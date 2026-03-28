// =============== NEW Stickers View (Redesigned) ===============
const stickersState = {
  mode: 'order', // 'order' or 'manual'
  categories: [],
  stickers: [],
  filteredStickers: [],
  selection: new Map(), // Map of imagePath -> { ...sticker, quantity }
  gridInfo: null,
  currentOrderNumber: null,
  savedOrders: [],
  generatedSheets: null, // Last generated sheets info for print/cut
  cutSettings: {
    depth: 6,
    speed: 4,
    pressure: 15,
    offset: 8.5
  },
  initialized: false
};

async function initStickersView() {
  if (!stickersState.initialized) {
    stickersState.initialized = true;
    setupStickersEventListeners();
    await loadStickersCutSettings();
  }

  // Load categories for manual mode
  await loadStickersCategories();
  await updateStickersGridInfo();

  // Load saved orders for order mode
  await loadSavedOrders();
}

function setupStickersEventListeners() {
  // Mode toggle buttons
  const modeOrderBtn = document.getElementById('stickersModeOrder');
  const modeManualBtn = document.getElementById('stickersModeManual');

  if (modeOrderBtn) {
    modeOrderBtn.addEventListener('click', () => switchStickersMode('order'));
  }
  if (modeManualBtn) {
    modeManualBtn.addEventListener('click', () => switchStickersMode('manual'));
  }

  // Layout mode button
  const modeLayoutBtn = document.getElementById('stickersModeLayout');
  if (modeLayoutBtn) {
    modeLayoutBtn.addEventListener('click', () => switchStickersMode('layout'));
  }

  // Order Mode: Import order
  const importOrderBtn = document.getElementById('stickersImportOrderBtn');
  if (importOrderBtn) {
    importOrderBtn.addEventListener('click', importStickersOrder);
  }

  // Order Mode: Refresh saved orders
  const refreshSavedBtn = document.getElementById('stickersRefreshSavedBtn');
  if (refreshSavedBtn) {
    refreshSavedBtn.addEventListener('click', loadSavedOrders);
  }

  // Order Mode: Search saved orders
  const savedSearch = document.getElementById('stickersSavedSearch');
  if (savedSearch) {
    savedSearch.addEventListener('input', debounce(filterSavedOrders, 300));
  }

  // Manual Mode: Google Drive Sync
  const gdriveSyncBtn = document.getElementById('stickersGdriveSyncBtn');
  if (gdriveSyncBtn) {
    gdriveSyncBtn.addEventListener('click', stickersGdriveSync);
  }

  // Manual Mode: Category filter
  const categorySelect = document.getElementById('stickersCategorySelect');
  if (categorySelect) {
    categorySelect.addEventListener('change', () => loadStickersCatalog(categorySelect.value));
  }

  // Manual Mode: Search
  const searchInput = document.getElementById('stickersSearch');
  if (searchInput) {
    searchInput.addEventListener('input', debounce(filterStickersCatalog, 300));
  }

  // Manual Mode: Size change
  const sizeInput = document.getElementById('stickersManualSize');
  if (sizeInput) {
    sizeInput.addEventListener('change', updateStickersGridInfo);
  }

  // Manual Mode: Select all
  const selectAllBtn = document.getElementById('stickersSelectAllBtn');
  if (selectAllBtn) {
    selectAllBtn.addEventListener('click', selectAllVisibleStickersNew);
  }

  // Clear selection
  const clearBtn = document.getElementById('stickersClearBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', clearStickersSelection);
  }

  // Generate sheets
  const generateBtn = document.getElementById('stickersGenerateBtn');
  if (generateBtn) {
    generateBtn.addEventListener('click', generateStickersSheets);
  }

  // View sheets
  const viewSheetsBtn = document.getElementById('stickersViewSheetsBtn');
  if (viewSheetsBtn) {
    viewSheetsBtn.addEventListener('click', openStickerSheetsBrowser);
  }

  // Print button
  const printBtn = document.getElementById('stickersPrintBtn');
  if (printBtn) {
    printBtn.addEventListener('click', printStickersSheet);
  }

  // Send to Cameo button
  const sendCameoBtn = document.getElementById('stickersSendCameoBtn');
  if (sendCameoBtn) {
    sendCameoBtn.addEventListener('click', sendStickersToCameo);
  }

  // Cut settings save
  const saveCutSettingsBtn = document.getElementById('stickersSaveCutSettings');
  if (saveCutSettingsBtn) {
    saveCutSettingsBtn.addEventListener('click', saveStickersCutSettings);
  }
}

