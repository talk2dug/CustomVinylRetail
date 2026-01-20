const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { Anthropic } = require('@anthropic-ai/sdk');

const ENV_PATH = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(ENV_PATH)) {
  require('dotenv').config({ path: ENV_PATH });
}

const MAX_IMAGE_BYTES = Number(process.env.CLAUDE_IMAGE_MAX_BYTES || 5000000);
const CLAUDE_MODEL = (process.env.CLAUDE_MODEL || 'claude-3-5-sonnet-20241022').trim();
function cleanKey(value) {
  if (!value) return '';
  let trimmed = String(value).trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    trimmed = trimmed.slice(1, -1);
  }
  return trimmed;
}

const ANTHROPIC_API_KEY = cleanKey(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || '');
const anthropicClient = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

async function fetchCompletion(messages, systemPrompt) {
  if (!anthropicClient) {
    throw new Error('Anthropic client not configured. Please set ANTHROPIC_API_KEY in .env file.');
  }
  const result = await anthropicClient.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 150,
    temperature: 0.2,
    system: systemPrompt,
    messages: messages
  });
  return result.content[0].text.trim();
}

function formatFolderName(folder) {
  if (!folder) return '';
  return String(folder).split(path.sep).pop() || folder;
}

async function describeCatalogDesign({ category, fileName, imagePath, imageBase64, mediaType }) {
  if (!anthropicClient) {
    return '';
  }

  let base64Image;
  let imageMediaType = mediaType || 'image/jpeg';

  if (imageBase64) {
    // Use provided base64 image directly (resize it first)
    const inputBuffer = Buffer.from(imageBase64, 'base64');
    const resized = await sharp(inputBuffer)
      .resize({ width: 1024, height: 1024, fit: 'inside' })
      .jpeg({ quality: 80 })
      .toBuffer();
    base64Image = resized.toString('base64');
    imageMediaType = 'image/jpeg'; // After resize it's JPEG
  } else if (imagePath && fs.existsSync(imagePath)) {
    // Resize image from file path
    const resized = await sharp(imagePath)
      .resize({ width: 1024, height: 1024, fit: 'inside' })
      .jpeg({ quality: 80 })
      .toBuffer();
    base64Image = resized.toString('base64');
    imageMediaType = 'image/jpeg';
  } else {
    return '';
  }

  const systemPrompt = `You are a catalog assistant that writes concise, descriptive metadata for wall art designs.
Focus on the visual content and style, not the filename. Keep descriptions clear and professional.
You must respond in valid JSON format only.`;

  const messages = [
    {
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/jpeg',
            data: base64Image
          }
        },
        {
          type: 'text',
          text: `Category: ${formatFolderName(category) || 'General'}
File: ${fileName || 'Unknown'}

Analyze this wall art design and provide:
1. A short, descriptive title (4-10 words) that captures what the design depicts
2. An SEO-friendly filename (lowercase, hyphens, no spaces, 3-6 words, no file extension)

Respond ONLY with valid JSON in this exact format:
{"description": "Your descriptive title here", "filename": "seo-friendly-filename-here"}`
        }
      ]
    }
  ];

  const response = await fetchCompletion(messages, systemPrompt);

  // Parse JSON response
  try {
    const parsed = JSON.parse(response);
    return parsed;
  } catch (e) {
    // Fallback: if not valid JSON, return as description only
    return { description: response, filename: null };
  }
}

module.exports = { describeCatalogDesign };
