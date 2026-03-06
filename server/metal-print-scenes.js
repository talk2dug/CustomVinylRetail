/**
 * Metal Print Scene Generator
 * Generates photorealistic room scenes featuring metal print artwork on walls
 * Uses Nano Banana (Gemini) for AI image generation
 */

const path = require('path');
const { NanoBananaService } = require('./nano-banana-service');
const { ImagePromptGenerator } = require('./leonardo-prompt-generator');

// Predefined scene types with descriptive prompts
const SCENE_TYPES = {
  modern_living_room: {
    label: 'Modern Living Room',
    prompt: 'Place this metal print artwork prominently on the wall of a modern, minimalist living room. The room has clean lines, neutral tones, a contemporary sofa, and large windows with natural light. The metal print has a glossy, reflective metallic surface that catches the ambient light beautifully. Interior design photography, photorealistic, high detail.'
  },
  office: {
    label: 'Home Office',
    prompt: 'Place this metal print artwork on the wall behind a sleek home office desk. The office has a modern aesthetic with a standing desk, ergonomic chair, and subtle ambient lighting. The metal print has a glossy metallic finish that adds sophistication to the workspace. Interior design photography, photorealistic.'
  },
  bedroom: {
    label: 'Bedroom',
    prompt: 'Place this metal print artwork above the headboard in a cozy, modern bedroom. The room has soft lighting, plush bedding, and warm neutral tones. The metal print has a glossy metallic surface that reflects the soft ambient light. Interior design photography, photorealistic.'
  },
  gallery: {
    label: 'Gallery Wall',
    prompt: 'Display this metal print artwork as the centerpiece of a professional gallery setting. Clean white walls, track lighting casting a warm glow on the metallic surface. The metal print has a premium glossy finish that creates stunning reflections under the gallery lights. Art gallery photography, photorealistic.'
  },
  restaurant: {
    label: 'Restaurant/Bar',
    prompt: 'Place this metal print artwork on the wall of an upscale restaurant or bar. The space has warm ambient lighting, exposed brick or textured walls, and modern decor. The metal print has a glossy metallic finish that catches the warm light. Commercial interior photography, photorealistic.'
  },
  man_cave: {
    label: 'Man Cave/Garage',
    prompt: 'Hang this metal print artwork in a stylish man cave or clean garage. The space has dark walls, accent lighting, and automotive or sports decor elements. The metal print has a glossy metallic surface that pops against the dark background. Lifestyle photography, photorealistic.'
  },
  gaming_room: {
    label: 'Gaming Room',
    prompt: 'Place this metal print artwork on the wall of a modern gaming room setup. RGB ambient lighting, sleek desk setup, and gaming gear visible. The metal print has a reflective metallic finish that picks up the colorful ambient lighting. Lifestyle photography, photorealistic.'
  }
};

class MetalPrintSceneGenerator {
  constructor(options = {}) {
    this.service = options.service || new NanoBananaService(options);

    const claudeKey = options.claudeApiKey || process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
    if (claudeKey) {
      this.promptGenerator = new ImagePromptGenerator(claudeKey);
    }
  }

  /**
   * Generate a single scene for a metal print
   */
  async generateScene(metalPrintImagePath, options = {}) {
    const { sceneType = 'modern_living_room', customPrompt } = options;

    const scene = SCENE_TYPES[sceneType];
    if (!scene && !customPrompt) {
      throw new Error(`Unknown scene type: ${sceneType}. Available: ${Object.keys(SCENE_TYPES).join(', ')}`);
    }

    const scenePrompt = customPrompt || scene.prompt;

    return this.service.generateScene(metalPrintImagePath, scenePrompt, {
      subDir: 'metal-print-scenes',
      sceneType
    });
  }

  /**
   * Generate a full marketing set (multiple room scenes)
   */
  async generateMarketingSet(metalPrintImagePath, options = {}) {
    const { sceneTypes = ['modern_living_room', 'man_cave', 'office', 'gallery'] } = options;
    const results = {};

    for (let i = 0; i < sceneTypes.length; i++) {
      const sceneType = sceneTypes[i];
      console.log(`[MetalPrintScenes] Generating scene ${i + 1}/${sceneTypes.length}: ${sceneType}`);

      try {
        results[sceneType] = await this.generateScene(metalPrintImagePath, { sceneType });
      } catch (error) {
        console.error(`[MetalPrintScenes] Failed for ${sceneType}:`, error.message);
        results[sceneType] = { error: error.message };
      }

      // Rate limit between scenes
      if (i < sceneTypes.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    return results;
  }

  /**
   * Generate scene using AI-crafted prompt (uses Claude to create a custom scene description)
   */
  async generateCustomScene(metalPrintImagePath, description, options = {}) {
    if (!this.promptGenerator) {
      throw new Error('Claude API key required for custom scene generation');
    }

    const promptResult = await this.promptGenerator.generatePrompt(
      `metal print artwork displayed in ${description}`,
      { category: 'metal_print_scene' }
    );

    return this.service.generateScene(metalPrintImagePath, promptResult.prompts[0], {
      subDir: 'metal-print-scenes',
      sceneType: 'custom'
    });
  }

  /**
   * Get available scene types
   */
  static getSceneTypes() {
    return Object.entries(SCENE_TYPES).map(([key, value]) => ({
      type: key,
      label: value.label
    }));
  }
}

module.exports = { MetalPrintSceneGenerator, SCENE_TYPES };
