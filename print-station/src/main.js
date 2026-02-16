const { app, BrowserWindow, ipcMain, dialog, shell, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const FormData = require('form-data');
const sharp = require('sharp');
const cp = require('child_process');
const os = require('os');
const { LocalCatalogDB } = require('./local-db');
const { PrinterFleetDB } = require('./printer-fleet-db');
const { PrinterService } = require('./printer-service');
const chokidar = require('chokidar');
let autoUpdater = null;
let tesseractWorker = null;

// Configure sharp to limit memory usage
// Reduce cache to 50MB and limit concurrency to 2 threads
sharp.cache({ memory: 50, files: 20, items: 100 });
sharp.concurrency(2);

// Store update state
let updateState = {
  checking: false,
  available: false,
  downloaded: false,
  error: null,
  progress: null,
  version: null
};

// Send update status to renderer
function sendUpdateStatus(win) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('update:status', updateState);
  }
}

// Initialize auto-updater events
function initAutoUpdater(win) {
  // Load the autoUpdater module now that app is ready
  try {
    autoUpdater = require('electron-updater').autoUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
  } catch (err) {
    console.error('[AutoUpdater] Failed to initialize:', err.message);
    return; // Don't set up events if module failed to load
  }

  autoUpdater.on('checking-for-update', () => {
    console.log('[AutoUpdater] Checking for updates...');
    updateState = { ...updateState, checking: true, error: null };
    sendUpdateStatus(win);
  });

  autoUpdater.on('update-available', (info) => {
    console.log('[AutoUpdater] Update available:', info.version);
    updateState = { ...updateState, checking: false, available: true, version: info.version };
    sendUpdateStatus(win);
  });

  autoUpdater.on('update-not-available', (info) => {
    console.log('[AutoUpdater] No update available. Current:', info.version);
    updateState = { ...updateState, checking: false, available: false };
    sendUpdateStatus(win);
  });

  autoUpdater.on('download-progress', (progress) => {
    console.log(`[AutoUpdater] Download progress: ${progress.percent.toFixed(1)}%`);
    updateState = { ...updateState, progress: progress };
    sendUpdateStatus(win);
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[AutoUpdater] Update downloaded:', info.version);
    updateState = { ...updateState, downloaded: true, progress: null, version: info.version };
    sendUpdateStatus(win);

    // Notify user
    if (win && !win.isDestroyed()) {
      dialog.showMessageBox(win, {
        type: 'info',
        title: 'Update Ready',
        message: `Version ${info.version} has been downloaded.`,
        detail: 'The update will be installed when you restart the application.',
        buttons: ['Restart Now', 'Later']
      }).then(({ response }) => {
        if (response === 0) {
          autoUpdater.quitAndInstall();
        }
      });
    }
  });

  autoUpdater.on('error', (err) => {
    console.error('[AutoUpdater] Error:', err.message);
    updateState = { ...updateState, checking: false, error: err.message };
    sendUpdateStatus(win);
  });

  // Check for updates after a short delay (give app time to fully load)
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(err => {
      console.error('[AutoUpdater] Check failed:', err.message);
    });
  }, 10000); // 10 second delay

  // Check for updates every 4 hours
  setInterval(() => {
    autoUpdater.checkForUpdates().catch(err => {
      console.error('[AutoUpdater] Periodic check failed:', err.message);
    });
  }, 4 * 60 * 60 * 1000);
}

