// =============== Vinyl Cutter Editor ===============
// Provides drag-and-drop canvas for arranging vinyl cut items with visible contour lines
// Supports color detection, contour editing, and cut file generation

// Local showToast helper - uses global if available, otherwise console log
function vinylShowToast(message, variant = 'info') {
  if (typeof window.showToast === 'function') {
    window.showToast(message, variant);
  } else {
    const prefix = variant === 'error' ? '[ERROR]' : variant === 'success' ? '[OK]' : '[INFO]';
    console.log(`${prefix} ${message}`);
  }
}

// Convert server file path to URL for loading in Electron
// (Same logic as sticker-layout-editor.js getStickerImageUrl)
function getVinylImageUrl(path) {
  if (!path) return '';

  // If it's already a data URL, return as-is
  if (path.startsWith('data:')) {
    return path;
  }

  // Get server base URL from app config
  // Note: For sync functions, we use cached config. For async functions, use window.printStation.getConfig()
  const serverBase = (
    window.printStationConfig?.serverBaseUrl ||
    'https://blueridgecustomco.com'
  ).replace(/\/$/, '');

  // If it's already a full URL, convert to /api/library/ route for better reliability
  if (path.startsWith('http://') || path.startsWith('https://')) {
    // Check if URL contains the server path that needs fixing
    if (path.includes('/home/ubuntu/') || path.includes('/vinylApp/web/')) {
      // Extract just the library portion
      const libraryMatch = path.match(/\/library\/(.+)$/);
      if (libraryMatch) {
        // Use /api/library/ for better handling of large files (avoids HTTP/2 issues)
        return serverBase + '/api/library/' + encodeURIComponent(libraryMatch[1]).replace(/%2F/g, '/');
      }
    }
    // Convert /library/ to /api/library/ for better reliability
    if (path.includes('/library/')) {
      const libraryMatch = path.match(/\/library\/(.+)$/);
      if (libraryMatch) {
        // The path might already be URL-encoded, so decode first then re-encode properly
        let libPath = libraryMatch[1];
        try {
          libPath = decodeURIComponent(libPath);
        } catch (e) {
          // Already decoded or invalid encoding, use as-is
        }
        // Encode each path segment separately
        const encodedPath = libPath.split('/').map(segment => encodeURIComponent(segment)).join('/');
        return serverBase + '/api/library/' + encodedPath;
      }
    }
    return path;
  }

  // Extract just the library path portion
  let libraryPath = '';

  // Handle various path formats - extract library portion
  if (path.includes('/library/')) {
    libraryPath = path.split('/library/')[1];
  } else if (path.includes('\\library\\')) {
    libraryPath = path.split('\\library\\')[1].replace(/\\/g, '/');
  } else if (path.startsWith('/')) {
    // Absolute path on server - extract from web folder or /mnt/websit/
    const webMatch = path.match(/\/web\/library\/(.+)$/);
    const websitMatch = path.match(/\/mnt\/websit\/(.+)$/);
    if (webMatch) {
      libraryPath = webMatch[1];
    } else if (websitMatch) {
      libraryPath = websitMatch[1];
    } else {
      // Fallback - just use the path
      return serverBase + path;
    }
  } else {
    // Already a relative path
    libraryPath = path;
  }

  // Use /api/library/ route for better reliability (Node.js handles it vs nginx static files)
  return serverBase + '/api/library/' + encodeURIComponent(libraryPath).replace(/%2F/g, '/');
}

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

const vinylCutterState = {
  canvas: null,
  canvasConfig: {
    widthInches: 12,
    heightInches: 12,
    dpi: 96,        // Screen display DPI
    exportDpi: 300, // Export resolution for cut files
    marginInches: 0.5,
    get widthPx() { return Math.floor(this.widthInches * this.dpi); },
    get heightPx() { return Math.floor(this.heightInches * this.dpi); },
    get marginPx() { return Math.floor(this.marginInches * this.dpi); },
    displayScale: 1  // 1:1 for vinyl (not scaled down)
  },
  items: [],           // Items on canvas with vectorization data
  colorLayers: [],     // Detected colors across all items { hex, name, count, visible }
  contourEditMode: false,
  editingItem: null,
  contourHandles: [],
  contourPoints: [],
  generatedFiles: [],
  showWeedingLines: false,
  showRegistrationMarks: true,
  showGrid: true,
  snapToGrid: false,
  isInitialized: false,
  // Zoom and pan state
  zoomLevel: 1,
  minZoom: 0.25,
  maxZoom: 4,
  zoomStep: 0.25,
  isPanning: false,
  lastPanPosition: { x: 0, y: 0 },
  // Contour cache
  contourCache: new Map(),
  // Grid elements (for toggling visibility)
  gridObjects: [],
  rulerObjects: []
};

// ============================================================================
// INITIALIZATION
// ============================================================================

function initVinylCutterEditor() {
  if (vinylCutterState.isInitialized) {
    console.log('[VinylCutter] Already initialized');
    return;
  }

  const canvasEl = document.getElementById('vinylEditorCanvas');
  if (!canvasEl) {
    console.error('[VinylCutter] Canvas element not found');
    return;
  }

  const config = vinylCutterState.canvasConfig;
  const displayWidth = config.widthPx * config.displayScale;
  const displayHeight = config.heightPx * config.displayScale;

  // Set canvas dimensions
  canvasEl.width = displayWidth;
  canvasEl.height = displayHeight;

  // Initialize Fabric.js canvas
  vinylCutterState.canvas = new fabric.Canvas('vinylEditorCanvas', {
    width: displayWidth,
    height: displayHeight,
    backgroundColor: '#ffffff',
    selection: true,
    preserveObjectStacking: true
  });

  // Draw grid and rulers
  drawVinylGrid();
  drawVinylRulers();

  // Setup event listeners
  setupVinylEditorEvents();
  setupVinylZoomPan();

  vinylCutterState.isInitialized = true;
  updateVinylCanvasSizeLabel();
  console.log('[VinylCutter] Editor initialized:', displayWidth, 'x', displayHeight);
}

// ============================================================================
// GRID AND RULERS
// ============================================================================

function drawVinylGrid() {
  const canvas = vinylCutterState.canvas;
  const config = vinylCutterState.canvasConfig;
  const scale = config.displayScale;

  // Clear existing grid objects
  vinylCutterState.gridObjects.forEach(obj => canvas.remove(obj));
  vinylCutterState.gridObjects = [];

  if (!vinylCutterState.showGrid) {
    canvas.renderAll();
    return;
  }

  const widthPx = config.widthPx * scale;
  const heightPx = config.heightPx * scale;
  const inchPx = config.dpi * scale;
  const quarterInchPx = inchPx / 4;

  // Draw 1/4" grid lines (minor)
  for (let x = quarterInchPx; x < widthPx; x += quarterInchPx) {
    if (x % inchPx !== 0) { // Skip major grid lines
      const line = new fabric.Line([x, 0, x, heightPx], {
        stroke: '#e5e5e5',
        strokeWidth: 0.5,
        selectable: false,
        evented: false,
        excludeFromExport: true
      });
      vinylCutterState.gridObjects.push(line);
      canvas.add(line);
    }
  }

  for (let y = quarterInchPx; y < heightPx; y += quarterInchPx) {
    if (y % inchPx !== 0) {
      const line = new fabric.Line([0, y, widthPx, y], {
        stroke: '#e5e5e5',
        strokeWidth: 0.5,
        selectable: false,
        evented: false,
        excludeFromExport: true
      });
      vinylCutterState.gridObjects.push(line);
      canvas.add(line);
    }
  }

  // Draw 1" grid lines (major)
  for (let x = inchPx; x < widthPx; x += inchPx) {
    const line = new fabric.Line([x, 0, x, heightPx], {
      stroke: '#cccccc',
      strokeWidth: 1,
      selectable: false,
      evented: false,
      excludeFromExport: true
    });
    vinylCutterState.gridObjects.push(line);
    canvas.add(line);
  }

  for (let y = inchPx; y < heightPx; y += inchPx) {
    const line = new fabric.Line([0, y, widthPx, y], {
      stroke: '#cccccc',
      strokeWidth: 1,
      selectable: false,
      evented: false,
      excludeFromExport: true
    });
    vinylCutterState.gridObjects.push(line);
    canvas.add(line);
  }

  // Send grid to back
  vinylCutterState.gridObjects.forEach(obj => canvas.sendToBack(obj));
  canvas.renderAll();
}

function drawVinylRulers() {
  const config = vinylCutterState.canvasConfig;
  const scale = config.displayScale;
  const widthPx = config.widthPx * scale;
  const heightPx = config.heightPx * scale;
  const inchPx = config.dpi * scale;

  // Get ruler containers
  const topRuler = document.getElementById('vinylTopRuler');
  const leftRuler = document.getElementById('vinylLeftRuler');

  if (!topRuler || !leftRuler) return;

  // Set ruler dimensions
  topRuler.style.width = widthPx + 'px';
  leftRuler.style.height = heightPx + 'px';

  // Clear existing content
  topRuler.innerHTML = '';
  leftRuler.innerHTML = '';

  // Create SVG for top ruler
  const topSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  topSvg.setAttribute('width', widthPx);
  topSvg.setAttribute('height', 25);
  topSvg.style.display = 'block';

  for (let i = 0; i <= config.widthInches; i++) {
    const x = i * inchPx;
    // Major tick
    const tick = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    tick.setAttribute('x1', x);
    tick.setAttribute('y1', 15);
    tick.setAttribute('x2', x);
    tick.setAttribute('y2', 25);
    tick.setAttribute('stroke', '#888');
    tick.setAttribute('stroke-width', '1');
    topSvg.appendChild(tick);

    // Number label
    if (i < config.widthInches) {
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', x + 4);
      text.setAttribute('y', 12);
      text.setAttribute('fill', '#888');
      text.setAttribute('font-size', '10');
      text.textContent = i.toString();
      topSvg.appendChild(text);
    }

    // Quarter inch ticks
    for (let q = 1; q < 4 && i < config.widthInches; q++) {
      const qx = x + (q * inchPx / 4);
      const qtick = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      qtick.setAttribute('x1', qx);
      qtick.setAttribute('y1', q === 2 ? 18 : 21);
      qtick.setAttribute('x2', qx);
      qtick.setAttribute('y2', 25);
      qtick.setAttribute('stroke', '#aaa');
      qtick.setAttribute('stroke-width', '0.5');
      topSvg.appendChild(qtick);
    }
  }
  topRuler.appendChild(topSvg);

  // Create SVG for left ruler
  const leftSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  leftSvg.setAttribute('width', 30);
  leftSvg.setAttribute('height', heightPx);
  leftSvg.style.display = 'block';

  for (let i = 0; i <= config.heightInches; i++) {
    const y = i * inchPx;
    // Major tick
    const tick = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    tick.setAttribute('x1', 20);
    tick.setAttribute('y1', y);
    tick.setAttribute('x2', 30);
    tick.setAttribute('y2', y);
    tick.setAttribute('stroke', '#888');
    tick.setAttribute('stroke-width', '1');
    leftSvg.appendChild(tick);

    // Number label
    if (i < config.heightInches) {
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', 4);
      text.setAttribute('y', y + 14);
      text.setAttribute('fill', '#888');
      text.setAttribute('font-size', '10');
      text.textContent = i.toString();
      leftSvg.appendChild(text);
    }

    // Quarter inch ticks
    for (let q = 1; q < 4 && i < config.heightInches; q++) {
      const qy = y + (q * inchPx / 4);
      const qtick = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      qtick.setAttribute('x1', q === 2 ? 23 : 25);
      qtick.setAttribute('y1', qy);
      qtick.setAttribute('x2', 30);
      qtick.setAttribute('y2', qy);
      qtick.setAttribute('stroke', '#aaa');
      qtick.setAttribute('stroke-width', '0.5');
      leftSvg.appendChild(qtick);
    }
  }
  leftRuler.appendChild(leftSvg);
}

// ============================================================================
// CANVAS SIZE MANAGEMENT
// ============================================================================

