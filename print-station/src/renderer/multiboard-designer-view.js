// =============== Multiboard Designer View ===============
// Phase 1: Scene + Grid + Tiles
// Phase 2: Accessories + Snap System + Color Picker
// Phase 3: Pricing + Quotes

const mbApi = {
  getServerUrl() {
    return window.printStationConfig?.serverBaseUrl || window.APP_CONFIG?.serverUrl || 'https://store.swayzecustomvinyl.com';
  },
  getHeaders() {
    return {
      'Content-Type': 'application/json',
      'x-api-key': window.printStationConfig?.apiKey || window.APP_CONFIG?.internalKey || ''
    };
  },
  async get(path) {
    const response = await fetch(`${this.getServerUrl()}${path}`, { headers: this.getHeaders() });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Request failed: ${response.status}`);
    }
    return response.json();
  },
  async post(path, data) {
    const response = await fetch(`${this.getServerUrl()}${path}`, {
      method: 'POST', headers: this.getHeaders(), body: JSON.stringify(data)
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || `Request failed: ${response.status}`);
    }
    return response.json();
  },
  async put(path, data) {
    const response = await fetch(`${this.getServerUrl()}${path}`, {
      method: 'PUT', headers: this.getHeaders(), body: JSON.stringify(data)
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || `Request failed: ${response.status}`);
    }
    return response.json();
  },
  async delete(path) {
    const response = await fetch(`${this.getServerUrl()}${path}`, {
      method: 'DELETE', headers: this.getHeaders()
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || `Request failed: ${response.status}`);
    }
    return response.json();
  }
};

// =============== STATE ===============

const mbState = {
  initialized: false,
  // Three.js
  scene: null,
  renderer: null,
  camera: null,
  controls: null,
  animFrameId: null,
  _resizeObserver: null,
  // Scene objects
  wallMesh: null,
  gridHelper: null,
  showGrid: true,
  snapPointMarkers: [],  // visual snap indicators on hovered tile
  // Catalog
  catalog: null,
  // Placed components (tiles + accessories)
  tiles: [],        // { id, partId, gridX, gridY, mesh, color, attachedToId? }
  nextTileId: 1,
  // Interaction
  selectedTile: null,
  isPlacing: false,
  placingPart: null,
  previewMesh: null,
  _movingComp: null,  // saved state when moving a component
  hoveredTileId: null,  // tile currently hovered during accessory placement
  raycaster: null,
  mouse: null,
  wallPlane: null,
  // Dimensions (in grid units; 1 unit = 1 inch)
  wallWidth: 48,
  wallHeight: 36,
  // Save/Load
  currentDesignId: null,
  // Pricing
  serviceLevel: 'designBuild',
  customerName: '',
  customerEmail: '',
  customerPhone: '',
  designStatus: 'draft'
};

// =============== COLOR PALETTE ===============

const MB_COLORS = {
  wall: 0x2c3e50,
  wallEdge: 0x1a252f,
  grid: 0x445566,
  gridCenter: 0x556677,
  tileDefault: 0x333333,
  tileHover: 0x00cc66,
  tileInvalid: 0xcc3333,
  tileSelected: 0x2196f3,
  snapPoint: 0x00ffaa,
  snapPointInvalid: 0xff4444,
  background: 0x1a1a2e
};

// Part category display order and labels
const MB_CATEGORIES = [
  { key: 'tiles',       label: 'Tiles' },
  { key: 'hooks',       label: 'Hooks' },
  { key: 'bins',        label: 'Bins & Trays' },
  { key: 'shelves',     label: 'Shelves' },
  { key: 'pegs',        label: 'Pegs' },
  { key: 'accessories', label: 'Accessories' },
  { key: 'hardware',    label: 'Hardware' },
];

// =============== PROCEDURAL TILE TEXTURE ===============

let mbTileCanvasCache = null;

function mbGetTileCanvases() {
  if (mbTileCanvasCache) return mbTileCanvasCache;

  const res = 256; // pixels per grid cell (25mm)
  const cx = res / 2, cy = res / 2;
  const multiR = res * 0.28;  // multihole radius
  const pegR = res * 0.065;   // pegboard hole radius
  const lipW = res * 0.025;   // lip/ridge width

  // --- Diffuse Map (grayscale, modulated by material.color) ---
  const diffCanvas = document.createElement('canvas');
  diffCanvas.width = res; diffCanvas.height = res;
  const dc = diffCanvas.getContext('2d');

  // Base surface - light so material color shows through
  dc.fillStyle = '#d8d8d8';
  dc.fillRect(0, 0, res, res);

  // Subtle surface texture: concentric print lines
  dc.strokeStyle = '#d0d0d0';
  dc.lineWidth = 0.5;
  for (let r = 8; r < res; r += 6) {
    dc.beginPath(); dc.arc(cx, cy, r, 0, Math.PI * 2); dc.stroke();
  }

  // Multihole: lip ring (raised edge, lighter)
  mbDrawOctagon(dc, cx, cy, multiR + lipW, '#e8e8e8');
  // Multihole: hole (dark depression)
  mbDrawOctagon(dc, cx, cy, multiR, '#2a2a2a');
  // Inner bevel (slightly lighter to suggest depth)
  mbDrawOctagon(dc, cx, cy, multiR - res * 0.015, '#222222');

  // Pegboard holes at cell corners (each shared with 4 adjacent cells)
  const corners = [[0, 0], [res, 0], [0, res], [res, res]];
  corners.forEach(([px, py]) => {
    // Lip
    dc.beginPath(); dc.arc(px, py, pegR + lipW, 0, Math.PI * 2);
    dc.fillStyle = '#e4e4e4'; dc.fill();
    // Hole
    dc.beginPath(); dc.arc(px, py, pegR, 0, Math.PI * 2);
    dc.fillStyle = '#383838'; dc.fill();
  });

  // Edge pegboard holes at midpoints of cell edges (shared with 2 adjacent cells)
  const edges = [[cx, 0], [cx, res], [0, cy], [res, cy]];
  edges.forEach(([px, py]) => {
    dc.beginPath(); dc.arc(px, py, pegR * 0.7 + lipW, 0, Math.PI * 2);
    dc.fillStyle = '#e0e0e0'; dc.fill();
    dc.beginPath(); dc.arc(px, py, pegR * 0.7, 0, Math.PI * 2);
    dc.fillStyle = '#404040'; dc.fill();
  });

  // --- Bump Map (height: white=raised, black=depressed) ---
  const bumpCanvas = document.createElement('canvas');
  bumpCanvas.width = res; bumpCanvas.height = res;
  const bc = bumpCanvas.getContext('2d');

  // Flat surface baseline
  bc.fillStyle = '#808080';
  bc.fillRect(0, 0, res, res);

  // Multihole lip (raised ridge)
  mbDrawOctagon(bc, cx, cy, multiR + lipW, '#b8b8b8');
  // Multihole depression
  mbDrawOctagon(bc, cx, cy, multiR, '#1a1a1a');

  // Pegboard holes
  corners.forEach(([px, py]) => {
    bc.beginPath(); bc.arc(px, py, pegR + lipW, 0, Math.PI * 2);
    bc.fillStyle = '#a8a8a8'; bc.fill();
    bc.beginPath(); bc.arc(px, py, pegR, 0, Math.PI * 2);
    bc.fillStyle = '#282828'; bc.fill();
  });

  edges.forEach(([px, py]) => {
    bc.beginPath(); bc.arc(px, py, pegR * 0.7 + lipW, 0, Math.PI * 2);
    bc.fillStyle = '#a0a0a0'; bc.fill();
    bc.beginPath(); bc.arc(px, py, pegR * 0.7, 0, Math.PI * 2);
    bc.fillStyle = '#303030'; bc.fill();
  });

  mbTileCanvasCache = { diffCanvas, bumpCanvas };
  return mbTileCanvasCache;
}

function mbDrawOctagon(ctx, cx, cy, radius, color) {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const angle = (i * Math.PI / 4) - Math.PI / 8;
    ctx.lineTo(cx + radius * Math.cos(angle), cy + radius * Math.sin(angle));
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function mbCreateTileMaterial(part, hexColor) {
  const { diffCanvas, bumpCanvas } = mbGetTileCanvases();

  const map = new THREE.CanvasTexture(diffCanvas);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.repeat.set(part.gridWidth, part.gridHeight);

  const bumpMap = new THREE.CanvasTexture(bumpCanvas);
  bumpMap.wrapS = bumpMap.wrapT = THREE.RepeatWrapping;
  bumpMap.repeat.set(part.gridWidth, part.gridHeight);

  return new THREE.MeshStandardMaterial({
    color: hexColor,
    map: map,
    bumpMap: bumpMap,
    bumpScale: 0.12,
    metalness: 0.1,
    roughness: 0.7
  });
}

// =============== INITIALIZATION ===============

function initMultiboardDesignerView() {
  if (!mbState.initialized) {
    mbState.initialized = true;
    setupMultiboardEventListeners();
    loadMultiboardCatalog();
    // Re-fit on window resize
    window.addEventListener('resize', mbFitDesignerToViewport);
  }
  if (mbState.scene && !mbState.animFrameId) {
    mbAnimate();
  }
  if (!mbState.scene) {
    setTimeout(() => mbInitScene(), 50);
  }
  // Lock section to fill exactly the remaining viewport
  mbFitDesignerToViewport();
}

function mbFitDesignerToViewport() {
  const section = document.getElementById('multiboardDesignerView');
  if (!section || !section.classList.contains('active')) return;
  // Find where the nav ends
  const nav = document.querySelector('.tab-bar');
  const navBottom = nav ? nav.getBoundingClientRect().bottom : 0;
  // Position the designer fixed, filling from nav bottom to viewport bottom
  section.style.position = 'fixed';
  section.style.top = navBottom + 'px';
  section.style.left = '0';
  section.style.right = '0';
  section.style.bottom = '0';
  section.style.height = 'auto';
  section.style.zIndex = '5';
}

async function loadMultiboardCatalog() {
  try {
    mbState.catalog = await mbApi.get('/api/multiboard/parts');
    renderMbPartsList();
  } catch (err) {
    console.error('[Multiboard] Failed to load catalog:', err);
    mbState.catalog = { parts: [], colorPresets: [] };
  }
}

// =============== SIDEBAR: CATEGORIZED PARTS LIST ===============

function renderMbPartsList() {
  const container = document.getElementById('mbPartsList');
  if (!container || !mbState.catalog) return;
  container.innerHTML = '';

  MB_CATEGORIES.forEach(cat => {
    const parts = mbState.catalog.parts.filter(p => !p.hidden && p.category === cat.key);
    if (parts.length === 0) return;

    // Category header
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;padding:6px 0;margin-bottom:4px;user-select:none;';
    header.innerHTML = `<span style="font-size:10px;transition:transform 0.2s;">&#9660;</span><span style="font-size:12px;font-weight:600;color:#aaa;text-transform:uppercase;letter-spacing:0.5px;">${cat.label}</span>`;
    const arrow = header.querySelector('span');
    const group = document.createElement('div');

    header.addEventListener('click', () => {
      const collapsed = group.style.display === 'none';
      group.style.display = collapsed ? 'block' : 'none';
      arrow.style.transform = collapsed ? '' : 'rotate(-90deg)';
    });

    container.appendChild(header);

    // Part cards
    parts.forEach(part => {
      const card = document.createElement('div');
      card.className = 'mb-part-card';
      card.dataset.partId = part.id;

      const previewColor = part.colors[0] || '#333';
      const sizeLabel = part.gridWidth > 0 ? `${part.gridWidth}x${part.gridHeight}` : '';
      const typeIcon = mbGetPartIcon(part);

      // Build badge indicators for hardware/tray requirements
      const badges = [];
      if (part._mountHardware && part._mountHardware.length) {
        const hw = part._mountHardware[0];
        badges.push(`<span style="font-size:9px;padding:1px 4px;border-radius:3px;background:#5d4037;color:#ffcc80;">${hw.type === 'magnet' ? 'magnet' : hw.type === 'screw' ? 'screw' : hw.type}</span>`);
      }
      if (part._requiresTray) {
        badges.push('<span style="font-size:9px;padding:1px 4px;border-radius:3px;background:#4a148c;color:#ce93d8;">tray</span>');
      }
      if (part._hasMethodChoice) {
        badges.push('<span style="font-size:9px;padding:1px 4px;border-radius:3px;background:#1565c0;color:#90caf9;">A/B</span>');
      } else if (part.requiresHardware && part.requiresHardware.length) {
        const hwCount = part.requiresHardware.reduce((sum, h) => sum + h.qty, 0);
        badges.push(`<span style="font-size:9px;padding:1px 4px;border-radius:3px;background:#37474f;color:#b0bec5;">\u00d7${hwCount} hw</span>`);
      }
      const badgeHtml = badges.length ? `<span style="margin-left:4px;">${badges.join(' ')}</span>` : '';

      card.innerHTML = `
        <div style="background:${previewColor};width:44px;height:44px;border-radius:4px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
          <span style="color:#fff;font-size:${sizeLabel ? '11' : '16'}px;font-weight:600;">${sizeLabel || typeIcon}</span>
        </div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:500;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${part.name}</div>
          <div style="font-size:12px;color:#888;">$${part.priceUSD.toFixed(2)}${badgeHtml}</div>
        </div>
      `;
      card.style.cssText = 'display:flex;gap:10px;align-items:center;padding:8px;border-radius:6px;cursor:pointer;border:2px solid transparent;margin-bottom:4px;transition:all 0.15s;';
      card.addEventListener('mouseenter', () => {
        if (!mbState.isPlacing || mbState.placingPart?.id !== part.id) card.style.borderColor = '#555';
      });
      card.addEventListener('mouseleave', () => {
        if (!mbState.isPlacing || mbState.placingPart?.id !== part.id) card.style.borderColor = 'transparent';
      });
      card.addEventListener('click', () => mbStartPlacing(part));
      group.appendChild(card);
    });

    container.appendChild(group);
  });
}

