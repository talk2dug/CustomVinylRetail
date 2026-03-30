/**
 * Nano Banana Service - High-Level Image Processing Service
 * Wraps NanoBananaAI with feature-specific methods for:
 * - Text-to-image generation
 * - Image editing
 * - Vectorization
 * - Scene generation (metal prints, apparel, multiboard)
 * - Art modification (aspect ratio, crop, variations)
 * - Batch processing
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { NanoBananaAI, MODELS, STYLES, ASPECT_RATIOS } = require('./nano-banana-ai');

// Common color name lookup for AI prompts
function hexToColorName(hex) {
  const colors = {
    '#000000': 'black', '#ffffff': 'white', '#ff0000': 'red', '#00ff00': 'green',
    '#0000ff': 'blue', '#ffff00': 'yellow', '#ff00ff': 'magenta', '#00ffff': 'cyan',
    '#808080': 'gray', '#800000': 'maroon', '#808000': 'olive', '#008000': 'dark green',
    '#800080': 'purple', '#008080': 'teal', '#000080': 'navy', '#ffa500': 'orange',
    '#ffc0cb': 'pink', '#a52a2a': 'brown', '#f5f5dc': 'beige', '#d2691e': 'chocolate',
    '#dc143c': 'crimson', '#ff6347': 'tomato red', '#4169e1': 'royal blue',
    '#228b22': 'forest green', '#daa520': 'goldenrod', '#b22222': 'firebrick red',
    '#2f4f4f': 'dark slate gray', '#556b2f': 'dark olive green',
  };
  const h = hex.toLowerCase();
  if (colors[h]) return colors[h];

  // Approximate by hue
  const r = parseInt(h.slice(1, 3), 16), g = parseInt(h.slice(3, 5), 16), b = parseInt(h.slice(5, 7), 16);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const brightness = (r + g + b) / 3;
  if (max - min < 20) return brightness > 200 ? 'light gray' : brightness > 100 ? 'gray' : 'dark gray';
  if (r > g && r > b) return brightness > 170 ? 'light red' : 'red';
  if (g > r && g > b) return brightness > 170 ? 'light green' : 'green';
  if (b > r && b > g) return brightness > 170 ? 'light blue' : 'blue';
  if (r > 200 && g > 150 && b < 100) return 'orange';
  if (r > 200 && g < 100 && b > 150) return 'pink';
  return `color ${hex}`;
}

class NanoBananaService {
  constructor(options = {}) {
    const apiKey = options.apiKey || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is required');
    }

    this.ai = new NanoBananaAI(apiKey, {
      outputDir: options.outputDir,
      model: options.model
    });

    this.outputBaseDir = options.outputDir || path.join(__dirname, '..', 'web', 'images', 'ai-generated');
    this.rateLimitDelay = options.rateLimitDelay || 2000; // ms between requests
  }

  // ============================================================
  // TEXT-TO-IMAGE
  // ============================================================

  /**
   * Standard text-to-image generation
   */
  async generateImage(prompt, options = {}) {
    return this.ai.generate(prompt, options);
  }

  // ============================================================
  // IMAGE EDITING
  // ============================================================

  /**
   * Edit an existing image with a text prompt
   */
  async editImage(inputPath, editPrompt, options = {}) {
    const result = await this.ai.editImage(inputPath, editPrompt, options);

    const savedImages = [];
    for (let i = 0; i < result.images.length; i++) {
      const image = result.images[i];
      const ext = image.mimeType === 'image/jpeg' ? 'jpg' : 'png';
      const filename = this.ai.generateFilename(editPrompt, i, ext);
      const subDir = options.subDir || 'edits';
      const localPath = this.ai.saveImage(image.data, filename, subDir);

      savedImages.push({
        id: require('crypto').randomUUID(),
        generationId: result.generationId,
        prompt: editPrompt,
        sourceImage: inputPath,
        filename,
        localPath,
        operationType: 'edit',
        createdAt: new Date().toISOString()
      });
    }

    return savedImages;
  }

  // ============================================================
  // VECTORIZATION (Requirement 2)
  // ============================================================

  /**
   * Enhance an image to look more vector-like / clean for catalog display
   */
  async vectorizeImage(inputPath, options = {}) {
    const {
      style = 'clean',
      background = 'transparent'
    } = options;

    const prompts = {
      clean: `Transform this image into a clean, professional product image. Make it look like a high-quality vector illustration with sharp edges, clean lines, flat vibrant colors, and minimal gradients. Remove any noise, artifacts, or imperfections. The result should be crisp and professional, suitable for an e-commerce product catalog. ${background === 'transparent' ? 'Place on a clean white background.' : ''}`,
      bold: `Transform this image into a bold, eye-catching vector-style graphic. Use high contrast, vivid colors, sharp clean edges, and strong outlines. Make it look like professional graphic design work with flat color fills and clean shapes. Remove any noise or artifacts.`,
      minimal: `Transform this image into a minimalist vector-style illustration. Use simplified shapes, flat colors, and clean geometric forms. Reduce detail to essential elements while maintaining recognizability. Clean white background.`
    };

    const editPrompt = prompts[style] || prompts.clean;

    const result = await this.ai.editImage(inputPath, editPrompt, options);

    const savedImages = [];
    for (let i = 0; i < result.images.length; i++) {
      const image = result.images[i];
      const basename = path.basename(inputPath, path.extname(inputPath));
      const filename = `${basename}_vectorized_${i}.png`;
      const localPath = this.ai.saveImage(image.data, filename, 'vectorized');

      savedImages.push({
        id: require('crypto').randomUUID(),
        generationId: result.generationId,
        prompt: editPrompt,
        sourceImage: inputPath,
        filename,
        localPath,
        operationType: 'vectorize',
        style,
        createdAt: new Date().toISOString()
      });
    }

    return savedImages;
  }

  // ============================================================
  // SCENE GENERATION (Requirements 3, 4, 6)
  // ============================================================

  /**
   * Place a subject image into a scene
   */
  async generateScene(subjectImagePath, scenePrompt, options = {}) {
    const {
      subDir = 'scenes',
      sceneType = 'custom'
    } = options;

    const result = await this.ai.editImage(subjectImagePath, scenePrompt, options);

    const savedImages = [];
    for (let i = 0; i < result.images.length; i++) {
      const image = result.images[i];
      const ext = image.mimeType === 'image/jpeg' ? 'jpg' : 'png';
      const basename = path.basename(subjectImagePath, path.extname(subjectImagePath));
      const filename = `${basename}_scene_${sceneType}_${i}.${ext}`;
      const localPath = this.ai.saveImage(image.data, filename, subDir);

      savedImages.push({
        id: require('crypto').randomUUID(),
        generationId: result.generationId,
        prompt: scenePrompt,
        sourceImage: subjectImagePath,
        filename,
        localPath,
        operationType: 'scene',
        sceneType,
        createdAt: new Date().toISOString()
      });
    }

    return savedImages;
  }

  // ============================================================
  // ART MODIFICATION (Requirement 5)
  // ============================================================

  /**
   * Change aspect ratio of an artwork using AI outpainting or Sharp cropping
   */
  async changeAspectRatio(imagePath, targetRatio, options = {}) {
    const target = ASPECT_RATIOS[targetRatio];
    if (!target) {
      throw new Error(`Unknown aspect ratio: ${targetRatio}. Available: ${Object.keys(ASPECT_RATIOS).join(', ')}`);
    }

    // Get current dimensions
    const metadata = await sharp(imagePath).metadata();
    const currentRatio = metadata.width / metadata.height;
    const targetRatioNum = target.width / target.height;

    // If we need to expand (outpaint), use Gemini
    if (Math.abs(currentRatio - targetRatioNum) > 0.05) {
      const editPrompt = `Extend this artwork to fill a ${targetRatio} (${target.label}) format (${target.width}x${target.height} pixels). Seamlessly continue the artwork's style, colors, and composition into the newly extended areas. Maintain artistic coherence. Do not crop or cut off any existing content.`;

      const result = await this.ai.editImage(imagePath, editPrompt, options);
      const savedImages = [];

      for (let i = 0; i < result.images.length; i++) {
        const image = result.images[i];
        const basename = path.basename(imagePath, path.extname(imagePath));
        const filename = `${basename}_${targetRatio.replace(':', 'x')}_${i}.png`;

        // Save AI output then resize to exact target dimensions
        const tempPath = this.ai.saveImage(image.data, `temp_${filename}`, 'art-modifications');
        const finalPath = path.join(this.outputBaseDir, 'art-modifications', filename);

        await sharp(tempPath)
          .resize(target.width, target.height, { fit: 'cover' })
          .toFile(finalPath);

        // Clean up temp
        fs.unlinkSync(tempPath);

        savedImages.push({
          id: require('crypto').randomUUID(),
          generationId: result.generationId,
          prompt: editPrompt,
          sourceImage: imagePath,
          filename,
          localPath: finalPath,
          operationType: 'aspect_ratio',
          targetRatio,
          createdAt: new Date().toISOString()
        });
      }

      return savedImages;
    }

    // If ratio is similar, just resize with Sharp (no AI needed)
    const basename = path.basename(imagePath, path.extname(imagePath));
    const filename = `${basename}_${targetRatio.replace(':', 'x')}.png`;
    const outputPath = path.join(this.outputBaseDir, 'art-modifications');
    if (!fs.existsSync(outputPath)) fs.mkdirSync(outputPath, { recursive: true });
    const finalPath = path.join(outputPath, filename);

    await sharp(imagePath)
      .resize(target.width, target.height, { fit: 'cover' })
      .toFile(finalPath);

    return [{
      id: require('crypto').randomUUID(),
      sourceImage: imagePath,
      filename,
      localPath: finalPath,
      operationType: 'resize',
      targetRatio,
      createdAt: new Date().toISOString()
    }];
  }

  /**
   * Create a variation of an existing artwork
   */
  async createVariation(imagePath, variationPrompt, options = {}) {
    const prompt = variationPrompt || 'Create a variation of this artwork with a different color palette and subtle compositional changes, while maintaining the same overall style and subject matter.';

    const result = await this.ai.editImage(imagePath, prompt, options);
    const savedImages = [];

    for (let i = 0; i < result.images.length; i++) {
      const image = result.images[i];
      const ext = image.mimeType === 'image/jpeg' ? 'jpg' : 'png';
      const basename = path.basename(imagePath, path.extname(imagePath));
      const filename = `${basename}_variation_${Date.now()}_${i}.${ext}`;
      const localPath = this.ai.saveImage(image.data, filename, 'art-modifications');

      savedImages.push({
        id: require('crypto').randomUUID(),
        generationId: result.generationId,
        prompt,
        sourceImage: imagePath,
        filename,
        localPath,
        operationType: 'variation',
        createdAt: new Date().toISOString()
      });
    }

    return savedImages;
  }

  /**
   * Iteratively refine an artwork through multiple AI passes
   */
  async iterateArtwork(imagePath, iterationPrompt, numIterations = 3) {
    const iterations = [];
    let currentPath = imagePath;

    for (let i = 0; i < numIterations; i++) {
      console.log(`[NanoBananaService] Iteration ${i + 1}/${numIterations}`);

      const prompt = `${iterationPrompt} (Iteration ${i + 1} of ${numIterations} - progressively refine and improve the quality)`;
      const result = await this.ai.editImage(currentPath, prompt);

      if (result.images.length > 0) {
        const image = result.images[0];
        const ext = image.mimeType === 'image/jpeg' ? 'jpg' : 'png';
        const basename = path.basename(imagePath, path.extname(imagePath));
        const filename = `${basename}_iter${i + 1}_${Date.now()}.${ext}`;
        const localPath = this.ai.saveImage(image.data, filename, 'art-modifications');

        iterations.push({
          iteration: i + 1,
          id: require('crypto').randomUUID(),
          generationId: result.generationId,
          prompt,
          sourceImage: currentPath,
          filename,
          localPath,
          operationType: 'iteration',
          createdAt: new Date().toISOString()
        });

        currentPath = localPath; // Feed output back as input
      }

      // Rate limit
      if (i < numIterations - 1) {
        await new Promise(resolve => setTimeout(resolve, this.rateLimitDelay));
      }
    }

    return iterations;
  }

  /**
   * Smart crop using Sharp's attention-based strategy (no AI needed)
   */
  async smartCrop(imagePath, targetRatio, options = {}) {
    const { focusPoint } = options;
    const target = ASPECT_RATIOS[targetRatio];
    if (!target) {
      throw new Error(`Unknown aspect ratio: ${targetRatio}`);
    }

    const basename = path.basename(imagePath, path.extname(imagePath));
    const filename = `${basename}_cropped_${targetRatio.replace(':', 'x')}.png`;
    const outputPath = path.join(this.outputBaseDir, 'art-modifications');
    if (!fs.existsSync(outputPath)) fs.mkdirSync(outputPath, { recursive: true });
    const finalPath = path.join(outputPath, filename);

    const resizeOptions = {
      fit: 'cover',
      position: focusPoint ? `${focusPoint.x}% ${focusPoint.y}%` : 'attention'
    };

    await sharp(imagePath)
      .resize(target.width, target.height, resizeOptions)
      .toFile(finalPath);

    return [{
      id: require('crypto').randomUUID(),
      sourceImage: imagePath,
      filename,
      localPath: finalPath,
      operationType: 'crop',
      targetRatio,
      createdAt: new Date().toISOString()
    }];
  }

  // ============================================================
  // BATCH PROCESSING
  // ============================================================

  /**
   * Process multiple items with rate limiting
   */
  async processBatch(items, processFn, options = {}) {
    const { onProgress } = options;
    const results = [];

    for (let i = 0; i < items.length; i++) {
      try {
        const result = await processFn(items[i], i);
        results.push({ success: true, index: i, result });
      } catch (error) {
        results.push({ success: false, index: i, error: error.message });
        console.error(`[NanoBananaService] Batch item ${i} failed:`, error.message);
      }

      if (onProgress) {
        onProgress(i + 1, items.length, results[results.length - 1]);
      }

      // Rate limit between requests
      if (i < items.length - 1) {
        await new Promise(resolve => setTimeout(resolve, this.rateLimitDelay));
      }
    }

    return results;
  }

  // ============================================================
  // APPAREL MOCKUP (Multi-Image Compositing)
  // ============================================================

  /**
   * Place a graphic design onto apparel in a model photo using AI
   * Sends both images to Gemini which composites them naturally
   */
  async placeGraphicOnApparel(modelImagePath, graphicPath, options = {}) {
    const sharp = require('sharp');
    const {
      zone = 'front-chest',
      size = 'auto',
      garmentType = 't-shirt',
      adjustX = 0,
      adjustY = 0,
      adjustScale = 100
    } = options;

    // Pre-process: detect if graphic is white-on-transparent and flatten
    // onto a dark background so Gemini can actually see the design
    let processedGraphicPath = graphicPath;
    try {
      const meta = await sharp(graphicPath).metadata();
      if (meta.hasAlpha) {
        const { data, info } = await sharp(graphicPath)
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });

        // Sample visible pixels to determine average color
        let visR = 0, visG = 0, visB = 0, visCount = 0;
        for (let i = 0; i < info.width * info.height; i++) {
          const a = data[i * 4 + 3];
          if (a > 20) {
            visR += data[i * 4];
            visG += data[i * 4 + 1];
            visB += data[i * 4 + 2];
            visCount++;
          }
        }

        if (visCount > 0) {
          const avgBrightness = (visR + visG + visB) / (visCount * 3);
          // If the visible pixels are mostly white/light, flatten onto dark background
          if (avgBrightness > 200) {
            const tmpPath = graphicPath.replace(/\.[^.]+$/, '_flattened.png');
            await sharp(graphicPath)
              .flatten({ background: { r: 30, g: 30, b: 30 } })
              .toFile(tmpPath);
            processedGraphicPath = tmpPath;
            console.log(`[NanoBanana] Pre-processed: white-on-transparent graphic flattened onto dark bg (brightness=${avgBrightness.toFixed(0)})`);
          }
        }
      }
    } catch (err) {
      console.warn(`[NanoBanana] Graphic pre-processing failed, using original: ${err.message}`);
    }

    const zoneDescriptions = {
      'front-chest': 'centered on the chest area of the front of the garment',
      'back': 'centered on the upper back area of the garment',
      'left-sleeve': 'on the outer side of the left sleeve',
      'right-sleeve': 'on the outer side of the right sleeve'
    };

    const sizeDescriptions = {
      'auto': 'appropriately sized for the placement zone',
      'small': 'small, roughly 15-20% of the garment area',
      'medium': 'medium, roughly 30-40% of the garment area',
      'large': 'large, roughly 50-60% of the garment area',
      'full': 'as large as possible, filling most of the available area'
    };

    const zoneDesc = zoneDescriptions[zone] || zoneDescriptions['front-chest'];
    const sizeDesc = sizeDescriptions[size] || sizeDescriptions['auto'];

    // Build position adjustment hints
    const adjustHints = [];
    if (adjustX < -5) adjustHints.push(`shifted ${Math.abs(adjustX)}% to the left of center`);
    else if (adjustX > 5) adjustHints.push(`shifted ${adjustX}% to the right of center`);
    if (adjustY < -5) adjustHints.push(`shifted ${Math.abs(adjustY)}% higher than center`);
    else if (adjustY > 5) adjustHints.push(`shifted ${adjustY}% lower than center`);
    if (adjustScale < 90) adjustHints.push(`${100 - adjustScale}% smaller than default`);
    else if (adjustScale > 110) adjustHints.push(`${adjustScale - 100}% larger than default`);

    const adjustmentLine = adjustHints.length > 0
      ? `\nPosition adjustment: The graphic should be ${adjustHints.join(', ')}.`
      : '';

    const isFlattened = processedGraphicPath !== graphicPath;
    const graphicNote = isFlattened
      ? 'The graphic has a dark background — extract just the visible design elements (the light/white artwork) and apply them to the garment. Do NOT place the dark background rectangle on the shirt.'
      : 'Apply the graphic as-is to the garment.';

    const prompt = `You are given two images:
Image 1: A photo of a person wearing a ${garmentType}
Image 2: A graphic design to print on the garment

${graphicNote}

Place the design from Image 2 ${zoneDesc}.
The graphic should be ${sizeDesc}.${adjustmentLine}

CRITICAL RULES:
- Reproduce the EXACT design from Image 2 — same text, artwork, colors, layout
- Do NOT create, invent, or substitute a different design
- The design must look naturally screen-printed on the fabric
- Follow the fabric's wrinkles, folds, and shadows
- Preserve the person's pose, face, expression exactly
- Hair or hands overlapping the graphic area should appear IN FRONT of the design
- Do NOT change anything else about the image
- Result should look like a professional product photo`;

    const result = await this.ai.compositeImages([modelImagePath, processedGraphicPath], prompt);

    // Clean up temp flattened file
    if (processedGraphicPath !== graphicPath) {
      try { fs.unlinkSync(processedGraphicPath); } catch (_) {}
    }

    // Save the generated image
    const saved = [];
    for (let i = 0; i < result.images.length; i++) {
      const imgData = result.images[i];
      const ext = imgData.mimeType.includes('png') ? 'png' : 'jpg';
      const filename = `apparel_${zone}_${Date.now()}_${i}.${ext}`;
      const savedPath = this.ai.saveImage(imgData.data, filename, 'apparel-mockups');
      saved.push({
        localPath: savedPath,
        filename,
        zone,
        size,
        generationId: result.generationId
      });
    }

    return saved;
  }

  /**
   * Recolor the garment in a model photo using AI
   * Sends the photo to Gemini to change the clothing color naturally
   * @param {string} modelImagePath - Path to the model photo
   * @param {string} targetColor - Hex color string (e.g. '#ff0000')
   * @param {object} options - { garmentType }
   * @returns {object} { localPath, filename }
   */
  async recolorGarment(modelImagePath, targetColor, options = {}) {
    const { garmentType = 't-shirt' } = options;

    // Convert hex to color name for better AI understanding
    const colorName = hexToColorName(targetColor);

    const prompt = `You are given a photo of a person wearing a ${garmentType}.

Change the color of the ${garmentType} to ${colorName} (${targetColor}).

Requirements:
- ONLY change the color of the garment — nothing else
- Keep the exact same person, pose, face, expression, hair, skin, background
- The new color should look completely natural on the fabric
- Preserve all wrinkles, folds, shadows, and fabric texture
- Maintain the same lighting and photography style
- The result should look like the person was originally photographed wearing a ${colorName} ${garmentType}
- Do NOT add any graphics, text, or designs to the garment`;

    const result = await this.ai.editImage(modelImagePath, prompt, options);

    if (!result.images || result.images.length === 0) {
      throw new Error('No image generated for garment recolor');
    }

    const imgData = result.images[0];
    const ext = imgData.mimeType?.includes('png') ? 'png' : 'jpg';
    const safeColor = targetColor.replace('#', '');
    const filename = `recolor_${safeColor}_${Date.now()}.${ext}`;
    const localPath = this.ai.saveImage(imgData.data, filename, 'apparel-mockups');

    console.log(`[NanoBanana] Garment recolored to ${colorName} (${targetColor})`);
    return { localPath, filename };
  }

  /**
   * Remove background from an image using AI
   * Returns the image with background removed (transparent/white)
   */
  async removeBackground(inputPath, options = {}) {
    const editPrompt = 'Remove the background from this image completely. Keep only the main subject/graphic with a clean transparent or white background. Preserve every detail, color, and edge of the subject perfectly. The result should have crisp, clean edges suitable for overlaying on other images.';

    const result = await this.ai.editImage(inputPath, editPrompt, options);

    const savedImages = [];
    for (let i = 0; i < result.images.length; i++) {
      const image = result.images[i];
      const basename = path.basename(inputPath, path.extname(inputPath));
      const filename = `${basename}_nobg_${i}.png`;
      const localPath = this.ai.saveImage(image.data, filename, 'background-removed');

      savedImages.push({
        id: require('crypto').randomUUID(),
        generationId: result.generationId,
        sourceImage: inputPath,
        filename,
        localPath,
        operationType: 'remove-background',
        createdAt: new Date().toISOString()
      });
    }

    return savedImages;
  }

  /**
   * Get the underlying AI client for direct access
   */
  getAI() {
    return this.ai;
  }
}

module.exports = { NanoBananaService, MODELS, STYLES, ASPECT_RATIOS };
