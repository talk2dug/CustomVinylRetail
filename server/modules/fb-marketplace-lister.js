/**
 * Facebook Marketplace Lister
 *
 * Creates locally-optimized Facebook page posts for products that are best
 * suited for local/marketplace selling (laser engraving, 3D prints, handmade items).
 *
 * Strategy:
 * - Posts to the FB page with marketplace-style formatting (price, local pickup, etc.)
 * - Uses Ollama (vision model if image available) to write authentic local-seller copy
 * - Rotates through products on a configurable schedule
 * - Tracks which products have been listed and when
 * - Targets the "laser-3d-handmade" product line from the sales team
 *
 * When FB Commerce API access is available, this module can be upgraded to
 * create actual Marketplace listings via the Commerce Manager API.
 *
 * Flow: GPU Bridge Ollama → Local Ollama fallback
 */

const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const ollamaClient = require('../lib/ollama-client');
const { tagUrl } = require('./utm-attribution');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(APP_ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'fb-marketplace-listings.json');

// Configuration
const COLLECTION_ID = process.env.FB_MARKETPLACE_COLLECTION_ID || '512424182048'; // Laser Engraving
const POSTS_PER_DAY = parseInt(process.env.FB_MARKETPLACE_POSTS_PER_DAY || '2', 10);
const ROTATION_DAYS = parseInt(process.env.FB_MARKETPLACE_ROTATION_DAYS || '14', 10);
const LISTING_INTERVAL_MS = 4 * 60 * 60 * 1000; // Check every 4 hours
const LOCATION = 'Asheville, NC';
const SHOP_URL = process.env.ASSET_BASE_URL || 'https://blueridgecustomco.com';

let _db = null;
let _timer = null;

// ============================================================================
// STATE PERSISTENCE
// ============================================================================

let state = {
  listings: [],         // { productId, title, postedAt, fbPostId, status }
  lastRun: null,
  postsToday: 0,
  todayDate: null,
  stats: {
    totalPosted: 0,
    totalEngagement: 0,
    lastPosted: null
  }
};

function loadState() {
  try {
    const tmpPath = DATA_FILE + '.tmp';
    if (fs.existsSync(tmpPath) && !fs.existsSync(DATA_FILE)) {
      fs.renameSync(tmpPath, DATA_FILE);
    }
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      state = { ...state, ...JSON.parse(raw) };
    }
  } catch (e) {
    console.error('[FBMarketplace] Error loading state:', e.message);
  }
}

function saveState() {
  try {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error('[FBMarketplace] Error saving state:', e.message);
  }
}

// ============================================================================
// DATABASE TABLES
// ============================================================================

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fb_marketplace_listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shopify_product_id TEXT NOT NULL,
      title TEXT NOT NULL,
      price TEXT,
      fb_post_id TEXT,
      post_text TEXT,
      image_url TEXT,
      status TEXT DEFAULT 'posted',
      engagement_json TEXT,
      posted_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_fbml_product ON fb_marketplace_listings(shopify_product_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_fbml_status ON fb_marketplace_listings(status)`);
}

// ============================================================================
// SHOPIFY PRODUCT FETCHER
// ============================================================================

async function fetchMarketplaceProducts() {
  const shop = process.env.SHOPIFY_SHOP || '';
  const token = process.env.SHOPIFY_ACCESS_TOKEN || '';
  const apiVersion = process.env.SHOPIFY_API_VERSION || '2024-10';

  if (!shop || !token) return [];

  const url = `https://${shop}/admin/api/${apiVersion}/products.json?limit=50&collection_id=${COLLECTION_ID}&fields=id,title,body_html,product_type,tags,variants,images,handle`;

  return new Promise((resolve) => {
    https.get(url, { headers: { 'X-Shopify-Access-Token': token } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.products || []);
        } catch {
          resolve([]);
        }
      });
    }).on('error', () => resolve([]));
  });
}

// ============================================================================
// LISTING CONTENT GENERATOR (Ollama)
// ============================================================================

