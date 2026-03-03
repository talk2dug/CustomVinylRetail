'use strict';
/**
 * seed-brcc-quotes.js
 *
 * Creates the 3 BRCC master catalog print quotes via the server REST API.
 * Run from the server directory:
 *   node seed-brcc-quotes.js [server-url]
 *
 * Defaults to http://localhost:4000. Override with first arg:
 *   node seed-brcc-quotes.js https://store.swayzecustomvinyl.com
 */

const https  = require('https');
const http   = require('http');
const SERVER  = process.argv[2] || 'http://localhost:4000';
const API_KEY = process.argv[3] || '';

// ── HTTP helper ───────────────────────────────────────────────────────────────

function apiRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const url     = new URL(path, SERVER);
    const mod     = url.protocol === 'https:' ? https : http;

    const options = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(API_KEY ? { 'x-api-key': API_KEY } : {}),
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    };

    const req = mod.request(options, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve(data); }
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Item builder ──────────────────────────────────────────────────────────────

function item(name, qty, material, priceCents, opts = {}) {
  return {
    name,
    qty,
    material,
    unit_price_cents: priceCents,
    stl_catalog_id:   opts.stl_catalog_id || null,
    part_id:          opts.part_id || null,
    missing_stl:      opts.missing_stl ? 1 : 0,
    search_hint:      opts.search_hint || null
  };
}

// ── Quote data ────────────────────────────────────────────────────────────────

