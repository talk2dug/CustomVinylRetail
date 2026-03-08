/**
 * Shopify Analytics Module
 * Pulls sales data, abandoned carts, and customer metrics from Shopify Admin API
 * Used by the Marketing Team orchestrator for funnel analysis and reporting.
 */

const https = require('https');
const { URL } = require('url');

// ---------------------------------------------------------------------------
// Config (from env)
// ---------------------------------------------------------------------------
const SHOP = (
  process.env.SHOPIFY_STORE_DOMAIN ||
  process.env.SHOPIFY_SHOP ||
  ''
).replace(/\/$/, '');
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || process.env.SHOPIFY_ADMIN_TOKEN || '';
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-10';

// ---------------------------------------------------------------------------
// Rate limiter — Shopify REST allows 2 calls/sec (bucket of 40).
// We space calls 600ms apart for safety, same as integrations/shopify.js.
// ---------------------------------------------------------------------------
const RATE_LIMIT_MS = 600;
let lastCallTime = 0;
const pendingCalls = [];
let isProcessing = false;

function waitForRateLimit() {
  return new Promise((resolve) => {
    pendingCalls.push(resolve);
    processNextCall();
  });
}

function processNextCall() {
  if (isProcessing || pendingCalls.length === 0) return;
  isProcessing = true;
  const now = Date.now();
  const wait = Math.max(0, RATE_LIMIT_MS - (now - lastCallTime));
  setTimeout(() => {
    lastCallTime = Date.now();
    const resolve = pendingCalls.shift();
    isProcessing = false;
    resolve();
    processNextCall();
  }, wait);
}

