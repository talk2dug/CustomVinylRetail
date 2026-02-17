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
    auto_orient: false
  },
  printers: [],
  loading: false,
  thumbCache: {},      // stlId -> dataURL (in-memory, lost on reload)
  thumbDiskCache: {},  // stlId -> file:// URL (populated from disk cache)
  stlBytesCache: {},   // stlId -> ArrayBuffer
  selectedPreview: null, // { renderer, scene, camera, controls, animId, resizeObs }
  plateMode: false,      // whether multi-select plate mode is active
  plateItems: [],        // array of catalog item objects on the plate
  platePreview: null,    // { renderer, scene, camera, controls, animId, resizeObs, meshes[], selectedMeshIndex, ... }
  plateTransforms: {}    // { [stlId]: { rx, ry, rz, scale, posX, posZ } } — persists rotation + scale + position across preview open/close
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
  const sliceOnlyBtn = document.getElementById('slicerSliceOnlyBtn');

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
    categoryFilter.addEventListener('change', () => slicerLoadCatalog());
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

  // Slice & Print
  if (sliceBtn) {
    sliceBtn.addEventListener('click', () => slicerSliceAndPrint(true));
  }

  // Slice Only
  if (sliceOnlyBtn) {
    sliceOnlyBtn.addEventListener('click', () => slicerSliceAndPrint(false));
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
    plateSliceBtn.addEventListener('click', () => slicerSlicePlate(true));
  }

  const plateSliceOnlyBtn = document.getElementById('slicerPlateSliceOnlyBtn');
  if (plateSliceOnlyBtn) {
    plateSliceOnlyBtn.addEventListener('click', () => slicerSlicePlate(false));
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
    return;
  }

  try {
    const result = await printStation.slicer.listCatalog({ search, category });
    slicerState.catalog = result.items || [];
    await slicerRenderCatalog();
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
    <div class="inventory-card slicer-catalog-card${selected ? ' slicer-plate-selected' : ''}" data-stl-id="${item.id}" style="cursor:pointer;padding:16px;position:relative;">
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

    // Simple name from filename
    const basename = filePath.split(/[\\/]/).pop().replace(/\.stl$/i, '').replace(/[_-]/g, ' ');

    slicerShowProgress('Uploading STL...', 'Sending file to server');

    const result = await printStation.slicer.uploadStl({
      filePath,
      name: basename,
      category: document.getElementById('slicerCategoryFilter')?.value || ''
    });

    slicerHideProgress();

    if (result.item) {
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
    const dirs = await printStation.selectFolder({ title: 'Select folder with STL files' });
    console.log('[Slicer] Folder selection result:', dirs);
    if (!dirs || !dirs.length) return;
    const directory = dirs[0];

    showToast('Scanning directory for STL files...', 'info', 3000);

    const files = await printStation.slicer.bulkScan(directory);

    if (!files || !files.length) {
      showToast('No STL files found in the selected directory.', 'warning', 4000);
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
      <strong id="slicerBulkTitle">Uploading 0 / ${total} STL files</strong>
      <span id="slicerBulkPct" style="font-size:0.8rem;color:var(--muted);">0%</span>
    </div>
    <div id="slicerBulkFile" style="color:var(--muted);font-size:0.8rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:8px;">Starting...</div>
    <div style="height:4px;border-radius:2px;background:var(--bg-secondary,#0f172a);overflow:hidden;">
      <div id="slicerBulkBar" style="height:100%;width:0%;background:var(--accent,#6366f1);border-radius:2px;transition:width 0.3s;"></div>
    </div>`;
  document.body.appendChild(toast);
  return toast;
}

async function slicerRunBulkUploadBackground(files) {
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
    if (titleEl) titleEl.textContent = `Uploading ${uploaded} / ${total} STL files`;
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

  // Done — update toast to show result, then fade out
  const successCount = total - failed;
  if (titleEl) titleEl.textContent = `Import complete: ${successCount} / ${total}`;
  if (fileEl) fileEl.textContent = failed > 0 ? `${failed} failed` : 'All files uploaded successfully';
  if (barEl) barEl.style.width = '100%';
  if (barEl) barEl.style.background = failed > 0 ? 'var(--warning,#f59e0b)' : 'var(--success,#22c55e)';

  // Refresh catalog if user is on slicer view
  try {
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

  // Auto-set material when ACE slot is selected
  slotSelect.onchange = () => {
    const selected = slotSelect.selectedOptions[0];
    if (!selected || !selected.dataset.material) return;
    const mat = selected.dataset.material;
    // Map ACE material names to slicer material keys
    const matMap = { pla: 'pla', petg: 'petg', abs: 'abs', tpu: 'tpu', asa: 'abs', 'rapid pla': 'rapid_pla', 'rapid petg': 'rapid_petg' };
    const slicerMat = matMap[mat] || mat.replace(/\s+/g, '_');
    if (slicerState.presets?.materials?.some(m => m.key === slicerMat)) {
      slicerState.settings.material = slicerMat;
      slicerSyncSettingsButtons();
    }
  };
}

// ============================================================================
// SLICING & PRINTING
// ============================================================================

async function slicerSliceAndPrint(andPrint) {
  const item = slicerState.selectedItem;
  if (!item) return alert('No model selected');

  const printerId = andPrint ? document.getElementById('slicerPrinter')?.value : null;
  if (andPrint && !printerId) return alert('Please select a printer');

  // Find the selected printer to get its model
  let printerModel = '';
  let printerName = '';
  if (printerId) {
    const printer = slicerState.printers.find(p => String(p.id) === String(printerId));
    if (printer) {
      printerName = printer.name || '';
      if (printer.model) printerModel = slicerMapPrinterModel(printer.model);
    }
  }

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
    auto_orient: slicerState.settings.auto_orient
  };

  // Read ACE slot if visible
  const aceSlotVal = document.getElementById('slicerAceSlot')?.value;
  const aceSlot = (aceSlotVal !== '' && aceSlotVal != null) ? parseInt(aceSlotVal, 10) : null;

  if (andPrint) {
    // Fire-and-forget — don't block the UI
    const modelName = item.name || 'model';
    showToast(`Slicing & sending "${modelName}" to ${printerName || 'printer'}...`, 'info', 6000);

    printStation.slicer.sliceAndPrint(sliceOptions, parseInt(printerId, 10), aceSlot)
      .then(result => {
        if (result.success) {
          showToast(`Print started on ${printerName}: ${modelName} (Job #${result.job?.id || ''})`, 'success', 6000);
        }
      })
      .catch(err => {
        console.error('[Slicer] Slice & print error:', err);
        showToast(`Print failed: ${err.message}`, 'error', 8000);
      });
  } else {
    // Slice-only: keep blocking so user sees the G-code result
    slicerShowProgress('Slicing...', 'PrusaSlicer is processing your model on the server');
    try {
      const result = await printStation.slicer.slice(sliceOptions);
      slicerHideProgress();

      // Refresh G-code list
      const updated = await printStation.slicer.getCatalogItem(item.id);
      if (updated) {
        slicerState.gcodeEntries = updated.gcodeEntries || [];
        slicerRenderGcodeList(slicerState.gcodeEntries);
      }

      const cached = result.cached ? ' (cache hit)' : '';
      showToast(`Slicing complete${cached}!`, 'success');
    } catch (err) {
      slicerHideProgress();
      console.error('[Slicer] Slice error:', err);
      showToast('Slicing failed: ' + err.message, 'error', 8000);
    }
  }
}

