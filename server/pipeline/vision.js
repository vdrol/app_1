import Anthropic from '@anthropic-ai/sdk';
import sharp from 'sharp';
import { SYSTEM_PROMPT } from './prompt.js';
import { analyzeWithGemini, geminiKey, GEMINI_MODEL } from './gemini.js';

/**
 * Optional AI layout analysis. Gives us what OCR can't: correct reading of
 * stylised display type, which lines belong together, typeface identification,
 * and where the photos/illustrations are.
 *
 * Provider: Claude when ANTHROPIC_API_KEY is set, otherwise Gemini when
 * GEMINI_API_KEY (or GOOGLE_API_KEY) is set. AI_PROVIDER=claude|gemini forces one.
 */
export const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
const VISION_SIDE = 1568;

export function aiProvider() {
  if (process.env.DISABLE_AI === '1') return null;
  const claude = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  const gemini = Boolean(geminiKey());
  const forced = (process.env.AI_PROVIDER || '').toLowerCase();
  if (forced === 'claude') return claude ? 'claude' : null;
  if (forced === 'gemini') return gemini ? 'gemini' : null;
  return claude ? 'claude' : gemini ? 'gemini' : null;
}

export const visionAvailable = () => aiProvider() !== null;

export const providerModel = (provider) => (provider === 'gemini' ? GEMINI_MODEL : provider === 'claude' ? MODEL : null);

/** Run layout analysis with whichever provider is configured. */
export async function analyzeLayout(pngBuffer, width, height) {
  const provider = aiProvider();
  if (provider === 'gemini') return { provider, result: await analyzeWithGemini(pngBuffer, width, height) };
  if (provider === 'claude') return { provider, result: await analyzeWithClaude(pngBuffer, width, height) };
  throw new Error('No AI provider configured');
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
    system: SYSTEM_PROMPT,
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
