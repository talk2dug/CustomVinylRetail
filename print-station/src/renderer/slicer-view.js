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
    profile: 'custom',
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
  plateTransforms: {},   // { [stlId]: { rx, ry, rz, scale, posX, posZ } } — persists rotation + scale + position across preview open/close
  plateInstanceTransforms: null  // ordered array of per-instance { stlId, rx, ry, rz, scale, posX, posZ } from last preview — used for slicing
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

  // Sort order
  const sortSelect = document.getElementById('slicerSortOrder');
  if (sortSelect) {
    sortSelect.addEventListener('change', () => slicerRenderCatalog());
  }

  // Sub-tab navigation
  document.querySelectorAll('.slicer-sub-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      slicerShowSubTab(btn.dataset.tab);
    });
  });

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

  // Update Info — opens scrape modal
  const updateInfoBtn = document.getElementById('slicerUpdateInfoBtn');
  if (updateInfoBtn) {
    updateInfoBtn.addEventListener('click', () => {
      if (!slicerState.selectedItem) return;
      slicerOpenUpdateInfoModal(slicerState.selectedItem);
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
      if (v > 100) v = 100;
      copiesInput.value = v;
      slicerState.settings.copies = v;
    };
    copiesMinus.addEventListener('click', () => { copiesInput.value = Math.max(1, parseInt(copiesInput.value, 10) - 1); clampCopies(); });
    copiesPlus.addEventListener('click', () => { copiesInput.value = Math.min(100, parseInt(copiesInput.value, 10) + 1); clampCopies(); });
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

  // Single-item orientation buttons (Flip X/Y/Z)
  document.querySelectorAll('.sl-rot-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      slicerRotateSingle(btn.dataset.axis, parseInt(btn.dataset.dir, 10));
    });
  });
  const resetRotBtn = document.getElementById('slicerResetRotBtn');
  if (resetRotBtn) resetRotBtn.addEventListener('click', slicerResetSingleRotation);
  const saveDefaultOrientBtn = document.getElementById('slicerSaveDefaultOrientBtn');
  if (saveDefaultOrientBtn) saveDefaultOrientBtn.addEventListener('click', slicerSaveDefaultOrientation);

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
      const guideBtn = e.target.closest('.slicer-guide-btn');
      if (guideBtn) {
        e.stopPropagation();
        const id = parseInt(guideBtn.dataset.guideId, 10);
        slicerShowPartGuide(id);
        return;
      }
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
      // If a profile is active and user clicks an individual setting, revert to Custom
      if (slicerState.settings.profile && slicerState.settings.profile !== 'custom') {
        const setting = row.dataset.setting;
        const lockable = ['quality', 'strength', 'speed', 'texture', 'surface', 'supports'];
        if (lockable.includes(setting)) {
          slicerState.settings.profile = 'custom';
          slicerSyncSettingsButtons();
        }
      }
      const setting = row.dataset.setting;
      const value = btn.dataset.value;
      if (setting && value) {
        slicerState.settings[setting] = value;
        slicerHighlightButtons(row, value);
      }
    });
  });

  // Profile dropdown change handler
  ['slicerProfile', 'slicerPlateProfile'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    sel.addEventListener('change', () => {
      slicerApplyProfile(sel.value);
    });
  });
}

/**
 * Apply a print profile — sets individual settings to match the profile's visual mapping
 * and stores the profile key so the server uses the exact override values.
 */
function slicerApplyProfile(profileKey) {
  slicerState.settings.profile = profileKey;
  if (profileKey === 'custom' || !slicerState.presets?.profiles) {
    slicerUpdateProfileHint(null);
    slicerSyncSettingsButtons();
    return;
  }
  // Find the profile's visual mapping from presets
  const profile = slicerState.presets.profiles.find(p => p.key === profileKey);
  if (profile && profile.visual) {
    const v = profile.visual;
    if (v.quality) slicerState.settings.quality = v.quality;
    if (v.strength) slicerState.settings.strength = v.strength;
    if (v.speed) slicerState.settings.speed = v.speed;
    if (v.texture) slicerState.settings.texture = v.texture;
    if (v.surface) slicerState.settings.surface = v.surface;
    if (v.supports) slicerState.settings.supports = v.supports;
  }
  slicerUpdateProfileHint(profile?.hint || null);
  slicerSyncSettingsButtons();
}

