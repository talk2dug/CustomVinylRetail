/**
 * Resize all mockup images to preview size (max 800px dimension)
 * This reduces file sizes significantly for faster loading
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const MAX_DIMENSION = 800;
const QUALITY = 85;

// Directories to process
const MOCKUP_DIRS = [
  '/home/ubuntu/vinylApp/web/images/custom-art',
  '/home/ubuntu/vinylApp/web/images/custom-art/mockups',
  '/home/ubuntu/vinylApp/web/images/custom-art/tiled'
];

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

async function resizeImage(filePath) {
  try {
    const metadata = await sharp(filePath).metadata();
    const { width, height } = metadata;

    // Skip if already small enough
    if (width <= MAX_DIMENSION && height <= MAX_DIMENSION) {
      return { skipped: true, reason: 'already small' };
    }

    const originalSize = fs.statSync(filePath).size;

    // Calculate new dimensions maintaining aspect ratio
    let newWidth, newHeight;
    if (width > height) {
      newWidth = MAX_DIMENSION;
      newHeight = Math.round(height * (MAX_DIMENSION / width));
    } else {
      newHeight = MAX_DIMENSION;
      newWidth = Math.round(width * (MAX_DIMENSION / height));
    }

    // Create temp file
    const ext = path.extname(filePath).toLowerCase();
    const tempPath = filePath + '.tmp';

    let pipeline = sharp(filePath).resize(newWidth, newHeight, { fit: 'inside' });

    if (ext === '.jpg' || ext === '.jpeg') {
      pipeline = pipeline.jpeg({ quality: QUALITY });
    } else if (ext === '.png') {
      pipeline = pipeline.png({ compressionLevel: 8 });
    } else if (ext === '.webp') {
      pipeline = pipeline.webp({ quality: QUALITY });
    }

    await pipeline.toFile(tempPath);

    // Replace original with resized
    fs.unlinkSync(filePath);
    fs.renameSync(tempPath, filePath);

    const newSize = fs.statSync(filePath).size;
    const savings = ((originalSize - newSize) / originalSize * 100).toFixed(1);

    return {
      resized: true,
      original: { width, height, size: originalSize },
      new: { width: newWidth, height: newHeight, size: newSize },
      savings: `${savings}%`
    };
  } catch (err) {
    return { error: err.message };
  }
}

async function processDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) {
    console.log(`[Resize] Directory not found: ${dirPath}`);
    return { processed: 0, skipped: 0, errors: 0 };
  }

  const files = fs.readdirSync(dirPath);
  let processed = 0, skipped = 0, errors = 0;
  let totalSaved = 0;

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) continue;

    const filePath = path.join(dirPath, file);
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) continue;

    const result = await resizeImage(filePath);

    if (result.error) {
      console.log(`[Resize] ERROR ${file}: ${result.error}`);
      errors++;
    } else if (result.skipped) {
      skipped++;
    } else if (result.resized) {
      const saved = result.original.size - result.new.size;
      totalSaved += saved;
      console.log(`[Resize] ${file}: ${result.original.width}x${result.original.height} -> ${result.new.width}x${result.new.height} (saved ${result.savings})`);
      processed++;
    }
  }

  return { processed, skipped, errors, totalSaved };
}

async function main() {
  console.log('[Resize] Starting mockup resize...');
  console.log(`[Resize] Max dimension: ${MAX_DIMENSION}px, Quality: ${QUALITY}`);

  let totalProcessed = 0, totalSkipped = 0, totalErrors = 0, totalSaved = 0;

  for (const dir of MOCKUP_DIRS) {
    console.log(`\n[Resize] Processing ${dir}`);
    const result = await processDirectory(dir);
    totalProcessed += result.processed;
    totalSkipped += result.skipped;
    totalErrors += result.errors;
    totalSaved += result.totalSaved || 0;
  }

  console.log(`\n[Resize] Complete!`);
  console.log(`[Resize] Resized: ${totalProcessed}`);
  console.log(`[Resize] Skipped: ${totalSkipped}`);
  console.log(`[Resize] Errors: ${totalErrors}`);
  console.log(`[Resize] Total saved: ${(totalSaved / 1024 / 1024).toFixed(2)} MB`);
}

main().catch(e => {
  console.error('[Resize] Fatal error:', e);
  process.exit(1);
});
