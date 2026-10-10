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

// --- Full-bleed photo cover: type sitting on a textured photograph ---
const coverDir = await fs.mkdtemp(path.join(os.tmpdir(), 'unflatten-cover-'));
const CW = 1000, CH = 1300;
let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const noise = Buffer.alloc(CW * CH * 3);
for (let i = 0; i < noise.length; i++) noise[i] = rand() * 255;
const photo = `<svg xmlns="http://www.w3.org/2000/svg" width="${CW}" height="${CH}">
  <defs><radialGradient id="a"><stop offset="0" stop-color="#e9c9a8"/><stop offset="1" stop-color="#6b4a3a"/></radialGradient>
  <linearGradient id="b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7fa7c9"/><stop offset="1" stop-color="#2c3e50"/></linearGradient></defs>
  <rect width="${CW}" height="${CH}" fill="url(#b)"/><ellipse cx="520" cy="560" rx="190" ry="240" fill="url(#a)"/>
  <path d="M200 1300 Q520 700 840 1300Z" fill="#8a2d3b"/><circle cx="150" cy="300" r="120" fill="#c9d6e3" opacity=".5"/></svg>`;
const type = `<svg xmlns="http://www.w3.org/2000/svg" width="${CW}" height="${CH}">
  <text x="500" y="200" text-anchor="middle" font-family="DejaVu Serif" font-weight="bold" font-size="190" fill="#ffffff">VOGUE</text>
  <text x="60" y="420" font-family="DejaVu Sans" font-weight="bold" font-size="54" fill="#ffd400">SUMMER</text>
  <text x="60" y="480" font-family="DejaVu Sans" font-weight="bold" font-size="54" fill="#ffd400">STYLE</text>
  <text x="60" y="525" font-family="DejaVu Sans" font-size="28" fill="#ffffff">50 looks to wear now</text>
  <text x="940" y="760" text-anchor="end" font-family="DejaVu Serif" font-style="italic" font-size="46" fill="#ffffff">The New</text>
  <text x="940" y="815" text-anchor="end" font-family="DejaVu Serif" font-style="italic" font-size="46" fill="#ffffff">Icons</text>
  <text x="60" y="1180" font-family="DejaVu Sans" font-weight="bold" font-size="64" fill="#ffffff">BEAUTY SECRETS</text>
  <text x="60" y="1230" font-family="DejaVu Sans" font-size="30" fill="#ffd400">From the world's top artists</text></svg>`;
const photoPng = await sharp(Buffer.from(photo)).blur(6)
  .composite([{ input: await sharp(noise, { raw: { width: CW, height: CH, channels: 3 } }).png().toBuffer(), blend: 'soft-light' }]).png().toBuffer();
const coverJpg = await sharp(photoPng).composite([{ input: Buffer.from(type) }]).jpeg({ quality: 82 }).toBuffer();
const cover = await analyzeDesign(coverJpg, coverDir, { useAI: false });
await shutdownOcr();
const ct = cover.layers.filter((l) => l.type === 'text');
const coverText = ct.map((t) => t.text).join(' ').toUpperCase();
for (const word of ['VOGUE', 'SUMMER', 'STYLE', 'LOOKS', 'NEW', 'ICONS', 'BEAUTY', 'ARTISTS']) assert.ok(coverText.includes(word), `photo cover: expected "${word}" as editable text, got ${JSON.stringify(coverText)}`);
const vogue = ct.find((t) => t.text.includes('VOGUE'));
assert.ok(Math.abs(vogue.fontSize - 190) < 35, `photo cover masthead size ~190, got ${vogue.fontSize}`);
assert.ok(ct.find((t) => /icons/i.test(t.text)).italic, 'italic coverline detected');
await buildExports(coverDir, cover);
const coverPsd = readPsd(await fs.readFile(path.join(coverDir, 'design.psd')), { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true });
assert.ok(!coverPsd.children.some((c) => /original/i.test(c.name)), 'PSD must not embed the flat original');
assert.equal(coverPsd.children.find((c) => c.name === 'Text').children.length, ct.length);
console.log('Photo cover OK:', ct.map((t) => JSON.stringify(t.text)).join(' '));

// --- Gemini provider, end to end against a local mock of the Gemini API ---
{
  const http = await import('node:http');
  const reply = {
    backgroundColor: 'photo',
    textBlocks: [{ text: 'VOGUE', box_2d: [45, 107, 156, 882], role: 'masthead', fontFamily: 'Bodoni Moda', fontCategory: 'serif', fontWeight: 700, italic: false, color: '#ffffff', align: 'center', rotation: 0 }],
    imageRegions: [],
  };
  let hits = 0;
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      hits++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(reply) }] }, finishReason: 'STOP' }] }));
    });
  }).listen(0);
  await new Promise((r) => srv.on('listening', r));
  const saved = { ...process.env };
  delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.GEMINI_API_KEY = 'test-key';
  process.env.GOOGLE_GEMINI_BASE_URL = `http://localhost:${srv.address().port}`;
  const gDir = await fs.mkdtemp(path.join(os.tmpdir(), 'unflatten-gemini-'));
  const gl = await analyzeDesign(coverJpg, gDir);
  await shutdownOcr();
  srv.close();
  process.env = saved;
  assert.equal(hits, 1, 'Gemini API called once');
  assert.equal(gl.meta.provider, 'gemini');
  const gv = gl.layers.find((l) => l.type === 'text' && l.text === 'VOGUE');
  assert.ok(gv && gv.fontFamily === 'Bodoni Moda', 'Gemini font suggestion applied to masthead');
  assert.ok(gl.layers.filter((l) => l.type === 'text').length >= 6, 'OCR lines Gemini skipped are still kept');
  console.log('Gemini provider OK:', gl.meta.model);
}

console.log('\nAll checks passed ✔');