function slicerPrintExistingGcode(gcodeId) {
  const printerId = document.getElementById('slicerPrinter')?.value;
  if (!printerId) return alert('Please select a printer first');

  const aceSlotVal = document.getElementById('slicerAceSlot')?.value;
  const aceSlot = (aceSlotVal !== '' && aceSlotVal != null) ? parseInt(aceSlotVal, 10) : null;

  const printer = slicerState.printers.find(p => String(p.id) === String(printerId));
  const printerName = printer?.name || 'printer';

  // Fire-and-forget — don't block the UI
  showToast(`Sending G-code to ${printerName}...`, 'info', 6000);

  printStation.slicer.printGcode(gcodeId, parseInt(printerId, 10), aceSlot)
    .then(result => {
      if (result.success) {
        showToast(`Print started on ${printerName} (Job #${result.job?.id || ''})`, 'success', 6000);
      }
    })
    .catch(err => {
      console.error('[Slicer] Print existing G-code error:', err);
      showToast('Print failed: ' + err.message, 'error', 8000);
    });
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

  // Clamp scale
  newScale = Math.max(0.1, Math.min(10.0, newScale));

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
            <input id="bpScaleSlider" type="range" min="10" max="1000" value="100" step="5"
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

    // Auto-set material on slot change
    slotSelect.onchange = () => {
      const selected = slotSelect.selectedOptions[0];
      if (!selected || !selected.dataset.material) return;
      const mat = selected.dataset.material;
      const matMap = { pla: 'pla', petg: 'petg', abs: 'abs', tpu: 'tpu', asa: 'abs', 'rapid pla': 'rapid_pla', 'rapid petg': 'rapid_petg' };
      const slicerMat = matMap[mat] || mat.replace(/\s+/g, '_');
      if (slicerState.presets?.materials?.some(m => m.key === slicerMat)) {
        slicerState.settings.material = slicerMat;
        const matContainer = document.getElementById('slicerPlateMaterial');
        if (matContainer) slicerHighlightButtons(matContainer, slicerMat);
      }
    };
  };
  // Reset slot picker
  select.onchange();
}