async function generateListingContent(product) {
  const title = product.title || 'Handmade Item';
  const price = product.variants?.[0]?.price || '0';
  const productType = product.product_type || '';
  const description = (product.body_html || '').replace(/<[^>]+>/g, '').trim().slice(0, 300);
  const imageUrl = product.images?.[0]?.src || null;

  const systemPrompt = `You are writing a Facebook Marketplace-style listing for a locally made item in Asheville, NC.

Brand: Blue Ridge Custom Co
Location: Asheville, NC (local pickup available)
Selling point: Handmade/laser engraved/locally crafted in Asheville

Rules:
- Write like a real person selling on Marketplace, NOT like a corporate brand
- Lead with what the item IS and what makes it special
- Mention it's locally made in Asheville
- Include "Local pickup available in Asheville" naturally
- Keep it 3-5 sentences max
- Mention the price naturally (e.g., "Asking $25" or "Just $15")
- NO hashtags (this is marketplace, not social media)
- NO links or URLs
- Be warm and personal, like a neighbor selling something they made
- If it's a gift item, mention who it's perfect for

Return JSON only:
{"text": "Your marketplace listing text", "headline": "Short attention-grabbing headline (under 60 chars)"}`;

  const userPrompt = `Write a Facebook Marketplace listing for:

Item: ${title}
Type: ${productType}
Price: $${price}
Description: ${description || 'Laser engraved / handcrafted item'}

Return only valid JSON.`;

  // Try vision model if we have an image
  let responseText = null;
  if (imageUrl) {
    try {
      // Download and convert image for vision
      const imgBuffer = await downloadImage(imageUrl);
      if (imgBuffer) {
        const base64 = imgBuffer.toString('base64');
        responseText = await ollamaClient.vision(
          `${systemPrompt}\n\n${userPrompt}`,
          [base64],
          { temperature: 0.8, maxTokens: 300, timeout: 120000 }
        );
      }
    } catch (e) {
      console.warn(`[FBMarketplace] Vision failed for ${title}, using text-only:`, e.message);
    }
  }

  // Fallback: text-only
  if (!responseText) {
    try {
      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ];
      responseText = await ollamaClient.chat(messages, { temperature: 0.8, timeout: 60000 });
    } catch (e) {
      console.error(`[FBMarketplace] LLM failed for ${title}:`, e.message);
    }
  }

  // Parse response
  if (responseText) {
    try {
      const cleaned = responseText.replace(/^```json?\s*/i, '').replace(/```\s*$/i, '').trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);
        return {
          text: result.text || '',
          headline: result.headline || title
        };
      }
    } catch (e) {
      console.warn('[FBMarketplace] Could not parse LLM response, using template');
    }
  }

  // Fallback template
  return {
    text: `${title} — handcrafted right here in Asheville, NC. $${price}. This makes a great gift! Local pickup available in Asheville. Message me if interested.`,
    headline: title
  };
}

// ============================================================================
// IMAGE DOWNLOADER
// ============================================================================

function downloadImage(url) {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : require('http');
    client.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadImage(res.headers.location).then(resolve);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', () => resolve(null));
  });
}

// ============================================================================
// FACEBOOK POSTING
// ============================================================================

async function postToFacebook(imageUrl, text) {
  const pageToken = process.env.FB_PAGE_ACCESS_TOKEN;
  const pageId = process.env.FB_PAGE_ID;

  if (!pageToken || !pageId) {
    console.warn('[FBMarketplace] FB credentials not configured');
    return null;
  }

  // Download image
  const imageBuffer = await downloadImage(imageUrl);
  if (!imageBuffer || imageBuffer.length < 1000) {
    console.warn('[FBMarketplace] Failed to download image or image too small');
    return null;
  }

  const boundary = '----FormBoundary' + crypto.randomBytes(8).toString('hex');

  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="source"; filename="product.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="message"\r\n\r\n${text}\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="access_token"\r\n\r\n${pageToken}\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="published"\r\n\r\ntrue\r\n`,
    `--${boundary}--\r\n`
  ];

  const photoData = Buffer.concat([
    Buffer.from(parts[0]),
    imageBuffer,
    Buffer.from(parts[1]),
    Buffer.from(parts[2]),
    Buffer.from(parts[3]),
    Buffer.from(parts[4])
  ]);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'graph.facebook.com',
      path: `/v21.0/${pageId}/photos`,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': photoData.length
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.error) {
            reject(new Error(result.error.message));
          } else {
            resolve({ postId: result.post_id || result.id, id: result.id });
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('FB request timeout')); });
    req.setTimeout(30000);
    req.write(photoData);
    req.end();
  });
}

