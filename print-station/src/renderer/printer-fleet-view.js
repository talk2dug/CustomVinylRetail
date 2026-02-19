// =============== 3D Printer Fleet View ===============

const fleetState = {
  initialized: false,
  printers: [],
  jobs: [],
  statusUnsub: null,
  selectedPrinterId: null,
  jobFilter: '',
  webcamUrls: {},       // printerId -> { snapshot, stream, rotation, flipH, flipV }
  snapshotTimer: null
};

// =============== INITIALIZATION ===============

function initPrinterFleetView() {
  if (!fleetState.initialized) {
    fleetState.initialized = true;
    setupFleetEventListeners();
    // Subscribe to real-time status updates from main process
    fleetState.statusUnsub = printStation.printerFleet.onPrinterStatus((data) => {
      updatePrinterCardStatus(data);
    });
  }
  loadFleetData();
  // Start snapshot refresh (5s)
  fleetStartSnapshotRefresh();
}

function fleetStartSnapshotRefresh() {
  if (fleetState.snapshotTimer) clearInterval(fleetState.snapshotTimer);
  fleetState.snapshotTimer = setInterval(fleetRefreshSnapshots, 5000);
}

function fleetRefreshSnapshots() {
  const imgs = document.querySelectorAll('.fleet-snapshot-img');
  const now = Date.now();
  imgs.forEach(img => {
    const base = img.dataset.snapshotUrl;
    if (!base) return;
    const newSrc = base + (base.includes('?') ? '&' : '?') + '_t=' + now;
    // Preload to avoid blank flash — only swap src after the new image is fully loaded
    const preload = new Image();
    preload.onload = () => { img.src = newSrc; img.style.display = ''; };
    preload.onerror = () => {}; // keep showing the old image on error
    preload.src = newSrc;
  });
}

function setupFleetEventListeners() {
  document.getElementById('fleetRefreshBtn').addEventListener('click', loadFleetData);
  document.getElementById('fleetAddPrinterBtn').addEventListener('click', showAddPrinterModal);
  document.getElementById('fleetJobFilter').addEventListener('change', (e) => {
    fleetState.jobFilter = e.target.value;
    renderJobsList();
  });
  document.getElementById('fleetPrinterGrid').addEventListener('click', handlePrinterGridClick);
}

// =============== DATA LOADING ===============

async function loadFleetData() {
  try {
    const [printersWithStatus, jobs, stats] = await Promise.all([
      printStation.printerFleet.getAllStatus(),
      printStation.printerFleet.listJobs({ limit: 50 }),
      printStation.printerFleet.getJobStats()
    ]);
    fleetState.printers = printersWithStatus;
    fleetState.jobs = jobs;
    renderFleetSummary(printersWithStatus, stats);
    renderPrinterCards(printersWithStatus);
    renderJobsList();
    document.getElementById('fleetLastUpdated').textContent =
      `Updated ${new Date().toLocaleTimeString()}`;

    // Fetch webcam URLs for each printer (async, non-blocking)
    for (const p of printersWithStatus) {
      if (!fleetState.webcamUrls[p.id]) {
        printStation.printerFleet.getWebcamUrls(p.id).then(urls => {
          fleetState.webcamUrls[p.id] = urls;
          // Update the snapshot img if card exists
          const img = document.querySelector(`#fleetCard-${p.id} .fleet-snapshot-img`);
          if (img && urls.snapshot) {
            img.dataset.snapshotUrl = urls.snapshot;
            img.src = urls.snapshot + (urls.snapshot.includes('?') ? '&' : '?') + '_t=' + Date.now();
            img.style.display = '';
          }
        }).catch(() => {});
      }
    }
  } catch (err) {
    console.error('[Fleet] Load error:', err);
    if (typeof showToast === 'function') showToast('Failed to load fleet data: ' + err.message, 'error');
  }
}

// =============== SUMMARY BAR ===============

function renderFleetSummary(printers, stats) {
  let online = 0, printing = 0, idle = 0, offline = 0;
  for (const p of printers) {
    const s = p.status?.state;
    if (s === 'offline' || !s || s === 'unknown') offline++;
    else if (s === 'printing') { printing++; online++; }
    else if (s === 'paused') { printing++; online++; }
    else { idle++; online++; }
  }
  document.getElementById('fleetTotalPrinters').textContent = printers.length;
  document.getElementById('fleetOnlineCount').textContent = online;
  document.getElementById('fleetPrintingCount').textContent = printing;
  document.getElementById('fleetIdleCount').textContent = idle;
  document.getElementById('fleetOfflineCount').textContent = offline;
  document.getElementById('fleetJobsToday').textContent = stats?.today || 0;
}

function updateFleetSummary() {
  const stats = { today: 0 };
  renderFleetSummary(fleetState.printers, stats);
}

// =============== PRINTER CARDS ===============

function renderPrinterCards(printers) {
  const grid = document.getElementById('fleetPrinterGrid');
  if (!printers.length) {
    grid.innerHTML = `<div class="placeholder" style="grid-column:1/-1;text-align:center;padding:60px 20px;color:var(--muted);">
      Click <strong>Add Printer</strong> to register your first 3D printer.
    </div>`;
    return;
  }
  grid.innerHTML = printers.map(p => renderPrinterCard(p)).join('');
}

/**
 * Derive the display state and color for a printer status.
 * Synthesizes states like "Heating" from temperature data when Klipper reports "standby".
 */
function fleetDeriveDisplayState(status) {
  const stateColors = {
    standby: 'var(--success)',
    printing: 'var(--accent)',
    paused: 'var(--warning)',
    error: 'var(--danger)',
    offline: 'var(--muted)',
    complete: 'var(--success)',
    cancelled: 'var(--muted)',
    heating: 'var(--warning)',
    unknown: 'var(--muted)'
  };

  const rawState = status.state || 'unknown';
  const extTemp = status.temperatures?.extruder;
  const bedTemp = status.temperatures?.bed;

  // Synthesize "heating" when standby but targets are set
  if (rawState === 'standby') {
    const nozzleHeating = extTemp && extTemp.target > 0 && extTemp.current < extTemp.target - 5;
    const bedHeating = bedTemp && bedTemp.target > 0 && bedTemp.current < bedTemp.target - 5;
    if (nozzleHeating || bedHeating) {
      return { label: 'Heating', color: stateColors.heating };
    }
  }

  return { label: rawState, color: stateColors[rawState] || stateColors.unknown };
}

