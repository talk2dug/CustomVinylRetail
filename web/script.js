const DEFAULT_RENDER_LIMIT = 32;
const RENDER_INCREMENT = 32;
const PIXELS_PER_INCH = 20;
const CURVE_THRESHOLD = 1;

const COLOR_PALETTES = [
  {
    id: 'regular-vinyl',
    label: 'Regular decal vinyl',
    description: 'Regular decal vinyl palette · approx. 10 ft on hand per color.',
    colors: [
      { name: 'Optic White', value: '#FFFFFF' },
      { name: 'Crystal White', value: '#FEFEFE' },
      { name: 'Charcoal Black', value: '#201F1D' },
      { name: 'Steel Gray', value: '#6A6B76' },
      { name: 'Warm Gray', value: '#DEDEDC' },
      { name: 'Frost Glaze', value: '#FDFCFD' },
      { name: 'Sage Gray', value: '#89938E' },
      { name: 'Coral Rose', value: '#E66C74' },
      { name: 'Silver Mist', value: '#CBCBCD' },
      { name: 'Golden Sand', value: '#E4C679' },
      { name: 'Copper Clay', value: '#A7765C' },
      { name: 'Plum Slate', value: '#4F4454' },
      { name: 'Soft White', value: '#F2F2F2' },
      { name: 'Dusty Mauve', value: '#B19EA6' },
      { name: 'Ivory Lace', value: '#FFFEFD' },
      { name: 'Arctic Gray', value: '#E9E9E9' },
      { name: 'Skyline Blue', value: '#74B6D1' },
      { name: 'Crimson Red', value: '#B72020' },
      { name: 'Pearl White', value: '#F9F8F8' },
      { name: 'Pacific Blue', value: '#4D8BBD' },
      { name: 'Lilac Smoke', value: '#B9AEC6' },
      { name: 'Violet Frost', value: '#9878B1' },
      { name: 'Champagne', value: '#E6DAAD' },
      { name: 'Seafoam', value: '#A0D6D8' },
      { name: 'Snow Drift', value: '#FFFFFE' },
      { name: 'Blush Pink', value: '#F2B8D0' },
      { name: 'Royal Sapphire', value: '#0D4B9D' },
      { name: 'Harvest Gold', value: '#DAAD28' },
      { name: 'Petal Pink', value: '#FAE4E6' }
    ]
  },
  {
    id: 'heat-transfer',
    label: 'Heat transfer vinyl',
    description:
      'Heat transfer vinyl palette · approx. 5 ft on hand per color (with 50 ft apparel reserves for yellow, red, blue, white, and black).',
    colors: [
      { name: 'Bright White', value: '#F6F6F6' },
      { name: 'Soft Sand', value: '#F2DFA0' },
      { name: 'Goldenrod', value: '#E3B552' },
      { name: 'Navy Steel', value: '#183D5C' },
      { name: 'Deep Midnight', value: '#0C1C35' },
      { name: 'Sunburst Yellow', value: '#EFD01C' },
      { name: 'Slate Blue', value: '#4A546E' },
      { name: 'Copper Orange', value: '#DE7E1E' },
      { name: 'Mauve Ash', value: '#C2AEAE' },
      { name: 'Fire Red', value: '#C72B1B' },
      { name: 'Lavender Mist', value: '#DBCED9' },
      { name: 'Storm Gray', value: '#7D8694' },
      { name: 'Royal Blue', value: '#176BC6' },
      { name: 'Bronze', value: '#A18755' },
      { name: 'Evergreen', value: '#2B8B60' },
      { name: 'Oxblood', value: '#7E0908' },
      { name: 'Chestnut', value: '#6D5029' },
      { name: 'Rose Pink', value: '#E1667E' },
      { name: 'Sky Blue', value: '#6AAEDF' },
      { name: 'Lime Green', value: '#61CA61' }
    ]
  }
];

function getPaletteById(id) {
  return (
    COLOR_PALETTES.find((palette) => palette.id === id) ||
    COLOR_PALETTES[0] ||
    { id: 'default', label: 'Default palette', description: '', colors: [{ name: 'Black', value: '#000000' }] }
  );
}

const DEFAULT_PALETTE = getPaletteById('regular-vinyl');
const DEFAULT_SELECTED_COLOR = (
  DEFAULT_PALETTE.colors[0]?.value || '#000000'
).toLowerCase();

const USD_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD'
});

const STICKER_PRICE_TABLE = {
  3: { 1: 350, 2: 375, 3: 400, 4: 425 },
  4: { 1: 375, 2: 425, 3: 450, 4: 500 },
  6: { 1: 425, 2: 500, 3: 575, 4: 700 }
};

const LASER_PRICE_CENTS = 1500;
const SHIPPING_STICKER_CENTS = 300;
const SHIPPING_LASER_CENTS = 500;
const GARMENT_COST_CENTS = {
  tshirt: 350,
  hoodie: 1500,
  hat: 300,
  beanie: 375,
  headband: 200,
  accessory: 400,
  drinkware: 850
};
const VINYL_COST_PER_SQFT_DOLLARS = 4 / 1200; // $4 per 1200 sqft roll
const APPAREL_VINYL_USAGE_SQFT = {
  tshirt: 1, // assumed coverage per garment
  hoodie: 1.2,
  hat: 0.5,
  beanie: 0.45,
  headband: 0.25,
  accessory: 0.35,
  drinkware: 0.6
};
const LABOR_RATE_PER_HOUR = 50;
const LABOR_MINUTES_PER_ITEM = 10;
const LABOR_COST_PER_ITEM_CENTS = Math.round(
  (LABOR_RATE_PER_HOUR / 60) * LABOR_MINUTES_PER_ITEM * 100
);
const PROFIT_MARGIN = 0.3;
const COLOR_ADDON_CENTS = 100;
const APPAREL_ALLOWED_COLORS = ['1', '2', '3', '4'];
const STORE_SELECTION_KEY = 'storeSelection';

function calculateApparelUnitPriceCents(productType, colorCount) {
  const garmentCost = GARMENT_COST_CENTS[productType] ?? 0;
  const vinylUsage = APPAREL_VINYL_USAGE_SQFT[productType] ?? 0;
  const vinylCostCents = Math.round(vinylUsage * VINYL_COST_PER_SQFT_DOLLARS * 100);
  const baseCostCents = garmentCost + vinylCostCents + LABOR_COST_PER_ITEM_CENTS;
  const profitAdjustedCents = Math.round(baseCostCents * (1 + PROFIT_MARGIN));
  const extraColors = Math.max(0, Number(colorCount || 1) - 1);
  return roundUpToQuarterDollar(profitAdjustedCents + extraColors * COLOR_ADDON_CENTS);
}

const FONT_OPTIONS = [
  { label: 'Font Awesome Solid', value: '"Font Awesome 6 Free"' },
  { label: 'Font Awesome Brands', value: '"Font Awesome 6 Brands"' },
  { label: 'Barlow', value: '"Barlow", sans-serif' },
  { label: 'Montserrat', value: '"Montserrat", sans-serif' },
  { label: 'Raleway', value: '"Raleway", sans-serif' },
  { label: 'Oswald', value: '"Oswald", sans-serif' },
  { label: 'Roboto Slab', value: '"Roboto Slab", serif' },
  { label: 'Playfair Display', value: '"Playfair Display", serif' },
  { label: 'Pacifico', value: '"Pacifico", cursive' },
  { label: 'Lobster', value: '"Lobster", cursive' },
  { label: 'Arial', value: 'Arial, sans-serif' }
];

function resolveSaveServerBase() {
  // Allow explicit override via ?server=... (e.g., http://localhost:4000)
  try {
    const url = new URL(window.location.href);
    const serverOverride = (url.searchParams.get('server') || '').trim();
    if (serverOverride) {
      try { return new URL(serverOverride).origin; } catch (_) { /* ignore invalid */ }
    }
  } catch (_) {}
  // Prefer current origin if http(s)
  try {
    const current = new URL(window.location.href);
    if (current.protocol === 'http:' || current.protocol === 'https:') {
      return current.origin;
    }
  } catch (_) {}
  // Fallback for file:// or other protocols — default to local save server
  return 'http://127.0.0.1:4000';
}

const SAVE_SERVER_BASE =
  window.__SAVE_SERVER_BASE__ || resolveSaveServerBase();

// Site-wide policy: disable file downloads from customer pages.
// Defaults to true unless explicitly overridden.
const DISABLE_DOWNLOADS = (typeof window !== 'undefined' && window.__DISABLE_DOWNLOADS__ !== undefined)
  ? Boolean(window.__DISABLE_DOWNLOADS__)
  : true;

