/**
 * Garment Recolor Service
 *
 * Uses Replicate AI APIs to automatically recolor clothing on model images.
 * - Step 1: Grounded SAM segments the garment
 * - Step 2: SDXL Inpainting recolors the masked area
 * - Results are cached in database to avoid redundant API calls
 *
 * Cost: ~$0.004 per new color variation (~$4 per 1,000 images)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Replicate config - using full model:version format
const REPLICATE_MODELS = {
  segmentation: 'schananas/grounded_sam:ee871c19efb1941f55f66a3d7d960428c8a5afcb77449547fe8e5a3ab9ebc21c',
  inpainting: 'lucataco/sdxl-inpainting:a5b13068cc81a89a4fbeefeccc774869fcb34df4dbc92c1555e0f2771d49dde7'
};

// Default inpainting settings (using correct API parameter names)
const INPAINTING_CONFIG = {
  steps: 50,  // More steps for better quality
  guidance_scale: 10,  // Max allowed by API (10) for faithful color adherence
  strength: 1.0,  // Full replacement for complete color change
  negative_prompt: 'blurry, low quality, distorted, deformed, ugly, bad anatomy, white clothing, original color, faded, washed out, transparent, see-through, pale, desaturated, uneven color, patchy, bleached spots, white patches, overexposed'
};

// Directory for cached recolored images
let CACHE_DIR = '/var/www/library/human-models/recolored';

// Retry configuration for rate limits
const RETRY_CONFIG = {
  maxRetries: 3,
  initialDelay: 10000, // 10 seconds
  maxDelay: 60000      // 60 seconds max
};

/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Run a Replicate model with automatic retry on rate limit
 */
async function runWithRetry(replicateClient, model, input, retries = 0) {
  try {
    return await replicateClient.run(model, { input });
  } catch (error) {
    const isRateLimit = error.message && error.message.includes('429');

    if (isRateLimit && retries < RETRY_CONFIG.maxRetries) {
      // Extract retry_after from error if available, or use exponential backoff
      const retryMatch = error.message.match(/retry_after.*?(\d+)/);
      const retryAfter = retryMatch ? parseInt(retryMatch[1]) * 1000 : null;
      const delay = Math.min(
        retryAfter || RETRY_CONFIG.initialDelay * Math.pow(2, retries),
        RETRY_CONFIG.maxDelay
      );

      console.log(`  [Recolor] Rate limited. Retrying in ${delay/1000}s (attempt ${retries + 1}/${RETRY_CONFIG.maxRetries})...`);
      await sleep(delay);
      return runWithRetry(replicateClient, model, input, retries + 1);
    }

    throw error;
  }
}

/**
 * Initialize the recolor service
 * @param {Object} options
 * @param {string} options.cacheDir - Directory to store cached images
 */
