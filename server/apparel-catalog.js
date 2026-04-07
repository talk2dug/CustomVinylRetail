const fs = require('fs');
const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..');
const PRODUCTS_DIR = path.join(APP_ROOT, 'Products');
const SKU_IMAGE_CANDIDATES_FILE = 'sku-to-alldayshirts-image-url-candidates.csv';
const STYLE_IMAGE_CANDIDATES_FILE = 'alldayshirts-cdn-image-url-candidates.csv';
const PATHS = require('./paths');
const PRODUCT_IMAGES_DIR = PATHS.PRODUCT_IMAGES_DIR;

const PRODUCT_FILE_TYPES = {
  'bella-canvas-4610c-unisex-heavyweight-t-shirt-skus.csv': 'tshirt',
  'district-dt6100-skus-and-images.csv': 'hoodie',
  'next-level-9300-adult-pch-pullover-hoody-skus.csv': 'hoodie',
  'paragon-221y-youth-bahama-performance-hooded-long-sleeve-t-shirt-skus.csv': 'hoodie',
  'liberty-bags-ft007-neoprene-can-holder-skus.csv': 'accessory',
  'intrepid-40oz-tumbler-skus.csv': 'drinkware',
  'otto-39-165-skus.csv': 'hat',
  'otto-cap-31-069-5-panel-mid-profile-baseball-cap-skus.csv': 'hat',
  'port-authority-c939-knit-cuff-beanie-skus.csv': 'beanie',
  'port-authority-cp91-skus.csv': 'beanie',
  'port-authority-c910-r-tek-stretch-fleece-headband-skus.csv': 'headband'
};

const IMAGE_TIMEOUT_MS = Number(process.env.APPAREL_IMAGE_TIMEOUT_MS) || 2500;
const LOGOUP_CDN_PATTERN = /assets-cdn\.logoup\.com/i;
const domainFailureCache = new Map();

function isHttpUrl(url) {
  return /^https?:\/\//i.test(String(url || '').trim());
}

function expandCandidateUrls(values = []) {
  const expanded = [];
  values
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean)
    .forEach((value) => {
      if (!expanded.includes(value)) {
        expanded.push(value);
      }
      if (LOGOUP_CDN_PATTERN.test(value)) {
        const encoded = encodeURIComponent(value);
        const rewrites = [
          `https://logoup.com/cdn-cgi/image/width=900,quality=85,format=auto/${encoded}`,
          `https://logoup.com/cdn-cgi/image/width=600,quality=85,format=auto/${encoded}`
        ];
        rewrites.forEach((rewrite) => {
          if (!expanded.includes(rewrite)) {
            expanded.push(rewrite);
          }
        });
      }
    });
  return expanded;
}

async function makeRequest(url, method) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method,
      redirect: 'follow',
      signal: controller.signal
    });
    return {
      ok: response.ok,
      status: response.status,
      url,
      method
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      url,
      method,
      error: error.name === 'AbortError' ? 'timeout' : error.message
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function attemptUrl(url) {
  const attempts = [];
  attempts.push(await makeRequest(url, 'HEAD'));
  const first = attempts[0];
  const shouldRetryWithGet =
    !first.ok &&
    (!first.status || [400, 401, 403, 404, 405, 500, 502, 503].includes(first.status));
  if (shouldRetryWithGet) {
    attempts.push(await makeRequest(url, 'GET'));
  }
  const finalResult = { ...attempts[attempts.length - 1], attempts: attempts.length };
  if (!finalResult.ok && !finalResult.error && !finalResult.status && first.error) {
    finalResult.error = first.error;
  }
  return finalResult;
}

async function checkUrl(url, cache) {
  const normalized = String(url || '').trim();
  if (!isHttpUrl(normalized)) {
    return { ok: false, url: normalized, error: 'invalid_url', attempts: 0 };
  }
  let hostname = null;
  try {
    hostname = new URL(normalized).hostname;
  } catch (error) {
    hostname = null;
  }
  if (hostname && domainFailureCache.has(hostname)) {
    const cachedDomainFailure = domainFailureCache.get(hostname);
    return { ...cachedDomainFailure, url: normalized };
  }
  if (cache.has(normalized)) {
    const cached = cache.get(normalized);
    return { ...cached };
  }
  const result = await attemptUrl(normalized);
  if (!result.ok && result.status === 403 && hostname) {
    domainFailureCache.set(hostname, {
      ok: false,
      status: 403,
      error: result.error || 'status_403',
      attempts: result.attempts,
      hostname
    });
  }
  cache.set(normalized, { ...result });
  return { ...result };
}

let cachedCatalog = null;
let loadingPromise = null;

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function normalizeProductUrl(value) {
  if (!value) return null;
  try {
    const { hostname, pathname } = new URL(String(value).trim());
    return `${hostname}${pathname}`.toLowerCase();
  } catch (error) {
    return String(value || '').trim().toLowerCase() || null;
  }
}

function extractSlugFromUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value).trim());
    return url.pathname.replace(/^\/+|\/+$/g, '').toLowerCase();
  } catch (error) {
    return String(value || '').trim().toLowerCase() || null;
  }
}

