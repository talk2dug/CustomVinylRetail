/**
 * TikTok Shop API Integration
 *
 * Handles OAuth 2.0 authentication and product listing management for TikTok Shop.
 * Uses the TikTok Shop Open API (version 202309+).
 *
 * API Docs: https://partner.tiktokshop.com/doc
 * Partner Portal (US): https://seller-us.tiktok.com/
 * Partner Portal (Global): https://seller.tiktok.com/
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
const APP_KEY = process.env.TIKTOK_APP_KEY || '';
const APP_SECRET = process.env.TIKTOK_APP_SECRET || '';
const REDIRECT_URI = process.env.TIKTOK_REDIRECT_URI || 'https://blueridgecustomco.com/api/tiktok/auth-callback';

// API URLs - TikTok Shop uses region-specific URLs
const API_URLS = {
  us: {
    auth: 'https://auth.tiktok-shops.com',
    api: 'https://open-api.tiktokglobalshop.com'
  },
  // Global regions use different base URL
  global: {
    auth: 'https://auth.tiktok-shops.com',
    api: 'https://open-api.tiktokglobalshop.com'
  }
};

// API Version
const API_VERSION = '202309';

// Token storage path
const DATA_DIR = path.resolve(__dirname, '..', '..', 'data');
const TOKEN_FILE = path.join(DATA_DIR, 'tiktok-tokens.json');

// Rate limiting
const RATE_LIMIT_MS = 100; // Be conservative
let lastCallTime = 0;

// TikTok Shop Fee structure (estimates)
const TIKTOK_FEES = {
  referralFee: 0.08,        // 8% referral fee (varies by category)
  transactionFee: 0.00,     // TikTok currently has 0% transaction fee promo
  // Note: Fees subject to change, check TikTok Shop seller center for current rates
};

/**
 * Check if TikTok Shop is configured
 */
function isConfigured() {
  return Boolean(APP_KEY && APP_SECRET);
}

/**
 * Generate state parameter for OAuth
 */
function generateState() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Generate HMAC-SHA256 signature for API requests
 * TikTok Shop requires signing all API requests
 *
 * @param {string} path - API endpoint path
 * @param {object} params - Query parameters
 * @param {string} body - Request body (JSON string)
 * @returns {string} HMAC-SHA256 signature
 */
function generateSignature(path, params = {}, body = '') {
  // Sort parameters alphabetically
  const sortedKeys = Object.keys(params).sort();

  // Build parameter string: key1value1key2value2...
  let paramString = '';
  for (const key of sortedKeys) {
    if (key !== 'sign' && key !== 'access_token') {
      paramString += `${key}${params[key]}`;
    }
  }

  // Build signing string: app_secret + path + paramString + body + app_secret
  const signString = `${APP_SECRET}${path}${paramString}${body}${APP_SECRET}`;

  // Generate HMAC-SHA256
  const signature = crypto
    .createHmac('sha256', APP_SECRET)
    .update(signString, 'utf8')
    .digest('hex');

  return signature;
}

/**
 * Get OAuth authorization URL
 */
function getAuthUrl(state) {
  if (!isConfigured()) {
    throw new Error('TikTok Shop not configured. Set TIKTOK_APP_KEY and TIKTOK_APP_SECRET.');
  }

  const params = new URLSearchParams({
    app_key: APP_KEY,
    state: state || generateState()
  });

  return `${API_URLS.us.auth}/oauth/authorize?${params.toString()}`;
}

/**
 * Exchange authorization code for access token
 */
