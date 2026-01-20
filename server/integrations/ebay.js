/**
 * eBay API Integration
 *
 * Handles OAuth 2.0 authentication and product listing management for eBay.
 * Uses the eBay RESTful APIs (Inventory, Browse, Fulfillment).
 *
 * API Docs: https://developer.ebay.com/docs
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
const CLIENT_ID = process.env.EBAY_CLIENT_ID || '';
const CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET || '';
const DEV_ID = process.env.EBAY_DEV_ID || '';
const REDIRECT_URI = process.env.EBAY_REDIRECT_URI || '';
const ENVIRONMENT = process.env.EBAY_ENVIRONMENT || 'sandbox'; // 'sandbox' or 'production'

// API URLs based on environment
const API_URLS = {
  sandbox: {
    auth: 'https://auth.sandbox.ebay.com',
    api: 'https://api.sandbox.ebay.com'
  },
  production: {
    auth: 'https://auth.ebay.com',
    api: 'https://api.ebay.com'
  }
};

const getAuthUrl = () => API_URLS[ENVIRONMENT]?.auth || API_URLS.sandbox.auth;
const getApiUrl = () => API_URLS[ENVIRONMENT]?.api || API_URLS.sandbox.api;

// Token storage path
const DATA_DIR = path.resolve(__dirname, '..', '..', 'data');
const TOKEN_FILE = path.join(DATA_DIR, 'ebay-tokens.json');

// Rate limiting: eBay has various limits, we'll be conservative
const RATE_LIMIT_MS = 200; // 5 req/sec
let lastCallTime = 0;

// eBay Fee structure (Basic Store level)
const EBAY_FEES = {
  // Final Value Fees vary by category - using Crafts category rates
  finalValueFee: 0.1325,      // 13.25% (no store) - adjust based on store level
  finalValueFeeBasic: 0.117,  // 11.7% (Basic store)
  finalValueFeePremium: 0.109, // 10.9% (Premium store)
  insertionFee: 0.35,         // $0.35 per listing after free allowance
  internationalFee: 0.0165,   // 1.65% additional for international
  // Payment processing is included in final value fee
};

// Store subscription costs
const EBAY_STORE_COSTS = {
  none: { monthly: 0, freeListings: 250, fvf: 0.1325 },
  starter: { monthly: 4.95, freeListings: 250, fvf: 0.1255 },
  basic: { monthly: 21.95, freeListings: 1000, fvf: 0.117 },
  premium: { monthly: 59.95, freeListings: 10000, fvf: 0.109 },
  anchor: { monthly: 299.95, freeListings: 25000, fvf: 0.099 }
};

/**
 * Calculate price with eBay fees baked in
 * @param {number} basePrice - Your desired net price
 * @param {string} storeLevel - Store subscription level
 * @returns {number} Price to list on eBay
 */
function calculateEbayPrice(basePrice, storeLevel = 'basic') {
  const store = EBAY_STORE_COSTS[storeLevel] || EBAY_STORE_COSTS.basic;
  const feePercent = store.fvf;

  // Price = basePrice / (1 - feePercent)
  const ebayPrice = basePrice / (1 - feePercent);

  // Round to nearest $0.05
  return Math.ceil(ebayPrice * 20) / 20;
}

/**
 * Generate state parameter for OAuth
 */
function generateState() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Check if eBay is configured
 */
function isConfigured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
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
    console.error('[eBay] Error loading tokens:', e.message);
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
    console.log('[eBay] Tokens saved successfully');
    return true;
  } catch (e) {
    console.error('[eBay] Error saving tokens:', e.message);
    return false;
  }
}

/**
 * Generate OAuth authorization URL
 * @param {string} state - State parameter for CSRF protection
 * @returns {string} Authorization URL
 */
function getAuthorizationUrl(state) {
  const scopes = [
    'https://api.ebay.com/oauth/api_scope',
    'https://api.ebay.com/oauth/api_scope/sell.inventory',
    'https://api.ebay.com/oauth/api_scope/sell.inventory.readonly',
    'https://api.ebay.com/oauth/api_scope/sell.marketing',
    'https://api.ebay.com/oauth/api_scope/sell.account',
    'https://api.ebay.com/oauth/api_scope/sell.account.readonly',
    'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
    'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
  ];

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: scopes.join(' '),
    state: state
  });

  return `${getAuthUrl()}/oauth2/authorize?${params.toString()}`;
}

