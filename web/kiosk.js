const CANVAS_PX_PER_INCH = 96;
const MIN_INCH = 2;
const MAX_INCH = 36;
const CANONICAL_HOST = 'https://store.swayzecustomvinyl.com';

const FONT_OPTIONS = [
  { label: 'Barlow', value: '"Barlow", "Segoe UI", sans-serif' },
  { label: 'Montserrat', value: '"Montserrat", "Segoe UI", sans-serif' },
  { label: 'Raleway', value: '"Raleway", "Segoe UI", sans-serif' },
  { label: 'Oswald', value: '"Oswald", "Segoe UI", sans-serif' },
  { label: 'Roboto Slab', value: '"Roboto Slab", serif' },
  { label: 'Playfair Display', value: '"Playfair Display", serif' },
  { label: 'Pacifico', value: '"Pacifico", cursive' },
  { label: 'Lobster', value: '"Lobster", cursive' },
  { label: 'Arial', value: 'Arial, sans-serif' }
];

const DEFAULT_TEXT_SETTINGS = {
  content: 'Custom Text',
  fontFamily: FONT_OPTIONS[0].value,
  fontSize: 120,
  color: '#000000',
  orientation: 'horizontal',
  curveAngle: 120,
  letterSpacing: 0,
  uppercase: false,
  scale: 0.4,
  x: 50,
  y: 40,
  rotation: 0
};

const DEFAULT_IMAGE_SETTINGS = {
  scale: 0.45,
  x: 50,
  y: 60,
  rotation: 0
};

const STICKER_PRICE_TABLE = {
  2: { 1: 325, 2: 350, 3: 375 },
  3: { 1: 350, 2: 375, 3: 400, 4: 425 },
  4: { 1: 375, 2: 425, 3: 450, 4: 500 },
  6: { 1: 425, 2: 500, 3: 575, 4: 700 },
  8: { 1: 500, 2: 575, 3: 650, 4: 750 },
  10: { 1: 575, 2: 650, 3: 750, 4: 850 },
  12: { 1: 650, 2: 750, 3: 850, 4: 950 }
};

const USD_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD'
});

