/**
 * Nano Banana Server - HTTP route handler for AI image generation
 * Replaces Leonardo.ai server routes with Gemini-powered endpoints
 * Mounts at /api/ai-images/* and /api/leonardo/* (backward compat)
 */

const path = require('path');
const { NanoBananaWorkflow, MODELS, ASPECT_RATIOS } = require('./nano-banana-workflow');
const { ImagePromptGenerator, PROMPT_TEMPLATES } = require('./leonardo-prompt-generator');
const { NanoBananaService, STYLES } = require('./nano-banana-service');
const { parseBody, sendJson } = require('./utils/http');

// Lazy-load services to avoid startup issues if API keys aren't set
let workflow = null;
let promptGenerator = null;
let service = null;

function getWorkflow() {
  if (!workflow) {
    workflow = new NanoBananaWorkflow();
  }
  return workflow;
}

function getPromptGenerator() {
  if (!promptGenerator) {
    const apiKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY not configured');
    }
    promptGenerator = new ImagePromptGenerator(apiKey);
  }
  return promptGenerator;
}

function getService() {
  if (!service) {
    service = new NanoBananaService();
  }
  return service;
}

/**
 * Handle AI image routes
 * Supports both /api/ai-images/* and /api/leonardo/* (backward compat)
 */
async function handleAiImageRoute(pathname, req, res) {
  let route;

  if (pathname.startsWith('/api/ai-images')) {
    route = pathname.slice('/api/ai-images'.length) || '/';
  } else if (pathname.startsWith('/api/leonardo')) {
    route = pathname.slice('/api/leonardo'.length) || '/';
  } else {
    return false;
  }

  try {
    // ============================================================
    // GET ROUTES
    // ============================================================

    // GET /status
    if (req.method === 'GET' && route === '/status') {
      const wf = getWorkflow();
      const status = await wf.checkStatus();
      const stats = wf.getStats();
      sendJson(res, 200, { success: true, api: status, stats });
      return true;
    }

    // GET /options
    if (req.method === 'GET' && route === '/options') {
      sendJson(res, 200, {
        models: Object.entries(MODELS).map(([name, id]) => ({ name, id })),
        aspectRatios: Object.entries(ASPECT_RATIOS).map(([ratio, dims]) => ({ ratio, ...dims })),
        styles: Object.entries(STYLES).map(([name, descriptor]) => ({ name, descriptor })),
        categories: Object.keys(PROMPT_TEMPLATES)
      });
      return true;
    }

    // GET /prompts
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

    // GET /generations
    if (req.method === 'GET' && route === '/generations') {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const limit = parseInt(url.searchParams.get('limit') || '20', 10);

      const wf = getWorkflow();
      const generations = wf.getRecentGenerations(limit);
      sendJson(res, 200, { success: true, generations });
      return true;
    }

    // GET /images
    if (req.method === 'GET' && route === '/images') {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const category = url.searchParams.get('category');
      const tags = url.searchParams.get('tags');
      const operation = url.searchParams.get('operation');
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);

      const wf = getWorkflow();
      let images;

      if (category) {
        images = wf.getImagesByCategory(category, limit);
      } else if (tags) {
        const tagArray = tags.split(',').map(t => t.trim());
        images = wf.searchByTags(tagArray, limit);
      } else if (operation) {
        images = wf.db.prepare(`
          SELECT * FROM ai_images WHERE operation_type = ? ORDER BY created_at DESC LIMIT ?
        `).all(operation, limit);
      } else {
        // Get from both tables
        try {
          images = wf.db.prepare(`
            SELECT id, generation_id, prompt, filename, file_path, category, tags, operation_type, 'gemini' as provider, created_at
            FROM ai_images
            UNION ALL
            SELECT id, leonardo_generation_id as generation_id, prompt, filename, file_path, category, tags, 'generate' as operation_type, 'leonardo' as provider, created_at
            FROM leonardo_images
            ORDER BY created_at DESC
            LIMIT ?
          `).all(limit);
        } catch (e) {
          images = wf.db.prepare('SELECT * FROM ai_images ORDER BY created_at DESC LIMIT ?').all(limit);
        }
      }

      sendJson(res, 200, { success: true, images });
      return true;
    }

    // ============================================================
    // POST ROUTES
    // ============================================================

    // POST /prompt - Generate prompt only
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
        includeNegative: false
      });

      sendJson(res, 200, { success: true, ...result });
      return true;
    }

    // POST /generate - Full workflow (keywords -> prompt -> generate -> DB)
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

    // POST /edit - Edit an existing image
    if (req.method === 'POST' && route === '/edit') {
      const body = await parseBody(req);
      const { imagePath, editPrompt } = body;

      if (!imagePath || !editPrompt) {
        sendJson(res, 400, { success: false, error: 'imagePath and editPrompt required' });
        return true;
      }

      const svc = getService();
      const results = await svc.editImage(imagePath, editPrompt, body);

      // Save to DB
      const wf = getWorkflow();
      for (const img of results) {
        wf.saveImage({
          generationId: img.generationId,
          prompt: img.prompt,
          filename: img.filename,
          filePath: img.localPath,
          category: 'edits',
          tags: ['ai-generated', 'edited'],
          sourceImagePath: imagePath,
          operationType: 'edit'
        }, false);
      }

      sendJson(res, 200, { success: true, images: results });
      return true;
    }

    // POST /vectorize - Vectorize an image
    if (req.method === 'POST' && route === '/vectorize') {
      const body = await parseBody(req);
      const { imagePath, style = 'clean', background = 'transparent' } = body;

      if (!imagePath) {
        sendJson(res, 400, { success: false, error: 'imagePath required' });
        return true;
      }

      const svc = getService();
      const results = await svc.vectorizeImage(imagePath, { style, background });

      // Save to DB
      const wf = getWorkflow();
      for (const img of results) {
        wf.saveImage({
          generationId: img.generationId,
          prompt: img.prompt,
          filename: img.filename,
          filePath: img.localPath,
          category: 'vectorized',
          tags: ['ai-generated', 'vectorized', style],
          sourceImagePath: imagePath,
          operationType: 'vectorize'
        }, false);
      }

      sendJson(res, 200, { success: true, images: results });
      return true;
    }

    // POST /scene - Generate a scene around a subject
    if (req.method === 'POST' && route === '/scene') {
      const body = await parseBody(req);
      const { imagePath, scenePrompt, sceneType = 'custom', subDir = 'scenes' } = body;

      if (!imagePath || !scenePrompt) {
        sendJson(res, 400, { success: false, error: 'imagePath and scenePrompt required' });
        return true;
      }

      const svc = getService();
      const results = await svc.generateScene(imagePath, scenePrompt, { sceneType, subDir });

      const wf = getWorkflow();
      for (const img of results) {
        wf.saveImage({
          generationId: img.generationId,
          prompt: img.prompt,
          filename: img.filename,
          filePath: img.localPath,
          category: `scenes/${sceneType}`,
          tags: ['ai-generated', 'scene', sceneType],
          sourceImagePath: imagePath,
          operationType: 'scene'
        }, false);
      }

      sendJson(res, 200, { success: true, images: results });
      return true;
    }

    // POST /modify - Art modification (aspect ratio, variation, iteration, crop)
    if (req.method === 'POST' && route === '/modify') {
      const body = await parseBody(req);
      const { imagePath, type, targetRatio, variationPrompt, iterationPrompt, numIterations, focusPoint } = body;

      if (!imagePath || !type) {
        sendJson(res, 400, { success: false, error: 'imagePath and type required. Type: aspect_ratio, variation, iterate, crop' });
        return true;
      }

      const svc = getService();
      let results;

      switch (type) {
        case 'aspect_ratio':
          if (!targetRatio) {
            sendJson(res, 400, { success: false, error: 'targetRatio required for aspect_ratio modification' });
            return true;
          }
          results = await svc.changeAspectRatio(imagePath, targetRatio);
          break;

        case 'variation':
          results = await svc.createVariation(imagePath, variationPrompt);
          break;

        case 'iterate':
          results = await svc.iterateArtwork(imagePath, iterationPrompt || 'Refine and improve the quality of this artwork', numIterations || 3);
          break;

        case 'crop':
          if (!targetRatio) {
            sendJson(res, 400, { success: false, error: 'targetRatio required for crop' });
            return true;
          }
          results = await svc.smartCrop(imagePath, targetRatio, { focusPoint });
          break;

        default:
          sendJson(res, 400, { success: false, error: `Unknown modification type: ${type}` });
          return true;
      }

      // Save to DB
      const wf = getWorkflow();
      for (const img of results) {
        if (img.generationId) {
          wf.saveImage({
            generationId: img.generationId,
            prompt: img.prompt || `${type}: ${targetRatio || variationPrompt || iterationPrompt}`,
            filename: img.filename,
            filePath: img.localPath,
            category: 'art-modifications',
            tags: ['ai-generated', 'modified', type],
            sourceImagePath: imagePath,
            operationType: img.operationType || type
          }, false);
        }
      }

      sendJson(res, 200, { success: true, images: results });
      return true;
    }

    // POST /batch - Batch generate
    if (req.method === 'POST' && route === '/batch') {
      const body = await parseBody(req);
      const { keywordsList, options = {} } = body;

      if (!keywordsList || !Array.isArray(keywordsList) || keywordsList.length === 0) {
        sendJson(res, 400, { success: false, error: 'keywordsList (array) required' });
        return true;
      }

      if (keywordsList.length > 10) {
        sendJson(res, 400, { success: false, error: 'Maximum 10 items per batch' });
        return true;
      }

      const wf = getWorkflow();
      const results = await wf.runBatch(keywordsList, options);

      sendJson(res, 200, { success: true, results });
      return true;
    }

    // Route not found
    sendJson(res, 404, { success: false, error: 'AI image route not found' });
    return true;

  } catch (error) {
    console.error('[AI Image API Error]', error);
    sendJson(res, 500, { success: false, error: error.message });
    return true;
  }
}

module.exports = { handleAiImageRoute };