async function exchangeCodeForToken(authCode) {
  const path = '/api/v2/token/get';
  const timestamp = Math.floor(Date.now() / 1000);

  const params = {
    app_key: APP_KEY,
    app_secret: APP_SECRET,
    auth_code: authCode,
    grant_type: 'authorized_code'
  };

  const url = `${API_URLS.us.api}${path}`;

  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(params);

    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.code === 0 && json.data) {
            // Save tokens
            saveTokens(json.data);
            resolve(json.data);
          } else {
            reject(new Error(json.message || 'Token exchange failed'));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/**
 * Refresh access token
 */
async function refreshAccessToken(refreshToken) {
  const path = '/api/v2/token/refresh';

  const params = {
    app_key: APP_KEY,
    app_secret: APP_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  };

  const url = `${API_URLS.us.api}${path}`;

  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(params);

    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.code === 0 && json.data) {
            saveTokens(json.data);
            resolve(json.data);
          } else {
            reject(new Error(json.message || 'Token refresh failed'));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/**
 * Save tokens to file
 */
function saveTokens(tokenData) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const data = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    access_token_expire_in: tokenData.access_token_expire_in,
    refresh_token_expire_in: tokenData.refresh_token_expire_in,
    open_id: tokenData.open_id,
    seller_name: tokenData.seller_name,
    seller_base_region: tokenData.seller_base_region,
    user_type: tokenData.user_type,
    updated_at: new Date().toISOString()
  };

  fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2));
  console.log('[TikTok] Tokens saved');
  return data;
}

/**
 * Load tokens from file
 */
function loadTokens() {
  if (!fs.existsSync(TOKEN_FILE)) {
    return null;
  }

  try {
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    return data;
  } catch (e) {
    console.error('[TikTok] Error loading tokens:', e.message);
    return null;
  }
}

/**
 * Get valid access token (refresh if needed)
 */
async function getAccessToken() {
  const tokens = loadTokens();

  if (!tokens || !tokens.access_token) {
    throw new Error('No TikTok tokens found. Please authorize first.');
  }

  // Check if token is expired (with 5 min buffer)
  const updatedAt = new Date(tokens.updated_at).getTime();
  const expiresAt = updatedAt + (tokens.access_token_expire_in * 1000) - (5 * 60 * 1000);

  if (Date.now() > expiresAt) {
    console.log('[TikTok] Access token expired, refreshing...');
    const newTokens = await refreshAccessToken(tokens.refresh_token);
    return newTokens.access_token;
  }

  return tokens.access_token;
}

/**
 * Make authenticated API request
 */
async function apiRequest(method, path, body = null, shopCipher = null) {
  // Rate limiting
  const now = Date.now();
  const timeSinceLastCall = now - lastCallTime;
  if (timeSinceLastCall < RATE_LIMIT_MS) {
    await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_MS - timeSinceLastCall));
  }
  lastCallTime = Date.now();

  const accessToken = await getAccessToken();
  const timestamp = Math.floor(Date.now() / 1000);

  // Build query parameters
  const params = {
    app_key: APP_KEY,
    timestamp: timestamp.toString(),
    version: API_VERSION
  };

  if (shopCipher) {
    params.shop_cipher = shopCipher;
  }

  // Generate signature
  const bodyStr = body ? JSON.stringify(body) : '';
  const signature = generateSignature(path, params, bodyStr);
  params.sign = signature;
  params.access_token = accessToken;

  const queryString = new URLSearchParams(params).toString();
  const url = `${API_URLS.us.api}${path}?${queryString}`;

  return new Promise((resolve, reject) => {
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    if (body) {
      options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.code === 0) {
            resolve(json.data);
          } else {
            console.error('[TikTok] API Error:', json);
            reject(new Error(`TikTok API Error ${json.code}: ${json.message}`));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(bodyStr);
    }
    req.end();
  });
}

// ===========================================
// Shop API
// ===========================================

/**
 * Get authorized shops
 */
async function getAuthorizedShops() {
  return apiRequest('GET', '/authorization/202309/shops');
}

/**
 * Get shop info
 */
async function getShopInfo(shopCipher) {
  return apiRequest('GET', '/shop/202309/shops', null, shopCipher);
}

// ===========================================
// Product API
// ===========================================

/**
 * Get product categories
 */
async function getCategories(shopCipher) {
  return apiRequest('GET', '/product/202309/categories', null, shopCipher);
}

