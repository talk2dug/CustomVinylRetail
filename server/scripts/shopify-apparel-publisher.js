#!/usr/bin/env node
/**
 * Shopify Apparel Publisher
 *
 * Takes designs from the catalog + their generated mockups and publishes
 * them to Shopify as apparel products with:
 *   - Both the flat design image AND the mockup photo
 *   - Size variants (S, M, L, XL, 2XL) with tiered pricing
 *   - AI-generated product descriptions via Gemini
 *   - Auto-add to Apparel collection
 *
 * Usage:
 *   node shopify-apparel-publisher.js --category "95 T Shirt Designs Mega Bundle" --limit 10
 *   node shopify-apparel-publisher.js --category "95 T Shirt Designs Mega Bundle" --dry-run
 *
 * API: POST /api/shopify-apparel/publish
 */

const fs = require('fs');
const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const ENV_PATH = path.join(APP_ROOT, '.env');
if (fs.existsSync(ENV_PATH)) require('dotenv').config({ path: ENV_PATH });

const MOCKUP_DIR = '/mnt/dbFiles/apparel-mockups';
const PRODUCT_BLANK_DIR = '/mnt/dbFiles/product-blank-mockups';
const CATALOG_DIR = path.join(APP_ROOT, 'web', 'library');
const PUBLIC_BASE = process.env.PUBLIC_URL || 'https://blueridgecustomco.com';

// ============================================================================
// PRICING — Bella Canvas 4610C
// ============================================================================

const SIZE_VARIANTS = [
  { size: 'S',   price: '24.99', cost: '3.99' },
  { size: 'M',   price: '24.99', cost: '3.99' },
  { size: 'L',   price: '24.99', cost: '3.99' },
  { size: 'XL',  price: '27.99', cost: '3.99' },
  { size: '2XL', price: '29.99', cost: '3.99' },
];

const COLLECTION_TITLE = 'Apparel';
const PRODUCT_TYPE = 'T-Shirt';
const VENDOR = 'Blue Ridge Custom Co';
const TAGS_BASE = ['apparel', 'custom-tee', 'graphic-tee', 'asheville', 'made-in-asheville'];

// ============================================================================
// GEMINI DESCRIPTION GENERATOR
// ============================================================================

function cleanKey(value) {
  if (!value) return '';
  let trimmed = String(value).trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) trimmed = trimmed.slice(1, -1);
  return trimmed;
}

const GEMINI_API_KEY = cleanKey(process.env.GEMINI_API_KEY || '');
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=';

async function generateProductDescription(designName, designCategory) {
  if (!GEMINI_API_KEY) {
    return buildFallbackDescription(designName);
  }

  const prompt = `Write a compelling Shopify product description for a custom graphic t-shirt.

Design name: "${designName}"
Design category: "${designCategory || 'graphic tee'}"
Brand: Blue Ridge Custom Co
Location: Asheville, NC (locally printed — this is a key selling point)
Product: Premium heavyweight graphic tee (Bella Canvas 4610C, 7.5oz)

Requirements:
- 2-3 short paragraphs, conversational but professional
- Highlight the design's vibe/aesthetic
- Mention it's custom printed in Asheville, NC
- Mention premium heavyweight fabric (7.5oz Bella Canvas)
- Include care instructions briefly (machine wash cold, tumble dry low)
- Do NOT use markdown, just plain text with line breaks
- Do NOT include the price or size info (that's handled by variants)
- Keep it under 150 words
- Sound authentic, not generic AI-generated

Return ONLY the product description text, nothing else.`;

  try {
    const resp = await fetch(GEMINI_URL + GEMINI_API_KEY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 500, thinkingConfig: { thinkingBudget: 0 } }
      }),
      signal: AbortSignal.timeout(20000)
    });

    if (!resp.ok) throw new Error(`Gemini ${resp.status}`);
    const data = await resp.json();
    const text = data.candidates?.[0]?.content?.parts?.filter(p => p.text && !p.thought).map(p => p.text).join('\n');
    if (text && text.length > 20) return text.trim();
  } catch (err) {
    console.warn(`[ShopifyApparel] AI description failed for "${designName}": ${err.message}`);
  }

  return buildFallbackDescription(designName);
}

