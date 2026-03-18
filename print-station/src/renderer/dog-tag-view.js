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
  selectedShape: 'bone',
  petName: '',
  colorIdx: 0,
  textCx: null,
  textCy: null,
  textSz: null,
  dragging: false,
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
  textMesh: null,
  raycaster: null,
  mouse: new (typeof THREE !== 'undefined' ? THREE.Vector2 : Object)(),
  tagTopPlane: null,
  container: null,
  // v2: STL blank geometry cache { shapeId: THREE.BufferGeometry }
  stlCache: {},
  tagsDir: null,
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
// THREE.JS SHAPE PROFILES — fallback when no blank STL exists
// ═══════════════════════════════════════════════════════════════

function dtCreateShapeProfile(shapeId) {
  switch (shapeId) {
    case 'bone': return dtBoneProfile();
    case 'shield': return dtShieldProfile();
    case 'heart': return dtHeartProfile();
    case 'paw': return dtPawProfile();
    case 'hydrant': return dtHydrantProfile();
    case 'star': return dtStarProfile();
    default: return dtBoneProfile();
  }
}

function dtBoneProfile() {
  // Bone: rounded-rect shaft + 8 knob circles at ends (matching OpenSCAD)
  // We trace the outer boundary by sampling the union of all circles
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
// TEXT TEXTURE — render pet name to a canvas, use as texture
// ═══════════════════════════════════════════════════════════════

function dtCreateTextTexture(text, fontSize, color) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const font = `bold ${fontSize * 10}px "Arial", "Helvetica", sans-serif`;
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

  const colors = COLOR_PRESETS[DT.colorIdx] || COLOR_PRESETS[0];
  const geo = DT.shapeGeo[DT.selectedShape];
  if (!geo) return;

  const baseColor = new THREE.Color(colors.base);
  const insertColor = new THREE.Color(colors.insert);

  const ringX = geo.ringX;
  const ringY = geo.ringY;
  const thickness = geo.thickness || TAG_THICKNESS;

  const bodyMat = new THREE.MeshPhysicalMaterial({
    color: baseColor,
    roughness: 0.35,
    metalness: 0.0,
    clearcoat: 0.2,
    clearcoatRoughness: 0.4,
  });

  // ── Tag body: use STL blank if cached, otherwise fallback to shape profile ──
  const stlGeo = DT.stlCache[DT.selectedShape];
  if (stlGeo) {
    // Use the actual blank STL geometry
    const bodyMesh = new THREE.Mesh(stlGeo.clone(), bodyMat);
    bodyMesh.castShadow = true;
    bodyMesh.receiveShadow = true;
    bodyMesh.name = 'tagBody';
    DT.tagGroup.add(bodyMesh);
  } else {
    // Fallback: extruded 2D profile
    const profile = dtCreateShapeProfile(DT.selectedShape);
    const holePath = new THREE.Path();
    holePath.absarc(ringX, ringY, RING_HOLE_DIA / 2, 0, Math.PI * 2, true);
    profile.holes.push(holePath);

    const extrudeSettings = {
      depth: thickness,
      bevelEnabled: true,
      bevelThickness: BEVEL_SIZE,
      bevelSize: BEVEL_SIZE,
      bevelSegments: BEVEL_SEGMENTS,
      curveSegments: 32,
    };

    const bodyGeo = new THREE.ExtrudeGeometry(profile, extrudeSettings);
    const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
    bodyMesh.castShadow = true;
    bodyMesh.receiveShadow = true;
    bodyMesh.name = 'tagBody';
    DT.tagGroup.add(bodyMesh);

    // Ring tab (only for fallback mode — STL blanks include tabs already)
    const needsTab = geo.needsTab || ['paw', 'star', 'hydrant', 'shield'].includes(DT.selectedShape);
    if (needsTab) {
      const tabProfile = new THREE.Shape();
      tabProfile.absarc(0, 0, 5, 0, Math.PI * 2, false);
      const tabHole = new THREE.Path();
      tabHole.absarc(0, 0, RING_HOLE_DIA / 2, 0, Math.PI * 2, true);
      tabProfile.holes.push(tabHole);
      const tabGeo = new THREE.ExtrudeGeometry(tabProfile, {
        depth: thickness,
        bevelEnabled: true,
        bevelThickness: BEVEL_SIZE * 0.7,
        bevelSize: BEVEL_SIZE * 0.7,
        bevelSegments: 2,
        curveSegments: 24,
      });
      const tabMesh = new THREE.Mesh(tabGeo, bodyMat.clone());
      tabMesh.position.set(ringX, ringY, 0);
      tabMesh.castShadow = true;
      tabMesh.name = 'ringTab';
      DT.tagGroup.add(tabMesh);
    }
  }

  // ── Split ring (decorative) ──
  const ringGeo = new THREE.TorusGeometry(4, 0.6, 8, 32);
  const ringMat = new THREE.MeshPhysicalMaterial({
    color: 0xcccccc,
    roughness: 0.2,
    metalness: 0.8,
  });
  const ringMesh = new THREE.Mesh(ringGeo, ringMat);
  ringMesh.position.set(ringX, ringY, thickness / 2);
  ringMesh.rotation.x = Math.PI / 2;
  ringMesh.castShadow = true;
  ringMesh.name = 'splitRing';
  DT.tagGroup.add(ringMesh);

  // ── Paw print decoration ──
  if (DT.selectedShape === 'paw') {
    dtAddPawDecoration(DT.tagGroup, baseColor);
  }

  // ── Text pocket + insert ──
  dtBuildTextInsert(geo, insertColor);

  // ── Position readout ──
  dtUpdatePosReadout();
}

