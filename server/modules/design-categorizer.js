/**
 * Design Categorizer — Gemini 2.5 Flash Visual Analysis
 *
 * Analyzes design images (PNG/JPG) and categorizes them by theme, mood,
 * dominant colors, and generates marketing copy. Results are cached to
 * avoid redundant API calls.
 *
 * Uses: Google Gemini 2.5 Flash (vision)
 * Cache: /mnt/dbFiles/design-categories.json
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const sharp = require('sharp');

const CACHE_PATH = '/mnt/dbFiles/design-categories.json';

const THEMES = [
  'outdoor-adventure',
  'moto-garage',
  'faith-inspirational',
  'retro-vintage',
  'edgy-urban',
  'humor-fun',
  'nature-animals',
  'sports-fitness',
  'music-culture',
  'abstract-artistic'
];

const MOODS = ['bold', 'chill', 'dark', 'uplifting', 'nostalgic', 'playful', 'fierce', 'serene'];

const SHIRT_COLORS = ['black', 'white', 'gray', 'navy', 'cream'];

// Theme-specific reel copy templates — written to feel local & authentic
const REEL_COPY = {
  'outdoor-adventure': {
    hook: 'Adventure starts here.',
    body: 'Vintage-inspired outdoor tees for the wild at heart. Printed in Asheville — because we know mountains.',
    cta: 'Link in bio. Limited drop.'
  },
  'moto-garage': {
    hook: 'Old school garage vibes.',
    body: 'Retro motorcycle tees that look like they came from a 1970s shop. Heavy ink on premium cotton.',
    cta: 'Grab yours before they ride off. Link in bio.'
  },
  'faith-inspirational': {
    hook: 'Wear your faith.',
    body: 'Premium graphic tees with designs that speak louder than words. Made with intention in the Blue Ridge Mountains.',
    cta: 'Shop the collection. Link in bio.'
  },
  'retro-vintage': {
    hook: 'Worn-in look. Fresh off the press.',
    body: 'These vintage-style graphic tees hit different. Distressed finishes, bold colors, old-school energy.',
    cta: 'New drops weekly. Link in bio.'
  },
  'edgy-urban': {
    hook: 'Not for the faint of heart.',
    body: 'Street-ready graphic tees with an edge. Dark ink, heavy vibes, unapologetic attitude.',
    cta: 'Cop it now. Link in bio.'
  },
  'humor-fun': {
    hook: 'Warning: you will get compliments.',
    body: 'Funny graphic tees that actually land. Conversation starters printed on premium blanks.',
    cta: 'Tag someone who needs this. Link in bio.'
  },
  'nature-animals': {
    hook: 'Wild by nature.',
    body: 'Nature-inspired graphic tees for people who\'d rather be outside. Designed and printed in the mountains of Asheville.',
    cta: 'Shop the wild side. Link in bio.'
  },
  'sports-fitness': {
    hook: 'Rep the grind.',
    body: 'Athletic-inspired graphic tees that go from the gym to the street. Bold prints on soft, breathable cotton.',
    cta: 'Gear up. Link in bio.'
  },
  'music-culture': {
    hook: 'Turn it up.',
    body: 'Music-inspired graphic tees for the ones who feel it in their bones. Festival-ready, stage-worthy.',
    cta: 'Find your anthem. Link in bio.'
  },
  'abstract-artistic': {
    hook: 'Wearable art.',
    body: 'Abstract graphic tees for the creative minds. Each design is a statement piece — printed, not mass-produced.',
    cta: 'Own the original. Link in bio.'
  }
};

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

let _cache = null;

function loadCache() {
  if (_cache) return _cache;
  try {
    if (fs.existsSync(CACHE_PATH)) {
      _cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    } else {
      _cache = {};
    }
  } catch (err) {
    console.error('[design-categorizer] Failed to load cache, starting fresh:', err.message);
    _cache = {};
  }
  return _cache;
}

function saveCache() {
  try {
    const dir = path.dirname(CACHE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(_cache, null, 2), 'utf8');
  } catch (err) {
    console.error('[design-categorizer] Failed to save cache:', err.message);
  }
}

function cacheKey(imagePath) {
  // Use absolute path as key; normalize it
  return path.resolve(imagePath);
}

// ---------------------------------------------------------------------------
// Image loading
// ---------------------------------------------------------------------------

/**
 * Load an image from a local path or URL, resize to max 1024px,
 * and return { base64, mimeType }.
 */
