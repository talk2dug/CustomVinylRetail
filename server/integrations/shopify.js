const https = require('https');

const SHOP = (
  process.env.SHOPIFY_STORE_DOMAIN ||
  process.env.SHOPIFY_SHOP ||
  ''
).replace(/\/$/, '');
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || process.env.SHOPIFY_ADMIN_TOKEN || '';
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-01';

// Rate limiter: Shopify allows 2 calls/sec with a bucket of 40 requests
// Use 600ms between calls for safety margin
const RATE_LIMIT_MS = 600;
let lastCallTime = 0;
let pendingCalls = [];
let isProcessing = false;

// Collection cache: Avoid redundant lookups during guided exports
// Cache format: { title: { id, handle, timestamp } }
const collectionCache = new Map();
const COLLECTION_CACHE_TTL = 300000; // 5 minutes

async function waitForRateLimit() {
  return new Promise((resolve) => {
    pendingCalls.push(resolve);
    processNextCall();
  });
}

function processNextCall() {
  if (isProcessing || pendingCalls.length === 0) return;

  isProcessing = true;
  const now = Date.now();
  const timeSinceLastCall = now - lastCallTime;
  const waitTime = Math.max(0, RATE_LIMIT_MS - timeSinceLastCall);

  setTimeout(() => {
    lastCallTime = Date.now();
    const resolve = pendingCalls.shift();
    isProcessing = false;
    resolve();
    // Process next call in queue
    processNextCall();
  }, waitTime);
}

function isConfigured() {
  return Boolean(SHOP && TOKEN);
}

function adminUrl(pathname) {
  if (!SHOP) throw new Error('SHOPIFY_SHOP not configured');
  const base = SHOP.startsWith('http') ? SHOP : `https://${SHOP}`;
  const p = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${base}/admin/api/${API_VERSION}${p}`;
}

async function httpJson(method, url, body, _retryCount = 0) {
  // Wait for rate limit before making the call
  await waitForRateLimit();

  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Shopify-Access-Token': TOKEN
      };
      const req = https.request(
        {
          method,
          hostname: u.hostname,
          port: u.port || 443,
          path: u.pathname + (u.search || ''),
          headers
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try { json = JSON.parse(text || '{}'); } catch (_) {}

            // 429 Too Many Requests — back off and retry (max 3 retries)
            if (res.statusCode === 429 && _retryCount < 3) {
              const retryAfter = parseFloat(res.headers['retry-after']) || (2 * (_retryCount + 1));
              console.log(`[Shopify] Rate limited (429), retrying in ${retryAfter}s (attempt ${_retryCount + 1}/3)`);
              setTimeout(() => {
                httpJson(method, url, body, _retryCount + 1).then(resolve).catch(reject);
              }, retryAfter * 1000);
              return;
            }

            if (res.statusCode >= 200 && res.statusCode < 300) {
              // Attach Link header for pagination support
              const result = json || { ok: true };
              if (res.headers.link) {
                result.__linkHeader = res.headers.link;
              }
              resolve(result);
            } else {
              // Build error message - handle objects by JSON stringifying
              let errMsg = `HTTP ${res.statusCode}`;
              if (json) {
                if (json.error) {
                  errMsg = typeof json.error === 'string' ? json.error : JSON.stringify(json.error);
                } else if (json.errors) {
                  errMsg = typeof json.errors === 'string' ? json.errors : JSON.stringify(json.errors);
                }
              } else if (text) {
                errMsg = text;
              }
              const err = new Error(errMsg);
              err.status = res.statusCode;
              err.detail = json || text;
              reject(err);
            }
          });
        }
      );
      req.on('error', reject);
      if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Parse Shopify Link header to extract the next page URL
 */
function parseLinkNext(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

async function graphql(query, variables = {}) {
  if (!isConfigured()) throw new Error('Shopify not configured');

  // Wait for rate limit before making the call
  await waitForRateLimit();

  const url = adminUrl('/graphql.json');
  const payload = JSON.stringify({ query, variables });
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      const req = https.request(
        {
          method: 'POST',
          hostname: u.hostname,
          port: u.port || 443,
          path: u.pathname + (u.search || ''),
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-Shopify-Access-Token': TOKEN }
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try { json = JSON.parse(text || '{}'); } catch (_) {}
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(json || {});
            } else {
              const err = new Error((json && (json.errors || json.error)) || text || `HTTP ${res.statusCode}`);
              err.status = res.statusCode;
              err.detail = json || text;
              reject(err);
            }
          });
        }
      );
      req.on('error', reject);
      req.write(payload);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

async function listPublications() {
  const q = `#graphql
    query ListPublications($first: Int!) {
      publications(first: $first) {
        edges { node { id name } }
      }
    }
  `;
  const data = await graphql(q, { first: 50 });
  const edges = data?.data?.publications?.edges || [];
  return edges.map((e) => e.node).filter(Boolean);
}

function toProductGid(id) {
  const n = Number(id);
  return `gid://shopify/Product/${Number.isFinite(n) ? n : String(id)}`;
}

function toCollectionGid(id) {
  const n = Number(id);
  return `gid://shopify/Collection/${Number.isFinite(n) ? n : String(id)}`;
}

async function publishToPublications(productId, publicationIds = []) {
  if (!Array.isArray(publicationIds) || !publicationIds.length) return { ok: true };
  const gid = toProductGid(productId);

  // Shopify's publishablePublish mutation requires publishing one at a time
  // using the input format with a single publicationId
  const q = `#graphql
    mutation PublishProduct($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) {
        publishable { __typename }
        userErrors { field message }
      }
    }
  `;

  // Build input array with each publication
  const input = publicationIds.map(pubId => ({ publicationId: pubId }));

  const resp = await graphql(q, { id: gid, input });
  const errs = resp?.data?.publishablePublish?.userErrors || [];
  if (errs.length) {
    const msg = errs.map((e) => e.message).join('; ');
    const error = new Error(msg || 'publishablePublish failed');
    error.detail = errs;
    throw error;
  }
  return { ok: true };
}