function normalizeHandle(value) {
  return String(value || '').trim().toLowerCase() || null;
}

function encodePathSegment(segment) {
  return encodeURIComponent(String(segment || '').trim());
}

function buildProductImagePath(dirName, fileName) {
  if (!dirName || !fileName) return null;
  return `/productimages/${encodePathSegment(dirName)}/${encodePathSegment(fileName)}`;
}

function parseCsv(content) {
  if (!content) return [];
  const rows = [];
  let current = '';
  let inQuotes = false;
  let value = '';

  const pushValue = () => {
    rows[rows.length - 1].push(value);
    value = '';
  };

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    if (rows.length === 0) {
      rows.push([]);
    }

    if (inQuotes) {
      if (char === '"') {
        const nextChar = content[i + 1];
        if (nextChar === '"') {
          value += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        value += char;
      }
      continue;
    }

    if (char === '\r') {
      continue;
    }

    if (char === '\n') {
      pushValue();
      rows.push([]);
      continue;
    }

    if (char === ',') {
      pushValue();
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    value += char;
  }

  if (rows.length) {
    rows[rows.length - 1].push(value);
  }

  return rows.filter((row) => row.some((cell) => cell && cell.trim().length));
}

function normalizeColor(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function normalizeStyle(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '')
    .toUpperCase();
}

function deriveStyleFromSku(sku, handle, title) {
  if (sku) {
    const parts = sku.split('-');
    if (parts.length >= 3 && /^\d+$/.test(parts[1]) && /^\d+$/.test(parts[2])) {
      return normalizeStyle(`${parts[1]}-${parts[2]}`);
    }
    if (parts.length >= 2) {
      return normalizeStyle(parts[1]);
    }
  }
  if (handle) {
    const parts = handle.split('-');
    if (parts.length >= 2) {
      return normalizeStyle(parts[1]);
    }
  }
  if (title) {
    const match = title.match(/([A-Za-z0-9]+-?[A-Za-z0-9]+)$/);
    if (match) {
      return normalizeStyle(match[1]);
    }
  }
  return null;
}

function splitCandidates(value) {
  if (!value) return [];
  return value
    .split('|')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function buildSkuCandidateMap() {
  const filePath = path.join(PRODUCTS_DIR, SKU_IMAGE_CANDIDATES_FILE);
  const content = readFileSafe(filePath);
  if (!content) return new Map();
  const rows = parseCsv(content);
  if (!rows.length) return new Map();
  const header = rows[0];
  const indexByName = (name) => header.indexOf(name);
  const handleIndex = indexByName('Handle');
  const titleIndex = indexByName('Title');
  const skuIndex = indexByName('Variant SKU');
  const colorIndex = indexByName('Color');
  const sizeIndex = indexByName('Size');
  const candidateIndex = indexByName('Candidate URLs (ordered)');
  const productUrlIndex = indexByName('Product URL');

  const map = new Map();

  rows.slice(1).forEach((row) => {
    const sku = row[skuIndex]?.trim();
    if (!sku) return;
    map.set(sku, {
      handle: row[handleIndex]?.trim() || null,
      title: row[titleIndex]?.trim() || null,
      color: row[colorIndex]?.trim() || null,
      size: row[sizeIndex]?.trim() || null,
      candidates: splitCandidates(row[candidateIndex]),
      productUrl: row[productUrlIndex]?.trim() || null
    });
  });

  return map;
}

function buildStyleCandidateMap() {
  const filePath = path.join(PRODUCTS_DIR, STYLE_IMAGE_CANDIDATES_FILE);
  const content = readFileSafe(filePath);
  if (!content) return new Map();
  const rows = parseCsv(content);
  if (!rows.length) return new Map();
  const header = rows[0];
  const styleIndex = header.indexOf('Style');
  const colorIndex = header.indexOf('Color');
  const underscoreIndex = header.indexOf('Candidate URL (underscore)');
  const hyphenIndex = header.indexOf('Candidate URL (hyphen)');

  const map = new Map();

  rows.slice(1).forEach((row) => {
    const style = normalizeStyle(row[styleIndex]);
    const color = normalizeColor(row[colorIndex]);
    if (!style || !color) return;
    const key = `${style}|${color}`;
    if (!map.has(key)) {
      map.set(key, new Set());
    }
    const set = map.get(key);
    [row[underscoreIndex], row[hyphenIndex]].forEach((candidate) => {
      if (candidate && candidate.trim()) {
        set.add(candidate.trim());
      }
    });
  });

  const result = new Map();
  for (const [key, set] of map.entries()) {
    result.set(key, Array.from(set));
  }
  return result;
}

function loadProductImageLibrary() {
  const library = {
    byUrl: new Map(),
    bySlug: new Map(),
    byHandle: new Map()
  };
  if (!fs.existsSync(PRODUCT_IMAGES_DIR)) {
    return library;
  }

  const dirEntries = fs.readdirSync(PRODUCT_IMAGES_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  dirEntries.forEach((entry) => {
    const dirName = entry.name;
    const dirPath = path.join(PRODUCT_IMAGES_DIR, dirName);
    const manifestPath = path.join(dirPath, 'images.json');
    if (!fs.existsSync(manifestPath)) return;

    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      console.warn(`Unable to parse ${manifestPath}:`, error.message);
      return;
    }

    const selected = Array.isArray(manifest.selected) ? manifest.selected.filter(isHttpUrl) : [];
    const allCandidates = Array.isArray(manifest.allCandidates)
      ? manifest.allCandidates
          .map((candidate) => candidate?.url)
          .filter(isHttpUrl)
      : [];

    const localFiles = fs
      .readdirSync(dirPath)
      .filter((file) => /\.(jpe?g|png|webp)$/i.test(file));

    const localByName = new Map();
    const localByNormalized = new Map();
    localFiles.forEach((file) => {
      const key = file.toLowerCase();
      const normalized = key.replace(/[-_]/g, '');
      const localPath = buildProductImagePath(dirName, file);
      localByName.set(key, localPath);
      if (!localByNormalized.has(normalized)) {
        localByNormalized.set(normalized, localPath);
      }
    });

    const local = [];
    const remote = [];

    const appendLocalMatch = (url) => {
      try {
        const base = path.basename(new URL(url).pathname).toLowerCase();
        if (localByName.has(base)) {
          const localPath = localByName.get(base);
          if (localPath && !local.includes(localPath)) {
            local.push(localPath);
          }
          return true;
        }
        const normalizedBase = base.replace(/[-_]/g, '');
        if (normalizedBase && localByNormalized.has(normalizedBase)) {
          const localPath = localByNormalized.get(normalizedBase);
          if (localPath && !local.includes(localPath)) {
            local.push(localPath);
          }
          return true;
        }
      } catch (_) {
        // ignore URL parse errors
      }
      return false;
    };

    selected.forEach((url) => {
      if (!appendLocalMatch(url) && !remote.includes(url)) {
        remote.push(url);
      }
    });

    allCandidates.forEach((url) => {
      if (!appendLocalMatch(url) && !remote.includes(url)) {
        remote.push(url);
      }
    });

    const normalizedRecord = {
      sourceUrl: manifest.sourceUrl || null,
      local,
      remote,
      dirName
    };

    if (manifest.sourceUrl) {
      const normalizedUrl = normalizeProductUrl(manifest.sourceUrl);
      if (normalizedUrl) {
        library.byUrl.set(normalizedUrl, normalizedRecord);
      }
      const slug = extractSlugFromUrl(manifest.sourceUrl);
      if (slug) {
        library.bySlug.set(slug, normalizedRecord);
        library.byHandle.set(slug, normalizedRecord);
      }
    }

    const derivedHandle = dirName.replace(/^www-[^-]+-/, '').toLowerCase();
    if (derivedHandle) {
      library.byHandle.set(derivedHandle, normalizedRecord);
    }
  });

  return library;
}

function findProductImageRecord(library, { productUrl, handle }) {
  if (!library) return null;
  const byUrlKey = normalizeProductUrl(productUrl);
  if (byUrlKey && library.byUrl.has(byUrlKey)) {
    return library.byUrl.get(byUrlKey);
  }
  const slugFromUrl = extractSlugFromUrl(productUrl);
  if (slugFromUrl && library.bySlug.has(slugFromUrl)) {
    return library.bySlug.get(slugFromUrl);
  }
  const normalizedHandle = normalizeHandle(handle);
  if (normalizedHandle && library.byHandle.has(normalizedHandle)) {
    return library.byHandle.get(normalizedHandle);
  }
  return null;
}

function pickFallbackImage(record) {
  if (!record) return null;
  if (Array.isArray(record.local) && record.local.length) {
    return { url: record.local[0], type: 'local' };
  }
  if (Array.isArray(record.remote) && record.remote.length) {
    return { url: record.remote[0], type: 'remote' };
  }
  return null;
}

async function loadProductFile(fileName, skuCandidates, styleCandidates, productImages) {
  const filePath = path.join(PRODUCTS_DIR, fileName);
  const content = readFileSafe(filePath);
  if (!content) return [];
  const rows = parseCsv(content);
  if (!rows.length) return [];
  const header = rows[0];

  const indexByName = (name) => header.indexOf(name);
  const handleIndex = indexByName('Handle');
  const titleIndex = indexByName('Title');
  const vendorIndex = indexByName('Vendor');
  const skuIndex = indexByName('Variant SKU');
  const option1NameIndex = indexByName('Option1 Name');
  const option1ValueIndex = indexByName('Option1 Value');
  const option2NameIndex = indexByName('Option2 Name');
  const option2ValueIndex = indexByName('Option2 Value');
  const option3NameIndex = indexByName('Option3 Name');
  const option3ValueIndex = indexByName('Option3 Value');
  const imageIndex = header.findIndex((name) =>
    name && /image src/i.test(name)
  );
  const colorUrlIndex = indexByName('Color Page URL');
  const productUrlIndex = indexByName('Product URL');

  const productType = PRODUCT_FILE_TYPES[fileName] || 'apparel';

  const products = new Map();

  rows.slice(1).forEach((row) => {
    if (!row.length) return;
    const handle = row[handleIndex]?.trim();
    const title = row[titleIndex]?.trim();
    const vendor = row[vendorIndex]?.trim();
    const sku = row[skuIndex]?.trim();
    if (!handle || !title || !sku) return;

    const options = {};
    const optionColumns = [
      [row[option1NameIndex], row[option1ValueIndex]],
      [row[option2NameIndex], row[option2ValueIndex]],
      [row[option3NameIndex], row[option3ValueIndex]]
    ];
    optionColumns.forEach(([name, value]) => {
      if (!name || !value) return;
      const key = String(name).toLowerCase();
      options[key] = value.trim();
    });

    const color = options.color || options.colour || null;
    const size = options.size || null;

    const style = deriveStyleFromSku(sku, handle, title);
    const primaryImage = imageIndex >= 0 ? row[imageIndex]?.trim() : null;
    const candidateRecord = skuCandidates.get(sku) || null;
    const candidateUrls = candidateRecord?.candidates || [];
    const productUrl =
      row[colorUrlIndex]?.trim() || row[productUrlIndex]?.trim() || candidateRecord?.productUrl || null;
    const candidateFromStyle = style
      ? styleCandidates.get(`${style}|${normalizeColor(color)}`) || []
      : [];

    if (!products.has(handle)) {
      products.set(handle, {
        handle,
        title,
        vendor,
        productType,
        style,
        variants: []
      });
    }

    products.get(handle).variants.push({
      sku,
      handle,
      style,
      productType,
      title,
      vendor,
      color,
      size,
      imageUrl: primaryImage || null,
      productUrl,
      candidateUrls: [...candidateUrls, ...candidateFromStyle],
      colorPageUrl: row[colorUrlIndex]?.trim() || null
    });
  });

  const checkedUrlCache = new Map();

  for (const product of products.values()) {
    for (const variant of product.variants) {
      const imageRecord = findProductImageRecord(productImages, {
        productUrl: variant.productUrl,
        handle: variant.handle || product.handle
      });

      if (imageRecord?.local?.length) {
        variant.imageUrl = imageRecord.local[0];
        variant.imageStatus = {
          ok: true,
          status: 200,
          error: 'local_image',
          attempts: 0
        };
        delete variant.candidateUrls;
        continue;
      }

      const candidateSet = new Set();
      if (imageRecord?.remote?.length) {
        imageRecord.remote.forEach((url) => {
          if (isHttpUrl(url)) {
            candidateSet.add(url);
          }
        });
      }
      expandCandidateUrls([
        variant.imageUrl,
        ...(variant.candidateUrls || [])
      ])
        .filter(isHttpUrl)
        .forEach((url) => candidateSet.add(url));

      const candidates = Array.from(candidateSet).slice(0, 2);

      const attemptDetails = [];
      let resolved = null;
      for (const candidate of candidates) {
        const result = await checkUrl(candidate, checkedUrlCache);
        attemptDetails.push({ ...result });
        if (result.ok) {
          resolved = result;
          break;
        }
      }

      if (resolved) {
        variant.imageUrl = resolved.url;
        variant.imageStatus = {
          ok: true,
          status: resolved.status ?? null,
          attempts: attemptDetails.length
        };
      } else {
        variant.imageUrl = null;
        const lastAttempt = attemptDetails.at(-1) || null;
        variant.imageStatus = {
          ok: false,
          status: lastAttempt?.status ?? null,
          error:
            lastAttempt?.error ||
            (attemptDetails.length
              ? `status_${lastAttempt?.status ?? 'unknown'}`
              : imageRecord?.remote?.length
              ? 'json_image_unavailable'
              : 'no_candidates'),
          attempts: attemptDetails.length
        };

        if (!variant.imageUrl && imageRecord?.remote?.length) {
          variant.imageUrl = imageRecord.remote[0];
          variant.imageStatus = {
            ok: true,
            status: 200,
            error: 'json_image',
            attempts: attemptDetails.length
          };
        }
      }

      delete variant.candidateUrls;
    }

    product.variants = product.variants.filter(
      (variant) => variant.productUrl || variant.imageUrl
    );
  }

  return Array.from(products.values());
}

async function loadApparelCatalog() {
  if (cachedCatalog) return cachedCatalog;
  if (loadingPromise) {
    return loadingPromise;
  }

  loadingPromise = (async () => {
    const skuCandidates = buildSkuCandidateMap();
    const styleCandidates = buildStyleCandidateMap();
    const productImages = loadProductImageLibrary();

    const productFiles = fs.readdirSync(PRODUCTS_DIR)
      .filter((file) => file.endsWith('.csv'))
      .filter((file) =>
        file !== SKU_IMAGE_CANDIDATES_FILE &&
        file !== STYLE_IMAGE_CANDIDATES_FILE &&
        PRODUCT_FILE_TYPES[file]
      );

    const products = [];
    for (const file of productFiles) {
      const entries = await loadProductFile(file, skuCandidates, styleCandidates, productImages);
      products.push(...entries);
    }

    cachedCatalog = {
      products: products.map((product) => ({
        ...product,
        variants: product.variants.map((variant) => ({
          sku: variant.sku,
          color: variant.color,
          size: variant.size,
          imageUrl: variant.imageUrl || null,
          productUrl: variant.productUrl || null,
          colorPageUrl: variant.colorPageUrl || null,
          imageStatus: variant.imageStatus || null,
          productType: product.productType,
          vendor: product.vendor,
          title: product.title,
          handle: product.handle,
          style: product.style
        }))
      })),
      generatedAt: new Date().toISOString()
    };
    return cachedCatalog;
  })()
    .catch((error) => {
      console.error('Unable to load apparel catalog:', error);
      cachedCatalog = { products: [], generatedAt: new Date().toISOString() };
      return cachedCatalog;
    });

  return loadingPromise;
}

module.exports = {
  loadApparelCatalog
};
