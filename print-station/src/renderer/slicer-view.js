/**
 * Slicer View — Slice & Print UI
 * STL catalog browser, G-code picker with settings, human-readable slice settings panel
 */

/* global printStation, THREE */

// ============================================================================
// STATE
// ============================================================================

const slicerState = {
  initialized: false,
  presets: null,
  catalog: [],
  categories: [],
  selectedItem: null,
  gcodeEntries: [],
  settings: {
    quality: 'standard',
    strength: 'normal',
    speed: 'normal',
    texture: 'smooth',
    supports: 'none',
    surface: 'standard',
    material: 'pla',
    printer_model: '',
    auto_orient: false,
    copies: 1
  },
  printers: [],
  loading: false,
  thumbCache: {},      // stlId -> dataURL (in-memory, lost on reload)
  thumbDiskCache: {},  // stlId -> file:// URL (populated from disk cache)
  stlBytesCache: {},   // stlId -> ArrayBuffer
  selectedPreview: null, // { renderer, scene, camera, controls, animId, resizeObs }
  folders: [],           // folder names for current category
  selectedFolder: null,  // currently open folder name (null = root view)
  plateMode: false,      // whether multi-select plate mode is active
  plateItems: [],        // array of catalog item objects on the plate
  platePreview: null,    // { renderer, scene, camera, controls, animId, resizeObs, meshes[], selectedMeshIndex, ... }
  plateTransforms: {}    // { [stlId]: { rx, ry, rz, scale, posX, posZ } } — persists rotation + scale + position across preview open/close
};

// ============================================================================
// G-CODE TYPE COLORS (for toolpath visualization)
// ============================================================================

const GCODE_TYPE_COLORS = {
  'External perimeter':          0x00e5ff,
  'Perimeter':                   0x00bcd4,
  'Overhang perimeter':          0xff5722,
  'Internal infill':             0x42a5f5,
  'Solid infill':                0x1e88e5,
  'Top solid infill':            0x1565c0,
  'Bridge infill':               0xab47bc,
  'Support material':            0xffc107,
  'Support material interface':  0xff9800,
  'Skirt/Brim':                  0x66bb6a,
  'Gap fill':                    0x26a69a,
  'unknown':                     0x888888
};

// ============================================================================
// INITIALIZATION
// ============================================================================

async function initSlicerView() {
  if (slicerState.initialized) {
    // Refresh catalog on re-entry
    await slicerLoadCatalog();
    return;
  }

  slicerState.initialized = true;

  // Load presets
  try {
    slicerState.presets = await printStation.slicer.getPresets();
    slicerBuildSettingsButtons();
  } catch (err) {
    console.warn('[Slicer] Failed to load presets:', err);
  }

  // Load printers from fleet
  try {
    const printers = await printStation.printerFleet.listPrinters({ active: true });
    slicerState.printers = printers || [];
    slicerPopulatePrinterDropdown();
  } catch (err) {
    console.warn('[Slicer] Failed to load printers:', err);
  }

  // Wire up events
  slicerWireEvents();

  // Load categories first, but don't load all STL — wait for user to pick a category
  await slicerLoadCategories();
  await slicerRenderCatalog(); // shows "choose a category" placeholder
}

// ============================================================================
// EVENT WIRING
// ============================================================================

function slicerWireEvents() {
  const searchInput = document.getElementById('slicerSearch');
  const categoryFilter = document.getElementById('slicerCategoryFilter');
  const uploadBtn = document.getElementById('slicerUploadBtn');
  const backBtn = document.getElementById('slicerBackBtn');
  const sliceBtn = document.getElementById('slicerSliceBtn');

  // Search
  let searchTimer = null;
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => slicerLoadCatalog(), 300);
    });
  }

  // Category filter
  if (categoryFilter) {
    categoryFilter.addEventListener('change', () => {
      slicerState.selectedFolder = null;
      slicerLoadFolders();
      slicerLoadCatalog();
    });
  }

  // Upload STL
  if (uploadBtn) {
    uploadBtn.addEventListener('click', slicerUploadStl);
  }

  // Bulk Import
  const bulkBtn = document.getElementById('slicerBulkImportBtn');
  if (bulkBtn) {
    bulkBtn.addEventListener('click', slicerBulkImport);
  }

  // Back to catalog
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      slicerDisposeSelectedPreview();
      slicerState.selectedItem = null;
      document.getElementById('slicerCatalogPanel').style.display = '';
      document.getElementById('slicerSettingsPanel').style.display = 'none';
    });
  }

  // View 3D button + thumb click
  const view3dBtn = document.getElementById('slicerView3dBtn');
  if (view3dBtn) {
    view3dBtn.addEventListener('click', () => {
      if (slicerState.selectedItem) slicerShow3dViewer(slicerState.selectedItem.id);
    });
  }
  const selectedThumb = document.getElementById('slicerSelectedThumb');
  if (selectedThumb) {
    selectedThumb.addEventListener('click', () => {
      if (slicerState.selectedItem) slicerShow3dViewer(slicerState.selectedItem.id);
    });
  }

  // View on Build Plate (single item)
  const viewOnBedBtn = document.getElementById('slicerViewOnBedBtn');
  if (viewOnBedBtn) {
    viewOnBedBtn.addEventListener('click', () => {
      if (!slicerState.selectedItem) return;
      slicerShowBuildPlatePreview([slicerState.selectedItem]);
    });
  }

  // Slice
  if (sliceBtn) {
    sliceBtn.addEventListener('click', () => slicerSliceAndPrint());
  }

  // Copies +/- controls (single item)
  const copiesInput = document.getElementById('slicerCopies');
  const copiesMinus = document.getElementById('slicerCopiesMinus');
  const copiesPlus = document.getElementById('slicerCopiesPlus');
  if (copiesInput && copiesMinus && copiesPlus) {
    const clampCopies = () => {
      let v = parseInt(copiesInput.value, 10);
      if (isNaN(v) || v < 1) v = 1;
      if (v > 20) v = 20;
      copiesInput.value = v;
      slicerState.settings.copies = v;
    };
    copiesMinus.addEventListener('click', () => { copiesInput.value = Math.max(1, parseInt(copiesInput.value, 10) - 1); clampCopies(); });
    copiesPlus.addEventListener('click', () => { copiesInput.value = Math.min(20, parseInt(copiesInput.value, 10) + 1); clampCopies(); });
    copiesInput.addEventListener('change', clampCopies);
  }

  // Auto Orient checkbox (single item)
  const autoOrientCb = document.getElementById('slicerAutoOrient');
  if (autoOrientCb) {
    autoOrientCb.addEventListener('change', () => {
      slicerState.settings.auto_orient = autoOrientCb.checked;
    });
  }

  // Auto Orient checkbox (plate)
  const plateAutoOrientCb = document.getElementById('slicerPlateAutoOrient');
  if (plateAutoOrientCb) {
    plateAutoOrientCb.addEventListener('change', () => {
      slicerState.settings.auto_orient = plateAutoOrientCb.checked;
    });
  }

  // Manage Categories
  const manageCatBtn = document.getElementById('slicerManageCategoriesBtn');
  if (manageCatBtn) {
    manageCatBtn.addEventListener('click', slicerShowCategoryManager);
  }

  // Catalog grid click delegation
  const grid = document.getElementById('slicerCatalogGrid');
  if (grid) {
    grid.addEventListener('click', (e) => {
      // Delete button — always works
      const delBtn = e.target.closest('.slicer-catalog-delete');
      if (delBtn) {
        e.stopPropagation();
        const id = parseInt(delBtn.dataset.stlId, 10);
        slicerDeleteItem(id);
        return;
      }
      const card = e.target.closest('[data-stl-id]');
      if (card) {
        const id = parseInt(card.dataset.stlId, 10);
        if (slicerState.plateMode) {
          slicerTogglePlateItem(id);
        } else {
          slicerSelectItem(id);
        }
      }
    });

    // Drag-and-drop for catalog cards → folder tiles
    grid.addEventListener('dragstart', (e) => {
      const card = e.target.closest('[data-stl-id]');
      if (!card) return;
      e.dataTransfer.setData('text/x-stl-id', card.dataset.stlId);
      e.dataTransfer.effectAllowed = 'move';
      card.style.opacity = '0.5';
    });
    grid.addEventListener('dragend', (e) => {
      const card = e.target.closest('[data-stl-id]');
      if (card) card.style.opacity = '';
    });
  }

  // Build Plate toggle button
  const plateToggle = document.getElementById('slicerPlateToggle');
  if (plateToggle) {
    plateToggle.addEventListener('click', slicerTogglePlateMode);
  }

  // Plate bar buttons
  const plateClearBtn = document.getElementById('slicerPlateClearBtn');
  if (plateClearBtn) {
    plateClearBtn.addEventListener('click', () => {
      slicerState.plateItems = [];
      slicerUpdatePlateBar();
      slicerUpdatePlateCheckmarks();
    });
  }

  const bulkCatBtn = document.getElementById('slicerBulkCategoryBtn');
  if (bulkCatBtn) {
    bulkCatBtn.addEventListener('click', slicerShowBulkCategoryPicker);
  }

  const plateGoBtn = document.getElementById('slicerPlateGoBtn');
  if (plateGoBtn) {
    plateGoBtn.addEventListener('click', slicerShowBuildPlatePreview);
  }

  // Plate settings panel buttons
  const plateBackBtn = document.getElementById('slicerPlateBackBtn');
  if (plateBackBtn) {
    plateBackBtn.addEventListener('click', () => {
      document.getElementById('slicerPlateSettingsPanel').style.display = 'none';
      document.getElementById('slicerCatalogPanel').style.display = '';
    });
  }

  const plateSliceBtn = document.getElementById('slicerPlateSliceBtn');
  if (plateSliceBtn) {
    plateSliceBtn.addEventListener('click', () => slicerSlicePlate());
  }

  // Plate settings buttons delegation
  document.querySelectorAll('.slicer-plate-btn-row').forEach(row => {
    row.addEventListener('click', (e) => {
      const btn = e.target.closest('.slicer-opt-btn');
      if (!btn) return;
      const setting = row.dataset.setting;
      const value = btn.dataset.value;
      if (setting && value) {
        slicerState.settings[setting] = value;
        slicerHighlightButtons(row, value);
      }
    });
  });

  // G-code list click delegation
  const gcodeList = document.getElementById('slicerGcodeList');
  if (gcodeList) {
    gcodeList.addEventListener('click', (e) => {
      const printBtn = e.target.closest('.slicer-gcode-print');
      if (printBtn) {
        const gcodeId = parseInt(printBtn.dataset.gcodeId, 10);
        slicerPrintExistingGcode(gcodeId);
      }
      const deleteBtn = e.target.closest('.slicer-gcode-delete');
      if (deleteBtn) {
        const gcodeId = parseInt(deleteBtn.dataset.gcodeId, 10);
        slicerDeleteGcodeEntry(gcodeId);
      }
    });
  }

  // Settings buttons delegation
  document.querySelectorAll('.slicer-btn-row').forEach(row => {
    row.addEventListener('click', (e) => {
      const btn = e.target.closest('.slicer-opt-btn');
      if (!btn) return;
      const setting = row.dataset.setting;
      const value = btn.dataset.value;
      if (setting && value) {
        slicerState.settings[setting] = value;
        slicerHighlightButtons(row, value);
      }
    });
  });
}

// ============================================================================
// CATALOG OPERATIONS
// ============================================================================

async function slicerLoadCatalog() {
  const search = document.getElementById('slicerSearch')?.value?.trim() || '';
  const category = document.getElementById('slicerCategoryFilter')?.value || '';

  // Require a category or search term — don't load everything at once
  if (!category && !search) {
    slicerState.catalog = [];
    await slicerRenderCatalog();
    slicerRenderFolderBar();
    return;
  }

  try {
    const query = { search, category };
    // Filter by folder: inside a folder shows that folder's items, root shows only unfiled items
    if (category && !search) {
      query.folder = slicerState.selectedFolder || '';
    }
    const result = await printStation.slicer.listCatalog(query);
    slicerState.catalog = result.items || [];
    await slicerRenderCatalog();
    slicerRenderFolderBar();
  } catch (err) {
    console.error('[Slicer] Load catalog error:', err);
  }
}

async function slicerLoadCategories() {
  try {
    const result = await printStation.slicer.getCategories();
    slicerState.categories = result.categories || [];
    const select = document.getElementById('slicerCategoryFilter');
    if (select) {
      const current = select.value;
      select.innerHTML = '<option value="">-- Choose a Category --</option>' +
        slicerState.categories.map(c =>
          `<option value="${slicerEsc(c)}"${c === current ? ' selected' : ''}>${slicerEsc(c)}</option>`
        ).join('');
    }
  } catch (err) {
    console.warn('[Slicer] Load categories error:', err);
  }
}

async function slicerLoadFolders() {
  const category = document.getElementById('slicerCategoryFilter')?.value || '';
  if (!category) {
    slicerState.folders = [];
    slicerState.selectedFolder = null;
    slicerRenderFolderBar();
    return;
  }
  try {
    const result = await printStation.slicer.listFolders(category);
    slicerState.folders = result.folders || [];
  } catch (err) {
    console.warn('[Slicer] Load folders error:', err);
    slicerState.folders = [];
  }
  slicerRenderFolderBar();
}

// ============================================================================
// FOLDER BAR
// ============================================================================

