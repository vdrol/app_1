# Design Unflattener

Upload **one image** of a magazine page, cover, poster or ad. Get back a **layered, editable design** you can open in **Photoshop** and **Canva**:

| File | Open in | What you get |
|---|---|---|
| `design.psd` | Photoshop, Photopea, Affinity | Live **type layers** (editable text with font, size, colour, leading, alignment), separate image layers, and a clean background with the text erased (the flat original is not embedded, so nothing can sit under or replace your layers) |
| `design.pptx` | **Canva** (Create a design → Import file), PowerPoint, Keynote, Google Slides | Slide sized to the design; every text box and image is a separate editable element. The most reliable way into Canva |
| `design.pdf` | Canva, Illustrator, Acrobat | Vector PDF with live text over image layers |
| `design.svg` | Illustrator, Figma, Inkscape | Live `<text>` and embedded image layers |
| `design-bundle.zip` | — | All of the above, plus every layer as a PNG and `layout.json` |

There's also an in-browser editor: before downloading you can fix any text, change fonts, sizes, colours and alignment, drag layers around, hide layers, then rebuild the files.

## How it works

```
image ─► OCR (4 preprocessing passes + per-line re-read) ─┐
      └► Claude vision (optional): text blocks, fonts,     ├─► text layers ─► mask ─► inpaint ─► clean background
         roles, image regions                              ┘                                     │
                                         flat background? ─► segment photos/shapes into layers ◄─┘
                                                              │
                                         exporters: PSD (ag-psd) · PPTX (pptxgenjs) · PDF (pdfkit) · SVG
```

1. **Text detection.** Tesseract runs on the original and greyscale page plus Sauvola-binarised maps (light-on-dark and dark-on-light, at two window sizes, plus a half-size pass for giant mastheads). The binarised maps strip a photographic background down to crisp letterforms, so type printed over photos is found too. Lines are split at column gutters, de-duplicated, then each line is re-read from a crop binarised with its own ink and paper colours.
2. **Layout understanding (optional, recommended).** With an Anthropic or Gemini API key, the model reads the page to group lines into text frames, transcribe stylised display type, label roles (masthead, headline, body…), suggest the closest Google Font, and find photos. Its blocks are snapped to the precise OCR boxes. (Gemini returns its native `box_2d` 0–1000 coordinates, which are converted to pixels.)
3. **Typography measurement.** Font size comes from line-box height and glyph classes (caps, ascenders, descenders). Leading comes from baseline pitch, colour from 2-means ink/paper clustering, weight from stroke width, and alignment from line edges.
4. **Background reconstruction.** Text pixels (with anti-aliasing) are masked and filled with a push–pull pyramid inpainter, with grain re-added on textured backgrounds.
5. **Image separation.** On flat backgrounds, large non-background regions (photos, panels, shapes) become their own layers with alpha, and are knocked out of the background plate. On photographic covers, Claude's regions are lifted as layers.

## Run it

Requires Node.js 20+.

```bash
npm install
npm start                       # http://localhost:3000
```

Turn on AI layout analysis (strongly recommended for real magazine pages) with **either** provider:

```bash
# Claude
export ANTHROPIC_API_KEY=sk-ant-...

# or Google Gemini (has a free tier: create a key at https://aistudio.google.com/apikey)
export GEMINI_API_KEY=...

npm start
```

If both keys are set, Claude is used; set `AI_PROVIDER=gemini` to prefer Gemini.

| Env var | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Turns on Claude vision analysis |
| `CLAUDE_MODEL` | `claude-opus-5-5` | Claude model used for layout analysis |
| `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | — | Turns on Gemini vision analysis |
| `GEMINI_MODEL` | `gemini-flash-latest` | Gemini model used for layout analysis |
| `AI_PROVIDER` | auto | `claude` or `gemini` to force one when both keys are set |
| `DISABLE_AI` | — | Set to `1` to force OCR-only mode |
| `PORT` | `3000` | |
| `DATA_DIR` | `./data/jobs` | Where uploads and outputs are stored (deleted after 24h) |

Everything else runs locally and offline. The OCR language data ships as an npm package.

### Test

```bash
npm test
```

This builds a synthetic magazine page and runs the whole pipeline in OCR-only mode, plus an AI-assisted pass using a canned Claude response. It then checks the detected text, sizes, colours, weights, alignment, text removal, image separation, and that the PSD contains live text layers.

## API

| Method | Path | |
|---|---|---|
| `POST` | `/api/jobs` | multipart `image` (+ optional `ai=false`) → `{ id }` |
| `GET` | `/api/jobs/:id` | status, progress, `layout`, `files` |
| `POST` | `/api/jobs/:id/export` | `{ layout }` (edited) → rebuilds all files |
| `GET` | `/api/jobs/:id/files/:file` | download (`?download=1` for attachment) |

## Tips and limitations

- **Input quality matters.** Use a flat scan or screenshot rather than an angled phone photo; 1500px+ on the long side is ideal.
- **Fonts.** Font suggestions are free Google Fonts, and Canva has nearly all of them built in. Photoshop will flag fonts you don't have installed: install them from fonts.google.com for an exact match, or let Photoshop substitute. The PDF uses standard PDF fonts, so for exact typefaces in Canva, use the PPTX.
- **Photoshop text layers.** When you open the PSD, Photoshop may ask to update text layers. Choose *Update* to render them with the real fonts.
- **What isn't reconstructed.** Text on curves, heavy effects (outlines, shadows), and objects layered behind other photos. These stay as pixels in the background or image layers.
- The background behind removed text is synthesised. It's clean on flat colours and gradients, and approximate on detailed photos.
