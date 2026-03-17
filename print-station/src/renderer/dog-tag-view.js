/**
 * BRCC Dog Tag Generator View — v2
 * ============================================================
 * Canvas-based tag designer with draggable text positioning,
 * real-time preview, batch queue, and slicer integration.
 * ============================================================
 */

const DT = {
  initialized: false,
  shapes: [],
  shapeGeo: {},
  defaults: {},
  selectedShape: 'bone',
  petName: '',
  colorIdx: 0,
  // Text position in mm (null = use shape default)
  textCx: null,
  textCy: null,
  textSz: null,
  // Drag state
  dragging: false,
  dragStartMm: null,
  // Canvas
  canvas: null,
  ctx: null,
  scale: 6, // px per mm
  // Slicer
  openscadAvailable: false,
  generating: false,
  // Batch
  batchQueue: [],
  // History
  history: [],
  lastGenResult: null,
};

const COLOR_PRESETS = [
  { base: '#ffffff', insert: '#222222', label: 'White + Black', baseLabel: 'White', insertLabel: 'Black' },
  { base: '#222222', insert: '#ffffff', label: 'Black + White', baseLabel: 'Black', insertLabel: 'White' },
  { base: '#1a1a2e', insert: '#e8b931', label: 'Navy + Gold', baseLabel: 'Navy', insertLabel: 'Gold' },
  { base: '#8b0000', insert: '#ffffff', label: 'Red + White', baseLabel: 'Red', insertLabel: 'White' },
  { base: '#2d5016', insert: '#f5f5dc', label: 'Green + Cream', baseLabel: 'Green', insertLabel: 'Cream' },
  { base: '#4a90d9', insert: '#ffffff', label: 'Blue + White', baseLabel: 'Blue', insertLabel: 'White' },
];

// ═══════════════════════════════════════════════════════════════
// SHAPE DRAWING — Canvas 2D paths matching OpenSCAD geometry
// ═══════════════════════════════════════════════════════════════