/**
 * Search categories
 */
async function searchCategories(shopCipher, keyword) {
  return apiRequest('POST', '/product/202309/categories/search', {
    keyword
  }, shopCipher);
}

/**
 * Get category rules (required attributes)
 */
async function getCategoryRules(shopCipher, categoryId) {
  return apiRequest('GET', `/product/202309/categories/${categoryId}/rules`, null, shopCipher);
}

/**
 * Create a product
 */
async function createProduct(shopCipher, productData) {
  return apiRequest('POST', '/product/202309/products', productData, shopCipher);
}

/**
 * Update a product
 */
async function updateProduct(shopCipher, productId, productData) {
  return apiRequest('PUT', `/product/202309/products/${productId}`, productData, shopCipher);
}

/**
 * Get product details
 */
async function getProduct(shopCipher, productId) {
  return apiRequest('GET', `/product/202309/products/${productId}`, null, shopCipher);
}

/**
 * Search products
 */
async function searchProducts(shopCipher, filters = {}) {
  return apiRequest('POST', '/product/202309/products/search', filters, shopCipher);
}

/**
 * Delete a product
 */
async function deleteProduct(shopCipher, productId) {
  return apiRequest('DELETE', `/product/202309/products/${productId}`, null, shopCipher);
}

/**
 * Activate a product (make it live)
 */
async function activateProduct(shopCipher, productIds) {
  return apiRequest('POST', '/product/202309/products/activate', {
    product_ids: Array.isArray(productIds) ? productIds : [productIds]
  }, shopCipher);
}

/**
 * Deactivate a product
 */
async function deactivateProduct(shopCipher, productIds) {
  return apiRequest('POST', '/product/202309/products/deactivate', {
    product_ids: Array.isArray(productIds) ? productIds : [productIds]
  }, shopCipher);
}

// ===========================================
// Inventory API
// ===========================================

/**
 * Update inventory
 */
async function updateInventory(shopCipher, skuId, quantity, warehouseId) {
  return apiRequest('POST', '/product/202309/inventory/update', {
    sku_id: skuId,
    quantity: quantity,
    warehouse_id: warehouseId
  }, shopCipher);
}

// ===========================================
// Order API
// ===========================================

/**
 * Get orders
 */
async function getOrders(shopCipher, filters = {}) {
  return apiRequest('POST', '/order/202309/orders/search', filters, shopCipher);
}

/**
 * Get order details
 */
async function getOrderDetails(shopCipher, orderIds) {
  return apiRequest('POST', '/order/202309/orders/detail/query', {
    order_ids: Array.isArray(orderIds) ? orderIds : [orderIds]
  }, shopCipher);
}

// ===========================================
// Image Upload API
// ===========================================

/**
 * Upload image from URL
 */
async function uploadImageFromUrl(shopCipher, imageUrl) {
  return apiRequest('POST', '/product/202309/images/upload', {
    img_url: imageUrl
  }, shopCipher);
}

// ===========================================
// Sync Helpers
// ===========================================

/**
 * Calculate price with TikTok fees
 */
function calculateTikTokPrice(basePrice) {
  const feePercent = TIKTOK_FEES.referralFee + TIKTOK_FEES.transactionFee;
  const price = basePrice / (1 - feePercent);
  return Math.ceil(price * 100) / 100; // Round up to nearest cent
}

/**
 * Convert Shopify product to TikTok format
 */
