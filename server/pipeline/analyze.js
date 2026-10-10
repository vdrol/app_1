import fs from 'node:fs/promises';
import path from 'node:path';
import { loadRaster, rasterToPng, cropRaster, cloneRaster, toHex, colorDist, clampBox, coverage, iou, unionBox } from './image.js';
import { detectTextLines } from './ocr.js';
import { analyzeTextBox, estimateFontSize, baselineOffset, inferAlign, strokeWidth, weightFromStroke, estimateSlant } from './style.js';
import { inpaint, dilate } from './inpaint.js';
import { dominantColor, findGraphicRegions } from './regions.js';
import { visionAvailable, analyzeLayout, providerModel, aiProvider } from './vision.js';

/**
 * Turn a flattened design image into a layered layout:
 *   background plate (text removed) + graphic layers + editable text layers.
 * Writes PNG assets and layout.json into jobDir and returns the layout.
 */
export async function analyzeDesign(input, jobDir, { onProgress = () => {}, useAI = true, aiResult = null } = {}) {
  const warnings = [];
  onProgress('Reading image', 0.05);
  const raster = await loadRaster(input);
  const { width: W, height: H } = raster;
  const originalPng = await rasterToPng(raster);
  await fs.writeFile(path.join(jobDir, 'original.png'), originalPng);

  onProgress('Finding text (OCR)', 0.15);
  const ocrLines = await detectTextLines(raster);
  for (const l of ocrLines) l.style = analyzeTextBox(raster, clampBox(pad(l.box, 2), W, H));

  let ai = aiResult; // injectable for tests
  let provider = aiResult ? 'test' : null;
  if (!ai && useAI && visionAvailable()) {
    provider = aiProvider();
    onProgress(`Understanding layout with ${provider === 'gemini' ? 'Gemini' : 'Claude'}`, 0.35);
    try {
      ({ result: ai } = await analyzeLayout(originalPng, W, H));
    } catch (err) {
      warnings.push(`AI layout analysis failed (${aiErrorMessage(err)}); used OCR only.`);
    }
  } else if (!ai && useAI) {
    warnings.push('Set ANTHROPIC_API_KEY or GEMINI_API_KEY to enable AI font matching and smarter text grouping. Using OCR only.');
  }

  onProgress('Measuring typography', 0.6);
  const groups = ai ? groupWithAI(ai, ocrLines, W, H) : groupLines(ocrLines).map((lines) => ({ lines }));
  const textLayers = [];
  const textMask = new Uint8Array(W * H);
  for (const g of groups) {
    const layer = buildTextLayer(g, raster, textMask, textLayers.length);
    if (layer) textLayers.push(layer);
  }

  onProgress('Removing text from background', 0.72);
  const clean = inpaint(raster, textMask);

  onProgress('Separating images and shapes', 0.85);
  const bg = dominantColor(clean);
  const flatBackground = bg.share > 0.3;
  const background = { color: flatBackground ? toHex(bg.color) : (ai?.backgroundColor?.startsWith('#') ? ai.backgroundColor : toHex(bg.color)), flat: flatBackground };
  const plate = cloneRaster(clean);
  const imageLayers = [];

  const addImageLayer = async (box, alpha, name, kind) => {
    const crop = cropRaster(clean, box.x, box.y, box.w, box.h, alpha);
    const file = `image-${imageLayers.length + 1}.png`;
    await fs.writeFile(path.join(jobDir, file), await rasterToPng(crop));
    imageLayers.push({ id: `img${imageLayers.length + 1}`, type: 'image', name, kind, src: file, x: crop.left, y: crop.top, w: crop.width, h: crop.height, visible: true });
    return crop;
  };

  if (flatBackground) {
    const regions = findGraphicRegions(clean, bg.color);
    for (const r of regions) {
      const named = ai?.imageRegions.find((a) => iou(clampBox(a.box, W, H), r.box) > 0.3);
      await addImageLayer(r.box, r.alpha, named?.name || (r.rectangular ? `Image ${imageLayers.length + 1}` : `Shape ${imageLayers.length + 1}`), named?.kind || (r.rectangular ? 'photo' : 'shape'));
      // Knock the region out of the background plate so moving the layer leaves no ghost.
      for (let y = 0; y < r.box.h; y++) for (let x = 0; x < r.box.w; x++) {
        if (!r.alpha[y * r.box.w + x]) continue;
        const o = ((r.box.y + y) * W + r.box.x + x) * 4;
        plate.data[o] = bg.color[0]; plate.data[o + 1] = bg.color[1]; plate.data[o + 2] = bg.color[2];
      }
    }
  } else if (ai) {
    // Photographic background: lift the regions Claude identified as rectangular layers.
    for (const r of ai.imageRegions) {
      const box = clampBox(r.box, W, H);
      if (box.w * box.h > W * H * 0.85 || box.w < 8 || box.h < 8) continue;
      await addImageLayer(box, null, r.name, r.kind);
    }
  }

  await fs.writeFile(path.join(jobDir, 'background.png'), await rasterToPng(plate));

  // Each text layer also gets a pixel preview (original ink colour on transparent),
  // used by apps that can't re-render live type and by the in-browser editor's
  // "original" overlay.
  for (const t of textLayers) {
    const crop = cropRaster(raster, t._mask.box.x, t._mask.box.y, t._mask.box.w, t._mask.box.h, t._mask.alpha);
    t.preview = `text-${t.id}.png`;
    t.previewBox = { x: crop.left, y: crop.top, w: crop.width, h: crop.height };
    await fs.writeFile(path.join(jobDir, t.preview), await rasterToPng(crop));
    delete t._mask;
  }

  const layout = {
    version: 1,
    width: W,
    height: H,
    background: { ...background, src: 'background.png' },
    original: 'original.png',
    layers: [...imageLayers, ...textLayers],
    meta: { ai: Boolean(ai), provider: ai ? provider : null, model: ai ? providerModel(provider) : null, warnings, createdAt: new Date().toISOString() },
  };
  await fs.writeFile(path.join(jobDir, 'layout.json'), JSON.stringify(layout, null, 2));
  onProgress('Done', 1);
  return layout;
}

