/**
 * Amazon Selling Partner API (SP-API) Integration
 *
 * Handles authentication and product listing management for Amazon.
 * Uses Login with Amazon (LWA) for OAuth and AWS Signature v4 for API requests.
 *
 * API Docs: https://developer-docs.amazon.com/sp-api
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
const LWA_CLIENT_ID = process.env.AMAZON_LWA_CLIENT_ID || '';
const LWA_CLIENT_SECRET = process.env.AMAZON_LWA_CLIENT_SECRET || '';
const REFRESH_TOKEN = process.env.AMAZON_REFRESH_TOKEN || '';
const SELLER_ID = process.env.AMAZON_SELLER_ID || '';
const MARKETPLACE_ID = process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER'; // US marketplace
const AWS_ACCESS_KEY = process.env.AWS_ACCESS_KEY_ID || '';
const AWS_SECRET_KEY = process.env.AWS_SECRET_ACCESS_KEY || '';
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

// Amazon SP-API endpoints
const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';
const SP_API_ENDPOINT = `https://sellingpartnerapi-na.amazon.com`;

// Token storage path
const DATA_DIR = path.resolve(__dirname, '..', '..', 'data');
const TOKEN_FILE = path.join(DATA_DIR, 'amazon-tokens.json');

// Rate limiting
const RATE_LIMIT_MS = 500; // Conservative rate limit
let lastCallTime = 0;

// Amazon Fee structure
const AMAZON_FEES = {
  // Referral fees by category
  referralFees: {
    'automotive': 0.12,          // 12% for automotive parts/accessories
    'electronics': 0.08,         // 8% for consumer electronics
    'home_garden': 0.15,         // 15% for home & garden
    'clothing': 0.17,            // 17% for clothing
    'default': 0.15              // 15% default
  },
  monthlySubscription: 39.99,    // Professional seller plan
  perItemFee: 0,                 // $0 for Professional (vs $0.99 for Individual)
  // FBA fees vary by size/weight - not included here (merchant fulfilled)
};

/**
 * Calculate price with Amazon fees baked in
 * @param {number} basePrice - Your desired net price
 * @param {string} category - Product category for referral fee
 * @returns {number} Price to list on Amazon
 */
function calculateAmazonPrice(basePrice, category = 'default') {
  const referralFee = AMAZON_FEES.referralFees[category] || AMAZON_FEES.referralFees.default;

  // Price = basePrice / (1 - referralFee)
  const amazonPrice = basePrice / (1 - referralFee);

  // Round to nearest $0.05
  return Math.ceil(amazonPrice * 20) / 20;
}

/**
 * Check if Amazon is configured
 */
function isConfigured() {
  return Boolean(LWA_CLIENT_ID && LWA_CLIENT_SECRET && AWS_ACCESS_KEY && AWS_SECRET_KEY);
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
    console.error('[Amazon] Error loading tokens:', e.message);
  }
  return null;
}

/**
 * Save tokens to file
 */
function saveTokens(tokens) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });

    const data = {
      ...tokens,
      expires_at: Date.now() + (tokens.expires_in * 1000),
      saved_at: Date.now()
    };

    fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2));
    console.log('[Amazon] Tokens saved successfully');
    return true;
  } catch (e) {
    console.error('[Amazon] Error saving tokens:', e.message);
    return false;
  }
}

/**
 * Get access token using refresh token (LWA)
 */
