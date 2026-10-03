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
 * Tesseract's page layout analysis is fragile on magazine layouts: coloured
 * headlines, light-on-dark type and very large display type are frequently
 * dropped by a single pass. We run several preprocessed passes and merge them.
 */
const PASSES = [
  { name: 'original', prep: (s) => s },
  { name: 'gray', prep: (s) => s.grayscale().normalise() },
  { name: 'inverted', prep: (s) => s.grayscale().normalise().negate({ alpha: false }) },
  { name: 'sparse', prep: (s) => s.grayscale().normalise(), psm: '11' },
];

export async function detectTextLines(raster) {
  const worker = await getWorker();
  const base = () => sharp(Buffer.from(raster.data.buffer, raster.data.byteOffset, raster.data.length), {
    raw: { width: raster.width, height: raster.height, channels: 4 },
  }).removeAlpha();

  const all = [];
  for (const pass of PASSES) {
    const png = await pass.prep(base()).png().toBuffer();
    await worker.setParameters({ tessedit_pageseg_mode: pass.psm || '3', preserve_interword_spaces: '1', user_defined_dpi: '300' });
    const { data } = await worker.recognize(png, {}, { blocks: true });
    for (const block of data.blocks || []) {
      for (const para of block.paragraphs || []) {
        for (const line of para.lines || []) {
          const text = line.text.replace(/\s+/g, ' ').trim();
          if (!isPlausibleText(text, line.confidence)) continue;
          const words = (line.words || [])
            .filter((w) => w.text.trim() && w.confidence > 30)
            .map((w) => ({ text: w.text, box: bboxToBox(w.bbox), confidence: w.confidence }));
          for (const seg of splitAtGaps({ text, box: bboxToBox(line.bbox), confidence: line.confidence, words })) {
            if (isPlausibleText(seg.text, seg.confidence)) all.push({ ...seg, pass: pass.name });
          }
        }
      }
    }
  }
  const merged = mergeLines(all, raster);
  for (const line of merged) await refineLine(worker, raster, line);
  return merged.filter((l) => isPlausibleText(l.text, l.confidence));
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
  if (text && data.confidence > line.confidence - 3) {
    line.text = text;
    line.confidence = data.confidence;
  }
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
    if (!dup) kept.push(l);
  }
  return kept.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
}

function containsMost(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return (ix * iy) / Math.min(a.w * a.h, b.w * b.h) > 0.6;
}