/** Short, actionable message for common provider errors (bad key, quota). */
function aiErrorMessage(err) {
  const msg = String(err?.message || err);
  const status = err?.status ?? Number(/\b(400|401|403|404|429)\b/.exec(msg)?.[1]);
  if (status === 401 || status === 403 || /API key not valid|invalid x-api-key|API_KEY_INVALID/i.test(msg)) return 'the API key was rejected — check it';
  if (status === 429 || /quota|RESOURCE_EXHAUSTED|rate limit/i.test(msg)) return 'rate limit or free-tier quota reached — try again later';
  if (status === 404 || /not found/i.test(msg)) return 'model not available for this key — set GEMINI_MODEL or CLAUDE_MODEL';
  return msg.length > 160 ? `${msg.slice(0, 160)}…` : msg;
}

const pad = (b, p) => ({ x: b.x - p, y: b.y - p, w: b.w + 2 * p, h: b.h + 2 * p });

/** Heuristic paragraph grouping for OCR-only mode. */
export function groupLines(lines) {
  const blocks = [];
  for (const line of [...lines].sort((a, b) => a.box.y - b.box.y)) {
    const target = blocks.find((blk) => {
      const last = blk[blk.length - 1];
      const ratio = line.box.h / last.box.h;
      if (ratio < 0.75 || ratio > 1.33) return false;
      const gap = line.box.y - (last.box.y + last.box.h);
      if (gap < -0.3 * last.box.h || gap > 0.9 * last.box.h) return false;
      const ov = Math.min(line.box.x + line.box.w, last.box.x + last.box.w) - Math.max(line.box.x, last.box.x);
      if (ov < 0.3 * Math.min(line.box.w, last.box.w)) return false;
      return colorDist(line.style.ink, last.style.ink) < 60;
    });
    if (target) target.push(line); else blocks.push([line]);
  }
  return blocks;
}

/** Use Claude's blocks for grouping/fonts and snap them to precise OCR boxes. */
function groupWithAI(ai, ocrLines, W, H) {
  const used = new Set();
  const groups = [];
  for (const blk of ai.textBlocks) {
    if (!blk.text.trim()) continue;
    const box = clampBox(blk.box, W, H);
    const grow = pad(box, Math.max(6, box.h * 0.08));
    const lines = ocrLines.filter((l, i) => !used.has(i) && coverage(l.box, grow) > 0.6);
    lines.forEach((l) => used.add(ocrLines.indexOf(l)));
    groups.push({ ai: blk, box, lines });
  }
  // OCR lines Claude didn't mention (often tiny print) become their own blocks.
  const leftovers = ocrLines.filter((l, i) => !used.has(i) && l.confidence > 75);
  for (const g of groupLines(leftovers)) groups.push({ lines: g });
  return groups;
}

