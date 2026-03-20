/**
 * BRCC Dog Tag Generator View — v3 (Three.js 3D Render)
 * ============================================================
 * Real 3D preview of dog tags using Three.js with:
 *   - Extruded shape geometry with bevel
 *   - Recessed text pocket + raised insert
 *   - Ring hole + tab
 *   - Orbit controls for inspection
 *   - Raycasted text dragging on tag surface
 *   - Batch queue + slicer integration
 * ============================================================
 */

/* global THREE */

const DT = {
  initialized: false,
  shapes: [],
  shapeGeo: {},
  defaults: {},
  fonts: [],
  selectedShape: 'bone',
  petName: '',       // backward compat: line 1 text
  colorIdx: 0,
  textCx: null,
  textCy: null,
  textSz: null,
  // Multi-line support
  mode: 'basePlate', // 'basePlate' | 'standaloneName'
  lineCount: 1,      // 1 or 2
  lines: [
    { text: '', font: 'Liberation Sans:style=Bold', fontSize: null, cx: null, cy: null },
    { text: '', font: 'Liberation Sans:style=Bold', fontSize: null, cx: null, cy: null },
  ],
  dragging: false,
  draggingLineIdx: -1,
  dragOffset: null,
  openscadAvailable: false,
  generating: false,
  batchQueue: [],
  history: [],
  lastGenResult: null,
  // Three.js
  scene: null,
  camera: null,
  renderer: null,
  controls: null,
  animId: null,
  tagGroup: null,
  textMeshes: [],    // one per line (replaces single textMesh)
  textMesh: null,    // backward compat alias
  raycaster: null,
  mouse: new (typeof THREE !== 'undefined' ? THREE.Vector2 : Object)(),
  tagTopPlane: null,
  container: null,
  // v2: STL blank geometry cache { shapeId: THREE.BufferGeometry }
  stlCache: {},
  tagsDir: null,
  // Standalone mode
  standaloneThickness: 3.0,
  standaloneConnectExpand: 0.3,
};

const COLOR_PRESETS = [
  { base: '#ffffff', insert: '#222222', label: 'White + Black', baseLabel: 'White', insertLabel: 'Black' },
  { base: '#222222', insert: '#ffffff', label: 'Black + White', baseLabel: 'Black', insertLabel: 'White' },
  { base: '#1a1a2e', insert: '#e8b931', label: 'Navy + Gold', baseLabel: 'Navy', insertLabel: 'Gold' },
  { base: '#8b0000', insert: '#ffffff', label: 'Red + White', baseLabel: 'Red', insertLabel: 'White' },
  { base: '#2d5016', insert: '#f5f5dc', label: 'Green + Cream', baseLabel: 'Green', insertLabel: 'Cream' },
  { base: '#4a90d9', insert: '#ffffff', label: 'Blue + White', baseLabel: 'Blue', insertLabel: 'White' },
];

// Tag dimensions (mm)
const TAG_THICKNESS = 3.2;
const POCKET_DEPTH = 1.4;
const INSERT_HEIGHT = 1.35;
const RING_HOLE_DIA = 4.6;
const BEVEL_SIZE = 0.4;
const BEVEL_SEGMENTS = 3;

// ═══════════════════════════════════════════════════════════════
// STL BLANK LOADING (v2 — loads actual Tinkercad blanks)
// ═══════════════════════════════════════════════════════════════

