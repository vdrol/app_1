import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { ZipArchive } from 'archiver';
import { buildPsd } from './psd.js';
import { buildPptx } from './pptx.js';
import { buildPdf } from './pdf.js';
import sharp from 'sharp';
import { buildSvg } from './svg.js';

export const EXPORTS = [
  { file: 'design.psd', label: 'Photoshop (.psd)', build: buildPsd },
  { file: 'design.pptx', label: 'Canva / PowerPoint (.pptx)', build: buildPptx },
  { file: 'design.pdf', label: 'PDF with live text (.pdf)', build: buildPdf },
  { file: 'design.svg', label: 'SVG for Illustrator / Figma (.svg)', build: buildSvg },
];

/** Build every export format plus a ZIP bundle with the individual layers. */
export async function buildExports(jobDir, layout) {
  await fs.writeFile(path.join(jobDir, 'layout.json'), JSON.stringify(layout, null, 2));
  const files = [];
  const ctx = {};
  for (const exp of [...EXPORTS].reverse()) { // SVG first: its render is the PSD composite
    const buf = await exp.build(jobDir, layout, ctx);
    if (exp.file === 'design.svg') ctx.composite = await renderSvg(buf);
    await fs.writeFile(path.join(jobDir, exp.file), buf);
    files.unshift({ file: exp.file, label: exp.label, bytes: buf.length });
  }
  const zipBytes = await zipBundle(jobDir, layout, files.map((f) => f.file));
  files.push({ file: 'design-bundle.zip', label: 'Everything + separate layer PNGs (.zip)', bytes: zipBytes });
  return files;
}

async function renderSvg(svg) {
  try {
    const { data, info } = await sharp(svg).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length) };
  } catch {
    return undefined; // fall back to the background plate
  }
}

function zipBundle(jobDir, layout, exportFiles) {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(path.join(jobDir, 'design-bundle.zip'));
    const zip = new ZipArchive({ zlib: { level: 6 } });
    out.on('close', () => resolve(zip.pointer()));
    zip.on('error', reject);
    zip.pipe(out);
    for (const f of exportFiles) zip.file(path.join(jobDir, f), { name: f });
    zip.file(path.join(jobDir, 'layout.json'), { name: 'layout.json' });
    zip.file(path.join(jobDir, layout.original), { name: 'layers/00-original.png' });
    zip.file(path.join(jobDir, layout.background.src), { name: 'layers/01-background.png' });
    layout.layers.forEach((l, i) => {
      const src = l.type === 'image' ? l.src : l.preview;
      if (src) zip.file(path.join(jobDir, src), { name: `layers/${String(i + 2).padStart(2, '0')}-${slug(l.name)}.png` });
    });
    zip.finalize();
  });
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'layer';
