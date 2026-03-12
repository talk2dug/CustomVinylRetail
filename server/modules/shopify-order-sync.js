/**
 * Shopify Order Sync Module
 * Periodically fetches orders, line items, and abandoned checkouts from
 * the Shopify Admin REST API and stores them locally in SQLite.
 *
 * On first run it backfills the last 30 days; subsequent runs fetch only
 * orders created since the last successful sync timestamp.
 *
 * Exports: startSync(db), syncNow(), getLastSync()
 */

const shopifyAnalytics = require('./shopify-analytics');
const salesAnalytics = require('./sales-analytics');

const TAG = '[shopify-order-sync]';
const SYNC_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const BACKFILL_DAYS = 365;

let _db = null;
let _timer = null;
let _syncing = false;
let _lastSync = null; // { timestamp, ordersUpserted, checkoutsUpserted }

// ---------------------------------------------------------------------------
// Database schema
// ---------------------------------------------------------------------------

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shopify_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shopify_order_id TEXT UNIQUE NOT NULL,
      order_number TEXT,
      created_at TEXT,
      total_price REAL DEFAULT 0,
      subtotal_price REAL DEFAULT 0,
      currency TEXT DEFAULT 'USD',
      financial_status TEXT,
      fulfillment_status TEXT,
      customer_email TEXT,
      customer_id TEXT,
      source_name TEXT,
      landing_site TEXT,
      referring_site TEXT,
      tags TEXT,
      raw_json TEXT,
      synced_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS shopify_order_line_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL,
      shopify_line_item_id TEXT,
      title TEXT,
      product_id TEXT,
      variant_id TEXT,
      quantity INTEGER DEFAULT 1,
      price REAL DEFAULT 0,
      product_type TEXT,
      vendor TEXT,
      FOREIGN KEY (order_id) REFERENCES shopify_orders(shopify_order_id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS shopify_checkouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shopify_checkout_id TEXT UNIQUE NOT NULL,
      token TEXT,
      created_at TEXT,
      updated_at TEXT,
      total_price REAL DEFAULT 0,
      subtotal_price REAL DEFAULT 0,
      currency TEXT DEFAULT 'USD',
      customer_email TEXT,
      customer_id TEXT,
      abandoned_checkout_url TEXT,
      line_item_count INTEGER DEFAULT 0,
      raw_json TEXT,
      synced_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS shopify_sync_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // Indexes for common queries
  db.exec(`CREATE INDEX IF NOT EXISTS idx_shopify_orders_created ON shopify_orders(created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_shopify_orders_email ON shopify_orders(customer_email)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_shopify_orders_financial ON shopify_orders(financial_status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_shopify_line_items_order ON shopify_order_line_items(order_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_shopify_line_items_product ON shopify_order_line_items(product_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_shopify_checkouts_created ON shopify_checkouts(created_at)`);
}

// ---------------------------------------------------------------------------
// Metadata helpers
// ---------------------------------------------------------------------------

