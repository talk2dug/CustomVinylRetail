/**
 * Nano Banana Workflow Service
 * Replaces Leonardo.ai workflow - integrates prompt generation, image generation, and database storage
 * Uses Google Gemini API via NanoBananaAI
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { NanoBananaAI, MODELS, ASPECT_RATIOS } = require('./nano-banana-ai');
const { ImagePromptGenerator } = require('./leonardo-prompt-generator');

// Configuration
const APP_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.LIBRARY_ROOT
  ? path.join(process.env.LIBRARY_ROOT, 'data')
  : path.join(APP_ROOT, 'data');
const IMAGES_DIR = process.env.LIBRARY_ROOT
  ? path.join(process.env.LIBRARY_ROOT, 'images', 'ai-generated')
  : path.join(APP_ROOT, 'web', 'images', 'ai-generated');
const PROMPTS_DIR = path.join(DATA_DIR, 'ai-prompts');

// Ensure directories exist
[DATA_DIR, IMAGES_DIR, PROMPTS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Subdirectories for organized storage
const SUB_DIRS = ['text-to-image', 'metal-print-scenes', 'apparel-mockups', 'vectorized', 'art-modifications', 'multiboard-mockups'];
SUB_DIRS.forEach(sub => {
  const dir = path.join(IMAGES_DIR, sub);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

/**
 * Initialize AI image database tables
 */