const QUOTES = [
  {
    project_name:  'Home Vinyl Cutting Station',
    customer_name: 'BRC',
    service_level: 'local',
    notes: 'Workspace #1 — Black + Teal | Wall-mounted behind bench | 12×6 tile panel + desktop riser',
    items: [
      item('Multiboard 8×8 Tile',                    8,  'Black PLA',   600),
      item('DS Snap Offset Part A — 8mm',            24,  'Black PLA',    50, { part_id: 'ds-snap-a' }),
      item('DS Snap Part B — Regular',               24,  'Black PLA',    50, { part_id: 'ds-snap-b' }),
      item('T-Bolt 13mm Flat Head Small Thread',     40,  'Black PLA',    25, { part_id: 't-bolt' }),
      item('Multibin Shell — 3CU×2CU×1CU (Topped)',  1,  'Teal PETG',   500),
      item('Multibin Shell — 2CU×2CU×1CU (Topped)',  1,  'Teal PETG',   350),
      item('Multibin Shell — 2CU×2CU×1CU (Simple)',  1,  'Teal PETG',   350),
      item('Multibin Shell — 2CU×1CU×1CU (Simple)',  2,  'Teal PETG',   200),
      item('Multibin Shell — 1CU×2CU×1CU (Simple)',  1,  'Teal PETG',   175),
      item('Multibin Shell — 1CU×1CU×1CU (Simple)',  1,  'Teal PETG',   150),
      item('Multibin Divided Insert',                 2,  'Teal PETG',   150),
      item('Bolt-Locked Shelf 4×2',                  1,  'Teal PETG',   600),
      item('Bolt-Locked Shelf 4×1',                  1,  'Teal PETG',   400),
      item('Bolt-Locked Shelf 2×1',                  1,  'Teal PETG',   250),
      item('Shelf Support Bracket',                   2,  'Teal PETG',   150, { part_id: 'shelf-support-bracket' }),
      item('Pegboard Click Hook — 25mm',              4,  'Teal PETG',   100),
      item('Pegboard Click Hook — 50mm',              1,  'Teal PETG',   150),
      item('Bolt-Locked Hook — 25mm',                2,  'Teal PETG',   150),
      item('Peg — Bolt-Locked Insert — 25mm',        4,  'Teal PETG',    75),
      item('Regular Multipoint',                      8,  'Black PLA',    40, { part_id: 'multipoint-connector' }),
      item('Label Holder — Multibin Shell',           5,  'White PLA',    75),
      item('Universal Label Holder',                  1,  'Teal PETG',   100),
      item('Free-Standing Foot V-Long',               2,  'Black PETG',    0, {
        missing_stl: true,
        search_hint: 'Free-Standing Foot V-Long multiboard printables.com/model/1349884'
      })
    ]
  },
  {
    project_name:  'Show Vinyl Cutting Station',
    customer_name: 'BRC',
    service_level: 'local',
    notes: 'Workspace #2 — Black + Orange | 6ft wide, floor-standing, table-height mount | 9×5 tile array (45 tiles)',
    items: [
      item('Multiboard 8×8 Tile',                   45,  'Black PLA',   600),
      item('DS Snap Offset Part A — 8mm',            80,  'Black PLA',    50, { part_id: 'ds-snap-a' }),
      item('DS Snap Part B — Regular',               80,  'Black PLA',    50, { part_id: 'ds-snap-b' }),
      item('T-Bolt 13mm Flat Head Small Thread',     80,  'Black PLA',    25, { part_id: 't-bolt' }),
      item('Free-Standing Foot V-Long',               4,  'Black PETG',    0, {
        missing_stl: true,
        search_hint: 'Free-Standing Foot V-Long multiboard printables.com/model/1349884'
      }),
      item('X-Brace — Freestanding Base',            2,  'Black PETG',    0, {
        missing_stl: true,
        search_hint: 'X-Brace Freestanding Multiboard Tile printables.com/model/1231166'
      }),
      item('Bolt-Locked Shelf 8×2',                  1,  'Orange PETG', 1000),
      item('Shelf Support Bracket',                   4,  'Orange PETG',  150, { part_id: 'shelf-support-bracket' }),
      item('Multibin Shell — 4CU×2CU×1CU (Topped)',  1,  'Orange PETG',  600),
      item('Multibin Shell — 2CU×2CU×1CU (Simple)',  1,  'Orange PETG',  350),
      item('Multibin Shell — 2CU×1CU×1CU (Simple)',  1,  'Orange PETG',  200),
      item('Multibin Shell — 1CU×1CU×1CU (Simple)',  1,  'Orange PETG',  150),
      item('Multibin Shell — 4CU×1CU×1CU (Simple)',  1,  'Orange PETG',  300),
      item('Multibin Divided Insert',                 1,  'Orange PETG',  150),
      item('Pegboard Click Hook — 25mm',              4,  'Orange PETG',  100),
      item('Pegboard Click Hook — 50mm',              2,  'Orange PETG',  150),
      item('Bolt-Locked Hook — 25mm',                2,  'Orange PETG',  150),
      item('Peg — Bolt-Locked Insert — 100mm',       4,  'Black PETG',   125),
      item('Regular Multipoint',                     10,  'Black PLA',     40, { part_id: 'multipoint-connector' }),
      item('Universal Label Holder',                  2,  'Orange PETG',  100),
      item('Label Holder — Multibin Shell',           5,  'White PLA',     75)
    ]
  },
  {
    project_name:  'Kitchen Organizer Show Display',
    customer_name: 'BRC',
    service_level: 'local',
    notes: 'Workspace #3 — White + Sage Green | Door-mount + Freestanding | 2×4 tile (door) / 2×3 tile (freestanding)',
    items: [
      item('Multiboard 8×8 Tile',                    8,  'White PLA',   600),
      item('DS Snap Offset Part A — 6.25mm',          8,  'White PLA',    50, { part_id: 'ds-snap-a' }),
      item('DS Snap Part B — Regular',                8,  'White PLA',    50, { part_id: 'ds-snap-b' }),
      item('T-Bolt 13mm Flat Head Small Thread',     30,  'White PLA',    25, { part_id: 't-bolt' }),
      item('Free-Standing Foot V-Long',               2,  'Sage Green PETG',  0, {
        missing_stl: true,
        search_hint: 'Free-Standing Foot V-Long multiboard printables.com/model/1349884'
      }),
      item('X-Brace — Freestanding Base',            1,  'White PETG',    0, {
        missing_stl: true,
        search_hint: 'X-Brace Freestanding Multiboard Tile printables.com/model/1231166'
      }),
      item('Bolt-Locked Shelf 4×1',                  3,  'Sage Green PETG',  400),
      item('Shelf Support Bracket',                   4,  'Sage Green PETG',  150, { part_id: 'shelf-support-bracket' }),
      item('Peg — Bolt-Locked Insert — 25mm',        2,  'Sage Green PETG',   75),
      item('Multibin Shell — 1CU×1CU×1CU (Simple)',  3,  'Sage Green PETG',  150),
      item('Multibin Shell — 2CU×2CU×1CU (Topped)',  1,  'Sage Green PETG',  350),
      item('Multibin Shell — 4CU×1CU×1CU (Simple)',  1,  'Sage Green PETG',  300),
      item('Multibin Shell — 2CU×1CU×1CU (Simple)',  2,  'Sage Green PETG',  200),
      item('Multibin Divided Insert',                 2,  'Sage Green PETG',  150),
      item('Regular Multipoint',                      6,  'Sage Green PETG',   40, { part_id: 'multipoint-connector' }),
      item('Pegboard Click Hook — 25mm',              2,  'Sage Green PETG',  100),
      item('Pegboard Click Hook — 50mm',              1,  'Sage Green PETG',  150),
      item('Universal Label Holder',                  1,  'Sage Green PETG',  100),
      item('Label Holder — Multibin Shell',           4,  'White PLA',         75)
    ]
  }
];

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nSeeding BRCC master catalog quotes → ${SERVER}\n`);

  // Check existing quotes to avoid duplication
  let existingList = [];
  try {
    const listResp = await apiRequest('GET', '/api/quotes/?source=multiboard&limit=50');
    existingList = listResp.quotes || [];
  } catch (e) {
    // First time or server might not be running locally
    console.warn('Could not fetch existing quotes (server may not be running locally):', e.message);
  }

  for (const q of QUOTES) {
    // Delete existing with same project name + customer
    const existing = existingList.find(
      ex => ex.customer_name === q.customer_name && ex.project_name === q.project_name
    );
    if (existing) {
      try {
        await apiRequest('DELETE', `/api/quotes/${existing.id}`);
        console.log(`  ↺ Deleted existing quote #${existing.id}: ${q.project_name}`);
      } catch (e) {
        console.warn(`  ! Could not delete #${existing.id}:`, e.message);
      }
    }

    // Create quote with items inline
    const total = q.items.reduce((s, i) => s + (i.unit_price_cents * i.qty), 0);
    try {
      const result = await apiRequest('POST', '/api/quotes/', {
        source:        'multiboard',
        customer_name: q.customer_name,
        project_name:  q.project_name,
        service_level: q.service_level,
        status:        'draft',
        notes:         q.notes,
        total_cents:   total,
        items:         q.items
      });
      const created = result.quote;
      console.log(`  ✓ #${created.id} ${q.project_name}  (${q.items.length} items, $${(total / 100).toFixed(2)})`);
    } catch (err) {
      console.error(`  ✗ Failed to create "${q.project_name}":`, err.message);
    }
  }

  console.log('\nDone.\n');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
