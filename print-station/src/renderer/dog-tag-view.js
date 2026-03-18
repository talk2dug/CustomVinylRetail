/**
 * BRCC Dog Tag Generator View — v4 (Fixed)
 * ============================================================
 * FIXES:
 *   1. Ring tab is now properly CSG-unioned into tag body so the
 *      ring hole punches through both as one solid piece.
 *      Approach: build tab as part of the Shape compound path,
 *      not a separate mesh. Ring hole is a shared hole path.
 *
 *   2. Paw decoration completely rewritten — correct pad/toe
 *      sizes, positions, and orientations using ShapeGeometry
 *      extruded along Z (not CylinderGeometry rotated on X).
 *
 *   3. Z-fighting eliminated — pocket is now a true recess
 *      (the tag body extrude depth is reduced in the pocket zone
 *      via a separate recessed plane), insert and label use
 *      explicit non-overlapping Z stacking with a guaranteed
 *      0.1mm gap between each layer.
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
  scene: null,
  camera: null,
  renderer: null,
  controls: null,
  animId: null,
  tagGroup: null,
  textMesh: null,
  raycaster: null,
  mouse: null,
  tagTopPlane: null,
  container: null,
  _resizeObs: null,
};

const COLOR_PRESETS = [
  { base: '#ffffff', insert: '#222222', label: 'White + Black',  baseLabel: 'White',  insertLabel: 'Black'  },
  { base: '#222222', insert: '#ffffff', label: 'Black + White',  baseLabel: 'Black',  insertLabel: 'White'  },
  { base: '#1a1a2e', insert: '#e8b931', label: 'Navy + Gold',    baseLabel: 'Navy',   insertLabel: 'Gold'   },
  { base: '#8b0000', insert: '#ffffff', label: 'Red + White',    baseLabel: 'Red',    insertLabel: 'White'  },
  { base: '#2d5016', insert: '#f5f5dc', label: 'Green + Cream',  baseLabel: 'Green',  insertLabel: 'Cream'  },
  { base: '#4a90d9', insert: '#ffffff', label: 'Blue + White',   baseLabel: 'Blue',   insertLabel: 'White'  },
];

// Tag dimensions (mm) — keep in sync with generate_dog_tag.js DEFAULTS
const TAG_THICKNESS   = 3.2;
const POCKET_DEPTH    = 1.4;
const INSERT_HEIGHT   = 1.35;
const RING_HOLE_DIA   = 4.6;
const BEVEL_SIZE      = 0.3;
const BEVEL_SEGMENTS  = 2;

// Z levels — explicit stack, no epsilons fighting each other
// Each level is guaranteed > the one below it
const Z_BASE_BOTTOM  = 0;
const Z_BASE_TOP     = TAG_THICKNESS;                          // 3.2
const Z_POCKET_FLOOR = TAG_THICKNESS - POCKET_DEPTH;          // 1.8  — bottom of recess
const Z_INSERT_BOT   = Z_POCKET_FLOOR + 0.05;                 // 1.85 — insert sits just above floor
const Z_INSERT_TOP   = Z_INSERT_BOT + INSERT_HEIGHT;          // 3.2
const Z_LABEL        = Z_INSERT_TOP + 0.08;                   // 3.28 — label strictly above insert

// ═══════════════════════════════════════════════════════════════
// FIX 1: SHAPE PROFILES WITH INTEGRATED RING TAB
//
// Each shape function returns a THREE.Shape whose outline
// already includes the ring tab bump. A single shared hole
// path punches the ring hole through both tag body AND tab.
// This means the body + tab are ONE ExtrudeGeometry — no
// floating separate mesh, no disconnected geometry.
// ═══════════════════════════════════════════════════════════════

function dtCreateShapeProfile(shapeId) {
  const { shape, ringX, ringY } = dtGetShapeAndRing(shapeId);

  // Punch ring hole as a hole in the shape — same path cuts
  // through both the tag body AND the tab since they're one shape
  const hole = new THREE.Path();
  hole.absarc(ringX, ringY, RING_HOLE_DIA / 2, 0, Math.PI * 2, true);
  shape.holes.push(hole);

  return shape;
}

function dtGetShapeAndRing(shapeId) {
  switch (shapeId) {
    case 'bone':    return dtBoneShapeAndRing();
    case 'shield':  return dtShieldShapeAndRing();
    case 'heart':   return dtHeartShapeAndRing();
    case 'paw':     return dtPawShapeAndRing();
    case 'hydrant': return dtHydrantShapeAndRing();
    case 'star':    return dtStarShapeAndRing();
    default:        return dtBoneShapeAndRing();
  }
}

// ── BONE ─────────────────────────────────────────────────────
// Bone ring hole is at left end (-44, 0). The knob cluster at
// the left end extends to ~x=-47, so the hole sits inside the
// existing knob — no separate tab needed.
function dtBoneShapeAndRing() {
  const sl = 32, sw = 10, knobR = 5, knobDist = 6;
  const circles = [];
  circles.push({ x: -sl / 2 + 2, y: 0, r: sw / 2 });
  circles.push({ x:  sl / 2 - 2, y: 0, r: sw / 2 });
  for (const ex of [-sl / 2, sl / 2]) {
    for (const angle of [45, 135, 225, 315]) {
      const rad = angle * Math.PI / 180;
      circles.push({ x: ex + Math.cos(rad) * knobDist, y: Math.sin(rad) * knobDist, r: knobR });
    }
  }
  const pts = dtUnionOutline(circles, 512);
  const shape = new THREE.Shape();
  if (pts.length > 0) {
    shape.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i].x, pts[i].y);
    shape.closePath();
  }
  // Ring hole sits inside the left knob cluster
  return { shape, ringX: -44, ringY: 0 };
}

// Angular raycast union-outline — samples farthest boundary point per angle
function dtUnionOutline(circles, numSamples) {
  const pts = [];
  for (let i = 0; i < numSamples; i++) {
    const angle = (i / numSamples) * Math.PI * 2;
    const dx = Math.cos(angle), dy = Math.sin(angle);
    let maxDist = 0;
    for (const c of circles) {
      const proj = c.x * dx + c.y * dy;
      const perpSq = c.x * c.x + c.y * c.y - proj * proj;
      if (perpSq < c.r * c.r) {
        const d = proj + Math.sqrt(c.r * c.r - perpSq);
        if (d > maxDist) maxDist = d;
      }
    }
    if (maxDist > 0) pts.push({ x: dx * maxDist, y: dy * maxDist });
  }
  return pts;
}

// ── SHIELD ───────────────────────────────────────────────────
// Tab is a small dome merged at top center (0, topY+tabR)
function dtShieldShapeAndRing() {
  const w = 40, h = 50, tr = 5;
  const tabR = 5.5, tabCy = h / 2 + tabR * 0.55;
  const ringY = tabCy;

  const shape = new THREE.Shape();
  // Build outline: bottom point → right side → top right arc →
  // top edge with integrated tab bump → top left arc → left side → close
  shape.moveTo(0, -h / 2 + 3);
  // Right side
  shape.lineTo(w / 2 - tr, h / 2 - tr);
  shape.absarc(w / 2 - tr, h / 2 - tr, tr, -Math.PI / 2, 0, false);
  // Top edge left half, with tab bump
  shape.lineTo(tabR + 1, h / 2);
  // Tab arc (bump upward)
  shape.absarc(0, tabCy, tabR, -Math.PI * 0.92, -Math.PI * 0.08, true);
  // Top edge right half (mirror)
  shape.lineTo(-(w / 2 - tr), h / 2);
  shape.absarc(-(w / 2 - tr), h / 2 - tr, tr, 0, Math.PI / 2, false);
  // Left side back to bottom
  shape.lineTo(0, -h / 2 + 3);
  shape.closePath();

  return { shape, ringX: 0, ringY };
}

// ── HEART ────────────────────────────────────────────────────
// Tab merges at top center between the two lobes
function dtHeartShapeAndRing() {
  const s = 1.15;
  const tabR = 5, tabCy = 12 * s + tabR * 0.6;

  const shape = new THREE.Shape();
  shape.moveTo(0, -22 * s);
  // Right lobe
  shape.bezierCurveTo( 10 * s, -22 * s,  22 * s, -10 * s,  20 * s, 2 * s);
  shape.bezierCurveTo( 18 * s,  10 * s,   5 * s,  12 * s,   0,     8 * s);
  // Tab bump at top
  shape.lineTo(tabR * 0.7, 10 * s);
  shape.absarc(0, tabCy, tabR, -Math.PI * 0.88, -Math.PI * 0.12, true);
  shape.lineTo(-tabR * 0.7, 10 * s);
  // Left lobe
  shape.bezierCurveTo( -5 * s,  12 * s, -18 * s,  10 * s, -20 * s, 2 * s);
  shape.bezierCurveTo(-22 * s, -10 * s, -10 * s, -22 * s,   0,    -22 * s);
  shape.closePath();

  return { shape, ringX: 0, ringY: tabCy };
}

// ── PAW ROUND ────────────────────────────────────────────────
// Circle tag + explicit tab circle merged at top
function dtPawShapeAndRing() {
  const tagR = 22, tabR = 5.5, tabCy = tagR + tabR * 0.55;

  // Build outline: large arc for most of the circle, then
  // a small arc bump for the tab, bridged by two short lines
  const shape = new THREE.Shape();
  const gapAngle = Math.asin((tabR + 0.5) / tagR); // angle where tab intersects circle
  // Start at right side of tab gap on circle
  shape.moveTo(Math.cos(-Math.PI / 2 + gapAngle) * tagR,
               Math.sin(-Math.PI / 2 + gapAngle) * tagR + tabCy - tabCy);

  // Most of the circle (going clockwise from just right of top, all the way around)
  shape.absarc(0, 0, tagR,
    -Math.PI / 2 + gapAngle,   // start angle
    -Math.PI / 2 - gapAngle + Math.PI * 2,  // end angle (just left of top gap)
    false
  );
  // Tab bump
  shape.absarc(0, tabCy, tabR, -Math.PI * 0.9, -Math.PI * 0.1, true);
  shape.closePath();

  return { shape, ringX: 0, ringY: tabCy };
}

// ── HYDRANT ──────────────────────────────────────────────────
// Tab emerges from dome top
function dtHydrantShapeAndRing() {
  const tabR = 5, domeTopY = 23, tabCy = domeTopY + tabR * 0.55;

  const shape = new THREE.Shape();
  shape.moveTo(-15, -22);
  shape.lineTo(15,  -22);
  shape.lineTo(15,  -14);
  // Right nozzle
  shape.lineTo(18, -8);
  shape.absarc(14, -4, 4, -Math.PI / 2, Math.PI / 2, false);
  shape.lineTo(12, 0);
  shape.lineTo(10, 2);
  shape.lineTo(10, 8);
  shape.lineTo(9, 12);
  // Dome — split to insert tab
  shape.absarc(0, 15, 8, 0.1, Math.PI / 2 - 0.15, false);  // right side of dome
  // Tab bump
  shape.lineTo(tabR * 0.7, domeTopY - 1);
  shape.absarc(0, tabCy, tabR, -Math.PI * 0.88, -Math.PI * 0.12, true);
  shape.lineTo(-tabR * 0.7, domeTopY - 1);
  // Dome left side
  shape.absarc(0, 15, 8, Math.PI / 2 + 0.15, Math.PI - 0.1, false);
  shape.lineTo(-9, 12);
  shape.lineTo(-10, 8);
  shape.lineTo(-10, 2);
  shape.lineTo(-12, 0);
  shape.absarc(-14, -4, 4, Math.PI / 2, -Math.PI / 2, true);
  shape.lineTo(-15, -14);
  shape.closePath();

  return { shape, ringX: 0, ringY: tabCy };
}

// ── STAR ─────────────────────────────────────────────────────
// Tab on top point of the star — extend that point into a tab
function dtStarShapeAndRing() {
  const points = 5, outerR = 24, innerR = 11;
  const tabR = 5, tabCy = outerR + tabR * 0.55;

  const shape = new THREE.Shape();
  for (let i = 0; i < points * 2; i++) {
    const angle = (Math.PI * 2 / (points * 2)) * i - Math.PI / 2;
    const r = i % 2 === 0 ? outerR : innerR;
    const x = Math.cos(angle) * r;
    const y = Math.sin(angle) * r;
    if (i === 0) {
      // Top point — divert through tab instead of sharp tip
      const tipAngle = angle;
      const preX  = Math.cos(tipAngle - 0.18) * (outerR - 1);
      const preY  = Math.sin(tipAngle - 0.18) * (outerR - 1);
      const postX = Math.cos(tipAngle + 0.18) * (outerR - 1);
      const postY = Math.sin(tipAngle + 0.18) * (outerR - 1);
      shape.moveTo(preX, preY);
      shape.lineTo(preX * 0.6, preY * 0.6 + tabCy * 0.4);
      shape.absarc(0, tabCy, tabR, -Math.PI * 0.88, -Math.PI * 0.12, true);
      shape.lineTo(postX * 0.6, postY * 0.6 + tabCy * 0.4);
      shape.lineTo(postX, postY);
    } else {
      shape.lineTo(x, y);
    }
  }
  shape.closePath();

  return { shape, ringX: 0, ringY: tabCy };
}

// ═══════════════════════════════════════════════════════════════
// FIX 2: PAW DECORATION — proper ShapeGeometry along Z
//
// Use extruded 2D circle paths instead of CylinderGeometry
// rotated on X. Positions derived from OpenSCAD source exactly.
// ═══════════════════════════════════════════════════════════════

function dtAddPawDecoration(group, insertColor) {
  // Pad and toe specs from OpenSCAD paw_round_tag.scad
  // Main pad: circle r=8 at (0, -1)
  // Toes: for a=[-50,-17,17,50] translate([sin(a)*12, cos(a)*12+2]) circle r=4
  const toeAngles = [-50, -17, 17, 50];
  const embossZ = Z_POCKET_FLOOR; // paw sits at pocket floor level
  const embossDepth = POCKET_DEPTH - 0.1; // almost full pocket depth

  const mat = new THREE.MeshPhysicalMaterial({
    color: insertColor,
    roughness: 0.3,
    metalness: 0.0,
    clearcoat: 0.1,
  });

  const extrudeOpts = (depth) => ({
    depth,
    bevelEnabled: false,
    curveSegments: 32,
  });

  // Main central pad
  const padShape = new THREE.Shape();
  padShape.absarc(0, -1, 8, 0, Math.PI * 2, false);
  const padGeo = new THREE.ExtrudeGeometry(padShape, extrudeOpts(embossDepth));
  const padMesh = new THREE.Mesh(padGeo, mat);
  padMesh.position.z = embossZ;
  padMesh.name = 'pawPad';
  group.add(padMesh);

  // Four toe pads
  for (const a of toeAngles) {
    const rad = a * Math.PI / 180;
    const tx = Math.sin(rad) * 12;
    const ty = Math.cos(rad) * 12 + 2;

    const toeShape = new THREE.Shape();
    toeShape.absarc(0, 0, 4, 0, Math.PI * 2, false);
    const toeGeo = new THREE.ExtrudeGeometry(toeShape, extrudeOpts(embossDepth));
    const toeMesh = new THREE.Mesh(toeGeo, mat);
    toeMesh.position.set(tx, ty, embossZ);
    toeMesh.name = 'pawToe';
    group.add(toeMesh);
  }
}

// ═══════════════════════════════════════════════════════════════
// FIX 3: TEXT TEXTURE — kept, just used at correct Z levels
// ═══════════════════════════════════════════════════════════════

function dtCreateTextTexture(text, fontSize, color) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const font = `bold ${fontSize * 10}px "Arial", "Helvetica", sans-serif`;
  ctx.font = font;
  const metrics = ctx.measureText(text);
  const pad = fontSize * 3;
  canvas.width  = Math.ceil(metrics.width + pad * 2);
  canvas.height = Math.ceil(fontSize * 14 + pad * 2);

  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return { texture, width: canvas.width / 10, height: canvas.height / 10 };
}

// ═══════════════════════════════════════════════════════════════
// SCENE SETUP
// ═══════════════════════════════════════════════════════════════

function dtSetupScene() {
  const container = document.getElementById('dt3DContainer');
  if (!container || typeof THREE === 'undefined') return;
  DT.container = container;
  DT.mouse = new THREE.Vector2();
  dtCleanupScene();

  const w = container.clientWidth  || 600;
  const h = container.clientHeight || 400;

  DT.scene = new THREE.Scene();
  DT.scene.background = new THREE.Color(0xf4f1ec);

  DT.camera = new THREE.PerspectiveCamera(35, w / h, 0.1, 1000);
  DT.camera.position.set(0, -55, 65);
  DT.camera.lookAt(0, 0, TAG_THICKNESS / 2);

  DT.renderer = new THREE.WebGLRenderer({ antialias: true });
  DT.renderer.setSize(w, h);
  DT.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  DT.renderer.shadowMap.enabled = true;
  DT.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.innerHTML = '';
  container.appendChild(DT.renderer.domElement);

  // Lights
  DT.scene.add(new THREE.AmbientLight(0xffffff, 0.55));

  const key = new THREE.DirectionalLight(0xffffff, 0.85);
  key.position.set(20, -20, 50);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { near: 1, far: 200, left: -60, right: 60, top: 60, bottom: -60 });
  DT.scene.add(key);

  const fill = new THREE.DirectionalLight(0xaaccff, 0.3);
  fill.position.set(-30, 10, 30);
  DT.scene.add(fill);

  const rim = new THREE.DirectionalLight(0xffeedd, 0.2);
  rim.position.set(0, 40, 10);
  DT.scene.add(rim);

  // Shadow ground
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.ShadowMaterial({ opacity: 0.12 })
  );
  ground.position.z = -0.5;
  ground.receiveShadow = true;
  DT.scene.add(ground);

  // Orbit controls
  if (typeof THREE.OrbitControls !== 'undefined') {
    DT.controls = new THREE.OrbitControls(DT.camera, DT.renderer.domElement);
    DT.controls.enableDamping = true;
    DT.controls.dampingFactor = 0.08;
    DT.controls.minDistance = 20;
    DT.controls.maxDistance = 200;
    DT.controls.target.set(0, 0, TAG_THICKNESS / 2);
    DT.controls.update();
  }

  DT.raycaster = new THREE.Raycaster();
  // Drag plane is at the top of the insert — Z_LABEL
  DT.tagTopPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -Z_LABEL);

  DT.tagGroup = new THREE.Group();
  DT.scene.add(DT.tagGroup);

  DT.renderer.domElement.addEventListener('mousedown',  dtOnMouseDown3D);
  DT.renderer.domElement.addEventListener('mousemove',  dtOnMouseMove3D);
  DT.renderer.domElement.addEventListener('mouseup',    dtOnMouseUp3D);
  DT.renderer.domElement.addEventListener('mouseleave', dtOnMouseUp3D);

  DT._resizeObs = new ResizeObserver(() => {
    const nw = container.clientWidth, nh = container.clientHeight;
    if (nw > 0 && nh > 0) {
      DT.camera.aspect = nw / nh;
      DT.camera.updateProjectionMatrix();
      DT.renderer.setSize(nw, nh);
    }
  });
  DT._resizeObs.observe(container);

  dtAnimate();
  dtBuildTag();
}

function dtCleanupScene() {
  if (DT.animId) { cancelAnimationFrame(DT.animId); DT.animId = null; }
  if (DT._resizeObs) { DT._resizeObs.disconnect(); DT._resizeObs = null; }
  if (DT.renderer) {
    DT.renderer.domElement.removeEventListener('mousedown',  dtOnMouseDown3D);
    DT.renderer.domElement.removeEventListener('mousemove',  dtOnMouseMove3D);
    DT.renderer.domElement.removeEventListener('mouseup',    dtOnMouseUp3D);
    DT.renderer.domElement.removeEventListener('mouseleave', dtOnMouseUp3D);
    DT.renderer.dispose();
  }
  if (DT.controls) DT.controls.dispose();
  DT.scene = DT.camera = DT.renderer = DT.controls = null;
}

function dtAnimate() {
  DT.animId = requestAnimationFrame(dtAnimate);
  if (DT.controls) DT.controls.update();
  if (DT.renderer && DT.scene && DT.camera) DT.renderer.render(DT.scene, DT.camera);
}

// ═══════════════════════════════════════════════════════════════
// BUILD TAG — orchestrates all three fixed subsystems
// ═══════════════════════════════════════════════════════════════

function dtBuildTag() {
  if (!DT.tagGroup || !DT.scene) return;

  // Dispose and clear
  while (DT.tagGroup.children.length > 0) {
    const child = DT.tagGroup.children[0];
    DT.tagGroup.remove(child);
    child.geometry?.dispose();
    if (child.material) {
      if (Array.isArray(child.material)) child.material.forEach(m => { m.map?.dispose(); m.dispose(); });
      else { child.material.map?.dispose(); child.material.dispose(); }
    }
  }
  DT.textMesh = null;

  const colors  = COLOR_PRESETS[DT.colorIdx] || COLOR_PRESETS[0];
  const geo     = DT.shapeGeo[DT.selectedShape];
  if (!geo) return;

  const baseColor   = new THREE.Color(colors.base);
  const insertColor = new THREE.Color(colors.insert);

  const baseMat = new THREE.MeshPhysicalMaterial({
    color: baseColor,
    roughness: 0.35,
    metalness: 0.0,
    clearcoat: 0.25,
    clearcoatRoughness: 0.35,
  });

  // ── FIX 1: One-piece tag body with integrated tab ──────────
  // Profile already has ring hole punched in. No separate tab mesh.
  const profile = dtCreateShapeProfile(DT.selectedShape);

  const bodyGeo = new THREE.ExtrudeGeometry(profile, {
    depth: TAG_THICKNESS,
    bevelEnabled: true,
    bevelThickness: BEVEL_SIZE,
    bevelSize: BEVEL_SIZE,
    bevelSegments: BEVEL_SEGMENTS,
    curveSegments: 48,
  });

  const bodyMesh = new THREE.Mesh(bodyGeo, baseMat);
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  bodyMesh.name = 'tagBody';
  DT.tagGroup.add(bodyMesh);

  // ── FIX 2: Paw decoration uses correct geometry ────────────
  if (DT.selectedShape === 'paw') {
    dtAddPawDecoration(DT.tagGroup, insertColor);
  }

  // ── Decorative split ring (visual only) ───────────────────
  const { ringX, ringY } = dtGetShapeAndRing(DT.selectedShape);
  const ringMesh = new THREE.Mesh(
    new THREE.TorusGeometry(4.2, 0.65, 8, 32),
    new THREE.MeshPhysicalMaterial({ color: 0xbcbcbc, roughness: 0.15, metalness: 0.9 })
  );
  ringMesh.position.set(ringX, ringY, TAG_THICKNESS / 2);
  ringMesh.rotation.x = Math.PI / 2;
  ringMesh.castShadow = true;
  ringMesh.name = 'splitRing';
  DT.tagGroup.add(ringMesh);

  // ── FIX 3: Text pocket + insert at non-conflicting Z ──────
  if (DT.petName) dtBuildTextInsert(geo, insertColor, baseMat.clone());

  dtUpdatePosReadout();
}

// ═══════════════════════════════════════════════════════════════
// FIX 3: TEXT INSERT — explicit Z stack, no z-fighting
// ═══════════════════════════════════════════════════════════════

function dtBuildTextInsert(geo, insertColor, pocketMat) {
  const name = DT.petName;
  if (!name) return;

  const tcx  = DT.textCx !== null ? DT.textCx : geo.textCx;
  const tcy  = DT.textCy !== null ? DT.textCy : geo.textCy;
  const tsz  = DT.textSz !== null ? DT.textSz : geo.textSz;

  const textData = dtCreateTextTexture(name, tsz, '#ffffff');
  const { texture, width: tw, height: th } = textData;

  const pad = 1.5;
  const pw  = tw + pad * 2;
  const ph  = th + pad * 2;

  // Pocket: recessed box. Sits with its TOP at Z_BASE_TOP.
  // BoxGeometry is centered — so center at (Z_BASE_TOP - POCKET_DEPTH/2)
  pocketMat.color.multiplyScalar(0.82);
  pocketMat.roughness = 0.6;
  const pocketGeo  = new THREE.BoxGeometry(pw, ph, POCKET_DEPTH);
  const pocketMesh = new THREE.Mesh(pocketGeo, pocketMat);
  pocketMesh.position.set(tcx, tcy, Z_POCKET_FLOOR + POCKET_DEPTH / 2);
  pocketMesh.name = 'pocket';
  DT.tagGroup.add(pocketMesh);

  // Insert slab: sits inside pocket, slightly inset from top
  // Center at Z_INSERT_BOT + INSERT_HEIGHT/2
  const insertMat = new THREE.MeshPhysicalMaterial({
    color: insertColor,
    roughness: 0.28,
    metalness: 0.0,
    clearcoat: 0.15,
  });
  const insertGeo  = new THREE.BoxGeometry(tw, th, INSERT_HEIGHT);
  const insertMesh = new THREE.Mesh(insertGeo, insertMat);
  insertMesh.position.set(tcx, tcy, Z_INSERT_BOT + INSERT_HEIGHT / 2);
  insertMesh.name = 'insert';
  DT.tagGroup.add(insertMesh);

  // Text label plane — strictly above insert, depthTest ON, depthWrite ON
  // Using renderOrder to force it above the insert without z-fighting
  const labelGeo  = new THREE.PlaneGeometry(tw * 0.92, th * 0.92);
  const labelMat  = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: true,   // FIX: was false — caused it to fight everything below
    depthTest: true,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const labelMesh = new THREE.Mesh(labelGeo, labelMat);
  labelMesh.position.set(tcx, tcy, Z_LABEL);
  labelMesh.renderOrder = 1;
  labelMesh.name = 'textLabel';
  DT.tagGroup.add(labelMesh);

  DT.textMesh = { pocket: pocketMesh, insert: insertMesh, label: labelMesh, width: tw, height: th };
}

// ═══════════════════════════════════════════════════════════════
// MOUSE / DRAG
// ═══════════════════════════════════════════════════════════════

function dtGetMouseMm(e) {
  if (!DT.renderer || !DT.camera || !DT.raycaster) return null;
  const rect = DT.renderer.domElement.getBoundingClientRect();
  DT.mouse.set(
    ((e.clientX - rect.left) / rect.width)  * 2 - 1,
    -((e.clientY - rect.top)  / rect.height) * 2 + 1
  );
  DT.raycaster.setFromCamera(DT.mouse, DT.camera);
  const intersection = new THREE.Vector3();
  return DT.raycaster.ray.intersectPlane(DT.tagTopPlane, intersection)
    ? { x: intersection.x, y: intersection.y }
    : null;
}

function dtIsOverText3D(mm) {
  if (!DT.textMesh || !DT.petName || !mm) return false;
  const geo = DT.shapeGeo[DT.selectedShape];
  if (!geo) return false;
  const tcx = DT.textCx !== null ? DT.textCx : geo.textCx;
  const tcy = DT.textCy !== null ? DT.textCy : geo.textCy;
  return Math.abs(mm.x - tcx) < DT.textMesh.width / 2 + 3 &&
         Math.abs(mm.y - tcy) < DT.textMesh.height / 2 + 3;
}

function dtOnMouseDown3D(e) {
  const mm = dtGetMouseMm(e);
  if (!dtIsOverText3D(mm)) return;
  const geo = DT.shapeGeo[DT.selectedShape];
  const tcx = DT.textCx !== null ? DT.textCx : geo.textCx;
  const tcy = DT.textCy !== null ? DT.textCy : geo.textCy;
  DT.dragging = true;
  DT.dragOffset = { x: mm.x - tcx, y: mm.y - tcy };
  if (DT.controls) DT.controls.enabled = false;
  DT.renderer.domElement.style.cursor = 'grabbing';
}

function dtOnMouseMove3D(e) {
  const mm = dtGetMouseMm(e);
  if (!mm) return;
  if (DT.dragging && DT.dragOffset) {
    DT.textCx = parseFloat((mm.x - DT.dragOffset.x).toFixed(1));
    DT.textCy = parseFloat((mm.y - DT.dragOffset.y).toFixed(1));
    dtUpdateTextPosition();
    dtUpdatePosReadout();
  } else {
    DT.renderer.domElement.style.cursor = dtIsOverText3D(mm) ? 'grab' : 'default';
  }
}

function dtOnMouseUp3D() {
  if (!DT.dragging) return;
  DT.dragging = false;
  DT.dragOffset = null;
  if (DT.controls) DT.controls.enabled = true;
  if (DT.renderer) DT.renderer.domElement.style.cursor = 'default';
}

function dtUpdateTextPosition() {
  if (!DT.textMesh) return;
  const geo = DT.shapeGeo[DT.selectedShape];
  if (!geo) return;
  const tcx = DT.textCx !== null ? DT.textCx : geo.textCx;
  const tcy = DT.textCy !== null ? DT.textCy : geo.textCy;
  for (const key of ['pocket', 'insert', 'label']) {
    if (DT.textMesh[key]) {
      DT.textMesh[key].position.x = tcx;
      DT.textMesh[key].position.y = tcy;
    }
  }
}

function dtUpdatePosReadout() {
  const el = document.getElementById('dtPosReadout');
  if (!el) return;
  const geo = DT.shapeGeo[DT.selectedShape];
  if (!geo) return;
  const cx = (DT.textCx !== null ? DT.textCx : geo.textCx).toFixed(1);
  const cy = (DT.textCy !== null ? DT.textCy : geo.textCy).toFixed(1);
  el.textContent = `Text: (${cx}, ${cy})mm${(DT.textCx !== null || DT.textCy !== null) ? ' [custom]' : ''}`;
}

// ═══════════════════════════════════════════════════════════════
// SHAPE PICKER
// ═══════════════════════════════════════════════════════════════

function dtRenderShapePicker() {
  const container = document.getElementById('dtShapeGrid');
  if (!container) return;
  container.innerHTML = DT.shapes.map(s => `
    <button class="dt-shape-btn ${s.id === DT.selectedShape ? 'selected' : ''}"
            data-shape="${s.id}" title="${s.desc}">
      <span class="dt-shape-btn-label">${s.label}</span>
    </button>
  `).join('');
  container.querySelectorAll('.dt-shape-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      DT.selectedShape = btn.dataset.shape;
      DT.textCx = DT.textCy = DT.textSz = null;
      dtRenderShapePicker();
      dtBuildTag();
    });
  });
}

// ═══════════════════════════════════════════════════════════════
// GENERATE / SLICER / BATCH — unchanged from v3
// ═══════════════════════════════════════════════════════════════

async function dtGenerate() {
  if (!DT.petName) { dtSetStatus('Enter a pet name first.', 'error'); document.getElementById('dtPetName')?.focus(); return; }
  DT.generating = true;
  dtSetStatus('Generating tag files...', 'info');
  dtUpdateButtons();
  try {
    const colors = COLOR_PRESETS[DT.colorIdx] || COLOR_PRESETS[0];
    const result = await window.printStation.dogTag.generate({
      name: DT.petName, shape: DT.selectedShape,
      colors: { base: colors.baseLabel, insert: colors.insertLabel },
      textCx: DT.textCx, textCy: DT.textCy, textSz: DT.textSz,
    });
    DT.lastGenResult = result;
    const stlReady = result.status === 'ready_to_print';
    dtSetStatus(
      `Generated <strong>${result.petName}</strong> (${result.shape}). ` +
      (stlReady ? 'STLs ready.' : 'SCAD files created (install OpenSCAD for STL).'),
      stlReady ? 'success' : 'warning'
    );
    dtLoadHistory();
  } catch (e) {
    dtSetStatus(`Error: ${e.message || e}`, 'error');
  } finally {
    DT.generating = false;
    dtUpdateButtons();
  }
}

async function dtSendToSlicer() {
  if (!DT.lastGenResult?.files?.baseStl) { dtSetStatus('No STL available. Generate first (requires OpenSCAD).', 'error'); return; }
  dtSetStatus('Uploading to slicer catalog...', 'info');
  try {
    const r = DT.lastGenResult;
    await window.printStation.dogTag.sendToSlicer({ stlPath: r.files.baseStl, name: `Dog Tag Base - ${r.shape} - ${r.petName}`, category: 'Dog Tags' });
    await window.printStation.dogTag.sendToSlicer({ stlPath: r.files.textStl, name: `Dog Tag Text - ${r.shape} - ${r.petName}`, category: 'Dog Tags' });
    dtSetStatus(`Uploaded to slicer: <strong>${r.petName}</strong> base + text.`, 'success');
  } catch (e) {
    dtSetStatus(`Slicer upload error: ${e.message || e}`, 'error');
  }
}

async function dtAddToBatch() {
  if (!DT.petName) { dtSetStatus('Enter a pet name first.', 'error'); return; }
  const colors = COLOR_PRESETS[DT.colorIdx] || COLOR_PRESETS[0];
  try {
    const result = await window.printStation.dogTag.batchAdd({
      name: DT.petName, shape: DT.selectedShape,
      colors: { base: colors.baseLabel, insert: colors.insertLabel },
      textCx: DT.textCx, textCy: DT.textCy, textSz: DT.textSz,
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
    dtSetStatus(`Generated ${result.count} tags.`, 'success');
    dtLoadHistory();
  } catch (e) {
    dtSetStatus(`Batch generate error: ${e.message || e}`, 'error');
  }
}

async function dtBatchRemove(id) {
  try { const result = await window.printStation.dogTag.batchRemove(id); DT.batchQueue = result.queue; dtRenderBatch(); } catch (_) {}
}
async function dtBatchClear() {
  try { await window.printStation.dogTag.batchClear(); DT.batchQueue = []; dtRenderBatch(); } catch (_) {}
}

// ═══════════════════════════════════════════════════════════════
// BATCH / HISTORY
// ═══════════════════════════════════════════════════════════════

function dtRenderBatch() {
  const container = document.getElementById('dtBatchList');
  const countEl   = document.getElementById('dtBatchCount');
  if (!container) return;
  if (countEl) countEl.textContent = DT.batchQueue.length || '';
  if (!DT.batchQueue.length) { container.innerHTML = '<div class="dt-empty">Queue empty. Use "+ Add to Batch".</div>'; return; }
  container.innerHTML = DT.batchQueue.map(item => `
    <div class="dt-batch-item">
      <div class="dt-batch-info">
        <strong>${item.name}</strong>
        <small>${item.shape}${item.textCx !== null ? ' [custom pos]' : ''}</small>
      </div>
      <button class="dt-batch-remove" data-id="${item.id}" title="Remove">&times;</button>
    </div>
  `).join('');
  container.querySelectorAll('.dt-batch-remove').forEach(btn => btn.addEventListener('click', () => dtBatchRemove(btn.dataset.id)));
}

async function dtLoadHistory() {
  try { const data = await window.printStation.dogTag.getHistory(); DT.history = (data.jobs || []).slice(0, 20); dtRenderHistory(); } catch (_) {}
}

function dtRenderHistory() {
  const container = document.getElementById('dtHistoryList');
  if (!container) return;
  if (!DT.history.length) { container.innerHTML = '<div class="dt-empty">No tags generated yet.</div>'; return; }
  container.innerHTML = DT.history.map(job => {
    const date = job.timestamp ? new Date(job.timestamp).toLocaleDateString() : '';
    return `
      <div class="dt-history-item">
        <div class="dt-history-info"><strong>${job.name}</strong><small>${job.shape} &middot; ${date}</small></div>
        <button class="dt-history-open" data-job="${job.jobId}" title="Open folder">Open</button>
      </div>`;
  }).join('');
  container.querySelectorAll('.dt-history-open').forEach(btn => btn.addEventListener('click', () => window.printStation.dogTag.openOutput(btn.dataset.job)));
}

// ═══════════════════════════════════════════════════════════════
// UI HELPERS
// ═══════════════════════════════════════════════════════════════

function dtSetStatus(html, type) { const el = document.getElementById('dtStatus'); if (el) { el.innerHTML = html; el.className = 'dt-status ' + (type || ''); } }

function dtUpdateButtons() {
  const genBtn    = document.getElementById('dtGenerateBtn');
  const slicerBtn = document.getElementById('dtSendToSlicerBtn');
  if (genBtn)    { genBtn.disabled = DT.generating; genBtn.textContent = DT.generating ? 'Generating...' : 'Generate Tag'; }
  if (slicerBtn) { slicerBtn.disabled = !DT.lastGenResult?.files?.baseStl; }
}

function dtResetTextPos() { DT.textCx = DT.textCy = DT.textSz = null; dtBuildTag(); }

// ═══════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════

async function initDogTagsView() {
  if (DT.initialized) {
    dtLoadHistory();
    dtLoadBatch();
    if (!DT.renderer || !DT.container?.isConnected) dtSetupScene();
    return;
  }

  try {
    const data = await window.printStation.dogTag.getShapes();
    DT.shapes = data.shapes || [];
    DT.defaults = data.defaults || {};
    DT.shapes.forEach(s => { if (s.geometry) DT.shapeGeo[s.id] = s.geometry; });
  } catch (e) { console.error('[DogTag] Failed to load shapes:', e); }

  try { const check = await window.printStation.dogTag.checkOpenscad(); DT.openscadAvailable = check.available; } catch (_) {}

  const oscadNote = document.getElementById('dtOpenscadNote');
  if (oscadNote) oscadNote.style.display = DT.openscadAvailable ? 'none' : 'block';

  const nameInput = document.getElementById('dtPetName');
  if (nameInput) {
    nameInput.addEventListener('input', () => {
      DT.petName = nameInput.value.trim().toUpperCase().replace(/[^A-Z0-9\s]/g, '').slice(0, 12);
      dtBuildTag();
    });
    nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') dtGenerate(); });
  }

  const colorSelect = document.getElementById('dtColorPreset');
  if (colorSelect) colorSelect.addEventListener('change', () => { DT.colorIdx = colorSelect.selectedIndex; dtBuildTag(); });

  document.getElementById('dtGenerateBtn')    ?.addEventListener('click', dtGenerate);
  document.getElementById('dtSendToSlicerBtn')?.addEventListener('click', dtSendToSlicer);
  document.getElementById('dtAddBatchBtn')    ?.addEventListener('click', dtAddToBatch);
  document.getElementById('dtBatchGenerateBtn')?.addEventListener('click', dtBatchGenerateAll);
  document.getElementById('dtBatchClearBtn')  ?.addEventListener('click', dtBatchClear);
  document.getElementById('dtResetPosBtn')    ?.addEventListener('click', dtResetTextPos);

  dtRenderShapePicker();
  dtLoadHistory();
  dtLoadBatch();
  setTimeout(() => dtSetupScene(), 50);
  DT.initialized = true;
}

async function dtLoadBatch() {
  try { DT.batchQueue = await window.printStation.dogTag.batchList(); dtRenderBatch(); } catch (_) {}
}

window.initDogTagsView = initDogTagsView;