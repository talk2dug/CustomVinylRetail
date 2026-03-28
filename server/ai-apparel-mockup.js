/**
 * AI Apparel Mockup Service
 * Uses Gemini multi-image compositing to place graphics on apparel naturally.
 * Supports multi-placement (front, back, sleeves), sequential compositing,
 * and side-by-side combined output.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const crypto = require('crypto');
const { NanoBananaService } = require('./nano-banana-service');

class AiApparelMockupService {
  constructor(options = {}) {
    this.service = options.service || new NanoBananaService(options);
    this.outputDir = path.join(
      options.outputDir || path.join(__dirname, '..', 'web', 'images', 'ai-generated'),
      'apparel-mockups'
    );

    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  /**
   * Place a single graphic on a model photo
   * @param {string} modelImagePath - Path to human model photo
   * @param {string} graphicPath - Path to graphic/design image
   * @param {object} options - { zone, size, garmentType }
   * @returns {object} { imagePath, zone, size, generationId }
   */
  async placeGraphic(modelImagePath, graphicPath, options = {}) {
    const results = await this.service.placeGraphicOnApparel(modelImagePath, graphicPath, options);

    if (results.length === 0) {
      throw new Error('No image generated from Gemini');
    }

    return results[0];
  }

  /**
   * Place multiple graphics sequentially on a model photo
   * Each pass feeds the result of the previous pass back to Gemini
   * @param {string} modelImagePath - Path to human model photo
   * @param {Array} placements - [{ graphicPath, zone, size }, ...]
   * @param {object} options - { garmentType }
   * @returns {object} { imagePath, placements }
   */
  async placeMultipleGraphics(modelImagePath, placements, options = {}) {
    if (!placements || placements.length === 0) {
      throw new Error('At least one placement is required');
    }

    let currentImagePath = modelImagePath;

    for (let i = 0; i < placements.length; i++) {
      const placement = placements[i];
      console.log(`[AiApparel] Placement ${i + 1}/${placements.length}: ${placement.zone} (${placement.size || 'auto'})`);

      const result = await this.placeGraphic(currentImagePath, placement.graphicPath, {
        zone: placement.zone,
        size: placement.size || 'auto',
        garmentType: options.garmentType || 't-shirt',
        adjustX: placement.adjustX || 0,
        adjustY: placement.adjustY || 0,
        adjustScale: placement.adjustScale || 100
      });

      currentImagePath = result.localPath;

      // Rate limit between sequential passes
      if (i < placements.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    return {
      imagePath: currentImagePath,
      placements: placements.map(p => ({ zone: p.zone, size: p.size }))
    };
  }

  /**
   * Generate a full mockup with front and/or back views
   * @param {object} options
   * @param {object} options.db - Database instance (for loading model images)
   * @param {string} options.modelFrontId - Human model ID for front view
   * @param {string} options.modelBackId - Human model ID for back view
   * @param {string} options.clothingColor - Optional hex color for clothing tint
   * @param {Array} options.placements - Front placements [{ graphicPath, zone, size }]
   * @param {Array} options.backPlacements - Back placements [{ graphicPath, zone, size }]
   * @param {string} options.garmentType - t-shirt, hoodie, etc.
   * @returns {object} { front, back }
   */
  async generateMockup(options = {}) {
    const {
      db,
      modelFrontId,
      modelBackId,
      modelFrontPath,
      modelBackPath,
      clothingColor,
      placements = [],
      backPlacements = [],
      garmentType = 't-shirt'
    } = options;

    const result = { front: null, back: null };

    // Process front view — supports direct path OR DB lookup by ID
    if ((modelFrontId || modelFrontPath) && placements.length > 0) {
      console.log('[AiApparel] Generating front view...');
      let frontModelPath;
      if (modelFrontPath && fs.existsSync(modelFrontPath)) {
        frontModelPath = modelFrontPath;
      } else if (modelFrontId) {
        frontModelPath = await this._getModelImagePath(db, modelFrontId, clothingColor, garmentType);
      } else {
        throw new Error('No valid front model image path');
      }

      result.front = await this.placeMultipleGraphics(frontModelPath, placements, { garmentType });
    }

    // Rate limit between views
    if (result.front && (modelBackId || modelBackPath) && backPlacements.length > 0) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // Process back view — supports direct path OR DB lookup by ID
    if ((modelBackId || modelBackPath) && backPlacements.length > 0) {
      console.log('[AiApparel] Generating back view...');
      let backModelPath;
      if (modelBackPath && fs.existsSync(modelBackPath)) {
        backModelPath = modelBackPath;
      } else if (modelBackId) {
        backModelPath = await this._getModelImagePath(db, modelBackId, clothingColor, garmentType);
      } else {
        throw new Error('No valid back model image path');
      }

      result.back = await this.placeMultipleGraphics(backModelPath, backPlacements, { garmentType });
    }

    return result;
  }

  /**
   * Create a side-by-side composite of front and back views
   * @param {string} frontPath - Path to front mockup image
   * @param {string} backPath - Path to back mockup image
   * @returns {string} Path to combined image
   */
  async createSideBySide(frontPath, backPath) {
    const targetHeight = 1024;
    const gap = 20;

    // Resize both to same height
    const frontResized = await sharp(frontPath)
      .resize({ height: targetHeight, withoutEnlargement: true })
      .toBuffer({ resolveWithObject: true });

    const backResized = await sharp(backPath)
      .resize({ height: targetHeight, withoutEnlargement: true })
      .toBuffer({ resolveWithObject: true });

    const totalWidth = frontResized.info.width + gap + backResized.info.width;

    const filename = `combined_${crypto.randomUUID().slice(0, 8)}.png`;
    const outputPath = path.join(this.outputDir, filename);

    await sharp({
      create: {
        width: totalWidth,
        height: targetHeight,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 }
      }
    })
      .composite([
        { input: frontResized.data, left: 0, top: 0 },
        { input: backResized.data, left: frontResized.info.width + gap, top: 0 }
      ])
      .png()
      .toFile(outputPath);

    console.log(`[AiApparel] Side-by-side created: ${filename}`);
    return outputPath;
  }

  /**
   * Full pipeline: generate front + back + combined
   */
  async generateFullMockupSet(options = {}) {
    const { generateSideBySide = true, ...mockupOptions } = options;

    const result = await this.generateMockup(mockupOptions);

    // Create side-by-side if we have both views
    if (generateSideBySide && result.front && result.back) {
      console.log('[AiApparel] Creating side-by-side composite...');
      result.combined = {
        imagePath: await this.createSideBySide(result.front.imagePath, result.back.imagePath)
      };
    }

    return result;
  }

  /**
   * Get model image path from DB, optionally applying clothing color tint
   * @private
   */
  async _getModelImagePath(db, modelId, clothingColor, garmentType) {
    if (!db) {
      throw new Error('Database instance required to load human models');
    }

    const model = db.prepare('SELECT * FROM human_models WHERE id = ?').get(modelId);
    if (!model) {
      throw new Error(`Human model not found: ${modelId}`);
    }

    let imagePath = model.optimized_path || model.file_path;
    if (!imagePath) {
      throw new Error(`Human model ${modelId} has no image path`);
    }

    // Resolve /library/ paths to filesystem
    if (!path.isAbsolute(imagePath) || imagePath.startsWith('/library/')) {
      const LIBRARY_ROOT = process.env.LIBRARY_ROOT || path.join(__dirname, '..', 'web', 'library');
      const relPath = imagePath.replace(/^\/library\//, '').replace(/^library\//, '');
      imagePath = path.join(LIBRARY_ROOT, relPath);
    }

    if (!fs.existsSync(imagePath)) {
      throw new Error(`Model image not found on disk: ${imagePath}`);
    }

    // If clothing color specified and not white, try to apply tint
    if (clothingColor && clothingColor !== '#ffffff' && clothingColor !== '#FFFFFF') {
      return this._applyClothingColor(imagePath, clothingColor, modelId, garmentType);
    }

    return imagePath;
  }

  /**
   * Apply clothing color change using Gemini AI
   * Sends the model photo to Gemini to naturally recolor the garment
   * Results are cached by model+color combo
   * @private
   */
  async _applyClothingColor(imagePath, targetColor, modelId, garmentType) {
    // Check for cached recolored version
    const cacheKey = `ai_recolor_${modelId}_${targetColor.replace('#', '')}`;
    const cachedPath = path.join(this.outputDir, `${cacheKey}.png`);

    if (fs.existsSync(cachedPath)) {
      console.log(`[AiApparel] Using cached recolor: ${path.basename(cachedPath)}`);
      return cachedPath;
    }

    console.log(`[AiApparel] AI recoloring garment to ${targetColor}...`);
    const result = await this.service.recolorGarment(imagePath, targetColor, {
      garmentType: garmentType || 't-shirt'
    });

    // Copy to cached path for future reuse
    fs.copyFileSync(result.localPath, cachedPath);
    console.log(`[AiApparel] Recolor cached: ${path.basename(cachedPath)}`);
    return cachedPath;
  }

  /**
   * Get available placement zones
   */
  static getZones() {
    return [
      { id: 'front-chest', label: 'Front (Chest)' },
      { id: 'back', label: 'Back' },
      { id: 'left-sleeve', label: 'Left Sleeve' },
      { id: 'right-sleeve', label: 'Right Sleeve' }
    ];
  }

  /**
   * Get available size presets
   */
  static getSizes() {
    return [
      { id: 'auto', label: 'Auto (AI decides)' },
      { id: 'small', label: 'Small' },
      { id: 'medium', label: 'Medium' },
      { id: 'large', label: 'Large' },
      { id: 'full', label: 'Full' }
    ];
  }
}

module.exports = { AiApparelMockupService };