// ---------------------------------------------------------------------------
// Low-level HTTP helpers (Node built-ins only)
// ---------------------------------------------------------------------------
function adminUrl(pathname) {
  const base = SHOP.startsWith('http') ? SHOP : `https://${SHOP}`;
  const p = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${base}/admin/api/${API_VERSION}${p}`;
}

/**
 * Rate-limited GET against the Shopify Admin REST API.
 * Returns { body, linkHeader } so callers can handle pagination.
 */
async function shopifyGet(endpoint) {
  await waitForRateLimit();

  const url = adminUrl(endpoint);
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      const req = https.request(
        {
          method: 'GET',
          hostname: u.hostname,
          port: u.port || 443,
          path: u.pathname + (u.search || ''),
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'X-Shopify-Access-Token': TOKEN,
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try { json = JSON.parse(text || '{}'); } catch (_) { /* ignore */ }
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ body: json || {}, linkHeader: res.headers['link'] || '' });
            } else {
              const err = new Error(
                (json && (json.errors || json.error)) || text || `HTTP ${res.statusCode}`
              );
              err.status = res.statusCode;
              err.detail = json || text;
              reject(err);
            }
          });
        }
      );
      req.on('error', reject);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Parse the RFC 5988 Link header returned by Shopify and extract the "next" URL.
 * Returns the full URL string or null.
 */
function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  const parts = linkHeader.split(',');
  for (const part of parts) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

/**
 * Convert a full next-page URL into a relative endpoint path (with query string)
 * that can be passed to shopifyGet.
 */
function nextLinkToEndpoint(nextUrl) {
  try {
    const u = new URL(nextUrl);
    return u.pathname.replace(`/admin/api/${API_VERSION}`, '') + u.search;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Timezone helpers — Eastern Time (America/New_York)
// ---------------------------------------------------------------------------
const EASTERN_TZ = 'America/New_York';

/** Return an ISO-8601 date string for the start of a given day in Eastern time. */
function easternDayStart(date) {
  const d = new Date(date);
  const str = d.toLocaleDateString('en-CA', { timeZone: EASTERN_TZ }); // YYYY-MM-DD
  return `${str}T00:00:00-05:00`;
}

/** Return an ISO-8601 date string for the end of a given day in Eastern time. */
function easternDayEnd(date) {
  const d = new Date(date);
  const str = d.toLocaleDateString('en-CA', { timeZone: EASTERN_TZ });
  return `${str}T23:59:59-05:00`;
}

/** Get today's date string (YYYY-MM-DD) in Eastern time. */
function todayEastern() {
  return new Date().toLocaleDateString('en-CA', { timeZone: EASTERN_TZ });
}

/** Subtract N days from a Date and return YYYY-MM-DD in Eastern time. */
function daysAgoEastern(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString('en-CA', { timeZone: EASTERN_TZ });
}

/** Get the YYYY-MM-DD string of a Date in Eastern time. */
function dateToEasternStr(date) {
  return new Date(date).toLocaleDateString('en-CA', { timeZone: EASTERN_TZ });
}

// ---------------------------------------------------------------------------
// Core data-fetching functions
// ---------------------------------------------------------------------------

/**
 * Fetch orders for a date range. Handles Shopify pagination (250/page via Link header).
 * @param {string} sinceDate - ISO date or YYYY-MM-DD
 * @param {string} untilDate - ISO date or YYYY-MM-DD
 * @returns {Array} orders
 */
async function getOrders(sinceDate, untilDate) {
  if (!isConfigured()) return [];

  const since = sinceDate.includes('T') ? sinceDate : easternDayStart(sinceDate);
  const until = untilDate.includes('T') ? untilDate : easternDayEnd(untilDate);

  const allOrders = [];
  let endpoint = `/orders.json?status=any&created_at_min=${encodeURIComponent(since)}&created_at_max=${encodeURIComponent(until)}&limit=250`;

  try {
    while (endpoint) {
      const { body, linkHeader } = await shopifyGet(endpoint);
      const orders = body.orders || [];
      allOrders.push(...orders);

      const nextUrl = parseNextLink(linkHeader);
      endpoint = nextUrl ? nextLinkToEndpoint(nextUrl) : null;
    }
  } catch (err) {
    console.error('[shopify-analytics] getOrders error:', err.message);
  }
  return allOrders;
}

/**
 * Get today's orders (Eastern time boundaries).
 */
async function getTodayOrders() {
  const today = todayEastern();
  return getOrders(today, today);
}

/**
 * Get orders for the last N days (including today).
 */
async function getOrdersLastNDays(n) {
  const until = todayEastern();
  const since = daysAgoEastern(n - 1);
  return getOrders(since, until);
}

/**
 * Fetch abandoned checkouts since a given date. Handles pagination.
 * @param {string} sinceDate - ISO date or YYYY-MM-DD
 * @returns {Array} checkouts
 */
async function getAbandonedCheckouts(sinceDate) {
  if (!isConfigured()) return [];

  const since = sinceDate.includes('T') ? sinceDate : easternDayStart(sinceDate);
  const allCheckouts = [];
  let endpoint = `/checkouts.json?created_at_min=${encodeURIComponent(since)}&limit=250`;

  try {
    while (endpoint) {
      const { body, linkHeader } = await shopifyGet(endpoint);
      const checkouts = body.checkouts || [];
      allCheckouts.push(...checkouts);

      const nextUrl = parseNextLink(linkHeader);
      endpoint = nextUrl ? nextLinkToEndpoint(nextUrl) : null;
    }
  } catch (err) {
    console.error('[shopify-analytics] getAbandonedCheckouts error:', err.message);
  }
  return allCheckouts;
}

// ---------------------------------------------------------------------------
// Metric computation helpers
// ---------------------------------------------------------------------------

/**
 * Compute comprehensive funnel metrics from a set of orders and abandoned checkouts.
 */
function computeMetrics(orders, abandonedCheckouts) {
  const orderCount = orders.length;
  const abandonedCount = abandonedCheckouts.length;

  let revenue = 0;
  let itemsSold = 0;
  let newCustomers = 0;
  let returningCustomers = 0;
  const productMap = {}; // name -> { quantity, revenue }
  const categoryMap = {}; // tag/type -> { quantity, revenue }
  const dayMap = {}; // YYYY-MM-DD -> { orders, revenue }

  for (const order of orders) {
    const orderTotal = parseFloat(order.total_price || 0);
    revenue += orderTotal;

    // Customer classification
    const custOrderCount = order.customer && order.customer.orders_count;
    if (custOrderCount === 1) {
      newCustomers++;
    } else {
      returningCustomers++;
    }

    // Day breakdown
    const dayStr = dateToEasternStr(order.created_at);
    if (!dayMap[dayStr]) dayMap[dayStr] = { date: dayStr, orders: 0, revenue: 0 };
    dayMap[dayStr].orders++;
    dayMap[dayStr].revenue += orderTotal;

    // Line items
    const lineItems = order.line_items || [];
    for (const item of lineItems) {
      const qty = item.quantity || 1;
      itemsSold += qty;
      const itemRevenue = parseFloat(item.price || 0) * qty;
      const name = item.title || item.name || 'Unknown';

      // Product aggregation
      if (!productMap[name]) productMap[name] = { name, quantity: 0, revenue: 0 };
      productMap[name].quantity += qty;
      productMap[name].revenue += itemRevenue;

      // Category: use product_type from the variant/product, or parse tags
      const category = extractCategory(item);
      if (category) {
        if (!categoryMap[category]) categoryMap[category] = { category, quantity: 0, revenue: 0 };
        categoryMap[category].quantity += qty;
        categoryMap[category].revenue += itemRevenue;
      }
    }
  }

  // Abandoned cart value
  let abandonedValue = 0;
  for (const checkout of abandonedCheckouts) {
    abandonedValue += parseFloat(checkout.total_price || 0);
  }

  // Top products by quantity (top 10)
  const topProducts = Object.values(productMap)
    .sort((a, b) => b.quantity - a.quantity)
    .slice(0, 10)
    .map((p) => ({ name: p.name, quantity: p.quantity, revenue: round2(p.revenue) }));

  // Top categories
  const topCategories = Object.values(categoryMap)
    .sort((a, b) => b.quantity - a.quantity)
    .map((c) => ({ category: c.category, quantity: c.quantity, revenue: round2(c.revenue) }));

  // Daily breakdown sorted by date
  const byDay = Object.values(dayMap)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({ date: d.date, orders: d.orders, revenue: round2(d.revenue) }));

  const conversionRate =
    orderCount + abandonedCount > 0
      ? round4(orderCount / (orderCount + abandonedCount))
      : 0;

  return {
    orders: orderCount,
    revenue: round2(revenue),
    avgOrderValue: orderCount > 0 ? round2(revenue / orderCount) : 0,
    itemsSold,
    abandonedCarts: abandonedCount,
    abandonedValue: round2(abandonedValue),
    conversionRate,
    topProducts,
    topCategories,
    newCustomers,
    returningCustomers,
    byDay,
  };
}

/**
 * Try to extract a product category from a line item.
 * Shopify line items may carry `product_type` (if the product was fetched with it),
 * or we fall back to parsing `variant_title`, `vendor`, or item properties/tags.
 */
function extractCategory(lineItem) {
  // Some Shopify responses include product_type at the line-item level
  if (lineItem.product_type) return lineItem.product_type;

  // Check item properties for a "category" or "type" key
  const props = lineItem.properties || [];
  for (const prop of props) {
    if (prop.name && /^(category|type|product.type)/i.test(prop.name) && prop.value) {
      return prop.value;
    }
  }

  // Fall back to vendor as a rough category proxy
  if (lineItem.vendor) return lineItem.vendor;

  return null;
}

function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }

// ---------------------------------------------------------------------------
// High-level analytics functions
// ---------------------------------------------------------------------------

/**
 * Compute funnel metrics for a date range.
 */
async function getFunnelMetrics(sinceDate, untilDate) {
  try {
    const [orders, abandonedCheckouts] = await Promise.all([
      getOrders(sinceDate, untilDate),
      getAbandonedCheckouts(sinceDate),
    ]);
    // Filter abandoned checkouts to the same date range (end boundary)
    const untilEnd = untilDate.includes('T') ? untilDate : easternDayEnd(untilDate);
    const filtered = abandonedCheckouts.filter((c) => new Date(c.created_at) <= new Date(untilEnd));
    return computeMetrics(orders, filtered);
  } catch (err) {
    console.error('[shopify-analytics] getFunnelMetrics error:', err.message);
    return emptyMetrics();
  }
}

/**
 * Daily snapshot: today's funnel metrics plus comparisons to yesterday
 * and the same day last week.
 */
async function getDailySnapshot() {
  try {
    const today = todayEastern();
    const yesterday = daysAgoEastern(1);
    const lastWeekSameDay = daysAgoEastern(7);

    const [todayMetrics, yesterdayMetrics, lastWeekMetrics] = await Promise.all([
      getFunnelMetrics(today, today),
      getFunnelMetrics(yesterday, yesterday),
      getFunnelMetrics(lastWeekSameDay, lastWeekSameDay),
    ]);

    return {
      date: today,
      today: todayMetrics,
      vsYesterday: computeDelta(todayMetrics, yesterdayMetrics),
      vsSameDayLastWeek: computeDelta(todayMetrics, lastWeekMetrics),
    };
  } catch (err) {
    console.error('[shopify-analytics] getDailySnapshot error:', err.message);
    return { date: todayEastern(), today: emptyMetrics(), vsYesterday: {}, vsSameDayLastWeek: {} };
  }
}

/**
 * Weekly summary: this week (Mon-today) vs last week, plus top/bottom performers.
 */
async function getWeeklySummary() {
  try {
    const today = todayEastern();
    const todayDate = new Date(today + 'T12:00:00');
    const dayOfWeek = todayDate.getDay(); // 0=Sun
    const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

    const thisWeekStart = daysAgoEastern(daysSinceMonday);
    const lastWeekStart = daysAgoEastern(daysSinceMonday + 7);
    const lastWeekEnd = daysAgoEastern(daysSinceMonday + 1);

    const [thisWeek, lastWeek] = await Promise.all([
      getFunnelMetrics(thisWeekStart, today),
      getFunnelMetrics(lastWeekStart, lastWeekEnd),
    ]);

    // Top performers: products with highest revenue this week
    const topPerformers = (thisWeek.topProducts || []).slice(0, 5);

    // Bottom performers: products with lowest revenue (that sold at least once)
    const bottomPerformers = (thisWeek.topProducts || [])
      .slice()
      .sort((a, b) => a.revenue - b.revenue)
      .slice(0, 5);

    return {
      period: { start: thisWeekStart, end: today },
      thisWeek,
      lastWeek,
      delta: computeDelta(thisWeek, lastWeek),
      topPerformers,
      bottomPerformers,
    };
  } catch (err) {
    console.error('[shopify-analytics] getWeeklySummary error:', err.message);
    return {
      period: {},
      thisWeek: emptyMetrics(),
      lastWeek: emptyMetrics(),
      delta: {},
      topPerformers: [],
      bottomPerformers: [],
    };
  }
}

/**
 * Customer metrics: new vs returning breakdown with totals.
 * @param {string} sinceDate - ISO date or YYYY-MM-DD
 */
async function getCustomerMetrics(sinceDate) {
  try {
    const until = todayEastern();
    const orders = await getOrders(sinceDate, until);

    let newCustomers = 0;
    let returningCustomers = 0;
    const customerIds = new Set();
    const newCustomerIds = new Set();
    const returningCustomerIds = new Set();
    let newRevenue = 0;
    let returningRevenue = 0;

    for (const order of orders) {
      const total = parseFloat(order.total_price || 0);
      const custId = order.customer && order.customer.id;
      const custOrderCount = order.customer && order.customer.orders_count;

      if (custId) customerIds.add(custId);

      if (custOrderCount === 1) {
        newCustomers++;
        newRevenue += total;
        if (custId) newCustomerIds.add(custId);
      } else {
        returningCustomers++;
        returningRevenue += total;
        if (custId) returningCustomerIds.add(custId);
      }
    }

    const totalOrders = newCustomers + returningCustomers;

    return {
      totalOrders,
      uniqueCustomers: customerIds.size,
      newCustomers: {
        orders: newCustomers,
        uniqueCustomers: newCustomerIds.size,
        revenue: round2(newRevenue),
        avgOrderValue: newCustomers > 0 ? round2(newRevenue / newCustomers) : 0,
        pctOfOrders: totalOrders > 0 ? round4(newCustomers / totalOrders) : 0,
      },
      returningCustomers: {
        orders: returningCustomers,
        uniqueCustomers: returningCustomerIds.size,
        revenue: round2(returningRevenue),
        avgOrderValue: returningCustomers > 0 ? round2(returningRevenue / returningCustomers) : 0,
        pctOfOrders: totalOrders > 0 ? round4(returningCustomers / totalOrders) : 0,
      },
    };
  } catch (err) {
    console.error('[shopify-analytics] getCustomerMetrics error:', err.message);
    return {
      totalOrders: 0,
      uniqueCustomers: 0,
      newCustomers: { orders: 0, uniqueCustomers: 0, revenue: 0, avgOrderValue: 0, pctOfOrders: 0 },
      returningCustomers: { orders: 0, uniqueCustomers: 0, revenue: 0, avgOrderValue: 0, pctOfOrders: 0 },
    };
  }
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/** Compute percentage deltas between two metric objects. */
function computeDelta(current, previous) {
  const delta = {};
  const keys = ['orders', 'revenue', 'avgOrderValue', 'itemsSold', 'abandonedCarts', 'conversionRate', 'newCustomers', 'returningCustomers'];
  for (const key of keys) {
    const cur = current[key] || 0;
    const prev = previous[key] || 0;
    delta[key] = {
      current: cur,
      previous: prev,
      change: round2(cur - prev),
      changePct: prev !== 0 ? round2(((cur - prev) / prev) * 100) : cur > 0 ? 100 : 0,
    };
  }
  return delta;
}

/** Return a zeroed-out metrics object for error cases. */
function emptyMetrics() {
  return {
    orders: 0,
    revenue: 0,
    avgOrderValue: 0,
    itemsSold: 0,
    abandonedCarts: 0,
    abandonedValue: 0,
    conversionRate: 0,
    topProducts: [],
    topCategories: [],
    newCustomers: 0,
    returningCustomers: 0,
    byDay: [],
  };
}

/**
 * Check whether Shopify credentials are configured.
 */
function isConfigured() {
  return Boolean(SHOP && TOKEN);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  getOrders,
  getTodayOrders,
  getOrdersLastNDays,
  getAbandonedCheckouts,
  getFunnelMetrics,
  getDailySnapshot,
  getWeeklySummary,
  getCustomerMetrics,
  isConfigured,
};
