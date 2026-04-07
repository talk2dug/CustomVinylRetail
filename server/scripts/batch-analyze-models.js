#!/usr/bin/env node
/**
 * Batch analyze human models — runs AI metadata on all unanalyzed models,
 * then deactivates any model whose garment has graphics/logos/text.
 *
 * Usage: node server/scripts/batch-analyze-models.js [--all] [--dry-run]
 *   --all      Re-analyze ALL models, not just unanalyzed ones
 *   --dry-run  Show what would be deactivated without doing it
 */

const path = require('path');
const fs = require('fs');
const PATHS = require('../paths');

// Load env
require('dotenv').config({ path: path.join(PATHS.APP_ROOT, '.env') });

const { analyzeHumanModel } = require('../human-model-analyzer');
const Database = require('better-sqlite3');
const DB_PATH = path.join(PATHS.APP_ROOT, 'data', 'store.db');
const db = new Database(DB_PATH);

const args = process.argv.slice(2);
const ANALYZE_ALL = args.includes('--all');
const DRY_RUN = args.includes('--dry-run');

// Resolve /library/... paths to filesystem
function resolveModelPath(filePath) {
  if (!filePath) return null;
  for (const { prefix, localRoot } of PATHS.URL_MAPPINGS) {
    if (filePath.startsWith(prefix)) {
      return path.join(localRoot, filePath.slice(prefix.length));
    }
  }
  return filePath;
}

async function run() {
  // Get models to analyze
  let models;
  if (ANALYZE_ALL) {
    models = db.prepare('SELECT * FROM human_models WHERE active = 1 ORDER BY created_at DESC').all();
  } else {
    // Unanalyzed = no style set (style is only set by the analyzer)
    models = db.prepare("SELECT * FROM human_models WHERE active = 1 AND (style IS NULL OR style = '') ORDER BY created_at DESC").all();
  }

  console.log(`Found ${models.length} models to analyze${ANALYZE_ALL ? ' (--all)' : ' (unanalyzed only)'}`);
  if (DRY_RUN) console.log('DRY RUN — no changes will be made');

  let analyzed = 0, deactivated = 0, errors = 0;

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const imagePath = resolveModelPath(model.file_path);

    if (!imagePath || !fs.existsSync(imagePath)) {
      console.log(`[${i + 1}/${models.length}] SKIP ${model.id} — file not found: ${imagePath}`);
      errors++;
      continue;
    }

    try {
      console.log(`[${i + 1}/${models.length}] Analyzing ${model.id} (${path.basename(imagePath)})...`);
      const metadata = await analyzeHumanModel(imagePath);

      // Build category
      const capitalize = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '';
      const categoryParts = [
        capitalize(metadata.gender),
        capitalize(metadata.apparel_type?.replace(/-/g, ' ')),
        capitalize(metadata.facing?.replace(/-/g, ' '))
      ].filter(Boolean);
      const category = categoryParts.length >= 2 ? categoryParts.join('-') : null;

      if (!DRY_RUN) {
        // Update metadata
        db.prepare(`UPDATE human_models SET
          gender = ?, ethnicity = ?, apparel_type = ?, facing = ?,
          pose_type = ?, category = ?, style = ?, demographic = ?,
          setting = ?, garment_color = ?, age_range = ?, sells_best_with = ?,
          updated_at = datetime('now')
          WHERE id = ?`).run(
          metadata.gender, metadata.ethnicity, metadata.apparel_type, metadata.facing,
          metadata.pose, category, metadata.style, metadata.demographic,
          metadata.setting, metadata.garment_color, metadata.age_range,
          Array.isArray(metadata.sells_best_with) ? metadata.sells_best_with.join(',') : (metadata.sells_best_with || ''),
          model.id
        );
      }

      analyzed++;

      // Check for graphics on garment
      const hasGraphics = metadata.has_graphics === true || metadata.has_graphics === 'true';
      if (hasGraphics) {
        console.log(`  → HAS GRAPHICS — deactivating (${metadata.apparel_type}, ${metadata.garment_color})`);
        if (!DRY_RUN) {
          db.prepare('UPDATE human_models SET active = 0, status = ? WHERE id = ?').run('graphics-on-garment', model.id);
        }
        deactivated++;
      } else {
        console.log(`  → OK: ${metadata.gender}, ${metadata.apparel_type}, ${metadata.style}, ${metadata.garment_color}`);
      }

      // Rate limit — Gemini has quota limits
      if (i < models.length - 1) {
        await new Promise(r => setTimeout(r, 1500));
      }
    } catch (err) {
      console.error(`  → ERROR: ${err.message}`);
      errors++;
    }
  }

  console.log('\n=== DONE ===');
  console.log(`Analyzed: ${analyzed}`);
  console.log(`Deactivated (has graphics): ${deactivated}`);
  console.log(`Errors/skipped: ${errors}`);
  console.log(`Total active models: ${db.prepare('SELECT COUNT(*) as c FROM human_models WHERE active=1').get().c}`);

  db.close();
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
