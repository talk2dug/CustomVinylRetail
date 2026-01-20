/**
 * Mockup Pro - Advanced Mockup Generator
 * Hybrid 2D (Fabric.js) + 3D (Three.js) mockup tool
 */

console.log('Mockup Pro: Script loading...');

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DecalGeometry } from 'three/addons/geometries/DecalGeometry.js';
import { ApparelBrowser } from './apparel-browser.js';

console.log('Mockup Pro: All imports loaded', { THREE, OrbitControls, GLTFLoader });

// ========================================
// CONFIGURATION
// ========================================

const CONFIG = {
  // Canvas dimensions
  canvasWidth: 800,
  canvasHeight: 800,

  // Design zones (relative to canvas, 0-1 range)
  zones: {
    front: { x: 0.25, y: 0.2, width: 0.5, height: 0.5 },
    back: { x: 0.25, y: 0.2, width: 0.5, height: 0.5 },
    'left-sleeve': { x: 0.05, y: 0.15, width: 0.25, height: 0.6 },
    'right-sleeve': { x: 0.7, y: 0.15, width: 0.25, height: 0.6 }
  },

  // Garment templates (grayscale base images)
  garments: {
    tshirt: {
      front: 'assets/tshirt-front.png',
      back: 'assets/tshirt-back.png',
      model: 'models/tshirt.glb'
    },
    longsleeve: {
      front: 'assets/longsleeve-front.png',
      back: 'assets/longsleeve-back.png',
      model: 'models/longsleeve.glb'
    },
    hoodie: {
      front: 'assets/hoodie-front.png',
      back: 'assets/hoodie-back.png',
      model: 'models/hoodie.glb'
    },
    tanktop: {
      front: 'assets/tanktop-front.png',
      back: 'assets/tanktop-back.png',
      model: 'models/tanktop.glb'
    }
  },

  // Mannequin models
  mannequins: {
    ghost: null,
    male: 'models/mannequins/male.glb',
    female: 'models/mannequins/female.glb',
    child: 'models/mannequins/child.glb'
  },

  // Default colors
  defaultApparelColor: '#ffffff',
  defaultTextColor: '#ffffff'
};

// ========================================
// STATE MANAGEMENT
// ========================================

const state = {
  // Current selections
  currentZone: 'front',
  currentGarment: 'tshirt',
  currentModel: 'ghost',
  apparelColor: CONFIG.defaultApparelColor,

  // Zone-specific canvas states
  zones: {
    front: { objects: [], json: null },
    back: { objects: [], json: null },
    'left-sleeve': { objects: [], json: null },
    'right-sleeve': { objects: [], json: null }
  },

  // Catalog
  catalog: null,
  flatDesigns: [],
  filtered: [],
  visibleCount: 0,

  // UI state
  activeTab: 'catalog',
  selectedObject: null,
  autoRotate: false,

  // 3D scene
  scene: null,
  camera: null,
  renderer: null,
  controls: null,
  garmentMesh: null,
  mannequinMesh: null,

  // Decal meshes for each zone
  decalMeshes: {
    front: null,
    back: null,
    'left-sleeve': null,
    'right-sleeve': null
  },

  // Textures for each zone
  decalTextures: {
    front: null,
    back: null,
    'left-sleeve': null,
    'right-sleeve': null
  },

  // Selected apparel from inventory
  selectedApparel: null,
  frontImageUrl: null,
  backImageUrl: null
};

// ========================================
// DOM ELEMENTS
// ========================================

const els = {
  // Toolbar
  apparelColorPicker: document.getElementById('apparelColorPicker'),
  colorPresets: document.getElementById('colorPresets'),
  garmentType: document.getElementById('garmentType'),
  modelType: document.getElementById('modelType'),

  // Export buttons
  exportPngBtn: document.getElementById('exportPngBtn'),
  exportGifBtn: document.getElementById('exportGifBtn'),
  exportVideoBtn: document.getElementById('exportVideoBtn'),
  saveToLibraryBtn: document.getElementById('saveToLibraryBtn'),

  // Sidebar
  sidebarTabs: document.querySelectorAll('.sidebar__tab'),
  catalogPanel: document.getElementById('catalogPanel'),
  textPanel: document.getElementById('textPanel'),
  layersPanel: document.getElementById('layersPanel'),

  // Catalog
  catalogSearch: document.getElementById('catalogSearch'),
  catalogCategory: document.getElementById('catalogCategory'),
  catalogGrid: document.getElementById('catalogGrid'),
  loadMoreBtn: document.getElementById('loadMoreBtn'),

  // Text tool
  textInput: document.getElementById('textInput'),
  addTextBtn: document.getElementById('addTextBtn'),
  fontFamily: document.getElementById('fontFamily'),
  fontSize: document.getElementById('fontSize'),
  textColor: document.getElementById('textColor'),
  textBold: document.getElementById('textBold'),
  textItalic: document.getElementById('textItalic'),
  textUnderline: document.getElementById('textUnderline'),
  textRotation: document.getElementById('textRotation'),
  textRotationValue: document.getElementById('textRotationValue'),
  textStrokeWidth: document.getElementById('textStrokeWidth'),
  textStrokeColor: document.getElementById('textStrokeColor'),

  // Layers
  layersList: document.getElementById('layersList'),
  deleteLayerBtn: document.getElementById('deleteLayerBtn'),

  // Workspace
  zoneBtns: document.querySelectorAll('.zone-btn'),
  editorCanvasWrap: document.getElementById('editorCanvasWrap'),
  colorOverlay: document.getElementById('colorOverlay'),
  zoneGuide: document.getElementById('zoneGuide'),
  zoneGuideArea: document.getElementById('zoneGuideArea'),
  editorCanvas: document.getElementById('editorCanvas'),
  previewCanvasWrap: document.getElementById('previewCanvasWrap'),
  previewCanvas: document.getElementById('previewCanvas'),
  previewLoading: document.getElementById('previewLoading'),

  // Editor tools
  centerDesignBtn: document.getElementById('centerDesignBtn'),
  flipHorizontalBtn: document.getElementById('flipHorizontalBtn'),
  flipVerticalBtn: document.getElementById('flipVerticalBtn'),
  bringForwardBtn: document.getElementById('bringForwardBtn'),
  sendBackwardBtn: document.getElementById('sendBackwardBtn'),
  vectorizeBtn: document.getElementById('vectorizeBtn'),
  vectorizeRemoveBg: document.getElementById('vectorizeRemoveBg'),
  vectorizeLoading: document.getElementById('vectorizeLoading'),
  vectorizeStepText: document.getElementById('vectorizeStepText'),
  vectorizeProgressBar: document.getElementById('vectorizeProgressBar'),

  // Preview tools
  resetViewBtn: document.getElementById('resetViewBtn'),
  toggleRotateBtn: document.getElementById('toggleRotateBtn'),

  // Status
  statusText: document.getElementById('statusText'),
  zoomLevel: document.getElementById('zoomLevel'),

  // Modal
  exportModal: document.getElementById('exportModal'),
  exportModalTitle: document.getElementById('exportModalTitle'),
  exportPreview: document.getElementById('exportPreview'),
  exportOptions: document.getElementById('exportOptions'),
  exportProgress: document.getElementById('exportProgress'),
  exportProgressBar: document.getElementById('exportProgressBar'),
  exportProgressText: document.getElementById('exportProgressText'),
  exportResolution: document.getElementById('exportResolution'),
  exportConfirmBtn: document.getElementById('exportConfirmBtn')
};

// ========================================
// FABRIC.JS 2D EDITOR
// ========================================

let fabricCanvas = null;

function initFabricCanvas() {
  fabricCanvas = new fabric.Canvas(els.editorCanvas, {
    backgroundColor: '#374151',
    preserveObjectStacking: true,
    selection: true
  });

  // Set canvas size
  fabricCanvas.setWidth(CONFIG.canvasWidth);
  fabricCanvas.setHeight(CONFIG.canvasHeight);

  // Event listeners
  fabricCanvas.on('selection:created', onObjectSelected);
  fabricCanvas.on('selection:updated', onObjectSelected);
  fabricCanvas.on('selection:cleared', onObjectDeselected);
  fabricCanvas.on('object:modified', onCanvasModified);
  fabricCanvas.on('object:added', onCanvasModified);
  fabricCanvas.on('object:removed', onCanvasModified);

  // Load placeholder garment background
  loadGarmentBackground();

  // Update zone guide
  updateZoneGuide();

  setStatus('2D Editor ready');
}

function loadGarmentBackground() {
  const garment = CONFIG.garments[state.currentGarment];
  const imagePath = state.currentZone === 'back' ? garment.back : garment.front;

  // Create a grayscale t-shirt placeholder if assets don't exist yet
  createPlaceholderGarment();
}

function createPlaceholderGarment() {
  // Create a simple garment shape as placeholder
  const width = CONFIG.canvasWidth;
  const height = CONFIG.canvasHeight;

  // T-shirt shape path
  const tshirtPath = state.currentGarment === 'tshirt' || state.currentGarment === 'longsleeve'
    ? createTshirtPath(width, height)
    : state.currentGarment === 'hoodie'
      ? createHoodiePath(width, height)
      : createTanktopPath(width, height);

  // Clear existing background
  fabricCanvas.setBackgroundImage(null, fabricCanvas.renderAll.bind(fabricCanvas));

  // Create path object
  const garmentShape = new fabric.Path(tshirtPath, {
    fill: '#808080', // Grayscale base
    selectable: false,
    evented: false,
    originX: 'center',
    originY: 'center',
    left: width / 2,
    top: height / 2
  });

  // Store reference for color tinting
  garmentShape.isGarment = true;

  // Add to canvas as background element
  fabricCanvas.add(garmentShape);
  fabricCanvas.sendToBack(garmentShape);

  // Apply current color
  applyApparelColor();

  fabricCanvas.renderAll();
}

function createTshirtPath(w, h) {
  const cx = w / 2;
  const scale = w / 800;

  // Simplified t-shirt SVG path
  return `
    M ${cx - 180 * scale} ${120 * scale}
    L ${cx - 280 * scale} ${180 * scale}
    L ${cx - 320 * scale} ${320 * scale}
    L ${cx - 220 * scale} ${340 * scale}
    L ${cx - 200 * scale} ${240 * scale}
    L ${cx - 180 * scale} ${260 * scale}
    L ${cx - 180 * scale} ${680 * scale}
    L ${cx + 180 * scale} ${680 * scale}
    L ${cx + 180 * scale} ${260 * scale}
    L ${cx + 200 * scale} ${240 * scale}
    L ${cx + 220 * scale} ${340 * scale}
    L ${cx + 320 * scale} ${320 * scale}
    L ${cx + 280 * scale} ${180 * scale}
    L ${cx + 180 * scale} ${120 * scale}
    Q ${cx + 100 * scale} ${80 * scale} ${cx} ${80 * scale}
    Q ${cx - 100 * scale} ${80 * scale} ${cx - 180 * scale} ${120 * scale}
    Z
  `;
}