function init(options = {}) {
  if (options.cacheDir) {
    CACHE_DIR = options.cacheDir;
  }
  // Ensure cache directory exists
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

/**
 * Generate a cache key for a specific model + color combination
 */
function getCacheKey(modelId, color, garmentType) {
  const colorSlug = color.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const garmentSlug = garmentType.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return `${modelId}_${garmentSlug}_${colorSlug}`;
}

/**
 * Get the file path for a cached recolored image
 */
function getCachePath(cacheKey) {
  return path.join(CACHE_DIR, `${cacheKey}.png`);
}

/**
 * Check if a cached recolored image exists
 */
function hasCachedImage(cacheKey) {
  const cachePath = getCachePath(cacheKey);
  return fs.existsSync(cachePath);
}

/**
 * Get fallback prompts for segmentation based on garment type
 */
function getSegmentationPrompts(garmentType) {
  const type = garmentType.toLowerCase();

  // Start with the exact type, then try broader terms
  const prompts = [type];

  if (type.includes('shirt') || type.includes('tee') || type.includes('t-shirt')) {
    prompts.push('shirt', 'top', 'clothing', 'garment');
  } else if (type.includes('hoodie') || type.includes('sweatshirt')) {
    prompts.push('hoodie', 'sweatshirt', 'top', 'clothing');
  } else if (type.includes('jacket') || type.includes('coat')) {
    prompts.push('jacket', 'outerwear', 'clothing');
  } else {
    prompts.push('clothing', 'garment', 'top');
  }

  return [...new Set(prompts)]; // Remove duplicates
}

/**
 * Run Grounded SAM to segment garment
 */
async function segmentGarment(replicateClient, imagePath, garmentType) {
  console.log(`  [Recolor] Segmenting "${garmentType}" from image...`);

  // Read image and convert to base64 data URI
  const imageBuffer = fs.readFileSync(imagePath);
  const base64Image = imageBuffer.toString('base64');
  const mimeType = imagePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
  const dataUri = `data:${mimeType};base64,${base64Image}`;

  // Try multiple prompts if needed
  const prompts = getSegmentationPrompts(garmentType);
  let lastError = null;

  for (const prompt of prompts) {
    try {
      console.log(`  [Recolor] Trying segmentation with prompt: "${prompt}"`);

      const output = await runWithRetry(replicateClient, REPLICATE_MODELS.segmentation, {
        image: dataUri,
        prompt: prompt,
        box_threshold: 0.2,  // Slightly lower threshold for better detection
        text_threshold: 0.2
      });

      // Grounded SAM returns array: [annotated, neg_annotated, mask, inverted_mask]
      // We need the 3rd element (index 2) which is the actual mask
      console.log(`  [Recolor] Segmentation output type: ${typeof output}, isArray: ${Array.isArray(output)}`);

      let maskUrl;
      if (Array.isArray(output) && output.length >= 3) {
        maskUrl = output[2];
      } else if (Array.isArray(output) && output.length > 0) {
        maskUrl = output[0];
      } else if (output && output.mask) {
        maskUrl = output.mask;
      } else if (typeof output === 'string') {
        maskUrl = output;
      }

      if (maskUrl) {
        // Ensure we return a string (Replicate may return URL objects)
        const maskUrlStr = typeof maskUrl === 'object' && maskUrl.href ? maskUrl.href : String(maskUrl);
        console.log(`  [Recolor] Using mask from prompt "${prompt}": ${maskUrlStr}`);
        return maskUrlStr;
      }
    } catch (err) {
      console.warn(`  [Recolor] Segmentation failed with prompt "${prompt}": ${err.message}`);
      lastError = err;
      // Continue to next prompt
    }
  }

  throw new Error(`Could not segment garment. Tried prompts: ${prompts.join(', ')}. Last error: ${lastError?.message || 'No mask generated'}`);
}

/**
 * Run SDXL Inpainting to recolor garment
 */
async function inpaintGarment(replicateClient, imagePath, maskUrl, colorPrompt, garmentType) {
  console.log(`  [Recolor] Inpainting with color: "${colorPrompt}"...`);

  // Read image and convert to base64 data URI
  const imageBuffer = fs.readFileSync(imagePath);
  const base64Image = imageBuffer.toString('base64');
  const mimeType = imagePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
  const dataUri = `data:${mimeType};base64,${base64Image}`;

  // Build the prompt for the new color - emphasize uniform color with natural shading
  const prompt = `${colorPrompt} ${garmentType}, uniform ${colorPrompt} colored cotton fabric, evenly dyed ${colorPrompt} garment with natural fabric folds and shadows, consistent ${colorPrompt} color throughout, professional product photography, studio lighting`;
  console.log(`  [Recolor] Inpainting prompt: "${prompt}"`);

  const output = await runWithRetry(replicateClient, REPLICATE_MODELS.inpainting, {
    image: dataUri,
    mask: maskUrl,
    prompt: prompt,
    negative_prompt: INPAINTING_CONFIG.negative_prompt,
    steps: INPAINTING_CONFIG.steps,
    guidance_scale: INPAINTING_CONFIG.guidance_scale,
    strength: INPAINTING_CONFIG.strength
  });

  // SDXL Inpainting returns the result image URL
  if (Array.isArray(output) && output.length > 0) {
    return output[0];
  } else if (typeof output === 'string') {
    return output;
  }

  throw new Error('No image generated from inpainting model');
}

/**
 * Download an image from URL to local file
 */
async function downloadImage(url, outputPath) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(outputPath, buffer);
  return outputPath;
}

/**
 * Main recolor function
 *
 * @param {Object} options
 * @param {string} options.modelId - Human model ID
 * @param {string} options.imagePath - Path to the original model image
 * @param {string} options.color - Target color (e.g., "forest green", "navy blue")
 * @param {string} options.garmentType - Type of garment (e.g., "t-shirt", "hoodie")
 * @param {Object} options.db - Database instance with getRecoloredModel and saveRecoloredModel methods
 * @param {string} options.replicateApiToken - Replicate API token
 * @param {boolean} options.forceRegenerate - Force regeneration even if cached
 * @returns {Promise<{success: boolean, cached: boolean, imagePath: string, cacheKey: string}>}
 */