function mbGetPartIcon(part) {
  const type = part.geometry?.type;
  if (type === 'hook') return '\u2E28';   // hook-like
  if (type === 'bin') return '\u25A1';     // box
  if (type === 'shelf') return '\u2015';   // horizontal bar
  return '\u25A0';
}

// =============== THREE.JS SCENE ===============

function mbInitScene() {
  const container = document.getElementById('mbCanvasContainer');
  if (!container) {
    console.warn('[Multiboard] Canvas container not found');
    return;
  }

  const width = container.clientWidth;
  const height = container.clientHeight;
  console.log('[Multiboard] Container size:', width, 'x', height);
  if (width < 10 || height < 10) {
    console.log('[Multiboard] Container too small, retrying...');
    setTimeout(() => mbInitScene(), 100);
    return;
  }

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(MB_COLORS.background);

  const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 5000);
  const maxDim = Math.max(mbState.wallWidth, mbState.wallHeight);
  camera.position.set(0, 0, maxDim * 1.8);
  camera.lookAt(0, 0, 0);

  const canvas = document.getElementById('mbCanvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  scene.add(new THREE.AmbientLight(0x808080, 1.2));
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
  dirLight.position.set(20, 30, 50);
  scene.add(dirLight);
  const backLight = new THREE.DirectionalLight(0x4488ff, 0.3);
  backLight.position.set(-20, -10, -30);
  scene.add(backLight);

  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;
  controls.minPolarAngle = Math.PI * 0.1;
  controls.maxPolarAngle = Math.PI * 0.9;
  controls.minDistance = 10;
  controls.maxDistance = maxDim * 4;

  mbState.scene = scene;
  mbState.renderer = renderer;
  mbState.camera = camera;
  mbState.controls = controls;
  mbState.raycaster = new THREE.Raycaster();
  mbState.mouse = new THREE.Vector2();
  mbState.wallPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

  mbBuildWall();
  mbBuildGrid();
  mbAnimate();

  const resizeObserver = new ResizeObserver(() => {
    if (!mbState.renderer) return;
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w < 10 || h < 10) return;
    mbState.camera.aspect = w / h;
    mbState.camera.updateProjectionMatrix();
    mbState.renderer.setSize(w, h);
  });
  resizeObserver.observe(container);
  mbState._resizeObserver = resizeObserver;

  // Use pointerdown/pointerup to avoid OrbitControls consuming clicks
  let pointerDownPos = null;
  canvas.addEventListener('mousemove', mbOnMouseMove);
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button === 0) pointerDownPos = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener('pointerup', (e) => {
    if (e.button !== 0 || !pointerDownPos) return;
    const dx = e.clientX - pointerDownPos.x;
    const dy = e.clientY - pointerDownPos.y;
    pointerDownPos = null;
    if (Math.abs(dx) < 5 && Math.abs(dy) < 5) {
      mbOnClick(e);
    }
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  console.log('[Multiboard] Scene initialized successfully. Canvas:', width, 'x', height);
}

function mbBuildWall() {
  if (mbState.wallMesh) {
    mbState.scene.remove(mbState.wallMesh);
    mbState.wallMesh.geometry.dispose();
    mbState.wallMesh.material.dispose();
  }
  const w = mbState.wallWidth;
  const h = mbState.wallHeight;
  const geometry = new THREE.BoxGeometry(w, h, 0.3);
  const material = new THREE.MeshPhongMaterial({ color: MB_COLORS.wall, specular: 0x111111, shininess: 10 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(0, 0, -0.15);
  mesh.userData.isWall = true;
  mbState.scene.add(mesh);
  mbState.wallMesh = mesh;
}

function mbBuildGrid() {
  if (mbState.gridHelper) {
    mbState.scene.remove(mbState.gridHelper);
    mbState.gridHelper.geometry.dispose();
    mbState.gridHelper.material.dispose();
  }
  if (!mbState.showGrid) return;

  const w = mbState.wallWidth;
  const h = mbState.wallHeight;
  const points = [];
  const halfW = w / 2;
  const halfH = h / 2;
  for (let x = -halfW; x <= halfW; x++) {
    points.push(new THREE.Vector3(x, -halfH, 0.01));
    points.push(new THREE.Vector3(x, halfH, 0.01));
  }
  for (let y = -halfH; y <= halfH; y++) {
    points.push(new THREE.Vector3(-halfW, y, 0.01));
    points.push(new THREE.Vector3(halfW, y, 0.01));
  }
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({ color: MB_COLORS.grid, transparent: true, opacity: 0.25 });
  const grid = new THREE.LineSegments(geometry, material);
  mbState.scene.add(grid);
  mbState.gridHelper = grid;
}

function mbAnimate() {
  mbState.animFrameId = requestAnimationFrame(mbAnimate);
  if (mbState.controls) mbState.controls.update();
  if (mbState.renderer && mbState.scene && mbState.camera) {
    mbState.renderer.render(mbState.scene, mbState.camera);
  }
}

// =============== STL MESH LOADING ===============

const _mbStlGeoCache = {};  // stlCatalogId -> THREE.BufferGeometry (already oriented)

/**
 * Find the mount normal — the direction the snap / mount surface faces.
 *
 * Combined strategy using three independent signals:
 *   1. PROTRUSION DETECTION — For each of the 6 bounding-box faces, count how
 *      many vertices are within a thin slab at that face. Snap pins / hook tips
 *      are sparse geometry at the extremes. The face with far fewer vertices
 *      than its opposite = the snap side (mount normal points outward from there).
 *   2. FLAT-FACE AREA — Sum area-weighted normals per axis-direction. The
 *      direction with the most flat-face area is typically the back plate
 *      (mount surface).
 *   3. THIN-AXIS TIEBREAK — The thinnest bounding-box axis is the wall-mount
 *      axis for most parts (hooks, labels, brackets).
 *
 * Each method votes with a confidence score; the direction with the highest
 * combined score wins.
 */
function mbFindMountNormal(geometry) {
  const positions = geometry.getAttribute('position');
  const normals = geometry.getAttribute('normal');
  if (!positions || !normals) return [0, 0, -1];

  geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  const extents = [
    bb.max.x - bb.min.x,
    bb.max.y - bb.min.y,
    bb.max.z - bb.min.z
  ];
  const maxExtent = Math.max(...extents);
  if (maxExtent < 1e-6) return [0, 0, -1];

  const vtxCount = positions.count;

  // ── 1. Protrusion detection: vertex density near each bounding-box face ──
  const slabFraction = 0.08; // 8% of axis extent
  const faceCounts = []; // [minCount, maxCount] per axis
  for (let axis = 0; axis < 3; axis++) {
    const lo = axis === 0 ? bb.min.x : axis === 1 ? bb.min.y : bb.min.z;
    const hi = axis === 0 ? bb.max.x : axis === 1 ? bb.max.y : bb.max.z;
    const slab = (hi - lo) * slabFraction;
    let minCount = 0, maxCount = 0;
    for (let v = 0; v < vtxCount; v++) {
      const val = axis === 0 ? positions.getX(v) : axis === 1 ? positions.getY(v) : positions.getZ(v);
      if (val <= lo + slab) minCount++;
      if (val >= hi - slab) maxCount++;
    }
    faceCounts.push([minCount, maxCount]);
  }

  // Score each of 6 directions: +X, -X, +Y, -Y, +Z, -Z
  const scores = new Float64Array(6);
  for (let axis = 0; axis < 3; axis++) {
    const [minC, maxC] = faceCounts[axis];
    const total = minC + maxC || 1;
    const asymmetry = Math.abs(maxC - minC) / total;
    if (asymmetry > 0.15) {
      if (maxC < minC) {
        // Fewer vertices at max end = protrusion there = mount normal is +axis
        scores[axis * 2] += asymmetry * 3.0;
      } else {
        scores[axis * 2 + 1] += asymmetry * 3.0;
      }
    }
  }

  // ── 2. Flat-face area analysis ──
  const triCount = positions.count / 3;
  const areaByDir = new Float64Array(6);
  for (let i = 0; i < triCount; i++) {
    const i0 = i * 3, i1 = i * 3 + 1, i2 = i * 3 + 2;
    const nx = normals.getX(i0), ny = normals.getY(i0), nz = normals.getZ(i0);
    const anx = Math.abs(nx), any = Math.abs(ny), anz = Math.abs(nz);
    let dirIdx;
    if (anx >= any && anx >= anz) dirIdx = nx > 0 ? 0 : 1;
    else if (any >= anx && any >= anz) dirIdx = ny > 0 ? 2 : 3;
    else dirIdx = nz > 0 ? 4 : 5;

    const alignment = [anx, anx, any, any, anz, anz][dirIdx];
    if (alignment < 0.7) continue;

    const ax = positions.getX(i0), ay = positions.getY(i0), az = positions.getZ(i0);
    const bx = positions.getX(i1), by = positions.getY(i1), bz = positions.getZ(i1);
    const cx = positions.getX(i2), cy = positions.getY(i2), cz = positions.getZ(i2);
    const ex = bx - ax, ey = by - ay, ez = bz - az;
    const fx = cx - ax, fy = cy - ay, fz = cz - az;
    const cpx = ey * fz - ez * fy, cpy = ez * fx - ex * fz, cpz = ex * fy - ey * fx;
    const area = 0.5 * Math.sqrt(cpx * cpx + cpy * cpy + cpz * cpz);
    areaByDir[dirIdx] += area;
  }

  let maxArea = 0;
  for (let d = 0; d < 6; d++) if (areaByDir[d] > maxArea) maxArea = areaByDir[d];
  if (maxArea > 0) {
    for (let d = 0; d < 6; d++) {
      scores[d] += (areaByDir[d] / maxArea) * 2.0;
    }
  }

  // ── 3. Thin-axis tiebreak ──
  const sortedAxes = [0, 1, 2].sort((a, b) => extents[a] - extents[b]);
  const thinAxis = sortedAxes[0];
  const thinRatio = extents[thinAxis] / maxExtent;
  if (thinRatio < 0.5) {
    const boost = (1.0 - thinRatio) * 1.5;
    scores[thinAxis * 2] += boost;
    scores[thinAxis * 2 + 1] += boost;
  }

  // ── Pick the winner ──
  let bestDir = 5; // default -Z
  let bestScore = -1;
  for (let d = 0; d < 6; d++) {
    if (scores[d] > bestScore) {
      bestScore = scores[d];
      bestDir = d;
    }
  }

  const dirVectors = [
    [1, 0, 0], [-1, 0, 0],
    [0, 1, 0], [0, -1, 0],
    [0, 0, 1], [0, 0, -1],
  ];
  return dirVectors[bestDir];
}

/**
 * Apply rotation to a BufferGeometry so that vector `from` aligns with `to`.
 * Uses Rodrigues' rotation formula.
 */
function mbOrientGeometry(geometry, from, to) {
  const cx = from[1] * to[2] - from[2] * to[1];
  const cy = from[2] * to[0] - from[0] * to[2];
  const cz = from[0] * to[1] - from[1] * to[0];
  const sinA = Math.sqrt(cx * cx + cy * cy + cz * cz);
  const cosA = from[0] * to[0] + from[1] * to[1] + from[2] * to[2];

  if (sinA < 1e-8) {
    if (cosA > 0) return; // already aligned
    // Opposite — rotate 180° around a perpendicular axis
    let ax = 1, ay = 0, az = 0;
    if (Math.abs(from[0]) > 0.9) { ax = 0; ay = 1; }
    const px = from[1] * az - from[2] * ay;
    const py = from[2] * ax - from[0] * az;
    const pz = from[0] * ay - from[1] * ax;
    const pl = Math.sqrt(px * px + py * py + pz * pz);
    const m = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(px / pl, py / pl, pz / pl), Math.PI);
    geometry.applyMatrix4(m);
    return;
  }

  const axis = new THREE.Vector3(cx / sinA, cy / sinA, cz / sinA);
  const angle = Math.atan2(sinA, cosA);
  const m = new THREE.Matrix4().makeRotationAxis(axis, angle);
  geometry.applyMatrix4(m);
}

/**
 * Fetch and parse an STL file, returning a THREE.BufferGeometry.
 * If savedMountNormal is provided (from DB), use it directly; otherwise auto-detect.
 * Results are cached so each STL is only fetched once per orientation.
 */
async function mbFetchStlGeometry(stlCatalogId, savedMountNormal) {
  // Cache key includes saved normal so a manual override gets its own cache entry
  const cacheKey = savedMountNormal ? `${stlCatalogId}_${savedMountNormal.join(',')}` : stlCatalogId;
  if (_mbStlGeoCache[cacheKey]) return _mbStlGeoCache[cacheKey].clone();
  try {
    const base64 = await printStation.slicer.fetchStlBytes(stlCatalogId);
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const loader = new THREE.STLLoader();
    const geometry = loader.parse(bytes.buffer);
    geometry.computeVertexNormals();

    // Use saved orientation if available, otherwise auto-detect
    const mountNormal = savedMountNormal || mbFindMountNormal(geometry);
    mbOrientGeometry(geometry, mountNormal, [0, 0, -1]);
    geometry.computeVertexNormals();

    _mbStlGeoCache[cacheKey] = geometry;
    return geometry.clone();
  } catch (err) {
    console.warn('[Multiboard] STL load failed for id', stlCatalogId, err.message);
    return null;
  }
}

/**
 * After a component is placed with a procedural mesh, asynchronously load
 * the real STL and swap it in. The STL is auto-oriented so the snap/mount
 * surface faces the wall, then scaled to fit the part's grid area.
 */
function mbLoadRealStlForComponent(comp) {
  const part = mbFindPart(comp.partId);
  if (!part || !part._stlCatalogId) return;

  mbFetchStlGeometry(part._stlCatalogId, part._mountNormal).then(geometry => {
    if (!geometry) return;
    // Verify the component still exists (might have been deleted)
    if (!mbState.tiles.find(t => t.id === comp.id)) return;

    // After orientation, compute bounds (STL files are in mm)
    geometry.computeBoundingBox();
    const bb = geometry.boundingBox;
    const stlW = bb.max.x - bb.min.x;  // mm
    const stlH = bb.max.y - bb.min.y;  // mm

    // Compute real MU dimensions from STL (1 MU = 25mm = 1 grid unit)
    const realMuW = Math.max(1, Math.round(stlW / 25));
    const realMuH = Math.max(1, Math.round(stlH / 25));

    // Update part grid dimensions if STL reveals a different size
    if (realMuW !== part.gridWidth || realMuH !== part.gridHeight) {
      console.log(`[Multiboard] Correcting "${part.name}" from ${part.gridWidth}x${part.gridHeight} to ${realMuW}x${realMuH} MU`);
      part.gridWidth = realMuW;
      part.gridHeight = realMuH;
    }

    // Scale STL to fit computed MU grid area exactly (no padding)
    const scale = Math.min(realMuW / stlW, realMuH / stlH);

    geometry.scale(scale, scale, scale);
    geometry.computeBoundingBox();
    const bb2 = geometry.boundingBox;

    // Center X/Y, sit on wall surface (Z=0 is the wall)
    const cx = (bb2.max.x + bb2.min.x) / 2;
    const cy = (bb2.max.y + bb2.min.y) / 2;
    const cz = bb2.min.z;  // align back face to Z=0
    geometry.translate(-cx, -cy, -cz);

    const material = new THREE.MeshPhongMaterial({
      color: comp.color,
      specular: 0x222222,
      shininess: 40
    });

    const stlMesh = new THREE.Mesh(geometry, material);
    stlMesh.userData.tileId = comp.id;
    stlMesh.userData.isTile = true;
    stlMesh.userData._materials = [material];
    stlMesh.userData._isStl = true;

    // Position at correct center using real dimensions
    const isAccessory = part.attachesTo !== 'wall';
    stlMesh.position.set(
      comp.gridX + realMuW / 2,
      comp.gridY + realMuH / 2,
      isAccessory ? 0.2 : 0
    );

    // Swap out the old mesh
    mbDisposeObject(comp.mesh);
    mbState.scene.remove(comp.mesh);
    mbState.scene.add(stlMesh);
    comp.mesh = stlMesh;

    // Re-apply selection highlight if this component is selected
    if (mbState.selectedTile && mbState.selectedTile.id === comp.id) {
      mbSetMeshEmissive(comp.mesh, 0x113355);
    }
  });
}

// =============== GEOMETRY FACTORY ===============

function mbCreatePartMesh(part, color) {
  const hexColor = color || parseInt((part.colors[0] || '#333333').replace('#', '0x'));
  const geoType = part.geometry?.type;

  let mesh;

  if (geoType === 'hook') {
    // Hook: vertical plate on wall + protruding arm
    const group = new THREE.Group();
    const plateH = part.gridHeight;
    const armLen = part.geometry.length || 1.5;

    // Back plate (flat against tile)
    const plateGeo = new THREE.BoxGeometry(0.8, plateH, 0.15);
    const plateMat = new THREE.MeshPhongMaterial({ color: hexColor, specular: 0x222222, shininess: 30 });
    const plate = new THREE.Mesh(plateGeo, plateMat);
    plate.position.set(0, 0, 0.075);
    group.add(plate);

    // Arm extending outward (+Z)
    const armGeo = new THREE.BoxGeometry(0.4, 0.4, armLen);
    const arm = new THREE.Mesh(armGeo, plateMat.clone());
    arm.position.set(0, -plateH / 2 + 0.2, armLen / 2 + 0.15);
    group.add(arm);

    // Tip (slight upturn)
    const tipGeo = new THREE.BoxGeometry(0.4, 0.6, 0.3);
    const tip = new THREE.Mesh(tipGeo, plateMat.clone());
    tip.position.set(0, -plateH / 2 + 0.4, armLen + 0.15);
    group.add(tip);

    mesh = group;
    mesh.userData._materials = [plateMat];

  } else if (geoType === 'bin') {
    // Bin: open-top box
    const group = new THREE.Group();
    const bw = part.gridWidth;
    const bh = part.gridHeight;
    const depth = part.geometry.depth || 1.5;
    const wallT = part.geometry.wallThickness || 0.08;

    const binMat = new THREE.MeshPhongMaterial({ color: hexColor, specular: 0x222222, shininess: 30 });

    // Back wall
    const back = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, wallT), binMat);
    back.position.set(0, 0, wallT / 2);
    group.add(back);

    // Bottom
    const bottom = new THREE.Mesh(new THREE.BoxGeometry(bw, wallT, depth), binMat.clone());
    bottom.position.set(0, -bh / 2 + wallT / 2, depth / 2);
    group.add(bottom);

    // Left wall
    const left = new THREE.Mesh(new THREE.BoxGeometry(wallT, bh, depth), binMat.clone());
    left.position.set(-bw / 2 + wallT / 2, 0, depth / 2);
    group.add(left);

    // Right wall
    const right = new THREE.Mesh(new THREE.BoxGeometry(wallT, bh, depth), binMat.clone());
    right.position.set(bw / 2 - wallT / 2, 0, depth / 2);
    group.add(right);

    // Front wall (shorter - like a scoop)
    const frontH = bh * 0.5;
    const front = new THREE.Mesh(new THREE.BoxGeometry(bw, frontH, wallT), binMat.clone());
    front.position.set(0, -bh / 2 + frontH / 2, depth - wallT / 2);
    group.add(front);

    mesh = group;
    mesh.userData._materials = [binMat];

  } else if (geoType === 'shelf') {
    // Shelf: flat surface extending from wall
    const group = new THREE.Group();
    const sw = part.gridWidth;
    const depth = part.geometry.depth || 3.0;
    const shelfMat = new THREE.MeshPhongMaterial({ color: hexColor, specular: 0x222222, shininess: 30 });

    // Shelf surface
    const surface = new THREE.Mesh(new THREE.BoxGeometry(sw, 0.15, depth), shelfMat);
    surface.position.set(0, 0, depth / 2);
    group.add(surface);

    // Two bracket supports (triangular-ish using boxes)
    const bracketMat = new THREE.MeshPhongMaterial({ color: 0x555555, specular: 0x111111, shininess: 20 });
    const bracketPositions = [-sw / 2 + 0.5, sw / 2 - 0.5];
    bracketPositions.forEach(bx => {
      // Vertical strut
      const vert = new THREE.Mesh(new THREE.BoxGeometry(0.15, 1.2, 0.15), bracketMat.clone());
      vert.position.set(bx, -0.6, 0.15);
      group.add(vert);
      // Diagonal brace
      const diag = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, depth * 0.7), bracketMat.clone());
      diag.position.set(bx, -0.3, depth * 0.35);
      diag.rotation.x = Math.PI * 0.15;
      group.add(diag);
    });

    mesh = group;
    mesh.userData._materials = [shelfMat];

  } else {
    // Default: tile (flat box with procedural multiboard texture)
    const geometry = new THREE.BoxGeometry(part.gridWidth, part.gridHeight, part.thickness || 0.2);
    const material = mbCreateTileMaterial(part, hexColor);
    mesh = new THREE.Mesh(geometry, material);
    mesh.userData._materials = [material];
  }

  return mesh;
}