async function dtLoadBlankStl(shapeId) {
  if (DT.stlCache[shapeId]) return DT.stlCache[shapeId]; // already cached
  if (typeof THREE === 'undefined' || typeof THREE.STLLoader === 'undefined') return null;

  try {
    const result = await window.printStation.dogTag.loadBlankStl(shapeId);
    if (!result || !result.found) return null;

    const binaryStr = atob(result.base64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

    const loader = new THREE.STLLoader();
    const geometry = loader.parse(bytes.buffer);
    geometry.computeVertexNormals();
    // Center the geometry horizontally but keep Z base at 0
    geometry.computeBoundingBox();
    const bb = geometry.boundingBox;
    const cx = (bb.max.x + bb.min.x) / 2;
    const cy = (bb.max.y + bb.min.y) / 2;
    const zMin = bb.min.z;
    geometry.translate(-cx, -cy, -zMin);

    DT.stlCache[shapeId] = geometry;
    return geometry;
  } catch (e) {
    console.warn('[DogTag] Failed to load blank STL for', shapeId, e);
    return null;
  }
}

// Preload all available blank STLs
async function dtPreloadBlanks() {
  for (const shape of DT.shapes) {
    if (shape.hasBlankStl) {
      dtLoadBlankStl(shape.id); // fire and forget, will cache
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// (Predefined shape profiles removed — all shapes are user-uploaded STL blanks)
// ═══════════════════════════════════════════════════════════════

// (All predefined shape profile functions removed — shapes come from uploaded STL files)

function _dtRemoved_placeholder() {
  const sl = 32, sw = 10, knobR = 5, knobDist = 6;

  // All circles that define the bone shape
  const circles = [];
  // Shaft: hull of 2 circles = rounded rectangle
  circles.push({ x: -sl / 2 + 2, y: 0, r: sw / 2 });
  circles.push({ x: sl / 2 - 2, y: 0, r: sw / 2 });
  // End knobs: 4 per end at 45/135/225/315 degrees
  for (const ex of [-sl / 2, sl / 2]) {
    for (const angle of [45, 135, 225, 315]) {
      const rad = angle * Math.PI / 180;
      circles.push({ x: ex + Math.cos(rad) * knobDist, y: Math.sin(rad) * knobDist, r: knobR });
    }
  }

  // March around the union boundary using angular sampling from center
  const pts = dtUnionOutline(circles, 360);
  const shape = new THREE.Shape();
  if (pts.length > 0) {
    shape.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i].x, pts[i].y);
    shape.closePath();
  }
  return shape;
}

// Trace the outer boundary of a union of circles by raycasting from center
function dtUnionOutline(circles, numSamples) {
  const pts = [];
  for (let i = 0; i < numSamples; i++) {
    const angle = (i / numSamples) * Math.PI * 2;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    // Find the farthest point on any circle boundary in this direction
    let maxDist = 0;
    for (const c of circles) {
      // Project circle center onto ray direction
      const proj = c.x * dx + c.y * dy;
      const perpSq = c.x * c.x + c.y * c.y - proj * proj;
      if (perpSq < c.r * c.r) {
        const d = proj + Math.sqrt(c.r * c.r - perpSq);
        if (d > maxDist) maxDist = d;
      }
    }
    if (maxDist > 0) {
      pts.push({ x: dx * maxDist, y: dy * maxDist });
    }
  }
  return pts;
}

function dtShieldProfile() {
  // Shield: wide top with rounded corners, tapers to a point at bottom
  // Matches OpenSCAD hull of 3 circles
  const w = 40, h = 50, tr = 5;
  const shape = new THREE.Shape();
  // Bottom point (small rounding)
  shape.moveTo(0, -h / 2 + 3 + 3); // start just above bottom tip
  // Right side going up
  shape.lineTo(w / 2 - tr, h / 2 - tr);
  // Top right rounded corner
  shape.absarc(w / 2 - tr, h / 2 - tr, tr, 0, Math.PI / 2, false);
  // Top edge
  shape.lineTo(-w / 2 + tr, h / 2);
  // Top left rounded corner
  shape.absarc(-w / 2 + tr, h / 2 - tr, tr, Math.PI / 2, Math.PI, false);
  // Left side going down
  shape.lineTo(0, -h / 2 + 3);
  shape.closePath();
  return shape;
}

function dtHeartProfile() {
  const shape = new THREE.Shape();
  const s = 1.15;
  // Heart from two arcs and a point
  // Using bezier curves for smooth heart
  const x = 0, y = 0;
  shape.moveTo(x, y - 22 * s); // bottom point
  // Right lobe
  shape.bezierCurveTo(x + 10 * s, y - 22 * s, x + 22 * s, y - 10 * s, x + 20 * s, y + 2 * s);
  shape.bezierCurveTo(x + 18 * s, y + 10 * s, x + 5 * s, y + 12 * s, x, y + 8 * s);
  // Left lobe
  shape.bezierCurveTo(x - 5 * s, y + 12 * s, x - 18 * s, y + 10 * s, x - 20 * s, y + 2 * s);
  shape.bezierCurveTo(x - 22 * s, y - 10 * s, x - 10 * s, y - 22 * s, x, y - 22 * s);
  return shape;
}

function dtPawProfile() {
  // Paw tag is a circle (matches OpenSCAD: circle(d=44))
  const shape = new THREE.Shape();
  shape.absarc(0, 0, 22, 0, Math.PI * 2, false);
  return shape;
}

// Add decorative paw print engravings on top of the paw tag
function dtAddPawDecoration(group, baseColor) {
  const darkColor = baseColor.clone().multiplyScalar(0.7);
  const mat = new THREE.MeshPhysicalMaterial({ color: darkColor, roughness: 0.5 });
  const depth = 0.3;
  const z = TAG_THICKNESS + BEVEL_SIZE - depth / 2 + 0.01;

  // Main pad (large ellipse)
  const padGeo = new THREE.CylinderGeometry(6, 6, depth, 24);
  padGeo.rotateX(Math.PI / 2);
  const padScale = new THREE.Mesh(padGeo, mat);
  padScale.scale.set(1.3, 1, 1);
  padScale.position.set(0, -5, z);
  group.add(padScale);

  // Four toe pads
  const toePositions = [
    { x: -8, y: 5 },
    { x: -3, y: 9 },
    { x: 3, y: 9 },
    { x: 8, y: 5 },
  ];
  const toeGeo = new THREE.CylinderGeometry(3, 3, depth, 16);
  toeGeo.rotateX(Math.PI / 2);
  for (const tp of toePositions) {
    const toe = new THREE.Mesh(toeGeo, mat);
    toe.position.set(tp.x, tp.y, z);
    toe.scale.set(1, 1.3, 1);
    group.add(toe);
  }
}

function dtHydrantProfile() {
  const shape = new THREE.Shape();
  // Simplified hydrant: wide base, narrow body, dome top
  // Base
  shape.moveTo(-15, -22);
  shape.lineTo(15, -22);
  shape.lineTo(15, -14);
  // Right nozzle bump
  shape.lineTo(18, -8);
  shape.absarc(14, -4, 4, -Math.PI / 2, Math.PI / 2, false);
  shape.lineTo(12, 0);
  shape.lineTo(10, 2);
  shape.lineTo(10, 8);
  shape.lineTo(9, 12);
  // Top dome
  shape.absarc(0, 15, 8, 0.1, Math.PI - 0.1, false);
  shape.lineTo(-9, 12);
  shape.lineTo(-10, 8);
  shape.lineTo(-10, 2);
  shape.lineTo(-12, 0);
  // Left nozzle bump
  shape.absarc(-14, -4, 4, Math.PI / 2, -Math.PI / 2, true);
  shape.lineTo(-15, -14);
  shape.closePath();
  return shape;
}

function dtStarProfile() {
  const shape = new THREE.Shape();
  const points = 5, outerR = 24, innerR = 11;
  for (let i = 0; i < points * 2; i++) {
    const angle = (Math.PI * 2 / (points * 2)) * i - Math.PI / 2;
    const r = i % 2 === 0 ? outerR : innerR;
    const x = Math.cos(angle) * r;
    const y = Math.sin(angle) * r;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  return shape;
}

// ═══════════════════════════════════════════════════════════════
// FONT HELPERS
// ═══════════════════════════════════════════════════════════════

// DT.fonts populated from IPC during init
// Map OpenSCAD font name to CSS font-family
function dtMapFontToCss(oscadFont) {
  if (!oscadFont) return 'Arial';
  // Strip :style=... suffix
  return oscadFont.replace(/:style=.*$/i, '').trim();
}

// ═══════════════════════════════════════════════════════════════
// TEXT TEXTURE — render text to a canvas, use as texture
// ═══════════════════════════════════════════════════════════════

function dtCreateTextTexture(text, fontSize, color, fontFamily) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const cssFamily = fontFamily ? dtMapFontToCss(fontFamily) : 'Arial';
  const font = `bold ${fontSize * 10}px "${cssFamily}", "Arial", sans-serif`;
  ctx.font = font;
  const metrics = ctx.measureText(text);
  const pad = fontSize * 3;
  canvas.width = Math.ceil(metrics.width + pad * 2);
  canvas.height = Math.ceil(fontSize * 14 + pad * 2);

  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;

  // Return texture and dimensions in mm
  const mmWidth = canvas.width / 10;
  const mmHeight = canvas.height / 10;
  return { texture, width: mmWidth, height: mmHeight, canvas };
}

// ═══════════════════════════════════════════════════════════════
// 3D SCENE SETUP
// ═══════════════════════════════════════════════════════════════

function dtSetupScene() {
  const container = document.getElementById('dt3DContainer');
  if (!container || typeof THREE === 'undefined') return;
  DT.container = container;

  // Clean up existing
  dtCleanupScene();

  const w = container.clientWidth;
  const h = container.clientHeight;

  // Scene
  DT.scene = new THREE.Scene();
  DT.scene.background = new THREE.Color(0xf0f0f0);

  // Camera — angled view from above
  DT.camera = new THREE.PerspectiveCamera(35, w / h, 0.1, 1000);
  DT.camera.position.set(0, -50, 60);
  DT.camera.lookAt(0, 0, 0);

  // Renderer
  DT.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  DT.renderer.setSize(w, h);
  DT.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  DT.renderer.shadowMap.enabled = true;
  DT.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.innerHTML = '';
  container.appendChild(DT.renderer.domElement);

  // Lights
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
  DT.scene.add(ambientLight);

  const mainLight = new THREE.DirectionalLight(0xffffff, 0.8);
  mainLight.position.set(20, -20, 50);
  mainLight.castShadow = true;
  mainLight.shadow.mapSize.set(1024, 1024);
  mainLight.shadow.camera.near = 1;
  mainLight.shadow.camera.far = 200;
  mainLight.shadow.camera.left = -50;
  mainLight.shadow.camera.right = 50;
  mainLight.shadow.camera.top = 50;
  mainLight.shadow.camera.bottom = -50;
  DT.scene.add(mainLight);

  const fillLight = new THREE.DirectionalLight(0xaaccff, 0.3);
  fillLight.position.set(-30, 10, 30);
  DT.scene.add(fillLight);

  const rimLight = new THREE.DirectionalLight(0xffeedd, 0.2);
  rimLight.position.set(0, 40, 10);
  DT.scene.add(rimLight);

  // Ground plane (shadow receiver)
  const groundGeo = new THREE.PlaneGeometry(200, 200);
  const groundMat = new THREE.ShadowMaterial({ opacity: 0.15 });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.position.z = -0.5;
  ground.receiveShadow = true;
  DT.scene.add(ground);

  // Subtle grid
  const gridHelper = new THREE.GridHelper(100, 20, 0xdddddd, 0xeeeeee);
  gridHelper.rotation.x = Math.PI / 2;
  gridHelper.position.z = -0.3;
  DT.scene.add(gridHelper);

  // Orbit Controls
  if (typeof THREE.OrbitControls !== 'undefined') {
    DT.controls = new THREE.OrbitControls(DT.camera, DT.renderer.domElement);
    DT.controls.enableDamping = true;
    DT.controls.dampingFactor = 0.08;
    DT.controls.minDistance = 20;
    DT.controls.maxDistance = 200;
    DT.controls.target.set(0, 0, TAG_THICKNESS / 2);
    DT.controls.update();
  }

  // Raycaster for text dragging
  DT.raycaster = new THREE.Raycaster();
  DT.tagTopPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -TAG_THICKNESS);

  // Tag group
  DT.tagGroup = new THREE.Group();
  DT.scene.add(DT.tagGroup);

  // Mouse events
  DT.renderer.domElement.addEventListener('mousedown', dtOnMouseDown3D);
  DT.renderer.domElement.addEventListener('mousemove', dtOnMouseMove3D);
  DT.renderer.domElement.addEventListener('mouseup', dtOnMouseUp3D);
  DT.renderer.domElement.addEventListener('mouseleave', dtOnMouseUp3D);

  // Resize observer
  DT._resizeObs = new ResizeObserver(() => {
    const nw = container.clientWidth;
    const nh = container.clientHeight;
    if (nw > 0 && nh > 0) {
      DT.camera.aspect = nw / nh;
      DT.camera.updateProjectionMatrix();
      DT.renderer.setSize(nw, nh);
    }
  });
  DT._resizeObs.observe(container);

  // Start render loop
  dtAnimate();

  // Build initial tag
  dtBuildTag();
}

function dtCleanupScene() {
  if (DT.animId) cancelAnimationFrame(DT.animId);
  DT.animId = null;
  if (DT._resizeObs) DT._resizeObs.disconnect();
  if (DT.renderer) {
    DT.renderer.domElement.removeEventListener('mousedown', dtOnMouseDown3D);
    DT.renderer.domElement.removeEventListener('mousemove', dtOnMouseMove3D);
    DT.renderer.domElement.removeEventListener('mouseup', dtOnMouseUp3D);
    DT.renderer.domElement.removeEventListener('mouseleave', dtOnMouseUp3D);
    DT.renderer.dispose();
  }
  if (DT.controls) DT.controls.dispose();
  DT.scene = null;
  DT.camera = null;
  DT.renderer = null;
  DT.controls = null;
}

function dtAnimate() {
  DT.animId = requestAnimationFrame(dtAnimate);
  if (DT.controls) DT.controls.update();
  if (DT.renderer && DT.scene && DT.camera) {
    DT.renderer.render(DT.scene, DT.camera);
  }
}

// ═══════════════════════════════════════════════════════════════
// BUILD TAG 3D MODEL
// ═══════════════════════════════════════════════════════════════

function dtBuildTag() {
  if (!DT.tagGroup || !DT.scene) return;

  // Clear existing
  while (DT.tagGroup.children.length > 0) {
    const child = DT.tagGroup.children[0];
    DT.tagGroup.remove(child);
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      if (child.material.map) child.material.map.dispose();
      child.material.dispose();
    }
  }
  DT.textMesh = null;
  DT.textMeshes = [];

  // Standalone mode: just show text, no base plate
  if (DT.mode === 'standaloneName') {
    dtBuildStandalonePreview();
    return;
  }

  const colors = COLOR_PRESETS[DT.colorIdx] || COLOR_PRESETS[0];
  let geo = DT.shapeGeo[DT.selectedShape];

  // For imported shapes without built-in geometry, derive it from the STL bounding box
  if (!geo && DT.stlCache[DT.selectedShape]) {
    const stl = DT.stlCache[DT.selectedShape];
    stl.computeBoundingBox();
    const bb = stl.boundingBox;
    const w = bb.max.x - bb.min.x;
    const h = bb.max.y - bb.min.y;
    geo = {
      type: DT.selectedShape,
      width: w, height: h,
      textCx: 0, textCy: 0, textSz: null,
      ringX: 0, ringY: 0,
      thickness: bb.max.z - bb.min.z,
    };
    DT.shapeGeo[DT.selectedShape] = geo;
  }

  if (!geo) return;

  const baseColor = new THREE.Color(colors.base);
  const insertColor = new THREE.Color(colors.insert);

  const ringX = geo.ringX;
  const ringY = geo.ringY;

  // Use actual STL height when available, otherwise config/default
  const stlGeoCheck = DT.stlCache[DT.selectedShape];
  let thickness = geo.thickness || TAG_THICKNESS;
  if (stlGeoCheck) {
    stlGeoCheck.computeBoundingBox();
    thickness = stlGeoCheck.boundingBox.max.z - stlGeoCheck.boundingBox.min.z;
  }

  // Update camera target and drag plane for actual thickness
  if (DT.controls) {
    DT.controls.target.set(0, 0, thickness / 2);
    DT.controls.update();
  }
  if (DT.tagTopPlane) {
    DT.tagTopPlane.set(new THREE.Vector3(0, 0, 1), -thickness);
  }

  const bodyMat = new THREE.MeshPhysicalMaterial({
    color: baseColor,
    roughness: 0.35,
    metalness: 0.0,
    clearcoat: 0.2,
    clearcoatRoughness: 0.4,
  });

  // ── Tag body: loaded from uploaded STL blank ──
  const stlGeo = DT.stlCache[DT.selectedShape];
  if (stlGeo) {
    const bodyMesh = new THREE.Mesh(stlGeo.clone(), bodyMat);
    bodyMesh.castShadow = true;
    bodyMesh.receiveShadow = true;
    bodyMesh.name = 'tagBody';
    DT.tagGroup.add(bodyMesh);
  } else {
    // No STL loaded — show placeholder
    return;
  }

  // ── Text lines ──
  dtBuildTextLines(geo, insertColor, thickness);

  // ── Position readout ──
  dtUpdatePosReadout();
}