function buildServerEndpoint(pathname = '/') {
  const normalizedPath =
    typeof pathname === 'string' && pathname.startsWith('/') ? pathname : `/${pathname || ''}`;
  try {
    const base = SAVE_SERVER_BASE.endsWith('/') ? SAVE_SERVER_BASE : `${SAVE_SERVER_BASE}/`;
    return new URL(normalizedPath.replace(/^\//, ''), base).toString();
  } catch (error) {
    const trimmedBase = SAVE_SERVER_BASE.replace(/\/+$/, '');
    return `${trimmedBase}${normalizedPath}`;
  }
}

const SAVE_ENDPOINT = buildServerEndpoint('/api/save-design');
const ORDER_CHECKOUT_ENDPOINT = (orderId) =>
  buildServerEndpoint(`/api/orders/${encodeURIComponent(orderId)}/checkout`);
const APPAREL_PRODUCTS_ENDPOINT = buildServerEndpoint('/api/apparel/products');
const SSAW_STYLES_ENDPOINT = buildServerEndpoint('/api/vendors/ssaw/styles');
const SSAW_PRODUCTS_ENDPOINT = buildServerEndpoint('/api/vendors/ssaw/products');
const SSAW_INVENTORY_ENDPOINT = buildServerEndpoint('/api/vendors/ssaw/inventory');
const SSAW_CONFIG_ENDPOINT = buildServerEndpoint('/api/vendors/ssaw/config');
const APPAREL_SIZE_SEQUENCE = [
  'YXS',
  'YSM',
  'YS',
  'YM',
  'YL',
  'YXL',
  '2XS',
  'XXS',
  'XS',
  'SM',
  'S',
  'MD',
  'M',
  'LG',
  'L',
  'XL',
  '1XL',
  '2XL',
  'XXL',
  '3XL',
  'XXXL',
  '4XL',
  'XXXXL',
  '5XL',
  '6XL',
  '7XL',
  'OS',
  'OSFM',
  'ONE',
  'ONESIZE',
  'ADULT',
  'YOUTH'
];

const APPAREL_PLACEHOLDERS = {
  tshirt: 'images/race-crew-shirt.jpg',
  hoodie: 'images/race-crew-shirt.jpg',
  hat: 'images/race-crew-shirt.jpg',
  beanie: 'images/race-crew-shirt.jpg',
  headband: 'images/race-crew-shirt.jpg',
  drinkware: 'images/race-crew-shirt.jpg',
  accessory: 'images/race-crew-shirt.jpg',
  default: 'images/race-crew-shirt.jpg'
};

const DESIGNER_DPI = 150;
const DESIGNER_SIZE_PRESETS = [
  { id: '3in-square', label: '3\" × 3\"', widthIn: 3, heightIn: 3 },
  { id: '4in-square', label: '4\" × 4\"', widthIn: 4, heightIn: 4 },
  { id: '6in-square', label: '6\" × 6\"', widthIn: 6, heightIn: 6 },
  { id: '6x3', label: '6\" × 3\"', widthIn: 6, heightIn: 3 },
  { id: '12x6', label: '12\" × 6\"', widthIn: 12, heightIn: 6 }
];

const DESIGNER_FONT_FAMILIES = [
  { family: 'Font Awesome 6 Free', weight: 900 },
  { family: 'Font Awesome 6 Free', weight: 400 },
  { family: 'Font Awesome 6 Brands', weight: 400 }
];

function getApparelPlaceholder(productType) {
  const key = String(productType || '').toLowerCase();
  return APPAREL_PLACEHOLDERS[key] || APPAREL_PLACEHOLDERS.default || '';
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const toRadians = (deg) => (deg * Math.PI) / 180;
const IMAGE_PADDING_RATIO = 0.2;

function buildSavedFileUrl(fileName) {
  if (!fileName) return null;
  return buildServerEndpoint(`/files/saved/${encodeURIComponent(fileName)}`);
}

const state = {
  catalog: null,
  categories: [],
  assetRoot: '',
  customerProfile: null,
  selectedCategory: null,
  filteredDesigns: [],
  renderLimit: DEFAULT_RENDER_LIMIT,
  selectedDesignId: null,
  selectedStickerSize: '4',
  selectedColor: DEFAULT_SELECTED_COLOR,
  backgroundColor: '#f8fafc',
  selectedSize: 4,
  previewImage: null,
  orders: [],
  textLayers: [],
  activeTextLayerId: null,
  draggingText: null,
  textMetrics: new Map(),
  lastImageBounds: null,
  previewImageMode: 'library',
  // color capability flags
  isMultiColorDesign: false,
  vinylControlsEnabled: true,
  apparelProducts: [],
  apparelVariantIndex: new Map(),
  selectedApparelItems: [],
  activeApparelProductHandle: null,
  activeApparelColor: null,
  apparelCatalogLoaded: false,
  apparelDefaultNote: '',
  currentPricing: null,
  designerReady: false,
  designerPendingMessages: [],
  designerSizeId: DESIGNER_SIZE_PRESETS[0].id,
  designerModalOpen: false,
  designerReturnFocus: null,
  activePaletteId: DEFAULT_PALETTE.id,
  paletteManualOverride: false,
  inventoryItems: [],
  inventoryLookup: new Map(),
  inventoryMaterial: 'regular-vinyl',
  inventoryLoading: false,
  inventoryError: null,
  inventoryUsage: [],
  previewDownloadUrl: null,
  previewDownloadName: '',
  previewCanvasClickSuppressed: false,
  storeSelectionApplied: false,
  // estimated color count for decals (auto-detected on decals page)
  estimatedColorCount: 1,
  // Local on-hand tracking for vendor apparel (e.g., S&S)
  ssawOnHand: new Map(), // sku -> { id, name, size, quantity, material }
  ssawOnHandLoaded: false,
  ssawPreferredWarehouse: '',
  apparelModalOpen: false,
  apparelFabric: null,
  // Overlay placement (relative to apparel preview image)
  overlayScale: 0.6,
  overlayPosX: 50, // percent of image width (center default)
  overlayPosY: 12, // percent of image height
  overlayDragging: null
};

const elements = {
  sidebar: document.getElementById('sidebar'),
  sidebarToggle: document.getElementById('sidebarToggle'),
  sidebarOverlay: document.getElementById('sidebarOverlay'),
  sidebarClose: document.getElementById('sidebarClose'),
  categorySelect: document.getElementById('categorySelect'),
  searchInput: document.getElementById('searchInput'),
  designGrid: document.getElementById('designGrid'),
  catalogTitle: document.getElementById('catalogTitle'),
  resultsCount: document.getElementById('resultsCount'),
  loadMoreButton: document.getElementById('loadMoreButton'),
  previewCanvas: document.getElementById('previewCanvas'),
  previewStage: document.getElementById('previewStage'),
  previewPlaceholder: document.getElementById('previewPlaceholder'),
  sizeSlider: document.getElementById('sizeSlider'),
  sizeValue: document.getElementById('sizeValue'),
  colorSwatches: document.getElementById('colorSwatches'),
  colorPaletteSelect: document.getElementById('colorPaletteSelect'),
  colorPaletteHint: document.getElementById('colorPaletteHint'),
  enableVinylColorCheckbox: document.getElementById('enableVinylColorCheckbox'),
  vinylColorWarning: document.getElementById('vinylColorWarning'),
  inventorySection: document.getElementById('inventorySection'),
  inventoryList: document.getElementById('inventoryList'),
  inventoryMaterialSelect: document.getElementById('inventoryMaterialSelect'),
  inventoryRefreshButton: document.getElementById('inventoryRefreshButton'),
  inventoryAddForm: document.getElementById('inventoryAddForm'),
  inventoryAddName: document.getElementById('inventoryAddName'),
  inventoryAddColor: document.getElementById('inventoryAddColor'),
  inventoryAddMaterial: document.getElementById('inventoryAddMaterial'),
  inventoryAddQuantity: document.getElementById('inventoryAddQuantity'),
  inventoryAddUnit: document.getElementById('inventoryAddUnit'),
  inventoryAddCost: document.getElementById('inventoryAddCost'),
  inventoryAddUrl: document.getElementById('inventoryAddUrl'),
  inventoryAddNotes: document.getElementById('inventoryAddNotes'),
  inventoryAdjustForm: document.getElementById('inventoryAdjustForm'),
  inventoryAdjustItemSelect: document.getElementById('inventoryAdjustItemSelect'),
  inventoryAdjustAmountInput: document.getElementById('inventoryAdjustAmountInput'),
  inventoryAdjustNotesInput: document.getElementById('inventoryAdjustNotesInput'),
  inventoryUsageFieldset: document.getElementById('inventoryUsageFieldset'),
  inventoryUsageItemSelect: document.getElementById('inventoryUsageItemSelect'),
  inventoryUsageQuantityInput: document.getElementById('inventoryUsageQuantityInput'),
  inventoryUsageAddButton: document.getElementById('inventoryUsageAddButton'),
  inventoryUsageList: document.getElementById('inventoryUsageList'),
  customColorInput: document.getElementById('customColorInput'),
  backgroundColorInput: document.getElementById('backgroundColorInput'),
  backgroundPresetSelect: document.getElementById('backgroundPresetSelect'),
  addTextButton: document.getElementById('addTextButton'),
  textLayersList: document.getElementById('textLayersList'),
  selectedCategoryLabel: document.getElementById('selectedCategoryLabel'),
  selectedDesignLabel: document.getElementById('selectedDesignLabel'),
  sourceLinks: document.getElementById('sourceLinks'),
  orderForm: document.getElementById('orderForm'),
  quantityInput: document.getElementById('quantityInput'),
  notesInput: document.getElementById('notesInput'),
  customerNameInput: document.getElementById('customerNameInput'),
  customerEmailInput: document.getElementById('customerEmailInput'),
  customerPhoneInput: document.getElementById('customerPhoneInput'),
  customerAddressInput: document.getElementById('customerAddressInput'),
  productTypeSelect: document.getElementById('productTypeSelect'),
  stickerSizeRow: document.getElementById('stickerSizeRow'),
  stickerSizeSelect: document.getElementById('stickerSizeSelect'),
  stickerColorSelect: document.getElementById('stickerColorSelect'),
  stickerColorRow: document.getElementById('stickerColorRow'),
  unitPriceDisplay: document.getElementById('unitPriceDisplay'),
  subtotalDisplay: document.getElementById('subtotalDisplay'),
  shippingDisplay: document.getElementById('shippingDisplay'),
  totalDisplay: document.getElementById('totalDisplay'),
  orderList: document.getElementById('orderList'),
  checkoutButton: document.getElementById('checkoutButton'),
  designCardTemplate: document.getElementById('designCardTemplate'),
  pricingFootnote: document.querySelector('.pricing-footnote'),
  apparelOpenButton: document.getElementById('apparelOpenButton'),
  apparelButtonBadge: document.getElementById('apparelButtonBadge'),
  apparelModal: document.getElementById('apparelModal'),
  apparelCloseButton: document.getElementById('apparelCloseButton'),
  apparelFieldset: document.getElementById('apparelFieldset'),
  apparelProductSelect: document.getElementById('apparelProductSelect'),
  apparelColorSelect: document.getElementById('apparelColorSelect'),
  apparelSizeSelect: document.getElementById('apparelSizeSelect'),
  apparelQuantityInput: document.getElementById('apparelQuantityInput'),
  apparelAddButton: document.getElementById('apparelAddButton'),
  apparelVariantPrice: document.getElementById('apparelVariantPrice'),
  apparelPreviewImage: document.getElementById('apparelPreviewImage'),
  apparelPreviewPlaceholder: document.getElementById('apparelPreviewPlaceholder'),
  apparelOverlayCanvas: document.getElementById('apparelOverlayCanvas'),
  apparelCanvas: document.getElementById('apparelCanvas'),
  apparelSelectedList: document.getElementById('apparelSelectedList'),
  apparelStockNote: document.getElementById('apparelStockNote'),
  overlaySizeSlider: document.getElementById('overlaySizeSlider'),
  overlayResetButton: document.getElementById('overlayResetButton'),
  priceSummary: document.getElementById('priceSummary'),
  vectorizeButton: document.getElementById('vectorizeButton'),
  vectorizeStatus: document.getElementById('vectorizeStatus'),
  designerModal: document.getElementById('designerModal'),
  designerClose: document.getElementById('designerCloseButton'),
  designerOpen: document.getElementById('openDesignerButton'),
  designerFrame: document.getElementById('designerFrame'),
  designerSizeSelect: document.getElementById('designerSizeSelect'),
  designerSave: document.getElementById('designerSaveButton'),
  designerCategorySelect: document.getElementById('designerCategorySelect'),
  designerLibraryGrid: document.getElementById('designerLibraryGrid'),
  designerResetButton: document.getElementById('designerResetButton')
};

if (elements.apparelStockNote) {
  state.apparelDefaultNote = elements.apparelStockNote.textContent || '';
}

function getStoredCustomerToken() {
  try {
    return localStorage.getItem('stickerPortalToken') || null;
  } catch (error) {
    console.warn('Unable to read stored token:', error);
    return null;
  }
}

function resolveAssetUrl(pathValue) {
  if (!pathValue) return '';
  if (/^https?:/i.test(pathValue)) {
    try {
      const current = new URL(window.location.href);
      const url = new URL(pathValue);
      url.protocol = current.protocol;
      url.hostname = current.hostname;
      url.port = current.port;
      return url.toString();
    } catch (error) {
      return pathValue;
    }
  }
  if (/^(data:|blob:)/i.test(pathValue)) return pathValue;
  if (pathValue.startsWith('/api/')) {
    return `${window.location.origin}${pathValue}`;
  }

  const base = state.assetRoot;
  if (!base) return pathValue;

  let baseUrl;
  try {
    if (/^https?:\/\//i.test(base)) {
      baseUrl = base;
    } else if (base.startsWith('/')) {
      baseUrl = `${window.location.origin}${base}`;
    } else {
      baseUrl = `${window.location.origin}/${base}`;
    }

    baseUrl = baseUrl.replace(/\/+$/, '') + '/';
    const cleanedPath = pathValue.replace(/^\.\//, '');
    return new URL(cleanedPath, baseUrl).href;
  } catch (error) {
    return pathValue;
  }
}

function buildImageUrl(pathValue, { width, quality } = {}) {
  const resolved = resolveAssetUrl(pathValue);
  if (!width && !quality) return resolved;
  try {
    const urlObject = /^https?:/i.test(resolved)
      ? new URL(resolved)
      : new URL(resolved, window.location.origin);
    if (width) {
      const clampedWidth = Math.min(Math.max(Math.round(width), 1), 2400);
      urlObject.searchParams.set('w', String(clampedWidth));
    }
    if (quality) {
      urlObject.searchParams.set('q', String(Math.min(Math.max(quality, 40), 95)));
    }
    return urlObject.href;
  } catch (error) {
    console.warn('Unable to build image URL:', error);
    return resolved;
  }
}

function buildServerImageUrl(pathValue, { width, quality, bust } = {}) {
  try {
    const base = resolveSaveServerBase();
    const rel = String(pathValue || '').replace(/^\.\//, '');
    const urlObject = /^https?:/i.test(rel)
      ? new URL(rel)
      : new URL(rel.startsWith('/') ? rel.slice(1) : rel, base.endsWith('/') ? base : `${base}/`);
    if (width) {
      const clampedWidth = Math.min(Math.max(Math.round(width), 1), 2400);
      urlObject.searchParams.set('w', String(clampedWidth));
    }
    if (quality) {
      urlObject.searchParams.set('q', String(Math.min(Math.max(quality, 40), 95)));
    }
    if (bust) {
      urlObject.searchParams.set('_', String(bust));
    }
    return urlObject.href;
  } catch (_) {
    return pathValue;
  }
}

function attachImageRetry(img, originalPath) {
  if (!img) return;
  img.addEventListener('error', () => {
    const tries = Number(img.dataset.retry || '0');
    if (tries >= 2) return; // give up after a couple attempts
    img.dataset.retry = String(tries + 1);
    // First retry: cache-bust current URL; Second: force server base
    if (tries === 0) {
      try {
        const url = new URL(img.src, window.location.origin);
        url.searchParams.set('_', String(Date.now()));
        img.src = url.toString();
      } catch (_) {
        img.src = `${img.src}${img.src.includes('?') ? '&' : '?'}_=${Date.now()}`;
      }
    } else {
      img.src = buildServerImageUrl(originalPath, { width: 480, quality: 80, bust: Date.now() });
    }
  }, { once: false });
}

function calculateCustomApparelPriceCents(garmentCostCents, productType, colorCount) {
  const vinylUsage = APPAREL_VINYL_USAGE_SQFT[productType] ?? 0;
  const vinylCostCents = Math.round(vinylUsage * VINYL_COST_PER_SQFT_DOLLARS * 100);
  const baseCostCents = Math.max(0, Math.round(Number(garmentCostCents) || 0)) + vinylCostCents + LABOR_COST_PER_ITEM_CENTS;
  const profitAdjustedCents = Math.round(baseCostCents * (1 + PROFIT_MARGIN));
  const extraColors = Math.max(0, Number(colorCount || 1) - 1);
  return roundUpToQuarterDollar(profitAdjustedCents + extraColors * COLOR_ADDON_CENTS);
}

function slugifyFilename(value, fallback = 'design') {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return slug || fallback;
}

function extractFileExtension(pathValue, fallback = 'png') {
  if (!pathValue) return fallback;
  const match = /\.[a-z0-9]+(?=$|\?)/i.exec(pathValue);
  if (match && match[0]) {
    return match[0].slice(1).toLowerCase();
  }
  return fallback;
}

async function downloadAssetToDisk(url, filename) {
  if (!url) return;
  try {
    if (url.startsWith('data:')) {
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename || 'catalog-design.png';
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      return;
    }
    const response = await fetch(url, { credentials: 'include', cache: 'no-cache' });
    if (!response.ok) {
      throw new Error(`Download failed with status ${response.status}`);
    }
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename || 'catalog-design.png';
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  } catch (error) {
    console.error('Unable to download asset:', error);
    alert('Unable to download this preview right now. Please try again in a moment.');
  }
}

function getCanvasContext() {
  const ctx = elements.previewCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('Unable to acquire 2D drawing context.');
  }
  return ctx;
}

function roundUpToQuarterDollar(cents) {
  const value = Math.max(0, Math.round(Number(cents) || 0));
  return Math.ceil(value / 25) * 25;
}

function getBulkDiscountRate(quantity) {
  const qty = Math.max(0, Number(quantity) || 0);
  if (qty >= 30) return 0.25;
  if (qty >= 21) return 0.15;
  if (qty >= 10) return 0.10;
  return 0;
}

function formatCents(cents = 0) {
  return USD_FORMATTER.format((cents || 0) / 100);
}

function computePricing(productType, sizeInches, colorCount, quantity) {
  const qty = Math.max(1, quantity || 1);
  let unitPriceCents = LASER_PRICE_CENTS;
  let shippingCents = 0;
  let descriptor = 'Laser-engraved wood';
  let colors = null;
  let size = null;

  const normalizedColor = String(colorCount || '1');

  switch (productType) {
    case 'sticker': {
      const sizeKey = String(sizeInches || '4');
      const sizePricing = STICKER_PRICE_TABLE[sizeKey] || STICKER_PRICE_TABLE['4'];
      unitPriceCents = sizePricing?.[normalizedColor] ?? sizePricing?.['1'] ?? 400;
      unitPriceCents = roundUpToQuarterDollar(unitPriceCents);
      const discountRate = getBulkDiscountRate(qty);
      if (discountRate > 0) {
        unitPriceCents = roundUpToQuarterDollar(Math.round(unitPriceCents * (1 - discountRate)));
      }
      shippingCents = SHIPPING_STICKER_CENTS;
      descriptor = `${sizeKey}" sticker · ${normalizedColor} color${normalizedColor === '1' ? '' : 's'}`;
      colors = Number(normalizedColor);
      size = Number(sizeKey);
      break;
    }
    case 'tshirt':
    case 'hat':
    case 'hoodie': {
      unitPriceCents = calculateApparelUnitPriceCents(productType, normalizedColor);
      const discountRate = getBulkDiscountRate(qty);
      if (discountRate > 0) {
        unitPriceCents = roundUpToQuarterDollar(Math.round(unitPriceCents * (1 - discountRate)));
      }
      shippingCents = 0;
      const label =
        productType === 'tshirt'
          ? 'Custom vinyl T-shirt'
          : productType === 'hoodie'
          ? 'Custom vinyl hoodie'
          : 'Custom vinyl hat';
      descriptor = `${label} · ${normalizedColor} color${normalizedColor === '1' ? '' : 's'}`;
      colors = Number(normalizedColor);
      break;
    }
    default: {
      unitPriceCents = LASER_PRICE_CENTS;
      const discountRate = getBulkDiscountRate(qty);
      if (discountRate > 0) {
        unitPriceCents = roundUpToQuarterDollar(Math.round(unitPriceCents * (1 - discountRate)));
      }
      shippingCents = SHIPPING_LASER_CENTS * qty; // shipping per plaque
      descriptor = 'Laser-engraved wood';
      break;
    }
  }

  const subtotalCents = unitPriceCents * qty;
  const totalCents = subtotalCents + shippingCents;

  return {
    productType,
    descriptor,
    colors,
    sizeInches: size,
    unitPriceCents,
    subtotalCents,
    shippingCents,
    totalCents,
    quantity: qty,
    currency: 'USD'
  };
}

function normalizeProductType(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function resolveApparelUnitPriceCents(productType, options = {}) {
  const normalized = normalizeProductType(productType);
  if (!normalized) return 0;
  const colorCount = String(options.colorCount || '1');
  if (GARMENT_COST_CENTS[normalized] !== undefined) {
    return calculateApparelUnitPriceCents(normalized, colorCount);
  }
  if (normalized === 'beanie') {
    return calculateApparelUnitPriceCents('beanie', colorCount);
  }
  if (normalized === 'headband') {
    return calculateApparelUnitPriceCents('headband', colorCount);
  }
  if (normalized === 'accessory') {
    return calculateApparelUnitPriceCents('accessory', colorCount);
  }
  if (normalized === 'drinkware') {
    return calculateApparelUnitPriceCents('drinkware', colorCount);
  }
  if (normalized === 'hat') {
    return calculateApparelUnitPriceCents('hat', colorCount);
  }
  return calculateApparelUnitPriceCents('tshirt', colorCount);
}

function ensureApparelPricing(item, options = {}) {
  if (!item) return item;
  const quantity = Math.max(1, Number(item.quantity) || 1);
  const normalizedType = normalizeProductType(item.productType);
  const unitPriceCents =
    Number.isFinite(item.unitPriceCents) && item.unitPriceCents > 0
      ? roundUpToQuarterDollar(item.unitPriceCents)
      : resolveApparelUnitPriceCents(normalizedType, options);
  let effectiveUnit = unitPriceCents;
  const discountRate = getBulkDiscountRate(quantity);
  if (discountRate > 0) {
    effectiveUnit = roundUpToQuarterDollar(Math.round(effectiveUnit * (1 - discountRate)));
  }
  const lineTotalCents = effectiveUnit * quantity;
  item.productType = normalizedType;
  item.unitPriceCents = effectiveUnit;
  item.lineTotalCents = lineTotalCents;
  item.quantity = quantity;
  return item;
}

function cloneApparelItems(items = []) {
  return items.map((item) =>
    ensureApparelPricing({
      ...item,
      quantity: Math.max(1, Number(item.quantity) || 1)
    })
  );
}

function computeApparelTotals(items = []) {
  const lines = cloneApparelItems(items);
  const subtotalCents = lines.reduce(
    (sum, entry) => sum + Math.max(0, Number(entry.lineTotalCents) || 0),
    0
  );
  return {
    items: lines,
    subtotalCents
  };
}

function readStoreSelection() {
  try {
    const raw = localStorage.getItem(STORE_SELECTION_KEY);
    if (!raw) return null;
    localStorage.removeItem(STORE_SELECTION_KEY);
    return JSON.parse(raw);
  } catch (error) {
    console.warn('Unable to parse store selection payload:', error);
    localStorage.removeItem(STORE_SELECTION_KEY);
    return null;
  }
}

function getStoreSelectionPrice(productType, fallbackCents) {
  if (Number.isFinite(fallbackCents) && fallbackCents > 0) {
    return roundUpToQuarterDollar(fallbackCents);
  }
  return calculateApparelUnitPriceCents(normalizeProductType(productType), 1);
}

function scrollApparelSectionIntoView() {
  if (!elements.apparelFieldset) return;
  try {
    elements.apparelFieldset.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    // ignore scroll failures (e.g., older browsers)
  }
  elements.apparelFieldset.classList.add('store-highlight');
  window.setTimeout(() => {
    elements.apparelFieldset?.classList.remove('store-highlight');
  }, 2200);
  if (elements.apparelStockNote && !elements.apparelStockNote.dataset.storeNote) {
    elements.apparelStockNote.dataset.storeNote = 'true';
    elements.apparelStockNote.textContent =
      'We pre-loaded your apparel selection. Adjust sizes or quantities as needed before submitting.';
  }
}

function integrateStoreSelection(selection) {
  if (!selection || state.storeSelectionApplied) return;
  const productType = normalizeProductType(selection.productType || 'tshirt');
  const quantity = Math.max(1, Number(selection.quantity) || 1);
  const priceCents = getStoreSelectionPrice(productType, Number(selection.priceCents));
  const newItem = ensureApparelPricing(
    {
      sku: selection.id ? `store-${selection.id}` : `store-${Date.now()}`,
      handle: selection.name || 'Custom apparel',
      title: selection.name || 'Custom apparel',
      vendor: 'Swayze Apparel',
      productType,
      style: 'Custom drop',
      color: selection.color || '',
      size: selection.size || '',
      quantity,
      imageUrl: selection.image || null,
      productUrl: selection.categorySlug
        ? `./catalog.html?category=${encodeURIComponent(selection.categorySlug)}`
        : null,
      unitPriceCents: priceCents,
      metadata: { fromStore: true }
    },
    { productType }
  );
  state.selectedApparelItems.push(newItem);
  state.storeSelectionApplied = true;
  renderSelectedApparelItems();
  scrollApparelSectionIntoView();
}

function applyStoreSelectionIfPresent() {
  if (state.storeSelectionApplied) return;
  const selection = readStoreSelection();
  if (!selection) return;
  if (!elements.apparelFieldset) {
    return;
  }
  integrateStoreSelection(selection);
}

function mergeApparelPricing(basePricing, apparelTotals, quantity) {
  const apparelSubtotalCents = apparelTotals?.subtotalCents || 0;
  const merged = {
    ...basePricing,
    apparelTotals,
    apparelSubtotalCents
  };
  const subtotalWithApparel = basePricing.subtotalCents + apparelSubtotalCents;
  merged.subtotalCents = subtotalWithApparel;
  merged.totalCents = subtotalWithApparel + (basePricing.shippingCents || 0);
  const qty = Math.max(1, quantity || basePricing.quantity || 1);
  merged.unitPriceCents = roundUpToQuarterDollar(Math.round(merged.subtotalCents / qty));
  if (apparelSubtotalCents > 0 && merged.descriptor && !/apparel/i.test(merged.descriptor)) {
    merged.descriptor = `${merged.descriptor} + apparel add-ons`;
  }
  merged.apparelDescriptor = 'Apparel add-ons';
  return merged;
}

function getDesignerSizeById(id) {
  return (
    DESIGNER_SIZE_PRESETS.find((preset) => preset.id === id) ||
    DESIGNER_SIZE_PRESETS[0]
  );
}

function convertDesignerSizeToPixels(size) {
  const preset = typeof size === 'string' ? getDesignerSizeById(size) : size;
  if (!preset) {
    return { width: 300, height: 300 };
  }
  return {
    width: Math.round(preset.widthIn * DESIGNER_DPI),
    height: Math.round(preset.heightIn * DESIGNER_DPI)
  };
}

function enqueueDesignerMessage(type, payload) {
  if (!elements.designerFrame || !elements.designerFrame.contentWindow) return;
  const message = { type, payload };
  if (state.designerReady) {
    elements.designerFrame.contentWindow.postMessage(message, '*');
  } else {
    state.designerPendingMessages.push(message);
  }
}

function flushDesignerQueue() {
  if (!state.designerReady || !elements.designerFrame?.contentWindow) return;
  while (state.designerPendingMessages.length) {
    const message = state.designerPendingMessages.shift();
    elements.designerFrame.contentWindow.postMessage(message, '*');
  }
}

function applyDesignerSize(sizeId) {
  const preset = getDesignerSizeById(sizeId);
  state.designerSizeId = preset.id;
  const { width, height } = convertDesignerSizeToPixels(preset);
  enqueueDesignerMessage('MINIPAINT_SET_CANVAS', { width, height });
  updateSize(preset.widthIn);
}

function getDesignerFontPayload() {
  return DESIGNER_FONT_FAMILIES.map((font) => ({
    family: font.family,
    weight: font.weight,
    style: font.style || 'normal'
  }));
}

function openDesignerModal() {
  if (!elements.designerModal) return;
  const active = document.activeElement;
  state.designerReturnFocus =
    active && typeof active.focus === 'function' ? active : elements.designerOpen || null;
  state.designerModalOpen = true;
  elements.designerModal.removeAttribute('hidden');
  document.body.classList.add('designer-modal-open');
  if (elements.designerSizeSelect) {
    elements.designerSizeSelect.value = state.designerSizeId;
  }
  const preset = getDesignerSizeById(state.designerSizeId);
  const dimensions = DESIGNER_SIZE_PRESETS.map((entry) => ({
    width: convertDesignerSizeToPixels(entry).width,
    height: convertDesignerSizeToPixels(entry).height,
    label: entry.label
  }));
  enqueueDesignerMessage('MINIPAINT_SET_DIMENSIONS', { dimensions });
  enqueueDesignerMessage('MINIPAINT_SET_FONTS', { fonts: getDesignerFontPayload() });
  const { width, height } = convertDesignerSizeToPixels(preset);
  enqueueDesignerMessage('MINIPAINT_SET_CANVAS', { width, height });
  renderDesignerLibrary();
  if (elements.designerSizeSelect && typeof elements.designerSizeSelect.focus === 'function') {
    try {
      elements.designerSizeSelect.focus({ preventScroll: true });
    } catch (error) {
      elements.designerSizeSelect.focus();
    }
  }
}

function closeDesignerModal() {
  if (!elements.designerModal) return;
  state.designerModalOpen = false;
  elements.designerModal.setAttribute('hidden', '');
  document.body.classList.remove('designer-modal-open');
  const returnTarget = state.designerReturnFocus;
  state.designerReturnFocus = null;
  if (returnTarget && typeof returnTarget.focus === 'function') {
    try {
      returnTarget.focus({ preventScroll: true });
    } catch (error) {
      returnTarget.focus();
    }
  }
}

function applyDesignerImage(payload) {
  if (!payload?.dataUrl) return;
  const image = new Image();
  image.onload = () => {
    state.previewImage = image;
    state.previewImageMode = 'custom';
    state.previewDownloadUrl = null;
    state.previewDownloadName = '';
    updatePreviewCanvas();
  };
  image.src = payload.dataUrl;
}

function handleDesignerMessage(event) {
  const { type, payload } = event.data || {};
  switch (type) {
    case 'MINIPAINT_READY': {
      state.designerReady = true;
      flushDesignerQueue();
      if (elements.designerSizeSelect) {
        elements.designerSizeSelect.value = state.designerSizeId;
      }
      enqueueDesignerMessage('MINIPAINT_SET_FONTS', { fonts: getDesignerFontPayload() });
      const preset = getDesignerSizeById(state.designerSizeId);
      const { width, height } = convertDesignerSizeToPixels(preset);
      enqueueDesignerMessage('MINIPAINT_SET_DIMENSIONS', {
        dimensions: DESIGNER_SIZE_PRESETS.map((entry) => ({
          width: convertDesignerSizeToPixels(entry).width,
          height: convertDesignerSizeToPixels(entry).height,
          label: entry.label
        }))
      });
      enqueueDesignerMessage('MINIPAINT_SET_CANVAS', { width, height });
      break;
    }
    case 'MINIPAINT_IMAGE':
      applyDesignerImage(payload);
      closeDesignerModal();
      break;
    case 'MINIPAINT_ERROR':
      if (payload?.message) {
        console.error('Designer error:', payload.message);
        alert(payload.message);
      }
      break;
    default:
      break;
  }
}

function handleDesignerSave() {
  enqueueDesignerMessage('MINIPAINT_EXPORT', { format: 'image/png' });
}

function renderDesignerLibrary() {
  if (!elements.designerLibraryGrid) return;
  const categories = state.categories || [];
  if (!categories.length) {
    if (elements.designerCategorySelect) {
      elements.designerCategorySelect.innerHTML =
        '<option value="">No categories available</option>';
      elements.designerCategorySelect.disabled = true;
    }
    elements.designerLibraryGrid.innerHTML = '<p class="designer-empty">Library not available.</p>';
    return;
  }
  if (elements.designerCategorySelect) {
    elements.designerCategorySelect.disabled = false;
  }
  let categorySlug =
    elements.designerCategorySelect?.value ||
    state.selectedCategory?.slug ||
    categories[0].slug;
  const category = categories.find((item) => item.slug === categorySlug) || categories[0];
  if (elements.designerCategorySelect) {
    categorySlug = category.slug;
    elements.designerCategorySelect.innerHTML = categories
      .map((cat) => `<option value="${cat.slug}" ${cat.slug === categorySlug ? 'selected' : ''}>${cat.name}</option>`)
      .join('');
    elements.designerCategorySelect.value = category.slug;
  }
  const designs = category?.designs || [];
  if (!designs.length) {
    elements.designerLibraryGrid.innerHTML = '<p class="designer-empty">No designs in this category yet.</p>';
    return;
  }
  const fragment = document.createDocumentFragment();
  designs.forEach((design) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'designer-library-item';
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = design.name;
    img.src = resolveAssetUrl(design.image);
    button.appendChild(img);
    const label = document.createElement('span');
    label.textContent = design.name;
    button.appendChild(label);
    button.addEventListener('click', () => {
      const imageUrl = resolveAssetUrl(design.image);
      enqueueDesignerMessage('MINIPAINT_INSERT_IMAGE', {
        url: imageUrl,
        options: { autoresize: false }
      });
    });
    fragment.appendChild(button);
  });
  elements.designerLibraryGrid.innerHTML = '';
  elements.designerLibraryGrid.appendChild(fragment);
}

function initDesignerModal() {
  window.addEventListener('message', handleDesignerMessage);

  if (elements.designerModal) {
    elements.designerModal.addEventListener('click', (event) => {
      if (
        event.target === elements.designerModal ||
        event.target?.dataset?.close === 'designer'
      ) {
        closeDesignerModal();
      }
    });
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (state.designerModalOpen) {
        event.preventDefault();
        closeDesignerModal();
        return;
      }
      if (state.apparelModalOpen) {
        event.preventDefault();
        closeApparelModal();
        return;
      }
    }
  });

  if (elements.designerOpen) {
    elements.designerOpen.addEventListener('click', (event) => {
      event.preventDefault();
      openDesignerModal();
    });
  }

  if (elements.designerClose) {
    elements.designerClose.addEventListener('click', (event) => {
      event.preventDefault();
      closeDesignerModal();
    });
  }

  if (elements.designerSave) {
    elements.designerSave.addEventListener('click', (event) => {
      event.preventDefault();
      handleDesignerSave();
    });
  }

  if (elements.designerSizeSelect) {
    elements.designerSizeSelect.innerHTML = DESIGNER_SIZE_PRESETS.map((preset) => {
      return `<option value="${preset.id}">${preset.label}</option>`;
    }).join('');
    elements.designerSizeSelect.value = state.designerSizeId;
    elements.designerSizeSelect.addEventListener('change', (event) => {
      applyDesignerSize(event.target.value);
    });
  }

  if (elements.designerCategorySelect) {
    elements.designerCategorySelect.addEventListener('change', renderDesignerLibrary);
  }

  if (elements.designerResetButton) {
    elements.designerResetButton.addEventListener('click', (event) => {
      event.preventDefault();
      const preset = getDesignerSizeById(state.designerSizeId);
      const { width, height } = convertDesignerSizeToPixels(preset);
      enqueueDesignerMessage('MINIPAINT_SET_CANVAS', { width, height });
    });
  }

  renderDesignerLibrary();

  // Apparel modal open/close wiring
  if (elements.apparelOpenButton) {
    elements.apparelOpenButton.addEventListener('click', (e) => {
      e.preventDefault();
      openApparelModal();
    });
  }
  if (elements.apparelCloseButton) {
    elements.apparelCloseButton.addEventListener('click', (e) => {
      e.preventDefault();
      closeApparelModal();
    });
  }
  if (elements.apparelModal) {
    elements.apparelModal.addEventListener('click', (e) => {
      const target = e.target;
      if (target && target.getAttribute && target.getAttribute('data-close') === 'apparel') {
        closeApparelModal();
      }
    });
  }
}

function updateStickerColorOptions(sizeKey) {
  if (!elements.stickerColorSelect) return;
  const pricing = STICKER_PRICE_TABLE[sizeKey] || STICKER_PRICE_TABLE['4'];
  const labelMap = {
    1: 'One color',
    2: 'Two colors',
    3: 'Three colors',
    4: 'Four colors'
  };

  Array.from(elements.stickerColorSelect.options).forEach((option) => {
    const value = option.value;
    if (!pricing[value]) {
      option.disabled = true;
      return;
    }
    option.disabled = false;
    const priceLabel = formatCents(pricing[value]);
    const baseLabel = labelMap[value] || `${value} colors`;
    option.textContent = `${baseLabel} (${priceLabel})`;
  });
}

// --- Apparel modal controls ---
function openApparelModal() {
  if (!elements.apparelModal) return;
  elements.apparelModal.removeAttribute('hidden');
  state.apparelModalOpen = true;
}

function closeApparelModal() {
  if (!elements.apparelModal) return;
  elements.apparelModal.setAttribute('hidden', '');
  state.apparelModalOpen = false;
}

function updateApparelVariantPrice() {
  if (!elements.apparelVariantPrice) return;
  const variant = getSelectedApparelVariant();
  if (variant && Number.isFinite(Number(variant.priceCents))) {
    elements.apparelVariantPrice.textContent = `Price: ${formatCents(Number(variant.priceCents))} each`;
  } else {
    elements.apparelVariantPrice.textContent = '';
  }
}

function updateApparelButtonBadge() {
  if (!elements.apparelButtonBadge) return;
  const count = Array.isArray(state.selectedApparelItems) ? state.selectedApparelItems.length : 0;
  if (!count) {
    elements.apparelButtonBadge.textContent = '';
    return;
  }
  const totals = computeApparelTotals(state.selectedApparelItems);
  const label = count === 1 ? '1 item' : `${count} items`;
  elements.apparelButtonBadge.textContent = `${label} · ${formatCents(totals.subtotalCents)}`;
}

function updateApparelColorOptions(productType) {
  if (!elements.stickerColorSelect) return;
  const labelMap = {
    1: 'One color',
    2: 'Two colors',
    3: 'Three colors',
    4: 'Four colors'
  };
  Array.from(elements.stickerColorSelect.options).forEach((option) => {
    const value = option.value;
    if (!APPAREL_ALLOWED_COLORS.includes(value)) {
      option.disabled = true;
      return;
    }
    option.disabled = false;
    const pricingPreview = computePricing(productType, null, value, 1);
    const baseLabel = labelMap[value] || `${value} colors`;
    option.textContent = `${baseLabel} (${formatCents(pricingPreview.unitPriceCents)})`;
  });
}

function updateApparelSubtotalLine(subtotalCents) {
  if (!elements.priceSummary) return;
  let line = elements.priceSummary.querySelector('[data-role="apparel-subtotal"]');
  if (subtotalCents > 0) {
    if (!line) {
      line = document.createElement('div');
      line.dataset.role = 'apparel-subtotal';
      const label = document.createElement('span');
      label.textContent = 'Apparel add-ons';
      const value = document.createElement('strong');
      value.id = 'apparelAddonsDisplay';
      line.append(label, value);
      const subtotalParent = elements.subtotalDisplay?.parentElement;
      if (subtotalParent && subtotalParent.parentElement === elements.priceSummary) {
        elements.priceSummary.insertBefore(line, subtotalParent);
      } else {
        elements.priceSummary.appendChild(line);
      }
    }
    const display = line.querySelector('strong');
    if (display) {
      display.textContent = formatCents(subtotalCents);
    }
  } else if (line && line.parentElement) {
    line.parentElement.removeChild(line);
  }
}

function updatePricingSummary() {
  const productType = elements.productTypeSelect?.value || 'sticker';
  const quantity = Math.max(1, Number(elements.quantityInput?.value || 1) || 1);
  const sizeValue = elements.stickerSizeSelect?.value || state.selectedStickerSize || '4';
  state.selectedStickerSize = sizeValue;

  let colorValue = elements.stickerColorSelect?.value || '1';
  const isSticker = productType === 'sticker';
  const isApparel =
    productType === 'tshirt' || productType === 'hat' || productType === 'hoodie';

  if (isSticker) {
    // On decals page we auto-detect color count; otherwise honor manual selector
    if (window.__AUTO_COLOR_COUNT__) {
      const est = Math.max(1, Math.min(4, Number(state.estimatedColorCount) || 1));
      colorValue = String(est);
    } else {
      updateStickerColorOptions(sizeValue);
      if (elements.stickerColorSelect) {
        const currentOption =
          elements.stickerColorSelect.options[elements.stickerColorSelect.selectedIndex];
        if (!currentOption || currentOption.disabled) {
          const firstEnabled = Array.from(elements.stickerColorSelect.options).find(
            (option) => !option.disabled
          );
          if (firstEnabled) {
            elements.stickerColorSelect.value = firstEnabled.value;
          }
        }
        colorValue = elements.stickerColorSelect.value || colorValue;
      }
    }
  } else if (isApparel) {
    updateApparelColorOptions(productType);
    if (elements.stickerColorSelect) {
      const currentOption =
        elements.stickerColorSelect.options[elements.stickerColorSelect.selectedIndex];
      if (!currentOption || currentOption.disabled) {
        const firstEnabled = Array.from(elements.stickerColorSelect.options).find(
          (option) => !option.disabled
        );
        if (firstEnabled) {
          elements.stickerColorSelect.value = firstEnabled.value;
        }
      }
      colorValue = elements.stickerColorSelect.value || '1';
    }
  }

  elements.stickerSizeRow?.classList.toggle('hidden', !isSticker);
  elements.pricingFootnote?.classList.toggle('hidden', !isSticker);
  elements.stickerColorRow?.classList.toggle('hidden', window.__AUTO_COLOR_COUNT__ ? true : !(isSticker || isApparel));

  const basePricing = computePricing(productType, sizeValue, colorValue, quantity);
  const apparelTotals = computeApparelTotals(state.selectedApparelItems);
  const pricing = mergeApparelPricing(basePricing, apparelTotals, quantity);

  if (elements.unitPriceDisplay) {
    elements.unitPriceDisplay.textContent = formatCents(pricing.unitPriceCents);
  }
  // Inline color-count next to unit price label on decals page
  try {
    const labelSpan = elements.unitPriceDisplay?.previousElementSibling || elements.priceSummary?.querySelector('div:first-child span');
    if (labelSpan) {
      if (window.__AUTO_COLOR_COUNT__ && isSticker) {
        const n = Math.max(1, Math.min(4, Number(colorValue) || 1));
        labelSpan.textContent = `Unit price (${n} ${n === 1 ? 'color' : 'colors'})`;
      } else {
        labelSpan.textContent = 'Unit price';
      }
    }
  } catch (_) {}
  if (elements.subtotalDisplay) {
    elements.subtotalDisplay.textContent = formatCents(pricing.subtotalCents);
  }
  // Inline color-count next to subtotal label on decals page
  try {
    const subLabelSpan = elements.subtotalDisplay?.previousElementSibling || elements.priceSummary?.querySelector('div:nth-child(2) span');
    if (subLabelSpan) {
      if (window.__AUTO_COLOR_COUNT__ && isSticker) {
        const n = Math.max(1, Math.min(4, Number(colorValue) || 1));
        subLabelSpan.textContent = `Subtotal (${n} ${n === 1 ? 'color' : 'colors'})`;
      } else {
        subLabelSpan.textContent = 'Subtotal';
      }
    }
  } catch (_) {}
  if (elements.shippingDisplay) {
    elements.shippingDisplay.textContent = formatCents(pricing.shippingCents);
  }
  if (elements.totalDisplay) {
    elements.totalDisplay.textContent = formatCents(pricing.totalCents);
  }

  updateApparelSubtotalLine(apparelTotals.subtotalCents);
  state.currentPricing = pricing;
  updateColorCountNote();

  return pricing;
}

function normalizeApparelSizeKey(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '');
}

function getApparelSizeOrder(size) {
  const normalized = normalizeApparelSizeKey(size);
  if (!normalized) return 500;
  const index = APPAREL_SIZE_SEQUENCE.indexOf(normalized);
  if (index >= 0) {
    return index;
  }
  const numericMatch = normalized.match(/^(\d+)/);
  if (numericMatch) {
    const num = Number(numericMatch[1]);
    if (Number.isFinite(num)) {
      return 200 + num;
    }
  }
  return 400 + normalized.charCodeAt(0);
}

function ensureApparelVariantIndex(product) {
  if (!product) return null;
  if (product._variantIndex) return product._variantIndex;
  const map = new Map();
  (product.variants || []).forEach((variant) => {
    const color = (variant.color || 'Standard').trim() || 'Standard';
    const size = (variant.size || 'One Size').trim() || 'One Size';
    if (!map.has(color)) {
      map.set(color, new Map());
    }
    map.get(color).set(size, variant);
  });
  product._variantIndex = map;
  state.apparelVariantIndex.set(product.handle, map);
  return map;
}

async function loadSsawStylesBatch(queries = []) {
  const results = [];
  for (const q of queries) {
    try {
      const res = await fetch(`${SSAW_STYLES_ENDPOINT}?q=${encodeURIComponent(q)}`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      const styles = Array.isArray(data.styles) ? data.styles : [];
      styles.forEach((s) => {
        const handle = `ssaw-${s.styleID}`;
        if (results.some((p) => p.handle === handle)) return;
        results.push({
          handle,
          title: `${s.brandName || ''} ${s.styleName || ''} ${s.title || ''}`.trim(),
          vendor: 'S&S Activewear',
          productType: s.productType || 'tshirt',
          styleID: s.styleID,
          brandName: s.brandName,
          styleName: s.styleName,
          source: 'ssaw',
          variants: []
        });
      });
    } catch (error) {
      console.warn('Unable to load SSAW styles for', q, error);
    }
  }
  return results;
}

async function loadSsawVariantsFor(product) {
  if (!product || product.source !== 'ssaw' || !product.styleID) return product;
  try {
    const res = await fetch(`${SSAW_PRODUCTS_ENDPOINT}?style=${encodeURIComponent(product.styleID)}`, { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    const variants = Array.isArray(data.variants) ? data.variants : [];
  const normalized = variants.map((v) => {
    const productType = product.productType || 'tshirt';
    const garmentCostCents = Math.max(0, Number(v.piecePriceCents) || 0);
    const unitPriceCents = calculateCustomApparelPriceCents(garmentCostCents, productType, 1);
    return {
      sku: v.sku,
      color: v.color || '',
      size: v.size || '',
      imageUrl: v.imageUrl || null,
      vendor: 'S&S Activewear',
      productType,
      style: product.styleName || '',
      handle: product.handle,
      title: product.title,
      priceCents: unitPriceCents,
      unitCostCents: garmentCostCents,
      // total qty reported by the vendor
      qty: Number(v.qty) || 0,
      // pass through warehouse-level availability if present
      warehouses: Array.isArray(v.warehouses)
        ? v.warehouses.map((w) => ({ abbr: String(w.abbr || w.warehouseAbbr || '').toUpperCase(), qty: Number(w.qty) || 0 }))
        : undefined,
      productUrl: null
    };
  });
    product.variants = normalized;
    product._variantIndex = null;
    ensureApparelVariantIndex(product);
  } catch (error) {
    console.warn('Unable to load SSAW variants:', error);
    product.variants = [];
    product._variantIndex = null;
  }
  return product;
}

// Ensure warehouse-level inventory data is attached for a given color (SSAW products include this
// but some older normalized entries may lack warehouses). This call is safe to no-op if already present.
async function ensureSsawInventoryForColor(product, color) {
  try {
    if (!product || product.source !== 'ssaw' || !product.styleID || !color) return;
    const lc = (product._inventoryLoadedColors ||= new Set());
    if (lc.has(color)) return; // already enriched
    // Fetch full variants for this style and merge warehouses into our variants
    const res = await fetch(`${SSAW_PRODUCTS_ENDPOINT}?style=${encodeURIComponent(product.styleID)}`, { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    const apiVariants = Array.isArray(data.variants) ? data.variants : [];
    const bySku = new Map((product.variants || []).map((v) => [v.sku, v]));
    apiVariants.forEach((v) => {
      if (!v || !v.sku) return;
      const local = bySku.get(v.sku);
      if (!local) return;
      if ((local.color || '').trim().toLowerCase() !== String(v.color || '').trim().toLowerCase()) return;
      // Merge qty and warehouses
      if (v.qty != null && Number.isFinite(Number(v.qty))) local.qty = Number(v.qty);
      if (Array.isArray(v.warehouses)) {
        local.warehouses = v.warehouses.map((w) => ({ abbr: String(w.abbr || w.warehouseAbbr || '').toUpperCase(), qty: Number(w.qty) || 0 }));
      }
    });
    lc.add(color);
  } catch (_) {
    // Swallow enrichment errors; UI will fall back to total qty
  }
}

function renderSsawSizeInventoryNote(product, color, size) {
  if (!elements.apparelStockNote) return;
  try {
    const pref = (state.ssawPreferredWarehouse || '').toUpperCase();
    const index = ensureApparelVariantIndex(product);
    const sizeMap = index?.get(color) || null;
    const variant = sizeMap ? sizeMap.get(size) : null;
    if (!variant) {
      elements.apparelStockNote.textContent = state.apparelDefaultNote || elements.apparelStockNote.textContent;
      return;
    }
    let qty = Number(variant?.qty);
    if (pref && Array.isArray(variant?.warehouses)) {
      const found = variant.warehouses.find((w) => String(w.abbr || '').toUpperCase() === pref);
      if (found) qty = Number(found.qty);
    }
    if (Number.isFinite(qty)) {
      elements.apparelStockNote.textContent = pref
        ? qty > 0
          ? `Availability: ${qty} available in ${pref}`
          : `Availability: Out in ${pref}`
        : qty > 0
        ? `Availability: ${qty} available`
        : 'Availability: Out of stock';
    } else {
      elements.apparelStockNote.textContent = state.apparelDefaultNote || elements.apparelStockNote.textContent;
    }
  } catch (_) {
    elements.apparelStockNote.textContent = state.apparelDefaultNote || elements.apparelStockNote.textContent;
  }
}

function resetApparelSelectors() {
  state.activeApparelProductHandle = null;
  state.activeApparelColor = null;
  if (elements.apparelProductSelect) {
    elements.apparelProductSelect.value = '';
  }
  if (elements.apparelColorSelect) {
    elements.apparelColorSelect.innerHTML = '<option value="">Select a product first</option>';
    elements.apparelColorSelect.disabled = true;
  }
  if (elements.apparelSizeSelect) {
    elements.apparelSizeSelect.innerHTML = '<option value="">Select a color first</option>';
    elements.apparelSizeSelect.disabled = true;
  }
  if (elements.apparelQuantityInput) {
    elements.apparelQuantityInput.value = '1';
    elements.apparelQuantityInput.disabled = true;
  }
  if (elements.apparelAddButton) {
    elements.apparelAddButton.disabled = true;
  }
  updateApparelPreview(null);
}

async function loadSsawConfig() {
      try {
        const res = await fetch(SSAW_CONFIG_ENDPOINT, { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        state.ssawPreferredWarehouse = (data?.preferredWarehouse || '').toUpperCase();
        state.ssawVisibleCategories = Array.isArray(data?.visibleCategories) ? data.visibleCategories : [];
        state.ssawVisibleBrands = Array.isArray(data?.visibleBrands) ? data.visibleBrands : [];
        state.ssawVisibleStyleIncludes = Array.isArray(data?.visibleStyleIncludes) ? data.visibleStyleIncludes : [];
        state.ssawVisibleStyleIds = Array.isArray(data?.visibleStyleIds) ? data.visibleStyleIds : [];
      } catch (error) {
        state.ssawPreferredWarehouse = '';
        state.ssawVisibleCategories = [];
        state.ssawVisibleBrands = [];
        state.ssawVisibleStyleIncludes = [];
        state.ssawVisibleStyleIds = [];
      }
    }

async function loadOnHandApparelItems() {
  if (state.ssawOnHandLoaded) return state.ssawOnHand;
  try {
    const res = await fetch('/api/inventory?material=apparel-ssaw', { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    const items = Array.isArray(data.items) ? data.items : [];
    state.ssawOnHand = new Map();
    items.forEach((it) => {
      if (it?.name) {
        state.ssawOnHand.set(it.name, { id: it.id, name: it.name, size: it.size || '', quantity: Number(it.quantity) || 0, material: it.material || 'apparel-ssaw' });
      }
    });
    state.ssawOnHandLoaded = true;
  } catch (error) {
    console.warn('Unable to load on-hand apparel inventory:', error);
    state.ssawOnHand = new Map();
    state.ssawOnHandLoaded = true;
  }
  return state.ssawOnHand;
}

async function getOnHandForSku(sku) {
  if (!sku) return { quantity: 0, id: null };
  if (!state.ssawOnHandLoaded) await loadOnHandApparelItems();
  const entry = state.ssawOnHand.get(sku);
  return entry ? { quantity: Number(entry.quantity) || 0, id: entry.id } : { quantity: 0, id: null };
}

function ensureOnHandControls() {
  if (!elements.apparelFieldset) return null;
  let wrap = document.getElementById('apparelOnHandWrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'apparelOnHandWrap';
    wrap.style.margin = '8px 0';
    wrap.style.display = 'none';
    wrap.innerHTML = `
      <label style="display:inline-block;margin-right:8px;">On hand</label>
      <input id="apparelOnHandInput" type="number" min="0" step="1" style="width:90px;margin-right:8px;" />
      <button id="apparelOnHandSave" type="button" class="secondary">Save</button>
      <span id="apparelOnHandStatus" class="meta" style="margin-left:10px;opacity:0.85;"></span>
    `;
    const anchor = elements.apparelQuantityInput?.parentElement || elements.apparelFieldset;
    anchor.parentElement?.insertBefore(wrap, anchor.nextSibling);
    const saveBtn = wrap.querySelector('#apparelOnHandSave');
    saveBtn.addEventListener('click', handleOnHandSave);
  }
  return wrap;
}

async function updateOnHandUIForSelectedVariant() {
  const wrap = ensureOnHandControls();
  if (!wrap) return;
  const variant = getSelectedApparelVariant();
  const product = getSelectedApparelProduct();
  if (!variant || !product || product.source !== 'ssaw') {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = '';
  const sku = variant.sku;
  const status = document.getElementById('apparelOnHandStatus');
  const input = document.getElementById('apparelOnHandInput');
  status.textContent = 'Checking on-hand…';
  const info = await getOnHandForSku(sku);
  input.value = String(info.quantity || 0);
  status.textContent = `Current on hand: ${info.quantity || 0}`;
}

async function handleOnHandSave() {
  const variant = getSelectedApparelVariant();
  const product = getSelectedApparelProduct();
  const input = document.getElementById('apparelOnHandInput');
  const status = document.getElementById('apparelOnHandStatus');
  if (!variant || !product || product.source !== 'ssaw' || !input) return;
  const sku = variant.sku;
  const desired = Math.max(0, Math.round(Number(input.value) || 0));
  const currentInfo = await getOnHandForSku(sku);
  try {
    if (!currentInfo.id) {
      // Create
      const payload = {
        name: sku,
        material: 'apparel-ssaw',
        size: variant.size || null,
        quantity: desired,
        unit: 'pcs',
        notes: `${product.title || product.handle || 'Apparel'} ${variant.color || ''} ${variant.size || ''}`.trim()
      };
      const res = await fetch('/api/inventory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Unable to create inventory item');
      state.ssawOnHand.set(sku, { id: data.item.id, name: sku, size: data.item.size || variant.size || '', quantity: Number(data.item.quantity) || desired, material: 'apparel-ssaw' });
      status.textContent = `Saved. Current on hand: ${Number(data.item.quantity) || desired}`;
      updateApparelAvailabilityNotes();
    } else {
      const delta = desired - (currentInfo.quantity || 0);
      if (delta !== 0) {
        const res = await fetch(`/api/inventory/${encodeURIComponent(currentInfo.id)}/adjust`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ change: delta, reason: 'manual-update', notes: 'SSAW on-hand update' })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || 'Unable to adjust on-hand');
        state.ssawOnHand.set(sku, { id: data.item.id, name: sku, size: data.item.size || variant.size || '', quantity: Number(data.item.quantity) || desired, material: 'apparel-ssaw' });
        status.textContent = `Saved. Current on hand: ${Number(data.item.quantity) || desired}`;
        updateApparelAvailabilityNotes();
      } else {
        status.textContent = `No change. Current on hand: ${currentInfo.quantity || 0}`;
      }
    }
  } catch (error) {
    console.error('Save on-hand failed:', error);
    status.textContent = 'Save failed';
  }
}

  function buildSsawSearchUI() {
  if (!elements.apparelFieldset) return null;
  // Avoid duplicate injection
  if (elements.apparelFieldset.querySelector('.apparel-ssaw-search')) return null;
  const container = document.createElement('div');
  container.className = 'apparel-ssaw-search';
  container.style.margin = '8px 0 12px';
  const qInput = document.createElement('input');
  qInput.type = 'search';
  qInput.placeholder = 'Search S&S (e.g., hoodie, 3001, brand)';
  qInput.style.minWidth = '220px';
  qInput.style.marginRight = '8px';
  const brandInput = document.createElement('input');
  brandInput.type = 'text';
  brandInput.placeholder = 'Brand (optional)';
  brandInput.style.minWidth = '160px';
  brandInput.style.marginRight = '8px';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'secondary';
  btn.textContent = 'Search S&S';
  const status = document.createElement('span');
  status.style.marginLeft = '10px';
  status.style.fontSize = '12px';
  status.style.opacity = '0.8';
  container.appendChild(qInput);
  container.appendChild(brandInput);
  container.appendChild(btn);
  container.appendChild(status);
  // Insert near the product selector if it's inside the same fieldset; otherwise prepend safely
  const fieldset = elements.apparelFieldset;
  let anchor = null;
  if (elements.apparelProductSelect) {
    const candidate = elements.apparelProductSelect.parentElement;
    if (candidate && fieldset.contains(candidate)) {
      anchor = candidate;
    }
  }
  try {
    if (anchor && anchor.parentNode === fieldset) {
      fieldset.insertBefore(container, anchor);
    } else if (fieldset.firstChild) {
      fieldset.insertBefore(container, fieldset.firstChild);
    } else {
      fieldset.appendChild(container);
    }
  } catch (e) {
    // Fallback: append if insertBefore fails for any reason
    fieldset.appendChild(container);
  }

  const setStatus = (msg) => (status.textContent = msg || '');
  const onSearch = async () => {
    const q = (qInput.value || '').trim();
    const brand = (brandInput.value || '').trim();
    if (!q) {
      setStatus('Enter a search term.');
      return;
    }
    try {
      setStatus('Searching…');
      const url = `${SSAW_STYLES_ENDPOINT}?q=${encodeURIComponent(q)}${brand ? `&brand=${encodeURIComponent(brand)}` : ''}`;
      const res = await fetch(url, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      let styles = Array.isArray(data.styles) ? data.styles : [];
      // Filter by visibility config if present
      const allowedCats = Array.isArray(state.ssawVisibleCategories) ? state.ssawVisibleCategories : [];
      const allowedBrands = Array.isArray(state.ssawVisibleBrands) ? state.ssawVisibleBrands : [];
      const includeTokens = Array.isArray(state.ssawVisibleStyleIncludes) ? state.ssawVisibleStyleIncludes : [];
      const allowedStyleIds = Array.isArray(state.ssawVisibleStyleIds) ? state.ssawVisibleStyleIds : [];
      if (allowedCats.length || allowedBrands.length) {
        styles = styles.filter((s) => {
          const catOk = allowedCats.length ? allowedCats.includes((s.productType || '').toLowerCase()) : true;
          const brandOk = allowedBrands.length ? allowedBrands.includes(s.brandName || '') : true;
          let styleOk = true;
          if (allowedStyleIds.length) {
            styleOk = allowedStyleIds.includes(String(s.styleID || ''));
          } else if (includeTokens.length) {
            const hay = `${(s.styleName || '').toLowerCase()} ${(s.title || '').toLowerCase()}`;
            styleOk = includeTokens.some((tok) => hay.includes(tok));
          }
          return catOk && brandOk && styleOk;
        });
      }
      // Remove existing SSAW products
      state.apparelProducts = state.apparelProducts.filter((p) => p.source !== 'ssaw');
      // Append SSAW styles
      styles.forEach((s) => {
        const handle = `ssaw-${s.styleID}`;
        if (state.apparelProducts.some((p) => p.handle === handle)) return;
        state.apparelProducts.push({
          handle,
          title: `${s.brandName || ''} ${s.styleName || ''} ${s.title || ''}`.trim(),
          vendor: 'S&S Activewear',
          productType: s.productType || 'tshirt',
          styleID: s.styleID,
          brandName: s.brandName,
          styleName: s.styleName,
          source: 'ssaw',
          variants: []
        });
      });
      state.apparelProducts.sort((a, b) => (a.title || a.handle || '').localeCompare(b.title || b.handle || ''));
      populateApparelProductSelect(state.apparelProducts);
      if (elements.apparelProductSelect) {
        elements.apparelProductSelect.value = styles.length ? `ssaw-${styles[0].styleID}` : '';
        elements.apparelProductSelect.dispatchEvent(new Event('change'));
      }
      setStatus(styles.length ? `${styles.length} result(s)` : 'No results');
    } catch (error) {
      console.warn('SSAW search failed:', error);
      setStatus('Search failed');
    }
  };
  btn.addEventListener('click', onSearch);
  qInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onSearch();
    }
  });
  return container;
}

// Visual S&S browser: categories → brands → styles
function buildSsawBrowserUI() {
  if (!elements.apparelFieldset) return null;
  // Prevent duplicates
  if (elements.apparelFieldset.querySelector('.apparel-ssaw-browser')) return null;

  const container = document.createElement('section');
  container.className = 'apparel-ssaw-browser';
  container.setAttribute('aria-label', 'Browse S&S apparel');

  const header = document.createElement('header');
  const title = document.createElement('h3');
  title.textContent = 'Browse S&S by category';
  const subtitle = document.createElement('p');
  subtitle.className = 'hint';
  subtitle.textContent = 'Pick a category, then brand, then a style. Images are provided by the S&S API.';
  header.appendChild(title);
  header.appendChild(subtitle);

  const crumbs = document.createElement('nav');
  crumbs.className = 'ssaw-crumbs';
  const crumbsList = document.createElement('ul');
  crumbs.appendChild(crumbsList);

  const status = document.createElement('div');
  status.className = 'ssaw-status';

  const categoriesRoot = document.createElement('div');
  categoriesRoot.className = 'ssaw-grid';
  const brandsRoot = document.createElement('div');
  brandsRoot.className = 'ssaw-grid';
  const stylesRoot = document.createElement('div');
  stylesRoot.className = 'ssaw-grid';

  const controlsBar = document.createElement('div');
  controlsBar.className = 'ssaw-controls';
  const inStockWrap = document.createElement('label');
  inStockWrap.className = 'ssaw-toggle';
  const inStockCheckbox = document.createElement('input');
  inStockCheckbox.type = 'checkbox';
  inStockCheckbox.checked = true;
  const inStockLabel = document.createElement('span');
  inStockLabel.textContent = 'Only show in-stock at preferred warehouse';
  inStockWrap.appendChild(inStockCheckbox);
  inStockWrap.appendChild(inStockLabel);
  controlsBar.appendChild(inStockWrap);

  const sections = document.createElement('div');
  sections.className = 'ssaw-sections';
  const categoriesSection = document.createElement('div');
  const brandsSection = document.createElement('div');
  const stylesSection = document.createElement('div');
  const brandsHeading = document.createElement('h4');
  brandsHeading.textContent = 'Brands';
  const stylesHeading = document.createElement('h4');
  stylesHeading.textContent = 'Styles';
  categoriesSection.appendChild(categoriesRoot);
  brandsSection.appendChild(brandsHeading);
  brandsSection.appendChild(brandsRoot);
  stylesSection.appendChild(stylesHeading);
  stylesSection.appendChild(stylesRoot);
  sections.appendChild(categoriesSection);
  sections.appendChild(brandsSection);
  sections.appendChild(stylesSection);

  container.appendChild(header);
  container.appendChild(crumbs);
  container.appendChild(status);
  container.appendChild(controlsBar);
  container.appendChild(sections);

  // Insert near the top of the apparel fieldset, after any search UI if present
  try {
    const anchor = elements.apparelFieldset.querySelector('.apparel-controls') || elements.apparelFieldset.firstChild;
    if (anchor && anchor.parentNode === elements.apparelFieldset) {
      elements.apparelFieldset.insertBefore(container, anchor);
    } else {
      elements.apparelFieldset.appendChild(container);
    }
  } catch (e) {
    elements.apparelFieldset.appendChild(container);
  }

  let SSAW_CATEGORIES = [
    { id: 'tshirt', label: 'T-Shirts', query: 't-shirt' },
    { id: 'longsleeve', label: 'Long-Sleeve Tees', query: 'long sleeve' },
    { id: 'polo', label: 'Polos', query: 'polo' },
    { id: 'hoodie', label: 'Hoodies & Sweatshirts', query: 'hood' },
    { id: 'outerwear', label: 'Jackets & Outerwear', query: 'jacket' },
    { id: 'hat', label: 'Hats & Caps', query: 'cap' },
    { id: 'beanie', label: 'Beanies', query: 'beanie' },
    { id: 'accessory', label: 'Accessories', query: 'accessor' },
    { id: 'drinkware', label: 'Drinkware', query: 'drink' }
  ];

  // Apply visibility filter if present
  try {
    const allowed = Array.isArray(state.ssawVisibleCategories) ? state.ssawVisibleCategories : [];
    if (allowed.length) {
      SSAW_CATEGORIES = SSAW_CATEGORIES.filter((c) => allowed.includes(c.id));
    }
  } catch (_) {}

  const cache = {
    categories: new Map(), // key: id -> { styles, brands }
    brandStyles: new Map(), // key: id:brand -> styles
    availability: new Map() // key: styleID -> boolean
  };

  const viewState = {
    category: null, // { id, label, query }
    brand: null, // string
    onlyInStock: true
  };

  function setStatus(message) {
    status.textContent = message || '';
  }

  async function fetchStyles({ q = '', brand = '', category = '' } = {}) {
    const params = [];
    if (q) params.push(`q=${encodeURIComponent(q)}`);
    if (brand) params.push(`brand=${encodeURIComponent(brand)}`);
    if (category) params.push(`category=${encodeURIComponent(category)}`);
    const url = `${SSAW_STYLES_ENDPOINT}${params.length ? `?${params.join('&')}` : ''}`;
    try {
      const res = await fetch(url, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      const styles = Array.isArray(data.styles) ? data.styles : [];
      // Enforce customer visibility (only curated style IDs if present)
      const allowedStyleIds = Array.isArray(state.ssawVisibleStyleIds)
        ? state.ssawVisibleStyleIds.map((id) => String(id))
        : [];
      if (allowedStyleIds.length) {
        return styles.filter((s) => allowedStyleIds.includes(String(s.styleID || '')));
      }
      return styles;
    } catch (err) {
      console.warn('SSAW styles fetch failed:', err);
      return [];
    }
  }

  function buildCard({ title, imageUrl, subtitle } = {}) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'ssaw-card';
    const media = document.createElement('div');
    media.className = 'ssaw-card__media';
    if (imageUrl) {
      const img = document.createElement('img');
      img.src = imageUrl;
      img.alt = title || subtitle || 'Preview';
      img.loading = 'lazy';
      media.appendChild(img);
    } else {
      const fallback = document.createElement('div');
      fallback.className = 'ssaw-card__fallback';
      fallback.textContent = (title || '?').charAt(0).toUpperCase();
      media.appendChild(fallback);
    }
    const body = document.createElement('div');
    body.className = 'ssaw-card__body';
    const h = document.createElement('strong');
    h.textContent = title || 'Untitled';
    body.appendChild(h);
    if (subtitle) {
      const p = document.createElement('span');
      p.className = 'ssaw-card__meta';
      p.textContent = subtitle;
      body.appendChild(p);
    }
    card.appendChild(media);
    card.appendChild(body);
    return card;
  }

  function renderCrumbs() {
    crumbsList.innerHTML = '';
    const addCrumb = (label, onclick, isCurrent) => {
      const li = document.createElement('li');
      const a = document.createElement('button');
      a.type = 'button';
      a.textContent = label;
      a.className = isCurrent ? 'current' : '';
      if (onclick) a.addEventListener('click', onclick);
      li.appendChild(a);
      crumbsList.appendChild(li);
    };
    addCrumb('Categories', () => resetToCategories(), !viewState.category);
    if (viewState.category) {
      addCrumb(viewState.category.label, () => resetToBrands(), !viewState.brand);
    }
    if (viewState.category && viewState.brand) {
      addCrumb(viewState.brand, null, true);
    }
    // toggle visibility of sections
    categoriesSection.style.display = viewState.category ? 'none' : '';
    brandsSection.style.display = viewState.category ? '' : 'none';
    stylesSection.style.display = viewState.brand ? '' : 'none';
    // show or hide in-stock filter
    controlsBar.style.display = viewState.category ? '' : 'none';
  }

  function resetToCategories() {
    viewState.category = null;
    viewState.brand = null;
    brandsRoot.innerHTML = '';
    stylesRoot.innerHTML = '';
    setStatus('');
    renderCrumbs();
    try { container.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) {}
  }

  function resetToBrands() {
    viewState.brand = null;
    stylesRoot.innerHTML = '';
    setStatus('');
    renderCrumbs();
  }

  function ensureSsawProduct(style) {
    if (!style || !style.styleID) return null;
    const handle = `ssaw-${style.styleID}`;
    const exists = state.apparelProducts.some((p) => p.handle === handle);
    if (!exists) {
      state.apparelProducts.push({
        handle,
        title: `${style.brandName || ''} ${style.styleName || ''} ${style.title || ''}`.trim(),
        vendor: 'S&S Activewear',
        productType: style.productType || 'tshirt',
        styleID: style.styleID,
        brandName: style.brandName,
        styleName: style.styleName,
        source: 'ssaw',
        variants: []
      });
      state.apparelProducts.sort((a, b) => (a.title || a.handle || '').localeCompare(b.title || b.handle || ''));
      populateApparelProductSelect(state.apparelProducts);
    }
    return handle;
  }

  function selectProductHandle(handle) {
    if (!elements.apparelProductSelect) return;
    elements.apparelProductSelect.value = handle || '';
    elements.apparelProductSelect.dispatchEvent(new Event('change'));
    scrollApparelSectionIntoView();
  }

  function renderCategories() {
    categoriesRoot.innerHTML = '';
    SSAW_CATEGORIES.forEach(async (cat) => {
      // Pre-fetch representative style for the card image
      const cached = cache.categories.get(cat.id);
      let previewUrl = cached?.previewUrl;
      if (!previewUrl) {
        const styles = await fetchStyles({ q: cat.query });
        const first = styles.find((s) => s.imageUrl);
        previewUrl = first?.imageUrl || '';
        cache.categories.set(cat.id, { styles, previewUrl });
      }
      const card = buildCard({ title: cat.label, imageUrl: previewUrl });
      card.addEventListener('click', () => onCategoryClick(cat));
      categoriesRoot.appendChild(card);
    });
  }

  function groupBrands(styles) {
    const map = new Map();
    styles.forEach((s) => {
      const brand = (s.brandName || 'Other').trim();
      if (!map.has(brand)) map.set(brand, []);
      map.get(brand).push(s);
    });
    // Sort brands by count desc then alpha
    const entries = Array.from(map.entries());
    entries.sort((a, b) => {
      if (b[1].length !== a[1].length) return b[1].length - a[1].length;
      return a[0].localeCompare(b[0]);
    });
    return entries;
  }

  function onCategoryClick(cat) {
    viewState.category = cat;
    viewState.brand = null;
    setStatus(`Loading ${cat.label} brands…`);
    brandsRoot.innerHTML = '';
    stylesRoot.innerHTML = '';
    (async () => {
      renderCrumbs();
      let entry = cache.categories.get(cat.id);
      if (!entry || !Array.isArray(entry.styles) || !entry.styles.length) {
        const styles = await fetchStyles({ q: cat.query });
        entry = { styles, previewUrl: entry?.previewUrl || '' };
        cache.categories.set(cat.id, entry);
      }
      // Apply curated style ID filter if present
      const allowedStyleIds = Array.isArray(state.ssawVisibleStyleIds)
        ? state.ssawVisibleStyleIds.map((id) => String(id))
        : [];
      const filteredStyles = allowedStyleIds.length
        ? (entry.styles || []).filter((s) => allowedStyleIds.includes(String(s.styleID || '')))
        : (entry.styles || []);
      const brandEntries = groupBrands(filteredStyles).slice(0, 12);
      if (!brandEntries.length) {
        setStatus('No brands found for this category.');
        return;
      }
      setStatus('');
      brandEntries.forEach(([brand, styles]) => {
        const preview = styles.find((s) => s.imageUrl)?.imageUrl || '';
        const card = buildCard({ title: brand, imageUrl: preview, subtitle: `${styles.length} style(s)` });
        card.addEventListener('click', () => onBrandClick(cat, brand));
        brandsRoot.appendChild(card);
      });
      // Scroll into view when brands render
      try { container.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) {}
    })();
  }

  async function ensurePreferredWarehouse() {
    if (!state.ssawPreferredWarehouse) {
      await loadSsawConfig();
    }
    return (state.ssawPreferredWarehouse || '').toUpperCase();
  }

  async function styleHasPreferredInventory(style, preferredCode) {
    const key = String(style.styleID || style.id || '');
    if (!key || !preferredCode) return true;
    if (cache.availability.has(key)) return cache.availability.get(key);
    try {
      const res = await fetch(`${SSAW_PRODUCTS_ENDPOINT}?style=${encodeURIComponent(key)}`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      const variants = Array.isArray(data.variants) ? data.variants : [];
      const ok = variants.some((v) => Array.isArray(v.warehouses) && v.warehouses.some((w) => String(w.abbr || '').toUpperCase() === preferredCode && Number(w.qty) > 0));
      cache.availability.set(key, ok);
      return ok;
    } catch (e) {
      cache.availability.set(key, false);
      return false;
    }
  }

  function onBrandClick(cat, brand) {
    viewState.brand = brand;
    setStatus(`Loading ${brand} ${cat.label}…`);
    stylesRoot.innerHTML = '';
    (async () => {
      const key = `${cat.id}:${brand}`;
      let list = cache.brandStyles.get(key);
      if (!list) {
        // Prefer brand filter; fallback to client-side filter if API brand filter missing
        const styles = await fetchStyles({ q: cat.query, brand });
        list = styles.length ? styles : (cache.categories.get(cat.id)?.styles || []).filter((s) => (s.brandName || '').trim() === brand);
        cache.brandStyles.set(key, list);
      }
      // Enforce curated style IDs if present
      const allowedStyleIds = Array.isArray(state.ssawVisibleStyleIds)
        ? state.ssawVisibleStyleIds.map((id) => String(id))
        : [];
      if (allowedStyleIds.length) {
        list = list.filter((s) => allowedStyleIds.includes(String(s.styleID || '')));
      }
      if (!list.length) {
        setStatus('No styles found for this brand.');
        return;
      }
      renderCrumbs();

      // Apply in-stock filter if preferred warehouse is set and toggle is on
      const preferred = await ensurePreferredWarehouse();
      let filtered = list.slice(0, 30);
      if (preferred && viewState.onlyInStock) {
        setStatus(`Checking ${brand} stock in ${preferred}…`);
        const checks = await Promise.all(
          filtered.map(async (style) => ({ style, ok: await styleHasPreferredInventory(style, preferred) }))
        );
        filtered = checks.filter((c) => c.ok).map((c) => c.style);
      }
      setStatus('');
      if (!filtered.length) {
        const msg = document.createElement('p');
        msg.className = 'hint';
        msg.textContent = preferred && viewState.onlyInStock
          ? `No styles currently in stock at ${preferred}.`
          : 'No styles to display.';
        stylesRoot.appendChild(msg);
      }
      filtered.forEach((style) => {
        const title = `${style.styleName || ''} ${style.title || ''}`.trim() || style.brandName || 'Style';
        const card = buildCard({ title, imageUrl: style.imageUrl, subtitle: style.brandName || '' });
        card.addEventListener('click', () => {
          const handle = ensureSsawProduct(style);
          if (handle) selectProductHandle(handle);
        });
        stylesRoot.appendChild(card);
      });
      try { stylesRoot.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) {}
    })();
  }

  // Kick off with categories
  renderCategories();
  renderCrumbs();

  // Wire the in-stock toggle
  inStockCheckbox.addEventListener('change', () => {
    viewState.onlyInStock = Boolean(inStockCheckbox.checked);
    if (viewState.category && viewState.brand) {
      onBrandClick(viewState.category, viewState.brand);
    }
  });

  // Show preferred code in toggle label if configured
  (async () => {
    const preferred = await ensurePreferredWarehouse();
    if (!preferred) {
      inStockWrap.style.display = 'none';
    } else {
      inStockLabel.textContent = `Only show in-stock at ${preferred}`;
    }
  })();

  return container;
}

function populateApparelProductSelect(products) {
  if (!elements.apparelProductSelect) return;
  const select = elements.apparelProductSelect;
  select.innerHTML = '';
  if (!Array.isArray(products) || !products.length) {
    select.innerHTML = '<option value="">No apparel products available</option>';
    select.disabled = true;
    resetApparelSelectors();
    return;
  }
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Select a product...';
  select.appendChild(placeholder);
  products.forEach((product) => {
    const option = document.createElement('option');
    option.value = product.handle;
    const vendor = product.vendor ? ` · ${product.vendor}` : '';
    option.textContent = `${product.title || product.handle}${vendor}`;
    select.appendChild(option);
  });
  select.disabled = false;
}

function getSelectedApparelProduct() {
  if (!state.activeApparelProductHandle) return null;
  return (
    state.apparelProducts.find(
      (product) => product.handle === state.activeApparelProductHandle
    ) || null
  );
}

function getSelectedApparelVariant() {
  const product = getSelectedApparelProduct();
  if (!product) return null;
  const color = elements.apparelColorSelect?.value || '';
  const size = elements.apparelSizeSelect?.value || '';
  if (!color || !size) return null;
  const variantIndex = ensureApparelVariantIndex(product);
  const sizeMap = variantIndex?.get(color);
  if (!sizeMap) return null;
  return sizeMap.get(size) || null;
}

function updateApparelPreview(variant) {
  if (!elements.apparelPreviewImage || !elements.apparelPreviewPlaceholder) return;
  try { if (window.__APPAREL_ONLY__) initApparelFabric(); } catch (_) {}
  // Also apply variant image as background for main preview stage
  const applyStageBg = (url) => {
    if (!elements.previewStage) return;
    if (url) {
      try {
        // Escape quotes in URL to keep CSS valid
        const safe = String(url).replace(/"/g, '\\"');
        elements.previewStage.style.setProperty("--apparel-bg", `url("${safe}")`);
        elements.previewStage.classList.add('has-apparel-bg');
      } catch (_) {
        elements.previewStage.style.setProperty('--apparel-bg','none');
        elements.previewStage.classList.remove('has-apparel-bg');
      }
    } else {
      elements.previewStage.style.setProperty('--apparel-bg','none');
      elements.previewStage.classList.remove('has-apparel-bg');
    }
  };
  if (variant && variant.imageUrl) {
    elements.apparelPreviewImage.src = variant.imageUrl;
    elements.apparelPreviewImage.hidden = false;
    elements.apparelPreviewPlaceholder.textContent = `${variant.title || 'Apparel item'} preview`;
    elements.apparelPreviewImage.onload = () => { try { updateApparelOverlay(); } catch (_) {} };
    applyStageBg(variant.imageUrl);
  } else {
    const placeholderSrc = getApparelPlaceholder(variant?.productType);
    if (placeholderSrc) {
      elements.apparelPreviewImage.src = placeholderSrc;
      elements.apparelPreviewImage.hidden = false;
      elements.apparelPreviewImage.onload = () => { try { updateApparelOverlay(); } catch (_) {} };
      applyStageBg(placeholderSrc);
    } else if (!elements.apparelPreviewImage.hidden) {
      elements.apparelPreviewImage.hidden = true;
      elements.apparelPreviewImage.removeAttribute('src');
      try { clearApparelOverlay(); } catch (_) {}
      applyStageBg('');
    }
    const product = getSelectedApparelProduct();
    if (variant?.imageStatus?.status) {
      const statusText =
        variant.imageStatus.status === 403
          ? 'Vendor blocks direct image access (HTTP 403).'
          : `Preview unavailable (HTTP ${variant.imageStatus.status}).`;
      elements.apparelPreviewPlaceholder.textContent = statusText;
    } else {
      elements.apparelPreviewPlaceholder.textContent = product
        ? 'Preview image not available for this variant.'
        : 'Choose a product, color, and size to preview the blank garment.';
    }
  }
  if (elements.apparelAddButton) {
    elements.apparelAddButton.disabled = !variant;
  }
}

function clearApparelOverlay() {
  const canvas = elements.apparelOverlayCanvas;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function updateApparelOverlay() {
  // If Fabric overlay is active, Fabric handles rendering and interaction
  if (state.apparelFabric) return;
  const canvas = elements.apparelOverlayCanvas;
  const garmentImg = elements.apparelPreviewImage;
  const srcCanvas = elements.previewCanvas;
  if (!canvas || !garmentImg || !srcCanvas) return;
  if (garmentImg.hidden) { clearApparelOverlay(); return; }

  const scale = Math.max(0.2, Math.min(1, Number(state.overlayScale) || 0.6));
  const targetWidth = Math.round((garmentImg.clientWidth || 160) * scale);
  const srcW = srcCanvas.width;
  const srcH = srcCanvas.height;
  if (!srcW || !srcH || !targetWidth) { clearApparelOverlay(); return; }
  const pixScale = targetWidth / srcW;
  const targetHeight = Math.max(1, Math.round(srcH * pixScale));

  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  try {
    const off = document.createElement('canvas');
    off.width = targetWidth;
    off.height = targetHeight;
    const octx = off.getContext('2d');
    // Draw current preview (already mono if user enabled recolor; otherwise multi-color)
    octx.drawImage(srcCanvas, 0, 0, off.width, off.height);
    const imgData = octx.getImageData(0, 0, off.width, off.height);
    const data = imgData.data;
    // Determine background reference (prefer configured background color; fallback to sampled 0,0)
    const bg = hexToRgb(state.backgroundColor || '#f8fafc');
    const sampleR = data[0], sampleG = data[1], sampleB = data[2];
    const ref = {
      r: (bg.r + sampleR) / 2,
      g: (bg.g + sampleG) / 2,
      b: (bg.b + sampleB) / 2
    };
    const threshold = 26; // RGB distance threshold to treat as background
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
      if (a < 8) { data[i+3] = 0; continue; }
      const dr = r - ref.r, dg = g - ref.g, db = b - ref.b;
      const dist = Math.sqrt(dr*dr + dg*dg + db*db);
      if (dist < threshold) {
        data[i+3] = 0; // make background transparent
      }
    }
    octx.putImageData(imgData, 0, 0);
    ctx.drawImage(off, 0, 0);
  } catch (_) {
    // Fallback: draw as-is
    ctx.drawImage(srcCanvas, 0, 0, canvas.width, canvas.height);
  }

  // Position overlay relative to garment image
  const imgRect = garmentImg.getBoundingClientRect();
  const wrapRect = garmentImg.parentElement.getBoundingClientRect();
  const relX = Math.max(0, Math.min(100, Number(state.overlayPosX) || 50));
  const relY = Math.max(0, Math.min(100, Number(state.overlayPosY) || 12));
  const centerLeft = wrapRect.left + (imgRect.width * relX) / 100 + (imgRect.left - wrapRect.left);
  const centerTop = wrapRect.top + (imgRect.height * relY) / 100 + (imgRect.top - wrapRect.top);
  // Convert center to percentage of wrapper for CSS top/left
  const leftPct = ((centerLeft - wrapRect.left) / wrapRect.width) * 100;
  const topPct = ((centerTop - wrapRect.top) / wrapRect.height) * 100;
  canvas.style.left = `${leftPct}%`;
  canvas.style.top = `${topPct}%`;
}

// use the shared hexToRgb declared later in this file

function handleApparelProductChange() {
  if (!elements.apparelProductSelect) return;
  const handle = elements.apparelProductSelect.value;
  state.activeApparelProductHandle = handle || null;
  state.activeApparelColor = null;

  if (!handle) {
    resetApparelSelectors();
    if (elements.apparelProductSelect) {
      elements.apparelProductSelect.disabled = state.apparelProducts.length === 0;
    }
    return;
  }

  let product = state.apparelProducts.find((entry) => entry.handle === handle) || null;
  if (!product) {
    resetApparelSelectors();
    return;
  }

  // If this is a vendor (SSAW) product, fetch its variants lazily
  const maybeLoad = async () => {
    if (product.source === 'ssaw' && (!Array.isArray(product.variants) || !product.variants.length)) {
      await loadSsawVariantsFor(product);
    }
    const variantIndex = ensureApparelVariantIndex(product);
    const colors = Array.from(variantIndex.keys()).sort((a, b) => a.localeCompare(b));
    if (elements.apparelColorSelect) {
      elements.apparelColorSelect.innerHTML = '';
      colors.forEach((color) => {
        const option = document.createElement('option');
        option.value = color;
        option.textContent = color;
        elements.apparelColorSelect.appendChild(option);
      });
      elements.apparelColorSelect.disabled = !colors.length;
    }

    if (!colors.length) {
      if (elements.apparelColorSelect) {
        elements.apparelColorSelect.innerHTML = '<option value="">No colors available</option>';
        elements.apparelColorSelect.disabled = true;
      }
      if (elements.apparelSizeSelect) {
        elements.apparelSizeSelect.innerHTML = '<option value="">No sizes available</option>';
        elements.apparelSizeSelect.disabled = true;
      }
      if (elements.apparelQuantityInput) {
        elements.apparelQuantityInput.value = '1';
        elements.apparelQuantityInput.disabled = true;
      }
      if (elements.apparelAddButton) {
        elements.apparelAddButton.disabled = true;
      }
      updateApparelPreview(null);
      return;
    }

    if (elements.apparelColorSelect) {
      elements.apparelColorSelect.value = colors[0];
    }
    state.activeApparelColor = colors[0];
    if (product.source === 'ssaw') {
      if (!state.ssawPreferredWarehouse) {
        await loadSsawConfig();
      }
      await ensureSsawInventoryForColor(product, colors[0]);
    }
    handleApparelColorChange();
  };

  // run as async but don't block
  if (product.source === 'ssaw') {
    if (elements.apparelColorSelect) {
      elements.apparelColorSelect.disabled = true;
      elements.apparelColorSelect.innerHTML = '<option value="">Loading…</option>';
    }
    if (elements.apparelSizeSelect) {
      elements.apparelSizeSelect.disabled = true;
      elements.apparelSizeSelect.innerHTML = '<option value="">Loading…</option>';
    }
    if (elements.apparelQuantityInput) {
      elements.apparelQuantityInput.disabled = true;
    }
    if (elements.apparelAddButton) {
      elements.apparelAddButton.disabled = true;
    }
  }
  maybeLoad();

}

function handleApparelColorChange() {
  const product = getSelectedApparelProduct();
  if (!product) {
    updateApparelPreview(null);
    return;
  }
  const color = elements.apparelColorSelect?.value || '';
  state.activeApparelColor = color || null;

  if (product.source === 'ssaw' && color) {
    const loaded = product._inventoryLoadedColors && product._inventoryLoadedColors.has(color);
    if (!loaded) {
      ensureSsawInventoryForColor(product, color).then(() => {
        if ((elements.apparelColorSelect?.value || '') === color) {
          // Re-render sizes with live inventory
          handleApparelColorChange();
        }
      });
    }
  }

  const variantIndex = ensureApparelVariantIndex(product);
  const sizeMap = variantIndex.get(color);
  if (!sizeMap || !sizeMap.size) {
    if (elements.apparelSizeSelect) {
      elements.apparelSizeSelect.innerHTML = '<option value="">No sizes available</option>';
      elements.apparelSizeSelect.disabled = true;
    }
    if (elements.apparelQuantityInput) {
      elements.apparelQuantityInput.value = '1';
      elements.apparelQuantityInput.disabled = true;
    }
    if (elements.apparelAddButton) {
      elements.apparelAddButton.disabled = true;
    }
    updateApparelPreview(null);
    return;
  }

  const sizes = Array.from(sizeMap.keys()).sort((a, b) => {
    const diff = getApparelSizeOrder(a) - getApparelSizeOrder(b);
    if (diff !== 0) return diff;
    return a.localeCompare(b);
  });

  if (elements.apparelSizeSelect) {
    elements.apparelSizeSelect.innerHTML = '';
    let firstAvailable = null;
    sizes.forEach((size) => {
      const option = document.createElement('option');
      option.value = size;
      const variant = sizeMap.get(size);
      let displayQty = Number(variant?.qty);
      const pref = (state.ssawPreferredWarehouse || '').toUpperCase();
      if (pref && Array.isArray(variant?.warehouses)) {
        const found = variant.warehouses.find((w) => String(w.abbr || '').toUpperCase() === pref);
        if (found) displayQty = Number(found.qty);
      }
      if (Number.isFinite(displayQty)) {
        option.textContent = pref
          ? displayQty > 0
            ? `${size} (${pref} ${displayQty})`
            : `${size} (out in ${pref})`
          : displayQty > 0
          ? `${size} (qty ${displayQty})`
          : `${size} (out of stock)`;
        option.disabled = displayQty <= 0;
        if (displayQty > 0 && !firstAvailable) firstAvailable = size;
      } else {
        option.textContent = size;
        if (!firstAvailable) firstAvailable = size;
      }
      elements.apparelSizeSelect.appendChild(option);
    });
    elements.apparelSizeSelect.disabled = false;
    elements.apparelSizeSelect.value = firstAvailable || sizes[0];
  }

  if (elements.apparelQuantityInput) {
    elements.apparelQuantityInput.disabled = false;
  }
  handleApparelSizeChange();
  // Update local on-hand controls for this variant
  updateOnHandUIForSelectedVariant();
  // Show the price for the chosen variant
  updateApparelVariantPrice();
  try { updateApparelOverlay(); } catch (_) {}
}

function handleApparelSizeChange() {
  const variant = getSelectedApparelVariant();
  updateApparelPreview(variant);
  const product = getSelectedApparelProduct();
  const color = elements.apparelColorSelect?.value || '';
  const size = elements.apparelSizeSelect?.value || '';
  if (product?.source === 'ssaw' && color && size) {
    renderSsawSizeInventoryNote(product, color, size);
  } else if (elements.apparelStockNote) {
    elements.apparelStockNote.textContent = state.apparelDefaultNote || elements.apparelStockNote.textContent;
  }
  updateOnHandUIForSelectedVariant();
  updateApparelVariantPrice();
  try { updateApparelOverlay(); } catch (_) {}
}

function handleApparelQuantityInput() {
  if (!elements.apparelQuantityInput) return;
  let value = Number(elements.apparelQuantityInput.value) || 1;
  value = Math.min(500, Math.max(1, Math.round(value)));
  elements.apparelQuantityInput.value = String(value);
}

function handleApparelAddItem() {
  const variant = getSelectedApparelVariant();
  if (!variant) {
    alert('Select a product, color, and size before adding apparel.');
    return;
  }
  const quantity = Math.min(
    500,
    Math.max(1, Math.round(Number(elements.apparelQuantityInput?.value) || 1))
  );
  const product = getSelectedApparelProduct() || {};
  const existingIndex = state.selectedApparelItems.findIndex(
    (entry) => entry.sku === variant.sku
  );
  if (existingIndex >= 0) {
    const existing = state.selectedApparelItems[existingIndex];
    existing.quantity += quantity;
    if (!existing.imageUrl && variant.imageUrl) {
      existing.imageUrl = variant.imageUrl;
    }
    if (!existing.imageStatus && variant.imageStatus) {
      existing.imageStatus = variant.imageStatus;
    }
    if (variant.priceCents != null && Number.isFinite(Number(variant.priceCents))) {
      existing.unitPriceCents = roundUpToQuarterDollar(Number(variant.priceCents));
    }
    ensureApparelPricing(existing);
  } else {
    const newItem = {
      sku: variant.sku,
      handle: variant.handle || product.handle || '',
      title: variant.title || product.title || variant.handle || 'Apparel item',
      vendor: variant.vendor || product.vendor || '',
      productType: variant.productType || product.productType || '',
      style: variant.style || product.style || '',
      color: variant.color || state.activeApparelColor || '',
      size: variant.size || '',
      quantity,
      imageUrl: variant.imageUrl || null,
      imageStatus: variant.imageStatus || null,
      productUrl: variant.productUrl || product.productUrl || null,
      colorPageUrl: variant.colorPageUrl || null,
      unitPriceCents:
        variant.priceCents != null && Number.isFinite(Number(variant.priceCents))
          ? roundUpToQuarterDollar(Number(variant.priceCents))
          : undefined
    };
    state.selectedApparelItems.push(ensureApparelPricing(newItem));
  }
  renderSelectedApparelItems();
  if (elements.apparelQuantityInput) {
    elements.apparelQuantityInput.value = '1';
  }
  // Close modal after adding one apparel item to keep the main page uncluttered
  closeApparelModal();
}

function renderSelectedApparelItems() {
  if (!elements.apparelSelectedList) return;
  state.selectedApparelItems.forEach((item) => ensureApparelPricing(item));
  elements.apparelSelectedList.innerHTML = '';
  if (!state.selectedApparelItems.length) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'No apparel add-ons yet.';
    elements.apparelSelectedList.appendChild(hint);
    updatePricingSummary();
    return;
  }
  const list = document.createElement('ul');
  list.className = 'apparel-selected-list';
  state.selectedApparelItems.forEach((item, index) => {
    const li = document.createElement('li');
    li.className = 'apparel-selected-item';
    li.dataset.sku = item.sku;
    const previewSrc = item.imageUrl || getApparelPlaceholder(item.productType);
    if (previewSrc) {
      const img = document.createElement('img');
      img.src = previewSrc;
      img.alt = `${item.title || item.handle || 'Apparel item'} preview`;
      img.loading = 'lazy';
      li.appendChild(img);
    }
    const content = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = `${item.quantity} × ${item.title || item.handle || 'Apparel item'}`;
    content.appendChild(title);
    const meta = document.createElement('div');
    meta.className = 'meta';
    const metaParts = [];
    if (item.color) metaParts.push(item.color);
    if (item.size) metaParts.push(item.size);
    metaParts.push(`SKU ${item.sku}`);
    meta.textContent = metaParts.join(' • ');
    content.appendChild(meta);
    const priceMeta = document.createElement('div');
    priceMeta.className = 'meta';
    if (item.unitPriceCents) {
      priceMeta.textContent = `${formatCents(item.unitPriceCents)} each · ${formatCents(
        item.lineTotalCents || item.unitPriceCents * item.quantity
      )}`;
    } else {
      priceMeta.textContent = 'Pricing to be confirmed';
    }
    content.appendChild(priceMeta);
    // Availability breakdown (on-hand vs order)
    if (String(item.vendor || '').toLowerCase().includes('s&s')) {
      const availability = document.createElement('div');
      availability.className = 'meta';
      availability.dataset.kind = 'availability';
      availability.textContent = 'Checking availability…';
      content.appendChild(availability);
    }
    if (item.productUrl) {
      const link = document.createElement('a');
      link.href = item.productUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Product page';
      content.appendChild(link);
    }
    if (!item.imageUrl && item.imageStatus?.status) {
      const warning = document.createElement('div');
      warning.className = 'meta';
      warning.textContent =
        item.imageStatus.status === 403
          ? 'Preview unavailable (HTTP 403 from vendor).'
          : `Preview unavailable (HTTP ${item.imageStatus.status}).`;
      content.appendChild(warning);
    }
    li.appendChild(content);
    const actions = document.createElement('div');
    actions.className = 'apparel-selected-item-actions';
    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'secondary small';
    removeButton.dataset.action = 'remove-apparel';
    removeButton.dataset.index = String(index);
    removeButton.textContent = 'Remove';
    actions.appendChild(removeButton);
    li.appendChild(actions);
    list.appendChild(li);
  });
  elements.apparelSelectedList.appendChild(list);
  updatePricingSummary();
  // Async availability update
  updateApparelAvailabilityNotes();
  // Update badge near the open button
  updateApparelButtonBadge();
}

async function updateApparelAvailabilityNotes() {
  if (!elements.apparelSelectedList) return;
  // Ensure cache
  await loadOnHandApparelItems();
  const items = state.selectedApparelItems || [];
  items.forEach((entry, idx) => {
    const sku = entry.sku;
    const node = elements.apparelSelectedList.querySelector(`li.apparel-selected-item[data-sku="${CSS.escape(sku)}"] .meta[data-kind="availability"]`);
    if (!node) return;
    const onHandInfo = state.ssawOnHand.get(sku);
    const onHand = Number(onHandInfo?.quantity) || 0;
    const qty = Math.max(1, Number(entry.quantity) || 1);
    const useOnHand = Math.min(onHand, qty);
    const toOrder = Math.max(0, qty - useOnHand);
    if (toOrder > 0) {
      node.textContent = `Availability: ${useOnHand} on hand · ${toOrder} to order (+2–3 business days)`;
    } else {
      node.textContent = `Availability: ${useOnHand} on hand`;
    }
  });
}

function handleApparelListClick(event) {
  const button = event.target.closest('button[data-action="remove-apparel"]');
  if (!button) return;
  const index = Number(button.dataset.index);
  if (!Number.isFinite(index) || index < 0) return;
  state.selectedApparelItems.splice(index, 1);
  renderSelectedApparelItems();
}

function clearApparelSelections() {
  state.selectedApparelItems = [];
  renderSelectedApparelItems();
}

async function loadApparelProducts() {
  if (!elements.apparelProductSelect) return;
  try {
    elements.apparelProductSelect.disabled = true;
    elements.apparelProductSelect.innerHTML =
      '<option value="">Loading apparel catalog...</option>';
    const response = await fetch(APPAREL_PRODUCTS_ENDPOINT, { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.error || `Apparel catalog failed (${response.status})`);
    }
    const products = Array.isArray(data.products)
      ? data.products.filter(
          (product) => Array.isArray(product?.variants) && product.variants.length
        )
      : [];
    // Include built-in pre-made apparel
    products.push(buildPremadeApparelProduct());
    products.sort((a, b) =>
      (a.title || a.handle || '').localeCompare(b.title || b.handle || '')
    );
    state.apparelProducts = products;
    state.apparelVariantIndex = new Map();
    state.apparelCatalogLoaded = true;
    populateApparelProductSelect(products);
    resetApparelSelectors();
    // Add S&S search UI above the product selector
    buildSsawSearchUI();
    // Add visual S&S browser (categories → brands → styles)
    buildSsawBrowserUI();
    if (elements.apparelStockNote) {
      elements.apparelStockNote.textContent =
        products.length > 0
          ? state.apparelDefaultNote || elements.apparelStockNote.textContent
          : 'No apparel products were returned. Confirm the CSV files are present and restart the save server.';
    }
  } catch (error) {
    console.error('Unable to load apparel catalog:', error);
    // Fallback to built-in pre-made apparel product
    const fallbackProducts = [buildPremadeApparelProduct()];
    state.apparelProducts = fallbackProducts;
    state.apparelVariantIndex = new Map();
    state.apparelCatalogLoaded = true;
    populateApparelProductSelect(fallbackProducts);
    resetApparelSelectors();
    if (elements.apparelStockNote) {
      elements.apparelStockNote.textContent =
        'Using built-in pre-made apparel. Start the save server for full catalog.';
    }
  }
  renderSelectedApparelItems();
}

function buildPremadeApparelProduct() {
  const handle = 'premade-apparel';
  const vendor = 'Swayze Apparel';
  const title = 'Pre-made Apparel';
  // Variants: T-shirt $15, Hoodie $20, Hat $10
  const variants = [
    {
      sku: 'PRE-T-ONESIZE',
      handle,
      title: 'Pre-made T-shirt',
      vendor,
      productType: 'tshirt',
      style: 'Pre-made',
      color: 'Standard',
      size: 'ONESIZE',
      priceCents: 1500,
      imageUrl: getApparelPlaceholder('tshirt')
    },
    {
      sku: 'PRE-H-ONESIZE',
      handle,
      title: 'Pre-made Hoodie',
      vendor,
      productType: 'hoodie',
      style: 'Pre-made',
      color: 'Standard',
      size: 'ONESIZE',
      priceCents: 2000,
      imageUrl: getApparelPlaceholder('hoodie')
    },
    {
      sku: 'PRE-HAT-ONESIZE',
      handle,
      title: 'Pre-made Hat',
      vendor,
      productType: 'hat',
      style: 'Pre-made',
      color: 'Standard',
      size: 'ONESIZE',
      priceCents: 1000,
      imageUrl: getApparelPlaceholder('hat')
    }
  ];
  return { handle, vendor, title, productType: 'tshirt', variants };
}

function buildApparelSummary(items = []) {
  if (!Array.isArray(items) || !items.length) return null;
  const pricedItems = cloneApparelItems(items);
  const subtotalCents = pricedItems.reduce(
    (sum, item) => sum + Math.max(0, Number(item.lineTotalCents) || 0),
    0
  );
  const container = document.createElement('div');
  container.className = 'order-apparel-summary';
  const heading = document.createElement('strong');
  heading.textContent = 'Apparel add-ons';
  container.appendChild(heading);
  const list = document.createElement('ul');
  list.className = 'order-apparel-list';
  pricedItems.forEach((item) => {
    const li = document.createElement('li');
    const title = document.createElement('span');
    title.textContent = `${item.quantity} × ${item.title || item.handle || 'Apparel item'}`;
    li.appendChild(title);
    const meta = document.createElement('span');
    meta.className = 'meta';
    const parts = [];
    if (item.color) parts.push(item.color);
    if (item.size) parts.push(item.size);
    parts.push(`SKU ${item.sku}`);
    meta.textContent = parts.join(' • ');
    li.appendChild(meta);
    if (item.productUrl) {
      const link = document.createElement('a');
      link.href = item.productUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Product page';
      li.appendChild(link);
    }
    if (!item.imageUrl && item.imageStatus?.status) {
      const warning = document.createElement('span');
      warning.className = 'order-apparel-warning';
      warning.textContent =
        item.imageStatus.status === 403
          ? 'Preview unavailable (HTTP 403).' 
          : `Preview unavailable (HTTP ${item.imageStatus.status}).`;
      li.appendChild(warning);
    }
    if (item.unitPriceCents) {
      const price = document.createElement('span');
      price.className = 'meta';
      price.textContent = `${formatCents(item.unitPriceCents)} each · ${formatCents(
        item.lineTotalCents || item.unitPriceCents * item.quantity
      )}`;
      li.appendChild(price);
    }
    list.appendChild(li);
  });
  container.appendChild(list);
  const footer = document.createElement('div');
  footer.className = 'order-apparel-summary-total';
  footer.textContent = `Apparel subtotal: ${formatCents(subtotalCents)}`;
  container.appendChild(footer);
  return container;
}

function buildInventoryUsageSummary(entries = []) {
  if (!Array.isArray(entries) || !entries.length) return null;
  const container = document.createElement('div');
  container.className = 'order-inventory-summary';
  const heading = document.createElement('strong');
  heading.textContent = 'Inventory usage';
  container.appendChild(heading);
  const list = document.createElement('ul');
  list.className = 'order-inventory-list';
  entries.forEach((entry) => {
    const li = document.createElement('li');
    const name = entry.name || entry.itemName || entry.itemId || 'Inventory item';
    const unit = entry.unit || 'unit';
    const label = document.createElement('span');
    label.textContent = `${entry.quantity} ${unit} · ${name}`;
    li.appendChild(label);
    const metaParts = [];
    if (entry.material) {
      metaParts.push(formatInventoryMaterial(entry.material));
    }
    if (entry.color) {
      metaParts.push(entry.color);
    }
    if (metaParts.length) {
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = metaParts.join(' • ');
      li.appendChild(document.createElement('br'));
      li.appendChild(meta);
    }
    list.appendChild(li);
  });
  container.appendChild(list);
  return container;
}

function formatInventoryMaterial(material) {
  const value = String(material || '').toLowerCase();
  if (!value) return 'Inventory';
  if (value === 'regular-vinyl') return 'Regular vinyl';
  if (value === 'heat-transfer') return 'Heat transfer vinyl';
  return value.replace(/[-_]/g, ' ').replace(/\b\w/g, (match) => match.toUpperCase());
}

function formatInventoryQuantity(item, quantity) {
  const amount = Number.isFinite(quantity) ? quantity : Number(item?.quantity || 0);
  const unit = item?.unit || 'unit';
  return `${amount} ${unit}`;
}

function updateInventoryLookup(items = []) {
  const lookup = new Map();
  items.forEach((item) => {
    if (item?.id) {
      lookup.set(item.id, item);
    }
  });
  state.inventoryLookup = lookup;
}

function renderInventoryList() {
  if (!elements.inventoryList) return;
  elements.inventoryList.innerHTML = '';

  if (state.inventoryLoading) {
    const loading = document.createElement('p');
    loading.className = 'hint';
    loading.textContent = 'Loading inventory…';
    elements.inventoryList.appendChild(loading);
    return;
  }

  if (state.inventoryError) {
    const error = document.createElement('p');
    error.className = 'hint';
    error.textContent = state.inventoryError;
    elements.inventoryList.appendChild(error);
    return;
  }

  if (!state.inventoryItems.length) {
    const empty = document.createElement('p');
    empty.className = 'inventory-empty';
    empty.textContent = 'No items tracked yet.';
    elements.inventoryList.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  state.inventoryItems.forEach((item) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'inventory-item';

    const header = document.createElement('div');
    header.className = 'inventory-item__header';
    const name = document.createElement('span');
    name.className = 'inventory-item__name';
    name.textContent = item.name || 'Inventory item';
    const qty = document.createElement('span');
    qty.className = 'inventory-item__qty';
    qty.textContent = formatInventoryQuantity(item);
    header.append(name, qty);
    wrapper.appendChild(header);

    const meta = document.createElement('div');
    meta.className = 'inventory-item__meta';
    const material = document.createElement('span');
    material.textContent = formatInventoryMaterial(item.material);
    meta.appendChild(material);

    if (item.color) {
      const color = document.createElement('span');
      color.className = 'inventory-item__color';
      const swatch = document.createElement('span');
      swatch.className = 'inventory-swatch';
      swatch.style.setProperty('--swatch-color', item.color);
      color.append(swatch, item.color);
      meta.appendChild(color);
    }

    if (Number.isInteger(item.unitCostCents)) {
      const cost = document.createElement('span');
      cost.textContent = `Cost: ${formatCents(item.unitCostCents)} / ${(item.unit || 'unit')}`;
      meta.appendChild(cost);
    }

    if (Number.isFinite(item.totalRemoved) && Math.abs(item.totalRemoved) > 0) {
      const used = document.createElement('span');
      used.textContent = `Used: ${formatInventoryQuantity(item, Math.abs(item.totalRemoved))}`;
      meta.appendChild(used);
    }

    if (item.notes) {
      const notes = document.createElement('span');
      notes.textContent = item.notes;
      meta.appendChild(notes);
    }

    wrapper.appendChild(meta);
    fragment.appendChild(wrapper);
  });

  elements.inventoryList.appendChild(fragment);
}

function populateInventorySelectors() {
  const adjustSelect = elements.inventoryAdjustItemSelect;
  const usageSelect = elements.inventoryUsageItemSelect;
  const items = state.inventoryItems;

  if (adjustSelect) {
    adjustSelect.innerHTML = '';
    if (!items.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No inventory items yet';
      adjustSelect.appendChild(option);
      adjustSelect.disabled = true;
    } else {
      adjustSelect.disabled = false;
      items.forEach((item) => {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = `${item.name} · ${formatInventoryQuantity(item)}`;
        adjustSelect.appendChild(option);
      });
    }
  }

  if (usageSelect) {
    usageSelect.innerHTML = '';
    if (!items.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No items available';
      usageSelect.appendChild(option);
      usageSelect.disabled = true;
    } else {
      usageSelect.disabled = false;
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Select an item';
      usageSelect.appendChild(placeholder);
      items.forEach((item) => {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = `${item.name} · ${formatInventoryQuantity(item)}`;
        option.disabled = Number(item.quantity || 0) <= 0;
        usageSelect.appendChild(option);
      });
      usageSelect.value = '';
    }
  }
}

function renderInventoryUsageList() {
  if (!elements.inventoryUsageList) return;
  elements.inventoryUsageList.innerHTML = '';
  if (!state.inventoryUsage.length) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'No inventory usage tracked yet.';
    elements.inventoryUsageList.appendChild(hint);
    return;
  }
  const fragment = document.createDocumentFragment();
  state.inventoryUsage.forEach((entry, index) => {
    const item = state.inventoryLookup.get(entry.itemId);
    const container = document.createElement('div');
    container.className = 'inventory-usage-entry';
    const label = document.createElement('span');
    label.className = 'inventory-usage-label';
    const name = entry.name || item?.name || 'Inventory item';
    const unit = entry.unit || item?.unit || 'unit';
    const quantityNode = document.createElement('strong');
    quantityNode.textContent = `${entry.quantity} ${unit}`;
    label.appendChild(quantityNode);
    label.appendChild(document.createTextNode(` · ${name}`));
    if (item) {
      const availability = document.createElement('span');
      availability.className = 'meta';
      availability.textContent = `On hand: ${formatInventoryQuantity(item)}`;
      label.appendChild(document.createTextNode(' '));
      label.appendChild(availability);
    }
    container.appendChild(label);

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.dataset.index = String(index);
    removeButton.textContent = 'Remove';
    container.appendChild(removeButton);
    fragment.appendChild(container);
  });
  elements.inventoryUsageList.appendChild(fragment);
}

async function loadInventory(material = state.inventoryMaterial) {
  if (!elements.inventoryList) return;
  const targetMaterial = material || state.inventoryMaterial || 'regular-vinyl';
  state.inventoryLoading = true;
  state.inventoryError = null;
  renderInventoryList();
  try {
    const materialParam = targetMaterial === 'all' ? null : targetMaterial;
    const endpoint = materialParam
      ? `/api/inventory?material=${encodeURIComponent(materialParam)}`
      : '/api/inventory';
    const response = await fetch(endpoint, { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.error || `Unable to load inventory (${response.status})`);
    }
    state.inventoryItems = Array.isArray(data.items) ? data.items.slice() : [];
    state.inventoryItems.sort((a, b) => {
      const nameA = (a?.name || '').toLowerCase();
      const nameB = (b?.name || '').toLowerCase();
      if (nameA === nameB) {
        return (a?.material || '').localeCompare(b?.material || '');
      }
      return nameA.localeCompare(nameB);
    });
    state.inventoryMaterial = targetMaterial;
    if (elements.inventoryMaterialSelect) {
      elements.inventoryMaterialSelect.value = targetMaterial;
    }
    updateInventoryLookup(state.inventoryItems);
    renderInventoryList();
    populateInventorySelectors();
    renderInventoryUsageList();
  } catch (error) {
    console.error('Unable to load inventory:', error);
    state.inventoryItems = [];
    state.inventoryError = error.message || 'Unable to load inventory.';
    if (elements.inventoryMaterialSelect) {
      elements.inventoryMaterialSelect.value = targetMaterial;
    }
    renderInventoryList();
    populateInventorySelectors();
    renderInventoryUsageList();
  } finally {
    state.inventoryLoading = false;
  }
}

async function handleInventoryAddSubmit(event) {
  event.preventDefault();
  if (!elements.inventoryAddForm) return;
  const name = elements.inventoryAddName?.value.trim() || '';
  if (!name) {
    alert('Enter a name for the inventory item.');
    return;
  }
  const material = elements.inventoryAddMaterial?.value || 'regular-vinyl';
  const color = elements.inventoryAddColor?.value.trim() || '';
  const quantityValue = Number(elements.inventoryAddQuantity?.value);
  const quantity = Number.isFinite(quantityValue) ? Math.round(quantityValue) : 0;
  const unit = elements.inventoryAddUnit?.value.trim() || 'unit';
  const cost = elements.inventoryAddCost?.value.trim();
  const itemUrl = elements.inventoryAddUrl?.value.trim();
  const notes = elements.inventoryAddNotes?.value.trim();

  const payload = {
    name,
    material,
    color,
    quantity,
    unit,
    unitCost: cost,
    itemUrl,
    notes
  };

  try {
    const response = await fetch('/api/inventory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.error || 'Unable to add inventory item.');
    }
    elements.inventoryAddForm.reset();
    if (elements.inventoryAddUnit) {
      elements.inventoryAddUnit.value = payload.unit || 'unit';
    }
    if (elements.inventoryAddMaterial) {
      elements.inventoryAddMaterial.value = material;
    }
    if (elements.inventoryAddQuantity) {
      elements.inventoryAddQuantity.value = '0';
    }
    await loadInventory(state.inventoryMaterial);
  } catch (error) {
    console.error(error);
    alert(error.message || 'Unable to add inventory item.');
  }
}

async function handleInventoryAdjustSubmit(event) {
  event.preventDefault();
  if (!elements.inventoryAdjustItemSelect) return;
  const itemId = elements.inventoryAdjustItemSelect.value;
  if (!itemId) {
    alert('Select an inventory item to adjust.');
    return;
  }
  const change = Number(elements.inventoryAdjustAmountInput?.value || 0);
  if (!Number.isFinite(change) || Math.round(change) === 0) {
    alert('Enter a non-zero amount to adjust.');
    return;
  }
  const notes = elements.inventoryAdjustNotesInput?.value.trim() || '';

  try {
    const response = await fetch(`/api/inventory/${encodeURIComponent(itemId)}/adjust`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ change, notes })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.error || 'Unable to adjust inventory.');
    }
    if (elements.inventoryAdjustForm) {
      elements.inventoryAdjustForm.reset();
    }
    await loadInventory(state.inventoryMaterial);
  } catch (error) {
    console.error(error);
    alert(error.message || 'Unable to adjust inventory.');
  }
}

function handleInventoryUsageAdd() {
  if (!elements.inventoryUsageItemSelect) return;
  const itemId = elements.inventoryUsageItemSelect.value;
  if (!itemId) {
    alert('Select an inventory item.');
    return;
  }
  const quantity = Math.max(1, Math.round(Number(elements.inventoryUsageQuantityInput?.value || 1)));
  const item = state.inventoryLookup.get(itemId);
  if (item && quantity > Number(item.quantity || 0)) {
    const available = formatInventoryQuantity(item);
    alert(`Only ${available} remaining for ${item.name}.`);
    return;
  }
  const existingIndex = state.inventoryUsage.findIndex((entry) => entry.itemId === itemId);
  if (existingIndex >= 0) {
    state.inventoryUsage[existingIndex].quantity += quantity;
  } else {
    state.inventoryUsage.push({
      itemId,
      quantity,
      name: item?.name || elements.inventoryUsageItemSelect.options[elements.inventoryUsageItemSelect.selectedIndex]?.text || 'Inventory item',
      unit: item?.unit || 'unit',
      material: item?.material || null
    });
  }
  if (elements.inventoryUsageQuantityInput) {
    elements.inventoryUsageQuantityInput.value = '1';
  }
  elements.inventoryUsageItemSelect.value = '';
  renderInventoryUsageList();
}

function handleInventoryUsageListClick(event) {
  const button = event.target.closest('button[data-index]');
  if (!button) return;
  const index = Number(button.dataset.index);
  if (!Number.isFinite(index)) return;
  state.inventoryUsage.splice(index, 1);
  renderInventoryUsageList();
}

function resetInventoryUsage() {
  state.inventoryUsage = [];
  renderInventoryUsageList();
}

function handleInventoryMaterialChange(event) {
  const value = event.target.value || 'regular-vinyl';
  loadInventory(value);
}

function handleInventoryRefresh() {
  loadInventory(state.inventoryMaterial);
}

async function bootstrapCustomerProfile() {
  const token = getStoredCustomerToken();
  if (!token) {
    state.customerProfile = null;
    return;
  }
  try {
    const response = await fetch('/api/customer/profile', {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-cache'
    });
    if (!response.ok) {
      if (response.status !== 401) {
        console.warn('Customer profile request failed:', response.status);
      }
      state.customerProfile = null;
      return;
    }
    const payload = await response.json().catch(() => ({}));
    state.customerProfile = payload?.customer || null;
  } catch (error) {
    console.warn('Unable to fetch customer profile:', error);
    state.customerProfile = null;
  }
}

function hydrateCustomerFields() {
  if (!elements.customerNameInput) return;
  if (!state.customerProfile) {
    elements.customerNameInput.disabled = false;
    elements.customerEmailInput.disabled = false;
    elements.customerPhoneInput.disabled = false;
    elements.customerAddressInput.disabled = false;
    return;
  }
  const { name, email, phone, address } = state.customerProfile;
  elements.customerNameInput.value = name || '';
  elements.customerNameInput.disabled = Boolean(name);
  elements.customerEmailInput.value = email || '';
  elements.customerEmailInput.disabled = Boolean(email);
  elements.customerPhoneInput.value = phone || '';
  elements.customerPhoneInput.disabled = Boolean(phone);
  elements.customerAddressInput.value = address || '';
  elements.customerAddressInput.disabled = Boolean(address);
}

async function loadCatalog() {
  // Robust fetch: prefer API on configured server, then server-hosted static, then local snapshot
  async function fetchAndParse(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    return JSON.parse(text);
  }
  const apiUrl = buildServerEndpoint('/api/catalog');
  const apiUrlBusted = `${apiUrl}${apiUrl.includes('?') ? '&' : '?'}_=${Date.now()}`;
  const staticUrl = buildServerEndpoint('/web/catalog.json');
  const staticUrlBusted = `${staticUrl}${staticUrl.includes('?') ? '&' : '?'}_=${Date.now()}`;
  const localUrlBusted = `./catalog.json?_=${Date.now()}`;
  const attempts = [apiUrl, apiUrlBusted, staticUrl, staticUrlBusted, localUrlBusted];
  for (const u of attempts) {
    try {
      return await fetchAndParse(u);
    } catch (_) {
      // continue
    }
  }
  console.warn('Unable to load catalog from API or local snapshot. If running from file://, start the save server or add ?server=http://localhost:4000 to the URL.');
  return { categories: [], assetRoot: '' };
}

function updateColorPaletteHint(palette) {
  if (!elements.colorPaletteHint) return;
  const base = palette?.description || '';
  if (!state.vinylControlsEnabled) {
    elements.colorPaletteHint.textContent =
      "Enable 'Change decal color' to choose a vinyl color." + (base ? ` ${base}` : '');
    return;
  }
  elements.colorPaletteHint.textContent = base;
}

function renderColorSwatches() {
  if (!elements.colorSwatches) return;
  const palette = getPaletteById(state.activePaletteId);
  const container = elements.colorSwatches;
  container.innerHTML = '';
  container.setAttribute('aria-disabled', String(!state.vinylControlsEnabled));
  container.style.opacity = state.vinylControlsEnabled ? '1' : '0.6';
  if (!palette || !Array.isArray(palette.colors) || !palette.colors.length) {
    updateColorPaletteHint(palette);
    return;
  }

  const fragment = document.createDocumentFragment();
  const normalizedSelected = normalizeHex(state.selectedColor || palette.colors[0].value);
  let hasMatch = false;

  palette.colors.forEach(({ value, name }) => {
    const normalized = normalizeHex(value);
    if (normalized === normalizedSelected) {
      hasMatch = true;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'color-swatch';
    button.title = `${name} (${normalized.toUpperCase()})`;
    button.dataset.color = normalized;
    button.style.background = normalized;
    button.style.setProperty('--swatch-color', normalized);
    button.setAttribute('aria-label', `${name} vinyl swatch`);
    button.addEventListener('click', () => {
      if (!state.vinylControlsEnabled) return;
      updateColorSelection(normalized);
    });
    fragment.appendChild(button);
  });

  container.appendChild(fragment);

  if (!hasMatch) {
    state.selectedColor = normalizeHex(palette.colors[0].value);
  } else {
    state.selectedColor = normalizedSelected;
  }

  if (elements.customColorInput) {
    elements.customColorInput.value = state.selectedColor;
    elements.customColorInput.disabled = !state.vinylControlsEnabled;
  }

  updateColorSelection(state.selectedColor);
  updateColorPaletteHint(palette);
}

function initColorPalette() {
  if (elements.colorPaletteSelect) {
    const options = COLOR_PALETTES.map(
      (palette) => `<option value="${palette.id}">${palette.label}</option>`
    ).join('');
    elements.colorPaletteSelect.innerHTML = options;
    const activePalette = getPaletteById(state.activePaletteId);
    elements.colorPaletteSelect.value = activePalette.id;
    elements.colorPaletteSelect.addEventListener('change', (event) => {
      const palette = getPaletteById(event.target.value);
      state.activePaletteId = palette.id;
      const recommendedId = getRecommendedPaletteId(elements.productTypeSelect?.value);
      state.paletteManualOverride = palette.id !== recommendedId;
      state.selectedColor = normalizeHex(palette.colors[0]?.value || '#000000');
      renderColorSwatches();
    });
  }

  renderColorSwatches();
}

function setVinylControlsEnabled(enabled) {
  state.vinylControlsEnabled = Boolean(enabled);
  if (elements.colorPaletteSelect) {
    elements.colorPaletteSelect.disabled = !state.vinylControlsEnabled;
  }
  if (elements.customColorInput) {
    elements.customColorInput.disabled = !state.vinylControlsEnabled;
  }
  renderColorSwatches();
}

function detectMultiColorFromImage(img) {
  try {
    const maxDim = 96;
    const ratio = Math.max(1, Math.max(img.naturalWidth, img.naturalHeight) / maxDim);
    const w = Math.max(1, Math.round(img.naturalWidth / ratio));
    const h = Math.max(1, Math.round(img.naturalHeight / ratio));
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const ctx = off.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const binCounts = new Map();
    let considered = 0;
    const step = 4 * 2; // sample every 2nd pixel
    for (let i = 0; i < data.length; i += step) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      if (a < 16) continue; // ignore transparent
      // ignore near-white background
      if (r > 245 && g > 245 && b > 245) continue;
      // strong quantization (2 bits/channel => 64 bins)
      const qr = r >> 6; // 0..3
      const qg = g >> 6;
      const qb = b >> 6;
      const key = (qr << 4) | (qg << 2) | qb; // pack to 6 bits
      binCounts.set(key, (binCounts.get(key) || 0) + 1);
      considered++;
    }
    if (considered < 100) return false; // not enough signal
    const minShare = 0.07; // bins contributing >=7%
    let dominant = 0;
    for (const [, count] of binCounts) {
      if (count / considered >= minShare) dominant++;
    }
    // Only treat as multi-color if 3+ dominant colors present
    return dominant >= 3;
  } catch (_) {
    return false;
  }
}

function getRecommendedPaletteId(productType) {
  const type = String(productType || '').toLowerCase();
  if (type === 'tshirt' || type === 'hoodie' || type === 'hat') {
    return 'heat-transfer';
  }
  return 'regular-vinyl';
}

function applyRecommendedPaletteForProduct(productType, { force = false } = {}) {
  const recommendedPalette = getPaletteById(getRecommendedPaletteId(productType));
  if (state.paletteManualOverride && !force) {
    if (state.activePaletteId !== recommendedPalette.id) {
      return;
    }
    state.paletteManualOverride = false;
  }

  if (state.activePaletteId === recommendedPalette.id && !force) {
    return;
  }

  state.activePaletteId = recommendedPalette.id;
  state.selectedColor = normalizeHex(recommendedPalette.colors[0]?.value || state.selectedColor);
  if (elements.colorPaletteSelect) {
    elements.colorPaletteSelect.value = recommendedPalette.id;
  }
  state.paletteManualOverride = false;
  renderColorSwatches();
}

function normalizeHex(value) {
  if (value === null || value === undefined) return '#000000';
  const hex = String(value).trim().toLowerCase();
  if (!hex) return '#000000';
  return hex.startsWith('#') ? hex : `#${hex}`;
}

function updateColorSelection(colorValue) {
  const normalized = normalizeHex(colorValue);
  state.selectedColor = normalized;
  if (elements.customColorInput && normalizeHex(elements.customColorInput.value) !== normalized) {
    elements.customColorInput.value = normalized;
  }
  if (elements.colorSwatches) {
    Array.from(elements.colorSwatches.children).forEach((node) => {
      const swatchColor = normalizeHex(node.dataset.color || '');
      node.classList.toggle('selected', swatchColor === normalized);
    });
  }
  updateStageBackground(normalized);
  updatePreviewCanvas();
}

function updateStageBackground(color) {
  const rgbaSoft = hexToRgba(color, 0.15);
  const rgbaStrong = hexToRgba(color, 0.35);
  elements.previewStage.style.setProperty(
    '--preview-vinyl-gradient',
    `linear-gradient(140deg, ${rgbaSoft}, rgba(255, 255, 255, 0.85) 45%, ${rgbaStrong})`
  );
}

function updateBackgroundColor(color) {
  const normalized = normalizeHex(color);
  state.backgroundColor = normalized;
  elements.previewStage.style.setProperty('--preview-car-color', normalized);
}

function populateCategorySelect() {
  const fragment = document.createDocumentFragment();
  state.categories.forEach((category, index) => {
    const option = document.createElement('option');
    option.value = category.slug;
    option.textContent = `${category.name} (${category.designs.length})`;
    if (index === 0) option.selected = true;
    fragment.appendChild(option);
  });
  elements.categorySelect.appendChild(fragment);
}

function setActiveCategory(slug) {
  const category = state.categories.find((item) => item.slug === slug);
  if (!category) return;
  state.selectedCategory = category;
  state.filteredDesigns = category.designs.slice();
  state.renderLimit = DEFAULT_RENDER_LIMIT;
  state.selectedDesignId = null;
  state.previewImage = null;
  state.previewImageMode = 'library';
  state.textLayers = [];
  state.activeTextLayerId = null;
  state.textMetrics.clear();
  state.lastImageBounds = null;
  elements.searchInput.value = '';
  updateCatalogTitle();
  updateSelectedLabels();
  renderDesignGrid();
  renderSourceLinks();
  renderTextLayersList();
  resetPreview();
  renderDesignerLibrary();
}

function updateCatalogTitle() {
  if (state.selectedCategory) {
    elements.catalogTitle.textContent = `Designs · ${state.selectedCategory.name}`;
    elements.resultsCount.textContent = `${state.selectedCategory.designs.length} total`;
  } else {
    elements.catalogTitle.textContent = 'Designs';
    elements.resultsCount.textContent = '';
  }
}

function matchesCatalogSearch(design, term) {
  if (!term) return true;
  const text = [
    design.name,
    design.autoDescription,
    design.id,
    (design.sources && design.sources.ai) || ''
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return text.includes(term);
}

function renderDesignGrid() {
  elements.designGrid.innerHTML = '';
  if (!state.selectedCategory) {
    elements.designGrid.textContent = 'Select a category to browse designs.';
    elements.loadMoreButton.hidden = true;
    return;
  }

  const searchTerm = elements.searchInput.value.trim().toLowerCase();
  const allDesigns = state.selectedCategory.designs;

  state.filteredDesigns = allDesigns.filter((design) => matchesCatalogSearch(design, searchTerm));

  if (!state.filteredDesigns.length) {
    elements.designGrid.textContent = 'No designs matched your search.';
    elements.loadMoreButton.hidden = true;
    elements.resultsCount.textContent = '0 found';
    return;
  }

  const toShow = state.filteredDesigns.slice(0, state.renderLimit);
  const fragment = document.createDocumentFragment();

  toShow.forEach((design) => {
    const card = createDesignCard(design);
    fragment.appendChild(card);
  });

  elements.designGrid.appendChild(fragment);

  const hasMore = state.filteredDesigns.length > state.renderLimit;
  elements.loadMoreButton.hidden = !hasMore;
  if (hasMore) {
    elements.loadMoreButton.textContent = `Load ${Math.min(
      RENDER_INCREMENT,
      state.filteredDesigns.length - state.renderLimit
    )} more designs`;
  }

  highlightSelectedCard();
  elements.resultsCount.textContent = `${state.filteredDesigns.length} found`;
}

function createDesignCard(design) {
  const template = elements.designCardTemplate.content.cloneNode(true);
  const button = template.querySelector('.design-card');
  const img = template.querySelector('img');
  const label = template.querySelector('.label');

  button.dataset.designId = design.id;
  label.textContent = design.name;
  if (design.autoDescription) {
    label.title = design.autoDescription;
  }
  img.loading = 'lazy';
  img.decoding = 'async';
  img.src = buildImageUrl(design.image, { width: 480, quality: 80 });
  img.alt = design.name;
  img.draggable = false;
  img.addEventListener('contextmenu', (event) => event.preventDefault());
  attachImageRetry(img, design.image);
  button.addEventListener('click', () => selectDesign(design));

  if (design.id === state.selectedDesignId) {
    button.classList.add('selected');
  }

  return button;
}

function highlightSelectedCard() {
  const cards = elements.designGrid.querySelectorAll('.design-card');
  cards.forEach((card) => {
    card.classList.toggle('selected', card.dataset.designId === state.selectedDesignId);
  });
}

async function selectDesign(design) {
  if (!design) return;
  state.selectedDesignId = design.id;
  if (elements.selectedDesignLabel) {
    elements.selectedDesignLabel.textContent = design.name;
  }
  if (window.__APPAREL_ONLY__) {
    try { initApparelFabric(); addDesignToApparelCanvas(design); } catch (_) {}
  }
  highlightSelectedCard();
  renderSourceLinks(design);
  const resolvedDownloadUrl = resolveAssetUrl(design.image);
  state.previewDownloadUrl = resolvedDownloadUrl;
  const extension = extractFileExtension(design.image, 'png');
  state.previewDownloadName = `${slugifyFilename(design.name, 'catalog-design')}.${extension}`;
  // Kick off color estimation for decals page
  if (window.__AUTO_COLOR_COUNT__) {
    window.requestAnimationFrame(() => {
      estimateDesignColorCount().then((count) => {
        state.estimatedColorCount = Math.max(1, Math.min(4, count || 1));
        updateColorCountNote();
        updatePricingSummary();
      }).catch(() => {
        state.estimatedColorCount = 1;
        updateColorCountNote();
        updatePricingSummary();
      });
    });
  }
  updatePreviewDownloadAffordance();

  try {
    const image = await loadImage(design.image, { width: 1600, quality: 90 });
    state.previewImage = image;
    state.previewImageMode = 'library';
    // respect checkbox for vinyl color changes
    const enabled = Boolean(elements.enableVinylColorCheckbox?.checked);
    setVinylControlsEnabled(enabled);
    elements.previewPlaceholder.style.display = 'none';
    elements.previewCanvas.classList.add('visible');
    updatePreviewCanvas();
  } catch (error) {
    console.error('Failed to load design preview:', error);
    elements.previewPlaceholder.innerHTML = '<p>Unable to load preview for this file.</p>';
    elements.previewPlaceholder.style.display = 'block';
    elements.previewCanvas.classList.remove('visible');
  }
}

function resetPreview() {
  const canvas = elements.previewCanvas;
  const ctx = getCanvasContext();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  state.textMetrics.clear();
  state.lastImageBounds = null;
  state.previewImageMode = 'library';
  state.previewDownloadUrl = null;
  state.previewDownloadName = '';
  updatePreviewDownloadAffordance();
  elements.previewPlaceholder.style.display = 'block';
  elements.previewPlaceholder.innerHTML = '<p>Select a design to start previewing.</p>';
  elements.previewCanvas.classList.remove('visible');
}

function updatePreviewDownloadAffordance() {
  const available =
    state.previewImageMode === 'library' &&
    Boolean(state.previewDownloadUrl) &&
    state.textLayers.length === 0 &&
    !DISABLE_DOWNLOADS;
  elements.previewCanvas.classList.toggle('preview-download-available', available);
  if (elements.previewStage) {
    elements.previewStage.classList.toggle('preview-download-available', available);
  }
}

function renderSourceLinks(design = null) {
  if (!elements.sourceLinks) return;
  if (!design || !design.sources || Object.keys(design.sources).length === 0) {
    elements.sourceLinks.textContent = 'Select a design to view available formats.';
    return;
  }

  const formats = Object.keys(design.sources)
    .map((format) => format.toUpperCase())
    .sort((a, b) => a.localeCompare(b));

  elements.sourceLinks.textContent = `Available formats: ${formats.join(
    ', '
  )}. Contact us to receive the file after customizing your order.`;
}

function updateSelectedLabels() {
  if (elements.selectedCategoryLabel) {
    elements.selectedCategoryLabel.textContent = state.selectedCategory
      ? state.selectedCategory.name
      : 'None';
  }

  if (!state.selectedCategory) {
    if (elements.selectedDesignLabel) {
      elements.selectedDesignLabel.textContent = 'Select a design';
    }
    return;
  }

  const design = state.selectedCategory.designs.find(
    (item) => item.id === state.selectedDesignId
  );
  if (elements.selectedDesignLabel) {
    elements.selectedDesignLabel.textContent = design ? design.name : 'Select a design';
  }
}

function updateSize(value) {
  const numeric = Number(value) || state.selectedSize;
  state.selectedSize = numeric;
  const formattedSize = Number.isInteger(numeric) ? numeric.toFixed(0) : numeric.toFixed(1);
  if (elements.sizeValue) {
    elements.sizeValue.textContent = `${formattedSize}"`;
  }
  updatePreviewCanvas();
}

function updatePreviewCanvas() {
  const canvas = elements.previewCanvas;
  const ctx = getCanvasContext();

  const hasImage = Boolean(state.previewImage);
  const isCustomImage = state.previewImageMode === 'custom';
  if (!hasImage && !state.textLayers.length) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    state.textMetrics.clear();
    elements.previewCanvas.classList.remove('visible');
    elements.previewPlaceholder.style.display = 'block';
    updatePreviewDownloadAffordance();
    return;
  }

  if (hasImage) {
    const rawWidth = state.previewImage.naturalWidth;
    const rawHeight = state.previewImage.naturalHeight;
    const paddingX = rawWidth * IMAGE_PADDING_RATIO;
    const paddingY = rawHeight * IMAGE_PADDING_RATIO;

    canvas.width = Math.round(rawWidth + paddingX * 2);
    canvas.height = Math.round(rawHeight + paddingY * 2);

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(state.previewImage, paddingX, paddingY);
    if (!isCustomImage && state.vinylControlsEnabled) {
      recolorCanvasToVinyl(ctx, canvas.width, canvas.height, state.selectedColor);
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = state.backgroundColor;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = 'source-over';
    }

    state.lastImageBounds = {
      x: paddingX,
      y: paddingY,
      width: rawWidth,
      height: rawHeight
    };
  } else {
    // Create a default canvas if no artwork yet but text needs a surface.
    canvas.width = 1200;
    canvas.height = 800;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = state.backgroundColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    state.lastImageBounds = null;
  }

  ctx.imageSmoothingEnabled = true;
  state.textMetrics.clear();
  const canvasWidth = canvas.width;
  const canvasHeight = canvas.height;

  if (!isCustomImage) {
    state.textLayers.forEach((layer) => {
      const metrics = renderTextLayer(ctx, layer, canvasWidth, canvasHeight);
      if (metrics) {
        state.textMetrics.set(layer.id, metrics);
      }
    });
  }

  elements.previewPlaceholder.style.display = 'none';
  canvas.classList.add('visible');
  scaleCanvasForSize();
  updatePreviewDownloadAffordance();
  try { updateApparelOverlay(); } catch (_) {}
}

function recolorCanvasToVinyl(ctx, width, height, hexColor) {
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  const rgb = hexToRgb(hexColor);
  const threshold = 230;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];
    if (a === 0) continue;

    const brightness = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (brightness > threshold) {
      data[i + 3] = 0;
    } else {
      data[i] = rgb.r;
      data[i + 1] = rgb.g;
      data[i + 2] = rgb.b;
      data[i + 3] = 255;
    }
  }

  ctx.putImageData(imageData, 0, 0);
}

function renderTextLayer(ctx, layer, canvasWidth, canvasHeight) {
  if (!layer.content.trim()) return null;

  const posX = (layer.x / 100) * canvasWidth;
  const posY = (layer.y / 100) * canvasHeight;

  ctx.save();
  ctx.translate(posX, posY);
  ctx.rotate(toRadians(layer.rotation));
  ctx.fillStyle = layer.color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  {
    const fam = String(layer.fontFamily || '').trim();
    let weight = '';
    if (/Font Awesome 6 Free/i.test(fam)) weight = '900 ';
    else if (/Font Awesome 6 Brands/i.test(fam)) weight = '400 ';
    ctx.font = `${weight}${layer.fontSize}px ${fam}`;
  }

  let metrics;
  if (Math.abs(layer.curve) < CURVE_THRESHOLD) {
    ctx.fillText(layer.content, 0, 0);
    const textWidth = ctx.measureText(layer.content).width;
    metrics = {
      width: textWidth,
      height: layer.fontSize,
      radius: 0
    };
  } else {
    metrics = renderCurvedText(ctx, layer);
  }

  ctx.restore();

  if (!metrics) return null;

  return {
    centerX: posX,
    centerY: posY,
    width: metrics.width,
    height: metrics.height,
    rotation: layer.rotation,
    radius: metrics.radius || 0
  };
}

function renderCurvedText(ctx, layer) {
  const text = layer.content;
  const totalWidth = ctx.measureText(text).width;
  if (!totalWidth) {
    ctx.fillText(text, 0, 0);
    return {
      width: layer.fontSize,
      height: layer.fontSize,
      radius: 0
    };
  }

  const normalizedCurve = clamp(layer.curve, -180, 180);
  const amplitude = (normalizedCurve / 180) * layer.fontSize * 3;
  const safeWidth = Math.max(totalWidth, 1);

  let cursorX = -totalWidth / 2;

  for (const char of text) {
    const metrics = ctx.measureText(char);
    const charWidth = metrics.width || (layer.fontSize * 0.5);
    const centerOffset = cursorX + charWidth / 2 + totalWidth / 2;
    const t = clamp(centerOffset / safeWidth, 0, 1);
    const offsetY = amplitude * (Math.cos(t * Math.PI) - 1);
    const slope =
      amplitude !== 0
        ? (amplitude * Math.PI * Math.sin(t * Math.PI)) / safeWidth
        : 0;

    ctx.save();
    ctx.translate(cursorX + charWidth / 2, offsetY);
    ctx.rotate(Math.atan(slope));
    ctx.fillText(char, 0, 0);
    ctx.restore();

    cursorX += charWidth;
  }

  const height = layer.fontSize + Math.abs(amplitude) * 2;
  return {
    width: totalWidth,
    height,
    radius: 0
  };
}

function scaleCanvasForSize() {
  const canvas = elements.previewCanvas;
  if (!canvas.width || !canvas.height) return;

  const targetWidth = Math.max(100, state.selectedSize * PIXELS_PER_INCH);
  const baseWidth = state.lastImageBounds?.width || canvas.width;
  const scale = baseWidth ? targetWidth / baseWidth : 1;
  const displayWidth = canvas.width * scale;

  canvas.style.width = `${displayWidth}px`;
  canvas.style.height = 'auto';
}

function addTextLayer() {
  const id = `text-${Date.now()}`;
  const layer = {
    id,
    content: 'Your text',
    fontFamily: FONT_OPTIONS[0].value,
    fontSize: 48,
    color: '#ffffff',
    x: 50,
    y: 50,
    rotation: 0,
    curve: 0
  };

  state.textLayers.push(layer);
  state.activeTextLayerId = id;
  renderTextLayersList();
  updatePreviewCanvas();
}

function removeTextLayer(id) {
  state.textLayers = state.textLayers.filter((layer) => layer.id !== id);
  if (state.activeTextLayerId === id) {
    state.activeTextLayerId = state.textLayers.length ? state.textLayers[0].id : null;
  }
  renderTextLayersList();
  updatePreviewCanvas();
}

function setActiveTextLayer(id) {
  if (state.activeTextLayerId === id) return;
  state.activeTextLayerId = id;
  refreshActiveTextLayerHighlight();
}

function updateTextLayer(id, updates, options = {}) {
  const layer = state.textLayers.find((item) => item.id === id);
  if (!layer) return;

  Object.assign(layer, updates);
  if (!options.skipListRender) {
    renderTextLayersList();
  }
  updatePreviewCanvas();
}

function renderTextLayersList() {
  const list = elements.textLayersList;
  if (!list) return;
  if (window.__APPAREL_ONLY__ && state.apparelFabric) {
    list.textContent = 'Use the on-canvas controls to edit overlays. Add text with the button above.';
    return;
  }

  if (!state.textLayers.length) {
    list.textContent = 'No text yet. Add your first line.';
    list.classList.add('empty');
    return;
  }

  list.classList.remove('empty');
  list.innerHTML = '';

  const fragment = document.createDocumentFragment();

  state.textLayers.forEach((layer, index) => {
    const card = document.createElement('article');
    card.className = 'text-layer-card';
    card.dataset.layerId = layer.id;
    if (layer.id === state.activeTextLayerId) {
      card.classList.add('active');
    }

    card.addEventListener('click', (event) => {
      const isControl = Boolean(
        event.target.closest('input, select, textarea, button')
      );
      if (isControl) {
        if (state.activeTextLayerId !== layer.id) {
          setActiveTextLayer(layer.id);
        }
        return;
      }
      setActiveTextLayer(layer.id);
    });

    const header = document.createElement('div');
    header.className = 'layer-header';
    const title = document.createElement('span');
    title.textContent = `Text ${index + 1}`;
    header.appendChild(title);

    const controls = document.createElement('div');
    controls.className = 'layer-controls';

    const textLabel = document.createElement('label');
    textLabel.textContent = 'Text';
    const textInput = document.createElement('input');
    textInput.type = 'text';
    textInput.value = layer.content;
    textInput.addEventListener('input', (event) =>
      updateTextLayer(layer.id, { content: event.target.value }, { skipListRender: true })
    );
    textLabel.appendChild(textInput);
    controls.appendChild(textLabel);

    const row = document.createElement('div');
    row.className = 'row';

    const fontLabel = document.createElement('label');
    fontLabel.textContent = 'Font family';
    const fontSelect = document.createElement('select');
    FONT_OPTIONS.forEach((font) => {
      const option = document.createElement('option');
      option.value = font.value;
      option.textContent = font.label;
      option.selected = font.value === layer.fontFamily;
      fontSelect.appendChild(option);
    });
    fontSelect.addEventListener('change', (event) =>
      updateTextLayer(layer.id, { fontFamily: event.target.value })
    );
    fontLabel.appendChild(fontSelect);
    row.appendChild(fontLabel);

    const colorLabel = document.createElement('label');
    colorLabel.textContent = 'Color';
    const colorWrap = document.createElement('div');
    colorWrap.className = 'color-input';
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = layer.color;
    colorInput.addEventListener('input', (event) =>
      updateTextLayer(layer.id, { color: event.target.value })
    );
    colorWrap.appendChild(colorInput);
    colorLabel.appendChild(colorWrap);
    row.appendChild(colorLabel);

    controls.appendChild(row);

    controls.appendChild(
      createSliderControl({
        label: `Size: ${layer.fontSize}px`,
        min: 8,
        max: 240,
        step: 1,
        value: layer.fontSize,
        onChange: (value) => updateTextLayer(layer.id, { fontSize: Number(value) })
      })
    );

    controls.appendChild(
      createSliderControl({
        label: `Rotation: ${layer.rotation.toFixed(0)}°`,
        min: -180,
        max: 180,
        step: 1,
        value: layer.rotation,
        onChange: (value) => updateTextLayer(layer.id, { rotation: Number(value) })
      })
    );

    controls.appendChild(
      createSliderControl({
        label: `Curve: ${layer.curve.toFixed(0)}°`,
        min: -180,
        max: 180,
        step: 1,
        value: layer.curve,
        onChange: (value) => updateTextLayer(layer.id, { curve: Number(value) })
      })
    );

    const footer = document.createElement('div');
    footer.className = 'layer-footer';
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'secondary small';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      removeTextLayer(layer.id);
    });
    footer.appendChild(removeBtn);

    card.appendChild(header);
    card.appendChild(controls);
    card.appendChild(footer);

    fragment.appendChild(card);
  });

  list.appendChild(fragment);
  refreshActiveTextLayerHighlight();
}

