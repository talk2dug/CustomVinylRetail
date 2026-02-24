/**
 * Multiboard Designer Server
 * API routes for the 3D wall organizer designer
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseBody, sendJson, sendError } = require('./utils/http');

// Load static parts catalog (legacy parts for backwards compatibility)
const PARTS_PATH = path.join(__dirname, '..', 'data', 'multiboard-parts.json');
let staticCatalog = null;

function loadStaticCatalog() {
  if (!staticCatalog) {
    staticCatalog = JSON.parse(fs.readFileSync(PARTS_PATH, 'utf-8'));
  }
  return staticCatalog;
}

// Type-to-designer-part mapping defaults
const MB_TYPE_DEFAULTS = {
  tile:      { attachesTo: 'wall',      snapType: null,        providesSnaps: ['multihole', 'pegboard'], geometry: { type: 'tile', cornerRadius: 0.1 }, thickness: 0.2 },
  hook:      { attachesTo: 'pegboard',  snapType: 'pegboard',  providesSnaps: [],                        geometry: { type: 'hook', style: 'single-peg', length: 1.5 }, thickness: 2.0 },
  bin:       { attachesTo: 'multihole', snapType: 'multihole', providesSnaps: [],                        geometry: { type: 'bin', depth: 1.5, wallThickness: 0.08 }, thickness: 2.0 },
  shelf:     { attachesTo: 'multihole', snapType: 'multihole', providesSnaps: [],                        geometry: { type: 'shelf', depth: 3.0 }, thickness: 2.5 },
  peg:       { attachesTo: 'pegboard',  snapType: 'pegboard',  providesSnaps: [],                        geometry: { type: 'hook', style: 'single-peg', length: 2.0 }, thickness: 2.0 },
  hardware:  { attachesTo: 'multihole', snapType: 'multihole', providesSnaps: [],                        geometry: { type: 'snap' }, thickness: 0.4 },
  accessory: { attachesTo: 'multihole', snapType: 'multihole', providesSnaps: [],                        geometry: { type: 'bin', depth: 1.0, wallThickness: 0.06 }, thickness: 1.5 },
  unknown:   { attachesTo: 'multihole', snapType: 'multihole', providesSnaps: [],                        geometry: { type: 'bin', depth: 1.5, wallThickness: 0.08 }, thickness: 2.0 },
};

// Map mb_type to designer category key
const MB_TYPE_TO_CATEGORY = {
  tile: 'tiles', hook: 'hooks', bin: 'bins', shelf: 'shelves',
  peg: 'pegs', hardware: 'hardware', accessory: 'accessories', unknown: 'bins',
};

// Default pricing per MU² by type
const MB_PRICING = {
  tile:      { costPerMU2: 0.005, pricePerMU2: 0.02, weightPerMU2: 0.5 },
  hook:      { costPerMU2: 0.10,  pricePerMU2: 0.50, weightPerMU2: 4.0 },
  bin:       { costPerMU2: 0.04,  pricePerMU2: 0.15, weightPerMU2: 1.5 },
  shelf:     { costPerMU2: 0.08,  pricePerMU2: 0.30, weightPerMU2: 3.0 },
  peg:       { costPerMU2: 0.10,  pricePerMU2: 0.50, weightPerMU2: 4.0 },
  hardware:  { costPerMU2: 0.05,  pricePerMU2: 0.25, weightPerMU2: 1.5 },
  accessory: { costPerMU2: 0.04,  pricePerMU2: 0.15, weightPerMU2: 1.0 },
  unknown:   { costPerMU2: 0.04,  pricePerMU2: 0.15, weightPerMU2: 1.5 },
};

/**
 * Transform a stl_catalog DB row into the designer part shape.
 */
function catalogItemToDesignerPart(row) {
  const defaults = MB_TYPE_DEFAULTS[row.mb_type] || MB_TYPE_DEFAULTS.unknown;
  const pricing = MB_PRICING[row.mb_type] || MB_PRICING.unknown;
  const w = row.mu_width || 2;
  const h = row.mu_height || 2;
  const muArea = w * h;

  // Scale geometry depth proportionally for bins/shelves
  const geometry = { ...defaults.geometry };
  if (geometry.type === 'bin') {
    geometry.depth = Math.max(1.0, h * 0.5);
  } else if (geometry.type === 'shelf') {
    geometry.depth = Math.max(2.0, h * 0.75);
  } else if (geometry.type === 'hook') {
    geometry.length = Math.max(1.0, w * 0.75);
  }

  return {
    id: `stl-${row.id}`,
    name: row.name,
    category: MB_TYPE_TO_CATEGORY[row.mb_type] || 'bins',
    gridWidth: w,
    gridHeight: h,
    thickness: defaults.thickness,
    attachesTo: defaults.attachesTo,
    snapType: defaults.snapType,
    providesSnaps: [...defaults.providesSnaps],
    requiresHardware: [],
    weightGrams: Math.round(muArea * pricing.weightPerMU2),
    costUSD: Math.round(muArea * pricing.costPerMU2 * 100) / 100,
    priceUSD: Math.round(muArea * pricing.pricePerMU2 * 100) / 100,
    colors: ['#333333', '#FFFFFF', '#1B5E20', '#1565C0', '#E65100'],
    geometry,
    hidden: false,
    _stlCatalogId: row.id,
    _stlPath: row.stl_path,
    _thumbnailPath: row.thumbnail_path,
    _mbType: row.mb_type,
  };
}

