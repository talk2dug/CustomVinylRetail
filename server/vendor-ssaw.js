const fetch = global.fetch || require('node-fetch');
const { URL, URLSearchParams } = require('url');

const DEFAULT_BASE_URL = process.env.SSAW_BASE_URL || 'https://api.ssactivewear.com/V2';
const ACCOUNT = process.env.SSAW_ACCOUNT || process.env.SSAW_USER || '';
const API_KEY = process.env.SSAW_API_KEY || process.env.SSAW_PASS || '';
const TIMEOUT_MS = Number(process.env.SSAW_TIMEOUT_MS || 8000);
const CACHE_TTL_MS = Number(process.env.SSAW_CACHE_TTL_MS || 60 * 60 * 1000); // 1h
const INV_TTL_MS = Number(process.env.SSAW_INVENTORY_TTL_MS || 5 * 60 * 1000); // 5m

function isConfigured() {
  return Boolean(ACCOUNT && API_KEY);
}

function authHeader() {
  const creds = Buffer.from(`${ACCOUNT}:${API_KEY}`).toString('base64');
  return `Basic ${creds}`;
}

function buildUrl(pathname, params = {}) {
  const base = DEFAULT_BASE_URL.replace(/\/+$/, '');
  const path = String(pathname || '').replace(/^\/+/, '');
  const u = new URL(`${base}/${path}`);
  const sp = new URLSearchParams(params);
  for (const [k, v] of sp) u.searchParams.set(k, v);
  return u.toString();
}