function slicerRenderFolderBar() {
  const bar = document.getElementById('slicerFolderBar');
  if (!bar) return;

  const category = document.getElementById('slicerCategoryFilter')?.value || '';
  if (!category) {
    bar.style.display = 'none';
    return;
  }

  bar.style.display = '';
  const inFolder = slicerState.selectedFolder;
  const folders = slicerState.folders || [];

  const breadcrumb = inFolder
    ? `<span class="slicer-folder-crumb" data-action="root">${slicerEsc(category)}</span>
       <span style="margin:0 6px;color:var(--muted);">/</span>
       <span style="font-weight:600;">${slicerEsc(inFolder)}</span>`
    : `<span style="font-weight:600;">${slicerEsc(category)}</span>`;

  let folderTilesHtml = '';
  const visibleFolders = inFolder ? folders.filter(f => f !== inFolder) : folders;
  if (visibleFolders.length > 0) {
    folderTilesHtml = `<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;">
      ${visibleFolders.map(f => `
        <div class="slicer-folder-tile" data-folder="${slicerEsc(f)}"
          style="display:flex;align-items:center;gap:8px;padding:10px 16px;border:1px solid var(--border);
          border-radius:8px;background:var(--bg-secondary,#1e293b);cursor:pointer;min-width:120px;transition:all 0.15s;">
          <span style="font-size:1.3rem;">&#128193;</span>
          <span style="font-weight:500;font-size:0.9rem;">${slicerEsc(f)}</span>
        </div>
      `).join('')}
    </div>`;
  }

  bar.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
      <div style="font-size:0.9rem;">${breadcrumb}</div>
      <div style="display:flex;gap:6px;">
        ${inFolder ? `<button class="slicer-folder-action secondary" data-action="back" style="padding:4px 12px;font-size:0.8rem;">&larr; Back</button>` : ''}
        <button class="slicer-folder-action secondary" data-action="new" style="padding:4px 12px;font-size:0.8rem;">+ New Folder</button>
        ${inFolder ? `<button class="slicer-folder-action secondary" data-action="rename" style="padding:4px 12px;font-size:0.8rem;">Rename</button>
        <button class="slicer-folder-action secondary" data-action="delete" style="padding:4px 12px;font-size:0.8rem;color:#ef4444;">Delete Folder</button>` : ''}
      </div>
    </div>
    ${folderTilesHtml}
  `;

  // Wire folder tile clicks + drop targets
  bar.querySelectorAll('.slicer-folder-tile').forEach(tile => {
    tile.addEventListener('click', () => {
      slicerState.selectedFolder = tile.dataset.folder;
      slicerLoadCatalog();
    });
    tile.addEventListener('dragover', (e) => {
      e.preventDefault();
      tile.classList.add('slicer-folder-drag-over');
    });
    tile.addEventListener('dragleave', () => {
      tile.classList.remove('slicer-folder-drag-over');
    });
    tile.addEventListener('drop', (e) => {
      e.preventDefault();
      tile.classList.remove('slicer-folder-drag-over');
      const stlId = e.dataTransfer.getData('text/x-stl-id');
      if (stlId) slicerMoveItemToFolder(parseInt(stlId, 10), tile.dataset.folder);
    });
  });

  // Breadcrumb root click + drop target
  const rootCrumb = bar.querySelector('[data-action="root"]');
  if (rootCrumb) {
    rootCrumb.addEventListener('click', () => {
      slicerState.selectedFolder = null;
      slicerLoadCatalog();
    });
    rootCrumb.addEventListener('dragover', (e) => {
      e.preventDefault();
      rootCrumb.style.textDecoration = 'underline';
    });
    rootCrumb.addEventListener('dragleave', () => {
      rootCrumb.style.textDecoration = '';
    });
    rootCrumb.addEventListener('drop', (e) => {
      e.preventDefault();
      rootCrumb.style.textDecoration = '';
      const stlId = e.dataTransfer.getData('text/x-stl-id');
      if (stlId) slicerMoveItemToFolder(parseInt(stlId, 10), null);
    });
  }

  // Action buttons
  bar.querySelectorAll('.slicer-folder-action').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      if (action === 'back') { slicerState.selectedFolder = null; slicerLoadCatalog(); }
      if (action === 'new') slicerCreateFolder();
      if (action === 'rename') slicerRenameFolderPrompt();
      if (action === 'delete') slicerDeleteFolderPrompt();
    });
  });
}

async function slicerCreateFolder() {
  const name = typeof window.showPrompt === 'function'
    ? await window.showPrompt('New folder name:')
    : prompt('New folder name:');
  if (!name || !name.trim()) return;
  const trimmed = name.trim();
  if (!slicerState.folders.includes(trimmed)) {
    slicerState.folders.push(trimmed);
    slicerState.folders.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }
  slicerState.selectedFolder = trimmed;
  slicerRenderFolderBar();
  await slicerLoadCatalog();
  if (typeof showToast === 'function') showToast(`Created folder "${trimmed}"`, 'success', 2000);
}

async function slicerRenameFolderPrompt() {
  const category = document.getElementById('slicerCategoryFilter')?.value || '';
  if (!category || !slicerState.selectedFolder) return;
  const newName = typeof window.showPrompt === 'function'
    ? await window.showPrompt(`Rename folder "${slicerState.selectedFolder}" to:`, slicerState.selectedFolder)
    : prompt(`Rename folder "${slicerState.selectedFolder}" to:`, slicerState.selectedFolder);
  if (!newName || !newName.trim() || newName.trim() === slicerState.selectedFolder) return;
  try {
    await printStation.slicer.renameFolder(category, slicerState.selectedFolder, newName.trim());
    if (typeof showToast === 'function') showToast(`Renamed folder to "${newName.trim()}"`, 'success', 2000);
    slicerState.selectedFolder = newName.trim();
    await slicerLoadFolders();
    await slicerLoadCatalog();
  } catch (err) {
    alert('Rename failed: ' + err.message);
  }
}

async function slicerDeleteFolderPrompt() {
  const category = document.getElementById('slicerCategoryFilter')?.value || '';
  if (!category || !slicerState.selectedFolder) return;
  if (!confirm(`Delete folder "${slicerState.selectedFolder}"? Items will be moved to the category root.`)) return;
  try {
    await printStation.slicer.removeFolder(category, slicerState.selectedFolder);
    if (typeof showToast === 'function') showToast(`Deleted folder "${slicerState.selectedFolder}"`, 'success', 2000);
    slicerState.selectedFolder = null;
    await slicerLoadFolders();
    await slicerLoadCatalog();
  } catch (err) {
    alert('Delete failed: ' + err.message);
  }
}

async function slicerMoveItemToFolder(stlId, folderName) {
  try {
    await printStation.slicer.updateCatalogItem(stlId, { folder: folderName || null });
    if (typeof showToast === 'function') showToast(`Moved to "${folderName || 'root'}"`, 'success', 2000);
    await slicerLoadFolders();
    await slicerLoadCatalog();
  } catch (err) {
    console.error('[Slicer] Move to folder error:', err);
    alert('Move failed: ' + err.message);
  }
}

async function slicerRenderCatalog() {
  const grid = document.getElementById('slicerCatalogGrid');
  if (!grid) return;

  if (!slicerState.catalog.length) {
    const category = document.getElementById('slicerCategoryFilter')?.value || '';
    const search = document.getElementById('slicerSearch')?.value?.trim() || '';
    const msg = (!category && !search)
      ? 'Select a category to browse STL models.'
      : 'No STL models found. Try a different category or search.';
    grid.innerHTML = `<div class="placeholder" style="grid-column:1/-1;text-align:center;padding:60px 20px;color:var(--muted);">
      ${msg}
    </div>`;
    return;
  }

  // Prefetch disk-cached thumbnails for items not already in any cache
  const uncachedIds = slicerState.catalog
    .filter(item => !slicerState.thumbCache[item.id] && !slicerState.thumbDiskCache[item.id])
    .map(item => item.id);
  if (uncachedIds.length) {
    await slicerPrefetchDiskThumbs(uncachedIds);
  }

  const isPlate = slicerState.plateMode;
  const plateIds = new Set(slicerState.plateItems.map(i => i.id));

  grid.innerHTML = slicerState.catalog.map(item => {
    const memCached = slicerState.thumbCache[item.id];
    const diskCached = slicerState.thumbDiskCache[item.id];
    const cachedUrl = memCached || diskCached;
    const thumbHtml = cachedUrl
      ? `<img src="${cachedUrl}" style="width:80px;height:80px;border-radius:8px;object-fit:cover;background:#0a0a1a;">`
      : `<canvas class="slicer-stl-thumb" data-stl-id="${item.id}" width="160" height="160" style="width:80px;height:80px;border-radius:8px;background:#0a0a1a;"></canvas>`;
    const selected = isPlate && plateIds.has(item.id);
    const checkHtml = isPlate ? `<div class="slicer-plate-check">${selected ? '✓' : ''}</div>` : '';
    return `
    <div class="inventory-card slicer-catalog-card${selected ? ' slicer-plate-selected' : ''}" data-stl-id="${item.id}" draggable="true" style="cursor:pointer;padding:16px;position:relative;">
      ${checkHtml}
      <button class="slicer-catalog-delete" data-stl-id="${item.id}" title="Delete"
        style="position:absolute;top:8px;right:8px;background:none;border:none;color:var(--danger);cursor:pointer;font-size:1rem;padding:4px 8px;opacity:0.6;">&times;</button>
      <div style="display:flex;gap:12px;align-items:flex-start;">
        <div style="width:80px;height:80px;border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
          ${thumbHtml}
        </div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;font-size:1rem;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${slicerEsc(item.name)}</div>
          ${item.category ? `<span class="badge" style="font-size:0.75rem;padding:2px 8px;background:var(--accent);border-radius:4px;">${slicerEsc(item.category)}</span>` : ''}
          <div class="muted" style="font-size:0.8rem;margin-top:4px;">
            ${item.dim_x ? `${item.dim_x.toFixed(1)} x ${item.dim_y.toFixed(1)} x ${item.dim_z.toFixed(1)} mm` : ''}
            ${item.file_size ? ` &middot; ${slicerFormatSize(item.file_size)}` : ''}
          </div>
          <div class="muted" style="font-size:0.8rem;margin-top:2px;">
            Defaults: ${slicerEsc(item.default_quality)} / ${slicerEsc(item.default_material)}
          </div>
        </div>
      </div>
    </div>`;
  }).join('');

  // Render thumbnails for canvases that don't have cached images
  slicerRenderThumbnails();
}

async function slicerUploadStl() {
  try {
    const filePath = await printStation.slicer.selectStlFile();
    if (!filePath) return;

    const ext = filePath.split('.').pop().toLowerCase();

    // ZIP flow: extract and upload each model inside
    if (ext === 'zip') {
      slicerShowProgress('Extracting ZIP archive...', 'Finding 3D models');
      let result;
      try {
        result = await printStation.slicer.extractZip(filePath);
      } catch (err) {
        slicerHideProgress();
        alert('Failed to extract ZIP: ' + err.message);
        return;
      }
      slicerHideProgress();

      if (!result.files.length) {
        showToast('No 3D model files found in ZIP.', 'warning', 4000);
        try { await printStation.slicer.cleanupTemp(result.tempDir); } catch (_) {}
        return;
      }

      const category = document.getElementById('slicerCategoryFilter')?.value || '';
      const uploadFiles = result.files.map(f => ({
        filePath: f.filePath,
        name: f.name,
        category,
        source: 'zip',
        zipName: filePath.split(/[\\/]/).pop()
      }));
      slicerRunBulkUploadBackground(uploadFiles, result.tempDir);
      return;
    }

    // Normal single-file flow
    const basename = filePath.split(/[\\/]/).pop().replace(/\.(stl|step|stp)$/i, '').replace(/[_-]/g, ' ');

    slicerShowProgress('Uploading 3D model...', 'Sending file to server');

    const result = await printStation.slicer.uploadStl({
      filePath,
      name: basename,
      category: document.getElementById('slicerCategoryFilter')?.value || ''
    });

    slicerHideProgress();

    if (result.item) {
      // Auto-assign to current folder if inside one
      if (slicerState.selectedFolder && result.item.id) {
        try {
          await printStation.slicer.updateCatalogItem(result.item.id, { folder: slicerState.selectedFolder });
        } catch (_) {}
      }
      await slicerLoadFolders();
      await slicerLoadCatalog();
      await slicerLoadCategories();
    }
  } catch (err) {
    slicerHideProgress();
    console.error('[Slicer] Upload error:', err);
    alert('Upload failed: ' + err.message);
  }
}

async function slicerDeleteItem(id) {
  if (!confirm('Delete this STL and all its cached G-code?')) return;
  try {
    await printStation.slicer.deleteCatalogItem(id);
    // Clean up local caches
    delete slicerState.thumbCache[id];
    delete slicerState.thumbDiskCache[id];
    delete slicerState.stlBytesCache[id];
    await slicerLoadCatalog();
  } catch (err) {
    console.error('[Slicer] Delete error:', err);
    alert('Delete failed: ' + err.message);
  }
}

async function slicerBulkImport() {
  console.log('[Slicer] Bulk import clicked');
  try {
    // Pick a folder
    const dirs = await printStation.selectFolder({ title: 'Select folder with 3D model files' });
    console.log('[Slicer] Folder selection result:', dirs);
    if (!dirs || !dirs.length) return;
    const directory = dirs[0];

    showToast('Scanning directory for 3D model files...', 'info', 3000);

    const files = await printStation.slicer.bulkScan(directory);

    if (!files || !files.length) {
      showToast('No 3D model files found in the selected directory.', 'warning', 4000);
      return;
    }

    // Launch upload in background — user can continue working
    slicerRunBulkUploadBackground(files);
  } catch (err) {
    console.error('[Slicer] Bulk import error:', err);
    showToast('Bulk import failed: ' + err.message, 'error', 5000);
  }
}

function slicerCreateBulkToast(total) {
  // Persistent toast pinned to bottom-right
  const toast = document.createElement('div');
  toast.id = 'slicerBulkToast';
  toast.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:9999;background:var(--card,#1e293b);border:1px solid var(--border,#334155);border-radius:10px;padding:14px 18px;min-width:300px;max-width:380px;box-shadow:0 8px 24px rgba(0,0,0,0.4);font-size:0.85rem;';
  toast.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
      <strong id="slicerBulkTitle">Uploading 0 / ${total} files</strong>
      <span id="slicerBulkPct" style="font-size:0.8rem;color:var(--muted);">0%</span>
    </div>
    <div id="slicerBulkFile" style="color:var(--muted);font-size:0.8rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:8px;">Starting...</div>
    <div style="height:4px;border-radius:2px;background:var(--bg-secondary,#0f172a);overflow:hidden;">
      <div id="slicerBulkBar" style="height:100%;width:0%;background:var(--accent,#6366f1);border-radius:2px;transition:width 0.3s;"></div>
    </div>`;
  document.body.appendChild(toast);
  return toast;
}

async function slicerRunBulkUploadBackground(files, tempDir = null) {
  const total = files.length;
  const toast = slicerCreateBulkToast(total);
  const titleEl = toast.querySelector('#slicerBulkTitle');
  const pctEl = toast.querySelector('#slicerBulkPct');
  const fileEl = toast.querySelector('#slicerBulkFile');
  const barEl = toast.querySelector('#slicerBulkBar');

  let uploaded = 0;
  let failed = 0;

  for (const file of files) {
    uploaded++;
    const pct = Math.round((uploaded / total) * 100);
    if (titleEl) titleEl.textContent = `Uploading ${uploaded} / ${total} files`;
    if (pctEl) pctEl.textContent = pct + '%';
    if (fileEl) fileEl.textContent = file.name + (file.source === 'zip' ? ` (${file.zipName})` : '');
    if (barEl) barEl.style.width = pct + '%';

    try {
      await printStation.slicer.bulkUploadOne({
        filePath: file.filePath,
        name: file.name,
        category: file.category || ''
      });
    } catch (err) {
      failed++;
      console.warn('[Slicer] Bulk upload failed for', file.name, err.message);
    }
  }

  // Clean up temp directory from ZIP extraction
  if (tempDir) {
    try { await printStation.slicer.cleanupTemp(tempDir); } catch (_) {}
  }

  // Done — update toast to show result, then fade out
  const successCount = total - failed;
  if (titleEl) titleEl.textContent = `Import complete: ${successCount} / ${total}`;
  if (fileEl) fileEl.textContent = failed > 0 ? `${failed} failed` : 'All files uploaded successfully';
  if (barEl) barEl.style.width = '100%';
  if (barEl) barEl.style.background = failed > 0 ? 'var(--warning,#f59e0b)' : 'var(--success,#22c55e)';

  // Refresh catalog if user is on slicer view
  try {
    await slicerLoadFolders();
    await slicerLoadCatalog();
    await slicerLoadCategories();
  } catch (_) {}

  // Auto-dismiss after 5 seconds
  setTimeout(() => {
    toast.style.transition = 'opacity 0.4s, transform 0.4s';
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => toast.remove(), 400);
  }, 5000);
}

// ============================================================================
// ITEM SELECTION & G-CODE DISPLAY
// ============================================================================

async function slicerSelectItem(id) {
  try {
    const result = await printStation.slicer.getCatalogItem(id);
    if (!result || !result.item) return;

    slicerState.selectedItem = result.item;
    slicerState.gcodeEntries = result.gcodeEntries || [];

    // Set defaults from catalog item
    if (result.item.default_quality) slicerState.settings.quality = result.item.default_quality;
    if (result.item.default_strength) slicerState.settings.strength = result.item.default_strength;
    if (result.item.default_material) slicerState.settings.material = result.item.default_material;
    if (result.item.default_texture) slicerState.settings.texture = result.item.default_texture;
    if (result.item.default_supports) slicerState.settings.supports = result.item.default_supports;
    if (result.item.default_surface) slicerState.settings.surface = result.item.default_surface;

    // Switch panels
    document.getElementById('slicerCatalogPanel').style.display = 'none';
    document.getElementById('slicerSettingsPanel').style.display = '';

    // Populate info
    slicerRenderSelectedInfo(result.item);
    slicerRenderGcodeList(slicerState.gcodeEntries);
    slicerSyncSettingsButtons();

    // Render 3D preview for selected item
    slicerFetchStlBuffer(result.item.id).then(buf => {
      slicerRenderSelectedPreview(buf);
    }).catch(err => {
      console.warn('[Slicer] Selected preview failed:', err.message);
    });

    // Refresh printers
    try {
      const printers = await printStation.printerFleet.listPrinters({ active: true });
      slicerState.printers = printers || [];
      slicerPopulatePrinterDropdown();
    } catch {}
  } catch (err) {
    console.error('[Slicer] Select item error:', err);
  }
}

function slicerRenderSelectedInfo(item) {
  const nameEl = document.getElementById('slicerSelectedName');
  const catEl = document.getElementById('slicerSelectedCategory');
  const dimsEl = document.getElementById('slicerSelectedDims');
  const notesEl = document.getElementById('slicerSelectedNotes');

  if (nameEl) nameEl.textContent = item.name || 'Unnamed';
  if (catEl) catEl.textContent = item.category ? `Category: ${item.category}` : '';
  if (dimsEl) {
    const parts = [];
    if (item.dim_x) parts.push(`${item.dim_x.toFixed(1)} x ${item.dim_y.toFixed(1)} x ${item.dim_z.toFixed(1)} mm`);
    if (item.file_size) parts.push(slicerFormatSize(item.file_size));
    if (item.triangle_count) parts.push(`${item.triangle_count.toLocaleString()} triangles`);
    dimsEl.textContent = parts.join(' \u00B7 ');
  }
  if (notesEl) notesEl.textContent = item.notes || '';
}

function slicerRenderGcodeList(entries) {
  const container = document.getElementById('slicerGcodeList');
  if (!container) return;

  if (!entries || !entries.length) {
    container.innerHTML = '<div class="muted" style="text-align:center;padding:16px;">No cached G-code for this model. Use the settings below to slice.</div>';
    return;
  }

  container.innerHTML = entries.map(entry => `
    <div class="slicer-gcode-entry" style="display:flex;gap:12px;align-items:center;padding:12px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px;">
      <div style="flex:1;min-width:0;">
        <div style="font-weight:600;font-size:0.9rem;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${slicerEsc(entry.gcode_filename)}</div>
        <div class="muted" style="font-size:0.8rem;display:flex;flex-wrap:wrap;gap:6px;">
          <span class="badge" style="font-size:0.7rem;padding:1px 6px;">${slicerEsc(slicerLabelFor('printers', entry.printer_model))}</span>
          <span class="badge" style="font-size:0.7rem;padding:1px 6px;">${slicerEsc(slicerLabelFor('materials', entry.material))}</span>
          <span class="badge" style="font-size:0.7rem;padding:1px 6px;">${slicerEsc(slicerLabelFor('quality', entry.quality))}</span>
          <span class="badge" style="font-size:0.7rem;padding:1px 6px;">${slicerEsc(slicerLabelFor('strength', entry.strength))}</span>
          <span class="badge" style="font-size:0.7rem;padding:1px 6px;">${slicerEsc(slicerLabelFor('speed', entry.speed))}</span>
          <span class="badge" style="font-size:0.7rem;padding:1px 6px;">${slicerEsc(slicerLabelFor('texture', entry.texture))}</span>
          <span class="badge" style="font-size:0.7rem;padding:1px 6px;">${slicerEsc(slicerLabelFor('supports', entry.supports))}</span>
        </div>
        <div class="muted" style="font-size:0.8rem;margin-top:4px;">
          ${entry.est_time_min ? slicerFormatTime(entry.est_time_min) : '?'}
          ${entry.est_weight_g ? ` \u00B7 ${entry.est_weight_g.toFixed(1)}g` : ''}
          ${entry.file_size ? ` \u00B7 ${slicerFormatSize(entry.file_size)}` : ''}
          ${entry.sliced_at ? ` \u00B7 ${new Date(entry.sliced_at).toLocaleDateString()}` : ''}
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:4px;flex-shrink:0;">
        <button class="primary slicer-gcode-print" data-gcode-id="${entry.id}" style="padding:6px 14px;font-size:0.85rem;">Print This</button>
        <button class="secondary slicer-gcode-delete" data-gcode-id="${entry.id}" style="padding:4px 10px;font-size:0.75rem;color:var(--danger);">Delete</button>
      </div>
    </div>
  `).join('');
}

// ============================================================================
// SETTINGS UI
// ============================================================================

function slicerBuildSettingsButtons() {
  const presets = slicerState.presets;
  if (!presets) return;

  const groups = {
    quality: 'slicerQuality',
    strength: 'slicerStrength',
    speed: 'slicerSpeed',
    texture: 'slicerTexture',
    surface: 'slicerSurface',
    supports: 'slicerSupports',
    material: 'slicerMaterial'
  };

  // Map preset category to DOM element
  const presetToField = {
    quality: 'quality',
    strength: 'strength',
    speed: 'speed',
    texture: 'texture',
    surface: 'surface',
    supports: 'supports',
    materials: 'material'
  };

  for (const [presetKey, fieldKey] of Object.entries(presetToField)) {
    const options = presets[presetKey];
    const containerId = groups[fieldKey];
    const container = document.getElementById(containerId);
    if (!container || !options) continue;

    container.innerHTML = options.map(opt => {
      const key = opt.key || opt.model;
      const label = opt.label || opt.name;
      const desc = opt.description || '';
      return `<button class="slicer-opt-btn" data-value="${slicerEsc(key)}" title="${slicerEsc(desc)}">${slicerEsc(label)}</button>`;
    }).join('');
  }

  slicerSyncSettingsButtons();
}

function slicerSyncSettingsButtons() {
  const settings = slicerState.settings;
  const rows = document.querySelectorAll('.slicer-btn-row');
  rows.forEach(row => {
    const setting = row.dataset.setting;
    if (setting && settings[setting]) {
      slicerHighlightButtons(row, settings[setting]);
    }
  });
  // Sync auto-orient checkboxes
  const aoCb = document.getElementById('slicerAutoOrient');
  if (aoCb) aoCb.checked = settings.auto_orient;
  const plateAoCb = document.getElementById('slicerPlateAutoOrient');
  if (plateAoCb) plateAoCb.checked = settings.auto_orient;
  // Sync copies input
  const copiesInput = document.getElementById('slicerCopies');
  if (copiesInput) copiesInput.value = settings.copies || 1;
}

function slicerHighlightButtons(container, activeValue) {
  container.querySelectorAll('.slicer-opt-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.value === activeValue);
  });
}

function slicerPopulatePrinterDropdown() {
  const select = document.getElementById('slicerPrinter');
  if (!select) return;

  const printers = slicerState.printers || [];
  select.innerHTML = '<option value="">Select a printer...</option>' +
    printers.map(p => {
      const label = `${p.name}${p.model ? ' (' + p.model + ')' : ''}`;
      return `<option value="${p.id}">${slicerEsc(label)}</option>`;
    }).join('');

  // Wire ACE slot picker to printer selection changes
  select.removeEventListener('change', slicerOnPrinterChange);
  select.addEventListener('change', slicerOnPrinterChange);
  // Reset slot picker
  slicerOnPrinterChange();
}