function switchStickersMode(mode) {
  stickersState.mode = mode;

  // Update toggle buttons
  const orderBtn = document.getElementById('stickersModeOrder');
  const manualBtn = document.getElementById('stickersModeManual');
  const layoutBtn = document.getElementById('stickersModeLayout');
  const orderPanel = document.getElementById('stickersOrderPanel');
  const manualPanel = document.getElementById('stickersManualPanel');
  const layoutPanel = document.getElementById('layoutEditorPanel');
  const currentOrderCard = document.getElementById('stickersCurrentOrder');

  // Layout mode side panels
  const layoutAvailablePanel = document.getElementById('layoutAvailableStickerPanel');
  const layoutGeneratePanel = document.getElementById('layoutGeneratePanel');

  // Standard side panels (show/hide based on mode)
  const selectionSummary = document.querySelector('.stickers-side-panel > .inventory-card:nth-child(3)'); // Selection Summary
  const cutSettings = document.querySelector('.stickers-side-panel > .inventory-card:nth-child(4)'); // Cut Settings
  const actionButtons = document.querySelector('.stickers-side-panel > .inventory-card:nth-child(5)'); // Action Buttons
  const selectedItems = document.getElementById('stickersSelectionList')?.parentElement; // Selected Items

  // Reset all buttons
  [orderBtn, manualBtn, layoutBtn].forEach(btn => {
    if (btn) {
      btn.classList.remove('active');
      btn.style.background = 'var(--card)';
      btn.style.color = 'var(--text)';
    }
  });

  // Hide all panels
  if (orderPanel) orderPanel.style.display = 'none';
  if (manualPanel) manualPanel.style.display = 'none';
  if (layoutPanel) layoutPanel.style.display = 'none';
  if (currentOrderCard) currentOrderCard.style.display = 'none';
  if (layoutAvailablePanel) layoutAvailablePanel.style.display = 'none';
  if (layoutGeneratePanel) layoutGeneratePanel.style.display = 'none';

  if (mode === 'order') {
    if (orderBtn) {
      orderBtn.classList.add('active');
      orderBtn.style.background = 'var(--primary)';
      orderBtn.style.color = 'white';
    }
    if (orderPanel) orderPanel.style.display = 'flex';
    if (currentOrderCard && stickersState.currentOrderNumber) {
      currentOrderCard.style.display = 'block';
    }
    // Show standard side panels
    showStandardSidePanels(true);
  } else if (mode === 'manual') {
    if (manualBtn) {
      manualBtn.classList.add('active');
      manualBtn.style.background = 'var(--primary)';
      manualBtn.style.color = 'white';
    }
    if (manualPanel) manualPanel.style.display = 'flex';
    // Show standard side panels
    showStandardSidePanels(true);
    // Load catalog if not already loaded
    if (stickersState.stickers.length === 0) {
      loadStickersCatalog();
    }
  } else if (mode === 'layout') {
    if (layoutBtn) {
      layoutBtn.classList.add('active');
      layoutBtn.style.background = 'var(--primary)';
      layoutBtn.style.color = 'white';
    }
    if (layoutPanel) layoutPanel.style.display = 'flex';
    if (layoutAvailablePanel) layoutAvailablePanel.style.display = 'flex';
    if (layoutGeneratePanel) layoutGeneratePanel.style.display = 'block';
    // Hide standard side panels in layout mode
    showStandardSidePanels(false);

    // Initialize layout editor and populate available stickers
    if (typeof initLayoutEditor === 'function') {
      initLayoutEditor();
    }
    if (typeof populateLayoutAvailableStickers === 'function') {
      const stickersArray = Array.from(stickersState.selection.values());
      populateLayoutAvailableStickers(stickersArray);
    }
    // Don't clear selection when entering layout mode
    return;
  }

  // Clear selection when switching modes (except layout)
  clearStickersSelection();
}

