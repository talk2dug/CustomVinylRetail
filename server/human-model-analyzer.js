/**
 * Human Model Image Analyzer
 * Uses Gemini Vision (primary) or Claude Vision (fallback) to extract metadata:
 * - Gender (male, female)
 * - Ethnicity (caucasian, black, asian, hispanic, middle-eastern, south-asian, mixed, other)
 * - Apparel Type (t-shirt, hoodie, tank-top, long-sleeve, polo, crewneck, v-neck, sweatshirt, jacket)
 * - Facing Direction (front, back, side-left, side-right, three-quarter)
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk').Anthropic; } catch (_) {}

const ENV_PATH = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(ENV_PATH)) {
  require('dotenv').config({ path: ENV_PATH });
}

const CLAUDE_MODEL = (process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514').trim();

function cleanKey(value) {
  if (!value) return '';
  let trimmed = String(value).trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    trimmed = trimmed.slice(1, -1);
  }
  return trimmed;
}

const ANTHROPIC_API_KEY = cleanKey(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || '');
const anthropicClient = (ANTHROPIC_API_KEY && Anthropic) ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;
const GEMINI_API_KEY = cleanKey(process.env.GEMINI_API_KEY || '');
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=`;

const ANALYSIS_PROMPT = `You are an image analysis assistant specializing in identifying characteristics of human models wearing apparel for e-commerce mockup purposes.

Analyze the image and extract the following information:
1. Gender: male or female
2. Ethnicity: caucasian, black, asian, hispanic, middle-eastern, south-asian, mixed, or other
3. Apparel Type: The type of upper-body garment (t-shirt, hoodie, tank-top, long-sleeve, polo, crewneck, v-neck, sweatshirt, jacket, dress, or other)
4. Facing: Which direction the model is facing (front, back, side-left, side-right, three-quarter-left, three-quarter-right)
5. Pose: Standing, sitting, casual, formal, action, etc.
6. Multiple people: If there are multiple people, describe the PRIMARY subject (the one most centered/prominent).

Respond ONLY with valid JSON in this exact format:
{
  "gender": "male|female",
  "ethnicity": "caucasian|black|asian|hispanic|middle-eastern|south-asian|mixed|other",
  "apparel_type": "t-shirt|hoodie|tank-top|long-sleeve|polo|crewneck|v-neck|sweatshirt|jacket|dress|other",
  "facing": "front|back|side-left|side-right|three-quarter-left|three-quarter-right",
  "pose": "string describing the pose",
  "confidence": 0.0-1.0
}`;

const validGenders = ['male', 'female'];
const validEthnicities = ['caucasian', 'black', 'asian', 'hispanic', 'middle-eastern', 'south-asian', 'mixed', 'other'];
const validApparelTypes = ['t-shirt', 'hoodie', 'tank-top', 'long-sleeve', 'polo', 'crewneck', 'v-neck', 'sweatshirt', 'jacket', 'dress', 'other'];
const validFacings = ['front', 'back', 'side-left', 'side-right', 'three-quarter-left', 'three-quarter-right'];

function parseAnalysisResponse(responseText) {
  let jsonStr = responseText.trim();
  // Extract JSON from markdown code blocks
  if (jsonStr.includes('```')) {
    const match = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (match) jsonStr = match[1].trim();
  }
  // Fallback: find first { ... } block
  if (!jsonStr.startsWith('{')) {
    const braceMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (braceMatch) jsonStr = braceMatch[0];
  }
  const metadata = JSON.parse(jsonStr);
  return {
    gender: validGenders.includes(metadata.gender?.toLowerCase()) ? metadata.gender.toLowerCase() : null,
    ethnicity: validEthnicities.includes(metadata.ethnicity?.toLowerCase()) ? metadata.ethnicity.toLowerCase() : null,
    apparel_type: validApparelTypes.includes(metadata.apparel_type?.toLowerCase()) ? metadata.apparel_type.toLowerCase() : null,
    facing: validFacings.includes(metadata.facing?.toLowerCase()) ? metadata.facing.toLowerCase() : 'front',
    pose: metadata.pose || null,
    confidence: typeof metadata.confidence === 'number' ? metadata.confidence : 0.8
  };
}

/**
 * Analyze via Gemini Vision API (primary — free/cheap)
 */