async function publishEverywhere(productId) {
  try {
    const wantedNames = (process.env.SHOPIFY_PUBLISH_TARGETS || 'Online Store,Shop,Facebook,Instagram,TikTok,Point of Sale').split(/[,|]/).map((s) => s.trim()).filter(Boolean);
    console.log(`[Shopify Publish] Attempting to publish product ${productId} to: ${wantedNames.join(', ')}`);
    const pubs = await listPublications().catch((e) => {
      console.error(`[Shopify Publish] Failed to list publications: ${e?.message}`);
      return [];
    });
    console.log(`[Shopify Publish] Available publications: ${pubs.map(p => p.name).join(', ') || 'NONE'}`);
    const wanted = pubs.filter((p) => wantedNames.some((n) => p.name && p.name.toLowerCase().includes(n.toLowerCase())));
    console.log(`[Shopify Publish] Matched publications: ${wanted.map(p => p.name).join(', ') || 'NONE'}`);
    if (!wanted.length) {
      console.warn(`[Shopify Publish] No matching publications found for product ${productId}`);
      return { ok: true, details: 'No matching publications or insufficient access.' };
    }
    await publishToPublications(productId, wanted.map((w) => w.id));
    console.log(`[Shopify Publish] ✓ Successfully published product ${productId} to ${wanted.length} channels`);
    return { ok: true, count: wanted.length };
  } catch (e) {
    console.error(`[Shopify Publish] ✗ Failed to publish product ${productId}: ${e?.message}`);
    return { ok: false, error: e?.message || String(e) };
  }
}

// Publish a collection to all sales channels
async function publishCollectionToPublications(collectionId, publicationIds = []) {
  if (!Array.isArray(publicationIds) || !publicationIds.length) return { ok: true };
  const gid = toCollectionGid(collectionId);

  const q = `#graphql
    mutation PublishCollection($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) {
        publishable { __typename }
        userErrors { field message }
      }
    }
  `;

  const input = publicationIds.map(pubId => ({ publicationId: pubId }));
  const resp = await graphql(q, { id: gid, input });
  const errs = resp?.data?.publishablePublish?.userErrors || [];
  if (errs.length) {
    const msg = errs.map((e) => e.message).join('; ');
    const error = new Error(msg || 'publishablePublish failed for collection');
    error.detail = errs;
    throw error;
  }
  return { ok: true };
}

async function publishCollectionEverywhere(collectionId) {
  try {
    const wantedNames = (process.env.SHOPIFY_PUBLISH_TARGETS || 'Online Store,Shop,Facebook,Instagram,TikTok,Point of Sale').split(/[,|]/).map((s) => s.trim()).filter(Boolean);
    console.log(`[Shopify Publish] Attempting to publish collection ${collectionId} to: ${wantedNames.join(', ')}`);
    const pubs = await listPublications().catch((e) => {
      console.error(`[Shopify Publish] Failed to list publications: ${e?.message}`);
      return [];
    });
    console.log(`[Shopify Publish] Available publications: ${pubs.map(p => p.name).join(', ') || 'NONE'}`);
    const wanted = pubs.filter((p) => wantedNames.some((n) => p.name && p.name.toLowerCase().includes(n.toLowerCase())));
    console.log(`[Shopify Publish] Matched publications: ${wanted.map(p => p.name).join(', ') || 'NONE'}`);
    if (!wanted.length) {
      console.warn(`[Shopify Publish] No matching publications found for collection ${collectionId}`);
      return { ok: true, details: 'No matching publications or insufficient access.' };
    }
    await publishCollectionToPublications(collectionId, wanted.map((w) => w.id));
    console.log(`[Shopify Publish] ✓ Successfully published collection ${collectionId} to ${wanted.length} channels`);
    return { ok: true, count: wanted.length };
  } catch (e) {
    console.error(`[Shopify Publish] ✗ Failed to publish collection ${collectionId}: ${e?.message}`);
    return { ok: false, error: e?.message || String(e) };
  }
}

async function createShopifyMetafields(productId, marketingProfile) {
  if (!isConfigured()) throw new Error('Shopify not configured');
  const payload = {
    metafield: {
      namespace: 'marketing',
      key: 'marketing_profile',
      type: 'json',
      value: JSON.stringify(marketingProfile || {})
    }
  };
  const url = adminUrl(`/products/${encodeURIComponent(productId)}/metafields.json`);
  const res = await httpJson('POST', url, payload);
  return res?.metafield || res;
}

async function getShopifyMetafields(productId) {
  if (!isConfigured()) throw new Error('Shopify not configured');
  const url = adminUrl(`/products/${encodeURIComponent(productId)}/metafields.json`);
  const res = await httpJson('GET', url);
  const list = Array.isArray(res?.metafields) ? res.metafields : [];
  const out = {};
  list
    .filter((m) => String(m.namespace) === 'marketing')
    .forEach((m) => {
      if (m.key === 'marketing_profile') {
        try {
          out.marketing_profile = typeof m.value === 'string' ? JSON.parse(m.value || '{}') : m.value;
        } catch (_) {
          out.marketing_profile = {};
        }
      } else {
        out[m.key] = m.value;
      }
    });
  return out;
}

async function getProductCollections(productId) {
  if (!isConfigured()) throw new Error('Shopify not configured');
  // Use collects API to find collections for a product
  const url = adminUrl(`/collects.json?product_id=${encodeURIComponent(productId)}`);
  const res = await httpJson('GET', url);
  const collects = Array.isArray(res?.collects) ? res.collects : [];
  return collects.map((c) => ({ id: c.collection_id }));
}

async function getCollectionMetafields(collectionId) {
  if (!isConfigured()) throw new Error('Shopify not configured');
  const url = adminUrl(`/collections/${encodeURIComponent(collectionId)}/metafields.json`);
  const res = await httpJson('GET', url);
  const list = Array.isArray(res?.metafields) ? res.metafields : [];
  const out = {};
  list
    .filter((m) => String(m.namespace) === 'marketing')
    .forEach((m) => {
      if (m.key === 'marketing_profile') {
        try {
          out.marketing_profile = typeof m.value === 'string' ? JSON.parse(m.value || '{}') : m.value;
        } catch (_) {
          out.marketing_profile = {};
        }
      } else {
        out[m.key] = m.value;
      }
    });
  return out;
}

