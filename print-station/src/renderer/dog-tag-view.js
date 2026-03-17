/**
 * BRCC Dog Tag Generator View
 * ============================================================
 * UI for generating custom two-color press-fit pet dog tags.
 * Calls window.printStation.dogTag.* IPC API.
 * ============================================================
 */

const dogTagState = {
  initialized: false,
  shapes: [],
  selectedShape: 'bone',
  generating: false,
  history: [],
  queueCount: 0,
};

// ── Shape visual icons (SVG-based) ──────────────────────────
const SHAPE_ICONS = {
  bone:    `<svg viewBox="0 0 64 40" width="48" height="30"><ellipse cx="8" cy="10" rx="7" ry="8" fill="currentColor"/><ellipse cx="8" cy="30" rx="7" ry="8" fill="currentColor"/><ellipse cx="56" cy="10" rx="7" ry="8" fill="currentColor"/><ellipse cx="56" cy="30" rx="7" ry="8" fill="currentColor"/><rect x="10" y="12" width="44" height="16" rx="6" fill="currentColor"/></svg>`,
  shield:  `<svg viewBox="0 0 40 50" width="32" height="40"><path d="M20 2 L38 12 L38 28 Q38 46 20 48 Q2 46 2 28 L2 12 Z" fill="currentColor"/></svg>`,
  heart:   `<svg viewBox="0 0 44 40" width="36" height="32"><path d="M22 38 Q2 24 2 14 Q2 2 12 2 Q22 2 22 12 Q22 2 32 2 Q42 2 42 14 Q42 24 22 38Z" fill="currentColor"/></svg>`,
  paw:     `<svg viewBox="0 0 44 44" width="36" height="36"><circle cx="22" cy="22" r="20" fill="currentColor"/></svg>`,
  hydrant: `<svg viewBox="0 0 36 48" width="28" height="38"><rect x="8" y="30" width="20" height="14" rx="2" fill="currentColor"/><rect x="10" y="20" width="16" height="12" rx="2" fill="currentColor"/><rect x="12" y="10" width="12" height="12" rx="2" fill="currentColor"/><circle cx="18" cy="6" r="5" fill="currentColor"/><rect x="2" y="26" width="8" height="6" rx="3" fill="currentColor"/><rect x="26" y="26" width="8" height="6" rx="3" fill="currentColor"/></svg>`,
  star:    `<svg viewBox="0 0 44 44" width="36" height="36"><polygon points="22,2 27,16 42,16 30,26 34,40 22,32 10,40 14,26 2,16 17,16" fill="currentColor"/></svg>`,
};

// ── Color presets ───────────────────────────────────────────
const COLOR_PRESETS = [
  { base: '#ffffff', insert: '#222222', label: 'White + Black' },
  { base: '#222222', insert: '#ffffff', label: 'Black + White' },
  { base: '#1a1a2e', insert: '#e8b931', label: 'Navy + Gold' },
  { base: '#8b0000', insert: '#ffffff', label: 'Red + White' },
  { base: '#2d5016', insert: '#f5f5dc', label: 'Green + Cream' },
  { base: '#4a90d9', insert: '#ffffff', label: 'Blue + White' },
];

// ── Load shapes from API ────────────────────────────────────
async function dtLoadShapes() {
  try {
    const data = await window.printStation.dogTag.getShapes();
    dogTagState.shapes = data.shapes || [];
  } catch (e) {
    console.error('[DogTag] Failed to load shapes:', e);
    dogTagState.shapes = [
      { id: 'bone', label: 'Classic Bone', desc: 'Traditional double-knob bone' },
      { id: 'shield', label: 'Shield / Badge', desc: 'Bold angular badge' },
      { id: 'heart', label: 'Heart', desc: 'Clean heart silhouette' },
      { id: 'paw', label: 'Paw Print', desc: 'Round tag with paw emboss' },
      { id: 'hydrant', label: 'Fire Hydrant', desc: 'Novelty hydrant shape' },
      { id: 'star', label: 'Sheriff Star', desc: '5-point star' },
    ];
  }
}

// ── Load history ────────────────────────────────────────────
async function dtLoadHistory() {
  try {
    const data = await window.printStation.dogTag.getHistory();
    dogTagState.history = data.jobs || [];
    dtRenderHistory();
  } catch (e) {
    console.error('[DogTag] Failed to load history:', e);
  }
}

// ── Load queue count ────────────────────────────────────────
async function dtLoadQueue() {
  try {
    const data = await window.printStation.dogTag.getQueue();
    dogTagState.queueCount = data.count || 0;
    const el = document.getElementById('dtQueueCount');
    if (el) el.textContent = `${dogTagState.queueCount} file${dogTagState.queueCount !== 1 ? 's' : ''} in queue`;
  } catch (_) {}
}

// ── Render shape picker ─────────────────────────────────────
function dtRenderShapes() {
  const container = document.getElementById('dtShapeGrid');
  if (!container) return;

  container.innerHTML = dogTagState.shapes.map(s => `
    <button class="dt-shape-card ${s.id === dogTagState.selectedShape ? 'selected' : ''}"
            data-shape="${s.id}" title="${s.desc}">
      <div class="dt-shape-icon">${SHAPE_ICONS[s.id] || ''}</div>
      <div class="dt-shape-label">${s.label}</div>
    </button>
  `).join('');

  container.querySelectorAll('.dt-shape-card').forEach(btn => {
    btn.addEventListener('click', () => {
      dogTagState.selectedShape = btn.dataset.shape;
      container.querySelectorAll('.dt-shape-card').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      dtUpdatePreview();
    });
  });
}