async function analyzeWithGemini(base64Image) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');

  const url = GEMINI_URL + GEMINI_API_KEY;
  console.log(`[HumanModelAnalyzer] Gemini URL: ${url.substring(0, 80)}... (image: ${(base64Image.length / 1024).toFixed(0)}KB)`);

  const body = {
    contents: [{
      parts: [
        { inlineData: { mimeType: 'image/jpeg', data: base64Image } },
        { text: ANALYSIS_PROMPT + '\n\nAnalyze this human model image and provide the metadata as JSON.' }
      ]
    }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 1024, thinkingConfig: { thinkingBudget: 0 } }
  };

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000)
    });
  } catch (fetchErr) {
    console.error(`[HumanModelAnalyzer] Gemini fetch error: ${fetchErr.message}`);
    throw fetchErr;
  }

  console.log(`[HumanModelAnalyzer] Gemini response status: ${resp.status}`);

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    console.error(`[HumanModelAnalyzer] Gemini API error: ${resp.status} ${errText.substring(0, 300)}`);
    throw new Error(`Gemini API ${resp.status}: ${errText.substring(0, 200)}`);
  }

  const data = await resp.json();
  // Gemini 2.5 may return multiple parts (thinking + response). Find the text part with JSON.
  const parts = data.candidates?.[0]?.content?.parts || [];
  console.log(`[HumanModelAnalyzer] Gemini parts count: ${parts.length}, types: ${parts.map(p => p.thought ? 'thought' : 'text').join(',')}`);
  // Concatenate all text parts (skip thought parts)
  let text = parts.filter(p => p.text && !p.thought).map(p => p.text).join('\n');
  if (!text) text = parts.map(p => p.text || '').join('\n'); // fallback: include everything
  if (!text) {
    console.error('[HumanModelAnalyzer] No text in Gemini response:', JSON.stringify(data).substring(0, 300));
    throw new Error('No text in Gemini response');
  }

  console.log(`[HumanModelAnalyzer] Gemini raw response (${parts.length} parts, ${text.length} chars): ${JSON.stringify(text.substring(0, 400))}`);
  try {
    const result = parseAnalysisResponse(text);
    console.log(`[HumanModelAnalyzer] Gemini parsed OK:`, JSON.stringify(result));
    return result;
  } catch (parseErr) {
    console.error(`[HumanModelAnalyzer] Gemini parse failed: ${parseErr.message}, raw: ${text.substring(0, 300)}`);
    throw parseErr;
  }
}

/**
 * Analyze via Claude Vision API (fallback)
 */
async function analyzeWithClaude(base64Image) {
  if (!anthropicClient) throw new Error('Anthropic client not configured');

  const result = await anthropicClient.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 300,
    temperature: 0.1,
    system: ANALYSIS_PROMPT,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Image } },
        { type: 'text', text: 'Analyze this human model image and provide the metadata as JSON.' }
      ]
    }]
  });

  return parseAnalysisResponse(result.content[0].text);
}

/**
 * Analyze a human model image and extract metadata.
 * Tries Gemini first (cheaper), falls back to Claude.
 */
async function analyzeHumanModel(imagePath) {
  if (!GEMINI_API_KEY && !anthropicClient) {
    throw new Error('No AI API configured. Set GEMINI_API_KEY or ANTHROPIC_API_KEY in .env');
  }

  if (!fs.existsSync(imagePath)) {
    throw new Error(`Image not found: ${imagePath}`);
  }

  const resized = await sharp(imagePath)
    .resize({ width: 1024, height: 1024, fit: 'inside' })
    .jpeg({ quality: 85 })
    .toBuffer();

  const base64Image = resized.toString('base64');

  // Try Gemini first, fall back to Claude
  console.log(`[HumanModelAnalyzer] GEMINI_API_KEY set: ${!!GEMINI_API_KEY}, Anthropic set: ${!!anthropicClient}`);
  if (GEMINI_API_KEY) {
    try {
      console.log('[HumanModelAnalyzer] Attempting Gemini analysis...');
      return await analyzeWithGemini(base64Image);
    } catch (err) {
      console.warn('[HumanModelAnalyzer] Gemini failed, trying Claude:', err.message, err.stack?.split('\n')[1]);
    }
  }

  if (anthropicClient) {
    try {
      return await analyzeWithClaude(base64Image);
    } catch (err) {
      console.error('[HumanModelAnalyzer] Claude also failed:', err.message);
      throw err;
    }
  }

  throw new Error('All AI backends failed');
}

/**
 * Analyze multiple human models and update the database
 * @param {Object} db - Database connection
 * @param {Array} modelIds - Array of model IDs to analyze (or null for all)
 * @param {Function} progressCallback - Called with { current, total, modelId, status }
 */