/**
 * Build the activity message line from Moonraker's display_status.message and temp data.
 */
function fleetGetActivityMessage(status) {
  // If Moonraker provides a display message, use it
  if (status.message && status.message.trim()) {
    return status.message.trim();
  }

  const rawState = status.state || 'unknown';
  const extTemp = status.temperatures?.extruder;
  const bedTemp = status.temperatures?.bed;

  // Synthesize activity from temperature data
  if (rawState === 'standby' || rawState === 'printing') {
    const msgs = [];
    if (extTemp && extTemp.target > 0 && extTemp.current < extTemp.target - 5) {
      msgs.push(`Heating nozzle ${extTemp.current.toFixed(0)}/${extTemp.target.toFixed(0)}\u00b0C`);
    }
    if (bedTemp && bedTemp.target > 0 && bedTemp.current < bedTemp.target - 5) {
      msgs.push(`Heating bed ${bedTemp.current.toFixed(0)}/${bedTemp.target.toFixed(0)}\u00b0C`);
    }
    if (msgs.length) return msgs.join(' \u00b7 ');
  }

  if (rawState === 'complete' && status.filename) {
    return `Completed: ${status.filename}`;
  }

  return '';
}

/**
 * Build the progress block HTML.
 * Shows for printing, paused, and complete states.
 */
function fleetBuildProgressHtml(status) {
  const rawState = status.state || '';

  if (rawState === 'printing' || rawState === 'paused') {
    const pct = ((status.progress || 0) * 100).toFixed(1);
    const fname = fleetEscapeHtml(status.filename || 'Unknown file');
    return `
      <div style="margin-bottom:10px;" data-fleet-section="progress">
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;font-size:0.85rem;">
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px;" title="${fname}">${fname}</span>
          <span>${pct}%</span>
        </div>
        <div class="progress-bar-container" style="height:8px;margin-bottom:4px;">
          <div class="progress-bar${rawState === 'paused' ? ' warning' : ''}" style="width:${pct}%"></div>
        </div>
        <div style="font-size:0.8rem;color:var(--muted);">
          ${fleetFormatDuration(status.printDuration)} elapsed
          ${status.progress > 0.01 ? ' &middot; ETA ' + fleetFormatETA(status.printDuration, status.progress) : ''}
        </div>
      </div>`;
  }

  if (rawState === 'complete' && status.filename) {
    const fname = fleetEscapeHtml(status.filename);
    return `
      <div style="margin-bottom:10px;" data-fleet-section="progress">
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;font-size:0.85rem;">
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px;" title="${fname}">${fname}</span>
          <span style="color:var(--success);">100%</span>
        </div>
        <div class="progress-bar-container" style="height:8px;margin-bottom:4px;">
          <div class="progress-bar" style="width:100%;background:var(--success);"></div>
        </div>
        <div style="font-size:0.8rem;color:var(--muted);">
          ${fleetFormatDuration(status.totalDuration || status.printDuration)} total
        </div>
      </div>`;
  }

  return '';
}

/**
 * Build action buttons HTML based on state.
 */
function fleetBuildActionsHtml(status, printerId) {
  const state = status.state || '';
  let actionsHtml = '';
  if (state === 'standby' || state === 'complete' || state === 'cancelled') {
    actionsHtml = `<button class="secondary fleet-action" data-action="upload" data-printer="${printerId}" style="padding:4px 10px;font-size:0.8rem;">Upload &amp; Print</button>`;
  } else if (state === 'printing') {
    actionsHtml = `
      <button class="secondary fleet-action" data-action="pause" data-printer="${printerId}" style="padding:4px 10px;font-size:0.8rem;">Pause</button>
      <button class="secondary fleet-action" data-action="cancel" data-printer="${printerId}" style="padding:4px 10px;font-size:0.8rem;color:var(--warning);">Cancel</button>`;
  } else if (state === 'paused') {
    actionsHtml = `
      <button class="secondary fleet-action" data-action="resume" data-printer="${printerId}" style="padding:4px 10px;font-size:0.8rem;">Resume</button>
      <button class="secondary fleet-action" data-action="cancel" data-printer="${printerId}" style="padding:4px 10px;font-size:0.8rem;color:var(--warning);">Cancel</button>`;
  } else if (state === 'offline' || state === 'unknown' || !state) {
    actionsHtml = `<button class="secondary fleet-action" data-action="reconnect" data-printer="${printerId}" style="padding:4px 10px;font-size:0.8rem;">Reconnect</button>`;
  }
  return actionsHtml;
}

