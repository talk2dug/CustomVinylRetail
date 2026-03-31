// =============== Inkjet Printer Fleet View ===============

const inkjetState = {
  initialized: false,
  printers: [],
  jobs: [],
  selectedPrinterId: null,
  capabilities: {},  // printerId -> capabilities
  inkLevels: {}      // printerId -> levels
};

// =============== INITIALIZATION ===============

function initInkjetFleetView() {
  if (!inkjetState.initialized) {
    inkjetState.initialized = true;
    document.getElementById('inkjetRefreshBtn').addEventListener('click', loadInkjetData);
    document.getElementById('inkjetAddPrinterBtn').addEventListener('click', showInkjetAddModal);
    document.getElementById('inkjetDiscoverBtn').addEventListener('click', discoverInkjetPrinters);
    document.getElementById('inkjetPrinterGrid').addEventListener('click', handleInkjetGridClick);
    document.getElementById('inkjetJobFilter').addEventListener('change', renderInkjetJobs);
  }
  loadInkjetData();
}

// =============== DATA LOADING ===============

async function loadInkjetData() {
  try {
    document.getElementById('inkjetLastUpdated').textContent = 'Loading...';
    const [printers, jobs, status] = await Promise.all([
      printStation.inkjetFleet.listPrinters(),
      printStation.inkjetFleet.listJobs({ limit: 50 }),
      printStation.inkjetFleet.getStatus()
    ]);
    inkjetState.printers = printers;
    inkjetState.jobs = jobs;
    renderInkjetSummary(status);
    renderInkjetGrid(status);
    renderInkjetJobs();
    document.getElementById('inkjetLastUpdated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    document.getElementById('inkjetLastUpdated').textContent = 'Error loading';
    console.error('[InkjetFleet] Load error:', err);
  }
}

// =============== RENDERING ===============

function renderInkjetSummary(status) {
  const printers = inkjetState.printers;
  const statusMap = status || {};
  let online = 0, printing = 0, idle = 0, offline = 0;

  for (const p of printers) {
    const s = statusMap[p.cups_name];
    if (!s || s.state === 'unknown') { offline++; continue; }
    if (s.state === 'printing') { printing++; online++; }
    else if (s.state === 'idle') { idle++; online++; }
    else if (s.state === 'disabled') { offline++; }
    else { idle++; online++; }
  }

  document.getElementById('inkjetTotalPrinters').textContent = printers.length;
  document.getElementById('inkjetOnlineCount').textContent = online;
  document.getElementById('inkjetPrintingCount').textContent = printing;
  document.getElementById('inkjetIdleCount').textContent = idle;
  document.getElementById('inkjetOfflineCount').textContent = offline;
}

function renderInkjetGrid(status) {
  const grid = document.getElementById('inkjetPrinterGrid');
  const printers = inkjetState.printers;
  const statusMap = status || {};

  if (!printers.length) {
    grid.innerHTML = `<div class="placeholder" style="grid-column:1/-1;text-align:center;padding:60px 20px;color:var(--muted);">
      Click <strong>Add Printer</strong> or <strong>Discover</strong> to find your inkjet printers.
    </div>`;
    return;
  }

  grid.innerHTML = printers.map(p => {
    const s = statusMap[p.cups_name] || {};
    const stateClass = s.state === 'printing' ? 'success' : s.state === 'idle' ? 'muted' : 'danger';
    const stateLabel = s.state === 'printing' ? 'Printing' : s.state === 'idle' ? 'Idle' : s.state === 'disabled' ? 'Disabled' : 'Unknown';
    const caps = p.capabilities ? JSON.parse(p.capabilities || '{}') : {};
    const hasCaps = Object.keys(caps).length > 0;

    return `
      <div class="inventory-card inkjet-card" data-printer-id="${p.id}" style="cursor:pointer;position:relative;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;">
          <div>
            <h3 style="margin:0 0 4px;">${escInkjet(p.name)}</h3>
            <div class="muted" style="font-size:0.85rem;">${escInkjet(p.make)} ${escInkjet(p.model)}</div>
            ${p.purpose ? `<div style="font-size:0.8rem;margin-top:2px;color:var(--accent);">${escInkjet(p.purpose)}</div>` : ''}
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="width:10px;height:10px;border-radius:50%;background:var(--${stateClass});display:inline-block;"></span>
            <span style="font-size:0.85rem;">${stateLabel}</span>
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">
          <button class="secondary inkjet-action" data-action="print" data-id="${p.id}" style="padding:4px 10px;font-size:0.85rem;">Print</button>
          <button class="secondary inkjet-action" data-action="ink" data-id="${p.id}" style="padding:4px 10px;font-size:0.85rem;">Ink Levels</button>
          ${hasCaps ? '' : `<button class="secondary inkjet-action" data-action="caps" data-id="${p.id}" style="padding:4px 10px;font-size:0.85rem;">Load Options</button>`}
          <button class="secondary inkjet-action" data-action="edit" data-id="${p.id}" style="padding:4px 10px;font-size:0.85rem;">Edit</button>
          <button class="secondary inkjet-action" data-action="delete" data-id="${p.id}" style="padding:4px 10px;font-size:0.85rem;color:var(--danger);">Remove</button>
        </div>
        ${p.location ? `<div class="muted" style="font-size:0.8rem;margin-top:8px;">Location: ${escInkjet(p.location)}</div>` : ''}
        <div class="muted" style="font-size:0.75rem;margin-top:4px;">CUPS: ${escInkjet(p.cups_name)}</div>
        <div id="inkjetInk-${p.id}" style="margin-top:8px;"></div>
      </div>`;
  }).join('');
}

function renderInkjetJobs() {
  const container = document.getElementById('inkjetJobsList');
  const filter = document.getElementById('inkjetJobFilter').value;
  let jobs = inkjetState.jobs;
  if (filter) jobs = jobs.filter(j => j.status === filter);

  if (!jobs.length) {
    container.innerHTML = '<div class="muted" style="text-align:center;padding:20px;">No print jobs</div>';
    return;
  }

  container.innerHTML = jobs.map(j => {
    const statusColor = j.status === 'printing' ? 'var(--success)' : j.status === 'completed' ? 'var(--muted)' :
      j.status === 'cancelled' ? 'var(--danger)' : j.status === 'queued' ? 'var(--accent)' : 'var(--text)';
    return `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);">
        <div>
          <strong>${escInkjet(j.filename)}</strong>
          <span class="muted" style="margin-left:8px;">${escInkjet(j.printer_name || '')}</span>
        </div>
        <div style="display:flex;align-items:center;gap:12px;">
          <span style="font-size:0.85rem;">${j.page_size || ''} · ${j.color_mode || ''} · x${j.copies || 1}</span>
          <span style="color:${statusColor};font-weight:600;font-size:0.85rem;text-transform:capitalize;">${j.status}</span>
          ${j.status === 'printing' || j.status === 'queued' ? `<button class="secondary inkjet-cancel-job" data-job-id="${j.id}" style="padding:2px 8px;font-size:0.8rem;color:var(--danger);">Cancel</button>` : ''}
        </div>
      </div>`;
  }).join('');

  // Cancel job handlers
  container.querySelectorAll('.inkjet-cancel-job').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const jobId = parseInt(btn.dataset.jobId);
      if (confirm('Cancel this print job?')) {
        await printStation.inkjetFleet.cancelJob(jobId);
        loadInkjetData();
      }
    });
  });
}

