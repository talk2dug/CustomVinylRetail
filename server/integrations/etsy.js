/**
 * Etsy Open API v3 Integration
 *
 * Handles OAuth 2.0 authentication and product listing management for Etsy.
 * Uses PKCE (Proof Key for Code Exchange) as required by Etsy's API.
 *
 * API Docs: https://developers.etsy.com/documentation
 */

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Load environment
const ENV_PATH = path.resolve(__dirname, '..', '..', '.env');
if (fs.existsSync(ENV_PATH)) {
  require('dotenv').config({ path: ENV_PATH });
}

// Configuration
const API_KEY = process.env.ETSY_API_KEY || '';
const API_SECRET = process.env.ETSY_API_SECRET || '';
const REDIRECT_URI = process.env.ETSY_REDIRECT_URI || 'http://localhost:4000/oauth/etsy/callback';
const SHOP_ID = process.env.ETSY_SHOP_ID || '';

const BASE_URL = 'https://openapi.etsy.com/v3';
const AUTH_URL = 'https://www.etsy.com/oauth/connect';
const TOKEN_URL = 'https://api.etsy.com/v3/public/oauth/token';

// Token storage path
const DATA_DIR = path.resolve(__dirname, '..', '..', 'data');
const TOKEN_FILE = path.join(DATA_DIR, 'etsy-tokens.json');

// Rate limiting: Etsy allows 10 requests per second
const RATE_LIMIT_MS = 120; // ~8 req/sec to be safe
let lastCallTime = 0;

// Fee structure for price calculations
const ETSY_FEES = {
  listingFee: 0.20,           // $0.20 per listing
  transactionFee: 0.065,      // 6.5% of sale price
  paymentProcessing: 0.03,    // 3% payment processing
  paymentFixed: 0.25,         // $0.25 fixed payment fee
  regulatoryFee: 0.005,       // ~0.5% regulatory operating fee (US)
  // Offsite ads fee (12-15%) is optional and varies
};

/**
 * Calculate price with Etsy fees baked in
 * @param {number} basePrice - Your desired net price
 * @param {boolean} includeOffsiteAds - Include 15% offsite ads buffer
 * @returns {number} Price to list on Etsy
 */
function calculateEtsyPrice(basePrice, includeOffsiteAds = false) {
  // Total percentage fees
  let feePercent = ETSY_FEES.transactionFee + ETSY_FEES.paymentProcessing + ETSY_FEES.regulatoryFee;
  if (includeOffsiteAds) {
    feePercent += 0.15; // 15% offsite ads (worst case)
  }

  // Fixed fees per transaction
  const fixedFees = ETSY_FEES.listingFee + ETSY_FEES.paymentFixed;

  // Price = (basePrice + fixedFees) / (1 - feePercent)
  const etsyPrice = (basePrice + fixedFees) / (1 - feePercent);

  // Round to nearest $0.05
  return Math.ceil(etsyPrice * 20) / 20;
}

/**
 * Generate PKCE code verifier and challenge
 */
function generatePKCE() {
  // Generate random 32-byte code verifier
  const verifier = crypto.randomBytes(32)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  // Generate SHA256 challenge
  const challenge = crypto.createHash('sha256')
    .update(verifier)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  return { verifier, challenge };
}

/**
 * Generate state parameter for OAuth
 */
function generateState() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Check if Etsy is configured
 */
function isConfigured() {
  return Boolean(API_KEY && API_SECRET);
}

/**
 * Check if we have valid tokens
 */
function hasValidTokens() {
  const tokens = loadTokens();
  if (!tokens || !tokens.access_token) return false;

  // Check if token is expired (with 5 min buffer)
  if (tokens.expires_at && Date.now() > tokens.expires_at - 300000) {
    return false;
  }

  return true;
}

/**
 * Load stored tokens
 */
function loadTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[Etsy] Error loading tokens:', e.message);
  }
  return null;
}

/**
 * Save tokens to file
 */
function saveTokens(tokens) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });

    // Calculate expiration timestamp
    const data = {
      ...tokens,
      expires_at: Date.now() + (tokens.expires_in * 1000),
      saved_at: Date.now()
    };

    fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2));
    console.log('[Etsy] Tokens saved successfully');
    return true;
  } catch (e) {
    console.error('[Etsy] Error saving tokens:', e.message);
    return false;
  }
}