function updateVinylCanvasSize() {
  const widthInput = document.getElementById('vinylCanvasWidth');
  const heightInput = document.getElementById('vinylCanvasHeight');

  if (!widthInput || !heightInput) return;

  const newWidth = parseInt(widthInput.value) || 12;
  const newHeight = parseInt(heightInput.value) || 12;

  // Clamp values
  const width = Math.max(1, Math.min(24, newWidth));
  const height = Math.max(1, Math.min(24, newHeight));

  widthInput.value = width;
  heightInput.value = height;

  // Update config
  vinylCutterState.canvasConfig.widthInches = width;
  vinylCutterState.canvasConfig.heightInches = height;

  // Resize canvas
  const canvas = vinylCutterState.canvas;
  if (canvas) {
    const config = vinylCutterState.canvasConfig;
    const displayWidth = config.widthPx * config.displayScale;
    const displayHeight = config.heightPx * config.displayScale;

    canvas.setDimensions({ width: displayWidth, height: displayHeight });
    drawVinylGrid();
    drawVinylRulers();
    canvas.renderAll();
  }

  updateVinylCanvasSizeLabel();
  vinylShowToast(`Canvas resized to ${width}" x ${height}"`, 'success');
}

function updateVinylCanvasSizeLabel() {
  const label = document.getElementById('vinylCanvasSizeLabel');
  if (label) {
    const config = vinylCutterState.canvasConfig;
    label.textContent = `${config.widthInches}" x ${config.heightInches}" @ ${config.dpi} DPI`;
  }
}

// ============================================================================
// EVENT HANDLERS
// ============================================================================

function setupVinylEditorEvents() {
  const canvas = vinylCutterState.canvas;

  // Object selection
  canvas.on('selection:created', updateVinylControls);
  canvas.on('selection:updated', updateVinylControls);
  canvas.on('selection:cleared', updateVinylControls);

  // Object modification
  canvas.on('object:modified', () => {
    updateVinylControls();
  });

  canvas.on('object:moving', (e) => {
    if (vinylCutterState.snapToGrid) {
      snapToVinylGrid(e.target);
    }
    if (e.target && e.target.vinylData) {
      updateVinylContourPosition(e.target);
    }
  });

  canvas.on('object:scaling', (e) => {
    if (e.target && e.target.vinylData) {
      updateVinylContourPosition(e.target);
    }
  });

  canvas.on('object:rotating', (e) => {
    if (e.target && e.target.vinylData) {
      updateVinylContourPosition(e.target);
    }
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', handleVinylKeyboard);

  // UI event bindings
  const showGridCheckbox = document.getElementById('vinylShowGrid');
  if (showGridCheckbox) {
    showGridCheckbox.addEventListener('change', (e) => {
      vinylCutterState.showGrid = e.target.checked;
      drawVinylGrid();
    });
  }

  const snapToGridCheckbox = document.getElementById('vinylSnapToGrid');
  if (snapToGridCheckbox) {
    snapToGridCheckbox.addEventListener('change', (e) => {
      vinylCutterState.snapToGrid = e.target.checked;
    });
  }

  const applySizeBtn = document.getElementById('vinylApplyCanvasSizeBtn');
  if (applySizeBtn) {
    applySizeBtn.addEventListener('click', updateVinylCanvasSize);
  }

  const clearCanvasBtn = document.getElementById('vinylClearCanvasBtn');
  if (clearCanvasBtn) {
    clearCanvasBtn.addEventListener('click', clearVinylCanvas);
  }
}

function handleVinylKeyboard(e) {
  // Only handle if vinyl cutter view is visible
  const vinylView = document.getElementById('vinylCutterView');
  if (!vinylView || vinylView.style.display === 'none' || !vinylView.classList.contains('active')) return;

  const canvas = vinylCutterState.canvas;
  if (!canvas) return;

  const activeObject = canvas.getActiveObject();

  switch (e.key) {
    case 'Delete':
    case 'Backspace':
      if (activeObject && activeObject.vinylData) {
        e.preventDefault();
        removeVinylItem();
      }
      break;
    case 'r':
    case 'R':
      if (!e.ctrlKey && !e.metaKey && activeObject) {
        e.preventDefault();
        rotateVinylItem(90);
      }
      break;
    case '[':
      if (activeObject) {
        e.preventDefault();
        scaleVinylItem(0.9);
      }
      break;
    case ']':
      if (activeObject) {
        e.preventDefault();
        scaleVinylItem(1.1);
      }
      break;
  }
}

function snapToVinylGrid(obj) {
  const config = vinylCutterState.canvasConfig;
  const gridSize = (config.dpi / 4) * config.displayScale; // Snap to 1/4"

  obj.left = Math.round(obj.left / gridSize) * gridSize;
  obj.top = Math.round(obj.top / gridSize) * gridSize;
}

// ============================================================================
// ZOOM AND PAN
// ============================================================================

function setupVinylZoomPan() {
  const canvas = vinylCutterState.canvas;
  const container = document.getElementById('vinylCanvasContainer');

  if (!container) return;

  // Mouse wheel zoom
  container.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -1 : 1;
      zoomVinylCanvas(delta);
    }
  }, { passive: false });
}

function zoomVinylCanvas(direction) {
  const state = vinylCutterState;
  const newZoom = state.zoomLevel + (direction * state.zoomStep);

  if (newZoom >= state.minZoom && newZoom <= state.maxZoom) {
    state.zoomLevel = newZoom;
    state.canvas.setZoom(newZoom);
    state.canvas.renderAll();

    // Update zoom display
    const zoomLabel = document.getElementById('vinylZoomLevel');
    if (zoomLabel) {
      zoomLabel.textContent = Math.round(newZoom * 100) + '%';
    }
  }
}

function resetVinylZoom() {
  vinylCutterState.zoomLevel = 1;
  vinylCutterState.canvas.setZoom(1);
  vinylCutterState.canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
  vinylCutterState.canvas.renderAll();

  const zoomLabel = document.getElementById('vinylZoomLevel');
  if (zoomLabel) {
    zoomLabel.textContent = '100%';
  }
}

// ============================================================================
// ITEM MANAGEMENT
// ============================================================================

async function addItemToVinylCanvas(design) {
  if (!vinylCutterState.canvas) {
    initVinylCutterEditor();
  }

  const canvas = vinylCutterState.canvas;
  const config = vinylCutterState.canvasConfig;
  const scale = config.displayScale;

  // Get image URL
  const rawPath = design.thumbnailUrl || design.imageUrl || design.imagePath || design.image;
  const imageUrl = getVinylImageUrl(rawPath);

  console.log('[VinylCutter] Adding item:', {
    title: design.title || design.name,
    rawPath,
    imageUrl
  });

  // Update status
  updateVinylStatus('Loading and vectorizing...');

  try {
    // Load image
    const img = await loadVinylImage(imageUrl);

    // Use custom dimensions from screenshot import, or default 4 inches
    const aspectRatio = img.width / img.height;
    let itemWidth, itemHeight;

    if (design._importWidthInches && design._importHeightInches) {
      itemWidth = design._importWidthInches * config.dpi;
      itemHeight = design._importHeightInches * config.dpi;
    } else if (design._importWidthInches) {
      itemWidth = design._importWidthInches * config.dpi;
      itemHeight = itemWidth / aspectRatio;
    } else if (design._importHeightInches) {
      itemHeight = design._importHeightInches * config.dpi;
      itemWidth = itemHeight * aspectRatio;
    } else {
      const targetSizeInches = 4;
      const targetSizePx = targetSizeInches * config.dpi;
      if (aspectRatio > 1) {
        itemWidth = targetSizePx;
        itemHeight = targetSizePx / aspectRatio;
      } else {
        itemHeight = targetSizePx;
        itemWidth = targetSizePx * aspectRatio;
      }
    }

    // Create Fabric image
    const fabricImg = new fabric.Image(img, {
      left: config.marginPx * scale + 50,
      top: config.marginPx * scale + 50,
      scaleX: (itemWidth * scale) / img.width,
      scaleY: (itemHeight * scale) / img.height,
      hasControls: true,
      hasBorders: true,
      lockUniScaling: false,
      cornerStyle: 'circle',
      cornerColor: '#7c3aed',
      cornerStrokeColor: '#7c3aed',
      borderColor: '#7c3aed',
      transparentCorners: false,
      centeredRotation: true
    });

    // Store vinyl data
    fabricImg.vinylData = {
      id: design.id || Date.now(),
      title: design.title || design.name,
      imagePath: design.imagePath,
      thumbnailUrl: design.thumbnailUrl,
      imageUrl: imageUrl,
      originalWidth: img.width,
      originalHeight: img.height,
      targetWidth: itemWidth,
      targetHeight: itemHeight,
      colors: []
    };

    // Vectorize and get per-color contours (if imagePath available)
    if (design.imagePath) {
      try {
        console.log('[VinylCutter] Vectorizing with imagePath:', design.imagePath);
        const vectorResult = await vectorizeVinylItem(design.imagePath);
        console.log('[VinylCutter] Vectorization result:', vectorResult);

        if (vectorResult && vectorResult.success !== false && vectorResult.colors && vectorResult.colors.length > 0) {
          // New format: each color has its own contourPath
          // colors: [{ hex, name, contourPath, contourPaths, count, percentage }, ...]
          // Sort colors by pixel count (largest first), but ensure BLACK is always first
          const sortedColors = [...vectorResult.colors].sort((a, b) => {
            // Black always comes first
            if (a.name === 'BLACK') return -1;
            if (b.name === 'BLACK') return 1;
            // Then sort by count (descending)
            return (b.count || 0) - (a.count || 0);
          });

          fabricImg.vinylData.colors = sortedColors;
          fabricImg.vinylData.width = vectorResult.width;
          fabricImg.vinylData.height = vectorResult.height;
          // Track which colors are enabled for cutting (default: only first color / black)
          fabricImg.vinylData.enabledColors = [sortedColors[0]?.hex || '#000000'];

          console.log('[VinylCutter] Colors sorted by count:', fabricImg.vinylData.colors.map(c => `${c.name || c.hex}: ${c.count}`));

          // Create contours for each color layer - this is proper vinyl cutting!
          fabricImg.colorContours = []; // Array to hold all color contour objects

          for (const colorData of vectorResult.colors) {
            if (colorData.contourPath) {
              const colorContour = createVinylContour(
                colorData.contourPath,
                vectorResult.width,
                vectorResult.height,
                itemWidth,
                itemHeight,
                scale,
                colorData.hex // Use the actual color for the stroke
              );
              if (colorContour) {
                colorContour.colorHex = colorData.hex; // Tag the contour with its color
                fabricImg.colorContours.push(colorContour);
                canvas.add(colorContour);
              }
            }
          }

          // Update contour positions for all color contours
          updateVinylColorContourPositions(fabricImg);

          // Color layers will be updated after item is added to state
        } else {
          throw new Error(vectorResult?.error || 'Vectorization returned no colors');
        }
      } catch (err) {
        console.warn('[VinylCutter] Vectorization failed, using fallback:', err.message);
        // Create rectangular fallback contour
        const fallbackContour = createFallbackVinylContour(itemWidth, itemHeight, scale);
        fabricImg.contourPath = fallbackContour;
        updateVinylContourPosition(fabricImg);
        canvas.add(fallbackContour);
      }
    } else {
      console.warn('[VinylCutter] No imagePath provided, using fallback contour');
      // Create rectangular fallback contour when no server path available
      const fallbackContour = createFallbackVinylContour(itemWidth, itemHeight, scale);
      fabricImg.contourPath = fallbackContour;
      updateVinylContourPosition(fabricImg);
      canvas.add(fallbackContour);
    }

    canvas.add(fabricImg);
    if (fabricImg.contourPath) {
      canvas.bringToFront(fabricImg.contourPath);
    }

    canvas.setActiveObject(fabricImg);
    canvas.renderAll();

    // Add to items list
    vinylCutterState.items.push(fabricImg);
    updateVinylItemsList();
    updateVinylItemCount();
    updateVinylColorLayers();  // Update color layers AFTER item is in the list
    updateVinylControls();
    updateVinylStatus('Ready');

    console.log('[VinylCutter] Added item:', design.title);

  } catch (err) {
    console.error('[VinylCutter] Failed to add item:', err);
    vinylShowToast('Failed to add item: ' + err.message, 'error');
    updateVinylStatus('Error');
  }
}

