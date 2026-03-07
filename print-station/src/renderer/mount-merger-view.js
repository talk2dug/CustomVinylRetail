/**
 * Mount Merger View — Multiboard Mount Merger for STL Catalog items
 * Loads source + mount STLs in a Three.js viewport, lets user position the mount,
 * then calls the backend to boolean-union them via OpenSCAD.
 */

/* global printStation, THREE, switchView */

// ============================================================================
// STATE
// ============================================================================

const mmState = {
  initialized: false,
  sourceItem: null,    // catalog item object
  mountItem: null,     // catalog item object (selected mount)
  mountType: 'snap-receiver', // 'snap-receiver', 'multibin-shell', or 'tray-base'
  parts: [],           // filtered mount parts from catalog
  // Three.js
  scene: null,
  camera: null,
  renderer: null,
  controls: null,
  animId: null,
  resizeObs: null,
  sourceMesh: null,
  mountMesh: null,
  sourceBox: null,
  mountBox: null,
  sourceBBHelper: null,
  mountBBHelper: null,
  // Drag state
  isDragging: false,
  dragPlane: null,
  dragOffset: new THREE.Vector3(),
  raycaster: new THREE.Raycaster(),
  mouse: new THREE.Vector2(),
  transformMode: 'translate', // 'translate' or 'rotate'
  rotateStart: null,
  generating: false
};

// ============================================================================
// INIT / OPEN
// ============================================================================

/**
 * Open the Mount Merger for a given catalog item.
 * Called from the slicer catalog UI.
 */
async function openMountMerger(sourceItem) {
  mmState.sourceItem = sourceItem;
  mmState.mountItem = null;

  // Switch to the view
  switchView('mountMergerView');

  // Show source info
  const infoEl = document.getElementById('mmSourceInfo');
  if (infoEl) {
    const dims = (sourceItem.dim_x && sourceItem.dim_y && sourceItem.dim_z)
      ? ` (${Math.round(sourceItem.dim_x)}×${Math.round(sourceItem.dim_y)}×${Math.round(sourceItem.dim_z)}mm)`
      : '';
    infoEl.textContent = `Source: ${sourceItem.name}${dims}`;
  }

  // Auto-suggest grid size based on source dimensions
  mmAutoSuggestGrid(sourceItem);

  // Init Three.js scene if not already done
  if (!mmState.initialized) {
    mmInitScene();
    mmWireEvents();
    mmState.initialized = true;
  } else {
    mmClearScene();
  }

  // Load source STL
  await mmLoadSourceStl(sourceItem.id);

  // Load mount parts list
  await mmLoadMountParts();

  // Reset UI
  document.getElementById('mmGenerateBtn').disabled = true;
  document.getElementById('mmProgress').style.display = 'none';
  document.getElementById('mmResult').style.display = 'none';
  mmState.generating = false;
}

// ============================================================================
// THREE.JS SCENE
// ============================================================================

function mmInitScene() {
  const container = document.getElementById('mmViewport');
  const width = container.clientWidth || 800;
  const height = container.clientHeight || 600;

  // Scene
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a1a);

  // Camera
  const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100000);
  camera.position.set(150, 120, 150);

  // Renderer
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  // Lighting
  scene.add(new THREE.AmbientLight(0x606060, 1.5));
  const dl1 = new THREE.DirectionalLight(0xffffff, 1.2);
  dl1.position.set(100, 200, 150);
  scene.add(dl1);
  const dl2 = new THREE.DirectionalLight(0x88aaff, 0.5);
  dl2.position.set(-100, -50, -100);
  scene.add(dl2);

  // Grid helper
  const grid = new THREE.GridHelper(400, 40, 0x333355, 0x222244);
  scene.add(grid);

  // OrbitControls
  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;

  // Drag plane (horizontal for XZ dragging)
  const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  // Animation loop
  function animate() {
    mmState.animId = requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  // Resize observer
  const resizeObs = new ResizeObserver(() => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  });
  resizeObs.observe(container);

  mmState.scene = scene;
  mmState.camera = camera;
  mmState.renderer = renderer;
  mmState.controls = controls;
  mmState.resizeObs = resizeObs;
  mmState.dragPlane = dragPlane;
}

