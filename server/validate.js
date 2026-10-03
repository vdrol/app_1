import fs from 'node:fs/promises';
import path from 'node:path';

const ALIGN = new Set(['left', 'center', 'right', 'justify']);
const CATEGORY = new Set(['serif', 'sans-serif', 'display', 'script', 'monospace']);
const HEX = /^#[0-9a-f]{6}$/i;
const num = (v, lo, hi, dflt) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : dflt);
const str = (v, max, dflt = '') => (typeof v === 'string' ? v.slice(0, max) : dflt);

/**
 * Accept an edited layout from the browser, but only the fields we know, and only
 * image assets that the server itself produced for this job.
 */
export async function sanitizeLayout(input, previous, jobDir) {
  if (!input || !Array.isArray(input.layers)) throw new Error('Missing layout.');
  const prevById = new Map(previous.layers.map((l) => [l.id, l]));
  const { width: W, height: H } = previous;
  const layers = [];
  let added = 0;

  for (const l of input.layers.slice(0, 500)) {
    const prev = prevById.get(l.id);
    const base = {
      id: prev ? prev.id : `n${++added}`,
      name: str(l.name, 120, prev?.name || 'Layer'),
      x: num(l.x, -W, 2 * W, 0), y: num(l.y, -H, 2 * H, 0),
      w: num(l.w, 1, 3 * W, 10), h: num(l.h, 1, 3 * H, 10),
      visible: l.visible !== false,
    };
    if (l.type === 'image') {
      if (!prev || prev.type !== 'image') continue; // images can't be invented client-side
      layers.push({ ...prev, ...base, src: prev.src });
    } else if (l.type === 'text') {
      const fontSize = num(l.fontSize, 1, 2000, 24);
      const t = {
        ...base,
        type: 'text',
        role: str(l.role, 30, prev?.role || 'other'),
        text: str(l.text, 20000),
        fontSize,
        lineHeight: num(l.lineHeight, 1, 4000, fontSize * 1.2),
        baselineRatio: num(l.baselineRatio, -2, 20, 0.8),
        fontFamily: str(l.fontFamily, 80, 'Inter').replace(/[^\w \-]/g, '') || 'Inter',
        fontCategory: CATEGORY.has(l.fontCategory) ? l.fontCategory : 'sans-serif',
        fontWeight: num(l.fontWeight, 100, 900, 400),
        italic: Boolean(l.italic),
        color: HEX.test(l.color) ? l.color : '#000000',
        align: ALIGN.has(l.align) ? l.align : 'left',
        rotation: num(l.rotation, -360, 360, 0),
        letterSpacing: num(l.letterSpacing, -500, 500, 0),
        uppercase: Boolean(l.uppercase),
      };
      if (prev?.preview) {
        t.preview = prev.preview; t.previewBox = prev.previewBox;
        const changed = ['text', 'x', 'y', 'w', 'h', 'fontSize', 'lineHeight', 'fontFamily', 'fontWeight', 'italic', 'color', 'align', 'rotation', 'letterSpacing'].some((k) => t[k] !== prev[k]);
        t.edited = Boolean(prev.edited) || changed;
      }
      layers.push(t);
    }
  }

  const bgColor = HEX.test(input.background?.color) ? input.background.color : previous.background.color;
  await fs.access(path.join(jobDir, previous.background.src));
  return { ...previous, background: { ...previous.background, color: bgColor }, layers };
}