async function recolorGarment(options = {}) {
  const {
    modelId,
    imagePath,
    color,
    garmentType = 't-shirt',
    db,
    replicateApiToken,
    forceRegenerate = false
  } = options;

  if (!modelId || !imagePath || !color) {
    throw new Error('modelId, imagePath, and color are required');
  }

  if (!replicateApiToken) {
    throw new Error('REPLICATE_API_TOKEN is required');
  }

  // Validate image exists
  if (!fs.existsSync(imagePath)) {
    throw new Error(`Image not found: ${imagePath}`);
  }

  // Check cache
  const cacheKey = getCacheKey(modelId, color, garmentType);

  // Check database cache first
  if (!forceRegenerate && db && db.getRecoloredModel) {
    const cached = db.getRecoloredModel(modelId, color, garmentType);
    if (cached && cached.filePath && fs.existsSync(cached.filePath)) {
      console.log(`[Recolor] Found cached image: ${cached.filePath}`);
      return {
        success: true,
        cached: true,
        imagePath: cached.filePath,
        webPath: cached.webPath,
        cacheKey
      };
    }
  }

  // Check filesystem cache
  const cachePath = getCachePath(cacheKey);
  if (!forceRegenerate && hasCachedImage(cacheKey)) {
    console.log(`[Recolor] Found cached file: ${cachePath}`);
    return {
      success: true,
      cached: true,
      imagePath: cachePath,
      webPath: `/library/human-models/recolored/${cacheKey}.png`,
      cacheKey
    };
  }

  console.log(`\n[Recolor] Starting garment recolor...`);
  console.log(`  Model: ${modelId}`);
  console.log(`  Image: ${imagePath}`);
  console.log(`  Garment: ${garmentType}`);
  console.log(`  Target Color: ${color}`);

  // Initialize Replicate client
  const Replicate = require('replicate');
  const replicate = new Replicate({
    auth: replicateApiToken
  });

  // Ensure cache directory exists
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }

  // Step 1: Segment the garment
  const maskUrl = await segmentGarment(replicate, imagePath, garmentType);
  console.log(`  [Recolor] Mask generated`);

  // Step 2: Inpaint with new color
  const resultUrl = await inpaintGarment(replicate, imagePath, maskUrl, color, garmentType);
  console.log(`  [Recolor] Inpainting complete`);

  // Step 3: Download and save result
  await downloadImage(resultUrl, cachePath);
  console.log(`  [Recolor] Saved: ${cachePath}`);

  // Step 4: Save to database
  if (db && db.saveRecoloredModel) {
    db.saveRecoloredModel({
      modelId,
      color,
      garmentType,
      filePath: cachePath,
      webPath: `/library/human-models/recolored/${cacheKey}.png`,
      cacheKey
    });
    console.log(`  [Recolor] Saved to database`);
  }

  return {
    success: true,
    cached: false,
    imagePath: cachePath,
    webPath: `/library/human-models/recolored/${cacheKey}.png`,
    cacheKey
  };
}

/**
 * Batch recolor a model into multiple colors
 */
async function batchRecolor(options = {}) {
  const {
    modelId,
    imagePath,
    colors = [],
    garmentType = 't-shirt',
    db,
    replicateApiToken
  } = options;

  console.log(`\n[Recolor] BATCH: ${colors.length} color variations`);

  const results = [];

  for (let i = 0; i < colors.length; i++) {
    const color = colors[i];
    console.log(`\n[${i + 1}/${colors.length}] Processing: ${color}`);

    try {
      const result = await recolorGarment({
        modelId,
        imagePath,
        color,
        garmentType,
        db,
        replicateApiToken
      });
      results.push({ color, ...result });
    } catch (error) {
      console.error(`  [Recolor] Failed: ${error.message}`);
      results.push({ color, success: false, error: error.message });
    }

    // Small delay between API calls
    if (i < colors.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  // Summary
  const successful = results.filter(r => r.success).length;
  const cached = results.filter(r => r.cached).length;
  console.log(`\n[Recolor] BATCH COMPLETE`);
  console.log(`  Total: ${results.length}`);
  console.log(`  Successful: ${successful}`);
  console.log(`  From Cache: ${cached}`);
  console.log(`  New API Calls: ${successful - cached}`);

  return results;
}

/**
 * Clear cached images for a model
 */
function clearCache(modelId) {
  const files = fs.readdirSync(CACHE_DIR);
  let cleared = 0;
  for (const file of files) {
    if (file.startsWith(`${modelId}_`)) {
      fs.unlinkSync(path.join(CACHE_DIR, file));
      cleared++;
    }
  }
  return cleared;
}

/**
 * List all cached color variants for a model
 */
function listCachedVariants(modelId) {
  if (!fs.existsSync(CACHE_DIR)) return [];
  const files = fs.readdirSync(CACHE_DIR);
  return files
    .filter(f => f.startsWith(`${modelId}_`) && f.endsWith('.png'))
    .map(f => {
      const parts = f.replace('.png', '').split('_');
      return {
        file: f,
        modelId: parts[0],
        garmentType: parts[1],
        color: parts.slice(2).join(' ').replace(/-/g, ' ')
      };
    });
}

module.exports = {
  init,
  recolorGarment,
  batchRecolor,
  getCacheKey,
  getCachePath,
  hasCachedImage,
  clearCache,
  listCachedVariants,
  REPLICATE_MODELS
};
