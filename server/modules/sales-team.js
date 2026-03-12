/**
 * Sales Team Module
 *
 * Autonomous AI sales team that manages product-line-specific campaigns,
 * promotions, and performance tracking. Each product line (Metal Prints,
 * Multiboard, Apparel/Stickers, Laser/3D/Handmade, Racing) gets its own
 * strategy, channels, and cadence.
 *
 * Features:
 * - Product line campaign definitions with channel routing
 * - Promotion engine (Shopify discount codes, flash sales, bundles)
 * - Daily standup at 9 AM Eastern (Telegram)
 * - Weekly strategy meeting at 10 AM Monday (Telegram)
 * - Seasonal campaign detection (holidays, events)
 * - Performance tracking per product line
 * - Learning journal with outcome tracking
 * - Approval gates for high-discount promotions
 *
 * Flow: GPU Bridge Ollama → Local Ollama fallback (no Claude API)
 */

const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const ollamaClient = require('../lib/ollama-client');
const shopifyAnalytics = require('./shopify-analytics');
const utmAttribution = require('./utm-attribution');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(APP_ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'sales-team.json');

const EASTERN_TZ = 'America/New_York';
const DAILY_REVIEW_HOUR = 9;           // 9 AM Eastern (after marketing standup at 8)
const WEEKLY_PLANNING_HOUR = 10;        // 10 AM Monday Eastern
const SCHEDULER_INTERVAL_MS = 60 * 1000; // 60s tick
const FLASH_SALE_COOLDOWN_HOURS = 72;   // Min gap between flash sales per product line
const APPROVAL_THRESHOLD_PERCENT = 25;  // Discounts > 25% need approval
const MAX_JOURNAL_ENTRIES = 500;
const MAX_MEETING_LOG = 52;
const MAX_ACTIVE_PROMOTIONS = 10;

let _db = null;
let _schedulerTimer = null;

// ============================================================================
// PRODUCT LINE DEFINITIONS
// ============================================================================

const PRODUCT_LINES = {
  'metal-prints': {
    displayName: 'Metal Prints',
    channels: ['facebook', 'instagram'],
    shopifyCollectionHandle: 'metal-prints',
    shopifyProductTypes: ['Metal Print', 'Metal Print Wall Art', 'Metal art'],
    audience: 'Homeowners, interior design enthusiasts, art collectors, car enthusiasts',
    strategies: ['collectionRotation', 'bundleDeals', 'seasonalCampaigns'],
    subCollections: [
      'rally-cars', 'scenic-scapes', 'geoshapes', 'american-light-houses',
      'city-skyline-metal-print-wall-art', 'classic-cars-metal-print-wall-art',
      'coastal-nautical-wall-art', 'farm-country-metal-print-wall-art',
      'f1-race-track-metal-print-wall-art', 'wild-life',
      'space-galaxy-metal-print-wall-art', 'nature-landscape-wall-art'
    ],
    bundleTemplates: [
      { name: 'Gallery Duo', quantity: 2, discountPercent: 15, codePrefix: 'DUO' },
      { name: 'Gallery Trio', quantity: 3, discountPercent: 20, codePrefix: 'TRIO' }
    ],
    defaultDiscountPercent: 10,
    maxDiscountPercent: 25,
    postingCadence: { postsPerWeek: 5, bestDays: ['tuesday', 'thursday', 'saturday'] }
  },

  'multiboard': {
    displayName: 'Multiboard',
    channels: ['facebook', 'facebook-marketplace'],
    shopifyCollectionHandle: 'multiboard-wall-organization',
    shopifyProductTypes: ['multiboard', 'Multiboard', 'Wall Organizer'],
    audience: 'Homeowners, organizers, makers, garage enthusiasts',
    strategies: ['problemSolution', 'starterKitBundles', 'localMarketplace'],
    rooms: ['kitchen', 'garage', 'craft-room', 'office', 'bathroom', 'entryway'],
    bundleTemplates: [
      { name: 'Starter Kit', quantity: 1, discountPercent: 10, codePrefix: 'MBSTART' },
      { name: 'Workshop Bundle', quantity: 3, discountPercent: 15, codePrefix: 'MBWORK' }
    ],
    defaultDiscountPercent: 10,
    maxDiscountPercent: 20,
    localPickup: true,
    postingCadence: { postsPerWeek: 3, bestDays: ['monday', 'wednesday', 'friday'] }
  },

  'apparel-stickers': {
    displayName: 'Apparel & Stickers',
    channels: ['facebook', 'instagram'],
    shopifyCollectionHandle: null,
    shopifyProductTypes: ['tshirt', 'T-Shirt', 'sticker', 'Bumper stickers', 'Decal', 'hoodie', 'hat'],
    audience: 'GenX, Millennials, meme culture, sticker collectors',
    strategies: ['trendDriven', 'flashSales', 'quantityDiscounts'],
    bundleTemplates: [
      { name: 'Sticker 5-Pack', quantity: 5, discountPercent: 15, codePrefix: 'STICK5' },
      { name: 'Tee + Stickers Combo', quantity: 1, discountPercent: 12, codePrefix: 'COMBO' }
    ],
    defaultDiscountPercent: 10,
    maxDiscountPercent: 30,
    postingCadence: { postsPerWeek: 4, bestDays: ['monday', 'wednesday', 'friday', 'sunday'] }
  },

  'laser-3d-handmade': {
    displayName: 'Laser / 3D / Handmade',
    channels: ['facebook-marketplace', 'facebook'],
    shopifyCollectionHandle: 'laser-engraving',
    shopifyProductTypes: ['Keychain', 'Coasters', 'Cutting boards', 'Coasters re-dos'],
    productKeywords: ['laser', 'engrav', '3d print', 'wood', 'handmade', 'custom'],
    audience: 'Gift buyers, couples, corporate buyers, personalization lovers',
    strategies: ['localPickup', 'giftOccasions', 'customOrders', 'ashevilleMade'],
    bundleTemplates: [
      { name: 'Gift Set', quantity: 1, discountPercent: 10, codePrefix: 'GIFT' }
    ],
    defaultDiscountPercent: 10,
    maxDiscountPercent: 20,
    localPickup: true,
    fbMarketplace: { enabled: true, location: 'Asheville, NC', rotationDays: 14 },
    postingCadence: { postsPerWeek: 3, bestDays: ['tuesday', 'thursday', 'saturday'] }
  },

  'racing-sim': {
    displayName: 'Racing & Sim Racing',
    channels: ['facebook', 'instagram'],
    shopifyCollectionHandle: 'racing',
    shopifyProductTypes: ['racing', 'Race Decal', 'Number Kit', 'Livery'],
    productKeywords: ['racing', 'race', 'livery', 'sim', 'scca', 'nasa', 'number kit'],
    audience: 'Amateur racers, SCCA/ARA/NASA competitors, sim racers, Subaru enthusiasts',
    strategies: ['eventDriven', 'crewBundles', 'groupTargeting'],
    bundleTemplates: [
      { name: 'Crew Bundle (5)', quantity: 5, discountPercent: 20, codePrefix: 'CREW' },
      { name: 'Race Weekend Kit', quantity: 1, discountPercent: 15, codePrefix: 'RACEDAY' }
    ],
    defaultDiscountPercent: 10,
    maxDiscountPercent: 25,
    postingCadence: { postsPerWeek: 2, bestDays: ['wednesday', 'friday'] }
  }
};

