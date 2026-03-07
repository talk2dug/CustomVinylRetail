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
        search: query.search || undefined,
        folder: Object.prototype.hasOwnProperty.call(query, 'folder') ? (query.folder || '') : undefined
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

  // GET /api/slicer/catalog/folders?category=X — list folders in a category
  if (req.method === 'GET' && route === '/catalog/folders') {
    try {
      const folderRows = db.listStlFolders(query.category || '');
      const folders = folderRows.map(r => r.folder);
      const folderCounts = {};
      for (const r of folderRows) folderCounts[r.folder] = r.count;
      sendJson(res, 200, { folders, folderCounts });
    } catch (err) {
      console.error('[Slicer] List folders error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // POST /api/slicer/catalog/bulk-folder — set folder for multiple items
  if (req.method === 'POST' && route === '/catalog/bulk-folder') {
    try {
      const body = await parseBody(req);
      const { stl_ids, folder } = body;
      if (!Array.isArray(stl_ids) || stl_ids.length === 0) {
        sendError(res, 400, 'stl_ids array is required');
        return true;
      }
      const result = db.bulkSetFolder(stl_ids, folder || null);
      sendJson(res, 200, result);
    } catch (err) {
      console.error('[Slicer] Bulk set folder error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // PUT /api/slicer/catalog/folders/rename — rename a folder within a category
  if (req.method === 'PUT' && route === '/catalog/folders/rename') {
    try {
      const body = await parseBody(req);
      const { category, old_name, new_name } = body;
      if (!category || !old_name || !new_name) {
        sendError(res, 400, 'category, old_name, and new_name are required');
        return true;
      }
      const result = db.renameStlFolder(category, old_name.trim(), new_name.trim());
      sendJson(res, 200, result);
    } catch (err) {
      console.error('[Slicer] Rename folder error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // POST /api/slicer/catalog/folders/remove — delete folder (items move to root)
  if (req.method === 'POST' && route === '/catalog/folders/remove') {
    try {
      const body = await parseBody(req);
      const { category, folder } = body;
      if (!category || !folder) {
        sendError(res, 400, 'category and folder are required');
        return true;
      }
      const result = db.deleteStlFolder(category, folder);
      sendJson(res, 200, result);
    } catch (err) {
      console.error('[Slicer] Remove folder error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // GET /api/slicer/catalog/:id/guide — mounting instructions + dependencies + howtos
  const guideMatch = route.match(/^\/catalog\/(\d+)\/guide$/);
  if (req.method === 'GET' && guideMatch) {
    try {
      const id = parseInt(guideMatch[1], 10);
      const item = db.getStlCatalogItem(id);
      if (!item) {
        sendError(res, 404, 'STL catalog item not found');
        return true;
      }

      // Resolve dependency recipe
      const { resolvePartDependencies } = require('./multiboard-dependency-recipes');
      const partObj = {
        name: item.name,
        gridWidth: item.mu_width || 2,
        gridHeight: item.mu_height || 2,
        _mbType: item.mb_type,
        _mountType: item.mount_type,
        attachesTo: item.mount_type === 'snap' ? 'multihole' : ''
      };
      const deps = resolvePartDependencies(partObj);

      // Get the single most relevant howto for this part type
      const typeToSlug = {
        shell: 'bin-assembly',
        bin: 'bin-assembly',
        insert: 'bin-assembly',
        divider: 'bin-assembly',
        gridfinity: 'bin-assembly',
        tray: 'tray-mounting-method-a',
        drawer: 'tray-mounting-method-a',
        shelf: 'shelf-bolt-locked',
        hook: 'peg-click-hooks',
        peg: 'peg-click-hooks',
        tile: 'wall-mounting-tiles',
        snap: 'snap-installation',
        mount: 'bolt-locked-inserts',
        bracket: 'bolt-locked-inserts',
        hinge: 'bolt-locked-inserts',
        fastener: 'bolt-locked-inserts',
        label: 'snap-installation',
        rail: 'multipoint-connections'
      };

      let enrichedHowtos = [];
      const slug = item.mb_type ? typeToSlug[item.mb_type] : null;
      if (slug) {
        const full = db.getHowtoBySlug(slug);
        if (full) enrichedHowtos.push({ title: full.howto.title, content: full.howto.content, slug: full.howto.slug, images: full.images, videos: full.videos });
      }

      // Parse mount hardware
      let mountHardware = [];
      if (item.mount_hardware) {
        try { mountHardware = JSON.parse(item.mount_hardware); } catch (_) {}
      }

      sendJson(res, 200, {
        item: {
          id: item.id,
          name: item.name,
          mb_type: item.mb_type,
          mount_type: item.mount_type,
          mount_hardware: mountHardware,
          requires_tray: item.requires_tray,
          tray_size: item.tray_size,
          tray_notes: item.tray_notes,
          mu_width: item.mu_width,
          mu_height: item.mu_height,
          folder: item.folder,
          source_url: item.source_url,
          description: item.description
        },
        dependencies: deps,
        howtos: enrichedHowtos
      });
    } catch (err) {
      console.error('[Slicer] Part guide error:', err);
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
        maxFileSize: 200 * 1024 * 1024, // 200MB max for 3D model files (STEP files can be large)
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
        // Use the actual extension (preserving case) for basename stripping on Linux
        const stlBase = path.basename(finalPath, path.extname(finalPath));
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
        est_time_min: null,
        description: fieldVal('description') || null,
        source_url: fieldVal('source_url') || null
      });

      sendJson(res, 201, { item: catalogItem });
    } catch (err) {
      console.error('[Slicer] Upload STL error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // POST /api/slicer/catalog/parse-part — run hardware parser on name + description
  if (req.method === 'POST' && route === '/catalog/parse-part') {
    try {
      const body = await parseBody(req);
      const { parsePart } = require('./multiboard-part-parser');
      const result = parsePart(body.name || '', body.description || '');
      sendJson(res, 200, result);
    } catch (err) {
      console.error('[Slicer] Parse part error:', err);
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
      const stlAbsPath = path.join(slicer.STL_MODELS, item.stl_path.trim());
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
      const absPath = path.join(slicer.STL_MODELS, item.stl_path.trim());
      if (!fs.existsSync(absPath)) {
        sendError(res, 404, 'STL file missing');
        return true;
      }
      const stat = fs.statSync(absPath);
      res.writeHead(200, {
        'Content-Type': 'application/sla',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${path.basename(item.stl_path.trim())}"`,
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

      const stlAbsPath = path.join(slicer.STL_MODELS, item.stl_path.trim());
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
        // User transform takes priority; fall back to item's saved default orientation
        transform: transform || (item.default_transform ? JSON.parse(item.default_transform) : null)
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
      const { stl_ids, instance_transforms, transforms, printer_model, material, quality, strength, speed, texture, surface, supports, auto_orient } = body;

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
        const absPath = path.join(slicer.STL_MODELS, item.stl_path.trim());
        if (!fs.existsSync(absPath)) {
          sendError(res, 404, `STL file missing from disk: ${item.name || item.stl_path}`);
          return true;
        }
        stlPaths.push(absPath);
        items.push(item);
      }

      const rawDb = db.db || db.getDb();
      const firstItem = items[0];

      // Build per-instance transforms array
      // New format: instance_transforms is an ordered array matching stl_ids
      // Legacy format: transforms is an object keyed by stl_id
      let finalInstanceTransforms = instance_transforms;
      if (!finalInstanceTransforms && transforms) {
        // Legacy: convert per-stlId transforms to per-instance
        finalInstanceTransforms = stl_ids.map(id => {
          const t = transforms[String(id)];
          if (t) return { stlId: id, ...t };
          return null;
        });
      }
      // Fill in default_transform for any instance that doesn't have one
      if (finalInstanceTransforms) {
        for (let i = 0; i < finalInstanceTransforms.length; i++) {
          if (!finalInstanceTransforms[i]) {
            const item = items[i];
            if (item && item.default_transform) {
              try { finalInstanceTransforms[i] = { stlId: item.id, ...JSON.parse(item.default_transform) }; } catch {}
            }
          }
        }
      } else {
        // No transforms at all — try default_transforms
        finalInstanceTransforms = items.map(item => {
          if (item.default_transform) {
            try { return { stlId: item.id, ...JSON.parse(item.default_transform) }; } catch {}
          }
          return null;
        });
      }

      const result = await slicer.slicePlate(stlPaths, {
        stl_ids,
        instance_transforms: finalInstanceTransforms,
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
  // SAVED BUILD PLATES
  // ========================================================================

  // GET /api/slicer/plates — list all saved build plates
  if (req.method === 'GET' && route === '/plates') {
    try {
      const plates = db.listSavedBuildPlates();
      for (const plate of plates) {
        try {
          const items = JSON.parse(plate.items || '[]');
          plate._itemSummary = items.map(it => {
            const cat = db.getStlCatalogItem(it.stl_id);
            return { stl_id: it.stl_id, qty: it.qty || 1, name: cat ? cat.name : `#${it.stl_id}` };
          });
          plate._totalParts = items.reduce((sum, it) => sum + (it.qty || 1), 0);
        } catch { plate._itemSummary = []; plate._totalParts = 0; }
      }
      sendJson(res, 200, { plates });
    } catch (err) {
      console.error('[Slicer] List plates error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // POST /api/slicer/plates — create a saved build plate
  if (req.method === 'POST' && route === '/plates') {
    try {
      const body = await parseBody(req);
      const { name, printer_model, items, settings } = body;
      if (!name) { sendError(res, 400, 'name is required'); return true; }
      if (!items || !Array.isArray(items) || items.length === 0) {
        sendError(res, 400, 'items array is required');
        return true;
      }
      const plate = db.createSavedBuildPlate({ name, printer_model, items, settings });
      sendJson(res, 201, plate);
    } catch (err) {
      console.error('[Slicer] Create plate error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // GET /api/slicer/plates/:id — get a saved build plate
  const plateGetMatch = route.match(/^\/plates\/(\d+)$/);
  if (req.method === 'GET' && plateGetMatch) {
    try {
      const id = parseInt(plateGetMatch[1], 10);
      const plate = db.getSavedBuildPlate(id);
      if (!plate) { sendError(res, 404, 'Saved plate not found'); return true; }
      // Enrich items
      try {
        const items = JSON.parse(plate.items || '[]');
        plate._itemSummary = items.map(it => {
          const cat = db.getStlCatalogItem(it.stl_id);
          return { stl_id: it.stl_id, qty: it.qty || 1, name: cat ? cat.name : `#${it.stl_id}`, missing: !cat };
        });
        plate._totalParts = items.reduce((sum, it) => sum + (it.qty || 1), 0);
      } catch { plate._itemSummary = []; plate._totalParts = 0; }
      sendJson(res, 200, plate);
    } catch (err) {
      console.error('[Slicer] Get plate error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // PUT /api/slicer/plates/:id — update a saved build plate
  const plateUpdateMatch = route.match(/^\/plates\/(\d+)$/);
  if (req.method === 'PUT' && plateUpdateMatch) {
    try {
      const id = parseInt(plateUpdateMatch[1], 10);
      const body = await parseBody(req);
      const updated = db.updateSavedBuildPlate(id, body);
      if (!updated) { sendError(res, 404, 'Saved plate not found'); return true; }
      sendJson(res, 200, updated);
    } catch (err) {
      console.error('[Slicer] Update plate error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // DELETE /api/slicer/plates/:id — delete a saved build plate
  const plateDeleteMatch = route.match(/^\/plates\/(\d+)$/);
  if (req.method === 'DELETE' && plateDeleteMatch) {
    try {
      const id = parseInt(plateDeleteMatch[1], 10);
      const plate = db.getSavedBuildPlate(id);
      if (!plate) { sendError(res, 404, 'Saved plate not found'); return true; }
      db.deleteSavedBuildPlate(id);
      sendJson(res, 200, { success: true, deleted: plate.name });
    } catch (err) {
      console.error('[Slicer] Delete plate error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // ========================================================================
  // PRODUCT BUILD PLATES (auto-generated from product kits)
  // ========================================================================

  // GET /api/slicer/product-plates — list all product build plates
  if (req.method === 'GET' && route === '/product-plates') {
    try {
      const productId = query.product_id;
      const plates = db.listProductBuildPlates(productId || undefined);
      sendJson(res, 200, plates);
    } catch (err) {
      console.error('[Slicer] List product plates error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // POST /api/slicer/product-plates — create a product build plate
  if (req.method === 'POST' && route === '/product-plates') {
    try {
      const body = await parseBody(req);
      const plate = db.createProductBuildPlate(body);
      sendJson(res, 201, plate);
    } catch (err) {
      console.error('[Slicer] Create product plate error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // PUT /api/slicer/product-plates/:id — update a product build plate
  const prodPlateUpdateMatch = route.match(/^\/product-plates\/(\d+)$/);
  if (req.method === 'PUT' && prodPlateUpdateMatch) {
    try {
      const id = parseInt(prodPlateUpdateMatch[1], 10);
      const body = await parseBody(req);
      const existing = db.getDb().prepare('SELECT * FROM product_build_plates WHERE id = ?').get(id);
      if (!existing) { sendError(res, 404, 'Product plate not found'); return true; }
      const updates = {};
      if (body.name !== undefined) updates.name = body.name;
      if (body.items !== undefined) updates.items = typeof body.items === 'string' ? body.items : JSON.stringify(body.items);
      if (body.material !== undefined) updates.material = body.material;
      if (body.printer_model !== undefined) updates.printer_model = body.printer_model;
      if (body.settings !== undefined) updates.settings = typeof body.settings === 'string' ? body.settings : JSON.stringify(body.settings);
      const setClauses = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
      if (setClauses) {
        db.getDb().prepare(`UPDATE product_build_plates SET ${setClauses} WHERE id = @id`).run({ ...updates, id });
      }
      const updated = db.getDb().prepare('SELECT * FROM product_build_plates WHERE id = ?').get(id);
      sendJson(res, 200, updated);
    } catch (err) {
      console.error('[Slicer] Update product plate error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // DELETE /api/slicer/product-plates/:id — delete a single product build plate
  const prodPlateDeleteMatch = route.match(/^\/product-plates\/(\d+)$/);
  if (req.method === 'DELETE' && prodPlateDeleteMatch) {
    try {
      const id = parseInt(prodPlateDeleteMatch[1], 10);
      db.getDb().prepare('DELETE FROM product_build_plates WHERE id = ?').run(id);
      sendJson(res, 200, { success: true });
    } catch (err) {
      console.error('[Slicer] Delete product plate error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // ========================================================================
  // THANGS PARTS SYNC
  // ========================================================================

  // GET /api/slicer/thangs-sync/status — sync status counts
  if (req.method === 'GET' && route === '/thangs-sync/status') {
    try {
      sendJson(res, 200, db.getThangsSyncStatus());
    } catch (err) {
      sendError(res, 500, err.message);
    }
    return true;
  }

  // GET /api/slicer/thangs-sync/missing — list unmatched parts
  if (req.method === 'GET' && route === '/thangs-sync/missing') {
    try {
      const search = query.search || null;
      const limit = parseInt(query.limit) || 100;
      const offset = parseInt(query.offset) || 0;
      const parts = db.listThangsMissingParts({ search, limit, offset });
      sendJson(res, 200, parts);
    } catch (err) {
      sendError(res, 500, err.message);
    }
    return true;
  }

  // POST /api/slicer/thangs-sync/run — re-match existing data against catalog
  if (req.method === 'POST' && route === '/thangs-sync/run') {
    try {
      const { exec } = require('child_process');
      const scriptPath = path.join(__dirname, 'scripts', 'sync-thangs-catalog.js');
      exec(`node "${scriptPath}"`, { timeout: 60000 }, (err, stdout, stderr) => {
        if (err) console.error('[ThangsSync] Re-match error:', err.message);
        else console.log('[ThangsSync] Re-match done:\n', stdout.slice(-300));
      });
      sendJson(res, 200, { started: true, message: 'Re-match started' });
    } catch (err) {
      sendError(res, 500, err.message);
    }
    return true;
  }

  // POST /api/slicer/thangs-sync/import — import crawled Thangs data (JSON array)
  if (req.method === 'POST' && route === '/thangs-sync/import') {
    try {
      const body = await parseBody(req);
      const models = body.models || body;
      if (!Array.isArray(models)) {
        sendError(res, 400, 'Expected JSON array of models');
        return true;
      }
      // Import and match in-process
      const { importAndMatch } = require('./scripts/sync-thangs-catalog');
      const status = importAndMatch(models);
      sendJson(res, 200, status);
    } catch (err) {
      console.error('[ThangsSync] Import error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // PUT /api/slicer/thangs-sync/:modelId/skip — mark as skipped
  const thangsSkipMatch = route.match(/^\/thangs-sync\/([^/]+)\/skip$/);
  if (req.method === 'PUT' && thangsSkipMatch) {
    try {
      const modelId = thangsSkipMatch[1];
      db.updateThangsPartStatus(modelId, 'skipped', null);
      sendJson(res, 200, { success: true });
    } catch (err) {
      sendError(res, 500, err.message);
    }
    return true;
  }

  // PUT /api/slicer/thangs-sync/:modelId/match — manually match to catalog ID
  const thangsMatchMatch = route.match(/^\/thangs-sync\/([^/]+)\/match$/);
  if (req.method === 'PUT' && thangsMatchMatch) {
    try {
      const modelId = thangsMatchMatch[1];
      const body = await parseBody(req);
      const catalogId = body.catalog_id;
      if (!catalogId) { sendError(res, 400, 'catalog_id required'); return true; }
      db.updateThangsPartStatus(modelId, 'matched', catalogId);
      sendJson(res, 200, { success: true });
    } catch (err) {
      sendError(res, 500, err.message);
    }
    return true;
  }

  // POST /api/slicer/thangs-sync/auto-match — auto-match a newly cataloged item against Thangs index
  if (req.method === 'POST' && route === '/thangs-sync/auto-match') {
    try {
      const body = await parseBody(req);
      const { catalogId, name, sourceUrl } = body;
      if (!catalogId) { sendError(res, 400, 'catalogId required'); return true; }
      const d = db.getDb();
      let matched = false;

      // Try matching by source URL (most accurate — Thangs download_url)
      if (sourceUrl) {
        // Extract model ID from thangs.com URL
        const thangsIdMatch = sourceUrl.match(/thangs\.com\/m\/(\d+)/);
        if (thangsIdMatch) {
          const tp = db.getThangsPartByModelId(thangsIdMatch[1]);
          if (tp && tp.status !== 'matched') {
            db.updateThangsPartStatus(tp.thangs_model_id, 'matched', catalogId);
            matched = true;
          }
        }
        // Also try matching by download_url
        if (!matched) {
          const byUrl = d.prepare("SELECT thangs_model_id FROM thangs_parts_index WHERE download_url = ? AND status != 'matched' LIMIT 1").get(sourceUrl);
          if (byUrl) {
            db.updateThangsPartStatus(byUrl.thangs_model_id, 'matched', catalogId);
            matched = true;
          }
        }
      }

      // Try matching by normalized name
      if (!matched && name) {
        const { normalizeName } = require('./scripts/sync-thangs-catalog');
        const norm = normalizeName(name);
        if (norm.length > 3) {
          const byTitle = d.prepare("SELECT thangs_model_id, title FROM thangs_parts_index WHERE status != 'matched' ORDER BY title").all();
          for (const tp of byTitle) {
            const normTitle = normalizeName(tp.title);
            if (normTitle === norm || (normTitle.length > 5 && norm.length > 5 && (normTitle.includes(norm) || norm.includes(normTitle)))) {
              db.updateThangsPartStatus(tp.thangs_model_id, 'matched', catalogId);
              matched = true;
              break;
            }
          }
        }
      }

      sendJson(res, 200, { matched, catalogId });
    } catch (err) {
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
