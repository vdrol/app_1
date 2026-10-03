import { colorDist } from './image.js';

/**
 * Split the pixels of a text box into "ink" and "paper" with a 2-means
 * clustering. The paper cluster is whichever dominates the box border.
 * Returns colours plus a per-pixel ink mask for the box.
 */
export function analyzeTextBox(raster, box) {
  const { width: W, data } = raster;
  const { x, y, w, h } = box;
  const px = (i, j) => {
    const o = ((y + j) * W + (x + i)) * 4;
    return [data[o], data[o + 1], data[o + 2]];
  };

  // Seed: border median (paper) and the pixel furthest from it (ink).
  const border = [];
  for (let i = 0; i < w; i++) { border.push(px(i, 0), px(i, h - 1)); }
  for (let j = 0; j < h; j++) { border.push(px(0, j), px(w - 1, j)); }
  let paper = median(border);
  let ink = paper, best = -1;
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 4000)));
  for (let j = 0; j < h; j += step) for (let i = 0; i < w; i += step) {
    const c = px(i, j); const d = colorDist(c, paper);
    if (d > best) { best = d; ink = c; }
  }

  for (let iter = 0; iter < 6; iter++) {
    const sa = [0, 0, 0, 0], sb = [0, 0, 0, 0];
    for (let j = 0; j < h; j += step) for (let i = 0; i < w; i += step) {
      const c = px(i, j);
      const t = colorDist(c, ink) < colorDist(c, paper) ? sa : sb;
      t[0] += c[0]; t[1] += c[1]; t[2] += c[2]; t[3]++;
    }
    if (sa[3]) ink = [sa[0] / sa[3], sa[1] / sa[3], sa[2] / sa[3]];
    if (sb[3]) paper = [sb[0] / sb[3], sb[1] / sb[3], sb[2] / sb[3]];
  }

  // If the "ink" cluster touches the border more than "paper", they're swapped
  // (e.g. a box that is mostly letterforms).
  let inkOnBorder = 0;
  for (const c of border) if (colorDist(c, ink) < colorDist(c, paper)) inkOnBorder++;
  if (inkOnBorder > border.length / 2) [ink, paper] = [paper, ink];

  // Ink mask + soft alpha. Alpha is the pixel's position on the paper→ink colour
  // axis, which preserves anti-aliased edges. The reported colour uses only the
  // most ink-like pixels so anti-aliasing doesn't wash it out.
  const mask = new Uint8Array(w * h);
  const alpha = new Uint8Array(w * h);
  const axis = [ink[0] - paper[0], ink[1] - paper[1], ink[2] - paper[2]];
  const len2 = axis[0] ** 2 + axis[1] ** 2 + axis[2] ** 2 || 1;
  const contrast = Math.sqrt(len2);
  const strong = [];
  let on = 0;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const c = px(i, j);
    const t = ((c[0] - paper[0]) * axis[0] + (c[1] - paper[1]) * axis[1] + (c[2] - paper[2]) * axis[2]) / len2;
    const a = Math.max(0, Math.min(1, (t - 0.1) / 0.8));
    alpha[j * w + i] = Math.round(a * 255);
    if (t > 0.3) { mask[j * w + i] = 255; on++; }
    if (t > 0.75) strong.push(c);
  }
  const inkColor = strong.length > 8 ? median(strong) : ink;
  return { ink: inkColor, paper, contrast, mask, alpha, inkRatio: on / (w * h) };
}

function median(colors) {
  const ch = [0, 1, 2].map((k) => colors.map((c) => c[k]).sort((a, b) => a - b));
  const m = colors.length >> 1;
  return [ch[0][m], ch[1][m], ch[2][m]];
}

/**
 * Estimate the CSS-style font size (em) from the height of a line's bounding box.
 * A tight bbox spans from the tallest glyph top to the lowest glyph bottom, so the
 * em size depends on which glyph classes occur in the text.
 */
export function estimateFontSize(text, bboxHeight) {
  const hasTall = /[A-Z0-9bdfhkltΑ-Ω'"!?/\\|()[\]{}#$%&@]/.test(text);
  const hasDesc = /[gjpqy,;()[\]{}|]/.test(text);
  const top = hasTall ? 0.72 : 0.52; // cap/ascender height vs x-height, in em
  const bottom = hasDesc ? 0.22 : 0;
  return bboxHeight / (top + bottom);
}

/** Where is the baseline relative to the top of the line box? */
export function baselineOffset(text, bboxHeight) {
  const hasDesc = /[gjpqy,;()[\]{}|]/.test(text);
  if (!hasDesc) return bboxHeight;
  const size = estimateFontSize(text, bboxHeight);
  return bboxHeight - size * 0.22;
}

/** Infer paragraph alignment from the left/right/centre edges of its lines. */
export function inferAlign(lines) {
  if (lines.length < 2) return 'left';
  const spread = (vals) => Math.max(...vals) - Math.min(...vals);
  const ref = Math.max(...lines.map((l) => l.box.h));
  const L = spread(lines.map((l) => l.box.x));
  const R = spread(lines.map((l) => l.box.x + l.box.w));
  const C = spread(lines.map((l) => l.box.x + l.box.w / 2));
  const tol = ref * 0.6;
  if (L <= tol) {
    // Justified text: every line but the last shares both edges.
    const body = lines.slice(0, -1);
    const Rb = spread(body.map((l) => l.box.x + l.box.w));
    return lines.length >= 3 && Rb <= tol * 0.5 ? 'justify' : 'left';
  }
  if (C <= tol) return 'center';
  if (R <= tol) return 'right';
  return 'left';
}

/**
 * Average stroke width of the ink, from area / perimeter (a stroke of width s and
 * length L has area sL and perimeter ~2L). Relative to the em size it separates
 * regular (~0.085) from bold (~0.12+) type.
 */
export function strokeWidth(mask, w, h) {
  let area = 0, edge = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!mask[y * w + x]) continue;
    area++;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !mask[y * w + x - 1] || !mask[y * w + x + 1] || !mask[(y - 1) * w + x] || !mask[(y + 1) * w + x]) edge++;
  }
  return edge ? (2 * area) / edge : 0;
}

export function weightFromStroke(ratio) {
  if (ratio > 0.17) return 900;
  if (ratio > 0.11) return 700;
  if (ratio > 0.1) return 600;
  if (ratio < 0.055) return 300;
  return 400;
}

/**
 * Slant of the letterforms: shear the ink horizontally by candidate angles and
 * keep the one whose column histogram is sharpest (upright strokes line up).
 * Returns the shear (dx/dy) — italics are typically 0.15-0.3.
 */
export function estimateSlant(mask, w, h) {
  let best = 0, bestScore = -1;
  const cy = h / 2;
  for (let s = -0.1; s <= 0.4001; s += 0.05) {
    const hist = new Float32Array(w + h);
    for (let y = 0; y < h; y++) {
      const off = Math.round(s * (y - cy)) + (h >> 1); // undo a rightward lean
      for (let x = 0; x < w; x++) if (mask[y * w + x]) hist[x + off]++;
    }
    let score = 0;
    for (const v of hist) score += v * v;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return best;
}