function shopifyToTikTokProduct(shopifyProduct, categoryId, options = {}) {
  const {
    priceMultiplier = 1.1 // Default 10% markup
  } = options;

  // Get base price
  const basePrice = parseFloat(shopifyProduct.variants?.[0]?.price || '0');
  const tiktokPrice = calculateTikTokPrice(basePrice * priceMultiplier);

  // Get images
  const images = (shopifyProduct.images || []).slice(0, 9); // TikTok max 9 images

  // Build description (TikTok has character limits)
  const description = (shopifyProduct.body_html || shopifyProduct.description || '')
    .replace(/<[^>]*>/g, '') // Strip HTML
    .slice(0, 10000); // TikTok limit

  // Build product data structure
  const productData = {
    title: shopifyProduct.title.slice(0, 255), // TikTok max 255 chars
    description: description,
    category_id: categoryId,
    brand_id: '', // Optional: set if you have brand registration
    main_images: images.map(img => ({
      uri: img.src || img
    })),
    skus: [{
      sales_attributes: [],
      stock_infos: [{
        warehouse_id: '', // Set your warehouse ID
        available_stock: 999
      }],
      seller_sku: `SHOP-${shopifyProduct.id}`,
      price: {
        amount: (tiktokPrice * 100).toString(), // Price in cents
        currency: 'USD'
      },
      inventory: [{
        quantity: 999
      }]
    }],
    package_dimensions: {
      length: '10',
      width: '10',
      height: '2',
      unit: 'INCH'
    },
    package_weight: {
      value: '1',
      unit: 'POUND'
    },
    is_cod_allowed: false,
    certifications: []
  };

  return productData;
}

/**
 * Sync a Shopify product to TikTok Shop
 */
async function syncProductToTikTok(shopCipher, shopifyProduct, categoryId, options = {}) {
  try {
    console.log(`[TikTok] Syncing product: ${shopifyProduct.title}`);

    // Convert to TikTok format
    const productData = shopifyToTikTokProduct(shopifyProduct, categoryId, options);

    // Upload images first
    const uploadedImages = [];
    for (const img of productData.main_images) {
      try {
        const result = await uploadImageFromUrl(shopCipher, img.uri);
        uploadedImages.push({ uri: result.uri });
      } catch (e) {
        console.error(`[TikTok] Image upload failed: ${e.message}`);
      }
    }

    if (uploadedImages.length > 0) {
      productData.main_images = uploadedImages;
    }

    // Create product
    const result = await createProduct(shopCipher, productData);

    console.log(`[TikTok] Product created: ${result.product_id}`);

    // Activate the product
    await activateProduct(shopCipher, result.product_id);

    return {
      success: true,
      productId: result.product_id,
      sku: productData.skus[0].seller_sku
    };
  } catch (error) {
    console.error(`[TikTok] Sync failed: ${error.message}`);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Get connection status
 */
async function getConnectionStatus() {
  const tokens = loadTokens();

  if (!tokens || !tokens.access_token) {
    return {
      connected: false,
      configured: isConfigured(),
      message: isConfigured() ? 'Not authorized' : 'Not configured'
    };
  }

  try {
    const shops = await getAuthorizedShops();
    return {
      connected: true,
      configured: true,
      seller_name: tokens.seller_name,
      seller_region: tokens.seller_base_region,
      shops: shops.shops || [],
      token_expires: tokens.access_token_expire_in,
      updated_at: tokens.updated_at
    };
  } catch (e) {
    return {
      connected: false,
      configured: true,
      error: e.message
    };
  }
}

// Export all functions
module.exports = {
  // Configuration
  isConfigured,

  // OAuth
  generateState,
  getAuthUrl,
  exchangeCodeForToken,
  refreshAccessToken,
  getAccessToken,

  // Token management
  saveTokens,
  loadTokens,

  // API helpers
  generateSignature,
  apiRequest,

  // Shop API
  getAuthorizedShops,
  getShopInfo,
  getConnectionStatus,

  // Product API
  getCategories,
  searchCategories,
  getCategoryRules,
  createProduct,
  updateProduct,
  getProduct,
  searchProducts,
  deleteProduct,
  activateProduct,
  deactivateProduct,

  // Inventory
  updateInventory,

  // Orders
  getOrders,
  getOrderDetails,

  // Images
  uploadImageFromUrl,

  // Sync helpers
  calculateTikTokPrice,
  shopifyToTikTokProduct,
  syncProductToTikTok,

  // Constants
  TIKTOK_FEES,
  API_VERSION
};
