/**
 * Leonardo.ai Prompt Generator
 * Uses Claude API to generate optimized prompts for Leonardo.ai image generation
 */

const Anthropic = require('@anthropic-ai/sdk');

// Prompt templates for different use cases
const PROMPT_TEMPLATES = {
  vehicle: {
    base: `You are an expert at creating prompts for Leonardo.ai to generate photorealistic car images optimized for metal sublimation prints.

Key requirements for vehicle prompts:
- Three-quarter front view angle (unless specified otherwise)
- Full car visible in frame
- Pure/solid black background for metal print contrast
- Dramatic studio lighting with sharp reflections
- Photorealistic quality, 8k resolution
- Include specific color names (e.g., "Bayside Blue metallic", "Torch Red")
- Mention key details (chrome, carbon fiber, wheels, livery)

Example prompt structure:
"[Year] [Make Model Variant], [Color Description], three-quarter front angle, full car in frame, [distinctive features], isolated on pure black background, dramatic studio lighting, [style details], photorealistic, 8k"`,
    suffix: 'three-quarter front angle, full car in frame, isolated on pure black background, dramatic studio lighting, sharp reflections, photorealistic, ultra detailed, 8k'
  },

  room: {
    base: `You are an expert at creating prompts for Leonardo.ai to generate interior room scenes for product mockups.

Key requirements for room mockups:
- Modern, stylish interior design
- Natural or warm lighting
- Wall space visible for artwork/print placement
- Clean, uncluttered composition
- High-end aesthetic (contemporary, minimalist, or cozy)
- Include furniture, decor elements, and textures
- Photorealistic quality

Example prompt structure:
"[Room type] interior, [style], [wall description with space for artwork], [furniture and decor], [lighting description], [mood/atmosphere], photorealistic, high detail"`,
    suffix: 'blank wall space for artwork, natural lighting, photorealistic, interior design photography, high detail'
  },

  model: {
    base: `You are an expert at creating prompts for Leonardo.ai to generate fashion/apparel mockup images with human models.

Key requirements for model mockups:
- Professional model photography style
- Clean backgrounds (studio or lifestyle)
- Focus on clothing/apparel visibility
- Good lighting for fabric textures
- Diverse, inclusive representations
- High fashion or lifestyle aesthetic

Example prompt structure:
"[Model description], wearing [apparel description], [pose/action], [setting/background], [lighting style], professional fashion photography, photorealistic"`,
    suffix: 'professional fashion photography, clean composition, photorealistic, commercial quality'
  },

  marketing: {
    base: `You are an expert at creating prompts for Leonardo.ai to generate marketing and promotional imagery.

Key requirements for marketing images:
- Eye-catching, vibrant compositions
- Brand-friendly aesthetics
- Social media optimized compositions
- Clear focal points
- Modern, trendy styles
- Suitable for ads, banners, social posts

Example prompt structure:
"[Subject/theme], [style/mood], [color scheme], [composition details], [intended use context], high impact, commercial quality"`,
    suffix: 'commercial photography, high impact, vibrant, marketing quality'
  },

  artwork: {
    base: `You are an expert at creating prompts for Leonardo.ai to generate artistic images suitable for prints and merchandise.

Key requirements for artwork:
- Bold, striking compositions
- Rich colors that pop on metal/canvas prints
- Black backgrounds work great for metal sublimation
- High contrast for visual impact
- Artistic style that appeals to target demographic
- Consider framing and display context

Example prompt structure:
"[Subject], [artistic style], [color palette], [composition], [mood/atmosphere], [background treatment], high detail, suitable for art print"`,
    suffix: 'bold composition, rich colors, high contrast, art print quality, detailed'
  }
};

class LeonardoPromptGenerator {
  constructor(apiKey, options = {}) {
    if (!apiKey) {
      throw new Error('Anthropic API key is required');
    }
    this.client = new Anthropic({ apiKey });
    this.model = options.model || 'claude-sonnet-4-20250514';
    this.promptHistory = [];
  }

  /**
   * Detect the category/type from keywords
   */
  detectCategory(keywords) {
    const lowerKeywords = keywords.toLowerCase();

    if (/car|vehicle|truck|motorcycle|rally|racing|sedan|coupe|sports car/i.test(lowerKeywords)) {
      return 'vehicle';
    }
    if (/room|interior|living|bedroom|office|kitchen|home|house|apartment/i.test(lowerKeywords)) {
      return 'room';
    }
    if (/model|person|wearing|fashion|apparel|clothing|shirt|hoodie/i.test(lowerKeywords)) {
      return 'model';
    }
    if (/marketing|ad|promotional|banner|social|campaign/i.test(lowerKeywords)) {
      return 'marketing';
    }

    return 'artwork';
  }

