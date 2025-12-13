/**
 * OCR-Based Catalog Text Extractor
 * Extracts text from catalog images using Tesseract OCR
 * Useful for band logos, text-based designs, etc.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { isJunkFile, formatDisplayName, slugify } = require('./utils/string');

// Try to load tesseract.js - it may not be installed yet
let createWorker = null;
try {
  const tesseract = require('tesseract.js');
  createWorker = tesseract.createWorker;
} catch (e) {
  console.warn('[OCR] tesseract.js not installed. Run: npm install tesseract.js');
}

const APP_ROOT = path.resolve(__dirname, '..');
const LIBRARY_ROOT = process.env.LIBRARY_ROOT
  ? path.resolve(process.env.LIBRARY_ROOT)
  : path.join(APP_ROOT, 'web', 'library');

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif']);

// Tesseract worker singleton
let tesseractWorker = null;

function collectFilesRecursive(dirPath) {
  const collected = [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        collected.push(...collectFilesRecursive(entryPath));
      } else if (entry.isFile()) {
        collected.push(entryPath);
      }
    }
  } catch (err) {
    console.error(`[OCR] Error reading directory ${dirPath}:`, err.message);
  }
  return collected;
}

/**
 * Find category directory by slug
 */
function findCategoryDirectory(categorySlug) {
  const rootEntries = fs.readdirSync(LIBRARY_ROOT, { withFileTypes: true });

  for (const entry of rootEntries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;

    const entrySlug = slugify(entry.name);
    if (entrySlug === categorySlug) {
      return entry.name;
    }
  }
  return null;
}

/**
 * Get all image files in a category
 */
function getCategoryItems(categorySlug) {
  const actualCategoryDir = findCategoryDirectory(categorySlug);

  if (!actualCategoryDir) {
    throw new Error(`Category not found: ${categorySlug}`);
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
      category: actualCategoryDir,
      relativePath: path.relative(LIBRARY_ROOT, filePath)
    });
  }

  return items;
}

/**
 * Initialize or get Tesseract worker
 */
async function ensureTesseract() {
  if (!createWorker) {
    throw new Error('tesseract.js is not installed. Run: npm install tesseract.js');
  }

  if (tesseractWorker) return tesseractWorker;

  const worker = await createWorker();
  await worker.loadLanguage('eng');
  await worker.initialize('eng');
  tesseractWorker = worker;
  return worker;
}

/**
 * Preprocess image for better OCR results (optimized for speed)
 * Returns just 2 variants: grayscale and inverted
 */
async function preprocessImage(imagePath) {
  const variants = [];

  try {
    const metadata = await sharp(imagePath).metadata();
    const needsScale = (metadata.width || 0) < 400 || (metadata.height || 0) < 400;

    // Single optimized grayscale with optional scaling
    let pipeline = sharp(imagePath).grayscale().normalize();
    if (needsScale) {
      const scale = Math.max(400 / (metadata.width || 400), 400 / (metadata.height || 400));
      pipeline = pipeline.resize(
        Math.round((metadata.width || 400) * scale),
        Math.round((metadata.height || 400) * scale)
      );
    }
    const grayBuffer = await pipeline.toBuffer();
    variants.push({ name: 'grayscale', buffer: grayBuffer });

    // Inverted (for white text on dark background - common in band logos)
    const invertedBuffer = await sharp(grayBuffer).negate().toBuffer();
    variants.push({ name: 'inverted', buffer: invertedBuffer });

  } catch (err) {
    console.error(`[OCR] Preprocessing error for ${imagePath}:`, err.message);
    // Fallback to original
    const originalBuffer = await sharp(imagePath).toBuffer();
    variants.push({ name: 'original', buffer: originalBuffer });
  }

  return variants;
}

/**
 * Clean up extracted text for use as searchable metadata
 */