// =============== EVENT HANDLERS ===============

async function handleInkjetGridClick(e) {
  const actionBtn = e.target.closest('.inkjet-action');
  if (!actionBtn) return;

  e.stopPropagation();
  const id = parseInt(actionBtn.dataset.id);
  const action = actionBtn.dataset.action;
  const printer = inkjetState.printers.find(p => p.id === id);
  if (!printer) return;

  if (action === 'print') {
    showInkjetPrintModal(printer);
  } else if (action === 'ink') {
    await showInkLevels(printer);
  } else if (action === 'caps') {
    await loadAndShowCapabilities(printer);
  } else if (action === 'edit') {
    showInkjetAddModal(printer);
  } else if (action === 'delete') {
    if (confirm(`Remove ${printer.name}? This will also remove it from CUPS.`)) {
      await printStation.inkjetFleet.removePrinter(id);
      loadInkjetData();
    }
  }
}

// =============== INK LEVELS ===============

async function showInkLevels(printer) {
  const container = document.getElementById(`inkjetInk-${printer.id}`);
  container.innerHTML = '<span class="muted">Checking ink levels...</span>';
  try {
    const levels = await printStation.inkjetFleet.getInkLevels(printer.id);
    inkjetState.inkLevels[printer.id] = levels;
    if (!Object.keys(levels).length) {
      container.innerHTML = '<span class="muted" style="font-size:0.8rem;">Ink levels not available for this printer</span>';
      return;
    }
    container.innerHTML = Object.entries(levels).map(([key, info]) => {
      const pct = info.level;
      const color = key.includes('black') || key.includes('toner') ? '#333' :
        key.includes('cyan') ? '#00bcd4' : key.includes('magenta') ? '#e91e63' :
        key.includes('yellow') ? '#ffc107' : '#666';
      const lowClass = pct <= 15 ? 'color:var(--danger);font-weight:bold;' : '';
      return `<div style="display:flex;align-items:center;gap:8px;margin:4px 0;">
        <span style="width:80px;font-size:0.8rem;${lowClass}">${escInkjet(info.name)}</span>
        <div style="flex:1;height:8px;background:var(--border);border-radius:4px;overflow:hidden;">
          <div style="width:${pct}%;height:100%;background:${color};border-radius:4px;"></div>
        </div>
        <span style="font-size:0.8rem;width:35px;text-align:right;${lowClass}">${pct}%</span>
      </div>`;
    }).join('');
  } catch (err) {
    container.innerHTML = `<span class="muted" style="font-size:0.8rem;">Error: ${err.message}</span>`;
  }
}

