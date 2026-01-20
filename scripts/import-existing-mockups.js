/**
 * Import existing mockup files from filesystem into the database
 * This one-time script scans for mockup images and creates database records
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
let sharp = null;
try {
  sharp = require('sharp');
} catch (e) {
  console.warn('[Import] Sharp not available, dimensions will be null');
}

// Load environment
const ENV_PATH = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(ENV_PATH)) {
  require('dotenv').config({ path: ENV_PATH });
}

// Direct database connection (bypassing db.js module cache issues)
const APP_ROOT_DIR = path.resolve(__dirname, '..');
const dbPath = path.join(APP_ROOT_DIR, 'data', 'app.db');
console.log('[Import] Database path:', dbPath);
const sqlite = new Database(dbPath);

// Simple direct insert function
function createMockupRecord(data) {
  const id = `mockup_${crypto.randomBytes(8).toString('hex')}`;
  const stmt = sqlite.prepare(`
    INSERT INTO custom_art_mockups
    (id, title, filename, file_path, url, product_id, artwork_id, room_id, campaign_slug, material_id, mockup_type, width, height, file_size, tags, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    id,
    data.title,
    data.filename,
    data.filePath,
    data.url,
    data.productId,
    data.artworkId,
    data.roomId,
    data.campaignSlug,
    data.materialId,
    data.mockupType,
    data.width,
    data.height,
    data.fileSize,
    data.tags,
    data.notes
  );
  return id;
}

function listMockups() {
  return sqlite.prepare('SELECT filename FROM custom_art_mockups').all();
}

const APP_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(APP_ROOT, 'data');
const WEB_DIR = path.join(APP_ROOT, 'web');
const CAMPAIGNS_DIR = path.join(DATA_DIR, 'campaigns');

// Directories where mockups might exist
const MOCKUP_DIRS = [
  { path: path.join(WEB_DIR, 'images', 'custom-art'), type: 'product' },
  { path: path.join(WEB_DIR, 'images', 'custom-art', 'mockups'), type: 'product' },
  { path: path.join(WEB_DIR, 'images', 'custom-art', 'tiled'), type: 'tiled' },
  { path: path.join(CAMPAIGNS_DIR, 'mockups'), type: 'campaign' }
];

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

async function getImageDimensions(filePath) {
  if (!sharp) return { width: null, height: null };
  try {
    const meta = await sharp(filePath).metadata();
    return { width: meta.width, height: meta.height };
  } catch (e) {
    return { width: null, height: null };
  }
}

function parseFilenameForMetadata(filename, mockupType) {
  const result = {
    productId: null,
    campaignSlug: null,
    title: filename.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' ')
  };

  // Try to extract product ID from filename like "mockup-prod_xxx-timestamp.jpg"
  const productMatch = filename.match(/mockup-([^-]+)-\d+\./);
  if (productMatch && productMatch[1] !== 'general') {
    result.productId = productMatch[1];
    result.title = `Product ${productMatch[1]} Mockup`;
  }

  // Try to extract campaign slug from filename like "campaign-mockup-slug-timestamp.jpg"
  const campaignMatch = filename.match(/campaign-mockup-([^-]+)-\d+\./);
  if (campaignMatch) {
    result.campaignSlug = campaignMatch[1];
    result.title = `${campaignMatch[1]} Campaign Mockup`;
  }

  return result;
}

async function importMockupsFromDir(dirPath, mockupType) {
  if (!fs.existsSync(dirPath)) {
    console.log(`[Import] Directory not found: ${dirPath}`);
    return { imported: 0, skipped: 0 };
  }

  const files = fs.readdirSync(dirPath);
  let imported = 0;
  let skipped = 0;

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) continue;

    const filePath = path.join(dirPath, file);
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) continue;

    // Check if this file already has a database record
    const existing = listMockups();
    const alreadyExists = existing.some(m => m.filename === file);

    if (alreadyExists) {
      console.log(`[Import] Skipping (already exists): ${file}`);
      skipped++;
      continue;
    }

    // Get image dimensions
    const { width, height } = await getImageDimensions(filePath);

    // Parse filename for metadata
    const metadata = parseFilenameForMetadata(file, mockupType);

    // Build URL
    let url = '';
    if (mockupType === 'campaign') {
      url = `/uploads/campaigns/mockups/${file}`;
    } else if (mockupType === 'tiled') {
      url = `${process.env.STORE_BASE_URL || 'https://store.swayzecustomvinyl.com'}/images/custom-art/tiled/${file}`;
    } else {
      url = `${process.env.STORE_BASE_URL || 'https://store.swayzecustomvinyl.com'}/images/custom-art/${file}`;
    }

    try {
      const mockupId = createMockupRecord({
        title: metadata.title,
        filename: file,
        filePath: filePath,
        url: url,
        productId: metadata.productId,
        artworkId: null,
        roomId: null,
        campaignSlug: metadata.campaignSlug,
        materialId: null,
        mockupType: mockupType,
        width,
        height,
        fileSize: stat.size,
        tags: null,
        notes: 'Imported from existing filesystem'
      });

      console.log(`[Import] Created: ${mockupId} - ${file} (${mockupType})`);
      imported++;
    } catch (e) {
      console.error(`[Import] Error creating record for ${file}:`, e.message);
      skipped++;
    }
  }

  return { imported, skipped };
}

async function main() {
  console.log('[Import] Starting mockup import...');
  console.log('[Import] Directories to scan:', MOCKUP_DIRS.map(d => d.path));

  let totalImported = 0;
  let totalSkipped = 0;

  for (const dir of MOCKUP_DIRS) {
    console.log(`\n[Import] Scanning ${dir.path} (type: ${dir.type})`);
    const result = await importMockupsFromDir(dir.path, dir.type);
    totalImported += result.imported;
    totalSkipped += result.skipped;
  }

  console.log(`\n[Import] Complete!`);
  console.log(`[Import] Imported: ${totalImported}`);
  console.log(`[Import] Skipped: ${totalSkipped}`);
}

main().catch(e => {
  console.error('[Import] Fatal error:', e);
  process.exit(1);
});