function slicerOnPrinterChange() {
  const printerId = document.getElementById('slicerPrinter')?.value;
  const slotGroup = document.getElementById('slicerAceSlotGroup');
  const slotSelect = document.getElementById('slicerAceSlot');
  if (!slotGroup || !slotSelect) return;

  if (!printerId) {
    slotGroup.style.display = 'none';
    slotSelect.value = '';
    return;
  }

  const printer = slicerState.printers.find(p => String(p.id) === String(printerId));
  if (!printer || !printer.has_multicolor) {
    slotGroup.style.display = 'none';
    slotSelect.value = '';
    return;
  }

  let aceSlots = [];
  try { aceSlots = printer.ace_slots ? JSON.parse(printer.ace_slots) : []; } catch (_) {}

  if (!aceSlots.length) {
    slotGroup.style.display = 'none';
    slotSelect.value = '';
    return;
  }

  slotGroup.style.display = '';
  slotSelect.innerHTML = '<option value="">Select filament slot...</option>' +
    aceSlots.map(s => {
      const label = `T${s.slot}: ${s.name || s.material || '?'}${s.color ? ' (' + s.color + ')' : ''}`;
      return `<option value="${s.slot}" data-material="${slicerEsc((s.material || 'PLA').toLowerCase())}">${slicerEsc(label)}</option>`;
    }).join('');

  // ACE slot selection — don't override the user's manual material choice.
  // The slot just determines which physical filament bay (T0-T3) to use.
  slotSelect.onchange = () => {};
}

// ============================================================================
// SLICING & PRINTING
// ============================================================================

/**
 * Look up a human-readable label + description for a setting value.
 */
function slicerGetSettingInfo(category, key) {
  const presets = slicerState.presets;
  if (!presets) return { label: key, description: '' };
  // materials is stored as 'materials' in presets but 'material' in settings
  const presetKey = category === 'material' ? 'materials' : category;
  const list = presets[presetKey];
  if (!list) return { label: key, description: '' };
  const match = list.find(p => (p.key || p.model) === key);
  if (!match) return { label: key, description: '' };
  return { label: match.label || match.name || key, description: match.description || '' };
}

/**
 * Show a pre-slice approval modal with a 3D preview and settings summary.
 * Returns a Promise that resolves true (user confirmed) or false (cancelled).
 */
function slicerShowApprovalModal({ items, settings, printerName, printerModel, aceSlotLabel, isPlate, andPrint }) {
  return new Promise((resolve) => {
    const existing = document.getElementById('slicerApprovalModal');
    if (existing) existing.remove();

    const presets = slicerState.presets || {};

    // Look up nozzle and bed temperatures from the material preset
    const materialKey = settings.material || 'pla';
    const materialPreset = (presets.materials || []).find(m => m.key === materialKey);
    const nozzleTemp = materialPreset ? materialPreset.hotend : null;
    const bedTempVal = materialPreset ? materialPreset.bed : null;

    // Build settings rows: { category, value, valueLabel, description }
    const settingFields = [
      { category: 'Material', key: 'material' },
      { category: 'Quality', key: 'quality' },
      { category: 'Strength', key: 'strength' },
      { category: 'Speed', key: 'speed' },
      { category: 'Texture', key: 'texture' },
      { category: 'Surface', key: 'surface' },
      { category: 'Supports', key: 'supports' },
    ];
    const settingRows = settingFields.map(f => {
      const info = slicerGetSettingInfo(f.key, settings[f.key]);
      return { category: f.category, valueLabel: info.label || settings[f.key], description: info.description || '' };
    });

    const modelNames = items.map(i => slicerEsc(i.name || 'Unknown')).join(', ');

    const modal = document.createElement('div');
    modal.id = 'slicerApprovalModal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:9999;display:flex;flex-direction:column;';

    const confirmLabel = andPrint ? 'Confirm &amp; Print' : 'Confirm &amp; Slice';

    modal.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 20px;border-bottom:1px solid rgba(255,255,255,0.1);">
        <h3 style="margin:0;color:#fff;">Review Before ${andPrint ? 'Printing' : 'Slicing'}</h3>
        <div style="display:flex;gap:8px;">
          <button id="approvalCancelBtn" style="background:none;border:1px solid rgba(255,255,255,0.3);color:#fff;padding:6px 16px;border-radius:6px;cursor:pointer;font-size:0.9rem;">Cancel</button>
          <button id="approvalConfirmBtn" style="background:var(--accent,#6366f1);color:#fff;border:none;padding:8px 22px;border-radius:6px;cursor:pointer;font-size:0.95rem;font-weight:600;">${confirmLabel}</button>
        </div>
      </div>
      <div style="flex:1;display:flex;overflow:hidden;">
        <!-- 3D Preview -->
        <div id="approvalPreviewContainer" style="flex:1;position:relative;overflow:hidden;min-height:300px;"></div>
        <!-- Settings Summary -->
        <div style="width:340px;background:rgba(15,23,42,0.95);border-left:1px solid rgba(255,255,255,0.1);overflow-y:auto;padding:20px;">
          <div style="margin-bottom:20px;">
            <div style="font-weight:700;font-size:1rem;color:#fff;margin-bottom:4px;">
              ${isPlate ? items.length + ' Model' + (items.length !== 1 ? 's' : '') + ' on Plate' : slicerEsc(items[0]?.name || 'Model')}
            </div>
            <div class="muted" style="font-size:0.8rem;color:rgba(255,255,255,0.5);">${modelNames}</div>
          </div>
          ${printerName ? `
          <div style="margin-bottom:18px;padding:10px 12px;border:1px solid rgba(56,189,248,0.3);border-radius:8px;background:rgba(56,189,248,0.08);">
            <div style="font-size:0.8rem;color:rgba(255,255,255,0.5);margin-bottom:2px;">Printer</div>
            <div style="font-weight:600;color:#38bdf8;">${slicerEsc(printerName)}${printerModel ? ' <span class="muted" style="font-weight:400;">(' + slicerEsc(printerModel) + ')</span>' : ''}</div>
            ${aceSlotLabel ? '<div style="font-size:0.85rem;color:rgba(255,255,255,0.7);margin-top:4px;">ACE Slot: <strong>' + slicerEsc(aceSlotLabel) + '</strong></div>' : ''}
          </div>` : ''}
          <div style="font-weight:600;font-size:0.9rem;color:#fff;margin-bottom:10px;">Slice Settings</div>
          ${settingRows.map(row => `
            <div style="display:flex;justify-content:space-between;align-items:flex-start;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06);">
              <span style="font-size:0.85rem;color:rgba(255,255,255,0.5);min-width:80px;">${slicerEsc(row.category)}</span>
              <div style="text-align:right;">
                <div style="font-size:0.9rem;color:#fff;font-weight:500;">${slicerEsc(row.valueLabel)}</div>
                ${row.description ? `<div style="font-size:0.75rem;color:rgba(255,255,255,0.4);max-width:200px;">${slicerEsc(row.description)}</div>` : ''}
              </div>
            </div>
          `).join('')}
          <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;${nozzleTemp != null ? 'border-bottom:1px solid rgba(255,255,255,0.06);' : ''}">
            <span style="font-size:0.85rem;color:rgba(255,255,255,0.5);">Auto-Orient</span>
            <span style="font-size:0.9rem;color:#fff;font-weight:500;">${settings.auto_orient ? 'Yes' : 'No'}</span>
          </div>
          ${nozzleTemp != null ? `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06);">
            <span style="font-size:0.85rem;color:rgba(255,255,255,0.5);">Nozzle Temp</span>
            <span style="font-size:0.9rem;color:#f59e0b;font-weight:500;">${nozzleTemp}&deg;C</span>
          </div>` : ''}
          ${bedTempVal != null ? `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;">
            <span style="font-size:0.85rem;color:rgba(255,255,255,0.5);">Bed Temp</span>
            <span style="font-size:0.9rem;color:#f59e0b;font-weight:500;">${bedTempVal}&deg;C</span>
          </div>` : ''}
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    // Render 3D preview into the container
    const previewContainer = document.getElementById('approvalPreviewContainer');
    const bedDims = slicerGetBedDimensions();

    // Reuse the build plate scene for the preview
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a1a);

    const width = previewContainer.clientWidth || 800;
    const height = previewContainer.clientHeight || 600;
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100000);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    previewContainer.appendChild(renderer.domElement);

    // Lighting
    scene.add(new THREE.AmbientLight(0x606060, 1.5));
    const dl1 = new THREE.DirectionalLight(0xffffff, 1.2);
    dl1.position.set(5, 10, 7);
    scene.add(dl1);
    const dl2 = new THREE.DirectionalLight(0x88aaff, 0.5);
    dl2.position.set(-5, -3, -5);
    scene.add(dl2);

    // OrbitControls
    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;

    // Bed plane
    const bedGeo = new THREE.PlaneGeometry(bedDims.x, bedDims.y);
    const bedMat = new THREE.MeshPhongMaterial({ color: 0x1a1a2e, specular: 0x111111, shininess: 5, transparent: true, opacity: 0.8 });
    const bedMesh = new THREE.Mesh(bedGeo, bedMat);
    bedMesh.rotation.x = -Math.PI / 2;
    bedMesh.position.set(bedDims.x / 2, 0, bedDims.y / 2);
    scene.add(bedMesh);

    // Grid
    const gridPoints = [];
    for (let x = 0; x <= bedDims.x; x += 10) { gridPoints.push(new THREE.Vector3(x, 0.05, 0)); gridPoints.push(new THREE.Vector3(x, 0.05, bedDims.y)); }
    for (let z = 0; z <= bedDims.y; z += 10) { gridPoints.push(new THREE.Vector3(0, 0.05, z)); gridPoints.push(new THREE.Vector3(bedDims.x, 0.05, z)); }
    scene.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(gridPoints), new THREE.LineBasicMaterial({ color: 0x333355, transparent: true, opacity: 0.3 })));

    // Border
    const borderPts = [new THREE.Vector3(0,0.1,0), new THREE.Vector3(bedDims.x,0.1,0), new THREE.Vector3(bedDims.x,0.1,bedDims.y), new THREE.Vector3(0,0.1,bedDims.y), new THREE.Vector3(0,0.1,0)];
    scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(borderPts), new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.6 })));

    // Camera position
    const bedCenter = new THREE.Vector3(bedDims.x / 2, 0, bedDims.y / 2);
    const maxBed = Math.max(bedDims.x, bedDims.y);
    const fov = camera.fov * (Math.PI / 180);
    const dist = maxBed / (2 * Math.tan(fov / 2)) * 1.6;
    camera.position.set(bedDims.x / 2 + dist * 0.5, dist * 0.7, bedDims.y / 2 + dist * 0.5);
    camera.lookAt(bedCenter);
    controls.target.copy(bedCenter);
    controls.update();

    // Animation loop
    let animId;
    function animate() { animId = requestAnimationFrame(animate); controls.update(); renderer.render(scene, camera); }
    animate();

    // Resize
    const resizeObs = new ResizeObserver(() => {
      const w = previewContainer.clientWidth; const h = previewContainer.clientHeight;
      camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h);
    });
    resizeObs.observe(previewContainer);

    // Load models into the scene
    const loader = new THREE.STLLoader();
    (async () => {
      for (const item of items) {
        try {
          const buf = await slicerFetchStlBuffer(item.id);
          const geometry = loader.parse(buf);
          geometry.computeVertexNormals();

          // Apply saved transforms
          const savedT = slicerState.plateTransforms[item.id];
          if (savedT) {
            if (savedT.rx) geometry.rotateX(savedT.rx);
            if (savedT.ry) geometry.rotateY(savedT.ry);
            if (savedT.rz) geometry.rotateZ(savedT.rz);
            if (savedT.scale && savedT.scale !== 1) geometry.scale(savedT.scale, savedT.scale, savedT.scale);
          }

          // Center in XZ, floor to Y=0
          geometry.computeBoundingBox();
          const gBox = geometry.boundingBox;
          const cx = (gBox.max.x + gBox.min.x) / 2;
          const cz = (gBox.max.z + gBox.min.z) / 2;
          const minY = gBox.min.y;
          geometry.translate(-cx, -minY, -cz);

          const mat = new THREE.MeshPhongMaterial({ color: 0x38bdf8, specular: 0x222222, shininess: 40 });
          const mesh = new THREE.Mesh(geometry, mat);

          // Restore position
          if (savedT && savedT.posX !== undefined) {
            mesh.position.set(savedT.posX, 0, savedT.posZ || 0);
            mesh.updateMatrixWorld(true);
            const bbox = new THREE.Box3().setFromObject(mesh);
            mesh.position.y = -bbox.min.y;
          } else if (!isPlate) {
            // Single model: center on bed
            const bbox = new THREE.Box3().setFromObject(mesh);
            const size = bbox.getSize(new THREE.Vector3());
            mesh.position.set(bedDims.x / 2, -bbox.min.y, bedDims.y / 2);
          }

          scene.add(mesh);
        } catch (err) {
          console.warn('[Approval] Failed to load STL for', item.name, err.message);
        }
      }
    })();

    // Cleanup helper
    function cleanup() {
      cancelAnimationFrame(animId);
      resizeObs.disconnect();
      renderer.dispose();
      modal.remove();
    }

    // Wire buttons
    document.getElementById('approvalCancelBtn').addEventListener('click', () => { cleanup(); resolve(false); });
    document.getElementById('approvalConfirmBtn').addEventListener('click', () => { cleanup(); resolve(true); });
  });
}

// ============================================================================
// G-CODE PARSER
// ============================================================================

/**
 * Parse PrusaSlicer G-code text into layer data for Three.js visualization.
 * Extracts extrusion moves grouped by layer and type for colored toolpath rendering.
 *
 * @param {string} text - Raw G-code text
 * @returns {{ layers, bounds, layerCount, totalSegments }}
 */
function slicerParseGcode(text) {
  const lines = text.split('\n');
  const layers = [];
  let currentLayer = null;
  let currentType = 'unknown';
  let layerIndex = -1;
  let curX = 0, curY = 0, curZ = 0, curE = 0;
  let currentZ = 0;

  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  let totalSegments = 0;

  // Batch points per (layer, type) to minimize object creation
  let typePoints = [];

  function flushSegment() {
    if (typePoints.length >= 6 && currentLayer) {
      currentLayer.segments.push({
        type: currentType,
        points: new Float32Array(typePoints)
      });
      totalSegments++;
    }
    typePoints = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const trimmed = line.trim();

    // Layer change marker
    if (trimmed === ';LAYER_CHANGE') {
      flushSegment();
      continue;
    }

    // Z height — creates a new layer
    if (trimmed.charCodeAt(0) === 59 && trimmed.charCodeAt(1) === 90 && trimmed.charCodeAt(2) === 58) {
      // ;Z:
      flushSegment();
      currentZ = parseFloat(trimmed.slice(3));
      layerIndex++;
      currentLayer = { z: currentZ, index: layerIndex, segments: [] };
      layers.push(currentLayer);
      continue;
    }

    // Type change
    if (trimmed.startsWith(';TYPE:')) {
      flushSegment();
      currentType = trimmed.slice(6);
      continue;
    }

    // Skip other comments and empty lines
    if (trimmed.charCodeAt(0) === 59) continue; // ;

    // Parse G0/G1 moves
    const c0 = trimmed.charCodeAt(0);
    if (c0 !== 71) continue; // 'G'
    const c1 = trimmed.charCodeAt(1);
    if (c1 !== 48 && c1 !== 49) continue; // '0' or '1'
    const c2 = trimmed.charCodeAt(2);
    if (c2 !== 32 && c2 !== 9) continue; // space or tab

    let newX = curX, newY = curY, newZ = curZ, newE = curE;
    let hasE = false;

    // Fast parameter extraction
    const parts = trimmed.split(' ');
    for (let j = 1; j < parts.length; j++) {
      const p = parts[j];
      if (p.length < 2) continue;
      if (p.charCodeAt(0) === 59) break; // ; inline comment
      const ch = p.charCodeAt(0);
      const val = parseFloat(p.slice(1));
      if (isNaN(val)) continue;
      if (ch === 88)      newX = val;       // X
      else if (ch === 89) newY = val;       // Y
      else if (ch === 90) newZ = val;       // Z
      else if (ch === 69) { newE = val; hasE = true; } // E
    }

    // Only record extrusion moves (E increasing) — skip travel and retracts
    if (hasE && newE > curE && currentLayer) {
      // Map: G-code X → Three X, G-code Y → Three Z, G-code Z → Three Y
      typePoints.push(
        curX, currentZ, curY,
        newX, currentZ, newY
      );

      if (newX < minX) minX = newX;
      if (newX > maxX) maxX = newX;
      if (newY < minY) minY = newY;
      if (newY > maxY) maxY = newY;
      if (currentZ < minZ) minZ = currentZ;
      if (currentZ > maxZ) maxZ = currentZ;
    }

    curX = newX;
    curY = newY;
    if (newZ !== curZ) curZ = newZ;
    curE = newE;
  }

  flushSegment();

  return {
    layers,
    bounds: { minX, maxX, minY, maxY, minZ, maxZ },
    layerCount: layers.length,
    totalSegments
  };
}

// ============================================================================
// G-CODE 3D VIEWER MODAL
// ============================================================================

/**
 * Show a full-screen G-code visualization modal with layer navigation.
 * Returns 'print' if user clicks Send to Printer, 'close' otherwise.
 */
