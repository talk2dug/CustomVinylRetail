// =============== Visual Sticker Layout Editor ===============
// Provides drag-and-drop canvas for arranging stickers with visible contour lines
// Supports rotation, resizing, and multi-page layouts

// Local showToast helper - uses global if available, otherwise console log
function showToast(message, variant = 'info') {
  if (typeof window.showToast === 'function') {
    window.showToast(message, variant);
  } else {
    const prefix = variant === 'error' ? '[ERROR]' : variant === 'success' ? '[OK]' : '[INFO]';
    console.log(`${prefix} ${message}`);
  }
}

// Convert server file path to URL for loading in Electron
function getStickerImageUrl(path) {
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
  // Paths might be like: /home/ubuntu/vinylApp/web/library/...
  // We need: https://server.com/api/library/...
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

const layoutEditorState = {
  canvas: null,
  pages: [], // Array of page data { stickers: [], canvas: null }
  currentPage: 0,
  availableStickers: [], // Stickers available to add from selection
  sheetConfig: {
    widthInches: 8.5,
    heightInches: 11,
    dpi: 300,
    marginInches: 0.5,
    get widthPx() { return Math.floor(this.widthInches * this.dpi); },
    get heightPx() { return Math.floor(this.heightInches * this.dpi); },
    get marginPx() { return Math.floor(this.marginInches * this.dpi); },
    // Canvas display scale (actual pixels to screen pixels)
    displayScale: 0.25
  },
  stickerSizeInches: 3,
  offsetMm: 0.25,
  isInitialized: false,
  // Contour editing state
  contourEditMode: false,
  editingSticker: null,
  contourHandles: [], // Array of control point circles
  contourPoints: [],   // Array of {x, y} points for the contour being edited
  // Zoom and pan state
  zoomLevel: 1,
  minZoom: 0.5,
  maxZoom: 5,
  zoomStep: 0.25,
  isPanning: false,
  lastPanPosition: { x: 0, y: 0 },
  // Crop state
  cropMode: false,
  cropSticker: null,
  cropRect: null,
  originalStickerState: null,
  // Contour cache (in-memory)
  contourCache: new Map() // imagePath -> { svgPath, width, height }
};

// ============================================================================
// LAZY CONTOUR LOADING
// Fetches contours from server on first use, caches in memory
// ============================================================================

/**
 * Fetch contour for a sticker image from the server (lazy generation)
 * Uses the IPC bridge (printStation.stickerSheets.getContour) for proper auth handling
 * @param {string} imagePath - Path to the sticker image
 * @returns {Promise<{svgPath: string, width: number, height: number}|null>}
 */
async function fetchStickerContour(imagePath) {
  // Guard against null/undefined paths
  if (!imagePath) {
    console.warn('[Contour] No image path provided, skipping fetch');
    return null;
  }

  // Check in-memory cache first
  if (layoutEditorState.contourCache.has(imagePath)) {
    console.log('[Contour] Cache hit (memory):', imagePath);
    return layoutEditorState.contourCache.get(imagePath);
  }

  console.log('[Contour] Fetching from server via IPC:', imagePath);

  try {
    // Use the IPC bridge which handles auth properly
    const data = await printStation.stickerSheets.getContour(imagePath);

    if (!data || !data.success || !data.contourPath) {
      throw new Error(data?.error || 'No contour returned');
    }

    const contourData = {
      svgPath: data.contourPath,
      width: data.width,
      height: data.height
    };

    // Cache in memory
    layoutEditorState.contourCache.set(imagePath, contourData);

    console.log('[Contour] Fetched and cached:', imagePath, data.cached ? '(server cache)' : '(generated)');
    return contourData;

  } catch (err) {
    console.error('[Contour] Failed to fetch contour:', err.message);
    return null;
  }
}

/**
 * Set loading state on a sticker thumbnail in the available stickers panel
 * @param {string} imagePath - Path to identify the sticker
 * @param {boolean} isLoading - Whether to show loading state
 */
function setStickerLoading(imagePath, isLoading) {
  // Find the sticker item in the available stickers panel
  const panel = document.getElementById('layoutAvailableStickers');
  if (!panel) return;

  const items = panel.querySelectorAll('.layout-sticker-item');
  for (const item of items) {
    if (item.dataset.path === imagePath) {
      if (isLoading) {
        item.classList.add('loading');
        // Add spinner overlay if not present
        if (!item.querySelector('.contour-spinner')) {
          const spinner = document.createElement('div');
          spinner.className = 'contour-spinner';
          spinner.innerHTML = '<div class="spinner-ring"></div><span>Generating contour...</span>';
          item.appendChild(spinner);
        }
      } else {
        item.classList.remove('loading');
        const spinner = item.querySelector('.contour-spinner');
        if (spinner) spinner.remove();
      }
      break;
    }
  }
}

// Initialize Fabric.js canvas for the layout editor
function initLayoutEditor() {
  if (layoutEditorState.isInitialized) return;

  const canvasEl = document.getElementById('layoutEditorCanvas');
  if (!canvasEl) {
    console.error('Layout editor canvas element not found');
    return;
  }

  // Calculate canvas display dimensions
  const displayWidth = layoutEditorState.sheetConfig.widthPx * layoutEditorState.sheetConfig.displayScale;
  const displayHeight = layoutEditorState.sheetConfig.heightPx * layoutEditorState.sheetConfig.displayScale;

  // Set canvas dimensions
  canvasEl.width = displayWidth;
  canvasEl.height = displayHeight;

  // Initialize Fabric.js canvas
  layoutEditorState.canvas = new fabric.Canvas('layoutEditorCanvas', {
    width: displayWidth,
    height: displayHeight,
    backgroundColor: '#ffffff',
    selection: true,
    preserveObjectStacking: true
  });

  // Draw sheet boundaries and margins
  drawSheetBoundaries();

  // Initialize first page
  layoutEditorState.pages = [{ stickers: [] }];
  layoutEditorState.currentPage = 0;

  // Setup event listeners
  setupLayoutEditorEvents();

  // Setup zoom and pan functionality
  setupCanvasPanning();
  setupZoomKeyboardShortcuts();

  layoutEditorState.isInitialized = true;
  console.log('[Layout Editor] Initialized with display scale:', layoutEditorState.sheetConfig.displayScale);
}

// Draw sheet boundaries, margins, and registration marks
function drawSheetBoundaries() {
  const canvas = layoutEditorState.canvas;
  const config = layoutEditorState.sheetConfig;
  const scale = config.displayScale;

  // Sheet border (for visual reference)
  const border = new fabric.Rect({
    left: 0,
    top: 0,
    width: config.widthPx * scale - 1,
    height: config.heightPx * scale - 1,
    fill: 'transparent',
    stroke: '#ccc',
    strokeWidth: 1,
    selectable: false,
    evented: false
  });
  canvas.add(border);

  // Margin boundary (printable area)
  const marginRect = new fabric.Rect({
    left: config.marginPx * scale,
    top: config.marginPx * scale,
    width: (config.widthPx - 2 * config.marginPx) * scale,
    height: (config.heightPx - 2 * config.marginPx) * scale,
    fill: 'transparent',
    stroke: '#e0e0e0',
    strokeWidth: 1,
    strokeDashArray: [5, 5],
    selectable: false,
    evented: false
  });
  canvas.add(marginRect);

  // Registration marks (corners) - visual only
  const regMarkSize = 15;
  const regMarkColor = '#333';

  // Top-left
  drawRegMark(canvas, config.marginPx * scale - 5, config.marginPx * scale - 5, regMarkSize, regMarkColor, 'tl');
  // Top-right
  drawRegMark(canvas, (config.widthPx - config.marginPx) * scale + 5, config.marginPx * scale - 5, regMarkSize, regMarkColor, 'tr');
  // Bottom-left
  drawRegMark(canvas, config.marginPx * scale - 5, (config.heightPx - config.marginPx) * scale + 5, regMarkSize, regMarkColor, 'bl');

  canvas.renderAll();
}

function drawRegMark(canvas, x, y, size, color, position) {
  const lines = [];

  if (position === 'tl') {
    // L-shape pointing right and down
    lines.push(new fabric.Line([x, y, x + size, y], { stroke: color, strokeWidth: 2, selectable: false, evented: false }));
    lines.push(new fabric.Line([x, y, x, y + size], { stroke: color, strokeWidth: 2, selectable: false, evented: false }));
  } else if (position === 'tr') {
    // L-shape pointing left and down
    lines.push(new fabric.Line([x, y, x - size, y], { stroke: color, strokeWidth: 2, selectable: false, evented: false }));
    lines.push(new fabric.Line([x, y, x, y + size], { stroke: color, strokeWidth: 2, selectable: false, evented: false }));
  } else if (position === 'bl') {
    // L-shape pointing right and up
    lines.push(new fabric.Line([x, y, x + size, y], { stroke: color, strokeWidth: 2, selectable: false, evented: false }));
    lines.push(new fabric.Line([x, y, x, y - size], { stroke: color, strokeWidth: 2, selectable: false, evented: false }));
  }

  lines.forEach(line => canvas.add(line));
}

// Setup event listeners for the layout editor
function setupLayoutEditorEvents() {
  const canvas = layoutEditorState.canvas;

  // Object selection
  canvas.on('selection:created', updateLayoutControls);
  canvas.on('selection:updated', updateLayoutControls);
  canvas.on('selection:cleared', updateLayoutControls);

  // Object modification
  canvas.on('object:modified', () => {
    saveCurrentPageState();
    updateLayoutControls();
  });

  canvas.on('object:moving', (e) => {
    constrainToMargins(e.target);
    // Keep contour in sync with sticker while moving
    if (e.target && e.target.stickerData) {
      updateContourPosition(e.target);
    }
  });

  // Also update contour during scaling and rotating
  canvas.on('object:scaling', (e) => {
    if (e.target && e.target.stickerData) {
      updateContourPosition(e.target);
    }
  });

  canvas.on('object:rotating', (e) => {
    if (e.target && e.target.stickerData) {
      updateContourPosition(e.target);
    }
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', handleLayoutKeyboard);
}

function handleLayoutKeyboard(e) {
  // Only handle if layout editor is visible
  const editorPanel = document.getElementById('layoutEditorPanel');
  if (!editorPanel || editorPanel.style.display === 'none') return;

  const canvas = layoutEditorState.canvas;
  const activeObject = canvas.getActiveObject();

  if (!activeObject) return;

  switch (e.key) {
    case 'Delete':
    case 'Backspace':
      if (activeObject.stickerData) {
        removeStickerFromLayout(activeObject);
      }
      break;
    case 'r':
    case 'R':
      if (!e.ctrlKey && !e.metaKey) {
        rotateSelectedSticker(90);
      }
      break;
    case '[':
      scaleSelectedSticker(0.9);
      break;
    case ']':
      scaleSelectedSticker(1.1);
      break;
  }
}

// Constrain object movement within printable margins
function constrainToMargins(obj) {
  const config = layoutEditorState.sheetConfig;
  const scale = config.displayScale;
  const margin = config.marginPx * scale;
  const maxX = (config.widthPx - config.marginPx) * scale;
  const maxY = (config.heightPx - config.marginPx) * scale;

  const bounds = obj.getBoundingRect();

  if (bounds.left < margin) {
    obj.left = margin + (obj.left - bounds.left);
  }
  if (bounds.top < margin) {
    obj.top = margin + (obj.top - bounds.top);
  }
  if (bounds.left + bounds.width > maxX) {
    obj.left = maxX - bounds.width + (obj.left - bounds.left);
  }
  if (bounds.top + bounds.height > maxY) {
    obj.top = maxY - bounds.height + (obj.top - bounds.top);
  }
}

// Add a sticker to the canvas with its contour
async function addStickerToLayout(sticker) {
  // Ensure canvas is initialized
  if (!layoutEditorState.canvas) {
    console.error('[Layout Editor] Canvas not initialized, initializing now...');
    initLayoutEditor();
  }

  const canvas = layoutEditorState.canvas;
  if (!canvas) {
    console.error('[Layout Editor] Failed to initialize canvas');
    showToast('Layout editor not ready. Please try again.', 'error');
    return;
  }

  const config = layoutEditorState.sheetConfig;
  const scale = config.displayScale;
  const targetSizePx = layoutEditorState.stickerSizeInches * config.dpi;

  // Load the sticker image - convert server paths to URLs
  // API returns: thumbnailUrl (full URL) and imagePath (local server path)
  const rawPath = sticker.thumbnailUrl || sticker.imageUrl || sticker.imagePath;
  const imageUrl = getStickerImageUrl(rawPath);

  console.log('[Layout Editor] Adding sticker:', {
    title: sticker.title || sticker.name,
    rawPath,
    imageUrl
  });

  try {
    // Create image element
    const img = await loadImage(imageUrl);

    // Calculate scaled dimensions (fit within target size)
    const aspectRatio = img.width / img.height;
    let stickerWidth, stickerHeight;

    if (aspectRatio > 1) {
      // Wider than tall
      stickerWidth = targetSizePx;
      stickerHeight = targetSizePx / aspectRatio;
    } else {
      // Taller than wide
      stickerHeight = targetSizePx;
      stickerWidth = targetSizePx * aspectRatio;
    }

    // Create Fabric image
    const fabricImg = new fabric.Image(img, {
      left: config.marginPx * scale + 50,
      top: config.marginPx * scale + 50,
      scaleX: (stickerWidth * scale) / img.width,
      scaleY: (stickerHeight * scale) / img.height,
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

    // Store sticker data
    fabricImg.stickerData = {
      id: sticker.id || Date.now(),
      title: sticker.title || sticker.name,
      imagePath: sticker.imagePath,
      thumbnailUrl: sticker.thumbnailUrl,
      imageUrl: imageUrl, // Store the resolved URL for operations like background removal
      originalWidth: img.width,
      originalHeight: img.height,
      targetWidth: stickerWidth,
      targetHeight: stickerHeight
    };

    // Generate and add contour outline
    const contour = await generateContourForSticker(sticker, stickerWidth, stickerHeight, scale);
    if (contour) {
      fabricImg.contourPath = contour;
      // Position contour relative to image
      updateContourPosition(fabricImg);
      console.log('[Contour] Created contour:', {
        type: contour.type,
        left: contour.left,
        top: contour.top,
        width: contour.width,
        height: contour.height,
        stroke: contour.stroke,
        visible: contour.visible
      });
    }

    canvas.add(fabricImg);
    if (contour) {
      canvas.add(contour);
      // Ensure contour is visible and on top
      canvas.bringToFront(contour);
    }

    canvas.setActiveObject(fabricImg);
    canvas.renderAll();

    // Ensure all contours stay visible on top
    bringContoursToFront();

    // Save state
    saveCurrentPageState();
    updateLayoutControls();
    updateLayoutStickerCount();

    console.log('[Layout Editor] Added sticker:', sticker.title);
  } catch (err) {
    console.error('[Layout Editor] Failed to add sticker:', err);
    showToast('Failed to add sticker: ' + err.message, 'error');
  }
}

// Load image as promise
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      console.log('[Layout Editor] Image loaded successfully:', url);
      resolve(img);
    };
    img.onerror = (err) => {
      console.error('[Layout Editor] Failed to load image:', url, err);
      reject(new Error('Failed to load image: ' + url));
    };
    img.src = url;
  });
}

// Generate contour path for a sticker
// Uses lazy loading from server with caching - returns immediate fallback, upgrades async
async function generateContourForSticker(sticker, width, height, displayScale) {
  const offsetMm = layoutEditorState.offsetMm;
  const config = layoutEditorState.sheetConfig;
  const imagePath = sticker.imagePath;

  // Try to get contour from sticker object if already available
  if (sticker.contour && sticker.contour.length > 0) {
    return createContourPath(sticker.contour, width, height, displayScale, offsetMm);
  }

  // Check if we already have this contour cached in memory
  if (imagePath && layoutEditorState.contourCache.has(imagePath)) {
    const cached = layoutEditorState.contourCache.get(imagePath);
    if (cached && cached.svgPath) {
      const contour = createContourFromSvgPath(
        cached.svgPath,
        cached.width,
        cached.height,
        width,
        height,
        displayScale,
        offsetMm
      );
      if (contour) {
        // Solid stroke indicates this is a real bezier contour (not rectangular fallback)
        contour.set({
          strokeDashArray: null
        });
        console.log('[Contour] Using cached bezier contour for:', imagePath);
        return contour;
      }
    }
  }

  // Return rectangular fallback immediately - don't block sticker addition
  // Contour will be fetched in background and can be upgraded later
  console.log('[Contour] Using rectangular fallback for:', imagePath || '(no path)');
  const offsetPx = (offsetMm / 25.4) * config.dpi * displayScale;

  const contour = new fabric.Rect({
    left: 0,
    top: 0,
    width: width * displayScale + offsetPx * 2,
    height: height * displayScale + offsetPx * 2,
    rx: 5,
    ry: 5,
    fill: 'transparent',
    stroke: '#ef4444',
    strokeWidth: 3,
    strokeDashArray: [8, 4],
    selectable: false,
    evented: false,
    originX: 'center',
    originY: 'center',
    visible: true
  });

  console.log('[Contour] Created fallback rectangle contour:', {
    width: contour.width,
    height: contour.height,
    stroke: contour.stroke,
    strokeWidth: contour.strokeWidth,
    visible: contour.visible
  });

  // Kick off background fetch for the real contour and UPDATE the display when ready
  if (imagePath) {
    fetchStickerContour(imagePath).then(contourData => {
      if (contourData) {
        console.log('[Contour] Fetched real contour, updating display:', imagePath);
        // Find the sticker on canvas that uses this image path and update its contour
        upgradeContourOnCanvas(imagePath, contourData);
      }
    }).catch(err => {
      console.warn('[Contour] Background fetch failed:', err.message);
    });
  }

  return contour;
}

/**
 * Upgrade a sticker's rectangular fallback contour to the real bezier contour
 * Called when the background fetch completes
 */
function upgradeContourOnCanvas(imagePath, contourData) {
  const canvas = layoutEditorState.canvas;
  if (!canvas) return;

  const config = layoutEditorState.sheetConfig;
  const scale = config.displayScale;
  const offsetMm = layoutEditorState.offsetMm;

  // Find all stickers with this image path
  const stickers = canvas.getObjects().filter(obj =>
    obj.stickerData && obj.stickerData.imagePath === imagePath
  );

  for (const sticker of stickers) {
    // Skip if sticker already has a custom (edited) contour
    if (sticker.stickerData.customContour && sticker.stickerData.customContour.length > 0) {
      console.log('[Contour] Skipping upgrade - sticker has custom contour');
      continue;
    }

    // Skip if contour was already upgraded (check if it's a Path, not a Rect)
    if (sticker.contourPath && sticker.contourPath.type === 'path') {
      console.log('[Contour] Skipping upgrade - already has bezier contour');
      continue;
    }

    const targetWidth = sticker.width * sticker.scaleX;
    const targetHeight = sticker.height * sticker.scaleY;

    // Create new contour from SVG path
    const newContour = createContourFromSvgPath(
      contourData.svgPath,
      contourData.width,
      contourData.height,
      targetWidth / scale,  // Convert back to actual pixels
      targetHeight / scale,
      scale,
      offsetMm
    );

    if (newContour) {
      // Remove old rectangular contour
      if (sticker.contourPath) {
        canvas.remove(sticker.contourPath);
      }

      // Set the new contour with solid stroke (indicates real contour)
      newContour.set({
        stroke: '#ef4444',
        strokeDashArray: null,  // Solid line = real contour
        strokeWidth: 3,  // Thicker for visibility
        visible: true
      });

      // Attach and position
      sticker.contourPath = newContour;
      sticker.stickerData.hasBezierContour = true;
      updateContourPosition(sticker);
      canvas.add(newContour);
      canvas.bringToFront(newContour);

      console.log('[Contour] ✅ Upgraded to bezier contour:', imagePath, {
        left: newContour.left,
        top: newContour.top,
        type: newContour.type,
        visible: newContour.visible,
        stroke: newContour.stroke,
        strokeWidth: newContour.strokeWidth
      });
    }
  }

  // Ensure all contours stay on top after upgrade
  bringContoursToFront();
  canvas.renderAll();
}

/**
 * Create a Fabric.js path from an SVG path string
 * Scales the path from original image dimensions to display dimensions
 */
function createContourFromSvgPath(svgPath, origWidth, origHeight, targetWidth, targetHeight, displayScale, offsetMm) {
  if (!svgPath) return null;

  const config = layoutEditorState.sheetConfig;

  try {
    // Calculate scale factors
    const scaleX = (targetWidth * displayScale) / origWidth;
    const scaleY = (targetHeight * displayScale) / origHeight;

    // Create fabric path
    const contour = new fabric.Path(svgPath, {
      fill: 'transparent',
      stroke: '#ef4444',
      strokeWidth: 1.5,
      strokeDashArray: [4, 2],
      selectable: false,
      evented: false,
      originX: 'center',
      originY: 'center',
      scaleX: scaleX,
      scaleY: scaleY
    });

    return contour;
  } catch (err) {
    console.error('[Contour] Failed to create fabric path from SVG:', err);
    return null;
  }
}

// Create contour path from points array
function createContourPath(points, width, height, displayScale, offsetMm) {
  if (!points || points.length < 3) return null;

  const config = layoutEditorState.sheetConfig;
  const offsetPx = (offsetMm / 25.4) * config.dpi * displayScale;

  // Scale points to display size and apply offset
  const scaledPoints = points.map(p => ({
    x: (p.x / width) * (width * displayScale),
    y: (p.y / height) * (height * displayScale)
  }));

  // Create SVG path string
  let pathStr = `M ${scaledPoints[0].x} ${scaledPoints[0].y}`;
  for (let i = 1; i < scaledPoints.length; i++) {
    pathStr += ` L ${scaledPoints[i].x} ${scaledPoints[i].y}`;
  }
  pathStr += ' Z';

  const contour = new fabric.Path(pathStr, {
    fill: 'transparent',
    stroke: '#ef4444',
    strokeWidth: 1.5,
    strokeDashArray: [4, 2],
    selectable: false,
    evented: false,
    originX: 'center',
    originY: 'center'
  });

  return contour;
}

// Update contour position to match its parent sticker
function updateContourPosition(stickerObj) {
  if (!stickerObj.contourPath) return;

  const contour = stickerObj.contourPath;

  // For Path objects (bezier contours), we need to position at the sticker center
  // For Rect objects (rectangular fallback), same positioning
  const centerX = stickerObj.left + (stickerObj.width * stickerObj.scaleX) / 2;
  const centerY = stickerObj.top + (stickerObj.height * stickerObj.scaleY) / 2;

  // For rectangles, we don't apply the sticker's scale since the rect is already sized correctly
  if (contour.type === 'rect') {
    contour.set({
      left: centerX,
      top: centerY,
      angle: stickerObj.angle
    });
  } else {
    // For paths (bezier contours), apply position and the sticker's transforms
    contour.set({
      left: centerX,
      top: centerY,
      angle: stickerObj.angle,
      scaleX: stickerObj.scaleX,
      scaleY: stickerObj.scaleY
    });
  }

  contour.setCoords();
}

// Bring all contours to front so they're visible on top of stickers
function bringContoursToFront() {
  const canvas = layoutEditorState.canvas;
  if (!canvas) return;

  const stickers = canvas.getObjects().filter(obj => obj.stickerData && obj.contourPath);
  for (const sticker of stickers) {
    canvas.bringToFront(sticker.contourPath);
  }
}

// Remove sticker from layout
function removeStickerFromLayout(stickerObj) {
  const canvas = layoutEditorState.canvas;

  // Remove contour if exists
  if (stickerObj.contourPath) {
    canvas.remove(stickerObj.contourPath);
  }

  canvas.remove(stickerObj);
  canvas.discardActiveObject();
  canvas.renderAll();

  saveCurrentPageState();
  updateLayoutControls();
  updateLayoutStickerCount();
}

// Rotate selected sticker
function rotateSelectedSticker(degrees) {
  const canvas = layoutEditorState.canvas;
  const obj = canvas.getActiveObject();

  if (obj && obj.stickerData) {
    obj.rotate((obj.angle || 0) + degrees);
    updateContourPosition(obj);
    canvas.renderAll();
    saveCurrentPageState();
  }
}

// Scale selected sticker
function scaleSelectedSticker(factor) {
  const canvas = layoutEditorState.canvas;
  const obj = canvas.getActiveObject();

  if (obj && obj.stickerData) {
    obj.scaleX *= factor;
    obj.scaleY *= factor;
    updateContourPosition(obj);
    constrainToMargins(obj);
    canvas.renderAll();
    saveCurrentPageState();
  }
}

// Enter crop mode for selected sticker
function enterCropMode() {
  const canvas = layoutEditorState.canvas;
  const obj = canvas.getActiveObject();

  if (!obj || !obj.stickerData) {
    showToast('Select a sticker first', 'error');
    return;
  }

  // Exit contour edit mode if active
  if (layoutEditorState.contourEditMode) {
    exitContourEditMode(false);
  }

  layoutEditorState.cropMode = true;
  layoutEditorState.cropSticker = obj;

  // Save original state for cancel
  layoutEditorState.originalStickerState = {
    left: obj.left,
    top: obj.top,
    scaleX: obj.scaleX,
    scaleY: obj.scaleY,
    width: obj.width,
    height: obj.height,
    clipPath: obj.clipPath ? obj.clipPath.toObject() : null
  };

  // Lock the sticker
  obj.selectable = false;
  obj.evented = false;

  // Create crop rectangle overlay
  const padding = 20;
  const cropRect = new fabric.Rect({
    left: obj.left - padding,
    top: obj.top - padding,
    width: obj.width * obj.scaleX + padding * 2,
    height: obj.height * obj.scaleY + padding * 2,
    fill: 'transparent',
    stroke: '#f59e0b',
    strokeWidth: 2,
    strokeDashArray: [5, 5],
    hasControls: true,
    hasBorders: true,
    lockRotation: true,
    cornerColor: '#f59e0b',
    cornerStrokeColor: '#f59e0b',
    borderColor: '#f59e0b',
    transparentCorners: false,
    cornerSize: 10,
    isCropRect: true
  });

  layoutEditorState.cropRect = cropRect;
  canvas.add(cropRect);
  canvas.setActiveObject(cropRect);
  canvas.renderAll();

  // Update UI
  updateCropModeUI(true);
  showToast('Adjust the crop area and click Apply Crop', 'info');
}

// Apply the crop
async function applyCrop() {
  const canvas = layoutEditorState.canvas;
  const cropRect = layoutEditorState.cropRect;
  const sticker = layoutEditorState.cropSticker;

  if (!cropRect || !sticker) {
    cancelCrop();
    return;
  }

  try {
    // Get crop rectangle bounds
    const cropBounds = cropRect.getBoundingRect();

    // Get sticker bounds
    const stickerBounds = sticker.getBoundingRect();

    // Calculate intersection (actual crop area)
    const intersectLeft = Math.max(cropBounds.left, stickerBounds.left);
    const intersectTop = Math.max(cropBounds.top, stickerBounds.top);
    const intersectRight = Math.min(cropBounds.left + cropBounds.width, stickerBounds.left + stickerBounds.width);
    const intersectBottom = Math.min(cropBounds.top + cropBounds.height, stickerBounds.top + stickerBounds.height);

    const cropWidth = intersectRight - intersectLeft;
    const cropHeight = intersectBottom - intersectTop;

    if (cropWidth <= 0 || cropHeight <= 0) {
      showToast('Invalid crop area', 'error');
      cancelCrop();
      return;
    }

    // Calculate crop coordinates relative to original image
    const relativeLeft = (intersectLeft - stickerBounds.left) / sticker.scaleX;
    const relativeTop = (intersectTop - stickerBounds.top) / sticker.scaleY;
    const relativeWidth = cropWidth / sticker.scaleX;
    const relativeHeight = cropHeight / sticker.scaleY;

    // Get the image source
    const imgSrc = sticker.stickerData.processedDataUrl ||
                   sticker.stickerData.imageUrl ||
                   getStickerImageUrl(sticker.stickerData.thumbnailUrl || sticker.stickerData.imagePath);

    // Create cropped image using canvas
    const croppedDataUrl = await cropImageWithCanvas(imgSrc, relativeLeft, relativeTop, relativeWidth, relativeHeight);

    if (!croppedDataUrl) {
      throw new Error('Failed to crop image');
    }

    // Load the cropped image
    const croppedImg = await loadImage(croppedDataUrl);

    // Store original position before modifying
    const newLeft = intersectLeft;
    const newTop = intersectTop;

    // Update the sticker with cropped image
    sticker.setElement(croppedImg, { width: croppedImg.width, height: croppedImg.height });
    sticker.set({
      left: newLeft + (cropWidth / 2),
      top: newTop + (cropHeight / 2),
      scaleX: cropWidth / croppedImg.width,
      scaleY: cropHeight / croppedImg.height,
      originX: 'center',
      originY: 'center'
    });

    // Clear cache
    sticker.dirty = true;
    if (sticker._cacheCanvas) {
      sticker._cacheCanvas = null;
    }
    sticker.setCoords();

    // Update sticker data
    sticker.stickerData.processedDataUrl = croppedDataUrl;
    sticker.stickerData.cropped = true;

    // Update contour to match new dimensions
    updateContourPosition(sticker);

    // Cleanup crop mode
    exitCropMode();
    saveCurrentPageState();
    showToast('Sticker cropped successfully', 'success');

  } catch (err) {
    console.error('[Layout Editor] Crop failed:', err);
    showToast('Failed to crop sticker: ' + err.message, 'error');
    cancelCrop();
  }
}

// Cancel crop mode
function cancelCrop() {
  exitCropMode();
  showToast('Crop cancelled', 'info');
}

// Exit crop mode and cleanup
function exitCropMode() {
  const canvas = layoutEditorState.canvas;

  // Remove crop rectangle
  if (layoutEditorState.cropRect) {
    canvas.remove(layoutEditorState.cropRect);
  }

  // Restore sticker interactivity
  if (layoutEditorState.cropSticker) {
    layoutEditorState.cropSticker.selectable = true;
    layoutEditorState.cropSticker.evented = true;
    canvas.setActiveObject(layoutEditorState.cropSticker);
  }

  // Reset state
  layoutEditorState.cropMode = false;
  layoutEditorState.cropRect = null;
  layoutEditorState.cropSticker = null;
  layoutEditorState.originalStickerState = null;

  canvas.renderAll();
  updateCropModeUI(false);
}

// Update UI for crop mode
function updateCropModeUI(isCropping) {
  const cropBtn = document.getElementById('layoutCropBtn');
  const applyBtn = document.getElementById('layoutCropApplyBtn');
  const cancelBtn = document.getElementById('layoutCropCancelBtn');
  const rotateBtn = document.getElementById('layoutRotateBtn');
  const scaleUpBtn = document.getElementById('layoutScaleUpBtn');
  const scaleDownBtn = document.getElementById('layoutScaleDownBtn');
  const deleteBtn = document.getElementById('layoutDeleteBtn');
  const removeBgBtn = document.getElementById('layoutRemoveBgBtn');
  const editContourBtn = document.getElementById('layoutEditContourBtn');
  const refreshContourBtn = document.getElementById('layoutRefreshContourBtn');

  if (isCropping) {
    if (cropBtn) cropBtn.style.display = 'none';
    if (applyBtn) applyBtn.style.display = 'inline-block';
    if (cancelBtn) cancelBtn.style.display = 'inline-block';
    if (rotateBtn) rotateBtn.style.display = 'none';
    if (scaleUpBtn) scaleUpBtn.style.display = 'none';
    if (scaleDownBtn) scaleDownBtn.style.display = 'none';
    if (deleteBtn) deleteBtn.style.display = 'none';
    if (removeBgBtn) removeBgBtn.style.display = 'none';
    if (editContourBtn) editContourBtn.style.display = 'none';
    if (refreshContourBtn) refreshContourBtn.style.display = 'none';
  } else {
    if (cropBtn) cropBtn.style.display = 'inline-block';
    if (applyBtn) applyBtn.style.display = 'none';
    if (cancelBtn) cancelBtn.style.display = 'none';
    if (rotateBtn) rotateBtn.style.display = 'inline-block';
    if (scaleUpBtn) scaleUpBtn.style.display = 'inline-block';
    if (scaleDownBtn) scaleDownBtn.style.display = 'inline-block';
    if (deleteBtn) deleteBtn.style.display = 'inline-block';
    if (removeBgBtn) removeBgBtn.style.display = 'inline-block';
    if (editContourBtn) editContourBtn.style.display = 'inline-block';
    if (refreshContourBtn) refreshContourBtn.style.display = 'inline-block';
  }
}

// Crop image using canvas
function cropImageWithCanvas(imageUrl, x, y, width, height) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        // Ensure crop bounds are within image
        const cropX = Math.max(0, Math.min(x, img.width));
        const cropY = Math.max(0, Math.min(y, img.height));
        const cropW = Math.min(width, img.width - cropX);
        const cropH = Math.min(height, img.height - cropY);

        canvas.width = cropW;
        canvas.height = cropH;

        ctx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

        const dataUrl = canvas.toDataURL('image/png');
        resolve(dataUrl);
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => reject(new Error('Failed to load image for cropping'));
    img.src = imageUrl;
  });
}