function cleanExtractedText(text) {
  if (!text) return '';

  return text
    .replace(/[^\w\s'-]/g, ' ')  // Remove special characters except apostrophe and hyphen
    .replace(/\s+/g, ' ')        // Normalize whitespace
    .trim()
    .substring(0, 200);          // Limit length
}

/**
 * Extract band/logo name from OCR text
 * Attempts to identify the main text content
 */
function extractBandName(text) {
  if (!text || text.length < 2) return null;

  // Common noise words to filter
  const noiseWords = new Set(['the', 'band', 'logo', 'official', 'music', 'rock', 'metal', 'est', 'since']);

  const words = text.split(/\s+/).filter(w => w.length > 1);
  const filteredWords = words.filter(w => !noiseWords.has(w.toLowerCase()));

  if (filteredWords.length === 0) return null;

  // Title case the result
  return filteredWords
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Perform OCR on a single image (optimized for speed)
 * Only tries 2 variants × 2 PSM modes = 4 attempts max
 */
async function performOcr(imagePath) {
  const worker = await ensureTesseract();

  // Get preprocessed variants (just 2: grayscale and inverted)
  const variants = await preprocessImage(imagePath);

  let bestText = '';
  let bestConfidence = 0;

  // Only 2 PSM modes for speed:
  // 7 = Single text line (best for logos)
  // 8 = Single word (good for band names)
  const psmModes = ['7', '8'];

  for (const variant of variants) {
    for (const psm of psmModes) {
      try {
        const result = await worker.recognize(variant.buffer, {
          tessedit_pageseg_mode: psm
        });

        if (result.data && result.data.text) {
          const text = result.data.text.trim();
          const confidence = result.data.confidence || 0;

          // Score based on confidence and text length
          const score = confidence * (1 + text.length / 50);

          if (score > bestConfidence && text.length > 1) {
            bestText = text;
            bestConfidence = score;

            // Early exit if we got a good result
            if (confidence > 70 && text.length > 2) {
              return {
                rawText: bestText,
                cleanedText: cleanExtractedText(bestText),
                bandName: extractBandName(bestText),
                confidence: bestConfidence
              };
            }
          }
        }
      } catch (err) {
        // Continue with other variants
      }
    }
  }

  return {
    rawText: bestText,
    cleanedText: cleanExtractedText(bestText),
    bandName: extractBandName(bestText),
    confidence: bestConfidence
  };
}

/**
 * Run OCR on all items in a category with progress reporting
 */
async function runCategoryOcr(categorySlug, { onProgress, onComplete, onError, minConfidence = 30 }) {
  try {
    const items = getCategoryItems(categorySlug);
    const total = items.length;

    if (total === 0) {
      if (onComplete) onComplete({ processed: 0, failed: 0, skipped: 0, total: 0, results: [] });
      return { processed: 0, failed: 0, skipped: 0, total: 0, results: [] };
    }

    let processed = 0;
    let failed = 0;
    let skipped = 0;
    const results = [];

    for (const item of items) {
      try {
        const ocrResult = await performOcr(item.imagePath);

        if (ocrResult.confidence < minConfidence || !ocrResult.cleanedText) {
          skipped++;
          results.push({
            id: item.id,
            name: item.name,
            relativePath: item.relativePath,
            ocrText: null,
            bandName: null,
            confidence: ocrResult.confidence,
            status: 'skipped',
            reason: 'low confidence or no text'
          });
        } else {
          processed++;
          results.push({
            id: item.id,
            name: item.name,
            relativePath: item.relativePath,
            ocrText: ocrResult.cleanedText,
            rawText: ocrResult.rawText,
            bandName: ocrResult.bandName,
            confidence: ocrResult.confidence,
            status: 'success'
          });
        }

        if (onProgress) {
          onProgress({
            current: processed + failed + skipped,
            total,
            processed,
            failed,
            skipped,
            item: item.name,
            result: results[results.length - 1]
          });
        }
      } catch (err) {
        console.error(`[OCR] Error processing ${item.name}:`, err.message);
        failed++;
        results.push({
          id: item.id,
          name: item.name,
          relativePath: item.relativePath,
          status: 'error',
          error: err.message
        });

        if (onProgress) {
          onProgress({
            current: processed + failed + skipped,
            total,
            processed,
            failed,
            skipped,
            item: item.name,
            result: results[results.length - 1]
          });
        }
      }
    }

    const summary = { processed, failed, skipped, total, results };
    if (onComplete) onComplete(summary);
    return summary;

  } catch (err) {
    if (onError) onError(err);
    throw err;
  }
}

/**
 * Update catalog.json with OCR-extracted text
 */
async function updateCatalogWithOcr(categorySlug, results, catalogPath) {
  if (!catalogPath) {
    const WEB_DIR = fs.existsSync(path.join(LIBRARY_ROOT, 'web'))
      ? path.join(LIBRARY_ROOT, 'web')
      : path.join(APP_ROOT, 'web');
    catalogPath = path.join(WEB_DIR, 'catalog.json');
  }

  if (!fs.existsSync(catalogPath)) {
    console.warn(`[OCR] catalog.json not found at ${catalogPath}, skipping update`);
    return 0;
  }

  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const category = catalog.categories?.find(cat => cat.slug === categorySlug);

  if (!category) {
    console.warn(`[OCR] Category ${categorySlug} not found in catalog`);
    return 0;
  }

  let updated = 0;
  for (const result of results) {
    if (result.status !== 'success') continue;

    const design = category.designs?.find(d => d.id === result.id);
    if (design) {
      design.ocrText = result.ocrText;
      if (result.bandName) {
        design.extractedName = result.bandName;
      }
      updated++;
    }
  }

  if (updated > 0) {
    fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2), 'utf8');
    console.log(`[OCR] Updated ${updated} designs in catalog.json for category ${categorySlug}`);
  }

  return updated;
}

/**
 * Clean up Tesseract worker
 */
async function terminateWorker() {
  if (tesseractWorker) {
    await tesseractWorker.terminate();
    tesseractWorker = null;
  }
}

module.exports = {
  runCategoryOcr,
  getCategoryItems,
  updateCatalogWithOcr,
  performOcr,
  findCategoryDirectory,
  terminateWorker
};
