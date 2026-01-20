const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const APP_ROOT = path.resolve(__dirname, '..');

// Use LIBRARY_ROOT if it exists and is accessible, otherwise fall back to APP_ROOT
let LIBRARY_ROOT = APP_ROOT;
if (process.env.LIBRARY_ROOT) {
  try {
    const candidatePath = path.resolve(process.env.LIBRARY_ROOT);
    // Test if we can access/create the parent directory
    const parentDir = path.dirname(candidatePath);
    if (fs.existsSync(parentDir)) {
      LIBRARY_ROOT = candidatePath;
    } else {
      console.warn(`LIBRARY_ROOT path ${candidatePath} is not accessible, using local APP_ROOT instead`);
    }
  } catch (error) {
    console.warn(`Invalid LIBRARY_ROOT path, using local APP_ROOT instead:`, error.message);
  }
}

// Database is always in APP_ROOT/data, not LIBRARY_ROOT
const DATA_DIR = path.join(APP_ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'store.db');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

// ============================================================================
// AUTOMATIC DATABASE BACKUP SYSTEM
// ============================================================================

/**
 * Create a timestamped backup of the database
 * @param {string} reason - Reason for backup (e.g., 'daily', 'before-delete', 'manual')
 * @returns {string} Path to backup file
 */
function createBackup(reason = 'manual') {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupName = `store-${timestamp}-${reason}.db`;
  const backupPath = path.join(BACKUP_DIR, backupName);

  try {
    // Use better-sqlite3's backup API for safe concurrent backup
    db.backup(backupPath);
    console.log(`[DB Backup] Created: ${backupPath}`);

    // Clean up old backups (keep last 30 days of daily backups, last 100 event backups)
    cleanupOldBackups();

    return backupPath;
  } catch (error) {
    console.error(`[DB Backup] Failed to create backup: ${error.message}`);
    throw error;
  }
}

/**
 * Clean up old backup files to prevent disk space issues
 */
function cleanupOldBackups() {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('store-') && f.endsWith('.db'))
      .map(f => ({
        name: f,
        path: path.join(BACKUP_DIR, f),
        stat: fs.statSync(path.join(BACKUP_DIR, f))
      }))
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs); // newest first

    const dailyBackups = files.filter(f => f.name.includes('-daily'));
    const eventBackups = files.filter(f => !f.name.includes('-daily'));

    // Keep last 30 daily backups
    dailyBackups.slice(30).forEach(f => {
      try { fs.unlinkSync(f.path); console.log(`[DB Backup] Cleaned up old backup: ${f.name}`); } catch (_) {}
    });

    // Keep last 100 event backups
    eventBackups.slice(100).forEach(f => {
      try { fs.unlinkSync(f.path); console.log(`[DB Backup] Cleaned up old backup: ${f.name}`); } catch (_) {}
    });
  } catch (error) {
    console.error(`[DB Backup] Cleanup failed: ${error.message}`);
  }
}

/**
 * List available backups
 * @returns {Array} List of backup files with metadata
 */
function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('store-') && f.endsWith('.db'))
      .map(f => {
        const stat = fs.statSync(path.join(BACKUP_DIR, f));
        return {
          name: f,
          path: path.join(BACKUP_DIR, f),
          size: stat.size,
          created: stat.mtime
        };
      })
      .sort((a, b) => b.created - a.created);
  } catch (error) {
    console.error(`[DB Backup] Failed to list backups: ${error.message}`);
    return [];
  }
}

/**
 * Restore database from a backup
 * @param {string} backupPath - Path to backup file
 */
function restoreFromBackup(backupPath) {
  if (!fs.existsSync(backupPath)) {
    throw new Error(`Backup file not found: ${backupPath}`);
  }

  // Create a backup of current state before restoring
  createBackup('before-restore');

  // Close current database connection
  db.close();

  // Copy backup over current database
  fs.copyFileSync(backupPath, DB_PATH);

  console.log(`[DB Backup] Restored from: ${backupPath}`);
  console.log(`[DB Backup] IMPORTANT: Server restart required to use restored database`);

  return true;
}

// Schedule daily backup at startup and every 24 hours
let lastDailyBackup = null;
function scheduleDailyBackup() {
  const now = new Date();
  const today = now.toISOString().split('T')[0];

  // Check if we've already done a daily backup today
  if (lastDailyBackup !== today) {
    try {
      createBackup('daily');
      lastDailyBackup = today;
    } catch (_) {}
  }
}

// Run daily backup check on startup and every hour
scheduleDailyBackup();
setInterval(scheduleDailyBackup, 60 * 60 * 1000); // Check every hour

const REGULAR_VINYL_SEED_ITEMS = [
  { name: 'Optic White', color: '#FFFFFF', quantity: 10 },
  { name: 'Crystal White', color: '#FEFEFE', quantity: 10 },
  { name: 'Charcoal Black', color: '#201F1D', quantity: 10 },
  { name: 'Steel Gray', color: '#6A6B76', quantity: 10 },
  { name: 'Warm Gray', color: '#DEDEDC', quantity: 10 },
  { name: 'Frost Glaze', color: '#FDFCFD', quantity: 10 },
  { name: 'Sage Gray', color: '#89938E', quantity: 10 },
  { name: 'Coral Rose', color: '#E66C74', quantity: 10 },
  { name: 'Silver Mist', color: '#CBCBCD', quantity: 10 },
  { name: 'Golden Sand', color: '#E4C679', quantity: 10 },
  { name: 'Copper Clay', color: '#A7765C', quantity: 10 },
  { name: 'Plum Slate', color: '#4F4454', quantity: 10 },
  { name: 'Soft White', color: '#F2F2F2', quantity: 10 },
  { name: 'Dusty Mauve', color: '#B19EA6', quantity: 10 },
  { name: 'Ivory Lace', color: '#FFFEFD', quantity: 10 },
  { name: 'Arctic Gray', color: '#E9E9E9', quantity: 10 },
  { name: 'Skyline Blue', color: '#74B6D1', quantity: 10 },
  { name: 'Crimson Red', color: '#B72020', quantity: 10 },
  { name: 'Pearl White', color: '#F9F8F8', quantity: 10 },
  { name: 'Pacific Blue', color: '#4D8BBD', quantity: 10 },
  { name: 'Lilac Smoke', color: '#B9AEC6', quantity: 10 },
  { name: 'Violet Frost', color: '#9878B1', quantity: 10 },
  { name: 'Champagne', color: '#E6DAAD', quantity: 10 },
  { name: 'Seafoam', color: '#A0D6D8', quantity: 10 },
  { name: 'Snow Drift', color: '#FFFFFE', quantity: 10 },
  { name: 'Blush Pink', color: '#F2B8D0', quantity: 10 },
  { name: 'Royal Sapphire', color: '#0D4B9D', quantity: 10 },
  { name: 'Harvest Gold', color: '#DAAD28', quantity: 10 },
  { name: 'Petal Pink', color: '#FAE4E6', quantity: 10 }
];

const HEAT_TRANSFER_APPAREL_BULK = new Set([
  'Bright White',
  'Sunburst Yellow',
  'Fire Red',
  'Royal Blue',
  'Deep Midnight'
]);

const HEAT_TRANSFER_SEED_ITEMS = [
  { name: 'Bright White', color: '#F6F6F6' },
  { name: 'Soft Sand', color: '#F2DFA0' },
  { name: 'Goldenrod', color: '#E3B552' },
  { name: 'Navy Steel', color: '#183D5C' },
  { name: 'Deep Midnight', color: '#0C1C35' },
  { name: 'Sunburst Yellow', color: '#EFD01C' },
  { name: 'Slate Blue', color: '#4A546E' },
  { name: 'Copper Orange', color: '#DE7E1E' },
  { name: 'Mauve Ash', color: '#C2AEAE' },
  { name: 'Fire Red', color: '#C72B1B' },
  { name: 'Lavender Mist', color: '#DBCED9' },
  { name: 'Storm Gray', color: '#7D8694' },
  { name: 'Royal Blue', color: '#176BC6' },
  { name: 'Bronze', color: '#A18755' },
  { name: 'Evergreen', color: '#2B8B60' },
  { name: 'Oxblood', color: '#7E0908' },
  { name: 'Chestnut', color: '#6D5029' },
  { name: 'Rose Pink', color: '#E1667E' },
  { name: 'Sky Blue', color: '#6AAEDF' },
  { name: 'Lime Green', color: '#61CA61' }
].map((item) => ({
  ...item,
  quantity: HEAT_TRANSFER_APPAREL_BULK.has(item.name) ? 50 : 5
}));

function normalizeHexColor(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  const prefixed = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  return prefixed.toUpperCase();
}

function ensureColumn(table, column, definition) {
  const info = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!info.some((col) => col.name === column)) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  }
}