function slicerShowGcodePreview({ gcodeText, gcodeId, sliceResult, printerId, aceSlot, printerName }) {
  return new Promise((resolve) => {
    const existing = document.getElementById('gcodePreviewModal');
    if (existing) existing.remove();

    // Parse G-code
    console.log('[GcodePreview] Parsing G-code...');
    const parsed = slicerParseGcode(gcodeText);
    console.log(`[GcodePreview] Parsed ${parsed.layerCount} layers, ${parsed.totalSegments} segments`);

    // Build color legend from types that appear
    const usedTypes = new Set();
    for (const layer of parsed.layers) {
      for (const seg of layer.segments) usedTypes.add(seg.type);
    }
    const legendHtml = [...usedTypes].map(type => {
      const color = GCODE_TYPE_COLORS[type] || GCODE_TYPE_COLORS['unknown'];
      const hex = '#' + color.toString(16).padStart(6, '0');
      return `<div style="display:flex;align-items:center;gap:8px;padding:2px 0;">
        <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${hex};flex-shrink:0;"></span>
        <span style="font-size:0.78rem;color:rgba(255,255,255,0.7);">${slicerEsc(type)}</span>
      </div>`;
    }).join('');

    const fname = sliceResult?.gcode_filename || 'G-code';
    const estTime = sliceResult?.est_time_min ? slicerFormatTime(sliceResult.est_time_min) : '--';
    const estWeight = sliceResult?.est_weight_g ? sliceResult.est_weight_g.toFixed(1) + 'g' : '--';
    const fileSize = sliceResult?.file_size ? slicerFormatSize(sliceResult.file_size) : '--';
    const showPrintBtn = printerId != null;

    const modal = document.createElement('div');
    modal.id = 'gcodePreviewModal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.95);z-index:9999;display:flex;flex-direction:column;';

    modal.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 20px;border-bottom:1px solid rgba(255,255,255,0.1);">
        <h3 style="margin:0;color:#fff;">G-code Preview</h3>
        <div style="display:flex;gap:8px;">
          <button id="gcodeCloseBtn" style="background:none;border:1px solid rgba(255,255,255,0.3);color:#fff;padding:6px 16px;border-radius:6px;cursor:pointer;font-size:0.9rem;">Close</button>
          ${showPrintBtn ? `<button id="gcodePrintBtn" style="background:var(--accent,#6366f1);color:#fff;border:none;padding:8px 22px;border-radius:6px;cursor:pointer;font-size:0.95rem;font-weight:600;">Send to Printer</button>` : ''}
        </div>
      </div>
      <div style="flex:1;display:flex;overflow:hidden;">
        <div id="gcodePreviewCanvas" style="flex:1;position:relative;overflow:hidden;min-height:300px;"></div>
        <div style="width:340px;background:rgba(15,23,42,0.95);border-left:1px solid rgba(255,255,255,0.1);overflow-y:auto;padding:20px;">
          <div style="margin-bottom:16px;">
            <div style="font-weight:600;font-size:0.9rem;color:#fff;margin-bottom:6px;word-break:break-all;">${slicerEsc(fname)}</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:0.82rem;">
              <div><span class="muted" style="color:rgba(255,255,255,0.5);">Time:</span> <span style="color:#fff;">${estTime}</span></div>
              <div><span class="muted" style="color:rgba(255,255,255,0.5);">Weight:</span> <span style="color:#fff;">${estWeight}</span></div>
              <div><span class="muted" style="color:rgba(255,255,255,0.5);">Size:</span> <span style="color:#fff;">${fileSize}</span></div>
              <div><span class="muted" style="color:rgba(255,255,255,0.5);">Layers:</span> <span style="color:#fff;">${parsed.layerCount}</span></div>
            </div>
          </div>

          <div style="margin-bottom:16px;">
            <div style="font-weight:600;font-size:0.85rem;color:#fff;margin-bottom:8px;">Layer Navigation</div>
            <div id="gcodeLayerLabel" style="font-size:0.82rem;color:rgba(255,255,255,0.7);margin-bottom:6px;">
              Layer ${parsed.layerCount} / ${parsed.layerCount} &mdash; Z: ${parsed.layers.length ? parsed.layers[parsed.layers.length - 1].z.toFixed(2) : '0'}mm
            </div>
            <input type="range" id="gcodeLayerSlider" min="0" max="${Math.max(0, parsed.layerCount - 1)}" value="${Math.max(0, parsed.layerCount - 1)}"
              style="width:100%;accent-color:var(--accent,#6366f1);margin-bottom:8px;">
            <label style="display:flex;align-items:center;gap:6px;font-size:0.82rem;color:rgba(255,255,255,0.6);cursor:pointer;">
              <input type="checkbox" id="gcodeShowAll" checked> Show all layers up to current
            </label>
          </div>

          <div style="margin-bottom:16px;">
            <div style="font-weight:600;font-size:0.85rem;color:#fff;margin-bottom:8px;">Type Legend</div>
            ${legendHtml}
          </div>

          ${printerName ? `
          <div style="margin-top:auto;padding-top:16px;border-top:1px solid rgba(255,255,255,0.08);">
            <div style="font-size:0.8rem;color:rgba(255,255,255,0.4);">Printer</div>
            <div style="font-size:0.9rem;color:#38bdf8;font-weight:500;">${slicerEsc(printerName)}</div>
          </div>` : ''}
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    // ---- Three.js scene ----
    const container = document.getElementById('gcodePreviewCanvas');
    const bedDims = slicerGetBedDimensions();

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a1a);

    const cw = container.clientWidth || 800;
    const ch = container.clientHeight || 600;
    const camera = new THREE.PerspectiveCamera(45, cw / ch, 0.1, 100000);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(cw, ch);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0x606060, 1.5));
    const dl1 = new THREE.DirectionalLight(0xffffff, 1.2);
    dl1.position.set(5, 10, 7);
    scene.add(dl1);
    const dl2 = new THREE.DirectionalLight(0x88aaff, 0.5);
    dl2.position.set(-5, -3, -5);
    scene.add(dl2);

    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;

    // Bed plane
    const bedGeo = new THREE.PlaneGeometry(bedDims.x, bedDims.y);
    const bedMat = new THREE.MeshPhongMaterial({ color: 0x1a1a2e, specular: 0x111111, shininess: 5, transparent: true, opacity: 0.8 });
    const bedMesh = new THREE.Mesh(bedGeo, bedMat);
    bedMesh.rotation.x = -Math.PI / 2;
    bedMesh.position.set(bedDims.x / 2, 0, bedDims.y / 2);
    scene.add(bedMesh);

    // Grid
    const gridPts = [];
    for (let x = 0; x <= bedDims.x; x += 10) { gridPts.push(new THREE.Vector3(x, 0.05, 0)); gridPts.push(new THREE.Vector3(x, 0.05, bedDims.y)); }
    for (let z = 0; z <= bedDims.y; z += 10) { gridPts.push(new THREE.Vector3(0, 0.05, z)); gridPts.push(new THREE.Vector3(bedDims.x, 0.05, z)); }
    scene.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(gridPts), new THREE.LineBasicMaterial({ color: 0x333355, transparent: true, opacity: 0.3 })));

    // Border
    const borderPts = [new THREE.Vector3(0,0.1,0), new THREE.Vector3(bedDims.x,0.1,0), new THREE.Vector3(bedDims.x,0.1,bedDims.y), new THREE.Vector3(0,0.1,bedDims.y), new THREE.Vector3(0,0.1,0)];
    scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(borderPts), new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.6 })));

    // ---- Render G-code toolpaths ----
    const layerObjects = []; // layerObjects[i] = [LineSegments, ...]
    const allDisposables = [];

    for (const layer of parsed.layers) {
      const group = [];
      for (const seg of layer.segments) {
        if (seg.points.length < 6) continue;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(seg.points, 3));
        const colorHex = GCODE_TYPE_COLORS[seg.type] || GCODE_TYPE_COLORS['unknown'];
        const mat = new THREE.LineBasicMaterial({ color: colorHex });
        const lineSegs = new THREE.LineSegments(geo, mat);
        scene.add(lineSegs);
        group.push(lineSegs);
        allDisposables.push({ geo, mat });
      }
      layerObjects.push(group);
    }

    // Camera position — frame the toolpaths
    const bedCenter = new THREE.Vector3(bedDims.x / 2, 0, bedDims.y / 2);
    const maxBed = Math.max(bedDims.x, bedDims.y);
    const fov = camera.fov * (Math.PI / 180);
    const dist = maxBed / (2 * Math.tan(fov / 2)) * 1.6;
    camera.position.set(bedDims.x / 2 + dist * 0.5, dist * 0.7, bedDims.y / 2 + dist * 0.5);
    camera.lookAt(bedCenter);
    controls.target.copy(bedCenter);
    controls.update();

    // Animation loop
    let animId;
    function animate() { animId = requestAnimationFrame(animate); controls.update(); renderer.render(scene, camera); }
    animate();

    // Resize
    const resizeObs = new ResizeObserver(() => {
      const w = container.clientWidth; const h = container.clientHeight;
      if (w && h) { camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h); }
    });
    resizeObs.observe(container);

    // ---- Layer slider ----
    const slider = document.getElementById('gcodeLayerSlider');
    const layerLabel = document.getElementById('gcodeLayerLabel');
    const showAllCb = document.getElementById('gcodeShowAll');

    function updateLayerVisibility() {
      const showAll = showAllCb.checked;
      const current = parseInt(slider.value, 10);

      for (let i = 0; i < layerObjects.length; i++) {
        const vis = showAll ? (i <= current) : (i === current);
        for (const obj of layerObjects[i]) obj.visible = vis;
      }

      const ld = parsed.layers[current];
      if (layerLabel && ld) {
        layerLabel.innerHTML = `Layer ${current + 1} / ${parsed.layerCount} &mdash; Z: ${ld.z.toFixed(2)}mm`;
      }
    }

    if (slider) slider.addEventListener('input', updateLayerVisibility);
    if (showAllCb) showAllCb.addEventListener('change', updateLayerVisibility);
    updateLayerVisibility();

    // ---- Cleanup ----
    function cleanup() {
      cancelAnimationFrame(animId);
      resizeObs.disconnect();
      for (const d of allDisposables) { d.geo.dispose(); d.mat.dispose(); }
      bedGeo.dispose(); bedMat.dispose();
      renderer.dispose();
      modal.remove();
    }

    // ---- Buttons ----
    document.getElementById('gcodeCloseBtn').addEventListener('click', () => { cleanup(); resolve('close'); });
    const printBtn = document.getElementById('gcodePrintBtn');
    if (printBtn) {
      printBtn.addEventListener('click', () => { cleanup(); resolve('print'); });
    }
  });
}

async function slicerSliceAndPrint() {
  const item = slicerState.selectedItem;
  if (!item) return alert('No model selected');

  // Get printer info (may be null if no printer selected)
  const printerId = document.getElementById('slicerPrinter')?.value || null;
  let printerModel = '';
  let printerName = '';
  if (printerId) {
    const printer = slicerState.printers.find(p => String(p.id) === String(printerId));
    if (printer) {
      printerName = printer.name || '';
      if (printer.model) printerModel = slicerMapPrinterModel(printer.model);
    }
  }

  // Include transform (scale, rotation, position) if the user modified the model
  const savedT = slicerState.plateTransforms[item.id];
  const transform = savedT ? {
    rx: savedT.rx || 0, ry: savedT.ry || 0, rz: savedT.rz || 0,
    scale: savedT.scale || 1, posX: savedT.posX || 0, posZ: savedT.posZ || 0
  } : null;

  const copies = slicerState.settings.copies || 1;
  const sliceOptions = {
    stl_id: item.id,
    printer_model: printerModel || 'kobra3',
    material: slicerState.settings.material,
    quality: slicerState.settings.quality,
    strength: slicerState.settings.strength,
    speed: slicerState.settings.speed,
    texture: slicerState.settings.texture,
    surface: slicerState.settings.surface,
    supports: slicerState.settings.supports,
    auto_orient: slicerState.settings.auto_orient,
    copies: copies > 1 ? copies : undefined,
    transform: transform
  };

  // Read ACE slot if visible
  const aceSlotVal = document.getElementById('slicerAceSlot')?.value;
  const aceSlot = (aceSlotVal !== '' && aceSlotVal != null) ? parseInt(aceSlotVal, 10) : null;
  const aceSlotLabel = aceSlot != null ? document.getElementById('slicerAceSlot')?.selectedOptions?.[0]?.textContent || `T${aceSlot}` : '';

  // STEP 1: Pre-slice approval modal (with temperatures)
  const approved = await slicerShowApprovalModal({
    items: [item],
    settings: slicerState.settings,
    printerName: printerName,
    printerModel: printerModel,
    aceSlotLabel,
    isPlate: false,
    andPrint: false
  });
  if (!approved) return;

  // STEP 2: Slice (blocking, with step progress)
  const sliceSteps = ['Slicing model', 'Loading G-code preview'];
  slicerShowProgress('Slicing...', sliceSteps, 0, 'PrusaSlicer is processing your model on the server');
  let sliceResult;
  try {
    sliceResult = await printStation.slicer.slice(sliceOptions);
    if (sliceResult.error) throw new Error(sliceResult.error);
  } catch (err) {
    slicerHideProgress();
    console.error('[Slicer] Slice error:', err);
    showToast('Slicing failed: ' + err.message, 'error', 8000);
    return;
  }

  const cached = sliceResult.cached ? ' (cache hit)' : '';

  // STEP 3: Fetch G-code text for visualization
  slicerUpdateProgress(1, 'Downloading G-code for 3D preview...');
  let gcodeText;
  try {
    gcodeText = await printStation.slicer.fetchGcodeText(sliceResult.gcode_id);
  } catch (err) {
    slicerHideProgress();
    console.error('[Slicer] Fetch G-code text error:', err);
    showToast('Could not load G-code for preview: ' + err.message, 'error', 6000);
    try {
      const updated = await printStation.slicer.getCatalogItem(item.id);
      if (updated) { slicerState.gcodeEntries = updated.gcodeEntries || []; slicerRenderGcodeList(slicerState.gcodeEntries); }
    } catch (_) {}
    return;
  }
  slicerHideProgress();
  showToast(`Slicing complete${cached}!`, 'success', 3000);

  // STEP 4: Show G-code 3D preview
  const action = await slicerShowGcodePreview({
    gcodeText,
    gcodeId: sliceResult.gcode_id,
    sliceResult,
    printerId: printerId ? parseInt(printerId, 10) : null,
    aceSlot,
    printerName
  });

  // STEP 5: Handle user decision — send to printer with step progress
  if (action === 'print') {
    if (!printerId) {
      showToast('No printer selected. G-code saved but not sent to printer.', 'warning', 6000);
    } else {
      const printSteps = ['Downloading G-code', 'Preparing file', 'Uploading to printer', 'Starting print'];
      slicerShowProgress('Sending to Printer...', printSteps, 0, 'Downloading G-code from server...');

      // Listen for progress events from main process
      const offProgress = printStation.slicer.onPrintProgress(({ step, detail }) => {
        slicerUpdateProgress(step - 1, detail);
      });

      try {
        const result = await printStation.slicer.printGcode(sliceResult.gcode_id, parseInt(printerId, 10), aceSlot);
        offProgress();
        slicerHideProgress();
        if (result.success) {
          showToast(`Print started on ${printerName}: ${item.name || 'model'} (Job #${result.job?.id || ''})`, 'success', 6000);
        }
      } catch (err) {
        offProgress();
        slicerHideProgress();
        console.error('[Slicer] Print error:', err);
        showToast('Print failed: ' + err.message, 'error', 8000);
      }
    }
  }

  // Refresh G-code list regardless
  try {
    const updated = await printStation.slicer.getCatalogItem(item.id);
    if (updated) { slicerState.gcodeEntries = updated.gcodeEntries || []; slicerRenderGcodeList(slicerState.gcodeEntries); }
  } catch (_) {}
}

async function slicerPrintExistingGcode(gcodeId) {
  const printerId = document.getElementById('slicerPrinter')?.value;
  if (!printerId) return alert('Please select a printer first');

  const aceSlotVal = document.getElementById('slicerAceSlot')?.value;
  const aceSlot = (aceSlotVal !== '' && aceSlotVal != null) ? parseInt(aceSlotVal, 10) : null;

  const printer = slicerState.printers.find(p => String(p.id) === String(printerId));
  const printerName = printer?.name || 'printer';

  const printSteps = ['Downloading G-code', 'Preparing file', 'Uploading to printer', 'Starting print'];
  slicerShowProgress('Sending to Printer...', printSteps, 0, 'Downloading G-code from server...');

  const offProgress = printStation.slicer.onPrintProgress(({ step, detail }) => {
    slicerUpdateProgress(step - 1, detail);
  });

  try {
    const result = await printStation.slicer.printGcode(gcodeId, parseInt(printerId, 10), aceSlot);
    offProgress();
    slicerHideProgress();
    if (result.success) {
      showToast(`Print started on ${printerName} (Job #${result.job?.id || ''})`, 'success', 6000);
    }
  } catch (err) {
    offProgress();
    slicerHideProgress();
    console.error('[Slicer] Print existing G-code error:', err);
    showToast('Print failed: ' + err.message, 'error', 8000);
  }
}

async function slicerDeleteGcodeEntry(gcodeId) {
  if (!confirm('Delete this cached G-code?')) return;
  try {
    await printStation.slicer.deleteCache(gcodeId);
    // Refresh
    if (slicerState.selectedItem) {
      const updated = await printStation.slicer.getCatalogItem(slicerState.selectedItem.id);
      if (updated) {
        slicerState.gcodeEntries = updated.gcodeEntries || [];
        slicerRenderGcodeList(slicerState.gcodeEntries);
      }
    }
  } catch (err) {
    console.error('[Slicer] Delete G-code error:', err);
    alert('Delete failed: ' + err.message);
  }
}

// ============================================================================
// CATEGORY MANAGER
// ============================================================================