async function getAccessToken() {
  // Check if we have a valid cached token
  const cached = loadTokens();
  if (cached && cached.access_token && cached.expires_at > Date.now() + 60000) {
    return cached.access_token;
  }

  if (!REFRESH_TOKEN) {
    throw new Error('No refresh token available. Complete OAuth flow first.');
  }

  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: REFRESH_TOKEN,
      client_id: LWA_CLIENT_ID,
      client_secret: LWA_CLIENT_SECRET
    }).toString();

    const options = {
      method: 'POST',
      hostname: 'api.amazon.com',
      path: '/auth/o2/token',
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
          if (res.statusCode === 200 && data.access_token) {
            saveTokens(data);
            resolve(data.access_token);
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

// ===========================================
// AWS Signature v4 Implementation
// ===========================================

/**
 * Create SHA256 hash
 */
function sha256(data) {
  return crypto.createHash('sha256').update(data, 'utf8').digest();
}

/**
 * Create HMAC-SHA256
 */
function hmacSha256(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

/**
 * Get signature key for AWS Signature v4
 */
function getSignatureKey(secretKey, dateStamp, region, service) {
  const kDate = hmacSha256('AWS4' + secretKey, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, 'aws4_request');
  return kSigning;
}

/**
 * Sign request with AWS Signature v4
 */
function signRequest(method, url, headers, body, accessToken) {
  const parsedUrl = new URL(url);
  const host = parsedUrl.host;
  const path = parsedUrl.pathname + parsedUrl.search;
  const service = 'execute-api';

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  // Create canonical headers
  const canonicalHeaders = {
    'host': host,
    'x-amz-access-token': accessToken,
    'x-amz-date': amzDate
  };

  // Add content headers if body exists
  const payloadHash = sha256(body || '').toString('hex');

  const sortedHeaders = Object.keys(canonicalHeaders).sort();
  const canonicalHeadersStr = sortedHeaders.map(k => `${k}:${canonicalHeaders[k]}\n`).join('');
  const signedHeaders = sortedHeaders.join(';');

  // Create canonical request
  const canonicalRequest = [
    method,
    parsedUrl.pathname,
    parsedUrl.search.slice(1), // Remove leading ?
    canonicalHeadersStr,
    signedHeaders,
    payloadHash
  ].join('\n');

  // Create string to sign
  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${AWS_REGION}/${service}/aws4_request`;
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    sha256(canonicalRequest).toString('hex')
  ].join('\n');

  // Calculate signature
  const signingKey = getSignatureKey(AWS_SECRET_KEY, dateStamp, AWS_REGION, service);
  const signature = hmacSha256(signingKey, stringToSign).toString('hex');

  // Create authorization header
  const authorization = `${algorithm} Credential=${AWS_ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    'Authorization': authorization,
    'x-amz-access-token': accessToken,
    'x-amz-date': amzDate,
    'host': host
  };
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
 * Make authenticated SP-API request
 */
async function apiRequest(method, endpoint, body = null, queryParams = {}) {
  await waitForRateLimit();

  if (!isConfigured()) {
    throw new Error('Amazon SP-API not configured. Set credentials in .env');
  }

  const accessToken = await getAccessToken();

  // Build URL with query params
  let url = `${SP_API_ENDPOINT}${endpoint}`;
  if (Object.keys(queryParams).length > 0) {
    const params = new URLSearchParams(queryParams);
    url += `?${params.toString()}`;
  }

  const bodyStr = body ? JSON.stringify(body) : '';

  // Sign the request
  const signedHeaders = signRequest(method, url, {}, bodyStr, accessToken);

  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);

    const options = {
      method,
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: {
        ...signedHeaders,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    };

    if (bodyStr) {
      options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
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
            const err = new Error(data.errors?.[0]?.message || data.message || `HTTP ${res.statusCode}`);
            err.status = res.statusCode;
            err.detail = data;
            reject(err);
          }
        } catch (e) {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ success: true });
          } else {
            reject(new Error(`Invalid JSON response: ${text.slice(0, 200)}`));
          }
        }
      });
    });

    req.on('error', reject);

    if (bodyStr) {
      req.write(bodyStr);
    }

    req.end();
  });
}

// ===========================================
// Sellers API
// ===========================================

/**
 * Get seller participation status
 */
async function getMarketplaceParticipations() {
  return apiRequest('GET', '/sellers/v1/marketplaceParticipations');
}

// ===========================================
// Catalog Items API
// ===========================================

/**
 * Search catalog items
 */
