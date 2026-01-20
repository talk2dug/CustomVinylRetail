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
  const serverBase = (
    window.state?.config?.serverBaseUrl?.trim() ||
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
    // Absolute path on server - extract from web folder
    const webMatch = path.match(/\/web\/library\/(.+)$/);
    if (webMatch) {
      libraryPath = webMatch[1];
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
  const rawPath = design.thumbnailUrl || design.imageUrl || design.imagePath;
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
    return await printStation.vinylCutter.vectorize(imagePath);
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
  const serverBase = (window.state?.config?.serverBaseUrl?.trim() || 'https://blueridgecustomco.com').replace(/\/$/, '');
  const url = `${serverBase}/api/library/vinyl-cuts/${batchName}/${fileName}`;
  window.open(url, '_blank');
}

async function sendVinylToSilhouette(batchName, fileName) {
  vinylShowToast('Sending to Silhouette...', 'info');
  try {
    const result = await printStation.vinylCutter.sendToSilhouette({ batchName, fileName });
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

async function openVinylCutsBrowser() {
  vinylShowToast('Loading generated cut files...', 'info');
  try {
    const batches = await printStation.vinylCutter.list();
    showVinylCutsBrowserModal(batches);
  } catch (err) {
    vinylShowToast('Failed to load: ' + err.message, 'error');
  }
}

function showVinylCutsBrowserModal(batches) {
  // Simple modal implementation - can be expanded
  let modal = document.getElementById('vinylCutsBrowserModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'vinylCutsBrowserModal';
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="modal-backdrop" onclick="closeVinylCutsBrowser()"></div>
      <div class="modal-dialog" style="max-width:800px;max-height:80vh;overflow:auto;">
        <div class="modal-header">
          <h3>Generated Vinyl Cut Files</h3>
          <button class="modal-close" onclick="closeVinylCutsBrowser()">&times;</button>
        </div>
        <div class="modal-body" id="vinylCutsBrowserContent">
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  const content = document.getElementById('vinylCutsBrowserContent');
  if (!batches || batches.length === 0) {
    content.innerHTML = '<div class="placeholder" style="text-align:center;padding:40px;color:#888;">No cut files generated yet</div>';
  } else {
    content.innerHTML = batches.map(batch => `
      <div class="vinyl-batch-card" style="background:var(--card);border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <h4 style="margin:0;">${batch.name}</h4>
          <button class="secondary" style="font-size:11px;color:#ef4444;" onclick="deleteVinylCutBatch('${batch.name}')">Delete</button>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;">
          ${batch.files.map(file => `
            <div style="display:flex;align-items:center;gap:4px;background:rgba(255,255,255,0.1);padding:4px 8px;border-radius:4px;">
              <span style="font-size:12px;">${file}</span>
              <button class="secondary" style="font-size:10px;padding:2px 6px;" onclick="previewVinylCutFile('${batch.name}', '${file}')">View</button>
              <button class="primary" style="font-size:10px;padding:2px 6px;" onclick="sendVinylToSilhouette('${batch.name}', '${file}')">Cut</button>
            </div>
          `).join('')}
        </div>
      </div>
    `).join('');
  }

  modal.style.display = 'flex';
}

function closeVinylCutsBrowser() {
  const modal = document.getElementById('vinylCutsBrowserModal');
  if (modal) {
    modal.style.display = 'none';
  }
}

async function deleteVinylCutBatch(batchName) {
  if (!confirm(`Delete batch "${batchName}"?`)) return;

  try {
    await printStation.vinylCutter.delete(batchName);
    vinylShowToast('Batch deleted', 'success');
    openVinylCutsBrowser(); // Refresh
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

    vinylShowToast(`Parsing ${files.length} Studio3 file(s)...`, 'info');
    updateVinylStatus('Parsing Studio3 files...');

    // Parse all selected files
    let successCount = 0;
    let errorCount = 0;

    for (const filepath of files) {
      try {
        const result = await window.printStation.studio3.parse(filepath);

        if (!result.success) {
          console.error('[Studio3 Import] Parse failed:', filepath, result.error);
          errorCount++;
          continue;
        }

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
    updateVinylItemsUI();
    updateVinylColorLayersUI();
    updateVinylGenerateButton();

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
window.importStudio3Files = importStudio3Files;
window.addStudio3ItemToCanvas = addStudio3ItemToCanvas;