function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      email TEXT UNIQUE NOT NULL,
      phone TEXT,
      address TEXT,
      password_hash TEXT,
      email_verified INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      token TEXT UNIQUE NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS auth_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      token TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      order_number INTEGER,
      customer_id INTEGER,
      design_id TEXT,
      design_name TEXT,
      product_type TEXT,
      category TEXT,
      size REAL,
      color TEXT,
      background TEXT,
      quantity INTEGER,
      notes TEXT,
      text_layers TEXT,
      preview_file TEXT,
      metadata_path TEXT,
      source_files TEXT,
      apparel_items TEXT,
      pricing TEXT,
      payment_link TEXT,
      payment_link_id TEXT,
      saved_at TEXT,
      paid INTEGER DEFAULT 0,
      internal_notes TEXT,
      bytes_written INTEGER,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS race_quotes (
      id TEXT PRIMARY KEY,
      quote_number INTEGER,
      customer_id INTEGER NOT NULL,
      business TEXT NOT NULL,
      contact_name TEXT NOT NULL,
      request_date TEXT,
      vehicle TEXT,
      colors TEXT,
      package_option TEXT,
      addons TEXT,
      notes TEXT,
      status TEXT DEFAULT 'submitted',
      base_cents INTEGER,
      addons_cents INTEGER,
      subtotal_cents INTEGER,
      tax_cents INTEGER,
      total_cents INTEGER,
      admin_notes TEXT,
      payment_link TEXT,
      payment_link_id TEXT,
      payment_status TEXT DEFAULT 'UNPAID',
      payment_details TEXT,
      timeline_text TEXT,
      delivery_text TEXT,
      pricing_notes TEXT,
      quote_valid_until TEXT,
      customer_response TEXT,
      customer_response_at TEXT,
      racing_body TEXT,
      car_number TEXT,
      co_driver TEXT,
      driver_country TEXT,
      co_driver_country TEXT,
      sponsors TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email);
    CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
    CREATE INDEX IF NOT EXISTS idx_tokens_token ON auth_tokens(token);
    CREATE INDEX IF NOT EXISTS idx_tokens_customer_type ON auth_tokens(customer_id, type);
    CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
    CREATE INDEX IF NOT EXISTS idx_orders_saved_at ON orders(saved_at);
  `);

  // POD (Print-on-demand) production orders, keyed to Shopify orders/line items
  db.exec(`
    CREATE TABLE IF NOT EXISTS pod_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shopify_order_id TEXT NOT NULL UNIQUE,
      shopify_order_number TEXT,
      status TEXT DEFAULT 'pending',
      shipping_name TEXT,
      shipping_address_json TEXT,
      customer_email TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pod_order_line_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      shopify_line_item_id TEXT NOT NULL UNIQUE,
      sku TEXT,
      name TEXT,
      quantity INTEGER,
      status TEXT DEFAULT 'pending',
      artwork_path TEXT,
      properties_json TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(order_id) REFERENCES pod_orders(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sku_artwork_map (
      sku TEXT PRIMARY KEY,
      artwork_path TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pod_line_items_order ON pod_order_line_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_pod_line_items_status ON pod_order_line_items(status);
  `);

  // Inbound SMS/messages
  db.exec(`
    CREATE TABLE IF NOT EXISTS inbound_messages (
      id TEXT PRIMARY KEY,
      provider TEXT,
      provider_message_id TEXT,
      from_phone TEXT,
      to_phone TEXT,
      body TEXT,
      direction TEXT DEFAULT 'in',
      customer_id INTEGER,
      raw_payload TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inbound_messages_created ON inbound_messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_inbound_messages_from ON inbound_messages(from_phone);
  `);
  // Migration: ensure new columns exist
  ensureColumn('inbound_messages', 'direction', "TEXT DEFAULT 'in'");

  ensureColumn('customers', 'email_verified', 'INTEGER DEFAULT 0');
  ensureColumn('customers', 'phone', 'TEXT');
  ensureColumn('customers', 'address', 'TEXT');
  ensureColumn('customers', 'password_hash', 'TEXT');
  ensureColumn('customers', 'sms_opt_in', 'INTEGER DEFAULT 0');
  ensureColumn('customers', 'remember_token', 'TEXT');
  ensureColumn('orders', 'order_number', 'INTEGER');
  ensureColumn('orders', 'pricing', 'TEXT');
  ensureColumn('orders', 'payment_link', 'TEXT');
  ensureColumn('orders', 'payment_link_id', 'TEXT');
  ensureColumn('orders', 'payment_status', 'TEXT');
  ensureColumn('orders', 'payment_details', 'TEXT');
  ensureColumn('orders', 'inventory_usage', 'TEXT');
  ensureColumn('orders', 'downloaded_at', 'TEXT');
  ensureColumn('orders', 'downloaded_by', 'TEXT');
  ensureColumn('orders', 'completed_at', 'TEXT');
  ensureColumn('orders', 'apparel_items', 'TEXT');
  ensureColumn('orders', 'product_type', 'TEXT');
  ensureColumn('orders', 'campaign', 'TEXT');
  ensureColumn('race_quotes', 'quote_number', 'INTEGER');
  ensureColumn('race_quotes', 'colors', 'TEXT');
  ensureColumn('race_quotes', 'addons', 'TEXT');
  ensureColumn('race_quotes', 'notes', 'TEXT');
  ensureColumn('race_quotes', 'admin_notes', 'TEXT');
  ensureColumn('race_quotes', 'payment_status', 'TEXT');
  ensureColumn('race_quotes', 'payment_details', 'TEXT');
  ensureColumn('race_quotes', 'timeline_text', 'TEXT');
  ensureColumn('race_quotes', 'delivery_text', 'TEXT');
  ensureColumn('race_quotes', 'pricing_notes', 'TEXT');
  ensureColumn('race_quotes', 'quote_valid_until', 'TEXT');
  ensureColumn('race_quotes', 'customer_response', 'TEXT');
  ensureColumn('race_quotes', 'customer_response_at', 'TEXT');
  ensureColumn('race_quotes', 'racing_body', 'TEXT');
  ensureColumn('race_quotes', 'car_number', 'TEXT');
  ensureColumn('race_quotes', 'co_driver', 'TEXT');
  ensureColumn('race_quotes', 'driver_country', 'TEXT');
  ensureColumn('race_quotes', 'co_driver_country', 'TEXT');
  ensureColumn('race_quotes', 'sponsors', 'TEXT');

  db.exec(`
    CREATE TABLE IF NOT EXISTS race_quote_messages (
      id TEXT PRIMARY KEY,
      quote_id TEXT NOT NULL,
      sender TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (quote_id) REFERENCES race_quotes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_race_quote_messages_quote ON race_quote_messages(quote_id, created_at);

    CREATE TABLE IF NOT EXISTS race_quote_files (
      id TEXT PRIMARY KEY,
      quote_id TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT,
      size INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (quote_id) REFERENCES race_quotes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_race_quote_files_quote ON race_quote_files(quote_id, created_at);
  `);

  // Car templates for race decal designer
  db.exec(`
    CREATE TABLE IF NOT EXISTS car_templates (
      id TEXT PRIMARY KEY,
      make TEXT NOT NULL,
      model TEXT NOT NULL,
      year_start INTEGER NOT NULL,
      year_end INTEGER NOT NULL,
      body_style TEXT,
      overall_length REAL,
      overall_width REAL,
      overall_height REAL,
      wheelbase REAL,
      template_side TEXT,
      template_front TEXT,
      template_rear TEXT,
      scale REAL DEFAULT 0.1,
      is_generated INTEGER DEFAULT 0,
      verified INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_car_templates_make_model ON car_templates(make, model);
    CREATE INDEX IF NOT EXISTS idx_car_templates_years ON car_templates(year_start, year_end);

    CREATE TABLE IF NOT EXISTS race_designs (
      id TEXT PRIMARY KEY,
      customer_id INTEGER NOT NULL,
      car_template_id TEXT,
      driver_info TEXT,
      reference_photos TEXT,
      decals TEXT,
      design_preview TEXT,
      production_spec TEXT,
      quote_id TEXT,
      status TEXT DEFAULT 'draft',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      FOREIGN KEY (car_template_id) REFERENCES car_templates(id) ON DELETE SET NULL,
      FOREIGN KEY (quote_id) REFERENCES race_quotes(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_race_designs_customer ON race_designs(customer_id);
    CREATE INDEX IF NOT EXISTS idx_race_designs_quote ON race_designs(quote_id);
  `);

  // Add design fields to race_quotes if not present
  ensureColumn('race_quotes', 'design_id', 'TEXT');
  ensureColumn('race_quotes', 'design_preview', 'TEXT');

  // Track vendor orders (e.g., S&S Activewear)
  db.exec(`
    CREATE TABLE IF NOT EXISTS vendor_orders (
      id TEXT PRIMARY KEY,
      vendor TEXT NOT NULL,
      vendor_order_id TEXT,
      customer_po TEXT,
      status TEXT,
      shipping_method TEXT,
      warehouses TEXT,
      tracking TEXT,
      raw_payload TEXT,
      request_payload TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_vendor_orders_vendor_order
      ON vendor_orders(vendor, vendor_order_id);
    CREATE INDEX IF NOT EXISTS idx_vendor_orders_po
      ON vendor_orders(customer_po);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS inventory_items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      material TEXT,
      color TEXT,
      color_name TEXT,
      size TEXT,
      fabric TEXT,
      description TEXT,
      image_url TEXT,
      item_url TEXT,
      unit_cost_cents INTEGER,
      unit TEXT DEFAULT 'unit',
      quantity INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(name, color, size, material)
    );

    CREATE TABLE IF NOT EXISTS inventory_transactions (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      change INTEGER NOT NULL,
      reason TEXT,
      order_id TEXT,
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (item_id) REFERENCES inventory_items(id) ON DELETE CASCADE
    );
  `);

  // Ensure vendor_orders columns exist for upgrades
  // Inventory column upgrades
  ensureColumn('inventory_items', 'color_name', 'TEXT');
  ensureColumn('inventory_items', 'fabric', 'TEXT');
  ensureColumn('inventory_items', 'description', 'TEXT');
  ensureColumn('inventory_items', 'image_url', 'TEXT');
  ensureColumn('inventory_items', 'image_url_back', 'TEXT');
  ensureColumn('inventory_items', 'variant_group_id', 'TEXT');
  ensureColumn('inventory_items', 'reference_url', 'TEXT');
  ensureColumn('vendor_orders', 'vendor', 'TEXT');
  ensureColumn('vendor_orders', 'vendor_order_id', 'TEXT');
  ensureColumn('vendor_orders', 'customer_po', 'TEXT');
  ensureColumn('vendor_orders', 'status', 'TEXT');
  ensureColumn('vendor_orders', 'shipping_method', 'TEXT');
  ensureColumn('vendor_orders', 'warehouses', 'TEXT');
  ensureColumn('vendor_orders', 'tracking', 'TEXT');
  ensureColumn('vendor_orders', 'raw_payload', 'TEXT');
  ensureColumn('vendor_orders', 'request_payload', 'TEXT');

  seedVinylInventory();

  // Initialize Custom Art tables
  initCustomArtTables();

  // Initialize Facebook Scheduled Posts tables
  initFacebookScheduledPosts();

  // Add columns for deferred AI generation
  ensureColumn('scheduled_facebook_posts', 'generate_ai_on_post', 'INTEGER DEFAULT 0');
  ensureColumn('scheduled_facebook_posts', 'ai_style', 'TEXT');

  // Initialize sticker contour cache table
  initStickerContourCache();
}

/**
 * Initialize Sticker Contour Cache table
 * Stores generated SVG contour paths for stickers (lazy generation, cached forever)
 * Key is a hash of the image path to handle any path format
 */
function initStickerContourCache() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sticker_contours (
      id TEXT PRIMARY KEY,
      image_path TEXT NOT NULL,
      image_path_hash TEXT NOT NULL UNIQUE,
      contour_svg_path TEXT NOT NULL,
      contour_width REAL,
      contour_height REAL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_sticker_contours_hash
      ON sticker_contours(image_path_hash);
  `);
}

/**
 * Initialize Facebook Scheduled Posts tables
 * - mockup_templates: Store mockup template configurations for campaigns
 * - scheduled_facebook_posts: Queue of posts to be published
 */
function initFacebookScheduledPosts() {
  db.exec(`
    -- Mockup templates for dynamic artwork compositing
    CREATE TABLE IF NOT EXISTS mockup_templates (
      id TEXT PRIMARY KEY,
      campaign_slug TEXT NOT NULL,
      name TEXT NOT NULL,
      mockup_image_path TEXT NOT NULL,
      artwork_position_json TEXT NOT NULL,
      blend_mode TEXT DEFAULT 'normal',
      output_format TEXT DEFAULT 'jpeg',
      output_quality INTEGER DEFAULT 90,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_mockup_templates_campaign
      ON mockup_templates(campaign_slug);

    -- Scheduled Facebook posts with mockup generation
    -- Two modes:
    --   1. Custom Art: template_id + artwork_path -> generates mockup dynamically
    --   2. Apparel: mockup_path -> uses existing mockup image directly
    CREATE TABLE IF NOT EXISTS scheduled_facebook_posts (
      id TEXT PRIMARY KEY,
      campaign_slug TEXT NOT NULL,
      product_uid TEXT,
      product_name TEXT,
      campaign_type TEXT DEFAULT 'custom-art',
      template_id TEXT,
      artwork_path TEXT,
      mockup_path TEXT,
      generated_mockup_path TEXT,
      post_text TEXT,
      post_hashtags TEXT,
      collection_url TEXT,
      scheduled_for TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      facebook_post_id TEXT,
      error_message TEXT,
      retry_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      published_at TEXT,
      FOREIGN KEY (template_id) REFERENCES mockup_templates(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_scheduled_posts_status
      ON scheduled_facebook_posts(status);
    CREATE INDEX IF NOT EXISTS idx_scheduled_posts_scheduled_for
      ON scheduled_facebook_posts(scheduled_for);
    CREATE INDEX IF NOT EXISTS idx_scheduled_posts_campaign
      ON scheduled_facebook_posts(campaign_slug);

    -- AI-generated post content for campaigns
    CREATE TABLE IF NOT EXISTS facebook_post_content (
      id TEXT PRIMARY KEY,
      campaign_slug TEXT NOT NULL,
      style TEXT,
      post_variations_json TEXT,
      recommended_hashtags TEXT,
      audience_insight TEXT,
      generated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_post_content_campaign
      ON facebook_post_content(campaign_slug);
  `);
}

function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase();
}

function normalizePhone(phone) {
  return String(phone || '').replace(/\D+/g, '');
}

function findCustomerByPhone(phone) {
  const norm = normalizePhone(phone);
  if (!norm) return null;
  const row = db
    .prepare("SELECT * FROM customers WHERE REPLACE(phone, '-', '') = ? OR phone = ?")
    .get(norm, norm);
  return row ? formatCustomer(row) : null;
}

function formatCustomer(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    address: row.address,
    smsOptIn: Boolean(row.sms_opt_in),
    emailVerified: Boolean(row.email_verified),
    rememberToken: row.remember_token || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function ensureRememberToken(customerId) {
  const existing = db
    .prepare('SELECT remember_token FROM customers WHERE id = ?')
    .get(customerId);
  if (existing?.remember_token) return existing.remember_token;
  return regenerateRememberToken(customerId);
}

function regenerateRememberToken(customerId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(
    `UPDATE customers
        SET remember_token = ?,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`
  ).run(token, customerId);
  return token;
}

function findCustomerByRememberToken(token) {
  if (!token) return null;
  const row = db
    .prepare('SELECT * FROM customers WHERE remember_token = ?')
    .get(token);
  return row ? formatCustomer(row) : null;
}

function upsertVendorOrderRecord({
  vendor = 'S&S Activewear',
  vendorOrderId = '',
  customerPO = '',
  status = '',
  shippingMethod = '',
  warehouses = '',
  tracking = '',
  raw = null
} = {}) {
  const payload = raw ? JSON.stringify(raw) : null;
  const idKey = String(vendorOrderId || '').trim();
  const poKey = String(customerPO || '').trim();
  if (!idKey && !poKey) return null;
  // Find existing by vendor+orderId first, else by PO
  let existing = null;
  if (idKey) {
    existing = db
      .prepare('SELECT * FROM vendor_orders WHERE vendor = ? AND vendor_order_id = ?')
      .get(vendor, idKey);
  }
  if (!existing && poKey) {
    existing = db
      .prepare('SELECT * FROM vendor_orders WHERE vendor = ? AND customer_po = ? ORDER BY updated_at DESC LIMIT 1')
      .get(vendor, poKey);
  }
  const nowFields = {
    vendor,
    vendor_order_id: idKey || (existing?.vendor_order_id || null),
    customer_po: poKey || (existing?.customer_po || null),
    status: status || (existing?.status || null),
    shipping_method: shippingMethod || (existing?.shipping_method || null),
    warehouses: warehouses || (existing?.warehouses || null),
    tracking: tracking || (existing?.tracking || null),
    raw_payload: payload || (existing?.raw_payload || null)
  };
  if (existing) {
    db.prepare(
      `UPDATE vendor_orders
         SET vendor_order_id = COALESCE(@vendor_order_id, vendor_order_id),
             customer_po = COALESCE(@customer_po, customer_po),
             status = COALESCE(@status, status),
             shipping_method = COALESCE(@shipping_method, shipping_method),
             warehouses = COALESCE(@warehouses, warehouses),
             tracking = COALESCE(@tracking, tracking),
             raw_payload = COALESCE(@raw_payload, raw_payload),
             updated_at = CURRENT_TIMESTAMP
       WHERE id = @id`
    ).run({ id: existing.id, ...nowFields });
    return existing.id;
  }
  const id = `vendor-${crypto.randomUUID()}`;
  db.prepare(
    `INSERT INTO vendor_orders
      (id, vendor, vendor_order_id, customer_po, status, shipping_method, warehouses, tracking, raw_payload)
      VALUES (@id, @vendor, @vendor_order_id, @customer_po, @status, @shipping_method, @warehouses, @tracking, @raw_payload)`
  ).run({ id, ...nowFields });
  return id;
}

function createVendorOrderDraft({
  vendor = 'S&S Activewear',
  customerPO = '',
  shippingMethod = '',
  warehouses = '',
  request = null
} = {}) {
  const id = `vendor-${crypto.randomUUID()}`;
  db.prepare(
    `INSERT INTO vendor_orders
      (id, vendor, customer_po, status, shipping_method, warehouses, request_payload)
      VALUES (@id, @vendor, @customer_po, 'pending_approval', @shipping_method, @warehouses, @request_payload)`
  ).run({
    id,
    vendor,
    customer_po: customerPO || null,
    shipping_method: shippingMethod || null,
    warehouses: warehouses || null,
    request_payload: request ? JSON.stringify(request) : null
  });
  return id;
}

function listVendorOrders({ vendor = '', po = '', status = '', limit = 100, offset = 0 } = {}) {
  const where = [];
  const params = {};
  if (vendor) {
    where.push('vendor = @vendor');
    params.vendor = vendor;
  }
  if (po) {
    where.push('customer_po = @po');
    params.po = po;
  }
  if (status) {
    where.push('status = @status');
    params.status = status;
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sql = `SELECT * FROM vendor_orders ${clause} ORDER BY updated_at DESC LIMIT @limit OFFSET @offset`;
  params.limit = Math.max(1, Math.min(Number(limit) || 100, 500));
  params.offset = Math.max(0, Number(offset) || 0);
  const rows = db.prepare(sql).all(params);
  return rows.map((row) => ({
    id: row.id,
    vendor: row.vendor,
    vendorOrderId: row.vendor_order_id,
    customerPO: row.customer_po,
    status: row.status,
    shippingMethod: row.shipping_method,
    warehouses: row.warehouses,
    tracking: row.tracking,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

function getVendorOrderById(id) {
  const row = db.prepare('SELECT * FROM vendor_orders WHERE id = ?').get(id);
  if (!row) return null;
  return {
    id: row.id,
    vendor: row.vendor,
    vendorOrderId: row.vendor_order_id,
    customerPO: row.customer_po,
    status: row.status,
    shippingMethod: row.shipping_method,
    warehouses: row.warehouses,
    tracking: row.tracking,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    raw: row.raw_payload ? safeParse(row.raw_payload) : null
  };
}

function updateVendorOrderRecord(id, updates = {}) {
  if (!id) return false;
  const allowed = ['status', 'shipping_method', 'warehouses', 'tracking', 'vendor_order_id', 'raw_payload'];
  const sets = [];
  const params = { id };
  allowed.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      sets.push(`${key} = @${key}`);
      params[key] = updates[key];
    }
  });
  if (!sets.length) return false;
  const sql = `UPDATE vendor_orders SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = @id`;
  const info = db.prepare(sql).run(params);
  return info.changes > 0;
}

function findCustomerByEmail(email) {
  if (!email) return null;
  return db
    .prepare('SELECT * FROM customers WHERE email = ?')
    .get(normalizeEmail(email));
}

function upsertCustomerContact({ name, email, phone, address }) {
  if (!email) return null;
  const normalizedEmail = normalizeEmail(email);
  const normalizedPhone = normalizePhone(phone);

  const existing = db
    .prepare('SELECT * FROM customers WHERE email = ?')
    .get(normalizedEmail);

  if (existing) {
    db.prepare(
      `UPDATE customers
         SET name = COALESCE(?, name),
             phone = CASE WHEN ? != '' THEN ? ELSE phone END,
             address = CASE WHEN ? != '' THEN ? ELSE address END,
             updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(
      name || existing.name,
      normalizedPhone,
      normalizedPhone,
      address || '',
      address || '',
      existing.id
    );

    return db.prepare('SELECT * FROM customers WHERE id = ?').get(existing.id);
  }

  const info = db
    .prepare(
      `INSERT INTO customers (name, email, phone, address)
       VALUES (?, ?, ?, ?)`
    )
    .run(name || '', normalizedEmail, normalizedPhone, address || '');

  return formatCustomer(
    db.prepare('SELECT * FROM customers WHERE id = ?').get(info.lastInsertRowid)
  );
}

function createCustomerAccount({ name, email, phone, address, password, smsOptIn }) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail || !password) {
    throw new Error('Email and password are required.');
  }

  const hash = bcrypt.hashSync(password, 12);
  const normalizedPhone = normalizePhone(phone);
  const optIn = smsOptIn ? 1 : 0;

  const existing = findCustomerByEmail(normalizedEmail);
  if (existing) {
    if (existing.password_hash) {
      throw new Error('An account already exists with this email.');
    }
    db.prepare(
      `UPDATE customers
         SET name = ?,
             phone = ?,
             address = ?,
             password_hash = ?,
             sms_opt_in = COALESCE(?, sms_opt_in),
             updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(name || existing.name, normalizedPhone, address || '', hash, optIn, existing.id);
    const updated = db.prepare('SELECT * FROM customers WHERE id = ?').get(existing.id);
    updated.remember_token = ensureRememberToken(updated.id);
    return formatCustomer(updated);
  }

  const info = db
    .prepare(
      `INSERT INTO customers (name, email, phone, address, password_hash, sms_opt_in)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(name || '', normalizedEmail, normalizedPhone, address || '', hash, optIn);
  const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(info.lastInsertRowid);
  row.remember_token = ensureRememberToken(row.id);
  return formatCustomer(row);
}

function verifyCustomerCredentials(email, password) {
  const normalizedEmail = normalizeEmail(email);
  const customer = db
    .prepare('SELECT * FROM customers WHERE email = ?')
    .get(normalizedEmail);
  if (!customer || !customer.password_hash) return null;
  const valid = bcrypt.compareSync(password, customer.password_hash);
  if (!valid) return null;
  customer.remember_token = ensureRememberToken(customer.id);
  return formatCustomer(customer);
}

function recordInboundMessage({ provider = 'simpletexting', providerId = null, from = '', to = '', body = '', raw = null } = {}) {
  const id = `sms-${crypto.randomUUID()}`;
  const fromNorm = normalizePhone(from);
  const toNorm = normalizePhone(to);
  const existing = fromNorm
    ? db
        .prepare("SELECT id FROM customers WHERE REPLACE(phone, '-', '') = ? OR phone = ?")
        .get(fromNorm, fromNorm)
    : null;
  db.prepare(
    `INSERT INTO inbound_messages (id, provider, provider_message_id, from_phone, to_phone, body, direction, customer_id, raw_payload)
     VALUES (@id, @provider, @provider_message_id, @from_phone, @to_phone, @body, 'in', @customer_id, @raw_payload)`
  ).run({
    id,
    provider,
    provider_message_id: providerId || null,
    from_phone: fromNorm || null,
    to_phone: toNorm || null,
    body: body || '',
    customer_id: existing ? existing.id : null,
    raw_payload: raw ? JSON.stringify(raw) : null
  });
  return id;
}

function recordOutboundMessage({ provider = 'simpletexting', providerId = null, from = '', to = '', body = '', raw = null } = {}) {
  const id = `sms-${crypto.randomUUID()}`;
  const fromNorm = normalizePhone(from);
  const toNorm = normalizePhone(to);
  const existing = toNorm
    ? db
        .prepare("SELECT id FROM customers WHERE REPLACE(phone, '-', '') = ? OR phone = ?")
        .get(toNorm, toNorm)
    : null;
  db.prepare(
    `INSERT INTO inbound_messages (id, provider, provider_message_id, from_phone, to_phone, body, direction, customer_id, raw_payload)
     VALUES (@id, @provider, @provider_message_id, @from_phone, @to_phone, @body, 'out', @customer_id, @raw_payload)`
  ).run({
    id,
    provider,
    provider_message_id: providerId || null,
    from_phone: fromNorm || null,
    to_phone: toNorm || null,
    body: body || '',
    customer_id: existing ? existing.id : null,
    raw_payload: raw ? JSON.stringify(raw) : null
  });
  return id;
}

function createSession(customerId, days = 30) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

  db.prepare(
    `INSERT INTO sessions (customer_id, token, expires_at)
     VALUES (?, ?, ?)`
  ).run(customerId, token, expiresAt);

  return { token, expiresAt };
}

function getCustomerByToken(token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT sessions.*, customers.*
       FROM sessions
       JOIN customers ON customers.id = sessions.customer_id
       WHERE sessions.token = ?`
    )
    .get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    deleteSession(token);
    return null;
  }
  return formatCustomer(
    db.prepare('SELECT * FROM customers WHERE id = ?').get(row.customer_id)
  );
}

function deleteSession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function deleteOrder(id) {
  if (!id) return;
  db.prepare('DELETE FROM orders WHERE id = ?').run(id);
}

function recordOrder({
  id,
  orderNumber,
  customerId,
  designId,
  designName,
  productType,
  category,
  size,
  color,
  background,
  quantity,
  notes,
  textLayers,
  previewFile,
  metadataPath,
  sourceFiles,
  apparelItems,
  inventoryUsage,
  pricing,
  paymentLink,
  paymentLinkId,
  paymentStatus,
  paymentDetails,
  savedAt,
  paid,
  internalNotes,
  bytesWritten
}) {
  db.prepare(
    `INSERT INTO orders (
      id, order_number, customer_id, design_id, design_name, product_type, category, size, color,
      background, quantity, notes, text_layers, preview_file, metadata_path,
      source_files, apparel_items, inventory_usage, pricing, payment_link, payment_link_id,
      payment_status, payment_details, downloaded_at, downloaded_by, completed_at,
      saved_at, paid, internal_notes, bytes_written, campaign
    ) VALUES (
      @id, @orderNumber, @customerId, @designId, @designName, @productType, @category, @size, @color,
      @background, @quantity, @notes, @textLayers, @previewFile, @metadataPath,
      @sourceFiles, @apparelItems, @inventoryUsage, @pricing, @paymentLink, @paymentLinkId,
      @paymentStatus, @paymentDetails, NULL, NULL, NULL,
      @savedAt, @paid, @internalNotes, @bytesWritten, @campaign
    )`
  ).run({
    id,
    orderNumber,
    customerId,
    designId,
    designName,
    productType: productType || null,
    category,
    size,
    color,
    background,
    quantity,
    notes,
    textLayers: JSON.stringify(textLayers || []),
    previewFile,
    metadataPath,
    sourceFiles: JSON.stringify(sourceFiles || []),
    apparelItems: JSON.stringify(apparelItems || []),
    inventoryUsage: inventoryUsage ? JSON.stringify(inventoryUsage) : null,
    pricing: pricing ? JSON.stringify(pricing) : null,
    paymentLink: paymentLink || null,
    paymentLinkId: paymentLinkId || null,
    paymentStatus: paymentStatus || null,
    paymentDetails: paymentDetails ? JSON.stringify(paymentDetails) : null,
    savedAt,
    paid: paid ? 1 : 0,
    internalNotes: internalNotes || '',
    bytesWritten,
    campaign: arguments[0].campaign || null
  });
}

function updateOrder(id, updates = {}) {
  const fields = [];
  const params = { id };

  if (updates.paid !== undefined) {
    fields.push('paid = @paid');
    params.paid = updates.paid ? 1 : 0;
  }
  if (updates.internalNotes !== undefined) {
    fields.push('internal_notes = @internalNotes');
    params.internalNotes = updates.internalNotes || '';
  }
  if (updates.paymentLink !== undefined) {
    fields.push('payment_link = @paymentLink');
    params.paymentLink = updates.paymentLink || null;
  }
  if (updates.paymentLinkId !== undefined) {
    fields.push('payment_link_id = @paymentLinkId');
    params.paymentLinkId = updates.paymentLinkId || null;
  }
  if (updates.paymentStatus !== undefined) {
    fields.push('payment_status = @paymentStatus');
    params.paymentStatus = updates.paymentStatus || null;
  }
  if (updates.paymentDetails !== undefined) {
    fields.push('payment_details = @paymentDetails');
    params.paymentDetails = updates.paymentDetails
      ? JSON.stringify(updates.paymentDetails)
      : null;
  }
  if (updates.notes !== undefined) {
    fields.push('notes = @notes');
    params.notes = updates.notes || '';
  }
  if (updates.textLayers !== undefined) {
    fields.push('text_layers = @textLayers');
    params.textLayers = JSON.stringify(updates.textLayers || []);
  }
  if (updates.pricing !== undefined) {
    fields.push('pricing = @pricing');
    params.pricing = updates.pricing ? JSON.stringify(updates.pricing) : null;
  }
  if (updates.designName !== undefined) {
    fields.push('design_name = @designName');
    params.designName = updates.designName || '';
  }
  if (updates.category !== undefined) {
    fields.push('category = @category');
    params.category = updates.category || '';
  }
  if (updates.productType !== undefined) {
    fields.push('product_type = @productType');
    params.productType = updates.productType || null;
  }
  if (updates.apparelItems !== undefined) {
    fields.push('apparel_items = @apparelItems');
    params.apparelItems = updates.apparelItems ? JSON.stringify(updates.apparelItems) : null;
  }
  if (updates.inventoryUsage !== undefined) {
    fields.push('inventory_usage = @inventoryUsage');
    params.inventoryUsage = updates.inventoryUsage
      ? JSON.stringify(updates.inventoryUsage)
      : null;
  }

  if (!fields.length) return;

  db.prepare(`UPDATE orders SET ${fields.join(', ')}, saved_at = saved_at WHERE id = @id`).run(params);
}

function fetchOrders() {
  return db
    .prepare(
      `SELECT orders.*, customers.name AS customer_name, customers.email AS customer_email,
              customers.phone AS customer_phone, customers.address AS customer_address,
              customers.email_verified AS customer_email_verified
       FROM orders
       LEFT JOIN customers ON customers.id = orders.customer_id
       ORDER BY datetime(saved_at) DESC`
    )
    .all()
    .map(mapOrderRow);
}

function fetchOrdersByCustomer(customerId) {
  return db
    .prepare(
      `SELECT orders.*, customers.name AS customer_name, customers.email AS customer_email,
              customers.phone AS customer_phone, customers.address AS customer_address,
              customers.email_verified AS customer_email_verified
       FROM orders
       LEFT JOIN customers ON customers.id = orders.customer_id
       WHERE orders.customer_id = ?
       ORDER BY datetime(saved_at) DESC`
    )
    .all(customerId)
    .map(mapOrderRow);
}

function fetchOrdersForQueue({ since }) {
  let query = `SELECT orders.*, customers.name AS customer_name, customers.email AS customer_email,
                      customers.phone AS customer_phone, customers.address AS customer_address,
                      customers.email_verified AS customer_email_verified
               FROM orders
               LEFT JOIN customers ON customers.id = orders.customer_id
               WHERE orders.completed_at IS NULL`;
  const params = [];
  if (since) {
    query += ' AND datetime(orders.saved_at) >= datetime(?)';
    params.push(since);
  }
  query += ' ORDER BY datetime(orders.saved_at) ASC LIMIT 100';
  return db.prepare(query).all(...params).map(mapOrderRow);
}

function markOrderDownloaded(id, downloadedBy) {
  db.prepare(
    `UPDATE orders
        SET downloaded_at = CURRENT_TIMESTAMP,
            downloaded_by = @by
      WHERE id = @id`
  ).run({ id, by: downloadedBy || null });
}

function markOrderCompleted(id, note) {
  db.prepare(
    `UPDATE orders
        SET completed_at = CURRENT_TIMESTAMP,
            internal_notes = CASE WHEN @note != '' THEN @note ELSE internal_notes END
      WHERE id = @id`
  ).run({ id, note: note || '' });
}

function getOrderById(id) {
  const row = db
    .prepare(
      `SELECT orders.*, customers.name AS customer_name, customers.email AS customer_email,
              customers.phone AS customer_phone, customers.address AS customer_address,
              customers.email_verified AS customer_email_verified
       FROM orders
       LEFT JOIN customers ON customers.id = orders.customer_id
       WHERE orders.id = ?`
    )
    .get(id);
  return row ? mapOrderRow(row) : null;
}

function mapOrderRow(row) {
  return {
    id: row.id,
    orderNumber: row.order_number,
    customerId: row.customer_id || null,
    designId: row.design_id,
    designName: row.design_name,
    productType: row.product_type || null,
    category: row.category,
    size: row.size,
    color: row.color,
    background: row.background,
    quantity: row.quantity,
    notes: row.notes,
    textLayers: safeParse(row.text_layers, []),
    previewFile: row.preview_file,
    metadataFile: row.metadata_path,
    sourceCopies: safeParse(row.source_files, []),
    apparelItems: safeParse(row.apparel_items, []),
    inventoryUsage: safeParse(row.inventory_usage, []),
    pricing: safeParse(row.pricing, null),
    paymentLink: row.payment_link,
    paymentLinkId: row.payment_link_id,
    paymentStatus: row.payment_status,
    paymentDetails: safeParse(row.payment_details, null),
    downloadedAt: row.downloaded_at || null,
    downloadedBy: row.downloaded_by || null,
    completedAt: row.completed_at || null,
    savedAt: row.saved_at,
    paid: Boolean(row.paid),
    internalNotes: row.internal_notes,
    bytes: row.bytes_written || null,
    campaign: row.campaign || null,
    customer: row.customer_email
      ? {
          name: row.customer_name,
          email: row.customer_email,
          phone: row.customer_phone,
          address: row.customer_address,
          emailVerified: Boolean(row.customer_email_verified)
        }
      : null
  };
}

function safeParse(value, fallback) {
  const fb = arguments.length >= 2 ? fallback : null;
  if (!value) return fb;
  try {
    return JSON.parse(value);
  } catch {
    return fb;
  }
}

function mapPodOrderRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    shopifyOrderId: row.shopify_order_id,
    shopifyOrderNumber: row.shopify_order_number,
    status: row.status || 'pending',
    shippingName: row.shipping_name || null,
    shippingAddress: safeParse(row.shipping_address_json, null),
    customerEmail: row.customer_email || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapPodLineItemRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    orderId: row.order_id,
    shopifyLineItemId: row.shopify_line_item_id,
    sku: row.sku || null,
    name: row.name || null,
    quantity: Number(row.quantity || 0),
    status: row.status || 'pending',
    artworkPath: row.artwork_path || null,
    properties: safeParse(row.properties_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapInventoryRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    material: row.material || null,
    color: row.color || null,
    colorName: row.color_name || null,
    size: row.size || null,
    fabric: row.fabric || null,
    description: row.description || null,
    imageUrl: row.image_url || null,
    imageUrlBack: row.image_url_back || null,
    itemUrl: row.item_url || null,
    referenceUrl: row.reference_url || null,
    variantGroupId: row.variant_group_id || null,
    unitCostCents: Number.isInteger(row.unit_cost_cents) ? row.unit_cost_cents : null,
    unit: row.unit || 'unit',
    quantity: Number(row.quantity) || 0,
    notes: row.notes || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    totalAdded: Number(row.total_added) || 0,
    totalRemoved: Math.abs(Number(row.total_removed) || 0),
    lastTransactionAt: row.last_transaction_at || null
  };
}

function getInventoryItemById(id) {
  if (!id) return null;
  const row = db
    .prepare(
      `SELECT i.*,
              COALESCE((
                SELECT SUM(t.change)
                FROM inventory_transactions t
                WHERE t.item_id = i.id AND t.change > 0
              ), 0) AS total_added,
              COALESCE((
                SELECT SUM(t.change)
                FROM inventory_transactions t
                WHERE t.item_id = i.id AND t.change < 0
              ), 0) AS total_removed,
              (
                SELECT MAX(t.created_at)
                FROM inventory_transactions t
                WHERE t.item_id = i.id
              ) AS last_transaction_at
       FROM inventory_items i
       WHERE i.id = ?`
    )
    .get(id);
  return row ? mapInventoryRow(row) : null;
}

function listInventoryItems(options = {}) {
  const { material } = options;
  let query = `
    SELECT i.*,
           COALESCE((
             SELECT SUM(t.change)
             FROM inventory_transactions t
             WHERE t.item_id = i.id AND t.change > 0
           ), 0) AS total_added,
           COALESCE((
             SELECT SUM(t.change)
             FROM inventory_transactions t
             WHERE t.item_id = i.id AND t.change < 0
           ), 0) AS total_removed,
           (
             SELECT MAX(t.created_at)
             FROM inventory_transactions t
             WHERE t.item_id = i.id
           ) AS last_transaction_at
    FROM inventory_items i`;
  const params = [];
  if (material) {
    query += ' WHERE COALESCE(i.material, \'\') = COALESCE(?, \'\')';
    params.push(material);
  }
  query += ' ORDER BY i.material, i.name COLLATE NOCASE';
  return db.prepare(query).all(...params).map(mapInventoryRow);
}

function addInventoryTransaction({ itemId, change, reason, orderId, notes, timestamp }) {
  const createdAt = timestamp || new Date().toISOString();
  db.prepare(
    `INSERT INTO inventory_transactions (id, item_id, change, reason, order_id, notes, created_at)
     VALUES (@id, @itemId, @change, @reason, @orderId, @notes, @createdAt)`
  ).run({
    id: `invtxn-${crypto.randomUUID()}`,
    itemId,
    change,
    reason: reason || (change >= 0 ? 'adjustment-add' : 'adjustment-remove'),
    orderId: orderId || null,
    notes: notes || null,
    createdAt
  });
}

const adjustInventoryQuantityTx = db.transaction((itemId, change, options = {}) => {
  const item = db
    .prepare('SELECT * FROM inventory_items WHERE id = ?')
    .get(itemId);
  if (!item) {
    throw new Error('Inventory item not found.');
  }
  const nextQuantity = Number(item.quantity || 0) + Number(change || 0);
  if (nextQuantity < 0) {
    throw new Error(`Insufficient stock for ${item.name}.`);
  }
  const timestamp = new Date().toISOString();
  db.prepare(
    `UPDATE inventory_items
        SET quantity = @quantity,
            updated_at = @updatedAt
      WHERE id = @id`
  ).run({
    id: itemId,
    quantity: nextQuantity,
    updatedAt: timestamp
  });
  addInventoryTransaction({
    itemId,
    change: Number(change || 0),
    reason: options.reason,
    orderId: options.orderId,
    notes: options.notes,
    timestamp
  });
});

function adjustInventoryQuantity(itemId, change, options = {}) {
  adjustInventoryQuantityTx(itemId, change, options);
  return getInventoryItemById(itemId);
}

function findInventoryItemByIdentity({ name, color, size, material }) {
  return db
    .prepare(
      `SELECT * FROM inventory_items
       WHERE name = ?
         AND COALESCE(color, '') = COALESCE(?, '')
         AND COALESCE(size, '') = COALESCE(?, '')
         AND COALESCE(material, '') = COALESCE(?, '')`
    )
    .get(name, color || '', size || '', material || '');
}

function createInventoryItem({
  name,
  material = null,
  color = null,
  colorName = null,
  size = null,
  fabric = null,
  description = null,
  imageUrl = null,
  imageUrlBack = null,
  itemUrl = null,
  referenceUrl = null,
  variantGroupId = null,
  unitCostCents = null,
  unit = 'unit',
  quantity = 0,
  notes = null
}) {
  if (!name) {
    throw new Error('Inventory item name is required.');
  }
  const normalizedColor = normalizeHexColor(color);
  const normalizedMaterial = material ? String(material).trim().toLowerCase() : null;
  const normalizedSize = size ? String(size).trim() : null;
  const requestedUnit =
    unit !== undefined && unit !== null ? String(unit).trim().toLowerCase() || null : null;
  const normalizedQuantity = Number.isFinite(Number(quantity)) ? Number(quantity) : 0;
  const now = new Date().toISOString();

  const existing = findInventoryItemByIdentity({
    name,
    color: normalizedColor,
    size: normalizedSize,
    material: normalizedMaterial
  });

  let itemId = existing?.id;
  if (!existing) {
    itemId = `inv-${crypto.randomUUID()}`;
    db.prepare(
      `INSERT INTO inventory_items (
         id, name, material, color, color_name, size, fabric, description, image_url, image_url_back, item_url, reference_url, variant_group_id, unit_cost_cents, unit, quantity, notes, created_at, updated_at
       ) VALUES (
         @id, @name, @material, @color, @colorName, @size, @fabric, @description, @imageUrl, @imageUrlBack, @itemUrl, @referenceUrl, @variantGroupId, @unitCostCents, @unit, 0, @notes, @now, @now
       )`
    ).run({
      id: itemId,
      name,
      material: normalizedMaterial,
      color: normalizedColor,
      colorName: colorName || null,
      size: normalizedSize,
      fabric: fabric || null,
      description: description || null,
      imageUrl: imageUrl || null,
      imageUrlBack: imageUrlBack || null,
      itemUrl: itemUrl || null,
      referenceUrl: referenceUrl || null,
      variantGroupId: variantGroupId || null,
      unitCostCents:
        Number.isFinite(Number(unitCostCents)) && Number(unitCostCents) >= 0
          ? Math.round(Number(unitCostCents))
          : null,
      unit: requestedUnit || 'unit',
      notes: notes || null,
      now
    });
  } else {
    db.prepare(
      `UPDATE inventory_items
          SET item_url = COALESCE(@itemUrl, item_url),
              image_url = COALESCE(@imageUrl, image_url),
              image_url_back = COALESCE(@imageUrlBack, image_url_back),
              reference_url = COALESCE(@referenceUrl, reference_url),
              variant_group_id = COALESCE(@variantGroupId, variant_group_id),
              color_name = COALESCE(@colorName, color_name),
              fabric = COALESCE(@fabric, fabric),
              description = COALESCE(@description, description),
              unit_cost_cents = COALESCE(@unitCostCents, unit_cost_cents),
              unit = COALESCE(@unit, unit),
              notes = COALESCE(@notes, notes),
              updated_at = @updatedAt
        WHERE id = @id`
    ).run({
      id: itemId,
      itemUrl: itemUrl || null,
      imageUrl: imageUrl || null,
      imageUrlBack: imageUrlBack || null,
      referenceUrl: referenceUrl || null,
      variantGroupId: variantGroupId || null,
      colorName: colorName || null,
      fabric: fabric || null,
      description: description || null,
      unitCostCents:
        Number.isFinite(Number(unitCostCents)) && Number(unitCostCents) >= 0
          ? Math.round(Number(unitCostCents))
          : null,
      unit: requestedUnit,
      notes: notes !== undefined ? notes : null,
      updatedAt: now
    });
  }

  if (normalizedQuantity !== 0) {
    adjustInventoryQuantity(itemId, normalizedQuantity, {
      reason: normalizedQuantity > 0 ? 'initial-stock' : 'initial-deduction',
      notes: notes || null
    });
  }

  return getInventoryItemById(itemId);
}

function updateInventoryItem(
  itemId,
  {
    name,
    material,
    color,
    colorName,
    size,
    fabric,
    description,
    imageUrl,
    imageUrlBack,
    itemUrl,
    referenceUrl,
    unitCostCents,
    unit,
    notes
  } = {}
) {
  const item = db
    .prepare('SELECT * FROM inventory_items WHERE id = ?')
    .get(itemId);
  if (!item) {
    throw new Error('Inventory item not found.');
  }

  const normalized = {
    name: name ? String(name).trim() : null,
    material: material ? String(material).trim().toLowerCase() : null,
    color: color === undefined ? undefined : normalizeHexColor(color),
    colorName: colorName === undefined ? undefined : (colorName ? String(colorName).trim() : null),
    size: size ? String(size).trim() : null,
    fabric: fabric === undefined ? undefined : (fabric ? String(fabric).trim() : null),
    description: description === undefined ? undefined : (description ? String(description).trim() : null),
    imageUrl: imageUrl === undefined ? undefined : (imageUrl || null),
    imageUrlBack: imageUrlBack === undefined ? undefined : (imageUrlBack || null),
    itemUrl: itemUrl === undefined ? undefined : itemUrl || null,
    referenceUrl: referenceUrl === undefined ? undefined : referenceUrl || null,
    unitCostCents:
      unitCostCents === undefined
        ? undefined
        : Number.isFinite(unitCostCents) && unitCostCents >= 0
        ? Math.round(unitCostCents)
        : null,
    unit: unit === undefined ? undefined : unit ? String(unit).trim().toLowerCase() : 'unit',
    notes: notes === undefined ? undefined : notes || null
  };

  const fields = [];
  const params = { id: itemId, updatedAt: new Date().toISOString() };

  if (normalized.name) {
    fields.push('name = @name');
    params.name = normalized.name;
  }
  if (normalized.material !== null && normalized.material !== undefined) {
    fields.push('material = @material');
    params.material = normalized.material;
  }
  if (normalized.color !== undefined) {
    fields.push('color = @color');
    params.color = normalized.color;
  }
  if (normalized.colorName !== undefined) {
    fields.push('color_name = @colorName');
    params.colorName = normalized.colorName;
  }
  if (normalized.size !== null) {
    fields.push('size = @size');
    params.size = normalized.size;
  }
  if (normalized.fabric !== undefined) {
    fields.push('fabric = @fabric');
    params.fabric = normalized.fabric;
  }
  if (normalized.description !== undefined) {
    fields.push('description = @description');
    params.description = normalized.description;
  }
  if (normalized.imageUrl !== undefined) {
    fields.push('image_url = @imageUrl');
    params.imageUrl = normalized.imageUrl;
  }
  if (normalized.imageUrlBack !== undefined) {
    fields.push('image_url_back = @imageUrlBack');
    params.imageUrlBack = normalized.imageUrlBack;
  }
  if (normalized.itemUrl !== undefined) {
    fields.push('item_url = @itemUrl');
    params.itemUrl = normalized.itemUrl;
  }
  if (normalized.referenceUrl !== undefined) {
    fields.push('reference_url = @referenceUrl');
    params.referenceUrl = normalized.referenceUrl;
  }
  if (normalized.unitCostCents !== undefined) {
    fields.push('unit_cost_cents = @unitCostCents');
    params.unitCostCents = normalized.unitCostCents;
  }
  if (normalized.unit !== undefined) {
    fields.push('unit = @unit');
    params.unit = normalized.unit;
  }
  if (normalized.notes !== undefined) {
    fields.push('notes = @notes');
    params.notes = normalized.notes;
  }

  if (!fields.length) {
    return getInventoryItemById(itemId);
  }

  fields.push('updated_at = @updatedAt');

  db.prepare(`UPDATE inventory_items SET ${fields.join(', ')} WHERE id = @id`).run(params);
  return getInventoryItemById(itemId);
}

function deleteInventoryItem(itemId) {
  const item = db
    .prepare('SELECT * FROM inventory_items WHERE id = ?')
    .get(itemId);
  if (!item) {
    throw new Error('Inventory item not found.');
  }
  // Create backup before deleting inventory items
  try { createBackup('before-inventory-delete'); } catch (_) {}
  db.prepare('DELETE FROM inventory_items WHERE id = ?').run(itemId);
  return { success: true };
}

function sanitizeInventoryUsageEntries(entries = []) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => ({
      itemId: entry.itemId || entry.id,
      quantity: Number(entry.quantity || entry.amount || entry.count || 0),
      reason: entry.reason || null,
      notes: entry.notes || null
    }))
    .filter((entry) => entry.itemId && Number.isFinite(entry.quantity) && entry.quantity > 0)
    .map((entry) => ({
      ...entry,
      quantity: Math.round(entry.quantity)
    }));
}

const recordOrderInventoryUsageTx = db.transaction((orderId, entries) => {
  const results = [];
  entries.forEach((entry) => {
    const item = db
      .prepare('SELECT * FROM inventory_items WHERE id = ?')
      .get(entry.itemId);
    if (!item) {
      throw new Error('Inventory item not found.');
    }
    const change = -Math.abs(entry.quantity);
    const nextQuantity = Number(item.quantity || 0) + change;
    if (nextQuantity < 0) {
      throw new Error(`Insufficient stock for ${item.name}.`);
    }
    const timestamp = new Date().toISOString();
    db.prepare(
      `UPDATE inventory_items
          SET quantity = @quantity,
              updated_at = @updatedAt
        WHERE id = @id`
    ).run({
      id: entry.itemId,
      quantity: nextQuantity,
      updatedAt: timestamp
    });
    addInventoryTransaction({
      itemId: entry.itemId,
      change,
      reason: entry.reason || 'order-usage',
      orderId,
      notes: entry.notes || null,
      timestamp
    });
    results.push({
      itemId: entry.itemId,
      quantity: Math.abs(change),
      name: item.name,
      color: item.color,
      material: item.material,
      unit: item.unit,
      unitCostCents: Number.isInteger(item.unit_cost_cents) ? item.unit_cost_cents : null,
      notes: entry.notes || null
    });
  });
  return results;
});

function recordOrderInventoryUsage(orderId, entries = []) {
  const sanitized = sanitizeInventoryUsageEntries(entries);
  if (!sanitized.length) return [];
  return recordOrderInventoryUsageTx(orderId, sanitized);
}

function seedVinylInventory() {
  const countRow = db.prepare('SELECT COUNT(*) AS count FROM inventory_items').get();
  if (countRow && countRow.count > 0) {
    return;
  }
  const seeds = [
    ...REGULAR_VINYL_SEED_ITEMS.map((item) => ({
      ...item,
      material: 'regular-vinyl',
      unit: 'ft',
      notes: 'Seeded from regular vinyl palette'
    })),
    ...HEAT_TRANSFER_SEED_ITEMS.map((item) => ({
      ...item,
      material: 'heat-transfer',
      unit: 'ft',
      notes: 'Seeded from heat transfer vinyl palette'
    }))
  ];

  seeds.forEach((seed) => {
    try {
      createInventoryItem(seed);
    } catch (error) {
      console.warn('Unable to seed inventory item:', seed.name, error.message);
    }
  });
}

function mapRaceQuoteRow(row) {
  return {
    id: row.id,
    quoteNumber: row.quote_number,
    customerId: row.customer_id,
    business: row.business,
    contactName: row.contact_name,
    requestDate: row.request_date,
    vehicle: row.vehicle,
    colors: row.colors,
    packageOption: row.package_option,
    addons: safeParse(row.addons, []),
    notes: row.notes,
    status: row.status || 'submitted',
    baseCents: row.base_cents || 0,
    addonsCents: row.addons_cents || 0,
    subtotalCents: row.subtotal_cents || 0,
    taxCents: row.tax_cents || 0,
    totalCents: row.total_cents || 0,
    adminNotes: row.admin_notes,
    paymentLink: row.payment_link,
    paymentLinkId: row.payment_link_id,
    paymentStatus: row.payment_status || 'UNPAID',
    paymentDetails: safeParse(row.payment_details, null),
    timelineText: row.timeline_text || '',
    deliveryText: row.delivery_text || '',
    pricingNotes: row.pricing_notes || '',
    quoteValidUntil: row.quote_valid_until || '',
    customerResponse: row.customer_response || null,
    customerResponseAt: row.customer_response_at || null,
    racingBody: row.racing_body || '',
    carNumber: row.car_number || '',
    coDriver: row.co_driver || '',
    driverCountry: row.driver_country || '',
    coDriverCountry: row.co_driver_country || '',
    sponsors: safeParse(row.sponsors, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    customer: row.customer_email
      ? {
          name: row.customer_name,
          email: row.customer_email,
          phone: row.customer_phone,
          address: row.customer_address
        }
      : null
  };
}

function getNextQuoteNumber() {
  const row = db.prepare('SELECT MAX(quote_number) AS max FROM race_quotes').get();
  const currentMax = row?.max || 299;
  return currentMax + 1;
}

function createRaceQuoteMessage({ quoteId, sender, message }) {
  if (!quoteId || !sender || !message) {
    throw new Error('quoteId, sender, and message are required.');
  }
  const id = `rqmsg-${crypto.randomUUID()}`;
  const text = String(message || '').trim();
  if (!text) {
    throw new Error('Message cannot be empty.');
  }
  db.prepare(
    `INSERT INTO race_quote_messages (id, quote_id, sender, message)
     VALUES (?, ?, ?, ?)`
  ).run(id, quoteId, sender, text);
  return getRaceQuoteMessageById(id);
}

function getRaceQuoteMessageById(id) {
  const row = db
    .prepare(
      `SELECT id, quote_id AS quoteId, sender, message, created_at AS createdAt
       FROM race_quote_messages
       WHERE id = ?`
    )
    .get(id);
  return row || null;
}

function listRaceQuoteMessages(quoteId) {
  return db
    .prepare(
      `SELECT id, quote_id AS quoteId, sender, message, created_at AS createdAt
       FROM race_quote_messages
       WHERE quote_id = ?
       ORDER BY datetime(created_at) ASC`
    )
    .all(quoteId);
}

function addRaceQuoteFile({ quoteId, storedName, originalName, mimeType, size }) {
  if (!quoteId || !storedName || !originalName) {
    throw new Error('quoteId, storedName, and originalName are required.');
  }
  const id = `rqfile-${crypto.randomUUID()}`;
  db.prepare(
    `INSERT INTO race_quote_files (id, quote_id, stored_name, original_name, mime_type, size)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, quoteId, storedName, originalName, mimeType || null, Number(size) || null);
  return getRaceQuoteFileById(id);
}

function getRaceQuoteFileById(id) {
  const row = db
    .prepare(
      `SELECT id, quote_id AS quoteId, stored_name AS storedName, original_name AS originalName,
              mime_type AS mimeType, size, created_at AS createdAt
       FROM race_quote_files
       WHERE id = ?`
    )
    .get(id);
  return row || null;
}

function listRaceQuoteFiles(quoteId) {
  return db
    .prepare(
      `SELECT id, quote_id AS quoteId, stored_name AS storedName, original_name AS originalName,
              mime_type AS mimeType, size, created_at AS createdAt
       FROM race_quote_files
       WHERE quote_id = ?
       ORDER BY datetime(created_at) ASC`
    )
    .all(quoteId);
}

function createRaceQuote({
  customerId,
  business,
  contactName,
  requestDate,
  vehicle,
  colors,
  packageOption,
  addons = [],
  notes = '',
  racingBody = '',
  carNumber = '',
  coDriver = '',
  sponsors = [],
  driverCountry = '',
  coDriverCountry = ''
}) {
  if (!customerId) {
    throw new Error('customerId is required to create a race quote.');
  }
  const id = `quote-${crypto.randomUUID()}`;
  const quoteNumber = getNextQuoteNumber();
  const addonsJson = JSON.stringify(addons || []);
  const sponsorsJson = JSON.stringify(sponsors || []);
  db.prepare(
    `INSERT INTO race_quotes (
      id, quote_number, customer_id, business, contact_name, request_date,
      vehicle, colors, package_option, addons, notes, status,
      racing_body, car_number, co_driver, driver_country, co_driver_country, sponsors
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    quoteNumber,
    customerId,
    business || '',
    contactName || '',
    requestDate || new Date().toISOString().slice(0, 10),
    vehicle || '',
    colors || '',
    packageOption || '',
    addonsJson,
    notes || '',
    racingBody || '',
    carNumber || '',
    coDriver || '',
    driverCountry || '',
    coDriverCountry || '',
    sponsorsJson
  );
  return getRaceQuoteById(id);
}

function updateRaceQuote(id, updates = {}) {
  if (!id) {
    throw new Error('Quote id is required.');
  }
  const fields = [];
  const params = {};

  const allowedNumeric = ['baseCents', 'addonsCents', 'subtotalCents', 'taxCents', 'totalCents'];
  allowedNumeric.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      const column = key.replace(/([A-Z])/g, '_$1').toLowerCase();
      fields.push(`${column} = @${key}`);
      params[key] = Number.isFinite(updates[key]) ? Math.round(updates[key]) : null;
    }
  });

  const allowedText = [
    'business',
    'contactName',
    'requestDate',
    'vehicle',
    'colors',
    'packageOption',
    'notes',
    'adminNotes',
    'status',
    'paymentLink',
    'paymentLinkId',
    'paymentStatus',
    'racingBody',
    'carNumber',
    'coDriver',
    'driverCountry',
    'coDriverCountry'
  ];

  allowedText.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      const column = key.replace(/([A-Z])/g, '_$1').toLowerCase();
      fields.push(`${column} = @${key}`);
      params[key] = updates[key];
    }
  });

  if (Object.prototype.hasOwnProperty.call(updates, 'addons')) {
    fields.push('addons = @addons');
    params.addons = JSON.stringify(updates.addons || []);
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'paymentDetails')) {
    fields.push('payment_details = @paymentDetails');
    params.paymentDetails = JSON.stringify(updates.paymentDetails || null);
  }

  const additionalText = {
    timelineText: 'timeline_text',
    deliveryText: 'delivery_text',
    pricingNotes: 'pricing_notes',
    quoteValidUntil: 'quote_valid_until',
    customerResponse: 'customer_response',
    customerResponseAt: 'customer_response_at',
    designId: 'design_id',
    designPreview: 'design_preview'
  };

  Object.entries(additionalText).forEach(([key, column]) => {
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      fields.push(`${column} = @${key}`);
      params[key] = updates[key] || null;
    }
  });

  if (Object.prototype.hasOwnProperty.call(updates, 'sponsors')) {
    fields.push('sponsors = @sponsors');
    params.sponsors = JSON.stringify(updates.sponsors || []);
  }

  if (!fields.length) {
    return getRaceQuoteById(id);
  }

  fields.push('updated_at = CURRENT_TIMESTAMP');
  const sql = `UPDATE race_quotes SET ${fields.join(', ')} WHERE id = @id`;
  db.prepare(sql).run({ ...params, id });
  return getRaceQuoteById(id);
}