function createHoodiePath(w, h) {
  const cx = w / 2;
  const scale = w / 800;

  return `
    M ${cx - 180 * scale} ${100 * scale}
    L ${cx - 300 * scale} ${200 * scale}
    L ${cx - 340 * scale} ${380 * scale}
    L ${cx - 220 * scale} ${400 * scale}
    L ${cx - 200 * scale} ${280 * scale}
    L ${cx - 180 * scale} ${300 * scale}
    L ${cx - 180 * scale} ${700 * scale}
    L ${cx + 180 * scale} ${700 * scale}
    L ${cx + 180 * scale} ${300 * scale}
    L ${cx + 200 * scale} ${280 * scale}
    L ${cx + 220 * scale} ${400 * scale}
    L ${cx + 340 * scale} ${380 * scale}
    L ${cx + 300 * scale} ${200 * scale}
    L ${cx + 180 * scale} ${100 * scale}
    Q ${cx + 120 * scale} ${40 * scale} ${cx} ${40 * scale}
    Q ${cx - 120 * scale} ${40 * scale} ${cx - 180 * scale} ${100 * scale}
    Z
    M ${cx - 60 * scale} ${100 * scale}
    Q ${cx} ${160 * scale} ${cx + 60 * scale} ${100 * scale}
    L ${cx + 40 * scale} ${80 * scale}
    Q ${cx} ${120 * scale} ${cx - 40 * scale} ${80 * scale}
    Z
  `;
}

function createTanktopPath(w, h) {
  const cx = w / 2;
  const scale = w / 800;

  return `
    M ${cx - 140 * scale} ${120 * scale}
    L ${cx - 160 * scale} ${200 * scale}
    L ${cx - 160 * scale} ${680 * scale}
    L ${cx + 160 * scale} ${680 * scale}
    L ${cx + 160 * scale} ${200 * scale}
    L ${cx + 140 * scale} ${120 * scale}
    Q ${cx + 80 * scale} ${80 * scale} ${cx} ${80 * scale}
    Q ${cx - 80 * scale} ${80 * scale} ${cx - 140 * scale} ${120 * scale}
    Z
  `;
}

function applyApparelColor() {
  const objects = fabricCanvas.getObjects();
  objects.forEach(obj => {
    if (obj.isGarment) {
      obj.set('fill', state.apparelColor);
    }
  });
  fabricCanvas.renderAll();

  // Also update color overlay for blending effect on designs
  updateColorOverlay();
}

function updateColorOverlay() {
  // Position overlay over canvas
  const canvasEl = els.editorCanvas;
  const rect = canvasEl.getBoundingClientRect();
  const wrapRect = els.editorCanvasWrap.getBoundingClientRect();

  els.colorOverlay.style.left = (rect.left - wrapRect.left) + 'px';
  els.colorOverlay.style.top = (rect.top - wrapRect.top) + 'px';
  els.colorOverlay.style.width = rect.width + 'px';
  els.colorOverlay.style.height = rect.height + 'px';

  // Only show overlay for non-white colors (multiply blend needs this)
  if (state.apparelColor.toLowerCase() === '#ffffff') {
    els.colorOverlay.style.background = 'transparent';
  } else {
    // We don't actually want to tint the designs, just the garment
    // So keep overlay transparent - garment color is applied directly
    els.colorOverlay.style.background = 'transparent';
  }
}

function updateZoneGuide() {
  const zone = CONFIG.zones[state.currentZone];
  if (!zone) return;

  const canvasEl = els.editorCanvas;
  const rect = canvasEl.getBoundingClientRect();
  const wrapRect = els.editorCanvasWrap.getBoundingClientRect();

  const offsetX = rect.left - wrapRect.left;
  const offsetY = rect.top - wrapRect.top;

  els.zoneGuide.style.left = (offsetX + rect.width * zone.x) + 'px';
  els.zoneGuide.style.top = (offsetY + rect.height * zone.y) + 'px';
  els.zoneGuideArea.style.width = (rect.width * zone.width) + 'px';
  els.zoneGuideArea.style.height = (rect.height * zone.height) + 'px';
}

function saveCurrentZoneState() {
  if (!fabricCanvas) return;

  // Save current zone's objects (excluding garment background)
  const objects = fabricCanvas.getObjects().filter(obj => !obj.isGarment);
  state.zones[state.currentZone].json = fabricCanvas.toJSON(['isGarment']);
}

function loadZoneState(zone) {
  return new Promise((resolve) => {
    if (!fabricCanvas) {
      resolve();
      return;
    }

    // Clear current objects (except garment)
    const toRemove = fabricCanvas.getObjects().filter(obj => !obj.isGarment);
    toRemove.forEach(obj => fabricCanvas.remove(obj));

    // Load saved state for new zone
    const zoneData = state.zones[zone];
    if (zoneData.json && zoneData.json.objects) {
      const nonGarmentObjects = zoneData.json.objects.filter(obj => !obj.isGarment);
      if (nonGarmentObjects.length > 0) {
        fabric.util.enlivenObjects(nonGarmentObjects, (objects) => {
          objects.forEach(obj => {
            fabricCanvas.add(obj);
          });
          fabricCanvas.renderAll();
          resolve();
        });
      } else {
        fabricCanvas.renderAll();
        resolve();
      }
    } else {
      fabricCanvas.renderAll();
      resolve();
    }
  });
}

async function switchZone(newZone) {
  if (newZone === state.currentZone) return;

  // Save current zone state
  saveCurrentZoneState();

  // Update state
  state.currentZone = newZone;

  // Update UI
  els.zoneBtns.forEach(btn => {
    btn.classList.toggle('zone-btn--active', btn.dataset.zone === newZone);
  });

  // Load new zone state (wait for async loading to complete)
  await loadZoneState(newZone);

  // Update garment (front/back view)
  createPlaceholderGarment();

  // Update zone guide
  updateZoneGuide();

  // Update 3D preview to reflect all zones
  update3DPreview();

  setStatus(`Switched to ${newZone.replace('-', ' ')} view`);
}

function onObjectSelected(e) {
  state.selectedObject = e.selected ? e.selected[0] : null;
  updateLayersList();
  updateTextToolFromSelection();
  els.deleteLayerBtn.disabled = !state.selectedObject;
}

function onObjectDeselected() {
  state.selectedObject = null;
  updateLayersList();
  els.deleteLayerBtn.disabled = true;
}

function onCanvasModified() {
  updateLayersList();
  update3DPreview();
}

// ========================================
// THREE.JS 3D PREVIEW
// ========================================

function init3DPreview() {
  const container = els.previewCanvasWrap;

  // Wait a tick for layout to complete, then get dimensions
  requestAnimationFrame(() => {
    let width = container.clientWidth;
    let height = container.clientHeight;

    console.log('init3DPreview - container:', container);
    console.log('init3DPreview - container dimensions:', width, 'x', height);

    // If container still has no size, use defaults
    if (width === 0 || height === 0) {
      width = 500;
      height = 500;
      console.log('Using default size:', width, height);
    }

    // Scene - dark background for proper apparel viewing
    state.scene = new THREE.Scene();
    state.scene.background = new THREE.Color(0x1e293b);

    // Camera
    state.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    state.camera.position.set(0, 0, 3);

    // Renderer - create without using the existing canvas to ensure proper sizing
    state.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false
    });
    state.renderer.setSize(width, height);
    state.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    // Replace the placeholder canvas with the renderer's canvas
    state.renderer.domElement.id = 'previewCanvas';
    if (els.previewCanvas.parentNode) {
      els.previewCanvas.parentNode.replaceChild(state.renderer.domElement, els.previewCanvas);
    }
    els.previewCanvas = state.renderer.domElement;

    console.log('Renderer canvas size:', state.renderer.domElement.width, 'x', state.renderer.domElement.height);
    console.log('Canvas getBoundingClientRect:', state.renderer.domElement.getBoundingClientRect());

    state.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    state.renderer.toneMappingExposure = 1;

    // Controls
    state.controls = new OrbitControls(state.camera, state.renderer.domElement);
    state.controls.enableDamping = true;
    state.controls.dampingFactor = 0.05;
    state.controls.minDistance = 1.5;
    state.controls.maxDistance = 6;
    state.controls.enablePan = false;

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    state.scene.add(ambientLight);

    const mainLight = new THREE.DirectionalLight(0xffffff, 1);
    mainLight.position.set(5, 5, 5);
    state.scene.add(mainLight);

    const fillLight = new THREE.DirectionalLight(0xffffff, 0.3);
    fillLight.position.set(-5, 0, -5);
    state.scene.add(fillLight);

    const rimLight = new THREE.DirectionalLight(0xffffff, 0.2);
    rimLight.position.set(0, 5, -5);
    state.scene.add(rimLight);

    // Initialize GLTF loader
    state.gltfLoader = new GLTFLoader();

    // Load initial 3D garment
    load3DGarment(state.currentGarment);

    // Animation loop
    animate3D();

    // Handle resize
    window.addEventListener('resize', on3DResize);

    setStatus('3D Preview ready');
  }); // end requestAnimationFrame
}

// Model paths configuration (use absolute paths from root)
const MODEL_PATHS = {
  garments: {
    tshirt: '/mockup-pro/models/tshirt.glb',
    hoodie: '/mockup-pro/models/hoodie.glb',
    longsleeve: '/mockup-pro/models/longsleeve.glb',
    tanktop: '/mockup-pro/models/tanktop.glb'
  },
  mannequins: {
    male: '/mockup-pro/models/mannequins/male.glb',
    female: '/mockup-pro/models/mannequins/female.glb',
    child: '/mockup-pro/models/mannequins/child.glb'
  }
};

// Load a 3D garment model
function load3DGarment(garmentType) {
  const modelPath = MODEL_PATHS.garments[garmentType];

  // Use procedural geometry only for tank top (no GLB model yet)
  if (false && garmentType === 'tanktop') {
    console.log('Using procedural geometry for:', garmentType);
    createFallbackGarment();
    if (els.previewLoading) {
      els.previewLoading.hidden = true;
      els.previewLoading.style.display = 'none';
    }
    setStatus(`Loaded ${garmentType} (procedural)`);
    return;
  }

  if (!modelPath) {
    console.warn('Unknown garment type:', garmentType);
    createFallbackGarment();
    return;
  }

  console.log('Loading 3D garment from GLB:', garmentType, modelPath);

  // Show loading indicator
  if (els.previewLoading) {
    els.previewLoading.hidden = false;
    els.previewLoading.style.display = 'flex';
  }

  state.gltfLoader.load(
    modelPath,
    (gltf) => {
      console.log('GLB model loaded:', gltf);

      // Remove existing garment and decals
      if (state.garmentMesh) {
        state.scene.remove(state.garmentMesh);
      }
      // Clear all existing decals when loading new garment
      removeAllDecals();

      const model = gltf.scene;

      // Calculate bounding box to normalize size
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());

      console.log('Model size:', size);
      console.log('Model center:', center);

      // Scale to fit in view (target height of ~1.5 units)
      const targetHeight = 1.5;
      const scale = targetHeight / size.y;
      model.scale.set(scale, scale, scale);

      // Center the model
      model.position.set(-center.x * scale, -center.y * scale, -center.z * scale);

      // Apply the current apparel color to all meshes
      model.traverse((child) => {
        if (child.isMesh) {
          // Create a new material based on the current apparel color
          child.material = new THREE.MeshStandardMaterial({
            color: state.apparelColor,
            roughness: 0.7,
            metalness: 0.0,
            side: THREE.DoubleSide
          });
        }
      });

      state.garmentMesh = model;
      state.scene.add(model);

      // Hide loading indicator
      if (els.previewLoading) {
        els.previewLoading.hidden = true;
        els.previewLoading.style.display = 'none';
      }

      // Reapply all zone decals to the new garment
      applyAllZoneDecals();

      setStatus(`Loaded ${garmentType} (3D model)`);
    },
    (progress) => {
      const percent = Math.round((progress.loaded / progress.total) * 100);
      console.log('Loading progress:', percent + '%');
    },
    (error) => {
      console.error('Error loading garment model:', error);
      // Fall back to procedural geometry on error
      createFallbackGarment();
      if (els.previewLoading) {
        els.previewLoading.hidden = true;
        els.previewLoading.style.display = 'none';
      }
      setStatus(`Loaded ${garmentType} (fallback)`);
    }
  );
}

