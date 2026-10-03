import path from 'node:path';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import { iou, clampBox } from './image.js';
import { analyzeTextBox } from './style.js';

const require = createRequire(import.meta.url);
// Traineddata ships as an npm package so the app works offline / behind strict proxies.
const LANG_PATH = path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int');

let workerPromise = null;
function getWorker() {
  workerPromise ??= createWorker('eng', 1, { langPath: LANG_PATH, cacheMethod: 'none' });
  return workerPromise;
}

export async function shutdownOcr() {
  if (workerPromise) (await workerPromise).terminate();
  workerPromise = null;
}

/**
 * Tesseract's own page analysis only works on clean, flat pages. On magazine
 * covers the type sits on photographs, so most of it is never found. We feed
 * Tesseract several versions of the page:
 *   - the original and a normalised greyscale (flat layouts, body text)
 *   - Sauvola-binarised maps for light-on-dark and dark-on-light type, at a small
 *     and a large window, which strip the photo away and leave crisp letterforms
 *   - a half-size copy of the large-window maps for giant display type/mastheads
 * then merge every reading and re-read each line from a clean crop.
 */
export async function detectTextLines(raster) {
  const worker = await getWorker();
  const { width: W, height: H } = raster;
  const gray = toGray(raster);
  const integrals = buildIntegrals(gray, W, H);
  const long = Math.max(W, H);
  const smallWin = Math.max(15, Math.round(long / 32));
  const largeWin = Math.max(41, Math.round(long / 8));

  const rgbPng = (prep) => prep(sharp(Buffer.from(raster.data.buffer, raster.data.byteOffset, raster.data.length), {
    raw: { width: W, height: H, channels: 4 },
  }).removeAlpha()).png().toBuffer();
  const binPng = (win, light, scale = 1) => {
    const bin = sauvola(gray, integrals, W, H, win, light);
    let img = sharp(bin, { raw: { width: W, height: H, channels: 1 } }).median(5);
    if (scale !== 1) img = img.resize(Math.round(W * scale), Math.round(H * scale));
    return img.threshold(128).png().toBuffer();
  };

  const passes = [
    { name: 'original', make: () => rgbPng((s) => s), psm: '3' },
    { name: 'gray', make: () => rgbPng((s) => s.grayscale().normalise()), psm: '3' },
    { name: 'light-small', make: () => binPng(smallWin, true), psm: '11' },
    { name: 'dark-small', make: () => binPng(smallWin, false), psm: '11' },
    { name: 'light-large', make: () => binPng(largeWin, true), psm: '11' },
    { name: 'dark-large', make: () => binPng(largeWin, false), psm: '11' },
    { name: 'light-huge', make: () => binPng(largeWin, true, 0.5), psm: '11', scale: 0.5 },
    { name: 'dark-huge', make: () => binPng(largeWin, false, 0.5), psm: '11', scale: 0.5 },
  ];

  const all = [];
  for (const pass of passes) {
    const png = await pass.make();
    const k = 1 / (pass.scale || 1);
    await worker.setParameters({ tessedit_pageseg_mode: pass.psm, preserve_interword_spaces: '1', user_defined_dpi: '300' });
    const { data } = await worker.recognize(png, {}, { blocks: true });
    for (const block of data.blocks || []) {
      for (const para of block.paragraphs || []) {
        for (const line of para.lines || []) {
          const text = line.text.replace(/\s+/g, ' ').trim();
          if (!isPlausibleText(text, line.confidence)) continue;
          const words = (line.words || [])
            .filter((w) => w.text.trim() && w.confidence > 30)
            .map((w) => ({ text: w.text, box: scaleBox(bboxToBox(w.bbox), k), confidence: w.confidence }));
          for (const seg of splitAtGaps({ text, box: scaleBox(bboxToBox(line.bbox), k), confidence: line.confidence, words })) {
            if (isPlausibleText(seg.text, seg.confidence)) all.push({ ...seg, pass: pass.name });
          }
        }
      }
    }
  }
  const merged = mergeLines(all, raster);
  for (const line of merged) await refineLine(worker, raster, line);
  // Drop readings that fall apart when re-read in isolation (photo texture
  // that happened to look like letters).
  return merged.filter((l) => isPlausibleText(l.text, l.confidence) && !(l.refinedConfidence < 45 && l.confidence < 85));
}

