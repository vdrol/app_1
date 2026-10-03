// End-to-end smoke test: synthesize a magazine-style page, run the full pipeline
// (OCR mode, no network), then verify every export opens and carries live text.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { readPsd } from 'ag-psd';
import { analyzeDesign } from '../server/pipeline/analyze.js';
import { shutdownOcr } from '../server/pipeline/ocr.js';
import { buildExports } from '../server/export/index.js';

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1d3557"/><stop offset="1" stop-color="#e76f51"/></linearGradient></defs>
  <rect width="900" height="1200" fill="#f4ecdf"/>
  <text x="450" y="150" text-anchor="middle" font-family="DejaVu Serif" font-weight="bold" font-size="120" fill="#b0202a">AURORA</text>
  <text x="450" y="205" text-anchor="middle" font-family="DejaVu Sans" font-size="26" fill="#333333">THE SPRING DESIGN ISSUE</text>
  <rect x="60" y="260" width="780" height="480" fill="url(#g)"/>
  <rect x="60" y="780" width="380" height="140" fill="#222222"/>
  <text x="80" y="840" font-family="DejaVu Sans" font-weight="bold" font-size="40" fill="#ffffff">Bold new</text>
  <text x="80" y="890" font-family="DejaVu Sans" font-weight="bold" font-size="40" fill="#ffffff">interiors</text>
  <text x="480" y="810" font-family="DejaVu Serif" font-size="22" fill="#222222">Designers are rethinking</text>
  <text x="480" y="842" font-family="DejaVu Serif" font-size="22" fill="#222222">small homes with bright</text>
  <text x="480" y="874" font-family="DejaVu Serif" font-size="22" fill="#222222">colour and clever storage.</text>
</svg>`;

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unflatten-'));
const input = await sharp(Buffer.from(svg)).png().toBuffer();
console.log('workdir', dir);

const stages = [];
const layout = await analyzeDesign(input, dir, { useAI: false, onProgress: (s) => stages.push(s) });
await shutdownOcr();

const texts = layout.layers.filter((l) => l.type === 'text');
const images = layout.layers.filter((l) => l.type === 'image');
console.log('stages:', stages.join(' → '));
for (const t of texts) console.log(`  text  ${JSON.stringify(t.text)}  size=${t.fontSize} weight=${t.fontWeight} color=${t.color} align=${t.align} @${t.x},${t.y}`);
for (const i of images) console.log(`  image ${i.name} ${i.w}x${i.h} @${i.x},${i.y}`);

const all = texts.map((t) => t.text).join(' ').toUpperCase();
for (const word of ['AURORA', 'SPRING', 'INTERIORS', 'STORAGE']) assert.ok(all.includes(word), `expected to find "${word}" in text layers`);
assert.ok(images.length >= 2, 'expected the photo and the dark panel as image layers');
const aurora = texts.find((t) => t.text.toUpperCase().includes('AURORA'));
assert.ok(Math.abs(aurora.fontSize - 120) < 30, `masthead font size ~120, got ${aurora.fontSize}`);
assert.equal(aurora.align, 'center');
assert.ok(aurora.fontWeight >= 600, `masthead is bold, got ${aurora.fontWeight}`);
const white = texts.find((t) => /interiors/i.test(t.text));
assert.ok(parseInt(white.color.slice(1, 3), 16) > 200, `white text should be white, got ${white.color}`);

// Background plate should no longer contain the masthead ink.
const bg = await sharp(path.join(dir, 'background.png')).raw().toBuffer({ resolveWithObject: true });
const px = (x, y) => { const o = (y * bg.info.width + x) * bg.info.channels; return [bg.data[o], bg.data[o + 1], bg.data[o + 2]]; };
let red = 0;
for (let y = aurora.y; y < aurora.y + aurora.h; y += 2) for (let x = aurora.x; x < aurora.x + aurora.w; x += 2) { const [r, g] = px(x, y); if (r - g > 80) red++; }
assert.ok(red < 20, `masthead should be removed from background, ${red} red pixels left`);

const files = await buildExports(dir, layout);
console.log('exports:', files.map((f) => `${f.file} (${(f.bytes / 1024).toFixed(0)} KB)`).join(', '));

const psd = readPsd(await fs.readFile(path.join(dir, 'design.psd')), { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true });
const textGroup = psd.children.find((c) => c.name === 'Text');
assert.equal(textGroup.children.length, texts.length);
assert.ok(textGroup.children.every((c) => c.text?.text), 'every PSD text layer carries live text');
assert.ok(psd.children.find((c) => c.name === 'Images').children.length === images.length);

const pdf = (await fs.readFile(path.join(dir, 'design.pdf'))).toString('latin1');
assert.ok(pdf.startsWith('%PDF') && /\/Font/.test(pdf), 'PDF has fonts (live text)');

const pptx = await fs.readFile(path.join(dir, 'design.pptx'));
assert.equal(pptx.subarray(0, 2).toString(), 'PK');
const svgOut = await fs.readFile(path.join(dir, 'design.svg'), 'utf8');
assert.ok(svgOut.includes('<text') && /AURORA/i.test(svgOut));

// --- AI-assisted path, with a canned Claude response (no network) ---
const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'unflatten-ai-'));
const aiResult = {
  backgroundColor: '#f4ecdf',
  textBlocks: [
    { text: 'AURORA', box: { x: 150, y: 60, w: 600, h: 95 }, role: 'masthead', fontFamily: 'Bodoni Moda', fontCategory: 'serif', fontWeight: 700, italic: false, color: '#b0202a', align: 'center', rotation: 0 },
    { text: 'Bold new\ninteriors', box: { x: 80, y: 805, w: 200, h: 95 }, role: 'headline', fontFamily: 'Montserrat', fontCategory: 'sans-serif', fontWeight: 700, italic: false, color: '#ffffff', align: 'left', rotation: 0 },
    // Text that OCR won't find in that spot: must be synthesized, not crash.
    { text: 'Ghost line', box: { x: 600, y: 1000, w: 200, h: 30 }, role: 'caption', fontFamily: 'Inter', fontCategory: 'sans-serif', fontWeight: 400, italic: true, color: '#555555', align: 'right', rotation: 0 },
  ],
  imageRegions: [{ name: 'Cover photo', box: { x: 60, y: 260, w: 780, h: 480 }, kind: 'photo' }],
};
const layout2 = await analyzeDesign(input, dir2, { aiResult });
await shutdownOcr();
const t2 = layout2.layers.filter((l) => l.type === 'text');
const mast = t2.find((t) => t.role === 'masthead');
assert.equal(mast.fontFamily, 'Bodoni Moda');
assert.ok(t2.find((t) => t.text === 'Bold new\ninteriors'), 'AI transcription is used when line count matches');
assert.ok(t2.find((t) => t.text === 'Ghost line' && t.italic), 'AI-only block is kept');
assert.ok(t2.some((t) => /storage/i.test(t.text)), 'OCR lines not mentioned by AI are kept');
assert.ok(layout2.layers.some((l) => l.name === 'Cover photo'), 'AI names the detected image region');
await buildExports(dir2, layout2);
console.log('AI-merge path OK:', t2.map((t) => t.name).join(' | '));

console.log('\nAll checks passed ✔');
