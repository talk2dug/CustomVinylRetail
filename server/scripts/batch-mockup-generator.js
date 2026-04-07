#!/usr/bin/env node
/**
 * Batch Mockup Generator
 *
 * Takes a design collection from the catalog and auto-generates mockups
 * by placing each design on matching model photos via Gemini AI.
 *
 * Usage:
 *   node batch-mockup-generator.js --category "95 T Shirt Designs Mega Bundle" --limit 10
 *   node batch-mockup-generator.js --category "95 T Shirt Designs Mega Bundle" --models phoenix --limit 5
 *   node batch-mockup-generator.js --design-id "biker-garage-1774584631175" --model-id "hm_053cba6feab5ae10"
 *
 * Can also be called via API: POST /api/batch-mockups/generate
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const ENV_PATH = path.join(APP_ROOT, '.env');
if (fs.existsSync(ENV_PATH)) require('dotenv').config({ path: ENV_PATH });

const { PIPELINE_OUTPUT_DIR } = require('../paths');
const LIBRARY_ROOT = path.join(APP_ROOT, 'web', 'library');
const OUTPUT_DIR = PIPELINE_OUTPUT_DIR;
const CATALOG_MOCKUP_DIR = path.join(LIBRARY_ROOT, 'Mockups', 'uploads', 'previews');
const CATALOG_PATH = path.join(APP_ROOT, 'web', 'catalog.json');

const API_BASE = `http://localhost:${process.env.PORT || 4000}`;
const API_KEY = process.env.INTERNAL_API_KEY || '';

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(CATALOG_MOCKUP_DIR, { recursive: true });

// ============================================================================
// API HELPERS
// ============================================================================

async function apiFetch(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const resp = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(120000)
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`API ${resp.status}: ${text.substring(0, 200)}`);
  }
  return resp.json();
}

// ============================================================================
// DESIGN & MODEL LOADING
// ============================================================================

function loadCatalog() {
  if (!fs.existsSync(CATALOG_PATH)) throw new Error('Catalog not found: ' + CATALOG_PATH);
  return JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
}

function getDesignsFromCategory(catalog, categoryName) {
  const cat = catalog.categories.find(c =>
    c.name.toLowerCase().includes(categoryName.toLowerCase()) ||
    c.slug.toLowerCase().includes(categoryName.toLowerCase())
  );
  if (!cat) throw new Error(`Category not found: "${categoryName}". Available: ${catalog.categories.map(c => c.name).join(', ')}`);
  return { category: cat.name, designs: cat.designs };
}

async function getModels(filter = {}) {
  const data = await apiFetch('/api/human-models');
  let models = Array.isArray(data) ? data : (data.models || data.items || []);

  // Filter by apparel type
  if (filter.apparelType) {
    models = models.filter(m => m.apparelType === filter.apparelType);
  }
  // Filter by name keyword (e.g., "phoenix")
  if (filter.nameFilter) {
    const kw = filter.nameFilter.toLowerCase();
    models = models.filter(m => (m.title || '').toLowerCase().includes(kw));
  }
  // Filter by style (casual-everyday, pinup-retro, edgy-urban, etc.)
  if (filter.style) {
    const styles = Array.isArray(filter.style) ? filter.style : [filter.style];
    const styled = models.filter(m => styles.includes(m.style));
    if (styled.length > 0) models = styled;
  }
  // Filter by demographic (everyday-mom, millennial-parent, young-adult, etc.)
  if (filter.demographic) {
    const demos = Array.isArray(filter.demographic) ? filter.demographic : [filter.demographic];
    const matched = models.filter(m => demos.includes(m.demographic));
    if (matched.length > 0) models = matched;
  }
  // Exclude styles
  if (filter.excludeStyle) {
    const exclude = Array.isArray(filter.excludeStyle) ? filter.excludeStyle : [filter.excludeStyle];
    models = models.filter(m => !exclude.includes(m.style));
  }
  // Filter by facing
  if (filter.facing) {
    models = models.filter(m => m.facing === filter.facing);
  }
  // Only active, analyzed models
  models = models.filter(m => m.active !== false && m.apparelType);

  return models;
}

// ============================================================================
// GRAPHIC FILE RESOLUTION
// ============================================================================

function resolveToLocalPath(urlOrPath) {
  let p = urlOrPath;
  // Strip full URL to path
  if (p.startsWith('http')) {
    try { p = decodeURIComponent(new URL(p).pathname); } catch (_) {}
  }
  // Try multiple resolution strategies
  const candidates = [];
  if (p.startsWith('/library/')) {
    candidates.push(path.join(LIBRARY_ROOT, p.slice('/library/'.length)));
    candidates.push(path.join(APP_ROOT, 'web', p.slice(1)));
  } else if (p.startsWith('/')) {
    candidates.push(path.join(APP_ROOT, 'web', p.slice(1)));
  }
  candidates.push(p); // try as-is
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function resolveGraphicPath(design) {
  const sources = design.sources || {};

  // Try preview image first (PNG preferred for transparency)
  if (design.image) {
    const resolved = resolveToLocalPath(design.image);
    if (resolved) return resolved;
  }

  // Try source files: PNG > SVG > JPG
  for (const ext of ['png', 'svg', 'jpg', 'jpeg']) {
    if (sources[ext]) {
      const resolved = resolveToLocalPath(sources[ext]);
      if (resolved) return resolved;
    }
  }

  return null;
}

// ============================================================================
// MODEL SELECTION
// ============================================================================

/**
 * Pick the best model for a design.
 * Rotates through models to avoid always using the same one.
 * Prefers front-facing t-shirt models.
 */