// =============== WALL DIMENSIONS ===============

function mbApplyWallDimensions() {
  const wInput = document.getElementById('mbWallWidth');
  const hInput = document.getElementById('mbWallHeight');
  const w = parseInt(wInput.value) || 48;
  const h = parseInt(hInput.value) || 36;

  mbState.wallWidth = Math.max(12, Math.min(120, w));
  mbState.wallHeight = Math.max(12, Math.min(96, h));
  wInput.value = mbState.wallWidth;
  hInput.value = mbState.wallHeight;

  // Remove out-of-bounds tiles (accessories attached to them will be removed too)
  const toRemove = mbState.tiles.filter(t => {
    const part = mbFindPart(t.partId);
    if (!part) return true;
    if (part.attachesTo !== 'wall') return false; // accessories checked via parent
    const halfW = mbState.wallWidth / 2;
    const halfH = mbState.wallHeight / 2;
    return (t.gridX + part.gridWidth > halfW + 0.01) ||
           (t.gridX < -halfW - 0.01) ||
           (t.gridY + part.gridHeight > halfH + 0.01) ||
           (t.gridY < -halfH - 0.01);
  });
  toRemove.forEach(t => mbRemoveComponent(t.id));

  mbBuildWall();
  mbBuildGrid();
  mbResetCamera();
  mbUpdateBom();
}

function mbResetCamera() {
  if (!mbState.camera || !mbState.controls) return;
  const maxDim = Math.max(mbState.wallWidth, mbState.wallHeight);
  mbState.camera.position.set(0, 0, maxDim * 1.8);
  mbState.camera.lookAt(0, 0, 0);
  mbState.controls.target.set(0, 0, 0);
  mbState.controls.update();
}

// =============== PLACEMENT ===============

function mbStartPlacing(part) {
  console.log('[Multiboard] Start placing:', part.name, '| attachesTo:', part.attachesTo);
  mbState.isPlacing = true;
  mbState.placingPart = part;
  mbDeselectTile();

  // Highlight active part card
  document.querySelectorAll('.mb-part-card').forEach(c => {
    c.style.borderColor = c.dataset.partId === part.id ? '#2196f3' : 'transparent';
  });

  // Show hint
  const hint = document.getElementById('mbPlacementHint');
  if (hint) {
    hint.style.display = 'block';
    hint.textContent = part.attachesTo === 'wall'
      ? 'Click on the wall to place tile. Press Escape to cancel.'
      : 'Click on a tile to place accessory. Press Escape to cancel.';
  }

  // Create preview mesh
  if (mbState.previewMesh) {
    mbDisposeObject(mbState.previewMesh);
    mbState.scene.remove(mbState.previewMesh);
  }

  mbState.previewMesh = mbCreatePartMesh(part, MB_COLORS.tileHover);
  mbSetMeshOpacity(mbState.previewMesh, 0.6);
  mbState.previewMesh.visible = false;
  mbState.scene.add(mbState.previewMesh);
}

function mbCancelPlacing() {
  // If we were moving a tile and cancelled, restore it to original position
  if (mbState._movingComp) {
    const mc = mbState._movingComp;
    const part = mbFindPart(mc.partId);
    if (part) {
      const restored = mbPlaceComponent(mc.gridX, mc.gridY, part, mc.color, mc.attachedToId);
      // Restore attached accessories too
      if (mc._attachedAccessories) {
        mc._attachedAccessories.forEach(a => {
          const aPart = mbFindPart(a.partId);
          if (aPart) mbPlaceComponent(a.gridX, a.gridY, aPart, a.color, restored.id);
        });
      }
    }
    mbState._movingComp = null;
  }

  mbState.isPlacing = false;
  mbState.placingPart = null;

  if (mbState.previewMesh) {
    mbDisposeObject(mbState.previewMesh);
    mbState.scene.remove(mbState.previewMesh);
    mbState.previewMesh = null;
  }

  mbClearSnapMarkers();

  const hint = document.getElementById('mbPlacementHint');
  if (hint) hint.style.display = 'none';

  document.querySelectorAll('.mb-part-card').forEach(c => c.style.borderColor = 'transparent');
}

/**
 * Start moving a placed component — picks it up and enters placement mode.
 * Escape restores it to the original position.
 */
function mbStartMoving(comp) {
  const part = mbFindPart(comp.partId);
  if (!part) return;

  // Save original state so we can restore on cancel
  const attachedAccessories = mbState.tiles
    .filter(t => t.attachedToId === comp.id)
    .map(a => ({ partId: a.partId, gridX: a.gridX, gridY: a.gridY, color: a.color }));

  mbState._movingComp = {
    partId: comp.partId,
    gridX: comp.gridX,
    gridY: comp.gridY,
    color: comp.color,
    attachedToId: comp.attachedToId,
    _attachedAccessories: attachedAccessories,
  };

  // Remove the component (and its accessories) from the scene
  mbRemoveComponent(comp.id);

  // Enter placement mode with the same part
  mbStartPlacing(part);

  // Update hint text
  const hint = document.getElementById('mbPlacementHint');
  if (hint) {
    hint.textContent = 'Click to place at new position. Press Escape to cancel move.';
    hint.style.display = '';
  }
}

function mbSnapToGrid(x, y) {
  return { x: Math.round(x), y: Math.round(y) };
}

function mbIsInBounds(gridX, gridY, part) {
  const halfW = mbState.wallWidth / 2;
  const halfH = mbState.wallHeight / 2;
  return gridX >= -halfW && gridY >= -halfH &&
         gridX + part.gridWidth <= halfW &&
         gridY + part.gridHeight <= halfH;
}

// Check overlap against placed components (tiles or accessories)
function mbCheckOverlap(gridX, gridY, part, excludeId) {
  const ax1 = gridX, ay1 = gridY;
  const ax2 = gridX + part.gridWidth, ay2 = gridY + part.gridHeight;
  const isAccessory = part.attachesTo !== 'wall';

  return mbState.tiles.some(t => {
    if (t.id === excludeId) return false;
    const tp = mbFindPart(t.partId);
    if (!tp) return false;
    // Only check overlap against same layer (tiles vs tiles, accessories vs accessories)
    const tIsAccessory = tp.attachesTo !== 'wall';
    if (isAccessory !== tIsAccessory) return false;

    const bx1 = t.gridX, by1 = t.gridY;
    const bx2 = t.gridX + tp.gridWidth, by2 = t.gridY + tp.gridHeight;
    return ax1 < bx2 && ax2 > bx1 && ay1 < by2 && ay2 > by1;
  });
}