function refreshActiveTextLayerHighlight() {
  if (!elements.textLayersList) return;
  const cards = elements.textLayersList.querySelectorAll('.text-layer-card');
  cards.forEach((card) => {
    const isActive = card.dataset.layerId === state.activeTextLayerId;
    card.classList.toggle('active', isActive);
  });
}

function createSliderControl({ label, min, max, step, value, onChange }) {
  const wrapper = document.createElement('div');
  wrapper.className = 'slider-group';
  const labelNode = document.createElement('label');
  labelNode.textContent = label;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.addEventListener('input', (event) => onChange(event.target.value));
  wrapper.appendChild(labelNode);
  wrapper.appendChild(input);
  return wrapper;
}

function handleCanvasPointerDown(event) {
  state.previewCanvasClickSuppressed = false;
  if (!state.textLayers.length) return;
  const coords = getCanvasPointerPosition(event);
  if (!coords) return;

  const hit = hitTestTextLayer(coords.x, coords.y);
  if (!hit) return;

  event.preventDefault();
  state.previewCanvasClickSuppressed = true;
  elements.previewCanvas.setPointerCapture(event.pointerId);
  state.draggingText = {
    id: hit.id,
    pointerId: event.pointerId,
    offsetX: coords.x - hit.metrics.centerX,
    offsetY: coords.y - hit.metrics.centerY
  };
  state.activeTextLayerId = hit.id;
  renderTextLayersList();
}

