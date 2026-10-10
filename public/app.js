const $ = (s) => document.querySelector(s);
const views = { upload: $('#uploadView'), progress: $('#progressView'), editor: $('#editorView') };

const POPULAR_FONTS = [
  'Playfair Display', 'Bodoni Moda', 'Libre Bodoni', 'DM Serif Display', 'Abril Fatface', 'Cormorant Garamond', 'EB Garamond',
  'Libre Caslon Text', 'Lora', 'Merriweather', 'Prata', 'Cinzel', 'Bebas Neue', 'Oswald', 'Anton', 'Archivo Black',
  'Montserrat', 'Inter', 'Roboto', 'Open Sans', 'Lato', 'Poppins', 'Raleway', 'Work Sans', 'Didact Gothic', 'Josefin Sans',
  'League Spartan', 'Space Grotesk', 'Barlow Condensed', 'Pacifico', 'Great Vibes', 'Dancing Script', 'Space Mono',
];
$('#fontList').innerHTML = POPULAR_FONTS.map((f) => `<option value="${f}">`).join('');

const state = { jobId: null, layout: null, files: [], selected: null, view: 'rebuilt', zoom: 1, dirty: false };

// ---------- Upload ----------
const dz = $('#dropzone');
const fileInput = $('#fileInput');
dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
fileInput.addEventListener('change', () => fileInput.files[0] && start(fileInput.files[0]));
['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
dz.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) start(f); });
document.addEventListener('paste', (e) => {
  if (views.upload.hidden) return;
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) start(item.getAsFile());
});
$('#newBtn').addEventListener('click', () => { history.replaceState(null, '', location.pathname); show('upload'); fileInput.value = ''; });

fetch('/api/health').then((r) => r.json()).then(({ ai, provider }) => {
  $('#aiToggle').checked = ai;
  $('#aiToggle').disabled = !ai;
  const name = provider === 'gemini' ? 'Gemini' : 'Claude';
  $('#aiStatus').textContent = ai ? `(${name} reads fonts & layout)` : '(no ANTHROPIC_API_KEY or GEMINI_API_KEY on the server — OCR only)';
}).catch(() => {});

function show(name) {
  for (const [k, el] of Object.entries(views)) el.hidden = k !== name;
  $('#newBtn').hidden = name === 'upload';
}

async function start(file) {
  if (!file.type.startsWith('image/')) return alert('Please choose an image file.');
  $('#progressThumb').src = URL.createObjectURL(file);
  setProgress('Uploading…', 0.02);
  show('progress');
  const body = new FormData();
  body.append('image', file);
  body.append('ai', String($('#aiToggle').checked));
  try {
    const res = await fetch('/api/jobs', { method: 'POST', body });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    history.replaceState(null, '', `#${data.id}`);
    await poll(data.id);
  } catch (err) {
    alert(err.message);
    show('upload');
  }
}

function setProgress(stage, p) {
  $('#progressStage').textContent = stage;
  $('#progressBar').style.width = `${Math.round(p * 100)}%`;
}

async function poll(id) {
  for (;;) {
    const res = await fetch(`/api/jobs/${id}`);
    const job = await res.json();
    if (!res.ok) throw new Error(job.error || 'Job not found');
    if (job.status === 'error') throw new Error(job.error);
    setProgress(job.stage + '…', Math.max(0.05, job.progress));
    if (job.status === 'done') return openEditor(job);
    await new Promise((r) => setTimeout(r, 700));
  }
}

// ---------- Editor ----------
const stage = $('#stage');
const viewport = $('#viewport');
const fileUrl = (f, dl) => `/api/jobs/${state.jobId}/files/${f}${dl ? '?download=1' : `?v=${Date.now()}`}`;

function openEditor(job) {
  state.jobId = job.id;
  state.layout = job.layout;
  state.files = job.files;
  state.selected = null;
  state.dirty = false;
  show('editor');
  fitZoom();
  render();
  renderDownloads();
  const w = job.layout.meta?.warnings || [];
  $('#warnings').textContent = [job.layout.meta?.ai ? `Layout analysed with ${job.layout.meta.model}.` : 'OCR-only mode.', ...w].join(' ');
}

