/**
 * Apparel Mockup Pipeline
 * 3-step process:
 * 1. Composite graphic design onto apparel blank (using existing mockup-compositor.js)
 * 2. Send composited mockup to Gemini → generate realistic lifestyle scene
 * 3. Output ready for existing marketing workflows (social-marketing.js, facebook-marketing-ai.js)
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const crypto = require('crypto');
const { NanoBananaService } = require('./nano-banana-service');
const { ImagePromptGenerator } = require('./leonardo-prompt-generator');

// Default apparel types with compositing positions
const APPAREL_TEMPLATES = {
  tshirt: {
    label: 'T-Shirt',
    artworkPosition: { x: 250, y: 180, width: 500, height: 500, rotation: 0, opacity: 1 },
    scenePrompt: 'A person casually wearing this custom t-shirt in an urban lifestyle setting. Natural pose, good lighting showing the printed graphic clearly. The graphic on the shirt is sharp and vibrant. Lifestyle fashion photography, photorealistic, commercial quality.'
  },
  hoodie: {
    label: 'Hoodie',
    artworkPosition: { x: 220, y: 200, width: 560, height: 450, rotation: 0, opacity: 1 },
    scenePrompt: 'A person wearing this custom hoodie in a casual outdoor setting. Relaxed pose, the hoodie graphic is clearly visible. Cool, comfortable lifestyle vibe. Fashion photography, photorealistic, commercial quality.'
  },
  hat: {
    label: 'Hat/Cap',
    artworkPosition: { x: 120, y: 40, width: 260, height: 120, rotation: 0, opacity: 1 },
    scenePrompt: 'A person wearing this custom hat/cap in a lifestyle setting. The hat design is clearly visible from the front. Casual, trendy look. Fashion photography, photorealistic.'
  },
  beanie: {
    label: 'Beanie',
    artworkPosition: { x: 100, y: 30, width: 300, height: 150, rotation: 0, opacity: 1 },
    scenePrompt: 'A person wearing this custom beanie in a cool-weather outdoor setting. The embroidered/printed design is visible. Cozy, stylish look. Fashion photography, photorealistic.'
  }
};

// Scene contexts for lifestyle shots
const SCENE_CONTEXTS = {
  urban: 'urban street with graffiti walls and modern architecture',
  outdoor: 'scenic outdoor setting with natural light and greenery',
  cafe: 'trendy coffee shop with warm ambient lighting',
  gym: 'modern gym or fitness studio',
  festival: 'outdoor music festival or event',
  studio: 'clean photography studio with professional lighting',
  beach: 'beach or coastal setting with warm sunlight',
  casual: 'casual everyday setting, natural and relaxed'
};

class ApparelMockupPipeline {
  constructor(options = {}) {
    this.service = options.service || new NanoBananaService(options);
    this.outputDir = path.join(
      options.outputDir || path.join(__dirname, '..', 'web', 'images', 'ai-generated'),
      'apparel-mockups'
    );

    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }

    const claudeKey = options.claudeApiKey || process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
    if (claudeKey) {
      this.promptGenerator = new ImagePromptGenerator(claudeKey);
    }
  }

  /**
   * Step 1: Composite a graphic design onto an apparel blank image
   * Uses Sharp for the compositing (mirrors mockup-compositor.js logic)
   */
  async compositeDesignOnApparel(designPath, apparelBlankPath, options = {}) {
    const {
      apparelType = 'tshirt',
      position = null,
      blendMode = 'normal'
    } = options;

    const template = APPAREL_TEMPLATES[apparelType] || APPAREL_TEMPLATES.tshirt;
    const artPos = position || template.artworkPosition;

    // Load the apparel blank
    if (!fs.existsSync(apparelBlankPath)) {
      throw new Error(`Apparel blank not found: ${apparelBlankPath}`);
    }
    if (!fs.existsSync(designPath)) {
      throw new Error(`Design file not found: ${designPath}`);
    }

    // Resize design to fit the artwork position
    const resizedDesign = await sharp(designPath)
      .resize(artPos.width, artPos.height, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();

    // Apply rotation if specified
    let finalDesign = resizedDesign;
    if (artPos.rotation) {
      finalDesign = await sharp(resizedDesign)
        .rotate(artPos.rotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .toBuffer();
    }

    // Composite design onto apparel blank
    const filename = `composite_${apparelType}_${crypto.randomUUID().slice(0, 8)}.png`;
    const outputPath = path.join(this.outputDir, filename);

    await sharp(apparelBlankPath)
      .composite([{
        input: finalDesign,
        top: artPos.y,
        left: artPos.x,
        blend: blendMode
      }])
      .png()
      .toFile(outputPath);

    console.log(`[ApparelPipeline] Composited: ${filename}`);
    return outputPath;
  }

  /**
   * Step 2: Generate a realistic lifestyle scene from the composited mockup
   */
  async generateLifestyleScene(compositedMockupPath, options = {}) {
    const {
      apparelType = 'tshirt',
      sceneContext = 'casual',
      customPrompt = null
    } = options;

    const template = APPAREL_TEMPLATES[apparelType] || APPAREL_TEMPLATES.tshirt;
    const context = SCENE_CONTEXTS[sceneContext] || SCENE_CONTEXTS.casual;

    let scenePrompt;
    if (customPrompt) {
      scenePrompt = customPrompt;
    } else if (this.promptGenerator) {
      // Use Claude to generate an optimized prompt
      const promptResult = await this.promptGenerator.generatePrompt(
        `person wearing custom ${apparelType} in ${context}`,
        { category: 'apparel_scene' }
      );
      scenePrompt = promptResult.prompts[0];
    } else {
      scenePrompt = template.scenePrompt.replace('lifestyle setting', context);
    }

    return this.service.generateScene(compositedMockupPath, scenePrompt, {
      subDir: 'apparel-mockups',
      sceneType: `${apparelType}_${sceneContext}`
    });
  }

  /**
   * Full pipeline: design + blank → composite → lifestyle scene
   */
  async generateMockup(designPath, apparelBlankPath, options = {}) {
    const {
      apparelType = 'tshirt',
      sceneContext = 'casual',
      position = null,
      customPrompt = null
    } = options;

    console.log(`[ApparelPipeline] Starting mockup pipeline for ${apparelType}...`);

    // Step 1: Composite
    console.log('[ApparelPipeline] Step 1: Compositing design onto apparel...');
    const compositedPath = await this.compositeDesignOnApparel(designPath, apparelBlankPath, {
      apparelType,
      position
    });

    // Step 2: Generate lifestyle scene
    console.log('[ApparelPipeline] Step 2: Generating lifestyle scene...');
    const sceneResults = await this.generateLifestyleScene(compositedPath, {
      apparelType,
      sceneContext,
      customPrompt
    });

    return {
      compositedPath,
      sceneImages: sceneResults,
      apparelType,
      sceneContext
    };
  }

  /**
   * Generate mockup without a blank — just send the design to Gemini
   * Useful when you don't have a product blank image
   */
  async generateMockupFromDesignOnly(designPath, options = {}) {
    const {
      apparelType = 'tshirt',
      sceneContext = 'casual',
      color = 'white'
    } = options;

    const template = APPAREL_TEMPLATES[apparelType] || APPAREL_TEMPLATES.tshirt;
    const context = SCENE_CONTEXTS[sceneContext] || SCENE_CONTEXTS.casual;

    const prompt = `Take this graphic design and place it on a ${color} ${template.label}. Show the ${template.label} being worn by a person in a ${context}. The graphic should be centered on the chest area, clearly visible, and properly scaled. The scene should look like a professional lifestyle product photo. Fashion photography, photorealistic, commercial quality.`;

    return this.service.generateScene(designPath, prompt, {
      subDir: 'apparel-mockups',
      sceneType: `${apparelType}_${sceneContext}`
    });
  }

  /**
   * Batch: generate mockups for a design across multiple apparel types
   */
  async batchGenerateMockups(designPath, options = {}) {
    const {
      apparelTypes = ['tshirt', 'hoodie'],
      sceneContext = 'casual',
      color = 'white'
    } = options;

    const results = {};

    for (let i = 0; i < apparelTypes.length; i++) {
      const apparelType = apparelTypes[i];
      console.log(`[ApparelPipeline] Batch ${i + 1}/${apparelTypes.length}: ${apparelType}`);

      try {
        results[apparelType] = await this.generateMockupFromDesignOnly(designPath, {
          apparelType,
          sceneContext,
          color
        });
      } catch (error) {
        console.error(`[ApparelPipeline] Failed for ${apparelType}:`, error.message);
        results[apparelType] = { error: error.message };
      }

      if (i < apparelTypes.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    return results;
  }

  /**
   * Get available apparel types
   */
  static getApparelTypes() {
    return Object.entries(APPAREL_TEMPLATES).map(([key, value]) => ({
      type: key,
      label: value.label
    }));
  }

  /**
   * Get available scene contexts
   */
  static getSceneContexts() {
    return Object.entries(SCENE_CONTEXTS).map(([key, value]) => ({
      context: key,
      description: value
    }));
  }
}

module.exports = { ApparelMockupPipeline, APPAREL_TEMPLATES, SCENE_CONTEXTS };