function loadVinylImage(url) {
  console.log('[VinylCutter] Loading image:', url);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';

    // Add timeout in case image never loads (30 seconds)
    const timeout = setTimeout(() => {
      console.error('[VinylCutter] Image load timeout:', url);
      reject(new Error('Image load timeout: ' + url));
    }, 30000);

    img.onload = () => {
      clearTimeout(timeout);
      console.log('[VinylCutter] Image loaded:', img.width, 'x', img.height);
      resolve(img);
    };

    img.onerror = (err) => {
      clearTimeout(timeout);
      console.error('[VinylCutter] Image load failed:', url, err);
      reject(new Error('Failed to load image: ' + url));
    };

    img.src = url;
  });
}

async function vectorizeVinylItem(imagePath) {
  // Use IPC bridge to vectorize
  if (typeof printStation !== 'undefined' && printStation.vinylCutter) {
    const useAi = document.getElementById('vinylUseAiToggle')?.checked ?? true;
    console.log('[VinylCutter] Vectorizing with', useAi ? 'AI (Gemini)' : 'legacy (potrace)');
    return await printStation.vinylCutter.vectorize(imagePath, { useAi });
  }
  throw new Error('Vinyl cutter IPC not available');
}

function createVinylContour(svgPath, origWidth, origHeight, targetWidth, targetHeight, displayScale, strokeColor = '#ef4444') {
  if (!svgPath) return null;

  try {
    const scaleX = (targetWidth * displayScale) / origWidth;
    const scaleY = (targetHeight * displayScale) / origHeight;

    const contour = new fabric.Path(svgPath, {
      fill: 'transparent',
      stroke: '#ef4444', // Always red for contour visibility
      strokeWidth: 2,
      selectable: false,
      evented: false,
      originX: 'center',
      originY: 'center',
      scaleX: scaleX,
      scaleY: scaleY
    });

    return contour;
  } catch (err) {
    console.error('[VinylCutter] Failed to create contour:', err);
    return null;
  }
}

// Update positions for all color contours on an item
function updateVinylColorContourPositions(item) {
  if (!item || !item.colorContours) return;

  const canvas = vinylCutterState.canvas;
  if (!canvas) return;

  for (const contour of item.colorContours) {
    contour.set({
      left: item.left,
      top: item.top,
      angle: item.angle || 0
    });
    contour.setCoords();
  }
  canvas.renderAll();
}

function createFallbackVinylContour(width, height, displayScale) {
  const contour = new fabric.Rect({
    left: 0,
    top: 0,
    width: width * displayScale + 10,
    height: height * displayScale + 10,
    rx: 5,
    ry: 5,
    fill: 'transparent',
    stroke: '#ef4444',
    strokeWidth: 2,
    strokeDashArray: [8, 4],
    selectable: false,
    evented: false,
    originX: 'center',
    originY: 'center'
  });

  return contour;
}

function updateVinylContourPosition(itemObj) {
  if (!itemObj.contourPath) return;

  const contour = itemObj.contourPath;
  const centerX = itemObj.left + (itemObj.width * itemObj.scaleX) / 2;
  const centerY = itemObj.top + (itemObj.height * itemObj.scaleY) / 2;

  if (contour.type === 'rect') {
    contour.set({
      left: centerX,
      top: centerY,
      angle: itemObj.angle
    });
  } else {
    contour.set({
      left: centerX,
      top: centerY,
      angle: itemObj.angle,
      scaleX: itemObj.scaleX,
      scaleY: itemObj.scaleY
    });
  }

  contour.setCoords();
}

function removeVinylItem() {
  const canvas = vinylCutterState.canvas;
  const activeObject = canvas.getActiveObject();

  if (!activeObject || !activeObject.vinylData) return;

  // Remove contour
  if (activeObject.contourPath) {
    canvas.remove(activeObject.contourPath);
  }

  // Remove from items array
  const index = vinylCutterState.items.indexOf(activeObject);
  if (index > -1) {
    vinylCutterState.items.splice(index, 1);
  }

  canvas.remove(activeObject);
  canvas.discardActiveObject();
  canvas.renderAll();

  updateVinylItemsList();
  updateVinylItemCount();
  updateVinylColorLayers();
  updateVinylControls();
}

function clearVinylCanvas() {
  const canvas = vinylCutterState.canvas;
  if (!canvas) return;

  // Remove all items and their contours
  vinylCutterState.items.forEach(item => {
    if (item.contourPath) {
      canvas.remove(item.contourPath);
    }
    canvas.remove(item);
  });

  vinylCutterState.items = [];
  vinylCutterState.colorLayers = [];
  canvas.discardActiveObject();
  canvas.renderAll();

  updateVinylItemsList();
  updateVinylItemCount();
  updateVinylColorLayers();
  updateVinylControls();

  vinylShowToast('Canvas cleared', 'info');
}

// ============================================================================
// ITEM TRANSFORMS
// ============================================================================

function rotateVinylItem(degrees) {
  const canvas = vinylCutterState.canvas;
  const activeObject = canvas.getActiveObject();

  if (!activeObject) return;

  activeObject.rotate((activeObject.angle || 0) + degrees);
  if (activeObject.vinylData && activeObject.contourPath) {
    updateVinylContourPosition(activeObject);
  }
  canvas.renderAll();
}

function scaleVinylItem(factor) {
  const canvas = vinylCutterState.canvas;
  const activeObject = canvas.getActiveObject();

  if (!activeObject) return;

  activeObject.scaleX *= factor;
  activeObject.scaleY *= factor;
  if (activeObject.vinylData && activeObject.contourPath) {
    updateVinylContourPosition(activeObject);
  }
  canvas.renderAll();
}

// ============================================================================
// UI UPDATES
// ============================================================================

function updateVinylControls() {
  const canvas = vinylCutterState.canvas;
  const activeObject = canvas ? canvas.getActiveObject() : null;
  const hasSelection = activeObject && activeObject.vinylData;
  const hasItems = vinylCutterState.items.length > 0;

  // Transform buttons
  const buttons = ['vinylRotateBtn', 'vinylScaleUpBtn', 'vinylScaleDownBtn', 'vinylDeleteBtn', 'vinylRefreshContourBtn', 'vinylEditContourBtn'];
  buttons.forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = !hasSelection;
  });

  // Generate button
  const generateBtn = document.getElementById('vinylGenerateBtn');
  const generateBtn2 = document.getElementById('vinylGenerateCutFilesBtn');
  if (generateBtn) generateBtn.disabled = !hasItems;
  if (generateBtn2) generateBtn2.disabled = !hasItems;

  // Status text
  const statusEl = document.getElementById('vinylGenerateStatus');
  if (statusEl) {
    statusEl.textContent = hasItems ? `${vinylCutterState.items.length} item(s) on canvas` : 'Add items to canvas first';
  }
}

function updateVinylItemCount() {
  const countEl = document.getElementById('vinylItemCount');
  if (countEl) {
    countEl.textContent = vinylCutterState.items.length.toString();
  }
}

