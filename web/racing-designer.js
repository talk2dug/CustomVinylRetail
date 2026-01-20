/**
 * Race Car Decal Designer
 * Handles the multi-step wizard for designing race car decals
 */

// ============================================================================
// State Management
// ============================================================================

const state = {
  currentStep: 1,
  isAuthenticated: false,
  customer: null,
  token: null,
  designId: null,
  driverInfo: {
    teamName: '',
    carNumber: '',
    racingSeries: '',
    primaryDriver: { name: '', country: '' },
    coDriver: null
  },
  vehicle: {
    make: '',
    model: '',
    year: null,
    color: '',
    templateId: null,
    template: null
  },
  referencePhotos: [],
  decals: [],
  canvas: null,
  currentView: 'side',
  history: [],
  historyIndex: -1
};

// Country data with flag emojis
const COUNTRIES = [
  { code: 'US', name: 'United States', flag: '🇺🇸' },
  { code: 'CA', name: 'Canada', flag: '🇨🇦' },
  { code: 'MX', name: 'Mexico', flag: '🇲🇽' },
  { code: 'GB', name: 'United Kingdom', flag: '🇬🇧' },
  { code: 'DE', name: 'Germany', flag: '🇩🇪' },
  { code: 'FR', name: 'France', flag: '🇫🇷' },
  { code: 'IT', name: 'Italy', flag: '🇮🇹' },
  { code: 'ES', name: 'Spain', flag: '🇪🇸' },
  { code: 'JP', name: 'Japan', flag: '🇯🇵' },
  { code: 'AU', name: 'Australia', flag: '🇦🇺' },
  { code: 'NZ', name: 'New Zealand', flag: '🇳🇿' },
  { code: 'BR', name: 'Brazil', flag: '🇧🇷' },
  { code: 'AR', name: 'Argentina', flag: '🇦🇷' },
  { code: 'SE', name: 'Sweden', flag: '🇸🇪' },
  { code: 'FI', name: 'Finland', flag: '🇫🇮' },
  { code: 'NO', name: 'Norway', flag: '🇳🇴' },
  { code: 'PL', name: 'Poland', flag: '🇵🇱' },
  { code: 'BE', name: 'Belgium', flag: '🇧🇪' },
  { code: 'NL', name: 'Netherlands', flag: '🇳🇱' },
  { code: 'AT', name: 'Austria', flag: '🇦🇹' },
  { code: 'CH', name: 'Switzerland', flag: '🇨🇭' },
  { code: 'IE', name: 'Ireland', flag: '🇮🇪' },
  { code: 'PT', name: 'Portugal', flag: '🇵🇹' },
  { code: 'CZ', name: 'Czech Republic', flag: '🇨🇿' },
  { code: 'RU', name: 'Russia', flag: '🇷🇺' },
  { code: 'KR', name: 'South Korea', flag: '🇰🇷' },
  { code: 'CN', name: 'China', flag: '🇨🇳' },
  { code: 'IN', name: 'India', flag: '🇮🇳' },
  { code: 'ZA', name: 'South Africa', flag: '🇿🇦' }
].sort((a, b) => a.name.localeCompare(b.name));

// ============================================================================
// Initialization
// ============================================================================

document.addEventListener('DOMContentLoaded', () => {
  checkAuth();
  initCountryDropdowns();
  initFormHandlers();
  initVehicleSelectors();
  initPhotoUpload();
  initCanvasEditor();
  initAuthModal();

  // Check for saved design in URL
  const params = new URLSearchParams(window.location.search);
  if (params.get('design')) {
    loadSavedDesign(params.get('design'));
  }
});

// ============================================================================
// Authentication
// ============================================================================

function checkAuth() {
  const token = localStorage.getItem('stickerPortalToken');
  const customer = localStorage.getItem('stickerPortalCustomer');

  if (token && customer) {
    try {
      state.token = token;
      state.customer = JSON.parse(customer);
      state.isAuthenticated = true;
    } catch (e) {
      clearAuth();
    }
  }
}

function clearAuth() {
  localStorage.removeItem('stickerPortalToken');
  localStorage.removeItem('stickerPortalCustomer');
  state.token = null;
  state.customer = null;
  state.isAuthenticated = false;
}

function requireAuth(callback) {
  if (state.isAuthenticated) {
    callback();
  } else {
    showAuthModal(callback);
  }
}

// ============================================================================
// Country Dropdowns
// ============================================================================

function initCountryDropdowns() {
  const driverCountry = document.getElementById('driver-country');
  const codriverCountry = document.getElementById('codriver-country');

  const options = COUNTRIES.map(c =>
    `<option value="${c.code}">${c.flag} ${c.name}</option>`
  ).join('');

  if (driverCountry) {
    driverCountry.innerHTML = '<option value="">Select country...</option>' + options;
  }
  if (codriverCountry) {
    codriverCountry.innerHTML = '<option value="">Select country...</option>' + options;
  }
}

