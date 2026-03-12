/**
 * UTM Attribution Tracking Module
 *
 * 1. Provides a central `tagUrl(url, params)` helper for all outbound links
 * 2. Parses UTM data from synced Shopify orders (landing_site, referring_site)
 * 3. Stores attribution records and generates per-channel, per-product-line reports
 * 4. Sends daily/weekly Telegram attribution summaries
 *
 * Exports: init(db), handleRoute(), tagUrl(), processNewOrders(), getReport()
 */

const url = require('url');
const TAG = '[UTMAttribution]';

let _db = null;
let _timer = null;

// ---------------------------------------------------------------------------
// URL tagging helper — used by all outbound modules
// ---------------------------------------------------------------------------

/**
 * Append UTM parameters to a URL.
 * @param {string} rawUrl   - Base URL
 * @param {object} params   - { source, medium, campaign, content, term }
 * @returns {string} Tagged URL
 */
function tagUrl(rawUrl, params = {}) {
  try {
    const u = new URL(rawUrl);
    if (params.source)   u.searchParams.set('utm_source', params.source);
    if (params.medium)   u.searchParams.set('utm_medium', params.medium);
    if (params.campaign) u.searchParams.set('utm_campaign', params.campaign);
    if (params.content)  u.searchParams.set('utm_content', params.content);
    if (params.term)     u.searchParams.set('utm_term', params.term);
    return u.toString();
  } catch (e) {
    return rawUrl;
  }
}

// ---------------------------------------------------------------------------
// Database schema
// ---------------------------------------------------------------------------

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS utm_attributions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shopify_order_id TEXT NOT NULL,
      order_number TEXT,
      created_at TEXT,
      total_price REAL DEFAULT 0,
      customer_email TEXT,
      utm_source TEXT,
      utm_medium TEXT,
      utm_campaign TEXT,
      utm_content TEXT,
      utm_term TEXT,
      landing_site TEXT,
      referring_site TEXT,
      source_name TEXT,
      product_line TEXT,
      discount_codes TEXT,
      attributed_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Promotion redemption tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS promotion_attributions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shopify_order_id TEXT NOT NULL,
      discount_code TEXT NOT NULL,
      discount_amount REAL DEFAULT 0,
      order_total REAL DEFAULT 0,
      product_line TEXT,
      created_at TEXT,
      attributed_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_promo_attr_code ON promotion_attributions(discount_code)`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_promo_attr_order_code ON promotion_attributions(shopify_order_id, discount_code)`);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_utm_attr_source ON utm_attributions(utm_source)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_utm_attr_campaign ON utm_attributions(utm_campaign)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_utm_attr_product_line ON utm_attributions(product_line)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_utm_attr_created ON utm_attributions(created_at)`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_utm_attr_order ON utm_attributions(shopify_order_id)`);
}

// ---------------------------------------------------------------------------
// UTM parsing
// ---------------------------------------------------------------------------

function parseUtmFromUrl(rawUrl) {
  if (!rawUrl) return {};
  try {
    const u = new URL(rawUrl, 'https://placeholder.com');
    return {
      utm_source:   u.searchParams.get('utm_source')   || null,
      utm_medium:   u.searchParams.get('utm_medium')    || null,
      utm_campaign: u.searchParams.get('utm_campaign')  || null,
      utm_content:  u.searchParams.get('utm_content')   || null,
      utm_term:     u.searchParams.get('utm_term')      || null
    };
  } catch {
    return {};
  }
}

/**
 * Determine product line from order line items.
 * Matches the PRODUCT_LINES from sales-team.js.
 */
