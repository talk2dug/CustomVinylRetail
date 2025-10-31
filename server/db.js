const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const APP_ROOT = path.resolve(__dirname, '..');
const LIBRARY_ROOT = process.env.LIBRARY_ROOT
  ? path.resolve(process.env.LIBRARY_ROOT)
  : APP_ROOT;
const DATA_DIR = path.join(LIBRARY_ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'store.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

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

  ensureColumn('customers', 'email_verified', 'INTEGER DEFAULT 0');
  ensureColumn('customers', 'phone', 'TEXT');
  ensureColumn('customers', 'address', 'TEXT');
  ensureColumn('customers', 'password_hash', 'TEXT');
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

  db.exec(`
    CREATE TABLE IF NOT EXISTS inventory_items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      material TEXT,
      color TEXT,
      size TEXT,
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

  seedVinylInventory();
}

function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase();
}

function normalizePhone(phone) {
  return String(phone || '').replace(/\D+/g, '');
}

function formatCustomer(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    address: row.address,
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

function createCustomerAccount({ name, email, phone, address, password }) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail || !password) {
    throw new Error('Email and password are required.');
  }

  const hash = bcrypt.hashSync(password, 12);
  const normalizedPhone = normalizePhone(phone);

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
             updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(name || existing.name, normalizedPhone, address || '', hash, existing.id);
    const updated = db.prepare('SELECT * FROM customers WHERE id = ?').get(existing.id);
    updated.remember_token = ensureRememberToken(updated.id);
    return formatCustomer(updated);
  }

  const info = db
    .prepare(
      `INSERT INTO customers (name, email, phone, address, password_hash)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(name || '', normalizedEmail, normalizedPhone, address || '', hash);
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
      saved_at, paid, internal_notes, bytes_written
    ) VALUES (
      @id, @orderNumber, @customerId, @designId, @designName, @productType, @category, @size, @color,
      @background, @quantity, @notes, @textLayers, @previewFile, @metadataPath,
      @sourceFiles, @apparelItems, @inventoryUsage, @pricing, @paymentLink, @paymentLinkId,
      @paymentStatus, @paymentDetails, NULL, NULL, NULL,
      @savedAt, @paid, @internalNotes, @bytesWritten
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
    bytesWritten
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
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function mapInventoryRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    material: row.material || null,
    color: row.color || null,
    size: row.size || null,
    itemUrl: row.item_url || null,
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
  size = null,
  itemUrl = null,
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
         id, name, material, color, size, item_url, unit_cost_cents, unit, quantity, notes, created_at, updated_at
       ) VALUES (
         @id, @name, @material, @color, @size, @itemUrl, @unitCostCents, @unit, 0, @notes, @now, @now
       )`
    ).run({
      id: itemId,
      name,
      material: normalizedMaterial,
      color: normalizedColor,
      size: normalizedSize,
      itemUrl: itemUrl || null,
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
              unit_cost_cents = COALESCE(@unitCostCents, unit_cost_cents),
              unit = COALESCE(@unit, unit),
              notes = COALESCE(@notes, notes),
              updated_at = @updatedAt
        WHERE id = @id`
    ).run({
      id: itemId,
      itemUrl: itemUrl || null,
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
    size,
    itemUrl,
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
    size: size ? String(size).trim() : null,
    itemUrl: itemUrl === undefined ? undefined : itemUrl || null,
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
  if (normalized.size !== null) {
    fields.push('size = @size');
    params.size = normalized.size;
  }
  if (normalized.itemUrl !== undefined) {
    fields.push('item_url = @itemUrl');
    params.itemUrl = normalized.itemUrl;
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
    customerResponseAt: 'customer_response_at'
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

module.exports = {
  initDatabase,
  normalizeEmail,
  normalizePhone,
  findCustomerByEmail,
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
  getNextOrderNumber,
  getNextQuoteNumber,
  setOrderPaymentLink,
  markOrderPaid,
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
  recordOrderInventoryUsage
};