function dtBuildTextLines(geo, insertColor, tagThickness) {
  tagThickness = tagThickness || TAG_THICKNESS;
  DT.textMeshes = [];
  DT.textMesh = null;

  const insertHex = '#' + insertColor.getHexString();
  const count = DT.mode === 'basePlate' ? DT.lineCount : 1;

  for (let i = 0; i < count; i++) {
    const line = DT.lines[i];
    const text = line.text || (i === 0 ? DT.petName : '') || '';
    if (!text) continue;

    const tcx = line.cx !== null ? line.cx : (i === 0 ? (DT.textCx !== null ? DT.textCx : geo.textCx) : 0);
    const tcy = line.cy !== null ? line.cy : (i === 0 ? (DT.textCy !== null ? DT.textCy : geo.textCy) : (geo.textCy || 0) - (geo.textSz || 7) * 1.5);
    const tsz = line.fontSize !== null ? line.fontSize : (i === 0 ? (DT.textSz !== null ? DT.textSz : geo.textSz) : (geo.textSz || 7) * 0.7);
    const font = line.font || 'Liberation Sans:style=Bold';

    const textData = dtCreateTextTexture(text, tsz, insertHex, font);
    const { texture, width: tw, height: th } = textData;

    const labelGeo = new THREE.PlaneGeometry(tw, th);
    const labelMat = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1 - i,
    });
    const labelMesh = new THREE.Mesh(labelGeo, labelMat);
    labelMesh.position.set(tcx, tcy, tagThickness + 0.05);
    labelMesh.name = `textLabel_${i}`;
    DT.tagGroup.add(labelMesh);

    const entry = { label: labelMesh, width: tw, height: th, lineIdx: i };
    DT.textMeshes.push(entry);
    if (i === 0) DT.textMesh = entry; // backward compat
  }
}