// Remove background using canvas (fallback when ImageMagick not available)
function removeBackgroundWithCanvas(imageUrl, keyColor = '#ffffff', fuzzPct = 10) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        canvas.width = img.width;
        canvas.height = img.height;
        ctx.drawImage(img, 0, 0);

        // Parse key color
        const kr = parseInt(keyColor.slice(1, 3), 16);
        const kg = parseInt(keyColor.slice(3, 5), 16);
        const kb = parseInt(keyColor.slice(5, 7), 16);

        console.log('[BG Removal] Processing image:', img.width, 'x', img.height);
        console.log('[BG Removal] Key color RGB:', kr, kg, kb);
        console.log('[BG Removal] Fuzz %:', fuzzPct);

        // Get image data
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;

        // Calculate threshold based on fuzz percentage
        // Max Euclidean distance is ~441 (sqrt(255^2 * 3))
        // At 1%, threshold should be very small (~4), at 30% it's ~132
        // Use a more conservative calculation: direct percentage of each channel
        const channelThreshold = (fuzzPct / 100) * 255;
        console.log('[BG Removal] Channel threshold:', channelThreshold);

        let pixelsRemoved = 0;
        let totalPixels = data.length / 4;

        // Process each pixel
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          const a = data[i + 3];

          if (a === 0) continue;

          // Check if each channel is within threshold of key color
          // This is more precise than Euclidean distance
          const rDiff = Math.abs(r - kr);
          const gDiff = Math.abs(g - kg);
          const bDiff = Math.abs(b - kb);

          // All channels must be within threshold (strict matching)
          if (rDiff <= channelThreshold && gDiff <= channelThreshold && bDiff <= channelThreshold) {
            data[i + 3] = 0;
            pixelsRemoved++;
          }
        }

        console.log('[BG Removal] Pixels removed:', pixelsRemoved, 'of', totalPixels, '(' + Math.round(pixelsRemoved/totalPixels*100) + '%)');

        ctx.putImageData(imageData, 0, 0);
        const resultDataUrl = canvas.toDataURL('image/png');
        console.log('[BG Removal] Result dataUrl length:', resultDataUrl.length);
        resolve(resultDataUrl);
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = imageUrl;
  });
}