async function searchCatalogItems(keywords, options = {}) {
  const params = {
    marketplaceIds: MARKETPLACE_ID,
    keywords: keywords,
    ...options
  };
  return apiRequest('GET', '/catalog/2022-04-01/items', null, params);
}

/**
 * Get catalog item by ASIN
 */
async function getCatalogItem(asin) {
  const params = {
    marketplaceIds: MARKETPLACE_ID,
    includedData: 'summaries,attributes,images,productTypes'
  };
  return apiRequest('GET', `/catalog/2022-04-01/items/${asin}`, null, params);
}

// ===========================================
// Listings API
// ===========================================

/**
 * Get listings item
 */
async function getListingsItem(sku) {
  const params = {
    marketplaceIds: MARKETPLACE_ID,
    includedData: 'summaries,attributes,issues,offers,fulfillmentAvailability'
  };
  return apiRequest('GET', `/listings/2021-08-01/items/${SELLER_ID}/${encodeURIComponent(sku)}`, null, params);
}

/**
 * Create or update listings item (PUT)
 */
async function putListingsItem(sku, item) {
  const body = {
    productType: item.productType || 'DECAL',
    requirements: 'LISTING',
    attributes: item.attributes || {}
  };

  // Add required attributes
  if (item.title) {
    body.attributes.item_name = [{ value: item.title, language_tag: 'en_US', marketplace_id: MARKETPLACE_ID }];
  }
  if (item.description) {
    body.attributes.product_description = [{ value: item.description, language_tag: 'en_US', marketplace_id: MARKETPLACE_ID }];
  }
  if (item.price) {
    body.attributes.purchasable_offer = [{
      marketplace_id: MARKETPLACE_ID,
      currency: 'USD',
      our_price: [{ schedule: [{ value_with_tax: item.price }] }]
    }];
    // List price (MSRP) - use same as selling price or slightly higher
    body.attributes.list_price = [{ value: item.price, currency: 'USD' }];
  }
  if (item.quantity !== undefined) {
    body.attributes.fulfillment_availability = [{
      fulfillment_channel_code: 'DEFAULT',
      quantity: item.quantity
    }];
  }
  if (item.bulletPoints && item.bulletPoints.length) {
    body.attributes.bullet_point = item.bulletPoints.map(bp => ({
      value: bp,
      language_tag: 'en_US',
      marketplace_id: MARKETPLACE_ID
    }));
  }
  if (item.brand) {
    body.attributes.brand = [{ value: item.brand, language_tag: 'en_US', marketplace_id: MARKETPLACE_ID }];
  }
  if (item.manufacturer) {
    body.attributes.manufacturer = [{ value: item.manufacturer, language_tag: 'en_US', marketplace_id: MARKETPLACE_ID }];
  }
  if (item.images && item.images.length) {
    body.attributes.main_product_image_locator = [{
      media_location: item.images[0],
      marketplace_id: MARKETPLACE_ID
    }];
    if (item.images.length > 1) {
      body.attributes.other_product_image_locator_1 = item.images.slice(1).map(img => ({
        media_location: img,
        marketplace_id: MARKETPLACE_ID
      }));
    }
  }

  // Set handling time for FBM (Fulfilled by Merchant) - important for POD
  if (item.handlingTime) {
    body.attributes.fulfillment_availability = [{
      fulfillment_channel_code: 'DEFAULT',
      quantity: item.quantity || 999,
      handling_time: { value: item.handlingTime, unit: 'days' }
    }];
  }

  // Wall Art specific attributes
  if (item._isMetalPrint || item.productType === 'WALL_ART') {
    // GTIN/UPC handling:
    // Option 1: Pass real UPC in item.upc
    // Option 2: Apply for GTIN exemption in Seller Central first
    // Without either, Amazon will reject with "External Product ID required" error
    if (item.upc) {
      body.attributes.externally_assigned_product_identifier = [{
        type: 'upc',
        value: item.upc
      }];
    }
    // Note: You MUST apply for GTIN exemption in Seller Central BEFORE listings will be accepted without UPC
    // Go to: Seller Central → Inventory → Add Product → Apply for GTIN exemption
    // Brand: Blue Ridge Custom Co, Category: Home & Kitchen → Wall Art

    body.attributes.item_type_keyword = [{ value: 'metal-prints', language_tag: 'en_US' }];
    body.attributes.theme = [{ value: 'Automotive', language_tag: 'en_US' }];

    // wall_art_form - valid values: art_print, hanging_sculpture, painting, photograph, plaque, poster, tapestry, wall_hanging_decor, wall_panel
    // For metal prints, wall_panel is the best fit
    body.attributes.wall_art_form = [{ value: 'wall_panel' }];

    // frame - complex object with color/material properties. For unframed metal prints, omit entirely
    // Amazon will treat as unframed by default

    body.attributes.color = [{ value: 'Multicolor', language_tag: 'en_US' }];
    body.attributes.country_of_origin = [{ value: 'US' }];
    body.attributes.orientation = [{ value: 'landscape' }];

    // Material specification
    body.attributes.material = [{ value: 'Aluminum', language_tag: 'en_US' }];

    // Dimensions - need both item_dimensions (with height) and item_length_width
    const dimensions = item.dimensions || { length: 10, width: 8, height: 0.1 };
    body.attributes.item_dimensions = [{
      length: { value: dimensions.length, unit: 'inches' },
      width: { value: dimensions.width, unit: 'inches' },
      height: { value: dimensions.height || 0.1, unit: 'inches' }
    }];
    body.attributes.item_length_width = [{
      length: { value: dimensions.length, unit: 'inches' },
      width: { value: dimensions.width, unit: 'inches' }
    }];
  }

  const params = { marketplaceIds: MARKETPLACE_ID };
  return apiRequest('PUT', `/listings/2021-08-01/items/${SELLER_ID}/${encodeURIComponent(sku)}`, body, params);
}