async function createCollectionMetafields(collectionId, marketingProfile) {
  if (!isConfigured()) throw new Error('Shopify not configured');
  const payload = {
    metafield: {
      namespace: 'marketing',
      key: 'marketing_profile',
      type: 'json',
      value: JSON.stringify(marketingProfile || {})
    }
  };
  const url = adminUrl(`/collections/${encodeURIComponent(collectionId)}/metafields.json`);
  const res = await httpJson('POST', url, payload);
  return res?.metafield || res;
}

async function listCollectionMetafieldEntries(collectionId) {
  if (!isConfigured()) throw new Error('Shopify not configured');
  const url = adminUrl(`/collections/${encodeURIComponent(collectionId)}/metafields.json`);
  const res = await httpJson('GET', url);
  const entries = Array.isArray(res?.metafields) ? res.metafields : [];
  return entries;
}

async function upsertCollectionMetafield(collectionId, { namespace, key, value, type = 'single_line_text_field' }) {
  if (!isConfigured()) throw new Error('Shopify not configured');
  if (!namespace || !key) throw new Error('Namespace and key are required for metafields.');
  const payload = { metafield: { namespace, key, type, value: value == null ? '' : String(value) } };
  const existing = await listCollectionMetafieldEntries(collectionId);
  const match = existing.find((mf) => String(mf.namespace) === namespace && String(mf.key) === key);
  if (match && match.id) {
    const updateUrl = adminUrl(`/metafields/${encodeURIComponent(match.id)}.json`);
    return httpJson('PUT', updateUrl, payload);
  }
  const createUrl = adminUrl(`/collections/${encodeURIComponent(collectionId)}/metafields.json`);
  return httpJson('POST', createUrl, payload);
}

async function listCollections({ title = '', limit = 20 } = {}) {
  if (!isConfigured()) throw new Error('Shopify not configured');
  const lim = Math.max(1, Math.min(250, Number(limit) || 20));
  const search = title ? `&title=${encodeURIComponent(title)}` : '';
  const urlCustom = adminUrl(`/custom_collections.json?limit=${lim}${search}`);
  const urlSmart = adminUrl(`/smart_collections.json?limit=${lim}${search}`);
  const [custom, smart] = await Promise.all([
    httpJson('GET', urlCustom).catch(() => ({})),
    httpJson('GET', urlSmart).catch(() => ({}))
  ]);
  const a = Array.isArray(custom?.custom_collections) ? custom.custom_collections : [];
  const b = Array.isArray(smart?.smart_collections) ? smart.smart_collections : [];
  return a
    .concat(b)
    .map((c) => ({
      id: c.id,
      title: c.title,
      handle: c.handle,
      updated_at: c.updated_at,
      products_count: c.products_count,
      image: c.image ? { src: c.image.src, alt: c.image.alt, width: c.image.width, height: c.image.height } : null
    }))
    .sort((x, y) => String(y.updated_at || '').localeCompare(String(x.updated_at || '')));
}

module.exports = {
  isConfigured,
  adminUrl,
  httpJson,
  getAsset,
  createProductGraphql,
  // Orders
  getOrder,
  addOrderTags,
  setOrderNoteAttributes,
  createFulfillment,
  createShopifyMetafields,
  getShopifyMetafields,
  getProductCollections,
  getCollectionMetafields,
  createCollectionMetafields,
  listCollectionMetafieldEntries,
  upsertCollectionMetafield,
  listCollections,
  listThemes,
  getMainThemeId,
  putAsset,
  findCustomCollectionByTitle,
  createCustomCollection,
  updateCustomCollection,
  createProduct,
  addProductToCollection,
  graphql,
  listPublications,
  publishToPublications,
  publishEverywhere,
  publishCollectionToPublications,
  publishCollectionEverywhere,
  findProductCategoryIdByName,
  updateProductCategory,
  // New helpers for landing pages/products
  getProduct,
  findPageByTitle,
  createPage,
  updatePage,
  // Inventory + locations
  listLocations,
  setInventoryLevel,
  updateInventoryItemCost,
  connectInventoryItemToLocation,
  adjustInventoryLevel,
  updateInventoryItemTracked,
  updateVariantInventoryManagement,
  updateProduct,
  deleteProduct,
  getCollectionProducts
};

async function listThemes() {
  if (!isConfigured()) throw new Error('Shopify not configured');
  const url = adminUrl('/themes.json');
  const res = await httpJson('GET', url);
  return Array.isArray(res?.themes) ? res.themes : [];
}

async function getMainThemeId() {
  const themes = await listThemes();
  const main = themes.find((t) => String(t.role) === 'main');
  return main?.id || null;
}

async function putAsset(themeId, key, value) {
  if (!isConfigured()) throw new Error('Shopify not configured');
  if (!themeId) throw new Error('themeId required');
  const url = adminUrl(`/themes/${encodeURIComponent(themeId)}/assets.json`);
  const payload = { asset: { key, value } };
  return httpJson('PUT', url, payload);
}

async function getAsset(themeId, key) {
  if (!isConfigured()) throw new Error('Shopify not configured');
  if (!themeId) throw new Error('themeId required');
  const url = adminUrl(`/themes/${encodeURIComponent(themeId)}/assets.json?asset[key]=${encodeURIComponent(key)}`);
  const res = await httpJson('GET', url);
  return res?.asset || null;
}

async function createProductGraphql(input) {
  // input: { title, options: [String], variants: [{ price, options: [String] }] }
  if (!isConfigured()) throw new Error('Shopify not configured');
  const mutation = `#graphql
    mutation productCreate($input: ProductInput!) {
      productCreate(input: $input) {
        product { id }
        userErrors { field message }
      }
    }
  `;
  const resp = await graphql(mutation, { input });
  const errs = resp?.data?.productCreate?.userErrors || [];
  if (errs.length) {
    const err = new Error('productCreate userErrors');
    err.detail = errs;
    err.status = 400;
    throw err;
  }
  const id = resp?.data?.productCreate?.product?.id || null;
  return { id };
}

// --- Orders helpers ---
async function getOrder(orderId) {
  if (!isConfigured()) throw new Error('Shopify not configured');
  const url = adminUrl(`/orders/${encodeURIComponent(orderId)}.json`);
  const res = await httpJson('GET', url);
  return res?.order || res;
}