function mmClearScene() {
  // Remove old meshes + helpers
  if (mmState.sourceMesh) { mmState.scene.remove(mmState.sourceMesh); mmState.sourceMesh = null; }
  if (mmState.mountMesh) { mmState.scene.remove(mmState.mountMesh); mmState.mountMesh = null; }
  if (mmState.sourceBBHelper) { mmState.scene.remove(mmState.sourceBBHelper); mmState.sourceBBHelper = null; }
  if (mmState.mountBBHelper) { mmState.scene.remove(mmState.mountBBHelper); mmState.mountBBHelper = null; }
  mmState.sourceBox = null;
  mmState.mountBox = null;
}

function mmDestroyScene() {
  if (mmState.animId) cancelAnimationFrame(mmState.animId);
  if (mmState.resizeObs) mmState.resizeObs.disconnect();
  if (mmState.renderer) {
    mmState.renderer.dispose();
    mmState.renderer.domElement.remove();
  }
  mmState.initialized = false;
}

// ============================================================================
// STL LOADING
// ============================================================================

async function mmLoadSourceStl(stlId) {
  const statusEl = document.getElementById('mmStatus');
  statusEl.textContent = 'Loading source STL...';

  try {
    const base64 = await printStation.slicer.fetchStlBytes(stlId);
    const buf = Uint8Array.from(atob(base64), c => c.charCodeAt(0)).buffer;

    const loader = new THREE.STLLoader();
    const geometry = loader.parse(buf);
    geometry.computeVertexNormals();

    // Z-up to Y-up
    geometry.rotateX(-Math.PI / 2);
    geometry.center();

    // Floor to Y=0
    geometry.computeBoundingBox();
    const minY = geometry.boundingBox.min.y;
    geometry.translate(0, -minY, 0);

    const material = new THREE.MeshStandardMaterial({
      color: 0x888899,
      roughness: 0.5,
      metalness: 0.1
    });
    const mesh = new THREE.Mesh(geometry, material);
    mmState.scene.add(mesh);
    mmState.sourceMesh = mesh;

    // Bounding box
    const box = new THREE.Box3().setFromObject(mesh);
    mmState.sourceBox = box;
    const bbHelper = new THREE.Box3Helper(box, 0x38bdf8);
    mmState.scene.add(bbHelper);
    mmState.sourceBBHelper = bbHelper;

    // Auto-fit camera
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = mmState.camera.fov * (Math.PI / 180);
    const dist = maxDim / (2 * Math.tan(fov / 2)) * 2.0;
    mmState.camera.position.set(center.x + dist * 0.5, center.y + dist * 0.6, center.z + dist * 0.5);
    mmState.controls.target.copy(center);
    mmState.controls.update();

    statusEl.textContent = `Source loaded: ${Math.round(size.x)}×${Math.round(size.y)}×${Math.round(size.z)}mm`;
  } catch (err) {
    console.error('[MountMerger] Failed to load source STL:', err);
    statusEl.textContent = 'Error loading source STL';
  }
}

