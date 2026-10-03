import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const WEIGHT_NAMES = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' };

export const snapWeight = (w) => Math.min(900, Math.max(100, Math.round((w || 400) / 100) * 100));

/** PostScript name the way Google Fonts names its static instances, e.g. PlayfairDisplay-BoldItalic. */
export function postScriptName(family, weight, italic) {
  const base = (family || 'Arial').replace(/[^A-Za-z0-9]/g, '');
  let style = WEIGHT_NAMES[snapWeight(weight)];
  if (italic) style = style === 'Regular' ? 'Italic' : `${style}Italic`;
  return `${base}-${style}`;
}

export function genericFamily(category) {
  return { serif: 'serif', 'sans-serif': 'sans-serif', display: 'serif', script: 'cursive', monospace: 'monospace' }[category] || 'sans-serif';
}

/** pdfkit's built-in (non-embedded) fonts. */
export function pdfStandardFont(category, weight, italic) {
  const bold = snapWeight(weight) >= 600;
  if (category === 'monospace') return `Courier${bold && italic ? '-BoldOblique' : bold ? '-Bold' : italic ? '-Oblique' : ''}`;
  if (category === 'serif' || category === 'display') return bold && italic ? 'Times-BoldItalic' : bold ? 'Times-Bold' : italic ? 'Times-Italic' : 'Times-Roman';
  return `Helvetica${bold && italic ? '-BoldOblique' : bold ? '-Bold' : italic ? '-Oblique' : ''}`;
}

export const textLines = (layer) => String(layer.text ?? '').split(/\r?\n/);

/** Position of the first baseline and the horizontal anchor for a text layer. */
export function textGeometry(layer) {
  const baseline = layer.y + (layer.baselineRatio ?? 0.8) * layer.fontSize;
  const anchorX = layer.align === 'center' ? layer.x + layer.w / 2 : layer.align === 'right' ? layer.x + layer.w : layer.x;
  // Top of a CSS/PowerPoint-style line box whose first baseline lands on `baseline`.
  const boxTop = baseline - (layer.lineHeight / 2 + 0.32 * layer.fontSize);
  const nLines = textLines(layer).length;
  const boxHeight = layer.lineHeight * nLines;
  return { baseline, anchorX, boxTop, boxHeight, nLines };
}

export async function readRgba(jobDir, file) {
  const { data, info } = await sharp(path.join(jobDir, file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length) };
}

export const readFile = (jobDir, file) => fs.readFile(path.join(jobDir, file));

export const visibleLayers = (layout) => layout.layers.filter((l) => l.visible !== false);