// ============================================================================
// SEASONAL CALENDAR
// ============================================================================

const SEASONAL_CALENDAR = [
  { name: "Valentine's Day", month: 2, day: 14, leadDays: 14, productLines: ['laser-3d-handmade', 'apparel-stickers', 'metal-prints'] },
  { name: "St. Patrick's Day", month: 3, day: 17, leadDays: 7, productLines: ['apparel-stickers'] },
  { name: 'Race Season Start', month: 3, day: 15, leadDays: 14, productLines: ['racing-sim'] },
  { name: "Mother's Day", month: 5, day: 11, leadDays: 21, productLines: ['laser-3d-handmade', 'metal-prints'] },
  { name: "Father's Day", month: 6, day: 15, leadDays: 21, productLines: ['laser-3d-handmade', 'multiboard', 'racing-sim'] },
  { name: 'Fourth of July', month: 7, day: 4, leadDays: 14, productLines: ['apparel-stickers', 'metal-prints'] },
  { name: 'Back to School', month: 8, day: 15, leadDays: 21, productLines: ['apparel-stickers', 'multiboard'] },
  { name: 'Labor Day', month: 9, day: 1, leadDays: 10, productLines: ['metal-prints', 'apparel-stickers'] },
  { name: 'Halloween', month: 10, day: 31, leadDays: 21, productLines: ['apparel-stickers'] },
  { name: 'Black Friday', month: 11, day: 28, leadDays: 14, productLines: ['metal-prints', 'apparel-stickers', 'laser-3d-handmade', 'multiboard', 'racing-sim'] },
  { name: 'Small Business Saturday', month: 11, day: 29, leadDays: 14, productLines: ['laser-3d-handmade', 'multiboard'] },
  { name: 'Christmas', month: 12, day: 25, leadDays: 30, productLines: ['laser-3d-handmade', 'metal-prints', 'multiboard'] },
  { name: 'New Year', month: 1, day: 1, leadDays: 7, productLines: ['apparel-stickers'] }
];

// ============================================================================
// STATE (persisted to data/sales-team.json)
// ============================================================================

let state = {
  lastDailyReview: null,
  lastWeeklyPlanning: null,
  lastSeasonalCheck: null,
  activePromotions: [],
  cooldowns: {},
  weeklyPlan: null,
  seasonalCampaignsTriggered: [],
  productLinePerformance: {},
  journal: [],
  lastStandup: null,
  lastWeeklyMeeting: null,
  pendingApprovals: [],
  meetingLog: []
};

// ============================================================================
// STATE PERSISTENCE (atomic write)
// ============================================================================

function loadState() {
  try {
    const tmpPath = DATA_FILE + '.tmp';
    if (fs.existsSync(tmpPath) && !fs.existsSync(DATA_FILE)) {
      fs.renameSync(tmpPath, DATA_FILE);
      console.log('[SalesTeam] Recovered state from .tmp file');
    }
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const loaded = JSON.parse(raw);
      state = { ...state, ...loaded };
      console.log('[SalesTeam] State loaded from', DATA_FILE);
    }
  } catch (e) {
    console.error('[SalesTeam] Error loading state:', e.message);
  }
}

function saveState() {
  try {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error('[SalesTeam] Error saving state:', e.message);
  }
}