async function analyzeAndUpdateModels(db, modelIds = null, progressCallback = null) {
  // Get models to analyze
  let query = 'SELECT id, file_path, title FROM human_models WHERE active = 1';
  const params = [];

  if (modelIds && modelIds.length > 0) {
    query += ` AND id IN (${modelIds.map(() => '?').join(',')})`;
    params.push(...modelIds);
  } else {
    // Only analyze models that don't have metadata yet
    query += ' AND (ethnicity IS NULL OR apparel_type IS NULL OR facing IS NULL)';
  }

  const models = db.prepare(query).all(...params);
  const total = models.length;
  let current = 0;
  let success = 0;
  let failed = 0;

  console.log(`[HumanModelAnalyzer] Analyzing ${total} models...`);

  for (const model of models) {
    current++;

    if (progressCallback) {
      progressCallback({ current, total, modelId: model.id, status: 'analyzing' });
    }

    try {
      // Resolve the full path
      const fullPath = model.file_path.startsWith('/')
        ? path.join(process.env.WEB_ROOT || '/home/ubuntu/vinylApp/web', model.file_path)
        : model.file_path;

      console.log(`[HumanModelAnalyzer] [${current}/${total}] Analyzing: ${model.title || model.id}`);

      const metadata = await analyzeHumanModel(fullPath);

      // Generate category from metadata: Gender-Apparel-Direction
      // Capitalize first letter of each part for cleaner display
      const capitalize = (str) => str ? str.charAt(0).toUpperCase() + str.slice(1).toLowerCase() : '';
      const categoryParts = [
        capitalize(metadata.gender),
        capitalize(metadata.apparel_type?.replace(/-/g, ' ')),
        capitalize(metadata.facing?.replace(/-/g, ' '))
      ].filter(Boolean);
      const category = categoryParts.length >= 2 ? categoryParts.join('-') : null;

      // Update the database
      db.prepare(`
        UPDATE human_models
        SET gender = ?, ethnicity = ?, apparel_type = ?, facing = ?, pose_type = ?, category = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        metadata.gender,
        metadata.ethnicity,
        metadata.apparel_type,
        metadata.facing,
        metadata.pose,
        category,
        model.id
      );

      console.log(`[HumanModelAnalyzer] Updated ${model.id}: gender=${metadata.gender}, ethnicity=${metadata.ethnicity}, apparel=${metadata.apparel_type}, facing=${metadata.facing}, category=${category}`);
      success++;

      if (progressCallback) {
        progressCallback({ current, total, modelId: model.id, status: 'complete', metadata });
      }

      // Rate limiting - wait 500ms between API calls
      await new Promise(resolve => setTimeout(resolve, 500));

    } catch (err) {
      console.error(`[HumanModelAnalyzer] Failed to analyze ${model.id}:`, err.message);
      failed++;

      if (progressCallback) {
        progressCallback({ current, total, modelId: model.id, status: 'error', error: err.message });
      }
    }
  }

  return { total, success, failed };
}

module.exports = {
  analyzeHumanModel,
  analyzeAndUpdateModels
};

// CLI usage
if (require.main === module) {
  const Database = require('better-sqlite3');
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'web', 'library', 'data', 'store.db');

  console.log('[HumanModelAnalyzer] CLI mode');
  console.log('[HumanModelAnalyzer] Database:', dbPath);

  const db = new Database(dbPath);

  // Get model IDs from command line or analyze all
  const modelIds = process.argv.slice(2);

  analyzeAndUpdateModels(db, modelIds.length > 0 ? modelIds : null, (progress) => {
    if (progress.status === 'analyzing') {
      console.log(`[${progress.current}/${progress.total}] Analyzing ${progress.modelId}...`);
    } else if (progress.status === 'complete') {
      console.log(`[${progress.current}/${progress.total}] ✓ ${progress.modelId}`);
    } else if (progress.status === 'error') {
      console.log(`[${progress.current}/${progress.total}] ✗ ${progress.modelId}: ${progress.error}`);
    }
  }).then(result => {
    console.log('\n=== Analysis Complete ===');
    console.log(`Total: ${result.total}`);
    console.log(`Success: ${result.success}`);
    console.log(`Failed: ${result.failed}`);
    db.close();
    process.exit(0);
  }).catch(err => {
    console.error('Fatal error:', err);
    db.close();
    process.exit(1);
  });
}
