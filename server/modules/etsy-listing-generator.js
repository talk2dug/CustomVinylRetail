/**
 * Etsy Listing Generator
 *
 * Generates Etsy-ready listing copy (title, description, tags) for products
 * using Ollama. Designed for manual copy-paste into Etsy since API access
 * was denied.
 *
 * Features:
 * - Fetches products from Shopify (any collection or all)
 * - Uses Ollama to generate SEO-optimized Etsy titles (140 char max)
 * - Generates Etsy descriptions with keyword-rich copy
 * - Produces 13 Etsy tags (max allowed) with search-focused keywords
 * - Stores generated listings in DB for easy retrieval
 * - Bulk generation for entire collections
 *
 * Exports: init(db), handleRoute(), generateListing(), getStatus()
 */

const ollamaClient = require('../lib/ollama-client');

const TAG = '[EtsyListingGen]';

let _db = null;

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS etsy_listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shopify_product_id TEXT NOT NULL,
      shopify_handle TEXT,
      original_title TEXT,
      etsy_title TEXT,
      etsy_description TEXT,
      etsy_tags TEXT,
      etsy_category TEXT,
      price REAL,
      image_urls TEXT,
      status TEXT DEFAULT 'draft',
      generated_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      listed_on_etsy INTEGER DEFAULT 0,
      notes TEXT
    )
  `);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_etsy_listings_product ON etsy_listings(shopify_product_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_etsy_listings_status ON etsy_listings(status)`);
}

// ---------------------------------------------------------------------------
// Shopify product fetcher (via internal API)
// ---------------------------------------------------------------------------

async function fetchCollectionProducts(collectionId, limit = 250) {
  const shopify = require('../integrations/shopify');
  if (collectionId) {
    return shopify.getCollectionProducts(collectionId, { limit });
  }
  return shopify.listAllProducts({ limit });
}

async function fetchProductFull(productId) {
  const shopify = require('../integrations/shopify');
  return shopify.getProductFull(productId);
}

// ---------------------------------------------------------------------------
// Generate Etsy listing copy using Ollama
// ---------------------------------------------------------------------------

async function generateListing(product) {
  const title = product.title || 'Untitled Product';
  const description = (product.body_html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const productType = product.product_type || '';
  const tags = product.tags || '';
  const vendor = product.vendor || 'Blue Ridge Custom Co';
  const price = product.variants?.[0]?.price || product.price || '0.00';

  const systemPrompt = `You are an Etsy SEO expert for Blue Ridge Custom Co, a small business in Asheville, NC that makes handmade and custom products. You specialize in writing high-converting Etsy listings.

CRITICAL Etsy rules:
- Title: Max 140 characters. Front-load the most searchable keywords. Use pipes | or commas to separate keyword phrases. No ALL CAPS.
- Description: 1-3 short paragraphs. Lead with what the item IS, then materials/process, then dimensions/details. Mention "handmade in Asheville, NC" or "made in North Carolina". Include care instructions if applicable. No markdown formatting — plain text only.
- Tags: Exactly 13 tags. Each tag max 20 characters. Use multi-word phrases that buyers search for. Mix broad and specific. No single generic words.
- Category suggestion: Suggest the best Etsy category path.

The shop sells: metal prints, custom vinyl decals, laser engraved wood items, 3D printed items, stickers, apparel, and Multiboard accessories.`;

  const userPrompt = `Generate an Etsy listing for this product:

Title: ${title}
Type: ${productType}
Current Description: ${description || 'None provided'}
Current Tags: ${tags || 'None'}
Price: $${price}
Vendor: ${vendor}

Respond in EXACTLY this format (no extra text):
ETSY_TITLE: [your title here]
ETSY_DESCRIPTION: [your description here]
ETSY_TAGS: [tag1, tag2, tag3, tag4, tag5, tag6, tag7, tag8, tag9, tag10, tag11, tag12, tag13]
ETSY_CATEGORY: [suggested category path]`;

  try {
    const result = await ollamaClient.chat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ], { temperature: 0.7, maxTokens: 800 });

    if (!result) return null;

    // Parse the structured response
    const parsed = parseListingResponse(result);
    if (!parsed) return null;

    // Store in DB
    const imageUrls = (product.images || []).map(img => img.src || img).filter(Boolean);

    _db.prepare(`
      INSERT OR REPLACE INTO etsy_listings
        (shopify_product_id, shopify_handle, original_title, etsy_title, etsy_description,
         etsy_tags, etsy_category, price, image_urls, status, generated_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', datetime('now'), datetime('now'))
    `).run(
      String(product.id),
      product.handle || null,
      title,
      parsed.title,
      parsed.description,
      parsed.tags,
      parsed.category || null,
      parseFloat(price),
      JSON.stringify(imageUrls)
    );

    console.log(TAG, `Generated listing for: ${title}`);

    return {
      shopifyProductId: String(product.id),
      originalTitle: title,
      etsyTitle: parsed.title,
      etsyDescription: parsed.description,
      etsyTags: parsed.tags,
      etsyCategory: parsed.category,
      price: parseFloat(price),
      imageUrls
    };
  } catch (e) {
    console.error(TAG, `Failed to generate listing for ${title}:`, e.message);
    return null;
  }
}

