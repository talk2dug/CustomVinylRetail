/**
 * Unified Marketplace Sync Manager
 *
 * Syncs products from Shopify to multiple marketplaces (Etsy, eBay, Amazon)
 * with platform-specific pricing adjustments to maintain profit margins.
 */

const fs = require('fs');
const path = require('path');

// Load environment
const ENV_PATH = path.resolve(__dirname, '..', '..', '.env');
if (fs.existsSync(ENV_PATH)) {
  require('dotenv').config({ path: ENV_PATH });
}

// Platform integrations
let etsy, ebay, amazon, shopify;
try { etsy = require('./etsy'); } catch (e) { etsy = null; }
try { ebay = require('./ebay'); } catch (e) { ebay = null; }
try { amazon = require('./amazon'); } catch (e) { amazon = null; }
try { shopify = require('./shopify'); } catch (e) { shopify = null; }

// Data storage
const DATA_DIR = path.resolve(__dirname, '..', '..', 'data');
const SYNC_LOG_FILE = path.join(DATA_DIR, 'marketplace-sync-log.json');
const SYNC_MAP_FILE = path.join(DATA_DIR, 'marketplace-product-map.json');

// Platform fee structures and multipliers
const PLATFORM_CONFIG = {
  shopify: {
    name: 'Shopify',
    multiplier: 1.0,
    fees: {
      transaction: 0,
      payment: 0.029,
      paymentFixed: 0.30,
      monthly: 29 // Basic plan
    }
  },
  etsy: {
    name: 'Etsy',
    multiplier: 1.15,
    fees: {
      listing: 0.20,
      transaction: 0.065,
      payment: 0.03,
      paymentFixed: 0.25,
      regulatory: 0.005,
      offsiteAds: 0.15 // Optional but can be charged
    }
  },
  ebay: {
    name: 'eBay',
    multiplier: 1.13,
    fees: {
      // Basic store level
      finalValue: 0.117,
      insertion: 0.35, // After free listings
      monthly: 21.95
    },
    storeLevels: {
      none: { fvf: 0.1325, monthly: 0, freeListings: 250 },
      starter: { fvf: 0.1255, monthly: 4.95, freeListings: 250 },
      basic: { fvf: 0.117, monthly: 21.95, freeListings: 1000 },
      premium: { fvf: 0.109, monthly: 59.95, freeListings: 10000 },
      anchor: { fvf: 0.099, monthly: 299.95, freeListings: 25000 }
    }
  },
  amazon: {
    name: 'Amazon',
    multiplier: 1.18,
    fees: {
      referral: 0.15, // 15% for most categories
      monthly: 39.99 // Professional plan
    }
  }
};

/**
 * Calculate platform-adjusted price
 */
function calculatePlatformPrice(basePrice, platform, options = {}) {
  const config = PLATFORM_CONFIG[platform];
  if (!config) return basePrice;

  let price;

  if (platform === 'etsy') {
    const includeOffsiteAds = options.includeOffsiteAds || false;
    let feePercent = config.fees.transaction + config.fees.payment + config.fees.regulatory;
    if (includeOffsiteAds) feePercent += config.fees.offsiteAds;
    const fixedFees = config.fees.listing + config.fees.paymentFixed;
    price = (basePrice + fixedFees) / (1 - feePercent);
  } else if (platform === 'ebay') {
    const storeLevel = options.storeLevel || 'basic';
    const store = config.storeLevels[storeLevel] || config.storeLevels.basic;
    price = basePrice / (1 - store.fvf);
  } else if (platform === 'amazon') {
    price = basePrice / (1 - config.fees.referral);
  } else {
    price = basePrice * config.multiplier;
  }

  // Round to nearest $0.05
  return Math.ceil(price * 20) / 20;
}

/**
 * Calculate prices for all platforms
 */
function calculateAllPrices(basePrice, options = {}) {
  return {
    shopify: basePrice,
    etsy: calculatePlatformPrice(basePrice, 'etsy', options),
    ebay: calculatePlatformPrice(basePrice, 'ebay', options),
    amazon: calculatePlatformPrice(basePrice, 'amazon', options)
  };
}

/**
 * Get platform availability status
 */
function getPlatformStatus() {
  return {
    etsy: {
      configured: etsy?.isConfigured() || false,
      authenticated: etsy?.hasValidTokens() || false,
      ready: etsy?.isConfigured() && etsy?.hasValidTokens()
    },
    ebay: {
      configured: ebay?.isConfigured() || false,
      authenticated: ebay?.hasValidTokens() || false,
      ready: ebay?.isConfigured() && ebay?.hasValidTokens()
    },
    amazon: {
      configured: amazon?.isConfigured() || false,
      authenticated: amazon?.hasValidTokens() || false,
      ready: amazon?.isConfigured() && amazon?.hasValidTokens()
    },
    shopify: {
      configured: shopify?.isConfigured() || false,
      authenticated: true, // Shopify uses API key, not OAuth
      ready: shopify?.isConfigured() || false
    }
  };
}

