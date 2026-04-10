/**
 * Meshy AI 3D Generation Client
 * Native Node.js wrapper for the Meshy REST API
 * https://docs.meshy.ai
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://api.meshy.ai';
const OUTPUT_DIR = path.join(__dirname, '..', '..', 'data', 'meshy-output');

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

class MeshyClient {
  constructor(apiKey) {
    if (!apiKey) throw new Error('MESHY_API_KEY is required');
    this.apiKey = apiKey;
  }

  // ── HTTP helpers ──

  _request(method, endpoint, body = null) {
    return new Promise((resolve, reject) => {
      const url = new URL(endpoint, BASE_URL);
      const options = {
        method,
        hostname: url.hostname,
        path: url.pathname + url.search,
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode >= 400) {
              const err = new Error(parsed.message || `HTTP ${res.statusCode}`);
              err.status = res.statusCode;
              err.response = parsed;
              return reject(err);
            }
            resolve(parsed);
          } catch (e) {
            if (res.statusCode >= 400) {
              const err = new Error(`HTTP ${res.statusCode}: ${data}`);
              err.status = res.statusCode;
              return reject(err);
            }
            resolve(data);
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });

      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  /**
   * Poll a task until completion
   * @param {string} endpoint - e.g. '/openapi/v2/text-to-3d'
   * @param {string} taskId
   * @param {object} opts - { timeout, onProgress }
   * @returns {Promise<object>} completed task object
   */
  async pollTask(endpoint, taskId, opts = {}) {
    const { timeout = 600000, onProgress } = opts;
    const start = Date.now();
    let delay = 5000;

    while (Date.now() - start < timeout) {
      const task = await this._request('GET', `${endpoint}/${taskId}`);

      if (onProgress) onProgress(task.status, task.progress || 0);

      if (task.status === 'SUCCEEDED') return task;
      if (task.status === 'FAILED' || task.status === 'CANCELED') {
        throw new Error(`Task ${task.status}: ${task.task_error?.message || 'Unknown error'}`);
      }

      // Slow down polling near completion (finalization can be slow)
      if (task.progress >= 95) {
        await this._sleep(15000);
      } else {
        await this._sleep(delay);
        delay = Math.min(delay * 1.5, 30000);
      }
    }

    throw new Error(`Task polling timeout after ${timeout}ms`);
  }

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  /**
   * Download a file from URL to local path
   */
  downloadFile(url, filePath) {
    return new Promise((resolve, reject) => {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const file = fs.createWriteStream(filePath);
      https.get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return this.downloadFile(res.headers.location, filePath).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlinkSync(filePath);
          return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        }
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(filePath); });
      }).on('error', (err) => {
        file.close();
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        reject(err);
      });
    });
  }

  /**
   * Create output directory for a task
   */
  _taskDir(prompt, taskId) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const slug = (prompt || 'model').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
    const dirName = `${timestamp}_${slug}_${taskId.slice(0, 8)}`;
    const dir = path.join(OUTPUT_DIR, dirName);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Save task metadata
   */
  _saveMetadata(dir, task, extra = {}) {
    const metadata = {
      task_id: task.id,
      status: task.status,
      type: task.type,
      prompt: task.prompt,
      progress: task.progress,
      model_urls: task.model_urls,
      texture_urls: task.texture_urls,
      thumbnail_url: task.thumbnail_url,
      created_at: task.created_at,
      finished_at: task.finished_at,
      ...extra,
    };
    fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(metadata, null, 2));
    return metadata;
  }

  // ── Generation APIs ──

  /**
   * Text to 3D (preview mode)
   * @param {object} opts
   * @param {string} opts.prompt - Description of the 3D model (max 600 chars)
   * @param {string} [opts.aiModel] - 'latest', 'meshy-6', 'meshy-5'
   * @param {string} [opts.topology] - 'triangle' or 'quad'
   * @param {number} [opts.targetPolycount] - 100-300000
   * @param {string[]} [opts.targetFormats] - e.g. ['glb', 'stl', '3mf']
   * @param {boolean} [opts.shouldRemesh]
   * @param {string} [opts.modelType] - 'standard' or 'lowpoly'
   * @param {boolean} [opts.autoSize]
   * @param {string} [opts.downloadFormat] - format to download, default 'glb'
   * @returns {Promise<{taskId, task, dir, files}>}
   */
  async textTo3D(opts) {
    const {
      prompt,
      aiModel = 'latest',
      topology = 'triangle',
      targetPolycount,
      targetFormats,
      shouldRemesh,
      modelType = 'standard',
      autoSize = false,
      downloadFormat = 'glb',
    } = opts;

    const body = {
      mode: 'preview',
      prompt,
      ai_model: aiModel,
      topology,
      model_type: modelType,
      auto_size: autoSize,
    };
    if (targetPolycount) body.target_polycount = targetPolycount;
    if (targetFormats) body.target_formats = targetFormats;
    if (shouldRemesh !== undefined) body.should_remesh = shouldRemesh;

    console.log(`[meshy] Creating text-to-3D preview: "${prompt}"`);
    const { result: taskId } = await this._request('POST', '/openapi/v2/text-to-3d', body);
    console.log(`[meshy] Task created: ${taskId}`);

    const task = await this.pollTask('/openapi/v2/text-to-3d', taskId, {
      onProgress: (status, progress) => console.log(`[meshy] ${status} ${progress}%`),
    });

    const dir = this._taskDir(prompt, taskId);
    const files = {};

    // Download model
    if (task.model_urls && task.model_urls[downloadFormat]) {
      const ext = downloadFormat === '3mf' ? '3mf' : downloadFormat;
      const filePath = path.join(dir, `model.${ext}`);
      await this.downloadFile(task.model_urls[downloadFormat], filePath);
      files.model = filePath;
    }

    // Download thumbnail
    if (task.thumbnail_url) {
      const thumbPath = path.join(dir, 'thumbnail.png');
      await this.downloadFile(task.thumbnail_url, thumbPath);
      files.thumbnail = thumbPath;
    }

    this._saveMetadata(dir, task);
    console.log(`[meshy] Preview complete, saved to ${dir}`);
    return { taskId, task, dir, files };
  }

  /**
   * Refine (texture) a preview task
   * @param {object} opts
   * @param {string} opts.previewTaskId
   * @param {boolean} [opts.enablePbr]
   * @param {string} [opts.texturePrompt]
   * @param {string[]} [opts.targetFormats]
   * @param {string} [opts.downloadFormat]
   * @returns {Promise<{taskId, task, dir, files}>}
   */
  async refineTextTo3D(opts) {
    const {
      previewTaskId,
      enablePbr = true,
      texturePrompt,
      targetFormats,
      downloadFormat = 'glb',
    } = opts;

    const body = {
      mode: 'refine',
      preview_task_id: previewTaskId,
      enable_pbr: enablePbr,
    };
    if (texturePrompt) body.texture_prompt = texturePrompt;
    if (targetFormats) body.target_formats = targetFormats;

    console.log(`[meshy] Refining task ${previewTaskId}`);
    const { result: taskId } = await this._request('POST', '/openapi/v2/text-to-3d', body);

    const task = await this.pollTask('/openapi/v2/text-to-3d', taskId, {
      onProgress: (status, progress) => console.log(`[meshy] refine ${status} ${progress}%`),
    });

    const dir = this._taskDir(task.prompt || 'refined', taskId);
    const files = {};

    if (task.model_urls && task.model_urls[downloadFormat]) {
      const filePath = path.join(dir, `model.${downloadFormat === '3mf' ? '3mf' : downloadFormat}`);
      await this.downloadFile(task.model_urls[downloadFormat], filePath);
      files.model = filePath;
    }

    if (task.thumbnail_url) {
      const thumbPath = path.join(dir, 'thumbnail.png');
      await this.downloadFile(task.thumbnail_url, thumbPath);
      files.thumbnail = thumbPath;
    }

    this._saveMetadata(dir, task);
    console.log(`[meshy] Refine complete, saved to ${dir}`);
    return { taskId, task, dir, files };
  }

  /**
   * Image to 3D
   * @param {object} opts
   * @param {string} opts.imageUrl - public URL or data URI
   * @param {boolean} [opts.shouldTexture]
   * @param {boolean} [opts.enablePbr]
   * @param {string} [opts.aiModel]
   * @param {string[]} [opts.targetFormats]
   * @param {string} [opts.downloadFormat]
   * @returns {Promise<{taskId, task, dir, files}>}
   */
  async imageTo3D(opts) {
    const {
      imageUrl,
      shouldTexture = true,
      enablePbr = true,
      aiModel = 'latest',
      targetFormats,
      downloadFormat = 'glb',
    } = opts;

    const body = {
      image_url: imageUrl,
      should_texture: shouldTexture,
      enable_pbr: enablePbr,
      ai_model: aiModel,
    };
    if (targetFormats) body.target_formats = targetFormats;

    console.log(`[meshy] Creating image-to-3D task`);
    const { result: taskId } = await this._request('POST', '/openapi/v1/image-to-3d', body);
    console.log(`[meshy] Task created: ${taskId}`);

    const task = await this.pollTask('/openapi/v1/image-to-3d', taskId, {
      onProgress: (status, progress) => console.log(`[meshy] ${status} ${progress}%`),
    });

    const dir = this._taskDir('image-to-3d', taskId);
    const files = {};

    if (task.model_urls && task.model_urls[downloadFormat]) {
      const filePath = path.join(dir, `model.${downloadFormat === '3mf' ? '3mf' : downloadFormat}`);
      await this.downloadFile(task.model_urls[downloadFormat], filePath);
      files.model = filePath;
    }

    if (task.thumbnail_url) {
      const thumbPath = path.join(dir, 'thumbnail.png');
      await this.downloadFile(task.thumbnail_url, thumbPath);
      files.thumbnail = thumbPath;
    }

    this._saveMetadata(dir, task);
    return { taskId, task, dir, files };
  }

  /**
   * Multi-Image to 3D
   */
  async multiImageTo3D(opts) {
    const {
      imageUrls,
      shouldTexture = true,
      enablePbr = true,
      aiModel = 'latest',
      targetFormats,
      downloadFormat = 'glb',
    } = opts;

    const body = {
      image_urls: imageUrls,
      should_texture: shouldTexture,
      enable_pbr: enablePbr,
      ai_model: aiModel,
    };
    if (targetFormats) body.target_formats = targetFormats;

    console.log(`[meshy] Creating multi-image-to-3D task (${imageUrls.length} images)`);
    const { result: taskId } = await this._request('POST', '/openapi/v1/multi-image-to-3d', body);

    const task = await this.pollTask('/openapi/v1/multi-image-to-3d', taskId, {
      onProgress: (status, progress) => console.log(`[meshy] ${status} ${progress}%`),
    });

    const dir = this._taskDir('multi-image-3d', taskId);
    const files = {};

    if (task.model_urls && task.model_urls[downloadFormat]) {
      const filePath = path.join(dir, `model.${downloadFormat === '3mf' ? '3mf' : downloadFormat}`);
      await this.downloadFile(task.model_urls[downloadFormat], filePath);
      files.model = filePath;
    }

    if (task.thumbnail_url) {
      await this.downloadFile(task.thumbnail_url, path.join(dir, 'thumbnail.png'));
      files.thumbnail = path.join(dir, 'thumbnail.png');
    }

    this._saveMetadata(dir, task);
    return { taskId, task, dir, files };
  }

  /**
   * Retexture an existing model
   */
  async retexture(opts) {
    const {
      inputTaskId,
      modelUrl,
      textStylePrompt,
      imageStyleUrl,
      enablePbr = true,
      targetFormats,
      downloadFormat = 'glb',
    } = opts;

    const body = { enable_pbr: enablePbr };
    if (inputTaskId) body.input_task_id = inputTaskId;
    if (modelUrl) body.model_url = modelUrl;
    if (textStylePrompt) body.text_style_prompt = textStylePrompt;
    if (imageStyleUrl) body.image_style_url = imageStyleUrl;
    if (targetFormats) body.target_formats = targetFormats;

    console.log(`[meshy] Creating retexture task`);
    const { result: taskId } = await this._request('POST', '/openapi/v1/retexture', body);

    const task = await this.pollTask('/openapi/v1/retexture', taskId, {
      onProgress: (status, progress) => console.log(`[meshy] retexture ${status} ${progress}%`),
    });

    const dir = this._taskDir('retexture', taskId);
    const files = {};

    if (task.model_urls && task.model_urls[downloadFormat]) {
      const filePath = path.join(dir, `model.${downloadFormat === '3mf' ? '3mf' : downloadFormat}`);
      await this.downloadFile(task.model_urls[downloadFormat], filePath);
      files.model = filePath;
    }

    this._saveMetadata(dir, task);
    return { taskId, task, dir, files };
  }

  /**
   * Remesh a model (change topology, polycount, format)
   */
  async remesh(opts) {
    const {
      inputTaskId,
      modelUrl,
      targetFormats = ['glb'],
      topology = 'triangle',
      targetPolycount,
      resizeHeight,
      convertFormatOnly = false,
    } = opts;

    const body = {
      target_formats: targetFormats,
      topology,
      convert_format_only: convertFormatOnly,
    };
    if (inputTaskId) body.input_task_id = inputTaskId;
    if (modelUrl) body.model_url = modelUrl;
    if (targetPolycount) body.target_polycount = targetPolycount;
    if (resizeHeight) body.resize_height = resizeHeight;

    console.log(`[meshy] Creating remesh task`);
    const { result: taskId } = await this._request('POST', '/openapi/v1/remesh', body);

    const task = await this.pollTask('/openapi/v1/remesh', taskId, {
      onProgress: (status, progress) => console.log(`[meshy] remesh ${status} ${progress}%`),
    });

    const dir = this._taskDir('remesh', taskId);
    const files = {};

    for (const fmt of targetFormats) {
      if (task.model_urls && task.model_urls[fmt]) {
        const filePath = path.join(dir, `model.${fmt}`);
        await this.downloadFile(task.model_urls[fmt], filePath);
        files[fmt] = filePath;
      }
    }

    this._saveMetadata(dir, task);
    return { taskId, task, dir, files };
  }

  /**
   * Multi-Color Print (3MF output for multicolor 3D printing)
   */
  async multiColorPrint(opts) {
    const { inputTaskId, maxColors = 4, maxDepth = 4 } = opts;

    const body = {
      input_task_id: inputTaskId,
      max_colors: maxColors,
      max_depth: maxDepth,
    };

    console.log(`[meshy] Creating multi-color print task (${maxColors} colors)`);
    const { result: taskId } = await this._request('POST', '/openapi/v1/print/multi-color', body);

    const task = await this.pollTask('/openapi/v1/print/multi-color', taskId, {
      onProgress: (status, progress) => console.log(`[meshy] print ${status} ${progress}%`),
    });

    const dir = this._taskDir('multicolor-print', taskId);
    const files = {};

    if (task.model_urls && task.model_urls['3mf']) {
      const filePath = path.join(dir, 'model.3mf');
      await this.downloadFile(task.model_urls['3mf'], filePath);
      files.model = filePath;
    }

    this._saveMetadata(dir, task);
    return { taskId, task, dir, files };
  }

  /**
   * Auto-rig a humanoid character
   */
  async rig(opts) {
    const { inputTaskId, modelUrl, heightMeters = 1.7 } = opts;

    const body = { height_meters: heightMeters };
    if (inputTaskId) body.input_task_id = inputTaskId;
    if (modelUrl) body.model_url = modelUrl;

    console.log(`[meshy] Creating rigging task`);
    const { result: taskId } = await this._request('POST', '/openapi/v1/rigging', body);

    const task = await this.pollTask('/openapi/v1/rigging', taskId, {
      onProgress: (status, progress) => console.log(`[meshy] rig ${status} ${progress}%`),
    });

    const dir = this._taskDir('rigged', taskId);
    const files = {};

    if (task.rigged_character_glb_url) {
      await this.downloadFile(task.rigged_character_glb_url, path.join(dir, 'rigged.glb'));
      files.rigged = path.join(dir, 'rigged.glb');
    }
    if (task.basic_animations?.walking_glb_url) {
      await this.downloadFile(task.basic_animations.walking_glb_url, path.join(dir, 'walking.glb'));
      files.walking = path.join(dir, 'walking.glb');
    }
    if (task.basic_animations?.running_glb_url) {
      await this.downloadFile(task.basic_animations.running_glb_url, path.join(dir, 'running.glb'));
      files.running = path.join(dir, 'running.glb');
    }

    this._saveMetadata(dir, task);
    return { taskId, task, dir, files };
  }

  // ── Utility APIs ──

  /**
   * Check credit balance
   */
  async getBalance() {
    const data = await this._request('GET', '/openapi/v1/balance');
    return data.balance;
  }

  /**
   * Get task status (any endpoint)
   */
  async getTask(endpoint, taskId) {
    return this._request('GET', `${endpoint}/${taskId}`);
  }

  /**
   * List tasks (any endpoint)
   */
  async listTasks(endpoint, opts = {}) {
    const { pageNum = 1, pageSize = 10, sortBy = '-created_at' } = opts;
    const qs = `?page_num=${pageNum}&page_size=${pageSize}&sort_by=${sortBy}`;
    return this._request('GET', `${endpoint}${qs}`);
  }
}

module.exports = { MeshyClient, OUTPUT_DIR };