async function addOrderTags(orderId, tagsToAdd = []) {
  if (!isConfigured()) throw new Error('Shopify not configured');
  if (!Array.isArray(tagsToAdd) || !tagsToAdd.length) return { ok: true };
  const current = await getOrder(orderId).catch(() => null);
  const curTagsCsv = (current && current.tags) || '';
  const set = new Set(
    String(curTagsCsv)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
  tagsToAdd.forEach((t) => set.add(String(t).trim()));
  const nextCsv = Array.from(set.values()).join(', ');
  const payload = { order: { id: Number(orderId), tags: nextCsv } };
  const url = adminUrl(`/orders/${encodeURIComponent(orderId)}.json`);
  const res = await httpJson('PUT', url, payload);
  return res?.order || res;
}

async function setOrderNoteAttributes(orderId, attrs = {}) {
  if (!isConfigured()) throw new Error('Shopify not configured');
  const arr = Object.keys(attrs || {}).map((k) => ({ name: String(k), value: String(attrs[k]) }));
  const payload = { order: { id: Number(orderId), note_attributes: arr } };
  const url = adminUrl(`/orders/${encodeURIComponent(orderId)}.json`);
  const res = await httpJson('PUT', url, payload);
  return res?.order || res;
}

async function createFulfillment({ orderId, locationId, lineItems = [], tracking = {}, notifyCustomer = true } = {}) {
  if (!isConfigured()) throw new Error('Shopify not configured');
  const url = adminUrl(`/orders/${encodeURIComponent(orderId)}/fulfillments.json`);
  const payload = {
    fulfillment: {
      location_id: locationId ? Number(locationId) : undefined,
      notify_customer: Boolean(notifyCustomer),
      line_items: lineItems.map((li) => ({ id: Number(li.id), quantity: Number(li.quantity || 1) })),
      tracking_number: tracking.tracking_number || tracking.number || undefined,
      tracking_company: tracking.tracking_company || tracking.company || undefined,
      tracking_url: tracking.tracking_url || tracking.url || undefined
    }
  };
  const res = await httpJson('POST', url, payload);
  return res?.fulfillment || res;
}

async function findCustomCollectionByTitle(title) {
  if (!isConfigured()) throw new Error('Shopify not configured');

  // Check cache first
  const cacheKey = String(title || '').trim().toLowerCase();
  const cached = collectionCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < COLLECTION_CACHE_TTL)) {
    console.log(`[Collection Cache] Hit for "${title}"`);
    return { id: cached.id, handle: cached.handle, title: cached.title };
  }

  // Cache miss or expired - fetch from Shopify
  const url = adminUrl(`/custom_collections.json?title=${encodeURIComponent(title || '')}&limit=5`);
  const res = await httpJson('GET', url);
  const list = Array.isArray(res?.custom_collections) ? res.custom_collections : [];
  const collection = list.find((c) => (c.title || '').trim().toLowerCase() === cacheKey) || null;

  // Update cache if found
  if (collection) {
    collectionCache.set(cacheKey, {
      id: collection.id,
      handle: collection.handle,
      title: collection.title,
      timestamp: Date.now()
    });
    console.log(`[Collection Cache] Stored "${title}" (ID: ${collection.id})`);
  }

  return collection;
}

async function createCustomCollection(title, options = {}) {
  if (!isConfigured()) throw new Error('Shopify not configured');
  const collectionData = { title };
  // Add optional fields
  if (options.template_suffix) collectionData.template_suffix = options.template_suffix;
  if (options.body_html) collectionData.body_html = options.body_html;
  if (options.image) collectionData.image = options.image;
  const payload = { custom_collection: collectionData };
  const url = adminUrl(`/custom_collections.json`);
  const res = await httpJson('POST', url, payload);
  const collection = res?.custom_collection || res;

  // Add to cache
  if (collection && collection.id) {
    const cacheKey = String(title || '').trim().toLowerCase();
    collectionCache.set(cacheKey, {
      id: collection.id,
      handle: collection.handle,
      title: collection.title,
      timestamp: Date.now()
    });
    console.log(`[Collection Cache] Created and stored "${title}" (ID: ${collection.id})`);
  }

  return collection;
}

async function updateCustomCollection(collectionId, updates) {
  if (!isConfigured()) throw new Error('Shopify not configured');
  if (!collectionId) throw new Error('collectionId required');
  const payload = { custom_collection: updates };
  const url = adminUrl(`/custom_collections/${encodeURIComponent(collectionId)}.json`);
  const res = await httpJson('PUT', url, payload);
  return res?.custom_collection || res;
}

async function createProduct(product) {
  if (!isConfigured()) throw new Error('Shopify not configured');
  const payload = { product };
  const url = adminUrl(`/products.json`);
  const res = await httpJson('POST', url, payload);
  return res?.product || res;
}

async function addProductToCollection(productId, collectionId) {
  if (!isConfigured()) throw new Error('Shopify not configured');
  const payload = { collect: { product_id: Number(productId), collection_id: Number(collectionId) } };
  const url = adminUrl(`/collects.json`);
  const res = await httpJson('POST', url, payload);
  return res?.collect || res;
}

async function getProduct(productId) {
  if (!isConfigured()) throw new Error('Shopify not configured');
  const url = adminUrl(`/products/${encodeURIComponent(productId)}.json`);
  const res = await httpJson('GET', url);
  return res?.product || res;
}

async function updateProduct(productId, product) {
  if (!isConfigured()) throw new Error('Shopify not configured');
  const payload = { product: { id: Number(productId), ...product } };
  const url = adminUrl(`/products/${encodeURIComponent(productId)}.json`);
  const res = await httpJson('PUT', url, payload);
  return res?.product || res;
}

// Add image to an existing product
async function addProductImage(productId, imageData) {
  if (!isConfigured()) throw new Error('Shopify not configured');
  // imageData can have: attachment (base64), src (url), filename, alt, position
  const payload = { image: imageData };
  const url = adminUrl(`/products/${encodeURIComponent(productId)}/images.json`);
  const res = await httpJson('POST', url, payload);
  return res?.image || res;
}

