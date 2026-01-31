// =============== STL File Manager View ===============

const stlState = {
  initialized: false,
  models: [],
  totalCount: 0,
  selectedIds: new Set(),
  currentPage: 1,
  pageSize: 50,
  search: '',
  category: '',
  favoritesOnly: false,
  sortBy: 'filename',
  sortDir: 'ASC',
  previewModel: null,
  threeScene: null,
  threeRenderer: null,
  threeCamera: null,
  threeControls: null,
  threeMesh: null,
  animFrameId: null,
  scanUnsub: null
};

const STL_PLACEHOLDER_SVG = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="200" height="200">
  <rect width="100" height="100" fill="#1a1a2e"/>
  <path d="M30 70L50 25L70 70Z" fill="none" stroke="#38bdf8" stroke-width="2"/>
  <path d="M50 25L70 70L55 55Z" fill="none" stroke="#2a8fc0" stroke-width="1.5"/>
  <text x="50" y="88" text-anchor="middle" fill="#555" font-size="8" font-family="sans-serif">STL</text>
</svg>`)}`;

// =============== INITIALIZATION ===============
function initStlManagerView() {
  if (!stlState.initialized) {
    stlState.initialized = true;
    setupStlEventListeners();
  }
  loadStlModels();
  loadStlCategories();
}

function setupStlEventListeners() {
  // Import Folder
  document.getElementById('stlImportFolderBtn').addEventListener('click', scanStlFolder);

  // Translate Names
  document.getElementById('stlTranslateNamesBtn').addEventListener('click', translateStlFilenames);

  // Search (debounced)
  let searchTimer;
  document.getElementById('stlSearchInput').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      stlState.search = e.target.value.trim();
      stlState.currentPage = 1;
      loadStlModels();
    }, 300);
  });

  // Category filter
  document.getElementById('stlCategoryFilter').addEventListener('change', (e) => {
    stlState.category = e.target.value;
    stlState.currentPage = 1;
    loadStlModels();
  });

  // Favorites toggle
  document.getElementById('stlFavoritesOnly').addEventListener('change', (e) => {
    stlState.favoritesOnly = e.target.checked;
    stlState.currentPage = 1;
    loadStlModels();
  });

  // Sort
  document.getElementById('stlSortBy').addEventListener('change', (e) => {
    stlState.sortBy = e.target.value;
    loadStlModels();
  });
  document.getElementById('stlSortDir').addEventListener('change', (e) => {
    stlState.sortDir = e.target.value;
    loadStlModels();
  });

  // Pagination
  document.getElementById('stlPrevPage').addEventListener('click', () => {
    if (stlState.currentPage > 1) {
      stlState.currentPage--;
      loadStlModels();
    }
  });
  document.getElementById('stlNextPage').addEventListener('click', () => {
    const maxPage = Math.ceil(stlState.totalCount / stlState.pageSize);
    if (stlState.currentPage < maxPage) {
      stlState.currentPage++;
      loadStlModels();
    }
  });

  // Grid clicks (event delegation)
  document.getElementById('stlModelGrid').addEventListener('click', (e) => {
    const card = e.target.closest('.stl-model-card');
    if (!card) return;
    const id = parseInt(card.dataset.stlId);
    if (!id) return;

    // Check if star was clicked
    if (e.target.closest('.stl-favorite-star')) {
      e.stopPropagation();
      toggleStlFavorite(id);
      return;
    }

    // Check if ctrl/shift held for multi-select
    if (e.ctrlKey || e.metaKey) {
      if (stlState.selectedIds.has(id)) {
        stlState.selectedIds.delete(id);
      } else {
        stlState.selectedIds.add(id);
      }
      updateStlSelection();
      return;
    }

    // Regular click - open preview
    openStlPreview(id);
  });

  // Bulk actions
  document.getElementById('stlBulkCategoryBtn').addEventListener('click', bulkSetStlCategory);
  document.getElementById('stlBulkTagsBtn').addEventListener('click', bulkSetStlTags);
  document.getElementById('stlBulkDeleteBtn').addEventListener('click', bulkDeleteStl);
  document.getElementById('stlClearSelectionBtn').addEventListener('click', () => {
    stlState.selectedIds.clear();
    updateStlSelection();
  });

  // Preview modal
  document.getElementById('stlPreviewCloseBtn').addEventListener('click', closeStlPreview);
  document.getElementById('stlActionSlicer').addEventListener('click', () => {
    if (stlState.previewModel) window.printStation.stlManager.openInSlicer(stlState.previewModel.id);
  });
  document.getElementById('stlActionCopy').addEventListener('click', () => {
    if (stlState.previewModel) window.printStation.stlManager.copyToFolder(stlState.previewModel.id);
  });
  document.getElementById('stlActionReveal').addEventListener('click', () => {
    if (stlState.previewModel) window.printStation.stlManager.revealInExplorer(stlState.previewModel.id);
  });
  document.getElementById('stlActionDelete').addEventListener('click', async () => {
    if (!stlState.previewModel) return;
    if (!confirm('Remove this model from the library?')) return;
    await window.printStation.stlManager.delete(stlState.previewModel.id);
    closeStlPreview();
    loadStlModels();
  });

  // Render mode buttons
  document.querySelectorAll('.stl-render-mode-btns button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.stl-render-mode-btns button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      setStlRenderMode(btn.dataset.mode);
    });
  });

  // Preview metadata save on blur
  document.getElementById('stlPreviewCategory').addEventListener('change', saveStlPreviewMetadata);
  document.getElementById('stlPreviewTags').addEventListener('change', saveStlPreviewMetadata);
  document.getElementById('stlPreviewNotes').addEventListener('change', saveStlPreviewMetadata);

  // Close preview with Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && stlState.previewModel) {
      closeStlPreview();
    }
  });
}

