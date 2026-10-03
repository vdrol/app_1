import { genericFamily, readFile, textGeometry, textLines, visibleLayers, snapWeight } from './common.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Self-contained SVG with live <text> — opens in Illustrator, Figma, Inkscape, Affinity. */
export async function buildSvg(jobDir, layout) {
  const { width: W, height: H } = layout;
  const dataUri = async (f) => `data:image/png;base64,${(await readFile(jobDir, f)).toString('base64')}`;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<g id="Background"><image width="${W}" height="${H}" xlink:href="${await dataUri(layout.background.src)}"/></g>`,
  ];
  for (const layer of visibleLayers(layout)) {
    if (layer.type === 'image') {
      parts.push(`<g id="${esc(layer.name)}"><image x="${layer.x}" y="${layer.y}" width="${layer.w}" height="${layer.h}" xlink:href="${await dataUri(layer.src)}"/></g>`);
      continue;
    }
    const { baseline, anchorX } = textGeometry(layer);
    const anchor = { center: 'middle', right: 'end' }[layer.align] || 'start';
    const rot = layer.rotation ? ` transform="rotate(${layer.rotation} ${anchorX} ${baseline})"` : '';
    const tspans = textLines(layer).map((line, i) => `<tspan x="${anchorX}" y="${round(baseline + i * layer.lineHeight)}">${esc(line) || ' '}</tspan>`).join('');
    parts.push(`<text id="${esc(layer.name)}" font-family="'${esc(layer.fontFamily)}', ${genericFamily(layer.fontCategory)}" font-size="${layer.fontSize}" font-weight="${snapWeight(layer.fontWeight)}"${layer.italic ? ' font-style="italic"' : ''} fill="${layer.color}" text-anchor="${anchor}"${layer.letterSpacing ? ` letter-spacing="${layer.letterSpacing}"` : ''} xml:space="preserve"${rot}>${tspans}</text>`);
  }
  parts.push('</svg>');
  return Buffer.from(parts.join('\n'));
}

const round = (v) => Math.round(v * 10) / 10;