// Remove background from selected sticker
async function removeSelectedStickerBackground() {
  const canvas = layoutEditorState.canvas;
  const obj = canvas.getActiveObject();

  if (!obj || !obj.stickerData) {
    showToast('Select a sticker first', 'error');
    return;
  }

  // Get selected background color from dropdown
  const bgColorSelect = document.getElementById('layoutBgColorSelect');
  const keyColor = bgColorSelect ? bgColorSelect.value : '#ffffff';

  // Get fuzz/tolerance value from slider (default to 5% for more precise removal)
  const fuzzSlider = document.getElementById('layoutBgFuzzSlider');
  const fuzzPct = fuzzSlider ? parseInt(fuzzSlider.value, 10) : 5;
  console.log('[Layout Editor] Removing background color:', keyColor, 'with fuzz:', fuzzPct + '%');

  const removeBgBtn = document.getElementById('layoutRemoveBgBtn');
  if (removeBgBtn) {
    removeBgBtn.disabled = true;
    removeBgBtn.textContent = 'Processing...';
  }

  try {
    // Get the image URL - use pre-resolved URL or resolve from available paths
    const imageUrl = obj.stickerData.imageUrl || getStickerImageUrl(obj.stickerData.thumbnailUrl || obj.stickerData.imagePath);
    console.log('[Layout Editor] Removing background from:', imageUrl);

    let dataUrl;

    // Try server-side removal first (uses ImageMagick)
    try {
      const result = await printStation.removeImageBackground({
        imageUrl,
        keyColor: keyColor,
        fuzzPct: fuzzPct
      });

      if (result?.success && result?.dataUrl) {
        dataUrl = result.dataUrl;
        console.log('[Layout Editor] Background removed via ImageMagick');
      }
    } catch (serverErr) {
      console.warn('[Layout Editor] Server-side removal failed, using canvas fallback:', serverErr.message);
    }

    // Fallback to canvas-based removal
    if (!dataUrl) {
      console.log('[Layout Editor] Using canvas-based background removal');
      dataUrl = await removeBackgroundWithCanvas(imageUrl, keyColor, fuzzPct);
    }

    if (!dataUrl) {
      throw new Error('Background removal failed');
    }

    console.log('[Layout Editor] Background removed successfully, dataUrl length:', dataUrl.length);

    // Store original properties
    const origLeft = obj.left;
    const origTop = obj.top;
    const origScaleX = obj.scaleX;
    const origScaleY = obj.scaleY;
    const origAngle = obj.angle || 0;
    const origStickerData = { ...obj.stickerData };
    const origContourPath = obj.contourPath;

    // Load the processed image and replace the current one
    const processedImg = await loadImage(dataUrl);
    console.log('[Layout Editor] Processed image loaded:', processedImg.width, 'x', processedImg.height);

    // Update the fabric image element with the new image
    obj.setElement(processedImg, { width: processedImg.width, height: processedImg.height });

    // Clear the cache so Fabric.js re-renders the new image
    obj.dirty = true;
    if (obj._cacheCanvas) {
      obj._cacheCanvas = null;
    }
    obj.setCoords();

    // Restore position and scale
    obj.set({
      left: origLeft,
      top: origTop,
      scaleX: origScaleX,
      scaleY: origScaleY,
      angle: origAngle,
      dirty: true
    });

    // Force cache invalidation
    obj.setCoords();

    // Update sticker data with processed info
    obj.stickerData = {
      ...origStickerData,
      backgroundRemoved: true,
      processedDataUrl: dataUrl,
      imageUrl: dataUrl
    };

    // Restore contour path reference
    obj.contourPath = origContourPath;

    // Update contour to green to indicate processed
    if (obj.contourPath) {
      obj.contourPath.set({
        stroke: '#22c55e',
        strokeDashArray: null
      });
    }

    // Force full canvas re-render
    canvas.requestRenderAll ? canvas.requestRenderAll() : canvas.renderAll();

    // Double-check with a slight delay to ensure render completes
    setTimeout(() => {
      canvas.requestRenderAll ? canvas.requestRenderAll() : canvas.renderAll();
    }, 50);

    saveCurrentPageState();
    updateLayoutControls();

    showToast('Background removed successfully!', 'success');
    console.log('[Layout Editor] Background removal applied visually.');

  } catch (err) {
    console.error('[Layout Editor] Background removal failed:', err);
    showToast('Failed to remove background: ' + (err.message || err), 'error');
  } finally {
    if (removeBgBtn) {
      removeBgBtn.disabled = false;
      removeBgBtn.textContent = 'Remove BG';
    }
    updateLayoutControls();
  }
}