async function loadImage(imagePathOrUrl) {
  let buffer;

  if (/^https?:\/\//.test(imagePathOrUrl)) {
    buffer = await fetchUrl(imagePathOrUrl);
  } else {
    if (!fs.existsSync(imagePathOrUrl)) {
      throw new Error(`Image not found: ${imagePathOrUrl}`);
    }
    buffer = fs.readFileSync(imagePathOrUrl);
  }

  // Resize with sharp — keep aspect, max 1024px on longest side
  const resized = await sharp(buffer)
    .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();

  return {
    base64: resized.toString('base64'),
    mimeType: 'image/jpeg'
  };
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : require('http');
    mod.get(url, { timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} fetching image`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Gemini API
// ---------------------------------------------------------------------------

function geminiRequest(payload) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const parsed = new URL(url);

    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 30000
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          const json = JSON.parse(raw);
          if (res.statusCode !== 200) {
            return reject(new Error(`Gemini API ${res.statusCode}: ${json.error?.message || raw}`));
          }
          resolve(json);
        } catch (e) {
          reject(new Error(`Gemini response parse error: ${raw.slice(0, 500)}`));
        }
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Gemini request timed out')); });
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Core categorization
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a graphic tee design analyst for a custom apparel brand in Asheville, NC.
Analyze the design image and return a JSON object with these exact fields:

{
  "theme": one of: ${JSON.stringify(THEMES)},
  "mood": one of: ${JSON.stringify(MOODS)},
  "colors": ["color1", "color2", ...] — dominant colors in the design (2-5 colors, use simple names like "red", "black", "gold", "forest green"),
  "keywords": ["kw1", "kw2", "kw3"] — 3 to 5 descriptive keywords about the design,
  "suggestedShirtColors": ["color1", "color2"] — 2-3 shirt colors from ${JSON.stringify(SHIRT_COLORS)} that would best complement this design
}

Rules:
- Pick the SINGLE best theme and mood
- For colors, describe what you see in the actual artwork
- For shirt colors, think about contrast and what makes the design pop
- Keywords should describe the subject matter and visual style
- Return ONLY valid JSON, no markdown fences, no extra text`;

/**
 * Categorize a single design image.
 * @param {string} imagePathOrUrl - Local file path or HTTP(S) URL
 * @param {object} [opts]
 * @param {boolean} [opts.skipCache=false] - Force re-analysis
 * @returns {Promise<object>} Category object
 */
async function categorizeDesign(imagePathOrUrl, opts = {}) {
  const cache = loadCache();
  const key = cacheKey(imagePathOrUrl);

  if (!opts.skipCache && cache[key]) {
    return cache[key];
  }

  const img = await loadImage(imagePathOrUrl);

  const payload = {
    contents: [{
      parts: [
        {
          inlineData: {
            mimeType: img.mimeType,
            data: img.base64
          }
        },
        {
          text: SYSTEM_PROMPT
        }
      ]
    }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 1024,
      thinkingConfig: {
        thinkingBudget: 0
      }
    }
  };

  const response = await geminiRequest(payload);

  // Extract text from response
  const text = response.candidates?.[0]?.content?.parts
    ?.filter(p => p.text)
    ?.map(p => p.text)
    ?.join('') || '';

  // Parse JSON from response (strip markdown fences if present)
  const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    console.error('[design-categorizer] Failed to parse Gemini response:', text.slice(0, 500));
    throw new Error('Failed to parse Gemini categorization response');
  }

  // Validate and normalize
  const result = {
    theme: THEMES.includes(parsed.theme) ? parsed.theme : 'abstract-artistic',
    mood: MOODS.includes(parsed.mood) ? parsed.mood : 'bold',
    colors: Array.isArray(parsed.colors) ? parsed.colors.slice(0, 5) : [],
    keywords: Array.isArray(parsed.keywords) ? parsed.keywords.slice(0, 5) : [],
    suggestedShirtColors: Array.isArray(parsed.suggestedShirtColors)
      ? parsed.suggestedShirtColors.filter(c => SHIRT_COLORS.includes(c))
      : ['black', 'white'],
    reelCopy: REEL_COPY[THEMES.includes(parsed.theme) ? parsed.theme : 'abstract-artistic'],
    analyzedAt: new Date().toISOString(),
    source: imagePathOrUrl
  };

  // Cache it
  cache[key] = result;
  _cache = cache;
  saveCache();

  return result;
}

/**
 * Batch categorize a collection of design images.
 * @param {string[]} imagePaths - Array of file paths or URLs
 * @param {object} [opts]
 * @param {boolean} [opts.skipCache=false]
 * @param {number} [opts.concurrency=2] - Max parallel requests
 * @param {function} [opts.onProgress] - Called with (completed, total, result)
 * @returns {Promise<object[]>} Array of category objects (same order as input)
 */
async function categorizeCollection(imagePaths, opts = {}) {
  const concurrency = opts.concurrency || 2;
  const results = new Array(imagePaths.length);
  let completed = 0;

  // Process in batches
  for (let i = 0; i < imagePaths.length; i += concurrency) {
    const batch = imagePaths.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(
      batch.map(p => categorizeDesign(p, { skipCache: opts.skipCache }))
    );

    for (let j = 0; j < batchResults.length; j++) {
      const idx = i + j;
      if (batchResults[j].status === 'fulfilled') {
        results[idx] = batchResults[j].value;
      } else {
        console.error(`[design-categorizer] Failed on ${imagePaths[idx]}:`, batchResults[j].reason?.message);
        results[idx] = {
          theme: null,
          mood: null,
          colors: [],
          keywords: [],
          suggestedShirtColors: [],
          reelCopy: null,
          error: batchResults[j].reason?.message || 'Unknown error',
          source: imagePaths[idx]
        };
      }
      completed++;
      if (opts.onProgress) {
        opts.onProgress(completed, imagePaths.length, results[idx]);
      }
    }

    // Small delay between batches to avoid rate limits
    if (i + concurrency < imagePaths.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  return results;
}

/**
 * Get cached category for a design (no API call).
 * @param {string} imagePathOrUrl
 * @returns {object|null}
 */
function getDesignCategory(imagePathOrUrl) {
  const cache = loadCache();
  return cache[cacheKey(imagePathOrUrl)] || null;
}

// ---------------------------------------------------------------------------
// Artwork identification — includes human-friendly title generation
// ---------------------------------------------------------------------------

const ARTWORK_IDENTIFY_PROMPT = `You are naming and categorizing artwork for a custom art and apparel shop in Asheville, NC.

Look at this image and return a JSON object with these exact fields:

{
  "title": "Short, natural artwork title",
  "theme": one of: ${JSON.stringify(THEMES)},
  "mood": one of: ${JSON.stringify(MOODS)},
  "colors": ["color1", "color2", ...] — dominant colors (2-5, simple names),
  "keywords": ["kw1", "kw2", "kw3"] — 3 to 5 descriptive keywords,
  "suggestedShirtColors": ["color1", "color2"] — 2-3 from ${JSON.stringify(SHIRT_COLORS)}
}

Title rules:
- Write a short, evocative title a real artist or gallery would use (2-6 words)
- Examples of good titles: "Morning Fog Over the Ridgeline", "Highland Cow at Dawn", "Neon Diner Glow", "Mushroom Forest Floor"
- NO technical terms, NO photography jargon, NO AI-sounding phrases
- Do NOT include words like: "ultra-wide", "panoramic", "cinematic", "photography of", "hyper-realistic", "8k", "generated", "prompt", "render"
- Do NOT start with "A" or "The" unless it sounds natural
- Make it sound like something you'd see on a gallery wall or a product listing
- Return ONLY valid JSON, no markdown fences, no extra text`;

const ARTWORK_CACHE_PATH = '/mnt/dbFiles/artwork-identifications.json';
let _artworkCache = null;

function loadArtworkCache() {
  if (_artworkCache) return _artworkCache;
  try {
    if (fs.existsSync(ARTWORK_CACHE_PATH)) {
      _artworkCache = JSON.parse(fs.readFileSync(ARTWORK_CACHE_PATH, 'utf8'));
    } else {
      _artworkCache = {};
    }
  } catch (err) {
    console.error('[design-categorizer] Failed to load artwork cache:', err.message);
    _artworkCache = {};
  }
  return _artworkCache;
}

function saveArtworkCache() {
  try {
    const dir = path.dirname(ARTWORK_CACHE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ARTWORK_CACHE_PATH, JSON.stringify(_artworkCache, null, 2), 'utf8');
  } catch (err) {
    console.error('[design-categorizer] Failed to save artwork cache:', err.message);
  }
}

/**
 * Identify artwork — categorize + generate human-friendly title.
 * @param {string} imagePathOrUrl - Local file path or HTTP(S) URL
 * @param {object} [opts]
 * @param {boolean} [opts.skipCache=false]
 * @param {string} [opts.hint] - Extra context to help with identification (e.g. partial name, location)
 * @returns {Promise<object>} Identification with title
 */
async function identifyArtwork(imagePathOrUrl, opts = {}) {
  const cache = loadArtworkCache();
  const key = cacheKey(imagePathOrUrl);

  if (!opts.skipCache && cache[key]) {
    return cache[key];
  }

  const img = await loadImage(imagePathOrUrl);

  let prompt = ARTWORK_IDENTIFY_PROMPT;
  if (opts.hint) {
    prompt += `\n\nAdditional context: ${opts.hint}`;
  }

  const payload = {
    contents: [{
      parts: [
        {
          inlineData: {
            mimeType: img.mimeType,
            data: img.base64
          }
        },
        {
          text: prompt
        }
      ]
    }],
    generationConfig: {
      temperature: 0.5,
      maxOutputTokens: 1024,
      thinkingConfig: {
        thinkingBudget: 0
      }
    }
  };

  const response = await geminiRequest(payload);

  const text = response.candidates?.[0]?.content?.parts
    ?.filter(p => p.text)
    ?.map(p => p.text)
    ?.join('') || '';

  const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    console.error('[design-categorizer] Failed to parse artwork identify response:', text.slice(0, 500));
    throw new Error('Failed to parse artwork identification response');
  }

  const result = {
    title: (parsed.title || '').trim(),
    theme: THEMES.includes(parsed.theme) ? parsed.theme : 'abstract-artistic',
    mood: MOODS.includes(parsed.mood) ? parsed.mood : 'bold',
    colors: Array.isArray(parsed.colors) ? parsed.colors.slice(0, 5) : [],
    keywords: Array.isArray(parsed.keywords) ? parsed.keywords.slice(0, 5) : [],
    suggestedShirtColors: Array.isArray(parsed.suggestedShirtColors)
      ? parsed.suggestedShirtColors.filter(c => SHIRT_COLORS.includes(c))
      : ['black', 'white'],
    reelCopy: REEL_COPY[THEMES.includes(parsed.theme) ? parsed.theme : 'abstract-artistic'],
    analyzedAt: new Date().toISOString(),
    source: imagePathOrUrl
  };

  cache[key] = result;
  _artworkCache = cache;
  saveArtworkCache();

  return result;
}

module.exports = {
  categorizeDesign,
  categorizeCollection,
  getDesignCategory,
  identifyArtwork,
  THEMES
};