// ── Update the tag preview ──────────────────────────────────
function dtUpdatePreview() {
  const nameInput = document.getElementById('dtPetName');
  const preview = document.getElementById('dtPreviewTag');
  if (!preview || !nameInput) return;

  const name = (nameInput.value || 'NAME').toUpperCase().replace(/[^A-Z0-9\s]/g, '').slice(0, 12) || 'NAME';
  const colorIdx = document.getElementById('dtColorPreset')?.selectedIndex || 0;
  const colors = COLOR_PRESETS[colorIdx] || COLOR_PRESETS[0];

  const shapeIcon = SHAPE_ICONS[dogTagState.selectedShape] || '';

  preview.innerHTML = `
    <div class="dt-preview-body" style="background:${colors.base};color:${colors.insert};">
      <div class="dt-preview-shape">${shapeIcon}</div>
      <div class="dt-preview-name" style="color:${colors.insert};border-color:${colors.insert}40;">${name}</div>
    </div>
    <div class="dt-preview-caption">${dogTagState.shapes.find(s => s.id === dogTagState.selectedShape)?.label || dogTagState.selectedShape}</div>
  `;
}

// ── Generate tag ────────────────────────────────────────────
async function dtGenerate() {
  const nameInput = document.getElementById('dtPetName');
  const statusEl = document.getElementById('dtStatus');
  const genBtn = document.getElementById('dtGenerateBtn');

  const name = nameInput?.value?.trim();
  if (!name) {
    if (statusEl) {
      statusEl.textContent = 'Please enter a pet name.';
      statusEl.className = 'dt-status error';
    }
    nameInput?.focus();
    return;
  }

  const colorIdx = document.getElementById('dtColorPreset')?.selectedIndex || 0;
  const colors = COLOR_PRESETS[colorIdx] || COLOR_PRESETS[0];

  dogTagState.generating = true;
  if (genBtn) { genBtn.disabled = true; genBtn.textContent = 'Generating...'; }
  if (statusEl) { statusEl.textContent = 'Generating SCAD files...'; statusEl.className = 'dt-status info'; }

  try {
    const result = await window.printStation.dogTag.generate({
      name,
      shape: dogTagState.selectedShape,
      colors: { base: colors.label.split(' + ')[0], insert: colors.label.split(' + ')[1] },
    });

    if (statusEl) {
      const statusIcon = result.status === 'ready_to_print' ? 'STLs ready' : 'SCAD files generated (open in OpenSCAD to export STL)';
      statusEl.innerHTML = `
        Tag generated for <strong>${result.petName}</strong> (${result.shape}).<br>
        ${statusIcon}<br>
        <small>Base: ${result.files.baseScad?.split(/[/\\]/).pop()}</small><br>
        <small>Text: ${result.files.textScad?.split(/[/\\]/).pop()}</small>
      `;
      statusEl.className = 'dt-status success';
    }

    // Refresh history and queue
    dtLoadHistory();
    dtLoadQueue();

  } catch (e) {
    console.error('[DogTag] Generate error:', e);
    if (statusEl) {
      statusEl.textContent = `Error: ${e.message || e}`;
      statusEl.className = 'dt-status error';
    }
  } finally {
    dogTagState.generating = false;
    if (genBtn) { genBtn.disabled = false; genBtn.textContent = 'Generate Tag'; }
  }
}

// ── Render history ──────────────────────────────────────────
function dtRenderHistory() {
  const container = document.getElementById('dtHistoryList');
  if (!container) return;

  if (!dogTagState.history.length) {
    container.innerHTML = '<div class="dt-empty">No tags generated yet. Create your first one above!</div>';
    return;
  }

  container.innerHTML = dogTagState.history.map(job => {
    const date = job.timestamp ? new Date(job.timestamp).toLocaleString() : '';
    const icon = SHAPE_ICONS[job.shape] || '';
    return `
      <div class="dt-history-item">
        <div class="dt-history-icon" title="${job.shape}">${icon}</div>
        <div class="dt-history-info">
          <strong>${job.name}</strong>
          <small>${job.shape} &middot; ${date}</small>
        </div>
        <button class="dt-history-open" data-job="${job.jobId}" title="Open output folder">Open</button>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.dt-history-open').forEach(btn => {
    btn.addEventListener('click', async () => {
      await window.printStation.dogTag.openOutput(btn.dataset.job);
    });
  });
}

// ── Initialization ──────────────────────────────────────────
function initDogTagsView() {
  if (dogTagState.initialized) {
    dtLoadHistory();
    dtLoadQueue();
    return;
  }

  // Load shapes then render
  dtLoadShapes().then(() => {
    dtRenderShapes();
    dtUpdatePreview();
  });

  // Wire up event listeners
  const nameInput = document.getElementById('dtPetName');
  if (nameInput) {
    nameInput.addEventListener('input', dtUpdatePreview);
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') dtGenerate();
    });
  }

  const colorSelect = document.getElementById('dtColorPreset');
  if (colorSelect) {
    colorSelect.addEventListener('change', dtUpdatePreview);
  }

  const genBtn = document.getElementById('dtGenerateBtn');
  if (genBtn) {
    genBtn.addEventListener('click', dtGenerate);
  }

  const refreshBtn = document.getElementById('dtRefreshBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      dtLoadHistory();
      dtLoadQueue();
    });
  }

  // Load initial data
  dtLoadHistory();
  dtLoadQueue();

  dogTagState.initialized = true;
}

// Expose to global scope for switchView()
window.initDogTagsView = initDogTagsView;