// Helper to show/hide standard side panels
function showStandardSidePanels(show) {
  const panels = document.querySelectorAll('.stickers-side-panel > .inventory-card');
  panels.forEach((panel, index) => {
    // Skip layout-specific panels (first two children when added)
    if (panel.id === 'layoutAvailableStickerPanel' || panel.id === 'layoutGeneratePanel') {
      return;
    }
    // Show/hide based on mode
    if (panel.id !== 'stickersOutputInfo') { // Keep output info controlled separately
      // Don't hide if it's the output info or current order card
      if (panel.id !== 'stickersCurrentOrder') {
        panel.style.display = show ? '' : 'none';
      }
    }
  });
}

async function stickersGdriveSync() {
  const btn = document.getElementById('stickersGdriveSyncBtn');
  if (btn) { btn.disabled = true; btn.textContent = '☁ Syncing...'; }
  try {
    const result = await printStation.stickerSheets.gdriveSync();
    if (result?.success && result.added > 0) {
      const toast = typeof showToast === 'function' ? showToast : (msg) => alert(msg);
      toast(`Google Drive sync: ${result.added} graphic${result.added !== 1 ? 's' : ''} across ${result.categories} categories`, 'success', 4000);
      await loadStickersCategories();
      await loadStickersCatalog();
    } else {
      const toast = typeof showToast === 'function' ? showToast : (msg) => alert(msg);
      toast('Google Drive sync: no new graphics found', 'info', 3000);
    }
  } catch (err) {
    console.error('[Stickers] GDrive sync error:', err);
    const toast = typeof showToast === 'function' ? showToast : (msg) => alert(msg);
    toast('Google Drive sync failed: ' + err.message, 'error', 6000);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '☁ Sync Google Drive'; }
  }
}

async function loadStickersCategories() {
  try {
    const result = await printStation.stickerSheets.getCategories();
    if (result?.success && result.categories) {
      stickersState.categories = result.categories;

      const select = document.getElementById('stickersCategorySelect');
      if (select) {
        select.innerHTML = '<option value="">All Categories</option>' +
          result.categories.map(cat => `<option value="${cat}">${cat}</option>`).join('');
      }
    }
  } catch (err) {
    console.error('Failed to load sticker categories:', err);
  }
}

async function loadStickersCatalog(category = null) {
  const grid = document.getElementById('stickersCatalogGrid');
  if (grid) {
    grid.innerHTML = '<div class="placeholder" style="grid-column:1/-1;text-align:center;padding:40px;">Loading stickers...</div>';
  }

  try {
    const result = await printStation.stickerSheets.getCatalog(category || undefined);
    if (result?.success && result.stickers) {
      stickersState.stickers = result.stickers;
      stickersState.filteredStickers = result.stickers;
      renderStickersCatalog();
    }
  } catch (err) {
    console.error('Failed to load sticker catalog:', err);
    if (grid) {
      grid.innerHTML = '<div class="placeholder" style="grid-column:1/-1;text-align:center;padding:40px;color:#f44;">Error loading stickers</div>';
    }
  }
}

function filterStickersCatalog() {
  const searchInput = document.getElementById('stickersSearch');
  const query = (searchInput?.value || '').toLowerCase().trim();

  if (!query) {
    stickersState.filteredStickers = stickersState.stickers;
  } else {
    stickersState.filteredStickers = stickersState.stickers.filter(s =>
      s.title.toLowerCase().includes(query) ||
      s.category.toLowerCase().includes(query) ||
      s.filename.toLowerCase().includes(query)
    );
  }

  renderStickersCatalog();
}

function renderStickersCatalog() {
  const grid = document.getElementById('stickersCatalogGrid');
  if (!grid) return;

  if (stickersState.filteredStickers.length === 0) {
    grid.innerHTML = '<div class="placeholder" style="grid-column:1/-1;text-align:center;padding:40px;">No stickers found</div>';
    return;
  }

  grid.innerHTML = stickersState.filteredStickers.map(sticker => {
    const isSelected = stickersState.selection.has(sticker.imagePath);
    const selectedClass = isSelected ? 'selected' : '';
    // Use resolveAssetUrl which handles absolute URLs, relative URLs, and file paths
    const thumbnailSrc = sticker.thumbnailUrl
      ? resolveAssetUrl(sticker.thumbnailUrl)
      : resolveAssetUrl(sticker.imagePath);

    return `
      <div class="sticker-card ${selectedClass}"
           data-path="${sticker.imagePath}"
           onclick="toggleStickersSelection('${sticker.imagePath.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')"
           title="${sticker.title}\n${sticker.category}">
        <div class="sticker-thumb" style="background-image:url('${thumbnailSrc}');background-size:contain;background-position:center;background-repeat:no-repeat;aspect-ratio:1;"></div>
        <div class="sticker-title" style="font-size:10px;padding:4px;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
          ${sticker.title}
        </div>
        ${sticker.gdrive ? '<div style="position:absolute;bottom:4px;left:4px;background:#2563eb;color:#fff;font-size:9px;padding:1px 5px;border-radius:4px;">☁</div>' : ''}
        ${isSelected ? `<div class="sticker-selected-badge" style="position:absolute;top:4px;right:4px;background:#4ade80;color:#000;font-size:10px;padding:2px 6px;border-radius:10px;">x${stickersState.selection.get(sticker.imagePath).quantity}</div>` : ''}
      </div>
    `;
  }).join('');
}