function fitZoom() {
  const avail = viewport.clientWidth - 48;
  const z = Math.min(1, avail / state.layout.width);
  state.zoom = z;
  $('#zoom').value = Math.round(z * 100);
}
$('#zoom').addEventListener('input', (e) => { state.zoom = e.target.value / 100; applyZoom(); });

function applyZoom() {
  const { width, height } = state.layout;
  stage.style.transform = `scale(${state.zoom})`;
  // Reserve the scaled footprint so the viewport scrolls correctly.
  stage.style.marginBottom = `${height * (state.zoom - 1)}px`;
  stage.style.marginRight = `${width * (state.zoom - 1)}px`;
  stage.style.marginLeft = width * state.zoom < viewport.clientWidth - 48 ? `${(viewport.clientWidth - 48 - width * state.zoom) / 2}px` : '0';
}

document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
  state.view = b.dataset.view;
  document.querySelectorAll('[data-view]').forEach((x) => x.classList.toggle('active', x === b));
  render();
}));

/** Same geometry the server uses for exports (server/export/common.js). */
function textBoxTop(l) {
  const baseline = l.y + (l.baselineRatio ?? 0.8) * l.fontSize;
  return baseline - (l.lineHeight / 2 + 0.32 * l.fontSize);
}

const loadedFonts = new Set();
function ensureFont(family) {
  if (!family || loadedFonts.has(family)) return;
  loadedFonts.add(family);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:ital,wght@0,100..900;1,100..900&display=swap`;
  link.onerror = () => {
    // Static-only families don't support the variable axis range; fall back to common weights.
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:ital,wght@0,400;0,700;1,400;1,700&display=swap`;
  };
  document.head.appendChild(link);
}

const generic = (c) => ({ serif: 'serif', display: 'serif', script: 'cursive', monospace: 'monospace' }[c] || 'sans-serif');

function render() {
  const L = state.layout;
  stage.style.width = `${L.width}px`;
  stage.style.height = `${L.height}px`;
  stage.style.background = L.background.color;
  stage.innerHTML = '';
  applyZoom();

  if (state.view === 'original') {
    stage.appendChild(img(fileUrl(L.original), { left: 0, top: 0, width: L.width, height: L.height }, 'orig'));
  } else {
    stage.appendChild(img(fileUrl(L.background.src), { left: 0, top: 0, width: L.width, height: L.height }));
    if (state.view === 'rebuilt') {
      for (const layer of L.layers) {
        if (layer.visible === false) continue;
        const el = layer.type === 'image' ? img(fileUrl(layer.src), { left: layer.x, top: layer.y, width: layer.w, height: layer.h }) : textEl(layer);
        el.classList.add('layer');
        el.dataset.id = layer.id;
        if (layer.id === state.selected) el.classList.add('selected');
        enableDrag(el, layer);
        stage.appendChild(el);
      }
    }
  }
  renderLayerList();
  renderProps();
}

function img(src, box, cls) {
  const el = document.createElement('img');
  el.src = src;
  el.alt = '';
  Object.assign(el.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
  if (cls) el.className = cls;
  return el;
}

function textEl(l) {
  ensureFont(l.fontFamily);
  const el = document.createElement('div');
  el.className = 'text-layer';
  el.textContent = l.text;
  const anchorLeft = l.align === 'center' ? l.x + l.w / 2 : l.align === 'right' ? l.x + l.w : l.x;
  Object.assign(el.style, {
    top: `${textBoxTop(l)}px`,
    left: `${anchorLeft}px`,
    transform: `${l.align === 'center' ? 'translateX(-50%)' : l.align === 'right' ? 'translateX(-100%)' : ''} rotate(${l.rotation || 0}deg)`,
    transformOrigin: 'left top',
    fontFamily: `'${l.fontFamily}', ${generic(l.fontCategory)}`,
    fontSize: `${l.fontSize}px`,
    lineHeight: `${l.lineHeight}px`,
    fontWeight: l.fontWeight,
    fontStyle: l.italic ? 'italic' : 'normal',
    color: l.color,
    letterSpacing: `${l.letterSpacing || 0}px`,
    textAlign: l.align === 'justify' ? 'left' : l.align,
  });
  el.addEventListener('dblclick', () => $('#pText').focus());
  return el;
}

function enableDrag(el, layer) {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    select(layer.id);
    const sx = e.clientX, sy = e.clientY, ox = layer.x, oy = layer.y;
    let moved = false;
    const target = stage.querySelector(`[data-id="${layer.id}"]`);
    target.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const dx = (ev.clientX - sx) / state.zoom, dy = (ev.clientY - sy) / state.zoom;
      if (!moved && Math.hypot(dx, dy) < 2) return;
      moved = true;
      layer.x = Math.round(ox + dx); layer.y = Math.round(oy + dy);
      const tx = layer.x - ox, ty = layer.y - oy;
      target.style.translate = `${tx}px ${ty}px`;
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      if (moved) { markDirty(); render(); }
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  });
}