function slicerUpdateProfileHint(hint) {
  const el = document.getElementById('slicerProfileHint');
  if (!el) return;
  if (hint) {
    el.textContent = hint;
    el.style.display = 'block';
  } else {
    el.textContent = '';
    el.style.display = 'none';
  }
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
    slicerState.folderCounts = result.folderCounts || {};
  } catch (err) {
    console.warn('[Slicer] Load folders error:', err);
    slicerState.folders = [];
    slicerState.folderCounts = {};
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
  const counts = slicerState.folderCounts || {};
  const visibleFolders = inFolder ? folders.filter(f => f !== inFolder) : folders;
  if (visibleFolders.length > 0) {
    folderTilesHtml = `<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;">
      ${visibleFolders.map(f => {
        const cnt = counts[f] || 0;
        return `
        <div class="slicer-folder-tile" data-folder="${slicerEsc(f)}"
          style="display:flex;align-items:center;gap:8px;padding:10px 16px;border:1px solid var(--border);
          border-radius:8px;background:var(--bg-secondary,#1e293b);cursor:pointer;min-width:120px;transition:all 0.15s;">
          <span style="font-size:1.3rem;">&#128193;</span>
          <span style="font-weight:500;font-size:0.9rem;">${slicerEsc(f)}</span>
          ${cnt ? `<span style="font-size:0.75rem;color:var(--muted);margin-left:auto;">${cnt}</span>` : ''}
        </div>`;
      }).join('')}
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

  // Sort catalog based on user selection
  const sortOrder = document.getElementById('slicerSortOrder')?.value || 'name-asc';
  slicerState.catalog.sort((a, b) => {
    switch (sortOrder) {
      case 'name-desc': return (b.name || '').localeCompare(a.name || '');
      case 'newest': return (b.id || 0) - (a.id || 0);
      case 'size': return (b.file_size || 0) - (a.file_size || 0);
      default: return (a.name || '').localeCompare(b.name || '');
    }
  });

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
      ? `<img src="${cachedUrl}" style="width:120px;height:120px;border-radius:8px;object-fit:cover;background:#0a0a1a;">`
      : `<canvas class="slicer-stl-thumb" data-stl-id="${item.id}" width="240" height="240" style="width:120px;height:120px;border-radius:8px;background:#0a0a1a;"></canvas>`;
    const selected = isPlate && plateIds.has(item.id);
    const checkHtml = isPlate ? `<div class="slicer-plate-check">${selected ? '✓' : ''}</div>` : '';
    const muBadge = (item.category === 'Multiboard' && item.mu_width && item.mu_height)
      ? `<span class="badge" style="font-size:0.75rem;padding:2px 8px;background:#4f46e5;border-radius:4px;margin-left:4px;">${item.mu_width}x${item.mu_height} MU</span>`
      : '';
    const guideBtn = item.category === 'Multiboard'
      ? `<button class="slicer-guide-btn" data-guide-id="${item.id}" title="Mounting Guide"
          style="position:absolute;top:8px;right:32px;background:none;border:none;color:#818cf8;cursor:pointer;font-size:1.1rem;padding:4px 8px;opacity:0.7;">&#9432;</button>`
      : '';
    return `
    <div class="inventory-card slicer-catalog-card${selected ? ' slicer-plate-selected' : ''}" data-stl-id="${item.id}" draggable="true" style="cursor:pointer;padding:16px;position:relative;">
      ${checkHtml}
      ${guideBtn}
      <button class="slicer-catalog-delete" data-stl-id="${item.id}" title="Delete"
        style="position:absolute;top:8px;right:8px;background:none;border:none;color:var(--danger);cursor:pointer;font-size:1rem;padding:4px 8px;opacity:0.6;">&times;</button>
      <div style="display:flex;gap:12px;align-items:flex-start;">
        <div style="width:120px;height:120px;border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
          ${thumbHtml}
        </div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;font-size:1rem;margin-bottom:4px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.3;">${slicerEsc(item.name)}</div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:4px;">
            ${item.category ? `<span class="badge" style="font-size:0.75rem;padding:2px 8px;background:var(--accent);border-radius:4px;">${slicerEsc(item.category)}</span>` : ''}
            ${muBadge}
          </div>
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

    // Pre-populate orientation from saved default (only if user hasn't already set a manual override)
    if (result.item.default_transform && !slicerState.plateTransforms[result.item.id]) {
      try {
        const dt = JSON.parse(result.item.default_transform);
        slicerState.plateTransforms[result.item.id] = {
          rx: dt.rx || 0, ry: dt.ry || 0, rz: dt.rz || 0,
          scale: dt.scale || 1, posX: 0, posZ: 0
        };
      } catch (e) { /* ignore bad JSON */ }
    }

    // Switch panels
    document.getElementById('slicerCatalogPanel').style.display = 'none';
    document.getElementById('slicerPlateSettingsPanel').style.display = 'none';
    document.getElementById('slicerSettingsPanel').style.display = '';

    // Populate info
    slicerRenderSelectedInfo(result.item);
    slicerRenderGcodeList(slicerState.gcodeEntries);
    slicerSyncSettingsButtons();
    slicerUpdateRotHint();

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

  // Show mount info if available
  const mountEl = document.getElementById('slicerSelectedMountInfo');
  if (mountEl) {
    const parts = [];
    if (item.mount_type) parts.push(`Mount: ${item.mount_type}`);
    if (item.mount_hardware) {
      try {
        const hw = JSON.parse(item.mount_hardware);
        hw.forEach(h => {
          if (h.type === 'magnet') parts.push(`${h.qty || '?'}x ${h.size || 'magnets'}`);
          else if (h.type === 'screw') parts.push(`${h.qty || '?'}x ${h.spec || 'screws'}`);
          else if (h.type === 'insert') parts.push(`${h.spec || '?'} inserts`);
        });
      } catch (_) {}
    }
    if (item.requires_tray) parts.push(`Tray: ${item.tray_size || 'yes'}`);
    if (item.source_url) parts.push('Has source URL');
    mountEl.textContent = parts.length ? parts.join(' · ') : '';
  }
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

  // Populate profile dropdowns
  if (presets.profiles) {
    ['slicerProfile', 'slicerPlateProfile'].forEach(id => {
      const sel = document.getElementById(id);
      if (!sel) return;
      sel.innerHTML = presets.profiles.map(p =>
        `<option value="${slicerEsc(p.key)}">${slicerEsc(p.label)}</option>`
      ).join('');
      sel.value = slicerState.settings.profile || 'custom';
    });
  }

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
  const isProfileActive = settings.profile && settings.profile !== 'custom';

  // Sync profile dropdowns
  ['slicerProfile', 'slicerPlateProfile'].forEach(id => {
    const sel = document.getElementById(id);
    if (sel) sel.value = settings.profile || 'custom';
  });

  // Lock/unlock individual setting rows based on profile
  const lockableSettings = ['quality', 'strength', 'speed', 'texture', 'surface', 'supports'];
  const rows = document.querySelectorAll('.slicer-btn-row');
  rows.forEach(row => {
    const setting = row.dataset.setting;
    if (!setting) return;
    if (setting && settings[setting]) {
      slicerHighlightButtons(row, settings[setting]);
    }
    if (lockableSettings.includes(setting)) {
      row.classList.toggle('profile-locked', isProfileActive);
    }
  });

  // Style the profile dropdown
  ['slicerProfile', 'slicerPlateProfile'].forEach(id => {
    const sel = document.getElementById(id);
    if (sel) sel.classList.toggle('profile-active', isProfileActive);
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
  const anycubic = printers.filter(p => (p.model || '').toLowerCase().includes('kobra'));
  const creality = printers.filter(p => !(p.model || '').toLowerCase().includes('kobra'));

  let html = '<option value="">Select a printer...</option>';
  if (anycubic.length) {
    html += '<optgroup label="Anycubic">';
    anycubic.forEach(p => { html += `<option value="${p.id}">${slicerEsc(p.name)} (${slicerEsc(p.model || '')})</option>`; });
    html += '</optgroup>';
  }
  if (creality.length) {
    html += '<optgroup label="Creality">';
    creality.forEach(p => { html += `<option value="${p.id}">${slicerEsc(p.name)} (${slicerEsc(p.model || '')})</option>`; });
    html += '</optgroup>';
  }
  select.innerHTML = html;
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
function slicerShowApprovalModal({ items, settings, printerName, printerModel, isPlate, andPrint }) {
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

          // Convert from STL Z-up to Three.js Y-up so preview matches PrusaSlicer output
          geometry.rotateX(-Math.PI / 2);

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
function slicerShowGcodePreview({ gcodeText, gcodeId, sliceResult, printerId, printerName }) {
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
    profile: slicerState.settings.profile || 'custom',
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

  // STEP 1: Pre-slice approval modal (with temperatures)
  const approved = await slicerShowApprovalModal({
    items: [item],
    settings: slicerState.settings,
    printerName: printerName,
    printerModel: printerModel,
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
  const requestedCopies = slicerState.settings.copies || 1;
  const actualCopies = sliceResult.actual_copies;
  const copiesNote = (actualCopies && actualCopies < requestedCopies)
    ? ` (${actualCopies} of ${requestedCopies} copies fit on the bed)`
    : '';
  showToast(`Slicing complete${cached}!${copiesNote}`, 'success', copiesNote ? 6000 : 3000);

  // STEP 4: Show G-code 3D preview
  const action = await slicerShowGcodePreview({
    gcodeText,
    gcodeId: sliceResult.gcode_id,
    sliceResult,
    printerId: printerId ? parseInt(printerId, 10) : null,
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
        const result = await printStation.slicer.printGcode(sliceResult.gcode_id, parseInt(printerId, 10));
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

  const printer = slicerState.printers.find(p => String(p.id) === String(printerId));
  const printerName = printer?.name || 'printer';

  const printSteps = ['Downloading G-code', 'Preparing file', 'Uploading to printer', 'Starting print'];
  slicerShowProgress('Sending to Printer...', printSteps, 0, 'Downloading G-code from server...');

  const offProgress = printStation.slicer.onPrintProgress(({ step, detail }) => {
    slicerUpdateProgress(step - 1, detail);
  });

  try {
    const result = await printStation.slicer.printGcode(gcodeId, parseInt(printerId, 10));
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
// PART GUIDE MODAL — Mounting instructions, dependencies, howtos
// ============================================================================

async function slicerShowPartGuide(itemId) {
  // Show loading modal immediately
  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;z-index:200;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;';
  modal.innerHTML = `
    <div style="background:var(--card,#1e293b);border-radius:12px;padding:32px;max-width:640px;width:95%;max-height:85vh;overflow-y:auto;position:relative;">
      <div style="text-align:center;padding:40px 0;color:var(--muted);">Loading guide...</div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

  try {
    const data = await printStation.slicer.getPartGuide(itemId);
    const item = data.item;
    const deps = data.dependencies || {};
    const howtos = data.howtos || [];

    // --- Header ---
    const typeLabel = item.mb_type ? item.mb_type.charAt(0).toUpperCase() + item.mb_type.slice(1) : 'Part';
    const muLabel = (item.mu_width && item.mu_height) ? `${item.mu_width}x${item.mu_height} MU` : '';

    // --- Mount Info ---
    let mountHtml = '';
    if (item.mount_type) {
      const mountLabels = {
        snap: 'Snap-fit (press into tile holes)',
        magnet: 'Magnetic (embedded magnets)',
        screw: 'Screw mount (heat-set inserts + bolts)',
        rail: 'Rail slide-in (T-slot rail system)',
        pegboard: 'Pegboard click (peg holes)'
      };
      mountHtml = `<div style="margin-bottom:16px;">
        <h4 style="margin:0 0 6px;font-size:0.9rem;color:var(--accent);">Mount Type</h4>
        <div style="font-size:0.9rem;">${mountLabels[item.mount_type] || item.mount_type}</div>
      </div>`;
    }

    // --- Embedded Hardware (magnets, screws, inserts from the part itself) ---
    let embeddedHtml = '';
    if (item.mount_hardware && item.mount_hardware.length > 0) {
      const lines = item.mount_hardware.map(h => {
        if (h.type === 'magnet') return `${h.qty || '?'}x ${h.size || 'magnets'}`;
        if (h.type === 'screw') return `${h.qty || '?'}x ${h.spec || 'screws'}`;
        if (h.type === 'insert') return `${h.spec || '?'} heat-set inserts`;
        return `${h.qty || ''}x ${h.type}`;
      });
      embeddedHtml = `<div style="margin-bottom:16px;">
        <h4 style="margin:0 0 6px;font-size:0.9rem;color:var(--accent);">Embedded Hardware</h4>
        <ul style="margin:0;padding-left:20px;font-size:0.85rem;">${lines.map(l => `<li>${slicerEsc(l)}</li>`).join('')}</ul>
      </div>`;
    }

    // --- Tray requirement ---
    let trayHtml = '';
    if (item.requires_tray) {
      trayHtml = `<div style="margin-bottom:16px;padding:10px 14px;background:#92400e20;border:1px solid #92400e;border-radius:8px;">
        <strong style="color:#fbbf24;">Requires Tray</strong>
        ${item.tray_size ? `<span style="margin-left:8px;font-size:0.85rem;">Size: ${slicerEsc(item.tray_size)}</span>` : ''}
        ${item.tray_notes ? `<div style="font-size:0.8rem;color:var(--muted);margin-top:4px;">${slicerEsc(item.tray_notes)}</div>` : ''}
      </div>`;
    }

    // --- Dependencies (from recipe engine) ---
    let depsHtml = '';
    const partIdLabels = {
      'flush-snap': 'Flush Snap',
      'moderate-snap': 'Moderate Snap',
      'heavy-hook-snap': 'Heavy Hook Snap',
      'drawer-shell': 'Drawer Shell',
      'rail-popin': 'Rail Pop-In',
      'drawer-stopper-pin': 'Drawer Stopper Pin',
      'bolt-locked-bracket': 'Bolt-Locked Bracket',
      'locking-bolt': 'Locking Bolt',
      'bracket-multipoint': 'Bracket Multipoint Adapter',
      'multipoint-connector': 'Multipoint Connector',
      'shelf-support-bracket': 'Shelf Support Bracket',
      'ds-snap-a': 'DS Snap Part A',
      'ds-snap-b': 'DS Snap Part B',
      'wall-mount': 'Wall Mount'
    };

    if (deps.methods && deps.methods.length > 1) {
      // Multiple mounting methods (e.g. trays)
      depsHtml = `<div style="margin-bottom:16px;">
        <h4 style="margin:0 0 8px;font-size:0.9rem;color:var(--accent);">Mounting Methods</h4>
        ${deps.methods.map(m => `
          <div style="margin-bottom:12px;padding:10px 14px;border:1px solid var(--border);border-radius:8px;">
            <div style="font-weight:600;font-size:0.9rem;margin-bottom:4px;">${slicerEsc(m.name)}</div>
            <div style="font-size:0.8rem;color:var(--muted);margin-bottom:6px;">${slicerEsc(m.description)}</div>
            <div style="font-size:0.85rem;">
              ${m.hardware.map(h => `<div style="padding:2px 0;">&bull; ${h.qty}x ${slicerEsc(partIdLabels[h.partId] || h.partId)}</div>`).join('')}
            </div>
          </div>
        `).join('')}
      </div>`;
    } else if (deps.requiresHardware && deps.requiresHardware.length > 0) {
      depsHtml = `<div style="margin-bottom:16px;">
        <h4 style="margin:0 0 6px;font-size:0.9rem;color:var(--accent);">Additional Parts Needed</h4>
        <ul style="margin:0;padding-left:20px;font-size:0.85rem;">
          ${deps.requiresHardware.map(h => `<li>${h.qty}x ${slicerEsc(partIdLabels[h.partId] || h.partId)}</li>`).join('')}
        </ul>
      </div>`;
    } else {
      depsHtml = `<div style="margin-bottom:16px;">
        <h4 style="margin:0 0 6px;font-size:0.9rem;color:var(--accent);">Additional Parts</h4>
        <div style="font-size:0.85rem;color:var(--muted);">No additional hardware required &mdash; this part is self-contained.</div>
      </div>`;
    }

    // --- Howtos ---
    let howtosHtml = '';
    if (howtos.length > 0) {
      howtosHtml = `<div>
        <h4 style="margin:0 0 8px;font-size:0.9rem;color:var(--accent);">Assembly Instructions</h4>
        ${howtos.map(h => {
          const content = h.content || '';
          // Convert markdown-ish content to simple HTML
          const htmlContent = content
            .replace(/^### (.+)$/gm, '<strong>$1</strong>')
            .replace(/^## (.+)$/gm, '<strong style="font-size:1rem;">$1</strong>')
            .replace(/^\d+\.\s+\*\*(.+?)\*\*\s*[–—-]\s*(.+)$/gm, '<div style="margin:4px 0;"><strong>$1</strong> &mdash; $2</div>')
            .replace(/^\d+\.\s+(.+)$/gm, '<div style="margin:4px 0;">&bull; $1</div>')
            .replace(/^[-*]\s+(.+)$/gm, '<div style="margin:2px 0 2px 12px;">&ndash; $1</div>')
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/\n{2,}/g, '<br><br>')
            .replace(/\n/g, '<br>');

          // Get images if present
          const images = h.images || [];
          const imgHtml = images.length > 0
            ? `<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;">${images.map(img =>
                `<img src="${slicerEsc(img.source_url || img.local_path)}" alt="${slicerEsc(img.alt || img.caption || '')}"
                  style="max-width:200px;max-height:150px;border-radius:6px;object-fit:cover;border:1px solid var(--border);">`
              ).join('')}</div>`
            : '';

          // Get videos if present
          const videos = h.videos || [];
          const vidHtml = videos.length > 0
            ? `<div style="margin-top:8px;">${videos.map(v =>
                `<a href="${slicerEsc(v.url)}" target="_blank" style="display:inline-flex;align-items:center;gap:6px;padding:6px 12px;background:var(--bg-secondary,#1e293b);border:1px solid var(--border);border-radius:6px;font-size:0.8rem;color:#818cf8;text-decoration:none;">
                  &#9654; ${slicerEsc(v.title || 'Watch Video')}</a>`
              ).join(' ')}</div>`
            : '';

          return `<details style="margin-bottom:8px;border:1px solid var(--border);border-radius:8px;overflow:hidden;" open>
            <summary style="padding:10px 14px;cursor:pointer;font-weight:600;font-size:0.9rem;background:var(--bg-secondary,#1e293b);">${slicerEsc(h.title)}</summary>
            <div style="padding:12px 14px;font-size:0.83rem;line-height:1.6;">${htmlContent}${imgHtml}${vidHtml}</div>
          </details>`;
        }).join('')}
      </div>`;
    }

    // --- Source URL ---
    const sourceHtml = item.source_url
      ? `<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border);">
          <a href="${slicerEsc(item.source_url)}" target="_blank" style="font-size:0.8rem;color:#818cf8;">View original source</a>
        </div>`
      : '';

    // Render the full modal content
    modal.querySelector('div').innerHTML = `
      <button style="position:absolute;top:12px;right:12px;background:none;border:none;color:var(--muted);cursor:pointer;font-size:1.3rem;padding:4px 8px;"
        onclick="this.closest('div[style*=fixed]').remove()">&times;</button>
      <div style="margin-bottom:16px;">
        <h3 style="margin:0 0 4px;font-size:1.1rem;">${slicerEsc(item.name)}</h3>
        <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
          <span class="badge" style="font-size:0.75rem;padding:2px 10px;background:var(--accent);border-radius:4px;">${typeLabel}</span>
          ${muLabel ? `<span class="badge" style="font-size:0.75rem;padding:2px 10px;background:#4f46e5;border-radius:4px;">${muLabel}</span>` : ''}
          ${item.folder ? `<span class="badge" style="font-size:0.75rem;padding:2px 10px;background:var(--bg-secondary,#334155);border-radius:4px;">${slicerEsc(item.folder)}</span>` : ''}
        </div>
      </div>
      ${mountHtml}
      ${embeddedHtml}
      ${trayHtml}
      ${depsHtml}
      ${howtosHtml}
      ${sourceHtml}
    `;
  } catch (err) {
    console.error('[Slicer] Part guide error:', err);
    modal.querySelector('div').innerHTML = `
      <button style="position:absolute;top:12px;right:12px;background:none;border:none;color:var(--muted);cursor:pointer;font-size:1.3rem;padding:4px 8px;"
        onclick="this.closest('div[style*=fixed]').remove()">&times;</button>
      <div style="text-align:center;padding:40px 0;">
        <div style="font-size:1rem;margin-bottom:8px;">Failed to load guide</div>
        <div class="muted" style="font-size:0.85rem;">${slicerEsc(err.message)}</div>
      </div>`;
  }
}