async function mmLoadMountStl(mountItem) {
  // Remove old mount
  if (mmState.mountMesh) { mmState.scene.remove(mmState.mountMesh); mmState.mountMesh = null; }
  if (mmState.mountBBHelper) { mmState.scene.remove(mmState.mountBBHelper); mmState.mountBBHelper = null; }

  mmState.mountItem = mountItem;
  const statusEl = document.getElementById('mmStatus');
  statusEl.textContent = 'Loading mount STL...';

  try {
    const base64 = await printStation.slicer.fetchStlBytes(mountItem.id);
    const buf = Uint8Array.from(atob(base64), c => c.charCodeAt(0)).buffer;

    const loader = new THREE.STLLoader();
    const geometry = loader.parse(buf);
    geometry.computeVertexNormals();

    // Z-up to Y-up
    geometry.rotateX(-Math.PI / 2);
    geometry.center();

    // Floor to Y=0
    geometry.computeBoundingBox();
    const minY = geometry.boundingBox.min.y;
    geometry.translate(0, -minY, 0);

    const material = new THREE.MeshStandardMaterial({
      color: 0x22bb66,
      roughness: 0.4,
      metalness: 0.1,
      transparent: true,
      opacity: 0.7
    });
    const mesh = new THREE.Mesh(geometry, material);
    mmState.scene.add(mesh);
    mmState.mountMesh = mesh;

    // Bounding box
    const box = new THREE.Box3().setFromObject(mesh);
    mmState.mountBox = box;
    const bbHelper = new THREE.Box3Helper(box, 0x22bb66);
    mmState.scene.add(bbHelper);
    mmState.mountBBHelper = bbHelper;

    // Auto-place at bottom center of source by default
    mmAutoPlaceMount('bottom');

    // Enable generate button
    document.getElementById('mmGenerateBtn').disabled = false;

    const size = box.getSize(new THREE.Vector3());
    statusEl.textContent = `Mount loaded: ${mountItem.name} (${Math.round(size.x)}×${Math.round(size.y)}×${Math.round(size.z)}mm)`;
  } catch (err) {
    console.error('[MountMerger] Failed to load mount STL:', err);
    statusEl.textContent = 'Error loading mount STL';
  }
}

// ============================================================================
// AUTO-PLACEMENT
// ============================================================================

function mmAutoPlaceMount(face) {
  if (!mmState.sourceMesh || !mmState.mountMesh) return;

  const srcBox = new THREE.Box3().setFromObject(mmState.sourceMesh);
  const mntBox = new THREE.Box3().setFromObject(mmState.mountMesh);
  const srcSize = srcBox.getSize(new THREE.Vector3());
  const srcCenter = srcBox.getCenter(new THREE.Vector3());
  const mntSize = mntBox.getSize(new THREE.Vector3());
  const mntCenter = mntBox.getCenter(new THREE.Vector3());

  // Reset mount rotation
  mmState.mountMesh.rotation.set(0, 0, 0);

  // Calculate position so mount face is flush with source face
  const pos = new THREE.Vector3();

  switch (face) {
    case 'bottom':
      // Mount on bottom (Y=minY of source), centered in XZ
      pos.set(
        srcCenter.x,
        srcBox.min.y - mntSize.y / 2,
        srcCenter.z
      );
      break;
    case 'top':
      pos.set(srcCenter.x, srcBox.max.y + mntSize.y / 2, srcCenter.z);
      break;
    case 'back':
      // Back = min Z face
      pos.set(srcCenter.x, srcCenter.y, srcBox.min.z - mntSize.z / 2);
      break;
    case 'front':
      pos.set(srcCenter.x, srcCenter.y, srcBox.max.z + mntSize.z / 2);
      break;
    case 'left':
      pos.set(srcBox.min.x - mntSize.x / 2, srcCenter.y, srcCenter.z);
      break;
    case 'right':
      pos.set(srcBox.max.x + mntSize.x / 2, srcCenter.y, srcCenter.z);
      break;
    default:
      return;
  }

  // Offset from mount geometry center to actual mesh position
  mmState.mountMesh.position.copy(pos);
  mmUpdateMountBB();
}

function mmUpdateMountBB() {
  if (!mmState.mountMesh) return;
  if (mmState.mountBBHelper) {
    mmState.scene.remove(mmState.mountBBHelper);
  }
  const box = new THREE.Box3().setFromObject(mmState.mountMesh);
  mmState.mountBox = box;
  mmState.mountBBHelper = new THREE.Box3Helper(box, 0x22bb66);
  mmState.scene.add(mmState.mountBBHelper);
}

// ============================================================================
// DRAG INTERACTION (move mount mesh by dragging)
// ============================================================================

function mmOnPointerDown(event) {
  if (!mmState.mountMesh || mmState.generating) return;

  const rect = mmState.renderer.domElement.getBoundingClientRect();
  mmState.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mmState.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  mmState.raycaster.setFromCamera(mmState.mouse, mmState.camera);
  const hits = mmState.raycaster.intersectObject(mmState.mountMesh);

  if (hits.length > 0) {
    mmState.isDragging = true;
    mmState.controls.enabled = false;

    if (mmState.transformMode === 'translate') {
      // Set drag plane at mount mesh Y
      mmState.dragPlane.constant = -mmState.mountMesh.position.y;
      const intersection = new THREE.Vector3();
      mmState.raycaster.ray.intersectPlane(mmState.dragPlane, intersection);
      mmState.dragOffset.copy(mmState.mountMesh.position).sub(intersection);
    } else {
      // Rotate mode: store start angle
      mmState.rotateStart = Math.atan2(
        mmState.mouse.y - 0,
        mmState.mouse.x - 0
      );
    }
  }
}

