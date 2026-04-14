/**
 * Decal Maker API routes
 * Routes: /api/decal-maker/*
 */

const crypto = require('crypto');
const { parseBody, sendJson, sendError } = require('./utils/http');

const PRICING = {
  basePrice: { 3: 350, 4: 375, 6: 425, 8: 550, 10: 700, 12: 850 }, // cents
  perExtraColor: 50, // cents per color beyond 1
  currency: 'USD'
};

function handleDecalMakerRoute(pathname, method, req, res, db) {
  // GET /api/decal-maker/pricing — return pricing table
  if (pathname === '/api/decal-maker/pricing' && method === 'GET') {
    sendJson(res, 200, PRICING);
    return true;
  }

  // GET /api/decal-maker/projects — list projects with filters
  if (pathname === '/api/decal-maker/projects' && method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const category = url.searchParams.get('category') || undefined;
    const createdBy = url.searchParams.get('createdBy') || url.searchParams.get('created_by') || undefined;
    const isTemplate = url.searchParams.get('is_template');
    const limit = parseInt(url.searchParams.get('limit'), 10) || 50;
    const offset = parseInt(url.searchParams.get('offset'), 10) || 0;

    const filters = { category, createdBy, limit, offset };
    if (isTemplate !== null && isTemplate !== undefined && isTemplate !== '') {
      filters.is_template = parseInt(isTemplate, 10);
    }

    const rows = db.listDecalProjects(filters);
    sendJson(res, 200, { projects: rows, count: rows.length, limit, offset });
    return true;
  }

  // Single project routes: GET/PUT/DELETE /api/decal-maker/projects/:id
  const singleMatch = pathname.match(/^\/api\/decal-maker\/projects\/([^/]+)$/);

  if (singleMatch && method === 'GET') {
    const getMatch = singleMatch;
    const project = db.getDecalProject(getMatch[1]);
    if (!project) {
      sendError(res, 404, 'Project not found');
      return true;
    }
    sendJson(res, 200, project);
    return true;
  }

  // POST /api/decal-maker/projects — create new project
  if (pathname === '/api/decal-maker/projects' && method === 'POST') {
    parseBody(req).then(body => {
      if (!body.name) return sendError(res, 400, 'name is required');
      if (!body.canvas_json && !body.canvasJson) return sendError(res, 400, 'canvas_json is required');

      const id = `decal_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const project = db.insertDecalProject({
        id,
        name: body.name,
        canvas_json: body.canvas_json || body.canvasJson,
        canvas_width_inches: body.canvas_width_inches ?? body.canvasWidthInches,
        canvas_height_inches: body.canvas_height_inches ?? body.canvasHeightInches,
        preview_png: body.preview_png || body.previewPng,
        category: body.category,
        color_count: body.color_count ?? body.colorCount,
        colors_used: body.colors_used || body.colorsUsed,
        price_cents: body.price_cents ?? body.priceCents,
        created_by: body.created_by || body.createdBy,
        customer_id: body.customer_id ?? body.customerId,
        is_template: body.is_template ?? body.isTemplate,
        tags: body.tags,
        order_id: body.order_id || body.orderId
      });
      sendJson(res, 201, project);
    }).catch(err => sendError(res, 400, err.message || 'Invalid request body'));
    return true;
  }

  if (singleMatch && method === 'PUT') {
    const putMatch = singleMatch;
    parseBody(req).then(body => {
      const existing = db.getDecalProject(putMatch[1]);
      if (!existing) return sendError(res, 404, 'Project not found');

      const updated = db.updateDecalProject(putMatch[1], body);
      sendJson(res, 200, updated);
    }).catch(err => sendError(res, 400, err.message || 'Invalid request body'));
    return true;
  }

  if (singleMatch && method === 'DELETE') {
    const delMatch = singleMatch;
    const existing = db.getDecalProject(delMatch[1]);
    if (!existing) {
      sendError(res, 404, 'Project not found');
      return true;
    }
    db.deleteDecalProject(delMatch[1]);
    sendJson(res, 200, { success: true, id: delMatch[1] });
    return true;
  }

  return false;
}

module.exports = { handleDecalMakerRoute };