function updateVinylItemsList() {
  const listEl = document.getElementById('vinylItemsList');
  if (!listEl) return;

  if (vinylCutterState.items.length === 0) {
    listEl.innerHTML = '<div class="placeholder" style="text-align:center;padding:20px;color:#888;">No items added yet</div>';
    return;
  }

  listEl.innerHTML = vinylCutterState.items.map((item, index) => {
    const data = item.vinylData;
    const enabledCount = data.enabledColors?.length || 1;
    const totalColors = data.colors?.length || 0;

    // Build color count options (1 to total colors)
    const colorCountOptions = [];
    for (let i = 1; i <= totalColors; i++) {
      colorCountOptions.push(`<option value="${i}" ${i === enabledCount ? 'selected' : ''}>${i} color${i > 1 ? 's' : ''}</option>`);
    }

    // Build enabled colors display with color swatches
    const enabledColorsDisplay = (data.enabledColors || []).map(hex => {
      const colorInfo = data.colors?.find(c => c.hex === hex);
      return `<div style="width:14px;height:14px;border-radius:2px;background:${hex};border:1px solid #555;" title="${colorInfo?.name || hex}"></div>`;
    }).join('');

    return `
      <div class="vinyl-item-row" style="padding:8px;background:rgba(255,255,255,0.05);border-radius:4px;margin-bottom:6px;">
        <div style="display:flex;align-items:center;gap:8px;cursor:pointer;" onclick="selectVinylItem(${index})">
          <img src="${data.imageUrl}" style="width:40px;height:40px;object-fit:contain;border-radius:4px;background:#fff;" />
          <div style="flex:1;min-width:0;">
            <div style="font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${data.title || 'Untitled'}</div>
            <div style="font-size:10px;color:#888;">${totalColors} colors detected</div>
          </div>
          <button class="secondary" style="font-size:10px;padding:2px 6px;" onclick="event.stopPropagation();removeVinylItemByIndex(${index})">X</button>
        </div>
        ${totalColors > 0 ? `
        <div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.1);">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
            <label style="font-size:11px;color:#aaa;">Cut colors:</label>
            <select onchange="setVinylItemColorCount(${index}, parseInt(this.value))" style="font-size:11px;padding:2px 4px;background:#333;color:#fff;border:1px solid #555;border-radius:3px;">
              ${colorCountOptions.join('')}
            </select>
          </div>
          <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">
            <span style="font-size:10px;color:#888;">Enabled:</span>
            ${enabledColorsDisplay}
            ${enabledCount < totalColors ? `<span style="font-size:10px;color:#666;">+${totalColors - enabledCount} merged to black</span>` : ''}
          </div>
        </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

// Set the number of colors for an item (enables that many colors, starting from black)
function setVinylItemColorCount(itemIndex, count) {
  const item = vinylCutterState.items[itemIndex];
  if (!item || !item.vinylData || !item.vinylData.colors) return;

  const colors = item.vinylData.colors;
  // Enable the first N colors (already sorted with BLACK first, then by count)
  item.vinylData.enabledColors = colors.slice(0, count).map(c => c.hex);

  console.log(`[VinylCutter] Item ${itemIndex} now has ${count} colors enabled:`, item.vinylData.enabledColors);

  updateVinylItemsList();
  updateVinylColorLayers();
}

// Expose to global scope for onclick handlers
window.setVinylItemColorCount = setVinylItemColorCount;

function selectVinylItem(index) {
  const item = vinylCutterState.items[index];
  if (item && vinylCutterState.canvas) {
    vinylCutterState.canvas.setActiveObject(item);
    vinylCutterState.canvas.renderAll();
    updateVinylControls();
  }
}

function removeVinylItemByIndex(index) {
  const item = vinylCutterState.items[index];
  if (item) {
    const canvas = vinylCutterState.canvas;
    // Remove single contour if present
    if (item.contourPath) {
      canvas.remove(item.contourPath);
    }
    // Remove all color contours if present
    if (item.colorContours && item.colorContours.length > 0) {
      item.colorContours.forEach(contour => canvas.remove(contour));
    }
    canvas.remove(item);
    vinylCutterState.items.splice(index, 1);
    canvas.discardActiveObject();
    canvas.renderAll();
    updateVinylItemsList();
    updateVinylItemCount();
    updateVinylColorLayers();
    updateVinylControls();
  }
}

function updateVinylColorLayers() {
  const colorsEl = document.getElementById('vinylColorLayers');
  const countEl = document.getElementById('vinylColorCount');

  // Collect ENABLED colors from all items (colors that will generate cut files)
  const enabledColorMap = new Map();
  // Also track total colors for reference
  let totalDetected = 0;

  vinylCutterState.items.forEach(item => {
    if (item.vinylData && item.vinylData.colors) {
      totalDetected += item.vinylData.colors.length;
      const enabledColors = item.vinylData.enabledColors || [item.vinylData.colors[0]?.hex];

      item.vinylData.colors.forEach(color => {
        const hex = color.hex || color;
        const isEnabled = enabledColors.includes(hex);

        if (isEnabled) {
          if (!enabledColorMap.has(hex)) {
            enabledColorMap.set(hex, { hex, name: color.name, count: 0 });
          }
          enabledColorMap.get(hex).count++;
        }
      });
    }
  });

  vinylCutterState.colorLayers = Array.from(enabledColorMap.values());

  if (countEl) {
    const enabledCount = vinylCutterState.colorLayers.length;
    countEl.textContent = `${enabledCount} cut file${enabledCount !== 1 ? 's' : ''}`;
  }

  if (!colorsEl) return;

  if (vinylCutterState.colorLayers.length === 0) {
    colorsEl.innerHTML = '<div class="placeholder" style="text-align:center;padding:15px;color:#888;font-size:12px;">Colors will appear after adding items</div>';
    return;
  }

  colorsEl.innerHTML = `
    <div style="font-size:10px;color:#888;margin-bottom:6px;">Cut files will be generated for:</div>
    ${vinylCutterState.colorLayers.map((color, index) => `
    <div class="color-layer-row" style="display:flex;align-items:center;gap:8px;padding:4px 6px;background:rgba(255,255,255,0.05);border-radius:4px;margin-bottom:4px;">
      <div style="width:20px;height:20px;border-radius:3px;background:${color.hex};border:1px solid #444;"></div>
      <span style="flex:1;font-size:12px;">${color.name || color.hex}</span>
      <span style="font-size:10px;color:#888;">${color.count} item${color.count !== 1 ? 's' : ''}</span>
    </div>
  `).join('')}
  `;
}

function updateVinylStatus(status) {
  const statusEl = document.getElementById('vinylCutterStatus');
  if (statusEl) {
    statusEl.textContent = status;
  }
}

// ============================================================================
// CONTOUR VISIBILITY
// ============================================================================

function toggleVinylContourVisibility() {
  const canvas = vinylCutterState.canvas;
  if (!canvas) return;

  const btn = document.getElementById('vinylContourToggle');
  const isHiding = btn && btn.textContent.includes('Hide');

  vinylCutterState.items.forEach(item => {
    // Handle single contour
    if (item.contourPath) {
      item.contourPath.visible = !isHiding;
    }
    // Handle multiple color contours
    if (item.colorContours && item.colorContours.length > 0) {
      item.colorContours.forEach(contour => {
        contour.visible = !isHiding;
      });
    }
  });

  canvas.renderAll();

  if (btn) {
    btn.textContent = isHiding ? 'Show Contours' : 'Hide Contours';
  }
}

// ============================================================================
// CUT FILE GENERATION
// ============================================================================

async function generateVinylCutFiles() {
  if (vinylCutterState.items.length === 0) {
    vinylShowToast('No items on canvas', 'warning');
    return;
  }

  updateVinylStatus('Generating cut files...');
  const generateBtn = document.getElementById('vinylGenerateBtn');
  if (generateBtn) generateBtn.disabled = true;

  try {
    // Collect item data - merge disabled colors into BLACK
    const items = vinylCutterState.items.map(item => {
      const enabledColors = item.vinylData.enabledColors || [item.vinylData.colors?.[0]?.hex];
      const allColors = item.vinylData.colors || [];

      console.log('[VinylCutter] Enabled colors:', enabledColors);
      console.log('[VinylCutter] All colors:', allColors.map(c => c.hex));

      // Build merged colors array:
      // - Enabled colors keep their original contour paths
      // - Disabled colors get merged into BLACK (their paths added to black's paths)
      const mergedColors = [];
      let blackColorEntry = null;

      // First, find or create the BLACK entry
      for (const color of allColors) {
        if (enabledColors.includes(color.hex)) {
          if (color.name === 'BLACK' || color.hex === '#000000') {
            // Clone the black entry so we can add merged paths
            blackColorEntry = {
              ...color,
              contourPath: color.contourPath,
              contourPaths: color.contourPaths ? [...color.contourPaths] : (color.contourPath ? [color.contourPath] : [])
            };
          } else {
            mergedColors.push(color);
          }
        }
      }

      // If no black in enabled colors, create one
      if (!blackColorEntry && enabledColors.length > 0) {
        // Use the first enabled color as the "base" color (instead of black)
        const firstEnabled = allColors.find(c => enabledColors.includes(c.hex));
        if (firstEnabled) {
          blackColorEntry = {
            ...firstEnabled,
            contourPaths: firstEnabled.contourPaths ? [...firstEnabled.contourPaths] : (firstEnabled.contourPath ? [firstEnabled.contourPath] : [])
          };
        }
      } else if (!blackColorEntry) {
        // No colors at all, create empty black
        blackColorEntry = { hex: '#000000', name: 'BLACK', contourPaths: [] };
      }

      // Merge disabled colors into black
      for (const color of allColors) {
        if (!enabledColors.includes(color.hex)) {
          // This color is disabled - merge its paths into black
          if (color.contourPaths && color.contourPaths.length > 0) {
            blackColorEntry.contourPaths.push(...color.contourPaths);
          } else if (color.contourPath) {
            blackColorEntry.contourPaths.push(color.contourPath);
          }
          console.log(`[VinylCutter] Merged ${color.name || color.hex} into ${blackColorEntry.name || blackColorEntry.hex}`);
        }
      }

      // Add black entry first (if it has paths)
      if (blackColorEntry && blackColorEntry.contourPaths.length > 0) {
        // Convert contourPaths array back to contourPath string for backward compatibility
        blackColorEntry.contourPath = blackColorEntry.contourPaths.join(' ');
        mergedColors.unshift(blackColorEntry);
      }

      console.log('[VinylCutter] Final merged colors:', mergedColors.map(c => `${c.name || c.hex}: ${c.contourPaths?.length || 1} paths`));

      return {
        imagePath: item.vinylData.imagePath,
        // Only send enabled colors (with disabled merged into black)
        colors: mergedColors,
        left: item.left,
        top: item.top,
        width: item.width * item.scaleX,
        height: item.height * item.scaleY,
        angle: item.angle || 0,
        scaleX: item.scaleX,
        scaleY: item.scaleY,
        // Original image dimensions (for scaling contour paths correctly)
        origWidth: item.vinylData.originalWidth || item.vinylData.width,
        origHeight: item.vinylData.originalHeight || item.vinylData.height
      };
    });

    const config = vinylCutterState.canvasConfig;
    const data = {
      items,
      canvasSize: {
        widthInches: config.widthInches,
        heightInches: config.heightInches,
        dpi: config.exportDpi
      },
      addWeedingLines: document.getElementById('vinylAddWeeding')?.checked || false,
      addRegistrationMarks: document.getElementById('vinylAddRegistration')?.checked || true
    };

    // Call server to generate files
    const result = await printStation.vinylCutter.generate(data);

    if (result && result.files) {
      vinylCutterState.generatedFiles = result.files;
      showVinylOutputPanel(result.files, result.batchName);
      vinylShowToast(`Generated ${result.files.length} cut file(s)`, 'success');
    }

  } catch (err) {
    console.error('[VinylCutter] Generation failed:', err);
    vinylShowToast('Failed to generate cut files: ' + err.message, 'error');
  } finally {
    updateVinylStatus('Ready');
    if (generateBtn) generateBtn.disabled = false;
  }
}

function showVinylOutputPanel(files, batchName) {
  const panel = document.getElementById('vinylOutputPanel');
  const filesEl = document.getElementById('vinylOutputFiles');

  if (!panel || !filesEl) return;

  panel.style.display = 'block';
  filesEl.innerHTML = files.map(file => `
    <div style="display:flex;align-items:center;gap:8px;padding:4px 6px;background:rgba(255,255,255,0.1);border-radius:4px;">
      <span style="flex:1;font-size:12px;">${file.name}</span>
      <button class="secondary" style="font-size:10px;padding:2px 8px;" onclick="previewVinylCutFile('${batchName}', '${file.name}')">Preview</button>
      <button class="primary" style="font-size:10px;padding:2px 8px;" onclick="sendVinylToSilhouette('${batchName}', '${file.name}')">Cut</button>
    </div>
  `).join('');
}

function previewVinylCutFile(batchName, fileName) {
  // Open preview modal or window
  const serverBase = (window.printStationConfig?.serverBaseUrl || 'https://blueridgecustomco.com').replace(/\/$/, '');
  const url = `${serverBase}/api/library/vinyl-cuts/${batchName}/${fileName}`;
  window.open(url, '_blank');
}

async function sendVinylToSilhouette(batchName, fileName) {
  vinylShowToast('Sending to Silhouette...', 'info');
  try {
    // Read cut settings from UI
    const cutSettings = {
      speed: parseInt(document.getElementById('vinylCutSpeed')?.value) || 3,
      pressure: parseInt(document.getElementById('vinylCutPressure')?.value) || 10,
      depth: parseInt(document.getElementById('vinylCutDepth')?.value) || 2,
      tool: document.getElementById('vinylCutTool')?.value || 'autoblade',
      xOffset: parseInt(document.getElementById('vinylCutXOffset')?.value) || 0,
      yOffset: parseInt(document.getElementById('vinylCutYOffset')?.value) || 0,
    };
    console.log('[VinylCutter] Sending with settings:', cutSettings);

    const result = await printStation.vinylCutter.sendToSilhouette({ batchName, fileName, cutSettings });
    if (result && result.success) {
      vinylShowToast('Sent to Silhouette successfully!', 'success');
    } else {
      throw new Error(result?.error || 'Unknown error');
    }
  } catch (err) {
    vinylShowToast('Failed to send: ' + err.message, 'error');
  }
}

// ============================================================================
// CONTOUR EDITING (Simplified version - reuse from sticker editor if needed)
// ============================================================================

function enterVinylContourEditMode() {
  const canvas = vinylCutterState.canvas;
  const activeObject = canvas?.getActiveObject();

  if (!activeObject || !activeObject.vinylData) {
    vinylShowToast('Select an item first', 'warning');
    return;
  }

  vinylCutterState.contourEditMode = true;
  vinylCutterState.editingItem = activeObject;

  // Show edit mode buttons
  document.getElementById('vinylEditContourBtn').style.display = 'none';
  document.getElementById('vinylDoneEditingBtn').style.display = 'inline-block';
  document.getElementById('vinylCircleContourBtn').style.display = 'inline-block';
  document.getElementById('vinylRoundedRectBtn').style.display = 'inline-block';
  document.getElementById('vinylSquareContourBtn').style.display = 'inline-block';
  document.getElementById('vinylSmoothContourBtn').style.display = 'inline-block';
  document.getElementById('vinylAddPointBtn').style.display = 'inline-block';
  document.getElementById('vinylRemovePointBtn').style.display = 'inline-block';

  vinylShowToast('Edit mode enabled', 'info');
}

function exitVinylContourEditMode(save = true) {
  vinylCutterState.contourEditMode = false;
  vinylCutterState.editingItem = null;

  // Hide edit mode buttons
  document.getElementById('vinylEditContourBtn').style.display = 'inline-block';
  document.getElementById('vinylDoneEditingBtn').style.display = 'none';
  document.getElementById('vinylCircleContourBtn').style.display = 'none';
  document.getElementById('vinylRoundedRectBtn').style.display = 'none';
  document.getElementById('vinylSquareContourBtn').style.display = 'none';
  document.getElementById('vinylSmoothContourBtn').style.display = 'none';
  document.getElementById('vinylAddPointBtn').style.display = 'none';
  document.getElementById('vinylRemovePointBtn').style.display = 'none';

  vinylCutterState.canvas?.renderAll();
  vinylShowToast('Edit mode exited', 'info');
}

function refreshVinylContour() {
  vinylShowToast('Refreshing contour...', 'info');
  // Re-fetch contour from server
  const activeObject = vinylCutterState.canvas?.getActiveObject();
  if (activeObject && activeObject.vinylData) {
    vectorizeVinylItem(activeObject.vinylData.imagePath).then(result => {
      if (result && result.contourPath) {
        // Remove old contour
        if (activeObject.contourPath) {
          vinylCutterState.canvas.remove(activeObject.contourPath);
        }
        // Create new contour
        const config = vinylCutterState.canvasConfig;
        const newContour = createVinylContour(
          result.contourPath,
          result.width,
          result.height,
          activeObject.vinylData.targetWidth,
          activeObject.vinylData.targetHeight,
          config.displayScale
        );
        if (newContour) {
          activeObject.contourPath = newContour;
          updateVinylContourPosition(activeObject);
          vinylCutterState.canvas.add(newContour);
          vinylCutterState.canvas.bringToFront(newContour);
          vinylCutterState.canvas.renderAll();
        }
        vinylShowToast('Contour refreshed', 'success');
      }
    }).catch(err => {
      vinylShowToast('Failed to refresh: ' + err.message, 'error');
    });
  }
}

// Shape contour functions (simplified)
function setVinylContourToCircle(segments = 16) {
  vinylShowToast('Circle contour applied', 'info');
  // Implementation would create elliptical contour matching item bounds
}

function setVinylContourToRoundedRect(radius = 20) {
  vinylShowToast('Rounded rectangle contour applied', 'info');
}

function resetVinylContourToDefault() {
  vinylShowToast('Square contour applied', 'info');
}

function smoothVinylContour() {
  vinylShowToast('Contour smoothed', 'info');
}

function addVinylContourPoint() {
  vinylShowToast('Point added', 'info');
}

function removeVinylContourPoint() {
  vinylShowToast('Point removed', 'info');
}

// ============================================================================
// VINYL CUTS BROWSER
// ============================================================================

// ---- Cut Files Manager State ----
let _cutBrowserState = {
  allBatches: [],
  filteredBatches: [],
  selectedBatches: new Set(),
  searchQuery: '',
  sortBy: 'newest',
  viewMode: 'grid',
  expandedPreview: null  // { batchName, fileName }
};

function _cutBrowserServerBase() {
  return (window.printStationConfig?.serverBaseUrl || 'https://blueridgecustomco.com').replace(/\/$/, '');
}

function _cutBrowserFormatDate(isoStr) {
  if (!isoStr) return 'Unknown date';
  try {
    const d = new Date(isoStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
      ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  } catch { return isoStr; }
}

function _cutBrowserFormatSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return size.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

function _cutBrowserExtractDate(batch) {
  if (batch.created) return new Date(batch.created).getTime();
  // Parse from batch name: cut-2026-04-13T19-55-31-655Z
  const m = batch.name.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`).getTime();
  return 0;
}

function _cutBrowserApplyFilters() {
  const s = _cutBrowserState;
  let result = [...s.allBatches];

  // Search filter
  if (s.searchQuery.trim()) {
    const q = s.searchQuery.toLowerCase();
    result = result.filter(b =>
      b.name.toLowerCase().includes(q) ||
      (b.colors || []).some(c => c.toLowerCase().includes(q))
    );
  }

  // Sort
  switch (s.sortBy) {
    case 'oldest':
      result.sort((a, b) => _cutBrowserExtractDate(a) - _cutBrowserExtractDate(b));
      break;
    case 'most-colors':
      result.sort((a, b) => (b.colors?.length || 0) - (a.colors?.length || 0));
      break;
    case 'largest':
      result.sort((a, b) => (b.totalSize || 0) - (a.totalSize || 0));
      break;
    case 'newest':
    default:
      result.sort((a, b) => _cutBrowserExtractDate(b) - _cutBrowserExtractDate(a));
      break;
  }

  s.filteredBatches = result;
}

async function openVinylCutsBrowser() {
  vinylShowToast('Loading cut files...', 'info');
  try {
    const batches = await printStation.vinylCutter.list();
    _cutBrowserState.allBatches = batches || [];
    _cutBrowserState.selectedBatches.clear();
    _cutBrowserState.searchQuery = '';
    _cutBrowserState.sortBy = 'newest';
    _cutBrowserState.expandedPreview = null;
    _cutBrowserApplyFilters();
    showVinylCutsBrowserModal();
  } catch (err) {
    vinylShowToast('Failed to load: ' + err.message, 'error');
  }
}

function _cutBrowserInjectStyles() {
  if (document.getElementById('cutBrowserStyles')) return;
  const style = document.createElement('style');
  style.id = 'cutBrowserStyles';
  style.textContent = `
    #vinylCutsBrowserModal {
      position: fixed; inset: 0; z-index: 9000;
      display: none; align-items: center; justify-content: center;
    }
    #vinylCutsBrowserModal .vcb-backdrop {
      position: absolute; inset: 0; background: rgba(0,0,0,0.7);
    }
    #vinylCutsBrowserModal .vcb-dialog {
      position: relative; z-index: 1;
      width: 95vw; height: 90vh;
      background: var(--bg-primary, #0f0f23);
      border: 1px solid var(--border, #333);
      border-radius: 12px;
      display: flex; flex-direction: column;
      overflow: hidden;
    }
    #vinylCutsBrowserModal .vcb-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 16px 20px; border-bottom: 1px solid var(--border, #333);
      flex-shrink: 0;
    }
    #vinylCutsBrowserModal .vcb-header h3 {
      margin: 0; font-size: 18px; color: var(--text, #eee);
    }
    #vinylCutsBrowserModal .vcb-header-right {
      display: flex; align-items: center; gap: 8px;
    }
    #vinylCutsBrowserModal .vcb-toolbar {
      display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
      padding: 12px 20px; border-bottom: 1px solid var(--border, #333);
      background: var(--bg-secondary, #1a1a2e); flex-shrink: 0;
    }
    #vinylCutsBrowserModal .vcb-search {
      flex: 1; min-width: 200px; padding: 8px 12px;
      background: var(--bg-primary, #0f0f23); color: var(--text, #eee);
      border: 1px solid var(--border, #333); border-radius: 6px;
      font-size: 13px; outline: none;
    }
    #vinylCutsBrowserModal .vcb-search:focus {
      border-color: #6366f1;
    }
    #vinylCutsBrowserModal .vcb-select {
      padding: 8px 10px; background: var(--bg-primary, #0f0f23);
      color: var(--text, #eee); border: 1px solid var(--border, #333);
      border-radius: 6px; font-size: 13px; cursor: pointer;
    }
    #vinylCutsBrowserModal .vcb-btn {
      padding: 7px 14px; border-radius: 6px; font-size: 12px;
      cursor: pointer; border: 1px solid var(--border, #333);
      background: var(--bg-secondary, #1a1a2e); color: var(--text, #eee);
      transition: background 0.15s;
    }
    #vinylCutsBrowserModal .vcb-btn:hover { background: rgba(255,255,255,0.1); }
    #vinylCutsBrowserModal .vcb-btn-primary {
      background: #6366f1; border-color: #6366f1; color: #fff;
    }
    #vinylCutsBrowserModal .vcb-btn-primary:hover { background: #5558e6; }
    #vinylCutsBrowserModal .vcb-btn-danger {
      color: #ef4444; border-color: rgba(239,68,68,0.3);
    }
    #vinylCutsBrowserModal .vcb-btn-danger:hover { background: rgba(239,68,68,0.15); }
    #vinylCutsBrowserModal .vcb-btn-sm {
      padding: 4px 10px; font-size: 11px;
    }
    #vinylCutsBrowserModal .vcb-body {
      flex: 1; overflow-y: auto; padding: 16px 20px;
    }
    #vinylCutsBrowserModal .vcb-stats {
      font-size: 12px; color: var(--text-muted, #888); white-space: nowrap;
    }
    #vinylCutsBrowserModal .vcb-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 14px;
    }
    #vinylCutsBrowserModal .vcb-card {
      background: var(--card, #1e1e3a);
      border: 1px solid var(--border, #333);
      border-radius: 10px; overflow: hidden;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    #vinylCutsBrowserModal .vcb-card:hover {
      border-color: #6366f1;
    }
    #vinylCutsBrowserModal .vcb-card.selected {
      border-color: #6366f1;
      box-shadow: 0 0 0 2px rgba(99,102,241,0.3);
    }
    #vinylCutsBrowserModal .vcb-card-header {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 12px; border-bottom: 1px solid var(--border, #333);
      background: rgba(255,255,255,0.03);
    }
    #vinylCutsBrowserModal .vcb-card-header input[type=checkbox] {
      accent-color: #6366f1; cursor: pointer;
    }
    #vinylCutsBrowserModal .vcb-card-title {
      flex: 1; font-size: 13px; font-weight: 600;
      color: var(--text, #eee); overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap;
    }
    #vinylCutsBrowserModal .vcb-card-date {
      font-size: 11px; color: var(--text-muted, #888); white-space: nowrap;
    }
    #vinylCutsBrowserModal .vcb-card-previews {
      display: flex; gap: 4px; padding: 10px 12px;
      overflow-x: auto; min-height: 80px; align-items: center;
      background: rgba(0,0,0,0.2);
    }
    #vinylCutsBrowserModal .vcb-thumb {
      width: 70px; height: 70px; flex-shrink: 0;
      border: 1px solid var(--border, #333); border-radius: 6px;
      background: #fff; cursor: pointer; overflow: hidden;
      display: flex; align-items: center; justify-content: center;
      transition: border-color 0.15s, transform 0.15s;
    }
    #vinylCutsBrowserModal .vcb-thumb:hover {
      border-color: #6366f1; transform: scale(1.05);
    }
    #vinylCutsBrowserModal .vcb-thumb img {
      width: 100%; height: 100%; object-fit: contain;
    }
    #vinylCutsBrowserModal .vcb-card-meta {
      display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
      padding: 8px 12px; font-size: 11px; color: var(--text-muted, #888);
    }
    #vinylCutsBrowserModal .vcb-color-dot {
      width: 14px; height: 14px; border-radius: 50%;
      border: 1px solid rgba(255,255,255,0.2); display: inline-block;
    }
    #vinylCutsBrowserModal .vcb-card-actions {
      display: flex; gap: 6px; padding: 8px 12px; flex-wrap: wrap;
      border-top: 1px solid var(--border, #333);
    }
    #vinylCutsBrowserModal .vcb-expanded-preview {
      margin: 0 12px 12px; border: 1px solid var(--border, #333);
      border-radius: 8px; background: #fff; overflow: hidden;
      max-height: 400px; position: relative;
    }
    #vinylCutsBrowserModal .vcb-expanded-preview img {
      width: 100%; height: auto; display: block; max-height: 380px;
      object-fit: contain;
    }
    #vinylCutsBrowserModal .vcb-expanded-preview .vcb-preview-toolbar {
      position: absolute; top: 8px; right: 8px;
      display: flex; gap: 4px;
    }
    #vinylCutsBrowserModal .vcb-badge {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 2px 8px; border-radius: 10px;
      background: rgba(255,255,255,0.08); font-size: 11px;
    }
    #vinylCutsBrowserModal .vcb-empty {
      text-align: center; padding: 60px 20px;
      color: var(--text-muted, #888);
    }
    #vinylCutsBrowserModal .vcb-empty svg {
      width: 48px; height: 48px; margin-bottom: 12px; opacity: 0.4;
    }
    #vinylCutsBrowserModal .vcb-close-btn {
      background: none; border: none; color: var(--text-muted, #888);
      font-size: 24px; cursor: pointer; padding: 0 4px; line-height: 1;
    }
    #vinylCutsBrowserModal .vcb-close-btn:hover { color: var(--text, #eee); }
    #vinylCutsBrowserModal .vcb-view-toggle {
      display: flex; border: 1px solid var(--border, #333); border-radius: 6px; overflow: hidden;
    }
    #vinylCutsBrowserModal .vcb-view-toggle button {
      padding: 6px 10px; background: none; border: none; color: var(--text-muted, #888);
      cursor: pointer; font-size: 13px;
    }
    #vinylCutsBrowserModal .vcb-view-toggle button.active {
      background: rgba(99,102,241,0.2); color: #6366f1;
    }
    #vinylCutsBrowserModal .vcb-list .vcb-card {
      display: grid;
      grid-template-columns: auto 1fr auto;
      grid-template-rows: auto;
      align-items: center;
    }
    #vinylCutsBrowserModal .vcb-list .vcb-card-header {
      border-bottom: none; padding: 10px 12px;
    }
    #vinylCutsBrowserModal .vcb-list .vcb-card-previews {
      min-height: 50px; padding: 6px 8px;
      border-bottom: none; background: transparent;
    }
    #vinylCutsBrowserModal .vcb-list .vcb-thumb {
      width: 44px; height: 44px;
    }
    #vinylCutsBrowserModal .vcb-select-all-wrap {
      display: flex; align-items: center; gap: 6px; font-size: 12px;
      color: var(--text-muted, #888);
    }
    #vinylCutsBrowserModal .vcb-select-all-wrap input { accent-color: #6366f1; cursor: pointer; }
    @media (max-width: 700px) {
      #vinylCutsBrowserModal .vcb-grid {
        grid-template-columns: 1fr;
      }
    }
  `;
  document.head.appendChild(style);
}

function showVinylCutsBrowserModal() {
  _cutBrowserInjectStyles();

  let modal = document.getElementById('vinylCutsBrowserModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'vinylCutsBrowserModal';
    modal.innerHTML = `
      <div class="vcb-backdrop" onclick="closeVinylCutsBrowser()"></div>
      <div class="vcb-dialog">
        <div class="vcb-header">
          <h3>Cut Files Manager</h3>
          <div class="vcb-header-right">
            <span class="vcb-stats" id="vcbStatsText"></span>
            <button class="vcb-close-btn" onclick="closeVinylCutsBrowser()" title="Close">&times;</button>
          </div>
        </div>
        <div class="vcb-toolbar" id="vcbToolbar">
          <input type="text" class="vcb-search" id="vcbSearch" placeholder="Search batches..." />
          <select class="vcb-select" id="vcbSort">
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="most-colors">Most colors</option>
            <option value="largest">Largest size</option>
          </select>
          <div class="vcb-view-toggle">
            <button id="vcbViewGrid" class="active" title="Grid view" onclick="cutBrowserSetView('grid')">&#9638;</button>
            <button id="vcbViewList" title="List view" onclick="cutBrowserSetView('list')">&#9776;</button>
          </div>
          <div class="vcb-select-all-wrap">
            <input type="checkbox" id="vcbSelectAll" onchange="cutBrowserToggleSelectAll(this.checked)" />
            <label for="vcbSelectAll">Select all</label>
          </div>
          <button class="vcb-btn vcb-btn-danger vcb-btn-sm" id="vcbBulkDeleteBtn" style="display:none;" onclick="cutBrowserBulkDelete()">
            Delete selected (<span id="vcbSelectedCount">0</span>)
          </button>
        </div>
        <div class="vcb-body" id="vcbBody"></div>
      </div>
    `;
    document.body.appendChild(modal);

    // Wire up search
    document.getElementById('vcbSearch').addEventListener('input', (e) => {
      _cutBrowserState.searchQuery = e.target.value;
      _cutBrowserApplyFilters();
      _cutBrowserRenderCards();
    });

    // Wire up sort
    document.getElementById('vcbSort').addEventListener('change', (e) => {
      _cutBrowserState.sortBy = e.target.value;
      _cutBrowserApplyFilters();
      _cutBrowserRenderCards();
    });
  }

  modal.style.display = 'flex';
  _cutBrowserRenderCards();
}

function _cutBrowserRenderCards() {
  const s = _cutBrowserState;
  const body = document.getElementById('vcbBody');
  const statsEl = document.getElementById('vcbStatsText');
  const bulkBtn = document.getElementById('vcbBulkDeleteBtn');
  const countEl = document.getElementById('vcbSelectedCount');

  // Update stats
  const totalColors = s.allBatches.reduce((sum, b) => sum + (b.colors?.length || 0), 0);
  const totalSize = s.allBatches.reduce((sum, b) => sum + (b.totalSize || 0), 0);
  statsEl.textContent = `${s.allBatches.length} batches | ${totalColors} colors | ${_cutBrowserFormatSize(totalSize)}`;

  // Update bulk button
  if (s.selectedBatches.size > 0) {
    bulkBtn.style.display = '';
    countEl.textContent = s.selectedBatches.size;
  } else {
    bulkBtn.style.display = 'none';
  }

  // Update select-all checkbox
  const selAllCb = document.getElementById('vcbSelectAll');
  if (selAllCb) {
    selAllCb.checked = s.filteredBatches.length > 0 && s.filteredBatches.every(b => s.selectedBatches.has(b.name));
    selAllCb.indeterminate = s.selectedBatches.size > 0 && !selAllCb.checked;
  }

  if (s.filteredBatches.length === 0) {
    body.innerHTML = `
      <div class="vcb-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>
        </svg>
        <div style="font-size:16px;margin-bottom:4px;">${s.searchQuery ? 'No batches match your search' : 'No cut files generated yet'}</div>
        <div style="font-size:13px;">Generate cut files from the vinyl editor to see them here.</div>
      </div>`;
    return;
  }

  const isGrid = s.viewMode === 'grid';
  const serverBase = _cutBrowserServerBase();

  const cardsHtml = s.filteredBatches.map(batch => {
    const isSelected = s.selectedBatches.has(batch.name);
    const dateStr = _cutBrowserFormatDate(batch.created || batch.name.replace(/^(cut|driver-names)-/, '').replace(/T/, 'T').replace(/-(\d{2})-(\d{2})-(\d{2,3})Z$/, ':$1:$2'));
    const colorCount = batch.colors?.length || 0;
    const escapedName = batch.name.replace(/'/g, "\\'");

    // SVG thumbnail previews
    const thumbsHtml = (batch.files || []).map(f => {
      const url = `${serverBase}/api/library/vinyl-cuts/${batch.name}/${f}`;
      const escapedFile = f.replace(/'/g, "\\'");
      return `<div class="vcb-thumb" onclick="cutBrowserTogglePreview('${escapedName}','${escapedFile}')" title="${f}">
        <img src="${url}" alt="${f}" loading="lazy" />
      </div>`;
    }).join('');

    // Color swatches
    const swatchesHtml = (batch.colors || []).map(c =>
      `<span class="vcb-color-dot" style="background:${c}" title="${c}"></span>`
    ).join('');

    // Expanded preview
    let expandedHtml = '';
    if (s.expandedPreview && s.expandedPreview.batchName === batch.name) {
      const pUrl = `${serverBase}/api/library/vinyl-cuts/${batch.name}/${s.expandedPreview.fileName}`;
      const pEscFile = s.expandedPreview.fileName.replace(/'/g, "\\'");
      expandedHtml = `
        <div class="vcb-expanded-preview">
          <div class="vcb-preview-toolbar">
            <button class="vcb-btn vcb-btn-sm" onclick="cutBrowserDownloadFile('${escapedName}','${pEscFile}')" title="Download">&#11015; Download</button>
            <button class="vcb-btn vcb-btn-primary vcb-btn-sm" onclick="sendVinylToSilhouette('${escapedName}','${pEscFile}')" title="Send to cutter">&#9986; Cut</button>
            <button class="vcb-btn vcb-btn-sm" onclick="cutBrowserClosePreview()" title="Close preview">&times;</button>
          </div>
          <img src="${pUrl}" alt="Preview" />
          <div style="padding:6px 10px;background:rgba(0,0,0,0.05);font-size:11px;color:#555;">
            ${s.expandedPreview.fileName}
            ${batch.fileSizes?.[s.expandedPreview.fileName] ? ' | ' + _cutBrowserFormatSize(batch.fileSizes[s.expandedPreview.fileName]) : ''}
          </div>
        </div>`;
    }

    // File action buttons for each SVG
    const fileActionsHtml = (batch.files || []).map(f => {
      const ef = f.replace(/'/g, "\\'");
      const colorHex = f.replace(/^cut_/, '').replace(/\.svg$/, '');
      const sizeStr = batch.fileSizes?.[f] ? _cutBrowserFormatSize(batch.fileSizes[f]) : '';
      return `<div style="display:inline-flex;align-items:center;gap:4px;background:rgba(255,255,255,0.05);padding:3px 8px;border-radius:4px;font-size:11px;">
        <span class="vcb-color-dot" style="width:10px;height:10px;background:#${colorHex};"></span>
        <span style="color:var(--text-muted,#888);">${f}</span>
        ${sizeStr ? `<span style="color:var(--text-muted,#666);font-size:10px;">(${sizeStr})</span>` : ''}
        <button class="vcb-btn vcb-btn-sm" onclick="cutBrowserTogglePreview('${escapedName}','${ef}')" title="Preview">&#128065;</button>
        <button class="vcb-btn vcb-btn-sm" onclick="cutBrowserDownloadFile('${escapedName}','${ef}')" title="Download">&#11015;</button>
        <button class="vcb-btn vcb-btn-primary vcb-btn-sm" onclick="sendVinylToSilhouette('${escapedName}','${ef}')" title="Cut">&#9986;</button>
      </div>`;
    }).join('');

    return `
    <div class="vcb-card ${isSelected ? 'selected' : ''}" data-batch="${batch.name}">
      <div class="vcb-card-header">
        <input type="checkbox" ${isSelected ? 'checked' : ''} onchange="cutBrowserToggleSelect('${escapedName}', this.checked)" />
        <div class="vcb-card-title" title="${batch.name}">${batch.name}</div>
        <div class="vcb-card-date">${dateStr}</div>
      </div>
      <div class="vcb-card-previews">${thumbsHtml || '<span style="color:var(--text-muted,#888);font-size:12px;">No SVG files</span>'}</div>
      ${expandedHtml}
      <div class="vcb-card-meta">
        <span class="vcb-badge">${colorCount} color${colorCount !== 1 ? 's' : ''}</span>
        <span class="vcb-badge">${batch.itemCount || '?'} item${(batch.itemCount || 0) !== 1 ? 's' : ''}</span>
        <span class="vcb-badge">${_cutBrowserFormatSize(batch.totalSize || 0)}</span>
        <span style="display:flex;gap:2px;align-items:center;">${swatchesHtml}</span>
      </div>
      <div class="vcb-card-actions" style="flex-wrap:wrap;">
        ${fileActionsHtml}
      </div>
      <div class="vcb-card-actions">
        <button class="vcb-btn vcb-btn-danger vcb-btn-sm" onclick="deleteVinylCutBatch('${escapedName}')">Delete batch</button>
      </div>
    </div>`;
  }).join('');

  body.innerHTML = `<div class="${isGrid ? 'vcb-grid' : 'vcb-list'}">${cardsHtml}</div>`;
}

function cutBrowserSetView(mode) {
  _cutBrowserState.viewMode = mode;
  document.getElementById('vcbViewGrid').classList.toggle('active', mode === 'grid');
  document.getElementById('vcbViewList').classList.toggle('active', mode === 'list');
  _cutBrowserRenderCards();
}

function cutBrowserToggleSelect(batchName, checked) {
  if (checked) {
    _cutBrowserState.selectedBatches.add(batchName);
  } else {
    _cutBrowserState.selectedBatches.delete(batchName);
  }
  _cutBrowserRenderCards();
}

function cutBrowserToggleSelectAll(checked) {
  const s = _cutBrowserState;
  if (checked) {
    s.filteredBatches.forEach(b => s.selectedBatches.add(b.name));
  } else {
    s.selectedBatches.clear();
  }
  _cutBrowserRenderCards();
}

function cutBrowserTogglePreview(batchName, fileName) {
  const s = _cutBrowserState;
  if (s.expandedPreview && s.expandedPreview.batchName === batchName && s.expandedPreview.fileName === fileName) {
    s.expandedPreview = null;
  } else {
    s.expandedPreview = { batchName, fileName };
  }
  _cutBrowserRenderCards();
}

function cutBrowserClosePreview() {
  _cutBrowserState.expandedPreview = null;
  _cutBrowserRenderCards();
}

function cutBrowserDownloadFile(batchName, fileName) {
  const url = `${_cutBrowserServerBase()}/api/library/vinyl-cuts/${batchName}/${fileName}`;
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.target = '_blank';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

async function cutBrowserBulkDelete() {
  const count = _cutBrowserState.selectedBatches.size;
  if (count === 0) return;
  if (!confirm(`Delete ${count} selected batch${count > 1 ? 'es' : ''}? This cannot be undone.`)) return;

  const toDelete = [..._cutBrowserState.selectedBatches];
  let deleted = 0, failed = 0;
  for (const batchName of toDelete) {
    try {
      await printStation.vinylCutter.delete(batchName);
      deleted++;
    } catch (err) {
      console.error('[CutBrowser] Failed to delete:', batchName, err);
      failed++;
    }
  }
  _cutBrowserState.selectedBatches.clear();
  vinylShowToast(`Deleted ${deleted} batch${deleted !== 1 ? 'es' : ''}${failed > 0 ? `, ${failed} failed` : ''}`, failed > 0 ? 'warning' : 'success');
  // Refresh
  try {
    const batches = await printStation.vinylCutter.list();
    _cutBrowserState.allBatches = batches || [];
    _cutBrowserApplyFilters();
    _cutBrowserRenderCards();
  } catch (err) {
    vinylShowToast('Failed to refresh: ' + err.message, 'error');
  }
}

function closeVinylCutsBrowser() {
  const modal = document.getElementById('vinylCutsBrowserModal');
  if (modal) {
    modal.style.display = 'none';
  }
}

async function deleteVinylCutBatch(batchName) {
  if (!confirm(`Delete batch "${batchName}"? This cannot be undone.`)) return;

  try {
    await printStation.vinylCutter.delete(batchName);
    vinylShowToast('Batch deleted', 'success');
    // Remove from state and re-render without full reload
    _cutBrowserState.allBatches = _cutBrowserState.allBatches.filter(b => b.name !== batchName);
    _cutBrowserState.selectedBatches.delete(batchName);
    if (_cutBrowserState.expandedPreview?.batchName === batchName) {
      _cutBrowserState.expandedPreview = null;
    }
    _cutBrowserApplyFilters();
    _cutBrowserRenderCards();
  } catch (err) {
    vinylShowToast('Failed to delete: ' + err.message, 'error');
  }
}

// ============================================================================
// STUDIO3 IMPORT FUNCTIONS
// ============================================================================

/**
 * Import .studio3 files into the vinyl cutter canvas
 * Uses the studio3 parser to extract images and cut paths
 * Also uploads to server for contour training
 */
async function importStudio3Files() {
  if (!window.printStation?.studio3) {
    vinylShowToast('Studio3 import not available', 'error');
    return;
  }

  try {
    // Open file browser for .studio3 files
    const browseResult = await window.printStation.studio3.browse();
    if (!browseResult.success || browseResult.canceled) {
      return; // User canceled
    }

    const files = browseResult.files;
    if (!files || files.length === 0) {
      vinylShowToast('No files selected', 'warning');
      return;
    }

    // Ask user to classify these files as sticker or decal
    const importType = await new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:10000;display:flex;align-items:center;justify-content:center;';
      overlay.innerHTML = `
        <div style="background:var(--bg-secondary,#1a1a2e);border:1px solid var(--border,#333);border-radius:12px;padding:28px;max-width:400px;width:90%;text-align:center;">
          <h3 style="margin:0 0 8px;color:var(--text,#eee);">Import Type</h3>
          <p style="margin:0 0 20px;color:var(--text-muted,#888);font-size:14px;">How should these ${files.length} file(s) be classified for contour training?</p>
          <div style="display:flex;gap:12px;justify-content:center;">
            <button id="s3TypeSticker" style="flex:1;padding:14px 12px;border-radius:8px;border:2px solid #27ae60;background:rgba(39,174,96,0.1);color:#27ae60;cursor:pointer;font-size:14px;font-weight:600;">
              Sticker<br><small style="opacity:0.7;font-weight:400;">Print & cut contours</small>
            </button>
            <button id="s3TypeDecal" style="flex:1;padding:14px 12px;border-radius:8px;border:2px solid #e74c3c;background:rgba(231,76,60,0.1);color:#e74c3c;cursor:pointer;font-size:14px;font-weight:600;">
              Decal<br><small style="opacity:0.7;font-weight:400;">Vector color cuts</small>
            </button>
          </div>
          <button id="s3TypeCancel" style="margin-top:14px;width:100%;padding:8px;border-radius:6px;border:1px solid var(--border,#444);background:transparent;color:var(--text-muted,#888);cursor:pointer;font-size:13px;">Cancel</button>
        </div>
      `;
      document.body.appendChild(overlay);
      overlay.querySelector('#s3TypeSticker').onclick = () => { overlay.remove(); resolve('sticker'); };
      overlay.querySelector('#s3TypeDecal').onclick = () => { overlay.remove(); resolve('decal'); };
      overlay.querySelector('#s3TypeCancel').onclick = () => { overlay.remove(); resolve(null); };
    });

    if (!importType) return; // User canceled

    vinylShowToast(`Parsing ${files.length} Studio3 file(s)...`, 'info');
    updateVinylStatus('Parsing Studio3 files...');

    // Parse all selected files
    let successCount = 0;
    let errorCount = 0;
    let uploadedCount = 0;

    for (const filepath of files) {
      try {
        const result = await window.printStation.studio3.parse(filepath);

        if (!result.success) {
          console.error('[Studio3 Import] Parse failed:', filepath, result.error);
          errorCount++;
          continue;
        }

        // Upload to server for contour training (in background)
        uploadStudio3ToServer(result, filepath, importType).then(uploaded => {
          if (uploaded) uploadedCount++;
        }).catch(err => {
          console.warn('[Studio3 Import] Server upload failed:', err.message);
        });

        // Add each image from the studio3 file to canvas
        for (const image of result.images) {
          await addStudio3ItemToCanvas({
            filepath,
            imageIndex: image.index,
            base64: image.base64,
            paths: result.paths,
            metadata: result.metadata,
            svg: result.svg
          });
          successCount++;
        }
      } catch (err) {
        console.error('[Studio3 Import] Error processing file:', filepath, err);
        errorCount++;
      }
    }

    updateVinylStatus('Ready');
    updateVinylItemsList();
    updateVinylItemCount();
    updateVinylColorLayers();
    updateVinylControls();

    if (successCount > 0) {
      vinylShowToast(`Imported ${successCount} design(s) from Studio3 files`, 'success');
    }
    if (errorCount > 0) {
      vinylShowToast(`${errorCount} file(s) failed to import`, 'warning');
    }

  } catch (err) {
    console.error('[Studio3 Import] Error:', err);
    vinylShowToast('Failed to import Studio3 files: ' + err.message, 'error');
    updateVinylStatus('Import failed');
  }
}

/**
 * Upload parsed Studio3 data to server for contour training
 * @param {Object} result - Parsed studio3 data {images, paths, metadata, svg}
 * @param {string} filepath - Original file path
 * @returns {Promise<boolean>} Success status
 */
async function uploadStudio3ToServer(result, filepath, type = 'sticker') {
  // Get config from preload API
  const config = await window.printStation?.getConfig() || {};
  const serverBase = (config.serverBaseUrl?.trim() || 'https://blueridgecustomco.com').replace(/\/$/, '');
  const apiKey = config.apiKey || '';

  // Extract filename from path
  const filename = filepath.split(/[/\\]/).pop();

  // Create thumbnail from first image (base64, small)
  let thumbnail = null;
  if (result.images && result.images.length > 0 && result.images[0].base64) {
    // Use first 1000 chars of base64 as thumbnail preview (or full if small)
    const base64 = result.images[0].base64;
    thumbnail = base64.length > 50000 ? base64.substring(0, 50000) + '...' : base64;
  }

  const payload = {
    filename,
    metadata: result.metadata || {},
    paths: result.paths || [],
    pathCount: result.paths?.length || 0,
    imageCount: result.images?.length || 0,
    thumbnail,
    type
  };

  console.log('[Studio3 Upload] Sending to server:', filename, 'paths:', payload.pathCount, 'images:', payload.imageCount);

  try {
    const response = await fetch(`${serverBase}/api/studio3/catalog`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (data.success) {
      console.log('[Studio3 Upload] Success:', filename, 'ID:', data.id);
      return true;
    } else {
      console.warn('[Studio3 Upload] Failed:', filename, data.error);
      return false;
    }
  } catch (err) {
    console.error('[Studio3 Upload] Error:', err.message);
    return false;
  }
}

/**
 * Trigger contour model training on the server
 * Uses all uploaded Studio3 files to learn contour style preferences
 */
async function trainContourModel() {
  const config = await window.printStation?.getConfig() || {};
  const serverBase = (config.serverBaseUrl?.trim() || 'https://blueridgecustomco.com').replace(/\/$/, '');
  const apiKey = config.apiKey || '';

  vinylShowToast('Training contour AI model...', 'info');
  updateVinylStatus('Training contour model...');

  try {
    const response = await fetch(`${serverBase}/api/contour/train`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey
      }
    });

    const data = await response.json();

    if (data.success) {
      const profile = data.profile;
      vinylShowToast(`Contour AI trained on ${data.sampleCount} files!`, 'success');
      console.log('[Contour Training] Success:', {
        sampleCount: data.sampleCount,
        cornerSharpness: profile?.cornerSharpness?.toFixed(2),
        detailLevel: profile?.detailLevel?.toFixed(3),
        smoothness: profile?.smoothness?.toFixed(2)
      });

      if (data.errors && data.errors.length > 0) {
        console.warn('[Contour Training] Some files had errors:', data.errors);
      }
    } else {
      vinylShowToast('Training failed: ' + (data.error || 'Unknown error'), 'error');
      console.error('[Contour Training] Failed:', data.error);
    }
  } catch (err) {
    console.error('[Contour Training] Error:', err);
    vinylShowToast('Training failed: ' + err.message, 'error');
  }

  updateVinylStatus('Ready');
}

/**
 * Load Studio3 catalog from server and display in a browsable list
 * These are the uploaded Studio3 files that can be used for production
 */
async function loadStudio3Catalog() {
  // Get config from preload API
  const config = await window.printStation?.getConfig() || {};
  const serverBase = (config.serverBaseUrl?.trim() || 'https://blueridgecustomco.com').replace(/\/$/, '');
  const apiKey = config.apiKey || '';

  try {
    const response = await fetch(`${serverBase}/api/studio3/catalog`, {
      headers: {
        'x-api-key': apiKey
      }
    });

    const data = await response.json();

    if (data.success) {
      console.log('[Studio3 Catalog] Loaded', data.count, 'items');
      return data.entries || [];
    } else {
      console.error('[Studio3 Catalog] Failed:', data.error);
      return [];
    }
  } catch (err) {
    console.error('[Studio3 Catalog] Error:', err);
    return [];
  }
}

/**
 * Get a specific Studio3 item with full data (including paths) from server
 */
async function getStudio3Item(id) {
  // Get config from preload API
  const config = await window.printStation?.getConfig() || {};
  const serverBase = (config.serverBaseUrl?.trim() || 'https://blueridgecustomco.com').replace(/\/$/, '');
  const apiKey = config.apiKey || '';

  try {
    const response = await fetch(`${serverBase}/api/studio3/catalog/${encodeURIComponent(id)}`, {
      headers: {
        'x-api-key': apiKey
      }
    });

    const data = await response.json();

    if (data.success) {
      return data.entry;
    } else {
      console.error('[Studio3 Item] Failed:', data.error);
      return null;
    }
  } catch (err) {
    console.error('[Studio3 Item] Error:', err);
    return null;
  }
}

/**
 * Add a Studio3 item to the vinyl canvas
 * Uses the extracted image and cut paths directly (no vectorization needed)
 */
async function addStudio3ItemToCanvas(studio3Data) {
  const { filepath, imageIndex, base64, paths, metadata, svg } = studio3Data;

  if (!vinylCutterState.canvas) {
    initVinylCutterEditor();
  }

  const canvas = vinylCutterState.canvas;
  const config = vinylCutterState.canvasConfig;
  const scale = config.displayScale;

  // Create image from base64
  const imageUrl = 'data:image/png;base64,' + base64;

  console.log('[Studio3 Import] Adding item from:', filepath, 'Image index:', imageIndex);

  try {
    // Load image
    const img = await loadVinylImage(imageUrl);

    // Default size: 4 inches for vinyl
    const targetSizeInches = 4;
    const targetSizePx = targetSizeInches * config.dpi;

    // Calculate scaled dimensions
    const aspectRatio = img.width / img.height;
    let itemWidth, itemHeight;

    if (aspectRatio > 1) {
      itemWidth = targetSizePx;
      itemHeight = targetSizePx / aspectRatio;
    } else {
      itemHeight = targetSizePx;
      itemWidth = targetSizePx * aspectRatio;
    }

    // Create Fabric image
    const fabricImg = new fabric.Image(img, {
      left: config.marginPx * scale + 50 + (vinylCutterState.items.length * 30),
      top: config.marginPx * scale + 50 + (vinylCutterState.items.length * 30),
      scaleX: (itemWidth * scale) / img.width,
      scaleY: (itemHeight * scale) / img.height,
      hasControls: true,
      hasBorders: true,
      lockUniScaling: false,
      cornerStyle: 'circle',
      cornerColor: '#8b5cf6', // Purple for Studio3 imports
      cornerStrokeColor: '#8b5cf6',
      borderColor: '#8b5cf6',
      transparentCorners: false,
      centeredRotation: true
    });

    // Extract filename for title
    const filename = filepath.split(/[/\\]/).pop().replace('.studio3', '');

    // Store vinyl data with Studio3 source info
    fabricImg.vinylData = {
      id: `studio3_${Date.now()}_${imageIndex}`,
      title: `${filename}${imageIndex > 0 ? ` (${imageIndex + 1})` : ''}`,
      imagePath: null, // No server path - embedded image
      thumbnailUrl: imageUrl,
      imageUrl: imageUrl,
      originalWidth: img.width,
      originalHeight: img.height,
      targetWidth: itemWidth,
      targetHeight: itemHeight,
      colors: [],
      // Studio3 specific data
      studio3Source: {
        filepath,
        imageIndex,
        metadata,
        hasPrebuiltPaths: paths && paths.length > 0
      }
    };

    // Use pre-built cut paths from Studio3 if available
    fabricImg.colorContours = [];

    if (paths && paths.length > 0) {
      console.log('[Studio3 Import] Using pre-built cut paths:', paths.length, 'paths');

      // Convert Studio3 paths to SVG path string
      for (let pathIdx = 0; pathIdx < paths.length; pathIdx++) {
        const pathPoints = paths[pathIdx];
        if (pathPoints.length < 2) continue;

        // Build SVG path string
        let svgPath = `M ${pathPoints[0].x},${pathPoints[0].y}`;
        for (let i = 1; i < pathPoints.length; i++) {
          svgPath += ` L ${pathPoints[i].x},${pathPoints[i].y}`;
        }
        svgPath += ' Z';

        // Calculate path bounds for scaling
        const xs = pathPoints.map(p => p.x);
        const ys = pathPoints.map(p => p.y);
        const pathWidth = Math.max(...xs) - Math.min(...xs);
        const pathHeight = Math.max(...ys) - Math.min(...ys);

        // Create contour
        const contour = createVinylContour(
          svgPath,
          pathWidth || img.width,
          pathHeight || img.height,
          itemWidth,
          itemHeight,
          scale,
          pathIdx === 0 ? '#ef4444' : '#f97316' // Red for first path, orange for others
        );

        contour.colorHex = pathIdx === 0 ? '#000000' : `#path${pathIdx}`;
        fabricImg.colorContours.push(contour);

        // Position contour to match image
        contour.set({
          left: fabricImg.left,
          top: fabricImg.top,
          originX: 'center',
          originY: 'center'
        });

        canvas.add(contour);
      }

      // Store path info as "colors" for UI display
      fabricImg.vinylData.colors = paths.map((p, idx) => ({
        hex: idx === 0 ? '#000000' : `#path${idx}`,
        name: `Cut Path ${idx + 1}`,
        contourPath: null, // SVG stored in contour object
        count: p.length,
        percentage: 100 / paths.length
      }));

    } else {
      console.log('[Studio3 Import] No pre-built paths, creating fallback contour');
      // Create fallback rectangular contour
      const fallbackContour = createFallbackVinylContour(itemWidth, itemHeight, scale);
      fallbackContour.set({
        left: fabricImg.left,
        top: fabricImg.top,
        originX: 'center',
        originY: 'center'
      });
      canvas.add(fallbackContour);
      fabricImg.contour = fallbackContour;
    }

    // Add image to canvas
    canvas.add(fabricImg);
    vinylCutterState.items.push(fabricImg);
    canvas.setActiveObject(fabricImg);
    canvas.requestRenderAll();

    console.log('[Studio3 Import] Successfully added:', fabricImg.vinylData.title);
    return true;

  } catch (err) {
    console.error('[Studio3 Import] Failed to add item:', err);
    throw err;
  }
}