viewport.addEventListener('pointerdown', (e) => { if (!e.target.closest('.layer')) select(null); });

function select(id) {
  if (state.selected === id) return;
  state.selected = id;
  stage.querySelectorAll('.layer').forEach((el) => el.classList.toggle('selected', el.dataset.id === id));
  renderLayerList();
  renderProps();
}

function renderLayerList() {
  const list = $('#layerList');
  const layers = [...state.layout.layers].reverse(); // top-most first, like Photoshop
  $('#layerCount').textContent = `(${layers.length + 1})`;
  list.innerHTML = '';
  for (const l of layers) {
    const li = document.createElement('li');
    li.className = `${l.id === state.selected ? 'selected' : ''} ${l.visible === false ? 'off' : ''}`;
    li.innerHTML = `<span class="kind">${l.type === 'text' ? 'T' : '▣'}</span><span class="name"></span><button class="eye" title="Show / hide" aria-label="Toggle visibility">${l.visible === false ? '○' : '●'}</button>`;
    li.querySelector('.name').textContent = l.type === 'text' ? l.text.replace(/\s+/g, ' ') || '(empty)' : l.name;
    li.addEventListener('click', () => select(l.id));
    li.querySelector('.eye').addEventListener('click', (e) => { e.stopPropagation(); l.visible = l.visible === false; markDirty(); render(); });
    list.appendChild(li);
  }
  const bg = document.createElement('li');
  bg.innerHTML = '<span class="kind">■</span><span class="name">Background (text removed)</span>';
  list.appendChild(bg);
}

// ---------- Properties ----------
const P = {
  text: $('#pText'), font: $('#pFont'), category: $('#pCategory'), size: $('#pSize'), line: $('#pLine'),
  track: $('#pTrack'), weight: $('#pWeight'), color: $('#pColor'), italic: $('#pItalic'),
};
const current = () => state.layout?.layers.find((l) => l.id === state.selected);

function renderProps() {
  const l = current();
  $('#propsSection').hidden = !l || l.type !== 'text';
  if (!l || l.type !== 'text') return;
  if (document.activeElement !== P.text) P.text.value = l.text;
  if (document.activeElement !== P.font) P.font.value = l.fontFamily;
  P.category.value = l.fontCategory;
  P.size.value = l.fontSize;
  P.line.value = l.lineHeight;
  P.track.value = l.letterSpacing || 0;
  P.weight.value = String(Math.round(l.fontWeight / 100) * 100);
  P.color.value = l.color;
  P.italic.checked = l.italic;
  document.querySelectorAll('#pAlign button').forEach((b) => b.classList.toggle('active', b.dataset.align === l.align));
}