function toggleStickersSelection(imagePath) {
  if (stickersState.selection.has(imagePath)) {
    const item = stickersState.selection.get(imagePath);
    item.quantity++;
  } else {
    const sticker = stickersState.stickers.find(s => s.imagePath === imagePath);
    if (sticker) {
      stickersState.selection.set(imagePath, { ...sticker, quantity: 1 });
    }
  }

  updateStickersSelectionUI();
  renderStickersCatalog();
}

function removeStickersItem(imagePath) {
  stickersState.selection.delete(imagePath);
  updateStickersSelectionUI();
  renderStickersCatalog();
}

function updateStickersQuantity(imagePath, delta) {
  const item = stickersState.selection.get(imagePath);
  if (!item) return;

  item.quantity = Math.max(1, item.quantity + delta);
  updateStickersSelectionUI();
  renderStickersCatalog();
}

function selectAllVisibleStickersNew() {
  for (const sticker of stickersState.filteredStickers) {
    if (!stickersState.selection.has(sticker.imagePath)) {
      stickersState.selection.set(sticker.imagePath, { ...sticker, quantity: 1 });
    }
  }
  updateStickersSelectionUI();
  renderStickersCatalog();
}

function clearStickersSelection() {
  stickersState.selection.clear();
  stickersState.currentOrderNumber = null;
  stickersState.generatedSheets = null;

  const currentOrderCard = document.getElementById('stickersCurrentOrder');
  if (currentOrderCard) currentOrderCard.style.display = 'none';

  const outputInfo = document.getElementById('stickersOutputInfo');
  if (outputInfo) outputInfo.style.display = 'none';

  const printBtn = document.getElementById('stickersPrintBtn');
  const cameoBtn = document.getElementById('stickersSendCameoBtn');
  if (printBtn) printBtn.disabled = true;
  if (cameoBtn) cameoBtn.disabled = true;

  updateStickersSelectionUI();
  renderStickersCatalog();
}

function updateStickersSelectionUI() {
  const countEl = document.getElementById('stickersSelectionCount');
  const sheetsEl = document.getElementById('stickersSheetsNeeded');
  const perSheetEl = document.getElementById('stickersPerSheet');
  const generateBtn = document.getElementById('stickersGenerateBtn');
  const listEl = document.getElementById('stickersSelectionList');

  // Count total stickers
  let totalCount = 0;
  for (const item of stickersState.selection.values()) {
    totalCount += item.quantity;
  }

  // Calculate sheets needed
  const capacity = stickersState.gridInfo?.capacity || 6;
  const sheetsNeeded = Math.ceil(totalCount / capacity);

  if (countEl) countEl.textContent = totalCount;
  if (sheetsEl) sheetsEl.textContent = sheetsNeeded;
  if (perSheetEl) perSheetEl.textContent = `~${capacity}`;

  if (generateBtn) {
    generateBtn.disabled = totalCount === 0;
    generateBtn.textContent = `Generate Sheets (${totalCount})`;
  }

  // Render selection list
  if (listEl) {
    if (stickersState.selection.size === 0) {
      listEl.innerHTML = '<div class="placeholder" style="text-align:center;padding:20px;color:#888;">No stickers selected</div>';
    } else {
      listEl.innerHTML = Array.from(stickersState.selection.values()).map(item => {
        // Use resolveAssetUrl which handles absolute URLs, relative URLs, and file paths
        const thumbSrc = item.thumbnailUrl ? resolveAssetUrl(item.thumbnailUrl) : resolveAssetUrl(item.imagePath);
        return `
        <div class="selection-item" style="display:flex;align-items:center;gap:8px;padding:6px;border-bottom:1px solid rgba(255,255,255,0.1);">
          <div style="width:40px;height:40px;background-image:url('${thumbSrc}');background-size:contain;background-position:center;background-repeat:no-repeat;flex-shrink:0;"></div>
          <div style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;">${item.title}</div>
          <div style="display:flex;align-items:center;gap:4px;">
            <button onclick="updateStickersQuantity('${item.imagePath.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}', -1)" style="width:24px;height:24px;padding:0;font-size:14px;">-</button>
            <span style="min-width:20px;text-align:center;">${item.quantity}</span>
            <button onclick="updateStickersQuantity('${item.imagePath.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}', 1)" style="width:24px;height:24px;padding:0;font-size:14px;">+</button>
            <button onclick="removeStickersItem('${item.imagePath.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')" style="width:24px;height:24px;padding:0;font-size:12px;color:#f44;">&times;</button>
          </div>
        </div>
      `}).join('');
    }
  }
}

