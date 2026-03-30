/**
 * Product Blank Mockup Generator
 *
 * Places graphic designs onto actual product blank photos from inventory.
 * These are the "what you'll actually receive" images for Shopify listings,
 * paired with the lifestyle AI mockups for marketing.
 *
 * Uses the same Gemini compositing as ai-apparel-mockup.js but with
 * product blank photos instead of lifestyle model photos.
 *
 * Starter Kit approach:
 *   - Every design gets: White Tee + Black Tee (Tier 1)
 *   - Theme pick adds ONE more: Hoodie, Hat, etc. (Tier 2)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const ENV_PATH = path.join(APP_ROOT, '.env');
if (fs.existsSync(ENV_PATH)) require('dotenv').config({ path: ENV_PATH });

const OUTPUT_DIR = '/mnt/dbFiles/product-blank-mockups';
const BLANK_CACHE_DIR = '/mnt/dbFiles/blank-images';
const API_BASE = `http://localhost:${process.env.PORT || 4000}`;
const API_KEY = process.env.INTERNAL_API_KEY || '';

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(BLANK_CACHE_DIR, { recursive: true });

// ============================================================================
// STARTER KIT — what blanks each design gets
// ============================================================================

const TIER_1 = [
  { type: 'T-shirt', color: 'White', label: 'White Tee' },
  { type: 'T-shirt', color: 'Black', label: 'Black Tee' },
];

// Theme → which Tier 2 blank to add
const TIER_2_BY_THEME = {
  'moto-garage':        { type: 'Hoodie', color: 'Black', label: 'Black Hoodie' },
  'edgy-urban':         { type: 'Hoodie', color: 'Black', label: 'Black Hoodie' },
  'retro-vintage':      { type: 'Hoodie', color: 'Grey', label: 'Grey Hoodie' },
  'outdoor-adventure':  { type: 'Hoodie', color: 'Navy', label: 'Navy Hoodie' },
  'faith-inspirational':{ type: 'T-shirt', color: 'Grey', label: 'Grey Tee' },
  'humor-fun':          { type: 'T-shirt', color: 'Grey', label: 'Grey Tee' },
  'nature-animals':     { type: 'T-shirt', color: 'Dark Green', label: 'Green Tee' },
  'music-culture':      { type: 'Hoodie', color: 'Black', label: 'Black Hoodie' },
  'abstract-artistic':  { type: 'T-shirt', color: 'White', label: 'White Tee' },
  'sports-fitness':     { type: 'T-shirt', color: 'Grey', label: 'Grey Tee' },
};

/**
 * Get the list of blanks a design should be mocked up on.
 * Returns [{type, color, label, imageUrl}]
 *
 * @param {string} theme - Design theme key
 * @param {object} [options]
 * @param {Array<{type: string, color: string}>} [options.apparelChoices] -
 *   User-selected apparel items (e.g. [{type:'T-shirt',color:'Black'},{type:'Hoodie',color:'Navy'}]).
 *   When provided, these replace the default tier system entirely.
 */
async function getBlanksForDesign(theme, options = {}) {
  let blanks;

  if (options.apparelChoices && Array.isArray(options.apparelChoices) && options.apparelChoices.length) {
    // User explicitly chose which apparel to use — skip tier system
    blanks = options.apparelChoices.map(c => ({
      type: c.type || 'T-shirt',
      color: c.color || 'White',
      label: c.label || `${c.color || 'White'} ${c.type || 'T-shirt'}`
    }));
    console.log(`[ProductBlank] Using user-selected apparel: ${blanks.map(b => b.label).join(', ')}`);
  } else {
    // Default tier system
    blanks = [...TIER_1];
    const tier2 = TIER_2_BY_THEME[theme] || TIER_2_BY_THEME['humor-fun'];
    const isDupe = blanks.some(b => b.type === tier2.type && b.color === tier2.color);
    if (!isDupe) blanks.push(tier2);
  }

  // Resolve image URLs from inventory
  const inventory = await fetchInventory();
  const resolved = [];

  for (const blank of blanks) {
    const match = inventory.find(i => {
      const name = (i.name || '').toLowerCase();
      const type = blank.type.toLowerCase();
      const color = blank.color.toLowerCase();
      return name.includes(type) && name.includes(color) && name.includes('- l');
    });

    if (match) {
      resolved.push({
        ...blank,
        imageUrl: match.imageUrl || match.image_url,
        imageUrlBack: match.imageUrlBack || match.image_url_back,
        inventoryId: match.id,
        cost: (match.unitCostCents || match.unit_cost_cents || 0) / 100
      });
    } else {
      console.warn(`[ProductBlank] No inventory match for ${blank.type} ${blank.color}`);
    }
  }

  return resolved;
}