function pickModel(models, usedModelIds = []) {
  // Prefer unused models
  let candidates = models.filter(m => !usedModelIds.includes(m.id));
  if (candidates.length === 0) candidates = models; // reset if all used

  // Prefer front-facing
  const frontFacing = candidates.filter(m => m.facing === 'front');
  if (frontFacing.length > 0) candidates = frontFacing;

  // Random pick from candidates
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// ============================================================================
// MOCKUP GENERATION
// ============================================================================

async function generateMockup(design, model, options = {}) {
  const graphicPath = resolveGraphicPath(design);
  if (!graphicPath) {
    return { success: false, error: `No graphic file found for design: ${design.name}` };
  }

  // Convert filesystem path back to web path for the API
  let webGraphicPath = graphicPath;
  if (graphicPath.startsWith(LIBRARY_ROOT)) {
    webGraphicPath = '/library/' + path.relative(LIBRARY_ROOT, graphicPath);
  }

  const garmentType = model.apparelType || 't-shirt';
  const zone = options.zone || 'front-chest';
  const size = options.size || 'large';

  try {
    const result = await apiFetch('/api/ai-images/apparel-mockup', {
      method: 'POST',
      body: JSON.stringify({
        modelFrontId: model.id,
        garmentType,
        placements: [{
          graphicPath: webGraphicPath,
          zone,
          size
        }],
        generateSideBySide: false
      })
    });

    if (!result.success) {
      return { success: false, error: result.error || 'Generation failed' };
    }

    // Save to permanent storage
    const frontResult = result.front;
    if (frontResult && frontResult.imagePath) {
      const srcPath = path.join(APP_ROOT, 'web', frontResult.imagePath.replace(/^\//, ''));
      const destFilename = `mockup_${design.id}_${model.id}_${Date.now()}.jpg`;
      const destPath = path.join(OUTPUT_DIR, destFilename);

      if (fs.existsSync(srcPath)) {
        fs.copyFileSync(srcPath, destPath);
        // Also copy to catalog Mockups folder for browsing
        const catalogName = `mockup-${design.id.substring(0, 40)}-${model.id.substring(0, 12)}.jpg`;
        const catalogPath = path.join(CATALOG_MOCKUP_DIR, catalogName);
        try { fs.copyFileSync(srcPath, catalogPath); } catch (_) {}
      }

      return {
        success: true,
        designId: design.id,
        designName: design.name,
        modelId: model.id,
        modelName: model.title,
        garmentType,
        zone,
        size,
        imagePath: destPath,
        webPath: `/apparel-mockups/${destFilename}`,
        generatedAt: new Date().toISOString()
      };
    }

    return { success: false, error: 'No front image in result' };
  } catch (err) {
    return { success: false, error: err.message, designId: design.id, modelId: model.id };
  }
}

// ============================================================================
// BATCH GENERATION
// ============================================================================

async function runBatch(options = {}) {
  const {
    category = '95 T Shirt Designs Mega Bundle',
    designIds = null,
    limit = 10,
    modelFilter = {},
    zone = 'front-chest',
    size = 'large',
    delayMs = 5000
  } = options;

  console.log('=== Batch Mockup Generator ===');
  console.log(`Category: ${category}`);
  if (designIds) console.log(`Design IDs: ${designIds.length} specific designs`);
  console.log(`Limit: ${limit}`);
  console.log(`Model filter:`, modelFilter);
  console.log();

  // Load designs
  const catalog = loadCatalog();
  let designs = [];
  let catName = category;

  if (designIds && Array.isArray(designIds) && designIds.length) {
    const idSet = new Set(designIds.map(id => String(id)));
    for (const cat of (catalog.categories || [])) {
      for (const design of (cat.designs || [])) {
        if (idSet.has(String(design.id))) {
          designs.push(design);
          idSet.delete(String(design.id));
        }
      }
      if (idSet.size === 0) break;
    }
    catName = `Campaign (${designs.length} designs)`;
  } else {
    const result = getDesignsFromCategory(catalog, category);
    catName = result.category;
    designs = result.designs;
  }
  console.log(`Found ${designs.length} designs in "${catName}"`);

  // Load models
  const models = await getModels({
    apparelType: 't-shirt',
    ...modelFilter
  });
  console.log(`Found ${models.length} matching models`);

  if (models.length === 0) {
    console.error('No matching models found. Check apparel type and filters.');
    return { success: 0, failed: 0, results: [] };
  }

  // Skip designs that already have mockups
  const existingMockups = new Set();
  if (fs.existsSync(OUTPUT_DIR)) {
    for (const f of fs.readdirSync(OUTPUT_DIR)) {
      if (f.startsWith('mockup_') && f.endsWith('.jpg')) {
        const designId = f.split('_hm_')[0].replace('mockup_', '');
        existingMockups.add(designId);
      }
    }
  }
  const needsMockup = designs.filter(d => !existingMockups.has(d.id));
  console.log(`Already have mockups: ${existingMockups.size}, Need mockups: ${needsMockup.length}`);

  // Select designs to process
  const toProcess = needsMockup.slice(0, limit);
  console.log(`Processing ${toProcess.length} designs...\n`);

  const results = [];
  const usedModelIds = [];
  let success = 0;
  let failed = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const design = toProcess[i];
    const model = pickModel(models, usedModelIds);
    usedModelIds.push(model.id);

    console.log(`[${i + 1}/${toProcess.length}] "${design.name.substring(0, 40)}" → ${(model.title || model.id).substring(0, 30)}`);

    const result = await generateMockup(design, model, { zone, size });

    if (result.success) {
      success++;
      console.log(`  ✓ Generated: ${result.webPath}`);
    } else {
      failed++;
      console.log(`  ✗ Failed: ${result.error?.substring(0, 80)}`);
    }

    results.push(result);

    // Rate limit between generations
    if (i < toProcess.length - 1) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  console.log(`\n=== COMPLETE ===`);
  console.log(`Success: ${success}/${toProcess.length}`);
  console.log(`Failed: ${failed}/${toProcess.length}`);

  // Save manifest
  const manifest = {
    category: catName,
    generatedAt: new Date().toISOString(),
    total: toProcess.length,
    success,
    failed,
    results: results.filter(r => r.success)
  };
  const manifestPath = path.join(OUTPUT_DIR, `batch_${Date.now()}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`Manifest: ${manifestPath}`);

  return manifest;
}

// ============================================================================
// API HANDLER (for server integration)
// ============================================================================

async function handleBatchMockupRoute(pathname, req, res, db) {
  const basePath = '/api/batch-mockups';
  if (!pathname.startsWith(basePath)) return false;
  const route = pathname.slice(basePath.length) || '/';

  const sendJson = (data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(data));
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-API-Key' });
    res.end();
    return true;
  }

  // POST /api/batch-mockups/generate — start a batch generation
  if (route === '/generate' && req.method === 'POST') {
    try {
      const chunks = [];
      await new Promise((resolve, reject) => {
        req.on('data', c => chunks.push(c));
        req.on('end', resolve);
        req.on('error', reject);
      });
      const body = JSON.parse(Buffer.concat(chunks).toString());

      // Run in background — return immediately
      const jobId = crypto.randomUUID();
      sendJson({ jobId, status: 'started', message: 'Batch generation started in background' }, 202);

      // Run async
      runBatch({
        category: body.category || '95 T Shirt Designs Mega Bundle',
        designIds: body.designIds || null,
        limit: body.limit || 10,
        modelFilter: body.modelFilter || {},
        zone: body.zone || 'front-chest',
        size: body.size || 'large',
        delayMs: body.delayMs || 5000
      }).then(result => {
        console.log(`[BatchMockup] Job ${jobId} complete: ${result.success}/${result.total}`);
      }).catch(err => {
        console.error(`[BatchMockup] Job ${jobId} failed:`, err.message);
      });

      return true;
    } catch (err) {
      sendJson({ error: err.message }, 500);
      return true;
    }
  }

  // GET /api/batch-mockups — list generated mockups
  if (route === '/' && req.method === 'GET') {
    try {
      const files = fs.readdirSync(OUTPUT_DIR)
        .filter(f => f.startsWith('mockup_') && (f.endsWith('.jpg') || f.endsWith('.png')))
        .map(f => {
          const stat = fs.statSync(path.join(OUTPUT_DIR, f));
          return {
            filename: f,
            url: `/apparel-mockups/${f}`,
            size: stat.size,
            createdAt: stat.mtime.toISOString()
          };
        })
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      sendJson({ mockups: files, total: files.length });
    } catch (err) {
      sendJson({ error: err.message }, 500);
    }
    return true;
  }

  // GET /api/batch-mockups/manifests — list batch run manifests
  if (route === '/manifests' && req.method === 'GET') {
    try {
      const files = fs.readdirSync(OUTPUT_DIR)
        .filter(f => f.startsWith('batch_') && f.endsWith('.json'))
        .map(f => {
          const data = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, f), 'utf8'));
          return { filename: f, ...data };
        })
        .sort((a, b) => new Date(b.generatedAt) - new Date(a.generatedAt));
      sendJson({ manifests: files });
    } catch (err) {
      sendJson({ error: err.message }, 500);
    }
    return true;
  }

  return false;
}

// ============================================================================
// CLI
// ============================================================================

if (require.main === module) {
  const args = process.argv.slice(2);
  const getArg = (flag) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? args[i + 1] : null; };

  const options = {
    category: getArg('--category') || '95 T Shirt Designs Mega Bundle',
    limit: parseInt(getArg('--limit') || '5'),
    modelFilter: {},
    zone: getArg('--zone') || 'front-chest',
    size: getArg('--size') || 'large',
    delayMs: parseInt(getArg('--delay') || '5000')
  };

  if (getArg('--models')) {
    options.modelFilter.nameFilter = getArg('--models');
  }

  runBatch(options).then(result => {
    process.exit(result.failed > 0 && result.success === 0 ? 1 : 0);
  }).catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}

module.exports = { runBatch, handleBatchMockupRoute };