// =============== CAPABILITIES ===============

async function loadAndShowCapabilities(printer) {
  try {
    const caps = await printStation.inkjetFleet.getCapabilities(printer.id);
    inkjetState.capabilities[printer.id] = caps;
    // Reload to show updated card (capabilities now cached)
    loadInkjetData();
  } catch (err) {
    alert('Failed to load printer capabilities: ' + err.message);
  }
}

// =============== PRINT MODAL ===============

function showInkjetPrintModal(printer) {
  const caps = printer.capabilities ? JSON.parse(printer.capabilities || '{}') : {};

  const buildSelect = (key, label, fallbackOptions) => {
    const cap = caps[key];
    const options = cap ? cap.values : (fallbackOptions || []).map(v => ({ value: v, isDefault: v === fallbackOptions[0] }));
    if (!options.length) return '';
    return `<div style="margin-bottom:10px;">
      <label style="display:block;margin-bottom:3px;font-size:0.85rem;">${label}</label>
      <select id="inkjetPrint_${key}" style="width:100%;padding:6px;">
        ${options.map(o => `<option value="${o.value}" ${o.isDefault ? 'selected' : ''}>${o.value}</option>`).join('')}
      </select>
    </div>`;
  };

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:9999;';
  modal.innerHTML = `
    <div style="background:var(--surface);border-radius:8px;padding:24px;width:500px;max-height:90vh;overflow-y:auto;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <h3 style="margin:0;">Print to ${escInkjet(printer.name)}</h3>
        <button id="inkjetPrintClose" style="background:none;border:none;font-size:1.2rem;cursor:pointer;color:var(--text);">✕</button>
      </div>

      <div style="margin-bottom:12px;">
        <label style="display:block;margin-bottom:3px;font-size:0.85rem;">File</label>
        <div style="display:flex;gap:8px;">
          <input id="inkjetPrintFile" type="file" style="flex:1;" accept=".pdf,.png,.jpg,.jpeg,.tiff,.bmp,.doc,.docx,.txt">
        </div>
      </div>

      <div style="margin-bottom:10px;">
        <label style="display:block;margin-bottom:3px;font-size:0.85rem;">Title</label>
        <input id="inkjetPrintTitle" type="text" style="width:100%;padding:6px;" placeholder="Job title (optional)">
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        ${buildSelect('PageSize', 'Paper Size', ['Letter', 'A4', 'Legal', '4x6', '5x7', '8x10'])}
        ${buildSelect('MediaType', 'Media Type', ['Plain', 'Photo', 'Glossy', 'Matte', 'Transparency'])}
        ${buildSelect('Resolution', 'Quality', ['300dpi', '600dpi', '1200dpi'])}
        <div style="margin-bottom:10px;">
          <label style="display:block;margin-bottom:3px;font-size:0.85rem;">Color Mode</label>
          <select id="inkjetPrint_ColorMode" style="width:100%;padding:6px;">
            <option value="Color">Color</option>
            <option value="Mono">Monochrome</option>
          </select>
        </div>
        ${buildSelect('Duplex', 'Duplex', ['None', 'DuplexNoTumble', 'DuplexTumble'])}
        <div style="margin-bottom:10px;">
          <label style="display:block;margin-bottom:3px;font-size:0.85rem;">Copies</label>
          <input id="inkjetPrintCopies" type="number" min="1" value="1" style="width:100%;padding:6px;">
        </div>
        <div style="margin-bottom:10px;">
          <label style="display:block;margin-bottom:3px;font-size:0.85rem;">Orientation</label>
          <select id="inkjetPrint_Orientation" style="width:100%;padding:6px;">
            <option value="Portrait">Portrait</option>
            <option value="Landscape">Landscape</option>
          </select>
        </div>
        <div style="margin-bottom:10px;">
          <label style="display:block;margin-bottom:3px;font-size:0.85rem;">Borders</label>
          <select id="inkjetPrint_Borders" style="width:100%;padding:6px;">
            <option value="default">Default</option>
            <option value="none">Borderless</option>
          </select>
        </div>
      </div>

      ${Object.keys(caps).filter(k => !['PageSize','MediaType','Resolution','Duplex'].includes(k)).map(k => {
        const c = caps[k];
        return `<div style="margin-bottom:10px;">
          <label style="display:block;margin-bottom:3px;font-size:0.85rem;">${c.label || k}</label>
          <select id="inkjetPrint_custom_${k}" style="width:100%;padding:6px;" data-custom-key="${k}">
            ${c.values.map(o => `<option value="${o.value}" ${o.isDefault ? 'selected' : ''}>${o.value}</option>`).join('')}
          </select>
        </div>`;
      }).join('')}

      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
        <button id="inkjetPrintCancel" class="secondary" style="padding:8px 16px;">Cancel</button>
        <button id="inkjetPrintSubmit" class="primary" style="padding:8px 16px;">Print</button>
      </div>
    </div>`;

  document.body.appendChild(modal);

  modal.querySelector('#inkjetPrintClose').addEventListener('click', () => modal.remove());
  modal.querySelector('#inkjetPrintCancel').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

  modal.querySelector('#inkjetPrintSubmit').addEventListener('click', async () => {
    const fileInput = modal.querySelector('#inkjetPrintFile');
    if (!fileInput.files.length) {
      alert('Please select a file to print');
      return;
    }

    const file = fileInput.files[0];
    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = reader.result.split(',')[1];

      // Gather custom options
      const customOptions = {};
      modal.querySelectorAll('[data-custom-key]').forEach(sel => {
        customOptions[sel.dataset.customKey] = sel.value;
      });

      const job = {
        printer_id: printer.id,
        filename: file.name,
        title: modal.querySelector('#inkjetPrintTitle').value || file.name,
        copies: parseInt(modal.querySelector('#inkjetPrintCopies').value) || 1,
        page_size: modal.querySelector('#inkjetPrint_PageSize')?.value || 'Letter',
        color_mode: modal.querySelector('#inkjetPrint_ColorMode')?.value || 'Color',
        media_type: modal.querySelector('#inkjetPrint_MediaType')?.value || 'Plain',
        print_quality: modal.querySelector('#inkjetPrint_Resolution')?.value || 'Normal',
        duplex: modal.querySelector('#inkjetPrint_Duplex')?.value || 'None',
        orientation: modal.querySelector('#inkjetPrint_Orientation')?.value || 'Portrait',
        borders: modal.querySelector('#inkjetPrint_Borders')?.value || 'default',
        custom_options: customOptions,
        file_base64: base64,
        submitted_by: 'print-station'
      };

      try {
        modal.querySelector('#inkjetPrintSubmit').disabled = true;
        modal.querySelector('#inkjetPrintSubmit').textContent = 'Sending...';
        await printStation.inkjetFleet.submitJob(job);
        modal.remove();
        loadInkjetData();
      } catch (err) {
        alert('Print failed: ' + err.message);
        modal.querySelector('#inkjetPrintSubmit').disabled = false;
        modal.querySelector('#inkjetPrintSubmit').textContent = 'Print';
      }
    };
    reader.readAsDataURL(file);
  });
}

