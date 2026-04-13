/**
 * Catalog Classifier — LLaVA Vision AI
 *
 * Fetches design images, resizes them, sends to LLaVA for visual analysis,
 * and returns structured classification data (description, category, tags, productType).
 */

const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const ollamaClient = require('./ollama-client');

// Predefined categories for classification
const CATEGORIES = [
  'anime', 'automotive', 'band-merch', 'beer-wine', 'boating', 'camping',
  'christian', 'country-life', 'custom-text', 'dad-humor', 'dog-lover',
  'family', 'fantasy', 'fishing', 'fitness', 'floral', 'food-drink',
  'funny', 'gaming', 'gun-rights', 'hippie', 'holiday', 'horror',
  'hunting', 'jdm', 'kids', 'military', 'mom-life', 'motorcycle',
  'music', 'nature', 'patriotic', 'pet', 'political', 'sports',
  'truck', 'vintage-retro'
];

// Predefined product types
const PRODUCT_TYPES = [
  'sticker', 'vinyl-decal', 'bumper-sticker', 'window-decal', 'laptop-sticker',
  't-shirt', 'hoodie', 'mug', 'phone-case', 'metal-print',
  'canvas', 'poster', 'magnet', 'patch', 'pin'
];

/**
 * Fetch an image from URL and return as Buffer
 */
function fetchImage(imageUrl) {
  return new Promise((resolve, reject) => {
    const client = imageUrl.startsWith('https') ? https : http;
    const req = client.get(imageUrl, { timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect
        fetchImage(res.headers.location).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} fetching image: ${imageUrl}`));
        return;
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Image fetch timeout')); });
  });
}

/**
 * Resize image to 512x512 JPEG for LLaVA analysis
 */
async function resizeImage(imageBuffer) {
  return sharp(imageBuffer)
    .resize(512, 512, { fit: 'inside', withoutEnlargement: false })
    .jpeg({ quality: 80 })
    .toBuffer();
}

/**
 * Build the vision prompt for LLaVA
 */
function buildPrompt(design, currentCategory) {
  return `You are a product catalog classifier for a custom vinyl/sticker shop.
Analyze this design image and return ONLY valid JSON (no markdown, no explanation):

{
  "description": "1-2 sentence description of what this design shows",
  "suggestedCategory": "best category from the list below",
  "tags": ["tag1", "tag2", "tag3"],
  "productType": "best type from the list below"
}

Categories: ${CATEGORIES.join(', ')}
Product types: ${PRODUCT_TYPES.join(', ')}

Design name: "${design.name || ''}"
Current category: "${currentCategory || 'unknown'}"

Return ONLY the JSON object, nothing else.`;
}

/**
 * Parse JSON from LLaVA response, handling markdown fences and partial JSON
 */
function parseResponse(responseText) {
  if (!responseText || typeof responseText !== 'string') {
    return null;
  }

  let text = responseText.trim();

  // Remove markdown code fences
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  text = text.trim();

  // Try direct parse
  try {
    return JSON.parse(text);
  } catch (e) {
    // Try to extract JSON object from text
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch (e2) {
        // Try fixing common issues: trailing commas, unquoted keys
        let fixed = jsonMatch[0]
          .replace(/,\s*}/g, '}')
          .replace(/,\s*]/g, ']');
        try {
          return JSON.parse(fixed);
        } catch (e3) {
          return null;
        }
      }
    }
    return null;
  }
}

/**
 * Validate and normalize parsed classification result
 */
function normalizeResult(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;

  const result = {};

  // Description
  result.description = typeof parsed.description === 'string'
    ? parsed.description.slice(0, 500)
    : '';

  // Category — validate against known list
  const cat = (parsed.suggestedCategory || '').toLowerCase().trim();
  result.suggestedCategory = CATEGORIES.includes(cat) ? cat : (parsed.suggestedCategory || 'unknown');

  // Tags — ensure array of strings
  if (Array.isArray(parsed.tags)) {
    result.tags = parsed.tags
      .filter(t => typeof t === 'string')
      .map(t => t.toLowerCase().trim())
      .filter(t => t.length > 0)
      .slice(0, 8);
  } else {
    result.tags = [];
  }

  // Product type — validate against known list
  const pt = (parsed.productType || '').toLowerCase().trim();
  result.productType = PRODUCT_TYPES.includes(pt) ? pt : 'sticker';

  return result;
}

/**
 * Classify a single design using LLaVA vision
 *
 * @param {object} design - { id, name, image, ... }
 * @param {object} options - { currentCategory, timeout }
 * @returns {object} { description, suggestedCategory, tags, productType, classifiedAt }
 */
async function classifyDesign(design, options = {}) {
  const currentCategory = options.currentCategory || '';
  const timeout = options.timeout || 120000;

  if (!design.image) {
    throw new Error(`Design "${design.name || design.id}" has no image URL`);
  }

  // 1. Fetch image
  const imageBuffer = await fetchImage(design.image);

  // 2. Resize to 512x512
  const resized = await resizeImage(imageBuffer);

  // 3. Convert to base64
  const base64Image = resized.toString('base64');

  // 4. Build prompt
  const prompt = buildPrompt(design, currentCategory);

  // 5. Call LLaVA via ollama client
  const response = await ollamaClient.vision(prompt, [base64Image], {
    timeout,
    temperature: 0.3,
    maxTokens: 500
  });

  // 6. Parse response
  const parsed = parseResponse(response);
  if (!parsed) {
    throw new Error(`Failed to parse LLaVA response for "${design.name}": ${response.slice(0, 200)}`);
  }

  // 7. Normalize and validate
  const result = normalizeResult(parsed);
  if (!result) {
    throw new Error(`Failed to normalize LLaVA result for "${design.name}"`);
  }

  result.classifiedAt = new Date().toISOString();
  return result;
}

module.exports = {
  classifyDesign,
  CATEGORIES,
  PRODUCT_TYPES,
  parseResponse,
  normalizeResult
};