// ============================================================================
// Form Handlers
// ============================================================================

function initFormHandlers() {
  // Driver info form
  const driverForm = document.getElementById('driver-info-form');
  if (driverForm) {
    driverForm.addEventListener('submit', handleDriverInfoSubmit);
  }

  // Co-driver toggle
  const hasCodriver = document.getElementById('has-codriver');
  if (hasCodriver) {
    hasCodriver.addEventListener('change', (e) => {
      const codriverSection = document.getElementById('codriver-section');
      const codriverNameItem = document.getElementById('codriver-name-item');
      if (e.target.checked) {
        codriverSection.classList.remove('hidden');
        if (codriverNameItem) codriverNameItem.classList.remove('hidden');
      } else {
        codriverSection.classList.add('hidden');
        if (codriverNameItem) codriverNameItem.classList.add('hidden');
      }
    });
  }

  // Vehicle form
  const vehicleForm = document.getElementById('vehicle-form');
  if (vehicleForm) {
    vehicleForm.addEventListener('submit', handleVehicleSubmit);
  }

  // Update car number preview
  const carNumberInput = document.getElementById('car-number');
  if (carNumberInput) {
    carNumberInput.addEventListener('input', (e) => {
      const preview = document.getElementById('door-number-preview');
      if (preview) {
        preview.textContent = e.target.value || '77';
      }
    });
  }
}

function handleDriverInfoSubmit(e) {
  e.preventDefault();

  const formData = new FormData(e.target);

  state.driverInfo = {
    teamName: formData.get('teamName') || '',
    carNumber: formData.get('carNumber'),
    racingSeries: formData.get('racingSeries'),
    primaryDriver: {
      name: formData.get('driverName'),
      country: formData.get('driverCountry')
    },
    coDriver: document.getElementById('has-codriver').checked ? {
      name: formData.get('codriverName'),
      country: formData.get('codriverCountry')
    } : null
  };

  goToStep(2);
}

function handleVehicleSubmit(e) {
  e.preventDefault();

  const formData = new FormData(e.target);

  state.vehicle.make = formData.get('carMake');
  state.vehicle.model = formData.get('carModel');
  state.vehicle.year = parseInt(formData.get('carYear'), 10);
  state.vehicle.color = formData.get('carColor') || '';

  // Initialize canvas with template
  initializeCanvasWithTemplate();

  goToStep(3);
}

// ============================================================================
// Vehicle Selection
// ============================================================================

async function initVehicleSelectors() {
  const makeSelect = document.getElementById('car-make');
  const modelSelect = document.getElementById('car-model');
  const yearSelect = document.getElementById('car-year');

  if (!makeSelect) return;

  // Load makes
  try {
    const response = await fetch('/api/car-templates/makes');
    const data = await response.json();

    if (data.success && data.makes.length > 0) {
      makeSelect.innerHTML = '<option value="">Select make...</option>' +
        data.makes.map(make => `<option value="${make}">${make}</option>`).join('');
    } else {
      // Fallback if no templates exist yet
      makeSelect.innerHTML = '<option value="">Select make...</option>' +
        ['Subaru', 'Mazda', 'Toyota', 'Honda', 'Ford', 'BMW', 'Volkswagen', 'Porsche', 'Chevrolet', 'Nissan', 'Hyundai']
          .map(make => `<option value="${make}">${make}</option>`).join('');
    }
  } catch (error) {
    console.error('Failed to load car makes:', error);
    // Fallback
    makeSelect.innerHTML = '<option value="">Select make...</option>' +
      ['Subaru', 'Mazda', 'Toyota', 'Honda', 'Ford', 'BMW', 'Volkswagen']
        .map(make => `<option value="${make}">${make}</option>`).join('');
  }

  // Make change handler
  makeSelect.addEventListener('change', async (e) => {
    const make = e.target.value;
    modelSelect.disabled = !make;
    modelSelect.innerHTML = '<option value="">Select model...</option>';
    yearSelect.disabled = true;
    yearSelect.innerHTML = '<option value="">Select year...</option>';
    hideTemplatePreview();

    if (!make) return;

    try {
      const response = await fetch(`/api/car-templates/models/${encodeURIComponent(make)}`);
      const data = await response.json();

      if (data.success && data.models.length > 0) {
        modelSelect.innerHTML = '<option value="">Select model...</option>' +
          data.models.map(m => `<option value="${m.model}" data-min="${m.minYear}" data-max="${m.maxYear}">${m.model}</option>`).join('');
      } else {
        // Manual entry fallback
        modelSelect.innerHTML = '<option value="">Enter model manually...</option>';
      }
    } catch (error) {
      console.error('Failed to load models:', error);
    }
  });

  // Model change handler
  modelSelect.addEventListener('change', (e) => {
    const option = e.target.selectedOptions[0];
    yearSelect.disabled = !e.target.value;
    yearSelect.innerHTML = '<option value="">Select year...</option>';
    hideTemplatePreview();

    if (!e.target.value) return;

    const minYear = parseInt(option.dataset.min, 10) || 2010;
    const maxYear = parseInt(option.dataset.max, 10) || new Date().getFullYear();

    const years = [];
    for (let y = maxYear; y >= minYear; y--) {
      years.push(y);
    }

    yearSelect.innerHTML = '<option value="">Select year...</option>' +
      years.map(y => `<option value="${y}">${y}</option>`).join('');
  });

  // Year change handler
  yearSelect.addEventListener('change', async (e) => {
    if (!e.target.value) {
      hideTemplatePreview();
      return;
    }

    const make = makeSelect.value;
    const model = modelSelect.value;
    const year = e.target.value;

    await loadTemplatePreview(make, model, year);
  });
}

