/**
 * Inventory Input Server — AI-powered rapid product entry
 *
 * Routes:
 *   POST /api/inventory-input/analyze       — Gemini Vision: measure size on grid, count colors
 *   POST /api/inventory-input/match-design  — Match photo against design catalog
 *   GET  /api/inventory-input/pricing       — Lookup price by category/size/colors
 *   GET  /api/inventory-input/categories     — List categories + subcategories
 *   POST /api/inventory-input/categories     — Add/update category pricing
 */

const fs = require('fs');
const path = require('path');
const { parseBody, sendJson, sendError } = require('./utils/http');

const ENV_PATH = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(ENV_PATH)) {
  require('dotenv').config({ path: ENV_PATH });
}

function cleanKey(value) {
  if (!value) return '';
  let trimmed = String(value).trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) trimmed = trimmed.slice(1, -1);
  return trimmed;
}

const GEMINI_API_KEY = cleanKey(process.env.GEMINI_API_KEY || '');
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=`;

const ANALYZE_PROMPT = `Analyze this product photo sitting on a self-healing cutting mat. The mat has a printed grid where each small square is exactly 1 inch x 1 inch.

MEASURING INSTRUCTIONS — this is critical, take your time:
1. Find the LEFT edge of the item. Identify the nearest vertical grid line.
2. Find the RIGHT edge of the item. Identify the nearest vertical grid line.
3. Count the number of 1-inch grid squares between those two grid lines. That is the WIDTH in inches.
4. Do the same for the TOP and BOTTOM edges to get the HEIGHT in inches.
5. The grid lines are the thin lines forming the squares — count the spaces between lines, not the lines themselves.
6. If the item extends past a grid line by roughly half a square or more, round up. Otherwise round down.
7. Double-check your count. A common mistake is undercounting the width by 1-2 inches.

Return JSON with these fields:
- widthInches: number (horizontal span in inches, measured by counting grid squares as described above)
- heightInches: number (vertical span in inches, measured by counting grid squares as described above)
- longestDimensionInches: number (the larger of widthInches and heightInches)
- colorCount: number (distinct vinyl/print colors in the design, NOT counting the mat, background, or transfer tape)
- colors: string[] (color names of the design colors only)
- description: string (brief description of the design — what is it a picture of, what text does it contain)
- itemType: string (one of: "vinyl-decal", "heat-transfer", "sticker", "keychain", "magnet", "metal-print", "3d-print", "laser-engrave", "other")
- confidence: number 0-1 (how confident you are in the measurements)

Return ONLY valid JSON, no markdown fences.`;

const MATCH_PROMPT = `You are comparing a product photo against a set of catalog design thumbnails.

The first image is the product to match. The remaining images are numbered catalog candidates.

For each candidate, assess similarity to the product design. Consider:
- Overall design shape and composition
- Text content (must match exactly if present)
- Color palette and style
- Subject matter

Return JSON:
- matchIndex: number (1-based index of best match, or 0 if none match well)
- confidence: number 0-1
- reason: string (brief explanation)

Return ONLY valid JSON, no markdown fences.`;

async function callGemini(parts, { thinking = false } = {}) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');

  const url = GEMINI_URL + GEMINI_API_KEY;
  const body = {
    contents: [{ parts }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: thinking ? 4096 : 1024,
      thinkingConfig: { thinkingBudget: thinking ? 2048 : 0 }
    }
  };

  const timeoutMs = thinking ? 60000 : 30000;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Gemini API ${resp.status}: ${errText.substring(0, 200)}`);
  }

  const data = await resp.json();
  const respParts = data.candidates?.[0]?.content?.parts || [];
  let text = respParts.filter(p => p.text && !p.thought).map(p => p.text).join('\n');
  if (!text) text = respParts.map(p => p.text || '').join('\n');
  if (!text) throw new Error('No text in Gemini response');
  return text;
}

function parseJsonResponse(text) {
  // Strip markdown fences if present
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  }
  return JSON.parse(cleaned);
}

// Standard print sizes — snap raw measurements to the closest match
const PRINT_SIZES = [
  [5, 7], [8, 10], [11, 14], [11, 17]
];

function snapToNearestSize(rawW, rawH) {
  // Ensure w <= h for comparison (portrait orientation)
  const [short, long] = rawW <= rawH ? [rawW, rawH] : [rawH, rawW];
  let best = null;
  let bestDist = Infinity;
  for (const [sw, lw] of PRINT_SIZES) {
    const dist = Math.abs(short - sw) + Math.abs(long - lw);
    if (dist < bestDist) {
      bestDist = dist;
      best = [sw, lw];
    }
  }
  // Return in original orientation
  if (rawW <= rawH) return { width: best[0], height: best[1] };
  return { width: best[1], height: best[0] };
}