// ============================================================================
// INVENTORY & IMAGE HELPERS
// ============================================================================

let _inventoryCache = null;
let _inventoryCacheTime = 0;

async function fetchInventory() {
  if (_inventoryCache && Date.now() - _inventoryCacheTime < 300000) return _inventoryCache;
  try {
    const resp = await fetch(`${API_BASE}/api/inventory`, {
      headers: { 'X-API-Key': API_KEY },
      signal: AbortSignal.timeout(10000)
    });
    const d = await resp.json();
    _inventoryCache = Array.isArray(d) ? d : (d.items || d.inventory || []);
    _inventoryCacheTime = Date.now();
    return _inventoryCache;
  } catch (err) {
    console.error('[ProductBlank] Inventory fetch error:', err.message);
    return _inventoryCache || [];
  }
}

/**
 * Download a blank image from CDN and cache locally.
 */
async function getBlankImage(imageUrl) {
  if (!imageUrl) return null;

  // Cache by URL hash
  const hash = crypto.createHash('md5').update(imageUrl).digest('hex');
  const ext = imageUrl.includes('.png') ? '.png' : '.jpg';
  const cachePath = path.join(BLANK_CACHE_DIR, `blank_${hash}${ext}`);

  if (fs.existsSync(cachePath)) return cachePath;

  try {
    const resp = await fetch(imageUrl, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(cachePath, buf);
    return cachePath;
  } catch (err) {
    console.error(`[ProductBlank] Download failed: ${imageUrl} — ${err.message}`);
    return null;
  }
}

// ============================================================================
// MOCKUP GENERATION — pixel-based compositing on product blanks
// ============================================================================

async function generateBlankMockup(blankImagePath, graphicPath, options = {}) {
  const { type = 't-shirt', color = 'white', designName = '' } = options;

  const { compositeOnGarment } = require('../garment-compositor');

  const result = await compositeOnGarment(blankImagePath, graphicPath, {
    zone: 'front-chest',
    size: 'large',
    photoType: 'product',
    blendOpacity: 0.3
  });

  // Copy from compositor output to product blank directory
  const destFilename = `product_${(designName || 'design').substring(0, 30)}_${type}_${color}_${Date.now()}.jpg`;
  const destPath = path.join(OUTPUT_DIR, destFilename);

  if (fs.existsSync(result.imagePath)) {
    fs.copyFileSync(result.imagePath, destPath);
  }

  return { imagePath: destPath, filename: destFilename, type, color };
}

/**
 * Generate product blank mockups for a design on all its assigned blanks.
 */
async function generateProductMockups(designId, graphicPath, theme, options = {}) {
  const blanks = await getBlanksForDesign(theme, { apparelChoices: options.apparelChoices });
  const results = [];

  console.log(`[ProductBlank] Generating ${blanks.length} product mockups for "${designId}"`);

  for (const blank of blanks) {
    // Download the blank image
    const blankImagePath = await getBlankImage(blank.imageUrl);
    if (!blankImagePath) {
      console.warn(`[ProductBlank] Skipping ${blank.label} — no image`);
      continue;
    }

    try {
      const result = await generateBlankMockup(blankImagePath, graphicPath, {
        type: blank.type,
        color: blank.color,
        designName: designId
      });
      results.push({ ...result, label: blank.label, cost: blank.cost });
      console.log(`[ProductBlank]   ✓ ${blank.label}`);
    } catch (err) {
      console.error(`[ProductBlank]   ✗ ${blank.label}: ${err.message}`);
    }

    // Rate limit
    await new Promise(r => setTimeout(r, 3000));
  }

  return results;
}

// ============================================================================
// BATCH — generate product mockups for a whole collection
// ============================================================================

async function generateProductMockupsBatch(designs, theme, options = {}) {
  const { delayMs = 5000, limit, apparelChoices } = options;
  const toProcess = limit ? designs.slice(0, limit) : designs;
  const allResults = [];

  for (let i = 0; i < toProcess.length; i++) {
    const design = toProcess[i];
    console.log(`[ProductBlank] [${i + 1}/${toProcess.length}] "${(design.name || design.id).substring(0, 40)}"`);

    try {
      const results = await generateProductMockups(
        design.id,
        design.graphicPath,
        theme,
        { apparelChoices }
      );
      allResults.push({ designId: design.id, mockups: results });
    } catch (err) {
      console.error(`[ProductBlank] Design "${design.id}" failed: ${err.message}`);
      allResults.push({ designId: design.id, error: err.message });
    }

    if (i < toProcess.length - 1) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  return allResults;
}

module.exports = {
  getBlanksForDesign,
  generateProductMockups,
  generateProductMockupsBatch,
  generateBlankMockup,
  TIER_1,
  TIER_2_BY_THEME
};