function renderPrinterCard(printer) {
  const status = printer.status || {};
  const displayState = fleetDeriveDisplayState(status);
  const extTemp = status.temperatures?.extruder;
  const bedTemp = status.temperatures?.bed;
  const activityMsg = fleetGetActivityMessage(status);
  const progressHtml = fleetBuildProgressHtml(status);
  const actionsHtml = fleetBuildActionsHtml(status, printer.id);

  let materialHtml = '';
  let aceSlots = [];
  try { aceSlots = printer.ace_slots ? JSON.parse(printer.ace_slots) : []; } catch (_) {}
  if (printer.has_multicolor && aceSlots.length) {
    const slotDots = aceSlots.map(s =>
      `<span style="font-size:0.8rem;" title="T${s.slot}: ${fleetEscapeHtml(s.name || '')}">T${s.slot}: ${fleetEscapeHtml(s.material || '?')} <span class="muted">(${fleetEscapeHtml(s.color || '?')})</span></span>`
    ).join(' &middot; ');
    materialHtml = `<div style="font-size:0.85rem;margin-bottom:10px;">${slotDots}</div>`;
  } else if (printer.loaded_material) {
    materialHtml = `
      <div style="font-size:0.85rem;margin-bottom:10px;">
        <span class="muted">Material:</span> ${fleetEscapeHtml(printer.loaded_material)}
        ${printer.loaded_color ? ` <span class="muted">(${fleetEscapeHtml(printer.loaded_color)})</span>` : ''}
      </div>`;
  }

  return `
    <div class="dashboard-card fleet-printer-card" data-printer-id="${printer.id}" id="fleetCard-${printer.id}">
      <div class="dashboard-card-header">
        <div>
          <h3 style="margin:0;">${fleetEscapeHtml(printer.name)}</h3>
          <span class="muted" style="font-size:0.75rem;">${fleetEscapeHtml(printer.model || '')}</span>
        </div>
        <span data-fleet-el="stateBlock" style="display:flex;align-items:center;gap:6px;">
          ${printer.has_multicolor ? '<span style="font-size:0.65rem;background:rgba(56,189,248,0.2);color:var(--accent);padding:2px 6px;border-radius:10px;">ACE</span>' : ''}
          <span data-fleet-el="stateDot" style="color:${displayState.color};font-size:1.1rem;">&#9679;</span>
          <span data-fleet-el="stateLabel" style="color:${displayState.color};font-size:0.85rem;text-transform:capitalize;">${displayState.label}</span>
        </span>
      </div>
      <div class="dashboard-card-body" style="padding:14px 18px;">
        <!-- Camera Snapshot -->
        <div style="margin-bottom:10px;border-radius:6px;overflow:hidden;background:var(--bg-secondary);min-height:40px;">
          <img class="fleet-snapshot-img"
               data-snapshot-url="${fleetState.webcamUrls[printer.id]?.snapshot || ''}"
               src="${fleetState.webcamUrls[printer.id]?.snapshot ? fleetState.webcamUrls[printer.id].snapshot + '&_t=' + Date.now() : ''}"
               style="${fleetState.webcamUrls[printer.id]?.snapshot ? '' : 'display:none;'}width:100%;border-radius:6px;aspect-ratio:4/3;object-fit:cover;"
               alt="Camera"
               onerror="this.style.display='none'">
        </div>
        <!-- Activity Message -->
        <div data-fleet-el="activity" style="font-size:0.8rem;color:var(--warning);margin-bottom:${activityMsg ? '8' : '0'}px;min-height:0;${activityMsg ? '' : 'display:none;'}">${fleetEscapeHtml(activityMsg)}</div>
        <!-- Temperatures -->
        <div data-fleet-el="temps" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;">
          <div style="font-size:0.85rem;">
            <span class="muted">Nozzle:</span>
            <strong data-fleet-el="nozzleTemp">${extTemp ? extTemp.current.toFixed(0) : '--'}</strong>&deg;C
            <span class="muted">/ <span data-fleet-el="nozzleTarget">${extTemp ? extTemp.target.toFixed(0) : '--'}</span>&deg;C</span>
          </div>
          <div style="font-size:0.85rem;">
            <span class="muted">Bed:</span>
            <strong data-fleet-el="bedTemp">${bedTemp ? bedTemp.current.toFixed(0) : '--'}</strong>&deg;C
            <span class="muted">/ <span data-fleet-el="bedTarget">${bedTemp ? bedTemp.target.toFixed(0) : '--'}</span>&deg;C</span>
          </div>
        </div>

        <div data-fleet-el="progressBlock">${progressHtml}</div>
        ${materialHtml}

        <!-- Quick Actions -->
        <div data-fleet-el="actions" style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
          ${actionsHtml}
          <button class="secondary fleet-action" data-action="detail" data-printer="${printer.id}" style="padding:4px 10px;font-size:0.8rem;margin-left:auto;">Details</button>
          <button class="secondary fleet-action" data-action="estop" data-printer="${printer.id}" style="padding:4px 10px;font-size:0.8rem;color:var(--danger);">E-STOP</button>
        </div>
      </div>
    </div>`;
}

// =============== REAL-TIME CARD UPDATES ===============

/**
 * Targeted DOM update — updates only the dynamic parts of the card without
 * rebuilding the entire element (preserves the camera snapshot <img>).
 */
function updatePrinterCardStatus(data) {
  // data = { printerId, apiUrl, state, temperatures, progress, ... }
  const printer = fleetState.printers.find(p => p.id === data.printerId);
  if (!printer) return;

  // Merge status into local state
  printer.status = {
    state: data.state,
    temperatures: data.temperatures,
    progress: data.progress,
    filename: data.filename,
    printDuration: data.printDuration,
    totalDuration: data.totalDuration,
    message: data.message,
    timestamp: data.timestamp
  };

  const card = document.getElementById(`fleetCard-${data.printerId}`);
  if (!card) return;

  const status = printer.status;
  const displayState = fleetDeriveDisplayState(status);
  const extTemp = status.temperatures?.extruder;
  const bedTemp = status.temperatures?.bed;

  // Update state dot + label
  const stateDot = card.querySelector('[data-fleet-el="stateDot"]');
  const stateLabel = card.querySelector('[data-fleet-el="stateLabel"]');
  if (stateDot) stateDot.style.color = displayState.color;
  if (stateLabel) { stateLabel.style.color = displayState.color; stateLabel.textContent = displayState.label; }

  // Update temperatures
  const nozzleEl = card.querySelector('[data-fleet-el="nozzleTemp"]');
  const nozzleTgtEl = card.querySelector('[data-fleet-el="nozzleTarget"]');
  const bedEl = card.querySelector('[data-fleet-el="bedTemp"]');
  const bedTgtEl = card.querySelector('[data-fleet-el="bedTarget"]');
  if (nozzleEl) nozzleEl.textContent = extTemp ? extTemp.current.toFixed(0) : '--';
  if (nozzleTgtEl) nozzleTgtEl.textContent = extTemp ? extTemp.target.toFixed(0) : '--';
  if (bedEl) bedEl.textContent = bedTemp ? bedTemp.current.toFixed(0) : '--';
  if (bedTgtEl) bedTgtEl.textContent = bedTemp ? bedTemp.target.toFixed(0) : '--';

  // Update activity message
  const activityEl = card.querySelector('[data-fleet-el="activity"]');
  if (activityEl) {
    const msg = fleetGetActivityMessage(status);
    activityEl.textContent = msg;
    activityEl.style.display = msg ? '' : 'none';
    activityEl.style.marginBottom = msg ? '8px' : '0';
  }

  // Update progress block
  const progressBlock = card.querySelector('[data-fleet-el="progressBlock"]');
  if (progressBlock) {
    progressBlock.innerHTML = fleetBuildProgressHtml(status);
  }

  // Update action buttons
  const actionsEl = card.querySelector('[data-fleet-el="actions"]');
  if (actionsEl) {
    const actionsHtml = fleetBuildActionsHtml(status, data.printerId);
    // Preserve the Details and E-STOP buttons (they don't change)
    actionsEl.innerHTML = `
      ${actionsHtml}
      <button class="secondary fleet-action" data-action="detail" data-printer="${data.printerId}" style="padding:4px 10px;font-size:0.8rem;margin-left:auto;">Details</button>
      <button class="secondary fleet-action" data-action="estop" data-printer="${data.printerId}" style="padding:4px 10px;font-size:0.8rem;color:var(--danger);">E-STOP</button>
    `;
  }

  // Update summary counts
  updateFleetSummary();
}