function deepClone(value) {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

const state = {
  catalog: null,
  catalogAssetRoot: '',
  catalogCategories: [],
  selectedCategorySlug: '',
  filteredCatalog: [],
  layers: [],
  activeLayerId: null,
  backgroundColor: '#f8fafc',
  transparentBackground: false,
  backgroundShape: 'rectangle',
  backgroundRadiusInches: 0.5,
  vinylColor: '#ffffff',
  canvasWidthInches: 8,
  canvasHeightInches: 4,
  quantity: 1,
  pricing: null,
  isSaving: false,
  layerMetrics: new Map(),
  dragging: null
};

const elements = {
  status: document.getElementById('kioskStatus'),
  widthInput: document.getElementById('widthInput'),
  heightInput: document.getElementById('heightInput'),
  quantityInput: document.getElementById('quantityInput'),
  vinylColorInput: document.getElementById('vinylColorInput'),
  backgroundColorInput: document.getElementById('backgroundColorInput'),
  transparentBackgroundToggle: document.getElementById('transparentBackgroundToggle'),
  backgroundShapeRow: document.getElementById('backgroundShapeRow'),
  backgroundShapeSelect: document.getElementById('backgroundShapeSelect'),
  backgroundRadiusLabel: document.getElementById('backgroundRadiusLabel'),
  backgroundRadiusInput: document.getElementById('backgroundRadiusInput'),
  pricingTotal: document.getElementById('pricingTotal'),
  pricingDetails: document.getElementById('pricingDetails'),
  addTextLayerButton: document.getElementById('addTextLayerButton'),
  clearDesignButton: document.getElementById('clearDesignButton'),
  layerList: document.getElementById('layerList'),
  catalogCategorySelect: document.getElementById('catalogCategorySelect'),
  catalogSearchInput: document.getElementById('catalogSearchInput'),
  catalogList: document.getElementById('catalogList'),
  layerInspector: document.getElementById('layerInspector'),
  canvasWrapper: document.getElementById('canvasWrapper'),
  canvas: document.getElementById('designCanvas'),
  finishButton: document.getElementById('finishButton'),
  layerTemplate: document.getElementById('layerTemplate'),
  catalogItemTemplate: document.getElementById('catalogItemTemplate'),
  orderDialog: document.getElementById('orderDialog'),
  closeOrderDialog: document.getElementById('closeOrderDialog'),
  cancelOrderButton: document.getElementById('cancelOrderButton'),
  orderForm: document.getElementById('orderForm'),
  orderStatus: document.getElementById('orderStatus')
};

const ctx = elements.canvas.getContext('2d', { willReadFrequently: true });

function recordLayerMetrics(layerId, metrics) {
  if (!layerId) return;
  state.layerMetrics.set(layerId, metrics);
}

function clearLayerMetrics() {
  state.layerMetrics.clear();
}

function resolveSaveServerBase(port = '4000') {
  try {
    const current = new URL(window.location.href);
    const isDefaultPort = !current.port || current.port === '80' || current.port === '443';
    if (isDefaultPort) {
      return current.origin;
    }
    current.port = port;
    return current.origin;
  } catch (error) {
    const { protocol, hostname, port: currentPort } = window.location;
    const isDefaultPort = !currentPort || currentPort === '80' || currentPort === '443';
    if (isDefaultPort) {
      return `${protocol}//${hostname}`;
    }
    return `${protocol}//${hostname}:${port}`;
  }
}

const SAVE_SERVER_BASE = resolveSaveServerBase();
const SAVE_ENDPOINT = `${SAVE_SERVER_BASE}/api/save-design`;

function formatMoney(cents) {
  if (cents == null) return '$0.00';
  return USD_FORMATTER.format(cents / 100);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'design';
}

function computePricing({ widthInches, quantity }) {
  const sizeKey =
    Object.keys(STICKER_PRICE_TABLE)
      .map(Number)
      .sort((a, b) => a - b)
      .reduce((closest, size) => {
        if (!closest) return size;
        const diffCurrent = Math.abs(widthInches - closest);
        const diffCandidate = Math.abs(widthInches - size);
        return diffCandidate < diffCurrent ? size : closest;
      }, widthInches) || Math.round(widthInches);

  const colorCount = 1;
  const sizePricing = STICKER_PRICE_TABLE[sizeKey] || STICKER_PRICE_TABLE[4];
  const unitPriceCents = sizePricing?.[colorCount] ?? sizePricing?.[1] ?? 400;
  const qty = Math.max(1, quantity || 1);
  const subtotalCents = unitPriceCents * qty;
  const shippingCents = qty >= 4 ? 400 : 300;

  return {
    descriptor: `${sizeKey}" sticker · ${colorCount} color`,
    unitPriceCents,
    subtotalCents,
    shippingCents,
    totalCents: subtotalCents + shippingCents,
    colors: colorCount,
    sizeInches: sizeKey,
    quantity: qty,
    currency: 'USD'
  };
}

function setStatus(message, variant = 'info') {
  if (!elements.status) return;
  elements.status.textContent = message;
  elements.status.className = 'status';
  if (variant === 'success') {
    elements.status.classList.add('success');
  } else if (variant === 'error') {
    elements.status.classList.add('error');
  }
}

function setCanvasSize(widthInches, heightInches) {
  const widthPx = Math.max(1, Math.round(widthInches * CANVAS_PX_PER_INCH));
  const heightPx = Math.max(1, Math.round(heightInches * CANVAS_PX_PER_INCH));
  elements.canvas.width = widthPx;
  elements.canvas.height = heightPx;
  renderCanvas();
}

function addLayer(layer) {
  state.layers.push(layer);
  state.activeLayerId = layer.id;
  renderLayerList();
  renderInspector();
  renderCanvas();
}

function duplicateLayer(layerId) {
  const source = state.layers.find((item) => item.id === layerId);
  if (!source) return;
  const copy = {
    ...deepClone(source),
    id: `${source.type}-${Date.now()}`,
    name: `${source.name || 'Layer'} copy`,
    x: clamp(source.x + 5, 0, 100),
    y: clamp(source.y + 5, 0, 100)
  };
  if (copy.type === 'image') {
    // Reuse the same image reference
    copy.image = source.image;
  }
  addLayer(copy);
}

function removeLayer(layerId) {
  state.layers = state.layers.filter((layer) => layer.id !== layerId);
  if (state.activeLayerId === layerId) {
    state.activeLayerId = state.layers.length ? state.layers[state.layers.length - 1].id : null;
  }
  renderLayerList();
  renderInspector();
  renderCanvas();
}

function clearLayers() {
  state.layers = [];
  state.activeLayerId = null;
  state.layerMetrics.clear();
  state.dragging = null;
  renderLayerList();
  renderInspector();
  renderCanvas();
}

function selectLayer(layerId) {
  if (state.activeLayerId === layerId) return;
  state.activeLayerId = layerId;
  renderLayerList();
  renderInspector();
  renderCanvas();
}

function updateLayer(layerId, updates, options = {}) {
  const layer = state.layers.find((item) => item.id === layerId);
  if (!layer) return;
  Object.assign(layer, updates);
  if (!options.skipLayerList) {
    renderLayerList();
  }
  if (!options.skipInspector) {
    renderInspector();
  }
  if (!options.skipCanvas) {
    renderCanvas();
  }
}

function renderLayerList() {
  const list = elements.layerList;
  if (!list) return;
  if (!state.layers.length) {
    list.innerHTML = 'No layers yet. Add text or graphics.';
    list.classList.add('empty');
    return;
  }
  list.classList.remove('empty');
  list.innerHTML = '';
  const fragment = document.createDocumentFragment();

  state.layers.forEach((layer, index) => {
    const template = elements.layerTemplate.content.cloneNode(true);
    const card = template.querySelector('.layer-card');
    const title = template.querySelector('.layer-title');
    const name = layer.name || (layer.type === 'text' ? `Text ${index + 1}` : `Graphic ${index + 1}`);
    title.textContent = name;
    card.dataset.layerId = layer.id;
    if (layer.id === state.activeLayerId) {
      card.classList.add('active');
    }
    card.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (button) return; // handled below
      selectLayer(layer.id);
    });
    template.querySelector('[data-action="duplicate"]').addEventListener('click', (event) => {
      event.stopPropagation();
      duplicateLayer(layer.id);
    });
    template.querySelector('[data-action="delete"]').addEventListener('click', (event) => {
      event.stopPropagation();
      removeLayer(layer.id);
    });
    fragment.appendChild(template);
  });

  list.appendChild(fragment);
}