// Update layout control buttons state
function updateLayoutControls() {
  const canvas = layoutEditorState.canvas;
  const activeObject = canvas ? canvas.getActiveObject() : null;
  const hasSelection = activeObject && activeObject.stickerData;

  const rotateBtn = document.getElementById('layoutRotateBtn');
  const deleteBtn = document.getElementById('layoutDeleteBtn');
  const scaleUpBtn = document.getElementById('layoutScaleUpBtn');
  const scaleDownBtn = document.getElementById('layoutScaleDownBtn');
  const editContourBtn = document.getElementById('layoutEditContourBtn');
  const removeBgBtn = document.getElementById('layoutRemoveBgBtn');
  const cropBtn = document.getElementById('layoutCropBtn');
  const refreshContourBtn = document.getElementById('layoutRefreshContourBtn');

  if (rotateBtn) rotateBtn.disabled = !hasSelection;
  if (deleteBtn) deleteBtn.disabled = !hasSelection;
  if (scaleUpBtn) scaleUpBtn.disabled = !hasSelection;
  if (scaleDownBtn) scaleDownBtn.disabled = !hasSelection;
  if (editContourBtn) editContourBtn.disabled = !hasSelection;
  if (removeBgBtn) removeBgBtn.disabled = !hasSelection;
  if (cropBtn) cropBtn.disabled = !hasSelection;
  if (refreshContourBtn) refreshContourBtn.disabled = !hasSelection;
}

// Update sticker count display
function updateLayoutStickerCount() {
  const canvas = layoutEditorState.canvas;
  if (!canvas) return;

  const stickerCount = canvas.getObjects().filter(obj => obj.stickerData).length;
  const countEl = document.getElementById('layoutStickerCount');
  if (countEl) {
    countEl.textContent = stickerCount;
  }

  const pageCountEl = document.getElementById('layoutPageCount');
  if (pageCountEl) {
    pageCountEl.textContent = layoutEditorState.pages.length;
  }
}

// Save current page state
function saveCurrentPageState() {
  const canvas = layoutEditorState.canvas;
  if (!canvas) return;

  const stickers = canvas.getObjects()
    .filter(obj => obj.stickerData)
    .map(obj => {
      // Clone the stickerData to avoid reference issues
      const stickerDataCopy = { ...obj.stickerData };

      // If there's a contourPath on the canvas object, extract its points and save to customContour
      // This ensures any contour (default or edited) is preserved
      if (obj.contourPath) {
        const contourObj = obj.contourPath;
        let extractedPoints = [];

        if (contourObj.path) {
          // It's a fabric.Path - extract points from path data
          const pathData = contourObj.path;
          const matrix = contourObj.calcTransformMatrix ? contourObj.calcTransformMatrix() : null;

          for (const cmd of pathData) {
            let point = null;
            if (cmd[0] === 'M' || cmd[0] === 'L') {
              point = { x: cmd[1], y: cmd[2] };
            } else if (cmd[0] === 'C') {
              point = { x: cmd[5], y: cmd[6] };
            } else if (cmd[0] === 'Q') {
              point = { x: cmd[3], y: cmd[4] };
            }
            if (point) {
              // Apply transform if available
              if (matrix && fabric.util.transformPoint) {
                const transformed = fabric.util.transformPoint(point, matrix);
                extractedPoints.push({ x: transformed.x, y: transformed.y });
              } else {
                extractedPoints.push(point);
              }
            }
          }
        } else if (contourObj.type === 'rect') {
          // It's a fabric.Rect - convert to corner points
          const left = contourObj.left - (contourObj.width / 2);
          const top = contourObj.top - (contourObj.height / 2);
          const right = left + contourObj.width;
          const bottom = top + contourObj.height;
          extractedPoints = [
            { x: left, y: top },
            { x: right, y: top },
            { x: right, y: bottom },
            { x: left, y: bottom }
          ];
        }

        // Only save if we extracted valid points
        if (extractedPoints.length >= 3) {
          stickerDataCopy.customContour = extractedPoints;
        }
      }

      return {
        stickerData: stickerDataCopy,
        left: obj.left,
        top: obj.top,
        width: obj.width,
        height: obj.height,
        angle: obj.angle,
        scaleX: obj.scaleX,
        scaleY: obj.scaleY
      };
    });

  layoutEditorState.pages[layoutEditorState.currentPage] = { stickers };
}