function handleCanvasPointerMove(event) {
  if (!state.draggingText || state.draggingText.pointerId !== event.pointerId) return;

  const coords = getCanvasPointerPosition(event);
  if (!coords) return;

  const layer = state.textLayers.find((item) => item.id === state.draggingText.id);
  if (!layer) return;

  const canvasWidth = elements.previewCanvas.width;
  const canvasHeight = elements.previewCanvas.height;
  if (!canvasWidth || !canvasHeight) return;

  const newCenterX = coords.x - state.draggingText.offsetX;
  const newCenterY = coords.y - state.draggingText.offsetY;

  layer.x = clamp((newCenterX / canvasWidth) * 100, 0, 100);
  layer.y = clamp((newCenterY / canvasHeight) * 100, 0, 100);

  updatePreviewCanvas();
}

function handleCanvasPointerUp(event) {
  if (!state.draggingText || state.draggingText.pointerId !== event.pointerId) return;

  elements.previewCanvas.releasePointerCapture(event.pointerId);
  state.draggingText = null;
  state.previewCanvasClickSuppressed = false;
}

async function handlePreviewCanvasClick(event) {
  if (DISABLE_DOWNLOADS) return;
  if (state.previewCanvasClickSuppressed) {
    state.previewCanvasClickSuppressed = false;
    return;
  }
  if (
    state.previewImageMode !== 'library' ||
    !state.previewDownloadUrl ||
    state.textLayers.length
  ) {
    return;
  }
  event.preventDefault();
  const filename = state.previewDownloadName || 'catalog-design.png';
  await downloadAssetToDisk(state.previewDownloadUrl, filename);
}