// Find which tile (wall-attached) covers a single grid point
function mbFindTileAt(gridX, gridY, snapType) {
  return mbState.tiles.find(t => {
    const tp = mbFindPart(t.partId);
    if (!tp || tp.attachesTo !== 'wall') return false;
    if (snapType && (!tp.providesSnaps || !tp.providesSnaps.includes(snapType))) return false;
    return gridX >= t.gridX && gridX < t.gridX + tp.gridWidth &&
           gridY >= t.gridY && gridY < t.gridY + tp.gridHeight;
  });
}

/**
 * Check if every grid cell the accessory covers sits on a compatible tile.
 * The accessory can span multiple tiles. Returns the tile under the
 * top-left corner (for attachedToId), or null if any cell is uncovered.
 */
function mbAccessoryCoversValidTiles(gridX, gridY, part) {
  const snapType = part.snapType;
  for (let x = gridX; x < gridX + part.gridWidth; x++) {
    for (let y = gridY; y < gridY + part.gridHeight; y++) {
      if (!mbFindTileAt(x, y, snapType)) return null;
    }
  }
  return mbFindTileAt(gridX, gridY, snapType);
}

function mbPlaceComponent(gridX, gridY, part, color, attachedToId, options) {
  options = options || {};
  const hexColor = color || parseInt((part.colors[0] || '#333333').replace('#', '0x'));
  const mesh = mbCreatePartMesh(part, hexColor);

  // Position depends on part type
  const isAccessory = part.attachesTo !== 'wall';
  const thickness = part.thickness || 0.2;

  if (mesh.isGroup) {
    // Groups are positioned at center of the part's grid area
    mesh.position.set(
      gridX + part.gridWidth / 2,
      gridY + part.gridHeight / 2,
      isAccessory ? 0.2 : 0  // accessories sit on tile surface
    );
  } else {
    mesh.position.set(
      gridX + part.gridWidth / 2,
      gridY + part.gridHeight / 2,
      isAccessory ? 0.2 + thickness / 2 : thickness / 2
    );
  }

  mesh.userData.tileId = mbState.nextTileId;
  mesh.userData.isTile = true;
  mbState.scene.add(mesh);

  const comp = {
    id: mbState.nextTileId++,
    partId: part.id,
    gridX,
    gridY,
    mesh,
    color: hexColor,
    attachedToId: attachedToId || null,
    mountMethodId: options.mountMethodId || null,
    _resolvedHardware: options.resolvedHardware || null
  };
  mbState.tiles.push(comp);
  mbUpdateBom();

  // Async: load real STL model and swap in once ready
  if (part._stlCatalogId) {
    mbLoadRealStlForComponent(comp);
  }

  return comp;
}

function mbRemoveComponent(compId) {
  // First remove any accessories attached to this component
  const attachedAccessories = mbState.tiles.filter(t => t.attachedToId === compId);
  attachedAccessories.forEach(a => mbRemoveComponent(a.id));

  const idx = mbState.tiles.findIndex(t => t.id === compId);
  if (idx === -1) return;
  const comp = mbState.tiles[idx];

  mbDisposeObject(comp.mesh);
  mbState.scene.remove(comp.mesh);
  mbState.tiles.splice(idx, 1);

  if (mbState.selectedTile && mbState.selectedTile.id === compId) {
    mbState.selectedTile = null;
    mbUpdateSelectionPanel();
  }
  mbUpdateBom();
}

// =============== SNAP POINT VISUALIZATION ===============

function mbShowSnapPoints(tile, snapType) {
  mbClearSnapMarkers();
  const tp = mbFindPart(tile.partId);
  if (!tp) return;

  // Show dots at each grid intersection within the tile
  const dotGeo = new THREE.SphereGeometry(0.15, 8, 8);
  const dotMat = new THREE.MeshBasicMaterial({ color: MB_COLORS.snapPoint, transparent: true, opacity: 0.7 });

  for (let x = tile.gridX; x < tile.gridX + tp.gridWidth; x++) {
    for (let y = tile.gridY; y < tile.gridY + tp.gridHeight; y++) {
      const dot = new THREE.Mesh(dotGeo, dotMat);
      dot.position.set(x + 0.5, y + 0.5, 0.25);
      mbState.scene.add(dot);
      mbState.snapPointMarkers.push(dot);
    }
  }
}

function mbClearSnapMarkers() {
  mbState.snapPointMarkers.forEach(m => {
    mbState.scene.remove(m);
    m.geometry.dispose();
    m.material.dispose();
  });
  mbState.snapPointMarkers = [];
  mbState.hoveredTileId = null;
}

// =============== SELECTION ===============

function mbSelectTile(comp) {
  mbDeselectTile();
  mbState.selectedTile = comp;
  mbSetMeshEmissive(comp.mesh, 0x113355);
  mbUpdateSelectionPanel();
}

function mbDeselectTile() {
  if (mbState.selectedTile) {
    mbSetMeshEmissive(mbState.selectedTile.mesh, 0x000000);
    mbState.selectedTile = null;
  }
  mbUpdateSelectionPanel();
}

function mbUpdateSelectionPanel() {
  const panel = document.getElementById('mbSelectionInfo');
  if (!panel) return;

  if (!mbState.selectedTile) {
    panel.innerHTML = '<p class="muted" style="font-size:13px;">Click a placed part to select it.</p>';
    return;
  }

  const comp = mbState.selectedTile;
  const part = mbFindPart(comp.partId);
  if (!part) return;

  const isAccessory = part.attachesTo !== 'wall';
  const attachedCount = mbState.tiles.filter(t => t.attachedToId === comp.id).length;

  panel.innerHTML = `
    <div style="padding:8px;border:1px solid var(--border);border-radius:6px;margin-bottom:8px;">
      <div style="font-weight:600;font-size:14px;margin-bottom:4px;">${part.name}</div>
      <div style="font-size:12px;color:#888;">
        ${part.gridWidth > 0 ? `${part.gridWidth}" x ${part.gridHeight}"` : ''}<br>
        ${isAccessory ? 'Accessory' : 'Tile'} at (${comp.gridX}, ${comp.gridY})<br>
        Price: $${part.priceUSD.toFixed(2)}
        ${attachedCount > 0 ? `<br><span style="color:#f0ad4e;">${attachedCount} accessori${attachedCount === 1 ? 'y' : 'es'} attached</span>` : ''}
        ${part._mountType ? `<br>Mount: <span style="color:#64b5f6;">${part._mountType}</span>` : ''}
      </div>
    </div>
    ${part._mountHardware && part._mountHardware.length ? `
    <div style="padding:6px 8px;border:1px solid #555;border-radius:6px;margin-bottom:8px;background:rgba(255,152,0,0.08);">
      <div style="font-size:11px;font-weight:600;color:#ffb74d;margin-bottom:2px;">Hardware Required:</div>
      ${part._mountHardware.map(hw => {
        if (hw.type === 'magnet') return `<div style="font-size:11px;color:#ccc;">${hw.qty ? hw.qty + 'x ' : ''}${hw.size || ''} magnet${hw.qty !== 1 ? 's' : ''}</div>`;
        if (hw.type === 'screw') return `<div style="font-size:11px;color:#ccc;">${hw.qty ? hw.qty + 'x ' : ''}${hw.spec || ''} screw${hw.qty !== 1 ? 's' : ''}</div>`;
        if (hw.type === 'insert') return `<div style="font-size:11px;color:#ccc;">${hw.spec || ''} heat-set insert</div>`;
        return `<div style="font-size:11px;color:#ccc;">${hw.type}: ${hw.spec || hw.size || ''}</div>`;
      }).join('')}
    </div>` : ''}
    ${part._requiresTray ? `
    <div style="padding:6px 8px;border:1px solid #555;border-radius:6px;margin-bottom:8px;background:rgba(156,39,176,0.08);">
      <div style="font-size:11px;font-weight:600;color:#ce93d8;margin-bottom:2px;">Requires Base Structure:</div>
      <div style="font-size:11px;color:#ccc;">
        This part needs a <b>Drawer Shell</b> or <b>Bolt-Locked Bracket</b> to mount.
        ${part._traySize ? `<br>Tray size: ${part._traySize}` : ''}
      </div>
    </div>` : ''}
    ${(() => {
      const hw = comp._resolvedHardware || part.requiresHardware || [];
      if (!hw.length) return '';
      const methodName = comp.mountMethodId && part._mountMethods
        ? (part._mountMethods.find(m => m.id === comp.mountMethodId) || {}).name || comp.mountMethodId
        : null;
      return `
      <div style="padding:6px 8px;border:1px solid #555;border-radius:6px;margin-bottom:8px;background:rgba(33,150,243,0.08);">
        <div style="font-size:11px;font-weight:600;color:#64b5f6;margin-bottom:2px;">
          Mounting Dependencies${methodName ? ` <span style="color:#90caf9;font-weight:400;">(${methodName})</span>` : ''}
        </div>
        ${hw.map(h => `<div style="font-size:11px;color:#ccc;">${h.qty}x ${h.partId.replace(/-/g, ' ')}</div>`).join('')}
        ${part._hasMethodChoice ? '<button id="mbChangeMethodBtn" class="secondary" style="width:100%;padding:3px 6px;font-size:10px;margin-top:4px;color:#90caf9;">Change Method</button>' : ''}
      </div>`;
    })()}
    <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px;">
      ${part.colors.map(c => `
        <div class="mb-color-swatch" data-color="${c}" style="width:24px;height:24px;border-radius:50%;background:${c};cursor:pointer;border:2px solid ${comp.color === parseInt(c.replace('#', '0x')) ? '#2196f3' : '#444'};" title="${c}"></div>
      `).join('')}
    </div>
    ${part._stlCatalogId ? `
    <div style="margin-bottom:8px;">
      <div style="font-size:11px;color:#888;margin-bottom:4px;">Rotate STL orientation:</div>
      <div style="display:flex;gap:4px;">
        <button class="secondary mb-rotate-btn" data-axis="x" style="flex:1;padding:4px 6px;font-size:11px;" title="Rotate 90° around X axis">X 90°</button>
        <button class="secondary mb-rotate-btn" data-axis="y" style="flex:1;padding:4px 6px;font-size:11px;" title="Rotate 90° around Y axis">Y 90°</button>
        <button class="secondary mb-rotate-btn" data-axis="z" style="flex:1;padding:4px 6px;font-size:11px;" title="Rotate 90° around Z axis">Z 90°</button>
      </div>
      <button id="mbSaveOrientBtn" class="secondary" style="width:100%;padding:4px 6px;font-size:11px;margin-top:4px;color:#4caf50;" title="Save this orientation for all future placements of this part">Save Orientation</button>
    </div>` : ''}
    <div style="display:flex;gap:6px;margin-bottom:${part._stlCatalogId ? '6px' : '0'};">
      <button id="mbMoveTileBtn" class="secondary" style="flex:1;padding:6px;">
        Move
      </button>
      <button id="mbDeleteTileBtn" class="secondary" style="flex:1;padding:6px;color:var(--danger);">
        Delete${attachedCount > 0 ? ` (+${attachedCount})` : ''}
      </button>
    </div>
    ${part._stlCatalogId ? `
    <button id="mbUpdateInfoBtn" class="secondary" style="width:100%;padding:6px;font-size:12px;color:#64b5f6;" title="Open Thangs page to scrape description and hardware info">
      Update Part Info
    </button>` : ''}
  `;

  // Color swatches
  panel.querySelectorAll('.mb-color-swatch').forEach(swatch => {
    swatch.addEventListener('click', () => {
      if (!mbState.selectedTile) return;
      const hex = parseInt(swatch.dataset.color.replace('#', '0x'));
      mbState.selectedTile.color = hex;
      mbSetMeshColor(mbState.selectedTile.mesh, hex);
      mbUpdateSelectionPanel();
    });
  });

  // Rotation buttons — rotate the STL mesh 90° around the clicked axis
  panel.querySelectorAll('.mb-rotate-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!mbState.selectedTile) return;
      const mesh = mbState.selectedTile.mesh;
      if (!mesh || !mesh.userData._isStl) {
        mbShowToast('STL not loaded yet — wait a moment', 'info');
        return;
      }
      const axis = btn.dataset.axis;
      const angle = Math.PI / 2;
      const rotAxis = axis === 'x' ? new THREE.Vector3(1, 0, 0)
                    : axis === 'y' ? new THREE.Vector3(0, 1, 0)
                    : new THREE.Vector3(0, 0, 1);
      mesh.geometry.applyMatrix4(new THREE.Matrix4().makeRotationAxis(rotAxis, angle));
      mesh.geometry.computeVertexNormals();
      mesh.geometry.computeBoundingBox();

      // Re-center after rotation
      const bb = mesh.geometry.boundingBox;
      const cx = (bb.max.x + bb.min.x) / 2;
      const cy = (bb.max.y + bb.min.y) / 2;
      const cz = bb.min.z;
      mesh.geometry.translate(-cx, -cy, -cz);

      mbState.renderer?.render(mbState.scene, mbState.camera);
    });
  });

  // Save Orientation — persist the current rotation for all future placements
  document.getElementById('mbSaveOrientBtn')?.addEventListener('click', async () => {
    if (!mbState.selectedTile) return;
    const p = mbFindPart(mbState.selectedTile.partId);
    if (!p || !p._stlCatalogId) return;

    // We need to figure out what mount_normal produces the current orientation.
    // The geometry has been rotated so mount→-Z, then possibly manually rotated.
    // Re-compute: take the auto-detected normal, apply the same manual rotations.
    // Simpler approach: just re-load the raw STL, find what direction in the
    // original STL now maps to -Z in the current geometry.
    //
    // Practical shortcut: record the effective mount-normal by reading the
    // geometry's current state. After all rotations, the -Z direction in the
    // current geometry came from some direction in the original. We track
    // cumulative rotations on the mesh's userData.
    //
    // Simplest: just clear the old cache, re-detect from the raw STL,
    // and store as a 6-direction enum that we reverse-map.
    //
    // ACTUALLY: The most reliable approach is to reload the raw STL, try all 6
    // orientations, and see which one best matches the current geometry. But
    // that's expensive. Let's just save the current rotation as a matrix and
    // re-apply it on future loads.

    // Save the geometry's bounding box orientation signature
    const mesh = mbState.selectedTile.mesh;
    if (!mesh.userData._isStl) {
      mbShowToast('STL not loaded yet', 'info');
      return;
    }

    // Fetch the raw (unrotated) STL to determine what mount_normal to save
    try {
      const base64 = await printStation.slicer.fetchStlBytes(p._stlCatalogId);
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const loader = new THREE.STLLoader();
      const rawGeo = loader.parse(bytes.buffer);
      rawGeo.computeVertexNormals();

      // Try all 6 cardinal mount normals and pick the one whose oriented
      // bounding box proportions best match the current mesh's proportions
      const currentBB = mesh.geometry.boundingBox;
      const curW = currentBB.max.x - currentBB.min.x;
      const curH = currentBB.max.y - currentBB.min.y;
      const curD = currentBB.max.z - currentBB.min.z;

      const candidates = [
        [1,0,0], [-1,0,0], [0,1,0], [0,-1,0], [0,0,1], [0,0,-1]
      ];
      let bestNormal = [0, 0, -1];
      let bestError = Infinity;

      for (const mn of candidates) {
        const testGeo = rawGeo.clone();
        mbOrientGeometry(testGeo, mn, [0, 0, -1]);
        testGeo.computeBoundingBox();
        const tb = testGeo.boundingBox;
        const tw = tb.max.x - tb.min.x;
        const th = tb.max.y - tb.min.y;
        const td = tb.max.z - tb.min.z;
        // Compare proportions (scale-independent)
        const err = Math.abs(tw/curW - 1) + Math.abs(th/curH - 1) + Math.abs(td/curD - 1);
        if (err < bestError) {
          bestError = err;
          bestNormal = mn;
        }
        testGeo.dispose();
      }
      rawGeo.dispose();

      // Save to DB
      await printStation.slicer.updateCatalogItem(p._stlCatalogId, {
        mount_normal: JSON.stringify(bestNormal)
      });

      // Update the part in memory
      p._mountNormal = bestNormal;

      // Clear the old cache entries for this STL so future loads use the new normal
      for (const key of Object.keys(_mbStlGeoCache)) {
        if (String(key).startsWith(String(p._stlCatalogId))) {
          _mbStlGeoCache[key].dispose();
          delete _mbStlGeoCache[key];
        }
      }

      mbShowToast('Orientation saved for ' + p.name, 'success');
    } catch (err) {
      console.error('[Multiboard] Save orientation failed:', err);
      mbShowToast('Failed to save orientation: ' + err.message, 'danger');
    }
  });

  // Move button
  document.getElementById('mbMoveTileBtn')?.addEventListener('click', () => {
    if (mbState.selectedTile) {
      mbStartMoving(mbState.selectedTile);
    }
  });

  // Delete button
  document.getElementById('mbDeleteTileBtn')?.addEventListener('click', () => {
    if (mbState.selectedTile) {
      mbRemoveComponent(mbState.selectedTile.id);
    }
  });

  // Update Part Info — open the scrape modal from slicer-view.js
  document.getElementById('mbUpdateInfoBtn')?.addEventListener('click', () => {
    if (!mbState.selectedTile) return;
    const p = mbFindPart(mbState.selectedTile.partId);
    if (!p || !p._stlCatalogId) return;

    // Build a minimal item object matching what slicerOpenUpdateInfoModal expects
    const item = { id: p._stlCatalogId, name: p.name, source_url: null };

    // slicerOpenUpdateInfoModal is defined in slicer-view.js (loaded globally)
    if (typeof slicerOpenUpdateInfoModal === 'function') {
      slicerOpenUpdateInfoModal(item);

      // After the modal closes and data is saved, refresh the part in our catalog
      // so the selection panel shows updated info. We poll for modal close.
      const checkClosed = setInterval(() => {
        const modal = document.getElementById('slicerUpdateInfoModal');
        if (!modal || modal.style.display === 'none') {
          clearInterval(checkClosed);
          // Reload catalog to pick up changes
          loadMultiboardCatalog().then(() => {
            if (mbState.selectedTile) mbUpdateSelectionPanel();
          });
        }
      }, 500);
    } else {
      mbShowToast('Update Info modal not available', 'info');
    }
  });

  // Change Method — re-open the method chooser for this component
  document.getElementById('mbChangeMethodBtn')?.addEventListener('click', () => {
    if (!mbState.selectedTile) return;
    const p = mbFindPart(mbState.selectedTile.partId);
    if (!p || !p._hasMethodChoice) return;
    mbShowMethodChooser(p).then(choice => {
      if (!choice) return;
      mbState.selectedTile.mountMethodId = choice.methodId;
      mbState.selectedTile._resolvedHardware = choice.hardware;
      mbUpdateBom();
      mbUpdateSelectionPanel();
    });
  });
}

