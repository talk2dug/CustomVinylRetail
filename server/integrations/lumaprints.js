/**
 * Lumaprints API Integration
 *
 * Metal print fulfillment via Lumaprints POD service.
 * API Docs: https://api-docs.lumaprints.com/
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// Load environment
const ENV_PATH = path.resolve(__dirname, '..', '..', '.env');
if (fs.existsSync(ENV_PATH)) {
  require('dotenv').config({ path: ENV_PATH });
}

// Configuration
const API_KEY = process.env.LUMAPRINTS_API_KEY || '';
const API_SECRET = process.env.LUMAPRINTS_API_SECRET || '';
const STORE_ID = process.env.LUMAPRINTS_STORE_ID || '';

// API URLs
const API_URLS = {
  production: 'https://us.api.lumaprints.com/api/v1',
  sandbox: 'https://us.api-sandbox.lumaprints.com/api/v1'
};

// Use sandbox for testing, production for real orders
const USE_SANDBOX = process.env.LUMAPRINTS_SANDBOX === 'true';
const BASE_URL = USE_SANDBOX ? API_URLS.sandbox : API_URLS.production;

// Product IDs
const PRODUCTS = {
  METAL_PRINT: 106001
};

// Metal Print Options
const METAL_OPTIONS = {
  surface: {
    GLOSSY_WHITE: 29,   // Default
    GLOSSY_SILVER: 30
  },
  hanging: {
    INSET_FRAME: 31,           // Default - built-in hanging
    METAL_EASEL: 32,           // For desk display
    SMALL_POSTS: 33,           // 3/4 inch stainless steel mounting posts
    LARGE_POSTS: 34,           // 1 inch stainless steel mounting posts
    NONE: 35                   // No hardware
  }
};

// Default options for metal prints
const DEFAULT_METAL_OPTIONS = [
  METAL_OPTIONS.surface.GLOSSY_WHITE,
  METAL_OPTIONS.hanging.INSET_FRAME
];

// Standard metal print sizes (width x height in inches)
// Note: 5x7 is NOT available through Lumaprints POD - done in-house
const METAL_SIZES = {
  '8x10': { width: 8, height: 10 },
  '8x12': { width: 8, height: 12 },
  '10x30': { width: 10, height: 30 },
  '11x14': { width: 11, height: 14 },
  '11x17': { width: 11, height: 17 },
  '12x12': { width: 12, height: 12 },
  '12x16': { width: 12, height: 16 },
  '12x18': { width: 12, height: 18 },
  '12x24': { width: 12, height: 24 },
  '15x45': { width: 15, height: 45 },
  '16x20': { width: 16, height: 20 },
  '16x24': { width: 16, height: 24 },
  '18x24': { width: 18, height: 24 },
  '20x20': { width: 20, height: 20 },
  '20x30': { width: 20, height: 30 },
  '20x40': { width: 20, height: 40 },
  '20x60': { width: 20, height: 60 },
  '24x24': { width: 24, height: 24 },
  '24x30': { width: 24, height: 30 },
  '24x36': { width: 24, height: 36 },
  '24x48': { width: 24, height: 48 },
  '30x30': { width: 30, height: 30 },
  '30x40': { width: 30, height: 40 },
  '30x60': { width: 30, height: 60 },
  '32x48': { width: 32, height: 48 },
  '36x36': { width: 36, height: 36 },
  '36x48': { width: 36, height: 48 },
  '40x60': { width: 40, height: 60 }
};

// Shipping methods
const SHIPPING_METHODS = {
  DEFAULT: 'default',
  GROUND: 'ground',
  OVERNIGHT: 'overnight',
  TWO_DAY: '2_day',
  PICKUP: 'pickup',
  USPS_FIRST_CLASS: 'usps_first_class',
  USPS_PRIORITY: 'usps_priority',
  USPS_EXPRESS: 'usps_express'
};

// Production times
const PRODUCTION_TIMES = {
  REGULAR: 'regular',
  NEXT_DAY: 'nextday',
  SAME_DAY: 'sameday'
};

// Token storage
const DATA_DIR = path.resolve(__dirname, '..', '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'lumaprints-config.json');

/**
 * Check if Lumaprints is configured
 */
function isConfigured() {
  return Boolean(API_KEY && API_SECRET && STORE_ID);
}

/**
 * Get Basic Auth header
 */
function getAuthHeader() {
  const credentials = Buffer.from(`${API_KEY}:${API_SECRET}`).toString('base64');
  return `Basic ${credentials}`;
}

/**
 * Make API request to Lumaprints
 */