// =============== DATA LOADING ===============
async function loadStlModels() {
  const query = {
    search: stlState.search,
    category: stlState.category,
    favorite: stlState.favoritesOnly ? 1 : undefined,
    limit: stlState.pageSize,
    offset: (stlState.currentPage - 1) * stlState.pageSize,
    sortBy: stlState.sortBy,
    sortDir: stlState.sortDir
  };

  try {
    const [models, count] = await Promise.all([
      window.printStation.stlManager.list(query),
      window.printStation.stlManager.count(query)
    ]);

    stlState.models = models;
    stlState.totalCount = count;
    renderStlGrid(models);
    renderStlPagination();
  } catch (err) {
    console.error('[STL] Failed to load models:', err);
    document.getElementById('stlModelGrid').innerHTML =
      '<p class="placeholder" style="grid-column:1/-1;text-align:center;padding:40px;">Error loading models</p>';
  }
}

async function loadStlCategories() {
  try {
    const categories = await window.printStation.stlManager.categories();
    const select = document.getElementById('stlCategoryFilter');
    const current = select.value;
    select.innerHTML = '<option value="">All Categories</option>';
    for (const cat of categories) {
      const opt = document.createElement('option');
      opt.value = cat.category;
      opt.textContent = `${cat.category} (${cat.count})`;
      select.appendChild(opt);
    }
    select.value = current;
  } catch (err) {
    console.error('[STL] Failed to load categories:', err);
  }
}

// =============== RENDERING ===============
function renderStlGrid(models) {
  const grid = document.getElementById('stlModelGrid');

  if (!models.length) {
    grid.innerHTML = `<div class="placeholder" style="grid-column:1/-1;text-align:center;padding:60px 20px;color:var(--muted);">
      ${stlState.search || stlState.category || stlState.favoritesOnly
        ? 'No models match your filters.'
        : 'Click <strong>Import Folder</strong> to scan a directory of STL files.'}
    </div>`;
    return;
  }

  grid.innerHTML = models.map(m => {
    const selected = stlState.selectedIds.has(m.id) ? ' selected' : '';
    const thumbSrc = m.thumbnail_path
      ? `file:///${m.thumbnail_path.replace(/\\/g, '/')}`
      : STL_PLACEHOLDER_SVG;
    const dims = `${m.dim_x.toFixed(1)} x ${m.dim_y.toFixed(1)} x ${m.dim_z.toFixed(1)}`;

    return `
      <div class="stl-model-card${selected}" data-stl-id="${m.id}">
        <span class="stl-favorite-star${m.favorite ? ' active' : ''}">${m.favorite ? '&#9733;' : '&#9734;'}</span>
        <img class="stl-model-card-thumb" src="${thumbSrc}" alt="${escapeStlHtml(m.filename)}" loading="lazy">
        <div class="stl-model-card-body">
          <div class="stl-model-card-title" title="${escapeStlHtml(m.filename)}">${escapeStlHtml(m.filename)}</div>
          <div class="stl-model-card-dims">${dims} mm</div>
          ${m.category ? `<span class="stl-model-card-badge">${escapeStlHtml(m.category)}</span>` : ''}
        </div>
      </div>
    `;
  }).join('');

  // Generate thumbnails for models missing them
  generateMissingThumbnails(models.filter(m => !m.thumbnail_path));
}