// Load page state
async function loadPageState(pageIndex) {
  if (pageIndex < 0 || pageIndex >= layoutEditorState.pages.length) return;

  const canvas = layoutEditorState.canvas;
  const pageData = layoutEditorState.pages[pageIndex];

  // Clear canvas (keep boundaries - remove stickers and their contours)
  const objects = canvas.getObjects().slice();
  objects.forEach(obj => {
    // Remove if it's a sticker (has stickerData)
    // Remove if it's a contour (referenced by a sticker's contourPath, or is a Rect/Path used as contour)
    // Keep boundary elements (sheet border, margin rect, registration marks)
    const isSticker = !!obj.stickerData;
    const isContour = obj.stroke === '#ef4444' || obj.stroke === '#22c55e'; // Contour colors
    const isBoundary = obj.stroke === '#ccc' || obj.stroke === '#e0e0e0' || obj.stroke === '#333'; // Boundary colors

    if (isSticker) {
      // Also remove the sticker's contour if it exists
      if (obj.contourPath) {
        canvas.remove(obj.contourPath);
      }
      canvas.remove(obj);
    } else if (isContour && !isBoundary) {
      canvas.remove(obj);
    }
  });

  layoutEditorState.currentPage = pageIndex;

  // Restore stickers from saved page data
  if (pageData.stickers && pageData.stickers.length > 0) {
    for (const item of pageData.stickers) {
      try {
        // Get the image URL from saved sticker data
        const imageUrl = item.stickerData.processedDataUrl ||
                         item.stickerData.imageUrl ||
                         getStickerImageUrl(item.stickerData.thumbnailUrl || item.stickerData.imagePath);

        // Load the image
        const img = await loadImage(imageUrl);

        // Create Fabric image with saved properties
        const fabricImg = new fabric.Image(img, {
          left: item.left,
          top: item.top,
          scaleX: item.scaleX,
          scaleY: item.scaleY,
          angle: item.angle || 0,
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

        // Restore sticker data
        fabricImg.stickerData = item.stickerData;

        // Recreate contour
        const config = layoutEditorState.sheetConfig;
        const scale = config.displayScale;
        const offsetPx = (layoutEditorState.offsetMm / 25.4) * config.dpi * scale;

        // Check if there's a custom contour saved
        if (item.stickerData.customContour && item.stickerData.customContour.length >= 3) {
          const points = item.stickerData.customContour;
          let pathStr = `M ${points[0].x} ${points[0].y}`;
          for (let i = 1; i < points.length; i++) {
            pathStr += ` L ${points[i].x} ${points[i].y}`;
          }
          pathStr += ' Z';

          const contour = new fabric.Path(pathStr, {
            fill: 'transparent',
            stroke: item.stickerData.backgroundRemoved ? '#22c55e' : '#ef4444',
            strokeWidth: 1.5,
            strokeDashArray: item.stickerData.backgroundRemoved ? null : [4, 2],
            selectable: false,
            evented: false
          });

          fabricImg.contourPath = contour;
          canvas.add(contour);
        } else {
          // Create default rectangular contour
          const contour = new fabric.Rect({
            left: 0,
            top: 0,
            width: fabricImg.width * fabricImg.scaleX + offsetPx * 2,
            height: fabricImg.height * fabricImg.scaleY + offsetPx * 2,
            rx: 5,
            ry: 5,
            fill: 'transparent',
            stroke: item.stickerData.backgroundRemoved ? '#22c55e' : '#ef4444',
            strokeWidth: 1.5,
            strokeDashArray: item.stickerData.backgroundRemoved ? null : [4, 2],
            selectable: false,
            evented: false,
            originX: 'center',
            originY: 'center'
          });

          fabricImg.contourPath = contour;
          updateContourPosition(fabricImg);
          canvas.add(contour);
        }

        canvas.add(fabricImg);
      } catch (err) {
        console.error('[Layout Editor] Failed to restore sticker:', item.stickerData?.title, err);
      }
    }
  }

  canvas.renderAll();
  updateLayoutControls();
  updateLayoutStickerCount();
  updatePageNavigator();
}

// Add new page
function addLayoutPage() {
  saveCurrentPageState();
  layoutEditorState.pages.push({ stickers: [] });

  // Clear canvas and switch to new page (remove stickers and contours, keep boundaries)
  const canvas = layoutEditorState.canvas;
  const objects = canvas.getObjects().slice();
  objects.forEach(obj => {
    const isSticker = !!obj.stickerData;
    const isContour = obj.stroke === '#ef4444' || obj.stroke === '#22c55e';
    const isBoundary = obj.stroke === '#ccc' || obj.stroke === '#e0e0e0' || obj.stroke === '#333';

    if (isSticker) {
      if (obj.contourPath) canvas.remove(obj.contourPath);
      canvas.remove(obj);
    } else if (isContour && !isBoundary) {
      canvas.remove(obj);
    }
  });

  layoutEditorState.currentPage = layoutEditorState.pages.length - 1;
  canvas.renderAll();

  updateLayoutControls();
  updateLayoutStickerCount();
  updatePageNavigator();

  showToast(`Added page ${layoutEditorState.pages.length}`, 'success');
}

// Navigate to page
function goToLayoutPage(pageIndex) {
  if (pageIndex === layoutEditorState.currentPage) return;
  if (pageIndex < 0 || pageIndex >= layoutEditorState.pages.length) return;

  saveCurrentPageState();
  loadPageState(pageIndex);
}

// Update page navigator UI
function updatePageNavigator() {
  const navEl = document.getElementById('layoutPageNavigator');
  if (!navEl) return;

  const pages = layoutEditorState.pages;
  const currentPage = layoutEditorState.currentPage;

  navEl.innerHTML = pages.map((_, i) => `
    <button class="page-nav-btn ${i === currentPage ? 'active' : ''}"
            onclick="goToLayoutPage(${i})"
            title="Page ${i + 1}">
      ${i + 1}
    </button>
  `).join('');
}

// Populate available stickers from selection
function populateLayoutAvailableStickers(stickers) {
  console.log('[Layout Editor] populateLayoutAvailableStickers called with', stickers?.length || 0, 'stickers');
  layoutEditorState.availableStickers = stickers || [];

  const listEl = document.getElementById('layoutAvailableStickers');
  console.log('[Layout Editor] layoutAvailableStickers element:', listEl);
  if (!listEl) {
    console.error('[Layout Editor] layoutAvailableStickers element not found!');
    return;
  }

  if (!stickers || stickers.length === 0) {
    listEl.innerHTML = '<div class="placeholder" style="text-align:center;padding:20px;color:#888;">No stickers selected. Go to Manual Selection to choose stickers.</div>';
    return;
  }

  listEl.innerHTML = stickers.map((s, i) => {
    const imgUrl = getStickerImageUrl(s.thumbnailUrl || s.imageUrl || s.imagePath);
    const pathAttr = s.imagePath ? `data-path="${s.imagePath.replace(/"/g, '&quot;')}"` : '';
    return `
    <div class="layout-sticker-item" ${pathAttr} onclick="addStickerToLayoutByIndex(${i})" title="Click to add to layout">
      <img src="${imgUrl}" alt="${s.title || s.name}" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%23333%22 width=%22100%22 height=%22100%22/><text x=%2250%22 y=%2255%22 text-anchor=%22middle%22 fill=%22%23888%22 font-size=%2212%22>No Image</text></svg>'" />
      <span class="layout-sticker-name">${s.title || s.name || 'Sticker'}</span>
      <span class="layout-sticker-qty">x${s.quantity || 1}</span>
    </div>
  `;
  }).join('');
}

// Add sticker by index from available list
function addStickerToLayoutByIndex(index) {
  console.log('[Layout Editor] addStickerToLayoutByIndex called with index:', index);
  console.log('[Layout Editor] Available stickers:', layoutEditorState.availableStickers.length);

  const sticker = layoutEditorState.availableStickers[index];
  if (sticker) {
    console.log('[Layout Editor] Found sticker:', sticker.title || sticker.name);
    addStickerToLayout(sticker);
  } else {
    console.error('[Layout Editor] No sticker found at index:', index);
  }
}

// Export layout to server for sheet generation
async function exportLayoutForGeneration() {
  const pages = layoutEditorState.pages;
  const config = layoutEditorState.sheetConfig;
  const scale = config.displayScale;

  console.log('[Layout Export] Starting export, pages:', pages.length, 'scale:', scale);

  // Build export data for each page
  const exportData = {
    pages: [],
    sheetConfig: {
      widthInches: config.widthInches,
      heightInches: config.heightInches,
      dpi: config.dpi,
      marginInches: config.marginInches
    },
    stickerSizeInches: layoutEditorState.stickerSizeInches,
    offsetMm: layoutEditorState.offsetMm
  };

  // Save current page first
  saveCurrentPageState();

  for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
    const pageStickerData = [];

    // Get stickers from current canvas if it's the current page
    if (pageIdx === layoutEditorState.currentPage) {
      const canvas = layoutEditorState.canvas;
      const objects = canvas.getObjects().filter(obj => obj.stickerData);

      for (const obj of objects) {
        // Get the actual bounding rect which accounts for rotation
        // Pass true to get coordinates WITHOUT viewport transform (ignores zoom/pan)
        const boundingRect = obj.getBoundingRect(true, true);

        // Convert canvas coordinates back to actual pixel coordinates
        // Use bounding rect for position (top-left of rotated object)
        const actualX = boundingRect.left / scale;
        const actualY = boundingRect.top / scale;
        // Use bounding rect dimensions (size after rotation)
        const actualWidth = boundingRect.width / scale;
        const actualHeight = boundingRect.height / scale;

        const stickerExport = {
          imagePath: obj.stickerData.imagePath,
          title: obj.stickerData.title,
          x: Math.round(actualX),
          y: Math.round(actualY),
          width: Math.round(actualWidth),
          height: Math.round(actualHeight),
          angle: obj.angle || 0
        };

        // Include background-removed data if processed
        if (obj.stickerData.backgroundRemoved && obj.stickerData.processedDataUrl) {
          stickerExport.backgroundRemoved = true;
          stickerExport.processedDataUrl = obj.stickerData.processedDataUrl;
        }

        // Include custom contour if edited
        if (obj.stickerData.customContour && obj.stickerData.customContour.length > 0) {
          // Convert canvas coordinates to actual pixel coordinates
          stickerExport.customContour = obj.stickerData.customContour.map(p => ({
            x: Math.round(p.x / scale),
            y: Math.round(p.y / scale)
          }));
        }

        console.log('[Layout Export] Current canvas sticker:', stickerExport.title,
          'pos:', stickerExport.x, stickerExport.y,
          'size:', stickerExport.width, 'x', stickerExport.height,
          'path:', stickerExport.imagePath);
        pageStickerData.push(stickerExport);
      }
    } else {
      // Use saved page data
      for (const item of pages[pageIdx].stickers) {
        // Calculate actual dimensions from saved width/height and scale
        // item.width/height is the original fabric object dimensions
        // item.scaleX/scaleY is the applied scale
        const canvasWidth = (item.width || 100) * (item.scaleX || 1);
        const canvasHeight = (item.height || 100) * (item.scaleY || 1);
        const angle = item.angle || 0;

        // Calculate bounding box after rotation
        // item.left/top in Fabric.js is the center point
        let boundingLeft, boundingTop, boundingWidth, boundingHeight;

        if (angle !== 0) {
          // Calculate rotated bounding box dimensions
          const radians = (angle * Math.PI) / 180;
          const cos = Math.abs(Math.cos(radians));
          const sin = Math.abs(Math.sin(radians));
          boundingWidth = canvasWidth * cos + canvasHeight * sin;
          boundingHeight = canvasWidth * sin + canvasHeight * cos;
          // item.left/top is the center, calculate top-left of bounding box
          boundingLeft = item.left - boundingWidth / 2;
          boundingTop = item.top - boundingHeight / 2;
        } else {
          // No rotation - item.left/top is the center for originX/Y = 'center'
          // But Fabric default is originX/Y = 'left'/'top', so left/top IS top-left
          boundingLeft = item.left;
          boundingTop = item.top;
          boundingWidth = canvasWidth;
          boundingHeight = canvasHeight;
        }

        const actualX = boundingLeft / scale;
        const actualY = boundingTop / scale;
        const actualWidth = boundingWidth / scale;
        const actualHeight = boundingHeight / scale;

        const stickerExportItem = {
          imagePath: item.stickerData.imagePath,
          title: item.stickerData.title,
          x: Math.round(actualX),
          y: Math.round(actualY),
          width: Math.round(actualWidth),
          height: Math.round(actualHeight),
          angle: angle
        };

        // Include background-removed data if processed
        if (item.stickerData.backgroundRemoved && item.stickerData.processedDataUrl) {
          stickerExportItem.backgroundRemoved = true;
          stickerExportItem.processedDataUrl = item.stickerData.processedDataUrl;
        }

        // Include custom contour if available
        if (item.stickerData.customContour && item.stickerData.customContour.length > 0) {
          stickerExportItem.customContour = item.stickerData.customContour.map(p => ({
            x: Math.round(p.x / scale),
            y: Math.round(p.y / scale)
          }));
        }

        console.log('[Layout Export] Saved page sticker:', stickerExportItem.title,
          'pos:', stickerExportItem.x, stickerExportItem.y,
          'size:', stickerExportItem.width, 'x', stickerExportItem.height,
          'path:', stickerExportItem.imagePath);
        pageStickerData.push(stickerExportItem);
      }
    }

    console.log('[Layout Export] Page', pageIdx, 'has', pageStickerData.length, 'stickers');
    if (pageStickerData.length > 0) {
      exportData.pages.push({ stickers: pageStickerData });
    }
  }

  return exportData;
}

// Generate sheets from layout
async function generateSheetsFromLayout() {
  const generateBtn = document.getElementById('layoutGenerateBtn');
  const statusEl = document.getElementById('layoutStatus');

  if (generateBtn) {
    generateBtn.disabled = true;
    generateBtn.textContent = 'Generating...';
  }
  if (statusEl) statusEl.textContent = 'Generating sheets from layout...';

  try {
    const exportData = await exportLayoutForGeneration();

    if (exportData.pages.length === 0) {
      showToast('No stickers in layout to generate', 'error');
      return;
    }

    // Call server API to generate sheets from manual layout
    const result = await printStation.stickerSheets.generateFromLayout(exportData);

    if (result?.success) {
      // Store result - use window.stickersState if available from stickers-view.js
      if (window.stickersState) {
        window.stickersState.generatedSheets = result;
      }
      // Also store locally for layout editor use
      layoutEditorState.generatedSheets = result;

      if (statusEl) statusEl.textContent = `Generated ${result.totalSheets} sheet(s)`;

      // Call showStickersOutput if available (from stickers-view.js)
      if (typeof window.showStickersOutput === 'function') {
        window.showStickersOutput(result);
      }

      // Enable print/cut buttons
      const printBtn = document.getElementById('stickersPrintBtn');
      const sendCameoBtn = document.getElementById('stickersSendCameoBtn');
      if (printBtn) printBtn.disabled = false;
      if (sendCameoBtn) sendCameoBtn.disabled = false;

      showToast(`Generated ${result.totalSheets} sheet(s) successfully!`, 'success');
    } else {
      throw new Error(result?.error || 'Unknown error');
    }
  } catch (err) {
    console.error('[Layout Editor] Generation failed:', err);
    showToast('Failed to generate sheets: ' + err.message, 'error');
    if (statusEl) statusEl.textContent = 'Generation failed';
  } finally {
    if (generateBtn) {
      generateBtn.disabled = false;
      generateBtn.textContent = 'Generate Sheets';
    }
  }
}

// Clear the layout editor
function clearLayoutEditor() {
  const canvas = layoutEditorState.canvas;
  if (!canvas) return;

  // Remove all stickers and contours (keep boundaries)
  const objects = canvas.getObjects().slice();
  objects.forEach(obj => {
    const isSticker = !!obj.stickerData;
    const isContour = obj.stroke === '#ef4444' || obj.stroke === '#22c55e';
    const isBoundary = obj.stroke === '#ccc' || obj.stroke === '#e0e0e0' || obj.stroke === '#333';

    if (isSticker) {
      if (obj.contourPath) canvas.remove(obj.contourPath);
      canvas.remove(obj);
    } else if (isContour && !isBoundary) {
      canvas.remove(obj);
    }
  });

  // Reset to single page
  layoutEditorState.pages = [{ stickers: [] }];
  layoutEditorState.currentPage = 0;

  canvas.renderAll();
  updateLayoutControls();
  updateLayoutStickerCount();
  updatePageNavigator();
}

// Toggle contour visibility
function toggleContourVisibility() {
  const canvas = layoutEditorState.canvas;
  if (!canvas) return;

  const contourObjects = canvas.getObjects().filter(obj =>
    obj.stroke === '#ef4444' && !obj.stickerData
  );

  const isVisible = contourObjects.length > 0 && contourObjects[0].visible;

  contourObjects.forEach(obj => {
    obj.visible = !isVisible;
  });

  canvas.renderAll();

  const toggleBtn = document.getElementById('layoutContourToggle');
  if (toggleBtn) {
    toggleBtn.textContent = isVisible ? 'Show Contours' : 'Hide Contours';
  }
}

// Update sticker size for new additions
function updateLayoutStickerSize(sizeInches) {
  layoutEditorState.stickerSizeInches = parseFloat(sizeInches) || 3;

  const sizeDisplay = document.getElementById('layoutSizeDisplay');
  if (sizeDisplay) {
    sizeDisplay.textContent = `${layoutEditorState.stickerSizeInches}"`;
  }
}

// Update contour offset
function updateLayoutOffset(offsetMm) {
  layoutEditorState.offsetMm = parseFloat(offsetMm) || 0.25;
}

// Switch to layout mode
function switchToLayoutMode() {
  // Get current selection from stickers state (use window reference since it's in stickers-view.js)
  const selection = window.stickersState?.selection;
  if (!selection) {
    console.error('[Layout Editor] stickersState.selection not available');
    showToast('No stickers selected. Select stickers in Manual Selection first.', 'error');
    return;
  }
  const stickersArray = Array.from(selection.values());
  console.log('[Layout Editor] switchToLayoutMode - stickers selected:', stickersArray.length, stickersArray);

  // Initialize layout editor if needed
  if (!layoutEditorState.isInitialized) {
    console.log('[Layout Editor] Initializing layout editor...');
    initLayoutEditor();
  } else {
    console.log('[Layout Editor] Already initialized, canvas:', layoutEditorState.canvas);
  }

  // Populate available stickers
  console.log('[Layout Editor] Populating available stickers...');
  populateLayoutAvailableStickers(stickersArray);

  // Show layout panel, hide other panels
  const layoutPanel = document.getElementById('layoutEditorPanel');
  const orderPanel = document.getElementById('stickersOrderPanel');
  const manualPanel = document.getElementById('stickersManualPanel');

  if (layoutPanel) layoutPanel.style.display = 'flex';
  if (orderPanel) orderPanel.style.display = 'none';
  if (manualPanel) manualPanel.style.display = 'none';

  // Show layout-specific side panels, hide others
  const layoutAvailablePanel = document.getElementById('layoutAvailableStickerPanel');
  const layoutGeneratePanel = document.getElementById('layoutGeneratePanel');
  const currentOrderPanel = document.getElementById('stickersCurrentOrder');

  if (layoutAvailablePanel) layoutAvailablePanel.style.display = 'flex';
  if (layoutGeneratePanel) layoutGeneratePanel.style.display = 'block';
  if (currentOrderPanel) currentOrderPanel.style.display = 'none';

  // Update mode buttons
  updateLayoutModeButtons('layout');
  updatePageNavigator();
}

// Update mode button states
function updateLayoutModeButtons(activeMode) {
  const orderBtn = document.getElementById('stickersModeOrder');
  const manualBtn = document.getElementById('stickersModeManual');
  const layoutBtn = document.getElementById('stickersModeLayout');

  const buttons = [orderBtn, manualBtn, layoutBtn];

  buttons.forEach(btn => {
    if (!btn) return;
    if (btn.id === `stickersMode${activeMode.charAt(0).toUpperCase() + activeMode.slice(1)}`) {
      btn.classList.add('active');
      btn.style.background = 'var(--primary)';
      btn.style.color = 'white';
    } else {
      btn.classList.remove('active');
      btn.style.background = 'var(--card)';
      btn.style.color = 'var(--text)';
    }
  });
}

// ============================================
// CONTOUR EDITING FUNCTIONS
// ============================================

// Enter contour edit mode for the selected sticker
function enterContourEditMode() {
  const canvas = layoutEditorState.canvas;
  const activeObject = canvas.getActiveObject();

  if (!activeObject || !activeObject.stickerData) {
    showToast('Select a sticker first', 'error');
    return;
  }

  // Exit any existing edit mode first
  if (layoutEditorState.contourEditMode) {
    exitContourEditMode(false);
  }

  layoutEditorState.contourEditMode = true;
  layoutEditorState.editingSticker = activeObject;

  // Ensure contour position is synced with sticker before editing
  updateContourPosition(activeObject);
  canvas.renderAll();

  // Lock the sticker from being moved while editing contour
  activeObject.set({
    selectable: false,
    evented: false
  });

  // Get the contour path or create default points
  const contourPath = activeObject.contourPath;
  let points = [];

  if (contourPath && contourPath.path) {
    // Ensure coords are updated before extracting points
    contourPath.setCoords();
    // Extract points from fabric.Path
    points = extractPointsFromPath(contourPath);
  } else {
    // Create rectangular default contour points
    const config = layoutEditorState.sheetConfig;
    const scale = config.displayScale;
    const offsetPx = (layoutEditorState.offsetMm / 25.4) * config.dpi * scale;

    const left = activeObject.left - offsetPx;
    const top = activeObject.top - offsetPx;
    const width = activeObject.width * activeObject.scaleX + offsetPx * 2;
    const height = activeObject.height * activeObject.scaleY + offsetPx * 2;

    points = [
      { x: left, y: top },
      { x: left + width, y: top },
      { x: left + width, y: top + height },
      { x: left, y: top + height }
    ];
  }

  layoutEditorState.contourPoints = points;

  // Create draggable handles for each point
  createContourHandles(points);

  // Update the contour path to show as editable
  if (contourPath) {
    contourPath.set({
      stroke: '#22c55e',
      strokeWidth: 2,
      strokeDashArray: null
    });
  }

  canvas.renderAll();

  // Update UI
  updateContourEditUI(true);

  console.log('[Layout Editor] Entered contour edit mode with', points.length, 'points');
}

// Extract points from a fabric.Path object
function extractPointsFromPath(pathObj) {
  const points = [];

  if (!pathObj || !pathObj.path) {
    return points;
  }

  // Get path data - fabric stores it as array of commands
  const pathData = pathObj.path;

  // For paths with originX/Y: 'center', Fabric positions the path by its center
  // but the path coordinates are in their own local space
  // We need to use the path's own offset properties
  const pathOffset = {
    x: pathObj.pathOffset ? pathObj.pathOffset.x : 0,
    y: pathObj.pathOffset ? pathObj.pathOffset.y : 0
  };

  // Get the position and scale of the path object
  const left = pathObj.left || 0;
  const top = pathObj.top || 0;
  const scaleX = pathObj.scaleX || 1;
  const scaleY = pathObj.scaleY || 1;
  const angle = pathObj.angle || 0;

  // Convert angle to radians
  const radians = (angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);

  for (const cmd of pathData) {
    let rawPoint = null;

    if (cmd[0] === 'M' || cmd[0] === 'L') {
      rawPoint = { x: cmd[1], y: cmd[2] };
    } else if (cmd[0] === 'C') {
      rawPoint = { x: cmd[5], y: cmd[6] };
    } else if (cmd[0] === 'Q') {
      rawPoint = { x: cmd[3], y: cmd[4] };
    }

    if (rawPoint) {
      // Step 1: Subtract path offset (path's internal origin)
      let x = rawPoint.x - pathOffset.x;
      let y = rawPoint.y - pathOffset.y;

      // Step 2: Apply scale
      x *= scaleX;
      y *= scaleY;

      // Step 3: Apply rotation around origin
      const rotatedX = x * cos - y * sin;
      const rotatedY = x * sin + y * cos;

      // Step 4: Translate to canvas position (path center is at left, top)
      const finalX = rotatedX + left;
      const finalY = rotatedY + top;

      points.push({ x: finalX, y: finalY });
    }
  }

  return points;
}

// Create draggable handles for contour points
function createContourHandles(points) {
  const canvas = layoutEditorState.canvas;
  layoutEditorState.contourHandles = [];

  points.forEach((point, index) => {
    const handle = new fabric.Circle({
      left: point.x,
      top: point.y,
      radius: 6,
      fill: '#22c55e',
      stroke: '#ffffff',
      strokeWidth: 2,
      originX: 'center',
      originY: 'center',
      hasControls: false,
      hasBorders: false,
      selectable: true,
      evented: true,
      hoverCursor: 'grab',
      moveCursor: 'grabbing'
    });

    handle.pointIndex = index;
    handle.isContourHandle = true;

    // Handle drag events
    handle.on('moving', function() {
      updateContourFromHandles();
    });

    handle.on('modified', function() {
      saveContourChanges();
    });

    canvas.add(handle);
    layoutEditorState.contourHandles.push(handle);
  });

  // Draw connecting lines between points
  updateContourLine();
}

// Update the contour line based on current handle positions
function updateContourLine() {
  const canvas = layoutEditorState.canvas;
  const handles = layoutEditorState.contourHandles;

  // Remove existing contour line
  const existingLine = canvas.getObjects().find(obj => obj.isContourLine);
  if (existingLine) {
    canvas.remove(existingLine);
  }

  if (handles.length < 2) return;

  // Create path string from handle positions
  const points = handles.map(h => ({ x: h.left, y: h.top }));
  let pathStr = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i++) {
    pathStr += ` L ${points[i].x} ${points[i].y}`;
  }
  pathStr += ' Z';

  const contourLine = new fabric.Path(pathStr, {
    fill: 'transparent',
    stroke: '#22c55e',
    strokeWidth: 2,
    selectable: false,
    evented: false
  });
  contourLine.isContourLine = true;

  // Add behind the handles
  canvas.add(contourLine);
  contourLine.sendToBack();

  // Make sure sticker image is behind the contour line
  const sticker = layoutEditorState.editingSticker;
  if (sticker) {
    sticker.sendToBack();
  }
}