// ═══════════════════════════════════════════════════════════════
// STANDALONE NAME PREVIEW
// ═══════════════════════════════════════════════════════════════

function dtBuildStandalonePreview() {
  const text = DT.lines[0].text || DT.petName || '';
  if (!text || !DT.tagGroup) return;

  const font = DT.lines[0].font || 'Liberation Sans:style=Bold';
  const fontSize = DT.lines[0].fontSize || 10;
  const thickness = DT.standaloneThickness || 3.0;
  const color = (COLOR_PRESETS[DT.colorIdx] || COLOR_PRESETS[0]).base;

  // Render text to canvas to get dimensions
  const textData = dtCreateTextTexture(text, fontSize, '#ffffff', font);
  const { texture, width: tw, height: th } = textData;

  // Create a box that approximates the extruded text
  const boxGeo = new THREE.BoxGeometry(tw, th, thickness);
  const boxMat = new THREE.MeshPhysicalMaterial({
    color,
    roughness: 0.4,
    metalness: 0.1,
  });
  const boxMesh = new THREE.Mesh(boxGeo, boxMat);
  boxMesh.position.set(0, 0, thickness / 2);
  boxMesh.castShadow = true;
  boxMesh.name = 'standaloneBody';
  DT.tagGroup.add(boxMesh);

  // Add text label on top
  const labelGeo = new THREE.PlaneGeometry(tw, th);
  const labelMat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
  });
  const labelMesh = new THREE.Mesh(labelGeo, labelMat);
  labelMesh.position.set(0, 0, thickness + 0.05);
  labelMesh.name = 'standaloneLabel';
  DT.tagGroup.add(labelMesh);
}

// ═══════════════════════════════════════════════════════════════
// MOUSE / DRAG HANDLING (3D raycasting)
// ═══════════════════════════════════════════════════════════════

function dtGetMouseMm(e) {
  if (!DT.renderer || !DT.camera) return null;
  const rect = DT.renderer.domElement.getBoundingClientRect();
  const mouse = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1
  );

  DT.raycaster.setFromCamera(mouse, DT.camera);
  const intersection = new THREE.Vector3();
  if (DT.raycaster.ray.intersectPlane(DT.tagTopPlane, intersection)) {
    return { x: intersection.x, y: intersection.y };
  }
  return null;
}

// Returns line index if mouse is over any text line, or -1
function dtFindTextLineAt(mm) {
  if (!mm || DT.textMeshes.length === 0) return -1;
  for (let i = DT.textMeshes.length - 1; i >= 0; i--) {
    const tm = DT.textMeshes[i];
    const pos = tm.label.position;
    if (Math.abs(mm.x - pos.x) < tm.width / 2 + 3 && Math.abs(mm.y - pos.y) < tm.height / 2 + 3) {
      return i;
    }
  }
  return -1;
}

function dtOnMouseDown3D(e) {
  const mm = dtGetMouseMm(e);
  if (!mm) return;
  const lineIdx = dtFindTextLineAt(mm);
  if (lineIdx >= 0) {
    const pos = DT.textMeshes[lineIdx].label.position;
    DT.dragging = true;
    DT.draggingLineIdx = lineIdx;
    DT.dragOffset = { x: mm.x - pos.x, y: mm.y - pos.y };
    if (DT.controls) DT.controls.enabled = false;
    DT.renderer.domElement.style.cursor = 'grabbing';
  }
}

function dtOnMouseMove3D(e) {
  const mm = dtGetMouseMm(e);
  if (!mm) return;

  if (DT.dragging && DT.dragOffset && DT.draggingLineIdx >= 0) {
    const newX = parseFloat((mm.x - DT.dragOffset.x).toFixed(1));
    const newY = parseFloat((mm.y - DT.dragOffset.y).toFixed(1));
    const idx = DT.draggingLineIdx;

    // Update the line's stored position
    DT.lines[idx].cx = newX;
    DT.lines[idx].cy = newY;

    // Backward compat for line 0
    if (idx === 0) { DT.textCx = newX; DT.textCy = newY; }

    // Move the mesh directly (no full rebuild)
    if (DT.textMeshes[idx]) {
      DT.textMeshes[idx].label.position.x = newX;
      DT.textMeshes[idx].label.position.y = newY;
    }
    dtUpdatePosReadout();
  } else {
    DT.renderer.domElement.style.cursor = dtFindTextLineAt(mm) >= 0 ? 'grab' : 'default';
  }
}