function renderStlPagination() {
  const total = stlState.totalCount;
  const start = total === 0 ? 0 : (stlState.currentPage - 1) * stlState.pageSize + 1;
  const end = Math.min(stlState.currentPage * stlState.pageSize, total);
  const maxPage = Math.max(1, Math.ceil(total / stlState.pageSize));

  document.getElementById('stlShowingText').textContent =
    total === 0 ? 'No models imported' : `Showing ${start}-${end} of ${total.toLocaleString()} models`;
  document.getElementById('stlPageInfo').textContent = `Page ${stlState.currentPage} of ${maxPage}`;
  document.getElementById('stlPrevPage').disabled = stlState.currentPage <= 1;
  document.getElementById('stlNextPage').disabled = stlState.currentPage >= maxPage;
}

function updateStlSelection() {
  const count = stlState.selectedIds.size;
  const bulkBar = document.getElementById('stlBulkActions');
  bulkBar.style.display = count > 0 ? 'flex' : 'none';
  document.getElementById('stlSelectedCount').textContent = `${count} selected`;

  // Update card visual state
  document.querySelectorAll('.stl-model-card').forEach(card => {
    const id = parseInt(card.dataset.stlId);
    card.classList.toggle('selected', stlState.selectedIds.has(id));
  });
}

// =============== SCANNING ===============
async function scanStlFolder() {
  try {
    const paths = await window.printStation.selectFolder({ title: 'Select STL Files Folder' });
    if (!paths || !paths.length) return;

    const directory = paths[0];
    const progressContainer = document.getElementById('stlProgressContainer');
    const progressBar = document.getElementById('stlProgressBar');
    const progressLabel = document.getElementById('stlProgressLabel');
    const progressCount = document.getElementById('stlProgressCount');

    progressContainer.style.display = 'block';
    progressBar.style.width = '0%';
    progressLabel.textContent = 'Scanning...';
    progressCount.textContent = '';

    // Listen for progress
    stlState.scanUnsub = window.printStation.stlManager.onScanProgress(({ current, total, filename }) => {
      const pct = total > 0 ? (current / total * 100).toFixed(1) : 0;
      progressBar.style.width = `${pct}%`;
      progressLabel.textContent = `Scanning: ${filename}`;
      progressCount.textContent = `${current} / ${total}`;
    });

    const result = await window.printStation.stlManager.scan({ directory });

    // Cleanup
    if (stlState.scanUnsub) { stlState.scanUnsub(); stlState.scanUnsub = null; }
    progressContainer.style.display = 'none';

    document.getElementById('stlStatusText').textContent =
      `Imported ${result.scanned} of ${result.total} STL files`;

    stlState.currentPage = 1;
    await loadStlModels();
    await loadStlCategories();
  } catch (err) {
    console.error('[STL] Scan error:', err);
    document.getElementById('stlProgressContainer').style.display = 'none';
    alert('Scan failed: ' + err.message);
  }
}