// =============== JOBS LIST ===============

function renderJobsList() {
  const container = document.getElementById('fleetJobsList');
  let jobs = fleetState.jobs;
  if (fleetState.jobFilter) {
    jobs = jobs.filter(j => j.status === fleetState.jobFilter);
  }

  if (!jobs.length) {
    container.innerHTML = `<div class="muted" style="text-align:center;padding:20px;">No ${fleetState.jobFilter || ''} jobs found</div>`;
    return;
  }

  container.innerHTML = `
    <table class="inventory-table" style="width:100%;">
      <thead>
        <tr>
          <th>Printer</th>
          <th>File</th>
          <th>Status</th>
          <th>Progress</th>
          <th>Duration</th>
          <th>Started</th>
        </tr>
      </thead>
      <tbody>
        ${jobs.map(j => {
          const statusColors = {
            printing: 'var(--accent)',
            paused: 'var(--warning)',
            completed: 'var(--success)',
            cancelled: 'var(--muted)',
            error: 'var(--danger)',
            queued: 'var(--text)'
          };
          const color = statusColors[j.status] || 'var(--text)';
          return `<tr>
            <td>${fleetEscapeHtml(j.printer_name || 'Unknown')}</td>
            <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${fleetEscapeHtml(j.filename)}">${fleetEscapeHtml(j.filename)}</td>
            <td><span style="color:${color};text-transform:capitalize;">${j.status}</span></td>
            <td>${j.status === 'completed' ? '100%' : ((j.progress || 0) * 100).toFixed(1) + '%'}</td>
            <td>${fleetFormatDuration(j.print_duration)}</td>
            <td>${j.started_at ? new Date(j.started_at).toLocaleString() : '--'}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

// =============== ACE SLOT PICKER ===============

/**
 * If the printer has a multi-color ACE hub, show a slot picker popup and return the selected slot number.
 * Returns null if the printer has no ACE, or the user cancels.
 */
function fleetPickAceSlot(printer) {
  return new Promise((resolve) => {
    let aceSlots = [];
    try { aceSlots = printer.ace_slots ? JSON.parse(printer.ace_slots) : []; } catch (_) {}

    if (!printer.has_multicolor || !aceSlots.length) {
      resolve(null);
      return;
    }

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;';
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--card,#1e293b);border-radius:12px;padding:24px;width:360px;max-width:90vw;';
    modal.innerHTML = `
      <h3 style="margin:0 0 12px;">Select Filament Slot</h3>
      <p class="muted" style="margin:0 0 16px;font-size:0.85rem;">Choose which ACE slot to use for this print.</p>
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:20px;">
        ${aceSlots.map(s => `
          <button class="secondary fleet-ace-pick" data-slot="${s.slot}" style="padding:10px 14px;text-align:left;display:flex;justify-content:space-between;align-items:center;">
            <span><strong>T${s.slot}</strong>: ${fleetEscapeHtml(s.name || s.material || '?')}</span>
            <span class="muted" style="font-size:0.85rem;">${fleetEscapeHtml(s.color || '')}</span>
          </button>
        `).join('')}
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button class="secondary fleet-ace-cancel" style="padding:6px 16px;">Cancel</button>
      </div>
    `;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    modal.querySelectorAll('.fleet-ace-pick').forEach(btn => {
      btn.addEventListener('click', () => {
        overlay.remove();
        resolve(parseInt(btn.dataset.slot, 10));
      });
    });
    modal.querySelector('.fleet-ace-cancel').addEventListener('click', () => {
      overlay.remove();
      resolve(null);
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) { overlay.remove(); resolve(null); }
    });
  });
}

// =============== EVENT HANDLERS ===============

async function handlePrinterGridClick(e) {
  const btn = e.target.closest('.fleet-action');
  if (!btn) return;

  const action = btn.dataset.action;
  const printerId = parseInt(btn.dataset.printer);

  try {
    switch (action) {
      case 'upload': {
        const filePath = await printStation.printerFleet.selectGcodeFile();
        if (!filePath) return;
        showToast('Uploading G-code...', 'info');
        await printStation.printerFleet.uploadGcode(printerId, filePath);
        showToast('File uploaded!', 'success');
        // Ask if they want to start the print
        const fname = filePath.split(/[\\/]/).pop();
        const confirmed = await printStation.showConfirm(`Start printing "${fname}"?`, 'Start Print');
        if (confirmed) {
          const printer = fleetState.printers.find(p => p.id === printerId);
          const aceSlot = printer ? await fleetPickAceSlot(printer) : null;
          await printStation.printerFleet.startPrint(printerId, fname, null, aceSlot);
          showToast('Print started!', 'success');
        }
        loadFleetData();
        break;
      }
      case 'pause':
        await printStation.printerFleet.pausePrint(printerId);
        showToast('Print paused', 'info');
        break;
      case 'resume':
        await printStation.printerFleet.resumePrint(printerId);
        showToast('Print resumed', 'info');
        break;
      case 'cancel': {
        const confirmed = await printStation.showConfirm('Cancel this print? The print will be stopped.', 'Cancel Print');
        if (confirmed) {
          await printStation.printerFleet.cancelPrint(printerId);
          showToast('Print cancelled', 'warning');
          loadFleetData();
        }
        break;
      }
      case 'estop': {
        const confirmed = await printStation.showConfirm(
          'EMERGENCY STOP will immediately halt the printer.\nThis may damage the current print.\n\nContinue?',
          'Emergency Stop'
        );
        if (confirmed) {
          await printStation.printerFleet.emergencyStop(printerId);
          showToast('Emergency stop sent!', 'error');
          loadFleetData();
        }
        break;
      }
      case 'reconnect':
        showToast('Reconnecting...', 'info');
        await printStation.printerFleet.reconnect(printerId);
        setTimeout(loadFleetData, 2000);
        break;
      case 'detail':
        showPrinterDetailModal(printerId);
        break;
    }
  } catch (err) {
    console.error('[Fleet] Action error:', err);
    showToast('Error: ' + err.message, 'error');
  }
}