function dtDrawShapePath(ctx, shape, scale) {
  ctx.beginPath();
  switch (shape) {
    case 'bone': {
      // Shaft: rounded rect + knobs at each end
      const sl = 32, sw = 10, er = 5;
      // Main shaft (rounded rect)
      const hr = sw / 2;
      ctx.moveTo(-sl/2 + hr, -hr);
      ctx.lineTo(sl/2 - hr, -hr);
      ctx.arc(sl/2 - hr, 0, hr, -Math.PI/2, Math.PI/2);
      ctx.lineTo(-sl/2 + hr, hr);
      ctx.arc(-sl/2 + hr, 0, hr, Math.PI/2, -Math.PI/2);
      ctx.closePath();
      // Knobs at each end
      const knobAngles = [45, 135, 225, 315];
      for (const ex of [-sl/2, sl/2]) {
        for (const angle of knobAngles) {
          const rad = angle * Math.PI / 180;
          const cx = ex + Math.cos(rad) * 6;
          const cy = Math.sin(rad) * 6;
          ctx.moveTo(cx + er, cy);
          ctx.arc(cx, cy, er, 0, Math.PI * 2);
        }
      }
      break;
    }
    case 'shield': {
      const w = 40, h = 50, tr = 5;
      ctx.moveTo(0, -h/2 + 3);
      ctx.lineTo(w/2 - tr, h/2 - tr);
      ctx.arc(w/2 - tr, h/2 - tr, tr, 0, Math.PI/2);
      ctx.lineTo(-w/2 + tr, h/2);
      ctx.arc(-w/2 + tr, h/2 - tr, tr, Math.PI/2, Math.PI);
      ctx.closePath();
      break;
    }
    case 'heart': {
      const s = 1.15;
      ctx.save();
      ctx.scale(s, s);
      // Two lobes + bottom point
      ctx.arc(-10, 0, 10, Math.PI, 0);
      ctx.arc(10, 0, 10, Math.PI, 0);
      ctx.lineTo(20, 0);
      ctx.lineTo(0, -22);
      ctx.lineTo(-20, 0);
      ctx.closePath();
      ctx.restore();
      break;
    }
    case 'paw': {
      ctx.arc(0, 0, 22, 0, Math.PI * 2);
      ctx.closePath();
      break;
    }
    case 'hydrant': {
      // Simplified hydrant outline
      const pts = [
        [-15, -22], [15, -22], [15, -14], // base
        [12, -14], [12, -4], [18, -4], [18, 2], [12, 2], // right nozzle area
        [10, 2], [10, 8], [9, 12], // body
        [9, 15], // top cylinder
      ];
      // Draw as rounded rect stack
      // Base plate
      dtRoundRect(ctx, -15, -22, 30, 8, 2);
      ctx.closePath();
      ctx.moveTo(0, 0);
      // Body
      dtRoundRect(ctx, -12, -14, 24, 12, 2);
      ctx.closePath();
      ctx.moveTo(0, 0);
      // Upper body
      dtRoundRect(ctx, -10, -4, 20, 12, 2);
      ctx.closePath();
      ctx.moveTo(0, 0);
      // Top
      dtRoundRect(ctx, -9, 8, 18, 4, 1);
      ctx.closePath();
      ctx.moveTo(0, 0);
      // Dome
      ctx.arc(0, 15, 7, 0, Math.PI * 2);
      ctx.closePath();
      // Side nozzles
      ctx.moveTo(0, 0);
      ctx.arc(-14, -0, 4, 0, Math.PI * 2);
      ctx.closePath();
      ctx.moveTo(0, 0);
      ctx.arc(14, -0, 4, 0, Math.PI * 2);
      ctx.closePath();
      break;
    }
    case 'star': {
      const points = 5, outerR = 24, innerR = 11;
      for (let i = 0; i < points * 2; i++) {
        const angle = (Math.PI * 2 / (points * 2)) * i - Math.PI / 2;
        const r = i % 2 === 0 ? outerR : innerR;
        const x = Math.cos(angle) * r;
        const y = Math.sin(angle) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      break;
    }
  }
}

function dtRoundRect(ctx, x, y, w, h, r) {
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arc(x + w - r, y + r, r, -Math.PI/2, 0);
  ctx.lineTo(x + w, y + h - r);
  ctx.arc(x + w - r, y + h - r, r, 0, Math.PI/2);
  ctx.lineTo(x + r, y + h);
  ctx.arc(x + r, y + h - r, r, Math.PI/2, Math.PI);
  ctx.lineTo(x, y + r);
  ctx.arc(x + r, y + r, r, Math.PI, -Math.PI/2);
}

// ═══════════════════════════════════════════════════════════════
// CANVAS RENDERING
// ═══════════════════════════════════════════════════════════════

function dtRender() {
  const { canvas, ctx, scale } = DT;
  if (!canvas || !ctx) return;

  const w = canvas.width;
  const h = canvas.height;
  const colors = COLOR_PRESETS[DT.colorIdx] || COLOR_PRESETS[0];
  const geo = DT.shapeGeo[DT.selectedShape];
  if (!geo) return;

  // Get effective text position
  const tcx = DT.textCx !== null ? DT.textCx : geo.textCx;
  const tcy = DT.textCy !== null ? DT.textCy : geo.textCy;
  const tsz = DT.textSz !== null ? DT.textSz : geo.textSz;

  ctx.clearRect(0, 0, w, h);

  // Background
  ctx.fillStyle = '#f0f0f0';
  ctx.fillRect(0, 0, w, h);

  // Draw grid
  ctx.strokeStyle = '#e0e0e0';
  ctx.lineWidth = 0.5;
  const gridMm = 5;
  for (let gx = -40; gx <= 40; gx += gridMm) {
    const px = w/2 + gx * scale;
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke();
  }
  for (let gy = -40; gy <= 40; gy += gridMm) {
    const py = h/2 - gy * scale;
    ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(w, py); ctx.stroke();
  }

  ctx.save();
  ctx.translate(w / 2, h / 2);
  // Flip Y so positive Y is up (like OpenSCAD)
  ctx.scale(scale, -scale);

  // ── Shadow ──
  ctx.save();
  ctx.translate(0.5, -0.8);
  dtDrawShapePath(ctx, DT.selectedShape, scale);
  ctx.fillStyle = 'rgba(0,0,0,0.15)';
  ctx.fill();
  ctx.restore();

  // ── Tag body ──
  dtDrawShapePath(ctx, DT.selectedShape, scale);
  ctx.fillStyle = colors.base;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.3)';
  ctx.lineWidth = 0.3;
  ctx.stroke();

  // ── Ring hole ──
  const ringX = geo.ringX;
  const ringY = geo.ringY;
  ctx.beginPath();
  ctx.arc(ringX, ringY, 2.3, 0, Math.PI * 2);
  ctx.fillStyle = '#f0f0f0';
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.2)';
  ctx.lineWidth = 0.2;
  ctx.stroke();

  // ── Ring tab (for shapes that need it) ──
  if (['paw', 'star', 'hydrant', 'shield'].includes(DT.selectedShape)) {
    ctx.beginPath();
    ctx.arc(ringX, ringY, 5, 0, Math.PI * 2);
    ctx.fillStyle = colors.base;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.2)';
    ctx.lineWidth = 0.2;
    ctx.stroke();
    // Re-draw ring hole on top
    ctx.beginPath();
    ctx.arc(ringX, ringY, 2.3, 0, Math.PI * 2);
    ctx.fillStyle = '#f0f0f0';
    ctx.fill();
  }

  // ── Text pocket (slightly darker than base) ──
  if (DT.petName) {
    ctx.save();
    ctx.translate(tcx, tcy);
    ctx.scale(1, -1); // Flip text back to readable
    const fontSizePx = tsz;
    ctx.font = `bold ${fontSizePx}px "Arial", "Liberation Sans", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const textW = ctx.measureText(DT.petName.toUpperCase()).width;

    // Pocket background (recessed area)
    const pocketPad = 1.5;
    ctx.fillStyle = dtDarken(colors.base, 0.08);
    dtRoundRect(ctx, -textW/2 - pocketPad, -fontSizePx/2 - pocketPad,
                textW + pocketPad * 2, fontSizePx + pocketPad * 2, 1);
    ctx.fill();

    // Text in insert color
    ctx.fillStyle = colors.insert;
    ctx.fillText(DT.petName.toUpperCase(), 0, 0);

    ctx.restore();
  }

  // ── Drag indicator ──
  if (DT.petName) {
    ctx.save();
    ctx.translate(tcx, tcy);
    ctx.scale(1, -1);
    const fontSizePx = tsz;
    ctx.font = `bold ${fontSizePx}px "Arial", "Liberation Sans", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const textW = ctx.measureText(DT.petName.toUpperCase()).width;
    const pad = 2;

    if (DT.dragging) {
      ctx.setLineDash([1, 1]);
      ctx.strokeStyle = '#ff6600';
      ctx.lineWidth = 0.3;
      ctx.strokeRect(-textW/2 - pad, -fontSizePx/2 - pad, textW + pad*2, fontSizePx + pad*2);
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  ctx.restore();

  // ── Position readout ──
  const posLabel = document.getElementById('dtPosReadout');
  if (posLabel) {
    const cx = DT.textCx !== null ? DT.textCx.toFixed(1) : geo.textCx.toFixed(1);
    const cy = DT.textCy !== null ? DT.textCy.toFixed(1) : geo.textCy.toFixed(1);
    const isCustom = DT.textCx !== null || DT.textCy !== null;
    posLabel.textContent = `Text: (${cx}, ${cy}) mm${isCustom ? ' [custom]' : ' [default]'}`;
  }
}

function dtDarken(hex, amount) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const f = 1 - amount;
  return `rgb(${Math.round(r * f)}, ${Math.round(g * f)}, ${Math.round(b * f)})`;
}