function detectProductLine(order) {
  const lineItems = order.line_items || [];
  const types = lineItems.map(li => (li.product_type || '').toLowerCase());
  const titles = lineItems.map(li => (li.title || '').toLowerCase());
  const tags = (order.tags || '').toLowerCase();

  // Check in priority order
  if (types.some(t => t.includes('multiboard')) || tags.includes('multiboard')) return 'multiboard';
  if (types.some(t => t.includes('metal') || t.includes('print')) || titles.some(t => t.includes('metal print'))) return 'metal-prints';
  if (types.some(t => t.includes('racing') || t.includes('sim')) || tags.includes('racing')) return 'racing-sim';
  if (types.some(t => t.includes('laser') || t.includes('3d') || t.includes('engrav') || t.includes('wood') || t.includes('keychain'))) return 'laser-3d-handmade';
  if (types.some(t => t.includes('apparel') || t.includes('shirt') || t.includes('sticker') || t.includes('hoodie'))) return 'apparel-stickers';

  // Fallback: check titles
  if (titles.some(t => t.includes('multiboard'))) return 'multiboard';
  if (titles.some(t => t.includes('metal print'))) return 'metal-prints';
  if (titles.some(t => t.includes('keychain') || t.includes('laser') || t.includes('engrav'))) return 'laser-3d-handmade';
  if (titles.some(t => t.includes('sticker') || t.includes('shirt'))) return 'apparel-stickers';

  return 'unknown';
}

/**
 * Infer source when no UTM tags are present, using Shopify's own fields.
 */
function inferSource(order) {
  const sourceName = (order.source_name || '').toLowerCase();
  const referringSite = (order.referring_site || '').toLowerCase();
  const landingSite = (order.landing_site || '').toLowerCase();

  if (referringSite.includes('facebook') || referringSite.includes('fb.com') || referringSite.includes('fbclid'))
    return { utm_source: 'facebook', utm_medium: 'social' };
  if (referringSite.includes('instagram'))
    return { utm_source: 'instagram', utm_medium: 'social' };
  if (referringSite.includes('google'))
    return { utm_source: 'google', utm_medium: referringSite.includes('shopping') ? 'shopping' : 'organic' };
  if (referringSite.includes('tiktok'))
    return { utm_source: 'tiktok', utm_medium: 'social' };
  if (referringSite.includes('etsy'))
    return { utm_source: 'etsy', utm_medium: 'marketplace' };
  if (referringSite.includes('ebay'))
    return { utm_source: 'ebay', utm_medium: 'marketplace' };

  if (sourceName === 'pos') return { utm_source: 'pos', utm_medium: 'in-person' };
  if (sourceName === 'shopify_draft_order') return { utm_source: 'manual', utm_medium: 'direct' };
  if (sourceName === 'web' && !referringSite) return { utm_source: 'direct', utm_medium: 'none' };

  return { utm_source: sourceName || 'unknown', utm_medium: 'unknown' };
}

// ---------------------------------------------------------------------------
// Process orders — extract UTM and store attribution
// ---------------------------------------------------------------------------