async function slicerSlicePlate(andPrint) {
  if (!slicerState.plateItems.length) return alert('No models on the plate');

  const printerId = andPrint ? document.getElementById('slicerPlatePrinter')?.value : null;
  if (andPrint && !printerId) return alert('Please select a printer');

  // Determine printer model
  let printerModel = '';
  if (printerId) {
    const printer = slicerState.printers.find(p => String(p.id) === String(printerId));
    if (printer && printer.model) {
      printerModel = slicerMapPrinterModel(printer.model);
    }
  }

  // Collect per-model transforms from the build plate preview
  const transforms = {};
  for (const item of slicerState.plateItems) {
    const t = slicerState.plateTransforms[item.id];
    if (t) {
      transforms[item.id] = {
        rx: t.rx || 0,
        ry: t.ry || 0,
        rz: t.rz || 0,
        scale: t.scale || 1,
        posX: t.posX || 0,
        posZ: t.posZ || 0
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

  const modelCount = slicerState.plateItems.length;

  if (andPrint) {
    // Fire-and-forget — don't block the UI
    const printer = slicerState.printers.find(p => String(p.id) === String(printerId));
    const printerName = printer?.name || 'printer';

    showToast(`Slicing ${modelCount} models & sending to ${printerName}...`, 'info', 6000);

    printStation.slicer.slicePlateAndPrint(sliceOptions, parseInt(printerId, 10), aceSlot)
      .then(result => {
        if (result.success) {
          showToast(`Plate print started on ${printerName} (Job #${result.job?.id || ''})`, 'success', 6000);
        }
      })
      .catch(err => {
        console.error('[Slicer] Plate slice & print error:', err);
        const msg = err?.message || err?.error || JSON.stringify(err) || 'Unknown error';
        showToast('Plate print failed: ' + msg, 'error', 8000);
      });
  } else {
    // Slice-only: keep blocking so user sees the result
    slicerShowProgress('Slicing Plate...', `PrusaSlicer is processing ${modelCount} models on the server`);
    try {
      const result = await printStation.slicer.slicePlate(sliceOptions);
      slicerHideProgress();

      const cached = result.cached ? ' (cache hit)' : '';
      showToast(`Plate slicing complete${cached}!`, 'success');
    } catch (err) {
      slicerHideProgress();
      console.error('[Slicer] Plate slice error:', err);
      const msg = err?.message || err?.error || JSON.stringify(err) || 'Unknown error';
      showToast('Plate slicing failed: ' + msg, 'error', 8000);
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

function slicerShowProgress(title, msg) {
  const overlay = document.getElementById('slicerProgressOverlay');
  const titleEl = document.getElementById('slicerProgressTitle');
  const msgEl = document.getElementById('slicerProgressMsg');
  const bar = document.getElementById('slicerProgressBar');

  if (overlay) overlay.style.display = 'flex';
  if (titleEl) titleEl.textContent = title || 'Processing...';
  if (msgEl) msgEl.textContent = msg || '';
  if (bar) {
    bar.style.width = '0%';
    // Animate indeterminate
    bar.style.animation = 'slicerPulse 2s infinite';
  }
  slicerState.loading = true;
}

function slicerHideProgress() {
  const overlay = document.getElementById('slicerProgressOverlay');
  const bar = document.getElementById('slicerProgressBar');
  if (overlay) overlay.style.display = 'none';
  if (bar) bar.style.animation = '';
  slicerState.loading = false;
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
