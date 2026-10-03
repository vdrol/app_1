import { writePsdBuffer } from 'ag-psd';
import { fromHex } from '../pipeline/image.js';
import { postScriptName, readRgba, textGeometry, textLines } from './common.js';

/**
 * Layered Photoshop document:
 *   Text (group)    – live, editable type layers
 *   Images (group)  – photos / shapes as separate pixel layers
 *   Background      – clean plate with text and graphics removed
 *   Original        – hidden reference copy of the upload
 */
export async function buildPsd(jobDir, layout) {
  const original = await readRgba(jobDir, layout.original);
  const background = await readRgba(jobDir, layout.background.src);

  const imageChildren = [];
  const textChildren = [];
  for (const layer of layout.layers) {
    if (layer.type === 'image') {
      const img = await readRgba(jobDir, layer.src);
      imageChildren.push({ name: layer.name, left: Math.round(layer.x), top: Math.round(layer.y), imageData: img, hidden: layer.visible === false });
    } else if (layer.type === 'text') {
      textChildren.push(await textLayer(jobDir, layer));
    }
  }

  const psd = {
    width: layout.width,
    height: layout.height,
    imageData: original, // composite preview (thumbnail / apps without layer support)
    children: [
      { name: 'Original (reference)', hidden: true, imageData: original },
      { name: 'Background', imageData: background },
      { name: 'Images', opened: true, children: imageChildren.reverse() },
      { name: 'Text', opened: true, children: textChildren.reverse() },
    ],
  };
  // invalidateTextLayers makes Photoshop re-render the type with real fonts on open.
  return Buffer.from(writePsdBuffer(psd, { invalidateTextLayers: true, generateThumbnail: false }));
}

async function textLayer(jobDir, layer) {
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
  // Pre-rendered pixels so the layer looks right even before Photoshop updates it
  // (and in viewers that can't render type).
  if (layer.preview && layer.previewBox && !layer.edited) {
    try {
      tl.imageData = await readRgba(jobDir, layer.preview);
      tl.left = layer.previewBox.x; tl.top = layer.previewBox.y;
    } catch { /* preview is optional */ }
  }
  return tl;
}

function rotationTransform(deg, tx, ty) {
  const a = (deg * Math.PI) / 180;
  return [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), tx, ty];
}
