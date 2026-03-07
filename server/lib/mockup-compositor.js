/**
 * @deprecated — For apparel mockups, use server/ai-apparel-mockup.js instead,
 * which uses Gemini AI for natural fabric-aware graphic placement.
 * This file is retained because facebook-post-scheduler.js and sales-pipeline-monitor.js
 * still import compositeArtwork/generateMockupToFile for non-apparel mockups.
 *
 * Mockup Compositor (LEGACY) - Dynamically composites artwork onto mockup templates
 *
 * This module takes a base mockup image and overlays artwork at a specified
 * position with transformations (scale, rotation, perspective).
 */

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

/**
 * Mockup Template Schema:
 * {
 *   id: string,                    // Unique template ID
 *   campaignSlug: string,          // Associated campaign
 *   name: string,                  // Friendly name
 *   mockupImagePath: string,       // Path to base mockup image
 *   artworkPosition: {
 *     x: number,                   // X position (pixels from left)
 *     y: number,                   // Y position (pixels from top)
 *     width: number,               // Target width for artwork
 *     height: number,              // Target height for artwork
 *     rotation: number,            // Rotation in degrees (0-360)
 *     opacity: number,             // Opacity (0-1, default 1)
 *   },
 *   blendMode: string,             // 'normal', 'multiply', 'overlay' (default: 'normal')
 *   outputFormat: 'jpeg' | 'png',  // Output format
 *   outputQuality: number,         // Quality (1-100)
 * }
 */

/**
 * Load and validate a mockup template
 */
function validateTemplate(template) {
  const required = ['mockupImagePath', 'artworkPosition'];
  for (const field of required) {
    if (!template[field]) {
      throw new Error(`Missing required field: ${field}`);
    }
  }

  const pos = template.artworkPosition;
  if (typeof pos.x !== 'number' || typeof pos.y !== 'number') {
    throw new Error('artworkPosition must have numeric x and y');
  }
  if (typeof pos.width !== 'number' || typeof pos.height !== 'number') {
    throw new Error('artworkPosition must have numeric width and height');
  }

  return {
    ...template,
    artworkPosition: {
      x: Math.round(pos.x),
      y: Math.round(pos.y),
      width: Math.round(pos.width),
      height: Math.round(pos.height),
      rotation: pos.rotation || 0,
      opacity: pos.opacity ?? 1,
    },
    blendMode: template.blendMode || 'normal',
    outputFormat: template.outputFormat || 'jpeg',
    outputQuality: template.outputQuality || 90,
  };
}

/**
 * Composite artwork onto a mockup template
 *
 * @param {Object} template - The mockup template configuration
 * @param {string|Buffer} artworkInput - Path to artwork or buffer
 * @param {Object} options - Additional options
 * @returns {Promise<Buffer>} - The composited image buffer
 */
async function compositeArtwork(template, artworkInput, options = {}) {
  const config = validateTemplate(template);
  const pos = config.artworkPosition;

  // Load the base mockup image
  let mockupBuffer;
  if (Buffer.isBuffer(template.mockupImagePath)) {
    mockupBuffer = template.mockupImagePath;
  } else if (fs.existsSync(template.mockupImagePath)) {
    mockupBuffer = fs.readFileSync(template.mockupImagePath);
  } else {
    throw new Error(`Mockup image not found: ${template.mockupImagePath}`);
  }

  // Get mockup dimensions
  const mockupMeta = await sharp(mockupBuffer).metadata();

  // Load and process the artwork
  let artworkBuffer;
  if (Buffer.isBuffer(artworkInput)) {
    artworkBuffer = artworkInput;
  } else if (fs.existsSync(artworkInput)) {
    artworkBuffer = fs.readFileSync(artworkInput);
  } else {
    throw new Error(`Artwork image not found: ${artworkInput}`);
  }

  // Resize artwork to fit the designated area
  let processedArtwork = sharp(artworkBuffer)
    .resize(pos.width, pos.height, {
      fit: options.artworkFit || 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    });

  // Apply rotation if specified
  if (pos.rotation !== 0) {
    processedArtwork = processedArtwork.rotate(pos.rotation, {
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    });
  }

  // Convert to buffer for compositing
  const artworkProcessed = await processedArtwork.png().toBuffer();

  // Get processed artwork dimensions (may change if rotated)
  const artworkMeta = await sharp(artworkProcessed).metadata();

  // Calculate centered position after rotation
  let finalX = pos.x;
  let finalY = pos.y;

  if (pos.rotation !== 0) {
    // Adjust position to center the rotated artwork
    const widthDiff = artworkMeta.width - pos.width;
    const heightDiff = artworkMeta.height - pos.height;
    finalX = Math.round(pos.x - widthDiff / 2);
    finalY = Math.round(pos.y - heightDiff / 2);
  }

  // Build composite operation
  const compositeOptions = {
    input: artworkProcessed,
    left: finalX,
    top: finalY,
  };

  // Apply blend mode if supported
  if (config.blendMode === 'multiply') {
    compositeOptions.blend = 'multiply';
  } else if (config.blendMode === 'overlay') {
    compositeOptions.blend = 'overlay';
  }

  // Composite the images
  let result = sharp(mockupBuffer)
    .composite([compositeOptions]);

  // Output in desired format
  if (config.outputFormat === 'png') {
    result = result.png({ quality: config.outputQuality });
  } else {
    result = result.jpeg({ quality: config.outputQuality });
  }

  return result.toBuffer();
}