// IPC handlers for updates
ipcMain.handle('update:check', async () => {
  if (!autoUpdater) return { success: false, error: 'Auto-updater not initialized' };
  try {
    const result = await autoUpdater.checkForUpdates();
    return { success: true, updateInfo: result?.updateInfo };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('update:download', async () => {
  if (!autoUpdater) return { success: false, error: 'Auto-updater not initialized' };
  try {
    await autoUpdater.downloadUpdate();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('update:install', () => {
  if (!autoUpdater) return;
  autoUpdater.quitAndInstall();
});

ipcMain.handle('update:getStatus', () => {
  return updateState;
});

ipcMain.handle('update:getVersion', () => {
  return app.getVersion();
});

const fetchModulePromise = import('node-fetch');
const fsPromises = fs.promises;

const DEFAULT_CATALOG_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const VECTOR_EXTENSIONS = new Set(['.svg']);
const DOC_EXTENSIONS = new Set(['.pdf', '.ai', '.eps']);
const SCAN_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...VECTOR_EXTENSIONS, ...DOC_EXTENSIONS]);

let localDb = null;
let fleetDb = null;
let printerService = null;
let fileWatcher = null;
let watchConfig = null;
const cancelledJobs = new Set();

function ensureLocalDb() {
  if (localDb) return localDb;
  try {
    localDb = new LocalCatalogDB(app);
  } catch (err) {
    console.warn('Local catalog DB unavailable:', err?.message || err);
    localDb = null;
  }
  return localDb;
}

function getCatalogCachePath(suffix = '') {
  const cacheDir = path.join(app.getPath('userData'), 'cache');
  return path.join(cacheDir, `catalog${suffix}.json`);
}

function normalizeCacheEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (!Object.prototype.hasOwnProperty.call(entry, 'data')) return null;
  return entry;
}

// In-memory cache keyed by suffix
const catalogCacheByType = new Map();

async function readCatalogCache(suffix = '') {
  // Check in-memory cache first
  if (catalogCacheByType.has(suffix)) {
    return catalogCacheByType.get(suffix);
  }

  const cachePath = getCatalogCachePath(suffix);
  try {
    const raw = await fsPromises.readFile(cachePath, 'utf8');
    const parsed = normalizeCacheEntry(JSON.parse(raw));
    catalogCacheByType.set(suffix, parsed);
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

async function writeCatalogCache(data, suffix = '', timestamp = new Date().toISOString()) {
  const cachePath = getCatalogCachePath(suffix);
  try {
    await fsPromises.mkdir(path.dirname(cachePath), { recursive: true });
    const payload = {
      fetchedAt: timestamp,
      data
    };
    await fsPromises.writeFile(cachePath, JSON.stringify(payload, null, 2), 'utf8');
    catalogCacheByType.set(suffix, payload);
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
  assetBaseUrl: 'http://localhost:4000',
  apiKey: '',
  pollIntervalMs: 30000,
  employeeName: '',
  autoOpenPreview: true,
  watchEnabled: false,
  watchFolder: '',
  watchAutoImport: true,
  watchOcr: true,
  watchAutoApprove: false,
  watchAutoMockup: false,
  watchMockupBackground: '',
  watchMockupOutputDir: '',
  watchMockupWidthPct: 40,
  watchMockupYOffsetPct: 0,
  watchMockupKeyColor: '#ffffff',
  watchMockupFuzzPct: 10
  ,
  // Preview optimization (optional background removal)
  previewRemoveBgEnabled: false,
  previewKeyColor: '#ffffff',
  previewFuzzPct: 8
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
  const settings = { ...defaultSettings, ...store.store };
  // Auto-populate apiKey from environment if not explicitly configured
  if (!settings.apiKey) {
    settings.apiKey = process.env.INTERNAL_API_KEY || process.env.PRINT_STATION_API_KEY || '';
  }
  return settings;
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

  // Debug logging for campaign updates
  if (pathname.includes('/campaigns/')) {
    console.log(`[httpRequest] ${method} ${url.toString()}`);
    if (body && typeof body === 'object' && body.items && Array.isArray(body.items) && body.items.length > 0) {
      console.log(`[httpRequest] Request body has ${body.items.length} items`);
      console.log(`[httpRequest] First item mockupImage: ${body.items[0].mockupImage || 'NONE'}`);
      console.log(`[httpRequest] First item shopifyProductId: ${body.items[0].shopifyProductId || 'NONE'}`);
    }
  }

  const response = await doFetch(url, {
    method,
    headers: requestHeaders,
    body: payload
  });

  // Debug logging for campaign update responses
  if (pathname.includes('/campaigns/')) {
    console.log(`[httpRequest] Response status: ${response.status} ${response.statusText}`);
  }

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
    console.error(`[httpRequest] Request failed:`, error);
    throw error;
  }

  if (response.status === 204) {
    return null;
  }

  if (contentType.includes('application/json')) {
    const json = await response.json();
    // Debug logging for campaign update responses
    if (pathname.includes('/campaigns/') && json && json.campaign && json.campaign.items) {
      console.log(`[httpRequest] Response has campaign with ${json.campaign.items.length} items`);
      if (json.campaign.items.length > 0) {
        console.log(`[httpRequest] First item mockupImage in response: ${json.campaign.items[0].mockupImage || 'NONE'}`);
      }
    }
    return json;
  }

  return response.text();
}

async function fetchQueue({ since } = {}) {
  return httpRequest('/api/internal/orders/queue', {
    method: 'GET',
    query: since ? { since } : undefined
  });
}

async function fulfillPodLineItems(payload = {}) {
  const {
    shopifyOrderId,
    lineItemIds,
    trackingNumber,
    trackingCompany,
    trackingUrl,
    notifyCustomer
  } = payload || {};
  const body = {
    shopify_order_id: shopifyOrderId,
    line_item_ids: Array.isArray(lineItemIds) ? lineItemIds : [],
    tracking_number: trackingNumber || '',
    tracking_company: trackingCompany || '',
    tracking_url: trackingUrl || '',
    notify_customer: notifyCustomer !== false
  };
  return httpRequest('/internal/fulfill', { method: 'POST', body });
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

async function updateOrder(payload = {}) {
  const { orderId, updates } = payload || {};
  if (!orderId) {
    throw new Error('orderId is required.');
  }
  const body = updates && typeof updates === 'object' ? updates : {};
  return httpRequest(`/api/orders/${encodeURIComponent(orderId)}`, {
    method: 'PATCH',
    body
  });
}

async function fetchCatalog(options = {}) {
  const { forceRefresh = false, catalogType = 'apparel' } = options || {};
  let maxAgeMs = DEFAULT_CATALOG_CACHE_MAX_AGE_MS;
  if (options && Object.prototype.hasOwnProperty.call(options, 'maxAgeMs')) {
    const parsed = Number(options.maxAgeMs);
    if (Number.isFinite(parsed)) {
      maxAgeMs = parsed;
    }
  }

  // Determine API endpoint and cache file based on catalog type
  const apiEndpoint = catalogType === 'decal-icons' ? '/api/catalog/decal-icons' : '/api/catalog';
  const cacheFileSuffix = catalogType === 'decal-icons' ? '-decal-icons' : '';

  const cached = await readCatalogCache(cacheFileSuffix);
  if (!forceRefresh && maxAgeMs > 0 && isCacheFresh(cached, maxAgeMs)) {
    return annotateCatalog(cached.data, {
      fromCache: true,
      staleFallback: false,
      fetchedAt: cached?.fetchedAt,
      catalogType
    });
  }

  try {
    const catalog = await httpRequest(apiEndpoint, { method: 'GET' });
    const payload = await writeCatalogCache(catalog, cacheFileSuffix);
    return annotateCatalog(catalog, {
      fromCache: false,
      staleFallback: false,
      fetchedAt: payload?.fetchedAt,
      catalogType
    });
  } catch (error) {
    if (cached && cached.data) {
      console.warn('Catalog fetch failed, serving cached copy:', error);
      return annotateCatalog(cached.data, {
        fromCache: true,
        staleFallback: true,
        fetchedAt: cached?.fetchedAt,
        catalogType
      });
    }
    throw error;
  }
}

async function catalogMove(payload = {}) {
  return httpRequest('/api/admin/catalog/move', { method: 'POST', body: payload });
}

async function catalogRename(payload = {}) {
  return httpRequest('/api/admin/catalog/rename', { method: 'POST', body: payload });
}

async function catalogDelete(payload = {}) {
  return httpRequest('/api/admin/catalog/item', { method: 'DELETE', body: payload });
}

async function catalogCreateFolder(payload = {}) {
  return httpRequest('/api/admin/catalog/folder', { method: 'POST', body: payload });
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

async function fetchSsawStyles({ q, brand, category } = {}) {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (brand) params.set('brand', brand);
  if (category) params.set('category', category);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return httpRequest(`/api/vendors/ssaw/styles${qs}`, { method: 'GET' });
}

async function fetchSsawProducts(styleId) {
  const id = styleId || '';
  if (!id) throw new Error('Missing S&S style id');
  return httpRequest(`/api/vendors/ssaw/products?style=${encodeURIComponent(id)}`, { method: 'GET' });
}

async function createVendorOrder(payload = {}) {
  return httpRequest('/api/vendors/ssaw/orders', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

async function fetchSsawOrders(params = {}) {
  const q = new URLSearchParams();
  if (params.id) q.set('id', params.id);
  if (params.po) q.set('po', params.po);
  if (params.from) q.set('from', params.from);
  if (params.to) q.set('to', params.to);
  if (params.status) q.set('status', params.status);
  const qs = q.toString() ? `?${q.toString()}` : '';
  return httpRequest(`/api/vendors/ssaw/orders${qs}`, { method: 'GET' });
}

async function fetchSsawConfig() {
  return httpRequest('/api/vendors/ssaw/config', { method: 'GET' });
}

async function updateSsawConfig(payload = {}) {
  return httpRequest('/api/vendors/ssaw/config', {
    method: 'POST',
    body: payload || {}
  });
}

async function fetchApparelCategories() {
  return httpRequest('/api/apparel/categories', { method: 'GET' });
}

async function createApparelCategory(payload = {}) {
  const body = {
    name: payload.name || payload.label || payload.category || ''
  };
  return httpRequest('/api/apparel/categories', {
    method: 'POST',
    body
  });
}

async function fetchApparelStore() {
  return httpRequest('/api/apparel/store', { method: 'GET' });
}

async function updateApparelStoreItem(payload = {}) {
  const { id, updates } = payload || {};
  if (!id) {
    throw new Error('Apparel item id is required.');
  }
  const body = updates && typeof updates === 'object' ? updates : {};
  return httpRequest(`/api/apparel/store/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body
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

async function deleteInventory(payload = {}) {
  const { itemId } = payload;
  if (!itemId) {
    throw new Error('Inventory item id is required.');
  }
  return httpRequest(`/api/inventory/${encodeURIComponent(itemId)}`, {
    method: 'DELETE'
  });
}

// Local vendor orders (DB)
async function fetchLocalVendorOrders(params = {}) {
  const q = new URLSearchParams();
  if (params.vendor) q.set('vendor', params.vendor);
  if (params.po) q.set('po', params.po);
  if (params.status) q.set('status', params.status);
  if (params.limit) q.set('limit', params.limit);
  if (params.offset) q.set('offset', params.offset);
  const qs = q.toString() ? `?${q.toString()}` : '';
  return httpRequest(`/api/internal/vendor-orders${qs}`, { method: 'GET' });
}

async function updateLocalVendorOrder({ id, updates }) {
  if (!id) throw new Error('id is required');
  return httpRequest(`/api/internal/vendor-orders/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: updates || {}
  });
}

async function createLocalVendorOrderDraft(payload = {}) {
  return httpRequest('/api/internal/vendor-orders', {
    method: 'POST',
    body: payload || {}
  });
}

async function approveLocalVendorOrder(id) {
  if (!id) throw new Error('id is required');
  return httpRequest(`/api/internal/vendor-orders/${encodeURIComponent(id)}/approve`, {
    method: 'POST'
  });
}

async function rejectLocalVendorOrder(id) {
  if (!id) throw new Error('id is required');
  return httpRequest(`/api/internal/vendor-orders/${encodeURIComponent(id)}/reject`, {
    method: 'POST'
  });
}

async function fetchLocalTopVendorItems(params = {}) {
  const q = new URLSearchParams();
  if (params.vendor) q.set('vendor', params.vendor);
  if (params.from) q.set('from', params.from);
  if (params.to) q.set('to', params.to);
  if (params.limit) q.set('limit', params.limit);
  const qs = q.toString() ? `?${q.toString()}` : '';
  return httpRequest(`/api/internal/vendor-orders/top${qs}`, { method: 'GET' });
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

// Resolve input (URL or local path) to a Node Buffer
async function resolveToBuffer(input) {
  if (!input) throw new Error('Input is required');
  const inputStr = String(input);

  // Handle data URIs (base64 encoded images from client-side processing)
  if (inputStr.startsWith('data:')) {
    const match = inputStr.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      const base64Data = match[2];
      return Buffer.from(base64Data, 'base64');
    }
    throw new Error('Invalid data URI format');
  }

  const settings = ensureServerConfigured();
  // If looks like URL or starts with /api/ or /productimages/, fetch from server
  const looksRemote = /^(https?:)?\//i.test(inputStr);
  if (looksRemote) {
    let resolvedUrl;
    try { resolvedUrl = new URL(input, settings.serverBaseUrl); } catch { throw new Error('Invalid image URL'); }
    const { fetch: doFetch, Headers: HeadersCtor } = await ensureFetch();
    const headers = new HeadersCtor({ Accept: 'image/*' });
    if (settings.apiKey) headers.set('X-API-Key', settings.apiKey);
    const resp = await doFetch(resolvedUrl, { method: 'GET', headers });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      throw new Error(t || `Fetch failed (${resp.status})`);
    }
    const ab = await resp.arrayBuffer();
    return Buffer.from(ab);
  }
  // Local file path
  return fs.promises.readFile(input);
}

// Resolve input (URL or local path) to a local file path (downloads to temp if remote)
async function resolveToLocalPath(input) {
  if (!input) throw new Error('Input is required');
  const looksRemote = /^(https?:)?\//i.test(String(input));
  if (!looksRemote) return input;
  const buf = await resolveToBuffer(input);
  const outDir = path.join(app.getPath('temp'), 'print-station-assets');
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (_) {}
  // Strip query parameters before extracting extension
  const urlWithoutQuery = String(input).split('?')[0];
  const ext = path.extname(urlWithoutQuery).toLowerCase() || '.jpg';
  const out = path.join(outDir, `asset-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  await fs.promises.writeFile(out, buf);
  return out;
}

async function uploadArtwork(params) {
  const {
    previewPath,
    sourcePaths = [],
    categoryMode,
    existingCategory,
    newCategoryName,
    displayName,
    apparel,
    apparelCategory
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
    if (apparel.categoryName) {
      form.append('apparelCategory', String(apparel.categoryName));
    }
  }

  if (apparelCategory && !apparel?.categoryName) {
    form.append('apparelCategory', String(apparelCategory));
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

  // Retry logic for connection resets during bulk uploads
  const maxRetries = 3;
  let lastError = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Recreate form for retry (streams can only be read once)
      const retryForm = new FormData();
      retryForm.append('displayName', displayName || '');
      retryForm.append('categoryMode', categoryMode || 'existing');
      if (categoryMode === 'existing' && existingCategory) {
        retryForm.append('category', existingCategory);
      }
      if (categoryMode === 'new' && newCategoryName) {
        retryForm.append('newCategoryName', newCategoryName);
      }
      if (apparel?.enabled) {
        retryForm.append('apparelEnabled', 'true');
        if (apparel.productType) retryForm.append('apparelProductType', String(apparel.productType));
        if (apparel.categoryName) retryForm.append('apparelCategory', String(apparel.categoryName));
      }
      if (apparelCategory && !apparel?.categoryName) {
        retryForm.append('apparelCategory', String(apparelCategory));
      }
      retryForm.append('preview', fs.createReadStream(previewPath));
      sourcePaths.filter(Boolean).forEach((filePath) => {
        retryForm.append('sources', fs.createReadStream(filePath));
      });

      const retryHeaders = retryForm.getHeaders();
      if (settings.apiKey) {
        retryHeaders['X-API-Key'] = settings.apiKey;
      }

      const response = await doFetch(url, {
        method: 'POST',
        body: retryForm,
        headers: retryHeaders
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
    } catch (err) {
      lastError = err;
      const isRetryable = err.code === 'ECONNRESET' || err.code === 'EPIPE' ||
                          err.code === 'ETIMEDOUT' || err.message?.includes('socket hang up') ||
                          err.message?.includes('connection reset');

      if (isRetryable && attempt < maxRetries - 1) {
        const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
        console.log(`[Upload] Connection error, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
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
      nodeIntegration: false,
      webviewTag: true
    },
    show: false
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  return mainWindow;
}

// ==================== 3D Printer Fleet Helpers ====================

function connectToPrinter(printer) {
  if (!printerService) return;

  const onStatus = (apiUrl, status) => {
    // Push to renderer
    const wins = BrowserWindow.getAllWindows();
    if (wins.length > 0 && !wins[0].isDestroyed()) {
      wins[0].webContents.send('fleet:printer:status', {
        printerId: printer.id,
        apiUrl,
        ...status
      });
    }

    if (!fleetDb) return;

    const activeJobs = fleetDb.getActiveJobs().filter(j => j.printer_id === printer.id);

    if (status.state === 'printing' && activeJobs.length > 0) {
      fleetDb.updateJob(activeJobs[0].id, {
        progress: status.progress || 0,
        status: 'printing'
      });
      printerService.updatePollRate(apiUrl, true);
    }

    if (status.state === 'complete' && activeJobs.length > 0) {
      fleetDb.updateJob(activeJobs[0].id, {
        status: 'completed',
        progress: 1,
        completed_at: new Date().toISOString(),
        print_duration: status.printDuration || 0
      });
      printerService.updatePollRate(apiUrl, false);
    }

    if (status.state === 'error' && activeJobs.length > 0) {
      fleetDb.updateJob(activeJobs[0].id, {
        status: 'error',
        error_message: status.message || 'Unknown error',
        completed_at: new Date().toISOString()
      });
      printerService.updatePollRate(apiUrl, false);
    }
  };

  // Connect WebSocket for real-time, start polling as fallback
  printerService.connectWebSocket(printer.api_url, onStatus);
  printerService.startPolling(printer.api_url, onStatus, 5000);
}

function disconnectPrinter(printer) {
  if (!printerService) return;
  printerService.disconnectWebSocket(printer.api_url);
  printerService.stopPolling(printer.api_url);
}

function registerIpcHandlers() {
  ipcMain.handle('config:get', () => getSettings());

  ipcMain.handle('config:set', (_event, updates) => {
    const next = updateSettings(updates || {});
    try { applyWatchSettings(next); } catch (_) {}
    return next;
  });

  // Read file as base64
  ipcMain.handle('file:readAsBase64', async (_event, filePath) => {
    try {
      const fs = require('fs').promises;
      const buffer = await fs.readFile(filePath);
      return buffer.toString('base64');
    } catch (e) {
      console.error('Error reading file as base64:', e);
      return null;
    }
  });

  // Fetch remote image as base64 (avoids CORS in renderer)
  ipcMain.handle('file:fetchAsBase64', async (_event, url) => {
    try {
      const { default: fetch } = await fetchModulePromise;
      console.log('[Main] Fetching image as base64:', url);
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const buffer = await response.buffer();
      const base64 = buffer.toString('base64');
      console.log('[Main] Fetched image, base64 length:', base64.length);
      return base64;
    } catch (e) {
      console.error('Error fetching image as base64:', e);
      return null;
    }
  });

  // Preview image cache directory
  const getPreviewCacheDir = () => path.join(app.getPath('userData'), 'preview-cache');
  const PREVIEW_CACHE_MAX_SIZE_MB = 500; // Max disk cache size in MB
  const PREVIEW_CACHE_MAX_FILES = 2000; // Max number of cached files

  // Generate cache key from URL (hash to handle long URLs)
  const getPreviewCacheKey = (url) => {
    const hash = crypto.createHash('md5').update(url).digest('hex');
    // Extract extension from URL or default to .jpg
    const extMatch = url.match(/\.([a-z]+)(?:\?|$)/i);
    const ext = extMatch ? extMatch[1].toLowerCase() : 'jpg';
    return `${hash}.${ext}`;
  };

  // Prune preview cache if it exceeds limits (removes oldest files first)
  const prunePreviewCache = async () => {
    try {
      const cacheDir = getPreviewCacheDir();
      const files = await fsPromises.readdir(cacheDir);
      if (files.length <= PREVIEW_CACHE_MAX_FILES / 2) return; // Only prune when over half full

      // Get file stats and sort by modification time (oldest first)
      const fileStats = await Promise.all(
        files.map(async (file) => {
          try {
            const filePath = path.join(cacheDir, file);
            const stat = await fsPromises.stat(filePath);
            return { file, path: filePath, mtime: stat.mtimeMs, size: stat.size };
          } catch (e) {
            return null;
          }
        })
      );

      const validFiles = fileStats.filter(Boolean).sort((a, b) => a.mtime - b.mtime);
      const totalSize = validFiles.reduce((sum, f) => sum + f.size, 0);
      const maxSizeBytes = PREVIEW_CACHE_MAX_SIZE_MB * 1024 * 1024;

      // Delete oldest files until under limits
      let currentSize = totalSize;
      let currentCount = validFiles.length;
      let deleted = 0;

      for (const file of validFiles) {
        if (currentSize <= maxSizeBytes * 0.7 && currentCount <= PREVIEW_CACHE_MAX_FILES * 0.7) break;
        try {
          await fsPromises.unlink(file.path);
          currentSize -= file.size;
          currentCount--;
          deleted++;
        } catch (e) {
          // Ignore individual file errors
        }
      }

      if (deleted > 0) {
        console.log(`[PreviewCache] Pruned ${deleted} files, freed ${((totalSize - currentSize) / 1024 / 1024).toFixed(1)}MB`);
      }
    } catch (e) {
      // Ignore prune errors
    }
  };

  // Get cached preview as file:// URL, or fetch and cache it
  ipcMain.handle('preview:getCached', async (_event, { url, forceRefresh = false }) => {
    if (!url) return null;

    try {
      const cacheDir = getPreviewCacheDir();
      await fsPromises.mkdir(cacheDir, { recursive: true });

      const cacheKey = getPreviewCacheKey(url);
      const cachePath = path.join(cacheDir, cacheKey);

      // Check if cached file exists and is not stale (7 days)
      if (!forceRefresh) {
        try {
          const stat = await fsPromises.stat(cachePath);
          const ageMs = Date.now() - stat.mtimeMs;
          const maxAgeMs = 7 * 24 * 60 * 60 * 1000; // 7 days
          if (ageMs < maxAgeMs) {
            // Return file:// URL for cached image
            return `file://${cachePath.replace(/\\/g, '/')}`;
          }
        } catch (e) {
          // File doesn't exist, continue to fetch
        }
      }

      // Fetch the image
      const { fetch: doFetch } = await ensureFetch();
      const settings = getSettings();
      const headers = {};
      if (settings.apiKey) {
        headers['X-API-Key'] = settings.apiKey;
      }

      const response = await doFetch(url, { headers });
      if (!response.ok) {
        console.warn(`[PreviewCache] Failed to fetch ${url}: ${response.status}`);
        return null;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      await fsPromises.writeFile(cachePath, buffer);

      return `file://${cachePath.replace(/\\/g, '/')}`;
    } catch (e) {
      console.error('[PreviewCache] Error:', e.message);
      return null;
    }
  });

  // Batch fetch previews (for loading multiple items at once)
  ipcMain.handle('preview:batchCache', async (_event, { urls }) => {
    if (!urls || !Array.isArray(urls)) return {};

    const results = {};
    const cacheDir = getPreviewCacheDir();
    await fsPromises.mkdir(cacheDir, { recursive: true });

    const { fetch: doFetch } = await ensureFetch();
    const settings = getSettings();
    const headers = {};
    if (settings.apiKey) {
      headers['X-API-Key'] = settings.apiKey;
    }

    // Process in parallel with concurrency limit
    const concurrency = 6;
    const queue = [...urls];
    const processing = new Set();

    const processOne = async (url) => {
      if (!url) return;

      try {
        const cacheKey = getPreviewCacheKey(url);
        const cachePath = path.join(cacheDir, cacheKey);

        // Check cache first
        try {
          const stat = await fsPromises.stat(cachePath);
          const ageMs = Date.now() - stat.mtimeMs;
          const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
          if (ageMs < maxAgeMs) {
            results[url] = `file://${cachePath.replace(/\\/g, '/')}`;
            return;
          }
        } catch (e) {
          // Not cached
        }

        const response = await doFetch(url, { headers });
        if (response.ok) {
          const buffer = Buffer.from(await response.arrayBuffer());
          await fsPromises.writeFile(cachePath, buffer);
          results[url] = `file://${cachePath.replace(/\\/g, '/')}`;
        }
      } catch (e) {
        // Skip failed URLs
      }
    };

    while (queue.length > 0 || processing.size > 0) {
      while (processing.size < concurrency && queue.length > 0) {
        const url = queue.shift();
        const promise = processOne(url).finally(() => processing.delete(promise));
        processing.add(promise);
      }
      if (processing.size > 0) {
        await Promise.race(processing);
      }
    }

    // Prune cache in background after batch operations
    prunePreviewCache().catch(() => {});

    return results;
  });

  // Clear preview cache (for maintenance)
  ipcMain.handle('preview:clearCache', async () => {
    try {
      const cacheDir = getPreviewCacheDir();
      const files = await fsPromises.readdir(cacheDir);
      let cleared = 0;
      for (const file of files) {
        try {
          await fsPromises.unlink(path.join(cacheDir, file));
          cleared++;
        } catch (e) {
          // Ignore individual file errors
        }
      }
      return { cleared };
    } catch (e) {
      return { cleared: 0, error: e.message };
    }
  });

  // Get cache stats
  ipcMain.handle('preview:cacheStats', async () => {
    try {
      const cacheDir = getPreviewCacheDir();
      const files = await fsPromises.readdir(cacheDir);
      let totalSize = 0;
      for (const file of files) {
        try {
          const stat = await fsPromises.stat(path.join(cacheDir, file));
          totalSize += stat.size;
        } catch (e) {
          // Ignore
        }
      }
      return { count: files.length, sizeBytes: totalSize, sizeMB: (totalSize / 1024 / 1024).toFixed(2) };
    } catch (e) {
      return { count: 0, sizeBytes: 0, sizeMB: '0.00' };
    }
  });

  ipcMain.handle('queue:fetch', (_event, args) => fetchQueue(args || {}));

  ipcMain.handle('queue:ack', (_event, payload) => markDownloaded(payload || {}));

  ipcMain.handle('queue:complete', (_event, payload) => markCompleted(payload || {}));

  ipcMain.handle('orders:list', () => listOrders());
  ipcMain.handle('orders:update', (_event, payload) => updateOrder(payload || {}));

  ipcMain.handle('catalog:fetch', (_event, options) => fetchCatalog(options || {}));
  ipcMain.handle('catalog:move', (_event, payload) => catalogMove(payload || {}));
  ipcMain.handle('catalog:rename', (_event, payload) => catalogRename(payload || {}));
  ipcMain.handle('catalog:delete', (_event, payload) => catalogDelete(payload || {}));
  ipcMain.handle('catalog:folder:create', (_event, payload) => catalogCreateFolder(payload || {}));

  // Catalog - Extract ZIP file and return image paths (streaming - no size limit)
  ipcMain.handle('catalog:extract-zip', async (_event, zipPath) => {
    const unzipper = require('unzipper');
    const path = require('path');
    const os = require('os');
    const fs = require('fs');

    try {
      // Create temp directory for extraction
      const tempDir = path.join(os.tmpdir(), `catalog-zip-${Date.now()}`);
      fs.mkdirSync(tempDir, { recursive: true });

      const imageExtensions = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
      const extractedPaths = [];

      // Use streaming extraction - no file size limit
      const directory = await unzipper.Open.file(zipPath);

      for (const entry of directory.files) {
        if (entry.type === 'Directory') continue;

        const ext = path.extname(entry.path).toLowerCase();
        if (!imageExtensions.includes(ext)) continue;

        // Skip __MACOSX and hidden files
        if (entry.path.includes('__MACOSX') || entry.path.startsWith('.') || entry.path.includes('/.')) {
          continue;
        }

        // Extract to temp directory with flat structure
        const filename = path.basename(entry.path);
        const destPath = path.join(tempDir, filename);

        // Handle duplicate filenames
        let finalPath = destPath;
        let counter = 1;
        while (fs.existsSync(finalPath)) {
          const name = path.basename(filename, ext);
          finalPath = path.join(tempDir, `${name}_${counter}${ext}`);
          counter++;
        }

        // Stream extraction - handles large files
        await new Promise((resolve, reject) => {
          entry.stream()
            .pipe(fs.createWriteStream(finalPath))
            .on('finish', resolve)
            .on('error', reject);
        });
        extractedPaths.push(finalPath);
      }

      console.log(`[Catalog ZIP] Extracted ${extractedPaths.length} images from ${path.basename(zipPath)}`);
      return { success: true, filePaths: extractedPaths, tempDir };
    } catch (error) {
      console.error('Catalog ZIP extraction error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('artwork:upload', (_event, payload) => uploadArtwork(payload || {}));

  // Facebook AI - Generate ads for campaign
  ipcMain.handle('facebook-ai:generate', async (event, { campaign, imagePath, budget }) => {
    try {
      const facebookAI = require('./facebook-ai');

      if (!facebookAI.isConfigured()) {
        return {
          success: false,
          error: 'Anthropic API key not configured. Add ANTHROPIC_API_KEY to .env file.'
        };
      }

      const result = await facebookAI.generateCampaignAds(campaign, imagePath, budget);
      return { success: true, data: result };
    } catch (error) {
      console.error('[Facebook AI Error]', error);
      return {
        success: false,
        error: error.message || 'Failed to generate Facebook ads'
      };
    }
  });

  // Facebook Shop Optimizer - Optimize products for Facebook Shop/Marketplace
  ipcMain.handle('facebook-shop:optimize', async (event, { items }) => {
    try {
      const shopOptimizer = require('./facebook-shop-optimizer');

      if (!shopOptimizer.isConfigured()) {
        return {
          success: false,
          error: 'Anthropic API key not configured. Add ANTHROPIC_API_KEY to .env file.'
        };
      }

      // Send progress updates to renderer
      const sendProgress = (current, total) => {
        event.sender.send('facebook-shop:progress', { current, total });
      };

      const results = await shopOptimizer.optimizeCampaignProducts(items, sendProgress);
      return { success: true, data: results };
    } catch (error) {
      console.error('[Facebook Shop Optimizer Error]', error);
      return {
        success: false,
        error: error.message || 'Failed to optimize products'
      };
    }
  });

  // ========================================
  // Social Marketing - Facebook Post Creator
  // ========================================

  // Generate Facebook post content using AI
  ipcMain.handle('social:fb:generate', async (_event, payload = {}) => {
    try {
      const socialMarketing = require('./social-marketing');
      const { items, style, collectionUrl, productType, campaign } = payload;

      if (!items || items.length === 0) {
        return { success: false, error: 'No items selected' };
      }

      const result = await socialMarketing.generatePostContent(items, {
        style: style || 'showcase',
        collectionUrl,
        productType: productType || 'other',
        campaign: campaign || null
      });

      return { success: true, data: result };
    } catch (error) {
      console.error('[Social Marketing Generate Error]', error);
      return { success: false, error: error.message || 'Failed to generate post' };
    }
  });

  // Publish post to Facebook immediately
  ipcMain.handle('social:fb:publish', async (_event, payload = {}) => {
    try {
      const socialMarketing = require('./social-marketing');
      const { text, images, collectionUrl, imageFormat, category } = payload;

      const result = await socialMarketing.publishPost({
        text,
        images,
        collectionUrl,
        imageFormat,
        category
      });

      return { success: true, data: result };
    } catch (error) {
      console.error('[Social Marketing Publish Error]', error);
      return { success: false, error: error.message || 'Failed to publish post' };
    }
  });

  // Schedule post for later
  ipcMain.handle('social:fb:schedule', async (_event, payload = {}) => {
    try {
      const socialMarketing = require('./social-marketing');
      const { text, images, collectionUrl, imageFormat, scheduledTime, category } = payload;

      const result = await socialMarketing.schedulePost({
        text,
        images,
        collectionUrl,
        imageFormat,
        scheduledTime,
        category
      });

      return { success: true, data: result };
    } catch (error) {
      console.error('[Social Marketing Schedule Error]', error);
      return { success: false, error: error.message || 'Failed to schedule post' };
    }
  });

  // Create collage image from multiple images
  ipcMain.handle('social:collage:create', async (_event, payload = {}) => {
    try {
      const socialMarketing = require('./social-marketing');
      const { images } = payload;

      const result = await socialMarketing.createCollage(images);
      return { success: true, data: result };
    } catch (error) {
      console.error('[Social Marketing Collage Error]', error);
      return { success: false, error: error.message || 'Failed to create collage' };
    }
  });

  // List scheduled posts
  ipcMain.handle('social:fb:scheduled:list', async () => {
    try {
      const socialMarketing = require('./social-marketing');
      const posts = await socialMarketing.listScheduledPosts();
      return { success: true, data: posts };
    } catch (error) {
      console.error('[Social Marketing List Scheduled Error]', error);
      return { success: false, error: error.message };
    }
  });

  // Cancel scheduled post
  ipcMain.handle('social:fb:scheduled:cancel', async (_event, postId) => {
    try {
      const socialMarketing = require('./social-marketing');
      await socialMarketing.cancelScheduledPost(postId);
      return { success: true };
    } catch (error) {
      console.error('[Social Marketing Cancel Error]', error);
      return { success: false, error: error.message };
    }
  });

  // ========================================
  // Social Marketing - TikTok Posts
  // ========================================

  // Load env vars from multiple locations (root .env has API keys, server .env has TikTok keys)
  const envPaths = [
    path.resolve(__dirname, '..', '..', '.env'),           // Root: g:\Vinyl Stuff\.env
    path.resolve(__dirname, '..', '..', 'server', '.env'), // Server: g:\Vinyl Stuff\server\.env
    'g:\\Vinyl Stuff\\.env'                                 // Absolute fallback
  ];
  for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
      require('dotenv').config({ path: envPath });
      console.log('[TikTok] Loaded env from:', envPath);
    }
  }

  // Get TikTok auth URL
  ipcMain.handle('social:tiktok:authUrl', async () => {
    try {
      const tiktokContent = require('../../server/integrations/tiktok-content');
      const url = tiktokContent.getAuthUrl();
      return { success: true, url };
    } catch (error) {
      console.error('[TikTok Auth URL Error]', error);
      return { success: false, error: error.message };
    }
  });

  // Get TikTok connection status (from server API)
  ipcMain.handle('social:tiktok:status', async () => {
    try {
      const fetch = (await fetchModulePromise).default;
      const response = await fetch('https://blueridgecustomco.com/api/tiktok-content/status');
      const status = await response.json();
      return { success: true, ...status };
    } catch (error) {
      console.error('[TikTok Status Error]', error);
      return { success: false, error: error.message, connected: false };
    }
  });

  // Get TikTok user info (from server API)
  ipcMain.handle('social:tiktok:userInfo', async () => {
    try {
      const fetch = (await fetchModulePromise).default;
      const response = await fetch('https://blueridgecustomco.com/api/tiktok-content/user');
      const userInfo = await response.json();
      if (userInfo.error) {
        return { success: false, error: userInfo.error };
      }
      return { success: true, data: userInfo };
    } catch (error) {
      console.error('[TikTok User Info Error]', error);
      return { success: false, error: error.message };
    }
  });

  // Upload video to TikTok (via server API)
  ipcMain.handle('social:tiktok:upload', async (_event, payload = {}) => {
    try {
      const fetch = (await fetchModulePromise).default;
      const fs = require('fs');
      const path = require('path');
      const FormData = require('form-data');
      const { videoPath, title, privacyLevel } = payload;

      if (!videoPath) {
        return { success: false, error: 'Video path is required' };
      }

      // Check if file exists
      if (!fs.existsSync(videoPath)) {
        return { success: false, error: 'Video file not found: ' + videoPath };
      }

      console.log('[TikTok] Uploading video file to server:', videoPath);

      // Step 1: Upload video to server to get a public URL
      const fileBuffer = fs.readFileSync(videoPath);
      const fileName = path.basename(videoPath);

      // Create multipart form data
      const formData = new FormData();
      formData.append('video', fileBuffer, {
        filename: fileName,
        contentType: 'video/mp4'
      });

      const uploadResponse = await fetch('https://blueridgecustomco.com/api/tiktok-content/upload-temp-video', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.INTERNAL_API_KEY || 'laZHEthV92qDq0adO07UnqoH3O4baZmV',
          ...formData.getHeaders()
        },
        body: formData
      });

      const uploadResult = await uploadResponse.json();
      if (!uploadResult.success || !uploadResult.videoUrl) {
        return { success: false, error: uploadResult.error || 'Failed to upload video to server' };
      }

      console.log('[TikTok] Video uploaded to server, URL:', uploadResult.videoUrl);

      // Step 2: Now use the URL to upload to TikTok
      const tiktokResponse = await fetch('https://blueridgecustomco.com/api/tiktok-content/upload-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoUrl: uploadResult.videoUrl,
          title: title || '',
          privacyLevel: privacyLevel || 'PUBLIC_TO_EVERYONE'
        })
      });

      const tiktokResult = await tiktokResponse.json();
      if (tiktokResult.error) {
        return { success: false, error: tiktokResult.error };
      }
      return { success: true, data: tiktokResult };
    } catch (error) {
      console.error('[TikTok Upload Error]', error);
      return { success: false, error: error.message };
    }
  });

  // Upload video from URL to TikTok (via server API)
  ipcMain.handle('social:tiktok:uploadFromUrl', async (_event, payload = {}) => {
    try {
      const fetch = (await fetchModulePromise).default;
      const { videoUrl, title, privacyLevel } = payload;

      if (!videoUrl) {
        return { success: false, error: 'Video URL is required' };
      }

      const response = await fetch('https://blueridgecustomco.com/api/tiktok-content/upload-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoUrl,
          title: title || '',
          privacyLevel: privacyLevel || 'PUBLIC_TO_EVERYONE'
        })
      });

      const result = await response.json();
      if (result.error) {
        return { success: false, error: result.error };
      }
      return { success: true, data: result };
    } catch (error) {
      console.error('[TikTok Upload From URL Error]', error);
      return { success: false, error: error.message };
    }
  });

  // Get publish status (via server API)
  ipcMain.handle('social:tiktok:publishStatus', async (_event, publishId) => {
    try {
      const fetch = (await fetchModulePromise).default;
      const response = await fetch(`https://blueridgecustomco.com/api/tiktok-content/publish-status?publishId=${publishId}`);
      const status = await response.json();
      if (status.error) {
        return { success: false, error: status.error };
      }
      return { success: true, data: status };
    } catch (error) {
      console.error('[TikTok Publish Status Error]', error);
      return { success: false, error: error.message };
    }
  });

  // Disconnect from TikTok (delete tokens via server API)
  ipcMain.handle('social:tiktok:disconnect', async () => {
    try {
      const fetch = (await fetchModulePromise).default;
      const response = await fetch('https://blueridgecustomco.com/api/tiktok-content/disconnect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.INTERNAL_API_KEY || ''
        }
      });
      const result = await response.json();
      if (result.error) {
        return { success: false, error: result.error };
      }
      return { success: true };
    } catch (error) {
      console.error('[TikTok Disconnect Error]', error);
      return { success: false, error: error.message };
    }
  });

  // Generate TikTok caption using Claude AI or templates
  ipcMain.handle('social:tiktok:generateCaption', async (_event, payload = {}) => {
    try {
      const { productName, productType, description, price, tags, keywords, style } = payload;

      // Try Claude/Anthropic API first if configured
      const anthropicKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
      if (anthropicKey) {
        try {
          const fetch = (await fetchModulePromise).default;
          // Use a fast model for caption generation (Haiku is best for this)
          const claudeModel = 'claude-3-haiku-20240307';
          const prompt = `You're a Gen Z creator posting on TikTok. Write like a REAL person, not a brand.

Product: ${productName}
Type: ${productType || 'decal/sticker'}
${description ? `Details: ${description}` : ''}
${price ? `Price: $${price}` : ''}

IMPORTANT - Write like these REAL viral TikTok examples:
- "obsessed with how this turned out ngl 😭🔥"
- "pov: you finally found the perfect sticker for your car"
- "no bc why does this go so hard"
- "told myself i didn't need more decals... anyway"
- "the way this hits different in person >>>"
- "not me buying another one 💀"
- "when the lighting hits just right"
- "this might be my new favorite ngl"

Rules:
- Sound like a real person posting their own content, NOT a business
- Use lowercase, casual grammar is totally fine
- 1-3 emojis max (don't overdo it)
- NO corporate phrases like "check out" "shop now" "premium quality"
- NO exclamation marks spam
- Keep it SHORT (under 80 chars ideally)
- Make people want to comment or share
- Only mention "link in bio" if it fits naturally at the end

Return ONLY valid JSON, nothing else:
{"caption": "your short caption here", "hashtags": "#cartok #stickertok #decals #smallbusiness #fyp"}`;

          console.log('[TikTok] Generating caption with Claude...');
          const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': anthropicKey,
              'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
              model: claudeModel,
              max_tokens: 300,
              messages: [{ role: 'user', content: prompt }]
            })
          });

          const data = await response.json();
          if (data.content?.[0]?.text) {
            const content = data.content[0].text;
            try {
              const parsed = JSON.parse(content);
              return { success: true, caption: parsed.caption, hashtags: parsed.hashtags };
            } catch {
              // If not valid JSON, use content as caption
              return { success: true, caption: content };
            }
          }
        } catch (aiError) {
          console.warn('[TikTok] Claude API failed, falling back to templates:', aiError.message);
        }
      }

      // Fallback: Generate caption from product-aware templates
      const name = productName || 'this custom creation';
      const type = productType || 'custom merchandise';
      const tagList = tags || [];

      const templates = [
        `${name} just dropped 🔥 Premium ${type} - handcrafted quality you can feel. Who's copping? 👀 Link in bio!`,
        `POV: You finally found THE perfect ${type} ✨ ${name} - made just for you! 🇺🇸 Shop link in bio 🛒`,
        `Stop the scroll! 🛑 ${name} is THAT piece for your collection 💯 Premium quality, made in USA. Link in bio!`,
        `This ${type} hits different 🔥 ${name} - custom made, premium quality ✨ Grab yours → link in bio!`,
        `New drop alert! 🚨 ${name} now available! Perfect ${type} for anyone who appreciates quality 💪 Link in bio!`,
        `${name} appreciation post 👀 Premium ${type}, made with love 🇺🇸 Tag someone who needs this! Link in bio 🔗`
      ];

      const caption = templates[Math.floor(Math.random() * templates.length)];

      // Generate relevant hashtags from tags and product info
      const baseHashtags = ['#fyp', '#foryou', '#smallbusiness', '#shopsmall', '#madeinusa'];
      const productHashtags = tagList.slice(0, 5).map(t => `#${t.replace(/\s+/g, '').toLowerCase()}`);
      const typeHashtags = type ? [`#${type.replace(/\s+/g, '').toLowerCase()}`] : [];

      const allHashtags = [...new Set([...baseHashtags, ...typeHashtags, ...productHashtags])].slice(0, 8);
      const hashtagStr = allHashtags.join(' ');

      return { success: true, caption, hashtags: hashtagStr };
    } catch (error) {
      console.error('[TikTok Caption Generate Error]', error);
      return { success: false, error: error.message };
    }
  });

  // ========================================
  // PRINTER API
  // ========================================

  // Get list of available printers
  ipcMain.handle('print:getPrinters', async () => {
    try {
      const { BrowserWindow } = require('electron');
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
      if (!win) {
        return { success: false, error: 'No window available', printers: [] };
      }
      const printers = await win.webContents.getPrintersAsync();
      console.log('[Print:getPrinters] Found', printers.length, 'printers');
      return {
        success: true,
        printers: printers.map(p => ({
          name: p.name,
          displayName: p.displayName || p.name,
          description: p.description,
          status: p.status,
          isDefault: p.isDefault
        }))
      };
    } catch (error) {
      console.error('[Print:getPrinters Error]', error);
      return { success: false, error: error.message, printers: [] };
    }
  });

  // Get default printer
  ipcMain.handle('print:getDefault', async () => {
    try {
      const { BrowserWindow } = require('electron');
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
      if (!win) {
        return { success: false, error: 'No window available', printer: null };
      }
      const printers = await win.webContents.getPrintersAsync();
      const defaultPrinter = printers.find(p => p.isDefault);
      return {
        success: true,
        printer: defaultPrinter ? {
          name: defaultPrinter.name,
          displayName: defaultPrinter.displayName || defaultPrinter.name,
          description: defaultPrinter.description
        } : null
      };
    } catch (error) {
      console.error('[Print:getDefault Error]', error);
      return { success: false, error: error.message, printer: null };
    }
  });

  // Print with OS dialog (gives full control over settings)
  ipcMain.handle('print:printWithDialog', async (_event, options = {}) => {
    try {
      const { imagePath, imageUrl, imageUrls } = options;
      const fs = require('fs');
      const path = require('path');
      const https = require('https');
      const http = require('http');
      const os = require('os');

      // Support single image (imagePath or imageUrl) or multiple images (imageUrls)
      let imageSources = [];
      if (imageUrls && Array.isArray(imageUrls) && imageUrls.length > 0) {
        imageSources = imageUrls;
      } else if (imageUrl) {
        imageSources = [imageUrl];
      } else if (imagePath) {
        imageSources = [imagePath];
      }

      if (imageSources.length === 0) {
        return { success: false, error: 'No image path or URL provided' };
      }

      console.log('[Print] Starting print with', imageSources.length, 'image(s)');

      // Download remote images to temp files if needed
      const tempFiles = [];
      const localPaths = [];

      for (const src of imageSources) {
        if (src.startsWith('http://') || src.startsWith('https://')) {
          // Download to temp file
          const tempPath = path.join(os.tmpdir(), `print_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
          console.log('[Print] Downloading', src, 'to', tempPath);

          await new Promise((resolve, reject) => {
            const client = src.startsWith('https') ? https : http;
            const file = fs.createWriteStream(tempPath);
            client.get(src, (response) => {
              if (response.statusCode === 301 || response.statusCode === 302) {
                // Follow redirect
                client.get(response.headers.location, (res2) => {
                  res2.pipe(file);
                  file.on('finish', () => { file.close(); resolve(); });
                }).on('error', reject);
              } else {
                response.pipe(file);
                file.on('finish', () => { file.close(); resolve(); });
              }
            }).on('error', reject);
          });

          tempFiles.push(tempPath);
          localPaths.push(tempPath);
        } else {
          // Already a local path
          localPaths.push(src.replace(/^file:\/\//, ''));
        }
      }

      console.log('[Print] Local paths:', localPaths);

      // Use Electron's print with proper full-page sizing
      const { BrowserWindow } = require('electron');

      // Create HTML file that references the local images directly
      // Use file:// URLs which work better than data URIs for large images
      const imagesHtml = localPaths.map((filePath, i) => {
        // Convert Windows path to proper file:// URL
        const fileUrl = 'file:///' + filePath.replace(/\\/g, '/').replace(/^\//, '');
        return `
        <div class="page" ${i < localPaths.length - 1 ? 'style="page-break-after: always;"' : ''}>
          <img src="${fileUrl}" />
        </div>
      `;
      }).join('');

      const htmlContent = `<!DOCTYPE html>
<html>
<head>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; padding: 0; background: white; }
    @page { size: Letter portrait; margin: 0; }
    @media print {
      html, body { width: 8.5in; height: 11in; margin: 0 !important; padding: 0 !important; }
      .page { width: 8.5in !important; height: 11in !important; page-break-inside: avoid; overflow: hidden; }
      img { width: 8.5in !important; height: 11in !important; object-fit: fill !important; }
    }
    .page { width: 8.5in; height: 11in; overflow: hidden; background: white; }
    img { width: 8.5in; height: 11in; object-fit: fill; display: block; }
  </style>
</head>
<body>${imagesHtml}</body>
</html>`;

      // Write HTML to a temp file (more reliable than data URI for large content)
      const tempHtmlPath = path.join(os.tmpdir(), `print_${Date.now()}.html`);
      fs.writeFileSync(tempHtmlPath, htmlContent);
      tempFiles.push(tempHtmlPath);
      console.log('[Print] Created temp HTML:', tempHtmlPath);

      const printWindow = new BrowserWindow({
        width: 816,
        height: 1056,
        show: true,  // Show window so print dialog appears properly
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          webSecurity: false  // Allow loading local file:// images
        }
      });

      // Load the HTML file
      await printWindow.loadFile(tempHtmlPath);
      console.log('[Print] HTML loaded');

      // Wait for images to load
      await new Promise(resolve => setTimeout(resolve, 2000));
      console.log('[Print] Opening print dialog...');

      return new Promise((resolve) => {
        printWindow.webContents.print({
          silent: false,
          printBackground: true,
          pageSize: 'Letter',
          margins: { marginType: 'none' },
          scaleFactor: 100
        }, (success, failureReason) => {
          console.log('[Print] Print result:', success, failureReason);
          printWindow.close();
          // Cleanup temp files after delay
          setTimeout(() => {
            for (const f of tempFiles) {
              try { fs.unlinkSync(f); } catch (e) { /* ignore */ }
            }
          }, 60000);
          resolve({ success, error: failureReason });
        });
      });
    } catch (error) {
      console.error('[Print:printWithDialog Error]', error);
      return { success: false, error: error.message };
    }
  });

  // Silent print with specified settings
  ipcMain.handle('print:print', async (_event, options = {}) => {
    try {
      const { imagePath, printerName, copies, color, landscape } = options;
      if (!imagePath) {
        return { success: false, error: 'No image path provided' };
      }

      const { BrowserWindow } = require('electron');
      const printWindow = new BrowserWindow({
        width: 800,
        height: 600,
        show: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true
        }
      });

      const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body {
              display: flex;
              justify-content: center;
              align-items: center;
              min-height: 100vh;
              background: white;
            }
            img {
              max-width: 100%;
              max-height: 100vh;
              object-fit: contain;
            }
            @media print {
              body { margin: 0; }
              img { max-width: 100%; max-height: 100%; }
            }
          </style>
        </head>
        <body>
          <img src="file://${imagePath.replace(/\\/g, '/')}" />
        </body>
        </html>
      `;

      await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`);
      await new Promise(resolve => setTimeout(resolve, 500));

      const printOptions = {
        silent: true,
        printBackground: true,
        copies: copies || 1,
        color: color !== false
      };

      if (printerName) {
        printOptions.deviceName = printerName;
      }

      if (landscape !== undefined) {
        printOptions.landscape = landscape;
      }

      return new Promise((resolve) => {
        printWindow.webContents.print(printOptions, (success, failureReason) => {
          printWindow.close();
          if (success) {
            resolve({ success: true });
          } else {
            resolve({ success: false, error: failureReason || 'Print failed' });
          }
        });
      });
    } catch (error) {
      console.error('[Print:print Error]', error);
      return { success: false, error: error.message };
    }
  });

  // Print to PDF
  ipcMain.handle('print:toPdf', async (_event, options = {}) => {
    try {
      const { imagePath, savePath, landscape, pageSize } = options;
      if (!imagePath) {
        return { success: false, error: 'No image path provided' };
      }

      const { BrowserWindow } = require('electron');
      const printWindow = new BrowserWindow({
        width: 800,
        height: 600,
        show: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true
        }
      });

      const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body {
              display: flex;
              justify-content: center;
              align-items: center;
              min-height: 100vh;
              background: white;
            }
            img {
              max-width: 100%;
              max-height: 100vh;
              object-fit: contain;
            }
          </style>
        </head>
        <body>
          <img src="file://${imagePath.replace(/\\/g, '/')}" />
        </body>
        </html>
      `;

      await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`);
      await new Promise(resolve => setTimeout(resolve, 500));

      const pdfOptions = {
        marginsType: 0,
        printBackground: true,
        landscape: landscape || false,
        pageSize: pageSize || 'Letter'
      };

      const pdfData = await printWindow.webContents.printToPDF(pdfOptions);
      printWindow.close();

      if (savePath) {
        const fs = require('fs');
        fs.writeFileSync(savePath, pdfData);
        return { success: true, path: savePath };
      }

      return { success: true, data: pdfData.toString('base64') };
    } catch (error) {
      console.error('[Print:toPdf Error]', error);
      return { success: false, error: error.message };
    }
  });

  // Select image file dialog
  ipcMain.handle('print:selectFile', async () => {
    try {
      const { dialog } = require('electron');
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Select Image to Print',
        filters: [
          { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'tiff', 'tif', 'bmp', 'gif', 'webp'] }
        ],
        properties: ['openFile']
      });

      if (result.canceled || !result.filePaths.length) {
        return { success: false, canceled: true };
      }

      const filePath = result.filePaths[0];
      const fs = require('fs');
      const path = require('path');
      const stats = fs.statSync(filePath);

      return {
        success: true,
        path: filePath,
        name: path.basename(filePath),
        size: stats.size
      };
    } catch (error) {
      console.error('[Print:selectFile Error]', error);
      return { success: false, error: error.message };
    }
  });

  // Save PDF dialog
  ipcMain.handle('print:savePdfDialog', async () => {
    try {
      const { dialog } = require('electron');
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Save as PDF',
        defaultPath: 'print.pdf',
        filters: [
          { name: 'PDF Files', extensions: ['pdf'] }
        ]
      });

      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true };
      }

      return { success: true, path: result.filePath };
    } catch (error) {
      console.error('[Print:savePdfDialog Error]', error);
      return { success: false, error: error.message };
    }
  });

  // ========================================
  // Facebook Schedule Manager (Server-based)
  // ========================================

  // List mockup templates
  ipcMain.handle('fb-schedule:list-templates', async () => {
    try {
      const settings = ensureServerConfigured();
      const url = new URL('/api/facebook/mockup-templates', settings.serverBaseUrl);
      const { fetch: doFetch } = await ensureFetch();

      const response = await doFetch(url.toString(), {
        headers: { 'X-API-Key': settings.apiKey || '' }
      });
      const data = await response.json();
      return { success: true, templates: data.templates || [] };
    } catch (error) {
      console.error('[FB Schedule] List templates error:', error);
      return { success: false, error: error.message };
    }
  });

  // Create mockup template
  ipcMain.handle('fb-schedule:create-template', async (_event, template) => {
    try {
      const settings = ensureServerConfigured();
      const url = new URL('/api/facebook/mockup-templates', settings.serverBaseUrl);
      const { fetch: doFetch } = await ensureFetch();

      const response = await doFetch(url.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': settings.apiKey || ''
        },
        body: JSON.stringify(template)
      });

      // Check if response is ok before parsing JSON
      if (!response.ok) {
        const text = await response.text();
        console.error('[FB Schedule] Create template failed:', response.status, text);
        return { success: false, error: text || `Server returned ${response.status}` };
      }

      const data = await response.json();
      return data;
    } catch (error) {
      console.error('[FB Schedule] Create template error:', error);
      return { success: false, error: error.message };
    }
  });

  // List scheduled posts
  ipcMain.handle('fb-schedule:list-posts', async () => {
    try {
      const settings = ensureServerConfigured();
      const url = new URL('/api/facebook/scheduled-posts', settings.serverBaseUrl);
      const { fetch: doFetch } = await ensureFetch();

      const response = await doFetch(url.toString(), {
        headers: { 'X-API-Key': settings.apiKey || '' }
      });

      // Check if response is ok before parsing JSON
      if (!response.ok) {
        const text = await response.text();
        console.error('[FB Schedule] List posts failed:', response.status, text);
        return { success: false, error: text || `Server returned ${response.status}`, posts: [] };
      }

      const data = await response.json();
      return { success: true, posts: data.posts || [] };
    } catch (error) {
      console.error('[FB Schedule] List posts error:', error);
      return { success: false, error: error.message };
    }
  });

  // Schedule posts for a campaign
  ipcMain.handle('fb-schedule:schedule-campaign', async (_event, options) => {
    try {
      const settings = ensureServerConfigured();
      const url = new URL('/api/facebook/schedule-campaign', settings.serverBaseUrl);
      const { fetch: doFetch } = await ensureFetch();

      const response = await doFetch(url.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': settings.apiKey || ''
        },
        body: JSON.stringify(options)
      });

      // Check if response is ok before parsing JSON
      if (!response.ok) {
        const text = await response.text();
        console.error('[FB Schedule] Schedule campaign failed:', response.status, text);
        return { success: false, error: text || `Server returned ${response.status}` };
      }

      const data = await response.json();
      return data;
    } catch (error) {
      console.error('[FB Schedule] Schedule campaign error:', error);
      return { success: false, error: error.message };
    }
  });

  // Process pending posts now
  ipcMain.handle('fb-schedule:process-pending', async () => {
    try {
      const settings = ensureServerConfigured();
      const url = new URL('/api/facebook/process-pending', settings.serverBaseUrl);
      const { fetch: doFetch } = await ensureFetch();

      const response = await doFetch(url.toString(), {
        method: 'POST',
        headers: { 'X-API-Key': settings.apiKey || '' }
      });

      // Check if response is ok before parsing JSON
      if (!response.ok) {
        const text = await response.text();
        console.error('[FB Schedule] Process pending failed:', response.status, text);
        return { success: false, error: text || `Server returned ${response.status}` };
      }

      const data = await response.json();
      return data;
    } catch (error) {
      console.error('[FB Schedule] Process pending error:', error);
      return { success: false, error: error.message };
    }
  });

  // Post a single scheduled post immediately
  ipcMain.handle('fb-schedule:post-now', async (_event, postId) => {
    console.log('[FB Schedule] Post now called with postId:', postId);
    try {
      const settings = ensureServerConfigured();
      const url = new URL(`/api/facebook/scheduled-posts/${postId}/post`, settings.serverBaseUrl);
      console.log('[FB Schedule] Posting to URL:', url.toString());
      const { fetch: doFetch } = await ensureFetch();

      const response = await doFetch(url.toString(), {
        method: 'POST',
        headers: { 'X-API-Key': settings.apiKey || '' }
      });

      console.log('[FB Schedule] Response status:', response.status);

      // Check if response is ok before parsing JSON
      if (!response.ok) {
        const text = await response.text();
        console.error('[FB Schedule] Post now failed:', response.status, text);
        return { success: false, error: text || `Server returned ${response.status}` };
      }

      const data = await response.json();
      console.log('[FB Schedule] Post now response:', data);
      return data;
    } catch (error) {
      console.error('[FB Schedule] Post now error:', error);
      return { success: false, error: error.message };
    }
  });

  // Delete a scheduled post
  ipcMain.handle('fb-schedule:delete-post', async (_event, postId) => {
    try {
      const settings = ensureServerConfigured();
      const url = new URL(`/api/facebook/scheduled-posts/${postId}`, settings.serverBaseUrl);
      const { fetch: doFetch } = await ensureFetch();

      const response = await doFetch(url.toString(), {
        method: 'DELETE',
        headers: { 'X-API-Key': settings.apiKey || '' }
      });

      // Check if response is ok before parsing JSON
      if (!response.ok) {
        const text = await response.text();
        console.error('[FB Schedule] Delete post failed:', response.status, text);
        return { success: false, error: text || `Server returned ${response.status}` };
      }

      const data = await response.json();
      return data;
    } catch (error) {
      console.error('[FB Schedule] Delete post error:', error);
      return { success: false, error: error.message };
    }
  });

  // Retry a failed post
  ipcMain.handle('fb-schedule:retry-post', async (_event, postId) => {
    try {
      const settings = ensureServerConfigured();
      const url = new URL(`/api/facebook/scheduled-posts/${postId}/retry`, settings.serverBaseUrl);
      const { fetch: doFetch } = await ensureFetch();

      const response = await doFetch(url.toString(), {
        method: 'POST',
        headers: { 'X-API-Key': settings.apiKey || '' }
      });

      // Check if response is ok before parsing JSON
      if (!response.ok) {
        const text = await response.text();
        console.error('[FB Schedule] Retry post failed:', response.status, text);
        return { success: false, error: text || `Server returned ${response.status}` };
      }

      const data = await response.json();
      return data;
    } catch (error) {
      console.error('[FB Schedule] Retry post error:', error);
      return { success: false, error: error.message };
    }
  });

  // ========================================
  // Facebook Insights API
  // ========================================

  // Get insights for a single Facebook post
  ipcMain.handle('fb-insights:get-post', async (_event, facebookPostId) => {
    try {
      const settings = ensureServerConfigured();
      const url = new URL(`/api/facebook/posts/${facebookPostId}/insights`, settings.serverBaseUrl);
      const { fetch: doFetch } = await ensureFetch();

      const response = await doFetch(url.toString(), {
        method: 'GET',
        headers: { 'X-API-Key': settings.apiKey || '' }
      });

      if (!response.ok) {
        const text = await response.text();
        console.error('[FB Insights] Get post insights failed:', response.status, text);
        return { success: false, error: text || `Server returned ${response.status}` };
      }

      const data = await response.json();
      return data;
    } catch (error) {
      console.error('[FB Insights] Get post insights error:', error);
      return { success: false, error: error.message };
    }
  });

  // Get insights for all published scheduled posts (with pagination)
  ipcMain.handle('fb-insights:get-all', async (_event, options = {}) => {
    try {
      const settings = ensureServerConfigured();
      const url = new URL('/api/facebook/scheduled-posts/insights', settings.serverBaseUrl);
      // Add pagination params - always send both
      url.searchParams.set('limit', options.limit || 20);
      url.searchParams.set('offset', options.offset || 0);
      console.log('[FB Insights] Fetching with pagination:', { limit: options.limit, offset: options.offset, url: url.toString() });
      const { fetch: doFetch } = await ensureFetch();

      const response = await doFetch(url.toString(), {
        method: 'GET',
        headers: { 'X-API-Key': settings.apiKey || '' }
      });

      if (!response.ok) {
        const text = await response.text();
        console.error('[FB Insights] Get all insights failed:', response.status, text);
        return { success: false, error: text || `Server returned ${response.status}` };
      }

      const data = await response.json();
      return data;
    } catch (error) {
      console.error('[FB Insights] Get all insights error:', error);
      return { success: false, error: error.message };
    }
  });

  // Get insights summary (aggregated stats)
  ipcMain.handle('fb-insights:get-summary', async (_event, options = {}) => {
    try {
      const settings = ensureServerConfigured();
      const url = new URL('/api/facebook/insights/summary', settings.serverBaseUrl);

      // Add query params
      if (options.campaignSlug) {
        url.searchParams.set('campaignSlug', options.campaignSlug);
      }
      if (options.days) {
        url.searchParams.set('days', options.days.toString());
      }

      const { fetch: doFetch } = await ensureFetch();

      const response = await doFetch(url.toString(), {
        method: 'GET',
        headers: { 'X-API-Key': settings.apiKey || '' }
      });

      if (!response.ok) {
        const text = await response.text();
        console.error('[FB Insights] Get summary failed:', response.status, text);
        return { success: false, error: text || `Server returned ${response.status}` };
      }

      const data = await response.json();
      return data;
    } catch (error) {
      console.error('[FB Insights] Get summary error:', error);
      return { success: false, error: error.message };
    }
  });

  // ========================================
  // Copy Generator - AI-Powered Ad Copy
  // ========================================

  // Generate comprehensive campaign copy
  ipcMain.handle('copy:campaign:generate', async (_event, payload = {}) => {
    try {
      const copyGenerator = require('./copy-generator');
      const { campaign, options } = payload;

      if (!copyGenerator.isConfigured()) {
        return {
          success: false,
          error: 'Anthropic API key not configured. Add ANTHROPIC_API_KEY to .env file.'
        };
      }

      const result = await copyGenerator.generateCampaignCopy(campaign, options || {});
      return { success: true, data: result };
    } catch (error) {
      console.error('[Copy Generator Campaign Error]', error);
      return { success: false, error: error.message || 'Failed to generate copy' };
    }
  });

  // Generate headlines only
  ipcMain.handle('copy:headlines:generate', async (_event, payload = {}) => {
    try {
      const copyGenerator = require('./copy-generator');
      const { campaign, count, options } = payload;

      if (!copyGenerator.isConfigured()) {
        return {
          success: false,
          error: 'Anthropic API key not configured. Add ANTHROPIC_API_KEY to .env file.'
        };
      }

      const result = await copyGenerator.generateHeadlines(campaign, count || 10, options || {});
      return { success: true, data: result };
    } catch (error) {
      console.error('[Copy Generator Headlines Error]', error);
      return { success: false, error: error.message || 'Failed to generate headlines' };
    }
  });

  // Generate product description
  ipcMain.handle('copy:description:generate', async (_event, payload = {}) => {
    try {
      const copyGenerator = require('./copy-generator');
      const { product, options } = payload;

      if (!copyGenerator.isConfigured()) {
        return {
          success: false,
          error: 'Anthropic API key not configured. Add ANTHROPIC_API_KEY to .env file.'
        };
      }

      const result = await copyGenerator.generateProductDescription(product, options || {});
      return { success: true, data: result };
    } catch (error) {
      console.error('[Copy Generator Description Error]', error);
      return { success: false, error: error.message || 'Failed to generate description' };
    }
  });

  // Generate email subject lines
  ipcMain.handle('copy:email:generate', async (_event, payload = {}) => {
    try {
      const copyGenerator = require('./copy-generator');
      const { campaign, count, options } = payload;

      if (!copyGenerator.isConfigured()) {
        return {
          success: false,
          error: 'Anthropic API key not configured. Add ANTHROPIC_API_KEY to .env file.'
        };
      }

      const result = await copyGenerator.generateEmailSubjects(campaign, count || 10, options || {});
      return { success: true, data: result };
    } catch (error) {
      console.error('[Copy Generator Email Error]', error);
      return { success: false, error: error.message || 'Failed to generate email subjects' };
    }
  });

  // Generate A/B test variations
  ipcMain.handle('copy:abtest:generate', async (_event, payload = {}) => {
    try {
      const copyGenerator = require('./copy-generator');
      const { originalCopy, element, count } = payload;

      if (!copyGenerator.isConfigured()) {
        return {
          success: false,
          error: 'Anthropic API key not configured. Add ANTHROPIC_API_KEY to .env file.'
        };
      }

      const result = await copyGenerator.generateABTestVariations(originalCopy, element || 'headline', count || 3);
      return { success: true, data: result };
    } catch (error) {
      console.error('[Copy Generator A/B Test Error]', error);
      return { success: false, error: error.message || 'Failed to generate A/B test variations' };
    }
  });

  // Improve existing copy
  ipcMain.handle('copy:improve', async (_event, payload = {}) => {
    try {
      const copyGenerator = require('./copy-generator');
      const { existingCopy, options } = payload;

      if (!copyGenerator.isConfigured()) {
        return {
          success: false,
          error: 'Anthropic API key not configured. Add ANTHROPIC_API_KEY to .env file.'
        };
      }

      const result = await copyGenerator.improveCopy(existingCopy, options || {});
      return { success: true, data: result };
    } catch (error) {
      console.error('[Copy Generator Improve Error]', error);
      return { success: false, error: error.message || 'Failed to improve copy' };
    }
  });

  // Local catalog: directory selection (folder chooser)
  ipcMain.handle('dialog:selectFolder', async (_event, options = {}) => {
    const result = await dialog.showOpenDialog({
      title: options.title || 'Select a folder',
      properties: ['openDirectory']
    });
    if (result.canceled) return [];
    return result.filePaths;
  });

  // Local catalog: scan directory recursively and return candidate images with metadata and duplicate flag
  ipcMain.handle('local:scan', async (_event, payload = {}) => {
    const { directory } = payload || {};
    if (!directory) throw new Error('Scan directory is required.');

    async function walk(dir) {
      const out = [];
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          // skip hidden/system folders
          if (entry.name.startsWith('.')) continue;
          out.push(...(await walk(full)));
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (!SCAN_EXTENSIONS.has(ext)) continue;
          out.push(full);
        }
      }
      return out;
    }

    const files = await walk(directory);
    const groups = new Map();
    for (const file of files) {
      const dir = path.dirname(file);
      const base = path.basename(file, path.extname(file));
      const key = `${dir}__${base}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(file);
    }

    function pickPreview(candidates) {
      // Prefer images, then SVG, then PDF, then AI/EPS
      const priority = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.pdf', '.ai', '.eps'];
      const sorted = [...candidates].sort((a, b) => {
        const ea = priority.indexOf(path.extname(a).toLowerCase());
        const eb = priority.indexOf(path.extname(b).toLowerCase());
        return (ea === -1 ? 999 : ea) - (eb === -1 ? 999 : eb);
      });
      return sorted[0];
    }

    // Preload existing perceptual hashes for near-duplicate detection
    const existingPhashes = (localDb?.allPhashes?.() || []).filter((r) => r.phash);
    const results = [];
    for (const [_key, fileList] of groups.entries()) {
      try {
        const previewCandidate = pickPreview(fileList);
        const stat = await fs.promises.stat(previewCandidate);
        const hash = await new Promise((resolve, reject) => {
          const h = crypto.createHash('sha256');
          const rs = fs.createReadStream(previewCandidate);
          rs.on('error', reject);
          rs.on('data', (chunk) => h.update(chunk));
          rs.on('end', () => resolve(h.digest('hex')));
        });
        const parent = path.basename(path.dirname(previewCandidate));
        const base = path.basename(previewCandidate, path.extname(previewCandidate));
        const duplicate = Boolean(localDb?.findByHash(hash));
        const file_type = path.extname(previewCandidate).replace('.', '').toLowerCase();
        // Sibling vector sources
        const sourcePaths = fileList.filter((p) => DOC_EXTENSIONS.has(path.extname(p).toLowerCase()) || VECTOR_EXTENSIONS.has(path.extname(p).toLowerCase()));
        // Compute perceptual hash for near-duplicate detection
        let phash = null; let nearDuplicate = false; let nearOf = null;
        try {
          phash = await computePhash(previewCandidate);
          if (phash && existingPhashes.length) {
            const { near, id } = findNearestPhash(phash, existingPhashes, 6);
            nearDuplicate = near;
            nearOf = id || null;
          }
        } catch (_) {}

        results.push({
          path: previewCandidate,
          sources: sourcePaths,
          category: parent,
          title: base,
          file_type,
          size: stat.size,
          hash,
          phash,
          duplicate,
          nearDuplicate,
          nearOf
        });
      } catch (_) {}
    }
    return results;
  });

  // Local catalog: import a batch of scanned items into SQLite (dedupe by hash)
  ipcMain.handle('local:import', async (_event, payload = {}) => {
    const { items = [] } = payload || {};
    if (!Array.isArray(items) || !items.length) return [];
    ensureLocalDb();
    if (!localDb) return [];
    const saved = [];
    for (const item of items) {
      try {
        let phash = item.phash || null;
        if (!phash) {
          try { phash = await computePhash(item.path); } catch (_) {}
        }
        const record = localDb.upsert({
          path: item.path,
          category: item.category,
          title: item.title,
          file_type: item.file_type,
          size: item.size,
          hash: item.hash,
          phash,
          status: 'imported'
        });
        saved.push(record);
      } catch (_) {}
    }
    return saved;
  });

  ipcMain.handle('local:list', (_event, options) => {
    const db = ensureLocalDb();
    if (!db) return [];
    return db.list(options || {});
  });

  ipcMain.handle('local:update', (_event, payload = {}) => {
    const { id, updates } = payload || {};
    if (!id) throw new Error('id is required');
    const db = ensureLocalDb();
    if (!db) throw new Error('Local catalog DB unavailable.');
    return db.update(id, updates || {});
  });

  ipcMain.handle('local:delete', (_event, id) => {
    if (!id) throw new Error('id is required');
    const db = ensureLocalDb();
    if (!db) throw new Error('Local catalog DB unavailable.');
    db.remove(id);
    return { success: true };
  });

  ipcMain.handle('local:categories', () => {
    const db = ensureLocalDb();
    if (!db) return [];
    return db.categories();
  });

  ipcMain.handle('local:approve', (_event, payload = {}) => {
    const { ids = [] } = payload || {};
    if (!Array.isArray(ids) || !ids.length) return { updated: 0 };
    const db = ensureLocalDb();
    if (!db) return { updated: 0 };
    const updated = db.updateMany(ids, { status: 'approved' });
    return { updated };
  });

  ipcMain.handle('local:approveCategory', (_event, category) => {
    if (typeof category !== 'string') throw new Error('category is required');
    const db = ensureLocalDb();
    if (!db) return { updated: 0 };
    const updated = db.approveCategory(category);
    return { updated };
  });

  // Export selected items to a directory (optimized preview preferred)
  ipcMain.handle('local:export', async (_event, payload = {}) => {
    const { ids = [], destDir, variant = 'preview' } = payload || {};
    if (!Array.isArray(ids) || !ids.length) return { exported: 0, files: [] };
    let targetDir = destDir;
    if (!targetDir) {
      const res = await dialog.showOpenDialog({ title: 'Choose export folder', properties: ['openDirectory'] });
      if (res.canceled || !res.filePaths?.[0]) return { exported: 0, files: [] };
      targetDir = res.filePaths[0];
    }
    const files = [];
    for (const id of ids) {
      const row = ensureLocalDb()?.getById(id);
      if (!row) continue;
      let src = row.path;
      if (variant === 'preview') {
        try { src = row.optimized_path || (await optimizePreview(row)); } catch (_) {}
      }
      const ext = path.extname(src) || '.jpg';
      const base = sanitizeSegment(row.title || path.basename(src, ext));
      const out = path.join(targetDir, `${base}${ext.toLowerCase() === '.svg' ? '.png' : ext}`);
      try {
        if (ext.toLowerCase() === '.svg') {
          // Rasterize SVG to PNG for printing convenience
          await sharp(await fs.promises.readFile(src)).png({ quality: 100 }).toFile(out);
        } else {
          await fs.promises.copyFile(src, out);
        }
        files.push(out);
      } catch (_) {}
    }
    return { exported: files.length, files };
  });

  // Bulk mockup generation: composite preview onto user-selected background
  ipcMain.handle('local:mockups', async (_event, payload = {}) => {
    const { ids = [], background, destDir, widthPct = 40, yOffsetPct = 0, removeBg = false, keyColor = '#ffffff', fuzzPct = 10, jobId } = payload || {};
    if (!Array.isArray(ids) || !ids.length) return { generated: 0, files: [] };
    let bgPath = background;
    if (!bgPath) {
      const res = await dialog.showOpenDialog({ title: 'Choose mockup background', properties: ['openFile'], filters: [{ name: 'Images', extensions: ['jpg','jpeg','png','webp'] }] });
      if (res.canceled || !res.filePaths?.[0]) return { generated: 0, files: [] };
      bgPath = res.filePaths[0];
    }
    let outDir = destDir;
    if (!outDir) {
      const res2 = await dialog.showOpenDialog({ title: 'Choose output folder', properties: ['openDirectory'] });
      if (res2.canceled || !res2.filePaths?.[0]) return { generated: 0, files: [] };
      outDir = res2.filePaths[0];
    }
    const bgMeta = await sharp(bgPath).metadata();
    const bgW = bgMeta.width || 2000;
    const targetW = Math.round((Math.max(10, Math.min(150, Number(widthPct))) / 100) * bgW);
    const yOffset = Math.round(((Number.isFinite(yOffsetPct) ? yOffsetPct : 0) / 100) * (bgMeta.height || 2000));
    const outputs = [];
    try { _event?.sender?.send('local:mockups:progress', { current: 0, total: ids.length }); } catch (_) {}
    for (let i = 0; i < ids.length; i++) {
      if (jobId && cancelledJobs.has(String(jobId))) break;
      const id = ids[i];
      const row = localDb.getById(id);
      if (!row) continue;
      const preview = row.optimized_path || (await optimizePreview(row));
    // Allow upscaling here so small decals can be made large enough
    let design = await sharp(preview).resize({ width: targetW }).toBuffer();
      if (removeBg) {
        try {
          const stripped = await removeBackgroundWithMagickBuffer(design, { keyColor, fuzzPct });
          if (stripped) design = stripped;
        } catch (_) {}
      }
      const designMeta = await sharp(design).metadata();
      const left = Math.max(0, Math.round((bgW - (designMeta.width || targetW)) / 2));
      const top = Math.max(0, Math.round(((bgMeta.height || 2000) - (designMeta.height || targetW)) / 2 + yOffset));
      const out = path.join(outDir, `${sanitizeSegment(row.title || 'mockup')}-mockup.jpg`);
      await sharp(bgPath)
        .composite([{ input: design, top, left }])
        .jpeg({ quality: 88 })
        .toFile(out);
      outputs.push(out);
      try { _event?.sender?.send('local:mockups:progress', { current: i + 1, total: ids.length, id, name: row.title || path.basename(row.path), jobId }); } catch (_) {}
    }
    return { generated: outputs.length, files: outputs };
  });

  // Convert hex color to human-readable color name for AI recoloring
  // Maps common hex colors to descriptive names that work well with AI prompts
  function hexToColorName(hex) {
    if (!hex) return 'white';
    const h = hex.replace('#', '').toLowerCase();

    // Common color mappings for apparel
    const colorMap = {
      // Blacks & Grays
      '000000': 'black',
      '1a1a1a': 'black',
      '2d2d2d': 'charcoal gray',
      '333333': 'dark gray',
      '4d4d4d': 'dark gray',
      '666666': 'gray',
      '808080': 'gray',
      '999999': 'light gray',
      'b3b3b3': 'light gray',
      'cccccc': 'silver gray',
      'd9d9d9': 'light gray',
      'ffffff': 'white',
      // Blues
      '000080': 'navy blue',
      '00008b': 'dark blue',
      '0000cd': 'medium blue',
      '0000ff': 'blue',
      '191970': 'midnight blue',
      '1e3a5f': 'navy blue',
      '1e90ff': 'dodger blue',
      '4169e1': 'royal blue',
      '4682b4': 'steel blue',
      '5f9ea0': 'cadet blue',
      '6495ed': 'cornflower blue',
      '87ceeb': 'sky blue',
      '87cefa': 'light sky blue',
      'add8e6': 'light blue',
      'b0c4de': 'light steel blue',
      // Reds
      '800000': 'maroon',
      '8b0000': 'dark red',
      'a52a2a': 'brown',
      'b22222': 'firebrick red',
      'cd5c5c': 'indian red',
      'dc143c': 'crimson red',
      'ff0000': 'red',
      'ff4500': 'orange red',
      'ff6347': 'tomato red',
      // Greens
      '006400': 'dark green',
      '008000': 'green',
      '228b22': 'forest green',
      '2e8b57': 'sea green',
      '32cd32': 'lime green',
      '3cb371': 'medium sea green',
      '556b2f': 'dark olive green',
      '6b8e23': 'olive drab',
      '7cfc00': 'lawn green',
      '808000': 'olive',
      '90ee90': 'light green',
      '98fb98': 'pale green',
      // Purples
      '4b0082': 'indigo',
      '663399': 'rebecca purple',
      '6a5acd': 'slate blue',
      '7b68ee': 'medium slate blue',
      '800080': 'purple',
      '8a2be2': 'blue violet',
      '8b008b': 'dark magenta',
      '9370db': 'medium purple',
      '9932cc': 'dark orchid',
      'ba55d3': 'medium orchid',
      'dda0dd': 'plum',
      'ee82ee': 'violet',
      // Browns/Tans
      '8b4513': 'saddle brown',
      'a0522d': 'sienna brown',
      'cd853f': 'peru brown',
      'd2691e': 'chocolate brown',
      'd2b48c': 'tan',
      'deb887': 'burlywood',
      'f4a460': 'sandy brown',
      // Pinks
      'c71585': 'medium violet red',
      'db7093': 'pale violet red',
      'ff1493': 'deep pink',
      'ff69b4': 'hot pink',
      'ffb6c1': 'light pink',
      'ffc0cb': 'pink',
      // Oranges/Yellows
      'ff7f50': 'coral',
      'ff8c00': 'dark orange',
      'ffa500': 'orange',
      'ffd700': 'gold',
      'ffff00': 'yellow',
      // Teals/Cyans
      '008080': 'teal',
      '008b8b': 'dark cyan',
      '00ced1': 'dark turquoise',
      '20b2aa': 'light sea green',
      '40e0d0': 'turquoise',
      '48d1cc': 'medium turquoise',
      '00ffff': 'cyan',
      '7fffd4': 'aquamarine',
      'afeeee': 'pale turquoise',
      'e0ffff': 'light cyan'
    };

    // Check for exact match first
    if (colorMap[h]) return colorMap[h];

    // Parse RGB components
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);

    // Determine basic hue and describe it
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const brightness = (r + g + b) / 3;
    const saturation = max === 0 ? 0 : (max - min) / max;

    // Grayscale detection
    if (saturation < 0.15) {
      if (brightness < 50) return 'black';
      if (brightness < 100) return 'charcoal gray';
      if (brightness < 150) return 'gray';
      if (brightness < 200) return 'light gray';
      if (brightness < 240) return 'off-white';
      return 'white';
    }

    // Calculate hue
    let hue;
    if (max === r) {
      hue = ((g - b) / (max - min)) * 60;
    } else if (max === g) {
      hue = (2 + (b - r) / (max - min)) * 60;
    } else {
      hue = (4 + (r - g) / (max - min)) * 60;
    }
    if (hue < 0) hue += 360;

    // Determine lightness modifier
    let lightMod = '';
    if (brightness < 80) lightMod = 'dark ';
    else if (brightness > 200) lightMod = 'light ';

    // Map hue to color name
    if (hue < 15 || hue >= 345) return lightMod + 'red';
    if (hue < 45) return lightMod + 'orange';
    if (hue < 70) return lightMod + 'yellow';
    if (hue < 150) return lightMod + 'green';
    if (hue < 195) return lightMod + 'cyan';
    if (hue < 260) return lightMod + 'blue';
    if (hue < 290) return lightMod + 'purple';
    if (hue < 345) return lightMod + 'pink';

    return 'unknown color';
  }

  // Apply clothing color tint to white/neutral clothing areas
  // Uses multiplicative blend to preserve shadows/creases for realistic fabric look
  async function tintClothingColor(inputBuffer, targetColor) {
    if (!targetColor || targetColor === '#ffffff' || targetColor === '#FFFFFF') {
      return inputBuffer; // No tinting needed for white
    }
    // Parse hex color
    const hex = targetColor.replace('#', '');
    const tR = parseInt(hex.substring(0, 2), 16) / 255;
    const tG = parseInt(hex.substring(2, 4), 16) / 255;
    const tB = parseInt(hex.substring(4, 6), 16) / 255;

    // Get raw pixel data from input image
    const image = sharp(inputBuffer);
    const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;

    const newData = Buffer.alloc(data.length);

    for (let i = 0; i < data.length; i += channels) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = channels === 4 ? data[i + 3] : 255;

      // Heuristic detection for white/neutral clothing
      const rgbDiff = Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(r - b));
      const isNeutral = rgbDiff <= 10;

      // Detect background pixels
      const isPureWhiteBg = r >= 248 && g >= 248 && b >= 248 && isNeutral;
      const isGrayBg = r >= 190 && r <= 215 && g >= 190 && g <= 215 && b >= 190 && b <= 215 && isNeutral;
      const isBackground = isPureWhiteBg || isGrayBg;

      let shouldTint = false;
      if (!isBackground) {
        const brightness = (r + g + b) / 3;
        const isWhiteClothing = brightness > 220 && isNeutral;
        const isShadowedWhite = brightness >= 150 && brightness <= 220 && rgbDiff <= 20;
        shouldTint = isWhiteClothing || isShadowedWhite;
      }

      if (shouldTint) {
        // Multiplicative blend - preserves shadows/creases
        newData[i] = Math.round(r * tR);
        newData[i + 1] = Math.round(g * tG);
        newData[i + 2] = Math.round(b * tB);
      } else {
        // Keep original pixel
        newData[i] = r;
        newData[i + 1] = g;
        newData[i + 2] = b;
      }
      if (channels === 4) {
        newData[i + 3] = a;
      }
    }

    // Reconstruct image
    return sharp(newData, { raw: { width, height, channels } }).png().toBuffer();
  }

  // Compose a single mockup from a base image (garment) and an overlay (design)
  ipcMain.handle('mockup:compose', async (_event, payload = {}) => {
    const {
      baseImage,
      overlayImage,
      widthPct = 40,
      xOffsetPct = 0,
      yOffsetPct = 0,
      removeBg = false,
      keyColor = '#ffffff',
      fuzzPct = 10,
      boostWhites = false,
      whitesFloor = 92,
      outputWidth = 2400,
      // Decal transformations
      decalSize = 100,
      decalRotation = 0,
      decalColor = null
    } = payload || {};

    if (!baseImage || !overlayImage) throw new Error('baseImage and overlayImage are required.');

    // Resolve inputs to local buffers/paths
    let basePath = await resolveToLocalPath(baseImage);
    const overlayBuf = await resolveToBuffer(overlayImage);
    let meta = await sharp(basePath).metadata();
    console.log(`[mockup:compose] Base image metadata: ${meta.width}x${meta.height}, format: ${meta.format}`);
    let bgW = meta.width || 2000;
    let bgH = meta.height || 2000;
    const desiredOutW = Math.max(1200, Math.min(Number(outputWidth) || 2400, 3000));
    const upscale = bgW < desiredOutW;
    const compositeW = upscale ? desiredOutW : bgW;
    const compositeH = upscale ? Math.round((desiredOutW / bgW) * bgH) : bgH;
    // Apply decal size scaling to width calculation
    const effectiveWidthPct = (Math.max(10, Math.min(150, Number(widthPct))) * (Number(decalSize) || 100)) / 100;
    const targetW = Math.round((effectiveWidthPct / 100) * compositeW);
    const xOffset = Math.round(((Number.isFinite(xOffsetPct) ? xOffsetPct : 0) / 100) * compositeW);
    const yOffset = Math.round(((Number.isFinite(yOffsetPct) ? yOffsetPct : 0) / 100) * compositeH);
    // Allow upscaling overlay so it can exceed original size for small art (e.g., hats)
    // Get original overlay dimensions first to calculate proper aspect ratio
    const overlayMeta = await sharp(overlayBuf).metadata();
    const overlayOrigW = overlayMeta.width || 1000;
    const overlayOrigH = overlayMeta.height || 1000;
    const targetH = Math.round((targetW / overlayOrigW) * overlayOrigH);
    let design = await sharp(overlayBuf).resize({ width: targetW, height: targetH, fit: 'fill' }).toBuffer();

    // Apply decal rotation if specified
    const rotation = Number(decalRotation) || 0;
    if (rotation !== 0) {
      try {
        // Sharp only supports 90, 180, 270 natively - use rotate for any angle
        design = await sharp(design)
          .rotate(rotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .toBuffer();
        console.log(`[mockup:compose] Applied rotation: ${rotation}°`);
      } catch (err) {
        console.warn('[mockup:compose] Rotation failed:', err?.message || err);
      }
    }

    // Apply decal color recoloring if specified
    if (decalColor && typeof decalColor === 'string' && /^#[0-9a-f]{6}$/i.test(decalColor)) {
      try {
        // Parse hex color
        const r = parseInt(decalColor.slice(1, 3), 16);
        const g = parseInt(decalColor.slice(3, 5), 16);
        const b = parseInt(decalColor.slice(5, 7), 16);

        // Get raw pixel data to recolor
        const { data, info } = await sharp(design)
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });

        const { width, height, channels } = info;
        const newData = Buffer.alloc(data.length);

        // Use the same algorithm as the original web decal creator (recolorCanvasToVinyl):
        // - Calculate brightness for each pixel
        // - If brightness > threshold (near white), make transparent
        // - Otherwise, replace with target color at full opacity
        const BRIGHTNESS_THRESHOLD = 230;

        for (let i = 0; i < data.length; i += channels) {
          const origR = data[i];
          const origG = data[i + 1];
          const origB = data[i + 2];
          const alpha = channels === 4 ? data[i + 3] : 255;

          // Skip fully transparent pixels
          if (alpha === 0) {
            newData[i] = origR;
            newData[i + 1] = origG;
            newData[i + 2] = origB;
            if (channels === 4) newData[i + 3] = 0;
            continue;
          }

          // Calculate brightness using standard luminance formula
          const brightness = 0.2126 * origR + 0.7152 * origG + 0.0722 * origB;

          if (brightness > BRIGHTNESS_THRESHOLD) {
            // Near-white pixel - make transparent (background removal)
            newData[i] = origR;
            newData[i + 1] = origG;
            newData[i + 2] = origB;
            if (channels === 4) newData[i + 3] = 0;
          } else {
            // Non-white pixel - replace with target color at full opacity
            newData[i] = r;
            newData[i + 1] = g;
            newData[i + 2] = b;
            if (channels === 4) newData[i + 3] = 255;
          }
        }

        design = await sharp(newData, { raw: { width, height, channels } })
          .png()
          .toBuffer();

        console.log(`[mockup:compose] Applied decal color recolor: ${decalColor}`);
      } catch (err) {
        console.warn('[mockup:compose] Color recolor failed:', err?.message || err);
      }
    }
    if (removeBg) {
      try {
        console.log('[mockup:compose] Removing background with keyColor:', keyColor, 'fuzzPct:', fuzzPct);
        const stripped = await removeBackgroundWithMagickBuffer(design, { keyColor, fuzzPct });
        if (stripped) {
          console.log('[mockup:compose] Background removed successfully');
          design = stripped;
        } else {
          console.warn('[mockup:compose] Background removal returned null');
        }
      } catch (err) {
        console.error('[mockup:compose] Background removal error:', err?.message || err);
      }
    }
    if (boostWhites) {
      try {
        const boosted = await boostWhitesWithMagickBuffer(design, { whitesFloor });
        if (boosted) design = boosted;
      } catch (_) {}
    }
    const designMeta = await sharp(design).metadata();
    const left = Math.max(0, Math.round((compositeW - (designMeta.width || targetW)) / 2 + xOffset));
    const top = Math.max(0, Math.round((compositeH - (designMeta.height || targetH)) / 2 + yOffset));
    const outDir = path.join(app.getPath('temp'), 'print-station-mockups');
    try { fs.mkdirSync(outDir, { recursive: true }); } catch (_) {}
    const outPath = path.join(outDir, `mockup-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
    let baseSharp = sharp(basePath).rotate();
    if (upscale) {
      baseSharp = baseSharp.resize({ width: desiredOutW });
    }
    await baseSharp
      .composite([{ input: design, top, left, blend: 'over', premultiplied: true }])
      .sharpen(0.3)
      .jpeg({ quality: 92, mozjpeg: true, chromaSubsampling: '4:4:4' })
      .toFile(outPath);
    return { success: true, path: outPath };
  });

  // Save a data URL PNG/JPEG to a temporary file and return path
  ipcMain.handle('image:saveTemp', async (_event, payload = {}) => {
    const { dataUrl, extension = 'png' } = payload || {};
    if (!dataUrl || typeof dataUrl !== 'string' || !/^data:image\//i.test(dataUrl)) {
      throw new Error('dataUrl image is required');
    }
    const match = dataUrl.match(/^data:image\/(png|jpeg|jpg);base64,(.*)$/i);
    if (!match) throw new Error('Unsupported data URL');
    const ext = match[1].toLowerCase() === 'jpeg' || match[1].toLowerCase() === 'jpg' ? 'jpg' : 'png';
    const base64 = match[2];
    const buf = Buffer.from(base64, 'base64');
    const outDir = path.join(app.getPath('temp'), 'print-station-images');
    try { fs.mkdirSync(outDir, { recursive: true }); } catch (_) {}
    const outPath = path.join(outDir, `img-${Date.now()}-${Math.random().toString(36).slice(2)}.${extension || ext}`);
    await fs.promises.writeFile(outPath, buf);
    return { success: true, path: outPath };
  });

  ipcMain.handle('image:preflight', async () => {
    const magick = which('magick') || which('convert');
    const gs = which('gs') || which('gswin64c') || which('gswin32c');
    const sharpOk = !!sharp;
    return { magick: magick || null, gs: gs || null, sharp: sharpOk };
  });

  // Vectorize an image (convert raster to SVG using potrace or ImageMagick)
  ipcMain.handle('image:vectorize', async (_event, imagePath) => {
    if (!imagePath) throw new Error('imagePath is required');

    // Resolve to local path
    const localPath = await resolveToLocalPath(imagePath);
    if (!localPath) throw new Error('Could not resolve image path');

    const outDir = path.join(app.getPath('temp'), 'print-station-vectors');
    try { fs.mkdirSync(outDir, { recursive: true }); } catch (_) {}
    const outPath = path.join(outDir, `vector-${Date.now()}-${Math.random().toString(36).slice(2)}.svg`);

    // Try potrace first (best quality)
    const potrace = which('potrace');
    if (potrace) {
      try {
        // Convert to BMP for potrace (it only accepts PBM/PGM/PPM/BMP)
        const bmpPath = path.join(outDir, `temp-${Date.now()}.bmp`);
        await sharp(localPath)
          .threshold(128)
          .toFile(bmpPath);

        await new Promise((resolve, reject) => {
          const proc = require('child_process').spawn(potrace, [
            bmpPath,
            '-s', // SVG output
            '-o', outPath,
            '--turdsize', '2',
            '--alphamax', '1'
          ]);
          proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`potrace exited with code ${code}`)));
          proc.on('error', reject);
        });

        // Clean up temp BMP
        try { fs.unlinkSync(bmpPath); } catch (_) {}

        console.log(`[image:vectorize] Created SVG with potrace: ${outPath}`);
        return { success: true, svgPath: outPath };
      } catch (err) {
        console.warn('[image:vectorize] potrace failed:', err?.message || err);
      }
    }

    // Fallback: Use ImageMagick trace
    const magick = which('magick') || which('convert');
    if (magick) {
      try {
        const args = magick.includes('magick')
          ? [localPath, '-threshold', '50%', '-negate', 'svg:' + outPath]
          : [localPath, '-threshold', '50%', '-negate', 'svg:' + outPath];

        await new Promise((resolve, reject) => {
          const proc = require('child_process').spawn(magick, args);
          proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ImageMagick exited with code ${code}`)));
          proc.on('error', reject);
        });

        console.log(`[image:vectorize] Created SVG with ImageMagick: ${outPath}`);
        return { success: true, svgPath: outPath };
      } catch (err) {
        console.warn('[image:vectorize] ImageMagick trace failed:', err?.message || err);
      }
    }

    // Final fallback: Create a simple embedded SVG with the raster image
    try {
      const imageBuffer = await sharp(localPath).png().toBuffer();
      const base64 = imageBuffer.toString('base64');
      const meta = await sharp(localPath).metadata();
      const w = meta.width || 500;
      const h = meta.height || 500;

      const svgContent = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <image width="${w}" height="${h}" xlink:href="data:image/png;base64,${base64}"/>
</svg>`;

      await fs.promises.writeFile(outPath, svgContent, 'utf8');
      console.log(`[image:vectorize] Created embedded SVG fallback: ${outPath}`);
      return { success: true, svgPath: outPath, fallback: true };
    } catch (err) {
      throw new Error(`Vectorization failed: ${err?.message || err}`);
    }
  });

  // Remove background from an image and return as base64 PNG
  ipcMain.handle('image:removeBackground', async (_event, payload = {}) => {
    const { imageUrl, keyColor = '#ffffff', fuzzPct = 10 } = payload || {};
    if (!imageUrl) throw new Error('imageUrl is required');

    try {
      // Resolve image to buffer
      const buffer = await resolveToBuffer(imageUrl);
      if (!buffer) throw new Error('Could not load image');

      // Remove background using ImageMagick
      const stripped = await removeBackgroundWithMagickBuffer(buffer, { keyColor, fuzzPct });
      if (!stripped) throw new Error('Background removal failed - ImageMagick may not be installed');

      // Return as base64 data URL
      const base64 = stripped.toString('base64');
      return {
        success: true,
        dataUrl: `data:image/png;base64,${base64}`
      };
    } catch (err) {
      console.error('[image:removeBackground] Error:', err?.message || err);
      throw new Error(`Background removal failed: ${err?.message || err}`);
    }
  });

  // Optimize an image for preview/publish and store optimized path in DB
  ipcMain.handle('local:optimize', async (_event, id) => {
    if (!id) throw new Error('id is required');
    const row = ensureLocalDb()?.getById(id);
    if (!row) throw new Error('Item not found');
    const optimized = await optimizePreview(row);
    const updated = ensureLocalDb().update(id, { optimized_path: optimized });
    return updated;
  });

  // Publish selected items to hosted server as new artwork
  ipcMain.handle('local:publish', async (_event, payload = {}) => {
    const { ids = [] } = payload || {};
    const published = [];
    for (const id of ids) {
      const row = ensureLocalDb()?.getById(id);
      if (!row) continue;
      try {
        const previewPath = row.optimized_path || (await optimizePreview(row));
        const displayName = String(row.title || path.basename(row.path, path.extname(row.path)));
        // Gather sibling vector sources using same basename
        const dir = path.dirname(row.path);
        const base = path.basename(row.path, path.extname(row.path));
        const siblings = await fs.promises.readdir(dir);
        const sourcePaths = siblings
          .map((name) => path.join(dir, name))
          .filter((p) => {
            const ext = path.extname(p).toLowerCase();
            return path.basename(p, ext) === base && (VECTOR_EXTENSIONS.has(ext) || DOC_EXTENSIONS.has(ext));
          });
        // Always allow new or existing by name; server will reuse if exists
        await uploadArtwork({
          previewPath,
          sourcePaths,
          categoryMode: 'new',
          newCategoryName: String(row.category || 'Uncategorized'),
          displayName
        });
        ensureLocalDb().update(id, { status: 'published', optimized_path: previewPath });
        published.push({ id, success: true });
      } catch (err) {
        published.push({ id, success: false, error: err?.message || 'Publish failed' });
      }
    }
    return published;
  });

  // OCR extraction for a given path or item id
  ipcMain.handle('local:ocr', async (_event, payload = {}) => {
    const { id, path: filePath } = payload || {};
    let targetPath = filePath || null;
    if (!targetPath && id) {
      const row = localDb.getById(id);
      if (!row) throw new Error('Item not found');
      // Prefer optimized preview for better OCR
      const previewPath = row.optimized_path || (await optimizePreview(row));
      targetPath = previewPath;
    }
    if (!targetPath) throw new Error('path or id required');
    const text = await performOcr(targetPath);
    // Suggest tags from OCR text
    const tags = suggestTags(text);
    // Persist if id provided
    if (id) {
      try { localDb.update(id, { tags: JSON.stringify(tags) }); } catch (_) {}
    }
    return { text, tags };
  });

  ipcMain.handle('quotes:fetch', () => fetchRaceQuotes());
  ipcMain.handle('quotes:detail', (_event, id) => fetchRaceQuoteDetail(id));
  ipcMain.handle('quotes:update', (_event, { id, payload }) => updateRaceQuote(id, payload || {}));
  ipcMain.handle('quotes:message', (_event, { id, message }) => postRaceQuoteMessage(id, message));
  ipcMain.handle('quotes:generate-assets', (_event, { id }) => generateQuoteAssets(id));
  ipcMain.handle('inventory:list', (_event, options) => fetchInventory(options || {}));
  ipcMain.handle('inventory:create', (_event, payload) => createInventoryItem(payload || {}));
  ipcMain.handle('inventory:adjust', (_event, payload) => adjustInventory(payload || {}));
  ipcMain.handle('inventory:update', (_event, payload) => updateInventory(payload || {}));
  ipcMain.handle('inventory:delete', (_event, payload) => deleteInventory(payload || {}));
  ipcMain.handle('apparel:categories:list', () => fetchApparelCategories());
  ipcMain.handle('apparel:categories:create', (_event, payload) =>
    createApparelCategory(payload || {})
  );
  ipcMain.handle('apparel:store', () => fetchApparelStore());
  ipcMain.handle('apparel:store:update', (_event, payload) =>
    updateApparelStoreItem(payload || {})
  );
  ipcMain.handle('vendor:ssaw:styles', (_event, payload) => fetchSsawStyles(payload || {}));
  ipcMain.handle('vendor:ssaw:products', (_event, styleId) => fetchSsawProducts(styleId));
  ipcMain.handle('vendor:ssaw:order:create', (_event, payload) => createVendorOrder(payload || {}));
  ipcMain.handle('vendor:ssaw:orders:list', (_event, params) => fetchSsawOrders(params || {}));
  ipcMain.handle('vendor:local:orders', (_event, params) => fetchLocalVendorOrders(params || {}));
  ipcMain.handle('vendor:local:orders:update', (_event, payload) => updateLocalVendorOrder(payload || {}));
  ipcMain.handle('vendor:local:orders:create', (_event, payload) => createLocalVendorOrderDraft(payload || {}));
  ipcMain.handle('vendor:local:orders:approve', (_event, id) => approveLocalVendorOrder(id));
  ipcMain.handle('vendor:local:orders:reject', (_event, id) => rejectLocalVendorOrder(id));
  ipcMain.handle('vendor:local:orders:top', (_event, params) => fetchLocalTopVendorItems(params || {}));
  ipcMain.handle('vendor:ssaw:config:update', (_event, payload) => updateSsawConfig(payload || {}));
  ipcMain.handle('vendor:ssaw:config', () => fetchSsawConfig());
  ipcMain.handle('files:download', (_event, payload) => downloadFile(payload || {}));

  // AI Recolor - Check if a recolored version exists in cache
  ipcMain.handle('recolor:checkCache', async (_event, { modelId, color, garmentType = 't-shirt' }) => {
    console.log(`[recolor:checkCache] Received: modelId=${modelId}, color=${color}, garmentType=${garmentType}`);
    if (!modelId || !color) {
      console.log(`[recolor:checkCache] Missing params, returning exists=false`);
      return { exists: false, error: 'modelId and color are required' };
    }
    try {
      const colorName = typeof color === 'string' && color.startsWith('#')
        ? hexToColorName(color)
        : color;
      console.log(`[recolor:checkCache] Converted color to: ${colorName}`);
      const result = await httpRequest(
        `/api/human-models/${encodeURIComponent(modelId)}/recolor-check`,
        { method: 'GET', query: { color: colorName, garmentType } }
      );
      console.log(`[recolor:checkCache] Server response:`, JSON.stringify(result));
      return result;
    } catch (error) {
      console.error('[recolor:checkCache] Error:', error.message);
      return { exists: false, error: error.message };
    }
  });

  // AI Recolor - Trigger recolor generation
  ipcMain.handle('recolor:generate', async (_event, { modelId, color, garmentType = 't-shirt' }) => {
    if (!modelId || !color) {
      throw new Error('modelId and color are required');
    }
    const colorName = typeof color === 'string' && color.startsWith('#')
      ? hexToColorName(color)
      : color;
    console.log(`[recolor:generate] Starting AI recolor: ${modelId} -> ${colorName} (${garmentType})`);
    const result = await httpRequest(
      `/api/human-models/${encodeURIComponent(modelId)}/recolor`,
      { method: 'POST', body: { color: colorName, garmentType, force: false } }
    );
    console.log(`[recolor:generate] Completed: ${result.webPath} (cached: ${result.cached})`);
    return result;
  });

  // OCR from a remote URL (downloads to temp, runs OCR, cleans up)
  ipcMain.handle('ocr:fromUrl', async (_event, urlStr) => {
    if (!urlStr) throw new Error('URL is required');
    const { fetch: doFetch } = await ensureFetch();
    const res = await doFetch(urlStr);
    if (!res.ok) {
      const msg = await res.text().catch(() => '');
      throw new Error(msg || `Fetch failed (${res.status})`);
    }
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const tmpDir = app.getPath('temp');
    const tmpPath = path.join(tmpDir, `ocr-${Date.now()}-${Math.random().toString(36).slice(2)}.img`);
    await fs.promises.writeFile(tmpPath, buffer);
    try {
      const text = await performOcr(tmpPath);
      return { text, tags: suggestTags(text) };
    } finally {
      try { await fs.promises.unlink(tmpPath); } catch (_) {}
    }
  });

  // OCR category items locally, send results to server
  ipcMain.handle('ocr:categoryLocal', async (_event, { categorySlug, minConfidence = 30, onProgressChannel }) => {
    if (!categorySlug) throw new Error('categorySlug is required');

    const { fetch: doFetch } = await ensureFetch();
    const settings = ensureServerConfigured();
    const serverUrl = settings.serverBaseUrl || '';
    const apiKey = settings.apiKey || 'internal';

    if (!serverUrl) throw new Error('Server URL not configured');

    // Get list of items from server
    const itemsRes = await doFetch(`${serverUrl}/api/admin/catalog/ocr-items?categorySlug=${encodeURIComponent(categorySlug)}`, {
      headers: { 'x-api-key': apiKey }
    });
    if (!itemsRes.ok) throw new Error(`Failed to get items: ${itemsRes.status}`);
    const { items } = await itemsRes.json();

    if (!items || items.length === 0) {
      return { processed: 0, skipped: 0, failed: 0, total: 0, results: [] };
    }

    const total = items.length;
    let processed = 0, skipped = 0, failed = 0;
    const results = [];
    const tmpDir = app.getPath('temp');
    const win = BrowserWindow.getAllWindows()[0];

    // Ensure tesseract is ready before processing
    await ensureTesseract();

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const progress = { current: i + 1, total, processed, skipped, failed, item: item.name };

      try {
        // Download image from server
        const imageUrl = `${serverUrl}/library/${item.relativePath.replace(/\\/g, '/')}`;
        const imgRes = await doFetch(imageUrl, { headers: { 'x-api-key': apiKey } });

        if (!imgRes.ok) {
          failed++;
          results.push({ id: item.id, name: item.name, status: 'error', error: `Download failed: ${imgRes.status}` });
          if (win && onProgressChannel) win.webContents.send(onProgressChannel, { ...progress, failed, result: results[results.length - 1] });
          continue;
        }

        const buffer = Buffer.from(await imgRes.arrayBuffer());
        const tmpPath = path.join(tmpDir, `ocr-cat-${Date.now()}-${Math.random().toString(36).slice(2)}.img`);
        await fs.promises.writeFile(tmpPath, buffer);

        try {
          const text = await performOcr(tmpPath);
          const confidence = text && text.length > 2 ? 50 : 10; // Simple confidence estimate

          if (!text || text.length < 2 || confidence < minConfidence) {
            skipped++;
            results.push({ id: item.id, name: item.name, status: 'skipped', reason: 'low confidence or no text', ocrText: text });
          } else {
            processed++;
            results.push({ id: item.id, name: item.name, status: 'success', ocrText: text, relativePath: item.relativePath });
          }
        } finally {
          try { await fs.promises.unlink(tmpPath); } catch (_) {}
        }

        if (win && onProgressChannel) {
          win.webContents.send(onProgressChannel, {
            current: i + 1, total, processed, skipped, failed,
            item: item.name,
            result: results[results.length - 1]
          });
        }
      } catch (err) {
        failed++;
        results.push({ id: item.id, name: item.name, status: 'error', error: err.message });
        if (win && onProgressChannel) win.webContents.send(onProgressChannel, { ...progress, failed, result: results[results.length - 1] });
      }
    }

    // Send results to server
    try {
      await doFetch(`${serverUrl}/api/admin/catalog/ocr-results`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({ categorySlug, results })
      });
    } catch (err) {
      console.error('[OCR] Failed to save results to server:', err.message);
    }

    return { processed, skipped, failed, total, results };
  });

  // Campaigns admin
  ipcMain.handle('campaigns:list', () => httpRequest('/api/admin/campaigns', { method: 'GET' }));
  ipcMain.handle('campaigns:get', (_event, slug) =>
    httpRequest(`/api/admin/campaigns/${encodeURIComponent(slug)}`, { method: 'GET' })
  );
  ipcMain.handle('campaigns:create', (_event, payload) =>
    httpRequest('/api/admin/campaigns', { method: 'POST', body: payload || {} })
  );
  ipcMain.handle('campaigns:update', (_event, { slug, payload }) =>
    httpRequest(`/api/admin/campaigns/${encodeURIComponent(slug)}`, {
      method: 'POST',
      body: payload || {}
    })
  );
  ipcMain.handle('campaigns:delete', (_event, slug) =>
    httpRequest(`/api/admin/campaigns/${encodeURIComponent(slug)}`, { method: 'DELETE' })
  );

  // ============================================================================
  // CUSTOM ART IPC HANDLERS
  // ============================================================================

  // Custom Art - Rooms
  ipcMain.handle('custom-art:rooms:list', (_event, query) =>
    httpRequest('/api/custom-art/rooms', { method: 'GET', query: query || {} })
  );
  ipcMain.handle('custom-art:rooms:get', (_event, id) =>
    httpRequest(`/api/custom-art/rooms/${encodeURIComponent(id)}`, { method: 'GET' })
  );
  ipcMain.handle('custom-art:rooms:create', (_event, payload) =>
    httpRequest('/api/custom-art/rooms', { method: 'POST', body: payload || {} })
  );
  ipcMain.handle('custom-art:rooms:update', (_event, { id, payload }) =>
    httpRequest(`/api/custom-art/rooms/${encodeURIComponent(id)}`, { method: 'PATCH', body: payload || {} })
  );
  ipcMain.handle('custom-art:rooms:delete', (_event, id) =>
    httpRequest(`/api/custom-art/rooms/${encodeURIComponent(id)}`, { method: 'DELETE' })
  );
  ipcMain.handle('custom-art:rooms:ai-metadata', async (_event, imagePath) => {
    // Read the file and convert to base64
    if (!fs.existsSync(imagePath)) {
      return { success: false, error: 'Image file not found locally' };
    }
    const imageBuffer = await fsPromises.readFile(imagePath);
    const base64Image = imageBuffer.toString('base64');
    const ext = path.extname(imagePath).toLowerCase();
    const mediaType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';

    // Send to server for AI analysis
    return httpRequest('/api/custom-art/rooms/ai-metadata', {
      method: 'POST',
      body: { imageBase64: base64Image, mediaType }
    });
  });

  // Custom Art - Artwork
  ipcMain.handle('custom-art:artwork:list', (_event, query) =>
    httpRequest('/api/custom-art/artwork', { method: 'GET', query: query || {} })
  );
  ipcMain.handle('custom-art:artwork:categories', () =>
    httpRequest('/api/custom-art/artwork/categories', { method: 'GET' })
  );
  ipcMain.handle('custom-art:artwork:get', (_event, id) =>
    httpRequest(`/api/custom-art/artwork/${encodeURIComponent(id)}`, { method: 'GET' })
  );
  ipcMain.handle('custom-art:artwork:create', (_event, payload) =>
    httpRequest('/api/custom-art/artwork', { method: 'POST', body: payload || {} })
  );
  ipcMain.handle('custom-art:artwork:update', (_event, { id, payload }) =>
    httpRequest(`/api/custom-art/artwork/${encodeURIComponent(id)}`, { method: 'PATCH', body: payload || {} })
  );
  ipcMain.handle('custom-art:artwork:delete', (_event, id) =>
    httpRequest(`/api/custom-art/artwork/${encodeURIComponent(id)}`, { method: 'DELETE' })
  );
  ipcMain.handle('custom-art:artwork:ai-metadata', async (_event, id) => {
    // First get the artwork to find the file path
    const artworkResult = await httpRequest(`/api/custom-art/artwork/${encodeURIComponent(id)}`, { method: 'GET' });
    if (!artworkResult?.artwork?.filePath) {
      return { success: false, error: 'Artwork or file path not found' };
    }
    const filePath = artworkResult.artwork.filePath;

    let imageBuffer;
    let ext = path.extname(filePath).toLowerCase();

    // Check if filePath is a local file (Windows path) or server-relative path
    const isLocalPath = /^[A-Za-z]:[\\/]/.test(filePath);

    if (isLocalPath && fs.existsSync(filePath)) {
      // Read from local filesystem
      imageBuffer = await fsPromises.readFile(filePath);
    } else {
      // Fetch from server
      const settings = ensureServerConfigured();
      const imageUrl = filePath.startsWith('http') ? filePath : `${settings.serverBaseUrl}/${filePath.replace(/^\//, '')}`;
      console.log('[AI Metadata] Fetching image from:', imageUrl);

      const { fetch: doFetch } = await ensureFetch();
      const response = await doFetch(imageUrl);
      if (!response.ok) {
        return { success: false, error: `Failed to fetch image from server: ${response.status}` };
      }
      const arrayBuffer = await response.arrayBuffer();
      imageBuffer = Buffer.from(arrayBuffer);
    }

    const base64Image = imageBuffer.toString('base64');
    const mediaType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';

    // Send to server with image data
    return httpRequest(`/api/custom-art/artwork/${encodeURIComponent(id)}/ai-metadata`, {
      method: 'POST',
      body: { imageBase64: base64Image, mediaType }
    });
  });

  // Custom Art - Materials
  ipcMain.handle('custom-art:materials:list', (_event, query) =>
    httpRequest('/api/custom-art/materials', { method: 'GET', query: query || {} })
  );
  ipcMain.handle('custom-art:materials:get', (_event, id) =>
    httpRequest(`/api/custom-art/materials/${encodeURIComponent(id)}`, { method: 'GET' })
  );
  ipcMain.handle('custom-art:materials:create', (_event, payload) =>
    httpRequest('/api/custom-art/materials', { method: 'POST', body: payload || {} })
  );
  ipcMain.handle('custom-art:materials:update', (_event, { id, payload }) =>
    httpRequest(`/api/custom-art/materials/${encodeURIComponent(id)}`, { method: 'PATCH', body: payload || {} })
  );
  ipcMain.handle('custom-art:materials:delete', (_event, id) =>
    httpRequest(`/api/custom-art/materials/${encodeURIComponent(id)}`, { method: 'DELETE' })
  );

  // Custom Art - Products
  ipcMain.handle('custom-art:products:list', (_event, query) =>
    httpRequest('/api/custom-art/products', { method: 'GET', query: query || {} })
  );
  ipcMain.handle('custom-art:products:get', (_event, id) =>
    httpRequest(`/api/custom-art/products/${encodeURIComponent(id)}`, { method: 'GET' })
  );
  ipcMain.handle('custom-art:products:create', (_event, payload) =>
    httpRequest('/api/custom-art/products', { method: 'POST', body: payload || {} })
  );
  ipcMain.handle('custom-art:products:update', (_event, { id, payload }) =>
    httpRequest(`/api/custom-art/products/${encodeURIComponent(id)}`, { method: 'PATCH', body: payload || {} })
  );
  ipcMain.handle('custom-art:products:delete', (_event, id) =>
    httpRequest(`/api/custom-art/products/${encodeURIComponent(id)}`, { method: 'DELETE' })
  );

  // Custom Art - Product Variants
  ipcMain.handle('custom-art:variants:list', (_event, productId) =>
    httpRequest(`/api/custom-art/products/${encodeURIComponent(productId)}/variants`, { method: 'GET' })
  );
  ipcMain.handle('custom-art:variants:create', (_event, { productId, payload }) =>
    httpRequest(`/api/custom-art/products/${encodeURIComponent(productId)}/variants`, { method: 'POST', body: payload || {} })
  );
  ipcMain.handle('custom-art:variants:update', (_event, { id, payload }) =>
    httpRequest(`/api/custom-art/variants/${encodeURIComponent(id)}`, { method: 'PATCH', body: payload || {} })
  );
  ipcMain.handle('custom-art:variants:delete', (_event, id) =>
    httpRequest(`/api/custom-art/variants/${encodeURIComponent(id)}`, { method: 'DELETE' })
  );

  // Custom Art - Mockups CRUD
  ipcMain.handle('custom-art:mockups:list', (_event, query) =>
    httpRequest('/api/custom-art/mockups', { method: 'GET', query: query || {} })
  );
  ipcMain.handle('custom-art:mockups:get', (_event, id) =>
    httpRequest(`/api/custom-art/mockups/${encodeURIComponent(id)}`, { method: 'GET' })
  );
  ipcMain.handle('custom-art:mockups:create', (_event, payload) =>
    httpRequest('/api/custom-art/mockups', { method: 'POST', body: payload || {} })
  );
  ipcMain.handle('custom-art:mockups:update', (_event, { id, payload }) =>
    httpRequest(`/api/custom-art/mockups/${encodeURIComponent(id)}`, { method: 'PUT', body: payload || {} })
  );
  ipcMain.handle('custom-art:mockups:delete', (_event, { id, hard }) =>
    httpRequest(`/api/custom-art/mockups/${encodeURIComponent(id)}${hard ? '?hard=true' : ''}`, { method: 'DELETE' })
  );

  // Custom Art - File Upload (uploads to server)
  ipcMain.handle('custom-art:upload', async (_event, { filePath, type }) => {
    // type = 'room' | 'artwork'
    try {
      const ext = path.extname(filePath).toLowerCase();
      const allowedExts = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
      if (!allowedExts.includes(ext)) {
        throw new Error(`Invalid file type: ${ext}. Allowed: ${allowedExts.join(', ')}`);
      }

      const filename = path.basename(filePath);

      console.log('[Custom Art Upload] Source:', filePath, 'Type:', type);

      // Check if source file exists
      if (!fs.existsSync(filePath)) {
        console.error('[Custom Art Upload] Source file not found:', filePath);
        return { success: false, error: 'Source file not found' };
      }

      // Read file as base64
      const fileBuffer = await fs.promises.readFile(filePath);
      const base64Data = fileBuffer.toString('base64');

      // Upload to server
      const settings = ensureServerConfigured();
      const url = new URL('/api/custom-art/upload', settings.serverBaseUrl);

      const { fetch: doFetch } = await ensureFetch();
      const response = await doFetch(url.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': settings.apiKey || ''
        },
        body: JSON.stringify({
          imageData: base64Data,
          filename: filename,
          type: type || 'artwork'
        })
      });

      const result = await response.json();

      if (!response.ok) {
        console.error('[Custom Art Upload] Server error:', result);
        return { success: false, error: result.error || 'Upload failed' };
      }

      console.log('[Custom Art Upload] Success:', result.filePath);

      // Return server-relative path
      return {
        success: true,
        filePath: result.filePath,
        thumbnailPath: result.filePath, // Server doesn't generate thumbnails yet, use same path
        filename: path.basename(result.filePath)
      };
    } catch (e) {
      console.error('[Custom Art Upload] Error:', e);
      return { success: false, error: e?.message || 'Upload failed' };
    }
  });

  // Custom Art - Select file dialog
  ipcMain.handle('custom-art:select-file', async (_event, options) => {
    const result = await dialog.showOpenDialog({
      title: options?.title || 'Select Image',
      properties: ['openFile'],
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }
      ]
    });
    if (result.canceled || !result.filePaths.length) {
      return { canceled: true };
    }
    return { canceled: false, filePath: result.filePaths[0] };
  });

  // Custom Art - Select multiple files (images or ZIP)
  ipcMain.handle('custom-art:select-files', async (_event, options) => {
    const result = await dialog.showOpenDialog({
      title: options?.title || 'Select Images or ZIP',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Images & Archives', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'zip'] },
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
        { name: 'ZIP Archives', extensions: ['zip'] }
      ]
    });
    if (result.canceled || !result.filePaths.length) {
      return { canceled: true, filePaths: [] };
    }
    return { canceled: false, filePaths: result.filePaths };
  });

  // Custom Art - Extract ZIP file and return image paths
  ipcMain.handle('custom-art:extract-zip', async (_event, zipPath) => {
    const AdmZip = require('adm-zip');
    const path = require('path');
    const os = require('os');
    const fs = require('fs');

    try {
      const zip = new AdmZip(zipPath);
      const zipEntries = zip.getEntries();

      // Create temp directory for extraction
      const tempDir = path.join(os.tmpdir(), `artwork-zip-${Date.now()}`);
      fs.mkdirSync(tempDir, { recursive: true });

      const imageExtensions = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
      const extractedPaths = [];

      for (const entry of zipEntries) {
        if (entry.isDirectory) continue;

        const ext = path.extname(entry.entryName).toLowerCase();
        if (!imageExtensions.includes(ext)) continue;

        // Skip __MACOSX and hidden files
        if (entry.entryName.includes('__MACOSX') || entry.entryName.startsWith('.') || entry.entryName.includes('/.')) {
          continue;
        }

        // Extract to temp directory with flat structure (avoid nested folders)
        const filename = path.basename(entry.entryName);
        const destPath = path.join(tempDir, filename);

        // Handle duplicate filenames
        let finalPath = destPath;
        let counter = 1;
        while (fs.existsSync(finalPath)) {
          const name = path.basename(filename, ext);
          finalPath = path.join(tempDir, `${name}_${counter}${ext}`);
          counter++;
        }

        fs.writeFileSync(finalPath, entry.getData());
        extractedPaths.push(finalPath);
      }

      return { success: true, filePaths: extractedPaths, tempDir };
    } catch (error) {
      console.error('ZIP extraction error:', error);
      return { success: false, error: error.message };
    }
  });

  // Custom Art - Save Mockup
  ipcMain.handle('custom-art:mockup:save', (_event, payload) =>
    httpRequest('/api/custom-art/mockup/save', { method: 'POST', body: payload || {} })
  );

  // Custom Art - Save Tiled Artwork (for wall patterns)
  ipcMain.handle('custom-art:tiled-artwork:save', (_event, payload) =>
    httpRequest('/api/custom-art/tiled-artwork/save', { method: 'POST', body: payload || {} })
  );

  // Custom Art - Generate Tiles (split artwork into panels for multi-panel products)
  ipcMain.handle('custom-art:tiles:generate', async (_event, payload) => {
    // payload: { artworkId, cols, rows, tileWidth, tileHeight, gap }
    // Fetch the image from server and send base64 for tile processing
    const { artworkId, cols, rows, tileWidth, tileHeight, gap } = payload || {};

    // First get the artwork info to find the file path
    const artworkResult = await httpRequest(`/api/custom-art/artwork/${encodeURIComponent(artworkId)}`, { method: 'GET' });
    if (!artworkResult?.artwork?.filePath) {
      return { success: false, error: 'Artwork or file path not found' };
    }

    const filePath = artworkResult.artwork.filePath;
    let imageBuffer;
    let ext = path.extname(filePath).toLowerCase();

    // Check if filePath is a local file (Windows path) or server-relative path
    const isLocalPath = /^[A-Za-z]:[\\/]/.test(filePath);

    if (isLocalPath && fs.existsSync(filePath)) {
      // Read from local filesystem
      imageBuffer = await fsPromises.readFile(filePath);
    } else {
      // Fetch from server
      const settings = ensureServerConfigured();
      const imageUrl = filePath.startsWith('http') ? filePath : `${settings.serverBaseUrl}/${filePath.replace(/^\//, '')}`;
      console.log('[Tiles Generate] Fetching image from:', imageUrl);

      const { fetch: doFetch } = await ensureFetch();
      const response = await doFetch(imageUrl);
      if (!response.ok) {
        return { success: false, error: `Failed to fetch image from server: ${response.status}` };
      }
      const arrayBuffer = await response.arrayBuffer();
      imageBuffer = Buffer.from(arrayBuffer);
    }

    const base64Image = imageBuffer.toString('base64');
    const mediaType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';

    // Send to server for tile generation
    return httpRequest('/api/custom-art/tiles/generate', {
      method: 'POST',
      body: {
        artworkId,
        cols,
        rows,
        tileWidth,
        tileHeight,
        gap,
        imageBase64: base64Image,
        mediaType
      }
    });
  });

  // Custom Art - Split Artwork (for mockup modal tiling)
  ipcMain.handle('custom-art:split-artwork', async (_event, payload) => {
    // payload: { imageSrc, cols, rows, name }
    // imageSrc can be a data URL or server URL
    const { imageSrc, cols, rows, name } = payload || {};

    if (!imageSrc) {
      return { success: false, error: 'No image source provided' };
    }

    let imageBase64, mediaType;

    if (imageSrc.startsWith('data:')) {
      // Already a data URL
      const [header, base64Data] = imageSrc.split(',');
      imageBase64 = base64Data;
      mediaType = header.split(':')[1]?.split(';')[0] || 'image/jpeg';
    } else {
      // Fetch from URL
      try {
        const { fetch: doFetch } = await ensureFetch();
        const response = await doFetch(imageSrc);
        if (!response.ok) {
          return { success: false, error: `Failed to fetch image: ${response.status}` };
        }
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        imageBase64 = buffer.toString('base64');
        // Determine media type from URL extension or default to jpeg
        const ext = imageSrc.split('.').pop()?.toLowerCase();
        mediaType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
      } catch (e) {
        console.error('[Split Artwork] Failed to fetch image:', e);
        return { success: false, error: e.message };
      }
    }

    // Send to server for splitting
    return httpRequest('/api/custom-art/split-artwork', {
      method: 'POST',
      body: {
        imageBase64,
        mediaType,
        cols,
        rows,
        name: name || 'Artwork'
      }
    });
  });

  // Custom Art - Shopify Export
  ipcMain.handle('custom-art:shopify:export', (_event, payload) =>
    httpRequest('/api/custom-art/shopify/export', { method: 'POST', body: payload || {} })
  );

  // Metal Print Filter and Campaign Export
  ipcMain.handle('metal-print:apply-filter', (_event, payload) =>
    httpRequest('/api/metal-print/apply-filter', { method: 'POST', body: payload || {} })
  );

  ipcMain.handle('metal-print:export-campaign', (_event, payload) =>
    httpRequest('/api/metal-print/export-campaign', { method: 'POST', body: payload || {} })
  );

  ipcMain.handle('metal-print:export-status', (_event, slug) =>
    httpRequest(`/api/metal-print/export-status/${encodeURIComponent(slug || '')}`, { method: 'GET' })
  );

  // Sticker Sheets handlers
  ipcMain.handle('sticker-sheets:categories', () =>
    httpRequest('/api/sticker-sheets/categories', { method: 'GET' })
  );

  ipcMain.handle('sticker-sheets:catalog', (_event, { category }) =>
    httpRequest(`/api/sticker-sheets/catalog${category ? '?category=' + encodeURIComponent(category) : ''}`, { method: 'GET' })
  );

  ipcMain.handle('sticker-sheets:grid-info', (_event, { stickerSizeInches }) =>
    httpRequest(`/api/sticker-sheets/grid-info?size=${stickerSizeInches || 3}`, { method: 'GET' })
  );

  ipcMain.handle('sticker-sheets:generate', (_event, payload) =>
    httpRequest('/api/sticker-sheets/generate', { method: 'POST', body: payload || {} })
  );

  // Generate sheets from manual visual layout
  ipcMain.handle('sticker-sheets:generate-from-layout', (_event, layoutData) =>
    httpRequest('/api/sticker-sheets/generate-from-layout', { method: 'POST', body: layoutData || {} })
  );

  ipcMain.handle('sticker-sheets:from-order', (_event, payload) =>
    httpRequest('/api/sticker-sheets/from-order', { method: 'POST', body: payload || {} })
  );

  ipcMain.handle('sticker-sheets:list', () =>
    httpRequest('/api/sticker-sheets/list', { method: 'GET' })
  );

  // New handlers for order-based sticker sheet storage
  ipcMain.handle('sticker-sheets:list-saved-orders', () =>
    httpRequest('/api/sticker-sheets/saved-orders', { method: 'GET' })
  );

  ipcMain.handle('sticker-sheets:get-order-sheets', (_event, { orderNumber }) =>
    httpRequest(`/api/sticker-sheets/order/${encodeURIComponent(orderNumber)}`, { method: 'GET' })
  );

  ipcMain.handle('sticker-sheets:send-to-cameo', (_event, payload) =>
    httpRequest('/api/sticker-sheets/send-to-cameo', { method: 'POST', body: payload || {} })
  );

  // Delete a sticker sheet batch
  ipcMain.handle('sticker-sheets:delete-batch', (_event, { batchName }) =>
    httpRequest(`/api/sticker-sheets/batch/${encodeURIComponent(batchName)}`, { method: 'DELETE' })
  );

  // Get contour for a sticker (lazy generation with caching)
  ipcMain.handle('sticker-sheets:get-contour', async (_event, { imagePath }) => {
    if (!imagePath) {
      return { success: false, error: 'Image path is required' };
    }
    // Encode path as base64 for URL safety
    const encodedPath = Buffer.from(imagePath).toString('base64');
    return httpRequest(`/api/stickers/contour/${encodedPath}`, { method: 'GET' });
  });

  // ============================================================================
  // Vinyl Cutter handlers
  // ============================================================================

  // Vectorize an image for vinyl cutting (with color detection)
  ipcMain.handle('vinyl-cutter:vectorize', async (_event, { imagePath }) => {
    if (!imagePath) {
      return { success: false, error: 'Image path is required' };
    }
    return httpRequest('/api/vinyl-cutter/vectorize', {
      method: 'POST',
      body: { imagePath }
    });
  });

  // Generate cut files with color separation
  ipcMain.handle('vinyl-cutter:generate', (_event, data) =>
    httpRequest('/api/vinyl-cutter/generate', { method: 'POST', body: data || {} })
  );

  // List generated vinyl cut batches
  ipcMain.handle('vinyl-cutter:list', () =>
    httpRequest('/api/vinyl-cutter/list', { method: 'GET' })
  );

  // Delete a vinyl cut batch
  ipcMain.handle('vinyl-cutter:delete', (_event, { batchName }) =>
    httpRequest(`/api/vinyl-cutter/batch/${encodeURIComponent(batchName)}`, { method: 'DELETE' })
  );

  // Send vinyl cut file to Silhouette - uses local Python script (same as cameo:open-cut-file)
  ipcMain.handle('vinyl-cutter:send-to-silhouette', async (_event, payload) => {
    const { batchName, fileName, cutSettings = {} } = payload || {};

    if (!batchName || !fileName) {
      return { success: false, error: 'batchName and fileName are required' };
    }

    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const https = require('https');
    const http = require('http');
    const { exec } = require('child_process');

    // Get server base URL from config
    const settings = ensureServerConfigured();
    const serverBaseUrl = settings.serverBaseUrl;

    // Build the URL to download the cut file
    const fileUrl = `${serverBaseUrl}/library/vinyl-cuts/${batchName}/${fileName}`;
    console.log('[Vinyl Cameo] Downloading cut file:', fileUrl);

    try {
      // Download the SVG to a temp file
      const tempPath = path.join(os.tmpdir(), `vinyl_cut_${Date.now()}.svg`);

      await new Promise((resolve, reject) => {
        const protocol = fileUrl.startsWith('https') ? https : http;
        const file = fs.createWriteStream(tempPath);

        protocol.get(fileUrl, {
          headers: { 'Accept': 'image/svg+xml,*/*' },
          rejectUnauthorized: false
        }, (response) => {
          if (response.statusCode === 301 || response.statusCode === 302) {
            // Handle redirect
            protocol.get(response.headers.location, {
              rejectUnauthorized: false
            }, (redirectRes) => {
              redirectRes.pipe(file);
              file.on('finish', () => { file.close(); resolve(); });
            }).on('error', reject);
            return;
          }
          response.pipe(file);
          file.on('finish', () => { file.close(); resolve(); });
        }).on('error', reject);
      });

      console.log('[Vinyl Cameo] Downloaded, file size:', fs.statSync(tempPath).size, 'bytes');

      // Path to the sendto_silhouette.py script
      const scriptPath = 'F:\\Vinyl Stuff\\StickerSheets\\sendto_silhouette.py';

      // Check if script exists
      if (!fs.existsSync(scriptPath)) {
        return { success: false, error: `Silhouette script not found at: ${scriptPath}` };
      }

      // Build command with settings for vinyl cutting
      // For vinyl cutting, we DON'T use registration marks - just cut from origin
      // This is different from sticker print-and-cut which needs regmarks
      const speed = cutSettings.speed || 4;
      const pressure = cutSettings.pressure || 15;
      const depth = cutSettings.depth || 6;
      const xOffset = cutSettings.xOffset || 0;
      const yOffset = cutSettings.yOffset || 0;

      // Vinyl cutting: NO registration marks, just cut directly
      const args = [
        `"${tempPath}"`,
        '--regmark=false',     // No registration marks for vinyl
        '--regsearch=false',   // Don't search for marks
        `--speed=${speed}`,
        `--pressure=${pressure}`,
        `--depth=${depth}`,
        '--tool=autoblade',
        `--x_off=${xOffset}`,
        `--y_off=${yOffset}`
      ];

      const command = `python "${scriptPath}" ${args.join(' ')}`;
      console.log('[Vinyl Cameo] Executing:', command);

      // Execute the Python script
      return new Promise((resolve) => {
        exec(command, {
          cwd: path.dirname(scriptPath),
          timeout: 300000,  // 5 minute timeout for cutting
        }, (error, stdout, stderr) => {
          // Clean up temp file
          try { fs.unlinkSync(tempPath); } catch (e) { /* ignore */ }

          if (error) {
            console.error('[Vinyl Cameo] Error:', error.message);
            console.error('[Vinyl Cameo] stderr:', stderr);
            resolve({ success: false, error: stderr || error.message });
            return;
          }

          console.log('[Vinyl Cameo] Success:', stdout);
          resolve({ success: true, message: 'Sent to Silhouette', output: stdout });
        });
      });

    } catch (err) {
      console.error('[Vinyl Cameo] Failed:', err);
      return { success: false, error: err.message };
    }
  });

  // ========================================
  // Studio3 Parser Handlers
  // ========================================
  const Studio3Parser = require('./studio3-parser');

  // Parse a .studio3 file and extract all data
  ipcMain.handle('studio3:parse', async (_event, filepath) => {
    try {
      console.log('[Studio3] Parsing file:', filepath);
      const parser = new Studio3Parser(filepath);
      const data = await parser.parse();

      // Convert image buffers to base64 for IPC transfer
      const images = data.images.map(img => ({
        index: img.index,
        size: img.size,
        base64: img.buffer.toString('base64'),
        mimeType: 'image/png'
      }));

      return {
        success: true,
        images,
        paths: data.paths,
        metadata: data.metadata,
        svg: data.svg
      };
    } catch (err) {
      console.error('[Studio3] Parse error:', err);
      return { success: false, error: err.message };
    }
  });

  // Extract just the images from a .studio3 file
  ipcMain.handle('studio3:extractImages', async (_event, filepath) => {
    try {
      const parser = new Studio3Parser(filepath);
      await parser.load();
      const images = parser.extractImages();

      return {
        success: true,
        images: images.map(img => ({
          index: img.index,
          size: img.size,
          base64: img.buffer.toString('base64'),
          mimeType: 'image/png'
        }))
      };
    } catch (err) {
      console.error('[Studio3] Extract images error:', err);
      return { success: false, error: err.message };
    }
  });

  // Extract just the cut paths from a .studio3 file
  ipcMain.handle('studio3:extractPaths', async (_event, filepath) => {
    try {
      const parser = new Studio3Parser(filepath);
      await parser.load();
      const paths = parser.extractCutPaths();

      return {
        success: true,
        paths,
        pathCount: paths.length,
        totalPoints: paths.reduce((sum, p) => sum + p.length, 0)
      };
    } catch (err) {
      console.error('[Studio3] Extract paths error:', err);
      return { success: false, error: err.message };
    }
  });

  // Convert cut paths to SVG
  ipcMain.handle('studio3:toSvg', async (_event, filepath, options = {}) => {
    try {
      const parser = new Studio3Parser(filepath);
      await parser.load();
      const svg = parser.toSvg(options);

      return { success: true, svg };
    } catch (err) {
      console.error('[Studio3] SVG conversion error:', err);
      return { success: false, error: err.message };
    }
  });

  // Save extracted images to a directory
  ipcMain.handle('studio3:saveImages', async (_event, filepath, outputDir) => {
    try {
      const parser = new Studio3Parser(filepath);
      await parser.load();
      const saved = await parser.saveImages(outputDir);

      return { success: true, files: saved };
    } catch (err) {
      console.error('[Studio3] Save images error:', err);
      return { success: false, error: err.message };
    }
  });

  // Browse for .studio3 files
  ipcMain.handle('studio3:browse', async () => {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog({
      title: 'Select Studio3 Files',
      filters: [
        { name: 'Silhouette Studio Files', extensions: ['studio3'] },
        { name: 'All Files', extensions: ['*'] }
      ],
      properties: ['openFile', 'multiSelections']
    });

    if (result.canceled) {
      return { success: false, canceled: true };
    }

    return { success: true, files: result.filePaths };
  });

  // Batch parse multiple .studio3 files (for catalog building)
  ipcMain.handle('studio3:batchParse', async (_event, filepaths) => {
    const results = [];

    for (const filepath of filepaths) {
      try {
        const parser = new Studio3Parser(filepath);
        const data = await parser.parse();

        results.push({
          filepath,
          success: true,
          imageCount: data.images.length,
          pathCount: data.paths.length,
          metadata: data.metadata,
          // Include thumbnail (first image) as base64
          thumbnail: data.images.length > 0
            ? data.images[0].buffer.toString('base64')
            : null
        });
      } catch (err) {
        results.push({
          filepath,
          success: false,
          error: err.message
        });
      }
    }

    return {
      success: true,
      total: filepaths.length,
      parsed: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results
    };
  });

  // Google Drive Sync handlers
  ipcMain.handle('gdrive:list', (_event, folder) =>
    httpRequest(`/api/gdrive/list${folder ? '?folder=' + encodeURIComponent(folder) : ''}`, { method: 'GET' })
  );

  ipcMain.handle('gdrive:sync-custom-art', (_event, fileIds) =>
    httpRequest('/api/gdrive/sync-custom-art', { method: 'POST', body: { fileIds } })
  );

  ipcMain.handle('gdrive:sync-catalog', (_event, items) =>
    httpRequest('/api/gdrive/sync-catalog', { method: 'POST', body: { items } })
  );

  ipcMain.handle('gdrive:sync-mockups', (_event, filenames) =>
    httpRequest('/api/gdrive/sync-mockups', { method: 'POST', body: { filenames } })
  );

  ipcMain.handle('gdrive:sync-rooms', (_event, filenames) =>
    httpRequest('/api/gdrive/sync-rooms', { method: 'POST', body: { filenames } })
  );

  ipcMain.handle('gdrive:sync', (_event, files) =>
    httpRequest('/api/gdrive/sync', { method: 'POST', body: { files } })
  );

  // Google Drive Pull (reverse sync) handlers
  ipcMain.handle('gdrive:pull-collection', (_event, categories) =>
    httpRequest('/api/gdrive/pull-collection', { method: 'POST', body: { categories: categories || [] } })
  );

  ipcMain.handle('gdrive:pull-custom-art', () =>
    httpRequest('/api/gdrive/pull-custom-art', { method: 'POST', body: {} })
  );

  ipcMain.handle('gdrive:pull-mockups', () =>
    httpRequest('/api/gdrive/pull-mockups', { method: 'POST', body: {} })
  );

  ipcMain.handle('gdrive:pull-rooms', () =>
    httpRequest('/api/gdrive/pull-rooms', { method: 'POST', body: {} })
  );

  // Silhouette Cameo local handlers - uses sendto_silhouette.py script
  ipcMain.handle('cameo:open-cut-file', async (_event, options = {}) => {
    const { url, cutSettings = {} } = options;
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const https = require('https');
    const http = require('http');
    const { exec } = require('child_process');

    try {
      console.log('[Cameo] Sending cut file to Silhouette:', url);

      if (!url) {
        return { success: false, error: 'No URL provided' };
      }

      // Download the SVG file to temp directory
      const tempDir = path.join(os.tmpdir(), 'silhouette-cuts');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const fileName = `cut_${Date.now()}.svg`;
      const tempPath = path.join(tempDir, fileName);

      console.log('[Cameo] Downloading to:', tempPath);

      // Download the file
      await new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        const file = fs.createWriteStream(tempPath);

        client.get(url, (response) => {
          if (response.statusCode === 301 || response.statusCode === 302) {
            // Follow redirect
            client.get(response.headers.location, (res2) => {
              res2.pipe(file);
              file.on('finish', () => { file.close(); resolve(); });
            }).on('error', reject);
          } else if (response.statusCode !== 200) {
            reject(new Error(`HTTP ${response.statusCode}`));
          } else {
            response.pipe(file);
            file.on('finish', () => { file.close(); resolve(); });
          }
        }).on('error', reject);
      });

      console.log('[Cameo] Downloaded, file size:', fs.statSync(tempPath).size, 'bytes');

      // Path to the sendto_silhouette.py script
      const scriptPath = 'F:\\Vinyl Stuff\\StickerSheets\\sendto_silhouette.py';

      // Check if script exists
      if (!fs.existsSync(scriptPath)) {
        return { success: false, error: `Silhouette script not found at: ${scriptPath}` };
      }

      // Build command with settings
      // Default registration mark settings for sticker sheets (Letter size: 8.5" x 11" = 215.9mm x 279.4mm)
      // Registration marks are 10mm from edge, so mark-to-mark distance is:
      // X: 215.9 - 20 = 195.9mm
      // Y: 279.4 - 20 = 259.4mm
      const speed = cutSettings.speed || 4;
      const pressure = cutSettings.pressure || 15;
      const depth = cutSettings.depth || 6;
      const xOffset = cutSettings.offset || 8.5;

      // Build the command arguments exactly as the user specified:
      // python sendto_silhouette.py my_sheet_cut.svg --regmark=true --regsearch=true
      // --rego-x=10 --rego-y=10 --reg-x=195.9 --reg-y=259.4 --speed=4 --pressure=15
      // --depth=6 --tool=autoblade --x_off=8.5
      const args = [
        `"${tempPath}"`,
        '--regmark=true',
        '--regsearch=true',
        '--rego-x=10',
        '--rego-y=10',
        '--reg-x=195.9',
        '--reg-y=259.4',
        `--speed=${speed}`,
        `--pressure=${pressure}`,
        `--depth=${depth}`,
        '--tool=autoblade',
        `--x_off=${xOffset}`
      ];

      const command = `python "${scriptPath}" ${args.join(' ')}`;
      console.log('[Cameo] Executing:', command);

      // Execute the Python script
      return new Promise((resolve) => {
        exec(command, {
          cwd: path.dirname(scriptPath),
          timeout: 300000,  // 5 minute timeout for cutting
          env: { ...process.env }
        }, (error, stdout, stderr) => {
          if (error) {
            console.error('[Cameo] Script error:', error.message);
            console.error('[Cameo] stderr:', stderr);
            resolve({
              success: false,
              error: `Script error: ${error.message}`,
              stderr: stderr,
              stdout: stdout
            });
          } else {
            console.log('[Cameo] Script output:', stdout);
            if (stderr) console.log('[Cameo] Script stderr:', stderr);
            resolve({
              success: true,
              message: 'Cut job sent to Silhouette Cameo',
              filePath: tempPath,
              stdout: stdout,
              stderr: stderr
            });
          }
        });
      });
    } catch (err) {
      console.error('[Cameo] Error:', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('cameo:get-script-path', async () => {
    const fs = require('fs');
    const scriptPath = 'F:\\Vinyl Stuff\\StickerSheets\\sendto_silhouette.py';

    if (fs.existsSync(scriptPath)) {
      return { success: true, path: scriptPath };
    }
    return { success: false, error: 'Silhouette script not found' };
  });

  // Campaign mockup handler
  ipcMain.handle('campaign:save-mockup', (_event, payload) =>
    httpRequest('/api/campaigns/save-mockup', { method: 'POST', body: payload || {} })
  );

  // Human Models handlers
  ipcMain.handle('human-models:list', (_event, query) =>
    httpRequest(`/api/human-models?activeOnly=${query?.activeOnly !== false}&limit=${query?.limit || 1000}&offset=${query?.offset || 0}${query?.category ? '&category=' + encodeURIComponent(query.category) : ''}${query?.gender ? '&gender=' + encodeURIComponent(query.gender) : ''}${query?.search ? '&search=' + encodeURIComponent(query.search) : ''}`, { method: 'GET' })
  );
  ipcMain.handle('human-models:categories', () =>
    httpRequest('/api/human-models/categories', { method: 'GET' })
  );
  ipcMain.handle('human-models:get', (_event, id) =>
    httpRequest(`/api/human-models/${encodeURIComponent(id)}`, { method: 'GET' })
  );
  ipcMain.handle('human-models:create', (_event, payload) =>
    httpRequest('/api/human-models', { method: 'POST', body: payload || {} })
  );
  ipcMain.handle('human-models:update', (_event, { id, payload }) =>
    httpRequest(`/api/human-models/${encodeURIComponent(id)}`, { method: 'PUT', body: payload || {} })
  );
  ipcMain.handle('human-models:delete', (_event, id) =>
    httpRequest(`/api/human-models/${encodeURIComponent(id)}`, { method: 'DELETE' })
  );
  ipcMain.handle('human-models:select-file', async (_event, options) => {
    const result = await dialog.showOpenDialog({
      title: options?.title || 'Select Model Image',
      properties: ['openFile'],
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }
      ]
    });
    if (result.canceled || !result.filePaths.length) {
      return { canceled: true };
    }
    return { canceled: false, filePath: result.filePaths[0] };
  });
  ipcMain.handle('human-models:select-files', async (_event, options) => {
    const result = await dialog.showOpenDialog({
      title: options?.title || 'Select Model Images or ZIP',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Images & Archives', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'zip'] },
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
        { name: 'ZIP Archives', extensions: ['zip'] }
      ]
    });
    if (result.canceled || !result.filePaths.length) {
      return { canceled: true, filePaths: [] };
    }
    return { canceled: false, filePaths: result.filePaths };
  });
  ipcMain.handle('human-models:upload', async (_event, { filePath }) => {
    try {
      const path = require('path');
      const fs = require('fs');
      const FormData = require('form-data');

      const filename = path.basename(filePath);

      console.log('[Human Models Upload] Source:', filePath);

      // Check if source file exists
      if (!fs.existsSync(filePath)) {
        console.error('[Human Models Upload] Source file not found:', filePath);
        return { success: false, error: 'Source file not found' };
      }

      // Upload to server via multipart form
      const settings = ensureServerConfigured();
      const url = new URL('/api/human-models/upload', settings.serverBaseUrl);

      const form = new FormData();
      form.append('file', fs.createReadStream(filePath), filename);

      const headers = form.getHeaders();
      if (settings.apiKey) {
        headers['X-API-Key'] = settings.apiKey;
      }

      const { fetch: doFetch } = await ensureFetch();
      const response = await doFetch(url.toString(), {
        method: 'POST',
        headers,
        body: form
      });

      const result = await response.json();

      if (!response.ok) {
        console.error('[Human Models Upload] Server error:', result);
        return { success: false, error: result.error || 'Upload failed' };
      }

      console.log('[Human Models Upload] Success:', result.filePath);
      return result;
    } catch (e) {
      console.error('[Human Models Upload] Error:', e);
      return { success: false, error: e?.message || 'Upload failed' };
    }
  });

  // Human Models - Extract ZIP file
  ipcMain.handle('human-models:extract-zip', async (_event, zipPath) => {
    const AdmZip = require('adm-zip');
    const path = require('path');
    const os = require('os');
    const fs = require('fs');

    try {
      const zip = new AdmZip(zipPath);
      const zipEntries = zip.getEntries();

      // Create temp directory for extraction
      const tempDir = path.join(os.tmpdir(), `human-models-zip-${Date.now()}`);
      fs.mkdirSync(tempDir, { recursive: true });

      const imageExtensions = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
      const extractedPaths = [];

      for (const entry of zipEntries) {
        if (entry.isDirectory) continue;

        const ext = path.extname(entry.entryName).toLowerCase();
        if (!imageExtensions.includes(ext)) continue;

        // Skip __MACOSX and hidden files
        if (entry.entryName.includes('__MACOSX') || entry.entryName.startsWith('.') || entry.entryName.includes('/.')) {
          continue;
        }

        // Extract to temp directory with flat structure
        const filename = path.basename(entry.entryName);
        const destPath = path.join(tempDir, filename);

        // Avoid overwriting files with same name
        let finalPath = destPath;
        let counter = 1;
        while (fs.existsSync(finalPath)) {
          const baseName = path.basename(filename, ext);
          finalPath = path.join(tempDir, `${baseName}_${counter}${ext}`);
          counter++;
        }

        zip.extractEntryTo(entry, tempDir, false, true);
        // Rename if needed
        if (finalPath !== destPath && fs.existsSync(destPath)) {
          fs.renameSync(destPath, finalPath);
        }

        extractedPaths.push(finalPath);
      }

      return { success: true, extractedPaths, tempDir };
    } catch (e) {
      console.error('ZIP extraction error:', e);
      return { success: false, error: e?.message || 'ZIP extraction failed' };
    }
  });

  // Human Models - AI Metadata Analysis
  ipcMain.handle('human-models:analyze-metadata', async (_event, modelId) => {
    try {
      const result = await httpRequest(`/api/human-models/${encodeURIComponent(modelId)}/analyze`, { method: 'POST' });
      return result;
    } catch (e) {
      console.error('[Human Models AI] Analyze error:', e);
      return { success: false, error: e?.message || 'Analysis failed' };
    }
  });

  // Human Models - AI-powered garment recoloring
  ipcMain.handle('human-models:recolor', async (_event, { modelId, color, garmentType, force }) => {
    try {
      console.log(`[Human Models Recolor] Request: ${modelId} -> ${color} (${garmentType || 't-shirt'})`);
      const result = await httpRequest(`/api/human-models/${encodeURIComponent(modelId)}/recolor`, {
        method: 'POST',
        body: { color, garmentType: garmentType || 't-shirt', force: !!force }
      });
      return result;
    } catch (e) {
      console.error('[Human Models Recolor] Error:', e);
      return { success: false, error: e?.message || 'Recolor failed' };
    }
  });

  // Human Models - List color variants for a model
  ipcMain.handle('human-models:color-variants', async (_event, modelId) => {
    try {
      const result = await httpRequest(`/api/human-models/${encodeURIComponent(modelId)}/color-variants`, { method: 'GET' });
      return result;
    } catch (e) {
      console.error('[Human Models] Color variants error:', e);
      return { success: false, error: e?.message || 'Failed to list variants' };
    }
  });

  // ============================================================================
  // MOCKUP BACKGROUNDS - for decal mockups
  // ============================================================================
  ipcMain.handle('mockup-backgrounds:list', (_event, query) =>
    httpRequest(`/api/mockup-backgrounds?activeOnly=${query?.activeOnly !== false}&limit=${query?.limit || 1000}&offset=${query?.offset || 0}${query?.category ? '&category=' + encodeURIComponent(query.category) : ''}`, { method: 'GET' })
  );
  ipcMain.handle('mockup-backgrounds:categories', () =>
    httpRequest('/api/mockup-backgrounds', { method: 'GET' }).then(r => ({ success: true, categories: r?.categories || [] }))
  );
  ipcMain.handle('mockup-backgrounds:get', (_event, id) =>
    httpRequest(`/api/mockup-backgrounds/${encodeURIComponent(id)}`, { method: 'GET' })
  );
  ipcMain.handle('mockup-backgrounds:create', (_event, payload) =>
    httpRequest('/api/mockup-backgrounds', { method: 'POST', body: payload || {} })
  );
  ipcMain.handle('mockup-backgrounds:update', (_event, { id, payload }) =>
    httpRequest(`/api/mockup-backgrounds/${encodeURIComponent(id)}`, { method: 'PATCH', body: payload || {} })
  );
  ipcMain.handle('mockup-backgrounds:delete', (_event, id) =>
    httpRequest(`/api/mockup-backgrounds/${encodeURIComponent(id)}`, { method: 'DELETE' })
  );
  ipcMain.handle('mockup-backgrounds:select-file', async (_event, options) => {
    const defaultFilters = [
      { name: 'Images & Archives', extensions: ['png', 'jpg', 'jpeg', 'webp', 'zip'] },
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
      { name: 'ZIP Archives', extensions: ['zip'] }
    ];
    const properties = ['openFile'];
    if (options?.multiple) {
      properties.push('multiSelections');
    }
    const result = await dialog.showOpenDialog({
      title: options?.title || 'Select Background Image or ZIP',
      properties,
      filters: options?.filters || defaultFilters
    });
    if (result.canceled || !result.filePaths.length) {
      return { canceled: true };
    }
    // Return multiple files if requested, otherwise single file for backwards compatibility
    if (options?.multiple) {
      return { canceled: false, filePaths: result.filePaths };
    }
    return { canceled: false, filePath: result.filePaths[0] };
  });
  ipcMain.handle('mockup-backgrounds:upload', async (_event, { filePath }) => {
    try {
      const path = require('path');
      const fs = require('fs');
      const FormData = require('form-data');
      const os = require('os');

      const filename = path.basename(filePath);
      const ext = path.extname(filePath).toLowerCase();

      console.log('[Mockup Backgrounds Upload] Source:', filePath);

      // Check if source file exists
      if (!fs.existsSync(filePath)) {
        console.error('[Mockup Backgrounds Upload] Source file not found:', filePath);
        return { success: false, error: 'Source file not found' };
      }

      // Handle ZIP files - extract locally and upload each image
      if (ext === '.zip') {
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(filePath);
        const zipEntries = zip.getEntries();
        const imageExtensions = ['.png', '.jpg', '.jpeg', '.webp'];
        const results = [];

        // Create temp directory for extraction
        const tempDir = path.join(os.tmpdir(), `mockup-bg-${Date.now()}`);
        fs.mkdirSync(tempDir, { recursive: true });

        console.log('[Mockup Backgrounds ZIP] Extracting to:', tempDir);

        for (const entry of zipEntries) {
          if (entry.isDirectory) continue;

          const entryExt = path.extname(entry.entryName).toLowerCase();
          if (!imageExtensions.includes(entryExt)) continue;

          // Extract to temp directory
          const entryFilename = path.basename(entry.entryName);
          const tempPath = path.join(tempDir, entryFilename);
          zip.extractEntryTo(entry, tempDir, false, true);

          // Upload this image to server
          try {
            const settings = ensureServerConfigured();
            const url = new URL('/api/mockup-backgrounds/upload', settings.serverBaseUrl);

            const form = new FormData();
            form.append('file', fs.createReadStream(tempPath), entryFilename);

            const headers = form.getHeaders();
            if (settings.apiKey) {
              headers['X-API-Key'] = settings.apiKey;
            }

            const { fetch: doFetch } = await ensureFetch();
            const response = await doFetch(url.toString(), {
              method: 'POST',
              headers,
              body: form
            });

            const result = await response.json();

            if (response.ok && result.success) {
              const baseName = path.basename(entry.entryName, entryExt);
              results.push({
                filePath: result.filePath,
                thumbnailPath: result.thumbnailPath,
                filename: entryFilename,
                suggestedName: baseName.replace(/[_-]/g, ' ').trim(),
                width: result.width,
                height: result.height,
                fileSize: result.fileSize
              });
            }
          } catch (uploadErr) {
            console.warn('[Mockup Backgrounds ZIP] Failed to upload:', entryFilename, uploadErr.message);
          }

          // Clean up temp file
          try { fs.unlinkSync(tempPath); } catch (e) {}
        }

        // Clean up temp directory
        try { fs.rmdirSync(tempDir); } catch (e) {}

        console.log('[Mockup Backgrounds ZIP] Uploaded', results.length, 'images');
        return {
          success: true,
          isZip: true,
          files: results,
          count: results.length
        };
      }

      // Upload single image to server via multipart form
      const settings = ensureServerConfigured();
      const url = new URL('/api/mockup-backgrounds/upload', settings.serverBaseUrl);

      const form = new FormData();
      form.append('file', fs.createReadStream(filePath), filename);

      const headers = form.getHeaders();
      if (settings.apiKey) {
        headers['X-API-Key'] = settings.apiKey;
      }

      const { fetch: doFetch } = await ensureFetch();
      const response = await doFetch(url.toString(), {
        method: 'POST',
        headers,
        body: form
      });

      const result = await response.json();

      if (!response.ok) {
        console.error('[Mockup Backgrounds Upload] Server error:', result);
        return { success: false, error: result.error || 'Upload failed' };
      }

      console.log('[Mockup Backgrounds Upload] Success:', result.filePath);
      return result;
    } catch (e) {
      console.error('[Mockup Backgrounds Upload] Error:', e);
      return { success: false, error: e?.message || 'Upload failed' };
    }
  });

  // Dashboard - Get aggregated stats
  ipcMain.handle('dashboard:stats', (_event, { period }) =>
    httpRequest(`/api/dashboard/stats?period=${encodeURIComponent(period || 'week')}`, { method: 'GET' })
  );

  // Dashboard - Get server health stats
  ipcMain.handle('dashboard:server-stats', () =>
    httpRequest('/api/server/stats', { method: 'GET' })
  );

  // Dashboard - Get social/marketing stats (Facebook/Meta API)
  ipcMain.handle('dashboard:social-stats', (_event, { period }) =>
    httpRequest(`/api/dashboard/social-stats?period=${encodeURIComponent(period || '7d')}`, { method: 'GET' })
  );

  // Admin cleanup (internal) — list orphans, cleanup, delete
  ipcMain.handle('admin:orders:orphans', () =>
    httpRequest('/api/internal/orders/orphans', { method: 'GET' })
  );
  ipcMain.handle('admin:orders:cleanup', (_event, payload) =>
    httpRequest('/api/internal/orders/cleanup', { method: 'POST', body: payload || {} })
  );
  ipcMain.handle('admin:orders:delete', (_event, id) =>
    httpRequest(`/api/internal/orders/${encodeURIComponent(String(id || ''))}`, { method: 'DELETE' })
  );

  // Admin: SMS test
  ipcMain.handle('admin:sms:test', (_event, payload) =>
    httpRequest('/api/internal/sms/test', { method: 'POST', body: payload || {} })
  );
  ipcMain.handle('admin:sms:send', (_event, payload) =>
    httpRequest('/api/internal/sms/send', { method: 'POST', body: payload || {} })
  );
  ipcMain.handle('admin:inbound:list', (_event, query) =>
    httpRequest('/api/internal/inbound-messages', { method: 'GET', query: query || {} })
  );

  // Marketing/admin
  ipcMain.handle('marketing:audience-map', () =>
    httpRequest('/api/internal/marketing/audience-map', { method: 'GET' })
  );
  ipcMain.handle('marketing:classify', (_event, product) =>
    httpRequest('/api/internal/marketing/classify', { method: 'POST', body: { product: product || {} } })
  );
  ipcMain.handle('marketing:launch', (_event, payload) =>
    httpRequest('/api/internal/marketing/launch', { method: 'POST', body: payload || {} })
  );
  ipcMain.handle('marketing:preview', (_event, payload) =>
    httpRequest('/api/internal/marketing/preview', { method: 'POST', body: payload || {} })
  );
  ipcMain.handle('marketing:llm:classify', (_event, payload) =>
    httpRequest('/api/internal/marketing/llm/classify', { method: 'POST', body: payload || {} })
  );
  ipcMain.handle('marketing:ad-templates', () =>
    httpRequest('/api/internal/marketing/ad-templates', { method: 'GET' })
  );
  ipcMain.handle('ads:performance:list', (_event, limit) =>
    httpRequest('/api/internal/ads/performance', { method: 'GET', query: { limit: limit || 200 } })
  );
  // Shopify test carts (internal)
  ipcMain.handle('shopify:test:carts:list', () =>
    httpRequest('/api/internal/marketing/shopify/test/carts', { method: 'GET' })
  );
  ipcMain.handle('shopify:test:carts:clear', () =>
    httpRequest('/api/internal/marketing/shopify/test/carts', { method: 'DELETE' })
  );
  ipcMain.handle('shopify:collection:get', (_event, id) =>
    httpRequest(`/api/internal/marketing/shopify/collection/${encodeURIComponent(String(id||''))}`, { method: 'GET' })
  );
  ipcMain.handle('shopify:collection:update', (_event, payload) =>
    httpRequest(`/api/internal/marketing/shopify/collection/${encodeURIComponent(String(payload?.id||''))}`, { method: 'POST', body: { marketing_profile: payload?.profile || {} } })
  );
  ipcMain.handle('shopify:collections:list', (_event, query) =>
    httpRequest('/api/internal/marketing/shopify/collections', { method: 'GET', query: query || {} })
  );
  // Campaign → Shopify export
  ipcMain.handle('shopify:campaign:export', (_event, payload) => {
    const slug = typeof payload === 'string' ? payload : (payload?.slug || '');
    if (!slug) throw new Error('Campaign slug is required.');
    const only = Array.isArray(payload?.only) && payload.only.length ? payload.only.join(',') : undefined;
    const force = payload?.force ? '1' : undefined;
    const skipMockups = payload?.skipMockups ? '1' : undefined;
    const query = { async: '1' };
    if (only) query.only = only;
    if (force) query.force = force;
    if (skipMockups) query.skipMockups = skipMockups;
    return httpRequest(`/api/internal/marketing/shopify/export-campaign/${encodeURIComponent(String(slug))}`, { method: 'POST', query });
  });
  ipcMain.handle('shopify:campaign:page', (_event, slug) => {
    if (!slug) throw new Error('Campaign slug is required.');
    return httpRequest(`/api/internal/marketing/shopify/campaign-page/${encodeURIComponent(String(slug))}`, { method: 'POST' });
  });
  ipcMain.handle('shopify:campaign:refresh-descriptions', (_event, slug) => {
    if (!slug) throw new Error('Campaign slug is required.');
    return httpRequest(`/api/internal/marketing/shopify/campaign-refresh/${encodeURIComponent(String(slug))}`, { method: 'POST' });
  });
  ipcMain.handle('shopify:campaign:export:status', (_event, slug) => {
    if (!slug) throw new Error('Campaign slug is required.');
    return httpRequest(`/api/internal/marketing/shopify/export-campaign/${encodeURIComponent(String(slug))}/status`, { method: 'GET' });
  });
  ipcMain.handle('shopify:campaign:export:cancel', (_event, slug) => {
    if (!slug) throw new Error('Campaign slug is required.');
    return httpRequest(`/api/internal/marketing/shopify/export-campaign/${encodeURIComponent(String(slug))}/cancel`, { method: 'POST' });
  });
  // Promo/discount stats
  ipcMain.handle('shopify:promo:stats', (_event, discountId) => {
    if (!discountId) throw new Error('Discount ID is required.');
    return httpRequest(`/api/internal/marketing/shopify/promo-stats/${encodeURIComponent(String(discountId))}`, { method: 'GET' });
  });

  // ============================================================================
  // SHOPIFY MANAGER APIs
  // ============================================================================
  ipcMain.handle('shopify-manager:products:list', async (_event, query) => {
    try {
      const data = await httpRequest('/api/internal/shopify-manager/products', { method: 'GET', query: query || {} });
      return { success: true, data };
    } catch (error) {
      console.error('[Shopify Manager] Failed to list products:', error);
      return { success: false, error: error.message || 'Failed to load products' };
    }
  });
  ipcMain.handle('shopify-manager:products:get', async (_event, id) => {
    try {
      if (!id) throw new Error('Product ID is required.');
      const data = await httpRequest(`/api/internal/shopify-manager/products/${encodeURIComponent(String(id))}`, { method: 'GET' });
      return { success: true, data };
    } catch (error) {
      console.error('[Shopify Manager] Failed to get product:', error);
      return { success: false, error: error.message || 'Failed to load product' };
    }
  });
  ipcMain.handle('shopify-manager:products:update', (_event, payload) => {
    const { id, updates } = payload || {};
    if (!id) throw new Error('Product ID is required.');
    return httpRequest(`/api/internal/shopify-manager/products/${encodeURIComponent(String(id))}`, {
      method: 'PUT',
      body: updates || {}
    });
  });
  ipcMain.handle('shopify-manager:variants:update', (_event, payload) => {
    const { id, updates } = payload || {};
    if (!id) throw new Error('Variant ID is required.');
    return httpRequest(`/api/internal/shopify-manager/variants/${encodeURIComponent(String(id))}`, {
      method: 'PUT',
      body: updates || {}
    });
  });
  ipcMain.handle('shopify-manager:bulk:update', (_event, payload) =>
    httpRequest('/api/internal/shopify-manager/bulk-update', { method: 'POST', body: payload || {} })
  );
  ipcMain.handle('shopify-manager:collections:list', async () => {
    try {
      const data = await httpRequest('/api/internal/shopify-manager/collections', { method: 'GET' });
      return { success: true, data };
    } catch (error) {
      console.error('[Shopify Manager] Failed to list collections:', error);
      return { success: false, error: error.message || 'Failed to load collections' };
    }
  });
  ipcMain.handle('shopify-manager:collections:products', async (_event, collectionId) => {
    try {
      if (!collectionId) throw new Error('Collection ID is required.');
      const data = await httpRequest(`/api/internal/shopify-manager/collections/${encodeURIComponent(String(collectionId))}/products`, { method: 'GET' });
      return { success: true, data };
    } catch (error) {
      console.error('[Shopify Manager] Failed to get collection products:', error);
      return { success: false, error: error.message || 'Failed to load collection products' };
    }
  });

  // Pricing sheet
  ipcMain.handle('pricing:get', () => {
    return httpRequest('/api/internal/marketing/pricing', { method: 'GET' });
  });
  ipcMain.handle('pricing:save', (_event, payload) => {
    const body = payload && payload.pricing ? payload : { pricing: payload };
    return httpRequest('/api/internal/marketing/pricing', { method: 'PUT', body });
  });
  // Shopify POD fulfillment
  ipcMain.handle('pod:fulfill', (_event, payload) =>
    fulfillPodLineItems(payload || {})
  );
  // Sales reports
  ipcMain.handle('reports:sales:summary', (_event, query) =>
    httpRequest('/api/internal/reports/sales/summary', { method: 'GET', query: query || {} })
  );
  ipcMain.handle('reports:sales:by-day', (_event, query) =>
    httpRequest('/api/internal/reports/sales/by-day', { method: 'GET', query: query || {} })
  );
  ipcMain.handle('reports:sales:by-category', (_event, query) =>
    httpRequest('/api/internal/reports/sales/by-category', { method: 'GET', query: query || {} })
  );
  ipcMain.handle('reports:sales:by-color', (_event, query) =>
    httpRequest('/api/internal/reports/sales/by-color', { method: 'GET', query: query || {} })
  );
  ipcMain.handle('reports:sales:by-campaign', (_event, query) =>
    httpRequest('/api/internal/reports/sales/by-campaign', { method: 'GET', query: query || {} })
  );
  ipcMain.handle('reports:sales:top-designs', (_event, query) =>
    httpRequest('/api/internal/reports/sales/top-designs', { method: 'GET', query: query || {} })
  );
  ipcMain.handle('reports:campaigns', (_event, query) =>
    httpRequest('/api/internal/reports/campaigns', { method: 'GET', query: query || {} })
  );

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

  // Native confirm dialog (avoids focus issues with window.confirm)
  ipcMain.handle('dialog:confirm', async (_event, { message, title }) => {
    const result = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Cancel', 'OK'],
      defaultId: 1,
      cancelId: 0,
      title: title || 'Confirm',
      message: message || 'Are you sure?'
    });
    return result.response === 1; // OK button
  });

  // Internal API key test
  ipcMain.handle('internal:test', async () => {
    return httpRequest('/api/internal/ping', { method: 'GET' });
  });
  ipcMain.handle('llm:test', async () => {
    try {
      const data = await httpRequest('/api/internal/marketing/llm/classify', {
        method: 'POST',
        body: { product: { title: 'Ping', description: 'Test' } }
      });
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: e?.message || 'Failed' };
    }
  });

  ipcMain.handle('fs:listImages', async (_event, payload = {}) => {
    const directory = payload?.directory;
    if (!directory) {
      throw new Error('Directory path is required.');
    }
    try {
      const entries = await fsPromises.readdir(directory, { withFileTypes: true });
      const files = entries
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(directory, entry.name))
        .filter((filePath) => IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase()))
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
      return files;
    } catch (error) {
      throw new Error(error?.message || 'Unable to read directory.');
    }
  });

  ipcMain.handle('system:openExternal', (_event, target) => {
    if (!target) return false;
    return shell.openExternal(target);
  });

  ipcMain.handle('jobs:cancel', (_event, jobId) => {
    if (!jobId) return { cancelled: false };
    cancelledJobs.add(String(jobId));
    // Auto-clear after a few minutes to prevent growth
    setTimeout(() => cancelledJobs.delete(String(jobId)), 5 * 60 * 1000).unref?.();
    return { cancelled: true };
  });

  ipcMain.handle('watch:importNow', async () => {
    try {
      const settings = getSettings();
      if (!settings.watchFolder) throw new Error('Choose a watch folder in Settings first.');
      const scanned = await scanDirectoryForItems(settings.watchFolder);
      const fresh = scanned.filter((x) => !ensureLocalDb()?.findByHash(x.hash));
      const saved = [];
      for (const item of fresh) {
        const rec = ensureLocalDb().upsert({
          path: item.path,
          category: item.category,
          title: item.title,
          file_type: item.file_type,
          size: item.size,
          hash: item.hash,
          phash: item.phash || null,
          status: 'imported'
        });
        try {
          if (settings.watchOcr) {
            const text = await performOcr(rec.optimized_path || item.path);
            const tags = suggestTags(text);
            localDb.update(rec.id, {
              title: (!rec.title || /^img|^image|^scan/i.test(rec.title)) ? text : rec.title,
              tags: JSON.stringify(tags)
            });
          }
        } catch (_) {}
        try { await optimizePreview(rec); } catch (_) {}
        if (settings.watchAutoApprove) {
          try { ensureLocalDb().update(rec.id, { status: 'approved' }); } catch (_) {}
        }
        if (settings.watchAutoMockup && settings.watchMockupBackground && settings.watchMockupOutputDir) {
          try {
            await generateMockupForRow(rec, {
              background: settings.watchMockupBackground,
              outDir: settings.watchMockupOutputDir,
              widthPct: Number(settings.watchMockupWidthPct) || 40,
              yOffsetPct: Number(settings.watchMockupYOffsetPct) || 0,
              removeBg: true,
              keyColor: settings.watchMockupKeyColor || '#ffffff',
              fuzzPct: Number(settings.watchMockupFuzzPct) || 10
            });
          } catch (_) {}
        }
        saved.push(rec);
      }
      return { imported: saved.length };
    } catch (error) {
      return { imported: 0, error: error?.message || String(error) };
    }
  });

  // Remove background from previews for selected items
  ipcMain.handle('local:previews:remove-bg', async (_event, payload = {}) => {
    const { ids = [], keyColor = '#ffffff', fuzzPct = 10, jobId } = payload || {};
    if (!Array.isArray(ids) || !ids.length) return { updated: 0 };
    const db = ensureLocalDb();
    if (!db) return { updated: 0 };
    let count = 0;
    try { _event?.sender?.send('local:previews:remove-bg:progress', { current: 0, total: ids.length }); } catch (_) {}
    for (let i = 0; i < ids.length; i++) {
      if (jobId && cancelledJobs.has(String(jobId))) break;
      const id = ids[i];
      const row = db.getById(id);
      if (!row) continue;
      const previewPath = row.optimized_path || (await optimizePreview(row));
      try {
        const buf = await fs.promises.readFile(previewPath);
        const stripped = await removeBackgroundWithMagickBuffer(buf, { keyColor, fuzzPct });
        if (stripped) {
          const outPath = previewOutputPathFor(row.hash || path.basename(row.path), '.png');
          await fs.promises.writeFile(outPath, stripped);
          db.update(id, { optimized_path: outPath });
          count++;
        }
      } catch (_) {}
      try { _event?.sender?.send('local:previews:remove-bg:progress', { current: i + 1, total: ids.length, id, name: row.title || path.basename(row.path), jobId }); } catch (_) {}
    }
    return { updated: count };
  });

  // ==================== 3D Printer Fleet IPC ====================

  // --- Printer CRUD ---
  ipcMain.handle('fleet:printers:list', (_event, query = {}) => {
    if (!fleetDb) return [];
    return fleetDb.listPrinters(query);
  });

  ipcMain.handle('fleet:printers:get', (_event, id) => {
    if (!fleetDb) return null;
    return fleetDb.getPrinter(id);
  });

  ipcMain.handle('fleet:printers:upsert', (_event, printer) => {
    if (!fleetDb) throw new Error('Fleet DB not initialized');
    const result = fleetDb.upsertPrinter(printer);
    if (result && result.active) connectToPrinter(result);
    return result;
  });

  ipcMain.handle('fleet:printers:update', (_event, { id, updates } = {}) => {
    if (!fleetDb || !id) return null;
    const before = fleetDb.getPrinter(id);
    const result = fleetDb.updatePrinter(id, updates || {});
    // Reconnect if URL changed or printer was re-enabled
    if (result && before) {
      if (before.api_url !== result.api_url || (!before.active && result.active)) {
        disconnectPrinter(before);
        if (result.active) connectToPrinter(result);
      }
    }
    return result;
  });

  ipcMain.handle('fleet:printers:remove', (_event, id) => {
    if (!fleetDb || !id) return { changes: 0 };
    const printer = fleetDb.getPrinter(id);
    if (printer) disconnectPrinter(printer);
    return fleetDb.removePrinter(id);
  });

  // --- Printer Status ---
  ipcMain.handle('fleet:printers:status', async (_event, id) => {
    if (!fleetDb || !printerService) return null;
    const printer = fleetDb.getPrinter(id);
    if (!printer) return null;
    // Return cached status if available, otherwise fetch live
    const cached = printerService.getCachedStatus(printer.api_url);
    if (cached && Date.now() - cached.timestamp < 10000) return cached;
    try {
      return await printerService.getPrinterStatus(printer.api_url);
    } catch (err) {
      return { state: 'offline', error: err.message, timestamp: Date.now() };
    }
  });

  ipcMain.handle('fleet:printers:statusAll', async () => {
    if (!fleetDb || !printerService) return [];
    const printers = fleetDb.listPrinters({ active: true });
    const results = [];
    for (const p of printers) {
      const cached = printerService.getCachedStatus(p.api_url);
      if (cached && Date.now() - cached.timestamp < 10000) {
        results.push({ ...p, status: cached });
      } else {
        try {
          const status = await printerService.getPrinterStatus(p.api_url);
          results.push({ ...p, status });
        } catch (err) {
          results.push({ ...p, status: { state: 'offline', error: err.message, timestamp: Date.now() } });
        }
      }
    }
    return results;
  });

  ipcMain.handle('fleet:printers:reconnect', async (_event, id) => {
    if (!fleetDb || !printerService) return { success: false };
    const printer = fleetDb.getPrinter(id);
    if (!printer) return { success: false, error: 'Printer not found' };
    disconnectPrinter(printer);
    connectToPrinter(printer);
    return { success: true };
  });

  ipcMain.handle('fleet:printers:testConnection', async (_event, apiUrl) => {
    if (!printerService) return { success: false, error: 'Service not initialized' };
    try {
      const status = await printerService.getPrinterStatus(apiUrl);
      const info = await printerService.getPrinterInfo(apiUrl);
      return { success: true, status, info };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // --- G-code File Management ---
  ipcMain.handle('fleet:files:select', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'G-code Files', extensions: ['gcode', 'g', 'gco'] }]
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('fleet:files:upload', async (_event, { printerId, filePath }) => {
    if (!fleetDb || !printerService) throw new Error('Fleet not initialized');
    const printer = fleetDb.getPrinter(printerId);
    if (!printer) throw new Error('Printer not found');
    return await printerService.uploadGcode(printer.api_url, filePath);
  });

  ipcMain.handle('fleet:files:list', async (_event, { printerId }) => {
    if (!fleetDb || !printerService) throw new Error('Fleet not initialized');
    const printer = fleetDb.getPrinter(printerId);
    if (!printer) throw new Error('Printer not found');
    return await printerService.listFiles(printer.api_url);
  });

  ipcMain.handle('fleet:files:delete', async (_event, { printerId, filename }) => {
    if (!fleetDb || !printerService) throw new Error('Fleet not initialized');
    const printer = fleetDb.getPrinter(printerId);
    if (!printer) throw new Error('Printer not found');
    return await printerService.deleteFile(printer.api_url, filename);
  });

  // --- Print Job Control ---
  ipcMain.handle('fleet:print:start', async (_event, { printerId, filename, shopifyOrderId }) => {
    if (!fleetDb || !printerService) throw new Error('Fleet not initialized');
    const printer = fleetDb.getPrinter(printerId);
    if (!printer) throw new Error('Printer not found');
    await printerService.startPrint(printer.api_url, filename);
    const job = fleetDb.createJob({
      printer_id: printerId,
      filename,
      status: 'printing',
      started_at: new Date().toISOString(),
      shopify_order_id: shopifyOrderId || null
    });
    printerService.updatePollRate(printer.api_url, true);
    return job;
  });

  ipcMain.handle('fleet:print:pause', async (_event, { printerId }) => {
    if (!fleetDb || !printerService) throw new Error('Fleet not initialized');
    const printer = fleetDb.getPrinter(printerId);
    if (!printer) throw new Error('Printer not found');
    await printerService.pausePrint(printer.api_url);
    const activeJobs = fleetDb.getActiveJobs().filter(j => j.printer_id === printerId);
    if (activeJobs.length) fleetDb.updateJob(activeJobs[0].id, { status: 'paused' });
    return { success: true };
  });

  ipcMain.handle('fleet:print:resume', async (_event, { printerId }) => {
    if (!fleetDb || !printerService) throw new Error('Fleet not initialized');
    const printer = fleetDb.getPrinter(printerId);
    if (!printer) throw new Error('Printer not found');
    await printerService.resumePrint(printer.api_url);
    const activeJobs = fleetDb.getActiveJobs().filter(j => j.printer_id === printerId && j.status === 'paused');
    if (activeJobs.length) fleetDb.updateJob(activeJobs[0].id, { status: 'printing' });
    printerService.updatePollRate(printer.api_url, true);
    return { success: true };
  });

  ipcMain.handle('fleet:print:cancel', async (_event, { printerId }) => {
    if (!fleetDb || !printerService) throw new Error('Fleet not initialized');
    const printer = fleetDb.getPrinter(printerId);
    if (!printer) throw new Error('Printer not found');
    await printerService.cancelPrint(printer.api_url);
    const activeJobs = fleetDb.getActiveJobs().filter(j => j.printer_id === printerId);
    if (activeJobs.length) {
      fleetDb.updateJob(activeJobs[0].id, {
        status: 'cancelled',
        completed_at: new Date().toISOString()
      });
    }
    printerService.updatePollRate(printer.api_url, false);
    return { success: true };
  });

  ipcMain.handle('fleet:print:emergencyStop', async (_event, { printerId }) => {
    if (!fleetDb || !printerService) throw new Error('Fleet not initialized');
    const printer = fleetDb.getPrinter(printerId);
    if (!printer) throw new Error('Printer not found');
    await printerService.emergencyStop(printer.api_url);
    const activeJobs = fleetDb.getActiveJobs().filter(j => j.printer_id === printerId);
    if (activeJobs.length) {
      fleetDb.updateJob(activeJobs[0].id, {
        status: 'error',
        error_message: 'Emergency stop triggered',
        completed_at: new Date().toISOString()
      });
    }
    return { success: true };
  });

  ipcMain.handle('fleet:gcode:send', async (_event, { printerId, command }) => {
    if (!fleetDb || !printerService) throw new Error('Fleet not initialized');
    const printer = fleetDb.getPrinter(printerId);
    if (!printer) throw new Error('Printer not found');
    return await printerService.sendGcode(printer.api_url, command);
  });

  // --- Webcam ---
  ipcMain.handle('fleet:webcam:urls', async (_event, printerId) => {
    if (!fleetDb || !printerService) throw new Error('Fleet not initialized');
    const printer = fleetDb.getPrinter(printerId);
    if (!printer) throw new Error('Printer not found');
    return await printerService.getWebcamUrls(printer.api_url);
  });

  // --- Job History ---
  ipcMain.handle('fleet:jobs:list', (_event, query = {}) => {
    if (!fleetDb) return [];
    return fleetDb.listJobs(query);
  });

  ipcMain.handle('fleet:jobs:active', () => {
    if (!fleetDb) return [];
    return fleetDb.getActiveJobs();
  });

  ipcMain.handle('fleet:jobs:stats', () => {
    if (!fleetDb) return {};
    return fleetDb.getJobStats();
  });

  // ============================================================================
  // SLICER IPC HANDLERS (proxy to server API)
  // ============================================================================

  async function slicerFetch(endpoint, options = {}) {
    const { fetch: doFetch } = await ensureFetch();
    const settings = ensureServerConfigured();
    const url = `${settings.serverBaseUrl}${endpoint}`;
    const headers = { ...(options.headers || {}) };
    if (settings.apiKey) {
      headers['X-API-Key'] = settings.apiKey;
    }
    const resp = await doFetch(url, { ...options, headers });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(text || `Server returned ${resp.status}`);
    }
    return resp;
  }

  // Presets
  ipcMain.handle('slicer:presets', async () => {
    const resp = await slicerFetch('/api/slicer/presets');
    return resp.json();
  });

  // STL Catalog
  ipcMain.handle('slicer:catalog:list', async (_event, query = {}) => {
    const params = new URLSearchParams();
    if (query.category) params.set('category', query.category);
    if (query.search) params.set('search', query.search);
    const qs = params.toString();
    const resp = await slicerFetch(`/api/slicer/catalog${qs ? '?' + qs : ''}`);
    return resp.json();
  });

  ipcMain.handle('slicer:catalog:categories', async () => {
    const resp = await slicerFetch('/api/slicer/catalog/categories');
    return resp.json();
  });

  ipcMain.handle('slicer:catalog:get', async (_event, id) => {
    const resp = await slicerFetch(`/api/slicer/catalog/${id}`);
    return resp.json();
  });

  ipcMain.handle('slicer:catalog:create', async (_event, { filePath, name, category, defaults } = {}) => {
    if (!filePath) throw new Error('No file path provided');
    const { fetch: doFetch } = await ensureFetch();
    const settings = ensureServerConfigured();
    const form = new FormData();
    form.append('file', fs.createReadStream(filePath), path.basename(filePath));
    if (name) form.append('name', name);
    if (category) form.append('category', category);
    if (defaults) {
      if (defaults.quality) form.append('default_quality', defaults.quality);
      if (defaults.strength) form.append('default_strength', defaults.strength);
      if (defaults.material) form.append('default_material', defaults.material);
      if (defaults.texture) form.append('default_texture', defaults.texture);
      if (defaults.supports) form.append('default_supports', defaults.supports);
    }
    const headers = form.getHeaders();
    if (settings.apiKey) headers['X-API-Key'] = settings.apiKey;
    const resp = await doFetch(`${settings.serverBaseUrl}/api/slicer/catalog`, {
      method: 'POST',
      headers,
      body: form
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(text || `Upload failed (${resp.status})`);
    }
    return resp.json();
  });

  ipcMain.handle('slicer:catalog:update', async (_event, { id, updates } = {}) => {
    const resp = await slicerFetch(`/api/slicer/catalog/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });
    return resp.json();
  });

  ipcMain.handle('slicer:catalog:delete', async (_event, id) => {
    const resp = await slicerFetch(`/api/slicer/catalog/${id}`, { method: 'DELETE' });
    return resp.json();
  });

  // Bulk STL import — scan directory recursively for .stl files + extract from ZIPs
  ipcMain.handle('slicer:stl:bulkScan', async (_event, directory) => {
    if (!directory) throw new Error('No directory specified');
    const unzipper = require('unzipper');
    const os = require('os');

    const stlFiles = [];   // { filePath, name, source: 'file'|'zip', zipName? }

    // Recursive directory walk
    async function walk(dir) {
      let entries;
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch (_) { return; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name.startsWith('.') || entry.name === '__MACOSX') continue;
          await walk(full);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (ext === '.stl') {
            stlFiles.push({
              filePath: full,
              name: path.basename(entry.name, '.stl').replace(/[_-]/g, ' '),
              source: 'file'
            });
          } else if (ext === '.zip') {
            // Extract STL files from ZIP
            try {
              const zipDir = await unzipper.Open.file(full);
              const tempDir = path.join(os.tmpdir(), `stl-zip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
              fs.mkdirSync(tempDir, { recursive: true });
              for (const zipEntry of zipDir.files) {
                if (zipEntry.type === 'Directory') continue;
                const zExt = path.extname(zipEntry.path).toLowerCase();
                if (zExt !== '.stl') continue;
                if (zipEntry.path.includes('__MACOSX') || zipEntry.path.includes('/.')) continue;
                const destName = path.basename(zipEntry.path);
                let destPath = path.join(tempDir, destName);
                let counter = 1;
                while (fs.existsSync(destPath)) {
                  destPath = path.join(tempDir, `${path.basename(destName, '.stl')}_${counter}.stl`);
                  counter++;
                }
                await new Promise((resolve, reject) => {
                  zipEntry.stream()
                    .pipe(fs.createWriteStream(destPath))
                    .on('finish', resolve)
                    .on('error', reject);
                });
                stlFiles.push({
                  filePath: destPath,
                  name: path.basename(destName, '.stl').replace(/[_-]/g, ' '),
                  source: 'zip',
                  zipName: entry.name
                });
              }
            } catch (zipErr) {
              console.warn(`[Slicer] Failed to extract ZIP ${entry.name}:`, zipErr.message);
            }
          }
        }
      }
    }

    await walk(directory);
    console.log(`[Slicer] Bulk scan found ${stlFiles.length} STL files in ${directory}`);
    return stlFiles;
  });

  // Bulk STL upload — upload a single file to the catalog (called per file from renderer)
  ipcMain.handle('slicer:stl:bulkUploadOne', async (_event, { filePath, name, category } = {}) => {
    if (!filePath) throw new Error('No file path provided');
    const { fetch: doFetch } = await ensureFetch();
    const settings = ensureServerConfigured();
    const form = new FormData();
    form.append('file', fs.createReadStream(filePath), path.basename(filePath));
    if (name) form.append('name', name);
    if (category) form.append('category', category);
    const headers = form.getHeaders();
    if (settings.apiKey) headers['X-API-Key'] = settings.apiKey;
    const resp = await doFetch(`${settings.serverBaseUrl}/api/slicer/catalog`, {
      method: 'POST',
      headers,
      body: form
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(text || `Upload failed (${resp.status})`);
    }
    return resp.json();
  });

  // STL file download (for 3D preview in renderer)
  ipcMain.handle('slicer:stl:fetch', async (_event, stlId) => {
    const resp = await slicerFetch(`/api/slicer/stl/${stlId}/download`);
    const buf = await resp.arrayBuffer();
    return Buffer.from(buf).toString('base64');
  });

  // Slicing
  ipcMain.handle('slicer:slice', async (_event, options) => {
    const resp = await slicerFetch('/api/slicer/slice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options)
    });
    return resp.json();
  });

  // Slice + Download + Upload to printer + Start print
  ipcMain.handle('slicer:sliceAndPrint', async (_event, { sliceOptions, printerId, aceSlot } = {}) => {
    if (!printerId) throw new Error('printerId is required');
    if (!fleetDb) throw new Error('Fleet DB not initialized');
    if (!printerService) throw new Error('Printer service not initialized');

    const printer = fleetDb.getPrinter(printerId);
    if (!printer) throw new Error('Printer not found');

    // Step 1: Slice on server
    console.log('[Slicer] Step 1: Slicing on server...');
    const sliceResp = await slicerFetch('/api/slicer/slice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sliceOptions)
    });
    const sliceResult = await sliceResp.json();
    console.log(`[Slicer] Step 1 done: ${sliceResult.gcode_filename} (cached: ${sliceResult.cached})`);

    // Step 2: Download G-code from server to temp dir
    console.log('[Slicer] Step 2: Downloading G-code...');
    const gcodeResp = await slicerFetch(`/api/slicer/gcode/${sliceResult.gcode_id}/download`);
    const arrayBuf = await gcodeResp.arrayBuffer();
    const tmpDir = app.getPath('temp');
    const tmpPath = path.join(tmpDir, sliceResult.gcode_filename);
    fs.writeFileSync(tmpPath, Buffer.from(arrayBuf));
    console.log(`[Slicer] Step 2 done: ${tmpPath} (${arrayBuf.byteLength} bytes)`);

    // Step 3: Upload to printer via Moonraker
    console.log(`[Slicer] Step 3: Uploading to printer ${printer.name} (${printer.api_url})...`);
    try {
      await printerService.uploadGcode(printer.api_url, tmpPath);
    } catch (uploadErr) {
      // Clean up temp file on failure
      try { fs.unlinkSync(tmpPath); } catch {}
      throw new Error(`Failed to upload G-code to printer "${printer.name}": ${uploadErr.message}`);
    }
    console.log('[Slicer] Step 3 done: uploaded');

    // Step 4: Home, bed level, and start print
    console.log(`[Slicer] Step 4: Homing, leveling, and starting print...${aceSlot != null ? ' (ACE slot T' + aceSlot + ')' : ''}`);
    try {
      await printerService.homeAndPrint(printer.api_url, sliceResult.gcode_filename, aceSlot);
    } catch (startErr) {
      // Clean up temp file on failure
      try { fs.unlinkSync(tmpPath); } catch {}
      throw new Error(`G-code uploaded but failed to start print on "${printer.name}": ${startErr.message}. The file is on the printer — you can start it manually.`);
    }
    console.log('[Slicer] Step 4 done: print started');

    // Step 5: Create fleet job record
    const job = fleetDb.createJob({
      printer_id: printerId,
      filename: sliceResult.gcode_filename,
      status: 'printing',
      started_at: new Date().toISOString()
    });

    // Clean up temp file
    try { fs.unlinkSync(tmpPath); } catch {}

    return { success: true, job, sliceResult };
  });

  // Print existing G-code (download from server + upload to printer)
  ipcMain.handle('slicer:printGcode', async (_event, { gcodeId, printerId, aceSlot } = {}) => {
    if (!gcodeId || !printerId) throw new Error('gcodeId and printerId required');
    if (!fleetDb) throw new Error('Fleet DB not initialized');
    if (!printerService) throw new Error('Printer service not initialized');

    const printer = fleetDb.getPrinter(printerId);
    if (!printer) throw new Error('Printer not found');

    // Download G-code from server
    const gcodeResp = await slicerFetch(`/api/slicer/gcode/${gcodeId}/download`);
    const contentDisp = gcodeResp.headers.get('content-disposition') || '';
    const filenameMatch = contentDisp.match(/filename="?([^"]+)"?/);
    const filename = filenameMatch ? filenameMatch[1] : `gcode_${gcodeId}.gcode`;
    const arrayBuf = await gcodeResp.arrayBuffer();
    const tmpDir = app.getPath('temp');
    const tmpPath = path.join(tmpDir, filename);
    fs.writeFileSync(tmpPath, Buffer.from(arrayBuf));

    // Upload to printer
    try {
      await printerService.uploadGcode(printer.api_url, tmpPath);
    } catch (uploadErr) {
      try { fs.unlinkSync(tmpPath); } catch {}
      throw new Error(`Failed to upload G-code to printer "${printer.name}": ${uploadErr.message}`);
    }

    // Home, bed level, and start print
    try {
      await printerService.homeAndPrint(printer.api_url, filename, aceSlot);
    } catch (startErr) {
      try { fs.unlinkSync(tmpPath); } catch {}
      throw new Error(`G-code uploaded but failed to start print on "${printer.name}": ${startErr.message}. The file is on the printer — you can start it manually.`);
    }

    // Create fleet job record
    const job = fleetDb.createJob({
      printer_id: printerId,
      filename: filename,
      status: 'printing',
      started_at: new Date().toISOString()
    });

    // Clean up temp file
    try { fs.unlinkSync(tmpPath); } catch {}

    return { success: true, job };
  });

  // G-code cache
  ipcMain.handle('slicer:gcodeForStl', async (_event, stlId) => {
    const resp = await slicerFetch(`/api/slicer/cache/for/${stlId}`);
    return resp.json();
  });

  ipcMain.handle('slicer:cache:list', async () => {
    const resp = await slicerFetch('/api/slicer/cache');
    return resp.json();
  });

  ipcMain.handle('slicer:cache:delete', async (_event, id) => {
    const resp = await slicerFetch(`/api/slicer/cache/${id}`, { method: 'DELETE' });
    return resp.json();
  });

  ipcMain.handle('slicer:cache:clear', async () => {
    const resp = await slicerFetch('/api/slicer/cache', { method: 'DELETE' });
    return resp.json();
  });

  // Select STL file dialog (for upload)
  ipcMain.handle('slicer:selectStlFile', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select STL File',
      filters: [{ name: '3D Models', extensions: ['stl', 'STL'] }],
      properties: ['openFile']
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
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

  // Register custom protocol to serve local web files
  protocol.registerFileProtocol('app-local', (request, callback) => {
    const url = request.url.replace('app-local://', '');
    const filePath = path.join(__dirname, 'web', url);
    console.log('[Protocol] Serving:', filePath);
    callback({ path: filePath });
  });

  registerIpcHandlers();
  // Initialize local database for staged decals
  try {
    localDb = new LocalCatalogDB(app);
  } catch (err) {
    console.warn('Local catalog DB unavailable:', err?.message || err);
  }
  // Initialize 3D Printer Fleet
  try {
    fleetDb = new PrinterFleetDB(app);
    console.log('[Fleet] Printer fleet database initialized');
  } catch (err) {
    console.warn('Printer fleet DB unavailable:', err?.message || err);
  }
  try {
    const { fetch: fleetFetch } = await ensureFetch();
    printerService = new PrinterService({ fetch: fleetFetch });
    console.log('[Fleet] Printer service initialized');
    // Auto-connect to all active printers
    if (fleetDb) {
      const activePrinters = fleetDb.listPrinters({ active: true });
      for (const p of activePrinters) {
        connectToPrinter(p);
      }
      if (activePrinters.length) {
        console.log(`[Fleet] Connecting to ${activePrinters.length} active printer(s)`);
      }
    }
  } catch (err) {
    console.warn('Printer service unavailable:', err?.message || err);
  }
  try {
    applyWatchSettings(getSettings());
  } catch (err) {
    console.warn('Watch configuration failed:', err?.message || err);
  }
  const mainWindow = createWindow();

  // ==================== Webview Download Interception ====================
  // Intercept downloads from <webview> tags (Multiboard Parts Browser)
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() === 'webview') {
      contents.session.on('will-download', (_dlEvent, item, _webContents) => {
        const filename = item.getFilename();
        const ext = path.extname(filename).toLowerCase();
        const isStl = ext === '.stl';
        const is3mf = ext === '.3mf';
        const isStep = ext === '.step' || ext === '.stp';

        if (isStl || is3mf || isStep) {
          // Auto-save to multiboard-parts folder
          const partsDir = path.join(app.getPath('userData'), 'multiboard-parts');
          fs.mkdirSync(partsDir, { recursive: true });

          // Avoid filename collisions
          let savePath = path.join(partsDir, filename);
          let counter = 1;
          while (fs.existsSync(savePath)) {
            const base = path.basename(filename, ext);
            savePath = path.join(partsDir, `${base}_${counter}${ext}`);
            counter++;
          }

          item.setSavePath(savePath);

          // Notify renderer of download start
          const win = BrowserWindow.getAllWindows()[0];
          if (win && !win.isDestroyed()) {
            win.webContents.send('multiboard:download-start', {
              filename,
              savePath,
              totalBytes: item.getTotalBytes()
            });
          }

          item.on('updated', (_updateEvent, state) => {
            const win2 = BrowserWindow.getAllWindows()[0];
            if (win2 && !win2.isDestroyed()) {
              win2.webContents.send('multiboard:download-progress', {
                filename,
                receivedBytes: item.getReceivedBytes(),
                totalBytes: item.getTotalBytes(),
                state
              });
            }
          });

          item.once('done', (_doneEvent, state) => {
            const win3 = BrowserWindow.getAllWindows()[0];
            if (state === 'completed') {
              console.log(`[Multiboard] Downloaded: ${savePath}`);

              // Notify download complete
              if (win3 && !win3.isDestroyed()) {
                win3.webContents.send('multiboard:download-complete', {
                  filename, savePath, success: true, format: ext.replace('.', '')
                });
              }
            } else {
              console.warn(`[Multiboard] Download failed: ${filename} (${state})`);
              if (win3 && !win3.isDestroyed()) {
                win3.webContents.send('multiboard:download-complete', {
                  filename, success: false, error: state
                });
              }
            }
          });
        }
        // Non-STL/3MF/STEP files: default Electron download behavior
      });
    }
  });

  // Initialize auto-updater (only in production builds)
  if (!process.env.ELECTRON_IS_DEV && app.isPackaged) {
    initAutoUpdater(mainWindow);
  } else {
    console.log('[AutoUpdater] Skipping in development mode');
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  if (printerService) {
    printerService.disconnectAll();
  }
  if (fleetDb) {
    fleetDb.close();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Helpers
function previewOutputPathFor(hash, ext = '.jpg') {
  const base = path.join(app.getPath('userData'), 'local-catalog', 'optimized');
  fs.mkdirSync(base, { recursive: true });
  return path.join(base, `${hash}${ext}`);
}

async function optimizePreview(row) {
  const input = row.path;
  const hash = row.hash || path.basename(input);
  const cfg = getSettings();
  const removeBg = Boolean(cfg.previewRemoveBgEnabled);
  const keyColor = cfg.previewKeyColor || '#ffffff';
  const fuzzPct = Number(cfg.previewFuzzPct || 8);
  const extOut = removeBg ? '.png' : '.jpg';
  const outPath = previewOutputPathFor(hash, extOut);
  try {
    const stat = await fs.promises.stat(outPath).catch(() => null);
    if (stat && stat.size > 0) return outPath;
  } catch (_) {}
  // Resize to a reasonable preview size for web
  try {
    if (!removeBg) {
      await sharp(input)
        .rotate()
        .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82, mozjpeg: true })
        .toFile(outPath);
    } else {
      const buf = await sharp(input)
        .rotate()
        .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
        .png({ quality: 90 })
        .toBuffer();
      const stripped = await removeBackgroundWithMagickBuffer(buf, { keyColor, fuzzPct });
      await fs.promises.writeFile(outPath, stripped || buf);
    }
  } catch (err) {
    // If the input is SVG, try rasterizing explicitly
    const ext = path.extname(input).toLowerCase();
    if (VECTOR_EXTENSIONS.has(ext)) {
      const svgBuffer = await fs.promises.readFile(input);
      if (!removeBg) {
        await sharp(svgBuffer)
          .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 82, mozjpeg: true })
          .toFile(outPath);
      } else {
        const buf = await sharp(svgBuffer)
          .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
          .png({ quality: 90 })
          .toBuffer();
        const stripped = await removeBackgroundWithMagickBuffer(buf, { keyColor, fuzzPct });
        await fs.promises.writeFile(outPath, stripped || buf);
      }
    } else if (DOC_EXTENSIONS.has(ext)) {
      // Try sibling preview with same basename (png/jpg/webp/gif)
      const dir = path.dirname(input);
      const base = path.basename(input, ext);
      const candidates = ['.png', '.jpg', '.jpeg', '.webp', '.gif']
        .map((e) => path.join(dir, base + e))
        .filter((p) => fs.existsSync(p));
      if (candidates.length) {
        if (!removeBg) {
          await sharp(candidates[0])
            .rotate()
            .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 82, mozjpeg: true })
            .toFile(outPath);
        } else {
          const buf = await sharp(candidates[0])
            .rotate()
            .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
            .png({ quality: 90 })
            .toBuffer();
          const stripped = await removeBackgroundWithMagickBuffer(buf, { keyColor, fuzzPct });
          await fs.promises.writeFile(outPath, stripped || buf);
        }
      } else {
        // Attempt external rasterization toolchain
        const ok = await rasterizeWithExternal(input, outPath);
        if (!ok) {
          // Rethrow; cannot generate preview
          throw err;
        }
      }
    } else {
      throw err;
    }
  }
  return outPath;
}