// ============================================================================
// PLATE MODE — MULTI-STL BUILD PLATE
// ============================================================================

async function slicerTogglePlateMode() {
  slicerState.plateMode = !slicerState.plateMode;
  const btn = document.getElementById('slicerPlateToggle');
  if (btn) btn.classList.toggle('active', slicerState.plateMode);

  if (!slicerState.plateMode) {
    // Exiting plate mode — clear plate items and instance transforms
    slicerState.plateItems = [];
    slicerState.plateInstanceTransforms = null;
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
    // Add to plate with qty=1
    const item = slicerState.catalog.find(i => i.id === id);
    if (item) {
      slicerState.plateItems.push({ ...item, qty: 1 });
      // Pre-populate plateTransforms from default_transform if not already set
      if (!slicerState.plateTransforms[item.id] && item.default_transform) {
        try {
          const dt = JSON.parse(item.default_transform);
          slicerState.plateTransforms[item.id] = {
            rx: dt.rx || 0, ry: dt.ry || 0, rz: dt.rz || 0,
            scale: dt.scale || 1, posX: 0, posZ: 0
          };
        } catch {}
      }
    }
  }

  slicerUpdatePlateBar();
  slicerUpdatePlateCheckmarks();
}

function slicerSetPlateItemQty(id, qty) {
  const item = slicerState.plateItems.find(i => i.id === id);
  if (item) {
    item.qty = Math.max(1, Math.min(99, qty));
    slicerUpdatePlateBar();
  }
}