function dtBuildTextInsert(geo, insertColor) {
  const name = DT.petName || '';
  if (!name) return;

  const tcx = DT.textCx !== null ? DT.textCx : geo.textCx;
  const tcy = DT.textCy !== null ? DT.textCy : geo.textCy;
  const tsz = DT.textSz !== null ? DT.textSz : geo.textSz;

  // Render text to texture
  const textData = dtCreateTextTexture(name, tsz, '#ffffff');
  const { texture, width: tw, height: th } = textData;

  // Pocket: slightly recessed darker area on tag top
  const pocketPad = 1.5;
  const pocketW = tw + pocketPad * 2;
  const pocketH = th + pocketPad * 2;
  const pocketGeo = new THREE.BoxGeometry(pocketW, pocketH, POCKET_DEPTH);
  const colors = COLOR_PRESETS[DT.colorIdx] || COLOR_PRESETS[0];
  const pocketMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(colors.base).multiplyScalar(0.85),
    roughness: 0.5,
    metalness: 0,
  });
  const pocketMesh = new THREE.Mesh(pocketGeo, pocketMat);
  pocketMesh.position.set(tcx, tcy, TAG_THICKNESS - POCKET_DEPTH / 2 + 0.01);
  pocketMesh.name = 'pocket';
  DT.tagGroup.add(pocketMesh);

  // Insert slab: colored block that sits in the pocket
  const insertGeo = new THREE.BoxGeometry(tw + 0.5, th + 0.5, INSERT_HEIGHT);
  const insertMat = new THREE.MeshPhysicalMaterial({
    color: insertColor,
    roughness: 0.3,
    metalness: 0,
    clearcoat: 0.15,
  });
  const insertMesh = new THREE.Mesh(insertGeo, insertMat);
  insertMesh.position.set(tcx, tcy, TAG_THICKNESS - POCKET_DEPTH + INSERT_HEIGHT / 2 + 0.01);
  insertMesh.name = 'insert';
  DT.tagGroup.add(insertMesh);

  // Text label on top of insert
  const labelGeo = new THREE.PlaneGeometry(tw, th);
  const labelMat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
  });
  const labelMesh = new THREE.Mesh(labelGeo, labelMat);
  labelMesh.position.set(tcx, tcy, TAG_THICKNESS - POCKET_DEPTH + INSERT_HEIGHT + 0.05);
  labelMesh.name = 'textLabel';
  DT.tagGroup.add(labelMesh);

  // Store reference for dragging
  DT.textMesh = { pocket: pocketMesh, insert: insertMesh, label: labelMesh, width: tw, height: th };
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

