import { writePsdBuffer } from 'ag-psd';
import { fromHex } from '../pipeline/image.js';
import { postScriptName, readRgba, textGeometry, textLines } from './common.js';

/**
 * Layered Photoshop document:
 *   Text (group)    – live, editable type layers
 *   Images (group)  – photos / shapes as separate pixel layers
 *   Background      – clean plate with text and graphics removed
 *
 * The original upload is deliberately NOT embedded: some importers (Canva, older
 * viewers) ignore the hidden flag or show only the composite, which made the
 * file look like a flat copy of the photo.
 */
export async function buildPsd(jobDir, layout, { composite } = {}) {
  const background = await readRgba(jobDir, layout.background.src);

  const imageChildren = [];
  const textChildren = [];
  for (const layer of layout.layers) {
    if (layer.type === 'image') {
      const img = await readRgba(jobDir, layer.src);
      imageChildren.push({ name: layer.name, left: Math.round(layer.x), top: Math.round(layer.y), imageData: img, hidden: layer.visible === false });
    } else if (layer.type === 'text') {
      textChildren.push(textLayer(layer));
    }
  }

  const psd = {
    width: layout.width,
    height: layout.height,
    // Composite = the rebuilt design (rendered from our SVG), used for thumbnails and
    // by apps that can't read layers.
    imageData: composite || background,
    children: [
      { name: 'Background', imageData: background },
      { name: 'Images', opened: true, children: imageChildren.reverse() },
      { name: 'Text', opened: true, children: textChildren.reverse() },
    ],
  };
  // invalidateTextLayers makes Photoshop re-render the type with real fonts on open.
  return Buffer.from(writePsdBuffer(psd, { invalidateTextLayers: true, generateThumbnail: false }));
}

function textLayer(layer) {
  const { baseline, anchorX } = textGeometry(layer);
  const [r, g, b] = fromHex(layer.color);
  const text = textLines(layer).join('\r');
  const tl = {
    name: layer.name,
    hidden: layer.visible === false,
    text: {
      text,
      transform: rotationTransform(layer.rotation || 0, anchorX, baseline),
      antiAlias: 'smooth',
      style: {
        font: { name: postScriptName(layer.fontFamily, layer.fontWeight, layer.italic) },
        fontSize: layer.fontSize,
        fillColor: { r, g, b },
        autoLeading: false,
        leading: layer.lineHeight,
        tracking: Math.round((layer.letterSpacing || 0) / layer.fontSize * 1000),
        fauxBold: false,
        fauxItalic: false,
      },
      paragraphStyle: {
        justification: { left: 'left', center: 'center', right: 'right', justify: 'justify-left' }[layer.align] || 'left',
      },
    },
  };
  return tl;
}

function rotationTransform(deg, tx, ty) {
  const a = (deg * Math.PI) / 180;
  return [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), tx, ty];
}