async function updateStickersGridInfo() {
  // For order mode, always use 3 inches
  // For manual mode, use the input value
  let size = 3;
  if (stickersState.mode === 'manual') {
    const sizeInput = document.getElementById('stickersManualSize');
    size = parseFloat(sizeInput?.value || 3);
  }

  try {
    const result = await printStation.stickerSheets.getGridInfo(size);
    if (result?.success && result.grid) {
      stickersState.gridInfo = result.grid;

      const infoEl = document.getElementById('stickersGridInfo');
      if (infoEl) {
        infoEl.textContent = `Grid: ${result.grid.cols}x${result.grid.rows} (${result.grid.capacity} stickers per sheet) | Sheet: ${result.grid.sheetWidthInches}" x ${result.grid.sheetHeightInches}"`;
      }

      updateStickersSelectionUI();
    }
  } catch (err) {
    console.error('Failed to get grid info:', err);
  }
}

async function importStickersOrder() {
  const orderIdInput = document.getElementById('stickersOrderId');
  const infoEl = document.getElementById('stickersOrderInfo');
  const importBtn = document.getElementById('stickersImportOrderBtn');

  const orderId = orderIdInput?.value?.trim();
  if (!orderId) {
    if (infoEl) infoEl.textContent = 'Please enter an order #';
    return;
  }

  if (importBtn) {
    importBtn.disabled = true;
    importBtn.textContent = 'Importing...';
  }
  if (infoEl) infoEl.textContent = 'Fetching order from Shopify...';

  try {
    const result = await printStation.stickerSheets.fromOrder({
      orderId,
      stickerSizeInches: 3, // Always 3 for orders
      offsetMm: stickersState.cutSettings.offset,
      saveByOrder: true // Save to order folder
    });

    if (result?.success) {
      stickersState.generatedSheets = result;
      stickersState.currentOrderNumber = result.orderNumber || orderId.replace('#', '');

      // Show current order card
      const currentOrderCard = document.getElementById('stickersCurrentOrder');
      const orderNumberEl = document.getElementById('stickersOrderNumber');
      if (currentOrderCard) currentOrderCard.style.display = 'block';
      if (orderNumberEl) orderNumberEl.textContent = stickersState.currentOrderNumber;

      if (infoEl) {
        infoEl.innerHTML = `<span style="color:#4ade80;">Order #${stickersState.currentOrderNumber}: Generated ${result.totalSheets} sheet(s) with ${result.totalStickers} stickers</span>`;
        if (result.notFound?.length) {
          infoEl.innerHTML += `<br><span style="color:#f90;">Warning: ${result.notFound.length} items not found in catalog</span>`;
        }
      }

      // Show output info
      showStickersOutput(result);

      // Enable print/cut buttons
      const printBtn = document.getElementById('stickersPrintBtn');
      const cameoBtn = document.getElementById('stickersSendCameoBtn');
      if (printBtn) printBtn.disabled = false;
      if (cameoBtn) cameoBtn.disabled = false;

      // Refresh saved orders list
      await loadSavedOrders();
    } else {
      if (infoEl) infoEl.innerHTML = `<span style="color:#f44;">Error: ${result?.error || 'Unknown error'}</span>`;
    }
  } catch (err) {
    console.error('Failed to import order:', err);
    if (infoEl) infoEl.innerHTML = `<span style="color:#f44;">Error: ${err.message}</span>`;
  } finally {
    if (importBtn) {
      importBtn.disabled = false;
      importBtn.textContent = 'Import Order';
    }
  }
}