async function slicerShowCategoryManager() {
  // Remove existing modal if open
  const existing = document.getElementById('slicerCategoryModal');
  if (existing) existing.remove();

  // Fetch categories with counts
  let categories = [];
  try {
    const result = await printStation.slicer.getCategoriesWithCounts();
    categories = result.categories || [];
  } catch (err) {
    console.error('[Slicer] Load categories error:', err);
    alert('Failed to load categories: ' + err.message);
    return;
  }

  // Build modal
  const modal = document.createElement('div');
  modal.id = 'slicerCategoryModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;';
  modal.innerHTML = `
    <div style="background:var(--card,#1e293b);border-radius:12px;padding:24px;width:700px;max-width:90vw;max-height:80vh;display:flex;flex-direction:column;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <h3 style="margin:0;">Manage Categories</h3>
        <button id="slicerCatModalClose" style="background:none;border:1px solid var(--border);color:var(--text);padding:6px 14px;border-radius:6px;cursor:pointer;">Close</button>
      </div>

      <div style="margin-bottom:16px;padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-secondary,#0f172a);">
        <div style="font-weight:600;font-size:0.9rem;margin-bottom:8px;">Merge Selected → New Category</div>
        <div style="display:flex;gap:8px;">
          <input id="slicerCatMergeName" type="text" placeholder="New category name..." style="flex:1;padding:8px 12px;">
          <button id="slicerCatMergeBtn" class="primary" style="padding:8px 16px;white-space:nowrap;">Merge Selected</button>
        </div>
        <div class="muted" style="font-size:0.8rem;margin-top:6px;">Select categories below, type a new name, then click Merge to combine them.</div>
      </div>

      <div style="display:flex;gap:8px;margin-bottom:8px;">
        <button id="slicerCatSelectAll" class="secondary" style="padding:4px 12px;font-size:0.8rem;">Select All</button>
        <button id="slicerCatSelectNone" class="secondary" style="padding:4px 12px;font-size:0.8rem;">Select None</button>
        <input id="slicerCatSearch" type="text" placeholder="Filter categories..." style="flex:1;padding:4px 10px;font-size:0.85rem;">
      </div>

      <div id="slicerCatList" style="flex:1;overflow-y:auto;border:1px solid var(--border);border-radius:8px;"></div>

      <div class="muted" style="font-size:0.8rem;margin-top:8px;text-align:center;">
        <span id="slicerCatTotal">${categories.length} categories, ${categories.reduce((s, c) => s + c.count, 0)} total items</span>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  // Render the category list
  const listEl = document.getElementById('slicerCatList');
  function renderCatList(filter = '') {
    const filtered = filter
      ? categories.filter(c => c.category.toLowerCase().includes(filter.toLowerCase()))
      : categories;

    listEl.innerHTML = filtered.map(c => `
      <div class="slicer-cat-row" data-cat="${slicerEsc(c.category)}" style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--border);cursor:pointer;">
        <input type="checkbox" class="slicer-cat-check" data-cat="${slicerEsc(c.category)}" style="width:16px;height:16px;accent-color:var(--accent);cursor:pointer;flex-shrink:0;">
        <div style="flex:1;min-width:0;">
          <span style="font-weight:500;font-size:0.9rem;word-break:break-all;">${slicerEsc(c.category)}</span>
          <span class="muted" style="font-size:0.8rem;margin-left:8px;">(${c.count} items)</span>
        </div>
        <button class="slicer-cat-rename-btn secondary" data-cat="${slicerEsc(c.category)}" style="padding:3px 10px;font-size:0.75rem;flex-shrink:0;" title="Rename">Rename</button>
      </div>
    `).join('');

    // Row click toggles checkbox
    listEl.querySelectorAll('.slicer-cat-row').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
        const cb = row.querySelector('.slicer-cat-check');
        if (cb) cb.checked = !cb.checked;
      });
    });

    // Rename buttons
    listEl.querySelectorAll('.slicer-cat-rename-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const oldName = btn.dataset.cat;
        const newName = prompt(`Rename "${oldName}" to:`, oldName);
        if (!newName || newName.trim() === oldName) return;
        try {
          await printStation.slicer.renameCategory(oldName, newName.trim());
          showToast(`Renamed "${oldName}" → "${newName.trim()}"`, 'success', 3000);
          await refreshCatList();
        } catch (err) {
          alert('Rename failed: ' + err.message);
        }
      });
    });
  }

  async function refreshCatList() {
    try {
      const result = await printStation.slicer.getCategoriesWithCounts();
      categories = result.categories || [];
      const filter = document.getElementById('slicerCatSearch')?.value || '';
      renderCatList(filter);
      const totalEl = document.getElementById('slicerCatTotal');
      if (totalEl) totalEl.textContent = `${categories.length} categories, ${categories.reduce((s, c) => s + c.count, 0)} total items`;
    } catch (err) {
      console.error('[Slicer] Refresh categories error:', err);
    }
  }

  renderCatList();

  // Search filter
  const searchInput = document.getElementById('slicerCatSearch');
  let searchTimer;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => renderCatList(searchInput.value), 200);
  });

  // Select All / None
  document.getElementById('slicerCatSelectAll').addEventListener('click', () => {
    listEl.querySelectorAll('.slicer-cat-check').forEach(cb => cb.checked = true);
  });
  document.getElementById('slicerCatSelectNone').addEventListener('click', () => {
    listEl.querySelectorAll('.slicer-cat-check').forEach(cb => cb.checked = false);
  });

  // Merge button
  document.getElementById('slicerCatMergeBtn').addEventListener('click', async () => {
    const toCategory = document.getElementById('slicerCatMergeName')?.value?.trim();
    if (!toCategory) return alert('Please enter a new category name');

    const selected = [];
    listEl.querySelectorAll('.slicer-cat-check:checked').forEach(cb => {
      selected.push(cb.dataset.cat);
    });

    if (!selected.length) return alert('Please select at least one category to merge');

    const totalItems = categories.filter(c => selected.includes(c.category)).reduce((s, c) => s + c.count, 0);
    if (!confirm(`Merge ${selected.length} categories (${totalItems} items) into "${toCategory}"?`)) return;

    try {
      const result = await printStation.slicer.mergeCategories(selected, toCategory);
      showToast(`Merged ${result.updated} items into "${toCategory}"`, 'success', 3000);
      document.getElementById('slicerCatMergeName').value = '';
      await refreshCatList();
      // Also refresh the main category dropdown
      await slicerLoadCategories();
    } catch (err) {
      alert('Merge failed: ' + err.message);
    }
  });

  // Close
  document.getElementById('slicerCatModalClose').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
}

// ============================================================================
// PLATE MODE — MULTI-STL BUILD PLATE
// ============================================================================

async function slicerTogglePlateMode() {
  slicerState.plateMode = !slicerState.plateMode;
  const btn = document.getElementById('slicerPlateToggle');
  if (btn) btn.classList.toggle('active', slicerState.plateMode);

  if (!slicerState.plateMode) {
    // Exiting plate mode — clear plate items
    slicerState.plateItems = [];
  }

  slicerUpdatePlateBar();
  await slicerRenderCatalog();
}

function slicerTogglePlateItem(id) {
  const idx = slicerState.plateItems.findIndex(i => i.id === id);
  if (idx >= 0) {
    // Remove from plate
    slicerState.plateItems.splice(idx, 1);
  } else {
    // Add to plate
    const item = slicerState.catalog.find(i => i.id === id);
    if (item) slicerState.plateItems.push(item);
  }

  slicerUpdatePlateBar();
  slicerUpdatePlateCheckmarks();
}

function slicerUpdatePlateBar() {
  const bar = document.getElementById('slicerPlateBar');
  if (!bar) return;

  if (!slicerState.plateMode || slicerState.plateItems.length === 0) {
    bar.style.display = 'none';
    return;
  }

  bar.style.display = '';
  const countEl = document.getElementById('slicerPlateCount');
  const namesEl = document.getElementById('slicerPlateNames');
  const n = slicerState.plateItems.length;

  if (countEl) countEl.textContent = `${n} model${n !== 1 ? 's' : ''} on plate`;
  if (namesEl) namesEl.textContent = slicerState.plateItems.map(i => i.name).join(', ');
}

function slicerUpdatePlateCheckmarks() {
  const plateIds = new Set(slicerState.plateItems.map(i => i.id));
  const grid = document.getElementById('slicerCatalogGrid');
  if (!grid) return;

  grid.querySelectorAll('.slicer-catalog-card[data-stl-id]').forEach(card => {
    const id = parseInt(card.dataset.stlId, 10);
    const selected = plateIds.has(id);
    card.classList.toggle('slicer-plate-selected', selected);
    const check = card.querySelector('.slicer-plate-check');
    if (check) check.textContent = selected ? '✓' : '';
  });
}

function slicerShowBulkCategoryPicker() {
  if (slicerState.plateItems.length === 0) {
    return alert('No models selected. Click on models to select them first.');
  }

  const n = slicerState.plateItems.length;
  const cats = slicerState.categories || [];

  // Build modal
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;';

  const modal = document.createElement('div');
  modal.style.cssText = 'background:var(--card,#1e293b);border-radius:12px;padding:24px;max-width:480px;width:90%;max-height:80vh;display:flex;flex-direction:column;';
  modal.innerHTML = `
    <h3 style="margin:0 0 4px;">Set Category</h3>
    <p class="muted" style="margin:0 0 16px;font-size:0.85rem;">${n} model${n !== 1 ? 's' : ''} selected</p>
    <input id="bulkCatSearch" type="text" placeholder="Search or type new category..."
      style="width:100%;padding:8px 12px;border-radius:6px;border:1px solid var(--border,#334155);background:var(--bg-secondary,#0f172a);color:var(--text,#e2e8f0);font-size:0.9rem;margin-bottom:12px;box-sizing:border-box;">
    <div id="bulkCatList" style="flex:1;overflow-y:auto;max-height:300px;border:1px solid var(--border,#334155);border-radius:8px;"></div>
    <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end;">
      <button id="bulkCatCancel" class="secondary" style="padding:8px 16px;">Cancel</button>
      <button id="bulkCatApply" class="primary" style="padding:8px 20px;font-weight:600;">Apply</button>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  let selectedCategory = '';

  function renderCatList(filter) {
    const listEl = document.getElementById('bulkCatList');
    if (!listEl) return;
    const lc = (filter || '').toLowerCase();
    const filtered = cats.filter(c => !lc || c.toLowerCase().includes(lc));

    // If user typed something that doesn't match any existing category, show "Create new" option
    const exactMatch = cats.some(c => c.toLowerCase() === lc);
    const createNew = lc && !exactMatch
      ? `<div class="bulk-cat-option" data-cat="${slicerEsc(filter.trim())}" style="padding:10px 14px;cursor:pointer;border-bottom:1px solid var(--border,#334155);color:var(--accent);font-weight:600;">
           + Create "${slicerEsc(filter.trim())}"
         </div>`
      : '';

    listEl.innerHTML = createNew + filtered.map(c => `
      <div class="bulk-cat-option${c === selectedCategory ? ' bulk-cat-active' : ''}" data-cat="${slicerEsc(c)}"
        style="padding:10px 14px;cursor:pointer;border-bottom:1px solid var(--border,#334155);${c === selectedCategory ? 'background:var(--accent);color:#fff;' : ''}">
        ${slicerEsc(c)}
      </div>
    `).join('');

    // Click handler for options
    listEl.querySelectorAll('.bulk-cat-option').forEach(opt => {
      opt.addEventListener('click', () => {
        selectedCategory = opt.dataset.cat;
        renderCatList(document.getElementById('bulkCatSearch')?.value || '');
      });
    });
  }

  renderCatList('');

  // Search filter
  const searchEl = document.getElementById('bulkCatSearch');
  searchEl.focus();
  searchEl.addEventListener('input', () => renderCatList(searchEl.value));

  // Cancel
  document.getElementById('bulkCatCancel').addEventListener('click', () => {
    document.body.removeChild(overlay);
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) document.body.removeChild(overlay);
  });

  // Apply
  document.getElementById('bulkCatApply').addEventListener('click', async () => {
    // If nothing selected from the list, use the typed text as new category
    const typed = searchEl.value.trim();
    const category = selectedCategory || typed;
    if (!category) return alert('Choose or type a category name.');

    const ids = slicerState.plateItems.map(i => i.id);
    try {
      document.getElementById('bulkCatApply').disabled = true;
      document.getElementById('bulkCatApply').textContent = 'Applying...';
      await printStation.slicer.bulkSetCategory(ids, category);
      document.body.removeChild(overlay);
      showToast(`Moved ${ids.length} model${ids.length !== 1 ? 's' : ''} to "${category}"`, 'success', 3000);

      // Clear selection, refresh catalog and categories
      slicerState.plateItems = [];
      slicerUpdatePlateBar();
      await slicerLoadCategories();
      await slicerLoadCatalog();
    } catch (err) {
      console.error('[Slicer] Bulk category error:', err);
      alert('Failed to set category: ' + (err.message || err));
      document.getElementById('bulkCatApply').disabled = false;
      document.getElementById('bulkCatApply').textContent = 'Apply';
    }
  });
}

// ============================================================================
// BUILD PLATE 3D PREVIEW
// ============================================================================

function slicerGetBedDimensions() {
  // First try to get dimensions from the selected fleet printer's DB record
  // (populated from actual Moonraker/Klipper query via getBuildVolume)
  const platePrinterId = document.getElementById('slicerPlatePrinter')?.value
                      || document.getElementById('slicerPrinter')?.value;
  if (platePrinterId) {
    const fleetPrinter = slicerState.printers.find(p => String(p.id) === String(platePrinterId));
    if (fleetPrinter && fleetPrinter.build_width && fleetPrinter.build_depth && fleetPrinter.build_height) {
      return {
        x: fleetPrinter.build_width,
        y: fleetPrinter.build_depth,
        z: fleetPrinter.build_height
      };
    }
  }

  // Fallback: try hardcoded presets (PRINTERS_MAP build strings)
  const presets = slicerState.presets;
  if (presets && presets.printers && presets.printers.length > 0) {
    let printer = presets.printers[0];
    if (platePrinterId) {
      const fleetPrinter = slicerState.printers.find(p => String(p.id) === String(platePrinterId));
      if (fleetPrinter) {
        const modelKey = slicerMapPrinterModel(fleetPrinter.model);
        const presetPrinter = presets.printers.find(p => p.model === modelKey);
        if (presetPrinter) printer = presetPrinter;
      }
    }
    if (printer && printer.build) {
      const [x, y, z] = printer.build.split('x').map(Number);
      return { x: x || 250, y: y || 250, z: z || 260 };
    }
  }
  return { x: 250, y: 250, z: 260 };
}

function bpInitScene(container, bedDims) {
  const width = container.clientWidth;
  const height = container.clientHeight;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a1a);

  const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100000);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  // Lighting (matches existing pattern)
  scene.add(new THREE.AmbientLight(0x606060, 1.5));
  const dl1 = new THREE.DirectionalLight(0xffffff, 1.2);
  dl1.position.set(5, 10, 7);
  scene.add(dl1);
  const dl2 = new THREE.DirectionalLight(0x88aaff, 0.5);
  dl2.position.set(-5, -3, -5);
  scene.add(dl2);

  // OrbitControls
  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;

  // Bed plane (XZ plane, Y=0)
  const bedGeo = new THREE.PlaneGeometry(bedDims.x, bedDims.y);
  const bedMat = new THREE.MeshPhongMaterial({
    color: 0x1a1a2e, specular: 0x111111, shininess: 5,
    transparent: true, opacity: 0.8
  });
  const bedMesh = new THREE.Mesh(bedGeo, bedMat);
  bedMesh.rotation.x = -Math.PI / 2;
  bedMesh.position.set(bedDims.x / 2, 0, bedDims.y / 2);
  bedMesh.userData.isBed = true;
  scene.add(bedMesh);

  // Grid lines (10mm spacing)
  const gridPoints = [];
  const gridSpacing = 10;
  for (let x = 0; x <= bedDims.x; x += gridSpacing) {
    gridPoints.push(new THREE.Vector3(x, 0.05, 0));
    gridPoints.push(new THREE.Vector3(x, 0.05, bedDims.y));
  }
  for (let z = 0; z <= bedDims.y; z += gridSpacing) {
    gridPoints.push(new THREE.Vector3(0, 0.05, z));
    gridPoints.push(new THREE.Vector3(bedDims.x, 0.05, z));
  }
  const gridGeo = new THREE.BufferGeometry().setFromPoints(gridPoints);
  const gridMat = new THREE.LineBasicMaterial({ color: 0x333355, transparent: true, opacity: 0.3 });
  const gridMesh = new THREE.LineSegments(gridGeo, gridMat);
  scene.add(gridMesh);

  // Bed border (bright cyan outline)
  const borderPoints = [
    new THREE.Vector3(0, 0.1, 0),
    new THREE.Vector3(bedDims.x, 0.1, 0),
    new THREE.Vector3(bedDims.x, 0.1, bedDims.y),
    new THREE.Vector3(0, 0.1, bedDims.y),
    new THREE.Vector3(0, 0.1, 0)
  ];
  const borderGeo = new THREE.BufferGeometry().setFromPoints(borderPoints);
  const borderMat = new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.6 });
  const borderLine = new THREE.Line(borderGeo, borderMat);
  scene.add(borderLine);

  // Camera — above and to the side, looking at bed center
  const bedCenter = new THREE.Vector3(bedDims.x / 2, 0, bedDims.y / 2);
  const maxBed = Math.max(bedDims.x, bedDims.y);
  const fov = camera.fov * (Math.PI / 180);
  const dist = maxBed / (2 * Math.tan(fov / 2)) * 1.6;
  camera.position.set(bedDims.x / 2 + dist * 0.5, dist * 0.7, bedDims.y / 2 + dist * 0.5);
  camera.lookAt(bedCenter);
  controls.target.copy(bedCenter);
  controls.update();

  // Raycaster for click-to-select
  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();

  // Animation loop
  let animId;
  function animate() {
    animId = requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  // ResizeObserver
  const resizeObs = new ResizeObserver(() => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  });
  resizeObs.observe(container);

  slicerState.platePreview = {
    renderer, scene, camera, controls, animId, resizeObs,
    raycaster, mouse,
    meshes: [],
    selectedMeshIndex: -1,
    bedMesh, gridMesh, borderLine,
    bedGeo, bedMat, gridGeo, gridMat, borderGeo, borderMat
  };
}

/**
 * Save mesh XZ position back to plateTransforms so it persists and gets sent to the slicer.
 */
function bpSavePosition(entry) {
  if (!slicerState.plateTransforms[entry.stlId]) {
    slicerState.plateTransforms[entry.stlId] = { rx: 0, ry: 0, rz: 0, scale: 1, posX: 0, posZ: 0 };
  }
  const t = slicerState.plateTransforms[entry.stlId];
  t.posX = entry.mesh.position.x;
  t.posZ = entry.mesh.position.z;
}

function bpAutoArrange(modelInfos, bedDims) {
  // Sort by depth (largest first) for better row packing
  modelInfos.sort((a, b) => Math.max(b.size.x, b.size.z) - Math.max(a.size.x, a.size.z));

  const padding = 5;
  let cursorX = padding;
  let cursorZ = padding;
  let rowMaxZ = 0;

  for (const info of modelInfos) {
    const w = info.size.x;
    const d = info.size.z;

    // Start new row if doesn't fit
    if (cursorX + w + padding > bedDims.x && cursorX > padding) {
      cursorX = padding;
      cursorZ += rowMaxZ + padding;
      rowMaxZ = 0;
    }

    info.mesh.position.set(cursorX + w / 2, 0, cursorZ + d / 2);
    cursorX += w + padding;
    if (d > rowMaxZ) rowMaxZ = d;
  }
}