/**
 * Delete listings item
 */
async function deleteListingsItem(sku) {
  const params = { marketplaceIds: MARKETPLACE_ID };
  return apiRequest('DELETE', `/listings/2021-08-01/items/${SELLER_ID}/${encodeURIComponent(sku)}`, null, params);
}

/**
 * Patch listings item (partial update)
 */
async function patchListingsItem(sku, patches) {
  const body = {
    productType: patches.productType || 'DECAL',
    patches: patches.operations || []
  };

  const params = { marketplaceIds: MARKETPLACE_ID };
  return apiRequest('PATCH', `/listings/2021-08-01/items/${SELLER_ID}/${encodeURIComponent(sku)}`, body, params);
}

// ===========================================
// Product Type Definitions API
// ===========================================

/**
 * Get product type definition (JSON schema with valid values)
 */
async function getProductTypeDefinition(productType, options = {}) {
  const params = {
    marketplaceIds: MARKETPLACE_ID,
    sellerId: SELLER_ID,
    productType: productType,
    requirements: options.requirements || 'LISTING',
    locale: 'en_US'
  };
  return apiRequest('GET', `/definitions/2020-09-01/productTypes/${productType}`, null, params);
}

/**
 * Search product types
 */
async function searchProductTypes(keywords) {
  const params = {
    marketplaceIds: MARKETPLACE_ID,
    keywords: keywords
  };
  return apiRequest('GET', '/definitions/2020-09-01/productTypes', null, params);
}

// ===========================================
// Product Pricing API
// ===========================================

/**
 * Get competitive pricing for SKU
 */
async function getCompetitivePricing(skus) {
  const skuList = Array.isArray(skus) ? skus : [skus];
  const params = {
    MarketplaceId: MARKETPLACE_ID,
    ItemType: 'Sku',
    Skus: skuList.join(',')
  };
  return apiRequest('GET', '/products/pricing/v0/competitivePrice', null, params);
}

/**
 * Get item offers (Buy Box info)
 */
