/**
 * Build Plate Manager View
 * Visual editor for managing 3D print build plates with part picker,
 * 2D bed visualization, and print queue integration.
 */
(function () {
  'use strict';

  const MU_MM = 40; // multiboard unit in mm
  const BED_SIZES = {
    kobra3: { w: 220, h: 220 },
    ke: { w: 220, h: 220 },
    s1pro: { w: 256, h: 256 }
  };

  // State
  const bpState = {
    plates: [],               // All product build plates
    currentPlateId: null,
    currentPlateItems: [],    // Parsed items array for current plate
    catalog: [],              // Multiboard STL parts
    printers: [],             // Available printers
    bedSize: { w: 220, h: 220 },
    selectedPrinterModel: 'kobra3'
  };

  // DOM cache
  const el = {};

  function cacheElements() {
    el.productFilter = document.getElementById('bpProductFilter');
    el.newPlateBtn = document.getElementById('bpNewPlateBtn');
    el.refreshBtn = document.getElementById('bpRefreshBtn');
    el.plateList = document.getElementById('bpPlateList');
    el.emptyState = document.getElementById('bpEmptyState');
    el.editorContent = document.getElementById('bpEditorContent');
    el.plateName = document.getElementById('bpPlateName');
    el.plateMaterial = document.getElementById('bpPlateMaterial');
    el.platePrinter = document.getElementById('bpPlatePrinter');
    el.savePlateBtn = document.getElementById('bpSavePlateBtn');
    el.deletePlateBtn = document.getElementById('bpDeletePlateBtn');
    el.bedCanvas = document.getElementById('bpBedCanvas');
    el.plateItemsList = document.getElementById('bpPlateItemsList');
    el.plateStats = document.getElementById('bpPlateStats');
    el.sliceBtn = document.getElementById('bpSliceBtn');
    el.sendToPrinterBtn = document.getElementById('bpSendToPrinterBtn');
    el.targetPrinter = document.getElementById('bpTargetPrinter');
    el.sliceStatus = document.getElementById('bpSliceStatus');
    el.partSearch = document.getElementById('bpPartSearch');
    el.partTypeFilter = document.getElementById('bpPartTypeFilter');
    el.partCatalog = document.getElementById('bpPartCatalog');
    el.queueBody = document.getElementById('bpQueueBody');
    el.queueCount = document.getElementById('bpQueueCount');
  }

  // ============================================================================
  // Data Loading
  // ============================================================================

  async function loadPlates() {
    try {
      const productId = el.productFilter.value || undefined;
      bpState.plates = await window.printStation.slicer.listProductPlates(productId);
      renderPlateList();
    } catch (err) {
      console.error('[BuildPlates] Failed to load plates:', err);
    }
  }

  async function loadCatalog() {
    try {
      const result = await window.printStation.slicer.listCatalog({ category: 'Multiboard' });
      bpState.catalog = (result.items || result || []).filter(p => p.mb_type);
      renderPartCatalog();
    } catch (err) {
      console.error('[BuildPlates] Failed to load catalog:', err);
    }
  }

  async function loadPrinters() {
    try {
      const printers = await window.printStation.printerFleet.listPrinters();
      bpState.printers = printers || [];
      renderPrinterOptions();
    } catch (err) {
      console.error('[BuildPlates] Failed to load printers:', err);
    }
  }

  // ============================================================================
  // Plate List (Left Panel)
  // ============================================================================

  function renderPlateList() {
    const plates = bpState.plates;
    if (!plates.length) {
      el.plateList.innerHTML = '<div style="padding:20px;text-align:center;color:#555;">No plates found.</div>';
      return;
    }

    // Group by product_id
    const groups = {};
    for (const p of plates) {
      const key = p.product_id || 'Custom';
      if (!groups[key]) groups[key] = [];
      groups[key].push(p);
    }

    let html = '';
    for (const [groupName, groupPlates] of Object.entries(groups)) {
      const displayName = groupPlates[0]?.name?.split(' - ')[0] || groupName;
      html += `<div class="bp-plate-group-header">${esc(displayName)}</div>`;
      for (const plate of groupPlates) {
        const items = safeParseJSON(plate.items);
        const settings = safeParseJSON(plate.settings);
        const totalQty = items.reduce((sum, it) => sum + (it.qty || 0), 0);
        const active = plate.id === bpState.currentPlateId ? ' active' : '';
        const badges = [];
        if (settings.stacked) badges.push('<span class="bp-status-badge slicing">STACKED</span>');
        if (settings.hardware_plate) badges.push('<span class="bp-status-badge queued">HW</span>');
        html += `
          <div class="bp-plate-item${active}" data-plate-id="${plate.id}">
            <div class="plate-name">${esc(plate.name || `Plate ${plate.plate_index + 1}`)} ${badges.join(' ')}</div>
            <div class="plate-meta">${totalQty} items | ${esc(plate.material)} | ${esc(plate.printer_model)}</div>
          </div>`;
      }
    }
    el.plateList.innerHTML = html;

    // Click handlers
    el.plateList.querySelectorAll('.bp-plate-item').forEach(item => {
      item.addEventListener('click', () => selectPlate(parseInt(item.dataset.plateId, 10)));
    });
  }

  function selectPlate(plateId) {
    bpState.currentPlateId = plateId;
    const plate = bpState.plates.find(p => p.id === plateId);
    if (!plate) return;

    // Show editor
    el.emptyState.style.display = 'none';
    el.editorContent.style.display = 'flex';

    // Populate fields
    el.plateName.value = plate.name || '';
    el.plateMaterial.value = plate.material || 'PLA';
    el.platePrinter.value = plate.printer_model || 'kobra3';
    bpState.selectedPrinterModel = plate.printer_model || 'kobra3';
    bpState.bedSize = BED_SIZES[bpState.selectedPrinterModel] || BED_SIZES.kobra3;

    // Parse items and settings
    bpState.currentPlateItems = safeParseJSON(plate.items);
    bpState.currentPlateSettings = safeParseJSON(plate.settings);

    renderPlateItems();
    renderBedCanvas();
    updatePlateStats();

    // Update active state in list
    el.plateList.querySelectorAll('.bp-plate-item').forEach(item => {
      item.classList.toggle('active', parseInt(item.dataset.plateId, 10) === plateId);
    });
  }

  // ============================================================================
  // Plate Editor (Center)
  // ============================================================================

  function renderPlateItems() {
    const items = bpState.currentPlateItems;
    if (!items.length) {
      el.plateItemsList.innerHTML = '<div style="padding:12px;color:#555;text-align:center;">No items. Add parts from the catalog.</div>';
      return;
    }

    let html = '';
    items.forEach((item, idx) => {
      const roleBadge = item.role === 'hardware'
        ? '<span style="font-size:0.7em;background:rgba(168,85,247,0.2);color:#a855f7;padding:1px 4px;border-radius:2px;margin-right:4px;">HW</span>'
        : '';
      html += `
        <div class="bp-plate-list-item">
          <span class="item-qty">${item.qty || 1}x</span>
          ${roleBadge}
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(item.name)}">${esc(item.name)}</span>
          <button class="item-remove" data-idx="${idx}" title="Remove">X</button>
        </div>`;
    });
    el.plateItemsList.innerHTML = html;

    // Remove handlers
    el.plateItemsList.querySelectorAll('.item-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.idx, 10);
        bpState.currentPlateItems.splice(idx, 1);
        renderPlateItems();
        renderBedCanvas();
        updatePlateStats();
      });
    });
  }

  function renderBedCanvas() {
    const canvas = el.bedCanvas;
    const ctx = canvas.getContext('2d');
    const bed = bpState.bedSize;
    const settings = bpState.currentPlateSettings || {};
    const scale = Math.min(420 / bed.w, 420 / bed.h);
    const cw = bed.w * scale;
    const ch = bed.h * scale;
    canvas.width = cw + 20;
    canvas.height = ch + 20;
    const ox = 10, oy = 10;

    // Clear
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Bed outline
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 2;
    ctx.strokeRect(ox, oy, cw, ch);

    // Grid lines every 40mm
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 0.5;
    for (let x = 40; x < bed.w; x += 40) {
      ctx.beginPath();
      ctx.moveTo(ox + x * scale, oy);
      ctx.lineTo(ox + x * scale, oy + ch);
      ctx.stroke();
    }
    for (let y = 40; y < bed.h; y += 40) {
      ctx.beginPath();
      ctx.moveTo(ox, oy + y * scale);
      ctx.lineTo(ox + cw, oy + y * scale);
      ctx.stroke();
    }

    // Bed label
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.font = '11px monospace';
    ctx.fillText(`${bed.w} x ${bed.h} mm`, ox + 4, oy + ch - 4);

    const items = bpState.currentPlateItems;
    const margin = 5;
    const colors = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#f97316', '#ec4899'];

    // ── Stacked plate rendering ──
    if (settings.stacked && items.length === 1) {
      const item = items[0];
      const stackH = settings.stack_height || 1;
      const totalQty = item.qty || 1;
      const color = '#6366f1';

      // Use stored positions_per_layer from settings (calculated by match script
      // using actual part dimensions). Fall back to catalog lookup only if missing.
      let perLayer = settings.positions_per_layer || 0;
      let perRow, numRows, fw, fh;

      if (perLayer > 0) {
        // Derive grid layout from stored positions count
        // Assume roughly square grid that fits the bed
        perRow = Math.ceil(Math.sqrt(perLayer));
        numRows = Math.ceil(perLayer / perRow);
        // Size each cell to fill the bed evenly
        fw = Math.floor((bed.w - margin * (perRow - 1)) / perRow);
        fh = Math.floor((bed.h - margin * (numRows - 1)) / numRows);
      } else {
        // Fallback: calculate from catalog part dimensions
        const catPart = bpState.catalog.find(c => c.id === item.stl_catalog_id);
        fw = catPart?.mu_width ? catPart.mu_width * MU_MM : 80;
        fh = catPart?.mu_height ? catPart.mu_height * MU_MM : 80;
        // Clamp to bed size
        fw = Math.min(fw, bed.w);
        fh = Math.min(fh, bed.h);
        perRow = Math.max(1, Math.floor((bed.w + margin) / (fw + margin)));
        numRows = Math.max(1, Math.floor((bed.h + margin) / (fh + margin)));
        perLayer = perRow * numRows;
      }

      // Draw each position with stack count
      for (let r = 0; r < numRows; r++) {
        for (let c = 0; c < perRow; c++) {
          const posIdx = r * perRow + c;
          if (posIdx >= perLayer) break;

          // How many items in this stack position
          const actualStack = Math.min(stackH, Math.max(0, totalQty - posIdx * stackH));
          if (actualStack <= 0) continue;

          const px = c * (fw + margin);
          const py = r * (fh + margin);

          // Ensure we don't draw outside the bed
          if (px + fw > bed.w + 1 || py + fh > bed.h + 1) continue;

          // Draw with depth effect for stacking
          const depth = Math.min(actualStack, 4);
          for (let d = depth; d >= 0; d--) {
            const dox = d * 2;
            const doy = d * 2;
            ctx.fillStyle = d === 0 ? color + '44' : color + '15';
            ctx.fillRect(ox + px * scale + dox, oy + py * scale + doy, fw * scale - depth * 2, fh * scale - depth * 2);
          }
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.5;
          ctx.strokeRect(ox + px * scale, oy + py * scale, fw * scale, fh * scale);

          // Stack count label
          ctx.fillStyle = '#fff';
          ctx.font = 'bold 14px sans-serif';
          ctx.fillText(`x${actualStack}`, ox + px * scale + fw * scale / 2 - 12, oy + py * scale + fh * scale / 2 + 5);

          // Part name
          ctx.font = '9px sans-serif';
          ctx.fillStyle = 'rgba(255,255,255,0.6)';
          const label = (item.name || '').split(' ').slice(0, 2).join(' ');
          ctx.fillText(label, ox + px * scale + 3, oy + py * scale + 12);
        }
      }

      // Stacked info overlay
      ctx.fillStyle = 'rgba(99,102,241,0.8)';
      ctx.font = 'bold 12px sans-serif';
      ctx.fillText(`STACKED: ${perLayer} pos x ${stackH} high = ${perLayer * stackH} cap (${totalQty} used)`, ox + 4, oy + 14);
      return;
    }

    // ── Normal plate rendering (row-packing) ──
    let curX = 0, curY = 0, rowHeight = 0;
    let colorIdx = 0;
    for (const item of items) {
      const catPart = bpState.catalog.find(c => c.id === item.stl_catalog_id);
      // Clamp footprint to bed size so items never render off-canvas
      const fw = Math.min(catPart?.mu_width ? catPart.mu_width * MU_MM : 80, bed.w);
      const fh = Math.min(catPart?.mu_height ? catPart.mu_height * MU_MM : 80, bed.h);
      const qty = item.qty || 1;
      const color = colors[colorIdx % colors.length];
      const isHardware = item.role === 'hardware';
      colorIdx++;

      for (let i = 0; i < qty; i++) {
        if (curX + fw + margin > bed.w) {
          curY += rowHeight + margin;
          curX = 0;
          rowHeight = 0;
        }
        if (curY + fh + margin > bed.h) {
          ctx.fillStyle = 'rgba(239,68,68,0.3)';
          ctx.fillRect(ox + curX * scale, oy + curY * scale, fw * scale, fh * scale);
          ctx.strokeStyle = '#ef4444';
          ctx.lineWidth = 1;
          ctx.strokeRect(ox + curX * scale, oy + curY * scale, fw * scale, fh * scale);
        } else {
          ctx.fillStyle = color + '33';
          ctx.fillRect(ox + curX * scale, oy + curY * scale, fw * scale, fh * scale);
          ctx.strokeStyle = isHardware ? '#a855f7' : color;
          ctx.lineWidth = 1.5;
          if (isHardware) {
            ctx.setLineDash([3, 3]);
          }
          ctx.strokeRect(ox + curX * scale, oy + curY * scale, fw * scale, fh * scale);
          ctx.setLineDash([]);
        }

        ctx.fillStyle = '#fff';
        ctx.font = '10px sans-serif';
        const label = (item.name || '').split(' ').slice(0, 2).join(' ');
        ctx.fillText(label, ox + curX * scale + 3, oy + curY * scale + 12);
        if (fw >= 60) {
          ctx.fillStyle = 'rgba(255,255,255,0.5)';
          ctx.font = '9px monospace';
          ctx.fillText(`${fw}x${fh}`, ox + curX * scale + 3, oy + curY * scale + 24);
        }

        curX += fw + margin;
        rowHeight = Math.max(rowHeight, fh);
      }
    }
  }

  function updatePlateStats() {
    const items = bpState.currentPlateItems;
    const settings = bpState.currentPlateSettings || {};
    const totalParts = items.reduce((sum, it) => sum + (it.qty || 1), 0);
    const uniqueParts = items.length;
    let info = `${totalParts} parts (${uniqueParts} unique)`;
    if (settings.stacked) {
      info += ` | Stacked: ${settings.positions_per_layer || '?'} positions x ${settings.stack_height || '?'} high`;
    }
    if (settings.hardware_plate) {
      info += ' | Hardware plate';
    }
    if (settings.slicer_overrides) {
      const so = settings.slicer_overrides;
      const flags = [];
      if (so.complete_objects) flags.push('Object-by-object');
      if (so.fill_density) flags.push(`Fill: ${so.fill_density}`);
      if (so.layer_height) flags.push(`LH: ${so.layer_height}mm`);
      if (flags.length) info += ` | ${flags.join(', ')}`;
    }
    el.plateStats.textContent = info;
  }

  // ============================================================================
  // Part Catalog (Right Panel)
  // ============================================================================

  function renderPartCatalog() {
    const search = (el.partSearch?.value || '').toLowerCase();
    const typeFilter = el.partTypeFilter?.value || '';

    let parts = bpState.catalog;
    if (typeFilter) {
      parts = parts.filter(p => p.mb_type === typeFilter);
    }
    if (search) {
      parts = parts.filter(p => (p.name || '').toLowerCase().includes(search));
    }

    // Limit to 100 for performance
    const display = parts.slice(0, 100);

    if (!display.length) {
      el.partCatalog.innerHTML = '<div style="padding:12px;color:#555;text-align:center;">No parts found.</div>';
      return;
    }

    let html = '';
    for (const part of display) {
      const dims = part.mu_width && part.mu_height ? `${part.mu_width}x${part.mu_height} MU` : '';
      html += `
        <div class="bp-part-item" data-part-id="${part.id}">
          <span class="part-name" title="${esc(part.name)}">${esc(part.name)}</span>
          <span class="part-dims">${dims}</span>
          <button class="part-add-btn" data-part-id="${part.id}">+</button>
        </div>`;
    }
    if (parts.length > 100) {
      html += `<div style="padding:8px;text-align:center;color:#555;font-size:0.8em;">Showing 100 of ${parts.length}. Refine search.</div>`;
    }
    el.partCatalog.innerHTML = html;

    // Add handlers
    el.partCatalog.querySelectorAll('.part-add-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        addPartToPlate(parseInt(btn.dataset.partId, 10));
      });
    });
  }

  function addPartToPlate(partId) {
    if (!bpState.currentPlateId) {
      alert('Select or create a plate first.');
      return;
    }
    const part = bpState.catalog.find(p => p.id === partId);
    if (!part) return;

    // Check if already on plate — increment qty
    const existing = bpState.currentPlateItems.find(it => it.stl_catalog_id === partId);
    if (existing) {
      existing.qty = (existing.qty || 1) + 1;
    } else {
      bpState.currentPlateItems.push({
        stl_catalog_id: part.id,
        name: part.name,
        qty: 1
      });
    }

    renderPlateItems();
    renderBedCanvas();
    updatePlateStats();
  }

  // ============================================================================
  // Printer Options
  // ============================================================================

  function renderPrinterOptions() {
    if (!el.targetPrinter) return;
    let html = '<option value="">Select printer…</option>';
    for (const p of bpState.printers) {
      html += `<option value="${esc(p.id)}">${esc(p.name || p.id)}</option>`;
    }
    el.targetPrinter.innerHTML = html;
  }

  // ============================================================================
  // Product Filter
  // ============================================================================

  function populateProductFilter() {
    const products = new Map();
    for (const p of bpState.plates) {
      if (p.product_id && !products.has(p.product_id)) {
        const displayName = (p.name || '').split(' - ')[0] || p.product_id;
        products.set(p.product_id, displayName);
      }
    }
    let html = '<option value="">All Products</option>';
    for (const [id, name] of products) {
      html += `<option value="${esc(id)}">${esc(name)}</option>`;
    }
    el.productFilter.innerHTML = html;
  }

  // ============================================================================
  // Save / Delete
  // ============================================================================

  async function savePlate() {
    if (!bpState.currentPlateId) return;
    try {
      await window.printStation.slicer.updateProductPlate(bpState.currentPlateId, {
        name: el.plateName.value,
        items: bpState.currentPlateItems,
        material: el.plateMaterial.value,
        printer_model: el.platePrinter.value
      });
      el.sliceStatus.textContent = 'Saved!';
      setTimeout(() => { el.sliceStatus.textContent = ''; }, 2000);
      await loadPlates();
      selectPlate(bpState.currentPlateId);
    } catch (err) {
      console.error('[BuildPlates] Save error:', err);
      alert('Failed to save: ' + err.message);
    }
  }

  async function deletePlate() {
    if (!bpState.currentPlateId) return;
    if (!confirm('Delete this plate?')) return;
    try {
      await window.printStation.slicer.deleteProductPlate(bpState.currentPlateId);
      bpState.currentPlateId = null;
      el.emptyState.style.display = 'flex';
      el.editorContent.style.display = 'none';
      await loadPlates();
    } catch (err) {
      console.error('[BuildPlates] Delete error:', err);
    }
  }

  async function createNewPlate() {
    try {
      const plate = await window.printStation.slicer.createProductPlate({
        product_id: el.productFilter.value || 'custom',
        plate_index: 0,
        name: 'New Plate',
        items: [],
        material: 'PLA',
        printer_model: 'kobra3'
      });
      await loadPlates();
      selectPlate(plate.id);
    } catch (err) {
      console.error('[BuildPlates] Create error:', err);
    }
  }

  // ============================================================================
  // Slicing & Printing
  // ============================================================================

  async function slicePlate() {
    if (!bpState.currentPlateId || !bpState.currentPlateItems.length) return;
    el.sliceStatus.textContent = 'Slicing…';
    el.sliceBtn.disabled = true;

    try {
      // Build items array for slicer
      const items = bpState.currentPlateItems.map(it => ({
        stl_catalog_id: it.stl_catalog_id,
        qty: it.qty || 1,
        name: it.name
      }));

      const result = await window.printStation.slicer.slicePlate({
        items,
        material: el.plateMaterial.value,
        printerModel: el.platePrinter.value
      });

      el.sliceStatus.textContent = result.success ? 'Sliced! G-code ready.' : 'Slice failed: ' + (result.error || 'Unknown');
    } catch (err) {
      console.error('[BuildPlates] Slice error:', err);
      el.sliceStatus.textContent = 'Slice error: ' + err.message;
    } finally {
      el.sliceBtn.disabled = false;
    }
  }

  async function sendToPrinter() {
    const printerId = el.targetPrinter.value;
    if (!printerId) {
      alert('Select a target printer first.');
      return;
    }
    if (!bpState.currentPlateItems.length) return;

    el.sliceStatus.textContent = 'Sending to printer…';
    el.sendToPrinterBtn.disabled = true;

    try {
      const items = bpState.currentPlateItems.map(it => ({
        stl_catalog_id: it.stl_catalog_id,
        qty: it.qty || 1,
        name: it.name
      }));

      const timelapse = document.getElementById('bpTimelapse')?.checked || false;
      const result = await window.printStation.slicer.slicePlateAndPrint({
        items,
        material: el.plateMaterial.value,
        printerModel: el.platePrinter.value
      }, printerId, { timelapse });

      el.sliceStatus.textContent = result.success ? 'Sent to printer!' : 'Failed: ' + (result.error || 'Unknown');
      loadQueue();
    } catch (err) {
      console.error('[BuildPlates] Send to printer error:', err);
      el.sliceStatus.textContent = 'Error: ' + err.message;
    } finally {
      el.sendToPrinterBtn.disabled = false;
    }
  }

  // ============================================================================
  // Print Queue (Bottom)
  // ============================================================================

  async function loadQueue() {
    try {
      const printers = bpState.printers;
      let queueItems = [];

      for (const printer of printers) {
        try {
          const status = await window.printStation.printerFleet.getAllStatus();
          if (status && status[printer.id]) {
            const ps = status[printer.id];
            if (ps.state === 'printing' || ps.state === 'paused') {
              queueItems.push({
                plate: ps.filename || 'Unknown',
                printer: printer.name || printer.id,
                status: ps.state,
                progress: ps.progress ? Math.round(ps.progress) + '%' : ''
              });
            }
          }
        } catch (_) { /* skip */ }
      }

      renderQueue(queueItems);
    } catch (err) {
      console.error('[BuildPlates] Queue load error:', err);
    }
  }

  function renderQueue(queueItems) {
    if (!queueItems.length) {
      el.queueBody.innerHTML = '<tr><td colspan="5" style="padding:12px;text-align:center;color:#555;">No active prints.</td></tr>';
      el.queueCount.textContent = '';
      return;
    }

    el.queueCount.textContent = `(${queueItems.length})`;
    let html = '';
    for (const qi of queueItems) {
      html += `
        <tr>
          <td style="padding:6px 12px;">${esc(qi.plate)}</td>
          <td style="padding:6px 12px;">${esc(qi.printer)}</td>
          <td style="padding:6px 12px;"><span class="bp-status-badge ${qi.status}">${qi.status}</span></td>
          <td style="padding:6px 12px;">${qi.progress}</td>
          <td style="padding:6px 12px;">—</td>
        </tr>`;
    }
    el.queueBody.innerHTML = html;
  }

  // ============================================================================
  // Utilities
  // ============================================================================

  function esc(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function safeParseJSON(val) {
    if (Array.isArray(val)) return val;
    try { return JSON.parse(val || '[]'); } catch { return []; }
  }

  // ============================================================================
  // Init
  // ============================================================================

  async function init() {
    cacheElements();
    if (!el.plateList) return; // view not in DOM

    // Event listeners
    el.refreshBtn.addEventListener('click', () => { loadPlates(); loadCatalog(); loadPrinters(); });
    el.newPlateBtn.addEventListener('click', createNewPlate);
    el.savePlateBtn.addEventListener('click', savePlate);
    el.deletePlateBtn.addEventListener('click', deletePlate);
    el.sliceBtn.addEventListener('click', slicePlate);
    el.sendToPrinterBtn.addEventListener('click', sendToPrinter);

    el.productFilter.addEventListener('change', loadPlates);
    el.platePrinter.addEventListener('change', () => {
      bpState.selectedPrinterModel = el.platePrinter.value;
      bpState.bedSize = BED_SIZES[bpState.selectedPrinterModel] || BED_SIZES.kobra3;
      renderBedCanvas();
    });

    // Part catalog search/filter
    let searchDebounce;
    el.partSearch.addEventListener('input', () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(renderPartCatalog, 200);
    });
    el.partTypeFilter.addEventListener('change', renderPartCatalog);

    // Load data
    await Promise.all([loadPlates(), loadCatalog(), loadPrinters()]);
    populateProductFilter();
    loadQueue();
  }

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
