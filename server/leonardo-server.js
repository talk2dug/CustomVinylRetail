/**
 * Leonardo.ai Server Integration
 * HTTP request handlers for Leonardo.ai image generation
 */

const { LeonardoWorkflow, MODELS, ASPECT_RATIOS } = require('./leonardo-workflow');
const { LeonardoPromptGenerator } = require('./leonardo-prompt-generator');
const { parseBody, sendJson } = require('./utils/http');

// Lazy-load workflow to avoid startup issues if API keys aren't set
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
    const apiKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY not configured');
    }
    promptGenerator = new LeonardoPromptGenerator(apiKey);
  }
  return promptGenerator;
}

/**
 * Handle Leonardo API routes
 * @param {string} pathname - URL pathname
 * @param {object} req - HTTP request
 * @param {object} res - HTTP response
 * @returns {boolean} - true if route was handled
 */
async function handleLeonardoRoute(pathname, req, res) {
  const basePath = '/api/leonardo';

  if (!pathname.startsWith(basePath)) {
    return false;
  }

  const route = pathname.slice(basePath.length) || '/';

  try {
    // GET /api/leonardo/status
    if (req.method === 'GET' && route === '/status') {
      const wf = getWorkflow();
      const tokens = await wf.checkTokens();
      const stats = wf.getStats();
      sendJson(res, 200, { success: true, api: tokens, stats });
      return true;
    }

    // GET /api/leonardo/options
    if (req.method === 'GET' && route === '/options') {
      sendJson(res, 200, {
        models: Object.entries(MODELS).map(([name, id]) => ({ name, id })),
        aspectRatios: Object.entries(ASPECT_RATIOS).map(([ratio, dims]) => ({ ratio, ...dims })),
        categories: ['vehicle', 'room', 'model', 'marketing', 'artwork']
      });
      return true;
    }

    // POST /api/leonardo/prompt - Generate prompt only
    if (req.method === 'POST' && route === '/prompt') {
      const body = await parseBody(req);
      const { keywords, category, style, numVariations = 1 } = body;

      if (!keywords) {
        sendJson(res, 400, { success: false, error: 'Keywords required' });
        return true;
      }

      const generator = getPromptGenerator();
      const result = await generator.generatePrompt(keywords, {
        category,
        style,
        numVariations,
        includeNegative: true
      });

      sendJson(res, 200, { success: true, ...result });
      return true;
    }

    // POST /api/leonardo/generate - Full workflow
    if (req.method === 'POST' && route === '/generate') {
      const body = await parseBody(req);
      const {
        keywords,
        prompt: existingPrompt,
        aspectRatio = '1:1',
        numImages = 1,
        model,
        category,
        style,
        addToArtwork = true
      } = body;

      if (!keywords && !existingPrompt) {
        sendJson(res, 400, { success: false, error: 'Either keywords or prompt required' });
        return true;
      }

      const wf = getWorkflow();
      let result;

      if (existingPrompt) {
        result = await wf.runWithPrompt(existingPrompt, {
          aspectRatio,
          numImages,
          model: model ? MODELS[model] || model : undefined,
          category,
          addToArtwork
        });
      } else {
        result = await wf.run(keywords, {
          aspectRatio,
          numImages,
          model: model ? MODELS[model] || model : undefined,
          category,
          style,
          addToArtwork
        });
      }

      sendJson(res, 200, result);
      return true;
    }

    // GET /api/leonardo/prompts - Get saved prompts
    if (req.method === 'GET' && route === '/prompts') {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const category = url.searchParams.get('category') || undefined;
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      const offset = parseInt(url.searchParams.get('offset') || '0', 10);

      const wf = getWorkflow();
      const prompts = wf.getPrompts({ category, limit, offset });

      sendJson(res, 200, { success: true, prompts });
      return true;
    }

    // GET /api/leonardo/generations - Get recent generations
    if (req.method === 'GET' && route === '/generations') {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const limit = parseInt(url.searchParams.get('limit') || '20', 10);

      const wf = getWorkflow();
      const generations = wf.getRecentGenerations(limit);

      sendJson(res, 200, { success: true, generations });
      return true;
    }

    // GET /api/leonardo/images - Get generated images
    if (req.method === 'GET' && route === '/images') {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const category = url.searchParams.get('category');
      const tags = url.searchParams.get('tags');
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);

      const wf = getWorkflow();
      let images;

      if (category) {
        images = wf.getImagesByCategory(category, limit);
      } else if (tags) {
        const tagArray = tags.split(',').map(t => t.trim());
        images = wf.searchByTags(tagArray, limit);
      } else {
        images = wf.db.prepare(`
          SELECT * FROM leonardo_images
          ORDER BY created_at DESC
          LIMIT ?
        `).all(limit);
      }

      sendJson(res, 200, { success: true, images });
      return true;
    }

    // Route not found within Leonardo API
    sendJson(res, 404, { success: false, error: 'Leonardo API route not found' });
    return true;

  } catch (error) {
    console.error('[Leonardo API Error]', error);
    sendJson(res, 500, { success: false, error: error.message });
    return true;
  }
}

module.exports = { handleLeonardoRoute };
