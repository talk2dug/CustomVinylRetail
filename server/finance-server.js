const fs = require('fs');
const path = require('path');
const url = require('url');
const { parseBody, sendJson, sendError } = require('./utils/http');

const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'finance-uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

async function handleFinanceRoute(pathname, req, res, db) {
  const basePath = '/api/finance';
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

  // ========== DASHBOARD ==========
  if (req.method === 'GET' && route === '/dashboard') {
    try {
      const data = db.getFinDashboard();
      sendJson(res, 200, data);
    } catch (err) {
      console.error('[Finance] Dashboard error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // ========== EXPENSES ==========
  // GET /api/finance/expenses/categories
  if (req.method === 'GET' && route === '/expenses/categories') {
    try {
      sendJson(res, 200, { categories: db.listFinExpenseCategories() });
    } catch (err) { sendError(res, 500, err.message); }
    return true;
  }

  // GET /api/finance/expenses
  if (req.method === 'GET' && route === '/expenses') {
    try {
      const items = db.listFinExpenses({
        category: query.category || undefined,
        from: query.from || undefined,
        to: query.to || undefined,
        search: query.search || undefined,
        limit: query.limit ? parseInt(query.limit) : 50,
        offset: query.offset ? parseInt(query.offset) : 0
      });
      sendJson(res, 200, { items });
    } catch (err) { sendError(res, 500, err.message); }
    return true;
  }

  // GET /api/finance/expenses/:id
  const expenseGet = route.match(/^\/expenses\/([a-f0-9-]+)$/);
  if (req.method === 'GET' && expenseGet) {
    const item = db.getFinExpense(expenseGet[1]);
    if (!item) return sendError(res, 404, 'Expense not found'), true;
    sendJson(res, 200, item);
    return true;
  }

  // POST /api/finance/expenses
  if (req.method === 'POST' && route === '/expenses') {
    try {
      const body = await parseBody(req);
      if (!body.date || !body.category || !body.description || body.amount_cents === undefined) {
        return sendError(res, 400, 'date, category, description, and amount_cents are required'), true;
      }
      const item = db.createFinExpense(body);
      sendJson(res, 201, item);
    } catch (err) { sendError(res, 500, err.message); }
    return true;
  }

  // PATCH /api/finance/expenses/:id
  const expensePatch = route.match(/^\/expenses\/([a-f0-9-]+)$/);
  if (req.method === 'PATCH' && expensePatch) {
    try {
      const body = await parseBody(req);
      const item = db.updateFinExpense(expensePatch[1], body);
      if (!item) return sendError(res, 404, 'Expense not found'), true;
      sendJson(res, 200, item);
    } catch (err) { sendError(res, 500, err.message); }
    return true;
  }

  // DELETE /api/finance/expenses/:id
  const expenseDel = route.match(/^\/expenses\/([a-f0-9-]+)$/);
  if (req.method === 'DELETE' && expenseDel) {
    try {
      db.deleteFinExpense(expenseDel[1]);
      sendJson(res, 200, { ok: true });
    } catch (err) { sendError(res, 500, err.message); }
    return true;
  }

  // ========== PLANNED PURCHASES ==========
  if (req.method === 'GET' && route === '/planned') {
    try {
      const items = db.listFinPlanned({
        status: query.status || undefined,
        priority: query.priority || undefined,
        sort: query.sort || undefined
      });
      sendJson(res, 200, { items });
    } catch (err) { sendError(res, 500, err.message); }
    return true;
  }

  const plannedGet = route.match(/^\/planned\/([a-f0-9-]+)$/);
  if (req.method === 'GET' && plannedGet) {
    const item = db.getFinPlanned(plannedGet[1]);
    if (!item) return sendError(res, 404, 'Not found'), true;
    sendJson(res, 200, item);
    return true;
  }

  if (req.method === 'POST' && route === '/planned') {
    try {
      const body = await parseBody(req);
      if (!body.name) return sendError(res, 400, 'name is required'), true;
      const item = db.createFinPlanned(body);
      sendJson(res, 201, item);
    } catch (err) { sendError(res, 500, err.message); }
    return true;
  }

  const plannedPatch = route.match(/^\/planned\/([a-f0-9-]+)$/);
  if (req.method === 'PATCH' && plannedPatch) {
    try {
      const body = await parseBody(req);
      const item = db.updateFinPlanned(plannedPatch[1], body);
      if (!item) return sendError(res, 404, 'Not found'), true;
      sendJson(res, 200, item);
    } catch (err) { sendError(res, 500, err.message); }
    return true;
  }

  const plannedDel = route.match(/^\/planned\/([a-f0-9-]+)$/);
  if (req.method === 'DELETE' && plannedDel) {
    try {
      db.deleteFinPlanned(plannedDel[1]);
      sendJson(res, 200, { ok: true });
    } catch (err) { sendError(res, 500, err.message); }
    return true;
  }

  // POST /api/finance/planned/:id/purchase — Convert to expense
  const plannedPurchase = route.match(/^\/planned\/([a-f0-9-]+)\/purchase$/);
  if (req.method === 'POST' && plannedPurchase) {
    try {
      const body = await parseBody(req);
      const planned = db.getFinPlanned(plannedPurchase[1]);
      if (!planned) return sendError(res, 404, 'Not found'), true;
      // Create expense from planned purchase
      const expense = db.createFinExpense({
        date: body.date || new Date().toISOString().slice(0, 10),
        category: planned.category || 'Equipment',
        vendor: body.vendor || null,
        description: planned.name,
        amount_cents: body.actual_cost_cents || planned.estimated_cost_cents || 0,
        payment_method: body.payment_method || null,
        notes: `Converted from planned purchase: ${planned.name}`
      });
      // Update planned item
      db.updateFinPlanned(plannedPurchase[1], {
        status: 'purchased',
        purchased_date: body.date || new Date().toISOString().slice(0, 10),
        actual_cost_cents: body.actual_cost_cents || planned.estimated_cost_cents,
        expense_id: expense.id
      });
      sendJson(res, 200, { expense, planned: db.getFinPlanned(plannedPurchase[1]) });
    } catch (err) { sendError(res, 500, err.message); }
    return true;
  }

  // ========== EQUIPMENT ==========
  if (req.method === 'GET' && route === '/equipment') {
    try {
      const items = db.listFinEquipment({
        category: query.category || undefined,
        status: query.status || undefined
      });
      sendJson(res, 200, { items });
    } catch (err) { sendError(res, 500, err.message); }
    return true;
  }

  const equipGet = route.match(/^\/equipment\/([a-f0-9-]+)$/);
  if (req.method === 'GET' && equipGet) {
    const item = db.getFinEquipment(equipGet[1]);
    if (!item) return sendError(res, 404, 'Not found'), true;
    const maintenance = db.listFinMaintenance(equipGet[1]);
    sendJson(res, 200, { ...item, maintenance });
    return true;
  }

  if (req.method === 'POST' && route === '/equipment') {
    try {
      const body = await parseBody(req);
      if (!body.name) return sendError(res, 400, 'name is required'), true;
      const item = db.createFinEquipment(body);
      sendJson(res, 201, item);
    } catch (err) { sendError(res, 500, err.message); }
    return true;
  }

  const equipPatch = route.match(/^\/equipment\/([a-f0-9-]+)$/);
  if (req.method === 'PATCH' && equipPatch) {
    try {
      const body = await parseBody(req);
      const item = db.updateFinEquipment(equipPatch[1], body);
      if (!item) return sendError(res, 404, 'Not found'), true;
      sendJson(res, 200, item);
    } catch (err) { sendError(res, 500, err.message); }
    return true;
  }

  const equipDel = route.match(/^\/equipment\/([a-f0-9-]+)$/);
  if (req.method === 'DELETE' && equipDel) {
    try {
      db.deleteFinEquipment(equipDel[1]);
      sendJson(res, 200, { ok: true });
    } catch (err) { sendError(res, 500, err.message); }
    return true;
  }

  // Equipment Maintenance
  const maintList = route.match(/^\/equipment\/([a-f0-9-]+)\/maintenance$/);
  if (req.method === 'GET' && maintList) {
    try {
      sendJson(res, 200, { items: db.listFinMaintenance(maintList[1]) });
    } catch (err) { sendError(res, 500, err.message); }
    return true;
  }

  const maintCreate = route.match(/^\/equipment\/([a-f0-9-]+)\/maintenance$/);
  if (req.method === 'POST' && maintCreate) {
    try {
      const body = await parseBody(req);
      if (!body.date || !body.type) return sendError(res, 400, 'date and type are required'), true;
      const item = db.createFinMaintenance(maintCreate[1], body);
      sendJson(res, 201, item);
    } catch (err) { sendError(res, 500, err.message); }
    return true;
  }

  const maintDel = route.match(/^\/equipment\/maintenance\/([a-f0-9-]+)$/);
  if (req.method === 'DELETE' && maintDel) {
    try {
      db.deleteFinMaintenance(maintDel[1]);
      sendJson(res, 200, { ok: true });
    } catch (err) { sendError(res, 500, err.message); }
    return true;
  }

  // ========== INVENTORY ==========
  if (req.method === 'GET' && route === '/inventory') {
    try {
      const items = db.listFinInventory({
        category: query.category || undefined,
        search: query.search || undefined,
        low_stock: query.low_stock === '1' || query.low_stock === 'true'
      });
      sendJson(res, 200, { items });
    } catch (err) { sendError(res, 500, err.message); }
    return true;
  }

  const invGet = route.match(/^\/inventory\/([a-f0-9-]+)$/);
  if (req.method === 'GET' && invGet) {
    const item = db.getFinInventoryItem(invGet[1]);
    if (!item) return sendError(res, 404, 'Not found'), true;
    sendJson(res, 200, item);
    return true;
  }

  if (req.method === 'POST' && route === '/inventory') {
    try {
      const body = await parseBody(req);
      if (!body.name) return sendError(res, 400, 'name is required'), true;
      const item = db.createFinInventoryItem(body);
      sendJson(res, 201, item);
    } catch (err) { sendError(res, 500, err.message); }
    return true;
  }

  const invPatch = route.match(/^\/inventory\/([a-f0-9-]+)$/);
  if (req.method === 'PATCH' && invPatch) {
    try {
      const body = await parseBody(req);
      const item = db.updateFinInventoryItem(invPatch[1], body);
      if (!item) return sendError(res, 404, 'Not found'), true;
      sendJson(res, 200, item);
    } catch (err) { sendError(res, 500, err.message); }
    return true;
  }

  const invDel = route.match(/^\/inventory\/([a-f0-9-]+)$/);
  if (req.method === 'DELETE' && invDel) {
    try {
      db.deleteFinInventoryItem(invDel[1]);
      sendJson(res, 200, { ok: true });
    } catch (err) { sendError(res, 500, err.message); }
    return true;
  }

  // PATCH /api/finance/inventory/:id/adjust — adjust quantity
  const invAdjust = route.match(/^\/inventory\/([a-f0-9-]+)\/adjust$/);
  if (req.method === 'PATCH' && invAdjust) {
    try {
      const body = await parseBody(req);
      if (body.delta === undefined) return sendError(res, 400, 'delta is required'), true;
      const item = db.adjustFinInventoryQty(invAdjust[1], body.delta);
      if (!item) return sendError(res, 404, 'Not found'), true;
      sendJson(res, 200, item);
    } catch (err) { sendError(res, 500, err.message); }
    return true;
  }

  // POST /api/finance/inventory/:id/weigh — update vinyl roll weight
  const invWeigh = route.match(/^\/inventory\/([a-f0-9-]+)\/weigh$/);
  if (req.method === 'POST' && invWeigh) {
    try {
      const body = await parseBody(req);
      if (body.weight_grams === undefined) return sendError(res, 400, 'weight_grams is required'), true;
      const result = db.weighFinVinylRoll(invWeigh[1], body.weight_grams);
      if (!result) return sendError(res, 404, 'Not found'), true;
      sendJson(res, 200, result);
    } catch (err) { sendError(res, 500, err.message); }
    return true;
  }

  // POST /api/finance/inventory/:id/photo — upload swatch photo
  const invPhoto = route.match(/^\/inventory\/([a-f0-9-]+)\/photo$/);
  if (req.method === 'POST' && invPhoto) {
    try {
      const chunks = [];
      await new Promise((resolve, reject) => {
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', resolve);
        req.on('error', reject);
      });
      const buffer = Buffer.concat(chunks);

      // Extract boundary from content-type
      const contentType = req.headers['content-type'] || '';
      if (contentType.includes('multipart/form-data')) {
        // Simple multipart parsing for single file
        const boundary = contentType.split('boundary=')[1];
        if (!boundary) return sendError(res, 400, 'Missing boundary'), true;
        const parts = buffer.toString('binary').split('--' + boundary);
        for (const part of parts) {
          const filenameMatch = part.match(/filename="([^"]+)"/);
          if (filenameMatch) {
            const ext = path.extname(filenameMatch[1]).toLowerCase() || '.jpg';
            const filename = `${invPhoto[1]}${ext}`;
            const headerEnd = part.indexOf('\r\n\r\n');
            const fileData = Buffer.from(part.slice(headerEnd + 4, part.lastIndexOf('\r\n')), 'binary');
            fs.writeFileSync(path.join(UPLOAD_DIR, filename), fileData);
            const imageUrl = `/api/finance/uploads/${filename}`;
            db.updateFinInventoryItem(invPhoto[1], { image_url: imageUrl });
            return sendJson(res, 200, { image_url: imageUrl }), true;
          }
        }
        return sendError(res, 400, 'No file in upload'), true;
      } else {
        // Raw image upload
        const ext = contentType.includes('png') ? '.png' : contentType.includes('webp') ? '.webp' : '.jpg';
        const filename = `${invPhoto[1]}${ext}`;
        fs.writeFileSync(path.join(UPLOAD_DIR, filename), buffer);
        const imageUrl = `/api/finance/uploads/${filename}`;
        db.updateFinInventoryItem(invPhoto[1], { image_url: imageUrl });
        sendJson(res, 200, { image_url: imageUrl });
      }
    } catch (err) { sendError(res, 500, err.message); }
    return true;
  }

  // GET /api/finance/uploads/:filename — serve uploaded images
  const uploadServe = route.match(/^\/uploads\/(.+)$/);
  if (req.method === 'GET' && uploadServe) {
    const filePath = path.join(UPLOAD_DIR, uploadServe[1]);
    if (!filePath.startsWith(UPLOAD_DIR)) return sendError(res, 403, 'Invalid path'), true;
    if (!fs.existsSync(filePath)) return sendError(res, 404, 'File not found'), true;
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
    const mime = mimeTypes[ext] || 'application/octet-stream';
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': data.length, 'Cache-Control': 'public, max-age=86400' });
    res.end(data);
    return true;
  }

  return false;
}

module.exports = { handleFinanceRoute };