// =============== MOUSE EVENTS ===============

function mbOnMouseMove(e) {
  if (!mbState.isPlacing || !mbState.previewMesh) return;

  const container = document.getElementById('mbCanvasContainer');
  const rect = container.getBoundingClientRect();
  mbState.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mbState.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

  const part = mbState.placingPart;
  const isAccessory = part.attachesTo !== 'wall';

  if (isAccessory) {
    mbOnMouseMoveAccessory(part);
  } else {
    mbOnMouseMoveTile(part);
  }
}

function mbOnMouseMoveTile(part) {
  mbState.raycaster.setFromCamera(mbState.mouse, mbState.camera);
  const intersectPt = new THREE.Vector3();
  const hit = mbState.raycaster.ray.intersectPlane(mbState.wallPlane, intersectPt);

  if (!hit) {
    mbState.previewMesh.visible = false;
    return;
  }

  const snapped = mbSnapToGrid(intersectPt.x - part.gridWidth / 2, intersectPt.y - part.gridHeight / 2);
  const gridX = snapped.x;
  const gridY = snapped.y;
  const inBounds = mbIsInBounds(gridX, gridY, part);
  const overlaps = mbCheckOverlap(gridX, gridY, part);
  const valid = inBounds && !overlaps;

  mbState.previewMesh.visible = true;
  const thickness = part.thickness || 0.2;

  if (mbState.previewMesh.isGroup) {
    mbState.previewMesh.position.set(gridX + part.gridWidth / 2, gridY + part.gridHeight / 2, 0);
  } else {
    mbState.previewMesh.position.set(gridX + part.gridWidth / 2, gridY + part.gridHeight / 2, thickness / 2);
  }
  mbSetMeshColor(mbState.previewMesh, valid ? MB_COLORS.tileHover : MB_COLORS.tileInvalid);
}

function mbOnMouseMoveAccessory(part) {
  mbState.raycaster.setFromCamera(mbState.mouse, mbState.camera);

  // Raycast to wall plane to get grid position, then check if a tile is there
  const intersectPt = new THREE.Vector3();
  const hit = mbState.raycaster.ray.intersectPlane(mbState.wallPlane, intersectPt);

  if (!hit) {
    mbState.previewMesh.visible = false;
    mbClearSnapMarkers();
    return;
  }

  const snapped = mbSnapToGrid(intersectPt.x - part.gridWidth / 2, intersectPt.y - part.gridHeight / 2);
  const gridX = snapped.x;
  const gridY = snapped.y;

  // Check if every cell the accessory covers is on a compatible tile
  const parentTile = mbAccessoryCoversValidTiles(gridX, gridY, part);
  const valid = parentTile && !mbCheckOverlap(gridX, gridY, part);

  // Show snap points on hovered tile
  if (parentTile && parentTile.id !== mbState.hoveredTileId) {
    mbClearSnapMarkers();
    mbShowSnapPoints(parentTile, part.snapType);
    mbState.hoveredTileId = parentTile.id;
  } else if (!parentTile) {
    mbClearSnapMarkers();
  }

  mbState.previewMesh.visible = true;
  const thickness = part.thickness || 0.2;

  if (mbState.previewMesh.isGroup) {
    mbState.previewMesh.position.set(gridX + part.gridWidth / 2, gridY + part.gridHeight / 2, 0.2);
  } else {
    mbState.previewMesh.position.set(gridX + part.gridWidth / 2, gridY + part.gridHeight / 2, 0.2 + thickness / 2);
  }
  mbSetMeshColor(mbState.previewMesh, valid ? MB_COLORS.tileHover : MB_COLORS.tileInvalid);
}

/**
 * Show mounting method chooser dialog for parts with multiple methods (e.g. trays).
 * Returns Promise<{ methodId, hardware }> or null if cancelled.
 */
function mbShowMethodChooser(part) {
  return new Promise(resolve => {
    const methods = part._mountMethods || [];
    if (!methods.length) return resolve(null);

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:2000;display:flex;align-items:center;justify-content:center;';

    const dialog = document.createElement('div');
    dialog.style.cssText = 'background:#1e1e1e;border:1px solid #555;border-radius:10px;padding:20px;max-width:420px;width:90%;color:#ddd;font-family:inherit;';

    let selectedIdx = 0;
    const render = () => {
      dialog.innerHTML = `
        <div style="font-size:16px;font-weight:600;margin-bottom:4px;">Choose Mounting Method</div>
        <div style="font-size:12px;color:#888;margin-bottom:14px;">${part.name}</div>
        ${methods.map((m, i) => `
          <label style="display:flex;align-items:flex-start;gap:10px;padding:10px;border:2px solid ${i === selectedIdx ? '#2196f3' : '#444'};border-radius:8px;margin-bottom:8px;cursor:pointer;background:${i === selectedIdx ? 'rgba(33,150,243,0.08)' : 'transparent'};">
            <input type="radio" name="mbMethod" value="${i}" ${i === selectedIdx ? 'checked' : ''} style="margin-top:3px;">
            <div>
              <div style="font-weight:600;font-size:13px;">${m.name}</div>
              <div style="font-size:11px;color:#aaa;margin-top:2px;">${m.description || ''}</div>
              <div style="font-size:10px;color:#888;margin-top:4px;">${m.hardware.map(h => `${h.qty}x ${h.partId.replace(/-/g, ' ')}`).join(', ')}</div>
            </div>
          </label>
        `).join('')}
        <div style="display:flex;gap:8px;margin-top:14px;justify-content:flex-end;">
          <button id="mbMethodCancel" class="secondary" style="padding:8px 16px;font-size:13px;">Cancel</button>
          <button id="mbMethodConfirm" style="padding:8px 16px;font-size:13px;background:#2196f3;color:#fff;border:none;border-radius:6px;cursor:pointer;">Place Part</button>
        </div>
      `;
      dialog.querySelectorAll('input[name="mbMethod"]').forEach(radio => {
        radio.addEventListener('change', () => {
          selectedIdx = parseInt(radio.value);
          render();
        });
      });
      dialog.querySelectorAll('label').forEach((lbl, i) => {
        lbl.addEventListener('click', () => {
          selectedIdx = i;
          render();
        });
      });
      dialog.querySelector('#mbMethodCancel').addEventListener('click', () => {
        overlay.remove();
        resolve(null);
      });
      dialog.querySelector('#mbMethodConfirm').addEventListener('click', () => {
        overlay.remove();
        const chosen = methods[selectedIdx];
        resolve({ methodId: chosen.id, hardware: chosen.hardware });
      });
    };

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) { overlay.remove(); resolve(null); }
    });
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    render();
  });
}

function mbOnClick(e) {
  const container = document.getElementById('mbCanvasContainer');
  const rect = container.getBoundingClientRect();
  mbState.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mbState.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

  if (mbState.isPlacing) {
    const part = mbState.placingPart;
    const isAccessory = part.attachesTo !== 'wall';

    mbState.raycaster.setFromCamera(mbState.mouse, mbState.camera);
    const intersectPt = new THREE.Vector3();
    const hit = mbState.raycaster.ray.intersectPlane(mbState.wallPlane, intersectPt);
    if (!hit) return;

    const snapped = mbSnapToGrid(intersectPt.x - part.gridWidth / 2, intersectPt.y - part.gridHeight / 2);
    const gridX = snapped.x;
    const gridY = snapped.y;

    // Preserve color if moving an existing component
    const moveColor = mbState._movingComp ? mbState._movingComp.color : null;

    // Validate position first
    if (isAccessory) {
      const parentTile = mbAccessoryCoversValidTiles(gridX, gridY, part);
      if (!parentTile) return;
      if (mbCheckOverlap(gridX, gridY, part)) return;

      // If part has method choice (e.g. trays), show chooser before placing
      if (part._hasMethodChoice && !mbState._movingComp) {
        mbShowMethodChooser(part).then(choice => {
          if (!choice) return; // user cancelled
          mbPlaceComponent(gridX, gridY, part, moveColor, parentTile.id, {
            mountMethodId: choice.methodId,
            resolvedHardware: choice.hardware
          });
          console.log('[Multiboard] Accessory placed (method:', choice.methodId, ') on tile', parentTile.id, 'Total:', mbState.tiles.length);
          mbState._movingComp = null;
        });
        return;
      }

      mbPlaceComponent(gridX, gridY, part, moveColor, parentTile.id);
      console.log('[Multiboard] Accessory placed on tile', parentTile.id, 'Total components:', mbState.tiles.length);
    } else {
      // Tile placement
      if (!mbIsInBounds(gridX, gridY, part)) return;
      if (mbCheckOverlap(gridX, gridY, part)) return;
      mbPlaceComponent(gridX, gridY, part, moveColor);
      console.log('[Multiboard] Tile placed! Total components:', mbState.tiles.length);
    }
    mbState._movingComp = null;  // Clear move state on successful placement
    return;
  }

  // Not placing - select a component
  mbState.raycaster.setFromCamera(mbState.mouse, mbState.camera);
  const allMeshes = [];
  mbState.tiles.forEach(t => {
    if (t.mesh.isGroup) {
      t.mesh.children.forEach(child => {
        child.userData.tileId = t.id;
        allMeshes.push(child);
      });
    } else {
      allMeshes.push(t.mesh);
    }
  });

  const intersects = mbState.raycaster.intersectObjects(allMeshes);
  if (intersects.length > 0) {
    const tileId = intersects[0].object.userData.tileId;
    const comp = mbState.tiles.find(t => t.id === tileId);
    if (comp) mbSelectTile(comp);
  } else {
    mbDeselectTile();
  }
}