  /**
   * Generate a Leonardo.ai optimized prompt from keywords
   * @param {string} keywords - User's input keywords or description
   * @param {object} options - Generation options
   * @returns {object} Generated prompt and metadata
   */
  async generatePrompt(keywords, options = {}) {
    const {
      category = null,
      style = null,
      numVariations = 1,
      includeNegative = false
    } = options;

    // Auto-detect category if not provided
    const promptCategory = category || this.detectCategory(keywords);
    const template = PROMPT_TEMPLATES[promptCategory] || PROMPT_TEMPLATES.artwork;

    const systemPrompt = `${template.base}

IMPORTANT RULES:
1. Output ONLY the prompt text - no explanations, quotes, or formatting
2. Make prompts detailed but concise (under 200 words)
3. Include specific visual details that Leonardo.ai can render
4. Avoid abstract concepts that can't be visualized
5. Use descriptive adjectives for colors, textures, lighting
6. End with quality modifiers: photorealistic, detailed, 8k, etc.
${style ? `7. Incorporate this style: ${style}` : ''}`;

    const userMessage = numVariations > 1
      ? `Generate ${numVariations} different prompt variations based on these keywords: "${keywords}"\n\nSeparate each prompt with "---" on its own line.`
      : `Generate a single optimized Leonardo.ai prompt based on these keywords: "${keywords}"`;

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }]
      });

      const generatedText = response.content[0].text.trim();

      // Parse multiple variations if requested
      const prompts = numVariations > 1
        ? generatedText.split(/---+/).map(p => p.trim()).filter(p => p.length > 0)
        : [generatedText];

      // Generate negative prompt if requested
      let negativePrompt = null;
      if (includeNegative) {
        negativePrompt = await this.generateNegativePrompt(promptCategory);
      }

      const result = {
        keywords,
        category: promptCategory,
        prompts,
        negativePrompt,
        template: promptCategory,
        generatedAt: new Date().toISOString()
      };

      // Store in history
      this.promptHistory.push(result);

      return result;
    } catch (error) {
      console.error('[PromptGenerator] Error:', error.message);
      throw error;
    }
  }

  /**
   * Generate a negative prompt for the category
   */
  async generateNegativePrompt(category) {
    const negativePrompts = {
      vehicle: 'blurry, low quality, distorted, cropped, partial car, multiple cars, text, watermark, logo, deformed wheels, bad proportions, unrealistic lighting',
      room: 'blurry, low quality, distorted, cluttered, messy, outdated decor, bad lighting, unrealistic proportions, text, watermark',
      model: 'blurry, low quality, distorted face, extra limbs, bad anatomy, deformed, disfigured, unrealistic proportions, text, watermark',
      marketing: 'blurry, low quality, distorted, unprofessional, cluttered, bad composition, text errors, watermark',
      artwork: 'blurry, low quality, distorted, amateur, bad composition, muddy colors, low contrast, watermark'
    };

    return negativePrompts[category] || negativePrompts.artwork;
  }

  /**
   * Enhance an existing prompt with additional details
   */
  async enhancePrompt(existingPrompt, enhancements = {}) {
    const {
      addLighting = false,
      addDetails = false,
      targetPlatform = 'metal print'
    } = enhancements;

    const systemPrompt = `You are an expert at enhancing Leonardo.ai prompts.
Take the existing prompt and improve it with:
${addLighting ? '- Better lighting descriptions (dramatic, studio, natural, etc.)' : ''}
${addDetails ? '- More specific visual details (textures, materials, reflections)' : ''}
- Optimization for ${targetPlatform}
- Quality modifiers (photorealistic, 8k, detailed)

Output ONLY the enhanced prompt text, no explanations.`;

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 512,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Enhance this prompt: "${existingPrompt}"` }]
    });

    return response.content[0].text.trim();
  }

  /**
   * Generate prompts for a batch of keywords
   */
  async generateBatch(keywordsList, options = {}) {
    const results = [];

    for (const keywords of keywordsList) {
      try {
        const result = await this.generatePrompt(keywords, options);
        results.push({ success: true, ...result });
      } catch (error) {
        results.push({
          success: false,
          keywords,
          error: error.message
        });
      }

      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    return results;
  }

  /**
   * Get prompt history
   */
  getHistory() {
    return this.promptHistory;
  }

  /**
   * Clear prompt history
   */
  clearHistory() {
    this.promptHistory = [];
  }

  /**
   * Quick vehicle prompt - convenience method
   */
  async vehiclePrompt(carDescription, options = {}) {
    return this.generatePrompt(carDescription, { ...options, category: 'vehicle' });
  }

  /**
   * Quick room prompt - convenience method
   */
  async roomPrompt(roomDescription, options = {}) {
    return this.generatePrompt(roomDescription, { ...options, category: 'room' });
  }

  /**
   * Quick model prompt - convenience method
   */
  async modelPrompt(description, options = {}) {
    return this.generatePrompt(description, { ...options, category: 'model' });
  }
}

module.exports = { LeonardoPromptGenerator, PROMPT_TEMPLATES };
