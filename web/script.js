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
  return profitAdjustedCents + extraColors * COLOR_ADDON_CENTS;
}

const FONT_OPTIONS = [
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
  const fallbackProtocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
  const fallbackHost = window.location.hostname || 'localhost';
  try {
    const current = new URL(window.location.href);
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      throw new Error('Unsupported protocol');
    }
    return current.origin;
  } catch (error) {
    return `${fallbackProtocol}//${fallbackHost}`;
  }
}

const SAVE_SERVER_BASE =
  window.__SAVE_SERVER_BASE__ || resolveSaveServerBase();

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
  storeSelectionApplied: false
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
  apparelFieldset: document.getElementById('apparelFieldset'),
  apparelProductSelect: document.getElementById('apparelProductSelect'),
  apparelColorSelect: document.getElementById('apparelColorSelect'),
  apparelSizeSelect: document.getElementById('apparelSizeSelect'),
  apparelQuantityInput: document.getElementById('apparelQuantityInput'),
  apparelAddButton: document.getElementById('apparelAddButton'),
  apparelPreviewImage: document.getElementById('apparelPreviewImage'),
  apparelPreviewPlaceholder: document.getElementById('apparelPreviewPlaceholder'),
  apparelSelectedList: document.getElementById('apparelSelectedList'),
  apparelStockNote: document.getElementById('apparelStockNote'),
  priceSummary: document.getElementById('priceSummary'),
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
      ? Math.round(item.unitPriceCents)
      : resolveApparelUnitPriceCents(normalizedType, options);
  const lineTotalCents = unitPriceCents * quantity;
  item.productType = normalizedType;
  item.unitPriceCents = unitPriceCents;
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
    return Math.round(fallbackCents);
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
  merged.unitPriceCents = Math.round(merged.subtotalCents / qty);
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
    if (event.key === 'Escape' && state.designerModalOpen) {
      event.preventDefault();
      closeDesignerModal();
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
  if (!elements.productTypeSelect) return;
  const productType = elements.productTypeSelect.value;
  const quantity = Number(elements.quantityInput.value) || 1;
  const sizeValue = elements.stickerSizeSelect?.value || state.selectedStickerSize || '4';
  state.selectedStickerSize = sizeValue;

  let colorValue = elements.stickerColorSelect?.value || '1';
  const isSticker = productType === 'sticker';
  const isApparel =
    productType === 'tshirt' || productType === 'hat' || productType === 'hoodie';

  if (isSticker) {
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
  elements.stickerColorRow?.classList.toggle('hidden', !(isSticker || isApparel));

  const basePricing = computePricing(productType, sizeValue, colorValue, quantity);
  const apparelTotals = computeApparelTotals(state.selectedApparelItems);
  const pricing = mergeApparelPricing(basePricing, apparelTotals, quantity);

  if (elements.unitPriceDisplay) {
    elements.unitPriceDisplay.textContent = formatCents(pricing.unitPriceCents);
  }
  if (elements.subtotalDisplay) {
    elements.subtotalDisplay.textContent = formatCents(pricing.subtotalCents);
  }
  if (elements.shippingDisplay) {
    elements.shippingDisplay.textContent = formatCents(pricing.shippingCents);
  }
  if (elements.totalDisplay) {
    elements.totalDisplay.textContent = formatCents(pricing.totalCents);
  }

  updateApparelSubtotalLine(apparelTotals.subtotalCents);
  state.currentPricing = pricing;

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
  if (variant && variant.imageUrl) {
    elements.apparelPreviewImage.src = variant.imageUrl;
    elements.apparelPreviewImage.hidden = false;
    elements.apparelPreviewPlaceholder.textContent = `${variant.title || 'Apparel item'} preview`;
  } else {
    const placeholderSrc = getApparelPlaceholder(variant?.productType);
    if (placeholderSrc) {
      elements.apparelPreviewImage.src = placeholderSrc;
      elements.apparelPreviewImage.hidden = false;
    } else if (!elements.apparelPreviewImage.hidden) {
      elements.apparelPreviewImage.hidden = true;
      elements.apparelPreviewImage.removeAttribute('src');
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

  const product =
    state.apparelProducts.find((entry) => entry.handle === handle) || null;
  if (!product) {
    resetApparelSelectors();
    return;
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
  handleApparelColorChange();
}

function handleApparelColorChange() {
  const product = getSelectedApparelProduct();
  if (!product) {
    updateApparelPreview(null);
    return;
  }
  const color = elements.apparelColorSelect?.value || '';
  state.activeApparelColor = color || null;

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
    sizes.forEach((size) => {
      const option = document.createElement('option');
      option.value = size;
      option.textContent = size;
      elements.apparelSizeSelect.appendChild(option);
    });
    elements.apparelSizeSelect.disabled = false;
    elements.apparelSizeSelect.value = sizes[0];
  }

  if (elements.apparelQuantityInput) {
    elements.apparelQuantityInput.disabled = false;
  }
  handleApparelSizeChange();
}

function handleApparelSizeChange() {
  const variant = getSelectedApparelVariant();
  updateApparelPreview(variant);
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
      colorPageUrl: variant.colorPageUrl || null
    };
    state.selectedApparelItems.push(ensureApparelPricing(newItem));
  }
  renderSelectedApparelItems();
  if (elements.apparelQuantityInput) {
    elements.apparelQuantityInput.value = '1';
  }
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
    products.sort((a, b) =>
      (a.title || a.handle || '').localeCompare(b.title || b.handle || '')
    );
    state.apparelProducts = products;
    state.apparelVariantIndex = new Map();
    state.apparelCatalogLoaded = true;
    populateApparelProductSelect(products);
    resetApparelSelectors();
    if (elements.apparelStockNote) {
      elements.apparelStockNote.textContent =
        products.length > 0
          ? state.apparelDefaultNote || elements.apparelStockNote.textContent
          : 'No apparel products were returned. Confirm the CSV files are present and restart the save server.';
    }
  } catch (error) {
    console.error('Unable to load apparel catalog:', error);
    state.apparelProducts = [];
    state.apparelVariantIndex = new Map();
    state.apparelCatalogLoaded = false;
    if (elements.apparelProductSelect) {
      elements.apparelProductSelect.innerHTML =
        '<option value="">Apparel catalog unavailable</option>';
      elements.apparelProductSelect.disabled = true;
    }
    resetApparelSelectors();
    if (elements.apparelStockNote) {
      elements.apparelStockNote.textContent =
        'Apparel catalog unavailable. Start the save server (npm run save-server) and refresh this page.';
    }
  }
  renderSelectedApparelItems();
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
  const response = await fetch('/api/catalog', { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`Unable to load catalog (${response.status})`);
  }
  return response.json();
}