function buildFallbackDescription(designName) {
  const cleanName = designName.replace(/\s+\d+$/, '').replace(/-/g, ' ');
  return `${cleanName} — a premium graphic tee custom printed right here in Asheville, NC by Blue Ridge Custom Co.

This design is printed on a heavyweight 7.5oz Bella Canvas 4610C tee for a substantial, quality feel that holds up wash after wash. The print is vibrant, detailed, and built to last.

Locally made with care. Machine wash cold, tumble dry low.`;
}

// ============================================================================
// SHOPIFY API
// ============================================================================

let shopify;
try {
  shopify = require('../integrations/shopify');
} catch (e) {
  console.error('Could not load Shopify integration:', e.message);
}

async function findOrCreateCollection(title) {
  try {
    // Search existing collections
    const existing = await shopify.findCustomCollectionByTitle(title);
    if (existing) {
      console.log(`[ShopifyApparel] Found collection: "${title}" (ID: ${existing.id})`);
      return existing;
    }

    // Create new collection
    const created = await shopify.createCustomCollection(title);
    console.log(`[ShopifyApparel] Created collection: "${title}" (ID: ${created.id})`);
    return created;
  } catch (err) {
    console.error(`[ShopifyApparel] Collection error: ${err.message}`);
    return null;
  }
}

async function publishProduct({ title, descriptionHtml, designImageUrl, mockupImageUrl, productBlankUrls, tags, designId }) {
  // Build size variants
  const variants = SIZE_VARIANTS.map(v => ({
    option1: v.size,
    price: v.price,
    compare_at_price: null,
    sku: `TEE-${designId.substring(0, 20).toUpperCase()}-${v.size}`,
    inventory_management: 'shopify',
    inventory_policy: 'continue',
    requires_shipping: true,
    taxable: true,
    weight: v.size === '2XL' ? 0.35 : 0.3,
    weight_unit: 'kg'
  }));

  // Build images — order matters for the listing:
  // 1. Lifestyle mockup (the hero/marketing shot)
  // 2. Product blank mockups (what they'll actually get)
  // 3. Flat design image
  const images = [];
  if (mockupImageUrl) images.push({ src: mockupImageUrl, alt: `${title} - Lifestyle Mockup` });
  if (productBlankUrls && productBlankUrls.length) {
    for (const pb of productBlankUrls) {
      images.push({ src: pb.url, alt: `${title} - ${pb.label}` });
    }
  }
  if (designImageUrl) images.push({ src: designImageUrl, alt: `${title} - Design` });

  const product = {
    title,
    body_html: descriptionHtml,
    vendor: VENDOR,
    product_type: PRODUCT_TYPE,
    tags: tags.join(', '),
    status: 'active',
    published: true,
    options: [{ name: 'Size', values: SIZE_VARIANTS.map(v => v.size) }],
    variants,
    images
  };

  let result;
  try {
    result = await shopify.createProduct(product);
  } catch (shopifyErr) {
    // Shopify errors have .detail with the full response
    const detail = shopifyErr.detail ? JSON.stringify(shopifyErr.detail).substring(0, 500) : '';
    const msg = shopifyErr.message || '';
    const fullMsg = detail || msg || JSON.stringify(shopifyErr).substring(0, 300);
    throw new Error(`Shopify API (${shopifyErr.status || '?'}): ${fullMsg}`);
  }
  if (result?.errors) {
    throw new Error(`Shopify validation: ${JSON.stringify(result.errors).substring(0, 300)}`);
  }
  return result;
}

// ============================================================================
// DESIGN + MOCKUP MATCHING
// ============================================================================