// ═══════════════════════════════════════════════════════════════
// MOUSE / DRAG HANDLING
// ═══════════════════════════════════════════════════════════════

function dtCanvasToMm(e) {
  const rect = DT.canvas.getBoundingClientRect();
  const px = (e.clientX - rect.left) * (DT.canvas.width / rect.width);
  const py = (e.clientY - rect.top) * (DT.canvas.height / rect.height);
  // Convert pixel to mm (center origin, Y flipped)
  const mmX = (px - DT.canvas.width / 2) / DT.scale;
  const mmY = -(py - DT.canvas.height / 2) / DT.scale;
  return { x: mmX, y: mmY };
}

function dtIsOverText(mmPos) {
  if (!DT.petName) return false;
  const geo = DT.shapeGeo[DT.selectedShape];
  if (!geo) return false;
  const tcx = DT.textCx !== null ? DT.textCx : geo.textCx;
  const tcy = DT.textCy !== null ? DT.textCy : geo.textCy;
  const tsz = DT.textSz !== null ? DT.textSz : geo.textSz;

  // Approximate text bounding box in mm
  const textW = DT.petName.length * tsz * 0.65;
  const textH = tsz * 1.2;

  return Math.abs(mmPos.x - tcx) < textW / 2 + 2 &&
         Math.abs(mmPos.y - tcy) < textH / 2 + 2;
}

