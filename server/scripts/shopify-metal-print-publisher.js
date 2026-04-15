/**
 * Shopify Metal Print Publisher
 *
 * Publishes metal print products to Shopify with Lumaprints size variants,
 * AI-generated descriptions, and room mockup images.
 *
 * Mirrors shopify-apparel-publisher.js pattern.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { METAL_PRINT_PIPELINE_DIR } = require('../paths');
const { apiFetch, sleep } = require('../modules/pipeline-utils');

// Lumaprints size variants with pricing
const SIZE_VARIANTS = [
  { size: '8x10',  width: 8,  height: 10, priceCents: 4995,  costCents: 2200 },
  { size: '11x14', width: 11, height: 14, priceCents: 6995,  costCents: 3100 },
  { size: '16x20', width: 16, height: 20, priceCents: 9995,  costCents: 4500 },
  { size: '20x30', width: 20, height: 30, priceCents: 14995, costCents: 6800 },
  { size: '24x36', width: 24, height: 36, priceCents: 19995, costCents: 9200 },
  { size: '30x40', width: 30, height: 40, priceCents: 27995, costCents: 13000 },
  { size: '40x60', width: 40, height: 60, priceCents: 44995, costCents: 21000 }
];

const COLLECTION_TITLE = 'Metal Prints';
const PRODUCT_TYPE = 'Metal Print';
const VENDOR = 'Blue Ridge Custom Co';
const TAGS_BASE = ['metal-print', 'wall-art', 'aluminum', 'hd-sublimation', 'asheville', 'made-in-asheville'];

let shopify = null;
function getShopify() {
  if (!shopify) shopify = require('../integrations/shopify');
  return shopify;
}

/**
 * Generate an AI product description for a metal print.
 */
async function generateProductDescription(designName, designCategory) {
  try {
    const prompt = `Write a compelling Shopify product description (3-4 sentences, HTML formatted) for a metal print wall art product.

Product: "${designName}" metal print
Category: ${designCategory || 'wall art'}
Material: HD sublimation on .045" thick ChromaLuxe-grade aluminum
Finish: High-gloss with brilliant metallic sheen
Features: Ready to hang, float-mount backing, scratch-resistant, waterproof, made in Asheville NC
Brand: Blue Ridge Custom Co — locally made in Asheville, NC

The description should:
- Mention the HD sublimation on aluminum process (colors pop with metallic luminance)
- Highlight durability and the stunning visual depth
- Note it's ready to hang with float-mount backing (appears to float off the wall)
- Mention it's locally crafted in Asheville, NC
- Be enthusiastic but professional, not cheesy`;

    const result = await apiFetch('/api/ai-text/generate', {
      method: 'POST',
      body: JSON.stringify({ prompt, maxTokens: 300 }),
      timeout: 30000
    });
    if (result.text) return result.text;
  } catch (err) {
    console.error('[ShopifyMetalPrint] AI description failed, using fallback:', err.message);
  }

  return buildFallbackDescription(designName);
}

function buildFallbackDescription(designName) {
  return `<p><strong>${designName}</strong> — HD sublimation on premium aluminum. Colors come alive with stunning metallic luminance and depth you just can't get with traditional prints.</p>
<p>Each metal print features a high-gloss finish on ChromaLuxe-grade .045" aluminum with a float-mount backing that makes it appear to hover off your wall. Scratch-resistant, waterproof, and built to last a lifetime.</p>
<p>Locally crafted in Asheville, NC by Blue Ridge Custom Co. Ready to hang — no frame needed.</p>`;
}

/**
 * Find or create the "Metal Prints" collection on Shopify.
 */
async function findOrCreateCollection(title) {
  const shop = getShopify();
  const collections = await shop.listCollections();
  const existing = collections.find(c => c.title.toLowerCase() === title.toLowerCase());
  if (existing) return existing;
  return shop.createCustomCollection(title, { body_html: '<p>Premium HD sublimation metal prints on aluminum. Vivid colors, metallic sheen, ready to hang. Made in Asheville, NC.</p>' });
}

