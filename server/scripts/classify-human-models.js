#!/usr/bin/env node
/**
 * Classify Human Models
 * Uses Ollama (llava vision model) via GPU bridge to analyze each model image
 * and determine gender, ethnicity, pose, facing, and apparel type.
 * Updates the human_models DB table with results.
 *
 * Usage: node scripts/classify-human-models.js [--dry-run] [--limit N] [--only-unclassified]
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const Database = require('better-sqlite3');

// Load .env
const envPath = path.resolve(__dirname, '..', '..', '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
}

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const LIBRARY_ROOT = process.env.LIBRARY_ROOT || path.join(__dirname, '..', '..', 'web', 'library');

// Ollama GPU bridge config
const OLLAMA_HOST = process.env.GPU_BRIDGE_HOST || process.env.OLLAMA_HOST || '127.0.0.1';
const OLLAMA_PORT = parseInt(process.env.GPU_BRIDGE_PORT || process.env.OLLAMA_PORT || '11434', 10);
const VISION_MODEL = 'llava:13b';

// Parse args
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const ONLY_UNCLASSIFIED = args.includes('--only-unclassified');
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : 0;

function ollamaChat(messages, options = {}) {
  const timeout = options.timeout || 120000;
  const payload = {
    model: VISION_MODEL,
    messages,
    stream: false,
    options: { temperature: 0.1 }
  };

  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      hostname: OLLAMA_HOST,
      port: OLLAMA_PORT,
      path: '/api/chat',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.message?.content || '');
        } catch (e) {
          reject(new Error(`Failed to parse Ollama response: ${e.message}\nRaw: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Ollama request timeout')); });
    req.write(body);
    req.end();
  });
}

async function classifyImage(imagePath) {
  const buffer = fs.readFileSync(imagePath);
  const base64 = buffer.toString('base64');

  const prompt = `Analyze this photo of a person modeling clothing. Respond with ONLY a valid JSON object, no other text:

{"gender":"male or female","ethnicity":"white or black or hispanic or asian or middle-eastern or south-asian or mixed","pose_type":"standing or sitting or walking or leaning or arms-crossed or hands-on-hips or casual","facing":"front or back or three-quarter-left or three-quarter-right or side-left or side-right","apparel_type":"t-shirt or hoodie or tank-top or long-sleeve or polo or dress or jacket or other"}

Pick exactly one value for each field. Determine gender and ethnicity from visible features. If the person's back is toward the camera, facing is "back".`;

  const response = await ollamaChat([
    {
      role: 'user',
      content: prompt,
      images: [base64]
    }
  ]);

  // Extract JSON from response
  const text = response.trim();
  // Try to find JSON in the response
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`No JSON found in response: ${text.slice(0, 200)}`);
  }
  return JSON.parse(jsonMatch[0]);
}

function resolveModelImagePath(model) {
  // Prefer thumbnail (smaller, faster to process), then optimized, then full
  let imagePath = model.thumbnail_path || model.optimized_path || model.file_path;
  if (!imagePath) return null;

  if (!path.isAbsolute(imagePath) || imagePath.startsWith('/library/')) {
    const relPath = imagePath.replace(/^\/library\//, '').replace(/^library\//, '');
    imagePath = path.join(LIBRARY_ROOT, relPath);
  }

  return fs.existsSync(imagePath) ? imagePath : null;
}

// Valid values for validation
const VALID = {
  gender: ['male', 'female'],
  ethnicity: ['white', 'black', 'hispanic', 'asian', 'middle-eastern', 'south-asian', 'mixed', 'other'],
  pose_type: ['standing', 'sitting', 'walking', 'leaning', 'arms-crossed', 'hands-on-hips', 'casual'],
  facing: ['front', 'back', 'three-quarter-left', 'three-quarter-right', 'side-left', 'side-right'],
  apparel_type: ['t-shirt', 'hoodie', 'tank-top', 'long-sleeve', 'polo', 'dress', 'jacket', 'other']
};

function sanitize(classification) {
  const result = {};
  for (const [key, validValues] of Object.entries(VALID)) {
    const val = (classification[key] || '').toLowerCase().trim();
    result[key] = validValues.includes(val) ? val : validValues[0];
  }
  return result;
}

async function main() {
  const dbPath = path.join(DATA_DIR, 'store.db');
  console.log(`DB: ${dbPath}`);
  console.log(`Library: ${LIBRARY_ROOT}`);
  console.log(`Ollama: ${OLLAMA_HOST}:${OLLAMA_PORT} (${VISION_MODEL})`);
  console.log(`Dry run: ${DRY_RUN}\n`);

  const db = new Database(dbPath);

  let query = 'SELECT * FROM human_models WHERE active = 1';
  if (ONLY_UNCLASSIFIED) {
    query += " AND (gender IS NULL OR gender = '' OR gender = 'unknown')";
  }
  query += ' ORDER BY id';
  if (LIMIT > 0) query += ` LIMIT ${LIMIT}`;

  const models = db.prepare(query).all();
  console.log(`Found ${models.length} models to classify\n`);

  const updateStmt = db.prepare(`
    UPDATE human_models
    SET gender = @gender, ethnicity = @ethnicity, pose_type = @pose_type,
        facing = @facing, apparel_type = @apparel_type, updated_at = datetime('now')
    WHERE id = @id
  `);

  let success = 0;
  let failed = 0;

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const imagePath = resolveModelImagePath(model);

    if (!imagePath) {
      console.log(`[${i + 1}/${models.length}] SKIP ${model.id} — no image found`);
      failed++;
      continue;
    }

    try {
      process.stdout.write(`[${i + 1}/${models.length}] ${model.id}... `);
      const raw = await classifyImage(imagePath);
      const classification = sanitize(raw);

      console.log(`${classification.gender} | ${classification.ethnicity} | ${classification.pose_type} | ${classification.facing} | ${classification.apparel_type}`);

      if (!DRY_RUN) {
        updateStmt.run({
          id: model.id,
          ...classification
        });
      }

      success++;
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      failed++;
    }

    // Small delay between requests to not overwhelm
    if (i < models.length - 1) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  db.close();
  console.log(`\nDone. Success: ${success}, Failed: ${failed}`);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