/**
 * Get basic authorization header (for token requests)
 */
function getBasicAuthHeader() {
  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  return `Basic ${credentials}`;
}

/**
 * Exchange authorization code for tokens
 */
async function exchangeCodeForTokens(code) {
  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: REDIRECT_URI
    }).toString();

    const url = new URL(`${getApiUrl()}/identity/v1/oauth2/token`);

    const options = {
      method: 'POST',
      hostname: url.hostname,
      path: url.pathname,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': getBasicAuthHeader(),
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
      refresh_token: tokens.refresh_token
    }).toString();

    const url = new URL(`${getApiUrl()}/identity/v1/oauth2/token`);

    const options = {
      method: 'POST',
      hostname: url.hostname,
      path: url.pathname,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': getBasicAuthHeader(),
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
            // Preserve refresh token if not returned
            if (!data.refresh_token && tokens.refresh_token) {
              data.refresh_token = tokens.refresh_token;
            }
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
async function apiRequest(method, endpoint, body = null, apiVersion = 'v1') {
  await waitForRateLimit();

  // Check and refresh token if needed
  let tokens = loadTokens();
  if (!tokens || !tokens.access_token) {
    throw new Error('Not authenticated. Run OAuth flow first.');
  }

  // Refresh if expired
  if (tokens.expires_at && Date.now() > tokens.expires_at - 60000) {
    console.log('[eBay] Token expired, refreshing...');
    tokens = await refreshAccessToken();
  }

  return new Promise((resolve, reject) => {
    const baseUrl = getApiUrl();
    const url = new URL(`${baseUrl}${endpoint}`);

    const options = {
      method,
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        'Authorization': `Bearer ${tokens.access_token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Language': 'en-US',
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US'
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
            const err = new Error(data.errors?.[0]?.message || data.error || `HTTP ${res.statusCode}`);
            err.status = res.statusCode;
            err.detail = data;
            reject(err);
          }
        } catch (e) {
          // Some endpoints return empty response on success
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ success: true });
          } else {
            reject(new Error(`Invalid JSON response: ${text.slice(0, 200)}`));
          }
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

// ===========================================
// Inventory API
// ===========================================

/**
 * Get inventory item by SKU
 */
async function getInventoryItem(sku) {
  return apiRequest('GET', `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`);
}

/**
 * Create or update inventory item
 */
async function createOrUpdateInventoryItem(sku, item) {
  const data = {
    availability: {
      shipToLocationAvailability: {
        quantity: item.quantity || 999
      }
    },
    condition: item.condition || 'NEW',
    product: {
      title: item.title,
      description: item.description || 'Premium vinyl decal/sticker',
      imageUrls: item.imageUrls || []
    }
  };

  // Only add aspects if provided and non-empty
  if (item.aspects && Object.keys(item.aspects).length > 0) {
    data.product.aspects = item.aspects;
  }

  if (item.brand) {
    data.product.aspects = data.product.aspects || {};
    data.product.aspects.Brand = [item.brand];
  }

  console.log('[eBay] Creating inventory item:', sku, JSON.stringify(data, null, 2));

  return apiRequest('PUT', `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, data);
}

/**
 * Delete inventory item
 */
async function deleteInventoryItem(sku) {
  return apiRequest('DELETE', `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`);
}

/**
 * Get all inventory items
 */
async function getInventoryItems(options = {}) {
  const params = new URLSearchParams();
  if (options.limit) params.set('limit', options.limit);
  if (options.offset) params.set('offset', options.offset);

  const query = params.toString() ? `?${params.toString()}` : '';
  return apiRequest('GET', `/sell/inventory/v1/inventory_item${query}`);
}

// ===========================================
// Offer API (links inventory to listings)
// ===========================================

/**
 * Create an offer for an inventory item
 */
async function createOffer(sku, offer) {
  const listingPolicies = {
    fulfillmentPolicyId: offer.fulfillmentPolicyId,
    returnPolicyId: offer.returnPolicyId
  };

  // Only add paymentPolicyId if provided (not needed for eBay Managed Payments)
  if (offer.paymentPolicyId) {
    listingPolicies.paymentPolicyId = offer.paymentPolicyId;
  }

  const data = {
    sku: sku,
    marketplaceId: 'EBAY_US',
    format: offer.format || 'FIXED_PRICE',
    listingDescription: offer.description,
    availableQuantity: offer.quantity || 999,
    categoryId: offer.categoryId, // eBay category ID
    listingPolicies,
    pricingSummary: {
      price: {
        currency: 'USD',
        value: String(offer.price)
      }
    }
  };

  // Only add merchantLocationKey if provided
  if (offer.locationKey) {
    data.merchantLocationKey = offer.locationKey;
  }

  console.log('[eBay] Creating offer:', JSON.stringify(data, null, 2));

  return apiRequest('POST', '/sell/inventory/v1/offer', data);
}

/**
 * Get offers for a SKU
 */
async function getOffers(sku) {
  return apiRequest('GET', `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}`);
}

/**
 * Publish an offer (make it live)
 */
async function publishOffer(offerId) {
  return apiRequest('POST', `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`);
}

/**
 * Update an offer
 */
async function updateOffer(offerId, updates) {
  return apiRequest('PUT', `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, updates);
}

/**
 * Delete an offer
 */
async function deleteOffer(offerId) {
  return apiRequest('DELETE', `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`);
}

// ===========================================
// Account API (policies)
// ===========================================

/**
 * Get fulfillment policies
 */
async function getFulfillmentPolicies() {
  return apiRequest('GET', '/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_US');
}

/**
 * Get payment policies
 */
async function getPaymentPolicies() {
  return apiRequest('GET', '/sell/account/v1/payment_policy?marketplace_id=EBAY_US');
}

/**
 * Get return policies
 */
async function getReturnPolicies() {
  return apiRequest('GET', '/sell/account/v1/return_policy?marketplace_id=EBAY_US');
}

/**
 * Create a fulfillment policy
 */
async function createFulfillmentPolicy(policy) {
  const data = {
    name: policy.name || 'Standard Shipping',
    marketplaceId: 'EBAY_US',
    categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }],
    handlingTime: {
      unit: 'DAY',
      value: policy.handlingDays || 1
    },
    shippingOptions: [{
      costType: 'FLAT_RATE',
      optionType: 'DOMESTIC',
      shippingServices: [{
        shippingCarrierCode: 'USPS',
        shippingServiceCode: 'USPSFirstClass',
        shippingCost: {
          currency: 'USD',
          value: String(policy.shippingCost || 4.99)
        },
        additionalShippingCost: {
          currency: 'USD',
          value: String(policy.additionalCost || 1.00)
        },
        freeShipping: policy.freeShipping || false
      }]
    }]
  };

  return apiRequest('POST', '/sell/account/v1/fulfillment_policy', data);
}

/**
 * Create a return policy
 */
async function createReturnPolicy(policy) {
  const data = {
    name: policy.name || '30 Day Returns',
    marketplaceId: 'EBAY_US',
    categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }],
    returnsAccepted: policy.returnsAccepted !== false,
    returnPeriod: {
      unit: 'DAY',
      value: policy.returnDays || 30
    },
    refundMethod: 'MONEY_BACK',
    returnShippingCostPayer: policy.sellerPaysReturn ? 'SELLER' : 'BUYER'
  };

  return apiRequest('POST', '/sell/account/v1/return_policy', data);
}

// ===========================================
// Merchant Location API
// ===========================================

/**
 * Create a merchant location (required for publishing offers)
 */
async function createMerchantLocation(locationKey, location) {
  const data = {
    location: {
      address: {
        city: location.city || 'Asheville',
        stateOrProvince: location.state || 'NC',
        postalCode: location.postalCode || '28801',
        country: location.country || 'US'
      }
    },
    locationTypes: ['WAREHOUSE'],
    name: location.name || 'Primary Location',
    merchantLocationStatus: 'ENABLED'
  };

  // Only add addressLine1 if provided (not always required for warehouse)
  if (location.addressLine1) {
    data.location.address.addressLine1 = location.addressLine1;
  }

  console.log('[eBay] Creating merchant location:', locationKey, JSON.stringify(data, null, 2));

  return apiRequest('POST', `/sell/inventory/v1/location/${encodeURIComponent(locationKey)}`, data);
}

/**
 * Get a merchant location by key
 */
async function getMerchantLocation(locationKey) {
  return apiRequest('GET', `/sell/inventory/v1/location/${encodeURIComponent(locationKey)}`);
}

/**
 * Get all merchant locations
 */
async function getMerchantLocations() {
  return apiRequest('GET', '/sell/inventory/v1/location');
}

/**
 * Delete a merchant location
 */
async function deleteMerchantLocation(locationKey) {
  return apiRequest('DELETE', `/sell/inventory/v1/location/${encodeURIComponent(locationKey)}`);
}

// ===========================================
// Taxonomy API (categories)
// ===========================================

/**
 * Get category tree
 */
async function getCategoryTree() {
  return apiRequest('GET', '/commerce/taxonomy/v1/category_tree/0'); // 0 = eBay US
}

/**
 * Search for category by keyword
 */
async function searchCategories(query) {
  return apiRequest('GET', `/commerce/taxonomy/v1/category_tree/0/get_category_suggestions?q=${encodeURIComponent(query)}`);
}

// ===========================================
// Helper Functions
// ===========================================

/**
 * Convert Shopify product to eBay inventory item format
 */
function shopifyToEbayItem(shopifyProduct, options = {}) {
  const {
    priceMultiplier = 1.13,
    storeLevel = 'basic',
    categoryId = '180098' // Stickers & Decals default
  } = options;

  // Get base price from first variant
  const basePrice = parseFloat(shopifyProduct.variants?.[0]?.price || shopifyProduct.price || 0);
  const ebayPrice = options.calculateFees
    ? calculateEbayPrice(basePrice, storeLevel)
    : basePrice * priceMultiplier;

  // Get images
  const imageUrls = (shopifyProduct.images || [])
    .slice(0, 12) // eBay max 12 images
    .map(img => img.src || img);

  // Build description with logo header
  const productDesc = shopifyProduct.body_html || shopifyProduct.description || '';
  // Keep HTML for eBay (they support it) - add branded template
  const description = `
<div style="text-align: center; margin-bottom: 20px;">
  <img src="https://blueridgecustomco.com/images/BlueRidgeCustomCoLogo.png" alt="Blue Ridge Custom Co" style="max-width: 250px; height: auto;">
</div>
<h2 style="text-align: center; color: #333;">${shopifyProduct.title}</h2>
${productDesc}
<br><br>
<hr style="border: 1px solid #ddd;">
<h3>Product Details:</h3>
<ul>
  <li>Professionally printed on premium materials</li>
  <li>Weather-resistant and UV-protected</li>
  <li>Vibrant, fade-resistant colors</li>
  <li>Ships from Asheville, NC</li>
</ul>
<hr style="border: 1px solid #ddd;">
<p style="text-align: center; color: #666;"><strong>Blue Ridge Custom Co</strong> - Quality Custom Products from the Mountains of North Carolina</p>
`;

  // Generate SKU - always use Shopify product ID to ensure uniqueness
  const variantSku = shopifyProduct.variants?.[0]?.sku;
  const sku = variantSku && variantSku.length > 3
    ? `${variantSku}-${shopifyProduct.id}`
    : `SHOP-${shopifyProduct.id}`;

  return {
    sku,
    title: shopifyProduct.title.slice(0, 80), // eBay max 80 chars
    description,
    price: ebayPrice.toFixed(2),
    quantity: 999,
    categoryId,
    condition: 'NEW',
    imageUrls,
    // Aspects commented out for now - may need category-specific aspects
    // aspects: {
    //   'Type': ['Decal/Sticker'],
    //   'Material': ['Vinyl'],
    //   'Indoor/Outdoor': ['Outdoor'],
    //   'Theme': extractThemes(shopifyProduct.tags)
    // },
    // Store Shopify reference
    _shopifyId: shopifyProduct.id,
    _shopifyHandle: shopifyProduct.handle
  };
}

/**
 * Extract themes from Shopify tags
 */
function extractThemes(tags) {
  if (!tags) return ['General'];

  const tagList = typeof tags === 'string'
    ? tags.split(',').map(t => t.trim())
    : tags;

  // Common theme mappings
  const themeMap = {
    'tribal': 'Tribal',
    'flame': 'Flames',
    'skull': 'Skulls',
    'dragon': 'Dragons',
    'racing': 'Racing',
    'automotive': 'Automotive',
    'animal': 'Animals',
    'nature': 'Nature',
    'sports': 'Sports'
  };

  const themes = [];
  for (const tag of tagList) {
    const lower = tag.toLowerCase();
    for (const [key, value] of Object.entries(themeMap)) {
      if (lower.includes(key) && !themes.includes(value)) {
        themes.push(value);
      }
    }
  }

  return themes.length > 0 ? themes : ['General'];
}

/**
 * Sync a Shopify product to eBay
 */
async function syncProductToEbay(shopifyProduct, options = {}) {
  console.log(`[eBay] Syncing product: ${shopifyProduct.title}`);

  // Convert to eBay format
  const ebayItem = shopifyToEbayItem(shopifyProduct, options);

  // Create/update inventory item
  await createOrUpdateInventoryItem(ebayItem.sku, ebayItem);
  console.log(`[eBay] Created/updated inventory item: ${ebayItem.sku}`);

  // Get policies (need these for offer)
  let fulfillmentPolicyId = options.fulfillmentPolicyId;
  let paymentPolicyId = options.paymentPolicyId;
  let returnPolicyId = options.returnPolicyId;

  if (!fulfillmentPolicyId || !paymentPolicyId || !returnPolicyId) {
    // Try to get existing policies
    try {
      const [fulfillment, payment, returns] = await Promise.all([
        getFulfillmentPolicies(),
        getPaymentPolicies(),
        getReturnPolicies()
      ]);

      fulfillmentPolicyId = fulfillmentPolicyId || fulfillment.fulfillmentPolicies?.[0]?.fulfillmentPolicyId;
      paymentPolicyId = paymentPolicyId || payment.paymentPolicies?.[0]?.paymentPolicyId;
      returnPolicyId = returnPolicyId || returns.returnPolicies?.[0]?.returnPolicyId;
    } catch (e) {
      console.error('[eBay] Error fetching policies:', e.message);
    }
  }

  if (!fulfillmentPolicyId || !paymentPolicyId || !returnPolicyId) {
    console.warn('[eBay] Missing policies - inventory item created but offer not created');
    return { sku: ebayItem.sku, status: 'inventory_only' };
  }

  // Create offer
  const offer = await createOffer(ebayItem.sku, {
    description: ebayItem.description,
    price: ebayItem.price,
    quantity: ebayItem.quantity,
    categoryId: ebayItem.categoryId,
    fulfillmentPolicyId,
    paymentPolicyId,
    returnPolicyId
  });

  console.log(`[eBay] Created offer: ${offer.offerId}`);

  // Publish if requested
  if (options.publish) {
    const published = await publishOffer(offer.offerId);
    console.log(`[eBay] Published listing: ${published.listingId}`);
    return {
      sku: ebayItem.sku,
      offerId: offer.offerId,
      listingId: published.listingId,
      status: 'published'
    };
  }

  return {
    sku: ebayItem.sku,
    offerId: offer.offerId,
    status: 'draft'
  };
}

// Store for OAuth state
const oauthPending = new Map();

/**
 * Start OAuth flow - returns URL and stores state
 */
function startOAuthFlow() {
  const state = generateState();

  // Store for callback
  oauthPending.set(state, {
    created: Date.now()
  });

  // Clean up old entries (> 10 minutes)
  for (const [key, value] of oauthPending.entries()) {
    if (Date.now() - value.created > 600000) {
      oauthPending.delete(key);
    }
  }

  const url = getAuthorizationUrl(state);

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

  const tokens = await exchangeCodeForTokens(code);
  return tokens;
}

module.exports = {
  // Configuration
  isConfigured,
  hasValidTokens,
  calculateEbayPrice,
  EBAY_FEES,
  EBAY_STORE_COSTS,

  // OAuth
  startOAuthFlow,
  completeOAuthFlow,
  refreshAccessToken,
  loadTokens,

  // Inventory API
  getInventoryItem,
  getInventoryItems,
  createOrUpdateInventoryItem,
  deleteInventoryItem,

  // Offer API
  createOffer,
  getOffers,
  publishOffer,
  updateOffer,
  deleteOffer,

  // Account/Policies API
  getFulfillmentPolicies,
  getPaymentPolicies,
  getReturnPolicies,
  createFulfillmentPolicy,
  createReturnPolicy,

  // Merchant Location API
  createMerchantLocation,
  getMerchantLocation,
  getMerchantLocations,
  deleteMerchantLocation,

  // Taxonomy
  getCategoryTree,
  searchCategories,

  // Sync helpers
  shopifyToEbayItem,
  syncProductToEbay
};