// =============== TRANSLATE FILENAMES ===============
async function translateStlFilenames() {
  try {
    const progressContainer = document.getElementById('stlProgressContainer');
    const progressBar = document.getElementById('stlProgressBar');
    const progressLabel = document.getElementById('stlProgressLabel');
    const progressCount = document.getElementById('stlProgressCount');
    const btn = document.getElementById('stlTranslateNamesBtn');

    btn.disabled = true;
    progressContainer.style.display = 'block';
    progressBar.style.width = '0%';
    progressLabel.textContent = 'Translating filenames...';
    progressCount.textContent = '';

    // Listen for progress
    const unsub = window.printStation.stlManager.onTranslateProgress(({ current, total, filename, newName, status }) => {
      const pct = total > 0 ? (current / total * 100).toFixed(1) : 0;
      progressBar.style.width = `${pct}%`;
      if (status === 'translated') {
        progressLabel.textContent = `${filename} → ${newName}`;
      } else if (status === 'skipped') {
        progressLabel.textContent = `Skipped: ${filename}`;
      } else if (status === 'error') {
        progressLabel.textContent = `Error: ${filename}`;
      }
      progressCount.textContent = `${current} / ${total}`;
    });

    const result = await window.printStation.stlManager.translateFilenames();

    unsub();
    progressContainer.style.display = 'none';
    btn.disabled = false;

    if (result.total === 0) {
      document.getElementById('stlStatusText').textContent = 'No non-English filenames found.';
    } else {
      document.getElementById('stlStatusText').textContent =
        `Translated ${result.translated} of ${result.total} filenames (${result.skipped} skipped).`;
    }

    await loadStlModels();
  } catch (err) {
    console.error('[STL] Translate error:', err);
    document.getElementById('stlProgressContainer').style.display = 'none';
    document.getElementById('stlTranslateNamesBtn').disabled = false;
    alert('Translation failed: ' + err.message);
  }
}

// =============== 3D PREVIEW ===============
async function openStlPreview(id) {
  const model = stlState.models.find(m => m.id === id);
  if (!model) return;
  stlState.previewModel = model;

  const modal = document.getElementById('stlPreviewModal');
  modal.classList.add('modal-visible');

  // Populate info
  document.getElementById('stlPreviewTitle').textContent = model.filename + '.stl';
  document.getElementById('stlInfoDims').textContent =
    `${model.dim_x.toFixed(1)} x ${model.dim_y.toFixed(1)} x ${model.dim_z.toFixed(1)} mm`;
  document.getElementById('stlInfoTriangles').textContent = model.triangle_count.toLocaleString();
  document.getElementById('stlInfoFileSize').textContent = formatFileSize(model.file_size);
  document.getElementById('stlInfoFormat').textContent = model.format;
  document.getElementById('stlInfoPath').textContent = model.file_path;
  document.getElementById('stlPreviewCategory').value = model.category || '';
  document.getElementById('stlPreviewTags').value = model.tags || '';
  document.getElementById('stlPreviewNotes').value = model.notes || '';

  // Reset render mode buttons
  document.querySelectorAll('.stl-render-mode-btns button').forEach(b => b.classList.remove('active'));
  document.querySelector('.stl-render-mode-btns button[data-mode="solid"]').classList.add('active');

  // Initialize Three.js
  await initThreeScene(model);
}

async function initThreeScene(model) {
  const container = document.getElementById('stlPreviewCanvasContainer');

  // Clean up any existing canvas (not the buttons)
  const existingCanvas = container.querySelector('canvas');
  if (existingCanvas) existingCanvas.remove();

  const width = container.clientWidth;
  const height = container.clientHeight;

  // Scene
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a1a);

  // Camera
  const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100000);

  // Renderer
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  // Lighting
  scene.add(new THREE.AmbientLight(0x606060, 1.5));
  const dirLight1 = new THREE.DirectionalLight(0xffffff, 1.2);
  dirLight1.position.set(5, 10, 7);
  scene.add(dirLight1);
  const dirLight2 = new THREE.DirectionalLight(0x88aaff, 0.5);
  dirLight2.position.set(-5, -3, -5);
  scene.add(dirLight2);

  // Grid
  const gridSize = Math.max(model.dim_x, model.dim_y, model.dim_z, 100) * 2;
  scene.add(new THREE.GridHelper(gridSize, 20, 0x333355, 0x222244));

  // Controls
  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;

  stlState.threeScene = scene;
  stlState.threeRenderer = renderer;
  stlState.threeCamera = camera;
  stlState.threeControls = controls;

  // Load STL
  try {
    const base64 = await window.printStation.stlManager.readFile(model.file_path);
    if (!base64) throw new Error('Failed to read file');

    const binaryStr = atob(base64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }

    const loader = new THREE.STLLoader();
    const geometry = loader.parse(bytes.buffer);
    geometry.computeVertexNormals();
    geometry.center();

    const material = new THREE.MeshPhongMaterial({
      color: 0x38bdf8,
      specular: 0x222222,
      shininess: 40,
      flatShading: false
    });

    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);
    stlState.threeMesh = mesh;

    // Position camera to fit model
    const box = new THREE.Box3().setFromObject(mesh);
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = camera.fov * (Math.PI / 180);
    const cameraDistance = maxDim / (2 * Math.tan(fov / 2)) * 1.8;

    camera.position.set(cameraDistance * 0.7, cameraDistance * 0.5, cameraDistance * 0.7);
    camera.lookAt(0, 0, 0);
    controls.target.set(0, 0, 0);
    controls.update();

  } catch (err) {
    console.error('[STL Preview] Load error:', err);
  }

  // Animation loop
  function animate() {
    stlState.animFrameId = requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  // Handle resize
  const resizeObserver = new ResizeObserver(() => {
    if (!stlState.threeRenderer) return;
    const w = container.clientWidth;
    const h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  });
  resizeObserver.observe(container);
  stlState._resizeObserver = resizeObserver;
}