// =============== BOM (BILL OF MATERIALS) + PRICING ===============

function mbCalculatePricing() {
  if (!mbState.catalog) return { partsTotal: 0, hardwareTotal: 0, weightGrams: 0, serviceFee: 0, grandTotal: 0, partCounts: {}, hardwareCounts: {} };

  const partCounts = {};
  mbState.tiles.forEach(t => {
    partCounts[t.partId] = (partCounts[t.partId] || 0) + 1;
  });

  const hardwareCounts = {};
  mbState.tiles.forEach(t => {
    const part = mbFindPart(t.partId);
    if (!part) return;
    // Use per-instance hardware (from method choice) or part default
    const hardware = t._resolvedHardware || part.requiresHardware || [];
    hardware.forEach(hw => {
      hardwareCounts[hw.partId] = (hardwareCounts[hw.partId] || 0) + hw.qty;
    });
  });

  let partsTotal = 0;
  let weightGrams = 0;
  Object.entries(partCounts).forEach(([partId, qty]) => {
    const part = mbFindPart(partId);
    if (!part) return;
    partsTotal += qty * part.priceUSD;
    weightGrams += qty * (part.weightGrams || 0);
  });

  let hardwareTotal = 0;
  Object.entries(hardwareCounts).forEach(([partId, qty]) => {
    const part = mbFindPart(partId);
    if (!part) return;
    hardwareTotal += qty * part.priceUSD;
    weightGrams += qty * (part.weightGrams || 0);
  });

  // Service fee calculation
  const rates = mbState.catalog.serviceRates || {};
  const level = mbState.serviceLevel;
  const wallSqFt = (mbState.wallWidth * mbState.wallHeight) / 144;
  let serviceFee = 0;

  if (level === 'designOnly' && rates.designOnly) {
    serviceFee = rates.designOnly.flat || 35;
  } else if (level === 'designBuild' && rates.designBuild) {
    serviceFee = Math.max(wallSqFt * (rates.designBuild.perSqFt || 10), rates.designBuild.minimum || 50);
  } else if (level === 'turnkey' && rates.turnkey) {
    serviceFee = Math.max(wallSqFt * (rates.turnkey.perSqFt || 17.5), rates.turnkey.minimum || 150);
  }

  const grandTotal = partsTotal + hardwareTotal + serviceFee;

  return { partsTotal, hardwareTotal, weightGrams, serviceFee, grandTotal, partCounts, hardwareCounts, wallSqFt };
}

function mbUpdateBom() {
  const body = document.getElementById('mbBomBody');
  if (!body || !mbState.catalog) return;

  const pricing = mbCalculatePricing();
  let rows = '';

  // Part rows (tiles + accessories)
  Object.entries(pricing.partCounts).forEach(([partId, qty]) => {
    const part = mbFindPart(partId);
    if (!part) return;
    const lineTotal = qty * part.priceUSD;
    rows += `<tr>
      <td style="padding:3px 6px;">${part.name}</td>
      <td style="padding:3px 6px;text-align:center;">${qty}</td>
      <td style="padding:3px 6px;text-align:right;">$${part.priceUSD.toFixed(2)}</td>
      <td style="padding:3px 6px;text-align:right;">$${lineTotal.toFixed(2)}</td>
    </tr>`;
  });

  // Hardware rows
  Object.entries(pricing.hardwareCounts).forEach(([partId, qty]) => {
    const part = mbFindPart(partId);
    if (!part) return;
    const lineTotal = qty * part.priceUSD;
    rows += `<tr style="color:#888;">
      <td style="padding:3px 6px;">&nbsp;&nbsp;${part.name}</td>
      <td style="padding:3px 6px;text-align:center;">${qty}</td>
      <td style="padding:3px 6px;text-align:right;">$${part.priceUSD.toFixed(2)}</td>
      <td style="padding:3px 6px;text-align:right;">$${lineTotal.toFixed(2)}</td>
    </tr>`;
  });

  body.innerHTML = rows || '<tr><td colspan="4" style="padding:8px;color:#888;text-align:center;">No parts placed yet</td></tr>';

  // Update pricing summary
  const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setEl('mbPartsTotal', `$${pricing.partsTotal.toFixed(2)}`);
  setEl('mbHardwareTotal', `$${pricing.hardwareTotal.toFixed(2)}`);
  setEl('mbWeightTotal', pricing.weightGrams >= 1000 ? `${(pricing.weightGrams / 1000).toFixed(1)}kg` : `${pricing.weightGrams}g`);
  setEl('mbServiceFee', `$${pricing.serviceFee.toFixed(2)}`);
  setEl('mbGrandTotal', `$${pricing.grandTotal.toFixed(2)}`);

  // Show/hide service fee row
  const feeRow = document.getElementById('mbServiceFeeRow');
  if (feeRow) feeRow.style.display = mbState.serviceLevel === 'none' ? 'none' : 'flex';
}

// =============== SAVE / LOAD ===============

async function mbSaveDesign() {
  const name = document.getElementById('mbProjectName')?.value || 'Untitled Design';
  const components = mbState.tiles.map(t => ({
    partId: t.partId,
    gridX: t.gridX,
    gridY: t.gridY,
    color: t.color,
    attachedToId: t.attachedToId || null,
    mountMethodId: t.mountMethodId || null,
    resolvedHardware: t._resolvedHardware || null
  }));

  const partsList = [];
  const counts = {};
  mbState.tiles.forEach(t => { counts[t.partId] = (counts[t.partId] || 0) + 1; });
  Object.entries(counts).forEach(([partId, qty]) => {
    const part = mbFindPart(partId);
    if (part) partsList.push({ partId, name: part.name, qty, unitPrice: part.priceUSD });
  });

  const grandTotal = partsList.reduce((s, p) => s + p.qty * p.unitPrice, 0);

  const pricing = mbCalculatePricing();

  const payload = {
    name,
    customerName: mbState.customerName || null,
    customerEmail: mbState.customerEmail || null,
    customerPhone: mbState.customerPhone || null,
    wallWidth: mbState.wallWidth,
    wallHeight: mbState.wallHeight,
    components,
    partsList,
    totalPriceCents: Math.round(pricing.grandTotal * 100),
    status: 'draft'
  };

  try {
    if (mbState.currentDesignId) {
      await mbApi.put(`/api/multiboard/designs/${mbState.currentDesignId}`, payload);
    } else {
      const result = await mbApi.post('/api/multiboard/designs', payload);
      mbState.currentDesignId = result.designId;
    }
    mbShowToast('Design saved!', 'success');
  } catch (err) {
    console.error('[Multiboard] Save error:', err);
    mbShowToast('Save failed: ' + err.message, 'danger');
  }
}

async function mbLoadDesign() {
  try {
    const { designs } = await mbApi.get('/api/multiboard/designs');
    if (!designs || designs.length === 0) {
      mbShowToast('No saved designs found', 'info');
      return;
    }

    const choice = await mbShowDesignPicker(designs);
    if (!choice) return;

    const { design } = await mbApi.get(`/api/multiboard/designs/${choice.design_id}`);

    mbClearAll();

    mbState.wallWidth = design.wall_width_inches || 48;
    mbState.wallHeight = design.wall_height_inches || 36;
    mbState.currentDesignId = design.design_id;
    mbState.customerName = design.customer_name || '';
    mbState.customerEmail = design.customer_email || '';
    mbState.customerPhone = design.customer_phone || '';

    document.getElementById('mbWallWidth').value = mbState.wallWidth;
    document.getElementById('mbWallHeight').value = mbState.wallHeight;
    document.getElementById('mbProjectName').value = design.name || '';
    mbUpdateStatusBadge(design.status || 'draft');

    mbBuildWall();
    mbBuildGrid();
    mbResetCamera();

    // Build ID mapping for attachedTo references
    const idMap = {};
    if (design.components && Array.isArray(design.components)) {
      // Place tiles first, then accessories
      const tiles = design.components.filter(c => {
        const p = mbFindPart(c.partId);
        return p && p.attachesTo === 'wall';
      });
      const accessories = design.components.filter(c => {
        const p = mbFindPart(c.partId);
        return p && p.attachesTo !== 'wall';
      });

      tiles.forEach((c, i) => {
        const part = mbFindPart(c.partId);
        if (part) {
          const placed = mbPlaceComponent(c.gridX, c.gridY, part, c.color, null, {
            mountMethodId: c.mountMethodId,
            resolvedHardware: c.resolvedHardware
          });
          // Store mapping from save index to new ID
          idMap[i] = placed.id;
        }
      });

      accessories.forEach(c => {
        const part = mbFindPart(c.partId);
        if (part) {
          // Find parent tile at this position
          const parentTile = mbFindTileAt(c.gridX, c.gridY, part.snapType);
          mbPlaceComponent(c.gridX, c.gridY, part, c.color, parentTile ? parentTile.id : null, {
            mountMethodId: c.mountMethodId,
            resolvedHardware: c.resolvedHardware
          });
        }
      });
    }

    mbUpdateBom();
    mbShowToast('Design loaded!', 'success');
  } catch (err) {
    console.error('[Multiboard] Load error:', err);
    mbShowToast('Load failed: ' + err.message, 'danger');
  }
}

function mbShowDesignPicker(designs) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:10000;display:flex;align-items:center;justify-content:center;';

    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-primary,#1e1e2e);border:1px solid var(--border,#333);border-radius:8px;padding:20px;max-width:400px;width:90%;max-height:400px;overflow-y:auto;';
    modal.innerHTML = `<h3 style="margin:0 0 12px;">Load Design</h3>`;

    designs.forEach(d => {
      const btn = document.createElement('button');
      btn.className = 'secondary';
      btn.style.cssText = 'display:block;width:100%;text-align:left;padding:10px;margin-bottom:6px;border-radius:4px;';
      btn.innerHTML = `<strong>${d.name}</strong><br><span style="font-size:12px;color:#888;">${d.wall_width_inches}x${d.wall_height_inches}" | ${d.status} | ${new Date(d.created_at).toLocaleDateString()}</span>`;
      btn.addEventListener('click', () => { document.body.removeChild(overlay); resolve(d); });
      modal.appendChild(btn);
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'secondary';
    cancelBtn.style.cssText = 'margin-top:8px;width:100%;padding:8px;';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => { document.body.removeChild(overlay); resolve(null); });
    modal.appendChild(cancelBtn);

    overlay.appendChild(modal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { document.body.removeChild(overlay); resolve(null); } });
    document.body.appendChild(overlay);
  });
}

function mbClearAll() {
  [...mbState.tiles].forEach(t => {
    mbDisposeObject(t.mesh);
    mbState.scene.remove(t.mesh);
  });
  mbState.tiles = [];
  mbState.nextTileId = 1;
  mbState.selectedTile = null;
  mbState.currentDesignId = null;
  mbState.designStatus = 'draft';
  mbClearSnapMarkers();
  mbUpdateSelectionPanel();
  mbUpdateBom();
  const badge = document.getElementById('mbStatusBadge');
  if (badge) badge.style.display = 'none';
}

// =============== MESH UTILITIES ===============

function mbDisposeMaterial(mat) {
  if (mat.map) mat.map.dispose();
  if (mat.bumpMap) mat.bumpMap.dispose();
  if (mat.normalMap) mat.normalMap.dispose();
  mat.dispose();
}

function mbDisposeObject(obj) {
  if (obj.isGroup) {
    obj.children.forEach(child => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) child.material.forEach(m => mbDisposeMaterial(m));
        else mbDisposeMaterial(child.material);
      }
    });
  } else {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) obj.material.forEach(m => mbDisposeMaterial(m));
      else mbDisposeMaterial(obj.material);
    }
  }
}

function mbSetMeshColor(obj, color) {
  if (obj.isGroup) {
    obj.children.forEach(child => {
      if (child.material && child.material.color) child.material.color.setHex(color);
    });
  } else if (obj.material && obj.material.color) {
    obj.material.color.setHex(color);
  }
}

function mbSetMeshEmissive(obj, color) {
  if (obj.isGroup) {
    obj.children.forEach(child => {
      if (child.material && child.material.emissive) child.material.emissive.setHex(color);
    });
  } else if (obj.material && obj.material.emissive) {
    obj.material.emissive.setHex(color);
  }
}

function mbSetMeshOpacity(obj, opacity) {
  const setMat = (mat) => { mat.transparent = true; mat.opacity = opacity; };
  if (obj.isGroup) {
    obj.children.forEach(child => {
      if (child.material) setMat(child.material);
    });
  } else if (obj.material) {
    setMat(obj.material);
  }
}

