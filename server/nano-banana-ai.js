/**
 * Nano Banana AI - Google Gemini API Image Client
 * Replaces Leonardo.ai for image generation and editing
 * Uses @google/generative-ai SDK for programmatic control
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Gemini Models for image generation
const MODELS = {
  GEMINI_2_FLASH: 'gemini-2.0-flash-exp',
  IMAGEN_3: 'imagen-3.0-generate-002',
  GEMINI_2_FLASH_THINKING: 'gemini-2.0-flash-thinking-exp',
};

// Prompt-based style descriptors (replaces Leonardo style UUIDs)
const STYLES = {
  CINEMATIC: 'cinematic lighting, dramatic shadows, film grain, widescreen composition',
  PHOTOREALISTIC: 'photorealistic, hyperdetailed, 8K resolution, natural lighting',
  THREE_D_RENDER: '3D render, volumetric lighting, physically-based rendering, clean geometry',
  ILLUSTRATION: 'digital illustration, clean lines, vibrant colors, artistic composition',
  PORTRAIT: 'portrait photography, studio lighting, shallow depth of field, sharp focus',
  FASHION: 'fashion photography, editorial style, professional lighting, commercial quality',
  BOKEH: 'bokeh background, shallow depth of field, dreamy atmosphere, soft highlights',
  VECTOR: 'clean vector style, flat colors, sharp edges, minimal gradients, graphic design',
  PRODUCT: 'product photography, studio lighting, white background, commercial quality'
};

// Common aspect ratios and their dimensions (same as Leonardo for compatibility)
const ASPECT_RATIOS = {
  '1:1': { width: 1024, height: 1024, label: 'Square' },
  '4:3': { width: 1024, height: 768, label: 'Standard' },
  '3:4': { width: 768, height: 1024, label: 'Portrait' },
  '16:9': { width: 1344, height: 768, label: 'Widescreen' },
  '9:16': { width: 768, height: 1344, label: 'Vertical/Stories' },
  '3:2': { width: 1152, height: 768, label: 'Photo' },
  '2:3': { width: 768, height: 1152, label: 'Photo Portrait' },
  '8x10': { width: 832, height: 1024, label: '8x10 Print' },
  '10x8': { width: 1024, height: 832, label: '10x8 Print' },
  '12x12': { width: 1024, height: 1024, label: '12x12 Print' }
};

class NanoBananaAI {
  constructor(apiKey, options = {}) {
    if (!apiKey) {
      throw new Error('Gemini API key is required');
    }
    this.apiKey = apiKey;
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.defaultModel = options.model || MODELS.GEMINI_2_FLASH;
    this.outputDir = options.outputDir || path.join(__dirname, '..', 'web', 'images', 'ai-generated');

    // Ensure output directory exists
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  /**
   * Text-to-image generation via Gemini
   */
  async createGeneration(prompt, options = {}) {
    const {
      aspectRatio = '1:1',
      numImages = 1,
      model = this.defaultModel,
      style = null
    } = options;

    const dimensions = ASPECT_RATIOS[aspectRatio] || ASPECT_RATIOS['1:1'];

    // Enhance prompt with aspect ratio guidance and style
    let enhancedPrompt = prompt;
    if (style && STYLES[style]) {
      enhancedPrompt += `. ${STYLES[style]}`;
    }
    enhancedPrompt += `. Image dimensions: ${dimensions.width}x${dimensions.height} pixels, ${dimensions.label} format.`;

    console.log(`[NanoBanana] Creating generation: ${prompt.substring(0, 50)}...`);
    console.log(`[NanoBanana] Target: ${dimensions.width}x${dimensions.height} (${aspectRatio})`);

    const generationId = crypto.randomUUID();
    const images = [];

    for (let i = 0; i < Math.min(numImages, 4); i++) {
      try {
        const genModel = this.genAI.getGenerativeModel({
          model,
          generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
          },
        });

        const result = await genModel.generateContent(enhancedPrompt);
        const response = result.response;

        // Extract image parts from response
        for (const part of response.candidates[0].content.parts) {
          if (part.inlineData) {
            images.push({
              data: part.inlineData.data,
              mimeType: part.inlineData.mimeType
            });
          }
        }
      } catch (err) {
        console.error(`[NanoBanana] Generation ${i + 1} failed:`, err.message);
        // If it's a model-specific error, try to provide helpful info
        if (err.message.includes('not found') || err.message.includes('not supported')) {
          console.error(`[NanoBanana] Model "${model}" may not support image generation. Try a different model.`);
        }
        throw err;
      }

      // Rate limit delay between multiple generations
      if (i < numImages - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    return {
      generationId,
      images,
      width: dimensions.width,
      height: dimensions.height,
      aspectRatio
    };
  }

  /**
   * Edit an existing image with a text prompt
   */
  async editImage(imagePath, editPrompt, options = {}) {
    const {
      model = this.defaultModel,
      outputFormat = 'png'
    } = options;

    if (!fs.existsSync(imagePath)) {
      throw new Error(`Image not found: ${imagePath}`);
    }

    const imageBuffer = fs.readFileSync(imagePath);
    const base64Image = imageBuffer.toString('base64');
    const ext = path.extname(imagePath).toLowerCase().slice(1);
    const mimeType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;

    console.log(`[NanoBanana] Editing image: ${path.basename(imagePath)}`);
    console.log(`[NanoBanana] Edit prompt: ${editPrompt.substring(0, 80)}...`);

    const genModel = this.genAI.getGenerativeModel({
      model,
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
      },
    });

    const result = await genModel.generateContent([
      { text: editPrompt },
      {
        inlineData: {
          mimeType,
          data: base64Image
        }
      }
    ]);

    const response = result.response;
    const generationId = crypto.randomUUID();
    const images = [];

    for (const part of response.candidates[0].content.parts) {
      if (part.inlineData) {
        images.push({
          data: part.inlineData.data,
          mimeType: part.inlineData.mimeType
        });
      }
    }

    if (images.length === 0) {
      // Check if there was a text response (might indicate the model couldn't generate an image)
      const textParts = response.candidates[0].content.parts.filter(p => p.text);
      const textResponse = textParts.map(p => p.text).join(' ');
      throw new Error(`No image generated. Model response: ${textResponse.substring(0, 200)}`);
    }

    return {
      generationId,
      images,
      sourceImage: imagePath
    };
  }

  /**
   * Save base64 image data to file
   */
  saveImage(imageData, filename, subDir = '') {
    const outputPath = subDir
      ? path.join(this.outputDir, subDir)
      : this.outputDir;

    if (!fs.existsSync(outputPath)) {
      fs.mkdirSync(outputPath, { recursive: true });
    }

    const buffer = Buffer.from(imageData, 'base64');
    const filepath = path.join(outputPath, filename);
    fs.writeFileSync(filepath, buffer);

    console.log(`[NanoBanana] Saved: ${filename}`);
    return filepath;
  }

  /**
   * Generate filename from prompt
   */
  generateFilename(prompt, index = 0, ext = 'png') {
    const cleanPrompt = prompt
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(word => word.length > 2)
      .slice(0, 5)
      .join('-');

    const timestamp = Date.now();
    const hash = crypto.createHash('md5').update(prompt + timestamp).digest('hex').substring(0, 6);

    return `${cleanPrompt}-${hash}-${index}.${ext}`;
  }

  /**
   * Extract tags from prompt (carried over from Leonardo, updated source tags)
   */
  extractTags(prompt) {
    const tags = new Set();

    tags.add('gemini-ai');
    tags.add('ai-generated');

    // Vehicle patterns
    const vehiclePatterns = [
      /\b(nissan|toyota|honda|mazda|subaru|mitsubishi|acura)\b/gi,
      /\b(ford|chevrolet|chevy|dodge|corvette|mustang|camaro|viper)\b/gi,
      /\b(bmw|mercedes|audi|porsche|lamborghini|ferrari)\b/gi,
      /\b(gt-r|supra|rx-7|nsx|wrx|sti|evo|gtr)\b/gi,
      /\b(rally|wrc|group b|racing|drift)\b/gi,
      /\b(sedan|coupe|hatchback|convertible|supercar)\b/gi
    ];

    vehiclePatterns.forEach(pattern => {
      const matches = prompt.match(pattern);
      if (matches) {
        matches.forEach(m => tags.add(m.toLowerCase().replace(/\s+/g, '-')));
      }
    });

    // Colors
    const colorMatches = prompt.match(/\b(red|blue|white|black|yellow|green|orange|silver|gold|gray|grey|purple|pink)\b/gi);
    if (colorMatches) {
      colorMatches.forEach(c => tags.add(c.toLowerCase()));
    }

    // Style keywords
    const styleMatches = prompt.match(/\b(photorealistic|cinematic|dramatic|studio|metallic|matte|glossy|chrome|vector|illustration)\b/gi);
    if (styleMatches) {
      styleMatches.forEach(s => tags.add(s.toLowerCase()));
    }

    // Category hints
    if (/room|interior|living|bedroom|office|kitchen/i.test(prompt)) {
      tags.add('mockup');
      tags.add('room');
    }
    if (/model|person|woman|man|wearing/i.test(prompt)) {
      tags.add('mockup');
      tags.add('model');
    }
    if (/car|vehicle|truck|motorcycle/i.test(prompt)) {
      tags.add('vehicle');
      tags.add('product');
    }
    if (/metal print|sublimation|black background/i.test(prompt)) {
      tags.add('metal-print');
      tags.add('product');
    }
    if (/multiboard|organizer|wall mount/i.test(prompt)) {
      tags.add('multiboard');
      tags.add('product');
    }
    if (/apparel|shirt|hoodie|hat|beanie/i.test(prompt)) {
      tags.add('apparel');
      tags.add('mockup');
    }

    return Array.from(tags);
  }

  /**
   * Determine category from prompt
   */
  categorizePrompt(prompt) {
    const lowerPrompt = prompt.toLowerCase();

    if (/room|interior|living|bedroom|office|kitchen|wall|decor/i.test(lowerPrompt)) {
      return 'mockups/rooms';
    }
    if (/model|person|woman|man|wearing|fashion|apparel/i.test(lowerPrompt)) {
      return 'mockups/models';
    }
    if (/car|vehicle|truck|motorcycle|rally|racing/i.test(lowerPrompt)) {
      return 'products/vehicles';
    }
    if (/multiboard|organizer|wall mount|pegboard/i.test(lowerPrompt)) {
      return 'products/multiboard';
    }
    if (/marketing|ad|advertisement|promotional|banner/i.test(lowerPrompt)) {
      return 'marketing';
    }
    if (/art|artwork|print|poster|illustration/i.test(lowerPrompt)) {
      return 'products/artwork';
    }

    return 'uncategorized';
  }

  /**
   * Full pipeline: Generate, save, tag, and return metadata
   */
  async generate(prompt, options = {}) {
    const generation = await this.createGeneration(prompt, options);

    if (!generation.images || generation.images.length === 0) {
      throw new Error('No images generated');
    }

    const results = [];
    const category = this.categorizePrompt(prompt);
    const tags = this.extractTags(prompt);

    for (let i = 0; i < generation.images.length; i++) {
      const image = generation.images[i];
      const ext = image.mimeType === 'image/jpeg' ? 'jpg' : 'png';
      const filename = this.generateFilename(prompt, i, ext);

      // Determine subdirectory based on category
      const subDir = this._categoryToSubDir(category);
      const localPath = this.saveImage(image.data, filename, subDir);

      const metadata = {
        id: crypto.randomUUID(),
        generationId: generation.generationId,
        prompt,
        filename,
        localPath,
        url: null, // Gemini returns inline data, no URL
        width: generation.width,
        height: generation.height,
        category,
        tags,
        model: options.model || this.defaultModel,
        seed: null, // Gemini doesn't return seeds
        createdAt: new Date().toISOString()
      };

      results.push(metadata);
    }

    return results;
  }

  /**
   * Map category to storage subdirectory
   */
  _categoryToSubDir(category) {
    const mapping = {
      'mockups/rooms': 'metal-print-scenes',
      'mockups/models': 'apparel-mockups',
      'products/vehicles': 'text-to-image',
      'products/multiboard': 'multiboard-mockups',
      'products/artwork': 'text-to-image',
      'marketing': 'text-to-image',
      'uncategorized': 'text-to-image'
    };
    return mapping[category] || 'text-to-image';
  }

  /**
   * List available aspect ratios
   */
  static getAspectRatios() {
    return Object.entries(ASPECT_RATIOS).map(([key, value]) => ({
      ratio: key,
      ...value
    }));
  }

  /**
   * List available models
   */
  static getModels() {
    return Object.entries(MODELS).map(([key, value]) => ({
      name: key.replace(/_/g, ' '),
      id: value
    }));
  }

  /**
   * List available styles
   */
  static getStyles() {
    return Object.entries(STYLES).map(([key, value]) => ({
      name: key.replace(/_/g, ' '),
      descriptor: value
    }));
  }
}

module.exports = {
  NanoBananaAI,
  MODELS,
  STYLES,
  ASPECT_RATIOS
};