// Delete all images from a product
async function deleteProductImages(productId) {
  if (!isConfigured()) throw new Error('Shopify not configured');
  // First get existing images
  const productUrl = adminUrl(`/products/${encodeURIComponent(productId)}.json?fields=images`);
  const productRes = await httpJson('GET', productUrl);
  const images = productRes?.product?.images || [];

  // Delete each image
  for (const img of images) {
    try {
      const deleteUrl = adminUrl(`/products/${encodeURIComponent(productId)}/images/${img.id}.json`);
      await httpJson('DELETE', deleteUrl);
    } catch (e) {
      console.log(`[Shopify] Could not delete image ${img.id}: ${e.message}`);
    }
  }
  return { deleted: images.length };
}

async function deleteProduct(productId) {
  if (!isConfigured()) throw new Error('Shopify not configured');
  const url = adminUrl(`/products/${encodeURIComponent(productId)}.json`);
  await httpJson('DELETE', url);
  return { deleted: true, productId };
}

async function getCollectionProducts(collectionId, { limit = 250 } = {}) {
  if (!isConfigured()) throw new Error('Shopify not configured');
  const url = adminUrl(`/collections/${encodeURIComponent(collectionId)}/products.json?limit=${limit}`);
  const res = await httpJson('GET', url);
  return res?.products || [];
}

async function findPageByTitle(title) {
  if (!isConfigured()) throw new Error('Shopify not configured');
  const url = adminUrl(`/pages.json?title=${encodeURIComponent(title || '')}&limit=5`);
  const res = await httpJson('GET', url);
  const list = Array.isArray(res?.pages) ? res.pages : [];
  return list.find((p) => (p.title || '').trim().toLowerCase() === String(title || '').trim().toLowerCase()) || null;
}

async function createPage({ title, body_html, published = true, template_suffix = '' } = {}) {
  if (!isConfigured()) throw new Error('Shopify not configured');
  const payload = { page: { title, body_html, published } };
  if (template_suffix) payload.page.template_suffix = template_suffix;
  const url = adminUrl(`/pages.json`);
  const res = await httpJson('POST', url, payload);
  return res?.page || res;
}

async function updatePage(pageId, fields = {}) {
  if (!isConfigured()) throw new Error('Shopify not configured');
  const payload = { page: { id: Number(pageId), ...fields } };
  const url = adminUrl(`/pages/${encodeURIComponent(pageId)}.json`);
  const res = await httpJson('PUT', url, payload);
  return res?.page || res;
}

async function listLocations() {
  if (!isConfigured()) throw new Error('Shopify not configured');
  const url = adminUrl('/locations.json');
  const res = await httpJson('GET', url);
  return Array.isArray(res?.locations) ? res.locations : [];
}

async function setInventoryLevel(inventoryItemId, locationId, available) {
  if (!isConfigured()) throw new Error('Shopify not configured');
  const url = adminUrl('/inventory_levels/set.json');
  const payload = { location_id: Number(locationId), inventory_item_id: Number(inventoryItemId), available: Number(available) };
  const res = await httpJson('POST', url, payload);
  return res;
}

async function updateInventoryItemCost(inventoryItemId, costCents) {
  if (!isConfigured()) throw new Error('Shopify not configured');
  const url = adminUrl(`/inventory_items/${encodeURIComponent(inventoryItemId)}.json`);
  const payload = { inventory_item: { id: Number(inventoryItemId), cost: (Number(costCents || 0) / 100).toFixed(2) } };
  const res = await httpJson('PUT', url, payload);
  return res?.inventory_item || res;
}

async function updateInventoryItemTracked(inventoryItemId, tracked) {
  if (!isConfigured()) throw new Error('Shopify not configured');
  const url = adminUrl(`/inventory_items/${encodeURIComponent(inventoryItemId)}.json`);
  const payload = { inventory_item: { id: Number(inventoryItemId), tracked: Boolean(tracked) } };
  const res = await httpJson('PUT', url, payload);
  return res?.inventory_item || res;
}

async function connectInventoryItemToLocation(inventoryItemId, locationId) {
  if (!isConfigured()) throw new Error('Shopify not configured');
  const url = adminUrl('/inventory_levels/connect.json');
  const payload = { location_id: Number(locationId), inventory_item_id: Number(inventoryItemId) };
  return httpJson('POST', url, payload);
}

async function adjustInventoryLevel(inventoryItemId, locationId, adjustment) {
  if (!isConfigured()) throw new Error('Shopify not configured');
  const url = adminUrl('/inventory_levels/adjust.json');
  const payload = { location_id: Number(locationId), inventory_item_id: Number(inventoryItemId), available_adjustment: Number(adjustment) };
  return httpJson('POST', url, payload);
}

// --- Price Rules & Discount Codes ---

/**
 * Create a price rule for discounts
 * @param {Object} options - Price rule options
 * @returns {Object} Created price rule
 */