function dtOnMouseUp3D() {
  if (DT.dragging) {
    DT.dragging = false;
    DT.draggingLineIdx = -1;
    DT.dragOffset = null;
    if (DT.controls) DT.controls.enabled = true;
    if (DT.renderer) DT.renderer.domElement.style.cursor = 'default';
  }
}

function dtUpdatePosReadout() {
  const posLabel = document.getElementById('dtPosReadout');
  if (!posLabel) return;
  const geo = DT.shapeGeo[DT.selectedShape];
  if (!geo) return;
  const cx = (DT.textCx !== null ? DT.textCx : geo.textCx).toFixed(1);
  const cy = (DT.textCy !== null ? DT.textCy : geo.textCy).toFixed(1);
  const isCustom = DT.textCx !== null || DT.textCy !== null;
  posLabel.textContent = `Text: (${cx}, ${cy})mm${isCustom ? ' [custom]' : ''}`;
}

// ═══════════════════════════════════════════════════════════════
// SHAPE PICKER
// ═══════════════════════════════════════════════════════════════

function dtRenderShapePicker() {
  const container = document.getElementById('dtShapeGrid');
  if (!container) return;

  if (DT.shapes.length === 0) {
    container.innerHTML = '<div class="dt-empty" style="font-size:0.8rem;">No base plates uploaded yet. Click "Upload Base Plate" to add one.</div>';
    return;
  }

  container.innerHTML = DT.shapes.map(s => `
    <div class="dt-shape-btn ${s.id === DT.selectedShape ? 'selected' : ''}"
         data-shape="${s.id}" title="${s.label} (${s.geometry?.width || '?'}×${s.geometry?.height || '?'}mm)" style="position:relative;cursor:pointer;">
      <span class="dt-shape-btn-label">${s.label}</span>
      <span class="dt-shape-delete" data-delete="${s.id}" title="Remove this shape" style="position:absolute;top:1px;right:1px;color:var(--muted);cursor:pointer;font-size:0.6rem;padding:2px;">✕</span>
    </div>
  `).join('');

  container.querySelectorAll('.dt-shape-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      // Don't select if clicking delete button
      if (e.target.classList.contains('dt-shape-delete')) return;
      DT.selectedShape = btn.dataset.shape;
      DT.textCx = null;
      DT.textCy = null;
      DT.textSz = null;
      // Reset line positions
      DT.lines.forEach(l => { l.cx = null; l.cy = null; });
      dtRenderShapePicker();
      dtSyncSliders();
      if (!DT.stlCache[btn.dataset.shape]) {
        await dtLoadBlankStl(btn.dataset.shape);
      }
      dtBuildTag();
    });
  });

  // Delete shape buttons
  container.querySelectorAll('.dt-shape-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.delete;
      const confirmed = await window.printStation.showConfirm(`Remove "${id}" base plate?`, 'Remove Shape');
      if (!confirmed) return;
      await window.printStation.dogTag.deleteShape(id);
      delete DT.stlCache[id];
      // Reload shapes
      const data = await window.printStation.dogTag.getShapes();
      DT.shapes = data.shapes || [];
      DT.shapes.forEach(s => { if (s.geometry) DT.shapeGeo[s.id] = s.geometry; });
      if (DT.selectedShape === id) {
        DT.selectedShape = DT.shapes[0]?.id || '';
      }
      dtRenderShapePicker();
      dtBuildTag();
    });
  });
}

// ═══════════════════════════════════════════════════════════════
// GENERATE / SLICER / BATCH (unchanged logic)
// ═══════════════════════════════════════════════════════════════

async function dtGenerate() {
  // Check which mode we're in
  if (DT.mode === 'standaloneName') {
    return dtGenerateStandalone();
  }

  const line1 = DT.lines[0].text || DT.petName || '';
  if (!line1) {
    dtSetStatus('Enter a name first.', 'error');
    document.getElementById('dtLine1Text')?.focus();
    return;
  }
  DT.generating = true;
  dtSetStatus('Generating keychain files...', 'info');
  dtUpdateButtons();
  try {
    const colors = COLOR_PRESETS[DT.colorIdx] || COLOR_PRESETS[0];

    // Build lines array — resolve positions to match the preview exactly
    const geo = DT.shapeGeo[DT.selectedShape] || {};
    const lines = [];
    for (let i = 0; i < DT.lineCount; i++) {
      const ln = DT.lines[i];
      if (ln.text || (i === 0 && DT.petName)) {
        // Resolve positions same as dtBuildTextLines does
        const rcx = ln.cx !== null ? ln.cx : (i === 0 ? (DT.textCx !== null ? DT.textCx : (geo.textCx || 0)) : 0);
        const rcy = ln.cy !== null ? ln.cy : (i === 0 ? (DT.textCy !== null ? DT.textCy : (geo.textCy || 0)) : (geo.textCy || 0) - (geo.textSz || 7) * 1.5);
        const rsz = ln.fontSize !== null ? ln.fontSize : (i === 0 ? (DT.textSz !== null ? DT.textSz : (geo.textSz || 7)) : (geo.textSz || 7) * 0.7);

        lines.push({
          text: ln.text || (i === 0 ? DT.petName : ''),
          font: ln.font || 'Liberation Sans:style=Bold',
          fontSize: rsz,
          textXOffset: rcx,
          textYOffset: rcy,
        });
      }
    }

    const result = await window.printStation.dogTag.generate({
      name: lines[0]?.text || DT.petName,
      shape: DT.selectedShape,
      colors: { base: colors.baseLabel, insert: colors.insertLabel },
      textCx: DT.textCx,
      textCy: DT.textCy,
      textSz: DT.textSz,
      lines,
      lineCount: DT.lineCount,
    });
    DT.lastGenResult = result;
    const stlReady = result.status === 'ready_to_print';
    dtSetStatus(
      `Generated <strong>${result.petName}</strong> (${result.shape}). ` +
      (stlReady ? 'STLs ready.' : 'SCAD files created (install OpenSCAD for STL).'),
      stlReady ? 'success' : 'warning'
    );
    dtUpdateButtons();
    dtLoadHistory();
  } catch (e) {
    dtSetStatus(`Error: ${e.message || e}`, 'error');
  } finally {
    DT.generating = false;
    dtUpdateButtons();
  }
}