function drawImageLayer(layer) {
  const { image } = layer;
  if (!image) return;
  const canvasWidth = elements.canvas.width;
  const canvasHeight = elements.canvas.height;
  const drawWidth = canvasWidth * clamp(layer.scale, 0.05, 1.5);
  const aspect = image.naturalHeight / image.naturalWidth || 1;
  const drawHeight = drawWidth * aspect;
  const centerX = (layer.x / 100) * canvasWidth;
  const centerY = (layer.y / 100) * canvasHeight;
  const rotation = ((layer.rotation || 0) * Math.PI) / 180;

  ctx.save();
  ctx.translate(centerX, centerY);
  ctx.rotate(rotation);
  ctx.globalAlpha = clamp(layer.opacity ?? 1, 0, 1);
  ctx.drawImage(image, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
  ctx.restore();
  recordLayerMetrics(layer.id, {
    centerX,
    centerY,
    width: drawWidth,
    height: drawHeight,
    rotation
  });
}

function computeHorizontalTextWidth(content, letterSpacing) {
  if (!content) return 0;
  const characters = content.split('');
  let width = 0;
  characters.forEach((char) => {
    width += ctx.measureText(char).width;
  });
  if (characters.length > 1) {
    width += (letterSpacing || 0) * (characters.length - 1);
  }
  return width;
}

function drawHorizontalText(layer) {
  const centerX = (layer.x / 100) * elements.canvas.width;
  const centerY = (layer.y / 100) * elements.canvas.height;
  const rotation = ((layer.rotation || 0) * Math.PI) / 180;
  const fontSize = layer.fontSize || DEFAULT_TEXT_SETTINGS.fontSize;

  ctx.save();
  ctx.translate(centerX, centerY);
  ctx.rotate(rotation);
  ctx.fillStyle = layer.color || '#000000';
  ctx.font = `${layer.uppercase ? '600 ' : ''}${fontSize}px ${layer.fontFamily}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const content = layer.uppercase ? layer.content.toUpperCase() : layer.content || '';
  const letterSpacing = layer.letterSpacing || 0;
  const textWidth = Math.max(computeHorizontalTextWidth(content, letterSpacing), fontSize);
  if (letterSpacing) {
    drawSpacedText(content, letterSpacing, fontSize);
  } else {
    ctx.fillText(content, 0, 0);
  }
  ctx.restore();
  recordLayerMetrics(layer.id, {
    centerX,
    centerY,
    width: textWidth,
    height: fontSize * 1.2,
    rotation
  });
}

function drawSpacedText(text, spacing, fontSize) {
  const characters = text.split('');
  const totalWidth =
    characters.reduce((width, char) => width + ctx.measureText(char).width, 0) +
    spacing * (characters.length - 1);
  let cursorX = -totalWidth / 2;

  characters.forEach((char) => {
    ctx.fillText(char, cursorX + ctx.measureText(char).width / 2, 0);
    cursorX += ctx.measureText(char).width + spacing;
  });
}

function drawVerticalText(layer) {
  const centerX = (layer.x / 100) * elements.canvas.width;
  const centerY = (layer.y / 100) * elements.canvas.height;
  const rotation = ((layer.rotation || 0) * Math.PI) / 180;
  const fontSize = layer.fontSize || DEFAULT_TEXT_SETTINGS.fontSize;
  const content = (layer.uppercase ? layer.content.toUpperCase() : layer.content || '').split('');

  ctx.save();
  ctx.translate(centerX, centerY);
  ctx.rotate(rotation);
  ctx.fillStyle = layer.color || '#000000';
  ctx.font = `${fontSize}px ${layer.fontFamily}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  let cursorY = -(content.length - 1) * (fontSize + (layer.letterSpacing || 0)) * 0.5;
  content.forEach((char) => {
    ctx.fillText(char, 0, cursorY);
    cursorY += fontSize + (layer.letterSpacing || 0);
  });
  ctx.restore();
  const totalHeight =
    content.length * fontSize + Math.max(0, content.length - 1) * (layer.letterSpacing || 0);
  const height = Math.max(totalHeight, fontSize);
  recordLayerMetrics(layer.id, {
    centerX,
    centerY,
    width: fontSize * 1.5,
    height,
    rotation
  });
}

function drawCurvedText(layer, fullCircle = false) {
  const centerX = (layer.x / 100) * elements.canvas.width;
  const centerY = (layer.y / 100) * elements.canvas.height;
  const rotation = ((layer.rotation || 0) * Math.PI) / 180;
  const fontSize = layer.fontSize || DEFAULT_TEXT_SETTINGS.fontSize;
  const text = layer.uppercase ? layer.content.toUpperCase() : layer.content || '';

  if (!text.trim()) return;

  const totalArcDegrees = clamp(layer.curveAngle ?? 160, 40, 360);
  const totalArc = fullCircle ? 2 * Math.PI : (totalArcDegrees * Math.PI) / 180;
  const radius =
    Math.min(elements.canvas.width, elements.canvas.height) *
    clamp(layer.scale || 0.4, 0.1, 1.2);

  ctx.save();
  ctx.translate(centerX, centerY);
  ctx.rotate(rotation);
  ctx.fillStyle = layer.color || '#000000';
  ctx.font = `${fontSize}px ${layer.fontFamily}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const spacing = (layer.letterSpacing || 0) / 100;
  const characters = text.split('');
  const charArc = totalArc / Math.max(characters.length, 1);
  let startAngle = fullCircle ? -Math.PI / 2 : -totalArc / 2;

  characters.forEach((char) => {
    ctx.save();
    ctx.rotate(startAngle);
    ctx.translate(0, -radius);
    ctx.rotate(fullCircle ? Math.PI / 2 : 0);
    ctx.fillText(char, 0, 0);
    ctx.restore();
    startAngle += charArc + spacing;
  });
  ctx.restore();
  const diameter = radius * 2 + fontSize * 1.2;
  recordLayerMetrics(layer.id, {
    centerX,
    centerY,
    width: diameter,
    height: diameter,
    rotation
  });
}

function drawLayer(layer) {
  if (layer.type === 'image') {
    drawImageLayer(layer);
    return;
  }
  switch (layer.orientation) {
    case 'vertical':
      drawVerticalText(layer);
      break;
    case 'arc':
      drawCurvedText(layer, false);
      break;
    case 'circle':
      drawCurvedText(layer, true);
      break;
    default:
      drawHorizontalText(layer);
  }
}

function drawBackgroundShape() {
  const width = elements.canvas.width;
  const height = elements.canvas.height;
  const fill = state.backgroundColor || '#ffffff';
  ctx.save();
  ctx.fillStyle = fill;

  switch (state.backgroundShape) {
    case 'rounded': {
      const radiusPx = Math.min(
        Math.max(0, state.backgroundRadiusInches) * CANVAS_PX_PER_INCH,
        Math.min(width, height) / 2
      );
      ctx.beginPath();
      ctx.moveTo(radiusPx, 0);
      ctx.lineTo(width - radiusPx, 0);
      ctx.quadraticCurveTo(width, 0, width, radiusPx);
      ctx.lineTo(width, height - radiusPx);
      ctx.quadraticCurveTo(width, height, width - radiusPx, height);
      ctx.lineTo(radiusPx, height);
      ctx.quadraticCurveTo(0, height, 0, height - radiusPx);
      ctx.lineTo(0, radiusPx);
      ctx.quadraticCurveTo(0, 0, radiusPx, 0);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'ellipse': {
      ctx.beginPath();
      ctx.ellipse(width / 2, height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
      ctx.closePath();
      ctx.fill();
      break;
    }
    default: {
      ctx.fillRect(0, 0, width, height);
    }
  }

  ctx.restore();
}

function renderCanvas() {
  ctx.clearRect(0, 0, elements.canvas.width, elements.canvas.height);
  clearLayerMetrics();

  if (!state.transparentBackground) {
    elements.canvasWrapper.classList.remove('transparent');
    drawBackgroundShape();
  } else {
    elements.canvasWrapper.classList.add('transparent');
  }

  state.layers.forEach(drawLayer);
}

function renderInspector() {
  const container = elements.layerInspector;
  if (!container) return;
  const layer = state.layers.find((item) => item.id === state.activeLayerId);
  if (!layer) {
    container.innerHTML = '<p class="placeholder">Select a layer to edit controls.</p>';
    return;
  }

  const controls = document.createElement('div');
  controls.className = 'controls';

  const makeInput = (labelText, inputEl) => {
    const wrapper = document.createElement('label');
    wrapper.textContent = labelText;
    wrapper.appendChild(inputEl);
    return wrapper;
  };

  const positionRow = document.createElement('div');
  positionRow.className = 'form-row';

  const xInput = document.createElement('input');
  xInput.type = 'range';
  xInput.min = 0;
  xInput.max = 100;
  xInput.value = layer.x;
  xInput.addEventListener('input', (event) => updateLayer(layer.id, { x: Number(event.target.value) }));
  positionRow.appendChild(makeInput('Horizontal', xInput));

  const yInput = document.createElement('input');
  yInput.type = 'range';
  yInput.min = 0;
  yInput.max = 100;
  yInput.value = layer.y;
  yInput.addEventListener('input', (event) => updateLayer(layer.id, { y: Number(event.target.value) }));
  positionRow.appendChild(makeInput('Vertical', yInput));

  controls.appendChild(positionRow);

  const rotationInput = document.createElement('input');
  rotationInput.type = 'range';
  rotationInput.min = -180;
  rotationInput.max = 180;
  rotationInput.value = layer.rotation || 0;
  rotationInput.addEventListener('input', (event) =>
    updateLayer(layer.id, { rotation: Number(event.target.value) })
  );
  controls.appendChild(makeInput('Rotation (°)', rotationInput));

  if (layer.type === 'image') {
    const scaleInput = document.createElement('input');
    scaleInput.type = 'range';
    scaleInput.min = 5;
    scaleInput.max = 150;
    scaleInput.value = Math.round((layer.scale || DEFAULT_IMAGE_SETTINGS.scale) * 100);
    scaleInput.addEventListener('input', (event) =>
      updateLayer(layer.id, { scale: Number(event.target.value) / 100 })
    );
    controls.appendChild(makeInput('Size (%)', scaleInput));
  } else {
    const textInput = document.createElement('input');
    textInput.type = 'text';
    textInput.value = layer.content;
    textInput.addEventListener('input', (event) =>
      updateLayer(
        layer.id,
        { content: event.target.value },
        { skipLayerList: true, skipInspector: true }
      )
    );
    controls.appendChild(makeInput('Text', textInput));

    const fontRow = document.createElement('div');
    fontRow.className = 'form-row';

    const fontSizeInput = document.createElement('input');
    fontSizeInput.type = 'range';
    fontSizeInput.min = 40;
    fontSizeInput.max = 300;
    fontSizeInput.value = layer.fontSize || DEFAULT_TEXT_SETTINGS.fontSize;
    fontSizeInput.addEventListener('input', (event) =>
      updateLayer(layer.id, { fontSize: Number(event.target.value) })
    );
    fontRow.appendChild(makeInput('Font size', fontSizeInput));

    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = layer.color || '#000000';
    colorInput.addEventListener('input', (event) => updateLayer(layer.id, { color: event.target.value }));
    fontRow.appendChild(makeInput('Color', colorInput));
    controls.appendChild(fontRow);

    const fontSelect = document.createElement('select');
    FONT_OPTIONS.forEach((font) => {
      const option = document.createElement('option');
      option.value = font.value;
      option.textContent = font.label;
      option.selected = font.value === layer.fontFamily;
      fontSelect.appendChild(option);
    });
    fontSelect.addEventListener('change', (event) =>
      updateLayer(layer.id, { fontFamily: event.target.value })
    );
    controls.appendChild(makeInput('Font family', fontSelect));

    const orientationSelect = document.createElement('select');
    [
      { value: 'horizontal', label: 'Horizontal' },
      { value: 'arc', label: 'Curved' },
      { value: 'circle', label: 'Circle' },
      { value: 'vertical', label: 'Vertical' }
    ].forEach((optionData) => {
      const option = document.createElement('option');
      option.value = optionData.value;
      option.textContent = optionData.label;
      option.selected = optionData.value === layer.orientation;
      orientationSelect.appendChild(option);
    });
    orientationSelect.addEventListener('change', (event) =>
      updateLayer(layer.id, { orientation: event.target.value })
    );
    controls.appendChild(makeInput('Orientation', orientationSelect));

    if (layer.orientation === 'arc' || layer.orientation === 'circle') {
      const curveInput = document.createElement('input');
      curveInput.type = 'range';
      curveInput.min = 40;
      curveInput.max = 360;
      curveInput.value = clamp(layer.curveAngle ?? DEFAULT_TEXT_SETTINGS.curveAngle, 40, 360);
      curveInput.addEventListener('input', (event) =>
        updateLayer(layer.id, { curveAngle: Number(event.target.value) })
      );
      controls.appendChild(makeInput('Curve angle', curveInput));
    }

    const spacingInput = document.createElement('input');
    spacingInput.type = 'range';
    spacingInput.min = 0;
    spacingInput.max = 100;
    spacingInput.value = layer.letterSpacing || 0;
    spacingInput.addEventListener('input', (event) =>
      updateLayer(layer.id, { letterSpacing: Number(event.target.value) })
    );
    controls.appendChild(makeInput('Letter spacing', spacingInput));

    const uppercaseToggle = document.createElement('label');
    uppercaseToggle.className = 'checkbox';
    const uppercaseInput = document.createElement('input');
    uppercaseInput.type = 'checkbox';
    uppercaseInput.checked = Boolean(layer.uppercase);
    uppercaseInput.addEventListener('change', (event) =>
      updateLayer(layer.id, { uppercase: event.target.checked })
    );
    uppercaseToggle.appendChild(uppercaseInput);
    uppercaseToggle.append('Uppercase');
    controls.appendChild(uppercaseToggle);
  }

  container.innerHTML = '';
  container.appendChild(controls);
}

function ensureHttps(value) {
  if (!value || typeof value !== 'string') return value;
  return value.replace(/^http:\/\//i, 'https://');
}

function updateBackgroundShapeControls() {
  const row = elements.backgroundShapeRow;
  const shapeSelect = elements.backgroundShapeSelect;
  const radiusLabel = elements.backgroundRadiusLabel;
  const radiusInput = elements.backgroundRadiusInput;
  const isTransparent = state.transparentBackground;
  const isRounded = state.backgroundShape === 'rounded';

  if (row) {
    row.classList.toggle('hidden', isTransparent);
  }
  if (shapeSelect) {
    shapeSelect.value = state.backgroundShape;
    shapeSelect.disabled = isTransparent;
  }
  if (radiusLabel) {
    radiusLabel.classList.toggle('hidden', isTransparent || !isRounded);
  }
  if (radiusInput) {
    radiusInput.value = String(state.backgroundRadiusInches);
    radiusInput.disabled = isTransparent || !isRounded;
  }
}

function resolveAssetUrl(pathValue, { width, quality } = {}) {
  if (!pathValue) return '';
  if (/^https?:/i.test(pathValue)) {
    try {
      const current = new URL(window.location.href);
      const url = new URL(pathValue);
      url.protocol = current.protocol;
      url.hostname = current.hostname;
      url.port = current.port;
      if (width) {
        const clampedWidth = Math.min(Math.max(Math.round(width), 1), 2400);
        url.searchParams.set('w', String(clampedWidth));
      }
      if (quality) {
        url.searchParams.set('q', String(Math.min(Math.max(quality, 40), 95)));
      }
      return url.toString();
    } catch (error) {
      return pathValue;
    }
  }
  if (/^data:/i.test(pathValue)) return pathValue;
  if (pathValue.startsWith('/api/')) {
    const url = new URL(pathValue, window.location.origin);
    if (width) {
      const clampedWidth = Math.min(Math.max(Math.round(width), 1), 2400);
      url.searchParams.set('w', String(clampedWidth));
    }
    if (quality) {
      url.searchParams.set('q', String(Math.min(Math.max(quality, 40), 95)));
    }
    return url.toString();
  }
  const assetRoot = state.catalogAssetRoot?.trim();
  const fallback = `${CANONICAL_HOST}/web/`;
  const base = ensureHttps(assetRoot && assetRoot.length ? assetRoot : fallback);
  try {
    const normalized = pathValue.replace(/^\.\//, '');
    const baseUrl = base.endsWith('/') ? base : `${base}/`;
    const url = new URL(normalized, baseUrl);
    if (width) {
      const clampedWidth = Math.min(Math.max(Math.round(width), 1), 2400);
      url.searchParams.set('w', String(clampedWidth));
    }
    if (quality) {
      url.searchParams.set('q', String(Math.min(Math.max(quality, 40), 95)));
    }
    return url.href;
  } catch (error) {
    return pathValue;
  }
}

async function loadCatalog() {
  try {
    setStatus('Loading catalog…');
    const catalogOrigin = ensureHttps(CANONICAL_HOST);
    const catalogUrl = `${catalogOrigin}/api/catalog`;
    const response = await fetch(catalogUrl, { cache: 'no-cache' });
    if (!response.ok) {
      throw new Error(`Failed to load catalog (${response.status})`);
    }
    const catalog = await response.json();
    state.catalog = catalog;
    state.catalogAssetRoot = catalog.assetRoot || '';
    state.catalogCategories = Array.isArray(catalog.categories) ? catalog.categories : [];
    if (state.catalogCategories.length) {
      state.selectedCategorySlug = state.catalogCategories[0].slug;
      populateCatalogCategories();
      filterCatalogDesigns();
      renderCatalogList();
      setStatus('Catalog ready', 'success');
    } else {
      setStatus('Catalog has no categories.', 'error');
    }
  } catch (error) {
    state.catalog = null;
    state.catalogCategories = [];
    state.filteredCatalog = [];
    elements.catalogList.innerHTML =
      '<p class="hint">Unable to load catalog. Please contact an attendant.</p>';
    setStatus(error.message || 'Unable to load catalog', 'error');
  }
}

function populateCatalogCategories() {
  const select = elements.catalogCategorySelect;
  if (!select) return;
  select.innerHTML = '';
  if (!state.catalogCategories.length) {
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'No categories available';
    placeholder.disabled = true;
    placeholder.selected = true;
    select.appendChild(placeholder);
    return;
  }
  state.catalogCategories.forEach((category) => {
    const option = document.createElement('option');
    option.value = category.slug;
    option.textContent = `${category.name} (${category.designs.length})`;
    option.selected = category.slug === state.selectedCategorySlug;
    select.appendChild(option);
  });
  if (!state.selectedCategorySlug && state.catalogCategories.length) {
    state.selectedCategorySlug = state.catalogCategories[0].slug;
  }
  if (state.selectedCategorySlug) {
    select.value = state.selectedCategorySlug;
  }
}

function filterCatalogDesigns() {
  const category = state.catalogCategories.find((item) => item.slug === state.selectedCategorySlug);
  const searchTerm = elements.catalogSearchInput.value.trim().toLowerCase();
  if (!category) {
    state.filteredCatalog = [];
    return;
  }
  state.filteredCatalog = category.designs.filter((design) =>
    design.name.toLowerCase().includes(searchTerm)
  );
}

function renderCatalogList() {
  const container = elements.catalogList;
  if (!container) return;
  if (!state.filteredCatalog.length) {
    container.innerHTML = '<p class="hint">No graphics match your search.</p>';
    container.classList.add('empty');
    return;
  }
  container.classList.remove('empty');
  container.innerHTML = '';
  const fragment = document.createDocumentFragment();

  state.filteredCatalog.slice(0, 120).forEach((design) => {
    const template = elements.catalogItemTemplate.content.cloneNode(true);
    const button = template.querySelector('.catalog-item');
    const img = template.querySelector('img');
    const name = template.querySelector('.name');
    img.src = resolveAssetUrl(design.image, { width: 480, quality: 80 });
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = design.name;
    name.textContent = design.name;
    button.addEventListener('click', () => addCatalogDesign(design));
    fragment.appendChild(template);
  });

  container.appendChild(fragment);
}

function addCatalogDesign(design) {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.onload = () => {
    addLayer({
      ...deepClone(DEFAULT_IMAGE_SETTINGS),
      id: `image-${Date.now()}`,
      type: 'image',
      name: design.name,
      image,
      source: resolveAssetUrl(design.image, { width: 1600, quality: 90 })
    });
  };
  image.onerror = () => {
    showToast('Unable to load graphic. Try another selection.', 'error');
  };
  image.src = resolveAssetUrl(design.image, { width: 1600, quality: 90 });
}

function addTextLayer() {
  addLayer({
    id: `text-${Date.now()}`,
    type: 'text',
    name: 'Custom text',
    ...deepClone(DEFAULT_TEXT_SETTINGS)
  });
}

function showToast(message, variant = 'info', timeout = 4200) {
  const container = document.getElementById('toastContainer');
  if (!container) {
    console[variant === 'error' ? 'error' : 'log'](message);
    return;
  }
  const toast = document.createElement('div');
  toast.className = `toast ${variant}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('hide');
    setTimeout(() => toast.remove(), 300);
  }, timeout);
}

