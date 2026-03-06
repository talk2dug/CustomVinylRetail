/**
 * Image Prompt Generator
 * Uses Ollama (local LLM) to generate optimized prompts for AI image generation (Gemini)
 * Fallback chain: Primary Ollama (bridge/GPU) → Fallback Ollama (server) → raw keywords
 */

const http = require('http');

// Prompt templates for different use cases
const PROMPT_TEMPLATES = {
  vehicle: {
    base: `You are an expert at creating prompts for AI image generation to create photorealistic car images optimized for metal sublimation prints.

Key requirements for vehicle prompts:
- Three-quarter front view angle (unless specified otherwise)
- Full car visible in frame
- Pure/solid black background for metal print contrast
- Dramatic studio lighting with sharp reflections
- Photorealistic quality, 8k resolution
- Include specific color names (e.g., "Bayside Blue metallic", "Torch Red")
- Mention key details (chrome, carbon fiber, wheels, livery)
- Avoid: blurry, low quality, distorted, cropped, partial car, multiple cars, text, watermark, deformed wheels

Example prompt structure:
"[Year] [Make Model Variant], [Color Description], three-quarter front angle, full car in frame, [distinctive features], isolated on pure black background, dramatic studio lighting, [style details], photorealistic, 8k"`,
    suffix: 'three-quarter front angle, full car in frame, isolated on pure black background, dramatic studio lighting, sharp reflections, photorealistic, ultra detailed, 8k'
  },

  room: {
    base: `You are an expert at creating prompts for AI image generation to create interior room scenes for product mockups.

Key requirements for room mockups:
- Modern, stylish interior design
- Natural or warm lighting
- Wall space visible for artwork/print placement
- Clean, uncluttered composition
- High-end aesthetic (contemporary, minimalist, or cozy)
- Include furniture, decor elements, and textures
- Photorealistic quality
- Avoid: blurry, cluttered, messy, outdated decor, bad lighting, unrealistic proportions, text, watermark

Example prompt structure:
"[Room type] interior, [style], [wall description with space for artwork], [furniture and decor], [lighting description], [mood/atmosphere], photorealistic, high detail"`,
    suffix: 'blank wall space for artwork, natural lighting, photorealistic, interior design photography, high detail'
  },

  model: {
    base: `You are an expert at creating prompts for AI image generation to create fashion/apparel mockup images with human models.

Key requirements for model mockups:
- Professional model photography style
- Clean backgrounds (studio or lifestyle)
- Focus on clothing/apparel visibility
- Good lighting for fabric textures
- Diverse, inclusive representations
- High fashion or lifestyle aesthetic
- Avoid: blurry, distorted face, extra limbs, bad anatomy, deformed, disfigured, text, watermark

Example prompt structure:
"[Model description], wearing [apparel description], [pose/action], [setting/background], [lighting style], professional fashion photography, photorealistic"`,
    suffix: 'professional fashion photography, clean composition, photorealistic, commercial quality'
  },

  marketing: {
    base: `You are an expert at creating prompts for AI image generation to create marketing and promotional imagery.

Key requirements for marketing images:
- Eye-catching, vibrant compositions
- Brand-friendly aesthetics
- Social media optimized compositions
- Clear focal points
- Modern, trendy styles
- Suitable for ads, banners, social posts
- Avoid: blurry, unprofessional, cluttered, bad composition, text errors, watermark

Example prompt structure:
"[Subject/theme], [style/mood], [color scheme], [composition details], [intended use context], high impact, commercial quality"`,
    suffix: 'commercial photography, high impact, vibrant, marketing quality'
  },

  artwork: {
    base: `You are an expert at creating prompts for AI image generation to create artistic images suitable for prints and merchandise.

Key requirements for artwork:
- Bold, striking compositions
- Rich colors that pop on metal/canvas prints
- Black backgrounds work great for metal sublimation
- High contrast for visual impact
- Artistic style that appeals to target demographic
- Consider framing and display context
- Avoid: blurry, amateur, bad composition, muddy colors, low contrast, watermark

Example prompt structure:
"[Subject], [artistic style], [color palette], [composition], [mood/atmosphere], [background treatment], high detail, suitable for art print"`,
    suffix: 'bold composition, rich colors, high contrast, art print quality, detailed'
  },

  metal_print_scene: {
    base: `You are an expert at creating prompts for AI image generation to create photorealistic interior scenes featuring metal print artwork displayed on walls.

Key requirements for metal print scene prompts:
- The metal print artwork should be the focal point on the wall
- The metal print has a glossy, reflective metallic surface that catches light
- The room should complement but not overpower the artwork
- Show the metal print mounted on the wall with subtle shadow
- Include realistic room elements: furniture, lighting, decor
- Photorealistic interior design photography style
- Show the reflective quality of the metal print surface
- Avoid: blurry, low quality, artwork looks flat/printed on paper, bad perspective

Example prompt structure:
"A photorealistic [room type] interior with a metal print artwork displayed on the [wall description]. The metal print features [artwork description] and has a glossy metallic finish that catches [lighting description]. [Room details and furniture]. Interior design photography, high detail"`,
    suffix: 'metal print on wall, glossy metallic surface, reflective finish, interior design photography, photorealistic, high detail'
  },

  multiboard: {
    base: `You are an expert at creating prompts for AI image generation to create photorealistic renders of modular wall-mounted organizer systems.

Key requirements for multiboard/organizer prompts:
- Show modular wall-mounted grid system (similar to pegboard but modern)
- Components include: base tiles/panels, hooks, bins, shelves, pegs, tool holders
- Materials look like high-quality 3D printed plastic (matte or semi-gloss finish)
- Realistic lighting showing depth and dimension of modular parts
- Wall-mounted, showing proper mounting on drywall/concrete
- Can include items stored on the organizer (tools, supplies, etc.)
- Clean, organized aesthetic
- Avoid: blurry, flat looking, unrealistic materials, floating parts

Example prompt structure:
"A photorealistic 3D render of a modular wall organizer system mounted on a [wall type] in a [room type]. The system includes [components]. [Items stored on it]. [Lighting and atmosphere]. Product photography quality, high detail"`,
    suffix: 'modular wall organizer, 3D printed parts, wall mounted, organized, clean aesthetic, product photography, photorealistic, high detail'
  },

  apparel_scene: {
    base: `You are an expert at creating prompts for AI image generation to create lifestyle scenes featuring people wearing custom apparel.

Key requirements for apparel scene prompts:
- Show a person naturally wearing the apparel in a lifestyle setting
- The graphic/design on the apparel should be clearly visible
- Natural, candid-feeling pose (not overly posed)
- Lifestyle settings: outdoor cafe, urban street, park, gym, festival, etc.
- Good lighting that shows fabric texture and print quality
- The person should look confident and natural
- Commercial quality suitable for e-commerce and social media
- Avoid: blurry, distorted anatomy, illegible graphic, stiff pose, bad lighting

Example prompt structure:
"A [person description] wearing a [apparel type] with [graphic description], [pose/action], in a [setting]. [Lighting description]. Lifestyle fashion photography, commercial quality, photorealistic"`,
    suffix: 'lifestyle fashion photography, natural pose, graphic clearly visible, commercial quality, photorealistic'
  }
};