function getRaceQuoteById(id) {
  const row = db
    .prepare(
      `SELECT race_quotes.*, customers.name AS customer_name, customers.email AS customer_email,
              customers.phone AS customer_phone, customers.address AS customer_address
       FROM race_quotes
       LEFT JOIN customers ON customers.id = race_quotes.customer_id
       WHERE race_quotes.id = ?`
    )
    .get(id);
  return row ? mapRaceQuoteRow(row) : null;
}

function fetchRaceQuotesByCustomer(customerId) {
  const rows = db
    .prepare(
      `SELECT race_quotes.*, customers.name AS customer_name, customers.email AS customer_email,
              customers.phone AS customer_phone, customers.address AS customer_address
       FROM race_quotes
       LEFT JOIN customers ON customers.id = race_quotes.customer_id
       WHERE race_quotes.customer_id = ?
       ORDER BY datetime(race_quotes.created_at) DESC`
    )
    .all(customerId);
  return rows.map(mapRaceQuoteRow);
}

function fetchAllRaceQuotes() {
  const rows = db
    .prepare(
      `SELECT race_quotes.*, customers.name AS customer_name, customers.email AS customer_email,
              customers.phone AS customer_phone, customers.address AS customer_address
       FROM race_quotes
       LEFT JOIN customers ON customers.id = race_quotes.customer_id
       ORDER BY datetime(race_quotes.created_at) DESC`
    )
    .all();
  return rows.map(mapRaceQuoteRow);
}