function updatePricing() {
  state.pricing = computePricing({
    widthInches: state.canvasWidthInches,
    quantity: state.quantity
  });
  elements.pricingTotal.textContent = formatMoney(state.pricing.totalCents);
  elements.pricingDetails.textContent = `${state.pricing.descriptor} · Qty ${state.pricing.quantity}`;
}

function openOrderDialog() {
  elements.orderDialog.classList.remove('hidden');
  elements.orderStatus.textContent = 'Awaiting submission.';
  elements.orderStatus.className = 'status-bar muted';
}

function closeOrderDialog() {
  if (state.isSaving) return;
  elements.orderDialog.classList.add('hidden');
  elements.orderForm.reset();
  elements.orderStatus.textContent = 'Awaiting submission.';
  elements.orderStatus.className = 'status-bar muted';
}

async function submitOrder(event) {
  event.preventDefault();
  if (state.isSaving) return;
  if (!state.layers.length) {
    elements.orderStatus.textContent = 'Add at least one text or graphic before saving.';
    elements.orderStatus.className = 'status-bar error';
    return;
  }

  try {
    state.isSaving = true;
    elements.orderStatus.textContent = 'Submitting order…';
    elements.orderStatus.className = 'status-bar muted';

    renderCanvas(); // ensure canvas reflects latest settings
    const imageData = elements.canvas.toDataURL('image/png');
    const formData = new FormData(elements.orderForm);
    const customer = {
      name: formData.get('name')?.trim() || '',
      phone: formData.get('phone')?.trim() || '',
      email: formData.get('email')?.trim() || ''
    };
    const notesInput = formData.get('notes')?.trim();

    const payload = {
      imageData,
      designId: `kiosk-${Date.now()}`,
      designName: 'Custom kiosk sticker',
      category: 'Kiosk Custom',
      size: Number(state.canvasWidthInches.toFixed(2)),
      color: state.vinylColor,
      background: state.transparentBackground ? 'transparent' : state.backgroundColor,
      quantity: state.quantity,
      notes: buildOrderNotes(notesInput),
      textLayers: state.layers
        .filter((layer) => layer.type === 'text')
        .map((layer) => ({
          content: layer.content,
          fontFamily: layer.fontFamily,
          fontSize: layer.fontSize,
          color: layer.color,
          orientation: layer.orientation,
          curveAngle: layer.curveAngle,
          letterSpacing: layer.letterSpacing,
          uppercase: layer.uppercase,
          x: layer.x,
          y: layer.y,
          rotation: layer.rotation
        })),
      designSources: {},
      pricing: state.pricing,
      customer,
      metadata: {
        widthInches: state.canvasWidthInches,
        heightInches: state.canvasHeightInches,
        transparentBackground: state.transparentBackground,
        backgroundShape: state.backgroundShape,
        backgroundRadiusInches: state.backgroundRadiusInches,
        backgroundColor: state.backgroundColor,
        vinylColor: state.vinylColor,
        layerCount: state.layers.length,
        submittedFrom: 'kiosk'
      }
    };

    const response = await fetch(SAVE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.error || `Save failed (${response.status})`);
    }

    elements.orderStatus.textContent =
      'Order received! Please let our team know so we can finalize payment.';
    elements.orderStatus.className = 'status-bar success';
    showToast('Order submitted to production queue.', 'success', 6000);
    state.layers = [];
    state.activeLayerId = null;
    renderLayerList();
    renderInspector();
    renderCanvas();
  } catch (error) {
    console.error('Unable to save kiosk order:', error);
    elements.orderStatus.textContent = error.message || 'Unable to submit order.';
    elements.orderStatus.className = 'status-bar error';
  } finally {
    state.isSaving = false;
  }
}

