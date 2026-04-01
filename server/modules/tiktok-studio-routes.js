'use strict';

const { parseBody } = require('../utils/http');
const { analyzeClip, batchAnalyze, getAnalysis } = require('./footage-analyzer');
const creativeDirector = require('./tiktok-creative-director');
const remotionRenderer = require('./remotion-renderer');

/**
 * TikTok Studio API routes — AI-driven video creation
 *
 * Routes:
 *   POST /api/tiktok-studio/generate         — full pipeline: brief → render
 *   POST /api/tiktok-studio/brief            — generate brief only (for review)
 *   GET  /api/tiktok-studio/status            — render queue status
 *   POST /api/tiktok-studio/analyze/:clipId   — analyze single clip
 *   POST /api/tiktok-studio/analyze-batch     — batch analyze all unanalyzed
 *   GET  /api/tiktok-studio/analysis/:clipId  — get analysis results
 */
async function handleTikTokStudioRoute(pathname, req, res, db) {
  const basePath = '/api/tiktok-studio';
  if (!pathname.startsWith(basePath)) return false;
  const route = pathname.slice(basePath.length) || '/';

  const sendJson = (data, status = 200) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(data));
  };
  const sendError = (msg, status = 400) => sendJson({ error: msg }, status);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key'
    });
    res.end();
    return true;
  }

  // POST /api/tiktok-studio/generate — full pipeline
  if (route === '/generate' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      console.log('[TikTok Studio] Full pipeline triggered', body);

      // Step 1: Generate creative brief
      const brief = await creativeDirector.generateCreativeBrief(db, {
        contentType: body.contentType || null,
        prompt: body.prompt || null,
        clipIds: body.clipIds || null,
        maxDuration: body.maxDuration || null
      });

      // Step 2: Queue render
      const renderResult = await remotionRenderer.queueRender(brief.props, body.outputName || null);

      // Step 3: Update brief with render result
      const rawDb = db.db || db;
      rawDb.prepare('UPDATE tiktok_briefs SET render_status = ?, render_output = ? WHERE id = ?')
        .run(renderResult.success ? 'rendered' : 'failed', JSON.stringify(renderResult), brief.id);

      return sendJson({
        brief: {
          id: brief.id,
          contentType: brief.contentType,
          rationale: brief.rationale,
          sceneCount: brief.props.scenes.length
        },
        render: renderResult
      }, 201);
    } catch (err) {
      console.error('[TikTok Studio] Generate error:', err);
      return sendError(err.message, 500);
    }
  }

  // POST /api/tiktok-studio/brief — generate brief only
  if (route === '/brief' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const brief = await creativeDirector.generateCreativeBrief(db, {
        contentType: body.contentType || null,
        prompt: body.prompt || null,
        clipIds: body.clipIds || null,
        maxDuration: body.maxDuration || null
      });
      return sendJson(brief, 201);
    } catch (err) {
      console.error('[TikTok Studio] Brief error:', err);
      return sendError(err.message, 500);
    }
  }

  // GET /api/tiktok-studio/status — render queue status
  if (route === '/status' && req.method === 'GET') {
    return sendJson(remotionRenderer.getRenderStatus());
  }

  // POST /api/tiktok-studio/analyze/:clipId — analyze single clip
  const analyzeMatch = route.match(/^\/analyze\/([a-f0-9-]+)$/);
  if (analyzeMatch && req.method === 'POST') {
    try {
      const clipId = analyzeMatch[1];
      const analysis = await analyzeClip(db, clipId);
      return sendJson({ clipId, analysis }, 200);
    } catch (err) {
      console.error('[TikTok Studio] Analyze error:', err);
      return sendError(err.message, 500);
    }
  }

  // POST /api/tiktok-studio/analyze-batch — batch analyze all
  if (route === '/analyze-batch' && req.method === 'POST') {
    try {
      // Run in background, return immediately
      const promise = batchAnalyze(db, (progress) => {
        console.log(`[TikTok Studio] Batch progress: ${progress.current}/${progress.total} — ${progress.status}`);
      });
      // Don't await — return immediately with accepted status
      promise.then(result => {
        console.log(`[TikTok Studio] Batch analysis complete: ${result.success}/${result.total} succeeded`);
      }).catch(err => {
        console.error('[TikTok Studio] Batch analysis error:', err);
      });
      return sendJson({ status: 'started', message: 'Batch analysis running in background' }, 202);
    } catch (err) {
      return sendError(err.message, 500);
    }
  }

  // GET /api/tiktok-studio/analysis/:clipId — get analysis results
  const analysisMatch = route.match(/^\/analysis\/([a-f0-9-]+)$/);
  if (analysisMatch && req.method === 'GET') {
    try {
      const analysis = getAnalysis(db, analysisMatch[1]);
      if (!analysis) return sendError('No analysis found for this clip', 404);
      return sendJson(analysis);
    } catch (err) {
      return sendError(err.message, 500);
    }
  }

  // GET /api/tiktok-studio/video/:filename — serve rendered video
  const videoMatch = route.match(/^\/video\/(.+\.mp4)$/);
  if (videoMatch && req.method === 'GET') {
    const fs = require('fs');
    const path = require('path');
    const filePath = path.join('/mnt/stlFiles/footage-library/rendered', videoMatch[1]);
    if (!fs.existsSync(filePath)) return sendError('Video not found', 404);
    const stat = fs.statSync(filePath);
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': stat.size,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=86400'
    });
    fs.createReadStream(filePath).pipe(res);
    return true;
  }

  return false;
}

module.exports = { handleTikTokStudioRoute };