/**
 * Load product mapping (Shopify ID -> Platform IDs)
 */
function loadProductMap() {
  try {
    if (fs.existsSync(SYNC_MAP_FILE)) {
      return JSON.parse(fs.readFileSync(SYNC_MAP_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[MarketplaceSync] Error loading product map:', e.message);
  }
  return {};
}

/**
 * Save product mapping
 */
function saveProductMap(map) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SYNC_MAP_FILE, JSON.stringify(map, null, 2));
  } catch (e) {
    console.error('[MarketplaceSync] Error saving product map:', e.message);
  }
}

/**
 * Log sync activity
 */
function logSync(entry) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });

    let log = [];
    if (fs.existsSync(SYNC_LOG_FILE)) {
      log = JSON.parse(fs.readFileSync(SYNC_LOG_FILE, 'utf8'));
    }

    log.push({
      ...entry,
      timestamp: new Date().toISOString()
    });

    // Keep last 1000 entries
    if (log.length > 1000) {
      log = log.slice(-1000);
    }

    fs.writeFileSync(SYNC_LOG_FILE, JSON.stringify(log, null, 2));
  } catch (e) {
    console.error('[MarketplaceSync] Error logging sync:', e.message);
  }
}

/**
 * Sync a single product to specified platforms
 */
async function syncProduct(shopifyProductId, platforms = ['etsy', 'ebay'], options = {}) {
  const results = {
    shopifyProductId,
    success: [],
    failed: [],
    skipped: []
  };

  // Fetch product from Shopify
  if (!shopify?.isConfigured()) {
    throw new Error('Shopify not configured');
  }

  const product = await shopify.getProduct(shopifyProductId);
  if (!product) {
    throw new Error(`Shopify product ${shopifyProductId} not found`);
  }

  console.log(`[MarketplaceSync] Syncing "${product.title}" to ${platforms.join(', ')}`);

  // Load existing mappings
  const productMap = loadProductMap();
  if (!productMap[shopifyProductId]) {
    productMap[shopifyProductId] = {
      shopifyHandle: product.handle,
      shopifyTitle: product.title,
      platforms: {}
    };
  }

  // Sync to each platform
  for (const platform of platforms) {
    try {
      if (platform === 'etsy') {
        if (!etsy?.hasValidTokens()) {
          results.skipped.push({ platform, reason: 'Not authenticated' });
          continue;
        }

        // Check if already synced
        if (productMap[shopifyProductId].platforms.etsy && !options.force) {
          results.skipped.push({
            platform,
            reason: 'Already synced',
            listingId: productMap[shopifyProductId].platforms.etsy.listingId
          });
          continue;
        }

        // Get shipping profile
        let shippingProfileId = options.etsyShippingProfileId;
        if (!shippingProfileId) {
          const profiles = await etsy.getShippingProfiles();
          if (profiles.results?.length > 0) {
            shippingProfileId = profiles.results[0].shipping_profile_id;
          }
        }

        const listing = await etsy.syncProductToEtsy(product, {
          publish: options.publish || false,
          priceMultiplier: PLATFORM_CONFIG.etsy.multiplier,
          shippingProfileId,
          taxonomyId: options.etsyTaxonomyId || 6648 // Bumper Stickers & Decals
        });

        productMap[shopifyProductId].platforms.etsy = {
          listingId: listing.listing_id,
          syncedAt: new Date().toISOString(),
          published: options.publish || false
        };

        results.success.push({
          platform,
          listingId: listing.listing_id,
          published: options.publish || false
        });

      } else if (platform === 'ebay') {
        if (!ebay?.hasValidTokens()) {
          results.skipped.push({ platform, reason: 'Not authenticated' });
          continue;
        }

        // Check if already synced
        if (productMap[shopifyProductId].platforms.ebay && !options.force) {
          results.skipped.push({
            platform,
            reason: 'Already synced',
            sku: productMap[shopifyProductId].platforms.ebay.sku
          });
          continue;
        }

        const result = await ebay.syncProductToEbay(product, {
          publish: options.publish || false,
          priceMultiplier: PLATFORM_CONFIG.ebay.multiplier,
          storeLevel: options.ebayStoreLevel || 'basic',
          categoryId: options.ebayCategoryId || '180098' // Stickers & Decals
        });

        productMap[shopifyProductId].platforms.ebay = {
          sku: result.sku,
          offerId: result.offerId,
          listingId: result.listingId,
          syncedAt: new Date().toISOString(),
          status: result.status
        };

        results.success.push({
          platform,
          sku: result.sku,
          offerId: result.offerId,
          listingId: result.listingId,
          status: result.status
        });

      } else if (platform === 'amazon') {
        if (!amazon?.hasValidTokens()) {
          results.skipped.push({ platform, reason: 'Not authenticated' });
          continue;
        }

        // Check if already synced
        if (productMap[shopifyProductId].platforms.amazon && !options.force) {
          results.skipped.push({
            platform,
            reason: 'Already synced',
            sku: productMap[shopifyProductId].platforms.amazon.sku
          });
          continue;
        }

        const result = await amazon.syncProductToAmazon(product, {
          priceMultiplier: PLATFORM_CONFIG.amazon.multiplier,
          category: options.amazonCategory || 'automotive'
        });

        productMap[shopifyProductId].platforms.amazon = {
          sku: result.sku,
          status: result.status,
          issues: result.issues,
          syncedAt: new Date().toISOString()
        };

        results.success.push({
          platform,
          sku: result.sku,
          status: result.status,
          issues: result.issues
        });
      }

    } catch (err) {
      console.error(`[MarketplaceSync] Error syncing to ${platform}:`, err.message);
      results.failed.push({
        platform,
        error: err.message,
        detail: err.detail
      });
    }
  }

  // Save updated mappings
  saveProductMap(productMap);

  // Log the sync
  logSync({
    action: 'sync_product',
    shopifyProductId,
    productTitle: product.title,
    results
  });

  return results;
}