async function getItemOffers(asin) {
  const params = {
    MarketplaceId: MARKETPLACE_ID,
    ItemCondition: 'New'
  };
  return apiRequest('GET', `/products/pricing/v0/items/${asin}/offers`, null, params);
}

// ===========================================
// Product Fees API
// ===========================================

/**
 * Get estimated fees for a product
 */
async function getMyFeesEstimate(asin, price) {
  const body = {
    FeesEstimateRequest: {
      MarketplaceId: MARKETPLACE_ID,
      IdType: 'ASIN',
      IdValue: asin,
      IsAmazonFulfilled: false,
      PriceToEstimateFees: {
        ListingPrice: {
          CurrencyCode: 'USD',
          Amount: price
        }
      }
    }
  };
  return apiRequest('POST', `/products/fees/v0/items/${asin}/feesEstimate`, body);
}

// ===========================================
// Feeds API (for bulk operations)
// ===========================================

/**
 * Create a feed document
 */
async function createFeedDocument(contentType = 'text/xml; charset=UTF-8') {
  const body = { contentType };
  return apiRequest('POST', '/feeds/2021-06-30/documents', body);
}

/**
 * Create a feed
 */
async function createFeed(feedType, feedDocumentId, marketplaceIds = [MARKETPLACE_ID]) {
  const body = {
    feedType,
    marketplaceIds,
    inputFeedDocumentId: feedDocumentId
  };
  return apiRequest('POST', '/feeds/2021-06-30/feeds', body);
}

/**
 * Get feed status
 */
async function getFeed(feedId) {
  return apiRequest('GET', `/feeds/2021-06-30/feeds/${feedId}`);
}

// ===========================================
// Helper Functions
// ===========================================

/**
 * Convert Shopify product to Amazon listing format
 */
function shopifyToAmazonItem(shopifyProduct, options = {}) {
  const {
    priceMultiplier = 1.18,
    category = 'automotive',
    brand = 'Blue Ridge Custom Co'
  } = options;

  // Detect product type from Shopify
  const shopifyProductType = shopifyProduct.productType || shopifyProduct.product_type || '';
  const isMetalPrint = shopifyProductType.toLowerCase().includes('metal print');

  // Get base price from first variant
  const basePrice = parseFloat(shopifyProduct.variants?.[0]?.price || shopifyProduct.price || 0);
  const amazonPrice = options.calculateFees
    ? calculateAmazonPrice(basePrice, isMetalPrint ? 'home_garden' : category)
    : basePrice * priceMultiplier;

  // Get images
  const images = (shopifyProduct.images || [])
    .slice(0, 9) // Amazon max 9 images
    .map(img => img.src || img.url || img);

  // Build description (strip HTML)
  let description = shopifyProduct.body_html || shopifyProduct.descriptionHtml || shopifyProduct.description || '';
  description = description.replace(/<[^>]*>/g, '');
  description = description.slice(0, 2000); // Amazon limit

  // Generate SKU - use handle for cleaner SKUs
  const handle = shopifyProduct.handle || '';
  const sku = shopifyProduct.variants?.[0]?.sku || `BRC-${handle.slice(0, 30).toUpperCase()}`;

  // Build bullet points based on product type
  const tags = typeof shopifyProduct.tags === 'string'
    ? shopifyProduct.tags.split(',').map(t => t.trim())
    : (shopifyProduct.tags || []);

  let bulletPoints;
  let productType;

  if (isMetalPrint) {
    productType = 'WALL_ART'; // Amazon product type for wall art
    bulletPoints = [
      'Premium HD metal print on durable aluminum substrate',
      'Vivid colors with high-gloss or matte finish options',
      'Lightweight yet durable - ready to hang with included mounting hardware',
      'Made in USA - Professional quality dye-sublimation printing',
      'Perfect for home, office, garage, or man cave decor'
    ];
  } else {
    productType = 'DECAL';
    bulletPoints = [
      'Premium outdoor vinyl decal - UV resistant and weatherproof',
      'Easy application with included instructions',
      '5+ year outdoor durability',
      'Made in USA - Professional quality printing',
      tags.length ? `Perfect for: ${tags.slice(0, 5).join(', ')}` : 'Great for cars, trucks, laptops, and more'
    ];
  }

  return {
    sku,
    title: shopifyProduct.title.slice(0, 200), // Amazon max 200 chars
    description,
    price: amazonPrice.toFixed(2),
    quantity: 999,
    productType,
    brand,
    manufacturer: brand,
    images,
    bulletPoints,
    handlingTime: isMetalPrint ? 5 : 3, // Days to ship (POD needs more time)
    // Store Shopify reference
    _shopifyId: shopifyProduct.id,
    _shopifyHandle: shopifyProduct.handle,
    _isMetalPrint: isMetalPrint
  };
}

