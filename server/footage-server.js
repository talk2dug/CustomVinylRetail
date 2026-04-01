const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const { parseBody, sendJson, sendError } = require('./utils/http');

const FOOTAGE_DIR = '/mnt/stlFiles/footage-library';
const THUMBNAIL_DIR = path.join(FOOTAGE_DIR, 'thumbnails');
fs.mkdirSync(FOOTAGE_DIR, { recursive: true });
fs.mkdirSync(THUMBNAIL_DIR, { recursive: true });

// Try to generate thumbnail using ffmpeg (best effort)
function generateThumbnail(videoPath, thumbPath) {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    // Extract frame at 1 second, resize to 320px wide
    exec(`ffmpeg -i "${videoPath}" -ss 00:00:01 -vframes 1 -vf "scale=320:-1" -y "${thumbPath}" 2>/dev/null`, (err) => {
      resolve(!err && fs.existsSync(thumbPath));
    });
  });
}

// Try to get video duration and dimensions using ffprobe
function getVideoMeta(videoPath) {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    exec(`ffprobe -v quiet -print_format json -show_format -show_streams "${videoPath}"`, (err, stdout) => {
      if (err) return resolve({});
      try {
        const info = JSON.parse(stdout);
        const videoStream = (info.streams || []).find(s => s.codec_type === 'video');
        resolve({
          duration_seconds: info.format ? parseFloat(info.format.duration) || null : null,
          width: videoStream ? videoStream.width : null,
          height: videoStream ? videoStream.height : null
        });
      } catch (_) { resolve({}); }
    });
  });
}