/**
 * Generate OAuth authorization URL
 * @param {string} state - State parameter for CSRF protection
 * @param {object} pkce - PKCE verifier and challenge
 * @returns {string} Authorization URL
 */
function getAuthorizationUrl(state, pkce) {
  const scopes = [
    'listings_r',      // Read listings
    'listings_w',      // Write listings
    'listings_d',      // Delete listings
    'shops_r',         // Read shop info
    'shops_w',         // Write shop info
    'profile_r',       // Read user profile
    'transactions_r',  // Read transactions
    'transactions_w',  // Write transactions
  ];

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: API_KEY,
    redirect_uri: REDIRECT_URI,
    scope: scopes.join(' '),
    state: state,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256'
  });

  return `${AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for tokens
 */
async function exchangeCodeForTokens(code, verifier) {
  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: API_KEY,
      redirect_uri: REDIRECT_URI,
      code: code,
      code_verifier: verifier
    }).toString();

    const options = {
      method: 'POST',
      hostname: 'api.etsy.com',
      path: '/v3/public/oauth/token',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        try {
          const data = JSON.parse(body);
          if (res.statusCode === 200) {
            saveTokens(data);
            resolve(data);
          } else {
            reject(new Error(data.error_description || data.error || `HTTP ${res.statusCode}`));
          }
        } catch (e) {
          reject(new Error(`Invalid response: ${body}`));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/**
 * Refresh access token using refresh token
 */
async function refreshAccessToken() {
  const tokens = loadTokens();
  if (!tokens || !tokens.refresh_token) {
    throw new Error('No refresh token available');
  }

  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: API_KEY,
      refresh_token: tokens.refresh_token
    }).toString();

    const options = {
      method: 'POST',
      hostname: 'api.etsy.com',
      path: '/v3/public/oauth/token',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        try {
          const data = JSON.parse(body);
          if (res.statusCode === 200) {
            saveTokens(data);
            resolve(data);
          } else {
            reject(new Error(data.error_description || data.error || `HTTP ${res.statusCode}`));
          }
        } catch (e) {
          reject(new Error(`Invalid response: ${body}`));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/**
 * Wait for rate limit
 */
async function waitForRateLimit() {
  const now = Date.now();
  const timeSinceLastCall = now - lastCallTime;
  const waitTime = Math.max(0, RATE_LIMIT_MS - timeSinceLastCall);

  if (waitTime > 0) {
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }

  lastCallTime = Date.now();
}

/**
 * Make authenticated API request
 */
async function apiRequest(method, endpoint, body = null) {
  await waitForRateLimit();

  // Check and refresh token if needed
  let tokens = loadTokens();
  if (!tokens || !tokens.access_token) {
    throw new Error('Not authenticated. Run OAuth flow first.');
  }

  // Refresh if expired
  if (tokens.expires_at && Date.now() > tokens.expires_at - 60000) {
    console.log('[Etsy] Token expired, refreshing...');
    tokens = await refreshAccessToken();
  }

  return new Promise((resolve, reject) => {
    const url = new URL(`${BASE_URL}${endpoint}`);

    const options = {
      method,
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        'Authorization': `Bearer ${tokens.access_token}`,
        'x-api-key': API_KEY,
        'Accept': 'application/json'
      }
    };

    if (body) {
      options.headers['Content-Type'] = 'application/json';
    }

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        try {
          const data = text ? JSON.parse(text) : {};
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            const err = new Error(data.error || `HTTP ${res.statusCode}`);
            err.status = res.statusCode;
            err.detail = data;
            reject(err);
          }
        } catch (e) {
          reject(new Error(`Invalid JSON response: ${text.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
}

/**
 * Get current user info (includes shop ID)
 */
async function getMe() {
  return apiRequest('GET', '/application/users/me');
}

/**
 * Get shop info
 */
async function getShop(shopId) {
  const id = shopId || SHOP_ID;
  if (!id) throw new Error('Shop ID required');
  return apiRequest('GET', `/application/shops/${id}`);
}