async function bpLoadAllModels(bedDims) {
  const pp = slicerState.platePreview;
  if (!pp) return;

  const items = pp._items || slicerState.plateItems;
  const statusText = document.getElementById('bpStatusText');
  if (statusText) statusText.textContent = `Loading ${items.length} models...`;

  // Fetch all STL buffers in parallel
  const buffers = await Promise.all(
    items.map(item => slicerFetchStlBuffer(item.id).catch(err => {
      console.warn('[BuildPlate] Failed to load STL for', item.name, err.message);
      return null;
    }))
  );

  const loader = new THREE.STLLoader();
  const modelInfos = [];

  for (let i = 0; i < items.length; i++) {
    const buf = buffers[i];
    if (!buf) continue;

    const item = items[i];
    const geometry = loader.parse(buf);
    geometry.computeVertexNormals();

    // Apply any previously saved transforms
    const savedT = slicerState.plateTransforms[item.id];
    if (savedT) {
      if (savedT.rx) geometry.rotateX(savedT.rx);
      if (savedT.ry) geometry.rotateY(savedT.ry);
      if (savedT.rz) geometry.rotateZ(savedT.rz);
      if (savedT.scale && savedT.scale !== 1) geometry.scale(savedT.scale, savedT.scale, savedT.scale);
    }

    // Auto-detect meter-unit STLs: if the raw geometry (before any user scaling)
    // has a max dimension under 1mm, the file was likely exported in meters.
    // Apply a x1000 correction so it renders at the correct mm scale.
    geometry.computeBoundingBox();
    const rawBox = geometry.boundingBox;
    const rawMaxDim = Math.max(
      rawBox.max.x - rawBox.min.x,
      rawBox.max.y - rawBox.min.y,
      rawBox.max.z - rawBox.min.z
    );
    if (rawMaxDim > 0 && rawMaxDim < 1.0 && (!savedT || !savedT.scale || savedT.scale === 1)) {
      // STL is in meters — convert to mm
      console.log(`[BuildPlate] Auto-scaling "${item.name}" from meters to mm (raw max dim: ${rawMaxDim.toFixed(4)})`);
      geometry.scale(1000, 1000, 1000);
      if (!slicerState.plateTransforms[item.id]) {
        slicerState.plateTransforms[item.id] = { rx: 0, ry: 0, rz: 0, scale: 1, posX: 0, posZ: 0 };
      }
      slicerState.plateTransforms[item.id].scale = 1000;
    }

    // Center in XZ, floor to Y=0
    geometry.computeBoundingBox();
    const gBox = geometry.boundingBox;
    const cx = (gBox.max.x + gBox.min.x) / 2;
    const cz = (gBox.max.z + gBox.min.z) / 2;
    const minY = gBox.min.y;
    geometry.translate(-cx, -minY, -cz);

    const material = new THREE.MeshPhongMaterial({
      color: 0x38bdf8, specular: 0x222222, shininess: 40
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.stlId = item.id;
    mesh.userData.itemIndex = i;

    const bbox = new THREE.Box3().setFromObject(mesh);
    const size = bbox.getSize(new THREE.Vector3());

    modelInfos.push({ stlId: item.id, item, mesh, geometry, material, bbox, size });
  }

  // Auto-arrange on bed (unless positions were previously saved)
  const hasSavedPositions = modelInfos.some(info => {
    const t = slicerState.plateTransforms[info.stlId];
    return t && (t.posX !== undefined && t.posX !== 0 || t.posZ !== undefined && t.posZ !== 0);
  });
  if (hasSavedPositions) {
    // Restore saved positions instead of auto-arranging
    for (const info of modelInfos) {
      const t = slicerState.plateTransforms[info.stlId];
      if (t && t.posX !== undefined) {
        info.mesh.position.set(t.posX, 0, t.posZ);
        // Re-floor Y
        info.mesh.updateMatrixWorld(true);
        const bbox2 = new THREE.Box3().setFromObject(info.mesh);
        info.mesh.position.y = -bbox2.min.y;
      }
    }
  } else {
    bpAutoArrange(modelInfos, bedDims);
  }

  // Add to scene
  for (const info of modelInfos) {
    pp.scene.add(info.mesh);
    pp.meshes.push({
      stlId: info.stlId,
      item: info.item,
      mesh: info.mesh,
      geometry: info.geometry,
      material: info.material
    });
    // Save positions to plateTransforms
    bpSavePosition({ stlId: info.stlId, mesh: info.mesh });
  }

  bpRenderModelList();
  bpCheckFit(bedDims);

  if (statusText) statusText.textContent = `${modelInfos.length} model${modelInfos.length !== 1 ? 's' : ''} loaded`;
  const bedSizeEl = document.getElementById('bpBedSize');
  if (bedSizeEl) bedSizeEl.textContent = `Bed: ${bedDims.x} \u00d7 ${bedDims.y} mm`;
}

function bpRenderModelList() {
  const pp = slicerState.platePreview;
  if (!pp) return;
  const listEl = document.getElementById('bpModelList');
  if (!listEl) return;

  listEl.innerHTML = pp.meshes.map((entry, idx) => {
    const item = entry.item;
    const selected = idx === pp.selectedMeshIndex;
    return `
      <div class="bp-model-item${selected ? ' bp-model-selected' : ''}" data-bp-idx="${idx}"
        style="padding:10px 12px;border-radius:8px;cursor:pointer;margin-bottom:4px;
        border:1px solid ${selected ? 'var(--accent)' : 'rgba(255,255,255,0.1)'};
        background:${selected ? 'rgba(56,189,248,0.15)' : 'transparent'};">
        <div style="font-weight:600;font-size:0.85rem;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
          ${slicerEsc(item.name)}
        </div>
        <div class="muted" style="font-size:0.75rem;color:rgba(255,255,255,0.5);">
          ${item.dim_x ? `${item.dim_x.toFixed(1)} \u00d7 ${item.dim_y.toFixed(1)} \u00d7 ${item.dim_z.toFixed(1)} mm` : 'Dimensions unknown'}
        </div>
      </div>`;
  }).join('');
}

function bpSelectModel(index) {
  const pp = slicerState.platePreview;
  if (!pp) return;

  // Deselect previous
  if (pp.selectedMeshIndex >= 0 && pp.selectedMeshIndex < pp.meshes.length) {
    const prev = pp.meshes[pp.selectedMeshIndex];
    prev.material.color.setHex(0x38bdf8);
    prev.material.emissive.setHex(0x000000);
  }

  pp.selectedMeshIndex = index;

  if (index >= 0 && index < pp.meshes.length) {
    const entry = pp.meshes[index];
    entry.material.color.setHex(0x22d3ee);
    entry.material.emissive.setHex(0x112233);
    const rotControls = document.getElementById('bpRotationControls');
    if (rotControls) rotControls.style.display = '';
    // Sync scale UI
    const t = slicerState.plateTransforms[entry.stlId];
    const scale = (t && t.scale) ? t.scale : 1;
    bpUpdateScaleUI(scale, entry);
  } else {
    const rotControls = document.getElementById('bpRotationControls');
    if (rotControls) rotControls.style.display = 'none';
  }

  bpRenderModelList();

  // Re-check fit colors (selected may have been red)
  bpCheckFit(slicerGetBedDimensions());
}

function bpRotateSelected(axis, direction) {
  const pp = slicerState.platePreview;
  if (!pp || pp.selectedMeshIndex < 0) return;

  const entry = pp.meshes[pp.selectedMeshIndex];
  const mesh = entry.mesh;
  const angle = (Math.PI / 2) * direction;

  // Save XZ position
  const posX = mesh.position.x;
  const posZ = mesh.position.z;

  // Rotate mesh
  if (axis === 'x') mesh.rotateX(angle);
  else if (axis === 'y') mesh.rotateY(angle);
  else if (axis === 'z') mesh.rotateZ(angle);

  // Recalculate bounding box in world space — move to origin first for clean bbox
  mesh.position.set(posX, 0, posZ);
  mesh.updateMatrixWorld(true);
  const bbox = new THREE.Box3().setFromObject(mesh);

  // Reposition so bottom sits exactly on bed (Y=0), keep XZ
  mesh.position.y = -bbox.min.y;

  // Track cumulative rotation
  if (!slicerState.plateTransforms[entry.stlId]) {
    slicerState.plateTransforms[entry.stlId] = { rx: 0, ry: 0, rz: 0, scale: 1, posX: 0, posZ: 0 };
  }
  const rot = slicerState.plateTransforms[entry.stlId];
  if (axis === 'x') rot.rx += angle;
  else if (axis === 'y') rot.ry += angle;
  else if (axis === 'z') rot.rz += angle;

  bpSavePosition(entry);
  bpCheckFit(slicerGetBedDimensions());
}

function bpResetRotation() {
  // Reset just rotation, keep scale and position
  const pp = slicerState.platePreview;
  if (!pp || pp.selectedMeshIndex < 0) return;

  const entry = pp.meshes[pp.selectedMeshIndex];
  const stlId = entry.stlId;
  const posX = entry.mesh.position.x;
  const posZ = entry.mesh.position.z;
  const t = slicerState.plateTransforms[stlId];
  const savedScale = (t && t.scale) ? t.scale : 1;

  // Clear rotation from transforms
  if (t) { t.rx = 0; t.ry = 0; t.rz = 0; }

  // Remove old mesh
  pp.scene.remove(entry.mesh);
  entry.geometry.dispose();
  entry.material.dispose();

  // Reload from cache
  slicerFetchStlBuffer(stlId).then(buf => {
    const loader = new THREE.STLLoader();
    const geometry = loader.parse(buf);
    geometry.computeVertexNormals();

    // Re-apply scale if any
    if (savedScale !== 1) geometry.scale(savedScale, savedScale, savedScale);

    // Center in XZ, floor to Y=0
    geometry.computeBoundingBox();
    const gBox = geometry.boundingBox;
    const cx = (gBox.max.x + gBox.min.x) / 2;
    const cz = (gBox.max.z + gBox.min.z) / 2;
    const minY = gBox.min.y;
    geometry.translate(-cx, -minY, -cz);

    const material = new THREE.MeshPhongMaterial({
      color: 0x22d3ee, specular: 0x222222, shininess: 40
    });
    material.emissive.setHex(0x112233);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.stlId = stlId;
    mesh.position.set(posX, 0, posZ);

    pp.scene.add(mesh);
    entry.mesh = mesh;
    entry.geometry = geometry;
    entry.material = material;

    bpCheckFit(slicerGetBedDimensions());
  });
}

function bpScaleSelected(newScale) {
  const pp = slicerState.platePreview;
  if (!pp || pp.selectedMeshIndex < 0) return;

  const entry = pp.meshes[pp.selectedMeshIndex];
  const mesh = entry.mesh;
  const stlId = entry.stlId;

  // Clamp scale (up to 10000% to handle meter-unit STLs that need ~1000x)
  newScale = Math.max(0.01, Math.min(100.0, newScale));

  // Get current transform state
  if (!slicerState.plateTransforms[stlId]) {
    slicerState.plateTransforms[stlId] = { rx: 0, ry: 0, rz: 0, scale: 1, posX: 0, posZ: 0 };
  }
  const t = slicerState.plateTransforms[stlId];
  const prevScale = t.scale || 1;
  const ratio = newScale / prevScale;

  // Save position
  const posX = mesh.position.x;
  const posZ = mesh.position.z;

  // Apply relative scale
  mesh.scale.multiplyScalar(ratio);
  t.scale = newScale;

  // Reposition so bottom sits on bed
  mesh.updateMatrixWorld(true);
  const bbox = new THREE.Box3().setFromObject(mesh);
  mesh.position.set(posX, -bbox.min.y, posZ);

  bpSavePosition(entry);
  bpUpdateScaleUI(newScale, entry);
  bpCheckFit(slicerGetBedDimensions());
}

function bpUpdateScaleUI(scale, entry) {
  const pct = Math.round(scale * 100);
  const valEl = document.getElementById('bpScaleValue');
  if (valEl) valEl.textContent = `${pct}%`;
  const slider = document.getElementById('bpScaleSlider');
  if (slider) slider.value = pct;

  // Show scaled dimensions
  const dimsEl = document.getElementById('bpScaleDims');
  if (dimsEl && entry) {
    entry.mesh.updateMatrixWorld(true);
    const bbox = new THREE.Box3().setFromObject(entry.mesh);
    const size = bbox.getSize(new THREE.Vector3());
    dimsEl.textContent = `${size.x.toFixed(1)} \u00d7 ${size.z.toFixed(1)} \u00d7 ${size.y.toFixed(1)} mm`;
  }
}

/**
 * Drop the selected model onto the plate — re-floor it so bottom sits exactly at Y=0.
 */
function bpDropToPlate() {
  const pp = slicerState.platePreview;
  if (!pp || pp.selectedMeshIndex < 0) return;

  const entry = pp.meshes[pp.selectedMeshIndex];
  const mesh = entry.mesh;

  mesh.updateMatrixWorld(true);
  const bbox = new THREE.Box3().setFromObject(mesh);
  // Shift Y so bounding box min.y === 0 (bottom touches bed)
  mesh.position.y -= bbox.min.y;

  bpSavePosition(entry);
  bpCheckFit(slicerGetBedDimensions());
}

/**
 * Scale the selected model to the maximum size that fits on the printer bed.
 * Preserves uniform scale and keeps model centered on bed.
 */
function bpMaxSize() {
  const pp = slicerState.platePreview;
  if (!pp || pp.selectedMeshIndex < 0) return;

  const entry = pp.meshes[pp.selectedMeshIndex];
  const mesh = entry.mesh;
  const stlId = entry.stlId;
  const bedDims = slicerGetBedDimensions();

  // Get current model size in world space
  mesh.updateMatrixWorld(true);
  const bbox = new THREE.Box3().setFromObject(mesh);
  const size = bbox.getSize(new THREE.Vector3());

  if (size.x <= 0 || size.y <= 0 || size.z <= 0) return;

  // Calculate scale factor to fill bed (XZ = bed plane, Y = height)
  const scaleX = bedDims.x / size.x;
  const scaleZ = bedDims.y / size.z;
  const scaleY = bedDims.z / size.y;
  const fitScale = Math.min(scaleX, scaleZ, scaleY);

  // Get current transform state
  if (!slicerState.plateTransforms[stlId]) {
    slicerState.plateTransforms[stlId] = { rx: 0, ry: 0, rz: 0, scale: 1, posX: 0, posZ: 0 };
  }
  const t = slicerState.plateTransforms[stlId];
  const prevScale = t.scale || 1;
  const newScale = prevScale * fitScale * 0.95; // 95% to leave a small margin

  bpScaleSelected(newScale);

  // Center on bed after max sizing
  mesh.updateMatrixWorld(true);
  const bbox2 = new THREE.Box3().setFromObject(mesh);
  mesh.position.x = bedDims.x / 2;
  mesh.position.z = bedDims.y / 2;
  mesh.position.y = -bbox2.min.y;

  bpSavePosition(entry);
  bpCheckFit(bedDims);
}

function bpCenterOnBed() {
  const pp = slicerState.platePreview;
  if (!pp || pp.selectedMeshIndex < 0) return;

  const entry = pp.meshes[pp.selectedMeshIndex];
  const bedDims = slicerGetBedDimensions();

  entry.mesh.updateMatrixWorld(true);
  const bbox = new THREE.Box3().setFromObject(entry.mesh);
  const size = bbox.getSize(new THREE.Vector3());

  entry.mesh.position.x = bedDims.x / 2;
  entry.mesh.position.z = bedDims.y / 2;

  // Re-floor Y
  entry.mesh.updateMatrixWorld(true);
  const bbox2 = new THREE.Box3().setFromObject(entry.mesh);
  entry.mesh.position.y = -bbox2.min.y;

  bpSavePosition(entry);
  bpCheckFit(bedDims);
}

function bpResetAllTransforms() {
  const pp = slicerState.platePreview;
  if (!pp || pp.selectedMeshIndex < 0) return;

  const entry = pp.meshes[pp.selectedMeshIndex];
  const stlId = entry.stlId;

  // Remove transform tracking
  delete slicerState.plateTransforms[stlId];

  // Remove old mesh
  pp.scene.remove(entry.mesh);
  entry.geometry.dispose();
  entry.material.dispose();

  // Reload from cache at original geometry
  slicerFetchStlBuffer(stlId).then(buf => {
    const loader = new THREE.STLLoader();
    const geometry = loader.parse(buf);
    geometry.computeVertexNormals();

    // Center in XZ, floor to Y=0
    geometry.computeBoundingBox();
    const gBox = geometry.boundingBox;
    const cx = (gBox.max.x + gBox.min.x) / 2;
    const cz = (gBox.max.z + gBox.min.z) / 2;
    const minY = gBox.min.y;
    geometry.translate(-cx, -minY, -cz);

    const material = new THREE.MeshPhongMaterial({
      color: 0x22d3ee, specular: 0x222222, shininess: 40
    });
    material.emissive.setHex(0x112233);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.stlId = stlId;

    // Place at bed center
    const bedDims = slicerGetBedDimensions();
    mesh.position.set(bedDims.x / 2, 0, bedDims.y / 2);

    pp.scene.add(mesh);
    entry.mesh = mesh;
    entry.geometry = geometry;
    entry.material = material;

    bpUpdateScaleUI(1, entry);
    bpCheckFit(bedDims);
  });
}

function bpCheckFit(bedDims) {
  const pp = slicerState.platePreview;
  if (!pp) return;

  let anyOutOfBounds = false;

  for (let i = 0; i < pp.meshes.length; i++) {
    const entry = pp.meshes[i];
    entry.mesh.updateMatrixWorld(true);
    const bbox = new THREE.Box3().setFromObject(entry.mesh);

    const outOfBounds = bbox.min.x < -1 || bbox.min.z < -1 ||
                        bbox.max.x > bedDims.x + 1 || bbox.max.z > bedDims.y + 1;

    if (outOfBounds) {
      anyOutOfBounds = true;
      entry.material.color.setHex(i === pp.selectedMeshIndex ? 0xff6666 : 0xff4444);
    } else if (i === pp.selectedMeshIndex) {
      entry.material.color.setHex(0x22d3ee);
      entry.material.emissive.setHex(0x112233);
    } else {
      entry.material.color.setHex(0x38bdf8);
      entry.material.emissive.setHex(0x000000);
    }
  }

  const warningEl = document.getElementById('bpFitWarning');
  if (warningEl) warningEl.style.display = anyOutOfBounds ? '' : 'none';
}

function bpOnCanvasClick(e) {
  const pp = slicerState.platePreview;
  if (!pp) return;

  const container = document.getElementById('bpCanvasContainer');
  if (!container) return;
  const rect = container.getBoundingClientRect();
  pp.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pp.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

  pp.raycaster.setFromCamera(pp.mouse, pp.camera);

  const meshObjects = pp.meshes.map(m => m.mesh);
  const intersects = pp.raycaster.intersectObjects(meshObjects);

  if (intersects.length > 0) {
    const hitMesh = intersects[0].object;
    const idx = pp.meshes.findIndex(m => m.mesh === hitMesh);
    bpSelectModel(idx);
  } else {
    bpSelectModel(-1);
  }
}

function bpWireEvents(bedDims) {
  const pp = slicerState.platePreview;
  if (!pp) return;

  // --- Drag-to-move on XZ bed plane ---
  let pointerDownPos = null;
  let isDraggingModel = false;
  let dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0); // Y=0 plane
  let dragOffset = new THREE.Vector3();

  pp.renderer.domElement.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    pointerDownPos = { x: e.clientX, y: e.clientY };

    // Check if we're clicking on the selected model to start drag
    if (pp.selectedMeshIndex >= 0) {
      const container = document.getElementById('bpCanvasContainer');
      const rect = container.getBoundingClientRect();
      pp.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pp.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      pp.raycaster.setFromCamera(pp.mouse, pp.camera);

      const entry = pp.meshes[pp.selectedMeshIndex];
      const hits = pp.raycaster.intersectObject(entry.mesh);
      if (hits.length > 0) {
        // Start dragging — disable orbit controls
        isDraggingModel = true;
        pp.controls.enabled = false;

        // Calculate offset from intersection point to mesh position
        const intersectPt = new THREE.Vector3();
        pp.raycaster.ray.intersectPlane(dragPlane, intersectPt);
        dragOffset.subVectors(entry.mesh.position, intersectPt);
        dragOffset.y = 0; // only care about XZ offset

        e.preventDefault();
      }
    }
  });

  pp.renderer.domElement.addEventListener('pointermove', (e) => {
    if (!isDraggingModel || pp.selectedMeshIndex < 0) return;

    const container = document.getElementById('bpCanvasContainer');
    const rect = container.getBoundingClientRect();
    pp.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pp.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    pp.raycaster.setFromCamera(pp.mouse, pp.camera);

    const intersectPt = new THREE.Vector3();
    if (pp.raycaster.ray.intersectPlane(dragPlane, intersectPt)) {
      const entry = pp.meshes[pp.selectedMeshIndex];
      const prevY = entry.mesh.position.y;
      entry.mesh.position.x = intersectPt.x + dragOffset.x;
      entry.mesh.position.z = intersectPt.z + dragOffset.z;
      entry.mesh.position.y = prevY; // keep Y (on-bed offset) unchanged
      bpCheckFit(bedDims);
    }
  });

  pp.renderer.domElement.addEventListener('pointerup', (e) => {
    if (e.button !== 0) return;

    if (isDraggingModel) {
      isDraggingModel = false;
      pp.controls.enabled = true;
      pointerDownPos = null;
      // Save final drag position to plateTransforms
      if (pp.selectedMeshIndex >= 0) {
        bpSavePosition(pp.meshes[pp.selectedMeshIndex]);
      }
      return; // don't trigger click after drag
    }

    if (!pointerDownPos) return;
    const dx = e.clientX - pointerDownPos.x;
    const dy = e.clientY - pointerDownPos.y;
    pointerDownPos = null;
    if (Math.abs(dx) < 5 && Math.abs(dy) < 5) {
      bpOnCanvasClick(e);
    }
  });

  // --- Sidebar model list click delegation ---
  const listEl = document.getElementById('bpModelList');
  if (listEl) {
    listEl.addEventListener('click', (e) => {
      const item = e.target.closest('[data-bp-idx]');
      if (item) bpSelectModel(parseInt(item.dataset.bpIdx, 10));
    });
  }

  // --- Rotation buttons ---
  document.querySelectorAll('.bp-rot-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      bpRotateSelected(btn.dataset.axis, parseInt(btn.dataset.dir, 10));
    });
  });

  // Reset rotation
  const resetBtn = document.getElementById('bpResetRotation');
  if (resetBtn) resetBtn.addEventListener('click', bpResetRotation);

  // --- Scale controls ---
  const scaleSlider = document.getElementById('bpScaleSlider');
  if (scaleSlider) {
    scaleSlider.addEventListener('input', () => {
      const pct = parseInt(scaleSlider.value, 10);
      bpScaleSelected(pct / 100);
    });
  }
  const scaleUp = document.getElementById('bpScaleUp');
  if (scaleUp) {
    scaleUp.addEventListener('click', () => {
      const pp2 = slicerState.platePreview;
      if (!pp2 || pp2.selectedMeshIndex < 0) return;
      const t = slicerState.plateTransforms[pp2.meshes[pp2.selectedMeshIndex].stlId];
      const cur = (t && t.scale) ? t.scale : 1;
      bpScaleSelected(cur + 0.1);
    });
  }
  const scaleDown = document.getElementById('bpScaleDown');
  if (scaleDown) {
    scaleDown.addEventListener('click', () => {
      const pp2 = slicerState.platePreview;
      if (!pp2 || pp2.selectedMeshIndex < 0) return;
      const t = slicerState.plateTransforms[pp2.meshes[pp2.selectedMeshIndex].stlId];
      const cur = (t && t.scale) ? t.scale : 1;
      bpScaleSelected(cur - 0.1);
    });
  }

  // Drop to plate
  const dropBtn = document.getElementById('bpDropToPlate');
  if (dropBtn) dropBtn.addEventListener('click', bpDropToPlate);

  // Max size
  const maxSizeBtn = document.getElementById('bpMaxSize');
  if (maxSizeBtn) maxSizeBtn.addEventListener('click', bpMaxSize);

  // Center on bed
  const centerBtn = document.getElementById('bpCenterOnBed');
  if (centerBtn) centerBtn.addEventListener('click', bpCenterOnBed);

  // Reset all transforms
  const resetAllBtn = document.getElementById('bpResetAll');
  if (resetAllBtn) resetAllBtn.addEventListener('click', bpResetAllTransforms);

  // --- Keyboard shortcuts ---
  function onKeyDown(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'Escape') { bpClosePreview(); return; }
    if (pp.selectedMeshIndex >= 0) {
      if (e.key === 'x' || e.key === 'X') { bpRotateSelected('x', e.shiftKey ? -1 : 1); e.preventDefault(); }
      if (e.key === 'y' || e.key === 'Y') { bpRotateSelected('y', e.shiftKey ? -1 : 1); e.preventDefault(); }
      if (e.key === 'z' || e.key === 'Z') { bpRotateSelected('z', e.shiftKey ? -1 : 1); e.preventDefault(); }
      if (e.key === 'r' || e.key === 'R') { bpResetRotation(); e.preventDefault(); }
      if (e.key === 'd' || e.key === 'D') { bpDropToPlate(); e.preventDefault(); }
      if (e.key === 'm' || e.key === 'M') { bpMaxSize(); e.preventDefault(); }
      // Arrow keys to nudge position
      const nudge = e.shiftKey ? 10 : 1;
      const nudgeEntry = pp.meshes[pp.selectedMeshIndex];
      if (e.key === 'ArrowLeft')  { nudgeEntry.mesh.position.x -= nudge; bpSavePosition(nudgeEntry); bpCheckFit(bedDims); e.preventDefault(); }
      if (e.key === 'ArrowRight') { nudgeEntry.mesh.position.x += nudge; bpSavePosition(nudgeEntry); bpCheckFit(bedDims); e.preventDefault(); }
      if (e.key === 'ArrowUp')    { nudgeEntry.mesh.position.z -= nudge; bpSavePosition(nudgeEntry); bpCheckFit(bedDims); e.preventDefault(); }
      if (e.key === 'ArrowDown')  { nudgeEntry.mesh.position.z += nudge; bpSavePosition(nudgeEntry); bpCheckFit(bedDims); e.preventDefault(); }
      // + / - for scale
      if (e.key === '+' || e.key === '=') {
        const t = slicerState.plateTransforms[pp.meshes[pp.selectedMeshIndex].stlId];
        bpScaleSelected(((t && t.scale) || 1) + 0.1);
        e.preventDefault();
      }
      if (e.key === '-' || e.key === '_') {
        const t = slicerState.plateTransforms[pp.meshes[pp.selectedMeshIndex].stlId];
        bpScaleSelected(((t && t.scale) || 1) - 0.1);
        e.preventDefault();
      }
    }
  }
  document.addEventListener('keydown', onKeyDown);
  pp._keydownHandler = onKeyDown;

  // --- Navigation buttons ---
  const backBtn = document.getElementById('bpBackBtn');
  if (backBtn) backBtn.addEventListener('click', bpClosePreview);

  const continueBtn = document.getElementById('bpContinueBtn');
  if (continueBtn) {
    continueBtn.addEventListener('click', () => {
      const isSingle = pp._isSingleItem;
      bpClosePreview();
      if (!isSingle) slicerShowPlateSettings();
    });
  }
}