async function handleFootageRoute(pathname, req, res, db) {
  const basePath = '/api/footage';
  if (!pathname.startsWith(basePath)) return false;
  const route = pathname.slice(basePath.length) || '/';
  const parsedUrl = url.parse(req.url || '', true);
  const query = parsedUrl.query || {};

  // OPTIONS (CORS preflight)
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
      'Access-Control-Max-Age': '86400'
    });
    res.end();
    return true;
  }

  // GET /api/footage/stats
  if (req.method === 'GET' && route === '/stats') {
    try {
      const stats = db.getFootageStats();
      // Add disk usage info
      const { execSync } = require('child_process');
      let diskFree = '';
      try { diskFree = execSync('df -h /mnt/stlFiles | tail -1').toString().trim(); } catch(_) {}
      sendJson(res, 200, { ...stats, disk: diskFree });
    } catch (err) { sendError(res, 500, err.message); }
    return true;
  }

  // GET /api/footage/categories
  if (req.method === 'GET' && route === '/categories') {
    try {
      sendJson(res, 200, { categories: db.listFootageCategories() });
    } catch (err) { sendError(res, 500, err.message); }
    return true;
  }

  // GET /api/footage/products — list products for tagging
  // ?all=1 returns all products, otherwise metal prints only
  if (req.method === 'GET' && route === '/products') {
    try {
      const sql = query.all === '1'
        ? "SELECT id, title FROM custom_art_products ORDER BY title"
        : "SELECT id, title FROM custom_art_products WHERE material_id = 'mat_metal' ORDER BY title";
      const products = db.db.prepare(sql).all();
      sendJson(res, 200, { products });
    } catch (err) { sendError(res, 500, err.message); }
    return true;
  }

  // GET /api/footage/clips
  if (req.method === 'GET' && route === '/clips') {
    try {
      const items = db.listFootage({
        category: query.category || undefined,
        product_id: query.product_id || undefined,
        status: query.status || undefined,
        tags: query.tags || undefined,
        search: query.search || undefined,
        limit: query.limit ? parseInt(query.limit) : 50,
        offset: query.offset ? parseInt(query.offset) : 0
      });
      sendJson(res, 200, { items });
    } catch (err) { sendError(res, 500, err.message); }
    return true;
  }

  // GET /api/footage/clips/:id
  const clipGet = route.match(/^\/clips\/([a-f0-9-]+)$/);
  if (req.method === 'GET' && clipGet) {
    const item = db.getFootage(clipGet[1]);
    if (!item) return sendError(res, 404, 'Clip not found'), true;
    sendJson(res, 200, item);
    return true;
  }

  // POST /api/footage/upload — multipart file upload (mobile-friendly)
  if (req.method === 'POST' && route === '/upload') {
    try {
      const contentType = req.headers['content-type'] || '';
      if (!contentType.includes('multipart/form-data')) {
        return sendError(res, 400, 'multipart/form-data required'), true;
      }

      const boundary = contentType.split('boundary=')[1];
      if (!boundary) return sendError(res, 400, 'Missing boundary'), true;

      const chunks = [];
      await new Promise((resolve, reject) => {
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', resolve);
        req.on('error', reject);
      });
      const buffer = Buffer.concat(chunks);

      // Parse multipart — extract file and fields
      const boundaryBuf = Buffer.from('--' + boundary);
      const parts = [];
      let start = 0;
      while (true) {
        const idx = buffer.indexOf(boundaryBuf, start);
        if (idx === -1) break;
        if (start > 0) {
          parts.push(buffer.slice(start, idx - 2)); // -2 for \r\n before boundary
        }
        start = idx + boundaryBuf.length + 2; // +2 for \r\n after boundary
        if (buffer[idx + boundaryBuf.length] === 0x2d && buffer[idx + boundaryBuf.length + 1] === 0x2d) break; // --boundary--
      }

      let fileData = null;
      let originalName = 'clip.mp4';
      let fileMime = 'video/mp4';
      const fields = {};

      for (const part of parts) {
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;
        const headers = part.slice(0, headerEnd).toString();
        const body = part.slice(headerEnd + 4);

        const nameMatch = headers.match(/name="([^"]+)"/);
        const filenameMatch = headers.match(/filename="([^"]+)"/);
        const ctMatch = headers.match(/Content-Type:\s*(\S+)/i);

        if (filenameMatch) {
          fileData = body;
          originalName = filenameMatch[1];
          fileMime = ctMatch ? ctMatch[1] : 'video/mp4';
        } else if (nameMatch) {
          fields[nameMatch[1]] = body.toString().trim();
        }
      }

      if (!fileData || fileData.length === 0) {
        return sendError(res, 400, 'No file uploaded'), true;
      }

      // Save file
      const ext = path.extname(originalName).toLowerCase() || '.mp4';
      const filename = crypto.randomUUID() + ext;
      const filePath = path.join(FOOTAGE_DIR, filename);
      fs.writeFileSync(filePath, fileData);

      // Get video metadata
      const meta = await getVideoMeta(filePath);

      // Generate thumbnail
      const thumbFilename = filename.replace(ext, '.jpg');
      const thumbPath = path.join(THUMBNAIL_DIR, thumbFilename);
      const thumbOk = await generateThumbnail(filePath, thumbPath);

      // Create DB record
      const record = db.createFootage({
        filename,
        original_name: originalName,
        file_path: filePath,
        file_size: fileData.length,
        duration_seconds: meta.duration_seconds || null,
        mime_type: fileMime,
        category: fields.category || null,
        subcategory: fields.subcategory || null,
        product_id: fields.product_id || null,
        product_name: fields.product_name || null,
        tags: fields.tags || null,
        notes: fields.notes || null,
        thumbnail_path: thumbOk ? thumbPath : null,
        status: 'raw',
        source: fields.source || 'upload',
        width: meta.width || null,
        height: meta.height || null
      });

      sendJson(res, 201, record);

      // Fire-and-forget: trigger AI analysis on the uploaded clip
      try {
        const { analyzeClip } = require('./modules/footage-analyzer');
        analyzeClip(db, record.id).then(() => {
          console.log(`[Footage] AI analysis complete for ${record.id}`);
        }).catch(e => {
          console.error(`[Footage] AI analysis failed for ${record.id}:`, e.message);
        });
      } catch (e) {
        console.error('[Footage] Could not load footage-analyzer:', e.message);
      }
    } catch (err) {
      console.error('[Footage] Upload error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // PATCH /api/footage/clips/:id — update metadata
  const clipPatch = route.match(/^\/clips\/([a-f0-9-]+)$/);
  if (req.method === 'PATCH' && clipPatch) {
    try {
      const body = await parseBody(req);
      const item = db.updateFootage(clipPatch[1], body);
      if (!item) return sendError(res, 404, 'Not found'), true;
      sendJson(res, 200, item);
    } catch (err) { sendError(res, 500, err.message); }
    return true;
  }

  // DELETE /api/footage/clips/:id
  const clipDel = route.match(/^\/clips\/([a-f0-9-]+)$/);
  if (req.method === 'DELETE' && clipDel) {
    try {
      const item = db.getFootage(clipDel[1]);
      if (item) {
        // Delete file from disk
        if (item.file_path && fs.existsSync(item.file_path)) fs.unlinkSync(item.file_path);
        if (item.thumbnail_path && fs.existsSync(item.thumbnail_path)) fs.unlinkSync(item.thumbnail_path);
        db.deleteFootage(clipDel[1]);
      }
      sendJson(res, 200, { ok: true });
    } catch (err) { sendError(res, 500, err.message); }
    return true;
  }

  // GET /api/footage/file/:filename — serve video file
  const fileServe = route.match(/^\/file\/(.+)$/);
  if (req.method === 'GET' && fileServe) {
    const filePath = path.join(FOOTAGE_DIR, fileServe[1]);
    if (!filePath.startsWith(FOOTAGE_DIR)) return sendError(res, 403, 'Invalid path'), true;
    if (!fs.existsSync(filePath)) return sendError(res, 404, 'File not found'), true;

    const stat = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
      '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska',
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png'
    };
    const mime = mimeTypes[ext] || 'application/octet-stream';

    // Support range requests for video streaming
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunkSize = end - start + 1;
      const stream = fs.createReadStream(filePath, { start, end });
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': mime
      });
      stream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': stat.size,
        'Content-Type': mime,
        'Accept-Ranges': 'bytes'
      });
      fs.createReadStream(filePath).pipe(res);
    }
    return true;
  }

  // GET /api/footage/thumb/:filename — serve thumbnail
  const thumbServe = route.match(/^\/thumb\/(.+)$/);
  if (req.method === 'GET' && thumbServe) {
    const filePath = path.join(THUMBNAIL_DIR, thumbServe[1]);
    if (!filePath.startsWith(THUMBNAIL_DIR)) return sendError(res, 403, 'Invalid path'), true;
    if (!fs.existsSync(filePath)) return sendError(res, 404, 'Thumbnail not found'), true;
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': data.length, 'Cache-Control': 'public, max-age=86400' });
    res.end(data);
    return true;
  }

  return false;
}

module.exports = { handleFootageRoute };