/**
 * List all shops for authenticated user
 */
async function getMyShops() {
  const me = await getMe();
  const userId = me.user_id;
  return apiRequest('GET', `/application/users/${userId}/shops`);
}

/**
 * Get shipping profiles for shop
 */
async function getShippingProfiles(shopId) {
  const id = shopId || SHOP_ID;
  if (!id) throw new Error('Shop ID required');
  return apiRequest('GET', `/application/shops/${id}/shipping-profiles`);
}

/**
 * Create a shipping profile
 */
async function createShippingProfile(shopId, profile) {
  const id = shopId || SHOP_ID;
  if (!id) throw new Error('Shop ID required');

  const data = {
    title: profile.title || 'Standard Shipping',
    origin_country_iso: profile.originCountry || 'US',
    primary_cost: profile.primaryCost || 4.99,
    secondary_cost: profile.secondaryCost || 1.00,
    min_processing_time: profile.minProcessingDays || 1,
    max_processing_time: profile.maxProcessingDays || 3,
  };

  return apiRequest('POST', `/application/shops/${id}/shipping-profiles`, data);
}

/**
 * Get taxonomy (categories)
 */
async function getTaxonomy() {
  // This endpoint doesn't require auth
  return apiRequest('GET', '/application/seller-taxonomy/nodes');
}

/**
 * Search taxonomy for a category
 */
async function findTaxonomyId(searchTerm) {
  const taxonomy = await getTaxonomy();
  const results = taxonomy.results || [];

  // Search for matching category
  const search = searchTerm.toLowerCase();

  function searchNode(node) {
    if (node.name && node.name.toLowerCase().includes(search)) {
      return node;
    }
    if (node.children) {
      for (const child of node.children) {
        const found = searchNode(child);
        if (found) return found;
      }
    }
    return null;
  }

  for (const node of results) {
    const found = searchNode(node);
    if (found) return found;
  }

  return null;
}

/**
 * Get listings for shop
 */
async function getListings(shopId, options = {}) {
  const id = shopId || SHOP_ID;
  if (!id) throw new Error('Shop ID required');

  const params = new URLSearchParams();
  if (options.limit) params.set('limit', options.limit);
  if (options.offset) params.set('offset', options.offset);
  if (options.state) params.set('state', options.state); // active, inactive, draft, expired

  const query = params.toString() ? `?${params.toString()}` : '';
  return apiRequest('GET', `/application/shops/${id}/listings${query}`);
}

/**
 * Get a single listing
 */
async function getListing(listingId) {
  return apiRequest('GET', `/application/listings/${listingId}`);
}

/**
 * Create a draft listing
 * @param {string} shopId - Shop ID
 * @param {object} listing - Listing data
 */
async function createListing(shopId, listing) {
  const id = shopId || SHOP_ID;
  if (!id) throw new Error('Shop ID required');

  // Required fields
  const data = {
    quantity: listing.quantity || 999,
    title: listing.title,
    description: listing.description,
    price: listing.price,
    who_made: listing.whoMade || 'i_did',
    when_made: listing.whenMade || 'made_to_order',
    taxonomy_id: listing.taxonomyId || 1, // Default to first category
    shipping_profile_id: listing.shippingProfileId,
  };

  // Optional fields
  if (listing.tags && listing.tags.length) {
    data.tags = listing.tags.slice(0, 13); // Max 13 tags
  }
  if (listing.materials && listing.materials.length) {
    data.materials = listing.materials.slice(0, 13); // Max 13 materials
  }
  if (listing.sku) {
    data.sku = listing.sku;
  }
  if (listing.personalizable !== undefined) {
    data.is_personalizable = listing.personalizable;
  }
  if (listing.personalizationRequired !== undefined) {
    data.personalization_is_required = listing.personalizationRequired;
  }
  if (listing.personalizationInstructions) {
    data.personalization_instructions = listing.personalizationInstructions;
  }

  return apiRequest('POST', `/application/shops/${id}/listings`, data);
}

/**
 * Update a listing
 */
async function updateListing(shopId, listingId, updates) {
  const id = shopId || SHOP_ID;
  if (!id) throw new Error('Shop ID required');

  return apiRequest('PATCH', `/application/shops/${id}/listings/${listingId}`, updates);
}