async function loadTemplatePreview(make, model, year) {
  const preview = document.getElementById('template-preview');
  const placeholder = preview.querySelector('.preview-placeholder');
  const loading = preview.querySelector('.preview-loading');
  const content = preview.querySelector('.preview-content');
  const notFound = preview.querySelector('.preview-not-found');

  placeholder.classList.add('hidden');
  loading.classList.remove('hidden');
  content.classList.add('hidden');
  notFound.classList.add('hidden');

  try {
    const response = await fetch(`/api/car-templates/find?make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}&year=${year}`);
    const data = await response.json();

    loading.classList.add('hidden');

    if (data.success && data.template) {
      state.vehicle.templateId = data.template.id;
      state.vehicle.template = data.template;

      // Show template preview
      const thumbnail = document.getElementById('template-thumbnail');
      const title = document.getElementById('template-title');
      const dimensions = document.getElementById('template-dimensions');

      if (data.template.templates.side) {
        thumbnail.innerHTML = data.template.templates.side;
      }

      title.textContent = `${data.template.make} ${data.template.model} (${data.template.yearStart}-${data.template.yearEnd})`;
      dimensions.textContent = `${data.template.dimensions.overallLength}" L × ${data.template.dimensions.overallWidth}" W × ${data.template.dimensions.overallHeight}" H`;

      content.classList.remove('hidden');
    } else {
      state.vehicle.templateId = null;
      state.vehicle.template = null;
      notFound.classList.remove('hidden');
    }
  } catch (error) {
    console.error('Failed to load template:', error);
    loading.classList.add('hidden');
    notFound.classList.remove('hidden');
  }
}

function hideTemplatePreview() {
  const preview = document.getElementById('template-preview');
  const placeholder = preview.querySelector('.preview-placeholder');
  const loading = preview.querySelector('.preview-loading');
  const content = preview.querySelector('.preview-content');
  const notFound = preview.querySelector('.preview-not-found');

  placeholder.classList.remove('hidden');
  loading.classList.add('hidden');
  content.classList.add('hidden');
  notFound.classList.add('hidden');
}

// ============================================================================
// Photo Upload
// ============================================================================

function initPhotoUpload() {
  const dropzone = document.getElementById('photo-dropzone');
  const fileInput = document.getElementById('photo-upload');
  const thumbnails = document.getElementById('photo-thumbnails');

  if (!dropzone || !fileInput) return;

  // Drag and drop
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dragover');
  });

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    handlePhotoFiles(e.dataTransfer.files);
  });

  // File input
  fileInput.addEventListener('change', (e) => {
    handlePhotoFiles(e.target.files);
  });
}

function handlePhotoFiles(files) {
  const thumbnails = document.getElementById('photo-thumbnails');
  const maxPhotos = 5;
  const maxSize = 10 * 1024 * 1024; // 10MB

  for (const file of files) {
    if (state.referencePhotos.length >= maxPhotos) {
      alert(`Maximum ${maxPhotos} photos allowed.`);
      break;
    }

    if (!file.type.startsWith('image/')) {
      alert(`${file.name} is not an image file.`);
      continue;
    }

    if (file.size > maxSize) {
      alert(`${file.name} exceeds 10MB limit.`);
      continue;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const photoData = {
        id: Date.now() + Math.random(),
        name: file.name,
        dataUrl: e.target.result
      };

      state.referencePhotos.push(photoData);
      renderPhotoThumbnail(photoData, thumbnails);
      updateReferencePhotosPanel();
    };
    reader.readAsDataURL(file);
  }
}

function renderPhotoThumbnail(photo, container) {
  const thumb = document.createElement('div');
  thumb.className = 'photo-thumb';
  thumb.innerHTML = `
    <img src="${photo.dataUrl}" alt="${photo.name}">
    <button type="button" class="remove-photo" data-id="${photo.id}">&times;</button>
  `;

  thumb.querySelector('.remove-photo').addEventListener('click', () => {
    state.referencePhotos = state.referencePhotos.filter(p => p.id !== photo.id);
    thumb.remove();
    updateReferencePhotosPanel();
  });

  container.appendChild(thumb);
}

