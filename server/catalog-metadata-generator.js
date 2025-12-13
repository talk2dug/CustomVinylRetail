/**
 * On-Demand Catalog Metadata Generator
 * Generates AI descriptions for catalog items by category with progress reporting
 */

const fs = require('fs');
const path = require('path');
const { describeCatalogDesign } = require('../scripts/claude-describe');
const { isJunkFile, formatDisplayName, slugify } = require('./utils/string');

const APP_ROOT = path.resolve(__dirname, '..');
const LIBRARY_ROOT = process.env.LIBRARY_ROOT
  ? path.resolve(process.env.LIBRARY_ROOT)
  : path.join(APP_ROOT, 'web', 'library');

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

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

/**
 * Get all image files in a category
 */
function getCategoryItems(categorySlug) {
  // First, try to find the actual directory name by checking LIBRARY_ROOT for matching directories
  console.log(`[Metadata Generator] Looking for category: ${categorySlug}`);
  console.log(`[Metadata Generator] LIBRARY_ROOT: ${LIBRARY_ROOT}`);

  const rootEntries = fs.readdirSync(LIBRARY_ROOT, { withFileTypes: true });
  let actualCategoryDir = null;

  console.log(`[Metadata Generator] Found ${rootEntries.length} entries in LIBRARY_ROOT`);
  const directories = rootEntries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name);
  console.log(`[Metadata Generator] Directories:`, directories);

  for (const entry of rootEntries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;

    // Check if this directory's slugified name matches the requested slug
    const entrySlug = slugify(entry.name);
    console.log(`[Metadata Generator] Checking: "${entry.name}" -> slug: "${entrySlug}" vs requested: "${categorySlug}"`);
    if (entrySlug === categorySlug) {
      actualCategoryDir = entry.name;
      console.log(`[Metadata Generator] MATCH FOUND: ${actualCategoryDir}`);
      break;
    }
  }

  if (!actualCategoryDir) {
    throw new Error(`Category not found: ${categorySlug} (no matching directory in ${LIBRARY_ROOT})`);
  }

  const categoryPath = path.join(LIBRARY_ROOT, actualCategoryDir);

  if (!fs.existsSync(categoryPath) || !fs.statSync(categoryPath).isDirectory()) {
    throw new Error(`Category path is invalid: ${categoryPath}`);
  }

  const files = collectFilesRecursive(categoryPath);
  const items = [];

  for (const filePath of files) {
    if (isJunkFile(filePath)) continue;
    const ext = path.extname(filePath).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) continue;

    const baseName = formatDisplayName(path.basename(filePath, ext));
    const fileName = path.basename(filePath, ext);

    items.push({
      id: slugify(baseName) || slugify(path.basename(filePath)),
      name: baseName,
      fileName: fileName,
      imagePath: filePath,
      category: actualCategoryDir
    });
  }

  return items;
}

/**
 * Generate metadata for items in a category with progress callback
 * @param {string} categorySlug - Category slug
 * @param {Function} onProgress - Progress callback (current, total, item, result)
 * @param {Function} onComplete - Completion callback
 * @param {Function} onError - Error callback
 */
async function generateCategoryMetadata(categorySlug, { onProgress, onComplete, onError }) {
  try {
    // Get all items in category
    const items = getCategoryItems(categorySlug);
    const total = items.length;

    if (total === 0) {
      if (onComplete) onComplete({ processed: 0, failed: 0 });
      return { processed: 0, failed: 0 };
    }

    let processed = 0;
    let failed = 0;
    const results = [];

    // Process each item
    for (const item of items) {
      try {
        // Generate description
        const description = await describeCatalogDesign({
          category: item.category,
          fileName: item.fileName,
          imagePath: item.imagePath
        });

        const result = {
          id: item.id,
          name: item.name,
          description: description || item.name,
          success: true
        };

        results.push(result);
        processed++;

        // Report progress
        if (onProgress) {
          onProgress({
            current: processed + failed,
            total,
            processed,
            failed,
            item: item.name,
            result: result
          });
        }
      } catch (error) {
        console.error(`Failed to generate metadata for ${item.name}:`, error);

        const result = {
          id: item.id,
          name: item.name,
          error: error.message,
          success: false
        };

        results.push(result);
        failed++;

        // Report progress even on failure
        if (onProgress) {
          onProgress({
            current: processed + failed,
            total,
            processed,
            failed,
            item: item.name,
            result: result
          });
        }
      }
    }

    // Final completion callback
    if (onComplete) {
      onComplete({
        processed,
        failed,
        total,
        results
      });
    }

    return {
      processed,
      failed,
      total,
      results
    };
  } catch (error) {
    if (onError) onError(error);
    throw error;
  }
}

/**
 * Update catalog.json with generated metadata
 */
async function updateCatalogMetadata(categorySlug, results, catalogPath) {
  // If catalogPath not provided, try to find it
  if (!catalogPath) {
    const LIBRARY_WEB_DIR = path.join(LIBRARY_ROOT, 'web');
    const WEB_DIR = fs.existsSync(LIBRARY_WEB_DIR) ? LIBRARY_WEB_DIR : path.join(APP_ROOT, 'web');
    catalogPath = path.join(WEB_DIR, 'catalog.json');
  }

  if (!fs.existsSync(catalogPath)) {
    throw new Error(`catalog.json not found at: ${catalogPath}`);
  }

  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const category = catalog.categories?.find(cat => cat.slug === categorySlug);

  if (!category) {
    throw new Error(`Category ${categorySlug} not found in catalog`);
  }

  // Update descriptions
  console.log(`[updateCatalogMetadata] Updating ${results.length} results for category ${categorySlug}`);
  let updated = 0;
  for (const result of results) {
    if (!result.success) {
      console.log(`[updateCatalogMetadata] Skipping failed result for ${result.id}`);
      continue;
    }

    const design = category.designs?.find(d => d.id === result.id);
    if (design) {
      console.log(`[updateCatalogMetadata] Updating design ${result.id} with description: ${result.description?.substring(0, 50)}...`);
      design.autoDescription = result.description;
      updated++;
    } else {
      console.log(`[updateCatalogMetadata] Design ${result.id} not found in category ${categorySlug}`);
    }
  }
  console.log(`[updateCatalogMetadata] Updated ${updated} designs, writing to ${catalogPath}`);

  // Write back to file
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2), 'utf8');
  console.log(`[updateCatalogMetadata] File written successfully`);
}

module.exports = {
  generateCategoryMetadata,
  getCategoryItems,
  updateCatalogMetadata
};