function dtIsOverText3D(mm) {
  if (!DT.textMesh || !DT.petName || !mm) return false;
  const geo = DT.shapeGeo[DT.selectedShape];
  if (!geo) return false;
  const tcx = DT.textCx !== null ? DT.textCx : geo.textCx;
  const tcy = DT.textCy !== null ? DT.textCy : geo.textCy;
  const tw = DT.textMesh.width;
  const th = DT.textMesh.height;
  return Math.abs(mm.x - tcx) < tw / 2 + 3 && Math.abs(mm.y - tcy) < th / 2 + 3;
}

function dtOnMouseDown3D(e) {
  const mm = dtGetMouseMm(e);
  if (dtIsOverText3D(mm)) {
    const geo = DT.shapeGeo[DT.selectedShape];
    const tcx = DT.textCx !== null ? DT.textCx : geo.textCx;
    const tcy = DT.textCy !== null ? DT.textCy : geo.textCy;
    DT.dragging = true;
    DT.dragOffset = { x: mm.x - tcx, y: mm.y - tcy };
    if (DT.controls) DT.controls.enabled = false; // disable orbit while dragging
    DT.renderer.domElement.style.cursor = 'grabbing';
  }
}

function dtOnMouseMove3D(e) {
  const mm = dtGetMouseMm(e);
  if (!mm) return;

  if (DT.dragging && DT.dragOffset) {
    DT.textCx = parseFloat((mm.x - DT.dragOffset.x).toFixed(1));
    DT.textCy = parseFloat((mm.y - DT.dragOffset.y).toFixed(1));
    // Update text position without full rebuild
    dtUpdateTextPosition();
    dtUpdatePosReadout();
  } else {
    DT.renderer.domElement.style.cursor = dtIsOverText3D(mm) ? 'grab' : 'default';
  }
}

function dtOnMouseUp3D() {
  if (DT.dragging) {
    DT.dragging = false;
    DT.dragOffset = null;
    if (DT.controls) DT.controls.enabled = true;
    if (DT.renderer) DT.renderer.domElement.style.cursor = 'default';
  }
}

function dtUpdateTextPosition() {
  if (!DT.textMesh) return;
  const geo = DT.shapeGeo[DT.selectedShape];
  if (!geo) return;
  const tcx = DT.textCx !== null ? DT.textCx : geo.textCx;
  const tcy = DT.textCy !== null ? DT.textCy : geo.textCy;

  DT.textMesh.pocket.position.x = tcx;
  DT.textMesh.pocket.position.y = tcy;
  DT.textMesh.insert.position.x = tcx;
  DT.textMesh.insert.position.y = tcy;
  DT.textMesh.label.position.x = tcx;
  DT.textMesh.label.position.y = tcy;
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

  container.innerHTML = DT.shapes.map(s => `
    <button class="dt-shape-btn ${s.id === DT.selectedShape ? 'selected' : ''}"
            data-shape="${s.id}" title="${s.desc}${s.hasBlankStl ? ' (Custom STL)' : ' (Built-in)'}">
      <span class="dt-shape-btn-label">${s.label}</span>
      ${s.hasBlankStl ? '<span class="dt-stl-badge">STL</span>' : ''}
    </button>
  `).join('');

  container.querySelectorAll('.dt-shape-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      DT.selectedShape = btn.dataset.shape;
      DT.textCx = null;
      DT.textCy = null;
      DT.textSz = null;
      dtRenderShapePicker();
      // Load blank STL if not cached yet
      const shapeInfo = DT.shapes.find(s => s.id === btn.dataset.shape);
      if (shapeInfo && shapeInfo.hasBlankStl && !DT.stlCache[btn.dataset.shape]) {
        await dtLoadBlankStl(btn.dataset.shape);
      }
      dtBuildTag();
    });
  });
}

// ═══════════════════════════════════════════════════════════════
// GENERATE / SLICER / BATCH (unchanged logic)
// ═══════════════════════════════════════════════════════════════