// Load a mannequin model
function load3DMannequin(mannequinType) {
  if (mannequinType === 'ghost') {
    // Remove mannequin if switching to ghost mode
    if (state.mannequinMesh) {
      state.scene.remove(state.mannequinMesh);
      state.mannequinMesh = null;
    }
    return;
  }

  const modelPath = MODEL_PATHS.mannequins[mannequinType];
  if (!modelPath) {
    console.warn('Unknown mannequin type:', mannequinType);
    return;
  }

  state.gltfLoader.load(
    modelPath,
    (gltf) => {
      // Remove existing mannequin
      if (state.mannequinMesh) {
        state.scene.remove(state.mannequinMesh);
        state.mannequinMesh = null;
      }

      const model = gltf.scene;

      // Center and scale
      const box = new THREE.Box3().setFromObject(model);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());

      const maxDim = Math.max(size.x, size.y, size.z);
      const scale = 2.5 / maxDim;
      model.scale.setScalar(scale);

      model.position.x = -center.x * scale;
      model.position.y = -center.y * scale - 0.3; // Slightly lower
      model.position.z = -center.z * scale - 0.1; // Slightly behind garment

      // Apply neutral color to mannequin
      model.traverse((child) => {
        if (child.isMesh) {
          child.material = new THREE.MeshStandardMaterial({
            color: 0x8b7355, // Skin tone
            roughness: 0.6,
            metalness: 0
          });
        }
      });

      state.mannequinMesh = model;
      state.scene.add(model);

      setStatus(`Loaded ${mannequinType} mannequin`);
    },
    undefined,
    (error) => {
      console.error('Error loading mannequin:', error);
    }
  );
}

// Create a procedural t-shirt shape
function createTShirtGeometry() {
  const shape = new THREE.Shape();

  // T-shirt outline (front view, scaled to ~1.5 units tall)
  // Start at left shoulder
  shape.moveTo(-0.6, 0.6);

  // Left sleeve
  shape.lineTo(-0.9, 0.5);
  shape.lineTo(-0.9, 0.25);
  shape.lineTo(-0.6, 0.25);

  // Left side down
  shape.lineTo(-0.5, -0.75);

  // Bottom hem
  shape.lineTo(0.5, -0.75);

  // Right side up
  shape.lineTo(0.6, 0.25);

  // Right sleeve
  shape.lineTo(0.9, 0.25);
  shape.lineTo(0.9, 0.5);
  shape.lineTo(0.6, 0.6);

  // Neckline (curved)
  shape.quadraticCurveTo(0.3, 0.75, 0, 0.7);
  shape.quadraticCurveTo(-0.3, 0.75, -0.6, 0.6);

  const extrudeSettings = {
    depth: 0.15,
    bevelEnabled: true,
    bevelThickness: 0.02,
    bevelSize: 0.02,
    bevelSegments: 2
  };

  return new THREE.ExtrudeGeometry(shape, extrudeSettings);
}

// Create geometry based on current garment type
function createGarmentGeometry(garmentType) {
  switch (garmentType) {
    case 'tshirt':
      return createTShirtGeometry();
    case 'hoodie':
      return createHoodieGeometry();
    case 'longsleeve':
      return createLongSleeveGeometry();
    case 'tanktop':
      return createTankTopGeometry();
    default:
      return createTShirtGeometry();
  }
}

function createHoodieGeometry() {
  const shape = new THREE.Shape();

  // Hoodie outline - wider body, hood
  shape.moveTo(-0.6, 0.7);

  // Left sleeve (longer)
  shape.lineTo(-0.95, 0.5);
  shape.lineTo(-0.95, 0.1);
  shape.lineTo(-0.6, 0.15);

  // Left side
  shape.lineTo(-0.55, -0.8);

  // Bottom
  shape.lineTo(0.55, -0.8);

  // Right side
  shape.lineTo(0.6, 0.15);

  // Right sleeve
  shape.lineTo(0.95, 0.1);
  shape.lineTo(0.95, 0.5);
  shape.lineTo(0.6, 0.7);

  // Hood
  shape.quadraticCurveTo(0.4, 0.9, 0, 0.85);
  shape.quadraticCurveTo(-0.4, 0.9, -0.6, 0.7);

  const extrudeSettings = {
    depth: 0.18,
    bevelEnabled: true,
    bevelThickness: 0.02,
    bevelSize: 0.02,
    bevelSegments: 2
  };

  return new THREE.ExtrudeGeometry(shape, extrudeSettings);
}

function createLongSleeveGeometry() {
  const shape = new THREE.Shape();

  // Long sleeve - extended arms
  shape.moveTo(-0.6, 0.6);

  // Left sleeve (long)
  shape.lineTo(-1.1, 0.45);
  shape.lineTo(-1.1, 0.2);
  shape.lineTo(-0.6, 0.25);

  // Left side
  shape.lineTo(-0.5, -0.75);

  // Bottom
  shape.lineTo(0.5, -0.75);

  // Right side
  shape.lineTo(0.6, 0.25);

  // Right sleeve (long)
  shape.lineTo(1.1, 0.2);
  shape.lineTo(1.1, 0.45);
  shape.lineTo(0.6, 0.6);

  // Neckline
  shape.quadraticCurveTo(0.3, 0.75, 0, 0.7);
  shape.quadraticCurveTo(-0.3, 0.75, -0.6, 0.6);

  const extrudeSettings = {
    depth: 0.15,
    bevelEnabled: true,
    bevelThickness: 0.02,
    bevelSize: 0.02,
    bevelSegments: 2
  };

  return new THREE.ExtrudeGeometry(shape, extrudeSettings);
}

function createTankTopGeometry() {
  const shape = new THREE.Shape();

  // Tank top - no sleeves, thinner straps
  shape.moveTo(-0.35, 0.65);

  // Left strap and armhole
  shape.lineTo(-0.55, 0.4);
  shape.quadraticCurveTo(-0.6, 0.2, -0.5, 0.1);

  // Left side
  shape.lineTo(-0.45, -0.75);

  // Bottom
  shape.lineTo(0.45, -0.75);

  // Right side
  shape.lineTo(0.5, 0.1);

  // Right armhole and strap
  shape.quadraticCurveTo(0.6, 0.2, 0.55, 0.4);
  shape.lineTo(0.35, 0.65);

  // Neckline (deeper V or scoop)
  shape.quadraticCurveTo(0.15, 0.5, 0, 0.45);
  shape.quadraticCurveTo(-0.15, 0.5, -0.35, 0.65);

  const extrudeSettings = {
    depth: 0.12,
    bevelEnabled: true,
    bevelThickness: 0.02,
    bevelSize: 0.02,
    bevelSegments: 2
  };

  return new THREE.ExtrudeGeometry(shape, extrudeSettings);
}

// Fallback to procedural geometry
function createFallbackGarment() {
  console.log('Creating procedural garment:', state.currentGarment);

  const geometry = createGarmentGeometry(state.currentGarment);

  // Center the geometry
  geometry.center();

  const material = new THREE.MeshStandardMaterial({
    color: state.apparelColor,
    roughness: 0.7,
    metalness: 0.0,
    side: THREE.DoubleSide
  });

  if (state.garmentMesh) {
    state.scene.remove(state.garmentMesh);
  }

  state.garmentMesh = new THREE.Mesh(geometry, material);
  state.garmentMesh.position.set(0, 0, 0);
  state.scene.add(state.garmentMesh);

  console.log('Procedural garment created:', state.currentGarment);
}

// Capture just the design elements (no garment background) as a transparent texture
// Cropped to the design zone area only
// If zoneName is provided, captures from stored zone data; otherwise captures current canvas
function captureDesignTexture(zoneName = null) {
  if (!fabricCanvas) return null;

  // Determine which zone we're capturing
  const targetZone = zoneName || state.currentZone;
  const zoneConfig = CONFIG.zones[targetZone];

  if (!zoneConfig) {
    console.warn(`Unknown zone: ${targetZone}`);
    return null;
  }

  // Get zone dimensions
  const zoneX = zoneConfig.x * CONFIG.canvasWidth;
  const zoneY = zoneConfig.y * CONFIG.canvasHeight;
  const zoneWidth = zoneConfig.width * CONFIG.canvasWidth;
  const zoneHeight = zoneConfig.height * CONFIG.canvasHeight;

  // Get design objects - either from current canvas or stored zone data
  let designObjectsData = [];

  if (zoneName && zoneName !== state.currentZone) {
    // Capture from stored zone data
    const zoneData = state.zones[zoneName];
    if (zoneData && zoneData.json && zoneData.json.objects) {
      designObjectsData = zoneData.json.objects.filter(obj => !obj.isGarment);
      console.log(`Zone ${zoneName}: capturing from stored data, found ${designObjectsData.length} objects`);
    } else {
      console.log(`Zone ${zoneName}: no stored data available`);
    }
  } else {
    // Capture from current canvas (this zone is currently active)
    const objects = fabricCanvas.getObjects().filter(obj => !obj.isGarment);
    console.log(`Zone ${targetZone} (current): capturing from canvas, found ${objects.length} objects`);
    if (objects.length === 0) return null;
    // Serialize current objects
    designObjectsData = objects.map(obj => obj.toObject(['isGarment']));
  }

  if (designObjectsData.length === 0) {
    return null; // No designs to capture
  }

  // Create a temporary canvas sized to the design zone
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = zoneWidth;
  tempCanvas.height = zoneHeight;

  // Create a fabric static canvas for rendering
  const tempFabricCanvas = new fabric.StaticCanvas(tempCanvas, {
    width: zoneWidth,
    height: zoneHeight,
    backgroundColor: null // Transparent background
  });

  // Use a promise to handle async object creation
  return new Promise((resolve) => {
    fabric.util.enlivenObjects(designObjectsData, (objects) => {
      objects.forEach(obj => {
        // Offset the object position to be relative to the zone origin
        obj.set({
          left: obj.left - zoneX,
          top: obj.top - zoneY
        });
        obj.setCoords();
        tempFabricCanvas.add(obj);
      });

      tempFabricCanvas.renderAll();

      // Get the data URL with transparency
      const dataURL = tempFabricCanvas.toDataURL({
        format: 'png',
        quality: 1
      });

      // Clean up
      tempFabricCanvas.dispose();

      resolve(dataURL);
    });
  });
}

// Capture design texture synchronously for current zone (for backwards compatibility)
function captureDesignTextureSync() {
  if (!fabricCanvas) return null;

  const designObjects = fabricCanvas.getObjects().filter(obj => !obj.isGarment);
  if (designObjects.length === 0) return null;

  const zone = CONFIG.zones[state.currentZone];
  const zoneX = zone.x * CONFIG.canvasWidth;
  const zoneY = zone.y * CONFIG.canvasHeight;
  const zoneWidth = zone.width * CONFIG.canvasWidth;
  const zoneHeight = zone.height * CONFIG.canvasHeight;

  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = zoneWidth;
  tempCanvas.height = zoneHeight;

  const tempFabricCanvas = new fabric.StaticCanvas(tempCanvas, {
    width: zoneWidth,
    height: zoneHeight,
    backgroundColor: null
  });

  designObjects.forEach(obj => {
    const clone = fabric.util.object.clone(obj);
    clone.set({
      left: obj.left - zoneX,
      top: obj.top - zoneY
    });
    clone.setCoords();
    tempFabricCanvas.add(clone);
  });

  tempFabricCanvas.renderAll();

  const dataURL = tempFabricCanvas.toDataURL({
    format: 'png',
    quality: 1
  });

  tempFabricCanvas.dispose();
  return dataURL;
}