function setRaceQuotePaymentLink(id, { url, linkId }) {
  if (!id) return;
  db.prepare(
    `UPDATE race_quotes
        SET payment_link = ?,
            payment_link_id = ?,
            payment_status = CASE WHEN ? IS NOT NULL THEN 'PENDING' ELSE payment_status END,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`
  ).run(url || null, linkId || null, url || null, id);
}

function markRaceQuotePaid(id, paymentDetails = {}) {
  if (!id) return;
  db.prepare(
    `UPDATE race_quotes
        SET payment_status = 'PAID',
            status = CASE WHEN status IN ('awaiting_payment','quoted') THEN 'approved' ELSE status END,
            payment_details = @paymentDetails,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = @id`
  ).run({
    id,
    paymentDetails: JSON.stringify(paymentDetails || null)
  });
}

function findRaceQuoteByPaymentLinkId(linkId) {
  if (!linkId) return null;
  const row = db
    .prepare(
      `SELECT race_quotes.*, customers.name AS customer_name, customers.email AS customer_email,
              customers.phone AS customer_phone, customers.address AS customer_address
       FROM race_quotes
       LEFT JOIN customers ON customers.id = race_quotes.customer_id
       WHERE race_quotes.payment_link_id = ?
       LIMIT 1`
    )
    .get(linkId);
  return row ? mapRaceQuoteRow(row) : null;
}

function duplicateOrder(id) {
  const order = getOrderById(id);
  if (!order) throw new Error('Order not found.');

  const newId = `${order.designId || 'design'}-${Date.now()}`;
  const savedAt = new Date().toISOString();
  const nextNumber = getNextOrderNumber();

  db.prepare(
    `INSERT INTO orders (
      id, order_number, customer_id, design_id, design_name, category, size, color,
      background, quantity, notes, text_layers, preview_file, metadata_path,
      source_files, pricing, payment_link, payment_link_id,
      payment_status, payment_details, downloaded_at, downloaded_by, completed_at,
      saved_at, paid, internal_notes, bytes_written
    )
    SELECT
      ?, ?, customer_id, design_id, design_name, category, size, color,
      background, quantity, notes, text_layers, preview_file, metadata_path,
      source_files, pricing, NULL, NULL,
      'UNPAID', NULL, NULL, NULL, NULL,
      ?, 0, internal_notes, bytes_written
    FROM orders WHERE id = ?`
  ).run(newId, nextNumber, savedAt, id);

  return getOrderById(newId);
}

function findCustomerById(id) {
  const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  if (!row) return null;
  row.remember_token = ensureRememberToken(row.id);
  return formatCustomer(row);
}

function createEmailToken(customerId, type, expiresHours = 24) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + expiresHours * 60 * 60 * 1000).toISOString();
  db.prepare(
    `INSERT INTO auth_tokens (customer_id, token, type, expires_at)
     VALUES (?, ?, ?, ?)`
  ).run(customerId, token, type, expiresAt);
  return { token, expiresAt };
}

function getNextOrderNumber() {
  const row = db.prepare('SELECT MAX(order_number) AS max FROM orders').get();
  const currentMax = row?.max || 999;
  return currentMax + 1;
}

function consumeEmailToken(token, type) {
  const row = db
    .prepare(
      `SELECT * FROM auth_tokens
       WHERE token = ? AND type = ? AND used = 0`
    )
    .get(token, type);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('UPDATE auth_tokens SET used = 1 WHERE id = ?').run(row.id);
    return null;
  }
  db.prepare('UPDATE auth_tokens SET used = 1 WHERE id = ?').run(row.id);
  return row;
}

function createLoginCode(customerId, ttlMinutes = 30) {
  const expiresAt = new Date(Date.now() + Math.max(1, ttlMinutes) * 60 * 1000).toISOString();
  // Generate a 6-digit numeric code and insert as a unique token
  // Retry on rare collision
  let attempts = 0;
  while (attempts < 5) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    try {
      db.prepare(
        `INSERT INTO auth_tokens (customer_id, token, type, expires_at)
         VALUES (?, ?, 'login_code', ?)`
      ).run(customerId, code, expiresAt);
      return { code, expiresAt };
    } catch (e) {
      attempts += 1;
    }
  }
  // Fallback to random hex if collisions persist
  const code = crypto.randomBytes(3).toString('hex');
  db.prepare(
    `INSERT INTO auth_tokens (customer_id, token, type, expires_at)
     VALUES (?, ?, 'login_code', ?)`
  ).run(customerId, code, expiresAt);
  return { code, expiresAt };
}

function consumeLoginCode(customerId, code) {
  if (!customerId || !code) return null;
  const row = db
    .prepare(
      `SELECT * FROM auth_tokens
       WHERE customer_id = ? AND token = ? AND type = 'login_code' AND used = 0`
    )
    .get(customerId, String(code).trim());
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('UPDATE auth_tokens SET used = 1 WHERE id = ?').run(row.id);
    return null;
  }
  db.prepare('UPDATE auth_tokens SET used = 1 WHERE id = ?').run(row.id);
  return row;
}

function markEmailVerified(customerId) {
  db.prepare(
    `UPDATE customers
       SET email_verified = 1,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(customerId);
}

function updateCustomerPassword(customerId, password) {
  const hash = bcrypt.hashSync(password, 12);
  db.prepare(
    `UPDATE customers
       SET password_hash = ?,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(hash, customerId);
}

function updateCustomerProfile(customerId, updates = {}) {
  if (!customerId) throw new Error('customerId is required');
  const fields = [];
  const params = { id: customerId };
  if (Object.prototype.hasOwnProperty.call(updates, 'name')) {
    fields.push('name = @name');
    params.name = updates.name || '';
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'phone')) {
    fields.push('phone = @phone');
    params.phone = normalizePhone(updates.phone);
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'address')) {
    fields.push('address = @address');
    params.address = updates.address || '';
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'smsOptIn')) {
    fields.push('sms_opt_in = @sms');
    params.sms = updates.smsOptIn ? 1 : 0;
  }
  if (!fields.length) return findCustomerById(customerId);
  const sql = `UPDATE customers SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = @id`;
  db.prepare(sql).run(params);
  return findCustomerById(customerId);
}

function setOrderPaymentLink(id, { url, linkId }) {
  db.prepare(
    `UPDATE orders
        SET payment_link = ?,
            payment_link_id = ?,
            payment_status = CASE WHEN ? IS NOT NULL THEN 'PENDING' ELSE payment_status END
      WHERE id = ?`
  ).run(url || null, linkId || null, url || null, id);
}

function markOrderPaid(id, paymentDetails = {}) {
  db.prepare(
    `UPDATE orders
        SET paid = 1,
            payment_status = 'PAID',
            payment_details = @details
      WHERE id = @id`
  ).run({
    id,
    details: JSON.stringify(paymentDetails)
  });
}

function getArtworkForSku(sku) {
  if (!sku) return null;
  const row = db
    .prepare('SELECT artwork_path FROM sku_artwork_map WHERE sku = ?')
    .get(String(sku));
  return row ? row.artwork_path : null;
}

function upsertArtworkForSku(sku, artworkPath) {
  if (!sku || !artworkPath) return false;
  const sql =
    'INSERT INTO sku_artwork_map (sku, artwork_path) VALUES (@sku, @artwork) ' +
    'ON CONFLICT(sku) DO UPDATE SET artwork_path = excluded.artwork_path';
  try {
    db.prepare(sql).run({ sku: String(sku), artwork: String(artworkPath) });
    return true;
  } catch (error) {
    // Older SQLite may not support ON CONFLICT DO UPDATE; fall back
    try {
      const existing = db
        .prepare('SELECT sku FROM sku_artwork_map WHERE sku = ?')
        .get(String(sku));
      if (existing) {
        db.prepare('UPDATE sku_artwork_map SET artwork_path = ? WHERE sku = ?').run(
          String(artworkPath),
          String(sku)
        );
      } else {
        db.prepare('INSERT INTO sku_artwork_map (sku, artwork_path) VALUES (?, ?)').run(
          String(sku),
          String(artworkPath)
        );
      }
      return true;
    } catch (_) {
      return false;
    }
  }
}

function upsertPodOrder({
  shopifyOrderId,
  shopifyOrderNumber,
  status,
  shippingName,
  shippingAddress,
  customerEmail
} = {}) {
  if (!shopifyOrderId) {
    throw new Error('shopifyOrderId is required for POD orders.');
  }
  const existing = db
    .prepare('SELECT * FROM pod_orders WHERE shopify_order_id = ?')
    .get(String(shopifyOrderId));
  const payload = {
    shopify_order_id: String(shopifyOrderId),
    shopify_order_number: shopifyOrderNumber ? String(shopifyOrderNumber) : null,
    status: status || (existing ? existing.status : 'pending'),
    shipping_name: shippingName || (existing ? existing.shipping_name : null),
    shipping_address_json: shippingAddress
      ? JSON.stringify(shippingAddress)
      : existing
      ? existing.shipping_address_json
      : null,
    customer_email: customerEmail || (existing ? existing.customer_email : null)
  };

  if (existing) {
    db.prepare(
      `UPDATE pod_orders
         SET shopify_order_number = @shopify_order_number,
             status = @status,
             shipping_name = @shipping_name,
             shipping_address_json = @shipping_address_json,
             customer_email = @customer_email,
             updated_at = CURRENT_TIMESTAMP
       WHERE shopify_order_id = @shopify_order_id`
    ).run(payload);
    const row = db
      .prepare('SELECT * FROM pod_orders WHERE shopify_order_id = ?')
      .get(String(shopifyOrderId));
    return mapPodOrderRow(row);
  }

  const info = db
    .prepare(
      `INSERT INTO pod_orders
         (shopify_order_id, shopify_order_number, status, shipping_name, shipping_address_json, customer_email)
       VALUES (@shopify_order_id, @shopify_order_number, @status, @shipping_name, @shipping_address_json, @customer_email)`
    )
    .run(payload);
  const row = db
    .prepare('SELECT * FROM pod_orders WHERE id = ?')
    .get(info.lastInsertRowid);
  return mapPodOrderRow(row);
}

function getPodOrderByShopifyOrderId(shopifyOrderId) {
  if (!shopifyOrderId) return null;
  const row = db
    .prepare('SELECT * FROM pod_orders WHERE shopify_order_id = ?')
    .get(String(shopifyOrderId));
  return row ? mapPodOrderRow(row) : null;
}

function upsertPodLineItem({
  orderId,
  shopifyLineItemId,
  sku,
  name,
  quantity,
  status,
  artworkPath,
  properties
} = {}) {
  if (!orderId || !shopifyLineItemId) {
    throw new Error('orderId and shopifyLineItemId are required for POD line items.');
  }
  const existing = db
    .prepare('SELECT * FROM pod_order_line_items WHERE shopify_line_item_id = ?')
    .get(String(shopifyLineItemId));
  const payload = {
    order_id: orderId,
    shopify_line_item_id: String(shopifyLineItemId),
    sku: sku || null,
    name: name || null,
    quantity: Number.isFinite(Number(quantity)) ? Number(quantity) : existing?.quantity || 0,
    status: status || (existing ? existing.status : 'pending'),
    artwork_path: artworkPath || (existing ? existing.artwork_path : null),
    properties_json: properties ? JSON.stringify(properties) : existing?.properties_json || null
  };

  if (existing) {
    db.prepare(
      `UPDATE pod_order_line_items
         SET order_id = @order_id,
             sku = @sku,
             name = @name,
             quantity = @quantity,
             status = @status,
             artwork_path = @artwork_path,
             properties_json = @properties_json,
             updated_at = CURRENT_TIMESTAMP
       WHERE shopify_line_item_id = @shopify_line_item_id`
    ).run(payload);
    const row = db
      .prepare('SELECT * FROM pod_order_line_items WHERE shopify_line_item_id = ?')
      .get(String(shopifyLineItemId));
    return mapPodLineItemRow(row);
  }

  const info = db
    .prepare(
      `INSERT INTO pod_order_line_items
         (order_id, shopify_line_item_id, sku, name, quantity, status, artwork_path, properties_json)
       VALUES (@order_id, @shopify_line_item_id, @sku, @name, @quantity, @status, @artwork_path, @properties_json)`
    )
    .run(payload);
  const row = db
    .prepare('SELECT * FROM pod_order_line_items WHERE id = ?')
    .get(info.lastInsertRowid);
  return mapPodLineItemRow(row);
}

function getPodLineItemByShopifyId(shopifyLineItemId) {
  if (!shopifyLineItemId) return null;
  const row = db
    .prepare('SELECT * FROM pod_order_line_items WHERE shopify_line_item_id = ?')
    .get(String(shopifyLineItemId));
  return row ? mapPodLineItemRow(row) : null;
}

