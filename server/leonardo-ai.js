/**
 * Leonardo.ai API Integration
 * Handles image generation, downloading, tagging, and database storage
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// API Configuration
const LEONARDO_API_BASE = 'https://cloud.leonardo.ai/api/rest/v1';

// Model IDs
const MODELS = {
  PHOENIX_1_0: 'de7d3faf-762f-48e0-b3b7-9d0ac3a3fcf3',
  PHOENIX_0_9: '6b645e3a-d64f-4341-a6d8-7a3690fbf042',
  LUCID_ORIGIN: '7b592283-e8a7-4c5a-9ba6-d18c31f258b9',
  LUCID_REALISM: '05ce0082-2d80-4a2d-8653-4d1c5e2418e',
  FLUX_DEV: 'b2614463-296c-462a-9586-aafdb8f00e36',
  SDXL_1_0: '16e7060a-803e-4df3-97ee-edcfa5dc9cc8',
  ANIME_XL: 'e71a1c2f-4f80-4800-934f-2c68979d8cc8'
};

// Style UUIDs (compatible with Phoenix/Lucid/Flux)
const STYLES = {
  CINEMATIC: '111dc692-d470-4eec-b791-3475abac4c46',
  PHOTOREALISTIC: 'b2a54a51-230b-4d4f-ad40-83d14ae91291',
  THREE_D_RENDER: '84a93e32-bc65-4f08-a5a8-f67a16c0da05',
  ILLUSTRATION: 'e8a60b85-d832-4a13-ad43-90f7e9ea4d20',
  PORTRAIT: '0d9a8ef4-26c1-42c6-a7aa-85e8d3b31f9d',
  FASHION: 'f9d9c68e-7a8e-4c9a-a6c5-e4b2e8d4c0f1',
  BOKEH: 'c8e9a3c6-5d7e-4a8f-b2c1-d9e6f4a3b2c1'
};

// Common aspect ratios and their dimensions
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

class LeonardoAI {
  constructor(apiKey, options = {}) {
    if (!apiKey) {
      throw new Error('Leonardo.ai API key is required');
    }
    this.apiKey = apiKey;
    this.defaultModel = options.model || MODELS.PHOENIX_1_0;
    this.outputDir = options.outputDir || path.join(__dirname, '..', 'leonardo-images');
    this.pollInterval = options.pollInterval || 5000; // 5 seconds
    this.maxPollAttempts = options.maxPollAttempts || 60; // 5 minutes max wait

    // Ensure output directory exists
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  /**
   * Make authenticated API request to Leonardo.ai
   */
  async request(endpoint, options = {}) {
    const url = `${LEONARDO_API_BASE}${endpoint}`;
    const headers = {
      'accept': 'application/json',
      'authorization': `Bearer ${this.apiKey}`,
      'content-type': 'application/json',
      ...options.headers
    };

    const response = await fetch(url, {
      ...options,
      headers
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Leonardo API error (${response.status}): ${error}`);
    }

    return response.json();
  }

  /**
   * Get user info and remaining tokens
   */
  async getUserInfo() {
    const result = await this.request('/me');
    return result.user_details?.[0] || result;
  }

  /**
   * Create a new image generation
   * @param {string} prompt - The generation prompt
   * @param {object} options - Generation options
   * @returns {object} Generation ID and details
   */
  async createGeneration(prompt, options = {}) {
    const {
      aspectRatio = '1:1',
      numImages = 1,
      model = this.defaultModel,
      contrast = 3.5,
      alchemy = true,
      enhancePrompt = false,
      styleUUID = null,
      negativePrompt = null,
      seed = null
    } = options;

    // Get dimensions from aspect ratio
    const dimensions = ASPECT_RATIOS[aspectRatio] || ASPECT_RATIOS['1:1'];

    const body = {
      prompt,
      modelId: model,
      width: dimensions.width,
      height: dimensions.height,
      num_images: Math.min(numImages, 4), // API limit
      contrast,
      alchemy,
      enhancePrompt
    };

    if (styleUUID) {
      body.styleUUID = styleUUID;
    }

    if (negativePrompt) {
      body.negative_prompt = negativePrompt;
    }

    if (seed !== null) {
      body.seed = seed;
    }

    console.log(`[Leonardo] Creating generation: ${prompt.substring(0, 50)}...`);
    console.log(`[Leonardo] Dimensions: ${dimensions.width}x${dimensions.height} (${aspectRatio})`);

    const result = await this.request('/generations', {
      method: 'POST',
      body: JSON.stringify(body)
    });

    return {
      generationId: result.sdGenerationJob?.generationId,
      ...result.sdGenerationJob
    };
  }

  /**
   * Get generation status and results
   */
  async getGeneration(generationId) {
    const result = await this.request(`/generations/${generationId}`);
    return result.generations_by_pk;
  }

  /**
   * Wait for generation to complete and return images
   */
  async waitForGeneration(generationId) {
    let attempts = 0;

    while (attempts < this.maxPollAttempts) {
      const generation = await this.getGeneration(generationId);

      if (generation.status === 'COMPLETE') {
        console.log(`[Leonardo] Generation complete: ${generationId}`);
        return generation;
      }

      if (generation.status === 'FAILED') {
        throw new Error(`Generation failed: ${generation.status}`);
      }

      attempts++;
      console.log(`[Leonardo] Waiting for generation... (${attempts}/${this.maxPollAttempts})`);
      await new Promise(resolve => setTimeout(resolve, this.pollInterval));
    }

    throw new Error('Generation timed out');
  }

  /**
   * Download an image from URL
   */
  async downloadImage(imageUrl, filename) {
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`Failed to download image: ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const filepath = path.join(this.outputDir, filename);
    fs.writeFileSync(filepath, buffer);

    return filepath;
  }

  /**
   * Generate filename from prompt
   */
  generateFilename(prompt, index = 0) {
    // Extract key terms from prompt for filename
    const cleanPrompt = prompt
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(word => word.length > 2)
      .slice(0, 5)
      .join('-');

    const timestamp = Date.now();
    const hash = crypto.createHash('md5').update(prompt + timestamp).digest('hex').substring(0, 6);

    return `${cleanPrompt}-${hash}-${index}.jpg`;
  }

  /**
   * Extract tags from prompt
   */
  extractTags(prompt) {
    const tags = new Set();

    // Add source tag
    tags.add('leonardo-ai');
    tags.add('ai-generated');

    // Extract vehicle types
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

    // Extract colors
    const colorPatterns = /\b(red|blue|white|black|yellow|green|orange|silver|gold|gray|grey|purple|pink)\b/gi;
    const colorMatches = prompt.match(colorPatterns);
    if (colorMatches) {
      colorMatches.forEach(c => tags.add(c.toLowerCase()));
    }

    // Extract style keywords
    const stylePatterns = /\b(photorealistic|cinematic|dramatic|studio|metallic|matte|glossy|chrome)\b/gi;
    const styleMatches = prompt.match(stylePatterns);
    if (styleMatches) {
      styleMatches.forEach(s => tags.add(s.toLowerCase()));
    }

    // Extract category hints
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
    if (/marketing|ad|advertisement|promotional|banner/i.test(lowerPrompt)) {
      return 'marketing';
    }
    if (/art|artwork|print|poster|illustration/i.test(lowerPrompt)) {
      return 'products/artwork';
    }

    return 'uncategorized';
  }

  /**
   * Full pipeline: Generate, download, tag, and return metadata
   * @param {string} prompt - The generation prompt
   * @param {object} options - Generation options
   * @returns {object[]} Array of generated image metadata
   */
  async generate(prompt, options = {}) {
    // Create generation
    const generation = await this.createGeneration(prompt, options);

    if (!generation.generationId) {
      throw new Error('Failed to create generation - no ID returned');
    }

    // Wait for completion
    const completed = await this.waitForGeneration(generation.generationId);

    // Process each generated image
    const results = [];
    const category = this.categorizePrompt(prompt);
    const tags = this.extractTags(prompt);

    for (let i = 0; i < completed.generated_images.length; i++) {
      const image = completed.generated_images[i];
      const filename = this.generateFilename(prompt, i);

      // Download image
      const localPath = await this.downloadImage(image.url, filename);

      // Build metadata
      const metadata = {
        id: image.id,
        generationId: generation.generationId,
        prompt,
        filename,
        localPath,
        url: image.url,
        width: completed.imageWidth,
        height: completed.imageHeight,
        category,
        tags,
        model: options.model || this.defaultModel,
        seed: image.seed,
        createdAt: new Date().toISOString()
      };

      results.push(metadata);
      console.log(`[Leonardo] Downloaded: ${filename}`);
    }

    return results;
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
      uuid: value
    }));
  }
}

// Export class and constants
module.exports = {
  LeonardoAI,
  MODELS,
  STYLES,
  ASPECT_RATIOS
};