function updateReferencePhotosPanel() {
  const panel = document.getElementById('reference-photos');
  if (!panel) return;

  if (state.referencePhotos.length === 0) {
    panel.innerHTML = '<p class="no-photos">No photos uploaded</p>';
  } else {
    panel.innerHTML = state.referencePhotos.map(p => `
      <div class="ref-photo-thumb" data-id="${p.id}">
        <img src="${p.dataUrl}" alt="${p.name}">
      </div>
    `).join('');
  }
}

// ============================================================================
// Canvas Editor (Fabric.js)
// ============================================================================

function initCanvasEditor() {
  // Initialize tool buttons
  document.getElementById('upload-decal-btn')?.addEventListener('click', () => {
    document.getElementById('decal-upload').click();
  });

  document.getElementById('decal-upload')?.addEventListener('change', handleDecalUpload);

  // Transform tools
  document.getElementById('flip-h-btn')?.addEventListener('click', flipSelectedHorizontal);
  document.getElementById('flip-v-btn')?.addEventListener('click', flipSelectedVertical);
  document.getElementById('duplicate-btn')?.addEventListener('click', duplicateSelected);
  document.getElementById('delete-btn')?.addEventListener('click', deleteSelected);

  // Layer tools
  document.getElementById('bring-front-btn')?.addEventListener('click', bringToFront);
  document.getElementById('send-back-btn')?.addEventListener('click', sendToBack);

  // History
  document.getElementById('undo-btn')?.addEventListener('click', undo);
  document.getElementById('redo-btn')?.addEventListener('click', redo);

  // Zoom
  document.getElementById('zoom-in-btn')?.addEventListener('click', () => zoom(1.2));
  document.getElementById('zoom-out-btn')?.addEventListener('click', () => zoom(0.8));
  document.getElementById('zoom-fit-btn')?.addEventListener('click', zoomToFit);

  // View tabs
  document.querySelectorAll('.view-tab').forEach(tab => {
    tab.addEventListener('click', (e) => {
      document.querySelectorAll('.view-tab').forEach(t => t.classList.remove('active'));
      e.target.classList.add('active');
      state.currentView = e.target.dataset.view;
      loadViewTemplate(state.currentView);
    });
  });

  // Color pickers
  document.getElementById('fill-color')?.addEventListener('change', (e) => {
    applyFillColor(e.target.value);
  });

  document.getElementById('stroke-color')?.addEventListener('change', (e) => {
    applyStrokeColor(e.target.value);
  });

  // Generated items drag
  document.querySelectorAll('.generated-item').forEach(item => {
    item.addEventListener('click', () => addGeneratedItem(item.dataset.type));
  });

  // Continue to quote
  document.getElementById('continue-to-quote-btn')?.addEventListener('click', () => {
    goToStep(4);
    updateReviewStep();
  });

  // Save design
  document.getElementById('save-design-btn')?.addEventListener('click', saveDesign);

  // Submit quote
  document.getElementById('submit-quote-btn')?.addEventListener('click', submitQuote);
}

function initializeCanvasWithTemplate() {
  const container = document.getElementById('canvas-container');
  if (!container) return;

  // Set canvas size based on template or default
  const canvasWidth = 1200;
  const canvasHeight = 600;

  // Initialize Fabric.js canvas
  state.canvas = new fabric.Canvas('design-canvas', {
    width: canvasWidth,
    height: canvasHeight,
    backgroundColor: '#ffffff',
    selection: true,
    preserveObjectStacking: true
  });

  // Load the template SVG as background
  if (state.vehicle.template && state.vehicle.template.templates.side) {
    loadViewTemplate('side');
  }

  // Set up selection event handlers
  state.canvas.on('selection:created', updateSelectionInfo);
  state.canvas.on('selection:updated', updateSelectionInfo);
  state.canvas.on('selection:cleared', clearSelectionInfo);
  state.canvas.on('object:modified', handleObjectModified);
  state.canvas.on('object:added', updateLayersList);
  state.canvas.on('object:removed', updateLayersList);

  // Add the generated elements (door numbers, name bars)
  addAutoGeneratedElements();
}

function loadViewTemplate(view) {
  if (!state.canvas || !state.vehicle.template) return;

  const templateSvg = state.vehicle.template.templates[view];
  if (!templateSvg) return;

  // Remove existing background
  const existingBg = state.canvas.getObjects().find(o => o.isBackground);
  if (existingBg) {
    state.canvas.remove(existingBg);
  }

  // Load SVG as background
  fabric.loadSVGFromString(templateSvg, (objects, options) => {
    const group = fabric.util.groupSVGElements(objects, options);
    group.set({
      left: 0,
      top: 0,
      selectable: false,
      evented: false,
      isBackground: true
    });

    // Scale to fit canvas
    const scale = Math.min(
      state.canvas.width / group.width,
      state.canvas.height / group.height
    ) * 0.9;

    group.scale(scale);
    group.center();

    state.canvas.add(group);
    state.canvas.sendToBack(group);
    state.canvas.renderAll();
  });
}