/**
 * Generate a mockup with artwork and save to file
 */
async function generateMockupToFile(template, artworkInput, outputPath, options = {}) {
  const buffer = await compositeArtwork(template, artworkInput, options);

  // Ensure output directory exists
  const outputDir = path.dirname(outputPath);
  fs.mkdirSync(outputDir, { recursive: true });

  fs.writeFileSync(outputPath, buffer);

  return {
    path: outputPath,
    size: buffer.length,
  };
}

/**
 * Create a mockup template by analyzing where artwork appears in an existing mockup
 * This is a helper for creating templates from existing campaign mockups
 *
 * @param {string} mockupWithArtwork - Path to mockup that already has artwork
 * @param {string} baseMockup - Path to the same mockup without artwork (background only)
 * @param {Object} manualPosition - Manual position override {x, y, width, height}
 */
async function createTemplateFromExisting(mockupWithArtwork, baseMockup, manualPosition) {
  // For now, this requires manual position input
  // In the future, we could use image diff to detect artwork region

  if (!manualPosition) {
    throw new Error('Manual position required. Provide {x, y, width, height}');
  }

  const mockupMeta = await sharp(baseMockup).metadata();

  return {
    mockupImagePath: baseMockup,
    artworkPosition: {
      x: manualPosition.x,
      y: manualPosition.y,
      width: manualPosition.width,
      height: manualPosition.height,
      rotation: manualPosition.rotation || 0,
      opacity: manualPosition.opacity || 1,
    },
    mockupDimensions: {
      width: mockupMeta.width,
      height: mockupMeta.height,
    },
    blendMode: 'normal',
    outputFormat: 'jpeg',
    outputQuality: 90,
  };
}

/**
 * Batch generate mockups for multiple artworks using the same template
 */
async function batchGenerateMockups(template, artworks, outputDir, options = {}) {
  const results = [];

  fs.mkdirSync(outputDir, { recursive: true });

  for (let i = 0; i < artworks.length; i++) {
    const artwork = artworks[i];
    const artworkPath = artwork.path || artwork;
    const artworkName = artwork.name || path.basename(artworkPath, path.extname(artworkPath));

    const outputPath = path.join(
      outputDir,
      `${artworkName}-mockup.${template.outputFormat || 'jpg'}`
    );

    try {
      const result = await generateMockupToFile(template, artworkPath, outputPath, options);
      results.push({
        success: true,
        artwork: artworkPath,
        artworkName,
        output: result.path,
        size: result.size,
      });
    } catch (error) {
      results.push({
        success: false,
        artwork: artworkPath,
        artworkName,
        error: error.message,
      });
    }

    // Report progress if callback provided
    if (options.onProgress) {
      options.onProgress(i + 1, artworks.length, results[results.length - 1]);
    }
  }

  return results;
}

/**
 * Preview a template by generating a sample mockup
 * Returns base64 for immediate display
 */
async function previewTemplate(template, artworkInput) {
  const buffer = await compositeArtwork(template, artworkInput);

  // Resize for preview
  const preview = await sharp(buffer)
    .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();

  return {
    base64: preview.toString('base64'),
    mimeType: 'image/jpeg',
    dataUrl: `data:image/jpeg;base64,${preview.toString('base64')}`,
  };
}

module.exports = {
  validateTemplate,
  compositeArtwork,
  generateMockupToFile,
  createTemplateFromExisting,
  batchGenerateMockups,
  previewTemplate,
};
