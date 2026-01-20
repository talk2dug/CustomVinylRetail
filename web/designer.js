/* ========================================
   Modern Decal Designer - JavaScript
   AI-Powered Canvas Designer with Fabric.js
   ======================================== */

(function () {
  'use strict';

  // ========================================
  // Constants & Configuration
  // ========================================

  const DPI = 96; // Screen DPI for canvas
  const INCHES_TO_PIXELS = DPI;

  const CANVAS_SIZES = {
    3: { width: 3, height: 3 },
    4: { width: 4, height: 4 },
    6: { width: 6, height: 6 },
    8: { width: 8, height: 8 },
    12: { width: 12, height: 12 }
  };

  const VINYL_PALETTES = {
    'regular-vinyl': {
      label: 'Regular Vinyl',
      colors: [
        { name: 'Optic White', value: '#FFFFFF' },
        { name: 'Charcoal Black', value: '#201F1D' },
        { name: 'Steel Gray', value: '#6A6B76' },
        { name: 'Crimson Red', value: '#B72020' },
        { name: 'Pacific Blue', value: '#4D8BBD' },
        { name: 'Royal Sapphire', value: '#0D4B9D' },
        { name: 'Harvest Gold', value: '#DAAD28' },
        { name: 'Coral Rose', value: '#E66C74' },
        { name: 'Violet Frost', value: '#9878B1' },
        { name: 'Seafoam', value: '#A0D6D8' }
      ]
    },
    'heat-transfer': {
      label: 'Heat Transfer Vinyl',
      colors: [
        { name: 'Bright White', value: '#F6F6F6' },
        { name: 'Deep Midnight', value: '#0C1C35' },
        { name: 'Fire Red', value: '#C72B1B' },
        { name: 'Royal Blue', value: '#176BC6' },
        { name: 'Sunburst Yellow', value: '#EFD01C' },
        { name: 'Evergreen', value: '#2B8B60' },
        { name: 'Copper Orange', value: '#DE7E1E' },
        { name: 'Rose Pink', value: '#E1667E' },
        { name: 'Lavender Mist', value: '#DBCED9' },
        { name: 'Lime Green', value: '#61CA61' }
      ]
    }
  };

  const FONT_FAMILIES = [
    'Barlow', 'Bebas Neue', 'Montserrat', 'Oswald', 'Pacifico',
    'Playfair Display', 'Raleway', 'Roboto', 'Lobster', 'Anton',
    'Righteous', 'Permanent Marker', 'Bangers', 'Racing Sans One',
    'Rubik Mono One'
  ];

  // ========================================
  // State Management
  // ========================================

  const state = {
    canvas: null,
    currentSize: 4,
    selectedPalette: 'regular-vinyl',
    selectedColor: '#FFFFFF',
    catalog: [],
    filteredCatalog: [],
    categories: [],
    selectedCategory: '',
    searchQuery: '',
    undoStack: [],
    redoStack: [],
    selectedObject: null,
    userEmail: null,
    savedDesigns: []
  };

  // ========================================
  // DOM Element References
  // ========================================

  const elements = {
    canvas: document.getElementById('designCanvas'),
    canvasSizeSelect: document.getElementById('canvasSizeSelect'),
    canvasSizeIndicator: document.getElementById('canvasSizeIndicator'),
    catalogGrid: document.getElementById('catalogGrid'),
    catalogSearch: document.getElementById('catalogSearch'),
    categoryFilter: document.getElementById('categoryFilter'),
    vinylPaletteSelect: document.getElementById('vinylPaletteSelect'),
    vinylColorSwatches: document.getElementById('vinylColorSwatches'),
    layersList: document.getElementById('layersList'),
    propertiesContent: document.getElementById('propertiesContent'),
    aiSuggestions: document.getElementById('aiSuggestions'),
    getAiSuggestion: document.getElementById('getAiSuggestion'),
    addTextButton: document.getElementById('addTextButton'),
    uploadImageButton: document.getElementById('uploadImageButton'),
    imageUploadInput: document.getElementById('imageUploadInput'),
    textEditorModal: document.getElementById('textEditorModal'),
    textInput: document.getElementById('textInput'),
    fontFamilySelect: document.getElementById('fontFamilySelect'),
    fontSizeInput: document.getElementById('fontSizeInput'),
    fontWeightSelect: document.getElementById('fontWeightSelect'),
    addTextConfirm: document.getElementById('addTextConfirm'),
    saveButton: document.getElementById('saveButton'),
    addToOrderButton: document.getElementById('addToOrderButton'),
    zoomInButton: document.getElementById('zoomInButton'),
    zoomOutButton: document.getElementById('zoomOutButton'),
    zoomResetButton: document.getElementById('zoomResetButton'),
    undoButton: document.getElementById('undoButton'),
    redoButton: document.getElementById('redoButton'),
    clearCanvasButton: document.getElementById('clearCanvasButton'),
    layerCount: document.getElementById('layerCount'),
    canvasDimensions: document.getElementById('canvasDimensions'),
    vinylColorInfo: document.getElementById('vinylColorInfo'),
    loadingOverlay: document.getElementById('loadingOverlay')
  };

  // ========================================
  // Canvas Initialization
  // ========================================

  function initCanvas() {
    const size = CANVAS_SIZES[state.currentSize];
    const width = size.width * INCHES_TO_PIXELS;
    const height = size.height * INCHES_TO_PIXELS;

    state.canvas = new fabric.Canvas('designCanvas', {
      width: width,
      height: height,
      backgroundColor: '#ffffff',
      preserveObjectStacking: true
    });

    // Enable object controls
    fabric.Object.prototype.set({
      transparentCorners: false,
      borderColor: '#3b82f6',
      cornerColor: '#3b82f6',
      cornerSize: 12,
      cornerStyle: 'circle'
    });

    // Canvas event listeners
    state.canvas.on('selection:created', handleSelection);
    state.canvas.on('selection:updated', handleSelection);
    state.canvas.on('selection:cleared', handleSelectionCleared);
    state.canvas.on('object:modified', saveState);
    state.canvas.on('object:added', updateLayers);
    state.canvas.on('object:removed', updateLayers);

    updateCanvasInfo();
  }

  // ========================================
  // Canvas Size Management
  // ========================================

  function setCanvasSize(sizeKey) {
    const size = CANVAS_SIZES[sizeKey];
    if (!size) return;

    state.currentSize = sizeKey;
    const width = size.width * INCHES_TO_PIXELS;
    const height = size.height * INCHES_TO_PIXELS;

    state.canvas.setDimensions({ width, height });
    state.canvas.renderAll();

    updateCanvasInfo();
    elements.canvasSizeIndicator.textContent = `${size.width}" × ${size.height}"`;
  }

  function updateCanvasInfo() {
    const size = CANVAS_SIZES[state.currentSize];
    elements.canvasDimensions.textContent = `${size.width}" × ${size.height}"`;
    elements.layerCount.textContent = `${state.canvas.getObjects().length} objects`;
  }

  // ========================================
  // Catalog Management
  // ========================================

  async function loadCatalog() {
    try {
      showLoading(true);
      const response = await fetch('./catalog.json');
      const data = await response.json();

      if (data.categories && Array.isArray(data.categories)) {
        state.categories = data.categories;
        state.catalog = [];

        // Flatten all designs from all categories
        data.categories.forEach(category => {
          if (category.designs && Array.isArray(category.designs)) {
            category.designs.forEach(design => {
              state.catalog.push({
                ...design,
                category: category.name,
                categorySlug: category.slug
              });
            });
          }
        });

        state.filteredCatalog = [...state.catalog];
        renderCategories();
        renderCatalog();
      }
    } catch (error) {
      console.error('Failed to load catalog:', error);
      showAiMessage('Unable to load catalog. Please refresh the page.', 'error');
    } finally {
      showLoading(false);
    }
  }

  function renderCategories() {
    if (!elements.categoryFilter) return;

    elements.categoryFilter.innerHTML = '<option value="">All Categories</option>';

    state.categories.forEach(category => {
      const option = document.createElement('option');
      option.value = category.slug;
      option.textContent = category.name;
      elements.categoryFilter.appendChild(option);
    });
  }

  function renderCatalog() {
    if (!elements.catalogGrid) return;

    elements.catalogGrid.innerHTML = '';

    if (state.filteredCatalog.length === 0) {
      elements.catalogGrid.innerHTML = `
        <div class="empty-state">
          <i class="fas fa-search"></i>
          <p>No designs found</p>
        </div>
      `;
      return;
    }

    // Limit to first 100 for performance
    const itemsToShow = state.filteredCatalog.slice(0, 100);

    itemsToShow.forEach(design => {
      const item = document.createElement('div');
      item.className = 'catalog-item';
      item.draggable = true;
      item.dataset.imageUrl = design.image;
      item.dataset.designName = design.name;

      const img = document.createElement('img');
      img.src = design.image;
      img.alt = design.name;
      img.loading = 'lazy';
      item.appendChild(img);

      // Drag events
      item.addEventListener('dragstart', handleDragStart);
      item.addEventListener('click', () => addImageToCanvas(design.image, design.name));

      elements.catalogGrid.appendChild(item);
    });
  }

  function filterCatalog() {
    let filtered = [...state.catalog];

    // Filter by category
    if (state.selectedCategory) {
      filtered = filtered.filter(design =>
        design.categorySlug === state.selectedCategory
      );
    }

    // Filter by search query
    if (state.searchQuery) {
      const query = state.searchQuery.toLowerCase();
      filtered = filtered.filter(design =>
        design.name.toLowerCase().includes(query) ||
        (design.category && design.category.toLowerCase().includes(query))
      );
    }

    state.filteredCatalog = filtered;
    renderCatalog();
  }

  // ========================================
  // Drag & Drop
  // ========================================

  function handleDragStart(e) {
    e.dataTransfer.setData('imageUrl', e.target.dataset.imageUrl);
    e.dataTransfer.setData('designName', e.target.dataset.designName);
    e.dataTransfer.effectAllowed = 'copy';
  }

  function setupDropZone() {
    const container = document.getElementById('canvasContainer');

    container.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });

    container.addEventListener('drop', (e) => {
      e.preventDefault();
      const imageUrl = e.dataTransfer.getData('imageUrl');
      const designName = e.dataTransfer.getData('designName');

      if (imageUrl) {
        const rect = state.canvas.getElement().getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        addImageToCanvas(imageUrl, designName, { x, y });
      }
    });
  }

  // ========================================
  // Add Objects to Canvas
  // ========================================

  function addImageToCanvas(url, name, position = null) {
    fabric.Image.fromURL(url, (img) => {
      // Scale image to fit within canvas
      const maxWidth = state.canvas.width * 0.4;
      const maxHeight = state.canvas.height * 0.4;
      const scale = Math.min(maxWidth / img.width, maxHeight / img.height);

      img.set({
        scaleX: scale,
        scaleY: scale,
        left: position ? position.x : state.canvas.width / 2,
        top: position ? position.y : state.canvas.height / 2,
        originX: 'center',
        originY: 'center',
        name: name || 'Image'
      });

      state.canvas.add(img);
      state.canvas.setActiveObject(img);
      state.canvas.renderAll();
      saveState();
      updateLayers();

      // Show AI suggestion
      showAiMessage(
        `🎨 Nice choice! Try adjusting the size and position. You can also add text to complement this design.`,
        'suggestion'
      );
    }, { crossOrigin: 'anonymous' });
  }

  function addTextToCanvas(text, options = {}) {
    const textObj = new fabric.Text(text, {
      left: options.left || state.canvas.width / 2,
      top: options.top || state.canvas.height / 2,
      fontSize: options.fontSize || 48,
      fontFamily: options.fontFamily || 'Barlow',
      fontWeight: options.fontWeight || 400,
      fill: state.selectedColor,
      originX: 'center',
      originY: 'center',
      name: options.name || 'Text'
    });

    state.canvas.add(textObj);
    state.canvas.setActiveObject(textObj);
    state.canvas.renderAll();
    saveState();
    updateLayers();
  }

  // ========================================
  // Text Editor Modal
  // ========================================

  function openTextEditor() {
    elements.textEditorModal.removeAttribute('hidden');
    elements.textInput.focus();
  }

  function closeTextEditor() {
    elements.textEditorModal.setAttribute('hidden', '');
    elements.textInput.value = '';
  }

  function initTextEditor() {
    // Populate font families
    elements.fontFamilySelect.innerHTML = FONT_FAMILIES.map(font => `
      <option value="${font}" style="font-family: '${font}'">${font}</option>
    `).join('');

    // Modal close handlers
    elements.textEditorModal.querySelectorAll('[data-close="textEditor"]').forEach(btn => {
      btn.addEventListener('click', closeTextEditor);
    });

    // Add text confirm
    elements.addTextConfirm.addEventListener('click', () => {
      const text = elements.textInput.value.trim();
      if (!text) return;

      const options = {
        fontSize: parseInt(elements.fontSizeInput.value) || 48,
        fontFamily: elements.fontFamilySelect.value,
        fontWeight: parseInt(elements.fontWeightSelect.value) || 400,
        name: text
      };

      addTextToCanvas(text, options);
      closeTextEditor();
    });
  }

  // ========================================
  // Layers Management
  // ========================================

  function updateLayers() {
    if (!elements.layersList) return;

    const objects = state.canvas.getObjects().reverse();
    elements.layersList.innerHTML = '';

    if (objects.length === 0) {
      elements.layersList.innerHTML = '<p class="empty-state">No layers yet. Add items to get started!</p>';
      updateCanvasInfo();
      return;
    }

    objects.forEach((obj, index) => {
      const actualIndex = objects.length - 1 - index;
      const layerItem = document.createElement('div');
      layerItem.className = 'layer-item';

      if (state.canvas.getActiveObject() === obj) {
        layerItem.classList.add('active');
      }

      const icon = obj.type === 'text' ? 'fa-font' : 'fa-image';
      const name = obj.name || `${obj.type} ${actualIndex + 1}`;

      layerItem.innerHTML = `
        <i class="fas ${icon} layer-icon"></i>
        <div class="layer-info">
          <div class="layer-name">${name}</div>
          <div class="layer-type">${obj.type}</div>
        </div>
        <div class="layer-actions">
          <button class="layer-action-btn" data-action="duplicate" title="Duplicate">
            <i class="fas fa-copy"></i>
          </button>
          <button class="layer-action-btn delete" data-action="delete" title="Delete">
            <i class="fas fa-trash"></i>
          </button>
        </div>
      `;

      // Click to select
      layerItem.addEventListener('click', (e) => {
        if (!e.target.closest('.layer-actions')) {
          state.canvas.setActiveObject(obj);
          state.canvas.renderAll();
          updateLayers();
        }
      });

      // Layer actions
      layerItem.querySelectorAll('.layer-action-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const action = btn.dataset.action;

          if (action === 'delete') {
            state.canvas.remove(obj);
            state.canvas.renderAll();
            saveState();
          } else if (action === 'duplicate') {
            obj.clone((cloned) => {
              cloned.set({
                left: obj.left + 20,
                top: obj.top + 20
              });
              state.canvas.add(cloned);
              state.canvas.setActiveObject(cloned);
              state.canvas.renderAll();
              saveState();
            });
          }
        });
      });

      elements.layersList.appendChild(layerItem);
    });

    updateCanvasInfo();
  }

  // ========================================
  // Selection Handlers
  // ========================================

  function handleSelection(e) {
    state.selectedObject = e.selected[0];
    updateProperties();
    updateLayers();
  }

  function handleSelectionCleared() {
    state.selectedObject = null;
    updateProperties();
    updateLayers();
  }

  function updateProperties() {
    if (!elements.propertiesContent) return;

    if (!state.selectedObject) {
      elements.propertiesContent.innerHTML = '<p class="no-selection">Select an object to edit its properties</p>';
      return;
    }

    const obj = state.selectedObject;
    let html = '';

    // Common properties
    html += `
      <div class="property-group">
        <label class="property-label">Position</label>
        <div class="property-buttons">
          <button class="property-btn" data-action="alignLeft">
            <i class="fas fa-align-left"></i> Left
          </button>
          <button class="property-btn" data-action="alignCenter">
            <i class="fas fa-align-center"></i> Center
          </button>
          <button class="property-btn" data-action="alignRight">
            <i class="fas fa-align-right"></i> Right
          </button>
          <button class="property-btn" data-action="alignTop">
            <i class="fas fa-arrow-up"></i> Top
          </button>
          <button class="property-btn" data-action="alignMiddle">
            <i class="fas fa-arrows-alt-v"></i> Middle
          </button>
          <button class="property-btn" data-action="alignBottom">
            <i class="fas fa-arrow-down"></i> Bottom
          </button>
        </div>
      </div>
    `;

    // Opacity
    html += `
      <div class="property-group">
        <label class="property-label">Opacity</label>
        <input type="range" class="property-slider" min="0" max="1" step="0.1" value="${obj.opacity || 1}" data-property="opacity">
      </div>
    `;

    // Rotation
    html += `
      <div class="property-group">
        <label class="property-label">Rotation</label>
        <input type="range" class="property-slider" min="0" max="360" step="1" value="${obj.angle || 0}" data-property="angle">
      </div>
    `;

    // Text-specific properties
    if (obj.type === 'text') {
      html += `
        <div class="property-group">
          <label class="property-label">Text Content</label>
          <input type="text" class="property-control" value="${obj.text}" data-property="text">
        </div>
        <div class="property-group">
          <label class="property-label">Font Size</label>
          <input type="number" class="property-control" value="${obj.fontSize}" data-property="fontSize" min="8" max="500">
        </div>
      `;
    }

    // Layer order
    html += `
      <div class="property-group">
        <label class="property-label">Layer Order</label>
        <div class="property-buttons">
          <button class="property-btn" data-action="bringForward">
            <i class="fas fa-arrow-up"></i> Forward
          </button>
          <button class="property-btn" data-action="sendBackwards">
            <i class="fas fa-arrow-down"></i> Backward
          </button>
          <button class="property-btn" data-action="bringToFront">
            <i class="fas fa-angle-double-up"></i> Front
          </button>
          <button class="property-btn" data-action="sendToBack">
            <i class="fas fa-angle-double-down"></i> Back
          </button>
        </div>
      </div>
    `;

    elements.propertiesContent.innerHTML = html;

    // Attach event listeners
    elements.propertiesContent.querySelectorAll('[data-property]').forEach(input => {
      input.addEventListener('input', (e) => {
        const property = e.target.dataset.property;
        let value = e.target.value;

        if (property === 'fontSize' || property === 'angle') {
          value = parseInt(value);
        } else if (property === 'opacity') {
          value = parseFloat(value);
        }

        obj.set(property, value);
        state.canvas.renderAll();
      });

      input.addEventListener('change', saveState);
    });

    elements.propertiesContent.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        handleObjectAction(obj, action);
      });
    });
  }

  function handleObjectAction(obj, action) {
    switch (action) {
      case 'alignLeft':
        obj.set({ left: obj.width * obj.scaleX / 2 });
        break;
      case 'alignCenter':
        obj.set({ left: state.canvas.width / 2 });
        break;
      case 'alignRight':
        obj.set({ left: state.canvas.width - (obj.width * obj.scaleX / 2) });
        break;
      case 'alignTop':
        obj.set({ top: obj.height * obj.scaleY / 2 });
        break;
      case 'alignMiddle':
        obj.set({ top: state.canvas.height / 2 });
        break;
      case 'alignBottom':
        obj.set({ top: state.canvas.height - (obj.height * obj.scaleY / 2) });
        break;
      case 'bringForward':
        state.canvas.bringForward(obj);
        break;
      case 'sendBackwards':
        state.canvas.sendBackwards(obj);
        break;
      case 'bringToFront':
        state.canvas.bringToFront(obj);
        break;
      case 'sendToBack':
        state.canvas.sendToBack(obj);
        break;
    }

    state.canvas.renderAll();
    saveState();
    updateLayers();
  }

  // ========================================
  // Vinyl Color System
  // ========================================

  function renderVinylColors() {
    if (!elements.vinylColorSwatches) return;

    const palette = VINYL_PALETTES[state.selectedPalette];
    if (!palette) return;

    elements.vinylColorSwatches.innerHTML = '';

    palette.colors.forEach(color => {
      const swatch = document.createElement('div');
      swatch.className = 'color-swatch';
      swatch.style.backgroundColor = color.value;
      swatch.title = color.name;

      if (color.value === state.selectedColor) {
        swatch.classList.add('active');
      }

      swatch.addEventListener('click', () => {
        state.selectedColor = color.value;
        renderVinylColors();
        updateVinylColorInfo(color.name);

        // Update selected text color
        const activeObj = state.canvas.getActiveObject();
        if (activeObj && activeObj.type === 'text') {
          activeObj.set('fill', color.value);
          state.canvas.renderAll();
          saveState();
        }
      });

      elements.vinylColorSwatches.appendChild(swatch);
    });
  }

  function updateVinylColorInfo(colorName) {
    if (elements.vinylColorInfo) {
      elements.vinylColorInfo.textContent = colorName || 'Select vinyl color';
    }
  }

  // ========================================
  // AI Suggestions
  // ========================================

  function showAiMessage(message, type = 'suggestion') {
    if (!elements.aiSuggestions) return;

    const item = document.createElement('div');
    item.className = 'ai-suggestion-item';

    const label = type === 'suggestion' ? 'AI Suggestion' : type === 'tip' ? 'Tip' : 'Info';

    item.innerHTML = `
      <strong>${label}</strong>
      <p>${message}</p>
    `;

    elements.aiSuggestions.innerHTML = '';
    elements.aiSuggestions.appendChild(item);
  }

  async function getAiSuggestion() {
    const objects = state.canvas.getObjects();

    if (objects.length === 0) {
      showAiMessage('Start by adding items from the catalog or text. I\'ll help you arrange them!', 'tip');
      return;
    }

    // Analyze current design
    const hasText = objects.some(obj => obj.type === 'text');
    const hasImages = objects.some(obj => obj.type === 'image');
    const objectCount = objects.length;

    let suggestion = '';

    if (objectCount === 1) {
      if (hasText) {
        suggestion = '📝 Try adding an image from the catalog to complement your text. Browse the categories on the left!';
      } else {
        suggestion = '✨ Add some text to go with your image! Click "Add Text" below the catalog.';
      }
    } else if (objectCount === 2) {
      suggestion = '🎯 Looking good! Try adjusting the sizes to create hierarchy. Make one element larger to draw the eye first.';
    } else if (objectCount >= 3) {
      suggestion = '🎨 You have multiple elements. Try using the alignment tools in Properties to create a clean, balanced layout.';
    }

    if (!hasText && hasImages) {
      suggestion += ' Consider adding text to make your message clear!';
    }

    showAiMessage(suggestion, 'suggestion');

    // TODO: Integration with Claude API for advanced suggestions
    // This would analyze the design and provide contextual recommendations
  }

  // ========================================
  // Undo/Redo System
  // ========================================

  function saveState() {
    const json = JSON.stringify(state.canvas.toJSON(['name']));
    state.undoStack.push(json);
    state.redoStack = [];

    // Limit undo stack
    if (state.undoStack.length > 50) {
      state.undoStack.shift();
    }

    updateUndoRedoButtons();
  }

  function undo() {
    if (state.undoStack.length === 0) return;

    const currentState = state.undoStack.pop();
    state.redoStack.push(JSON.stringify(state.canvas.toJSON(['name'])));

    if (state.undoStack.length > 0) {
      const previousState = state.undoStack[state.undoStack.length - 1];
      state.canvas.loadFromJSON(previousState, () => {
        state.canvas.renderAll();
        updateLayers();
      });
    } else {
      state.canvas.clear();
      state.canvas.renderAll();
      updateLayers();
    }

    updateUndoRedoButtons();
  }

  function redo() {
    if (state.redoStack.length === 0) return;

    const nextState = state.redoStack.pop();
    state.undoStack.push(nextState);

    state.canvas.loadFromJSON(nextState, () => {
      state.canvas.renderAll();
      updateLayers();
    });

    updateUndoRedoButtons();
  }

  function updateUndoRedoButtons() {
    if (elements.undoButton) {
      elements.undoButton.disabled = state.undoStack.length === 0;
    }
    if (elements.redoButton) {
      elements.redoButton.disabled = state.redoStack.length === 0;
    }
  }

  // ========================================
  // Save & Export
  // ========================================

  function saveDesign() {
    const design = {
      id: Date.now(),
      name: `Design ${new Date().toLocaleString()}`,
      canvasSize: state.currentSize,
      vinylColor: state.selectedColor,
      data: state.canvas.toJSON(['name']),
      preview: state.canvas.toDataURL('image/png')
    };

    // Save to localStorage
    const saved = localStorage.getItem('savedDesigns');
    const designs = saved ? JSON.parse(saved) : [];
    designs.push(design);
    localStorage.setItem('savedDesigns', JSON.stringify(designs));

    alert('Design saved successfully!');
  }

  function addToOrder() {
    const preview = state.canvas.toDataURL('image/png');
    const design = {
      preview: preview,
      size: state.currentSize,
      vinylColor: state.selectedColor,
      data: state.canvas.toJSON(['name'])
    };

    // TODO: Integration with your existing order system
    // For now, save to localStorage and redirect
    localStorage.setItem('currentDesign', JSON.stringify(design));

    if (confirm('Add this design to your order? You\'ll be redirected to the order page.')) {
      window.location.href = './catalog.html';
    }
  }

  // ========================================
  // Utility Functions
  // ========================================

  function showLoading(show) {
    if (elements.loadingOverlay) {
      if (show) {
        elements.loadingOverlay.removeAttribute('hidden');
      } else {
        elements.loadingOverlay.setAttribute('hidden', '');
      }
    }
  }

  function clearCanvas() {
    if (confirm('Are you sure you want to clear the canvas? This cannot be undone.')) {
      state.canvas.clear();
      state.canvas.backgroundColor = '#ffffff';
      state.canvas.renderAll();
      saveState();
      updateLayers();
    }
  }

  // ========================================
  // Event Listeners
  // ========================================

  function initEventListeners() {
    // Canvas size
    elements.canvasSizeSelect?.addEventListener('change', (e) => {
      setCanvasSize(e.target.value);
    });

    // Search and filter
    elements.catalogSearch?.addEventListener('input', (e) => {
      state.searchQuery = e.target.value;
      filterCatalog();
    });

    elements.categoryFilter?.addEventListener('change', (e) => {
      state.selectedCategory = e.target.value;
      filterCatalog();
    });

    // Vinyl palette
    elements.vinylPaletteSelect?.addEventListener('change', (e) => {
      state.selectedPalette = e.target.value;
      renderVinylColors();
    });

    // Quick actions
    elements.addTextButton?.addEventListener('click', openTextEditor);
    elements.uploadImageButton?.addEventListener('click', () => {
      elements.imageUploadInput?.click();
    });

    elements.imageUploadInput?.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (event) => {
          addImageToCanvas(event.target.result, file.name);
        };
        reader.readAsDataURL(file);
      }
    });

    // Canvas controls
    elements.zoomInButton?.addEventListener('click', () => {
      const zoom = state.canvas.getZoom();
      state.canvas.setZoom(zoom * 1.1);
    });

    elements.zoomOutButton?.addEventListener('click', () => {
      const zoom = state.canvas.getZoom();
      state.canvas.setZoom(zoom / 1.1);
    });

    elements.zoomResetButton?.addEventListener('click', () => {
      state.canvas.setZoom(1);
      state.canvas.viewportCenterObject(state.canvas.getObjects()[0]);
    });

    elements.undoButton?.addEventListener('click', undo);
    elements.redoButton?.addEventListener('click', redo);
    elements.clearCanvasButton?.addEventListener('click', clearCanvas);

    // AI suggestions
    elements.getAiSuggestion?.addEventListener('click', getAiSuggestion);

    // Save & export
    elements.saveButton?.addEventListener('click', saveDesign);
    elements.addToOrderButton?.addEventListener('click', addToOrder);

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey) {
        switch (e.key.toLowerCase()) {
          case 'z':
            e.preventDefault();
            if (e.shiftKey) {
              redo();
            } else {
              undo();
            }
            break;
          case 's':
            e.preventDefault();
            saveDesign();
            break;
        }
      }

      // Delete key
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const activeObj = state.canvas.getActiveObject();
        if (activeObj && !document.activeElement.matches('input, textarea')) {
          e.preventDefault();
          state.canvas.remove(activeObj);
          state.canvas.renderAll();
          saveState();
        }
      }
    });
  }

  // ========================================
  // Templates
  // ========================================

  function initTemplates() {
    document.querySelectorAll('[data-template]').forEach(btn => {
      btn.addEventListener('click', () => {
        const template = btn.dataset.template;
        applyTemplate(template);
      });
    });
  }

  function applyTemplate(template) {
    if (!confirm('Apply template? This will clear your current design.')) {
      return;
    }

    state.canvas.clear();
    state.canvas.backgroundColor = '#ffffff';

    // Simple template examples
    switch (template) {
      case 'single-centered':
        showAiMessage('🎯 Single centered layout selected. Add one main image or text element from the catalog.', 'tip');
        break;

      case 'text-over-image':
        showAiMessage('📸 Text over image layout. Add an image first, then add text on top.', 'tip');
        break;

      case 'three-stacked':
        showAiMessage('📚 Three stacked elements. Add three images or mix of images and text, stacked vertically.', 'tip');
        break;

      case 'grid-four':
        showAiMessage('🔲 2×2 grid layout. Add four small images that will be arranged in a grid.', 'tip');
        break;
    }

    state.canvas.renderAll();
    saveState();
  }

  // ========================================
  // Initialization
  // ========================================

  function init() {
    initCanvas();
    initEventListeners();
    initTextEditor();
    initTemplates();
    setupDropZone();
    loadCatalog();
    renderVinylColors();
    updateUndoRedoButtons();

    // Initial AI message
    showAiMessage(
      'Welcome! 👋 I\'m your AI design assistant. Start by browsing the catalog on the left, or add text to create your custom decal. I\'ll provide suggestions as you design!',
      'tip'
    );
  }

  // Start the app when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