function buildOrderNotes(extraNotes) {
  const backgroundDescription = state.transparentBackground
    ? 'transparent'
    : `${state.backgroundColor} (${state.backgroundShape}${
        state.backgroundShape === 'rounded'
          ? `, radius ${state.backgroundRadiusInches.toFixed(2)}"`
          : ''
      })`;
  const baseNotes = [
    `Kiosk order submitted ${new Date().toLocaleString()}.`,
    `Canvas size: ${state.canvasWidthInches.toFixed(1)}" × ${state.canvasHeightInches.toFixed(1)}".`,
    `Background: ${backgroundDescription}.`,
    `Vinyl color: ${state.vinylColor}.`,
    `Layers: ${state.layers.length}.`,
    'Payment status: awaiting collection.'
  ];
  if (extraNotes) {
    baseNotes.push(`Customer note: ${extraNotes}`);
  }
  return baseNotes.join('\n');
}

function getCanvasPoint(event) {
  const rect = elements.canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return {
    x: ((event.clientX - rect.left) / rect.width) * elements.canvas.width,
    y: ((event.clientY - rect.top) / rect.height) * elements.canvas.height
  };
}

function pointInLayer(point, metrics) {
  if (!metrics || !metrics.width || !metrics.height) return false;
  const dx = point.x - metrics.centerX;
  const dy = point.y - metrics.centerY;
  const angle = -(metrics.rotation || 0);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const localX = dx * cos - dy * sin;
  const localY = dx * sin + dy * cos;
  return Math.abs(localX) <= metrics.width / 2 && Math.abs(localY) <= metrics.height / 2;
}

function findLayerAtPoint(point) {
  for (let i = state.layers.length - 1; i >= 0; i -= 1) {
    const layer = state.layers[i];
    const metrics = state.layerMetrics.get(layer.id);
    if (metrics && pointInLayer(point, metrics)) {
      return layer;
    }
  }
  return null;
}

function handleCanvasPointerDown(event) {
  const point = getCanvasPoint(event);
  if (!point) return;

  const targetLayer = findLayerAtPoint(point);
  if (!targetLayer) return;

  selectLayer(targetLayer.id);

  const metrics = state.layerMetrics.get(targetLayer.id);
  if (!metrics) return;

  state.dragging = {
    layerId: targetLayer.id,
    pointerId: event.pointerId,
    offsetX: point.x - metrics.centerX,
    offsetY: point.y - metrics.centerY
  };

  try {
    elements.canvas.setPointerCapture(event.pointerId);
  } catch (error) {
    // Ignore capture errors on unsupported browsers.
  }
  elements.canvasWrapper.classList.add('dragging');
}

function handleCanvasPointerMove(event) {
  if (!state.dragging || state.dragging.pointerId !== event.pointerId) return;
  const point = getCanvasPoint(event);
  if (!point) return;

  const { offsetX, offsetY, layerId } = state.dragging;
  const canvasWidth = elements.canvas.width;
  const canvasHeight = elements.canvas.height;

  const centerX = clamp(point.x - offsetX, 0, canvasWidth);
  const centerY = clamp(point.y - offsetY, 0, canvasHeight);

  const percentX = clamp((centerX / canvasWidth) * 100, 0, 100);
  const percentY = clamp((centerY / canvasHeight) * 100, 0, 100);

  updateLayer(layerId, { x: percentX, y: percentY }, { skipLayerList: true, skipInspector: true });
}

function endCanvasDrag(pointerId) {
  if (state.dragging && state.dragging.pointerId === pointerId) {
    state.dragging = null;
    elements.canvasWrapper.classList.remove('dragging');
  }
}

function handleCanvasPointerUp(event) {
  if (state.dragging && state.dragging.pointerId === event.pointerId) {
    try {
      elements.canvas.releasePointerCapture(event.pointerId);
    } catch (error) {
      // Ignore release errors
    }
  }
  endCanvasDrag(event.pointerId);
}

function handleCanvasPointerLeave(event) {
  endCanvasDrag(event.pointerId);
}

function initEventListeners() {
  elements.widthInput.addEventListener('input', (event) => {
    const value = clamp(Number(event.target.value) || MIN_INCH, MIN_INCH, MAX_INCH);
    state.canvasWidthInches = value;
    event.target.value = value;
    setCanvasSize(state.canvasWidthInches, state.canvasHeightInches);
    updatePricing();
  });

  elements.heightInput.addEventListener('input', (event) => {
    const value = clamp(Number(event.target.value) || MIN_INCH, MIN_INCH, MAX_INCH);
    state.canvasHeightInches = value;
    event.target.value = value;
    setCanvasSize(state.canvasWidthInches, state.canvasHeightInches);
  });

  elements.quantityInput.addEventListener('input', (event) => {
    const value = clamp(Number(event.target.value) || 1, 1, 999);
    state.quantity = value;
    event.target.value = value;
    updatePricing();
  });

  elements.vinylColorInput.addEventListener('input', (event) => {
    state.vinylColor = event.target.value;
  });

  elements.backgroundColorInput.addEventListener('input', (event) => {
    state.backgroundColor = event.target.value;
    renderCanvas();
  });

  elements.transparentBackgroundToggle.addEventListener('change', (event) => {
    state.transparentBackground = event.target.checked;
    updateBackgroundShapeControls();
    renderCanvas();
  });

  if (elements.backgroundShapeSelect) {
    elements.backgroundShapeSelect.addEventListener('change', (event) => {
      state.backgroundShape = event.target.value || 'rectangle';
      updateBackgroundShapeControls();
      renderCanvas();
    });
  }

  if (elements.backgroundRadiusInput) {
    elements.backgroundRadiusInput.addEventListener('input', (event) => {
      const value = Math.max(0, Number(event.target.value) || 0);
      state.backgroundRadiusInches = value;
      updateBackgroundShapeControls();
      renderCanvas();
    });
  }

  elements.addTextLayerButton.addEventListener('click', addTextLayer);
  elements.clearDesignButton.addEventListener('click', () => {
    clearLayers();
    showToast('All layers cleared.', 'info');
  });

  elements.catalogCategorySelect.addEventListener('change', (event) => {
    state.selectedCategorySlug = event.target.value;
    filterCatalogDesigns();
    renderCatalogList();
  });

  elements.catalogSearchInput.addEventListener('input', () => {
    filterCatalogDesigns();
    renderCatalogList();
  });

  elements.finishButton.addEventListener('click', openOrderDialog);
  elements.closeOrderDialog.addEventListener('click', closeOrderDialog);
  elements.cancelOrderButton.addEventListener('click', closeOrderDialog);
  elements.orderForm.addEventListener('submit', submitOrder);

  elements.canvas.addEventListener('pointerdown', handleCanvasPointerDown);
  elements.canvas.addEventListener('pointermove', handleCanvasPointerMove);
  elements.canvas.addEventListener('pointerup', handleCanvasPointerUp);
  elements.canvas.addEventListener('pointerleave', handleCanvasPointerLeave);
  elements.canvas.addEventListener('pointercancel', handleCanvasPointerUp);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !elements.orderDialog.classList.contains('hidden')) {
      closeOrderDialog();
    }
  });
}

function bootstrap() {
  const toastContainer = document.createElement('div');
  toastContainer.id = 'toastContainer';
  toastContainer.className = 'toast-container';
  document.body.appendChild(toastContainer);

  setCanvasSize(state.canvasWidthInches, state.canvasHeightInches);
  updateBackgroundShapeControls();
  updatePricing();
  initEventListeners();
  loadCatalog();
}

bootstrap();