function closeStlPreview() {
  stlState.previewModel = null;

  // Cancel animation
  if (stlState.animFrameId) {
    cancelAnimationFrame(stlState.animFrameId);
    stlState.animFrameId = null;
  }

  // Dispose Three.js
  if (stlState.threeMesh) {
    stlState.threeMesh.geometry.dispose();
    if (stlState.threeMesh.material) stlState.threeMesh.material.dispose();
    stlState.threeMesh = null;
  }
  if (stlState.threeRenderer) {
    stlState.threeRenderer.dispose();
    const canvas = stlState.threeRenderer.domElement;
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
    stlState.threeRenderer = null;
  }
  if (stlState.threeControls) {
    stlState.threeControls.dispose();
    stlState.threeControls = null;
  }
  if (stlState._resizeObserver) {
    stlState._resizeObserver.disconnect();
    stlState._resizeObserver = null;
  }
  stlState.threeScene = null;
  stlState.threeCamera = null;

  document.getElementById('stlPreviewModal').classList.remove('modal-visible');
}

function setStlRenderMode(mode) {
  if (!stlState.threeMesh) return;
  const mesh = stlState.threeMesh;

  switch (mode) {
    case 'solid':
      mesh.material.wireframe = false;
      mesh.material.transparent = false;
      mesh.material.opacity = 1;
      mesh.material.color.set(0x38bdf8);
      break;
    case 'wireframe':
      mesh.material.wireframe = true;
      mesh.material.transparent = false;
      mesh.material.opacity = 1;
      mesh.material.color.set(0x38bdf8);
      break;
    case 'xray':
      mesh.material.wireframe = false;
      mesh.material.transparent = true;
      mesh.material.opacity = 0.3;
      mesh.material.color.set(0x66ccff);
      break;
  }
  mesh.material.needsUpdate = true;
}

async function saveStlPreviewMetadata() {
  if (!stlState.previewModel) return;
  const id = stlState.previewModel.id;
  const updates = {
    category: document.getElementById('stlPreviewCategory').value.trim(),
    tags: document.getElementById('stlPreviewTags').value.trim(),
    notes: document.getElementById('stlPreviewNotes').value.trim()
  };

  try {
    const updated = await window.printStation.stlManager.update(id, updates);
    if (updated) {
      // Update local state
      const idx = stlState.models.findIndex(m => m.id === id);
      if (idx >= 0) Object.assign(stlState.models[idx], updates);
      stlState.previewModel = { ...stlState.previewModel, ...updates };
      // Refresh categories if category changed
      loadStlCategories();
    }
  } catch (err) {
    console.error('[STL] Save metadata error:', err);
  }
}