async function dtGenerateStandalone() {
  const text = DT.lines[0].text || DT.petName || '';
  if (!text) {
    dtSetStatus('Enter a name first.', 'error');
    document.getElementById('dtStandaloneText')?.focus();
    return;
  }
  DT.generating = true;
  dtSetStatus('Generating standalone name...', 'info');
  dtUpdateButtons();
  try {
    const result = await window.printStation.dogTag.generateStandalone({
      text,
      font: DT.lines[0].font || 'Liberation Sans:style=Bold',
      fontSize: DT.lines[0].fontSize || 10,
      thickness: DT.standaloneThickness,
      connectExpand: DT.standaloneConnectExpand,
    });
    DT.lastGenResult = result;
    const stlReady = result.status === 'ready_to_print';
    dtSetStatus(
      `Generated standalone <strong>${text}</strong>. ` +
      (stlReady ? 'STL ready.' : 'SCAD created (install OpenSCAD for STL).'),
      stlReady ? 'success' : 'warning'
    );
    dtUpdateButtons();
    dtLoadHistory();
  } catch (e) {
    dtSetStatus(`Error: ${e.message || e}`, 'error');
  } finally {
    DT.generating = false;
    dtUpdateButtons();
  }
}

async function dtSendToSlicer() {
  const r = DT.lastGenResult;
  if (!r) {
    dtSetStatus('No STL available. Generate first.', 'error');
    return;
  }

  // Handle standalone mode
  if (r.mode === 'standalone') {
    if (!r.files?.stl) {
      dtSetStatus('No STL available. Generate first.', 'error');
      return;
    }
    dtSetStatus('Uploading to STL library...', 'info');
    try {
      await window.printStation.dogTag.sendToSlicer({
        stlPath: r.files.stl,
        name: `${r.petName} - Standalone Name`,
        category: 'Keychains',
        folder: 'Standalone Names',
      });
      dtSetStatus(`Uploaded <strong>${r.petName}</strong> to STL library.`, 'success');
    } catch (e) {
      dtSetStatus(`Upload error: ${e.message || e}`, 'error');
    }
    return;
  }

  // Base plate mode
  if (!r.files?.baseStl) {
    dtSetStatus('No STL available. Generate first.', 'error');
    return;
  }

  dtSetStatus('Uploading to STL library...', 'info');
  try {
    // Build a readable shape label
    const shapeLabel = DT.shapes.find(s => s.id === r.shape)?.label || r.shape;

    // Upload base plate
    await window.printStation.dogTag.sendToSlicer({
      stlPath: r.files.baseStl,
      name: `${shapeLabel} Base - ${r.petName}`,
      category: 'Keychains',
      folder: shapeLabel,
    });

    // Upload all text inserts
    const inserts = r.files.textStls || (r.files.textStl ? [r.files.textStl] : []);
    for (let i = 0; i < inserts.length; i++) {
      const lineSuffix = inserts.length > 1 ? ` L${i + 1}` : '';
      await window.printStation.dogTag.sendToSlicer({
        stlPath: inserts[i],
        name: `${shapeLabel} Insert${lineSuffix} - ${r.petName}`,
        category: 'Keychains',
        folder: shapeLabel,
      });
    }

    const count = 1 + inserts.length;
    dtSetStatus(`Uploaded <strong>${r.petName}</strong> (${count} files) to STL library. Go to Slice & Print.`, 'success');
  } catch (e) {
    dtSetStatus(`Upload error: ${e.message || e}`, 'error');
  }
}

async function dtAddToBatch() {
  const line1 = DT.lines[0].text || DT.petName || '';
  if (!line1) {
    dtSetStatus('Enter a name first.', 'error');
    return;
  }
  const colors = COLOR_PRESETS[DT.colorIdx] || COLOR_PRESETS[0];

  // Build lines for batch storage — resolve positions to match preview
  const geo = DT.shapeGeo[DT.selectedShape] || {};
  const batchLines = [];
  for (let i = 0; i < DT.lineCount; i++) {
    const ln = DT.lines[i];
    if (ln.text || (i === 0 && DT.petName)) {
      const rcx = ln.cx !== null ? ln.cx : (i === 0 ? (DT.textCx !== null ? DT.textCx : (geo.textCx || 0)) : 0);
      const rcy = ln.cy !== null ? ln.cy : (i === 0 ? (DT.textCy !== null ? DT.textCy : (geo.textCy || 0)) : (geo.textCy || 0) - (geo.textSz || 7) * 1.5);
      const rsz = ln.fontSize !== null ? ln.fontSize : (i === 0 ? (DT.textSz !== null ? DT.textSz : (geo.textSz || 7)) : (geo.textSz || 7) * 0.7);
      batchLines.push({
        text: ln.text || (i === 0 ? DT.petName : ''),
        font: ln.font || 'Liberation Sans:style=Bold',
        fontSize: rsz,
        textXOffset: rcx,
        textYOffset: rcy,
      });
    }
  }

  try {
    const result = await window.printStation.dogTag.batchAdd({
      name: line1,
      shape: DT.selectedShape,
      colors: { base: colors.baseLabel, insert: colors.insertLabel },
      textCx: DT.textCx,
      textCy: DT.textCy,
      textSz: DT.textSz,
      lines: batchLines,
      lineCount: DT.lineCount,
    });
    DT.batchQueue = result.queue;
    dtRenderBatch();
    dtSetStatus(`Added <strong>${line1}</strong> to batch (${DT.batchQueue.length} items).`, 'success');
  } catch (e) {
    dtSetStatus(`Batch error: ${e.message || e}`, 'error');
  }
}

async function dtBatchGenerateAll() {
  if (!DT.batchQueue.length) return;
  dtSetStatus(`Generating ${DT.batchQueue.length} tags...`, 'info');
  try {
    const result = await window.printStation.dogTag.batchGenerateAll();
    DT.batchQueue = [];
    dtRenderBatch();
    dtSetStatus(`Generated ${result.count} tags. STLs are in the queue folder.`, 'success');
    dtLoadHistory();
  } catch (e) {
    dtSetStatus(`Batch generate error: ${e.message || e}`, 'error');
  }
}

async function dtBatchRemove(id) {
  try {
    const result = await window.printStation.dogTag.batchRemove(id);
    DT.batchQueue = result.queue;
    dtRenderBatch();
  } catch (_) {}
}

async function dtBatchClear() {
  try {
    await window.printStation.dogTag.batchClear();
    DT.batchQueue = [];
    dtRenderBatch();
  } catch (_) {}
}

// ═══════════════════════════════════════════════════════════════
// BATCH / HISTORY PANELS
// ═══════════════════════════════════════════════════════════════