function listOpenPodOrders() {
  const rows = db
    .prepare(
      `SELECT
         o.id AS order_id,
         o.shopify_order_id,
         o.shopify_order_number,
         o.status AS order_status,
         o.shipping_name,
         o.shipping_address_json,
         o.customer_email,
         o.created_at AS order_created_at,
         o.updated_at AS order_updated_at,
         li.id AS line_id,
         li.shopify_line_item_id,
         li.sku,
         li.name AS line_name,
         li.quantity,
         li.status AS line_status,
         li.artwork_path,
         li.properties_json,
         li.created_at AS line_created_at,
         li.updated_at AS line_updated_at
       FROM pod_orders o
       JOIN pod_order_line_items li ON li.order_id = o.id
       WHERE li.status != 'shipped'
       ORDER BY datetime(o.created_at) ASC, o.id ASC, li.id ASC`
    )
    .all();

  const byOrder = new Map();
  for (const row of rows) {
    const key = row.order_id;
    if (!byOrder.has(key)) {
      const orderRow = {
        id: row.order_id,
        shopify_order_id: row.shopify_order_id,
        shopify_order_number: row.shopify_order_number,
        status: row.order_status,
        shipping_name: row.shipping_name,
        shipping_address_json: row.shipping_address_json,
        customer_email: row.customer_email,
        created_at: row.order_created_at,
        updated_at: row.order_updated_at
      };
      byOrder.set(key, {
        order: mapPodOrderRow(orderRow),
        lineItems: []
      });
    }
    const lineRow = {
      id: row.line_id,
      order_id: row.order_id,
      shopify_line_item_id: row.shopify_line_item_id,
      sku: row.sku,
      name: row.line_name,
      quantity: row.quantity,
      status: row.line_status,
      artwork_path: row.artwork_path,
      properties_json: row.properties_json,
      created_at: row.line_created_at,
      updated_at: row.line_updated_at
    };
    byOrder.get(key).lineItems.push(mapPodLineItemRow(lineRow));
  }

  return Array.from(byOrder.values());
}

function markPodLineItemsShipped(shopifyLineItemIds = []) {
  const ids = Array.isArray(shopifyLineItemIds)
    ? shopifyLineItemIds.map((v) => String(v)).filter(Boolean)
    : [];
  if (!ids.length) return;

  const orderIds = new Set();
  const getOrderStmt = db.prepare(
    'SELECT order_id FROM pod_order_line_items WHERE shopify_line_item_id = ?'
  );
  const updateLineStmt = db.prepare(
    `UPDATE pod_order_line_items
       SET status = 'shipped',
           updated_at = CURRENT_TIMESTAMP
     WHERE shopify_line_item_id = ?`
  );

  ids.forEach((id) => {
    const row = getOrderStmt.get(id);
    if (row && row.order_id) {
      orderIds.add(row.order_id);
    }
    updateLineStmt.run(id);
  });

  const hasUnshippedStmt = db.prepare(
    'SELECT COUNT(*) AS count FROM pod_order_line_items WHERE order_id = ? AND status != \'shipped\''
  );
  const updateOrderStmt = db.prepare(
    `UPDATE pod_orders
       SET status = 'shipped',
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  );

  Array.from(orderIds).forEach((orderId) => {
    const row = hasUnshippedStmt.get(orderId);
    if (!row || Number(row.count || 0) === 0) {
      updateOrderStmt.run(orderId);
    }
  });
}

// ============================================================================
// CUSTOM ART MODULE - Rooms, Artwork, Materials, Products
// ============================================================================

function initCustomArtTables() {
  console.log('[Custom Art] Initializing tables...');

  // Rooms - background photos for mockups
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_art_rooms (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      room_type TEXT,
      description TEXT,
      tags TEXT,
      image_path TEXT NOT NULL,
      thumbnail_path TEXT,
      active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_custom_art_rooms_active ON custom_art_rooms(active);
    CREATE INDEX IF NOT EXISTS idx_custom_art_rooms_type ON custom_art_rooms(room_type);
  `);

  // Migration: Add tags column if not exists
  try {
    db.exec(`ALTER TABLE custom_art_rooms ADD COLUMN tags TEXT`);
  } catch (e) {
    // Column may already exist
  }

  // Artwork catalog
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_art_artwork (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      tags TEXT,
      category TEXT,
      style TEXT,
      dimensions_width REAL,
      dimensions_height REAL,
      dimensions_unit TEXT DEFAULT 'inches',
      file_path TEXT NOT NULL,
      optimized_path TEXT,
      thumbnail_path TEXT,
      status TEXT DEFAULT 'draft',
      active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_custom_art_artwork_status ON custom_art_artwork(status);
    CREATE INDEX IF NOT EXISTS idx_custom_art_artwork_category ON custom_art_artwork(category);
    CREATE INDEX IF NOT EXISTS idx_custom_art_artwork_active ON custom_art_artwork(active);
  `);

  // Migration: Add seo_filename column if it doesn't exist
  try {
    db.exec(`ALTER TABLE custom_art_artwork ADD COLUMN seo_filename TEXT`);
  } catch (e) {
    // Column already exists, ignore
  }

  // Human Models (for mockups)
  db.exec(`
    CREATE TABLE IF NOT EXISTS human_models (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      tags TEXT,
      category TEXT,
      gender TEXT,
      pose_type TEXT,
      seo_filename TEXT,
      file_path TEXT NOT NULL,
      optimized_path TEXT,
      thumbnail_path TEXT,
      mask_path TEXT,
      status TEXT DEFAULT 'draft',
      active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_human_models_status ON human_models(status);
    CREATE INDEX IF NOT EXISTS idx_human_models_category ON human_models(category);
    CREATE INDEX IF NOT EXISTS idx_human_models_gender ON human_models(gender);
    CREATE INDEX IF NOT EXISTS idx_human_models_active ON human_models(active);
  `);

  // Migration: add mask_path column if missing
  ensureColumn('human_models', 'mask_path', 'TEXT');

  // Recolored Human Models (AI-generated color variants)
  db.exec(`
    CREATE TABLE IF NOT EXISTS human_model_color_variants (
      id TEXT PRIMARY KEY,
      model_id TEXT NOT NULL,
      color TEXT NOT NULL,
      garment_type TEXT NOT NULL DEFAULT 't-shirt',
      file_path TEXT NOT NULL,
      web_path TEXT NOT NULL,
      cache_key TEXT UNIQUE NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (model_id) REFERENCES human_models(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_hm_color_variants_model ON human_model_color_variants(model_id);
    CREATE INDEX IF NOT EXISTS idx_hm_color_variants_color ON human_model_color_variants(color);
    CREATE INDEX IF NOT EXISTS idx_hm_color_variants_cache ON human_model_color_variants(cache_key);
  `);

  // Materials (canvas, metal, wood, acrylic, etc.)
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_art_materials (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      filter_type TEXT,
      base_cost_cents INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_custom_art_materials_active ON custom_art_materials(active);
  `);

  // Products with pricing
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_art_products (
      id TEXT PRIMARY KEY,
      artwork_id TEXT,
      title TEXT NOT NULL,
      description TEXT,
      has_variants INTEGER DEFAULT 0,
      base_price_cents INTEGER DEFAULT 0,
      cost_cents INTEGER DEFAULT 0,
      material_id TEXT,
      single_size_width REAL,
      single_size_height REAL,
      size_unit TEXT DEFAULT 'inches',
      mockup_path TEXT,
      mockup_room_id TEXT,
      shopify_product_id TEXT,
      shopify_handle TEXT,
      status TEXT DEFAULT 'draft',
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (artwork_id) REFERENCES custom_art_artwork(id) ON DELETE SET NULL,
      FOREIGN KEY (material_id) REFERENCES custom_art_materials(id) ON DELETE SET NULL,
      FOREIGN KEY (mockup_room_id) REFERENCES custom_art_rooms(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_custom_art_products_artwork ON custom_art_products(artwork_id);
    CREATE INDEX IF NOT EXISTS idx_custom_art_products_status ON custom_art_products(status);
    CREATE INDEX IF NOT EXISTS idx_custom_art_products_shopify ON custom_art_products(shopify_product_id);
  `);

  // Product variants (when has_variants = 1)
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_art_product_variants (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      material_id TEXT,
      size_width REAL NOT NULL,
      size_height REAL NOT NULL,
      size_unit TEXT DEFAULT 'inches',
      price_cents INTEGER DEFAULT 0,
      cost_cents INTEGER DEFAULT 0,
      sku TEXT,
      shopify_variant_id TEXT,
      active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (product_id) REFERENCES custom_art_products(id) ON DELETE CASCADE,
      FOREIGN KEY (material_id) REFERENCES custom_art_materials(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_custom_art_variants_product ON custom_art_product_variants(product_id);
    CREATE INDEX IF NOT EXISTS idx_custom_art_variants_sku ON custom_art_product_variants(sku);

    -- Tiles table for split panel products
    CREATE TABLE IF NOT EXISTS custom_art_tiles (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      artwork_id TEXT,
      row_num INTEGER NOT NULL,
      col_num INTEGER NOT NULL,
      filename TEXT NOT NULL,
      file_path TEXT NOT NULL,
      url TEXT,
      width_inches REAL,
      height_inches REAL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (product_id) REFERENCES custom_art_products(id) ON DELETE CASCADE,
      FOREIGN KEY (artwork_id) REFERENCES custom_art_artwork(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_custom_art_tiles_product ON custom_art_tiles(product_id);
    CREATE INDEX IF NOT EXISTS idx_custom_art_tiles_artwork ON custom_art_tiles(artwork_id);
  `);

  // Mockups - standalone mockup images that can be associated with products/artwork/campaigns
  // Note: No FK constraints for simpler migration and fewer dependency issues
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_art_mockups (
      id TEXT PRIMARY KEY,
      title TEXT,
      filename TEXT NOT NULL,
      file_path TEXT NOT NULL,
      url TEXT,
      product_id TEXT,
      artwork_id TEXT,
      room_id TEXT,
      campaign_slug TEXT,
      material_id TEXT,
      mockup_type TEXT DEFAULT 'product',
      width INTEGER,
      height INTEGER,
      file_size INTEGER,
      tags TEXT,
      notes TEXT,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create indexes separately with try/catch for backward compatibility
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_custom_art_mockups_product ON custom_art_mockups(product_id)`); } catch (e) { /* ignore */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_custom_art_mockups_artwork ON custom_art_mockups(artwork_id)`); } catch (e) { /* ignore */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_custom_art_mockups_room ON custom_art_mockups(room_id)`); } catch (e) { /* ignore */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_custom_art_mockups_campaign ON custom_art_mockups(campaign_slug)`); } catch (e) { /* ignore */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_custom_art_mockups_type ON custom_art_mockups(mockup_type)`); } catch (e) { /* ignore */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_custom_art_mockups_active ON custom_art_mockups(active)`); } catch (e) { /* ignore */ }

  // Mockup Backgrounds - background images for compositing decal mockups in print-station
  db.exec(`
    CREATE TABLE IF NOT EXISTS mockup_backgrounds (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT DEFAULT 'general',
      description TEXT,
      file_path TEXT NOT NULL,
      thumbnail_path TEXT,
      width INTEGER,
      height INTEGER,
      file_size INTEGER,
      tags TEXT,
      default_width_pct INTEGER DEFAULT 40,
      default_x_offset INTEGER DEFAULT 0,
      default_y_offset INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create indexes for mockup_backgrounds
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_mockup_backgrounds_category ON mockup_backgrounds(category)`); } catch (e) { /* ignore */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_mockup_backgrounds_active ON mockup_backgrounds(active)`); } catch (e) { /* ignore */ }

  // Studio3 Catalog - stores parsed .studio3 files for catalog/training
  db.exec(`
    CREATE TABLE IF NOT EXISTS studio3_catalog (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      metadata TEXT,
      path_count INTEGER DEFAULT 0,
      image_count INTEGER DEFAULT 0,
      thumbnail TEXT,
      paths TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create indexes for studio3_catalog
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_studio3_catalog_filename ON studio3_catalog(filename)`); } catch (e) { /* ignore */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_studio3_catalog_created ON studio3_catalog(created_at)`); } catch (e) { /* ignore */ }

  // Seed default materials
  seedCustomArtMaterials();

  console.log('[Custom Art] ✅ Tables initialized successfully');
}

