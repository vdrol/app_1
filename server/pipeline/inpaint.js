/**
 * Fill masked pixels (mask[i] = 255) from their surroundings using a push-pull
 * image pyramid: known pixels are averaged down to coarse levels, then holes are
 * filled back up from the coarse estimates. Smooth, fast and dependency-free —
 * ideal for removing type from flat colours and gradients, decent on photos.
 */
export function inpaint(raster, mask) {
  const { width: W, height: H, data } = raster;
  const levels = [];
  let w = W, h = H;
  let col = new Float32Array(W * H * 3);
  let wt = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (mask[i]) continue;
    col[i * 3] = data[i * 4]; col[i * 3 + 1] = data[i * 4 + 1]; col[i * 3 + 2] = data[i * 4 + 2];
    wt[i] = 1;
  }
  levels.push({ w, h, col, wt });

  // Push: downsample with weights.
  while (w > 1 || h > 1) {
    const nw = Math.max(1, Math.ceil(w / 2)), nh = Math.max(1, Math.ceil(h / 2));
    const ncol = new Float32Array(nw * nh * 3), nwt = new Float32Array(nw * nh);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const s = y * w + x, d = (y >> 1) * nw + (x >> 1), ws = wt[s];
      if (!ws) continue;
      ncol[d * 3] += col[s * 3] * ws; ncol[d * 3 + 1] += col[s * 3 + 1] * ws; ncol[d * 3 + 2] += col[s * 3 + 2] * ws;
      nwt[d] += ws;
    }
    for (let i = 0; i < nw * nh; i++) if (nwt[i]) {
      ncol[i * 3] /= nwt[i]; ncol[i * 3 + 1] /= nwt[i]; ncol[i * 3 + 2] /= nwt[i];
      nwt[i] = Math.min(1, nwt[i]);
    }
    w = nw; h = nh; col = ncol; wt = nwt;
    levels.push({ w, h, col, wt });
  }

  // Pull: fill unknown/partial pixels from the coarser level (bilinear).
  for (let l = levels.length - 2; l >= 0; l--) {
    const fine = levels[l], coarse = levels[l + 1];
    for (let y = 0; y < fine.h; y++) for (let x = 0; x < fine.w; x++) {
      const i = y * fine.w + x, a = fine.wt[i];
      if (a >= 1) continue;
      const c = sampleBilinear(coarse, (x + 0.5) / 2 - 0.5, (y + 0.5) / 2 - 0.5);
      for (let k = 0; k < 3; k++) fine.col[i * 3 + k] = fine.col[i * 3 + k] * a + c[k] * (1 - a);
      fine.wt[i] = 1;
    }
  }

  const out = new Uint8ClampedArray(data);
  const base = levels[0];
  for (let i = 0; i < W * H; i++) {
    if (!mask[i]) continue;
    out[i * 4] = base.col[i * 3]; out[i * 4 + 1] = base.col[i * 3 + 1]; out[i * 4 + 2] = base.col[i * 3 + 2]; out[i * 4 + 3] = 255;
  }
  addGrain(out, mask, raster);
  return { width: W, height: H, data: out };
}

function sampleBilinear(lv, fx, fy) {
  const x0 = Math.max(0, Math.min(lv.w - 1, Math.floor(fx))), y0 = Math.max(0, Math.min(lv.h - 1, Math.floor(fy)));
  const x1 = Math.min(lv.w - 1, x0 + 1), y1 = Math.min(lv.h - 1, y0 + 1);
  const tx = Math.max(0, Math.min(1, fx - x0)), ty = Math.max(0, Math.min(1, fy - y0));
  const res = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const a = lv.col[(y0 * lv.w + x0) * 3 + k], b = lv.col[(y0 * lv.w + x1) * 3 + k];
    const c = lv.col[(y1 * lv.w + x0) * 3 + k], d = lv.col[(y1 * lv.w + x1) * 3 + k];
    res[k] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }
  return res;
}

/**
 * Smooth fills look plasticky on printed/photographic backgrounds. Re-inject a
 * little noise matching the local texture strength so patches blend in.
 */
function addGrain(out, mask, raster) {
  const { width: W, height: H, data } = raster;
  let sum = 0, n = 0;
  for (let y = 1; y < H - 1; y += 3) for (let x = 1; x < W - 1; x += 3) {
    const i = y * W + x;
    if (mask[i] || mask[i + 1]) continue;
    sum += Math.abs(data[i * 4] - data[(i + 1) * 4]); n++;
  }
  // Mean |neighbour difference| of uniform noise is ~1/3 of its range; scale up.
  const amp = Math.min(60, n ? (sum / n) * 1.6 : 0);
  if (amp < 1.5) return; // flat artwork: keep it perfectly clean
  let seed = 1234567;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
  for (let i = 0; i < W * H; i++) {
    if (!mask[i]) continue;
    const g = rnd() * amp;
    out[i * 4] += g + rnd() * amp * 0.5; out[i * 4 + 1] += g + rnd() * amp * 0.5; out[i * 4 + 2] += g + rnd() * amp * 0.5;
  }
}

/** Binary dilation with a square structuring element of the given radius. */
export function dilate(mask, W, H, r) {
  if (r <= 0) return mask;
  const tmp = new Uint8Array(W * H), out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    let run = -1;
    for (let x = 0; x < W; x++) if (mask[y * W + x]) run = x; else if (run >= 0 && x - run <= r) tmp[y * W + x] = 255;
    for (let x = 0; x < W; x++) if (mask[y * W + x]) tmp[y * W + x] = 255;
    run = -1;
    for (let x = W - 1; x >= 0; x--) if (mask[y * W + x]) run = x; else if (run >= 0 && run - x <= r) tmp[y * W + x] = 255;
  }
  for (let x = 0; x < W; x++) {
    let run = -1;
    for (let y = 0; y < H; y++) if (tmp[y * W + x]) { run = y; out[y * W + x] = 255; } else if (run >= 0 && y - run <= r) out[y * W + x] = 255;
    run = -1;
    for (let y = H - 1; y >= 0; y--) if (tmp[y * W + x]) run = y; else if (run >= 0 && run - y <= r) out[y * W + x] = 255;
  }
  return out;
}
