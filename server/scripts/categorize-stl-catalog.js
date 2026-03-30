#!/usr/bin/env node
/**
 * Auto-categorization migration script for stl_catalog.
 * Consolidates messy category/folder names into clean, browsable structure.
 *
 * Usage:
 *   node scripts/categorize-stl-catalog.js --dry-run   # Preview changes
 *   node scripts/categorize-stl-catalog.js              # Apply changes
 */

const path = require('path');
const Database = require('better-sqlite3');

// Match the DATA_DIR used by db.js — project root /data/ not /server/data/
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'store.db');
const db = new Database(DB_PATH);

const DRY_RUN = process.argv.includes('--dry-run');

// ============================================================================
// CATEGORY RULES
// Each rule: { target: 'Clean Category', folder: 'optional subfolder',
//              patterns: [regex or string matched against category OR item name] }
// Rules are checked in order — first match wins.
// ============================================================================

const CATEGORY_RULES = [
  // ── Multiboard (keep as-is, already has its own auto-classification) ──
  { target: 'Multiboard', patterns: [/^multiboard$/i, /^MultiBinShit$/i] },

  // ── Book Nooks ──
  { target: 'Book Nooks', patterns: [/book\s*nook/i, /book\s*box/i] },

  // ── Cookie Cutters ──
  { target: 'Cookie Cutters', patterns: [/cookie\s*cutter/i] },

  // ── Vases & Planters ──
  { target: 'Vases & Planters', patterns: [/vase/i, /planter/i, /flower\s*pot/i, /^AI Robert Planters$/i] },

  // ── Lamps & Lighting ──
  { target: 'Lamps & Lighting', patterns: [
    /lamp/i, /light/i, /led/i, /lantern/i, /voidlamp/i, /diffuser/i,
    /veilleuse/i, /lampara/i, /lampe/i, /litho.*lamp/i
  ]},

  // ── Keychains ──
  { target: 'Keychains', patterns: [
    /keychain/i, /key\s*chain/i, /key\s*ring/i, /key\s*fob/i, /llavero/i,
    /key\s*holder/i, /keychaing/i, /colgante/i, /porte\s*cle/i
  ]},

  // ── Dog Tags ──
  { target: 'Dog Tags', patterns: [/dog\s*tag/i, /dogtag/i, /dog\s*collar/i] },

  // ── Medals & Trophies ──
  { target: 'Medals', patterns: [/medal/i] },

  // ── Organizers & Storage ──
  { target: 'Organizers & Storage', patterns: [
    /^organizer/i, /storage\s*box/i, /dumpster/i, /container/i,
    /basket/i, /^tcpiii/i, /shipping\s*container/i
  ]},

  // ── Frames & Wall Art ──
  { target: 'Wall Art & Frames', patterns: [/frame/i, /wall\s*decor/i, /wall\s*art/i, /^HP\s+Wall/i] },

  // ── Figurines & Characters ──
  { target: 'Figurines', patterns: [
    /dragon/i, /baby\s*groot/i, /mandalorian/i, /baby\s*yoda/i, /goku/i,
    /pokemon/i, /mario/i, /venom/i, /batman/i, /superman/i, /deadpool/i,
    /stormtrooper/i, /star\s*wars/i, /marvel/i, /avenger/i, /snoopy/i,
    /bart/i, /ren.*stimpy/i, /among\s*us/i, /pac\s*man/i, /transformers/i,
    /godzilla/i, /ahsoka/i, /dali/i, /rick\s*and\s*morty/i, /minion/i,
    /spiderman/i, /groot/i, /stitch/i, /monkey/i, /emoji/i, /marshmello/i,
    /bulldog/i, /chihuahua/i, /chiwawa/i, /rottweiler/i, /dachshund/i,
    /unicorn/i, /cat\s*skeleton/i, /pig\s*keychain/i, /cow\s*keychain/i
  ]},

  // ── Mechanical & Gadgets ──
  { target: 'Mechanical & Gadgets', patterns: [
    /gear/i, /mechanical/i, /articul/i, /gadget/i, /turbine/i,
    /print\s*in\s*place/i, /flexi/i, /nozzle/i, /race\s*track/i,
    /garden.*sprinkler/i, /motorcycle/i, /bike/i
  ]},

  // ── Home & Decor ──
  { target: 'Home & Decor', patterns: [
    /^HP\s+Home/i, /^HP\s+Build/i, /shelf/i, /shelves/i, /display/i,
    /furniture/i, /decor/i, /sapin/i, /beehive/i, /mushroom/i,
    /origami/i, /geometric.*heart/i, /crystal.*cluster/i,
    /pineapple/i, /sunflower/i
  ]},

  // ── 3D Printer Parts ──
  { target: '3D Printer Parts', patterns: [
    /reprap/i, /camera\s*mount/i, /kobra/i, /cable\s*chain/i,
    /clamp\s*base/i, /nozzle/i, /^Config\s/i, /^Fit\s*Test/i,
    /print.*mount/i, /^LBLUC/i
  ]},

  // ── Steampunk ──
  { target: 'Steampunk', patterns: [/steampunk/i] },

  // ── RC & Engineering ──
  { target: 'RC & Engineering', patterns: [/^RC/i, /^RC.*Engineering/i, /fpv/i] },

  // ── Holiday & Seasonal ──
  { target: 'Holiday & Seasonal', patterns: [
    /christmas/i, /halloween/i, /santa/i, /holiday/i, /winter/i
  ]},

  // ── Stickers & Labels ──
  { target: 'Stickers & Labels', patterns: [/sticker/i, /label/i] },

  // ── Multicolor Prints ──
  { target: 'Multicolor Prints', patterns: [/^multicolor$/i, /^monocolor$/i] },
];