// ============================================================================
// DATABASE TABLES
// ============================================================================

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sales_campaigns (
      id TEXT PRIMARY KEY,
      product_line TEXT NOT NULL,
      campaign_type TEXT NOT NULL,
      title TEXT NOT NULL,
      discount_code TEXT,
      discount_percent REAL,
      discount_fixed_cents INTEGER,
      shopify_price_rule_id TEXT,
      collection_handle TEXT,
      starts_at TEXT NOT NULL,
      ends_at TEXT,
      status TEXT DEFAULT 'active',
      performance_json TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sc_product_line ON sales_campaigns(product_line)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sc_status ON sales_campaigns(status)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS promotion_redemptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id TEXT NOT NULL,
      order_id TEXT,
      customer_email TEXT,
      revenue_cents INTEGER DEFAULT 0,
      redeemed_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pr_campaign ON promotion_redemptions(campaign_id)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS product_line_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      product_line TEXT NOT NULL,
      revenue_cents INTEGER DEFAULT 0,
      orders INTEGER DEFAULT 0,
      aov_cents INTEGER DEFAULT 0,
      items_sold INTEGER DEFAULT 0,
      top_product TEXT,
      channel_json TEXT,
      UNIQUE(date, product_line)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_plm_date ON product_line_metrics(date)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS sales_journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      type TEXT NOT NULL,
      product_line TEXT,
      action TEXT NOT NULL,
      context TEXT,
      outcome TEXT,
      score REAL,
      tags TEXT
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sj_type ON sales_journal(type)`);
}

// ============================================================================
// TIMEZONE HELPERS
// ============================================================================

function nowEastern() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: EASTERN_TZ }));
}

function getEasternHour() { return nowEastern().getHours(); }
function getEasternDayOfWeek() { return nowEastern().getDay(); }

function todayEasternStr() {
  const d = nowEastern();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function yesterdayEasternStr() {
  const d = nowEastern();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getEasternDateStr(date) {
  const d = new Date(date.toLocaleString('en-US', { timeZone: EASTERN_TZ }));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isWeekday() {
  const dow = getEasternDayOfWeek();
  return dow >= 1 && dow <= 5;
}

// ============================================================================
// TELEGRAM
// ============================================================================

function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return Promise.resolve();

  const postData = JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
      timeout: 10000
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.ok) console.error('[SalesTeam] Telegram error:', parsed.description);
          resolve(parsed);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', (err) => { console.error('[SalesTeam] Telegram error:', err.message); reject(err); });
    req.on('timeout', () => { req.destroy(); reject(new Error('Telegram timeout')); });
    req.write(postData);
    req.end();
  });
}

// ============================================================================
// LLM (Ollama — GPU bridge → local fallback)
// ============================================================================

async function callLLM(systemPrompt, userPrompt, maxTokens = 4096) {
  try {
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];
    const result = await ollamaClient.chat(messages, { temperature: 0.7, timeout: 120000 });
    if (result && result.trim()) {
      return result;
    }
  } catch (e) {
    console.error('[SalesTeam] LLM error:', e.message);
  }
  return null;
}

// ============================================================================
// PRODUCT TYPE → PRODUCT LINE MAPPING
// ============================================================================

function mapProductTypeToLine(productType, title) {
  const pt = (productType || '').toLowerCase();
  const t = (title || '').toLowerCase();

  for (const [lineId, line] of Object.entries(PRODUCT_LINES)) {
    // Check product types
    for (const type of line.shopifyProductTypes) {
      if (pt === type.toLowerCase()) return lineId;
    }
    // Check keywords
    if (line.productKeywords) {
      for (const kw of line.productKeywords) {
        if (t.includes(kw.toLowerCase()) || pt.includes(kw.toLowerCase())) return lineId;
      }
    }
  }
  return 'other';
}

// ============================================================================
// PERFORMANCE DATA COLLECTION
// ============================================================================

async function updateProductLineMetrics(db) {
  const yesterday = yesterdayEasternStr();

  try {
    // Get yesterday's orders with line items
    const orders = db.prepare(`
      SELECT o.shopify_order_id, o.total_price, o.customer_email,
             li.title as item_title, li.product_type, li.quantity, li.price
      FROM shopify_orders o
      LEFT JOIN shopify_order_line_items li ON li.order_id = o.shopify_order_id
      WHERE date(o.created_at) = ?
    `).all(yesterday);

    // Aggregate by product line
    const metrics = {};
    const ordersByLine = {};

    for (const row of orders) {
      const line = mapProductTypeToLine(row.product_type, row.item_title);
      if (!metrics[line]) {
        metrics[line] = { revenue_cents: 0, items_sold: 0, orders: new Set(), top_products: {} };
      }
      const priceCents = Math.round((parseFloat(row.price) || 0) * (row.quantity || 1) * 100);
      metrics[line].revenue_cents += priceCents;
      metrics[line].items_sold += (row.quantity || 1);
      metrics[line].orders.add(row.shopify_order_id);

      const productName = row.item_title || 'Unknown';
      metrics[line].top_products[productName] = (metrics[line].top_products[productName] || 0) + (row.quantity || 1);
    }

    // Insert into DB
    const upsert = db.prepare(`
      INSERT INTO product_line_metrics (date, product_line, revenue_cents, orders, aov_cents, items_sold, top_product)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date, product_line) DO UPDATE SET
        revenue_cents = excluded.revenue_cents,
        orders = excluded.orders,
        aov_cents = excluded.aov_cents,
        items_sold = excluded.items_sold,
        top_product = excluded.top_product
    `);

    for (const [line, data] of Object.entries(metrics)) {
      const orderCount = data.orders.size;
      const aov = orderCount > 0 ? Math.round(data.revenue_cents / orderCount) : 0;
      const topProduct = Object.entries(data.top_products).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

      upsert.run(yesterday, line, data.revenue_cents, orderCount, aov, data.items_sold, topProduct);
    }

    // Update state snapshot
    for (const [line, data] of Object.entries(metrics)) {
      state.productLinePerformance[line] = {
        revenue7d: await get7DayRevenue(db, line),
        orders7d: await get7DayOrders(db, line),
        lastUpdated: new Date().toISOString()
      };
    }

    console.log(`[SalesTeam] Updated metrics for ${yesterday}: ${Object.keys(metrics).length} product lines`);
    return metrics;
  } catch (e) {
    console.error('[SalesTeam] Metrics update error:', e.message);
    return {};
  }
}

function get7DayRevenue(db, productLine) {
  try {
    const row = db.prepare(`
      SELECT COALESCE(SUM(revenue_cents), 0) as total
      FROM product_line_metrics
      WHERE product_line = ? AND date >= date('now', '-7 days')
    `).get(productLine);
    return row?.total || 0;
  } catch { return 0; }
}

function get7DayOrders(db, productLine) {
  try {
    const row = db.prepare(`
      SELECT COALESCE(SUM(orders), 0) as total
      FROM product_line_metrics
      WHERE product_line = ? AND date >= date('now', '-7 days')
    `).get(productLine);
    return row?.total || 0;
  } catch { return 0; }
}

function getProductLinePerformance(productLine, days = 7) {
  if (!_db) return null;
  try {
    const rows = _db.prepare(`
      SELECT date, revenue_cents, orders, aov_cents, items_sold, top_product
      FROM product_line_metrics
      WHERE product_line = ? AND date >= date('now', '-' || ? || ' days')
      ORDER BY date DESC
    `).all(productLine, days);

    const totalRevenue = rows.reduce((s, r) => s + r.revenue_cents, 0);
    const totalOrders = rows.reduce((s, r) => s + r.orders, 0);
    const totalItems = rows.reduce((s, r) => s + r.items_sold, 0);

    // Active campaigns for this line
    const activeCampaigns = state.activePromotions.filter(p => p.productLine === productLine);

    return {
      productLine,
      period: `${days}d`,
      revenue: (totalRevenue / 100).toFixed(2),
      orders: totalOrders,
      aov: totalOrders > 0 ? (totalRevenue / totalOrders / 100).toFixed(2) : '0.00',
      itemsSold: totalItems,
      dailyBreakdown: rows,
      activeCampaigns
    };
  } catch (e) {
    console.error('[SalesTeam] Performance query error:', e.message);
    return null;
  }
}

// ============================================================================
// PROMOTION ENGINE
// ============================================================================

function generatePromoCode(productLine, type) {
  const prefix = {
    'metal-prints': 'METAL',
    'multiboard': 'MB',
    'apparel-stickers': 'STYLE',
    'laser-3d-handmade': 'CRAFT',
    'racing-sim': 'RACE'
  }[productLine] || 'PROMO';

  const suffix = crypto.randomBytes(2).toString('hex').toUpperCase();
  const typeCode = { flash_sale: 'FLASH', bundle: 'BUNDLE', seasonal: 'SEASON', winback: 'BACK', custom: '' }[type] || '';

  return `${prefix}${typeCode}${suffix}`;
}

async function createPromotion(productLine, type, options = {}) {
  const line = PRODUCT_LINES[productLine];
  if (!line) throw new Error(`Unknown product line: ${productLine}`);

  if (state.activePromotions.length >= MAX_ACTIVE_PROMOTIONS) {
    throw new Error('Maximum active promotions reached');
  }

  const discountPercent = options.discountPercent || line.defaultDiscountPercent;
  const durationHours = options.durationHours || (type === 'flash_sale' ? 24 : 168); // 24h flash, 7d default
  const title = options.title || `${line.displayName} ${type.replace(/_/g, ' ')}`;
  const code = options.code || generatePromoCode(productLine, type);

  // Check cooldown for flash sales
  if (type === 'flash_sale') {
    const lastFlash = state.cooldowns[productLine]?.lastFlashSale;
    if (lastFlash) {
      const hoursSince = (Date.now() - new Date(lastFlash).getTime()) / (1000 * 60 * 60);
      if (hoursSince < FLASH_SALE_COOLDOWN_HOURS) {
        const remaining = Math.ceil(FLASH_SALE_COOLDOWN_HOURS - hoursSince);
        throw new Error(`Flash sale cooldown: ${remaining}h remaining for ${line.displayName}`);
      }
    }
  }

  // Approval gate for high discounts
  if (discountPercent > APPROVAL_THRESHOLD_PERCENT) {
    const approvalId = crypto.randomBytes(4).toString('hex');
    const approval = {
      id: approvalId,
      productLine,
      type,
      discountPercent,
      title,
      code,
      options,
      requestedAt: new Date().toISOString()
    };
    state.pendingApprovals.push(approval);
    saveState();

    await sendTelegram(
      `🔒 *APPROVAL NEEDED*\n\n` +
      `${line.displayName}: ${discountPercent}% off (${type})\n` +
      `Code: \`${code}\`\n` +
      `Duration: ${durationHours}h\n\n` +
      `Reply /approve ${approvalId} or /deny ${approvalId}`
    );

    return { status: 'pending_approval', approvalId, code };
  }

  return await executePromotion(productLine, type, { ...options, discountPercent, durationHours, title, code });
}