function withTimeout(promise, ms) {
  let id;
  const timeout = new Promise((_, reject) => {
    id = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([
    promise.finally(() => clearTimeout(id)),
    timeout
  ]);
}

async function getJson(url) {
  const res = await withTimeout(
    fetch(url, {
      headers: {
        Authorization: authHeader(),
        Accept: 'application/json'
      }
    }),
    TIMEOUT_MS
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`SSAW HTTP ${res.status}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return res.json();
}

async function postJson(url, body) {
  const res = await withTimeout(
    fetch(url, {
      method: 'POST',
      headers: {
        Authorization: authHeader(),
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body || {})
    }),
    TIMEOUT_MS
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`SSAW HTTP ${res.status}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  const text = await res.text();
  return { ok: true, text };
}

const cache = new Map(); // key -> { data, expiresAt }

function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data, ttlMs) {
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

function toCdnUrl(path) {
  if (!path) return null;
  if (/^https?:/i.test(path)) return path;
  const p = String(path).replace(/^\/+/, '');
  return `https://cdn.ssactivewear.com/${p}`;
}

function mapCategoryToType(baseCategory = '') {
  const t = String(baseCategory).toLowerCase();
  if (t.includes('hood')) return 'hoodie';
  if (t.includes('t-shirt') || t.includes('tshirts') || t.includes('tee')) return 'tshirt';
  if (t.includes('beanie')) return 'beanie';
  if (t.includes('cap') || t.includes('hat') || t.includes('headwear')) return 'hat';
  if (t.includes('drink')) return 'drinkware';
  if (t.includes('accessor')) return 'accessory';
  return 'tshirt';
}

async function searchStyles({ q = '', brand = '', category = '' } = {}) {
  if (!isConfigured()) throw new Error('SSAW credentials not configured');
  const params = {};
  if (q) params.search = String(q);
  if (brand) params.brand = String(brand);
  if (category) params.category = String(category);
  const url = buildUrl('Styles', params);

  const key = `styles:${JSON.stringify(params)}`;
  const cached = getCache(key);
  if (cached) return cached;
  const json = await getJson(url);
  // json is an array of styles
  const styles = (Array.isArray(json) ? json : []).map((s) => ({
    styleID: s.styleID,
    brandName: s.brandName,
    styleName: s.styleName,
    title: s.title,
    baseCategory: s.baseCategory,
    imageUrl: toCdnUrl(s.styleImage),
    vendor: 'S&S Activewear',
    productType: mapCategoryToType(s.baseCategory)
  }));
  const data = { styles };
  setCache(key, data, CACHE_TTL_MS);
  return data;
}

async function productsByStyle(styleID) {
  if (!isConfigured()) throw new Error('SSAW credentials not configured');
  const id = Number(styleID);
  if (!Number.isFinite(id)) throw new Error('Invalid style id');
  const params = { style: String(id) };
  const url = buildUrl('Products', params);
  const key = `products:${id}`;
  const cached = getCache(key);
  if (cached) return cached;
  const json = await getJson(url);
  const variants = (Array.isArray(json) ? json : []).map((p) => ({
    sku: p.sku,
    color: p.colorName,
    size: p.sizeName,
    imageUrl:
      toCdnUrl(p.colorOnModelFrontImage) ||
      toCdnUrl(p.colorFrontImage) ||
      toCdnUrl(p.colorBackImage) ||
      toCdnUrl(p.colorSwatchImage) ||
      null,
    frontImageUrl:
      toCdnUrl(p.colorOnModelFrontImage) ||
      toCdnUrl(p.colorFrontImage) ||
      null,
    backImageUrl:
      toCdnUrl(p.colorOnModelBackImage) ||
      toCdnUrl(p.colorBackImage) ||
      null,
    vendor: 'S&S Activewear',
    styleID: p.styleID,
    brandName: p.brandName,
    styleName: p.styleName,
    piecePrice: Number(p.piecePrice) || null,
    piecePriceCents: Math.round((Number(p.piecePrice) || 0) * 100),
    qty: Number(p.qty) || 0,
    warehouses: Array.isArray(p.warehouses)
      ? p.warehouses.map((w) => ({ abbr: w.warehouseAbbr || w.abbr || '', qty: Number(w.qty) || 0 }))
      : []
  }));
  const data = { styleID: id, variants };
  setCache(key, data, CACHE_TTL_MS);
  return data;
}

async function inventory({ sku, style, color, size } = {}) {
  if (!isConfigured()) throw new Error('SSAW credentials not configured');
  const params = {};
  if (sku) params.sku = String(sku);
  if (style) params.style = String(style);
  if (color) params.color = String(color);
  if (size) params.size = String(size);
  const url = buildUrl('Inventory', params);
  const key = `inv:${JSON.stringify(params)}`;
  const cached = getCache(key);
  if (cached) return cached;
  const json = await getJson(url);
  const data = { items: Array.isArray(json) ? json : [] };
  setCache(key, data, INV_TTL_MS);
  return data;
}

module.exports = {
  isConfigured,
  searchStyles,
  productsByStyle,
  inventory,
  createOrder: async function createOrder(payload = {}) {
    if (!isConfigured()) throw new Error('SSAW credentials not configured');
    const url = buildUrl('Orders');
    return postJson(url, payload);
  },
  listOrders: async function listOrders({ customerPO = '', orderId = '', from = '', to = '', status = '' } = {}) {
    if (!isConfigured()) throw new Error('SSAW credentials not configured');
    const params = {};
    if (customerPO) params.CustomerPO = String(customerPO);
    if (orderId) params.orderID = String(orderId);
    if (status) params.status = String(status);
    if (from) params.from = String(from);
    if (to) params.to = String(to);
    const url = buildUrl('Orders', params);
    const json = await getJson(url);
    // The API may return a single object or an array; normalize to array
    const orders = Array.isArray(json) ? json : json ? [json] : [];
    return { orders };
  },
  orderById: async function orderById(orderId) {
    if (!isConfigured()) throw new Error('SSAW credentials not configured');
    const id = String(orderId || '').trim();
    if (!id) throw new Error('Missing order id');
    const url = buildUrl('Orders', { orderID: id });
    const json = await getJson(url);
    return { order: json };
  },
  mapCategoryToType
};
