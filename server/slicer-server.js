/**
 * Slicer Server
 * API routes for the 3D slicing module
 * Handles STL catalog management, slicing requests, G-code cache, and presets
 */

const fs = require('fs');
const path = require('path');
const url = require('url');
const { formidable } = require('formidable');
const { parseBody, sendJson, sendError } = require('./utils/http');
const slicer = require('./slicer-service');

/**
 * Handle Slicer API routes
 * @param {string} pathname - URL pathname
 * @param {object} req - HTTP request
 * @param {object} res - HTTP response
 * @param {object} db - Database module (db.db for raw instance)
 */
async function handleSlicerRoute(pathname, req, res, db) {
  const basePath = '/api/slicer';

  if (!pathname.startsWith(basePath)) {
    return false;
  }

  const route = pathname.slice(basePath.length) || '/';
  const parsedUrl = url.parse(req.url || '', true);
  const query = parsedUrl.query || {};

  // ========================================================================
  // PRESETS
  // ========================================================================

  // GET /api/slicer/presets — human-readable options map
  if (req.method === 'GET' && route === '/presets') {
    try {
      sendJson(res, 200, slicer.getPresets());
    } catch (err) {
      console.error('[Slicer] Presets error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // ========================================================================
  // STL CATALOG
  // ========================================================================

  // GET /api/slicer/catalog — list catalog
  if (req.method === 'GET' && route === '/catalog') {
    try {
      const items = db.listStlCatalog({
        category: query.category || undefined,
        search: query.search || undefined
      });
      sendJson(res, 200, { items });
    } catch (err) {
      console.error('[Slicer] List catalog error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // GET /api/slicer/catalog/categories — list distinct categories
  if (req.method === 'GET' && route === '/catalog/categories') {
    try {
      const categories = db.listStlCatalogCategories();
      sendJson(res, 200, { categories });
    } catch (err) {
      console.error('[Slicer] List categories error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // GET /api/slicer/catalog/categories/counts — list categories with item counts
  if (req.method === 'GET' && route === '/catalog/categories/counts') {
    try {
      const categories = db.listStlCatalogCategoriesWithCounts();
      sendJson(res, 200, { categories });
    } catch (err) {
      console.error('[Slicer] List categories counts error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // POST /api/slicer/catalog/categories/merge — merge multiple categories into one
  if (req.method === 'POST' && route === '/catalog/categories/merge') {
    try {
      const body = await parseBody(req);
      const { from_categories, to_category } = body;
      if (!from_categories || !Array.isArray(from_categories) || !from_categories.length) {
        sendError(res, 400, 'from_categories (array) is required');
        return true;
      }
      if (!to_category || typeof to_category !== 'string' || !to_category.trim()) {
        sendError(res, 400, 'to_category (string) is required');
        return true;
      }
      const result = db.mergeStlCategories(from_categories, to_category.trim());
      sendJson(res, 200, result);
    } catch (err) {
      console.error('[Slicer] Merge categories error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // PUT /api/slicer/catalog/categories/rename — rename a single category
  if (req.method === 'PUT' && route === '/catalog/categories/rename') {
    try {
      const body = await parseBody(req);
      const { old_name, new_name } = body;
      if (!old_name || !new_name) {
        sendError(res, 400, 'old_name and new_name are required');
        return true;
      }
      const result = db.renameStlCategory(old_name.trim(), new_name.trim());
      sendJson(res, 200, result);
    } catch (err) {
      console.error('[Slicer] Rename category error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // DELETE /api/slicer/catalog/categories/remove — uncategorize items in a category
  if (req.method === 'POST' && route === '/catalog/categories/remove') {
    try {
      const body = await parseBody(req);
      const { category } = body;
      if (!category) {
        sendError(res, 400, 'category is required');
        return true;
      }
      const result = db.deleteStlCategory(category);
      sendJson(res, 200, result);
    } catch (err) {
      console.error('[Slicer] Remove category error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // POST /api/slicer/catalog/bulk-category — set category for multiple items at once
  if (req.method === 'POST' && route === '/catalog/bulk-category') {
    try {
      const body = await parseBody(req);
      const { stl_ids, category } = body;
      if (!Array.isArray(stl_ids) || stl_ids.length === 0) {
        sendError(res, 400, 'stl_ids array is required');
        return true;
      }
      if (typeof category !== 'string') {
        sendError(res, 400, 'category string is required');
        return true;
      }
      const result = db.bulkSetCategory(stl_ids, category.trim());
      sendJson(res, 200, result);
    } catch (err) {
      console.error('[Slicer] Bulk set category error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // GET /api/slicer/catalog/:id — get item + its G-code entries
  const catalogIdMatch = route.match(/^\/catalog\/(\d+)$/);
  if (req.method === 'GET' && catalogIdMatch) {
    try {
      const id = parseInt(catalogIdMatch[1], 10);
      const item = db.getStlCatalogItem(id);
      if (!item) {
        sendError(res, 404, 'STL catalog item not found');
        return true;
      }
      const gcodeEntries = db.listGcodeCacheForStl(id);
      sendJson(res, 200, { item, gcodeEntries });
    } catch (err) {
      console.error('[Slicer] Get catalog item error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // POST /api/slicer/catalog — upload STL file
  if (req.method === 'POST' && route === '/catalog') {
    try {
      const uploadDir = slicer.STL_MODELS;
      fs.mkdirSync(uploadDir, { recursive: true });

      const form = formidable({
        multiples: false,
        keepExtensions: true,
        allowEmptyFiles: false,
        maxFileSize: 100 * 1024 * 1024, // 100MB max for STL files
        uploadDir: uploadDir
      });

      const { fields, files } = await new Promise((resolve, reject) => {
        form.parse(req, (error, fields, files) => {
          if (error) reject(error);
          else resolve({ fields, files });
        });
      });

      // Get uploaded file info
      const fileField = files.file || files.stl;
      const file = Array.isArray(fileField) ? fileField[0] : fileField;
      if (!file) {
        sendError(res, 400, 'No 3D model file uploaded');
        return true;
      }

      // Move to proper name
      const originalName = file.originalFilename || file.newFilename || 'model.stl';
      const safeName = originalName.replace(/[^a-zA-Z0-9_.\-]/g, '_');
      const destPath = path.join(uploadDir, safeName);

      // If a file with that name already exists, add timestamp
      let finalPath = destPath;
      if (fs.existsSync(destPath)) {
        const ext = path.extname(safeName);
        const base = path.basename(safeName, ext);
        finalPath = path.join(uploadDir, `${base}_${Date.now()}${ext}`);
      }

      fs.renameSync(file.filepath, finalPath);

      // Convert STEP/STP → STL using PrusaSlicer
      const uploadExt = path.extname(finalPath).toLowerCase();
      if (uploadExt === '.step' || uploadExt === '.stp') {
        const stlBase = path.basename(finalPath, uploadExt);
        let stlPath = path.join(uploadDir, stlBase + '.stl');
        if (fs.existsSync(stlPath)) {
          stlPath = path.join(uploadDir, `${stlBase}_${Date.now()}.stl`);
        }
        try {
          await slicer.convertStepToStl(finalPath, stlPath);
        } catch (convErr) {
          try { fs.unlinkSync(finalPath); } catch {}
          sendError(res, 400, `Failed to convert STEP file to STL: ${convErr.message}`);
          return true;
        }
        if (!fs.existsSync(stlPath)) {
          try { fs.unlinkSync(finalPath); } catch {}
          sendError(res, 400, 'STEP to STL conversion produced no output');
          return true;
        }
        // Remove original STEP file, use converted STL going forward
        try { fs.unlinkSync(finalPath); } catch {}
        finalPath = stlPath;
      }

      // Parse field values
      const fieldVal = (name) => {
        const v = fields[name];
        if (!v) return '';
        return Array.isArray(v) ? (v[0] || '').trim() : String(v).trim();
      };

      const stlRelPath = path.relative(slicer.STL_MODELS, finalPath).replace(/\\/g, '/');
      const fileStat = fs.statSync(finalPath);

      // Try to get model info from PrusaSlicer
      let modelInfo = null;
      try {
        modelInfo = await slicer.getModelInfo(finalPath);
      } catch {}

      const catalogItem = db.createStlCatalogItem({
        name: fieldVal('name') || path.basename(safeName, path.extname(safeName)),
        category: fieldVal('category') || null,
        stl_path: stlRelPath,
        thumbnail_path: null,
        default_quality: fieldVal('default_quality') || 'standard',
        default_strength: fieldVal('default_strength') || 'normal',
        default_material: fieldVal('default_material') || 'pla',
        default_texture: fieldVal('default_texture') || 'smooth',
        default_supports: fieldVal('default_supports') || 'none',
        default_surface: fieldVal('default_surface') || 'standard',
        default_speed: fieldVal('default_speed') || 'normal',
        notes: fieldVal('notes') || null,
        file_size: fileStat.size,
        triangle_count: modelInfo?.triangle_count || null,
        dim_x: modelInfo?.dim_x || null,
        dim_y: modelInfo?.dim_y || null,
        dim_z: modelInfo?.dim_z || null,
        est_weight_g: null,
        est_time_min: null
      });

      sendJson(res, 201, { item: catalogItem });
    } catch (err) {
      console.error('[Slicer] Upload STL error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // PUT /api/slicer/catalog/:id — update catalog item
  const catalogUpdateMatch = route.match(/^\/catalog\/(\d+)$/);
  if (req.method === 'PUT' && catalogUpdateMatch) {
    try {
      const id = parseInt(catalogUpdateMatch[1], 10);
      const body = await parseBody(req);
      const updated = db.updateStlCatalogItem(id, body);
      if (!updated) {
        sendError(res, 404, 'STL catalog item not found');
        return true;
      }
      sendJson(res, 200, { item: updated });
    } catch (err) {
      console.error('[Slicer] Update catalog error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // DELETE /api/slicer/catalog/:id — delete catalog item + G-code cache
  const catalogDeleteMatch = route.match(/^\/catalog\/(\d+)$/);
  if (req.method === 'DELETE' && catalogDeleteMatch) {
    try {
      const id = parseInt(catalogDeleteMatch[1], 10);
      const item = db.getStlCatalogItem(id);
      if (!item) {
        sendError(res, 404, 'STL catalog item not found');
        return true;
      }

      // Delete physical STL file
      const stlAbsPath = path.join(slicer.STL_MODELS, item.stl_path);
      try { fs.unlinkSync(stlAbsPath); } catch {}

      // Delete associated G-code files
      const gcodeEntries = db.listGcodeCacheForStl(id);
      for (const entry of gcodeEntries) {
        const gcodePath = path.join(slicer.GCODE_CACHE, entry.gcode_path);
        try { fs.unlinkSync(gcodePath); } catch {}
      }

      // Delete thumbnail if exists
      if (item.thumbnail_path) {
        const thumbPath = path.join(slicer.STL_THUMBNAILS, item.thumbnail_path);
        try { fs.unlinkSync(thumbPath); } catch {}
      }

      db.deleteStlCatalogItem(id);
      sendJson(res, 200, { success: true, deleted: item.name });
    } catch (err) {
      console.error('[Slicer] Delete catalog error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // ========================================================================
  // STL FILE SERVING
  // ========================================================================

  // GET /api/slicer/stl/:id/thumbnail — serve STL thumbnail
  const thumbMatch = route.match(/^\/stl\/(\d+)\/thumbnail$/);
  if (req.method === 'GET' && thumbMatch) {
    try {
      const id = parseInt(thumbMatch[1], 10);
      const item = db.getStlCatalogItem(id);
      if (!item || !item.thumbnail_path) {
        sendError(res, 404, 'Thumbnail not found');
        return true;
      }
      const absPath = path.join(slicer.STL_THUMBNAILS, item.thumbnail_path);
      if (!fs.existsSync(absPath)) {
        sendError(res, 404, 'Thumbnail file missing');
        return true;
      }
      const stat = fs.statSync(absPath);
      const ext = path.extname(absPath).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': stat.size,
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*'
      });
      fs.createReadStream(absPath).pipe(res);
    } catch (err) {
      console.error('[Slicer] Serve thumbnail error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // GET /api/slicer/stl/:id/download — serve raw STL file
  const stlDownloadMatch = route.match(/^\/stl\/(\d+)\/download$/);
  if (req.method === 'GET' && stlDownloadMatch) {
    try {
      const id = parseInt(stlDownloadMatch[1], 10);
      const item = db.getStlCatalogItem(id);
      if (!item) {
        sendError(res, 404, 'STL catalog item not found');
        return true;
      }
      const absPath = path.join(slicer.STL_MODELS, item.stl_path);
      if (!fs.existsSync(absPath)) {
        sendError(res, 404, 'STL file missing');
        return true;
      }
      const stat = fs.statSync(absPath);
      res.writeHead(200, {
        'Content-Type': 'application/sla',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${path.basename(item.stl_path)}"`,
        'Access-Control-Allow-Origin': '*'
      });
      fs.createReadStream(absPath).pipe(res);
    } catch (err) {
      console.error('[Slicer] Serve STL error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // ========================================================================
  // SLICING
  // ========================================================================

  // POST /api/slicer/slice — slice an STL with given settings
  if (req.method === 'POST' && route === '/slice') {
    try {
      const body = await parseBody(req);
      const { stl_id, printer_model, material, quality, strength, speed, texture, surface, supports, auto_orient, copies, transform } = body;

      if (!stl_id) {
        sendError(res, 400, 'stl_id is required');
        return true;
      }

      const item = db.getStlCatalogItem(stl_id);
      if (!item) {
        sendError(res, 404, 'STL catalog item not found');
        return true;
      }

      const stlAbsPath = path.join(slicer.STL_MODELS, item.stl_path);
      if (!fs.existsSync(stlAbsPath)) {
        sendError(res, 404, 'STL file missing from disk');
        return true;
      }

      const rawDb = db.db || db.getDb();

      const result = await slicer.sliceSTL(stlAbsPath, {
        stl_id,
        printer_model: printer_model || 'kobra3',
        material: material || item.default_material || 'pla',
        quality: quality || item.default_quality || 'standard',
        strength: strength || item.default_strength || 'normal',
        speed: speed || 'normal',
        texture: texture || item.default_texture || 'smooth',
        surface: surface || item.default_surface || 'standard',
        supports: supports || item.default_supports || 'none',
        auto_orient: auto_orient === true,
        copies: parseInt(copies, 10) || 1,
        transform: transform || null
      }, rawDb);

      sendJson(res, 200, result);
    } catch (err) {
      console.error('[Slicer] Slice error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // POST /api/slicer/slice-plate — slice multiple STLs on one plate
  if (req.method === 'POST' && route === '/slice-plate') {
    try {
      const body = await parseBody(req);
      const { stl_ids, transforms, printer_model, material, quality, strength, speed, texture, surface, supports, auto_orient } = body;

      if (!stl_ids || !Array.isArray(stl_ids) || stl_ids.length === 0) {
        sendError(res, 400, 'stl_ids (array) is required');
        return true;
      }

      // Validate all IDs and resolve paths
      const stlPaths = [];
      const items = [];
      for (const id of stl_ids) {
        const item = db.getStlCatalogItem(id);
        if (!item) {
          sendError(res, 404, `STL catalog item not found: id=${id}`);
          return true;
        }
        const absPath = path.join(slicer.STL_MODELS, item.stl_path);
        if (!fs.existsSync(absPath)) {
          sendError(res, 404, `STL file missing from disk: ${item.name || item.stl_path}`);
          return true;
        }
        stlPaths.push(absPath);
        items.push(item);
      }

      const rawDb = db.db || db.getDb();
      const firstItem = items[0];

      const result = await slicer.slicePlate(stlPaths, {
        stl_ids,
        transforms: transforms || {},
        printer_model: printer_model || 'kobra3',
        material: material || firstItem.default_material || 'pla',
        quality: quality || firstItem.default_quality || 'standard',
        strength: strength || firstItem.default_strength || 'normal',
        speed: speed || 'normal',
        texture: texture || firstItem.default_texture || 'smooth',
        surface: surface || firstItem.default_surface || 'standard',
        supports: supports || firstItem.default_supports || 'none',
        auto_orient: auto_orient === true  // Default OFF — most models are already oriented correctly
      }, rawDb);

      sendJson(res, 200, result);
    } catch (err) {
      console.error('[Slicer] Plate slice error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // ========================================================================
  // G-CODE CACHE
  // ========================================================================

  // GET /api/slicer/gcode/:id/download — download a cached G-code file
  const gcodeDownloadMatch = route.match(/^\/gcode\/(\d+)\/download$/);
  if (req.method === 'GET' && gcodeDownloadMatch) {
    try {
      const id = parseInt(gcodeDownloadMatch[1], 10);
      const entry = db.getGcodeCache(id);
      if (!entry) {
        sendError(res, 404, 'G-code cache entry not found');
        return true;
      }
      const absPath = path.join(slicer.GCODE_CACHE, entry.gcode_path);
      if (!fs.existsSync(absPath)) {
        sendError(res, 404, 'G-code file missing from disk');
        return true;
      }
      const stat = fs.statSync(absPath);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${entry.gcode_filename}"`,
        'Access-Control-Allow-Origin': '*'
      });
      fs.createReadStream(absPath).pipe(res);
    } catch (err) {
      console.error('[Slicer] Download G-code error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // GET /api/slicer/cache — list all cached G-code entries
  if (req.method === 'GET' && route === '/cache') {
    try {
      const entries = db.listAllGcodeCache();
      sendJson(res, 200, { entries });
    } catch (err) {
      console.error('[Slicer] List cache error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // GET /api/slicer/cache/for/:stlId — list G-code entries for a specific STL
  const cacheForStlMatch = route.match(/^\/cache\/for\/(\d+)$/);
  if (req.method === 'GET' && cacheForStlMatch) {
    try {
      const stlId = parseInt(cacheForStlMatch[1], 10);
      const entries = db.listGcodeCacheForStl(stlId);
      sendJson(res, 200, { entries });
    } catch (err) {
      console.error('[Slicer] List cache for STL error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // DELETE /api/slicer/cache/:id — delete one cached G-code
  const cacheDeleteMatch = route.match(/^\/cache\/(\d+)$/);
  if (req.method === 'DELETE' && cacheDeleteMatch) {
    try {
      const id = parseInt(cacheDeleteMatch[1], 10);
      const entry = db.getGcodeCache(id);
      if (!entry) {
        sendError(res, 404, 'G-code cache entry not found');
        return true;
      }
      // Delete physical file
      const absPath = path.join(slicer.GCODE_CACHE, entry.gcode_path);
      try { fs.unlinkSync(absPath); } catch {}
      db.deleteGcodeCache(id);
      sendJson(res, 200, { success: true, deleted: entry.gcode_filename });
    } catch (err) {
      console.error('[Slicer] Delete cache entry error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // DELETE /api/slicer/cache — clear all G-code cache
  if (req.method === 'DELETE' && route === '/cache') {
    try {
      // Delete all physical G-code files
      const entries = db.listAllGcodeCache();
      for (const entry of entries) {
        const absPath = path.join(slicer.GCODE_CACHE, entry.gcode_path);
        try { fs.unlinkSync(absPath); } catch {}
      }
      db.clearAllGcodeCache();
      sendJson(res, 200, { success: true, cleared: entries.length });
    } catch (err) {
      console.error('[Slicer] Clear cache error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // No matching route
  sendError(res, 404, 'Slicer API endpoint not found');
  return true;
}

module.exports = { handleSlicerRoute };