function slicerUpdatePlateBar() {
  const bar = document.getElementById('slicerPlateBar');
  if (!bar) return;

  if (!slicerState.plateMode || slicerState.plateItems.length === 0) {
    bar.style.display = 'none';
    slicerUpdatePlateBanner();
    return;
  }

  bar.style.display = '';
  const n = slicerState.plateItems.length;
  const totalParts = slicerState.plateItems.reduce((s, i) => s + (i.qty || 1), 0);

  // Build chip list with qty controls + remove button
  const chipsHtml = slicerState.plateItems.map(item => {
    const qty = item.qty || 1;
    const folderLabel = item.folder ? ` <span style="color:var(--muted);font-size:0.7rem;">${slicerEsc(item.folder)}</span>` : '';
    return `<span class="slicer-plate-chip" data-plate-id="${item.id}"
      style="display:inline-flex;align-items:center;gap:4px;padding:3px 10px;background:var(--bg-secondary,#1e293b);border:1px solid var(--border);border-radius:12px;font-size:0.8rem;white-space:nowrap;">
      ${slicerEsc(item.name)}${folderLabel}
      <span style="display:inline-flex;align-items:center;gap:2px;margin-left:4px;background:rgba(255,255,255,0.08);border-radius:8px;padding:1px 4px;">
        <button class="plate-qty-btn" data-qty-id="${item.id}" data-delta="-1" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:0.85rem;padding:0 2px;line-height:1;">-</button>
        <span style="min-width:16px;text-align:center;font-weight:600;font-size:0.8rem;color:var(--text);">${qty}</span>
        <button class="plate-qty-btn" data-qty-id="${item.id}" data-delta="1" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:0.85rem;padding:0 2px;line-height:1;">+</button>
      </span>
      <span class="slicer-plate-chip-remove" data-remove-id="${item.id}" style="cursor:pointer;color:var(--danger);font-weight:700;margin-left:2px;line-height:1;">&times;</span>
    </span>`;
  }).join('');

  bar.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;">
      <div style="flex:1;min-width:0;">
        <span style="font-weight:700;font-size:1rem;color:var(--accent);">${totalParts} part${totalParts !== 1 ? 's' : ''} (${n} unique) on plate</span>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;max-height:80px;overflow-y:auto;">
          ${chipsHtml}
        </div>
      </div>
      <button id="slicerPlateClearBtn" class="secondary" style="padding:6px 14px;font-size:0.85rem;">Clear</button>
      <button id="slicerBulkCategoryBtn" class="secondary" style="padding:8px 14px;font-size:0.9rem;font-weight:600;">Set Category</button>
      <button id="slicerPlateSaveBtn" class="secondary" style="padding:8px 14px;font-size:0.9rem;font-weight:600;">Save Plate</button>
      <button id="slicerPlateGoBtn" class="primary" style="padding:8px 18px;font-size:0.95rem;font-weight:600;">Slice Plate &rarr;</button>
    </div>`;

  // Wire qty buttons
  bar.querySelectorAll('.plate-qty-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.qtyId, 10);
      const delta = parseInt(btn.dataset.delta, 10);
      const item = slicerState.plateItems.find(i => i.id === id);
      if (item) slicerSetPlateItemQty(id, (item.qty || 1) + delta);
    });
  });

  // Wire remove chip buttons
  bar.querySelectorAll('.slicer-plate-chip-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const removeId = parseInt(btn.dataset.removeId, 10);
      slicerState.plateItems = slicerState.plateItems.filter(i => i.id !== removeId);
      slicerUpdatePlateBar();
      slicerUpdatePlateCheckmarks();
    });
  });

  // Re-wire the action buttons since we replaced innerHTML
  document.getElementById('slicerPlateClearBtn')?.addEventListener('click', () => {
    slicerState.plateItems = [];
    slicerUpdatePlateBar();
    slicerUpdatePlateCheckmarks();
  });
  document.getElementById('slicerBulkCategoryBtn')?.addEventListener('click', slicerShowBulkCategoryPicker);
  document.getElementById('slicerPlateSaveBtn')?.addEventListener('click', () => slicerSavePlate(slicerState._editingPlateId));
  document.getElementById('slicerPlateGoBtn')?.addEventListener('click', slicerShowBuildPlatePreview);

  slicerUpdatePlateBanner();
}

function slicerUpdatePlateBanner() {
  let banner = document.getElementById('slicerPlateBanner');
  const currentFolder = slicerState.selectedFolder;
  const plateItems = slicerState.plateItems || [];

  // Count items from other folders
  const otherCount = plateItems.filter(i => i.folder !== currentFolder).length;

  if (!slicerState.plateMode || otherCount === 0) {
    if (banner) banner.remove();
    return;
  }

  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'slicerPlateBanner';
    banner.style.cssText = 'margin:0 16px 8px;padding:8px 14px;background:#4f46e520;border:1px solid #4f46e5;border-radius:8px;font-size:0.85rem;color:#a5b4fc;cursor:pointer;';
    const folderBar = document.getElementById('slicerFolderBar');
    if (folderBar) folderBar.parentNode.insertBefore(banner, folderBar.nextSibling);
    else return;
  }
  banner.textContent = `${otherCount} item${otherCount !== 1 ? 's' : ''} on plate from other folders`;
  banner.onclick = () => {
    const plateBar = document.getElementById('slicerPlateBar');
    if (plateBar) plateBar.scrollIntoView({ behavior: 'smooth', block: 'end' });
  };
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
  const totalParts = items.reduce((s, i) => s + (i.qty || 1), 0);
  const statusText = document.getElementById('bpStatusText');
  if (statusText) statusText.textContent = `Loading ${totalParts} parts (${items.length} unique)...`;

  // Fetch unique STL buffers in parallel (deduplicate by id)
  const uniqueIds = [...new Set(items.map(i => i.id))];
  const failedNames = [];
  const bufferMap = {};
  const bufResults = await Promise.all(
    uniqueIds.map(id => slicerFetchStlBuffer(id).catch(err => {
      const item = items.find(i => i.id === id);
      console.error('[BuildPlate] Failed to load STL for', item?.name, '(id:', id, ')', err.message);
      failedNames.push(item?.name || `ID ${id}`);
      return null;
    }))
  );
  uniqueIds.forEach((id, idx) => { bufferMap[id] = bufResults[idx]; });

  if (failedNames.length > 0 && failedNames.length === uniqueIds.length) {
    if (statusText) statusText.textContent = `Failed to load all ${uniqueIds.length} models — check server connection`;
    return;
  } else if (failedNames.length > 0) {
    console.warn(`[BuildPlate] ${failedNames.length} model(s) failed to load:`, failedNames.join(', '));
  }

  const loader = new THREE.STLLoader();
  const modelInfos = [];
  // Cache parsed+transformed base geometry per stl_id for cloning copies
  const baseGeometryCache = {};

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const buf = bufferMap[item.id];
    if (!buf) continue;

    const qty = item.qty || 1;

    // Auto-populate plateTransforms from item.default_transform if not already set
    if (!slicerState.plateTransforms[item.id] && item.default_transform) {
      try {
        const dt = JSON.parse(item.default_transform);
        slicerState.plateTransforms[item.id] = {
          rx: dt.rx || 0, ry: dt.ry || 0, rz: dt.rz || 0,
          scale: dt.scale || 1, posX: 0, posZ: 0
        };
      } catch {}
    }

    // Parse and transform base geometry once per unique stl_id
    if (!baseGeometryCache[item.id]) {
      const geometry = loader.parse(buf);
      geometry.computeVertexNormals();

      // Convert from STL Z-up to Three.js Y-up so preview matches PrusaSlicer output
      geometry.rotateX(-Math.PI / 2);

      // Apply any previously saved transforms
      const savedT = slicerState.plateTransforms[item.id];
      if (savedT) {
        if (savedT.rx) geometry.rotateX(savedT.rx);
        if (savedT.ry) geometry.rotateY(savedT.ry);
        if (savedT.rz) geometry.rotateZ(savedT.rz);
        if (savedT.scale && savedT.scale !== 1) geometry.scale(savedT.scale, savedT.scale, savedT.scale);
      }

      // Auto-detect meter-unit STLs
      geometry.computeBoundingBox();
      const rawBox = geometry.boundingBox;
      const rawMaxDim = Math.max(rawBox.max.x - rawBox.min.x, rawBox.max.y - rawBox.min.y, rawBox.max.z - rawBox.min.z);
      if (rawMaxDim > 0 && rawMaxDim < 1.0 && (!savedT || !savedT.scale || savedT.scale === 1)) {
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

      baseGeometryCache[item.id] = geometry;
    }

    // Create qty meshes (first uses base geometry, rest clone it)
    for (let c = 0; c < qty; c++) {
      const geom = c === 0 ? baseGeometryCache[item.id] : baseGeometryCache[item.id].clone();
      const mat = new THREE.MeshPhongMaterial({ color: 0x38bdf8, specular: 0x222222, shininess: 40 });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.userData.stlId = item.id;
      mesh.userData.itemIndex = i;
      mesh.userData.copyIndex = c;

      const bbox = new THREE.Box3().setFromObject(mesh);
      const size = bbox.getSize(new THREE.Vector3());

      modelInfos.push({ stlId: item.id, item, mesh, geometry: geom, material: mat, bbox, size, copyIndex: c });
    }
  }

  // Always auto-arrange when we have copies (positions are per-mesh, not per-item)
  bpAutoArrange(modelInfos, bedDims);

  // Add to scene
  for (const info of modelInfos) {
    pp.scene.add(info.mesh);
    pp.meshes.push({
      stlId: info.stlId,
      item: info.item,
      mesh: info.mesh,
      geometry: info.geometry,
      material: info.material,
      copyIndex: info.copyIndex
    });
  }

  bpRenderModelList();
  bpCheckFit(bedDims);

  if (statusText) statusText.textContent = `${modelInfos.length} part${modelInfos.length !== 1 ? 's' : ''} loaded (${items.length} unique)`;
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
    const copyLabel = entry.copyIndex > 0 ? ` (copy ${entry.copyIndex + 1})` : '';
    return `
      <div class="bp-model-item${selected ? ' bp-model-selected' : ''}" data-bp-idx="${idx}"
        style="padding:10px 12px;border-radius:8px;cursor:pointer;margin-bottom:4px;
        border:1px solid ${selected ? 'var(--accent)' : 'rgba(255,255,255,0.1)'};
        background:${selected ? 'rgba(56,189,248,0.15)' : 'transparent'};">
        <div style="font-weight:600;font-size:0.85rem;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
          ${slicerEsc(item.name)}${copyLabel}
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

    // Convert from STL Z-up to Three.js Y-up so preview matches PrusaSlicer output
    geometry.rotateX(-Math.PI / 2);

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
      // Save per-instance positions before closing — each mesh gets its own transform
      // This preserves the user's arrangement for qty>1 items (multiple copies at different positions)
      if (!isSingle && pp.meshes && pp.meshes.length > 0) {
        slicerState.plateInstanceTransforms = pp.meshes.map(entry => {
          const baseT = slicerState.plateTransforms[entry.stlId] || {};
          return {
            stlId: entry.stlId,
            rx: baseT.rx || 0,
            ry: baseT.ry || 0,
            rz: baseT.rz || 0,
            scale: baseT.scale || 1,
            posX: entry.mesh.position.x,
            posZ: entry.mesh.position.z
          };
        });
      }
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
  // Guard: when called as an event handler, itemsOverride is a MouseEvent — ignore it
  const validOverride = Array.isArray(itemsOverride) ? itemsOverride : null;
  const items = validOverride || slicerState.plateItems;
  if (!items || items.length === 0) return alert('No models to preview');
  const isSingleItem = !!validOverride;

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
    listEl.innerHTML = slicerState.plateItems.map(item => {
      const qty = item.qty || 1;
      return `
      <div class="slicer-plate-item-row" data-plate-item-id="${item.id}" style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border);">
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;font-size:0.95rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${slicerEsc(item.name)}</div>
          <div class="muted" style="font-size:0.8rem;">
            ${item.category ? slicerEsc(item.category) + ' · ' : ''}${item.dim_x ? `${item.dim_x.toFixed(1)} x ${item.dim_y.toFixed(1)} x ${item.dim_z.toFixed(1)} mm` : ''}
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:4px;">
          <button class="plate-settings-qty-btn secondary" data-qty-id="${item.id}" data-delta="-1" style="padding:2px 8px;font-size:0.9rem;">-</button>
          <span style="min-width:24px;text-align:center;font-weight:700;font-size:0.95rem;">${qty}</span>
          <button class="plate-settings-qty-btn secondary" data-qty-id="${item.id}" data-delta="1" style="padding:2px 8px;font-size:0.9rem;">+</button>
        </div>
        <button class="plate-item-remove" data-plate-remove-id="${item.id}" title="Remove from plate">&times;</button>
      </div>`;
    }).join('');

    // Wire qty buttons
    listEl.querySelectorAll('.plate-settings-qty-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = parseInt(btn.dataset.qtyId, 10);
        const delta = parseInt(btn.dataset.delta, 10);
        const item = slicerState.plateItems.find(i => i.id === id);
        if (item) {
          slicerSetPlateItemQty(id, (item.qty || 1) + delta);
          slicerShowPlateSettings(); // Re-render
        }
      });
    });

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
  const anycubic = printers.filter(p => (p.model || '').toLowerCase().includes('kobra'));
  const creality = printers.filter(p => !(p.model || '').toLowerCase().includes('kobra'));

  let html = '<option value="">Select a printer...</option>';
  if (anycubic.length) {
    html += '<optgroup label="Anycubic">';
    anycubic.forEach(p => { html += `<option value="${p.id}">${slicerEsc(p.name)} (${slicerEsc(p.model || '')})</option>`; });
    html += '</optgroup>';
  }
  if (creality.length) {
    html += '<optgroup label="Creality">';
    creality.forEach(p => { html += `<option value="${p.id}">${slicerEsc(p.name)} (${slicerEsc(p.model || '')})</option>`; });
    html += '</optgroup>';
  }
  select.innerHTML = html;
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

  // Expand items by quantity and collect per-instance transforms
  // Each copy gets its own position from the build plate preview arrangement
  const expandedIds = [];
  const instanceTransforms = [];
  const pit = slicerState.plateInstanceTransforms; // per-instance positions from preview
  let pitIdx = 0;

  for (const item of slicerState.plateItems) {
    const qty = item.qty || 1;
    const baseT = slicerState.plateTransforms[item.id] || {};
    for (let c = 0; c < qty; c++) {
      expandedIds.push(item.id);
      // Use per-instance transform from preview if available, otherwise fall back to per-stlId
      if (pit && pitIdx < pit.length && pit[pitIdx].stlId === item.id) {
        instanceTransforms.push(pit[pitIdx]);
        pitIdx++;
      } else {
        instanceTransforms.push({
          stlId: item.id,
          rx: baseT.rx || 0, ry: baseT.ry || 0, rz: baseT.rz || 0,
          scale: baseT.scale || 1,
          posX: baseT.posX || 0, posZ: baseT.posZ || 0
        });
      }
    }
  }

  const sliceOptions = {
    stl_ids: expandedIds,
    instance_transforms: instanceTransforms,
    profile: slicerState.settings.profile || 'custom',
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

  const modelCount = slicerState.plateItems.length;

  // STEP 1: Pre-slice approval modal (with temperatures)
  const approved = await slicerShowApprovalModal({
    items: slicerState.plateItems,
    settings: slicerState.settings,
    printerName,
    printerModel,
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
  const estInfo = sliceResult.est_time_min ? ` — ${slicerFormatTime(sliceResult.est_time_min)}, ${sliceResult.est_weight_g ? sliceResult.est_weight_g.toFixed(1) + 'g filament' : ''}` : '';
  showToast(`Plate slicing complete${cached}!${estInfo}`, 'success', 5000);

  // STEP 4: Show G-code 3D preview
  const action = await slicerShowGcodePreview({
    gcodeText,
    gcodeId: sliceResult.gcode_id,
    sliceResult,
    printerId: printerId ? parseInt(printerId, 10) : null,
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
        const result = await printStation.slicer.printGcode(sliceResult.gcode_id, parseInt(printerId, 10));
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
// SAVE PLATE + SAVED PLATES + SLICE HISTORY
// ============================================================================

async function slicerSavePlate(editingPlateId) {
  if (!slicerState.plateItems.length) return alert('No models on the plate');

  const defaultName = slicerState._editingPlateName || '';
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;';

  const printers = slicerState.printers || [];
  const currentModel = slicerState.settings.printer_model || 'kobra3';

  // Group printers by manufacturer
  const anycubic = printers.filter(p => (p.model || '').toLowerCase().includes('kobra'));
  const creality = printers.filter(p => !(p.model || '').toLowerCase().includes('kobra'));

  const printerOptions = (() => {
    let html = '<option value="">Auto-detect from settings</option>';
    if (anycubic.length) {
      html += '<optgroup label="Anycubic">';
      anycubic.forEach(p => {
        const m = slicerMapPrinterModel(p.model);
        html += `<option value="${slicerEsc(m)}">${slicerEsc(p.name)} (${slicerEsc(p.model)})</option>`;
      });
      html += '</optgroup>';
    }
    if (creality.length) {
      html += '<optgroup label="Creality">';
      creality.forEach(p => {
        const m = slicerMapPrinterModel(p.model);
        html += `<option value="${slicerEsc(m)}">${slicerEsc(p.name)} (${slicerEsc(p.model)})</option>`;
      });
      html += '</optgroup>';
    }
    if (!printers.length) {
      html += '<option value="kobra3">Anycubic Kobra 3</option>';
      html += '<option value="ender3_s1pro">Creality Ender 3 S1 Pro</option>';
    }
    return html;
  })();

  const totalParts = slicerState.plateItems.reduce((s, i) => s + (i.qty || 1), 0);
  const modal = document.createElement('div');
  modal.style.cssText = 'background:var(--card,#1e293b);border-radius:12px;padding:24px;max-width:480px;width:90%;';
  modal.innerHTML = `
    <h3 style="margin:0 0 16px;">${editingPlateId ? 'Update' : 'Save'} Build Plate</h3>
    <div style="margin-bottom:12px;">
      <label style="font-size:0.85rem;color:var(--muted);margin-bottom:4px;display:block;">Plate Name</label>
      <input id="savePlateNameInput" type="text" value="${slicerEsc(defaultName)}" placeholder="e.g. Snap Connectors Batch"
        style="width:100%;padding:8px 12px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);font-size:0.95rem;box-sizing:border-box;">
    </div>
    <div style="margin-bottom:16px;">
      <label style="font-size:0.85rem;color:var(--muted);margin-bottom:4px;display:block;">Printer Model</label>
      <select id="savePlatePrinterSelect" style="width:100%;padding:8px 12px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);font-size:0.95rem;">
        ${printerOptions}
      </select>
    </div>
    <div style="margin-bottom:16px;padding:10px;background:rgba(255,255,255,0.04);border-radius:8px;font-size:0.85rem;">
      <strong>${totalParts} part${totalParts !== 1 ? 's' : ''}</strong> (${slicerState.plateItems.length} unique) &mdash;
      ${slicerState.plateItems.map(i => `${i.qty || 1}x ${slicerEsc(i.name)}`).join(', ')}
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;">
      <button id="savePlateCancelBtn" class="secondary" style="padding:8px 16px;">Cancel</button>
      <button id="savePlateConfirmBtn" class="primary" style="padding:8px 20px;font-weight:600;">${editingPlateId ? 'Update' : 'Save'}</button>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const nameInput = document.getElementById('savePlateNameInput');
  const printerSelect = document.getElementById('savePlatePrinterSelect');
  nameInput.focus();
  nameInput.select();

  // Set current printer model in dropdown
  if (currentModel) printerSelect.value = currentModel;

  return new Promise(resolve => {
    const close = () => { overlay.remove(); resolve(); };

    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    document.getElementById('savePlateCancelBtn').addEventListener('click', close);

    document.getElementById('savePlateConfirmBtn').addEventListener('click', async () => {
      const name = nameInput.value.trim();
      if (!name) { nameInput.style.borderColor = '#ef4444'; return; }

      const printerModel = printerSelect.value || currentModel || 'kobra3';
      const items = slicerState.plateItems.map(item => ({
        stl_id: item.id,
        qty: item.qty || 1,
        transform: slicerState.plateTransforms[item.id] || null
      }));
      const settings = { ...slicerState.settings };

      try {
        if (editingPlateId) {
          await printStation.slicer.updatePlate(editingPlateId, { name, printer_model: printerModel, items, settings });
          showToast(`Plate "${name}" updated!`, 'success', 3000);
        } else {
          await printStation.slicer.createPlate({ name, printer_model: printerModel, items, settings });
          showToast(`Plate "${name}" saved!`, 'success', 3000);
        }
        slicerState._editingPlateName = '';
        slicerState._editingPlateId = null;
        overlay.remove();
        resolve();
      } catch (err) {
        console.error('[Slicer] Save plate error:', err);
        showToast('Failed to save plate: ' + (err.message || 'unknown'), 'error', 5000);
      }
    });

    nameInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') document.getElementById('savePlateConfirmBtn').click();
      if (e.key === 'Escape') close();
    });
  });
}

// --- Sub-tab navigation ---

function slicerShowSubTab(tabName) {
  // Hide all tab panels
  ['slicerCatalogWrapper', 'slicerSavedPlatesPanel', 'slicerSliceHistoryPanel'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  // Also hide settings panels when switching tabs
  if (tabName !== 'catalog') {
    const sp = document.getElementById('slicerSettingsPanel');
    if (sp) sp.style.display = 'none';
    const psp = document.getElementById('slicerPlateSettingsPanel');
    if (psp) psp.style.display = 'none';
  }

  // Show the target panel
  const panelMap = {
    catalog: 'slicerCatalogWrapper',
    savedPlates: 'slicerSavedPlatesPanel',
    sliceHistory: 'slicerSliceHistoryPanel'
  };
  const targetEl = document.getElementById(panelMap[tabName]);
  if (targetEl) targetEl.style.display = '';

  // When switching to catalog, ensure catalog panel is visible
  if (tabName === 'catalog') {
    const cp = document.getElementById('slicerCatalogPanel');
    if (cp) cp.style.display = '';
  }

  // Update tab button active states
  document.querySelectorAll('.slicer-sub-tab').forEach(btn => {
    const isActive = btn.dataset.tab === tabName;
    btn.classList.toggle('active', isActive);
    btn.style.color = isActive ? 'var(--text)' : 'var(--muted)';
    btn.style.borderBottomColor = isActive ? 'var(--accent,#6366f1)' : 'transparent';
  });

  // Load data for the tab
  if (tabName === 'savedPlates') slicerLoadSavedPlates();
  if (tabName === 'sliceHistory') slicerLoadSliceHistory();
}

// --- Saved Plates ---

async function slicerLoadSavedPlates() {
  const panel = document.getElementById('slicerSavedPlatesPanel');
  if (!panel) return;

  panel.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted);">Loading saved plates...</div>';

  try {
    const result = await printStation.slicer.listPlates();
    const plates = result.plates || result || [];

    if (!plates.length) {
      panel.innerHTML = `
        <div style="text-align:center;padding:60px 20px;">
          <div style="font-size:1.1rem;color:var(--muted);margin-bottom:8px;">No saved build plates yet</div>
          <div style="font-size:0.85rem;color:var(--muted);">Select items in the Catalog tab and click "Save Plate" to create one.</div>
        </div>`;
      return;
    }

    panel.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:16px;">
        ${plates.map(plate => {
          const items = typeof plate.items === 'string' ? JSON.parse(plate.items) : (plate.items || []);
          const totalParts = items.reduce((s, i) => s + (i.qty || 1), 0);
          const summary = (plate._itemSummary || []).map(s => `${s.qty}x ${slicerEsc(s.name)}`).join(', ') || `${totalParts} parts`;
          const hasGcode = plate.est_time_min || plate.last_gcode_id;
          const printerLabel = slicerPrinterModelLabel(plate.printer_model);
          const updated = plate.updated_at ? new Date(plate.updated_at).toLocaleDateString() : '';

          return `
          <div class="inventory-card saved-plate-card" data-plate-id="${plate.id}" style="padding:16px;">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
              <div>
                <h3 style="margin:0 0 4px;font-size:1rem;">${slicerEsc(plate.name)}</h3>
                <div class="muted" style="font-size:0.8rem;">${printerLabel} &middot; ${totalParts} part${totalParts !== 1 ? 's' : ''} &middot; Updated ${updated}</div>
              </div>
              ${hasGcode ? `<span style="background:#22c55e20;color:#4ade80;padding:2px 8px;border-radius:6px;font-size:0.75rem;font-weight:600;">Sliced</span>` : ''}
            </div>
            <div style="font-size:0.85rem;color:var(--muted);margin-bottom:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${summary}</div>
            ${hasGcode ? `
              <div style="display:flex;gap:12px;margin-bottom:10px;padding:8px 10px;background:rgba(255,255,255,0.04);border-radius:6px;font-size:0.85rem;">
                <span>Time: <strong>${slicerFormatTime(plate.est_time_min)}</strong></span>
                <span>Filament: <strong>${plate.est_weight_g ? plate.est_weight_g.toFixed(1) + 'g' : '?'}</strong></span>
              </div>
            ` : ''}
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
              <button class="saved-plate-action primary" data-action="slice" data-plate-id="${plate.id}" style="padding:6px 14px;font-size:0.85rem;">Slice</button>
              <button class="saved-plate-action secondary" data-action="preview" data-plate-id="${plate.id}" style="padding:6px 14px;font-size:0.85rem;">Preview</button>
              <button class="saved-plate-action secondary" data-action="edit" data-plate-id="${plate.id}" style="padding:6px 14px;font-size:0.85rem;">Edit</button>
              <button class="saved-plate-action secondary" data-action="delete" data-plate-id="${plate.id}" style="padding:6px 10px;font-size:0.85rem;color:var(--danger);">Delete</button>
            </div>
          </div>`;
        }).join('')}
      </div>`;

    // Wire action buttons
    panel.querySelectorAll('.saved-plate-action').forEach(btn => {
      btn.addEventListener('click', () => {
        const plateId = parseInt(btn.dataset.plateId, 10);
        const action = btn.dataset.action;
        const plate = plates.find(p => p.id === plateId);
        if (!plate) return;

        if (action === 'slice') slicerSliceSavedPlate(plate);
        else if (action === 'preview') slicerPreviewSavedPlate(plate);
        else if (action === 'edit') slicerEditSavedPlate(plate);
        else if (action === 'delete') slicerDeleteSavedPlate(plate);
      });
    });
  } catch (err) {
    console.error('[Slicer] Load saved plates error:', err);
    panel.innerHTML = `<div style="text-align:center;padding:40px;color:var(--danger);">Failed to load saved plates: ${slicerEsc(err.message)}</div>`;
  }
}

function slicerPrinterModelLabel(model) {
  if (!model) return 'Unknown';
  const m = model.toLowerCase();
  if (m.includes('kobra') && m.includes('v2')) return 'Kobra 3 V2';
  if (m.includes('kobra')) return 'Kobra 3';
  if (m.includes('s1') && m.includes('pro')) return 'Ender 3 S1 Pro';
  if (m.includes('ke') || m.includes('v3')) return 'Ender 3 V3 KE';
  if (m.includes('ender')) return 'Ender 3';
  return model;
}

async function slicerSliceSavedPlate(plate) {
  // Show a printer picker popup then slice
  const items = typeof plate.items === 'string' ? JSON.parse(plate.items) : (plate.items || []);
  const settings = typeof plate.settings === 'string' ? JSON.parse(plate.settings) : (plate.settings || {});
  if (!items.length) return alert('This plate has no items');

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;';

  const printers = slicerState.printers || [];
  const anycubic = printers.filter(p => (p.model || '').toLowerCase().includes('kobra'));
  const creality = printers.filter(p => !(p.model || '').toLowerCase().includes('kobra'));

  let printerOptionsHtml = '<option value="">Select a printer...</option>';
  if (anycubic.length) {
    printerOptionsHtml += '<optgroup label="Anycubic">';
    anycubic.forEach(p => { printerOptionsHtml += `<option value="${p.id}" data-model="${slicerEsc(p.model)}">${slicerEsc(p.name)} (${slicerEsc(p.model)})</option>`; });
    printerOptionsHtml += '</optgroup>';
  }
  if (creality.length) {
    printerOptionsHtml += '<optgroup label="Creality">';
    creality.forEach(p => { printerOptionsHtml += `<option value="${p.id}" data-model="${slicerEsc(p.model)}">${slicerEsc(p.name)} (${slicerEsc(p.model)})</option>`; });
    printerOptionsHtml += '</optgroup>';
  }

  const totalParts = items.reduce((s, i) => s + (i.qty || 1), 0);
  const modal = document.createElement('div');
  modal.style.cssText = 'background:var(--card,#1e293b);border-radius:12px;padding:24px;max-width:440px;width:90%;';
  modal.innerHTML = `
    <h3 style="margin:0 0 12px;">Slice "${slicerEsc(plate.name)}"</h3>
    <div class="muted" style="margin-bottom:16px;font-size:0.85rem;">${totalParts} part${totalParts !== 1 ? 's' : ''}</div>
    <div style="margin-bottom:16px;">
      <label style="font-size:0.85rem;color:var(--muted);margin-bottom:4px;display:block;">Send to Printer</label>
      <select id="savedPlateSlicePrinter" style="width:100%;padding:8px 12px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);font-size:0.95rem;">
        ${printerOptionsHtml}
      </select>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;">
      <button id="savedPlateSliceCancelBtn" class="secondary" style="padding:8px 16px;">Cancel</button>
      <button id="savedPlateSliceGoBtn" class="primary" style="padding:8px 20px;font-weight:600;">Slice</button>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.getElementById('savedPlateSliceCancelBtn').addEventListener('click', () => overlay.remove());

  document.getElementById('savedPlateSliceGoBtn').addEventListener('click', async () => {
    const select = document.getElementById('savedPlateSlicePrinter');
    const printerId = select.value || null;
    let printerModel = plate.printer_model || 'kobra3';
    let printerName = '';

    if (printerId) {
      const printer = printers.find(p => String(p.id) === String(printerId));
      if (printer) {
        printerName = printer.name || '';
        if (printer.model) printerModel = slicerMapPrinterModel(printer.model);
      }
    }

    overlay.remove();

    // Expand items by quantity with per-instance transforms
    const expandedIds = [];
    const instanceTransforms = [];
    for (const item of items) {
      const qty = item.qty || 1;
      const t = item.transform || {};
      for (let c = 0; c < qty; c++) {
        expandedIds.push(item.stl_id);
        instanceTransforms.push({
          stlId: item.stl_id,
          rx: t.rx || 0, ry: t.ry || 0, rz: t.rz || 0,
          scale: t.scale || 1,
          posX: t.posX || 0, posZ: t.posZ || 0
        });
      }
    }

    const sliceOptions = {
      stl_ids: expandedIds,
      instance_transforms: instanceTransforms,
      profile: settings.profile || 'custom',
      printer_model: printerModel,
      material: settings.material,
      quality: settings.quality,
      strength: settings.strength,
      speed: settings.speed,
      texture: settings.texture,
      surface: settings.surface,
      supports: settings.supports,
      auto_orient: settings.auto_orient
    };

    const sliceSteps = ['Slicing plate', 'Loading G-code preview'];
    slicerShowProgress('Slicing Saved Plate...', sliceSteps, 0, `PrusaSlicer is processing ${totalParts} parts`);

    let sliceResult;
    try {
      sliceResult = await printStation.slicer.slicePlate(sliceOptions);
      if (sliceResult.error) throw new Error(sliceResult.error);
    } catch (err) {
      slicerHideProgress();
      console.error('[Slicer] Saved plate slice error:', err);
      showToast('Slice failed: ' + (err.message || 'unknown'), 'error', 8000);
      return;
    }

    // Update plate's last_gcode_id
    try {
      await printStation.slicer.updatePlate(plate.id, { last_gcode_id: sliceResult.gcode_id });
    } catch (e) { console.warn('[Slicer] Could not update plate gcode ref:', e); }

    // Fetch gcode for preview
    slicerUpdateProgress(1, 'Downloading G-code for 3D preview...');
    let gcodeText;
    try {
      gcodeText = await printStation.slicer.fetchGcodeText(sliceResult.gcode_id);
    } catch (err) {
      slicerHideProgress();
      showToast('Sliced! Could not load G-code preview: ' + err.message, 'warning', 6000);
      slicerLoadSavedPlates(); // Refresh cards
      return;
    }

    slicerHideProgress();
    const estInfo = sliceResult.est_time_min ? ` (${slicerFormatTime(sliceResult.est_time_min)}, ${sliceResult.est_weight_g ? sliceResult.est_weight_g.toFixed(1) + 'g' : '?'})` : '';
    showToast(`Plate sliced${estInfo}!`, 'success', 4000);

    // Show gcode preview
    const action = await slicerShowGcodePreview({
      gcodeText,
      gcodeId: sliceResult.gcode_id,
      sliceResult,
      printerId: printerId ? parseInt(printerId, 10) : null,
      printerName
    });

    if (action === 'print' && printerId) {
      const printSteps = ['Downloading G-code', 'Preparing file', 'Uploading to printer', 'Starting print'];
      slicerShowProgress('Sending to Printer...', printSteps, 0, 'Downloading G-code from server...');
      const offProgress = printStation.slicer.onPrintProgress(({ step, detail }) => {
        slicerUpdateProgress(step - 1, detail);
      });
      try {
        const result = await printStation.slicer.printGcode(sliceResult.gcode_id, parseInt(printerId, 10));
        offProgress();
        slicerHideProgress();
        if (result.success) showToast(`Print started on ${printerName}!`, 'success', 6000);
      } catch (err) {
        offProgress();
        slicerHideProgress();
        showToast('Print failed: ' + (err.message || 'unknown'), 'error', 8000);
      }
    }

    slicerLoadSavedPlates(); // Refresh cards with updated estimates
  });
}

async function slicerPreviewSavedPlate(plate) {
  const items = typeof plate.items === 'string' ? JSON.parse(plate.items) : (plate.items || []);
  if (!items.length) return alert('This plate has no items');

  // Load items into plate state and open build plate preview
  if (!slicerState.catalog || !slicerState.catalog.length) {
    await slicerLoadCatalog();
  }

  // Enable plate mode
  if (!slicerState.plateMode) {
    slicerState.plateMode = true;
    const btn = document.getElementById('slicerPlateToggle');
    if (btn) btn.classList.add('active');
  }

  // Load items
  slicerState.plateItems = [];
  slicerState.plateTransforms = {};
  for (const item of items) {
    const catalogItem = slicerState.catalog.find(i => i.id === item.stl_id);
    if (catalogItem) {
      slicerState.plateItems.push({ ...catalogItem, qty: item.qty || 1 });
      if (item.transform) {
        slicerState.plateTransforms[item.stl_id] = { ...item.transform };
      }
    }
  }

  slicerUpdatePlateBar();
  slicerUpdatePlateCheckmarks();

  // Switch to catalog tab and open build plate preview
  slicerShowSubTab('catalog');
  slicerShowBuildPlatePreview();
}

async function slicerEditSavedPlate(plate) {
  const items = typeof plate.items === 'string' ? JSON.parse(plate.items) : (plate.items || []);
  const settings = typeof plate.settings === 'string' ? JSON.parse(plate.settings) : (plate.settings || {});

  // Load catalog if needed
  if (!slicerState.catalog || !slicerState.catalog.length) {
    await slicerLoadCatalog();
  }

  // Enable plate mode
  if (!slicerState.plateMode) {
    slicerState.plateMode = true;
    const btn = document.getElementById('slicerPlateToggle');
    if (btn) btn.classList.add('active');
  }

  // Load items into working state
  slicerState.plateItems = [];
  slicerState.plateTransforms = {};
  for (const item of items) {
    const catalogItem = slicerState.catalog.find(i => i.id === item.stl_id);
    if (catalogItem) {
      slicerState.plateItems.push({ ...catalogItem, qty: item.qty || 1 });
      if (item.transform) {
        slicerState.plateTransforms[item.stl_id] = { ...item.transform };
      }
    }
  }

  // Apply saved settings
  if (settings) {
    Object.assign(slicerState.settings, settings);
  }

  // Store editing state so Save Plate updates instead of creating
  slicerState._editingPlateId = plate.id;
  slicerState._editingPlateName = plate.name;

  // Switch to catalog tab
  slicerShowSubTab('catalog');
  slicerUpdatePlateBar();
  slicerUpdatePlateCheckmarks();
  await slicerRenderCatalog();

  showToast(`Editing plate "${plate.name}" — modify items, then click Save Plate to update.`, 'info', 5000);
}

async function slicerDeleteSavedPlate(plate) {
  if (!confirm(`Delete plate "${plate.name}"? This cannot be undone.`)) return;

  try {
    await printStation.slicer.deletePlate(plate.id);
    showToast(`Plate "${plate.name}" deleted.`, 'success', 3000);
    slicerLoadSavedPlates();
  } catch (err) {
    console.error('[Slicer] Delete plate error:', err);
    showToast('Delete failed: ' + (err.message || 'unknown'), 'error', 5000);
  }
}

// --- Slice History ---

async function slicerLoadSliceHistory() {
  const panel = document.getElementById('slicerSliceHistoryPanel');
  if (!panel) return;

  panel.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted);">Loading slice history...</div>';

  try {
    const cacheList = await printStation.slicer.listCache();
    const entries = (cacheList.entries || cacheList || []).filter(e => e.plate_stl_ids);

    if (!entries.length) {
      panel.innerHTML = `
        <div style="text-align:center;padding:60px 20px;">
          <div style="font-size:1.1rem;color:var(--muted);margin-bottom:8px;">No plate slice history</div>
          <div style="font-size:0.85rem;color:var(--muted);">Sliced build plates will appear here with print time and filament estimates.</div>
        </div>`;
      return;
    }

    // Sort newest first
    entries.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

    panel.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:16px;">
        ${entries.map(entry => {
          const printerLabel = slicerPrinterModelLabel(entry.printer_model);
          const date = entry.created_at ? new Date(entry.created_at).toLocaleDateString() : '';
          const time = entry.created_at ? new Date(entry.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
          const fileName = entry.gcode_filename || entry.filename || 'plate.gcode';
          const fileSize = entry.file_size ? slicerFormatBytes(entry.file_size) : '';
          const materialLabel = entry.material ? entry.material.toUpperCase() : '';
          const qualityLabel = entry.quality || '';

          // Parse plate_stl_ids for item count
          let itemCount = 0;
          try {
            const ids = typeof entry.plate_stl_ids === 'string' ? JSON.parse(entry.plate_stl_ids) : entry.plate_stl_ids;
            itemCount = Array.isArray(ids) ? ids.length : 0;
          } catch {}

          return `
          <div class="inventory-card slice-history-card" data-gcode-id="${entry.id}" style="padding:16px;">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
              <div style="flex:1;min-width:0;">
                <div style="font-weight:600;font-size:0.95rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${slicerEsc(fileName)}</div>
                <div class="muted" style="font-size:0.8rem;">${printerLabel} &middot; ${materialLabel} &middot; ${qualityLabel} &middot; ${date} ${time}</div>
              </div>
            </div>
            <div style="display:flex;gap:12px;margin-bottom:10px;padding:8px 10px;background:rgba(255,255,255,0.04);border-radius:6px;font-size:0.85rem;">
              <span>Time: <strong>${slicerFormatTime(entry.est_time_min)}</strong></span>
              <span>Filament: <strong>${entry.est_weight_g ? entry.est_weight_g.toFixed(1) + 'g' : '?'}</strong></span>
              <span>Parts: <strong>${itemCount}</strong></span>
              ${fileSize ? `<span>Size: <strong>${fileSize}</strong></span>` : ''}
            </div>
            <div style="display:flex;gap:6px;">
              <button class="slice-history-action primary" data-action="print" data-gcode-id="${entry.id}" style="padding:6px 14px;font-size:0.85rem;">Print</button>
              <button class="slice-history-action secondary" data-action="download" data-gcode-id="${entry.id}" style="padding:6px 14px;font-size:0.85rem;">Download</button>
            </div>
          </div>`;
        }).join('')}
      </div>`;

    // Wire action buttons
    panel.querySelectorAll('.slice-history-action').forEach(btn => {
      btn.addEventListener('click', () => {
        const gcodeId = parseInt(btn.dataset.gcodeId, 10);
        const action = btn.dataset.action;

        if (action === 'print') slicerPrintFromHistory(gcodeId);
        else if (action === 'download') slicerDownloadGcode(gcodeId);
      });
    });
  } catch (err) {
    console.error('[Slicer] Load slice history error:', err);
    panel.innerHTML = `<div style="text-align:center;padding:40px;color:var(--danger);">Failed to load history: ${slicerEsc(err.message)}</div>`;
  }
}

async function slicerPrintFromHistory(gcodeId) {
  // Show printer picker
  const printers = slicerState.printers || [];
  if (!printers.length) return alert('No printers available');

  const anycubic = printers.filter(p => (p.model || '').toLowerCase().includes('kobra'));
  const creality = printers.filter(p => !(p.model || '').toLowerCase().includes('kobra'));

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;';

  let optionsHtml = '<option value="">Select a printer...</option>';
  if (anycubic.length) {
    optionsHtml += '<optgroup label="Anycubic">';
    anycubic.forEach(p => { optionsHtml += `<option value="${p.id}">${slicerEsc(p.name)} (${slicerEsc(p.model)})</option>`; });
    optionsHtml += '</optgroup>';
  }
  if (creality.length) {
    optionsHtml += '<optgroup label="Creality">';
    creality.forEach(p => { optionsHtml += `<option value="${p.id}">${slicerEsc(p.name)} (${slicerEsc(p.model)})</option>`; });
    optionsHtml += '</optgroup>';
  }

  const modal = document.createElement('div');
  modal.style.cssText = 'background:var(--card,#1e293b);border-radius:12px;padding:24px;max-width:400px;width:90%;';
  modal.innerHTML = `
    <h3 style="margin:0 0 16px;">Print G-code</h3>
    <div style="margin-bottom:16px;">
      <label style="font-size:0.85rem;color:var(--muted);margin-bottom:4px;display:block;">Send to Printer</label>
      <select id="historyPrintPrinterSelect" style="width:100%;padding:8px 12px;border-radius:6px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text);font-size:0.95rem;">
        ${optionsHtml}
      </select>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;">
      <button id="historyPrintCancelBtn" class="secondary" style="padding:8px 16px;">Cancel</button>
      <button id="historyPrintGoBtn" class="primary" style="padding:8px 20px;font-weight:600;">Print</button>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.getElementById('historyPrintCancelBtn').addEventListener('click', () => overlay.remove());

  document.getElementById('historyPrintGoBtn').addEventListener('click', async () => {
    const printerId = document.getElementById('historyPrintPrinterSelect').value;
    if (!printerId) { showToast('Please select a printer', 'warning', 3000); return; }
    const printer = printers.find(p => String(p.id) === String(printerId));
    overlay.remove();

    const printSteps = ['Downloading G-code', 'Preparing file', 'Uploading to printer', 'Starting print'];
    slicerShowProgress('Sending to Printer...', printSteps, 0, 'Downloading G-code from server...');
    const offProgress = printStation.slicer.onPrintProgress(({ step, detail }) => {
      slicerUpdateProgress(step - 1, detail);
    });

    try {
      const result = await printStation.slicer.printGcode(gcodeId, parseInt(printerId, 10));
      offProgress();
      slicerHideProgress();
      if (result.success) showToast(`Print started on ${printer ? printer.name : 'printer'}!`, 'success', 6000);
    } catch (err) {
      offProgress();
      slicerHideProgress();
      showToast('Print failed: ' + (err.message || 'unknown'), 'error', 8000);
    }
  });
}

async function slicerDownloadGcode(gcodeId) {
  try {
    showToast('Downloading G-code...', 'info', 2000);
    const gcodeText = await printStation.slicer.fetchGcodeText(gcodeId);
    if (!gcodeText) throw new Error('Empty G-code');
    const blob = new Blob([gcodeText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `plate_${gcodeId}.gcode`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('G-code downloaded!', 'success', 3000);
  } catch (err) {
    console.error('[Slicer] Download gcode error:', err);
    showToast('Download failed: ' + (err.message || 'unknown'), 'error', 5000);
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

  // Apply STL Z-up → Three.js Y-up so preview matches PrusaSlicer's orientation
  geometry.rotateX(-Math.PI / 2);

  // Apply any saved print-orientation overrides so preview shows exactly how it'll print
  const previewItem = slicerState.selectedItem;
  if (previewItem) {
    const t = slicerState.plateTransforms[previewItem.id];
    if (t) {
      if (t.rx) geometry.rotateX(t.rx);
      if (t.ry) geometry.rotateY(t.ry);
      if (t.rz) geometry.rotateZ(t.rz);
      if (t.scale && t.scale !== 1) geometry.scale(t.scale, t.scale, t.scale);
    }
  }

  // Floor model to Y=0 and center in XZ — matches how build plate preview shows it
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  geometry.translate(
    -((bb.max.x + bb.min.x) / 2),
    -bb.min.y,
    -((bb.max.z + bb.min.z) / 2)
  );

  const material = new THREE.MeshPhongMaterial({
    color: 0x38bdf8, specular: 0x222222, shininess: 40
  });
  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);

  // Small bed reference plane at Y=0 so orientation relative to printer X/Y axes is visible
  geometry.computeBoundingBox();
  const mbox = geometry.boundingBox;
  const mw = mbox.max.x - mbox.min.x;
  const md = mbox.max.z - mbox.min.z;
  const mh = mbox.max.y - mbox.min.y;
  const padFactor = 1.6;
  const bedW = Math.max(mw * padFactor, 30);
  const bedD = Math.max(md * padFactor, 30);
  const bedGeo = new THREE.PlaneGeometry(bedW, bedD);
  const bedMat = new THREE.MeshPhongMaterial({ color: 0x1a1a2e, transparent: true, opacity: 0.7 });
  const bedMesh = new THREE.Mesh(bedGeo, bedMat);
  bedMesh.rotation.x = -Math.PI / 2;
  scene.add(bedMesh);

  // Thin grid lines on the bed (5mm spacing, up to 8 lines per axis)
  const gridPts = [];
  const step = Math.max(5, Math.ceil(Math.min(bedW, bedD) / 8 / 5) * 5);
  for (let x = -bedW / 2; x <= bedW / 2 + 0.01; x += step) {
    gridPts.push(new THREE.Vector3(x, 0.05, -bedD / 2));
    gridPts.push(new THREE.Vector3(x, 0.05,  bedD / 2));
  }
  for (let z = -bedD / 2; z <= bedD / 2 + 0.01; z += step) {
    gridPts.push(new THREE.Vector3(-bedW / 2, 0.05, z));
    gridPts.push(new THREE.Vector3( bedW / 2, 0.05, z));
  }
  const gridGeo = new THREE.BufferGeometry().setFromPoints(gridPts);
  const gridMat = new THREE.LineBasicMaterial({ color: 0x333355, transparent: true, opacity: 0.4 });
  const gridMesh = new THREE.LineSegments(gridGeo, gridMat);
  scene.add(gridMesh);

  // Camera: same elevation angle as build plate (0.5/0.7/0.5 ratio) so orientation reads identically
  const maxDim = Math.max(mw, mh, md, bedW, bedD);
  const fov = camera.fov * (Math.PI / 180);
  const dist = maxDim / (2 * Math.tan(fov / 2)) * 1.4;
  const modelCenterY = mh / 2;
  camera.position.set(dist * 0.5, modelCenterY + dist * 0.7, dist * 0.5);
  const target = new THREE.Vector3(0, modelCenterY, 0);
  camera.lookAt(target);

  const controls = new THREE.OrbitControls(camera, canvas);
  controls.target.copy(target);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;
  controls.update();

  let animId;
  function animate() {
    animId = requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  slicerState.selectedPreview = { renderer, scene, camera, controls, animId, geometry, material, bedGeo, bedMat, gridGeo, gridMat };
}

function slicerDisposeSelectedPreview() {
  const p = slicerState.selectedPreview;
  if (!p) return;
  if (p.animId) cancelAnimationFrame(p.animId);
  if (p.controls) p.controls.dispose();
  if (p.geometry) p.geometry.dispose();
  if (p.material) p.material.dispose();
  if (p.bedGeo) p.bedGeo.dispose();
  if (p.bedMat) p.bedMat.dispose();
  if (p.gridGeo) p.gridGeo.dispose();
  if (p.gridMat) p.gridMat.dispose();
  if (p.renderer) p.renderer.dispose();
  slicerState.selectedPreview = null;
}

// ============================================================================
// SINGLE-ITEM ORIENTATION CONTROLS
// ============================================================================

/**
 * Rotate the selected single item 90° on the given axis, save to plateTransforms,
 * and re-render the preview so the user sees the effect immediately.
 */
function slicerRotateSingle(axis, dir) {
  const item = slicerState.selectedItem;
  if (!item) return;

  const angle = (Math.PI / 2) * dir;
  if (!slicerState.plateTransforms[item.id]) {
    slicerState.plateTransforms[item.id] = { rx: 0, ry: 0, rz: 0, scale: 1, posX: 0, posZ: 0 };
  }
  const t = slicerState.plateTransforms[item.id];
  if (axis === 'x')      t.rx = (t.rx || 0) + angle;
  else if (axis === 'y') t.ry = (t.ry || 0) + angle;
  else if (axis === 'z') t.rz = (t.rz || 0) + angle;

  slicerUpdateRotHint();
  slicerFetchStlBuffer(item.id).then(buf => slicerRenderSelectedPreview(buf)).catch(() => {});
}

/**
 * Clear any saved orientation override for the current item and re-render.
 */
function slicerResetSingleRotation() {
  const item = slicerState.selectedItem;
  if (!item) return;
  delete slicerState.plateTransforms[item.id];
  slicerUpdateRotHint();
  slicerFetchStlBuffer(item.id).then(buf => slicerRenderSelectedPreview(buf)).catch(() => {});
}

/**
 * Update the rotation hint text and saved-badge visibility.
 */
function slicerUpdateRotHint() {
  const hintEl  = document.getElementById('slicerRotHint');
  const badgeEl = document.getElementById('slicerSavedOrientBadge');
  const item = slicerState.selectedItem;
  const t = item ? slicerState.plateTransforms[item.id] : null;
  const toDeg = r => Math.round(((r || 0) * 180 / Math.PI + 360 * 100) % 360);
  const rxd = toDeg(t && t.rx);
  const ryd = toDeg(t && t.ry);
  const rzd = toDeg(t && t.rz);
  if (hintEl) {
    if (!t || (rxd === 0 && ryd === 0 && rzd === 0)) {
      hintEl.textContent = '';
    } else {
      const parts = [];
      if (rxd !== 0) parts.push(`X:${rxd}°`);
      if (ryd !== 0) parts.push(`Y:${ryd}°`);
      if (rzd !== 0) parts.push(`Z:${rzd}°`);
      hintEl.textContent = parts.join(' ');
    }
  }
  // Show "★ saved" badge if item has a persisted default transform
  if (badgeEl) {
    const hasSaved = item && item.default_transform;
    badgeEl.style.display = hasSaved ? '' : 'none';
  }
}

/**
 * Save current orientation as the permanent default for this item.
 * Persists to server DB so it auto-applies on every future slice.
 */
async function slicerSaveDefaultOrientation() {
  const item = slicerState.selectedItem;
  if (!item) return;
  const t = slicerState.plateTransforms[item.id];
  const saveBtn = document.getElementById('slicerSaveDefaultOrientBtn');

  try {
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

    const payload = t
      ? { rx: t.rx || 0, ry: t.ry || 0, rz: t.rz || 0, scale: t.scale || 1 }
      : null; // null clears the saved default

    await printStation.slicer.updateCatalogItem(item.id, {
      default_transform: payload ? JSON.stringify(payload) : null
    });

    // Update local item cache so badge reflects saved state
    item.default_transform = payload ? JSON.stringify(payload) : null;
    slicerUpdateRotHint();

    if (saveBtn) {
      saveBtn.textContent = payload ? '✓ Saved!' : '✓ Cleared';
      setTimeout(() => {
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Default'; }
      }, 1500);
    }
  } catch (err) {
    console.error('[Slicer] Save default orientation failed:', err);
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Default'; }
    alert('Failed to save default orientation: ' + err.message);
  }
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

// ============================================================================
// UPDATE INFO MODAL — Scrape part description from Thangs page
// ============================================================================

let _slicerUpdateInfoItem = null;
let _slicerUpdateInfoWebview = null;
let _slicerUpdateScrapedData = null;

function slicerOpenUpdateInfoModal(item) {
  _slicerUpdateInfoItem = item;
  _slicerUpdateScrapedData = null;

  const modal = document.getElementById('slicerUpdateInfoModal');
  if (!modal) return;
  modal.style.display = '';

  // Set title
  const title = document.getElementById('slicerUpdateInfoTitle');
  if (title) title.textContent = `Update Info: ${item.name}`;

  // Reset results panel
  const empty = document.getElementById('slicerUpdateScrapedEmpty');
  const results = document.getElementById('slicerUpdateScrapedResults');
  if (empty) empty.style.display = '';
  if (results) results.style.display = 'none';

  // Create webview if needed
  const container = document.getElementById('slicerUpdateWebviewContainer');
  if (!container) return;

  // Remove old webview
  if (_slicerUpdateInfoWebview) {
    try { _slicerUpdateInfoWebview.remove(); } catch (_) {}
    _slicerUpdateInfoWebview = null;
  }

  const wv = document.createElement('webview');
  const searchName = encodeURIComponent(item.name.replace(/\s+/g, ' ').trim());
  const searchUrl = item.source_url || `https://thangs.com/search/${searchName}?view=list&searchScope=thangs`;
  wv.setAttribute('src', searchUrl);
  wv.setAttribute('partition', 'persist:multiboard-browser');
  wv.setAttribute('allowpopups', '');
  wv.style.cssText = 'width:100%;height:100%;border:none;';

  wv.addEventListener('did-navigate', (e) => {
    const urlBar = document.getElementById('slicerUpdateUrlBar');
    if (urlBar) urlBar.value = e.url;
  });
  wv.addEventListener('did-navigate-in-page', (e) => {
    if (e.isMainFrame) {
      const urlBar = document.getElementById('slicerUpdateUrlBar');
      if (urlBar) urlBar.value = e.url;
    }
  });

  container.appendChild(wv);
  _slicerUpdateInfoWebview = wv;

  // Wire buttons (use event delegation to avoid double-binding)
  const scrapeBtn = document.getElementById('slicerUpdateScrapeBtn');
  const closeBtn = document.getElementById('slicerUpdateCloseBtn');
  const approveBtn = document.getElementById('slicerUpdateApproveBtn');
  const discardBtn = document.getElementById('slicerUpdateDiscardBtn');

  // Replace elements to remove old listeners
  if (scrapeBtn) {
    const newBtn = scrapeBtn.cloneNode(true);
    scrapeBtn.parentNode.replaceChild(newBtn, scrapeBtn);
    newBtn.addEventListener('click', slicerUpdateScrape);
  }
  if (closeBtn) {
    const newBtn = closeBtn.cloneNode(true);
    closeBtn.parentNode.replaceChild(newBtn, closeBtn);
    newBtn.addEventListener('click', slicerCloseUpdateInfoModal);
  }
  if (approveBtn) {
    const newBtn = approveBtn.cloneNode(true);
    approveBtn.parentNode.replaceChild(newBtn, approveBtn);
    newBtn.addEventListener('click', slicerUpdateApprove);
  }
  if (discardBtn) {
    const newBtn = discardBtn.cloneNode(true);
    discardBtn.parentNode.replaceChild(newBtn, discardBtn);
    newBtn.addEventListener('click', () => {
      _slicerUpdateScrapedData = null;
      const empty = document.getElementById('slicerUpdateScrapedEmpty');
      const results = document.getElementById('slicerUpdateScrapedResults');
      if (empty) empty.style.display = '';
      if (results) results.style.display = 'none';
    });
  }
}

function slicerCloseUpdateInfoModal() {
  const modal = document.getElementById('slicerUpdateInfoModal');
  if (modal) modal.style.display = 'none';

  if (_slicerUpdateInfoWebview) {
    try { _slicerUpdateInfoWebview.remove(); } catch (_) {}
    _slicerUpdateInfoWebview = null;
  }
  _slicerUpdateInfoItem = null;
  _slicerUpdateScrapedData = null;
}

async function slicerUpdateScrape() {
  if (!_slicerUpdateInfoWebview) return;

  const scrapeBtn = document.getElementById('slicerUpdateScrapeBtn');
  if (scrapeBtn) {
    scrapeBtn.textContent = 'Scraping...';
    scrapeBtn.disabled = true;
  }

  try {
    // Get the current page URL
    const pageUrl = await _slicerUpdateInfoWebview.executeJavaScript('window.location.href');

    // Scrape description from the page — gather text from ALL matching elements
    const description = await _slicerUpdateInfoWebview.executeJavaScript(`
      (function() {
        try {
          var seen = new Set();
          var parts = [];

          // Collect text from all elements matching these selectors
          var selectors = [
            '[class*="description" i]',
            '[data-testid*="description"]',
            '.model-page-description',
            'article',
            '[class*="about" i]',
            '[class*="detail" i]',
            '[class*="specs" i]',
            '[class*="info" i]',
            '[class*="content" i]',
            '[class*="body" i]',
            '[class*="text" i]',
            '[class*="readme" i]',
            '[class*="summary" i]'
          ];

          for (var i = 0; i < selectors.length; i++) {
            var els = document.querySelectorAll(selectors[i]);
            for (var j = 0; j < els.length; j++) {
              var el = els[j];
              // Skip tiny elements, nav bars, headers, footers, buttons
              var tag = el.tagName.toLowerCase();
              if (tag === 'button' || tag === 'input' || tag === 'select' || tag === 'nav' || tag === 'footer' || tag === 'header') continue;
              // Skip if element is not visible
              var rect = el.getBoundingClientRect();
              if (rect.width < 50 || rect.height < 10) continue;
              var text = (el.innerText || '').trim();
              // Skip short or duplicate text
              if (text.length < 15) continue;
              if (seen.has(text)) continue;
              // Skip if this text is a subset of something we already have
              var isSubset = false;
              for (var k = 0; k < parts.length; k++) {
                if (parts[k].includes(text)) { isSubset = true; break; }
              }
              if (isSubset) continue;
              // Remove any existing parts that are subsets of this text
              parts = parts.filter(function(p) { return !text.includes(p); });
              seen = new Set(parts);
              seen.add(text);
              parts.push(text);
            }
          }

          if (parts.length > 0) {
            return parts.join('\\n\\n---\\n\\n').slice(0, 8000);
          }

          // Fallback: meta description
          var meta = document.querySelector('meta[name="description"]')
            || document.querySelector('meta[property="og:description"]');
          if (meta && meta.content && meta.content.trim().length > 10) {
            return meta.content.trim().slice(0, 8000);
          }
          return null;
        } catch(e) { return null; }
      })()
    `);

    // Run the parser on the scraped description + item name
    // We do this server-side via an IPC call
    const parsed = await printStation.slicer.parsePartInfo(
      _slicerUpdateInfoItem.name,
      description || ''
    );

    _slicerUpdateScrapedData = {
      source_url: pageUrl,
      description: description,
      mount_type: parsed?.mount_type || 'unknown',
      mount_hardware: parsed?.mount_hardware || null,
      requires_tray: parsed?.requires_tray || 0,
      tray_size: parsed?.tray_size || null,
      tray_notes: parsed?.tray_notes || null
    };

    // Show results
    slicerUpdateShowScrapedResults();

  } catch (err) {
    console.warn('[UpdateInfo] Scrape error:', err);
    if (typeof window.showToast === 'function') {
      window.showToast('Scrape failed: ' + (err.message || 'unknown error'), 'error');
    }
  } finally {
    const btn = document.getElementById('slicerUpdateScrapeBtn');
    if (btn) {
      btn.textContent = 'Scrape This Page';
      btn.disabled = false;
    }
  }
}

function slicerUpdateShowScrapedResults() {
  const data = _slicerUpdateScrapedData;
  if (!data) return;

  const empty = document.getElementById('slicerUpdateScrapedEmpty');
  const results = document.getElementById('slicerUpdateScrapedResults');
  if (empty) empty.style.display = 'none';
  if (results) results.style.display = '';

  // Fill in fields
  const urlEl = document.getElementById('slicerUpdateSourceUrl');
  if (urlEl) urlEl.textContent = data.source_url || 'N/A';

  const descEl = document.getElementById('slicerUpdateDescription');
  if (descEl) descEl.textContent = data.description || '(no description found)';

  const mountSel = document.getElementById('slicerUpdateMountType');
  if (mountSel) mountSel.value = data.mount_type || 'unknown';

  const hwEl = document.getElementById('slicerUpdateHardware');
  if (hwEl) {
    if (data.mount_hardware) {
      try {
        const hw = JSON.parse(data.mount_hardware);
        hwEl.innerHTML = hw.map(h => {
          if (h.type === 'magnet') return `<div>Magnet: ${h.qty || '?'}x ${h.size || 'unknown size'}</div>`;
          if (h.type === 'screw') return `<div>Screw: ${h.qty || '?'}x ${h.spec || 'unknown'}</div>`;
          if (h.type === 'insert') return `<div>Insert: ${h.spec || 'unknown'}</div>`;
          return `<div>${h.type}: ${JSON.stringify(h)}</div>`;
        }).join('');
      } catch (_) {
        hwEl.textContent = data.mount_hardware;
      }
    } else {
      hwEl.textContent = 'None detected';
    }
  }

  const trayEl = document.getElementById('slicerUpdateTray');
  if (trayEl) {
    if (data.requires_tray) {
      trayEl.textContent = `Yes${data.tray_size ? ` (${data.tray_size})` : ''}${data.tray_notes ? ` — ${data.tray_notes}` : ''}`;
    } else {
      trayEl.textContent = 'No';
    }
  }
}

async function slicerUpdateApprove() {
  if (!_slicerUpdateInfoItem || !_slicerUpdateScrapedData) return;

  const data = _slicerUpdateScrapedData;
  const id = _slicerUpdateInfoItem.id;

  // Allow user to override mount type from dropdown
  const mountSel = document.getElementById('slicerUpdateMountType');
  if (mountSel) data.mount_type = mountSel.value;

  try {
    await printStation.slicer.updateCatalogItem(id, {
      source_url: data.source_url || null,
      description: data.description || null,
      mount_type: data.mount_type || null,
      mount_hardware: data.mount_hardware || null,
      requires_tray: data.requires_tray || 0,
      tray_size: data.tray_size || null,
      tray_notes: data.tray_notes || null
    });

    if (typeof window.showToast === 'function') {
      window.showToast('Part info updated!', 'success');
    }

    // Update the local item data and re-render
    Object.assign(_slicerUpdateInfoItem, data);
    slicerRenderSelectedInfo(_slicerUpdateInfoItem);

    slicerCloseUpdateInfoModal();
  } catch (err) {
    console.warn('[UpdateInfo] Save error:', err);
    if (typeof window.showToast === 'function') {
      window.showToast('Save failed: ' + (err.message || 'unknown error'), 'error');
    }
  }
}

// ============================================================================
// PUBLIC API — called externally (e.g. from Print Quotes view)
// ============================================================================

/**
 * Switch to plate mode and pre-load catalog items by ID.
 * @param {Array<{id: number, name: string, qty?: number}>} items
 */
window.slicerAddPlateItems = async function (items) {
  if (!slicerState.initialized) {
    initSlicerView();
    await new Promise(r => setTimeout(r, 400));
  }
  // Ensure catalog is loaded
  if (!slicerState.catalog || !slicerState.catalog.length) {
    await slicerLoadCatalog();
  }
  // Enable plate mode
  if (!slicerState.plateMode) {
    slicerState.plateMode = true;
    const btn = document.getElementById('slicerPlateToggle');
    if (btn) btn.classList.add('active');
  }
  // Add items
  for (const req of items) {
    const catalogItem = slicerState.catalog.find(i => i.id === req.id);
    if (catalogItem && !slicerState.plateItems.find(i => i.id === req.id)) {
      slicerState.plateItems.push({ ...catalogItem, _overrideQty: req.qty || 1 });
    }
  }
  slicerUpdatePlateBar();
  await slicerRenderCatalog();
};