function dtRenderBatch() {
  const container = document.getElementById('dtBatchList');
  const countEl = document.getElementById('dtBatchCount');
  if (!container) return;
  if (countEl) countEl.textContent = DT.batchQueue.length || '';
  if (!DT.batchQueue.length) {
    container.innerHTML = '<div class="dt-empty">Queue empty. Use "+ Add to Batch".</div>';
    return;
  }
  container.innerHTML = DT.batchQueue.map(item => `
    <div class="dt-batch-item">
      <div class="dt-batch-info">
        <strong>${item.name}</strong>
        <small>${item.shape}${item.textCx !== null ? ' [custom pos]' : ''}</small>
      </div>
      <button class="dt-batch-remove" data-id="${item.id}" title="Remove">&times;</button>
    </div>
  `).join('');
  container.querySelectorAll('.dt-batch-remove').forEach(btn => {
    btn.addEventListener('click', () => dtBatchRemove(btn.dataset.id));
  });
}

async function dtLoadHistory() {
  try {
    const data = await window.printStation.dogTag.getHistory();
    DT.history = (data.jobs || []).slice(0, 20);
    dtRenderHistory();
  } catch (_) {}
}

function dtRenderHistory() {
  const container = document.getElementById('dtHistoryList');
  if (!container) return;
  if (!DT.history.length) {
    container.innerHTML = '<div class="dt-empty">No keychains generated yet.</div>';
    return;
  }
  container.innerHTML = DT.history.map(job => {
    const date = job.timestamp ? new Date(job.timestamp).toLocaleDateString() : '';
    return `
      <div class="dt-history-item">
        <div class="dt-history-info">
          <strong>${job.name}</strong>
          <small>${job.shape} &middot; ${date}</small>
        </div>
        <button class="dt-history-open" data-job="${job.jobId}" title="Open folder">Open</button>
      </div>
    `;
  }).join('');
  container.querySelectorAll('.dt-history-open').forEach(btn => {
    btn.addEventListener('click', () => window.printStation.dogTag.openOutput(btn.dataset.job));
  });
}

// ═══════════════════════════════════════════════════════════════
// UI HELPERS
// ═══════════════════════════════════════════════════════════════

function dtSetStatus(html, type) {
  const el = document.getElementById('dtStatus');
  if (!el) return;
  el.innerHTML = html;
  el.className = 'dt-status ' + (type || '');
}

function dtUpdateButtons() {
  const genBtn = document.getElementById('dtGenerateBtn');
  const slicerBtn = document.getElementById('dtSendToSlicerBtn');
  if (genBtn) {
    genBtn.disabled = DT.generating;
    genBtn.textContent = DT.generating ? 'Generating...' : 'Generate Keychain';
  }
  if (slicerBtn) {
    const hasStl = DT.lastGenResult?.files?.baseStl;
    slicerBtn.disabled = !hasStl;
    slicerBtn.title = hasStl ? 'Upload STLs to slicer catalog' : 'Generate a tag with OpenSCAD first';
  }
}

function dtResetTextPos() {
  DT.textCx = null;
  DT.textCy = null;
  DT.textSz = null;
  dtSyncSliders();
  dtBuildTag();
}