// Categories that are clearly junk / generic names → Uncategorized
const JUNK_PATTERNS = [
  /^files?$/i, /^files?\s*\(\d+\)$/i, /^images$/i, /^STL$/i, /^STL[\s-]*Files$/i,
  /^Downloads?$/i, /^Archive$/i, /^Base$/i, /^Original$/i, /^3D.*文件$/i,
  /^3d\s*print\s*files?$/i, /^HP\s+/i
];

// ============================================================================
// SUBFOLDER RULES
// After assigning category, try to extract a subfolder from the original
// category name or item name.
// ============================================================================

function extractSubfolder(item, newCategory, oldCategory) {
  // Book Nooks: use the theme as subfolder
  if (newCategory === 'Book Nooks') {
    const m = (oldCategory || item.name || '').match(/^(.+?)\s*book\s*nook/i);
    if (m) {
      const theme = m[1].replace(/model\s*files?$/i, '').replace(/[_-]+/g, ' ').trim();
      if (theme && theme.length > 1) return theme;
    }
  }

  // Lamps: extract lamp type/name as subfolder
  if (newCategory === 'Lamps & Lighting') {
    // Clean up the old category name as a subfolder
    let sub = (oldCategory || '').replace(/\s*STL\s*Files?\s*/gi, '').replace(/\s*@\w+/g, '').trim();
    sub = sub.replace(/[_+]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (sub && sub.length > 2 && sub.toLowerCase() !== 'lamps' && !JUNK_PATTERNS.some(p => p.test(sub))) {
      return sub;
    }
  }

  // Keychains: try to extract theme
  if (newCategory === 'Keychains') {
    let sub = (oldCategory || '').replace(/keychains?/gi, '').replace(/llaveros?/gi, '')
      .replace(/[_+]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (sub && sub.length > 2 && !JUNK_PATTERNS.some(p => p.test(sub))) {
      return sub;
    }
  }

  return null;
}

// ============================================================================
// MAIN MIGRATION
// ============================================================================

function categorizeItem(item) {
  const cat = (item.category || '').trim();
  const name = (item.name || '').trim();

  // Skip items already in Multiboard (has its own system)
  if (cat === 'Multiboard') return null;

  // Try matching category name first, then item name
  for (const rule of CATEGORY_RULES) {
    for (const pattern of rule.patterns) {
      const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i');
      if (regex.test(cat) || regex.test(name)) {
        if (rule.target === cat && !rule.folder) return null; // already correct
        const folder = rule.folder || extractSubfolder(item, rule.target, cat);
        return { category: rule.target, folder };
      }
    }
  }

  // Check if it's a junk category
  if (JUNK_PATTERNS.some(p => p.test(cat))) {
    return { category: 'Uncategorized', folder: null };
  }

  // If the category has very few items (1-2) and looks like a filename, uncategorize it
  // This is handled by the caller via count check

  return null; // no change
}

function run() {
  console.log(`\n${DRY_RUN ? '=== DRY RUN ===' : '=== APPLYING CHANGES ==='}\n`);

  const allItems = db.prepare('SELECT * FROM stl_catalog').all();
  console.log(`Total items in catalog: ${allItems.length}`);

  // Get category counts for the small-category cleanup
  const catCounts = {};
  for (const item of allItems) {
    const cat = (item.category || '').trim();
    catCounts[cat] = (catCounts[cat] || 0) + 1;
  }

  const changes = [];
  const stats = { total: 0, skipped: 0, byCategory: {} };

  for (const item of allItems) {
    let result = categorizeItem(item);

    // If no rule matched and it's a tiny category (<=3 items) with a generic/messy name, uncategorize
    if (!result) {
      const cat = (item.category || '').trim();
      if (cat && catCounts[cat] <= 3) {
        // Check if the category name looks like a filename or download artifact
        if (/\d{8}|snapshot|20\d{2}|model.files|files?\s*\(/i.test(cat)) {
          result = { category: 'Uncategorized', folder: null };
        }
      }
    }

    if (result) {
      const oldCat = item.category || '(none)';
      const newCat = result.category;
      const newFolder = result.folder || null;

      // Skip if nothing actually changes
      if (newCat === oldCat && newFolder === item.folder) {
        stats.skipped++;
        continue;
      }

      changes.push({
        id: item.id,
        name: item.name,
        oldCategory: oldCat,
        newCategory: newCat,
        oldFolder: item.folder,
        newFolder: newFolder
      });

      stats.byCategory[newCat] = (stats.byCategory[newCat] || 0) + 1;
      stats.total++;
    }
  }

  // Print summary
  console.log(`\nItems to recategorize: ${stats.total}`);
  console.log(`Items skipped (already correct): ${stats.skipped}`);
  console.log('\nCategory breakdown:');
  const sorted = Object.entries(stats.byCategory).sort((a, b) => b[1] - a[1]);
  for (const [cat, count] of sorted) {
    console.log(`  ${cat}: ${count} items`);
  }

  // Print sample changes
  console.log('\nSample changes (first 30):');
  for (const c of changes.slice(0, 30)) {
    const folderStr = c.newFolder ? ` → folder: "${c.newFolder}"` : '';
    console.log(`  [${c.id}] "${c.name}": "${c.oldCategory}" → "${c.newCategory}"${folderStr}`);
  }

  if (DRY_RUN) {
    console.log(`\n=== DRY RUN COMPLETE — no changes applied ===`);
    console.log(`Run without --dry-run to apply ${stats.total} changes.\n`);
    process.exit(0);
  }

  // Apply changes in a transaction
  const updateCat = db.prepare('UPDATE stl_catalog SET category = ? WHERE id = ?');
  const updateFolder = db.prepare('UPDATE stl_catalog SET folder = ? WHERE id = ?');
  const updateBoth = db.prepare('UPDATE stl_catalog SET category = ?, folder = ? WHERE id = ?');

  const applyAll = db.transaction(() => {
    for (const c of changes) {
      if (c.newFolder) {
        updateBoth.run(c.newCategory, c.newFolder, c.id);
      } else {
        updateCat.run(c.newCategory, c.id);
      }
    }
  });

  applyAll();
  console.log(`\n✓ Applied ${stats.total} changes successfully.\n`);

  // Print final category counts
  const finalCounts = db.prepare(
    `SELECT category, COUNT(*) as cnt FROM stl_catalog
     WHERE category IS NOT NULL GROUP BY category ORDER BY cnt DESC`
  ).all();
  console.log('Final category counts:');
  for (const row of finalCounts) {
    console.log(`  ${row.category}: ${row.cnt}`);
  }
}

run();