function update3DPreview() {
  if (!state.garmentMesh) return;

  // Update color on all meshes in the 3D model
  state.garmentMesh.traverse((child) => {
    if (child.isMesh && child.material) {
      // Handle both single material and array of materials
      if (Array.isArray(child.material)) {
        child.material.forEach(mat => {
          mat.color.set(state.apparelColor);
          mat.needsUpdate = true;
        });
      } else {
        child.material.color.set(state.apparelColor);
        child.material.needsUpdate = true;
      }
    }
  });

  // Capture design and apply as decal
  applyDesignToModel();
}

// Debounce the design application to avoid too many updates
let designUpdateTimeout = null;

function applyDesignToModel() {
  // Debounce - wait for user to stop making changes
  if (designUpdateTimeout) {
    clearTimeout(designUpdateTimeout);
  }

  designUpdateTimeout = setTimeout(() => {
    applyAllZoneDecals();
  }, 100);
}

// Remove a single zone's decal
function removeZoneDecal(zoneName) {
  if (state.decalMeshes[zoneName]) {
    state.scene.remove(state.decalMeshes[zoneName]);
    if (state.decalMeshes[zoneName].geometry) state.decalMeshes[zoneName].geometry.dispose();
    if (state.decalMeshes[zoneName].material) state.decalMeshes[zoneName].material.dispose();
    state.decalMeshes[zoneName] = null;
  }
  if (state.decalTextures[zoneName]) {
    state.decalTextures[zoneName].dispose();
    state.decalTextures[zoneName] = null;
  }
}

// Remove all zone decals
function removeAllDecals() {
  Object.keys(state.decalMeshes).forEach(zoneName => {
    removeZoneDecal(zoneName);
  });
}

// Get decal configuration for each zone (garment-aware)
function getDecalConfig(zoneName, box, size, center) {
  const garmentType = state.currentGarment || 'tshirt';

  // Garment-specific adjustments
  const garmentSettings = {
    tshirt: {
      frontYOffset: 0.05,
      frontSizeMultiplier: 0.6,
      backYOffset: 0.05,
      backSizeMultiplier: 0.6,
      sleeveYOffset: 0.2,
      sleeveSizeX: 0.4,
      sleeveSizeY: 0.25
    },
    longsleeve: {
      frontYOffset: 0.05,
      frontSizeMultiplier: 0.55,
      backYOffset: 0.05,
      backSizeMultiplier: 0.55,
      sleeveYOffset: 0.0,  // Center on sleeve (full arm coverage)
      sleeveSizeX: 0.25,   // Width of sleeve decal
      sleeveSizeY: 0.5,    // Much taller for full arm length
      frontZOffset: 0.5    // Push front decal out on Z axis
    },
    hoodie: {
      frontYOffset: 0.0,  // Lower on hoodie (below hood)
      frontSizeMultiplier: 0.5,  // Smaller due to larger garment
      backYOffset: 0.05,
      backSizeMultiplier: 0.5,
      sleeveYOffset: 0.15,
      sleeveSizeX: 0.35,
      sleeveSizeY: 0.2
    },
    tanktop: {
      frontYOffset: 0.05,
      frontSizeMultiplier: 0.55,
      backYOffset: 0.05,
      backSizeMultiplier: 0.55,
      sleeveYOffset: 0.2,
      sleeveSizeX: 0.3,
      sleeveSizeY: 0.2
    }
  };

  const settings = garmentSettings[garmentType] || garmentSettings.tshirt;

  const configs = {
    front: {
      position: new THREE.Vector3(
        center.x,
        center.y + size.y * settings.frontYOffset,
        box.max.z + 0.01 + size.z * (settings.frontZOffset || 0)  // Front surface with garment-specific Z offset
      ),
      orientation: new THREE.Euler(0, 0, 0),
      size: new THREE.Vector3(
        size.x * settings.frontSizeMultiplier,
        size.x * settings.frontSizeMultiplier,
        size.z * 1.0  // Increased depth for better projection
      )
    },
    back: {
      position: new THREE.Vector3(
        center.x,
        center.y + size.y * settings.backYOffset,
        box.min.z  // Back surface
      ),
      orientation: new THREE.Euler(0, Math.PI, 0),  // Rotated 180 degrees
      size: new THREE.Vector3(
        size.x * settings.backSizeMultiplier,
        size.x * settings.backSizeMultiplier,
        size.z * 0.5
      )
    },
    'left-sleeve': {
      position: new THREE.Vector3(
        box.min.x,  // Left side
        center.y + size.y * settings.sleeveYOffset,
        center.z
      ),
      orientation: new THREE.Euler(0, -Math.PI / 2, 0),  // Facing left
      size: new THREE.Vector3(
        size.z * settings.sleeveSizeX,
        size.y * settings.sleeveSizeY,
        size.x * 0.3
      )
    },
    'right-sleeve': {
      position: new THREE.Vector3(
        box.max.x,  // Right side
        center.y + size.y * settings.sleeveYOffset,
        center.z
      ),
      orientation: new THREE.Euler(0, Math.PI / 2, 0),  // Facing right
      size: new THREE.Vector3(
        size.z * settings.sleeveSizeX,
        size.y * settings.sleeveSizeY,
        size.x * 0.3
      )
    }
  };
  return configs[zoneName];
}

// Apply decal for a single zone
async function applyZoneDecal(zoneName, targetMesh, box, size, center) {
  // First, save current zone state to ensure we have latest data
  saveCurrentZoneState();

  console.log(`Applying decal for zone: ${zoneName} (current zone: ${state.currentZone})`);

  // Get the design texture for this zone
  const designDataURL = await captureDesignTexture(zoneName);

  // Remove existing decal for this zone
  removeZoneDecal(zoneName);

  if (!designDataURL) {
    console.log(`No design to apply for zone: ${zoneName}`);
    return; // No design for this zone
  }

  console.log(`Got design texture for zone: ${zoneName}, applying decal...`);

  // Load the design as a texture
  return new Promise((resolve) => {
    const textureLoader = new THREE.TextureLoader();
    textureLoader.load(designDataURL, (texture) => {
      state.decalTextures[zoneName] = texture;
      texture.colorSpace = THREE.SRGBColorSpace;

      // Get decal configuration for this zone
      const config = getDecalConfig(zoneName, box, size, center);

      // Ensure entire garment model's matrix is up to date (important for transformed models)
      state.garmentMesh.updateMatrixWorld(true);
      targetMesh.updateMatrixWorld(true);

      // Create decal geometry projected onto the mesh
      console.log(`Creating decal for ${zoneName}:`, {
        position: config.position,
        orientation: config.orientation,
        size: config.size,
        targetMeshName: targetMesh.name || 'unnamed'
      });

      const decalGeometry = new DecalGeometry(
        targetMesh,
        config.position,
        config.orientation,
        config.size
      );

      console.log(`Decal geometry for ${zoneName}: ${decalGeometry.attributes.position?.count || 0} vertices`);

      // Create decal material
      const decalMaterial = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4
      });

      // Create and add the decal mesh to scene
      state.decalMeshes[zoneName] = new THREE.Mesh(decalGeometry, decalMaterial);
      state.scene.add(state.decalMeshes[zoneName]);

      console.log(`Decal applied to ${zoneName}:`, config.position);
      resolve();
    });
  });
}

// Apply decals for all zones
async function applyAllZoneDecals() {
  if (!state.scene || !state.garmentMesh) {
    console.warn('Cannot apply decals - missing scene or garment mesh');
    return;
  }

  // Find all meshes in the garment model - some models may have multiple meshes
  const meshes = [];
  state.garmentMesh.traverse((child) => {
    if (child.isMesh) {
      meshes.push(child);
    }
  });

  console.log(`Found ${meshes.length} meshes in ${state.currentGarment} model`);

  if (meshes.length === 0) {
    console.warn('No meshes found in garment model');
    return;
  }

  // Use the largest mesh as the target for decals (usually the main body)
  let targetMesh = meshes[0];
  if (meshes.length > 1) {
    let maxVolume = 0;
    meshes.forEach(mesh => {
      const meshBox = new THREE.Box3().setFromObject(mesh);
      const meshSize = meshBox.getSize(new THREE.Vector3());
      const volume = meshSize.x * meshSize.y * meshSize.z;
      if (volume > maxVolume) {
        maxVolume = volume;
        targetMesh = mesh;
      }
    });
    console.log('Using largest mesh for decals');
  }

  // Get garment bounding box for positioning (use full model for consistent positioning)
  const box = new THREE.Box3().setFromObject(state.garmentMesh);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  console.log(`Garment ${state.currentGarment} - size:`, size, 'center:', center);

  // Apply decals to all zones
  const zones = ['front', 'back', 'left-sleeve', 'right-sleeve'];

  for (const zoneName of zones) {
    await applyZoneDecal(zoneName, targetMesh, box, size, center);
  }

  console.log('All zone decals applied for', state.currentGarment);
}

// Legacy function for backwards compatibility
function applyDesignToModelImmediate() {
  applyAllZoneDecals();
}

let frameCount = 0;
function animate3D() {
  requestAnimationFrame(animate3D);

  if (state.autoRotate && state.garmentMesh) {
    state.garmentMesh.rotation.y += 0.005;
  }

  if (state.controls) {
    state.controls.update();
  }

  if (state.renderer && state.scene && state.camera) {
    state.renderer.render(state.scene, state.camera);
    frameCount++;
    if (frameCount === 1) {
      console.log('First frame rendered!');
      console.log('Renderer info:', state.renderer.info);
    }
  } else {
    if (frameCount === 0) {
      console.error('Cannot render - missing:', {
        renderer: !!state.renderer,
        scene: !!state.scene,
        camera: !!state.camera
      });
      frameCount = -1; // Only log once
    }
  }
}

function on3DResize() {
  const container = els.previewCanvasWrap;
  const width = container.clientWidth;
  const height = container.clientHeight;

  if (state.camera) {
    state.camera.aspect = width / height;
    state.camera.updateProjectionMatrix();
  }

  if (state.renderer) {
    state.renderer.setSize(width, height);
  }
}

function reset3DView() {
  if (state.camera) {
    state.camera.position.set(0, 0, 3);
    state.camera.lookAt(0, 0, 0);
  }

  if (state.garmentMesh) {
    state.garmentMesh.rotation.set(0, 0, 0);
  }

  if (state.controls) {
    state.controls.reset();
  }
}

function toggleAutoRotate() {
  state.autoRotate = !state.autoRotate;
  els.toggleRotateBtn.classList.toggle('active', state.autoRotate);
}

// ========================================
// CATALOG
// ========================================

const PAGE_SIZE = 24;