function loadCatalog() {
  const catalogPath = path.join(APP_ROOT, 'web', 'catalog.json');
  return JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
}

function findMockupForDesign(designId) {
  // Look for lifestyle mockup files that contain the design ID
  if (!fs.existsSync(MOCKUP_DIR)) return null;
  const files = fs.readdirSync(MOCKUP_DIR).filter(f =>
    f.startsWith('mockup_') && f.includes(designId.substring(0, 30)) && f.endsWith('.jpg')
  );
  if (files.length === 0) return null;
  return path.join(MOCKUP_DIR, files[0]);
}

function findProductBlanksForDesign(designId) {
  // Look for product blank mockups that contain the design ID
  if (!fs.existsSync(PRODUCT_BLANK_DIR)) return [];
  const files = fs.readdirSync(PRODUCT_BLANK_DIR).filter(f =>
    f.startsWith('product_') && f.includes(designId.substring(0, 30)) && f.endsWith('.jpg')
  );
  return files.map(f => {
    // Extract type and color from filename: product_designId_type_color_timestamp.jpg
    const parts = f.replace('product_', '').replace('.jpg', '').split('_');
    // Find type and color parts (after the design id portion)
    let label = 'Product';
    const fLower = f.toLowerCase();
    if (fLower.includes('_hoodie_')) {
      label = fLower.includes('_black_') ? 'Black Hoodie' : fLower.includes('_grey_') ? 'Grey Hoodie' : fLower.includes('_navy_') ? 'Navy Hoodie' : 'Hoodie';
    } else if (fLower.includes('_t-shirt_') || fLower.includes('_tee_')) {
      label = fLower.includes('_black_') ? 'Black Tee' : fLower.includes('_white_') ? 'White Tee' : fLower.includes('_grey_') ? 'Grey Tee' : 'T-Shirt';
    } else if (fLower.includes('_hat_')) {
      label = 'Hat';
    }
    return {
      path: path.join(PRODUCT_BLANK_DIR, f),
      filename: f,
      label
    };
  });
}

function encodeImageUrl(url) {
  // Encode spaces and special chars in the URL path while preserving the structure
  try {
    const u = new URL(url);
    // Encode each path segment individually
    u.pathname = u.pathname.split('/').map(seg => encodeURIComponent(decodeURIComponent(seg))).join('/');
    return u.toString();
  } catch (_) {
    return url.replace(/ /g, '%20');
  }
}

function resolveDesignImageUrl(design) {
  // Get the public URL for the design preview image
  if (design.image && design.image.startsWith('http')) return encodeImageUrl(design.image);
  if (design.image) return encodeImageUrl(`${PUBLIC_BASE}${design.image}`);
  return null;
}

function getMockupPublicUrl(mockupPath) {
  // Mockups need to be accessible via public URL for Shopify to download
  // They're in the Mockups catalog folder which nginx serves
  const filename = path.basename(mockupPath);

  // Check if it's in the catalog Mockups folder
  const catalogPath = path.join(CATALOG_DIR, 'Mockups', 'uploads', 'previews', filename);
  if (fs.existsSync(catalogPath)) {
    return encodeImageUrl(`${PUBLIC_BASE}/library/Mockups/uploads/previews/${filename}`);
  }

  // Copy it there if not
  const destDir = path.join(CATALOG_DIR, 'Mockups', 'uploads', 'previews');
  fs.mkdirSync(destDir, { recursive: true });
  const destFilename = `mockup-${filename}`;
  const destPath = path.join(destDir, destFilename);
  try {
    fs.copyFileSync(mockupPath, destPath);
    return encodeImageUrl(`${PUBLIC_BASE}/library/Mockups/uploads/previews/${destFilename}`);
  } catch (err) {
    console.warn(`[ShopifyApparel] Could not copy mockup to catalog: ${err.message}`);
    return null;
  }
}

// ============================================================================
// BATCH PUBLISH
// ============================================================================