function which(cmd) {
  const isWin = process.platform === 'win32';
  const envPath = process.env.PATH || '';
  const exts = isWin ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];

  // Common ImageMagick installation paths - check these FIRST before system PATH
  // This prevents Windows system32\convert.exe (FAT to NTFS tool) from being found
  const imageMagickPaths = isWin ? [] : [];
  if (isWin) {
    // Dynamically find ImageMagick installations in Program Files
    const programFiles = ['C:\\Program Files', 'C:\\Program Files (x86)'];
    for (const pf of programFiles) {
      try {
        const dirs = fs.readdirSync(pf).filter(d => d.toLowerCase().startsWith('imagemagick'));
        for (const dir of dirs) {
          imageMagickPaths.push(path.join(pf, dir));
        }
      } catch (_) {}
    }
    // Add common hardcoded paths as fallback
    imageMagickPaths.push('C:\\Program Files\\ImageMagick-7.1.1-Q16-HDRI');
    imageMagickPaths.push('C:\\Program Files\\ImageMagick-7.1.0-Q16-HDRI');
    imageMagickPaths.push('C:\\Program Files\\ImageMagick');
  }

  const commonPaths = isWin
    ? imageMagickPaths
    : ['/usr/local/bin', '/opt/homebrew/bin', '/opt/local/bin', '/usr/bin'];

  // Check ImageMagick/common paths FIRST, then system PATH
  // This ensures we find the real ImageMagick before Windows system32\convert.exe
  const systemPaths = envPath.split(path.delimiter).filter(p => {
    // On Windows, skip system32 when looking for 'convert' to avoid the FAT/NTFS tool
    if (isWin && cmd.toLowerCase() === 'convert' && p.toLowerCase().includes('system32')) {
      return false;
    }
    return true;
  });
  const allPaths = [...new Set([...commonPaths, ...systemPaths])];

  for (const p of allPaths) {
    if (!p) continue;
    for (const ext of exts) {
      const full = path.join(p, isWin ? cmd + ext : cmd);
      if (fs.existsSync(full)) return full;
    }
  }
  return null;
}

