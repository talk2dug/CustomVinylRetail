/**
 * Scrub and clean titles for assets (human models, artwork, rooms, etc.)
 * Detects AI-generated gibberish and replaces with clean sequential titles
 *
 * Usage: node scripts/scrub-titles.js [--table human_models|custom_art_artwork|custom_art_rooms] [--dry-run]
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
console.log('[Scrub] Database:', dbPath);

const db = new Database(dbPath);

// Patterns that indicate an AI-generated or junk title
const JUNK_PATTERNS = [
  /lucid\s*origin/i,
  /midjourney/i,
  /dall-?e/i,
  /stable\s*diffusion/i,
  /cinematic\s+photo/i,
  /stunning\s+and\s+vibrant/i,
  /a\s+photo\s+of/i,
  /a\s+portrait\s+of/i,
  /professional\s+photo/i,
  /threequarter\s+length/i,
  /three\s+quarter/i,
  /full\s+length\s+portrait/i,
  /[a-f0-9]{8}[-_\s][a-f0-9]{4}/i, // UUID fragments
  /\b[a-f0-9]{12,}\b/i, // Long hex strings
];

/**
 * Check if a title is AI-generated junk that needs replacement
 */
function isJunkTitle(title) {
  if (!title || title.trim().length < 3) return true;
  for (const pattern of JUNK_PATTERNS) {
    if (pattern.test(title)) return true;
  }
  return false;
}

/**
 * Scrub titles for a specific table
 */
function scrubTable(tableName, options = {}) {
  const { dryRun = false, prefix = 'Item' } = options;

  // Get column names for the table
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const hasTitle = columns.some(c => c.name === 'title');

  if (!hasTitle) {
    console.log(`[Scrub] Table ${tableName} has no 'title' column, skipping`);
    return { updated: 0, skipped: 0 };
  }

  // Get all rows ordered by created_at for consistent numbering
  const rows = db.prepare(`SELECT id, title FROM ${tableName} ORDER BY created_at ASC`).all();
  console.log(`[Scrub] Found ${rows.length} rows in ${tableName}`);

  let updated = 0;
  let skipped = 0;
  let counter = 1;
  const changes = [];

  for (const row of rows) {
    const originalTitle = row.title;

    // Skip if title is already clean
    if (!isJunkTitle(originalTitle)) {
      skipped++;
      counter++;
      continue;
    }

    // Generate clean numbered title
    const newTitle = `${prefix} ${String(counter).padStart(3, '0')}`;

    changes.push({
      id: row.id,
      oldTitle: originalTitle,
      newTitle: newTitle
    });

    if (!dryRun) {
      db.prepare(`UPDATE ${tableName} SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(newTitle, row.id);
    }

    updated++;
    counter++;
  }

  // Show changes
  if (changes.length > 0) {
    console.log(`\n[Scrub] Changes for ${tableName}:`);
    for (const change of changes.slice(0, 20)) {
      console.log(`  ${change.id}:`);
      console.log(`    OLD: "${change.oldTitle?.substring(0, 60)}${change.oldTitle?.length > 60 ? '...' : ''}"`);
      console.log(`    NEW: "${change.newTitle}"`);
    }
    if (changes.length > 20) {
      console.log(`  ... and ${changes.length - 20} more`);
    }
  }

  return { updated, skipped };
}

// Main
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const tableArg = args.find(a => !a.startsWith('--'));

if (dryRun) {
  console.log('[Scrub] DRY RUN - no changes will be made\n');
}

const tables = tableArg ? [tableArg] : ['human_models', 'custom_art_artwork', 'custom_art_rooms'];

const prefixes = {
  'human_models': 'Model',
  'custom_art_artwork': 'Artwork',
  'custom_art_rooms': 'Room'
};

let totalUpdated = 0;
let totalSkipped = 0;

for (const table of tables) {
  console.log(`\n[Scrub] Processing ${table}...`);
  try {
    const result = scrubTable(table, { dryRun, prefix: prefixes[table] || 'Item' });
    totalUpdated += result.updated;
    totalSkipped += result.skipped;
    console.log(`[Scrub] ${table}: ${result.updated} updated, ${result.skipped} unchanged`);
  } catch (e) {
    console.error(`[Scrub] Error processing ${table}:`, e.message);
  }
}

console.log(`\n[Scrub] Complete!`);
console.log(`[Scrub] Total: ${totalUpdated} updated, ${totalSkipped} unchanged`);

if (dryRun) {
  console.log('\n[Scrub] This was a dry run. Run without --dry-run to apply changes.');
}

db.close();