// Sync slider UI with current DT state
function dtSyncSliders() {
  // Sync per-line size sliders
  for (let i = 0; i < 2; i++) {
    const n = i + 1;
    const sizeSlider = document.getElementById(`dtLine${n}Size`);
    const sizeVal = document.getElementById(`dtLine${n}SizeVal`);
    if (sizeSlider && sizeVal) {
      const geo = DT.shapeGeo[DT.selectedShape] || {};
      const sz = DT.lines[i].fontSize !== null ? DT.lines[i].fontSize : (geo.textSz || 7);
      sizeSlider.value = sz;
      sizeVal.textContent = DT.lines[i].fontSize !== null ? sz.toFixed(1) : 'auto';
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════

async function initDogTagsView() {
  if (DT.initialized) {
    dtLoadHistory();
    dtLoadBatch();
    // Re-setup scene if container was detached
    if (!DT.renderer || !DT.container?.isConnected) {
      dtSetupScene();
    }
    return;
  }

  // Load shapes + geometry from backend
  try {
    const data = await window.printStation.dogTag.getShapes();
    DT.shapes = data.shapes || [];
    DT.defaults = data.defaults || {};
    DT.tagsDir = data.tagsDir || null;
    DT.fonts = data.fonts || [];
    DT.shapes.forEach(s => {
      if (s.geometry) DT.shapeGeo[s.id] = s.geometry;
    });
    // Preload blank STLs for shapes that have them
    dtPreloadBlanks();
  } catch (e) {
    console.error('[DogTag] Failed to load shapes:', e);
  }

  // Check openscad
  try {
    const check = await window.printStation.dogTag.checkOpenscad();
    DT.openscadAvailable = check.available;
  } catch (_) {}

  const oscadNote = document.getElementById('dtOpenscadNote');
  if (oscadNote) oscadNote.style.display = DT.openscadAvailable ? 'none' : 'block';

  // ── Populate font dropdowns ──
  function populateFontDropdown(selectEl) {
    if (!selectEl) return;
    selectEl.innerHTML = '';
    (DT.fonts || []).forEach(f => {
      const opt = document.createElement('option');
      opt.value = f.value;
      opt.textContent = f.label;
      opt.dataset.category = f.category;
      selectEl.appendChild(opt);
    });
  }
  populateFontDropdown(document.getElementById('dtLine1Font'));
  populateFontDropdown(document.getElementById('dtLine2Font'));
  populateFontDropdown(document.getElementById('dtStandaloneFont'));

  // ── Mode toggle (Base Plate / Standalone Name) ──
  function dtSetMode(mode) {
    DT.mode = mode;
    document.getElementById('dtModeBasePlate')?.classList.toggle('active', mode === 'basePlate');
    document.getElementById('dtModeStandalone')?.classList.toggle('active', mode === 'standaloneName');
    const bp = document.getElementById('dtBasePlateControls');
    const sa = document.getElementById('dtStandaloneControls');
    if (bp) bp.style.display = mode === 'basePlate' ? '' : 'none';
    if (sa) sa.style.display = mode === 'standaloneName' ? '' : 'none';
    dtBuildTag();
  }
  document.getElementById('dtModeBasePlate')?.addEventListener('click', () => dtSetMode('basePlate'));
  document.getElementById('dtModeStandalone')?.addEventListener('click', () => dtSetMode('standaloneName'));

  // ── Line count toggle ──
  function dtSetLineCount(n) {
    DT.lineCount = n;
    document.getElementById('dtLineCount1')?.classList.toggle('active', n === 1);
    document.getElementById('dtLineCount2')?.classList.toggle('active', n === 2);
    const l2 = document.getElementById('dtLine2Controls');
    if (l2) l2.style.display = n === 2 ? '' : 'none';
    dtBuildTag();
  }
  document.getElementById('dtLineCount1')?.addEventListener('click', () => dtSetLineCount(1));
  document.getElementById('dtLineCount2')?.addEventListener('click', () => dtSetLineCount(2));

  // ── Per-line text input + font + size ──
  function setupLineControls(idx) {
    const n = idx + 1;
    const textInput = document.getElementById(`dtLine${n}Text`);
    const fontSelect = document.getElementById(`dtLine${n}Font`);
    const sizeSlider = document.getElementById(`dtLine${n}Size`);
    const sizeVal = document.getElementById(`dtLine${n}SizeVal`);

    if (textInput) {
      textInput.addEventListener('input', () => {
        DT.lines[idx].text = textInput.value.trim().toUpperCase().replace(/[^A-Z0-9\s]/g, '').slice(0, 20);
        // Keep backward compat
        if (idx === 0) DT.petName = DT.lines[0].text;
        dtBuildTag();
      });
      textInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') dtGenerate(); });
    }

    if (fontSelect) {
      fontSelect.addEventListener('change', () => {
        DT.lines[idx].font = fontSelect.value;
        dtBuildTag();
      });
    }

    if (sizeSlider) {
      sizeSlider.addEventListener('input', () => {
        DT.lines[idx].fontSize = parseFloat(sizeSlider.value);
        if (sizeVal) sizeVal.textContent = DT.lines[idx].fontSize.toFixed(1);
        // Keep backward compat for line 1
        if (idx === 0) DT.textSz = DT.lines[0].fontSize;
        dtBuildTag();
      });
    }
  }
  setupLineControls(0);
  setupLineControls(1);

  // ── Standalone controls ──
  const saText = document.getElementById('dtStandaloneText');
  if (saText) {
    saText.addEventListener('input', () => {
      DT.lines[0].text = saText.value.trim().toUpperCase().replace(/[^A-Z0-9\s]/g, '').slice(0, 20);
      DT.petName = DT.lines[0].text;
      dtBuildTag();
    });
  }
  const saFont = document.getElementById('dtStandaloneFont');
  if (saFont) {
    saFont.addEventListener('change', () => {
      DT.lines[0].font = saFont.value;
      // Auto-set connect expand based on font category
      const fontData = (DT.fonts || []).find(f => f.value === saFont.value);
      if (fontData) {
        DT.standaloneConnectExpand = fontData.category === 'script' ? 0 : 0.3;
        const connSlider = document.getElementById('dtStandaloneConnect');
        const connVal = document.getElementById('dtStandaloneConnectVal');
        if (connSlider) connSlider.value = DT.standaloneConnectExpand;
        if (connVal) connVal.textContent = DT.standaloneConnectExpand.toFixed(2);
      }
      dtBuildTag();
    });
  }
  const saSize = document.getElementById('dtStandaloneSize');
  if (saSize) {
    saSize.addEventListener('input', () => {
      DT.lines[0].fontSize = parseFloat(saSize.value);
      const v = document.getElementById('dtStandaloneSizeVal');
      if (v) v.textContent = DT.lines[0].fontSize.toFixed(1);
      dtBuildTag();
    });
  }
  const saThick = document.getElementById('dtStandaloneThickness');
  if (saThick) {
    saThick.addEventListener('input', () => {
      DT.standaloneThickness = parseFloat(saThick.value);
      const v = document.getElementById('dtStandaloneThicknessVal');
      if (v) v.textContent = DT.standaloneThickness.toFixed(1);
      dtBuildTag();
    });
  }
  const saConn = document.getElementById('dtStandaloneConnect');
  if (saConn) {
    saConn.addEventListener('input', () => {
      DT.standaloneConnectExpand = parseFloat(saConn.value);
      const v = document.getElementById('dtStandaloneConnectVal');
      if (v) v.textContent = DT.standaloneConnectExpand.toFixed(2);
      dtBuildTag();
    });
  }

  // Color select
  const colorSelect = document.getElementById('dtColorPreset');
  if (colorSelect) {
    colorSelect.addEventListener('change', () => {
      DT.colorIdx = colorSelect.selectedIndex;
      dtBuildTag();
    });
  }

  // Buttons
  document.getElementById('dtGenerateBtn')?.addEventListener('click', dtGenerate);
  document.getElementById('dtSendToSlicerBtn')?.addEventListener('click', dtSendToSlicer);
  document.getElementById('dtAddBatchBtn')?.addEventListener('click', dtAddToBatch);
  document.getElementById('dtBatchGenerateBtn')?.addEventListener('click', dtBatchGenerateAll);
  document.getElementById('dtBatchClearBtn')?.addEventListener('click', dtBatchClear);
  document.getElementById('dtResetPosBtn')?.addEventListener('click', dtResetTextPos);
  document.getElementById('dtOpenTagsFolderBtn')?.addEventListener('click', () => {
    window.printStation.dogTag.openTagsFolder();
  });
  document.getElementById('dtImportBlankBtn')?.addEventListener('click', async () => {
    // Import one or more STL files as new base plate shapes (no pre-selected shape needed)
    const result = await window.printStation.dogTag.importBlank(null);
    if (result && result.imported) {
      const names = (result.shapes || []).map(s => s.label).join(', ');
      dtSetStatus(`Imported ${result.count} base plate(s): ${names}`, 'success');
      // Reload shapes
      const data = await window.printStation.dogTag.getShapes();
      DT.shapes = data.shapes || [];
      DT.shapes.forEach(s => { if (s.geometry) DT.shapeGeo[s.id] = s.geometry; });
      // Select the first newly imported shape
      if (result.shapes?.[0]) {
        DT.selectedShape = result.shapes[0].id;
        await dtLoadBlankStl(DT.selectedShape);
      }
      dtRenderShapePicker();
      dtBuildTag();
    }
  });

  // Select first available shape if current selection doesn't exist
  if (DT.shapes.length > 0 && !DT.shapes.find(s => s.id === DT.selectedShape)) {
    DT.selectedShape = DT.shapes[0].id;
  }

  // Render
  dtRenderShapePicker();
  dtSyncSliders();
  dtLoadHistory();
  dtLoadBatch();

  // Setup Three.js scene, then build initial tag after blanks load
  setTimeout(async () => {
    dtSetupScene();
    // Wait for selected shape's STL to load before building
    if (DT.selectedShape && !DT.stlCache[DT.selectedShape]) {
      await dtLoadBlankStl(DT.selectedShape);
    }
    dtBuildTag();
  }, 100);

  DT.initialized = true;
}

async function dtLoadBatch() {
  try {
    DT.batchQueue = await window.printStation.dogTag.batchList();
    dtRenderBatch();
  } catch (_) {}
}

window.initDogTagsView = initDogTagsView;
