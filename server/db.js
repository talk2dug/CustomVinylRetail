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

  // Contour Style Profile - learned preferences from Studio3 files
  db.exec(`
    CREATE TABLE IF NOT EXISTS contour_style_profile (
      id TEXT PRIMARY KEY DEFAULT 'default',
      profile_data TEXT NOT NULL,
      sample_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ============================================
  // SKU CATALOG TABLES - POS System
  // ============================================

  // SKU Designs (parsed from .studio3 files)
  db.exec(`
    CREATE TABLE IF NOT EXISTS sku_designs (
      id TEXT PRIMARY KEY,
      studio3_id TEXT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      thumbnail TEXT,
      original_width_mm REAL,
      original_height_mm REAL,
      cut_paths TEXT,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (studio3_id) REFERENCES studio3_catalog(id) ON DELETE SET NULL
    )
  `);
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_sku_designs_slug ON sku_designs(slug)`); } catch (e) { /* ignore */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_sku_designs_active ON sku_designs(active)`); } catch (e) { /* ignore */ }

  // SKU Variants (design + size + color combinations)
  db.exec(`
    CREATE TABLE IF NOT EXISTS sku_variants (
      id TEXT PRIMARY KEY,
      design_id TEXT NOT NULL,
      sku TEXT NOT NULL UNIQUE,
      size_inches REAL NOT NULL,
      color_name TEXT NOT NULL,
      color_hex TEXT,
      price_cents INTEGER NOT NULL,
      active INTEGER DEFAULT 1,
      qr_code_data TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (design_id) REFERENCES sku_designs(id) ON DELETE CASCADE
    )
  `);
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_sku_variants_design ON sku_variants(design_id)`); } catch (e) { /* ignore */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_sku_variants_sku ON sku_variants(sku)`); } catch (e) { /* ignore */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_sku_variants_active ON sku_variants(active)`); } catch (e) { /* ignore */ }

  // Cart Sessions (in-progress checkout sessions)
  db.exec(`
    CREATE TABLE IF NOT EXISTS cart_sessions (
      id TEXT PRIMARY KEY,
      status TEXT DEFAULT 'active',
      total_cents INTEGER DEFAULT 0,
      item_count INTEGER DEFAULT 0,
      square_order_id TEXT,
      square_payment_link TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    )
  `);
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_cart_sessions_status ON cart_sessions(status)`); } catch (e) { /* ignore */ }

  // Cart Items (items in a cart session)
  db.exec(`
    CREATE TABLE IF NOT EXISTS cart_items (
      id TEXT PRIMARY KEY,
      cart_session_id TEXT NOT NULL,
      variant_id TEXT NOT NULL,
      sku TEXT NOT NULL,
      quantity INTEGER DEFAULT 1,
      unit_price_cents INTEGER NOT NULL,
      line_total_cents INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (cart_session_id) REFERENCES cart_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (variant_id) REFERENCES sku_variants(id) ON DELETE CASCADE
    )
  `);
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_cart_items_session ON cart_items(cart_session_id)`); } catch (e) { /* ignore */ }

  // SKU Scans (analytics and inventory tracking)
  db.exec(`
    CREATE TABLE IF NOT EXISTS sku_scans (
      id TEXT PRIMARY KEY,
      variant_id TEXT,
      sku TEXT NOT NULL,
      scan_type TEXT DEFAULT 'sale',
      cart_session_id TEXT,
      quantity INTEGER DEFAULT 1,
      scanned_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (variant_id) REFERENCES sku_variants(id) ON DELETE SET NULL
    )
  `);
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_sku_scans_session ON sku_scans(cart_session_id)`); } catch (e) { /* ignore */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_sku_scans_sku ON sku_scans(sku)`); } catch (e) { /* ignore */ }

  // QR Product Catalog (simple product items with photo, description, price)
  db.exec(`
    CREATE TABLE IF NOT EXISTS qr_products (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      price_cents INTEGER NOT NULL DEFAULT 0,
      photo_path TEXT,
      category TEXT DEFAULT '',
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_qr_products_active ON qr_products(active)`); } catch (e) { /* ignore */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_qr_products_category ON qr_products(category)`); } catch (e) { /* ignore */ }

  // Decal fields (added via ALTER TABLE so existing rows get defaults)
  const decalColumns = [
    { name: 'size', sql: "ALTER TABLE qr_products ADD COLUMN size TEXT DEFAULT ''" },
    { name: 'color', sql: "ALTER TABLE qr_products ADD COLUMN color TEXT DEFAULT ''" },
    { name: 'decal_text', sql: "ALTER TABLE qr_products ADD COLUMN decal_text TEXT DEFAULT ''" },
    { name: 'is_heat_transfer', sql: "ALTER TABLE qr_products ADD COLUMN is_heat_transfer INTEGER DEFAULT 0" },
    { name: 'quantity', sql: "ALTER TABLE qr_products ADD COLUMN quantity INTEGER DEFAULT 1" },
  ];
  for (const col of decalColumns) {
    try { db.exec(col.sql); } catch (e) { /* column already exists */ }
  }

  // Shopify sync fields (added via ALTER TABLE so existing rows get defaults)
  const shopifyColumns = [
    { name: 'shopify_product_id', sql: "ALTER TABLE qr_products ADD COLUMN shopify_product_id TEXT" },
    { name: 'shopify_handle', sql: "ALTER TABLE qr_products ADD COLUMN shopify_handle TEXT" },
  ];
  for (const col of shopifyColumns) {
    try { db.exec(col.sql); } catch (e) { /* column already exists */ }
  }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_qr_products_shopify ON qr_products(shopify_product_id)`); } catch (e) { /* ignore */ }

  // Seed default materials
  seedCustomArtMaterials();

  // ============================================================================
  // B2B METAL PRINTS PORTAL TABLES
  // ============================================================================

  // B2B Partner Companies
  db.exec(`
    CREATE TABLE IF NOT EXISTS b2b_companies (
      id TEXT PRIMARY KEY,
      company_name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      contact_email TEXT NOT NULL,
      contact_phone TEXT,
      billing_address TEXT,
      shipping_address TEXT,
      tax_exempt INTEGER DEFAULT 0,
      tax_id TEXT,
      payment_terms TEXT DEFAULT 'prepay',
      credit_limit_cents INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_b2b_companies_slug ON b2b_companies(slug)`); } catch (e) { /* ignore */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_b2b_companies_status ON b2b_companies(status)`); } catch (e) { /* ignore */ }

  // B2B Users (employees of partner companies)
  db.exec(`
    CREATE TABLE IF NOT EXISTS b2b_users (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT,
      role TEXT DEFAULT 'user',
      is_primary_contact INTEGER DEFAULT 0,
      email_verified INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_login_at TEXT,
      FOREIGN KEY (company_id) REFERENCES b2b_companies(id) ON DELETE CASCADE
    )
  `);
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_b2b_users_company ON b2b_users(company_id)`); } catch (e) { /* ignore */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_b2b_users_email ON b2b_users(email)`); } catch (e) { /* ignore */ }

  // B2B Sessions (separate from customer sessions)
  db.exec(`
    CREATE TABLE IF NOT EXISTS b2b_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES b2b_users(id) ON DELETE CASCADE
    )
  `);
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_b2b_sessions_token ON b2b_sessions(token)`); } catch (e) { /* ignore */ }

  // B2B Metal Print Orders
  db.exec(`
    CREATE TABLE IF NOT EXISTS b2b_metal_print_orders (
      id TEXT PRIMARY KEY,
      order_number INTEGER,
      company_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      status TEXT DEFAULT 'draft',
      shipping_name TEXT,
      shipping_address_line1 TEXT,
      shipping_address_line2 TEXT,
      shipping_city TEXT,
      shipping_state TEXT,
      shipping_zip TEXT,
      shipping_country TEXT DEFAULT 'US',
      shipping_phone TEXT,
      tracking_carrier TEXT,
      tracking_number TEXT,
      subtotal_cents INTEGER DEFAULT 0,
      shipping_cents INTEGER DEFAULT 0,
      tax_cents INTEGER DEFAULT 0,
      total_cents INTEGER DEFAULT 0,
      payment_status TEXT DEFAULT 'pending',
      payment_link TEXT,
      payment_link_id TEXT,
      payment_details TEXT,
      paid_at TEXT,
      notes TEXT,
      internal_notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      submitted_at TEXT,
      shipped_at TEXT,
      completed_at TEXT,
      FOREIGN KEY (company_id) REFERENCES b2b_companies(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES b2b_users(id) ON DELETE SET NULL
    )
  `);
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_b2b_orders_company ON b2b_metal_print_orders(company_id)`); } catch (e) { /* ignore */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_b2b_orders_status ON b2b_metal_print_orders(status)`); } catch (e) { /* ignore */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_b2b_orders_payment ON b2b_metal_print_orders(payment_status)`); } catch (e) { /* ignore */ }

  // B2B Order Line Items (individual prints)
  db.exec(`
    CREATE TABLE IF NOT EXISTS b2b_metal_print_items (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      size TEXT NOT NULL,
      custom_dimensions TEXT,
      quantity INTEGER DEFAULT 1,
      unit_price_cents INTEGER NOT NULL,
      line_total_cents INTEGER NOT NULL,
      image_path TEXT,
      image_original_name TEXT,
      image_width INTEGER,
      image_height INTEGER,
      uploaded_at TEXT,
      needs_quote INTEGER DEFAULT 0,
      quote_price_cents INTEGER,
      quote_approved INTEGER DEFAULT 0,
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES b2b_metal_print_orders(id) ON DELETE CASCADE
    )
  `);
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_b2b_items_order ON b2b_metal_print_items(order_id)`); } catch (e) { /* ignore */ }

  // Multiboard Designer
  db.exec(`
    CREATE TABLE IF NOT EXISTS multiboard_designs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      design_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      customer_name TEXT,
      customer_email TEXT,
      customer_phone TEXT,
      wall_width_inches REAL NOT NULL,
      wall_height_inches REAL NOT NULL,
      components_json TEXT NOT NULL,
      parts_list_json TEXT,
      total_price_cents INTEGER,
      status TEXT DEFAULT 'draft',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Multiboard Orders (production queue)
  db.exec(`
    CREATE TABLE IF NOT EXISTS multiboard_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT UNIQUE NOT NULL,
      design_id TEXT NOT NULL,
      customer_name TEXT,
      customer_email TEXT,
      customer_phone TEXT,
      service_level TEXT DEFAULT 'designBuild',
      wall_width_inches REAL NOT NULL,
      wall_height_inches REAL NOT NULL,
      components_json TEXT NOT NULL,
      parts_list_json TEXT,
      total_price_cents INTEGER,
      service_fee_cents INTEGER DEFAULT 0,
      status TEXT DEFAULT 'ordered',
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  console.log('[B2B Portal] ✅ Tables initialized successfully');
  console.log('[Custom Art] ✅ Tables initialized successfully');
  console.log('[Multiboard] ✅ Tables initialized successfully');

  // STL Catalog (3D models stored on server for slicing)
  db.exec(`
    CREATE TABLE IF NOT EXISTS stl_catalog (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT,
      stl_path TEXT NOT NULL,
      thumbnail_path TEXT,
      default_quality TEXT DEFAULT 'standard',
      default_strength TEXT DEFAULT 'normal',
      default_material TEXT DEFAULT 'pla',
      default_texture TEXT DEFAULT 'smooth',
      default_supports TEXT DEFAULT 'none',
      notes TEXT,
      file_size INTEGER,
      triangle_count INTEGER,
      dim_x REAL, dim_y REAL, dim_z REAL,
      est_weight_g REAL,
      est_time_min REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_stl_catalog_name ON stl_catalog(name);
    CREATE INDEX IF NOT EXISTS idx_stl_catalog_category ON stl_catalog(category);
  `);

  // G-code Cache (sliced G-code with full settings metadata)
  db.exec(`
    CREATE TABLE IF NOT EXISTS gcode_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stl_catalog_id INTEGER NOT NULL,
      settings_hash TEXT NOT NULL UNIQUE,
      printer_model TEXT NOT NULL,
      material TEXT NOT NULL,
      quality TEXT NOT NULL,
      strength TEXT NOT NULL,
      speed TEXT NOT NULL,
      texture TEXT NOT NULL,
      supports TEXT NOT NULL,
      gcode_path TEXT NOT NULL,
      gcode_filename TEXT NOT NULL,
      est_weight_g REAL,
      est_time_min REAL,
      file_size INTEGER,
      sliced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (stl_catalog_id) REFERENCES stl_catalog(id)
    );
    CREATE INDEX IF NOT EXISTS idx_gcode_cache_stl ON gcode_cache(stl_catalog_id);
    CREATE INDEX IF NOT EXISTS idx_gcode_cache_hash ON gcode_cache(settings_hash);
  `);

  console.log('[Slicer] ✅ Tables initialized successfully');
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
// SKU CATALOG CRUD FUNCTIONS - POS System
// ============================================================================

// Pricing table: [size in inches][color count] = price in cents
const STICKER_PRICE_TABLE = {
  2: { 1: 325, 2: 350, 3: 375 },
  3: { 1: 350, 2: 375, 3: 400, 4: 425 },
  4: { 1: 375, 2: 425, 3: 450, 4: 500 },
  6: { 1: 425, 2: 500, 3: 575, 4: 700 },
  8: { 1: 500, 2: 575, 3: 650, 4: 750 },
  10: { 1: 575, 2: 650, 3: 750, 4: 850 },
  12: { 1: 650, 2: 750, 3: 850, 4: 950 }
};

/**
 * Calculate price for a sticker based on size and color count
 */
function calculateStickerPrice(sizeInches, colorCount = 1) {
  const sizes = Object.keys(STICKER_PRICE_TABLE).map(Number);
  const nearestSize = sizes.reduce((prev, curr) =>
    Math.abs(curr - sizeInches) < Math.abs(prev - sizeInches) ? curr : prev
  );
  const colorTable = STICKER_PRICE_TABLE[nearestSize] || STICKER_PRICE_TABLE[4];
  const maxColors = Math.max(...Object.keys(colorTable).map(Number));
  const clampedColors = Math.min(Math.max(colorCount, 1), maxColors);
  return colorTable[clampedColors] || 400;
}

/**
 * Generate a slug from a design name
 */
function generateSlug(name) {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 20);
}