// =============== ADD PRINTER MODAL ===============

function showAddPrinterModal(editPrinter = null) {
  const isEdit = editPrinter && editPrinter.id;
  const existing = document.getElementById('fleetAddModal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'fleetAddModal';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-dialog" style="width:min(520px,92vw);">
      <div class="modal-header">
        <h3 style="margin:0;">${isEdit ? 'Edit Printer' : 'Add Printer'}</h3>
        <button class="secondary fleet-modal-close" style="padding:4px 10px;font-size:0.9rem;">&times;</button>
      </div>
      <div class="modal-body">
        <div style="display:flex;flex-direction:column;gap:14px;">
          <div>
            <label style="font-size:0.85rem;color:var(--muted);display:block;margin-bottom:4px;">Printer Name</label>
            <input id="fleetAddName" type="text" style="width:100%;" value="${fleetEscapeHtml(isEdit ? editPrinter.name : '')}" placeholder="e.g. Kobra 3 #1">
          </div>
          <div>
            <label style="font-size:0.85rem;color:var(--muted);display:block;margin-bottom:4px;">Model</label>
            <select id="fleetAddModel" style="width:100%;padding:8px 12px;">
              <option value="kobra3"${isEdit && editPrinter.model === 'kobra3' ? ' selected' : ''}>Kobra 3</option>
              <option value="kobra3_v2"${isEdit && editPrinter.model === 'kobra3_v2' ? ' selected' : ''}>Kobra 3 V2</option>
              <option value="ender3_s1pro"${isEdit && editPrinter.model === 'ender3_s1pro' ? ' selected' : ''}>Ender 3 S1 Pro</option>
              <option value="ender3_v3_ke"${isEdit && editPrinter.model === 'ender3_v3_ke' ? ' selected' : ''}>Ender 3 V3 KE</option>
              <option value="other"${isEdit && !['kobra3','kobra3_v2','ender3_s1pro','ender3_v3_ke'].includes(editPrinter.model) ? ' selected' : ''}>Other</option>
            </select>
          </div>
          <div>
            <label style="font-size:0.85rem;color:var(--muted);display:block;margin-bottom:4px;">Moonraker URL (ip:port)</label>
            <input id="fleetAddUrl" type="text" style="width:100%;" value="${fleetEscapeHtml(isEdit ? editPrinter.api_url : '')}" placeholder="e.g. http://192.168.0.109:7125">
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
            <div>
              <label style="font-size:0.85rem;color:var(--muted);display:block;margin-bottom:4px;">Width (mm)</label>
              <input id="fleetAddWidth" type="number" style="width:100%;" value="${isEdit ? editPrinter.build_width : 250}">
            </div>
            <div>
              <label style="font-size:0.85rem;color:var(--muted);display:block;margin-bottom:4px;">Depth (mm)</label>
              <input id="fleetAddDepth" type="number" style="width:100%;" value="${isEdit ? editPrinter.build_depth : 250}">
            </div>
            <div>
              <label style="font-size:0.85rem;color:var(--muted);display:block;margin-bottom:4px;">Height (mm)</label>
              <input id="fleetAddHeight" type="number" style="width:100%;" value="${isEdit ? editPrinter.build_height : 260}">
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
            <div>
              <label style="font-size:0.85rem;color:var(--muted);display:block;margin-bottom:4px;">Material</label>
              <select id="fleetAddMaterial" style="width:100%;padding:8px 12px;">
                <option value="PLA"${isEdit && editPrinter.loaded_material === 'PLA' ? ' selected' : ''}>PLA</option>
                <option value="PETG"${isEdit && editPrinter.loaded_material === 'PETG' ? ' selected' : ''}>PETG</option>
                <option value="ABS"${isEdit && editPrinter.loaded_material === 'ABS' ? ' selected' : ''}>ABS</option>
                <option value="TPU"${isEdit && editPrinter.loaded_material === 'TPU' ? ' selected' : ''}>TPU</option>
                <option value="ASA"${isEdit && editPrinter.loaded_material === 'ASA' ? ' selected' : ''}>ASA</option>
                <option value="RAPID_PLA"${isEdit && editPrinter.loaded_material === 'RAPID_PLA' ? ' selected' : ''}>Rapid PLA</option>
                <option value="RAPID_PETG"${isEdit && editPrinter.loaded_material === 'RAPID_PETG' ? ' selected' : ''}>Rapid PETG</option>
              </select>
            </div>
            <div>
              <label style="font-size:0.85rem;color:var(--muted);display:block;margin-bottom:4px;">Color</label>
              <input id="fleetAddColor" type="text" style="width:100%;" value="${fleetEscapeHtml(isEdit ? (editPrinter.loaded_color || '') : 'White')}" placeholder="e.g. White">
            </div>
          </div>
          <div>
            <label style="display:flex;align-items:center;gap:8px;font-size:0.9rem;cursor:pointer;">
              <input id="fleetAddMulticolor" type="checkbox"${isEdit ? (editPrinter.has_multicolor ? ' checked' : '') : ''}>
              Multi-Color (ACE unit)
            </label>
          </div>
          <div id="fleetAceSlots" style="display:${isEdit && editPrinter.has_multicolor ? 'block' : 'none'};border:1px solid var(--border);border-radius:8px;padding:12px;">
            <label style="font-size:0.85rem;color:var(--muted);display:block;margin-bottom:8px;">ACE Filament Slots</label>
            ${[0,1,2,3].map(i => {
              let slot = { material: 'PLA', color: 'White', name: '' };
              if (isEdit) {
                try {
                  const slots = JSON.parse(editPrinter.ace_slots || '[]');
                  const found = slots.find(s => s.slot === i);
                  if (found) slot = found;
                } catch (_) {}
              }
              return `
              <div style="display:grid;grid-template-columns:auto 1fr 80px 1fr;gap:6px;align-items:center;margin-bottom:6px;">
                <span style="font-size:0.85rem;font-weight:600;min-width:28px;">T${i}</span>
                <select class="fleet-ace-material" data-slot="${i}" style="padding:6px 8px;font-size:0.85rem;">
                  <option value="PLA"${slot.material === 'PLA' ? ' selected' : ''}>PLA</option>
                  <option value="PETG"${slot.material === 'PETG' ? ' selected' : ''}>PETG</option>
                  <option value="ABS"${slot.material === 'ABS' ? ' selected' : ''}>ABS</option>
                  <option value="TPU"${slot.material === 'TPU' ? ' selected' : ''}>TPU</option>
                  <option value="ASA"${slot.material === 'ASA' ? ' selected' : ''}>ASA</option>
                  <option value="RAPID_PLA"${slot.material === 'RAPID_PLA' ? ' selected' : ''}>Rapid PLA</option>
                  <option value="RAPID_PETG"${slot.material === 'RAPID_PETG' ? ' selected' : ''}>Rapid PETG</option>
                </select>
                <input class="fleet-ace-color" data-slot="${i}" type="text" style="padding:6px 8px;font-size:0.85rem;" value="${fleetEscapeHtml(slot.color || '')}" placeholder="Color">
                <input class="fleet-ace-name" data-slot="${i}" type="text" style="padding:6px 8px;font-size:0.85rem;" value="${fleetEscapeHtml(slot.name || '')}" placeholder="Label (e.g. White PLA)">
              </div>`;
            }).join('')}
          </div>
          <div id="fleetTestResult" style="display:none;"></div>
        </div>
      </div>
      <div class="modal-footer">
        <button id="fleetTestBtn" class="secondary" style="margin-right:auto;">Test Connection</button>
        <button class="secondary fleet-modal-close">Cancel</button>
        <button id="fleetSaveBtn" class="primary">${isEdit ? 'Save' : 'Add Printer'}</button>
      </div>
    </div>`;

  document.body.appendChild(modal);

  // Toggle ACE slots visibility when multicolor checkbox changes
  document.getElementById('fleetAddMulticolor').addEventListener('change', (e) => {
    document.getElementById('fleetAceSlots').style.display = e.target.checked ? 'block' : 'none';
  });

  // Close
  modal.querySelectorAll('.fleet-modal-close').forEach(btn => {
    btn.addEventListener('click', () => modal.remove());
  });
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });

  // Test connection
  document.getElementById('fleetTestBtn').addEventListener('click', async () => {
    const apiUrl = document.getElementById('fleetAddUrl').value.trim();
    if (!apiUrl) { showToast('Enter a Moonraker URL first', 'warning'); return; }
    const resultDiv = document.getElementById('fleetTestResult');
    resultDiv.style.display = 'block';
    resultDiv.className = 'status-bar';
    resultDiv.textContent = 'Testing connection...';
    try {
      const res = await printStation.printerFleet.testConnection(apiUrl);
      if (res.success) {
        resultDiv.className = 'status-bar success';
        let msg = `Connected! State: ${res.status?.state || 'unknown'}, Klippy: ${res.info?.state || 'unknown'}`;
        if (res.buildVolume) {
          msg += ` | Bed: ${res.buildVolume.width}×${res.buildVolume.depth}×${res.buildVolume.height}mm`;
          // Auto-populate the build dimension fields
          const widthInput = document.getElementById('fleetAddWidth');
          const depthInput = document.getElementById('fleetAddDepth');
          const heightInput = document.getElementById('fleetAddHeight');
          if (widthInput) widthInput.value = res.buildVolume.width;
          if (depthInput) depthInput.value = res.buildVolume.depth;
          if (heightInput) heightInput.value = res.buildVolume.height;
        }
      } else {
        resultDiv.className = 'status-bar error';
        resultDiv.textContent = `Failed: ${res.error}`;
      }
    } catch (err) {
      resultDiv.className = 'status-bar error';
      resultDiv.textContent = `Error: ${err.message}`;
    }
  });

  // Save
  document.getElementById('fleetSaveBtn').addEventListener('click', async () => {
    const name = document.getElementById('fleetAddName').value.trim();
    const apiUrl = document.getElementById('fleetAddUrl').value.trim();
    if (!name || !apiUrl) { showToast('Name and URL are required', 'warning'); return; }

    const printer = {
      name,
      model: document.getElementById('fleetAddModel').value,
      api_url: apiUrl.startsWith('http') ? apiUrl : `http://${apiUrl}`,
      has_multicolor: document.getElementById('fleetAddMulticolor').checked,
      build_width: parseInt(document.getElementById('fleetAddWidth').value) || 220,
      build_depth: parseInt(document.getElementById('fleetAddDepth').value) || 220,
      build_height: parseInt(document.getElementById('fleetAddHeight').value) || 250,
      loaded_material: document.getElementById('fleetAddMaterial').value,
      loaded_color: document.getElementById('fleetAddColor').value.trim(),
      active: true
    };

    // Collect ACE slot data if multicolor is checked
    if (printer.has_multicolor) {
      const aceSlots = [0,1,2,3].map(i => ({
        slot: i,
        material: modal.querySelector(`.fleet-ace-material[data-slot="${i}"]`)?.value || 'PLA',
        color: modal.querySelector(`.fleet-ace-color[data-slot="${i}"]`)?.value.trim() || '',
        name: modal.querySelector(`.fleet-ace-name[data-slot="${i}"]`)?.value.trim() || ''
      }));
      printer.ace_slots = JSON.stringify(aceSlots);
    } else {
      printer.ace_slots = '[]';
    }

    try {
      if (isEdit) {
        await printStation.printerFleet.updatePrinter(editPrinter.id, printer);
        showToast('Printer updated', 'success');
      } else {
        await printStation.printerFleet.upsertPrinter(printer);
        showToast('Printer added!', 'success');
      }
      modal.remove();
      loadFleetData();
    } catch (err) {
      showToast('Failed: ' + err.message, 'error');
    }
  });
}