function mmOnPointerMove(event) {
  if (!mmState.isDragging || !mmState.mountMesh) return;

  const rect = mmState.renderer.domElement.getBoundingClientRect();
  mmState.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mmState.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  if (mmState.transformMode === 'translate') {
    mmState.raycaster.setFromCamera(mmState.mouse, mmState.camera);
    const intersection = new THREE.Vector3();
    mmState.raycaster.ray.intersectPlane(mmState.dragPlane, intersection);
    if (intersection) {
      mmState.mountMesh.position.x = intersection.x + mmState.dragOffset.x;
      mmState.mountMesh.position.z = intersection.z + mmState.dragOffset.z;
      mmUpdateMountBB();
    }
  } else {
    // Rotate around Y axis
    const angle = Math.atan2(mmState.mouse.y, mmState.mouse.x);
    const delta = angle - mmState.rotateStart;
    mmState.mountMesh.rotation.y += delta * 2;
    mmState.rotateStart = angle;
    mmUpdateMountBB();
  }
}

function mmOnPointerUp() {
  if (mmState.isDragging) {
    mmState.isDragging = false;
    mmState.controls.enabled = true;
  }
}

// ============================================================================
// MOUNT PARTS LIST
// ============================================================================

async function mmLoadMountParts() {
  const listEl = document.getElementById('mmPartsList');
  listEl.innerHTML = '<div style="padding:12px;color:var(--text-secondary);font-size:0.8rem;">Loading mounts...</div>';

  try {
    const resp = await printStation.slicer.listCatalog({ category: 'Multiboard' });
    let items = resp.items || [];

    // Filter by mount type
    const mbTypeFilters = {
      'snap-receiver': ['tile', 'snap', 'peg'],
      'multibin-shell': ['bin', 'shell'],
      'tray-base': ['tray', 'shelf', 'drawer']
    };
    const mbTypeFilter = mbTypeFilters[mmState.mountType] || ['tile', 'snap', 'peg'];

    items = items.filter(i => i.mb_type && mbTypeFilter.includes(i.mb_type));

    // Filter by grid size if specified
    const gw = parseInt(document.getElementById('mmGridW').value);
    const gh = parseInt(document.getElementById('mmGridH').value);
    if (gw && gh) {
      items = items.filter(i => i.mu_width === gw && i.mu_height === gh);
    } else if (gw) {
      items = items.filter(i => i.mu_width === gw);
    } else if (gh) {
      items = items.filter(i => i.mu_height === gh);
    }

    mmState.parts = items;

    if (!items.length) {
      listEl.innerHTML = '<div style="padding:12px;color:var(--text-secondary);font-size:0.8rem;">No matching mounts found. Try adjusting filters.</div>';
      return;
    }

    listEl.innerHTML = '';
    for (const item of items.slice(0, 100)) {
      const el = document.createElement('div');
      el.className = 'mm-part-item';
      el.style.cssText = 'padding:8px;margin-bottom:4px;border-radius:4px;cursor:pointer;border:1px solid transparent;font-size:0.78rem;';
      el.innerHTML = `
        <div style="font-weight:500;margin-bottom:2px;">${escHtml(item.name)}</div>
        <div style="color:var(--text-secondary);font-size:0.7rem;">
          ${item.mu_width && item.mu_height ? item.mu_width + '×' + item.mu_height + ' MU' : ''}
          ${item.mb_type ? ' · ' + item.mb_type : ''}
          ${item.dim_x ? ' · ' + Math.round(item.dim_x) + '×' + Math.round(item.dim_y) + '×' + Math.round(item.dim_z) + 'mm' : ''}
        </div>
      `;
      el.addEventListener('mouseenter', () => { el.style.background = 'var(--bg-primary)'; });
      el.addEventListener('mouseleave', () => {
        if (mmState.mountItem?.id !== item.id) el.style.background = '';
      });
      el.addEventListener('click', () => {
        // Highlight selected
        listEl.querySelectorAll('.mm-part-item').forEach(e => {
          e.style.borderColor = 'transparent';
          e.style.background = '';
        });
        el.style.borderColor = 'var(--accent)';
        el.style.background = 'var(--bg-primary)';
        mmLoadMountStl(item);
      });
      listEl.appendChild(el);
    }

    if (items.length > 100) {
      const more = document.createElement('div');
      more.style.cssText = 'padding:8px;color:var(--text-secondary);font-size:0.75rem;text-align:center;';
      more.textContent = `+ ${items.length - 100} more (refine filters to see all)`;
      listEl.appendChild(more);
    }
  } catch (err) {
    console.error('[MountMerger] Failed to load parts:', err);
    listEl.innerHTML = `<div style="padding:12px;color:#e53e3e;font-size:0.8rem;">Error: ${err.message}</div>`;
  }
}

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