// Update contour points from handle positions
function updateContourFromHandles() {
  const handles = layoutEditorState.contourHandles;
  layoutEditorState.contourPoints = handles.map(h => ({
    x: h.left,
    y: h.top
  }));
  updateContourLine();
}

// Save contour changes to the sticker
function saveContourChanges() {
  const sticker = layoutEditorState.editingSticker;
  if (!sticker) return;

  const points = layoutEditorState.contourPoints;

  // Store custom contour points on the sticker
  sticker.stickerData.customContour = points.map(p => ({ x: p.x, y: p.y }));

  console.log('[Layout Editor] Saved contour with', points.length, 'points');
}

// Add a point to the contour
function addContourPoint() {
  const canvas = layoutEditorState.canvas;
  const handles = layoutEditorState.contourHandles;
  const points = layoutEditorState.contourPoints;

  if (points.length < 2) return;

  // Find the longest edge and add a point in the middle
  let maxDist = 0;
  let maxIdx = 0;

  for (let i = 0; i < points.length; i++) {
    const next = (i + 1) % points.length;
    const dx = points[next].x - points[i].x;
    const dy = points[next].y - points[i].y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > maxDist) {
      maxDist = dist;
      maxIdx = i;
    }
  }

  // Insert new point
  const nextIdx = (maxIdx + 1) % points.length;
  const newPoint = {
    x: (points[maxIdx].x + points[nextIdx].x) / 2,
    y: (points[maxIdx].y + points[nextIdx].y) / 2
  };

  // Insert into points array
  points.splice(nextIdx, 0, newPoint);
  layoutEditorState.contourPoints = points;

  // Recreate all handles
  clearContourHandles();
  createContourHandles(points);

  canvas.renderAll();
  saveContourChanges();

  showToast('Added contour point', 'success');
}