async function loadCatalog() {
  try {
    // Try API first, then local file
    const endpoints = ['/api/catalog', '../catalog.json'];

    for (const url of endpoints) {
      try {
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          if (data && Array.isArray(data.categories)) {
            state.catalog = data;
            state.flatDesigns = flattenDesigns(data);
            state.filtered = [...state.flatDesigns];
            renderCategoryOptions();
            renderCatalog();
            return;
          }
        }
      } catch (e) {
        console.warn('Failed to load catalog from', url);
      }
    }

    // Fallback empty catalog
    state.catalog = { categories: [] };
    state.flatDesigns = [];
    state.filtered = [];
    renderCatalog();

  } catch (err) {
    console.error('Error loading catalog:', err);
    setStatus('Failed to load catalog', 'error');
  }
}

function flattenDesigns(catalog) {
  const flat = [];
  (catalog.categories || []).forEach(cat => {
    (cat.designs || []).forEach(design => {
      flat.push({
        id: design.id,
        name: design.name || design.id,
        image: resolveImageUrl(design.image),
        categorySlug: cat.slug,
        categoryName: cat.name
      });
    });
  });
  return flat;
}

function resolveImageUrl(image) {
  if (!image) return null;
  if (/^(data:|https?:)/i.test(image)) return image;
  if (image.startsWith('/api/')) return image;
  return image;
}

function renderCategoryOptions() {
  const select = els.catalogCategory;
  select.innerHTML = '<option value="">All Categories</option>';

  (state.catalog?.categories || []).forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat.slug;
    opt.textContent = cat.name;
    select.appendChild(opt);
  });
}

function filterCatalog() {
  const query = (els.catalogSearch.value || '').toLowerCase().trim();
  const category = els.catalogCategory.value;

  state.filtered = state.flatDesigns.filter(d => {
    if (category && d.categorySlug !== category) return false;
    if (query && !d.name.toLowerCase().includes(query)) return false;
    return true;
  });

  state.visibleCount = 0;
  renderCatalog();
}

function renderCatalog() {
  if (state.visibleCount === 0) {
    els.catalogGrid.innerHTML = '';
  }

  const slice = state.filtered.slice(state.visibleCount, state.visibleCount + PAGE_SIZE);

  slice.forEach(design => {
    const item = document.createElement('div');
    item.className = 'catalog-item';
    item.innerHTML = `
      <div class="catalog-item__preview">
        <img src="${design.image}" alt="${design.name}" loading="lazy" crossorigin="anonymous" />
      </div>
      <div class="catalog-item__name">${design.name}</div>
    `;

    item.addEventListener('click', () => addDesignToCanvas(design));

    // Enable drag
    item.draggable = true;
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/json', JSON.stringify(design));
    });

    els.catalogGrid.appendChild(item);
  });

  state.visibleCount += slice.length;

  // Update load more button
  const remaining = state.filtered.length - state.visibleCount;
  els.loadMoreBtn.disabled = remaining <= 0;
  els.loadMoreBtn.textContent = remaining > 0 ? `Load More (${remaining})` : 'No more designs';
}

function addDesignToCanvas(design) {
  const url = design.image;
  if (!url) return;

  fabric.Image.fromURL(url, (img) => {
    if (!img) {
      setStatus('Failed to load design', 'error');
      return;
    }

    // Scale to fit zone
    const zone = CONFIG.zones[state.currentZone];
    const maxW = CONFIG.canvasWidth * zone.width * 0.8;
    const maxH = CONFIG.canvasHeight * zone.height * 0.8;
    const scale = Math.min(maxW / img.width, maxH / img.height, 1);

    img.scale(scale);

    // Position in center of zone
    const zoneCenter = {
      x: CONFIG.canvasWidth * (zone.x + zone.width / 2),
      y: CONFIG.canvasHeight * (zone.y + zone.height / 2)
    };

    img.set({
      left: zoneCenter.x,
      top: zoneCenter.y,
      originX: 'center',
      originY: 'center',
      cornerColor: '#3b82f6',
      cornerStrokeColor: '#3b82f6',
      borderColor: '#3b82f6',
      transparentCorners: false,
      cornerSize: 10
    });

    // Store design info
    img.designInfo = {
      id: design.id,
      name: design.name,
      type: 'design'
    };

    fabricCanvas.add(img);
    fabricCanvas.setActiveObject(img);
    fabricCanvas.renderAll();

    setStatus(`Added "${design.name}"`);
    update3DPreview();

  }, { crossOrigin: 'anonymous' });
}

// ========================================
// TEXT TOOL
// ========================================

function addText() {
  const text = els.textInput.value.trim();
  if (!text) {
    setStatus('Enter some text first', 'error');
    return;
  }

  const fontFamily = els.fontFamily.value;
  const fontSize = parseInt(els.fontSize.value) || 48;
  const fill = els.textColor.value;
  const fontWeight = els.textBold.classList.contains('active') ? 'bold' : 'normal';
  const fontStyle = els.textItalic.classList.contains('active') ? 'italic' : 'normal';
  const underline = els.textUnderline.classList.contains('active');
  const strokeWidth = parseInt(els.textStrokeWidth.value) || 0;
  const stroke = els.textStrokeColor.value;

  const textObj = new fabric.IText(text, {
    fontFamily,
    fontSize,
    fill,
    fontWeight,
    fontStyle,
    underline,
    stroke: strokeWidth > 0 ? stroke : null,
    strokeWidth,
    originX: 'center',
    originY: 'center',
    left: CONFIG.canvasWidth / 2,
    top: CONFIG.canvasHeight / 2,
    cornerColor: '#3b82f6',
    cornerStrokeColor: '#3b82f6',
    borderColor: '#3b82f6',
    transparentCorners: false,
    cornerSize: 10
  });

  textObj.designInfo = {
    name: text.substring(0, 20) + (text.length > 20 ? '...' : ''),
    type: 'text'
  };

  fabricCanvas.add(textObj);
  fabricCanvas.setActiveObject(textObj);
  fabricCanvas.renderAll();

  // Clear input
  els.textInput.value = '';

  setStatus('Text added');
  update3DPreview();
}

function updateTextToolFromSelection() {
  const obj = state.selectedObject;
  if (!obj || obj.type !== 'i-text') return;

  els.fontFamily.value = obj.fontFamily || 'Arial';
  els.fontSize.value = obj.fontSize || 48;
  els.textColor.value = obj.fill || '#ffffff';
  els.textBold.classList.toggle('active', obj.fontWeight === 'bold');
  els.textItalic.classList.toggle('active', obj.fontStyle === 'italic');
  els.textUnderline.classList.toggle('active', obj.underline === true);
  els.textStrokeWidth.value = obj.strokeWidth || 0;
  els.textStrokeColor.value = obj.stroke || '#000000';
  els.textRotation.value = obj.angle || 0;
  els.textRotationValue.textContent = `${Math.round(obj.angle || 0)}°`;
}

function updateSelectedText() {
  const obj = state.selectedObject;
  if (!obj || obj.type !== 'i-text') return;

  obj.set({
    fontFamily: els.fontFamily.value,
    fontSize: parseInt(els.fontSize.value) || 48,
    fill: els.textColor.value,
    fontWeight: els.textBold.classList.contains('active') ? 'bold' : 'normal',
    fontStyle: els.textItalic.classList.contains('active') ? 'italic' : 'normal',
    underline: els.textUnderline.classList.contains('active'),
    strokeWidth: parseInt(els.textStrokeWidth.value) || 0,
    stroke: parseInt(els.textStrokeWidth.value) > 0 ? els.textStrokeColor.value : null,
    angle: parseInt(els.textRotation.value) || 0
  });

  fabricCanvas.renderAll();
  update3DPreview();
}

// ========================================
// LAYERS
// ========================================

function updateLayersList() {
  const objects = fabricCanvas.getObjects().filter(obj => !obj.isGarment);

  if (objects.length === 0) {
    els.layersList.innerHTML = '<p class="layers__empty">No layers yet. Add designs or text to get started.</p>';
    return;
  }

  els.layersList.innerHTML = '';

  // Reverse order (top layer first)
  [...objects].reverse().forEach((obj, index) => {
    const info = obj.designInfo || {};
    const isSelected = obj === state.selectedObject;

    const layerEl = document.createElement('div');
    layerEl.className = 'layer-item' + (isSelected ? ' selected' : '');
    layerEl.innerHTML = `
      <div class="layer-item__preview">
        ${info.type === 'text' ? 'T' : '🎨'}
      </div>
      <div class="layer-item__info">
        <div class="layer-item__name">${info.name || 'Layer'}</div>
        <div class="layer-item__type">${info.type || 'object'}</div>
      </div>
      <div class="layer-item__actions">
        <button type="button" class="layer-item__btn" data-action="visibility" title="Toggle visibility">
          ${obj.visible !== false ? '👁' : '👁‍🗨'}
        </button>
      </div>
    `;

    layerEl.addEventListener('click', (e) => {
      if (e.target.closest('[data-action]')) return;
      fabricCanvas.setActiveObject(obj);
      fabricCanvas.renderAll();
    });

    const visBtn = layerEl.querySelector('[data-action="visibility"]');
    visBtn.addEventListener('click', () => {
      obj.visible = !obj.visible;
      fabricCanvas.renderAll();
      updateLayersList();
      update3DPreview();
    });

    els.layersList.appendChild(layerEl);
  });
}

function deleteSelectedLayer() {
  if (!state.selectedObject) return;

  fabricCanvas.remove(state.selectedObject);
  fabricCanvas.renderAll();
  state.selectedObject = null;
  els.deleteLayerBtn.disabled = true;
  updateLayersList();
  update3DPreview();
  setStatus('Layer deleted');
}

// ========================================
// EDITOR TOOLS
// ========================================

function centerSelected() {
  const obj = fabricCanvas.getActiveObject();
  if (!obj) return;

  const zone = CONFIG.zones[state.currentZone];
  obj.set({
    left: CONFIG.canvasWidth * (zone.x + zone.width / 2),
    top: CONFIG.canvasHeight * (zone.y + zone.height / 2)
  });
  obj.setCoords();
  fabricCanvas.renderAll();
  update3DPreview();
}

function flipHorizontal() {
  const obj = fabricCanvas.getActiveObject();
  if (!obj) return;
  obj.set('flipX', !obj.flipX);
  fabricCanvas.renderAll();
  update3DPreview();
}

function flipVertical() {
  const obj = fabricCanvas.getActiveObject();
  if (!obj) return;
  obj.set('flipY', !obj.flipY);
  fabricCanvas.renderAll();
  update3DPreview();
}

function bringForward() {
  const obj = fabricCanvas.getActiveObject();
  if (!obj) return;
  fabricCanvas.bringForward(obj);
  fabricCanvas.renderAll();
  updateLayersList();
  update3DPreview();
}

function sendBackward() {
  const obj = fabricCanvas.getActiveObject();
  if (!obj) return;

  // Don't send behind garment
  const objects = fabricCanvas.getObjects();
  const garmentIndex = objects.findIndex(o => o.isGarment);
  const objIndex = objects.indexOf(obj);

  if (objIndex > garmentIndex + 1) {
    fabricCanvas.sendBackwards(obj);
    fabricCanvas.renderAll();
    updateLayersList();
    update3DPreview();
  }
}

// ========================================
// VECTORIZE
// ========================================

