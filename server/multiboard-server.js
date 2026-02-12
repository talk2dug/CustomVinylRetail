/**
 * Multiboard Designer Server
 * API routes for the 3D wall organizer designer
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseBody, sendJson, sendError } = require('./utils/http');

// Load parts catalog
const PARTS_PATH = path.join(__dirname, '..', 'data', 'multiboard-parts.json');
let partsCatalog = null;

function loadCatalog() {
  if (!partsCatalog) {
    partsCatalog = JSON.parse(fs.readFileSync(PARTS_PATH, 'utf-8'));
  }
  return partsCatalog;
}

/**
 * Handle Multiboard API routes
 * @param {string} pathname - URL pathname
 * @param {object} req - HTTP request
 * @param {object} res - HTTP response
 * @param {object} db - Database module (raw db instance at db.db)
 * @returns {boolean} - true if route was handled
 */
async function handleMultiboardRoute(pathname, req, res, db) {
  const basePath = '/api/multiboard';

  if (!pathname.startsWith(basePath)) {
    return false;
  }

  const route = pathname.slice(basePath.length) || '/';

  // GET /api/multiboard/parts - Return parts catalog
  if (req.method === 'GET' && route === '/parts') {
    try {
      const catalog = loadCatalog();
      sendJson(res, 200, catalog);
    } catch (err) {
      sendError(res, 500, 'Failed to load parts catalog');
    }
    return true;
  }

  // GET /api/multiboard/designs - List saved designs
  if (req.method === 'GET' && route === '/designs') {
    try {
      const rows = db.db.prepare(`
        SELECT design_id, name, customer_name, wall_width_inches, wall_height_inches,
               total_price_cents, status, created_at, updated_at
        FROM multiboard_designs
        ORDER BY updated_at DESC
      `).all();
      sendJson(res, 200, { designs: rows });
    } catch (err) {
      console.error('[Multiboard] List designs error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // GET /api/multiboard/designs/:id - Load a design
  const designMatch = route.match(/^\/designs\/([a-zA-Z0-9_-]+)$/);
  if (req.method === 'GET' && designMatch) {
    try {
      const row = db.db.prepare(`
        SELECT * FROM multiboard_designs WHERE design_id = ?
      `).get(designMatch[1]);

      if (!row) {
        sendError(res, 404, 'Design not found');
        return true;
      }

      // Parse JSON fields
      const design = {
        ...row,
        components: JSON.parse(row.components_json || '[]'),
        partsList: JSON.parse(row.parts_list_json || '[]')
      };
      delete design.components_json;
      delete design.parts_list_json;

      sendJson(res, 200, { design });
    } catch (err) {
      console.error('[Multiboard] Get design error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // POST /api/multiboard/designs - Save new design
  if (req.method === 'POST' && route === '/designs') {
    try {
      const body = await parseBody(req);
      const designId = 'mb-' + crypto.randomBytes(8).toString('hex');

      const stmt = db.db.prepare(`
        INSERT INTO multiboard_designs
          (design_id, name, customer_name, customer_email, customer_phone,
           wall_width_inches, wall_height_inches, components_json, parts_list_json,
           total_price_cents, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        designId,
        body.name || 'Untitled Design',
        body.customerName || null,
        body.customerEmail || null,
        body.customerPhone || null,
        body.wallWidth || 48,
        body.wallHeight || 36,
        JSON.stringify(body.components || []),
        JSON.stringify(body.partsList || []),
        body.totalPriceCents || 0,
        body.status || 'draft'
      );

      sendJson(res, 201, { designId, success: true });
    } catch (err) {
      console.error('[Multiboard] Create design error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // PUT /api/multiboard/designs/:id - Update design
  if (req.method === 'PUT' && designMatch) {
    try {
      const body = await parseBody(req);
      const id = designMatch[1];

      const existing = db.db.prepare('SELECT id FROM multiboard_designs WHERE design_id = ?').get(id);
      if (!existing) {
        sendError(res, 404, 'Design not found');
        return true;
      }

      const stmt = db.db.prepare(`
        UPDATE multiboard_designs SET
          name = COALESCE(?, name),
          customer_name = COALESCE(?, customer_name),
          customer_email = COALESCE(?, customer_email),
          customer_phone = COALESCE(?, customer_phone),
          wall_width_inches = COALESCE(?, wall_width_inches),
          wall_height_inches = COALESCE(?, wall_height_inches),
          components_json = COALESCE(?, components_json),
          parts_list_json = COALESCE(?, parts_list_json),
          total_price_cents = COALESCE(?, total_price_cents),
          status = COALESCE(?, status),
          updated_at = datetime('now')
        WHERE design_id = ?
      `);

      stmt.run(
        body.name || null,
        body.customerName || null,
        body.customerEmail || null,
        body.customerPhone || null,
        body.wallWidth || null,
        body.wallHeight || null,
        body.components ? JSON.stringify(body.components) : null,
        body.partsList ? JSON.stringify(body.partsList) : null,
        body.totalPriceCents !== undefined ? body.totalPriceCents : null,
        body.status || null,
        id
      );

      sendJson(res, 200, { success: true });
    } catch (err) {
      console.error('[Multiboard] Update design error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // DELETE /api/multiboard/designs/:id - Delete design
  if (req.method === 'DELETE' && designMatch) {
    try {
      const result = db.db.prepare('DELETE FROM multiboard_designs WHERE design_id = ?').run(designMatch[1]);
      if (result.changes === 0) {
        sendError(res, 404, 'Design not found');
        return true;
      }
      sendJson(res, 200, { success: true });
    } catch (err) {
      console.error('[Multiboard] Delete design error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  return false;
}

module.exports = { handleMultiboardRoute };