function handleDecalUpload(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (event) => {
    if (file.type === 'image/svg+xml') {
      fabric.loadSVGFromString(event.target.result, (objects, options) => {
        const decal = fabric.util.groupSVGElements(objects, options);
        addDecalToCanvas(decal, file.name);
      });
    } else {
      fabric.Image.fromURL(event.target.result, (img) => {
        addDecalToCanvas(img, file.name);
      });
    }
  };

  if (file.type === 'image/svg+xml') {
    reader.readAsText(file);
  } else {
    reader.readAsDataURL(file);
  }

  e.target.value = '';
}

function addDecalToCanvas(decal, name) {
  if (!state.canvas) return;

  // Scale to reasonable size
  const maxSize = 150;
  const scale = maxSize / Math.max(decal.width, decal.height);

  decal.set({
    left: state.canvas.width / 2,
    top: state.canvas.height / 2,
    originX: 'center',
    originY: 'center',
    scaleX: scale,
    scaleY: scale,
    decalName: name,
    decalType: 'custom'
  });

  state.canvas.add(decal);
  state.canvas.setActiveObject(decal);
  state.canvas.renderAll();

  saveToHistory();
  updateLayersList();
}

function addGeneratedItem(type) {
  if (!state.canvas) return;

  let element;

  switch (type) {
    case 'door-number':
      element = new fabric.Text(state.driverInfo.carNumber || '77', {
        fontSize: 120,
        fontFamily: 'Arial Black, sans-serif',
        fontWeight: 'bold',
        fill: '#ffffff',
        stroke: '#000000',
        strokeWidth: 4,
        textAlign: 'center',
        decalName: 'Door Number',
        decalType: 'number'
      });
      break;

    case 'name-bar-driver':
      const driverCountry = COUNTRIES.find(c => c.code === state.driverInfo.primaryDriver.country);
      const driverText = driverCountry
        ? `${driverCountry.flag} ${state.driverInfo.primaryDriver.name}`
        : state.driverInfo.primaryDriver.name;

      element = createNameBar(driverText, 'Driver Name');
      break;

    case 'name-bar-codriver':
      if (!state.driverInfo.coDriver) return;
      const codriverCountry = COUNTRIES.find(c => c.code === state.driverInfo.coDriver.country);
      const codriverText = codriverCountry
        ? `${codriverCountry.flag} ${state.driverInfo.coDriver.name}`
        : state.driverInfo.coDriver.name;

      element = createNameBar(codriverText, 'Co-Driver Name');
      break;
  }

  if (element) {
    element.set({
      left: state.canvas.width / 2,
      top: state.canvas.height / 2,
      originX: 'center',
      originY: 'center'
    });

    state.canvas.add(element);
    state.canvas.setActiveObject(element);
    state.canvas.renderAll();

    saveToHistory();
    updateLayersList();
  }
}

function createNameBar(text, name) {
  const textObj = new fabric.Text(text, {
    fontSize: 24,
    fontFamily: 'Arial, sans-serif',
    fontWeight: 'bold',
    fill: '#000000'
  });

  const padding = 10;
  const rect = new fabric.Rect({
    width: textObj.width + padding * 2,
    height: textObj.height + padding * 2,
    fill: '#ffffff',
    stroke: '#000000',
    strokeWidth: 2,
    rx: 4,
    ry: 4
  });

  const group = new fabric.Group([rect, textObj], {
    decalName: name,
    decalType: 'nameBar'
  });

  return group;
}

function addAutoGeneratedElements() {
  // These will be added but positioned off to the side initially
  // Users can drag them into position
}

// Transform functions
function flipSelectedHorizontal() {
  const active = state.canvas?.getActiveObject();
  if (active) {
    active.set('flipX', !active.flipX);
    state.canvas.renderAll();
    saveToHistory();
  }
}

function flipSelectedVertical() {
  const active = state.canvas?.getActiveObject();
  if (active) {
    active.set('flipY', !active.flipY);
    state.canvas.renderAll();
    saveToHistory();
  }
}

function duplicateSelected() {
  const active = state.canvas?.getActiveObject();
  if (active) {
    active.clone((cloned) => {
      cloned.set({
        left: active.left + 20,
        top: active.top + 20
      });
      state.canvas.add(cloned);
      state.canvas.setActiveObject(cloned);
      state.canvas.renderAll();
      saveToHistory();
    });
  }
}

function deleteSelected() {
  const active = state.canvas?.getActiveObject();
  if (active && !active.isBackground) {
    state.canvas.remove(active);
    state.canvas.renderAll();
    saveToHistory();
  }
}

function bringToFront() {
  const active = state.canvas?.getActiveObject();
  if (active) {
    state.canvas.bringToFront(active);
    state.canvas.renderAll();
    saveToHistory();
  }
}