function buildTextLayer(group, raster, textMask, index) {
  const { width: W, height: H } = raster;
  const { ai } = group;
  let lines = [...group.lines].sort((a, b) => a.box.y - b.box.y);
  const aiLines = ai ? ai.text.split('\n').map((s) => s.trim()).filter(Boolean) : null;

  if (!lines.length) {
    if (!ai) return null;
    // Claude saw text OCR missed (stylised type). Synthesize evenly spaced lines.
    const n = aiLines.length || 1;
    const lh = group.box.h / n;
    lines = aiLines.map((text, i) => {
      const box = clampBox({ x: group.box.x, y: group.box.y + i * lh, w: group.box.w, h: lh * 0.82 }, W, H);
      return { text, box, style: analyzeTextBox(raster, box) };
    });
  }

  // Prefer Claude's transcription when it lines up with the OCR line structure.
  const lineTexts = aiLines && aiLines.length === lines.length ? aiLines : lines.map((l) => l.text);
  const text = ai && !(aiLines.length === lines.length) ? ai.text.trim() : lineTexts.join('\n');

  const sizes = lines.map((l, i) => estimateFontSize(lineTexts[i] || l.text, l.box.h)).sort((a, b) => a - b);
  const fontSize = sizes[sizes.length >> 1];
  const box = unionBox(lines.map((l) => l.box));
  const pitches = lines.slice(1).map((l, i) => (l.box.y + baselineOffset(lineTexts[i + 1] || l.text, l.box.h)) - (lines[i].box.y + baselineOffset(lineTexts[i] || lines[i].text, lines[i].box.h)));
  const lineHeight = pitches.length ? median(pitches) : fontSize * 1.2;
  const firstBaseline = lines[0].box.y + baselineOffset(lineTexts[0] || lines[0].text, lines[0].box.h);

  // Colour: measured ink is more reliable than a model's guess unless contrast is poor.
  const inks = lines.filter((l) => l.style.contrast > 40).map((l) => l.style.ink);
  const color = inks.length ? toHex(medianColor(inks)) : (ai?.color || '#000000');

  // Build the removal mask and the soft-alpha preview for this block.
  const mb = clampBox(pad(box, 3), W, H);
  const alpha = new Uint8Array(mb.w * mb.h);
  const r = Math.max(2, Math.round(fontSize * 0.06));
  const strokes = [];
  const slants = [];
  for (const l of lines) {
    const lb = clampBox(pad(l.box, 2), W, H);
    const st = l.style.contrast > 25 ? l.style : analyzeTextBox(raster, lb);
    // Anti-aliasing widens the thresholded stroke by roughly half a pixel per side.
    strokes.push(Math.max(0, strokeWidth(st.mask, lb.w, lb.h) - 0.6) / fontSize);
    slants.push(estimateSlant(st.mask, lb.w, lb.h));
    const local = dilate(st.mask, lb.w, lb.h, r);
    for (let y = 0; y < lb.h; y++) for (let x = 0; x < lb.w; x++) {
      const gx = lb.x + x, gy = lb.y + y;
      if (local[y * lb.w + x]) textMask[gy * W + gx] = 255;
      const ax = gx - mb.x, ay = gy - mb.y;
      if (ax >= 0 && ay >= 0 && ax < mb.w && ay < mb.h) alpha[ay * mb.w + ax] = Math.max(alpha[ay * mb.w + ax], st.alpha[y * lb.w + x]);
    }
  }

  const role = ai?.role || guessRole(fontSize, raster.height, lines.length);
  const measuredWeight = weightFromStroke(median(strokes));
  let align = lines.length > 1 ? inferAlign(lines) : (ai?.align === 'justify' ? 'left' : ai?.align || 'left');
  // A lone line sitting on the page's centre axis is almost certainly centred.
  if (!ai && lines.length === 1 && Math.abs(box.x + box.w / 2 - W / 2) < W * 0.015) align = 'center';
  const id = `t${index + 1}`;
  return {
    id,
    type: 'text',
    name: `${capitalize(role)} – ${text.replace(/\s+/g, ' ').slice(0, 28)}`,
    role,
    text,
    x: box.x, y: box.y, w: box.w, h: box.h,
    fontSize: round1(fontSize),
    lineHeight: round1(lineHeight),
    baselineRatio: round3((firstBaseline - box.y) / fontSize), // first baseline = y + ratio * fontSize
    fontFamily: ai?.fontFamily || defaultFamily(role),
    fontCategory: ai?.fontCategory || defaultCategory(role),
    fontWeight: ai?.fontWeight || measuredWeight,
    italic: ai ? Boolean(ai.italic) : median(slants) >= 0.12,
    color,
    align,
    rotation: ai?.rotation && Math.abs(ai.rotation) > 2 ? ai.rotation : 0,
    letterSpacing: 0,
    uppercase: text === text.toUpperCase() && /[A-Z]/.test(text),
    visible: true,
    _mask: { box: mb, alpha },
  };
}

function guessRole(fontSize, H, nLines) {
  if (fontSize > H * 0.06) return 'headline';
  if (fontSize > H * 0.03) return 'subheadline';
  if (nLines > 2) return 'body';
  return fontSize < H * 0.015 ? 'caption' : 'label';
}

const isDisplayRole = (role) => role === 'masthead' || role === 'headline';
const defaultFamily = (role) => (isDisplayRole(role) ? 'Playfair Display' : 'Inter');
const defaultCategory = (role) => (isDisplayRole(role) ? 'serif' : 'sans-serif');

const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
const medianColor = (cs) => [0, 1, 2].map((k) => median(cs.map((c) => c[k])));
const round1 = (v) => Math.round(v * 10) / 10;
const round3 = (v) => Math.round(v * 1000) / 1000;
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