function getMeta(key) {
  const row = _db.prepare('SELECT value FROM shopify_sync_meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setMeta(key, value) {
  _db.prepare('INSERT OR REPLACE INTO shopify_sync_meta (key, value) VALUES (?, ?)').run(key, value);
}

// ---------------------------------------------------------------------------
// Upsert helpers (prepared statements created once per sync cycle)
// ---------------------------------------------------------------------------

function upsertOrder(order, stmts) {
  const shopifyId = String(order.id);
  const existing = stmts.checkOrder.get(shopifyId);

  if (existing) {
    stmts.updateOrder.run(
      order.order_number ? String(order.order_number) : null,
      order.created_at || null,
      parseFloat(order.total_price || 0),
      parseFloat(order.subtotal_price || 0),
      order.currency || 'USD',
      order.financial_status || null,
      order.fulfillment_status || null,
      order.email || order.contact_email || (order.customer && order.customer.email) || null,
      order.customer ? String(order.customer.id) : null,
      order.source_name || null,
      order.landing_site || null,
      order.referring_site || null,
      order.tags || null,
      JSON.stringify(order),
      new Date().toISOString(),
      shopifyId
    );
    // Delete old line items before re-inserting
    stmts.deleteLineItems.run(shopifyId);
  } else {
    stmts.insertOrder.run(
      shopifyId,
      order.order_number ? String(order.order_number) : null,
      order.created_at || null,
      parseFloat(order.total_price || 0),
      parseFloat(order.subtotal_price || 0),
      order.currency || 'USD',
      order.financial_status || null,
      order.fulfillment_status || null,
      order.email || order.contact_email || (order.customer && order.customer.email) || null,
      order.customer ? String(order.customer.id) : null,
      order.source_name || null,
      order.landing_site || null,
      order.referring_site || null,
      order.tags || null,
      JSON.stringify(order),
      new Date().toISOString()
    );
  }

  // Insert line items
  const lineItems = order.line_items || [];
  for (const li of lineItems) {
    stmts.insertLineItem.run(
      shopifyId,
      li.id ? String(li.id) : null,
      li.title || li.name || null,
      li.product_id ? String(li.product_id) : null,
      li.variant_id ? String(li.variant_id) : null,
      li.quantity || 1,
      parseFloat(li.price || 0),
      li.product_type || null,
      li.vendor || null
    );
  }

  return !existing; // true if this was a new insert
}

function upsertCheckout(checkout, stmts) {
  const shopifyId = String(checkout.id);
  const existing = stmts.checkCheckout.get(shopifyId);

  if (existing) {
    stmts.updateCheckout.run(
      checkout.token || null,
      checkout.created_at || null,
      checkout.updated_at || null,
      parseFloat(checkout.total_price || 0),
      parseFloat(checkout.subtotal_price || 0),
      checkout.currency || 'USD',
      checkout.email || (checkout.customer && checkout.customer.email) || null,
      checkout.customer ? String(checkout.customer.id) : null,
      checkout.abandoned_checkout_url || null,
      (checkout.line_items || []).length,
      JSON.stringify(checkout),
      new Date().toISOString(),
      shopifyId
    );
    return false;
  } else {
    stmts.insertCheckout.run(
      shopifyId,
      checkout.token || null,
      checkout.created_at || null,
      checkout.updated_at || null,
      parseFloat(checkout.total_price || 0),
      parseFloat(checkout.subtotal_price || 0),
      checkout.currency || 'USD',
      checkout.email || (checkout.customer && checkout.customer.email) || null,
      checkout.customer ? String(checkout.customer.id) : null,
      checkout.abandoned_checkout_url || null,
      (checkout.line_items || []).length,
      JSON.stringify(checkout),
      new Date().toISOString()
    );
    return true;
  }
}

// ---------------------------------------------------------------------------
// Feed new orders into salesAnalytics
// ---------------------------------------------------------------------------

function feedToSalesAnalytics(order) {
  try {
    const customerEmail = order.email || order.contact_email || (order.customer && order.customer.email);
    const totalCents = order.total_price ? Math.round(parseFloat(order.total_price) * 100) : 0;
    const isNewCustomer = order.customer && order.customer.orders_count === 1;

    salesAnalytics.recordOrder({
      id: order.id || order.order_number,
      channel: 'shopify',
      totalCents,
      items: (order.line_items || []).map(li => ({
        title: li.title,
        category: li.product_type || 'other',
        priceCents: li.price ? Math.round(parseFloat(li.price) * 100) : 0,
        quantity: li.quantity || 1
      })),
      customerEmail,
      isNewCustomer,
      source: order.source_name || 'shopify'
    });
  } catch (err) {
    console.error(TAG, 'Failed to feed order to salesAnalytics:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Core sync logic
// ---------------------------------------------------------------------------

async function runSync() {
  if (_syncing) {
    console.log(TAG, 'Sync already in progress, skipping');
    return;
  }
  if (!shopifyAnalytics.isConfigured()) {
    console.warn(TAG, 'Shopify not configured (missing SHOPIFY_SHOP or SHOPIFY_ACCESS_TOKEN)');
    return;
  }

  _syncing = true;
  const syncStart = Date.now();
  let ordersUpserted = 0;
  let newOrders = 0;
  let checkoutsUpserted = 0;

  try {
    const lastSyncTimestamp = getMeta('last_order_sync');
    const isBackfill = !lastSyncTimestamp;

    // Determine date range
    let sinceDate;
    if (isBackfill) {
      const d = new Date();
      d.setDate(d.getDate() - BACKFILL_DAYS);
      sinceDate = d.toISOString();
      console.log(TAG, `First run — backfilling last ${BACKFILL_DAYS} days from ${sinceDate}`);
    } else {
      // Overlap by 2 hours to catch any orders that arrived late
      const d = new Date(lastSyncTimestamp);
      d.setHours(d.getHours() - 2);
      sinceDate = d.toISOString();
      console.log(TAG, `Incremental sync from ${sinceDate}`);
    }

    const untilDate = new Date().toISOString();

    // Fetch orders from Shopify API
    const orders = await shopifyAnalytics.getOrders(sinceDate, untilDate);
    console.log(TAG, `Fetched ${orders.length} orders from Shopify`);

    // Prepare statements for batch upsert
    const stmts = {
      checkOrder: _db.prepare('SELECT 1 FROM shopify_orders WHERE shopify_order_id = ?'),
      insertOrder: _db.prepare(`
        INSERT INTO shopify_orders
          (shopify_order_id, order_number, created_at, total_price, subtotal_price,
           currency, financial_status, fulfillment_status, customer_email, customer_id,
           source_name, landing_site, referring_site, tags, raw_json, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      updateOrder: _db.prepare(`
        UPDATE shopify_orders SET
          order_number = ?, created_at = ?, total_price = ?, subtotal_price = ?,
          currency = ?, financial_status = ?, fulfillment_status = ?,
          customer_email = ?, customer_id = ?, source_name = ?,
          landing_site = ?, referring_site = ?, tags = ?, raw_json = ?, synced_at = ?
        WHERE shopify_order_id = ?
      `),
      deleteLineItems: _db.prepare('DELETE FROM shopify_order_line_items WHERE order_id = ?'),
      insertLineItem: _db.prepare(`
        INSERT INTO shopify_order_line_items
          (order_id, shopify_line_item_id, title, product_id, variant_id,
           quantity, price, product_type, vendor)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      checkCheckout: _db.prepare('SELECT 1 FROM shopify_checkouts WHERE shopify_checkout_id = ?'),
      insertCheckout: _db.prepare(`
        INSERT INTO shopify_checkouts
          (shopify_checkout_id, token, created_at, updated_at, total_price, subtotal_price,
           currency, customer_email, customer_id, abandoned_checkout_url,
           line_item_count, raw_json, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      updateCheckout: _db.prepare(`
        UPDATE shopify_checkouts SET
          token = ?, created_at = ?, updated_at = ?, total_price = ?, subtotal_price = ?,
          currency = ?, customer_email = ?, customer_id = ?, abandoned_checkout_url = ?,
          line_item_count = ?, raw_json = ?, synced_at = ?
        WHERE shopify_checkout_id = ?
      `)
    };

    // Upsert orders inside a transaction for speed + atomicity
    const upsertAllOrders = _db.transaction((orderList) => {
      for (const order of orderList) {
        const isNew = upsertOrder(order, stmts);
        ordersUpserted++;
        if (isNew) {
          newOrders++;
          // Only feed genuinely new orders into sales analytics
          // During backfill, feed all; during incremental, only new inserts
          feedToSalesAnalytics(order);
        }
      }
    });

    upsertAllOrders(orders);
    console.log(TAG, `Upserted ${ordersUpserted} orders (${newOrders} new)`);

    // Fetch and store abandoned checkouts
    try {
      const checkouts = await shopifyAnalytics.getAbandonedCheckouts(sinceDate);
      console.log(TAG, `Fetched ${checkouts.length} abandoned checkouts`);

      const upsertAllCheckouts = _db.transaction((checkoutList) => {
        for (const checkout of checkoutList) {
          upsertCheckout(checkout, stmts);
          checkoutsUpserted++;
        }
      });

      upsertAllCheckouts(checkouts);
      console.log(TAG, `Upserted ${checkoutsUpserted} checkouts`);
    } catch (checkoutErr) {
      console.error(TAG, 'Checkout sync error (non-fatal):', checkoutErr.message);
    }

    // Update sync metadata
    const now = new Date().toISOString();
    setMeta('last_order_sync', now);
    setMeta('last_sync_orders_count', String(ordersUpserted));
    setMeta('last_sync_duration_ms', String(Date.now() - syncStart));

    _lastSync = {
      timestamp: now,
      ordersUpserted,
      newOrders,
      checkoutsUpserted,
      durationMs: Date.now() - syncStart
    };

    console.log(TAG, `Sync complete in ${_lastSync.durationMs}ms — ${ordersUpserted} orders, ${checkoutsUpserted} checkouts`);
  } catch (err) {
    console.error(TAG, 'Sync failed:', err.message);
    _lastSync = {
      timestamp: new Date().toISOString(),
      error: err.message,
      ordersUpserted,
      newOrders,
      checkoutsUpserted,
      durationMs: Date.now() - syncStart
    };
  } finally {
    _syncing = false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize tables and start the periodic sync daemon.
 * @param {object} db - better-sqlite3 database instance
 */
function startSync(db) {
  if (!db) throw new Error('db instance required');
  _db = db;

  ensureTables(_db);
  console.log(TAG, 'Tables ensured, starting initial sync...');

  // Run first sync after a short delay to let other daemons initialize
  setTimeout(() => {
    runSync().catch(err => console.error(TAG, 'Initial sync error:', err.message));
  }, 5000);

  // Schedule recurring syncs
  _timer = setInterval(() => {
    runSync().catch(err => console.error(TAG, 'Scheduled sync error:', err.message));
  }, SYNC_INTERVAL_MS);

  // Allow timer to not block process exit
  if (_timer.unref) _timer.unref();
}

/**
 * Trigger an immediate sync (returns a promise).
 */
async function syncNow() {
  if (!_db) throw new Error('Sync not started — call startSync(db) first');
  return runSync();
}

/**
 * Return info about the last completed sync.
 */
function getLastSync() {
  if (_lastSync) return _lastSync;
  if (!_db) return null;

  // Fall back to persisted metadata
  const ts = getMeta('last_order_sync');
  if (!ts) return null;
  return {
    timestamp: ts,
    ordersUpserted: parseInt(getMeta('last_sync_orders_count') || '0', 10),
    durationMs: parseInt(getMeta('last_sync_duration_ms') || '0', 10)
  };
}

module.exports = {
  startSync,
  syncNow,
  getLastSync
};