function dtOnMouseDown(e) {
  const mm = dtCanvasToMm(e);
  if (dtIsOverText(mm)) {
    DT.dragging = true;
    const geo = DT.shapeGeo[DT.selectedShape];
    const tcx = DT.textCx !== null ? DT.textCx : geo.textCx;
    const tcy = DT.textCy !== null ? DT.textCy : geo.textCy;
    DT.dragStartMm = { offX: mm.x - tcx, offY: mm.y - tcy };
    DT.canvas.style.cursor = 'grabbing';
    dtRender();
  }
}

function dtOnMouseMove(e) {
  const mm = dtCanvasToMm(e);
  if (DT.dragging && DT.dragStartMm) {
    DT.textCx = parseFloat((mm.x - DT.dragStartMm.offX).toFixed(1));
    DT.textCy = parseFloat((mm.y - DT.dragStartMm.offY).toFixed(1));
    dtRender();
  } else {
    DT.canvas.style.cursor = dtIsOverText(mm) ? 'grab' : 'default';
  }
}

function dtOnMouseUp() {
  if (DT.dragging) {
    DT.dragging = false;
    DT.canvas.style.cursor = 'default';
    dtRender();
  }
}

// ═══════════════════════════════════════════════════════════════
// SHAPE PICKER
// ═══════════════════════════════════════════════════════════════

function dtRenderShapePicker() {
  const container = document.getElementById('dtShapeGrid');
  if (!container) return;

  container.innerHTML = DT.shapes.map(s => `
    <button class="dt-shape-btn ${s.id === DT.selectedShape ? 'selected' : ''}"
            data-shape="${s.id}" title="${s.desc}">
      <span class="dt-shape-btn-label">${s.label}</span>
    </button>
  `).join('');

  container.querySelectorAll('.dt-shape-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      DT.selectedShape = btn.dataset.shape;
      // Reset text position to shape default when switching shapes
      DT.textCx = null;
      DT.textCy = null;
      DT.textSz = null;
      dtRenderShapePicker();
      dtRender();
    });
  });
}

// ═══════════════════════════════════════════════════════════════
// GENERATE / SLICER / BATCH
// ═══════════════════════════════════════════════════════════════

async function dtGenerate() {
  if (!DT.petName) {
    dtSetStatus('Enter a pet name first.', 'error');
    document.getElementById('dtPetName')?.focus();
    return;
  }

  DT.generating = true;
  dtSetStatus('Generating tag files...', 'info');
  dtUpdateButtons();

  try {
    const colors = COLOR_PRESETS[DT.colorIdx] || COLOR_PRESETS[0];
    const result = await window.printStation.dogTag.generate({
      name: DT.petName,
      shape: DT.selectedShape,
      colors: { base: colors.baseLabel, insert: colors.insertLabel },
      textCx: DT.textCx,
      textCy: DT.textCy,
      textSz: DT.textSz,
    });

    DT.lastGenResult = result;
    const stlReady = result.status === 'ready_to_print';

    dtSetStatus(
      `Generated <strong>${result.petName}</strong> (${result.shape}). ` +
      (stlReady ? 'STLs ready.' : 'SCAD files created (install OpenSCAD for STL).'),
      stlReady ? 'success' : 'warning'
    );

    // Enable send-to-slicer if STLs exist
    dtUpdateButtons();
    dtLoadHistory();
  } catch (e) {
    dtSetStatus(`Error: ${e.message || e}`, 'error');
  } finally {
    DT.generating = false;
    dtUpdateButtons();
  }
}

async function dtSendToSlicer() {
  if (!DT.lastGenResult?.files?.baseStl) {
    dtSetStatus('No STL available. Generate first (requires OpenSCAD).', 'error');
    return;
  }

  dtSetStatus('Uploading to slicer catalog...', 'info');
  try {
    const r = DT.lastGenResult;
    // Upload base tag
    await window.printStation.dogTag.sendToSlicer({
      stlPath: r.files.baseStl,
      name: `Dog Tag Base - ${r.shape} - ${r.petName}`,
      category: 'Dog Tags',
    });
    // Upload text insert
    await window.printStation.dogTag.sendToSlicer({
      stlPath: r.files.textStl,
      name: `Dog Tag Text - ${r.shape} - ${r.petName}`,
      category: 'Dog Tags',
    });

    dtSetStatus(`Uploaded to slicer: base + text for <strong>${r.petName}</strong>. Switch to Slice & Print to print.`, 'success');
  } catch (e) {
    dtSetStatus(`Slicer upload error: ${e.message || e}`, 'error');
  }
}