async function execFileSafe(cmd, args, opts) {
  return new Promise((resolve) => {
    const child = cp.execFile(cmd, args, { windowsHide: true, ...opts }, (error, stdout, stderr) => {
      resolve({ error, stdout, stderr, code: error ? error.code : 0 });
    });
    if (child && child.stdin) child.stdin.end();
  });
}

async function rasterizeWithExternal(input, outPath) {
  try { fs.mkdirSync(path.dirname(outPath), { recursive: true }); } catch (_) {}
  const magick = which('magick') || which('convert');
  if (magick) {
    // density improves quality; [0] ensures first page
    const args = [input + '[0]', '-density', '220', '-background', 'white', '-alpha', 'remove', '-alpha', 'off', '-resize', '1600x1600>', outPath];
    const { code } = await execFileSafe(magick, args);
    if (code === 0 && fs.existsSync(outPath)) return true;
  }
  const gs = which('gs') || which('gswin64c') || which('gswin32c');
  if (gs) {
    const tmpJpg = outPath; // direct render to final
    const args = ['-dSAFER', '-dBATCH', '-dNOPAUSE', '-sDEVICE=jpeg', '-dJPEGQ=82', '-r200', '-dFirstPage=1', '-dLastPage=1', `-sOutputFile=${tmpJpg}`, input];
    const { code } = await execFileSafe(gs, args);
    if (code === 0 && fs.existsSync(tmpJpg)) return true;
  }
  const pdftoppm = which('pdftoppm');
  if (pdftoppm && input.toLowerCase().endsWith('.pdf')) {
    const outPrefix = outPath.replace(/\.jpe?g$/i, '');
    const args = ['-singlefile', '-jpeg', '-scale-to', '1600', input, outPrefix];
    const { code } = await execFileSafe(pdftoppm, args);
    if (code === 0 && fs.existsSync(outPath)) return true;
  }
  return false;
}