// Dynamically load ImageTracer library
function ensureImageTracer() {
  const tryLoad = (src) => new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });

  return new Promise(async (resolve) => {
    if (typeof ImageTracer !== 'undefined') return resolve(true);
    // Try relative path
    const okRel = await tryLoad('../imagetracer.min.js');
    if (okRel && typeof ImageTracer !== 'undefined') return resolve(true);
    // Try CDN as fallback
    const okCdn = await tryLoad('https://cdn.jsdelivr.net/npm/imagetracerjs@1.2.6/imagetracer_v1.2.6.min.js');
    if (okCdn && typeof ImageTracer !== 'undefined') return resolve(true);
    resolve(false);
  });
}

function setVectorizeLoadingText(message = 'Vectorizing...') {
  if (els.vectorizeStepText) {
    els.vectorizeStepText.textContent = message;
  }
}

function setVectorizeProgress(pct) {
  if (els.vectorizeProgressBar) {
    const clamped = Math.max(0, Math.min(100, Math.round(pct)));
    els.vectorizeProgressBar.style.width = clamped + '%';
  }
}

function showVectorizeLoading(message = 'Vectorizing...') {
  if (els.vectorizeLoading) {
    setVectorizeLoadingText(message);
    setVectorizeProgress(0);
    els.vectorizeLoading.hidden = false;
  }
}

function hideVectorizeLoading() {
  if (els.vectorizeLoading) {
    els.vectorizeLoading.hidden = true;
  }
}

function getActiveImageElement() {
  const obj = fabricCanvas.getActiveObject();
  if (!obj) return { obj: null, imgEl: null };

  // Prefer plain image objects
  if (obj.type === 'image' && (obj._originalElement || obj._element)) {
    return { obj, imgEl: obj._originalElement || obj._element };
  }

  // If group or other object, try to render to a canvas snapshot
  try {
    const dataUrl = obj.toDataURL({ format: 'png', multiplier: 2 });
    const tmp = new Image();
    tmp.crossOrigin = 'anonymous';
    return { obj, imgEl: tmp, dataUrl };
  } catch (_) {
    return { obj, imgEl: null };
  }
}

function autoRemoveBackground(imgData) {
  const { data, width, height } = imgData;
  if (!data || !width || !height) return;

  // Sample edge pixels to estimate background color
  let sr = 0, sg = 0, sb = 0, n = 0;
  const step = Math.max(1, Math.floor(Math.min(width, height) / 80));

  // Top and bottom rows
  for (let x = 0; x < width; x += step) {
    const i1 = (0 * width + x) * 4;
    const i2 = ((height - 1) * width + x) * 4;
    sr += data[i1]; sg += data[i1 + 1]; sb += data[i1 + 2]; n++;
    sr += data[i2]; sg += data[i2 + 1]; sb += data[i2 + 2]; n++;
  }
  // Left and right columns
  for (let y = 0; y < height; y += step) {
    const i1 = (y * width + 0) * 4;
    const i2 = (y * width + (width - 1)) * 4;
    sr += data[i1]; sg += data[i1 + 1]; sb += data[i1 + 2]; n++;
    sr += data[i2]; sg += data[i2 + 1]; sb += data[i2 + 2]; n++;
  }
  if (!n) return;
  const br = sr / n, bg = sg / n, bb = sb / n;

  // Compute distance stats on border samples to choose threshold
  let sum = 0, sumSq = 0, cnt = 0;
  const dist = (r, g, b) => {
    const dr = r - br, dg = g - bg, db = b - bb;
    return Math.sqrt(dr * dr + dg * dg + db * db);
  };
  for (let x = 0; x < width; x += step) {
    let i = (0 * width + x) * 4;
    let d = dist(data[i], data[i+1], data[i+2]);
    sum += d; sumSq += d * d; cnt++;
    i = ((height - 1) * width + x) * 4;
    d = dist(data[i], data[i+1], data[i+2]);
    sum += d; sumSq += d * d; cnt++;
  }
  for (let y = 0; y < height; y += step) {
    let i = (y * width + 0) * 4;
    let d = dist(data[i], data[i+1], data[i+2]);
    sum += d; sumSq += d * d; cnt++;
    i = (y * width + (width - 1)) * 4;
    d = dist(data[i], data[i+1], data[i+2]);
    sum += d; sumSq += d * d; cnt++;
  }
  const mean = cnt ? sum / cnt : 0;
  const variance = Math.max(0, (sumSq / Math.max(1, cnt)) - mean * mean);
  const std = Math.sqrt(variance);
  // Threshold: mean + 2*std, clamped to a sane range
  const thr = Math.max(20, Math.min(80, mean + 2 * std));

  // Remove pixels similar to background color
  for (let i = 0; i < data.length; i += 4) {
    const dr = data[i] - br, dg = data[i + 1] - bg, db = data[i + 2] - bb;
    const d = Math.sqrt(dr * dr + dg * dg + db * db);
    if (d <= thr) {
      data[i + 3] = 0; // transparent
    }
  }
}

function setObjectDefaults(obj) {
  obj.set({
    cornerColor: '#3b82f6',
    cornerStyle: 'circle',
    cornerSize: 10,
    transparentCorners: false,
    borderColor: '#3b82f6',
    borderScaleFactor: 2
  });
}

async function vectorizeSelected() {
  await ensureImageTracer();
  if (typeof ImageTracer === 'undefined') {
    setStatus('Vectorizer not available', 'error');
    alert('ImageTracer library not loaded. Please try again.');
    return;
  }

  showVectorizeLoading('Preparing image...');
  await new Promise(r => setTimeout(r, 30));

  const { obj, imgEl, dataUrl } = getActiveImageElement();
  if (!obj) {
    setStatus('Select an image to vectorize', 'error');
    hideVectorizeLoading();
    return;
  }
  if (!imgEl) {
    setStatus('Unable to read selected object', 'error');
    hideVectorizeLoading();
    return;
  }

  // Ensure image source is ready
  if (dataUrl) imgEl.src = dataUrl;
  await new Promise((resolve) => {
    if (imgEl.complete && imgEl.naturalWidth) return resolve();
    imgEl.onload = () => resolve();
    imgEl.onerror = () => resolve();
  });

  setVectorizeLoadingText('Scaling source...');
  setVectorizeProgress(10);

  const iw = imgEl.naturalWidth || imgEl.width || 0;
  const ih = imgEl.naturalHeight || imgEl.height || 0;
  if (!iw || !ih) {
    setStatus('Invalid image dimensions', 'error');
    hideVectorizeLoading();
    return;
  }

  // Cap the vectorization resolution for performance
  const MAX_VECT_W = 1000;
  const scale = Math.min(MAX_VECT_W / iw, 1);
  const tw = Math.max(1, Math.round(iw * scale));
  const th = Math.max(1, Math.round(ih * scale));

  const off = document.createElement('canvas');
  off.width = tw;
  off.height = th;
  const octx = off.getContext('2d');
  octx.drawImage(imgEl, 0, 0, tw, th);

  setVectorizeLoadingText('Extracting pixels...');
  setVectorizeProgress(25);
  const imgData = octx.getImageData(0, 0, tw, th);

  // Multi-color trace options
  const options = {
    numberofcolors: 6,
    colorquantcycles: 3,
    strokewidth: 0,
    ltres: 1,
    qtres: 1,
    pathomit: 8
  };

  // Optional: auto-remove background
  if (els.vectorizeRemoveBg && els.vectorizeRemoveBg.checked) {
    try {
      setVectorizeLoadingText('Removing background...');
      setVectorizeProgress(32);
      autoRemoveBackground(imgData);
    } catch (_) { /* ignore */ }
  }

  let svgstr = null;
  setVectorizeLoadingText('Tracing paths...');
  let fake = 30;
  setVectorizeProgress(fake);
  let ticking = true;
  const tick = () => {
    if (!ticking) return;
    fake = Math.min(85, fake + 3 + Math.random() * 4);
    setVectorizeProgress(fake);
    setTimeout(tick, 180);
  };
  setTimeout(tick, 180);

  try {
    svgstr = ImageTracer.imagedataToSVG(imgData, options);
  } catch (err) {
    console.error('Vectorize error:', err);
    setStatus('Vectorization failed', 'error');
    hideVectorizeLoading();
    return;
  }
  ticking = false;

  if (!svgstr) {
    setStatus('Vectorization failed', 'error');
    hideVectorizeLoading();
    return;
  }

  setVectorizeLoadingText('Importing SVG...');
  setVectorizeProgress(92);

  // Parse and add SVG via Fabric
  fabric.loadSVGFromString(svgstr, (objects, svgOptions) => {
    try {
      const group = (fabric.util && fabric.util.groupSVGElements)
        ? fabric.util.groupSVGElements(objects, svgOptions)
        : new fabric.Group(objects);

      // Ensure the group has measurable bounds before scaling
      fabricCanvas.add(group);
      group.set({ originX: 'center', originY: 'center' });

      // Target the same visual size as the raster object
      const center = obj.getCenterPoint();
      const targetW = obj.getScaledWidth() || obj.width || 1;
      const currW = group.getScaledWidth() || group.width || 1;
      let scaleRatio = 1;
      if (currW > 0 && Number.isFinite(currW)) {
        scaleRatio = targetW / currW;
      }
      group.scale(scaleRatio);
      group.set({ left: center.x, top: center.y });
      setObjectDefaults(group);
      group.objectCaching = false;
      group.setCoords();

      // Store design info for layers panel
      group.designInfo = {
        name: obj.designInfo?.name || 'Vector',
        type: 'vector'
      };

      // Remove the raster and focus the new vector
      fabricCanvas.remove(obj);
      fabricCanvas.setActiveObject(group);
      fabricCanvas.requestRenderAll();
      setVectorizeProgress(100);
      setStatus('Vectorized successfully');
      hideVectorizeLoading();
      updateLayersList();
      update3DPreview();
    } catch (e) {
      console.error('SVG import failed:', e);
      setStatus('SVG import failed', 'error');
      hideVectorizeLoading();
    }
  });
}

// ========================================
// EXPORT
// ========================================

let currentExportType = 'png';

function openExportModal(type) {
  currentExportType = type;

  els.exportModalTitle.textContent = type === 'png'
    ? 'Export as PNG'
    : type === 'gif'
      ? 'Export as Animated GIF'
      : 'Export as Video';

  // Show preview from 3D renderer
  let previewDataUrl;
  if (state.renderer && state.scene && state.camera) {
    // Render current frame
    state.renderer.render(state.scene, state.camera);
    previewDataUrl = state.renderer.domElement.toDataURL('image/png');
  } else {
    // Fallback to 2D canvas
    previewDataUrl = fabricCanvas.toDataURL({ format: 'png', multiplier: 0.5 });
  }

  els.exportPreview.innerHTML = `<img src="${previewDataUrl}" alt="Preview" />`;

  // Show/hide options based on type
  if (type === 'gif') {
    els.exportOptions.innerHTML = `
      <div class="export-option">
        <label>Duration</label>
        <select id="exportDuration">
          <option value="2">2 seconds</option>
          <option value="4" selected>4 seconds</option>
          <option value="6">6 seconds</option>
        </select>
      </div>
      <div class="export-option">
        <label>Resolution</label>
        <select id="exportResolution">
          <option value="1">Standard (1x)</option>
          <option value="2" selected>High (2x)</option>
        </select>
      </div>
    `;
  } else if (type === 'video') {
    els.exportOptions.innerHTML = `
      <div class="export-option">
        <label>Format</label>
        <select id="exportVideoFormat">
          <option value="mp4" selected>MP4 (Shopify/Social)</option>
          <option value="webm">WebM (Web)</option>
        </select>
      </div>
      <div class="export-option">
        <label>Duration</label>
        <select id="exportDuration">
          <option value="2">2 seconds</option>
          <option value="4" selected>4 seconds</option>
          <option value="6">6 seconds</option>
        </select>
      </div>
      <div class="export-option">
        <label>Resolution</label>
        <select id="exportResolution">
          <option value="1">Standard (1x)</option>
          <option value="2" selected>High (2x)</option>
        </select>
      </div>
    `;
  } else {
    els.exportOptions.innerHTML = `
      <div class="export-option">
        <label>Resolution</label>
        <select id="exportResolution">
          <option value="1">Standard (1x)</option>
          <option value="2" selected>High (2x)</option>
          <option value="4">Ultra (4x)</option>
        </select>
      </div>
    `;
  }

  els.exportProgress.hidden = true;
  els.exportModal.hidden = false;
}