// ============================================================================
// CRICUT SCREENSHOT IMPORT
// ============================================================================

/**
 * Import screenshots from Cricut Design Space (or any image).
 * Opens file picker, asks for dimensions, AI vectorizes, adds to canvas.
 */
async function importScreenshot() {
  if (!window.printStation?.vinylCutter?.importScreenshot) {
    vinylShowToast('Screenshot import not available', 'error');
    return;
  }

  try {
    updateVinylStatus('Selecting screenshots...');
    const result = await window.printStation.vinylCutter.importScreenshot();

    if (result.canceled) {
      updateVinylStatus('Ready');
      return;
    }

    if (!result.success) {
      vinylShowToast(`Import failed: ${result.error || 'Unknown error'}`, 'error');
      console.error('[Screenshot Import] IPC error:', JSON.stringify(result));
      updateVinylStatus('Ready');
      return;
    }

    if (!result.imported || result.imported.length === 0) {
      const errMsg = result.error || result.errors || 'Unknown error';
      vinylShowToast(`Failed to upload: ${errMsg}`, 'error');
      console.error('[Screenshot Import] IPC result:', JSON.stringify(result));
      updateVinylStatus('Ready');
      return;
    }

    // Ask for dimensions
    const dimensions = await showScreenshotDimensionsModal(result.imported);
    if (!dimensions) {
      updateVinylStatus('Ready');
      return; // Canceled
    }

    // Add each imported screenshot to canvas with AI vectorization
    let added = 0;
    for (const item of result.imported) {
      try {
        updateVinylStatus(`Vectorizing ${item.filename}...`);
        await addItemToVinylCanvas({
          title: item.filename,
          imagePath: item.serverPath,
          _importWidthInches: dimensions.widthInches,
          _importHeightInches: dimensions.heightInches,
          _isScreenshotImport: true
        });
        added++;
      } catch (err) {
        console.error('[Screenshot Import] Failed to add:', item.filename, err);
        vinylShowToast(`Failed to add ${item.filename}: ${err.message}`, 'error');
      }
    }

    if (added > 0) {
      vinylShowToast(`Imported ${added} screenshot${added === 1 ? '' : 's'} to vinyl cutter`, 'success');
    }
    updateVinylStatus('Ready');
  } catch (err) {
    console.error('[Screenshot Import Error]', err);
    vinylShowToast('Import failed: ' + err.message, 'error');
    updateVinylStatus('Ready');
  }
}

