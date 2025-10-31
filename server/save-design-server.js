const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
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
//const sms = require('./sms');
const { SquareClient, SquareEnvironment } = require('square');
const { loadApparelCatalog } = require('./apparel-catalog');

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
const HOST = process.env.HOST || process.env.BIND_ADDRESS || '0.0.0.0';
const APP_ROOT = path.resolve(__dirname, '..');
const LIBRARY_ROOT = process.env.LIBRARY_ROOT
  ? path.resolve(process.env.LIBRARY_ROOT)
  : APP_ROOT;
const LIBRARY_WEB_DIR = path.join(LIBRARY_ROOT, 'web');
const WEB_DIR = fs.existsSync(LIBRARY_WEB_DIR) ? LIBRARY_WEB_DIR : path.join(APP_ROOT, 'web');
const DATA_DIR = path.join(LIBRARY_ROOT, 'data');
const OUTPUT_DIR = path.join(LIBRARY_ROOT, 'saved-designs');
const RACE_QUOTE_FILES_DIR = path.join(DATA_DIR, 'race-quote-files');
const PRODUCT_IMAGES_DIR = path.join(APP_ROOT, 'ProductImages');
const MAX_BODY_SIZE = 25 * 1024 * 1024; // 25 MB
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

// function getAdminSmsRecipients() {
//   return sms.parseRecipientList(process.env.SMS_ADMIN_RECIPIENTS || '');
// }

// function truncateSmsBody(value) {
//   if (!value) return '';
//   const text = String(value).trim();
//   if (text.length <= 320) {
//     return text;
//   }
//   return `${text.slice(0, 319)}…`;
// }

// function broadcastAdminSms(body) {
//   if (!sms.isConfigured()) return;
//   const recipients = getAdminSmsRecipients();
//   if (!recipients.length) return;
//   const message = truncateSmsBody(body);
//   if (!message) return;
//   recipients.forEach((recipient) => {
//     sms
//       .sendSms({ to: recipient, body: message })
//       .catch((error) => console.error('Twilio admin SMS failed:', error?.message || error));
//   });
// }

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
  //broadcastAdminSms(message);
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
  //broadcastAdminSms(parts.filter(Boolean).join(' · '));
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

function sanitizeUrl(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  if (/^\/productimages\//.test(trimmed)) {
    return trimmed;
  }
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    return new URL(trimmed).toString();
  } catch (error) {
    return null;
  }
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
  const size = sanitizeCopy(payload.size || '', 40) || null;
  const unit = sanitizeCopy(payload.unit || '', 16).toLowerCase() || null;
  const itemUrl =
    payload.itemUrl !== undefined || payload.url !== undefined
      ? sanitizeUrl(payload.itemUrl || payload.url)
      : null;
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
    size,
    itemUrl,
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
  if (payload.itemUrl !== undefined || payload.url !== undefined) {
    result.itemUrl = sanitizeUrl(payload.itemUrl || payload.url);
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

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function handleOptions(res) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
    'Access-Control-Max-Age': '86400'
  });
  res.end();
}

function decodeImage(dataUrl) {
  const match = /^data:image\/png;base64,(.+)$/.exec(dataUrl || '');
  if (!match) {
    throw new Error('Expected a PNG data URL.');
  }
  return Buffer.from(match[1], 'base64');
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'design';
}

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

    if (customerPayload?.email) {
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
          emailVerified: Boolean(customerRecord.emailVerified)
        }
      : customerPayload
      ? {
          name: customerPayload.name,
          email: customerPayload.email,
          phone: customerPayload.phone,
          address: customerPayload.address,
          emailVerified: false
        }
      : null;

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
      pricing: metadata.pricing || null,
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
      pricing: metadata.pricing || null,
      paymentLink: null,
      paymentLinkId: null,
      paymentStatus: 'UNPAID',
      paymentDetails: null,
      savedAt,
      paid: false,
      internalNotes: metadata.internalNotes || '',
      bytesWritten: buffer.length
    });

    notifyAdminsOfNewOrder({
      id: slug,
      orderNumber,
      quantity: metadata.quantity || 1,
      designName: metadata.designName || null,
      designId: metadata.designId || null,
      category: metadata.category || null,
      customer: customerSnapshot,
      pricing: metadata.pricing || null
    });

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
      address: customer.address || ''
    };
  } catch (error) {
    console.warn('Unable to resolve customer profile:', error.message || error);
    return null;
  }
}

function serveCatalogResponse(req, res) {
  const catalogPath = path.join(WEB_DIR, 'catalog.json');
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

function toApiOrder(order) {
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
    bytes: order.bytes
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

const requestHandler = (req, res) => {
  const parsedUrl = url.parse(req.url || '', true);
  const segments = (parsedUrl.pathname || '').split('/').filter(Boolean);

  if (req.method === 'OPTIONS') {
    handleOptions(res);
    return;
  }

  if (req.method === 'GET' && segments[0] === 'productimages') {
    serveProductImage(req, res, segments);
    return;
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && parsedUrl.pathname === '/api/catalog') {
    serveCatalogResponse(req, res);
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
        if (!payload.imageData) {
          sendJson(res, 400, { error: 'Missing imageData.' });
          return;
        }
        const result = persistDesign(payload);
        sendJson(res, 201, { success: true, ...result });
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
    collectRequestBody(req, (error, body) => {
      if (error) {
        sendJson(res, 413, { error: error.message });
        return;
      }
      try {
        const payload = body ? JSON.parse(body || '{}') : {};
        db.markOrderDownloaded(segments[3], payload.downloadedBy || null);
        const order = db.getOrderById(segments[3]);
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
    collectRequestBody(req, (error, body) => {
      if (error) {
        sendJson(res, 413, { error: error.message });
        return;
      }
      try {
        const payload = body ? JSON.parse(body || '{}') : {};
        db.markOrderCompleted(segments[3], payload.note || '');
        const order = db.getOrderById(segments[3]);
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

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
};

function createServerInstance() {
  if (httpsOptions) {
    return https.createServer(httpsOptions, requestHandler);
  }
  return http.createServer(requestHandler);
}

const server = createServerInstance();

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
        sources: savedSources
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
