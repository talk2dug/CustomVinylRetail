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
    material: 'pla',
    printer_model: ''
  },
  printers: [],
  loading: false,
  thumbCache: {},      // stlId -> dataURL
  stlBytesCache: {},   // stlId -> ArrayBuffer
  selectedPreview: null // { renderer, scene, camera, controls, animId, resizeObs }
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

  // Load catalog
  await slicerLoadCatalog();
  await slicerLoadCategories();
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

  // Slice & Print
  if (sliceBtn) {
    sliceBtn.addEventListener('click', () => slicerSliceAndPrint(true));
  }

  // Slice Only
  if (sliceOnlyBtn) {
    sliceOnlyBtn.addEventListener('click', () => slicerSliceAndPrint(false));
  }

  // Catalog grid click delegation
  const grid = document.getElementById('slicerCatalogGrid');
  if (grid) {
    grid.addEventListener('click', (e) => {
      const card = e.target.closest('[data-stl-id]');
      if (card) {
        const id = parseInt(card.dataset.stlId, 10);
        slicerSelectItem(id);
      }
      // Delete button
      const delBtn = e.target.closest('.slicer-catalog-delete');
      if (delBtn) {
        e.stopPropagation();
        const id = parseInt(delBtn.dataset.stlId, 10);
        slicerDeleteItem(id);
      }
    });
  }

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

  try {
    const result = await printStation.slicer.listCatalog({ search, category });
    slicerState.catalog = result.items || [];
    slicerRenderCatalog();
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
      select.innerHTML = '<option value="">All Categories</option>' +
        slicerState.categories.map(c =>
          `<option value="${slicerEsc(c)}"${c === current ? ' selected' : ''}>${slicerEsc(c)}</option>`
        ).join('');
    }
  } catch (err) {
    console.warn('[Slicer] Load categories error:', err);
  }
}