/**
 * Show a modal asking the user for the physical dimensions of the imported screenshot(s)
 */
function showScreenshotDimensionsModal(imported) {
  return new Promise((resolve) => {
    const fileList = imported.map(i => i.filename).join(', ');
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:10000;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
      <div style="background:var(--bg-secondary,#1a1a2e);border:1px solid var(--border,#333);border-radius:12px;padding:28px;max-width:440px;width:90%;">
        <h3 style="margin:0 0 8px;color:var(--text,#eee);">Screenshot Dimensions</h3>
        <p style="margin:0 0 6px;color:var(--text-muted,#888);font-size:13px;">Importing: ${imported.length} file${imported.length > 1 ? 's' : ''}</p>
        <p style="margin:0 0 18px;color:var(--text-muted,#888);font-size:12px;">Enter the actual physical size of the design as it was in Cricut (or desired cut size).</p>
        <div style="display:flex;gap:16px;margin-bottom:18px;">
          <label style="flex:1;font-size:13px;color:var(--text,#eee);">
            <span>Width (inches)</span>
            <input type="number" id="ssImportWidth" value="4" min="0.5" max="24" step="0.25" style="width:100%;margin-top:4px;padding:8px;border-radius:6px;border:1px solid var(--border,#444);background:var(--bg-primary,#111);color:var(--text,#eee);font-size:14px;" />
          </label>
          <label style="flex:1;font-size:13px;color:var(--text,#eee);">
            <span>Height (inches)</span>
            <input type="number" id="ssImportHeight" value="4" min="0.5" max="24" step="0.25" style="width:100%;margin-top:4px;padding:8px;border-radius:6px;border:1px solid var(--border,#444);background:var(--bg-primary,#111);color:var(--text,#eee);font-size:14px;" />
          </label>
        </div>
        <p style="margin:0 0 12px;color:#f59e0b;font-size:11px;">Tip: If you only know one dimension, set it and leave the other — aspect ratio will be preserved from the image.</p>
        <div style="display:flex;gap:12px;">
          <button id="ssImportOk" style="flex:1;padding:10px;border-radius:6px;border:none;background:#3b82f6;color:white;cursor:pointer;font-size:14px;font-weight:600;">Import & Vectorize</button>
          <button id="ssImportCancel" style="padding:10px 20px;border-radius:6px;border:1px solid var(--border,#444);background:transparent;color:var(--text-muted,#888);cursor:pointer;font-size:13px;">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('#ssImportOk').onclick = () => {
      const w = parseFloat(overlay.querySelector('#ssImportWidth').value) || 4;
      const h = parseFloat(overlay.querySelector('#ssImportHeight').value) || 4;
      overlay.remove();
      resolve({ widthInches: w, heightInches: h });
    };
    overlay.querySelector('#ssImportCancel').onclick = () => {
      overlay.remove();
      resolve(null);
    };
  });
}