async function executePromotion(productLine, type, options) {
  const line = PRODUCT_LINES[productLine];
  const { discountPercent, durationHours, title, code } = options;
  const campaignId = crypto.randomBytes(8).toString('hex');

  const startsAt = new Date().toISOString();
  const endsAt = new Date(Date.now() + durationHours * 60 * 60 * 1000).toISOString();

  // Create Shopify discount code
  let shopifyPriceRuleId = null;
  try {
    const shopify = require('../integrations/shopify');
    const result = await shopify.createPercentageDiscount({
      title,
      code,
      percentOff: discountPercent,
      startsAt,
      endsAt,
      oncePerCustomer: true
    });
    shopifyPriceRuleId = result.priceRule?.id ? String(result.priceRule.id) : null;
    console.log(`[SalesTeam] Created Shopify discount: ${code} (${discountPercent}% off, ${durationHours}h)`);
  } catch (e) {
    console.error(`[SalesTeam] Shopify discount creation failed: ${e.message}`);
    // Continue — track the campaign even if Shopify code fails
  }

  // Record in DB
  _db.prepare(`
    INSERT INTO sales_campaigns (id, product_line, campaign_type, title, discount_code,
      discount_percent, shopify_price_rule_id, starts_at, ends_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
  `).run(campaignId, productLine, type, title, code, discountPercent, shopifyPriceRuleId, startsAt, endsAt);

  // Track in state
  const promotion = {
    id: campaignId,
    productLine,
    type,
    code,
    discountPercent,
    title,
    startsAt,
    endsAt,
    shopifyPriceRuleId,
    status: 'active',
    redemptions: 0,
    revenue: 0
  };
  state.activePromotions.push(promotion);

  // Update cooldown
  if (type === 'flash_sale') {
    if (!state.cooldowns[productLine]) state.cooldowns[productLine] = {};
    state.cooldowns[productLine].lastFlashSale = startsAt;
  }

  saveState();

  // Journal entry
  addJournalEntry({
    type: 'decision',
    productLine,
    action: `Created ${type}: ${code} (${discountPercent}% off, ${durationHours}h)`,
    context: title
  });

  return promotion;
}

async function expirePromotions() {
  const now = new Date().toISOString();
  const expired = state.activePromotions.filter(p => p.endsAt && p.endsAt < now && p.status === 'active');

  for (const promo of expired) {
    promo.status = 'completed';

    // Update DB
    try {
      _db.prepare(`UPDATE sales_campaigns SET status = 'completed', updated_at = datetime('now') WHERE id = ?`).run(promo.id);
    } catch (e) { /* ignore */ }

    // Clean up Shopify price rule
    if (promo.shopifyPriceRuleId) {
      try {
        const shopify = require('../integrations/shopify');
        await shopify.deletePriceRule(promo.shopifyPriceRuleId);
      } catch (e) {
        console.warn(`[SalesTeam] Failed to delete price rule ${promo.shopifyPriceRuleId}:`, e.message);
      }
    }

    addJournalEntry({
      type: 'outcome',
      productLine: promo.productLine,
      action: `Promotion expired: ${promo.code}`,
      context: `${promo.redemptions || 0} redemptions, $${((promo.revenue || 0) / 100).toFixed(2)} revenue`
    });

    console.log(`[SalesTeam] Expired promotion: ${promo.code} (${promo.productLine})`);
  }

  // Remove completed from active list
  state.activePromotions = state.activePromotions.filter(p => p.status === 'active');
  if (expired.length > 0) saveState();
}

