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
const CATALOG_PATH = path.join(__dirname, '..', 'web', 'catalog.json');

if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

// Cached catalog for design lookups
let _catalogCache = null;
let _catalogCacheTime = 0;
function loadCatalog() {
  const now = Date.now();
  if (_catalogCache && now - _catalogCacheTime < 60000) return _catalogCache;
  try {
    _catalogCache = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
    _catalogCacheTime = now;
    return _catalogCache;
  } catch (e) {
    console.error('[reel-studio] catalog load failed:', e);
    return { categories: [] };
  }
}

/**
 * Resolve apparel mockup filenames to design IDs.
 * Filename format: mockup_<designId>_hm_<modelId>_<timestamp>.jpg
 * where designId is typically "slug-name-<timestamp>" (e.g. sarcastic-moods-065-1762126207472)
 */
function resolveMockupToDesignId(filename) {
  if (!filename) return null;
  const m = filename.match(/^mockup_(.+?)_hm_/);
  if (!m) return null;
  const extracted = m[1];
  // Try exact match against catalog
  const catalog = loadCatalog();
  for (const cat of (catalog.categories || [])) {
    for (const design of (cat.designs || [])) {
      if (design.id === extracted) return { designId: design.id, category: cat.name };
      // Fallback: prefix match (mockup might include only first 30 chars)
      if (design.id.startsWith(extracted.slice(0, 30))) return { designId: design.id, category: cat.name };
    }
  }
  return null;
}

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
          name: 'Apparel Drop',
          description: 'Big hooks, per-item captions, model-vibe matched (best for apparel)',
          assetType: 'image',
          dimensions: '1080x1920',
          supportsCopy: true,
          copyTemplate: 'apparel',
        },
        {
          id: 'MetalPrintStory',
          name: 'Metal Print Story',
          description: 'Cinematic: hook → process → hero → mockups → why metal → CTA',
          assetType: 'image',
          dimensions: '1080x1920',
          supportsCopy: true,
          copyTemplate: 'metal-print',
          needsProcessFootage: true,
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

  // POST /api/reel-studio/generate-copy — AI-write hooks/captions via local Ollama
  if (pathname === '/api/reel-studio/generate-copy' && req.method === 'POST') {
    parseBody(req).then(async (body) => {
      const { template = 'apparel', items = [], vibe, sceneContext } = body;
      try {
        const { writeApparelCopy, writeMetalPrintCopy } = require('./modules/reel-copywriter');
        let copy;
        if (template === 'metal-print') {
          copy = await writeMetalPrintCopy({ items, sceneContext });
        } else {
          copy = await writeApparelCopy({ items, vibe });
        }
        sendJson(res, 200, { success: true, copy });
      } catch (e) {
        console.error('[reel-studio] copy generation failed:', e);
        sendError(res, 500, e.message);
      }
    }).catch(() => sendError(res, 400, 'Invalid request body'));
    return true;
  }

  // POST /api/reel-studio/resolve-designs — mockup filenames → design IDs
  if (pathname === '/api/reel-studio/resolve-designs' && req.method === 'POST') {
    parseBody(req).then((body) => {
      const { filenames } = body;
      if (!Array.isArray(filenames)) return sendError(res, 400, 'filenames array required');
      const resolved = filenames.map(fn => {
        const match = resolveMockupToDesignId(fn);
        return { filename: fn, ...(match || { designId: null }) };
      });
      sendJson(res, 200, { resolved });
    }).catch(() => sendError(res, 400, 'Invalid request body'));
    return true;
  }

  // POST /api/reel-studio/publish-shopify — publish designs to Shopify (optional TikTok Shop)
  if (pathname === '/api/reel-studio/publish-shopify' && req.method === 'POST') {
    parseBody(req).then(async (body) => {
      const { designIds, includeTikTokShop = false, dryRun = false } = body;
      if (!Array.isArray(designIds) || designIds.length === 0) {
        return sendError(res, 400, 'designIds array required');
      }

      try {
        console.log(`[reel-studio] Publishing ${designIds.length} design(s) to Shopify (TikTok Shop: ${includeTikTokShop})`);
        const { publishBatch } = require('./scripts/shopify-apparel-publisher');
        const result = await publishBatch({
          designIds,
          limit: designIds.length,
          dryRun,
          delayMs: 1500,
        });

        // Extract product URLs
        const STORE_BASE = process.env.SHOPIFY_STORE_URL || 'https://blueridgecustomco.com';
        const products = (result.results || [])
          .filter(r => r.handle && !r.error)
          .map(r => ({
            designId: r.designId,
            title: r.title,
            shopifyId: r.shopifyId,
            handle: r.handle,
            url: `${STORE_BASE}/products/${r.handle}`,
          }));

        // Optionally add to TikTok Shop publication
        let tiktokShopAdded = 0;
        if (includeTikTokShop && products.length > 0 && !dryRun) {
          try {
            const shopify = require('./integrations/shopify');
            const publications = await shopify.getPublications();
            const tiktokPub = publications?.find(p =>
              (p.name || '').toLowerCase().includes('tiktok')
            );
            if (tiktokPub) {
              for (const product of products) {
                try {
                  await shopify.publishToPublications(product.shopifyId, [tiktokPub.id]);
                  tiktokShopAdded++;
                } catch (err) {
                  console.warn('[reel-studio] TikTok Shop publish failed for', product.title, err.message);
                }
              }
            } else {
              console.warn('[reel-studio] No TikTok Shop publication found');
            }
          } catch (err) {
            console.error('[reel-studio] TikTok Shop integration failed:', err);
          }
        }

        // Build primary CTA URL (use collection URL for multi-item, product URL for single)
        const primaryUrl = products.length === 1
          ? products[0].url
          : `${STORE_BASE}/collections/apparel`;

        sendJson(res, 200, {
          success: true,
          published: products.length,
          failed: result.failed || 0,
          products,
          primaryUrl,
          tiktokShopAdded,
          summary: result,
        });
      } catch (e) {
        console.error('[reel-studio] publish failed:', e);
        sendError(res, 500, e.message);
      }
    }).catch(() => sendError(res, 400, 'Invalid request body'));
    return true;
  }

  return false;
}

module.exports = { handleReelStudioRoute };
