const fs = require('fs');
const path = require('path');

const ENV_PATH = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(ENV_PATH)) {
  require('dotenv').config({ path: ENV_PATH });
}

const APP_ROOT = path.resolve(__dirname, '..');
const LIBRARY_ROOT = process.env.LIBRARY_ROOT
  ? path.resolve(process.env.LIBRARY_ROOT)
  : path.join(APP_ROOT, 'web', 'library');
// Decal Creator Icons library (non-apparel ready items)
const DECAL_ICONS_ROOT = process.env.DECAL_ICONS_ROOT
  ? path.resolve(process.env.DECAL_ICONS_ROOT)
  : path.join(APP_ROOT, 'dbFiles', 'DecalCreatorIcons');
const WEB_DIR = path.join(APP_ROOT, 'web');
const ASSET_BASE_URL = (process.env.ASSET_BASE_URL || '').trim();
const OUTPUT_FILE = path.join(WEB_DIR, 'catalog.json');
const DECAL_ICONS_OUTPUT_FILE = path.join(WEB_DIR, 'catalog-decal-icons.json');

function toFullAssetUrl(filePath, libraryRoot, webSubPath) {
  if (!filePath) return null;
  const relative = path.relative(libraryRoot, filePath);
  const webPath = relative.split(path.sep).join('/');
  return `${ASSET_BASE_URL}/${webSubPath}/${webPath}`;
}

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const SOURCE_EXTENSION_MAP = new Map([
  ['.ai', 'ai'],
  ['.eps', 'eps'],
  ['.pdf', 'pdf'],
  ['.svg', 'svg']
]);
const SKIP_DIRS = new Set(['web', 'scripts', 'node_modules', 'data', 'saved-designs']);

function isDirectory(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch (error) {
    return false;
  }
}

