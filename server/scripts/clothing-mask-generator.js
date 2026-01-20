/**
 * Clothing Mask Generator - HYBRID APPROACH
 * Generates masks for human model images to enable accurate color tinting
 *
 * Step 1: Use rembg (Python AI) to remove background and isolate the person
 * Step 2: Use color detection to identify white clothing vs skin
 *
 * Requires: pip install rembg
 */

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const { execSync, exec } = require('child_process');

// Temp folder for intermediate files
const TEMP_FOLDER = path.join(__dirname, '..', '..', 'temp_masks');

/**
 * Generate a clothing mask using hybrid approach
 * Step 1: rembg removes background
 * Step 2: Color detection identifies clothing
 */
async function generateClothingMask(inputPath, outputPath, options = {}) {
  const {
    // Clothing detection thresholds - more lenient to capture full garments
    clothingLuminanceMin = 100,  // Lower to catch deeply shadowed areas of white clothing
    clothingLuminanceMax = 255,  // Max brightness
    maxColorVariance = 45,       // Higher to allow slightly off-white/cream clothing

    // Hair exclusion - exclude top portion of image where hair typically is
    hairExclusionRatio = 0.25,   // Top 25% of person has more aggressive filtering

    // Keep temp files for debugging
    keepTempFiles = false,

    // Cleanup
    blur = 0.5      // Smooth edges
  } = options;

  // Create temp folder
  if (!fs.existsSync(TEMP_FOLDER)) {
    fs.mkdirSync(TEMP_FOLDER, { recursive: true });
  }

  const baseName = path.basename(inputPath, path.extname(inputPath));
  const noBgPath = path.join(TEMP_FOLDER, `${baseName}_nobg.png`);

  // Step 1: Remove background with rembg
  console.log(`[rembg] Removing background: ${baseName}`);
  try {
    // Try full path first (Linux), then fall back to just 'rembg' (Windows/PATH)
    const rembgCmd = process.platform === 'win32' ? 'rembg' : '/home/ubuntu/.local/bin/rembg';
    execSync(`${rembgCmd} i "${inputPath}" "${noBgPath}"`, { stdio: 'pipe' });
  } catch (error) {
    // Fallback: try without full path
    try {
      execSync(`rembg i "${inputPath}" "${noBgPath}"`, { stdio: 'pipe' });
    } catch (e2) {
      throw new Error(`rembg failed. Make sure it's installed: pip install rembg\nError: ${error.message}`);
    }
  }

  // Step 2: Load the no-background image
  const noBgImage = sharp(noBgPath);
  const metadata = await noBgImage.metadata();
  const { width, height } = metadata;

  const rawBuffer = await noBgImage
    .ensureAlpha()
    .raw()
    .toBuffer();

  // Find bounding box of non-transparent pixels (the person)
  let minY = height, maxY = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const a = rawBuffer[i * 4 + 3];
      if (a >= 128) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const personHeight = maxY - minY;
  const hairCutoffY = minY + Math.floor(personHeight * hairExclusionRatio);

  // Create mask: white/gray clothing only (not transparent, not skin, neutral color)
  const maskBuffer = Buffer.alloc(width * height);

  for (let i = 0; i < width * height; i++) {
    const y = Math.floor(i / width);
    const pixelIndex = i * 4; // RGBA
    const r = rawBuffer[pixelIndex];
    const g = rawBuffer[pixelIndex + 1];
    const b = rawBuffer[pixelIndex + 2];
    const a = rawBuffer[pixelIndex + 3];

    // Skip transparent pixels (background removed by rembg)
    if (a < 128) {
      maskBuffer[i] = 0;
      continue;
    }

    // Check if skin tone
    const isSkin = isSkinTone(r, g, b);
    if (isSkin) {
      maskBuffer[i] = 0;
      continue;
    }

    // Calculate luminance and color variance
    const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
    const colorVariance = Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(r - b));

    // Check if pixel is white/gray clothing (neutral color, appropriate brightness)
    const isNeutralColor = colorVariance <= maxColorVariance;
    const isClothingBrightness = luminance >= clothingLuminanceMin && luminance <= clothingLuminanceMax;

    // In hair region (top of person), be more strict - require higher luminance and lower variance
    const inHairRegion = y < hairCutoffY;
    if (inHairRegion) {
      // Much stricter in hair region - only very bright, very neutral pixels
      const isVeryBright = luminance >= 200;
      const isVeryNeutral = colorVariance <= 15;
      maskBuffer[i] = (isVeryBright && isVeryNeutral) ? 255 : 0;
    } else {
      // Normal clothing region - use standard thresholds
      maskBuffer[i] = (isNeutralColor && isClothingBrightness) ? 255 : 0;
    }
  }

  // Clean up and save mask
  let maskImage = sharp(maskBuffer, { raw: { width, height, channels: 1 } });

  if (blur > 0) {
    maskImage = maskImage.blur(blur);
  }

  await maskImage
    .threshold(128)
    .png()
    .toFile(outputPath);

  // Cleanup temp files
  if (!keepTempFiles && fs.existsSync(noBgPath)) {
    fs.unlinkSync(noBgPath);
  }

  console.log(`Mask generated: ${outputPath}`);
  return outputPath;
}

