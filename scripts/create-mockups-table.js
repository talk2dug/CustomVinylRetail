/**
 * Create the custom_art_mockups table (without FK constraints for simpler migration)
 */
const Database = require('better-sqlite3');
const path = require('path');
const dbPath = path.join(__dirname, '..', 'data', 'app.db');
const db = new Database(dbPath);

// Check existing tables
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Existing tables:', tables.map(t => t.name).join(', '));

// Drop and recreate to remove FK constraints
db.exec(`DROP TABLE IF EXISTS custom_art_mockups`);
console.log('Dropped old table');

// Create table without foreign key constraints
db.exec(`
  CREATE TABLE custom_art_mockups (
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

db.exec(`CREATE INDEX IF NOT EXISTS idx_custom_art_mockups_product ON custom_art_mockups(product_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_custom_art_mockups_artwork ON custom_art_mockups(artwork_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_custom_art_mockups_campaign ON custom_art_mockups(campaign_slug)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_custom_art_mockups_type ON custom_art_mockups(mockup_type)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_custom_art_mockups_active ON custom_art_mockups(active)`);

console.log('custom_art_mockups table created!');

// Verify columns
const cols = db.prepare('PRAGMA table_info(custom_art_mockups)').all();
console.log('Columns:', cols.map(c => c.name).join(', '));

db.close();
console.log('Done!');
