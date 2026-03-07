#!/usr/bin/env node
/**
 * Check which STL files referenced by product build plates are missing on disk.
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const db = require('../db');
db.initDatabase();
const d = db.getDb();

const plates = d.prepare('SELECT * FROM product_build_plates ORDER BY product_id, plate_index').all();
const seen = new Map(); // stl_catalog_id → { name, has_file, stl_path, needed_by }

for (const plate of plates) {
  const items = JSON.parse(plate.items || '[]');
  for (const item of items) {
    const id = item.stl_catalog_id;
    if (!id || seen.has(id)) {
      if (seen.has(id)) {
        seen.get(id).needed_by.add(plate.product_id);
        seen.get(id).total_qty += (item.qty || 0);
      }
      continue;
    }
    const cat = d.prepare('SELECT id, name, stl_path, mb_type, mu_width, mu_height FROM stl_catalog WHERE id = ?').get(id);
    if (!cat) {
      seen.set(id, { name: item.name, has_file: false, stl_path: null, reason: 'NOT IN CATALOG', needed_by: new Set([plate.product_id]), total_qty: item.qty || 0 });
      continue;
    }
    let hasFile = false;
    let resolvedPath = '';
    if (cat.stl_path) {
      const trimmed = cat.stl_path.trim();
      // Try absolute
      if (fs.existsSync(trimmed)) {
        hasFile = true;
        resolvedPath = trimmed;
      } else {
        // Try relative to data/stl-library
        const rel = path.join(__dirname, '..', '..', 'data', 'stl-library', trimmed);
        if (fs.existsSync(rel)) {
          hasFile = true;
          resolvedPath = rel;
        } else {
          // Try inside models/ subdirectory
          const relModels = path.join(__dirname, '..', '..', 'data', 'stl-library', 'models', trimmed);
          if (fs.existsSync(relModels)) {
            hasFile = true;
            resolvedPath = relModels;
          }
        }
      }
    }
    seen.set(id, {
      name: cat.name,
      mb_type: cat.mb_type,
      dims: `${cat.mu_width || '?'}x${cat.mu_height || '?'} MU`,
      has_file: hasFile,
      stl_path: cat.stl_path ? cat.stl_path.trim() : '(none)',
      resolved: resolvedPath,
      reason: hasFile ? 'OK' : (cat.stl_path ? 'FILE NOT FOUND' : 'NO PATH'),
      needed_by: new Set([plate.product_id]),
      total_qty: item.qty || 0
    });
  }
}

// Report
const missing = [];
const found = [];
for (const [id, info] of seen) {
  if (info.has_file) {
    found.push({ id, ...info, needed_by: [...info.needed_by] });
  } else {
    missing.push({ id, ...info, needed_by: [...info.needed_by] });
  }
}

console.log(`\n=== STL File Check for Product Build Plates ===`);
console.log(`Total unique parts: ${seen.size}`);
console.log(`Found on disk: ${found.length}`);
console.log(`MISSING: ${missing.length}\n`);

if (missing.length > 0) {
  console.log('--- MISSING STL FILES ---');
  for (const m of missing) {
    console.log(`  ID ${m.id} | ${m.name}`);
    console.log(`    Type: ${m.mb_type || '?'} | Dims: ${m.dims} | Qty needed: ${m.total_qty}`);
    console.log(`    Path: ${m.stl_path}`);
    console.log(`    Reason: ${m.reason}`);
    console.log(`    Needed by: ${m.needed_by.join(', ')}`);
    console.log('');
  }
}

if (found.length > 0) {
  console.log('--- FOUND (OK) ---');
  for (const f of found) {
    console.log(`  ID ${f.id} | ${f.name} | ${f.dims} | qty: ${f.total_qty} | ${f.needed_by.join(', ')}`);
  }
}