function seedCustomArtMaterials() {
  const defaultMaterials = [
    { id: 'mat_canvas', name: 'Canvas', description: 'Gallery-wrapped canvas print', filter_type: 'canvas', base_cost_cents: 2500 },
    { id: 'mat_metal', name: 'Metal', description: 'HD aluminum metal print', filter_type: 'metal', base_cost_cents: 3500 },
    { id: 'mat_wood', name: 'Wood', description: 'Laser burned wood plank', filter_type: 'none', base_cost_cents: 4000 },
    { id: 'mat_acrylic', name: 'Acrylic', description: 'Crystal clear acrylic print', filter_type: 'none', base_cost_cents: 4500 },
    { id: 'mat_poster', name: 'Poster', description: 'High-quality paper print', filter_type: 'none', base_cost_cents: 1000 },
    { id: 'mat_framed', name: 'Framed Print', description: 'Matted and framed print', filter_type: 'none', base_cost_cents: 5000 }
  ];

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO custom_art_materials (id, name, description, filter_type, base_cost_cents)
    VALUES (@id, @name, @description, @filter_type, @base_cost_cents)
  `);

  defaultMaterials.forEach((mat) => insertStmt.run(mat));
}

// --- ROOMS CRUD ---
function createCustomArtRoom({ title, roomType, description, tags, imagePath, thumbnailPath, active }) {
  const id = `room_${crypto.randomBytes(8).toString('hex')}`;
  const isActive = active !== false ? 1 : 0; // Default to active
  db.prepare(`
    INSERT INTO custom_art_rooms (id, title, room_type, description, tags, image_path, thumbnail_path, active)
    VALUES (@id, @title, @roomType, @description, @tags, @imagePath, @thumbnailPath, @active)
  `).run({ id, title, roomType: roomType || null, description: description || null, tags: tags || null, imagePath, thumbnailPath: thumbnailPath || null, active: isActive });
  return getCustomArtRoomById(id);
}

function updateCustomArtRoom(id, updates) {
  const fields = [];
  const params = { id };

  if (updates.title !== undefined) { fields.push('title = @title'); params.title = updates.title; }
  if (updates.roomType !== undefined) { fields.push('room_type = @roomType'); params.roomType = updates.roomType; }
  if (updates.description !== undefined) { fields.push('description = @description'); params.description = updates.description; }
  if (updates.tags !== undefined) { fields.push('tags = @tags'); params.tags = updates.tags; }
  if (updates.imagePath !== undefined) { fields.push('image_path = @imagePath'); params.imagePath = updates.imagePath; }
  if (updates.thumbnailPath !== undefined) { fields.push('thumbnail_path = @thumbnailPath'); params.thumbnailPath = updates.thumbnailPath; }
  if (updates.active !== undefined) { fields.push('active = @active'); params.active = updates.active ? 1 : 0; }
  if (updates.sortOrder !== undefined) { fields.push('sort_order = @sortOrder'); params.sortOrder = updates.sortOrder; }

  if (!fields.length) return getCustomArtRoomById(id);

  fields.push('updated_at = CURRENT_TIMESTAMP');
  db.prepare(`UPDATE custom_art_rooms SET ${fields.join(', ')} WHERE id = @id`).run(params);
  return getCustomArtRoomById(id);
}

function deleteCustomArtRoom(id) {
  db.prepare('DELETE FROM custom_art_rooms WHERE id = ?').run(id);
}

function getCustomArtRoomById(id) {
  const row = db.prepare('SELECT * FROM custom_art_rooms WHERE id = ?').get(id);
  return row ? mapCustomArtRoom(row) : null;
}

function listCustomArtRooms({ activeOnly = true, roomType } = {}) {
  let query = 'SELECT * FROM custom_art_rooms WHERE 1=1';
  const params = [];
  if (activeOnly) { query += ' AND active = 1'; }
  if (roomType) { query += ' AND room_type = ?'; params.push(roomType); }
  query += ' ORDER BY sort_order ASC, created_at DESC';
  return db.prepare(query).all(...params).map(mapCustomArtRoom);
}

function mapCustomArtRoom(row) {
  return {
    id: row.id,
    title: row.title,
    roomType: row.room_type,
    description: row.description,
    tags: row.tags,
    imagePath: row.image_path,
    thumbnailPath: row.thumbnail_path,
    active: Boolean(row.active),
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// --- ARTWORK CRUD ---
function createCustomArtArtwork({ title, description, tags, category, style, dimensionsWidth, dimensionsHeight, dimensionsUnit, filePath, optimizedPath, thumbnailPath, status }) {
  const id = `art_${crypto.randomBytes(8).toString('hex')}`;
  db.prepare(`
    INSERT INTO custom_art_artwork (id, title, description, tags, category, style, dimensions_width, dimensions_height, dimensions_unit, file_path, optimized_path, thumbnail_path, status)
    VALUES (@id, @title, @description, @tags, @category, @style, @dimensionsWidth, @dimensionsHeight, @dimensionsUnit, @filePath, @optimizedPath, @thumbnailPath, @status)
  `).run({
    id,
    title,
    description: description || null,
    tags: tags || null,
    category: category || null,
    style: style || null,
    dimensionsWidth: dimensionsWidth || null,
    dimensionsHeight: dimensionsHeight || null,
    dimensionsUnit: dimensionsUnit || 'inches',
    filePath,
    optimizedPath: optimizedPath || null,
    thumbnailPath: thumbnailPath || null,
    status: status || 'draft'
  });
  return getCustomArtArtworkById(id);
}

function updateCustomArtArtwork(id, updates) {
  const fields = [];
  const params = { id };

  if (updates.title !== undefined) { fields.push('title = @title'); params.title = updates.title; }
  if (updates.description !== undefined) { fields.push('description = @description'); params.description = updates.description; }
  if (updates.tags !== undefined) { fields.push('tags = @tags'); params.tags = updates.tags; }
  if (updates.category !== undefined) { fields.push('category = @category'); params.category = updates.category; }
  if (updates.style !== undefined) { fields.push('style = @style'); params.style = updates.style; }
  if (updates.dimensionsWidth !== undefined) { fields.push('dimensions_width = @dimensionsWidth'); params.dimensionsWidth = updates.dimensionsWidth; }
  if (updates.dimensionsHeight !== undefined) { fields.push('dimensions_height = @dimensionsHeight'); params.dimensionsHeight = updates.dimensionsHeight; }
  if (updates.dimensionsUnit !== undefined) { fields.push('dimensions_unit = @dimensionsUnit'); params.dimensionsUnit = updates.dimensionsUnit; }
  if (updates.filePath !== undefined) { fields.push('file_path = @filePath'); params.filePath = updates.filePath; }
  if (updates.optimizedPath !== undefined) { fields.push('optimized_path = @optimizedPath'); params.optimizedPath = updates.optimizedPath; }
  if (updates.thumbnailPath !== undefined) { fields.push('thumbnail_path = @thumbnailPath'); params.thumbnailPath = updates.thumbnailPath; }
  if (updates.status !== undefined) { fields.push('status = @status'); params.status = updates.status; }
  if (updates.active !== undefined) { fields.push('active = @active'); params.active = updates.active ? 1 : 0; }
  if (updates.sortOrder !== undefined) { fields.push('sort_order = @sortOrder'); params.sortOrder = updates.sortOrder; }
  if (updates.seoFilename !== undefined) { fields.push('seo_filename = @seoFilename'); params.seoFilename = updates.seoFilename; }

  if (!fields.length) return getCustomArtArtworkById(id);

  fields.push('updated_at = CURRENT_TIMESTAMP');
  db.prepare(`UPDATE custom_art_artwork SET ${fields.join(', ')} WHERE id = @id`).run(params);
  return getCustomArtArtworkById(id);
}

function deleteCustomArtArtwork(id) {
  db.prepare('DELETE FROM custom_art_artwork WHERE id = ?').run(id);
}

function getCustomArtArtworkById(id) {
  const row = db.prepare('SELECT * FROM custom_art_artwork WHERE id = ?').get(id);
  return row ? mapCustomArtArtwork(row) : null;
}

function listCustomArtArtwork({ activeOnly = true, status, category, search, limit = 100, offset = 0 } = {}) {
  let query = 'SELECT * FROM custom_art_artwork WHERE 1=1';
  const params = [];
  if (activeOnly) { query += ' AND active = 1'; }
  if (status) { query += ' AND status = ?'; params.push(status); }
  if (category) { query += ' AND category = ?'; params.push(category); }
  if (search) { query += ' AND (title LIKE ? OR tags LIKE ? OR description LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  query += ' ORDER BY sort_order ASC, created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return db.prepare(query).all(...params).map(mapCustomArtArtwork);
}

function listCustomArtArtworkCategories() {
  return db.prepare("SELECT DISTINCT category FROM custom_art_artwork WHERE category IS NOT NULL AND category != '' ORDER BY category").all().map(r => r.category);
}

function mapCustomArtArtwork(row) {
  // Generate preview path from file path if not already set
  let previewPath = row.thumbnail_path || row.optimized_path;
  if (!previewPath && row.file_path) {
    // Convert file_path to preview path by adding 'previews/' subdirectory
    // e.g., '/dbFiles/uploads/custom-art/image.jpg' -> '/dbFiles/uploads/custom-art/previews/image.jpg'
    const pathParts = row.file_path.split('/');
    const filename = pathParts.pop();
    previewPath = pathParts.join('/') + '/previews/' + filename.replace(/\.(png|PNG)$/, '.jpg');
  }

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    seoFilename: row.seo_filename,
    tags: row.tags,
    category: row.category,
    style: row.style,
    dimensions: {
      width: row.dimensions_width,
      height: row.dimensions_height,
      unit: row.dimensions_unit
    },
    filePath: row.file_path,
    optimizedPath: row.optimized_path,
    thumbnailPath: row.thumbnail_path,
    previewPath: previewPath,  // Add preview path for client use
    status: row.status,
    active: Boolean(row.active),
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// --- HUMAN MODELS CRUD ---
function createHumanModel({ title, description, tags, category, gender, poseType, seoFilename, filePath, optimizedPath, thumbnailPath, status }) {
  const id = `hm_${crypto.randomBytes(8).toString('hex')}`;
  db.prepare(`
    INSERT INTO human_models (id, title, description, tags, category, gender, pose_type, seo_filename, file_path, optimized_path, thumbnail_path, status)
    VALUES (@id, @title, @description, @tags, @category, @gender, @poseType, @seoFilename, @filePath, @optimizedPath, @thumbnailPath, @status)
  `).run({
    id,
    title,
    description: description || null,
    tags: tags || null,
    category: category || null,
    gender: gender || null,
    poseType: poseType || null,
    seoFilename: seoFilename || null,
    filePath,
    optimizedPath: optimizedPath || null,
    thumbnailPath: thumbnailPath || null,
    status: status || 'draft'
  });
  return getHumanModelById(id);
}

function updateHumanModel(id, updates) {
  const fields = [];
  const params = { id };

  if (updates.title !== undefined) { fields.push('title = @title'); params.title = updates.title; }
  if (updates.description !== undefined) { fields.push('description = @description'); params.description = updates.description; }
  if (updates.tags !== undefined) { fields.push('tags = @tags'); params.tags = updates.tags; }
  if (updates.category !== undefined) { fields.push('category = @category'); params.category = updates.category; }
  if (updates.gender !== undefined) { fields.push('gender = @gender'); params.gender = updates.gender; }
  if (updates.ethnicity !== undefined) { fields.push('ethnicity = @ethnicity'); params.ethnicity = updates.ethnicity; }
  if (updates.apparel_type !== undefined) { fields.push('apparel_type = @apparel_type'); params.apparel_type = updates.apparel_type; }
  if (updates.facing !== undefined) { fields.push('facing = @facing'); params.facing = updates.facing; }
  if (updates.poseType !== undefined) { fields.push('pose_type = @poseType'); params.poseType = updates.poseType; }
  if (updates.pose_type !== undefined) { fields.push('pose_type = @pose_type'); params.pose_type = updates.pose_type; }
  if (updates.seoFilename !== undefined) { fields.push('seo_filename = @seoFilename'); params.seoFilename = updates.seoFilename; }
  if (updates.filePath !== undefined) { fields.push('file_path = @filePath'); params.filePath = updates.filePath; }
  if (updates.optimizedPath !== undefined) { fields.push('optimized_path = @optimizedPath'); params.optimizedPath = updates.optimizedPath; }
  if (updates.thumbnailPath !== undefined) { fields.push('thumbnail_path = @thumbnailPath'); params.thumbnailPath = updates.thumbnailPath; }
  if (updates.status !== undefined) { fields.push('status = @status'); params.status = updates.status; }
  if (updates.active !== undefined) { fields.push('active = @active'); params.active = updates.active ? 1 : 0; }
  if (updates.sortOrder !== undefined) { fields.push('sort_order = @sortOrder'); params.sortOrder = updates.sortOrder; }

  if (!fields.length) return getHumanModelById(id);

  fields.push('updated_at = CURRENT_TIMESTAMP');
  db.prepare(`UPDATE human_models SET ${fields.join(', ')} WHERE id = @id`).run(params);
  return getHumanModelById(id);
}

function deleteHumanModel(id) {
  db.prepare('DELETE FROM human_models WHERE id = ?').run(id);
}

function getHumanModelById(id) {
  const row = db.prepare('SELECT * FROM human_models WHERE id = ?').get(id);
  return row ? mapHumanModel(row) : null;
}

function listHumanModels({ activeOnly = true, status, category, gender, search, limit = 100, offset = 0 } = {}) {
  let query = 'SELECT * FROM human_models WHERE 1=1';
  const params = [];
  if (activeOnly) { query += ' AND active = 1'; }
  if (status) { query += ' AND status = ?'; params.push(status); }
  if (category) { query += ' AND category = ?'; params.push(category); }
  if (gender) { query += ' AND gender = ?'; params.push(gender); }
  if (search) { query += ' AND (title LIKE ? OR tags LIKE ? OR description LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  query += ' ORDER BY sort_order ASC, created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return db.prepare(query).all(...params).map(mapHumanModel);
}

function listHumanModelCategories() {
  return db.prepare("SELECT DISTINCT category FROM human_models WHERE category IS NOT NULL AND category != '' ORDER BY category").all().map(r => r.category);
}

function mapHumanModel(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    tags: row.tags,
    category: row.category,
    gender: row.gender,
    ethnicity: row.ethnicity,
    apparelType: row.apparel_type,
    facing: row.facing,
    poseType: row.pose_type,
    seoFilename: row.seo_filename,
    filePath: row.file_path,
    optimizedPath: row.optimized_path,
    thumbnailPath: row.thumbnail_path,
    maskPath: row.mask_path,  // Clothing mask for color tinting
    status: row.status,
    active: Boolean(row.active),
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// --- HUMAN MODEL COLOR VARIANTS (AI-recolored models) ---
function saveRecoloredModel({ modelId, color, garmentType, filePath, webPath, cacheKey }) {
  const id = `hmcv_${crypto.randomBytes(8).toString('hex')}`;
  // Use INSERT OR REPLACE to update if cache_key already exists
  db.prepare(`
    INSERT OR REPLACE INTO human_model_color_variants (id, model_id, color, garment_type, file_path, web_path, cache_key, created_at)
    VALUES (@id, @modelId, @color, @garmentType, @filePath, @webPath, @cacheKey, CURRENT_TIMESTAMP)
  `).run({
    id,
    modelId,
    color,
    garmentType: garmentType || 't-shirt',
    filePath,
    webPath,
    cacheKey
  });
  return getRecoloredModelByCacheKey(cacheKey);
}

function getRecoloredModel(modelId, color, garmentType = 't-shirt') {
  // Normalize garment type - handle both "t-shirt" and "tshirt" variants
  const normalizedType = garmentType.toLowerCase().replace(/-/g, '');
  const row = db.prepare(`
    SELECT * FROM human_model_color_variants
    WHERE model_id = ? AND LOWER(color) = LOWER(?)
    AND LOWER(REPLACE(garment_type, '-', '')) = ?
  `).get(modelId, color, normalizedType);
  return row ? mapRecoloredModel(row) : null;
}

function getRecoloredModelByCacheKey(cacheKey) {
  const row = db.prepare('SELECT * FROM human_model_color_variants WHERE cache_key = ?').get(cacheKey);
  return row ? mapRecoloredModel(row) : null;
}

function listRecoloredModelsByModel(modelId) {
  return db.prepare('SELECT * FROM human_model_color_variants WHERE model_id = ? ORDER BY created_at DESC')
    .all(modelId)
    .map(mapRecoloredModel);
}

function listRecoloredModelsByColor(color) {
  return db.prepare('SELECT * FROM human_model_color_variants WHERE LOWER(color) = LOWER(?) ORDER BY created_at DESC')
    .all(color)
    .map(mapRecoloredModel);
}

function deleteRecoloredModel(id) {
  db.prepare('DELETE FROM human_model_color_variants WHERE id = ?').run(id);
}

function deleteRecoloredModelsByModel(modelId) {
  db.prepare('DELETE FROM human_model_color_variants WHERE model_id = ?').run(modelId);
}

function mapRecoloredModel(row) {
  return {
    id: row.id,
    modelId: row.model_id,
    color: row.color,
    garmentType: row.garment_type,
    filePath: row.file_path,
    webPath: row.web_path,
    cacheKey: row.cache_key,
    createdAt: row.created_at
  };
}

// --- MATERIALS CRUD ---
function createCustomArtMaterial({ name, description, filterType, baseCostCents }) {
  const id = `mat_${crypto.randomBytes(8).toString('hex')}`;
  db.prepare(`
    INSERT INTO custom_art_materials (id, name, description, filter_type, base_cost_cents)
    VALUES (@id, @name, @description, @filterType, @baseCostCents)
  `).run({ id, name, description: description || null, filterType: filterType || 'none', baseCostCents: baseCostCents || 0 });
  return getCustomArtMaterialById(id);
}

function updateCustomArtMaterial(id, updates) {
  const fields = [];
  const params = { id };

  if (updates.name !== undefined) { fields.push('name = @name'); params.name = updates.name; }
  if (updates.description !== undefined) { fields.push('description = @description'); params.description = updates.description; }
  if (updates.filterType !== undefined) { fields.push('filter_type = @filterType'); params.filterType = updates.filterType; }
  if (updates.baseCostCents !== undefined) { fields.push('base_cost_cents = @baseCostCents'); params.baseCostCents = updates.baseCostCents; }
  if (updates.active !== undefined) { fields.push('active = @active'); params.active = updates.active ? 1 : 0; }
  if (updates.sortOrder !== undefined) { fields.push('sort_order = @sortOrder'); params.sortOrder = updates.sortOrder; }

  if (!fields.length) return getCustomArtMaterialById(id);

  fields.push('updated_at = CURRENT_TIMESTAMP');
  db.prepare(`UPDATE custom_art_materials SET ${fields.join(', ')} WHERE id = @id`).run(params);
  return getCustomArtMaterialById(id);
}

function deleteCustomArtMaterial(id) {
  db.prepare('DELETE FROM custom_art_materials WHERE id = ?').run(id);
}

function getCustomArtMaterialById(id) {
  const row = db.prepare('SELECT * FROM custom_art_materials WHERE id = ?').get(id);
  return row ? mapCustomArtMaterial(row) : null;
}

function listCustomArtMaterials({ activeOnly = true } = {}) {
  let query = 'SELECT * FROM custom_art_materials';
  if (activeOnly) { query += ' WHERE active = 1'; }
  query += ' ORDER BY sort_order ASC, name ASC';
  return db.prepare(query).all().map(mapCustomArtMaterial);
}

function mapCustomArtMaterial(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    filterType: row.filter_type,
    baseCostCents: row.base_cost_cents,
    active: Boolean(row.active),
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// --- PRODUCTS CRUD ---
function createCustomArtProduct({ artworkId, title, description, hasVariants, basePriceCents, costCents, materialId, singleSizeWidth, singleSizeHeight, sizeUnit, mockupPath, mockupRoomId, status }) {
  const id = `prod_${crypto.randomBytes(8).toString('hex')}`;
  db.prepare(`
    INSERT INTO custom_art_products (id, artwork_id, title, description, has_variants, base_price_cents, cost_cents, material_id, single_size_width, single_size_height, size_unit, mockup_path, mockup_room_id, status)
    VALUES (@id, @artworkId, @title, @description, @hasVariants, @basePriceCents, @costCents, @materialId, @singleSizeWidth, @singleSizeHeight, @sizeUnit, @mockupPath, @mockupRoomId, @status)
  `).run({
    id,
    artworkId: artworkId || null,
    title,
    description: description || null,
    hasVariants: hasVariants ? 1 : 0,
    basePriceCents: basePriceCents || 0,
    costCents: costCents || 0,
    materialId: materialId || null,
    singleSizeWidth: singleSizeWidth || null,
    singleSizeHeight: singleSizeHeight || null,
    sizeUnit: sizeUnit || 'inches',
    mockupPath: mockupPath || null,
    mockupRoomId: mockupRoomId || null,
    status: status || 'draft'
  });
  return getCustomArtProductById(id);
}

function updateCustomArtProduct(id, updates) {
  const fields = [];
  const params = { id };

  if (updates.artworkId !== undefined) { fields.push('artwork_id = @artworkId'); params.artworkId = updates.artworkId; }
  if (updates.title !== undefined) { fields.push('title = @title'); params.title = updates.title; }
  if (updates.description !== undefined) { fields.push('description = @description'); params.description = updates.description; }
  if (updates.hasVariants !== undefined) { fields.push('has_variants = @hasVariants'); params.hasVariants = updates.hasVariants ? 1 : 0; }
  if (updates.basePriceCents !== undefined) { fields.push('base_price_cents = @basePriceCents'); params.basePriceCents = updates.basePriceCents; }
  if (updates.costCents !== undefined) { fields.push('cost_cents = @costCents'); params.costCents = updates.costCents; }
  if (updates.materialId !== undefined) { fields.push('material_id = @materialId'); params.materialId = updates.materialId; }
  if (updates.singleSizeWidth !== undefined) { fields.push('single_size_width = @singleSizeWidth'); params.singleSizeWidth = updates.singleSizeWidth; }
  if (updates.singleSizeHeight !== undefined) { fields.push('single_size_height = @singleSizeHeight'); params.singleSizeHeight = updates.singleSizeHeight; }
  if (updates.sizeUnit !== undefined) { fields.push('size_unit = @sizeUnit'); params.sizeUnit = updates.sizeUnit; }
  if (updates.mockupPath !== undefined) { fields.push('mockup_path = @mockupPath'); params.mockupPath = updates.mockupPath; }
  if (updates.mockupRoomId !== undefined) { fields.push('mockup_room_id = @mockupRoomId'); params.mockupRoomId = updates.mockupRoomId; }
  if (updates.shopifyProductId !== undefined) { fields.push('shopify_product_id = @shopifyProductId'); params.shopifyProductId = updates.shopifyProductId; }
  if (updates.shopifyHandle !== undefined) { fields.push('shopify_handle = @shopifyHandle'); params.shopifyHandle = updates.shopifyHandle; }
  if (updates.status !== undefined) { fields.push('status = @status'); params.status = updates.status; }
  if (updates.active !== undefined) { fields.push('active = @active'); params.active = updates.active ? 1 : 0; }

  if (!fields.length) return getCustomArtProductById(id);

  fields.push('updated_at = CURRENT_TIMESTAMP');
  db.prepare(`UPDATE custom_art_products SET ${fields.join(', ')} WHERE id = @id`).run(params);
  return getCustomArtProductById(id);
}

function deleteCustomArtProduct(id) {
  db.prepare('DELETE FROM custom_art_products WHERE id = ?').run(id);
}

function getCustomArtProductById(id) {
  const row = db.prepare(`
    SELECT p.*,
           a.title AS artwork_title, a.file_path AS artwork_file_path, a.optimized_path AS artwork_optimized_path,
           m.name AS material_name, m.filter_type AS material_filter_type,
           r.title AS room_title, r.image_path AS room_image_path
    FROM custom_art_products p
    LEFT JOIN custom_art_artwork a ON a.id = p.artwork_id
    LEFT JOIN custom_art_materials m ON m.id = p.material_id
    LEFT JOIN custom_art_rooms r ON r.id = p.mockup_room_id
    WHERE p.id = ?
  `).get(id);
  if (!row) return null;
  const product = mapCustomArtProduct(row);
  product.variants = listCustomArtProductVariants(id);
  return product;
}

function getCustomArtProductByShopifyId(shopifyProductId) {
  if (!shopifyProductId) return null;
  const row = db.prepare(`
    SELECT p.*,
           a.title AS artwork_title, a.file_path AS artwork_file_path, a.optimized_path AS artwork_optimized_path,
           m.name AS material_name, m.filter_type AS material_filter_type,
           r.title AS room_title, r.image_path AS room_image_path
    FROM custom_art_products p
    LEFT JOIN custom_art_artwork a ON a.id = p.artwork_id
    LEFT JOIN custom_art_materials m ON m.id = p.material_id
    LEFT JOIN custom_art_rooms r ON r.id = p.mockup_room_id
    WHERE p.shopify_product_id = ?
  `).get(String(shopifyProductId));
  if (!row) return null;
  return mapCustomArtProduct(row);
}

function getMockupsForShopifyProducts(shopifyProductIds) {
  if (!shopifyProductIds || !shopifyProductIds.length) return {};
  // For each Shopify product ID, find the local product and its mockups
  const result = {};
  for (const shopifyId of shopifyProductIds) {
    const product = getCustomArtProductByShopifyId(shopifyId);
    if (product) {
      // Get mockups linked to this product
      const mockups = db.prepare(`
        SELECT * FROM custom_art_mockups
        WHERE product_id = ? AND active = 1
        ORDER BY created_at DESC
      `).all(product.id).map(mapCustomArtMockup);

      // Also include the product's mockup_path if set
      result[shopifyId] = {
        productId: product.id,
        mockupPath: product.mockupPath,
        mockups: mockups
      };
    }
  }
  return result;
}

function listCustomArtProducts({ activeOnly = true, status, artworkId, limit = 100, offset = 0 } = {}) {
  let query = `
    SELECT p.*,
           a.title AS artwork_title, a.file_path AS artwork_file_path, a.optimized_path AS artwork_optimized_path,
           m.name AS material_name, m.filter_type AS material_filter_type,
           r.title AS room_title, r.image_path AS room_image_path
    FROM custom_art_products p
    LEFT JOIN custom_art_artwork a ON a.id = p.artwork_id
    LEFT JOIN custom_art_materials m ON m.id = p.material_id
    LEFT JOIN custom_art_rooms r ON r.id = p.mockup_room_id
    WHERE 1=1
  `;
  const params = [];
  if (activeOnly) { query += ' AND p.active = 1'; }
  if (status) { query += ' AND p.status = ?'; params.push(status); }
  if (artworkId) { query += ' AND p.artwork_id = ?'; params.push(artworkId); }
  query += ' ORDER BY p.created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return db.prepare(query).all(...params).map(mapCustomArtProduct);
}

function mapCustomArtProduct(row) {
  return {
    id: row.id,
    artworkId: row.artwork_id,
    title: row.title,
    description: row.description,
    hasVariants: Boolean(row.has_variants),
    basePriceCents: row.base_price_cents,
    costCents: row.cost_cents,
    materialId: row.material_id,
    singleSize: {
      width: row.single_size_width,
      height: row.single_size_height,
      unit: row.size_unit
    },
    mockupPath: row.mockup_path,
    mockupRoomId: row.mockup_room_id,
    shopifyProductId: row.shopify_product_id,
    shopifyHandle: row.shopify_handle,
    status: row.status,
    active: Boolean(row.active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Joined data
    artwork: row.artwork_title ? {
      title: row.artwork_title,
      filePath: row.artwork_file_path,
      optimizedPath: row.artwork_optimized_path
    } : null,
    material: row.material_name ? {
      name: row.material_name,
      filterType: row.material_filter_type
    } : null,
    room: row.room_title ? {
      title: row.room_title,
      imagePath: row.room_image_path
    } : null
  };
}

// --- PRODUCT VARIANTS CRUD ---
function createCustomArtProductVariant({ productId, materialId, sizeWidth, sizeHeight, sizeUnit, priceCents, costCents, sku }) {
  const id = `var_${crypto.randomBytes(8).toString('hex')}`;
  db.prepare(`
    INSERT INTO custom_art_product_variants (id, product_id, material_id, size_width, size_height, size_unit, price_cents, cost_cents, sku)
    VALUES (@id, @productId, @materialId, @sizeWidth, @sizeHeight, @sizeUnit, @priceCents, @costCents, @sku)
  `).run({
    id,
    productId,
    materialId: materialId || null,
    sizeWidth,
    sizeHeight,
    sizeUnit: sizeUnit || 'inches',
    priceCents: priceCents || 0,
    costCents: costCents || 0,
    sku: sku || null
  });
  return getCustomArtProductVariantById(id);
}

function updateCustomArtProductVariant(id, updates) {
  const fields = [];
  const params = { id };

  if (updates.materialId !== undefined) { fields.push('material_id = @materialId'); params.materialId = updates.materialId; }
  if (updates.sizeWidth !== undefined) { fields.push('size_width = @sizeWidth'); params.sizeWidth = updates.sizeWidth; }
  if (updates.sizeHeight !== undefined) { fields.push('size_height = @sizeHeight'); params.sizeHeight = updates.sizeHeight; }
  if (updates.sizeUnit !== undefined) { fields.push('size_unit = @sizeUnit'); params.sizeUnit = updates.sizeUnit; }
  if (updates.priceCents !== undefined) { fields.push('price_cents = @priceCents'); params.priceCents = updates.priceCents; }
  if (updates.costCents !== undefined) { fields.push('cost_cents = @costCents'); params.costCents = updates.costCents; }
  if (updates.sku !== undefined) { fields.push('sku = @sku'); params.sku = updates.sku; }
  if (updates.shopifyVariantId !== undefined) { fields.push('shopify_variant_id = @shopifyVariantId'); params.shopifyVariantId = updates.shopifyVariantId; }
  if (updates.active !== undefined) { fields.push('active = @active'); params.active = updates.active ? 1 : 0; }
  if (updates.sortOrder !== undefined) { fields.push('sort_order = @sortOrder'); params.sortOrder = updates.sortOrder; }

  if (!fields.length) return getCustomArtProductVariantById(id);

  fields.push('updated_at = CURRENT_TIMESTAMP');
  db.prepare(`UPDATE custom_art_product_variants SET ${fields.join(', ')} WHERE id = @id`).run(params);
  return getCustomArtProductVariantById(id);
}

function deleteCustomArtProductVariant(id) {
  db.prepare('DELETE FROM custom_art_product_variants WHERE id = ?').run(id);
}

function deleteCustomArtProductVariantsByProductId(productId) {
  db.prepare('DELETE FROM custom_art_product_variants WHERE product_id = ?').run(productId);
}

function getCustomArtProductVariantById(id) {
  const row = db.prepare(`
    SELECT v.*, m.name AS material_name, m.filter_type AS material_filter_type
    FROM custom_art_product_variants v
    LEFT JOIN custom_art_materials m ON m.id = v.material_id
    WHERE v.id = ?
  `).get(id);
  return row ? mapCustomArtProductVariant(row) : null;
}

function listCustomArtProductVariants(productId, { activeOnly = true } = {}) {
  let query = `
    SELECT v.*, m.name AS material_name, m.filter_type AS material_filter_type
    FROM custom_art_product_variants v
    LEFT JOIN custom_art_materials m ON m.id = v.material_id
    WHERE v.product_id = ?
  `;
  if (activeOnly) { query += ' AND v.active = 1'; }
  query += ' ORDER BY v.sort_order ASC, v.created_at ASC';
  return db.prepare(query).all(productId).map(mapCustomArtProductVariant);
}

function mapCustomArtProductVariant(row) {
  return {
    id: row.id,
    productId: row.product_id,
    materialId: row.material_id,
    size: {
      width: row.size_width,
      height: row.size_height,
      unit: row.size_unit
    },
    priceCents: row.price_cents,
    costCents: row.cost_cents,
    sku: row.sku,
    shopifyVariantId: row.shopify_variant_id,
    active: Boolean(row.active),
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    material: row.material_name ? {
      name: row.material_name,
      filterType: row.material_filter_type
    } : null
  };
}

// ============================================================================
// Custom Art Tiles (Split Panel Products)
// ============================================================================

function createCustomArtTile({ productId, artworkId, row, col, filename, filePath, url, widthInches, heightInches }) {
  const id = `tile_${crypto.randomBytes(8).toString('hex')}`;
  db.prepare(`
    INSERT INTO custom_art_tiles (id, product_id, artwork_id, row_num, col_num, filename, file_path, url, width_inches, height_inches)
    VALUES (@id, @productId, @artworkId, @row, @col, @filename, @filePath, @url, @widthInches, @heightInches)
  `).run({ id, productId, artworkId: artworkId || null, row, col, filename, filePath, url: url || null, widthInches: widthInches || null, heightInches: heightInches || null });
  return getCustomArtTileById(id);
}

function getCustomArtTileById(id) {
  const row = db.prepare('SELECT * FROM custom_art_tiles WHERE id = ?').get(id);
  return row ? mapCustomArtTile(row) : null;
}

function listCustomArtTilesByProduct(productId) {
  const rows = db.prepare('SELECT * FROM custom_art_tiles WHERE product_id = ? ORDER BY row_num ASC, col_num ASC').all(productId);
  return rows.map(mapCustomArtTile);
}

function listCustomArtTilesByArtwork(artworkId) {
  const rows = db.prepare('SELECT * FROM custom_art_tiles WHERE artwork_id = ? ORDER BY row_num ASC, col_num ASC').all(artworkId);
  return rows.map(mapCustomArtTile);
}

function deleteCustomArtTilesByProduct(productId) {
  db.prepare('DELETE FROM custom_art_tiles WHERE product_id = ?').run(productId);
}

function mapCustomArtTile(row) {
  return {
    id: row.id,
    productId: row.product_id,
    artworkId: row.artwork_id,
    row: row.row_num,
    col: row.col_num,
    filename: row.filename,
    filePath: row.file_path,
    url: row.url,
    widthInches: row.width_inches,
    heightInches: row.height_inches,
    createdAt: row.created_at
  };
}

// ============================================================================
// Custom Art Mockups (Standalone mockup image management)
// ============================================================================

function createCustomArtMockup({ title, filename, filePath, url, productId, artworkId, roomId, campaignSlug, materialId, mockupType, width, height, fileSize, tags, notes }) {
  const id = `mockup_${crypto.randomBytes(8).toString('hex')}`;
  db.prepare(`
    INSERT INTO custom_art_mockups (id, title, filename, file_path, url, product_id, artwork_id, room_id, campaign_slug, material_id, mockup_type, width, height, file_size, tags, notes)
    VALUES (@id, @title, @filename, @filePath, @url, @productId, @artworkId, @roomId, @campaignSlug, @materialId, @mockupType, @width, @height, @fileSize, @tags, @notes)
  `).run({
    id,
    title: title || null,
    filename,
    filePath,
    url: url || null,
    productId: productId || null,
    artworkId: artworkId || null,
    roomId: roomId || null,
    campaignSlug: campaignSlug || null,
    materialId: materialId || null,
    mockupType: mockupType || 'product',
    width: width || null,
    height: height || null,
    fileSize: fileSize || null,
    tags: tags || null,
    notes: notes || null
  });
  return id;
}

function getCustomArtMockupById(id) {
  const row = db.prepare(`
    SELECT m.*,
           p.title AS product_title,
           a.title AS artwork_title, a.thumbnail_path AS artwork_thumbnail,
           r.title AS room_title, r.thumbnail_path AS room_thumbnail
    FROM custom_art_mockups m
    LEFT JOIN custom_art_products p ON p.id = m.product_id
    LEFT JOIN custom_art_artwork a ON a.id = m.artwork_id
    LEFT JOIN custom_art_rooms r ON r.id = m.room_id
    WHERE m.id = ?
  `).get(id);
  return row ? mapCustomArtMockup(row) : null;
}

function listCustomArtMockups({ activeOnly = true, productId, artworkId, roomId, campaignSlug, mockupType, limit = 100, offset = 0 } = {}) {
  let query = `
    SELECT m.*,
           p.title AS product_title,
           a.title AS artwork_title, a.thumbnail_path AS artwork_thumbnail,
           r.title AS room_title, r.thumbnail_path AS room_thumbnail
    FROM custom_art_mockups m
    LEFT JOIN custom_art_products p ON p.id = m.product_id
    LEFT JOIN custom_art_artwork a ON a.id = m.artwork_id
    LEFT JOIN custom_art_rooms r ON r.id = m.room_id
    WHERE 1=1
  `;
  const params = [];
  if (activeOnly) { query += ' AND m.active = 1'; }
  if (productId) { query += ' AND m.product_id = ?'; params.push(productId); }
  if (artworkId) { query += ' AND m.artwork_id = ?'; params.push(artworkId); }
  if (roomId) { query += ' AND m.room_id = ?'; params.push(roomId); }
  if (campaignSlug) { query += ' AND m.campaign_slug = ?'; params.push(campaignSlug); }
  if (mockupType) { query += ' AND m.mockup_type = ?'; params.push(mockupType); }
  query += ' ORDER BY m.created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return db.prepare(query).all(...params).map(mapCustomArtMockup);
}

function updateCustomArtMockup(id, updates) {
  const fields = [];
  const params = { id };

  if (updates.title !== undefined) { fields.push('title = @title'); params.title = updates.title; }
  if (updates.productId !== undefined) { fields.push('product_id = @productId'); params.productId = updates.productId; }
  if (updates.artworkId !== undefined) { fields.push('artwork_id = @artworkId'); params.artworkId = updates.artworkId; }
  if (updates.roomId !== undefined) { fields.push('room_id = @roomId'); params.roomId = updates.roomId; }
  if (updates.tags !== undefined) { fields.push('tags = @tags'); params.tags = updates.tags; }
  if (updates.notes !== undefined) { fields.push('notes = @notes'); params.notes = updates.notes; }
  if (updates.active !== undefined) { fields.push('active = @active'); params.active = updates.active ? 1 : 0; }

  if (!fields.length) return getCustomArtMockupById(id);

  fields.push('updated_at = CURRENT_TIMESTAMP');
  db.prepare(`UPDATE custom_art_mockups SET ${fields.join(', ')} WHERE id = @id`).run(params);
  return getCustomArtMockupById(id);
}

function deleteCustomArtMockup(id) {
  // Get the mockup to find the file path for cleanup
  const mockup = getCustomArtMockupById(id);
  db.prepare('DELETE FROM custom_art_mockups WHERE id = ?').run(id);
  return mockup; // Return so caller can delete the file
}

function mapCustomArtMockup(row) {
  return {
    id: row.id,
    title: row.title,
    filename: row.filename,
    filePath: row.file_path,
    url: row.url,
    productId: row.product_id,
    artworkId: row.artwork_id,
    roomId: row.room_id,
    campaignSlug: row.campaign_slug,
    materialId: row.material_id,
    mockupType: row.mockup_type || 'product',
    width: row.width,
    height: row.height,
    fileSize: row.file_size,
    tags: row.tags,
    notes: row.notes,
    active: Boolean(row.active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    product: row.product_title ? { title: row.product_title } : null,
    artwork: row.artwork_title ? { title: row.artwork_title, thumbnail: row.artwork_thumbnail } : null,
    room: row.room_title ? { title: row.room_title, thumbnail: row.room_thumbnail } : null
  };
}

// ============================================================================
// Car Templates for Race Decal Designer
// ============================================================================

function formatCarTemplate(row) {
  if (!row) return null;
  return {
    id: row.id,
    make: row.make,
    model: row.model,
    yearStart: row.year_start,
    yearEnd: row.year_end,
    bodyStyle: row.body_style,
    dimensions: {
      overallLength: row.overall_length,
      overallWidth: row.overall_width,
      overallHeight: row.overall_height,
      wheelbase: row.wheelbase
    },
    templates: {
      side: row.template_side,
      front: row.template_front,
      rear: row.template_rear
    },
    scale: row.scale,
    isGenerated: Boolean(row.is_generated),
    verified: Boolean(row.verified),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function listCarTemplates({ make, verified } = {}) {
  let sql = 'SELECT * FROM car_templates WHERE 1=1';
  const params = {};
  if (make) {
    sql += ' AND make = @make';
    params.make = make;
  }
  if (verified !== undefined) {
    sql += ' AND verified = @verified';
    params.verified = verified ? 1 : 0;
  }
  sql += ' ORDER BY make, model, year_start';
  return db.prepare(sql).all(params).map(formatCarTemplate);
}

function getCarTemplateById(id) {
  const row = db.prepare('SELECT * FROM car_templates WHERE id = ?').get(id);
  return formatCarTemplate(row);
}

function findCarTemplate(make, model, year) {
  const row = db.prepare(`
    SELECT * FROM car_templates
    WHERE LOWER(make) = LOWER(?)
      AND LOWER(model) = LOWER(?)
      AND year_start <= ?
      AND year_end >= ?
    ORDER BY verified DESC, is_generated ASC
    LIMIT 1
  `).get(make, model, year, year);
  return formatCarTemplate(row);
}

function getDistinctCarMakes() {
  return db.prepare('SELECT DISTINCT make FROM car_templates ORDER BY make')
    .all()
    .map(r => r.make);
}

function getCarModelsByMake(make) {
  return db.prepare(`
    SELECT DISTINCT model, MIN(year_start) as minYear, MAX(year_end) as maxYear
    FROM car_templates
    WHERE LOWER(make) = LOWER(?)
    GROUP BY model
    ORDER BY model
  `).all(make);
}

function createCarTemplate({
  make,
  model,
  yearStart,
  yearEnd,
  bodyStyle = null,
  overallLength = null,
  overallWidth = null,
  overallHeight = null,
  wheelbase = null,
  templateSide = null,
  templateFront = null,
  templateRear = null,
  scale = 0.1,
  isGenerated = false,
  verified = false
}) {
  const id = `car-${crypto.randomUUID()}`;
  db.prepare(`
    INSERT INTO car_templates (
      id, make, model, year_start, year_end, body_style,
      overall_length, overall_width, overall_height, wheelbase,
      template_side, template_front, template_rear,
      scale, is_generated, verified
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, make, model, yearStart, yearEnd, bodyStyle,
    overallLength, overallWidth, overallHeight, wheelbase,
    templateSide, templateFront, templateRear,
    scale, isGenerated ? 1 : 0, verified ? 1 : 0
  );
  return getCarTemplateById(id);
}