// Add shop link as first comment
async function addShopComment(postId, productHandle) {
  const pageToken = process.env.FB_PAGE_ACCESS_TOKEN;
  if (!pageToken || !postId) return;

  const rawShopUrl = `${SHOP_URL}/products/${productHandle}`;
  const shopUrl = tagUrl(rawShopUrl, {
    source: 'facebook',
    medium: 'marketplace',
    campaign: 'laser-3d-handmade',
    content: productHandle
  });
  const commentText = `🛒 Shop online: ${shopUrl}\n📍 Or pick up locally in Asheville, NC!`;

  const postData = JSON.stringify({
    message: commentText,
    access_token: pageToken
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'graph.facebook.com',
      path: `/v21.0/${postId}/comments`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', () => resolve(null));
    req.write(postData);
    req.end();
  });
}

// ============================================================================
// LISTING SCHEDULER
// ============================================================================

function getEligibleProducts(products) {
  const now = Date.now();
  const rotationMs = ROTATION_DAYS * 24 * 60 * 60 * 1000;

  return products.filter(p => {
    // Must have an image
    if (!p.images || p.images.length === 0) return false;

    // Check if recently listed
    const lastListing = state.listings.find(l => l.productId === String(p.id));
    if (lastListing) {
      const lastPosted = new Date(lastListing.postedAt).getTime();
      if (now - lastPosted < rotationMs) return false;
    }

    return true;
  });
}

