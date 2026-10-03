import { colorDist } from './image.js';
import { dilate } from './inpaint.js';

/** Most common colour (5-bit quantised) and the share of pixels near it. */
export function dominantColor(raster) {
  const { width: W, height: H, data } = raster;
  const hist = new Map();
  const step = Math.max(1, Math.floor(Math.sqrt((W * H) / 250000)));
  let total = 0;
  for (let y = 0; y < H; y += step) for (let x = 0; x < W; x += step) {
    const o = (y * W + x) * 4;
    const key = ((data[o] >> 3) << 10) | ((data[o + 1] >> 3) << 5) | (data[o + 2] >> 3);
    hist.set(key, (hist.get(key) || 0) + 1); total++;
  }
  let bestKey = 0, best = 0;
  for (const [k, v] of hist) if (v > best) { best = v; bestKey = k; }
  const approx = [((bestKey >> 10) & 31) * 8 + 4, ((bestKey >> 5) & 31) * 8 + 4, (bestKey & 31) * 8 + 4];
  // Refine with the exact mean of near pixels and measure coverage.
  const acc = [0, 0, 0]; let near = 0;
  for (let y = 0; y < H; y += step) for (let x = 0; x < W; x += step) {
    const o = (y * W + x) * 4; const c = [data[o], data[o + 1], data[o + 2]];
    if (colorDist(c, approx) < 24) { acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; near++; }
  }
  const color = near ? acc.map((v) => v / near) : approx;
  return { color, share: near / total };
}

/**
 * On designs with a flat background, find large non-background areas
 * (photos, colour panels, illustrations) and return them as separate layers.
 */
export function findGraphicRegions(raster, bgColor, { minAreaRatio = 0.012, tolerance = 30 } = {}) {
  const { width: W, height: H, data } = raster;
  // Work on a downscaled grid for speed.
  const s = Math.max(1, Math.round(Math.max(W, H) / 600));
  const gw = Math.ceil(W / s), gh = Math.ceil(H / s);
  const grid = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    let fg = 0, n = 0;
    for (let y = gy * s; y < Math.min(H, (gy + 1) * s); y++) for (let x = gx * s; x < Math.min(W, (gx + 1) * s); x++) {
      const o = (y * W + x) * 4; n++;
      if (colorDist([data[o], data[o + 1], data[o + 2]], bgColor) > tolerance) fg++;
    }
    if (fg / n > 0.5) grid[gy * gw + gx] = 255;
  }
  const closed = dilate(grid, gw, gh, 2);

  const labels = new Int32Array(gw * gh).fill(-1);
  const regions = [];
  for (let i = 0; i < gw * gh; i++) {
    if (!closed[i] || labels[i] >= 0) continue;
    const id = regions.length; const stack = [i]; labels[i] = id;
    let x0 = gw, y0 = gh, x1 = 0, y1 = 0, area = 0;
    while (stack.length) {
      const p = stack.pop(); const px = p % gw, py = (p / gw) | 0; area++;
      if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
      for (const q of [p - 1, p + 1, p - gw, p + gw]) {
        if (q < 0 || q >= gw * gh) continue;
        if ((q === p - 1 && px === 0) || (q === p + 1 && px === gw - 1)) continue;
        if (closed[q] && labels[q] < 0) { labels[q] = id; stack.push(q); }
      }
    }
    regions.push({ id, x0, y0, x1, y1, area });
  }

  const minArea = gw * gh * minAreaRatio;
  return regions
    .filter((r) => r.area >= minArea && r.area < gw * gh * 0.92)
    .map((r) => {
      const box = { x: r.x0 * s, y: r.y0 * s, w: Math.min(W, (r.x1 + 1) * s) - r.x0 * s, h: Math.min(H, (r.y1 + 1) * s) - r.y0 * s };
      // Full-resolution alpha for the region: foreground pixels connected to this label.
      const alpha = new Uint8Array(box.w * box.h);
      for (let y = 0; y < box.h; y++) for (let x = 0; x < box.w; x++) {
        const gx = Math.floor((box.x + x) / s), gy = Math.floor((box.y + y) / s);
        if (labels[gy * gw + gx] !== r.id) continue;
        const o = ((box.y + y) * W + box.x + x) * 4;
        if (colorDist([data[o], data[o + 1], data[o + 2]], bgColor) > tolerance * 0.6) alpha[y * box.w + x] = 255;
      }
      return tighten(box, alpha);
    })
    .filter(Boolean);
}

/** Shrink a region to the bounds of its alpha and decide whether it's a rectangle. */
function tighten(box, alpha) {
  let x0 = box.w, y0 = box.h, x1 = -1, y1 = -1;
  for (let y = 0; y < box.h; y++) for (let x = 0; x < box.w; x++) {
    if (!alpha[y * box.w + x]) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) return null;
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const out = new Uint8Array(w * h);
  let on = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = alpha[(y + y0) * box.w + x + x0];
    out[y * w + x] = v; if (v) on++;
  }
  const filled = on / (w * h);
  // Nearly-rectangular regions (photos, panels) get a solid alpha so we don't punch
  // holes where the photo happens to contain the background colour.
  if (filled > 0.85) out.fill(255);
  return { box: { x: box.x + x0, y: box.y + y0, w, h }, alpha: out, rectangular: filled > 0.85 };
}
