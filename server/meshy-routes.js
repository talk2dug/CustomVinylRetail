/**
 * Meshy 3D AI Generation API routes
 * Routes: /api/meshy/*
 */

const path = require('path');
const fs = require('fs');
const { parseBody, sendJson, sendError } = require('./utils/http');
const { MeshyClient, OUTPUT_DIR } = require('./modules/meshy-client');

function getMeshyClient() {
  const key = process.env.MESHY_API_KEY;
  if (!key) throw new Error('MESHY_API_KEY not configured in .env');
  return new MeshyClient(key);
}

function handleMeshyRoute(pathname, req, res) {
  // GET /api/meshy/balance — check credits
  if (pathname === '/api/meshy/balance' && req.method === 'GET') {
    getMeshyClient().getBalance()
      .then(balance => sendJson(res, 200, { balance }))
      .catch(err => sendError(res, 500, err.message));
    return true;
  }

  // POST /api/meshy/text-to-3d — generate 3D from text
  if (pathname === '/api/meshy/text-to-3d' && req.method === 'POST') {
    parseBody(req).then(body => {
      if (!body.prompt) return sendError(res, 400, 'prompt is required');
      getMeshyClient().textTo3D({
        prompt: body.prompt,
        aiModel: body.aiModel || body.ai_model,
        topology: body.topology,
        targetPolycount: body.targetPolycount || body.target_polycount,
        targetFormats: body.targetFormats || body.target_formats,
        shouldRemesh: body.shouldRemesh ?? body.should_remesh,
        modelType: body.modelType || body.model_type,
        autoSize: body.autoSize ?? body.auto_size,
        downloadFormat: body.downloadFormat || body.download_format || 'glb',
      }).then(result => {
        sendJson(res, 200, {
          success: true,
          taskId: result.taskId,
          dir: result.dir,
          files: result.files,
          modelUrls: result.task.model_urls,
          thumbnailUrl: result.task.thumbnail_url,
        });
      }).catch(err => sendError(res, 500, err.message));
    }).catch(err => sendError(res, 400, 'Invalid request body'));
    return true;
  }

  // POST /api/meshy/refine — refine/texture a preview
  if (pathname === '/api/meshy/refine' && req.method === 'POST') {
    parseBody(req).then(body => {
      if (!body.previewTaskId && !body.preview_task_id) {
        return sendError(res, 400, 'previewTaskId is required');
      }
      getMeshyClient().refineTextTo3D({
        previewTaskId: body.previewTaskId || body.preview_task_id,
        enablePbr: body.enablePbr ?? body.enable_pbr ?? true,
        texturePrompt: body.texturePrompt || body.texture_prompt,
        targetFormats: body.targetFormats || body.target_formats,
        downloadFormat: body.downloadFormat || body.download_format || 'glb',
      }).then(result => {
        sendJson(res, 200, {
          success: true,
          taskId: result.taskId,
          dir: result.dir,
          files: result.files,
          modelUrls: result.task.model_urls,
        });
      }).catch(err => sendError(res, 500, err.message));
    }).catch(err => sendError(res, 400, 'Invalid request body'));
    return true;
  }

  // POST /api/meshy/image-to-3d — convert image to 3D
  if (pathname === '/api/meshy/image-to-3d' && req.method === 'POST') {
    parseBody(req).then(body => {
      if (!body.imageUrl && !body.image_url) {
        return sendError(res, 400, 'imageUrl is required');
      }
      getMeshyClient().imageTo3D({
        imageUrl: body.imageUrl || body.image_url,
        shouldTexture: body.shouldTexture ?? body.should_texture ?? true,
        enablePbr: body.enablePbr ?? body.enable_pbr ?? true,
        aiModel: body.aiModel || body.ai_model,
        targetFormats: body.targetFormats || body.target_formats,
        downloadFormat: body.downloadFormat || body.download_format || 'glb',
      }).then(result => {
        sendJson(res, 200, {
          success: true,
          taskId: result.taskId,
          dir: result.dir,
          files: result.files,
          modelUrls: result.task.model_urls,
        });
      }).catch(err => sendError(res, 500, err.message));
    }).catch(err => sendError(res, 400, 'Invalid request body'));
    return true;
  }

  // POST /api/meshy/multi-image-to-3d
  if (pathname === '/api/meshy/multi-image-to-3d' && req.method === 'POST') {
    parseBody(req).then(body => {
      if (!body.imageUrls && !body.image_urls) {
        return sendError(res, 400, 'imageUrls is required (array of 1-4 URLs)');
      }
      getMeshyClient().multiImageTo3D({
        imageUrls: body.imageUrls || body.image_urls,
        shouldTexture: body.shouldTexture ?? body.should_texture ?? true,
        enablePbr: body.enablePbr ?? body.enable_pbr ?? true,
        aiModel: body.aiModel || body.ai_model,
        targetFormats: body.targetFormats || body.target_formats,
        downloadFormat: body.downloadFormat || body.download_format || 'glb',
      }).then(result => {
        sendJson(res, 200, {
          success: true,
          taskId: result.taskId,
          dir: result.dir,
          files: result.files,
          modelUrls: result.task.model_urls,
        });
      }).catch(err => sendError(res, 500, err.message));
    }).catch(err => sendError(res, 400, 'Invalid request body'));
    return true;
  }

  // POST /api/meshy/retexture
  if (pathname === '/api/meshy/retexture' && req.method === 'POST') {
    parseBody(req).then(body => {
      getMeshyClient().retexture({
        inputTaskId: body.inputTaskId || body.input_task_id,
        modelUrl: body.modelUrl || body.model_url,
        textStylePrompt: body.textStylePrompt || body.text_style_prompt,
        imageStyleUrl: body.imageStyleUrl || body.image_style_url,
        enablePbr: body.enablePbr ?? body.enable_pbr ?? true,
        targetFormats: body.targetFormats || body.target_formats,
        downloadFormat: body.downloadFormat || body.download_format || 'glb',
      }).then(result => {
        sendJson(res, 200, {
          success: true,
          taskId: result.taskId,
          dir: result.dir,
          files: result.files,
        });
      }).catch(err => sendError(res, 500, err.message));
    }).catch(err => sendError(res, 400, 'Invalid request body'));
    return true;
  }

  // POST /api/meshy/remesh
  if (pathname === '/api/meshy/remesh' && req.method === 'POST') {
    parseBody(req).then(body => {
      getMeshyClient().remesh({
        inputTaskId: body.inputTaskId || body.input_task_id,
        modelUrl: body.modelUrl || body.model_url,
        targetFormats: body.targetFormats || body.target_formats || ['glb'],
        topology: body.topology,
        targetPolycount: body.targetPolycount || body.target_polycount,
        resizeHeight: body.resizeHeight || body.resize_height,
        convertFormatOnly: body.convertFormatOnly ?? body.convert_format_only,
      }).then(result => {
        sendJson(res, 200, {
          success: true,
          taskId: result.taskId,
          dir: result.dir,
          files: result.files,
        });
      }).catch(err => sendError(res, 500, err.message));
    }).catch(err => sendError(res, 400, 'Invalid request body'));
    return true;
  }

  // POST /api/meshy/multicolor-print
  if (pathname === '/api/meshy/multicolor-print' && req.method === 'POST') {
    parseBody(req).then(body => {
      if (!body.inputTaskId && !body.input_task_id) {
        return sendError(res, 400, 'inputTaskId is required');
      }
      getMeshyClient().multiColorPrint({
        inputTaskId: body.inputTaskId || body.input_task_id,
        maxColors: body.maxColors || body.max_colors || 4,
        maxDepth: body.maxDepth || body.max_depth || 4,
      }).then(result => {
        sendJson(res, 200, {
          success: true,
          taskId: result.taskId,
          dir: result.dir,
          files: result.files,
        });
      }).catch(err => sendError(res, 500, err.message));
    }).catch(err => sendError(res, 400, 'Invalid request body'));
    return true;
  }

  // POST /api/meshy/rig
  if (pathname === '/api/meshy/rig' && req.method === 'POST') {
    parseBody(req).then(body => {
      getMeshyClient().rig({
        inputTaskId: body.inputTaskId || body.input_task_id,
        modelUrl: body.modelUrl || body.model_url,
        heightMeters: body.heightMeters || body.height_meters || 1.7,
      }).then(result => {
        sendJson(res, 200, {
          success: true,
          taskId: result.taskId,
          dir: result.dir,
          files: result.files,
        });
      }).catch(err => sendError(res, 500, err.message));
    }).catch(err => sendError(res, 400, 'Invalid request body'));
    return true;
  }

  // GET /api/meshy/task/:endpoint/:id — check any task status
  if (pathname.startsWith('/api/meshy/task/') && req.method === 'GET') {
    const parts = pathname.replace('/api/meshy/task/', '').split('/');
    if (parts.length < 2) return sendError(res, 400, 'Usage: /api/meshy/task/{endpoint}/{taskId}');
    const endpoint = `/openapi/${parts.slice(0, -1).join('/')}`;
    const taskId = parts[parts.length - 1];
    getMeshyClient().getTask(endpoint, taskId)
      .then(task => sendJson(res, 200, task))
      .catch(err => sendError(res, 500, err.message));
    return true;
  }

  // GET /api/meshy/outputs — list local generated files
  if (pathname === '/api/meshy/outputs' && req.method === 'GET') {
    if (!fs.existsSync(OUTPUT_DIR)) return sendJson(res, 200, { outputs: [] });
    const dirs = fs.readdirSync(OUTPUT_DIR)
      .filter(d => fs.statSync(path.join(OUTPUT_DIR, d)).isDirectory())
      .map(d => {
        const metaPath = path.join(OUTPUT_DIR, d, 'metadata.json');
        let metadata = null;
        if (fs.existsSync(metaPath)) {
          try { metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (e) {}
        }
        const files = fs.readdirSync(path.join(OUTPUT_DIR, d));
        return { directory: d, files, metadata };
      })
      .reverse();
    sendJson(res, 200, { outputs: dirs });
    return true;
  }

  // GET /api/meshy/output/:dir/:file — serve a generated file
  if (pathname.startsWith('/api/meshy/output/') && req.method === 'GET') {
    const relPath = pathname.replace('/api/meshy/output/', '');
    const filePath = path.join(OUTPUT_DIR, relPath);

    if (!filePath.startsWith(OUTPUT_DIR) || !fs.existsSync(filePath)) {
      return sendError(res, 404, 'File not found');
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.glb': 'model/gltf-binary',
      '.gltf': 'model/gltf+json',
      '.obj': 'text/plain',
      '.fbx': 'application/octet-stream',
      '.stl': 'application/sla',
      '.3mf': 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml',
      '.usdz': 'model/vnd.usdz+zip',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.json': 'application/json',
    };

    const stat = fs.statSync(filePath);
    res.writeHead(200, {
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
    });
    fs.createReadStream(filePath).pipe(res);
    return true;
  }

  return false;
}

module.exports = { handleMeshyRoute };