function slicerRenderCatalog() {
  const grid = document.getElementById('slicerCatalogGrid');
  if (!grid) return;

  if (!slicerState.catalog.length) {
    grid.innerHTML = `<div class="placeholder" style="grid-column:1/-1;text-align:center;padding:60px 20px;color:var(--muted);">
      No STL models in the catalog yet. Click <strong>+ Upload STL</strong> to add your first model.
    </div>`;
    return;
  }

  grid.innerHTML = slicerState.catalog.map(item => {
    const cached = slicerState.thumbCache[item.id];
    const thumbHtml = cached
      ? `<img src="${cached}" style="width:80px;height:80px;border-radius:8px;object-fit:cover;background:#0a0a1a;">`
      : `<canvas class="slicer-stl-thumb" data-stl-id="${item.id}" width="160" height="160" style="width:80px;height:80px;border-radius:8px;background:#0a0a1a;"></canvas>`;
    return `
    <div class="inventory-card slicer-catalog-card" data-stl-id="${item.id}" style="cursor:pointer;padding:16px;position:relative;">
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

    slicerShowProgress('Scanning directory...', 'Looking for STL files and ZIP archives');

    const files = await printStation.slicer.bulkScan(directory);

    if (!files || !files.length) {
      slicerHideProgress();
      alert('No STL files found in the selected directory.');
      return;
    }

    const category = document.getElementById('slicerCategoryFilter')?.value || '';
    const total = files.length;
    let uploaded = 0;
    let failed = 0;
    const errors = [];

    const titleEl = document.getElementById('slicerProgressTitle');
    const msgEl = document.getElementById('slicerProgressMsg');
    const bar = document.getElementById('slicerProgressBar');
    if (titleEl) titleEl.textContent = `Uploading ${total} STL files...`;
    if (bar) bar.style.animation = '';

    for (const file of files) {
      uploaded++;
      const pct = Math.round((uploaded / total) * 100);
      if (msgEl) {
        const src = file.source === 'zip' ? ` (from ${file.zipName})` : '';
        msgEl.textContent = `${uploaded} / ${total}: ${file.name}${src}`;
      }
      if (bar) bar.style.width = pct + '%';

      try {
        await printStation.slicer.bulkUploadOne({
          filePath: file.filePath,
          name: file.name,
          category
        });
      } catch (err) {
        failed++;
        errors.push(`${file.name}: ${err.message}`);
        console.warn('[Slicer] Bulk upload failed for', file.name, err.message);
      }
    }

    slicerHideProgress();

    // Refresh catalog
    await slicerLoadCatalog();
    await slicerLoadCategories();

    const successCount = total - failed;
    let msg = `Imported ${successCount} of ${total} STL files.`;
    if (failed > 0) {
      msg += `\n\n${failed} failed:\n` + errors.slice(0, 10).join('\n');
      if (errors.length > 10) msg += `\n...and ${errors.length - 10} more`;
    }
    alert(msg);
  } catch (err) {
    slicerHideProgress();
    console.error('[Slicer] Bulk import error:', err);
    alert('Bulk import failed: ' + err.message);
  }
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
    supports: 'slicerSupports',
    material: 'slicerMaterial'
  };

  // Map preset category to DOM element
  const presetToField = {
    quality: 'quality',
    strength: 'strength',
    speed: 'speed',
    texture: 'texture',
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
    return;
  }

  const printer = slicerState.printers.find(p => String(p.id) === String(printerId));
  if (!printer || !printer.has_multicolor) {
    slotGroup.style.display = 'none';
    return;
  }

  let aceSlots = [];
  try { aceSlots = printer.ace_slots ? JSON.parse(printer.ace_slots) : []; } catch (_) {}

  if (!aceSlots.length) {
    slotGroup.style.display = 'none';
    return;
  }

  slotGroup.style.display = '';
  slotSelect.innerHTML = '<option value="">Select filament slot...</option>' +
    aceSlots.map(s => {
      const label = `T${s.slot}: ${s.name || s.material || '?'}${s.color ? ' (' + s.color + ')' : ''}`;
      return `<option value="${s.slot}">${slicerEsc(label)}</option>`;
    }).join('');
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
  if (printerId) {
    const printer = slicerState.printers.find(p => String(p.id) === String(printerId));
    if (printer && printer.model) {
      // Map printer model name to slicer key
      printerModel = slicerMapPrinterModel(printer.model);
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
    supports: slicerState.settings.supports
  };

  slicerShowProgress(
    andPrint ? 'Slicing & Printing...' : 'Slicing...',
    'PrusaSlicer is processing your model on the server'
  );

  // Read ACE slot if visible
  const aceSlotVal = document.getElementById('slicerAceSlot')?.value;
  const aceSlot = (aceSlotVal !== '' && aceSlotVal != null) ? parseInt(aceSlotVal, 10) : null;

  try {
    let result;
    if (andPrint) {
      result = await printStation.slicer.sliceAndPrint(sliceOptions, parseInt(printerId, 10), aceSlot);
    } else {
      result = await printStation.slicer.slice(sliceOptions);
    }

    slicerHideProgress();

    // Refresh G-code list
    const updated = await printStation.slicer.getCatalogItem(item.id);
    if (updated) {
      slicerState.gcodeEntries = updated.gcodeEntries || [];
      slicerRenderGcodeList(slicerState.gcodeEntries);
    }

    if (andPrint && result.success) {
      alert(`Print started! Job #${result.job?.id || ''}`);
    } else if (!andPrint) {
      const cached = result.cached ? ' (cache hit)' : '';
      alert(`Slicing complete${cached}! G-code: ${result.gcode_filename || 'ready'}`);
    }
  } catch (err) {
    slicerHideProgress();
    console.error('[Slicer] Slice error:', err);
    alert('Slicing failed: ' + err.message);
  }
}

async function slicerPrintExistingGcode(gcodeId) {
  const printerId = document.getElementById('slicerPrinter')?.value;
  if (!printerId) return alert('Please select a printer first');

  const aceSlotVal = document.getElementById('slicerAceSlot')?.value;
  const aceSlot = (aceSlotVal !== '' && aceSlotVal != null) ? parseInt(aceSlotVal, 10) : null;

  slicerShowProgress('Printing...', 'Downloading G-code and sending to printer');

  try {
    const result = await printStation.slicer.printGcode(gcodeId, parseInt(printerId, 10), aceSlot);
    slicerHideProgress();

    if (result.success) {
      alert(`Print started! Job #${result.job?.id || ''}`);
    }
  } catch (err) {
    slicerHideProgress();
    console.error('[Slicer] Print existing G-code error:', err);
    alert('Print failed: ' + err.message);
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
// 3D PREVIEW — THUMBNAILS + VIEWER
// ============================================================================

/**
 * Fetch STL bytes (from cache or server), returns ArrayBuffer
 */
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