function getCanvasPointerPosition(event) {
  const canvas = elements.previewCanvas;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;

  const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
  const y = ((event.clientY - rect.top) / rect.height) * canvas.height;
  return { x, y };
}

function hitTestTextLayer(x, y) {
  const entries = Array.from(state.textMetrics.entries());
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const [id, metrics] = entries[i];
    if (!metrics) continue;
    const dx = x - metrics.centerX;
    const dy = y - metrics.centerY;
    const angle = -toRadians(metrics.rotation);
    const rotatedX = dx * Math.cos(angle) - dy * Math.sin(angle);
    const rotatedY = dx * Math.sin(angle) + dy * Math.cos(angle);
    const halfW = (metrics.width || 0) / 2;
    const halfH = (metrics.height || 0) / 2;
    if (Math.abs(rotatedX) <= halfW && Math.abs(rotatedY) <= halfH) {
      return { id, metrics };
    }
  }
  return null;
}

function loadImage(src, options = {}) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = buildImageUrl(src, options);
  });
}

function hexToRgb(hex) {
  const clean = normalizeHex(hex).replace('#', '');
  const value =
    clean.length === 3 ? clean.split('').map((char) => char + char).join('') : clean;
  const intVal = parseInt(value, 16);
  return {
    r: (intVal >> 16) & 255,
    g: (intVal >> 8) & 255,
    b: intVal & 255
  };
}