async function pausePromotion(campaignId) {
  const promo = state.activePromotions.find(p => p.id === campaignId);
  if (!promo) throw new Error('Promotion not found');

  promo.status = 'paused';

  try {
    _db.prepare(`UPDATE sales_campaigns SET status = 'paused', updated_at = datetime('now') WHERE id = ?`).run(campaignId);
  } catch (e) { /* ignore */ }

  if (promo.shopifyPriceRuleId) {
    try {
      const shopify = require('../integrations/shopify');
      await shopify.deletePriceRule(promo.shopifyPriceRuleId);
    } catch (e) { /* ignore */ }
  }

  state.activePromotions = state.activePromotions.filter(p => p.id !== campaignId);
  saveState();
  return { success: true };
}

// ============================================================================
// SEASONAL CAMPAIGN DETECTION
// ============================================================================

async function checkSeasonalCampaigns() {
  const now = nowEastern();
  const currentYear = now.getFullYear();

  for (const event of SEASONAL_CALENDAR) {
    const eventDate = new Date(currentYear, event.month - 1, event.day);
    const leadDate = new Date(eventDate.getTime() - event.leadDays * 24 * 60 * 60 * 1000);
    const eventKey = `${event.name}-${currentYear}`;

    // Check if we're in the lead-up window and haven't triggered yet
    if (now >= leadDate && now <= eventDate && !state.seasonalCampaignsTriggered.includes(eventKey)) {
      const daysUntil = Math.ceil((eventDate - now) / (1000 * 60 * 60 * 24));

      console.log(`[SalesTeam] Seasonal trigger: ${event.name} in ${daysUntil} days`);

      // Ask Ollama to plan the campaign
      const planPrompt = `Plan a ${event.name} sales campaign for these product lines: ${event.productLines.map(l => PRODUCT_LINES[l]?.displayName).join(', ')}.

Context: We are Blue Ridge Custom Co / Swayze Custom Vinyl in Asheville, NC. We sell metal print wall art, custom apparel, stickers, Multiboard organization systems, laser engraving, and racing vinyl.

The event is ${daysUntil} days away. For each product line, suggest:
1. Discount type and percentage (keep between 10-20%)
2. Marketing angle (1 sentence)
3. Best channel to promote on

Return as JSON array:
[{"productLine":"...", "discountPercent": N, "angle":"...", "channel":"..."}]`;

      const plan = await callLLM(
        'You are a sales strategist for a custom printing business. Be practical and specific. Return only valid JSON.',
        planPrompt
      );

      if (plan) {
        try {
          const cleaned = plan.replace(/^```json?\s*/i, '').replace(/```\s*$/i, '').trim();
          const suggestions = JSON.parse(cleaned);
          if (Array.isArray(suggestions)) {
            for (const s of suggestions) {
              const pl = event.productLines.find(l =>
                PRODUCT_LINES[l]?.displayName?.toLowerCase().includes((s.productLine || '').toLowerCase())
              ) || event.productLines[0];

              try {
                await createPromotion(pl, 'seasonal', {
                  discountPercent: Math.min(s.discountPercent || 15, PRODUCT_LINES[pl]?.maxDiscountPercent || 20),
                  durationHours: daysUntil * 24,
                  title: `${event.name} - ${PRODUCT_LINES[pl]?.displayName || pl}`
                });
              } catch (promoErr) {
                console.warn(`[SalesTeam] Seasonal promo creation failed for ${pl}:`, promoErr.message);
              }
            }
          }
        } catch (parseErr) {
          console.warn('[SalesTeam] Could not parse seasonal plan:', parseErr.message);
        }
      }

      // Notify via Telegram
      await sendTelegram(
        `📅 *SEASONAL ALERT: ${event.name}*\n\n` +
        `${daysUntil} days away!\n` +
        `Product lines: ${event.productLines.map(l => PRODUCT_LINES[l]?.displayName).join(', ')}\n` +
        `Promotions ${plan ? 'created' : 'need manual setup'}`
      );

      state.seasonalCampaignsTriggered.push(eventKey);
      saveState();
    }
  }

  // Clean up old seasonal triggers from previous years
  state.seasonalCampaignsTriggered = state.seasonalCampaignsTriggered.filter(k => k.endsWith(`-${currentYear}`));
}

// ============================================================================
// DAILY STANDUP GENERATION
// ============================================================================