function bpClosePreview() {
  const pp = slicerState.platePreview;
  if (!pp) return;

  if (pp._keydownHandler) document.removeEventListener('keydown', pp._keydownHandler);
  if (pp.animId) cancelAnimationFrame(pp.animId);
  if (pp.resizeObs) pp.resizeObs.disconnect();
  if (pp.controls) pp.controls.dispose();

  // Dispose model meshes
  for (const entry of pp.meshes) {
    if (entry.geometry) entry.geometry.dispose();
    if (entry.material) entry.material.dispose();
  }

  // Dispose bed, grid, border
  if (pp.bedGeo) pp.bedGeo.dispose();
  if (pp.bedMat) pp.bedMat.dispose();
  if (pp.gridGeo) pp.gridGeo.dispose();
  if (pp.gridMat) pp.gridMat.dispose();
  if (pp.borderGeo) pp.borderGeo.dispose();
  if (pp.borderMat) pp.borderMat.dispose();

  if (pp.renderer) pp.renderer.dispose();

  const modal = document.getElementById('slicerBuildPlateModal');
  if (modal) modal.remove();

  slicerState.platePreview = null;
}

async function slicerShowBuildPlatePreview(itemsOverride) {
  // itemsOverride: optional array of catalog items (for single-item preview)
  const items = itemsOverride || slicerState.plateItems;
  if (!items || items.length === 0) return alert('No models to preview');
  const isSingleItem = !!itemsOverride;

  // Clean up any existing preview
  if (slicerState.platePreview) bpClosePreview();

  const bedDims = slicerGetBedDimensions();
  const n = items.length;

  // Create modal DOM
  const modal = document.createElement('div');
  modal.id = 'slicerBuildPlateModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.9);z-index:9999;display:flex;flex-direction:column;';
  modal.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 20px;border-bottom:1px solid rgba(255,255,255,0.1);">
      <h3 style="margin:0;color:#fff;">Build Plate Preview</h3>
      <div style="display:flex;gap:8px;align-items:center;">
        <span id="bpBedSize" class="muted" style="font-size:0.85rem;color:rgba(255,255,255,0.6);"></span>
        <button id="bpBackBtn" style="background:none;border:1px solid rgba(255,255,255,0.3);color:#fff;padding:6px 16px;border-radius:6px;cursor:pointer;font-size:0.9rem;">Back</button>
        <button id="bpContinueBtn" style="background:var(--accent,#6366f1);color:#fff;border:none;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:0.95rem;font-weight:600;">${isSingleItem ? 'Close' : 'Continue to Settings &rarr;'}</button>
      </div>
    </div>
    <div style="flex:1;display:flex;overflow:hidden;">
      <div id="bpCanvasContainer" style="flex:1;position:relative;overflow:hidden;"></div>
      <div id="bpSidebar" style="width:280px;background:rgba(15,23,42,0.95);border-left:1px solid rgba(255,255,255,0.1);display:flex;flex-direction:column;overflow-y:auto;">
        <div style="padding:12px 14px;border-bottom:1px solid rgba(255,255,255,0.1);">
          <div style="font-weight:600;font-size:0.9rem;color:#fff;margin-bottom:4px;">Models on Plate (${n})</div>
          <div class="muted" style="font-size:0.8rem;color:rgba(255,255,255,0.5);">Click to select &bull; Drag to move &bull; X/Y/Z rotate</div>
        </div>
        <div id="bpModelList" style="flex:1;overflow-y:auto;padding:8px;"></div>
        <div id="bpRotationControls" style="display:none;padding:14px;border-top:1px solid rgba(255,255,255,0.1);">
          <div style="font-weight:600;font-size:0.85rem;color:#fff;margin-bottom:10px;">Rotate Selected Model</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            <button class="bp-rot-btn" data-axis="x" data-dir="1" style="flex:1;min-width:65px;padding:8px 4px;border:1px solid rgba(255,255,255,0.2);border-radius:6px;background:rgba(56,189,248,0.1);color:#fff;cursor:pointer;font-size:0.85rem;">X +90&deg;</button>
            <button class="bp-rot-btn" data-axis="x" data-dir="-1" style="flex:1;min-width:65px;padding:8px 4px;border:1px solid rgba(255,255,255,0.2);border-radius:6px;background:rgba(56,189,248,0.1);color:#fff;cursor:pointer;font-size:0.85rem;">X -90&deg;</button>
            <button class="bp-rot-btn" data-axis="y" data-dir="1" style="flex:1;min-width:65px;padding:8px 4px;border:1px solid rgba(255,255,255,0.2);border-radius:6px;background:rgba(56,189,248,0.1);color:#fff;cursor:pointer;font-size:0.85rem;">Y +90&deg;</button>
            <button class="bp-rot-btn" data-axis="y" data-dir="-1" style="flex:1;min-width:65px;padding:8px 4px;border:1px solid rgba(255,255,255,0.2);border-radius:6px;background:rgba(56,189,248,0.1);color:#fff;cursor:pointer;font-size:0.85rem;">Y -90&deg;</button>
            <button class="bp-rot-btn" data-axis="z" data-dir="1" style="flex:1;min-width:65px;padding:8px 4px;border:1px solid rgba(255,255,255,0.2);border-radius:6px;background:rgba(56,189,248,0.1);color:#fff;cursor:pointer;font-size:0.85rem;">Z +90&deg;</button>
            <button class="bp-rot-btn" data-axis="z" data-dir="-1" style="flex:1;min-width:65px;padding:8px 4px;border:1px solid rgba(255,255,255,0.2);border-radius:6px;background:rgba(56,189,248,0.1);color:#fff;cursor:pointer;font-size:0.85rem;">Z -90&deg;</button>
          </div>
          <button id="bpResetRotation" style="width:100%;margin-top:8px;padding:6px;border:1px solid rgba(255,255,255,0.2);border-radius:6px;background:none;color:rgba(255,255,255,0.7);cursor:pointer;font-size:0.8rem;">Reset Rotation (R)</button>
          <div style="margin-top:14px;border-top:1px solid rgba(255,255,255,0.1);padding-top:12px;">
            <div style="font-weight:600;font-size:0.85rem;color:#fff;margin-bottom:8px;">Uniform Scale</div>
            <div style="display:flex;align-items:center;gap:8px;">
              <button id="bpScaleDown" style="width:36px;height:36px;border:1px solid rgba(255,255,255,0.2);border-radius:6px;background:rgba(56,189,248,0.1);color:#fff;cursor:pointer;font-size:1.1rem;font-weight:700;">−</button>
              <div style="flex:1;text-align:center;">
                <span id="bpScaleValue" style="font-size:1rem;font-weight:700;color:var(--accent);">100%</span>
              </div>
              <button id="bpScaleUp" style="width:36px;height:36px;border:1px solid rgba(255,255,255,0.2);border-radius:6px;background:rgba(56,189,248,0.1);color:#fff;cursor:pointer;font-size:1.1rem;font-weight:700;">+</button>
            </div>
            <input id="bpScaleSlider" type="range" min="1" max="10000" value="100" step="5"
              style="width:100%;margin-top:6px;accent-color:var(--accent);">
            <div id="bpScaleDims" class="muted" style="font-size:0.75rem;text-align:center;margin-top:4px;color:rgba(255,255,255,0.5);"></div>
          </div>
          <div style="margin-top:12px;border-top:1px solid rgba(255,255,255,0.1);padding-top:10px;">
            <button id="bpDropToPlate" style="width:100%;padding:8px;border:1px solid rgba(34,211,238,0.4);border-radius:6px;background:rgba(34,211,238,0.1);color:#22d3ee;cursor:pointer;font-size:0.85rem;font-weight:600;">⬇ Drop to Plate</button>
            <button id="bpMaxSize" style="width:100%;margin-top:6px;padding:8px;border:1px solid rgba(168,85,247,0.4);border-radius:6px;background:rgba(168,85,247,0.1);color:#a855f7;cursor:pointer;font-size:0.85rem;font-weight:600;">⤢ Max Size</button>
            <button id="bpCenterOnBed" style="width:100%;margin-top:6px;padding:6px;border:1px solid rgba(255,255,255,0.2);border-radius:6px;background:none;color:rgba(255,255,255,0.7);cursor:pointer;font-size:0.8rem;">Center on Bed</button>
            <button id="bpResetAll" style="width:100%;margin-top:6px;padding:6px;border:1px solid rgba(239,68,68,0.3);border-radius:6px;background:none;color:rgba(239,68,68,0.8);cursor:pointer;font-size:0.8rem;">Reset All (Rotation + Scale)</button>
          </div>
        </div>
      </div>
    </div>
    <div id="bpStatusBar" style="padding:8px 20px;border-top:1px solid rgba(255,255,255,0.1);display:flex;align-items:center;gap:12px;">
      <span id="bpStatusText" class="muted" style="font-size:0.85rem;color:rgba(255,255,255,0.5);">Loading models...</span>
      <span id="bpFitWarning" style="display:none;color:#ef4444;font-size:0.85rem;font-weight:600;">&#9888; Some models extend beyond the bed!</span>
    </div>`;

  document.body.appendChild(modal);

  // Init 3D scene
  const container = document.getElementById('bpCanvasContainer');
  bpInitScene(container, bedDims);

  // Store items on the preview state for bpLoadAllModels to use
  slicerState.platePreview._items = items;
  slicerState.platePreview._isSingleItem = isSingleItem;

  // Load and arrange models
  await bpLoadAllModels(bedDims);

  // Wire events
  bpWireEvents(bedDims);
}

function slicerShowPlateSettings() {
  if (slicerState.plateItems.length === 0) return alert('No models on the plate');

  // Hide catalog, show plate settings
  document.getElementById('slicerCatalogPanel').style.display = 'none';
  document.getElementById('slicerSettingsPanel').style.display = 'none';
  document.getElementById('slicerPlateSettingsPanel').style.display = '';

  // Render plate items list
  const listEl = document.getElementById('slicerPlateItemsList');
  if (listEl) {
    listEl.innerHTML = slicerState.plateItems.map(item => `
      <div class="slicer-plate-item-row" data-plate-item-id="${item.id}">
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;font-size:0.95rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${slicerEsc(item.name)}</div>
          <div class="muted" style="font-size:0.8rem;">
            ${item.category ? slicerEsc(item.category) + ' · ' : ''}${item.dim_x ? `${item.dim_x.toFixed(1)} x ${item.dim_y.toFixed(1)} x ${item.dim_z.toFixed(1)} mm` : ''}
          </div>
        </div>
        <button class="plate-item-remove" data-plate-remove-id="${item.id}" title="Remove from plate">&times;</button>
      </div>
    `).join('');

    // Wire remove buttons
    listEl.querySelectorAll('.plate-item-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = parseInt(btn.dataset.plateRemoveId, 10);
        slicerState.plateItems = slicerState.plateItems.filter(i => i.id !== id);
        slicerUpdatePlateBar();
        if (slicerState.plateItems.length === 0) {
          // Go back to catalog if plate is now empty
          document.getElementById('slicerPlateSettingsPanel').style.display = 'none';
          document.getElementById('slicerCatalogPanel').style.display = '';
          return;
        }
        slicerShowPlateSettings(); // Re-render
      });
    });
  }

  // Build settings buttons for plate panel
  slicerBuildPlateSettingsButtons();

  // Populate plate printer dropdown
  slicerPopulatePlatePrinterDropdown();
}

function slicerBuildPlateSettingsButtons() {
  const presets = slicerState.presets;
  if (!presets) return;

  const groups = {
    quality: 'slicerPlateQuality',
    strength: 'slicerPlateStrength',
    speed: 'slicerPlateSpeed',
    texture: 'slicerPlateTexture',
    surface: 'slicerPlateSurface',
    supports: 'slicerPlateSupports',
    material: 'slicerPlateMaterial'
  };

  const presetToField = {
    quality: 'quality',
    strength: 'strength',
    speed: 'speed',
    texture: 'texture',
    surface: 'surface',
    supports: 'supports',
    materials: 'material'
  };

  for (const [presetKey, fieldKey] of Object.entries(presetToField)) {
    const options = presets[presetKey];
    const containerId = groups[fieldKey];
    const container = document.getElementById(containerId);
    if (!container || !options) continue;

    container.innerHTML = options.map(opt => {
      const key = opt.key || opt.model;
      const label = opt.label || opt.name;
      const desc = opt.description || '';
      return `<button class="slicer-opt-btn" data-value="${slicerEsc(key)}" title="${slicerEsc(desc)}">${slicerEsc(label)}</button>`;
    }).join('');
  }

  // Sync current settings to plate buttons
  const settings = slicerState.settings;
  Object.entries(groups).forEach(([field, containerId]) => {
    const container = document.getElementById(containerId);
    if (container && settings[field]) {
      slicerHighlightButtons(container, settings[field]);
    }
  });
}

function slicerPopulatePlatePrinterDropdown() {
  const select = document.getElementById('slicerPlatePrinter');
  if (!select) return;

  const printers = slicerState.printers || [];
  select.innerHTML = '<option value="">Select a printer...</option>' +
    printers.map(p => {
      const label = `${p.name}${p.model ? ' (' + p.model + ')' : ''}`;
      return `<option value="${p.id}">${slicerEsc(label)}</option>`;
    }).join('');

  // Wire ACE slot picker
  select.onchange = () => {
    const printerId = select.value;
    const slotGroup = document.getElementById('slicerPlateAceSlotGroup');
    const slotSelect = document.getElementById('slicerPlateAceSlot');
    if (!slotGroup || !slotSelect) return;

    if (!printerId) {
      slotGroup.style.display = 'none';
      slotSelect.value = '';
      return;
    }

    const printer = slicerState.printers.find(p => String(p.id) === String(printerId));
    if (!printer || !printer.has_multicolor) {
      slotGroup.style.display = 'none';
      slotSelect.value = '';
      return;
    }

    let aceSlots = [];
    try { aceSlots = printer.ace_slots ? JSON.parse(printer.ace_slots) : []; } catch (_) {}

    if (!aceSlots.length) {
      slotGroup.style.display = 'none';
      slotSelect.value = '';
      return;
    }

    slotGroup.style.display = '';
    slotSelect.innerHTML = '<option value="">Select filament slot...</option>' +
      aceSlots.map(s => {
        const label = `T${s.slot}: ${s.name || s.material || '?'}${s.color ? ' (' + s.color + ')' : ''}`;
        return `<option value="${s.slot}" data-material="${slicerEsc((s.material || 'PLA').toLowerCase())}">${slicerEsc(label)}</option>`;
      }).join('');

    // ACE slot selection — don't override the user's manual material choice.
    slotSelect.onchange = () => {};
  };
  // Reset slot picker
  select.onchange();
}

async function slicerSlicePlate() {
  if (!slicerState.plateItems.length) return alert('No models on the plate');

  // Get printer info (may be null)
  const printerId = document.getElementById('slicerPlatePrinter')?.value || null;
  let printerModel = '';
  let printerName = '';
  if (printerId) {
    const printer = slicerState.printers.find(p => String(p.id) === String(printerId));
    if (printer) {
      printerName = printer.name || '';
      if (printer.model) printerModel = slicerMapPrinterModel(printer.model);
    }
  }

  // Collect per-model transforms from the build plate preview
  const transforms = {};
  for (const item of slicerState.plateItems) {
    const t = slicerState.plateTransforms[item.id];
    if (t) {
      transforms[item.id] = {
        rx: t.rx || 0, ry: t.ry || 0, rz: t.rz || 0,
        scale: t.scale || 1, posX: t.posX || 0, posZ: t.posZ || 0
      };
    }
  }

  const sliceOptions = {
    stl_ids: slicerState.plateItems.map(i => i.id),
    transforms,
    printer_model: printerModel || 'kobra3',
    material: slicerState.settings.material,
    quality: slicerState.settings.quality,
    strength: slicerState.settings.strength,
    speed: slicerState.settings.speed,
    texture: slicerState.settings.texture,
    surface: slicerState.settings.surface,
    supports: slicerState.settings.supports,
    auto_orient: slicerState.settings.auto_orient
  };

  // Read ACE slot
  const aceSlotVal = document.getElementById('slicerPlateAceSlot')?.value;
  const aceSlot = (aceSlotVal !== '' && aceSlotVal != null) ? parseInt(aceSlotVal, 10) : null;
  const aceSlotLabel = aceSlot != null ? document.getElementById('slicerPlateAceSlot')?.selectedOptions?.[0]?.textContent || `T${aceSlot}` : '';

  const modelCount = slicerState.plateItems.length;

  // STEP 1: Pre-slice approval modal (with temperatures)
  const approved = await slicerShowApprovalModal({
    items: slicerState.plateItems,
    settings: slicerState.settings,
    printerName,
    printerModel,
    aceSlotLabel,
    isPlate: true,
    andPrint: false
  });
  if (!approved) return;

  // STEP 2: Slice (blocking, with step progress)
  const sliceSteps = ['Slicing plate', 'Loading G-code preview'];
  slicerShowProgress('Slicing Plate...', sliceSteps, 0, `PrusaSlicer is processing ${modelCount} models on the server`);
  let sliceResult;
  try {
    sliceResult = await printStation.slicer.slicePlate(sliceOptions);
    if (sliceResult.error) throw new Error(sliceResult.error);
  } catch (err) {
    slicerHideProgress();
    console.error('[Slicer] Plate slice error:', err);
    const msg = err?.message || err?.error || JSON.stringify(err) || 'Unknown error';
    showToast('Plate slicing failed: ' + msg, 'error', 8000);
    return;
  }

  const cached = sliceResult.cached ? ' (cache hit)' : '';

  // STEP 3: Fetch G-code text for visualization
  slicerUpdateProgress(1, 'Downloading G-code for 3D preview...');
  let gcodeText;
  try {
    gcodeText = await printStation.slicer.fetchGcodeText(sliceResult.gcode_id);
  } catch (err) {
    slicerHideProgress();
    console.error('[Slicer] Fetch G-code text error:', err);
    showToast('Could not load G-code for preview: ' + err.message, 'error', 6000);
    return;
  }
  slicerHideProgress();
  showToast(`Plate slicing complete${cached}!`, 'success', 3000);

  // STEP 4: Show G-code 3D preview
  const action = await slicerShowGcodePreview({
    gcodeText,
    gcodeId: sliceResult.gcode_id,
    sliceResult,
    printerId: printerId ? parseInt(printerId, 10) : null,
    aceSlot,
    printerName
  });

  // STEP 5: Handle user decision — send to printer with step progress
  if (action === 'print') {
    if (!printerId) {
      showToast('No printer selected. G-code saved but not sent to printer.', 'warning', 6000);
    } else {
      const printSteps = ['Downloading G-code', 'Preparing file', 'Uploading to printer', 'Starting print'];
      slicerShowProgress('Sending to Printer...', printSteps, 0, 'Downloading G-code from server...');

      const offProgress = printStation.slicer.onPrintProgress(({ step, detail }) => {
        slicerUpdateProgress(step - 1, detail);
      });

      try {
        const result = await printStation.slicer.printGcode(sliceResult.gcode_id, parseInt(printerId, 10), aceSlot);
        offProgress();
        slicerHideProgress();
        if (result.success) {
          showToast(`Plate print started on ${printerName} (Job #${result.job?.id || ''})`, 'success', 6000);
        }
      } catch (err) {
        offProgress();
        slicerHideProgress();
        console.error('[Slicer] Print error:', err);
        const msg = err?.message || err?.error || JSON.stringify(err) || 'Unknown error';
        showToast('Print failed: ' + msg, 'error', 8000);
      }
    }
  }
}