function sendToBack() {
  const active = state.canvas?.getActiveObject();
  if (active && !active.isBackground) {
    state.canvas.sendToBack(active);
    // Make sure background stays at back
    const bg = state.canvas.getObjects().find(o => o.isBackground);
    if (bg) state.canvas.sendToBack(bg);
    state.canvas.renderAll();
    saveToHistory();
  }
}

function applyFillColor(color) {
  const active = state.canvas?.getActiveObject();
  if (active) {
    active.set('fill', color);
    state.canvas.renderAll();
    saveToHistory();
  }
}

function applyStrokeColor(color) {
  const active = state.canvas?.getActiveObject();
  if (active) {
    active.set('stroke', color);
    state.canvas.renderAll();
    saveToHistory();
  }
}

// Zoom functions
function zoom(factor) {
  if (!state.canvas) return;
  const newZoom = state.canvas.getZoom() * factor;
  state.canvas.setZoom(Math.min(Math.max(newZoom, 0.1), 5));
  updateZoomDisplay();
}

function zoomToFit() {
  if (!state.canvas) return;
  state.canvas.setZoom(1);
  state.canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
  updateZoomDisplay();
}

function updateZoomDisplay() {
  const zoomLevel = document.getElementById('zoom-level');
  if (zoomLevel) {
    zoomLevel.textContent = Math.round(state.canvas.getZoom() * 100) + '%';
  }
}

// Selection info
function updateSelectionInfo(e) {
  const obj = e.selected?.[0] || state.canvas?.getActiveObject();
  if (!obj || obj.isBackground) {
    clearSelectionInfo();
    return;
  }

  const noSelection = document.querySelector('.no-selection');
  const details = document.getElementById('selection-details');

  if (noSelection) noSelection.classList.add('hidden');
  if (details) details.classList.remove('hidden');

  const scale = state.vehicle.template?.scale || 0.1;
  const widthInches = (obj.width * obj.scaleX * scale).toFixed(1);
  const heightInches = (obj.height * obj.scaleY * scale).toFixed(1);

  document.getElementById('obj-width').textContent = `${widthInches}"`;
  document.getElementById('obj-height').textContent = `${heightInches}"`;
  document.getElementById('obj-position').textContent = `(${Math.round(obj.left)}, ${Math.round(obj.top)})`;
  document.getElementById('obj-rotation').textContent = `${Math.round(obj.angle || 0)}°`;

  // Update dimension readout
  document.getElementById('selected-dims').textContent = `${widthInches}" × ${heightInches}"`;
}

function clearSelectionInfo() {
  const noSelection = document.querySelector('.no-selection');
  const details = document.getElementById('selection-details');

  if (noSelection) noSelection.classList.remove('hidden');
  if (details) details.classList.add('hidden');

  document.getElementById('selected-dims').textContent = 'No selection';
}

function handleObjectModified() {
  saveToHistory();
  updateSelectionInfo({ selected: [state.canvas.getActiveObject()] });
}

// Layers list
function updateLayersList() {
  const list = document.getElementById('layers-list');
  if (!list || !state.canvas) return;

  const objects = state.canvas.getObjects().filter(o => !o.isBackground);

  if (objects.length === 0) {
    list.innerHTML = '<p class="no-layers">No decals placed yet</p>';
    return;
  }

  list.innerHTML = objects.map((obj, i) => `
    <div class="layer-item" data-index="${i}">
      <div class="layer-icon">${getLayerIcon(obj.decalType)}</div>
      <span class="layer-name">${obj.decalName || 'Decal ' + (i + 1)}</span>
    </div>
  `).join('');

  list.querySelectorAll('.layer-item').forEach(item => {
    item.addEventListener('click', () => {
      const index = parseInt(item.dataset.index, 10);
      const objects = state.canvas.getObjects().filter(o => !o.isBackground);
      if (objects[index]) {
        state.canvas.setActiveObject(objects[index]);
        state.canvas.renderAll();
      }
    });
  });
}

function getLayerIcon(type) {
  switch (type) {
    case 'number': return '#';
    case 'nameBar': return 'N';
    case 'custom': return 'D';
    default: return '?';
  }
}

// History (undo/redo)
function saveToHistory() {
  const json = state.canvas.toJSON(['decalName', 'decalType', 'isBackground']);
  state.history = state.history.slice(0, state.historyIndex + 1);
  state.history.push(json);
  state.historyIndex++;

  updateHistoryButtons();
}

function undo() {
  if (state.historyIndex <= 0) return;
  state.historyIndex--;
  loadFromHistory();
}

function redo() {
  if (state.historyIndex >= state.history.length - 1) return;
  state.historyIndex++;
  loadFromHistory();
}

function loadFromHistory() {
  state.canvas.loadFromJSON(state.history[state.historyIndex], () => {
    state.canvas.renderAll();
    updateLayersList();
    updateHistoryButtons();
  });
}

