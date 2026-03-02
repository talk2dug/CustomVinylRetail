'use strict';
/**
 * quote-server.js — REST API for the Print Quotes system
 *
 * Routes mounted at /api/quotes
 * All routes receive the db module so they can call CRUD helpers directly.
 */

const url = require('url');
const { parseBody, sendJson, sendError } = require('./utils/http');
const { packQuoteItems } = require('./plate-packer');

/**
 * Handle Print Quotes API routes.
 * @param {string} pathname - URL pathname
 * @param {object} req - HTTP request
 * @param {object} res - HTTP response
 * @param {object} db - Database module
 * @returns {boolean} true if route was handled
 */
async function handleQuoteRoute(pathname, req, res, db) {
  const basePath = '/api/quotes';
  if (!pathname.startsWith(basePath)) return false;

  const route = pathname.slice(basePath.length) || '/';
  const parsedUrl = url.parse(req.url || '', true);
  const query = parsedUrl.query || {};

  // Regex helpers
  const quoteIdMatch = route.match(/^\/(\d+)$/);
  const quoteItemsMatch = route.match(/^\/(\d+)\/items$/);
  const quotePlatesMatch = route.match(/^\/(\d+)\/plates$/);
  const quotePlatesPackMatch = route.match(/^\/(\d+)\/plates\/pack$/);
  const quotePlateIdMatch = route.match(/^\/(\d+)\/plates\/(\d+)$/);

  // ========================================================================
  // GET /api/quotes — list quotes
  // ========================================================================
  if (req.method === 'GET' && route === '/') {
    try {
      const quotes = db.listPrintQuotes({
        status: query.status || undefined,
        source: query.source || undefined,
        limit: query.limit ? parseInt(query.limit, 10) : 100
      });
      sendJson(res, 200, { quotes });
    } catch (err) {
      console.error('[Quotes] list error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // ========================================================================
  // POST /api/quotes — create quote
  // ========================================================================
  if (req.method === 'POST' && route === '/') {
    try {
      const body = await parseBody(req);
      const quote = db.createPrintQuote(body);

      // If items supplied in body, add them
      if (Array.isArray(body.items) && body.items.length > 0) {
        for (const item of body.items) {
          db.addPrintQuoteItem(quote.id, item);
        }
        // Recompute total
        const items = db.listPrintQuoteItems(quote.id);
        const total = items.reduce((s, i) => s + (i.unit_price_cents * i.qty), 0);
        db.updatePrintQuote(quote.id, { total_cents: total });
      }

      sendJson(res, 201, { quote: db.getPrintQuote(quote.id) });
    } catch (err) {
      console.error('[Quotes] create error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // ========================================================================
  // GET /api/quotes/:id — get quote detail
  // ========================================================================
  if (req.method === 'GET' && quoteIdMatch) {
    const id = parseInt(quoteIdMatch[1], 10);
    try {
      const quote = db.getPrintQuote(id);
      if (!quote) return sendError(res, 404, 'Quote not found'), true;
      const items = db.listPrintQuoteItems(id);
      const plates = db.listPrintQuotePlates(id);
      sendJson(res, 200, { quote, items, plates });
    } catch (err) {
      console.error('[Quotes] get error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // ========================================================================
  // PATCH /api/quotes/:id — update quote fields
  // ========================================================================
  if (req.method === 'PATCH' && quoteIdMatch) {
    const id = parseInt(quoteIdMatch[1], 10);
    try {
      const body = await parseBody(req);
      const updated = db.updatePrintQuote(id, body);
      if (!updated) return sendError(res, 404, 'Quote not found'), true;
      sendJson(res, 200, { quote: updated });
    } catch (err) {
      console.error('[Quotes] update error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // ========================================================================
  // DELETE /api/quotes/:id — delete quote
  // ========================================================================
  if (req.method === 'DELETE' && quoteIdMatch) {
    const id = parseInt(quoteIdMatch[1], 10);
    try {
      db.deletePrintQuote(id);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      console.error('[Quotes] delete error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // ========================================================================
  // GET /api/quotes/:id/items — list items
  // ========================================================================
  if (req.method === 'GET' && quoteItemsMatch) {
    const id = parseInt(quoteItemsMatch[1], 10);
    try {
      sendJson(res, 200, { items: db.listPrintQuoteItems(id) });
    } catch (err) {
      sendError(res, 500, err.message);
    }
    return true;
  }

  // ========================================================================
  // PUT /api/quotes/:id/items — replace all items
  // ========================================================================
  if (req.method === 'PUT' && quoteItemsMatch) {
    const id = parseInt(quoteItemsMatch[1], 10);
    try {
      const body = await parseBody(req);
      const newItems = Array.isArray(body.items) ? body.items : [];
      db.deletePrintQuoteItems(id);
      for (const item of newItems) {
        db.addPrintQuoteItem(id, item);
      }
      const items = db.listPrintQuoteItems(id);
      const total = items.reduce((s, i) => s + (i.unit_price_cents * i.qty), 0);
      db.updatePrintQuote(id, { total_cents: total });
      sendJson(res, 200, { items, total_cents: total });
    } catch (err) {
      console.error('[Quotes] replace items error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // ========================================================================
  // GET /api/quotes/:id/plates — list plates
  // ========================================================================
  if (req.method === 'GET' && quotePlatesMatch) {
    const id = parseInt(quotePlatesMatch[1], 10);
    try {
      sendJson(res, 200, { plates: db.listPrintQuotePlates(id) });
    } catch (err) {
      sendError(res, 500, err.message);
    }
    return true;
  }

  // ========================================================================
  // POST /api/quotes/:id/plates/pack — run bin-packing, save & return plates
  // ========================================================================
  if (req.method === 'POST' && quotePlatesPackMatch) {
    const id = parseInt(quotePlatesPackMatch[1], 10);
    try {
      const body = await parseBody(req);
      const printerModel = body.printerModel || query.printer || 'default';

      // Load items and attach STL catalog rows for footprint estimation
      const items = db.listPrintQuoteItems(id);
      if (!items.length) {
        return sendJson(res, 400, { error: 'No items in quote' }), true;
      }

      // Attach catalog rows for dimension lookups
      for (const item of items) {
        if (item.stl_catalog_id) {
          try { item._stlRow = db.getStlCatalogItem(item.stl_catalog_id); } catch (e) { /* ignore */ }
        }
      }

      const plates = packQuoteItems(items, { printerModel });
      db.upsertPrintQuotePlates(id, plates);
      sendJson(res, 200, { plates: db.listPrintQuotePlates(id) });
    } catch (err) {
      console.error('[Quotes] pack error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // ========================================================================
  // PUT /api/quotes/:id/plates — replace plates (manual rearrange)
  // ========================================================================
  if (req.method === 'PUT' && quotePlatesMatch) {
    const id = parseInt(quotePlatesMatch[1], 10);
    try {
      const body = await parseBody(req);
      const plates = Array.isArray(body.plates) ? body.plates : [];
      db.upsertPrintQuotePlates(id, plates);
      sendJson(res, 200, { plates: db.listPrintQuotePlates(id) });
    } catch (err) {
      console.error('[Quotes] replace plates error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // ========================================================================
  // PATCH /api/quotes/:quoteId/plates/:plateId — update plate (status, printer, gcode)
  // ========================================================================
  if (req.method === 'PATCH' && quotePlateIdMatch) {
    const plateId = parseInt(quotePlateIdMatch[2], 10);
    try {
      const body = await parseBody(req);
      const plate = db.updatePrintQuotePlate(plateId, body);
      if (!plate) return sendError(res, 404, 'Plate not found'), true;
      sendJson(res, 200, { plate });
    } catch (err) {
      console.error('[Quotes] update plate error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  return false;
}

module.exports = { handleQuoteRoute };
