import { GoogleGenAI } from '@google/genai';
import sharp from 'sharp';
import { SYSTEM_PROMPT } from './prompt.js';

/**
 * Google Gemini as an alternative layout analyser (has a free tier).
 * Gemini is trained to localise objects as box_2d = [ymin, xmin, ymax, xmax]
 * normalised to 0-1000, so we ask for that and convert back to pixels.
 */
export const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const VISION_SIDE = 1536;

export const geminiKey = () => process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';

const box2d = { type: 'array', items: { type: 'integer' }, description: '[ymin, xmin, ymax, xmax], each normalised to 0-1000' };

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
          box_2d: box2d,
          role: { type: 'string', enum: ['masthead', 'headline', 'subheadline', 'body', 'caption', 'pullquote', 'byline', 'label', 'other'] },
          fontFamily: { type: 'string', description: 'Closest freely available Google Font family name.' },
          fontCategory: { type: 'string', enum: ['serif', 'sans-serif', 'display', 'script', 'monospace'] },
          fontWeight: { type: 'integer', description: '100-900' },
          italic: { type: 'boolean' },
          color: { type: 'string', description: '#rrggbb' },
          align: { type: 'string', enum: ['left', 'center', 'right', 'justify'] },
          rotation: { type: 'number', description: 'Degrees clockwise, 0 for horizontal text.' },
        },
        required: ['text', 'box_2d', 'role', 'fontFamily', 'fontCategory', 'fontWeight', 'italic', 'color', 'align', 'rotation'],
      },
    },
    imageRegions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          box_2d: box2d,
          kind: { type: 'string', enum: ['photo', 'illustration', 'logo', 'shape', 'cutout'] },
        },
        required: ['name', 'box_2d', 'kind'],
      },
    },
  },
  required: ['backgroundColor', 'textBlocks', 'imageRegions'],
};

export async function analyzeWithGemini(pngBuffer, width, height) {
  const scale = Math.min(1, VISION_SIDE / Math.max(width, height));
  const jpeg = await sharp(pngBuffer).resize(Math.round(width * scale), Math.round(height * scale)).jpeg({ quality: 90 }).toBuffer();

  const ai = new GoogleGenAI({ apiKey: geminiKey() });
  const res = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: 'image/jpeg', data: jpeg.toString('base64') } },
        { text: 'Extract every text block and image region as JSON. Give every box as box_2d = [ymin, xmin, ymax, xmax] normalised to 0-1000.' },
      ],
    }],
    config: {
      systemInstruction: SYSTEM_PROMPT,
      responseMimeType: 'application/json',
      responseJsonSchema: SCHEMA,
      temperature: 0.2,
    },
  });

  const text = res.text;
  if (!text) {
    const reason = res.promptFeedback?.blockReason || res.candidates?.[0]?.finishReason || 'empty response';
    throw new Error(`Gemini returned no layout (${reason}).`);
  }
  const result = JSON.parse(text);
  const toBox = (b) => {
    if (!Array.isArray(b) || b.length !== 4) return { x: 0, y: 0, w: 1, h: 1 };
    const [y0, x0, y1, x1] = b.map(Number);
    return { x: (x0 / 1000) * width, y: (y0 / 1000) * height, w: ((x1 - x0) / 1000) * width, h: ((y1 - y0) / 1000) * height };
  };
  return {
    backgroundColor: result.backgroundColor || '',
    textBlocks: (result.textBlocks || []).map(({ box_2d, ...t }) => ({ ...t, box: toBox(box_2d) })).filter((t) => t.box.w > 1 && t.box.h > 1),
    imageRegions: (result.imageRegions || []).map(({ box_2d, ...r }) => ({ ...r, box: toBox(box_2d) })).filter((r) => r.box.w > 1 && r.box.h > 1),
  };
}
