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

const ANALYSIS_PROMPT = `You are a creative director at a custom apparel company. You're evaluating model photos to decide which product designs they should wear in marketing materials.

Look at this model photo and build a complete profile. Think about WHO this person represents to a buyer — what audience would see themselves in this model?

Analyze and return:

1. **gender**: male or female
2. **ethnicity**: caucasian, black, asian, hispanic, middle-eastern, south-asian, mixed, or other
3. **apparel_type**: What upper-body garment are they wearing? (t-shirt, hoodie, tank-top, long-sleeve, polo, crewneck, v-neck, sweatshirt, jacket, dress, hat, beanie, or other)
4. **facing**: front, back, side-left, side-right, three-quarter-left, three-quarter-right
5. **pose**: Describe the pose briefly
6. **style**: The model's overall aesthetic/vibe. Pick ONE:
   - pinup-retro (vintage glamour, tattoos, rockabilly, bold makeup, retro hair)
   - edgy-urban (streetwear, dark colors, attitude, graffiti/brick backgrounds)
   - outdoor-active (nature settings, athletic, adventure vibes)
   - casual-everyday (relatable, everyday person, suburban, approachable)
   - preppy-clean (polished, bright colors, put-together)
   - bohemian-artsy (creative, eclectic, colorful, artistic)
   - skater-youth (skateparks, sneakers, oversized fits, young energy)
   - fitness-athletic (gym, sports, muscular, activewear)
   - professional-minimal (clean backgrounds, studio lighting, commercial)
   - country-southern (rural, western, americana vibes)
7. **demographic**: Who does this model represent as a customer? Pick ONE:
   - gen-z-trendy (teens/early 20s, social media native)
   - young-adult (20s-30s, lifestyle focused)
   - millennial-parent (30s-40s, family/work balance)
   - blue-collar (working class, trades, hands-on)
   - creative-artist (musicians, artists, makers)
   - outdoor-enthusiast (hikers, campers, adventure seekers)
   - biker-gearhead (motorcycle/car culture)
   - faith-community (church, spiritual, family values)
   - everyday-mom (relatable mother, busy life, humor)
   - everyday-dad (relatable father, dad jokes, weekend warrior)
   - alt-subculture (tattoo culture, punk, goth, alternative)
   - fitness-focused (gym rats, athletes, health conscious)
8. **setting**: Where was the photo taken? Pick ONE:
   - studio, outdoor-nature, urban-street, cafe-restaurant, beach-coastal, suburban, industrial, skatepark, gym, home, retail-store, alley-gritty, park, rural
9. **garment_color**: What color is the main garment? (white, black, gray, navy, cream, red, blue, green, pink, etc.)
10. **age_range**: Approximate age (teens, early-20s, mid-20s, late-20s, early-30s, mid-30s, 40s, 50s+)
11. **sells_best_with**: What TYPES of graphic designs would look best on this model? List 2-3:
   - vintage-pinup, retro-americana, sarcastic-humor, skull-dark, nature-outdoor, faith-scripture, motorcycle-garage, abstract-art, pop-culture, animal-nature, music-band, sports, political, cute-kawaii, typography-quote, military-patriotic

If there are multiple people, profile the PRIMARY subject (most centered/prominent).

Respond ONLY with valid JSON matching this structure exactly.`;

const validGenders = ['male', 'female'];
const validEthnicities = ['caucasian', 'black', 'asian', 'hispanic', 'middle-eastern', 'south-asian', 'mixed', 'other'];
const validApparelTypes = ['t-shirt', 'hoodie', 'tank-top', 'long-sleeve', 'polo', 'crewneck', 'v-neck', 'sweatshirt', 'jacket', 'dress', 'hat', 'beanie', 'other'];
const validFacings = ['front', 'back', 'side-left', 'side-right', 'three-quarter-left', 'three-quarter-right'];
const validStyles = ['pinup-retro', 'edgy-urban', 'outdoor-active', 'casual-everyday', 'preppy-clean', 'bohemian-artsy', 'skater-youth', 'fitness-athletic', 'professional-minimal', 'country-southern'];
const validDemographics = ['gen-z-trendy', 'young-adult', 'millennial-parent', 'blue-collar', 'creative-artist', 'outdoor-enthusiast', 'biker-gearhead', 'faith-community', 'everyday-mom', 'everyday-dad', 'alt-subculture', 'fitness-focused'];
const validSettings = ['studio', 'outdoor-nature', 'urban-street', 'cafe-restaurant', 'beach-coastal', 'suburban', 'industrial', 'skatepark', 'gym', 'home', 'retail-store', 'alley-gritty', 'park', 'rural'];

function parseAnalysisResponse(responseText) {
  let jsonStr = responseText.trim();
  if (jsonStr.includes('```')) {
    const match = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (match) jsonStr = match[1].trim();
  }
  if (!jsonStr.startsWith('{')) {
    const braceMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (braceMatch) jsonStr = braceMatch[0];
  }
  const m = JSON.parse(jsonStr);

  // Normalize sells_best_with to always be an array
  let sellsBestWith = m.sells_best_with;
  if (typeof sellsBestWith === 'string') sellsBestWith = sellsBestWith.split(',').map(s => s.trim());
  if (!Array.isArray(sellsBestWith)) sellsBestWith = [];

  return {
    gender: validGenders.includes(m.gender?.toLowerCase()) ? m.gender.toLowerCase() : null,
    ethnicity: validEthnicities.includes(m.ethnicity?.toLowerCase()) ? m.ethnicity.toLowerCase() : null,
    apparel_type: validApparelTypes.includes(m.apparel_type?.toLowerCase()) ? m.apparel_type.toLowerCase() : null,
    facing: validFacings.includes(m.facing?.toLowerCase()) ? m.facing.toLowerCase() : 'front',
    pose: m.pose || null,
    style: validStyles.includes(m.style?.toLowerCase()) ? m.style.toLowerCase() : null,
    demographic: validDemographics.includes(m.demographic?.toLowerCase()) ? m.demographic.toLowerCase() : null,
    setting: validSettings.includes(m.setting?.toLowerCase()) ? m.setting.toLowerCase() : null,
    garment_color: m.garment_color?.toLowerCase() || null,
    age_range: m.age_range || null,
    sells_best_with: sellsBestWith.slice(0, 5),
    confidence: typeof m.confidence === 'number' ? m.confidence : 0.8
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