async function generateStickersSheets() {
  const generateBtn = document.getElementById('stickersGenerateBtn');
  const statusEl = document.getElementById('stickersStatus');

  if (stickersState.selection.size === 0) return;

  // Get size based on mode
  let size = 3;
  if (stickersState.mode === 'manual') {
    const sizeInput = document.getElementById('stickersManualSize');
    size = parseFloat(sizeInput?.value || 3);
  }

  // Prepare designs array
  const designs = Array.from(stickersState.selection.values()).map(item => ({
    imagePath: item.imagePath,
    quantity: item.quantity,
    title: item.title
  }));

  if (generateBtn) {
    generateBtn.disabled = true;
    generateBtn.textContent = 'Generating...';
  }
  if (statusEl) statusEl.textContent = 'Generating sheets...';

  try {
    const payload = {
      designs,
      stickerSizeInches: size,
      offsetMm: stickersState.cutSettings.offset,
      filenamePrefix: stickersState.mode === 'order' && stickersState.currentOrderNumber
        ? `order-${stickersState.currentOrderNumber}`
        : 'sticker-sheet',
      scaleByLargestDimension: stickersState.mode === 'manual', // New flag
      useRotationPacking: true // Enable rotation-aware packing
    };

    // If order mode with order number, save to order folder
    if (stickersState.mode === 'order' && stickersState.currentOrderNumber) {
      payload.orderNumber = stickersState.currentOrderNumber;
    }

    const result = await printStation.stickerSheets.generate(payload);

    if (result?.success) {
      stickersState.generatedSheets = result;

      if (statusEl) statusEl.textContent = `Generated ${result.totalSheets} sheet(s)`;

      showStickersOutput(result);

      // Enable print/cut buttons
      const printBtn = document.getElementById('stickersPrintBtn');
      const cameoBtn = document.getElementById('stickersSendCameoBtn');
      if (printBtn) printBtn.disabled = false;
      if (cameoBtn) cameoBtn.disabled = false;
    } else {
      if (statusEl) statusEl.textContent = `Error: ${result?.error || 'Unknown error'}`;
    }
  } catch (err) {
    console.error('Failed to generate sheets:', err);
    if (statusEl) statusEl.textContent = `Error: ${err.message}`;
  } finally {
    if (generateBtn) {
      generateBtn.disabled = false;
      let count = 0;
      for (const item of stickersState.selection.values()) count += item.quantity;
      generateBtn.textContent = `Generate Sheets (${count})`;
    }
  }
}

