const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const FormData = require('form-data');
const sharp = require('sharp');

const fetchModulePromise = import('node-fetch');
const fsPromises = fs.promises;

const DEFAULT_CATALOG_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours

let catalogCacheMemory = null;
let catalogCacheLoaded = false;

function getCatalogCachePath() {
  const cacheDir = path.join(app.getPath('userData'), 'cache');
  return path.join(cacheDir, 'catalog.json');
}

function normalizeCacheEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (!Object.prototype.hasOwnProperty.call(entry, 'data')) return null;
  return entry;
}

async function readCatalogCache() {
  if (catalogCacheLoaded && catalogCacheMemory) {
    return catalogCacheMemory;
  }

  const cachePath = getCatalogCachePath();
  try {
    const raw = await fsPromises.readFile(cachePath, 'utf8');
    const parsed = normalizeCacheEntry(JSON.parse(raw));
    catalogCacheMemory = parsed;
    catalogCacheLoaded = true;
    if (parsed && parsed.data) {
      annotateCatalog(parsed.data, {
        fromCache: true,
        staleFallback: false,
        fetchedAt: parsed.fetchedAt
      });
    }
    return parsed;
  } catch (error) {
    catalogCacheLoaded = true;
    if (error.code !== 'ENOENT') {
      console.warn('Failed to read catalog cache:', error);
    }
    return null;
  }
}

function annotateCatalog(data, meta = {}) {
  if (!data || typeof data !== 'object') return data;
  try {
    Object.defineProperty(data, '__catalogCache', {
      value: { ...meta },
      writable: true,
      configurable: true
    });
  } catch (error) {
    data.__catalogCache = { ...meta }; // Fallback if defineProperty fails
  }
  return data;
}

async function writeCatalogCache(data, timestamp = new Date().toISOString()) {
  const cachePath = getCatalogCachePath();
  try {
    await fsPromises.mkdir(path.dirname(cachePath), { recursive: true });
    const payload = {
      fetchedAt: timestamp,
      data
    };
    await fsPromises.writeFile(cachePath, JSON.stringify(payload, null, 2), 'utf8');
    catalogCacheMemory = payload;
    catalogCacheLoaded = true;
    annotateCatalog(data, { fromCache: false, staleFallback: false, fetchedAt: timestamp });
    return payload;
  } catch (error) {
    console.warn('Failed to write catalog cache:', error);
    return null;
  }
}

function isCacheFresh(cacheEntry, maxAgeMs) {
  if (!cacheEntry || !cacheEntry.fetchedAt) return false;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return false;
  const fetched = new Date(cacheEntry.fetchedAt).getTime();
  if (!Number.isFinite(fetched)) return false;
  return Date.now() - fetched <= maxAgeMs;
}

async function ensureFetch() {
  const mod = await fetchModulePromise;
  const fetchFn = mod.default || mod;
  const HeadersCtor = mod.Headers || global.Headers;
  if (typeof global.Headers !== 'function' && HeadersCtor) {
    global.Headers = HeadersCtor;
  }
  if (typeof global.Request !== 'function' && mod.Request) {
    global.Request = mod.Request;
  }
  if (typeof global.Response !== 'function' && mod.Response) {
    global.Response = mod.Response;
  }
  return { fetch: fetchFn, Headers: HeadersCtor || global.Headers };
}

const defaultSettings = {
  serverBaseUrl: 'http://localhost:4000',
  assetBaseUrl: '',
  apiKey: '',
  pollIntervalMs: 30000,
  employeeName: '',
  autoOpenPreview: true
};

let StoreConstructor = null;
let store = null;

const storeReady = import('electron-store')
  .then((mod) => {
    StoreConstructor = mod.default || mod;
    store = new StoreConstructor({
      name: 'print-station-settings',
      defaults: defaultSettings
    });
  })
  .catch((error) => {
    console.error('Failed to initialize settings store:', error);
    throw error;
  });

function assertStore() {
  if (!store) {
    throw new Error('Settings store is not ready yet.');
  }
}

function getSettings() {
  assertStore();
  return { ...defaultSettings, ...store.store };
}

function updateSettings(updates = {}) {
  assertStore();
  const next = { ...getSettings(), ...updates };
  store.set(next);
  return next;
}

function ensureServerConfigured() {
  assertStore();
  const settings = getSettings();
  if (!settings.serverBaseUrl) {
    throw new Error('Server base URL is not configured.');
  }
  return settings;
}