async function generateSalesStandup(db) {
  const yesterday = yesterdayEasternStr();
  const today = todayEasternStr();

  // Collect metrics per product line
  const lineMetrics = {};
  let totalRevenue = 0;
  let totalOrders = 0;

  for (const [lineId, line] of Object.entries(PRODUCT_LINES)) {
    try {
      const row = db.prepare(`
        SELECT COALESCE(SUM(revenue_cents), 0) as revenue,
               COALESCE(SUM(orders), 0) as orders,
               COALESCE(SUM(items_sold), 0) as items
        FROM product_line_metrics
        WHERE product_line = ? AND date = ?
      `).get(lineId, yesterday);

      lineMetrics[lineId] = {
        displayName: line.displayName,
        revenue: (row?.revenue || 0) / 100,
        orders: row?.orders || 0,
        items: row?.items || 0
      };
      totalRevenue += (row?.revenue || 0);
      totalOrders += (row?.orders || 0);
    } catch (e) {
      lineMetrics[lineId] = { displayName: line.displayName, revenue: 0, orders: 0, items: 0 };
    }
  }

  // Active promotions summary
  const activePromos = state.activePromotions.map(p => ({
    code: p.code,
    productLine: PRODUCT_LINES[p.productLine]?.displayName || p.productLine,
    discount: `${p.discountPercent}%`,
    expiresIn: p.endsAt ? Math.max(0, Math.ceil((new Date(p.endsAt) - Date.now()) / (1000 * 60 * 60))) + 'h' : 'no expiry'
  }));

  // Upcoming seasonal events (next 30 days)
  const now = nowEastern();
  const upcoming = SEASONAL_CALENDAR.filter(e => {
    const eventDate = new Date(now.getFullYear(), e.month - 1, e.day);
    const daysUntil = Math.ceil((eventDate - now) / (1000 * 60 * 60 * 24));
    return daysUntil > 0 && daysUntil <= 30;
  }).map(e => {
    const eventDate = new Date(now.getFullYear(), e.month - 1, e.day);
    const daysUntil = Math.ceil((eventDate - now) / (1000 * 60 * 60 * 24));
    return `${e.name} (${daysUntil}d)`;
  });

  // Get attribution data (7-day window for context)
  const attribution = utmAttribution.getReport(7);

  // Build data for LLM
  const standupData = {
    date: yesterday,
    totalRevenue: (totalRevenue / 100).toFixed(2),
    totalOrders,
    lineMetrics,
    activePromotions: activePromos,
    upcomingEvents: upcoming,
    pendingApprovals: state.pendingApprovals.length,
    attribution: attribution ? {
      revenueByChannel: attribution.bySource,
      revenueByProductLine: attribution.byProductLineSource,
      topCampaigns: attribution.byCampaign.slice(0, 5)
    } : null
  };

  // Try LLM analysis
  const llmResult = await callLLM(
    `You are the AI Sales Team lead for Blue Ridge Custom Co / Swayze Custom Vinyl in Asheville, NC.
Generate a concise daily sales standup report. Be direct, data-driven, and actionable.
Focus on what's working, what's not, and what to do today.
Keep it under 400 words. Use plain text (this goes to Telegram).`,
    `Here's yesterday's sales data:\n${JSON.stringify(standupData, null, 2)}\n\nGenerate the daily standup. Include revenue by product line, active promotions, and 2-3 specific action items for today.`
  );

  // Format message
  let message = `💼 *SALES TEAM STANDUP — ${yesterday}*\n\n`;

  message += `💰 *REVENUE*: $${(totalRevenue / 100).toFixed(2)} (${totalOrders} orders)\n\n`;

  message += `📊 *BY PRODUCT LINE*\n`;
  for (const [lineId, m] of Object.entries(lineMetrics)) {
    const icon = m.revenue > 0 ? '✅' : '⬜';
    message += `${icon} ${m.displayName}: $${m.revenue.toFixed(2)} (${m.orders} orders)\n`;
  }

  // Attribution breakdown
  if (attribution && attribution.bySource.length > 0) {
    message += `\n📡 *CHANNEL ATTRIBUTION (7d)*\n`;
    for (const row of attribution.bySource.slice(0, 5)) {
      message += `• ${row.source}/${row.medium}: $${row.revenue} (${row.orders})\n`;
    }
  }

  if (activePromos.length > 0) {
    message += `\n🏷️ *ACTIVE PROMOTIONS*\n`;
    for (const p of activePromos) {
      message += `• \`${p.code}\` ${p.productLine} ${p.discount} off (expires: ${p.expiresIn})\n`;
    }
  }

  if (upcoming.length > 0) {
    message += `\n📅 *UPCOMING*: ${upcoming.join(', ')}\n`;
  }

  if (state.pendingApprovals.length > 0) {
    message += `\n🔒 *${state.pendingApprovals.length} pending approval(s)*\n`;
  }

  if (llmResult) {
    // Extract just the action items from LLM
    const actionMatch = llmResult.match(/action\s*items?[:\s]*([\s\S]*?)$/i) ||
                         llmResult.match(/today[:\s]*([\s\S]*?)$/i);
    if (actionMatch) {
      message += `\n📋 *AI RECOMMENDATIONS*\n${actionMatch[1].trim().slice(0, 500)}\n`;
    } else {
      message += `\n📋 *AI ANALYSIS*\n${llmResult.trim().slice(0, 500)}\n`;
    }
  }

  return message;
}

// ============================================================================
// WEEKLY STRATEGY MEETING
// ============================================================================

async function generateWeeklyStrategy(db) {
  // Pull 7-day performance
  const linePerf = {};
  for (const lineId of Object.keys(PRODUCT_LINES)) {
    linePerf[lineId] = getProductLinePerformance(lineId, 7);
  }

  // Pull completed campaigns from last 7 days
  let recentCampaigns = [];
  try {
    recentCampaigns = db.prepare(`
      SELECT * FROM sales_campaigns
      WHERE created_at >= datetime('now', '-7 days')
      ORDER BY created_at DESC
    `).all();
  } catch (e) { /* ignore */ }

  // Pull journal entries from last 7 days
  let recentJournal = [];
  try {
    recentJournal = db.prepare(`
      SELECT * FROM sales_journal
      WHERE timestamp >= datetime('now', '-7 days')
      ORDER BY timestamp DESC
      LIMIT 20
    `).all();
  } catch (e) { /* ignore */ }

  // Get 7-day attribution data for strategy decisions
  const attribution = utmAttribution.getReport(7);

  const weekData = {
    performance: linePerf,
    campaigns: recentCampaigns,
    journal: recentJournal,
    activePromotions: state.activePromotions,
    productLines: Object.entries(PRODUCT_LINES).map(([id, l]) => ({
      id, name: l.displayName, strategies: l.strategies, channels: l.channels
    })),
    channelAttribution: attribution ? {
      bySource: attribution.bySource,
      byProductLineSource: attribution.byProductLineSource,
      topCampaigns: attribution.byCampaign.slice(0, 10)
    } : null
  };

  const llmResult = await callLLM(
    `You are the AI Sales Team strategist for Blue Ridge Custom Co / Swayze Custom Vinyl in Asheville, NC.

Product lines:
- Metal Prints: HD sublimation metal wall art (rally cars, scenic, lighthouses, wildlife, etc.)
- Multiboard: 3D printed modular wall organization (licensed Multiboard reseller)
- Apparel & Stickers: T-shirts, hoodies, vinyl stickers, bumper stickers
- Laser/3D/Handmade: Custom engraved items, keychains, coasters, cutting boards
- Racing & Sim Racing: Custom vinyl liveries, number kits, crew apparel

Key selling points:
- Made locally in Asheville, NC
- "Locally made" is a major differentiator
- $0 ad budget currently — all organic
- Focus on methodical, product-line-specific campaigns

Generate a weekly strategy meeting report with:
1. Performance review per product line (what worked, what didn't)
2. Specific campaign plan for next week per product line (1-2 actions each)
3. Which promotions to create or retire
4. Any product line that needs special attention
Keep it actionable and under 600 words.`,
    `Weekly data:\n${JSON.stringify(weekData, null, 2)}`
  );

  let message = `📊 *WEEKLY SALES STRATEGY — Week of ${todayEasternStr()}*\n\n`;

  if (llmResult) {
    message += llmResult.trim().slice(0, 3500);
  } else {
    // Fallback template
    message += `*Performance Summary (7 days)*\n`;
    for (const [lineId, perf] of Object.entries(linePerf)) {
      if (perf) {
        message += `• ${PRODUCT_LINES[lineId].displayName}: $${perf.revenue} (${perf.orders} orders)\n`;
      }
    }
    message += `\n_LLM unavailable — manual strategy review needed._\n`;
  }

  // Store meeting
  state.meetingLog.push({
    type: 'weekly_strategy',
    date: new Date().toISOString(),
    summary: (llmResult || 'LLM unavailable').slice(0, 2000)
  });
  if (state.meetingLog.length > MAX_MEETING_LOG) {
    state.meetingLog = state.meetingLog.slice(-MAX_MEETING_LOG);
  }

  return message;
}

