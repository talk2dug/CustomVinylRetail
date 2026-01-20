/**
 * Update categories for human models that already have metadata
 * Generates category from: Gender-Apparel-Direction
 *
 * Usage: node scripts/update-human-model-categories.js [--dry-run]
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Load environment
const ENV_PATH = path.resolve(__dirname, '..', '..', '.env');
if (fs.existsSync(ENV_PATH)) {
  require('dotenv').config({ path: ENV_PATH });
}

const dbPath = process.env.DB_PATH || path.resolve(__dirname, '..', '..', 'web', 'library', 'data', 'store.db');
console.log('[UpdateCategories] Database:', dbPath);

const db = new Database(dbPath);

/**
 * Capitalize first letter, handle multi-word values like "three-quarter"
 */
function formatCategoryPart(str) {
  if (!str) return '';
  // Replace dashes with spaces and capitalize each word
  return str
    .split(/[-\s]+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Generate category from metadata
 */
function generateCategory(gender, apparelType, facing) {
  const parts = [
    formatCategoryPart(gender),
    formatCategoryPart(apparelType),
    formatCategoryPart(facing)
  ].filter(Boolean);

  return parts.length >= 2 ? parts.join('-') : null;
}

// Main
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

if (dryRun) {
  console.log('[UpdateCategories] DRY RUN - no changes will be made\n');
}

// Get models that have metadata but no category, or where category needs update
const models = db.prepare(`
  SELECT id, title, gender, apparel_type, facing, category
  FROM human_models
  WHERE active = 1
    AND (gender IS NOT NULL OR apparel_type IS NOT NULL OR facing IS NOT NULL)
`).all();

console.log(`[UpdateCategories] Found ${models.length} models with metadata\n`);

let updated = 0;
let skipped = 0;
const changes = [];

for (const model of models) {
  const newCategory = generateCategory(model.gender, model.apparel_type, model.facing);

  // Skip if category wouldn't change
  if (model.category === newCategory) {
    skipped++;
    continue;
  }

  changes.push({
    id: model.id,
    title: model.title,
    oldCategory: model.category,
    newCategory: newCategory,
    parts: { gender: model.gender, apparel: model.apparel_type, facing: model.facing }
  });

  if (!dryRun && newCategory) {
    db.prepare(`UPDATE human_models SET category = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(newCategory, model.id);
  }

  updated++;
}

// Show changes
if (changes.length > 0) {
  console.log('[UpdateCategories] Changes:');
  for (const change of changes.slice(0, 30)) {
    console.log(`  ${change.id} (${change.title || 'Untitled'}):`);
    console.log(`    Parts: gender=${change.parts.gender}, apparel=${change.parts.apparel}, facing=${change.parts.facing}`);
    console.log(`    OLD: "${change.oldCategory || '(none)'}"`);
    console.log(`    NEW: "${change.newCategory || '(none)'}"`);
  }
  if (changes.length > 30) {
    console.log(`  ... and ${changes.length - 30} more`);
  }
}

console.log(`\n[UpdateCategories] Complete!`);
console.log(`[UpdateCategories] Updated: ${updated}`);
console.log(`[UpdateCategories] Skipped (unchanged): ${skipped}`);

if (dryRun) {
  console.log('\n[UpdateCategories] This was a dry run. Run without --dry-run to apply changes.');
}

db.close();