function sanitizeSegment(value, fallback = 'item') {
  const result = String(value || '')
    .normalize('NFKD')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .trim()
    .slice(0, 60);
  return result || fallback;
}

function escapeSvg(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function countryCodeToFlagEmoji(code) {
  if (!code || typeof code !== 'string' || code.length !== 2) return '';
  const upper = code.toUpperCase();
  const base = 127397;
  return String.fromCodePoint(...upper.split('').map((char) => base + char.charCodeAt(0)));
}

function estimateFontSize(text, width, { min = 240, max = 1400 } = {}) {
  const normalized = String(text || '').trim();
  const length = normalized ? normalized.replace(/\s+/g, '').length || normalized.length : 1;
  const estimate = Math.round((width * 0.8) / length);
  return Math.max(min, Math.min(max, estimate));
}

const COUNTRY_DATA = `
AF|Afghanistan
AX|Aland Islands
AL|Albania
DZ|Algeria
AS|American Samoa
AD|Andorra
AO|Angola
AI|Anguilla
AQ|Antarctica
AG|Antigua and Barbuda
AR|Argentina
AM|Armenia
AW|Aruba
AU|Australia
AT|Austria
AZ|Azerbaijan
BS|Bahamas
BH|Bahrain
BD|Bangladesh
BB|Barbados
BY|Belarus
BE|Belgium
BZ|Belize
BJ|Benin
BM|Bermuda
BT|Bhutan
BO|Bolivia
BQ|Bonaire
BA|Bosnia and Herzegovina
BW|Botswana
BV|Bouvet Island
BR|Brazil
IO|British Indian Ocean Territory
BN|Brunei
BG|Bulgaria
BF|Burkina Faso
BI|Burundi
KH|Cambodia
CM|Cameroon
CA|Canada
CV|Cape Verde
KY|Cayman Islands
CF|Central African Republic
TD|Chad
CL|Chile
CN|China
CX|Christmas Island
CC|Cocos Islands
CO|Colombia
KM|Comoros
CG|Congo
CD|Congo (DRC)
CK|Cook Islands
CR|Costa Rica
CI|Cote d'Ivoire
HR|Croatia
CU|Cuba
CW|Curacao
CY|Cyprus
CZ|Czech Republic
DK|Denmark
DJ|Djibouti
DM|Dominica
DO|Dominican Republic
EC|Ecuador
EG|Egypt
SV|El Salvador
GQ|Equatorial Guinea
ER|Eritrea
EE|Estonia
SZ|Eswatini
ET|Ethiopia
FK|Falkland Islands
FO|Faroe Islands
FJ|Fiji
FI|Finland
FR|France
GF|French Guiana
PF|French Polynesia
TF|French Southern Territories
GA|Gabon
GM|Gambia
GE|Georgia
DE|Germany
GH|Ghana
GI|Gibraltar
GR|Greece
GL|Greenland
GD|Grenada
GP|Guadeloupe
GU|Guam
GT|Guatemala
GG|Guernsey
GN|Guinea
GW|Guinea-Bissau
GY|Guyana
HT|Haiti
HM|Heard Island and McDonald Islands
VA|Vatican City
HN|Honduras
HK|Hong Kong
HU|Hungary
IS|Iceland
IN|India
ID|Indonesia
IR|Iran
IQ|Iraq
IE|Ireland
IM|Isle of Man
IL|Israel
IT|Italy
JM|Jamaica
JP|Japan
JE|Jersey
JO|Jordan
KZ|Kazakhstan
KE|Kenya
KI|Kiribati
KP|North Korea
KR|South Korea
KW|Kuwait
KG|Kyrgyzstan
LA|Laos
LV|Latvia
LB|Lebanon
LS|Lesotho
LR|Liberia
LY|Libya
LI|Liechtenstein
LT|Lithuania
LU|Luxembourg
MO|Macau
MG|Madagascar
MW|Malawi
MY|Malaysia
MV|Maldives
ML|Mali
MT|Malta
MH|Marshall Islands
MQ|Martinique
MR|Mauritania
MU|Mauritius
YT|Mayotte
MX|Mexico
FM|Micronesia
MD|Moldova
MC|Monaco
MN|Mongolia
ME|Montenegro
MS|Montserrat
MA|Morocco
MZ|Mozambique
MM|Myanmar
NA|Namibia
NR|Nauru
NP|Nepal
NL|Netherlands
NC|New Caledonia
NZ|New Zealand
NI|Nicaragua
NE|Niger
NG|Nigeria
NU|Niue
NF|Norfolk Island
MK|North Macedonia
MP|Northern Mariana Islands
NO|Norway
OM|Oman
PK|Pakistan
PW|Palau
PS|Palestine
PA|Panama
PG|Papua New Guinea
PY|Paraguay
PE|Peru
PH|Philippines
PN|Pitcairn Islands
PL|Poland
PT|Portugal
PR|Puerto Rico
QA|Qatar
RE|Reunion
RO|Romania
RU|Russia
RW|Rwanda
BL|Saint Barthelemy
SH|Saint Helena
KN|Saint Kitts and Nevis
LC|Saint Lucia
MF|Saint Martin
PM|Saint Pierre and Miquelon
VC|Saint Vincent and the Grenadines
WS|Samoa
SM|San Marino
ST|Sao Tome and Principe
SA|Saudi Arabia
SN|Senegal
RS|Serbia
SC|Seychelles
SL|Sierra Leone
SG|Singapore
SX|Sint Maarten
SK|Slovakia
SI|Slovenia
SB|Solomon Islands
SO|Somalia
ZA|South Africa
GS|South Georgia and South Sandwich Islands
SS|South Sudan
ES|Spain
LK|Sri Lanka
SD|Sudan
SR|Suriname
SJ|Svalbard and Jan Mayen
SE|Sweden
CH|Switzerland
SY|Syria
TW|Taiwan
TJ|Tajikistan
TZ|Tanzania
TH|Thailand
TL|Timor-Leste
TG|Togo
TK|Tokelau
TO|Tonga
TT|Trinidad and Tobago
TN|Tunisia
TR|Turkey
TM|Turkmenistan
TC|Turks and Caicos Islands
TV|Tuvalu
UG|Uganda
UA|Ukraine
AE|United Arab Emirates
GB|United Kingdom
US|United States
UM|United States Minor Outlying Islands
VI|United States Virgin Islands
UY|Uruguay
UZ|Uzbekistan
VU|Vanuatu
VE|Venezuela
VN|Vietnam
VG|British Virgin Islands
WF|Wallis and Futuna
EH|Western Sahara
YE|Yemen
ZM|Zambia
ZW|Zimbabwe
`.trim();

const COUNTRY_NAMES = COUNTRY_DATA.split('\n').reduce((acc, line) => {
  const [code, name] = line.split('|');
  if (code && name) {
    acc[code] = name;
  }
  return acc;
}, Object.create(null));

function buildQuoteAssetConfigs(quote) {
  const basePrefix = sanitizeSegment(
    quote.quoteNumber ? `quote-${quote.quoteNumber}` : quote.business || quote.id || 'quote'
  );
  const assets = [];

  if (quote.carNumber) {
    const numberText = String(quote.carNumber).trim().toUpperCase();
    if (numberText) {
      const width = 3600;
      const height = 2400;
      const fontSize = estimateFontSize(numberText, width, { min: 800, max: 2000 });
      assets.push({
        fileName: `${basePrefix}-car-number-${sanitizeSegment(numberText, 'number')}.jpg`,
        width,
        height,
        background: '#ffffff',
        textColor: '#111827',
        lines: [{ text: numberText, fontSize, fontWeight: '800', letterSpacing: '12' }]
      });
    }
  }

  if (quote.contactName) {
    const name = String(quote.contactName).trim();
    if (name) {
      const width = 3600;
      const height = 1600;
      const upperName = name.toUpperCase();
      const nameFont = estimateFontSize(upperName, width, { min: 520, max: 1400 });
      const countryName = COUNTRY_NAMES[quote.driverCountry?.toUpperCase?.() || ''] || quote.driverCountry || '';
      const flagEmoji = countryCodeToFlagEmoji(quote.driverCountry);
      const detailText = [flagEmoji, countryName].filter(Boolean).join(' ').trim();
      const lines = [
        { text: upperName, fontSize: nameFont, fontWeight: '800', letterSpacing: '8' }
      ];
      if (detailText) {
        lines.push({
          text: detailText,
          fontSize: Math.max(360, Math.round(nameFont * 0.45)),
          fontWeight: '600',
          letterSpacing: '4'
        });
      }
      assets.push({
        fileName: `${basePrefix}-driver-${sanitizeSegment(name, 'driver')}.jpg`,
        width,
        height,
        background: '#ffffff',
        textColor: '#111827',
        lines
      });
    }
  }

  if (quote.coDriver) {
    const name = String(quote.coDriver).trim();
    if (name) {
      const width = 3600;
      const height = 1600;
      const upperName = name.toUpperCase();
      const nameFont = estimateFontSize(upperName, width, { min: 520, max: 1300 });
      const countryName =
        COUNTRY_NAMES[quote.coDriverCountry?.toUpperCase?.() || ''] || quote.coDriverCountry || '';
      const flagEmoji = countryCodeToFlagEmoji(quote.coDriverCountry);
      const detailText = [flagEmoji, countryName].filter(Boolean).join(' ').trim();
      const lines = [
        { text: upperName, fontSize: nameFont, fontWeight: '800', letterSpacing: '8' }
      ];
      if (detailText) {
        lines.push({
          text: detailText,
          fontSize: Math.max(340, Math.round(nameFont * 0.45)),
          fontWeight: '600',
          letterSpacing: '4'
        });
      }
      assets.push({
        fileName: `${basePrefix}-co-driver-${sanitizeSegment(name, 'co-driver')}.jpg`,
        width,
        height,
        background: '#ffffff',
        textColor: '#111827',
        lines
      });
    }
  }

  if (Array.isArray(quote.sponsors)) {
    quote.sponsors.forEach((sponsor, index) => {
      const sponsorName = String(sponsor?.name || '').trim();
      if (!sponsorName) return;
      const width = 3200;
      const height = 1400;
      const upperName = sponsorName.toUpperCase();
      const nameFont = estimateFontSize(upperName, width, { min: 420, max: 1100 });
      const detailParts = [];
      if (sponsor.size) {
        detailParts.push(`Size: ${String(sponsor.size).toUpperCase()}`);
      }
      if (sponsor.color) {
        detailParts.push(`Color: ${sponsor.color}`);
      }
      if (sponsor.apparel) {
        detailParts.push('Include on apparel');
      }
      const detailText = detailParts.join(' • ');
      const lines = [
        { text: upperName, fontSize: nameFont, fontWeight: '800', letterSpacing: '6' }
      ];
      if (detailText) {
        lines.push({
          text: detailText,
          fontSize: Math.max(320, Math.round(nameFont * 0.5)),
          fontWeight: '500',
          letterSpacing: '2'
        });
      }
      assets.push({
        fileName: `${basePrefix}-sponsor-${index + 1}-${sanitizeSegment(
          sponsorName,
          `sponsor-${index + 1}`
        )}.jpg`,
        width,
        height,
        background: '#ffffff',
        textColor: '#111827',
        lines
      });
    });
  }

  if (!assets.length) {
    throw new Error('No car numbers, driver names, or sponsors available to generate assets.');
  }

  return assets;
}

function createTextSvg({ width, height, background, textColor, lines }) {
  const sanitizedLines = (lines || []).map((line) => ({
    text: String(line?.text || '').trim(),
    fontSize: Number(line?.fontSize) || 400,
    fontFamily: line?.fontFamily || '"Impact","Arial Black","Montserrat",sans-serif',
    fontWeight: line?.fontWeight || '700',
    letterSpacing: line?.letterSpacing || '4',
    lineHeight: Number(line?.lineHeight) || 1.1,
    textColor: line?.textColor || textColor || '#111827'
  })).filter((line) => line.text);

  if (!sanitizedLines.length) {
    throw new Error('No text lines provided for SVG generation.');
  }

  const totalHeight = sanitizedLines.reduce(
    (sum, line) => sum + line.fontSize * line.lineHeight,
    0
  );
  const startY = (height - totalHeight) / 2;
  let cursorY = startY;

  const textNodes = sanitizedLines
    .map((line) => {
      const centerY = cursorY + (line.fontSize * line.lineHeight) / 2;
      cursorY += line.fontSize * line.lineHeight;
      return `<text x="50%" y="${centerY.toFixed(
        2
      )}" text-anchor="middle" font-family=${JSON.stringify(line.fontFamily)} font-size="${
        line.fontSize
      }" font-weight="${line.fontWeight}" letter-spacing="${line.letterSpacing}" fill="${
        line.textColor
      }" dominant-baseline="middle">${escapeSvg(line.text)}</text>`;
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="${background || '#ffffff'}" />
    ${textNodes}
  </svg>`;
}

async function renderTextAsset(config, outputPath) {
  const svg = createTextSvg(config);
  await sharp(Buffer.from(svg))
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4', mozjpeg: true })
    .toFile(outputPath);
}

async function generateQuoteAssets(quoteId) {
  if (!quoteId) {
    throw new Error('Quote id is required for asset generation.');
  }

  const detail = await fetchRaceQuoteDetail(quoteId);
  const quote = detail?.quote;
  if (!quote) {
    throw new Error('Unable to load quote details.');
  }

  const browserWindow = BrowserWindow.getFocusedWindow();
  const defaultFolderName = sanitizeSegment(
    quote.quoteNumber ? `quote-${quote.quoteNumber}` : quote.business || quote.id || 'quote'
  );
  const defaultPath = path.join(app.getPath('documents'), defaultFolderName);

  const selection = await dialog.showOpenDialog(browserWindow || undefined, {
    title: 'Select destination folder',
    defaultPath,
    properties: ['openDirectory', 'createDirectory']
  });

  if (selection.canceled || !selection.filePaths?.length) {
    return { success: false, cancelled: true };
  }

  const targetRoot = selection.filePaths[0];
  const outputDir = path.join(targetRoot, defaultFolderName);
  fs.mkdirSync(outputDir, { recursive: true });

  const assets = buildQuoteAssetConfigs(quote);
  const generatedFiles = [];

  for (const asset of assets) {
    const outputPath = path.join(outputDir, asset.fileName);
    await renderTextAsset(asset, outputPath);
    generatedFiles.push(outputPath);
  }

  return {
    success: true,
    outputDir,
    files: generatedFiles
  };
}

async function httpRequest(pathname, options = {}) {
  const { fetch: doFetch, Headers: HeadersCtor } = await ensureFetch();
  const settings = ensureServerConfigured();
  const url = new URL(pathname, settings.serverBaseUrl);
  const { query, method = 'GET', body, headers = {} } = options;

  if (query && typeof query === 'object') {
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, value);
      }
    });
  }

  const requestHeaders = new HeadersCtor({
    Accept: 'application/json',
    ...headers
  });

  if (settings.apiKey) {
    requestHeaders.set('X-API-Key', settings.apiKey);
  }

  let payload = body;
  if (body && typeof body === 'object' && typeof body.getHeaders === 'function') {
    const formHeaders = body.getHeaders();
    Object.entries(formHeaders).forEach(([key, value]) => {
      requestHeaders.set(key, value);
    });
  } else if (body && typeof body === 'object' && !(body instanceof Buffer)) {
    requestHeaders.set('Content-Type', 'application/json');
    payload = JSON.stringify(body);
  }

  const response = await doFetch(url, {
    method,
    headers: requestHeaders,
    body: payload
  });

  const contentType = response.headers.get('content-type') || '';
  if (!response.ok) {
    let detail = null;
    if (contentType.includes('application/json')) {
      try {
        detail = await response.json();
      } catch (_) {
        detail = null;
      }
    } else {
      detail = await response.text();
    }
    const message =
      typeof detail === 'object' && detail && detail.error
        ? detail.error
        : detail || `Request failed with status ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.detail = detail;
    throw error;
  }

  if (response.status === 204) {
    return null;
  }

  if (contentType.includes('application/json')) {
    return response.json();
  }

  return response.text();
}

async function fetchQueue({ since } = {}) {
  return httpRequest('/api/internal/orders/queue', {
    method: 'GET',
    query: since ? { since } : undefined
  });
}

async function listOrders() {
  return httpRequest('/api/orders', { method: 'GET' });
}

async function markDownloaded({ orderId, downloadedBy }) {
  if (!orderId) throw new Error('orderId is required.');
  return httpRequest(`/api/internal/orders/${encodeURIComponent(orderId)}/acknowledge`, {
    method: 'PATCH',
    body: downloadedBy ? { downloadedBy } : {}
  });
}

async function markCompleted({ orderId, note }) {
  if (!orderId) throw new Error('orderId is required.');
  return httpRequest(`/api/internal/orders/${encodeURIComponent(orderId)}/completed`, {
    method: 'PATCH',
    body: note ? { note } : {}
  });
}

async function fetchCatalog(options = {}) {
  const { forceRefresh = false } = options || {};
  let maxAgeMs = DEFAULT_CATALOG_CACHE_MAX_AGE_MS;
  if (options && Object.prototype.hasOwnProperty.call(options, 'maxAgeMs')) {
    const parsed = Number(options.maxAgeMs);
    if (Number.isFinite(parsed)) {
      maxAgeMs = parsed;
    }
  }

  const cached = await readCatalogCache();
  if (!forceRefresh && maxAgeMs > 0 && isCacheFresh(cached, maxAgeMs)) {
    return annotateCatalog(cached.data, {
      fromCache: true,
      staleFallback: false,
      fetchedAt: cached?.fetchedAt
    });
  }

  try {
    const catalog = await httpRequest('/api/catalog', { method: 'GET' });
    const payload = await writeCatalogCache(catalog);
    return annotateCatalog(catalog, {
      fromCache: false,
      staleFallback: false,
      fetchedAt: payload?.fetchedAt
    });
  } catch (error) {
    if (cached && cached.data) {
      console.warn('Catalog fetch failed, serving cached copy:', error);
      return annotateCatalog(cached.data, {
        fromCache: true,
        staleFallback: true,
        fetchedAt: cached?.fetchedAt
      });
    }
    throw error;
  }
}

async function fetchRaceQuotes() {
  return httpRequest('/api/internal/race-quotes', { method: 'GET' });
}

async function fetchRaceQuoteDetail(id) {
  return httpRequest(`/api/internal/race-quotes/${encodeURIComponent(id)}`, { method: 'GET' });
}

async function updateRaceQuote(id, payload) {
  return httpRequest(`/api/internal/race-quotes/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {})
  });
}

async function postRaceQuoteMessage(id, message) {
  return httpRequest(`/api/internal/race-quotes/${encodeURIComponent(id)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message })
  });
}