async function createPriceRule(options = {}) {
  if (!isConfigured()) throw new Error('Shopify not configured');
  const {
    title,
    target_type = 'line_item',           // 'line_item' or 'shipping_line'
    target_selection = 'all',             // 'all' or 'entitled'
    allocation_method = 'across',         // 'across' or 'each'
    value_type = 'percentage',            // 'percentage' or 'fixed_amount'
    value,                                // negative number (e.g., -15.0 for 15% off)
    customer_selection = 'all',           // 'all' or 'prerequisite'
    starts_at,
    ends_at,
    usage_limit = null,
    once_per_customer = false,
    prerequisite_quantity_range = null,   // { greater_than_or_equal_to: X }
    prerequisite_subtotal_range = null,   // { greater_than_or_equal_to: X }
    entitled_product_ids = [],
    entitled_variant_ids = [],
    entitled_collection_ids = [],
    prerequisite_product_ids = [],
    prerequisite_variant_ids = [],
    prerequisite_collection_ids = [],
    prerequisite_to_entitlement_quantity_ratio = null, // { prerequisite_quantity: X, entitled_quantity: Y }
    allocation_limit = null               // For BXGY, max times discount applies per order
  } = options;

  const priceRule = {
    title: title || `Discount ${Date.now()}`,
    target_type,
    target_selection,
    allocation_method,
    value_type,
    value: String(value),
    customer_selection,
    starts_at: starts_at || new Date().toISOString()
  };

  if (ends_at) priceRule.ends_at = ends_at;
  if (usage_limit) priceRule.usage_limit = usage_limit;
  if (once_per_customer) priceRule.once_per_customer = once_per_customer;
  if (prerequisite_quantity_range) priceRule.prerequisite_quantity_range = prerequisite_quantity_range;
  if (prerequisite_subtotal_range) priceRule.prerequisite_subtotal_range = prerequisite_subtotal_range;
  if (entitled_product_ids.length) priceRule.entitled_product_ids = entitled_product_ids;
  if (entitled_variant_ids.length) priceRule.entitled_variant_ids = entitled_variant_ids;
  if (entitled_collection_ids.length) priceRule.entitled_collection_ids = entitled_collection_ids;
  if (prerequisite_product_ids.length) priceRule.prerequisite_product_ids = prerequisite_product_ids;
  if (prerequisite_variant_ids.length) priceRule.prerequisite_variant_ids = prerequisite_variant_ids;
  if (prerequisite_collection_ids.length) priceRule.prerequisite_collection_ids = prerequisite_collection_ids;
  if (prerequisite_to_entitlement_quantity_ratio) priceRule.prerequisite_to_entitlement_quantity_ratio = prerequisite_to_entitlement_quantity_ratio;
  if (allocation_limit) priceRule.allocation_limit = allocation_limit;

  const url = adminUrl('/price_rules.json');
  const res = await httpJson('POST', url, { price_rule: priceRule });
  return res?.price_rule || res;
}

/**
 * Create a discount code for a price rule
 * @param {number|string} priceRuleId - Price rule ID
 * @param {string} code - Discount code (uppercase, no spaces)
 * @returns {Object} Created discount code
 */
async function createDiscountCode(priceRuleId, code) {
  if (!isConfigured()) throw new Error('Shopify not configured');
  const url = adminUrl(`/price_rules/${encodeURIComponent(priceRuleId)}/discount_codes.json`);
  const res = await httpJson('POST', url, { discount_code: { code: String(code).toUpperCase().replace(/\s+/g, '') } });
  return res?.discount_code || res;
}

/**
 * Delete a price rule (and its associated discount codes)
 * @param {number|string} priceRuleId - Price rule ID
 */
async function deletePriceRule(priceRuleId) {
  if (!isConfigured()) throw new Error('Shopify not configured');
  const url = adminUrl(`/price_rules/${encodeURIComponent(priceRuleId)}.json`);
  await httpJson('DELETE', url);
  return { deleted: true, priceRuleId };
}

/**
 * Get a price rule by ID
 * @param {number|string} priceRuleId - Price rule ID
 * @returns {Object} Price rule
 */
async function getPriceRule(priceRuleId) {
  if (!isConfigured()) throw new Error('Shopify not configured');
  const url = adminUrl(`/price_rules/${encodeURIComponent(priceRuleId)}.json`);
  const res = await httpJson('GET', url);
  return res?.price_rule || res;
}

/**
 * List discount codes for a price rule
 * @param {number|string} priceRuleId - Price rule ID
 * @returns {Array} Discount codes
 */
async function listDiscountCodes(priceRuleId) {
  if (!isConfigured()) throw new Error('Shopify not configured');
  const url = adminUrl(`/price_rules/${encodeURIComponent(priceRuleId)}/discount_codes.json`);
  const res = await httpJson('GET', url);
  return res?.discount_codes || [];
}

/**
 * Create a Buy X Get Y discount for a campaign
 * @param {Object} options
 * @returns {Object} { priceRule, discountCode }
 */
async function createBuyXGetYDiscount(options = {}) {
  const {
    title,
    code,
    collectionId,
    buyQuantity = 2,
    buyVariantIds = [],      // Variants customer must buy (empty = any in collection)
    freeQuantity = 2,
    freeVariantIds = [],     // Variants customer gets free (empty = same as buy)
    startsAt,
    endsAt,
    usageLimit = null,
    oncePerCustomer = true
  } = options;

  // For BXGY, we use:
  // - target_type: 'line_item'
  // - target_selection: 'entitled'
  // - value_type: 'percentage'
  // - value: '-100.0' (100% off the free items)
  // - allocation_method: 'each'
  // - prerequisite_to_entitlement_quantity_ratio for the X:Y ratio

  const priceRuleOptions = {
    title: title || `Buy ${buyQuantity} Get ${freeQuantity} Free`,
    target_type: 'line_item',
    target_selection: 'entitled',
    allocation_method: 'each',
    value_type: 'percentage',
    value: '-100.0',  // 100% off (free)
    customer_selection: 'all',
    starts_at: startsAt || new Date().toISOString(),
    ends_at: endsAt || null,
    usage_limit: usageLimit,
    once_per_customer: oncePerCustomer,
    prerequisite_to_entitlement_quantity_ratio: {
      prerequisite_quantity: buyQuantity,
      entitled_quantity: freeQuantity
    },
    allocation_limit: freeQuantity  // Max free items per order
  };

  // Set prerequisite (what they must buy)
  if (buyVariantIds.length) {
    priceRuleOptions.prerequisite_variant_ids = buyVariantIds;
  } else if (collectionId) {
    priceRuleOptions.prerequisite_collection_ids = [Number(collectionId)];
  }

  // Set entitled (what they get free)
  if (freeVariantIds.length) {
    priceRuleOptions.entitled_variant_ids = freeVariantIds;
  } else if (buyVariantIds.length) {
    // Same as what they buy
    priceRuleOptions.entitled_variant_ids = buyVariantIds;
  } else if (collectionId) {
    priceRuleOptions.entitled_collection_ids = [Number(collectionId)];
  }

  const priceRule = await createPriceRule(priceRuleOptions);

  // Create discount code if provided
  let discountCode = null;
  if (code && priceRule?.id) {
    discountCode = await createDiscountCode(priceRule.id, code);
  }

  return { priceRule, discountCode };
}

/**
 * Create a percentage discount for a campaign
 * @param {Object} options
 * @returns {Object} { priceRule, discountCode }
 */