function hexToRgba(hex, alpha = 1) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Estimate the number of significant colors in the current design image.
// - Downscales for performance
// - Quantizes RGB to 4 bits/channel to merge gradients
// - Counts only buckets >= 15% of pixels
// - If none exceed threshold, returns 1 (treat gradient as single color)
async function estimateDesignColorCount() {
  try {
    const img = state.previewImage;
    if (!img) return 1;
    const maxDim = 96;
    const ratio = Math.min(1, maxDim / Math.max(img.naturalWidth || img.width || 1, img.naturalHeight || img.height || 1));
    const w = Math.max(1, Math.round((img.naturalWidth || img.width || 1) * ratio));
    const h = Math.max(1, Math.round((img.naturalHeight || img.height || 1) * ratio));
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const octx = off.getContext('2d', { willReadFrequently: true });
    octx.drawImage(img, 0, 0, w, h);
    const { data } = octx.getImageData(0, 0, w, h);
    const totalPixels = w * h;
    if (!totalPixels) return 1;
    const counts = new Map();
    let solidCount = 0;
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a < 16) continue; // ignore near-transparent
      const r = data[i] >> 4; // 0-15
      const g = data[i + 1] >> 4;
      const b = data[i + 2] >> 4;
      const key = (r << 8) | (g << 4) | b;
      counts.set(key, (counts.get(key) || 0) + 1);
      solidCount++;
    }
    if (!solidCount) return 1;
    const threshold = Math.max(1, Math.floor(solidCount * 0.15));
    // Convert to list and keep only significant buckets
    const entries = Array.from(counts.entries()).filter(([, c]) => c >= threshold);
    if (!entries.length) return 1; // gradients split into many small buckets
    // Merge close colors (treat nearby hues as one)
    const clusters = [];
    const dist = (c1, c2) => {
      const r1 = ((c1 >> 8) & 0x0f) * 16 + 8;
      const g1 = ((c1 >> 4) & 0x0f) * 16 + 8;
      const b1 = (c1 & 0x0f) * 16 + 8;
      const r2 = ((c2 >> 8) & 0x0f) * 16 + 8;
      const g2 = ((c2 >> 4) & 0x0f) * 16 + 8;
      const b2 = (c2 & 0x0f) * 16 + 8;
      const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
      return Math.sqrt(dr*dr + dg*dg + db*db);
    };
    const MERGE_THRESHOLD = 30; // RGB distance
    for (const [key, c] of entries.sort((a,b)=>b[1]-a[1])) {
      let placed = false;
      for (const cl of clusters) {
        if (dist(cl.center, key) <= MERGE_THRESHOLD) {
          cl.total += c;
          // keep center anchored to dominant
          placed = true;
          break;
        }
      }
      if (!placed) clusters.push({ center: key, total: c });
    }
    return Math.max(1, Math.min(4, clusters.length || 1));
  } catch (_) {
    return 1;
  }
}

