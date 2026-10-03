import path from 'node:path';
import PptxGenJS from 'pptxgenjs';
import { snapWeight, textGeometry, textLines, visibleLayers } from './common.js';

/**
 * PowerPoint file sized exactly to the design. This is the most faithful route
 * into Canva (Canva → Create → Import file), Google Slides and Keynote: every
 * text box stays editable and every image is a separate, movable element.
 */
export async function buildPptx(jobDir, layout) {
  const { width: W, height: H } = layout;
  // PowerPoint slides max out at 56in; keep the long side at 13.333in (16:9 width).
  const inch = 13.333 / Math.max(W, H);
  const slideW = W * inch, slideH = H * inch;
  const pt = inch * 72; // points per pixel

  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'DESIGN', width: slideW, height: slideH });
  pptx.layout = 'DESIGN';
  pptx.title = 'Editable design';
  const slide = pptx.addSlide();
  slide.background = { color: layout.background.color.replace('#', '') };
  slide.addImage({ path: path.join(jobDir, layout.background.src), x: 0, y: 0, w: slideW, h: slideH, altText: 'Background' });

  for (const layer of visibleLayers(layout)) {
    if (layer.type === 'image') {
      slide.addImage({ path: path.join(jobDir, layer.src), x: layer.x * inch, y: layer.y * inch, w: layer.w * inch, h: layer.h * inch, altText: layer.name });
      continue;
    }
    const { boxTop, boxHeight } = textGeometry(layer);
    // Give the frame a little slack so a slightly wider substitute font doesn't re-wrap lines.
    const slack = layer.w * 0.12;
    const x = layer.align === 'center' ? layer.x - slack / 2 : layer.align === 'right' ? layer.x - slack : layer.x;
    slide.addText(textLines(layer).join('\n'), {
      x: x * inch, y: boxTop * inch, w: (layer.w + slack) * inch, h: boxHeight * inch,
      fontFace: layer.fontFamily,
      fontSize: Math.max(1, layer.fontSize * pt),
      bold: snapWeight(layer.fontWeight) >= 600,
      italic: Boolean(layer.italic),
      color: layer.color.replace('#', ''),
      align: layer.align === 'justify' ? 'justify' : layer.align,
      valign: 'top',
      lineSpacing: layer.lineHeight * pt,
      charSpacing: (layer.letterSpacing || 0) * pt,
      margin: 0,
      inset: 0,
      wrap: false,
      fit: 'none',
      rotate: layer.rotation || 0,
      paraSpaceBefore: 0,
      paraSpaceAfter: 0,
    });
  }
  return pptx.write({ outputType: 'nodebuffer' });
}