/**
 * Detect skin tones using multiple color space checks
 * Works across diverse skin tones
 */
function isSkinTone(r, g, b) {
  // RGB rule-based skin detection
  const rgbSkin = (
    r > 95 && g > 40 && b > 20 &&
    r > g && r > b &&
    Math.abs(r - g) > 15 &&
    (Math.max(r, g, b) - Math.min(r, g, b)) > 15
  );

  // HSV-based skin detection
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  let h = 0;
  if (delta !== 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h = Math.round(h * 60);
    if (h < 0) h += 360;
  }

  const s = max === 0 ? 0 : (delta / max) * 100;
  const v = (max / 255) * 100;

  // Skin tone hue range (0-50 degrees, wrapping around red)
  const hsvSkin = (
    (h >= 0 && h <= 50) &&
    (s >= 10 && s <= 70) &&
    (v >= 30 && v <= 90)
  );

  return rgbSkin || hsvSkin;
}

/**
 * Batch process all images in a folder
 */
async function batchGenerateMasks(inputFolder, outputFolder, options = {}) {
  // Create output folder if needed
  if (!fs.existsSync(outputFolder)) {
    fs.mkdirSync(outputFolder, { recursive: true });
  }

  // Get all image files
  const files = fs.readdirSync(inputFolder)
    .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f));

  console.log(`Processing ${files.length} images...`);

  const results = [];
  for (const file of files) {
    const inputPath = path.join(inputFolder, file);
    const maskFileName = file.replace(/\.(png|jpg|jpeg|webp)$/i, '_mask.png');
    const outputPath = path.join(outputFolder, maskFileName);

    try {
      await generateClothingMask(inputPath, outputPath, options);
      results.push({ file, success: true, maskPath: outputPath });
    } catch (error) {
      console.error(`Error processing ${file}:`, error.message);
      results.push({ file, success: false, error: error.message });
    }
  }

  console.log(`\nCompleted: ${results.filter(r => r.success).length}/${files.length}`);
  return results;
}

/**
 * Generate mask for a single model and update database
 */