function updateColorCountNote() {
  const node = document.getElementById('colorCountNote');
  if (!node || !window.__AUTO_COLOR_COUNT__) return;
  const est = Math.max(1, Math.min(4, Number(state.estimatedColorCount) || 1));
  node.textContent = `Estimated colors: ${est}. If the number of colors is incorrect, we will reach out to verify before proceeding.`;
}

// --- Vectorization (from mockups, simplified) ---
function ensureImageTracer() {
  // Try loading locally, then via save-server /web paths
  const tryLoad = (src) => new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
  return new Promise(async (resolve, reject) => {
    if (window.ImageTracer && typeof window.ImageTracer.imagedataToSVG === 'function') {
      return resolve(window.ImageTracer);
    }
    const rel = await tryLoad('./imagetracer.min.js');
    if (rel && window.ImageTracer) return resolve(window.ImageTracer);
    const root = await tryLoad(buildServerEndpoint('/web/imagetracer.min.js'));
    if (root && window.ImageTracer) return resolve(window.ImageTracer);
    const vendor = await tryLoad(buildServerEndpoint('/web/vendor/imagetracer.min.js'));
    if (vendor && window.ImageTracer) return resolve(window.ImageTracer);
    reject(new Error('Vectorizer library not loaded'));
  });
}

function setVectorizeStatus(msg) {
  if (elements.vectorizeStatus) elements.vectorizeStatus.textContent = msg || '';
}

function autoRemoveBackgroundFromImage(img, options = {}) {
  const max = options.max || 512;
  const w = Math.min(max, img.naturalWidth || img.width || max);
  const h = Math.round((w / (img.naturalWidth || w)) * (img.naturalHeight || img.height || w));
  const off = document.createElement('canvas');
  off.width = w;
  off.height = h;
  const ctx = off.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const imgData = ctx.getImageData(0, 0, w, h);
  const data = imgData.data;
  // Sample border pixels to find dominant edge color
  const samples = [];
  const pushPx = (i) => samples.push([data[i], data[i + 1], data[i + 2]]);
  for (let x = 0; x < w; x++) { pushPx((0 * w + x) * 4); pushPx(((h - 1) * w + x) * 4); }
  for (let y = 0; y < h; y++) { pushPx((y * w + 0) * 4); pushPx((y * w + (w - 1)) * 4); }
  const avg = samples.reduce((a, c) => [a[0]+c[0], a[1]+c[1], a[2]+c[2]], [0,0,0]).map(v => v / samples.length);
  const threshold = 28; // color distance threshold
  for (let i = 0; i < data.length; i += 4) {
    const dr = data[i] - avg[0];
    const dg = data[i + 1] - avg[1];
    const db = data[i + 2] - avg[2];
    const dist = Math.sqrt(dr*dr + dg*dg + db*db);
    if (dist < threshold) data[i + 3] = 0;
  }
  ctx.putImageData(imgData, 0, 0);
  return off;
}

async function vectorizeCurrentDesign() {
  try {
    if (!state.previewImage) {
      alert('Select a design before vectorizing.');
      return;
    }
    setVectorizeStatus('Loading vectorizer…');
    await ensureImageTracer();
    setVectorizeStatus('Preparing image…');
    const cleaned = autoRemoveBackgroundFromImage(state.previewImage, { max: 640 });
    const ctx = cleaned.getContext('2d', { willReadFrequently: true });
    const imgData = ctx.getImageData(0, 0, cleaned.width, cleaned.height);
    setVectorizeStatus('Tracing…');
    const svg = window.ImageTracer.imagedataToSVG(imgData, {
      // favor fewer paths but preserve color blocks
      numberofcolors: 8,
      ltres: 1,
      qtres: 1,
      pathomit: 8,
      roundcoords: 1
    });
    setVectorizeStatus('Importing…');
    const svgUrl = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
    const vecImg = new Image();
    await new Promise((res, rej) => { vecImg.onload = res; vecImg.onerror = rej; vecImg.src = svgUrl; });
    // Replace preview image with vector render (keeps multi-color, skips recolor path)
    state.previewImage = vecImg;
    state.previewImageMode = 'custom';
    updatePreviewCanvas();
    try { updateApparelOverlay(); } catch (_) {}
    setVectorizeStatus('Vectorized.');
    setTimeout(() => setVectorizeStatus(''), 1500);
  } catch (error) {
    console.error('Vectorize failed:', error);
    setVectorizeStatus('Vectorize failed');
  }
}

async function handleAddToOrder(event) {
  event.preventDefault();

  if (!state.selectedCategory || !state.selectedDesignId || !state.previewImage) {
    alert('Pick a design before adding it to your order.');
    return;
  }

  const design = state.selectedCategory.designs.find(
    (item) => item.id === state.selectedDesignId
  );
  if (!design) {
    alert('Design not found. Please select it again.');
    return;
  }

  const customer = {
    name: elements.customerNameInput.value.trim(),
    email: elements.customerEmailInput.value.trim(),
    phone: elements.customerPhoneInput.value.trim(),
    address: elements.customerAddressInput.value.trim()
  };

  if (!customer.name || !customer.email) {
    alert('Please provide the customer\'s name and email before adding to the order.');
    return;
  }

  if (!state.textLayers.length) {
    const proceed = window.confirm(
      'You have not added any custom text. Would you like to continue without text?'
    );
    if (!proceed) return;
  }

  const quantity = Math.max(1, Number(elements.quantityInput.value) || 1);
  const notes = elements.notesInput.value.trim();
  const submitButton = elements.orderForm.querySelector('.primary');
  const originalLabel = submitButton ? submitButton.textContent : '';

  const productType = elements.productTypeSelect?.value || 'sticker';
  const usesStickerSizing = productType === 'sticker';
  const usesColorCount = productType === 'sticker' || productType === 'tshirt' || productType === 'hat';
  const sizeSelection = usesStickerSizing
    ? elements.stickerSizeSelect?.value || state.selectedStickerSize || '4'
    : null;
  let colorSelection = usesColorCount ? elements.stickerColorSelect?.value || '1' : null;
  if (window.__AUTO_COLOR_COUNT__ && productType === 'sticker') {
    colorSelection = String(Math.max(1, Math.min(4, Number(state.estimatedColorCount) || 1)));
  }
  const basePricing = computePricing(productType, sizeSelection, colorSelection, quantity);
  const apparelItems = cloneApparelItems(state.selectedApparelItems);
  const apparelTotals = computeApparelTotals(apparelItems);
  const pricing = mergeApparelPricing(basePricing, apparelTotals, quantity);
  const pricedApparelItems = apparelTotals.items;
  const inventoryUsageEntries = state.inventoryUsage.map((entry) => ({
    itemId: entry.itemId,
    quantity: entry.quantity,
    name: entry.name,
    unit: entry.unit,
    material: entry.material
  }));
  const inventoryUsagePayload = inventoryUsageEntries.map((entry) => ({
    itemId: entry.itemId,
    quantity: entry.quantity
  }));

  try {
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = 'Saving...';
    }

    updatePreviewCanvas();
    const imageData = elements.previewCanvas.toDataURL('image/png');
    const designSources = { ...(design.sources || {}) };

    const savePayload = {
      imageData,
      designId: design.id,
      designName: design.name,
      category: state.selectedCategory.name,
      size: state.selectedSize,
      color: state.selectedColor,
      background: state.backgroundColor,
      quantity,
      notes,
      textLayers: cloneTextLayers(),
      designSources,
      apparelItems: pricedApparelItems,
      inventoryUsage: inventoryUsagePayload,
      pricing,
      customer
    };

    const saveResult = await saveDesignToServer(savePayload);
    const resolvedPricing = saveResult?.pricing || pricing;
    const serverOrderId = saveResult?.id || null;
    const localId = serverOrderId || `${design.id}-${Date.now()}`;
    const resolvedApparelItems = Array.isArray(saveResult?.apparelItems)
      ? saveResult.apparelItems
      : pricedApparelItems;
    const finalPricing = resolvedApparelItems.length && !resolvedPricing.apparelTotals
      ? mergeApparelPricing(resolvedPricing, computeApparelTotals(resolvedApparelItems), quantity)
      : resolvedPricing;

    state.orders.push({
      id: localId,
      orderId: serverOrderId,
      orderNumber: saveResult?.orderNumber,
      category: state.selectedCategory.name,
      designName: design.name,
      size: state.selectedSize,
      stickerSize: sizeSelection ? Number(sizeSelection) : null,
      color: state.selectedColor,
      background: state.backgroundColor,
      quantity,
      notes,
      textLayers: cloneTextLayers(),
      savedPreview: saveResult?.previewFile,
      metadataPath: saveResult?.metadataPath,
      bytes: saveResult?.bytesWritten || 0,
      sourceCopies: Array.isArray(saveResult?.sourceCopies) ? saveResult.sourceCopies : [],
      pricing: finalPricing,
      apparelItems: resolvedApparelItems,
      inventoryUsage: Array.isArray(saveResult?.inventoryUsage)
        ? saveResult.inventoryUsage
        : inventoryUsageEntries,
      paymentLink: saveResult?.paymentLink || null,
      paymentLinkId: saveResult?.paymentLinkId || null,
      paymentStatus: saveResult?.paymentStatus || 'UNPAID',
      customer
    });

    if (elements.quantityInput) {
      elements.quantityInput.value = '1';
    }
   elements.notesInput.value = '';
   clearApparelSelections();
    resetInventoryUsage();
    updatePricingSummary();

    await loadInventory(state.inventoryMaterial);
    renderOrderSummary();
    alert('Design saved and added to the order summary.');
  } catch (error) {
    console.error('Unable to save design preview:', error);
    alert(
      'We could not save the preview. Please make sure the save server is running (npm run save-server) and try again.'
    );
  } finally {
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = originalLabel || 'Add to order';
    }
  }
}

async function saveDesignToServer(payload) {
  const response = await fetch(SAVE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    let errorMessage = response.statusText;
    try {
      const data = await response.json();
      if (data?.error) {
        errorMessage = data.error;
      }
    } catch (error) {
      const fallback = await response.text();
      errorMessage = fallback || errorMessage;
    }
    throw new Error(`Save failed (${response.status}): ${errorMessage}`);
  }
  return response.json();
}

async function requestCheckoutLink(orderId) {
  const response = await fetch(ORDER_CHECKOUT_ENDPOINT(orderId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error || `Checkout failed (${response.status})`);
  }
  return data;
}

async function startCheckoutForOrder(order, index, button) {
  if (!order?.orderId) {
    alert(
      'This design has not been recorded on the server yet. Save it again before attempting checkout.'
    );
    return;
  }

  if (order.paymentStatus === 'PAID') {
    alert('This order has already been marked as paid.');
    return;
  }

  if (order.paymentLink) {
    window.location.href = order.paymentLink;
    return;
  }

  const triggerButton = button || null;
  const originalLabel = triggerButton?.textContent || '';
  if (triggerButton) {
    triggerButton.disabled = true;
    triggerButton.textContent = 'Generating link...';
  }

  try {
    const data = await requestCheckoutLink(order.orderId);
    const existing = state.orders[index];
    if (existing && existing.orderId === order.orderId) {
      const merged = {
        ...existing,
        paymentLink: data?.url || data?.order?.paymentLink || existing.paymentLink || null,
        paymentLinkId: data?.order?.paymentLinkId || existing.paymentLinkId || null,
        paymentStatus: data?.order?.paymentStatus || 'PENDING'
      };
      state.orders[index] = merged;
    }
    renderOrderSummary();

    const checkoutUrl =
      data?.url ||
      data?.order?.paymentLink ||
      (state.orders[index] && state.orders[index].paymentLink);
    if (checkoutUrl) {
      window.location.href = checkoutUrl;
    } else {
      alert('Checkout link created, but no URL was returned.');
    }
  } catch (error) {
    console.error('Checkout failed:', error);
    alert(error.message || 'Unable to start checkout.');
  } finally {
    if (triggerButton && triggerButton.isConnected) {
      triggerButton.disabled = false;
      triggerButton.textContent = originalLabel || 'Checkout';
    }
  }
}

function cloneTextLayers() {
  return state.textLayers.map((layer) => ({ ...layer }));
}

