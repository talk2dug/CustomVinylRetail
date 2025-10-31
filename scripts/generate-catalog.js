const path = require('path');
const fs = require('fs');

const ENV_PATH = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(ENV_PATH)) {
  require('dotenv').config({ path: ENV_PATH });
}

const APP_ROOT = path.resolve(__dirname, '..');
const LIBRARY_ROOT = process.env.LIBRARY_ROOT
  ? path.resolve(process.env.LIBRARY_ROOT)
  : APP_ROOT;
const LIBRARY_WEB_DIR = path.join(LIBRARY_ROOT, 'web');
const WEB_DIR = fs.existsSync(LIBRARY_WEB_DIR) ? LIBRARY_WEB_DIR : path.join(APP_ROOT, 'web');
const ASSET_BASE_URL = (process.env.ASSET_BASE_URL || '').trim();
const OUTPUT_FILE = path.join(WEB_DIR, 'catalog.json');

function toApiLibraryPath(filePath) {
  if (!filePath) return null;
  const relative = path.relative(LIBRARY_ROOT, filePath);
  const segments = relative.split(path.sep).filter(Boolean);
  const encoded = segments.map((segment) => encodeURIComponent(segment));
  return `/api/library/${encoded.join('/')}`;
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

function ensureWebDir() {
  fs.mkdirSync(WEB_DIR, { recursive: true });
}

function buildCatalog() {
  ensureWebDir();
  const categories = [];
  const rootEntries = fs.readdirSync(LIBRARY_ROOT, { withFileTypes: true });

  for (const entry of rootEntries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    if (SKIP_DIRS.has(entry.name)) continue;

    const categoryPath = path.join(LIBRARY_ROOT, entry.name);
    if (!isDirectory(categoryPath)) continue;

    const files = collectFilesRecursive(categoryPath);
    const designsByKey = new Map();

    for (const filePath of files) {
      const ext = path.extname(filePath).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(ext)) continue;

      const baseName = formatDisplayName(path.basename(filePath, ext));
      const key = slugify(baseName) || slugify(path.basename(filePath));
      const relativePath = ASSET_BASE_URL
        ? toApiLibraryPath(filePath)
        : path
            .relative(WEB_DIR, filePath)
            .split(path.sep)
            .join('/');

      if (!designsByKey.has(key)) {
        designsByKey.set(key, {
          id: key,
          name: baseName,
          image: relativePath,
          sources: {}
        });
      } else if (!designsByKey.get(key).image) {
        designsByKey.get(key).image = relativePath;
      }
    }

    if (!designsByKey.size) continue;

    // Attempt to attach matching source files (AI, EPS, etc.)
    for (const filePath of files) {
      const ext = path.extname(filePath).toLowerCase();
      if (!SOURCE_EXTENSION_MAP.has(ext)) continue;

      const baseName = formatDisplayName(path.basename(filePath, ext));
      const key = slugify(baseName) || slugify(path.basename(filePath));
      const design = designsByKey.get(key);
      if (!design) continue;

      const relativePath = ASSET_BASE_URL
        ? toApiLibraryPath(filePath)
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
    assetRoot: ASSET_BASE_URL ? '/api/library' : '..',
    categories
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(catalog, null, 2), 'utf8');
  console.log(`Catalog generated with ${categories.length} categories.`);
}

buildCatalog();