const scaleBox = (b, k) => (k === 1 ? b : { x: Math.round(b.x * k), y: Math.round(b.y * k), w: Math.round(b.w * k), h: Math.round(b.h * k) });

function toGray(r) {
  const g = new Uint8Array(r.width * r.height);
  for (let i = 0; i < g.length; i++) g[i] = (r.data[i * 4] * 299 + r.data[i * 4 + 1] * 587 + r.data[i * 4 + 2] * 114) / 1000;
  return g;
}

function buildIntegrals(g, W, H) {
  const I1 = new Float64Array((W + 1) * (H + 1)), I2 = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let r1 = 0, r2 = 0;
    for (let x = 0; x < W; x++) {
      const v = g[y * W + x]; r1 += v; r2 += v * v;
      I1[(y + 1) * (W + 1) + x + 1] = I1[y * (W + 1) + x + 1] + r1;
      I2[(y + 1) * (W + 1) + x + 1] = I2[y * (W + 1) + x + 1] + r2;
    }
  }
  return { I1, I2 };
}

/**
 * Sauvola local thresholding. `light` picks out type lighter than its
 * surroundings (white coverlines on a photo); output is black ink on white.
 */
function sauvola(g, { I1, I2 }, W, H, win, light) {
  const out = Buffer.alloc(W * H);
  const r = win >> 1, S = W + 1;
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1);
      const n = (x1 - x0) * (y1 - y0);
      const s1 = I1[y1 * S + x1] - I1[y0 * S + x1] - I1[y1 * S + x0] + I1[y0 * S + x0];
      const s2 = I2[y1 * S + x1] - I2[y0 * S + x1] - I2[y1 * S + x0] + I2[y0 * S + x0];
      let m = s1 / n;
      const sd = Math.sqrt(Math.max(0, s2 / n - m * m));
      let v = g[y * W + x];
      if (light) { v = 255 - v; m = 255 - m; }
      out[y * W + x] = sd > 18 && v < m * (1 + 0.25 * (sd / 128 - 1)) ? 0 : 255;
    }
  }
  return out;
}

/**
 * Re-read one line from a clean, polarity-normalised crop. We binarise using the
 * line's own ink/paper colours, so white-on-black, coloured-on-tint and
 * dark-on-light all become crisp black-on-white for Tesseract.
 */
async function refineLine(worker, raster, line) {
  const p = Math.max(3, Math.round(line.box.h * 0.15));
  const box = clampBox({ x: line.box.x - p, y: line.box.y - p, w: line.box.w + 2 * p, h: line.box.h + 2 * p }, raster.width, raster.height);
  const st = analyzeTextBox(raster, box);
  if (st.contrast < 30) return;
  tightenToInk(line, box, st.mask);
  const gray = Buffer.alloc(box.w * box.h);
  for (let i = 0; i < gray.length; i++) gray[i] = 255 - st.alpha[i];
  const scale = Math.min(4, Math.max(1, 64 / line.box.h));
  const png = await sharp(gray, { raw: { width: box.w, height: box.h, channels: 1 } })
    .resize(Math.round(box.w * scale), Math.round(box.h * scale), { kernel: 'lanczos3' })
    .extend({ top: 20, bottom: 20, left: 20, right: 20, background: '#ffffff' })
    .png().toBuffer();
  await worker.setParameters({ tessedit_pageseg_mode: '7' });
  const { data } = await worker.recognize(png);
  const text = (data.text || '').replace(/\s+/g, ' ').trim();
  line.refinedConfidence = text ? data.confidence : 0;
  if (text && data.confidence > line.confidence - 3) {
    line.text = text;
    line.confidence = data.confidence;
  }
}

/**
 * Boxes from binarised or rescaled passes can include stray blobs. Shrink the
 * line box to the rows/columns that actually carry the line's ink.
 */