async function handleInventoryInputRoute(pathname, req, res, db) {
  const method = req.method;

  // POST /api/inventory-input/analyze
  if (pathname === '/api/inventory-input/analyze' && method === 'POST') {
    const body = await parseBody(req);
    const { imageBase64, mimeType } = body;
    if (!imageBase64) return sendError(res, 400, 'imageBase64 required');

    const parts = [
      { inlineData: { mimeType: mimeType || 'image/jpeg', data: imageBase64 } },
      { text: ANALYZE_PROMPT }
    ];

    const text = await callGemini(parts, { thinking: true });
    const result = parseJsonResponse(text);

    console.log(`[Inventory Input] Analysis: ${result.widthInches}x${result.heightInches}" | ${result.colorCount} colors, type: ${result.itemType}, confidence: ${result.confidence}`);
    return sendJson(res, 200, { ok: true, analysis: result });
  }

  // POST /api/inventory-input/match-design
  if (pathname === '/api/inventory-input/match-design' && method === 'POST') {
    const body = await parseBody(req);
    const { imageBase64, mimeType, candidates } = body;
    // candidates: [{ id, name, thumbnailBase64, mimeType }]
    if (!imageBase64) return sendError(res, 400, 'imageBase64 required');
    if (!candidates || !candidates.length) return sendJson(res, 200, { ok: true, matched: false, reason: 'No candidates provided' });

    const parts = [
      { inlineData: { mimeType: mimeType || 'image/jpeg', data: imageBase64 } },
      { text: 'This is the product photo to match. Below are the catalog candidates:' }
    ];

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      parts.push({ text: `Candidate ${i + 1}: "${c.name}"` });
      if (c.thumbnailBase64) {
        parts.push({ inlineData: { mimeType: c.mimeType || 'image/jpeg', data: c.thumbnailBase64 } });
      }
    }

    parts.push({ text: MATCH_PROMPT });

    const text = await callGemini(parts);
    const result = parseJsonResponse(text);

    if (result.matchIndex > 0 && result.matchIndex <= candidates.length) {
      const matched = candidates[result.matchIndex - 1];
      return sendJson(res, 200, {
        ok: true,
        matched: true,
        designId: matched.id,
        designName: matched.name,
        confidence: result.confidence,
        reason: result.reason
      });
    }

    return sendJson(res, 200, { ok: true, matched: false, confidence: result.confidence, reason: result.reason });
  }

  // GET /api/inventory-input/pricing?category=&subcategory=&size=&colorCount=
  if (pathname === '/api/inventory-input/pricing' && method === 'GET') {
    const url = new URL(req.url, 'http://localhost');
    const category = url.searchParams.get('category') || '';
    const subcategory = url.searchParams.get('subcategory') || '';
    const size = parseFloat(url.searchParams.get('size') || '0');
    const colorCount = parseInt(url.searchParams.get('colorCount') || '1', 10);

    // Decals/stickers/heat transfer use the sticker price table
    const isDecal = /decal|sticker|vinyl|heat.?transfer|bumper/i.test(category);
    const effectiveSize = size > 0 ? size : parseFloat(subcategory) || parseFloat(url.searchParams.get('printSize') || '') || 0;
    if (isDecal && effectiveSize > 0) {
      const priceCents = db.calculateStickerPrice(effectiveSize, colorCount);
      return sendJson(res, 200, { ok: true, found: true, priceCents, source: 'sticker_price_table' });
    }

    // Other categories use category_pricing table
    const printSize = url.searchParams.get('printSize') || ''; // e.g. "11x14"

    // Try exact subcategory first
    const pricing = db.getCategoryPricing(category, subcategory);
    if (pricing) {
      return sendJson(res, 200, { ok: true, found: true, priceCents: pricing.base_price_cents, source: 'category_pricing' });
    }

    // Try print size as subcategory (e.g. Metal Prints → 11x14)
    if (printSize) {
      const sizePricing = db.getCategoryPricing(category, printSize);
      if (sizePricing) {
        return sendJson(res, 200, { ok: true, found: true, priceCents: sizePricing.base_price_cents, source: 'category_pricing_size' });
      }
    }

    // Try without subcategory
    if (subcategory || printSize) {
      const fallback = db.getCategoryPricing(category, '');
      if (fallback) {
        return sendJson(res, 200, { ok: true, found: true, priceCents: fallback.base_price_cents, source: 'category_pricing_fallback' });
      }
    }

    return sendJson(res, 200, { ok: true, found: false });
  }

  // GET /api/inventory-input/categories
  if (pathname === '/api/inventory-input/categories' && method === 'GET') {
    const pricing = db.listCategoryPricing();
    // Also get existing qr_products categories
    const existingDb = db.getDb();
    const productCats = existingDb.prepare(`
      SELECT DISTINCT category, subcategory FROM qr_products WHERE category != '' ORDER BY category, subcategory
    `).all();

    // Merge
    const catMap = {};
    for (const p of pricing) {
      if (!catMap[p.category]) catMap[p.category] = { subcategories: [], hasPricing: true };
      if (p.subcategory) catMap[p.category].subcategories.push({ name: p.subcategory, priceCents: p.base_price_cents });
      else catMap[p.category].basePriceCents = p.base_price_cents;
    }
    for (const row of productCats) {
      if (!catMap[row.category]) catMap[row.category] = { subcategories: [], hasPricing: false };
      if (row.subcategory && !catMap[row.category].subcategories.find(s => s.name === row.subcategory)) {
        catMap[row.category].subcategories.push({ name: row.subcategory });
      }
    }

    // Add built-in sticker/decal categories (priced via STICKER_PRICE_TABLE)
    for (const name of ['Decals', 'Bumper Stickers', 'Heat Transfer Decals']) {
      if (!catMap[name]) catMap[name] = { subcategories: [], hasPricing: true, builtIn: true };
    }

    const categories = Object.entries(catMap).map(([name, data]) => ({ name, ...data })).sort((a, b) => a.name.localeCompare(b.name));
    return sendJson(res, 200, { ok: true, categories });
  }

  // POST /api/inventory-input/categories
  if (pathname === '/api/inventory-input/categories' && method === 'POST') {
    const body = await parseBody(req);
    const { category, subcategory, basePriceCents } = body;
    if (!category) return sendError(res, 400, 'category required');
    if (typeof basePriceCents !== 'number' || basePriceCents < 0) return sendError(res, 400, 'basePriceCents required (number >= 0)');

    const result = db.upsertCategoryPricing(category, subcategory || '', basePriceCents);
    return sendJson(res, 200, { ok: true, pricing: result });
  }

  return sendError(res, 404, `Unknown inventory-input route: ${pathname}`);
}

module.exports = { handleInventoryInputRoute };