// Remove the selected contour point
function removeContourPoint() {
  const canvas = layoutEditorState.canvas;
  const activeObject = canvas.getActiveObject();

  if (!activeObject || !activeObject.isContourHandle) {
    showToast('Select a contour point to remove', 'error');
    return;
  }

  if (layoutEditorState.contourPoints.length <= 3) {
    showToast('Contour must have at least 3 points', 'error');
    return;
  }

  const pointIndex = activeObject.pointIndex;
  layoutEditorState.contourPoints.splice(pointIndex, 1);

  // Recreate handles
  clearContourHandles();
  createContourHandles(layoutEditorState.contourPoints);

  canvas.renderAll();
  saveContourChanges();

  showToast('Removed contour point', 'success');
}

// Clear all contour handles
function clearContourHandles() {
  const canvas = layoutEditorState.canvas;

  // Remove handles
  layoutEditorState.contourHandles.forEach(handle => {
    canvas.remove(handle);
  });
  layoutEditorState.contourHandles = [];

  // Remove contour line
  const existingLine = canvas.getObjects().find(obj => obj.isContourLine);
  if (existingLine) {
    canvas.remove(existingLine);
  }
}

// Exit contour edit mode
function exitContourEditMode(save = true) {
  const canvas = layoutEditorState.canvas;
  const sticker = layoutEditorState.editingSticker;

  if (!layoutEditorState.contourEditMode) return;

  if (save && sticker) {
    saveContourChanges();

    // Update the sticker's contour path with new points
    const points = layoutEditorState.contourPoints;

    // Remove old contour
    if (sticker.contourPath) {
      canvas.remove(sticker.contourPath);
    }

    // Create new contour path
    if (points.length >= 3) {
      let pathStr = `M ${points[0].x} ${points[0].y}`;
      for (let i = 1; i < points.length; i++) {
        pathStr += ` L ${points[i].x} ${points[i].y}`;
      }
      pathStr += ' Z';

      const newContour = new fabric.Path(pathStr, {
        fill: 'transparent',
        stroke: '#ef4444',
        strokeWidth: 1.5,
        strokeDashArray: [4, 2],
        selectable: false,
        evented: false
      });

      sticker.contourPath = newContour;
      canvas.add(newContour);
    }
  }

  // Clear edit state
  clearContourHandles();

  // Unlock the sticker
  if (sticker) {
    sticker.set({
      selectable: true,
      evented: true
    });
  }

  layoutEditorState.contourEditMode = false;
  layoutEditorState.editingSticker = null;
  layoutEditorState.contourPoints = [];

  canvas.discardActiveObject();
  canvas.renderAll();

  // Update UI
  updateContourEditUI(false);

  console.log('[Layout Editor] Exited contour edit mode');
}

// Update UI for contour edit mode
function updateContourEditUI(isEditing) {
  console.log('[Layout Editor] updateContourEditUI called with isEditing:', isEditing);

  const editBtn = document.getElementById('layoutEditContourBtn');
  const doneBtn = document.getElementById('layoutDoneEditingBtn');
  const addPointBtn = document.getElementById('layoutAddPointBtn');
  const removePointBtn = document.getElementById('layoutRemovePointBtn');

  // Contour shape buttons
  const circleBtn = document.getElementById('layoutCircleContourBtn');
  const roundedBtn = document.getElementById('layoutRoundedRectBtn');
  const squareBtn = document.getElementById('layoutSquareContourBtn');
  const smoothBtn = document.getElementById('layoutSmoothContourBtn');

  console.log('[Layout Editor] Shape buttons found:', {
    circle: circleBtn,
    rounded: roundedBtn,
    square: squareBtn,
    smooth: smoothBtn,
    circleParent: circleBtn?.parentElement,
    circleCurrentDisplay: circleBtn?.style?.display,
    circleComputedDisplay: circleBtn ? window.getComputedStyle(circleBtn).display : 'N/A'
  });

  // Standard controls
  const rotateBtn = document.getElementById('layoutRotateBtn');
  const scaleUpBtn = document.getElementById('layoutScaleUpBtn');
  const scaleDownBtn = document.getElementById('layoutScaleDownBtn');
  const deleteBtn = document.getElementById('layoutDeleteBtn');
  const removeBgBtn = document.getElementById('layoutRemoveBgBtn');
  const refreshContourBtn = document.getElementById('layoutRefreshContourBtn');

  if (isEditing) {
    if (editBtn) editBtn.style.display = 'none';
    if (doneBtn) doneBtn.style.display = 'inline-block';
    if (addPointBtn) addPointBtn.style.display = 'inline-block';
    if (removePointBtn) removePointBtn.style.display = 'inline-block';

    // Show contour shape buttons - use setAttribute for maximum compatibility
    if (circleBtn) {
      circleBtn.style.setProperty('display', 'inline-block', 'important');
      console.log('[Layout Editor] Set circle button display to inline-block, now:', circleBtn.style.display);
    }
    if (roundedBtn) {
      roundedBtn.style.setProperty('display', 'inline-block', 'important');
      console.log('[Layout Editor] Set rounded button display to inline-block');
    }
    if (squareBtn) {
      squareBtn.style.setProperty('display', 'inline-block', 'important');
      console.log('[Layout Editor] Set square button display to inline-block');
    }
    if (smoothBtn) {
      smoothBtn.style.setProperty('display', 'inline-block', 'important');
      console.log('[Layout Editor] Set smooth button display to inline-block');
    }

    // Hide standard controls while editing contour
    if (rotateBtn) rotateBtn.style.display = 'none';
    if (scaleUpBtn) scaleUpBtn.style.display = 'none';
    if (scaleDownBtn) scaleDownBtn.style.display = 'none';
    if (deleteBtn) deleteBtn.style.display = 'none';
    if (removeBgBtn) removeBgBtn.style.display = 'none';
    if (refreshContourBtn) refreshContourBtn.style.display = 'none';
  } else {
    if (editBtn) editBtn.style.display = 'inline-block';
    if (doneBtn) doneBtn.style.display = 'none';
    if (addPointBtn) addPointBtn.style.display = 'none';
    if (removePointBtn) removePointBtn.style.display = 'none';

    // Hide contour shape buttons
    if (circleBtn) circleBtn.style.display = 'none';
    if (roundedBtn) roundedBtn.style.display = 'none';
    if (squareBtn) squareBtn.style.display = 'none';
    if (smoothBtn) smoothBtn.style.display = 'none';

    // Show standard controls
    if (rotateBtn) rotateBtn.style.display = 'inline-block';
    if (scaleUpBtn) scaleUpBtn.style.display = 'inline-block';
    if (scaleDownBtn) scaleDownBtn.style.display = 'inline-block';
    if (deleteBtn) deleteBtn.style.display = 'inline-block';
    if (removeBgBtn) removeBgBtn.style.display = 'inline-block';
    if (refreshContourBtn) refreshContourBtn.style.display = 'inline-block';
  }
}

// Reset contour to default (rectangle around sticker)
function resetContourToDefault() {
  const sticker = layoutEditorState.editingSticker;
  if (!sticker) return;

  const config = layoutEditorState.sheetConfig;
  const scale = config.displayScale;
  const offsetPx = (layoutEditorState.offsetMm / 25.4) * config.dpi * scale;

  const left = sticker.left - offsetPx;
  const top = sticker.top - offsetPx;
  const width = sticker.width * sticker.scaleX + offsetPx * 2;
  const height = sticker.height * sticker.scaleY + offsetPx * 2;

  const points = [
    { x: left, y: top },
    { x: left + width, y: top },
    { x: left + width, y: top + height },
    { x: left, y: top + height }
  ];

  layoutEditorState.contourPoints = points;

  // Recreate handles
  clearContourHandles();
  createContourHandles(points);

  layoutEditorState.canvas.renderAll();
  saveContourChanges();

  showToast('Reset contour to default', 'success');
}

// Set contour to circular/elliptical shape
function setContourToCircle(numPoints = 16) {
  const sticker = layoutEditorState.editingSticker;
  if (!sticker) {
    showToast('Enter contour edit mode first', 'error');
    return;
  }

  const config = layoutEditorState.sheetConfig;
  const scale = config.displayScale;
  const offsetPx = (layoutEditorState.offsetMm / 25.4) * config.dpi * scale;

  // Calculate center and radius based on sticker bounds
  const width = sticker.width * sticker.scaleX;
  const height = sticker.height * sticker.scaleY;
  const centerX = sticker.left + width / 2;
  const centerY = sticker.top + height / 2;

  // Use an ellipse that fits around the sticker with offset
  const radiusX = (width / 2) + offsetPx;
  const radiusY = (height / 2) + offsetPx;

  // Generate points around the ellipse
  const points = [];
  for (let i = 0; i < numPoints; i++) {
    const angle = (i / numPoints) * 2 * Math.PI;
    points.push({
      x: centerX + radiusX * Math.cos(angle),
      y: centerY + radiusY * Math.sin(angle)
    });
  }

  layoutEditorState.contourPoints = points;

  // Recreate handles
  clearContourHandles();
  createContourHandles(points);

  layoutEditorState.canvas.renderAll();
  saveContourChanges();

  showToast('Contour set to circle (' + numPoints + ' points)', 'success');
}

// Set contour to rounded rectangle
function setContourToRoundedRect(cornerRadius = 20) {
  const sticker = layoutEditorState.editingSticker;
  if (!sticker) {
    showToast('Enter contour edit mode first', 'error');
    return;
  }

  const config = layoutEditorState.sheetConfig;
  const scale = config.displayScale;
  const offsetPx = (layoutEditorState.offsetMm / 25.4) * config.dpi * scale;

  const left = sticker.left - offsetPx;
  const top = sticker.top - offsetPx;
  const width = sticker.width * sticker.scaleX + offsetPx * 2;
  const height = sticker.height * sticker.scaleY + offsetPx * 2;

  // Clamp corner radius to half of smallest dimension
  const maxRadius = Math.min(width, height) / 2;
  const r = Math.min(cornerRadius, maxRadius);

  // Generate points for rounded rectangle (4 points per corner arc)
  const points = [];
  const pointsPerCorner = 4;

  // Top-right corner
  for (let i = 0; i <= pointsPerCorner; i++) {
    const angle = -Math.PI / 2 + (i / pointsPerCorner) * (Math.PI / 2);
    points.push({
      x: left + width - r + r * Math.cos(angle),
      y: top + r + r * Math.sin(angle)
    });
  }

  // Bottom-right corner
  for (let i = 0; i <= pointsPerCorner; i++) {
    const angle = 0 + (i / pointsPerCorner) * (Math.PI / 2);
    points.push({
      x: left + width - r + r * Math.cos(angle),
      y: top + height - r + r * Math.sin(angle)
    });
  }

  // Bottom-left corner
  for (let i = 0; i <= pointsPerCorner; i++) {
    const angle = Math.PI / 2 + (i / pointsPerCorner) * (Math.PI / 2);
    points.push({
      x: left + r + r * Math.cos(angle),
      y: top + height - r + r * Math.sin(angle)
    });
  }

  // Top-left corner
  for (let i = 0; i <= pointsPerCorner; i++) {
    const angle = Math.PI + (i / pointsPerCorner) * (Math.PI / 2);
    points.push({
      x: left + r + r * Math.cos(angle),
      y: top + r + r * Math.sin(angle)
    });
  }

  layoutEditorState.contourPoints = points;

  // Recreate handles
  clearContourHandles();
  createContourHandles(points);

  layoutEditorState.canvas.renderAll();
  saveContourChanges();

  showToast('Contour set to rounded rectangle', 'success');
}