async function dtGenerate() {
  if (!DT.petName) {
    dtSetStatus('Enter a pet name first.', 'error');
    document.getElementById('dtPetName')?.focus();
    return;
  }
  DT.generating = true;
  dtSetStatus('Generating tag files...', 'info');
  dtUpdateButtons();
  try {
    const colors = COLOR_PRESETS[DT.colorIdx] || COLOR_PRESETS[0];
    const result = await window.printStation.dogTag.generate({
      name: DT.petName,
      shape: DT.selectedShape,
      colors: { base: colors.baseLabel, insert: colors.insertLabel },
      textCx: DT.textCx,
      textCy: DT.textCy,
      textSz: DT.textSz,
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

async function dtSendToSlicer() {
  if (!DT.lastGenResult?.files?.baseStl) {
    dtSetStatus('No STL available. Generate first (requires OpenSCAD).', 'error');
    return;
  }
  dtSetStatus('Uploading to slicer catalog...', 'info');
  try {
    const r = DT.lastGenResult;
    await window.printStation.dogTag.sendToSlicer({
      stlPath: r.files.baseStl,
      name: `Dog Tag Base - ${r.shape} - ${r.petName}`,
      category: 'Dog Tags',
    });
    await window.printStation.dogTag.sendToSlicer({
      stlPath: r.files.textStl,
      name: `Dog Tag Text - ${r.shape} - ${r.petName}`,
      category: 'Dog Tags',
    });
    dtSetStatus(`Uploaded to slicer: <strong>${r.petName}</strong> base + text. Go to Slice & Print to print.`, 'success');
  } catch (e) {
    dtSetStatus(`Slicer upload error: ${e.message || e}`, 'error');
  }
}

async function dtAddToBatch() {
  if (!DT.petName) {
    dtSetStatus('Enter a pet name first.', 'error');
    return;
  }
  const colors = COLOR_PRESETS[DT.colorIdx] || COLOR_PRESETS[0];
  try {
    const result = await window.printStation.dogTag.batchAdd({
      name: DT.petName,
      shape: DT.selectedShape,
      colors: { base: colors.baseLabel, insert: colors.insertLabel },
      textCx: DT.textCx,
      textCy: DT.textCy,
      textSz: DT.textSz,
    });
    DT.batchQueue = result.queue;
    dtRenderBatch();
    dtSetStatus(`Added <strong>${DT.petName}</strong> to batch (${DT.batchQueue.length} tags).`, 'success');
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
    container.innerHTML = '<div class="dt-empty">No tags generated yet.</div>';
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
    genBtn.textContent = DT.generating ? 'Generating...' : 'Generate Tag';
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
  dtBuildTag();
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

  // Name input
  const nameInput = document.getElementById('dtPetName');
  if (nameInput) {
    nameInput.addEventListener('input', () => {
      DT.petName = nameInput.value.trim().toUpperCase().replace(/[^A-Z0-9\s]/g, '').slice(0, 12);
      dtBuildTag();
    });
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') dtGenerate();
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
    const result = await window.printStation.dogTag.importBlank(DT.selectedShape);
    if (result && result.imported) {
      dtSetStatus(`Imported blank STL for "${DT.selectedShape}". Reloading shapes...`, 'success');
      // Invalidate cache and reload
      delete DT.stlCache[DT.selectedShape];
      const data = await window.printStation.dogTag.getShapes();
      DT.shapes = data.shapes || [];
      DT.shapes.forEach(s => { if (s.geometry) DT.shapeGeo[s.id] = s.geometry; });
      await dtLoadBlankStl(DT.selectedShape);
      dtRenderShapePicker();
      dtBuildTag();
    }
  });

  // Render
  dtRenderShapePicker();
  dtLoadHistory();
  dtLoadBatch();

  // Setup Three.js scene (slight delay to ensure container has dimensions)
  setTimeout(() => dtSetupScene(), 50);

  DT.initialized = true;
}

async function dtLoadBatch() {
  try {
    DT.batchQueue = await window.printStation.dogTag.batchList();
    dtRenderBatch();
  } catch (_) {}
}

window.initDogTagsView = initDogTagsView;