async function createPercentageDiscount(options = {}) {
  const {
    title,
    code,
    collectionId,
    percentOff = 15,
    minQuantity = 0,
    startsAt,
    endsAt,
    usageLimit = null,
    oncePerCustomer = false
  } = options;

  const priceRuleOptions = {
    title: title || `${percentOff}% Off`,
    target_type: 'line_item',
    target_selection: collectionId ? 'entitled' : 'all',
    allocation_method: 'across',
    value_type: 'percentage',
    value: String(-Math.abs(percentOff)),
    customer_selection: 'all',
    starts_at: startsAt || new Date().toISOString(),
    ends_at: endsAt || null,
    usage_limit: usageLimit,
    once_per_customer: oncePerCustomer
  };

  if (collectionId) {
    priceRuleOptions.entitled_collection_ids = [Number(collectionId)];
  }

  if (minQuantity > 0) {
    priceRuleOptions.prerequisite_quantity_range = { greater_than_or_equal_to: minQuantity };
  }

  const priceRule = await createPriceRule(priceRuleOptions);

  let discountCode = null;
  if (code && priceRule?.id) {
    discountCode = await createDiscountCode(priceRule.id, code);
  }

  return { priceRule, discountCode };
}

/**
 * Create a fixed amount discount for a campaign
 * @param {Object} options
 * @returns {Object} { priceRule, discountCode }
 */
async function createFixedDiscount(options = {}) {
  const {
    title,
    code,
    collectionId,
    amountOff = 5,
    minOrderAmount = 0,
    startsAt,
    endsAt,
    usageLimit = null,
    oncePerCustomer = false
  } = options;

  const priceRuleOptions = {
    title: title || `$${amountOff} Off`,
    target_type: 'line_item',
    target_selection: collectionId ? 'entitled' : 'all',
    allocation_method: 'across',
    value_type: 'fixed_amount',
    value: String(-Math.abs(amountOff)),
    customer_selection: 'all',
    starts_at: startsAt || new Date().toISOString(),
    ends_at: endsAt || null,
    usage_limit: usageLimit,
    once_per_customer: oncePerCustomer
  };

  if (collectionId) {
    priceRuleOptions.entitled_collection_ids = [Number(collectionId)];
  }

  if (minOrderAmount > 0) {
    priceRuleOptions.prerequisite_subtotal_range = { greater_than_or_equal_to: String(minOrderAmount) };
  }

  const priceRule = await createPriceRule(priceRuleOptions);

  let discountCode = null;
  if (code && priceRule?.id) {
    discountCode = await createDiscountCode(priceRule.id, code);
  }

  return { priceRule, discountCode };
}

/**
 * Create a free shipping discount
 * @param {Object} options
 * @returns {Object} { priceRule, discountCode }
 */
async function createFreeShippingDiscount(options = {}) {
  const {
    title,
    code,
    minOrderAmount = 50,
    startsAt,
    endsAt,
    usageLimit = null,
    oncePerCustomer = false
  } = options;

  const priceRuleOptions = {
    title: title || `Free Shipping over $${minOrderAmount}`,
    target_type: 'shipping_line',
    target_selection: 'all',
    allocation_method: 'across',
    value_type: 'percentage',
    value: '-100.0',
    customer_selection: 'all',
    starts_at: startsAt || new Date().toISOString(),
    ends_at: endsAt || null,
    usage_limit: usageLimit,
    once_per_customer: oncePerCustomer
  };

  if (minOrderAmount > 0) {
    priceRuleOptions.prerequisite_subtotal_range = { greater_than_or_equal_to: String(minOrderAmount) };
  }

  const priceRule = await createPriceRule(priceRuleOptions);

  let discountCode = null;
  if (code && priceRule?.id) {
    discountCode = await createDiscountCode(priceRule.id, code);
  }

  return { priceRule, discountCode };
}

