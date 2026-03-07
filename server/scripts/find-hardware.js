#!/usr/bin/env node
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const db = require('../db');
db.initDatabase();
const d = db.getDb();

const searches = {
  'flush-snap': "name LIKE '%Flush Snap%' AND mb_type IS NOT NULL",
  'locking-bolt': "name LIKE '%Locking Bolt%' AND mb_type IS NOT NULL",
  'wall-mount': "(name LIKE '%Wall Mount%' OR name LIKE '%Screw On Mount%') AND mb_type IS NOT NULL",
  'bracket': "name LIKE '%Bracket%Bolt%' AND mb_type = 'bracket'",
  'heavy-hook-snap': "name LIKE '%Hook Snap%' AND mb_type IS NOT NULL",
  'shelf-support': "name LIKE '%Shelf%Support%' OR (name LIKE '%Shelf%Bracket%' AND mb_type IS NOT NULL)",
  'ds-snap': "name LIKE '%DS%Snap%'",
  'drawer-shell': "name LIKE '%Drawer Shell%' OR (name LIKE '%Shell%' AND mb_type = 'shell')",
  'moderate-snap': "name LIKE '%Moderate%Snap%' OR name LIKE '%Standard%Snap%'",
  'rail-popin': "name LIKE '%Rail%Pop%' OR name LIKE '%Pop%In%Rail%'",
  'stopper-pin': "name LIKE '%Stopper%' OR name LIKE '%Stop Pin%'",
  'multipoint-connector': "name LIKE '%Multipoint%' AND mb_type IS NOT NULL",
  'fasteners-all': "mb_type = 'fastener'",
  'snaps-all': "mb_type = 'snap'"
};

for (const [label, where] of Object.entries(searches)) {
  console.log(`\n=== ${label} ===`);
  try {
    const rows = d.prepare(`SELECT id, name, mb_type, mu_width, mu_height FROM stl_catalog WHERE ${where} ORDER BY name LIMIT 8`).all();
    if (!rows.length) console.log('  (none found)');
    rows.forEach(r => console.log(`  ${r.id} | ${r.mb_type} | ${r.mu_width||0}x${r.mu_height||0} | ${r.name}`));
  } catch (e) {
    console.log('  ERROR:', e.message);
  }
}