function renderOrderSummary() {
  if (!state.orders.length) {
    elements.orderList.textContent = 'No items yet. Add designs to build your order.';
    return;
  }

  const fragment = document.createDocumentFragment();
  state.orders.forEach((item, index) => {
    const card = document.createElement('article');
    card.className = 'order-item';

    const header = document.createElement('header');
    const title = document.createElement('span');
    title.textContent = item.orderNumber
      ? `Order #${item.orderNumber} · ${item.designName}`
      : item.designName;
    const qty = document.createElement('span');
    qty.textContent = `×${item.quantity}`;
    header.appendChild(title);
    header.appendChild(qty);

    const details = document.createElement('div');
    details.className = 'order-details';
    if (item.customer?.name) {
      details.appendChild(buildDetailLine('Customer', item.customer.name));
    }
    if (item.customer?.email) {
      details.appendChild(buildDetailLine('Email', item.customer.email));
    }
    if (item.customer?.phone) {
      details.appendChild(buildDetailLine('Phone', item.customer.phone));
    }
    if (item.customer?.address) {
      details.appendChild(buildDetailLine('Address', item.customer.address));
    }
    if (item.orderNumber) {
      details.appendChild(buildDetailLine('Order #', item.orderNumber));
    }
    details.appendChild(buildDetailLine('Category', item.category));
    details.appendChild(buildDetailLine('Width', `${item.size.toFixed(1)}"`));
    details.appendChild(buildDetailLine('Vinyl', item.color.toUpperCase()));
    details.appendChild(buildDetailLine('Background', item.background.toUpperCase()));

    if (item.pricing) {
      details.appendChild(buildDetailLine('Product', item.pricing.descriptor || 'Custom item'));
      const colorCount = Number(item.pricing.colors) || null;
      if (item.pricing.sizeInches) {
        details.appendChild(
          buildDetailLine('Sticker size', `${Number(item.pricing.sizeInches).toFixed(0)}"`)
        );
      }
      const unitLabel = colorCount && item.pricing.sizeInches
        ? `Unit price (${colorCount} ${colorCount === 1 ? 'color' : 'colors'})`
        : 'Unit price';
      const subLabel = colorCount && item.pricing.sizeInches
        ? `Subtotal (${colorCount} ${colorCount === 1 ? 'color' : 'colors'})`
        : 'Subtotal';
      details.appendChild(buildDetailLine(unitLabel, formatCents(item.pricing.unitPriceCents)));
      details.appendChild(buildDetailLine(subLabel, formatCents(item.pricing.subtotalCents)));
      details.appendChild(buildDetailLine('Shipping', formatCents(item.pricing.shippingCents)));
      details.appendChild(buildDetailLine('Total', formatCents(item.pricing.totalCents)));
      // Also add an explicit Colors line for clarity when available
      if (colorCount) {
        details.appendChild(buildDetailLine('Colors', String(colorCount)));
      }
    }

    if (item.apparelItems?.length) {
      const apparelSummary = buildApparelSummary(item.apparelItems);
      if (apparelSummary) {
        details.appendChild(apparelSummary);
      }
    }

    if (item.inventoryUsage?.length) {
      const inventorySummary = buildInventoryUsageSummary(item.inventoryUsage);
      if (inventorySummary) {
        details.appendChild(inventorySummary);
      }
    }

    if (item.paymentStatus) {
      details.appendChild(buildDetailLine('Payment status', item.paymentStatus));
    }

    if (item.paymentLink) {
      details.appendChild(
        buildLinkDetailLine('Payment link', 'Open checkout page', item.paymentLink)
      );
    }

    if (item.savedPreview) {
      if (DISABLE_DOWNLOADS) {
        details.appendChild(buildDetailLine('Preview', 'Ready'));
      } else {
        const previewUrl = buildSavedFileUrl(item.savedPreview);
        if (previewUrl) {
          details.appendChild(
            buildLinkDetailLine(
              `Preview${item.orderNumber ? ` (Order #${item.orderNumber})` : ''}`,
              item.savedPreview,
              previewUrl
            )
          );
        } else {
          details.appendChild(buildDetailLine('Preview', item.savedPreview));
        }
      }
    }

    if (item.metadataPath) {
      details.appendChild(buildDetailLine('Metadata file', item.metadataPath));
    }

    if (item.sourceCopies?.length) {
      const container = document.createElement('div');
      const strong = document.createElement('strong');
      strong.textContent = 'Source files: ';
      container.appendChild(strong);

      const list = document.createElement('div');
      list.className = 'order-source-files';

      item.sourceCopies.forEach((source) => {
        if (DISABLE_DOWNLOADS) {
          const span = document.createElement('span');
          span.textContent = source.file || source.format.toUpperCase();
          list.appendChild(span);
        } else {
          const link = document.createElement('a');
          link.textContent = source.file || source.format.toUpperCase();
          const href = buildSavedFileUrl(source.file);
          if (href) {
            link.href = href;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
          } else {
            link.href = '#';
            link.addEventListener('click', (event) => event.preventDefault());
          }
          list.appendChild(link);
        }
      });

      container.appendChild(list);
      details.appendChild(container);
    }

    if (item.textLayers?.length) {
      const lines = item.textLayers
        .map(
          (layer, idx) =>
            `#${idx + 1} "${layer.content}" · ${layer.fontSize}px · ${layer.fontFamily}`
        )
        .join('\n');
      details.appendChild(buildDetailLine('Custom text', lines));
    }

    if (item.notes) {
      details.appendChild(buildDetailLine('Notes', item.notes));
    }

    const footer = document.createElement('footer');
    const checkoutBtn = document.createElement('button');
    checkoutBtn.type = 'button';
    checkoutBtn.className = 'primary';
    if (item.paymentStatus === 'PAID') {
      checkoutBtn.className = 'secondary';
      checkoutBtn.textContent = 'Paid';
      checkoutBtn.disabled = true;
    } else {
      checkoutBtn.textContent = item.paymentLink ? 'Open payment link' : 'Pay now';
      checkoutBtn.addEventListener('click', () =>
        startCheckoutForOrder(state.orders[index], index, checkoutBtn)
      );
    }
    footer.appendChild(checkoutBtn);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'secondary';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => removeOrderItem(index));
    footer.appendChild(removeBtn);

    card.appendChild(header);
    card.appendChild(details);
    card.appendChild(footer);

    fragment.appendChild(card);
  });

  elements.orderList.innerHTML = '';
  elements.orderList.appendChild(fragment);
}

function buildDetailLine(label, value) {
  const row = document.createElement('div');
  const strong = document.createElement('strong');
  strong.textContent = `${label}: `;
  const text = document.createElement('span');
  text.textContent = value;
  row.appendChild(strong);
  row.appendChild(text);
  return row;
}

function buildLinkDetailLine(label, text, href) {
  const row = document.createElement('div');
  const strong = document.createElement('strong');
  strong.textContent = `${label}: `;
  const link = document.createElement('a');
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = text;
  row.appendChild(strong);
  row.appendChild(link);
  return row;
}

function removeOrderItem(index) {
  state.orders.splice(index, 1);
  renderOrderSummary();
}

function handleCheckout() {
  if (!state.orders.length) {
    alert('Add at least one item to your order summary first.');
    return;
  }

  const index = state.orders.findIndex((item) => item?.orderId);
  if (index === -1) {
    alert('Please save your design again to generate an order before checking out.');
    return;
  }
  startCheckoutForOrder(state.orders[index], index, elements.checkoutButton);
}

function initResponsiveSidebar() {
  const { sidebar, sidebarToggle, sidebarOverlay, sidebarClose } = elements;
  if (!sidebar || !sidebarToggle || !sidebarOverlay) return;

  const body = document.body;
  const focusSelectors =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const mobileQuery = window.matchMedia('(max-width: 860px)');
  let lastFocus = null;

  const isMobile = () => mobileQuery.matches;

  const closeSidebar = ({ restoreFocus = true } = {}) => {
    if (!body.classList.contains('sidebar-open')) return;
    body.classList.remove('sidebar-open');
    sidebarOverlay.hidden = true;
    sidebar.setAttribute('aria-hidden', 'true');
    sidebarToggle.setAttribute('aria-expanded', 'false');
    if (restoreFocus) {
      const target = lastFocus instanceof HTMLElement ? lastFocus : sidebarToggle;
      target?.focus?.();
    }
    lastFocus = null;
  };

  const openSidebar = () => {
    if (!isMobile()) return;
    lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : sidebarToggle;
    body.classList.add('sidebar-open');
    sidebarOverlay.hidden = false;
    sidebar.setAttribute('aria-hidden', 'false');
    sidebarToggle.setAttribute('aria-expanded', 'true');
    const focusTarget =
      sidebarClose ||
      sidebar.querySelector(focusSelectors);
    focusTarget?.focus?.();
  };

  sidebarToggle.addEventListener('click', () => {
    if (body.classList.contains('sidebar-open')) {
      closeSidebar({ restoreFocus: false });
    } else {
      openSidebar();
    }
  });

  sidebarOverlay.addEventListener('click', () => closeSidebar());
  sidebarClose?.addEventListener('click', () => closeSidebar());

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && body.classList.contains('sidebar-open') && isMobile()) {
      event.preventDefault();
      closeSidebar();
    }
  });

  const handleViewportChange = () => {
    if (!isMobile()) {
      closeSidebar({ restoreFocus: false });
      sidebar.removeAttribute('aria-hidden');
      sidebarOverlay.hidden = true;
      sidebarToggle.setAttribute('aria-expanded', 'false');
      return;
    }

    const isOpen = body.classList.contains('sidebar-open');
    sidebar.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
    if (!isOpen) {
      sidebarOverlay.hidden = true;
    }
  };

  if (typeof mobileQuery.addEventListener === 'function') {
    mobileQuery.addEventListener('change', handleViewportChange);
  } else if (typeof mobileQuery.addListener === 'function') {
    mobileQuery.addListener(handleViewportChange);
  }

  elements.closeSidebarForMobile = (options = {}) => closeSidebar(options);
  handleViewportChange();
}

function attachEventListeners() {
  elements.categorySelect?.addEventListener('change', (event) => {
    setActiveCategory(event.target.value);
    elements.closeSidebarForMobile?.({ restoreFocus: false });
  });

  elements.searchInput?.addEventListener('input', () => {
    state.renderLimit = DEFAULT_RENDER_LIMIT;
    renderDesignGrid();
  });

  elements.loadMoreButton?.addEventListener('click', () => {
    state.renderLimit += RENDER_INCREMENT;
    renderDesignGrid();
  });

  elements.sizeSlider?.addEventListener('input', (event) => {
    const value = event.target.value;
    updateSize(value);
    if (elements.productTypeSelect?.value === 'sticker' && elements.stickerSizeSelect) {
      const targetSizes = ['3', '4', '6'];
      const closest = targetSizes.reduce((prev, curr) => {
        const prevDiff = Math.abs(Number(prev) - Number(value));
        const currDiff = Math.abs(Number(curr) - Number(value));
        return currDiff < prevDiff ? curr : prev;
      });
      if (elements.stickerSizeSelect.value !== closest) {
        elements.stickerSizeSelect.value = closest;
      }
    }
    updatePricingSummary();
  });

  elements.customColorInput?.addEventListener('input', (event) => {
    updateColorSelection(event.target.value);
  });

  elements.backgroundColorInput?.addEventListener('input', (event) => {
    if (elements.backgroundPresetSelect) {
      elements.backgroundPresetSelect.value = 'custom';
    }
    updateBackgroundColor(event.target.value);
  });

  elements.backgroundPresetSelect?.addEventListener('change', (event) => {
    const value = event.target.value;
    if (value === 'custom') {
      if (elements.backgroundColorInput) {
        updateBackgroundColor(elements.backgroundColorInput.value);
      }
    } else if (value) {
      if (elements.backgroundColorInput) {
        elements.backgroundColorInput.value = value;
      }
      updateBackgroundColor(value);
    }
  });

  // Vinyl color enable/disable checkbox
  if (elements.enableVinylColorCheckbox) {
    // default off
    setVinylControlsEnabled(elements.enableVinylColorCheckbox.checked);
    elements.enableVinylColorCheckbox.addEventListener('change', () => {
      setVinylControlsEnabled(elements.enableVinylColorCheckbox.checked);
      try { updateApparelOverlay(); } catch (_) {}
    });
  } else {
    // fallback: keep enabled
    setVinylControlsEnabled(true);
  }

  elements.inventoryMaterialSelect?.addEventListener('change', handleInventoryMaterialChange);
  elements.inventoryRefreshButton?.addEventListener('click', handleInventoryRefresh);
  elements.inventoryAddForm?.addEventListener('submit', handleInventoryAddSubmit);
  elements.inventoryAdjustForm?.addEventListener('submit', handleInventoryAdjustSubmit);
  elements.inventoryUsageAddButton?.addEventListener('click', handleInventoryUsageAdd);
  elements.inventoryUsageList?.addEventListener('click', handleInventoryUsageListClick);

  elements.addTextButton?.addEventListener('click', () => {
    if (window.__APPAREL_ONLY__) {
      initApparelFabric();
      addFabricTextOverlay();
      return;
    }
    if (!state.selectedDesignId) {
      alert('Select a design before adding text.');
      return;
    }
    addTextLayer();
  });

  elements.productTypeSelect?.addEventListener('change', () => {
    updatePricingSummary();
    applyRecommendedPaletteForProduct(elements.productTypeSelect.value);
  });
  elements.stickerSizeSelect?.addEventListener('change', (event) => {
    const value = event.target.value;
    if (elements.sizeSlider) {
      elements.sizeSlider.value = value;
    }
    updateSize(value);
    updatePricingSummary();
  });
  elements.stickerColorSelect?.addEventListener('change', () => {
    updatePricingSummary();
  });

  elements.apparelProductSelect?.addEventListener('change', handleApparelProductChange);
  elements.apparelColorSelect?.addEventListener('change', handleApparelColorChange);
  elements.apparelSizeSelect?.addEventListener('change', handleApparelSizeChange);
  elements.apparelQuantityInput?.addEventListener('input', handleApparelQuantityInput);
  elements.apparelAddButton?.addEventListener('click', handleApparelAddItem);
  elements.apparelSelectedList?.addEventListener('click', handleApparelListClick);
  elements.vectorizeButton?.addEventListener('click', (e) => {
    e.preventDefault();
    if (state.apparelFabric) {
      vectorizeSelectedApparel();
    } else {
      vectorizeCurrentDesign();
    }
  });
  elements.overlaySizeSlider?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    state.overlayScale = Math.max(0.2, Math.min(1, v));
    updateApparelOverlay();
  });
  elements.overlayResetButton?.addEventListener('click', () => {
    state.overlayPosX = 50;
    state.overlayPosY = 12;
    state.overlayScale = 0.6;
    if (elements.overlaySizeSlider) elements.overlaySizeSlider.value = String(state.overlayScale);
    updateApparelOverlay();
  });
  // Drag to move overlay
  elements.apparelOverlayCanvas?.addEventListener('pointerdown', (e) => {
    if (state.apparelFabric) return; // Fabric handles interactions
    try { elements.apparelOverlayCanvas.setPointerCapture(e.pointerId); } catch (_) {}
    state.overlayDragging = { id: e.pointerId };
  });
  elements.apparelOverlayCanvas?.addEventListener('pointerup', (e) => {
    if (state.apparelFabric) return;
    if (state.overlayDragging && state.overlayDragging.id === e.pointerId) {
      try { elements.apparelOverlayCanvas.releasePointerCapture(e.pointerId); } catch (_) {}
      state.overlayDragging = null;
    }
  });
  elements.apparelOverlayCanvas?.addEventListener('pointermove', (e) => {
    if (state.apparelFabric) return;
    if (!state.overlayDragging) return;
    const img = elements.apparelPreviewImage;
    if (!img || img.hidden) return;
    const imgRect = img.getBoundingClientRect();
    const wrapRect = img.parentElement.getBoundingClientRect();
    const x = e.clientX - imgRect.left;
    const y = e.clientY - imgRect.top;
    const relX = Math.max(0, Math.min(100, (x / imgRect.width) * 100));
    const relY = Math.max(0, Math.min(100, (y / imgRect.height) * 100));
    state.overlayPosX = relX;
    state.overlayPosY = relY;
    updateApparelOverlay();
  });

  elements.quantityInput?.addEventListener('input', () => {
    updatePricingSummary();
  });

  elements.orderForm?.addEventListener('submit', handleAddToOrder);
  elements.checkoutButton?.addEventListener('click', handleCheckout);

  [elements.previewStage, elements.previewCanvas, elements.designGrid].forEach((node) => {
    if (node && typeof node.addEventListener === 'function') {
      node.addEventListener('contextmenu', (event) => event.preventDefault());
    }
  });

  elements.previewCanvas?.addEventListener('pointerdown', handleCanvasPointerDown);
  elements.previewCanvas?.addEventListener('pointermove', handleCanvasPointerMove);
  elements.previewCanvas?.addEventListener('pointerup', handleCanvasPointerUp);
  elements.previewCanvas?.addEventListener('pointerleave', handleCanvasPointerUp);
  elements.previewCanvas?.addEventListener('click', handlePreviewCanvasClick);

  initDesignerModal();
}

function bootstrapQuantityInput() {
  if (elements.quantityInput) {
    elements.quantityInput.value = '1';
  }
}

async function bootstrap() {
  try {
    await bootstrapCustomerProfile();
    hydrateCustomerFields();
    state.catalog = await loadCatalog();
    state.categories = state.catalog.categories || [];
    state.assetRoot = state.catalog.assetRoot || '';
    if (!state.categories.length) {
      elements.designGrid.textContent = 'No categories found in the catalog.';
      return;
    }

    populateCategorySelect();
    initColorPalette();
    applyRecommendedPaletteForProduct(elements.productTypeSelect?.value);
    updateStageBackground(state.selectedColor);
    updateBackgroundColor(state.backgroundColor);
    renderTextLayersList();
    renderSelectedApparelItems();
    attachEventListeners();
    renderInventoryUsageList();
    await loadInventory(state.inventoryMaterial);
    bootstrapQuantityInput();
    if (elements.apparelFieldset) {
      // Load S&S visibility config first so curated style IDs are enforced in the browser
      await loadSsawConfig();
      await loadApparelProducts();
    }
    applyStoreSelectionIfPresent();
    updatePricingSummary();
    // Respect category passed via query string, e.g. catalog.html?category=car-related
    let initialCategorySlug = null;
    try {
      const url = new URL(window.location.href);
      const q = (url.searchParams.get('category') || '').trim();
      if (q) initialCategorySlug = q.toLowerCase();
    } catch (_) {}
    const foundInitial = initialCategorySlug
      ? state.categories.find((c) => (c.slug || '').toLowerCase() === initialCategorySlug)
      : null;
    // Prefer "Car Related" by default if present
    let preferred = null;
    try {
      preferred = state.categories.find((c) => (c.name || '').toLowerCase().includes('car'))
        || state.categories.find((c) => (c.slug || '').toLowerCase().includes('car'))
        || null;
    } catch (_) {}
    const targetSlug = foundInitial ? foundInitial.slug : (preferred ? preferred.slug : state.categories[0].slug);
    if (elements.categorySelect) {
      elements.categorySelect.value = targetSlug;
    }
    setActiveCategory(targetSlug);
    updateSize(state.selectedSize);
    renderOrderSummary();
  } catch (error) {
    console.error(error);
    elements.designGrid.textContent =
      'Something went wrong while loading the catalog. Try regenerating it.';
  }
}

initResponsiveSidebar();
bootstrap().finally(() => {
  try {
    if (window.__OPEN_APPAREL_ON_LOAD__ && typeof openApparelModal === 'function') {
      openApparelModal();
    }
  } catch (_) {}
});
// --- Apparel Fabric (mockups-like) ---
function initApparelFabric() {
  if (state.apparelFabric || !elements.apparelCanvas || !window.fabric) return state.apparelFabric;
  const canvas = new fabric.Canvas(elements.apparelCanvas, { preserveObjectStacking: true });
  try {
    const wrap = elements.previewStage;
    const w = Math.max(300, Math.round(wrap?.clientWidth || 600));
    const h = Math.max(300, Math.round(wrap?.clientHeight || 600));
    canvas.setWidth(w); canvas.setHeight(h);
  } catch (_) {}
  state.apparelFabric = canvas;
  return canvas;
}

function setFabricSizeToImage(imgEl) {
  const c = state.apparelFabric; if (!c || !imgEl) return;
  const w = Math.max(100, Math.round(elements.previewStage?.clientWidth || imgEl.clientWidth || 300));
  const h = Math.max(100, Math.round(elements.previewStage?.clientHeight || imgEl.clientHeight || 300));
  c.setWidth(w); c.setHeight(h); c.renderAll();
}

function setFabricObjectDefaults(obj) {
  try {
    obj.set({ cornerColor: '#1d4ed8', cornerStrokeColor: '#1d4ed8', borderColor: '#1d4ed8', transparentCorners: false, cornerSize: 10, originX: 'center', originY: 'center' });
  } catch (_) {}
}

function loadApparelBackground(url) {
  const c = state.apparelFabric; if (!c || !url) return;
  const imgEl = new Image();
  if (!/^data:/i.test(url)) imgEl.crossOrigin = 'anonymous';
  imgEl.onload = () => {
    try {
      setFabricSizeToImage(elements.apparelPreviewImage || imgEl);
      const iw = imgEl.naturalWidth || imgEl.width || c.getWidth();
      const ih = imgEl.naturalHeight || imgEl.height || c.getHeight();
      const fabricImg = new fabric.Image(imgEl);
      fabricImg.objectCaching = false;
      const scale = Math.min(c.getWidth() / iw, c.getHeight() / ih);
      fabricImg.scale(scale);
      c.setBackgroundImage(fabricImg, c.renderAll.bind(c), { originX: 'left', originY: 'top', left: 0, top: 0 });
    } catch (_) {}
  };
  imgEl.onerror = () => {};
  imgEl.src = url;
}

function addDesignToApparelCanvas(design) {
  const c = initApparelFabric(); if (!c) return;
  const url = resolveAssetUrl(design.image);
  fabric.Image.fromURL(url, (img) => {
    if (!img) return;
    const maxW = c.getWidth() * 0.65;
    const maxH = c.getHeight() * 0.65;
    const iw = img.width || 512;
    const ih = img.height || 512;
    const scale = Math.min(maxW / iw, maxH / ih, 1);
    img.objectCaching = false;
    img.scale(scale);
    img.set({ left: c.getWidth() / 2, top: c.getHeight() / 2, originX: 'center', originY: 'center' });
    setFabricObjectDefaults(img);
    c.add(img); c.setActiveObject(img); c.requestRenderAll();
  }, { crossOrigin: 'anonymous' });
}

async function vectorizeSelectedApparel() {
  const c = state.apparelFabric; if (!c) return;
  try {
    setVectorizeStatus('Loading vectorizer…');
    await ensureImageTracer();
    if (typeof ImageTracer === 'undefined') { setVectorizeStatus('Vectorizer not available'); return; }
    const obj = c.getActiveObject(); if (!obj) { setVectorizeStatus('Select an overlay to vectorize'); return; }
    let imgEl = null; let dataUrl = null;
    if (obj.type === 'image' && (obj._originalElement || obj._element)) { imgEl = obj._originalElement || obj._element; }
    else { try { dataUrl = obj.toDataURL({ format: 'png', multiplier: 2 }); } catch (_) {} }
    if (dataUrl) { const tmp = new Image(); tmp.crossOrigin = 'anonymous'; tmp.src = dataUrl; imgEl = tmp; await new Promise(r => { tmp.onload = r; tmp.onerror = r; }); }
    if (!imgEl) { setVectorizeStatus('Unable to read selected object'); return; }
    const iw = imgEl.naturalWidth || imgEl.width || 0; const ih = imgEl.naturalHeight || imgEl.height || 0; if (!iw||!ih){ setVectorizeStatus('Invalid image'); return; }
    setVectorizeStatus('Preparing image…');
    const MAX_W = 1000; const scale = Math.min(MAX_W/iw,1); const tw=Math.max(1,Math.round(iw*scale)); const th=Math.max(1,Math.round(ih*scale));
    const off = document.createElement('canvas'); off.width=tw; off.height=th; const octx=off.getContext('2d'); octx.drawImage(imgEl,0,0,tw,th);
    const imgData = octx.getImageData(0,0,tw,th);
    setVectorizeStatus('Tracing…');
    let svgstr = null; try { svgstr = ImageTracer.imagedataToSVG(imgData, { numberofcolors: 6, colorquantcycles: 3, strokewidth: 0, ltres: 1, qtres: 1, pathomit: 8 }); } catch (e) { setVectorizeStatus('Vectorization failed'); return; }
    if (!svgstr) { setVectorizeStatus('Vectorization failed'); return; }
    setVectorizeStatus('Importing…');
    fabric.loadSVGFromString(svgstr, (objects, options) => {
      try {
        const group = (fabric.util && fabric.util.groupSVGElements)
          ? fabric.util.groupSVGElements(objects, options)
          : new fabric.Group(objects);
        // Add first so Fabric computes bounds properly
        c.add(group);
        setFabricObjectDefaults(group);
        group.set({ originX: 'center', originY: 'center' });
        const center = obj.getCenterPoint();
        const targetW = obj.getScaledWidth() || obj.width || 1;
        // Prefer built-in scaling helper for reliability
        if (typeof group.scaleToWidth === 'function') {
          group.scaleToWidth(targetW);
        } else {
          // Fallback: compute current width and scale proportionally
          const bounds = group.getBoundingRect(true);
          const currW = bounds && bounds.width ? bounds.width : (group.getScaledWidth() || group.width || 1);
          const sc = targetW / Math.max(1, currW);
          group.scale((group.scaleX || 1) * sc);
        }
        group.set({ left: center.x, top: center.y });
        group.objectCaching = false;
        group.setCoords();
        c.bringToFront(group);
        c.remove(obj);
        c.setActiveObject(group);
        c.requestRenderAll();
        setVectorizeStatus('Vectorized.');
        setTimeout(() => setVectorizeStatus(''), 1500);
      } catch (e) { setVectorizeStatus('SVG import failed'); }
    });
  } catch (err) {
    setVectorizeStatus('Vectorize failed');
  }
}

function addFabricTextOverlay() {
  const c = initApparelFabric(); if (!c) return;
  const txt = new fabric.Textbox('Your text', { left: c.getWidth()/2, top: c.getHeight()/2, originX:'center', originY:'center', fill: '#ffffff', fontSize: 48, fontFamily: 'Barlow, sans-serif' });
  setFabricObjectDefaults(txt); c.add(txt); c.setActiveObject(txt); c.requestRenderAll();
}

(() => {
  const RETRY_LIMIT = 3;
  const RETRY_PARAM = 'libraryRetry';
  function isLibraryAsset(src) {
    return typeof src === 'string' && src.includes('/api/library/');
  }
  function buildRetrySrc(base, attempt) {
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}${RETRY_PARAM}=${Date.now()}-${attempt}`;
  }
  document.addEventListener('error', (event) => {
    const img = event.target;
    if (!(img && img.tagName && img.tagName.toUpperCase() === 'IMG')) return;
    const current = img.currentSrc || img.src || '';
    if (!isLibraryAsset(current)) return;
    const attempts = Number(img.dataset.libraryRetryCount || 0);
    if (attempts >= RETRY_LIMIT) return;
    event.preventDefault();
    const base = img.dataset.libraryRetryBase || current;
    if (!img.dataset.libraryRetryBase) {
      img.dataset.libraryRetryBase = base;
    }
    const nextAttempts = attempts + 1;
    img.dataset.libraryRetryCount = String(nextAttempts);
    setTimeout(() => {
      img.src = buildRetrySrc(base, nextAttempts);
    }, 50);
  }, true);
  document.addEventListener('load', (event) => {
    const img = event.target;
    if (!(img && img.tagName && img.tagName.toUpperCase() === 'IMG')) return;
    const base = img.dataset.libraryRetryBase || '';
    if (!isLibraryAsset(base)) return;
    delete img.dataset.libraryRetryCount;
    delete img.dataset.libraryRetryBase;
  }, true);
})();