function formatDisplayName(rawName) {
  return rawName
    .replace(/\.[^/.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function collectFilesRecursive(dirPath) {
  const collected = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      collected.push(...collectFilesRecursive(entryPath));
    } else if (entry.isFile()) {
      collected.push(entryPath);
    }
  }

  return collected;
}

function isJunkFile(filePath) {
  const name = path.basename(filePath);
  const lower = name.toLowerCase();
  // Ignore macOS resource forks and common junk files
  if (name.startsWith('._')) return true; // AppleDouble
  if (name === '.ds_store' || lower === '.ds_store') return true;
  if (lower === 'thumbs.db') return true;
  return false;
}

function ensureWebDir() {
  fs.mkdirSync(WEB_DIR, { recursive: true });
}

/**
 * Build a catalog from a given library root directory
 * @param {Object} options - Build options
 * @param {string} options.libraryRoot - Root directory containing category folders
 * @param {string} options.outputFile - Output JSON file path
 * @param {string} options.webSubPath - Web-relative path for asset URLs (e.g., 'web/library' or 'dbFiles/DecalCreatorIcons')
 * @param {string} options.catalogName - Display name for logging
 */
async function buildCatalogFromRoot({ libraryRoot, outputFile, webSubPath, catalogName }) {
  ensureWebDir();

  // Check if library root exists
  if (!fs.existsSync(libraryRoot)) {
    console.warn(`${catalogName}: Library root does not exist: ${libraryRoot}`);
    return { categories: [], count: 0 };
  }

  // Load existing catalog to preserve metadata (like autoDescription)
  let existingCatalog = null;
  try {
    if (fs.existsSync(outputFile)) {
      const existing = fs.readFileSync(outputFile, 'utf8');
      existingCatalog = JSON.parse(existing);
      console.log(`${catalogName}: Loaded existing catalog to preserve metadata...`);
    }
  } catch (err) {
    console.warn(`${catalogName}: Could not load existing catalog, starting fresh:`, err.message);
  }

  const categories = [];
  const rootEntries = fs.readdirSync(libraryRoot, { withFileTypes: true });
  const designQueue = [];

  for (const entry of rootEntries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    if (SKIP_DIRS.has(entry.name)) continue;

    const categoryPath = path.join(libraryRoot, entry.name);
    if (!isDirectory(categoryPath)) continue;

    const files = collectFilesRecursive(categoryPath);
    const designsByKey = new Map();

    for (const filePath of files) {
      if (isJunkFile(filePath)) continue;
      const ext = path.extname(filePath).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(ext)) continue;

      const baseName = formatDisplayName(path.basename(filePath, ext));
      const key = slugify(baseName) || slugify(path.basename(filePath));
      const relativePath = ASSET_BASE_URL
        ? toFullAssetUrl(filePath, libraryRoot, webSubPath)
        : path
            .relative(WEB_DIR, filePath)
            .split(path.sep)
            .join('/');

      if (!designsByKey.has(key)) {
        // Check if this design exists in the old catalog with metadata
        let preservedAutoDescription = '';
        if (existingCatalog && existingCatalog.categories) {
          const existingCategory = existingCatalog.categories.find(
            cat => cat.slug === slugify(entry.name)
          );
          if (existingCategory && existingCategory.designs) {
            const existingDesign = existingCategory.designs.find(d => d.id === key);
            if (existingDesign && existingDesign.autoDescription) {
              preservedAutoDescription = existingDesign.autoDescription;
            }
          }
        }

        const designObj = {
          id: key,
          name: baseName,
          image: relativePath,
          sources: {},
          autoDescription: preservedAutoDescription,
          __sourcePath: filePath,
          __folderName: entry.name
        };
        designsByKey.set(key, designObj);
        designQueue.push({
          design: designObj,
          imagePath: filePath,
          folderName: entry.name,
          fileName: path.basename(filePath, ext)
        });
      } else if (!designsByKey.get(key).image) {
        designsByKey.get(key).image = relativePath;
      }
    }

    if (!designsByKey.size) continue;

    // Attempt to attach matching source files (AI, EPS, etc.)
    for (const filePath of files) {
      if (isJunkFile(filePath)) continue;
      const ext = path.extname(filePath).toLowerCase();
      if (!SOURCE_EXTENSION_MAP.has(ext)) continue;

      const baseName = formatDisplayName(path.basename(filePath, ext));
      const key = slugify(baseName) || slugify(path.basename(filePath));
      const design = designsByKey.get(key);
      if (!design) continue;

      const relativePath = ASSET_BASE_URL
        ? toFullAssetUrl(filePath, libraryRoot, webSubPath)
        : path
            .relative(WEB_DIR, filePath)
            .split(path.sep)
            .join('/');

      design.sources[SOURCE_EXTENSION_MAP.get(ext)] = relativePath;
    }

    const category = {
      name: formatDisplayName(entry.name),
      slug: slugify(entry.name),
      designs: Array.from(designsByKey.values()).sort((a, b) =>
        a.name.localeCompare(b.name)
      )
    };

    categories.push(category);
  }

  categories.sort((a, b) => a.name.localeCompare(b.name));

  const catalog = {
    generatedAt: new Date().toISOString(),
    assetRoot: ASSET_BASE_URL ? '' : '.',
    categories
  };

  // Clean up temporary fields
  // Note: AI metadata generation is now done on-demand via print-station
  // Existing autoDescription values are preserved during catalog rebuild
  designQueue.forEach((item) => {
    // Ensure autoDescription exists (empty string for new designs, preserved for existing)
    if (item.design.autoDescription === undefined || item.design.autoDescription === null) {
      item.design.autoDescription = '';
    }
    delete item.design.__sourcePath;
    delete item.design.__folderName;
  });


  fs.writeFileSync(outputFile, JSON.stringify(catalog, null, 2), 'utf8');
  const totalDesigns = categories.reduce((sum, cat) => sum + cat.designs.length, 0);
  console.log(`${catalogName}: Generated with ${categories.length} categories, ${totalDesigns} designs.`);
  return { categories: categories.length, designs: totalDesigns };
}

// Google Drive Graphics directory
const GDRIVE_GRAPHICS_DIR = '/mnt/gdrive/Side Hustle Library/Graphics';

/**
 * Build catalog entries from Google Drive Graphics folder.
 * Returns categories array compatible with catalog.json format.
 * Images are served via /api/sticker-catalog/gdrive-image/ endpoint.
 */
