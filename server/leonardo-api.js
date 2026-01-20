/**
 * Leonardo.ai API Routes
 * Express router for Leonardo.ai integration endpoints
 */

const express = require('express');
const { LeonardoWorkflow, MODELS, ASPECT_RATIOS } = require('./leonardo-workflow');
const { LeonardoPromptGenerator } = require('./leonardo-prompt-generator');

const router = express.Router();

// Initialize workflow (lazy loading)
let workflow = null;
let promptGenerator = null;

function getWorkflow() {
  if (!workflow) {
    workflow = new LeonardoWorkflow();
  }
  return workflow;
}

function getPromptGenerator() {
  if (!promptGenerator) {
    promptGenerator = new LeonardoPromptGenerator(
      process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY
    );
  }
  return promptGenerator;
}

/**
 * GET /api/leonardo/status
 * Check API status and token balance
 */
router.get('/status', async (req, res) => {
  try {
    const wf = getWorkflow();
    const tokens = await wf.checkTokens();
    const stats = wf.getStats();

    res.json({
      success: true,
      api: tokens,
      stats
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/leonardo/options
 * Get available models, aspect ratios, etc.
 */
router.get('/options', (req, res) => {
  res.json({
    models: Object.entries(MODELS).map(([name, id]) => ({ name, id })),
    aspectRatios: Object.entries(ASPECT_RATIOS).map(([ratio, dims]) => ({
      ratio,
      ...dims
    })),
    categories: ['vehicle', 'room', 'model', 'marketing', 'artwork']
  });
});

/**
 * POST /api/leonardo/prompt
 * Generate a prompt from keywords (no image generation)
 */
router.post('/prompt', async (req, res) => {
  try {
    const { keywords, category, style, numVariations = 1 } = req.body;

    if (!keywords) {
      return res.status(400).json({ success: false, error: 'Keywords required' });
    }

    const generator = getPromptGenerator();
    const result = await generator.generatePrompt(keywords, {
      category,
      style,
      numVariations,
      includeNegative: true
    });

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/leonardo/generate
 * Full workflow: keywords -> prompt -> generate -> download -> tag -> database
 */
router.post('/generate', async (req, res) => {
  try {
    const {
      keywords,
      prompt: existingPrompt,
      aspectRatio = '1:1',
      numImages = 1,
      model,
      category,
      style,
      addToArtwork = true
    } = req.body;

    if (!keywords && !existingPrompt) {
      return res.status(400).json({
        success: false,
        error: 'Either keywords or prompt required'
      });
    }

    const wf = getWorkflow();

    let result;
    if (existingPrompt) {
      // Use existing prompt
      result = await wf.runWithPrompt(existingPrompt, {
        aspectRatio,
        numImages,
        model: model ? MODELS[model] || model : undefined,
        category,
        addToArtwork
      });
    } else {
      // Full workflow with prompt generation
      result = await wf.run(keywords, {
        aspectRatio,
        numImages,
        model: model ? MODELS[model] || model : undefined,
        category,
        style,
        addToArtwork
      });
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/leonardo/batch
 * Batch generate from multiple keywords
 */
router.post('/batch', async (req, res) => {
  try {
    const { keywords: keywordsList, ...options } = req.body;

    if (!Array.isArray(keywordsList) || keywordsList.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'keywords array required'
      });
    }

    if (keywordsList.length > 10) {
      return res.status(400).json({
        success: false,
        error: 'Maximum 10 items per batch'
      });
    }

    const wf = getWorkflow();
    const results = await wf.runBatch(keywordsList, options);

    res.json({
      success: true,
      total: keywordsList.length,
      successful: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/leonardo/prompts
 * Get saved prompts
 */
router.get('/prompts', (req, res) => {
  try {
    const { category, limit = 50, offset = 0 } = req.query;
    const wf = getWorkflow();
    const prompts = wf.getPrompts({
      category,
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10)
    });

    res.json({ success: true, prompts });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/leonardo/generations
 * Get recent generations
 */
router.get('/generations', (req, res) => {
  try {
    const { limit = 20 } = req.query;
    const wf = getWorkflow();
    const generations = wf.getRecentGenerations(parseInt(limit, 10));

    res.json({ success: true, generations });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/leonardo/images
 * Get generated images
 */
router.get('/images', (req, res) => {
  try {
    const { category, tags, limit = 50 } = req.query;
    const wf = getWorkflow();

    let images;
    if (category) {
      images = wf.getImagesByCategory(category, parseInt(limit, 10));
    } else if (tags) {
      const tagArray = tags.split(',').map(t => t.trim());
      images = wf.searchByTags(tagArray, parseInt(limit, 10));
    } else {
      // Get all recent
      images = wf.db.prepare(`
        SELECT * FROM leonardo_images
        ORDER BY created_at DESC
        LIMIT ?
      `).all(parseInt(limit, 10));
    }

    res.json({ success: true, images });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