/**
 * Delete a listing
 */
async function deleteListing(shopId, listingId) {
  const id = shopId || SHOP_ID;
  if (!id) throw new Error('Shop ID required');

  return apiRequest('DELETE', `/application/shops/${id}/listings/${listingId}`);
}

/**
 * Upload image to listing
 */
async function uploadListingImage(shopId, listingId, imagePath, options = {}) {
  const id = shopId || SHOP_ID;
  if (!id) throw new Error('Shop ID required');

  await waitForRateLimit();

  const tokens = loadTokens();
  if (!tokens || !tokens.access_token) {
    throw new Error('Not authenticated');
  }

  // Read image file
  const imageBuffer = fs.readFileSync(imagePath);
  const fileName = path.basename(imagePath);
  const boundary = `----EtsyBoundary${Date.now()}`;

  // Build multipart form data
  let body = '';
  body += `--${boundary}\r\n`;
  body += `Content-Disposition: form-data; name="image"; filename="${fileName}"\r\n`;
  body += `Content-Type: image/${path.extname(fileName).slice(1) || 'png'}\r\n\r\n`;

  const bodyStart = Buffer.from(body, 'utf8');
  const bodyEnd = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const fullBody = Buffer.concat([bodyStart, imageBuffer, bodyEnd]);

  return new Promise((resolve, reject) => {
    const options = {
      method: 'POST',
      hostname: 'openapi.etsy.com',
      path: `/v3/application/shops/${id}/listings/${listingId}/images`,
      headers: {
        'Authorization': `Bearer ${tokens.access_token}`,
        'x-api-key': API_KEY,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': fullBody.length
      }
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        try {
          const data = text ? JSON.parse(text) : {};
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            const err = new Error(data.error || `HTTP ${res.statusCode}`);
            err.status = res.statusCode;
            err.detail = data;
            reject(err);
          }
        } catch (e) {
          reject(new Error(`Invalid response: ${text.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.write(fullBody);
    req.end();
  });
}

/**
 * Upload image from URL to listing
 */
async function uploadListingImageFromUrl(shopId, listingId, imageUrl) {
  const id = shopId || SHOP_ID;
  if (!id) throw new Error('Shop ID required');

  // Download image first
  const tempPath = path.join(require('os').tmpdir(), `etsy-upload-${Date.now()}.jpg`);

  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(tempPath);
    https.get(imageUrl, (res) => {
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(tempPath, () => {});
      reject(err);
    });
  });

  try {
    const result = await uploadListingImage(shopId, listingId, tempPath);
    fs.unlinkSync(tempPath);
    return result;
  } catch (err) {
    fs.unlinkSync(tempPath);
    throw err;
  }
}

/**
 * Publish a draft listing (make it active)
 */
async function publishListing(shopId, listingId) {
  return updateListing(shopId, listingId, { state: 'active' });
}

/**
 * Convert Shopify product to Etsy listing format
 */
function shopifyToEtsyListing(shopifyProduct, options = {}) {
  const {
    shippingProfileId,
    taxonomyId = 6648, // Default: Bumper Stickers & Decals
    priceMultiplier = 1.15, // 15% markup for Etsy fees
    includeOffsiteAds = false
  } = options;

  // Get base price from first variant
  const basePrice = parseFloat(shopifyProduct.variants?.[0]?.price || shopifyProduct.price || 0);
  const etsyPrice = includeOffsiteAds
    ? calculateEtsyPrice(basePrice, true)
    : basePrice * priceMultiplier;

  // Extract tags
  const tags = shopifyProduct.tags
    ? (typeof shopifyProduct.tags === 'string'
        ? shopifyProduct.tags.split(',').map(t => t.trim())
        : shopifyProduct.tags)
    : [];

  // Build description
  let description = shopifyProduct.body_html || shopifyProduct.description || '';
  // Strip HTML tags
  description = description.replace(/<[^>]*>/g, '');
  // Add standard footer
  description += '\n\n---\nProfessionally printed on premium outdoor vinyl. Weather-resistant and UV-protected for lasting durability.';

  return {
    title: shopifyProduct.title.slice(0, 140), // Etsy max 140 chars
    description: description.slice(0, 10000), // Etsy max 10000 chars
    price: etsyPrice.toFixed(2),
    quantity: 999,
    taxonomyId,
    shippingProfileId,
    whoMade: 'i_did',
    whenMade: 'made_to_order',
    tags: tags.slice(0, 13),
    materials: ['vinyl', 'adhesive vinyl', 'outdoor vinyl'],
    sku: shopifyProduct.variants?.[0]?.sku || `SHOP-${shopifyProduct.id}`,
    personalizable: false,
    // Store Shopify ID for reference
    _shopifyId: shopifyProduct.id,
    _shopifyHandle: shopifyProduct.handle
  };
}

/**
 * Sync a Shopify product to Etsy
 */
async function syncProductToEtsy(shopifyProduct, options = {}) {
  const shopId = options.shopId || SHOP_ID;
  if (!shopId) throw new Error('Shop ID required');

  console.log(`[Etsy] Syncing product: ${shopifyProduct.title}`);

  // Convert to Etsy format
  const etsyListing = shopifyToEtsyListing(shopifyProduct, options);

  // Create draft listing
  const listing = await createListing(shopId, etsyListing);
  console.log(`[Etsy] Created draft listing: ${listing.listing_id}`);

  // Upload images
  const images = shopifyProduct.images || [];
  for (let i = 0; i < Math.min(images.length, 10); i++) { // Etsy max 10 images
    const img = images[i];
    const imageUrl = img.src || img;
    try {
      await uploadListingImageFromUrl(shopId, listing.listing_id, imageUrl);
      console.log(`[Etsy] Uploaded image ${i + 1}/${images.length}`);
    } catch (err) {
      console.error(`[Etsy] Failed to upload image ${i + 1}:`, err.message);
    }
  }

  // Publish if requested
  if (options.publish) {
    await publishListing(shopId, listing.listing_id);
    console.log(`[Etsy] Published listing: ${listing.listing_id}`);
  }

  return listing;
}

// Store for OAuth state/verifier pairs
const oauthPending = new Map();

/**
 * Start OAuth flow - returns URL and stores state
 */
function startOAuthFlow() {
  const state = generateState();
  const pkce = generatePKCE();

  // Store for callback
  oauthPending.set(state, {
    verifier: pkce.verifier,
    created: Date.now()
  });

  // Clean up old entries (> 10 minutes)
  for (const [key, value] of oauthPending.entries()) {
    if (Date.now() - value.created > 600000) {
      oauthPending.delete(key);
    }
  }

  const url = getAuthorizationUrl(state, pkce);

  return { url, state };
}

/**
 * Complete OAuth flow - exchange code for tokens
 */
async function completeOAuthFlow(code, state) {
  const pending = oauthPending.get(state);
  if (!pending) {
    throw new Error('Invalid or expired state parameter');
  }

  oauthPending.delete(state);

  const tokens = await exchangeCodeForTokens(code, pending.verifier);

  // Get shop ID
  try {
    const shops = await getMyShops();
    if (shops.results && shops.results.length > 0) {
      const shopId = shops.results[0].shop_id;
      console.log(`[Etsy] Shop ID: ${shopId}`);
      // Note: User should add ETSY_SHOP_ID to .env
    }
  } catch (e) {
    console.log('[Etsy] Could not fetch shop info:', e.message);
  }

  return tokens;
}

module.exports = {
  // Configuration
  isConfigured,
  hasValidTokens,
  calculateEtsyPrice,
  ETSY_FEES,

  // OAuth
  startOAuthFlow,
  completeOAuthFlow,
  refreshAccessToken,
  loadTokens,

  // Shop operations
  getMe,
  getShop,
  getMyShops,
  getShippingProfiles,
  createShippingProfile,

  // Taxonomy
  getTaxonomy,
  findTaxonomyId,

  // Listings
  getListings,
  getListing,
  createListing,
  updateListing,
  deleteListing,
  publishListing,
  uploadListingImage,
  uploadListingImageFromUrl,

  // Sync helpers
  shopifyToEtsyListing,
  syncProductToEtsy
};