function buildGdriveGraphicsCategories() {
  if (!fs.existsSync(GDRIVE_GRAPHICS_DIR)) {
    console.log('Google Drive Graphics: Mount not available, skipping');
    return [];
  }

  const categories = [];
  const topEntries = fs.readdirSync(GDRIVE_GRAPHICS_DIR, { withFileTypes: true });
  let totalDesigns = 0;

  for (const entry of topEntries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;

    const catName = entry.name;
    const catPath = path.join(GDRIVE_GRAPHICS_DIR, catName);
    console.log(`Google Drive Graphics: Scanning ${catName}...`);

    const files = collectFilesRecursive(catPath);
    const designsByKey = new Map();

    for (const filePath of files) {
      if (isJunkFile(filePath)) continue;
      const ext = path.extname(filePath).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(ext)) continue;

      const baseName = formatDisplayName(path.basename(filePath, ext));
      const key = slugify(baseName) || slugify(path.basename(filePath));
      const relativeToGdrive = path.relative(GDRIVE_GRAPHICS_DIR, filePath).split(path.sep).join('/');

      if (!designsByKey.has(key)) {
        designsByKey.set(key, {
          id: key,
          name: baseName,
          image: `/api/sticker-catalog/gdrive-image/${encodeURIComponent(relativeToGdrive)}`,
          sources: {},
          autoDescription: ''
        });
      }

      // Attach source files (SVG, AI, EPS, etc.)
      if (SOURCE_EXTENSION_MAP.has(ext)) {
        const design = designsByKey.get(key);
        if (design) {
          design.sources[SOURCE_EXTENSION_MAP.get(ext)] = `/api/sticker-catalog/gdrive-image/${encodeURIComponent(relativeToGdrive)}`;
        }
      }
    }

    if (designsByKey.size > 0) {
      categories.push({
        name: `GDrive: ${formatDisplayName(catName)}`,
        slug: `gdrive-${slugify(catName)}`,
        designs: Array.from(designsByKey.values()).sort((a, b) => a.name.localeCompare(b.name))
      });
      totalDesigns += designsByKey.size;
      console.log(`Google Drive Graphics:   ${catName}: ${designsByKey.size} designs`);
    }
  }

  console.log(`Google Drive Graphics: ${totalDesigns} designs across ${categories.length} categories`);
  return categories;
}

async function buildAllCatalogs() {
  const includeGdrive = process.argv.includes('--include-gdrive');
  console.log('=== Building Catalogs ===\n');

  // Build Apparel Ready catalog (main library)
  const apparelResult = await buildCatalogFromRoot({
    libraryRoot: LIBRARY_ROOT,
    outputFile: OUTPUT_FILE,
    webSubPath: 'library',
    catalogName: 'Apparel Ready'
  });

  // Preserve existing Google Drive categories from the old catalog
  // (only re-scan Google Drive when explicitly requested with --include-gdrive)
  try {
    const catalogData = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
    if (includeGdrive) {
      console.log('\nGoogle Drive scan requested (--include-gdrive)...');
      const gdriveCategories = buildGdriveGraphicsCategories();
      // Remove old gdrive categories, add fresh ones
      catalogData.categories = (catalogData.categories || []).filter(c => !c.slug || !c.slug.startsWith('gdrive-'));
      if (gdriveCategories.length > 0) {
        catalogData.categories.push(...gdriveCategories);
        const gdriveDesigns = gdriveCategories.reduce((sum, c) => sum + c.designs.length, 0);
        console.log(`Apparel Ready: Added ${gdriveCategories.length} Google Drive categories (${gdriveDesigns} designs)`);
      }
      fs.writeFileSync(OUTPUT_FILE, JSON.stringify(catalogData, null, 2), 'utf8');
    } else {
      // Preserve any existing gdrive categories from the previous catalog
      let existingGdrive = [];
      try {
        // Read the catalog we just wrote — it won't have gdrive categories
        // Try to recover them from a backup or the previously loaded catalog
        const backupPath = OUTPUT_FILE + '.bak';
        if (fs.existsSync(backupPath)) {
          const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
          existingGdrive = (backup.categories || []).filter(c => c.slug && c.slug.startsWith('gdrive-'));
        }
      } catch (_) {}
      if (existingGdrive.length > 0) {
        catalogData.categories.push(...existingGdrive);
        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(catalogData, null, 2), 'utf8');
        console.log(`Apparel Ready: Preserved ${existingGdrive.length} existing Google Drive categories`);
      }
    }
  } catch (err) {
    console.error('Google Drive categories handling failed:', err.message);
  }

  // Build Decal Creator Icons catalog
  const decalResult = await buildCatalogFromRoot({
    libraryRoot: DECAL_ICONS_ROOT,
    outputFile: DECAL_ICONS_OUTPUT_FILE,
    webSubPath: 'dbFiles/DecalCreatorIcons',
    catalogName: 'Decal Creator Icons'
  });

  console.log('\n=== Summary ===');
  console.log(`Apparel Ready: ${apparelResult.categories} categories, ${apparelResult.designs} designs`);
  console.log(`Decal Creator Icons: ${decalResult.categories} categories, ${decalResult.designs} designs`);
}

buildAllCatalogs().catch((error) => {
  console.error('Catalog generation failed:', error);
  process.exit(1);
});