/**
 * Resolve a mockup file path to a public URL the Shopify API can fetch.
 */
function getMockupPublicUrl(mockupPath) {
  // The server serves these via /metal-print-mockups/ route
  // Must use a publicly accessible URL so Shopify can fetch the image
  // Preserve subdirectory structure (e.g. mountain-biking/metal-mockup-...)
  const PIPELINE_DIR = '/mnt/dbFiles/metal-print-pipeline';
  const publicBase = process.env.ASSET_BASE_URL || `http://localhost:${process.env.PORT || 4000}`;
  // Use just the filename — the pipeline-mockup route auto-searches subdirs
  const filename = path.basename(mockupPath);
  // Use /api/ prefix so nginx proxies to Node
  // Include API key so Shopify can fetch without auth issues
  const apiKey = process.env.INTERNAL_API_KEY || '';
  return `${publicBase}/api/reel-studio/pipeline-mockup/${encodeURIComponent(filename)}?key=${encodeURIComponent(apiKey)}`;
}

/**
 * Publish a single metal print product to Shopify.
 */
async function publishProduct({ title, descriptionHtml, mockupImageUrls, filteredArtUrl, tags, designId }) {
  const shop = getShopify();

  const variants = SIZE_VARIANTS.map(sv => ({
    title: sv.size,
    option1: sv.size,
    price: (sv.priceCents / 100).toFixed(2),
    sku: `MP-${(title || 'design').replace(/[^a-zA-Z0-9]/g, '-').substring(0, 30)}-${sv.size}`,
    requires_shipping: true,
    weight: sv.width * sv.height * 0.02, // approximate weight in lbs
    weight_unit: 'lb',
    inventory_management: null,
    fulfillment_service: 'manual'
  }));

  // Images: room mockups first (hero), then filtered art detail
  const images = [];
  for (const mockupUrl of (mockupImageUrls || [])) {
    images.push({ src: mockupUrl });
  }
  if (filteredArtUrl) {
    images.push({ src: filteredArtUrl });
  }

  const product = {
    title,
    body_html: descriptionHtml,
    vendor: VENDOR,
    product_type: PRODUCT_TYPE,
    tags: tags.join(', '),
    options: [{ name: 'Size' }],
    variants,
    images
  };

  const created = await shop.createProduct(product);
  console.log(`[ShopifyMetalPrint] Created product: ${created.id} — ${title}`);
  return created;
}

/**
 * Batch publish metal prints to Shopify.
 */