// =============== UTILITIES ===============

function mbFindPart(partId) {
  if (!mbState.catalog) return null;
  return mbState.catalog.parts.find(p => p.id === partId);
}

function mbShowToast(message, type) {
  if (typeof window.showToast === 'function') {
    window.showToast(message, type === 'danger' ? 'error' : type);
  } else {
    console.log(`[Multiboard ${type}] ${message}`);
  }
}

// =============== QUOTE GENERATION ===============

function mbGenerateQuote() {
  if (mbState.tiles.length === 0) {
    mbShowToast('Place some parts before generating a quote', 'info');
    return;
  }
  mbShowQuoteModal();
}

function mbShowQuoteModal() {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:10000;display:flex;align-items:center;justify-content:center;';

  const modal = document.createElement('div');
  modal.style.cssText = 'background:var(--bg-primary,#1e1e2e);border:1px solid var(--border,#333);border-radius:8px;padding:24px;max-width:420px;width:90%;';
  modal.innerHTML = `
    <h3 style="margin:0 0 16px;">Customer Information</h3>
    <div style="margin-bottom:12px;">
      <label style="font-size:12px;color:#888;display:block;margin-bottom:4px;">Customer Name</label>
      <input id="mbQuoteCustName" type="text" value="${mbState.customerName}" placeholder="e.g. Mike Johnson" style="width:100%;padding:8px 10px;box-sizing:border-box;">
    </div>
    <div style="margin-bottom:12px;">
      <label style="font-size:12px;color:#888;display:block;margin-bottom:4px;">Phone</label>
      <input id="mbQuoteCustPhone" type="tel" value="${mbState.customerPhone}" placeholder="828-555-1234" style="width:100%;padding:8px 10px;box-sizing:border-box;">
    </div>
    <div style="margin-bottom:12px;">
      <label style="font-size:12px;color:#888;display:block;margin-bottom:4px;">Email</label>
      <input id="mbQuoteCustEmail" type="email" value="${mbState.customerEmail}" placeholder="customer@example.com" style="width:100%;padding:8px 10px;box-sizing:border-box;">
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
      <button id="mbQuoteCancelBtn" class="secondary" style="padding:8px 16px;">Cancel</button>
      <button id="mbQuoteGenBtn" class="primary" style="padding:8px 16px;">Generate Quote</button>
    </div>
  `;

  overlay.appendChild(modal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) document.body.removeChild(overlay); });

  document.body.appendChild(overlay);

  document.getElementById('mbQuoteCancelBtn').addEventListener('click', () => document.body.removeChild(overlay));
  document.getElementById('mbQuoteGenBtn').addEventListener('click', () => {
    mbState.customerName = document.getElementById('mbQuoteCustName').value.trim();
    mbState.customerPhone = document.getElementById('mbQuoteCustPhone').value.trim();
    mbState.customerEmail = document.getElementById('mbQuoteCustEmail').value.trim();
    document.body.removeChild(overlay);
    mbOpenPrintableQuote();
    mbSaveQuoteToDb();
  });

  document.getElementById('mbQuoteCustName').focus();
}

function mbOpenPrintableQuote() {
  const pricing = mbCalculatePricing();
  const projectName = document.getElementById('mbProjectName')?.value || 'Untitled Design';
  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const serviceLevelLabels = {
    none: 'Parts Only',
    designOnly: 'Design Only',
    designBuild: 'Design + Build',
    turnkey: 'Turnkey Install'
  };

  // Build BOM rows
  let bomRows = '';
  Object.entries(pricing.partCounts).forEach(([partId, qty]) => {
    const part = mbFindPart(partId);
    if (!part) return;
    bomRows += `<tr>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;">${part.name}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:center;">${qty}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;">$${part.priceUSD.toFixed(2)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;">$${(qty * part.priceUSD).toFixed(2)}</td>
    </tr>`;
  });

  // Hardware rows
  Object.entries(pricing.hardwareCounts).forEach(([partId, qty]) => {
    const part = mbFindPart(partId);
    if (!part) return;
    bomRows += `<tr style="color:#666;">
      <td style="padding:6px 10px;border-bottom:1px solid #eee;padding-left:20px;">${part.name}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:center;">${qty}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;">$${part.priceUSD.toFixed(2)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;">$${(qty * part.priceUSD).toFixed(2)}</td>
    </tr>`;
  });

  const serviceRow = mbState.serviceLevel !== 'none' ? `
    <tr>
      <td colspan="3" style="padding:6px 10px;border-bottom:1px solid #eee;">${serviceLevelLabels[mbState.serviceLevel]} Service</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;">$${pricing.serviceFee.toFixed(2)}</td>
    </tr>` : '';

  const html = `<!DOCTYPE html>
<html>
<head>
  <title>Quote - ${projectName}</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color:#333; padding:40px; max-width:800px; margin:0 auto; }
    .header { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:30px; padding-bottom:20px; border-bottom:3px solid #2196f3; }
    .company { font-size:24px; font-weight:700; color:#1a1a2e; }
    .company-sub { font-size:12px; color:#666; margin-top:4px; }
    .quote-title { font-size:20px; font-weight:600; color:#2196f3; text-align:right; }
    .quote-date { font-size:12px; color:#666; text-align:right; margin-top:4px; }
    .info-grid { display:grid; grid-template-columns:1fr 1fr; gap:20px; margin-bottom:24px; }
    .info-box { background:#f8f9fa; border-radius:6px; padding:14px; }
    .info-box h4 { font-size:11px; text-transform:uppercase; color:#888; letter-spacing:0.5px; margin-bottom:6px; }
    .info-box p { font-size:13px; line-height:1.6; }
    table { width:100%; border-collapse:collapse; margin-bottom:20px; }
    thead th { background:#f8f9fa; padding:8px 10px; text-align:left; font-size:12px; text-transform:uppercase; color:#888; letter-spacing:0.3px; border-bottom:2px solid #ddd; }
    .totals { margin-left:auto; width:280px; }
    .totals .row { display:flex; justify-content:space-between; padding:4px 0; font-size:13px; }
    .totals .total-row { border-top:2px solid #333; margin-top:6px; padding-top:8px; font-size:18px; font-weight:700; }
    .footer { margin-top:40px; padding-top:16px; border-top:1px solid #ddd; font-size:11px; color:#888; text-align:center; }
    .notes { background:#fffde7; border-left:3px solid #ffc107; padding:12px 16px; margin:20px 0; font-size:12px; border-radius:0 4px 4px 0; }
    @media print {
      body { padding:20px; }
      .no-print { display:none; }
    }
  </style>
</head>
<body>
  <div class="no-print" style="margin-bottom:20px;text-align:right;">
    <button onclick="window.print()" style="padding:8px 20px;background:#2196f3;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:14px;">Print / Save PDF</button>
  </div>

  <div class="header">
    <div>
      <div class="company">Swayzee Custom Vinyl</div>
      <div class="company-sub">Blue Ridge Custom Co.<br>Multiboard Wall Systems</div>
    </div>
    <div>
      <div class="quote-title">QUOTE</div>
      <div class="quote-date">${date}</div>
    </div>
  </div>

  <div class="info-grid">
    <div class="info-box">
      <h4>Project</h4>
      <p><strong>${projectName}</strong><br>
      Wall: ${mbState.wallWidth}" x ${mbState.wallHeight}" (${pricing.wallSqFt.toFixed(1)} sq ft)<br>
      Service: ${serviceLevelLabels[mbState.serviceLevel]}</p>
    </div>
    <div class="info-box">
      <h4>Customer</h4>
      <p>${mbState.customerName || 'N/A'}<br>
      ${mbState.customerPhone || ''}<br>
      ${mbState.customerEmail || ''}</p>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th style="text-align:left;">Part</th>
        <th style="text-align:center;">Qty</th>
        <th style="text-align:right;">Unit Price</th>
        <th style="text-align:right;">Line Total</th>
      </tr>
    </thead>
    <tbody>
      ${bomRows}
      ${serviceRow}
    </tbody>
  </table>

  <div class="totals">
    <div class="row"><span>Parts Subtotal:</span><span>$${pricing.partsTotal.toFixed(2)}</span></div>
    <div class="row" style="color:#666;"><span>Hardware:</span><span>$${pricing.hardwareTotal.toFixed(2)}</span></div>
    ${mbState.serviceLevel !== 'none' ? `<div class="row"><span>Service Fee:</span><span>$${pricing.serviceFee.toFixed(2)}</span></div>` : ''}
    <div class="row" style="color:#666;"><span>Est. Weight:</span><span>${pricing.weightGrams >= 1000 ? (pricing.weightGrams / 1000).toFixed(1) + 'kg' : pricing.weightGrams + 'g'}</span></div>
    <div class="row total-row"><span>Total:</span><span>$${pricing.grandTotal.toFixed(2)}</span></div>
  </div>

  <div class="notes">
    <strong>Note:</strong> This quote is valid for 30 days. Prices may vary based on color selections and material availability.
    All Multiboard components are 3D printed with PLA and designed for the 25mm grid system.
    ${mbState.serviceLevel === 'turnkey' ? 'Turnkey pricing includes on-site installation within 30 miles. Additional mileage billed at $1.00/mile.' : ''}
  </div>

  <div class="footer">
    Swayzee Custom Vinyl &bull; Blue Ridge Custom Co. &bull; store.swayzecustomvinyl.com
  </div>
</body>
</html>`;

  const quoteWindow = window.open('', '_blank', 'width=850,height=1100');
  if (quoteWindow) {
    quoteWindow.document.write(html);
    quoteWindow.document.close();
  } else {
    mbShowToast('Pop-up blocked. Please allow pop-ups for quote generation.', 'danger');
  }
}

// =============== SAVE QUOTE TO PRINT QUOTES DB ===============

async function mbSaveQuoteToDb() {
  if (typeof window.pqSaveMbQuote !== 'function') return; // quotes-view.js not loaded
  try {
    const pricing = mbCalculatePricing();
    const projectName = document.getElementById('mbProjectName')?.value || 'Untitled Design';
    const totalCents = Math.round(pricing.grandTotal * 100);

    // Build items list from partCounts + hardwareCounts
    const items = [];

    Object.entries(pricing.partCounts).forEach(([partId, qty]) => {
      const part = mbFindPart(partId);
      if (!part) return;
      items.push({
        stl_catalog_id: part._stlCatalogId || null,
        part_id: partId,
        name: part.name,
        qty,
        unit_price_cents: Math.round((part.priceUSD || 0) * 100),
        material: 'PLA',
        missing_stl: part._stlCatalogId ? 0 : 1,
        search_hint: part._stlCatalogId ? null : `${part.name} multiboard`
      });
    });

    Object.entries(pricing.hardwareCounts).forEach(([partId, qty]) => {
      const part = mbFindPart(partId);
      if (!part) return;
      items.push({
        stl_catalog_id: part._stlCatalogId || null,
        part_id: partId,
        name: part.name,
        qty,
        unit_price_cents: Math.round((part.priceUSD || 0) * 100),
        material: 'PLA',
        missing_stl: part._stlCatalogId ? 0 : 1,
        search_hint: part._stlCatalogId ? null : `${part.name} multiboard`
      });
    });

    const quote = await window.pqSaveMbQuote({
      projectName,
      customerName: mbState.customerName,
      email: mbState.customerEmail,
      phone: mbState.customerPhone,
      serviceLevel: mbState.serviceLevel === 'none' ? 'local' : 'local',
      totalCents,
      items
    });

    mbShowToast(`Quote saved to Print Quotes (ID ${quote.id})`, 'success');
  } catch (err) {
    console.error('[Multiboard] Failed to save quote to DB:', err);
    // Non-fatal — user still gets the printable window
  }
}

// =============== BUILD INSTRUCTIONS ===============

