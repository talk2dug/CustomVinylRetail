#!/usr/bin/env node
/**
 * sync-thangs-catalog.js — Discover Multiboard parts on Thangs and match against local catalog.
 *
 * Two modes:
 *   --crawl        Crawl Thangs search API (must run from local machine — Cloudflare blocks datacenter IPs)
 *                  Output: --crawl --output thangs-data.json
 *   --import FILE  Import previously crawled JSON into DB and match against stl_catalog
 *   (no args)      Re-match existing data in DB
 */
const path = require('path');
const fs = require('fs');
const https = require('https');

// ── Config ──
const THANGS_OWNERS = new Set(['multiboard', 'multibuild', 'keep making']);
const PAGE_SIZE = 50;
const MAX_PAGES = 200;
const DELAY_MS = 500;

// ── HTTP helper — uses curl to bypass Cloudflare TLS fingerprinting ──
function fetchJSON(url) {
  const { execSync } = require('child_process');
  return new Promise((resolve, reject) => {
    try {
      const result = execSync(
        `curl -s "${url}" -H "Accept: application/json" -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" -H "Origin: https://thangs.com" -H "Referer: https://thangs.com/"`,
        { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
      ).toString();
      // Check for rate limit (HTML response)
      if (result.includes('Rate limit')) return reject(new Error('RATE_LIMITED'));
      resolve(JSON.parse(result));
    } catch (e) {
      if (e.message && e.message.includes('JSON')) {
        reject(new Error('Invalid JSON (likely Cloudflare challenge)'));
      } else {
        reject(e);
      }
    }
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function normalizeName(name) {
  return (name || '')
    .replace(/\.stl$/i, '')
    .replace(/[_\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// ── Phase 1: Crawl Thangs API (runs locally, not on server) ──
async function crawlThangs(outputFile) {
  const searchTerms = ['multiboard', 'multibin', 'multigrid'];
  const allModels = new Map();

  console.log('=== Crawling Thangs API ===');

  for (const term of searchTerms) {
    console.log(`\nSearching for "${term}"...`);
    let page = 0;
    let consecutiveEmpty = 0;

    while (page < MAX_PAGES) {
      const url = `https://thangs.com/api/models/v3/search-by-text?searchTerm=${encodeURIComponent(term)}&scope=thangs&pageSize=${PAGE_SIZE}&page=${page}&collapse=true&freeModels=true`;

      try {
        const data = await fetchJSON(url);
        const results = data.results || [];

        if (!Array.isArray(results) || results.length === 0) {
          consecutiveEmpty++;
          if (consecutiveEmpty >= 2) break;
          page++;
          await sleep(DELAY_MS);
          continue;
        }

        consecutiveEmpty = 0;
        let pageOwnerCount = 0;

        for (const model of results) {
          const owner = (model.ownerUsername || '').toLowerCase();
          if (!THANGS_OWNERS.has(owner)) continue;

          const modelId = String(model.modelId || model.id);
          if (allModels.has(modelId)) continue;

          allModels.set(modelId, {
            thangs_model_id: modelId,
            title: model.name || 'Unknown',
            filename: model.modelFileName || null,
            thumbnail_url: model.thumbnailUrl || null,
            owner: model.ownerUsername || null,
            part_ids: (model.parts || []).map(p => String(p.modelId || p.id || '')).filter(Boolean),
            download_url: model.modelPageUrl || `https://thangs.com/m/${modelId}`
          });
          pageOwnerCount++;
        }

        process.stdout.write(`  page ${page}: ${results.length} results, ${pageOwnerCount} Multiboard (${allModels.size} total)\r`);
        page++;
        await sleep(DELAY_MS);

      } catch (err) {
        if (err.message === 'RATE_LIMITED') {
          console.log(`\n  Rate limited on page ${page}, waiting 10s...`);
          await sleep(10000);
          continue;
        }
        console.error(`\n  Error on page ${page}: ${err.message}`);
        break;
      }
    }
    console.log(`\n  Done with "${term}" — ${allModels.size} total`);
  }

  const models = [...allModels.values()];
  console.log(`\nTotal unique Multiboard models: ${models.length}`);

  if (outputFile) {
    fs.writeFileSync(outputFile, JSON.stringify(models, null, 2));
    console.log(`Saved to ${outputFile}`);
  }
  return models;
}

// ── Phase 2: Import + Match (runs on server with DB access) ──
function importAndMatch(models) {
  require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
  const db = require('../db');
  db.initDatabase();
  const d = db.getDb();

  if (models && models.length > 0) {
    console.log(`\nImporting ${models.length} models into thangs_parts_index...`);
    let saved = 0;
    for (const model of models) {
      db.upsertThangsPartIndex(model);
      saved++;
      if (saved % 100 === 0) process.stdout.write(`  ${saved}/${models.length}\r`);
    }
    console.log(`  Saved ${saved} models`);
  }

  // Cross-reference against stl_catalog
  console.log('\nMatching against local stl_catalog...');
  const catalogItems = d.prepare('SELECT id, name, source_url FROM stl_catalog').all();
  const catalogByNorm = new Map();
  for (const item of catalogItems) {
    const norm = normalizeName(item.name);
    if (!catalogByNorm.has(norm)) catalogByNorm.set(norm, item);
  }
  console.log(`  Local catalog: ${catalogItems.length} items, ${catalogByNorm.size} unique normalized names`);

  const thangsItems = d.prepare('SELECT * FROM thangs_parts_index').all();
  let matched = 0, missing = 0, alreadyMatched = 0;

  const updateStatus = d.prepare('UPDATE thangs_parts_index SET status = ?, matched_catalog_id = ? WHERE thangs_model_id = ?');
  const updateSourceUrl = d.prepare("UPDATE stl_catalog SET source_url = ? WHERE id = ? AND (source_url IS NULL OR source_url = '')");

  const matchTransaction = d.transaction(() => {
    for (const tp of thangsItems) {
      if (tp.status === 'matched' && tp.matched_catalog_id) { alreadyMatched++; continue; }
      if (tp.status === 'skipped') continue;

      const normTitle = normalizeName(tp.title);
      const normFilename = normalizeName(tp.filename);

      let catalogMatch = catalogByNorm.get(normTitle);
      if (!catalogMatch && normFilename) catalogMatch = catalogByNorm.get(normFilename);
      if (!catalogMatch) {
        for (const [norm, item] of catalogByNorm) {
          if (norm.length > 5 && normTitle.length > 5 && (norm.includes(normTitle) || normTitle.includes(norm))) {
            catalogMatch = item;
            break;
          }
        }
      }

      if (catalogMatch) {
        updateStatus.run('matched', catalogMatch.id, tp.thangs_model_id);
        if (tp.download_url) updateSourceUrl.run(tp.download_url, catalogMatch.id);
        matched++;
      } else {
        updateStatus.run('missing', null, tp.thangs_model_id);
        missing++;
      }
    }
  });
  matchTransaction();

  const status = db.getThangsSyncStatus();
  console.log(`\n=== Sync Complete ===`);
  console.log(`Total indexed:      ${status.total}`);
  console.log(`Already matched:    ${alreadyMatched}`);
  console.log(`Newly matched:      ${matched}`);
  console.log(`Missing (download): ${status.missing}`);
  console.log(`Skipped:            ${status.skipped}`);

  const missingExamples = d.prepare("SELECT title, download_url FROM thangs_parts_index WHERE status = 'missing' ORDER BY title LIMIT 15").all();
  if (missingExamples.length > 0) {
    console.log(`\n--- Sample Missing (first 15) ---`);
    for (const m of missingExamples) console.log(`  ${m.title}\n    ${m.download_url}`);
  }

  return status;
}

// Export for use from server API
module.exports = { crawlThangs, importAndMatch, normalizeName };

// ── CLI ──
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--crawl')) {
    const outputIdx = args.indexOf('--output');
    const outputFile = outputIdx >= 0 ? args[outputIdx + 1] : path.join(__dirname, 'thangs-data.json');
    await crawlThangs(outputFile);
    return;
  }

  if (args.includes('--import')) {
    const fileIdx = args.indexOf('--import');
    const file = args[fileIdx + 1];
    if (!file || !fs.existsSync(file)) {
      console.error('Usage: --import <file.json>');
      process.exit(1);
    }
    const models = JSON.parse(fs.readFileSync(file, 'utf-8'));
    importAndMatch(models);
    return;
  }

  // Default: just re-match existing data
  require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
  const db = require('../db');
  db.initDatabase();
  const d = db.getDb();
  const count = d.prepare('SELECT COUNT(*) as c FROM thangs_parts_index').get().c;
  if (count === 0) {
    console.log('No Thangs data in DB. Run with --crawl first (from local machine), then --import on server.');
    return;
  }
  console.log(`Re-matching ${count} existing Thangs entries...`);
  importAndMatch([]);
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