function updateHistoryButtons() {
  const undoBtn = document.getElementById('undo-btn');
  const redoBtn = document.getElementById('redo-btn');

  if (undoBtn) undoBtn.disabled = state.historyIndex <= 0;
  if (redoBtn) redoBtn.disabled = state.historyIndex >= state.history.length - 1;
}

// ============================================================================
// Step Navigation
// ============================================================================

function goToStep(step) {
  if (step < 1 || step > 5) return;

  // Hide all steps
  document.querySelectorAll('.wizard-step').forEach(s => s.classList.remove('active'));

  // Show target step
  const targetStep = document.getElementById(step === 5 ? 'step-success' : `step-${step}`);
  if (targetStep) {
    targetStep.classList.add('active');
  }

  // Update progress indicators
  document.querySelectorAll('.progress-steps .step').forEach(s => {
    const stepNum = parseInt(s.dataset.step, 10);
    s.classList.remove('active', 'completed');
    if (stepNum < step) {
      s.classList.add('completed');
    } else if (stepNum === step) {
      s.classList.add('active');
    }
  });

  state.currentStep = step;

  // Scroll to top
  window.scrollTo(0, 0);
}

// ============================================================================
// Review & Quote
// ============================================================================

function updateReviewStep() {
  // Update summary info
  document.getElementById('summary-car-number').textContent = state.driverInfo.carNumber;
  document.getElementById('summary-driver').textContent = state.driverInfo.primaryDriver.name;
  document.getElementById('summary-series').textContent = state.driverInfo.racingSeries;
  document.getElementById('summary-vehicle').textContent =
    `${state.vehicle.year} ${state.vehicle.make} ${state.vehicle.model}`;

  if (state.driverInfo.coDriver) {
    document.getElementById('summary-codriver-row').style.display = 'flex';
    document.getElementById('summary-codriver').textContent = state.driverInfo.coDriver.name;
  }

  // Update design preview
  if (state.canvas) {
    const dataUrl = state.canvas.toDataURL({ format: 'png', multiplier: 0.5 });
    document.getElementById('design-preview-large').innerHTML = `<img src="${dataUrl}" alt="Design Preview">`;
  }

  // Update specs table
  updateSpecsTable();
}

function updateSpecsTable() {
  const tbody = document.getElementById('decal-specs-body');
  if (!tbody || !state.canvas) return;

  const objects = state.canvas.getObjects().filter(o => !o.isBackground);
  const scale = state.vehicle.template?.scale || 0.1;

  if (objects.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-row">No decals in design</td></tr>';
    return;
  }

  tbody.innerHTML = objects.map(obj => {
    const width = (obj.width * obj.scaleX * scale).toFixed(1);
    const height = (obj.height * obj.scaleY * scale).toFixed(1);
    const material = getMaterialRecommendation(obj);

    return `
      <tr>
        <td>${obj.decalName || 'Custom Decal'}</td>
        <td>${width}" × ${height}"</td>
        <td>${material}</td>
        <td>1</td>
      </tr>
    `;
  }).join('');
}

function getMaterialRecommendation(obj) {
  // Simple recommendation based on size and type
  const area = obj.width * obj.scaleX * obj.height * obj.scaleY * 0.01; // sq inches
  if (area > 500) return 'Cast Vinyl (curved)';
  if (obj.decalType === 'number') return 'Reflective Vinyl';
  return 'Calendered Vinyl';
}

// ============================================================================
// Save & Submit
// ============================================================================

