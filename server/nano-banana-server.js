/**
 * Nano Banana Server - HTTP route handler for AI image generation
 * Replaces Leonardo.ai server routes with Gemini-powered endpoints
 * Mounts at /api/ai-images/* and /api/leonardo/* (backward compat)
 */

const fs = require('fs');
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

    // POST /apparel-mockup - AI apparel mockup generation
    if (req.method === 'POST' && route === '/apparel-mockup') {
      const body = await parseBody(req);
      const {
        modelFrontId,
        modelBackId,
        modelFrontPath,
        modelBackPath,
        clothingColor,
        placements = [],
        backPlacements = [],
        garmentType = 't-shirt',
        generateSideBySide = true
      } = body;

      if (!modelFrontId && !modelBackId && !modelFrontPath && !modelBackPath) {
        sendJson(res, 400, { success: false, error: 'At least one model ID or image path required' });
        return true;
      }

      if (placements.length === 0 && backPlacements.length === 0) {
        sendJson(res, 400, { success: false, error: 'At least one placement required' });
        return true;
      }

      // Resolve and validate placement graphic paths
      const LIBRARY_ROOT = process.env.LIBRARY_ROOT || path.join(__dirname, '..', 'web', 'library');
      for (const p of [...placements, ...backPlacements]) {
        if (!p.graphicPath) {
          sendJson(res, 400, { success: false, error: 'Each placement requires a graphicPath' });
          return true;
        }
        // Strip full URL to path — handles https://blueridgecustomco.com/library/... or https://store.swayzecustomvinyl.com/library/...
        if (/^https?:\/\//i.test(p.graphicPath)) {
          try {
            const urlObj = new URL(p.graphicPath);
            p.graphicPath = decodeURIComponent(urlObj.pathname);
          } catch (_) {
            // If URL parsing fails, try simple regex extraction
            p.graphicPath = p.graphicPath.replace(/^https?:\/\/[^/]+/, '');
          }
        }
        // Resolve web-relative paths to filesystem paths
        if (!path.isAbsolute(p.graphicPath)) {
          // Handle paths like "library/designs/..." or "/library/designs/..."
          let relPath = p.graphicPath.replace(/^\//, '');
          if (relPath.startsWith('library/')) {
            p.graphicPath = path.join(LIBRARY_ROOT, relPath.slice('library/'.length));
          } else {
            p.graphicPath = path.join(LIBRARY_ROOT, relPath);
          }
        } else if (p.graphicPath.startsWith('/library/')) {
          p.graphicPath = path.join(LIBRARY_ROOT, p.graphicPath.slice('/library/'.length));
        }
        if (!fs.existsSync(p.graphicPath)) {
          sendJson(res, 400, { success: false, error: `Graphic file not found: ${p.graphicPath}` });
          return true;
        }
      }

      const { AiApparelMockupService } = require('./ai-apparel-mockup');
      const mockupService = new AiApparelMockupService({ service: getService() });

      // Get DB from main server (has human_models table)
      const mainDb = require('./db').getDb();

      const result = await mockupService.generateFullMockupSet({
        db: mainDb,
        modelFrontId,
        modelBackId,
        modelFrontPath,
        modelBackPath,
        clothingColor,
        placements,
        backPlacements,
        garmentType,
        generateSideBySide
      });

      // Build response with web-accessible paths
      const response = { success: true };
      if (result.front) {
        response.front = {
          imagePath: result.front.imagePath.replace(/.*[/\\]web[/\\]/, '/'),
          placements: result.front.placements
        };
      }
      if (result.back) {
        response.back = {
          imagePath: result.back.imagePath.replace(/.*[/\\]web[/\\]/, '/'),
          placements: result.back.placements
        };
      }
      if (result.combined) {
        response.combined = {
          imagePath: result.combined.imagePath.replace(/.*[/\\]web[/\\]/, '/')
        };
      }

      sendJson(res, 200, response);
      return true;
    }

    // POST /remove-background - Remove background from image using AI
    if (req.method === 'POST' && route === '/remove-background') {
      const body = await parseBody(req);
      const { imagePath } = body;

      if (!imagePath) {
        sendJson(res, 400, { success: false, error: 'imagePath required' });
        return true;
      }

      // Resolve path
      const LIBRARY_ROOT = process.env.LIBRARY_ROOT || path.join(__dirname, '..', 'web', 'library');
      let resolvedPath = imagePath;
      if (!path.isAbsolute(resolvedPath)) {
        let relPath = resolvedPath.replace(/^\//, '');
        if (relPath.startsWith('library/')) {
          resolvedPath = path.join(LIBRARY_ROOT, relPath.slice('library/'.length));
        } else {
          resolvedPath = path.join(LIBRARY_ROOT, relPath);
        }
      } else if (resolvedPath.startsWith('/library/')) {
        resolvedPath = path.join(LIBRARY_ROOT, resolvedPath.slice('/library/'.length));
      }

      if (!fs.existsSync(resolvedPath)) {
        sendJson(res, 400, { success: false, error: `Image file not found: ${resolvedPath}` });
        return true;
      }

      const svc = getService();
      const results = await svc.removeBackground(resolvedPath);

      if (results.length === 0) {
        sendJson(res, 500, { success: false, error: 'No image generated' });
        return true;
      }

      const image = results[0];
      sendJson(res, 200, {
        success: true,
        image: {
          localPath: image.localPath,
          filename: image.filename,
          webPath: image.localPath.replace(/.*[/\\]web[/\\]/, '/')
        }
      });
      return true;
    }

    // POST /apparel-mockup/adjust - Quick Sharp-based adjustment of generated mockup
    if (req.method === 'POST' && route === '/apparel-mockup/adjust') {
      const body = await parseBody(req);
      const { sourceImage, adjustX = 0, adjustY = 0, adjustScale = 100 } = body;

      if (!sourceImage) {
        sendJson(res, 400, { success: false, error: 'sourceImage required' });
        return true;
      }

      const LIBRARY_ROOT = process.env.LIBRARY_ROOT || path.join(__dirname, '..', 'web', 'library');
      let resolvedSource = sourceImage;
      if (resolvedSource.startsWith('/')) {
        resolvedSource = path.join(__dirname, '..', 'web', resolvedSource);
      }

      if (!fs.existsSync(resolvedSource)) {
        sendJson(res, 400, { success: false, error: `Source image not found: ${resolvedSource}` });
        return true;
      }

      const sharp = require('sharp');
      const crypto = require('crypto');

      // Load original image
      const metadata = await sharp(resolvedSource).metadata();
      const imgWidth = metadata.width;
      const imgHeight = metadata.height;

      // Calculate pixel offsets from percentage values
      const pixelX = Math.round((adjustX / 100) * imgWidth);
      const pixelY = Math.round((adjustY / 100) * imgHeight);
      const scale = adjustScale / 100;

      // Create adjusted version using Sharp extract + resize + composite
      const newWidth = Math.round(imgWidth * scale);
      const newHeight = Math.round(imgHeight * scale);

      let adjusted = sharp(resolvedSource).resize(newWidth, newHeight, { fit: 'fill' });

      // Composite onto canvas at offset position
      const adjustedBuf = await adjusted.toBuffer();
      const left = Math.round((imgWidth - newWidth) / 2) + pixelX;
      const top = Math.round((imgHeight - newHeight) / 2) + pixelY;

      const outputFilename = `adjusted_${crypto.randomUUID().slice(0, 8)}.png`;
      const outputDir = path.join(__dirname, '..', 'web', 'images', 'ai-generated', 'apparel-mockups');
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
      const outputPath = path.join(outputDir, outputFilename);

      await sharp({
        create: {
          width: imgWidth,
          height: imgHeight,
          channels: 4,
          background: { r: 255, g: 255, b: 255, alpha: 1 }
        }
      })
        .composite([{
          input: adjustedBuf,
          left: Math.max(0, left),
          top: Math.max(0, top)
        }])
        .png()
        .toFile(outputPath);

      sendJson(res, 200, {
        success: true,
        imagePath: `/images/ai-generated/apparel-mockups/${outputFilename}`
      });
      return true;
    }

    // GET /apparel-mockup/options - Get available zones and sizes
    if (req.method === 'GET' && route === '/apparel-mockup/options') {
      const { AiApparelMockupService } = require('./ai-apparel-mockup');
      sendJson(res, 200, {
        success: true,
        zones: AiApparelMockupService.getZones(),
        sizes: AiApparelMockupService.getSizes()
      });
      return true;
    }

    // POST /apparel-mockup/save - Save a generated mockup to permanent storage
    if (req.method === 'POST' && route === '/apparel-mockup/save') {
      const body = await parseBody(req);
      const { title, imagePath, humanModelId, graphicName, graphicPath, garmentType, clothingColor, tags } = body;

      if (!imagePath) {
        sendJson(res, 400, { success: false, error: 'imagePath required' });
        return true;
      }
      if (!title) {
        sendJson(res, 400, { success: false, error: 'title required' });
        return true;
      }

      // Resolve the source image path
      let sourcePath = imagePath;
      if (sourcePath.startsWith('/')) {
        sourcePath = path.join(__dirname, '..', 'web', sourcePath);
      }
      if (!fs.existsSync(sourcePath)) {
        sendJson(res, 400, { success: false, error: `Source image not found: ${sourcePath}` });
        return true;
      }

      const sharp = require('sharp');
      const crypto = require('crypto');

      // Permanent storage directory
      const SAVE_DIR = '/mnt/dbFiles/apparel-mockups';
      if (!fs.existsSync(SAVE_DIR)) {
        fs.mkdirSync(SAVE_DIR, { recursive: true });
      }

      // Generate filename from title
      const safeName = title.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 80);
      const filename = `${safeName}_${Date.now()}.png`;
      const destPath = path.join(SAVE_DIR, filename);

      // Copy file to permanent storage
      fs.copyFileSync(sourcePath, destPath);

      // Get dimensions
      const metadata = await sharp(destPath).metadata();
      const fileStats = fs.statSync(destPath);

      // Save to database
      const mainDb = require('./db');
      const mockupId = mainDb.createCustomArtMockup({
        title,
        filename,
        filePath: destPath,
        url: `/apparel-mockups/${filename}`,
        mockupType: 'apparel-ai',
        width: metadata.width || null,
        height: metadata.height || null,
        fileSize: fileStats.size || null,
        tags: tags || null,
        humanModelId: humanModelId || null,
        graphicName: graphicName || null,
        graphicPath: graphicPath || null,
        garmentType: garmentType || null,
        clothingColor: clothingColor || null
      });

      console.log(`[AI Apparel] Saved mockup: ${title} → ${filename} (${mockupId})`);

      sendJson(res, 200, {
        success: true,
        mockupId,
        filename,
        url: `/apparel-mockups/${filename}`
      });
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