// =============== ADD/EDIT PRINTER MODAL ===============

function showInkjetAddModal(editPrinter = null) {
  const isEdit = editPrinter && editPrinter.id;

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:9999;';
  modal.innerHTML = `
    <div style="background:var(--surface);border-radius:8px;padding:24px;width:450px;">
      <h3 style="margin:0 0 16px;">${isEdit ? 'Edit Printer' : 'Add Inkjet Printer'}</h3>
      <div style="margin-bottom:10px;">
        <label style="display:block;margin-bottom:3px;font-size:0.85rem;">Name</label>
        <input id="inkjetAddName" type="text" style="width:100%;padding:6px;" value="${escInkjet(isEdit ? editPrinter.name : '')}" placeholder="e.g. Canon TR8600">
      </div>
      <div style="margin-bottom:10px;">
        <label style="display:block;margin-bottom:3px;font-size:0.85rem;">CUPS Name (no spaces)</label>
        <input id="inkjetAddCups" type="text" style="width:100%;padding:6px;" value="${escInkjet(isEdit ? editPrinter.cups_name : '')}" placeholder="e.g. Canon_TR8600" ${isEdit ? 'disabled' : ''}>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div style="margin-bottom:10px;">
          <label style="display:block;margin-bottom:3px;font-size:0.85rem;">Make</label>
          <input id="inkjetAddMake" type="text" style="width:100%;padding:6px;" value="${escInkjet(isEdit ? editPrinter.make || '' : '')}" placeholder="e.g. Canon">
        </div>
        <div style="margin-bottom:10px;">
          <label style="display:block;margin-bottom:3px;font-size:0.85rem;">Model</label>
          <input id="inkjetAddModel" type="text" style="width:100%;padding:6px;" value="${escInkjet(isEdit ? editPrinter.model || '' : '')}" placeholder="e.g. TR8600">
        </div>
      </div>
      <div style="margin-bottom:10px;">
        <label style="display:block;margin-bottom:3px;font-size:0.85rem;">Printer URI (for new printers)</label>
        <input id="inkjetAddUri" type="text" style="width:100%;padding:6px;" value="${escInkjet(isEdit ? editPrinter.uri || '' : '')}" placeholder="e.g. ipp://192.168.0.100/ipp/print">
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div style="margin-bottom:10px;">
          <label style="display:block;margin-bottom:3px;font-size:0.85rem;">Location</label>
          <input id="inkjetAddLocation" type="text" style="width:100%;padding:6px;" value="${escInkjet(isEdit ? editPrinter.location || '' : '')}" placeholder="e.g. Office">
        </div>
        <div style="margin-bottom:10px;">
          <label style="display:block;margin-bottom:3px;font-size:0.85rem;">Purpose</label>
          <input id="inkjetAddPurpose" type="text" style="width:100%;padding:6px;" value="${escInkjet(isEdit ? editPrinter.purpose || '' : '')}" placeholder="e.g. Labels, DTF, Stickers">
        </div>
      </div>
      ${!isEdit ? `<label style="display:flex;align-items:center;gap:6px;margin-bottom:10px;font-size:0.85rem;">
        <input id="inkjetAddToCups" type="checkbox" checked> Also add to CUPS on print server
      </label>` : ''}
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
        <button id="inkjetAddCancel" class="secondary" style="padding:8px 16px;">Cancel</button>
        <button id="inkjetAddSave" class="primary" style="padding:8px 16px;">${isEdit ? 'Save' : 'Add Printer'}</button>
      </div>
    </div>`;

  document.body.appendChild(modal);

  modal.querySelector('#inkjetAddCancel').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

  modal.querySelector('#inkjetAddSave').addEventListener('click', async () => {
    const data = {
      name: modal.querySelector('#inkjetAddName').value.trim(),
      cups_name: modal.querySelector('#inkjetAddCups').value.trim().replace(/\s+/g, '_'),
      make: modal.querySelector('#inkjetAddMake').value.trim(),
      model: modal.querySelector('#inkjetAddModel').value.trim(),
      uri: modal.querySelector('#inkjetAddUri').value.trim(),
      location: modal.querySelector('#inkjetAddLocation').value.trim(),
      purpose: modal.querySelector('#inkjetAddPurpose').value.trim()
    };

    if (!data.name || !data.cups_name) {
      alert('Name and CUPS name are required');
      return;
    }

    if (!isEdit) {
      const addToCups = modal.querySelector('#inkjetAddToCups')?.checked;
      data.add_to_cups = addToCups && !!data.uri;
    }

    try {
      if (isEdit) {
        await printStation.inkjetFleet.updatePrinter(editPrinter.id, data);
      } else {
        await printStation.inkjetFleet.addPrinter(data);
      }
      modal.remove();
      loadInkjetData();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  });
}

// =============== DISCOVER ===============

async function discoverInkjetPrinters() {
  const btn = document.getElementById('inkjetDiscoverBtn');
  btn.disabled = true;
  btn.textContent = 'Scanning...';

  try {
    const discovered = await printStation.inkjetFleet.discover();
    const newPrinters = discovered.filter(p => p.discovered && p.status === 'not_added');

    if (!newPrinters.length) {
      alert('No new printers found on the network. Make sure they are powered on and connected to WiFi.');
      return;
    }

    const msg = `Found ${newPrinters.length} new printer(s):\n\n` +
      newPrinters.map(p => `- ${p.name} (${p.uri})`).join('\n') +
      '\n\nAdd them all?';

    if (confirm(msg)) {
      for (const p of newPrinters) {
        // CUPS names must be printable ASCII, no spaces or special chars
        const safeCupsName = (p.cups_name || p.name || 'printer')
          .replace(/[^\x20-\x7E]/g, '')
          .replace(/\s+/g, '_')
          .replace(/[^a-zA-Z0-9_-]/g, '_')
          .replace(/_+/g, '_')
          .replace(/^_|_$/g, '');
        await printStation.inkjetFleet.addPrinter({
          name: p.name || p.cups_name,
          cups_name: safeCupsName,
          uri: p.uri,
          add_to_cups: true
        });
      }
      loadInkjetData();
    }
  } catch (err) {
    alert('Discovery failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Discover';
  }
}

// =============== HELPERS ===============

function escInkjet(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = String(str);
  return d.innerHTML;
}

// Expose for switchView init
window.initInkjetFleetView = initInkjetFleetView;