function showStickersOutput(result) {
  const outputInfo = document.getElementById('stickersOutputInfo');
  const outputDetails = document.getElementById('stickersOutputDetails');

  if (outputInfo) outputInfo.style.display = 'block';
  if (outputDetails) {
    outputDetails.innerHTML = `
      <div>Total Stickers: <strong>${result.totalStickers}</strong></div>
      <div>Sheets Generated: <strong>${result.totalSheets}</strong></div>
      ${result.orderNumber ? `<div>Saved to: Order #${result.orderNumber}</div>` : ''}
      <div style="margin-top:8px;font-size:10px;color:#888;">${result.outputDir || ''}</div>
    `;
  }
}

async function loadSavedOrders() {
  const listEl = document.getElementById('stickersSavedOrdersList');
  if (!listEl) return;

  listEl.innerHTML = '<div class="placeholder" style="text-align:center;padding:20px;color:#888;">Loading...</div>';

  try {
    const result = await printStation.stickerSheets.listSavedOrders();

    if (result?.success && result.orders?.length > 0) {
      stickersState.savedOrders = result.orders;
      renderSavedOrders();
    } else {
      stickersState.savedOrders = [];
      listEl.innerHTML = '<div class="placeholder" style="text-align:center;padding:30px;color:#888;">No saved order sheets yet</div>';
    }
  } catch (err) {
    console.error('Failed to load saved orders:', err);
    listEl.innerHTML = '<div class="placeholder" style="text-align:center;padding:30px;color:#f44;">Error loading saved orders</div>';
  }
}

function filterSavedOrders() {
  renderSavedOrders();
}

function renderSavedOrders() {
  const listEl = document.getElementById('stickersSavedOrdersList');
  const searchInput = document.getElementById('stickersSavedSearch');
  if (!listEl) return;

  const query = (searchInput?.value || '').toLowerCase().trim();
  const filtered = query
    ? stickersState.savedOrders.filter(o => o.orderNumber.toLowerCase().includes(query))
    : stickersState.savedOrders;

  if (filtered.length === 0) {
    listEl.innerHTML = '<div class="placeholder" style="text-align:center;padding:30px;color:#888;">No matching orders found</div>';
    return;
  }

  // Use blueridgecustomco.com for static library assets (served directly by nginx)
  const serverUrl = 'https://blueridgecustomco.com';

  listEl.innerHTML = filtered.map(order => `
    <div class="saved-order-item" style="border:1px solid var(--border);border-radius:6px;margin-bottom:8px;overflow:hidden;">
      <div style="padding:10px;background:var(--card);display:flex;justify-content:space-between;align-items:center;">
        <div>
          <strong style="color:#38bdf8;">Order #${order.orderNumber}</strong>
          <div style="font-size:11px;color:#888;">${order.sheetCount} sheet(s) - ${order.createdAt}</div>
        </div>
        <div style="display:flex;gap:6px;">
          <button class="secondary" style="font-size:11px;padding:4px 8px;" onclick="loadSavedOrderSheets('${order.orderNumber}')">View</button>
          <button class="primary" style="font-size:11px;padding:4px 8px;" onclick="reprintSavedOrder('${order.orderNumber}')">Print</button>
        </div>
      </div>
    </div>
  `).join('');
}

async function loadSavedOrderSheets(orderNumber) {
  try {
    const result = await printStation.stickerSheets.getOrderSheets(orderNumber);
    if (result?.success && result.sheets) {
      stickersState.generatedSheets = result;
      stickersState.currentOrderNumber = orderNumber;

      // Show current order card
      const currentOrderCard = document.getElementById('stickersCurrentOrder');
      const orderNumberEl = document.getElementById('stickersOrderNumber');
      if (currentOrderCard) currentOrderCard.style.display = 'block';
      if (orderNumberEl) orderNumberEl.textContent = orderNumber;

      showStickersOutput(result);

      // Enable print/cut buttons
      const printBtn = document.getElementById('stickersPrintBtn');
      const cameoBtn = document.getElementById('stickersSendCameoBtn');
      if (printBtn) printBtn.disabled = false;
      if (cameoBtn) cameoBtn.disabled = false;

      showToast(`Loaded sheets for Order #${orderNumber}`, 'success');
    }
  } catch (err) {
    console.error('Failed to load order sheets:', err);
    showToast('Failed to load order sheets', 'error');
  }
}

async function reprintSavedOrder(orderNumber) {
  await loadSavedOrderSheets(orderNumber);
  printStickersSheet();
}

// Cut Settings
function toggleCutSettings() {
  const panel = document.getElementById('stickersCutSettingsPanel');
  const toggle = document.getElementById('stickersCutSettingsToggle');

  if (panel.style.display === 'none') {
    panel.style.display = 'block';
    toggle.textContent = '- Collapse';
  } else {
    panel.style.display = 'none';
    toggle.textContent = '+ Expand';
  }
}

async function loadStickersCutSettings() {
  try {
    const config = await printStation.getConfig();
    if (config?.stickersCutSettings) {
      stickersState.cutSettings = { ...stickersState.cutSettings, ...config.stickersCutSettings };

      // Update UI
      const depthInput = document.getElementById('stickersCutDepth');
      const speedInput = document.getElementById('stickersCutSpeed');
      const pressureInput = document.getElementById('stickersCutPressure');
      const offsetInput = document.getElementById('stickersCutOffset');

      if (depthInput) depthInput.value = stickersState.cutSettings.depth;
      if (speedInput) speedInput.value = stickersState.cutSettings.speed;
      if (pressureInput) pressureInput.value = stickersState.cutSettings.pressure;
      if (offsetInput) offsetInput.value = stickersState.cutSettings.offset;
    }
  } catch (err) {
    console.error('Failed to load cut settings:', err);
  }
}

