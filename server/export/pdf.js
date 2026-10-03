import path from 'node:path';
import PDFDocument from 'pdfkit';
import { pdfStandardFont, textGeometry, textLines, visibleLayers } from './common.js';

/**
 * Single-page vector PDF with live text. Canva, Illustrator, Affinity and most
 * editors import PDF text as editable text boxes. Uses PDF base fonts so it
 * works everywhere; swap fonts after import for an exact match.
 */
export function buildPdf(jobDir, layout) {
  const { width: W, height: H } = layout;
  const s = 0.75; // 96 dpi pixels → points
  const doc = new PDFDocument({ size: [W * s, H * s], margin: 0, autoFirstPage: true, info: { Title: 'Editable design', Creator: 'Design Unflattener' } });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  doc.image(path.join(jobDir, layout.background.src), 0, 0, { width: W * s, height: H * s });
  for (const layer of visibleLayers(layout)) {
    if (layer.type === 'image') {
      doc.image(path.join(jobDir, layer.src), layer.x * s, layer.y * s, { width: layer.w * s, height: layer.h * s });
      continue;
    }
    const { baseline, anchorX } = textGeometry(layer);
    const size = layer.fontSize * s;
    doc.save();
    if (layer.rotation) doc.rotate(layer.rotation, { origin: [anchorX * s, baseline * s] });
    doc.font(pdfStandardFont(layer.fontCategory, layer.fontWeight, layer.italic)).fontSize(size).fillColor(layer.color);
    textLines(layer).forEach((line, i) => {
      const spacing = (layer.letterSpacing || 0) * s;
      const width = doc.widthOfString(line, { characterSpacing: spacing });
      let x = anchorX * s;
      if (layer.align === 'center') x -= width / 2;
      else if (layer.align === 'right') x -= width;
      doc.text(line, x, (baseline + i * layer.lineHeight) * s, { lineBreak: false, baseline: 'alphabetic', characterSpacing: spacing });
    });
    doc.restore();
  }
  doc.end();
  return done;
}