// Smooth out blocky contours using Chaikin's corner-cutting algorithm
// This creates smoother curves by cutting corners iteratively
function smoothContour(iterations = 2) {
  const sticker = layoutEditorState.editingSticker;
  if (!sticker) {
    showToast('Enter contour edit mode first', 'error');
    return;
  }

  let points = layoutEditorState.contourPoints;
  if (!points || points.length < 3) {
    showToast('Need at least 3 points to smooth', 'error');
    return;
  }

  // Chaikin's algorithm: for each edge, create two new points at 25% and 75%
  // This effectively "cuts corners" and smooths the polygon
  for (let iter = 0; iter < iterations; iter++) {
    const smoothed = [];
    const n = points.length;

    for (let i = 0; i < n; i++) {
      const p0 = points[i];
      const p1 = points[(i + 1) % n];

      // First point at 25% along the edge
      smoothed.push({
        x: p0.x * 0.75 + p1.x * 0.25,
        y: p0.y * 0.75 + p1.y * 0.25
      });

      // Second point at 75% along the edge
      smoothed.push({
        x: p0.x * 0.25 + p1.x * 0.75,
        y: p0.y * 0.25 + p1.y * 0.75
      });
    }

    points = smoothed;
  }

  layoutEditorState.contourPoints = points;

  // Recreate handles
  clearContourHandles();
  createContourHandles(points);

  layoutEditorState.canvas.renderAll();
  saveContourChanges();

  showToast(`Contour smoothed (${points.length} points)`, 'success');
}

// ============================================
// ZOOM AND PAN FUNCTIONS
// ============================================

// Zoom the canvas by a direction (-1 for out, +1 for in)
function zoomLayoutCanvas(direction) {
  const canvas = layoutEditorState.canvas;
  if (!canvas) return;

  const step = layoutEditorState.zoomStep;
  let newZoom = layoutEditorState.zoomLevel + (direction * step);

  // Clamp to min/max
  newZoom = Math.max(layoutEditorState.minZoom, Math.min(layoutEditorState.maxZoom, newZoom));

  setLayoutZoom(newZoom);
}

// Set a specific zoom level
function setLayoutZoom(zoomLevel, point) {
  const canvas = layoutEditorState.canvas;
  if (!canvas) return;

  // Clamp zoom level
  zoomLevel = Math.max(layoutEditorState.minZoom, Math.min(layoutEditorState.maxZoom, zoomLevel));

  // If no point specified, zoom toward center
  if (!point) {
    point = {
      x: canvas.getWidth() / 2,
      y: canvas.getHeight() / 2
    };
  }

  // Use Fabric.js zoom to point
  canvas.zoomToPoint(point, zoomLevel);

  layoutEditorState.zoomLevel = zoomLevel;
  updateZoomDisplay();

  console.log('[Layout Editor] Zoom set to:', Math.round(zoomLevel * 100) + '%');
}

// Reset zoom to fit the canvas
function resetLayoutZoom() {
  const canvas = layoutEditorState.canvas;
  if (!canvas) return;

  // Reset viewport transform to identity
  canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
  layoutEditorState.zoomLevel = 1;
  updateZoomDisplay();

  console.log('[Layout Editor] Zoom reset to 100%');
}

// Update the zoom level display
function updateZoomDisplay() {
  const zoomEl = document.getElementById('layoutZoomLevel');
  if (zoomEl) {
    zoomEl.textContent = Math.round(layoutEditorState.zoomLevel * 100) + '%';
  }
}

// Handle mouse wheel for zoom and scroll/pan
function handleCanvasWheel(opt) {
  const e = opt.e;
  const canvas = layoutEditorState.canvas;

  // Ctrl+scroll = Zoom
  if (e.ctrlKey) {
    e.preventDefault();
    e.stopPropagation();

    const delta = e.deltaY;
    let zoomDirection = delta > 0 ? -1 : 1;

    // Get mouse position relative to canvas
    const pointer = canvas.getPointer(e, true);

    // Calculate new zoom
    const step = layoutEditorState.zoomStep;
    let newZoom = layoutEditorState.zoomLevel + (zoomDirection * step);
    newZoom = Math.max(layoutEditorState.minZoom, Math.min(layoutEditorState.maxZoom, newZoom));

    setLayoutZoom(newZoom, pointer);
    return;
  }

  // Regular scroll = Pan when zoomed in
  if (layoutEditorState.zoomLevel > 1) {
    e.preventDefault();
    e.stopPropagation();

    const vpt = canvas.viewportTransform;

    // Shift+scroll = horizontal pan, regular scroll = vertical pan
    if (e.shiftKey) {
      vpt[4] -= e.deltaY; // Horizontal pan
    } else {
      vpt[4] -= e.deltaX; // Horizontal from trackpad
      vpt[5] -= e.deltaY; // Vertical pan
    }

    canvas.requestRenderAll();
  }
}

// Setup panning (drag canvas when holding spacebar or middle mouse)
function setupCanvasPanning() {
  const canvas = layoutEditorState.canvas;
  if (!canvas) return;

  let spacePressed = false;

  // Track spacebar state
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !spacePressed) {
      const editorPanel = document.getElementById('layoutEditorPanel');
      if (!editorPanel || editorPanel.style.display === 'none') return;

      spacePressed = true;
      canvas.defaultCursor = 'grab';
      canvas.hoverCursor = 'grab';
      canvas.selection = false;
      e.preventDefault();
    }
  });

  document.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      spacePressed = false;
      canvas.defaultCursor = 'default';
      canvas.hoverCursor = 'move';
      canvas.selection = true;
    }
  });

  // Mouse down - start panning
  canvas.on('mouse:down', function(opt) {
    const e = opt.e;

    // Pan with spacebar + click or middle mouse button
    if (spacePressed || e.button === 1) {
      layoutEditorState.isPanning = true;
      layoutEditorState.lastPanPosition = { x: e.clientX, y: e.clientY };
      canvas.defaultCursor = 'grabbing';
      e.preventDefault();
    }
  });

  // Mouse move - pan if dragging
  canvas.on('mouse:move', function(opt) {
    if (!layoutEditorState.isPanning) return;

    const e = opt.e;
    const vpt = canvas.viewportTransform;
    const dx = e.clientX - layoutEditorState.lastPanPosition.x;
    const dy = e.clientY - layoutEditorState.lastPanPosition.y;

    vpt[4] += dx;
    vpt[5] += dy;

    canvas.requestRenderAll();
    layoutEditorState.lastPanPosition = { x: e.clientX, y: e.clientY };
  });

  // Mouse up - stop panning
  canvas.on('mouse:up', function(opt) {
    if (layoutEditorState.isPanning) {
      layoutEditorState.isPanning = false;
      canvas.defaultCursor = spacePressed ? 'grab' : 'default';
    }
  });

  // Mouse wheel zoom
  canvas.on('mouse:wheel', handleCanvasWheel);
}

// Add keyboard shortcuts for zoom
function setupZoomKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Only handle if layout editor is visible
    const editorPanel = document.getElementById('layoutEditorPanel');
    if (!editorPanel || editorPanel.style.display === 'none') return;

    // Ctrl/Cmd + Plus = Zoom In
    if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '=')) {
      e.preventDefault();
      zoomLayoutCanvas(1);
    }
    // Ctrl/Cmd + Minus = Zoom Out
    else if ((e.ctrlKey || e.metaKey) && e.key === '-') {
      e.preventDefault();
      zoomLayoutCanvas(-1);
    }
    // Ctrl/Cmd + 0 = Reset Zoom
    else if ((e.ctrlKey || e.metaKey) && e.key === '0') {
      e.preventDefault();
      resetLayoutZoom();
    }
  });
}

// Export functions for global access
window.initLayoutEditor = initLayoutEditor;
window.addStickerToLayout = addStickerToLayout;
/**
 * Refresh the contour for the selected sticker by re-fetching from server
 * Forces a fresh contour generation, bypassing cache
 */
async function refreshSelectedContour() {
  const canvas = layoutEditorState.canvas;
  if (!canvas) return;

  const activeObject = canvas.getActiveObject();
  if (!activeObject || !activeObject.stickerData) {
    showToast('Select a sticker first', 'error');
    return;
  }

  const imagePath = activeObject.stickerData.imagePath;
  if (!imagePath) {
    showToast('Sticker has no image path', 'error');
    return;
  }

  const refreshBtn = document.getElementById('layoutRefreshContourBtn');
  if (refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.textContent = '↻ Loading...';
  }

  try {
    // Clear from cache to force re-fetch
    layoutEditorState.contourCache.delete(imagePath);

    // Clear any custom contour so we get the server-generated one
    delete activeObject.stickerData.customContour;

    // Fetch fresh contour from server (forceRegenerate could be added to API if needed)
    const contourData = await fetchStickerContour(imagePath);

    if (!contourData || !contourData.svgPath) {
      throw new Error('No contour data returned from server');
    }

    const config = layoutEditorState.sheetConfig;
    const scale = config.displayScale;
    const offsetMm = layoutEditorState.offsetMm;

    const targetWidth = activeObject.width * activeObject.scaleX;
    const targetHeight = activeObject.height * activeObject.scaleY;

    // Create new contour from fetched SVG path
    const newContour = createContourFromSvgPath(
      contourData.svgPath,
      contourData.width,
      contourData.height,
      targetWidth / scale,
      targetHeight / scale,
      scale,
      offsetMm
    );

    if (newContour) {
      // Remove old contour
      if (activeObject.contourPath) {
        canvas.remove(activeObject.contourPath);
      }

      // Set solid stroke to indicate real contour
      newContour.set({
        stroke: '#ef4444',
        strokeDashArray: null,
        strokeWidth: 1.5
      });

      // Attach and position
      activeObject.contourPath = newContour;
      activeObject.stickerData.hasBezierContour = true;
      updateContourPosition(activeObject);
      canvas.add(newContour);
      canvas.renderAll();

      saveCurrentPageState();
      showToast('Contour refreshed!', 'success');
      console.log('[Contour] Refreshed contour for:', imagePath);
    } else {
      throw new Error('Failed to create contour from SVG path');
    }

  } catch (err) {
    console.error('[Contour] Refresh failed:', err);
    showToast('Failed to refresh contour: ' + err.message, 'error');
  } finally {
    if (refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.textContent = '↻ Refresh';
    }
  }
}

window.addStickerToLayoutByIndex = addStickerToLayoutByIndex;
window.removeStickerFromLayout = removeStickerFromLayout;
window.rotateSelectedSticker = rotateSelectedSticker;
window.scaleSelectedSticker = scaleSelectedSticker;
window.removeSelectedStickerBackground = removeSelectedStickerBackground;
window.addLayoutPage = addLayoutPage;
window.goToLayoutPage = goToLayoutPage;
window.generateSheetsFromLayout = generateSheetsFromLayout;
window.clearLayoutEditor = clearLayoutEditor;
window.toggleContourVisibility = toggleContourVisibility;
window.updateLayoutStickerSize = updateLayoutStickerSize;
window.updateLayoutOffset = updateLayoutOffset;
window.switchToLayoutMode = switchToLayoutMode;
window.exportLayoutForGeneration = exportLayoutForGeneration;
window.populateLayoutAvailableStickers = populateLayoutAvailableStickers;
window.layoutEditorState = layoutEditorState;

// Contour editing exports
window.enterContourEditMode = enterContourEditMode;
window.exitContourEditMode = exitContourEditMode;
window.addContourPoint = addContourPoint;
window.removeContourPoint = removeContourPoint;
window.resetContourToDefault = resetContourToDefault;
window.setContourToCircle = setContourToCircle;
window.setContourToRoundedRect = setContourToRoundedRect;
window.refreshSelectedContour = refreshSelectedContour;

// Zoom and pan exports
window.zoomLayoutCanvas = zoomLayoutCanvas;
window.setLayoutZoom = setLayoutZoom;
window.resetLayoutZoom = resetLayoutZoom;

// Crop exports
window.enterCropMode = enterCropMode;
window.applyCrop = applyCrop;
window.cancelCrop = cancelCrop;