/**
 * Sync a Shopify product to Amazon
 */
async function syncProductToAmazon(shopifyProduct, options = {}) {
  console.log(`[Amazon] Syncing product: ${shopifyProduct.title}`);

  // Convert to Amazon format
  const amazonItem = shopifyToAmazonItem(shopifyProduct, options);

  // Create/update listing
  const result = await putListingsItem(amazonItem.sku, amazonItem);
  console.log(`[Amazon] Created/updated listing: ${amazonItem.sku}`);

  return {
    sku: amazonItem.sku,
    status: result.status || 'ACCEPTED',
    issues: result.issues || [],
    _shopifyId: shopifyProduct.id
  };
}

// ===========================================
// OAuth Flow for Initial Setup
// ===========================================

const OAUTH_REDIRECT_URI = process.env.AMAZON_REDIRECT_URI || 'https://blueridgecustomco.com/oauth/amazon/callback';

/**
 * Generate OAuth authorization URL
 */
function getAuthorizationUrl(state) {
  // Amazon SP-API OAuth URL
  const params = new URLSearchParams({
    application_id: process.env.AMAZON_APP_ID || '', // Your SP-API app ID
    state: state,
    redirect_uri: OAUTH_REDIRECT_URI
  });

  return `https://sellercentral.amazon.com/apps/authorize/consent?${params.toString()}`;
}

/**
 * Exchange authorization code for tokens
 */
async function exchangeCodeForTokens(code) {
  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      client_id: LWA_CLIENT_ID,
      client_secret: LWA_CLIENT_SECRET
    }).toString();

    const options = {
      method: 'POST',
      hostname: 'api.amazon.com',
      path: '/auth/o2/token',
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
          if (res.statusCode === 200 && data.refresh_token) {
            console.log('[Amazon] Got refresh token - add this to .env:');
            console.log(`AMAZON_REFRESH_TOKEN=${data.refresh_token}`);
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

// Store OAuth state
const oauthPending = new Map();

/**
 * Start OAuth flow
 */
function startOAuthFlow() {
  const state = crypto.randomBytes(16).toString('hex');

  oauthPending.set(state, { created: Date.now() });

  // Clean up old entries
  for (const [key, value] of oauthPending.entries()) {
    if (Date.now() - value.created > 600000) {
      oauthPending.delete(key);
    }
  }

  const url = getAuthorizationUrl(state);
  return { url, state };
}

/**
 * Complete OAuth flow
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
  calculateAmazonPrice,
  AMAZON_FEES,

  // OAuth
  startOAuthFlow,
  completeOAuthFlow,
  getAccessToken,
  loadTokens,

  // Sellers API
  getMarketplaceParticipations,

  // Catalog API
  searchCatalogItems,
  getCatalogItem,

  // Listings API
  getListingsItem,
  putListingsItem,
  deleteListingsItem,
  patchListingsItem,

  // Product Type Definitions API
  getProductTypeDefinition,
  searchProductTypes,

  // Pricing API
  getCompetitivePricing,
  getItemOffers,

  // Fees API
  getMyFeesEstimate,

  // Feeds API
  createFeedDocument,
  createFeed,
  getFeed,

  // Sync helpers
  shopifyToAmazonItem,
  syncProductToAmazon
};