function closeExportModal() {
  els.exportModal.hidden = true;
}

async function executeExport() {
  const resolution = parseInt(document.getElementById('exportResolution')?.value || '2');

  els.exportProgress.hidden = false;
  els.exportConfirmBtn.disabled = true;

  try {
    if (currentExportType === 'png') {
      await exportPng(resolution);
    } else if (currentExportType === 'gif') {
      const duration = parseInt(document.getElementById('exportDuration')?.value || '4');
      await exportGif(resolution, duration);
    } else if (currentExportType === 'video') {
      const duration = parseInt(document.getElementById('exportDuration')?.value || '4');
      const format = document.getElementById('exportVideoFormat')?.value || 'mp4';
      await exportVideo(resolution, duration, format);
    }
  } catch (err) {
    console.error('Export failed:', err);
    setStatus('Export failed: ' + err.message, 'error');
  } finally {
    els.exportConfirmBtn.disabled = false;
    closeExportModal();
  }
}

async function exportPng(multiplier = 2) {
  setExportProgress(0, 'Rendering 3D scene...');

  if (!state.renderer || !state.scene || !state.camera) {
    throw new Error('3D renderer not available');
  }

  // Store original renderer size
  const originalWidth = state.renderer.domElement.width;
  const originalHeight = state.renderer.domElement.height;

  // Calculate export size (based on renderer aspect ratio)
  const exportWidth = originalWidth * multiplier;
  const exportHeight = originalHeight * multiplier;

  // Resize renderer for high-res export
  state.renderer.setSize(exportWidth, exportHeight, false);
  state.camera.aspect = exportWidth / exportHeight;
  state.camera.updateProjectionMatrix();

  setExportProgress(30, 'Capturing frame...');

  // Render at high resolution
  state.renderer.render(state.scene, state.camera);
  const dataUrl = state.renderer.domElement.toDataURL('image/png');

  setExportProgress(60, 'Restoring view...');

  // Restore original size
  state.renderer.setSize(originalWidth, originalHeight, false);
  state.camera.aspect = originalWidth / originalHeight;
  state.camera.updateProjectionMatrix();
  state.renderer.render(state.scene, state.camera);

  setExportProgress(80, 'Preparing download...');

  // Trigger download
  const link = document.createElement('a');
  link.download = `mockup-${Date.now()}.png`;
  link.href = dataUrl;
  link.click();

  setExportProgress(100, 'Done!');
  setStatus('PNG exported successfully');
}

async function exportGif(multiplier = 2, duration = 4) {
  if (typeof GIF === 'undefined') {
    throw new Error('GIF.js library not loaded');
  }

  if (!state.renderer || !state.scene || !state.camera) {
    throw new Error('3D renderer not available');
  }

  const fps = 15;
  const totalFrames = fps * duration;
  const rotationPerFrame = (Math.PI * 2) / totalFrames;

  setExportProgress(0, 'Initializing GIF encoder...');

  // Store original renderer size
  const originalWidth = state.renderer.domElement.width;
  const originalHeight = state.renderer.domElement.height;

  // Calculate export size
  const exportWidth = Math.round(originalWidth * multiplier);
  const exportHeight = Math.round(originalHeight * multiplier);

  // Resize renderer for export
  state.renderer.setSize(exportWidth, exportHeight, false);
  state.camera.aspect = exportWidth / exportHeight;
  state.camera.updateProjectionMatrix();

  const gif = new GIF({
    workers: 2,
    quality: 10,
    width: exportWidth,
    height: exportHeight,
    workerScript: 'https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.worker.js'
  });

  // Create a pivot group at garment center to rotate everything together
  const pivotGroup = new THREE.Group();
  const box = new THREE.Box3().setFromObject(state.garmentMesh);
  const center = box.getCenter(new THREE.Vector3());
  pivotGroup.position.copy(center);
  state.scene.add(pivotGroup);

  // Move garment and decals into the pivot group (adjusting for pivot position)
  const garmentOriginalPos = state.garmentMesh.position.clone();
  state.scene.remove(state.garmentMesh);
  state.garmentMesh.position.sub(center);
  pivotGroup.add(state.garmentMesh);

  const decalOriginalPositions = {};
  Object.keys(state.decalMeshes).forEach(zone => {
    if (state.decalMeshes[zone]) {
      decalOriginalPositions[zone] = state.decalMeshes[zone].position.clone();
      state.scene.remove(state.decalMeshes[zone]);
      state.decalMeshes[zone].position.sub(center);
      pivotGroup.add(state.decalMeshes[zone]);
    }
  });

  for (let i = 0; i < totalFrames; i++) {
    setExportProgress((i / totalFrames) * 80, `Rendering frame ${i + 1}/${totalFrames}...`);

    const currentRotation = i * rotationPerFrame;

    // Rotate the pivot group (garment + decals rotate together)
    pivotGroup.rotation.y = currentRotation;

    // Render 3D scene
    state.renderer.render(state.scene, state.camera);

    // Capture frame from 3D renderer
    const frameCanvas = document.createElement('canvas');
    frameCanvas.width = exportWidth;
    frameCanvas.height = exportHeight;
    const ctx = frameCanvas.getContext('2d');
    ctx.drawImage(state.renderer.domElement, 0, 0);

    gif.addFrame(frameCanvas, { delay: 1000 / fps, copy: true });

    // Small delay to prevent UI freeze
    await new Promise(r => setTimeout(r, 10));
  }

  // Restore: move everything back to scene
  pivotGroup.remove(state.garmentMesh);
  state.garmentMesh.position.copy(garmentOriginalPos);
  state.scene.add(state.garmentMesh);

  Object.keys(state.decalMeshes).forEach(zone => {
    if (state.decalMeshes[zone] && decalOriginalPositions[zone]) {
      pivotGroup.remove(state.decalMeshes[zone]);
      state.decalMeshes[zone].position.copy(decalOriginalPositions[zone]);
      state.scene.add(state.decalMeshes[zone]);
    }
  });

  state.scene.remove(pivotGroup);

  // Restore original renderer size
  state.renderer.setSize(originalWidth, originalHeight, false);
  state.camera.aspect = originalWidth / originalHeight;
  state.camera.updateProjectionMatrix();
  state.renderer.render(state.scene, state.camera);

  setExportProgress(85, 'Encoding GIF...');

  return new Promise((resolve, reject) => {
    gif.on('finished', (blob) => {
      setExportProgress(100, 'Done!');

      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.download = `mockup-${Date.now()}.gif`;
      link.href = url;
      link.click();

      URL.revokeObjectURL(url);
      setStatus('GIF exported successfully');
      resolve();
    });

    gif.on('error', reject);
    gif.render();
  });
}

async function exportVideo(multiplier = 2, duration = 4, format = 'mp4') {
  if (!state.renderer || !state.scene || !state.camera) {
    throw new Error('3D renderer not available');
  }

  const fps = 30;
  const totalFrames = fps * duration;

  setExportProgress(0, 'Setting up video recorder...');

  // Store original renderer size
  const originalWidth = state.renderer.domElement.width;
  const originalHeight = state.renderer.domElement.height;

  // Calculate export size
  const exportWidth = Math.round(originalWidth * multiplier);
  const exportHeight = Math.round(originalHeight * multiplier);

  // Resize renderer for export
  state.renderer.setSize(exportWidth, exportHeight, false);
  state.camera.aspect = exportWidth / exportHeight;
  state.camera.updateProjectionMatrix();

  // Create canvas for video recording
  const canvas = document.createElement('canvas');
  canvas.width = exportWidth;
  canvas.height = exportHeight;
  const ctx = canvas.getContext('2d');

  const stream = canvas.captureStream(fps);

  // Determine mimeType based on format and browser support
  let mimeType, fileExt;
  if (format === 'mp4') {
    // Try MP4 with H.264 codec (best compatibility for Shopify/social)
    const mp4Types = [
      'video/mp4;codecs=avc1.42E01E',
      'video/mp4;codecs=h264',
      'video/mp4'
    ];
    mimeType = mp4Types.find(type => MediaRecorder.isTypeSupported(type));

    if (!mimeType) {
      // Fallback to WebM if MP4 not supported, we'll note it in the filename
      console.warn('MP4 not supported, falling back to WebM');
      mimeType = 'video/webm;codecs=vp9';
      fileExt = 'webm';
      setStatus('MP4 not supported in this browser, using WebM', 'warning');
    } else {
      fileExt = 'mp4';
    }
  } else {
    mimeType = 'video/webm;codecs=vp9';
    fileExt = 'webm';
  }

  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 8000000 // Higher bitrate for better quality
  });

  const chunks = [];
  recorder.ondataavailable = (e) => chunks.push(e.data);

  recorder.start();

  // Create a pivot group at garment center to rotate everything together
  const pivotGroup = new THREE.Group();
  const box = new THREE.Box3().setFromObject(state.garmentMesh);
  const center = box.getCenter(new THREE.Vector3());
  pivotGroup.position.copy(center);
  state.scene.add(pivotGroup);

  // Move garment and decals into the pivot group (adjusting for pivot position)
  const garmentOriginalPos = state.garmentMesh.position.clone();
  state.scene.remove(state.garmentMesh);
  state.garmentMesh.position.sub(center);
  pivotGroup.add(state.garmentMesh);

  const decalOriginalPositions = {};
  Object.keys(state.decalMeshes).forEach(zone => {
    if (state.decalMeshes[zone]) {
      decalOriginalPositions[zone] = state.decalMeshes[zone].position.clone();
      state.scene.remove(state.decalMeshes[zone]);
      state.decalMeshes[zone].position.sub(center);
      pivotGroup.add(state.decalMeshes[zone]);
    }
  });

  for (let i = 0; i < totalFrames; i++) {
    setExportProgress((i / totalFrames) * 90, `Recording frame ${i + 1}/${totalFrames}...`);

    // Calculate current rotation
    const currentRotation = (i / totalFrames) * Math.PI * 2;

    // Rotate the pivot group (garment + decals rotate together)
    pivotGroup.rotation.y = currentRotation;

    // Render 3D scene
    state.renderer.render(state.scene, state.camera);

    // Draw 3D renderer to video canvas
    ctx.drawImage(state.renderer.domElement, 0, 0);

    await new Promise(r => setTimeout(r, 1000 / fps));
  }

  // Restore: move everything back to scene
  pivotGroup.remove(state.garmentMesh);
  state.garmentMesh.position.copy(garmentOriginalPos);
  state.scene.add(state.garmentMesh);

  Object.keys(state.decalMeshes).forEach(zone => {
    if (state.decalMeshes[zone] && decalOriginalPositions[zone]) {
      pivotGroup.remove(state.decalMeshes[zone]);
      state.decalMeshes[zone].position.copy(decalOriginalPositions[zone]);
      state.scene.add(state.decalMeshes[zone]);
    }
  });

  state.scene.remove(pivotGroup);

  // Restore original renderer size
  state.renderer.setSize(originalWidth, originalHeight, false);
  state.camera.aspect = originalWidth / originalHeight;
  state.camera.updateProjectionMatrix();
  state.renderer.render(state.scene, state.camera);

  recorder.stop();

  return new Promise((resolve) => {
    recorder.onstop = () => {
      setExportProgress(100, 'Done!');

      const blobType = fileExt === 'mp4' ? 'video/mp4' : 'video/webm';
      const blob = new Blob(chunks, { type: blobType });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.download = `mockup-${Date.now()}.${fileExt}`;
      link.href = url;
      link.click();

      URL.revokeObjectURL(url);
      setStatus(`Video exported successfully as ${fileExt.toUpperCase()}`);
      resolve();
    };
  });
}