function updateCarTemplate(id, updates = {}) {
  const fields = [];
  const params = { id };

  const textFields = ['make', 'model', 'bodyStyle', 'templateSide', 'templateFront', 'templateRear'];
  const numericFields = ['yearStart', 'yearEnd', 'overallLength', 'overallWidth', 'overallHeight', 'wheelbase', 'scale'];
  const boolFields = ['isGenerated', 'verified'];

  textFields.forEach(key => {
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      const col = key.replace(/([A-Z])/g, '_$1').toLowerCase();
      fields.push(`${col} = @${key}`);
      params[key] = updates[key];
    }
  });

  numericFields.forEach(key => {
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      const col = key.replace(/([A-Z])/g, '_$1').toLowerCase();
      fields.push(`${col} = @${key}`);
      params[key] = updates[key];
    }
  });

  boolFields.forEach(key => {
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      const col = key.replace(/([A-Z])/g, '_$1').toLowerCase();
      fields.push(`${col} = @${key}`);
      params[key] = updates[key] ? 1 : 0;
    }
  });

  if (!fields.length) return getCarTemplateById(id);

  fields.push('updated_at = CURRENT_TIMESTAMP');
  db.prepare(`UPDATE car_templates SET ${fields.join(', ')} WHERE id = @id`).run(params);
  return getCarTemplateById(id);
}

function deleteCarTemplate(id) {
  db.prepare('DELETE FROM car_templates WHERE id = ?').run(id);
}

// ============================================================================
// Race Designs (Customer Decal Layouts)
// ============================================================================

function formatRaceDesign(row) {
  if (!row) return null;
  return {
    id: row.id,
    customerId: row.customer_id,
    carTemplateId: row.car_template_id,
    driverInfo: row.driver_info ? JSON.parse(row.driver_info) : null,
    referencePhotos: row.reference_photos ? JSON.parse(row.reference_photos) : [],
    decals: row.decals ? JSON.parse(row.decals) : [],
    designPreview: row.design_preview,
    productionSpec: row.production_spec ? JSON.parse(row.production_spec) : null,
    quoteId: row.quote_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Joined fields
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    carMake: row.car_make,
    carModel: row.car_model
  };
}

function createRaceDesign({ customerId, carTemplateId = null, driverInfo = null }) {
  const id = `design-${crypto.randomUUID()}`;
  db.prepare(`
    INSERT INTO race_designs (id, customer_id, car_template_id, driver_info)
    VALUES (?, ?, ?, ?)
  `).run(id, customerId, carTemplateId, driverInfo ? JSON.stringify(driverInfo) : null);
  return getRaceDesignById(id);
}

function getRaceDesignById(id) {
  const row = db.prepare(`
    SELECT rd.*,
           c.name as customer_name, c.email as customer_email,
           ct.make as car_make, ct.model as car_model
    FROM race_designs rd
    LEFT JOIN customers c ON c.id = rd.customer_id
    LEFT JOIN car_templates ct ON ct.id = rd.car_template_id
    WHERE rd.id = ?
  `).get(id);
  return formatRaceDesign(row);
}

function listRaceDesignsByCustomer(customerId) {
  const rows = db.prepare(`
    SELECT rd.*,
           c.name as customer_name, c.email as customer_email,
           ct.make as car_make, ct.model as car_model
    FROM race_designs rd
    LEFT JOIN customers c ON c.id = rd.customer_id
    LEFT JOIN car_templates ct ON ct.id = rd.car_template_id
    WHERE rd.customer_id = ?
    ORDER BY rd.updated_at DESC
  `).all(customerId);
  return rows.map(formatRaceDesign);
}

function updateRaceDesign(id, updates = {}) {
  const fields = [];
  const params = { id };

  if (Object.prototype.hasOwnProperty.call(updates, 'carTemplateId')) {
    fields.push('car_template_id = @carTemplateId');
    params.carTemplateId = updates.carTemplateId;
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'driverInfo')) {
    fields.push('driver_info = @driverInfo');
    params.driverInfo = JSON.stringify(updates.driverInfo);
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'referencePhotos')) {
    fields.push('reference_photos = @referencePhotos');
    params.referencePhotos = JSON.stringify(updates.referencePhotos);
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'decals')) {
    fields.push('decals = @decals');
    params.decals = JSON.stringify(updates.decals);
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'designPreview')) {
    fields.push('design_preview = @designPreview');
    params.designPreview = updates.designPreview;
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'productionSpec')) {
    fields.push('production_spec = @productionSpec');
    params.productionSpec = JSON.stringify(updates.productionSpec);
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'quoteId')) {
    fields.push('quote_id = @quoteId');
    params.quoteId = updates.quoteId;
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'status')) {
    fields.push('status = @status');
    params.status = updates.status;
  }

  if (!fields.length) return getRaceDesignById(id);

  fields.push('updated_at = CURRENT_TIMESTAMP');
  db.prepare(`UPDATE race_designs SET ${fields.join(', ')} WHERE id = @id`).run(params);
  return getRaceDesignById(id);
}

function deleteRaceDesign(id) {
  db.prepare('DELETE FROM race_designs WHERE id = ?').run(id);
}

function listAllRaceDesigns({ status, limit = 100, offset = 0 } = {}) {
  let sql = `
    SELECT rd.*,
           c.name as customer_name, c.email as customer_email,
           ct.make as car_make, ct.model as car_model
    FROM race_designs rd
    LEFT JOIN customers c ON c.id = rd.customer_id
    LEFT JOIN car_templates ct ON ct.id = rd.car_template_id
    WHERE 1=1
  `;
  const params = { limit, offset };
  if (status) {
    sql += ' AND rd.status = @status';
    params.status = status;
  }
  sql += ' ORDER BY rd.updated_at DESC LIMIT @limit OFFSET @offset';
  return db.prepare(sql).all(params).map(formatRaceDesign);
}

// ============================================================================
// MOCKUP TEMPLATES & SCHEDULED FACEBOOK POSTS
// ============================================================================