async function saveDesign() {
  requireAuth(async () => {
    try {
      const designData = {
        carTemplateId: state.vehicle.templateId,
        driverInfo: state.driverInfo,
        referencePhotos: state.referencePhotos.map(p => p.dataUrl),
        decals: state.canvas ? state.canvas.toJSON(['decalName', 'decalType', 'isBackground']) : null,
        designPreview: state.canvas ? state.canvas.toDataURL({ format: 'png', multiplier: 0.3 }) : null
      };

      const response = await fetch(
        state.designId ? `/api/customer/race-designs/${state.designId}` : '/api/customer/race-designs',
        {
          method: state.designId ? 'PUT' : 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${state.token}`
          },
          body: JSON.stringify(designData)
        }
      );

      const data = await response.json();

      if (data.success) {
        state.designId = data.design.id;
        alert('Design saved successfully!');
      } else {
        throw new Error(data.error || 'Failed to save design');
      }
    } catch (error) {
      console.error('Save error:', error);
      alert('Failed to save design: ' + error.message);
    }
  });
}

async function submitQuote() {
  requireAuth(async () => {
    const submitBtn = document.getElementById('submit-quote-btn');
    const btnText = submitBtn.querySelector('.btn-text');
    const btnLoading = submitBtn.querySelector('.btn-loading');

    btnText.classList.add('hidden');
    btnLoading.classList.remove('hidden');
    submitBtn.disabled = true;

    try {
      // First save the design
      const designData = {
        carTemplateId: state.vehicle.templateId,
        driverInfo: state.driverInfo,
        referencePhotos: state.referencePhotos.map(p => p.dataUrl),
        decals: state.canvas ? state.canvas.toJSON(['decalName', 'decalType', 'isBackground']) : null,
        designPreview: state.canvas ? state.canvas.toDataURL({ format: 'png', multiplier: 0.5 }) : null,
        status: 'submitted'
      };

      const saveResponse = await fetch(
        state.designId ? `/api/customer/race-designs/${state.designId}` : '/api/customer/race-designs',
        {
          method: state.designId ? 'PUT' : 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${state.token}`
          },
          body: JSON.stringify(designData)
        }
      );

      const saveData = await saveResponse.json();
      if (!saveData.success) {
        throw new Error(saveData.error || 'Failed to save design');
      }

      state.designId = saveData.design.id;

      // Now create quote from design
      const notes = document.getElementById('quote-notes')?.value || '';
      const quotePayload = {
        business: state.driverInfo.teamName,
        vehicle: `${state.vehicle.year} ${state.vehicle.make} ${state.vehicle.model}`,
        colors: state.vehicle.color,
        notes: notes
      };

      const quoteResponse = await fetch(`/api/customer/race-designs/${state.designId}/quote`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${state.token}`
        },
        body: JSON.stringify(quotePayload)
      });

      const quoteData = await quoteResponse.json();

      if (quoteData.success) {
        goToStep(5); // Success step
      } else {
        throw new Error(quoteData.error || 'Failed to submit quote');
      }
    } catch (error) {
      console.error('Submit error:', error);
      alert('Failed to submit quote: ' + error.message);
    } finally {
      btnText.classList.remove('hidden');
      btnLoading.classList.add('hidden');
      submitBtn.disabled = false;
    }
  });
}

async function loadSavedDesign(designId) {
  try {
    const response = await fetch(`/api/customer/race-designs/${designId}`, {
      headers: {
        'Authorization': `Bearer ${state.token}`
      }
    });

    const data = await response.json();

    if (data.success && data.design) {
      state.designId = data.design.id;
      state.driverInfo = data.design.driverInfo || state.driverInfo;
      state.vehicle.templateId = data.design.carTemplateId;
      state.referencePhotos = (data.design.referencePhotos || []).map((url, i) => ({
        id: i,
        name: `Photo ${i + 1}`,
        dataUrl: url
      }));

      // Pre-fill forms...
      // Navigate to appropriate step based on design state
    }
  } catch (error) {
    console.error('Failed to load design:', error);
  }
}

// ============================================================================
// Auth Modal
// ============================================================================

function initAuthModal() {
  // Tab switching
  document.querySelectorAll('.auth-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const isLogin = tab.dataset.tab === 'login';
      document.getElementById('login-form').classList.toggle('hidden', !isLogin);
      document.getElementById('register-form').classList.toggle('hidden', isLogin);
    });
  });

  // Login form
  document.getElementById('login-form')?.addEventListener('submit', handleLogin);

  // Register form
  document.getElementById('register-form')?.addEventListener('submit', handleRegister);
}

let authCallback = null;

function showAuthModal(callback) {
  authCallback = callback;
  document.getElementById('auth-modal').classList.remove('hidden');
}

function closeAuthModal() {
  document.getElementById('auth-modal').classList.add('hidden');
  authCallback = null;
}

async function handleLogin(e) {
  e.preventDefault();

  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;

  try {
    const response = await fetch('/api/customer/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    const data = await response.json();

    if (data.token) {
      localStorage.setItem('stickerPortalToken', data.token);
      localStorage.setItem('stickerPortalCustomer', JSON.stringify(data.customer));
      state.token = data.token;
      state.customer = data.customer;
      state.isAuthenticated = true;

      closeAuthModal();

      if (authCallback) {
        authCallback();
        authCallback = null;
      }
    } else {
      alert(data.error || 'Login failed');
    }
  } catch (error) {
    alert('Login failed: ' + error.message);
  }
}

async function handleRegister(e) {
  e.preventDefault();

  const name = document.getElementById('register-name').value;
  const email = document.getElementById('register-email').value;
  const password = document.getElementById('register-password').value;
  const phone = document.getElementById('register-phone').value;

  try {
    const response = await fetch('/api/customer/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password, phone })
    });

    const data = await response.json();

    if (data.token) {
      localStorage.setItem('stickerPortalToken', data.token);
      localStorage.setItem('stickerPortalCustomer', JSON.stringify(data.customer));
      state.token = data.token;
      state.customer = data.customer;
      state.isAuthenticated = true;

      closeAuthModal();

      if (authCallback) {
        authCallback();
        authCallback = null;
      }
    } else {
      alert(data.error || 'Registration failed');
    }
  } catch (error) {
    alert('Registration failed: ' + error.message);
  }
}