async function generateMaskForModel(db, modelId, options = {}) {
  // Get model from database
  const model = db.prepare('SELECT * FROM human_models WHERE id = ?').get(modelId);
  if (!model) {
    throw new Error(`Model not found: ${modelId}`);
  }

  const modelFilePath = model.optimized_path || model.file_path;
  if (!modelFilePath) {
    throw new Error(`No image path for model: ${modelId}`);
  }

  // Resolve the path - models are stored under /web/library/human-models/
  const webDir = path.join(__dirname, '..', '..', 'web');
  let fullImagePath;

  if (modelFilePath.startsWith('/')) {
    fullImagePath = path.resolve(webDir, modelFilePath.replace(/^\//, ''));
  } else if (modelFilePath.includes(':')) {
    // Absolute Windows path
    fullImagePath = modelFilePath;
  } else {
    fullImagePath = path.join(webDir, modelFilePath);
  }

  // Fallback: check if it exists as-is
  if (!fs.existsSync(fullImagePath) && fs.existsSync(modelFilePath)) {
    fullImagePath = modelFilePath;
  }

  if (!fs.existsSync(fullImagePath)) {
    throw new Error(`Image file not found: ${fullImagePath}`);
  }

  // Create masks folder next to the human models
  const libraryDir = path.join(webDir, 'library');
  const masksDir = path.join(libraryDir, 'human-models', 'masks');
  if (!fs.existsSync(masksDir)) {
    fs.mkdirSync(masksDir, { recursive: true });
  }

  // Generate mask filename
  const baseName = path.basename(modelFilePath, path.extname(modelFilePath));
  const maskFileName = `${baseName}_mask.png`;
  const maskPath = path.join(masksDir, maskFileName);
  // Store with leading slash to match how filePath is stored
  const relativeMaskPath = `/library/human-models/masks/${maskFileName}`;

  // Generate the mask
  await generateClothingMask(fullImagePath, maskPath, options);

  // Update database
  db.prepare('UPDATE human_models SET mask_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(relativeMaskPath, modelId);

  console.log(`Updated model ${modelId} with mask: ${relativeMaskPath}`);

  return {
    modelId,
    maskPath: relativeMaskPath,
    fullMaskPath: maskPath
  };
}

/**
 * Generate masks for all models without masks
 */
async function generateMissingMasks(db, options = {}) {
  const models = db.prepare("SELECT * FROM human_models WHERE (mask_path IS NULL OR mask_path = '') AND active = 1").all();

  console.log(`Found ${models.length} models without masks`);

  const results = [];
  for (const model of models) {
    try {
      const result = await generateMaskForModel(db, model.id, options);
      results.push({ ...result, success: true });
    } catch (error) {
      console.error(`Error generating mask for ${model.id}:`, error.message);
      results.push({ modelId: model.id, success: false, error: error.message });
    }
  }

  const successful = results.filter(r => r.success).length;
  console.log(`\nGenerated ${successful}/${models.length} masks`);

  return results;
}

// Export functions
module.exports = {
  generateClothingMask,
  batchGenerateMasks,
  isSkinTone,
  generateMaskForModel,
  generateMissingMasks
};

// CLI usage
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args[0] === '--db') {
    // Generate masks for all models in database
    const Database = require('better-sqlite3');
    const dbPath = path.join(__dirname, '..', '..', 'data', 'store.db');
    const db = new Database(dbPath);

    generateMissingMasks(db, {
      clothingLuminanceMin: parseInt(args[1]) || 180
    })
      .then(results => {
        console.log('Done!');
        db.close();
      })
      .catch(err => {
        console.error('Error:', err);
        db.close();
        process.exit(1);
      });
  } else if (args.length >= 2) {
    // Batch process folder
    batchGenerateMasks(args[0], args[1], {
      clothingLuminanceMin: parseInt(args[2]) || 180
    })
      .then(() => console.log('Done!'))
      .catch(err => console.error('Error:', err));
  } else {
    console.log('Usage:');
    console.log('  Batch folder:  node clothing-mask-generator.js <input-folder> <output-folder> [luminance-min]');
    console.log('  From database: node clothing-mask-generator.js --db [luminance-min]');
    console.log('');
    console.log('Examples:');
    console.log('  node clothing-mask-generator.js ./models ./masks 180');
    console.log('  node clothing-mask-generator.js --db 175');
    process.exit(1);
  }
}
