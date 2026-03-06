/**
 * Art Modifier Service
 * Handles artwork modifications: aspect ratio changes, cropping, variations, iterations
 * Uses Nano Banana (Gemini) for AI-powered modifications and Sharp for non-AI ops
 */

const { NanoBananaService, ASPECT_RATIOS } = require('./nano-banana-service');

class ArtModifier {
  constructor(options = {}) {
    this.service = options.service || new NanoBananaService(options);
  }

  /**
   * Change aspect ratio (AI outpainting for expansion, Sharp for contraction)
   */
  async changeAspectRatio(imagePath, targetRatio, options = {}) {
    return this.service.changeAspectRatio(imagePath, targetRatio, options);
  }

  /**
   * Create a variation of existing artwork
   */
  async createVariation(imagePath, variationPrompt, options = {}) {
    return this.service.createVariation(imagePath, variationPrompt, options);
  }

  /**
   * Create multiple variations at once
   */
  async createVariations(imagePath, prompts, options = {}) {
    const results = [];

    for (let i = 0; i < prompts.length; i++) {
      console.log(`[ArtModifier] Variation ${i + 1}/${prompts.length}`);
      try {
        const result = await this.service.createVariation(imagePath, prompts[i], options);
        results.push({ success: true, prompt: prompts[i], images: result });
      } catch (error) {
        results.push({ success: false, prompt: prompts[i], error: error.message });
      }

      if (i < prompts.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    return results;
  }

  /**
   * Iteratively refine artwork through multiple AI passes
   */
  async iterateArtwork(imagePath, iterationPrompt, numIterations = 3) {
    return this.service.iterateArtwork(imagePath, iterationPrompt, numIterations);
  }

  /**
   * Smart crop using Sharp attention-based strategy
   */
  async smartCrop(imagePath, targetRatio, options = {}) {
    return this.service.smartCrop(imagePath, targetRatio, options);
  }

  /**
   * Generate multiple aspect ratio versions of an artwork
   */
  async generateAllRatios(imagePath, ratios = ['1:1', '4:3', '16:9', '9:16'], options = {}) {
    const results = {};

    for (const ratio of ratios) {
      console.log(`[ArtModifier] Generating ${ratio} version`);
      try {
        results[ratio] = await this.changeAspectRatio(imagePath, ratio, options);
      } catch (error) {
        console.error(`[ArtModifier] Failed for ${ratio}:`, error.message);
        results[ratio] = { error: error.message };
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return results;
  }

  /**
   * Get available aspect ratios
   */
  static getAspectRatios() {
    return ASPECT_RATIOS;
  }
}

module.exports = { ArtModifier };