async function dtAddToBatch() {
  if (!DT.petName) {
    dtSetStatus('Enter a pet name first.', 'error');
    return;
  }
  const colors = COLOR_PRESETS[DT.colorIdx] || COLOR_PRESETS[0];
  try {
    const result = await window.printStation.dogTag.batchAdd({
      name: DT.petName,
      shape: DT.selectedShape,
      colors: { base: colors.baseLabel, insert: colors.insertLabel },
      textCx: DT.textCx,
      textCy: DT.textCy,
      textSz: DT.textSz,
    });
    DT.batchQueue = result.queue;
    dtRenderBatch();
    dtSetStatus(`Added <strong>${DT.petName}</strong> to batch (${DT.batchQueue.length} tags).`, 'success');
  } catch (e) {
    dtSetStatus(`Batch error: ${e.message || e}`, 'error');
  }
}

async function dtBatchGenerateAll() {
  if (!DT.batchQueue.length) return;

  dtSetStatus(`Generating ${DT.batchQueue.length} tags... this may take a moment.`, 'info');
  try {
    const result = await window.printStation.dogTag.batchGenerateAll();
    DT.batchQueue = [];
    dtRenderBatch();
    dtSetStatus(`Generated ${result.count} tags. STLs are in the queue folder.`, 'success');
    dtLoadHistory();
  } catch (e) {
    dtSetStatus(`Batch generate error: ${e.message || e}`, 'error');
  }
}

async function dtBatchRemove(id) {
  try {
    const result = await window.printStation.dogTag.batchRemove(id);
    DT.batchQueue = result.queue;
    dtRenderBatch();
  } catch (_) {}
}

async function dtBatchClear() {
  try {
    await window.printStation.dogTag.batchClear();
    DT.batchQueue = [];
    dtRenderBatch();
  } catch (_) {}
}

// ═══════════════════════════════════════════════════════════════
// BATCH PANEL RENDER
// ═══════════════════════════════════════════════════════════════

function dtRenderBatch() {
  const container = document.getElementById('dtBatchList');
  const countEl = document.getElementById('dtBatchCount');
  if (!container) return;

  if (countEl) countEl.textContent = DT.batchQueue.length || '';

  if (!DT.batchQueue.length) {
    container.innerHTML = '<div class="dt-empty">Queue empty. Add tags with "+ Add to Batch".</div>';
    return;
  }

  container.innerHTML = DT.batchQueue.map(item => `
    <div class="dt-batch-item">
      <div class="dt-batch-info">
        <strong>${item.name}</strong>
        <small>${item.shape}${item.textCx !== null ? ' [custom pos]' : ''}</small>
      </div>
      <button class="dt-batch-remove" data-id="${item.id}" title="Remove">&times;</button>
    </div>
  `).join('');

  container.querySelectorAll('.dt-batch-remove').forEach(btn => {
    btn.addEventListener('click', () => dtBatchRemove(btn.dataset.id));
  });
}

// ═══════════════════════════════════════════════════════════════
// HISTORY PANEL
// ═══════════════════════════════════════════════════════════════

async function dtLoadHistory() {
  try {
    const data = await window.printStation.dogTag.getHistory();
    DT.history = (data.jobs || []).slice(0, 20);
    dtRenderHistory();
  } catch (_) {}
}