async function computePhash(filePath) {
  const image = sharp(filePath).grayscale().resize(8, 8, { fit: 'fill' });
  const { data } = await image.raw().toBuffer({ resolveWithObject: true });
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i];
  const avg = sum / data.length;
  let bits = '';
  for (let i = 0; i < data.length; i++) bits += data[i] > avg ? '1' : '0';
  // Convert to hex string (16 hex chars for 64 bits)
  let hex = '';
  for (let i = 0; i < 64; i += 4) {
    const nibble = bits.slice(i, i + 4);
    hex += parseInt(nibble, 2).toString(16);
  }
  return hex;
}

function hammingDistanceHex(a, b) {
  if (!a || !b) return Infinity;
  const x = BigInt('0x' + a) ^ BigInt('0x' + b);
  let count = 0n;
  let y = x;
  while (y) { y &= y - 1n; count++; }
  return Number(count);
}

function findNearestPhash(phash, existing, threshold = 6) {
  let min = Infinity; let id = null;
  for (const row of existing) {
    if (!row.phash) continue;
    const d = hammingDistanceHex(phash, row.phash);
    if (d < min) { min = d; id = row.id; }
    if (min === 0) break;
  }
  return { near: Number.isFinite(min) && min <= threshold, id, distance: min };
}

function suggestTags(text) {
  if (!text) return [];
  const cleaned = String(text).toLowerCase().replace(/[^a-z0-9\s#&+/-]/g, ' ');
  const words = cleaned.split(/\s+/).filter(Boolean);
  const stop = new Set(['the','and','for','with','this','that','from','your','you','are','but','not','all','one','two','three','four','five','six','seven','eight','nine','ten','a','an','of','to','in','on','by','at','it','is','be','as','or']);
  const counts = new Map();
  for (const w of words) {
    if (w.length < 3) continue;
    if (stop.has(w)) continue;
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  return Array.from(counts.entries()).sort((a,b) => b[1]-a[1]).slice(0, 8).map(([w]) => w);
}

async function removeBackgroundWithMagickBuffer(buffer, { keyColor = '#ffffff', fuzzPct = 10 } = {}) {
  const magick = which('magick') || which('convert');
  if (!magick) {
    console.warn('[RemoveBg] ImageMagick not found in PATH');
    return null;
  }
  console.log('[RemoveBg] Using ImageMagick at:', magick);
  const tmpIn = path.join(os.tmpdir(), `bgstrip-in-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  const tmpOut = path.join(os.tmpdir(), `bgstrip-out-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  await fs.promises.writeFile(tmpIn, buffer);
  const args = [tmpIn, '-fuzz', `${Math.max(0, Math.min(100, Number(fuzzPct) || 10))}%`, '-transparent', keyColor || '#ffffff', 'PNG32:' + tmpOut];
  console.log('[RemoveBg] Running:', magick, args.join(' '));
  const { code, error, stderr } = await execFileSafe(magick, args);
  if (code !== 0 || !fs.existsSync(tmpOut)) {
    console.warn('[RemoveBg] Failed:', { code, error: error?.message, stderr });
    try { fs.unlinkSync(tmpIn); } catch (_) {}
    try { fs.unlinkSync(tmpOut); } catch (_) {}
    return null;
  }
  console.log('[RemoveBg] Success - output at:', tmpOut);
  const outBuf = await fs.promises.readFile(tmpOut);
  try { fs.unlinkSync(tmpIn); } catch (_) {}
  try { fs.unlinkSync(tmpOut); } catch (_) {}
  return outBuf;
}

async function boostWhitesWithMagickBuffer(buffer, { whitesFloor = 92 } = {}) {
  const magick = which('magick') || which('convert');
  if (!magick) return null;
  const tmpIn = path.join(os.tmpdir(), `boost-in-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  const tmpOut = path.join(os.tmpdir(), `boost-out-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  await fs.promises.writeFile(tmpIn, buffer);
  const floor = Math.max(80, Math.min(98, Number(whitesFloor) || 92));
  // Push upper tones to pure white while preserving alpha
  const args = [tmpIn, '-colorspace', 'sRGB', '-channel', 'RGB', '-level', `${floor}%`, '100%', '+channel', 'PNG32:' + tmpOut];
  const { code } = await execFileSafe(magick, args);
  if (code !== 0 || !fs.existsSync(tmpOut)) {
    try { fs.unlinkSync(tmpIn); } catch (_) {}
    try { fs.unlinkSync(tmpOut); } catch (_) {}
    return null;
  }
  const outBuf = await fs.promises.readFile(tmpOut);
  try { fs.unlinkSync(tmpIn); } catch (_) {}
  try { fs.unlinkSync(tmpOut); } catch (_) {}
  return outBuf;
}

async function generateMockupForRow(row, { background, outDir, widthPct = 40, yOffsetPct = 0, removeBg = false } = {}) {
  const bgMeta = await sharp(background).metadata();
  const bgW = bgMeta.width || 2000;
  const targetW = Math.round((Math.max(10, Math.min(150, Number(widthPct))) / 100) * bgW);
  const yOffset = Math.round(((Number.isFinite(yOffsetPct) ? yOffsetPct : 0) / 100) * (bgMeta.height || 2000));
  const preview = row.optimized_path || (await optimizePreview(row));
  // Allow upscaling here for small source previews
  let design = await sharp(preview).resize({ width: targetW }).toBuffer();
  if (removeBg) {
    try {
      const stripped = await removeBackgroundWithMagickBuffer(design, {});
      if (stripped) design = stripped;
    } catch (_) {}
  }
  const designMeta = await sharp(design).metadata();
  const left = Math.max(0, Math.round((bgW - (designMeta.width || targetW)) / 2));
  const top = Math.max(0, Math.round(((bgMeta.height || 2000) - (designMeta.height || targetW)) / 2 + yOffset));
  const out = path.join(outDir, `${sanitizeSegment(row.title || 'mockup')}-mockup.jpg`);
  await sharp(background)
    .composite([{ input: design, top, left }])
    .jpeg({ quality: 88 })
    .toFile(out);
  return out;
}

async function ensureTesseract() {
  if (tesseractWorker) return tesseractWorker;
  const { createWorker } = require('tesseract.js');
  const worker = await createWorker();
  await worker.loadLanguage('eng');
  await worker.initialize('eng');
  tesseractWorker = worker;
  return worker;
}

async function performOcr(imagePath) {
  const worker = await ensureTesseract();
  const { data } = await worker.recognize(imagePath);
  const raw = String(data?.text || '').trim();
  // Normalize whitespace, keep to a reasonable length
  const normalized = raw.replace(/\s+/g, ' ').trim().slice(0, 240);
  return normalized;
}
async function scanDirectoryForItems(directory) {
  // Reuse local:scan logic without IPC
  const files = await (async function walk(dir) {
    const out = [];
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue;
        out.push(...(await walk(full)));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!SCAN_EXTENSIONS.has(ext)) continue;
        out.push(full);
      }
    }
    return out;
  })(directory);

  const groups = new Map();
  for (const file of files) {
    const dir = path.dirname(file);
    const base = path.basename(file, path.extname(file));
    const key = `${dir}__${base}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(file);
  }
  const existingPhashes = (localDb?.allPhashes?.() || []).filter((r) => r.phash);
  const results = [];
  for (const [_key, fileList] of groups.entries()) {
    try {
      const previewCandidate = (function pickPreview(candidates) {
        const priority = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.pdf', '.ai', '.eps'];
        const sorted = [...candidates].sort((a, b) => {
          const ea = priority.indexOf(path.extname(a).toLowerCase());
          const eb = priority.indexOf(path.extname(b).toLowerCase());
          return (ea === -1 ? 999 : ea) - (eb === -1 ? 999 : eb);
        });
        return sorted[0];
      })(fileList);
      const stat = await fs.promises.stat(previewCandidate);
      const hash = await new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        const rs = fs.createReadStream(previewCandidate);
        rs.on('error', reject);
        rs.on('data', (chunk) => h.update(chunk));
        rs.on('end', () => resolve(h.digest('hex')));
      });
      const parent = path.basename(path.dirname(previewCandidate));
      const base = path.basename(previewCandidate, path.extname(previewCandidate));
      const duplicate = Boolean(localDb?.findByHash(hash));
      const file_type = path.extname(previewCandidate).replace('.', '').toLowerCase();
      const sourcePaths = fileList.filter((p) => DOC_EXTENSIONS.has(path.extname(p).toLowerCase()) || VECTOR_EXTENSIONS.has(path.extname(p).toLowerCase()));
      let phash = null; let nearDuplicate = false; let nearOf = null;
      try {
        phash = await computePhash(previewCandidate);
        if (phash && existingPhashes.length) {
          const { near, id } = findNearestPhash(phash, existingPhashes, 6);
          nearDuplicate = near; nearOf = id || null;
        }
      } catch (_) {}
      results.push({ path: previewCandidate, sources: sourcePaths, category: parent, title: base, file_type, size: stat.size, hash, phash, duplicate, nearDuplicate, nearOf });
    } catch (_) {}
  }
  return results;
}

function applyWatchSettings(settings) {
  const cfg = settings || {};
  // Ensure local DB is available for watcher event handlers
  ensureLocalDb();
  watchConfig = cfg;
  if (fileWatcher) {
    try { fileWatcher.close(); } catch (_) {}
    fileWatcher = null;
  }
  const enabled = Boolean(cfg.watchEnabled) && typeof cfg.watchFolder === 'string' && cfg.watchFolder.trim();
  if (!enabled) return;
  const folder = cfg.watchFolder;
  fileWatcher = chokidar.watch(folder, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 500 },
    ignored: [/node_modules/, /\.git/, /uploads\//, /\.zip$/, /\.rar$/, /\.7z$/, /\.tar/, /\.gz$/],
    depth: 3  // Limit recursion depth to avoid scanning deep nested folders
  });

  // Debounce watcher to prevent overwhelming the system
  let watcherDebounceTimer = null;
  const pendingFiles = new Set();

  fileWatcher.on('add', (filePath) => {
    pendingFiles.add(filePath);
    if (watcherDebounceTimer) clearTimeout(watcherDebounceTimer);
    watcherDebounceTimer = setTimeout(() => processWatcherQueue(), 2000);
  });

  async function processWatcherQueue() {
    const files = [...pendingFiles];
    pendingFiles.clear();

    for (const filePath of files) {
      await processWatchedFile(filePath, cfg);
      // Small delay between files to prevent blocking
      await new Promise(r => setTimeout(r, 100));
    }
  }

  async function processWatchedFile(filePath, cfg) {
    try {
      const ext = path.extname(filePath).toLowerCase();
      if (!SCAN_EXTENSIONS.has(ext)) return;
      if (!cfg.watchAutoImport) return; // only auto if enabled
      const dir = path.dirname(filePath);
      const base = path.basename(filePath, path.extname(filePath));
      const siblings = (await fs.promises.readdir(dir))
        .map((n) => path.join(dir, n))
        .filter((p) => path.basename(p, path.extname(p)) === base);
      const scanned = await scanDirectoryForItems(dir);
      const match = scanned.find((x) => x.path === filePath || (x.title === base && path.dirname(x.path) === dir));
      if (!match) return;
      if (ensureLocalDb()?.findByHash(match.hash)) return; // skip exact dup
      const rec = ensureLocalDb().upsert({
        path: match.path,
        category: match.category,
        title: match.title,
        file_type: match.file_type,
        size: match.size,
        hash: match.hash,
        phash: match.phash || null,
        status: 'imported'
      });
      try { await optimizePreview(rec); } catch (_) {}
      if (cfg.watchOcr) {
        try {
          const text = await performOcr(rec.optimized_path || rec.path);
          const tags = suggestTags(text);
          ensureLocalDb().update(rec.id, {
            title: (!rec.title || /^img|^image|^scan/i.test(rec.title)) ? text : rec.title,
            tags: JSON.stringify(tags)
          });
        } catch (_) {}
      }
      if (cfg.watchAutoApprove) { try { ensureLocalDb().update(rec.id, { status: 'approved' }); } catch (_) {} }
      if (cfg.watchAutoMockup && cfg.watchMockupBackground && cfg.watchMockupOutputDir) {
        try {
          await generateMockupForRow(rec, {
            background: cfg.watchMockupBackground,
            outDir: cfg.watchMockupOutputDir,
            widthPct: Number(cfg.watchMockupWidthPct) || 40,
            yOffsetPct: Number(cfg.watchMockupYOffsetPct) || 0,
            removeBg: true
          });
        } catch (_) {}
      }
    } catch (err) {
      console.warn('Watch import failed:', err?.message || err);
    }
  }
}