function setExportProgress(percent, text) {
  els.exportProgressBar.style.width = percent + '%';
  els.exportProgressText.textContent = text;
}

// ========================================
// SAVE TO LIBRARY
// ========================================

async function saveToLibrary() {
  try {
    const name = prompt('Name this mockup:', `Mockup ${new Date().toLocaleString()}`);
    if (!name) return;

    if (!state.renderer || !state.scene || !state.camera) {
      throw new Error('3D renderer not available');
    }

    setStatus('Saving to library...');

    // Store original renderer size
    const originalWidth = state.renderer.domElement.width;
    const originalHeight = state.renderer.domElement.height;

    // Resize for high-res capture
    const multiplier = 2;
    const exportWidth = originalWidth * multiplier;
    const exportHeight = originalHeight * multiplier;

    state.renderer.setSize(exportWidth, exportHeight, false);
    state.camera.aspect = exportWidth / exportHeight;
    state.camera.updateProjectionMatrix();

    // Render and capture
    state.renderer.render(state.scene, state.camera);
    const dataUrl = state.renderer.domElement.toDataURL('image/png');

    // Restore original size
    state.renderer.setSize(originalWidth, originalHeight, false);
    state.camera.aspect = originalWidth / originalHeight;
    state.camera.updateProjectionMatrix();
    state.renderer.render(state.scene, state.camera);

    const blob = await (await fetch(dataUrl)).blob();
    const fileName = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}.png`;
    const file = new File([blob], fileName, { type: 'image/png' });

    const form = new FormData();
    form.append('displayName', name);
    form.append('existingCategory', 'our-clothing-apparel');
    form.append('preview', file, fileName);
    form.append('apparelEnabled', '1');
    form.append('apparelProductType', state.currentGarment);
    form.append('apparelCategory', 'Our Clothing Apparel');

    const res = await fetch('/api/admin/artwork', { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data?.success) {
      throw new Error(data?.error || 'Upload failed');
    }

    setStatus('Saved to library!');

  } catch (err) {
    console.error('Save failed:', err);
    setStatus('Save failed: ' + err.message, 'error');
  }
}

// ========================================
// UTILITY FUNCTIONS
// ========================================

function setStatus(message, type = 'info') {
  els.statusText.textContent = message;
  els.statusText.style.color = type === 'error' ? '#ef4444' : '#94a3b8';
}

// ========================================
// EVENT LISTENERS
// ========================================

function initEventListeners() {
  // Apparel color
  els.apparelColorPicker.addEventListener('input', (e) => {
    state.apparelColor = e.target.value;
    applyApparelColor();
    update3DPreview();
  });

  els.colorPresets.addEventListener('click', (e) => {
    const preset = e.target.closest('.color-preset');
    if (!preset) return;

    state.apparelColor = preset.dataset.color;
    els.apparelColorPicker.value = state.apparelColor;
    applyApparelColor();
    update3DPreview();

    // Update active state
    document.querySelectorAll('.color-preset').forEach(p => p.classList.remove('active'));
    preset.classList.add('active');
  });

  // Garment type
  els.garmentType.addEventListener('change', (e) => {
    state.currentGarment = e.target.value;
    createPlaceholderGarment();
    // Load new 3D garment model
    load3DGarment(state.currentGarment);
  });

  // Model type (mannequin selection)
  els.modelType.addEventListener('change', (e) => {
    state.currentModel = e.target.value;
    // Load mannequin model (or remove if "ghost" mode)
    load3DMannequin(state.currentModel);
  });

  // Sidebar tabs
  els.sidebarTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = tab.dataset.tab;

      els.sidebarTabs.forEach(t => t.classList.remove('sidebar__tab--active'));
      tab.classList.add('sidebar__tab--active');

      document.querySelectorAll('.sidebar__panel').forEach(p => {
        p.hidden = p.dataset.panel !== tabName;
      });
    });
  });

  // Catalog
  els.catalogSearch.addEventListener('input', filterCatalog);
  els.catalogCategory.addEventListener('change', filterCatalog);
  els.loadMoreBtn.addEventListener('click', renderCatalog);

  // Text tool
  els.addTextBtn.addEventListener('click', addText);
  els.textInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') addText();
  });

  // Text style buttons
  els.textBold.addEventListener('click', () => {
    els.textBold.classList.toggle('active');
    updateSelectedText();
  });

  els.textItalic.addEventListener('click', () => {
    els.textItalic.classList.toggle('active');
    updateSelectedText();
  });

  els.textUnderline.addEventListener('click', () => {
    els.textUnderline.classList.toggle('active');
    updateSelectedText();
  });

  // Text properties
  [els.fontFamily, els.fontSize, els.textColor, els.textStrokeWidth, els.textStrokeColor].forEach(el => {
    el.addEventListener('change', updateSelectedText);
  });

  els.textRotation.addEventListener('input', (e) => {
    els.textRotationValue.textContent = `${e.target.value}°`;
    updateSelectedText();
  });

  // Layers
  els.deleteLayerBtn.addEventListener('click', deleteSelectedLayer);

  // Zone buttons
  els.zoneBtns.forEach(btn => {
    btn.addEventListener('click', () => switchZone(btn.dataset.zone));
  });

  // Editor tools
  els.centerDesignBtn.addEventListener('click', centerSelected);
  els.flipHorizontalBtn.addEventListener('click', flipHorizontal);
  els.flipVerticalBtn.addEventListener('click', flipVertical);
  els.bringForwardBtn.addEventListener('click', bringForward);
  els.sendBackwardBtn.addEventListener('click', sendBackward);
  if (els.vectorizeBtn) {
    els.vectorizeBtn.addEventListener('click', vectorizeSelected);
  }

  // Preview tools
  els.resetViewBtn.addEventListener('click', reset3DView);
  els.toggleRotateBtn.addEventListener('click', toggleAutoRotate);

  // Export buttons
  els.exportPngBtn.addEventListener('click', () => openExportModal('png'));
  els.exportGifBtn.addEventListener('click', () => openExportModal('gif'));
  els.exportVideoBtn.addEventListener('click', () => openExportModal('video'));
  els.saveToLibraryBtn.addEventListener('click', saveToLibrary);

  // Export modal
  els.exportModal.addEventListener('click', (e) => {
    if (e.target.hasAttribute('data-close') || e.target.closest('[data-close]')) {
      closeExportModal();
    }
  });

  els.exportConfirmBtn.addEventListener('click', executeExport);

  // Drag and drop on canvas
  els.editorCanvasWrap.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.currentTarget.style.outline = '2px dashed #3b82f6';
  });

  els.editorCanvasWrap.addEventListener('dragleave', (e) => {
    e.currentTarget.style.outline = '';
  });

  els.editorCanvasWrap.addEventListener('drop', (e) => {
    e.preventDefault();
    e.currentTarget.style.outline = '';

    try {
      const data = e.dataTransfer.getData('application/json');
      if (data) {
        const design = JSON.parse(data);
        addDesignToCanvas(design);
      }
    } catch (err) {
      console.warn('Drop failed:', err);
    }
  });

  // Window resize
  window.addEventListener('resize', () => {
    updateZoneGuide();
    updateColorOverlay();
    on3DResize();
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (state.selectedObject && !state.selectedObject.isEditing) {
        deleteSelectedLayer();
      }
    }

    if (e.ctrlKey || e.metaKey) {
      if (e.key === 'c') {
        // Copy handled by Fabric
      } else if (e.key === 'v') {
        // Paste handled by Fabric
      } else if (e.key === 'z') {
        // TODO: Undo
      } else if (e.key === 'y') {
        // TODO: Redo
      }
    }
  });
}

// ========================================
// INITIALIZATION
// ========================================

// Apparel browser instance
let apparelBrowser = null;

async function init() {
  setStatus('Initializing...');

  // Initialize Fabric.js canvas
  initFabricCanvas();

  // Initialize Three.js preview
  init3DPreview();

  // Set up event listeners
  initEventListeners();

  // Initialize apparel browser
  apparelBrowser = new ApparelBrowser({
    onSelectVariant: (variant) => {
      console.log('Selected variant:', variant);
      // Update canvas with selected apparel
      if (variant.imageUrl) {
        loadApparelBackgroundImage(variant.imageUrl, variant.backImageUrl);
      }
      // Update apparel color
      if (variant.color) {
        const hexColor = apparelBrowser.colorNameToHex(variant.color);
        state.apparelColor = hexColor;
        els.apparelColorPicker.value = hexColor;
        applyApparelColor();
        update3DPreview();
      }
      // Store selected apparel info
      state.selectedApparel = variant;
      setStatus(`Using ${variant.color || ''} ${variant.styleName || 'apparel'}`);
    },
    onApparelColorChange: (hexColor) => {
      state.apparelColor = hexColor;
      els.apparelColorPicker.value = hexColor;
      applyApparelColor();
      update3DPreview();
    }
  });

  // Load catalog
  await loadCatalog();

  // Initial UI updates
  updateZoneGuide();
  updateColorOverlay();

  setStatus('Ready');
}

// Load apparel background image (front and optionally back)
function loadApparelBackgroundImage(frontUrl, backUrl) {
  if (!frontUrl) return;

  // Store URLs for front/back switching
  state.frontImageUrl = frontUrl;
  state.backImageUrl = backUrl;

  // Load the appropriate image based on current zone
  const imageUrl = state.currentZone === 'back' && backUrl ? backUrl : frontUrl;

  fabric.Image.fromURL(imageUrl, (img) => {
    if (!img) {
      setStatus('Failed to load apparel image', 'error');
      return;
    }

    // Remove existing garment shape
    const toRemove = fabricCanvas.getObjects().filter(obj => obj.isGarment);
    toRemove.forEach(obj => fabricCanvas.remove(obj));

    // Scale to fit canvas
    const scale = Math.min(
      CONFIG.canvasWidth / img.width,
      CONFIG.canvasHeight / img.height
    ) * 0.95;

    img.scale(scale);
    img.set({
      left: CONFIG.canvasWidth / 2,
      top: CONFIG.canvasHeight / 2,
      originX: 'center',
      originY: 'center',
      selectable: false,
      evented: false
    });

    img.isGarment = true;
    img.isRealImage = true; // Flag to skip color tinting on real images

    fabricCanvas.add(img);
    fabricCanvas.sendToBack(img);
    fabricCanvas.renderAll();

    update3DPreview();
    setStatus('Apparel loaded');

  }, { crossOrigin: 'anonymous' });
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