function dtRenderHistory() {
  const container = document.getElementById('dtHistoryList');
  if (!container) return;

  if (!DT.history.length) {
    container.innerHTML = '<div class="dt-empty">No tags generated yet.</div>';
    return;
  }

  container.innerHTML = DT.history.map(job => {
    const date = job.timestamp ? new Date(job.timestamp).toLocaleDateString() : '';
    return `
      <div class="dt-history-item">
        <div class="dt-history-info">
          <strong>${job.name}</strong>
          <small>${job.shape} &middot; ${date}</small>
        </div>
        <button class="dt-history-open" data-job="${job.jobId}" title="Open folder">Open</button>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.dt-history-open').forEach(btn => {
    btn.addEventListener('click', () => window.printStation.dogTag.openOutput(btn.dataset.job));
  });
}

// ═══════════════════════════════════════════════════════════════
// UI HELPERS
// ═══════════════════════════════════════════════════════════════

function dtSetStatus(html, type) {
  const el = document.getElementById('dtStatus');
  if (!el) return;
  el.innerHTML = html;
  el.className = 'dt-status ' + (type || '');
}

function dtUpdateButtons() {
  const genBtn = document.getElementById('dtGenerateBtn');
  const slicerBtn = document.getElementById('dtSendToSlicerBtn');

  if (genBtn) {
    genBtn.disabled = DT.generating;
    genBtn.textContent = DT.generating ? 'Generating...' : 'Generate Tag';
  }

  if (slicerBtn) {
    const hasStl = DT.lastGenResult?.files?.baseStl;
    slicerBtn.disabled = !hasStl;
    slicerBtn.title = hasStl ? 'Upload STLs to slicer catalog' : 'Generate a tag with OpenSCAD first';
  }
}

function dtResetTextPos() {
  DT.textCx = null;
  DT.textCy = null;
  DT.textSz = null;
  dtRender();
}

// ═══════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════

async function initDogTagsView() {
  if (DT.initialized) {
    dtLoadHistory();
    dtLoadBatch();
    dtRender();
    return;
  }

  // Load shapes + geometry from backend
  try {
    const data = await window.printStation.dogTag.getShapes();
    DT.shapes = data.shapes || [];
    DT.defaults = data.defaults || {};
    DT.shapes.forEach(s => {
      if (s.geometry) DT.shapeGeo[s.id] = s.geometry;
    });
  } catch (e) {
    console.error('[DogTag] Failed to load shapes:', e);
  }

  // Check openscad
  try {
    const check = await window.printStation.dogTag.checkOpenscad();
    DT.openscadAvailable = check.available;
  } catch (_) {}

  const oscadNote = document.getElementById('dtOpenscadNote');
  if (oscadNote) {
    oscadNote.style.display = DT.openscadAvailable ? 'none' : 'block';
  }

  // Canvas setup
  DT.canvas = document.getElementById('dtCanvas');
  if (DT.canvas) {
    DT.ctx = DT.canvas.getContext('2d');
    // High-DPI support
    const dpr = window.devicePixelRatio || 1;
    const rect = DT.canvas.getBoundingClientRect();
    DT.canvas.width = rect.width * dpr;
    DT.canvas.height = rect.height * dpr;
    DT.ctx.scale(dpr, dpr);
    DT.canvas.width = rect.width;
    DT.canvas.height = rect.height;
    DT.scale = Math.min(rect.width, rect.height) / 70; // ~70mm viewport

    // Mouse events
    DT.canvas.addEventListener('mousedown', dtOnMouseDown);
    DT.canvas.addEventListener('mousemove', dtOnMouseMove);
    DT.canvas.addEventListener('mouseup', dtOnMouseUp);
    DT.canvas.addEventListener('mouseleave', dtOnMouseUp);
  }

  // Name input
  const nameInput = document.getElementById('dtPetName');
  if (nameInput) {
    nameInput.addEventListener('input', () => {
      DT.petName = nameInput.value.trim().toUpperCase().replace(/[^A-Z0-9\s]/g, '').slice(0, 12);
      dtRender();
    });
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') dtGenerate();
    });
  }

  // Color select
  const colorSelect = document.getElementById('dtColorPreset');
  if (colorSelect) {
    colorSelect.addEventListener('change', () => {
      DT.colorIdx = colorSelect.selectedIndex;
      dtRender();
    });
  }

  // Buttons
  document.getElementById('dtGenerateBtn')?.addEventListener('click', dtGenerate);
  document.getElementById('dtSendToSlicerBtn')?.addEventListener('click', dtSendToSlicer);
  document.getElementById('dtAddBatchBtn')?.addEventListener('click', dtAddToBatch);
  document.getElementById('dtBatchGenerateBtn')?.addEventListener('click', dtBatchGenerateAll);
  document.getElementById('dtBatchClearBtn')?.addEventListener('click', dtBatchClear);
  document.getElementById('dtResetPosBtn')?.addEventListener('click', dtResetTextPos);

  // Render
  dtRenderShapePicker();
  dtRender();
  dtLoadHistory();
  dtLoadBatch();

  DT.initialized = true;
}

async function dtLoadBatch() {
  try {
    DT.batchQueue = await window.printStation.dogTag.batchList();
    dtRenderBatch();
  } catch (_) {}
}

window.initDogTagsView = initDogTagsView;