function initAiDb(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_prompts (
      id TEXT PRIMARY KEY,
      keywords TEXT NOT NULL,
      prompt TEXT NOT NULL,
      category TEXT,
      tags TEXT,
      model TEXT,
      aspect_ratio TEXT,
      times_used INTEGER DEFAULT 0,
      last_used_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_ai_prompts_category ON ai_prompts(category);
    CREATE INDEX IF NOT EXISTS idx_ai_prompts_keywords ON ai_prompts(keywords);

    CREATE TABLE IF NOT EXISTS ai_generations (
      id TEXT PRIMARY KEY,
      prompt_id TEXT,
      generation_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      model TEXT,
      provider TEXT DEFAULT 'gemini',
      aspect_ratio TEXT,
      width INTEGER,
      height INTEGER,
      num_images INTEGER,
      status TEXT DEFAULT 'complete',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      FOREIGN KEY (prompt_id) REFERENCES ai_prompts(id)
    );

    CREATE TABLE IF NOT EXISTS ai_images (
      id TEXT PRIMARY KEY,
      generation_id TEXT NOT NULL,
      provider_image_id TEXT,
      prompt TEXT NOT NULL,
      filename TEXT NOT NULL,
      file_path TEXT NOT NULL,
      url TEXT,
      width INTEGER,
      height INTEGER,
      category TEXT,
      tags TEXT,
      artwork_id TEXT,
      source_image_path TEXT,
      operation_type TEXT DEFAULT 'generate',
      seed INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_ai_images_category ON ai_images(category);
    CREATE INDEX IF NOT EXISTS idx_ai_images_generation ON ai_images(generation_id);
    CREATE INDEX IF NOT EXISTS idx_ai_images_operation ON ai_images(operation_type);
  `);

  return db;
}

class NanoBananaWorkflow {
  constructor(options = {}) {
    this.geminiApiKey = options.geminiApiKey || process.env.GEMINI_API_KEY;
    this.claudeApiKey = options.claudeApiKey || process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;

    if (!this.geminiApiKey) {
      throw new Error('GEMINI_API_KEY is required - set in .env or pass as option');
    }
    if (!this.claudeApiKey) {
      throw new Error('ANTHROPIC_API_KEY is required - set in .env or pass as option');
    }

    // Initialize services
    this.ai = new NanoBananaAI(this.geminiApiKey, {
      outputDir: IMAGES_DIR,
      model: options.model || MODELS.GEMINI_2_FLASH
    });

    this.promptGenerator = new ImagePromptGenerator(this.claudeApiKey, {
      model: options.claudeModel || 'claude-sonnet-4-20250514'
    });

    // Initialize database
    const dbPath = path.join(DATA_DIR, 'store.db');
    this.db = new Database(dbPath);
    this.db.pragma('foreign_keys = ON');
    initAiDb(this.db);

    console.log('[NanoBananaWorkflow] Initialized');
    console.log(`[NanoBananaWorkflow] Images dir: ${IMAGES_DIR}`);
  }

  generateId() {
    return crypto.randomUUID();
  }

  /**
   * Save a prompt to the database
   */
  savePrompt(promptData) {
    const id = this.generateId();
    const stmt = this.db.prepare(`
      INSERT INTO ai_prompts (id, keywords, prompt, category, tags, model, aspect_ratio)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      promptData.keywords,
      promptData.prompt,
      promptData.category,
      JSON.stringify(promptData.tags || []),
      promptData.model || MODELS.GEMINI_2_FLASH,
      promptData.aspectRatio || '1:1'
    );

    return { id, ...promptData };
  }

  /**
   * Get saved prompts
   */
  getPrompts(options = {}) {
    const { category, limit = 100, offset = 0 } = options;

    let sql = 'SELECT * FROM ai_prompts';
    const params = [];

    if (category) {
      sql += ' WHERE category = ?';
      params.push(category);
    }

    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    return this.db.prepare(sql).all(...params);
  }

  /**
   * Save a generation record
   */
  saveGeneration(genData) {
    const id = this.generateId();
    const stmt = this.db.prepare(`
      INSERT INTO ai_generations (id, prompt_id, generation_id, prompt, model, provider, aspect_ratio, width, height, num_images, status, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      genData.promptId || null,
      genData.generationId,
      genData.prompt,
      genData.model,
      genData.provider || 'gemini',
      genData.aspectRatio,
      genData.width,
      genData.height,
      genData.numImages,
      'complete', // Gemini is synchronous
      new Date().toISOString()
    );

    return id;
  }

  /**
   * Save an image record and optionally add to artwork table
   */
  saveImage(imageData, addToArtwork = true) {
    const id = this.generateId();

    const stmt = this.db.prepare(`
      INSERT INTO ai_images (id, generation_id, provider_image_id, prompt, filename, file_path, url, width, height, category, tags, source_image_path, operation_type, seed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      imageData.generationId,
      imageData.providerImageId || null,
      imageData.prompt,
      imageData.filename,
      imageData.filePath,
      imageData.url || null,
      imageData.width,
      imageData.height,
      imageData.category,
      JSON.stringify(imageData.tags || []),
      imageData.sourceImagePath || null,
      imageData.operationType || 'generate',
      imageData.seed || null
    );

    let artworkId = null;
    if (addToArtwork) {
      artworkId = this.addToArtwork(imageData);
      this.db.prepare('UPDATE ai_images SET artwork_id = ? WHERE id = ?').run(artworkId, id);
    }

    return { id, artworkId };
  }

  /**
   * Add image to the custom_art_artwork table
   */
  addToArtwork(imageData) {
    const id = this.generateId();
    const title = this.generateTitle(imageData.prompt);
    const seoFilename = imageData.filename.replace(/\.[^.]+$/, '');

    // Calculate relative path for web serving
    const relativePath = `/images/ai-generated/${imageData.filename}`;

    const stmt = this.db.prepare(`
      INSERT INTO custom_art_artwork (id, title, description, tags, category, file_path, status, active)
      VALUES (?, ?, ?, ?, ?, ?, 'active', 1)
    `);

    stmt.run(
      id,
      title,
      imageData.prompt,
      JSON.stringify(imageData.tags || []),
      imageData.category,
      relativePath
    );

    try {
      this.db.prepare('UPDATE custom_art_artwork SET seo_filename = ? WHERE id = ?').run(seoFilename, id);
    } catch (e) {
      // Column might not exist
    }

    console.log(`[NanoBananaWorkflow] Added to artwork: ${title} (${id})`);
    return id;
  }

  /**
   * Generate a title from prompt
   */
  generateTitle(prompt) {
    const words = prompt
      .split(/[,\s]+/)
      .filter(w => w.length > 2)
      .slice(0, 6);
    return words.join(' ').substring(0, 100);
  }

  /**
   * Save prompt to file
   */
  savePromptToFile(promptData) {
    const filename = `prompt-${Date.now()}.json`;
    const filepath = path.join(PROMPTS_DIR, filename);
    fs.writeFileSync(filepath, JSON.stringify(promptData, null, 2));
    return filepath;
  }

  /**
   * FULL WORKFLOW: Keywords -> Prompt -> Generate -> Save -> Database
   */
  async run(keywords, options = {}) {
    const {
      aspectRatio = '1:1',
      numImages = 1,
      model = MODELS.GEMINI_2_FLASH,
      category = null,
      style = null,
      addToArtwork = true,
      savePromptFile = true
    } = options;

    console.log(`\n[NanoBananaWorkflow] Starting workflow for: "${keywords}"`);
    console.log(`[NanoBananaWorkflow] Aspect ratio: ${aspectRatio}, Images: ${numImages}`);

    const result = {
      keywords,
      options,
      steps: {},
      images: [],
      success: false,
      error: null
    };

    try {
      // Step 1: Generate prompt with Claude
      console.log('\n[Step 1] Generating prompt with Claude...');
      const promptResult = await this.promptGenerator.generatePrompt(keywords, {
        category,
        style,
        includeNegative: false // Gemini doesn't support negative prompts
      });

      result.steps.promptGeneration = {
        success: true,
        prompt: promptResult.prompts[0],
        category: promptResult.category
      };

      // Save prompt to database
      const savedPrompt = this.savePrompt({
        keywords,
        prompt: promptResult.prompts[0],
        category: promptResult.category,
        model,
        aspectRatio
      });

      if (savePromptFile) {
        this.savePromptToFile({
          ...savedPrompt,
          generatedAt: new Date().toISOString()
        });
      }

      console.log(`[Step 1] Prompt generated: "${promptResult.prompts[0].substring(0, 80)}..."`);

      // Step 2: Generate images with Gemini
      console.log('\n[Step 2] Generating images with Gemini...');
      const images = await this.ai.generate(promptResult.prompts[0], {
        aspectRatio,
        numImages,
        model
      });

      result.steps.imageGeneration = {
        success: true,
        count: images.length
      };

      console.log(`[Step 2] Generated ${images.length} image(s)`);

      // Step 3: Save to database
      console.log('\n[Step 3] Saving to database...');
      for (const image of images) {
        const saved = this.saveImage({
          generationId: image.generationId,
          providerImageId: image.id,
          prompt: promptResult.prompts[0],
          filename: image.filename,
          filePath: image.localPath,
          url: image.url,
          width: image.width,
          height: image.height,
          category: promptResult.category,
          tags: image.tags,
          seed: image.seed,
          operationType: 'generate'
        }, addToArtwork);

        result.images.push({
          ...image,
          dbId: saved.id,
          artworkId: saved.artworkId
        });
      }

      result.steps.database = {
        success: true,
        imagesAdded: result.images.length,
        artworkAdded: addToArtwork ? result.images.length : 0
      };

      result.success = true;
      console.log('\n[NanoBananaWorkflow] Workflow completed successfully!');

    } catch (error) {
      result.error = error.message;
      console.error(`\n[NanoBananaWorkflow] Error: ${error.message}`);
    }

    return result;
  }

  /**
   * Run workflow with an existing prompt (skip prompt generation)
   */
  async runWithPrompt(prompt, options = {}) {
    const {
      aspectRatio = '1:1',
      numImages = 1,
      model = MODELS.GEMINI_2_FLASH,
      category = null,
      addToArtwork = true
    } = options;

    console.log(`\n[NanoBananaWorkflow] Running with existing prompt`);

    const result = {
      prompt,
      options,
      images: [],
      success: false,
      error: null
    };

    try {
      const detectedCategory = category || this.promptGenerator.detectCategory(prompt);

      const images = await this.ai.generate(prompt, {
        aspectRatio,
        numImages,
        model
      });

      for (const image of images) {
        const saved = this.saveImage({
          generationId: image.generationId,
          providerImageId: image.id,
          prompt,
          filename: image.filename,
          filePath: image.localPath,
          url: image.url,
          width: image.width,
          height: image.height,
          category: detectedCategory,
          tags: image.tags,
          seed: image.seed,
          operationType: 'generate'
        }, addToArtwork);

        result.images.push({
          ...image,
          dbId: saved.id,
          artworkId: saved.artworkId
        });
      }

      result.success = true;

    } catch (error) {
      result.error = error.message;
    }

    return result;
  }

  /**
   * Batch generate from multiple keywords
   */
  async runBatch(keywordsList, options = {}) {
    const results = [];

    for (let i = 0; i < keywordsList.length; i++) {
      console.log(`\n[Batch ${i + 1}/${keywordsList.length}]`);
      const result = await this.run(keywordsList[i], options);
      results.push(result);

      if (i < keywordsList.length - 1) {
        console.log('[Batch] Waiting 2 seconds before next...');
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    return results;
  }

  /**
   * Get recent generations (queries both new and legacy tables)
   */
  getRecentGenerations(limit = 20) {
    // Try to query both tables, fall back to just ai_generations if leonardo tables don't exist
    try {
      return this.db.prepare(`
        SELECT id, generation_id, prompt, model, 'gemini' as provider, aspect_ratio, width, height, num_images, status, created_at, completed_at
        FROM ai_generations
        UNION ALL
        SELECT id, generation_id, prompt, model, 'leonardo' as provider, aspect_ratio, width, height, num_images, status, created_at, completed_at
        FROM leonardo_generations
        ORDER BY created_at DESC
        LIMIT ?
      `).all(limit);
    } catch (e) {
      return this.db.prepare(`
        SELECT * FROM ai_generations
        ORDER BY created_at DESC
        LIMIT ?
      `).all(limit);
    }
  }

  /**
   * Get images by category (queries both new and legacy tables)
   */
  getImagesByCategory(category, limit = 50) {
    try {
      return this.db.prepare(`
        SELECT id, generation_id, prompt, filename, file_path, width, height, category, tags, 'gemini' as provider, operation_type, created_at
        FROM ai_images WHERE category = ?
        UNION ALL
        SELECT id, leonardo_generation_id as generation_id, prompt, filename, file_path, width, height, category, tags, 'leonardo' as provider, 'generate' as operation_type, created_at
        FROM leonardo_images WHERE category = ?
        ORDER BY created_at DESC
        LIMIT ?
      `).all(category, category, limit);
    } catch (e) {
      return this.db.prepare(`
        SELECT * FROM ai_images WHERE category = ? ORDER BY created_at DESC LIMIT ?
      `).all(category, limit);
    }
  }

  /**
   * Search images by tags
   */
  searchByTags(tags, limit = 50) {
    const tagPatterns = tags.map(t => `%${t}%`);
    const conditions = tagPatterns.map(() => 'tags LIKE ?').join(' OR ');

    try {
      return this.db.prepare(`
        SELECT id, generation_id, prompt, filename, file_path, category, tags, 'gemini' as provider, created_at
        FROM ai_images WHERE ${conditions}
        UNION ALL
        SELECT id, leonardo_generation_id as generation_id, prompt, filename, file_path, category, tags, 'leonardo' as provider, created_at
        FROM leonardo_images WHERE ${conditions}
        ORDER BY created_at DESC
        LIMIT ?
      `).all(...tagPatterns, ...tagPatterns, limit);
    } catch (e) {
      return this.db.prepare(`
        SELECT * FROM ai_images WHERE ${conditions} ORDER BY created_at DESC LIMIT ?
      `).all(...tagPatterns, limit);
    }
  }

  /**
   * Get workflow statistics
   */
  getStats() {
    const stats = {
      totalPrompts: this.db.prepare('SELECT COUNT(*) as count FROM ai_prompts').get().count,
      totalGenerations: this.db.prepare('SELECT COUNT(*) as count FROM ai_generations').get().count,
      totalImages: this.db.prepare('SELECT COUNT(*) as count FROM ai_images').get().count,
      byCategory: this.db.prepare(`
        SELECT category, COUNT(*) as count FROM ai_images GROUP BY category
      `).all(),
      byOperation: this.db.prepare(`
        SELECT operation_type, COUNT(*) as count FROM ai_images GROUP BY operation_type
      `).all(),
      recentGenerations: this.getRecentGenerations(5)
    };

    // Include legacy counts if available
    try {
      stats.legacyImages = this.db.prepare('SELECT COUNT(*) as count FROM leonardo_images').get().count;
    } catch (e) {
      stats.legacyImages = 0;
    }

    return stats;
  }

  /**
   * Check API status (Gemini doesn't have a token balance endpoint)
   */
  async checkStatus() {
    try {
      // Quick test generation to verify API key works
      const model = this.ai.genAI.getGenerativeModel({ model: MODELS.GEMINI_2_FLASH });
      const result = await model.generateContent('Say "API OK" in exactly 2 words');
      return {
        status: 'active',
        provider: 'gemini',
        model: MODELS.GEMINI_2_FLASH,
        message: result.response.text().trim()
      };
    } catch (error) {
      return { status: 'error', error: error.message };
    }
  }

  /**
   * Close database connection
   */
  close() {
    try {
      this.db.close();
    } catch (e) {
      // ignore
    }
  }
}

// Export with backward-compatible aliases
module.exports = {
  NanoBananaWorkflow,
  LeonardoWorkflow: NanoBananaWorkflow, // backward compat
  MODELS,
  ASPECT_RATIOS
};