function bind(input, ev, apply) {
  input.addEventListener(ev, () => { const l = current(); if (!l) return; apply(l, input); markDirty(); rerenderLayer(l); });
}
bind(P.text, 'input', (l, i) => { l.text = i.value; });
bind(P.font, 'change', (l, i) => { l.fontFamily = i.value.trim() || l.fontFamily; });
bind(P.category, 'change', (l, i) => { l.fontCategory = i.value; });
bind(P.size, 'input', (l, i) => {
  const v = parseFloat(i.value); if (!(v > 0)) return;
  l.lineHeight = Math.round(l.lineHeight * (v / l.fontSize) * 10) / 10; // keep leading proportional
  l.fontSize = v;
});
bind(P.line, 'input', (l, i) => { const v = parseFloat(i.value); if (v > 0) l.lineHeight = v; });
bind(P.track, 'input', (l, i) => { l.letterSpacing = parseFloat(i.value) || 0; });
bind(P.weight, 'change', (l, i) => { l.fontWeight = parseInt(i.value, 10); });
bind(P.color, 'input', (l, i) => { l.color = i.value; });
bind(P.italic, 'change', (l, i) => { l.italic = i.checked; });
document.querySelectorAll('#pAlign button').forEach((b) => b.addEventListener('click', () => {
  const l = current(); if (!l) return;
  l.align = b.dataset.align; markDirty(); rerenderLayer(l); renderProps();
}));

function rerenderLayer(l) {
  const old = stage.querySelector(`[data-id="${l.id}"]`);
  if (!old) return render();
  const el = textEl(l);
  el.classList.add('layer', 'selected');
  el.dataset.id = l.id;
  enableDrag(el, l);
  old.replaceWith(el);
  const li = $('#layerList li.selected .name');
  if (li) li.textContent = l.text.replace(/\s+/g, ' ') || '(empty)';
}

document.addEventListener('keydown', (e) => {
  const l = current();
  if (!l || views.editor.hidden || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
  const step = e.shiftKey ? 10 : 1;
  const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (d) { e.preventDefault(); l.x += d[0]; l.y += d[1]; markDirty(); render(); }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); l.visible = false; markDirty(); render(); }
  if (e.key === 'Escape') select(null);
});

// ---------- Downloads ----------
function markDirty() {
  state.dirty = true;
  $('#rebuildBtn').disabled = false;
  $('#rebuildHint').textContent = 'You have unsaved edits — rebuild to include them in the downloads.';
}

const ORDER = ['design.psd', 'design.pptx', 'design.pdf', 'design.svg', 'design-bundle.zip'];
const LABELS = {
  'design.psd': ['Photoshop', '.psd'], 'design.pptx': ['Canva / PowerPoint', '.pptx'], 'design.pdf': ['PDF, live text', '.pdf'],
  'design.svg': ['Illustrator / Figma', '.svg'], 'design-bundle.zip': ['Everything + layer PNGs', '.zip'],
};
function renderDownloads() {
  const files = [...state.files].sort((a, b) => ORDER.indexOf(a.file) - ORDER.indexOf(b.file));
  $('#downloads').innerHTML = files.map((f) => {
    const [label, ext] = LABELS[f.file] || [f.file, ''];
    const size = f.bytes ? `${(f.bytes / 1024 / 1024).toFixed(1)} MB` : ext;
    return `<a href="${fileUrl(f.file, true)}" class="${/psd|pptx/.test(f.file) ? 'featured' : ''}" download>${label} <small>${ext} · ${size}</small></a>`;
  }).join('');
}

$('#rebuildBtn').addEventListener('click', async () => {
  const btn = $('#rebuildBtn');
  btn.disabled = true; btn.textContent = 'Rebuilding…';
  try {
    const res = await fetch(`/api/jobs/${state.jobId}/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ layout: state.layout }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    const sel = state.selected;
    state.layout = data.layout; state.files = data.files; state.dirty = false; state.selected = sel;
    renderDownloads(); render();
    $('#rebuildHint').textContent = 'Files updated with your edits.';
  } catch (err) {
    alert(`Rebuild failed: ${err.message}`);
    btn.disabled = false;
  } finally {
    btn.textContent = 'Apply edits to files';
  }
});

window.addEventListener('beforeunload', (e) => { if (state.dirty) e.preventDefault(); });
window.addEventListener('resize', () => state.layout && applyZoom());

// Deep link: /#<jobId> reopens a finished job.
const hash = location.hash.slice(1);
if (/^[0-9a-z]{16}$/.test(hash)) {
  show('progress'); setProgress('Loading…', 0.5);
  poll(hash).catch(() => { history.replaceState(null, '', location.pathname); show('upload'); });
}
