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

const { PIPELINE_OUTPUT_DIR } = require('./paths');
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

  // POST /api/reel-studio/render — render a composition with given props.
  // Optional campaign attachment: pass { campaignRunId, chunkDesignIds,
  // shopifyProductIds, theme, isTikTokShopReel } and the rendered video will
  // be inserted into tiktok_videos tied to that pipeline run, ready for
  // finalize-campaign to run step 7b/7c.
  if (pathname === '/api/reel-studio/render' && req.method === 'POST') {
    parseBody(req).then(async (body) => {
      const {
        template, props, label,
        campaignRunId, chunkDesignIds, shopifyProductIds,
        theme, isTikTokShopReel, caption
      } = body;
      if (!template || !props) return sendError(res, 400, 'template and props are required');
      try {
        console.log(`[reel-studio] Rendering ${template}${campaignRunId ? ` (campaign ${campaignRunId})` : ''}`);
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
          campaignRunId: campaignRunId || null,
          createdAt: new Date().toISOString(),
        });
        saveHistory(history.slice(0, 100));

        // If attached to a campaign run, insert into tiktok_videos so the
        // finalize-campaign step can run 7b/7c against it.
        let videoId = null;
        if (campaignRunId) {
          try {
            const db = require('./db');
            const run = db.getPipelineRun(campaignRunId);
            if (!run) {
              console.warn(`[reel-studio] campaign run ${campaignRunId} not found, skipping DB insert`);
            } else {
              videoId = `tv_${crypto.randomBytes(8).toString('hex')}`;
              // Determine next chunk_idx for this theme within this run
              const existing = db.getPipelineRunReels(campaignRunId) || [];
              const sameTheme = existing.filter(r => r.template === (theme || template));
              const nextChunkIdx = sameTheme.length;
              db.createTiktokVideo({
                id: videoId,
                filename: path.basename(result.filePath),
                url: videoUrl,
                template: theme || template,
                collection: run.collection || run.campaign_slug,
                designs: JSON.stringify(chunkDesignIds || []),
                shopifyProductIds: JSON.stringify(shopifyProductIds || []),
                duration: result.durationMs ? result.durationMs / 1000 : null,
                status: 'draft',
                platform: isTikTokShopReel ? 'tiktok-shop' : 'shopify',
                caption: caption || '',
                source: 'manual-reel-studio',
                renderProps: JSON.stringify({ template, props }),
                campaignRunId,
                chunkIdx: nextChunkIdx,
                isTiktokShopReel: isTikTokShopReel ? 1 : 0
              });
              console.log(`[reel-studio] Saved reel → tiktok_videos ${videoId} for campaign ${campaignRunId}`);
            }
          } catch (dbErr) {
            console.error('[reel-studio] DB insert failed:', dbErr.message);
            // Don't fail the render if DB insert fails — return warning
          }
        }

        sendJson(res, 200, {
          success: true,
          videoUrl,
          filename: path.basename(result.filePath),
          durationMs: result.durationMs,
          videoId,
          campaignRunId: campaignRunId || null,
        });
      } catch (e) {
        console.error('[reel-studio] render failed:', e);
        sendError(res, 500, e.message);
      }
    }).catch(() => sendError(res, 400, 'Invalid request body'));
    return true;
  }

  // GET /api/reel-studio/pipeline-mockup/:filename — serve mockup file from
  // the apparel pipeline output dir so the reel-studio UI can preview them.
  if (pathname.startsWith('/api/reel-studio/pipeline-mockup/') && req.method === 'GET') {
    const filename = decodeURIComponent(pathname.replace('/api/reel-studio/pipeline-mockup/', ''));
    // Prevent path traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return sendError(res, 400, 'Invalid filename');
    }
    const filePath = path.join(PIPELINE_OUTPUT_DIR, filename);
    if (!filePath.startsWith(PIPELINE_OUTPUT_DIR) || !fs.existsSync(filePath)) {
      return sendError(res, 404, 'Mockup not found');
    }
    const ext = path.extname(filename).toLowerCase();
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
    const stat = fs.statSync(filePath);
    res.writeHead(200, {
      'Content-Type': mime[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'public, max-age=3600',
    });
    fs.createReadStream(filePath).pipe(res);
    return true;
  }

  // GET /api/reel-studio/pending-campaigns — list pipeline_runs awaiting reels
  // Each entry includes resolved mockup files and design metadata so the UI
  // can pre-populate the reel composition with the right assets.
  if (pathname === '/api/reel-studio/pending-campaigns' && req.method === 'GET') {
    try {
      const db = require('./db');
      const runs = db.listPipelineRunsAwaitingReels();
      const enriched = runs.map(run => {
        let themeGroups = {};
        let publishManifest = [];
        let apparelChoices = [];
        try { themeGroups = run.theme_groups ? JSON.parse(run.theme_groups) : {}; } catch (_) {}
        try { publishManifest = run.publish_manifest ? JSON.parse(run.publish_manifest) : []; } catch (_) {}
        try { apparelChoices = run.apparel_choices ? JSON.parse(run.apparel_choices) : []; } catch (_) {}

        // For each theme, find mockup files on disk
        const themes = {};
        const mockupDir = run.mockup_dir;
        for (const [theme, items] of Object.entries(themeGroups)) {
          const themeItems = items.map(item => {
            let mockupFile = null;
            if (mockupDir && fs.existsSync(mockupDir) && item.designId) {
              const files = fs.readdirSync(mockupDir).filter(f =>
                f.includes(item.designId) && /\.(png|jpg|jpeg|webp)$/i.test(f)
              );
              if (files.length) mockupFile = files[0];
            }
            const shopifyMatch = publishManifest.find(p =>
              p.shopifyId && item.designId && p.designId?.includes(item.designId.substring(0, 20))
            );
            return {
              name: item.name,
              designId: item.designId,
              designSlug: item.designSlug,
              category: item.category,
              mockupFile,
              mockupUrl: mockupFile ? `/api/reel-studio/pipeline-mockup/${encodeURIComponent(mockupFile)}` : null,
              shopifyProductId: shopifyMatch?.shopifyId ? String(shopifyMatch.shopifyId) : null,
              shopifyHandle: shopifyMatch?.handle || null,
              preview: item.preview
            };
          });
          themes[theme] = themeItems;
        }

        // Reels already created for this run
        const existingReels = db.getPipelineRunReels(run.id) || [];

        return {
          id: run.id,
          campaignSlug: run.campaign_slug,
          collection: run.collection,
          status: run.status,
          createdAt: run.created_at,
          apparelChoices,
          themes,
          existingReelCount: existingReels.length,
          existingReels: existingReels.map(r => ({
            id: r.id,
            url: r.url,
            theme: r.template,
            isTikTokShopReel: !!r.is_tiktok_shop_reel,
            chunkIdx: r.chunk_idx
          }))
        };
      });
      sendJson(res, 200, { campaigns: enriched });
    } catch (e) {
      console.error('[reel-studio] pending-campaigns failed:', e);
      sendError(res, 500, e.message);
    }
    return true;
  }

  // POST /api/reel-studio/finalize-campaign/:id — run step 7b + 7c against
  // the reels that have been created for this pipeline run, then mark the
  // pipeline_runs row as finalized.
  if (pathname.startsWith('/api/reel-studio/finalize-campaign/') && req.method === 'POST') {
    const runId = decodeURIComponent(pathname.replace('/api/reel-studio/finalize-campaign/', ''));
    parseBody(req).then(async (body = {}) => {
      try {
        const db = require('./db');
        const reelFollowup = require('./modules/reel-followup');
        const run = db.getPipelineRun(runId);
        if (!run) return sendError(res, 404, 'Pipeline run not found');

        const reels = db.getPipelineRunReels(runId) || [];
        if (!reels.length) return sendError(res, 400, 'No reels attached to this campaign run yet');

        // Adapt tiktok_videos rows back into the reelRecords shape the
        // follow-up module expects.
        const reelRecords = reels.map(r => {
          let designIds = [];
          let shopifyProductIds = [];
          try { designIds = r.designs ? JSON.parse(r.designs) : []; } catch (_) {}
          try { shopifyProductIds = r.shopify_product_ids ? JSON.parse(r.shopify_product_ids) : []; } catch (_) {}
          return {
            videoId: r.id,
            theme: r.template,
            chunkIdx: r.chunk_idx || 0,
            isTikTokShopReel: !!r.is_tiktok_shop_reel,
            reel: { outputUrl: r.url, outputPath: r.filename },
            designIds,
            shopifyProductIds,
          };
        });

        let apparelChoices;
        try { apparelChoices = run.apparel_choices ? JSON.parse(run.apparel_choices) : undefined; } catch (_) {}

        const results = { errors: [], landingPages: [] };
        const ctx = {
          notify: body.notify === true,
          apparelChoices,
          results,
        };

        db.updatePipelineRun(runId, { status: 'finalizing' });

        const tiktokResult = await reelFollowup.publishTiktokShopReelProducts(reelRecords, ctx);
        const pagesResult = await reelFollowup.createReelLandingPages(reelRecords, ctx);

        db.updatePipelineRun(runId, {
          status: 'complete',
          finalized_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          current_step: 'complete',
        });

        sendJson(res, 200, {
          success: true,
          runId,
          tiktokShop: tiktokResult,
          landingPages: pagesResult,
          errors: results.errors,
          landingPagesDetail: results.landingPages,
        });
      } catch (e) {
        console.error('[reel-studio] finalize-campaign failed:', e);
        try {
          require('./db').updatePipelineRun(runId, { status: 'error', error_message: e.message });
        } catch (_) {}
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