async function runListingCycle() {
  const today = new Date().toISOString().slice(0, 10);

  // Reset daily counter
  if (state.todayDate !== today) {
    state.postsToday = 0;
    state.todayDate = today;
  }

  // Check daily limit
  if (state.postsToday >= POSTS_PER_DAY) {
    return { skipped: true, reason: `Daily limit reached (${POSTS_PER_DAY})` };
  }

  // Fetch products
  const products = await fetchMarketplaceProducts();
  if (products.length === 0) {
    console.log('[FBMarketplace] No products found in collection');
    return { skipped: true, reason: 'No products in collection' };
  }

  // Get eligible products (not recently listed)
  const eligible = getEligibleProducts(products);
  if (eligible.length === 0) {
    console.log('[FBMarketplace] All products recently listed, waiting for rotation');
    return { skipped: true, reason: 'All products in rotation cooldown' };
  }

  // Pick a random product (weighted toward ones listed least recently)
  const sorted = eligible.sort((a, b) => {
    const aListing = state.listings.find(l => l.productId === String(a.id));
    const bListing = state.listings.find(l => l.productId === String(b.id));
    const aTime = aListing ? new Date(aListing.postedAt).getTime() : 0;
    const bTime = bListing ? new Date(bListing.postedAt).getTime() : 0;
    return aTime - bTime; // Oldest first
  });

  const product = sorted[0];
  const imageUrl = product.images[0].src;
  const price = product.variants?.[0]?.price || '0';

  console.log(`[FBMarketplace] Generating listing for: ${product.title} ($${price})`);

  // Generate content
  const content = await generateListingContent(product);

  // Format the full post
  const fullText = `📍 ${LOCATION} | $${price}\n\n${content.text}`;

  // Post to Facebook
  let fbResult = null;
  try {
    fbResult = await postToFacebook(imageUrl, fullText);
    console.log(`[FBMarketplace] Posted: ${product.title} → FB post ${fbResult?.postId}`);

    // Add shop link comment
    if (fbResult?.postId && product.handle) {
      await addShopComment(fbResult.postId, product.handle);
    }
  } catch (e) {
    console.error(`[FBMarketplace] Failed to post ${product.title}:`, e.message);
  }

  // Record listing
  const listing = {
    productId: String(product.id),
    title: product.title,
    price,
    postedAt: new Date().toISOString(),
    fbPostId: fbResult?.postId || null,
    status: fbResult ? 'posted' : 'failed',
    headline: content.headline
  };

  // Update or add to listings array
  const existingIdx = state.listings.findIndex(l => l.productId === listing.productId);
  if (existingIdx >= 0) {
    state.listings[existingIdx] = listing;
  } else {
    state.listings.push(listing);
  }

  // Update stats
  state.postsToday++;
  state.stats.totalPosted++;
  state.stats.lastPosted = new Date().toISOString();
  state.lastRun = new Date().toISOString();

  // Record in DB
  if (_db && fbResult) {
    try {
      _db.prepare(`
        INSERT INTO fb_marketplace_listings (shopify_product_id, title, price, fb_post_id, post_text, image_url, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(String(product.id), product.title, price, fbResult.postId, fullText, imageUrl, 'posted');
    } catch (e) { /* ignore */ }
  }

  saveState();
  return { posted: true, product: product.title, fbPostId: fbResult?.postId };
}

// ============================================================================
// STATUS & API
// ============================================================================

function getStatus() {
  return {
    running: !!_timer,
    postsToday: state.postsToday,
    dailyLimit: POSTS_PER_DAY,
    rotationDays: ROTATION_DAYS,
    totalListings: state.listings.length,
    totalPosted: state.stats.totalPosted,
    lastPosted: state.stats.lastPosted,
    lastRun: state.lastRun,
    collectionId: COLLECTION_ID,
    location: LOCATION
  };
}

function getListings(limit = 20) {
  return state.listings
    .sort((a, b) => new Date(b.postedAt) - new Date(a.postedAt))
    .slice(0, limit);
}

function handleRoute(pathname, req, res) {
  const { sendJson, parseBody } = require('../utils/http');

  if (req.method === 'GET' && pathname === '/api/fb-marketplace/status') {
    sendJson(res, 200, getStatus());
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/fb-marketplace/listings') {
    sendJson(res, 200, { listings: getListings() });
    return true;
  }

  // Manual trigger: post one listing now
  if (req.method === 'POST' && pathname === '/api/fb-marketplace/post-now') {
    (async () => {
      try {
        const result = await runListingCycle();
        sendJson(res, 200, result);
      } catch (e) {
        sendJson(res, 500, { error: e.message });
      }
    })();
    return true;
  }

  // Post a specific product by Shopify product ID
  if (req.method === 'POST' && pathname === '/api/fb-marketplace/post-product') {
    (async () => {
      try {
        const body = await parseBody(req);
        const { productId } = body;
        if (!productId) {
          sendJson(res, 400, { error: 'productId required' });
          return;
        }

        const products = await fetchMarketplaceProducts();
        const product = products.find(p => String(p.id) === String(productId));
        if (!product) {
          sendJson(res, 404, { error: 'Product not found in marketplace collection' });
          return;
        }

        const imageUrl = product.images?.[0]?.src;
        if (!imageUrl) {
          sendJson(res, 400, { error: 'Product has no image' });
          return;
        }

        const content = await generateListingContent(product);
        const price = product.variants?.[0]?.price || '0';
        const fullText = `📍 ${LOCATION} | $${price}\n\n${content.text}`;

        const fbResult = await postToFacebook(imageUrl, fullText);
        if (fbResult?.postId && product.handle) {
          await addShopComment(fbResult.postId, product.handle);
        }

        sendJson(res, 200, { posted: true, product: product.title, fbPostId: fbResult?.postId });
      } catch (e) {
        sendJson(res, 500, { error: e.message });
      }
    })();
    return true;
  }

  return false;
}

// ============================================================================
// INIT
// ============================================================================

function init(db) {
  _db = db;
  loadState();
  ensureTables(_db);

  // Schedule listing cycles
  _timer = setInterval(() => {
    runListingCycle().catch(e => console.error('[FBMarketplace] Cycle error:', e.message));
  }, LISTING_INTERVAL_MS);

  if (_timer.unref) _timer.unref();

  // Run first cycle after 30s delay
  setTimeout(() => {
    runListingCycle().catch(e => console.error('[FBMarketplace] Initial cycle error:', e.message));
  }, 30000);

  console.log(`[FBMarketplace] Initialized (${POSTS_PER_DAY}/day, ${ROTATION_DAYS}d rotation, ${LOCATION})`);
}

module.exports = {
  init,
  getStatus,
  getListings,
  handleRoute,
  runListingCycle,
  generateListingContent,
  fetchMarketplaceProducts
};