async function saveStickersCutSettings() {
  const depthInput = document.getElementById('stickersCutDepth');
  const speedInput = document.getElementById('stickersCutSpeed');
  const pressureInput = document.getElementById('stickersCutPressure');
  const offsetInput = document.getElementById('stickersCutOffset');

  stickersState.cutSettings = {
    depth: parseInt(depthInput?.value || 6),
    speed: parseInt(speedInput?.value || 4),
    pressure: parseInt(pressureInput?.value || 15),
    offset: parseFloat(offsetInput?.value || 8.5)
  };

  try {
    await printStation.saveConfig({ stickersCutSettings: stickersState.cutSettings });
    showToast('Cut settings saved', 'success');
  } catch (err) {
    console.error('Failed to save cut settings:', err);
    showToast('Failed to save settings', 'error');
  }
}

// Print and Cameo functions
async function printStickersSheet() {
  if (!stickersState.generatedSheets?.sheets?.length) {
    showToast('No sheets to print. Generate sheets first.', 'error');
    return;
  }

  const statusEl = document.getElementById('stickersStatus');
  if (statusEl) statusEl.textContent = 'Opening print dialog...';

  try {
    const serverUrl = 'https://blueridgecustomco.com';
    const sheets = stickersState.generatedSheets.sheets;

    // Build array of print URLs
    const imageUrls = sheets.map(sheet => `${serverUrl}${sheet.printUrl}`);

    // Use Electron's native print dialog via IPC
    const result = await printStation.printer.printWithDialog({ imageUrls });

    if (result.success) {
      if (statusEl) statusEl.textContent = `Printed ${sheets.length} sheet(s)`;
      showToast('Print job sent!', 'success');
    } else {
      if (statusEl) statusEl.textContent = 'Print cancelled';
      showToast(result.error || 'Print cancelled', 'warning');
    }
  } catch (err) {
    console.error('Failed to print:', err);
    if (statusEl) statusEl.textContent = 'Print error';
    showToast('Failed to print: ' + err.message, 'error');
  }
}

async function sendStickersToCameo() {
  if (!stickersState.generatedSheets?.sheets?.length) {
    showToast('No sheets to cut. Generate sheets first.', 'error');
    return;
  }

  // Check if any sheets have cut URLs
  const sheetsWithCut = stickersState.generatedSheets.sheets.filter(s => s.cutUrl);
  if (sheetsWithCut.length === 0) {
    showToast('No cut files found for these sheets.', 'error');
    return;
  }

  const statusEl = document.getElementById('stickersStatus');
  if (statusEl) statusEl.textContent = 'Downloading cut files...';
  showToast(`Downloading ${sheetsWithCut.length} cut file(s)...`, 'info');

  try {
    const serverUrl = 'https://blueridgecustomco.com';

    // Download each cut SVG file and open with Silhouette Studio
    for (let i = 0; i < sheetsWithCut.length; i++) {
      const sheet = sheetsWithCut[i];
      const cutUrl = `${serverUrl}${sheet.cutUrl}`;

      console.log(`[Cameo] Processing sheet ${i + 1}/${sheetsWithCut.length}:`, cutUrl);

      if (statusEl) statusEl.textContent = `Opening cut file ${i + 1}/${sheetsWithCut.length}...`;

      // Use the local Cameo handler which downloads and opens in Silhouette Studio
      const result = await printStation.cameo.openCutFile({
        url: cutUrl,
        cutSettings: stickersState.cutSettings
      });

      if (!result?.success) {
        throw new Error(result?.error || `Failed to open cut file ${i + 1}`);
      }

      // Small delay between files
      if (i < sheetsWithCut.length - 1) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    if (statusEl) statusEl.textContent = `Opened ${sheetsWithCut.length} cut file(s) in Silhouette Studio`;
    showToast(`Opened ${sheetsWithCut.length} cut file(s) in Silhouette Studio!`, 'success');

  } catch (err) {
    console.error('Failed to send to Cameo:', err);
    if (statusEl) statusEl.textContent = 'Cameo error';
    showToast('Cameo error: ' + err.message, 'error');
  }
}

// Global exports for onclick handlers
window.toggleStickersSelection = toggleStickersSelection;
window.removeStickersItem = removeStickersItem;
window.updateStickersQuantity = updateStickersQuantity;
window.toggleCutSettings = toggleCutSettings;
window.loadSavedOrderSheets = loadSavedOrderSheets;
window.reprintSavedOrder = reprintSavedOrder;

// Export state and functions for layout editor integration
window.stickersState = stickersState;
window.showStickersOutput = showStickersOutput;
