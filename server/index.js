import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { customAlphabet } from 'nanoid';
import { analyzeDesign } from './pipeline/analyze.js';
import { aiProvider, providerModel } from './pipeline/vision.js';
import { buildExports } from './export/index.js';
import { sanitizeLayout } from './validate.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data', 'jobs');
const PORT = Number(process.env.PORT || 3000);
const JOB_TTL_MS = 24 * 60 * 60 * 1000;
const newId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 16);
const ID_RE = /^[0-9a-z]{16}$/;
const FILE_RE = /^[\w.-]+\.(png|psd|pptx|pdf|svg|zip|json)$/;

await fs.mkdir(DATA_DIR, { recursive: true });

/** In-memory job status; assets live on disk under DATA_DIR/<id>. */
const jobs = new Map();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /^image\/(png|jpe?g|webp|tiff|gif|avif|heic|heif)$/.test(file.mimetype)),
});

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(ROOT, 'public')));

app.get('/api/health', (_req, res) => res.json({ ok: true, ai: aiProvider() !== null, provider: aiProvider(), model: providerModel(aiProvider()) }));

app.post('/api/jobs', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Upload a PNG, JPG, WEBP or TIFF image in the "image" field.' });
  const id = newId();
  const dir = path.join(DATA_DIR, id);
  await fs.mkdir(dir, { recursive: true });
  const job = { id, status: 'processing', stage: 'Queued', progress: 0, createdAt: Date.now() };
  jobs.set(id, job);
  res.status(202).json({ id });

  const useAI = req.body?.ai !== 'false';
  try {
    const layout = await analyzeDesign(req.file.buffer, dir, {
      useAI,
      onProgress: (stage, progress) => Object.assign(job, { stage, progress }),
    });
    job.stage = 'Building files';
    const files = await buildExports(dir, layout);
    Object.assign(job, { status: 'done', progress: 1, stage: 'Done', layout, files });
  } catch (err) {
    console.error(`[job ${id}]`, err);
    Object.assign(job, { status: 'error', error: friendlyError(err) });
  }
});

app.get('/api/jobs/:id', async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found or expired.' });
  res.json(job);
});

/** Re-export after the user edited layers in the browser. */
app.post('/api/jobs/:id/export', async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job || job.status !== 'done') return res.status(404).json({ error: 'Job not found or not ready.' });
  const dir = path.join(DATA_DIR, job.id);
  try {
    const layout = await sanitizeLayout(req.body?.layout, job.layout, dir);
    const files = await buildExports(dir, layout);
    Object.assign(job, { layout, files });
    res.json({ layout, files });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/jobs/:id/files/:file', async (req, res) => {
  const { id, file } = req.params;
  if (!ID_RE.test(id) || !FILE_RE.test(file)) return res.status(400).end();
  const full = path.join(DATA_DIR, id, file);
  try { await fs.access(full); } catch { return res.status(404).end(); }
  if (req.query.download) res.attachment(file);
  res.sendFile(full, { maxAge: 0 });
});

async function getJob(id) {
  if (!ID_RE.test(id)) return null;
  if (jobs.has(id)) return jobs.get(id);
  // Survive restarts: rehydrate a finished job from disk.
  try {
    const dir = path.join(DATA_DIR, id);
    const layout = JSON.parse(await fs.readFile(path.join(dir, 'layout.json'), 'utf8'));
    const names = await fs.readdir(dir);
    const files = names.filter((n) => /^design[.-]/.test(n)).map((file) => ({ file }));
    const job = { id, status: 'done', progress: 1, stage: 'Done', layout, files, createdAt: Date.now() };
    jobs.set(id, job);
    return job;
  } catch { return null; }
}

function friendlyError(err) {
  if (/unsupported image format|Input buffer contains unsupported/i.test(err.message)) return 'That file could not be read as an image.';
  return `Processing failed: ${err.message}`;
}

// Housekeeping: delete jobs older than a day.
setInterval(async () => {
  for (const id of await fs.readdir(DATA_DIR).catch(() => [])) {
    const dir = path.join(DATA_DIR, id);
    const st = await fs.stat(dir).catch(() => null);
    if (st && Date.now() - st.mtimeMs > JOB_TTL_MS) {
      await fs.rm(dir, { recursive: true, force: true });
      jobs.delete(id);
    }
  }
}, 60 * 60 * 1000).unref();

app.listen(PORT, () => {
  console.log(`Design Unflattener running at http://localhost:${PORT}`);
  const p = aiProvider();
  console.log(p ? `AI layout analysis: ${p} (${providerModel(p)})` : 'AI layout analysis: disabled (set ANTHROPIC_API_KEY or GEMINI_API_KEY to enable)');
});