/**
 * Bulk sync products from a Shopify collection
 */
async function syncCollection(collectionId, platforms = ['etsy', 'ebay'], options = {}) {
  if (!shopify?.isConfigured()) {
    throw new Error('Shopify not configured');
  }

  console.log(`[MarketplaceSync] Starting collection sync: ${collectionId}`);

  // Get products in collection
  const products = await shopify.getCollectionProducts(collectionId);
  console.log(`[MarketplaceSync] Found ${products.length} products in collection`);

  const results = {
    collectionId,
    total: products.length,
    synced: [],
    failed: [],
    skipped: []
  };

  // Sync each product with delay to respect rate limits
  for (let i = 0; i < products.length; i++) {
    const product = products[i];
    console.log(`[MarketplaceSync] Syncing ${i + 1}/${products.length}: ${product.title}`);

    try {
      const productResult = await syncProduct(product.id, platforms, options);

      if (productResult.success.length > 0) {
        results.synced.push({
          productId: product.id,
          title: product.title,
          platforms: productResult.success
        });
      }

      if (productResult.failed.length > 0) {
        results.failed.push({
          productId: product.id,
          title: product.title,
          errors: productResult.failed
        });
      }

      if (productResult.skipped.length > 0) {
        results.skipped.push({
          productId: product.id,
          title: product.title,
          reasons: productResult.skipped
        });
      }

      // Rate limit delay
      if (i < products.length - 1) {
        await new Promise(resolve => setTimeout(resolve, options.delayMs || 1000));
      }

    } catch (err) {
      console.error(`[MarketplaceSync] Error syncing product ${product.id}:`, err.message);
      results.failed.push({
        productId: product.id,
        title: product.title,
        error: err.message
      });
    }
  }

  // Log the bulk sync
  logSync({
    action: 'sync_collection',
    collectionId,
    totalProducts: products.length,
    synced: results.synced.length,
    failed: results.failed.length,
    skipped: results.skipped.length
  });

  console.log(`[MarketplaceSync] Collection sync complete:`, {
    synced: results.synced.length,
    failed: results.failed.length,
    skipped: results.skipped.length
  });

  return results;
}

/**
 * Get sync status for a product
 */
function getProductSyncStatus(shopifyProductId) {
  const productMap = loadProductMap();
  return productMap[shopifyProductId] || null;
}

/**
 * Get all synced products
 */
function getAllSyncedProducts() {
  return loadProductMap();
}

/**
 * Get recent sync log entries
 */
function getSyncLog(limit = 50) {
  try {
    if (fs.existsSync(SYNC_LOG_FILE)) {
      const log = JSON.parse(fs.readFileSync(SYNC_LOG_FILE, 'utf8'));
      return log.slice(-limit).reverse();
    }
  } catch (e) {
    console.error('[MarketplaceSync] Error reading sync log:', e.message);
  }
  return [];
}

/**
 * Generate price comparison table
 */
function generatePriceTable(shopifyProducts, options = {}) {
  const table = [];

  for (const product of shopifyProducts) {
    const basePrice = parseFloat(product.variants?.[0]?.price || product.price || 0);
    const prices = calculateAllPrices(basePrice, options);

    table.push({
      id: product.id,
      title: product.title,
      handle: product.handle,
      sku: product.variants?.[0]?.sku,
      prices,
      margins: {
        etsy: ((prices.etsy - basePrice) / prices.etsy * 100).toFixed(1) + '%',
        ebay: ((prices.ebay - basePrice) / prices.ebay * 100).toFixed(1) + '%',
        amazon: ((prices.amazon - basePrice) / prices.amazon * 100).toFixed(1) + '%'
      }
    });
  }

  return table;
}

module.exports = {
  // Configuration
  PLATFORM_CONFIG,
  getPlatformStatus,

  // Pricing
  calculatePlatformPrice,
  calculateAllPrices,
  generatePriceTable,

  // Sync operations
  syncProduct,
  syncCollection,

  // Status & logging
  getProductSyncStatus,
  getAllSyncedProducts,
  getSyncLog,
  loadProductMap,

  // Utilities
  logSync
};