async function fetchInventory(options = {}) {
  const { material } = options;
  const query =
    material && material !== 'all'
      ? { material }
      : undefined;
  return httpRequest('/api/inventory', {
    method: 'GET',
    query
  });
}

async function createInventoryItem(payload = {}) {
  const body = { ...payload };
  return httpRequest('/api/inventory', {
    method: 'POST',
    body
  });
}

async function adjustInventory(payload = {}) {
  const { itemId, change, notes, reason } = payload;
  if (!itemId) {
    throw new Error('Inventory item id is required.');
  }
  const numericChange = Number(change);
  if (!Number.isFinite(numericChange) || Math.round(numericChange) === 0) {
    throw new Error('Enter a non-zero adjustment amount.');
  }
  return httpRequest(`/api/inventory/${encodeURIComponent(itemId)}/adjust`, {
    method: 'POST',
    body: {
      change: Math.round(numericChange),
      notes: notes || undefined,
      reason: reason || undefined
    }
  });
}

async function updateInventory(payload = {}) {
  const { itemId, ...updates } = payload;
  if (!itemId) {
    throw new Error('Inventory item id is required.');
  }
  return httpRequest(`/api/inventory/${encodeURIComponent(itemId)}`, {
    method: 'PATCH',
    body: updates
  });
}