// ============================================================================
// LEARNING JOURNAL
// ============================================================================

function addJournalEntry(entry) {
  const record = {
    timestamp: new Date().toISOString(),
    type: entry.type || 'observation',
    productLine: entry.productLine || null,
    action: entry.action,
    context: entry.context || null,
    outcome: entry.outcome || null,
    score: entry.score || null,
    tags: entry.tags || null
  };

  state.journal.push(record);
  if (state.journal.length > MAX_JOURNAL_ENTRIES) {
    state.journal = state.journal.slice(-MAX_JOURNAL_ENTRIES);
  }

  // Also persist to DB
  try {
    _db.prepare(`
      INSERT INTO sales_journal (timestamp, type, product_line, action, context, outcome, score, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(record.timestamp, record.type, record.productLine, record.action,
           record.context, record.outcome, record.score, record.tags);
  } catch (e) { /* ignore */ }

  saveState();
}

// ============================================================================
// APPROVAL HANDLING
// ============================================================================

async function approvePromotion(approvalId) {
  const idx = state.pendingApprovals.findIndex(a => a.id === approvalId);
  if (idx === -1) return { error: 'Approval not found' };

  const approval = state.pendingApprovals.splice(idx, 1)[0];
  const result = await executePromotion(approval.productLine, approval.type, {
    discountPercent: approval.discountPercent,
    durationHours: approval.options?.durationHours || 168,
    title: approval.title,
    code: approval.code
  });

  saveState();
  await sendTelegram(`✅ Approved: \`${approval.code}\` (${approval.discountPercent}% off ${PRODUCT_LINES[approval.productLine]?.displayName})`);
  return result;
}

function denyPromotion(approvalId) {
  const idx = state.pendingApprovals.findIndex(a => a.id === approvalId);
  if (idx === -1) return { error: 'Approval not found' };

  const approval = state.pendingApprovals.splice(idx, 1)[0];
  saveState();

  addJournalEntry({
    type: 'decision',
    productLine: approval.productLine,
    action: `Denied promotion: ${approval.code} (${approval.discountPercent}% off)`,
    context: 'Owner denied via approval gate'
  });

  return { success: true, denied: approval.code };
}

// ============================================================================
// SCHEDULER
// ============================================================================

function startScheduler(db) {
  _schedulerTimer = setInterval(async () => {
    try {
      const hour = getEasternHour();
      const dayOfWeek = getEasternDayOfWeek();
      const today = todayEasternStr();

      // Daily review at 9 AM (every day)
      if (hour === DAILY_REVIEW_HOUR) {
        const alreadyDone = state.lastDailyReview &&
          getEasternDateStr(new Date(state.lastDailyReview)) === today;
        if (!alreadyDone) {
          console.log('[SalesTeam] Running daily review...');
          await updateProductLineMetrics(db);
          const report = await generateSalesStandup(db);
          if (report) {
            await sendTelegram(report);
            console.log('[SalesTeam] Daily standup sent');
          }
          state.lastDailyReview = new Date().toISOString();
          state.lastStandup = new Date().toISOString();
          saveState();
        }
      }

      // Weekly planning at 10 AM Monday
      if (hour === WEEKLY_PLANNING_HOUR && dayOfWeek === 1) {
        const alreadyDone = state.lastWeeklyPlanning &&
          getEasternDateStr(new Date(state.lastWeeklyPlanning)) === today;
        if (!alreadyDone) {
          console.log('[SalesTeam] Running weekly strategy meeting...');
          const report = await generateWeeklyStrategy(db);
          if (report) {
            await sendTelegram(report);
            console.log('[SalesTeam] Weekly strategy sent');
          }
          state.lastWeeklyPlanning = new Date().toISOString();
          state.lastWeeklyMeeting = new Date().toISOString();
          saveState();
        }
      }

      // Seasonal check daily at noon
      if (hour === 12) {
        const alreadyChecked = state.lastSeasonalCheck &&
          getEasternDateStr(new Date(state.lastSeasonalCheck)) === today;
        if (!alreadyChecked) {
          await checkSeasonalCampaigns();
          state.lastSeasonalCheck = new Date().toISOString();
          saveState();
        }
      }

      // Expire promotions every tick
      await expirePromotions();
    } catch (e) {
      console.error('[SalesTeam] Scheduler error:', e.message);
    }
  }, SCHEDULER_INTERVAL_MS);

  if (_schedulerTimer.unref) _schedulerTimer.unref();
  console.log('[SalesTeam] Scheduler started (60s interval)');
}

// ============================================================================
// STATUS
// ============================================================================

function getStatus() {
  return {
    status: 'running',
    lastStandup: state.lastStandup,
    lastWeeklyMeeting: state.lastWeeklyMeeting,
    lastSeasonalCheck: state.lastSeasonalCheck,
    activePromotions: state.activePromotions.length,
    pendingApprovals: state.pendingApprovals.length,
    journalEntries: state.journal.length,
    productLines: Object.keys(PRODUCT_LINES).map(id => ({
      id,
      name: PRODUCT_LINES[id].displayName,
      channels: PRODUCT_LINES[id].channels,
      performance: state.productLinePerformance[id] || null
    }))
  };
}

// ============================================================================
// API ROUTE HANDLER
// ============================================================================

function handleRoute(pathname, req, res, db) {
  const { sendJson, sendError, parseBody } = require('../utils/http');

  // GET /api/sales-team/status
  if (req.method === 'GET' && pathname === '/api/sales-team/status') {
    sendJson(res, 200, getStatus());
    return true;
  }

  // GET /api/sales-team/campaigns?status=active&productLine=metal-prints
  if (req.method === 'GET' && pathname === '/api/sales-team/campaigns') {
    try {
      const url = new URL(req.url, 'http://localhost');
      const status = url.searchParams.get('status');
      const productLine = url.searchParams.get('productLine');

      let sql = 'SELECT * FROM sales_campaigns WHERE 1=1';
      const params = [];
      if (status) { sql += ' AND status = ?'; params.push(status); }
      if (productLine) { sql += ' AND product_line = ?'; params.push(productLine); }
      sql += ' ORDER BY created_at DESC LIMIT 50';

      const campaigns = db.prepare(sql).all(...params);
      sendJson(res, 200, { campaigns });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  // GET /api/sales-team/promotions/active
  if (req.method === 'GET' && pathname === '/api/sales-team/promotions/active') {
    sendJson(res, 200, { promotions: state.activePromotions });
    return true;
  }

  // POST /api/sales-team/promotion/create
  if (req.method === 'POST' && pathname === '/api/sales-team/promotion/create') {
    (async () => {
      try {
        const body = await parseBody(req);
        const { productLine, type, discountPercent, durationHours, title, code } = body;
        if (!productLine || !type) {
          sendJson(res, 400, { error: 'productLine and type required' });
          return;
        }
        const result = await createPromotion(productLine, type, { discountPercent, durationHours, title, code });
        sendJson(res, 201, result);
      } catch (e) {
        sendJson(res, 400, { error: e.message });
      }
    })();
    return true;
  }

  // POST /api/sales-team/campaign/:id/pause
  if (req.method === 'POST' && pathname.match(/^\/api\/sales-team\/campaign\/[^/]+\/pause$/)) {
    const id = pathname.split('/')[4];
    pausePromotion(id)
      .then(r => sendJson(res, 200, r))
      .catch(e => sendJson(res, 400, { error: e.message }));
    return true;
  }

  // POST /api/sales-team/approval/:id/approve
  if (req.method === 'POST' && pathname.match(/^\/api\/sales-team\/approval\/[^/]+\/approve$/)) {
    const id = pathname.split('/')[4];
    approvePromotion(id)
      .then(r => sendJson(res, 200, r))
      .catch(e => sendJson(res, 400, { error: e.message }));
    return true;
  }

  // POST /api/sales-team/approval/:id/deny
  if (req.method === 'POST' && pathname.match(/^\/api\/sales-team\/approval\/[^/]+\/deny$/)) {
    const id = pathname.split('/')[4];
    sendJson(res, 200, denyPromotion(id));
    return true;
  }

  // GET /api/sales-team/performance/:productLine
  if (req.method === 'GET' && pathname.match(/^\/api\/sales-team\/performance\/[^/]+$/)) {
    const productLine = pathname.split('/')[4];
    const url = new URL(req.url, 'http://localhost');
    const days = parseInt(url.searchParams.get('days') || '7', 10);
    const perf = getProductLinePerformance(productLine, days);
    if (perf) {
      sendJson(res, 200, perf);
    } else {
      sendJson(res, 404, { error: `Unknown product line: ${productLine}` });
    }
    return true;
  }

  // GET /api/sales-team/product-lines
  if (req.method === 'GET' && pathname === '/api/sales-team/product-lines') {
    sendJson(res, 200, { productLines: PRODUCT_LINES });
    return true;
  }

  // POST /api/sales-team/standup — trigger manual standup
  if (req.method === 'POST' && pathname === '/api/sales-team/standup') {
    (async () => {
      try {
        await updateProductLineMetrics(db);
        const report = await generateSalesStandup(db);
        if (report) await sendTelegram(report);
        sendJson(res, 200, { sent: true, report });
      } catch (e) {
        sendJson(res, 500, { error: e.message });
      }
    })();
    return true;
  }

  // POST /api/sales-team/meeting — trigger manual weekly meeting
  if (req.method === 'POST' && pathname === '/api/sales-team/meeting') {
    (async () => {
      try {
        const report = await generateWeeklyStrategy(db);
        if (report) await sendTelegram(report);
        sendJson(res, 200, { sent: true, report });
      } catch (e) {
        sendJson(res, 500, { error: e.message });
      }
    })();
    return true;
  }

  return false;
}

// ============================================================================
// INIT
// ============================================================================

function init(db) {
  console.log('[SalesTeam] Initializing...');
  _db = db;
  loadState();
  ensureTables(_db);
  startScheduler(_db);

  // Initial metrics collection after a delay
  setTimeout(() => {
    updateProductLineMetrics(_db).catch(e =>
      console.error('[SalesTeam] Initial metrics error:', e.message)
    );
  }, 15000);

  console.log('[SalesTeam] Initialized');
  console.log(`[SalesTeam]   Product lines: ${Object.keys(PRODUCT_LINES).length}`);
  console.log(`[SalesTeam]   Active promotions: ${state.activePromotions.length}`);
  console.log(`[SalesTeam]   Last standup: ${state.lastStandup || 'never'}`);
  console.log(`[SalesTeam]   Last weekly: ${state.lastWeeklyMeeting || 'never'}`);
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  init,
  getStatus,
  handleRoute,
  createPromotion,
  pausePromotion,
  approvePromotion,
  denyPromotion,
  getProductLinePerformance,
  generateSalesStandup,
  generateWeeklyStrategy,
  addJournalEntry,
  updateProductLineMetrics,
  PRODUCT_LINES,
  SEASONAL_CALENDAR
};