function tightenToInk(line, box, mask) {
  const { w, h } = box;
  const rows = new Float32Array(h), cols = new Float32Array(w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { rows[y]++; cols[x]++; }
  const span = (prof, frac) => {
    const max = Math.max(...prof);
    if (!max) return null;
    // Longest run of "inky" entries, bridging small gaps (between words / letters).
    const on = Array.from(prof, (v) => v >= max * frac);
    const bridge = Math.max(2, Math.round(prof.length * 0.06));
    let best = null, start = -1, lastOn = -1;
    for (let i = 0; i <= on.length; i++) {
      if (i < on.length && on[i]) { if (start < 0) start = i; lastOn = i; continue; }
      if (start >= 0 && (i === on.length || i - lastOn > bridge)) {
        if (!best || lastOn - start > best[1] - best[0]) best = [start, lastOn];
        start = -1;
      }
    }
    return best;
  };
  // Low thresholds: sparse rows (ascenders, descenders, x-height tops) must survive.
  const ry = span(rows, 0.03), rx = span(cols, 0.02);
  if (!ry || !rx) return;
  const nb = { x: box.x + rx[0], y: box.y + ry[0], w: rx[1] - rx[0] + 1, h: ry[1] - ry[0] + 1 };
  // Only ever shrink, and never to something implausibly small.
  if (nb.h >= line.box.h * 0.4 && nb.w >= line.box.w * 0.4 && nb.h <= line.box.h + 4) line.box = nb;
}

/**
 * Tesseract happily reads straight across column gutters ("Bold new small homes
 * with bright"). Split a line wherever the gap between words is much wider than
 * a normal word space.
 */
function splitAtGaps(line) {
  const words = [...line.words].sort((a, b) => a.box.x - b.box.x);
  if (words.length < 2) return [line];
  const h = line.box.h;
  const segs = [[words[0]]];
  for (let i = 1; i < words.length; i++) {
    const prev = words[i - 1];
    const gap = words[i].box.x - (prev.box.x + prev.box.w);
    if (gap > h * 1.2) segs.push([words[i]]);
    else segs[segs.length - 1].push(words[i]);
  }
  if (segs.length === 1) return [line];
  return segs.map((ws) => {
    const x0 = Math.min(...ws.map((w) => w.box.x)), y0 = Math.min(...ws.map((w) => w.box.y));
    const x1 = Math.max(...ws.map((w) => w.box.x + w.box.w)), y1 = Math.max(...ws.map((w) => w.box.y + w.box.h));
    return {
      text: ws.map((w) => w.text).join(' ').replace(/\s+/g, ' ').trim(),
      box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
      confidence: ws.reduce((s, w) => s + w.confidence, 0) / ws.length,
      words: ws,
    };
  });
}

function bboxToBox(b) {
  return { x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 };
}

function isPlausibleText(text, conf) {
  if (!text) return false;
  const letters = (text.match(/[\p{L}\p{N}]/gu) || []).length;
  if (letters === 0) return false;
  if (letters / text.replace(/\s/g, '').length < 0.5) return false; // mostly punctuation noise
  if (conf < 55) return false;
  if (letters <= 2 && conf < 80) return false;
  return true;
}

/** Keep the most confident reading of each physical line across passes. */
function mergeLines(lines, raster) {
  lines.sort((a, b) => b.confidence * Math.sqrt(b.text.length) - a.confidence * Math.sqrt(a.text.length));
  const kept = [];
  for (const l of lines) {
    if (l.box.w < 4 || l.box.h < 5) continue;
    if (l.box.w * l.box.h > raster.width * raster.height * 0.5) continue;
    const dup = kept.find((k) => iou(k.box, l.box) > 0.3 || containsMost(k.box, l.box));
    if (!dup) { kept.push(l); continue; }
    // Same words read by another pass with a tighter box (binarised passes can
    // glue nearby blobs onto a line): keep the reading, take the tighter box.
    if (norm(dup.text) === norm(l.text) && l.box.h < dup.box.h * 0.9 && l.confidence > dup.confidence - 8) {
      dup.box = l.box; dup.words = l.words;
    }
  }
  return kept.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
}

const norm = (t) => t.toLowerCase().replace(/[^a-z0-9]/g, '');

function containsMost(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return (ix * iy) / Math.min(a.w * a.h, b.w * b.h) > 0.6;
}
