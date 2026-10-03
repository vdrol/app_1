import Anthropic from '@anthropic-ai/sdk';
import sharp from 'sharp';

/**
 * Optional AI layout analysis with Claude's vision. Gives us what OCR can't:
 * correct reading of stylised display type, which lines belong together,
 * typeface identification, and where the photos/illustrations are.
 *
 * Enabled when ANTHROPIC_API_KEY (or another SDK credential) is configured.
 */
export const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
const VISION_SIDE = 1568;

export function visionAvailable() {
  if (process.env.DISABLE_AI === '1') return false;
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

const box = {
  type: 'object',
  properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
  required: ['x', 'y', 'w', 'h'],
  additionalProperties: false,
};

const SCHEMA = {
  type: 'object',
  properties: {
    backgroundColor: { type: 'string', description: 'Dominant background colour as #rrggbb, or "photo" if the background is a photograph.' },
    textBlocks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Exact text, with \\n between visual lines.' },
          box,
          role: { type: 'string', enum: ['masthead', 'headline', 'subheadline', 'body', 'caption', 'pullquote', 'byline', 'label', 'other'] },
          fontFamily: { type: 'string', description: 'Closest freely available Google Font family name.' },
          fontCategory: { type: 'string', enum: ['serif', 'sans-serif', 'display', 'script', 'monospace'] },
          fontWeight: { type: 'integer', description: '100-900' },
          italic: { type: 'boolean' },
          color: { type: 'string', description: '#rrggbb' },
          align: { type: 'string', enum: ['left', 'center', 'right', 'justify'] },
          rotation: { type: 'number', description: 'Degrees clockwise, 0 for horizontal text.' },
        },
        required: ['text', 'box', 'role', 'fontFamily', 'fontCategory', 'fontWeight', 'italic', 'color', 'align', 'rotation'],
        additionalProperties: false,
      },
    },
    imageRegions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          box,
          kind: { type: 'string', enum: ['photo', 'illustration', 'logo', 'shape', 'cutout'] },
        },
        required: ['name', 'box', 'kind'],
        additionalProperties: false,
      },
    },
  },
  required: ['backgroundColor', 'textBlocks', 'imageRegions'],
  additionalProperties: false,
};

const SYSTEM = `You are a senior editorial designer reverse-engineering a flattened magazine or publication layout into editable layers.
Coordinates are integer pixels in the image you are given, origin top-left; boxes are tight around the visible ink.
Text blocks: one block per typographic unit that a designer would set as a single text frame (same font, size, colour and alignment). Transcribe exactly, preserving case and line breaks as they appear. Include every legible piece of text, including tiny captions, folios and barcodes' numbers; skip text that is part of a photo (e.g. signage in a street scene) unless it is clearly a design element.
Fonts: name the closest Google Font (e.g. Playfair Display, Bodoni Moda, Didact Gothic, Oswald, Montserrat, Libre Caslon Text, Abril Fatface, Bebas Neue, Inter, Lora). Mastheads are often Didone serifs or custom wordmarks; pick the nearest match.
Image regions: photographs, illustrations, logos, and solid colour panels/shapes that sit on top of the page background. Do not list the full-page background itself. On a full-bleed photo cover, list the main subject cut-out only if it overlaps the masthead.`;

export async function analyzeWithClaude(pngBuffer, width, height) {
  const scale = Math.min(1, VISION_SIDE / Math.max(width, height));
  const vw = Math.round(width * scale), vh = Math.round(height * scale);
  const jpeg = await sharp(pngBuffer).resize(vw, vh).jpeg({ quality: 90 }).toBuffer();

  const client = new Anthropic();
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } },
        { type: 'text', text: `This image is ${vw}x${vh} pixels. Extract every text block and image region as JSON.` },
      ],
    }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') throw new Error('Claude declined to analyse this image.');
  if (msg.stop_reason === 'max_tokens') throw new Error('Layout analysis was cut off (design too dense).');
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const result = JSON.parse(text);

  const up = (b) => ({ x: b.x / scale, y: b.y / scale, w: b.w / scale, h: b.h / scale });
  return {
    backgroundColor: result.backgroundColor,
    textBlocks: result.textBlocks.map((t) => ({ ...t, box: up(t.box) })),
    imageRegions: result.imageRegions.map((r) => ({ ...r, box: up(r.box) })),
  };
}