function formatMockupTemplate(row) {
  if (!row) return null;
  return {
    id: row.id,
    campaignSlug: row.campaign_slug,
    name: row.name,
    mockupImagePath: row.mockup_image_path,
    artworkPosition: row.artwork_position_json ? JSON.parse(row.artwork_position_json) : null,
    blendMode: row.blend_mode,
    outputFormat: row.output_format,
    outputQuality: row.output_quality,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function createMockupTemplate({ campaignSlug, name, mockupImagePath, artworkPosition, blendMode, outputFormat, outputQuality }) {
  const id = `mockup-tpl-${crypto.randomUUID()}`;
  db.prepare(`
    INSERT INTO mockup_templates (id, campaign_slug, name, mockup_image_path, artwork_position_json, blend_mode, output_format, output_quality)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    campaignSlug,
    name || 'Default Template',
    mockupImagePath,
    JSON.stringify(artworkPosition),
    blendMode || 'normal',
    outputFormat || 'jpeg',
    outputQuality || 90
  );
  return getMockupTemplateById(id);
}

function getMockupTemplateById(id) {
  const row = db.prepare('SELECT * FROM mockup_templates WHERE id = ?').get(id);
  return formatMockupTemplate(row);
}

function getMockupTemplatesByCampaign(campaignSlug) {
  const rows = db.prepare('SELECT * FROM mockup_templates WHERE campaign_slug = ? AND is_active = 1 ORDER BY created_at DESC').all(campaignSlug);
  return rows.map(formatMockupTemplate);
}

function updateMockupTemplate(id, updates = {}) {
  const fields = [];
  const params = { id };

  if (updates.name !== undefined) {
    fields.push('name = @name');
    params.name = updates.name;
  }
  if (updates.mockupImagePath !== undefined) {
    fields.push('mockup_image_path = @mockupImagePath');
    params.mockupImagePath = updates.mockupImagePath;
  }
  if (updates.artworkPosition !== undefined) {
    fields.push('artwork_position_json = @artworkPositionJson');
    params.artworkPositionJson = JSON.stringify(updates.artworkPosition);
  }
  if (updates.blendMode !== undefined) {
    fields.push('blend_mode = @blendMode');
    params.blendMode = updates.blendMode;
  }
  if (updates.outputFormat !== undefined) {
    fields.push('output_format = @outputFormat');
    params.outputFormat = updates.outputFormat;
  }
  if (updates.outputQuality !== undefined) {
    fields.push('output_quality = @outputQuality');
    params.outputQuality = updates.outputQuality;
  }
  if (updates.isActive !== undefined) {
    fields.push('is_active = @isActive');
    params.isActive = updates.isActive ? 1 : 0;
  }

  if (!fields.length) return getMockupTemplateById(id);

  fields.push('updated_at = CURRENT_TIMESTAMP');
  db.prepare(`UPDATE mockup_templates SET ${fields.join(', ')} WHERE id = @id`).run(params);
  return getMockupTemplateById(id);
}

function deleteMockupTemplate(id) {
  db.prepare('DELETE FROM mockup_templates WHERE id = ?').run(id);
}

function listAllMockupTemplates() {
  const rows = db.prepare('SELECT * FROM mockup_templates WHERE is_active = 1 ORDER BY created_at DESC').all();
  return rows.map(formatMockupTemplate);
}

// Scheduled Facebook Posts

function formatScheduledPost(row) {
  if (!row) return null;
  return {
    id: row.id,
    campaignSlug: row.campaign_slug,
    productUid: row.product_uid,
    productName: row.product_name,
    campaignType: row.campaign_type,
    templateId: row.template_id,
    artworkPath: row.artwork_path,
    mockupPath: row.mockup_path,
    generatedMockupPath: row.generated_mockup_path,
    postText: row.post_text,
    postHashtags: row.post_hashtags,
    collectionUrl: row.collection_url,
    scheduledFor: row.scheduled_for,
    status: row.status,
    facebookPostId: row.facebook_post_id,
    errorMessage: row.error_message,
    retryCount: row.retry_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
    generateAiOnPost: Boolean(row.generate_ai_on_post),
    aiStyle: row.ai_style
  };
}

/**
 * Create a scheduled Facebook post
 *
 * For Custom Art campaigns: provide templateId + artworkPath
 * For Apparel campaigns: provide mockupPath directly
 */
function createScheduledPost({
  campaignSlug,
  productUid,
  productName,
  campaignType,
  templateId,
  artworkPath,
  mockupPath,
  postText,
  postHashtags,
  collectionUrl,
  scheduledFor,
  generateAiOnPost,
  aiStyle
}) {
  const id = `fb-post-${crypto.randomUUID()}`;
  db.prepare(`
    INSERT INTO scheduled_facebook_posts
    (id, campaign_slug, product_uid, product_name, campaign_type, template_id, artwork_path, mockup_path, post_text, post_hashtags, collection_url, scheduled_for, generate_ai_on_post, ai_style)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    campaignSlug,
    productUid || null,
    productName || null,
    campaignType || 'custom-art',
    templateId || null,
    artworkPath || null,
    mockupPath || null,
    postText || '',
    postHashtags || '',
    collectionUrl || null,
    scheduledFor,
    generateAiOnPost ? 1 : 0,
    aiStyle || null
  );
  return getScheduledPostById(id);
}

function getScheduledPostById(id) {
  const row = db.prepare('SELECT * FROM scheduled_facebook_posts WHERE id = ?').get(id);
  return formatScheduledPost(row);
}

function listScheduledPosts({ campaignSlug, status, fromDate, toDate, limit = 100, offset = 0 } = {}) {
  let sql = 'SELECT * FROM scheduled_facebook_posts WHERE 1=1';
  const params = { limit, offset };

  if (campaignSlug) {
    sql += ' AND campaign_slug = @campaignSlug';
    params.campaignSlug = campaignSlug;
  }
  if (status) {
    sql += ' AND status = @status';
    params.status = status;
  }
  if (fromDate) {
    sql += ' AND scheduled_for >= @fromDate';
    params.fromDate = fromDate;
  }
  if (toDate) {
    sql += ' AND scheduled_for <= @toDate';
    params.toDate = toDate;
  }

  sql += ' ORDER BY scheduled_for ASC LIMIT @limit OFFSET @offset';
  return db.prepare(sql).all(params).map(formatScheduledPost);
}

function getPendingScheduledPosts() {
  const now = new Date().toISOString();
  const rows = db.prepare(`
    SELECT * FROM scheduled_facebook_posts
    WHERE status = 'pending' AND scheduled_for <= ?
    ORDER BY scheduled_for ASC
  `).all(now);
  return rows.map(formatScheduledPost);
}

function updateScheduledPost(id, updates = {}) {
  const fields = [];
  const params = { id };

  const allowedFields = [
    'postText', 'postHashtags', 'collectionUrl', 'scheduledFor', 'status',
    'generatedMockupPath', 'facebookPostId', 'errorMessage', 'retryCount', 'publishedAt'
  ];

  const fieldMap = {
    postText: 'post_text',
    postHashtags: 'post_hashtags',
    collectionUrl: 'collection_url',
    scheduledFor: 'scheduled_for',
    status: 'status',
    generatedMockupPath: 'generated_mockup_path',
    facebookPostId: 'facebook_post_id',
    errorMessage: 'error_message',
    retryCount: 'retry_count',
    publishedAt: 'published_at'
  };

  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      const dbField = fieldMap[field];
      fields.push(`${dbField} = @${field}`);
      params[field] = updates[field];
    }
  }

  if (!fields.length) return getScheduledPostById(id);

  fields.push('updated_at = CURRENT_TIMESTAMP');
  db.prepare(`UPDATE scheduled_facebook_posts SET ${fields.join(', ')} WHERE id = @id`).run(params);
  return getScheduledPostById(id);
}

function deleteScheduledPost(id) {
  db.prepare('DELETE FROM scheduled_facebook_posts WHERE id = ?').run(id);
}

function markScheduledPostPublished(id, facebookPostId) {
  return updateScheduledPost(id, {
    status: 'published',
    facebookPostId,
    publishedAt: new Date().toISOString()
  });
}

function markScheduledPostFailed(id, errorMessage) {
  const post = getScheduledPostById(id);
  return updateScheduledPost(id, {
    status: 'failed',
    errorMessage,
    retryCount: (post?.retryCount || 0) + 1
  });
}

// Facebook Post Content (AI-generated)

function saveFacebookPostContent({ campaignSlug, style, postVariations, recommendedHashtags, audienceInsight }) {
  const id = `fb-content-${crypto.randomUUID()}`;
  db.prepare(`
    INSERT INTO facebook_post_content (id, campaign_slug, style, post_variations_json, recommended_hashtags, audience_insight)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    campaignSlug,
    style || 'showcase',
    JSON.stringify(postVariations || []),
    recommendedHashtags || '',
    audienceInsight || ''
  );
  return id;
}

function getFacebookPostContentByCampaign(campaignSlug) {
  const row = db.prepare('SELECT * FROM facebook_post_content WHERE campaign_slug = ? ORDER BY generated_at DESC LIMIT 1').get(campaignSlug);
  if (!row) return null;
  return {
    id: row.id,
    campaignSlug: row.campaign_slug,
    style: row.style,
    postVariations: row.post_variations_json ? JSON.parse(row.post_variations_json) : [],
    recommendedHashtags: row.recommended_hashtags,
    audienceInsight: row.audience_insight,
    generatedAt: row.generated_at
  };
}

// ============================================================================
// MOCKUP BACKGROUNDS - for print-station decal mockups
// ============================================================================

function createMockupBackground({
  name,
  category = 'general',
  description,
  filePath,
  thumbnailPath,
  width,
  height,
  fileSize,
  tags,
  defaultWidthPct = 40,
  defaultXOffset = 0,
  defaultYOffset = 0,
  active = true,
  sortOrder = 0
}) {
  const id = `bg_${crypto.randomBytes(8).toString('hex')}`;
  db.prepare(`
    INSERT INTO mockup_backgrounds (
      id, name, category, description, file_path, thumbnail_path,
      width, height, file_size, tags, default_width_pct,
      default_x_offset, default_y_offset, active, sort_order
    ) VALUES (
      @id, @name, @category, @description, @filePath, @thumbnailPath,
      @width, @height, @fileSize, @tags, @defaultWidthPct,
      @defaultXOffset, @defaultYOffset, @active, @sortOrder
    )
  `).run({
    id,
    name,
    category,
    description: description || null,
    filePath,
    thumbnailPath: thumbnailPath || null,
    width: width || null,
    height: height || null,
    fileSize: fileSize || null,
    tags: tags || null,
    defaultWidthPct,
    defaultXOffset,
    defaultYOffset,
    active: active ? 1 : 0,
    sortOrder
  });
  return getMockupBackgroundById(id);
}

function getMockupBackgroundById(id) {
  const row = db.prepare('SELECT * FROM mockup_backgrounds WHERE id = ?').get(id);
  return row ? mapMockupBackgroundRow(row) : null;
}

function listMockupBackgrounds(options = {}) {
  const { category, activeOnly = true, limit = 100, offset = 0 } = options;
  let sql = 'SELECT * FROM mockup_backgrounds WHERE 1=1';
  const params = {};

  if (activeOnly) {
    sql += ' AND active = 1';
  }
  if (category) {
    sql += ' AND category = @category';
    params.category = category;
  }

  sql += ' ORDER BY sort_order ASC, name ASC LIMIT @limit OFFSET @offset';
  params.limit = limit;
  params.offset = offset;

  const rows = db.prepare(sql).all(params);
  return rows.map(mapMockupBackgroundRow);
}

function listMockupBackgroundCategories() {
  const rows = db.prepare(`
    SELECT DISTINCT category FROM mockup_backgrounds
    WHERE active = 1 AND category IS NOT NULL
    ORDER BY category ASC
  `).all();
  return rows.map(r => r.category);
}

function updateMockupBackground(id, updates) {
  const fields = [];
  const params = { id };

  if (updates.name !== undefined) { fields.push('name = @name'); params.name = updates.name; }
  if (updates.category !== undefined) { fields.push('category = @category'); params.category = updates.category; }
  if (updates.description !== undefined) { fields.push('description = @description'); params.description = updates.description; }
  if (updates.filePath !== undefined) { fields.push('file_path = @filePath'); params.filePath = updates.filePath; }
  if (updates.thumbnailPath !== undefined) { fields.push('thumbnail_path = @thumbnailPath'); params.thumbnailPath = updates.thumbnailPath; }
  if (updates.width !== undefined) { fields.push('width = @width'); params.width = updates.width; }
  if (updates.height !== undefined) { fields.push('height = @height'); params.height = updates.height; }
  if (updates.fileSize !== undefined) { fields.push('file_size = @fileSize'); params.fileSize = updates.fileSize; }
  if (updates.tags !== undefined) { fields.push('tags = @tags'); params.tags = updates.tags; }
  if (updates.defaultWidthPct !== undefined) { fields.push('default_width_pct = @defaultWidthPct'); params.defaultWidthPct = updates.defaultWidthPct; }
  if (updates.defaultXOffset !== undefined) { fields.push('default_x_offset = @defaultXOffset'); params.defaultXOffset = updates.defaultXOffset; }
  if (updates.defaultYOffset !== undefined) { fields.push('default_y_offset = @defaultYOffset'); params.defaultYOffset = updates.defaultYOffset; }
  if (updates.active !== undefined) { fields.push('active = @active'); params.active = updates.active ? 1 : 0; }
  if (updates.sortOrder !== undefined) { fields.push('sort_order = @sortOrder'); params.sortOrder = updates.sortOrder; }

  if (fields.length === 0) return getMockupBackgroundById(id);

  fields.push('updated_at = CURRENT_TIMESTAMP');
  db.prepare(`UPDATE mockup_backgrounds SET ${fields.join(', ')} WHERE id = @id`).run(params);
  return getMockupBackgroundById(id);
}

function deleteMockupBackground(id) {
  const existing = getMockupBackgroundById(id);
  if (!existing) return { success: false, error: 'Background not found' };
  db.prepare('DELETE FROM mockup_backgrounds WHERE id = ?').run(id);
  return { success: true, deleted: existing };
}

function mapMockupBackgroundRow(row) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    description: row.description,
    filePath: row.file_path,
    thumbnailPath: row.thumbnail_path,
    width: row.width,
    height: row.height,
    fileSize: row.file_size,
    tags: row.tags,
    defaultWidthPct: row.default_width_pct,
    defaultXOffset: row.default_x_offset,
    defaultYOffset: row.default_y_offset,
    active: !!row.active,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// ============================================================================
// STICKER CONTOUR CACHE FUNCTIONS
// Lazy generation of contours - generated on first use, cached forever
// ============================================================================

/**
 * Generate a hash for the image path (used as cache key)
 * @param {string} imagePath - Path to the sticker image
 * @returns {string} MD5 hash of the path
 */
function hashImagePath(imagePath) {
  return crypto.createHash('md5').update(imagePath).digest('hex');
}

/**
 * Get cached contour for a sticker by image path
 * @param {string} imagePath - Path to the sticker image
 * @returns {Object|null} Cached contour data or null if not cached
 */
function getStickerContour(imagePath) {
  const pathHash = hashImagePath(imagePath);
  const row = db.prepare(`
    SELECT * FROM sticker_contours WHERE image_path_hash = ?
  `).get(pathHash);

  if (!row) return null;

  return {
    id: row.id,
    imagePath: row.image_path,
    contourSvgPath: row.contour_svg_path,
    width: row.contour_width,
    height: row.contour_height,
    createdAt: row.created_at
  };
}

/**
 * Save a generated contour to the cache
 * @param {string} imagePath - Path to the sticker image
 * @param {string} contourSvgPath - SVG path data (d attribute content)
 * @param {number} width - Original image width
 * @param {number} height - Original image height
 * @returns {string} ID of the saved contour record
 */
function saveStickerContour(imagePath, contourSvgPath, width, height) {
  const pathHash = hashImagePath(imagePath);
  const id = `contour-${crypto.randomUUID()}`;

  // Use INSERT OR REPLACE in case the contour already exists
  db.prepare(`
    INSERT OR REPLACE INTO sticker_contours
    (id, image_path, image_path_hash, contour_svg_path, contour_width, contour_height, created_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(id, imagePath, pathHash, contourSvgPath, width, height);

  return id;
}

/**
 * Delete a cached contour (useful if image is updated)
 * @param {string} imagePath - Path to the sticker image
 * @returns {boolean} True if a contour was deleted
 */
function deleteStickerContour(imagePath) {
  const pathHash = hashImagePath(imagePath);
  const result = db.prepare(`
    DELETE FROM sticker_contours WHERE image_path_hash = ?
  `).run(pathHash);

  return result.changes > 0;
}

/**
 * List all cached contours (for debugging/admin)
 * @param {number} limit - Max number of results
 * @returns {Array} List of cached contours
 */
function listStickerContours(limit = 100) {
  const rows = db.prepare(`
    SELECT id, image_path, contour_width, contour_height, created_at
    FROM sticker_contours
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit);

  return rows.map(row => ({
    id: row.id,
    imagePath: row.image_path,
    width: row.contour_width,
    height: row.contour_height,
    createdAt: row.created_at
  }));
}

module.exports = {
  initDatabase,
  normalizeEmail,
  normalizePhone,
  findCustomerByEmail,
  findCustomerByPhone,
  recordOutboundMessage,
  recordInboundMessage,
  upsertCustomerContact,
  createCustomerAccount,
  verifyCustomerCredentials,
  createSession,
  getCustomerByToken,
  deleteSession,
  deleteOrder,
  recordOrder,
  updateOrder,
  fetchOrders,
  fetchOrdersByCustomer,
  fetchOrdersForQueue,
  getOrderById,
  duplicateOrder,
  findCustomerById,
  createEmailToken,
  consumeEmailToken,
  markEmailVerified,
  updateCustomerPassword,
  createLoginCode,
  consumeLoginCode,
  updateCustomerProfile,
  getNextOrderNumber,
  getNextQuoteNumber,
  setOrderPaymentLink,
  markOrderPaid,
  // POD orders (Shopify print-on-demand)
  getArtworkForSku,
  upsertArtworkForSku,
  upsertPodOrder,
  getPodOrderByShopifyOrderId,
  upsertPodLineItem,
  getPodLineItemByShopifyId,
  listOpenPodOrders,
  markPodLineItemsShipped,
  createRaceQuote,
  updateRaceQuote,
  getRaceQuoteById,
  fetchRaceQuotesByCustomer,
  fetchAllRaceQuotes,
  setRaceQuotePaymentLink,
  markRaceQuotePaid,
  findRaceQuoteByPaymentLinkId,
  createRaceQuoteMessage,
  listRaceQuoteMessages,
  getRaceQuoteMessageById,
  addRaceQuoteFile,
  listRaceQuoteFiles,
  getRaceQuoteFileById,
  findCustomerByRememberToken,
  regenerateRememberToken,
  markOrderDownloaded,
  markOrderCompleted,
  listInventoryItems,
  getInventoryItemById,
  createInventoryItem,
  adjustInventoryQuantity,
  updateInventoryItem,
  deleteInventoryItem,
  recordOrderInventoryUsage,
  upsertVendorOrderRecord,
  // Custom Art - Rooms
  createCustomArtRoom,
  updateCustomArtRoom,
  deleteCustomArtRoom,
  getCustomArtRoomById,
  listCustomArtRooms,
  // Custom Art - Artwork
  createCustomArtArtwork,
  updateCustomArtArtwork,
  deleteCustomArtArtwork,
  getCustomArtArtworkById,
  listCustomArtArtwork,
  listCustomArtArtworkCategories,
  // Human Models
  createHumanModel,
  updateHumanModel,
  deleteHumanModel,
  getHumanModelById,
  listHumanModels,
  listHumanModelCategories,
  // Human Model Color Variants (AI-recolored models)
  saveRecoloredModel,
  getRecoloredModel,
  getRecoloredModelByCacheKey,
  listRecoloredModelsByModel,
  listRecoloredModelsByColor,
  deleteRecoloredModel,
  deleteRecoloredModelsByModel,
  // Raw database instance (for scripts that need direct access)
  db,
  // Custom Art - Materials
  createCustomArtMaterial,
  updateCustomArtMaterial,
  deleteCustomArtMaterial,
  getCustomArtMaterialById,
  listCustomArtMaterials,
  // Custom Art - Products
  createCustomArtProduct,
  updateCustomArtProduct,
  deleteCustomArtProduct,
  getCustomArtProductById,
  getCustomArtProductByShopifyId,
  getMockupsForShopifyProducts,
  listCustomArtProducts,
  // Custom Art - Product Variants
  createCustomArtProductVariant,
  updateCustomArtProductVariant,
  deleteCustomArtProductVariant,
  deleteCustomArtProductVariantsByProductId,
  getCustomArtProductVariantById,
  listCustomArtProductVariants,
  // Custom Art Tiles
  createCustomArtTile,
  getCustomArtTileById,
  listCustomArtTilesByProduct,
  listCustomArtTilesByArtwork,
  deleteCustomArtTilesByProduct,
  // Custom Art Mockups
  createCustomArtMockup,
  getCustomArtMockupById,
  listCustomArtMockups,
  updateCustomArtMockup,
  deleteCustomArtMockup,
  // Car Templates for Race Decal Designer
  listCarTemplates,
  getCarTemplateById,
  findCarTemplate,
  getDistinctCarMakes,
  getCarModelsByMake,
  createCarTemplate,
  updateCarTemplate,
  deleteCarTemplate,
  // Race Designs
  createRaceDesign,
  getRaceDesignById,
  listRaceDesignsByCustomer,
  updateRaceDesign,
  deleteRaceDesign,
  listAllRaceDesigns,
  // Mockup Templates (for Facebook post automation)
  createMockupTemplate,
  getMockupTemplateById,
  getMockupTemplatesByCampaign,
  listAllMockupTemplates,
  updateMockupTemplate,
  deleteMockupTemplate,
  // Scheduled Facebook Posts
  createScheduledPost,
  getScheduledPostById,
  listScheduledPosts,
  getPendingScheduledPosts,
  updateScheduledPost,
  deleteScheduledPost,
  markScheduledPostPublished,
  markScheduledPostFailed,
  // Facebook Post Content (AI-generated)
  saveFacebookPostContent,
  getFacebookPostContentByCampaign,
  // Mockup Backgrounds (for print-station decal mockups)
  createMockupBackground,
  getMockupBackgroundById,
  listMockupBackgrounds,
  listMockupBackgroundCategories,
  updateMockupBackground,
  deleteMockupBackground,
  // Sticker Contour Cache (lazy generation)
  getStickerContour,
  saveStickerContour,
  deleteStickerContour,
  listStickerContours,
  // Expose database instance for modules that need direct access
  getDb: () => db,
  // Database backup functions
  createBackup,
  listBackups,
  restoreFromBackup,
  BACKUP_DIR
};