function processNewOrders() {
  if (!_db) return { processed: 0 };

  // Get all orders not yet attributed
  const unattributed = _db.prepare(`
    SELECT o.shopify_order_id, o.order_number, o.created_at, o.total_price,
           o.customer_email, o.landing_site, o.referring_site, o.source_name,
           o.tags, o.raw_json
    FROM shopify_orders o
    LEFT JOIN utm_attributions a ON o.shopify_order_id = a.shopify_order_id
    WHERE a.id IS NULL
  `).all();

  if (unattributed.length === 0) return { processed: 0 };

  const insertStmt = _db.prepare(`
    INSERT OR IGNORE INTO utm_attributions
      (shopify_order_id, order_number, created_at, total_price, customer_email,
       utm_source, utm_medium, utm_campaign, utm_content, utm_term,
       landing_site, referring_site, source_name, product_line, discount_codes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertPromoStmt = _db.prepare(`
    INSERT OR IGNORE INTO promotion_attributions
      (shopify_order_id, discount_code, discount_amount, order_total, product_line, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let processed = 0;
  let promosTracked = 0;
  const insertAll = _db.transaction((orders) => {
    for (const order of orders) {
      // Try to parse UTM from landing_site first
      let utm = parseUtmFromUrl(order.landing_site);

      // If no UTM tags, try referring_site
      if (!utm.utm_source) {
        utm = parseUtmFromUrl(order.referring_site);
      }

      // If still no UTM, infer from Shopify source data
      if (!utm.utm_source) {
        utm = inferSource(order);
      }

      // Detect product line from raw_json line items
      let rawOrder = {};
      try { rawOrder = JSON.parse(order.raw_json || '{}'); } catch {}
      const productLine = detectProductLine(rawOrder);

      // Extract discount codes from raw order
      const discountCodes = [];
      const discountApps = rawOrder.discount_applications || [];
      const discountCodeObjs = rawOrder.discount_codes || [];
      for (const dc of discountCodeObjs) {
        if (dc.code) discountCodes.push(dc.code.toUpperCase());
      }

      insertStmt.run(
        order.shopify_order_id,
        order.order_number,
        order.created_at,
        order.total_price,
        order.customer_email,
        utm.utm_source || null,
        utm.utm_medium || null,
        utm.utm_campaign || null,
        utm.utm_content || null,
        utm.utm_term || null,
        order.landing_site,
        order.referring_site,
        order.source_name,
        productLine,
        discountCodes.length > 0 ? discountCodes.join(',') : null
      );

      // Track each discount code redemption
      for (const dc of discountCodeObjs) {
        if (dc.code) {
          insertPromoStmt.run(
            order.shopify_order_id,
            dc.code.toUpperCase(),
            parseFloat(dc.amount || 0),
            order.total_price,
            productLine,
            order.created_at
          );
          promosTracked++;
        }
      }

      processed++;
    }
  });

  insertAll(unattributed);
  if (processed > 0) console.log(TAG, `Attributed ${processed} new orders, ${promosTracked} promo redemptions`);
  return { processed, promosTracked };
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

function getReport(days = 30) {
  if (!_db) return null;

  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString();

  // Revenue by source
  const bySource = _db.prepare(`
    SELECT utm_source AS source, utm_medium AS medium,
           COUNT(*) AS orders, ROUND(SUM(total_price), 2) AS revenue,
           ROUND(AVG(total_price), 2) AS avg_order
    FROM utm_attributions
    WHERE created_at >= ?
    GROUP BY utm_source, utm_medium
    ORDER BY revenue DESC
  `).all(sinceStr);

  // Revenue by campaign
  const byCampaign = _db.prepare(`
    SELECT utm_campaign AS campaign, utm_source AS source,
           COUNT(*) AS orders, ROUND(SUM(total_price), 2) AS revenue
    FROM utm_attributions
    WHERE created_at >= ? AND utm_campaign IS NOT NULL
    GROUP BY utm_campaign
    ORDER BY revenue DESC
    LIMIT 20
  `).all(sinceStr);

  // Revenue by product line
  const byProductLine = _db.prepare(`
    SELECT product_line, COUNT(*) AS orders,
           ROUND(SUM(total_price), 2) AS revenue,
           ROUND(AVG(total_price), 2) AS avg_order
    FROM utm_attributions
    WHERE created_at >= ?
    GROUP BY product_line
    ORDER BY revenue DESC
  `).all(sinceStr);

  // Revenue by product line + source (the money query)
  const byProductLineSource = _db.prepare(`
    SELECT product_line, utm_source AS source,
           COUNT(*) AS orders, ROUND(SUM(total_price), 2) AS revenue
    FROM utm_attributions
    WHERE created_at >= ?
    GROUP BY product_line, utm_source
    ORDER BY product_line, revenue DESC
  `).all(sinceStr);

  // Totals
  const totals = _db.prepare(`
    SELECT COUNT(*) AS total_orders, ROUND(SUM(total_price), 2) AS total_revenue,
           ROUND(AVG(total_price), 2) AS avg_order
    FROM utm_attributions
    WHERE created_at >= ?
  `).get(sinceStr);

  return {
    period: `${days} days`,
    since: sinceStr,
    totals: totals || { total_orders: 0, total_revenue: 0, avg_order: 0 },
    bySource,
    byCampaign,
    byProductLine,
    byProductLineSource,
    promotionPerformance: getPromotionPerformance(sinceStr)
  };
}

function getPromotionPerformance(sinceStr) {
  if (!_db) return [];
  try {
    return _db.prepare(`
      SELECT discount_code, COUNT(*) AS redemptions,
             ROUND(SUM(discount_amount), 2) AS total_discounted,
             ROUND(SUM(order_total), 2) AS total_revenue,
             product_line
      FROM promotion_attributions
      WHERE created_at >= ?
      GROUP BY discount_code
      ORDER BY redemptions DESC
      LIMIT 20
    `).all(sinceStr);
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// Telegram report formatting
// ---------------------------------------------------------------------------

function formatTelegramReport(days = 7) {
  const report = getReport(days);
  if (!report || report.totals.total_orders === 0) {
    return `📊 *Attribution Report (${days}d)*\nNo attributed orders in this period.`;
  }

  let msg = `📊 *Attribution Report — Last ${days} Days*\n`;
  msg += `💰 *${report.totals.total_orders} orders • $${report.totals.total_revenue} revenue*\n`;
  msg += `📦 Avg order: $${report.totals.avg_order}\n\n`;

  // By source
  if (report.bySource.length > 0) {
    msg += `*Revenue by Channel:*\n`;
    for (const row of report.bySource) {
      const pct = report.totals.total_revenue > 0
        ? Math.round((row.revenue / report.totals.total_revenue) * 100)
        : 0;
      msg += `• ${row.source}/${row.medium}: $${row.revenue} (${row.orders} orders, ${pct}%)\n`;
    }
    msg += '\n';
  }

  // By product line
  if (report.byProductLine.length > 0) {
    msg += `*Revenue by Product Line:*\n`;
    for (const row of report.byProductLine) {
      msg += `• ${row.product_line}: $${row.revenue} (${row.orders} orders)\n`;
    }
    msg += '\n';
  }

  // Top campaigns
  if (report.byCampaign.length > 0) {
    msg += `*Top Campaigns:*\n`;
    for (const row of report.byCampaign.slice(0, 5)) {
      msg += `• ${row.campaign}: $${row.revenue} (${row.orders} orders)\n`;
    }
  }

  return msg;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

function handleRoute(pathname, req, res, db) {
  // GET /api/attribution/report?days=30
  if (pathname === '/api/attribution/report' && req.method === 'GET') {
    const parsed = new URL(req.url, 'http://localhost');
    const days = parseInt(parsed.searchParams.get('days') || '30', 10);
    const report = getReport(days);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(report));
    return true;
  }

  // GET /api/attribution/telegram-report?days=7
  if (pathname === '/api/attribution/telegram-report' && req.method === 'GET') {
    const parsed = new URL(req.url, 'http://localhost');
    const days = parseInt(parsed.searchParams.get('days') || '7', 10);
    const msg = formatTelegramReport(days);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: msg }));
    return true;
  }

  // POST /api/attribution/process — manually trigger attribution processing
  if (pathname === '/api/attribution/process' && req.method === 'POST') {
    const result = processNewOrders();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return true;
  }

  // GET /api/attribution/status
  if (pathname === '/api/attribution/status') {
    const total = _db ? _db.prepare('SELECT COUNT(*) AS c FROM utm_attributions').get().c : 0;
    const unprocessed = _db ? _db.prepare(`
      SELECT COUNT(*) AS c FROM shopify_orders o
      LEFT JOIN utm_attributions a ON o.shopify_order_id = a.shopify_order_id
      WHERE a.id IS NULL
    `).get().c : 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ running: !!_db, totalAttributed: total, unprocessed }));
    return true;
  }

  return false;
}

function getStatus() {
  if (!_db) return { running: false };
  const total = _db.prepare('SELECT COUNT(*) AS c FROM utm_attributions').get().c;
  return { running: true, totalAttributed: total };
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function init(db) {
  _db = db;
  ensureTables(db);
  console.log(TAG, 'Tables ensured');

  // Process any existing unattributed orders immediately
  const result = processNewOrders();
  console.log(TAG, `Initial processing: ${result.processed} orders attributed`);

  // Run attribution every 5 minutes (picks up newly synced orders)
  _timer = setInterval(() => {
    try { processNewOrders(); } catch (e) { console.error(TAG, 'Processing error:', e.message); }
  }, 5 * 60 * 1000);

  if (_timer.unref) _timer.unref();
  console.log(TAG, 'Initialized (5-min processing interval)');
}

module.exports = {
  init,
  tagUrl,
  getReport,
  getStatus,
  formatTelegramReport,
  processNewOrders,
  handleRoute
};