function updateColorPaletteHint(palette) {
  if (!elements.colorPaletteHint) return;
  elements.colorPaletteHint.textContent = palette?.description || '';
}

function renderColorSwatches() {
  if (!elements.colorSwatches) return;
  const palette = getPaletteById(state.activePaletteId);
  const container = elements.colorSwatches;
  container.innerHTML = '';
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

function renderDesignGrid() {
  elements.designGrid.innerHTML = '';
  if (!state.selectedCategory) {
    elements.designGrid.textContent = 'Select a category to browse designs.';
    elements.loadMoreButton.hidden = true;
    return;
  }

  const searchTerm = elements.searchInput.value.trim().toLowerCase();
  const allDesigns = state.selectedCategory.designs;

  state.filteredDesigns = allDesigns.filter((design) =>
    design.name.toLowerCase().includes(searchTerm)
  );

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
  img.loading = 'lazy';
  img.decoding = 'async';
  img.src = buildImageUrl(design.image, { width: 480, quality: 80 });
  img.alt = design.name;
  img.draggable = false;
  img.addEventListener('contextmenu', (event) => event.preventDefault());
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
  elements.selectedDesignLabel.textContent = design.name;
  highlightSelectedCard();
  renderSourceLinks(design);
  const resolvedDownloadUrl = resolveAssetUrl(design.image);
  state.previewDownloadUrl = resolvedDownloadUrl;
  const extension = extractFileExtension(design.image, 'png');
  state.previewDownloadName = `${slugifyFilename(design.name, 'catalog-design')}.${extension}`;
  updatePreviewDownloadAffordance();

  try {
    const image = await loadImage(design.image, { width: 1600, quality: 90 });
    state.previewImage = image;
    state.previewImageMode = 'library';
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
    state.textLayers.length === 0;
  elements.previewCanvas.classList.toggle('preview-download-available', available);
  if (elements.previewStage) {
    elements.previewStage.classList.toggle('preview-download-available', available);
  }
}

function renderSourceLinks(design = null) {
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
  elements.selectedCategoryLabel.textContent = state.selectedCategory
    ? state.selectedCategory.name
    : 'None';

  if (!state.selectedCategory) {
    elements.selectedDesignLabel.textContent = 'Select a design';
    return;
  }

  const design = state.selectedCategory.designs.find(
    (item) => item.id === state.selectedDesignId
  );
  elements.selectedDesignLabel.textContent = design ? design.name : 'Select a design';
}

function updateSize(value) {
  const numeric = Number(value) || state.selectedSize;
  state.selectedSize = numeric;
  const formattedSize = Number.isInteger(numeric) ? numeric.toFixed(0) : numeric.toFixed(1);
  elements.sizeValue.textContent = `${formattedSize}"`;
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
    if (!isCustomImage) {
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
  ctx.font = `${layer.fontSize}px ${layer.fontFamily}`;

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
  const colorSelection = usesColorCount ? elements.stickerColorSelect?.value || '1' : null;
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

    elements.quantityInput.value = '1';
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
      if (item.pricing.sizeInches) {
        details.appendChild(
          buildDetailLine('Sticker size', `${Number(item.pricing.sizeInches).toFixed(0)}"`)
        );
      }
      details.appendChild(buildDetailLine('Unit price', formatCents(item.pricing.unitPriceCents)));
      details.appendChild(buildDetailLine('Subtotal', formatCents(item.pricing.subtotalCents)));
      details.appendChild(buildDetailLine('Shipping', formatCents(item.pricing.shippingCents)));
      details.appendChild(buildDetailLine('Total', formatCents(item.pricing.totalCents)));
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
  elements.categorySelect.addEventListener('change', (event) => {
    setActiveCategory(event.target.value);
    elements.closeSidebarForMobile?.({ restoreFocus: false });
  });

  elements.searchInput.addEventListener('input', () => {
    state.renderLimit = DEFAULT_RENDER_LIMIT;
    renderDesignGrid();
  });

  elements.loadMoreButton.addEventListener('click', () => {
    state.renderLimit += RENDER_INCREMENT;
    renderDesignGrid();
  });

  elements.sizeSlider.addEventListener('input', (event) => {
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

  elements.customColorInput.addEventListener('input', (event) => {
    updateColorSelection(event.target.value);
  });

  elements.backgroundColorInput.addEventListener('input', (event) => {
    elements.backgroundPresetSelect.value = 'custom';
    updateBackgroundColor(event.target.value);
  });

  elements.backgroundPresetSelect.addEventListener('change', (event) => {
    const value = event.target.value;
    if (value === 'custom') {
      updateBackgroundColor(elements.backgroundColorInput.value);
    } else if (value) {
      elements.backgroundColorInput.value = value;
      updateBackgroundColor(value);
    }
  });

  elements.inventoryMaterialSelect?.addEventListener('change', handleInventoryMaterialChange);
  elements.inventoryRefreshButton?.addEventListener('click', handleInventoryRefresh);
  elements.inventoryAddForm?.addEventListener('submit', handleInventoryAddSubmit);
  elements.inventoryAdjustForm?.addEventListener('submit', handleInventoryAdjustSubmit);
  elements.inventoryUsageAddButton?.addEventListener('click', handleInventoryUsageAdd);
  elements.inventoryUsageList?.addEventListener('click', handleInventoryUsageListClick);

  elements.addTextButton.addEventListener('click', () => {
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
      updateSize(value);
    }
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

  elements.quantityInput.addEventListener('input', () => {
    updatePricingSummary();
  });

  elements.orderForm.addEventListener('submit', handleAddToOrder);
  elements.checkoutButton.addEventListener('click', handleCheckout);

  [elements.previewStage, elements.previewCanvas, elements.designGrid].forEach((node) => {
    node.addEventListener('contextmenu', (event) => event.preventDefault());
  });

  elements.previewCanvas.addEventListener('pointerdown', handleCanvasPointerDown);
  elements.previewCanvas.addEventListener('pointermove', handleCanvasPointerMove);
  elements.previewCanvas.addEventListener('pointerup', handleCanvasPointerUp);
  elements.previewCanvas.addEventListener('pointerleave', handleCanvasPointerUp);
  elements.previewCanvas.addEventListener('click', handlePreviewCanvasClick);

  initDesignerModal();
}

function bootstrapQuantityInput() {
  elements.quantityInput.value = '1';
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
      await loadApparelProducts();
    }
    applyStoreSelectionIfPresent();
    updatePricingSummary();
    setActiveCategory(state.categories[0].slug);
    updateSize(state.selectedSize);
    renderOrderSummary();
  } catch (error) {
    console.error(error);
    elements.designGrid.textContent =
      'Something went wrong while loading the catalog. Try regenerating it.';
  }
}

initResponsiveSidebar();
bootstrap();