// =============== THUMBNAIL GENERATION ===============
async function generateMissingThumbnails(models) {
  if (!models.length) return;
  if (typeof THREE === 'undefined') return;

  // Create offscreen renderer
  const offCanvas = document.createElement('canvas');
  offCanvas.width = 256;
  offCanvas.height = 256;

  const offRenderer = new THREE.WebGLRenderer({ canvas: offCanvas, antialias: true, alpha: true });
  offRenderer.setSize(256, 256);

  const offScene = new THREE.Scene();
  offScene.background = new THREE.Color(0x1a1a2e);
  offScene.add(new THREE.AmbientLight(0x606060, 1.5));
  const light = new THREE.DirectionalLight(0xffffff, 1.2);
  light.position.set(5, 10, 7);
  offScene.add(light);

  const offCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 100000);

  const loader = new THREE.STLLoader();

  for (const model of models) {
    try {
      const base64 = await window.printStation.stlManager.readFile(model.file_path);
      if (!base64) continue;

      const binaryStr = atob(base64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

      const geometry = loader.parse(bytes.buffer);
      geometry.computeVertexNormals();
      geometry.center();

      const material = new THREE.MeshPhongMaterial({ color: 0x38bdf8, flatShading: false });
      const mesh = new THREE.Mesh(geometry, material);
      offScene.add(mesh);

      // Position camera
      const box = new THREE.Box3().setFromObject(mesh);
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      const dist = maxDim / (2 * Math.tan(22.5 * Math.PI / 180)) * 1.5;
      offCamera.position.set(dist * 0.7, dist * 0.5, dist * 0.7);
      offCamera.lookAt(0, 0, 0);

      offRenderer.render(offScene, offCamera);

      const dataUrl = offCanvas.toDataURL('image/png');
      const thumbPath = await window.printStation.stlManager.saveThumbnail(model.id, dataUrl);

      // Update the card image in the DOM
      if (thumbPath) {
        const card = document.querySelector(`.stl-model-card[data-stl-id="${model.id}"] .stl-model-card-thumb`);
        if (card) card.src = `file:///${thumbPath.replace(/\\/g, '/')}`;
        model.thumbnail_path = thumbPath;
      }

      // Cleanup mesh
      offScene.remove(mesh);
      geometry.dispose();
      material.dispose();
    } catch (err) {
      console.error(`[STL Thumb] Error generating for ${model.filename}:`, err);
    }
  }

  offRenderer.dispose();
}

// =============== BULK OPERATIONS ===============
async function toggleStlFavorite(id) {
  try {
    const updated = await window.printStation.stlManager.toggleFavorite(id);
    if (updated) {
      const idx = stlState.models.findIndex(m => m.id === id);
      if (idx >= 0) stlState.models[idx].favorite = updated.favorite;
      // Update star in DOM
      const star = document.querySelector(`.stl-model-card[data-stl-id="${id}"] .stl-favorite-star`);
      if (star) {
        star.classList.toggle('active', updated.favorite === 1);
        star.innerHTML = updated.favorite ? '&#9733;' : '&#9734;';
      }
    }
  } catch (err) {
    console.error('[STL] Toggle favorite error:', err);
  }
}

async function bulkSetStlCategory() {
  const ids = Array.from(stlState.selectedIds);
  if (!ids.length) return;
  const category = prompt('Enter category for selected models:');
  if (category === null) return;

  await window.printStation.stlManager.bulkSetCategory(ids, category.trim());
  stlState.selectedIds.clear();
  updateStlSelection();
  await loadStlModels();
  await loadStlCategories();
}

async function bulkSetStlTags() {
  const ids = Array.from(stlState.selectedIds);
  if (!ids.length) return;
  const tags = prompt('Enter tags for selected models (comma-separated):');
  if (tags === null) return;

  await window.printStation.stlManager.bulkSetTags(ids, tags.trim());
  stlState.selectedIds.clear();
  updateStlSelection();
  await loadStlModels();
}

async function bulkDeleteStl() {
  const ids = Array.from(stlState.selectedIds);
  if (!ids.length) return;
  if (!confirm(`Delete ${ids.length} model(s) from the library?`)) return;

  await window.printStation.stlManager.bulkDelete(ids);
  stlState.selectedIds.clear();
  updateStlSelection();
  await loadStlModels();
  await loadStlCategories();
}

// =============== UTILITIES ===============
function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function escapeStlHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