async function apiRequest(method, endpoint, body = null) {
  if (!isConfigured()) {
    throw new Error('Lumaprints not configured. Set LUMAPRINTS_API_KEY and LUMAPRINTS_API_SECRET.');
  }

  const url = new URL(`${BASE_URL}${endpoint}`);

  return new Promise((resolve, reject) => {
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        'Authorization': getAuthHeader(),
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : {};

          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            console.error('[Lumaprints] API Error:', res.statusCode, json);
            reject(new Error(json.message || json.error || `API Error: ${res.statusCode}`));
          }
        } catch (e) {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ success: true, raw: data });
          } else {
            reject(new Error(`API Error: ${res.statusCode} - ${data}`));
          }
        }
      });
    });

    req.on('error', reject);

    if (body) {
      const bodyStr = JSON.stringify(body);
      req.setHeader('Content-Length', Buffer.byteLength(bodyStr));
      req.write(bodyStr);
    }

    req.end();
  });
}

// ===========================================
// Order Management
// ===========================================

/**
 * Submit a new order to Lumaprints
 *
 * @param {object} orderData - Order details
 * @param {string} orderData.externalId - Your order ID
 * @param {object} orderData.recipient - Shipping address
 * @param {array} orderData.items - Array of order items
 * @param {string} [orderData.shippingMethod] - Shipping method
 * @param {string} [orderData.productionTime] - Production time
 * @param {string} [orderData.specialInstructions] - Special instructions
 */
async function submitOrder(orderData) {
  const {
    externalId,
    recipient,
    items,
    shippingMethod = SHIPPING_METHODS.DEFAULT,
    productionTime = PRODUCTION_TIMES.REGULAR,
    specialInstructions = ''
  } = orderData;

  // Validate recipient
  const requiredFields = ['firstName', 'lastName', 'addressLine1', 'city', 'state', 'zipCode', 'country'];
  for (const field of requiredFields) {
    if (!recipient[field]) {
      throw new Error(`Missing required recipient field: ${field}`);
    }
  }

  // Build order items
  const orderItems = items.map((item, index) => {
    const size = METAL_SIZES[item.size];
    if (!size && (!item.width || !item.height)) {
      throw new Error(`Invalid size for item ${index}: ${item.size}`);
    }

    return {
      externalItemId: item.externalItemId || `${externalId}-${index}`,
      subcategoryId: item.subcategoryId || PRODUCTS.METAL_PRINT,
      quantity: item.quantity || 1,
      width: item.width || size.width,
      height: item.height || size.height,
      file: {
        imageUrl: item.imageUrl,
        saveImage: item.saveImage !== false // Default to true
      },
      orderItemOptions: item.options || DEFAULT_METAL_OPTIONS
    };
  });

  const payload = {
    externalId,
    storeId: parseInt(STORE_ID, 10),
    shippingMethod,
    productionTime,
    specialInstructions: specialInstructions.slice(0, 1024),
    recipient: {
      firstName: recipient.firstName,
      lastName: recipient.lastName,
      company: recipient.company || '',
      addressLine1: recipient.addressLine1,
      addressLine2: recipient.addressLine2 || '',
      city: recipient.city,
      state: recipient.state,
      zipCode: recipient.zipCode,
      country: recipient.country,
      phone: recipient.phone || ''
    },
    orderItems
  };

  console.log('[Lumaprints] Submitting order:', externalId);

  const result = await apiRequest('POST', '/orders', payload);

  console.log('[Lumaprints] Order submitted:', result);

  return result;
}

/**
 * Get order by Lumaprints order number
 */
async function getOrder(orderNumber) {
  return apiRequest('GET', `/orders/${orderNumber}`);
}

/**
 * Get order by external ID
 */
async function getOrderByExternalId(externalId) {
  return apiRequest('GET', `/orders/external/${externalId}`);
}

/**
 * Get multiple orders with filters
 */
async function getOrders(filters = {}) {
  const params = new URLSearchParams();

  // storeId is required
  params.append('storeId', STORE_ID);

  if (filters.page) params.append('page', filters.page);
  if (filters.orderDateStart) params.append('orderDateStart', filters.orderDateStart);
  if (filters.orderDateEnd) params.append('orderDateEnd', filters.orderDateEnd);

  const queryString = params.toString();
  const endpoint = `/orders?${queryString}`;

  return apiRequest('GET', endpoint);
}

/**
 * Get shipment info for an order
 */
async function getShipment(orderNumber) {
  return apiRequest('GET', `/orders/${orderNumber}/shipment`);
}

/**
 * Verify image dimensions are valid for a product
 */
async function verifyImageSize(imageUrl, width, height, subcategoryId = PRODUCTS.METAL_PRINT) {
  return apiRequest('POST', '/images/verify', {
    imageUrl,
    width,
    height,
    subcategoryId
  });
}

/**
 * Get order cost estimate
 */
async function getOrderCost(orderData) {
  return apiRequest('POST', '/orders/cost', orderData);
}

// ===========================================
// Metal Print Helpers
// ===========================================

/**
 * Create a metal print order item
 */