// --- Product search/update helpers ---
async function findProductByTag(tag) {
  if (!isConfigured()) throw new Error('Shopify not configured');
  const q = `#graphql
    query FindProduct($query: String!, $first: Int!) {
      products(first: $first, query: $query) {
        edges { node { id handle title variants(first: 100) { edges { node { id title sku option1 option2 inventoryItem { id } } } } } }
      }
    }
  `;
  const query = `tag:${JSON.stringify(String(tag))}`; // ensure quotes for special chars
  const data = await graphql(q, { query, first: 1 });
  const edges = data?.data?.products?.edges || [];
  const node = edges[0]?.node || null;
  if (!node) return null;
  return {
    id: node.id.replace(/.*\//, ''),
    handle: node.handle,
    title: node.title,
    variants: (node.variants?.edges || []).map((e) => ({
      id: e.node.id.replace(/.*\//, ''),
      option1: e.node.option1 || null,
      option2: e.node.option2 || null,
      inventoryItemId: e.node.inventoryItem?.id ? e.node.inventoryItem.id.replace(/.*\//, '') : null
    }))
  };
}

async function updateVariantPrice(variantId, priceCents) {
  if (!isConfigured()) throw new Error('Shopify not configured');
  const url = adminUrl(`/variants/${encodeURIComponent(variantId)}.json`);
  const payload = { variant: { id: Number(variantId), price: (Number(priceCents || 0) / 100).toFixed(2) } };
  const res = await httpJson('PUT', url, payload);
  return res?.variant || res;
}

async function updateVariantInventoryManagement(variantId, management) {
  if (!isConfigured()) throw new Error('Shopify not configured');
  const url = adminUrl(`/variants/${encodeURIComponent(variantId)}.json`);
  const payload = { variant: { id: Number(variantId), inventory_management: String(management || 'shopify') } };
  const res = await httpJson('PUT', url, payload);
  return res?.variant || res;
}

async function listProducts({ limit = 50, since_id } = {}) {
  if (!isConfigured()) throw new Error('Shopify not configured');
  const lim = Math.max(1, Math.min(250, Number(limit) || 50));
  let url = adminUrl(`/products.json?limit=${lim}`);

  // Use cursor-based pagination with since_id if provided
  if (since_id) {
    url += `&since_id=${encodeURIComponent(since_id)}`;
  }

  const res = await httpJson('GET', url);
  const products = Array.isArray(res?.products) ? res.products : [];

  // Return products and the last ID for cursor-based pagination
  const lastId = products.length > 0 ? products[products.length - 1].id : null;
  return { products, lastId };
}

module.exports.findProductByTag = findProductByTag;
module.exports.updateVariantPrice = updateVariantPrice;
module.exports.updateVariantInventoryManagement = updateVariantInventoryManagement;
module.exports.listProducts = listProducts;

// Price rules & discount codes
module.exports.createPriceRule = createPriceRule;
module.exports.createDiscountCode = createDiscountCode;
module.exports.deletePriceRule = deletePriceRule;
module.exports.getPriceRule = getPriceRule;
module.exports.listDiscountCodes = listDiscountCodes;
module.exports.createBuyXGetYDiscount = createBuyXGetYDiscount;
module.exports.createPercentageDiscount = createPercentageDiscount;
module.exports.createFixedDiscount = createFixedDiscount;
module.exports.createFreeShippingDiscount = createFreeShippingDiscount;

// --- Standardized Product Category helpers ---
async function findProductCategoryIdByName(name) {
  if (!name) return null;
  const q = `#graphql
    query Taxonomy($query: String!, $first: Int!) {
      productTaxonomyNodes(query: $query, first: $first) {
        edges { node { id fullName } }
      }
    }
  `;
  try {
    const data = await graphql(q, { query: name, first: 10 });
    const edges = data?.data?.productTaxonomyNodes?.edges || [];
    const match = edges.map((e) => e.node).find((n) => (n.fullName || '').toLowerCase() === String(name).toLowerCase());
    return match?.id || edges[0]?.node?.id || null;
  } catch (_) {
    return null;
  }
}

async function updateProductCategory(productId, categoryId) {
  if (!productId || !categoryId) return { ok: false };
  const gid = toProductGid(productId);
  const q = `#graphql
    mutation SetCategory($id: ID!, $categoryId: ID!) {
      productUpdate(input: { id: $id, productCategory: $categoryId }) {
        product { id }
        userErrors { field message }
      }
    }
  `;
  const resp = await graphql(q, { id: gid, categoryId });
  const errs = resp?.data?.productUpdate?.userErrors || [];
  if (errs.length) {
    const error = new Error(errs.map((e) => e.message).join('; '));
    error.detail = errs;
    throw error;
  }
  return { ok: true };
}

/**
 * List all products with full pagination support
 * Follows Shopify Link header to fetch every page automatically
 */
async function listAllProducts({ limit = 250, collection_id } = {}) {
  let allProducts = [];
  let url = adminUrl(`/products.json?limit=${limit}${collection_id ? `&collection_id=${collection_id}` : ''}`);

  while (url) {
    const resp = await httpJson('GET', url);
    if (resp.products) {
      allProducts = allProducts.concat(resp.products);
    }
    // Follow pagination via Link header
    url = parseLinkNext(resp.__linkHeader) || null;
  }
  console.log(`[Shopify] listAllProducts fetched ${allProducts.length} total products`);
  return allProducts;
}

/**
 * Get inventory levels for a location (or all locations)
 * Returns inventory for all items at the given location
 */
async function getInventoryLevels({ locationId, inventoryItemIds } = {}) {
  if (!isConfigured()) throw new Error('Shopify not configured');
  let url;
  if (inventoryItemIds && inventoryItemIds.length) {
    url = adminUrl(`/inventory_levels.json?inventory_item_ids=${inventoryItemIds.join(',')}&limit=250`);
  } else if (locationId) {
    url = adminUrl(`/inventory_levels.json?location_ids=${locationId}&limit=250`);
  } else {
    throw new Error('Either locationId or inventoryItemIds required');
  }
  const resp = await httpJson('GET', url);
  return resp?.inventory_levels || [];
}

/**
 * Get all orders with pagination (recent first)
 */
async function getAllOrders({ status = 'any', limit = 250, created_at_min } = {}) {
  let allOrders = [];
  let url = adminUrl(`/orders.json?status=${status}&limit=${limit}${created_at_min ? `&created_at_min=${created_at_min}` : ''}`);

  while (url) {
    const resp = await httpJson('GET', url);
    if (resp.orders) {
      allOrders = allOrders.concat(resp.orders);
    }
    url = parseLinkNext(resp.__linkHeader) || null;
  }
  return allOrders;
}

/**
 * Update variant details (price, compare_at_price, inventory, sku)
 */
async function updateVariant(variantId, updates) {
  return await httpJson('PUT', adminUrl(`variants/${variantId}.json`), {
    variant: updates
  });
}

/**
 * Bulk update product tags
 */
async function updateProductTags(productId, tags) {
  return await httpJson('PUT', adminUrl(`products/${productId}.json`), {
    product: { tags: Array.isArray(tags) ? tags.join(', ') : tags }
  });
}

/**
 * Get product with full variant and inventory details
 */
async function getProductFull(productId) {
  const product = await httpJson('GET', adminUrl(`products/${productId}.json?fields=id,title,body_html,vendor,product_type,tags,status,variants,images,handle,metafields_global_title_tag,metafields_global_description_tag`));
  return product?.product;
}

/**
 * Update product with full details
 */
async function updateProductFull(productId, updates) {
  // Shopify REST API accepts these fields
  const allowedFields = [
    'title', 'body_html', 'vendor', 'product_type', 'tags', 'status',
    'handle', 'metafields_global_title_tag', 'metafields_global_description_tag'
  ];

  const product = {};
  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      product[field] = updates[field];
    }
  }

  return await httpJson('PUT', adminUrl(`products/${productId}.json`), { product });
}

/**
 * Update multiple variants at once
 */
async function updateProductVariants(productId, variants) {
  // Each variant should have { id, price, compare_at_price, inventory_quantity, sku }
  return await httpJson('PUT', adminUrl(`products/${productId}.json`), {
    product: { variants }
  });
}

// Export new functions
module.exports.listAllProducts = listAllProducts;
module.exports.getInventoryLevels = getInventoryLevels;
module.exports.getAllOrders = getAllOrders;
module.exports.updateVariant = updateVariant;
module.exports.updateProductTags = updateProductTags;
module.exports.getProductFull = getProductFull;
module.exports.updateProductFull = updateProductFull;
module.exports.updateProductVariants = updateProductVariants;
module.exports.addProductImage = addProductImage;
module.exports.deleteProductImages = deleteProductImages;