/**
 * Generate SKU code from design slug, size, and color
 */
function generateSkuCode(designSlug, sizeInches, colorName) {
  const sizePart = `${Math.round(sizeInches)}IN`;
  const colorPart = colorName
    .toUpperCase()
    .replace(/\s+/g, '-')
    .replace(/[^A-Z0-9-]/g, '')
    .substring(0, 10);
  return `${designSlug}-${sizePart}-${colorPart}`;
}

// --- SKU Designs CRUD ---
function createSkuDesign({ name, studio3Id, thumbnail, originalWidthMm, originalHeightMm, cutPaths }) {
  const id = `design_${crypto.randomBytes(8).toString('hex')}`;
  let slug = generateSlug(name);

  // Ensure slug is unique
  let counter = 1;
  let originalSlug = slug;
  while (db.prepare('SELECT 1 FROM sku_designs WHERE slug = ?').get(slug)) {
    slug = `${originalSlug}-${counter++}`;
  }

  db.prepare(`
    INSERT INTO sku_designs (id, studio3_id, name, slug, thumbnail, original_width_mm, original_height_mm, cut_paths)
    VALUES (@id, @studio3Id, @name, @slug, @thumbnail, @originalWidthMm, @originalHeightMm, @cutPaths)
  `).run({
    id,
    studio3Id: studio3Id || null,
    name,
    slug,
    thumbnail: thumbnail || null,
    originalWidthMm: originalWidthMm || null,
    originalHeightMm: originalHeightMm || null,
    cutPaths: cutPaths ? JSON.stringify(cutPaths) : null
  });
  return getSkuDesignById(id);
}

function updateSkuDesign(id, updates) {
  const fields = [];
  const params = { id };

  if (updates.name !== undefined) { fields.push('name = @name'); params.name = updates.name; }
  if (updates.slug !== undefined) { fields.push('slug = @slug'); params.slug = updates.slug; }
  if (updates.thumbnail !== undefined) { fields.push('thumbnail = @thumbnail'); params.thumbnail = updates.thumbnail; }
  if (updates.originalWidthMm !== undefined) { fields.push('original_width_mm = @originalWidthMm'); params.originalWidthMm = updates.originalWidthMm; }
  if (updates.originalHeightMm !== undefined) { fields.push('original_height_mm = @originalHeightMm'); params.originalHeightMm = updates.originalHeightMm; }
  if (updates.cutPaths !== undefined) { fields.push('cut_paths = @cutPaths'); params.cutPaths = JSON.stringify(updates.cutPaths); }
  if (updates.active !== undefined) { fields.push('active = @active'); params.active = updates.active ? 1 : 0; }

  if (fields.length === 0) return getSkuDesignById(id);

  fields.push('updated_at = CURRENT_TIMESTAMP');
  db.prepare(`UPDATE sku_designs SET ${fields.join(', ')} WHERE id = @id`).run(params);
  return getSkuDesignById(id);
}