function createMetalPrintItem({
  imageUrl,
  size,
  width,
  height,
  quantity = 1,
  surface = 'glossy_white',
  hanging = 'inset_frame',
  externalItemId
}) {
  // Get dimensions from size or use provided width/height
  let dims;
  if (size && METAL_SIZES[size]) {
    dims = METAL_SIZES[size];
  } else if (width && height) {
    dims = { width, height };
  } else {
    throw new Error('Must provide either size (e.g., "8x10") or width and height');
  }

  // Map surface option
  const surfaceOption = surface === 'glossy_silver'
    ? METAL_OPTIONS.surface.GLOSSY_SILVER
    : METAL_OPTIONS.surface.GLOSSY_WHITE;

  // Map hanging option
  const hangingMap = {
    'inset_frame': METAL_OPTIONS.hanging.INSET_FRAME,
    'metal_easel': METAL_OPTIONS.hanging.METAL_EASEL,
    'small_posts': METAL_OPTIONS.hanging.SMALL_POSTS,
    'large_posts': METAL_OPTIONS.hanging.LARGE_POSTS,
    'none': METAL_OPTIONS.hanging.NONE
  };
  const hangingOption = hangingMap[hanging] || METAL_OPTIONS.hanging.INSET_FRAME;

  return {
    subcategoryId: PRODUCTS.METAL_PRINT,
    externalItemId,
    quantity,
    width: dims.width,
    height: dims.height,
    imageUrl,
    options: [surfaceOption, hangingOption]
  };
}

/**
 * Submit a metal print order (simplified helper)
 */
async function submitMetalPrintOrder({
  orderId,
  recipient,
  prints,
  shippingMethod = 'default',
  productionTime = 'regular',
  specialInstructions = ''
}) {
  const items = prints.map((print, idx) => createMetalPrintItem({
    ...print,
    externalItemId: print.externalItemId || `${orderId}-item-${idx}`
  }));

  return submitOrder({
    externalId: orderId,
    recipient,
    items,
    shippingMethod,
    productionTime,
    specialInstructions
  });
}

// ===========================================
// Configuration & Status
// ===========================================

/**
 * Save configuration
 */
function saveConfig(config) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const data = {
    ...config,
    updated_at: new Date().toISOString()
  };

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
  return data;
}

/**
 * Load configuration
 */
function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    console.error('[Lumaprints] Error loading config:', e.message);
    return null;
  }
}

/**
 * Get connection status
 */
async function getConnectionStatus() {
  if (!isConfigured()) {
    return {
      connected: false,
      configured: false,
      message: 'Not configured. Set LUMAPRINTS_API_KEY, LUMAPRINTS_API_SECRET, and LUMAPRINTS_STORE_ID.'
    };
  }

  try {
    // Try to fetch orders to verify connection
    const orders = await getOrders({});

    return {
      connected: true,
      configured: true,
      sandbox: USE_SANDBOX,
      storeId: STORE_ID,
      message: 'Connected to Lumaprints'
    };
  } catch (e) {
    return {
      connected: false,
      configured: true,
      sandbox: USE_SANDBOX,
      error: e.message
    };
  }
}

/**
 * Test the API connection
 */
async function testConnection() {
  console.log('[Lumaprints] Testing connection...');
  console.log('[Lumaprints] Using:', USE_SANDBOX ? 'SANDBOX' : 'PRODUCTION');
  console.log('[Lumaprints] Store ID:', STORE_ID);

  const status = await getConnectionStatus();
  console.log('[Lumaprints] Status:', status);

  return status;
}

// ===========================================
// Webhooks
// ===========================================

/**
 * Subscribe to Lumaprints webhook events
 * Currently only "shipping" event is available
 */
async function subscribeWebhook(webhookUrl, username = null, password = null) {
  const body = {
    event: 'shipping',
    storeId: parseInt(STORE_ID, 10),
    url: webhookUrl
  };

  if (username) body.username = username;
  if (password) body.password = password;

  console.log('[Lumaprints] Subscribing to shipping webhook:', webhookUrl);

  return apiRequest('POST', '/webhook', body);
}

/**
 * Get current webhook subscriptions
 */
async function getWebhooks() {
  return apiRequest('GET', `/webhook?storeId=${STORE_ID}`);
}

/**
 * Delete a webhook subscription
 */
async function deleteWebhook(webhookId) {
  return apiRequest('DELETE', `/webhook/${webhookId}`);
}

// Export everything
module.exports = {
  // Configuration
  isConfigured,
  getConnectionStatus,
  testConnection,
  saveConfig,
  loadConfig,

  // Orders
  submitOrder,
  getOrder,
  getOrderByExternalId,
  getOrders,
  getShipment,
  getOrderCost,

  // Images
  verifyImageSize,

  // Metal Print Helpers
  createMetalPrintItem,
  submitMetalPrintOrder,

  // Webhooks
  subscribeWebhook,
  getWebhooks,
  deleteWebhook,

  // Constants
  PRODUCTS,
  METAL_OPTIONS,
  METAL_SIZES,
  SHIPPING_METHODS,
  PRODUCTION_TIMES,
  DEFAULT_METAL_OPTIONS,

  // URLs
  API_URLS,
  USE_SANDBOX
};
