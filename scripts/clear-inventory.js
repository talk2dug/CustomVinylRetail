/**
 * Clear all inventory items from the database
 * Run this on the production server to clear inventory
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const APP_ROOT = path.resolve(__dirname, '..');
const LIBRARY_ROOT = process.env.LIBRARY_ROOT
  ? path.resolve(process.env.LIBRARY_ROOT)
  : path.join(APP_ROOT, 'web', 'library');
const DATA_DIR = path.join(LIBRARY_ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'store.db');

console.log('Database path:', DB_PATH);

if (!fs.existsSync(DB_PATH)) {
  console.error('Database not found at:', DB_PATH);
  process.exit(1);
}

const db = new Database(DB_PATH);

try {
  // Check current count
  const beforeCount = db.prepare('SELECT COUNT(*) as count FROM inventory_items').get();
  console.log('Inventory items before:', beforeCount.count);

  if (beforeCount.count === 0) {
    console.log('Inventory is already empty.');
    process.exit(0);
  }

  // Show sample items
  console.log('\nSample items to be deleted:');
  const sampleItems = db.prepare('SELECT name, material FROM inventory_items LIMIT 5').all();
  sampleItems.forEach(item => {
    console.log(`  - ${item.name} (${item.material})`);
  });

  // Clear inventory
  console.log('\nClearing inventory...');
  const result = db.prepare('DELETE FROM inventory_items').run();
  console.log('Deleted rows:', result.changes);

  // Verify
  const afterCount = db.prepare('SELECT COUNT(*) as count FROM inventory_items').get();
  console.log('Inventory items after:', afterCount.count);

  if (afterCount.count === 0) {
    console.log('\n✓ Inventory successfully cleared!');
  } else {
    console.log('\n⚠ Warning: Some items may still remain');
  }

} catch (error) {
  console.error('Error:', error.message);
  process.exit(1);
} finally {
  db.close();
}