async function downloadFile({ url, filename }) {
  const settings = ensureServerConfigured();
  if (!url) {
    throw new Error('File URL is required.');
  }

  let resolvedUrl;
  try {
    resolvedUrl = new URL(url, settings.serverBaseUrl);
  } catch (error) {
    throw new Error('Invalid download URL.');
  }

  const { fetch: doFetch, Headers: HeadersCtor } = await ensureFetch();
  const headers = new HeadersCtor({ Accept: 'application/octet-stream' });
  if (settings.apiKey) {
    headers.set('X-API-Key', settings.apiKey);
  }

  const response = await doFetch(resolvedUrl, { method: 'GET', headers });
  if (!response.ok) {
    const message = await response.text().catch(() => '');
    throw new Error(message || `Download failed (${response.status})`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const suggestedName = filename || path.basename(resolvedUrl.pathname) || 'download.png';
  const defaultPath = path.join(app.getPath('downloads'), suggestedName);

  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath,
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (canceled || !filePath) {
    return { canceled: true };
  }

  await fs.promises.writeFile(filePath, buffer);
  return { canceled: false, filePath };
}

async function uploadArtwork(params) {
  const {
    previewPath,
    sourcePaths = [],
    categoryMode,
    existingCategory,
    newCategoryName,
    displayName,
    apparel
  } = params || {};

  if (!previewPath) {
    throw new Error('Select a preview image before uploading.');
  }

  const settings = ensureServerConfigured();
  const url = new URL('/api/admin/artwork', settings.serverBaseUrl);
  const form = new FormData();

  form.append('displayName', displayName || '');
  form.append('categoryMode', categoryMode || 'existing');
  if (categoryMode === 'existing' && existingCategory) {
    form.append('category', existingCategory);
  }
  if (categoryMode === 'new' && newCategoryName) {
    form.append('newCategoryName', newCategoryName);
  }

  if (apparel?.enabled) {
    form.append('apparelEnabled', 'true');
    if (apparel.productType) {
      form.append('apparelProductType', String(apparel.productType));
    }
  }

  form.append('preview', fs.createReadStream(previewPath));
  sourcePaths.filter(Boolean).forEach((filePath) => {
    form.append('sources', fs.createReadStream(filePath));
  });

  const headers = form.getHeaders();
  if (settings.apiKey) {
    headers['X-API-Key'] = settings.apiKey;
  }

  const { fetch: doFetch } = await ensureFetch();

  const response = await doFetch(url, {
    method: 'POST',
    body: form,
    headers
  });

  const contentType = response.headers.get('content-type') || '';
  if (!response.ok) {
    let detail;
    if (contentType.includes('application/json')) {
      detail = await response.json().catch(() => null);
    } else {
      detail = await response.text();
    }
    const message =
      detail && typeof detail === 'object' && detail.error
        ? detail.error
        : detail || `Upload failed with status ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.detail = detail;
    throw error;
  }
  return response.json();
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1100,
    minHeight: 720,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    show: false
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  return mainWindow;
}

function registerIpcHandlers() {
  ipcMain.handle('config:get', () => getSettings());

  ipcMain.handle('config:set', (_event, updates) => updateSettings(updates || {}));

  ipcMain.handle('queue:fetch', (_event, args) => fetchQueue(args || {}));

  ipcMain.handle('queue:ack', (_event, payload) => markDownloaded(payload || {}));

  ipcMain.handle('queue:complete', (_event, payload) => markCompleted(payload || {}));

  ipcMain.handle('orders:list', () => listOrders());

  ipcMain.handle('catalog:fetch', (_event, options) => fetchCatalog(options || {}));

  ipcMain.handle('artwork:upload', (_event, payload) => uploadArtwork(payload || {}));

  ipcMain.handle('quotes:fetch', () => fetchRaceQuotes());
  ipcMain.handle('quotes:detail', (_event, id) => fetchRaceQuoteDetail(id));
  ipcMain.handle('quotes:update', (_event, { id, payload }) => updateRaceQuote(id, payload || {}));
  ipcMain.handle('quotes:message', (_event, { id, message }) => postRaceQuoteMessage(id, message));
  ipcMain.handle('quotes:generate-assets', (_event, { id }) => generateQuoteAssets(id));
  ipcMain.handle('inventory:list', (_event, options) => fetchInventory(options || {}));
  ipcMain.handle('inventory:create', (_event, payload) => createInventoryItem(payload || {}));
  ipcMain.handle('inventory:adjust', (_event, payload) => adjustInventory(payload || {}));
  ipcMain.handle('inventory:update', (_event, payload) => updateInventory(payload || {}));
  ipcMain.handle('files:download', (_event, payload) => downloadFile(payload || {}));

  ipcMain.handle('dialog:selectFiles', async (_event, options = {}) => {
    const result = await dialog.showOpenDialog({
      title: options.title || 'Select files',
      properties: options.properties || ['openFile'],
      filters: options.filters || []
    });
    if (result.canceled) {
      return [];
    }
    return result.filePaths;
  });

  ipcMain.handle('system:openExternal', (_event, target) => {
    if (!target) return false;
    return shell.openExternal(target);
  });
}

app.on('ready', async () => {
  try {
    await storeReady;
  } catch (error) {
    dialog.showErrorBox(
      'Print Station Error',
      `Unable to initialize settings store:\n\n${error.message || error}`
    );
    app.quit();
    return;
  }

  registerIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