class ImagePromptGenerator {
  constructor(apiKeyOrOptions = {}, options = {}) {
    // Accept either (apiKey, options) for backward compat or (options) directly
    if (typeof apiKeyOrOptions === 'string') {
      // Old-style: new ImagePromptGenerator(apiKey, options)
      options = options || {};
    } else {
      options = apiKeyOrOptions || {};
    }

    // Ollama config from options or env
    this.ollamaHost = options.ollamaHost || process.env.OLLAMA_HOST || '100.64.0.13';
    this.ollamaPort = parseInt(options.ollamaPort || process.env.OLLAMA_PORT || '11434', 10);
    this.ollamaModel = options.ollamaModel || process.env.OLLAMA_MODEL || 'llama3.1:8b';

    // Fallback Ollama (server-local)
    this.ollamaFallbackHost = options.ollamaFallbackHost || process.env.OLLAMA_FALLBACK_HOST || '127.0.0.1';
    this.ollamaFallbackPort = parseInt(options.ollamaFallbackPort || process.env.OLLAMA_FALLBACK_PORT || '11434', 10);

    this.promptHistory = [];
  }

  /**
   * Call Ollama API
   */
  _callOllama(prompt, options = {}) {
    const {
      host = this.ollamaHost,
      port = this.ollamaPort,
      model = this.ollamaModel,
      temperature = 0.7,
      maxTokens = 1024,
      timeout = 60000,
      systemPrompt = null
    } = options;

    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({
        model,
        prompt: systemPrompt ? `${systemPrompt}\n\nUser: ${prompt}` : prompt,
        stream: false,
        options: {
          temperature,
          num_predict: maxTokens
        }
      });

      const req = http.request({
        hostname: host,
        port,
        path: '/api/generate',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.response || '');
          } catch (e) {
            reject(new Error(`Ollama parse error: ${e.message}`));
          }
        });
      });

      req.on('error', (e) => reject(new Error(`Ollama connection error (${host}:${port}): ${e.message}`)));
      req.on('timeout', () => { req.destroy(); reject(new Error(`Ollama timeout (${host}:${port})`)); });
      req.write(payload);
      req.end();
    });
  }

  /**
   * Call Ollama with fallback chain: primary → fallback server → null
   */
  async _callOllamaWithFallback(prompt, options = {}) {
    // Try primary (bridge/GPU laptop)
    try {
      console.log(`[PromptGenerator] Trying Ollama at ${this.ollamaHost}:${this.ollamaPort}...`);
      const result = await this._callOllama(prompt, {
        ...options,
        host: this.ollamaHost,
        port: this.ollamaPort,
        timeout: options.timeout || 60000
      });
      if (result && result.trim()) {
        console.log(`[PromptGenerator] Primary Ollama responded`);
        return result.trim();
      }
    } catch (e) {
      console.warn(`[PromptGenerator] Primary Ollama failed: ${e.message}`);
    }

    // Try fallback (server-local)
    if (this.ollamaFallbackHost !== this.ollamaHost || this.ollamaFallbackPort !== this.ollamaPort) {
      try {
        console.log(`[PromptGenerator] Trying fallback Ollama at ${this.ollamaFallbackHost}:${this.ollamaFallbackPort}...`);
        const result = await this._callOllama(prompt, {
          ...options,
          host: this.ollamaFallbackHost,
          port: this.ollamaFallbackPort,
          timeout: options.timeout || 120000 // longer timeout for CPU inference
        });
        if (result && result.trim()) {
          console.log(`[PromptGenerator] Fallback Ollama responded`);
          return result.trim();
        }
      } catch (e) {
        console.warn(`[PromptGenerator] Fallback Ollama failed: ${e.message}`);
      }
    }

    return null;
  }

  /**
   * Detect the category/type from keywords
   */
  detectCategory(keywords) {
    const lowerKeywords = keywords.toLowerCase();

    if (/car|vehicle|truck|motorcycle|rally|racing|sedan|coupe|sports car/i.test(lowerKeywords)) {
      return 'vehicle';
    }
    if (/multiboard|organizer|pegboard|wall mount.*hook|wall mount.*bin/i.test(lowerKeywords)) {
      return 'multiboard';
    }
    if (/metal print.*room|metal print.*scene|metal print.*wall|artwork.*wall.*room/i.test(lowerKeywords)) {
      return 'metal_print_scene';
    }
    if (/room|interior|living|bedroom|office|kitchen|home|house|apartment/i.test(lowerKeywords)) {
      return 'room';
    }
    if (/model|person|wearing|fashion|apparel|clothing|shirt|hoodie/i.test(lowerKeywords)) {
      return 'model';
    }
    if (/apparel.*scene|lifestyle.*apparel|lifestyle.*shirt|lifestyle.*hoodie/i.test(lowerKeywords)) {
      return 'apparel_scene';
    }
    if (/marketing|ad|promotional|banner|social|campaign/i.test(lowerKeywords)) {
      return 'marketing';
    }

    return 'artwork';
  }

  /**
   * Generate an optimized image prompt from keywords
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
3. Include specific visual details that AI image generation can render
4. Avoid abstract concepts that can't be visualized
5. Use descriptive adjectives for colors, textures, lighting
6. End with quality modifiers: photorealistic, detailed, 8k, etc.
7. Include any "avoid" instructions naturally in the prompt (e.g., "without text or watermarks")
${style ? `8. Incorporate this style: ${style}` : ''}`;

    const userMessage = numVariations > 1
      ? `Generate ${numVariations} different prompt variations based on these keywords: "${keywords}"\n\nSeparate each prompt with "---" on its own line.`
      : `Generate a single optimized image generation prompt based on these keywords: "${keywords}"`;

    try {
      const generatedText = await this._callOllamaWithFallback(userMessage, {
        systemPrompt,
        temperature: 0.7,
        maxTokens: 1024
      });

      let prompts;
      if (generatedText) {
        // Parse Ollama response
        prompts = numVariations > 1
          ? generatedText.split(/---+/).map(p => p.trim()).filter(p => p.length > 0)
          : [generatedText];
      } else {
        // Last resort: use keywords + template suffix as the prompt
        console.warn('[PromptGenerator] All Ollama instances unavailable, using keywords + template');
        prompts = [`${keywords}, ${template.suffix}`];
      }

      // Generate negative prompt if requested
      let negativePrompt = null;
      if (includeNegative) {
        negativePrompt = this.generateNegativePrompt(promptCategory);
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
      // Fallback: keywords + suffix
      return {
        keywords,
        category: promptCategory,
        prompts: [`${keywords}, ${template.suffix}`],
        negativePrompt: null,
        template: promptCategory,
        generatedAt: new Date().toISOString()
      };
    }
  }

  /**
   * Generate a negative prompt for the category
   */
  generateNegativePrompt(category) {
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

    const systemPrompt = `You are an expert at enhancing AI image generation prompts.
Take the existing prompt and improve it with:
${addLighting ? '- Better lighting descriptions (dramatic, studio, natural, etc.)' : ''}
${addDetails ? '- More specific visual details (textures, materials, reflections)' : ''}
- Optimization for ${targetPlatform}
- Quality modifiers (photorealistic, 8k, detailed)
- Include any negative instructions naturally (e.g., "without text or watermarks")

Output ONLY the enhanced prompt text, no explanations.`;

    const result = await this._callOllamaWithFallback(
      `Enhance this prompt: "${existingPrompt}"`,
      { systemPrompt, temperature: 0.6, maxTokens: 512 }
    );

    return result || existingPrompt; // fallback to original if Ollama unavailable
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

      // Small delay between requests
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

// Export with both old and new names for backward compatibility
const LeonardoPromptGenerator = ImagePromptGenerator;
module.exports = { LeonardoPromptGenerator, ImagePromptGenerator, PROMPT_TEMPLATES };