// ============================================================================
// AUTO-SUGGEST GRID SIZE
// ============================================================================

function mmAutoSuggestGrid(item) {
  const MU = 25; // 1 Multiboard Unit = 25mm
  if (item.dim_x && item.dim_z) {
    // Use X and Z (width and depth in print orientation, mapped from STL dims)
    const w = Math.max(item.dim_x, item.dim_y, item.dim_z);
    const h = Math.min(
      ...([item.dim_x, item.dim_y, item.dim_z].filter(d => d !== w))
    ) || w;
    const sugW = Math.max(1, Math.min(6, Math.ceil(w / MU)));
    const sugH = Math.max(1, Math.min(6, Math.ceil(h / MU)));
    document.getElementById('mmGridW').value = sugW;
    document.getElementById('mmGridH').value = sugH;
    document.getElementById('mmGridSuggestion').textContent = `(auto: ${sugW}×${sugH})`;
  }
}

// ============================================================================
// GENERATE & SAVE
// ============================================================================

async function mmGenerate() {
  if (!mmState.sourceItem || !mmState.mountItem || !mmState.mountMesh) return;
  if (mmState.generating) return;

  mmState.generating = true;
  document.getElementById('mmGenerateBtn').disabled = true;
  document.getElementById('mmProgress').style.display = 'flex';
  document.getElementById('mmResult').style.display = 'none';

  try {
    // Get the mount mesh world matrix
    mmState.mountMesh.updateMatrixWorld(true);
    const transform = mmState.mountMesh.matrixWorld.toArray(); // 16-element column-major

    const face = document.getElementById('mmSnapFace').value || undefined;
    const gw = parseInt(document.getElementById('mmGridW').value) || undefined;
    const gh = parseInt(document.getElementById('mmGridH').value) || undefined;

    const result = await printStation.slicer.addMount({
      sourceStlId: mmState.sourceItem.id,
      mountStlId: mmState.mountItem.id,
      transform,
      mountType: mmState.mountItem.mb_type || mmState.mountType,
      face,
      gridSize: (gw && gh) ? `${gw}x${gh}` : undefined
    });

    document.getElementById('mmProgress').style.display = 'none';

    if (result.success) {
      const resultEl = document.getElementById('mmResult');
      resultEl.style.display = 'flex';
      resultEl.innerHTML = `
        <span style="color:#22bb66;font-size:0.85rem;">Merged successfully: ${escHtml(result.catalogEntry.name)}</span>
        <button id="mmViewCatalog" class="primary" style="padding:4px 12px;font-size:0.8rem;">View in Catalog</button>
      `;
      document.getElementById('mmViewCatalog').addEventListener('click', () => {
        switchView('slicerView');
      });
    } else {
      const resultEl = document.getElementById('mmResult');
      resultEl.style.display = 'flex';
      resultEl.innerHTML = `<span style="color:#e53e3e;font-size:0.85rem;">Error: ${escHtml(result.error || 'Unknown error')}</span>`;
    }
  } catch (err) {
    console.error('[MountMerger] Generate error:', err);
    document.getElementById('mmProgress').style.display = 'none';
    const resultEl = document.getElementById('mmResult');
    resultEl.style.display = 'flex';
    resultEl.innerHTML = `<span style="color:#e53e3e;font-size:0.85rem;">Error: ${escHtml(err.message)}</span>`;
  } finally {
    mmState.generating = false;
    document.getElementById('mmGenerateBtn').disabled = false;
  }
}

