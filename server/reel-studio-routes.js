/**
 * Reel Studio routes — asset browser + render pipeline
 * Routes: /api/reel-studio/*
 *
 * NO AI — just asset serving and Remotion render triggering.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseBody, sendJson, sendError } = require('./utils/http');
const { renderVideo, OUT_DIR } = require('../remotion/render-api');

const AUDIO_DIR = path.join(__dirname, '..', 'data', 'reel-studio-audio');
const HISTORY_FILE = path.join(__dirname, '..', 'data', 'reel-studio-history.json');

if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch (e) { console.error('[reel-studio] history load:', e); }
  return [];
}

function saveHistory(entries) {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(entries, null, 2)); }
  catch (e) { console.error('[reel-studio] history save:', e); }
}

function handleReelStudioRoute(pathname, req, res) {
  // GET /api/reel-studio/templates — list available compositions
  if (pathname === '/api/reel-studio/templates' && req.method === 'GET') {
    sendJson(res, 200, {
      templates: [
        {
          id: 'MockupReel',
          name: 'Mockup Reel',
          description: 'Product mockup slideshow with hook, labels, and brand outro',
          assetType: 'image',
          dimensions: '1080x1920',
          transitions: ['zoom', 'slide', 'fade'],
        },
        {
          id: 'FootageReel',
          name: 'Footage Reel',
          description: 'Video clips from footage library with hook and outro',
          assetType: 'video',
          dimensions: '1080x1920',
        },
        {
          id: 'CatalogShowcase',
          name: 'Catalog Showcase',
          description: 'Artwork slideshow with category badge and Shop Now CTA',
          assetType: 'image',
          dimensions: '1080x1920',
        },
      ],
    });
    return true;
  }

  // POST /api/reel-studio/render — render a composition with given props
  if (pathname === '/api/reel-studio/render' && req.method === 'POST') {
    parseBody(req).then(async (body) => {
      const { template, props, label } = body;
      if (!template || !props) return sendError(res, 400, 'template and props are required');
      try {
        console.log(`[reel-studio] Rendering ${template}`);
        const outputFile = `reel-${template.toLowerCase()}-${Date.now()}.mp4`;
        const result = await renderVideo({
          compositionId: template,
          props,
          outputFile,
        });
        const videoUrl = `/api/remotion/output/${path.basename(result.filePath)}`;

        const history = loadHistory();
        history.unshift({
          id: `reel_${Date.now()}`,
          template,
          label: label || '',
          props,
          videoUrl,
          filename: path.basename(result.filePath),
          durationMs: result.durationMs,
          createdAt: new Date().toISOString(),
        });
        saveHistory(history.slice(0, 100));

        sendJson(res, 200, {
          success: true,
          videoUrl,
          filename: path.basename(result.filePath),
          durationMs: result.durationMs,
        });
      } catch (e) {
        console.error('[reel-studio] render failed:', e);
        sendError(res, 500, e.message);
      }
    }).catch(() => sendError(res, 400, 'Invalid request body'));
    return true;
  }

  // POST /api/reel-studio/upload-audio — upload an audio file for voiceover
  if (pathname === '/api/reel-studio/upload-audio' && req.method === 'POST') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const buffer = Buffer.concat(chunks);
        const contentType = req.headers['content-type'] || 'audio/mpeg';
        const ext = contentType.includes('wav') ? '.wav' : contentType.includes('ogg') ? '.ogg' : '.mp3';
        const id = crypto.randomBytes(8).toString('hex');
        const filename = `voice_${Date.now()}_${id}${ext}`;
        const filePath = path.join(AUDIO_DIR, filename);
        fs.writeFileSync(filePath, buffer);
        sendJson(res, 200, {
          success: true,
          filename,
          url: `/api/reel-studio/audio/${filename}`,
          sizeBytes: buffer.length,
        });
      } catch (e) {
        sendError(res, 500, e.message);
      }
    });
    req.on('error', () => sendError(res, 500, 'Upload failed'));
    return true;
  }

  // GET /api/reel-studio/audio/:filename — serve uploaded audio
  if (pathname.startsWith('/api/reel-studio/audio/') && req.method === 'GET') {
    const filename = decodeURIComponent(pathname.replace('/api/reel-studio/audio/', ''));
    const filePath = path.join(AUDIO_DIR, filename);
    if (!filePath.startsWith(AUDIO_DIR) || !fs.existsSync(filePath)) {
      return sendError(res, 404, 'Audio not found');
    }
    const stat = fs.statSync(filePath);
    const ext = path.extname(filename).toLowerCase();
    const mime = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4' };
    res.writeHead(200, {
      'Content-Type': mime[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'public, max-age=86400',
    });
    fs.createReadStream(filePath).pipe(res);
    return true;
  }

  // GET /api/reel-studio/audio — list uploaded audio files
  if (pathname === '/api/reel-studio/audio' && req.method === 'GET') {
    const files = fs.existsSync(AUDIO_DIR)
      ? fs.readdirSync(AUDIO_DIR).map(f => {
          const stat = fs.statSync(path.join(AUDIO_DIR, f));
          return {
            filename: f,
            url: `/api/reel-studio/audio/${f}`,
            sizeBytes: stat.size,
            uploadedAt: stat.birthtime,
          };
        })
      : [];
    sendJson(res, 200, { audio: files.reverse() });
    return true;
  }

  // GET /api/reel-studio/history — list past renders
  if (pathname === '/api/reel-studio/history' && req.method === 'GET') {
    sendJson(res, 200, { history: loadHistory() });
    return true;
  }

  return false;
}

module.exports = { handleReelStudioRoute };
