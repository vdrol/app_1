import sharp from 'sharp';

// Largest side we work at. Big enough for print-ish exports, small enough to keep
// OCR and inpainting fast.
export const MAX_SIDE = 2400;

/** Decode any supported upload into a normalized RGBA raster. */
export async function loadRaster(input) {
  const img = sharp(input, { failOn: 'none' }).rotate(); // honour EXIF orientation
  const meta = await img.metadata();
  let pipeline = img.flatten({ background: '#ffffff' });
  const longest = Math.max(meta.width || 0, meta.height || 0);
  if (longest > MAX_SIDE) {
    pipeline = pipeline.resize({ width: meta.width >= meta.height ? MAX_SIDE : null, height: meta.height > meta.width ? MAX_SIDE : null });
  }
  const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length) };
}

export function cloneRaster(r) {
  return { width: r.width, height: r.height, data: new Uint8ClampedArray(r.data) };
}

export async function rasterToPng(r) {
  return sharp(Buffer.from(r.data.buffer, r.data.byteOffset, r.data.length), {
    raw: { width: r.width, height: r.height, channels: 4 },
  }).png({ compressionLevel: 6 }).toBuffer();
}

/** Copy a rectangle out of a raster. Optional alpha mask (Uint8Array, same rect size). */
export function cropRaster(r, x, y, w, h, alpha) {
  x = Math.max(0, Math.round(x)); y = Math.max(0, Math.round(y));
  w = Math.max(1, Math.min(r.width - x, Math.round(w)));
  h = Math.max(1, Math.min(r.height - y, Math.round(h)));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let j = 0; j < h; j++) {
    const src = ((y + j) * r.width + x) * 4;
    out.set(r.data.subarray(src, src + w * 4), j * w * 4);
  }
  if (alpha) for (let i = 0; i < w * h; i++) out[i * 4 + 3] = alpha[i];
  return { width: w, height: h, data: out, left: x, top: y };
}

export const toHex = ([r, g, b]) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
export const fromHex = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
export const colorDist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export const clampBox = (b, W, H) => {
  const x = Math.max(0, Math.min(W - 1, Math.round(b.x)));
  const y = Math.max(0, Math.min(H - 1, Math.round(b.y)));
  return { x, y, w: Math.max(1, Math.min(W - x, Math.round(b.w))), h: Math.max(1, Math.min(H - y, Math.round(b.h))) };
};

export function iou(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  return inter / (a.w * a.h + b.w * b.h - inter || 1);
}

/** Fraction of box a covered by box b. */
export function coverage(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return (ix * iy) / (a.w * a.h || 1);
}

export const unionBox = (boxes) => {
  const x0 = Math.min(...boxes.map((b) => b.x)), y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w)), y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};