// ============================================================================
// WIRE EVENTS
// ============================================================================

function mmWireEvents() {
  const canvas = mmState.renderer.domElement;

  // Drag interaction for mount mesh
  canvas.addEventListener('pointerdown', mmOnPointerDown);
  canvas.addEventListener('pointermove', mmOnPointerMove);
  canvas.addEventListener('pointerup', mmOnPointerUp);
  canvas.addEventListener('pointerleave', mmOnPointerUp);

  // Keyboard: T = translate, R = rotate
  document.addEventListener('keydown', (e) => {
    // Only handle when mount merger view is active
    if (!document.getElementById('mountMergerView').classList.contains('active')) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

    if (e.key === 't' || e.key === 'T') {
      mmState.transformMode = 'translate';
      document.getElementById('mmTranslateBtn').classList.add('active');
      document.getElementById('mmTranslateBtn').style.background = 'var(--accent)';
      document.getElementById('mmTranslateBtn').style.color = '#fff';
      document.getElementById('mmRotateBtn').classList.remove('active');
      document.getElementById('mmRotateBtn').style.background = 'var(--bg-primary)';
      document.getElementById('mmRotateBtn').style.color = 'var(--text-primary)';
    }
    if (e.key === 'r' || e.key === 'R') {
      mmState.transformMode = 'rotate';
      document.getElementById('mmRotateBtn').classList.add('active');
      document.getElementById('mmRotateBtn').style.background = 'var(--accent)';
      document.getElementById('mmRotateBtn').style.color = '#fff';
      document.getElementById('mmTranslateBtn').classList.remove('active');
      document.getElementById('mmTranslateBtn').style.background = 'var(--bg-primary)';
      document.getElementById('mmTranslateBtn').style.color = 'var(--text-primary)';
    }
  });

  // Toolbar buttons
  document.getElementById('mmTranslateBtn').addEventListener('click', () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 't' }));
  });
  document.getElementById('mmRotateBtn').addEventListener('click', () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r' }));
  });

  // Snap face dropdown
  document.getElementById('mmSnapFace').addEventListener('change', (e) => {
    if (e.target.value) mmAutoPlaceMount(e.target.value);
  });

  // Reset button
  document.getElementById('mmResetBtn').addEventListener('click', () => {
    if (mmState.mountMesh) {
      mmState.mountMesh.position.set(0, 0, 0);
      mmState.mountMesh.rotation.set(0, 0, 0);
      mmAutoPlaceMount('bottom');
    }
  });

  // Mount type toggle
  document.querySelectorAll('.mm-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mm-type-btn').forEach(b => {
        b.style.background = 'var(--bg-primary)';
        b.style.color = 'var(--text-primary)';
        b.classList.remove('active');
      });
      btn.style.background = 'var(--accent)';
      btn.style.color = '#fff';
      btn.classList.add('active');
      mmState.mountType = btn.dataset.type;
      // Show/hide grid picker (only for snap receivers)
      document.getElementById('mmGridPicker').style.display =
        mmState.mountType === 'snap-receiver' ? 'block' : 'none';
      // Default tray-base placement to bottom
      if (mmState.mountType === 'tray-base' && mmState.mountMesh) {
        mmAutoPlaceMount('bottom');
      }
      mmLoadMountParts();
    });
  });

  // Grid size filter change
  document.getElementById('mmGridW').addEventListener('change', () => mmLoadMountParts());
  document.getElementById('mmGridH').addEventListener('change', () => mmLoadMountParts());

  // Generate button
  document.getElementById('mmGenerateBtn').addEventListener('click', mmGenerate);

  // Close button
  document.getElementById('mmCloseBtn').addEventListener('click', () => {
    switchView('slicerView');
  });
}