// ============================================================================
// 3D PREVIEW — THUMBNAILS + VIEWER
// ============================================================================

/**
 * Fetch STL bytes (from cache or server), returns ArrayBuffer
 */
/**
 * Batch-check which STL thumbnails are cached on disk.
 * Populates slicerState.thumbDiskCache with file:// URLs.
 */
async function slicerPrefetchDiskThumbs(stlIds) {
  if (!stlIds.length) return;
  try {
    const result = await printStation.slicer.getThumbsCached(stlIds);
    for (const [id, url] of Object.entries(result)) {
      if (url) slicerState.thumbDiskCache[id] = url;
    }
  } catch (err) {
    console.warn('[Slicer] Disk thumb prefetch failed:', err.message);
  }
}

async function slicerFetchStlBuffer(stlId) {
  if (slicerState.stlBytesCache[stlId]) return slicerState.stlBytesCache[stlId];
  const base64 = await printStation.slicer.fetchStlBytes(stlId);
  const binaryStr = atob(base64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
  slicerState.stlBytesCache[stlId] = bytes.buffer;
  return bytes.buffer;
}

/**
 * Render a single STL to a canvas (single render pass, no animation loop).
 * Returns the dataURL of the rendered image.
 */
function slicerRenderStlToCanvas(canvas, arrayBuffer) {
  const width = canvas.width;
  const height = canvas.height;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a1a);

  const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100000);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(width, height, false);

  // Lighting
  scene.add(new THREE.AmbientLight(0x606060, 1.5));
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
  dirLight.position.set(5, 10, 7);
  scene.add(dirLight);
  const dirLight2 = new THREE.DirectionalLight(0x88aaff, 0.5);
  dirLight2.position.set(-5, -3, -5);
  scene.add(dirLight2);

  // Parse STL
  const loader = new THREE.STLLoader();
  const geometry = loader.parse(arrayBuffer);
  geometry.computeVertexNormals();
  geometry.center();

  const material = new THREE.MeshPhongMaterial({
    color: 0x38bdf8, specular: 0x222222, shininess: 40
  });
  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);

  // Auto-position camera
  const box = new THREE.Box3().setFromObject(mesh);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const fov = camera.fov * (Math.PI / 180);
  const dist = maxDim / (2 * Math.tan(fov / 2)) * 1.8;
  camera.position.set(dist * 0.7, dist * 0.5, dist * 0.7);
  camera.lookAt(0, 0, 0);

  // Render once
  renderer.render(scene, camera);
  const dataUrl = canvas.toDataURL('image/png');

  // Cleanup
  geometry.dispose();
  material.dispose();
  renderer.dispose();

  return dataUrl;
}

/**
 * Render thumbnails for all .slicer-stl-thumb canvases in the grid.
 * Processes one at a time to avoid GPU memory spikes.
 */
async function slicerRenderThumbnails() {
  const canvases = document.querySelectorAll('.slicer-stl-thumb');
  for (const canvas of canvases) {
    const stlId = parseInt(canvas.dataset.stlId, 10);
    if (!stlId) continue;
    try {
      const buf = await slicerFetchStlBuffer(stlId);
      const dataUrl = slicerRenderStlToCanvas(canvas, buf);
      slicerState.thumbCache[stlId] = dataUrl;
      // Persist to disk cache (fire-and-forget)
      printStation.slicer.saveThumbCache(stlId, dataUrl).then(fileUrl => {
        if (fileUrl) slicerState.thumbDiskCache[stlId] = fileUrl;
      }).catch(() => {});
    } catch (err) {
      console.warn('[Slicer] Thumb render failed for STL', stlId, err.message);
    }
  }
}

/**
 * Render an interactive preview into the #slicerSelectedCanvas.
 */
function slicerRenderSelectedPreview(arrayBuffer) {
  // Dispose previous
  slicerDisposeSelectedPreview();

  const canvas = document.getElementById('slicerSelectedCanvas');
  if (!canvas) return;

  const width = canvas.width;
  const height = canvas.height;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a1a);

  const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100000);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(width, height, false);

  scene.add(new THREE.AmbientLight(0x606060, 1.5));
  const d1 = new THREE.DirectionalLight(0xffffff, 1.2);
  d1.position.set(5, 10, 7);
  scene.add(d1);
  const d2 = new THREE.DirectionalLight(0x88aaff, 0.5);
  d2.position.set(-5, -3, -5);
  scene.add(d2);

  const loader = new THREE.STLLoader();
  const geometry = loader.parse(arrayBuffer);
  geometry.computeVertexNormals();
  geometry.center();

  const material = new THREE.MeshPhongMaterial({
    color: 0x38bdf8, specular: 0x222222, shininess: 40
  });
  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);

  const box = new THREE.Box3().setFromObject(mesh);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const fov = camera.fov * (Math.PI / 180);
  const dist = maxDim / (2 * Math.tan(fov / 2)) * 1.8;
  camera.position.set(dist * 0.7, dist * 0.5, dist * 0.7);
  camera.lookAt(0, 0, 0);

  const controls = new THREE.OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;

  let animId;
  function animate() {
    animId = requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  slicerState.selectedPreview = { renderer, scene, camera, controls, animId, geometry, material };
}

function slicerDisposeSelectedPreview() {
  const p = slicerState.selectedPreview;
  if (!p) return;
  if (p.animId) cancelAnimationFrame(p.animId);
  if (p.controls) p.controls.dispose();
  if (p.geometry) p.geometry.dispose();
  if (p.material) p.material.dispose();
  if (p.renderer) p.renderer.dispose();
  slicerState.selectedPreview = null;
}

/**
 * Full-screen 3D viewer modal
 */
async function slicerShow3dViewer(stlId) {
  const existing = document.getElementById('slicer3dModal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'slicer3dModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:9999;display:flex;flex-direction:column;';
  modal.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 20px;">
      <h3 style="margin:0;color:#fff;">${slicerEsc(slicerState.selectedItem?.name || 'STL Viewer')}</h3>
      <button id="slicer3dClose" style="background:none;border:1px solid rgba(255,255,255,0.3);color:#fff;padding:6px 16px;border-radius:6px;cursor:pointer;font-size:0.9rem;">Close</button>
    </div>
    <div id="slicer3dContainer" style="flex:1;overflow:hidden;position:relative;"></div>`;
  document.body.appendChild(modal);

  const container = document.getElementById('slicer3dContainer');
  const width = container.clientWidth;
  const height = container.clientHeight;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a1a);

  const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100000);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  scene.add(new THREE.AmbientLight(0x606060, 1.5));
  const dl1 = new THREE.DirectionalLight(0xffffff, 1.2);
  dl1.position.set(5, 10, 7);
  scene.add(dl1);
  const dl2 = new THREE.DirectionalLight(0x88aaff, 0.5);
  dl2.position.set(-5, -3, -5);
  scene.add(dl2);

  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;

  let animId;
  let geo, mat;

  try {
    const buf = await slicerFetchStlBuffer(stlId);
    const loader = new THREE.STLLoader();
    geo = loader.parse(buf);
    geo.computeVertexNormals();
    geo.center();

    mat = new THREE.MeshPhongMaterial({
      color: 0x38bdf8, specular: 0x222222, shininess: 40
    });
    const mesh = new THREE.Mesh(geo, mat);
    scene.add(mesh);

    // Grid
    const box = new THREE.Box3().setFromObject(mesh);
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const gridSize = maxDim * 2;
    scene.add(new THREE.GridHelper(gridSize, 20, 0x333355, 0x222244));

    // Camera positioning
    const fov = camera.fov * (Math.PI / 180);
    const dist = maxDim / (2 * Math.tan(fov / 2)) * 1.8;
    camera.position.set(dist * 0.7, dist * 0.5, dist * 0.7);
    camera.lookAt(0, 0, 0);
    controls.target.set(0, 0, 0);
    controls.update();
  } catch (err) {
    console.error('[Slicer] 3D viewer load error:', err);
  }

  function animate() {
    animId = requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  // Resize handling
  const resizeObs = new ResizeObserver(() => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  });
  resizeObs.observe(container);

  // Cleanup on close
  function close3d() {
    cancelAnimationFrame(animId);
    resizeObs.disconnect();
    controls.dispose();
    if (geo) geo.dispose();
    if (mat) mat.dispose();
    renderer.dispose();
    modal.remove();
  }

  document.getElementById('slicer3dClose').addEventListener('click', close3d);
  modal.addEventListener('click', (e) => { if (e.target === modal) close3d(); });
}

// ============================================================================
// PROGRESS OVERLAY
// ============================================================================

/**
 * Show progress overlay with step indicators.
 * @param {string} title - Overlay title
 * @param {string[]} steps - Array of step labels, e.g. ['Slicing model', 'Loading preview']
 * @param {number} [activeStep=0] - 0-based index of the current step
 * @param {string} [detail] - Detail text below steps
 */
function slicerShowProgress(title, steps, activeStep, detail) {
  const overlay = document.getElementById('slicerProgressOverlay');
  const titleEl = document.getElementById('slicerProgressTitle');
  const stepsEl = document.getElementById('slicerProgressSteps');
  const msgEl = document.getElementById('slicerProgressMsg');
  const bar = document.getElementById('slicerProgressBar');

  if (overlay) overlay.style.display = 'flex';
  if (titleEl) titleEl.textContent = title || 'Processing...';

  // Store steps in state for updates
  slicerState._progressSteps = steps || [];
  slicerState._progressActive = typeof activeStep === 'number' ? activeStep : 0;

  slicerRenderProgressSteps();

  if (msgEl) msgEl.textContent = detail || '';
  if (bar) {
    if (steps && steps.length > 1) {
      const pct = Math.round(((slicerState._progressActive) / steps.length) * 100);
      bar.style.animation = '';
      bar.style.width = pct + '%';
    } else {
      bar.style.width = '0%';
      bar.style.animation = 'slicerPulse 2s infinite';
    }
  }
  slicerState.loading = true;
}

/**
 * Update the active step and detail text without re-showing the overlay.
 */
function slicerUpdateProgress(activeStep, detail) {
  slicerState._progressActive = activeStep;
  slicerRenderProgressSteps();

  const msgEl = document.getElementById('slicerProgressMsg');
  if (msgEl && detail) msgEl.textContent = detail;

  const bar = document.getElementById('slicerProgressBar');
  const steps = slicerState._progressSteps || [];
  if (bar && steps.length > 1) {
    const pct = Math.round(((activeStep) / steps.length) * 100);
    bar.style.animation = '';
    bar.style.width = pct + '%';
  }
}

/**
 * Render the step list inside the progress overlay.
 */
function slicerRenderProgressSteps() {
  const stepsEl = document.getElementById('slicerProgressSteps');
  if (!stepsEl) return;
  const steps = slicerState._progressSteps || [];
  const active = slicerState._progressActive || 0;

  if (!steps.length) { stepsEl.innerHTML = ''; return; }

  stepsEl.innerHTML = steps.map((label, i) => {
    if (i < active) {
      // Completed
      return `<div style="display:flex;align-items:center;gap:8px;color:#4ade80;">
        <span style="font-size:1rem;width:20px;text-align:center;">&#10003;</span>
        <span style="text-decoration:line-through;opacity:0.7;">${slicerEsc(label)}</span>
      </div>`;
    } else if (i === active) {
      // Current
      return `<div style="display:flex;align-items:center;gap:8px;color:var(--accent,#60a5fa);font-weight:600;">
        <span style="font-size:0.7rem;width:20px;text-align:center;animation:slicerStepPulse 1.5s infinite;">&#9679;</span>
        <span>${slicerEsc(label)}</span>
      </div>`;
    } else {
      // Pending
      return `<div style="display:flex;align-items:center;gap:8px;color:var(--text-muted,#64748b);">
        <span style="font-size:0.7rem;width:20px;text-align:center;">&#9675;</span>
        <span>${slicerEsc(label)}</span>
      </div>`;
    }
  }).join('');
}

function slicerHideProgress() {
  const overlay = document.getElementById('slicerProgressOverlay');
  const bar = document.getElementById('slicerProgressBar');
  if (overlay) overlay.style.display = 'none';
  if (bar) bar.style.animation = '';
  slicerState.loading = false;
  slicerState._progressSteps = [];
  slicerState._progressActive = 0;
}

// ============================================================================
// HELPERS
// ============================================================================

function slicerEsc(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

function slicerFormatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function slicerFormatTime(minutes) {
  if (!minutes || minutes <= 0) return '0m';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function slicerLabelFor(category, key) {
  if (!slicerState.presets || !key) return key || '';

  const presetCategory = category === 'material' ? 'materials' : category;
  const options = slicerState.presets[presetCategory];
  if (!options) return key;

  const match = options.find(o => (o.key || o.model) === key);
  return match ? (match.label || match.name || key) : key;
}

function slicerMapPrinterModel(modelName) {
  if (!modelName) return 'kobra3';
  const lower = modelName.toLowerCase();
  if (lower.includes('kobra') && lower.includes('v2')) return 'kobra3_v2';
  if (lower.includes('kobra') && lower.includes('3')) return 'kobra3';
  if (lower.includes('s1') && lower.includes('pro')) return 'ender3_s1pro';
  if (lower.includes('ke') || lower.includes('v3')) return 'ender3_v3_ke';
  if (lower.includes('ender')) return 'ender3_s1pro';
  return 'kobra3';
}