function deleteSkuDesign(id) {
  const existing = getSkuDesignById(id);
  if (!existing) return { success: false, error: 'Design not found' };
  db.prepare('DELETE FROM sku_designs WHERE id = ?').run(id);
  return { success: true, deleted: existing };
}

function getSkuDesignById(id) {
  const row = db.prepare('SELECT * FROM sku_designs WHERE id = ?').get(id);
  return row ? mapSkuDesignRow(row) : null;
}

function getSkuDesignBySlug(slug) {
  const row = db.prepare('SELECT * FROM sku_designs WHERE slug = ?').get(slug);
  return row ? mapSkuDesignRow(row) : null;
}

function listSkuDesigns({ activeOnly = false } = {}) {
  let query = 'SELECT d.*, (SELECT COUNT(*) FROM sku_variants v WHERE v.design_id = d.id) as variant_count FROM sku_designs d';
  if (activeOnly) query += ' WHERE d.active = 1';
  query += ' ORDER BY d.created_at DESC';
  return db.prepare(query).all().map(row => ({
    ...mapSkuDesignRow(row),
    variantCount: row.variant_count
  }));
}

function mapSkuDesignRow(row) {
  return {
    id: row.id,
    studio3Id: row.studio3_id,
    name: row.name,
    slug: row.slug,
    thumbnail: row.thumbnail,
    originalWidthMm: row.original_width_mm,
    originalHeightMm: row.original_height_mm,
    cutPaths: row.cut_paths ? JSON.parse(row.cut_paths) : null,
    active: !!row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// --- SKU Variants CRUD ---
function createSkuVariant({ designId, sizeInches, colorName, colorHex, priceCents }) {
  const design = getSkuDesignById(designId);
  if (!design) throw new Error('Design not found');

  const id = `var_${crypto.randomBytes(8).toString('hex')}`;
  const sku = generateSkuCode(design.slug, sizeInches, colorName);

  // Check for duplicate SKU
  const existing = db.prepare('SELECT 1 FROM sku_variants WHERE sku = ?').get(sku);
  if (existing) throw new Error(`SKU ${sku} already exists`);

  // Auto-calculate price if not provided
  const finalPrice = priceCents || calculateStickerPrice(sizeInches, 1);

  db.prepare(`
    INSERT INTO sku_variants (id, design_id, sku, size_inches, color_name, color_hex, price_cents)
    VALUES (@id, @designId, @sku, @sizeInches, @colorName, @colorHex, @priceCents)
  `).run({
    id,
    designId,
    sku,
    sizeInches,
    colorName,
    colorHex: colorHex || null,
    priceCents: finalPrice
  });
  return getSkuVariantById(id);
}

function updateSkuVariant(id, updates) {
  const fields = [];
  const params = { id };

  if (updates.colorName !== undefined) { fields.push('color_name = @colorName'); params.colorName = updates.colorName; }
  if (updates.colorHex !== undefined) { fields.push('color_hex = @colorHex'); params.colorHex = updates.colorHex; }
  if (updates.priceCents !== undefined) { fields.push('price_cents = @priceCents'); params.priceCents = updates.priceCents; }
  if (updates.active !== undefined) { fields.push('active = @active'); params.active = updates.active ? 1 : 0; }
  if (updates.qrCodeData !== undefined) { fields.push('qr_code_data = @qrCodeData'); params.qrCodeData = updates.qrCodeData; }

  if (fields.length === 0) return getSkuVariantById(id);

  fields.push('updated_at = CURRENT_TIMESTAMP');
  db.prepare(`UPDATE sku_variants SET ${fields.join(', ')} WHERE id = @id`).run(params);
  return getSkuVariantById(id);
}

function deleteSkuVariant(id) {
  const existing = getSkuVariantById(id);
  if (!existing) return { success: false, error: 'Variant not found' };
  db.prepare('DELETE FROM sku_variants WHERE id = ?').run(id);
  return { success: true, deleted: existing };
}

function getSkuVariantById(id) {
  const row = db.prepare('SELECT * FROM sku_variants WHERE id = ?').get(id);
  return row ? mapSkuVariantRow(row) : null;
}

function getSkuVariantBySku(sku) {
  const row = db.prepare('SELECT * FROM sku_variants WHERE sku = ?').get(sku);
  return row ? mapSkuVariantRow(row) : null;
}

function listSkuVariants({ designId, activeOnly = false } = {}) {
  let query = 'SELECT * FROM sku_variants WHERE 1=1';
  const params = [];
  if (designId) { query += ' AND design_id = ?'; params.push(designId); }
  if (activeOnly) query += ' AND active = 1';
  query += ' ORDER BY size_inches ASC, color_name ASC';
  return db.prepare(query).all(...params).map(mapSkuVariantRow);
}

function mapSkuVariantRow(row) {
  return {
    id: row.id,
    designId: row.design_id,
    sku: row.sku,
    sizeInches: row.size_inches,
    colorName: row.color_name,
    colorHex: row.color_hex,
    priceCents: row.price_cents,
    active: !!row.active,
    qrCodeData: row.qr_code_data,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// --- Cart Sessions CRUD ---
function createCartSession() {
  const id = `cart_${crypto.randomBytes(8).toString('hex')}`;
  db.prepare(`
    INSERT INTO cart_sessions (id, status, total_cents, item_count)
    VALUES (@id, 'active', 0, 0)
  `).run({ id });
  return getCartSessionById(id);
}

function updateCartSession(id, updates) {
  const fields = [];
  const params = { id };

  if (updates.status !== undefined) { fields.push('status = @status'); params.status = updates.status; }
  if (updates.totalCents !== undefined) { fields.push('total_cents = @totalCents'); params.totalCents = updates.totalCents; }
  if (updates.itemCount !== undefined) { fields.push('item_count = @itemCount'); params.itemCount = updates.itemCount; }
  if (updates.squareOrderId !== undefined) { fields.push('square_order_id = @squareOrderId'); params.squareOrderId = updates.squareOrderId; }
  if (updates.squarePaymentLink !== undefined) { fields.push('square_payment_link = @squarePaymentLink'); params.squarePaymentLink = updates.squarePaymentLink; }
  if (updates.completedAt !== undefined) { fields.push('completed_at = @completedAt'); params.completedAt = updates.completedAt; }

  if (fields.length === 0) return getCartSessionById(id);

  fields.push('updated_at = CURRENT_TIMESTAMP');
  db.prepare(`UPDATE cart_sessions SET ${fields.join(', ')} WHERE id = @id`).run(params);
  return getCartSessionById(id);
}

function getCartSessionById(id) {
  const row = db.prepare('SELECT * FROM cart_sessions WHERE id = ?').get(id);
  return row ? mapCartSessionRow(row) : null;
}

function getActiveCartSession() {
  const row = db.prepare("SELECT * FROM cart_sessions WHERE status = 'active' ORDER BY created_at DESC LIMIT 1").get();
  return row ? mapCartSessionRow(row) : null;
}

function listCartSessions({ status } = {}) {
  let query = 'SELECT * FROM cart_sessions';
  const params = [];
  if (status) { query += ' WHERE status = ?'; params.push(status); }
  query += ' ORDER BY created_at DESC';
  return db.prepare(query).all(...params).map(mapCartSessionRow);
}

function mapCartSessionRow(row) {
  return {
    id: row.id,
    status: row.status,
    totalCents: row.total_cents,
    itemCount: row.item_count,
    squareOrderId: row.square_order_id,
    squarePaymentLink: row.square_payment_link,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  };
}

// --- Cart Items CRUD ---
function addCartItem(cartSessionId, { variantId, sku, quantity = 1, unitPriceCents }) {
  const id = `item_${crypto.randomBytes(8).toString('hex')}`;
  const lineTotalCents = unitPriceCents * quantity;

  db.prepare(`
    INSERT INTO cart_items (id, cart_session_id, variant_id, sku, quantity, unit_price_cents, line_total_cents)
    VALUES (@id, @cartSessionId, @variantId, @sku, @quantity, @unitPriceCents, @lineTotalCents)
  `).run({ id, cartSessionId, variantId, sku, quantity, unitPriceCents, lineTotalCents });

  // Update cart totals
  recalculateCartTotals(cartSessionId);

  return getCartItemById(id);
}

function updateCartItem(id, { quantity }) {
  const item = getCartItemById(id);
  if (!item) return null;

  const lineTotalCents = item.unitPriceCents * quantity;
  db.prepare(`
    UPDATE cart_items SET quantity = @quantity, line_total_cents = @lineTotalCents WHERE id = @id
  `).run({ id, quantity, lineTotalCents });

  // Update cart totals
  recalculateCartTotals(item.cartSessionId);

  return getCartItemById(id);
}

function removeCartItem(id) {
  const item = getCartItemById(id);
  if (!item) return { success: false, error: 'Item not found' };

  db.prepare('DELETE FROM cart_items WHERE id = ?').run(id);

  // Update cart totals
  recalculateCartTotals(item.cartSessionId);

  return { success: true, deleted: item };
}

function getCartItemById(id) {
  const row = db.prepare('SELECT * FROM cart_items WHERE id = ?').get(id);
  return row ? mapCartItemRow(row) : null;
}

function listCartItems(cartSessionId) {
  return db.prepare('SELECT * FROM cart_items WHERE cart_session_id = ? ORDER BY created_at ASC')
    .all(cartSessionId)
    .map(mapCartItemRow);
}

function clearCartItems(cartSessionId) {
  db.prepare('DELETE FROM cart_items WHERE cart_session_id = ?').run(cartSessionId);
  recalculateCartTotals(cartSessionId);
}

function recalculateCartTotals(cartSessionId) {
  const result = db.prepare(`
    SELECT COALESCE(SUM(line_total_cents), 0) as total, COUNT(*) as count
    FROM cart_items WHERE cart_session_id = ?
  `).get(cartSessionId);

  db.prepare(`
    UPDATE cart_sessions SET total_cents = @total, item_count = @count, updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `).run({ id: cartSessionId, total: result.total, count: result.count });
}

function mapCartItemRow(row) {
  return {
    id: row.id,
    cartSessionId: row.cart_session_id,
    variantId: row.variant_id,
    sku: row.sku,
    quantity: row.quantity,
    unitPriceCents: row.unit_price_cents,
    lineTotalCents: row.line_total_cents,
    createdAt: row.created_at
  };
}

// --- SKU Scans (Analytics) ---
function recordSkuScan({ variantId, sku, scanType = 'sale', cartSessionId }) {
  const id = `scan_${crypto.randomBytes(8).toString('hex')}`;
  db.prepare(`
    INSERT INTO sku_scans (id, variant_id, sku, scan_type, cart_session_id)
    VALUES (@id, @variantId, @sku, @scanType, @cartSessionId)
  `).run({ id, variantId: variantId || null, sku, scanType, cartSessionId: cartSessionId || null });
  return id;
}

function listSkuScans({ sku, cartSessionId, startDate, endDate, limit = 100 } = {}) {
  let query = 'SELECT * FROM sku_scans WHERE 1=1';
  const params = [];

  if (sku) { query += ' AND sku = ?'; params.push(sku); }
  if (cartSessionId) { query += ' AND cart_session_id = ?'; params.push(cartSessionId); }
  if (startDate) { query += ' AND scanned_at >= ?'; params.push(startDate); }
  if (endDate) { query += ' AND scanned_at <= ?'; params.push(endDate); }

  query += ' ORDER BY scanned_at DESC LIMIT ?';
  params.push(limit);

  return db.prepare(query).all(...params).map(row => ({
    id: row.id,
    variantId: row.variant_id,
    sku: row.sku,
    scanType: row.scan_type,
    cartSessionId: row.cart_session_id,
    quantity: row.quantity,
    scannedAt: row.scanned_at
  }));
}

// ============================================================================
// QR PRODUCT CATALOG FUNCTIONS
// Simple product items with photo, title, description, price
// ============================================================================

function mapQrProductRow(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description || '',
    priceCents: row.price_cents,
    photoPath: row.photo_path || null,
    category: row.category || '',
    size: row.size || '',
    color: row.color || '',
    decalText: row.decal_text || '',
    isHeatTransfer: !!row.is_heat_transfer,
    quantity: row.quantity || 1,
    active: !!row.active,
    shopifyProductId: row.shopify_product_id || null,
    shopifyHandle: row.shopify_handle || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function createQrProduct({ title, description, priceCents, photoPath, category, size, color, decalText, isHeatTransfer, quantity }) {
  const id = `prod_${crypto.randomBytes(8).toString('hex')}`;
  db.prepare(`
    INSERT INTO qr_products (id, title, description, price_cents, photo_path, category, size, color, decal_text, is_heat_transfer, quantity)
    VALUES (@id, @title, @description, @priceCents, @photoPath, @category, @size, @color, @decalText, @isHeatTransfer, @quantity)
  `).run({
    id,
    title,
    description: description || '',
    priceCents: priceCents || 0,
    photoPath: photoPath || null,
    category: category || '',
    size: size || '',
    color: color || '',
    decalText: decalText || '',
    isHeatTransfer: isHeatTransfer ? 1 : 0,
    quantity: quantity || 1
  });
  return getQrProductById(id);
}

function updateQrProduct(id, updates) {
  const fields = [];
  const params = { id };

  if (updates.title !== undefined) { fields.push('title = @title'); params.title = updates.title; }
  if (updates.description !== undefined) { fields.push('description = @description'); params.description = updates.description; }
  if (updates.priceCents !== undefined) { fields.push('price_cents = @priceCents'); params.priceCents = updates.priceCents; }
  if (updates.photoPath !== undefined) { fields.push('photo_path = @photoPath'); params.photoPath = updates.photoPath; }
  if (updates.category !== undefined) { fields.push('category = @category'); params.category = updates.category; }
  if (updates.size !== undefined) { fields.push('size = @size'); params.size = updates.size; }
  if (updates.color !== undefined) { fields.push('color = @color'); params.color = updates.color; }
  if (updates.decalText !== undefined) { fields.push('decal_text = @decalText'); params.decalText = updates.decalText; }
  if (updates.isHeatTransfer !== undefined) { fields.push('is_heat_transfer = @isHeatTransfer'); params.isHeatTransfer = updates.isHeatTransfer ? 1 : 0; }
  if (updates.quantity !== undefined) { fields.push('quantity = @quantity'); params.quantity = updates.quantity; }
  if (updates.active !== undefined) { fields.push('active = @active'); params.active = updates.active ? 1 : 0; }
  if (updates.shopifyProductId !== undefined) { fields.push('shopify_product_id = @shopifyProductId'); params.shopifyProductId = updates.shopifyProductId; }
  if (updates.shopifyHandle !== undefined) { fields.push('shopify_handle = @shopifyHandle'); params.shopifyHandle = updates.shopifyHandle; }

  if (fields.length === 0) return getQrProductById(id);

  fields.push('updated_at = CURRENT_TIMESTAMP');
  db.prepare(`UPDATE qr_products SET ${fields.join(', ')} WHERE id = @id`).run(params);
  return getQrProductById(id);
}

function deleteQrProduct(id) {
  const existing = getQrProductById(id);
  if (!existing) return { success: false, error: 'Product not found' };
  db.prepare('DELETE FROM qr_products WHERE id = ?').run(id);
  return { success: true, deleted: existing };
}

function getQrProductById(id) {
  const row = db.prepare('SELECT * FROM qr_products WHERE id = ?').get(id);
  return row ? mapQrProductRow(row) : null;
}

function listQrProducts({ activeOnly = false, category, search } = {}) {
  let query = 'SELECT * FROM qr_products WHERE 1=1';
  const params = [];

  if (activeOnly) { query += ' AND active = 1'; }
  if (category) { query += ' AND category = ?'; params.push(category); }
  if (search) {
    query += ' AND (title LIKE ? OR description LIKE ? OR category LIKE ?)';
    const term = `%${search}%`;
    params.push(term, term, term);
  }

  query += ' ORDER BY created_at DESC';
  return db.prepare(query).all(...params).map(mapQrProductRow);
}

function listQrProductCategories() {
  return db.prepare(
    "SELECT DISTINCT category FROM qr_products WHERE category IS NOT NULL AND category != '' ORDER BY category"
  ).all().map(r => r.category);
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

// ============================================================================
// B2B METAL PRINTS PORTAL FUNCTIONS
// ============================================================================

// Wholesale pricing for B2B metal prints
const B2B_METAL_PRINT_PRICING = {
  '5x7': 1500,    // $15.00
  '8x10': 2200,   // $22.00
  '11x14': 3200   // $32.00
};

function getB2BWholesalePrice(size) {
  return B2B_METAL_PRINT_PRICING[size] || null;
}

function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w-]+/g, '')
    .replace(/--+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

// --- B2B COMPANIES ---

function createB2BCompany({ companyName, contactEmail, contactPhone, billingAddress, shippingAddress, taxExempt, taxId, paymentTerms, notes }) {
  const id = `b2b-co-${crypto.randomBytes(8).toString('hex')}`;
  const slug = slugify(companyName);

  db.prepare(`
    INSERT INTO b2b_companies (id, company_name, slug, contact_email, contact_phone, billing_address, shipping_address, tax_exempt, tax_id, payment_terms, notes)
    VALUES (@id, @companyName, @slug, @contactEmail, @contactPhone, @billingAddress, @shippingAddress, @taxExempt, @taxId, @paymentTerms, @notes)
  `).run({
    id,
    companyName,
    slug,
    contactEmail: normalizeEmail(contactEmail),
    contactPhone: contactPhone || null,
    billingAddress: billingAddress || null,
    shippingAddress: shippingAddress || null,
    taxExempt: taxExempt ? 1 : 0,
    taxId: taxId || null,
    paymentTerms: paymentTerms || 'prepay',
    notes: notes || null
  });

  return getB2BCompanyById(id);
}

function getB2BCompanyById(id) {
  const row = db.prepare('SELECT * FROM b2b_companies WHERE id = ?').get(id);
  return row ? formatB2BCompany(row) : null;
}

function getB2BCompanyBySlug(slug) {
  const row = db.prepare('SELECT * FROM b2b_companies WHERE slug = ?').get(slug);
  return row ? formatB2BCompany(row) : null;
}

function listB2BCompanies({ status, limit = 100, offset = 0 } = {}) {
  const where = [];
  const params = { limit, offset };

  if (status) {
    where.push('status = @status');
    params.status = status;
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM b2b_companies ${clause} ORDER BY company_name ASC LIMIT @limit OFFSET @offset`).all(params);
  return rows.map(formatB2BCompany);
}

function updateB2BCompany(id, updates) {
  const fields = [];
  const params = { id };

  if (updates.companyName !== undefined) { fields.push('company_name = @companyName'); params.companyName = updates.companyName; }
  if (updates.contactEmail !== undefined) { fields.push('contact_email = @contactEmail'); params.contactEmail = normalizeEmail(updates.contactEmail); }
  if (updates.contactPhone !== undefined) { fields.push('contact_phone = @contactPhone'); params.contactPhone = updates.contactPhone; }
  if (updates.billingAddress !== undefined) { fields.push('billing_address = @billingAddress'); params.billingAddress = updates.billingAddress; }
  if (updates.shippingAddress !== undefined) { fields.push('shipping_address = @shippingAddress'); params.shippingAddress = updates.shippingAddress; }
  if (updates.taxExempt !== undefined) { fields.push('tax_exempt = @taxExempt'); params.taxExempt = updates.taxExempt ? 1 : 0; }
  if (updates.taxId !== undefined) { fields.push('tax_id = @taxId'); params.taxId = updates.taxId; }
  if (updates.paymentTerms !== undefined) { fields.push('payment_terms = @paymentTerms'); params.paymentTerms = updates.paymentTerms; }
  if (updates.status !== undefined) { fields.push('status = @status'); params.status = updates.status; }
  if (updates.notes !== undefined) { fields.push('notes = @notes'); params.notes = updates.notes; }

  if (fields.length === 0) return getB2BCompanyById(id);

  fields.push('updated_at = CURRENT_TIMESTAMP');
  db.prepare(`UPDATE b2b_companies SET ${fields.join(', ')} WHERE id = @id`).run(params);
  return getB2BCompanyById(id);
}

function formatB2BCompany(row) {
  return {
    id: row.id,
    companyName: row.company_name,
    slug: row.slug,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    billingAddress: row.billing_address,
    shippingAddress: row.shipping_address,
    taxExempt: !!row.tax_exempt,
    taxId: row.tax_id,
    paymentTerms: row.payment_terms,
    creditLimitCents: row.credit_limit_cents,
    status: row.status,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function deleteB2BCompany(id) {
  const existing = getB2BCompanyById(id);
  if (!existing) return { success: false, error: 'Company not found' };
  db.prepare('DELETE FROM b2b_companies WHERE id = ?').run(id);
  return { success: true, deleted: existing };
}

// --- B2B USERS ---

function createB2BUser({ companyId, email, password, name, phone, role, isPrimaryContact }) {
  const id = `b2b-user-${crypto.randomBytes(8).toString('hex')}`;
  const passwordHash = bcrypt.hashSync(password, 10);

  db.prepare(`
    INSERT INTO b2b_users (id, company_id, email, password_hash, name, phone, role, is_primary_contact)
    VALUES (@id, @companyId, @email, @passwordHash, @name, @phone, @role, @isPrimaryContact)
  `).run({
    id,
    companyId,
    email: normalizeEmail(email),
    passwordHash,
    name,
    phone: phone || null,
    role: role || 'user',
    isPrimaryContact: isPrimaryContact ? 1 : 0
  });

  return getB2BUserById(id);
}

function getB2BUserById(id) {
  const row = db.prepare(`
    SELECT b2b_users.*, b2b_companies.company_name
    FROM b2b_users
    JOIN b2b_companies ON b2b_companies.id = b2b_users.company_id
    WHERE b2b_users.id = ?
  `).get(id);
  return row ? formatB2BUser(row) : null;
}

function getB2BUserByEmail(email) {
  const row = db.prepare(`
    SELECT b2b_users.*, b2b_companies.company_name
    FROM b2b_users
    JOIN b2b_companies ON b2b_companies.id = b2b_users.company_id
    WHERE b2b_users.email = ?
  `).get(normalizeEmail(email));
  return row ? formatB2BUser(row) : null;
}

function listB2BUsers(companyId) {
  const rows = db.prepare(`
    SELECT b2b_users.*, b2b_companies.company_name
    FROM b2b_users
    JOIN b2b_companies ON b2b_companies.id = b2b_users.company_id
    WHERE b2b_users.company_id = ?
    ORDER BY b2b_users.name ASC
  `).all(companyId);
  return rows.map(formatB2BUser);
}

function updateB2BUser(id, updates) {
  const fields = [];
  const params = { id };

  if (updates.name !== undefined) { fields.push('name = @name'); params.name = updates.name; }
  if (updates.phone !== undefined) { fields.push('phone = @phone'); params.phone = updates.phone; }
  if (updates.role !== undefined) { fields.push('role = @role'); params.role = updates.role; }
  if (updates.status !== undefined) { fields.push('status = @status'); params.status = updates.status; }
  if (updates.isPrimaryContact !== undefined) { fields.push('is_primary_contact = @isPrimaryContact'); params.isPrimaryContact = updates.isPrimaryContact ? 1 : 0; }
  if (updates.password !== undefined) {
    fields.push('password_hash = @passwordHash');
    params.passwordHash = bcrypt.hashSync(updates.password, 10);
  }

  if (fields.length === 0) return getB2BUserById(id);

  fields.push('updated_at = CURRENT_TIMESTAMP');
  db.prepare(`UPDATE b2b_users SET ${fields.join(', ')} WHERE id = @id`).run(params);
  return getB2BUserById(id);
}

function deleteB2BUser(id) {
  const existing = getB2BUserById(id);
  if (!existing) return { success: false, error: 'User not found' };
  db.prepare('DELETE FROM b2b_users WHERE id = ?').run(id);
  return { success: true, deleted: existing };
}

function formatB2BUser(row) {
  return {
    id: row.id,
    companyId: row.company_id,
    companyName: row.company_name,
    email: row.email,
    name: row.name,
    phone: row.phone,
    role: row.role,
    isPrimaryContact: !!row.is_primary_contact,
    emailVerified: !!row.email_verified,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at
  };
}

// --- B2B AUTH ---

function verifyB2BCredentials(email, password) {
  const normalizedEmail = normalizeEmail(email);
  const row = db.prepare(`
    SELECT b2b_users.*, b2b_companies.company_name, b2b_companies.status as company_status
    FROM b2b_users
    JOIN b2b_companies ON b2b_companies.id = b2b_users.company_id
    WHERE b2b_users.email = ?
  `).get(normalizedEmail);

  if (!row || !row.password_hash) return null;
  if (row.status !== 'active') return null;
  if (row.company_status !== 'active') return null;

  const valid = bcrypt.compareSync(password, row.password_hash);
  if (!valid) return null;

  // Update last login
  db.prepare('UPDATE b2b_users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);

  return formatB2BUser(row);
}

function createB2BSession(userId, days = 7) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

  db.prepare(`
    INSERT INTO b2b_sessions (user_id, token, expires_at)
    VALUES (?, ?, ?)
  `).run(userId, token, expiresAt);

  return { token, expiresAt };
}

function getB2BUserByToken(token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT b2b_sessions.*, b2b_users.*, b2b_companies.company_name
    FROM b2b_sessions
    JOIN b2b_users ON b2b_users.id = b2b_sessions.user_id
    JOIN b2b_companies ON b2b_companies.id = b2b_users.company_id
    WHERE b2b_sessions.token = ?
  `).get(token);

  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    deleteB2BSession(token);
    return null;
  }

  return formatB2BUser(row);
}

function deleteB2BSession(token) {
  db.prepare('DELETE FROM b2b_sessions WHERE token = ?').run(token);
}

// --- B2B ORDERS ---

function getNextB2BOrderNumber() {
  const row = db.prepare('SELECT MAX(order_number) as max_num FROM b2b_metal_print_orders').get();
  return (row?.max_num || 10000) + 1;
}

function createB2BOrder({ companyId, userId, shippingName, shippingAddressLine1, shippingAddressLine2, shippingCity, shippingState, shippingZip, shippingCountry, shippingPhone, notes }) {
  const id = `b2b-order-${crypto.randomBytes(8).toString('hex')}`;
  const orderNumber = getNextB2BOrderNumber();

  db.prepare(`
    INSERT INTO b2b_metal_print_orders (
      id, order_number, company_id, user_id, shipping_name, shipping_address_line1, shipping_address_line2,
      shipping_city, shipping_state, shipping_zip, shipping_country, shipping_phone, notes
    ) VALUES (
      @id, @orderNumber, @companyId, @userId, @shippingName, @shippingAddressLine1, @shippingAddressLine2,
      @shippingCity, @shippingState, @shippingZip, @shippingCountry, @shippingPhone, @notes
    )
  `).run({
    id,
    orderNumber,
    companyId,
    userId,
    shippingName: shippingName || null,
    shippingAddressLine1: shippingAddressLine1 || null,
    shippingAddressLine2: shippingAddressLine2 || null,
    shippingCity: shippingCity || null,
    shippingState: shippingState || null,
    shippingZip: shippingZip || null,
    shippingCountry: shippingCountry || 'US',
    shippingPhone: shippingPhone || null,
    notes: notes || null
  });

  return getB2BOrderById(id);
}

function getB2BOrderById(id) {
  const row = db.prepare(`
    SELECT o.*, c.company_name, u.name as user_name, u.email as user_email
    FROM b2b_metal_print_orders o
    JOIN b2b_companies c ON c.id = o.company_id
    LEFT JOIN b2b_users u ON u.id = o.user_id
    WHERE o.id = ?
  `).get(id);
  return row ? formatB2BOrder(row) : null;
}

function getB2BOrderByNumber(orderNumber) {
  const row = db.prepare(`
    SELECT o.*, c.company_name, u.name as user_name, u.email as user_email
    FROM b2b_metal_print_orders o
    JOIN b2b_companies c ON c.id = o.company_id
    LEFT JOIN b2b_users u ON u.id = o.user_id
    WHERE o.order_number = ?
  `).get(orderNumber);
  return row ? formatB2BOrder(row) : null;
}

function listB2BOrders({ companyId, status, paymentStatus, limit = 50, offset = 0 } = {}) {
  const where = [];
  const params = { limit, offset };

  if (companyId) {
    where.push('o.company_id = @companyId');
    params.companyId = companyId;
  }
  if (status) {
    where.push('o.status = @status');
    params.status = status;
  }
  if (paymentStatus) {
    where.push('o.payment_status = @paymentStatus');
    params.paymentStatus = paymentStatus;
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT o.*, c.company_name, u.name as user_name, u.email as user_email,
           (SELECT COUNT(*) FROM b2b_metal_print_items WHERE order_id = o.id) as item_count
    FROM b2b_metal_print_orders o
    JOIN b2b_companies c ON c.id = o.company_id
    LEFT JOIN b2b_users u ON u.id = o.user_id
    ${clause}
    ORDER BY o.created_at DESC
    LIMIT @limit OFFSET @offset
  `).all(params);

  return rows.map(row => ({
    ...formatB2BOrder(row),
    itemCount: row.item_count
  }));
}

function listB2BProductionQueue() {
  const rows = db.prepare(`
    SELECT o.*, c.company_name, u.name as user_name, u.email as user_email,
           (SELECT COUNT(*) FROM b2b_metal_print_items WHERE order_id = o.id) as item_count
    FROM b2b_metal_print_orders o
    JOIN b2b_companies c ON c.id = o.company_id
    LEFT JOIN b2b_users u ON u.id = o.user_id
    WHERE o.payment_status = 'paid'
      AND o.status IN ('received', 'being_printed')
    ORDER BY
      CASE o.status
        WHEN 'being_printed' THEN 1
        WHEN 'received' THEN 2
      END,
      o.paid_at ASC
  `).all();

  return rows.map(row => ({
    ...formatB2BOrder(row),
    itemCount: row.item_count
  }));
}

function updateB2BOrder(id, updates) {
  const fields = [];
  const params = { id };

  if (updates.status !== undefined) { fields.push('status = @status'); params.status = updates.status; }
  if (updates.shippingName !== undefined) { fields.push('shipping_name = @shippingName'); params.shippingName = updates.shippingName; }
  if (updates.shippingAddressLine1 !== undefined) { fields.push('shipping_address_line1 = @shippingAddressLine1'); params.shippingAddressLine1 = updates.shippingAddressLine1; }
  if (updates.shippingAddressLine2 !== undefined) { fields.push('shipping_address_line2 = @shippingAddressLine2'); params.shippingAddressLine2 = updates.shippingAddressLine2; }
  if (updates.shippingCity !== undefined) { fields.push('shipping_city = @shippingCity'); params.shippingCity = updates.shippingCity; }
  if (updates.shippingState !== undefined) { fields.push('shipping_state = @shippingState'); params.shippingState = updates.shippingState; }
  if (updates.shippingZip !== undefined) { fields.push('shipping_zip = @shippingZip'); params.shippingZip = updates.shippingZip; }
  if (updates.shippingCountry !== undefined) { fields.push('shipping_country = @shippingCountry'); params.shippingCountry = updates.shippingCountry; }
  if (updates.shippingPhone !== undefined) { fields.push('shipping_phone = @shippingPhone'); params.shippingPhone = updates.shippingPhone; }
  if (updates.trackingCarrier !== undefined) { fields.push('tracking_carrier = @trackingCarrier'); params.trackingCarrier = updates.trackingCarrier; }
  if (updates.trackingNumber !== undefined) { fields.push('tracking_number = @trackingNumber'); params.trackingNumber = updates.trackingNumber; }
  if (updates.subtotalCents !== undefined) { fields.push('subtotal_cents = @subtotalCents'); params.subtotalCents = updates.subtotalCents; }
  if (updates.shippingCents !== undefined) { fields.push('shipping_cents = @shippingCents'); params.shippingCents = updates.shippingCents; }
  if (updates.taxCents !== undefined) { fields.push('tax_cents = @taxCents'); params.taxCents = updates.taxCents; }
  if (updates.totalCents !== undefined) { fields.push('total_cents = @totalCents'); params.totalCents = updates.totalCents; }
  if (updates.paymentStatus !== undefined) { fields.push('payment_status = @paymentStatus'); params.paymentStatus = updates.paymentStatus; }
  if (updates.paymentLink !== undefined) { fields.push('payment_link = @paymentLink'); params.paymentLink = updates.paymentLink; }
  if (updates.paymentLinkId !== undefined) { fields.push('payment_link_id = @paymentLinkId'); params.paymentLinkId = updates.paymentLinkId; }
  if (updates.paymentDetails !== undefined) { fields.push('payment_details = @paymentDetails'); params.paymentDetails = updates.paymentDetails; }
  if (updates.paidAt !== undefined) { fields.push('paid_at = @paidAt'); params.paidAt = updates.paidAt; }
  if (updates.notes !== undefined) { fields.push('notes = @notes'); params.notes = updates.notes; }
  if (updates.internalNotes !== undefined) { fields.push('internal_notes = @internalNotes'); params.internalNotes = updates.internalNotes; }
  if (updates.submittedAt !== undefined) { fields.push('submitted_at = @submittedAt'); params.submittedAt = updates.submittedAt; }
  if (updates.shippedAt !== undefined) { fields.push('shipped_at = @shippedAt'); params.shippedAt = updates.shippedAt; }
  if (updates.completedAt !== undefined) { fields.push('completed_at = @completedAt'); params.completedAt = updates.completedAt; }

  if (fields.length === 0) return getB2BOrderById(id);

  fields.push('updated_at = CURRENT_TIMESTAMP');
  db.prepare(`UPDATE b2b_metal_print_orders SET ${fields.join(', ')} WHERE id = @id`).run(params);
  return getB2BOrderById(id);
}

function setB2BOrderPaymentLink(id, { url, linkId }) {
  db.prepare(`
    UPDATE b2b_metal_print_orders
    SET payment_link = ?, payment_link_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(url, linkId, id);
  return getB2BOrderById(id);
}

function markB2BOrderPaid(id, paymentDetails) {
  db.prepare(`
    UPDATE b2b_metal_print_orders
    SET payment_status = 'paid', paid_at = CURRENT_TIMESTAMP, payment_details = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(JSON.stringify(paymentDetails), id);
  return getB2BOrderById(id);
}

function findB2BOrderByPaymentLinkId(linkId) {
  const row = db.prepare(`
    SELECT o.*, c.company_name, u.name as user_name, u.email as user_email
    FROM b2b_metal_print_orders o
    JOIN b2b_companies c ON c.id = o.company_id
    LEFT JOIN b2b_users u ON u.id = o.user_id
    WHERE o.payment_link_id = ?
  `).get(linkId);
  return row ? formatB2BOrder(row) : null;
}

function formatB2BOrder(row) {
  return {
    id: row.id,
    orderNumber: row.order_number,
    companyId: row.company_id,
    companyName: row.company_name,
    userId: row.user_id,
    userName: row.user_name,
    userEmail: row.user_email,
    status: row.status,
    shippingName: row.shipping_name,
    shippingAddressLine1: row.shipping_address_line1,
    shippingAddressLine2: row.shipping_address_line2,
    shippingCity: row.shipping_city,
    shippingState: row.shipping_state,
    shippingZip: row.shipping_zip,
    shippingCountry: row.shipping_country,
    shippingPhone: row.shipping_phone,
    trackingCarrier: row.tracking_carrier,
    trackingNumber: row.tracking_number,
    subtotalCents: row.subtotal_cents,
    shippingCents: row.shipping_cents,
    taxCents: row.tax_cents,
    totalCents: row.total_cents,
    paymentStatus: row.payment_status,
    paymentLink: row.payment_link,
    paymentLinkId: row.payment_link_id,
    paymentDetails: row.payment_details ? JSON.parse(row.payment_details) : null,
    paidAt: row.paid_at,
    notes: row.notes,
    internalNotes: row.internal_notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    submittedAt: row.submitted_at,
    shippedAt: row.shipped_at,
    completedAt: row.completed_at
  };
}

// --- B2B ORDER ITEMS ---

function addB2BOrderItem(orderId, { size, quantity, customDimensions, notes }) {
  const id = `b2b-item-${crypto.randomBytes(8).toString('hex')}`;
  const priceCents = getB2BWholesalePrice(size);
  const needsQuote = priceCents === null ? 1 : 0;
  const unitPrice = priceCents || 0;
  const lineTotal = unitPrice * (quantity || 1);

  db.prepare(`
    INSERT INTO b2b_metal_print_items (id, order_id, size, custom_dimensions, quantity, unit_price_cents, line_total_cents, needs_quote, notes)
    VALUES (@id, @orderId, @size, @customDimensions, @quantity, @unitPrice, @lineTotal, @needsQuote, @notes)
  `).run({
    id,
    orderId,
    size,
    customDimensions: customDimensions ? JSON.stringify(customDimensions) : null,
    quantity: quantity || 1,
    unitPrice,
    lineTotal,
    needsQuote,
    notes: notes || null
  });

  return getB2BOrderItemById(id);
}

function getB2BOrderItemById(id) {
  const row = db.prepare('SELECT * FROM b2b_metal_print_items WHERE id = ?').get(id);
  return row ? formatB2BOrderItem(row) : null;
}

function listB2BOrderItems(orderId) {
  const rows = db.prepare('SELECT * FROM b2b_metal_print_items WHERE order_id = ? ORDER BY created_at ASC').all(orderId);
  return rows.map(formatB2BOrderItem);
}

function updateB2BOrderItem(id, updates) {
  const fields = [];
  const params = { id };

  if (updates.size !== undefined) {
    fields.push('size = @size');
    params.size = updates.size;
    // Recalculate price if size changed
    const priceCents = getB2BWholesalePrice(updates.size);
    fields.push('unit_price_cents = @unitPrice');
    fields.push('needs_quote = @needsQuote');
    params.unitPrice = priceCents || 0;
    params.needsQuote = priceCents === null ? 1 : 0;
  }
  if (updates.quantity !== undefined) { fields.push('quantity = @quantity'); params.quantity = updates.quantity; }
  if (updates.customDimensions !== undefined) { fields.push('custom_dimensions = @customDimensions'); params.customDimensions = JSON.stringify(updates.customDimensions); }
  if (updates.imagePath !== undefined) { fields.push('image_path = @imagePath'); params.imagePath = updates.imagePath; }
  if (updates.imageOriginalName !== undefined) { fields.push('image_original_name = @imageOriginalName'); params.imageOriginalName = updates.imageOriginalName; }
  if (updates.imageWidth !== undefined) { fields.push('image_width = @imageWidth'); params.imageWidth = updates.imageWidth; }
  if (updates.imageHeight !== undefined) { fields.push('image_height = @imageHeight'); params.imageHeight = updates.imageHeight; }
  if (updates.uploadedAt !== undefined) { fields.push('uploaded_at = @uploadedAt'); params.uploadedAt = updates.uploadedAt; }
  if (updates.quotePriceCents !== undefined) {
    fields.push('quote_price_cents = @quotePriceCents');
    params.quotePriceCents = updates.quotePriceCents;
    fields.push('unit_price_cents = @quotePriceCents');
  }
  if (updates.quoteApproved !== undefined) { fields.push('quote_approved = @quoteApproved'); params.quoteApproved = updates.quoteApproved ? 1 : 0; }
  if (updates.notes !== undefined) { fields.push('notes = @notes'); params.notes = updates.notes; }

  if (fields.length === 0) return getB2BOrderItemById(id);

  db.prepare(`UPDATE b2b_metal_print_items SET ${fields.join(', ')} WHERE id = @id`).run(params);

  // Recalculate line total
  const item = db.prepare('SELECT * FROM b2b_metal_print_items WHERE id = ?').get(id);
  if (item) {
    const lineTotal = item.unit_price_cents * item.quantity;
    db.prepare('UPDATE b2b_metal_print_items SET line_total_cents = ? WHERE id = ?').run(lineTotal, id);
  }

  return getB2BOrderItemById(id);
}

function deleteB2BOrderItem(id) {
  const existing = getB2BOrderItemById(id);
  if (!existing) return { success: false, error: 'Item not found' };
  db.prepare('DELETE FROM b2b_metal_print_items WHERE id = ?').run(id);
  return { success: true, deleted: existing };
}

function formatB2BOrderItem(row) {
  return {
    id: row.id,
    orderId: row.order_id,
    size: row.size,
    customDimensions: row.custom_dimensions ? JSON.parse(row.custom_dimensions) : null,
    quantity: row.quantity,
    unitPriceCents: row.unit_price_cents,
    lineTotalCents: row.line_total_cents,
    imagePath: row.image_path,
    imageOriginalName: row.image_original_name,
    imageWidth: row.image_width,
    imageHeight: row.image_height,
    uploadedAt: row.uploaded_at,
    needsQuote: !!row.needs_quote,
    quotePriceCents: row.quote_price_cents,
    quoteApproved: !!row.quote_approved,
    notes: row.notes,
    createdAt: row.created_at
  };
}

// Calculate order totals
function calculateB2BOrderTotals(orderId) {
  const items = listB2BOrderItems(orderId);
  let subtotal = 0;

  for (const item of items) {
    subtotal += item.lineTotalCents;
  }

  // Flat rate shipping for B2B
  const shippingCents = items.length > 0 ? 1000 : 0; // $10 flat rate
  const taxCents = 0; // B2B typically tax-exempt
  const totalCents = subtotal + shippingCents + taxCents;

  updateB2BOrder(orderId, {
    subtotalCents: subtotal,
    shippingCents,
    taxCents,
    totalCents
  });

  return { subtotalCents: subtotal, shippingCents, taxCents, totalCents };
}

// ============================================================================
// STL CATALOG (3D Model Library for Slicer)
// ============================================================================

function createStlCatalogItem(item) {
  const ins = db.prepare(`
    INSERT INTO stl_catalog (name, category, stl_path, thumbnail_path,
      default_quality, default_strength, default_material, default_texture, default_supports,
      notes, file_size, triangle_count, dim_x, dim_y, dim_z, est_weight_g, est_time_min)
    VALUES (@name, @category, @stl_path, @thumbnail_path,
      @default_quality, @default_strength, @default_material, @default_texture, @default_supports,
      @notes, @file_size, @triangle_count, @dim_x, @dim_y, @dim_z, @est_weight_g, @est_time_min)
  `);
  const info = ins.run({
    name: item.name || 'Unnamed',
    category: item.category || null,
    stl_path: item.stl_path,
    thumbnail_path: item.thumbnail_path || null,
    default_quality: item.default_quality || 'standard',
    default_strength: item.default_strength || 'normal',
    default_material: item.default_material || 'pla',
    default_texture: item.default_texture || 'smooth',
    default_supports: item.default_supports || 'none',
    notes: item.notes || null,
    file_size: item.file_size || null,
    triangle_count: item.triangle_count || null,
    dim_x: item.dim_x || null,
    dim_y: item.dim_y || null,
    dim_z: item.dim_z || null,
    est_weight_g: item.est_weight_g || null,
    est_time_min: item.est_time_min || null
  });
  return getStlCatalogItem(info.lastInsertRowid);
}

function getStlCatalogItem(id) {
  return db.prepare('SELECT * FROM stl_catalog WHERE id = ?').get(id) || null;
}

function listStlCatalog({ category, search } = {}) {
  const clauses = [];
  const params = {};
  if (category) {
    clauses.push('category = @category');
    params.category = category;
  }
  if (search) {
    clauses.push('(name LIKE @q OR category LIKE @q OR notes LIKE @q)');
    params.q = `%${search}%`;
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM stl_catalog ${where} ORDER BY name COLLATE NOCASE`).all(params);
}

function listStlCatalogCategories() {
  return db.prepare('SELECT DISTINCT category FROM stl_catalog WHERE category IS NOT NULL ORDER BY category').all()
    .map(r => r.category);
}

function updateStlCatalogItem(id, updates) {
  const allowed = ['name', 'category', 'stl_path', 'thumbnail_path',
    'default_quality', 'default_strength', 'default_material', 'default_texture', 'default_supports',
    'notes', 'file_size', 'triangle_count', 'dim_x', 'dim_y', 'dim_z', 'est_weight_g', 'est_time_min'];
  const set = [];
  const params = { id };
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      set.push(`${key} = @${key}`);
      params[key] = updates[key];
    }
  }
  if (!set.length) return getStlCatalogItem(id);
  db.prepare(`UPDATE stl_catalog SET ${set.join(', ')} WHERE id = @id`).run(params);
  return getStlCatalogItem(id);
}

function deleteStlCatalogItem(id) {
  // Delete associated G-code cache entries
  db.prepare('DELETE FROM gcode_cache WHERE stl_catalog_id = ?').run(id);
  return db.prepare('DELETE FROM stl_catalog WHERE id = ?').run(id);
}

// ============================================================================
// G-CODE CACHE (Sliced G-code with settings metadata)
// ============================================================================

function getGcodeCache(id) {
  return db.prepare('SELECT * FROM gcode_cache WHERE id = ?').get(id) || null;
}

function listGcodeCacheForStl(stlCatalogId) {
  return db.prepare(`
    SELECT gc.*, sc.name AS stl_name
    FROM gcode_cache gc
    LEFT JOIN stl_catalog sc ON sc.id = gc.stl_catalog_id
    WHERE gc.stl_catalog_id = ?
    ORDER BY gc.sliced_at DESC
  `).all(stlCatalogId);
}

function listAllGcodeCache() {
  return db.prepare(`
    SELECT gc.*, sc.name AS stl_name
    FROM gcode_cache gc
    LEFT JOIN stl_catalog sc ON sc.id = gc.stl_catalog_id
    ORDER BY gc.sliced_at DESC
  `).all();
}

function deleteGcodeCache(id) {
  return db.prepare('DELETE FROM gcode_cache WHERE id = ?').run(id);
}

function clearAllGcodeCache() {
  return db.prepare('DELETE FROM gcode_cache').run();
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
  // SKU Catalog - POS System
  calculateStickerPrice,
  generateSkuCode,
  // SKU Designs
  createSkuDesign,
  updateSkuDesign,
  deleteSkuDesign,
  getSkuDesignById,
  getSkuDesignBySlug,
  listSkuDesigns,
  // SKU Variants
  createSkuVariant,
  updateSkuVariant,
  deleteSkuVariant,
  getSkuVariantById,
  getSkuVariantBySku,
  listSkuVariants,
  // Cart Sessions
  createCartSession,
  updateCartSession,
  getCartSessionById,
  getActiveCartSession,
  listCartSessions,
  // Cart Items
  addCartItem,
  updateCartItem,
  removeCartItem,
  getCartItemById,
  listCartItems,
  clearCartItems,
  // SKU Scans
  recordSkuScan,
  listSkuScans,
  // QR Product Catalog
  createQrProduct,
  updateQrProduct,
  deleteQrProduct,
  getQrProductById,
  listQrProducts,
  listQrProductCategories,
  // Expose database instance for modules that need direct access
  getDb: () => db,
  // Database backup functions
  createBackup,
  listBackups,
  restoreFromBackup,
  BACKUP_DIR,
  // B2B Metal Prints Portal
  getB2BWholesalePrice,
  // B2B Companies
  createB2BCompany,
  getB2BCompanyById,
  getB2BCompanyBySlug,
  listB2BCompanies,
  updateB2BCompany,
  deleteB2BCompany,
  // B2B Users
  createB2BUser,
  getB2BUserById,
  getB2BUserByEmail,
  listB2BUsers,
  updateB2BUser,
  deleteB2BUser,
  // B2B Auth
  verifyB2BCredentials,
  createB2BSession,
  getB2BUserByToken,
  deleteB2BSession,
  // B2B Orders
  createB2BOrder,
  getB2BOrderById,
  getB2BOrderByNumber,
  listB2BOrders,
  listB2BProductionQueue,
  updateB2BOrder,
  setB2BOrderPaymentLink,
  markB2BOrderPaid,
  findB2BOrderByPaymentLinkId,
  // B2B Order Items
  addB2BOrderItem,
  getB2BOrderItemById,
  listB2BOrderItems,
  updateB2BOrderItem,
  deleteB2BOrderItem,
  calculateB2BOrderTotals,
  // STL Catalog (3D Slicer)
  createStlCatalogItem,
  getStlCatalogItem,
  listStlCatalog,
  listStlCatalogCategories,
  updateStlCatalogItem,
  deleteStlCatalogItem,
  // G-code Cache
  getGcodeCache,
  listGcodeCacheForStl,
  listAllGcodeCache,
  deleteGcodeCache,
  clearAllGcodeCache
};