async function publishBatch(options = {}) {
  const { designs = [], mockupMap = {}, filteredArtMap = {}, dryRun = false, delayMs = 2000 } = options;

  console.log(`[ShopifyMetalPrint] Publishing batch: ${designs.length} designs, dryRun=${dryRun}`);

  let collection;
  if (!dryRun) {
    collection = await findOrCreateCollection(COLLECTION_TITLE);
    console.log(`[ShopifyMetalPrint] Collection: ${collection.id} — ${collection.title}`);
  }

  const results = [];
  for (const design of designs) {
    const designName = design.name || design.title || 'Metal Print';
    const designSlug = (designName).replace(/[^a-zA-Z0-9]/g, '-').toLowerCase().substring(0, 40);
    const designCategory = design.category || design.theme || '';

    try {
      // Generate description
      const descriptionHtml = await generateProductDescription(designName, designCategory);

      // Build tags
      const designTags = [...TAGS_BASE];
      if (designCategory) designTags.push(designCategory.toLowerCase().replace(/\s+/g, '-'));
      const nameWords = designName.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      designTags.push(...nameWords.slice(0, 5));

      // Get mockup URLs
      const mockupPaths = mockupMap[design.id] || mockupMap[designSlug] || [];
      const mockupImageUrls = mockupPaths.map(p => getMockupPublicUrl(p));

      // Get filtered art URL
      const filteredArtPath = filteredArtMap[design.id] || filteredArtMap[designSlug] || null;
      const filteredArtUrl = filteredArtPath ? getMockupPublicUrl(filteredArtPath) : null;

      if (dryRun) {
        results.push({
          designId: design.id,
          title: `${designName} — Metal Print`,
          tags: designTags,
          variantCount: SIZE_VARIANTS.length,
          mockupCount: mockupImageUrls.length,
          status: 'dry-run'
        });
        continue;
      }

      const product = await publishProduct({
        title: `${designName} — Metal Print`,
        descriptionHtml,
        mockupImageUrls,
        filteredArtUrl,
        tags: designTags,
        designId: design.id
      });

      // Add to collection
      if (collection) {
        try {
          await getShopify().addProductToCollection(product.id, collection.id);
        } catch (e) {
          console.error(`[ShopifyMetalPrint] Failed to add to collection:`, e.message);
        }
      }

      results.push({
        designId: design.id,
        shopifyId: product.id,
        handle: product.handle,
        title: product.title,
        variantCount: product.variants?.length || 0,
        status: 'published'
      });

      if (delayMs > 0) await sleep(delayMs);
    } catch (err) {
      console.error(`[ShopifyMetalPrint] Failed to publish "${designName}":`, err.message);
      results.push({
        designId: design.id,
        title: designName,
        error: err.message,
        status: 'error'
      });
    }
  }

  const success = results.filter(r => r.status === 'published' || r.status === 'dry-run').length;
  const failed = results.filter(r => r.status === 'error').length;
  console.log(`[ShopifyMetalPrint] Batch complete: ${success} success, ${failed} failed`);

  return {
    publishedAt: new Date().toISOString(),
    collection: collection ? { id: collection.id, title: collection.title } : null,
    total: results.length,
    success,
    failed,
    results
  };
}

/**
 * API route handler.
 */
async function handleShopifyMetalPrintRoute(pathname, req, res, db) {
  const { parseBody, sendJson, sendError } = require('../utils/http');

  // POST /api/shopify-metal-print/publish
  if (pathname === '/api/shopify-metal-print/publish' && req.method === 'POST') {
    const body = await parseBody(req);
    const { designs, mockupMap, filteredArtMap, dryRun, delayMs } = body;

    if (!designs || !designs.length) {
      return sendError(res, 400, 'designs array required');
    }

    publishBatch({ designs, mockupMap, filteredArtMap, dryRun, delayMs }).then(result => {
      console.log(`[ShopifyMetalPrint] Background publish finished: ${result.success}/${result.total}`);
    }).catch(err => {
      console.error('[ShopifyMetalPrint] Background publish failed:', err);
    });

    sendJson(res, 200, { status: 'started', designCount: designs.length, dryRun: !!dryRun });
    return true;
  }

  // GET /api/shopify-metal-print/pricing
  if (pathname === '/api/shopify-metal-print/pricing' && req.method === 'GET') {
    sendJson(res, 200, {
      success: true,
      variants: SIZE_VARIANTS.map(sv => ({
        size: sv.size,
        price: (sv.priceCents / 100).toFixed(2),
        cost: (sv.costCents / 100).toFixed(2),
        margin: ((sv.priceCents - sv.costCents) / sv.priceCents * 100).toFixed(1) + '%'
      }))
    });
    return true;
  }

  return false;
}

// CLI support
if (require.main === module) {
  console.log('Shopify Metal Print Publisher');
  console.log('Size variants:', SIZE_VARIANTS.map(s => `${s.size} @ $${(s.priceCents / 100).toFixed(2)}`).join(', '));
}

module.exports = {
  publishBatch,
  handleShopifyMetalPrintRoute,
  SIZE_VARIANTS,
  generateProductDescription
};
