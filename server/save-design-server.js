const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const os = require('os');
const { execFile } = require('child_process');
const zlib = require('zlib');
const { formidable } = require('formidable');
let sharp = null;
try {
  sharp = require('sharp');
} catch (error) {
  console.warn('sharp module not available; image resizing will be disabled.');
}

const ENV_PATH = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(ENV_PATH)) {
  require('dotenv').config({ path: ENV_PATH });
}

const db = require('./db');
const { sendAccountEmail } = require('./mailer');
const sms = require('./sms');
const { SquareClient, SquareEnvironment } = require('square');
const { loadApparelCatalog } = require('./apparel-catalog');
const ssaw = require('./vendor-ssaw');
const { sendOrdersEmail } = require('./mailer');
// Marketing integrations
const shopify = require('./integrations/shopify');
const ads = require('./integrations/ads');
const { classifyMarketingProfile } = require('./utils/classifier');
const metalPrints = require('./metal-prints-server');
const { handleLeonardoRoute } = require('./leonardo-server');
const { generateCategoryMetadata, updateCatalogMetadata } = require('./catalog-metadata-generator');
const { runCategoryOcr, updateCatalogWithOcr, getCategoryItems: getOcrCategoryItems, findCategoryDirectory } = require('./catalog-ocr-generator');
const { describeCatalogDesign } = require('../scripts/claude-describe');
const stickerSheets = require('./sticker-sheet-generator');
const taskTracker = require('./task-tracker');
// Shared utilities
const { slugify, escapeHtml, sanitizeUrl } = require('./utils/string');
const { sendJson, handleOptions } = require('./utils/http');

function parseMarketingTags(rawTags) {
  try {
    // Shopify REST product.tags is a comma-separated string; GraphQL may send an array
    const list = Array.isArray(rawTags)
      ? rawTags
      : typeof rawTags === 'string'
      ? rawTags.split(',').map((t) => t.trim()).filter(Boolean)
      : [];
    const profile = {};
    for (const tag of list) {
      if (!/^marketing:/i.test(tag)) continue;
      const body = tag.replace(/^marketing:/i, '');
      const eq = body.indexOf('=');
      const keyRaw = eq >= 0 ? body.slice(0, eq).trim() : body.trim();
      const valRaw = eq >= 0 ? body.slice(eq + 1).trim() : '';
      const key = keyRaw.toLowerCase();
      const value = valRaw;
      if (!key) continue;
      const setStr = (k, v) => { if (v) profile[k] = v; };
      const setList = (k, v) => {
        const parts = String(v || '').split(/[|;,]+/).map((s) => s.trim()).filter(Boolean);
        if (parts.length) profile[k] = parts;
      };
      if (key === 'audience_segment') setStr('audience_segment', value);
      else if (key === 'tone') setStr('tone', value);
      else if (key === 'generation') setStr('generation', value);
      else if (key === 'template' || key === 'ad_template') setStr('ad_template', value);
      else if (key === 'audience_id' || key === 'ad_audience_id') setStr('ad_audience_id', value);
      else if (key === 'campaign_priority') {
        const n = Number(value); if (Number.isFinite(n)) profile.campaign_priority = Math.round(n);
      }
      else if (key === 'interests') setList('interests', value);
      else if (key === 'keywords') setList('keywords', value);
    }
    return profile;
  } catch (_) {
    return {};
  }
}

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
const HOST = process.env.HOST || process.env.BIND_ADDRESS || '0.0.0.0';
const APP_ROOT = path.resolve(__dirname, '..');

// Use LIBRARY_ROOT if it exists and is accessible, otherwise fall back to APP_ROOT
let LIBRARY_ROOT = APP_ROOT;
if (process.env.LIBRARY_ROOT) {
  try {
    const candidatePath = path.resolve(process.env.LIBRARY_ROOT);
    const parentDir = path.dirname(candidatePath);
    if (fs.existsSync(parentDir)) {
      LIBRARY_ROOT = candidatePath;
    } else {
      console.warn(`LIBRARY_ROOT path ${candidatePath} is not accessible, using local APP_ROOT instead`);
    }
  } catch (error) {
    console.warn(`Invalid LIBRARY_ROOT path, using local APP_ROOT instead:`, error.message);
  }
}

const LIBRARY_WEB_DIR = path.join(LIBRARY_ROOT, 'web');
const WEB_DIR = fs.existsSync(LIBRARY_WEB_DIR) ? LIBRARY_WEB_DIR : path.join(APP_ROOT, 'web');
const DATA_DIR = path.join(LIBRARY_ROOT, 'data');
const OUTPUT_DIR = path.join(LIBRARY_ROOT, 'saved-designs');
const RACE_QUOTE_FILES_DIR = path.join(DATA_DIR, 'race-quote-files');
const PRODUCT_IMAGES_DIR = path.join(APP_ROOT, 'ProductImages');
const CAMPAIGNS_DIR = path.join(DATA_DIR, 'campaigns');
const PRICING_FILE = path.join(DATA_DIR, 'pricing.json');
const PRICING_FALLBACK = path.join(__dirname, 'data', 'pricing.json');
const EXPORT_STATE_DIR = path.join(DATA_DIR, 'export-jobs');
const SHOPIFY_TEST_CARTS_FILE = path.join(DATA_DIR, 'shopify-cart-webhooks.json');
const MAX_BODY_SIZE = 100 * 1024 * 1024; // 100 MB (campaigns with many items can be large)
const CUSTOMER_PORTAL_URL =
  process.env.CUSTOMER_PORTAL_URL || 'http://208.113.130.237:8000/web/customer.html';
const EMAIL_LOG_ENABLED = process.env.DISABLE_EMAIL_LOG === '1' ? false : true;

const HTTPS_KEY_PATH = process.env.HTTPS_KEY_PATH || process.env.SSL_KEY_PATH || null;
const HTTPS_CERT_PATH = process.env.HTTPS_CERT_PATH || process.env.SSL_CERT_PATH || null;
const HTTPS_CA_PATH = process.env.HTTPS_CA_PATH || process.env.SSL_CA_PATH || null;
const HTTPS_PASSPHRASE = process.env.HTTPS_PASSPHRASE || null;

let httpsOptions = null;
if (HTTPS_KEY_PATH && HTTPS_CERT_PATH) {
  try {
    httpsOptions = {
      key: fs.readFileSync(HTTPS_KEY_PATH, 'utf8'),
      cert: fs.readFileSync(HTTPS_CERT_PATH, 'utf8')
    };
    if (HTTPS_CA_PATH) {
      httpsOptions.ca = fs.readFileSync(HTTPS_CA_PATH, 'utf8');
    }
    if (HTTPS_PASSPHRASE) {
      httpsOptions.passphrase = HTTPS_PASSPHRASE;
    }
  } catch (error) {
    console.error('Unable to load HTTPS certificates:', error.message);
    httpsOptions = null;
  }
}

const readFileSafe = (filePath) => {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    return null;
  }
};

/**
 * Add black background to images that are predominantly white/light
 * Only applies to images with transparency where the content is mostly white
 * @param {string} imagePath - Path to the image file
 * @returns {Promise<{path: string, needsCleanup: boolean}>} - Path to processed image
 */
async function addBlackBackgroundIfNeeded(imagePath) {
  if (!sharp) {
    console.warn('[addBlackBackground] Sharp not available, returning original');
    return { path: imagePath, needsCleanup: false };
  }

  try {
    const metadata = await sharp(imagePath).metadata();

    // Check if image has alpha channel (transparency)
    const hasAlpha = metadata.hasAlpha;

    if (!hasAlpha) {
      // No transparency, return original
      return { path: imagePath, needsCleanup: false };
    }

    // Check if image is predominantly white/light by analyzing the dominant color
    const { dominant } = await sharp(imagePath).stats();
    const avgBrightness = (dominant.r + dominant.g + dominant.b) / 3;

    // Only add black background if image is predominantly light/white (brightness > 200)
    if (avgBrightness <= 200) {
      console.log(`[addBlackBackground] Image is not predominantly white (brightness: ${avgBrightness.toFixed(0)}), keeping original: ${path.basename(imagePath)}`);
      return { path: imagePath, needsCleanup: false };
    }

    console.log(`[addBlackBackground] Image is predominantly white (brightness: ${avgBrightness.toFixed(0)}), adding black background: ${path.basename(imagePath)}`);

    // Create a black background and composite the image on top
    const { width, height } = metadata;
    const processedBuffer = await sharp({
      create: {
        width: width,
        height: height,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 1 }
      }
    })
    .composite([{ input: imagePath }])
    .png()
    .toBuffer();

    // Save to a temporary file
    const tempPath = path.join(os.tmpdir(), `bg-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
    fs.writeFileSync(tempPath, processedBuffer);

    console.log(`[addBlackBackground] Created temp file with black background: ${tempPath}`);
    return { path: tempPath, needsCleanup: true };
  } catch (error) {
    console.error(`[addBlackBackground] Error processing image: ${error.message}`);
    return { path: imagePath, needsCleanup: false };
  }
}

function getAdminSmsRecipients() {
  return sms.parseRecipientList(process.env.SMS_ADMIN_RECIPIENTS || '');
}

function truncateSmsBody(value) {
  if (!value) return '';
  const text = String(value).trim();
  if (text.length <= 320) {
    return text;
  }
  return `${text.slice(0, 319)}…`;
}

function broadcastAdminSms(body) {
  try {
    if (!sms.isConfigured()) return;
    const recipients = getAdminSmsRecipients();
    if (!recipients.length) return;
    const message = truncateSmsBody(body);
    if (!message) return;
    recipients.forEach((recipient) => {
      sms
        .sendSms({ to: recipient, body: message })
        .catch((error) => console.error('Admin SMS failed:', error?.message || error));
    });
  } catch (error) {
    console.warn('SMS broadcast skipped:', error?.message || error);
  }
}

function notifyAdminsOfNewOrder(order) {
  if (!order ) return;
  const orderLabel = order.orderNumber ? `#${order.orderNumber}` : order.id;
  const customerName =
    order.customer?.name?.trim() ||
    order.customer?.email?.trim() ||
    order.customer?.phone?.trim() ||
    '';
  const quantity =
    Number.isFinite(Number(order.quantity))
      ? Number(order.quantity)
      : Number(order.pricing?.quantity) || null;
  const descriptor =
    order.pricing?.descriptor ||
    order.designName ||
    order.designId ||
    (order.category ? `${order.category} order` : 'Sticker order');

  const parts = [`New order ${orderLabel}`];
  if (customerName) {
    parts.push(`for ${customerName}`);
  }
  if (quantity) {
    parts.push(`qty ${quantity}`);
  }
  parts.push(descriptor);
  const message = parts.filter(Boolean).join(' · ');
  broadcastAdminSms(message);
}

function notifyAdminsOfRaceQuote(quote) {
  if (!quote ) return;
  const quoteLabel = quote.quoteNumber ? `#${quote.quoteNumber}` : quote.id;
  const business = quote.business || 'Race quote';
  const contact = quote.contactName || '';
  const packageLabel = quote.packageOption ? quote.packageOption.replace(/_/g, ' ') : '';
  const parts = [`New race quote ${quoteLabel}`, business];
  if (contact) {
    parts.push(contact);
  }
  if (packageLabel) {
    parts.push(`Package: ${packageLabel}`);
  }
  broadcastAdminSms(parts.filter(Boolean).join(' · '));
}

function safeSendCustomerSms(to, body) {
  try {
    if (!sms.isConfigured()) return;
    if (!to || !String(body || '').trim()) return;
    sms.sendSms({ to, body: String(body) }).catch((e) =>
      console.warn('Customer SMS failed:', e?.message || e)
    );
  } catch (_) {}
}

function notifyCustomerOfNewOrder({ orderNumber, customer }) {
  if (!customer) return;
  const to = (customer.phone || '').trim();
  const want = customer.smsOptIn === true || customer.sms_opt_in === true; // payload support
  if (!to || !want) return;
  const link = CUSTOMER_PORTAL_URL;
  const msg = `Thanks! We received your order #${orderNumber}. You can view and pay from your portal: ${link}`;
  safeSendCustomerSms(to, msg);
}

function notifyCustomerOfPaymentLink({ customer, url, count, orderNumber }) {
  if (!customer) return;
  const to = (customer.phone || '').trim();
  const want = customer.smsOptIn === true || customer.sms_opt_in === true; // payload support
  if (!to || !want || !url) return;
  const n = Number(count || 0);
  const header = n > 1 ? `${n} orders` : `order #${orderNumber || ''}`.trim();
  const msg = `Your ${header} is ready to pay: ${url}`;
  safeSendCustomerSms(to, msg);
}

function getRacePackageLabel(value) {
  if (!value) return 'Race package';
  const key = String(value || '').toLowerCase();
  return RACE_PACKAGE_OPTIONS[key]?.label || value.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatRaceAddonLabel(value) {
  if (!value) return '';
  return value
    .split(/[-_]/g)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

function normalizeSponsorEntries(entries) {
  if (!Array.isArray(entries)) return [];
  const allowedSizes = new Set(['small', 'medium', 'large']);
  return entries
    .map((entry) => {
      const name = sanitizeCopy(entry?.name || '', 80);
      if (!name) return null;
      let size = String(entry?.size || '').toLowerCase();
      if (!allowedSizes.has(size)) size = 'medium';
      const color = sanitizeCopy(entry?.color || '', 40);
      const apparel = Boolean(entry?.apparel || entry?.includeApparel);
      return { name, size, color, apparel };
    })
    .filter(Boolean)
    .slice(0, 10);
}

// sanitizeUrl and escapeHtml are now imported from ./utils/string

function getShopifyStorefrontBase() {
  const raw = (process.env.SHOPIFY_STOREFRONT_URL || process.env.SHOPIFY_SHOP || '').trim();
  if (!raw) return '';
  const base = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return base.replace(/\/$/, '');
}

function sanitizeApparelItems(items) {
  if (!Array.isArray(items)) return [];
  const sanitized = [];
  for (const entry of items) {
    const sku = sanitizeCopy(entry?.sku || '', 80);
    const quantityRaw = Number(entry?.quantity);
    if (!sku) continue;
    if (!Number.isFinite(quantityRaw) || quantityRaw <= 0) continue;
    const quantity = Math.min(500, Math.max(1, Math.round(quantityRaw)));
    const handle = sanitizeCopy(entry?.handle || '', 80) || null;
    const title = sanitizeCopy(entry?.title || '', 160) || null;
    const vendor = sanitizeCopy(entry?.vendor || '', 80) || null;
    const productType = sanitizeCopy(entry?.productType || '', 40) || null;
    const style = sanitizeCopy(entry?.style || '', 40) || null;
    const color = sanitizeCopy(entry?.color || '', 60) || null;
    const size = sanitizeCopy(entry?.size || '', 40) || null;
    const unitPriceCents = Number.isFinite(entry?.unitPriceCents)
      ? Math.round(entry.unitPriceCents)
      : null;
    const lineTotalCents = Number.isFinite(entry?.lineTotalCents)
      ? Math.round(entry.lineTotalCents)
      : unitPriceCents
      ? unitPriceCents * quantity
      : null;
    sanitized.push({
      sku,
      handle,
      title,
      vendor,
      productType,
      style,
      color,
      size,
      quantity,
      imageUrl: sanitizeUrl(entry?.imageUrl),
      imageStatus: sanitizeImageStatus(entry?.imageStatus),
      productUrl: sanitizeUrl(entry?.productUrl),
      colorPageUrl: sanitizeUrl(entry?.colorPageUrl),
      unitPriceCents,
      lineTotalCents
    });
    if (sanitized.length >= 50) {
      break;
    }
  }
  return sanitized;
}

function isPodSku(sku) {
  if (!sku) return false;
  const raw = process.env.POD_SKU_PREFIXES || '';
  if (!raw) return false;
  const prefixes = String(raw)
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!prefixes.length) return false;
  const value = String(sku).trim();
  return prefixes.some((prefix) => value.startsWith(prefix));
}

function normalizeLineItemProperties(properties) {
  if (!Array.isArray(properties)) return null;
  const out = {};
  properties.forEach((p) => {
    const key = (p && p.name) ? String(p.name).trim() : '';
    if (!key) return;
    out[key] = p && p.value !== undefined ? p.value : null;
  });
  return Object.keys(out).length ? out : null;
}

function normalizeHexColor(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  const prefixed = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  return prefixed.toUpperCase();
}

function parseCurrencyToCents(value) {
  if (value === null || value === undefined || value === '') return null;
  if (Number.isFinite(value)) {
    const numeric = Number(value);
    if (Number.isInteger(numeric) && Math.abs(numeric) >= 100000) {
      return Math.round(numeric);
    }
    return Math.round(numeric * 100);
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    if (Number.isInteger(numeric) && Math.abs(numeric) >= 100000) {
      return Math.round(numeric);
    }
    return Math.round(numeric * 100);
  }
  const cleaned = String(value)
    .replace(/[^0-9.-]/g, '')
    .trim();
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return null;
  if (Math.abs(parsed) > 100000 && Number.isInteger(parsed)) {
    return Math.round(parsed);
  }
  return Math.round(parsed * 100);
}

function sanitizeInventoryItemPayload(payload = {}) {
  const name = sanitizeCopy(payload.name || '', 120);
  if (!name) {
    throw userError('Inventory item name is required.');
  }
  const material = sanitizeCopy(payload.material || '', 40).toLowerCase() || null;
  const color = normalizeHexColor(payload.color || payload.hex || '');
  const colorName = sanitizeCopy(payload.colorName || payload.color_name || '', 40) || null;
  const size = sanitizeCopy(payload.size || '', 40) || null;
  const fabric = sanitizeCopy(payload.fabric || '', 80) || null;
  const description = sanitizeCopy(payload.description || '', 400) || null;
  const imageUrl = payload.imageUrl !== undefined ? sanitizeUrl(payload.imageUrl) : null;
  const imageUrlBack = payload.imageUrlBack !== undefined ? sanitizeUrl(payload.imageUrlBack) : null;
  const unit = sanitizeCopy(payload.unit || '', 16).toLowerCase() || null;
  const itemUrl =
    payload.itemUrl !== undefined || payload.url !== undefined
      ? sanitizeUrl(payload.itemUrl || payload.url)
      : null;
  const referenceUrl = payload.referenceUrl !== undefined ? sanitizeUrl(payload.referenceUrl) : null;
  const variantGroupId = sanitizeCopy(payload.variantGroupId || '', 80) || null;
  const notes = sanitizeCopy(payload.notes || '', 160) || null;
  let unitCostCents = null;
  if (payload.unitCostCents !== undefined) {
    const centsValue = Number(payload.unitCostCents);
    if (Number.isFinite(centsValue) && centsValue >= 0) {
      unitCostCents = Math.round(centsValue);
    }
  } else if (payload.unitCost !== undefined) {
    const parsed = parseCurrencyToCents(payload.unitCost);
    if (Number.isFinite(parsed) && parsed >= 0) {
      unitCostCents = parsed;
    }
  } else if (payload.cost !== undefined) {
    const parsed = parseCurrencyToCents(payload.cost);
    if (Number.isFinite(parsed) && parsed >= 0) {
      unitCostCents = parsed;
    }
  }
  const quantityRaw =
    payload.quantity !== undefined
      ? Number(payload.quantity)
      : payload.initialQuantity !== undefined
      ? Number(payload.initialQuantity)
      : 0;
  const quantity = Number.isFinite(quantityRaw) ? Math.round(quantityRaw) : 0;

  return {
    name,
    material: material || null,
    color,
    colorName,
    size,
    fabric,
    description,
    imageUrl,
    imageUrlBack,
    itemUrl,
    referenceUrl,
    variantGroupId,
    unitCostCents: Number.isFinite(unitCostCents) && unitCostCents >= 0 ? unitCostCents : null,
    unit: unit || null,
    quantity,
    notes
  };
}

function sanitizeInventoryUpdatePayload(payload = {}) {
  const result = {};
  if (payload.name !== undefined) {
    const name = sanitizeCopy(payload.name || '', 120);
    if (!name) {
      throw userError('Name cannot be empty.');
    }
    result.name = name;
  }
  if (payload.material !== undefined) {
    const material = sanitizeCopy(payload.material || '', 40).toLowerCase();
    result.material = material || null;
  }
  if (payload.color !== undefined) {
    result.color = normalizeHexColor(payload.color || payload.hex || '');
  }
  if (payload.size !== undefined) {
    const size = sanitizeCopy(payload.size || '', 40);
    result.size = size || null;
  }
  if (payload.colorName !== undefined || payload.color_name !== undefined) {
    const colorName = sanitizeCopy(payload.colorName || payload.color_name || '', 40);
    result.colorName = colorName || null;
  }
  if (payload.fabric !== undefined) {
    const fabric = sanitizeCopy(payload.fabric || '', 80);
    result.fabric = fabric || null;
  }
  if (payload.description !== undefined) {
    const description = sanitizeCopy(payload.description || '', 400);
    result.description = description || null;
  }
  if (payload.imageUrl !== undefined) {
    result.imageUrl = sanitizeUrl(payload.imageUrl);
  }
  if (payload.imageUrlBack !== undefined) {
    result.imageUrlBack = sanitizeUrl(payload.imageUrlBack);
  }
  if (payload.itemUrl !== undefined || payload.url !== undefined) {
    result.itemUrl = sanitizeUrl(payload.itemUrl || payload.url);
  }
  if (payload.referenceUrl !== undefined) {
    result.referenceUrl = sanitizeUrl(payload.referenceUrl);
  }
  if (
    payload.unitCostCents !== undefined ||
    payload.unitCost !== undefined ||
    payload.cost !== undefined
  ) {
    const cents =
      payload.unitCostCents !== undefined
        ? Math.round(Number(payload.unitCostCents) || 0)
        : parseCurrencyToCents(payload.unitCost ?? payload.cost);
    if (cents !== null && cents < 0) {
      throw userError('Cost cannot be negative.');
    }
    result.unitCostCents = cents;
  }
  if (payload.unit !== undefined) {
    const unit = sanitizeCopy(payload.unit || '', 16).toLowerCase();
    result.unit = unit || 'unit';
  }
  if (payload.notes !== undefined) {
    const notes = sanitizeCopy(payload.notes || '', 200);
    result.notes = notes || null;
  }
  return result;
}

function sanitizeInventoryAdjustmentPayload(payload = {}) {
  const changeSource =
    payload.change !== undefined
      ? Number(payload.change)
      : payload.quantity !== undefined
      ? Number(payload.quantity)
      : payload.amount !== undefined
      ? Number(payload.amount)
      : 0;
  if (!Number.isFinite(changeSource) || Math.round(changeSource) === 0) {
    throw userError('Adjustment amount must be a non-zero number.');
  }
  const change = Math.round(changeSource);
  const reason = sanitizeCopy(payload.reason || '', 80) || (change > 0 ? 'adjustment-add' : 'adjustment-remove');
  const notes = sanitizeCopy(payload.notes || '', 160) || null;
  return { change, reason, notes };
}

function sanitizeInventoryUsagePayload(entries = []) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => {
      const itemId = sanitizeCopy(entry?.itemId || entry?.id || '', 64);
      const quantity = Number(entry?.quantity ?? entry?.amount ?? entry?.count ?? 0);
      if (!itemId || !Number.isFinite(quantity) || quantity <= 0) {
        return null;
      }
      const reason = sanitizeCopy(entry?.reason || '', 80) || null;
      const notes = sanitizeCopy(entry?.notes || '', 160) || null;
      return {
        itemId,
        quantity: Math.round(quantity),
        reason,
        notes
      };
    })
    .filter(Boolean);
}

function sanitizeImageStatus(value) {
  if (!value || typeof value !== 'object') return null;
  const status = Number.isFinite(value.status) ? Number(value.status) : null;
  const attempts = Number.isFinite(value.attempts) ? Number(value.attempts) : null;
  const normalized = {
    ok: Boolean(value.ok)
  };
  if (status !== null) {
    normalized.status = status;
  }
  const errorText = sanitizeCopy(value.error || '', 120);
  if (errorText) {
    normalized.error = errorText;
  }
  if (attempts !== null) {
    normalized.attempts = attempts;
  }
  return normalized;
}

function formatSponsorJobLine(sponsor) {
  if (!sponsor) return '';
  const parts = [sponsor.name];
  if (sponsor.size) parts.push(`size: ${sponsor.size}`);
  if (sponsor.color) parts.push(`color: ${sponsor.color}`);
  if (sponsor.apparel) parts.push('include apparel');
  return parts.filter(Boolean).join(' · ');
}

function queueRaceQuoteJob(quote) {
  if (!quote || !quote.id) return null;
  try {
    const orderId = `racequote-${quote.id}`;
    const existing = db.getOrderById(orderId);
    const status = (quote.status || '').toLowerCase();
    const response = (quote.customerResponse || '').toLowerCase();
    const accepted =
      response === 'accepted' || ['approved', 'awaiting_payment', 'paid'].includes(status);

    if (!accepted) {
      if (existing) {
        db.deleteOrder(orderId);
      }
      return null;
    }

    const now = new Date().toISOString();
    const orderNumber = existing?.orderNumber || db.getNextOrderNumber();
    const packageLabel = getRacePackageLabel(quote.packageOption);
    const addonsLabel = Array.isArray(quote.addons) && quote.addons.length
      ? quote.addons.map(formatRaceAddonLabel).join(', ')
      : '';

    const driverLine = quote.contactName
      ? `Driver: ${quote.contactName}${quote.driverCountry ? ` (${quote.driverCountry})` : ''}`
      : null;
    const coDriverLine = quote.coDriver
      ? `Co-driver: ${quote.coDriver}${quote.coDriverCountry ? ` (${quote.coDriverCountry})` : ''}`
      : null;

    const lines = [
      quote.requestDate ? `Requested: ${quote.requestDate}` : null,
      quote.business ? `Business: ${quote.business}` : null,
      driverLine,
      quote.customer?.email ? `Email: ${quote.customer.email}` : null,
      quote.customer?.phone ? `Phone: ${quote.customer.phone}` : null,
      quote.vehicle ? `Vehicle: ${quote.vehicle}` : null,
      quote.colors ? `Primary colors: ${quote.colors}` : null,
      `Package: ${packageLabel}`,
      addonsLabel ? `Add-ons: ${addonsLabel}` : null,
      quote.racingBody ? `Series: ${quote.racingBody}` : null,
      quote.carNumber ? `Car #: ${quote.carNumber}` : null,
      coDriverLine,
      quote.timelineText ? `Timeline: ${quote.timelineText}` : null,
      quote.deliveryText ? `Delivery: ${quote.deliveryText}` : null,
      quote.pricingNotes ? `Pricing notes: ${quote.pricingNotes}` : null,
      quote.notes ? `Notes: ${quote.notes}` : null
    ].filter(Boolean);

    const sponsorLines = Array.isArray(quote.sponsors) && quote.sponsors.length
      ? quote.sponsors.map((sponsor, index) => `Sponsor ${index + 1}: ${formatSponsorJobLine(sponsor)}`)
      : [];

    const textLayers = [...lines, ...sponsorLines].map((content) => ({ content }));

    const pricing =
      Number.isFinite(quote.totalCents) && quote.totalCents > 0
        ? { descriptor: `${packageLabel} (Race quote)`, totalCents: quote.totalCents }
        : { descriptor: `${packageLabel} (Race quote)` };

    const internalNotes = [
      'Race quote request queued automatically.',
      quote.customer?.address ? `Address: ${quote.customer.address}` : null,
      [...lines, ...sponsorLines].join(' | ')
    ]
      .filter(Boolean)
      .join('\n');
    if (existing) {
      db.updateOrder(orderId, {
        notes: lines.join('\n'),
        textLayers,
        pricing,
        designName: `Race Quote · ${quote.business || quote.contactName || quote.id}`,
        category: 'Race Quote',
        internalNotes
      });
      return db.getOrderById(orderId);
    }

    db.recordOrder({
      id: orderId,
      orderNumber,
      customerId: quote.customerId || null,
      designId: quote.id,
      designName: `Race Quote · ${quote.business || quote.contactName || quote.id}`,
      category: 'Race Quote',
      size: null,
      color: null,
      background: null,
      quantity: 1,
      notes: lines.join('\n'),
      textLayers,
      previewFile: null,
      metadataPath: null,
      sourceFiles: [],
      pricing,
      paymentLink: null,
      paymentLinkId: null,
      paymentStatus: 'UNPAID',
      paymentDetails: null,
      savedAt: now,
      paid: false,
      internalNotes,
      bytesWritten: 0
    });

    return db.getOrderById(orderId);
  } catch (error) {
    console.error('Unable to queue race quote job:', error);
    return null;
  }
}

function getRaceQuoteFilesDir(quoteId) {
  const dir = path.join(RACE_QUOTE_FILES_DIR, quoteId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function buildRaceQuoteFilePath(quoteId, storedName) {
  return path.join(getRaceQuoteFilesDir(quoteId), storedName);
}

function buildPublicAssetUrl(value, assetRoot) {
  if (!value) return null;
  const normalized = String(value).replace(/\\/g, '/').replace(/^\.\//, '');
  if (/^(https?:|data:)/i.test(normalized)) {
    return normalized;
  }

  const sanitized = normalized.replace(/^(\.\.\/)+/g, '');
  const candidate = sanitized || normalized;

  const base = assetRoot ? assetRoot.trim() : '';
  if (!base) {
    return candidate.startsWith('/') ? candidate : `/${candidate}`;
  }

  try {
    const formattedBase = base.endsWith('/') ? base : `${base}/`;
    return new URL(candidate.replace(/^\//, ''), formattedBase).toString();
  } catch (error) {
    const safeBase = base.replace(/\/$/, '');
    const trimmed = candidate.startsWith('/') ? candidate : `/${candidate}`;
    return `${safeBase}${trimmed}`;
  }
}

function toLibraryRelativePath(rawPath) {
  if (!rawPath) return null;
  const normalized = String(rawPath).replace(/\\/g, '/');
  const absolute = path.resolve(LIBRARY_ROOT, normalized);
  const libraryRootNormalized = path.resolve(LIBRARY_ROOT).replace(/\\/g, '/');
  const absoluteNormalized = absolute.replace(/\\/g, '/');
  const rootWithSlash = libraryRootNormalized.endsWith('/')
    ? libraryRootNormalized
    : `${libraryRootNormalized}/`;
  if (absoluteNormalized !== libraryRootNormalized && !absoluteNormalized.startsWith(rootWithSlash)) {
    return null;
  }
  const relative = path
    .relative(LIBRARY_ROOT, absolute)
    .split(path.sep)
    .join('/');
  if (!relative || relative.startsWith('..')) {
    return null;
  }
  return relative.replace(/^\.\//, '');
}

function buildAssetProxyUrl(rawPath, assetRoot) {
  const libraryRelative = toLibraryRelativePath(rawPath);
  if (libraryRelative) {
    const encoded = libraryRelative.split('/').map(encodeURIComponent).join('/');
    return `/api/library/${encoded}`;
  }
  return buildPublicAssetUrl(rawPath, assetRoot);
}

function buildSourceProxyMap(sourceMap, assetRoot) {
  const result = {};
  if (!sourceMap || typeof sourceMap !== 'object') {
    return result;
  }
  for (const [key, value] of Object.entries(sourceMap)) {
    result[key] = buildAssetProxyUrl(value, assetRoot);
  }
  return result;
}

function ensureCampaignsDir() {
  fs.mkdirSync(CAMPAIGNS_DIR, { recursive: true });
  return CAMPAIGNS_DIR;
}

function ensureExportDir() {
  fs.mkdirSync(EXPORT_STATE_DIR, { recursive: true });
  return EXPORT_STATE_DIR;
}

function readShopifyCartEvents() {
  try {
    const raw = fs.readFileSync(SHOPIFY_TEST_CARTS_FILE, 'utf8');
    const data = JSON.parse(raw || '[]');
    return Array.isArray(data) ? data : [];
  } catch (_) {
    return [];
  }
}

function appendShopifyCartEvent(event) {
  const list = readShopifyCartEvents();
  list.push({ ...event, receivedAt: new Date().toISOString() });
  const trimmed = list.slice(-50);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SHOPIFY_TEST_CARTS_FILE, JSON.stringify(trimmed, null, 2), 'utf8');
  return trimmed.length;
}

function sanitizeCampaignSlug(value) {
  const base = slugify(value || 'campaign');
  return base || 'campaign';
}

function readCampaign(slug) {
  try {
    const file = path.join(ensureCampaignsDir(), `${sanitizeCampaignSlug(slug)}.json`);
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    return data;
  } catch (error) {
    return null;
  }
}

function writeCampaignFile(slug, payload) {
  const safeSlug = sanitizeCampaignSlug(slug);
  const file = path.join(ensureCampaignsDir(), `${safeSlug}.json`);

  // Debug logging for every campaign write
  console.log(`[writeCampaignFile] Writing campaign: ${safeSlug}`);
  if (payload && payload.items && Array.isArray(payload.items)) {
    console.log(`[writeCampaignFile] Campaign has ${payload.items.length} items`);
    if (payload.items.length > 0) {
      console.log(`[writeCampaignFile] First item mockupImage: ${payload.items[0].mockupImage || 'NONE'}`);
      console.log(`[writeCampaignFile] First item shopifyProductId: ${payload.items[0].shopifyProductId || 'NONE'}`);
    }
  }

  // Capture stack trace to see where the write came from
  const stack = new Error().stack;
  const callerLine = stack.split('\n')[2]; // Skip Error and writeCampaignFile lines
  console.log(`[writeCampaignFile] Called from: ${callerLine ? callerLine.trim() : 'unknown'}`);

  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`[writeCampaignFile] ✓ Write completed`);
  return file;
}

function listCampaigns() {
  try {
    const files = fs.readdirSync(ensureCampaignsDir());
    return files
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        try {
          const raw = fs.readFileSync(path.join(CAMPAIGNS_DIR, name), 'utf8');
          const data = JSON.parse(raw);
          return data;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (error) {
    return [];
  }
}

function resolveCampaignItem(item, catalog, assetRoot) {
  const out = { ...item };
  // Resolve via catalog reference if provided
  if (!out.image && out.categorySlug && out.designId) {
    const { category, design } = findDesignInCatalog(catalog, out.categorySlug, out.designId);
    if (design) {
      out.name = out.name || design.name || out.designId;
      out.image = buildAssetProxyUrl(design.image, assetRoot);
      out.sources = buildSourceProxyMap(design.sources, assetRoot);
    }
    if (category && !out.categoryName) {
      out.categoryName = category.name;
    }
  }
  if (out.image) {
    out.image = buildAssetProxyUrl(out.image, assetRoot);
  }
  if (out.hero && out.hero.image) {
    out.hero.image = buildAssetProxyUrl(out.hero.image, assetRoot);
  }
  out.productType = normalizeApparelProductType(out.productType || 'tshirt');
  // Normalize price for stickers (allow dollars or cents in payload)
  if (out.productType === 'sticker') {
    if (out.priceCents == null && out.price != null) {
      const dollars = Number(out.price);
      if (Number.isFinite(dollars) && dollars >= 0) {
        out.priceCents = Math.round(dollars * 100);
      }
    }
    if (typeof out.priceCents === 'string') {
      const parsed = Number(out.priceCents);
      if (Number.isFinite(parsed)) out.priceCents = Math.round(parsed);
    }
  }
  out.quantity = Number.isFinite(Number(out.quantity)) ? Math.max(1, Number(out.quantity)) : 1;
  return out;
}

function readPricingSheet() {
  try {
    let raw = null;
    try { raw = fs.readFileSync(PRICING_FILE, 'utf8'); } catch (_) {}
    if (!raw) {
      try { raw = fs.readFileSync(PRICING_FALLBACK, 'utf8'); } catch (_) {}
    }
    if (!raw) return {};
    const json = JSON.parse(raw || '{}');
    return json && typeof json === 'object' ? json : {};
  } catch (_) {
    return {};
  }
}

function getVariantPricing(pricing, type, size) {
  const t = String(type || '').toLowerCase();
  const s = String(size || '').toUpperCase();
  const base = pricing?.[t]?.base || pricing?.[t] || null;
  const sizes = pricing?.[t]?.sizes || null;
  const pick = (sizes && sizes[s]) || base || null;
  let priceCents = null, costCents = null;
  if (pick && typeof pick === 'object') {
    if (Number.isFinite(Number(pick.priceCents))) priceCents = Math.round(Number(pick.priceCents));
    // Support detailed cost breakdown: costMaterialCents + costLaborCents
    const hasUnified = Number.isFinite(Number(pick.costCents));
    const mat = Number.isFinite(Number(pick.costMaterialCents)) ? Math.round(Number(pick.costMaterialCents)) : null;
    const lab = Number.isFinite(Number(pick.costLaborCents)) ? Math.round(Number(pick.costLaborCents)) : null;
    if (hasUnified) {
      costCents = Math.round(Number(pick.costCents));
    } else if (mat != null || lab != null) {
      costCents = (mat || 0) + (lab || 0);
    }
  } else if (Number.isFinite(Number(pick))) {
    priceCents = Math.round(Number(pick));
  }
  return { priceCents, costCents };
}

function resolveCampaignPublic(campaign) {
  if (!campaign) return null;
  const catalog = loadCatalogSnapshot();
  const assetRoot = process.env.ASSET_BASE_URL || catalog?.assetRoot || '';
  const items = Array.isArray(campaign.items) ? campaign.items : [];
  const resolvedItems = items.map((it) => resolveCampaignItem(it, catalog, assetRoot)).filter((it) => it.image);
  const hero = campaign.hero && campaign.hero.image
    ? { ...campaign.hero, image: buildAssetProxyUrl(campaign.hero.image, assetRoot) }
    : null;
  const rawMockup = campaign.mockupStrategy || {};
  const mockupStrategy = {
    mode: String(rawMockup.mode || 'perItem').toLowerCase() === 'campaign' ? 'campaign' : 'perItem',
    mockupItemUid: String(rawMockup.mockupItemUid || ''),
    description: String(rawMockup.description || '').trim()
  };
  let sharedMockup = null;
  if (mockupStrategy.mode === 'campaign' && mockupStrategy.mockupItemUid) {
    const selected = resolvedItems.find((it) => String(it.uid || '') === mockupStrategy.mockupItemUid);
    if (selected && selected.image) {
      sharedMockup = {
        name: selected.name || '',
        image: selected.image,
        productType: selected.productType || '',
        size: selected.size || '',
        color: selected.color || selected.colorName || '',
        description: mockupStrategy.description || ''
      };
    }
  }
  return {
    slug: campaign.slug,
    title: campaign.title || campaign.slug,
    subtitle: campaign.subtitle || campaign.tagline || '',
    themeColor: campaign.themeColor || '#1d4ed8',
    hero,
    items: resolvedItems,
    mockupStrategy,
    sharedMockup,
    updatedAt: campaign.updatedAt || null,
    assetRoot: assetRoot || null
  };
}

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN || null;
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID || null;
const SQUARE_ENV =
  process.env.SQUARE_ENV === 'production'
    ? SquareEnvironment.Production
    : SquareEnvironment.Sandbox;
const SQUARE_WEBHOOK_SIGNATURE_KEY = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || null;
const INTERNAL_API_KEY =
  process.env.INTERNAL_API_KEY || process.env.PRINT_STATION_API_KEY || null;

const squareClient = SQUARE_ACCESS_TOKEN
  ? new SquareClient({
      token: SQUARE_ACCESS_TOKEN,
      environment: SQUARE_ENV
    })
  : null;
let cachedSquareLocationId = SQUARE_LOCATION_ID || null;

function toMoneyAmount(cents) {
  const value = Number(cents ?? 0);
  if (!Number.isFinite(value)) {
    throw new Error('Invalid money amount.');
  }
  return BigInt(Math.round(value));
}

const ALLOWED_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const ALLOWED_SOURCE_EXTENSIONS = new Map([
  ['.ai', 'ai'],
  ['.eps', 'eps'],
  ['.pdf', 'pdf'],
  ['.svg', 'svg']
]);
const SKIP_UPLOAD_SEARCH_DIRS = new Set(['web', 'scripts', 'node_modules', 'data', 'saved-designs']);
const SPECIALS_FILE = path.join(DATA_DIR, 'specials.json');
const MAX_SPECIAL_ITEMS = 4;
const RACE_PACKAGE_OPTIONS = {
  basic: { label: 'Basic Number Kit' },
  sponsor: { label: 'Sponsor Kit' },
  pro: { label: 'Pro Package' },
  elite: { label: 'Elite Custom Kit' }
};

const DECAL_SIZES = ['3"', '4"', '5"', '6"', '7"', '8"', '9"'];

function getRegularVinylColors() {
  try {
    const items = db.listInventoryItems({ material: 'regular-vinyl' }) || [];
    const set = new Set();
    for (const row of items) {
      // Use name field (e.g., "Arctic Gray") instead of colorName/color (hex codes)
      const color = String(row.name || row.colorName || '').trim();
      if (color) set.add(color);
    }
    return Array.from(set).sort();
  } catch (_) {
    return [];
  }
}

function parseStickerSizeInches(label) {
  if (!label) return 3;
  const numeric = Number(String(label).replace(/[^0-9.]+/g, ''));
  if (!Number.isFinite(numeric) || numeric <= 0) return 3;
  return numeric;
}

function priceForStickerSize(sizeLabel) {
  const inches = parseStickerSizeInches(sizeLabel);
  const delta = Math.max(0, inches - 3);
  const price = 3 + delta;
  return price.toFixed(2);
}

const APPAREL_STORE_FILE = path.join(DATA_DIR, 'apparel-store.json');
const DEFAULT_APPAREL_STORE = {
  updatedAt: null,
  categories: [],
  items: []
};
const KNOWN_APPAREL_PRODUCT_TYPES = new Set([
  'tshirt',
  'hoodie',
  'hat',
  'beanie',
  'headband',
  'accessory',
  'drinkware'
]);
const VALID_QUOTE_STATUSES = new Set([
  'submitted',
  'in_review',
  'quoted',
  'awaiting_payment',
  'approved',
  'paid',
  'cancelled'
]);

db.initDatabase();
ensureOutputDir();
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(RACE_QUOTE_FILES_DIR, { recursive: true });

function ensureOutputDir() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function makeCustomerLink(param, token) {
  return `${CUSTOMER_PORTAL_URL}?${param}=${encodeURIComponent(token)}`;
}

function logEmailPreview(action, url) {
  if (EMAIL_LOG_ENABLED) {
    console.log(`[email:${action}] ${url}`);
  }
}

function findCategoryDirectoryBySlug(categorySlug) {
  if (!categorySlug) return null;
  const entries = fs.readdirSync(LIBRARY_ROOT, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    if (SKIP_UPLOAD_SEARCH_DIRS.has(entry.name)) continue;
    if (slugify(entry.name) === categorySlug) {
      return path.join(LIBRARY_ROOT, entry.name);
    }
  }
  return null;
}

function ensureUploadsDirectories(categoryDir) {
  const baseDir = path.join(categoryDir, 'uploads');
  const previewsDir = path.join(baseDir, 'previews');
  const sourcesDir = path.join(baseDir, 'sources');
  fs.mkdirSync(baseDir, { recursive: true });
  fs.mkdirSync(previewsDir, { recursive: true });
  fs.mkdirSync(sourcesDir, { recursive: true });
  return { baseDir, previewsDir, sourcesDir };
}

function ensureUniqueBase(previewsDir, base, ext) {
  let candidate = base || `design-${Date.now()}`;
  let counter = 1;
  while (fs.existsSync(path.join(previewsDir, candidate + ext))) {
    candidate = `${base}-${counter++}`;
  }
  return candidate;
}

function regenerateCatalog() {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [path.join(APP_ROOT, 'scripts', 'generate-catalog.js')],
      { env: { ...process.env, LIBRARY_ROOT } },
      (error) => {
        if (error) {
          console.error('Catalog regeneration failed:', error);
          reject(error);
          return;
        }
        resolve();
      }
    );
  });
}

async function sendVerificationEmail(customer, link) {
  try {
    await sendAccountEmail({
      to: customer.email,
      subject: "Confirm your Swayze's Custom Vinyl account",
      text: `Hi ${customer.name || 'there'},\n\nPlease confirm your email address so you can manage your sticker orders.\n\nConfirm now: ${link}\n\nIf you didn’t request this, ignore the message.`,
      html: `<p>Hi ${customer.name || 'there'},</p><p>Please confirm your email address so you can manage your sticker orders.</p><p><a href="${link}">Confirm my email</a></p><p>If you didn’t request this, you can ignore the message.</p>`
    });
  } catch (error) {
    console.error('Failed to send verification email:', error);
  }
}

async function sendPasswordResetEmail(customer, link) {
  try {
    await sendAccountEmail({
      to: customer.email,
      subject: "Reset your Swayze's Custom Vinyl password",
      text: `Hi ${customer.name || 'there'},\n\nWe received a request to reset your password. If that was you, use the link below in the next two hours.\n\nReset password: ${link}\n\nIf you didn't request this, you can ignore the email.`,
      html: `<p>Hi ${customer.name || 'there'},</p><p>We received a request to reset your password. If that was you, use the button below in the next two hours.</p><p><a href="${link}">Reset password</a></p><p>If you didn’t request this, you can ignore the email.</p>`
    });
  } catch (error) {
    console.error('Failed to send password reset email:', error);
  }
}

async function createSquarePaymentLinkForOrder(order) {
  if (!squareClient) {
    throw new Error('Square integration not configured.');
  }
  if (!order.pricing || !Number.isFinite(order.pricing.totalCents)) {
    throw new Error('Pricing details are required before collecting payment.');
  }
  const locationId = await getSquareLocationId();

  const idempotencyKey = crypto.randomUUID();
  const currency = order.pricing.currency || 'USD';
  const quantity = Math.max(1, order.pricing.quantity || order.quantity || 1);

  const lineItems = [
    {
      name: order.pricing.descriptor || `Order #${order.orderNumber || order.id}`,
      quantity: `${quantity}`,
      basePriceMoney: {
        amount: toMoneyAmount(order.pricing.unitPriceCents),
        currency
      }
    }
  ];

  if (order.pricing.shippingCents) {
    lineItems.push({
      name: 'Shipping',
      quantity: '1',
      basePriceMoney: {
        amount: toMoneyAmount(order.pricing.shippingCents),
        currency
      }
    });
  }

  const redirectUrl = `${CUSTOMER_PORTAL_URL}?paid=1&order=${encodeURIComponent(order.id)}`;

  const response = await squareClient.checkout.paymentLinks.create({
    idempotencyKey,
    order: {
      locationId,
      referenceId: order.orderNumber ? `order-${order.orderNumber}` : order.id,
      lineItems
    },
    checkoutOptions: {
      redirectUrl,
      customerEmail: order.customer?.email || undefined
    }
  });

  const paymentLink = response?.paymentLink;
  db.setOrderPaymentLink(order.id, {
    url: paymentLink?.url || null,
    linkId: paymentLink?.id || null
  });

  try {
    // SMS notify if customer opted in
    const customer = order.customerId
      ? db.findCustomerById(order.customerId)
      : order.customer || null;
    if (customer && (customer.smsOptIn || customer.sms_opt_in) && paymentLink?.url) {
      notifyCustomerOfPaymentLink({ customer, url: paymentLink.url, orderNumber: order.orderNumber });
    }
  } catch (_) {}

  return paymentLink;
}

async function createSquarePaymentLinkForOrdersAggregate(customer, orders) {
  if (!squareClient) {
    throw new Error('Square integration not configured.');
  }
  if (!Array.isArray(orders) || !orders.length) {
    throw new Error('No orders to include.');
  }
  const locationId = await getSquareLocationId();
  const idempotencyKey = crypto.randomUUID();
  const currency = 'USD';
  const lineItems = [];
  for (const order of orders) {
    if (!order.pricing || !Number.isFinite(order.pricing.totalCents) || order.pricing.totalCents <= 0) {
      continue;
    }
    const quantity = Math.max(1, order.pricing.quantity || order.quantity || 1);
    lineItems.push({
      name: order.pricing.descriptor || `Order #${order.orderNumber || order.id}`,
      quantity: `${quantity}`,
      basePriceMoney: { amount: toMoneyAmount(order.pricing.unitPriceCents), currency }
    });
    if (order.pricing.shippingCents) {
      lineItems.push({
        name: `Shipping (Order #${order.orderNumber || order.id})`,
        quantity: '1',
        basePriceMoney: { amount: toMoneyAmount(order.pricing.shippingCents), currency }
      });
    }
  }
  if (!lineItems.length) {
    throw new Error('No payable line items found.');
  }
  const referenceId = `batch-${Date.now()}-${customer.id}`;
  const redirectUrl = `${CUSTOMER_PORTAL_URL}?paid=1&batch=${encodeURIComponent(referenceId)}`;
  const response = await squareClient.checkout.paymentLinks.create({
    idempotencyKey,
    order: { locationId, referenceId, lineItems },
    checkoutOptions: { redirectUrl, customerEmail: customer.email || undefined }
  });
  const paymentLink = response?.paymentLink;
  // Save link on each order for traceability
  const url = paymentLink?.url || null;
  const linkId = paymentLink?.id || null;
  orders.forEach((o) => {
    try { db.setOrderPaymentLink(o.id, { url, linkId }); } catch (_) {}
  });
  try {
    if (customer && (customer.smsOptIn || customer.sms_opt_in) && url) {
      notifyCustomerOfPaymentLink({ customer, url, count: orders.length });
    }
  } catch (_) {}
  return paymentLink;
}

async function createSquarePaymentLinkForRaceQuote(quote) {
  if (!squareClient) {
    throw new Error('Square integration not configured.');
  }
  if (!Number.isFinite(quote.totalCents) || quote.totalCents <= 0) {
    throw new Error('Quote total is required before collecting payment.');
  }
  const locationId = await getSquareLocationId();

  const idempotencyKey = crypto.randomUUID();
  const currency = 'USD';

  const lineItems = [
    {
      name:
        quote.packageOption && quote.packageOption.length
          ? `${quote.packageOption} package`
          : `Race kit quote #${quote.quoteNumber || quote.id}`,
      quantity: '1',
      basePriceMoney: {
        amount: toMoneyAmount(quote.totalCents),
        currency
      }
    }
  ];

  const response = await squareClient.checkout.paymentLinks.create({
    idempotencyKey,
    order: {
      locationId,
      referenceId: `quote-${quote.id}`,
      lineItems
    },
    checkoutOptions: {
      redirectUrl: `${CUSTOMER_PORTAL_URL}?quote=${encodeURIComponent(quote.id)}&paid=1`,
      customerEmail: quote.customer?.email || undefined
    }
  });

  const paymentLink = response?.paymentLink;
  db.setRaceQuotePaymentLink(quote.id, {
    url: paymentLink?.url || null,
    linkId: paymentLink?.id || null
  });
  db.updateRaceQuote(quote.id, { status: 'awaiting_payment' });

  return paymentLink;
}

async function getSquareLocationId() {
  if (!squareClient) {
    throw new Error('Square integration not configured.');
  }
  if (cachedSquareLocationId) {
    return cachedSquareLocationId;
  }
  const response = await squareClient.locations.list();
  const locations = response?.locations || [];
  const activeLocation = locations.find((loc) => loc.status === 'ACTIVE') || locations[0];
  if (!activeLocation) {
    throw new Error('No active Square locations available.');
  }
  cachedSquareLocationId = activeLocation.id;
  return cachedSquareLocationId;
}

// sendJson and handleOptions are now imported from ./utils/http

function decodeImage(dataUrl) {
  const match = /^data:image\/png;base64,(.+)$/.exec(dataUrl || '');
  if (!match) {
    throw new Error('Expected a PNG data URL.');
  }
  return Buffer.from(match[1], 'base64');
}

// slugify is now imported from ./utils/string

function buildUniqueFilenames(baseSlug) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `${baseSlug}-${timestamp}`;
  let attempt = 0;

  while (attempt < 1000) {
    const suffix = attempt ? `-${attempt}` : '';
    const slug = `${base}${suffix}`;
    const imageName = `${slug}.png`;
    const metadataName = `${slug}.json`;
    const imagePath = path.join(OUTPUT_DIR, imageName);
    const metadataPath = path.join(OUTPUT_DIR, metadataName);
    if (!fs.existsSync(imagePath) && !fs.existsSync(metadataPath)) {
      return { slug, imageName, metadataName };
    }
    attempt += 1;
  }

  throw new Error('Unable to allocate a unique filename for saved design.');
}

function copyDesignSources(slug, designSources = {}) {
  const records = [];
  if (!designSources || typeof designSources !== 'object') return records;

  for (const [format, relativePath] of Object.entries(designSources)) {
    if (!relativePath) continue;
    const absolutePath = path.resolve(WEB_DIR, relativePath);
    if (!fs.existsSync(absolutePath)) continue;

    const ext = path.extname(absolutePath) || '';
    const copyName = `${slug}-${format}${ext}`;
    const copyPath = path.join(OUTPUT_DIR, copyName);

    try {
      if (!fs.existsSync(copyPath)) {
        fs.copyFileSync(absolutePath, copyPath);
      }

      records.push({
        format,
        file: copyName,
        originalPath: path
          .relative(LIBRARY_ROOT, absolutePath)
          .split(path.sep)
          .join('/'),
        size: fs.statSync(copyPath).size
      });
    } catch (error) {
      console.warn(`Unable to copy source file ${relativePath}:`, error.message);
    }
  }

  return records;
}

function duplicateSavedSources(slug, sourceCopies = []) {
  const duplicated = [];
  sourceCopies.forEach((source) => {
    if (!source.file) return;
    const originalPath = path.join(OUTPUT_DIR, source.file);
    if (!fs.existsSync(originalPath)) return;
    const ext = path.extname(source.file) || '';
    const newName = `${slug}-${source.format || 'source'}${ext}`;
    const targetPath = path.join(OUTPUT_DIR, newName);
    fs.copyFileSync(originalPath, targetPath);
    duplicated.push({
      ...source,
      file: newName,
      size: fs.statSync(targetPath).size
    });
  });
  return duplicated;
}

function writeMetadataFile(fileName, data) {
  const metadataPath = path.join(OUTPUT_DIR, fileName);
  fs.writeFileSync(metadataPath, JSON.stringify(data, null, 2), 'utf8');
  return metadataPath;
}

function moveFile(source, target) {
  if (!source || !target) return;
  try {
    fs.renameSync(source, target);
  } catch (error) {
    if (error.code === 'EXDEV') {
      fs.copyFileSync(source, target);
      fs.unlinkSync(source);
    } else {
      throw error;
    }
  }
}

function persistDesign(payload) {
  ensureOutputDir();
  const { imageData, textLayers, designSources, customer: customerPayload, ...metadata } = payload;
  const buffer = decodeImage(imageData);
  const apparelItems = sanitizeApparelItems(metadata.apparelItems || []);
  const productType =
    sanitizeCopy(
      metadata.productType ||
        metadata.pricing?.productType ||
        (apparelItems[0]?.productType || ''),
      40
    ) || null;
  metadata.apparelItems = apparelItems;
  metadata.productType = productType;
  const inventoryUsageInput = sanitizeInventoryUsagePayload(
    metadata.inventoryUsage || payload.inventoryUsage || []
  );
  metadata.inventoryUsage = inventoryUsageInput;

  const baseSlug = slugify(metadata.designId || metadata.designName || 'design');
  const { slug, imageName, metadataName } = buildUniqueFilenames(baseSlug);

  const previewPath = path.join(OUTPUT_DIR, imageName);
  let orderInventoryUsage = [];
  let sourceCopies = [];
  let previewWritten = false;
  let metadataWritten = false;
  let metadataFilePath = null;
  let customerRecord = null;
  let savedAt = null;
  let orderNumber = null;

  try {
    if (inventoryUsageInput.length) {
      try {
        orderInventoryUsage = db.recordOrderInventoryUsage(slug, inventoryUsageInput);
      } catch (error) {
        throw userError(error.message || 'Unable to reserve inventory for this order.');
      }
    }

    fs.writeFileSync(previewPath, buffer, { flag: 'wx' });
    previewWritten = true;

    sourceCopies = copyDesignSources(slug, designSources);

    if (metadata._authCustomerId) {
      try {
        customerRecord = db.findCustomerById(metadata._authCustomerId);
      } catch (error) {
        console.warn('Unable to fetch authenticated customer by id:', error.message);
      }
    }
    if (!customerRecord && customerPayload?.email) {
      try {
        customerRecord = db.upsertCustomerContact(customerPayload);
      } catch (error) {
        console.warn('Unable to upsert customer contact:', error.message);
      }
    }

    savedAt = new Date().toISOString();
    orderNumber = db.getNextOrderNumber();
    const customerSnapshot = customerRecord
      ? {
          name: customerRecord.name,
          email: customerRecord.email,
          phone: customerRecord.phone,
          address: customerRecord.address,
          emailVerified: Boolean(customerRecord.emailVerified),
          smsOptIn: Boolean(customerRecord.smsOptIn)
        }
      : customerPayload
      ? {
          name: customerPayload.name,
          email: customerPayload.email,
          phone: customerPayload.phone,
          address: customerPayload.address,
          emailVerified: false,
          smsOptIn: Boolean(customerPayload.smsOptIn)
        }
      : null;

    // Normalize pricing for kiosk orders: no shipping
    let normalizedPricing = metadata.pricing || null;
    try {
      if (metadata.submittedFrom === 'kiosk' && normalizedPricing && typeof normalizedPricing === 'object') {
        const qty = Math.max(1, Number(normalizedPricing.quantity || metadata.quantity || 1));
        const unit = Math.max(0, Number(normalizedPricing.unitPriceCents || 0));
        const subtotal = Number.isFinite(normalizedPricing.subtotalCents)
          ? Math.max(0, Number(normalizedPricing.subtotalCents))
          : unit * qty;
        normalizedPricing = {
          ...normalizedPricing,
          shippingCents: 0,
          subtotalCents: subtotal,
          totalCents: subtotal,
        };
      }
    } catch (_) {}

    const enrichedMetadata = {
      ...metadata,
      id: slug,
      orderNumber,
      savedAt,
      file: imageName,
      textLayers: textLayers || [],
      sourceCopies,
      customer: customerSnapshot,
      paid: false,
      paymentStatus: 'UNPAID',
      pricing: normalizedPricing,
      bytesWritten: buffer.length,
      inventoryUsage: orderInventoryUsage
    };

    metadataFilePath = writeMetadataFile(metadataName, enrichedMetadata);
    metadataWritten = true;

    db.recordOrder({
      id: slug,
      orderNumber,
      customerId: customerRecord?.id || null,
      designId: metadata.designId || null,
      designName: metadata.designName || 'Unknown design',
      productType,
      category: metadata.category || 'Uncategorized',
      size: metadata.size || 0,
      color: metadata.color || '#000000',
      background: metadata.background || '#ffffff',
      quantity: metadata.quantity || 1,
      notes: metadata.notes || '',
      textLayers,
      previewFile: imageName,
      metadataPath: metadataName,
      sourceFiles: sourceCopies,
      apparelItems,
      inventoryUsage: orderInventoryUsage,
      pricing: normalizedPricing,
      paymentLink: null,
      paymentLinkId: null,
      paymentStatus: 'UNPAID',
      paymentDetails: null,
      savedAt,
      paid: false,
      internalNotes: metadata.internalNotes || '',
      bytesWritten: buffer.length,
      campaign: metadata.campaign || null
    });

    const orderSnapshot = {
      id: slug,
      orderNumber,
      quantity: metadata.quantity || 1,
      designName: metadata.designName || null,
      designId: metadata.designId || null,
      category: metadata.category || null,
      customer: customerSnapshot,
      pricing: normalizedPricing || null
    };
    notifyAdminsOfNewOrder(orderSnapshot);
    // Customer SMS (opt‑in)
    if (customerSnapshot && (customerSnapshot.smsOptIn || customerSnapshot.sms_opt_in)) {
      notifyCustomerOfNewOrder({ orderNumber, customer: customerSnapshot });
    }

    return {
      id: slug,
      orderNumber,
      previewFile: imageName,
      metadataPath: path.posix.join('saved-designs', metadataName),
      sourceCopies,
      pricing: metadata.pricing || null,
      paymentLink: null,
      paymentStatus: 'UNPAID',
      bytesWritten: buffer.length,
      apparelItems,
      inventoryUsage: orderInventoryUsage,
      productType
    };
  } catch (error) {
    if (orderInventoryUsage.length) {
      try {
        orderInventoryUsage.forEach((entry) => {
          db.adjustInventoryQuantity(entry.itemId, entry.quantity, {
            reason: 'rollback',
            orderId: slug,
            notes: 'Reverted after failed order save'
          });
        });
      } catch (rollbackError) {
        console.error('Inventory rollback failed:', rollbackError);
      }
    }
    if (metadataWritten && metadataFilePath) {
      try {
        fs.unlinkSync(metadataFilePath);
      } catch (cleanupError) {
        console.warn('Unable to remove metadata file after failure:', cleanupError.message);
      }
    }
    if (previewWritten) {
      try {
        fs.unlinkSync(previewPath);
      } catch (cleanupError) {
        console.warn('Unable to remove preview file after failure:', cleanupError.message);
      }
    }
    throw error;
  }
}

function duplicateOrder(order) {
  ensureOutputDir();
  const baseSlug = slugify(order.designId || order.designName || 'design');
  const { slug, imageName, metadataName } = buildUniqueFilenames(baseSlug);

  const originalPreviewPath = path.join(OUTPUT_DIR, order.previewFile);
  if (!fs.existsSync(originalPreviewPath)) {
    throw new Error('Original preview file missing.');
  }

  const newPreviewPath = path.join(OUTPUT_DIR, imageName);
  fs.copyFileSync(originalPreviewPath, newPreviewPath);

  const duplicatedSources = duplicateSavedSources(slug, order.sourceCopies || []);

  const savedAt = new Date().toISOString();
  const orderNumber = db.getNextOrderNumber();
  const metadata = {
    id: slug,
    orderNumber,
    designId: order.designId,
    designName: order.designName,
    productType: order.productType || null,
    category: order.category,
    size: order.size,
    color: order.color,
    background: order.background,
    quantity: order.quantity,
    notes: order.notes,
    textLayers: order.textLayers || [],
    sourceCopies: duplicatedSources,
    apparelItems: Array.isArray(order.apparelItems) ? order.apparelItems : [],
    file: imageName,
    savedAt,
    customer: order.customer
      ? {
          ...order.customer,
          emailVerified: order.customer.emailVerified ?? false
        }
      : null,
    paid: false,
    paymentStatus: 'UNPAID',
    pricing: order.pricing || null,
    bytesWritten: fs.statSync(newPreviewPath).size
  };

  writeMetadataFile(metadataName, metadata);

  db.recordOrder({
    id: slug,
    orderNumber,
    customerId: order.customerId || null,
    designId: order.designId,
    designName: order.designName,
    productType: order.productType || null,
    category: order.category,
    size: order.size,
    color: order.color,
    background: order.background,
    quantity: order.quantity,
    notes: order.notes,
    textLayers: order.textLayers || [],
    previewFile: imageName,
    metadataPath: metadataName,
    sourceFiles: duplicatedSources,
    apparelItems: Array.isArray(order.apparelItems) ? order.apparelItems : [],
    pricing: order.pricing || null,
    paymentLink: null,
    paymentLinkId: null,
    paymentStatus: 'UNPAID',
    paymentDetails: null,
    savedAt,
    paid: false,
    internalNotes: order.internalNotes || '',
    bytesWritten: metadata.bytesWritten
  });

  return {
    newId: slug,
    orderNumber,
    metadataPath: path.posix.join('saved-designs', metadataName),
    previewFile: imageName,
    sourceCopies: duplicatedSources,
    pricing: order.pricing || null,
    apparelItems: Array.isArray(order.apparelItems) ? order.apparelItems : [],
    productType: order.productType || null,
    savedAt
  };
}

function determineMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html':
    case '.htm':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.woff':
      return 'font/woff';
    case '.woff2':
      return 'font/woff2';
    case '.ttf':
      return 'font/ttf';
    default:
      return 'application/octet-stream';
  }
}

function serveProductImage(req, res, segments) {
  if (!fs.existsSync(PRODUCT_IMAGES_DIR)) {
    sendJson(res, 404, { error: 'Image library unavailable.' });
    return;
  }
  const relativeSegments = segments.slice(1).map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch (error) {
      return segment;
    }
  });
  if (!relativeSegments.length || relativeSegments.some((part) => !part)) {
    sendJson(res, 404, { error: 'Image not found.' });
    return;
  }
  const joined = path.join(...relativeSegments);
  const safePath = path.join(PRODUCT_IMAGES_DIR, joined);
  if (!safePath.startsWith(PRODUCT_IMAGES_DIR)) {
    sendJson(res, 400, { error: 'Invalid image path.' });
    return;
  }
  let stat = null;
  try {
    stat = fs.statSync(safePath);
  } catch (error) {
    sendJson(res, 404, { error: 'Image not found.' });
    return;
  }
  if (!stat.isFile()) {
    sendJson(res, 404, { error: 'Image not found.' });
    return;
  }
  const mimeType = determineMimeType(safePath);
  res.writeHead(200, {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=86400',
    'Content-Type': mimeType,
    'Content-Length': stat.size
  });
  fs.createReadStream(safePath).pipe(res);
}

function serveWebAsset(req, res, assetPath) {
  let requested = assetPath || '';
  if (!requested || requested.endsWith('/')) {
    requested = path.join(requested, 'index.html');
  }

  const safePath = path.join(WEB_DIR, requested);
  if (!safePath.startsWith(WEB_DIR)) {
    sendJson(res, 400, { error: 'Invalid asset path.' });
    return;
  }

  let stat = null;
  try {
    stat = fs.statSync(safePath);
  } catch (error) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  if (stat.isDirectory()) {
    const indexPath = path.join(safePath, 'index.html');
    if (fs.existsSync(indexPath)) {
      serveWebAsset(req, res, path.join(assetPath || '', 'index.html'));
      return;
    }
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Directory listing not allowed');
    return;
  }

  const mimeType = determineMimeType(safePath);
  res.writeHead(200, {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': mimeType,
    'Content-Length': stat.size
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const stream = fs.createReadStream(safePath);
  stream.on('error', (error) => {
    console.error('Failed to stream asset:', error);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
    }
    res.end('Unable to read asset.');
  });
  stream.pipe(res);
}

function shouldServeLibraryAsset(pathSegments) {
  if (!Array.isArray(pathSegments) || pathSegments.length === 0) return false;
  if (pathSegments.some((segment) => segment === '..')) return false;

  const [first] = pathSegments;
  if (!first || first.startsWith('.')) return false;
  if (first === 'web' || first === 'api' || first === 'files') return false;
  if (SKIP_UPLOAD_SEARCH_DIRS.has(first)) return false;

  try {
    const stats = fs.statSync(path.join(LIBRARY_ROOT, first));
    return stats.isDirectory();
  } catch (error) {
    return false;
  }
}

/**
 * Serve library asset with black background (for transparent images)
 */
async function serveLibraryAssetWithBlackBg(req, res, assetPath) {
  if (!assetPath) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  const pathParts = assetPath.split('/').filter(Boolean);
  if (!pathParts.length || pathParts.some((part) => part === '..')) {
    sendJson(res, 400, { error: 'Invalid asset path.' });
    return;
  }

  const safePath = path.resolve(LIBRARY_ROOT, assetPath);
  const relative = path.relative(LIBRARY_ROOT, safePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    sendJson(res, 400, { error: 'Invalid asset path.' });
    return;
  }

  let stat = null;
  try {
    stat = fs.statSync(safePath);
  } catch (error) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  if (!stat.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  if (!sharp) {
    // If sharp is not available, serve original
    serveLibraryAsset(req, res, assetPath);
    return;
  }

  try {
    const metadata = await sharp(safePath).metadata();
    const hasAlpha = metadata.hasAlpha;

    // Parse query params for resizing
    const parsed = url.parse(req.url || '', true);
    const query = parsed.query || {};
    const requestedWidth = Number(query.w || query.width || query.maxWidth || 0);
    const maxWidth = Number.isFinite(requestedWidth) && requestedWidth > 0 ? Math.min(requestedWidth, 2400) : null;
    const qualityParam = Number(query.q || query.quality || 0);
    const quality = Number.isFinite(qualityParam) && qualityParam > 0 ? Math.min(Math.max(qualityParam, 40), 95) : 85;

    let transformer;
    let needsBlackBg = hasAlpha;

    // Check if image is predominantly white (even without transparency)
    if (!needsBlackBg) {
      try {
        const stats = await sharp(safePath)
          .resize({ width: 200, withoutEnlargement: true }) // Sample smaller version for speed
          .raw()
          .toBuffer({ resolveWithObject: true });

        const { data, info } = stats;
        const pixelCount = info.width * info.height;
        const channels = info.channels;
        let whitePixelCount = 0;

        // Count pixels that are predominantly white (R, G, B > 240)
        for (let i = 0; i < data.length; i += channels) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          if (r > 240 && g > 240 && b > 240) {
            whitePixelCount++;
          }
        }

        const whitePercentage = (whitePixelCount / pixelCount) * 100;
        // If more than 70% of pixels are white, add black background
        if (whitePercentage > 70) {
          needsBlackBg = true;
          console.log(`[Black BG] Image is ${whitePercentage.toFixed(1)}% white, adding black background`);
        }
      } catch (err) {
        console.error('[Black BG] Error checking white percentage:', err);
        // Continue without white detection if it fails
      }
    }

    if (needsBlackBg) {
      // Image has transparency or is predominantly white - composite onto black background
      const { width, height } = metadata;
      const targetWidth = maxWidth || width;
      const targetHeight = maxWidth ? Math.round(height * (maxWidth / width)) : height;

      transformer = sharp({
        create: {
          width: targetWidth,
          height: targetHeight,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 1 }
        }
      });

      // Resize original if needed, then composite
      const resizedInput = maxWidth
        ? await sharp(safePath).resize({ width: maxWidth, withoutEnlargement: true }).toBuffer()
        : safePath;

      transformer = transformer.composite([{ input: resizedInput }]).png({ quality });
    } else {
      // No transparency and not predominantly white - just serve with optional resize
      transformer = sharp(safePath);
      if (maxWidth) {
        transformer = transformer.resize({ width: maxWidth, withoutEnlargement: true });
      }
      transformer = transformer.png({ quality });
    }

    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400'
    };

    res.writeHead(200, headers);
    transformer.pipe(res);

    transformer.on('error', (error) => {
      console.error('[serveLibraryAssetWithBlackBg] Transform error:', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
      }
      res.end('Image processing failed.');
    });
  } catch (error) {
    console.error('[serveLibraryAssetWithBlackBg] Error:', error);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Image processing failed.');
  }
}

function serveLibraryAsset(req, res, assetPath) {
  if (!assetPath) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  const pathParts = assetPath.split('/').filter(Boolean);
  if (!pathParts.length || pathParts.some((part) => part === '..')) {
    sendJson(res, 400, { error: 'Invalid asset path.' });
    return;
  }

  const safePath = path.resolve(LIBRARY_ROOT, assetPath);
  const relative = path.relative(LIBRARY_ROOT, safePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    sendJson(res, 400, { error: 'Invalid asset path.' });
    return;
  }

  let stat = null;
  try {
    stat = fs.statSync(safePath);
  } catch (error) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  if (!stat.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  const mimeType = determineMimeType(safePath);
  const parsed = url.parse(req.url || '', true);
  const query = parsed.query || {};
  const requestedWidth = Number(query.w || query.width || query.maxWidth || 0);
  const maxWidth = Number.isFinite(requestedWidth) ? requestedWidth : 0;
  const qualityParam = Number(query.q || query.quality || 0);
  const quality = Number.isFinite(qualityParam) && qualityParam > 0 ? Math.min(Math.max(qualityParam, 40), 95) : 82;

  const isTransformableImage =
    sharp &&
    req.method === 'GET' &&
    maxWidth > 0 &&
    mimeType.startsWith('image/') &&
    mimeType !== 'image/svg+xml';

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': mimeType,
    'Cache-Control': 'public, max-age=86400',
    Vary: 'Accept-Encoding'
  };
  if (!isTransformableImage) {
    headers['Content-Length'] = stat.size;
  }

  if (req.method === 'HEAD') {
    res.writeHead(200, headers);
    res.end();
    return;
  }

  res.writeHead(200, headers);

  const stream = fs.createReadStream(safePath);
  stream.on('error', (error) => {
    console.error('Failed to stream library asset:', error);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
    }
    res.end('Unable to read asset.');
  });

  if (!isTransformableImage) {
    stream.pipe(res);
    return;
  }

  const targetWidth = Math.min(Math.max(Math.round(maxWidth), 1), 2400);
  const transformer = sharp();
  transformer.rotate();
  transformer.resize({ width: targetWidth, withoutEnlargement: true });

  if (mimeType === 'image/jpeg') {
    transformer.jpeg({ quality, progressive: true });
  } else if (mimeType === 'image/png') {
    transformer.png({ compressionLevel: 9, adaptiveFiltering: true });
  } else if (mimeType === 'image/webp') {
    transformer.webp({ quality });
  }

  transformer.on('error', (error) => {
    console.error('Image transform error:', error);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
    }
    res.end('Unable to process image.');
  });

  stream.pipe(transformer).pipe(res);
}

function serveSavedFile(res, fileName) {
  if (!fileName || fileName.includes('/') || fileName.includes('\\')) {
    sendJson(res, 400, { error: 'Invalid file name.' });
    return;
  }

  const safePath = path.join(OUTPUT_DIR, fileName);
  if (!safePath.startsWith(OUTPUT_DIR)) {
    sendJson(res, 400, { error: 'File outside allowed directory.' });
    return;
  }

  if (!fs.existsSync(safePath)) {
    sendJson(res, 404, { error: 'File not found.' });
    return;
  }

  const stream = fs.createReadStream(safePath);
  stream.on('error', (error) => {
    console.error('Failed to stream file:', error);
    sendJson(res, 500, { error: 'Failed to read file.' });
  });

  const ext = path.extname(fileName).toLowerCase();
  const mimeType =
    ext === '.png'
      ? 'image/png'
      : ext === '.jpg' || ext === '.jpeg'
      ? 'image/jpeg'
      : ext === '.svg'
      ? 'image/svg+xml'
      : ext === '.pdf'
      ? 'application/pdf'
      : 'application/octet-stream';

  res.writeHead(200, {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': mimeType,
    'Content-Disposition': `attachment; filename="${path.basename(fileName)}"`
  });
  stream.pipe(res);
}

function collectRequestBody(req, callback) {
  let body = '';
  let size = 0;

  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_SIZE) {
      callback(new Error('Payload too large.'));
      req.destroy();
      return;
    }
    body += chunk;
  });

  req.on('end', () => callback(null, body));
  req.on('error', (error) => callback(error));
}

// Promise-based JSON body parser
function getReqBodyJson(req) {
  return new Promise((resolve, reject) => {
    collectRequestBody(req, (err, body) => {
      if (err) {
        reject(err);
        return;
      }
      try {
        const json = body ? JSON.parse(body) : {};
        resolve(json);
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
  });
}

function parseMultipartForm(req, options = {}) {
  return new Promise((resolve, reject) => {
    const form = formidable({
      multiples: true,
      keepExtensions: true,
      allowEmptyFiles: false,
      maxFiles: 10,
      maxFileSize: 50 * 1024 * 1024,
      ...options
    });

    form.parse(req, (error, fields, files) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ fields, files });
    });
  });
}

function fieldValue(fields, name) {
  if (!fields || typeof fields !== 'object') return '';
  const value = fields[name];
  if (value == null) return '';
  if (Array.isArray(value)) {
    return fieldValue({ value: value[0] }, 'value');
  }
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
  return '';
}

function sanitizeCategoryFolderName(rawName) {
  const value = fieldValue({ value: rawName }, 'value');
  const sanitized = value
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^\.+|\.+$/g, '')
    .trim();
  if (!sanitized) {
    return '';
  }
  return sanitized.slice(0, 80);
}

function listFormFiles(input) {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input.flatMap((item) => listFormFiles(item));
  }
  if (typeof input === 'object' && input.filepath) {
    return [input];
  }
  return [];
}

function deleteIfExists(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true });
    }
  } catch (error) {
    console.warn('Unable to delete temp file:', filePath, error.message);
  }
}

function ensureDirectorySafe(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function toWebRelative(filePath) {
  return path
    .relative(WEB_DIR, filePath)
    .split(path.sep)
    .join('/');
}

function userError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.expose = true;
  return error;
}

function sanitizeCopy(value, maxLength = 160) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizeCountryCode(value) {
  const code = String(value || '')
    .trim()
    .toUpperCase();
  if (!code) return '';
  return /^[A-Z]{2}$/.test(code) ? code : '';
}

function sanitizeApparelCategoryName(value) {
  const trimmed = sanitizeCopy(value || '', 80);
  if (!trimmed) return '';
  return trimmed
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function normalizeApparelProductType(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase();
  if (!raw) return 'tshirt';
  if (raw === 'apparel') return 'tshirt';
  if (raw === 't-shirt' || raw === 'tee') return 'tshirt';
  if (raw === 'shirt' || raw === 'tee-shirt') return 'tshirt';
  if (raw === 'cap') return 'hat';
  if (KNOWN_APPAREL_PRODUCT_TYPES.has(raw)) return raw;
  return raw.replace(/[^a-z0-9]+/g, '-') || 'tshirt';
}

function parseBooleanFlag(value) {
  if (typeof value === 'boolean') return value;
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (!normalized) return false;
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function readApparelStoreFile() {
  const raw = readFileSafe(APPAREL_STORE_FILE);
  if (!raw) {
    return { ...DEFAULT_APPAREL_STORE };
  }
  try {
    const data = JSON.parse(raw);
    const categories = Array.isArray(data.categories)
      ? data.categories
          .map((entry) => {
            if (!entry) return null;
            const slug = slugify(entry.slug || entry.name || '');
            const name = sanitizeApparelCategoryName(entry.name || entry.slug || '') || null;
            if (!slug || !name) return null;
            return { slug, name };
          })
          .filter(Boolean)
      : [];
    const items = Array.isArray(data.items)
      ? data.items
          .map((item) => {
            if (!item || !item.id) return null;
            const categorySlug = slugify(item.categorySlug || item.category || item.categoryName || '');
            const categoryName = sanitizeApparelCategoryName(item.categoryName || item.category || '') || null;
            return {
              id: String(item.id),
              name: sanitizeCopy(item.name || 'Apparel item', 120) || 'Apparel item',
              productType: normalizeApparelProductType(item.productType || 'tshirt'),
              categorySlug,
              categoryName: categoryName || null,
              preview: item.preview || item.previewUrl || null,
              previewPath: item.previewPath || null,
              libraryCategory: item.libraryCategory || null,
              libraryCategorySlug: item.libraryCategorySlug || null,
              sources: Array.isArray(item.sources) ? item.sources : [],
              createdAt: item.createdAt || null,
              updatedAt: item.updatedAt || null
            };
          })
          .filter(Boolean)
      : [];
    return {
      updatedAt: data.updatedAt || null,
      categories,
      items
    };
  } catch (error) {
    console.warn('Unable to parse apparel store file:', error.message);
    return { ...DEFAULT_APPAREL_STORE };
  }
}

function saveApparelStore(store) {
  const payload = {
    updatedAt: store.updatedAt || null,
    categories: store.categories || [],
    items: store.items || []
  };
  fs.mkdirSync(path.dirname(APPAREL_STORE_FILE), { recursive: true });
  fs.writeFileSync(APPAREL_STORE_FILE, JSON.stringify(payload, null, 2), 'utf8');
}

function loadApparelStore() {
  const store = readApparelStoreFile();
  store.categories = Array.from(
    new Map(store.categories.map((entry) => [entry.slug, entry])).values()
  ).sort((a, b) => a.name.localeCompare(b.name));
  store.items = Array.from(
    new Map(store.items.map((entry) => [entry.id, entry])).values()
  ).sort((a, b) => a.name.localeCompare(b.name));
  return store;
}

function ensureApparelCategory(store, slug, name) {
  if (!slug || !name) return;
  const existing = store.categories.find((entry) => entry.slug === slug);
  if (existing) {
    if (existing.name !== name) {
      existing.name = name;
    }
  } else {
    store.categories.push({ slug, name });
  }
  store.categories.sort((a, b) => a.name.localeCompare(b.name));
  store.items = store.items.map((item) =>
    item.categorySlug === slug ? { ...item, categoryName: name } : item
  );
}

function registerApparelDesign(entry) {
  const store = loadApparelStore();
  const now = new Date().toISOString();
  const categorySlug = slugify(entry.categoryName || 'apparel');
  const categoryName = sanitizeApparelCategoryName(entry.categoryName || 'Apparel');
  ensureApparelCategory(store, categorySlug, categoryName);

  const nextItem = {
    id: entry.id,
    name: sanitizeCopy(entry.name || 'Apparel design', 120) || 'Apparel design',
    productType: normalizeApparelProductType(entry.productType || 'tshirt'),
    categorySlug,
    categoryName,
    preview: entry.previewUrl || entry.previewPath || null,
    previewPath: entry.previewPath || null,
    libraryCategory: entry.libraryCategory || null,
    libraryCategorySlug: entry.libraryCategorySlug || null,
    sources: Array.isArray(entry.sources) ? entry.sources : [],
    createdAt: null,
    updatedAt: now
  };

  const items = store.items || [];
  const existingIndex = items.findIndex((item) => item.id === nextItem.id);
  if (existingIndex >= 0) {
    const existing = items[existingIndex];
    nextItem.createdAt = existing.createdAt || now;
    items[existingIndex] = { ...existing, ...nextItem };
  } else {
    nextItem.createdAt = now;
    items.push(nextItem);
  }

  store.items = items.sort((a, b) => a.name.localeCompare(b.name));
  store.updatedAt = now;
  saveApparelStore(store);
  return nextItem;
}

function addApparelCategory(name) {
  const normalizedName = sanitizeApparelCategoryName(name);
  if (!normalizedName) {
    throw userError('Category name is required.');
  }
  const slug = slugify(normalizedName);
  const store = loadApparelStore();
  ensureApparelCategory(store, slug, normalizedName);
  store.updatedAt = new Date().toISOString();
  saveApparelStore(store);
  return {
    slug,
    name: normalizedName
  };
}

function updateApparelStoreItem(itemId, updates = {}) {
  const normalizedId = sanitizeCopy(itemId, 160);
  if (!normalizedId) {
    throw userError('Apparel item id is required.');
  }
  const store = loadApparelStore();
  const index = store.items.findIndex((entry) => entry.id === normalizedId);
  if (index < 0) {
    throw userError('Apparel item not found.');
  }
  const now = new Date().toISOString();
  const current = { ...store.items[index] };

  if (Object.prototype.hasOwnProperty.call(updates, 'name')) {
    const name = sanitizeCopy(updates.name, 120);
    if (!name) {
      throw userError('Display name is required.');
    }
    current.name = name;
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'productType')) {
    current.productType = normalizeApparelProductType(updates.productType || 'tshirt');
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'categoryName')) {
    const categoryName = sanitizeApparelCategoryName(updates.categoryName);
    if (!categoryName) {
      throw userError('Category name is required.');
    }
    const categorySlug = slugify(categoryName);
    ensureApparelCategory(store, categorySlug, categoryName);
    current.categorySlug = categorySlug;
    current.categoryName = categoryName;
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'libraryCategory')) {
    const libraryCategory = sanitizeCopy(updates.libraryCategory, 120);
    current.libraryCategory = libraryCategory || null;
    current.libraryCategorySlug = libraryCategory ? slugify(libraryCategory) : null;
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'libraryCategorySlug')) {
    const slug = sanitizeCopy(updates.libraryCategorySlug, 120);
    current.libraryCategorySlug = slug || (current.libraryCategory ? slugify(current.libraryCategory) : null);
  }

  current.updatedAt = now;
  store.items[index] = current;
  store.updatedAt = now;
  saveApparelStore(store);
  return current;
}

function sanitizeFileName(value, fallback = 'file') {
  const base = String(value || fallback)
    .replace(/[\r\n]+/g, ' ')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .trim();
  return base || fallback;
}

function sendFileResponse(res, filePath, fileName, mimeType) {
  if (!fs.existsSync(filePath)) {
    sendJson(res, 404, { error: 'File not found.' });
    return;
  }
  const resolvedMime = mimeType || determineMimeType(filePath);
  const stream = fs.createReadStream(filePath);
  const stats = fs.statSync(filePath);
  res.writeHead(200, {
    'Content-Type': resolvedMime,
    'Content-Length': stats.size,
    'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName || path.basename(filePath))}"`,
    'Access-Control-Allow-Origin': '*'
  });
  stream.pipe(res);
}

function loadCatalogSnapshot() {
  const catalogPath = path.join(WEB_DIR, 'catalog.json');
  try {
    const raw = fs.readFileSync(catalogPath, 'utf8');
    const data = JSON.parse(raw);
    return data;
  } catch (error) {
    console.error('Unable to read catalog snapshot:', error);
    return null;
  }
}

function resolveCustomerProfile(token) {
  if (!token) return null;
  try {
    const customer = db.getCustomerByToken(token);
    if (!customer) return null;
    return {
      id: customer.id,
      name: customer.name || '',
      email: customer.email || '',
      phone: customer.phone || '',
      address: customer.address || '',
      smsOptIn: Boolean(customer.smsOptIn)
    };
  } catch (error) {
    console.warn('Unable to resolve customer profile:', error.message || error);
    return null;
  }
}

/**
 * Serve a catalog JSON file
 * @param {Object} req - HTTP request
 * @param {Object} res - HTTP response
 * @param {string} catalogType - 'apparel' or 'decal-icons'
 */
function serveCatalogResponse(req, res, catalogType = 'apparel') {
  const catalogFile = catalogType === 'decal-icons' ? 'catalog-decal-icons.json' : 'catalog.json';
  const catalogPath = path.join(WEB_DIR, catalogFile);
  fs.stat(catalogPath, (error, stats) => {
    if (error || !stats?.isFile?.()) {
      sendJson(res, 404, { error: 'Catalog not found.' });
      return;
    }

    const lastModified = stats.mtime.toUTCString();
    const etag = `"${stats.size}-${Number(stats.mtimeMs)}"`;
    const headers = {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=600',
      'Last-Modified': lastModified,
      ETag: etag,
      'Access-Control-Allow-Origin': '*',
      Vary: 'Accept-Encoding'
    };

    const ifNoneMatch = req.headers['if-none-match'];
    if (
      ifNoneMatch &&
      ifNoneMatch
        .split(',')
        .map((value) => value.trim())
        .includes(etag)
    ) {
      res.writeHead(304, headers);
      res.end();
      return;
    }

    const ifModifiedSince = req.headers['if-modified-since'];
    if (ifModifiedSince) {
      const sinceTime = Number(new Date(ifModifiedSince));
      if (!Number.isNaN(sinceTime) && sinceTime >= stats.mtimeMs) {
        res.writeHead(304, headers);
        res.end();
        return;
      }
    }

    if (req.method === 'HEAD') {
      res.writeHead(200, headers);
      res.end();
      return;
    }

    const acceptEncoding = req.headers['accept-encoding'] || '';
    const readStream = fs.createReadStream(catalogPath);

    const handleStreamError = (streamError) => {
      console.error('Catalog stream error:', streamError);
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'Unable to stream catalog.' });
      } else {
        res.destroy(streamError);
      }
    };

    readStream.on('error', handleStreamError);

    if (/\bbr\b/.test(acceptEncoding) && typeof zlib.createBrotliCompress === 'function') {
      headers['Content-Encoding'] = 'br';
      res.writeHead(200, headers);
      const brotli = zlib.createBrotliCompress({
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: 5
        }
      });
      brotli.on('error', handleStreamError);
      readStream.pipe(brotli).pipe(res);
    } else if (/\bgzip\b/.test(acceptEncoding)) {
      headers['Content-Encoding'] = 'gzip';
      res.writeHead(200, headers);
      const gzip = zlib.createGzip({ level: 5 });
      gzip.on('error', handleStreamError);
      readStream.pipe(gzip).pipe(res);
    } else {
      res.writeHead(200, headers);
      readStream.pipe(res);
    }
  });
}

function parseCookies(req) {
  const header = req.headers['cookie'] || '';
  const out = {};
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = decodeURIComponent(pair.slice(idx + 1).trim());
    if (k) out[k] = v;
  });
  return out;
}

function setCampaignCookie(res, slug) {
  if (!slug || !res?.setHeader) return;
  const cookie = `scv_campaign=${encodeURIComponent(slug)}; Path=/; Max-Age=${7 * 24 * 60 * 60}; SameSite=Lax`;
  const existing = res.getHeader && res.getHeader('Set-Cookie');
  if (existing) {
    const arr = Array.isArray(existing) ? existing.concat([cookie]) : [existing, cookie];
    res.setHeader('Set-Cookie', arr);
  } else {
    res.setHeader('Set-Cookie', cookie);
  }
}

function findDesignInCatalog(catalog, categorySlug, designId) {
  if (!catalog) return { category: null, design: null };
  const categories = Array.isArray(catalog.categories) ? catalog.categories : [];
  const category = categories.find((entry) => entry.slug === categorySlug) || null;
  const design = category?.designs?.find((entry) => entry.id === designId) || null;
  return { category, design };
}

function readSpecialsFile() {
  try {
    const raw = fs.readFileSync(SPECIALS_FILE, 'utf8');
    const data = JSON.parse(raw);
    const items = Array.isArray(data.items) ? data.items : [];
    return { items, updatedAt: data.updatedAt || null };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('Unable to read specials file:', error.message);
    }
    return { items: [], updatedAt: null };
  }
}

function writeSpecialsFile(items) {
  const payload = {
    updatedAt: new Date().toISOString(),
    items
  };
  fs.mkdirSync(path.dirname(SPECIALS_FILE), { recursive: true });
  fs.writeFileSync(SPECIALS_FILE, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

function resolveSpecialEntry(entry, catalog) {
  const assetRoot = process.env.ASSET_BASE_URL || catalog?.assetRoot || '';
  const { category, design } = findDesignInCatalog(catalog, entry.categorySlug, entry.designId);
  const resolved = {
    id: `${entry.categorySlug}:${entry.designId}`,
    categorySlug: entry.categorySlug,
    designId: entry.designId,
    title: entry.title,
    tagline: entry.tagline || '',
    categoryName: category?.name || null,
    designName: design?.name || null,
    image: buildAssetProxyUrl(design?.image, assetRoot),
    sources: buildSourceProxyMap(design?.sources, assetRoot),
    missing: !design
  };
  return resolved;
}

function buildSpecialsResponse({ includeMissing = false } = {}) {
  const { items, updatedAt } = readSpecialsFile();
  const catalog = loadCatalogSnapshot();
  const resolved = items.map((entry) => resolveSpecialEntry(entry, catalog));
  const filtered = includeMissing ? resolved : resolved.filter((entry) => !entry.missing && entry.image);
  return {
    updatedAt,
    assetRoot: process.env.ASSET_BASE_URL || catalog?.assetRoot || null,
    items: filtered
  };
}

function normalizeSpecialsPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw userError('Invalid payload.');
  }
  const rawItems = Array.isArray(payload.items) ? payload.items : [];
  if (rawItems.length > MAX_SPECIAL_ITEMS) {
    throw userError(`You can feature up to ${MAX_SPECIAL_ITEMS} designs at a time.`);
  }

  const catalog = loadCatalogSnapshot();
  if (!catalog) {
    throw new Error('Catalog data is unavailable. Regenerate the catalog and try again.');
  }

  const seen = new Set();
  const normalized = rawItems.map((item, index) => {
    const categorySlug = sanitizeCopy(item?.categorySlug || '', 80).toLowerCase();
    const designId = sanitizeCopy(item?.designId || '', 80).toLowerCase();
    if (!categorySlug || !designId) {
      throw userError(`Item #${index + 1} is missing the category or design selection.`);
    }
    const key = `${categorySlug}:${designId}`;
    if (seen.has(key)) {
      throw userError('Each featured design must be unique.');
    }
    seen.add(key);

    const { category, design } = findDesignInCatalog(catalog, categorySlug, designId);
    if (!category || !design) {
      throw userError(`The selected design #${index + 1} could not be found in the catalog.`);
    }
    const title =
      sanitizeCopy(item?.title, 80) || design.name || design.id.replace(/[-_]/g, ' ');
    const tagline = sanitizeCopy(item?.tagline, 160);

    return {
      categorySlug,
      designId: design.id,
      title,
      tagline
    };
  });

  return normalized;
}

function extractToken(req) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : null;
}

function requireAuth(req, res) {
  const token = extractToken(req);
  if (!token) {
    sendJson(res, 401, { error: 'Authorization required.' });
    return null;
  }
  const customer = db.getCustomerByToken(token);
  if (!customer) {
    sendJson(res, 401, { error: 'Invalid or expired session.' });
    return null;
  }
  return { ...customer, token };
}

function requireInternalKey(req, res) {
  if (!INTERNAL_API_KEY) {
    return true;
  }
  const key = req.headers['x-api-key'];
  if (!key || key !== INTERNAL_API_KEY) {
    sendJson(res, 401, { error: 'Invalid or missing API key.' });
    return false;
  }
  return true;
}

function listInboundMessages({ since = null, from = '', phone = '', limit = 100 } = {}) {
  const params = [];
  let sql = `SELECT id, provider, provider_message_id AS providerId, from_phone AS fromPhone, to_phone AS toPhone, body, customer_id AS customerId, created_at AS createdAt
             FROM inbound_messages`;
  const where = [];
  if (since) {
    where.push('datetime(created_at) >= datetime(?)');
    params.push(since);
  }
  if (from) {
    where.push('(from_phone = ? OR from_phone LIKE ? )');
    params.push(from);
    params.push(`%${from}%`);
  }
  if (phone) {
    where.push('((from_phone = ? OR from_phone LIKE ?) OR (to_phone = ? OR to_phone LIKE ?))');
    params.push(phone, `%${phone}%`, phone, `%${phone}%`);
  }
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  sql += ' ORDER BY datetime(created_at) DESC LIMIT ?';
  params.push(Math.max(1, Math.min(Number(limit) || 100, 500)));
  try {
    const rows = db._rawAll ? db._rawAll(sql, params) : require('better-sqlite3')(dbPath);
  } catch (e) {}
  try {
    const Database = require('better-sqlite3');
    const sqlite = new Database(require('path').join(process.env.LIBRARY_ROOT || require('path').resolve(__dirname, '..'), 'data', 'store.db'));
    const stmt = sqlite.prepare(sql);
    const rows = stmt.all(...params);
    sqlite.close();
    return rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      providerId: r.providerId,
      from: r.fromPhone,
      to: r.toPhone,
      body: r.body,
      customerId: r.customerId,
      createdAt: r.createdAt
    }));
  } catch (e) {
    console.error('DB list inbound error:', e);
    return [];
  }
}

// Vendor config (persisted)
const VENDOR_CONFIG_PATH = path.join(DATA_DIR, 'vendor-config.json');

function readVendorConfig() {
  try {
    const raw = fs.readFileSync(VENDOR_CONFIG_PATH, 'utf8');
    const json = JSON.parse(raw);
    return json && typeof json === 'object' ? json : {};
  } catch (_) {
    return {};
  }
}

function writeVendorConfig(config) {
  try {
    const dir = path.dirname(VENDOR_CONFIG_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(VENDOR_CONFIG_PATH, JSON.stringify(config || {}, null, 2));
    return true;
  } catch (error) {
    console.error('Unable to write vendor config:', error);
    return false;
  }
}

function normalizeSsawOrderPayload(input = {}) {
  const po = String(input.poNumber || input.CustomerPO || `INV-${Date.now()}`);
  const rawItems = Array.isArray(input.items)
    ? input.items
    : Array.isArray(input.Lines)
    ? input.Lines
    : [];
  const lines = rawItems
    .map((it) => {
      const sku = it.sku || it.Sku || it.SKU;
      const qtyRaw = it.qty ?? it.quantity ?? it.Qty ?? it.Quantity;
      const qty = Number(qtyRaw);
      if (!sku || !Number.isFinite(qty) || qty <= 0) return null;
      // SSAW expects Identifier (SKU) and Qty for each line
      return { Identifier: String(sku), Qty: Math.round(qty) };
    })
    .filter(Boolean);

  const ship = input.shipping || input.ShippingAddress || {};
  const shippingAddress = {
    Customer: ship.customer || process.env.SSAW_SHIP_CUSTOMER || 'Swayze Custom Vinyl',
    Attn: ship.attn || process.env.SSAW_SHIP_ATTN || '',
    Address: ship.address || ship.address1 || process.env.SSAW_SHIP_ADDRESS1 || '',
    City: ship.city || process.env.SSAW_SHIP_CITY || '',
    State: ship.state || process.env.SSAW_SHIP_STATE || '',
    Zip: String(ship.zip || process.env.SSAW_SHIP_ZIP || ''),
    Country: ship.country || process.env.SSAW_SHIP_COUNTRY || 'US',
    Phone: ship.phone || process.env.SSAW_SHIP_PHONE || '',
    Residential: Boolean(
      ship.residential !== undefined ? ship.residential : process.env.SSAW_SHIP_RESIDENTIAL === '1'
    )
  };

  // Resolve requested warehouses
  let warehouses = [];
  if (Array.isArray(input.warehouses)) {
    warehouses = input.warehouses
      .map((w) => String(w || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4))
      .filter(Boolean);
  } else if (Array.isArray(input.Warehouses)) {
    warehouses = input.Warehouses
      .map((w) => String(w || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4))
      .filter(Boolean);
  } else {
    const cfg = readVendorConfig();
    const pref = (cfg?.ssaw?.preferredWarehouse || process.env.SSAW_PREF_WAREHOUSE || '')
      .toUpperCase()
      .replace(/[^A-Z]/g, '')
      .slice(0, 4);
    if (pref) warehouses = [pref];
  }

  const payload = {
    CustomerPO: po,
    ShippingAddress: shippingAddress,
    ShippingMethod: String(input.shippingMethod || process.env.SSAW_SHIP_METHOD || '1'),
    Lines: lines.map((ln) => (warehouses.length ? { ...ln, WarehouseAbbr: warehouses[0] } : ln)),
    Notes: input.notes || ''
  };
  // Optional payment profile (some accounts require this)
  try {
    let paymentProfile = input.paymentProfile ?? input.PaymentProfile ?? null;
    if (!paymentProfile) {
      const cfg = readVendorConfig();
      paymentProfile = cfg?.ssaw?.paymentProfile || process.env.SSAW_PAYMENT_PROFILE || null;
    }
    if (paymentProfile) {
      const cfg = readVendorConfig();
      const emailFallback = (cfg?.ssaw?.paymentEmail || process.env.SSAW_PAYMENT_EMAIL || process.env.ORDERS_SMTP_USER || '').trim();
      const defaultType = (process.env.SSAW_PAYMENT_TYPE || 'CreditCard').trim();
      const customerProfileIdEnv = (process.env.SSAW_CUSTOMER_PROFILE_ID || '').trim();
      if (typeof paymentProfile === 'string') {
        const trimmed = paymentProfile.trim();
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
          try {
            payload.PaymentProfile = JSON.parse(trimmed);
          } catch (_) {
            payload.PaymentProfile = { PaymentProfileID: trimmed };
          }
        } else {
          // Wrap raw profile id into an object so we can include Email/Type
          payload.PaymentProfile = { PaymentProfileID: trimmed };
        }
      } else if (typeof paymentProfile === 'object') {
        payload.PaymentProfile = paymentProfile;
      }
      if (payload.PaymentProfile && typeof payload.PaymentProfile === 'object') {
        if (!payload.PaymentProfile.PaymentType && defaultType) {
          payload.PaymentProfile.PaymentType = defaultType;
        }
        if (!payload.PaymentProfile.Email && emailFallback) {
          payload.PaymentProfile.Email = emailFallback;
        }
        if (!payload.PaymentProfile.CustomerProfileID && customerProfileIdEnv) {
          payload.PaymentProfile.CustomerProfileID = customerProfileIdEnv;
        }
        // Normalize key name: some accounts expect ProfileID instead of PaymentProfileID
        if (payload.PaymentProfile.PaymentProfileID && !payload.PaymentProfile.ProfileID) {
          payload.PaymentProfile.ProfileID = payload.PaymentProfile.PaymentProfileID;
        }
        if (payload.PaymentProfile.ProfileID && !payload.PaymentProfile.PaymentProfileID) {
          payload.PaymentProfile.PaymentProfileID = payload.PaymentProfile.ProfileID;
        }
        // Mirror Email to alias key expected by some accounts
        if (payload.PaymentProfile['PaymentProfile-Email'] && !payload.PaymentProfile.Email) {
          payload.PaymentProfile.Email = payload.PaymentProfile['PaymentProfile-Email'];
        }
        if (payload.PaymentProfile.Email && !payload.PaymentProfile['PaymentProfile-Email']) {
          payload.PaymentProfile['PaymentProfile-Email'] = payload.PaymentProfile.Email;
        }
        // Ensure IDs are sent as strings
        ['CustomerProfileID', 'PaymentProfileID', 'ProfileID'].forEach((key) => {
          if (
            Object.prototype.hasOwnProperty.call(payload.PaymentProfile, key) &&
            payload.PaymentProfile[key] != null
          ) {
            payload.PaymentProfile[key] = String(payload.PaymentProfile[key]);
          }
        });
      }
    }
  } catch (_) {
    // ignore payment profile mapping errors
  }
  if (warehouses.length) {
    payload.Warehouses = warehouses;
  }
  if (input.allowSplit !== undefined) {
    payload.AllowSplit = Boolean(input.allowSplit);
  }
  return payload;
}

function toApiOrder(order) {
  let podInfo = null;
  try {
    const id = order.id || '';
    const match = /^shopify-([^-\s]+)-([^-\s]+)$/.exec(String(id));
    if (match && typeof db.getPodLineItemByShopifyId === 'function') {
      const shopifyOrderId = match[1];
      const shopifyLineItemId = match[2];
      const podLine = db.getPodLineItemByShopifyId(shopifyLineItemId);
      if (podLine) {
        const podOrder =
          typeof db.getPodOrderByShopifyOrderId === 'function'
            ? db.getPodOrderByShopifyOrderId(shopifyOrderId)
            : null;
        podInfo = {
          shopifyOrderId,
          shopifyLineItemId,
          sku: podLine.sku || null,
          podArtworkPath: podLine.artworkPath || null,
          podStatus: podLine.status || 'pending',
          podProperties: podLine.properties || null,
          podShippingName: podOrder ? podOrder.shippingName || null : null,
          podShippingAddress: podOrder ? podOrder.shippingAddress || null : null
        };
      }
    }
  } catch (_) {}

  return {
    id: order.id,
    orderNumber: order.orderNumber,
    designId: order.designId,
    designName: order.designName,
    productType: order.productType || null,
    category: order.category,
    size: order.size,
    color: order.color,
    background: order.background,
    quantity: order.quantity,
    notes: order.notes,
    textLayers: order.textLayers,
    savedAt: order.savedAt,
    paid: order.paid,
    customer: order.customer,
    internalNotes: order.internalNotes,
    previewFile: order.previewFile,
    metadataPath: order.metadataFile ? path.posix.join('saved-designs', order.metadataFile) : null,
    sourceCopies: order.sourceCopies,
    apparelItems: Array.isArray(order.apparelItems) ? order.apparelItems : [],
    inventoryUsage: Array.isArray(order.inventoryUsage) ? order.inventoryUsage : [],
    pricing: order.pricing,
    paymentLink: order.paymentLink,
    paymentLinkId: order.paymentLinkId,
    paymentStatus: order.paymentStatus,
    paymentDetails: order.paymentDetails,
    downloadedAt: order.downloadedAt,
    downloadedBy: order.downloadedBy,
    completedAt: order.completedAt,
    bytes: order.bytes,
    // POD/Shopify metadata (optional; present for Shopify POD line items)
    pod: Boolean(podInfo),
    shopifyOrderId: podInfo ? podInfo.shopifyOrderId : null,
    shopifyLineItemId: podInfo ? podInfo.shopifyLineItemId : null,
    sku: podInfo ? podInfo.sku : null,
    podArtworkPath: podInfo ? podInfo.podArtworkPath : null,
    podStatus: podInfo ? podInfo.podStatus : null,
    podProperties: podInfo ? podInfo.podProperties : null,
    podShippingName: podInfo ? podInfo.podShippingName : null,
    podShippingAddress: podInfo ? podInfo.podShippingAddress : null
  };
}

function toApiRaceQuote(quote) {
  if (!quote) return null;
  return {
    id: quote.id,
    quoteNumber: quote.quoteNumber,
    customerId: quote.customerId,
    business: quote.business,
    contactName: quote.contactName,
    requestDate: quote.requestDate,
    vehicle: quote.vehicle,
    colors: quote.colors,
    packageOption: quote.packageOption,
    addons: quote.addons,
    notes: quote.notes,
    status: quote.status,
    baseCents: quote.baseCents,
    addonsCents: quote.addonsCents,
    subtotalCents: quote.subtotalCents,
    taxCents: quote.taxCents,
    totalCents: quote.totalCents,
    adminNotes: quote.adminNotes,
    paymentLink: quote.paymentLink,
    paymentLinkId: quote.paymentLinkId,
    paymentStatus: quote.paymentStatus,
    timelineText: quote.timelineText,
    deliveryText: quote.deliveryText,
    pricingNotes: quote.pricingNotes,
    quoteValidUntil: quote.quoteValidUntil,
    customerResponse: quote.customerResponse,
    customerResponseAt: quote.customerResponseAt,
    racingBody: quote.racingBody,
    carNumber: quote.carNumber,
    coDriver: quote.coDriver,
    driverCountry: quote.driverCountry || '',
    coDriverCountry: quote.coDriverCountry || '',
    sponsors: Array.isArray(quote.sponsors) ? quote.sponsors : [],
    createdAt: quote.createdAt,
    updatedAt: quote.updatedAt,
    customer: quote.customer
  };
}

const requestHandler = async (req, res) => {
  const parsedUrl = url.parse(req.url || '', true);
  const segments = (parsedUrl.pathname || '').split('/').filter(Boolean);

  if (req.method === 'OPTIONS') {
    handleOptions(res);
    return;
  }

  // Lightweight health check for POD/Shopify backend
  if (req.method === 'GET' && parsedUrl.pathname === '/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // ===========================================
  // Print Station Auto-Updates
  // ===========================================
  // Serves update files for electron-updater
  // Files should be placed in: server/updates/print-station/
  // Required files after build: latest.yml, Vinyl Print Station Setup X.X.X.exe
  if (parsedUrl.pathname.startsWith('/updates/print-station/')) {
    const fileName = parsedUrl.pathname.replace('/updates/print-station/', '');
    const updateDir = path.resolve(__dirname, 'updates', 'print-station');
    const filePath = path.join(updateDir, fileName);

    // Security: prevent path traversal
    if (!filePath.startsWith(updateDir)) {
      sendJson(res, 403, { error: 'Invalid path' });
      return;
    }

    // Create updates directory if it doesn't exist
    if (!fs.existsSync(updateDir)) {
      fs.mkdirSync(updateDir, { recursive: true });
    }

    if (!fs.existsSync(filePath)) {
      sendJson(res, 404, { error: 'Update file not found', file: fileName });
      return;
    }

    // Determine content type
    const ext = path.extname(fileName).toLowerCase();
    const contentTypes = {
      '.yml': 'text/yaml',
      '.yaml': 'text/yaml',
      '.exe': 'application/octet-stream',
      '.dmg': 'application/octet-stream',
      '.zip': 'application/zip',
      '.blockmap': 'application/octet-stream',
      '.json': 'application/json'
    };
    const contentType = contentTypes[ext] || 'application/octet-stream';

    try {
      const stat = fs.statSync(filePath);
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': stat.size,
        'Cache-Control': 'no-cache'
      });
      fs.createReadStream(filePath).pipe(res);
    } catch (err) {
      console.error('[Updates] Error serving file:', err);
      sendJson(res, 500, { error: 'Error serving file' });
    }
    return;
  }

  // ===========================================
  // Etsy OAuth 2.0 Flow
  // ===========================================

  // GET /oauth/etsy - Start OAuth flow (redirects to Etsy)
  if (req.method === 'GET' && parsedUrl.pathname === '/oauth/etsy') {
    try {
      const etsy = require('./integrations/etsy');
      if (!etsy.isConfigured()) {
        sendJson(res, 500, { error: 'Etsy API not configured. Set ETSY_API_KEY and ETSY_API_SECRET in .env' });
        return;
      }
      const { url, state } = etsy.startOAuthFlow();
      console.log('[Etsy OAuth] Redirecting to Etsy for authorization...');
      res.writeHead(302, { Location: url });
      res.end();
    } catch (err) {
      console.error('[Etsy OAuth] Start error:', err);
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // GET /oauth/etsy/callback - Handle OAuth callback from Etsy
  if (req.method === 'GET' && parsedUrl.pathname === '/oauth/etsy/callback') {
    const query = parsedUrl.query || {};
    const code = query.code;
    const state = query.state;
    const error = query.error;

    if (error) {
      console.error('[Etsy OAuth] Error from Etsy:', error, query.error_description);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <html><body style="font-family: system-ui; padding: 40px; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #dc2626;">Etsy Authorization Failed</h1>
          <p><strong>Error:</strong> ${query.error}</p>
          <p>${query.error_description || ''}</p>
          <p><a href="/oauth/etsy">Try again</a></p>
        </body></html>
      `);
      return;
    }

    if (!code || !state) {
      sendJson(res, 400, { error: 'Missing code or state parameter' });
      return;
    }

    (async () => {
      try {
        const etsy = require('./integrations/etsy');
        const tokens = await etsy.completeOAuthFlow(code, state);

        // Get shop info
        let shopInfo = null;
        try {
          const shops = await etsy.getMyShops();
          if (shops.results && shops.results.length > 0) {
            shopInfo = shops.results[0];
          }
        } catch (e) {
          console.log('[Etsy OAuth] Could not fetch shop info:', e.message);
        }

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html><body style="font-family: system-ui; padding: 40px; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #16a34a;">Etsy Connected Successfully!</h1>
            <p>Your Etsy account has been authorized.</p>
            ${shopInfo ? `
              <div style="background: #f3f4f6; padding: 16px; border-radius: 8px; margin: 20px 0;">
                <p><strong>Shop Name:</strong> ${shopInfo.shop_name || 'N/A'}</p>
                <p><strong>Shop ID:</strong> ${shopInfo.shop_id}</p>
                <p style="color: #6b7280; font-size: 14px; margin-top: 12px;">
                  Add this to your .env file:<br>
                  <code style="background: #1f2937; color: #10b981; padding: 4px 8px; border-radius: 4px;">ETSY_SHOP_ID=${shopInfo.shop_id}</code>
                </p>
              </div>
            ` : ''}
            <p>Token expires in: ${Math.round(tokens.expires_in / 3600)} hours</p>
            <p><a href="/api/etsy/status">View Etsy integration status</a></p>
          </body></html>
        `);
      } catch (err) {
        console.error('[Etsy OAuth] Callback error:', err);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html><body style="font-family: system-ui; padding: 40px; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #dc2626;">Etsy Authorization Failed</h1>
            <p><strong>Error:</strong> ${err.message}</p>
            <p><a href="/oauth/etsy">Try again</a></p>
          </body></html>
        `);
      }
    })();
    return;
  }

  // GET /api/etsy/status - Check Etsy connection status
  if (req.method === 'GET' && parsedUrl.pathname === '/api/etsy/status') {
    (async () => {
      try {
        const etsy = require('./integrations/etsy');
        const configured = etsy.isConfigured();
        const hasTokens = etsy.hasValidTokens();
        const tokens = etsy.loadTokens();

        const status = {
          configured,
          authenticated: hasTokens,
          shopId: process.env.ETSY_SHOP_ID || null,
          tokenExpiresAt: tokens?.expires_at ? new Date(tokens.expires_at).toISOString() : null,
          authUrl: configured && !hasTokens ? '/oauth/etsy' : null
        };

        if (hasTokens && process.env.ETSY_SHOP_ID) {
          try {
            const shop = await etsy.getShop();
            status.shop = {
              name: shop.shop_name,
              url: shop.url,
              listingCount: shop.listing_active_count
            };
          } catch (e) {
            status.shopError = e.message;
          }
        }

        sendJson(res, 200, status);
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
    })();
    return;
  }

  // GET /api/etsy/listings - Get shop listings
  if (req.method === 'GET' && parsedUrl.pathname === '/api/etsy/listings') {
    (async () => {
      try {
        const etsy = require('./integrations/etsy');
        if (!etsy.hasValidTokens()) {
          sendJson(res, 401, { error: 'Not authenticated. Visit /oauth/etsy to connect.' });
          return;
        }
        const query = parsedUrl.query || {};
        const listings = await etsy.getListings(null, {
          limit: query.limit || 25,
          offset: query.offset || 0,
          state: query.state || 'active'
        });
        sendJson(res, 200, listings);
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
    })();
    return;
  }

  // POST /api/etsy/sync-product - Sync a Shopify product to Etsy
  if (req.method === 'POST' && parsedUrl.pathname === '/api/etsy/sync-product') {
    collectRequestBody(req, async (error, body) => {
      if (error) { sendJson(res, 413, { error: error.message }); return; }
      try {
        const etsy = require('./integrations/etsy');
        if (!etsy.hasValidTokens()) {
          sendJson(res, 401, { error: 'Not authenticated. Visit /oauth/etsy to connect.' });
          return;
        }

        const payload = JSON.parse(body || '{}');
        const { shopifyProductId, publish = false, priceMultiplier = 1.15 } = payload;

        if (!shopifyProductId) {
          sendJson(res, 400, { error: 'shopifyProductId required' });
          return;
        }

        // Fetch from Shopify
        const shopifyProduct = await shopify.getProduct(shopifyProductId);
        if (!shopifyProduct) {
          sendJson(res, 404, { error: 'Shopify product not found' });
          return;
        }

        // Get or create shipping profile
        let shippingProfileId = null;
        try {
          const profiles = await etsy.getShippingProfiles();
          if (profiles.results && profiles.results.length > 0) {
            shippingProfileId = profiles.results[0].shipping_profile_id;
          } else {
            const newProfile = await etsy.createShippingProfile(null, {
              title: 'Standard Vinyl Shipping',
              primaryCost: 4.99,
              secondaryCost: 1.00,
              minProcessingDays: 1,
              maxProcessingDays: 3
            });
            shippingProfileId = newProfile.shipping_profile_id;
          }
        } catch (e) {
          console.error('[Etsy] Shipping profile error:', e.message);
        }

        // Sync to Etsy
        const listing = await etsy.syncProductToEtsy(shopifyProduct, {
          publish,
          priceMultiplier,
          shippingProfileId,
          taxonomyId: 6648 // Bumper Stickers & Decals
        });

        sendJson(res, 200, {
          success: true,
          etsyListingId: listing.listing_id,
          shopifyProductId,
          published: publish
        });
      } catch (err) {
        console.error('[Etsy] Sync error:', err);
        sendJson(res, 500, { error: err.message, detail: err.detail });
      }
    });
    return;
  }

  // POST /api/etsy/calculate-price - Calculate Etsy price with fees
  if (req.method === 'POST' && parsedUrl.pathname === '/api/etsy/calculate-price') {
    collectRequestBody(req, (error, body) => {
      if (error) { sendJson(res, 413, { error: error.message }); return; }
      try {
        const etsy = require('./integrations/etsy');
        const { basePrice, includeOffsiteAds = false } = JSON.parse(body || '{}');

        if (!basePrice || isNaN(basePrice)) {
          sendJson(res, 400, { error: 'basePrice required' });
          return;
        }

        const etsyPrice = etsy.calculateEtsyPrice(parseFloat(basePrice), includeOffsiteAds);
        const fees = etsy.ETSY_FEES;

        sendJson(res, 200, {
          basePrice: parseFloat(basePrice),
          etsyPrice,
          markup: ((etsyPrice / basePrice - 1) * 100).toFixed(1) + '%',
          fees: {
            listing: fees.listingFee,
            transaction: (fees.transactionFee * 100) + '%',
            payment: (fees.paymentProcessing * 100) + '% + $' + fees.paymentFixed,
            regulatory: (fees.regulatoryFee * 100) + '%',
            offsiteAds: includeOffsiteAds ? '15%' : 'not included'
          }
        });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
    });
    return;
  }

  // ===========================================
  // eBay OAuth 2.0 Flow
  // ===========================================

  // GET /oauth/ebay - Start OAuth flow (redirects to eBay)
  if (req.method === 'GET' && parsedUrl.pathname === '/oauth/ebay') {
    try {
      const ebay = require('./integrations/ebay');
      if (!ebay.isConfigured()) {
        sendJson(res, 500, { error: 'eBay API not configured. Set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET in .env' });
        return;
      }
      const { url, state } = ebay.startOAuthFlow();
      console.log('[eBay OAuth] Redirecting to eBay for authorization...');
      res.writeHead(302, { Location: url });
      res.end();
    } catch (err) {
      console.error('[eBay OAuth] Start error:', err);
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // GET /oauth/ebay/callback - Handle OAuth callback from eBay
  if (req.method === 'GET' && parsedUrl.pathname === '/oauth/ebay/callback') {
    const query = parsedUrl.query || {};
    const code = query.code;
    const state = query.state;
    const error = query.error;

    if (error) {
      console.error('[eBay OAuth] Error from eBay:', error, query.error_description);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <html><body style="font-family: system-ui; padding: 40px; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #dc2626;">eBay Authorization Failed</h1>
          <p><strong>Error:</strong> ${query.error}</p>
          <p>${query.error_description || ''}</p>
          <p><a href="/oauth/ebay">Try again</a></p>
        </body></html>
      `);
      return;
    }

    if (!code || !state) {
      sendJson(res, 400, { error: 'Missing code or state parameter' });
      return;
    }

    (async () => {
      try {
        const ebay = require('./integrations/ebay');
        const tokens = await ebay.completeOAuthFlow(code, state);

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html><body style="font-family: system-ui; padding: 40px; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #16a34a;">eBay Connected Successfully!</h1>
            <p>Your eBay seller account has been authorized.</p>
            <div style="background: #f3f4f6; padding: 16px; border-radius: 8px; margin: 20px 0;">
              <p><strong>Token Type:</strong> ${tokens.token_type}</p>
              <p><strong>Expires In:</strong> ${Math.round(tokens.expires_in / 3600)} hours</p>
            </div>
            <p><a href="/api/ebay/status">View eBay integration status</a></p>
          </body></html>
        `);
      } catch (err) {
        console.error('[eBay OAuth] Callback error:', err);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html><body style="font-family: system-ui; padding: 40px; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #dc2626;">eBay Authorization Failed</h1>
            <p><strong>Error:</strong> ${err.message}</p>
            <p><a href="/oauth/ebay">Try again</a></p>
          </body></html>
        `);
      }
    })();
    return;
  }

  // GET /oauth/ebay/declined - Handle user declining eBay authorization
  if (req.method === 'GET' && parsedUrl.pathname === '/oauth/ebay/declined') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <html><body style="font-family: system-ui; padding: 40px; max-width: 600px; margin: 0 auto;">
        <h1 style="color: #f59e0b;">eBay Authorization Cancelled</h1>
        <p>You chose not to authorize the eBay connection.</p>
        <p>You can try again at any time to connect your eBay seller account.</p>
        <p style="margin-top: 20px;">
          <a href="/oauth/ebay" style="background: #2563eb; color: white; padding: 10px 20px; text-decoration: none; border-radius: 6px;">Try Again</a>
        </p>
      </body></html>
    `);
    return;
  }

  // GET /api/ebay/status - Check eBay connection status
  if (req.method === 'GET' && parsedUrl.pathname === '/api/ebay/status') {
    (async () => {
      try {
        const ebay = require('./integrations/ebay');
        const configured = ebay.isConfigured();
        const hasTokens = ebay.hasValidTokens();
        const tokens = ebay.loadTokens();

        const status = {
          configured,
          authenticated: hasTokens,
          environment: process.env.EBAY_ENVIRONMENT || 'sandbox',
          tokenExpiresAt: tokens?.expires_at ? new Date(tokens.expires_at).toISOString() : null,
          authUrl: configured && !hasTokens ? '/oauth/ebay' : null
        };

        if (hasTokens) {
          try {
            const inventory = await ebay.getInventoryItems({ limit: 1 });
            status.inventoryCount = inventory.total || 0;
          } catch (e) {
            status.inventoryError = e.message;
          }
        }

        sendJson(res, 200, status);
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
    })();
    return;
  }

  // GET /api/ebay/inventory - Get inventory items
  if (req.method === 'GET' && parsedUrl.pathname === '/api/ebay/inventory') {
    (async () => {
      try {
        const ebay = require('./integrations/ebay');
        if (!ebay.hasValidTokens()) {
          sendJson(res, 401, { error: 'Not authenticated. Visit /oauth/ebay to connect.' });
          return;
        }
        const query = parsedUrl.query || {};
        const inventory = await ebay.getInventoryItems({
          limit: query.limit || 25,
          offset: query.offset || 0
        });
        sendJson(res, 200, inventory);
      } catch (err) {
        sendJson(res, 500, { error: err.message, detail: err.detail });
      }
    })();
    return;
  }

  // GET /api/ebay/policies - Get all seller policies
  if (req.method === 'GET' && parsedUrl.pathname === '/api/ebay/policies') {
    (async () => {
      try {
        const ebay = require('./integrations/ebay');
        if (!ebay.hasValidTokens()) {
          sendJson(res, 401, { error: 'Not authenticated. Visit /oauth/ebay to connect.' });
          return;
        }

        const [fulfillment, payment, returns] = await Promise.all([
          ebay.getFulfillmentPolicies().catch(e => ({ error: e.message })),
          ebay.getPaymentPolicies().catch(e => ({ error: e.message })),
          ebay.getReturnPolicies().catch(e => ({ error: e.message }))
        ]);

        sendJson(res, 200, { fulfillment, payment, returns });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
    })();
    return;
  }

  // POST /api/ebay/create-policies - Create default business policies
  if (req.method === 'POST' && parsedUrl.pathname === '/api/ebay/create-policies') {
    (async () => {
      try {
        const ebay = require('./integrations/ebay');
        if (!ebay.hasValidTokens()) {
          sendJson(res, 401, { error: 'Not authenticated. Visit /oauth/ebay to connect.' });
          return;
        }

        const results = {};

        // Create fulfillment policy
        try {
          results.fulfillment = await ebay.createFulfillmentPolicy({
            name: 'Standard Vinyl Shipping',
            handlingDays: 1,
            shippingCost: 4.99,
            additionalCost: 1.00,
            freeShipping: false
          });
        } catch (e) {
          results.fulfillment = { error: e.message };
        }

        // Create return policy
        try {
          results.returns = await ebay.createReturnPolicy({
            name: '30 Day Returns',
            returnsAccepted: true,
            returnDays: 30,
            sellerPaysReturn: false
          });
        } catch (e) {
          results.returns = { error: e.message };
        }

        sendJson(res, 200, results);
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
    })();
    return;
  }

  // POST /api/ebay/sync-product - Sync a Shopify product to eBay
  if (req.method === 'POST' && parsedUrl.pathname === '/api/ebay/sync-product') {
    collectRequestBody(req, async (error, body) => {
      if (error) { sendJson(res, 413, { error: error.message }); return; }
      try {
        const ebay = require('./integrations/ebay');
        if (!ebay.hasValidTokens()) {
          sendJson(res, 401, { error: 'Not authenticated. Visit /oauth/ebay to connect.' });
          return;
        }

        const payload = JSON.parse(body || '{}');
        const { shopifyProductId, publish = false, priceMultiplier = 1.13, storeLevel = 'basic' } = payload;

        if (!shopifyProductId) {
          sendJson(res, 400, { error: 'shopifyProductId required' });
          return;
        }

        // Fetch from Shopify
        const shopifyProduct = await shopify.getProduct(shopifyProductId);
        if (!shopifyProduct) {
          sendJson(res, 404, { error: 'Shopify product not found' });
          return;
        }

        // Sync to eBay
        const result = await ebay.syncProductToEbay(shopifyProduct, {
          publish,
          priceMultiplier,
          storeLevel,
          categoryId: '180098' // Stickers & Decals
        });

        sendJson(res, 200, {
          success: true,
          ...result,
          shopifyProductId
        });
      } catch (err) {
        console.error('[eBay] Sync error:', err);
        sendJson(res, 500, { error: err.message, detail: err.detail });
      }
    });
    return;
  }

  // POST /api/ebay/bulk-sync - Sync all Shopify products to eBay
  if (req.method === 'POST' && parsedUrl.pathname === '/api/ebay/bulk-sync') {
    collectRequestBody(req, async (error, body) => {
      if (error) { sendJson(res, 413, { error: error.message }); return; }
      try {
        const ebay = require('./integrations/ebay');
        if (!ebay.hasValidTokens()) {
          sendJson(res, 401, { error: 'Not authenticated. Visit /oauth/ebay to connect.' });
          return;
        }

        const payload = JSON.parse(body || '{}');
        const {
          publish = false,
          priceMultiplier = 1.15,
          categoryId = '360', // Art Prints category (simpler requirements)
          limit = 50,
          skipExisting = true
        } = payload;

        // Get all Shopify products
        console.log('[eBay] Fetching Shopify products...');
        const shopifyProducts = await shopify.listAllProducts({ limit });
        console.log(`[eBay] Found ${shopifyProducts.length} Shopify products`);

        // Get existing eBay inventory to skip duplicates
        let existingSkus = new Set();
        if (skipExisting) {
          try {
            const inventory = await ebay.getInventoryItems({ limit: 200 });
            if (inventory.inventoryItems) {
              inventory.inventoryItems.forEach(item => existingSkus.add(item.sku));
            }
            console.log(`[eBay] Found ${existingSkus.size} existing eBay items`);
          } catch (e) {
            console.log('[eBay] Could not fetch existing inventory:', e.message);
          }
        }

        // Get merchant location
        let locationKey = null;
        try {
          const locations = await ebay.getMerchantLocations();
          locationKey = locations.locations?.[0]?.merchantLocationKey || 'default';
        } catch (e) {
          console.log('[eBay] No merchant location, will create default');
        }

        // Get policies
        const [fulfillment, returns] = await Promise.all([
          ebay.getFulfillmentPolicies(),
          ebay.getReturnPolicies()
        ]);
        const fulfillmentPolicyId = fulfillment.fulfillmentPolicies?.[0]?.fulfillmentPolicyId;
        const returnPolicyId = returns.returnPolicies?.[0]?.returnPolicyId;

        if (!fulfillmentPolicyId || !returnPolicyId) {
          sendJson(res, 400, { error: 'Business policies not configured' });
          return;
        }

        const results = { synced: [], skipped: [], errors: [] };

        for (const product of shopifyProducts) {
          // Generate unique SKU - match logic in ebay.shopifyToEbayItem
          const variantSku = product.variants?.[0]?.sku;
          const sku = variantSku && variantSku.length > 3
            ? `${variantSku}-${product.id}`
            : `SHOP-${product.id}`;

          // Skip if already exists
          if (skipExisting && existingSkus.has(sku)) {
            results.skipped.push({ sku, title: product.title, reason: 'already exists' });
            continue;
          }

          try {
            // Convert to eBay format
            const ebayItem = ebay.shopifyToEbayItem(product, { priceMultiplier, categoryId });

            // Create inventory item
            await ebay.createOrUpdateInventoryItem(sku, ebayItem);
            console.log(`[eBay] Created inventory: ${sku}`);

            // Create offer if we have policies
            if (publish) {
              const offer = await ebay.createOffer(sku, {
                description: ebayItem.description,
                price: ebayItem.price,
                quantity: 999,
                categoryId,
                fulfillmentPolicyId,
                returnPolicyId,
                locationKey
              });

              // Publish
              const published = await ebay.publishOffer(offer.offerId);
              results.synced.push({
                sku,
                title: product.title,
                offerId: offer.offerId,
                listingId: published.listingId,
                status: 'published'
              });
            } else {
              results.synced.push({ sku, title: product.title, status: 'inventory_only' });
            }

            // Rate limit - wait 500ms between products
            await new Promise(r => setTimeout(r, 500));

          } catch (err) {
            console.error(`[eBay] Error syncing ${sku}:`, err.message);
            results.errors.push({ sku, title: product.title, error: err.message });
          }
        }

        sendJson(res, 200, {
          success: true,
          summary: {
            total: shopifyProducts.length,
            synced: results.synced.length,
            skipped: results.skipped.length,
            errors: results.errors.length
          },
          results
        });

      } catch (err) {
        console.error('[eBay] Bulk sync error:', err);
        sendJson(res, 500, { error: err.message, detail: err.detail });
      }
    });
    return;
  }

  // POST /api/ebay/create-location - Create a merchant location for shipping
  if (req.method === 'POST' && parsedUrl.pathname === '/api/ebay/create-location') {
    collectRequestBody(req, async (error, body) => {
      if (error) { sendJson(res, 413, { error: error.message }); return; }
      try {
        const ebay = require('./integrations/ebay');
        if (!ebay.hasValidTokens()) {
          sendJson(res, 401, { error: 'Not authenticated. Visit /oauth/ebay to connect.' });
          return;
        }

        const payload = JSON.parse(body || '{}');
        const locationKey = payload.locationKey || 'default';

        const result = await ebay.createMerchantLocation(locationKey, {
          name: payload.name || 'Primary Location',
          addressLine1: payload.addressLine1 || '',
          city: payload.city || 'Asheville',
          state: payload.state || 'NC',
          postalCode: payload.postalCode || '28801',
          country: payload.country || 'US'
        });

        sendJson(res, 200, { success: true, locationKey, result });
      } catch (err) {
        console.error('[eBay] Create location error:', err);
        sendJson(res, 500, { error: err.message, detail: err.detail });
      }
    });
    return;
  }

  // GET /api/ebay/locations - Get merchant locations
  if (req.method === 'GET' && parsedUrl.pathname === '/api/ebay/locations') {
    try {
      const ebay = require('./integrations/ebay');
      if (!ebay.hasValidTokens()) {
        sendJson(res, 401, { error: 'Not authenticated. Visit /oauth/ebay to connect.' });
        return;
      }

      const locations = await ebay.getMerchantLocations();
      sendJson(res, 200, locations);
    } catch (err) {
      console.error('[eBay] Get locations error:', err);
      sendJson(res, 500, { error: err.message, detail: err.detail });
    }
    return;
  }

  // GET /api/ebay/offers - Get offers for a SKU
  if (req.method === 'GET' && parsedUrl.pathname === '/api/ebay/offers') {
    (async () => {
      try {
        const ebay = require('./integrations/ebay');
        if (!ebay.hasValidTokens()) {
          sendJson(res, 401, { error: 'Not authenticated. Visit /oauth/ebay to connect.' });
          return;
        }

        const queryParams = parsedUrl.query || {};
        const sku = queryParams.sku;
        if (!sku) {
          sendJson(res, 400, { error: 'sku query parameter required' });
          return;
        }

        const offers = await ebay.getOffers(sku);
        sendJson(res, 200, offers);
      } catch (err) {
        console.error('[eBay] Get offers error:', err);
        sendJson(res, 500, { error: err.message, detail: err.detail });
      }
    })();
    return;
  }

  // POST /api/ebay/publish-offer - Publish an existing offer by ID
  if (req.method === 'POST' && parsedUrl.pathname === '/api/ebay/publish-offer') {
    collectRequestBody(req, async (error, body) => {
      if (error) { sendJson(res, 413, { error: error.message }); return; }
      try {
        const ebay = require('./integrations/ebay');
        if (!ebay.hasValidTokens()) {
          sendJson(res, 401, { error: 'Not authenticated. Visit /oauth/ebay to connect.' });
          return;
        }

        const payload = JSON.parse(body || '{}');
        const { offerId } = payload;

        if (!offerId) {
          sendJson(res, 400, { error: 'offerId required' });
          return;
        }

        const published = await ebay.publishOffer(offerId);
        sendJson(res, 200, {
          success: true,
          offerId,
          listingId: published.listingId,
          status: 'published'
        });
      } catch (err) {
        console.error('[eBay] Publish offer error:', err);
        sendJson(res, 500, { error: err.message, detail: err.detail });
      }
    });
    return;
  }

  // PUT /api/ebay/offer - Update an existing offer
  if (req.method === 'PUT' && parsedUrl.pathname === '/api/ebay/offer') {
    collectRequestBody(req, async (error, body) => {
      if (error) { sendJson(res, 413, { error: error.message }); return; }
      try {
        const ebay = require('./integrations/ebay');
        if (!ebay.hasValidTokens()) {
          sendJson(res, 401, { error: 'Not authenticated. Visit /oauth/ebay to connect.' });
          return;
        }

        const payload = JSON.parse(body || '{}');
        const { offerId, ...updates } = payload;

        if (!offerId) {
          sendJson(res, 400, { error: 'offerId required' });
          return;
        }

        const result = await ebay.updateOffer(offerId, updates);
        sendJson(res, 200, { success: true, offerId, result });
      } catch (err) {
        console.error('[eBay] Update offer error:', err);
        sendJson(res, 500, { error: err.message, detail: err.detail });
      }
    });
    return;
  }

  // POST /api/ebay/publish - Create offer and publish a listing from inventory
  if (req.method === 'POST' && parsedUrl.pathname === '/api/ebay/publish') {
    collectRequestBody(req, async (error, body) => {
      if (error) { sendJson(res, 413, { error: error.message }); return; }
      try {
        const ebay = require('./integrations/ebay');
        if (!ebay.hasValidTokens()) {
          sendJson(res, 401, { error: 'Not authenticated. Visit /oauth/ebay to connect.' });
          return;
        }

        const payload = JSON.parse(body || '{}');
        const { sku, price, categoryId = '159889' } = payload;

        if (!sku) {
          sendJson(res, 400, { error: 'sku required' });
          return;
        }

        // Get policies and locations
        const [fulfillment, returns, locations] = await Promise.all([
          ebay.getFulfillmentPolicies(),
          ebay.getReturnPolicies(),
          ebay.getMerchantLocations()
        ]);

        const fulfillmentPolicyId = fulfillment.fulfillmentPolicies?.[0]?.fulfillmentPolicyId;
        const returnPolicyId = returns.returnPolicies?.[0]?.returnPolicyId;

        if (!fulfillmentPolicyId || !returnPolicyId) {
          sendJson(res, 400, { error: 'Business policies not configured. Create policies first.' });
          return;
        }

        // Check for merchant location - required for publishing
        let locationKey = locations.locations?.[0]?.merchantLocationKey;
        if (!locationKey) {
          // Auto-create a default location
          console.log('[eBay] No merchant location found, creating default...');
          await ebay.createMerchantLocation('default', {
            name: 'Primary Location',
            city: 'Asheville',
            state: 'NC',
            postalCode: '28801',
            country: 'US'
          });
          locationKey = 'default';
        }

        // Get inventory item to get details
        const inventoryItem = await ebay.getInventoryItem(sku);
        const listingPrice = price || '19.99';

        // Create offer with location
        const offer = await ebay.createOffer(sku, {
          description: inventoryItem.product?.description || 'Premium vinyl decal',
          price: listingPrice,
          quantity: 999,
          categoryId: categoryId,
          fulfillmentPolicyId,
          returnPolicyId,
          paymentPolicyId: null, // eBay Managed Payments doesn't need this
          locationKey: locationKey
        });

        console.log('[eBay] Created offer:', offer.offerId);

        // Publish offer
        const published = await ebay.publishOffer(offer.offerId);

        sendJson(res, 200, {
          success: true,
          sku,
          offerId: offer.offerId,
          listingId: published.listingId,
          status: 'published'
        });
      } catch (err) {
        console.error('[eBay] Publish error:', err);
        sendJson(res, 500, { error: err.message, detail: err.detail });
      }
    });
    return;
  }

  // POST /api/ebay/calculate-price - Calculate eBay price with fees
  if (req.method === 'POST' && parsedUrl.pathname === '/api/ebay/calculate-price') {
    collectRequestBody(req, (error, body) => {
      if (error) { sendJson(res, 413, { error: error.message }); return; }
      try {
        const ebay = require('./integrations/ebay');
        const { basePrice, storeLevel = 'basic' } = JSON.parse(body || '{}');

        if (!basePrice || isNaN(basePrice)) {
          sendJson(res, 400, { error: 'basePrice required' });
          return;
        }

        const ebayPrice = ebay.calculateEbayPrice(parseFloat(basePrice), storeLevel);
        const store = ebay.EBAY_STORE_COSTS[storeLevel] || ebay.EBAY_STORE_COSTS.basic;

        sendJson(res, 200, {
          basePrice: parseFloat(basePrice),
          ebayPrice,
          markup: ((ebayPrice / basePrice - 1) * 100).toFixed(1) + '%',
          storeLevel,
          fees: {
            finalValueFee: (store.fvf * 100) + '%',
            monthlySubscription: '$' + store.monthly,
            freeListings: store.freeListings
          }
        });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
    });
    return;
  }

  // GET /api/ebay/categories - Search eBay categories
  if (req.method === 'GET' && parsedUrl.pathname === '/api/ebay/categories') {
    (async () => {
      try {
        const ebay = require('./integrations/ebay');
        if (!ebay.hasValidTokens()) {
          sendJson(res, 401, { error: 'Not authenticated. Visit /oauth/ebay to connect.' });
          return;
        }

        const query = parsedUrl.query || {};
        if (query.q) {
          const results = await ebay.searchCategories(query.q);
          sendJson(res, 200, results);
        } else {
          const tree = await ebay.getCategoryTree();
          sendJson(res, 200, tree);
        }
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
    })();
    return;
  }

  // ===========================================
  // eBay Marketplace Account Deletion Notifications
  // Required by eBay Developer Program for compliance
  // ===========================================

  // eBay Verification Token (32-80 characters) - Required for endpoint validation
  const EBAY_VERIFICATION_TOKEN = process.env.EBAY_VERIFICATION_TOKEN || '896f3717ffc04d349ba8282973515cfc161cb2de5104b51a932b0a5146b8e68a';

  // GET /api/ebay/marketplace-account-deletion - eBay verification challenge
  // eBay sends a GET request with challenge_code to verify the endpoint
  if (req.method === 'GET' && parsedUrl.pathname === '/api/ebay/marketplace-account-deletion') {
    const query = parsedUrl.query || {};
    const challengeCode = query.challenge_code;

    if (!challengeCode) {
      sendJson(res, 400, { error: 'Missing challenge_code parameter' });
      return;
    }

    // Create the challenge response hash as per eBay documentation
    // hash = SHA256(challengeCode + verificationToken + endpoint)
    const crypto = require('crypto');
    const endpoint = 'https://blueridgecustomco.com/api/ebay/marketplace-account-deletion';
    const hash = crypto
      .createHash('sha256')
      .update(challengeCode + EBAY_VERIFICATION_TOKEN + endpoint)
      .digest('hex');

    console.log('[eBay] Marketplace account deletion endpoint verification received');

    // Return the challengeResponse as required by eBay
    sendJson(res, 200, { challengeResponse: hash });
    return;
  }

  // POST /api/ebay/marketplace-account-deletion - Handle account deletion notifications
  // eBay sends a POST request when a user requests account deletion
  if (req.method === 'POST' && parsedUrl.pathname === '/api/ebay/marketplace-account-deletion') {
    collectRequestBody(req, (error, body) => {
      if (error) {
        sendJson(res, 413, { error: error.message });
        return;
      }

      try {
        const notification = JSON.parse(body || '{}');

        console.log('[eBay] Marketplace account deletion notification received:', JSON.stringify(notification, null, 2));

        // Log the deletion request for compliance
        const fs = require('fs');
        const path = require('path');
        const logDir = path.join(__dirname, '..', 'data');
        const logFile = path.join(logDir, 'ebay-account-deletions.json');

        // Ensure data directory exists
        if (!fs.existsSync(logDir)) {
          fs.mkdirSync(logDir, { recursive: true });
        }

        // Load existing log or create new
        let deletionLog = [];
        if (fs.existsSync(logFile)) {
          try {
            deletionLog = JSON.parse(fs.readFileSync(logFile, 'utf8'));
          } catch (e) {
            deletionLog = [];
          }
        }

        // Add this notification
        deletionLog.push({
          timestamp: new Date().toISOString(),
          notification: notification,
          processed: true
        });

        // Save log
        fs.writeFileSync(logFile, JSON.stringify(deletionLog, null, 2));

        // If we have stored tokens for this user, we should clean them up
        // The notification contains userId which we can match against stored tokens
        if (notification.userId) {
          const tokenFile = path.join(logDir, 'ebay-tokens.json');
          if (fs.existsSync(tokenFile)) {
            try {
              const tokens = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
              // If this is our connected user, remove their tokens
              if (tokens.user_id === notification.userId) {
                fs.unlinkSync(tokenFile);
                console.log('[eBay] Removed tokens for deleted user:', notification.userId);
              }
            } catch (e) {
              console.error('[eBay] Error checking/removing tokens:', e.message);
            }
          }
        }

        // Return 200 OK to acknowledge receipt
        sendJson(res, 200, {
          status: 'received',
          message: 'Account deletion notification processed successfully'
        });

      } catch (err) {
        console.error('[eBay] Error processing account deletion notification:', err.message);
        sendJson(res, 500, { error: err.message });
      }
    });
    return;
  }

  // ===========================================
  // TikTok Shop Integration API
  // ===========================================

  // GET /oauth/tiktok - Start OAuth flow (redirects to TikTok)
  if (req.method === 'GET' && parsedUrl.pathname === '/oauth/tiktok') {
    try {
      const tiktok = require('./integrations/tiktok-shop');
      if (!tiktok.isConfigured()) {
        sendJson(res, 500, { error: 'TikTok Shop not configured. Set TIKTOK_APP_KEY and TIKTOK_APP_SECRET in .env' });
        return;
      }
      const state = tiktok.generateState();
      const authUrl = tiktok.getAuthUrl(state);
      res.writeHead(302, { Location: authUrl });
      res.end();
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // GET /oauth/tiktok/callback or /api/tiktok/auth-callback - Handle OAuth callback from TikTok
  if (req.method === 'GET' && (parsedUrl.pathname === '/oauth/tiktok/callback' || parsedUrl.pathname === '/api/tiktok/auth-callback')) {
    const query = parsedUrl.query || {};
    const code = query.code;
    const state = query.state;
    const error = query.error;

    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(`
        <html><body style="font-family: system-ui; padding: 40px; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #dc2626;">TikTok Authorization Failed</h1>
          <p><strong>Error:</strong> ${error}</p>
          <p><a href="/oauth/tiktok">Try again</a></p>
        </body></html>
      `);
      return;
    }

    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(`
        <html><body style="font-family: system-ui; padding: 40px; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #dc2626;">TikTok Authorization Failed</h1>
          <p>Missing authorization code. Please try again.</p>
          <p><a href="/oauth/tiktok">Try again</a></p>
        </body></html>
      `);
      return;
    }

    (async () => {
      try {
        const tiktok = require('./integrations/tiktok-shop');
        const tokens = await tiktok.exchangeCodeForToken(code);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html><body style="font-family: system-ui; padding: 40px; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #16a34a;">TikTok Shop Connected!</h1>
            <p>Successfully connected to TikTok Shop.</p>
            <p><strong>Seller:</strong> ${tokens.seller_name || 'Connected'}</p>
            <p><strong>Region:</strong> ${tokens.seller_base_region || 'US'}</p>
            <p style="margin-top: 20px;">You can now sync products to your TikTok Shop.</p>
            <p><a href="/api/tiktok/status" style="background: #000; color: white; padding: 10px 20px; text-decoration: none; border-radius: 6px;">Check Status</a></p>
          </body></html>
        `);
      } catch (err) {
        console.error('[TikTok] OAuth error:', err.message);
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(`
          <html><body style="font-family: system-ui; padding: 40px; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #dc2626;">TikTok Authorization Failed</h1>
            <p><strong>Error:</strong> ${err.message}</p>
            <p><a href="/oauth/tiktok">Try again</a></p>
          </body></html>
        `);
      }
    })();
    return;
  }

  // ==================== TIKTOK CONTENT POSTING API ====================

  // GET /oauth/tiktok-content - Start OAuth flow for content posting
  if (req.method === 'GET' && parsedUrl.pathname === '/oauth/tiktok-content') {
    try {
      const tiktokContent = require('./integrations/tiktok-content');
      const authUrl = tiktokContent.getAuthUrl('content_auth');
      res.writeHead(302, { Location: authUrl });
      res.end();
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // GET /api/tiktok-content/auth-callback - OAuth callback for content API
  if (req.method === 'GET' && parsedUrl.pathname === '/api/tiktok-content/auth-callback') {
    const query = parsedUrl.query || {};
    const code = query.code;
    const error = query.error;

    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(`
        <html><body style="font-family: system-ui; padding: 40px; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #dc2626;">TikTok Authorization Failed</h1>
          <p><strong>Error:</strong> ${error}</p>
          <p><a href="/oauth/tiktok-content">Try again</a></p>
        </body></html>
      `);
      return;
    }

    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(`
        <html><body style="font-family: system-ui; padding: 40px; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #dc2626;">TikTok Authorization Failed</h1>
          <p>Missing authorization code.</p>
          <p><a href="/oauth/tiktok-content">Try again</a></p>
        </body></html>
      `);
      return;
    }

    (async () => {
      try {
        const tiktokContent = require('./integrations/tiktok-content');
        const tokens = await tiktokContent.exchangeCodeForToken(code);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html><body style="font-family: system-ui; padding: 40px; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #16a34a;">TikTok Content API Connected!</h1>
            <p>Successfully connected to TikTok for video posting.</p>
            <p><strong>Open ID:</strong> ${tokens.open_id}</p>
            <p><strong>Scopes:</strong> ${tokens.scope}</p>
            <p style="margin-top: 20px;">You can now post videos to your TikTok account.</p>
            <p><a href="/api/tiktok-content/status" style="background: #000; color: white; padding: 10px 20px; text-decoration: none; border-radius: 6px;">Check Status</a></p>
          </body></html>
        `);
      } catch (err) {
        console.error('[TikTok Content] OAuth error:', err.message);
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(`
          <html><body style="font-family: system-ui; padding: 40px; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #dc2626;">TikTok Authorization Failed</h1>
            <p><strong>Error:</strong> ${err.message}</p>
            <p><a href="/oauth/tiktok-content">Try again</a></p>
          </body></html>
        `);
      }
    })();
    return;
  }

  // GET /api/tiktok-content/status - Check content API connection status
  if (req.method === 'GET' && parsedUrl.pathname === '/api/tiktok-content/status') {
    try {
      const tiktokContent = require('./integrations/tiktok-content');
      const status = tiktokContent.getConnectionStatus();
      sendJson(res, 200, status);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // POST /api/tiktok-content/disconnect - Remove TikTok tokens (disconnect)
  if (req.method === 'POST' && parsedUrl.pathname === '/api/tiktok-content/disconnect') {
    if (!requireInternalKey(req, res)) return;
    try {
      const DATA_DIR = path.resolve(__dirname, '..', 'data');
      const TOKEN_FILE = path.join(DATA_DIR, 'tiktok-content-tokens.json');
      if (fs.existsSync(TOKEN_FILE)) {
        fs.unlinkSync(TOKEN_FILE);
        console.log('[TikTok Content] Tokens deleted - disconnected');
      }
      sendJson(res, 200, { success: true, message: 'Disconnected from TikTok' });
    } catch (err) {
      console.error('[TikTok Content] Disconnect error:', err.message);
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // GET /api/tiktok-content/user - Get authenticated user info
  if (req.method === 'GET' && parsedUrl.pathname === '/api/tiktok-content/user') {
    (async () => {
      try {
        const tiktokContent = require('./integrations/tiktok-content');
        const user = await tiktokContent.getUserInfo();
        sendJson(res, 200, user);
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
    })();
    return;
  }

  // POST /api/tiktok-content/upload-temp-video - Upload video file to get a public URL
  if (req.method === 'POST' && parsedUrl.pathname === '/api/tiktok-content/upload-temp-video') {
    if (!requireInternalKey(req, res)) return;

    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      sendJson(res, 400, { error: 'Content-Type must be multipart/form-data' });
      return;
    }

    // Parse multipart form data
    const busboy = require('busboy');
    const fs = require('fs');
    const path = require('path');
    const crypto = require('crypto');

    const bb = busboy({ headers: req.headers, limits: { fileSize: 500 * 1024 * 1024 } }); // 500MB limit
    let savedFilePath = null;
    let fileError = null;

    bb.on('file', (name, file, info) => {
      const { filename, mimeType } = info;
      if (!mimeType.startsWith('video/')) {
        fileError = 'File must be a video';
        file.resume();
        return;
      }

      // Generate unique filename
      const ext = path.extname(filename) || '.mp4';
      const uniqueName = `tiktok-temp-${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
      const tempDir = path.resolve(__dirname, '..', 'data', 'tiktok-temp');

      // Ensure temp directory exists
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      savedFilePath = path.join(tempDir, uniqueName);
      const writeStream = fs.createWriteStream(savedFilePath);

      file.pipe(writeStream);

      writeStream.on('error', (err) => {
        fileError = err.message;
      });
    });

    bb.on('finish', () => {
      if (fileError) {
        sendJson(res, 400, { error: fileError });
        return;
      }

      if (!savedFilePath) {
        sendJson(res, 400, { error: 'No video file received' });
        return;
      }

      // Return a public URL for the uploaded video
      const filename = path.basename(savedFilePath);
      const publicUrl = `https://blueridgecustomco.com/api/tiktok-content/temp-video/${filename}`;

      console.log('[TikTok] Temp video saved:', savedFilePath);
      console.log('[TikTok] Public URL:', publicUrl);

      // Schedule cleanup after 1 hour
      setTimeout(() => {
        try {
          if (fs.existsSync(savedFilePath)) {
            fs.unlinkSync(savedFilePath);
            console.log('[TikTok] Cleaned up temp video:', savedFilePath);
          }
        } catch (e) {
          console.error('[TikTok] Failed to clean up temp video:', e.message);
        }
      }, 60 * 60 * 1000); // 1 hour

      sendJson(res, 200, { success: true, videoUrl: publicUrl, filename });
    });

    bb.on('error', (err) => {
      console.error('[TikTok] Upload error:', err.message);
      sendJson(res, 500, { error: err.message });
    });

    req.pipe(bb);
    return;
  }

  // GET /api/tiktok-content/temp-video/:filename - Serve temp video files
  if (req.method === 'GET' && parsedUrl.pathname.startsWith('/api/tiktok-content/temp-video/')) {
    const filename = parsedUrl.pathname.replace('/api/tiktok-content/temp-video/', '');
    if (!filename || filename.includes('..') || filename.includes('/')) {
      sendJson(res, 400, { error: 'Invalid filename' });
      return;
    }

    const fs = require('fs');
    const path = require('path');
    const tempDir = path.resolve(__dirname, '..', 'data', 'tiktok-temp');
    const filePath = path.join(tempDir, filename);

    if (!fs.existsSync(filePath)) {
      sendJson(res, 404, { error: 'Video not found' });
      return;
    }

    const stat = fs.statSync(filePath);
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes'
    });

    const readStream = fs.createReadStream(filePath);
    readStream.pipe(res);
    return;
  }

  // POST /api/tiktok-content/upload-video - Upload and publish a video
  if (req.method === 'POST' && parsedUrl.pathname === '/api/tiktok-content/upload-video') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { videoPath, videoUrl, title, privacyLevel } = JSON.parse(body);
        const tiktokContent = require('./integrations/tiktok-content');

        let result;
        if (videoUrl) {
          // Upload from URL
          result = await tiktokContent.uploadVideoFromUrl(videoUrl, title, privacyLevel || 'PUBLIC_TO_EVERYONE');
        } else if (videoPath) {
          // Upload from local file
          result = await tiktokContent.uploadVideo(videoPath, title, privacyLevel || 'PUBLIC_TO_EVERYONE');
        } else {
          sendJson(res, 400, { error: 'Either videoPath or videoUrl is required' });
          return;
        }

        sendJson(res, 200, { success: true, result });
      } catch (err) {
        console.error('[TikTok Content] Upload error:', err.message);
        sendJson(res, 500, { error: err.message });
      }
    });
    return;
  }

  // GET /api/tiktok-content/publish-status - Check video publish status
  if (req.method === 'GET' && parsedUrl.pathname === '/api/tiktok-content/publish-status') {
    const publishId = parsedUrl.query?.publish_id;
    if (!publishId) {
      sendJson(res, 400, { error: 'publish_id query parameter required' });
      return;
    }

    (async () => {
      try {
        const tiktokContent = require('./integrations/tiktok-content');
        const status = await tiktokContent.getPublishStatus(publishId);
        sendJson(res, 200, status);
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
    })();
    return;
  }

  // ==================== TIKTOK SHOP API ====================

  // GET /api/tiktok/status - Check TikTok connection status
  if (req.method === 'GET' && parsedUrl.pathname === '/api/tiktok/status') {
    (async () => {
      try {
        const tiktok = require('./integrations/tiktok-shop');
        const configured = tiktok.isConfigured();
        const tokens = tiktok.loadTokens();
        const hasTokens = Boolean(tokens?.access_token);

        const statusInfo = {
          platform: 'tiktok',
          configured,
          connected: hasTokens,
          authUrl: configured && !hasTokens ? '/oauth/tiktok' : null
        };

        if (hasTokens) {
          statusInfo.seller_name = tokens.seller_name;
          statusInfo.seller_region = tokens.seller_base_region;
          statusInfo.updated_at = tokens.updated_at;

          // Try to get shops
          try {
            const shops = await tiktok.getAuthorizedShops();
            statusInfo.shops = shops.shops || [];
          } catch (e) {
            statusInfo.shopsError = e.message;
          }
        }

        sendJson(res, 200, statusInfo);
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
    })();
    return;
  }

  // GET /api/tiktok/shops - Get authorized shops
  if (req.method === 'GET' && parsedUrl.pathname === '/api/tiktok/shops') {
    (async () => {
      try {
        const tiktok = require('./integrations/tiktok-shop');
        const tokens = tiktok.loadTokens();
        if (!tokens?.access_token) {
          sendJson(res, 401, { error: 'Not authenticated. Visit /oauth/tiktok to connect.' });
          return;
        }

        const shops = await tiktok.getAuthorizedShops();
        sendJson(res, 200, shops);
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
    })();
    return;
  }

  // GET /api/tiktok/categories - Get product categories
  if (req.method === 'GET' && parsedUrl.pathname === '/api/tiktok/categories') {
    (async () => {
      try {
        const tiktok = require('./integrations/tiktok-shop');
        const query = parsedUrl.query || {};
        const shopCipher = query.shop_cipher;

        if (!shopCipher) {
          sendJson(res, 400, { error: 'shop_cipher parameter required' });
          return;
        }

        const categories = await tiktok.getCategories(shopCipher);
        sendJson(res, 200, categories);
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
    })();
    return;
  }

  // POST /api/tiktok/categories/search - Search categories
  if (req.method === 'POST' && parsedUrl.pathname === '/api/tiktok/categories/search') {
    collectRequestBody(req, (error, body) => {
      if (error) { sendJson(res, 413, { error: error.message }); return; }
      (async () => {
        try {
          const tiktok = require('./integrations/tiktok-shop');
          const { shop_cipher, keyword } = JSON.parse(body || '{}');

          if (!shop_cipher || !keyword) {
            sendJson(res, 400, { error: 'shop_cipher and keyword required' });
            return;
          }

          const results = await tiktok.searchCategories(shop_cipher, keyword);
          sendJson(res, 200, results);
        } catch (err) {
          sendJson(res, 500, { error: err.message });
        }
      })();
    });
    return;
  }

  // GET /api/tiktok/products - Get products
  if (req.method === 'GET' && parsedUrl.pathname === '/api/tiktok/products') {
    (async () => {
      try {
        const tiktok = require('./integrations/tiktok-shop');
        const query = parsedUrl.query || {};
        const shopCipher = query.shop_cipher;

        if (!shopCipher) {
          sendJson(res, 400, { error: 'shop_cipher parameter required' });
          return;
        }

        const products = await tiktok.searchProducts(shopCipher, {});
        sendJson(res, 200, products);
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
    })();
    return;
  }

  // POST /api/tiktok/sync-product - Sync Shopify product to TikTok
  if (req.method === 'POST' && parsedUrl.pathname === '/api/tiktok/sync-product') {
    collectRequestBody(req, (error, body) => {
      if (error) { sendJson(res, 413, { error: error.message }); return; }
      (async () => {
        try {
          const tiktok = require('./integrations/tiktok-shop');
          const tokens = tiktok.loadTokens();
          if (!tokens?.access_token) {
            sendJson(res, 401, { error: 'Not authenticated. Visit /oauth/tiktok to connect.' });
            return;
          }

          const payload = JSON.parse(body || '{}');
          const { shop_cipher, shopify_product_id, category_id, price_multiplier = 1.1 } = payload;

          if (!shop_cipher || !shopify_product_id || !category_id) {
            sendJson(res, 400, { error: 'shop_cipher, shopify_product_id, and category_id required' });
            return;
          }

          // Load Shopify product from database
          const product = db.getShopifyProduct(shopify_product_id);
          if (!product) {
            sendJson(res, 404, { error: `Shopify product ${shopify_product_id} not found in database` });
            return;
          }

          const result = await tiktok.syncProductToTikTok(shop_cipher, product, category_id, {
            priceMultiplier: price_multiplier
          });

          sendJson(res, 200, result);
        } catch (err) {
          sendJson(res, 500, { error: err.message });
        }
      })();
    });
    return;
  }

  // POST /api/tiktok/calculate-price - Calculate price with TikTok fees
  if (req.method === 'POST' && parsedUrl.pathname === '/api/tiktok/calculate-price') {
    collectRequestBody(req, (error, body) => {
      if (error) { sendJson(res, 413, { error: error.message }); return; }
      try {
        const tiktok = require('./integrations/tiktok-shop');
        const { base_price } = JSON.parse(body || '{}');

        if (!base_price || isNaN(base_price)) {
          sendJson(res, 400, { error: 'base_price required' });
          return;
        }

        const tiktokPrice = tiktok.calculateTikTokPrice(parseFloat(base_price));

        sendJson(res, 200, {
          base_price: parseFloat(base_price),
          tiktok_price: tiktokPrice,
          fees: tiktok.TIKTOK_FEES
        });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
    });
    return;
  }

  // GET /api/tiktok/orders - Get orders
  if (req.method === 'GET' && parsedUrl.pathname === '/api/tiktok/orders') {
    (async () => {
      try {
        const tiktok = require('./integrations/tiktok-shop');
        const query = parsedUrl.query || {};
        const shopCipher = query.shop_cipher;

        if (!shopCipher) {
          sendJson(res, 400, { error: 'shop_cipher parameter required' });
          return;
        }

        const orders = await tiktok.getOrders(shopCipher, {});
        sendJson(res, 200, orders);
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
    })();
    return;
  }

  // ===========================================
  // Lumaprints Fulfillment API
  // ===========================================

  // GET /api/lumaprints/status - Check Lumaprints connection status
  if (req.method === 'GET' && parsedUrl.pathname === '/api/lumaprints/status') {
    (async () => {
      try {
        const lumaprints = require('./integrations/lumaprints');
        const status = await lumaprints.getConnectionStatus();
        sendJson(res, 200, status);
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
    })();
    return;
  }

  // GET /api/lumaprints/orders - Get orders from Lumaprints
  if (req.method === 'GET' && parsedUrl.pathname === '/api/lumaprints/orders') {
    (async () => {
      try {
        const lumaprints = require('./integrations/lumaprints');
        const query = parsedUrl.query || {};
        const orders = await lumaprints.getOrders({
          status: query.status,
          startDate: query.startDate,
          endDate: query.endDate,
          page: query.page,
          limit: query.limit || 50
        });
        sendJson(res, 200, { success: true, orders });
      } catch (err) {
        sendJson(res, 500, { success: false, error: err.message });
      }
    })();
    return;
  }

  // GET /api/lumaprints/order/:id - Get single order
  if (req.method === 'GET' && parsedUrl.pathname.startsWith('/api/lumaprints/order/')) {
    (async () => {
      try {
        const lumaprints = require('./integrations/lumaprints');
        const orderId = parsedUrl.pathname.split('/').pop();
        const order = await lumaprints.getOrder(orderId);
        sendJson(res, 200, { success: true, order });
      } catch (err) {
        sendJson(res, 500, { success: false, error: err.message });
      }
    })();
    return;
  }

  // GET /api/lumaprints/shipment/:orderId - Get shipment info
  if (req.method === 'GET' && parsedUrl.pathname.startsWith('/api/lumaprints/shipment/')) {
    (async () => {
      try {
        const lumaprints = require('./integrations/lumaprints');
        const orderId = parsedUrl.pathname.split('/').pop();
        const shipment = await lumaprints.getShipment(orderId);
        sendJson(res, 200, { success: true, shipment });
      } catch (err) {
        sendJson(res, 500, { success: false, error: err.message });
      }
    })();
    return;
  }

  // POST /api/lumaprints/submit-order - Submit a new order
  if (req.method === 'POST' && parsedUrl.pathname === '/api/lumaprints/submit-order') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const lumaprints = require('./integrations/lumaprints');
        const data = JSON.parse(body);

        // Validate required fields
        if (!data.orderId) {
          sendJson(res, 400, { success: false, error: 'orderId is required' });
          return;
        }
        if (!data.recipient) {
          sendJson(res, 400, { success: false, error: 'recipient is required' });
          return;
        }
        if (!data.prints || !data.prints.length) {
          sendJson(res, 400, { success: false, error: 'prints array is required' });
          return;
        }

        const result = await lumaprints.submitMetalPrintOrder({
          orderId: data.orderId,
          recipient: data.recipient,
          prints: data.prints,
          shippingMethod: data.shippingMethod || 'default',
          productionTime: data.productionTime || 'regular',
          specialInstructions: data.specialInstructions || ''
        });

        sendJson(res, 201, { success: true, result });
      } catch (err) {
        console.error('[Lumaprints] Submit order error:', err);
        sendJson(res, 500, { success: false, error: err.message });
      }
    });
    return;
  }

  // POST /api/lumaprints/cost-estimate - Get cost estimate for an order
  if (req.method === 'POST' && parsedUrl.pathname === '/api/lumaprints/cost-estimate') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const lumaprints = require('./integrations/lumaprints');
        const data = JSON.parse(body);
        const cost = await lumaprints.getOrderCost(data);
        sendJson(res, 200, { success: true, cost });
      } catch (err) {
        sendJson(res, 500, { success: false, error: err.message });
      }
    });
    return;
  }

  // POST /api/lumaprints/verify-image - Verify image dimensions
  if (req.method === 'POST' && parsedUrl.pathname === '/api/lumaprints/verify-image') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const lumaprints = require('./integrations/lumaprints');
        const { imageUrl, width, height } = JSON.parse(body);

        if (!imageUrl || !width || !height) {
          sendJson(res, 400, { success: false, error: 'imageUrl, width, and height are required' });
          return;
        }

        const result = await lumaprints.verifyImageSize(imageUrl, width, height);
        sendJson(res, 200, { success: true, result });
      } catch (err) {
        sendJson(res, 500, { success: false, error: err.message });
      }
    });
    return;
  }

  // GET /api/lumaprints/sizes - Get available metal print sizes
  if (req.method === 'GET' && parsedUrl.pathname === '/api/lumaprints/sizes') {
    try {
      const lumaprints = require('./integrations/lumaprints');
      sendJson(res, 200, {
        success: true,
        sizes: lumaprints.METAL_SIZES,
        options: {
          surface: lumaprints.METAL_OPTIONS.surface,
          hanging: lumaprints.METAL_OPTIONS.hanging
        },
        shippingMethods: lumaprints.SHIPPING_METHODS,
        productionTimes: lumaprints.PRODUCTION_TIMES
      });
    } catch (err) {
      sendJson(res, 500, { success: false, error: err.message });
    }
    return;
  }

  // ===========================================
  // Fulfillment Helper Functions
  // ===========================================

  /**
   * Generate tracking URL based on carrier name
   */
  function getTrackingUrl(carrier, trackingNumber) {
    if (!trackingNumber) return '';

    const carrierLower = (carrier || '').toLowerCase();

    // Common carrier tracking URLs
    const trackingUrls = {
      'ups': `https://www.ups.com/track?tracknum=${trackingNumber}`,
      'fedex': `https://www.fedex.com/fedextrack/?trknbr=${trackingNumber}`,
      'usps': `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`,
      'dhl': `https://www.dhl.com/en/express/tracking.html?AWB=${trackingNumber}`,
      'ontrac': `https://www.ontrac.com/tracking/?number=${trackingNumber}`,
      'lasership': `https://www.lasership.com/track/${trackingNumber}`,
      'amazon': `https://track.amazon.com/tracking/${trackingNumber}`,
      'spee-dee': `https://packages.speedeedelivery.com/track.php?track=${trackingNumber}`,
      'gls': `https://www.gls-us.com/track-and-trace?TrackingNumber=${trackingNumber}`
    };

    // Check for partial matches
    for (const [key, url] of Object.entries(trackingUrls)) {
      if (carrierLower.includes(key)) {
        return url;
      }
    }

    // Default: return empty string if carrier not recognized
    return '';
  }

  /**
   * Update fulfillment on the originating sales channel
   */
  async function updateSalesChannelFulfillment(order, lineItemId, trackingInfo) {
    const channel = (order.sales_channel || 'shopify').toLowerCase();

    console.log(`[Fulfillment] Updating ${channel} for order ${order.channel_order_id || order.shopify_order_id}`);

    switch (channel) {
      case 'shopify': {
        const shopify = require('./integrations/shopify');
        if (!shopify.isConfigured()) {
          console.log('[Fulfillment] Shopify not configured, skipping fulfillment update');
          return { success: false, reason: 'Shopify not configured' };
        }

        const orderId = order.channel_order_id || order.shopify_order_id;
        if (!orderId) {
          console.log('[Fulfillment] No Shopify order ID found');
          return { success: false, reason: 'No order ID' };
        }

        try {
          const result = await shopify.createFulfillment({
            orderId: orderId,
            lineItems: [{ id: lineItemId, quantity: 1 }],
            tracking: {
              tracking_number: trackingInfo.trackingNumber,
              tracking_company: trackingInfo.carrier,
              tracking_url: trackingInfo.trackingUrl
            },
            notifyCustomer: true
          });

          console.log(`[Fulfillment] Shopify fulfillment created:`, result);
          return { success: true, result };
        } catch (err) {
          console.error(`[Fulfillment] Shopify error:`, err.message);
          return { success: false, error: err.message };
        }
      }

      case 'ebay': {
        // eBay Fulfillment API - requires shipping tracking update
        // API: POST /sell/fulfillment/v1/order/{orderId}/shipping_fulfillment
        console.log('[Fulfillment] eBay fulfillment update not yet implemented');
        // TODO: Implement eBay shipping fulfillment
        // const ebay = require('./integrations/ebay');
        // await ebay.createShippingFulfillment(orderId, lineItemId, trackingInfo);
        return { success: false, reason: 'eBay fulfillment not yet implemented' };
      }

      case 'tiktok': {
        // TikTok Shop Fulfillment API
        // API: POST /api/fulfillment/shipping_info/update
        console.log('[Fulfillment] TikTok fulfillment update not yet implemented');
        // TODO: Implement TikTok shipping fulfillment
        // const tiktok = require('./integrations/tiktok-shop');
        // await tiktok.updateShipment(orderId, trackingInfo);
        return { success: false, reason: 'TikTok fulfillment not yet implemented' };
      }

      case 'facebook':
      case 'meta': {
        // Facebook/Meta Commerce Fulfillment API
        console.log('[Fulfillment] Facebook fulfillment update not yet implemented');
        // TODO: Implement Facebook shipping fulfillment
        return { success: false, reason: 'Facebook fulfillment not yet implemented' };
      }

      case 'amazon': {
        // Amazon SP-API Fulfillment
        console.log('[Fulfillment] Amazon fulfillment update not yet implemented');
        // TODO: Implement Amazon shipping fulfillment
        return { success: false, reason: 'Amazon fulfillment not yet implemented' };
      }

      case 'etsy': {
        // Etsy Fulfillment API
        console.log('[Fulfillment] Etsy fulfillment update not yet implemented');
        // TODO: Implement Etsy shipping fulfillment
        return { success: false, reason: 'Etsy fulfillment not yet implemented' };
      }

      default:
        console.log(`[Fulfillment] Unknown sales channel: ${channel}`);
        return { success: false, reason: `Unknown channel: ${channel}` };
    }
  }

  // POST /api/lumaprints/webhook/subscribe - Subscribe to shipping webhook
  if (req.method === 'POST' && parsedUrl.pathname === '/api/lumaprints/webhook/subscribe') {
    (async () => {
      try {
        const lumaprints = require('./integrations/lumaprints');
        const webhookUrl = `${process.env.ASSET_BASE_URL || 'https://blueridgecustomco.com'}/api/lumaprints/webhook`;
        const result = await lumaprints.subscribeWebhook(webhookUrl);
        sendJson(res, 200, { success: true, result, webhookUrl });
      } catch (err) {
        sendJson(res, 500, { success: false, error: err.message });
      }
    })();
    return;
  }

  // GET /api/lumaprints/webhooks - Get current webhook subscriptions
  if (req.method === 'GET' && parsedUrl.pathname === '/api/lumaprints/webhooks') {
    (async () => {
      try {
        const lumaprints = require('./integrations/lumaprints');
        const webhooks = await lumaprints.getWebhooks();
        sendJson(res, 200, { success: true, webhooks });
      } catch (err) {
        sendJson(res, 500, { success: false, error: err.message });
      }
    })();
    return;
  }

  // POST /api/lumaprints/webhook - Receive webhook from Lumaprints (shipping notifications)
  if (req.method === 'POST' && parsedUrl.pathname === '/api/lumaprints/webhook') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        console.log('[Lumaprints Webhook] Received:', body);
        const data = JSON.parse(body);

        // Lumaprints shipping webhook payload:
        // { orderNumber, shipments: [{ carrier, shippingMethod, trackingNumber, shipmentDate, items: [...] }] }

        if (data.orderNumber && data.shipments && data.shipments.length > 0) {
          const db = require('./db');
          const dbClient = db.getDb();

          // Find our order by the external ID we sent (format: orderNumber-lineItemId)
          const externalId = data.orderNumber;
          const shipment = data.shipments[0]; // Get first shipment

          // Try to find the metal print order
          // The externalId we sent was "orderNumber-lineItemId"
          const parts = externalId.split('-');
          if (parts.length >= 2) {
            const orderNumber = parts[0];
            const lineItemId = parts.slice(1).join('-');

            // Get the order first to know which channel to update
            const order = dbClient.prepare(`
              SELECT id, sales_channel, channel_order_id, shopify_order_id, customer_email
              FROM metal_print_orders
              WHERE order_number = ? AND line_item_id = ?
            `).get(orderNumber, lineItemId);

            if (!order) {
              console.log(`[Lumaprints Webhook] Order not found: ${orderNumber}-${lineItemId}`);
            } else {
              // Update the order with tracking info
              const result = dbClient.prepare(`
                UPDATE metal_print_orders
                SET status = 'shipped',
                    lumaprints_status = 'shipped',
                    shipped_at = datetime('now'),
                    tracking_carrier = ?,
                    tracking_number = ?
                WHERE id = ?
              `).run(shipment.carrier || '', shipment.trackingNumber || '', order.id);

              console.log(`[Lumaprints Webhook] Updated order ${orderNumber}-${lineItemId} to shipped`);
              console.log(`[Lumaprints Webhook] Tracking: ${shipment.carrier} ${shipment.trackingNumber}`);
              console.log(`[Lumaprints Webhook] Sales Channel: ${order.sales_channel}`);

              // Update fulfillment on the sales channel
              const trackingInfo = {
                carrier: shipment.carrier || '',
                trackingNumber: shipment.trackingNumber || '',
                trackingUrl: getTrackingUrl(shipment.carrier, shipment.trackingNumber)
              };

              try {
                await updateSalesChannelFulfillment(order, lineItemId, trackingInfo);
              } catch (fulfillErr) {
                console.error(`[Lumaprints Webhook] Failed to update ${order.sales_channel} fulfillment:`, fulfillErr.message);
              }

              // TODO: Send shipping notification email to customer
            }
          }
        }

        // Always respond 200 to acknowledge receipt
        sendJson(res, 200, { success: true, message: 'Webhook received' });
      } catch (err) {
        console.error('[Lumaprints Webhook] Error:', err);
        // Still respond 200 to prevent retries for parse errors
        sendJson(res, 200, { success: true, message: 'Webhook received with errors' });
      }
    });
    return;
  }

  // ===========================================
  // Unified Marketplace Sync API
  // ===========================================

  // GET /api/marketplace/status - Get all platform connection statuses
  if (req.method === 'GET' && parsedUrl.pathname === '/api/marketplace/status') {
    try {
      const sync = require('./integrations/marketplace-sync');
      const status = sync.getPlatformStatus();
      sendJson(res, 200, status);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // POST /api/marketplace/calculate-prices - Calculate prices for all platforms
  if (req.method === 'POST' && parsedUrl.pathname === '/api/marketplace/calculate-prices') {
    collectRequestBody(req, (error, body) => {
      if (error) { sendJson(res, 413, { error: error.message }); return; }
      try {
        const sync = require('./integrations/marketplace-sync');
        const { basePrice, includeOffsiteAds = false, storeLevel = 'basic' } = JSON.parse(body || '{}');

        if (!basePrice || isNaN(basePrice)) {
          sendJson(res, 400, { error: 'basePrice required' });
          return;
        }

        const prices = sync.calculateAllPrices(parseFloat(basePrice), { includeOffsiteAds, storeLevel });

        sendJson(res, 200, {
          basePrice: parseFloat(basePrice),
          prices,
          config: sync.PLATFORM_CONFIG
        });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
    });
    return;
  }

  // POST /api/marketplace/sync-product - Sync a product to multiple platforms
  if (req.method === 'POST' && parsedUrl.pathname === '/api/marketplace/sync-product') {
    collectRequestBody(req, async (error, body) => {
      if (error) { sendJson(res, 413, { error: error.message }); return; }
      try {
        const sync = require('./integrations/marketplace-sync');
        const payload = JSON.parse(body || '{}');
        const {
          shopifyProductId,
          platforms = ['etsy', 'ebay'],
          publish = false,
          force = false
        } = payload;

        if (!shopifyProductId) {
          sendJson(res, 400, { error: 'shopifyProductId required' });
          return;
        }

        const result = await sync.syncProduct(shopifyProductId, platforms, { publish, force });
        sendJson(res, 200, result);
      } catch (err) {
        console.error('[Marketplace Sync] Error:', err);
        sendJson(res, 500, { error: err.message });
      }
    });
    return;
  }

  // POST /api/marketplace/sync-collection - Sync all products in a Shopify collection
  if (req.method === 'POST' && parsedUrl.pathname === '/api/marketplace/sync-collection') {
    collectRequestBody(req, async (error, body) => {
      if (error) { sendJson(res, 413, { error: error.message }); return; }
      try {
        const sync = require('./integrations/marketplace-sync');
        const payload = JSON.parse(body || '{}');
        const {
          collectionId,
          platforms = ['etsy', 'ebay'],
          publish = false,
          force = false,
          delayMs = 1000
        } = payload;

        if (!collectionId) {
          sendJson(res, 400, { error: 'collectionId required' });
          return;
        }

        const result = await sync.syncCollection(collectionId, platforms, { publish, force, delayMs });
        sendJson(res, 200, result);
      } catch (err) {
        console.error('[Marketplace Sync] Collection error:', err);
        sendJson(res, 500, { error: err.message });
      }
    });
    return;
  }

  // GET /api/marketplace/product-status/:id - Get sync status for a product
  if (req.method === 'GET' && parsedUrl.pathname.startsWith('/api/marketplace/product-status/')) {
    try {
      const sync = require('./integrations/marketplace-sync');
      const productId = parsedUrl.pathname.split('/').pop();
      const status = sync.getProductSyncStatus(productId);

      if (status) {
        sendJson(res, 200, status);
      } else {
        sendJson(res, 404, { error: 'Product not synced to any marketplace' });
      }
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // GET /api/marketplace/synced-products - Get all synced products
  if (req.method === 'GET' && parsedUrl.pathname === '/api/marketplace/synced-products') {
    try {
      const sync = require('./integrations/marketplace-sync');
      const products = sync.getAllSyncedProducts();
      sendJson(res, 200, products);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // GET /api/marketplace/sync-log - Get recent sync activity log
  if (req.method === 'GET' && parsedUrl.pathname === '/api/marketplace/sync-log') {
    try {
      const sync = require('./integrations/marketplace-sync');
      const query = parsedUrl.query || {};
      const limit = parseInt(query.limit) || 50;
      const log = sync.getSyncLog(limit);
      sendJson(res, 200, log);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // POST /api/marketplace/price-table - Generate price comparison table for products
  if (req.method === 'POST' && parsedUrl.pathname === '/api/marketplace/price-table') {
    collectRequestBody(req, async (error, body) => {
      if (error) { sendJson(res, 413, { error: error.message }); return; }
      try {
        const sync = require('./integrations/marketplace-sync');
        const payload = JSON.parse(body || '{}');
        const { productIds, collectionId, includeOffsiteAds = false, storeLevel = 'basic' } = payload;

        let products = [];

        if (collectionId) {
          products = await shopify.getCollectionProducts(collectionId);
        } else if (productIds && productIds.length) {
          for (const id of productIds) {
            const product = await shopify.getProduct(id);
            if (product) products.push(product);
          }
        } else {
          sendJson(res, 400, { error: 'productIds or collectionId required' });
          return;
        }

        const table = sync.generatePriceTable(products, { includeOffsiteAds, storeLevel });
        sendJson(res, 200, { count: table.length, products: table });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
    });
    return;
  }

  // ===========================================
  // Amazon SP-API Integration
  // ===========================================

  // GET /oauth/amazon - Start OAuth flow (redirects to Amazon Seller Central)
  if (req.method === 'GET' && parsedUrl.pathname === '/oauth/amazon') {
    try {
      const amazon = require('./integrations/amazon');
      if (!amazon.isConfigured()) {
        sendJson(res, 500, { error: 'Amazon SP-API not configured. Set AMAZON_LWA_CLIENT_ID, AMAZON_LWA_CLIENT_SECRET, and AWS credentials in .env' });
        return;
      }
      const { url, state } = amazon.startOAuthFlow();
      console.log('[Amazon OAuth] Redirecting to Amazon Seller Central for authorization...');
      res.writeHead(302, { Location: url });
      res.end();
    } catch (err) {
      console.error('[Amazon OAuth] Start error:', err);
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // GET /oauth/amazon/callback - Handle OAuth callback from Amazon
  if (req.method === 'GET' && parsedUrl.pathname === '/oauth/amazon/callback') {
    const query = parsedUrl.query || {};
    const spapi_oauth_code = query.spapi_oauth_code;
    const state = query.state;
    const error = query.error;

    if (error) {
      console.error('[Amazon OAuth] Error from Amazon:', error, query.error_description);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <html><body style="font-family: system-ui; padding: 40px; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #dc2626;">Amazon Authorization Failed</h1>
          <p><strong>Error:</strong> ${query.error}</p>
          <p>${query.error_description || ''}</p>
          <p><a href="/oauth/amazon">Try again</a></p>
        </body></html>
      `);
      return;
    }

    if (!spapi_oauth_code || !state) {
      sendJson(res, 400, { error: 'Missing spapi_oauth_code or state parameter' });
      return;
    }

    (async () => {
      try {
        const amazon = require('./integrations/amazon');
        const tokens = await amazon.completeOAuthFlow(spapi_oauth_code, state);

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html><body style="font-family: system-ui; padding: 40px; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #16a34a;">Amazon Connected Successfully!</h1>
            <p>Your Amazon Seller account has been authorized.</p>
            <div style="background: #f3f4f6; padding: 16px; border-radius: 8px; margin: 20px 0;">
              <p><strong>Important:</strong> Add this refresh token to your .env file:</p>
              <code style="background: #1f2937; color: #10b981; padding: 8px; border-radius: 4px; display: block; word-break: break-all; margin-top: 8px;">
                AMAZON_REFRESH_TOKEN=${tokens.refresh_token}
              </code>
            </div>
            <p><a href="/api/amazon/status">View Amazon integration status</a></p>
          </body></html>
        `);
      } catch (err) {
        console.error('[Amazon OAuth] Callback error:', err);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html><body style="font-family: system-ui; padding: 40px; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #dc2626;">Amazon Authorization Failed</h1>
            <p><strong>Error:</strong> ${err.message}</p>
            <p><a href="/oauth/amazon">Try again</a></p>
          </body></html>
        `);
      }
    })();
    return;
  }

  // GET /api/amazon/status - Check Amazon connection status
  if (req.method === 'GET' && parsedUrl.pathname === '/api/amazon/status') {
    (async () => {
      try {
        const amazon = require('./integrations/amazon');
        const configured = amazon.isConfigured();
        const hasTokens = amazon.hasValidTokens();
        const tokens = amazon.loadTokens();

        const status = {
          configured,
          authenticated: hasTokens,
          sellerId: process.env.AMAZON_SELLER_ID || null,
          marketplaceId: process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER',
          tokenExpiresAt: tokens?.expires_at ? new Date(tokens.expires_at).toISOString() : null,
          authUrl: configured && !hasTokens ? '/oauth/amazon' : null
        };

        if (hasTokens) {
          try {
            const participations = await amazon.getMarketplaceParticipations();
            status.marketplaces = participations.payload || [];
          } catch (e) {
            status.marketplaceError = e.message;
          }
        }

        sendJson(res, 200, status);
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
    })();
    return;
  }

  // GET /api/amazon/listing/:sku - Get a listing by SKU
  if (req.method === 'GET' && parsedUrl.pathname.startsWith('/api/amazon/listing/')) {
    (async () => {
      try {
        const amazon = require('./integrations/amazon');
        if (!amazon.hasValidTokens()) {
          sendJson(res, 401, { error: 'Not authenticated. Complete Amazon OAuth flow first.' });
          return;
        }

        const sku = decodeURIComponent(parsedUrl.pathname.split('/').pop());
        const listing = await amazon.getListingsItem(sku);
        sendJson(res, 200, listing);
      } catch (err) {
        sendJson(res, err.status || 500, { error: err.message, detail: err.detail });
      }
    })();
    return;
  }

  // POST /api/amazon/sync-product - Sync a Shopify product to Amazon
  if (req.method === 'POST' && parsedUrl.pathname === '/api/amazon/sync-product') {
    collectRequestBody(req, async (error, body) => {
      if (error) { sendJson(res, 413, { error: error.message }); return; }
      try {
        const amazon = require('./integrations/amazon');
        if (!amazon.hasValidTokens()) {
          sendJson(res, 401, { error: 'Not authenticated. Complete Amazon OAuth flow first.' });
          return;
        }

        const payload = JSON.parse(body || '{}');
        const { shopifyProductId, priceMultiplier = 1.18, category = 'automotive' } = payload;

        if (!shopifyProductId) {
          sendJson(res, 400, { error: 'shopifyProductId required' });
          return;
        }

        // Fetch from Shopify
        const shopifyProduct = await shopify.getProduct(shopifyProductId);
        if (!shopifyProduct) {
          sendJson(res, 404, { error: 'Shopify product not found' });
          return;
        }

        // Sync to Amazon
        const result = await amazon.syncProductToAmazon(shopifyProduct, {
          priceMultiplier,
          category
        });

        sendJson(res, 200, {
          success: true,
          ...result,
          shopifyProductId
        });
      } catch (err) {
        console.error('[Amazon] Sync error:', err);
        sendJson(res, 500, { error: err.message, detail: err.detail });
      }
    });
    return;
  }

  // POST /api/amazon/calculate-price - Calculate Amazon price with fees
  if (req.method === 'POST' && parsedUrl.pathname === '/api/amazon/calculate-price') {
    collectRequestBody(req, (error, body) => {
      if (error) { sendJson(res, 413, { error: error.message }); return; }
      try {
        const amazon = require('./integrations/amazon');
        const { basePrice, category = 'default' } = JSON.parse(body || '{}');

        if (!basePrice || isNaN(basePrice)) {
          sendJson(res, 400, { error: 'basePrice required' });
          return;
        }

        const amazonPrice = amazon.calculateAmazonPrice(parseFloat(basePrice), category);
        const referralFee = amazon.AMAZON_FEES.referralFees[category] || amazon.AMAZON_FEES.referralFees.default;

        sendJson(res, 200, {
          basePrice: parseFloat(basePrice),
          amazonPrice,
          markup: ((amazonPrice / basePrice - 1) * 100).toFixed(1) + '%',
          category,
          fees: {
            referralFee: (referralFee * 100) + '%',
            monthlySubscription: '$' + amazon.AMAZON_FEES.monthlySubscription
          }
        });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
    });
    return;
  }

  // GET /api/amazon/search-catalog - Search Amazon catalog
  if (req.method === 'GET' && parsedUrl.pathname === '/api/amazon/search-catalog') {
    (async () => {
      try {
        const amazon = require('./integrations/amazon');
        if (!amazon.hasValidTokens()) {
          sendJson(res, 401, { error: 'Not authenticated. Complete Amazon OAuth flow first.' });
          return;
        }

        const query = parsedUrl.query || {};
        if (!query.keywords) {
          sendJson(res, 400, { error: 'keywords query parameter required' });
          return;
        }

        const results = await amazon.searchCatalogItems(query.keywords);
        sendJson(res, 200, results);
      } catch (err) {
        sendJson(res, 500, { error: err.message, detail: err.detail });
      }
    })();
    return;
  }

  // Server stats endpoint for dashboard
  if (req.method === 'GET' && parsedUrl.pathname === '/api/server/stats') {
    try {
      const os = require('os');
      const { execSync } = require('child_process');

      // CPU usage - get load average
      const loadAvg = os.loadavg();
      const cpuCount = os.cpus().length;
      const cpuUsagePercent = Math.min(100, Math.round((loadAvg[0] / cpuCount) * 100));

      // Memory
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const memUsagePercent = Math.round((usedMem / totalMem) * 100);

      // Disk space - get all mounted drives (Linux df command)
      let diskTotal = 0, diskUsed = 0, diskFree = 0, diskUsagePercent = 0;
      let drives = [];
      try {
        // Get all mounted drives excluding tmpfs, devtmpfs, etc.
        const dfOutput = execSync("df -B1 --output=target,size,used,avail,pcent -x tmpfs -x devtmpfs 2>/dev/null | tail -n +2", { encoding: 'utf8' });
        const lines = dfOutput.trim().split('\n').filter(Boolean);

        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 5) {
            const mountPoint = parts[0];
            const total = parseInt(parts[1]) || 0;
            const used = parseInt(parts[2]) || 0;
            const free = parseInt(parts[3]) || 0;
            const usePct = parseInt(parts[4]) || 0;

            // Skip boot/efi partition
            if (mountPoint === '/boot/efi') continue;

            drives.push({
              mountPoint,
              name: mountPoint === '/' ? 'Root' : mountPoint.replace('/mnt/', ''),
              totalBytes: total,
              usedBytes: used,
              freeBytes: free,
              usagePercent: usePct,
              totalGB: (total / 1073741824).toFixed(1),
              usedGB: (used / 1073741824).toFixed(1)
            });

            // Set root as the primary disk for backwards compatibility
            if (mountPoint === '/') {
              diskTotal = total;
              diskUsed = used;
              diskFree = free;
              diskUsagePercent = usePct;
            }
          }
        }
      } catch (e) {
        console.error('[Server Stats] Disk check failed:', e.message);
      }

      // Uptime
      const uptimeSeconds = os.uptime();
      const days = Math.floor(uptimeSeconds / 86400);
      const hours = Math.floor((uptimeSeconds % 86400) / 3600);
      const minutes = Math.floor((uptimeSeconds % 3600) / 60);
      const uptimeStr = days > 0 ? `${days}d ${hours}h ${minutes}m` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

      sendJson(res, 200, {
        success: true,
        cpu: {
          usagePercent: cpuUsagePercent,
          loadAvg: loadAvg[0].toFixed(2),
          cores: cpuCount
        },
        memory: {
          totalBytes: totalMem,
          usedBytes: usedMem,
          freeBytes: freeMem,
          usagePercent: memUsagePercent,
          totalGB: (totalMem / 1073741824).toFixed(1),
          usedGB: (usedMem / 1073741824).toFixed(1)
        },
        disk: {
          totalBytes: diskTotal,
          usedBytes: diskUsed,
          freeBytes: diskFree,
          usagePercent: diskUsagePercent,
          totalGB: (diskTotal / 1073741824).toFixed(1),
          usedGB: (diskUsed / 1073741824).toFixed(1)
        },
        drives: drives,
        uptime: uptimeStr,
        uptimeSeconds,
        timestamp: new Date().toISOString()
      });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return;
  }

  // Dashboard stats endpoint - aggregates catalog, orders, sales, inventory data
  if (req.method === 'GET' && parsedUrl.pathname === '/api/dashboard/stats') {
    try {
      const period = parsedUrl.searchParams?.get('period') || 'week';

      // Calculate date range based on period
      const now = new Date();
      let startDate;
      switch (period) {
        case 'today':
          startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          break;
        case 'week':
          startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          break;
        case 'month':
          startDate = new Date(now.getFullYear(), now.getMonth(), 1);
          break;
        case 'year':
          startDate = new Date(now.getFullYear(), 0, 1);
          break;
        default:
          startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      }
      const startDateStr = startDate.toISOString();

      // Catalog stats - use catalog.json file, not database
      let catalogStats = { totalDesigns: 0, categories: 0, localItems: 0, campaigns: 0, topCategories: [] };
      try {
        const catalog = loadCatalogSnapshot();
        const categories = Array.isArray(catalog?.categories) ? catalog.categories : [];
        catalogStats.categories = categories.length;

        // Count total designs across all categories
        let totalDesigns = 0;
        const categoryCounts = {};
        for (const cat of categories) {
          const designCount = Array.isArray(cat.designs) ? cat.designs.length : 0;
          totalDesigns += designCount;
          if (cat.name) {
            categoryCounts[cat.name] = designCount;
          }
        }
        catalogStats.totalDesigns = totalDesigns;

        // Top categories by design count
        catalogStats.topCategories = Object.entries(categoryCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([name, count]) => ({ name, count }));
      } catch (e) { console.error('[Dashboard] Catalog stats error:', e.message); }

      // Local items count (inventory items)
      try {
        const localItems = db.listInventoryItems ? db.listInventoryItems() : [];
        catalogStats.localItems = localItems.length;
      } catch (e) {}

      // Campaigns count - use local listCampaigns() function (reads from files)
      try {
        const campaigns = listCampaigns();
        catalogStats.campaigns = campaigns.filter(c => c.status === 'active' || !c.status).length;
      } catch (e) {}

      // Orders stats - use db.fetchOrders()
      let ordersStats = { pending: 0, processing: 0, completed: 0, total: 0, recentOrders: [] };
      try {
        const orders = db.fetchOrders ? db.fetchOrders() : [];
        ordersStats.pending = orders.filter(o => o.status === 'pending' || o.status === 'new').length;
        ordersStats.processing = orders.filter(o => o.status === 'processing' || o.status === 'in_progress').length;
        ordersStats.completed = orders.filter(o => {
          if (o.status !== 'completed' && o.status !== 'shipped') return false;
          const completedDate = o.completedAt || o.updatedAt;
          if (!completedDate) return false;
          return new Date(completedDate) >= new Date(now.getFullYear(), now.getMonth(), now.getDate());
        }).length;
        ordersStats.total = orders.filter(o => o.status !== 'completed' && o.status !== 'shipped' && o.status !== 'cancelled').length;
        ordersStats.recentOrders = orders.slice(0, 5).map(o => ({
          id: o.orderNumber || o.id,
          design: o.title || 'Unknown',
          status: o.status,
          date: o.createdAt
        }));
      } catch (e) { console.error('[Dashboard] Orders stats error:', e.message); }

      // Sales stats
      let salesStats = { revenue: 0, orderCount: 0, avgOrder: 0, itemsSold: 0, topProducts: [] };
      try {
        // Use fetchOrders from db module
        const allOrders = db.fetchOrders ? db.fetchOrders() : [];
        const periodOrders = allOrders.filter(o => {
          const orderDate = new Date(o.createdAt || o.date);
          return orderDate >= startDate && (o.status === 'completed' || o.status === 'shipped' || o.status === 'paid');
        });
        salesStats.orderCount = periodOrders.length;
        salesStats.revenue = periodOrders.reduce((sum, o) => sum + (o.totalCents || o.total || 0), 0) / 100;
        salesStats.avgOrder = salesStats.orderCount > 0 ? salesStats.revenue / salesStats.orderCount : 0;
        salesStats.itemsSold = periodOrders.reduce((sum, o) => sum + (o.quantity || o.itemCount || 1), 0);

        // Top products
        const productSales = {};
        periodOrders.forEach(o => {
          const name = o.productName || o.designTitle || 'Unknown';
          productSales[name] = (productSales[name] || 0) + (o.quantity || 1);
        });
        salesStats.topProducts = Object.entries(productSales)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([name, sold]) => ({ name, sold }));
      } catch (e) { console.error('[Dashboard] Sales stats error:', e.message); }

      // Inventory stats
      let inventoryStats = { totalItems: 0, lowStock: 0, outOfStock: 0, totalValue: 0, alerts: [] };
      try {
        const inventory = db.listInventoryItems ? db.listInventoryItems() : [];
        inventoryStats.totalItems = inventory.length;
        inventoryStats.lowStock = inventory.filter(i => i.quantity > 0 && i.quantity <= (i.lowStockThreshold || 5)).length;
        inventoryStats.outOfStock = inventory.filter(i => i.quantity <= 0).length;
        inventoryStats.totalValue = inventory.reduce((sum, i) => sum + ((i.quantity || 0) * (i.costCents || 0)), 0) / 100;

        // Stock alerts
        inventoryStats.alerts = inventory
          .filter(i => i.quantity <= (i.lowStockThreshold || 5))
          .slice(0, 5)
          .map(i => ({
            name: i.name || i.title || 'Unknown',
            quantity: i.quantity,
            status: i.quantity <= 0 ? 'out' : 'low'
          }));
      } catch (e) { console.error('[Dashboard] Inventory stats error:', e.message); }

      sendJson(res, 200, {
        success: true,
        catalog: catalogStats,
        orders: ordersStats,
        sales: salesStats,
        inventory: inventoryStats,
        period,
        generatedAt: new Date().toISOString()
      });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return;
  }

  // Dashboard - Social/Marketing stats (Facebook/Meta integration)
  if (req.method === 'GET' && parsedUrl.pathname === '/api/dashboard/social-stats') {
    try {
      const period = parsedUrl.searchParams?.get('period') || '7d';
      const socialStats = await ads.getDashboardSocialStats(period);
      sendJson(res, 200, {
        success: true,
        ...socialStats,
        period,
        generatedAt: new Date().toISOString()
      });
    } catch (e) {
      console.error('[Dashboard] Social stats error:', e.message);
      sendJson(res, 500, { error: e.message });
    }
    return;
  }

  if (req.method === 'GET' && segments[0] === 'productimages') {
    serveProductImage(req, res, segments);
    return;
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && parsedUrl.pathname === '/api/catalog') {
    serveCatalogResponse(req, res, 'apparel');
    return;
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && parsedUrl.pathname === '/api/catalog/decal-icons') {
    serveCatalogResponse(req, res, 'decal-icons');
    return;
  }

  // Canva integration: simple health check
  if (req.method === 'GET' && parsedUrl.pathname === '/api/integrations/canva/health') {
    sendJson(res, 200, { ok: true, message: 'Canva integration is up' });
    return;
  }

  // Canva Publish endpoint (scaffold): accepts multipart upload (preferred) or JSON { url, filename, title, category }
  if (req.method === 'POST' && parsedUrl.pathname === '/api/integrations/canva/publish') {
    handleCanvaPublish(req, res);
    return;
  }

  // Shopify webhook: products/create (audience/campaign pipeline)
  if (req.method === 'POST' && parsedUrl.pathname === '/api/webhooks/shopify/products/create') {
    // Optional HMAC validation
    const sharedSecret =
      process.env.SHOPIFY_WEBHOOK_SECRET ||
      process.env.SHOPIFY_WEBHOOK_SHARED_SECRET ||
      '';
    const hmacHeader = req.headers['x-shopify-hmac-sha256'] || '';
    collectRequestBody(req, async (error, body) => {
      if (error) { sendJson(res, 413, { error: error.message }); return; }
      try {
        if (sharedSecret && hmacHeader) {
          try {
            const digest = crypto.createHmac('sha256', sharedSecret).update(body || '', 'utf8').digest('base64');
            if (digest !== String(hmacHeader).trim()) {
              sendJson(res, 401, { error: 'Invalid webhook signature.' });
              return;
            }
          } catch (_) {
            sendJson(res, 401, { error: 'Invalid webhook signature.' });
            return;
          }
        }
        const payload = JSON.parse(body || '{}');
        const product = payload || {};
        const productId = product?.id || product?.product_id || null;
        let marketingProfile = null;
        try {
          if (shopify.isConfigured() && productId) {
            const metafields = await shopify.getShopifyMetafields(productId);
            marketingProfile = metafields?.marketing_profile || null;
          }
        } catch (e) {
          console.warn('Shopify metafields fetch failed:', e?.message || e);
        }
        // Fallback: try embedded metafields if present
        if (!marketingProfile && product?.metafields) {
          try { marketingProfile = JSON.parse(product.metafields?.marketing?.marketing_profile || '{}'); } catch (_) {}
        }
        marketingProfile = marketingProfile || {};

        // Option A: Parse marketing:* tags on the product to enrich profile
        try {
          const tagProfile = parseMarketingTags(product?.tags);
          // Merge: tags provide defaults, metafields override
          marketingProfile = { ...tagProfile, ...marketingProfile };
        } catch (e) {
          console.warn('Tag parsing failed:', e?.message || e);
        }

        // Collection inheritance: if no product-level profile, try from first collection
        if ((!marketingProfile || !marketingProfile.audience_segment) && shopify.isConfigured() && productId) {
          try {
            const collections = await shopify.getProductCollections(productId);
            for (const c of collections) {
              const cm = await shopify.getCollectionMetafields(c.id);
              if (cm && cm.marketing_profile && cm.marketing_profile.audience_segment) {
                marketingProfile = { ...cm.marketing_profile, ...marketingProfile };
                break;
              }
            }
          } catch (e) {
            console.warn('Collection inheritance failed:', e?.message || e);
          }
        }

        // Auto-tag if still missing and enabled
        if ((!marketingProfile || !marketingProfile.audience_segment) && (process.env.MARKETING_AUTOTAG_ENABLED === '1' || process.env.MARKETING_AUTOTAG_ENABLED === 'true')) {
          try {
            const guess = classifyMarketingProfile(product);
            marketingProfile = { ...guess, ...marketingProfile };
            // Optional write-back to Shopify metafield
            if (shopify.isConfigured() && productId && (process.env.MARKETING_AUTOTAG_WRITEBACK === '1' || process.env.MARKETING_AUTOTAG_WRITEBACK === 'true')) {
              await shopify.createShopifyMetafields(productId, marketingProfile);
            }
          } catch (e) {
            console.warn('Auto-tagging failed:', e?.message || e);
          }
        }

        // Audience mapping
        const audienceSeg = marketingProfile.audience_segment || 'general';
        const mapping = ads.mapAudienceToAds(audienceSeg) || {};
        const templateKey = marketingProfile.ad_template || mapping.creative_template || 'default';
        const creative = ads.generateAdCreative(product, templateKey, { marketing_profile: marketingProfile });

        // Non-blocking: spawn ad creation in background; immediately 200 OK
        setImmediate(async () => {
          try {
            const name = `${product?.title || 'Product'} · ${audienceSeg}`;
            // Meta example (guarded by env config)
            if (process.env.META_ACCESS_TOKEN && process.env.META_AD_ACCOUNT_ID) {
              const targeting = ads.buildMetaTargetingFromProfile(marketingProfile, mapping);
              await ads.createAdCampaign('meta', { name, audience_id: mapping.meta_audience_id, creative, budget: 500, targeting });
            }
            // TikTok example
            if (process.env.TIKTOK_ACCESS_TOKEN && process.env.TIKTOK_AD_ACCOUNT_ID) {
              const ttTargeting = ads.buildTikTokTargetingFromProfile(marketingProfile, mapping);
              await ads.createAdCampaign('tiktok', { name, audience_id: mapping.tiktok_audience_id, creative, budget: 500, targeting: ttTargeting });
            }
          } catch (e) {
            console.warn('Ad creation error:', e?.message || e);
          }
        });

        sendJson(res, 200, { success: true });
      } catch (e) {
        console.error('Shopify webhook error:', e);
        sendJson(res, 400, { error: e?.message || 'Invalid webhook payload.' });
      }
    });
    return;
  }

  // Shopify webhook: carts/create (test receiver)
  if (req.method === 'POST' && parsedUrl.pathname === '/api/webhooks/shopify/carts/create') {
    const sharedSecret =
      process.env.SHOPIFY_WEBHOOK_SECRET ||
      process.env.SHOPIFY_WEBHOOK_SHARED_SECRET ||
      '';
    const hmacHeader = req.headers['x-shopify-hmac-sha256'] || '';
    const topicHeader = req.headers['x-shopify-topic'] || '';
    const shopHeader = req.headers['x-shopify-shop-domain'] || '';
    collectRequestBody(req, async (error, body) => {
      if (error) { sendJson(res, 413, { error: error.message }); return; }
      try {
        if (sharedSecret && hmacHeader) {
          try {
            const digest = crypto.createHmac('sha256', sharedSecret).update(body || '', 'utf8').digest('base64');
            if (digest !== String(hmacHeader).trim()) { sendJson(res, 401, { error: 'Invalid webhook signature.' }); return; }
          } catch (_) { sendJson(res, 401, { error: 'Invalid webhook signature.' }); return; }
        }
        let payload = {};
        try { payload = JSON.parse(body || '{}'); } catch (_) {}
        const meta = {
          topic: String(topicHeader || 'carts/create'),
          shop: String(shopHeader || ''),
          token: payload && (payload.token || payload.cart_token || null),
          id: payload && (payload.id || null)
        };
        appendShopifyCartEvent({ meta, payload });
        sendJson(res, 200, { success: true });
      } catch (e) {
        console.error('Shopify carts/create webhook error:', e);
        sendJson(res, 500, { error: e?.message || 'Unable to process cart webhook.' });
      }
    });
    return;
  }

  // Shopify webhook: orders/create (ingest orders)
  if (req.method === 'POST' && parsedUrl.pathname === '/api/webhooks/shopify/orders/create') {
    const sharedSecret =
      process.env.SHOPIFY_WEBHOOK_SECRET ||
      process.env.SHOPIFY_WEBHOOK_SHARED_SECRET ||
      '';
    const hmacHeader = req.headers['x-shopify-hmac-sha256'] || '';
    collectRequestBody(req, async (error, body) => {
      if (error) { sendJson(res, 413, { error: error.message }); return; }
      try {
        if (sharedSecret && hmacHeader) {
          try {
            const digest = crypto.createHmac('sha256', sharedSecret).update(body || '', 'utf8').digest('base64');
            if (digest !== String(hmacHeader).trim()) { sendJson(res, 401, { error: 'Invalid webhook signature.' }); return; }
          } catch (_) { sendJson(res, 401, { error: 'Invalid webhook signature.' }); return; }
        }
        const payload = JSON.parse(body || '{}');
        await handleShopifyOrderWebhook(payload, { topic: 'orders/create' });
        sendJson(res, 200, { success: true });
      } catch (e) {
        console.error('Shopify orders/create webhook error:', e);
        sendJson(res, 500, { error: e?.message || 'Unable to ingest order.' });
      }
    });
    return;
  }

  // Shopify webhook: orders/create (POD backend, alternate path)
  if (req.method === 'POST' && parsedUrl.pathname === '/shopify/webhooks/orders-create') {
    const sharedSecret =
      process.env.SHOPIFY_WEBHOOK_SECRET ||
      process.env.SHOPIFY_WEBHOOK_SHARED_SECRET ||
      '';
    const hmacHeader = req.headers['x-shopify-hmac-sha256'] || '';
    collectRequestBody(req, async (error, body) => {
      if (error) { sendJson(res, 413, { error: error.message }); return; }
      try {
        if (sharedSecret && hmacHeader) {
          try {
            const digest = crypto
              .createHmac('sha256', sharedSecret)
              .update(body || '', 'utf8')
              .digest('base64');
            if (digest !== String(hmacHeader).trim()) {
              sendJson(res, 401, { error: 'Invalid webhook signature.' });
              return;
            }
          } catch (_) {
            sendJson(res, 401, { error: 'Invalid webhook signature.' });
            return;
          }
        }
        const payload = JSON.parse(body || '{}');
        await handleShopifyOrderWebhook(payload, { topic: 'orders/create' });
        sendJson(res, 200, { success: true });
      } catch (e) {
        console.error('Shopify POD orders/create webhook error:', e);
        sendJson(res, 500, { error: e?.message || 'Unable to ingest order.' });
      }
    });
    return;
  }

  // Shopify webhook: orders/paid (update payment status)
  if (req.method === 'POST' && parsedUrl.pathname === '/api/webhooks/shopify/orders/paid') {
    const sharedSecret =
      process.env.SHOPIFY_WEBHOOK_SECRET ||
      process.env.SHOPIFY_WEBHOOK_SHARED_SECRET ||
      '';
    const hmacHeader = req.headers['x-shopify-hmac-sha256'] || '';
    collectRequestBody(req, async (error, body) => {
      if (error) { sendJson(res, 413, { error: error.message }); return; }
      try {
        if (sharedSecret && hmacHeader) {
          try {
            const digest = crypto.createHmac('sha256', sharedSecret).update(body || '', 'utf8').digest('base64');
            if (digest !== String(hmacHeader).trim()) { sendJson(res, 401, { error: 'Invalid webhook signature.' }); return; }
          } catch (_) { sendJson(res, 401, { error: 'Invalid webhook signature.' }); return; }
        }
        const payload = JSON.parse(body || '{}');
        await handleShopifyOrderWebhook(payload, { topic: 'orders/paid' });
        sendJson(res, 200, { success: true });
      } catch (e) {
        console.error('Shopify orders/paid webhook error:', e);
        sendJson(res, 500, { error: e?.message || 'Unable to process order payment update.' });
      }
    });
    return;
  }

  // Metal Prints API routes
  if (parsedUrl.pathname && parsedUrl.pathname.startsWith('/apps/metal-prints/api/')) {
    // Create a mini Express-like request/response wrapper for the router
    const fakeNext = (err) => {
      if (err) {
        console.error('Metal prints API error:', err);
        sendJson(res, 500, { success: false, error: err.message || 'Internal server error' });
      } else {
        // Route not found in metal prints router
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
      }
    };

    // Add helper methods to response object if needed
    if (!res.json) {
      res.json = (data) => sendJson(res, 200, data);
    }
    if (!res.status) {
      res.status = (code) => {
        res.statusCode = code;
        return res;
      };
    }
    if (!res.sendFile) {
      res.sendFile = (filePath) => {
        fs.readFile(filePath, (err, data) => {
          if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('File not found');
            return;
          }
          const ext = path.extname(filePath).toLowerCase();
          const contentType = {
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.heic': 'image/heic'
          }[ext] || 'application/octet-stream';
          res.writeHead(200, { 'Content-Type': contentType });
          res.end(data);
        });
      };
    }

    // Handle the route with the metal prints router
    metalPrints.router.handle(req, res, fakeNext);
    return;
  }

  // Metal Print Sublimation Filter API
  if (req.method === 'POST' && parsedUrl.pathname === '/api/metal-print/apply-filter') {
    handleApplyMetalPrintFilter(req, res).catch(err => {
      console.error('[Metal Print Filter Error]', err);
      sendJson(res, 500, { success: false, error: err.message || 'Internal server error' });
    });
    return;
  }

  // Metal Print Campaign Export to Shopify (async - returns immediately with job ID)
  if (req.method === 'POST' && parsedUrl.pathname === '/api/metal-print/export-campaign') {
    if (!requireInternalKey(req, res)) return;
    handleMetalPrintCampaignExport(req, res).catch(err => {
      console.error('[Metal Print Campaign Export Error]', err);
      sendJson(res, 500, { success: false, error: err.message || 'Internal server error' });
    });
    return;
  }

  // Metal Print Export Status endpoint
  if (req.method === 'GET' && parsedUrl.pathname.startsWith('/api/metal-print/export-status/')) {
    const slug = parsedUrl.pathname.replace('/api/metal-print/export-status/', '');
    handleMetalPrintExportStatus(req, res, slug).catch(err => {
      console.error('[Metal Print Export Status Error]', err);
      sendJson(res, 500, { success: false, error: err.message || 'Internal server error' });
    });
    return;
  }

  // ============================================================================
  // STICKER SHEET GENERATOR API
  // ============================================================================

  // List sticker categories
  if (req.method === 'GET' && parsedUrl.pathname === '/api/sticker-sheets/categories') {
    if (!requireInternalKey(req, res)) return;
    handleStickerSheetCategories(req, res).catch(err => {
      console.error('[Sticker Sheet Categories Error]', err);
      sendJson(res, 500, { success: false, error: err.message || 'Internal server error' });
    });
    return;
  }

  // List stickers in a category
  if (req.method === 'GET' && parsedUrl.pathname === '/api/sticker-sheets/catalog') {
    if (!requireInternalKey(req, res)) return;
    handleStickerSheetCatalog(req, res, parsedUrl).catch(err => {
      console.error('[Sticker Sheet Catalog Error]', err);
      sendJson(res, 500, { success: false, error: err.message || 'Internal server error' });
    });
    return;
  }

  // Generate sticker sheets from manual selection
  if (req.method === 'POST' && parsedUrl.pathname === '/api/sticker-sheets/generate') {
    if (!requireInternalKey(req, res)) return;
    handleStickerSheetGenerate(req, res).catch(err => {
      console.error('[Sticker Sheet Generate Error]', err);
      sendJson(res, 500, { success: false, error: err.message || 'Internal server error' });
    });
    return;
  }

  // Generate sticker sheets from Shopify order
  if (req.method === 'POST' && parsedUrl.pathname === '/api/sticker-sheets/from-order') {
    if (!requireInternalKey(req, res)) return;
    handleStickerSheetFromOrder(req, res).catch(err => {
      console.error('[Sticker Sheet From Order Error]', err);
      sendJson(res, 500, { success: false, error: err.message || 'Internal server error' });
    });
    return;
  }

  // Get grid layout info (for UI preview)
  if (req.method === 'GET' && parsedUrl.pathname === '/api/sticker-sheets/grid-info') {
    if (!requireInternalKey(req, res)) return;
    const sizeInches = parseFloat(parsedUrl.searchParams?.get('size') || parsedUrl.query?.size) || 3;
    const grid = stickerSheets.calculateGridLayout(sizeInches);
    sendJson(res, 200, {
      success: true,
      grid: {
        cols: grid.cols,
        rows: grid.rows,
        capacity: grid.capacity,
        stickerSizeInches: grid.stickerSizeInches,
        sheetWidthInches: stickerSheets.SHEET_CONFIG.widthInches,
        sheetHeightInches: stickerSheets.SHEET_CONFIG.heightInches
      }
    });
    return;
  }

  // List generated sticker sheet batches
  if (req.method === 'GET' && parsedUrl.pathname === '/api/sticker-sheets/list') {
    if (!requireInternalKey(req, res)) return;
    handleStickerSheetsList(req, res).catch(err => {
      console.error('[Sticker Sheets List Error]', err);
      sendJson(res, 500, { success: false, error: err.message || 'Internal server error' });
    });
    return;
  }

  // ===== TASK TRACKER API =====
  // Get all active and recent tasks for dashboard display
  if (req.method === 'GET' && parsedUrl.pathname === '/api/tasks/status') {
    if (!requireInternalKey(req, res)) return;
    try {
      const summary = taskTracker.getTasksSummary();
      sendJson(res, 200, { success: true, ...summary });
    } catch (err) {
      console.error('[Task Status Error]', err);
      sendJson(res, 500, { success: false, error: err.message });
    }
    return;
  }

  // Get specific task by ID
  if (req.method === 'GET' && parsedUrl.pathname.startsWith('/api/tasks/')) {
    if (!requireInternalKey(req, res)) return;
    const taskId = parsedUrl.pathname.replace('/api/tasks/', '');
    try {
      const task = taskTracker.getTask(taskId);
      if (task) {
        sendJson(res, 200, { success: true, task });
      } else {
        sendJson(res, 404, { success: false, error: 'Task not found' });
      }
    } catch (err) {
      console.error('[Task Get Error]', err);
      sendJson(res, 500, { success: false, error: err.message });
    }
    return;
  }

  // Leonardo AI Image Generator API
  if (parsedUrl.pathname && parsedUrl.pathname.startsWith('/api/leonardo')) {
    handleLeonardoRoute(parsedUrl.pathname, req, res).catch(err => {
      console.error('[Leonardo API Error]', err);
      sendJson(res, 500, { success: false, error: err.message || 'Internal server error' });
    });
    return;
  }

  // Simple POD admin view: list open POD orders (not yet fully shipped)
  if (req.method === 'GET' && parsedUrl.pathname === '/orders/open') {
    try {
      const items = db.listOpenPodOrders();
      sendJson(res, 200, { success: true, orders: items });
    } catch (error) {
      console.error('Unable to load open POD orders:', error);
      sendJson(res, 500, { error: error?.message || 'Unable to load open orders.' });
    }
    return;
  }

  // Internal: marketing classify (requires INTERNAL_API_KEY)
  if (
    req.method === 'POST' &&
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'marketing' &&
    segments[3] === 'classify'
  ) {
    if (!requireInternalKey(req, res)) return;
    collectRequestBody(req, async (error, body) => {
      if (error) { sendJson(res, 413, { error: error.message }); return; }
      try {
        const payload = JSON.parse(body || '{}');
        const product = payload.product || {};
        const result = classifyMarketingProfile(product);
        sendJson(res, 200, { success: true, marketing_profile: result });
      } catch (e) {
        sendJson(res, 400, { error: e?.message || 'Invalid payload.' });
      }
    });
    return;
  }

  // Internal: LLM classify (requires INTERNAL_API_KEY)
  if (
    req.method === 'POST' &&
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'marketing' &&
    segments[3] === 'llm' &&
    segments[4] === 'classify'
  ) {
    if (!requireInternalKey(req, res)) return;
    const provider = (process.env.LLM_PROVIDER || 'ollama').toLowerCase();
    const baseUrl = process.env.LLM_API_URL || '';
    const model = process.env.LLM_MODEL || '';
    const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 15000);
    if (!baseUrl || !model) { sendJson(res, 503, { error: 'LLM not configured (set LLM_API_URL and LLM_MODEL).' }); return; }
    collectRequestBody(req, async (error, body) => {
      if (error) { sendJson(res, 413, { error: error.message }); return; }
      try {
        const payload = body ? JSON.parse(body || '{}') : {};
        const product = payload.product || {};
        const existing = payload.existing_profile || {};
        const tags = payload.tags || [];
        const ocr = payload.ocr_text || '';
        const collection = payload.collection || '';

        const systemPrompt = 'You are a marketing classification assistant. Given product information, return a JSON object under key marketing_profile. Include: audience_segment (string), interests (string[]), generation (string), tone (string), ad_template (string), ad_audience_id (string), campaign_priority (integer 0-100), keywords (string[]), demographics (object with age_range (string like "18-24","25-34","35-44","45-54","55+"), gender ("male"|"female"|"all"), income_bracket ("low"|"middle"|"high")), locations (array of { country (2-letter), state (optional), city (optional) } prioritized by relevance), safety_flags (object with sensitive (boolean), adult (boolean), restricted_platforms (string[])), and confidence (0-100). Be specific when the product indicates niches (e.g., pinup girls → likely interests, gender, age). Infer locations from tags, collection, OCR, title/description; if unknown, leave a generic US-only location. Respect existing_profile (it overrides your guesses). Use concise, lower-case values. Output JSON only.';
        const userPayload = { title: product.title || '', description: product.description || product.body_html || '', tags, collection, ocr_text: ocr, existing_profile: existing };

        function withTimeout(promise, ms) {
          return new Promise((resolve, reject) => {
            const id = setTimeout(() => reject(new Error('timeout')), ms);
            promise.then((v) => { clearTimeout(id); resolve(v); }).catch((e) => { clearTimeout(id); reject(e); });
          });
        }

        async function callOllama() {
          const data = JSON.stringify({ model, options: { temperature: 0.2 }, messages: [ { role: 'system', content: systemPrompt }, { role: 'user', content: JSON.stringify(userPayload) } ] });
          const u = new URL('/api/chat', baseUrl);
          const isHttps = u.protocol === 'https:';
          const lib = isHttps ? https : http;
          const reqPromise = new Promise((resolve, reject) => {
            const req2 = lib.request({ method: 'POST', hostname: u.hostname, port: u.port || (isHttps ? 443 : 80), path: u.pathname + (u.search || ''), headers: { 'Content-Type': 'application/json' } }, (r) => {
              const chunks = [];
              r.on('data', (c) => chunks.push(c));
              r.on('end', () => {
                try {
                  const text = Buffer.concat(chunks).toString('utf8');
                  const json = JSON.parse(text || '{}');
                  const content = json?.message?.content || '{}';
                  resolve(content);
                } catch (e) { reject(e); }
              });
            });
            req2.on('error', reject);
            req2.write(data);
            req2.end();
          });
          return withTimeout(reqPromise, LLM_TIMEOUT_MS);
        }

        async function callOpenAICompat() {
          const data = JSON.stringify({ model, temperature: 0.2, messages: [ { role: 'system', content: systemPrompt }, { role: 'user', content: JSON.stringify(userPayload) } ], response_format: { type: 'json_object' } });
          const u = new URL('/chat/completions', baseUrl);
          const isHttps = u.protocol === 'https:';
          const lib = isHttps ? https : http;
          const headers = { 'Content-Type': 'application/json' };
          if (process.env.LLM_API_KEY) headers['Authorization'] = `Bearer ${process.env.LLM_API_KEY}`;
          const reqPromise = new Promise((resolve, reject) => {
            const req2 = lib.request({ method: 'POST', hostname: u.hostname, port: u.port || (isHttps ? 443 : 80), path: u.pathname + (u.search || ''), headers }, (r) => {
              const chunks = [];
              r.on('data', (c) => chunks.push(c));
              r.on('end', () => {
                try {
                  const text = Buffer.concat(chunks).toString('utf8');
                  const json = JSON.parse(text || '{}');
                  const content = json?.choices?.[0]?.message?.content || '{}';
                  resolve(content);
                } catch (e) { reject(e); }
              });
            });
            req2.on('error', reject);
            req2.write(data);
            req2.end();
          });
          return withTimeout(reqPromise, LLM_TIMEOUT_MS);
        }

        let content = '{}';
        if (provider === 'ollama') content = await callOllama(); else content = await callOpenAICompat();
        // Parse JSON from content robustly (strip code fences, trim trailing text)
        function extractJsonObject(text) {
          const s = String(text || '').replace(/^```json\s*|```$/g, '').trim();
          const first = s.indexOf('{');
          const last = s.lastIndexOf('}');
          if (first >= 0 && last > first) {
            const candidate = s.slice(first, last + 1);
            try { return JSON.parse(candidate); } catch (_) {}
          }
          // Fallback: try original
          try { return JSON.parse(s); } catch (_) {}
          return {};
        }
        let profile = extractJsonObject(content);
        if (!profile || typeof profile !== 'object') profile = {};
        sendJson(res, 200, { success: true, marketing_profile: profile });
      } catch (e) {
        const message = e?.message || 'LLM classify failed.';
        // If timeout or upstream 504-ish, hint for retry
        sendJson(res, 500, { error: message });
      }
    });
    return;
  }

  if (req.method === 'GET' && parsedUrl.pathname === '/api/public/config') {
    const smsMsgsPerMonth = Number(process.env.SMS_MSGS_PER_MONTH || process.env.SMS_MESSAGES_PER_MONTH || 4) || 4;
    sendJson(res, 200, { success: true, smsMsgsPerMonth });
    return;
  }

  // ============================================================================
  // Car Templates API (Public - for race decal designer)
  // ============================================================================

  // GET /api/car-templates - List all car templates
  if (req.method === 'GET' && parsedUrl.pathname === '/api/car-templates') {
    try {
      const make = parsedUrl.query?.make || null;
      const templates = db.listCarTemplates({ make: make || undefined, verified: true });
      sendJson(res, 200, { success: true, templates });
    } catch (error) {
      console.error('Unable to list car templates:', error);
      sendJson(res, 500, { error: 'Unable to load car templates.' });
    }
    return;
  }

  // GET /api/car-templates/makes - List distinct makes
  if (req.method === 'GET' && parsedUrl.pathname === '/api/car-templates/makes') {
    try {
      const makes = db.getDistinctCarMakes();
      sendJson(res, 200, { success: true, makes });
    } catch (error) {
      console.error('Unable to list car makes:', error);
      sendJson(res, 500, { error: 'Unable to load car makes.' });
    }
    return;
  }

  // GET /api/car-templates/models/:make - List models for a make
  if (
    req.method === 'GET' &&
    segments[0] === 'api' &&
    segments[1] === 'car-templates' &&
    segments[2] === 'models' &&
    segments[3]
  ) {
    try {
      const make = decodeURIComponent(segments[3]);
      const models = db.getCarModelsByMake(make);
      sendJson(res, 200, { success: true, models });
    } catch (error) {
      console.error('Unable to list car models:', error);
      sendJson(res, 500, { error: 'Unable to load car models.' });
    }
    return;
  }

  // GET /api/car-templates/find?make=X&model=Y&year=Z - Find matching template
  if (req.method === 'GET' && parsedUrl.pathname === '/api/car-templates/find') {
    try {
      const make = parsedUrl.query?.make || null;
      const model = parsedUrl.query?.model || null;
      const year = parseInt(parsedUrl.query?.year || '0', 10);
      if (!make || !model || !year) {
        sendJson(res, 400, { error: 'make, model, and year are required.' });
        return;
      }
      const template = db.findCarTemplate(make, model, year);
      if (!template) {
        sendJson(res, 404, { error: 'No template found for this vehicle.', notFound: true });
        return;
      }
      sendJson(res, 200, { success: true, template });
    } catch (error) {
      console.error('Unable to find car template:', error);
      sendJson(res, 500, { error: 'Unable to find car template.' });
    }
    return;
  }

  // GET /api/car-templates/:id - Get specific template by ID
  if (
    req.method === 'GET' &&
    segments[0] === 'api' &&
    segments[1] === 'car-templates' &&
    segments[2] &&
    segments[2] !== 'makes' &&
    segments[2] !== 'models' &&
    segments[2] !== 'find'
  ) {
    try {
      const template = db.getCarTemplateById(segments[2]);
      if (!template) {
        sendJson(res, 404, { error: 'Template not found.' });
        return;
      }
      sendJson(res, 200, { success: true, template });
    } catch (error) {
      console.error('Unable to load car template:', error);
      sendJson(res, 500, { error: 'Unable to load car template.' });
    }
    return;
  }

  // Alias: serve /web/vector/imagetracer.min.js from the vendor copy so clients can
  // reference ./vector/imagetracer.min.js in pages (mirrors image-style paths)
  if (req.method === 'GET' && parsedUrl.pathname === '/web/vector/imagetracer.min.js') {
    try {
      const aliasPath = path.join('vendor', 'imagetracer.min.js');
      serveWebAsset(req, res, aliasPath);
      return;
    } catch (_) {}
    // Fallback to proxy route if vendor path fails
  }

  // Serve videos from /web/videos/ directory
  if (req.method === 'GET' && parsedUrl.pathname && parsedUrl.pathname.startsWith('/web/videos/')) {
    try {
      const videoPath = parsedUrl.pathname.replace('/web/videos/', '');
      const localPath = path.join(WEB_DIR, 'videos', videoPath);

      if (fs.existsSync(localPath)) {
        const stat = fs.statSync(localPath);
        const ext = path.extname(localPath).toLowerCase();
        const contentType = {
          '.mov': 'video/quicktime',
          '.mp4': 'video/mp4',
          '.webm': 'video/webm'
        }[ext] || 'video/mp4';

        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': stat.size,
          'Cache-Control': 'public, max-age=86400',
          'Access-Control-Allow-Origin': '*'
        });
        fs.createReadStream(localPath).pipe(res);
        return;
      }
    } catch (err) {
      console.error('Error serving video:', err);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Video not found');
    return;
  }

  // Serve ImageTracer locally or proxy from CDN for mockups vectorizer
  if (req.method === 'GET' && parsedUrl.pathname === '/web/vendor/imagetracer.min.js') {
    try {
      const localPath = path.join(WEB_DIR, 'vendor', 'imagetracer.min.js');
      if (fs.existsSync(localPath)) {
        const stat = fs.statSync(localPath);
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=UTF-8',
          'Content-Length': stat.size,
          'Cache-Control': 'public, max-age=86400',
          'Access-Control-Allow-Origin': '*'
        });
        fs.createReadStream(localPath).pipe(res);
        return;
      }
      // Proxy from CDN if not present locally
      const cdnUrl = 'https://cdn.jsdelivr.net/npm/imagetracerjs@1.2.6/imagetracer.min.js';
      https.get(cdnUrl, (upstream) => {
        if (upstream.statusCode && upstream.statusCode >= 200 && upstream.statusCode < 300) {
          res.writeHead(200, {
            'Content-Type': upstream.headers['content-type'] || 'application/javascript; charset=UTF-8',
            'Cache-Control': 'public, max-age=86400',
            'Access-Control-Allow-Origin': '*'
          });
          upstream.pipe(res);
        } else {
          sendJson(res, 502, { error: 'Unable to fetch vectorizer library.' });
        }
      }).on('error', () => {
        sendJson(res, 502, { error: 'Unable to fetch vectorizer library.' });
      });
    } catch (error) {
      sendJson(res, 500, { error: 'Vectorizer proxy failed.' });
    }
    return;
  }

  // Public campaigns endpoints
  if (
    (req.method === 'GET' || req.method === 'HEAD') &&
    segments[0] === 'api' &&
    segments[1] === 'public' &&
    segments[2] === 'campaigns'
  ) {
    if (segments[3]) {
      const slug = sanitizeCampaignSlug(segments[3]);
      const campaign = readCampaign(slug);
      if (!campaign) {
        sendJson(res, 404, { error: 'Campaign not found.' });
        return;
      }
      const resolved = resolveCampaignPublic(campaign);
      sendJson(res, 200, { success: true, campaign: resolved });
      return;
    }
    // List campaigns (lightweight info)
    const raw = listCampaigns();
    const list = raw
      .map((c) => ({ slug: c.slug, title: c.title || c.slug, updatedAt: c.updatedAt || null }))
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    sendJson(res, 200, { success: true, campaigns: list });
    return;
  }

  // Admin: Campaigns CRUD (requires INTERNAL_API_KEY)
  if (
    segments[0] === 'api' &&
    segments[1] === 'admin' &&
    segments[2] === 'campaigns'
  ) {
    if (!requireInternalKey(req, res)) return;
    // List campaigns
    if (req.method === 'GET' && segments.length === 3) {
      try {
        const raw = listCampaigns();
        const list = raw
          .map((c) => ({ slug: c.slug, title: c.title || c.slug, updatedAt: c.updatedAt || null }))
          .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
        sendJson(res, 200, { success: true, campaigns: list });
      } catch (e) {
        sendJson(res, 500, { error: e?.message || 'Unable to list campaigns.' });
      }
      return;
    }
    // Read one
    if (req.method === 'GET' && segments[3]) {
      try {
        const slug = sanitizeCampaignSlug(segments[3]);
        const campaign = readCampaign(slug);
        if (!campaign) { sendJson(res, 404, { error: 'Campaign not found.' }); return; }
        sendJson(res, 200, { success: true, campaign });
      } catch (e) {
        sendJson(res, 500, { error: e?.message || 'Unable to load campaign.' });
      }
      return;
    }
    // Create
    if (req.method === 'POST' && segments.length === 3) {
      collectRequestBody(req, (error, body) => {
        if (error) { sendJson(res, 413, { error: error.message }); return; }
        try {
          const payload = body ? JSON.parse(body || '{}') : {};
          const title = String(payload.title || '').trim() || 'Campaign';
          let slug = sanitizeCampaignSlug(title);
          // Ensure unique slug
          const existing = new Set((listCampaigns() || []).map((c) => c.slug));
          let i = 1; const base = slug || 'campaign';
          while (existing.has(slug || '')) { slug = `${base}-${++i}`; }
          const now = new Date().toISOString();
          const campaign = { slug, title, subtitle: payload.subtitle || payload.tagline || '', themeColor: payload.themeColor || '#1d4ed8', hero: payload.hero || null, items: Array.isArray(payload.items) ? payload.items : [], apparel: payload.apparel || null, updatedAt: now };
          writeCampaignFile(slug, campaign);
          sendJson(res, 201, { success: true, campaign });
        } catch (e) {
          sendJson(res, 400, { error: e?.message || 'Invalid payload.' });
        }
      });
      return;
    }
    // Update
    if (req.method === 'POST' && segments[3]) {
      collectRequestBody(req, (error, body) => {
        if (error) { sendJson(res, 413, { error: error.message }); return; }
        try {
          const slug = sanitizeCampaignSlug(segments[3]);
          const current = readCampaign(slug);
          if (!current) { sendJson(res, 404, { error: 'Campaign not found.' }); return; }
          const payload = body ? JSON.parse(body || '{}') : {};

          // Debug logging for OLD handler
          console.log(`[OLD Campaign Update] Slug: ${slug}`);
          if (payload.items && Array.isArray(payload.items) && payload.items.length > 0) {
            console.log(`[OLD Campaign Update] Payload has ${payload.items.length} items`);
            console.log(`[OLD Campaign Update] First item mockupImage: ${payload.items[0].mockupImage || 'NONE'}`);
            console.log(`[OLD Campaign Update] First item shopifyProductId: ${payload.items[0].shopifyProductId || 'NONE'}`);
          } else {
            console.log(`[OLD Campaign Update] Payload items: ${JSON.stringify(payload.items).substring(0, 100)}`);
          }
          if (current.items && current.items.length > 0) {
            console.log(`[OLD Campaign Update] Current first item mockupImage: ${current.items[0].mockupImage || 'NONE'}`);
          }

          const updated = { ...current, ...payload, updatedAt: new Date().toISOString(), slug: current.slug };

          if (updated.items && updated.items.length > 0) {
            console.log(`[OLD Campaign Update] Updated first item mockupImage: ${updated.items[0].mockupImage || 'NONE'}`);
          }

          writeCampaignFile(slug, updated);
          sendJson(res, 200, { success: true, campaign: updated });
        } catch (e) {
          sendJson(res, 400, { error: e?.message || 'Invalid payload.' });
        }
      });
      return;
    }
    // Delete
    if (req.method === 'DELETE' && segments[3]) {
      try {
        const slug = sanitizeCampaignSlug(segments[3]);
        const file = path.join(ensureCampaignsDir(), `${slug}.json`);
        if (!fs.existsSync(file)) { sendJson(res, 404, { error: 'Campaign not found.' }); return; }
        fs.unlinkSync(file);
        sendJson(res, 200, { success: true });
      } catch (e) {
        sendJson(res, 500, { error: e?.message || 'Unable to delete campaign.' });
      }
      return;
    }
  }

  // Campaign tracking (impression/click) + set attribution cookie
  if (
    req.method === 'POST' &&
    segments[0] === 'api' &&
    segments[1] === 'public' &&
    segments[2] === 'campaigns' &&
    segments[3] &&
    segments[4] === 'track'
  ) {
    const slug = sanitizeCampaignSlug(segments[3]);
    setCampaignCookie(res, slug);
    collectRequestBody(req, async (error, body) => {
      try {
        const payload = body ? JSON.parse(body || '{}') : {};
        const event = (payload.event || parsedUrl.query?.event || 'impression').toString();
        const file = path.join(ensureCampaignsDir(), `${slug}-metrics.json`);
        let metrics = { slug, impressions: 0, clicks: 0, last: null };
        try { metrics = { ...metrics, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (_) {}
        if (event === 'click') metrics.clicks += 1; else metrics.impressions += 1;
        metrics.last = new Date().toISOString();
        fs.writeFileSync(file, JSON.stringify(metrics, null, 2), 'utf8');
        sendJson(res, 200, { success: true, metrics });
      } catch (err) {
        const msg = error?.message || err?.message || 'Unable to track campaign.';
        console.error('Campaign track failed:', msg);
        sendJson(res, 400, { error: msg });
      }
    });
    return;
  }

  if (req.method === 'GET' && parsedUrl.pathname === '/api/apparel/products') {
    loadApparelCatalog()
      .then((catalog) => {
        sendJson(res, 200, { success: true, ...catalog });
      })
      .catch((error) => {
        console.error('Unable to load apparel catalog:', error);
        sendJson(res, 500, { error: 'Unable to load apparel catalog.' });
      });
    return;
  }

  // S&S Activewear vendor proxy endpoints
  if (
    segments[0] === 'api' &&
    segments[1] === 'vendors' &&
    segments[2] === 'ssaw'
  ) {
    const action = segments[3] || '';
    if (!ssaw.isConfigured()) {
      sendJson(res, 400, { error: 'Vendor not configured. Set SSAW_ACCOUNT and SSAW_API_KEY in .env' });
      return;
    }
    if (action === 'styles') {
      const q = String(parsedUrl.query.q || parsedUrl.query.search || '').trim();
      const brand = String(parsedUrl.query.brand || '').trim();
      const category = String(parsedUrl.query.category || '').trim();
      ssaw
        .searchStyles({ q, brand, category })
        .then((data) => sendJson(res, 200, { success: true, ...data }))
        .catch((error) => {
          console.error('SSAW vendor error (styles):', error?.message || error);
          sendJson(res, 502, { error: 'Vendor request failed.' });
        });
      return;
    }
    if (action === 'products') {
      const style = parsedUrl.query.style || parsedUrl.query.styleID || parsedUrl.query.id;
      if (!style) {
        sendJson(res, 400, { error: 'Missing style parameter' });
        return;
      }
      ssaw
        .productsByStyle(style)
        .then((data) => sendJson(res, 200, { success: true, ...data }))
        .catch((error) => {
          console.error('SSAW vendor error (products):', error?.message || error);
          sendJson(res, 502, { error: 'Vendor request failed.' });
        });
      return;
    }
    if (action === 'config') {
      if (req.method === 'GET') {
        const cfg = readVendorConfig();
        const preferredWarehouse =
          (cfg?.ssaw?.preferredWarehouse || '').toUpperCase() ||
          (process.env.SSAW_PREF_WAREHOUSE || '').toUpperCase();
        const paymentProfile = cfg?.ssaw?.paymentProfile || process.env.SSAW_PAYMENT_PROFILE || '';
        const paymentEmail = cfg?.ssaw?.paymentEmail || process.env.SSAW_PAYMENT_EMAIL || '';
        const visibleCategories = Array.isArray(cfg?.ssaw?.visibleCategories)
          ? cfg.ssaw.visibleCategories
          : [];
        const visibleBrands = Array.isArray(cfg?.ssaw?.visibleBrands)
          ? cfg.ssaw.visibleBrands
          : [];
        const visibleStyleIncludes = Array.isArray(cfg?.ssaw?.visibleStyleIncludes)
          ? cfg.ssaw.visibleStyleIncludes
          : [];
        const visibleStyleIds = Array.isArray(cfg?.ssaw?.visibleStyleIds)
          ? cfg.ssaw.visibleStyleIds
          : [];
        sendJson(res, 200, {
          success: true,
          preferredWarehouse,
          paymentProfile,
          paymentEmail,
          visibleCategories,
          visibleBrands,
          visibleStyleIncludes,
          visibleStyleIds
        });
        return;
      }
      if (req.method === 'POST' || req.method === 'PATCH') {
        collectRequestBody(req, (error, body) => {
          if (error) {
            sendJson(res, 413, { error: error.message });
            return;
          }
          try {
            const payload = body ? JSON.parse(body) : {};
            const hasPref = Object.prototype.hasOwnProperty.call(payload, 'preferredWarehouse');
            let code = hasPref
              ? String(payload.preferredWarehouse || '').trim().toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4)
              : null;
            const current = readVendorConfig();
            const next = { ...current, ssaw: { ...(current.ssaw || {}) } };
            if (hasPref) {
              next.ssaw.preferredWarehouse = code || '';
            }
            if (payload && Object.prototype.hasOwnProperty.call(payload, 'paymentProfile')) {
              next.ssaw.paymentProfile = payload.paymentProfile || '';
            }
            if (payload && Object.prototype.hasOwnProperty.call(payload, 'paymentEmail')) {
              next.ssaw.paymentEmail = String(payload.paymentEmail || '').trim();
            }
            if (payload && Object.prototype.hasOwnProperty.call(payload, 'visibleCategories')) {
              next.ssaw.visibleCategories = Array.isArray(payload.visibleCategories)
                ? payload.visibleCategories.map((c) => String(c || '').toLowerCase()).filter(Boolean)
                : [];
            }
            if (payload && Object.prototype.hasOwnProperty.call(payload, 'visibleBrands')) {
              next.ssaw.visibleBrands = Array.isArray(payload.visibleBrands)
                ? payload.visibleBrands.map((b) => String(b || '')).filter(Boolean)
                : [];
            }
            if (payload && Object.prototype.hasOwnProperty.call(payload, 'visibleStyleIncludes')) {
              next.ssaw.visibleStyleIncludes = Array.isArray(payload.visibleStyleIncludes)
                ? payload.visibleStyleIncludes.map((t) => String(t || '').toLowerCase()).filter(Boolean)
                : [];
            }
            if (payload && Object.prototype.hasOwnProperty.call(payload, 'visibleStyleIds')) {
              next.ssaw.visibleStyleIds = Array.isArray(payload.visibleStyleIds)
                ? payload.visibleStyleIds.map((id) => String(id || '').trim()).filter(Boolean)
                : [];
            }
            if (!writeVendorConfig(next)) {
              throw new Error('Unable to persist vendor config.');
            }
            sendJson(res, 200, {
              success: true,
              preferredWarehouse: hasPref ? (code || '') : (current?.ssaw?.preferredWarehouse || ''),
              paymentProfile: next.ssaw.paymentProfile || '',
              paymentEmail: next.ssaw.paymentEmail || '',
              visibleCategories: next.ssaw.visibleCategories || [],
              visibleBrands: next.ssaw.visibleBrands || [],
              visibleStyleIncludes: next.ssaw.visibleStyleIncludes || [],
              visibleStyleIds: next.ssaw.visibleStyleIds || []
            });
          } catch (err) {
            sendJson(res, 400, { error: err?.message || 'Invalid payload.' });
          }
        });
        return;
      }
      sendJson(res, 405, { error: 'Method not allowed.' });
      return;
    }
    if (action === 'inventory') {
      const sku = parsedUrl.query.sku || '';
      const style = parsedUrl.query.style || '';
      const color = parsedUrl.query.color || '';
      const size = parsedUrl.query.size || '';
      ssaw
        .inventory({ sku, style, color, size })
        .then((data) => sendJson(res, 200, { success: true, ...data }))
        .catch((error) => {
          console.error('SSAW vendor error (inventory):', error?.message || error);
          sendJson(res, 502, { error: 'Vendor request failed.' });
        });
      return;
    }
    if (action === 'orders' && req.method === 'POST') {
      collectRequestBody(req, (error, body) => {
        if (error) {
          sendJson(res, 413, { error: error.message });
          return;
        }
        let payload = {};
        try {
          payload = body ? JSON.parse(body) : {};
        } catch (err) {
          sendJson(res, 400, { error: 'Invalid JSON payload.' });
          return;
        }
        // Normalize to SSAW order schema (ShippingAddress, Lines, etc.)
        const orderPayload = normalizeSsawOrderPayload(payload);
      ssaw
        .createOrder(orderPayload)
        .then((data) => {
          try {
            const normalized = Array.isArray(data) ? (data[0] || {}) : (data || {});
            const vendorOrderId = String(
              normalized.OrderID || normalized.orderID || normalized.id || ''
            ).trim();
            const customerPO = String(orderPayload.CustomerPO || '').trim();
            const status = String(normalized.OrderStatus || normalized.status || '').trim();
            const shippingMethod = String(
              normalized.ShippingMethod || normalized.shippingMethod || orderPayload.ShippingMethod || ''
            ).trim();
            // Warehouses: from payload or response lines
            const whSet = new Set();
            if (Array.isArray(orderPayload.Warehouses)) {
              orderPayload.Warehouses.forEach((w) => whSet.add(String(w || '').trim()));
            }
            const lines = Array.isArray(normalized.Lines) ? normalized.Lines : [];
            lines.forEach((ln) => {
              if (ln && ln.WarehouseAbbr) whSet.add(String(ln.WarehouseAbbr));
            });
            const warehouses = Array.from(whSet).filter(Boolean).join(', ');
            // Tracking fields if any exist
            const tracking = String(
              (normalized.TrackingNumber || (Array.isArray(normalized.TrackingNumbers) ? normalized.TrackingNumbers.join(', ') : ''))
            ).trim();
            db.upsertVendorOrderRecord({
              vendor: 'S&S Activewear',
              vendorOrderId,
              customerPO,
              status,
              shippingMethod,
              warehouses,
              tracking,
              raw: normalized
            });
          } catch (e) {
            console.warn('Unable to record vendor order locally:', e?.message || e);
          }
          sendJson(res, 201, { success: true, vendorResponse: data });
        })
        .catch((err) => {
          console.error('SSAW vendor error (create order):', err?.message || err);
          sendJson(res, 502, { error: 'Vendor order failed.', details: err?.body || null });
        });
      });
      return;
    }
    if (action === 'orders' && req.method === 'GET') {
      const id = String(parsedUrl.query.id || parsedUrl.query.orderID || '').trim();
      const po = String(parsedUrl.query.po || parsedUrl.query.CustomerPO || '').trim();
      const from = String(parsedUrl.query.from || '').trim();
      const to = String(parsedUrl.query.to || '').trim();
      const status = String(parsedUrl.query.status || '').trim();
      const runner = id
        ? () => ssaw.orderById(id)
        : () => ssaw.listOrders({ customerPO: po, from, to, status });
      runner()
        .then((data) => {
          try {
            const list = Array.isArray(data?.orders) ? data.orders : (data?.order ? [data.order] : []);
            list.forEach((entry) => {
              const vendorOrderId = String(entry?.OrderID || entry?.orderID || entry?.id || '').trim();
              const customerPO = String(entry?.CustomerPO || entry?.customerPO || '').trim();
              const status = String(entry?.OrderStatus || entry?.status || '').trim();
              const shippingMethod = String(entry?.ShippingMethod || entry?.shippingMethod || '').trim();
              const whSet = new Set();
              if (Array.isArray(entry?.Warehouses)) entry.Warehouses.forEach((w) => whSet.add(String(w || '').trim()));
              const lines = Array.isArray(entry?.Lines) ? entry.Lines : [];
              lines.forEach((ln) => ln?.WarehouseAbbr && whSet.add(String(ln.WarehouseAbbr)));
              const warehouses = Array.from(whSet).filter(Boolean).join(', ');
              const tracking = String(
                (entry?.TrackingNumber || (Array.isArray(entry?.TrackingNumbers) ? entry.TrackingNumbers.join(', ') : ''))
              ).trim();
              db.upsertVendorOrderRecord({
                vendor: 'S&S Activewear',
                vendorOrderId,
                customerPO,
                status,
                shippingMethod,
                warehouses,
                tracking,
                raw: entry
              });
            });
          } catch (e) {
            console.warn('Unable to upsert vendor orders locally:', e?.message || e);
          }
          sendJson(res, 200, { success: true, ...data });
        })
        .catch((err) => {
          console.error('SSAW vendor error (list/get orders):', err?.message || err);
          sendJson(res, 502, { error: 'Vendor request failed.' });
        });
      return;
    }
    // Placeholders for future order management actions (cancel, approve, etc.)
    if (action === 'orders' && segments[4] && req.method !== 'GET') {
      // e.g., /api/vendors/ssaw/orders/:id/cancel
      sendJson(res, 501, { error: 'Order management action not implemented yet.' });
      return;
    }
    sendJson(res, 404, { error: 'Unknown vendor action' });
    return;
  }

  if (
    req.method === 'GET' &&
    segments[0] === 'api' &&
    segments[1] === 'apparel' &&
    segments[2] === 'store'
  ) {
    const store = loadApparelStore();
    const assetRoot = process.env.ASSET_BASE_URL || '';
    const items = store.items.map((item) => {
      const preview = item.preview || item.previewPath || null;
      const previewUrl = preview && preview.startsWith('http')
        ? preview
        : item.previewPath
        ? buildAssetProxyUrl(path.join(WEB_DIR, item.previewPath), assetRoot)
        : preview;
      const sources = Array.isArray(item.sources)
        ? item.sources.map((source) => {
            if (!source || !source.file) return source;
            const absolutePath = path.join(WEB_DIR, source.file);
            return {
              ...source,
              url: buildAssetProxyUrl(absolutePath, assetRoot)
            };
          })
        : [];
      return {
        id: item.id,
        name: item.name,
        productType: item.productType,
        categorySlug: item.categorySlug,
        categoryName: item.categoryName,
        preview: previewUrl,
        previewPath: item.previewPath || null,
        libraryCategory: item.libraryCategory || null,
        libraryCategorySlug: item.libraryCategorySlug || null,
        sources,
        createdAt: item.createdAt || null,
        updatedAt: item.updatedAt || null
      };
    });

    const counts = new Map();
    items.forEach((item) => {
      if (!item.categorySlug) return;
      counts.set(item.categorySlug, (counts.get(item.categorySlug) || 0) + 1);
    });

    const categories = store.categories.map((entry) => ({
      slug: entry.slug,
      name: entry.name,
      count: counts.get(entry.slug) || 0
    }));

    sendJson(res, 200, {
      success: true,
      updatedAt: store.updatedAt,
      categories,
      items
    });
    return;
  }

  if (
    req.method === 'GET' &&
    segments[0] === 'api' &&
    segments[1] === 'apparel' &&
    segments[2] === 'categories'
  ) {
    const store = loadApparelStore();
    sendJson(res, 200, {
      success: true,
      updatedAt: store.updatedAt,
      categories: store.categories
    });
    return;
  }

  // Catalog admin operations (requires INTERNAL_API_KEY)
  if (
    segments[0] === 'api' &&
    segments[1] === 'admin' &&
    segments[2] === 'catalog'
  ) {
    const method = req.method;

    function resolveAbsoluteFromCatalogPath(imagePath) {
      if (!imagePath) return null;
      try {
        // Handle full URLs (https://blueridgecustomco.com/web/library/...)
        if (imagePath.startsWith('https://') || imagePath.startsWith('http://')) {
          try {
            const urlObj = new URL(imagePath);
            const pathname = urlObj.pathname;
            // Check if it's a library path
            if (pathname.includes('/web/library/')) {
              const rel = decodeURIComponent(pathname.replace(/^.*\/web\/library\//, ''));
              return path.join(LIBRARY_ROOT, rel);
            }
            // Otherwise treat as web path
            if (pathname.startsWith('/web/')) {
              const rel = decodeURIComponent(pathname.replace(/^\/web\//, ''));
              return path.join(WEB_DIR, rel);
            }
          } catch {
            return null;
          }
        }
        if (imagePath.startsWith('/api/library/')) {
          const rel = decodeURIComponent(imagePath.replace(/^\/api\/library\//, ''));
          return path.join(LIBRARY_ROOT, rel);
        }
        const rel = imagePath.startsWith('/') ? imagePath.slice(1) : imagePath;
        return path.join(WEB_DIR, rel);
      } catch {
        return null;
      }
    }

    function listSiblingFilesForBase(dir, base) {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const files = entries
          .filter((e) => e.isFile())
          .map((e) => e.name)
          .filter((name) => name.startsWith(base + '.'))
          .map((name) => path.join(dir, name));
        return files;
      } catch {
        return [];
      }
    }

    function uniqueTarget(dir, fileName) {
      const ext = path.extname(fileName);
      const name = path.basename(fileName, ext);
      let candidate = fileName;
      let counter = 1;
      while (fs.existsSync(path.join(dir, candidate))) {
        candidate = `${name}-${counter++}${ext}`;
      }
      return path.join(dir, candidate);
    }

    function ensureCategoryDir(slug) {
      const dir = findCategoryDirectoryBySlug(slug);
      if (!dir) {
        throw userError('Target category does not exist.');
      }
      ensureDirectorySafe(dir);
      return dir;
    }

    function findDesignById(catalog, id) {
      const categories = Array.isArray(catalog?.categories) ? catalog.categories : [];
      for (const cat of categories) {
        const found = (cat.designs || []).find((d) => d.id === id);
        if (found) {
          return { category: cat, design: found };
        }
      }
      return null;
    }

    if (method === 'POST' && segments[3] === 'move') {
      if (!requireInternalKey(req, res)) return;
      collectRequestBody(req, async (error, body) => {
        if (error) {
          sendJson(res, 413, { error: error.message });
          return;
        }
        try {
          const payload = body ? JSON.parse(body || '{}') : {};
          const id = sanitizeCopy(payload.id, 200);
          const toSlug = sanitizeCopy(payload.toCategorySlug, 120);
          if (!id || !toSlug) throw userError('id and toCategorySlug are required.');
          const catalog = loadCatalogSnapshot();
          const found = findDesignById(catalog, id);
          if (!found) throw userError('Design not found.');
          const abs = resolveAbsoluteFromCatalogPath(found.design.image);
          if (!abs) throw userError('Unable to resolve file path for design.');
          const dir = path.dirname(abs);
          const base = path.basename(abs, path.extname(abs));
          const related = listSiblingFilesForBase(dir, base);
          const targetCategoryDir = ensureCategoryDir(toSlug);
          const moved = [];
          related.forEach((src) => {
            const target = uniqueTarget(targetCategoryDir, path.basename(src));
            moveFile(src, target);
            moved.push({ from: src, to: target });
          });
          await regenerateCatalog();
          sendJson(res, 200, { success: true, moved: moved.length });
        } catch (err) {
          if (err?.expose) {
            sendJson(res, err.statusCode || 400, { error: err.message });
            return;
          }
          console.error('Catalog move failed:', err);
          sendJson(res, 500, { error: 'Unable to move design.' });
        }
      });
      return;
    }

    if (method === 'POST' && segments[3] === 'rename') {
      if (!requireInternalKey(req, res)) return;
      collectRequestBody(req, async (error, body) => {
        if (error) {
          sendJson(res, 413, { error: error.message });
          return;
        }
        try {
          const payload = body ? JSON.parse(body || '{}') : {};
          const id = sanitizeCopy(payload.id, 200);
          const newName = sanitizeCopy(payload.newName, 120);
          if (!id || !newName) throw userError('id and newName are required.');
          const catalog = loadCatalogSnapshot();
          const found = findDesignById(catalog, id);
          if (!found) throw userError('Design not found.');
          const abs = resolveAbsoluteFromCatalogPath(found.design.image);
          if (!abs) throw userError('Unable to resolve file path for design.');
          const dir = path.dirname(abs);
          const oldBase = path.basename(abs, path.extname(abs));
          const newBase = slugify(newName) || newName.replace(/\s+/g, '-');
          const related = listSiblingFilesForBase(dir, oldBase);
          related.forEach((src) => {
            const ext = path.extname(src);
            const dst = path.join(dir, `${newBase}${ext}`);
            const target = uniqueTarget(dir, path.basename(dst));
            moveFile(src, target);
          });
          await regenerateCatalog();
          sendJson(res, 200, { success: true });
        } catch (err) {
          if (err?.expose) {
            sendJson(res, err.statusCode || 400, { error: err.message });
            return;
          }
          console.error('Catalog rename failed:', err);
          sendJson(res, 500, { error: 'Unable to rename design.' });
        }
      });
      return;
    }

    if (method === 'DELETE' && segments[3] === 'item') {
      if (!requireInternalKey(req, res)) return;
      collectRequestBody(req, async (error, body) => {
        if (error) {
          sendJson(res, 413, { error: error.message });
          return;
        }
        try {
          const payload = body ? JSON.parse(body || '{}') : {};
          const id = sanitizeCopy(payload.id, 200);
          if (!id) throw userError('id is required.');
          const catalog = loadCatalogSnapshot();
          const found = findDesignById(catalog, id);
          if (!found) throw userError('Design not found.');
          const abs = resolveAbsoluteFromCatalogPath(found.design.image);
          if (!abs) throw userError('Unable to resolve file path for design.');
          const dir = path.dirname(abs);
          const base = path.basename(abs, path.extname(abs));
          const related = listSiblingFilesForBase(dir, base);

          // Also delete source files if they exist (sources folder is sibling to previews)
          const sourcesDir = path.join(path.dirname(dir), 'sources');
          const sourceFiles = listSiblingFilesForBase(sourcesDir, base);

          // Delete all related files (previews + sources)
          const allFiles = [...related, ...sourceFiles];
          allFiles.forEach((p) => deleteIfExists(p));
          await regenerateCatalog();
          console.log(`[Catalog Delete] Deleted ${allFiles.length} files for design ${id}:`, allFiles.map(f => path.basename(f)));
          sendJson(res, 200, { success: true, deleted: allFiles.length });
        } catch (err) {
          if (err?.expose) {
            sendJson(res, err.statusCode || 400, { error: err.message });
            return;
          }
          console.error('Catalog delete failed:', err);
          sendJson(res, 500, { error: 'Unable to delete design.' });
        }
      });
      return;
    }

    if (method === 'POST' && segments[3] === 'folder') {
      if (!requireInternalKey(req, res)) return;
      collectRequestBody(req, async (error, body) => {
        if (error) {
          sendJson(res, 413, { error: error.message });
          return;
        }
        try {
          const payload = body ? JSON.parse(body || '{}') : {};
          const name = sanitizeCategoryFolderName(payload.name || payload.folder || payload.category || '');
          if (!name) throw userError('Folder name is required.');
          const slug = slugify(name);
          const existing = findCategoryDirectoryBySlug(slug);
          if (existing) {
            sendJson(res, 200, { success: true, slug, name: path.basename(existing), created: false });
            return;
          }
          const targetDir = path.join(LIBRARY_ROOT, name);
          const rootPrefix = LIBRARY_ROOT.endsWith(path.sep) ? LIBRARY_ROOT : LIBRARY_ROOT + path.sep;
          const withinRoot = targetDir === LIBRARY_ROOT || targetDir.startsWith(rootPrefix);
          if (!withinRoot) throw userError('Invalid target folder.');
          ensureDirectorySafe(targetDir);
          await regenerateCatalog();
          sendJson(res, 200, { success: true, slug, name, created: true });
        } catch (err) {
          if (err?.expose) {
            sendJson(res, err.statusCode || 400, { error: err.message });
            return;
          }
          console.error('Catalog folder create failed:', err);
          sendJson(res, 500, { error: 'Unable to create folder.' });
        }
      });
      return;
    }
  }

  // Campaign admin operations (requires INTERNAL_API_KEY)
  if (
    segments[0] === 'api' &&
    segments[1] === 'admin' &&
    segments[2] === 'campaigns'
  ) {
    // OPTIONS preflight
    if (req.method === 'OPTIONS') {
      handleOptions(res);
      return;
    }
    if (req.method === 'GET') {
      if (!requireInternalKey(req, res)) return;
      if (segments[3]) {
        const slug = sanitizeCampaignSlug(segments[3]);
        const data = readCampaign(slug);
        if (!data) {
          sendJson(res, 404, { error: 'Campaign not found.' });
          return;
        }
        sendJson(res, 200, { success: true, campaign: data });
        return;
      }
      const campaigns = listCampaigns();
      sendJson(res, 200, { success: true, campaigns });
      return;
    }

    if (req.method === 'POST' && segments.length === 3) {
      if (!requireInternalKey(req, res)) return;
      collectRequestBody(req, (error, body) => {
        if (error) {
          sendJson(res, 413, { error: error.message });
          return;
        }
        try {
          const payload = body ? JSON.parse(body || '{}') : {};
          const title = sanitizeCopy(payload.title || '', 120) || null;
          const slug = sanitizeCampaignSlug(payload.slug || title || 'campaign');
          if (readCampaign(slug)) {
            sendJson(res, 409, { error: 'Campaign already exists.', slug });
            return;
          }
          const now = new Date().toISOString();
          const campaign = {
            slug,
            title: title || slug,
            subtitle: sanitizeCopy(payload.subtitle || payload.tagline || '', 200) || '',
            themeColor: sanitizeCopy(payload.themeColor || '', 16) || '#1d4ed8',
            hero: payload.hero || null,
            items: Array.isArray(payload.items) ? payload.items : [],
            schedule: payload.schedule || null,
            utm: payload.utm || { source: 'facebook', medium: 'social', campaign: slug },
            createdAt: now,
            updatedAt: now
          };
          writeCampaignFile(slug, campaign);
          sendJson(res, 201, { success: true, campaign });
        } catch (err) {
          console.error('Unable to create campaign:', err);
          sendJson(res, 400, { error: err.message || 'Invalid payload.' });
        }
      });
      return;
    }

    if (req.method === 'PATCH' && segments[3]) {
      if (!requireInternalKey(req, res)) return;
      collectRequestBody(req, (error, body) => {
        if (error) {
          sendJson(res, 413, { error: error.message });
          return;
        }
        try {
          const slug = sanitizeCampaignSlug(segments[3]);
          const current = readCampaign(slug);
          if (!current) {
            sendJson(res, 404, { error: 'Campaign not found.' });
            return;
          }
          const payload = body ? JSON.parse(body || '{}') : {};
          const updated = {
            ...current,
            ...payload,
            slug: current.slug, // slug immutable
            updatedAt: new Date().toISOString()
          };
          writeCampaignFile(slug, updated);
          sendJson(res, 200, { success: true, campaign: updated });
        } catch (err) {
          console.error('Unable to update campaign:', err);
          sendJson(res, 400, { error: err.message || 'Invalid payload.' });
        }
      });
      return;
    }

    if (req.method === 'DELETE' && segments[3]) {
      if (!requireInternalKey(req, res)) return;
      try {
        const slug = sanitizeCampaignSlug(segments[3]);
        const file = path.join(ensureCampaignsDir(), `${slug}.json`);
        if (!fs.existsSync(file)) {
          sendJson(res, 404, { error: 'Campaign not found.' });
          return;
        }
        fs.unlinkSync(file);
        sendJson(res, 200, { success: true, slug });
      } catch (err) {
        console.error('Unable to delete campaign:', err);
        sendJson(res, 500, { error: err.message || 'Unable to delete campaign.' });
      }
      return;
    }

    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }

  if (
    req.method === 'POST' &&
    segments[0] === 'api' &&
    segments[1] === 'apparel' &&
    segments[2] === 'categories'
  ) {
    if (!requireInternalKey(req, res)) return;
    collectRequestBody(req, async (error, body) => {
      if (error) {
        sendJson(res, 413, { error: error.message });
        return;
      }
      try {
        const payload = body ? JSON.parse(body || '{}') : {};
        const name = payload.name || payload.label || payload.category || '';
        const category = addApparelCategory(name);
        const store = loadApparelStore();
        sendJson(res, 200, {
          success: true,
          category,
          categories: store.categories,
          updatedAt: store.updatedAt
        });
      } catch (err) {
        if (err?.expose) {
          sendJson(res, err.statusCode || 400, { error: err.message });
          return;
        }
        console.error('Unable to add apparel category:', err);
        sendJson(res, 500, { error: err.message || 'Unable to add apparel category.' });
      }
    });
    return;
  }

  if (
    req.method === 'PATCH' &&
    segments[0] === 'api' &&
    segments[1] === 'apparel' &&
    segments[2] === 'store' &&
    segments[3]
  ) {
    if (!requireInternalKey(req, res)) return;
    collectRequestBody(req, (error, body) => {
      if (error) {
        sendJson(res, 413, { error: error.message });
        return;
      }
      try {
        const payload = body ? JSON.parse(body || '{}') : {};
        if (!payload || typeof payload !== 'object') {
          throw userError('Invalid update payload.');
        }
        const item = updateApparelStoreItem(segments[3], payload);
        const store = loadApparelStore();
        sendJson(res, 200, {
          success: true,
          item,
          updatedAt: store.updatedAt
        });
      } catch (err) {
        if (err?.expose) {
          sendJson(res, err.statusCode || 400, { error: err.message });
          return;
        }
        console.error('Unable to update apparel store item:', err);
        sendJson(res, 500, { error: err.message || 'Unable to update apparel item.' });
      }
    });
    return;
  }

  if (segments[0] === 'api' && segments[1] === 'inventory') {
    if (req.method === 'GET') {
      if (segments[2]) {
        const itemId = sanitizeCopy(segments[2], 80);
        const item = db.getInventoryItemById(itemId);
        if (!item) {
          sendJson(res, 404, { error: 'Inventory item not found.' });
          return;
        }
        sendJson(res, 200, { success: true, item });
        return;
      }
      try {
        const material = parsedUrl.query?.material
          ? sanitizeCopy(parsedUrl.query.material, 40).toLowerCase()
          : null;
        const items = db.listInventoryItems({ material: material || null });
        sendJson(res, 200, { success: true, items });
      } catch (error) {
        console.error('Unable to list inventory:', error);
        sendJson(res, 500, { error: 'Unable to list inventory.' });
      }
      return;
    }

    if (req.method === 'POST' && segments.length === 2) {
      collectRequestBody(req, (error, body) => {
        if (error) {
          sendJson(res, 413, { error: error.message });
          return;
        }
        try {
          const payload = body ? JSON.parse(body || '{}') : {};
          const sanitized = sanitizeInventoryItemPayload(payload);
          const item = db.createInventoryItem(sanitized);
          sendJson(res, 201, { success: true, item });
        } catch (err) {
          if (err?.expose) {
            sendJson(res, err.statusCode || 400, { error: err.message });
            return;
          }
          console.error('Unable to create inventory item:', err);
          sendJson(res, 500, { error: err.message || 'Unable to create inventory item.' });
        }
      });
      return;
    }

    if (
      req.method === 'PATCH' &&
      segments[2]
    ) {
      const itemId = sanitizeCopy(segments[2], 80);
      const existing = db.getInventoryItemById(itemId);
      if (!existing) {
        sendJson(res, 404, { error: 'Inventory item not found.' });
        return;
      }
      collectRequestBody(req, (error, body) => {
        if (error) {
          sendJson(res, 413, { error: error.message });
          return;
        }
        try {
          const payload = body ? JSON.parse(body || '{}') : {};
          const updates = sanitizeInventoryUpdatePayload(payload);
          if (!updates || !Object.keys(updates).length) {
            sendJson(res, 400, { error: 'No update fields provided.' });
            return;
          }
          const item = db.updateInventoryItem(itemId, updates);
          sendJson(res, 200, { success: true, item });
        } catch (err) {
          if (err?.expose) {
            sendJson(res, err.statusCode || 400, { error: err.message });
            return;
          }
          console.error('Unable to update inventory item:', err);
          sendJson(res, 500, { error: err.message || 'Unable to update inventory item.' });
        }
      });
      return;
    }

    if (
      req.method === 'POST' &&
      segments[2] &&
      segments[3] === 'adjust'
    ) {
      const itemId = sanitizeCopy(segments[2], 80);
      const existing = db.getInventoryItemById(itemId);
      if (!existing) {
        sendJson(res, 404, { error: 'Inventory item not found.' });
        return;
      }
      collectRequestBody(req, (error, body) => {
        if (error) {
          sendJson(res, 413, { error: error.message });
          return;
        }
        try {
          const payload = body ? JSON.parse(body || '{}') : {};
          const adjustment = sanitizeInventoryAdjustmentPayload(payload);
          const item = db.adjustInventoryQuantity(itemId, adjustment.change, {
            reason: adjustment.reason,
            notes: adjustment.notes
          });
          sendJson(res, 200, { success: true, item });
        } catch (err) {
          if (err?.expose) {
            sendJson(res, err.statusCode || 400, { error: err.message });
            return;
          }
          console.error('Unable to adjust inventory:', err);
          sendJson(res, 500, { error: err.message || 'Unable to adjust inventory.' });
        }
      });
      return;
    }

    if (req.method === 'DELETE' && segments[2]) {
      const itemId = sanitizeCopy(segments[2], 80);
      const existing = db.getInventoryItemById(itemId);
      if (!existing) {
        sendJson(res, 404, { error: 'Inventory item not found.' });
        return;
      }
      try {
        db.deleteInventoryItem(itemId);
        sendJson(res, 200, { success: true });
      } catch (err) {
        if (err?.expose) {
          sendJson(res, err.statusCode || 400, { error: err.message });
          return;
        }
        console.error('Unable to delete inventory item:', err);
        sendJson(res, 500, { error: err.message || 'Unable to delete inventory item.' });
      }
      return;
    }
  }

  // ============================================================================
  // MOCKUP BACKGROUNDS API - for print-station decal mockups
  // ============================================================================
  if (segments[0] === 'api' && segments[1] === 'mockup-backgrounds') {
    // GET /api/mockup-backgrounds - List all backgrounds
    // GET /api/mockup-backgrounds/:id - Get single background
    if (req.method === 'GET') {
      if (segments[2]) {
        const bgId = sanitizeCopy(segments[2], 80);
        const bg = db.getMockupBackgroundById(bgId);
        if (!bg) {
          sendJson(res, 404, { error: 'Background not found.' });
          return;
        }
        sendJson(res, 200, { success: true, background: bg });
        return;
      }
      try {
        const category = parsedUrl.query?.category
          ? sanitizeCopy(parsedUrl.query.category, 40)
          : null;
        const activeOnly = parsedUrl.query?.activeOnly !== 'false';
        const backgrounds = db.listMockupBackgrounds({ category, activeOnly });
        const categories = db.listMockupBackgroundCategories();
        sendJson(res, 200, { success: true, backgrounds, categories });
      } catch (error) {
        console.error('Unable to list mockup backgrounds:', error);
        sendJson(res, 500, { error: 'Unable to list backgrounds.' });
      }
      return;
    }

    // POST /api/mockup-backgrounds - Create new background
    if (req.method === 'POST' && segments.length === 2) {
      collectRequestBody(req, (error, body) => {
        if (error) {
          sendJson(res, 413, { error: error.message });
          return;
        }
        try {
          const payload = body ? JSON.parse(body || '{}') : {};
          if (!payload.name || !payload.filePath) {
            sendJson(res, 400, { error: 'name and filePath are required.' });
            return;
          }
          const bg = db.createMockupBackground({
            name: sanitizeCopy(payload.name, 100),
            category: payload.category ? sanitizeCopy(payload.category, 50) : 'general',
            description: payload.description ? sanitizeCopy(payload.description, 500) : null,
            filePath: payload.filePath,
            thumbnailPath: payload.thumbnailPath || null,
            width: payload.width ? Number(payload.width) : null,
            height: payload.height ? Number(payload.height) : null,
            fileSize: payload.fileSize ? Number(payload.fileSize) : null,
            tags: payload.tags ? sanitizeCopy(payload.tags, 200) : null,
            defaultWidthPct: payload.defaultWidthPct ? Number(payload.defaultWidthPct) : 40,
            defaultXOffset: payload.defaultXOffset ? Number(payload.defaultXOffset) : 0,
            defaultYOffset: payload.defaultYOffset ? Number(payload.defaultYOffset) : 0,
            active: payload.active !== false,
            sortOrder: payload.sortOrder ? Number(payload.sortOrder) : 0
          });
          sendJson(res, 201, { success: true, background: bg });
        } catch (err) {
          console.error('Unable to create mockup background:', err);
          sendJson(res, 500, { error: err.message || 'Unable to create background.' });
        }
      });
      return;
    }

    // PATCH /api/mockup-backgrounds/:id - Update background
    if (req.method === 'PATCH' && segments[2]) {
      const bgId = sanitizeCopy(segments[2], 80);
      const existing = db.getMockupBackgroundById(bgId);
      if (!existing) {
        sendJson(res, 404, { error: 'Background not found.' });
        return;
      }
      collectRequestBody(req, (error, body) => {
        if (error) {
          sendJson(res, 413, { error: error.message });
          return;
        }
        try {
          const payload = body ? JSON.parse(body || '{}') : {};
          const updates = {};
          if (payload.name !== undefined) updates.name = sanitizeCopy(payload.name, 100);
          if (payload.category !== undefined) updates.category = sanitizeCopy(payload.category, 50);
          if (payload.description !== undefined) updates.description = payload.description ? sanitizeCopy(payload.description, 500) : null;
          if (payload.filePath !== undefined) updates.filePath = payload.filePath;
          if (payload.thumbnailPath !== undefined) updates.thumbnailPath = payload.thumbnailPath;
          if (payload.width !== undefined) updates.width = Number(payload.width);
          if (payload.height !== undefined) updates.height = Number(payload.height);
          if (payload.fileSize !== undefined) updates.fileSize = Number(payload.fileSize);
          if (payload.tags !== undefined) updates.tags = payload.tags ? sanitizeCopy(payload.tags, 200) : null;
          if (payload.defaultWidthPct !== undefined) updates.defaultWidthPct = Number(payload.defaultWidthPct);
          if (payload.defaultXOffset !== undefined) updates.defaultXOffset = Number(payload.defaultXOffset);
          if (payload.defaultYOffset !== undefined) updates.defaultYOffset = Number(payload.defaultYOffset);
          if (payload.active !== undefined) updates.active = !!payload.active;
          if (payload.sortOrder !== undefined) updates.sortOrder = Number(payload.sortOrder);

          if (!Object.keys(updates).length) {
            sendJson(res, 400, { error: 'No update fields provided.' });
            return;
          }
          const bg = db.updateMockupBackground(bgId, updates);
          sendJson(res, 200, { success: true, background: bg });
        } catch (err) {
          console.error('Unable to update mockup background:', err);
          sendJson(res, 500, { error: err.message || 'Unable to update background.' });
        }
      });
      return;
    }

    // DELETE /api/mockup-backgrounds/:id - Delete background
    if (req.method === 'DELETE' && segments[2]) {
      const bgId = sanitizeCopy(segments[2], 80);
      const existing = db.getMockupBackgroundById(bgId);
      if (!existing) {
        sendJson(res, 404, { error: 'Background not found.' });
        return;
      }
      try {
        db.deleteMockupBackground(bgId);
        sendJson(res, 200, { success: true });
      } catch (err) {
        console.error('Unable to delete mockup background:', err);
        sendJson(res, 500, { error: err.message || 'Unable to delete background.' });
      }
      return;
    }
  }

  // ============================================================================
  // DATABASE BACKUP API
  // ============================================================================
  if (segments[0] === 'api' && segments[1] === 'backups') {
    // List backups
    if (req.method === 'GET' && segments.length === 2) {
      try {
        const backups = db.listBackups();
        sendJson(res, 200, { success: true, backups });
      } catch (error) {
        console.error('Unable to list backups:', error);
        sendJson(res, 500, { error: 'Unable to list backups.' });
      }
      return;
    }

    // Create manual backup
    if (req.method === 'POST' && segments.length === 2) {
      try {
        const backupPath = db.createBackup('manual');
        sendJson(res, 201, { success: true, path: backupPath });
      } catch (error) {
        console.error('Unable to create backup:', error);
        sendJson(res, 500, { error: 'Unable to create backup.' });
      }
      return;
    }

    // Restore from backup
    if (req.method === 'POST' && segments[2] === 'restore') {
      collectRequestBody(req, (error, body) => {
        if (error) {
          sendJson(res, 413, { error: error.message });
          return;
        }
        try {
          const payload = body ? JSON.parse(body || '{}') : {};
          if (!payload.backupPath) {
            sendJson(res, 400, { error: 'backupPath is required.' });
            return;
          }
          db.restoreFromBackup(payload.backupPath);
          sendJson(res, 200, { success: true, message: 'Database restored. Server restart required.' });
        } catch (err) {
          console.error('Unable to restore backup:', err);
          sendJson(res, 500, { error: err.message || 'Unable to restore backup.' });
        }
      });
      return;
    }
  }

  if (req.method === 'GET' && parsedUrl.pathname === '/api/customer/profile') {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : null;
    const profile = resolveCustomerProfile(token);
    if (!profile) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }
    sendJson(res, 200, { customer: profile });
    return;
  }

  if (req.method === 'PATCH' && parsedUrl.pathname === '/api/customer/profile') {
    const auth = requireAuth(req, res);
    if (!auth) return;
    collectRequestBody(req, (error, body) => {
      if (error) {
        sendJson(res, 413, { error: error.message });
        return;
      }
      try {
        const payload = body ? JSON.parse(body || '{}') : {};
        const updates = {};
        if (Object.prototype.hasOwnProperty.call(payload, 'name')) updates.name = String(payload.name || '');
        if (Object.prototype.hasOwnProperty.call(payload, 'phone')) updates.phone = String(payload.phone || '');
        if (Object.prototype.hasOwnProperty.call(payload, 'address')) updates.address = String(payload.address || '');
        if (Object.prototype.hasOwnProperty.call(payload, 'smsOptIn')) updates.smsOptIn = !!payload.smsOptIn;
        const updated = db.updateCustomerProfile(auth.id, updates);
        const profile = {
          id: updated.id,
          name: updated.name || '',
          email: updated.email || '',
          phone: updated.phone || '',
          address: updated.address || '',
          smsOptIn: Boolean(updated.smsOptIn)
        };
        sendJson(res, 200, { success: true, customer: profile });
      } catch (err) {
        console.error('Unable to update profile:', err);
        sendJson(res, 500, { error: err.message || 'Unable to update profile.' });
      }
    });
    return;
  }

  if (req.method === 'POST' && parsedUrl.pathname === '/api/auth/register') {
    collectRequestBody(req, (error, body) => {
      if (error) {
        sendJson(res, 413, { error: error.message });
        return;
      }
      try {
        const payload = JSON.parse(body || '{}');
        const customer = db.createCustomerAccount(payload);
        const session = db.createSession(customer.id);
        const verification = db.createEmailToken(customer.id, 'verify', 48);
        const verifyLink = makeCustomerLink('verify', verification.token);
        logEmailPreview('verify-account', verifyLink);
        sendVerificationEmail(customer, verifyLink).catch((err) =>
          console.error('Deferred verification email error:', err)
        );
        sendJson(res, 201, {
          success: true,
          token: session.token,
          expiresAt: session.expiresAt,
          customer: {
            id: customer.id,
            name: customer.name,
            email: customer.email,
            phone: customer.phone,
            address: customer.address,
            emailVerified: customer.emailVerified
          },
          verification: {
            token: verification.token,
            previewUrl: verifyLink
          }
        });
      } catch (err) {
        console.error('Registration failed:', err);
        sendJson(res, 400, { error: err.message || 'Unable to create account.' });
      }
    });
    return;
  }

  if (req.method === 'POST' && parsedUrl.pathname === '/api/auth/login') {
    collectRequestBody(req, (error, body) => {
      if (error) {
        sendJson(res, 413, { error: error.message });
        return;
      }
      try {
        const payload = JSON.parse(body || '{}');
        const customer = db.verifyCustomerCredentials(payload.email, payload.password);
        if (!customer) {
          sendJson(res, 401, { error: 'Invalid email or password.' });
          return;
        }
        const session = db.createSession(customer.id);
        sendJson(res, 200, {
          success: true,
          token: session.token,
          expiresAt: session.expiresAt,
          customer
        });
      } catch (err) {
        console.error('Login failed:', err);
        sendJson(res, 500, { error: err.message || 'Unable to log in.' });
      }
    });
    return;
  }

  // Kiosk/customer magic-code login (email delivery for now)
  if (
    req.method === 'POST' &&
    (parsedUrl.pathname === '/api/auth/login-code/request' || parsedUrl.pathname === '/api/auth/request-login-code')
  ) {
    collectRequestBody(req, async (error, body) => {
      if (error) { sendJson(res, 413, { error: error.message }); return; }
      try {
        const payload = JSON.parse(body || '{}');
        const email = (payload.email || '').trim();
        if (!email) { sendJson(res, 400, { error: 'Email is required.' }); return; }
        // Ensure customer exists or upsert minimal profile
        let customer = db.findCustomerByEmail(email);
        if (!customer) {
          customer = db.upsertCustomerContact({
            name: (payload.name || '').trim(),
            email,
            phone: (payload.phone || '').trim(),
            address: (payload.address || '').trim()
          });
        }
        const { code, expiresAt } = db.createLoginCode(customer.id, 30);
        // Email the code
        try {
          await sendAccountEmail({
            to: email,
            subject: 'Your verification code',
            text: `Your login code is ${code}. It expires in 30 minutes.`,
            html: `<p>Your login code is <strong>${code}</strong>.</p><p>This code expires in 30 minutes.</p>`
          });
        } catch (mailErr) {
          console.error('Unable to send login code email:', mailErr);
        }
        // Return code for kiosk usage so we can render a QR immediately.
        // Email still gets sent above.
        sendJson(res, 200, { success: true, code, expiresAt });
      } catch (err) {
        console.error('Login code request failed:', err);
        sendJson(res, 500, { error: err.message || 'Unable to request code.' });
      }
    });
    return;
  }

  if (
    req.method === 'POST' &&
    (parsedUrl.pathname === '/api/auth/login-code/verify' || parsedUrl.pathname === '/api/auth/verify-login-code')
  ) {
    collectRequestBody(req, (error, body) => {
      if (error) { sendJson(res, 413, { error: error.message }); return; }
      try {
        const payload = JSON.parse(body || '{}');
        const email = (payload.email || '').trim();
        const code = (payload.code || '').trim();
        if (!email || !code) { sendJson(res, 400, { error: 'Email and code are required.' }); return; }
        const customer = db.findCustomerByEmail(email);
        if (!customer) { sendJson(res, 404, { error: 'Account not found.' }); return; }
        const entry = db.consumeLoginCode(customer.id, code);
        if (!entry) { sendJson(res, 400, { error: 'Invalid or expired code.' }); return; }
        const session = db.createSession(customer.id);
        sendJson(res, 200, { success: true, token: session.token, expiresAt: session.expiresAt, customer });
      } catch (err) {
        console.error('Login code verify failed:', err);
        sendJson(res, 500, { error: err.message || 'Unable to verify code.' });
      }
    });
    return;
  }

  if (req.method === 'GET' && parsedUrl.pathname === '/api/admin/specials') {
    const data = buildSpecialsResponse({ includeMissing: true });
    sendJson(res, 200, { success: true, ...data });
    return;
  }

  if (req.method === 'PUT' && parsedUrl.pathname === '/api/admin/specials') {
    collectRequestBody(req, (error, body) => {
      if (error) {
        sendJson(res, 413, { error: error.message });
        return;
      }
      try {
        const payload = body ? JSON.parse(body || '{}') : {};
        const normalized = normalizeSpecialsPayload(payload);
        const saved = writeSpecialsFile(normalized);
        const catalog = loadCatalogSnapshot();
        const resolved = normalized.map((entry) => resolveSpecialEntry(entry, catalog));
        sendJson(res, 200, {
          success: true,
          updatedAt: saved.updatedAt,
          items: resolved
        });
      } catch (err) {
        console.error('Unable to update specials:', err);
        const status = err.statusCode && Number.isInteger(err.statusCode) ? err.statusCode : 500;
        const message =
          status >= 500 && !err.expose ? 'Unable to update specials.' : err.message || 'Update failed.';
        sendJson(res, status, { error: message });
      }
    });
    return;
  }

  if (req.method === 'GET' && parsedUrl.pathname === '/api/public/specials') {
    const data = buildSpecialsResponse({ includeMissing: false });
    sendJson(res, 200, { success: true, ...data });
    return;
  }

  if (req.method === 'POST' && parsedUrl.pathname === '/api/admin/artwork') {
    handleArtworkUpload(req, res);
    return;
  }

  // =====================================================
  // Shopify Product Sync - Fix all existing products
  // =====================================================
  if (req.method === 'POST' && parsedUrl.pathname === '/api/admin/shopify/sync-all-products') {
    if (!requireInternalKey(req, res)) return;

    // Use SSE to stream progress
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    const sendSSE = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    (async () => {
      try {
        sendSSE('status', { message: 'Starting Shopify product sync...' });

        if (!shopify.isConfigured()) {
          sendSSE('error', { message: 'Shopify not configured' });
          res.end();
          return;
        }

        // Get default inventory value from body or use 999
        let defaultInventory = 999;
        try {
          const bodyRaw = await new Promise((resolve, reject) => {
            let data = '';
            req.on('data', chunk => data += chunk);
            req.on('end', () => resolve(data));
            req.on('error', reject);
          });
          if (bodyRaw) {
            const parsed = JSON.parse(bodyRaw);
            if (parsed.defaultInventory) defaultInventory = Number(parsed.defaultInventory) || 999;
          }
        } catch (_) {}

        // Get the first location for inventory
        let locationId = null;
        try {
          const locations = await shopify.listLocations();
          if (locations.length > 0) {
            locationId = locations[0].id;
            sendSSE('status', { message: `Using location: ${locations[0].name} (ID: ${locationId})` });
          }
        } catch (e) {
          sendSSE('warning', { message: 'Could not get locations for inventory sync' });
        }

        // Patterns to clean from titles (AI residue)
        const aiPatterns = [
          /\s*[-–—]\s*(Vinyl\s+)?Decal\s*$/i,
          /\s*[-–—]\s*Premium\s+Quality\s*$/i,
          /\s*[-–—]\s*High\s+Quality\s*$/i,
          /\s*[-–—]\s*Die[\s-]?Cut\s*$/i,
          /\s*[-–—]\s*Sticker\s*$/i,
          /\s*\|\s*.*$/,  // Everything after a pipe
          /\s*–\s*Custom\s+Made\s*$/i,
          /\s*-\s*Made\s+in\s+USA\s*$/i,
          /^\s*NEW!\s*/i,
          /^\s*HOT!\s*/i,
          /^\s*SALE!\s*/i,
          /\s+vinyl\s+decal\s+sticker\s*$/i,
          /\s+car\s+window\s+decal\s*$/i,
          /\s+bumper\s+sticker\s*$/i
        ];

        const cleanTitle = (title) => {
          let cleaned = title || '';
          for (const pattern of aiPatterns) {
            cleaned = cleaned.replace(pattern, '');
          }
          // Trim and clean up extra spaces
          cleaned = cleaned.replace(/\s+/g, ' ').trim();
          return cleaned;
        };

        // Template suffix mapping based on product type or tags
        const getTemplateSuffix = (product) => {
          const tags = (product.tags || '').toLowerCase();
          const productType = (product.product_type || '').toLowerCase();
          const title = (product.title || '').toLowerCase();

          if (tags.includes('custom-art') || tags.includes('custom art') ||
              productType.includes('custom art') || productType.includes('wall art')) {
            return 'custom-art';
          }
          if (tags.includes('tiled-art') || tags.includes('tiled art') ||
              productType.includes('tiled art') || title.includes('tiled')) {
            return 'tiled-art';
          }
          // Sticker packs use a simple sticker template (no color/size options)
          if (productType === 'sticker-pack' || tags.includes('sticker-pack')) {
            return 'sticker';
          }
          // Decal/sticker products use the decal template with vinyl color selector
          if (productType === 'sticker' || productType === 'decal' ||
              tags.includes('decal') || tags.includes('sticker') ||
              tags.includes('vinyl')) {
            return 'decal';
          }
          // Default: no suffix (uses default product template)
          return '';
        };

        // Fetch all products using pagination
        let allProducts = [];
        let lastId = null;
        let page = 0;

        sendSSE('status', { message: 'Fetching all products from Shopify...' });

        do {
          page++;
          const result = await shopify.listProducts({ limit: 250, since_id: lastId });
          if (result.products && result.products.length > 0) {
            allProducts = allProducts.concat(result.products);
            lastId = result.lastId;
            sendSSE('progress', { message: `Fetched ${allProducts.length} products (page ${page})...` });
          } else {
            lastId = null;
          }
        } while (lastId);

        sendSSE('status', { message: `Found ${allProducts.length} products to sync` });

        // Process each product
        let processed = 0;
        let updated = 0;
        let errors = 0;

        for (const product of allProducts) {
          processed++;
          const productLog = { id: product.id, title: product.title };

          try {
            const updates = {};
            const actions = [];

            // 1. Clean title
            const cleanedTitle = cleanTitle(product.title);
            if (cleanedTitle !== product.title) {
              updates.title = cleanedTitle;
              actions.push(`Title cleaned: "${product.title}" → "${cleanedTitle}"`);
            }

            // 2. Set vendor
            if (product.vendor !== 'Blue Ridge Custom Co') {
              updates.vendor = 'Blue Ridge Custom Co';
              actions.push(`Vendor: "${product.vendor}" → "Blue Ridge Custom Co"`);
            }

            // 3. Set template suffix
            const templateSuffix = getTemplateSuffix(product);
            if ((product.template_suffix || '') !== templateSuffix) {
              updates.template_suffix = templateSuffix;
              if (templateSuffix) {
                actions.push(`Template: "${product.template_suffix || 'default'}" → "${templateSuffix}"`);
              }
            }

            // 4. Apply updates if any
            if (Object.keys(updates).length > 0) {
              await shopify.updateProduct(product.id, updates);
              updated++;
            }

            // 5. Publish to all channels
            try {
              await shopify.publishEverywhere(product.id);
              actions.push('Published to all channels');
            } catch (pubErr) {
              actions.push(`Publish warning: ${pubErr.message}`);
            }

            // 6. Fix inventory for all variants
            if (locationId && product.variants && product.variants.length > 0) {
              for (const variant of product.variants) {
                if (variant.inventory_item_id) {
                  try {
                    // Ensure inventory tracking is enabled
                    if (variant.inventory_management !== 'shopify') {
                      await shopify.updateVariantInventoryManagement(variant.id, 'shopify');
                    }
                    // Set inventory level
                    await shopify.setInventoryLevel(variant.inventory_item_id, locationId, defaultInventory);
                  } catch (invErr) {
                    // Try to connect first, then set
                    try {
                      await shopify.connectInventoryItemToLocation(variant.inventory_item_id, locationId);
                      await shopify.setInventoryLevel(variant.inventory_item_id, locationId, defaultInventory);
                    } catch (_) {}
                  }
                }
              }
              actions.push(`Inventory set to ${defaultInventory} for ${product.variants.length} variant(s)`);
            }

            sendSSE('product', {
              index: processed,
              total: allProducts.length,
              id: product.id,
              title: cleanedTitle || product.title,
              actions: actions.length > 0 ? actions : ['No changes needed']
            });

          } catch (err) {
            errors++;
            sendSSE('product-error', {
              index: processed,
              total: allProducts.length,
              id: product.id,
              title: product.title,
              error: err.message
            });
          }

          // Small delay to avoid rate limiting
          await new Promise(r => setTimeout(r, 100));
        }

        sendSSE('complete', {
          total: allProducts.length,
          updated,
          errors,
          message: `Sync complete! ${updated} products updated, ${errors} errors`
        });

      } catch (err) {
        sendSSE('error', { message: err.message || 'Sync failed' });
      }

      res.end();
    })();

    return;
  }

  // AI Metadata Generation for Catalog (Server-Sent Events)
  if (req.method === 'POST' && parsedUrl.pathname === '/api/admin/catalog/generate-metadata') {
    if (!requireInternalKey(req, res)) return;
    collectRequestBody(req, async (error, body) => {
      if (error) {
        sendJson(res, 413, { error: error.message });
        return;
      }

      try {
        const payload = JSON.parse(body || '{}');
        const categorySlug = payload.categorySlug;

        if (!categorySlug) {
          sendJson(res, 400, { error: 'categorySlug is required.' });
          return;
        }

        // Set up Server-Sent Events
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*'
        });

        // Helper to send SSE event
        const sendEvent = (data) => {
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        // Send start event
        sendEvent({ type: 'start', categorySlug });

        // Generate metadata with progress callbacks
        await generateCategoryMetadata(categorySlug, {
          catalogPath: path.join(WEB_DIR, 'catalog.json'),
          onProgress: (progress) => {
            sendEvent({ type: 'progress', ...progress });
          },
          onComplete: async (summary) => {
            // Update catalog.json with generated metadata
            try {
              const catalogJsonPath = path.join(WEB_DIR, 'catalog.json');
              await updateCatalogMetadata(categorySlug, summary.results, catalogJsonPath);
              console.log(`Updated catalog.json with ${summary.processed} metadata entries for ${categorySlug}`);
            } catch (updateError) {
              console.error('Failed to update catalog.json:', updateError);
            }
            sendEvent({ type: 'complete', ...summary });
            res.end();
          },
          onError: (error) => {
            sendEvent({ type: 'error', error: error.message || 'Generation failed' });
            res.end();
          }
        });
      } catch (err) {
        console.error('Metadata generation error:', err);
        if (!res.headersSent) {
          sendJson(res, 500, { error: err.message || 'Failed to generate metadata.' });
        } else {
          res.write(`data: ${JSON.stringify({ type: 'error', error: err.message || 'Generation failed' })}\n\n`);
          res.end();
        }
      }
    });
    return;
  }

  // OCR Text Extraction for Catalog Items (Server-Sent Events)
  if (req.method === 'POST' && parsedUrl.pathname === '/api/admin/catalog/ocr-extract') {
    if (!requireInternalKey(req, res)) return;
    collectRequestBody(req, async (error, body) => {
      if (error) {
        sendJson(res, 413, { error: error.message });
        return;
      }

      try {
        const payload = JSON.parse(body || '{}');
        const categorySlug = payload.categorySlug;
        const minConfidence = payload.minConfidence || 30;

        if (!categorySlug) {
          sendJson(res, 400, { error: 'categorySlug is required.' });
          return;
        }

        // Verify category exists
        const categoryDir = findCategoryDirectory(categorySlug);
        if (!categoryDir) {
          sendJson(res, 404, { error: `Category not found: ${categorySlug}` });
          return;
        }

        // Set up Server-Sent Events
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*'
        });

        const sendEvent = (data) => {
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        sendEvent({ type: 'start', categorySlug, categoryDir });

        await runCategoryOcr(categorySlug, {
          minConfidence,
          onProgress: (progress) => {
            sendEvent({ type: 'progress', ...progress });
          },
          onComplete: async (summary) => {
            // Optionally update catalog.json with OCR results
            try {
              const catalogJsonPath = path.join(WEB_DIR, 'catalog.json');
              const updated = await updateCatalogWithOcr(categorySlug, summary.results, catalogJsonPath);
              console.log(`[OCR] Updated catalog.json with ${updated} OCR entries for ${categorySlug}`);
              summary.catalogUpdated = updated;
            } catch (updateError) {
              console.error('[OCR] Failed to update catalog.json:', updateError);
              summary.catalogUpdateError = updateError.message;
            }
            sendEvent({ type: 'complete', ...summary });
            res.end();
          },
          onError: (error) => {
            sendEvent({ type: 'error', error: error.message || 'OCR extraction failed' });
            res.end();
          }
        });
      } catch (err) {
        console.error('[OCR] Extraction error:', err);
        if (!res.headersSent) {
          sendJson(res, 500, { error: err.message || 'Failed to run OCR extraction.' });
        } else {
          res.write(`data: ${JSON.stringify({ type: 'error', error: err.message || 'OCR extraction failed' })}\n\n`);
          res.end();
        }
      }
    });
    return;
  }

  // Get available categories for OCR
  if (req.method === 'GET' && parsedUrl.pathname === '/api/admin/catalog/categories') {
    if (!requireInternalKey(req, res)) return;
    try {
      const entries = fs.readdirSync(LIBRARY_ROOT, { withFileTypes: true });
      const categories = entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => ({
          name: e.name,
          slug: e.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      sendJson(res, 200, { categories });
    } catch (err) {
      console.error('[OCR] Error listing categories:', err);
      sendJson(res, 500, { error: err.message || 'Failed to list categories.' });
    }
    return;
  }

  // Get items in a category for local OCR processing
  if (req.method === 'GET' && parsedUrl.pathname === '/api/admin/catalog/ocr-items') {
    if (!requireInternalKey(req, res)) return;
    try {
      const query = parsedUrl.query || {};
      const categorySlug = query.categorySlug;
      if (!categorySlug) {
        sendJson(res, 400, { error: 'categorySlug is required' });
        return;
      }

      const items = getOcrCategoryItems(categorySlug);
      sendJson(res, 200, { items });
    } catch (err) {
      console.error('[OCR] Error getting category items:', err);
      sendJson(res, 500, { error: err.message || 'Failed to get category items.' });
    }
    return;
  }

  // Save OCR results from local processing
  if (req.method === 'POST' && parsedUrl.pathname === '/api/admin/catalog/ocr-results') {
    if (!requireInternalKey(req, res)) return;
    collectRequestBody(req, async (error, body) => {
      if (error) {
        sendJson(res, 413, { error: error.message });
        return;
      }

      try {
        const payload = JSON.parse(body || '{}');
        const { categorySlug, results } = payload;

        if (!categorySlug || !results) {
          sendJson(res, 400, { error: 'categorySlug and results are required' });
          return;
        }

        // Save results to a JSON file in the data directory
        const ocrDataDir = path.join(DATA_DIR, 'ocr-results');
        fs.mkdirSync(ocrDataDir, { recursive: true });

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `${categorySlug}-${timestamp}.json`;
        const filepath = path.join(ocrDataDir, filename);

        const successResults = results.filter(r => r.status === 'success');
        fs.writeFileSync(filepath, JSON.stringify({
          categorySlug,
          timestamp: new Date().toISOString(),
          totalProcessed: results.length,
          successCount: successResults.length,
          results: successResults
        }, null, 2));

        console.log(`[OCR] Saved ${successResults.length} OCR results for ${categorySlug} to ${filename}`);

        // Also try to update catalog.json if it exists
        try {
          await updateCatalogWithOcr(categorySlug, results, path.join(WEB_DIR, 'catalog.json'));
        } catch (catalogErr) {
          console.warn('[OCR] Could not update catalog.json:', catalogErr.message);
        }

        sendJson(res, 200, { success: true, saved: successResults.length, file: filename });
      } catch (err) {
        console.error('[OCR] Error saving results:', err);
        sendJson(res, 500, { error: err.message || 'Failed to save OCR results.' });
      }
    });
    return;
  }

  if (req.method === 'POST' && parsedUrl.pathname === '/api/auth/refresh') {
    collectRequestBody(req, (error, body) => {
      if (error) {
        sendJson(res, 413, { error: error.message });
        return;
      }
      try {
        const payload = JSON.parse(body || '{}');
        const rememberToken = payload.rememberToken;
        if (!rememberToken) {
          sendJson(res, 400, { error: 'rememberToken is required.' });
          return;
        }
        const customer = db.findCustomerByRememberToken(rememberToken);
        if (!customer) {
          sendJson(res, 401, { error: 'Session expired. Please sign in again.' });
          return;
        }
        const session = db.createSession(customer.id);
        sendJson(res, 200, {
          success: true,
          token: session.token,
          expiresAt: session.expiresAt,
          customer
        });
      } catch (err) {
        console.error('Refresh session failed:', err);
        sendJson(res, 500, { error: err.message || 'Unable to refresh session.' });
      }
    });
    return;
  }

  if (req.method === 'POST' && parsedUrl.pathname === '/api/auth/logout') {
    const token = extractToken(req);
    collectRequestBody(req, (error, body) => {
      if (token) {
        db.deleteSession(token);
      }
      try {
        const payload = body ? JSON.parse(body || '{}') : {};
        if (payload.rememberToken) {
          const customer = db.findCustomerByRememberToken(payload.rememberToken);
          if (customer) {
            db.regenerateRememberToken(customer.id);
          }
        }
      } catch (err) {
        console.warn('Failed to parse logout body:', err);
      }
      sendJson(res, 200, { success: true });
    });
    return;
  }

  if (req.method === 'POST' && parsedUrl.pathname === '/api/auth/request-email-confirmation') {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const verification = db.createEmailToken(auth.id, 'verify', 48);
    const link = makeCustomerLink('verify', verification.token);
    logEmailPreview('verify-account', link);
    const customer = db.findCustomerById(auth.id);
    if (customer) {
      sendVerificationEmail(customer, link).catch((err) =>
        console.error('Deferred verification email error:', err)
      );
    }
    sendJson(res, 200, {
      success: true,
      previewUrl: link,
      token: verification.token
    });
    return;
  }

  if (req.method === 'POST' && parsedUrl.pathname === '/api/auth/confirm-email') {
    collectRequestBody(req, (error, body) => {
      if (error) {
        sendJson(res, 413, { error: error.message });
        return;
      }
      try {
        const payload = JSON.parse(body || '{}');
        if (!payload.token) {
          sendJson(res, 400, { error: 'Token is required.' });
          return;
        }
        const entry = db.consumeEmailToken(payload.token, 'verify');
        if (!entry) {
          sendJson(res, 400, { error: 'Invalid or expired token.' });
          return;
        }
        db.markEmailVerified(entry.customer_id);
        const customer = db.findCustomerById(entry.customer_id);
        const session = db.createSession(customer.id);
        sendJson(res, 200, {
          success: true,
          customer,
          token: session.token,
          expiresAt: session.expiresAt
        });
      } catch (err) {
        console.error('Confirm email failed:', err);
        sendJson(res, 500, { error: err.message || 'Unable to confirm email.' });
      }
    });
    return;
  }

  if (req.method === 'POST' && parsedUrl.pathname === '/api/auth/request-password-reset') {
    collectRequestBody(req, (error, body) => {
      if (error) {
        sendJson(res, 413, { error: error.message });
        return;
      }
      try {
        const payload = JSON.parse(body || '{}');
        const email = db.normalizeEmail(payload.email);
        if (!email) {
          sendJson(res, 400, { error: 'Email is required.' });
          return;
        }
        const customer = db.findCustomerByEmail(email);
        if (!customer) {
          sendJson(res, 200, { success: true });
          return;
        }
        const reset = db.createEmailToken(customer.id, 'reset', 2);
        const link = makeCustomerLink('resetToken', reset.token);
        logEmailPreview('password-reset', link);
        sendPasswordResetEmail(customer, link).catch((err) =>
          console.error('Deferred password reset email error:', err)
        );
        sendJson(res, 200, { success: true, previewUrl: link, token: reset.token });
      } catch (err) {
        console.error('Password reset request failed:', err);
        sendJson(res, 500, { error: err.message || 'Unable to create reset request.' });
      }
    });
    return;
  }

  if (req.method === 'POST' && parsedUrl.pathname === '/api/auth/reset-password') {
    collectRequestBody(req, (error, body) => {
      if (error) {
        sendJson(res, 413, { error: error.message });
        return;
      }
      try {
        const payload = JSON.parse(body || '{}');
        if (!payload.token || !payload.password) {
          sendJson(res, 400, { error: 'Token and new password are required.' });
          return;
        }
        const entry = db.consumeEmailToken(payload.token, 'reset');
        if (!entry) {
          sendJson(res, 400, { error: 'Invalid or expired token.' });
          return;
        }
        db.updateCustomerPassword(entry.customer_id, payload.password);
        const customer = db.findCustomerById(entry.customer_id);
        const session = db.createSession(customer.id);
        sendJson(res, 200, {
          success: true,
          token: session.token,
          expiresAt: session.expiresAt,
          customer
        });
      } catch (err) {
        console.error('Password reset failed:', err);
        sendJson(res, 500, { error: err.message || 'Unable to reset password.' });
      }
    });
    return;
  }

  if (req.method === 'POST' && parsedUrl.pathname === '/api/save-design') {
    collectRequestBody(req, (error, body) => {
      if (error) {
        sendJson(res, 413, { error: error.message });
        return;
      }
      try {
        const payload = JSON.parse(body || '{}');
        // Associate with authenticated customer if token provided
        const authHeader = req.headers.authorization || '';
        const token = authHeader.startsWith('Bearer ')
          ? authHeader.slice(7).trim()
          : null;
        const authProfile = resolveCustomerProfile(token);
        if (authProfile) {
          payload.customer = payload.customer || {};
          payload.customer.name = payload.customer.name || authProfile.name;
          payload.customer.email = payload.customer.email || authProfile.email;
          payload.customer.phone = payload.customer.phone || authProfile.phone;
          payload.customer.address = payload.customer.address || authProfile.address;
          payload._authCustomerId = authProfile.id;
        }
        // Attach campaign from cookie if present
        try {
          const cookies = parseCookies(req);
          const cSlug = cookies['scv_campaign'] || cookies['campaign'] || '';
          if (cSlug) {
            payload.metadata = payload.metadata || {};
            if (!payload.metadata.campaign) payload.metadata.campaign = cSlug;
          }
        } catch (_) {}
        if (!payload.imageData) {
          sendJson(res, 400, { error: 'Missing imageData.' });
          return;
        }
        const result = persistDesign(payload);
        // Optional: create a session for the provided customer email (kiosk QR login)
        let sessionToken = null;
        try {
          const email = (payload.customer?.email || '').trim();
          if (email) {
            const cust = db.findCustomerByEmail(email);
            if (cust) {
              const session = db.createSession(cust.id);
              sessionToken = session?.token || null;
            }
          }
        } catch (_) {}
        const bodyOut = sessionToken ? { success: true, sessionToken, ...result } : { success: true, ...result };
        sendJson(res, 201, bodyOut);
      } catch (err) {
        console.error('Failed to save design:', err);
        sendJson(res, 500, { error: err.message || 'Unknown error.' });
      }
    });
    return;
  }

  if (req.method === 'GET' && parsedUrl.pathname === '/api/orders') {
    try {
      const orders = db.fetchOrders().map(toApiOrder);
      sendJson(res, 200, { orders });
    } catch (error) {
      console.error('Unable to list orders:', error);
      sendJson(res, 500, { error: 'Unable to list orders.' });
    }
    return;
  }

  // Internal sales reports (requires INTERNAL_API_KEY)
  if (
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'reports' &&
    segments[3] === 'sales'
  ) {
    if (!requireInternalKey(req, res)) return;
    const q = parsedUrl.query || {};
    const includeUnpaid = String(q.includeUnpaid || '').trim() === '1';
    const from = q.from ? new Date(String(q.from)) : null;
    const to = q.to ? new Date(String(q.to)) : null;
    const inRange = (ts) => {
      const t = Number(new Date(ts));
      if (!Number.isFinite(t)) return false;
      if (from && t < from.getTime()) return false;
      if (to && t > to.getTime()) return false;
      return true;
    };
    function listOrdersForReports() {
      const all = db.fetchOrders();
      return all.filter((o) => inRange(o.savedAt) && (includeUnpaid || o.paid || String(o.paymentStatus || '').toUpperCase() === 'PAID'));
    }
    try {
      if (req.method === 'GET' && segments[4] === 'summary') {
        const orders = listOrdersForReports();
        const count = orders.length;
        const paidCount = orders.filter((o) => o.paid || String(o.paymentStatus || '').toUpperCase() === 'PAID').length;
        const revenue = orders.reduce((sum, o) => sum + (Number(o.pricing?.totalCents) || 0), 0);
        const avg = count ? Math.round(revenue / count) : 0;
        sendJson(res, 200, { success: true, count, paidCount, revenueCents: revenue, averageOrderCents: avg });
        return;
      }
      if (req.method === 'GET' && segments[4] === 'by-day') {
        const orders = listOrdersForReports();
        const map = new Map();
        orders.forEach((o) => {
          const d = new Date(o.savedAt);
          const key = isNaN(d) ? 'unknown' : d.toISOString().slice(0, 10);
          const m = map.get(key) || { date: key, orders: 0, revenueCents: 0 };
          m.orders += 1;
          m.revenueCents += Number(o.pricing?.totalCents) || 0;
          map.set(key, m);
        });
        const items = Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
        sendJson(res, 200, { success: true, items });
        return;
      }
      if (req.method === 'GET' && segments[4] === 'by-category') {
        const orders = listOrdersForReports();
        const map = new Map();
        orders.forEach((o) => {
          const key = (o.category || 'Uncategorized').trim();
          const m = map.get(key) || { category: key, orders: 0, revenueCents: 0 };
          m.orders += 1;
          m.revenueCents += Number(o.pricing?.totalCents) || 0;
          map.set(key, m);
        });
        const items = Array.from(map.values()).sort((a, b) => b.revenueCents - a.revenueCents);
        sendJson(res, 200, { success: true, items });
        return;
      }
      if (req.method === 'GET' && segments[4] === 'by-color') {
        const orders = listOrdersForReports();
        const map = new Map();
        orders.forEach((o) => {
          const key = (o.color || '—').toUpperCase();
          const m = map.get(key) || { color: key, count: 0, revenueCents: 0 };
          m.count += 1;
          m.revenueCents += Number(o.pricing?.totalCents) || 0;
          map.set(key, m);
        });
        const items = Array.from(map.values()).sort((a, b) => b.count - a.count);
        sendJson(res, 200, { success: true, items });
        return;
      }
      if (req.method === 'GET' && segments[4] === 'by-campaign') {
        const orders = listOrdersForReports();
        const map = new Map();
        orders.forEach((o) => {
          const key = (o.campaign || '—');
          const m = map.get(key) || { campaign: key, orders: 0, revenueCents: 0 };
          m.orders += 1;
          m.revenueCents += Number(o.pricing?.totalCents) || 0;
          map.set(key, m);
        });
        const items = Array.from(map.values()).sort((a, b) => b.revenueCents - a.revenueCents);
        sendJson(res, 200, { success: true, items });
        return;
      }
      if (req.method === 'GET' && segments[4] === 'top-designs') {
        const orders = listOrdersForReports();
        const map = new Map();
        orders.forEach((o) => {
          const key = (o.designName || o.designId || 'Design').trim();
          const m = map.get(key) || { name: key, orders: 0, revenueCents: 0 };
          m.orders += 1;
          m.revenueCents += Number(o.pricing?.totalCents) || 0;
          map.set(key, m);
        });
        const items = Array.from(map.values()).sort((a, b) => b.orders - a.orders).slice(0, 50);
        sendJson(res, 200, { success: true, items });
        return;
      }
      sendJson(res, 404, { error: 'Unknown report.' });
    } catch (error) {
      console.error('Sales report error:', error);
      sendJson(res, 500, { error: error.message || 'Unable to build report.' });
    }
    return;
  }

  // Internal campaign performance (requires INTERNAL_API_KEY)
  if (
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'reports' &&
    segments[3] === 'campaigns'
  ) {
    if (!requireInternalKey(req, res)) return;
    const q = parsedUrl.query || {};
    const from = q.from ? new Date(String(q.from)) : null;
    const to = q.to ? new Date(String(q.to)) : null;
    const inRange = (ts) => {
      const t = Number(new Date(ts));
      if (!Number.isFinite(t)) return false;
      if (from && t < from.getTime()) return false;
      if (to && t > to.getTime()) return false;
      return true;
    };
    try {
      const orders = db.fetchOrders().filter((o) => inRange(o.savedAt));
      const orderAgg = new Map();
      orders.forEach((o) => {
        const key = (o.campaign || '—');
        const rec = orderAgg.get(key) || { campaign: key, orders: 0, revenueCents: 0 };
        rec.orders += 1;
        rec.revenueCents += Number(o.pricing?.totalCents) || 0;
        orderAgg.set(key, rec);
      });
      // Merge with metrics files
      const campaigns = listCampaigns();
      const items = [];
      const seen = new Set();
      campaigns.forEach((c) => {
        const slug = c.slug;
        const file = path.join(ensureCampaignsDir(), `${slug}-metrics.json`);
        let metrics = { impressions: 0, clicks: 0, last: null };
        try { metrics = { ...metrics, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (_) {}
        const sales = orderAgg.get(slug) || { orders: 0, revenueCents: 0 };
        items.push({ slug, title: c.title || slug, impressions: metrics.impressions || 0, clicks: metrics.clicks || 0, last: metrics.last || null, orders: sales.orders, revenueCents: sales.revenueCents });
        seen.add(slug);
      });
      // Add unattributed bucket if any orders
      if (orderAgg.has('—')) {
        const sales = orderAgg.get('—');
        items.push({ slug: '—', title: 'Unattributed', impressions: 0, clicks: 0, last: null, orders: sales.orders, revenueCents: sales.revenueCents });
      }
      items.sort((a, b) => b.revenueCents - a.revenueCents);
      sendJson(res, 200, { success: true, items });
    } catch (error) {
      console.error('Campaign report error:', error);
      sendJson(res, 500, { error: error.message || 'Unable to build campaign report.' });
    }
    return;
  }

  // Internal vendor orders (local DB)
  if (
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'vendor-orders'
  ) {
    // Top items aggregation
    if (req.method === 'GET' && segments[3] === 'top') {
      try {
        const vendor = String(parsedUrl.query.vendor || '').trim();
        const limit = Math.max(1, Math.min(Number(parsedUrl.query.limit || 20), 200));
        const from = String(parsedUrl.query.from || '').trim();
        const to = String(parsedUrl.query.to || '').trim();
        let base = db.listVendorOrders({ vendor: vendor || '', status: 'approved_sent', limit: 2000, offset: 0 });
        // Date filter on updatedAt if provided
        if (from || to) {
          const fromTs = from ? Number(new Date(from)) : null;
          // Include entire 'to' day if date only
          let toTs = to ? Number(new Date(to)) : null;
          if (to && to.length === 10) {
            const end = new Date(`${to}T23:59:59`);
            toTs = Number(end);
          }
          base = base.filter((row) => {
            const ts = Number(new Date(row.updatedAt || row.createdAt || 0));
            if (!Number.isFinite(ts)) return false;
            if (fromTs && ts < fromTs) return false;
            if (toTs && ts > toTs) return false;
            return true;
          });
        }
        const counts = new Map();
        base.forEach((row) => {
          const detailed = db.getVendorOrderById(row.id);
          const raw = detailed?.raw || null;
          const lines = Array.isArray(raw?.Lines) ? raw.Lines : [];
          lines.forEach((ln) => {
            const sku = String(ln?.Identifier || ln?.SKU || ln?.Sku || '').trim();
            const qty = Math.max(0, Number(ln?.Qty || ln?.Quantity || 0));
            if (sku && qty > 0) {
              counts.set(sku, (counts.get(sku) || 0) + qty);
            }
          });
        });
        const items = Array.from(counts.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, limit)
          .map(([sku, qty]) => ({ sku, quantity: qty }));
        sendJson(res, 200, { success: true, items });
      } catch (error) {
        console.error('Unable to aggregate top vendor items:', error);
        sendJson(res, 500, { error: 'Unable to aggregate top vendor items.' });
      }
      return;
    }
    // Create a local pending vendor order
    if (req.method === 'POST' && !segments[3]) {
      collectRequestBody(req, (error, body) => {
        if (error) {
          sendJson(res, 413, { error: error.message });
          return;
        }
        try {
          const payload = body ? JSON.parse(body) : {};
          const po = String(payload.poNumber || payload.CustomerPO || '').trim() || `INV-${Date.now()}`;
          const shippingMethod = String(payload.shippingMethod || payload.ShippingMethod || '').trim();
          const warehouses = Array.isArray(payload.warehouses)
            ? payload.warehouses.map((w) => String(w || '').trim()).filter(Boolean).join(', ')
            : String(payload.warehouses || '').trim();
          const requestPayload = {
            CustomerPO: po,
            ShippingMethod: shippingMethod || undefined,
            Lines: Array.isArray(payload.lines)
              ? payload.lines
                  .map((ln) => ({ Identifier: String(ln.sku || ln.Identifier || ''), Qty: Math.max(1, Number(ln.qty || ln.Qty || 0)) }))
                  .filter((ln) => ln.Identifier && ln.Qty > 0)
              : [],
            Warehouses: warehouses ? warehouses.split(/\s*,\s*/) : undefined,
            AllowSplit: payload.allowSplit !== undefined ? Boolean(payload.allowSplit) : false,
            Notes: payload.notes || ''
          };
          const id = db.createVendorOrderDraft({
            vendor: 'S&S Activewear',
            customerPO: po,
            shippingMethod,
            warehouses,
            request: requestPayload
          });
          sendJson(res, 201, { success: true, id });
        } catch (err) {
          sendJson(res, 400, { error: err?.message || 'Invalid payload.' });
        }
      });
      return;
    }
    // Approve & send to vendor
    if (req.method === 'POST' && segments[3] && segments[4] === 'approve') {
      const id = segments[3];
      try {
        const record = db.getVendorOrderById(id);
        if (!record) {
          sendJson(res, 404, { error: 'Vendor order not found.' });
          return;
        }
        const request = record.raw?.CustomerPO || record.request_payload
          ? (record.raw || JSON.parse(record.request_payload || '{}'))
          : JSON.parse(record.request_payload || '{}');
        const finalPayload = normalizeSsawOrderPayload(request || {});
        ssaw
          .createOrder(finalPayload)
          .then((vendorResp) => {
            try {
              const normalized = Array.isArray(vendorResp) ? (vendorResp[0] || {}) : (vendorResp || {});
              const vendorOrderId = String(normalized.OrderID || normalized.orderID || normalized.id || '').trim();
              const status = String(normalized.OrderStatus || normalized.status || 'approved_sent').trim() || 'approved_sent';
              const whSet = new Set();
              if (Array.isArray(finalPayload.Warehouses)) finalPayload.Warehouses.forEach((w) => whSet.add(String(w || '').trim()));
              const lines = Array.isArray(normalized.Lines) ? normalized.Lines : [];
              lines.forEach((ln) => ln?.WarehouseAbbr && whSet.add(String(ln.WarehouseAbbr)));
              const warehouses = Array.from(whSet).filter(Boolean).join(', ');
              const tracking = String(
                (normalized.TrackingNumber || (Array.isArray(normalized.TrackingNumbers) ? normalized.TrackingNumbers.join(', ') : ''))
              ).trim();
              db.updateVendorOrderRecord(id, {
                vendor_order_id: vendorOrderId || null,
                status: status || 'approved_sent',
                warehouses: warehouses || null,
                tracking: tracking || null,
                raw_payload: JSON.stringify(normalized)
              });
            } catch (e) {
              console.warn('Unable to persist approved vendor order:', e?.message || e);
            }
            sendJson(res, 200, { success: true });
          })
          .catch((err) => {
            try {
              db.updateVendorOrderRecord(id, {
                status: 'approval_failed',
                raw_payload: err?.body ? String(err.body) : String(err?.message || 'Unknown error')
              });
            } catch (e) {
              console.warn('Unable to save failed vendor order response:', e?.message || e);
            }
            sendJson(res, 502, { error: 'Vendor order failed.', details: err?.body || null });
          });
      } catch (error) {
        sendJson(res, 500, { error: error?.message || 'Approval failed.' });
      }
      return;
    }
    // Reject locally
    if (req.method === 'POST' && segments[3] && segments[4] === 'reject') {
      const id = segments[3];
      const ok = db.updateVendorOrderRecord(id, { status: 'rejected' });
      if (!ok) {
        sendJson(res, 404, { error: 'Vendor order not found.' });
        return;
      }
      const item = db.getVendorOrderById(id);
      sendJson(res, 200, { success: true, item });
      return;
    }
    if (req.method === 'GET') {
      const vendor = String(parsedUrl.query.vendor || '').trim();
      const po = String(parsedUrl.query.po || '').trim();
      const status = String(parsedUrl.query.status || '').trim();
      const limit = Number(parsedUrl.query.limit || 100);
      const offset = Number(parsedUrl.query.offset || 0);
      try {
        const items = db.listVendorOrders({ vendor, po, status, limit, offset });
        sendJson(res, 200, { success: true, items });
      } catch (error) {
        console.error('Unable to list vendor orders:', error);
        sendJson(res, 500, { error: 'Unable to list vendor orders.' });
      }
      return;
    }
    if (req.method === 'PATCH' && segments[3]) {
      collectRequestBody(req, (error, body) => {
        if (error) {
          sendJson(res, 413, { error: error.message });
          return;
        }
        try {
          const payload = body ? JSON.parse(body) : {};
          const updates = {};
          ['status', 'shipping_method', 'warehouses', 'tracking'].forEach((k) => {
            if (Object.prototype.hasOwnProperty.call(payload, k)) updates[k] = payload[k];
          });
          const ok = db.updateVendorOrderRecord(segments[3], updates);
          if (!ok) {
            sendJson(res, 404, { error: 'Vendor order not found or no changes.' });
            return;
          }
          const item = db.getVendorOrderById(segments[3]);
          sendJson(res, 200, { success: true, item });
        } catch (err) {
          sendJson(res, 400, { error: err?.message || 'Invalid payload.' });
        }
      });
      return;
    }
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }

  if (req.method === 'GET' && parsedUrl.pathname === '/api/admin/race-quotes') {
    try {
      const quotes = db.fetchAllRaceQuotes().map(toApiRaceQuote);
      sendJson(res, 200, { success: true, quotes });
    } catch (error) {
      console.error('Unable to list race quotes:', error);
      sendJson(res, 500, { error: 'Unable to list race quotes.' });
    }
    return;
  }

  if (
    req.method === 'PATCH' &&
    segments[0] === 'api' &&
    segments[1] === 'admin' &&
    segments[2] === 'race-quotes' &&
    segments[3]
  ) {
    collectRequestBody(req, (error, body) => {
      if (error) {
        sendJson(res, 413, { error: error.message });
        return;
      }
      try {
        const payload = body ? JSON.parse(body || '{}') : {};
        const updates = sanitizeRaceQuoteAdminUpdate(payload);
        const quote = db.updateRaceQuote(segments[3], updates);
        if (!quote) {
          sendJson(res, 404, { error: 'Quote not found.' });
          return;
        }
        sendJson(res, 200, { success: true, quote: toApiRaceQuote(quote) });
      } catch (err) {
        console.error('Unable to update race quote:', err);
        sendJson(res, 400, { error: err.message || 'Unable to update quote.' });
      }
    });
    return;
  }

  if (
    req.method === 'POST' &&
    segments[0] === 'api' &&
    segments[1] === 'admin' &&
    segments[2] === 'race-quotes' &&
    segments[3] &&
    segments[4] === 'payment-link'
  ) {
    try {
      const quote = db.getRaceQuoteById(segments[3]);
      if (!quote) {
        sendJson(res, 404, { error: 'Quote not found.' });
        return;
      }
      if (!Number.isFinite(quote.totalCents) || quote.totalCents <= 0) {
        sendJson(res, 400, { error: 'Set the quote total before generating a payment link.' });
        return;
      }
      if (!squareClient) {
        sendJson(res, 503, { error: 'Square payments are not configured yet.' });
        return;
      }
      createSquarePaymentLinkForRaceQuote(quote)
        .then(() => {
          const refreshed = db.getRaceQuoteById(quote.id);
          sendJson(res, 200, { success: true, quote: toApiRaceQuote(refreshed) });
        })
        .catch((error) => {
          console.error('Unable to create race quote payment link:', error);
          sendJson(res, 500, { error: error.message || 'Unable to create payment link.' });
        });
    } catch (error) {
      console.error('Race quote payment link error:', error);
      sendJson(res, 500, { error: error.message || 'Unable to create payment link.' });
    }
    return;
  }

  if (req.method === 'PATCH' && segments[0] === 'api' && segments[1] === 'orders' && segments[2]) {
    collectRequestBody(req, (error, body) => {
      if (error) {
        sendJson(res, 413, { error: error.message });
        return;
      }
      try {
        const updates = JSON.parse(body || '{}');
        db.updateOrder(segments[2], updates);
        const order = db.getOrderById(segments[2]);
        sendJson(res, 200, { success: true, order: order ? toApiOrder(order) : null });
      } catch (err) {
        console.error('Failed to update order:', err);
        sendJson(res, 500, { error: err.message || 'Unable to update order.' });
      }
    });
    return;
  }

  if (req.method === 'GET' && parsedUrl.pathname === '/api/customer/orders') {
    const auth = requireAuth(req, res);
    if (!auth) return;
    try {
      const orders = db.fetchOrdersByCustomer(auth.id).map(toApiOrder);
      sendJson(res, 200, { success: true, orders });
    } catch (error) {
      console.error('Unable to fetch customer orders:', error);
      sendJson(res, 500, { error: error.message || 'Unable to fetch orders.' });
    }
    return;
  }

  if (
    req.method === 'DELETE' &&
    segments[0] === 'api' &&
    segments[1] === 'customer' &&
    segments[2] === 'orders' &&
    segments[3]
  ) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    try {
      const orderId = segments[3];
      const order = db.getOrderById(orderId);
      if (!order || order.customerId !== auth.id) {
        sendJson(res, 404, { error: 'Order not found.' });
        return;
      }
      if (order.paid || String(order.paymentStatus || '').toUpperCase() === 'PAID') {
        sendJson(res, 400, { error: 'Paid orders cannot be deleted.' });
        return;
      }
      db.deleteOrder(orderId);
      sendJson(res, 200, { success: true });
    } catch (error) {
      console.error('Unable to delete order:', error);
      sendJson(res, 500, { error: error.message || 'Unable to delete order.' });
    }
    return;
  }

  if (
    req.method === 'POST' &&
    segments[0] === 'api' &&
    segments[1] === 'customer' &&
    segments[2] === 'orders' &&
    segments[3] === 'pay-all'
  ) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    try {
      const all = db.fetchOrdersByCustomer(auth.id);
      const unpaid = all.filter(
        (o) => !o.paid && String(o.paymentStatus || '').toUpperCase() !== 'PAID' && o.pricing && Number(o.pricing.totalCents) > 0
      );
      if (!unpaid.length) {
        sendJson(res, 400, { error: 'No unpaid orders with totals.' });
        return;
      }
      const customer = db.findCustomerById(auth.id) || { id: auth.id, email: auth.email };
      const link = await createSquarePaymentLinkForOrdersAggregate(customer, unpaid);
      if (!link?.url) {
        sendJson(res, 500, { error: 'Unable to create aggregated payment link.' });
        return;
      }
      sendJson(res, 200, { success: true, url: link.url });
    } catch (error) {
      console.error('Pay-all error:', error);
      const message = error?.message || 'Unable to create aggregated invoice.';
      const status = message.toLowerCase().includes('square integration not configured') ? 503 : 500;
      sendJson(res, status, { error: message });
    }
    return;
  }

  if (
    req.method === 'GET' &&
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'orders' &&
    segments[3] === 'queue'
  ) {
    if (!requireInternalKey(req, res)) return;
    try {
      const since = parsedUrl.query?.since;
      const orders = db.fetchOrdersForQueue({ since }).map(toApiOrder);
      sendJson(res, 200, { success: true, orders });
    } catch (error) {
      console.error('Unable to load queue:', error);
      sendJson(res, 500, { error: error.message || 'Unable to load queue.' });
    }
    return;
  }

  // Internal: fulfill Shopify POD line items and mark as shipped
  if (req.method === 'POST' && parsedUrl.pathname === '/internal/fulfill') {
    if (!requireInternalKey(req, res)) return;
    if (!shopify.isConfigured()) {
      sendJson(res, 503, { error: 'Shopify not configured.' });
      return;
    }
    collectRequestBody(req, async (error, body) => {
      if (error) {
        sendJson(res, 413, { error: error.message });
        return;
      }
      try {
        const payload = body ? JSON.parse(body || '{}') : {};
        const orderId = payload.shopify_order_id || payload.order_id || payload.orderId;
        const lineItemIdsRaw = payload.line_item_ids || payload.lineItemIds || [];
        const trackingNumber = payload.tracking_number || payload.trackingNumber || '';
        const trackingCompany = payload.tracking_company || payload.trackingCompany || '';
        const trackingUrl = payload.tracking_url || payload.trackingUrl || '';
        const notifyCustomer =
          payload.notify_customer !== undefined
            ? Boolean(payload.notify_customer)
            : true;

        const lineItemIds = Array.isArray(lineItemIdsRaw)
          ? Array.from(
              new Set(
                lineItemIdsRaw
                  .map((v) => String(v).trim())
                  .filter(Boolean)
              )
            )
          : [];

        if (!orderId || !lineItemIds.length) {
          sendJson(res, 400, {
            error: 'shopify_order_id and line_item_ids are required.'
          });
          return;
        }

        const lineItems = lineItemIds.map((id) => {
          const rec = db.getPodLineItemByShopifyId(id);
          const qty = rec && Number(rec.quantity || 0) > 0 ? Number(rec.quantity) : 1;
          return { id, quantity: qty };
        });

        if (!lineItems.length) {
          sendJson(res, 400, {
            error: 'No matching POD line items found for fulfillment.'
          });
          return;
        }

        const tracking = {
          tracking_number: trackingNumber,
          tracking_company: trackingCompany,
          tracking_url: trackingUrl
        };

        try {
          const fulfillment = await shopify.createFulfillment({
            orderId,
            // Let Shopify choose default location unless env is explicitly set
            locationId: process.env.SHOPIFY_LOCATION_ID || undefined,
            lineItems,
            tracking,
            notifyCustomer
          });

          try {
            db.markPodLineItemsShipped(lineItemIds);
          } catch (eDb) {
            console.error('Unable to mark POD line items shipped in DB:', eDb);
          }

          sendJson(res, 200, { success: true, fulfillment });
        } catch (err) {
          console.error('Shopify fulfillment error:', err?.status, err?.detail || err);
          const status =
            (err && Number(err.status)) && Number(err.status) >= 400 && Number(err.status) < 600
              ? Number(err.status)
              : 502;
          sendJson(res, status, {
            error: err?.message || 'Unable to create fulfillment.',
            detail: err?.detail || null
          });
        }
      } catch (e) {
        sendJson(res, 400, { error: e?.message || 'Invalid payload.' });
      }
    });
    return;
  }

  // Internal: send POD mockup approval email to customer
  if (req.method === 'POST' && parsedUrl.pathname === '/internal/pod/mockup-email') {
    if (!requireInternalKey(req, res)) return;
    collectRequestBody(req, async (error, body) => {
      if (error) {
        sendJson(res, 413, { error: error.message });
        return;
      }
      try {
        const payload = body ? JSON.parse(body || '{}') : {};
        const shopifyOrderId =
          payload.shopify_order_id || payload.order_id || payload.orderId;
        const lineItemId =
          payload.line_item_id || payload.lineItemId || null;
        const explicitTo = (payload.to || payload.email || '').trim();
        const mockupUrl =
          payload.mockup_url || payload.mockupUrl || '';
        const additionalMessage =
          (payload.message || payload.notes || '').trim();

        if (!shopifyOrderId) {
          sendJson(res, 400, { error: 'shopify_order_id is required.' });
          return;
        }

        const podOrder = db.getPodOrderByShopifyOrderId(shopifyOrderId);
        if (!podOrder) {
          sendJson(res, 404, { error: 'POD order not found for this Shopify order id.' });
          return;
        }

        const recipient = explicitTo || podOrder.customerEmail;
        if (!recipient) {
          sendJson(res, 400, { error: 'Customer email address is not available.' });
          return;
        }

        const lineItem =
          lineItemId ? db.getPodLineItemByShopifyId(lineItemId) : null;
        const finalMockupUrl =
          mockupUrl || (lineItem && lineItem.artworkPath) || '';

        const orderLabel =
          podOrder.shopifyOrderNumber ||
          podOrder.shopifyOrderId ||
          shopifyOrderId;
        const itemLabel =
          (lineItem && (lineItem.name || lineItem.sku)) || '';

        const subjectParts = [`Mockup for your order ${orderLabel}`];
        if (itemLabel) subjectParts.push(`– ${itemLabel}`);
        const subject = subjectParts.join(' ');

        const textLines = [
          `Hi ${podOrder.shippingName || 'there'},`,
          '',
          'Before we print your item, please review this mockup to confirm everything looks correct.',
        ];
        if (finalMockupUrl) {
          textLines.push('', `Mockup: ${finalMockupUrl}`);
        }
        if (additionalMessage) {
          textLines.push('', additionalMessage);
        }
        textLines.push(
          '',
          'Reply to this email to approve or request changes.',
          '',
          "Thanks,",
          "Swayze's Custom Vinyl"
        );
        const text = textLines.join('\n');

        const escapedName = escapeHtml(podOrder.shippingName || 'there');
        const escapedMessage = escapeHtml(additionalMessage);
        const htmlParts = [
          `<p>Hi ${escapedName},</p>`,
          '<p>Before we print your item, please review this mockup to confirm everything looks correct.</p>'
        ];
        if (finalMockupUrl) {
          const safeUrl = escapeHtml(finalMockupUrl);
          htmlParts.push(
            `<p><a href="${safeUrl}" target="_blank" rel="noopener noreferrer">View mockup</a></p>`,
            `<p><img src="${safeUrl}" alt="Order mockup" style="max-width:100%;height:auto;border:1px solid #ddd;border-radius:4px;" /></p>`
          );
        }
        if (additionalMessage) {
          htmlParts.push(`<p>${escapedMessage}</p>`);
        }
        htmlParts.push(
          '<p>Reply to this email to approve or request changes.</p>',
          `<p>Thanks,<br>Swayze's Custom Vinyl</p>`
        );
        const html = htmlParts.join('\n');

        try {
          await sendOrdersEmail({
            to: recipient,
            subject,
            text,
            html
          });
        } catch (eMail) {
          console.error('Unable to send POD mockup email:', eMail);
          sendJson(res, 502, { error: 'Unable to send email.' });
          return;
        }

        sendJson(res, 200, { success: true });
      } catch (e) {
        sendJson(res, 400, { error: e?.message || 'Invalid payload.' });
      }
    });
    return;
  }

  // Admin cleanup helpers
  if (
    req.method === 'GET' &&
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'orders' &&
    segments[3] === 'orphans'
  ) {
    if (!requireInternalKey(req, res)) return;
    try {
      const all = db.fetchOrders();
      const orphans = all.filter((o) => !o.customerId);
      sendJson(res, 200, { success: true, count: orphans.length, orders: orphans.map(toApiOrder) });
    } catch (error) {
      console.error('Unable to list orphans:', error);
      sendJson(res, 500, { error: error.message || 'Unable to list orphans.' });
    }
    return;
  }

  // Internal: SMS test endpoint (requires INTERNAL_API_KEY)
  if (
    req.method === 'GET' &&
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'ping'
  ) {
    if (!requireInternalKey(req, res)) return;
    sendJson(res, 200, { success: true });
    return;
  }

  // Lightweight health for SimpleTexting webhook path (helps verify Nginx route)
  if (
    req.method === 'GET' &&
    segments[0] === 'api' &&
    segments[1] === 'webhooks' &&
    segments[2] === 'simpletexting' &&
    segments[3] === 'health'
  ) {
    sendJson(res, 200, { ok: true, message: 'SimpleTexting webhook path healthy' });
    return;
  }

  // Webhook: SimpleTexting inbound SMS
  if (
    (req.method === 'POST' || req.method === 'GET') &&
    segments[0] === 'api' &&
    segments[1] === 'webhooks' &&
    segments[2] === 'simpletexting' &&
    segments[3] === 'inbound'
  ) {
    // Optional token check
    const wantToken = process.env.SIMPLETEXTING_WEBHOOK_TOKEN || process.env.ST_WEBHOOK_TOKEN || '';
    const qsToken = parsedUrl.query?.token || parsedUrl.query?.auth || parsedUrl.query?.key || '';
    if (wantToken && String(wantToken) !== String(qsToken)) {
      sendJson(res, 401, { error: 'Unauthorized webhook.' });
      return;
    }
    const finish = (payload) => {
      try {
        const msg = payload || {};
        // Accept multiple common aliases from providers
        const from = msg.phone || msg.from || msg.sender || msg.msisdn || msg.fromNumber || '';
        const to = msg.to || msg.recipient || msg.toNumber || '';
        const body = msg.message || msg.text || msg.body || msg.content || '';
        const providerId = msg.messageId || msg.id || msg.sms_id || null;
        if (!from || !body) {
          sendJson(res, 400, { error: 'Missing from or message.' });
          return;
        }
        const id = db.recordInboundMessage({ provider: 'simpletexting', providerId, from, to, body, raw: msg });
        // Keyword opt-in/out handling
        try {
          const upper = String(body || '').trim().toUpperCase();
          const customer = db.findCustomerByPhone ? db.findCustomerByPhone(from) : null;
          if (customer) {
            if (upper === 'STOP' || upper === 'UNSUBSCRIBE') {
              db.updateCustomerProfile(customer.id, { smsOptIn: false });
              sms
                .sendSms({ to: from, body: 'You have been unsubscribed. Reply START to opt in again.' })
                .catch(() => {});
            } else if (upper === 'START' || upper === 'YES') {
              db.updateCustomerProfile(customer.id, { smsOptIn: true });
              sms
                .sendSms({ to: from, body: 'You are now subscribed to SMS updates. Reply STOP to unsubscribe.' })
                .catch(() => {});
            }
          }
        } catch (e) {
          console.warn('Opt-in/out handling error:', e?.message || e);
        }
        // Optional auto-reply
        try {
          const auto = process.env.INBOUND_SMS_AUTOREPLY_ENABLED === '1' || process.env.INBOUND_SMS_AUTOREPLY_ENABLED === 'true';
          const replyText = process.env.INBOUND_SMS_AUTOREPLY_TEXT || 'Thanks! We received your message.';
          if (auto && from) {
            sms
              .sendSms({ to: from, body: replyText })
              .catch((e) => console.warn('Auto-reply failed:', e?.message || e));
          }
        } catch (e) {
          console.warn('Auto-reply exception:', e?.message || e);
        }
        // Optional email forward
        try {
          const forward = (process.env.INBOUND_SMS_FORWARD_EMAILS || '').split(/[,;\s]+/).filter(Boolean);
          if (forward.length) {
            const subject = `Inbound SMS from ${from}`;
            const lines = [
              `From: ${from || '(unknown)'}`,
              `To: ${to || '(unknown)'}`,
              `Message: ${body || ''}`,
              `ID: ${id}${providerId ? ` (provider: ${providerId})` : ''}`
            ];
            const text = lines.join('\n');
            const html = `<p><strong>From:</strong> ${from || '(unknown)'}<br/><strong>To:</strong> ${to || '(unknown)'}<br/><strong>Message:</strong> ${body || ''}<br/><strong>ID:</strong> ${id}${providerId ? ` (provider: ${providerId})` : ''}</p>`;
            // Fire-and-forget email forward; don't block webhook response
            sendOrdersEmail({ to: forward.join(','), subject, text, html }).catch((e) =>
              console.warn('Forward email failed:', e?.message || e)
            );
          }
        } catch (e) {
          console.warn('Forward email exception:', e?.message || e);
        }
        sendJson(res, 200, { success: true, id });
      } catch (e) {
        console.error('Inbound SMS error:', e);
        // Optional debug: if token matched and debug=1, expose details to aid setup
        const debug = (parsedUrl.query && (parsedUrl.query.debug === '1' || parsedUrl.query.debug === 'true')) || false;
        if (debug && (!wantToken || String(wantToken) === String(qsToken))) {
          sendJson(res, 500, { error: 'Unable to record message.', detail: e?.message || String(e) });
          return;
        }
        sendJson(res, 500, { error: 'Unable to record message.' });
      }
    };

    if (req.method === 'GET') {
      finish(parsedUrl.query || {});
      return;
    }
    collectRequestBody(req, (error, body) => {
      if (error) {
        sendJson(res, 413, { error: error.message });
        return;
      }
      const ctype = req.headers['content-type'] || '';
      if (ctype.includes('application/json')) {
        let json = {};
        try { json = JSON.parse(body || '{}'); } catch (_) {}
        finish(json);
      } else {
        // form-encoded or unknown: parse via URLSearchParams
        const params = new URLSearchParams(body || '');
        const payload = {};
        for (const [k, v] of params.entries()) payload[k] = v;
        finish(payload);
      }
    });
    return;
  }

  // Internal: test inbound insert (requires INTERNAL_API_KEY)
  if (
    req.method === 'POST' &&
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'inbound' &&
    segments[3] === 'test-insert'
  ) {
    if (!requireInternalKey(req, res)) return;
    collectRequestBody(req, (error, body) => {
      if (error) { sendJson(res, 413, { error: error.message }); return; }
      try {
        const json = body && (req.headers['content-type'] || '').includes('application/json')
          ? JSON.parse(body || '{}')
          : Object.fromEntries(new URLSearchParams(body || ''));
        const from = json.from || json.phone || '';
        const to = json.to || '';
        const message = json.message || json.text || json.body || '';
        if (!from || !message) { sendJson(res, 400, { error: 'from and message are required.' }); return; }
        const id = db.recordInboundMessage({ provider: 'simpletexting', providerId: 'debug', from, to, body: message, raw: json });
        sendJson(res, 200, { success: true, id });
      } catch (e) {
        sendJson(res, 500, { error: e.message || 'Insert failed.' });
      }
    });
    return;
  }

  // Internal: list inbound messages (requires INTERNAL_API_KEY)
  if (
    req.method === 'GET' &&
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'inbound-messages'
  ) {
    if (!requireInternalKey(req, res)) return;
    try {
      const since = parsedUrl.query?.since || null;
      const from = parsedUrl.query?.from || '';
      const phone = parsedUrl.query?.phone || '';
      const limit = Math.max(1, Math.min(Number(parsedUrl.query?.limit || 100), 500));
      const rows = listInboundMessages({ since, from, phone, limit });
      sendJson(res, 200, { success: true, items: rows });
    } catch (e) {
      console.error('List inbound failed:', e);
      sendJson(res, 500, { error: e.message || 'Unable to list inbound messages.' });
    }
    return;
  }

  // Internal: marketing audience map (requires INTERNAL_API_KEY)
  if (
    req.method === 'GET' &&
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'marketing' &&
    segments[3] === 'audience-map'
  ) {
    if (!requireInternalKey(req, res)) return;
    try {
      const mapping = ads.readAudienceMap();
      sendJson(res, 200, { success: true, mapping });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to load audience map.' });
    }
    return;
  }

  // Internal: marketing launch test (requires INTERNAL_API_KEY)
  if (
    req.method === 'POST' &&
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'marketing' &&
    segments[3] === 'launch'
  ) {
    if (!requireInternalKey(req, res)) return;
    collectRequestBody(req, async (error, body) => {
      if (error) { sendJson(res, 413, { error: error.message }); return; }
      try {
        const payload = JSON.parse(body || '{}');
        const product = payload.product || {};
        const marketingProfile = payload.marketing_profile || {};
        const audienceSeg = marketingProfile.audience_segment || 'general';
        const mapping = ads.mapAudienceToAds(audienceSeg) || {};
        const templateKey = marketingProfile.ad_template || mapping.creative_template || 'default';
        const overrides = { marketing_profile: marketingProfile };
        if (payload.product_url) overrides.product_url = payload.product_url;
        if (payload.utm) overrides.utm = payload.utm;
        const creative = ads.generateAdCreative(product, templateKey, overrides);
        const name = `${product?.title || 'Product'} · ${audienceSeg}`;
        const results = {};
        if (process.env.META_ACCESS_TOKEN && process.env.META_AD_ACCOUNT_ID) {
          try {
            const targeting = ads.buildMetaTargetingFromProfile(marketingProfile, mapping);
            results.meta = await ads.createAdCampaign('meta', { name, audience_id: mapping.meta_audience_id, creative, budget: 500, targeting });
          } catch (e) { results.meta = { error: e?.message || String(e) }; }
        }
        if (process.env.TIKTOK_ACCESS_TOKEN && process.env.TIKTOK_AD_ACCOUNT_ID) {
          try {
            const ttTargeting = ads.buildTikTokTargetingFromProfile(marketingProfile, mapping);
            results.tiktok = await ads.createAdCampaign('tiktok', { name, audience_id: mapping.tiktok_audience_id, creative, budget: 500, targeting: ttTargeting });
          } catch (e) { results.tiktok = { error: e?.message || String(e) }; }
        }
        sendJson(res, 200, { success: true, results, creative });
      } catch (e) {
        sendJson(res, 400, { error: e?.message || 'Invalid payload.' });
      }
    });
    return;
  }

  // Internal: marketing creative preview (requires INTERNAL_API_KEY)
  if (
    req.method === 'POST' &&
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'marketing' &&
    segments[3] === 'preview'
  ) {
    if (!requireInternalKey(req, res)) return;
    collectRequestBody(req, (error, body) => {
      if (error) { sendJson(res, 413, { error: error.message }); return; }
      try {
        const payload = JSON.parse(body || '{}');
        const product = payload.product || {};
        const marketingProfile = payload.marketing_profile || {};
        const templateKey = payload.template || marketingProfile.ad_template || '';
        const overrides = { marketing_profile: marketingProfile };
        if (payload.product_url) overrides.product_url = payload.product_url;
        if (payload.utm) overrides.utm = payload.utm;
        const creative = ads.generateAdCreative(product, templateKey, overrides);
        sendJson(res, 200, { success: true, creative });
      } catch (e) {
        sendJson(res, 400, { error: e?.message || 'Invalid payload.' });
      }
    });
    return;
  }

  // Internal: ads performance update (requires INTERNAL_API_KEY)
  if (
    req.method === 'POST' &&
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'ads' &&
    segments[3] === 'performance' &&
    segments[4] === 'update'
  ) {
    if (!requireInternalKey(req, res)) return;
    collectRequestBody(req, (error, body) => {
      if (error) { sendJson(res, 413, { error: error.message }); return; }
      try {
        const data = JSON.parse(body || '{}');
        const r = ads.updateTargetingFromPerformance(data);
        if (r.success) sendJson(res, 200, { success: true });
        else sendJson(res, 500, { error: r.error || 'Unable to update performance.' });
      } catch (e) {
        sendJson(res, 400, { error: e?.message || 'Invalid payload.' });
      }
    });
    return;
  }

  // Internal: ad templates (requires INTERNAL_API_KEY)
  if (
    req.method === 'GET' &&
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'marketing' &&
    segments[3] === 'ad-templates'
  ) {
    if (!requireInternalKey(req, res)) return;
    try {
      const templates = ads.readTemplates();
      sendJson(res, 200, { success: true, templates });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to load templates.' });
    }
    return;
  }

  // Internal: ads performance list (requires INTERNAL_API_KEY)
  if (
    req.method === 'GET' &&
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'ads' &&
    segments[3] === 'performance'
  ) {
    if (!requireInternalKey(req, res)) return;
    try {
      const limit = Math.max(1, Math.min(Number(parsedUrl.query?.limit || 200), 1000));
      const records = ads.readPerformance(limit);
      // Basic aggregates by audience_segment if provided
      const byAudience = {};
      records.forEach((r) => {
        const seg = (r.audience_segment || r.segment || 'unknown').toString();
        byAudience[seg] = byAudience[seg] || { count: 0 };
        byAudience[seg].count++;
        if (typeof r.ctr === 'number') { byAudience[seg].ctrSum = (byAudience[seg].ctrSum || 0) + r.ctr; }
        if (typeof r.cpa_cents === 'number') { byAudience[seg].cpaSum = (byAudience[seg].cpaSum || 0) + r.cpa_cents; byAudience[seg].cpaCount = (byAudience[seg].cpaCount || 0) + 1; }
      });
      Object.keys(byAudience).forEach((k) => {
        const a = byAudience[k];
        a.avgCtr = a.ctrSum != null ? a.ctrSum / a.count : null;
        a.avgCpaCents = a.cpaSum != null && a.cpaCount ? a.cpaSum / a.cpaCount : null;
        delete a.ctrSum; delete a.cpaSum; delete a.cpaCount;
      });
      sendJson(res, 200, { success: true, records, byAudience });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to load performance.' });
    }
    return;
  }

  // Admin: Campaign CRUD endpoints
  if (req.method === 'GET' && parsedUrl.pathname === '/api/admin/campaigns') {
    if (!requireInternalKey(req, res)) return;
    try {
      ensureCampaignsDir();
      const files = fs.readdirSync(CAMPAIGNS_DIR).filter(f => f.endsWith('.json'));
      const campaigns = files.map(f => {
        try {
          const slug = f.replace('.json', '');
          const data = JSON.parse(fs.readFileSync(path.join(CAMPAIGNS_DIR, f), 'utf8'));
          return {
            slug,
            title: data.title || slug,
            subtitle: data.subtitle || '',
            itemCount: Array.isArray(data.items) ? data.items.length : 0,
            createdAt: data.createdAt || null,
            updatedAt: data.updatedAt || null
          };
        } catch {
          return null;
        }
      }).filter(Boolean);
      sendJson(res, 200, { success: true, campaigns });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to list campaigns.' });
    }
    return;
  }

  if (req.method === 'GET' && segments[0] === 'api' && segments[1] === 'admin' && segments[2] === 'campaigns' && segments[3]) {
    if (!requireInternalKey(req, res)) return;
    try {
      const slug = sanitizeCampaignSlug(segments[3]);
      const campaign = readCampaign(slug);
      if (!campaign) {
        sendJson(res, 404, { error: 'Campaign not found.' });
        return;
      }
      sendJson(res, 200, { success: true, campaign });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to read campaign.' });
    }
    return;
  }

  if (req.method === 'POST' && parsedUrl.pathname === '/api/admin/campaigns') {
    if (!requireInternalKey(req, res)) return;
    try {
      const body = await getReqBodyJson(req);
      if (!body || (!body.slug && !body.title)) {
        sendJson(res, 400, { error: 'slug or title is required.' });
        return;
      }
      const slug = sanitizeCampaignSlug(body.slug || body.title);
      const campaign = {
        slug,
        title: body.title || slug,
        subtitle: body.subtitle || '',
        themeColor: body.themeColor || '#1d4ed8',
        hero: body.hero || null,
        items: Array.isArray(body.items) ? body.items : [],
        salesInitiative: body.salesInitiative || null,
        benefits: body.benefits || null,
        socialProof: body.socialProof || null,
        endDate: body.endDate || null,
        mockupStrategy: body.mockupStrategy || null,
        apparel: body.apparel || null,
        shopifyCollection: body.shopifyCollection || null,
        shopifyPage: body.shopifyPage || null,
        createdAt: body.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      writeCampaignFile(slug, campaign);
      sendJson(res, 200, { success: true, campaign });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to create campaign.' });
    }
    return;
  }

  if (req.method === 'POST' && segments[0] === 'api' && segments[1] === 'admin' && segments[2] === 'campaigns' && segments[3]) {
    if (!requireInternalKey(req, res)) return;
    try {
      const slug = sanitizeCampaignSlug(segments[3]);
      const existing = readCampaign(slug);
      if (!existing) {
        sendJson(res, 404, { error: 'Campaign not found.' });
        return;
      }
      const body = await getReqBodyJson(req);
      // Debug: Log mockup data being saved
      if (body.items && Array.isArray(body.items) && body.items.length > 0) {
        console.log(`[Campaign Update] Saving ${body.items.length} items for campaign ${slug}`);
        console.log(`[Campaign Update] First item mockupImage: ${body.items[0].mockupImage || 'NONE'}`);
        console.log(`[Campaign Update] First item shopifyProductId: ${body.items[0].shopifyProductId || 'NONE'}`);
      }
      const campaign = {
        ...existing,
        title: body.title !== undefined ? body.title : existing.title,
        subtitle: body.subtitle !== undefined ? body.subtitle : existing.subtitle,
        themeColor: body.themeColor !== undefined ? body.themeColor : existing.themeColor,
        hero: body.hero !== undefined ? body.hero : existing.hero,
        items: body.items !== undefined ? body.items : existing.items,
        salesInitiative: body.salesInitiative !== undefined ? body.salesInitiative : existing.salesInitiative,
        benefits: body.benefits !== undefined ? body.benefits : existing.benefits,
        socialProof: body.socialProof !== undefined ? body.socialProof : existing.socialProof,
        endDate: body.endDate !== undefined ? body.endDate : existing.endDate,
        mockupStrategy: body.mockupStrategy !== undefined ? body.mockupStrategy : existing.mockupStrategy,
        apparel: body.apparel !== undefined ? body.apparel : existing.apparel,
        shopifyCollection: body.shopifyCollection !== undefined ? body.shopifyCollection : existing.shopifyCollection,
        shopifyPage: body.shopifyPage !== undefined ? body.shopifyPage : existing.shopifyPage,
        updatedAt: new Date().toISOString()
      };
      writeCampaignFile(slug, campaign);
      sendJson(res, 200, { success: true, campaign });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to update campaign.' });
    }
    return;
  }

  if (req.method === 'DELETE' && segments[0] === 'api' && segments[1] === 'admin' && segments[2] === 'campaigns' && segments[3]) {
    if (!requireInternalKey(req, res)) return;
    try {
      const slug = sanitizeCampaignSlug(segments[3]);
      const filePath = path.join(CAMPAIGNS_DIR, `${slug}.json`);
      if (!fs.existsSync(filePath)) {
        sendJson(res, 404, { error: 'Campaign not found.' });
        return;
      }
      fs.unlinkSync(filePath);
      sendJson(res, 200, { success: true });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to delete campaign.' });
    }
    return;
  }

  // Campaign mockup save endpoint
  if (req.method === 'POST' && parsedUrl.pathname === '/api/campaigns/save-mockup') {
    if (!requireInternalKey(req, res)) return;
    try {
      const body = await getReqBodyJson(req);
      const { campaignId, mockupBase64, filename } = body;

      if (!campaignId) {
        sendJson(res, 400, { error: 'campaignId is required.' });
        return;
      }
      if (!mockupBase64) {
        sendJson(res, 400, { error: 'mockupBase64 is required.' });
        return;
      }

      // Find the campaign file by ID (campaignId could be the slug)
      const slug = sanitizeCampaignSlug(campaignId);
      const campaign = readCampaign(slug);
      if (!campaign) {
        sendJson(res, 404, { error: 'Campaign not found.' });
        return;
      }

      // Create campaign mockups directory if needed
      const mockupsDir = path.join(CAMPAIGNS_DIR, 'mockups');
      if (!fs.existsSync(mockupsDir)) {
        fs.mkdirSync(mockupsDir, { recursive: true });
      }

      // Save the mockup image
      const mockupFilename = filename || `campaign-mockup-${slug}-${Date.now()}.jpg`;
      const mockupPath = path.join(mockupsDir, mockupFilename);
      const imageBuffer = Buffer.from(mockupBase64, 'base64');
      fs.writeFileSync(mockupPath, imageBuffer);

      // Update campaign with mockup path
      const relativeMockupPath = `/uploads/campaigns/mockups/${mockupFilename}`;
      campaign.mockupImage = relativeMockupPath;
      campaign.updatedAt = new Date().toISOString();
      writeCampaignFile(slug, campaign);

      // Get image dimensions if sharp is available
      let width = null, height = null;
      if (sharp) {
        try {
          const meta = await sharp(mockupPath).metadata();
          width = meta.width;
          height = meta.height;
        } catch (_) {}
      }

      // Create a mockup record in the database for campaign mockups too
      const mockupId = db.createCustomArtMockup({
        title: `${campaign.name || slug} Campaign Mockup`,
        filename: mockupFilename,
        filePath: mockupPath,
        url: relativeMockupPath,
        productId: null,
        artworkId: null,
        roomId: null,
        campaignSlug: slug,
        materialId: null,
        mockupType: 'campaign',
        width,
        height,
        fileSize: imageBuffer.length,
        tags: null,
        notes: null
      });

      console.log(`[Campaign Mockup] Saved mockup ${mockupId} for campaign ${slug}: ${relativeMockupPath}`);
      sendJson(res, 200, { success: true, mockupId, mockupPath: relativeMockupPath });
    } catch (e) {
      console.error('[Campaign Mockup] Error:', e);
      sendJson(res, 500, { error: e?.message || 'Unable to save campaign mockup.' });
    }
    return;
  }

  // ============================================================================
  // FACEBOOK POST SCHEDULING & MOCKUP TEMPLATE ENDPOINTS
  // ============================================================================

  // Create/Update Mockup Template
  if (req.method === 'POST' && parsedUrl.pathname === '/api/facebook/mockup-templates') {
    if (!requireInternalKey(req, res)) return;
    try {
      const body = await getReqBodyJson(req);
      const { campaignSlug, name, mockupImagePath, artworkPosition, blendMode, outputFormat, outputQuality } = body;

      if (!campaignSlug || !mockupImagePath || !artworkPosition) {
        sendJson(res, 400, { error: 'campaignSlug, mockupImagePath, and artworkPosition are required.' });
        return;
      }

      const template = db.createMockupTemplate({
        campaignSlug,
        name: name || 'Default Template',
        mockupImagePath,
        artworkPosition,
        blendMode,
        outputFormat,
        outputQuality
      });

      sendJson(res, 201, { success: true, template });
    } catch (e) {
      console.error('[Mockup Template] Error:', e);
      sendJson(res, 500, { error: e?.message || 'Unable to create mockup template.' });
    }
    return;
  }

  // List ALL mockup templates
  if (req.method === 'GET' && parsedUrl.pathname === '/api/facebook/mockup-templates') {
    if (!requireInternalKey(req, res)) return;
    try {
      const templates = db.listAllMockupTemplates();
      sendJson(res, 200, { success: true, templates });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to fetch templates.' });
    }
    return;
  }

  // Get mockup templates for a specific campaign
  if (req.method === 'GET' && parsedUrl.pathname.startsWith('/api/facebook/mockup-templates/')) {
    if (!requireInternalKey(req, res)) return;
    try {
      const campaignSlug = parsedUrl.pathname.split('/').pop();
      const templates = db.getMockupTemplatesByCampaign(campaignSlug);
      sendJson(res, 200, { success: true, templates });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to fetch templates.' });
    }
    return;
  }

  // Update mockup template
  if (req.method === 'PUT' && parsedUrl.pathname.startsWith('/api/facebook/mockup-templates/')) {
    if (!requireInternalKey(req, res)) return;
    try {
      const templateId = parsedUrl.pathname.split('/').pop();
      const body = await getReqBodyJson(req);
      const template = db.updateMockupTemplate(templateId, body);
      sendJson(res, 200, { success: true, template });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to update template.' });
    }
    return;
  }

  // Delete mockup template
  if (req.method === 'DELETE' && parsedUrl.pathname.startsWith('/api/facebook/mockup-templates/')) {
    if (!requireInternalKey(req, res)) return;
    try {
      const templateId = parsedUrl.pathname.split('/').pop();
      db.deleteMockupTemplate(templateId);
      sendJson(res, 200, { success: true });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to delete template.' });
    }
    return;
  }

  // Schedule Facebook posts for a campaign
  if (req.method === 'POST' && parsedUrl.pathname === '/api/facebook/schedule-campaign') {
    if (!requireInternalKey(req, res)) return;
    try {
      const body = await getReqBodyJson(req);
      const { campaignSlug, templateId, postText, postHashtags, collectionUrl, startDate, intervalHours, excludeProductUids } = body;

      if (!campaignSlug) {
        sendJson(res, 400, { error: 'campaignSlug is required.' });
        return;
      }

      // Load campaign
      const campaign = readCampaign(campaignSlug);
      if (!campaign) {
        sendJson(res, 404, { error: 'Campaign not found.' });
        return;
      }

      // Import scheduler
      const { schedulePostsForCampaign } = require('./lib/facebook-post-scheduler');

      const result = schedulePostsForCampaign(campaign, db, {
        templateId,
        postText,
        postHashtags,
        collectionUrl,
        startDate,
        intervalHours: intervalHours || 24,
        excludeProductUids: excludeProductUids || []
      });

      sendJson(res, 200, { success: true, ...result });
    } catch (e) {
      console.error('[FB Schedule Campaign] Error:', e);
      sendJson(res, 500, { error: e?.message || 'Unable to schedule campaign posts.' });
    }
    return;
  }

  // List scheduled posts
  if (req.method === 'GET' && parsedUrl.pathname === '/api/facebook/scheduled-posts') {
    if (!requireInternalKey(req, res)) return;
    try {
      const { campaignSlug, status, fromDate, toDate, limit, offset } = parsedUrl.query || {};
      const posts = db.listScheduledPosts({
        campaignSlug,
        status,
        fromDate,
        toDate,
        limit: Number(limit) || 100,
        offset: Number(offset) || 0
      });
      sendJson(res, 200, { posts, count: posts.length });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to fetch scheduled posts.' });
    }
    return;
  }

  // Create a single scheduled post
  if (req.method === 'POST' && parsedUrl.pathname === '/api/facebook/scheduled-posts') {
    if (!requireInternalKey(req, res)) return;
    try {
      const body = await getReqBodyJson(req);
      const post = db.createScheduledPost(body);
      sendJson(res, 201, { success: true, post });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to create scheduled post.' });
    }
    return;
  }

  // Update a scheduled post
  if (req.method === 'PUT' && parsedUrl.pathname.startsWith('/api/facebook/scheduled-posts/')) {
    if (!requireInternalKey(req, res)) return;
    try {
      const postId = parsedUrl.pathname.split('/').pop();
      const body = await getReqBodyJson(req);
      const post = db.updateScheduledPost(postId, body);
      sendJson(res, 200, { success: true, post });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to update scheduled post.' });
    }
    return;
  }

  // Delete a scheduled post
  if (req.method === 'DELETE' && parsedUrl.pathname.startsWith('/api/facebook/scheduled-posts/')) {
    if (!requireInternalKey(req, res)) return;
    try {
      const postId = parsedUrl.pathname.split('/').pop();
      db.deleteScheduledPost(postId);
      sendJson(res, 200, { success: true });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to delete scheduled post.' });
    }
    return;
  }

  // Post a single scheduled post immediately
  if (req.method === 'POST' && parsedUrl.pathname.match(/^\/api\/facebook\/scheduled-posts\/[^/]+\/post$/)) {
    console.log('[FB Post Now] Received request:', parsedUrl.pathname);
    if (!requireInternalKey(req, res)) return;
    try {
      const pathParts = parsedUrl.pathname.split('/');
      const postId = pathParts[pathParts.length - 2]; // Get ID before /post
      console.log('[FB Post Now] Post ID:', postId);

      const post = db.getScheduledPostById(postId);
      console.log('[FB Post Now] Found post:', post ? 'yes' : 'no', post ? JSON.stringify(post).substring(0, 200) : '');
      if (!post) {
        sendJson(res, 404, { error: 'Scheduled post not found.' });
        return;
      }

      const { processScheduledPost } = require('./lib/facebook-post-scheduler');
      console.log('[FB Post Now] Processing post...');
      const result = await processScheduledPost(post, db);
      console.log('[FB Post Now] Result:', JSON.stringify(result).substring(0, 500));

      if (result.success) {
        sendJson(res, 200, { success: true, facebookPostId: result.facebookPostId });
      } else {
        sendJson(res, 500, { success: false, error: result.error });
      }
    } catch (e) {
      console.error('[FB Post Now] Error:', e);
      sendJson(res, 500, { error: e?.message || 'Unable to post now.' });
    }
    return;
  }

  // Retry a failed scheduled post
  if (req.method === 'POST' && parsedUrl.pathname.match(/^\/api\/facebook\/scheduled-posts\/[^/]+\/retry$/)) {
    if (!requireInternalKey(req, res)) return;
    try {
      const pathParts = parsedUrl.pathname.split('/');
      const postId = pathParts[pathParts.length - 2]; // Get ID before /retry

      const post = db.getScheduledPostById(postId);
      if (!post) {
        sendJson(res, 404, { error: 'Scheduled post not found.' });
        return;
      }

      // Reset status to pending so it can be processed
      db.updateScheduledPost(postId, { status: 'pending', error: null });

      const { processScheduledPost } = require('./lib/facebook-post-scheduler');
      const result = await processScheduledPost(post, db);

      if (result.success) {
        sendJson(res, 200, { success: true, facebookPostId: result.facebookPostId });
      } else {
        sendJson(res, 500, { success: false, error: result.error });
      }
    } catch (e) {
      console.error('[FB Retry Post] Error:', e);
      sendJson(res, 500, { error: e?.message || 'Unable to retry post.' });
    }
    return;
  }

  // Process pending posts now (manual trigger)
  if (req.method === 'POST' && parsedUrl.pathname === '/api/facebook/process-pending') {
    if (!requireInternalKey(req, res)) return;
    try {
      const { processPendingPosts } = require('./lib/facebook-post-scheduler');
      const results = await processPendingPosts(db);
      sendJson(res, 200, { success: true, ...results });
    } catch (e) {
      console.error('[FB Process Pending] Error:', e);
      sendJson(res, 500, { error: e?.message || 'Unable to process pending posts.' });
    }
    return;
  }

  // Preview mockup generation (without posting)
  if (req.method === 'POST' && parsedUrl.pathname === '/api/facebook/preview-mockup') {
    if (!requireInternalKey(req, res)) return;
    try {
      const body = await getReqBodyJson(req);
      const { templateId, artworkPath } = body;

      if (!templateId || !artworkPath) {
        sendJson(res, 400, { error: 'templateId and artworkPath are required.' });
        return;
      }

      const template = db.getMockupTemplateById(templateId);
      if (!template) {
        sendJson(res, 404, { error: 'Template not found.' });
        return;
      }

      const { previewTemplate } = require('./lib/mockup-compositor');
      const preview = await previewTemplate(
        {
          mockupImagePath: template.mockupImagePath,
          artworkPosition: template.artworkPosition,
          blendMode: template.blendMode,
          outputFormat: template.outputFormat,
          outputQuality: template.outputQuality
        },
        artworkPath
      );

      sendJson(res, 200, { success: true, preview: preview.dataUrl });
    } catch (e) {
      console.error('[Mockup Preview] Error:', e);
      sendJson(res, 500, { error: e?.message || 'Unable to generate preview.' });
    }
    return;
  }

  // Get insights for a single Facebook post
  if (req.method === 'GET' && parsedUrl.pathname.match(/^\/api\/facebook\/posts\/[^/]+\/insights$/)) {
    if (!requireInternalKey(req, res)) return;
    try {
      const pathParts = parsedUrl.pathname.split('/');
      const facebookPostId = pathParts[4]; // /api/facebook/posts/{id}/insights

      const { getPostInsights } = require('./lib/facebook-post-scheduler');
      const insights = await getPostInsights(facebookPostId);
      sendJson(res, 200, { success: true, insights });
    } catch (e) {
      console.error('[FB Insights] Error:', e);
      sendJson(res, 500, { error: e?.message || 'Unable to fetch insights.' });
    }
    return;
  }

  // Get insights for published scheduled posts (with pagination)
  if (req.method === 'GET' && parsedUrl.pathname === '/api/facebook/scheduled-posts/insights') {
    if (!requireInternalKey(req, res)) return;
    try {
      // Parse pagination params
      const limit = parseInt(parsedUrl.query?.limit) || 20;
      const offset = parseInt(parsedUrl.query?.offset) || 0;

      // Get all published posts with Facebook IDs
      const posts = db.listScheduledPosts({ status: 'published' });
      const postsWithFbIds = posts.filter(p => p.facebookPostId);
      const totalCount = postsWithFbIds.length;

      if (totalCount === 0) {
        sendJson(res, 200, { success: true, insights: [], totalCount: 0, limit, offset, message: 'No published posts with Facebook IDs found.' });
        return;
      }

      // Apply pagination - slice posts for this page
      const paginatedPosts = postsWithFbIds.slice(offset, offset + limit);

      const { getPostInsights } = require('./lib/facebook-post-scheduler');

      // Fetch insights for each post in this page
      const insightsResults = [];
      for (const post of paginatedPosts) {
        try {
          const insights = await getPostInsights(post.facebookPostId);
          insightsResults.push({
            scheduledPostId: post.id,
            productName: post.productName,
            campaignSlug: post.campaignSlug,
            publishedAt: post.publishedAt,
            ...insights
          });
        } catch (err) {
          insightsResults.push({
            scheduledPostId: post.id,
            productName: post.productName,
            campaignSlug: post.campaignSlug,
            facebookPostId: post.facebookPostId,
            error: err.message
          });
        }
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      sendJson(res, 200, { success: true, insights: insightsResults, totalCount, limit, offset });
    } catch (e) {
      console.error('[FB Insights Bulk] Error:', e);
      sendJson(res, 500, { error: e?.message || 'Unable to fetch insights.' });
    }
    return;
  }

  // Get insights summary (aggregated stats)
  if (req.method === 'GET' && parsedUrl.pathname === '/api/facebook/insights/summary') {
    if (!requireInternalKey(req, res)) return;
    try {
      const { campaignSlug, days } = parsedUrl.query || {};
      const daysAgo = parseInt(days) || 30;
      const cutoffDate = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();

      // Get published posts
      const allPosts = db.listScheduledPosts({ status: 'published' });
      let posts = allPosts.filter(p => p.facebookPostId && p.publishedAt >= cutoffDate);

      if (campaignSlug) {
        posts = posts.filter(p => p.campaignSlug === campaignSlug);
      }

      if (posts.length === 0) {
        sendJson(res, 200, {
          success: true,
          summary: {
            totalPosts: 0,
            totalLikes: 0,
            totalComments: 0,
            totalShares: 0,
            totalReach: 0,
            totalImpressions: 0,
            avgEngagementRate: '0.00',
            topPosts: []
          }
        });
        return;
      }

      const { getPostInsights } = require('./lib/facebook-post-scheduler');

      // Fetch insights for each
      const allInsights = [];
      for (const post of posts) {
        try {
          const insights = await getPostInsights(post.facebookPostId);
          allInsights.push({
            ...insights,
            scheduledPostId: post.id,
            productName: post.productName,
            campaignSlug: post.campaignSlug
          });
        } catch (err) {
          console.log(`[FB Insights] Failed to fetch for ${post.facebookPostId}: ${err.message}`);
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Calculate summary
      const summary = {
        totalPosts: allInsights.length,
        totalLikes: allInsights.reduce((sum, i) => sum + (i.likes || 0), 0),
        totalComments: allInsights.reduce((sum, i) => sum + (i.comments || 0), 0),
        totalShares: allInsights.reduce((sum, i) => sum + (i.shares || 0), 0),
        totalReach: allInsights.reduce((sum, i) => sum + (i.reach || 0), 0),
        totalImpressions: allInsights.reduce((sum, i) => sum + (i.impressions || 0), 0),
        avgEngagementRate: '0.00',
        topPosts: []
      };

      // Calculate average engagement rate
      if (summary.totalReach > 0) {
        const totalEngagement = summary.totalLikes + summary.totalComments + summary.totalShares;
        summary.avgEngagementRate = (totalEngagement / summary.totalReach * 100).toFixed(2);
      }

      // Get top 5 posts by engagement
      summary.topPosts = allInsights
        .sort((a, b) => (b.likes + b.comments + b.shares) - (a.likes + a.comments + a.shares))
        .slice(0, 5)
        .map(i => ({
          productName: i.productName,
          campaignSlug: i.campaignSlug,
          likes: i.likes,
          comments: i.comments,
          shares: i.shares,
          reach: i.reach,
          engagementRate: i.engagementRate,
          permalinkUrl: i.permalinkUrl
        }));

      sendJson(res, 200, { success: true, summary, period: `${daysAgo} days` });
    } catch (e) {
      console.error('[FB Insights Summary] Error:', e);
      sendJson(res, 500, { error: e?.message || 'Unable to generate insights summary.' });
    }
    return;
  }

  // Internal: Export campaign to Shopify (requires INTERNAL_API_KEY)
  if (
    req.method === 'POST' &&
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'marketing' &&
    segments[3] === 'shopify' &&
    segments[4] === 'export-campaign' &&
    segments[5]
  ) {
    if (!requireInternalKey(req, res)) return;
    if (!shopify.isConfigured()) { sendJson(res, 503, { error: 'Shopify not configured.' }); return; }
    try {
      const slug = sanitizeCampaignSlug(segments[5]);
      const doAsync = parsedUrl.query?.async === '1' || parsedUrl.query?.async === 'true';
      // Optional: export only specific item indices (comma-separated)
      const onlyParam = parsedUrl.query?.only || '';
      const onlySet = onlyParam
        ? new Set(
            String(onlyParam)
              .split(/[\s,]+/)
              .map((v) => Number(v))
              .filter((n) => Number.isFinite(n))
          )
        : null;
      const force = parsedUrl.query?.force === '1' || parsedUrl.query?.force === 'true';
      const skipMockups = parsedUrl.query?.skipMockups === '1' || parsedUrl.query?.skipMockups === 'true';
      const campaign = readCampaign(slug);
      if (!campaign) { sendJson(res, 404, { error: 'Campaign not found.' }); return; }

      if (!doAsync) {
        // Fallback to sync: small campaigns
        parsedUrl.query = parsedUrl.query || {};
        parsedUrl.query.async = '1';
      }

      // Start background job
      const jobId = `export-${slug}-${Date.now()}`;
      const statePath = path.join(ensureExportDir(), `${jobId}.json`);
      const totalAll = Array.isArray(campaign.items) ? campaign.items.length : 0;
      const total = onlySet ? onlySet.size : totalAll;
      fs.writeFileSync(statePath, JSON.stringify({ jobId, slug, total, processed: 0, ok: 0, fail: 0, startedAt: new Date().toISOString(), done: false, only: onlySet ? Array.from(onlySet) : null }, null, 2));

      const delay = (ms) => new Promise((r) => setTimeout(r, ms));
      // Delay between items to avoid rate limit issues
      const rateLimitMs = Number(process.env.SHOPIFY_EXPORT_RATE_LIMIT_MS || process.env.SHOPIFY_REQUEST_DELAY_MS || 600);

      setImmediate(async () => {
        const assetRoot = process.env.ASSET_BASE_URL || process.env.STORE_BASE_URL || '';
        let results = [];
        let ok = 0, fail = 0, processed = 0;
        try {
          // Load pricing sheet once for this job
          const pricing = readPricingSheet();
          // Default stock per variant
          const defaultStock = Number(process.env.SHOPIFY_DEFAULT_STOCK_PER_VARIANT || 10);
          // Ensure collection
          const collectionTitle = campaign.title || slug;
          console.log(`[Collection] Looking for collection: "${collectionTitle}"`);
          let collection = null;
          try {
            collection = await shopify.findCustomCollectionByTitle(collectionTitle);
            if (collection) {
              console.log(`[Collection] ✓ Found existing collection (ID: ${collection.id})`);
            }
          } catch (err) {
            console.log(`[Collection] Search failed: ${err.message}`);
          }
          if (!collection) {
            console.log(`[Collection] Creating new collection: "${collectionTitle}"`);
            try {
              collection = await shopify.createCustomCollection(collectionTitle);
              console.log(`[Collection] ✓ Created collection (ID: ${collection.id})`);
            } catch (err) {
              console.error(`[Collection] ✗ Failed to create: ${err.message}`);
            }
          }
          const collectionId = collection?.id || null;
          const collectionHandle = collection?.handle || null;
          const shopFront = getShopifyStorefrontBase();
          const collectionUrl = collectionHandle && shopFront ? `${shopFront}/collections/${collectionHandle}` : null;

          // Primary location for inventory (prefer env if provided)
          let locationId = process.env.SHOPIFY_LOCATION_ID ? (Number(process.env.SHOPIFY_LOCATION_ID) || process.env.SHOPIFY_LOCATION_ID) : null;
          if (!locationId) {
            try { const locs = await shopify.listLocations(); locationId = locs?.[0]?.id || null; } catch (_) {}
          }

          // Enforce campaign-level apparel: if campaign.apparel is empty but any item has
          // an S&S apparel selection, promote the first one to campaign.apparel so all
          // items inherit it. Persist back to the campaign file for consistency.
          try {
            if (!campaign.apparel) {
              const firstWithApparel = (Array.isArray(campaign.items) ? campaign.items : [])
                .find((x) => x && x.apparel && String(x.apparel.source || '').toLowerCase() === 'ssaw');
              if (firstWithApparel && firstWithApparel.apparel) {
                campaign.apparel = firstWithApparel.apparel;
                try { writeCampaignFile(slug, { ...campaign, updatedAt: new Date().toISOString() }); } catch (_) {}
              }
            }
          } catch (_) {}

          const items = Array.isArray(campaign.items) ? campaign.items : [];
          const rawMockupStrategy = campaign.mockupStrategy || {};
          const mockupStrategy = {
            mode: String(rawMockupStrategy.mode || 'perItem').toLowerCase() === 'campaign' ? 'campaign' : 'perItem',
            mockupItemUid: String(rawMockupStrategy.mockupItemUid || ''),
            description: String(rawMockupStrategy.description || '').trim()
          };
          const selectedMockupItem =
            mockupStrategy.mode === 'campaign' && mockupStrategy.mockupItemUid
              ? items.find((it) => String(it.uid || '') === mockupStrategy.mockupItemUid)
              : null;
          const sharedMockupImage = selectedMockupItem
            ? buildPublicAssetUrl(selectedMockupItem.image, assetRoot)
            : null;
          // Encode spaces in shared mockup image URL for Shopify compatibility
          const sharedMockupImageEncoded = sharedMockupImage ? sharedMockupImage.replace(/ /g, '%20') : null;
          const sharedMockupName = selectedMockupItem ? selectedMockupItem.name || '' : '';

          // Update collection description and image (always, not just for campaign mockup mode)
          if (collectionId) {
            try {
              // Determine which mockup image to use for the collection
              let collectionMockupUrl = null;
              if (mockupStrategy.mode === 'campaign' && sharedMockupImage) {
                // Use shared mockup if in campaign mode
                collectionMockupUrl = sharedMockupImageEncoded;
              } else {
                // Use first item's mockup if available (per-item mode)
                const firstItemWithMockup = items.find((it) => it.mockupImage);
                if (firstItemWithMockup) {
                  const url = buildPublicAssetUrl(firstItemWithMockup.mockupImage, assetRoot);
                  collectionMockupUrl = url ? url.replace(/ /g, '%20') : null;
                }
              }

              // Build rich HTML description for collection landing page
              const collectionDescriptionParts = [];

              // Hero section with subtitle
              if (campaign.subtitle) {
                collectionDescriptionParts.push(`<h2 class="campaign-subtitle" style="font-size:24px;font-weight:600;margin:0 0 16px 0;color:#111827;">${escapeHtml(campaign.subtitle)}</h2>`);
              }

              // Mockup description
              if (mockupStrategy.description) {
                collectionDescriptionParts.push(`<p class="campaign-description" style="font-size:16px;line-height:1.6;color:#374151;margin:0 0 20px 0;">${escapeHtml(mockupStrategy.description)}</p>`);
              }

              // Sales initiative / promotion
              if (campaign.salesInitiative && campaign.salesInitiative.type !== 'none') {
                const si = campaign.salesInitiative;
                let promoText = '';
                if (si.type === 'buy_x_get_y') {
                  promoText = `Buy ${si.buyQuantity || 10}, Get ${si.freeQuantity || 1} Free!`;
                } else if (si.description) {
                  promoText = si.description;
                }
                if (promoText) {
                  collectionDescriptionParts.push(`
                    <div class="campaign-promo" style="background:#fef3c7;border-left:4px solid #f59e0b;padding:16px;margin:20px 0;border-radius:8px;">
                      <strong style="color:#d97706;font-size:14px;text-transform:uppercase;letter-spacing:0.5px;">Limited Time Offer:</strong>
                      <p style="margin:8px 0 0 0;font-size:18px;font-weight:600;color:#92400e;">${escapeHtml(promoText)}</p>
                    </div>
                  `);
                }
              }

              // Call to action
              const itemCount = items.length;
              collectionDescriptionParts.push(`
                <p style="margin:24px 0;font-size:16px;color:#111827;">
                  <strong>Choose from ${itemCount} unique design${itemCount !== 1 ? 's' : ''} below!</strong>
                </p>
              `);

              const body_html = collectionDescriptionParts.join('\n');

              // Upload mockup image to Shopify by setting it as the collection's image
              // Shopify will automatically upload it to their CDN
              const updatePayload = { body_html };
              if (collectionMockupUrl) {
                updatePayload.image = { src: collectionMockupUrl };
                console.log(`[Collection] Adding mockup image to collection`);
              }
              await shopify.updateCustomCollection(collectionId, updatePayload);

              // Store mockup metadata in collection metafields for reference
              await shopify.upsertCollectionMetafield(collectionId, {
                namespace: 'marketing',
                key: 'shared_mockup_image',
                value: sharedMockupImage
              });
              if (mockupStrategy.description) {
                await shopify.upsertCollectionMetafield(collectionId, {
                  namespace: 'marketing',
                  key: 'shared_mockup_description',
                  value: mockupStrategy.description
                });
              }
              if (sharedMockupName) {
                await shopify.upsertCollectionMetafield(collectionId, {
                  namespace: 'marketing',
                  key: 'shared_mockup_label',
                  value: sharedMockupName
                });
              }

              // Campaign tagline/subtitle
              if (campaign.subtitle) {
                await shopify.upsertCollectionMetafield(collectionId, {
                  namespace: 'marketing',
                  key: 'campaign_tagline',
                  value: campaign.subtitle,
                  type: 'single_line_text_field'
                });
              }

              // Social proof text
              const socialProof = campaign.socialProof || 'Trusted by 500+ customers';
              await shopify.upsertCollectionMetafield(collectionId, {
                namespace: 'marketing',
                key: 'social_proof_text',
                value: socialProof,
                type: 'single_line_text_field'
              });

              // Campaign benefits
              const defaultBenefits = [
                'Premium weather-resistant vinyl',
                'Easy peel & stick application',
                'Vibrant, long-lasting colors',
                'Custom sizes available'
              ];
              const benefits = campaign.benefits && Array.isArray(campaign.benefits) && campaign.benefits.length
                ? campaign.benefits
                : defaultBenefits;
              await shopify.upsertCollectionMetafield(collectionId, {
                namespace: 'marketing',
                key: 'campaign_benefits',
                value: JSON.stringify(benefits),
                type: 'json'
              });

              // Campaign end date (if available)
              if (campaign.endDate) {
                await shopify.upsertCollectionMetafield(collectionId, {
                  namespace: 'marketing',
                  key: 'campaign_end_date',
                  value: campaign.endDate,
                  type: 'single_line_text_field'
                });
              }

              // Theme color for styling
              if (campaign.themeColor) {
                await shopify.upsertCollectionMetafield(collectionId, {
                  namespace: 'marketing',
                  key: 'theme_color',
                  value: campaign.themeColor,
                  type: 'color'
                });
              }

              // Sales initiative details
              if (campaign.salesInitiative && campaign.salesInitiative.type !== 'none') {
                await shopify.upsertCollectionMetafield(collectionId, {
                  namespace: 'marketing',
                  key: 'promotion_details',
                  value: JSON.stringify(campaign.salesInitiative),
                  type: 'json'
                });
              }

            } catch (err) {
              console.warn('Unable to update collection mockup metafields:', err?.message || err);
            }
          }
          for (let i = 0; i < items.length; i++) {
            if (onlySet && !onlySet.has(i)) {
              continue;
            }
            if (rateLimitMs > 0) {
              await delay(rateLimitMs);
            }
            const it = items[i] || {};
            try {
              // Check for cancel
              try {
                const st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
                if (st.cancelled) {
                  fs.writeFileSync(statePath, JSON.stringify({ ...st, done: true, finishedAt: new Date().toISOString() }, null, 2));
                  break;
                }
              } catch (_) {}
              const title = `${campaign.title || slug} · ${it.name || `Item ${i + 1}`}`.trim();
              const shareUrl = `${(process.env.STORE_BASE_URL || '').replace(/\/$/, '')}/web/campaign.html?c=${encodeURIComponent(slug)}`;
              const descParts = [];
              console.log(`[Shopify Export] Item ${i + 1}: ${it.name}`);
              console.log(`[Shopify Export]   it.autoDescription: ${it.autoDescription ? it.autoDescription.substring(0, 50) + '...' : 'NONE'}`);
              console.log(`[Shopify Export]   it.description: ${it.description || 'NONE'}`);
              const autoDescriptionText = ((it.autoDescription || it.description || it.name) || '').trim();
              console.log(`[Shopify Export]   Using: ${autoDescriptionText.substring(0, 50)}...`);
              if (autoDescriptionText) {
                descParts.push(`<p>${escapeHtml(autoDescriptionText)}</p>`);
              }
              if (campaign.subtitle || campaign.tagline) descParts.push(campaign.subtitle || campaign.tagline);
              descParts.push('Part of our campaign.');
              // For sticker pack products, add bundle deal note
              const isStickerPackCampaign = campaign.productType === 'sticker-pack' || /^sticker-?pack$/i.test(String(it.productType || ''));
              if (isStickerPackCampaign) {
                descParts.push('<p><strong>🎉 Bundle Deal:</strong> Get 20 stickers for just $10! Simply add 20 to your cart.</p>');
              }
              // For decal products (not sticker packs), add color selection note
              else if (campaign.productType === 'decal' || /^(sticker|decal)$/i.test(String(it.productType || ''))) {
                descParts.push('<p><strong>Color:</strong> Please specify your desired vinyl color in the order notes at checkout. Available colors include a wide variety of vinyl options.</p>');
              }
              // Prefer Shopify landing page URL; fallback to Shopify collection URL; else legacy share URL
              let campaignUrl = null;
              try {
                if (campaign.shopifyPage && campaign.shopifyPage.url) {
                  campaignUrl = String(campaign.shopifyPage.url).trim();
                }
              } catch (_) {}
              if (!campaignUrl) {
                campaignUrl = collectionUrl || null;
              }
              if (!campaignUrl) {
                campaignUrl = shareUrl || null;
              }
              if (campaignUrl) descParts.push(`<p><a href="${campaignUrl}">View the full campaign</a></p>`);
              const body_html = descParts.join(' ');
              // Determine effective product type: if apparel is selected at item or campaign level,
              // force apparel (tshirt/hoodie) even if the item was initially categorized as 'sticker'.
              const hasApparel = Boolean((it.apparel && it.apparel.source) || (campaign.apparel && campaign.apparel.source));
              const ptype = hasApparel
                ? normalizeApparelProductType(it.productType || 'tshirt')
                : (/^(sticker)$/i.test(String(it.productType || '')) ? 'sticker' : normalizeApparelProductType(it.productType || 'tshirt'));
              const uidTag = it.uid ? `campaign_item_uid:${String(it.uid)}` : null;
              const campaignApparel = campaign.apparel || null;
              const effectiveApparel = it.apparel || campaignApparel || null;
              const tags = [
                `campaign:${slug}`,
                `campaign_item:${slug}:${i + 1}`,
                (ptype ? `product_type:${ptype}` : null),
                (ptype ? `category:${ptype}` : null),
                uidTag
              ].filter(Boolean).join(', ');
              const extraTagsArr = [];
              if (effectiveApparel && String(effectiveApparel.source || '').toLowerCase() === 'ssaw') {
                extraTagsArr.push('vendor:ssaw');
                if (effectiveApparel.styleID || effectiveApparel.styleId) extraTagsArr.push(`ssaw_style:${effectiveApparel.styleID || effectiveApparel.styleId}`);
                if (effectiveApparel.colorName || effectiveApparel.color) extraTagsArr.push(`color:${String(effectiveApparel.colorName || effectiveApparel.color).trim()}`);
              }
              const tagsFull = [tags].concat(extraTagsArr).filter(Boolean).join(', ');
              // Build array of images
              // For DECAL campaigns: decal first (main), mockup second
              // For APPAREL campaigns: mockup first (main), decal second (for AI recognition)
              const imageUrls = [];
              const isDecalCampaign = campaign.productType === 'decal';
              console.log(`[Image Order] Campaign productType: ${campaign.productType || 'not set'}, isDecalCampaign: ${isDecalCampaign}`);

              // Build mockup URL
              let mockupUrl = null;
              if (it.mockupImage) {
                console.log(`[Mockup URL] Item "${it.name}": mockupImage = ${it.mockupImage}`);
                console.log(`[Mockup URL] assetRoot = ${assetRoot}`);
                const url = buildPublicAssetUrl(it.mockupImage, assetRoot);
                console.log(`[Mockup URL] Built URL = ${url}`);
                if (url) {
                  mockupUrl = url.replace(/ /g, '%20');
                }
              } else {
                console.log(`[Mockup URL] Item "${it.name}": No mockupImage field`);
              }

              // Build catalog/decal image URL
              let catalogUrl = null;
              console.log(`[Catalog Image] Item "${it.name}": it.image = ${it.image || 'NONE'}`);
              if (it.image) {
                let url = buildPublicAssetUrl(it.image, assetRoot);
                console.log(`[Catalog Image] Built URL = ${url}`);
                // Use black background endpoint for catalog images to ensure white/transparent designs are visible
                // Handle both /api/library/ and /web/library/ paths
                if (url && (url.includes('/api/library/') || url.includes('/web/library/'))) {
                  url = url.replace('/api/library/', '/api/library-black-bg/');
                  url = url.replace('/web/library/', '/api/library-black-bg/');
                  console.log(`[Catalog Image] Using black-bg endpoint for catalog image: ${path.basename(it.image)}`);
                  console.log(`[Catalog Image] Black-bg URL = ${url}`);
                }
                if (url) {
                  catalogUrl = url.replace(/ /g, '%20');
                }
              } else {
                console.log(`[Catalog Image] No catalog image found for item`);
              }

              // Add images in correct order based on campaign type
              // If skipMockups is enabled for decal campaigns, only include catalog image
              if (isDecalCampaign && skipMockups) {
                // DECAL campaign with skip mockups: only catalog/decal image
                if (catalogUrl) {
                  imageUrls.push(catalogUrl);
                  console.log(`[Image Order] ✓ Added decal image ONLY (skip mockups enabled)`);
                }
              } else if (isDecalCampaign) {
                // DECAL campaign: decal image first (main), mockup second
                if (catalogUrl) {
                  imageUrls.push(catalogUrl);
                  console.log(`[Image Order] ✓ Added decal image FIRST (MAIN IMAGE)`);
                }
                if (mockupUrl) {
                  imageUrls.push(mockupUrl);
                  console.log(`[Image Order] ✓ Added mockup SECOND (SECONDARY IMAGE)`);
                }
              } else {
                // APPAREL/other campaign: mockup first (main), decal second
                if (mockupUrl) {
                  imageUrls.push(mockupUrl);
                  console.log(`[Image Order] ✓ Added mockup FIRST (MAIN IMAGE)`);
                }
                if (catalogUrl) {
                  imageUrls.push(catalogUrl);
                  console.log(`[Image Order] ✓ Added catalog image SECOND (SECONDARY IMAGE)`);
                }
              }

              // If no images yet and apparel is selected, use apparel base image
              if (imageUrls.length === 0 && effectiveApparel && effectiveApparel.imageUrl) {
                const apparelUrl = effectiveApparel.imageUrl.replace(/ /g, '%20');
                imageUrls.push(apparelUrl);
                console.log(`[Image Order] ✓ Added apparel base image as fallback`);
              }
              const imageUrl = imageUrls[0] || null; // Keep for backward compatibility
              const priceCentsRaw = Number(it.priceCents);
              // Variants
              // Check if this is a decal campaign OR item is explicitly a sticker/decal
              // Also check for sticker-pack (single-size, no-color bundle product)
              const isStickerPack = campaign.productType === 'sticker-pack' || /^sticker-?pack$/i.test(String(it.productType || ''));
              const isDecalProduct = !isStickerPack && (isDecalCampaign || /^(sticker|decal)$/i.test(String(it.productType || '')));
              const productType = isStickerPack
                ? 'sticker-pack'
                : (hasApparel && !isDecalProduct
                  ? normalizeApparelProductType(it.productType || 'tshirt')
                  : (isDecalProduct ? 'sticker' : normalizeApparelProductType(it.productType || 'tshirt')));
              let options = undefined; let finalVariants = [];
              const weight = 1; const weight_unit = 'lb'; const requires_shipping = true;
              if (/^(tshirt|hoodie|apparel)$/i.test(productType)) {
                const isSsaw = effectiveApparel && String(effectiveApparel.source || '').toLowerCase() === 'ssaw' && (effectiveApparel.styleID || effectiveApparel.styleId);
                if (isSsaw) {
                  const styleId = effectiveApparel.styleID || effectiveApparel.styleId;
                  const chosenColor = (effectiveApparel.colorName || effectiveApparel.color || '').trim();
                  // Load SSAW sizes for chosen color
                  let sizes = ['S','M','L','XL'];
                  const sizeCost = new Map();
                  try {
                    const data = await ssaw.productsByStyle(styleId);
                    const variants = Array.isArray(data?.variants) ? data.variants : [];
                    const filt = chosenColor ? variants.filter((v) => String(v.color || '').toLowerCase() === chosenColor.toLowerCase()) : variants;
                    const set = new Set();
                    for (const v of filt) {
                      const sz = String(v.size || '').toUpperCase();
                      if (!sz) continue;
                      set.add(sz);
                      const cents = Number.isFinite(Number(v.piecePriceCents)) ? Number(v.piecePriceCents) : (Number.isFinite(Number(v.piecePrice)) ? Math.round(Number(v.piecePrice) * 100) : null);
                      if (Number.isFinite(cents)) {
                        const prev = sizeCost.get(sz);
                        sizeCost.set(sz, prev == null ? cents : Math.min(prev, cents));
                      }
                    }
                    if (set.size) sizes = Array.from(set.values());
                  } catch (_) {}

                  function roundUpToQuarter(c) { const n = Math.max(0, Math.round(Number(c)||0)); const r = n % 25; return r === 0 ? n : n + (25 - r); }
                  function calcPriceFromCost(costCents) {
                    // Pricing model:
                    // (apparel cost + DTF/Vinyl ($2) + Labor ($2.67) + Overhead ($2)) * 2.5
                    // Then round UP to the nearest .00/.25/.50/.75
                    const BASE_DTF_CENTS = Number(process.env.PRICING_DTF_VINYL_CENTS || 200);
                    const BASE_LABOR_CENTS = Number(process.env.PRICING_LABOR_CENTS || 267);
                    const BASE_OVERHEAD_CENTS = Number(process.env.PRICING_OVERHEAD_CENTS || 200);
                    const MARKUP = Number(process.env.PRICING_MARKUP_MULTIPLIER || 2.5);
                    const base = Math.max(0, Number(costCents) || 0);
                    const subtotal = base + BASE_DTF_CENTS + BASE_LABOR_CENTS + BASE_OVERHEAD_CENTS;
                    const raw = subtotal * MARKUP; // in cents, may be fractional
                    const cents = Math.ceil(raw); // round up to next cent before quarter rounding
                    return roundUpToQuarter(cents);
                  }
                  // Shopify REST create expects option names only; values are derived from variant option fields
                  options = [ { name: 'Size' } ];
                  sizes.forEach((size) => {
                    const costCents = sizeCost.has(size) ? sizeCost.get(size) : null;
                    const effective = costCents != null ? calcPriceFromCost(costCents) : (Number.isFinite(priceCentsRaw) ? Math.max(priceCentsRaw, 0) : 0);
                    const price = (Number(effective) / 100).toFixed(2);
                    finalVariants.push({ option1: size, price, weight, weight_unit, _costCents: costCents || null, _size: size, _color: chosenColor || null, _stock: Number.isFinite(Number(it.stock)) ? Number(it.stock) : defaultStock });
                  });
                } else {
                  // Inventory apparel path: use in-stock inventory costs if available; do NOT use S&S costs
                  const invApparel = effectiveApparel && String(effectiveApparel.source || '').toLowerCase() === 'inventory' ? effectiveApparel : null;
                  const invSizeRaw = invApparel && invApparel.size ? String(invApparel.size).trim() : '';
                  const invColorRaw = invApparel && (invApparel.colorName || invApparel.color) ? String(invApparel.colorName || invApparel.color).trim() : '';
                  let sizes = [];
                  // If we have an inventory apparel item, derive all sizes for that product/color from inventory
                  if (invApparel && invApparel.itemId && db && typeof db.listInventoryItems === 'function') {
                    try {
                      const list = db.listInventoryItems({ material: 'apparel' }) || [];
                      const base = list.find((row) => String(row.id) === String(invApparel.itemId));
                      if (base) {
                        const matKey = String(base.material || '');
                        const colorKey = String((base.colorName || base.color || '')).toLowerCase();
                        const baseName = String(base.name || '');
                        const baseParts = baseName.split(' - ');
                        const baseStem = baseParts.length > 1 ? baseParts.slice(0, -1).join(' - ') : baseName;
                        const siblingSizes = list
                          .filter((row) => {
                            if (String(row.material || '') !== matKey) return false;
                            const rowColor = String((row.colorName || row.color || '')).toLowerCase();
                            if (rowColor !== colorKey) return false;
                            const rowName = String(row.name || '');
                            const parts = rowName.split(' - ');
                            const stem = parts.length > 1 ? parts.slice(0, -1).join(' - ') : rowName;
                            return stem === baseStem;
                          })
                          .map((row) => String(row.size || '').trim())
                          .filter(Boolean);
                        if (siblingSizes.length) {
                          sizes = Array.from(new Set(siblingSizes));
                        }
                      }
                    } catch (_) {}
                  }
                  if (!sizes.length) {
                    if (Array.isArray(it.sizes) && it.sizes.length) {
                      sizes = it.sizes.map((s) => String(s).trim());
                    } else if (invSizeRaw) {
                      sizes = [invSizeRaw];
                    } else {
                      sizes = ['S','M','L','XL'];
                    }
                  }
                  let colors = [];
                  if (Array.isArray(it.colors) && it.colors.length) {
                    colors = it.colors.map((c) => String(c).trim());
                  } else if (invColorRaw) {
                    colors = [invColorRaw];
                  } else if (it.color) {
                    colors = [String(it.color).trim()];
                  } else {
                    colors = ['Black'];
                  }
                  options = [ { name: 'Size' }, { name: 'Color' } ];
                  function roundUpToQuarter(c) { const n = Math.max(0, Math.round(Number(c)||0)); const r = n % 25; return r === 0 ? n : n + (25 - r); }
                  function calcPriceFromCost(costCents) {
                    const BASE_DTF_CENTS = Number(process.env.PRICING_DTF_VINYL_CENTS || 200);
                    const BASE_LABOR_CENTS = Number(process.env.PRICING_LABOR_CENTS || 267);
                    const BASE_OVERHEAD_CENTS = Number(process.env.PRICING_OVERHEAD_CENTS || 200);
                    const MARKUP = Number(process.env.PRICING_MARKUP_MULTIPLIER || 2.5);
                    const base = Math.max(0, Number(costCents) || 0);
                    const subtotal = base + BASE_DTF_CENTS + BASE_LABOR_CENTS + BASE_OVERHEAD_CENTS;
                    const raw = subtotal * MARKUP;
                    const cents = Math.ceil(raw);
                    return roundUpToQuarter(cents);
                  }
                  function findInventoryCostCents(ptype, size, color) {
                    // If campaign-level inventory apparel is explicitly selected, use that cost directly
                    if (campaignApparel && String(campaignApparel.source||'').toLowerCase() === 'inventory') {
                      if (Number.isFinite(Number(campaignApparel.unitCostCents))) {
                        return Math.round(Number(campaignApparel.unitCostCents));
                      }
                      if (campaignApparel.itemId && db && typeof db.getInventoryItemById === 'function') {
                        try {
                          const rec = db.getInventoryItemById(campaignApparel.itemId);
                          // mapInventoryRow exposes unitCostCents
                          if (rec && Number.isFinite(Number(rec.unitCostCents))) return Math.round(Number(rec.unitCostCents));
                        } catch (_) {}
                      }
                    }
                    try {
                      const list = db.listInventoryItems({ material: 'apparel' }) || [];
                      const typeNeedle = String(ptype || '').toLowerCase();
                      const sizeUp = String(size || '').toUpperCase();
                      const colorNeedle = String(color || '').toLowerCase();
                      let candidates = list.filter((row) => {
                        const rowName = String(row.name || '').toLowerCase();
                        const rowTypeMatch = typeNeedle === 'hoodie' ? (rowName.includes('hood') || rowName.includes('sweat')) : (rowName.includes('t-shirt') || rowName.includes('tshirt') || rowName.includes('tee') || rowName.includes('shirt'));
                        const sizeMatch = sizeUp ? String(row.size || '').toUpperCase() === sizeUp : true;
                        const colorMatch = colorNeedle ? (String((row.colorName || row.color || '')).toLowerCase().includes(colorNeedle)) : true;
                        return rowTypeMatch && sizeMatch && colorMatch && Number.isInteger(row.unitCostCents);
                      });
                      if (!candidates.length) {
                        candidates = list.filter((row) => Number.isInteger(row.unitCostCents));
                      }
                      if (!candidates.length) return null;
                      candidates.sort((a, b) => (a.unitCostCents || 0) - (b.unitCostCents || 0));
                      return candidates[0].unitCostCents || null;
                    } catch (_) { return null; }
                  }
                  sizes.forEach((size) => {
                    const invCost = findInventoryCostCents(productType, size, null);
                    const fallback = getVariantPricing(pricing, productType, size);
                    const baseCost = Number.isFinite(invCost) ? invCost : (Number.isFinite(fallback?.costCents) ? fallback.costCents : null);
                    const computed = Number.isFinite(baseCost) ? calcPriceFromCost(baseCost) : null;
                    const effectivePriceCents = Number.isFinite(computed)
                      ? computed
                      : (Number.isFinite(fallback?.priceCents) ? fallback.priceCents : (Number.isFinite(priceCentsRaw) && priceCentsRaw > 0 ? priceCentsRaw : 0));
                    const price = (Number(effectivePriceCents) / 100).toFixed(2);
                    colors.forEach((color) => {
                      const variant = {
                        option1: size,
                        option2: color,
                        price,
                        weight,
                        weight_unit,
                        _costCents: baseCost || null,
                        _size: size,
                        _color: color,
                        _stock: Number.isFinite(Number(it.stock)) ? Number(it.stock) : defaultStock
                      };
                      finalVariants.push(variant);
                    });
                  });
                }
              } else if (productType === 'sticker-pack') {
                // Sticker Pack: Single size, no color options, bundle pricing ($10 for 20 = $0.50 each)
                // No variants needed - just a simple product with quantity pricing
                const stickerPackPrice = '0.50'; // $0.50 per sticker (20 for $10)
                options = undefined; // No options, default variant only
                finalVariants = [{
                  price: stickerPackPrice,
                  weight: 0.1, // Light weight for single sticker
                  weight_unit: 'lb',
                  _costCents: 10, // Estimated 10 cents cost per sticker
                  _stock: Number.isFinite(Number(it.stock)) ? Number(it.stock) : defaultStock
                }];
                console.log(`[Variants] Sticker Pack: Single variant at $${stickerPackPrice} each (20 for $10 bundle)`);
              } else {
                if (productType === 'sticker') {
                  const sizeList = Array.isArray(it.sizes) && it.sizes.length
                    ? it.sizes.map((s) => String(s).trim()).filter(Boolean)
                    : DECAL_SIZES.slice();
                  // Get available colors for the product description/metafield
                  const inventoryColors = getRegularVinylColors();
                  let availableColors = Array.isArray(it.colors) && it.colors.length
                    ? it.colors.map((c) => String(c).trim()).filter(Boolean)
                    : inventoryColors;
                  if (!availableColors.length && inventoryColors.length) {
                    availableColors = inventoryColors.slice();
                  }
                  if (!availableColors.length) {
                    availableColors = ['White'];
                  }
                  // Option 1: Only Size as variant, Color as line item property
                  // This keeps us well under Shopify's 100 variant limit (only 7 variants for 7 sizes)
                  // Color will be selected by customer via product customization
                  options = [{ name: 'Size' }];
                  finalVariants = [];
                  sizeList.forEach((size) => {
                    const price = priceForStickerSize(size);
                    const cost = null;
                    finalVariants.push({
                      option1: size,
                      price,
                      weight,
                      weight_unit,
                      _costCents: cost,
                      _size: size,
                      _stock: Number.isFinite(Number(it.stock)) ? Number(it.stock) : defaultStock
                    });
                  });
                  // Store available colors for metafield creation later
                  it._availableColors = availableColors;
                  console.log(`[Variants] Sticker product: ${sizeList.length} size variants, ${availableColors.length} colors available via customization`);
                } else {
                  const { priceCents, costCents } = getVariantPricing(pricing, productType, null);
                  function roundUpToQuarter(c) { const n = Math.max(0, Math.round(Number(c)||0)); const r = n % 25; return r === 0 ? n : n + (25 - r); }
                  function calcPriceFromCost(costCents) {
                    const BASE_DTF_CENTS = Number(process.env.PRICING_DTF_VINYL_CENTS || 200);
                    const BASE_LABOR_CENTS = Number(process.env.PRICING_LABOR_CENTS || 267);
                    const BASE_OVERHEAD_CENTS = Number(process.env.PRICING_OVERHEAD_CENTS || 200);
                    const MARKUP = Number(process.env.PRICING_MARKUP_MULTIPLIER || 2.5);
                    const base = Math.max(0, Number(costCents) || 0);
                    const subtotal = base + BASE_DTF_CENTS + BASE_LABOR_CENTS + BASE_OVERHEAD_CENTS;
                    const raw = subtotal * MARKUP;
                    const cents = Math.ceil(raw);
                    return roundUpToQuarter(cents);
                  }
                  // For single-variant apparel (rare), prefer inventory cost when available
                  let invCostSingle = null;
                  try {
                    const list = db.listInventoryItems({ material: 'apparel' }) || [];
                    const typeNeedle = String(productType || '').toLowerCase();
                    const candidates = list.filter((row) => {
                      const rowName = String(row.name || '').toLowerCase();
                      const rowTypeMatch = typeNeedle === 'hoodie'
                        ? (rowName.includes('hood') || rowName.includes('sweat'))
                        : (rowName.includes('t-shirt') || rowName.includes('tshirt') || rowName.includes('tee') || rowName.includes('shirt'));
                      return rowTypeMatch && Number.isInteger(row.unit_cost_cents);
                    });
                    if (candidates.length) {
                      candidates.sort((a,b) => (a.unit_cost_cents||0) - (b.unit_cost_cents||0));
                      invCostSingle = candidates[0].unit_cost_cents || null;
                    }
                  } catch (_) {}
                  const baseCostSingle = Number.isFinite(invCostSingle) ? invCostSingle : (Number.isFinite(costCents) ? costCents : null);
                  const computed = Number.isFinite(baseCostSingle) ? calcPriceFromCost(baseCostSingle) : null;
                  const effectivePriceCents = Number.isFinite(computed)
                    ? computed
                    : (Number.isFinite(priceCents) ? priceCents : (Number.isFinite(priceCentsRaw) && priceCentsRaw > 0 ? priceCentsRaw : 0));
                  const price = (Number(effectivePriceCents) / 100).toFixed(2);
                  finalVariants = [{
                    price,
                    weight,
                    weight_unit,
                    _costCents: costCents || null,
                    _stock: Number.isFinite(Number(it.stock)) ? Number(it.stock) : defaultStock
                  }];
                }
              }
              // Assign POD-friendly SKUs and record artwork mapping for variants
              try {
                const podPrefixes = String(process.env.POD_SKU_PREFIXES || '').split(/[,\\s]+/).map((s) => s.trim()).filter(Boolean);
                const podEnabled = podPrefixes.length > 0;
                if (podEnabled && Array.isArray(finalVariants) && finalVariants.length) {
                  const typeKey = String(productType || '').toLowerCase();
                  let basePrefix = 'POD-';
                  if (typeKey === 'sticker' || typeKey === 'decal') {
                    basePrefix = 'DECAL-';
                  } else if (typeKey === 'tshirt' || typeKey === 'tee' || typeKey === 'hoodie' || typeKey === 'sweatshirt' || typeKey === 'apparel') {
                    basePrefix = 'APPAREL-';
                  }
                  const baseIdRaw = it.designId || it.id || it.slug || `${slug}-${i + 1}`;
                  const baseId = String(baseIdRaw).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'design';

                  let artworkPath = null;
                  try {
                    const catalog = loadCatalogSnapshot();
                    if (catalog && it.categorySlug && it.designId) {
                      const found = findDesignInCatalog(catalog, it.categorySlug, it.designId);
                      if (found && found.design && found.design.image) {
                        artworkPath = found.design.image;
                      }
                    }
                  } catch (_) {}

                  finalVariants.forEach((v) => {
                    const sizeLabel = String(v._size || v.option1 || '').toUpperCase().replace(/\\s+/g, '');
                    const colorLabel = String(v._color || v.option2 || '').toUpperCase().replace(/\\s+/g, '');
                    const skuParts = [basePrefix + baseId];
                    if (sizeLabel) skuParts.push(sizeLabel);
                    if (colorLabel) skuParts.push(colorLabel);
                    const sku = skuParts.join('-');
                    v.sku = sku;
                    if (artworkPath && typeof db.upsertArtworkForSku === 'function') {
                      try { db.upsertArtworkForSku(sku, artworkPath); } catch (_) {}
                    }
                  });
                }
              } catch (_) {}

              const apiVer = String(process.env.SHOPIFY_API_VERSION || '');
              const allowLegacyFields = apiVer === '2024-10' || apiVer.startsWith('2024-');

              // Check if we should apply compare_at_price for strikethrough pricing
              const si = campaign.salesInitiative;
              const hasPercentDiscount = si && si.type === 'percentOff' && Number(si.percentOff) > 0;
              const hasFixedDiscount = si && si.type === 'fixedOff' && Number(si.fixedAmount) > 0;
              const discountPercent = hasPercentDiscount ? Number(si.percentOff) : 0;
              const discountFixed = hasFixedDiscount ? Number(si.fixedAmount) : 0;

              const variantsForApi = (finalVariants || []).map((v) => {
                const out = {};
                const originalPrice = parseFloat(v.price || 0);

                // Apply strikethrough pricing based on promo type
                if (hasPercentDiscount && originalPrice > 0) {
                  // Percentage discount: reduce price, show original as compare_at
                  const discountedPrice = originalPrice * (1 - discountPercent / 100);
                  out.price = discountedPrice.toFixed(2);
                  out.compare_at_price = originalPrice.toFixed(2);
                } else if (hasFixedDiscount && originalPrice > discountFixed) {
                  // Fixed amount off: reduce price, show original as compare_at
                  const discountedPrice = originalPrice - discountFixed;
                  out.price = Math.max(0.01, discountedPrice).toFixed(2);
                  out.compare_at_price = originalPrice.toFixed(2);
                } else {
                  if (v.price != null) out.price = v.price;
                }

                if (v.option1) out.option1 = v.option1;
                if (v.option2) out.option2 = v.option2;
                if (v.option3) out.option3 = v.option3;
                if (v.sku) out.sku = v.sku;
                if (allowLegacyFields) {
                  if (v.weight != null) out.weight = v.weight;
                  if (v.weight_unit) out.weight_unit = v.weight_unit;
                  out.inventory_management = 'shopify';
                  out.fulfillment_service = 'manual';
                }
                return out;
              });
              // Smart idempotency: reuse existing product if shopifyProductId is set
              // Even with force=true, we should UPDATE existing products instead of creating duplicates
              let productId = Number(it.shopifyProductId) || null;
              console.log(`[Product ID] Item "${it.name}": shopifyProductId = ${it.shopifyProductId || 'NONE'}, productId = ${productId || 'NONE'}, force = ${force}`);
              let created = null;
              let existingVariants = [];

              // Always try to find existing product by tag to avoid duplicates
              // (force flag controls update behavior, not duplicate detection)
              if (!productId) {
                console.log(`[Product ID] No existing productId, checking for existing product by tag...`);
                try {
                  let found = null;
                  if (uidTag) { found = await shopify.findProductByTag(uidTag); }
                  if (!found) { found = await shopify.findProductByTag(`campaign_item:${slug}:${i + 1}`); }
                  if (found && found.id) { productId = Number(found.id); existingVariants = found.variants || []; }
                } catch (_) {}
              }

              // Log what action we'll take
              if (productId) {
                console.log(`[Product ID] Will UPDATE existing product ${productId}`);
              } else {
                console.log(`[Product ID] Will CREATE new product`);
              }
              if (!productId) {
                // Determine template suffix based on product type
                // sticker-pack uses its own simple template, decals use the decal template with color selector
                const templateSuffix = isStickerPack ? 'sticker' : ((productType === 'sticker' || isDecalProduct) ? 'decal' : '');

                // Build product payload based on API version
                let productPayload = { title, options, variants: variantsForApi };
                if (templateSuffix) productPayload.template_suffix = templateSuffix;
                if (allowLegacyFields) {
                  productPayload = {
                    title,
                    body_html,
                    vendor: 'Blue Ridge Custom Co',
                    product_type: productType,
                    tags: tagsFull,
                    status: 'active',
                    options,
                    variants: variantsForApi,
                    images: imageUrls.length ? imageUrls.map(url => ({ src: url })) : undefined
                  };
                  if (templateSuffix) productPayload.template_suffix = templateSuffix;
                }
                try {
                  console.log(`[Product Create] Attempting REST create for "${title}" with ${variantsForApi.length} variants`);
                  created = await shopify.createProduct(productPayload);
                  console.log(`[Product Create] ✓ REST create succeeded, ID: ${created?.id}`);
                  if (!allowLegacyFields) {
                    // After successful create on newer API, update remaining fields including status and template
                    const updateFields = { body_html, vendor: 'Blue Ridge Custom Co', product_type: productType, tags: tagsFull, status: 'active' };
                    if (templateSuffix) updateFields.template_suffix = templateSuffix;
                    try { await shopify.updateProduct(created.id, updateFields); } catch (_) {}
                  }
                } catch (eCreate) {
                  console.error(`[Product Create] REST create failed: ${eCreate?.message}`);
                  // Fallback 1: ultra-minimal REST create (title + variants)
                  try {
                    console.log(`[Product Create] Trying minimal REST create...`);
                    const minimal = { title, variants: variantsForApi.length ? variantsForApi : [{ price: (Number(priceCentsRaw)||0)/100 }] };
                    created = await shopify.createProduct(minimal);
                    console.log(`[Product Create] ✓ Minimal REST create succeeded, ID: ${created?.id}`);
                    const updateFields = { body_html, vendor: 'Blue Ridge Custom Co', product_type: productType, tags: tagsFull, status: 'active' };
                    if (templateSuffix) updateFields.template_suffix = templateSuffix;
                    try { await shopify.updateProduct(created.id, updateFields); } catch (_) {}
                  } catch (eRest) {
                    console.error(`[Product Create] Minimal REST failed: ${eRest?.message}`);
                    // Fallback 2: GraphQL productCreate
                    console.log(`[Product Create] Trying GraphQL create...`);
                    const gqlInput = {
                      title,
                      options: (options || []).map((o) => o && o.name ? o.name : '').filter(Boolean),
                      variants: (variantsForApi || []).map((v) => ({ price: v.price, options: [v.option1, v.option2, v.option3].filter(Boolean) }))
                    };
                    const createdGql = await shopify.createProductGraphql(gqlInput);
                    const gid = createdGql?.id || '';
                    const numericId = gid && gid.includes('/') ? Number(gid.split('/').pop()) : null;
                    created = { id: numericId || gid };
                    console.log(`[Product Create] ✓ GraphQL create succeeded, ID: ${created?.id}`);
                    // Update remaining fields via REST including status and template
                    const updateFields = { body_html, vendor: 'Blue Ridge Custom Co', product_type: productType, tags: tagsFull, status: 'active' };
                    if (templateSuffix) updateFields.template_suffix = templateSuffix;
                    try { await shopify.updateProduct(created.id, updateFields); } catch (_) {}
                  }
                }
                // If images specified, attach them after product creation to avoid strict validation on create
                if (created && created.id && imageUrls.length && !(String(process.env.SHOPIFY_API_VERSION||'') === '2024-10' || String(process.env.SHOPIFY_API_VERSION||'').startsWith('2024-'))) {
                  let imageSuccess = 0;
                  let imageFailed = 0;
                  for (const url of imageUrls) {
                    try {
                      console.log(`[Image Upload] Uploading to product ${created.id}: ${url.substring(0, 80)}...`);
                      await shopify.httpJson('POST', shopify.adminUrl(`/products/${encodeURIComponent(created.id)}/images.json`), { image: { src: url } });
                      imageSuccess++;
                      console.log(`[Image Upload] ✓ Success`);
                    } catch (err) {
                      imageFailed++;
                      console.error(`[Image Upload] ✗ Failed: ${err.message}`);
                    }
                  }
                  console.log(`[Image Upload] Product ${created.id}: ${imageSuccess} succeeded, ${imageFailed} failed out of ${imageUrls.length} total`);
                }
                productId = created?.id;
                if (productId && collectionId) { try { await shopify.addProductToCollection(productId, collectionId); } catch (_) {} }
                // Also add sticker-pack products to the main Stickers collection
                if (productId && isStickerPack) {
                  try {
                    const stickersCollection = await shopify.findCustomCollectionByTitle('Stickers');
                    if (stickersCollection && stickersCollection.id) {
                      await shopify.addProductToCollection(productId, stickersCollection.id);
                      console.log(`[Collection] Added sticker-pack product ${productId} to Stickers collection`);
                    }
                  } catch (stickerColErr) {
                    console.log(`[Collection] Could not add to Stickers collection: ${stickerColErr.message}`);
                  }
                }
                // Publish to all sales channels
                try {
                  const pubResult = await shopify.publishEverywhere(productId);
                  if (!pubResult.ok) {
                    console.warn(`[Publish] Product ${productId} publish issue: ${pubResult.error || pubResult.details}`);
                  }
                } catch (pubErr) {
                  console.error(`[Publish] Product ${productId} publish error: ${pubErr?.message}`);
                }
              }
              // If product existed, update core fields to reflect new item
              if (productId && !created) {
                console.log(`[Product Update] Updating existing product ${productId} for item "${it.name}"`);
                console.log(`[Product Update] Has ${imageUrls.length} images to update`);
                try {
                  const updatePayload = {
                    title,
                    body_html,
                    product_type: productType,
                    tags: tagsFull,
                    options,
                    variants: variantsForApi
                  };
                  if (imageUrls.length) updatePayload.images = imageUrls.map(url => ({ src: url }));
                  console.log(`[Product Update] Calling shopify.updateProduct with ${Object.keys(updatePayload).length} fields`);
                  await shopify.updateProduct(productId, updatePayload);
                  console.log(`[Product Update] ✓ Successfully updated product ${productId}`);
                  // Re-publish to all sales channels after update
                  try {
                    const pubResult = await shopify.publishEverywhere(productId);
                    if (!pubResult.ok) {
                      console.warn(`[Publish] Product ${productId} publish issue: ${pubResult.error || pubResult.details}`);
                    }
                  } catch (pubErr) {
                    console.error(`[Publish] Product ${productId} publish error: ${pubErr?.message}`);
                  }
                } catch (err) {
                  console.error(`[Product Update] ✗ Failed to update product ${productId}: ${err.message}`);
                }
              } else if (productId && created) {
                console.log(`[Product Update] Skipping update - product was just created (ID: ${productId})`);
              } else {
                console.log(`[Product Update] Skipping update - no productId set`);
              }
              // Write dynamic mockup metafields (base/overlay/params) best-effort
              // SKIP per-item mockup metafields if campaign-wide mockup mode is active
              try {
                if (productId && mockupStrategy.mode !== 'campaign') {
                  const campaignApparel = campaign.apparel || null;
                  const effectiveApparel = it.apparel || campaignApparel || null;
                  let baseUrl = null;
                  if (effectiveApparel && String(effectiveApparel.source || '').toLowerCase() === 'ssaw') {
                    baseUrl = effectiveApparel.imageUrl || null;
                  }
                  // Resolve overlay from catalog design
                  let overlayUrl = null;
                  try {
                    const catalog = loadCatalogSnapshot();
                    if (catalog && it.categorySlug && it.designId) {
                      const { design } = findDesignInCatalog(catalog, it.categorySlug, it.designId);
                      if (design && design.image) overlayUrl = buildPublicAssetUrl(design.image, assetRoot);
                    }
                  } catch (_) {}
                  const widthPct = Math.round(Number(it.mockupParams?.widthPct || 40));
                  const yOffsetPct = Math.round(Number(it.mockupParams?.yOffsetPct || 0));
                  // Decide background color: use mockupParams.bgColor if set; else if apparel color is white-ish, set light gray; else none
                  let bgColor = null;
                  try {
                    const colorName = (effectiveApparel && (effectiveApparel.colorName || effectiveApparel.color)) ? String(effectiveApparel.colorName || effectiveApparel.color) : '';
                    if (it.mockupParams && it.mockupParams.bgColor) {
                      bgColor = String(it.mockupParams.bgColor);
                    } else if (/^(white|ivory|natural|cream|bone|sand|stone|oatmeal|off\s*white)$/i.test(colorName)) {
                      bgColor = '#e5e7eb';
                    }
                  } catch (_) {}
                  const autoDescMetafield = (it.autoDescription || it.description || it.name || '').trim();
                  // For sticker products, include available colors metafield
                  const availableColorsValue = Array.isArray(it._availableColors) && it._availableColors.length
                    ? it._availableColors.join(', ')
                    : null;
                  const entries = [
                    baseUrl ? { namespace: 'mockup', key: 'base_url', type: 'url', value: String(baseUrl) } : null,
                    overlayUrl ? { namespace: 'mockup', key: 'overlay_url', type: 'url', value: String(overlayUrl) } : null,
                    { namespace: 'mockup', key: 'width_pct', type: 'number_integer', value: String(widthPct) },
                    { namespace: 'mockup', key: 'y_offset_pct', type: 'number_integer', value: String(yOffsetPct) },
                    bgColor ? { namespace: 'mockup', key: 'bg_color', type: 'single_line_text_field', value: String(bgColor) } : null,
                    { namespace: 'mockup', key: 'bg_auto', type: 'number_integer', value: '1' },
                    // Available colors for sticker/decal products (used for customization dropdown)
                    availableColorsValue ? { namespace: 'custom', key: 'available_colors', type: 'single_line_text_field', value: availableColorsValue } : null
                  ].concat(
                    autoDescMetafield
                      ? [{ namespace: 'marketing', key: 'auto_description', type: 'single_line_text_field', value: autoDescMetafield }]
                      : []
                  ).filter(Boolean);
                  for (const mf of entries) {
                    try {
                      await shopify.httpJson('POST', shopify.adminUrl(`/products/${encodeURIComponent(productId)}/metafields.json`), { metafield: mf });
                    } catch (_) {
                      // ignore create errors (may already exist)
                    }
                  }
                }
              } catch (_) {}
              // Inventory + cost per variant (default 10); also update variant prices if existing
              try {
                // Get variant list - always refresh from Shopify to ensure we have correct inventory_item_ids
                let variantsList = [];
                if (created?.variants) {
                  variantsList = created.variants.map((v) => ({ id: v.id, option1: v.option1, option2: v.option2, inventoryItemId: v.inventory_item_id }));
                } else if (productId) {
                  // Re-fetch product to get current variants with valid inventory_item_ids
                  try {
                    const refreshed = await shopify.findProductByTag(`campaign_item_uid:${uid}`);
                    if (refreshed?.variants?.length) {
                      variantsList = refreshed.variants;
                      console.log(`[Inventory] Refreshed ${variantsList.length} variants for product ${productId}`);
                    } else if (existingVariants.length) {
                      variantsList = existingVariants;
                    }
                  } catch (eRefresh) {
                    console.warn(`[Inventory] Could not refresh variants: ${eRefresh?.message}`);
                    if (existingVariants.length) variantsList = existingVariants;
                  }
                } else if (existingVariants.length) {
                  variantsList = existingVariants; // from GraphQL
                }

                // Log warning if no variants found
                if (!variantsList.length) {
                  console.warn(`[Inventory] No variants found for product ${productId} - inventory will not be set!`);
                }
                // Update price/inventory/cost
                for (const v of variantsList) {
                  let plan = finalVariants.find((p) => (!p._size || p._size === v.option1) && (!p._color || p._color === v.option2));
                  // Fallback match if the store's option order is Color/Size
                  if (!plan) {
                    plan = finalVariants.find((p) => (!p._color || p._color === v.option1) && (!p._size || p._size === v.option2));
                  }
                  if (plan && Number.isFinite(Number(plan.price))) {
                    try {
                      const cents = Math.round(Number(plan.price) * 100);
                      await shopify.updateVariantPrice(v.id, cents);
                    } catch (ePrice) {
                      try {
                        const cur = JSON.parse(fs.readFileSync(statePath, 'utf8'));
                        const errors = Array.isArray(cur.errors) ? cur.errors : [];
                        errors.push({ index: i, step: 'price', variantId: v.id, error: ePrice?.message || String(ePrice) });
                        fs.writeFileSync(statePath, JSON.stringify({ ...cur, errors: errors.slice(-20) }, null, 2));
                      } catch (_) {}
                    }
                  }
                  const invId = v.inventoryItemId || v.inventory_item_id;
                  if (invId && locationId) {
                    // Ensure tracking is enabled and variant is set to use Shopify inventory management
                    try { await shopify.updateInventoryItemTracked(invId, true); } catch (eTrk) {
                      console.warn(`[Inventory] Failed to enable tracking for ${invId}: ${eTrk?.message}`);
                      try { const cur = JSON.parse(fs.readFileSync(statePath, 'utf8')); const errors = Array.isArray(cur.errors) ? cur.errors : []; errors.push({ index: i, step: 'track', inventoryItemId: invId, error: eTrk?.message || String(eTrk) }); fs.writeFileSync(statePath, JSON.stringify({ ...cur, errors: errors.slice(-20) }, null, 2)); } catch (_) {}
                    }
                    try { if (v.id) await shopify.updateVariantInventoryManagement(v.id, 'shopify'); } catch (_) {}
                    // Ensure connection to location, then set available; fallback to adjust
                    try { await shopify.connectInventoryItemToLocation(invId, locationId); } catch (eConn) {
                      console.warn(`[Inventory] Failed to connect ${invId} to location ${locationId}: ${eConn?.message}`);
                      try { const cur = JSON.parse(fs.readFileSync(statePath, 'utf8')); const errors = Array.isArray(cur.errors) ? cur.errors : []; errors.push({ index: i, step: 'connect', inventoryItemId: invId, error: eConn?.message || String(eConn) }); fs.writeFileSync(statePath, JSON.stringify({ ...cur, errors: errors.slice(-20) }, null, 2)); } catch (_) {}
                    }
                    const desired = plan && Number.isFinite(Number(plan._stock)) ? Number(plan._stock) : defaultStock;
                    console.log(`[Inventory] Setting variant ${v.id} (invId: ${invId}) to ${desired} units at location ${locationId}`);
                    try {
                      await shopify.setInventoryLevel(invId, locationId, desired);
                      console.log(`[Inventory] ✓ Successfully set inventory for variant ${v.id} to ${desired}`);
                    }
                    catch (eSet) {
                      console.warn(`[Inventory] setInventoryLevel failed for ${invId}: ${eSet?.message}, trying adjust...`);
                      try {
                        await shopify.adjustInventoryLevel(invId, locationId, desired);
                        console.log(`[Inventory] ✓ Successfully adjusted inventory for variant ${v.id} to ${desired}`);
                      }
                      catch (eAdj) {
                        console.error(`[Inventory] ✗ Both set and adjust failed for ${invId}: ${eAdj?.message}`);
                        try { const cur = JSON.parse(fs.readFileSync(statePath, 'utf8')); const errors = Array.isArray(cur.errors) ? cur.errors : []; errors.push({ index: i, step: 'inventory', inventoryItemId: invId, error: eSet?.message || eAdj?.message || 'inventory failed', available: desired }); fs.writeFileSync(statePath, JSON.stringify({ ...cur, errors: errors.slice(-20) }, null, 2)); } catch (_) {}
                      }
                    }
                    if (plan && Number.isFinite(plan._costCents)) {
                      try { await shopify.updateInventoryItemCost(invId, plan._costCents); } catch (eCost) { try { const cur = JSON.parse(fs.readFileSync(statePath, 'utf8')); const errors = Array.isArray(cur.errors) ? cur.errors : []; errors.push({ index: i, step: 'cost', inventoryItemId: invId, error: eCost?.message || String(eCost) }); fs.writeFileSync(statePath, JSON.stringify({ ...cur, errors: errors.slice(-20) }, null, 2)); } catch (_) {} }
                    }
                  } else if (!invId) {
                    console.warn(`[Inventory] Variant ${v.id} (${v.option1}/${v.option2}) has no inventory_item_id - skipping`);
                  } else if (!locationId) {
                    console.warn(`[Inventory] No locationId available - cannot set inventory`);
                  }
                }
              } catch (eInv) {
                console.error(`[Inventory] Error in inventory block: ${eInv?.message}`);
              }
              // Inventory + cost per variant (default 10)
              try {
                const shopifyVariants = Array.isArray(created?.variants) ? created.variants : [];
                for (const v of shopifyVariants) {
                  const invId = v?.inventory_item_id;
                  if (invId && locationId) {
                    try { await shopify.updateInventoryItemTracked(invId, true); } catch (_) {}
                    try { if (v.id) await shopify.updateVariantInventoryManagement(v.id, 'shopify'); } catch (_) {}
                    let plan = finalVariants.find((p) => (!p._size || p._size === v.option1) && (!p._color || p._color === v.option2));
                    if (!plan) {
                      plan = finalVariants.find((p) => (!p._color || p._color === v.option1) && (!p._size || p._size === v.option2));
                    }
                    const desired = plan && Number.isFinite(Number(plan._stock)) ? Number(plan._stock) : defaultStock;
                    try { await shopify.setInventoryLevel(invId, locationId, desired); } catch (_) {}
                  }
                  // Ensure price is set for created variants too
                  try {
                    let plan = finalVariants.find((p) => (!p._size || p._size === v.option1) && (!p._color || p._color === v.option2));
                    if (!plan) {
                      plan = finalVariants.find((p) => (!p._color || p._color === v.option1) && (!p._size || p._size === v.option2));
                    }
                    if (plan && Number.isFinite(Number(plan.price)) && v?.id) {
                      const cents = Math.round(Number(plan.price) * 100);
                      await shopify.updateVariantPrice(v.id, cents);
                    }
                  } catch (_) {}
                  // Match plan to get cost by size/color
                  let plan = finalVariants.find((p) => (!p._size || p._size === v.option1) && (!p._color || p._color === v.option2));
                  if (!plan) {
                    plan = finalVariants.find((p) => (!p._color || p._color === v.option1) && (!p._size || p._size === v.option2));
                  }
                  if (plan && Number.isFinite(plan._costCents)) {
                    try { await shopify.updateInventoryItemCost(invId, plan._costCents); } catch (_) {}
                  }
                }
              } catch (_) {}
              // Set standardized Product Category (best-effort via GraphQL)
              try {
                const TAXO = {
                  tshirt: 'Apparel & Accessories > Clothing > Shirts & Tops > T-Shirts',
                  hoodie: 'Apparel & Accessories > Clothing > Shirts & Tops > Sweatshirts & Hoodies',
                  hat: 'Apparel & Accessories > Clothing Accessories > Hats',
                  beanie: 'Apparel & Accessories > Clothing Accessories > Hats',
                  sticker: 'Home & Garden > Decor > Decals & Stickers',
                  drinkware: 'Kitchen & Dining > Drinkware',
                  accessory: 'Apparel & Accessories > Clothing Accessories'
                };
                const catName = TAXO[ptype] || null;
                if (productId && catName) {
                  const catId = await shopify.findProductCategoryIdByName(catName).catch(() => null);
                  if (catId) { await shopify.updateProductCategory(productId, catId).catch(() => null); }
                }
              } catch (eCat) {
                try { const cur = JSON.parse(fs.readFileSync(statePath, 'utf8')); const errors = Array.isArray(cur.errors) ? cur.errors : []; errors.push({ index: i, step: 'category', error: eCat?.message || String(eCat) }); fs.writeFileSync(statePath, JSON.stringify({ ...cur, errors: errors.slice(-20) }, null, 2)); } catch (_) {}
              }
              results.push({ index: i, ok: true, productId }); ok++;
              // Persist mapping immediately to prevent re-creation on cancel/retry
              console.log(`[Product ID] Saving shopifyProductId ${productId} to campaign item ${i}`);
              try {
                campaign.items[i] = {
                  ...campaign.items[i],
                  shopifyProductId: productId,
                  mockupImage: it.mockupImage || campaign.items[i].mockupImage,
                  mockupParams: it.mockupParams || campaign.items[i].mockupParams
                };
                writeCampaignFile(slug, { ...campaign, updatedAt: new Date().toISOString() });
                console.log(`[Product ID] ✓ Saved shopifyProductId${it.mockupImage ? ' and mockup data' : ''} to campaign file`);
              } catch (err) {
                console.error(`[Product ID] ✗ Failed to save: ${err.message}`);
              }
            } catch (e) {
              const status = e && e.status ? `HTTP ${e.status}` : '';
              let detail = '';
              try { detail = e && e.detail ? (typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail)) : ''; } catch (_) {}
              const errMsg = [e?.message || String(e), status, detail ? `detail: ${String(detail).slice(0, 400)}` : '']
                .filter(Boolean)
                .join(' | ');
              results.push({ index: i, ok: false, error: errMsg }); fail++;
              // Append error sample to state
              try {
                const cur = JSON.parse(fs.readFileSync(statePath, 'utf8'));
                const errors = Array.isArray(cur.errors) ? cur.errors : [];
                const nextErrors = errors.concat([{ index: i, name: it.name || '', error: errMsg }]).slice(-20);
                fs.writeFileSync(statePath, JSON.stringify({ ...cur, errors: nextErrors }, null, 2));
              } catch (_) {}
            }
            processed++;
            // Write progress
            try {
              const cur = JSON.parse(fs.readFileSync(statePath, 'utf8'));
              fs.writeFileSync(statePath, JSON.stringify({ ...cur, jobId, slug, total, processed, ok, fail, collectionId, collectionHandle, collectionUrl, updatedAt: new Date().toISOString(), done: false }, null, 2));
            } catch (_) {
              fs.writeFileSync(statePath, JSON.stringify({ jobId, slug, total, processed, ok, fail, collectionId, collectionHandle, collectionUrl, updatedAt: new Date().toISOString(), done: false }, null, 2));
            }
            // Additional delay between items for safety
            await delay(600);
          }
          // Save updated campaign + collection link and preserve any accumulated errors in the final state
          try { writeCampaignFile(slug, { ...campaign, shopifyCollection: { id: collectionId, handle: collectionHandle, url: collectionUrl }, updatedAt: new Date().toISOString() }); } catch (_) {}

          // Create Shopify discount code if salesInitiative is configured
          let discountResult = null;
          const si = campaign.salesInitiative;
          if (si && si.type !== 'none' && si.applyToShopify !== false && collectionId) {
            try {
              console.log(`[Discount] Creating Shopify discount for campaign "${slug}", type: ${si.type}`);
              const code = si.promoCode || `${String(campaign.title || slug).toUpperCase().replace(/[^A-Z0-9]+/g, '')}-${si.type.toUpperCase()}`.slice(0, 20);
              const startsAt = si.startDate ? new Date(si.startDate).toISOString() : new Date().toISOString();
              const endsAt = si.endDate ? new Date(si.endDate).toISOString() : null;

              switch (si.type) {
                case 'percentOff':
                  discountResult = await shopify.createPercentageDiscount({
                    title: `${campaign.title || slug} - ${si.percentOff}% Off`,
                    code,
                    collectionId,
                    percentOff: si.percentOff || 15,
                    minQuantity: si.percentMinQty || 0,
                    startsAt,
                    endsAt
                  });
                  break;
                case 'fixedOff':
                  discountResult = await shopify.createFixedDiscount({
                    title: `${campaign.title || slug} - $${si.fixedAmount} Off`,
                    code,
                    collectionId,
                    amountOff: si.fixedAmount || 5,
                    minOrderAmount: si.fixedMinOrder || 0,
                    startsAt,
                    endsAt
                  });
                  break;
                case 'buyXGetY': {
                  // For Buy X Get Y with specific sizes, look up variant IDs from collection products
                  let buyVariantIds = [];
                  let freeVariantIds = [];

                  if ((si.buySize || si.freeSize) && collectionId) {
                    try {
                      console.log(`[Discount] Looking up variant IDs for sizes: buy="${si.buySize || 'any'}", free="${si.freeSize || 'same'}"`);
                      const products = await shopify.getCollectionProducts(collectionId);

                      for (const product of products) {
                        if (Array.isArray(product.variants)) {
                          for (const variant of product.variants) {
                            // Check option1/option2/option3 for size match
                            const options = [variant.option1, variant.option2, variant.option3].filter(Boolean);
                            const optionsLower = options.map(o => String(o).toLowerCase());

                            // Match buy size
                            if (si.buySize) {
                              const buySizeLower = String(si.buySize).toLowerCase();
                              if (optionsLower.some(o => o === buySizeLower || o.includes(buySizeLower))) {
                                buyVariantIds.push(variant.id);
                              }
                            }

                            // Match free size (or same as buy if not specified)
                            const freeSizeToMatch = si.freeSize || si.buySize;
                            if (freeSizeToMatch) {
                              const freeSizeLower = String(freeSizeToMatch).toLowerCase();
                              if (optionsLower.some(o => o === freeSizeLower || o.includes(freeSizeLower))) {
                                freeVariantIds.push(variant.id);
                              }
                            }
                          }
                        }
                      }

                      console.log(`[Discount] Found ${buyVariantIds.length} buy variants, ${freeVariantIds.length} free variants`);
                    } catch (lookupErr) {
                      console.error(`[Discount] Failed to look up variants: ${lookupErr.message}`);
                    }
                  }

                  discountResult = await shopify.createBuyXGetYDiscount({
                    title: si.buySize && si.freeSize
                      ? `${campaign.title || slug} - Buy ${si.buyQuantity} ${si.buySize}, Get ${si.freeQuantity} ${si.freeSize} Free`
                      : `${campaign.title || slug} - Buy ${si.buyQuantity} Get ${si.freeQuantity} Free`,
                    code,
                    collectionId,
                    buyQuantity: si.buyQuantity || 2,
                    buyVariantIds: buyVariantIds.length ? buyVariantIds : [],
                    freeQuantity: si.freeQuantity || 2,
                    freeVariantIds: freeVariantIds.length ? freeVariantIds : [],
                    startsAt,
                    endsAt,
                    oncePerCustomer: true
                  });
                  break;
                }
                case 'freeShipping':
                  discountResult = await shopify.createFreeShippingDiscount({
                    title: `${campaign.title || slug} - Free Shipping`,
                    code,
                    minOrderAmount: si.freeShipThreshold || 50,
                    startsAt,
                    endsAt
                  });
                  break;
                default:
                  console.log(`[Discount] Promo type "${si.type}" not yet supported for automatic Shopify discount`);
              }

              if (discountResult?.priceRule?.id) {
                console.log(`[Discount] Created price rule ID: ${discountResult.priceRule.id}`);
                if (discountResult.discountCode?.code) {
                  console.log(`[Discount] Created discount code: ${discountResult.discountCode.code}`);
                }
                // Update campaign with discount info
                try {
                  const updatedCampaign = readCampaign(slug);
                  if (updatedCampaign) {
                    updatedCampaign.salesInitiative = {
                      ...updatedCampaign.salesInitiative,
                      shopifyPriceRuleId: discountResult.priceRule.id,
                      shopifyDiscountId: discountResult.discountCode?.id || null,
                      shopifyDiscountCode: discountResult.discountCode?.code || null
                    };
                    writeCampaignFile(slug, updatedCampaign);
                  }
                } catch (_) {}
              }
            } catch (discountErr) {
              console.error(`[Discount] Failed to create discount: ${discountErr.message}`);
              // Don't fail the export, just log it
            }
          }

          try {
            const cur = JSON.parse(fs.readFileSync(statePath, 'utf8'));
            fs.writeFileSync(
              statePath,
              JSON.stringify({
                ...cur,
                jobId,
                slug,
                total,
                processed,
                ok,
                fail,
                collectionId,
                collectionHandle,
                collectionUrl,
                discountCode: discountResult?.discountCode?.code || null,
                priceRuleId: discountResult?.priceRule?.id || null,
                done: true,
                finishedAt: new Date().toISOString()
              }, null, 2)
            );
          } catch (_) {
            fs.writeFileSync(statePath, JSON.stringify({ jobId, slug, total, processed, ok, fail, collectionId, collectionHandle, collectionUrl, done: true, finishedAt: new Date().toISOString() }, null, 2));
          }
        } catch (err) {
          try {
            const cur = JSON.parse(fs.readFileSync(statePath, 'utf8'));
            fs.writeFileSync(
              statePath,
              JSON.stringify({
                ...cur,
                jobId,
                slug,
                total,
                processed,
                ok,
                fail,
                error: err?.message || String(err),
                done: true,
                finishedAt: new Date().toISOString()
              }, null, 2)
            );
          } catch (_) {
            fs.writeFileSync(statePath, JSON.stringify({ jobId, slug, total, processed, ok, fail, error: err?.message || String(err), done: true, finishedAt: new Date().toISOString() }, null, 2));
          }
        }
      });

      sendJson(res, 202, { success: true, jobId, slug });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Export failed.' });
    }
    return;
  }

  // Internal: Export job status
  if (
    req.method === 'GET' &&
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'marketing' &&
    segments[3] === 'shopify' &&
    segments[4] === 'export-campaign' &&
    segments[5] &&
    segments[6] === 'status'
  ) {
    if (!requireInternalKey(req, res)) return;
    try {
      const slug = sanitizeCampaignSlug(segments[5]);
      const files = fs.readdirSync(ensureExportDir()).filter((n) => n.startsWith(`export-${slug}-`) && n.endsWith('.json')).sort();
      if (!files.length) { sendJson(res, 404, { error: 'No export job found.' }); return; }
      const state = JSON.parse(fs.readFileSync(path.join(EXPORT_STATE_DIR, files[files.length - 1]), 'utf8'));
      sendJson(res, 200, { success: true, state });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to read job status.' });
    }
    return;
  }

  // Internal: Cancel export job
  if (
    req.method === 'POST' &&
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'marketing' &&
    segments[3] === 'shopify' &&
    segments[4] === 'export-campaign' &&
    segments[5] &&
    segments[6] === 'cancel'
  ) {
    if (!requireInternalKey(req, res)) return;
    try {
      const slug = sanitizeCampaignSlug(segments[5]);
      const files = fs.readdirSync(ensureExportDir()).filter((n) => n.startsWith(`export-${slug}-`) && n.endsWith('.json')).sort();
      if (!files.length) { sendJson(res, 404, { error: 'No export job found.' }); return; }
      const statePath = path.join(EXPORT_STATE_DIR, files[files.length - 1]);
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      state.cancelled = true;
      state.updatedAt = new Date().toISOString();
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
      sendJson(res, 200, { success: true });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to cancel job.' });
    }
    return;
  }

  // Internal: Shopify collections helper (requires INTERNAL_API_KEY)
  if (
    req.method === 'GET' &&
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'marketing' &&
    segments[3] === 'shopify' &&
    segments[4] === 'collections'
  ) {
    if (!requireInternalKey(req, res)) return;
    if (!shopify.isConfigured()) { sendJson(res, 503, { error: 'Shopify not configured.' }); return; }
    try {
      const title = parsedUrl.query?.title || '';
      const limit = Math.max(1, Math.min(Number(parsedUrl.query?.limit || 20), 250));
      const items = await shopify.listCollections({ title, limit });
      sendJson(res, 200, { success: true, items });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to list collections.' });
    }
    return;
  }

  // Internal: Promo/discount stats (requires INTERNAL_API_KEY)
  // GET /api/internal/marketing/shopify/promo-stats/:discountId
  if (
    req.method === 'GET' &&
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'marketing' &&
    segments[3] === 'shopify' &&
    segments[4] === 'promo-stats' &&
    segments[5]
  ) {
    if (!requireInternalKey(req, res)) return;
    if (!shopify.isConfigured()) { sendJson(res, 503, { error: 'Shopify not configured.' }); return; }
    try {
      const discountId = segments[5];
      // For now, return placeholder stats - Shopify's discount stats API is limited
      // In the future, we could query orders with this discount code
      // or use the price_rule analytics if available
      const stats = {
        discountId,
        orders: 0,
        revenue: 0,
        discountsGiven: 0,
        message: 'Stats tracking not yet implemented. Use Shopify admin for detailed analytics.'
      };
      sendJson(res, 200, { success: true, stats });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to fetch promo stats.' });
    }
    return;
  }

  // ============================================================
  // SHOPIFY MANAGER ENDPOINTS
  // ============================================================

  // GET /api/internal/shopify-manager/products
  // List all products, optionally filtered by collection
  if (
    req.method === 'GET' &&
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'shopify-manager' &&
    segments[3] === 'products'
  ) {
    if (!requireInternalKey(req, res)) return;
    if (!shopify.isConfigured()) { sendJson(res, 503, { error: 'Shopify not configured.' }); return; }
    try {
      const collectionId = parsedUrl.query?.collection_id || null;
      const limit = Math.min(Number(parsedUrl.query?.limit || 250), 250);
      const products = await shopify.listAllProducts({ limit, collection_id: collectionId });
      sendJson(res, 200, { success: true, products });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to list products.' });
    }
    return;
  }

  // GET /api/internal/shopify-manager/products/:id
  // Get single product with full details
  if (
    req.method === 'GET' &&
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'shopify-manager' &&
    segments[3] === 'products' &&
    segments[4]
  ) {
    if (!requireInternalKey(req, res)) return;
    if (!shopify.isConfigured()) { sendJson(res, 503, { error: 'Shopify not configured.' }); return; }
    try {
      const productId = segments[4];
      const product = await shopify.getProductFull(productId);
      if (!product) {
        sendJson(res, 404, { error: 'Product not found.' });
        return;
      }
      sendJson(res, 200, { success: true, product });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to get product.' });
    }
    return;
  }

  // PUT /api/internal/shopify-manager/products/:id
  // Update product
  if (
    req.method === 'PUT' &&
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'shopify-manager' &&
    segments[3] === 'products' &&
    segments[4]
  ) {
    if (!requireInternalKey(req, res)) return;
    if (!shopify.isConfigured()) { sendJson(res, 503, { error: 'Shopify not configured.' }); return; }
    try {
      const productId = segments[4];
      const body = await collectBody(req);
      const updates = JSON.parse(body);
      const result = await shopify.updateProductFull(productId, updates);
      sendJson(res, 200, { success: true, product: result?.product });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to update product.' });
    }
    return;
  }

  // PUT /api/internal/shopify-manager/variants/:id
  // Update single variant (price, compare_at_price, sku, etc.)
  if (
    req.method === 'PUT' &&
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'shopify-manager' &&
    segments[3] === 'variants' &&
    segments[4]
  ) {
    if (!requireInternalKey(req, res)) return;
    if (!shopify.isConfigured()) { sendJson(res, 503, { error: 'Shopify not configured.' }); return; }
    try {
      const variantId = segments[4];
      const body = await collectBody(req);
      const updates = JSON.parse(body);
      const result = await shopify.updateVariant(variantId, updates);
      sendJson(res, 200, { success: true, variant: result?.variant });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to update variant.' });
    }
    return;
  }

  // POST /api/internal/shopify-manager/bulk-update
  // Bulk update multiple products
  if (
    req.method === 'POST' &&
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'shopify-manager' &&
    segments[3] === 'bulk-update'
  ) {
    if (!requireInternalKey(req, res)) return;
    if (!shopify.isConfigured()) { sendJson(res, 503, { error: 'Shopify not configured.' }); return; }
    try {
      const body = await collectBody(req);
      const { productIds, operation, value, value2 } = JSON.parse(body);

      if (!productIds || !Array.isArray(productIds) || productIds.length === 0) {
        sendJson(res, 400, { error: 'productIds array is required.' });
        return;
      }

      const results = { success: 0, failed: 0, errors: [] };

      for (const productId of productIds) {
        try {
          // Get current product
          const product = await shopify.getProductFull(productId);
          if (!product) {
            results.failed++;
            results.errors.push({ productId, error: 'Product not found' });
            continue;
          }

          let updates = {};

          switch (operation) {
            case 'price_percent_off': {
              // Set compare_at_price to current price, then reduce price by %
              const pct = parseFloat(value) / 100;
              for (const v of product.variants || []) {
                const originalPrice = parseFloat(v.price);
                const newPrice = (originalPrice * (1 - pct)).toFixed(2);
                await shopify.updateVariant(v.id, {
                  price: newPrice,
                  compare_at_price: v.price
                });
              }
              break;
            }
            case 'price_increase_percent': {
              const pct = parseFloat(value) / 100;
              for (const v of product.variants || []) {
                const newPrice = (parseFloat(v.price) * (1 + pct)).toFixed(2);
                await shopify.updateVariant(v.id, { price: newPrice });
              }
              break;
            }
            case 'price_decrease_percent': {
              const pct = parseFloat(value) / 100;
              for (const v of product.variants || []) {
                const newPrice = (parseFloat(v.price) * (1 - pct)).toFixed(2);
                await shopify.updateVariant(v.id, { price: newPrice });
              }
              break;
            }
            case 'price_set_fixed': {
              const newPrice = parseFloat(value).toFixed(2);
              for (const v of product.variants || []) {
                await shopify.updateVariant(v.id, { price: newPrice });
              }
              break;
            }
            case 'inventory_set': {
              const qty = parseInt(value, 10);
              // Get first location
              const locations = await shopify.listLocations();
              const locationId = locations?.[0]?.id;
              if (locationId) {
                for (const v of product.variants || []) {
                  if (v.inventory_item_id) {
                    await shopify.setInventoryLevel(v.inventory_item_id, locationId, qty);
                  }
                }
              }
              break;
            }
            case 'inventory_adjust': {
              const delta = parseInt(value, 10);
              const locations = await shopify.listLocations();
              const locationId = locations?.[0]?.id;
              if (locationId) {
                for (const v of product.variants || []) {
                  if (v.inventory_item_id) {
                    await shopify.adjustInventoryLevel(v.inventory_item_id, locationId, delta);
                  }
                }
              }
              break;
            }
            case 'tags_add': {
              const currentTags = (product.tags || '').split(',').map(t => t.trim()).filter(Boolean);
              const newTags = value.split(',').map(t => t.trim()).filter(Boolean);
              const allTags = [...new Set([...currentTags, ...newTags])];
              updates.tags = allTags.join(', ');
              break;
            }
            case 'tags_remove': {
              const currentTags = (product.tags || '').split(',').map(t => t.trim()).filter(Boolean);
              const removeTags = value.split(',').map(t => t.trim().toLowerCase());
              const filteredTags = currentTags.filter(t => !removeTags.includes(t.toLowerCase()));
              updates.tags = filteredTags.join(', ');
              break;
            }
            case 'type_set':
              updates.product_type = value;
              break;
            case 'vendor_set':
              updates.vendor = value;
              break;
            case 'status_active':
              updates.status = 'active';
              break;
            case 'status_draft':
              updates.status = 'draft';
              break;
            case 'status_archived':
              updates.status = 'archived';
              break;
            case 'description_append':
              updates.body_html = (product.body_html || '') + value;
              break;
            case 'description_prepend':
              updates.body_html = value + (product.body_html || '');
              break;
            case 'description_replace':
              updates.body_html = (product.body_html || '').replace(new RegExp(value, 'gi'), value2 || '');
              break;
            default:
              results.failed++;
              results.errors.push({ productId, error: `Unknown operation: ${operation}` });
              continue;
          }

          if (Object.keys(updates).length > 0) {
            await shopify.updateProductFull(productId, updates);
          }

          results.success++;
          // Rate limit delay
          await new Promise(r => setTimeout(r, 300));

        } catch (err) {
          results.failed++;
          results.errors.push({ productId, error: err.message });
        }
      }

      sendJson(res, 200, { success: true, results });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Bulk update failed.' });
    }
    return;
  }

  // GET /api/internal/shopify-manager/collections
  // List all collections
  if (
    req.method === 'GET' &&
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'shopify-manager' &&
    segments[3] === 'collections' &&
    !segments[4]
  ) {
    if (!requireInternalKey(req, res)) return;
    if (!shopify.isConfigured()) { sendJson(res, 503, { error: 'Shopify not configured.' }); return; }
    try {
      const collections = await shopify.listCollections({ limit: 250 });
      sendJson(res, 200, { success: true, collections });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to list collections.' });
    }
    return;
  }

  // GET /api/internal/shopify-manager/collections/:id/products
  // Get products for a specific collection
  if (
    req.method === 'GET' &&
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'shopify-manager' &&
    segments[3] === 'collections' &&
    segments[4] &&
    segments[5] === 'products'
  ) {
    if (!requireInternalKey(req, res)) return;
    if (!shopify.isConfigured()) { sendJson(res, 503, { error: 'Shopify not configured.' }); return; }
    try {
      const collectionId = segments[4];
      const products = await shopify.getCollectionProducts(collectionId, { limit: 250 });
      sendJson(res, 200, { success: true, products });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to get collection products.' });
    }
    return;
  }

  // Internal: list captured Shopify cart webhooks (test) (requires INTERNAL_API_KEY)
  if (
    req.method === 'GET' &&
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'marketing' &&
    segments[3] === 'shopify' &&
    segments[4] === 'test' &&
    segments[5] === 'carts'
  ) {
    if (!requireInternalKey(req, res)) return;
    try {
      const list = readShopifyCartEvents();
      sendJson(res, 200, { success: true, items: list });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to read cart events.' });
    }
    return;
  }

  // Internal: clear captured Shopify cart webhooks (test) (requires INTERNAL_API_KEY)
  if (
    req.method === 'DELETE' &&
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'marketing' &&
    segments[3] === 'shopify' &&
    segments[4] === 'test' &&
    segments[5] === 'carts'
  ) {
    if (!requireInternalKey(req, res)) return;
    try {
      fs.writeFileSync(SHOPIFY_TEST_CARTS_FILE, '[]', 'utf8');
      sendJson(res, 200, { success: true });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to clear cart events.' });
    }
    return;
  }

  // Internal: Shopify publications helper (requires INTERNAL_API_KEY)
  if (
    req.method === 'GET' &&
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'marketing' &&
    segments[3] === 'shopify' &&
    segments[4] === 'publications'
  ) {
    if (!requireInternalKey(req, res)) return;
    if (!shopify.isConfigured()) { sendJson(res, 503, { error: 'Shopify not configured.' }); return; }
    try {
      const pubs = await shopify.listPublications();
      sendJson(res, 200, { success: true, publications: pubs });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to list publications.' });
    }
    return;
  }

  // Internal: Install dynamic mockup snippet in theme (requires INTERNAL_API_KEY)
  if (
    req.method === 'POST' &&
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'marketing' &&
    segments[3] === 'shopify' &&
    segments[4] === 'theme' &&
    segments[5] === 'install-mockup'
  ) {
    if (!requireInternalKey(req, res)) return;
    if (!shopify.isConfigured()) { sendJson(res, 503, { error: 'Shopify not configured.' }); return; }
    try {
      const themeId = await shopify.getMainThemeId();
      if (!themeId) { sendJson(res, 404, { error: 'No main theme found.' }); return; }
      const snippetKey = 'snippets/dynamic-mockup.liquid';
      const snippetValue = `{% comment %} Dynamic mockup canvas injected by server {% endcomment %}
<div id="dynamic-mockup"
  data-base="{{ product.metafields.mockup.base_url.value | default: product.metafields.mockup['base_url'].value | default: product.metafields.mockup.base_url | default: product.metafields.mockup['base_url'] }}"
  data-overlay="{{ product.metafields.mockup.overlay_url.value | default: product.metafields.mockup['overlay_url'].value | default: product.metafields.mockup.overlay_url | default: product.metafields.mockup['overlay_url'] }}"
  data-width="{{ product.metafields.mockup.width_pct.value | default: product.metafields.mockup['width_pct'].value | default: 40 }}"
  data-y="{{ product.metafields.mockup.y_offset_pct.value | default: product.metafields.mockup['y_offset_pct'].value | default: 0 }}"
  data-bg="{{ product.metafields.mockup.bg_color.value | default: product.metafields.mockup['bg_color'].value | default: '' }}"
  data-bgauto="{{ product.metafields.mockup.bg_auto.value | default: product.metafields.mockup['bg_auto'].value | default: 1 }}">
  <canvas id="dynamic-mockup-canvas" style="max-width:100%;height:auto"></canvas>
</div>
<script>
(function(){
  var host = document.getElementById('dynamic-mockup'); if(!host) return;
  var canvas = host.querySelector('canvas'); var ctx = canvas.getContext('2d');
  var baseUrl = host.dataset.base, overlayUrl = host.dataset.overlay;
  var widthPct = parseFloat(host.dataset.width||'40'); var yPct = parseFloat(host.dataset.y||'0');
  var bgColor = (host.dataset.bg||'').trim(); var bgAuto = (host.dataset.bgauto||'1')==='1' || (host.dataset.bgauto||'true')==='true';
  function load(src){return new Promise(function(res,rej){ var img=new Image(); img.crossOrigin='anonymous'; img.onload=function(){res(img)}; img.onerror=rej; img.src=src; });}
  function knockoutWhite(img){ try{ var off=document.createElement('canvas'); off.width=img.width; off.height=img.height; var octx=off.getContext('2d'); octx.drawImage(img,0,0); var data=octx.getImageData(0,0,off.width,off.height); var px=data.data; for(var i=0;i<px.length;i+=4){ var r=px[i],g=px[i+1],b=px[i+2]; if(r>245&&g>245&&b>245){ px[i+3]=0; } } octx.putImageData(data,0,0); var out=new Image(); out.src=off.toDataURL(); return out; }catch(e){ return img; } }
  function hasAlpha(img){ try{ var off=document.createElement('canvas'); off.width=img.width; off.height=img.height; var octx=off.getContext('2d'); octx.drawImage(img,0,0); var data=octx.getImageData(0,0,1,1).data; return data[3]!==255; }catch(e){ return false; } }
  function avgBrightness(img){ try{ var off=document.createElement('canvas'); off.width=img.width; off.height=img.height; var octx=off.getContext('2d'); octx.drawImage(img,0,0); var w=off.width, h=off.height; var sample= octx.getImageData(0,0,Math.max(4,Math.min(16,w)), Math.max(4,Math.min(16,h))).data; var sum=0,c=0; for(var i=0;i<sample.length;i+=4){ sum += (0.299*sample[i]+0.587*sample[i+1]+0.114*sample[i+2]); c++; } return c? (sum/c):255; }catch(e){ return 255; } }
  if (!baseUrl || !overlayUrl) {
    try { console.warn('Dynamic mockup: missing base or overlay URL', { baseUrl: baseUrl||'', overlayUrl: overlayUrl||'' }); } catch(_){ }
    if (canvas) { ctx.font='14px sans-serif'; ctx.fillStyle='#9ca3af'; ctx.fillText('Mockup not configured', 10, 24); }
    return;
  }
  function avgBrightnessAlphaAware(img){ try{ var off=document.createElement('canvas'); off.width=img.width; off.height=img.height; var octx=off.getContext('2d'); octx.drawImage(img,0,0); var w=off.width, h=off.height; var data=octx.getImageData(0,0,w,h).data; var sum=0,c=0; for(var i=0;i<data.length;i+=4){ var a=data[i+3]; if(a<16) continue; sum += (0.299*data[i]+0.587*data[i+1]+0.114*data[i+2]); c++; } return c? (sum/c):255; }catch(e){ return 255; } }
  function render(){ if(!baseUrl||!overlayUrl) return Promise.resolve(); return Promise.all([load(baseUrl), load(overlayUrl)]).then(function(arr){ var base=arr[0], ov=arr[1]; canvas.width=base.width; canvas.height=base.height; ctx.clearRect(0,0,canvas.width,canvas.height);
    // Fill background: explicit wins; else auto-detect using overlay then base
    var bg = (bgColor && bgColor!=='transparent') ? bgColor : '';
    if (!bg && bgAuto) {
      var b = avgBrightness(base);
      var ob = avgBrightnessAlphaAware(ov);
      if (ob > 235) { bg = '#111827'; } // very light overlay → dark bg
      else if (b > 245) { bg = '#e5e7eb'; } // very light base → light gray bg
      else if (ob < 40 && b < 60) { bg = '#f3f4f6'; } // very dark overlay on dark base → lighten
    }
    if (bg) { ctx.fillStyle=bg; ctx.fillRect(0,0,canvas.width,canvas.height); }
    ctx.drawImage(base,0,0,canvas.width,canvas.height);
    if(!hasAlpha(ov)) ov=knockoutWhite(ov);
    var overlayW=Math.round(canvas.width*(widthPct/100)); var scale=overlayW/ov.width; var overlayH=Math.round(ov.height*scale);
    var x=Math.round((canvas.width-overlayW)/2); var y=Math.round(canvas.height*0.5 + (yPct/100)*canvas.height - overlayH/2);
    // subtle shadow for contrast
    ctx.save(); ctx.shadowColor='rgba(0,0,0,0.12)'; ctx.shadowBlur=6; ctx.shadowOffsetY=2; ctx.drawImage(ov,x,y,overlayW,overlayH); ctx.restore();
  }); }
  render();
})();
</script>`;
      await shopify.putAsset(themeId, snippetKey, snippetValue);
      sendJson(res, 200, { success: true, themeId, snippet: snippetKey });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to install mockup snippet.' });
    }
    return;
  }

  // Internal: Patch product template to include dynamic mockup snippet (requires INTERNAL_API_KEY)
  if (
    req.method === 'POST' &&
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'marketing' &&
    segments[3] === 'shopify' &&
    segments[4] === 'theme' &&
    segments[5] === 'patch-product'
  ) {
    if (!requireInternalKey(req, res)) return;
    if (!shopify.isConfigured()) { sendJson(res, 503, { error: 'Shopify not configured.' }); return; }
    try {
      const themeId = await shopify.getMainThemeId();
      if (!themeId) { sendJson(res, 404, { error: 'No main theme found.' }); return; }
      // Ensure snippet exists (idempotent)
      const snippetKey = 'snippets/dynamic-mockup.liquid';
      const snippetValue = `{% render 'dynamic-mockup' %}`; // minimal check signature
      try {
        await shopify.putAsset(themeId, 'snippets/dynamic-mockup.liquid', `{% comment %} Placeholder snippet (content installed separately). {% endcomment %}`);
      } catch (_) {}

      // Try common product template locations
      const candidates = [
        'sections/main-product.liquid',
        'sections/product-template.liquid',
        'templates/product.liquid'
      ];
      let targetKey = null;
      let asset = null;
      for (const key of candidates) {
        try { asset = await shopify.getAsset(themeId, key); if (asset && asset.value) { targetKey = key; break; } } catch (_) {}
      }
      if (!targetKey || !asset || !asset.value) {
        sendJson(res, 404, { error: 'Product template not found. Please add {% render \"dynamic-mockup\" %} manually.' });
        return;
      }
      const content = String(asset.value);
      if (content.includes("render 'dynamic-mockup'") || content.includes('render "dynamic-mockup"')) {
        sendJson(res, 200, { success: true, message: 'Snippet already included.', themeId, key: targetKey });
        return;
      }
      // Insert before schema if present, else append
      const schemaIdx = content.indexOf('{% schema %}');
      let patched = '';
      const includeLine = "\n{% render 'dynamic-mockup' %}\n";
      if (schemaIdx > -1) {
        patched = content.slice(0, schemaIdx) + includeLine + content.slice(schemaIdx);
      } else {
        patched = content + includeLine;
      }
      await shopify.putAsset(themeId, targetKey, patched);
      sendJson(res, 200, { success: true, themeId, key: targetKey, inserted: true });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to patch product template.' });
    }
    return;
  }

  // Internal: Pricing sheet (get/update) requires INTERNAL_API_KEY
  if (
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'marketing' &&
    segments[3] === 'pricing'
  ) {
    if (!requireInternalKey(req, res)) return;
    try {
      if (req.method === 'GET') {
        // Determine source path
        let source = null;
        try { fs.accessSync(PRICING_FILE, fs.constants.R_OK); source = PRICING_FILE; } catch (_) {}
        if (!source) {
          try { fs.accessSync(PRICING_FALLBACK, fs.constants.R_OK); source = PRICING_FALLBACK; } catch (_) {}
        }
        const pricing = readPricingSheet();
        sendJson(res, 200, { success: true, pricing, source: source || null });
        return;
      }
      if (req.method === 'PUT') {
        collectRequestBody(req, (error, body) => {
          if (error) { sendJson(res, 413, { error: error.message }); return; }
          try {
            const json = body ? JSON.parse(body || '{}') : {};
            const pricing = json && json.pricing ? json.pricing : json;
            if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) {
              sendJson(res, 400, { error: 'Invalid pricing payload (must be an object).' }); return;
            }
            fs.mkdirSync(DATA_DIR, { recursive: true });
            fs.writeFileSync(PRICING_FILE, JSON.stringify(pricing, null, 2));
            sendJson(res, 200, { success: true, path: PRICING_FILE });
          } catch (e) {
            sendJson(res, 400, { error: e?.message || 'Invalid JSON.' });
          }
        });
        return;
      }
      sendJson(res, 405, { error: 'Method not allowed' });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Pricing endpoint failed.' });
    }
    return;
  }

  // Internal: Shopify locations helper (requires INTERNAL_API_KEY)
  if (
    req.method === 'GET' &&
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'marketing' &&
    segments[3] === 'shopify' &&
    segments[4] === 'locations'
  ) {
    if (!requireInternalKey(req, res)) return;
    if (!shopify.isConfigured()) { sendJson(res, 503, { error: 'Shopify not configured.' }); return; }
    try {
      const locs = await shopify.listLocations();
      sendJson(res, 200, { success: true, locations: locs });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to list locations.' });
    }
    return;
  }

  // Internal: Create/Update Shopify landing page for campaign (requires INTERNAL_API_KEY)
  if (
    req.method === 'POST' &&
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'marketing' &&
    segments[3] === 'shopify' &&
    segments[4] === 'campaign-refresh' &&
    segments[5]
  ) {
    if (!requireInternalKey(req, res)) return;
    if (!shopify.isConfigured()) { sendJson(res, 503, { error: 'Shopify not configured.' }); return; }
    try {
      const slug = sanitizeCampaignSlug(segments[5]);
      const campaign = readCampaign(slug);
      if (!campaign) { sendJson(res, 404, { error: 'Campaign not found.' }); return; }

      // Resolve preferred campaign URL (Shopify page > Shopify collection > legacy share)
      const shopFront = getShopifyStorefrontBase();
      let collection = campaign.shopifyCollection || null;
      if (!collection || !collection.url) {
        try {
          const found = await shopify.findCustomCollectionByTitle(campaign.title || slug);
          if (found) collection = { id: found.id, handle: found.handle, url: (found.handle && shopFront) ? `${shopFront}/collections/${found.handle}` : null };
        } catch (_) {}
      }
      const shareUrl = `${(process.env.STORE_BASE_URL || '').replace(/\/$/, '')}/web/campaign.html?c=${encodeURIComponent(slug)}`;
      const campaignUrl = (campaign.shopifyPage && campaign.shopifyPage.url)
        ? String(campaign.shopifyPage.url).trim()
        : (collection && collection.url) ? collection.url : shareUrl;

      const items = Array.isArray(campaign.items) ? campaign.items : [];
      let ok = 0, fail = 0, updated = 0;
      for (let i = 0; i < items.length; i++) {
        const it = items[i] || {};
        try {
          let productId = Number(it.shopifyProductId || it.shopify_product_id) || null;
          const uidTag = it.uid ? `campaign_item_uid:${String(it.uid)}` : null;
          if (!productId) {
            try { if (uidTag) { const p = await shopify.findProductByTag(uidTag); if (p && p.id) productId = Number(p.id); } } catch (_) {}
          }
          if (!productId) {
            const legacyTag = `campaign_item:${slug}:${i + 1}`;
            try { const p2 = await shopify.findProductByTag(legacyTag); if (p2 && p2.id) productId = Number(p2.id); } catch (_) {}
          }
          if (!productId) { fail++; continue; }

          const descParts = [];
          // Include AI-generated description from item
          const autoDescriptionText = ((it.autoDescription || it.description || it.name) || '').trim();
          if (autoDescriptionText) {
            descParts.push(`<p>${escapeHtml(autoDescriptionText)}</p>`);
          }
          if (campaign.subtitle || campaign.tagline) descParts.push(`<p>${escapeHtml(campaign.subtitle || campaign.tagline)}</p>`);
          if (campaignUrl) descParts.push(`<p><a href="${escapeHtml(campaignUrl)}">View the full campaign</a></p>`);
          const body_html = descParts.join('\n');
          await shopify.updateProduct(productId, { body_html }).catch(() => null);
          updated++; ok++;
        } catch (_) {
          fail++;
        }
      }
      try { writeCampaignFile(slug, { ...campaign, shopifyCollection: collection || campaign.shopifyCollection || null, updatedAt: new Date().toISOString() }); } catch (_) {}
      sendJson(res, 200, { success: true, updated, ok, fail, campaignUrl });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to refresh product descriptions.' });
    }
    return;
  }

  if (
    req.method === 'POST' &&
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'marketing' &&
    segments[3] === 'shopify' &&
    segments[4] === 'campaign-page' &&
    segments[5]
  ) {
    if (!requireInternalKey(req, res)) return;
    if (!shopify.isConfigured()) { sendJson(res, 503, { error: 'Shopify not configured.' }); return; }
    try {
      const slug = sanitizeCampaignSlug(segments[5]);
      const campaign = readCampaign(slug);
      if (!campaign) { sendJson(res, 404, { error: 'Campaign not found.' }); return; }
      const title = `Campaign: ${campaign.title || slug}`.trim();
      // Build body HTML with hero + items grid
      const items = Array.isArray(campaign.items) ? campaign.items : [];
      const products = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i] || {};
        const pid = it.shopifyProductId || it.shopify_product_id || null;
        if (!pid) { continue; }
        try {
          const p = await shopify.getProduct(pid);
          products.push({ id: p.id, title: p.title, handle: p.handle, image: (p.image && p.image.src) || (Array.isArray(p.images) && p.images[0]?.src) || null });
        } catch (_) {}
      }
      const shopFront = getShopifyStorefrontBase();
      const hero = campaign.hero?.image ? `<p><img alt="${escapeHtml(campaign.title || slug)}" src="${escapeHtml(buildPublicAssetUrl(campaign.hero.image, process.env.ASSET_BASE_URL || process.env.STORE_BASE_URL || ''))}" style="max-width:100%;height:auto;border-radius:8px;"/></p>` : '';
      const subtitle = campaign.subtitle ? `<p>${escapeHtml(campaign.subtitle)}</p>` : '';
      // Optional CTA to the full collection
      const collection = campaign.shopifyCollection || null;
      const collUrl = (collection && collection.url) ? collection.url : (collection && collection.handle && shopFront ? `${shopFront}/collections/${collection.handle}` : null);
      const cta = collUrl ? `<p style="margin:16px 0;"><a href="${escapeHtml(collUrl)}" style="display:inline-block;background:#111827;color:#fff;padding:10px 14px;border-radius:8px;text-decoration:none;">Shop the full collection</a></p>` : '';

      const grid = products.length
        ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:16px;">
            ${products.map((p) => `
              <a href="${shopFront ? `${shopFront}/products/${escapeHtml(p.handle)}` : `/products/${escapeHtml(p.handle)}`}" style="display:block;text-decoration:none;color:inherit;border:1px solid #eee;border-radius:8px;overflow:hidden;">
                ${p.image ? `<img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.title)}" style="width:100%;height:auto;display:block;"/>` : ''}
                <div style="padding:8px 10px;font-size:14px;">${escapeHtml(p.title)}</div>
              </a>
            `).join('')}
           </div>`
        : '<p>No products exported yet. Use "Export to Shopify" first.</p>';
      const body_html = `<div style="max-width:1000px;margin:0 auto;">${subtitle}${hero}${cta}${grid}</div>`;
      // Upsert Page by title
      let page = await shopify.findPageByTitle(title).catch(() => null);
      if (page) {
        page = await shopify.updatePage(page.id, { body_html, published: true });
      } else {
        page = await shopify.createPage({ title, body_html, published: true });
      }
      const urlPath = page?.handle ? `/pages/${page.handle}` : null;
      const shopFrontBase = getShopifyStorefrontBase();
      const urlAbs = urlPath && shopFrontBase ? `${shopFrontBase}${urlPath}` : urlPath;
      // Persist back to campaign file
      try { writeCampaignFile(slug, { ...campaign, shopifyPage: { id: page?.id, handle: page?.handle, url: urlAbs }, updatedAt: new Date().toISOString() }); } catch (_) {}
      sendJson(res, 200, { success: true, page: { id: page?.id, handle: page?.handle, url: urlAbs } });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to create landing page.' });
    }
    return;
  }

  if (
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'marketing' &&
    segments[3] === 'shopify' &&
    segments[4] === 'collection' &&
    segments[5]
  ) {
    if (!requireInternalKey(req, res)) return;
    if (!shopify.isConfigured()) { sendJson(res, 503, { error: 'Shopify not configured.' }); return; }
    const collectionId = segments[5];
    if (req.method === 'GET') {
      try {
        const meta = await shopify.getCollectionMetafields(collectionId);
        sendJson(res, 200, { success: true, metafields: meta });
      } catch (e) {
        sendJson(res, 500, { error: e?.message || 'Unable to fetch collection metafields.' });
      }
      return;
    }
    if (req.method === 'POST') {
      collectRequestBody(req, async (error, body) => {
        if (error) { sendJson(res, 413, { error: error.message }); return; }
        try {
          const payload = JSON.parse(body || '{}');
          const mp = payload.marketing_profile || {};
          await shopify.createCollectionMetafields(collectionId, mp);
          sendJson(res, 200, { success: true });
        } catch (e) {
          sendJson(res, 400, { error: e?.message || 'Unable to update collection metafields.' });
        }
      });
      return;
    }
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }

  // Internal: send SMS (requires INTERNAL_API_KEY)
  if (
    req.method === 'POST' &&
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'sms' &&
    segments[3] === 'send'
  ) {
    if (!requireInternalKey(req, res)) return;
    if (!sms.isConfigured()) { sendJson(res, 503, { error: 'SMS provider not configured.' }); return; }
    collectRequestBody(req, async (error, body) => {
      if (error) { sendJson(res, 413, { error: error.message }); return; }
      try {
        const payload = body ? JSON.parse(body || '{}') : {};
        const to = payload.to || '';
        const message = payload.message || '';
        if (!to || !message) { sendJson(res, 400, { error: 'to and message are required.' }); return; }
        const result = await sms.sendSms({ to, body: message });
        try { db.recordOutboundMessage({ provider: 'simpletexting', to, body: message, raw: { result } }); } catch (_) {}
        sendJson(res, 200, { success: true, result });
      } catch (e) {
        sendJson(res, 500, { error: e.message || 'Unable to send SMS.' });
      }
    });
    return;
  }

  // Internal: SMS test endpoint (requires INTERNAL_API_KEY)
  if (
    req.method === 'POST' &&
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'sms' &&
    segments[3] === 'test'
  ) {
    if (!requireInternalKey(req, res)) return;
    if (!sms.isConfigured()) {
      sendJson(res, 503, { error: 'SMS provider not configured.' });
      return;
    }
    collectRequestBody(req, async (error, body) => {
      if (error) { sendJson(res, 413, { error: error.message }); return; }
      try {
        const payload = body ? JSON.parse(body || '{}') : {};
        const toRaw = payload.to || '';
        const msg = String(payload.message || 'Test message from Print Station');
        const debug = Boolean(payload.debug);
        const list = toRaw
          ? [toRaw]
          : getAdminSmsRecipients();
        if (!Array.isArray(list) || !list.length) {
          sendJson(res, 400, { error: 'No destination. Provide `to` or set SMS_ADMIN_RECIPIENTS.' });
          return;
        }
        let ok = 0, fail = 0;
        const details = [];
        await Promise.all(
          list.map((recipient) =>
            sms
              .sendSms({ to: recipient, body: msg })
              .then((resp) => {
                ok++;
                details.push({ to: recipient, ok: true, response: resp || null });
              })
              .catch((e) => {
                const msg = e?.message || String(e);
                const status = e?.status || null;
                const detail = e?.detail || null;
                console.warn('Test SMS failed:', recipient, status || '', msg);
                if (detail) console.warn('Detail:', typeof detail === 'string' ? detail : JSON.stringify(detail));
                fail++;
                details.push({ to: recipient, ok: false, error: msg, status, detail });
              })
          )
        );
        const payloadOut = { success: true, sent: ok, failed: fail };
        if (debug) payloadOut.details = details;
        sendJson(res, 200, payloadOut);
      } catch (err) {
        console.error('SMS test error:', err);
        sendJson(res, 500, { error: err.message || 'SMS test failed.' });
      }
    });
    return;
  }

  if (
    req.method === 'DELETE' &&
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'orders' &&
    segments[3]
  ) {
    if (!requireInternalKey(req, res)) return;
    try {
      const id = segments[3];
      const exists = db.getOrderById(id);
      if (!exists) {
        sendJson(res, 404, { error: 'Order not found.' });
        return;
      }
      db.deleteOrder(id);
      sendJson(res, 200, { success: true });
    } catch (error) {
      console.error('Admin delete order failed:', error);
      sendJson(res, 500, { error: error.message || 'Unable to delete order.' });
    }
    return;
  }

  if (
    req.method === 'POST' &&
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'orders' &&
    segments[3] === 'cleanup'
  ) {
    if (!requireInternalKey(req, res)) return;
    collectRequestBody(req, (error, body) => {
      if (error) { sendJson(res, 413, { error: error.message }); return; }
      try {
        const payload = body ? JSON.parse(body || '{}') : {};
        const orphanOnly = !!payload.orphanOnly;
        const unpaidOnly = !!payload.unpaidOnly;
        const idPrefix = String(payload.idPrefix || '').trim();
        const olderThanDays = Number(payload.olderThanDays);
        const limit = Math.max(0, Number(payload.limit || 0));
        const cutoff = Number.isFinite(olderThanDays) && olderThanDays > 0
          ? Date.now() - olderThanDays * 24 * 60 * 60 * 1000
          : null;
        const all = db.fetchOrders();
        let targets = all.filter((o) => true);
        if (orphanOnly) targets = targets.filter((o) => !o.customerId);
        if (unpaidOnly) targets = targets.filter((o) => !o.paid && String(o.paymentStatus || '').toUpperCase() !== 'PAID');
        if (idPrefix) targets = targets.filter((o) => String(o.id || '').startsWith(idPrefix));
        if (cutoff) targets = targets.filter((o) => {
          const ts = Number(new Date(o.savedAt || 0));
          return Number.isFinite(ts) && ts < cutoff;
        });
        if (limit) targets = targets.slice(0, limit);
        targets.forEach((o) => { try { db.deleteOrder(o.id); } catch (_) {} });
        sendJson(res, 200, { success: true, deleted: targets.length });
      } catch (err) {
        console.error('Cleanup failed:', err);
        sendJson(res, 500, { error: err.message || 'Cleanup failed.' });
      }
    });
    return;
  }

  if (
    req.method === 'GET' &&
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'race-quotes'
  ) {
    if (!requireInternalKey(req, res)) return;
    try {
      if (segments[3]) {
        const quote = db.getRaceQuoteById(segments[3]);
        if (!quote) {
          sendJson(res, 404, { error: 'Quote not found.' });
          return;
        }
        const messages = db.listRaceQuoteMessages(segments[3]);
        const files = db.listRaceQuoteFiles(segments[3]).map((file) => ({
          id: file.id,
          originalName: file.originalName,
          size: file.size,
          createdAt: file.createdAt,
          url: `/api/internal/race-quotes/${encodeURIComponent(segments[3])}/files/${encodeURIComponent(file.id)}`
        }));
        sendJson(res, 200, {
          success: true,
          quote: toApiRaceQuote(quote),
          messages,
          files
        });
        return;
      }
      const statusFilter = (parsedUrl.query?.status || '').toLowerCase();
      const quotes = db.fetchAllRaceQuotes()
        .map(toApiRaceQuote)
        .filter((quote) => {
          if (!statusFilter) return true;
          return (quote.status || '').toLowerCase() === statusFilter;
        });
      sendJson(res, 200, { success: true, quotes });
    } catch (error) {
      console.error('Unable to load race quotes (internal):', error);
      sendJson(res, 500, { error: error.message || 'Unable to load race quotes.' });
    }
    return;
  }

  if (
    req.method === 'GET' &&
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'race-quotes' &&
    segments[3] &&
    segments[4] === 'files' &&
    segments[5]
  ) {
    if (!requireInternalKey(req, res)) return;
    try {
      const file = db.getRaceQuoteFileById(segments[5]);
      if (!file || file.quoteId !== segments[3]) {
        sendJson(res, 404, { error: 'File not found.' });
        return;
      }
      const filePath = buildRaceQuoteFilePath(file.quoteId, file.storedName);
      sendFileResponse(res, filePath, file.originalName, file.mimeType || undefined);
    } catch (error) {
      console.error('Unable to serve internal race quote file:', error);
      sendJson(res, 500, { error: error.message || 'Unable to download file.' });
    }
    return;
  }

  if (
    req.method === 'PATCH' &&
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'race-quotes' &&
    segments[3]
  ) {
    if (!requireInternalKey(req, res)) return;
    collectRequestBody(req, (error, body) => {
      if (error) {
        sendJson(res, 413, { error: error.message });
        return;
      }
      try {
        const payload = body ? JSON.parse(body || '{}') : {};
        const updates = sanitizeRaceQuoteAdminUpdate(payload);
        const updated = db.updateRaceQuote(segments[3], updates);
        if (!updated) {
          sendJson(res, 404, { error: 'Quote not found.' });
          return;
        }
        const apiQuote = toApiRaceQuote(updated);
        queueRaceQuoteJob(apiQuote);
        sendJson(res, 200, { success: true, quote: apiQuote });
      } catch (err) {
        console.error('Unable to update race quote (internal):', err);
        sendJson(res, 400, { error: err.message || 'Unable to update quote.' });
      }
    });
    return;
  }

  if (
    req.method === 'POST' &&
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'race-quotes' &&
    segments[3] &&
    segments[4] === 'messages'
  ) {
    if (!requireInternalKey(req, res)) return;
    collectRequestBody(req, (error, body) => {
      if (error) {
        sendJson(res, 413, { error: error.message });
        return;
      }
      try {
        const quote = db.getRaceQuoteById(segments[3]);
        if (!quote) {
          sendJson(res, 404, { error: 'Quote not found.' });
          return;
        }
        const payload = body ? JSON.parse(body || '{}') : {};
        const message = String(payload.message || '').trim();
        if (!message) {
          sendJson(res, 400, { error: 'Message text is required.' });
          return;
        }
        const record = db.createRaceQuoteMessage({
          quoteId: quote.id,
          sender: 'shop',
          message
        });
        sendJson(res, 201, { success: true, message: record });
      } catch (err) {
        console.error('Unable to create race quote message (internal):', err);
        sendJson(res, 400, { error: err.message || 'Unable to add message.' });
      }
    });
    return;
  }

  if (
    req.method === 'POST' &&
    segments[0] === 'api' &&
    segments[1] === 'customer' &&
    segments[2] === 'orders' &&
    segments[3] &&
    segments[4] === 'pay'
  ) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const order = db.getOrderById(segments[3]);
    if (!order || order.customerId !== auth.id) {
      sendJson(res, 404, { error: 'Order not found.' });
      return;
    }
    if (order.paid) {
      sendJson(res, 400, { error: 'This order is already marked as paid.' });
      return;
    }
    if (order.paymentLink) {
      sendJson(res, 200, { success: true, url: order.paymentLink });
      return;
    }
    if (!order.pricing || !Number.isFinite(order.pricing.totalCents)) {
      sendJson(res, 400, { error: 'Pricing details are missing for this order.' });
      return;
    }
    if (!squareClient) {
      sendJson(res, 503, { error: 'Square payments are not configured yet.' });
      return;
    }

    createSquarePaymentLinkForOrder(order)
      .then((paymentLink) => {
        sendJson(res, 200, { success: true, url: paymentLink?.url || null });
      })
      .catch((error) => {
        console.error('Unable to create payment link:', error);
        sendJson(res, 500, { error: error.message || 'Unable to start payment.' });
      });
    return;
  }

  // Public race quote submission (from racing page - no auth required)
  if (req.method === 'POST' && parsedUrl.pathname === '/api/race-quotes') {
    collectRequestBody(req, (error, body) => {
      if (error) {
        sendJson(res, 413, { error: error.message });
        return;
      }
      try {
        const payload = JSON.parse(body || '{}');

        // Validate email and phone are provided
        const email = String(payload.email || '').trim();
        const phone = String(payload.phone || '').trim();
        if (!email) {
          throw new Error('Email address is required.');
        }
        if (!phone) {
          throw new Error('Phone number is required.');
        }

        // Get or create customer contact
        const customer = db.upsertCustomerContact({
          name: payload.customer || payload.contactName || '',
          email: email,
          phone: phone,
          address: ''
        });

        if (!customer || !customer.id) {
          throw new Error('Unable to process customer information.');
        }

        // Sanitize and create quote
        const sanitized = sanitizeRaceQuoteRequest(payload);
        const quote = db.createRaceQuote({
          customerId: customer.id,
          ...sanitized
        });

        const apiQuote = toApiRaceQuote(quote);
        notifyAdminsOfRaceQuote(apiQuote);

        sendJson(res, 201, {
          success: true,
          quote: apiQuote
        });
      } catch (err) {
        console.error('Unable to create public race quote:', err);
        sendJson(res, 400, { error: err.message || 'Unable to submit quote request.' });
      }
    });
    return;
  }

  if (req.method === 'POST' && parsedUrl.pathname === '/api/customer/race-quotes') {
    const auth = requireAuth(req, res);
    if (!auth) return;
    collectRequestBody(req, (error, body) => {
      if (error) {
        sendJson(res, 413, { error: error.message });
        return;
      }
      try {
        const payload = JSON.parse(body || '{}');
        const sanitized = sanitizeRaceQuoteRequest(payload);
        const quote = db.createRaceQuote({
          customerId: auth.id,
          ...sanitized
        });
        const apiQuote = toApiRaceQuote(quote);
        notifyAdminsOfRaceQuote(apiQuote);
        sendJson(res, 201, {
          success: true,
          quote: apiQuote
        });
      } catch (err) {
        console.error('Unable to create race quote:', err);
        sendJson(res, 400, { error: err.message || 'Unable to submit quote request.' });
      }
    });
    return;
  }

  if (req.method === 'GET' && parsedUrl.pathname === '/api/customer/race-quotes') {
    const auth = requireAuth(req, res);
    if (!auth) return;
    try {
      const quotes = db.fetchRaceQuotesByCustomer(auth.id).map(toApiRaceQuote);
      sendJson(res, 200, { success: true, quotes });
    } catch (error) {
      console.error('Unable to load customer race quotes:', error);
      sendJson(res, 500, { error: 'Unable to load race quotes.' });
    }
    return;
  }

  if (
    req.method === 'GET' &&
    segments[0] === 'api' &&
    segments[1] === 'customer' &&
    segments[2] === 'race-quotes' &&
    segments[3]
  ) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    try {
      const quote = db.getRaceQuoteById(segments[3]);
      if (!quote || quote.customerId !== auth.id) {
        sendJson(res, 404, { error: 'Quote not found.' });
        return;
      }
      const messages = db.listRaceQuoteMessages(quote.id);
      const files = db.listRaceQuoteFiles(quote.id).map((file) => ({
        id: file.id,
        originalName: file.originalName,
        size: file.size,
        createdAt: file.createdAt,
        url: `/api/customer/race-quotes/${encodeURIComponent(quote.id)}/files/${encodeURIComponent(file.id)}`
      }));
      sendJson(res, 200, {
        success: true,
        quote: toApiRaceQuote(quote),
        messages,
        files
      });
    } catch (error) {
      console.error('Unable to load race quote detail:', error);
      sendJson(res, 500, { error: error.message || 'Unable to load race quote.' });
    }
    return;
  }

  if (
    req.method === 'GET' &&
    segments[0] === 'api' &&
    segments[1] === 'customer' &&
    segments[2] === 'race-quotes' &&
    segments[3] &&
    segments[4] === 'files' &&
    segments[5]
  ) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    try {
      const quote = db.getRaceQuoteById(segments[3]);
      if (!quote || quote.customerId !== auth.id) {
        sendJson(res, 404, { error: 'Quote not found.' });
        return;
      }
      const file = db.getRaceQuoteFileById(segments[5]);
      if (!file || file.quoteId !== quote.id) {
        sendJson(res, 404, { error: 'File not found.' });
        return;
      }
      const filePath = buildRaceQuoteFilePath(file.quoteId, file.storedName);
      sendFileResponse(res, filePath, file.originalName, file.mimeType || undefined);
    } catch (error) {
      console.error('Unable to serve race quote file:', error);
      sendJson(res, 500, { error: error.message || 'Unable to download file.' });
    }
    return;
  }

  if (
    req.method === 'POST' &&
    segments[0] === 'api' &&
    segments[1] === 'customer' &&
    segments[2] === 'race-quotes' &&
    segments[3] &&
    segments[4] === 'files'
  ) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const quote = db.getRaceQuoteById(segments[3]);
    if (!quote || quote.customerId !== auth.id) {
      sendJson(res, 404, { error: 'Quote not found.' });
      return;
    }
    parseMultipartForm(req, { maxFiles: 5, maxFileSize: 25 * 1024 * 1024 })
      .then(({ files }) => {
        const upload = listFormFiles(files.file || files.upload || files.attachment)[0];
        if (!upload || !upload.originalFilename) {
          deleteIfExists(upload?.filepath);
          sendJson(res, 400, { error: 'Choose a file to upload.' });
          return;
        }
        const tempPath = upload.filepath;
        const originalName = sanitizeCopy(upload.originalFilename, 120) || 'file';
        const sanitized = sanitizeFileName(originalName, 'attachment');
        const ext = path.extname(originalName) || '';
        const storedName = `${Date.now()}-${crypto.randomUUID()}${ext}`;
        const targetDir = getRaceQuoteFilesDir(quote.id);
        const targetPath = path.join(targetDir, storedName);
        try {
          moveFile(tempPath, targetPath);
          const stats = fs.statSync(targetPath);
          const record = db.addRaceQuoteFile({
            quoteId: quote.id,
            storedName,
            originalName: originalName,
            mimeType: upload.mimetype || determineMimeType(targetPath),
            size: stats.size
          });
          const url = `/api/customer/race-quotes/${encodeURIComponent(quote.id)}/files/${encodeURIComponent(record.id)}`;
          sendJson(res, 201, {
            success: true,
            file: {
              id: record.id,
              originalName: record.originalName,
              size: record.size,
              createdAt: record.createdAt,
              url
            }
          });
        } catch (error) {
          deleteIfExists(tempPath);
          console.error('Unable to store race quote file:', error);
          sendJson(res, 500, { error: error.message || 'Unable to upload file.' });
        }
      })
      .catch((error) => {
        console.error('Race quote file upload error:', error);
        sendJson(res, 400, { error: error.message || 'Unable to upload file.' });
      });
    return;
  }

  if (
    req.method === 'GET' &&
    segments[0] === 'api' &&
    segments[1] === 'customer' &&
    segments[2] === 'race-quotes' &&
    segments[3] &&
    segments[4] === 'messages'
  ) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    try {
      const quote = db.getRaceQuoteById(segments[3]);
      if (!quote || quote.customerId !== auth.id) {
        sendJson(res, 404, { error: 'Quote not found.' });
        return;
      }
      const messages = db.listRaceQuoteMessages(quote.id);
      sendJson(res, 200, { success: true, messages });
    } catch (error) {
      console.error('Unable to load race quote messages:', error);
      sendJson(res, 500, { error: error.message || 'Unable to load messages.' });
    }
    return;
  }

  if (
    req.method === 'POST' &&
    segments[0] === 'api' &&
    segments[1] === 'customer' &&
    segments[2] === 'race-quotes' &&
    segments[3] &&
    segments[4] === 'messages'
  ) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    collectRequestBody(req, (error, body) => {
      if (error) {
        sendJson(res, 413, { error: error.message });
        return;
      }
      try {
        const quote = db.getRaceQuoteById(segments[3]);
        if (!quote || quote.customerId !== auth.id) {
          sendJson(res, 404, { error: 'Quote not found.' });
          return;
        }
        const payload = body ? JSON.parse(body || '{}') : {};
        const message = String(payload.message || '').trim();
        if (!message) {
          sendJson(res, 400, { error: 'Message text is required.' });
          return;
        }
        const record = db.createRaceQuoteMessage({
          quoteId: quote.id,
          sender: 'customer',
          message
        });
        sendJson(res, 201, { success: true, message: record });
      } catch (err) {
        console.error('Unable to create race quote message:', err);
        sendJson(res, 400, { error: err.message || 'Unable to add message.' });
      }
    });
    return;
  }

  // ============================================================================
  // Race Designs API (Customer - authenticated)
  // ============================================================================

  // POST /api/customer/race-designs - Create new design
  if (req.method === 'POST' && parsedUrl.pathname === '/api/customer/race-designs') {
    const auth = requireAuth(req, res);
    if (!auth) return;
    collectRequestBody(req, (error, body) => {
      if (error) {
        sendJson(res, 413, { error: error.message });
        return;
      }
      try {
        const payload = JSON.parse(body || '{}');
        const design = db.createRaceDesign({
          customerId: auth.id,
          carTemplateId: payload.carTemplateId || null,
          driverInfo: payload.driverInfo || null
        });
        sendJson(res, 201, { success: true, design });
      } catch (err) {
        console.error('Unable to create race design:', err);
        sendJson(res, 400, { error: err.message || 'Unable to create design.' });
      }
    });
    return;
  }

  // GET /api/customer/race-designs - List user's designs
  if (req.method === 'GET' && parsedUrl.pathname === '/api/customer/race-designs') {
    const auth = requireAuth(req, res);
    if (!auth) return;
    try {
      const designs = db.listRaceDesignsByCustomer(auth.id);
      sendJson(res, 200, { success: true, designs });
    } catch (error) {
      console.error('Unable to load customer race designs:', error);
      sendJson(res, 500, { error: 'Unable to load designs.' });
    }
    return;
  }

  // GET /api/customer/race-designs/:id - Get specific design
  if (
    req.method === 'GET' &&
    segments[0] === 'api' &&
    segments[1] === 'customer' &&
    segments[2] === 'race-designs' &&
    segments[3]
  ) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    try {
      const design = db.getRaceDesignById(segments[3]);
      if (!design || design.customerId !== auth.id) {
        sendJson(res, 404, { error: 'Design not found.' });
        return;
      }
      sendJson(res, 200, { success: true, design });
    } catch (error) {
      console.error('Unable to load race design:', error);
      sendJson(res, 500, { error: 'Unable to load design.' });
    }
    return;
  }

  // PUT /api/customer/race-designs/:id - Update design
  if (
    req.method === 'PUT' &&
    segments[0] === 'api' &&
    segments[1] === 'customer' &&
    segments[2] === 'race-designs' &&
    segments[3]
  ) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    collectRequestBody(req, (error, body) => {
      if (error) {
        sendJson(res, 413, { error: error.message });
        return;
      }
      try {
        const design = db.getRaceDesignById(segments[3]);
        if (!design || design.customerId !== auth.id) {
          sendJson(res, 404, { error: 'Design not found.' });
          return;
        }
        const payload = JSON.parse(body || '{}');
        const updates = {};
        if (payload.carTemplateId !== undefined) updates.carTemplateId = payload.carTemplateId;
        if (payload.driverInfo !== undefined) updates.driverInfo = payload.driverInfo;
        if (payload.referencePhotos !== undefined) updates.referencePhotos = payload.referencePhotos;
        if (payload.decals !== undefined) updates.decals = payload.decals;
        if (payload.designPreview !== undefined) updates.designPreview = payload.designPreview;
        if (payload.productionSpec !== undefined) updates.productionSpec = payload.productionSpec;
        if (payload.status !== undefined) updates.status = payload.status;
        const updated = db.updateRaceDesign(design.id, updates);
        sendJson(res, 200, { success: true, design: updated });
      } catch (err) {
        console.error('Unable to update race design:', err);
        sendJson(res, 400, { error: err.message || 'Unable to update design.' });
      }
    });
    return;
  }

  // DELETE /api/customer/race-designs/:id - Delete design
  if (
    req.method === 'DELETE' &&
    segments[0] === 'api' &&
    segments[1] === 'customer' &&
    segments[2] === 'race-designs' &&
    segments[3]
  ) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    try {
      const design = db.getRaceDesignById(segments[3]);
      if (!design || design.customerId !== auth.id) {
        sendJson(res, 404, { error: 'Design not found.' });
        return;
      }
      db.deleteRaceDesign(design.id);
      sendJson(res, 200, { success: true });
    } catch (error) {
      console.error('Unable to delete race design:', error);
      sendJson(res, 500, { error: 'Unable to delete design.' });
    }
    return;
  }

  // POST /api/customer/race-designs/:id/quote - Generate quote from design
  if (
    req.method === 'POST' &&
    segments[0] === 'api' &&
    segments[1] === 'customer' &&
    segments[2] === 'race-designs' &&
    segments[3] &&
    segments[4] === 'quote'
  ) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    collectRequestBody(req, (error, body) => {
      if (error) {
        sendJson(res, 413, { error: error.message });
        return;
      }
      try {
        const design = db.getRaceDesignById(segments[3]);
        if (!design || design.customerId !== auth.id) {
          sendJson(res, 404, { error: 'Design not found.' });
          return;
        }
        const payload = JSON.parse(body || '{}');
        const driverInfo = design.driverInfo || {};

        // Build quote data from design
        const quoteData = {
          customerId: auth.id,
          business: payload.business || driverInfo.teamName || '',
          contactName: driverInfo.primaryDriver?.name || auth.name || '',
          vehicle: payload.vehicle || '',
          colors: payload.colors || '',
          packageOption: payload.packageOption || 'custom',
          addons: payload.addons || [],
          notes: payload.notes || `Design ID: ${design.id}`,
          racingBody: driverInfo.racingSeries || '',
          carNumber: driverInfo.carNumber || '',
          coDriver: driverInfo.coDriver?.name || '',
          driverCountry: driverInfo.primaryDriver?.country || '',
          coDriverCountry: driverInfo.coDriver?.country || '',
          sponsors: payload.sponsors || []
        };

        const quote = db.createRaceQuote(quoteData);

        // Link design to quote
        db.updateRaceDesign(design.id, { quoteId: quote.id, status: 'quoted' });

        // Also update quote with design reference
        db.updateRaceQuote(quote.id, { designId: design.id, designPreview: design.designPreview });

        const apiQuote = toApiRaceQuote(db.getRaceQuoteById(quote.id));
        notifyAdminsOfRaceQuote(apiQuote);

        sendJson(res, 201, { success: true, quote: apiQuote, design: db.getRaceDesignById(design.id) });
      } catch (err) {
        console.error('Unable to create quote from design:', err);
        sendJson(res, 400, { error: err.message || 'Unable to create quote.' });
      }
    });
    return;
  }

  if (
    req.method === 'POST' &&
    segments[0] === 'api' &&
    segments[1] === 'customer' &&
    segments[2] === 'race-quotes' &&
    segments[3] &&
    segments[4] === 'decision'
  ) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    collectRequestBody(req, (error, body) => {
      if (error) {
        sendJson(res, 413, { error: error.message });
        return;
      }
      try {
        const quote = db.getRaceQuoteById(segments[3]);
        if (!quote || quote.customerId !== auth.id) {
          sendJson(res, 404, { error: 'Quote not found.' });
          return;
        }
        const payload = body ? JSON.parse(body || '{}') : {};
        const decision = String(payload.decision || '').toLowerCase();
        if (!['approve', 'accept', 'decline', 'reject'].includes(decision)) {
          sendJson(res, 400, { error: 'Decision must be approve or decline.' });
          return;
        }
        const timestamp = new Date().toISOString();
        const updates = {
          customerResponse: decision.startsWith('a') ? 'accepted' : 'declined',
          customerResponseAt: timestamp,
          status: decision.startsWith('a') ? 'approved' : 'cancelled'
        };
        if (payload.notes) {
          db.createRaceQuoteMessage({
            quoteId: quote.id,
            sender: 'customer',
            message: String(payload.notes || '').trim()
          });
        }
        const updated = db.updateRaceQuote(quote.id, updates);
        const apiQuote = toApiRaceQuote(updated);
        queueRaceQuoteJob(apiQuote);
        sendJson(res, 200, { success: true, quote: apiQuote });
      } catch (err) {
        console.error('Unable to record race quote decision:', err);
        sendJson(res, 400, { error: err.message || 'Unable to record decision.' });
      }
    });
    return;
  }

  if (
    req.method === 'POST' &&
    segments[0] === 'api' &&
    segments[1] === 'customer' &&
    segments[2] === 'race-quotes' &&
    segments[3] &&
    segments[4] === 'checkout'
  ) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    try {
      const quote = db.getRaceQuoteById(segments[3]);
      if (!quote || quote.customerId !== auth.id) {
        sendJson(res, 404, { error: 'Quote not found.' });
        return;
      }
      if (!Number.isFinite(quote.totalCents) || quote.totalCents <= 0) {
        sendJson(res, 400, { error: 'A quoted total is required before checkout.' });
        return;
      }
      if (quote.paymentStatus === 'PAID') {
        sendJson(res, 400, { error: 'This quote is already paid.' });
        return;
      }
      if (!squareClient) {
        sendJson(res, 503, { error: 'Square payments are not configured yet.' });
        return;
      }
      const finalizeResponse = (current) => {
        const refreshed = current || db.getRaceQuoteById(quote.id);
        if (!refreshed?.paymentLink) {
          sendJson(res, 500, { error: 'Unable to create payment link for this quote.' });
          return;
        }
        sendJson(res, 200, {
          success: true,
          url: refreshed.paymentLink,
          quote: toApiRaceQuote(refreshed)
        });
      };

      if (!quote.paymentLink) {
        createSquarePaymentLinkForRaceQuote(quote)
          .then((link) => {
            finalizeResponse(link ? db.getRaceQuoteById(quote.id) : null);
          })
          .catch((error) => {
            console.error('Unable to start quote checkout:', error);
            sendJson(res, 500, { error: error.message || 'Unable to start checkout.' });
          });
      } else {
        finalizeResponse(quote);
      }
    } catch (error) {
      console.error('Unable to start quote checkout:', error);
      sendJson(res, 500, { error: error.message || 'Unable to start checkout.' });
    }
    return;
  }

  if (
    req.method === 'POST' &&
    segments[0] === 'api' &&
    segments[1] === 'customer' &&
    segments[2] === 'orders' &&
    segments[3] &&
    segments[4] === 'reorder'
  ) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    try {
      const order = db.getOrderById(segments[3]);
      if (!order || order.customerId !== auth.id) {
        sendJson(res, 404, { error: 'Order not found.' });
        return;
      }
      const result = duplicateOrder({ ...order, customerId: auth.id });
      sendJson(res, 201, {
        success: true,
        orderId: result.newId,
        orderNumber: result.orderNumber
      });
    } catch (error) {
      console.error('Unable to duplicate order for customer:', error);
      sendJson(res, 500, { error: error.message || 'Unable to duplicate order.' });
    }
    return;
  }

  if (
    req.method === 'PATCH' &&
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'orders' &&
    segments[3] &&
    segments[4] === 'acknowledge'
  ) {
    if (!requireInternalKey(req, res)) return;
    collectRequestBody(req, async (error, body) => {
      if (error) {
        sendJson(res, 413, { error: error.message });
        return;
      }
        try {
          const payload = body ? JSON.parse(body || '{}') : {};
          db.markOrderDownloaded(segments[3], payload.downloadedBy || null);
          const order = db.getOrderById(segments[3]);
          // Best-effort: reflect status to Shopify as "in production"
          try {
            const shop = order?.paymentDetails?.shopify || null;
            if (shop && shop.order_id && shopify.isConfigured()) {
              await shopify.addOrderTags(shop.order_id, ['in_production']).catch(() => null);
              await shopify.setOrderNoteAttributes(shop.order_id, { production_status: 'in_production' }).catch(() => null);
            }
          } catch (_) {}
          sendJson(res, 200, { success: true, order: order ? toApiOrder(order) : null });
        } catch (err) {
          console.error('Unable to acknowledge order:', err);
          sendJson(res, 500, { error: err.message || 'Unable to acknowledge order.' });
        }
      });
      return;
    }

  if (
    req.method === 'PATCH' &&
    segments[0] === 'api' &&
    segments[1] === 'internal' &&
    segments[2] === 'orders' &&
    segments[3] &&
    segments[4] === 'completed'
  ) {
    if (!requireInternalKey(req, res)) return;
    collectRequestBody(req, async (error, body) => {
      if (error) {
        sendJson(res, 413, { error: error.message });
        return;
      }
      try {
        const payload = body ? JSON.parse(body || '{}') : {};
        db.markOrderCompleted(segments[3], payload.note || '');
        const order = db.getOrderById(segments[3]);
        // If Shopify-linked, create a fulfillment for this line item (notify customer)
        try {
          const shop = order?.paymentDetails?.shopify || null;
          if (shop && shop.order_id && shop.line_item_id && shopify.isConfigured()) {
            let locationId = process.env.SHOPIFY_LOCATION_ID ? (Number(process.env.SHOPIFY_LOCATION_ID) || process.env.SHOPIFY_LOCATION_ID) : null;
            if (!locationId) {
              try { const locs = await shopify.listLocations(); locationId = locs?.[0]?.id || null; } catch (_) {}
            }
            const lineItems = [{ id: shop.line_item_id, quantity: Number(order.quantity || 1) || 1 }];
            const tracking = {
              tracking_number: payload.tracking_number || payload.trackingNumber || undefined,
              tracking_company: payload.tracking_company || payload.trackingCompany || undefined,
              tracking_url: payload.tracking_url || payload.trackingUrl || undefined
            };
            await shopify.createFulfillment({ orderId: shop.order_id, locationId, lineItems, tracking, notifyCustomer: true }).catch(() => null);
            await shopify.addOrderTags(shop.order_id, ['fulfilled']).catch(() => null);
            await shopify.setOrderNoteAttributes(shop.order_id, { production_status: 'completed' }).catch(() => null);
          }
        } catch (_) {}
        sendJson(res, 200, { success: true, order: order ? toApiOrder(order) : null });
      } catch (err) {
        console.error('Unable to mark order completed:', err);
        sendJson(res, 500, { error: err.message || 'Unable to mark order completed.' });
      }
    });
    return;
  }

  if (req.method === 'POST' && segments[0] === 'api' && segments[1] === 'orders' && segments[2] && segments[3] === 'reorder') {
    try {
      const order = db.getOrderById(segments[2]);
      if (!order) {
        sendJson(res, 404, { error: 'Order not found.' });
        return;
      }
      const result = duplicateOrder(order);
      sendJson(res, 201, {
        success: true,
        orderId: result.newId,
        orderNumber: result.orderNumber
      });
    } catch (error) {
      console.error('Unable to duplicate order:', error);
      sendJson(res, 500, { error: error.message || 'Unable to duplicate order.' });
    }
    return;
  }

  if (req.method === 'POST' && segments[0] === 'api' && segments[1] === 'webhooks' && segments[2] === 'square') {
    handleSquareWebhook(req, res);
    return;
  }

  if (req.method === 'GET' && segments[0] === 'files' && segments[1] === 'saved' && segments[2]) {
    const fileName = decodeURIComponent(segments.slice(2).join('/'));
    serveSavedFile(res, fileName);
    return;
  }

  // Serve library assets with black background (for transparent images)
  if ((req.method === 'GET' || req.method === 'HEAD') && segments[0] === 'api' && segments[1] === 'library-black-bg' && segments.length > 2) {
    const assetPath = decodeURIComponent(segments.slice(2).join('/'));
    serveLibraryAssetWithBlackBg(req, res, assetPath);
    return;
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && segments[0] === 'api' && segments[1] === 'library' && segments.length > 2) {
    const assetPath = decodeURIComponent(segments.slice(2).join('/'));
    serveLibraryAsset(req, res, assetPath);
    return;
  }

  if (
    req.method === 'POST' &&
    segments[0] === 'api' &&
    segments[1] === 'orders' &&
    segments[2] &&
    segments[3] === 'checkout'
  ) {
    const orderId = segments[2];
    try {
      const order = db.getOrderById(orderId);
      if (!order) {
        sendJson(res, 404, { error: 'Order not found.' });
        return;
      }
      if (order.paid) {
        sendJson(res, 400, { error: 'This order is already marked as paid.' });
        return;
      }
      const pricing = order.pricing || null;
      if (!pricing || !Number.isFinite(pricing.totalCents) || pricing.totalCents <= 0) {
        sendJson(res, 400, { error: 'Pricing details are required before collecting payment.' });
        return;
      }

      const finalizeResponse = (current) => {
        const updatedOrder = current || db.getOrderById(orderId);
        const url = updatedOrder?.paymentLink || null;
        if (!url) {
          sendJson(res, 500, { error: 'Payment link unavailable.' });
          return;
        }
        sendJson(res, 200, {
          success: true,
          url,
          order: updatedOrder ? toApiOrder(updatedOrder) : null
        });
      };

      if (!order.paymentLink) {
        createSquarePaymentLinkForOrder(order)
          .then((link) => {
            if (!link?.url) {
              sendJson(res, 500, { error: 'Unable to create payment link.' });
              return;
            }
            finalizeResponse(db.getOrderById(orderId));
          })
          .catch((error) => {
            console.error('Unable to generate checkout link:', error);
            const message = error?.message || 'Unable to start checkout.';
            const status =
              message && message.toLowerCase().includes('square integration not configured')
                ? 503
                : 500;
            sendJson(res, status, { error: message });
          });
        return;
      }

      finalizeResponse(order);
    } catch (error) {
      console.error('Unable to generate checkout link:', error);
      const message = error?.message || 'Unable to start checkout.';
      const status =
        message && message.toLowerCase().includes('square integration not configured') ? 503 : 500;
      sendJson(res, status, { error: message });
    }
    return;
  }

  // Serve index.html for root path
  if (
    (req.method === 'GET' || req.method === 'HEAD') &&
    (parsedUrl.pathname === '/' || parsedUrl.pathname === '')
  ) {
    serveWebAsset(req, res, 'index.html');
    return;
  }

  if (
    (req.method === 'GET' || req.method === 'HEAD') &&
    (parsedUrl.pathname === '/kiosk' || parsedUrl.pathname === '/kiosk.html')
  ) {
    serveWebAsset(req, res, 'kiosk.html');
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    let decodedSegments;
    try {
      decodedSegments = segments.map((segment) => decodeURIComponent(segment));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Invalid request path');
      return;
    }

    if (decodedSegments[0] === 'web') {
      const assetPath = decodedSegments.slice(1).join('/');
      serveWebAsset(req, res, assetPath);
      return;
    }

    if (shouldServeLibraryAsset(decodedSegments)) {
      const assetPath = decodedSegments.join('/');
      serveLibraryAsset(req, res, assetPath);
      return;
    }
  }

  // ============================================================================
  // CUSTOM ART API ENDPOINTS
  // ============================================================================

  // --- ROOMS ---
  if (req.method === 'GET' && parsedUrl.pathname === '/api/custom-art/rooms') {
    if (!requireInternalKey(req, res)) return;
    try {
      const activeOnly = parsedUrl.query?.activeOnly !== 'false';
      const roomType = parsedUrl.query?.roomType || null;
      const rooms = db.listCustomArtRooms({ activeOnly, roomType });
      sendJson(res, 200, { success: true, rooms });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to list rooms.' });
    }
    return;
  }

  if (req.method === 'GET' && segments[0] === 'api' && segments[1] === 'custom-art' && segments[2] === 'rooms' && segments[3]) {
    if (!requireInternalKey(req, res)) return;
    try {
      const room = db.getCustomArtRoomById(segments[3]);
      if (!room) {
        sendJson(res, 404, { error: 'Room not found.' });
        return;
      }
      sendJson(res, 200, { success: true, room });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to get room.' });
    }
    return;
  }

  if (req.method === 'POST' && parsedUrl.pathname === '/api/custom-art/rooms') {
    if (!requireInternalKey(req, res)) return;
    try {
      const body = await getReqBodyJson(req);
      if (!body || !body.title || !body.imagePath) {
        sendJson(res, 400, { error: 'title and imagePath are required.' });
        return;
      }
      const room = db.createCustomArtRoom({
        title: body.title,
        roomType: body.roomType || null,
        description: body.description || null,
        tags: body.tags || null,
        imagePath: body.imagePath,
        thumbnailPath: body.thumbnailPath || null,
        active: body.active !== false // Default to active
      });
      sendJson(res, 200, { success: true, room });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to create room.' });
    }
    return;
  }

  if (req.method === 'PATCH' && segments[0] === 'api' && segments[1] === 'custom-art' && segments[2] === 'rooms' && segments[3]) {
    if (!requireInternalKey(req, res)) return;
    try {
      const existing = db.getCustomArtRoomById(segments[3]);
      if (!existing) {
        sendJson(res, 404, { error: 'Room not found.' });
        return;
      }
      const body = await getReqBodyJson(req);
      const room = db.updateCustomArtRoom(segments[3], body);
      sendJson(res, 200, { success: true, room });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to update room.' });
    }
    return;
  }

  if (req.method === 'DELETE' && segments[0] === 'api' && segments[1] === 'custom-art' && segments[2] === 'rooms' && segments[3]) {
    if (!requireInternalKey(req, res)) return;
    try {
      db.deleteCustomArtRoom(segments[3]);
      sendJson(res, 200, { success: true });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to delete room.' });
    }
    return;
  }

  // AI Metadata generation for rooms
  if (req.method === 'POST' && segments[0] === 'api' && segments[1] === 'custom-art' && segments[2] === 'rooms' && segments[3] === 'ai-metadata') {
    console.log('[Room AI Metadata] Endpoint called');
    if (!requireInternalKey(req, res)) return;
    try {
      const body = await getReqBodyJson(req);
      const imageBase64 = body?.imageBase64;
      const mediaType = body?.mediaType || 'image/jpeg';

      if (!imageBase64) {
        sendJson(res, 400, { error: 'No image data provided. Please provide imageBase64 in request body.' });
        return;
      }

      // Use Claude to analyze the room image
      const anthropicKey = process.env.ANTHROPIC_API_KEY;
      if (!anthropicKey) {
        sendJson(res, 500, { error: 'AI service not configured (ANTHROPIC_API_KEY missing).' });
        return;
      }

      const roomTypeOptions = ['living-room', 'bedroom', 'office', 'dining-room', 'hallway', 'bathroom', 'kitchen', 'other'];

      const prompt = `Analyze this room image and provide metadata for a mockup generator. Return a JSON object with these fields:
- title: A short, descriptive title for this room setting (e.g., "Modern Minimalist Living Room", "Cozy Bedroom with Natural Light")
- description: A 2-3 sentence description of the room's style, lighting, and atmosphere
- roomType: One of these values EXACTLY: ${roomTypeOptions.join(', ')}
- tags: Comma-separated keywords describing the room's style, colors, and features (e.g., "modern, minimalist, white walls, natural light, wooden floor")

Return ONLY valid JSON, no markdown or explanation.`;

      const anthropicRes = await new Promise((resolve, reject) => {
        const postData = JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1024,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
              { type: 'text', text: prompt }
            ]
          }]
        });

        const options = {
          hostname: 'api.anthropic.com',
          port: 443,
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': anthropicKey,
            'anthropic-version': '2023-06-01',
            'Content-Length': Buffer.byteLength(postData)
          }
        };

        const req = https.request(options, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error('Failed to parse AI response'));
            }
          });
        });
        req.on('error', reject);
        req.write(postData);
        req.end();
      });

      // Extract text from Claude response
      const responseText = anthropicRes?.content?.[0]?.text || '';
      console.log('[Room AI Metadata] Claude response:', responseText);

      // Parse the JSON from response
      let metadata = {};
      try {
        // Try to extract JSON from response (handle potential markdown wrapping)
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          metadata = JSON.parse(jsonMatch[0]);
        }
      } catch (parseErr) {
        console.error('[Room AI Metadata] JSON parse error:', parseErr);
        sendJson(res, 500, { error: 'Failed to parse AI response as JSON.' });
        return;
      }

      // Validate roomType is one of our options
      if (metadata.roomType && !roomTypeOptions.includes(metadata.roomType)) {
        metadata.roomType = 'other';
      }

      sendJson(res, 200, { success: true, metadata });
    } catch (e) {
      console.error('[Room AI Metadata] Error:', e);
      sendJson(res, 500, { error: e?.message || 'Unable to generate room AI metadata.' });
    }
    return;
  }

  // --- ARTWORK ---
  if (req.method === 'GET' && parsedUrl.pathname === '/api/custom-art/artwork') {
    if (!requireInternalKey(req, res)) return;
    try {
      const activeOnly = parsedUrl.query?.activeOnly !== 'false';
      const status = parsedUrl.query?.status || null;
      const category = parsedUrl.query?.category || null;
      const search = parsedUrl.query?.search || null;
      const limit = Number(parsedUrl.query?.limit) || 100;
      const offset = Number(parsedUrl.query?.offset) || 0;
      console.log('[Custom Art API] listArtwork query:', { activeOnly, status, category, search, limit, offset, rawActiveOnly: parsedUrl.query?.activeOnly });
      const artwork = db.listCustomArtArtwork({ activeOnly, status, category, search, limit, offset });
      console.log('[Custom Art API] listArtwork returned', artwork?.length || 0, 'items');
      sendJson(res, 200, { success: true, artwork });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to list artwork.' });
    }
    return;
  }

  if (req.method === 'GET' && parsedUrl.pathname === '/api/custom-art/artwork/categories') {
    if (!requireInternalKey(req, res)) return;
    try {
      const categories = db.listCustomArtArtworkCategories();
      sendJson(res, 200, { success: true, categories });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to list categories.' });
    }
    return;
  }

  if (req.method === 'GET' && segments[0] === 'api' && segments[1] === 'custom-art' && segments[2] === 'artwork' && segments[3] && segments[3] !== 'categories') {
    if (!requireInternalKey(req, res)) return;
    try {
      const artwork = db.getCustomArtArtworkById(segments[3]);
      if (!artwork) {
        sendJson(res, 404, { error: 'Artwork not found.' });
        return;
      }
      sendJson(res, 200, { success: true, artwork });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to get artwork.' });
    }
    return;
  }

  if (req.method === 'POST' && parsedUrl.pathname === '/api/custom-art/artwork') {
    if (!requireInternalKey(req, res)) return;
    try {
      const body = await getReqBodyJson(req);
      if (!body || !body.title || !body.filePath) {
        sendJson(res, 400, { error: 'title and filePath are required.' });
        return;
      }
      const artwork = db.createCustomArtArtwork({
        title: body.title,
        description: body.description || null,
        tags: body.tags || null,
        category: body.category || null,
        style: body.style || null,
        dimensionsWidth: body.dimensionsWidth || body.dimensions?.width || null,
        dimensionsHeight: body.dimensionsHeight || body.dimensions?.height || null,
        dimensionsUnit: body.dimensionsUnit || body.dimensions?.unit || 'inches',
        filePath: body.filePath,
        optimizedPath: body.optimizedPath || null,
        thumbnailPath: body.thumbnailPath || null,
        status: body.status || 'draft'
      });
      sendJson(res, 200, { success: true, artwork });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to create artwork.' });
    }
    return;
  }

  if (req.method === 'PATCH' && segments[0] === 'api' && segments[1] === 'custom-art' && segments[2] === 'artwork' && segments[3]) {
    if (!requireInternalKey(req, res)) return;
    try {
      const existing = db.getCustomArtArtworkById(segments[3]);
      if (!existing) {
        sendJson(res, 404, { error: 'Artwork not found.' });
        return;
      }
      const body = await getReqBodyJson(req);
      // Handle nested dimensions object
      if (body.dimensions) {
        if (body.dimensions.width !== undefined) body.dimensionsWidth = body.dimensions.width;
        if (body.dimensions.height !== undefined) body.dimensionsHeight = body.dimensions.height;
        if (body.dimensions.unit !== undefined) body.dimensionsUnit = body.dimensions.unit;
      }
      const artwork = db.updateCustomArtArtwork(segments[3], body);
      sendJson(res, 200, { success: true, artwork });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to update artwork.' });
    }
    return;
  }

  if (req.method === 'DELETE' && segments[0] === 'api' && segments[1] === 'custom-art' && segments[2] === 'artwork' && segments[3]) {
    if (!requireInternalKey(req, res)) return;
    try {
      db.deleteCustomArtArtwork(segments[3]);
      sendJson(res, 200, { success: true });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to delete artwork.' });
    }
    return;
  }

  // AI Metadata generation for artwork
  if (req.method === 'POST' && segments[0] === 'api' && segments[1] === 'custom-art' && segments[2] === 'artwork' && segments[3] && segments[4] === 'ai-metadata') {
    console.log('[AI Metadata] Endpoint called for artwork:', segments[3]);
    if (!requireInternalKey(req, res)) return;
    try {
      const artworkId = segments[3];
      const body = await getReqBodyJson(req);
      console.log('[AI Metadata] Looking up artwork:', artworkId, 'hasImageBase64:', !!body?.imageBase64);

      const artwork = db.getCustomArtArtworkById(artworkId);
      if (!artwork) {
        sendJson(res, 404, { error: 'Artwork not found.' });
        return;
      }

      // Check if we have base64 image from client or need to find file on server
      let imagePath = null;
      let imageBase64 = body?.imageBase64;
      let mediaType = body?.mediaType || 'image/jpeg';

      if (!imageBase64 && artwork.filePath) {
        // Try to find file on server (for server-side uploaded images)
        const webPath = path.resolve(__dirname, '..', 'web', artwork.filePath.replace(/^\//, ''));
        if (fs.existsSync(webPath)) {
          imagePath = webPath;
        } else if (fs.existsSync(artwork.filePath)) {
          imagePath = artwork.filePath;
        }
      }

      if (!imageBase64 && !imagePath) {
        console.log('[AI Metadata] ERROR: No image data provided and file not found on server');
        sendJson(res, 400, { error: 'No image data provided. Please provide imageBase64 in request body.' });
        return;
      }

      // Generate AI metadata (description + filename)
      console.log('[AI Metadata] Calling describeCatalogDesign, hasBase64:', !!imageBase64, 'imagePath:', imagePath);
      const aiResult = await describeCatalogDesign({
        category: artwork.category || '',
        fileName: artwork.title || 'artwork',
        imagePath: imagePath,
        imageBase64: imageBase64,
        mediaType: mediaType
      });
      console.log('[AI Metadata] Generated result:', aiResult);

      if (!aiResult || (!aiResult.description && !aiResult.filename)) {
        sendJson(res, 500, { error: 'AI metadata generation failed or not configured.' });
        return;
      }

      // Build update object with description and seoFilename
      const updates = {};
      if (aiResult.description) updates.description = aiResult.description;
      if (aiResult.filename) updates.seoFilename = aiResult.filename;

      // Update the artwork with the generated metadata
      console.log('[AI Metadata] Saving to artwork:', artworkId, updates);
      const updated = db.updateCustomArtArtwork(artworkId, updates);
      console.log('[AI Metadata] Updated artwork - description:', updated?.description, 'seoFilename:', updated?.seoFilename);
      sendJson(res, 200, { success: true, artwork: updated, generatedDescription: aiResult.description, generatedFilename: aiResult.filename });
    } catch (e) {
      console.error('AI metadata error:', e);
      sendJson(res, 500, { error: e?.message || 'Unable to generate AI metadata.' });
    }
    return;
  }

  // --- HUMAN MODELS ---
  if (req.method === 'GET' && parsedUrl.pathname === '/api/human-models') {
    if (!requireInternalKey(req, res)) return;
    try {
      const activeOnly = parsedUrl.query?.activeOnly !== 'false';
      const status = parsedUrl.query?.status || null;
      const category = parsedUrl.query?.category || null;
      const gender = parsedUrl.query?.gender || null;
      const search = parsedUrl.query?.search || null;
      const limit = Number(parsedUrl.query?.limit) || 100;
      const offset = Number(parsedUrl.query?.offset) || 0;
      const models = db.listHumanModels({ activeOnly, status, category, gender, search, limit, offset });
      sendJson(res, 200, { success: true, models });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to list human models.' });
    }
    return;
  }

  if (req.method === 'GET' && parsedUrl.pathname === '/api/human-models/categories') {
    if (!requireInternalKey(req, res)) return;
    try {
      const categories = db.listHumanModelCategories();
      sendJson(res, 200, { success: true, categories });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to list categories.' });
    }
    return;
  }

  // GET single human model by ID (only if no sub-path like /recolor, /analyze, etc.)
  if (req.method === 'GET' && segments[0] === 'api' && segments[1] === 'human-models' && segments[2] && segments[2] !== 'categories' && !segments[3]) {
    if (!requireInternalKey(req, res)) return;
    try {
      const modelId = segments[2];
      const model = db.getHumanModelById(modelId);
      if (!model) {
        sendJson(res, 404, { error: 'Human model not found.' });
        return;
      }
      sendJson(res, 200, { success: true, model });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to get human model.' });
    }
    return;
  }

  if (req.method === 'POST' && parsedUrl.pathname === '/api/human-models') {
    if (!requireInternalKey(req, res)) return;
    try {
      const body = await getReqBodyJson(req);
      if (!body || !body.title || !body.filePath) {
        sendJson(res, 400, { error: 'title and filePath are required.' });
        return;
      }
      const model = db.createHumanModel({
        title: body.title,
        description: body.description || null,
        tags: body.tags || null,
        category: body.category || null,
        gender: body.gender || null,
        poseType: body.poseType || null,
        seoFilename: body.seoFilename || null,
        filePath: body.filePath,
        optimizedPath: body.optimizedPath || null,
        thumbnailPath: body.thumbnailPath || null,
        status: body.status || 'draft'
      });
      sendJson(res, 201, { success: true, model });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to create human model.' });
    }
    return;
  }

  if (req.method === 'PUT' && segments[0] === 'api' && segments[1] === 'human-models' && segments[2]) {
    if (!requireInternalKey(req, res)) return;
    try {
      const modelId = segments[2];
      const body = await getReqBodyJson(req);
      const model = db.updateHumanModel(modelId, body);
      if (!model) {
        sendJson(res, 404, { error: 'Human model not found.' });
        return;
      }
      sendJson(res, 200, { success: true, model });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to update human model.' });
    }
    return;
  }

  if (req.method === 'DELETE' && segments[0] === 'api' && segments[1] === 'human-models' && segments[2]) {
    if (!requireInternalKey(req, res)) return;
    try {
      const modelId = segments[2];
      db.deleteHumanModel(modelId);
      sendJson(res, 200, { success: true });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to delete human model.' });
    }
    return;
  }

  // Human Models file upload
  if (req.method === 'POST' && parsedUrl.pathname === '/api/human-models/upload') {
    if (!requireInternalKey(req, res)) return;
    try {
      const contentType = req.headers['content-type'] || '';
      if (!contentType.includes('multipart/form-data')) {
        sendJson(res, 400, { error: 'Expected multipart/form-data' });
        return;
      }

      const { fields, files } = await parseMultipartForm(req, {
        uploadDir: path.join(LIBRARY_ROOT, 'human-models'),
        maxFileSize: 50 * 1024 * 1024,
        filter: ({ mimetype }) => mimetype && mimetype.startsWith('image/')
      });

      const file = files.file?.[0] || files.file;
      if (!file) {
        sendJson(res, 400, { error: 'No file uploaded' });
        return;
      }

      const ext = path.extname(file.originalFilename || '').toLowerCase() || '.png';
      const uniqueId = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const destFilename = `model_${uniqueId}${ext}`;
      const thumbFilename = `model_${uniqueId}_thumb.jpg`;

      const destDir = path.join(LIBRARY_ROOT, 'human-models');
      await fs.promises.mkdir(destDir, { recursive: true });

      const destPath = path.join(destDir, destFilename);
      const thumbPath = path.join(destDir, thumbFilename);

      // Move uploaded file to destination
      await fs.promises.rename(file.filepath, destPath);

      // Create thumbnail
      let thumbnailPath = null;
      if (sharp) {
        try {
          await sharp(destPath)
            .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 80 })
            .toFile(thumbPath);
          thumbnailPath = `/library/human-models/${thumbFilename}`;
        } catch (thumbErr) {
          console.warn('[Human Models Upload] Thumbnail creation failed:', thumbErr.message);
        }
      }

      sendJson(res, 200, {
        success: true,
        filePath: `/library/human-models/${destFilename}`,
        thumbnailPath,
        filename: file.originalFilename || destFilename
      });
    } catch (e) {
      console.error('[Human Models Upload] Error:', e);
      sendJson(res, 500, { error: e?.message || 'Upload failed' });
    }
    return;
  }

  // Mockup Backgrounds file upload (images only - ZIP extraction handled by client)
  if (req.method === 'POST' && parsedUrl.pathname === '/api/mockup-backgrounds/upload') {
    if (!requireInternalKey(req, res)) return;
    try {
      const contentType = req.headers['content-type'] || '';
      if (!contentType.includes('multipart/form-data')) {
        sendJson(res, 400, { error: 'Expected multipart/form-data' });
        return;
      }

      const { fields, files } = await parseMultipartForm(req, {
        uploadDir: path.join(LIBRARY_ROOT, 'mockup-backgrounds'),
        maxFileSize: 50 * 1024 * 1024,
        filter: ({ mimetype }) => mimetype && mimetype.startsWith('image/')
      });

      const file = files.file?.[0] || files.file;
      if (!file) {
        sendJson(res, 400, { error: 'No file uploaded' });
        return;
      }

      console.log('[Mockup Backgrounds Upload] File received:', {
        filepath: file.filepath,
        originalFilename: file.originalFilename,
        mimetype: file.mimetype,
        size: file.size
      });

      // Verify temp file exists
      if (!fs.existsSync(file.filepath)) {
        console.error('[Mockup Backgrounds Upload] Temp file does not exist:', file.filepath);
        sendJson(res, 500, { error: 'Uploaded file not found on server' });
        return;
      }

      const ext = path.extname(file.originalFilename || '').toLowerCase() || '.png';
      const uniqueId = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const destFilename = `bg_${uniqueId}${ext}`;
      const thumbFilename = `bg_${uniqueId}_thumb.jpg`;

      const destDir = path.join(LIBRARY_ROOT, 'mockup-backgrounds');
      await fs.promises.mkdir(destDir, { recursive: true });

      const destPath = path.join(destDir, destFilename);
      const thumbPath = path.join(destDir, thumbFilename);

      // Move uploaded file to destination (use copy+unlink for cross-filesystem support)
      try {
        await fs.promises.rename(file.filepath, destPath);
      } catch (renameErr) {
        // If rename fails (cross-device), fallback to copy + unlink
        console.log('[Mockup Backgrounds Upload] Rename failed, using copy:', renameErr.code);
        await fs.promises.copyFile(file.filepath, destPath);
        await fs.promises.unlink(file.filepath).catch(() => {});
      }

      // Get image dimensions
      let width = null, height = null, fileSize = null;
      if (sharp) {
        try {
          const metadata = await sharp(destPath).metadata();
          width = metadata.width;
          height = metadata.height;
          const stats = await fs.promises.stat(destPath);
          fileSize = stats.size;
        } catch (metaErr) {
          console.warn('[Mockup Backgrounds Upload] Metadata read failed:', metaErr.message);
        }
      }

      // Create thumbnail
      let thumbnailPath = null;
      if (sharp) {
        try {
          await sharp(destPath)
            .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 80 })
            .toFile(thumbPath);
          thumbnailPath = `/library/mockup-backgrounds/${thumbFilename}`;
        } catch (thumbErr) {
          console.warn('[Mockup Backgrounds Upload] Thumbnail creation failed:', thumbErr.message);
        }
      }

      sendJson(res, 200, {
        success: true,
        filePath: `/library/mockup-backgrounds/${destFilename}`,
        thumbnailPath,
        filename: file.originalFilename || destFilename,
        width,
        height,
        fileSize
      });
    } catch (e) {
      console.error('[Mockup Backgrounds Upload] Error:', e);
      sendJson(res, 500, { error: e?.message || 'Upload failed' });
    }
    return;
  }

  // Human Models - AI Metadata Analysis
  if (req.method === 'POST' && segments[0] === 'api' && segments[1] === 'human-models' && segments[3] === 'analyze') {
    if (!requireInternalKey(req, res)) return;
    const modelId = segments[2];
    try {
      const model = db.getHumanModelById(modelId);
      if (!model) {
        sendJson(res, 404, { error: 'Model not found.' });
        return;
      }

      // Get the full image path (model uses camelCase from mapHumanModel)
      const modelFilePath = model.filePath;
      if (!modelFilePath) {
        sendJson(res, 400, { error: 'Model has no file path.' });
        return;
      }
      // Resolve the path - models are stored under /web/library/human-models/
      let imagePath;
      if (modelFilePath.startsWith('/')) {
        imagePath = path.resolve(__dirname, '..', 'web', modelFilePath.replace(/^\//, ''));
      } else {
        imagePath = modelFilePath;
      }
      // Fallback: check if it exists as-is
      if (!fs.existsSync(imagePath) && fs.existsSync(modelFilePath)) {
        imagePath = modelFilePath;
      }

      console.log('[Human Model AI] Analyzing:', modelId, imagePath);

      // Use the human-model-analyzer module
      const { analyzeHumanModel } = require('./human-model-analyzer');
      const metadata = await analyzeHumanModel(imagePath);

      console.log('[Human Model AI] Result:', metadata);

      // Generate category from metadata: Gender-Apparel-Direction
      const capitalize = (str) => str ? str.charAt(0).toUpperCase() + str.slice(1).toLowerCase() : '';
      const categoryParts = [
        capitalize(metadata.gender),
        capitalize(metadata.apparel_type?.replace(/-/g, ' ')),
        capitalize(metadata.facing?.replace(/-/g, ' '))
      ].filter(Boolean);
      const category = categoryParts.length >= 2 ? categoryParts.join('-') : null;

      console.log('[Human Model AI] Generated category:', category);

      // Update the database with the analyzed metadata and generated category
      db.updateHumanModel(modelId, {
        gender: metadata.gender,
        ethnicity: metadata.ethnicity,
        apparel_type: metadata.apparel_type,
        facing: metadata.facing,
        pose_type: metadata.pose,
        category: category
      });

      sendJson(res, 200, {
        success: true,
        modelId,
        metadata: { ...metadata, category }
      });
    } catch (e) {
      console.error('[Human Model AI] Error:', e);
      sendJson(res, 500, { error: e?.message || 'Analysis failed' });
    }
    return;
  }

  // Human Models - Generate Clothing Mask
  if (req.method === 'POST' && segments[0] === 'api' && segments[1] === 'human-models' && segments[3] === 'generate-mask') {
    if (!requireInternalKey(req, res)) return;
    try {
      const modelId = segments[2];
      const body = await getReqBodyJson(req).catch(() => ({}));
      const options = {
        clothingLuminanceMin: body.luminanceMin || 170,
        keepTempFiles: body.keepTempFiles || false,
        blur: body.blur || 0.5
      };

      console.log('[Human Model Mask] Generating mask for:', modelId);

      const { generateMaskForModel } = require('./scripts/clothing-mask-generator');
      const result = await generateMaskForModel(db.db, modelId, options);

      console.log('[Human Model Mask] Generated:', result.maskPath);

      sendJson(res, 200, {
        success: true,
        modelId,
        maskPath: result.maskPath
      });
    } catch (e) {
      console.error('[Human Model Mask] Error:', e);
      sendJson(res, 500, { error: e?.message || 'Mask generation failed' });
    }
    return;
  }

  // Human Models - Generate All Missing Masks
  if (req.method === 'POST' && parsedUrl.pathname === '/api/human-models/generate-all-masks') {
    if (!requireInternalKey(req, res)) return;
    try {
      const body = await getReqBodyJson(req).catch(() => ({}));
      const options = {
        clothingLuminanceMin: body.luminanceMin || 170,
        keepTempFiles: body.keepTempFiles || false,
        blur: body.blur || 0.5
      };

      console.log('[Human Model Mask] Generating masks for all models without masks...');

      const { generateMissingMasks } = require('./scripts/clothing-mask-generator');
      const results = await generateMissingMasks(db.db, options);

      const successful = results.filter(r => r.success).length;
      console.log(`[Human Model Mask] Generated ${successful}/${results.length} masks`);

      sendJson(res, 200, {
        success: true,
        generated: successful,
        total: results.length,
        results
      });
    } catch (e) {
      console.error('[Human Model Mask] Error:', e);
      sendJson(res, 500, { error: e?.message || 'Batch mask generation failed' });
    }
    return;
  }

  // Human Models - Check if recolored version exists in cache
  // GET /api/human-models/:id/recolor-check?color=navy+blue&garmentType=t-shirt
  if (req.method === 'GET' && segments[0] === 'api' && segments[1] === 'human-models' && segments[3] === 'recolor-check') {
    if (!requireInternalKey(req, res)) return;
    try {
      const modelId = segments[2];
      const urlParams = new URL(req.url, `http://${req.headers.host}`).searchParams;
      const color = urlParams.get('color');
      const garmentType = urlParams.get('garmentType') || 't-shirt';

      if (!color) {
        sendJson(res, 400, { error: 'color query param is required' });
        return;
      }

      // Check if model exists
      const model = db.getHumanModelById(modelId);
      if (!model) {
        sendJson(res, 404, { error: 'Model not found' });
        return;
      }

      // Check cache
      const cached = db.getRecoloredModel(modelId, color, garmentType);
      const exists = !!(cached && cached.filePath && fs.existsSync(cached.filePath));

      sendJson(res, 200, {
        exists,
        modelId,
        color,
        garmentType,
        cached: exists ? {
          webPath: cached.webPath,
          cacheKey: cached.cacheKey
        } : null
      });
    } catch (e) {
      console.error('[Recolor Check] Error:', e);
      sendJson(res, 500, { error: e?.message || 'Check failed' });
    }
    return;
  }

  // Human Models - Recolor Garment (AI-powered color change)
  // POST /api/human-models/:id/recolor
  // Body: { color: "forest green", garmentType: "t-shirt", force: false }
  if (req.method === 'POST' && segments[0] === 'api' && segments[1] === 'human-models' && segments[3] === 'recolor') {
    if (!requireInternalKey(req, res)) return;
    try {
      const modelId = segments[2];
      const body = await getReqBodyJson(req).catch(() => ({}));
      const { color, garmentType = 't-shirt', force = false } = body;

      if (!color) {
        sendJson(res, 400, { error: 'color is required' });
        return;
      }

      // Get the model to find its image path
      const model = db.getHumanModelById(modelId);
      if (!model) {
        sendJson(res, 404, { error: 'Model not found' });
        return;
      }

      console.log(`[Recolor] Request for model ${modelId}: ${color} ${garmentType}`);

      // Check cache first (unless force regenerate)
      if (!force) {
        const cached = db.getRecoloredModel(modelId, color, garmentType);
        if (cached && cached.filePath && fs.existsSync(cached.filePath)) {
          console.log(`[Recolor] Returning cached: ${cached.webPath}`);
          sendJson(res, 200, {
            success: true,
            cached: true,
            imagePath: cached.filePath,
            webPath: cached.webPath,
            cacheKey: cached.cacheKey
          });
          return;
        }
      }

      // Check if Replicate API token is configured
      const replicateToken = process.env.REPLICATE_API_TOKEN;
      if (!replicateToken) {
        sendJson(res, 500, { error: 'REPLICATE_API_TOKEN not configured on server' });
        return;
      }

      // Get the actual file path for the model image
      const imagePath = model.filePath.startsWith('/library/')
        ? path.join(LIBRARY_ROOT, model.filePath.replace('/library/', ''))
        : model.filePath;

      if (!fs.existsSync(imagePath)) {
        sendJson(res, 404, { error: `Model image not found: ${imagePath}` });
        return;
      }

      // Initialize and run the recolor service
      const garmentRecolor = require('./garment-recolor');
      garmentRecolor.init({ cacheDir: path.join(LIBRARY_ROOT, 'human-models', 'recolored') });

      const result = await garmentRecolor.recolorGarment({
        modelId,
        imagePath,
        color,
        garmentType,
        replicateApiToken: replicateToken,
        forceRegenerate: force,
        db: {
          getRecoloredModel: (mId, c, g) => db.getRecoloredModel(mId, c, g),
          saveRecoloredModel: (data) => db.saveRecoloredModel(data)
        }
      });

      console.log(`[Recolor] Completed: ${result.webPath} (cached: ${result.cached})`);

      sendJson(res, 200, {
        success: true,
        cached: result.cached,
        imagePath: result.imagePath,
        webPath: result.webPath,
        cacheKey: result.cacheKey
      });
    } catch (e) {
      console.error('[Recolor] Error:', e);
      sendJson(res, 500, { error: e?.message || 'Recolor failed' });
    }
    return;
  }

  // Human Models - List Color Variants for a model
  // GET /api/human-models/:id/color-variants
  if (req.method === 'GET' && segments[0] === 'api' && segments[1] === 'human-models' && segments[3] === 'color-variants') {
    if (!requireInternalKey(req, res)) return;
    try {
      const modelId = segments[2];
      const variants = db.listRecoloredModelsByModel(modelId);
      sendJson(res, 200, { success: true, variants });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Failed to list variants' });
    }
    return;
  }

  // --- MATERIALS ---
  if (req.method === 'GET' && parsedUrl.pathname === '/api/custom-art/materials') {
    if (!requireInternalKey(req, res)) return;
    try {
      const activeOnly = parsedUrl.query?.activeOnly !== 'false';
      const materials = db.listCustomArtMaterials({ activeOnly });
      sendJson(res, 200, { success: true, materials });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to list materials.' });
    }
    return;
  }

  if (req.method === 'GET' && segments[0] === 'api' && segments[1] === 'custom-art' && segments[2] === 'materials' && segments[3]) {
    if (!requireInternalKey(req, res)) return;
    try {
      const material = db.getCustomArtMaterialById(segments[3]);
      if (!material) {
        sendJson(res, 404, { error: 'Material not found.' });
        return;
      }
      sendJson(res, 200, { success: true, material });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to get material.' });
    }
    return;
  }

  if (req.method === 'POST' && parsedUrl.pathname === '/api/custom-art/materials') {
    if (!requireInternalKey(req, res)) return;
    try {
      const body = await getReqBodyJson(req);
      if (!body || !body.name) {
        sendJson(res, 400, { error: 'name is required.' });
        return;
      }
      const material = db.createCustomArtMaterial({
        name: body.name,
        description: body.description || null,
        filterType: body.filterType || 'none',
        baseCostCents: body.baseCostCents || 0
      });
      sendJson(res, 200, { success: true, material });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to create material.' });
    }
    return;
  }

  if (req.method === 'PATCH' && segments[0] === 'api' && segments[1] === 'custom-art' && segments[2] === 'materials' && segments[3]) {
    if (!requireInternalKey(req, res)) return;
    try {
      const existing = db.getCustomArtMaterialById(segments[3]);
      if (!existing) {
        sendJson(res, 404, { error: 'Material not found.' });
        return;
      }
      const body = await getReqBodyJson(req);
      const material = db.updateCustomArtMaterial(segments[3], body);
      sendJson(res, 200, { success: true, material });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to update material.' });
    }
    return;
  }

  if (req.method === 'DELETE' && segments[0] === 'api' && segments[1] === 'custom-art' && segments[2] === 'materials' && segments[3]) {
    if (!requireInternalKey(req, res)) return;
    try {
      db.deleteCustomArtMaterial(segments[3]);
      sendJson(res, 200, { success: true });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to delete material.' });
    }
    return;
  }

  // --- PRODUCTS ---
  if (req.method === 'GET' && parsedUrl.pathname === '/api/custom-art/products') {
    if (!requireInternalKey(req, res)) return;
    try {
      const activeOnly = parsedUrl.query?.activeOnly !== 'false';
      const status = parsedUrl.query?.status || null;
      const artworkId = parsedUrl.query?.artworkId || null;
      const limit = Number(parsedUrl.query?.limit) || 100;
      const offset = Number(parsedUrl.query?.offset) || 0;
      const products = db.listCustomArtProducts({ activeOnly, status, artworkId, limit, offset });
      sendJson(res, 200, { success: true, products });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to list products.' });
    }
    return;
  }

  if (req.method === 'GET' && segments[0] === 'api' && segments[1] === 'custom-art' && segments[2] === 'products' && segments[3]) {
    if (!requireInternalKey(req, res)) return;
    try {
      const product = db.getCustomArtProductById(segments[3]);
      if (!product) {
        sendJson(res, 404, { error: 'Product not found.' });
        return;
      }
      sendJson(res, 200, { success: true, product });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to get product.' });
    }
    return;
  }

  if (req.method === 'POST' && parsedUrl.pathname === '/api/custom-art/products') {
    if (!requireInternalKey(req, res)) return;
    try {
      const body = await getReqBodyJson(req);
      if (!body || !body.title) {
        sendJson(res, 400, { error: 'title is required.' });
        return;
      }
      const product = db.createCustomArtProduct({
        artworkId: body.artworkId || null,
        title: body.title,
        description: body.description || null,
        hasVariants: body.hasVariants || false,
        basePriceCents: body.basePriceCents || 0,
        costCents: body.costCents || 0,
        materialId: body.materialId || null,
        singleSizeWidth: body.singleSizeWidth || body.singleSize?.width || null,
        singleSizeHeight: body.singleSizeHeight || body.singleSize?.height || null,
        sizeUnit: body.sizeUnit || body.singleSize?.unit || 'inches',
        mockupPath: body.mockupPath || null,
        mockupRoomId: body.mockupRoomId || null,
        status: body.status || 'draft'
      });

      // If this is a tiled product, save the tiles to the database
      if (body.tiledInfo?.tiles && Array.isArray(body.tiledInfo.tiles)) {
        console.log('[CustomArt] Saving', body.tiledInfo.tiles.length, 'tiles for product:', product.id);
        for (const tile of body.tiledInfo.tiles) {
          try {
            db.createCustomArtTile({
              productId: product.id,
              artworkId: body.artworkId || null,
              row: tile.row,
              col: tile.col,
              filename: tile.filename,
              filePath: tile.filePath || tile.url,
              url: tile.url,
              widthInches: tile.widthInches || body.tiledInfo.tileWidth,
              heightInches: tile.heightInches || body.tiledInfo.tileHeight
            });
          } catch (tileErr) {
            console.error('[CustomArt] Error saving tile:', tileErr);
          }
        }
        console.log('[CustomArt] Tiles saved successfully');
      }

      sendJson(res, 200, { success: true, product });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to create product.' });
    }
    return;
  }

  if (req.method === 'PATCH' && segments[0] === 'api' && segments[1] === 'custom-art' && segments[2] === 'products' && segments[3]) {
    if (!requireInternalKey(req, res)) return;
    try {
      const existing = db.getCustomArtProductById(segments[3]);
      if (!existing) {
        sendJson(res, 404, { error: 'Product not found.' });
        return;
      }
      const body = await getReqBodyJson(req);
      // Handle nested singleSize object
      if (body.singleSize) {
        if (body.singleSize.width !== undefined) body.singleSizeWidth = body.singleSize.width;
        if (body.singleSize.height !== undefined) body.singleSizeHeight = body.singleSize.height;
        if (body.singleSize.unit !== undefined) body.sizeUnit = body.singleSize.unit;
      }
      const product = db.updateCustomArtProduct(segments[3], body);
      sendJson(res, 200, { success: true, product });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to update product.' });
    }
    return;
  }

  if (req.method === 'DELETE' && segments[0] === 'api' && segments[1] === 'custom-art' && segments[2] === 'products' && segments[3]) {
    if (!requireInternalKey(req, res)) return;
    try {
      db.deleteCustomArtProduct(segments[3]);
      sendJson(res, 200, { success: true });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to delete product.' });
    }
    return;
  }

  // --- PRODUCT TILES (for split panel products) ---
  if (req.method === 'GET' && segments[0] === 'api' && segments[1] === 'custom-art' && segments[2] === 'products' && segments[3] && segments[4] === 'tiles') {
    if (!requireInternalKey(req, res)) return;
    try {
      const product = db.getCustomArtProductById(segments[3]);
      if (!product) {
        sendJson(res, 404, { error: 'Product not found.' });
        return;
      }
      const tiles = db.listCustomArtTilesByProduct(segments[3]);
      sendJson(res, 200, { success: true, tiles });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to list tiles.' });
    }
    return;
  }

  // --- PRODUCT VARIANTS ---
  if (req.method === 'GET' && segments[0] === 'api' && segments[1] === 'custom-art' && segments[2] === 'products' && segments[3] && segments[4] === 'variants') {
    if (!requireInternalKey(req, res)) return;
    try {
      const product = db.getCustomArtProductById(segments[3]);
      if (!product) {
        sendJson(res, 404, { error: 'Product not found.' });
        return;
      }
      const activeOnly = parsedUrl.query?.activeOnly !== 'false';
      const variants = db.listCustomArtProductVariants(segments[3], { activeOnly });
      sendJson(res, 200, { success: true, variants });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to list variants.' });
    }
    return;
  }

  if (req.method === 'POST' && segments[0] === 'api' && segments[1] === 'custom-art' && segments[2] === 'products' && segments[3] && segments[4] === 'variants') {
    if (!requireInternalKey(req, res)) return;
    try {
      const product = db.getCustomArtProductById(segments[3]);
      if (!product) {
        sendJson(res, 404, { error: 'Product not found.' });
        return;
      }
      const body = await getReqBodyJson(req);
      if (!body || body.sizeWidth === undefined || body.sizeHeight === undefined) {
        sendJson(res, 400, { error: 'sizeWidth and sizeHeight are required.' });
        return;
      }
      const variant = db.createCustomArtProductVariant({
        productId: segments[3],
        materialId: body.materialId || null,
        sizeWidth: body.sizeWidth || body.size?.width,
        sizeHeight: body.sizeHeight || body.size?.height,
        sizeUnit: body.sizeUnit || body.size?.unit || 'inches',
        priceCents: body.priceCents || 0,
        costCents: body.costCents || 0,
        sku: body.sku || null
      });
      sendJson(res, 200, { success: true, variant });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to create variant.' });
    }
    return;
  }

  if (req.method === 'PATCH' && segments[0] === 'api' && segments[1] === 'custom-art' && segments[2] === 'variants' && segments[3]) {
    if (!requireInternalKey(req, res)) return;
    try {
      const existing = db.getCustomArtProductVariantById(segments[3]);
      if (!existing) {
        sendJson(res, 404, { error: 'Variant not found.' });
        return;
      }
      const body = await getReqBodyJson(req);
      // Handle nested size object
      if (body.size) {
        if (body.size.width !== undefined) body.sizeWidth = body.size.width;
        if (body.size.height !== undefined) body.sizeHeight = body.size.height;
        if (body.size.unit !== undefined) body.sizeUnit = body.size.unit;
      }
      const variant = db.updateCustomArtProductVariant(segments[3], body);
      sendJson(res, 200, { success: true, variant });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to update variant.' });
    }
    return;
  }

  if (req.method === 'DELETE' && segments[0] === 'api' && segments[1] === 'custom-art' && segments[2] === 'variants' && segments[3]) {
    if (!requireInternalKey(req, res)) return;
    try {
      db.deleteCustomArtProductVariant(segments[3]);
      sendJson(res, 200, { success: true });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to delete variant.' });
    }
    return;
  }

  // --- CUSTOM ART MOCKUPS CRUD ---
  // List all mockups from database
  if (req.method === 'GET' && parsedUrl.pathname === '/api/custom-art/mockups') {
    if (!requireInternalKey(req, res)) return;
    try {
      const query = parsedUrl.query || {};

      // Get mockups from database
      console.log('[Mockups] Listing with query:', query);
      const mockups = db.listCustomArtMockups({
        productId: query.productId,
        artworkId: query.artworkId,
        roomId: query.roomId,
        campaignSlug: query.campaignSlug,
        mockupType: query.mockupType,
        activeOnly: query.activeOnly !== 'false'
      });
      console.log('[Mockups] Found', mockups.length, 'mockups');

      sendJson(res, 200, mockups);
    } catch (e) {
      console.error('[Mockups] Error listing mockups:', e);
      sendJson(res, 500, { error: e?.message || 'Unable to list mockups.' });
    }
    return;
  }

  // Get single mockup by ID
  if (req.method === 'GET' && segments[0] === 'api' && segments[1] === 'custom-art' && segments[2] === 'mockups' && segments[3]) {
    if (!requireInternalKey(req, res)) return;
    try {
      const mockup = db.getCustomArtMockupById(segments[3]);
      if (!mockup) {
        sendJson(res, 404, { error: 'Mockup not found.' });
        return;
      }
      sendJson(res, 200, mockup);
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to get mockup.' });
    }
    return;
  }

  // Create mockup
  if (req.method === 'POST' && parsedUrl.pathname === '/api/custom-art/mockups') {
    if (!requireInternalKey(req, res)) return;
    try {
      const body = await getReqBodyJson(req);
      const { title, filename, filePath, url, productId, artworkId, roomId, width, height, fileSize, tags, notes, imageData } = body;

      // If imageData is provided, save the file first
      let finalFilePath = filePath;
      let finalUrl = url;
      let finalFilename = filename;

      if (imageData) {
        const mockupsDir = path.join(__dirname, '..', 'web', 'images', 'custom-art', 'mockups');
        fs.mkdirSync(mockupsDir, { recursive: true });

        const ext = (filename || 'mockup.png').split('.').pop() || 'png';
        const uniqueFilename = `mockup-${Date.now()}-${Math.random().toString(36).substring(2, 10)}.${ext}`;
        const absolutePath = path.join(mockupsDir, uniqueFilename);

        const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
        fs.writeFileSync(absolutePath, Buffer.from(base64Data, 'base64'));

        finalFilePath = `images/custom-art/mockups/${uniqueFilename}`;
        finalFilename = uniqueFilename;
        finalUrl = `${process.env.STORE_BASE_URL || 'https://store.swayzecustomvinyl.com'}/${finalFilePath}`;

        // Get image dimensions
        try {
          const sharp = require('sharp');
          const metadata = await sharp(absolutePath).metadata();
          body.width = metadata.width;
          body.height = metadata.height;
          body.fileSize = fs.statSync(absolutePath).size;
        } catch (e) {
          console.warn('[Mockups] Could not get image metadata:', e.message);
        }
      }

      if (!finalFilename || !finalFilePath) {
        sendJson(res, 400, { error: 'filename and filePath are required (or provide imageData).' });
        return;
      }

      const mockupId = db.createCustomArtMockup({
        title: title || finalFilename,
        filename: finalFilename,
        filePath: finalFilePath,
        url: finalUrl,
        productId,
        artworkId,
        roomId,
        width: body.width,
        height: body.height,
        fileSize: body.fileSize,
        tags,
        notes
      });

      const mockup = db.getCustomArtMockupById(mockupId);
      console.log('[Mockups] Created mockup:', mockupId);
      sendJson(res, 200, mockup);
    } catch (e) {
      console.error('[Mockups] Error creating mockup:', e);
      sendJson(res, 500, { error: e?.message || 'Unable to create mockup.' });
    }
    return;
  }

  // Update mockup
  if (req.method === 'PUT' && segments[0] === 'api' && segments[1] === 'custom-art' && segments[2] === 'mockups' && segments[3]) {
    if (!requireInternalKey(req, res)) return;
    try {
      const body = await getReqBodyJson(req);
      db.updateCustomArtMockup(segments[3], body);
      const updated = db.getCustomArtMockupById(segments[3]);
      sendJson(res, 200, updated);
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to update mockup.' });
    }
    return;
  }

  // Delete mockup (soft delete - sets active=0)
  if (req.method === 'DELETE' && segments[0] === 'api' && segments[1] === 'custom-art' && segments[2] === 'mockups' && segments[3]) {
    if (!requireInternalKey(req, res)) return;
    try {
      const query = parsedUrl.query || {};
      const hardDelete = query.hard === 'true';

      if (hardDelete) {
        // Hard delete - remove from DB and optionally delete file
        const mockup = db.getCustomArtMockupById(segments[3]);
        if (mockup && mockup.filePath) {
          const absolutePath = path.join(__dirname, '..', 'web', mockup.filePath);
          if (fs.existsSync(absolutePath)) {
            fs.unlinkSync(absolutePath);
            console.log('[Mockups] Deleted file:', absolutePath);
          }
        }
        db.deleteCustomArtMockup(segments[3], true);
      } else {
        // Soft delete
        db.deleteCustomArtMockup(segments[3], false);
      }
      sendJson(res, 200, { success: true });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to delete mockup.' });
    }
    return;
  }

  // --- FILE UPLOAD FOR CUSTOM ART ---
  if (req.method === 'POST' && parsedUrl.pathname === '/api/custom-art/upload') {
    if (!requireInternalKey(req, res)) return;
    try {
      // Accept JSON body with base64 imageData
      const body = await getReqBodyJson(req);
      if (!body || !body.imageData || !body.filename) {
        sendJson(res, 400, { error: 'imageData (base64) and filename are required.' });
        return;
      }
      const uploadDir = path.join(LIBRARY_ROOT, 'uploads', 'custom-art');
      fs.mkdirSync(uploadDir, { recursive: true });

      const ext = path.extname(body.filename) || '.png';
      const safeFilename = `${Date.now()}-${Math.random().toString(36).substring(2, 10)}${ext}`;
      const filePath = path.join(uploadDir, safeFilename);

      // Decode base64
      const base64Data = body.imageData.replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));

      const relativePath = `library/uploads/custom-art/${safeFilename}`;
      sendJson(res, 200, { success: true, filePath: relativePath, absolutePath: filePath });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to upload file.' });
    }
    return;
  }

  // --- SAVE MOCKUP FOR CUSTOM ART ---
  if (req.method === 'POST' && parsedUrl.pathname === '/api/custom-art/mockup/save') {
    if (!requireInternalKey(req, res)) return;
    try {
      const body = await getReqBodyJson(req);
      const { productId, mockupBase64, filename, artworkId, roomId, campaignSlug, materialId, mockupType, title } = body;

      if (!mockupBase64) {
        sendJson(res, 400, { error: 'mockupBase64 is required.' });
        return;
      }

      // Ensure custom-art-images directory exists
      const customArtImagesDir = path.join(__dirname, '..', 'web', 'images', 'custom-art');
      try { fs.mkdirSync(customArtImagesDir, { recursive: true }); } catch (_) {}

      // Save the mockup image
      const ext = (filename || 'mockup.jpg').split('.').pop() || 'jpg';
      const mockupFilename = filename || `mockup-${productId || 'general'}-${Date.now()}.${ext}`;
      const mockupPath = path.join(customArtImagesDir, mockupFilename);

      const imageBuffer = Buffer.from(mockupBase64, 'base64');
      fs.writeFileSync(mockupPath, imageBuffer);

      // Build the public URL for the mockup
      const publicUrl = `${process.env.STORE_BASE_URL || 'https://store.swayzecustomvinyl.com'}/images/custom-art/${mockupFilename}`;

      // Get image dimensions if sharp is available
      let width = null, height = null;
      if (sharp) {
        try {
          const meta = await sharp(mockupPath).metadata();
          width = meta.width;
          height = meta.height;
        } catch (_) {}
      }

      // Create a mockup record in the database
      const mockupId = db.createCustomArtMockup({
        title: title || (productId ? `Mockup for ${productId}` : 'General Mockup'),
        filename: mockupFilename,
        filePath: mockupPath,
        url: publicUrl,
        productId: productId || null,
        artworkId: artworkId || null,
        roomId: roomId || null,
        campaignSlug: campaignSlug || null,
        materialId: materialId || null,
        mockupType: mockupType || (productId ? 'product' : 'general'),
        width,
        height,
        fileSize: imageBuffer.length,
        tags: null,
        notes: null
      });

      // Update the product with the mockup path if productId is provided
      if (productId) {
        db.updateCustomArtProduct(productId, { mockupPath: publicUrl });
      }

      console.log('[CustomArt] Saved mockup:', mockupId, 'product:', productId || 'none', 'campaign:', campaignSlug || 'none', 'URL:', publicUrl);

      sendJson(res, 200, { success: true, mockupId, mockupPath: publicUrl });
    } catch (e) {
      console.error('[CustomArt] Error saving mockup:', e);
      sendJson(res, 500, { error: e?.message || 'Unable to save mockup.' });
    }
    return;
  }

  // --- SAVE TILED ARTWORK FOR CUSTOM ART (wall patterns) ---
  if (req.method === 'POST' && parsedUrl.pathname === '/api/custom-art/tiled-artwork/save') {
    if (!requireInternalKey(req, res)) return;
    try {
      const body = await getReqBodyJson(req);
      const { productId, artworkBase64, filename, originalArtworkId } = body;

      if (!productId || !artworkBase64 || !filename) {
        sendJson(res, 400, { error: 'productId, artworkBase64, and filename are required.' });
        return;
      }

      // Ensure tiled artwork directory exists (separate from main artwork)
      const tiledArtworkDir = path.join(__dirname, '..', 'web', 'images', 'custom-art', 'tiled');
      try { fs.mkdirSync(tiledArtworkDir, { recursive: true }); } catch (_) {}

      // Save the tiled artwork image
      const tiledPath = path.join(tiledArtworkDir, filename);
      fs.writeFileSync(tiledPath, Buffer.from(artworkBase64, 'base64'));

      // Build the public URL
      const publicUrl = `${process.env.STORE_BASE_URL || 'https://store.swayzecustomvinyl.com'}/images/custom-art/tiled/${filename}`;

      console.log('[CustomArt] Saved tiled artwork for product:', productId, 'File:', filename, 'URL:', publicUrl);

      // Note: We don't add these to Shopify - they're for internal workflow only
      // The tiled files are associated with the product but not exported

      sendJson(res, 200, { success: true, tiledArtworkPath: publicUrl, filename });
    } catch (e) {
      console.error('[CustomArt] Error saving tiled artwork:', e);
      sendJson(res, 500, { error: e?.message || 'Unable to save tiled artwork.' });
    }
    return;
  }

  // --- GENERATE TILES (SPLIT ARTWORK INTO PANELS) ---
  if (req.method === 'POST' && parsedUrl.pathname === '/api/custom-art/tiles/generate') {
    if (!requireInternalKey(req, res)) return;
    try {
      const body = await getReqBodyJson(req);
      const { artworkId, cols, rows, tileWidth, tileHeight, gap, imageBase64, mediaType } = body;

      if (!artworkId || !cols || !rows || !tileWidth || !tileHeight || !imageBase64) {
        sendJson(res, 400, { error: 'artworkId, cols, rows, tileWidth, tileHeight, and imageBase64 are required.' });
        return;
      }

      const sharp = require('sharp');
      const { v4: uuidv4 } = require('uuid');

      // Decode the base64 image
      const imageBuffer = Buffer.from(imageBase64, 'base64');
      const metadata = await sharp(imageBuffer).metadata();
      const imgWidth = metadata.width;
      const imgHeight = metadata.height;

      // The entire image should be split evenly into cols × rows tiles
      // Gaps are the physical space between tiles on the wall, NOT parts of the image to cut out
      // Each tile gets an equal portion of the source image
      const gapInches = gap || 0;

      // Calculate the pixel dimensions for each tile
      // The full image is divided into cols × rows equal sections
      const tilePixelWidth = Math.floor(imgWidth / cols);
      const tilePixelHeight = Math.floor(imgHeight / rows);

      // Calculate total physical dimensions for display purposes
      const totalWidthInches = (tileWidth * cols) + (gapInches * (cols - 1));
      const totalHeightInches = (tileHeight * rows) + (gapInches * (rows - 1));

      console.log('[Tiles] Image dimensions:', imgWidth, 'x', imgHeight);
      console.log('[Tiles] Grid:', cols, 'cols x', rows, 'rows');
      console.log('[Tiles] Each tile pixels:', tilePixelWidth, 'x', tilePixelHeight);

      // Ensure tiles directory exists
      const tilesDir = path.join(__dirname, '..', 'web', 'images', 'custom-art', 'tiles');
      try { fs.mkdirSync(tilesDir, { recursive: true }); } catch (_) {}

      const tiles = [];
      const baseFilename = `${artworkId}-${uuidv4().slice(0, 8)}`;

      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          // Calculate the starting position for this tile
          // Each tile gets an equal portion of the image
          const startX = col * tilePixelWidth;
          const startY = row * tilePixelHeight;

          // For the last column/row, extend to the edge to capture any remaining pixels
          const isLastCol = col === cols - 1;
          const isLastRow = row === rows - 1;
          const cropWidth = isLastCol ? (imgWidth - startX) : tilePixelWidth;
          const cropHeight = isLastRow ? (imgHeight - startY) : tilePixelHeight;

          console.log(`[Tiles] Tile ${row + 1}-${col + 1}: start (${startX}, ${startY}), size ${cropWidth}x${cropHeight}`);

          // Crop the tile from the source image
          const tileBuffer = await sharp(imageBuffer)
            .extract({ left: startX, top: startY, width: cropWidth, height: cropHeight })
            .toBuffer();

          // Save the tile with sequential naming (row-col)
          const tileFilename = `${baseFilename}_tile_${row + 1}-${col + 1}.png`;
          const tilePath = path.join(tilesDir, tileFilename);
          await sharp(tileBuffer).png().toFile(tilePath);

          const publicUrl = `${process.env.STORE_BASE_URL || 'https://store.swayzecustomvinyl.com'}/images/custom-art/tiles/${tileFilename}`;

          tiles.push({
            row: row + 1,
            col: col + 1,
            filename: tileFilename,
            url: publicUrl,
            filePath: tilePath,
            widthInches: tileWidth,
            heightInches: tileHeight
          });
        }
      }

      console.log('[CustomArt] Generated', tiles.length, 'tiles for artwork:', artworkId);

      sendJson(res, 200, {
        success: true,
        artworkId,
        cols,
        rows,
        tileWidth,
        tileHeight,
        gap: gapInches,
        totalWidthInches,
        totalHeightInches,
        tiles
      });
    } catch (e) {
      console.error('[CustomArt] Error generating tiles:', e);
      sendJson(res, 500, { error: e?.message || 'Unable to generate tiles.' });
    }
    return;
  }

  // --- SPLIT ARTWORK INTO TILES (for mockup modal) ---
  if (req.method === 'POST' && parsedUrl.pathname === '/api/custom-art/split-artwork') {
    if (!requireInternalKey(req, res)) return;
    try {
      const body = await getReqBodyJson(req);
      const { imageBase64, mediaType, cols, rows, name } = body;

      if (!imageBase64 || !cols || !rows) {
        sendJson(res, 400, { error: 'imageBase64, cols, and rows are required.' });
        return;
      }

      const sharp = require('sharp');
      const { v4: uuidv4 } = require('uuid');

      // Decode the base64 image
      const imageBuffer = Buffer.from(imageBase64, 'base64');
      const metadata = await sharp(imageBuffer).metadata();
      const imgWidth = metadata.width;
      const imgHeight = metadata.height;

      // Calculate the pixel dimensions for each tile
      const tilePixelWidth = Math.floor(imgWidth / cols);
      const tilePixelHeight = Math.floor(imgHeight / rows);

      console.log('[Split Artwork] Image dimensions:', imgWidth, 'x', imgHeight);
      console.log('[Split Artwork] Grid:', cols, 'cols x', rows, 'rows');
      console.log('[Split Artwork] Each tile pixels:', tilePixelWidth, 'x', tilePixelHeight);

      // Ensure tiles directory exists
      const tilesDir = path.join(__dirname, '..', 'web', 'images', 'custom-art', 'tiles');
      try { fs.mkdirSync(tilesDir, { recursive: true }); } catch (_) {}

      const tiles = [];
      const safeName = (name || 'artwork').replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, '-').substring(0, 50);
      const baseFilename = `${safeName}-${uuidv4().slice(0, 8)}`;

      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const startX = col * tilePixelWidth;
          const startY = row * tilePixelHeight;

          // For the last column/row, extend to the edge
          const isLastCol = col === cols - 1;
          const isLastRow = row === rows - 1;
          const cropWidth = isLastCol ? (imgWidth - startX) : tilePixelWidth;
          const cropHeight = isLastRow ? (imgHeight - startY) : tilePixelHeight;

          // Crop the tile from the source image
          const tileBuffer = await sharp(imageBuffer)
            .extract({ left: startX, top: startY, width: cropWidth, height: cropHeight })
            .toBuffer();

          // Save the tile
          const tileFilename = `${baseFilename}_tile_${row + 1}-${col + 1}.png`;
          const tilePath = path.join(tilesDir, tileFilename);
          await sharp(tileBuffer).png().toFile(tilePath);

          const publicUrl = `/images/custom-art/tiles/${tileFilename}`;

          tiles.push({
            row: row + 1,
            col: col + 1,
            filename: tileFilename,
            url: publicUrl,
            filePath: tilePath
          });
        }
      }

      console.log('[Split Artwork] Generated', tiles.length, 'tiles');

      sendJson(res, 200, {
        success: true,
        cols,
        rows,
        tiles
      });
    } catch (e) {
      console.error('[Split Artwork] Error:', e);
      sendJson(res, 500, { error: e?.message || 'Unable to split artwork.' });
    }
    return;
  }

  // --- SHOPIFY EXPORT FOR CUSTOM ART ---
  if (req.method === 'POST' && parsedUrl.pathname === '/api/custom-art/shopify/export') {
    if (!requireInternalKey(req, res)) return;
    try {
      const body = await getReqBodyJson(req);
      // Support both old format (productIds) and new format (products with base64 images)
      const products = body?.products || [];
      const productIds = body?.productIds || products.map(p => p.id);

      if (!Array.isArray(productIds) || !productIds.length) {
        sendJson(res, 400, { error: 'productIds or products array is required.' });
        return;
      }

      // Build a map of product ID to image data (artwork and mockup)
      const imageDataMap = {};
      for (const p of products) {
        if (p.id) {
          imageDataMap[p.id] = {
            artwork: p.artworkBase64 ? { base64: p.artworkBase64, filename: p.artworkFilename } : null,
            artworkUrl: p.artworkUrl || null,  // URL if artwork is already on server
            mockup: p.mockupBase64 ? { base64: p.mockupBase64, filename: p.mockupFilename } : null,
            mockupUrl: p.mockupUrl || null  // URL if mockup is already on server
          };
        }
      }

      const shopify = require('./integrations/shopify');
      if (!shopify.isConfigured()) {
        sendJson(res, 500, { error: 'Shopify is not configured.' });
        return;
      }

      // Ensure custom-art-images directory exists
      const customArtImagesDir = path.join(__dirname, '..', 'web', 'images', 'custom-art');
      try { fs.mkdirSync(customArtImagesDir, { recursive: true }); } catch (_) {}

      const results = [];
      for (const productId of productIds) {
        try {
          const product = db.getCustomArtProductById(productId);
          if (!product) {
            results.push({ productId, success: false, error: 'Product not found.' });
            continue;
          }

          let isUpdate = !!product.shopifyProductId;
          let existingProductId = product.shopifyProductId || null;

          // If no local shopifyProductId, check Shopify for existing product by tag
          if (!existingProductId) {
            try {
              const searchTag = `custom-art-product-${productId}`;
              const existingProduct = await shopify.findProductByTag(searchTag);
              if (existingProduct && existingProduct.id) {
                console.log(`[CustomArt Shopify] Found existing product by tag: ${existingProduct.id}`);
                existingProductId = existingProduct.id;
                isUpdate = true;
                // Update local DB with the found Shopify ID
                db.updateCustomArtProduct(productId, {
                  shopifyProductId: String(existingProduct.id),
                  shopifyHandle: existingProduct.handle || null
                });
              }
            } catch (searchErr) {
              console.log(`[CustomArt Shopify] Product search by tag failed: ${searchErr.message}`);
            }
          }

          // Build Shopify product payload
          // Artwork image is primary, mockup is secondary
          const images = [];
          const imageData = imageDataMap[productId] || {};

          // Handle artwork image - could be base64 or URL
          if (imageData.artwork?.base64) {
            // Save the artwork image to the server and use public URL
            const ext = (imageData.artwork.filename || 'image.jpg').split('.').pop() || 'jpg';
            const imageFilename = `${productId}-artwork-${Date.now()}.${ext}`;
            const imagePath = path.join(customArtImagesDir, imageFilename);
            try {
              fs.writeFileSync(imagePath, Buffer.from(imageData.artwork.base64, 'base64'));
              const publicUrl = `${process.env.STORE_BASE_URL || 'https://store.swayzecustomvinyl.com'}/images/custom-art/${imageFilename}`;
              console.log('[CustomArt Shopify] Saved artwork to:', imagePath, 'URL:', publicUrl);
              images.push({ src: publicUrl, position: 1 });
            } catch (e) {
              console.error('[CustomArt Shopify] Failed to save artwork image:', e);
            }
          } else if (imageData.artworkUrl) {
            // Artwork is already on server, use the URL directly
            console.log('[CustomArt Shopify] Using artwork URL directly:', imageData.artworkUrl);
            images.push({ src: imageData.artworkUrl, position: 1 });
          }

          // Handle mockup image - either from URL (already on server) or base64
          console.log('[CustomArt Shopify] Checking mockup for product:', productId);
          console.log('[CustomArt Shopify] imageData.mockupUrl:', imageData.mockupUrl);
          console.log('[CustomArt Shopify] imageData.mockup?.base64 length:', imageData.mockup?.base64?.length || 'none');
          console.log('[CustomArt Shopify] product.mockupPath from DB:', product.mockupPath);

          if (imageData.mockupUrl) {
            // Mockup is already on server, use the URL directly
            console.log('[CustomArt Shopify] Using existing mockup URL:', imageData.mockupUrl);
            images.push({ src: imageData.mockupUrl, position: 2 });
          } else if (imageData.mockup?.base64) {
            // Save the mockup image to the server and use public URL
            const ext = (imageData.mockup.filename || 'image.jpg').split('.').pop() || 'jpg';
            const imageFilename = `${productId}-mockup-${Date.now()}.${ext}`;
            const imagePath = path.join(customArtImagesDir, imageFilename);
            try {
              fs.writeFileSync(imagePath, Buffer.from(imageData.mockup.base64, 'base64'));
              const publicUrl = `${process.env.STORE_BASE_URL || 'https://store.swayzecustomvinyl.com'}/images/custom-art/${imageFilename}`;
              console.log('[CustomArt Shopify] Saved mockup to:', imagePath, 'URL:', publicUrl);
              images.push({ src: publicUrl, position: 2 });
            } catch (e) {
              console.error('[CustomArt Shopify] Failed to save mockup image:', e);
            }
          } else if (product.mockupPath) {
            // Fallback: check if product has a mockupPath stored in DB
            console.log('[CustomArt Shopify] Using product mockupPath from DB:', product.mockupPath);
            images.push({ src: product.mockupPath, position: 2 });
          } else {
            console.log('[CustomArt Shopify] No mockup found for product:', productId);
          }

          // ALWAYS include artwork image if available and not already added
          // This ensures the original artwork is uploaded to Shopify for printing purposes
          const hasArtworkImage = images.some(img => img.position === 1);
          if (!hasArtworkImage && product.artworkId) {
            const artwork = db.getCustomArtArtworkById(product.artworkId);
            console.log('[CustomArt Shopify] Looking up artwork for product:', productId, 'artworkId:', product.artworkId);
            console.log('[CustomArt Shopify] Found artwork:', artwork?.id, 'filePath:', artwork?.filePath);
            if (artwork?.filePath) {
              // Convert relative path to full URL
              const storeUrl = process.env.STORE_BASE_URL || 'https://store.swayzecustomvinyl.com';
              let artworkUrl = artwork.filePath;
              if (!artworkUrl.startsWith('http')) {
                artworkUrl = `${storeUrl}/${artworkUrl.startsWith('/') ? artworkUrl.substring(1) : artworkUrl}`;
              }
              console.log('[CustomArt Shopify] Adding artwork image from DB:', artworkUrl);
              images.unshift({ src: artworkUrl, position: 1 });
              // Re-number mockup position if present
              const mockupImg = images.find(img => img.position === 2 || img.src?.includes('mockup'));
              if (mockupImg && images.indexOf(mockupImg) !== 0) {
                mockupImg.position = 2;
              }
            }
          }

          // Build variants if product has variants, otherwise single variant
          const variants = [];
          if (product.hasVariants && product.variants?.length) {
            for (const v of product.variants) {
              variants.push({
                title: `${v.sizeWidth}×${v.sizeHeight}${v.sizeUnit === 'inches' ? '"' : 'cm'}`,
                price: (v.priceCents / 100).toFixed(2),
                sku: v.sku || `CART-${product.id}-${v.id}`,
                option1: `${v.sizeWidth}×${v.sizeHeight}${v.sizeUnit === 'inches' ? '"' : 'cm'}`,
                inventory_management: null
              });
            }
          } else {
            variants.push({
              price: (product.basePriceCents / 100).toFixed(2),
              sku: `CART-${product.id}`,
              inventory_management: null
            });
          }

          // Build a cleaned title - prefer artwork title over product title
          // Use artwork title as the primary source for Shopify product title
          let cleanTitle = product.artwork?.title || product.title || '';
          // Remove prefixes before "|" (e.g., "Lucid Origin Frozen|")
          if (cleanTitle.includes('|')) {
            cleanTitle = cleanTitle.split('|').pop().trim();
          }
          // Remove dimension suffixes like "2 c64683d6 325d 4bff a8b6 070a2ee17c1a - 4x2 Split Panel" or similar UUID + dimension patterns
          cleanTitle = cleanTitle.replace(/\s+[a-f0-9]{8}[\s-]+[a-f0-9]{4}[\s-]+[a-f0-9]{4}[\s-]+[a-f0-9]{4}[\s-]+[a-f0-9]{12}.*$/i, '').trim();
          cleanTitle = cleanTitle.replace(/\s*-\s*\d+x\d+\s*Split\s*Panel.*$/i, '').trim();

          // Build description
          let description = '';
          const material = product.material?.name || '';
          const sizeInfo = product.singleSize || {};
          const hasVariants = product.hasVariants && product.variants?.length > 0;

          if (hasVariants) {
            // Multiple size variants
            const sizes = product.variants.map(v => `${v.sizeWidth}×${v.sizeHeight}${v.sizeUnit === 'inches' ? '"' : 'cm'}`).join(', ');
            description = `<p>Available in ${sizes}.</p>`;
            if (material) {
              description += `<p>Printed on premium ${material.toLowerCase()}.</p>`;
            }
          } else if (sizeInfo.width && sizeInfo.height) {
            // Single size
            const unit = sizeInfo.unit === 'inches' ? '"' : 'cm';
            description = `<p>${sizeInfo.width}${unit} × ${sizeInfo.height}${unit} piece.</p>`;
            if (material) {
              description += `<p>Printed on premium ${material.toLowerCase()}.</p>`;
            }
          } else if (material) {
            description = `<p>Printed on premium ${material.toLowerCase()}.</p>`;
          }

          // Add artwork name to description if available and different from title
          const artworkTitle = product.artwork?.title || '';
          if (artworkTitle && artworkTitle !== cleanTitle) {
            // Clean the artwork title the same way
            let cleanArtwork = artworkTitle;
            if (cleanArtwork.includes('|')) cleanArtwork = cleanArtwork.split('|').pop().trim();
            cleanArtwork = cleanArtwork.replace(/\s+[a-f0-9]{8}[\s-]+[a-f0-9]{4}[\s-]+[a-f0-9]{4}[\s-]+[a-f0-9]{4}[\s-]+[a-f0-9]{12}.*$/i, '').trim();
            cleanArtwork = cleanArtwork.replace(/\s*-\s*\d+x\d+\s*Split\s*Panel.*$/i, '').trim();
            if (cleanArtwork && cleanArtwork !== cleanTitle) {
              description += `<p>Design: ${cleanArtwork}</p>`;
            }
          }

          const shopifyPayload = {
            title: cleanTitle || product.title,
            body_html: description || product.description || '',
            vendor: 'Blue Ridge Custom Co',
            product_type: 'Wall Art',
            tags: ['custom-art', material || 'art', `custom-art-product-${productId}`].filter(Boolean).join(', '),
            status: 'active',
            template_suffix: 'custom-art'
          };

          // Only include images if we have new ones
          if (images.length > 0) {
            shopifyPayload.images = images;
          }

          // Only include variants for new products (updating variants requires different API)
          if (!isUpdate) {
            shopifyPayload.variants = variants;
            // Add size option if variants
            if (product.hasVariants && product.variants?.length) {
              shopifyPayload.options = [{ name: 'Size' }];
            }
          }

          let resultProduct;
          if (isUpdate) {
            // Update existing Shopify product
            console.log('[CustomArt Shopify] Updating product:', existingProductId, JSON.stringify(shopifyPayload, null, 2));
            try {
              resultProduct = await shopify.updateProduct(existingProductId, shopifyPayload);
              console.log('[CustomArt Shopify] Update response:', JSON.stringify(resultProduct, null, 2));
            } catch (updateErr) {
              // If product not found in Shopify (deleted), clear the ID and create new
              if (updateErr?.status === 404 || updateErr?.message?.includes('Not Found')) {
                console.log('[CustomArt Shopify] Product not found in Shopify, clearing ID and creating new...');
                db.updateCustomArtProduct(productId, { shopifyProductId: null, shopifyHandle: null });
                // Add variants for new product creation
                shopifyPayload.variants = variants;
                if (product.hasVariants && product.variants?.length) {
                  shopifyPayload.options = [{ name: 'Size' }];
                }
                resultProduct = await shopify.createProduct(shopifyPayload);
                console.log('[CustomArt Shopify] Create response (after 404):', JSON.stringify(resultProduct, null, 2));
              } else {
                throw updateErr;
              }
            }
          } else {
            // Create new Shopify product
            console.log('[CustomArt Shopify] Creating product:', JSON.stringify(shopifyPayload, null, 2));
            resultProduct = await shopify.createProduct(shopifyPayload);
            console.log('[CustomArt Shopify] Create response:', JSON.stringify(resultProduct, null, 2));
          }

          if (resultProduct?.id) {
            // Update local product with Shopify ID (if new)
            if (!isUpdate) {
              db.updateCustomArtProduct(productId, {
                shopifyProductId: String(resultProduct.id),
                shopifyHandle: resultProduct.handle || null
              });
            }
            // Always publish to all channels (Online Store, Point of Sale, Facebook, Instagram, TikTok)
            await shopify.publishEverywhere(resultProduct.id).catch((e) => {
              console.log('[CustomArt Shopify] publishEverywhere error (non-fatal):', e?.message || e);
            });

            results.push({
              productId,
              success: true,
              shopifyProductId: String(resultProduct.id),
              handle: resultProduct.handle,
              updated: isUpdate
            });
          } else {
            results.push({ productId, success: false, error: 'Shopify did not return a product ID.' });
          }
        } catch (e) {
          console.error('[CustomArt Shopify] Error:', e);
          const errorMsg = typeof e === 'object' ? (e.message || JSON.stringify(e)) : String(e);
          results.push({ productId, success: false, error: errorMsg });
        }
      }

      sendJson(res, 200, { success: true, results });
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Unable to export to Shopify.' });
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
};

function createServerInstance() {
  if (httpsOptions) {
    return https.createServer(httpsOptions, requestHandler);
  }
  return http.createServer(requestHandler);
}

// Map Shopify order payload to internal orders
async function handleShopifyOrderWebhook(orderPayload, { topic } = {}) {
  try {
    const o = orderPayload || {};
    const shopifyOrderId = o.id;
    const shopifyOrderName = o.name || String(o.order_number || '');
    const financialStatus = (o.financial_status || '').toLowerCase();
    const isPaid = financialStatus === 'paid' || financialStatus === 'partially_paid';
    const email = o.email || (o.customer && o.customer.email) || '';
    const phone = (o.customer && o.customer.phone) || (o.shipping_address && o.shipping_address.phone) || (o.billing_address && o.billing_address.phone) || '';
    const addressParts = [];
    const ship = o.shipping_address || {};
    if (ship.name) addressParts.push(ship.name);
    const line1 = [ship.address1, ship.address2].filter(Boolean).join(' ');
    const line2 = [ship.city, ship.province, ship.zip].filter(Boolean).join(', ');
    if (line1) addressParts.push(line1);
    if (line2) addressParts.push(line2);
    const addressText = addressParts.join('\n');

    // Upsert customer
    let customer = null;
    try { customer = db.upsertCustomerContact({ name: ship.name || (o.customer && (o.customer.first_name + ' ' + o.customer.last_name)) || '', email, phone, address: addressText }); } catch (_) {}
    const customerId = customer?.id || null;

    // Build a quick lookup from campaign mappings by product_id
    function findCampaignItemByProductId(productId) {
      try {
        const campaigns = listCampaigns();
        for (const c of campaigns) {
          if (!Array.isArray(c.items)) continue;
          for (const it of c.items) {
            if (it && (it.shopifyProductId || it.productId)) {
              const pid = Number(it.shopifyProductId || it.productId);
              if (Number(productId) === pid) {
                return { campaign: c, item: it };
              }
            }
          }
        }
      } catch (_) {}
      return null;
    }

    const when = o.created_at || new Date().toISOString();
    const lines = Array.isArray(o.line_items) ? o.line_items : [];
    for (const li of lines) {
      try {
        const lid = li.id;
        const sku = String(li.sku || '').trim();
        const productId = li.product_id;
        const quantity = Number(li.quantity || 1);
        const price = Number(li.price || 0);
        // Build internal id per line item to track separately in pipeline
        const internalId = `shopify-${shopifyOrderId}-${lid}`;
        const existing = db.getOrderById(internalId);
        if (existing) {
          // Update paid status on repeat webhook events
          if (topic === 'orders/paid' || isPaid) {
            db.updateOrder(internalId, { paid: true, paymentStatus: 'PAID', paymentDetails: { shopify: { order_id: shopifyOrderId, name: shopifyOrderName, line_item_id: lid, topic } } });
          }
          // Still allow POD ingestion below for idempotent updates
        } else {
          // Try to map to a campaign/design via productId
          const mapping = productId ? findCampaignItemByProductId(productId) : null;
          const campaignSlug = mapping?.campaign?.slug || null;
          const designId = mapping?.item?.designId || null;
          const designName = mapping?.item?.name || li.title || li.name || 'Order Item';
          const productType = mapping?.item?.productType || null;
          const previewFile = mapping?.item?.image || null;

          const paymentDetails = { shopify: { order_id: shopifyOrderId, name: shopifyOrderName, line_item_id: lid, product_id: productId, variant_id: li.variant_id } };
          const pricing = { unitPriceCents: Math.round(price * 100), quantity, subtotalCents: Math.round(price * 100) * quantity, currency: o.currency || 'USD' };

          db.recordOrder({
            id: internalId,
            orderNumber: db.getNextOrderNumber(),
            customerId,
            designId,
            designName,
            productType,
            category: mapping?.item?.categorySlug || null,
            size: null,
            color: null,
            background: null,
            quantity,
            notes: `Shopify ${shopifyOrderName} · line ${lid}`,
            textLayers: [],
            previewFile,
            metadataPath: null,
            sourceFiles: [],
            apparelItems: [],
            inventoryUsage: [],
            pricing,
            paymentLink: null,
            paymentLinkId: null,
            paymentStatus: isPaid ? 'PAID' : (o.financial_status || 'UNPAID'),
            paymentDetails,
            savedAt: when,
            paid: Boolean(isPaid),
            internalNotes: '',
            bytesWritten: 0,
            campaign: campaignSlug
          });
        }

        // POD ingestion: create/update production jobs for POD SKUs
        if (isPodSku(sku)) {
          try {
            const podOrder = db.upsertPodOrder({
              shopifyOrderId,
              shopifyOrderNumber: shopifyOrderName,
              status: 'pending',
              shippingName: ship.name || '',
              shippingAddress: ship,
              customerEmail: email || ''
            });
            const artworkPath = db.getArtworkForSku(sku);
            const propsObject = normalizeLineItemProperties(li.properties || []);
            const lineStatus = artworkPath ? 'pending' : 'error';
            if (!artworkPath) {
              console.error('POD artwork mapping not found for SKU:', sku);
            }
            db.upsertPodLineItem({
              orderId: podOrder.id,
              shopifyLineItemId: lid,
              sku,
              name: li.title || li.name || null,
              quantity,
              status: lineStatus,
              artworkPath: artworkPath || null,
              properties: propsObject
            });
          } catch (ePod) {
            console.error('Unable to upsert POD line item for Shopify order', shopifyOrderId, ePod);
          }
        }
      } catch (eLine) {
        console.warn('Shopify order line ingest failed:', eLine?.message || eLine);
      }
    }

    // Check for metal print orders and create upload records
    try {
      await metalPrints.handleShopifyOrderCreated(o);
    } catch (metalError) {
      console.error('Metal prints webhook handling failed:', metalError);
      // Don't throw - let the main order processing continue even if metal prints fails
    }
  } catch (e) {
    console.error('Shopify order ingest error:', e);
    throw e;
  }
}

const server = createServerInstance();

// Set server timeout to 10 minutes for large campaign exports
server.timeout = 600000; // 10 minutes
server.keepAliveTimeout = 620000; // slightly longer than timeout

// Initialize metal prints database
try {
  metalPrints.initDatabase();
} catch (error) {
  console.error('Failed to initialize metal prints database:', error);
}

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    const bindHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
    const protocol = httpsOptions ? 'https' : 'http';
    console.log(`Save design server listening on ${protocol}://${bindHost}:${PORT}`);
    if (httpsOptions) {
      console.log('HTTPS enabled using provided certificate paths.');
    }
  });
}

module.exports = { createServer: createServerInstance };

/**
 * Apply sublimation metal print filter to an image
 * This simulates the look of sublimation printing on metal:
 * - Increased contrast (1.3x)
 * - Increased saturation (1.4x)
 * - Slight cyan/metallic tint
 * - Enhanced brightness in highlights
 */
async function handleApplyMetalPrintFilter(req, res) {
  try {
    const body = await getJsonBody(req);
    const { imagePath, imageBase64, outputPath } = body;

    if (!imagePath && !imageBase64) {
      return sendJson(res, 400, { success: false, error: 'imagePath or imageBase64 is required' });
    }

    let inputBuffer;

    if (imageBase64) {
      // Decode base64 image
      inputBuffer = Buffer.from(imageBase64, 'base64');
    } else {
      // Read from file path
      const safePath = path.resolve(LIBRARY_ROOT, imagePath.replace(/^library\//, ''));
      if (!fs.existsSync(safePath)) {
        return sendJson(res, 404, { success: false, error: 'Image file not found' });
      }
      inputBuffer = await fs.promises.readFile(safePath);
    }

    // Apply sublimation metal print filter using Sharp
    // The filter simulates the look of sublimation on aluminum:
    // 1. Boost contrast and saturation for vivid colors
    // 2. Add slight cyan tint for metallic appearance
    // 3. Increase brightness slightly to simulate metallic sheen

    let processedBuffer = await sharp(inputBuffer)
      // Increase saturation (1.4x) and brightness slightly (1.05x)
      .modulate({
        brightness: 1.05,
        saturation: 1.4
      })
      // Apply linear contrast boost (effectively 1.3x contrast)
      .linear(1.3, -(128 * 0.3))
      // Add slight cyan tint for metallic look
      .recomb([
        [1.0, 0.0, 0.0],   // Red channel unchanged
        [0.0, 1.05, 0.0],  // Green slightly boosted
        [0.0, 0.0, 1.08]   // Blue slightly boosted (cyan tint)
      ])
      .png({ quality: 95 })
      .toBuffer();

    // Determine output path
    let savedPath = null;
    if (outputPath) {
      const safeOutputPath = path.resolve(LIBRARY_ROOT, outputPath.replace(/^library\//, ''));
      await fs.promises.mkdir(path.dirname(safeOutputPath), { recursive: true });
      await fs.promises.writeFile(safeOutputPath, processedBuffer);
      savedPath = outputPath;
    }

    // Return the processed image as base64
    const resultBase64 = processedBuffer.toString('base64');

    return sendJson(res, 200, {
      success: true,
      imageBase64: resultBase64,
      savedPath: savedPath,
      mimeType: 'image/png'
    });

  } catch (err) {
    console.error('[Metal Print Filter] Error:', err);
    return sendJson(res, 500, { success: false, error: err.message || 'Failed to apply filter' });
  }
}

// ============================================================================
// STICKER SHEET GENERATOR HANDLERS
// ============================================================================

// Use main library catalog for stickers (same as design catalog)
const STICKER_CATALOG_ROOT = process.env.STICKER_CATALOG_PATH || LIBRARY_ROOT;
const STICKER_OUTPUT_DIR = process.env.STICKER_OUTPUT_PATH || path.join(LIBRARY_ROOT, 'sticker-sheets');

/**
 * List generated sticker sheet batches (sorted newest first)
 */
async function handleStickerSheetsList(req, res) {
  try {
    // Ensure output directory exists
    await fs.promises.mkdir(STICKER_OUTPUT_DIR, { recursive: true });

    const entries = await fs.promises.readdir(STICKER_OUTPUT_DIR, { withFileTypes: true });
    const batches = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

      const batchDir = path.join(STICKER_OUTPUT_DIR, entry.name);
      const files = await fs.promises.readdir(batchDir);

      // Get directory stats for creation time
      const stats = await fs.promises.stat(batchDir);

      // Find PNG and SVG files (support both old format -print.png and new format _PRINT.png)
      const printFiles = files.filter(f => f.endsWith('-print.png') || f.endsWith('_PRINT.png'));
      const cutFiles = files.filter(f => f.endsWith('-cut.svg') || f.endsWith('_CUT.svg'));
      // Cricut files: PNG with registration marks (new), PDF (legacy), or SVG (old)
      const cricutFiles = files.filter(f => f.endsWith('_CRICUT.png') || f.endsWith('_CRICUT.pdf') || f.endsWith('_CRICUT.svg'));

      // Build file URLs
      const sheets = printFiles.map((pf, idx) => {
        // Extract sheet number from both formats: -01-print.png or _Sheet01_PRINT.png
        const oldMatch = pf.match(/-(\d+)-print\.png$/);
        const newMatch = pf.match(/_Sheet(\d+)_PRINT\.png$/);
        const sheetNum = oldMatch?.[1] || newMatch?.[1] || String(idx + 1);

        // Find matching cut file (both formats)
        const cutFile = cutFiles.find(cf =>
          cf.includes(`-${sheetNum}-cut.svg`) || cf.includes(`_Sheet${sheetNum}_CUT.svg`)
        ) || cutFiles[idx];

        // Find matching Cricut file (PNG preferred, fall back to PDF or SVG)
        const cricutFile = cricutFiles.find(cf =>
          cf.includes(`_Sheet${sheetNum}_CRICUT.png`) || cf.includes(`_Sheet${sheetNum}_CRICUT.pdf`) || cf.includes(`_Sheet${sheetNum}_CRICUT.svg`)
        ) || cricutFiles[idx];

        const relativePrint = path.relative(LIBRARY_ROOT, path.join(batchDir, pf)).replace(/\\/g, '/');
        const relativeCut = cutFile ? path.relative(LIBRARY_ROOT, path.join(batchDir, cutFile)).replace(/\\/g, '/') : null;
        const relativeCricut = cricutFile ? path.relative(LIBRARY_ROOT, path.join(batchDir, cricutFile)).replace(/\\/g, '/') : null;

        return {
          sheetNumber: parseInt(sheetNum, 10),
          printUrl: `/api/library/${relativePrint.split('/').map(p => encodeURIComponent(p)).join('/')}`,
          cutUrl: relativeCut ? `/api/library/${relativeCut.split('/').map(p => encodeURIComponent(p)).join('/')}` : null,
          cricutUrl: relativeCricut ? `/api/library/${relativeCricut.split('/').map(p => encodeURIComponent(p)).join('/')}` : null,
          printFile: pf,
          printFilename: pf,
          cutFile: cutFile || null,
          cutFilename: cutFile || null,
          cricutFile: cricutFile || null,
          cricutFilename: cricutFile || null
        };
      });

      batches.push({
        name: entry.name,
        createdAt: stats.birthtime || stats.mtime,
        sheetCount: printFiles.length,
        sheets
      });
    }

    // Sort by creation date (newest first)
    batches.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    sendJson(res, 200, { success: true, batches, count: batches.length });
  } catch (err) {
    console.error('[Sticker Sheets List Error]', err);
    sendJson(res, 500, { success: false, error: err.message });
  }
}

/**
 * List available sticker categories
 */
async function handleStickerSheetCategories(req, res) {
  try {
    const categories = await stickerSheets.listStickerCategories(STICKER_CATALOG_ROOT);
    sendJson(res, 200, { success: true, categories });
  } catch (err) {
    console.error('[Sticker Categories Error]', err);
    sendJson(res, 500, { success: false, error: err.message });
  }
}

/**
 * List stickers in a category or all stickers
 */
async function handleStickerSheetCatalog(req, res, parsedUrl) {
  try {
    const category = parsedUrl.searchParams?.get('category') || parsedUrl.query?.category || null;
    const stickers = await stickerSheets.scanStickerCatalog(STICKER_CATALOG_ROOT, category);

    // Add thumbnail URL for each sticker
    const stickersWithUrls = stickers.map(s => {
      // Convert absolute path to API URL
      const relativePath = path.relative(LIBRARY_ROOT, s.imagePath).replace(/\\/g, '/');
      const encodedPath = relativePath.split('/').map(p => encodeURIComponent(p)).join('/');
      return {
        ...s,
        thumbnailUrl: `/api/library/${encodedPath}`
      };
    });

    sendJson(res, 200, { success: true, stickers: stickersWithUrls, count: stickersWithUrls.length });
  } catch (err) {
    console.error('[Sticker Catalog Error]', err);
    sendJson(res, 500, { success: false, error: err.message });
  }
}

/**
 * Generate sticker sheets from manual selection
 * Body: { designs: [{imagePath, quantity, title}], stickerSizeInches, offsetMm, filenamePrefix }
 */
async function handleStickerSheetGenerate(req, res) {
  try {
    const body = await getReqBodyJson(req);
    const {
      designs = [],
      stickerSizeInches = 3,
      offsetMm = 3,
      filenamePrefix = 'sticker-sheet'
    } = body;

    if (!designs || !Array.isArray(designs) || designs.length === 0) {
      return sendJson(res, 400, { success: false, error: 'designs array is required' });
    }

    // Ensure output directory exists
    await fs.promises.mkdir(STICKER_OUTPUT_DIR, { recursive: true });

    // Generate timestamp-based subfolder
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outputDir = path.join(STICKER_OUTPUT_DIR, `${filenamePrefix}-${timestamp}`);

    console.log(`[Sticker Sheets] Generating sheets for ${designs.length} designs to ${outputDir}`);

    const result = await stickerSheets.generateStickerSheets(designs, {
      stickerSizeInches,
      offsetMm,
      outputDir,
      filenamePrefix
    });

    sendJson(res, 200, {
      success: true,
      ...result
    });
  } catch (err) {
    console.error('[Sticker Sheet Generate Error]', err);
    sendJson(res, 500, { success: false, error: err.message });
  }
}

/**
 * Generate sticker sheets from a Shopify order
 * Body: { orderId, stickerSizeInches, offsetMm }
 */
async function handleStickerSheetFromOrder(req, res) {
  try {
    const body = await getReqBodyJson(req);
    const {
      orderId,
      stickerSizeInches = 3,
      offsetMm = 3
    } = body;

    if (!orderId) {
      return sendJson(res, 400, { success: false, error: 'orderId is required' });
    }

    // Fetch order from Shopify
    console.log(`[Sticker Sheets] Fetching order ${orderId} from Shopify`);
    const order = await shopify.getOrder(orderId);

    if (!order || !order.line_items) {
      return sendJson(res, 404, { success: false, error: 'Order not found or has no line items' });
    }

    // Extract sticker line items and match to catalog
    const designs = [];
    const notFound = [];

    for (const lineItem of order.line_items) {
      // Check if this is a sticker product (by SKU prefix or product type)
      const sku = lineItem.sku || '';
      const productType = lineItem.product_type || '';
      const title = lineItem.title || lineItem.name || '';

      // Only process sticker items
      const isSticker = sku.toLowerCase().startsWith('sticker') ||
                        productType.toLowerCase().includes('sticker') ||
                        title.toLowerCase().includes('sticker');

      if (!isSticker) continue;

      // Try to find artwork for this item
      // First try SKU-based lookup
      let artworkPath = null;

      if (sku) {
        const skuArtwork = db.getArtworkForSku(sku);
        if (skuArtwork) {
          artworkPath = skuArtwork;
        }
      }

      // If no SKU match, try to find by product_id
      if (!artworkPath && lineItem.product_id) {
        // Look up in custom_art_products table
        try {
          const product = db.getCustomArtProductByShopifyId(lineItem.product_id);
          if (product && product.artwork_id) {
            const artwork = db.getCustomArtArtwork(product.artwork_id);
            if (artwork && artwork.file_path) {
              artworkPath = artwork.file_path;
            }
          }
        } catch (e) {
          // Ignore lookup errors
        }
      }

      // If still no match, try to scan catalog by title
      if (!artworkPath) {
        const stickers = await stickerSheets.scanStickerCatalog(STICKER_CATALOG_ROOT);
        const match = stickers.find(s =>
          s.title.toLowerCase().includes(title.toLowerCase()) ||
          title.toLowerCase().includes(s.title.toLowerCase())
        );
        if (match) {
          artworkPath = match.imagePath;
        }
      }

      if (artworkPath) {
        designs.push({
          imagePath: artworkPath,
          quantity: lineItem.quantity || 1,
          title: title
        });
      } else {
        notFound.push({
          title,
          sku,
          productId: lineItem.product_id,
          quantity: lineItem.quantity
        });
      }
    }

    if (designs.length === 0) {
      return sendJson(res, 400, {
        success: false,
        error: 'No sticker designs found for this order',
        notFound
      });
    }

    // Generate sheets
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outputDir = path.join(STICKER_OUTPUT_DIR, `order-${orderId}-${timestamp}`);
    await fs.promises.mkdir(outputDir, { recursive: true });

    console.log(`[Sticker Sheets] Generating sheets for order ${orderId} with ${designs.length} designs`);

    const result = await stickerSheets.generateStickerSheets(designs, {
      stickerSizeInches,
      offsetMm,
      outputDir,
      filenamePrefix: `order-${orderId}`
    });

    sendJson(res, 200, {
      success: true,
      orderId,
      orderNumber: order.order_number || order.name,
      ...result,
      notFound: notFound.length > 0 ? notFound : undefined
    });
  } catch (err) {
    console.error('[Sticker Sheet From Order Error]', err);
    sendJson(res, 500, { success: false, error: err.message });
  }
}

// ============================================================================
// METAL PRINT EXPORT HANDLERS
// ============================================================================

/**
 * Export a metal print campaign to Shopify
 * Creates products with 5x7, 8x10, 11x14 variants for each artwork
 * Applies the sublimation filter to each artwork before uploading
 */
// Track active metal print export jobs
const metalPrintExportJobs = new Map();

async function handleMetalPrintCampaignExport(req, res) {
  try {
    const body = await getReqBodyJson(req);
    const { campaignName, collectionName, artworkData, mockupPath } = body;

    if (!campaignName) {
      return sendJson(res, 400, { success: false, error: 'campaignName is required' });
    }
    if (!artworkData || !Array.isArray(artworkData) || artworkData.length === 0) {
      return sendJson(res, 400, { success: false, error: 'artworkData array is required' });
    }

    // Check if Shopify is configured
    if (!shopify.isConfigured()) {
      return sendJson(res, 503, { success: false, error: 'Shopify not configured' });
    }

    // Load pricing
    const pricing = readPricingSheet();
    const metalPrintPricing = pricing['metal-print'];
    if (!metalPrintPricing || !metalPrintPricing.sizes) {
      return sendJson(res, 400, { success: false, error: 'Metal print pricing not configured' });
    }

    // Generate job ID
    const jobId = `metal-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const jobSlug = campaignName.toLowerCase().replace(/[^a-z0-9]+/g, '-');

    // Initialize job status
    const jobStatus = {
      jobId,
      campaignName,
      total: artworkData.length,
      processed: 0,
      successCount: 0,
      failCount: 0,
      status: 'starting',
      startedAt: new Date().toISOString(),
      collectionId: null,
      collectionHandle: null,
      results: []
    };
    metalPrintExportJobs.set(jobId, jobStatus);

    // Save initial status to file
    const statusPath = path.join(DATA_DIR, `metal-export-${jobSlug}.json`);
    fs.writeFileSync(statusPath, JSON.stringify(jobStatus, null, 2));

    console.log(`[Metal Print Campaign] Starting async export job ${jobId} for "${campaignName}" with ${artworkData.length} artworks`);

    // Return immediately with job ID - process in background
    sendJson(res, 202, {
      success: true,
      async: true,
      jobId,
      statusUrl: `/api/metal-print/export-status/${jobSlug}`,
      message: `Export started for ${artworkData.length} artworks. Poll status URL for progress.`
    });

    // Process in background using setImmediate to not block
    setImmediate(async () => {
      try {
        // Get or create collection with campaign template
        const collectionTitle = collectionName || campaignName;
        let collection = null;
        try {
          collection = await shopify.findCustomCollectionByTitle(collectionTitle);
          if (collection) {
            console.log(`[Metal Print Campaign] Found existing collection: ${collection.id}`);
            try {
              await shopify.updateCustomCollection(collection.id, { template_suffix: 'campaign' });
            } catch (templateErr) {
              console.log(`[Metal Print Campaign] Could not update template: ${templateErr.message}`);
            }
          }
        } catch (err) {
          console.log(`[Metal Print Campaign] Collection search failed: ${err.message}`);
        }

        if (!collection) {
          try {
            collection = await shopify.createCustomCollection(collectionTitle, {
              template_suffix: 'campaign'
            });
            console.log(`[Metal Print Campaign] Created new collection: ${collection.id}`);
          } catch (err) {
            console.error(`[Metal Print Campaign] Failed to create collection: ${err.message}`);
          }
        }

        const collectionId = collection?.id || null;
        const collectionHandle = collection?.handle || null;
        jobStatus.collectionId = collectionId;
        jobStatus.collectionHandle = collectionHandle;
        jobStatus.status = 'processing';

        const results = [];
        const rateLimitMs = Number(process.env.SHOPIFY_EXPORT_RATE_LIMIT_MS || 500);
        const sizes = metalPrintPricing.sizes;

        // Process each artwork
        for (const artwork of artworkData) {
          const artworkId = artwork.id;
          try {
            console.log(`[Metal Print Campaign] Processing artwork: ${artwork.title || artworkId}`);

            // Get image data
            let inputBuffer;
            if (artwork.imageBase64) {
              inputBuffer = Buffer.from(artwork.imageBase64, 'base64');
            } else if (artwork.filePath) {
              let imagePath = artwork.filePath;
              if (imagePath.startsWith('/library/') || imagePath.startsWith('library/')) {
                imagePath = path.join(WEB_DIR, imagePath.replace(/^\//, ''));
              } else if (imagePath.startsWith('/images/') || imagePath.startsWith('images/')) {
                imagePath = path.join(WEB_DIR, imagePath.replace(/^\//, ''));
              } else if (!path.isAbsolute(imagePath)) {
                imagePath = path.join(WEB_DIR, imagePath);
              }
              if (!fs.existsSync(imagePath)) {
                results.push({ artworkId, success: false, error: 'Image file not found' });
                jobStatus.failCount++;
                jobStatus.processed++;
                continue;
              }
              inputBuffer = fs.readFileSync(imagePath);
            } else {
              results.push({ artworkId, success: false, error: 'No artwork image data or path' });
              jobStatus.failCount++;
              jobStatus.processed++;
              continue;
            }

            // Apply sublimation filter
            const filteredBuffer = await sharp(inputBuffer)
              .modulate({ brightness: 1.05, saturation: 1.4 })
              .linear(1.3, -(128 * 0.3))
              .recomb([
                [1.0, 0.0, 0.0],
                [0.0, 1.05, 0.0],
                [0.0, 0.0, 1.08]
              ])
              .png({ quality: 95 })
              .toBuffer();

            const imageBase64 = filteredBuffer.toString('base64');

            // Clean title
            let productTitle = artwork.title || 'Metal Print';
            productTitle = productTitle
              .replace(/^Lucid\s*Origin\s*/i, '')
              .replace(/^(gen_|generated_|ai_|flux_|leonardo_|a cinematic photo of\s*)/i, '')
              .replace(/[a-f0-9]{8}[-\s][a-f0-9]{4}[-\s][a-f0-9]{4}[-\s][a-f0-9]{4}[-\s][a-f0-9]{12}/gi, '')
              .replace(/\s+[a-f0-9]{8,}$/i, '')
              .replace(/_/g, ' ')
              .replace(/\s+/g, ' ')
              .trim();
            if (!productTitle) productTitle = `Metal Print ${artworkId}`;

            // Create variants
            const variants = [];
            for (const [sizeName, sizeData] of Object.entries(sizes)) {
              variants.push({
                option1: sizeName,
                price: (sizeData.priceCents / 100).toFixed(2),
                sku: sizeData.sku || `METAL-${sizeName.replace('x', '')}`,
                inventory_management: 'shopify',
                inventory_policy: 'continue',
                requires_shipping: true,
                taxable: true
              });
            }

            // Check for existing product
            let existingProduct = null;
            try {
              const searchTag = `artwork-id-${artworkId}`;
              existingProduct = await shopify.findProductByTag(searchTag);
              if (!existingProduct && collectionId) {
                const collectionProducts = await shopify.getCollectionProducts(collectionId, { limit: 250 });
                existingProduct = collectionProducts.find(p =>
                  p.title.toLowerCase().trim() === productTitle.toLowerCase().trim() &&
                  p.product_type === 'Metal Print'
                );
              }
            } catch (searchErr) {
              console.log(`[Metal Print Campaign] Product search failed: ${searchErr.message}`);
            }

            // Build product data
            const campaignTag = campaignName.toLowerCase().replace(/\s+/g, '-');
            const productData = {
              title: productTitle,
              body_html: `<p>High-quality sublimation metal print. Vibrant colors and stunning detail on aluminum.</p><p>Available in sizes: ${Object.keys(sizes).join(', ')}</p>`,
              vendor: process.env.SHOPIFY_VENDOR || 'Custom Vinyl',
              product_type: 'Metal Print',
              tags: ['metal-print', 'sublimation', 'wall-art', campaignTag, `artwork-id-${artworkId}`],
              variants: variants,
              options: [{ name: 'Size', values: Object.keys(sizes) }],
              images: [{ attachment: imageBase64, filename: `${productTitle.replace(/\s+/g, '-')}.png` }]
            };

            let shopifyProduct;
            if (existingProduct && existingProduct.id) {
              const existingVariantCount = existingProduct.variants ? existingProduct.variants.length : 0;
              if (existingVariantCount !== variants.length) {
                console.log(`[Metal Print Campaign] Variant count mismatch - deleting and recreating...`);
                try {
                  await shopify.deleteProduct(existingProduct.id);
                  await new Promise(r => setTimeout(r, 500));
                } catch (delErr) {
                  console.log(`[Metal Print Campaign] Delete failed: ${delErr.message}`);
                }
                shopifyProduct = await shopify.createProduct(productData);
                console.log(`[Metal Print Campaign] Recreated product: ${shopifyProduct.id}`);
              } else {
                shopifyProduct = await shopify.updateProduct(existingProduct.id, {
                  title: productTitle,
                  body_html: productData.body_html,
                  tags: productData.tags.join(', '),
                  variants: variants,
                  options: [{ name: 'Size', values: Object.keys(sizes) }]
                });
                shopifyProduct = { id: existingProduct.id, ...shopifyProduct };
              }
            } else {
              shopifyProduct = await shopify.createProduct(productData);
              console.log(`[Metal Print Campaign] Created product: ${shopifyProduct.id}`);
            }

            // Add to collection
            if (collectionId && shopifyProduct.id) {
              try {
                await shopify.addProductToCollection(shopifyProduct.id, collectionId);
              } catch (colErr) {
                console.log(`[Metal Print Campaign] Failed to add to collection: ${colErr.message}`);
              }
            }

            results.push({ artworkId, success: true, shopifyProductId: shopifyProduct.id, title: productTitle });
            jobStatus.successCount++;
            jobStatus.processed++;

            // Rate limit
            await new Promise(r => setTimeout(r, rateLimitMs));

          } catch (artErr) {
            console.error(`[Metal Print Campaign] Error processing artwork ${artworkId}:`, artErr);
            results.push({ artworkId, success: false, error: artErr.message });
            jobStatus.failCount++;
            jobStatus.processed++;
          }

          // Update status file periodically
          jobStatus.results = results;
          fs.writeFileSync(statusPath, JSON.stringify(jobStatus, null, 2));
        }

        // Set collection mockup if provided
        if (collectionId && mockupPath) {
          try {
            let mockupFullPath;
            if (mockupPath.startsWith('http://') || mockupPath.startsWith('https://')) {
              mockupFullPath = path.join(WEB_DIR, new URL(mockupPath).pathname);
            } else if (mockupPath.startsWith('/')) {
              mockupFullPath = path.join(WEB_DIR, mockupPath);
            } else {
              mockupFullPath = path.join(WEB_DIR, mockupPath);
            }

            if (fs.existsSync(mockupFullPath)) {
              const mockupBuffer = await fs.promises.readFile(mockupFullPath);
              const mockupBase64 = mockupBuffer.toString('base64');
              await shopify.updateCustomCollection(collectionId, {
                image: { attachment: mockupBase64 }
              });
              console.log(`[Metal Print Campaign] Set collection mockup image`);
            }
          } catch (mockupErr) {
            console.log(`[Metal Print Campaign] Could not set collection mockup: ${mockupErr.message}`);
          }
        }

        // Final status update
        jobStatus.status = 'complete';
        jobStatus.completedAt = new Date().toISOString();
        jobStatus.results = results;
        fs.writeFileSync(statusPath, JSON.stringify(jobStatus, null, 2));
        console.log(`[Metal Print Campaign] Export complete: ${jobStatus.successCount} success, ${jobStatus.failCount} failed`);

      } catch (bgErr) {
        console.error('[Metal Print Campaign] Background processing error:', bgErr);
        jobStatus.status = 'error';
        jobStatus.error = bgErr.message;
        fs.writeFileSync(statusPath, JSON.stringify(jobStatus, null, 2));
      }
    });

  } catch (err) {
    console.error('[Metal Print Campaign Export] Error:', err);
    return sendJson(res, 500, { success: false, error: err.message || 'Failed to start export' });
  }
}

// Metal print export status endpoint handler
async function handleMetalPrintExportStatus(req, res, slug) {
  try {
    const statusPath = path.join(DATA_DIR, `metal-export-${slug}.json`);
    if (!fs.existsSync(statusPath)) {
      return sendJson(res, 404, { success: false, error: 'Export job not found' });
    }
    const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    return sendJson(res, 200, { success: true, ...status });
  } catch (err) {
    return sendJson(res, 500, { success: false, error: err.message });
  }
}

// Legacy synchronous export for small batches (kept for backwards compatibility)
async function handleMetalPrintCampaignExportSync(req, res) {
  try {
    const body = await getReqBodyJson(req);
    const { campaignName, collectionName, artworkData, mockupPath } = body;

    if (!campaignName) {
      return sendJson(res, 400, { success: false, error: 'campaignName is required' });
    }
    if (!artworkData || !Array.isArray(artworkData) || artworkData.length === 0) {
      return sendJson(res, 400, { success: false, error: 'artworkData array is required' });
    }

    console.log(`[Metal Print Campaign SYNC] Starting export for "${campaignName}" with ${artworkData.length} artworks`);

    // Check if Shopify is configured
    if (!shopify.isConfigured()) {
      return sendJson(res, 503, { success: false, error: 'Shopify not configured' });
    }

    // Load pricing
    const pricing = readPricingSheet();
    const metalPrintPricing = pricing['metal-print'];
    if (!metalPrintPricing || !metalPrintPricing.sizes) {
      return sendJson(res, 400, { success: false, error: 'Metal print pricing not configured' });
    }

    // Get or create collection with campaign template
    const collectionTitle = collectionName || campaignName;
    let collection = null;
    try {
      collection = await shopify.findCustomCollectionByTitle(collectionTitle);
      if (collection) {
        console.log(`[Metal Print Campaign] Found existing collection: ${collection.id}`);
        // Ensure existing collection uses campaign template
        try {
          await shopify.updateCustomCollection(collection.id, { template_suffix: 'campaign' });
          console.log(`[Metal Print Campaign] Set collection template to 'campaign'`);
        } catch (templateErr) {
          console.log(`[Metal Print Campaign] Could not update template: ${templateErr.message}`);
        }
      }
    } catch (err) {
      console.log(`[Metal Print Campaign] Collection search failed: ${err.message}`);
    }

    if (!collection) {
      try {
        // Create collection with campaign template
        collection = await shopify.createCustomCollection(collectionTitle, {
          template_suffix: 'campaign'
        });
        console.log(`[Metal Print Campaign] Created new collection with campaign template: ${collection.id}`);
      } catch (err) {
        console.error(`[Metal Print Campaign] Failed to create collection: ${err.message}`);
      }
    }

    const collectionId = collection?.id || null;
    const results = [];
    const rateLimitMs = Number(process.env.SHOPIFY_EXPORT_RATE_LIMIT_MS || 500);

    // Process each artwork - artworkData contains { id, title, category, filePath } or legacy { id, title, category, imageBase64 }
    for (const artwork of artworkData) {
      const artworkId = artwork.id;
      try {
        console.log(`[Metal Print Campaign] Processing artwork: ${artwork.title || artworkId}`);

        // Get image data - either from base64 (legacy) or read from disk (optimized)
        let inputBuffer;
        if (artwork.imageBase64) {
          // Legacy: base64 data sent in payload
          inputBuffer = Buffer.from(artwork.imageBase64, 'base64');
        } else if (artwork.filePath) {
          // Optimized: read from disk using file path
          let imagePath = artwork.filePath;
          // Handle relative paths from custom_art_artwork table
          // Paths like "library/uploads/..." are relative to WEB_DIR (/home/ubuntu/vinylApp/web)
          // Paths like "/images/..." are also relative to WEB_DIR
          if (imagePath.startsWith('/library/') || imagePath.startsWith('library/')) {
            imagePath = path.join(WEB_DIR, imagePath.replace(/^\//, ''));
          } else if (imagePath.startsWith('/images/') || imagePath.startsWith('images/')) {
            imagePath = path.join(WEB_DIR, imagePath.replace(/^\//, ''));
          } else if (!path.isAbsolute(imagePath)) {
            imagePath = path.join(WEB_DIR, imagePath);
          }
          console.log(`[Metal Print Campaign] Reading image from: ${imagePath}`);
          if (!fs.existsSync(imagePath)) {
            console.log(`[Metal Print Campaign] Image not found: ${imagePath}`);
            results.push({ artworkId, success: false, error: 'Image file not found' });
            continue;
          }
          inputBuffer = fs.readFileSync(imagePath);
        } else {
          console.log(`[Metal Print Campaign] No image data or path for artwork: ${artworkId}`);
          results.push({ artworkId, success: false, error: 'No artwork image data or path' });
          continue;
        }

        // Apply sublimation filter to inputBuffer
        const filteredBuffer = await sharp(inputBuffer)
          .modulate({ brightness: 1.05, saturation: 1.4 })
          .linear(1.3, -(128 * 0.3))
          .recomb([
            [1.0, 0.0, 0.0],
            [0.0, 1.05, 0.0],
            [0.0, 0.0, 1.08]
          ])
          .png({ quality: 95 })
          .toBuffer();

        // Convert to base64 for Shopify upload
        const imageBase64 = filteredBuffer.toString('base64');

        // Clean title (remove generation prefix, UUID, Lucid Origin, etc.)
        let productTitle = artwork.title || 'Metal Print';
        productTitle = productTitle
          // Remove "Lucid Origin" prefix (case insensitive)
          .replace(/^Lucid\s*Origin\s*/i, '')
          // Remove common AI generation prefixes
          .replace(/^(gen_|generated_|ai_|flux_|leonardo_|a cinematic photo of\s*)/i, '')
          // Remove UUIDs in various formats (with dashes or spaces)
          .replace(/[a-f0-9]{8}[-\s][a-f0-9]{4}[-\s][a-f0-9]{4}[-\s][a-f0-9]{4}[-\s][a-f0-9]{12}/gi, '')
          // Remove standalone hex strings that look like truncated UUIDs (8+ hex chars at end)
          .replace(/\s+[a-f0-9]{8,}$/i, '')
          // Clean up underscores and extra spaces
          .replace(/_/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

        // Ensure we have a title
        if (!productTitle) {
          productTitle = `Metal Print ${artworkId}`;
        }

        // Create variants array for Shopify
        const variants = [];
        const sizes = metalPrintPricing.sizes;

        for (const [sizeName, sizeData] of Object.entries(sizes)) {
          variants.push({
            option1: sizeName,
            price: (sizeData.priceCents / 100).toFixed(2),
            sku: sizeData.sku || `METAL-${sizeName.replace('x', '')}`,
            inventory_management: 'shopify',
            inventory_policy: 'continue',
            requires_shipping: true,
            taxable: true
          });
        }

        // Check if product already exists by title
        let existingProduct = null;
        try {
          // Search for existing product with same title and product_type
          const searchTag = `artwork-id-${artworkId}`;
          existingProduct = await shopify.findProductByTag(searchTag);
          if (!existingProduct) {
            // Also try finding by title in collection
            if (collectionId) {
              const collectionProducts = await shopify.getCollectionProducts(collectionId, { limit: 250 });
              existingProduct = collectionProducts.find(p =>
                p.title.toLowerCase().trim() === productTitle.toLowerCase().trim() &&
                p.product_type === 'Metal Print'
              );
            }
          }
        } catch (searchErr) {
          console.log(`[Metal Print Campaign] Product search failed: ${searchErr.message}`);
        }

        // Build product data
        const campaignTag = campaignName.toLowerCase().replace(/\s+/g, '-');
        const productData = {
          title: productTitle,
          body_html: `<p>High-quality sublimation metal print. Vibrant colors and stunning detail on aluminum.</p><p>Available in sizes: ${Object.keys(sizes).join(', ')}</p>`,
          vendor: process.env.SHOPIFY_VENDOR || 'Custom Vinyl',
          product_type: 'Metal Print',
          tags: ['metal-print', 'sublimation', 'wall-art', campaignTag, `artwork-id-${artworkId}`],
          variants: variants,
          options: [{ name: 'Size', values: Object.keys(sizes) }],
          images: [{ attachment: imageBase64, filename: `${productTitle.replace(/\s+/g, '-')}.png` }]
        };

        // NOTE: For metal prints, only the artwork image is added to individual products
        // The campaign mockup is used for collection/marketing display only, not on products

        let shopifyProduct;
        if (existingProduct && existingProduct.id) {
          // Check if variant count matches - Shopify REST API can't add new variants on update
          const existingVariantCount = existingProduct.variants ? existingProduct.variants.length : 0;
          const newVariantCount = variants.length;

          if (existingVariantCount !== newVariantCount) {
            // Variant count mismatch - delete and recreate to get all variants
            console.log(`[Metal Print Campaign] Variant count mismatch (existing: ${existingVariantCount}, new: ${newVariantCount}) - deleting and recreating...`);
            try {
              await shopify.deleteProduct(existingProduct.id);
              console.log(`[Metal Print Campaign] Deleted old product ${existingProduct.id}`);
              // Small delay after delete
              await new Promise(r => setTimeout(r, 500));
            } catch (delErr) {
              console.log(`[Metal Print Campaign] Delete failed: ${delErr.message}, trying to create anyway`);
            }
            // Create fresh product with all variants
            shopifyProduct = await shopify.createProduct(productData);
            console.log(`[Metal Print Campaign] Recreated product: ${shopifyProduct.id} - ${productTitle} with ${newVariantCount} variants`);
          } else {
            // Same variant count - just update existing product
            console.log(`[Metal Print Campaign] Found existing product ${existingProduct.id}, updating...`);
            shopifyProduct = await shopify.updateProduct(existingProduct.id, {
              title: productTitle,
              body_html: productData.body_html,
              tags: productData.tags.join(', '),
              variants: variants,
              options: [{ name: 'Size', values: Object.keys(sizes) }]
            });
            console.log(`[Metal Print Campaign] Updated product: ${existingProduct.id} - ${productTitle}`);
            shopifyProduct = { id: existingProduct.id, ...shopifyProduct };
          }
        } else {
          // Create new product
          shopifyProduct = await shopify.createProduct(productData);
          console.log(`[Metal Print Campaign] Created product: ${shopifyProduct.id} - ${productTitle} with ${variants.length} variants`);
        }

        // Add to collection if we have one
        if (collectionId && shopifyProduct.id) {
          try {
            await shopify.addProductToCollection(shopifyProduct.id, collectionId);
            console.log(`[Metal Print Campaign] Added product to collection`);
          } catch (colErr) {
            console.log(`[Metal Print Campaign] Failed to add to collection: ${colErr.message}`);
          }
        }

        results.push({
          artworkId,
          success: true,
          shopifyProductId: shopifyProduct.id,
          title: productTitle
        });

        // Rate limit
        await new Promise(r => setTimeout(r, rateLimitMs));

      } catch (artErr) {
        console.error(`[Metal Print Campaign] Error processing artwork ${artworkId}:`, artErr);
        results.push({ artworkId, success: false, error: artErr.message });
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;

    // Set the collection mockup image if provided
    if (collectionId && mockupPath) {
      try {
        console.log(`[Metal Print Campaign] Processing mockup path: ${mockupPath}`);

        // Handle different mockup path formats:
        // 1. Full URL: https://store.swayzecustomvinyl.com/images/custom-art/mockup-prod_xxx.jpg
        // 2. Web path: /images/custom-art/mockup-prod_xxx.jpg
        // 3. Legacy campaign path: /uploads/campaigns/xxx.jpg

        let mockupFullPath;
        if (mockupPath.startsWith('http://') || mockupPath.startsWith('https://')) {
          // Full URL - extract the path portion and map to WEB_DIR
          const urlPath = new URL(mockupPath).pathname;
          mockupFullPath = path.join(WEB_DIR, urlPath);
        } else if (mockupPath.startsWith('/images/')) {
          // Web path like /images/custom-art/mockup-prod_xxx.jpg
          mockupFullPath = path.join(WEB_DIR, mockupPath);
        } else if (mockupPath.startsWith('/uploads/campaigns/')) {
          // Legacy campaign uploads
          mockupFullPath = path.join(CAMPAIGNS_DIR, mockupPath.replace('/uploads/campaigns/', ''));
        } else if (mockupPath.startsWith('/')) {
          // Generic absolute web path
          mockupFullPath = path.join(WEB_DIR, mockupPath);
        } else {
          // Relative path - assume it's relative to WEB_DIR
          mockupFullPath = path.join(WEB_DIR, mockupPath);
        }

        console.log(`[Metal Print Campaign] Resolved mockup path: ${mockupFullPath}`);

        if (fs.existsSync(mockupFullPath)) {
          const mockupBuffer = await fs.promises.readFile(mockupFullPath);
          const mockupBase64 = mockupBuffer.toString('base64');

          // Update collection with mockup as the collection image
          await shopify.updateCustomCollection(collectionId, {
            image: { attachment: mockupBase64 },
            body_html: `<p>Premium sublimation metal prints featuring stunning artwork. Available in 5x7, 8x10, and 11x14 sizes.</p>`
          });
          console.log(`[Metal Print Campaign] Set collection mockup image successfully`);
        } else {
          console.log(`[Metal Print Campaign] Mockup file not found: ${mockupFullPath}`);
        }
      } catch (mockupErr) {
        console.log(`[Metal Print Campaign] Could not set collection mockup: ${mockupErr.message}`);
      }
    }

    console.log(`[Metal Print Campaign] Export complete: ${successCount} success, ${failCount} failed`);

    return sendJson(res, 200, {
      success: true,
      campaignName,
      collectionId,
      collectionHandle: collection?.handle,
      totalProcessed: results.length,
      successCount,
      failCount,
      results
    });

  } catch (err) {
    console.error('[Metal Print Campaign Export] Error:', err);
    return sendJson(res, 500, { success: false, error: err.message || 'Failed to export campaign' });
  }
}

/**
 * Get artwork by ID from the custom art database
 */
async function getArtworkById(artworkId) {
  try {
    const sqlite = db.getDb();
    const artwork = sqlite.prepare('SELECT * FROM custom_art_artwork WHERE id = ?').get(artworkId);
    return artwork;
  } catch (err) {
    console.error('[getArtworkById] Error:', err);
    return null;
  }
}

async function handleArtworkUpload(req, res) {
  const createdFiles = [];
  const tempFiles = [];
  let createdCategoryDir = null;

  try {
    const { fields, files } = await parseMultipartForm(req);
    const displayName = fieldValue(fields, 'displayName') || fieldValue(fields, 'name');
    if (!displayName) {
      throw userError('Display name is required.');
    }

    const categoryMode = (fieldValue(fields, 'categoryMode') || '').toLowerCase();
    const existingCategorySlug =
      fieldValue(fields, 'category') || fieldValue(fields, 'existingCategory');
    const requestedNewCategory =
      fieldValue(fields, 'newCategoryName') || fieldValue(fields, 'newCategory');
    const normalizedNewCategory = sanitizeCategoryFolderName(requestedNewCategory);
    const apparelEnabled = parseBooleanFlag(fieldValue(fields, 'apparelEnabled'));
    const apparelProductTypeInput = fieldValue(fields, 'apparelProductType');
    const apparelProductType = normalizeApparelProductType(apparelProductTypeInput || 'tshirt');
    const apparelCategoryInput = fieldValue(fields, 'apparelCategory');
    const apparelCategoryName = sanitizeApparelCategoryName(apparelCategoryInput);

    if (apparelEnabled && !apparelCategoryName) {
      throw userError('Choose an apparel category or enter a new one.');
    }

    let categoryDir = null;
    let categorySlug = '';
    let categoryDisplayName = '';
    let createdNewCategory = false;

    if ((categoryMode === 'new' && normalizedNewCategory) || !existingCategorySlug) {
      if (!normalizedNewCategory) {
        throw userError('Enter a category name or choose an existing category.');
      }
      const prospectiveSlug = slugify(normalizedNewCategory);
      const existingDir = findCategoryDirectoryBySlug(prospectiveSlug);
      if (existingDir) {
        categoryDir = existingDir;
        categorySlug = prospectiveSlug;
        categoryDisplayName = path.basename(existingDir);
      } else {
        const categoryFolder = normalizedNewCategory;
        const resolvedDir = path.resolve(LIBRARY_ROOT, categoryFolder);
        const rootPrefix = LIBRARY_ROOT.endsWith(path.sep)
          ? LIBRARY_ROOT
          : LIBRARY_ROOT + path.sep;
        const withinRoot = resolvedDir === LIBRARY_ROOT || resolvedDir.startsWith(rootPrefix);
        if (!withinRoot) {
          throw userError('Category path is invalid.');
        }
        ensureDirectorySafe(resolvedDir);
        categoryDir = resolvedDir;
        categorySlug = slugify(categoryFolder);
        categoryDisplayName = categoryFolder;
        createdNewCategory = true;
        createdCategoryDir = categoryDir;
      }
    } else {
      const dir = findCategoryDirectoryBySlug(existingCategorySlug);
      if (!dir) {
        throw userError('Selected category does not exist.');
      }
      categoryDir = dir;
      categorySlug = existingCategorySlug;
      categoryDisplayName = path.basename(dir);
    }

    if (!categoryDir) {
      throw userError('Category could not be determined.');
    }

    const previewFile = listFormFiles(files.preview)[0];
    if (!previewFile || !previewFile.originalFilename) {
      throw userError('Preview image is required.');
    }

    tempFiles.push(previewFile);

    const previewExt = path.extname(previewFile.originalFilename || '').toLowerCase();
    if (!ALLOWED_IMAGE_EXTENSIONS.has(previewExt)) {
      throw userError('Preview must be an image file (PNG, JPG, GIF, or WEBP).');
    }

    const { previewsDir, sourcesDir } = ensureUploadsDirectories(categoryDir);

    const baseIdentifier = `${slugify(displayName)}-${Date.now()}`;
    const previewBase = ensureUniqueBase(previewsDir, baseIdentifier, previewExt);
    const previewFileName = `${previewBase}${previewExt}`;
    const previewTarget = path.join(previewsDir, previewFileName);
  fs.mkdirSync(path.dirname(previewTarget), { recursive: true });
  moveFile(previewFile.filepath, previewTarget);
    createdFiles.push(previewTarget);

    const previewStats = fs.statSync(previewTarget);

    const savedSources = [];
    const sourceFiles = listFormFiles(files.sources);
    sourceFiles.forEach((file) => {
      if (!file || !file.originalFilename) {
        deleteIfExists(file?.filepath);
        return;
      }
      tempFiles.push(file);
      const ext = path.extname(file.originalFilename || '').toLowerCase();
      const format = ALLOWED_SOURCE_EXTENSIONS.get(ext);
      if (!format) {
        deleteIfExists(file.filepath);
        return;
      }
      if (savedSources.some((existing) => existing.format === format)) {
        deleteIfExists(file.filepath);
        console.warn(`Duplicate ${format.toUpperCase()} source ignored for ${displayName}.`);
        return;
      }
      const sourceName = `${previewBase}${ext}`;
      const sourceTarget = path.join(sourcesDir, sourceName);
      fs.mkdirSync(path.dirname(sourceTarget), { recursive: true });
      moveFile(file.filepath, sourceTarget);
      createdFiles.push(sourceTarget);
      const stats = fs.statSync(sourceTarget);
      savedSources.push({
        format,
        file: toWebRelative(sourceTarget),
        name: file.originalFilename,
        size: stats.size
      });
    });

    await regenerateCatalog();

    const previewRelative = toWebRelative(previewTarget);
    const previewProxyUrl = buildAssetProxyUrl(
      previewTarget,
      process.env.ASSET_BASE_URL || ''
    );
    let apparelEntry = null;
    if (apparelEnabled) {
      apparelEntry = registerApparelDesign({
        id: previewBase,
        name: displayName,
        productType: apparelProductType,
        categoryName: apparelCategoryName,
        previewPath: previewRelative,
        previewUrl: previewProxyUrl,
        libraryCategory: categoryDisplayName,
        libraryCategorySlug: categorySlug,
        sources: savedSources
      });
    }

    sendJson(res, 201, {
      success: true,
      category: {
        slug: categorySlug,
        name: categoryDisplayName,
        created: createdNewCategory
      },
      design: {
        name: displayName,
        preview: previewRelative,
        size: previewStats.size,
        sources: savedSources,
        apparel: apparelEnabled
          ? {
              productType: apparelProductType,
              category: {
                slug: apparelEntry?.categorySlug || slugify(apparelCategoryName),
                name: apparelEntry?.categoryName || apparelCategoryName
              },
              preview: apparelEntry?.preview || previewProxyUrl
            }
          : null
      }
    });
  } catch (error) {
    createdFiles.reverse().forEach((filePath) => deleteIfExists(filePath));
    tempFiles.forEach((file) => deleteIfExists(file?.filepath));
    if (createdCategoryDir) {
      try {
        const uploadsPath = path.join(createdCategoryDir, 'uploads');
        if (fs.existsSync(uploadsPath) && fs.readdirSync(uploadsPath).length === 0) {
          fs.rmSync(uploadsPath, { recursive: true, force: true });
        }
        if (fs.existsSync(createdCategoryDir) && fs.readdirSync(createdCategoryDir).length === 0) {
          fs.rmdirSync(createdCategoryDir);
        }
      } catch (cleanupError) {
        console.warn('Unable to cleanup new category directory:', cleanupError.message);
      }
    }
    if (error && error.stack) {
      console.error('Artwork upload failed:', error.stack);
    } else {
      console.error('Artwork upload failed:', error);
    }
    const status = error.statusCode && Number.isInteger(error.statusCode) ? error.statusCode : 500;
    const isProduction = process.env.NODE_ENV === 'production';
    const exposeDetail = status < 500 || error.expose || !isProduction;
    const message =
      status >= 500 && !exposeDetail
        ? 'Unable to upload artwork. Please try again.'
        : error.message || 'Upload failed.';
    const payload = { error: message };
    if (exposeDetail && error && typeof error === 'object') {
      payload.detail = {
        message: error.message,
        code: error.code || null
      };
      if (!isProduction && error.stack) {
        payload.detail.stack = error.stack;
      }
    }
    sendJson(res, status, payload);
  }
}

async function handleCanvaPublish(req, res) {
  // Authorization: accept if no INTERNAL_API_KEY configured; otherwise require matching X-API-Key
  const requiredKey = INTERNAL_API_KEY;
  if (requiredKey) {
    const headerKey = req.headers['x-api-key'] || req.headers['x-api_key'] || req.headers['x-internal-api-key'];
    if (!headerKey || String(headerKey).trim() !== String(requiredKey).trim()) {
      sendJson(res, 401, { error: 'Unauthorized. Missing or invalid API key.' });
      return;
    }
  }

  try {
    // Support multipart form (file field: asset|file|preview) OR JSON with {url}
    let uploadedFile = null;
    let cleanupTemp = [];
    let categoryInput = '';
    let displayName = '';
    let originalName = '';
    const contentType = req.headers['content-type'] || '';
    if (contentType.startsWith('multipart/')) {
      const { fields, files } = await parseMultipartForm(req, { maxFiles: 4, maxFileSize: 30 * 1024 * 1024 });
      displayName = fieldValue(fields, 'displayName') || fieldValue(fields, 'title') || '';
      categoryInput = fieldValue(fields, 'category') || 'Canva';
      uploadedFile = listFormFiles(files.asset || files.file || files.preview || files.upload)[0] || null;
      if (!uploadedFile || !uploadedFile.filepath) {
        throw userError('Upload a file under field name "asset" or "file".');
      }
      originalName = uploadedFile.originalFilename || 'design';
    } else {
      // Buffer JSON
      const body = await new Promise((resolve) => {
        collectRequestBody(req, (err, payload) => {
          if (err) resolve(null); else resolve(payload);
        });
      });
      const json = body ? JSON.parse(body) : {};
      const urlToFetch = json.url || json.sourceUrl || null;
      displayName = json.title || '';
      categoryInput = json.category || 'Canva';
      if (!urlToFetch) throw userError('Provide url or send multipart with file.');
      const tempPath = path.join(os.tmpdir(), `canva-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
      await new Promise((resolve, reject) => {
        const client = urlToFetch.startsWith('https:') ? https : http;
        client.get(urlToFetch, (up) => {
          if (!up.statusCode || up.statusCode < 200 || up.statusCode >= 300) {
            reject(new Error(`Fetch failed (${up.statusCode})`));
            return;
          }
          const ws = fs.createWriteStream(tempPath);
          up.pipe(ws);
          ws.on('finish', () => { ws.close(() => resolve()); });
          ws.on('error', reject);
        }).on('error', reject);
      });
      uploadedFile = { filepath: tempPath, originalFilename: json.filename || 'design.png' };
      originalName = uploadedFile.originalFilename;
      cleanupTemp.push(tempPath);
    }

    // Determine category directory
    const newCategory = sanitizeCategoryFolderName(categoryInput || 'Canva');
    const dir = findCategoryDirectoryBySlug(slugify(newCategory)) || path.resolve(LIBRARY_ROOT, newCategory);
    ensureDirectorySafe(dir);
    const { previewsDir, sourcesDir } = ensureUploadsDirectories(dir);

    // Decide preview/source
    const ext = path.extname(originalName || '').toLowerCase();
    const isImage = ALLOWED_IMAGE_EXTENSIONS.has(ext);
    const vectorFmt = ALLOWED_SOURCE_EXTENSIONS.get(ext) || null;

    const nameBase = slugify(displayName || originalName.replace(/\.[^.]+$/, '')) || `design-${Date.now()}`;
    const previewBase = ensureUniqueBase(previewsDir, nameBase, isImage ? ext : '.png');
    let previewTarget = path.join(previewsDir, isImage ? (previewBase + ext) : (previewBase + '.png'));

    // Move/copy file(s)
    if (isImage) {
      fs.mkdirSync(path.dirname(previewTarget), { recursive: true });
      moveFile(uploadedFile.filepath, previewTarget);
    } else if (vectorFmt) {
      // Save vector into sources
      const srcName = `${previewBase}${ext}`;
      const sourceTarget = path.join(sourcesDir, srcName);
      fs.mkdirSync(path.dirname(sourceTarget), { recursive: true });
      moveFile(uploadedFile.filepath, sourceTarget);
      // Try to rasterize vector into PNG preview via sharp (SVG likely to succeed; PDF/AI may need external tools)
      try {
        const buf = fs.readFileSync(sourceTarget);
        await sharp(buf).png({ quality: 90 }).toFile(previewTarget);
      } catch (err) {
        console.error('Vector rasterization failed:', err.message || err);
        // Give up with 422; frontend can retry by uploading PNG preview
        sendJson(res, 422, { error: 'Unable to rasterize vector to preview. Upload a PNG preview instead.' });
        return;
      }
    } else {
      cleanupTemp.forEach((p) => deleteIfExists(p));
      throw userError('Unsupported file type. Use PNG/JPG/SVG/PDF/AI.');
    }

    await regenerateCatalog();
    const previewRelative = toWebRelative(previewTarget);
    const assetRoot = process.env.ASSET_BASE_URL || '';
    sendJson(res, 201, {
      success: true,
      design: {
        name: displayName || nameBase,
        preview: previewRelative,
        previewUrl: buildAssetProxyUrl(previewTarget, assetRoot),
        category: { name: path.basename(dir), slug: slugify(path.basename(dir)) }
      }
    });
  } catch (error) {
    console.error('Canva publish failed:', error);
    const status = error.statusCode && Number.isInteger(error.statusCode) ? error.statusCode : 500;
    sendJson(res, status, { error: error.message || 'Unable to publish from Canva.' });
  }
}

async function handleSquareWebhook(req, res) {
  try {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      if (!verifySquareWebhook(req.headers, rawBody)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid signature.' }));
        return;
      }

      const event = JSON.parse(rawBody || '{}');
      await processSquareEvent(event);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
  } catch (error) {
    console.error('Square webhook error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Webhook processing failed.' }));
  }
}

function verifySquareWebhook(headers, rawBody) {
  if (!SQUARE_WEBHOOK_SIGNATURE_KEY) {
    return true;
  }
  const signature = headers['x-square-hmacsha256-signature'];
  if (!signature) return false;
  const hmac = crypto.createHmac('sha256', SQUARE_WEBHOOK_SIGNATURE_KEY);
  hmac.update(rawBody);
  const expected = hmac.digest('base64');
  return signature === expected;
}

async function processSquareEvent(event) {
  const type = event?.type || '';
  if (!type.startsWith('payment.')) return;

  const payment = event?.data?.object?.payment;
  if (!payment) return;

  const status = payment.status;
  if (status !== 'COMPLETED') return;

  const referenceId = payment.referenceId || '';
  const paymentLinkId = payment.paymentLinkId || null;
  const squareOrderId = payment.orderId || null;

  let order = null;
  let quote = null;

  if (paymentLinkId) {
    order = db.fetchOrders().find((o) => o.paymentLinkId === paymentLinkId);
    if (!order) {
      quote = db.findRaceQuoteByPaymentLinkId(paymentLinkId);
    }
  }

  if (!order && referenceId && referenceId.startsWith('order-')) {
    const orderNumber = referenceId.replace('order-', '');
    order = db.fetchOrders().find((o) => String(o.orderNumber) === orderNumber);
  }

  if (!order && !quote && referenceId && referenceId.startsWith('quote-')) {
    const quoteId = referenceId.replace('quote-', '');
    quote = db.getRaceQuoteById(quoteId);
  }

  if (!order && referenceId) {
    order = db.getOrderById(referenceId);
  }

  if (!order && !quote && squareOrderId) {
    order = db.fetchOrders().find((o) => o.paymentDetails?.squareOrderId === squareOrderId);
  }

  if (!order && !quote && squareOrderId) {
    quote = db.fetchAllRaceQuotes().find((q) => q.paymentDetails?.squareOrderId === squareOrderId);
  }

  if (order) {
    db.markOrderPaid(order.id, {
      paymentId: payment.id,
      status: payment.status,
      amount: payment.amountMoney,
      receipt: payment.receiptUrl || null,
      paymentLinkId,
      squareOrderId
    });
    return;
  }

  if (quote) {
    db.markRaceQuotePaid(quote.id, {
      paymentId: payment.id,
      status: payment.status,
      amount: payment.amountMoney,
      receipt: payment.receiptUrl || null,
      paymentLinkId,
      squareOrderId
    });
  }
}

function sanitizeRaceQuoteRequest(payload = {}) {
  const business = String(payload.business || '').trim();
  const contactName = String(
    payload.customer || payload.customerName || payload.contactName || ''
  ).trim();
  if (!business) throw new Error('Business name is required.');
  if (!contactName) throw new Error('Customer name is required.');

  const requestDate = String(payload.date || payload.requestDate || '').trim();
  const vehicle = String(payload.vehicle || '').trim();
  const colors = String(payload.primaryColors || payload.colors || '').trim();

  const packageInput = String(payload.packageOption || payload.package || '').trim();
  const normalizedPackage = normalizePackageOption(packageInput);
  if (!normalizedPackage) {
    throw new Error('Choose one of the race package options.');
  }

  const notes = String(payload.notes || '').trim();
  const addons = Array.isArray(payload.addons)
    ? payload.addons
        .map((value) => String(value || '').trim())
        .filter((value) => value && value.length <= 120)
    : [];
  const racingBody = sanitizeCopy(payload.racingBody || payload.series || '', 80);
  const carNumber = sanitizeCopy(payload.carNumber || payload.car || '', 12);
  const coDriver = sanitizeCopy(payload.coDriver || payload.coDriverName || '', 80);
  const driverCountry = normalizeCountryCode(payload.driverCountry || payload.driverCountryCode);
  const coDriverCountry = normalizeCountryCode(payload.coDriverCountry || payload.coDriverCountryCode);
  const sponsors = normalizeSponsorEntries(payload.sponsors);

  return {
    business,
    contactName,
    requestDate,
    vehicle,
    colors,
    packageOption: normalizedPackage,
    addons,
    notes,
    racingBody,
    carNumber,
    coDriver,
    driverCountry,
    coDriverCountry,
    sponsors
  };
}

function sanitizeRaceQuoteAdminUpdate(payload = {}) {
  const updates = {};

  if (Object.prototype.hasOwnProperty.call(payload, 'business')) {
    updates.business = String(payload.business || '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'contactName')) {
    updates.contactName = String(payload.contactName || payload.customer || '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'requestDate')) {
    updates.requestDate = String(payload.requestDate || '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'vehicle')) {
    updates.vehicle = String(payload.vehicle || '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'colors')) {
    updates.colors = String(payload.colors || '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'packageOption')) {
    const normalizedPackage = normalizePackageOption(payload.packageOption);
    if (!normalizedPackage) {
      throw new Error('Unknown package option.');
    }
    updates.packageOption = normalizedPackage;
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'notes')) {
    updates.notes = String(payload.notes || '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'adminNotes')) {
    updates.adminNotes = String(payload.adminNotes || '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'racingBody')) {
    updates.racingBody = sanitizeCopy(payload.racingBody || '', 80);
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'carNumber')) {
    updates.carNumber = sanitizeCopy(payload.carNumber || '', 12);
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'coDriver')) {
    updates.coDriver = sanitizeCopy(payload.coDriver || '', 80);
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'driverCountry')) {
    updates.driverCountry = normalizeCountryCode(payload.driverCountry);
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'coDriverCountry')) {
    updates.coDriverCountry = normalizeCountryCode(payload.coDriverCountry);
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'sponsors')) {
    updates.sponsors = normalizeSponsorEntries(payload.sponsors);
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'timelineText')) {
    updates.timelineText = String(payload.timelineText || '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'deliveryText')) {
    updates.deliveryText = String(payload.deliveryText || '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'pricingNotes')) {
    updates.pricingNotes = String(payload.pricingNotes || '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'quoteValidUntil')) {
    updates.quoteValidUntil = String(payload.quoteValidUntil || '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'addons')) {
    updates.addons = Array.isArray(payload.addons)
      ? payload.addons
          .map((value) => String(value || '').trim())
          .filter((value) => value && value.length <= 120)
      : [];
  }

  const amountMappings = [
    ['baseCents', 'baseAmount'],
    ['addonsCents', 'addonsAmount'],
    ['subtotalCents', 'subtotalAmount'],
    ['taxCents', 'taxAmount'],
    ['totalCents', 'totalAmount']
  ];

  amountMappings.forEach(([centsKey, amountKey]) => {
    if (Object.prototype.hasOwnProperty.call(payload, centsKey)) {
      const value = Number(payload[centsKey]);
      updates[centsKey] = Number.isFinite(value) ? Math.round(value) : null;
    } else if (Object.prototype.hasOwnProperty.call(payload, amountKey)) {
      const normalized = normalizeMoneyInput(payload[amountKey]);
      if (normalized !== undefined) {
        updates[centsKey] = normalized;
      }
    }
  });

  if (Object.prototype.hasOwnProperty.call(payload, 'status')) {
    const status = String(payload.status || '').toLowerCase().trim();
    if (!VALID_QUOTE_STATUSES.has(status)) {
      throw new Error('Invalid quote status.');
    }
    updates.status = status;
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'paymentStatus')) {
    updates.paymentStatus = String(payload.paymentStatus || '').toUpperCase().trim();
  }

  return updates;
}

function normalizePackageOption(value) {
  if (!value) return null;
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (RACE_PACKAGE_OPTIONS[slug]) {
    return slug;
  }
  switch (slug) {
    case 'basic-number-kit':
    case 'basic':
    case 'number-kit':
      return 'basic';
    case 'sponsor-kit':
    case 'sponsor':
      return 'sponsor';
    case 'pro-package':
    case 'pro':
      return 'pro';
    case 'elite-custom-kit':
    case 'elite':
    case 'elite-kit':
      return 'elite';
    default:
      return null;
  }
}

function normalizeMoneyInput(value) {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    if (Math.abs(value) >= 1000 && Number.isInteger(value)) {
      return Math.round(value);
    }
    return Math.round(value * 100);
  }
  if (typeof value === 'string') {
    const cleaned = value.replace(/[^0-9.-]+/g, '');
    if (!cleaned) return undefined;
    const numeric = Number(cleaned);
    if (!Number.isFinite(numeric)) return undefined;
    if (Math.abs(numeric) >= 1000 && Number.isInteger(numeric)) {
      return Math.round(numeric);
    }
    return Math.round(numeric * 100);
  }
  return undefined;
}