async function publishBatch(options = {}) {
  const {
    category = '95 T Shirt Designs Mega Bundle',
    limit = 10,
    dryRun = false,
    delayMs = 3000
  } = options;

  console.log('=== Shopify Apparel Publisher ===');
  console.log(`Category: ${category}`);
  console.log(`Limit: ${limit}`);
  console.log(`Dry run: ${dryRun}`);
  console.log();

  // Load catalog
  const catalog = loadCatalog();
  const cat = catalog.categories.find(c =>
    c.name.toLowerCase().includes(category.toLowerCase())
  );
  if (!cat) {
    console.error(`Category not found: "${category}"`);
    return { success: 0, failed: 0 };
  }

  console.log(`Found ${cat.designs.length} designs in "${cat.name}"`);

  // Find/create Apparel collection
  let collectionId = null;
  if (!dryRun && shopify) {
    const collection = await findOrCreateCollection(COLLECTION_TITLE);
    collectionId = collection?.id;
    console.log(`Collection: ${COLLECTION_TITLE} (ID: ${collectionId || 'failed'})`);
  }

  const designs = cat.designs.slice(0, limit);
  let success = 0, failed = 0, skipped = 0;
  const results = [];

  for (let i = 0; i < designs.length; i++) {
    const design = designs[i];
    const cleanName = design.name
      .replace(/\s+\d{10,}$/g, '')  // strip trailing timestamp IDs
      .replace(/-/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());  // title case

    const title = `${cleanName} Graphic Tee - Custom Printed in Asheville`;

    // Find mockup
    const mockupPath = findMockupForDesign(design.id);
    if (!mockupPath) {
      console.log(`[${i + 1}/${designs.length}] SKIP "${cleanName}" — no mockup generated`);
      skipped++;
      continue;
    }

    // Get image URLs
    const designImageUrl = resolveDesignImageUrl(design);
    const mockupImageUrl = getMockupPublicUrl(mockupPath);

    // Find product blank mockups (white tee, black tee, hoodie, etc.)
    const productBlanks = findProductBlanksForDesign(design.id);
    const productBlankUrls = productBlanks.map(pb => {
      const url = getMockupPublicUrl(pb.path);
      return url ? { url, label: pb.label } : null;
    }).filter(Boolean);

    console.log(`[${i + 1}/${designs.length}] "${cleanName}"`);
    console.log(`  Lifestyle: ${mockupImageUrl ? 'YES' : 'NO'} | Product blanks: ${productBlankUrls.length} | Design: ${designImageUrl ? 'YES' : 'NO'}`);

    // Generate AI description
    const description = await generateProductDescription(cleanName, cat.name);
    const descriptionHtml = description.split('\n').filter(Boolean).map(p => `<p>${p}</p>`).join('\n');

    // Build tags
    const designTags = [...TAGS_BASE];
    cleanName.split(' ').forEach(word => {
      if (word.length > 3) designTags.push(word.toLowerCase());
    });

    if (dryRun) {
      console.log(`  [DRY RUN] Would create: "${title}"`);
      console.log(`  Images: 1 lifestyle + ${productBlankUrls.length} product blanks + 1 design = ${1 + productBlankUrls.length + 1} total`);
      console.log(`  Variants: ${SIZE_VARIANTS.map(v => `${v.size}=$${v.price}`).join(', ')}`);
      success++;
      results.push({ designId: design.id, title, dryRun: true });
    } else {
      try {
        const product = await publishProduct({
          title,
          descriptionHtml,
          designImageUrl,
          mockupImageUrl,
          productBlankUrls,
          tags: designTags,
          designId: design.id
        });

        if (product?.id) {
          console.log(`  ✓ Published: Shopify ID ${product.id}`);

          // Add to collection
          if (collectionId) {
            try {
              await shopify.addProductToCollection(product.id, collectionId);
              console.log(`  ✓ Added to "${COLLECTION_TITLE}" collection`);
            } catch (colErr) {
              console.warn(`  ⚠ Collection add failed: ${colErr.message}`);
            }
          }

          // Publish to all sales channels EXCEPT TikTok (100 product limit on TikTok Shop)
          // Marketing team manages TikTok rotation separately
          try {
            const pubs = await shopify.listPublications().catch(() => []);
            const nonTikTok = pubs.filter(p => !p.name?.toLowerCase().includes('tiktok'));
            if (nonTikTok.length) {
              await shopify.publishToPublications(product.id, nonTikTok.map(p => p.id));
              console.log(`  ✓ Published to ${nonTikTok.length} channels (TikTok excluded — managed by marketing team)`);
            }
          } catch (pubErr) {
            console.warn(`  ⚠ Channel publish warning: ${pubErr.message?.substring(0, 80)}`);
          }

          success++;
          results.push({ designId: design.id, title, shopifyId: product.id, handle: product.handle });
        } else {
          console.log(`  ✗ Failed: No product ID returned`);
          failed++;
        }
      } catch (err) {
        console.error('[ShopifyApparel] Raw error:', typeof err, err);
        const errMsg = typeof err === 'object' ? (err.message || JSON.stringify(err).substring(0, 300)) : String(err);
        console.log(`  ✗ Failed: ${errMsg.substring(0, 200)}`);
        failed++;
        results.push({ designId: design.id, title, error: errMsg });
      }
    }

    // Rate limit
    if (i < designs.length - 1) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  console.log(`\n=== COMPLETE ===`);
  console.log(`Published: ${success}/${designs.length}`);
  console.log(`Failed: ${failed}`);
  console.log(`Skipped (no mockup): ${skipped}`);

  // Save manifest
  const manifest = {
    category: cat.name,
    publishedAt: new Date().toISOString(),
    total: designs.length,
    success, failed, skipped,
    results
  };
  const manifestPath = path.join(MOCKUP_DIR, `shopify_publish_${Date.now()}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  return manifest;
}

// ============================================================================
// API HANDLER
// ============================================================================

async function handleShopifyApparelRoute(pathname, req, res, db) {
  const basePath = '/api/shopify-apparel';
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

  // POST /api/shopify-apparel/publish — publish designs to Shopify
  if (route === '/publish' && req.method === 'POST') {
    try {
      const chunks = [];
      await new Promise((resolve, reject) => {
        req.on('data', c => chunks.push(c));
        req.on('end', resolve);
        req.on('error', reject);
      });
      const body = JSON.parse(Buffer.concat(chunks).toString());

      const jobId = require('crypto').randomUUID();
      sendJson({ jobId, status: 'started', message: 'Publishing to Shopify in background' }, 202);

      publishBatch({
        category: body.category || '95 T Shirt Designs Mega Bundle',
        limit: body.limit || 10,
        dryRun: body.dryRun || false,
        delayMs: body.delayMs || 3000
      }).then(result => {
        console.log(`[ShopifyApparel] Job ${jobId} complete: ${result.success} published`);
      }).catch(err => {
        console.error(`[ShopifyApparel] Job ${jobId} failed:`, err.message);
      });

      return true;
    } catch (err) {
      sendJson({ error: err.message }, 500);
      return true;
    }
  }

  // GET /api/shopify-apparel/pricing — show current pricing config
  if (route === '/pricing' && req.method === 'GET') {
    sendJson({
      productType: PRODUCT_TYPE,
      vendor: VENDOR,
      baseCost: '3.99',
      variants: SIZE_VARIANTS,
      collection: COLLECTION_TITLE
    });
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

  publishBatch({
    category: getArg('--category') || '95 T Shirt Designs Mega Bundle',
    limit: parseInt(getArg('--limit') || '10'),
    dryRun: args.includes('--dry-run'),
    delayMs: parseInt(getArg('--delay') || '3000')
  }).then(() => process.exit(0)).catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}

module.exports = { publishBatch, handleShopifyApparelRoute };