/**
 * Build dynamic catalog: static legacy parts + STL catalog parts
 */
function buildDynamicCatalog(db) {
  const staticData = loadStaticCatalog();
  const dbItems = db.listMultiboardParts();
  const dynamicParts = dbItems.map(catalogItemToDesignerPart);

  return {
    parts: [...staticData.parts, ...dynamicParts],
    serviceRates: staticData.serviceRates,
    colorPresets: staticData.colorPresets,
  };
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

  // GET /api/multiboard/parts - Return parts catalog (static legacy + dynamic from STL catalog)
  if (req.method === 'GET' && route === '/parts') {
    try {
      const catalog = buildDynamicCatalog(db);
      sendJson(res, 200, catalog);
    } catch (err) {
      console.error('[Multiboard] Failed to build catalog:', err);
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

  // ======================== ORDERS ========================

  // POST /api/multiboard/order - Create production order from design
  if (req.method === 'POST' && route === '/order') {
    try {
      const body = await parseBody(req);

      if (!body.designId) {
        sendError(res, 400, 'designId is required');
        return true;
      }

      // Load the design
      const design = db.db.prepare('SELECT * FROM multiboard_designs WHERE design_id = ?').get(body.designId);
      if (!design) {
        sendError(res, 404, 'Design not found');
        return true;
      }

      const orderId = 'mbo-' + crypto.randomBytes(8).toString('hex');

      db.db.prepare(`
        INSERT INTO multiboard_orders
          (order_id, design_id, customer_name, customer_email, customer_phone,
           service_level, wall_width_inches, wall_height_inches,
           components_json, parts_list_json, total_price_cents, service_fee_cents,
           status, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ordered', ?)
      `).run(
        orderId,
        body.designId,
        body.customerName || design.customer_name || null,
        body.customerEmail || design.customer_email || null,
        body.customerPhone || design.customer_phone || null,
        body.serviceLevel || 'designBuild',
        design.wall_width_inches,
        design.wall_height_inches,
        design.components_json,
        design.parts_list_json,
        body.totalPriceCents || design.total_price_cents || 0,
        body.serviceFeeCents || 0,
        body.notes || null
      );

      // Update design status to 'ordered'
      db.db.prepare("UPDATE multiboard_designs SET status = 'ordered', updated_at = datetime('now') WHERE design_id = ?")
        .run(body.designId);

      sendJson(res, 201, { orderId, success: true });
    } catch (err) {
      console.error('[Multiboard] Create order error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // GET /api/multiboard/orders - List all orders
  if (req.method === 'GET' && route === '/orders') {
    try {
      const rows = db.db.prepare(`
        SELECT order_id, design_id, customer_name, service_level,
               wall_width_inches, wall_height_inches,
               total_price_cents, service_fee_cents, status, notes,
               created_at, updated_at
        FROM multiboard_orders
        ORDER BY created_at DESC
      `).all();
      sendJson(res, 200, { orders: rows });
    } catch (err) {
      console.error('[Multiboard] List orders error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // GET /api/multiboard/orders/:id - Get order details
  const orderMatch = route.match(/^\/orders\/([a-zA-Z0-9_-]+)$/);
  if (req.method === 'GET' && orderMatch) {
    try {
      const row = db.db.prepare('SELECT * FROM multiboard_orders WHERE order_id = ?').get(orderMatch[1]);
      if (!row) {
        sendError(res, 404, 'Order not found');
        return true;
      }

      const order = {
        ...row,
        components: JSON.parse(row.components_json || '[]'),
        partsList: JSON.parse(row.parts_list_json || '[]')
      };
      delete order.components_json;
      delete order.parts_list_json;

      sendJson(res, 200, { order });
    } catch (err) {
      console.error('[Multiboard] Get order error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // PATCH /api/multiboard/orders/:id/status - Update order status
  const statusMatch = route.match(/^\/orders\/([a-zA-Z0-9_-]+)\/status$/);
  if (req.method === 'PATCH' && statusMatch) {
    try {
      const body = await parseBody(req);
      const validStatuses = ['ordered', 'in-production', 'complete', 'cancelled'];

      if (!body.status || !validStatuses.includes(body.status)) {
        sendError(res, 400, `Invalid status. Must be one of: ${validStatuses.join(', ')}`);
        return true;
      }

      const result = db.db.prepare(`
        UPDATE multiboard_orders SET status = ?, notes = COALESCE(?, notes), updated_at = datetime('now')
        WHERE order_id = ?
      `).run(body.status, body.notes || null, statusMatch[1]);

      if (result.changes === 0) {
        sendError(res, 404, 'Order not found');
        return true;
      }

      // Sync design status
      const order = db.db.prepare('SELECT design_id FROM multiboard_orders WHERE order_id = ?').get(statusMatch[1]);
      if (order) {
        const designStatus = body.status === 'cancelled' ? 'draft' : body.status;
        db.db.prepare("UPDATE multiboard_designs SET status = ?, updated_at = datetime('now') WHERE design_id = ?")
          .run(designStatus, order.design_id);
      }

      sendJson(res, 200, { success: true });
    } catch (err) {
      console.error('[Multiboard] Update order status error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  return false;
}

module.exports = { handleMultiboardRoute };