// ============================================================================
// EXPOSE TO GLOBAL SCOPE
// ============================================================================

window.initVinylCutterEditor = initVinylCutterEditor;
window.addItemToVinylCanvas = addItemToVinylCanvas;
window.zoomVinylCanvas = zoomVinylCanvas;
window.resetVinylZoom = resetVinylZoom;
window.toggleVinylContourVisibility = toggleVinylContourVisibility;
window.rotateVinylItem = rotateVinylItem;
window.scaleVinylItem = scaleVinylItem;
window.removeVinylItem = removeVinylItem;
window.refreshVinylContour = refreshVinylContour;
window.enterVinylContourEditMode = enterVinylContourEditMode;
window.exitVinylContourEditMode = exitVinylContourEditMode;
window.setVinylContourToCircle = setVinylContourToCircle;
window.setVinylContourToRoundedRect = setVinylContourToRoundedRect;
window.resetVinylContourToDefault = resetVinylContourToDefault;
window.smoothVinylContour = smoothVinylContour;
window.addVinylContourPoint = addVinylContourPoint;
window.removeVinylContourPoint = removeVinylContourPoint;
window.generateVinylCutFiles = generateVinylCutFiles;
window.openVinylCutsBrowser = openVinylCutsBrowser;
window.closeVinylCutsBrowser = closeVinylCutsBrowser;
window.selectVinylItem = selectVinylItem;
window.removeVinylItemByIndex = removeVinylItemByIndex;
window.previewVinylCutFile = previewVinylCutFile;
window.sendVinylToSilhouette = sendVinylToSilhouette;
window.deleteVinylCutBatch = deleteVinylCutBatch;
window.cutBrowserSetView = cutBrowserSetView;
window.cutBrowserToggleSelect = cutBrowserToggleSelect;
window.cutBrowserToggleSelectAll = cutBrowserToggleSelectAll;
window.cutBrowserTogglePreview = cutBrowserTogglePreview;
window.cutBrowserClosePreview = cutBrowserClosePreview;
window.cutBrowserDownloadFile = cutBrowserDownloadFile;
window.cutBrowserBulkDelete = cutBrowserBulkDelete;
window.importScreenshot = importScreenshot;
window.importStudio3Files = importStudio3Files;
window.addStudio3ItemToCanvas = addStudio3ItemToCanvas;
window.uploadStudio3ToServer = uploadStudio3ToServer;
window.trainContourModel = trainContourModel;
window.loadStudio3Catalog = loadStudio3Catalog;
window.getStudio3Item = getStudio3Item;
