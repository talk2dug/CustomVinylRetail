/**
 * Leonardo.ai Full Workflow Service
 * Integrates prompt generation, image generation, downloading, tagging, and database storage
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { LeonardoAI, MODELS, ASPECT_RATIOS } = require('./leonardo-ai');
const { LeonardoPromptGenerator } = require('./leonardo-prompt-generator');

// Configuration
const APP_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.LIBRARY_ROOT
  ? path.join(process.env.LIBRARY_ROOT, 'data')
  : path.join(APP_ROOT, 'data');
const IMAGES_DIR = process.env.LIBRARY_ROOT
  ? path.join(process.env.LIBRARY_ROOT, 'images', 'leonardo')
  : path.join(APP_ROOT, 'web', 'images', 'leonardo');
const PROMPTS_DIR = path.join(DATA_DIR, 'leonardo-prompts');

// Ensure directories exist
[DATA_DIR, IMAGES_DIR, PROMPTS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

/**
 * Initialize Leonardo prompts database table
 */
function initLeonardoDb(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS leonardo_prompts (
      id TEXT PRIMARY KEY,
      keywords TEXT NOT NULL,
      prompt TEXT NOT NULL,
      negative_prompt TEXT,
      category TEXT,
      tags TEXT,
      model TEXT,
      aspect_ratio TEXT,
      times_used INTEGER DEFAULT 0,
      last_used_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_leonardo_prompts_category ON leonardo_prompts(category);
    CREATE INDEX IF NOT EXISTS idx_leonardo_prompts_keywords ON leonardo_prompts(keywords);

    CREATE TABLE IF NOT EXISTS leonardo_generations (
      id TEXT PRIMARY KEY,
      prompt_id TEXT,
      generation_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      model TEXT,
      aspect_ratio TEXT,
      width INTEGER,
      height INTEGER,
      num_images INTEGER,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      FOREIGN KEY (prompt_id) REFERENCES leonardo_prompts(id)
    );

    CREATE TABLE IF NOT EXISTS leonardo_images (
      id TEXT PRIMARY KEY,
      leonardo_generation_id TEXT NOT NULL,
      leonardo_image_id TEXT,
      prompt TEXT NOT NULL,
      filename TEXT NOT NULL,
      file_path TEXT NOT NULL,
      url TEXT,
      width INTEGER,
      height INTEGER,
      category TEXT,
      tags TEXT,
      artwork_id TEXT,
      seed INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_leonardo_images_category ON leonardo_images(category);
    CREATE INDEX IF NOT EXISTS idx_leonardo_images_generation ON leonardo_images(leonardo_generation_id);
  `);

  return db;
}

class LeonardoWorkflow {
  constructor(options = {}) {
    // API keys from env or options
    this.leonardoApiKey = options.leonardoApiKey || process.env.LEONARDO_API_KEY;
    this.claudeApiKey = options.claudeApiKey || process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;

    if (!this.leonardoApiKey) {
      throw new Error('LEONARDO_API_KEY is required - set in .env or pass as option');
    }
    if (!this.claudeApiKey) {
      throw new Error('ANTHROPIC_API_KEY is required - set in .env or pass as option');
    }

    // Initialize services
    this.leonardo = new LeonardoAI(this.leonardoApiKey, {
      outputDir: IMAGES_DIR,
      model: options.model || MODELS.PHOENIX_1_0
    });

    this.promptGenerator = new LeonardoPromptGenerator(this.claudeApiKey, {
      model: options.claudeModel || 'claude-sonnet-4-20250514'
    });

    // Initialize database
    const dbPath = path.join(DATA_DIR, 'store.db');
    this.db = new Database(dbPath);
    this.db.pragma('foreign_keys = ON');
    initLeonardoDb(this.db);

    console.log('[LeonardoWorkflow] Initialized');
    console.log(`[LeonardoWorkflow] Images dir: ${IMAGES_DIR}`);
    console.log(`[LeonardoWorkflow] Prompts dir: ${PROMPTS_DIR}`);
  }

  /**
   * Generate a unique ID
   */
  generateId() {
    return crypto.randomUUID();
  }

  /**
   * Save a prompt to the database
   */
  savePrompt(promptData) {
    const id = this.generateId();
    const stmt = this.db.prepare(`
      INSERT INTO leonardo_prompts (id, keywords, prompt, negative_prompt, category, tags, model, aspect_ratio)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      promptData.keywords,
      promptData.prompt,
      promptData.negativePrompt || null,
      promptData.category,
      JSON.stringify(promptData.tags || []),
      promptData.model || MODELS.PHOENIX_1_0,
      promptData.aspectRatio || '1:1'
    );

    return { id, ...promptData };
  }

  /**
   * Get saved prompts
   */
  getPrompts(options = {}) {
    const { category, limit = 100, offset = 0 } = options;

    let sql = 'SELECT * FROM leonardo_prompts';
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
      INSERT INTO leonardo_generations (id, prompt_id, generation_id, prompt, model, aspect_ratio, width, height, num_images, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      genData.promptId || null,
      genData.generationId,
      genData.prompt,
      genData.model,
      genData.aspectRatio,
      genData.width,
      genData.height,
      genData.numImages,
      'pending'
    );

    return id;
  }

  /**
   * Update generation status
   */
  updateGenerationStatus(id, status) {
    const stmt = this.db.prepare(`
      UPDATE leonardo_generations
      SET status = ?, completed_at = CASE WHEN ? = 'complete' THEN CURRENT_TIMESTAMP ELSE completed_at END
      WHERE id = ?
    `);
    stmt.run(status, status, id);
  }

  /**
   * Save an image record and optionally add to artwork table
   */
  saveImage(imageData, addToArtwork = true) {
    const id = this.generateId();

    // Save to leonardo_images
    const stmt = this.db.prepare(`
      INSERT INTO leonardo_images (id, leonardo_generation_id, leonardo_image_id, prompt, filename, file_path, url, width, height, category, tags, seed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      imageData.generationId,
      imageData.leonardoImageId,
      imageData.prompt,
      imageData.filename,
      imageData.filePath,
      imageData.url,
      imageData.width,
      imageData.height,
      imageData.category,
      JSON.stringify(imageData.tags || []),
      imageData.seed
    );

    // Also add to custom_art_artwork if requested
    let artworkId = null;
    if (addToArtwork) {
      artworkId = this.addToArtwork(imageData);

      // Link artwork to leonardo_image
      this.db.prepare('UPDATE leonardo_images SET artwork_id = ? WHERE id = ?').run(artworkId, id);
    }

    return { id, artworkId };
  }

  /**
   * Add image to the custom_art_artwork table
   */
  addToArtwork(imageData) {
    const id = this.generateId();

    // Generate title from prompt
    const title = this.generateTitle(imageData.prompt);

    // Generate SEO filename
    const seoFilename = imageData.filename.replace(/\.[^.]+$/, '');

    // Calculate relative path for web serving
    const relativePath = `/images/leonardo/${imageData.filename}`;

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

    // Try to add seo_filename if column exists
    try {
      this.db.prepare('UPDATE custom_art_artwork SET seo_filename = ? WHERE id = ?').run(seoFilename, id);
    } catch (e) {
      // Column might not exist, ignore
    }

    console.log(`[LeonardoWorkflow] Added to artwork: ${title} (${id})`);
    return id;
  }

  /**
   * Generate a title from prompt
   */
  generateTitle(prompt) {
    // Extract key terms for title
    const words = prompt
      .split(/[,\s]+/)
      .filter(w => w.length > 2)
      .slice(0, 6);

    return words.join(' ').substring(0, 100);
  }

  /**
   * Save prompt to file for later reference
   */
  savePromptToFile(promptData) {
    const filename = `prompt-${Date.now()}.json`;
    const filepath = path.join(PROMPTS_DIR, filename);
    fs.writeFileSync(filepath, JSON.stringify(promptData, null, 2));
    return filepath;
  }

  /**
   * FULL WORKFLOW: Keywords -> Prompt -> Generate -> Download -> Tag -> Database
   * @param {string} keywords - User's input keywords
   * @param {object} options - Workflow options
   * @returns {object} Complete workflow result
   */
  async run(keywords, options = {}) {
    const {
      aspectRatio = '1:1',
      numImages = 1,
      model = MODELS.PHOENIX_1_0,
      category = null,
      style = null,
      addToArtwork = true,
      savePromptFile = true
    } = options;

    console.log(`\n[LeonardoWorkflow] Starting workflow for: "${keywords}"`);
    console.log(`[LeonardoWorkflow] Aspect ratio: ${aspectRatio}, Images: ${numImages}`);

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
        includeNegative: true
      });

      result.steps.promptGeneration = {
        success: true,
        prompt: promptResult.prompts[0],
        negativePrompt: promptResult.negativePrompt,
        category: promptResult.category
      };

      // Save prompt to database
      const savedPrompt = this.savePrompt({
        keywords,
        prompt: promptResult.prompts[0],
        negativePrompt: promptResult.negativePrompt,
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
      console.log(`[Step 1] Category: ${promptResult.category}`);

      // Step 2: Generate images with Leonardo
      console.log('\n[Step 2] Generating images with Leonardo.ai...');
      const images = await this.leonardo.generate(promptResult.prompts[0], {
        aspectRatio,
        numImages,
        model,
        negativePrompt: promptResult.negativePrompt
      });

      result.steps.imageGeneration = {
        success: true,
        count: images.length
      };

      console.log(`[Step 2] Generated ${images.length} image(s)`);

      // Step 3: Save to database and artwork
      console.log('\n[Step 3] Saving to database...');
      for (const image of images) {
        const saved = this.saveImage({
          generationId: image.generationId,
          leonardoImageId: image.id,
          prompt: promptResult.prompts[0],
          filename: image.filename,
          filePath: image.localPath,
          url: image.url,
          width: image.width,
          height: image.height,
          category: promptResult.category,
          tags: image.tags,
          seed: image.seed
        }, addToArtwork);

        result.images.push({
          ...image,
          dbId: saved.id,
          artworkId: saved.artworkId
        });

        console.log(`[Step 3] Saved: ${image.filename}`);
      }

      result.steps.database = {
        success: true,
        imagesAdded: result.images.length,
        artworkAdded: addToArtwork ? result.images.length : 0
      };

      result.success = true;
      console.log('\n[LeonardoWorkflow] Workflow completed successfully!');

    } catch (error) {
      result.error = error.message;
      console.error(`\n[LeonardoWorkflow] Error: ${error.message}`);
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
      model = MODELS.PHOENIX_1_0,
      category = null,
      addToArtwork = true
    } = options;

    console.log(`\n[LeonardoWorkflow] Running with existing prompt`);

    const result = {
      prompt,
      options,
      images: [],
      success: false,
      error: null
    };

    try {
      // Detect category from prompt if not provided
      const detectedCategory = category || this.promptGenerator.detectCategory(prompt);

      // Generate images
      const images = await this.leonardo.generate(prompt, {
        aspectRatio,
        numImages,
        model
      });

      // Save to database
      for (const image of images) {
        const saved = this.saveImage({
          generationId: image.generationId,
          leonardoImageId: image.id,
          prompt,
          filename: image.filename,
          filePath: image.localPath,
          url: image.url,
          width: image.width,
          height: image.height,
          category: detectedCategory,
          tags: image.tags,
          seed: image.seed
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

      // Delay between batches to avoid rate limits
      if (i < keywordsList.length - 1) {
        console.log('[Batch] Waiting 5 seconds before next...');
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }

    return results;
  }

  /**
   * Get recent generations
   */
  getRecentGenerations(limit = 20) {
    return this.db.prepare(`
      SELECT g.*,
             (SELECT COUNT(*) FROM leonardo_images WHERE leonardo_generation_id = g.generation_id) as image_count
      FROM leonardo_generations g
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit);
  }

  /**
   * Get images by category
   */
  getImagesByCategory(category, limit = 50) {
    return this.db.prepare(`
      SELECT * FROM leonardo_images
      WHERE category = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(category, limit);
  }

  /**
   * Search images by tags
   */
  searchByTags(tags, limit = 50) {
    const tagPatterns = tags.map(t => `%${t}%`);
    const conditions = tagPatterns.map(() => 'tags LIKE ?').join(' OR ');

    return this.db.prepare(`
      SELECT * FROM leonardo_images
      WHERE ${conditions}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...tagPatterns, limit);
  }

  /**
   * Get workflow statistics
   */
  getStats() {
    const stats = {
      totalPrompts: this.db.prepare('SELECT COUNT(*) as count FROM leonardo_prompts').get().count,
      totalGenerations: this.db.prepare('SELECT COUNT(*) as count FROM leonardo_generations').get().count,
      totalImages: this.db.prepare('SELECT COUNT(*) as count FROM leonardo_images').get().count,
      byCategory: this.db.prepare(`
        SELECT category, COUNT(*) as count
        FROM leonardo_images
        GROUP BY category
      `).all(),
      recentGenerations: this.getRecentGenerations(5)
    };

    return stats;
  }

  /**
   * Check Leonardo API token balance
   */
  async checkTokens() {
    try {
      const userInfo = await this.leonardo.getUserInfo();
      return {
        tokensRemaining: userInfo.apiConcurrencySlots || userInfo.subscriptionTokens,
        plan: userInfo.subscriptionPlan || 'Unknown',
        ...userInfo
      };
    } catch (error) {
      return { error: error.message };
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

// Export
module.exports = { LeonardoWorkflow, MODELS, ASPECT_RATIOS };