async function mbGenerateBuildInstructions() {
  if (mbState.tiles.length === 0) {
    mbShowToast('Place some parts before generating build instructions', 'info');
    return;
  }

  const pricing = mbCalculatePricing();
  const projectName = document.getElementById('mbProjectName')?.value || 'Untitled Design';

  // Build parts list for the document
  const partsList = [];
  const seen = new Set();

  Object.entries(pricing.partCounts).forEach(([partId, qty]) => {
    const part = mbFindPart(partId);
    if (!part || part.hidden) return;
    if (!seen.has(partId)) {
      seen.add(partId);
      partsList.push({ partId: part.id, name: part.name, qty, unitPrice: part.priceUSD });
    }
  });

  Object.entries(pricing.hardwareCounts).forEach(([partId, qty]) => {
    const part = mbFindPart(partId);
    if (!part) return;
    if (!seen.has(partId)) {
      seen.add(partId);
      partsList.push({ partId: part.id, name: part.name, qty, unitPrice: part.priceUSD });
    }
  });

  // Derive howto tags from placed part types
  const tags = new Set();
  tags.add('assembly'); // always include general assembly info
  mbState.tiles.forEach(t => {
    const part = mbFindPart(t.partId);
    if (!part) return;
    const name = (part.name || '').toLowerCase();
    const mbType = part._mbType || '';

    // Tiles always need wall mounting instructions
    if (mbType === 'tile' || /\btile\b/.test(name)) {
      tags.add('wall-mount'); tags.add('tiles');
    }
    // Trays need snap + bracket instructions
    if (/\btray\b/.test(name) || /\blu\b/.test(name)) {
      tags.add('snaps'); tags.add('bolt-lock'); tags.add('multipoint'); tags.add('shells');
    }
    // Bins/shells
    if (mbType === 'bin' || /\bbin\b/.test(name) || /\bshell\b/.test(name)) {
      tags.add('snaps'); tags.add('shells'); tags.add('multipoint');
    }
    // Shelves
    if (mbType === 'shelf' || /\bshelf\b/.test(name) || /\bshelve\b/.test(name)) {
      tags.add('snaps'); tags.add('bolt-lock');
    }
    // Hooks / Peg Click
    if (mbType === 'hook' || mbType === 'peg' || /\bhook\b/.test(name) || /\bpeg\b/.test(name)) {
      tags.add('peg-click');
    }
    // Snap-based accessories
    if (/\bsnap\b/.test(name) || /\bbracket\b/.test(name)) {
      tags.add('snaps');
    }
    // Drawers / inserts
    if (/\bdrawer\b/.test(name) || /\binsert\b/.test(name)) {
      tags.add('shells'); tags.add('multipoint');
    }
    // Check requiresHardware for clues
    const hw = t._resolvedHardware || part.requiresHardware || [];
    hw.forEach(h => {
      if (/snap/.test(h.partId)) tags.add('snaps');
      if (/bolt/.test(h.partId) || /bracket/.test(h.partId)) tags.add('bolt-lock');
      if (/multipoint/.test(h.partId) || /rail/.test(h.partId)) tags.add('multipoint');
    });
  });

  mbShowToast('Generating build instructions...', 'info');

  try {
    const result = await mbApi.post('/api/howtos/build-doc', {
      parts_list: partsList,
      design_name: projectName,
      tags: Array.from(tags),
      format: 'html'
    });

    if (!result.document) {
      mbShowToast('No build instructions available for these parts', 'info');
      return;
    }

    // Open in a new window
    const docWindow = window.open('', '_blank', 'width=900,height=1100');
    if (docWindow) {
      docWindow.document.write(result.document);
      docWindow.document.close();
    } else {
      mbShowToast('Pop-up blocked. Please allow pop-ups for build instructions.', 'danger');
    }
  } catch (err) {
    console.error('[BuildInstructions] Error:', err);
    mbShowToast('Failed to generate build instructions: ' + err.message, 'danger');
  }
}

// =============== ORDERS + STATUS ===============

const MB_STATUS_CONFIG = {
  draft:           { label: 'Draft',         bg: '#444',    color: '#fff' },
  quoted:          { label: 'Quoted',        bg: '#1565c0', color: '#fff' },
  ordered:         { label: 'Ordered',       bg: '#e65100', color: '#fff' },
  'in-production': { label: 'In Production', bg: '#6a1b9a', color: '#fff' },
  complete:        { label: 'Complete',      bg: '#2e7d32', color: '#fff' },
  cancelled:       { label: 'Cancelled',     bg: '#b71c1c', color: '#fff' }
};

function mbUpdateStatusBadge(status) {
  const badge = document.getElementById('mbStatusBadge');
  if (!badge) return;
  const cfg = MB_STATUS_CONFIG[status] || MB_STATUS_CONFIG.draft;
  badge.style.display = 'inline-block';
  badge.style.background = cfg.bg;
  badge.style.color = cfg.color;
  badge.textContent = cfg.label;
  mbState.designStatus = status;
}

function mbCreateOrder() {
  if (mbState.tiles.length === 0) {
    mbShowToast('Design a layout before creating an order', 'info');
    return;
  }

  // Must save first
  if (!mbState.currentDesignId) {
    mbShowToast('Please save the design first', 'info');
    return;
  }

  mbShowOrderConfirmModal();
}

function mbShowOrderConfirmModal() {
  const pricing = mbCalculatePricing();
  const projectName = document.getElementById('mbProjectName')?.value || 'Untitled Design';
  const serviceLevelLabels = {
    none: 'Parts Only', designOnly: 'Design Only',
    designBuild: 'Design + Build', turnkey: 'Turnkey Install'
  };

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:10000;display:flex;align-items:center;justify-content:center;';

  const modal = document.createElement('div');
  modal.style.cssText = 'background:var(--bg-primary,#1e1e2e);border:1px solid var(--border,#333);border-radius:8px;padding:24px;max-width:480px;width:90%;';
  modal.innerHTML = `
    <h3 style="margin:0 0 4px;">Create Production Order</h3>
    <p style="font-size:12px;color:#888;margin:0 0 16px;">This will lock the design and add it to the production queue.</p>

    <div style="background:var(--bg-secondary,#252538);border-radius:6px;padding:12px;margin-bottom:12px;font-size:13px;">
      <div style="display:flex;justify-content:space-between;margin-bottom:4px;"><span style="color:#888;">Project:</span><span>${projectName}</span></div>
      <div style="display:flex;justify-content:space-between;margin-bottom:4px;"><span style="color:#888;">Wall:</span><span>${mbState.wallWidth}" x ${mbState.wallHeight}"</span></div>
      <div style="display:flex;justify-content:space-between;margin-bottom:4px;"><span style="color:#888;">Service:</span><span>${serviceLevelLabels[mbState.serviceLevel]}</span></div>
      <div style="display:flex;justify-content:space-between;margin-bottom:4px;"><span style="color:#888;">Parts:</span><span>${mbState.tiles.length} components</span></div>
      <div style="display:flex;justify-content:space-between;font-weight:600;border-top:1px solid var(--border,#333);padding-top:6px;margin-top:4px;">
        <span>Total:</span><span>$${pricing.grandTotal.toFixed(2)}</span>
      </div>
    </div>

    <div style="margin-bottom:12px;">
      <label style="font-size:12px;color:#888;display:block;margin-bottom:4px;">Customer</label>
      <input id="mbOrderCustName" type="text" value="${mbState.customerName}" placeholder="Customer name" style="width:100%;padding:6px 10px;margin-bottom:6px;box-sizing:border-box;">
      <div style="display:flex;gap:6px;">
        <input id="mbOrderCustPhone" type="tel" value="${mbState.customerPhone}" placeholder="Phone" style="flex:1;padding:6px 10px;box-sizing:border-box;">
        <input id="mbOrderCustEmail" type="email" value="${mbState.customerEmail}" placeholder="Email" style="flex:1;padding:6px 10px;box-sizing:border-box;">
      </div>
    </div>

    <div style="margin-bottom:16px;">
      <label style="font-size:12px;color:#888;display:block;margin-bottom:4px;">Notes</label>
      <textarea id="mbOrderNotes" rows="2" placeholder="Production notes (optional)" style="width:100%;padding:6px 10px;resize:vertical;box-sizing:border-box;"></textarea>
    </div>

    <div style="display:flex;gap:8px;justify-content:flex-end;">
      <button id="mbOrderCancelBtn" class="secondary" style="padding:8px 16px;">Cancel</button>
      <button id="mbOrderConfirmBtn" class="primary" style="padding:8px 16px;background:#e65100;">Confirm Order</button>
    </div>
  `;

  overlay.appendChild(modal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) document.body.removeChild(overlay); });
  document.body.appendChild(overlay);

  document.getElementById('mbOrderCancelBtn').addEventListener('click', () => document.body.removeChild(overlay));
  document.getElementById('mbOrderConfirmBtn').addEventListener('click', async () => {
    const btn = document.getElementById('mbOrderConfirmBtn');
    btn.disabled = true;
    btn.textContent = 'Creating...';

    mbState.customerName = document.getElementById('mbOrderCustName').value.trim();
    mbState.customerPhone = document.getElementById('mbOrderCustPhone').value.trim();
    mbState.customerEmail = document.getElementById('mbOrderCustEmail').value.trim();

    try {
      // Save design first to capture latest customer info
      await mbSaveDesign();

      const pricing = mbCalculatePricing();
      const result = await mbApi.post('/api/multiboard/order', {
        designId: mbState.currentDesignId,
        customerName: mbState.customerName,
        customerEmail: mbState.customerEmail,
        customerPhone: mbState.customerPhone,
        serviceLevel: mbState.serviceLevel,
        totalPriceCents: Math.round(pricing.grandTotal * 100),
        serviceFeeCents: Math.round(pricing.serviceFee * 100),
        notes: document.getElementById('mbOrderNotes').value.trim() || null
      });

      document.body.removeChild(overlay);
      mbUpdateStatusBadge('ordered');
      mbShowToast(`Order created: ${result.orderId}`, 'success');
    } catch (err) {
      console.error('[Multiboard] Create order error:', err);
      btn.disabled = false;
      btn.textContent = 'Confirm Order';
      mbShowToast('Order failed: ' + err.message, 'danger');
    }
  });

  document.getElementById('mbOrderCustName').focus();
}

async function mbShowOrdersPanel() {
  try {
    const { orders } = await mbApi.get('/api/multiboard/orders');
    if (!orders || orders.length === 0) {
      mbShowToast('No orders found', 'info');
      return;
    }

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:10000;display:flex;align-items:center;justify-content:center;';

    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-primary,#1e1e2e);border:1px solid var(--border,#333);border-radius:8px;padding:20px;max-width:600px;width:95%;max-height:500px;overflow-y:auto;';
    modal.innerHTML = `<h3 style="margin:0 0 12px;">Production Orders</h3>`;

    orders.forEach(o => {
      const cfg = MB_STATUS_CONFIG[o.status] || MB_STATUS_CONFIG.draft;
      const total = o.total_price_cents ? `$${(o.total_price_cents / 100).toFixed(2)}` : '$0.00';
      const date = new Date(o.created_at).toLocaleDateString();

      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px;border:1px solid var(--border,#333);border-radius:6px;margin-bottom:6px;';
      row.innerHTML = `
        <div style="flex:1;min-width:0;">
          <div style="font-weight:500;font-size:13px;">${o.customer_name || 'No Customer'} <span style="color:#888;font-weight:400;">— ${o.order_id}</span></div>
          <div style="font-size:12px;color:#888;">${o.wall_width_inches}x${o.wall_height_inches}" | ${total} | ${date}</div>
          ${o.notes ? `<div style="font-size:11px;color:#666;margin-top:2px;">${o.notes}</div>` : ''}
        </div>
        <span style="font-size:10px;padding:3px 8px;border-radius:8px;font-weight:600;text-transform:uppercase;background:${cfg.bg};color:${cfg.color};">${cfg.label}</span>
        <select class="mb-order-status-select" data-order-id="${o.order_id}" style="padding:4px 6px;font-size:11px;border-radius:4px;">
          <option value="ordered" ${o.status === 'ordered' ? 'selected' : ''}>Ordered</option>
          <option value="in-production" ${o.status === 'in-production' ? 'selected' : ''}>In Production</option>
          <option value="complete" ${o.status === 'complete' ? 'selected' : ''}>Complete</option>
          <option value="cancelled" ${o.status === 'cancelled' ? 'selected' : ''}>Cancelled</option>
        </select>
      `;
      modal.appendChild(row);
    });

    const closeBtn = document.createElement('button');
    closeBtn.className = 'secondary';
    closeBtn.style.cssText = 'margin-top:8px;width:100%;padding:8px;';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', () => document.body.removeChild(overlay));
    modal.appendChild(closeBtn);

    overlay.appendChild(modal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { document.body.removeChild(overlay); } });
    document.body.appendChild(overlay);

    // Status change handlers
    modal.querySelectorAll('.mb-order-status-select').forEach(sel => {
      sel.addEventListener('change', async (e) => {
        const orderId = e.target.dataset.orderId;
        const newStatus = e.target.value;
        try {
          const resp = await fetch(`${mbApi.getServerUrl()}/api/multiboard/orders/${orderId}/status`, {
            method: 'PATCH',
            headers: mbApi.getHeaders(),
            body: JSON.stringify({ status: newStatus })
          });
          if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error || 'Failed');
          mbShowToast(`Order ${orderId} → ${newStatus}`, 'success');
          // Refresh the badge on the parent row
          const badge = e.target.previousElementSibling;
          const cfg = MB_STATUS_CONFIG[newStatus];
          if (badge && cfg) {
            badge.style.background = cfg.bg;
            badge.textContent = cfg.label;
          }
        } catch (err) {
          mbShowToast('Status update failed: ' + err.message, 'danger');
        }
      });
    });
  } catch (err) {
    console.error('[Multiboard] Load orders error:', err);
    mbShowToast('Failed to load orders: ' + err.message, 'danger');
  }
}

// =============== EVENT LISTENERS ===============

function setupMultiboardEventListeners() {
  document.getElementById('mbApplyWallBtn')?.addEventListener('click', mbApplyWallDimensions);
  document.getElementById('mbResetCameraBtn')?.addEventListener('click', mbResetCamera);
  document.getElementById('mbSaveBtn')?.addEventListener('click', mbSaveDesign);
  document.getElementById('mbLoadBtn')?.addEventListener('click', mbLoadDesign);
  document.getElementById('mbQuoteBtn')?.addEventListener('click', mbGenerateQuote);
  document.getElementById('mbBuildInstructionsBtn')?.addEventListener('click', mbGenerateBuildInstructions);
  document.getElementById('mbOrderBtn')?.addEventListener('click', mbCreateOrder);
  document.getElementById('mbOrdersListBtn')?.addEventListener('click', mbShowOrdersPanel);

  document.getElementById('mbServiceLevel')?.addEventListener('change', (e) => {
    mbState.serviceLevel = e.target.value;
    mbUpdateBom();
  });

  document.getElementById('mbToggleGridBtn')?.addEventListener('click', () => {
    mbState.showGrid = !mbState.showGrid;
    mbBuildGrid();
  });

  document.addEventListener('keydown', (e) => {
    const view = document.getElementById('multiboardDesignerView');
    if (!view || !view.classList.contains('active')) return;

    if (e.key === 'Escape') {
      if (mbState.isPlacing) {
        mbCancelPlacing();
      } else {
        mbDeselectTile();
      }
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (mbState.selectedTile && document.activeElement?.tagName !== 'INPUT') {
        mbRemoveComponent(mbState.selectedTile.id);
      }
    }
  });
}