function parseListingResponse(text) {
  try {
    const titleMatch = text.match(/ETSY_TITLE:\s*(.+?)(?:\n|ETSY_DESCRIPTION)/s);
    const descMatch = text.match(/ETSY_DESCRIPTION:\s*(.+?)(?:\nETSY_TAGS)/s);
    const tagsMatch = text.match(/ETSY_TAGS:\s*(.+?)(?:\nETSY_CATEGORY|$)/s);
    const catMatch = text.match(/ETSY_CATEGORY:\s*(.+?)$/m);

    if (!titleMatch || !descMatch || !tagsMatch) return null;

    let title = titleMatch[1].trim();
    // Enforce 140 char limit
    if (title.length > 140) title = title.slice(0, 137) + '...';

    const description = descMatch[1].trim();

    // Parse tags — clean and limit to 13
    let tags = tagsMatch[1].trim();
    // Remove brackets if present
    tags = tags.replace(/^\[|\]$/g, '');
    let tagArray = tags.split(',').map(t => t.trim()).filter(Boolean);
    // Enforce 20 char limit per tag
    tagArray = tagArray.map(t => t.length > 20 ? t.slice(0, 20) : t);
    // Limit to 13 tags
    tagArray = tagArray.slice(0, 13);

    const category = catMatch ? catMatch[1].trim() : null;

    return {
      title,
      description,
      tags: tagArray.join(', '),
      category
    };
  } catch (e) {
    console.error(TAG, 'Failed to parse listing response:', e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Bulk generation
// ---------------------------------------------------------------------------

async function generateBulk(collectionId, options = {}) {
  const { skipExisting = true, limit = 50 } = options;

  const products = await fetchCollectionProducts(collectionId, limit);
  console.log(TAG, `Fetched ${products.length} products for bulk generation`);

  const results = { total: products.length, generated: 0, skipped: 0, failed: 0 };

  for (const product of products) {
    // Skip if already generated
    if (skipExisting) {
      const existing = _db.prepare('SELECT 1 FROM etsy_listings WHERE shopify_product_id = ?').get(String(product.id));
      if (existing) {
        results.skipped++;
        continue;
      }
    }

    // Fetch full product data if needed
    let fullProduct = product;
    if (!product.body_html && product.id) {
      try {
        fullProduct = await fetchProductFull(product.id);
      } catch (e) {
        fullProduct = product;
      }
    }

    const listing = await generateListing(fullProduct);
    if (listing) {
      results.generated++;
    } else {
      results.failed++;
    }

    // Small delay between API calls to be kind to Ollama
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log(TAG, `Bulk generation complete: ${results.generated} generated, ${results.skipped} skipped, ${results.failed} failed`);
  return results;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

function handleRoute(pathname, req, res) {
  const { parseBody } = require('../utils/http');

  // GET /api/etsy-listings/status
  if (pathname === '/api/etsy-listings/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getStatus()));
    return true;
  }

  // GET /api/etsy-listings — list all generated listings
  if (pathname === '/api/etsy-listings' && req.method === 'GET') {
    const parsed = new URL(req.url, 'http://localhost');
    const status = parsed.searchParams.get('status') || null;
    const limit = parseInt(parsed.searchParams.get('limit') || '100', 10);

    let query = 'SELECT * FROM etsy_listings';
    const params = [];
    if (status) {
      query += ' WHERE status = ?';
      params.push(status);
    }
    query += ' ORDER BY generated_at DESC LIMIT ?';
    params.push(limit);

    const listings = _db.prepare(query).all(...params);
    // Parse image_urls JSON for each
    for (const l of listings) {
      try { l.image_urls = JSON.parse(l.image_urls || '[]'); } catch { l.image_urls = []; }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ listings }));
    return true;
  }

  // GET /api/etsy-listings/:id — get single listing
  if (pathname.match(/^\/api\/etsy-listings\/\d+$/) && req.method === 'GET') {
    const id = pathname.split('/').pop();
    const listing = _db.prepare('SELECT * FROM etsy_listings WHERE id = ?').get(id);
    if (!listing) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Listing not found' }));
      return true;
    }
    try { listing.image_urls = JSON.parse(listing.image_urls || '[]'); } catch { listing.image_urls = []; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(listing));
    return true;
  }

  // POST /api/etsy-listings/generate — generate for single product
  if (pathname === '/api/etsy-listings/generate' && req.method === 'POST') {
    (async () => {
      try {
        const body = await parseBody(req);
        const { productId, collectionId } = body;

        if (productId) {
          const product = await fetchProductFull(productId);
          if (!product) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Product not found' }));
            return;
          }
          const listing = await generateListing(product);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ listing }));
        } else if (collectionId) {
          // Bulk generate for a collection
          const results = await generateBulk(collectionId, body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(results));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'productId or collectionId required' }));
        }
      } catch (e) {
        console.error(TAG, 'Generate error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    })();
    return true;
  }

  // POST /api/etsy-listings/regenerate/:id — regenerate a single listing
  if (pathname.match(/^\/api\/etsy-listings\/regenerate\/\d+$/) && req.method === 'POST') {
    (async () => {
      try {
        const id = pathname.split('/').pop();
        const existing = _db.prepare('SELECT * FROM etsy_listings WHERE id = ?').get(id);
        if (!existing) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Listing not found' }));
          return;
        }
        const product = await fetchProductFull(existing.shopify_product_id);
        const listing = await generateListing(product);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ listing }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    })();
    return true;
  }

  // PUT /api/etsy-listings/:id — update listing (mark as listed, edit, etc.)
  if (pathname.match(/^\/api\/etsy-listings\/\d+$/) && req.method === 'PUT') {
    (async () => {
      try {
        const id = pathname.split('/').pop();
        const body = await parseBody(req);

        const fields = [];
        const values = [];
        if (body.etsy_title !== undefined) { fields.push('etsy_title = ?'); values.push(body.etsy_title); }
        if (body.etsy_description !== undefined) { fields.push('etsy_description = ?'); values.push(body.etsy_description); }
        if (body.etsy_tags !== undefined) { fields.push('etsy_tags = ?'); values.push(body.etsy_tags); }
        if (body.status !== undefined) { fields.push('status = ?'); values.push(body.status); }
        if (body.listed_on_etsy !== undefined) { fields.push('listed_on_etsy = ?'); values.push(body.listed_on_etsy ? 1 : 0); }
        if (body.notes !== undefined) { fields.push('notes = ?'); values.push(body.notes); }

        if (fields.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No fields to update' }));
          return;
        }

        fields.push('updated_at = datetime(\'now\')');
        values.push(id);

        _db.prepare(`UPDATE etsy_listings SET ${fields.join(', ')} WHERE id = ?`).run(...values);

        const updated = _db.prepare('SELECT * FROM etsy_listings WHERE id = ?').get(id);
        try { updated.image_urls = JSON.parse(updated.image_urls || '[]'); } catch { updated.image_urls = []; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(updated));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    })();
    return true;
  }

  return false;
}

function getStatus() {
  if (!_db) return { running: false };
  const total = _db.prepare('SELECT COUNT(*) AS c FROM etsy_listings').get().c;
  const drafts = _db.prepare("SELECT COUNT(*) AS c FROM etsy_listings WHERE status = 'draft'").get().c;
  const listed = _db.prepare('SELECT COUNT(*) AS c FROM etsy_listings WHERE listed_on_etsy = 1').get().c;
  return { running: true, totalListings: total, drafts, listed };
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function init(db) {
  _db = db;
  ensureTables(db);
  console.log(TAG, 'Initialized');
}

module.exports = {
  init,
  handleRoute,
  getStatus,
  generateListing,
  generateBulk
};
