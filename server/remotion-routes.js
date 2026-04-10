/**
 * Remotion video rendering routes for vinylApp server
 * Routes: /api/remotion/*
 */

const path = require('path');
const fs = require('fs');
const { parseBody, sendJson, sendError } = require('./utils/http');
const { renderVideo, renderStill, OUT_DIR } = require('../remotion/render-api');

function handleRemotionRoute(pathname, req, res, db) {
  // POST /api/remotion/render — render a video
  if (pathname === '/api/remotion/render' && req.method === 'POST') {
    parseBody(req).then(body => {
      const { compositionId, props, outputFile, codec } = body;
      if (!compositionId) {
        return sendError(res, 400, 'compositionId is required');
      }
      console.log(`[remotion] Starting render: ${compositionId}`);
      renderVideo({ compositionId, props, outputFile, codec })
        .then(result => {
          sendJson(res, {
            success: true,
            filePath: result.filePath,
            filename: path.basename(result.filePath),
            durationMs: result.durationMs,
          });
        })
        .catch(err => {
          sendError(res, 500, err.message);
        });
    }).catch(err => sendError(res, 400, 'Invalid request body'));
    return true;
  }

  // POST /api/remotion/still — render a still frame
  if (pathname === '/api/remotion/still' && req.method === 'POST') {
    parseBody(req).then(body => {
      const { compositionId, props, frame, format, outputFile } = body;
      if (!compositionId) {
        return sendError(res, 400, 'compositionId is required');
      }
      renderStill({ compositionId, props, frame, format, outputFile })
        .then(result => {
          sendJson(res, {
            success: true,
            filePath: result.filePath,
            filename: path.basename(result.filePath),
          });
        })
        .catch(err => {
          sendError(res, 500, err.message);
        });
    }).catch(err => sendError(res, 400, 'Invalid request body'));
    return true;
  }

  // GET /api/remotion/compositions — list available compositions
  if (pathname === '/api/remotion/compositions' && req.method === 'GET') {
    sendJson(res, {
      compositions: [
        {
          id: 'ProductShowcase',
          description: 'Single product showcase with animated reveal',
          dimensions: '1080x1920',
          duration: '5s',
          props: ['productName', 'productImage', 'backgroundColor'],
        },
        {
          id: 'TikTokPromo',
          description: 'TikTok-style promo with headline, product carousel, and CTA',
          dimensions: '1080x1920',
          duration: '10s',
          props: ['headline', 'subheadline', 'productImages', 'accentColor'],
        },
        {
          id: 'StickerReveal',
          description: 'Sticker peel-off reveal animation',
          dimensions: '1080x1080',
          duration: '3s',
          props: ['stickerImage', 'stickerName', 'backgroundColor'],
        },
      ],
    });
    return true;
  }

  // GET /api/remotion/output/:filename — serve rendered file
  if (pathname.startsWith('/api/remotion/output/') && req.method === 'GET') {
    const filename = pathname.replace('/api/remotion/output/', '');
    const filePath = path.join(OUT_DIR, filename);

    if (!fs.existsSync(filePath)) {
      return sendError(res, 404, 'File not found');
    }

    const ext = path.extname(filename).toLowerCase();
    const mimeTypes = {
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.png': 'image/png',
      '.jpeg': 'image/jpeg',
      '.jpg': 'image/jpeg',
    };

    const stat = fs.statSync(filePath);
    res.writeHead(200, {
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': `inline; filename="${filename}"`,
    });
    fs.createReadStream(filePath).pipe(res);
    return true;
  }

  // GET /api/remotion/outputs — list rendered files
  if (pathname === '/api/remotion/outputs' && req.method === 'GET') {
    if (!fs.existsSync(OUT_DIR)) {
      return sendJson(res, { files: [] });
    }
    const files = fs.readdirSync(OUT_DIR).map(f => {
      const stat = fs.statSync(path.join(OUT_DIR, f));
      return {
        filename: f,
        size: stat.size,
        created: stat.birthtime,
      };
    });
    sendJson(res, { files });
    return true;
  }

  return false;
}

module.exports = { handleRemotionRoute };