// =============== PRINTER DETAIL MODAL ===============

async function showPrinterDetailModal(printerId) {
  const printer = fleetState.printers.find(p => p.id === printerId);
  if (!printer) return;

  const existing = document.getElementById('fleetDetailModal');
  if (existing) existing.remove();

  // Load files and history
  let files = [];
  let history = [];
  try {
    [files, history] = await Promise.all([
      printStation.printerFleet.listFiles(printerId).catch(() => []),
      printStation.printerFleet.listJobs({ printerId, limit: 20 }).catch(() => [])
    ]);
  } catch (_) {}

  const modal = document.createElement('div');
  modal.id = 'fleetDetailModal';
  modal.className = 'fleet-detail-modal';
  modal.innerHTML = `
    <div class="fleet-detail-content">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
        <div>
          <h2 style="margin:0;">${fleetEscapeHtml(printer.name)}</h2>
          <span class="muted">${fleetEscapeHtml(printer.model || '')} &middot; ${fleetEscapeHtml(printer.api_url)}</span>
        </div>
        <div style="display:flex;gap:8px;">
          <button class="secondary" id="fleetDetailEdit" style="padding:6px 12px;">Edit</button>
          <button class="secondary" id="fleetDetailDelete" style="padding:6px 12px;color:var(--danger);">Delete</button>
          <button class="secondary fleet-detail-close" style="padding:6px 12px;font-size:1.1rem;">&times;</button>
        </div>
      </div>

      <!-- Live Camera View -->
      <div id="fleetDetailCamContainer" style="margin-bottom:16px;border-radius:8px;overflow:hidden;background:var(--bg-secondary);text-align:center;display:none;">
        <img id="fleetDetailStream" style="width:100%;border-radius:8px;aspect-ratio:4/3;object-fit:contain;" alt="Live Camera">
      </div>

      <!-- Build Volume -->
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px;">
        <div class="dashboard-stat-item">
          <span class="stat-value">${printer.build_width || '--'}</span>
          <span class="stat-label">Width (mm)</span>
        </div>
        <div class="dashboard-stat-item">
          <span class="stat-value">${printer.build_depth || '--'}</span>
          <span class="stat-label">Depth (mm)</span>
        </div>
        <div class="dashboard-stat-item">
          <span class="stat-value">${printer.build_height || '--'}</span>
          <span class="stat-label">Height (mm)</span>
        </div>
        <div class="dashboard-stat-item">
          <span class="stat-value">${printer.loaded_material || '--'}</span>
          <span class="stat-label">Material</span>
        </div>
      </div>

      <!-- Files on Printer -->
      <div class="inventory-card" style="margin-bottom:16px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <h3 style="margin:0;">Files on Printer</h3>
          <button class="secondary" id="fleetDetailUpload" style="padding:4px 10px;font-size:0.85rem;">Upload G-code</button>
        </div>
        <div id="fleetDetailFiles" style="max-height:200px;overflow-y:auto;">
          ${files.length ? files.map(f => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);">
              <span style="font-size:0.85rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:50%;" title="${fleetEscapeHtml(f.path || f.filename)}">${fleetEscapeHtml(f.path || f.filename || '')}</span>
              <div style="display:flex;gap:6px;align-items:center;">
                <span class="muted" style="font-size:0.8rem;">${fleetFormatSize(f.size)}</span>
                <button class="secondary fleet-file-print" data-file="${fleetEscapeHtml(f.path || f.filename)}" style="padding:2px 8px;font-size:0.8rem;">Print</button>
                <button class="secondary fleet-file-delete" data-file="${fleetEscapeHtml(f.path || f.filename)}" style="padding:2px 8px;font-size:0.8rem;color:var(--danger);">Del</button>
              </div>
            </div>
          `).join('') : '<div class="muted" style="padding:10px;text-align:center;">No files on printer</div>'}
        </div>
      </div>

      <!-- G-code Console -->
      <div class="inventory-card" style="margin-bottom:16px;">
        <h3 style="margin:0 0 10px 0;">G-code Console</h3>
        <div id="fleetGcodeLog" class="fleet-gcode-console" style="margin-bottom:8px;">Ready.</div>
        <div style="display:flex;gap:6px;">
          <input id="fleetGcodeInput" type="text" style="flex:1;" placeholder="Enter G-code (e.g. G28, M104 S200)">
          <button id="fleetGcodeSend" class="primary" style="padding:6px 14px;">Send</button>
        </div>
        <div style="display:flex;gap:4px;margin-top:6px;flex-wrap:wrap;">
          <button class="secondary fleet-gcode-quick" data-cmd="G28" style="padding:2px 8px;font-size:0.8rem;">Home</button>
          <button class="secondary fleet-gcode-quick" data-cmd="M104 S0" style="padding:2px 8px;font-size:0.8rem;">Nozzle Off</button>
          <button class="secondary fleet-gcode-quick" data-cmd="M140 S0" style="padding:2px 8px;font-size:0.8rem;">Bed Off</button>
          <button class="secondary fleet-gcode-quick" data-cmd="M84" style="padding:2px 8px;font-size:0.8rem;">Motors Off</button>
          <button class="secondary fleet-gcode-quick" data-cmd="M106 S0" style="padding:2px 8px;font-size:0.8rem;">Fan Off</button>
        </div>
      </div>

      <!-- Print History -->
      <div class="inventory-card">
        <h3 style="margin:0 0 10px 0;">Print History</h3>
        <div style="max-height:200px;overflow-y:auto;">
          ${history.length ? `
            <table class="inventory-table" style="width:100%;">
              <thead>
                <tr><th>File</th><th>Status</th><th>Duration</th><th>Date</th></tr>
              </thead>
              <tbody>
                ${history.map(j => `
                  <tr>
                    <td style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${fleetEscapeHtml(j.filename)}</td>
                    <td style="text-transform:capitalize;">${j.status}</td>
                    <td>${fleetFormatDuration(j.print_duration)}</td>
                    <td>${j.created_at ? new Date(j.created_at).toLocaleDateString() : '--'}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          ` : '<div class="muted" style="padding:10px;text-align:center;">No print history</div>'}
        </div>
      </div>
    </div>`;

  document.body.appendChild(modal);

  // Load live camera stream
  (async () => {
    try {
      const urls = fleetState.webcamUrls[printerId] || await printStation.printerFleet.getWebcamUrls(printerId);
      if (urls) fleetState.webcamUrls[printerId] = urls;
      const streamImg = document.getElementById('fleetDetailStream');
      const container = document.getElementById('fleetDetailCamContainer');
      if (streamImg && container && urls?.stream) {
        streamImg.src = urls.stream;
        // Apply rotation/flip transforms
        const transforms = [];
        if (urls.rotation) transforms.push(`rotate(${urls.rotation}deg)`);
        if (urls.flipH) transforms.push('scaleX(-1)');
        if (urls.flipV) transforms.push('scaleY(-1)');
        if (transforms.length) streamImg.style.transform = transforms.join(' ');
        container.style.display = '';
        streamImg.onerror = () => { container.style.display = 'none'; };
      }
    } catch (_) {}
  })();

  // Close — also stop stream to free resources
  modal.querySelectorAll('.fleet-detail-close').forEach(btn => btn.addEventListener('click', () => {
    const streamImg = document.getElementById('fleetDetailStream');
    if (streamImg) streamImg.src = '';
    modal.remove();
  }));
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      const streamImg = document.getElementById('fleetDetailStream');
      if (streamImg) streamImg.src = '';
      modal.remove();
    }
  });

  // Edit
  document.getElementById('fleetDetailEdit').addEventListener('click', () => {
    const streamImg = document.getElementById('fleetDetailStream');
    if (streamImg) streamImg.src = '';
    modal.remove();
    showAddPrinterModal(printer);
  });

  // Delete
  document.getElementById('fleetDetailDelete').addEventListener('click', async () => {
    const confirmed = await printStation.showConfirm(`Delete printer "${printer.name}"? This will also delete all job history for this printer.`, 'Delete Printer');
    if (confirmed) {
      await printStation.printerFleet.removePrinter(printerId);
      showToast('Printer removed', 'info');
      modal.remove();
      loadFleetData();
    }
  });

  // Upload from detail
  document.getElementById('fleetDetailUpload').addEventListener('click', async () => {
    const filePath = await printStation.printerFleet.selectGcodeFile();
    if (!filePath) return;
    showToast('Uploading...', 'info');
    try {
      await printStation.printerFleet.uploadGcode(printerId, filePath);
      showToast('Uploaded!', 'success');
      showPrinterDetailModal(printerId); // refresh
    } catch (err) {
      showToast('Upload failed: ' + err.message, 'error');
    }
  });

  // File actions
  modal.querySelectorAll('.fleet-file-print').forEach(btn => {
    btn.addEventListener('click', async () => {
      const filename = btn.dataset.file;
      const confirmed = await printStation.showConfirm(`Start printing "${filename}"?`, 'Start Print');
      if (confirmed) {
        try {
          const aceSlot = await fleetPickAceSlot(printer);
          await printStation.printerFleet.startPrint(printerId, filename, null, aceSlot);
          showToast('Print started!', 'success');
          modal.remove();
          loadFleetData();
        } catch (err) {
          showToast('Failed to start: ' + err.message, 'error');
        }
      }
    });
  });

  modal.querySelectorAll('.fleet-file-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const filename = btn.dataset.file;
      const confirmed = await printStation.showConfirm(`Delete "${filename}" from the printer?`, 'Delete File');
      if (confirmed) {
        try {
          await printStation.printerFleet.deleteFile(printerId, filename);
          showToast('File deleted', 'info');
          showPrinterDetailModal(printerId); // refresh
        } catch (err) {
          showToast('Delete failed: ' + err.message, 'error');
        }
      }
    });
  });

  // G-code console
  const gcodeLog = document.getElementById('fleetGcodeLog');
  const gcodeInput = document.getElementById('fleetGcodeInput');

  function appendGcodeLog(text, type = 'info') {
    const colors = { info: '#0f0', error: '#f87171', sent: '#38bdf8' };
    gcodeLog.innerHTML += `<div style="color:${colors[type] || '#0f0'};">${fleetEscapeHtml(text)}</div>`;
    gcodeLog.scrollTop = gcodeLog.scrollHeight;
  }

  async function sendGcodeCommand(command) {
    if (!command.trim()) return;
    appendGcodeLog(`> ${command}`, 'sent');
    try {
      await printStation.printerFleet.sendGcode(printerId, command);
      appendGcodeLog('OK', 'info');
    } catch (err) {
      appendGcodeLog(`Error: ${err.message}`, 'error');
    }
  }

  document.getElementById('fleetGcodeSend').addEventListener('click', () => {
    sendGcodeCommand(gcodeInput.value);
    gcodeInput.value = '';
    gcodeInput.focus();
  });

  gcodeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      sendGcodeCommand(gcodeInput.value);
      gcodeInput.value = '';
    }
  });

  modal.querySelectorAll('.fleet-gcode-quick').forEach(btn => {
    btn.addEventListener('click', () => sendGcodeCommand(btn.dataset.cmd));
  });
}

// =============== HELPERS ===============

function fleetFormatDuration(seconds) {
  if (!seconds) return '--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function fleetFormatETA(elapsed, progress) {
  if (!progress || progress <= 0) return '--';
  const total = elapsed / progress;
  const remaining = total - elapsed;
  if (remaining <= 0) return '< 1m';
  return fleetFormatDuration(remaining);
}

function fleetFormatSize(bytes) {
  if (!bytes) return '--';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function fleetEscapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}
