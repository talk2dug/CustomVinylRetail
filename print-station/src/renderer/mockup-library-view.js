'use strict';
// ============================================================================
// MOCKUP LIBRARY VIEW
// Browse, preview, filter, and download generated apparel mockups.
// ============================================================================

(function () {

  let mlInitialized = false;

  const mlState = {
    mockups: [],           // full list from server
    filtered: [],          // after search/filter/sort
    manifests: [],         // batch manifests
    selected: new Set(),   // filenames of selected cards
    previewIndex: -1,      // index in filtered[] for preview modal
    loading: false,
  };

  // ---- Cached DOM refs -------------------------------------------------------
  const el = {};
  function cacheElements() {
    el.refreshBtn = document.getElementById('mlRefreshBtn');
    el.selectAllBtn = document.getElementById('mlSelectAllBtn');
    el.downloadSelectedBtn = document.getElementById('mlDownloadSelectedBtn');
    el.statsBar = document.getElementById('mlStatsBar');
    el.statTotal = document.getElementById('mlStatTotal');
    el.statDisk = document.getElementById('mlStatDisk');
    el.statOldest = document.getElementById('mlStatOldest');
    el.statNewest = document.getElementById('mlStatNewest');
    el.searchInput = document.getElementById('mlSearchInput');
    el.batchFilter = document.getElementById('mlBatchFilter');
    el.sortOrder = document.getElementById('mlSortOrder');
    el.grid = document.getElementById('mlGrid');
  }

  // ---- Helpers ---------------------------------------------------------------
  function getServerBase() {
    try {
      const configStr = localStorage.getItem('printStationConfig');
      if (configStr) {
        const config = JSON.parse(configStr);
        if (config.serverBaseUrl) return config.serverBaseUrl.replace(/\/$/, '');
      }
    } catch (_) {}
    return 'https://store.swayzecustomvinyl.com';
  }

  function esc(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function formatBytes(bytes) {
    if (!bytes || bytes < 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let val = bytes;
    while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
    return val.toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
  }

  function formatDate(iso) {
    if (!iso) return '--';
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function formatDateTime(iso) {
    if (!iso) return '--';
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
      ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  function debounce(fn, ms) {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  // ---- Data Loading ----------------------------------------------------------
  async function loadMockups() {
    if (mlState.loading) return;
    mlState.loading = true;
    el.grid.innerHTML = '<div class="ml-empty">Loading mockups...</div>';

    try {
      const data = await printStation.mockupLibrary.list();
      mlState.mockups = data?.mockups || [];
      updateStats();
      filterMockups();
    } catch (e) {
      console.error('[MockupLibrary] Failed to load mockups:', e);
      el.grid.innerHTML = '<div class="ml-empty">Failed to load mockups: ' + esc(e.message) + '</div>';
    } finally {
      mlState.loading = false;
    }
  }

  async function loadManifests() {
    try {
      const data = await printStation.mockupLibrary.manifests();
      mlState.manifests = data?.manifests || [];
      populateBatchFilter();
    } catch (e) {
      console.error('[MockupLibrary] Failed to load manifests:', e);
    }
  }

  function populateBatchFilter() {
    if (!el.batchFilter) return;
    const options = '<option value="">All Batches</option>' +
      mlState.manifests.map(m => {
        const label = m.category || m.filename || 'Batch';
        const date = formatDate(m.generatedAt);
        const count = m.results?.length || m.total || '?';
        return `<option value="${esc(m.filename)}">${esc(label)} (${count}) - ${date}</option>`;
      }).join('');
    el.batchFilter.innerHTML = options;
  }

  // ---- Stats -----------------------------------------------------------------
  function updateStats() {
    const mockups = mlState.mockups;
    el.statTotal.textContent = mockups.length;

    const totalSize = mockups.reduce((sum, m) => sum + (m.size || 0), 0);
    el.statDisk.textContent = formatBytes(totalSize);

    if (mockups.length > 0) {
      const dates = mockups.map(m => new Date(m.createdAt).getTime()).filter(t => !isNaN(t));
      if (dates.length) {
        el.statOldest.textContent = formatDate(new Date(Math.min(...dates)).toISOString());
        el.statNewest.textContent = formatDate(new Date(Math.max(...dates)).toISOString());
      }
    } else {
      el.statOldest.textContent = '--';
      el.statNewest.textContent = '--';
    }
  }

  // ---- Filtering & Sorting ---------------------------------------------------
  function filterMockups() {
    const search = (el.searchInput?.value || '').toLowerCase().trim();
    const batchFile = el.batchFilter?.value || '';
    const sortOrder = el.sortOrder?.value || 'newest';

    let filtered = [...mlState.mockups];

    // Search filter
    if (search) {
      filtered = filtered.filter(m =>
        (m.filename || '').toLowerCase().includes(search)
      );
    }

    // Batch filter — match filenames from the batch manifest
    if (batchFile) {
      const manifest = mlState.manifests.find(m => m.filename === batchFile);
      if (manifest && manifest.results) {
        const batchFilenames = new Set(manifest.results.map(r => r.filename).filter(Boolean));
        filtered = filtered.filter(m => batchFilenames.has(m.filename));
      }
    }

    // Sort
    filtered.sort((a, b) => {
      const da = new Date(a.createdAt).getTime() || 0;
      const db = new Date(b.createdAt).getTime() || 0;
      return sortOrder === 'oldest' ? da - db : db - da;
    });

    mlState.filtered = filtered;
    renderMockupGrid(filtered);
  }

  // ---- Grid Rendering --------------------------------------------------------
  function renderMockupGrid(mockups) {
    if (!el.grid) return;

    if (!mockups.length) {
      el.grid.innerHTML = '<div class="ml-empty">No mockups found</div>';
      return;
    }

    const serverBase = getServerBase();

    el.grid.innerHTML = mockups.map((m, i) => {
      const imgUrl = `${serverBase}${m.url}`;
      const isSelected = mlState.selected.has(m.filename);
      return `<div class="ml-card${isSelected ? ' selected' : ''}" data-index="${i}" data-filename="${esc(m.filename)}">
        <div class="ml-card-check${isSelected ? ' checked' : ''}" data-action="check" title="Select">
          ${isSelected ? '&#10003;' : ''}
        </div>
        <button class="ml-card-dl" data-action="download" title="Download">&#8681;</button>
        <img class="ml-card-img" src="${esc(imgUrl)}" alt="${esc(m.filename)}" loading="lazy" />
        <div class="ml-card-info">
          <div class="ml-card-name" title="${esc(m.filename)}">${esc(m.filename)}</div>
          <div class="ml-card-meta">
            <span>${formatDate(m.createdAt)}</span>
            <span>${formatBytes(m.size)}</span>
          </div>
        </div>
      </div>`;
    }).join('');

    // Event delegation on the grid
    // (We rebind every render; delegated on the grid container)
  }

  // ---- Selection -------------------------------------------------------------
  function toggleSelect(filename) {
    if (mlState.selected.has(filename)) {
      mlState.selected.delete(filename);
    } else {
      mlState.selected.add(filename);
    }
    updateSelectionUI();
  }

  function selectAll() {
    if (mlState.selected.size === mlState.filtered.length) {
      // Deselect all
      mlState.selected.clear();
    } else {
      mlState.filtered.forEach(m => mlState.selected.add(m.filename));
    }
    updateSelectionUI();
  }

  function updateSelectionUI() {
    const count = mlState.selected.size;
    if (el.downloadSelectedBtn) {
      el.downloadSelectedBtn.textContent = `Download Selected (${count})`;
      el.downloadSelectedBtn.disabled = count === 0;
    }
    if (el.selectAllBtn) {
      el.selectAllBtn.textContent = mlState.selected.size === mlState.filtered.length && mlState.filtered.length > 0
        ? 'Deselect All' : 'Select All';
    }

    // Update card visual states
    el.grid?.querySelectorAll('.ml-card').forEach(card => {
      const fn = card.dataset.filename;
      const isSelected = mlState.selected.has(fn);
      card.classList.toggle('selected', isSelected);
      const check = card.querySelector('.ml-card-check');
      if (check) {
        check.classList.toggle('checked', isSelected);
        check.innerHTML = isSelected ? '&#10003;' : '';
      }
    });
  }

  // ---- Download --------------------------------------------------------------
  async function downloadMockup(filename) {
    try {
      await printStation.mockupLibrary.download(filename);
    } catch (e) {
      console.error('[MockupLibrary] Download failed:', e);
    }
  }

  async function downloadSelected() {
    const files = [...mlState.selected];
    if (!files.length) return;

    const btn = el.downloadSelectedBtn;
    const origText = btn.textContent;

    for (let i = 0; i < files.length; i++) {
      btn.textContent = `Downloading ${i + 1}/${files.length}...`;
      btn.disabled = true;
      try {
        await downloadMockup(files[i]);
      } catch (e) {
        console.error('[MockupLibrary] Batch download error for', files[i], e);
      }
    }

    btn.textContent = origText;
    btn.disabled = false;
  }

  // ---- Preview Modal ---------------------------------------------------------
  function openPreview(index) {
    if (index < 0 || index >= mlState.filtered.length) return;
    mlState.previewIndex = index;

    const mockup = mlState.filtered[index];
    const serverBase = getServerBase();
    const imgUrl = `${serverBase}${mockup.url}`;
    const hasPrev = index > 0;
    const hasNext = index < mlState.filtered.length - 1;

    // Remove existing
    closePreview();

    const overlay = document.createElement('div');
    overlay.className = 'ml-preview-overlay';
    overlay.id = 'mlPreviewOverlay';
    overlay.innerHTML = `
      <div class="ml-preview-modal">
        <div class="ml-preview-img-wrap">
          ${hasPrev ? '<button class="ml-preview-nav prev" data-action="prev">&lsaquo;</button>' : ''}
          <img src="${esc(imgUrl)}" alt="${esc(mockup.filename)}" />
          ${hasNext ? '<button class="ml-preview-nav next" data-action="next">&rsaquo;</button>' : ''}
        </div>
        <div class="ml-preview-footer">
          <div class="ml-preview-meta">
            <strong>${esc(mockup.filename)}</strong>
            ${formatDateTime(mockup.createdAt)} &middot; ${formatBytes(mockup.size)}
          </div>
          <div class="ml-preview-actions">
            <button class="ml-btn primary" data-action="download-preview">Download</button>
            <button class="ml-btn" data-action="close-preview">Close</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    // Events
    overlay.addEventListener('click', (e) => {
      const action = e.target.dataset?.action || e.target.closest('[data-action]')?.dataset?.action;
      if (action === 'prev') {
        openPreview(mlState.previewIndex - 1);
      } else if (action === 'next') {
        openPreview(mlState.previewIndex + 1);
      } else if (action === 'download-preview') {
        downloadMockup(mockup.filename);
      } else if (action === 'close-preview' || e.target === overlay) {
        closePreview();
      }
    });

    // Keyboard navigation
    overlay._keyHandler = (e) => {
      if (e.key === 'Escape') closePreview();
      else if (e.key === 'ArrowLeft' && mlState.previewIndex > 0) openPreview(mlState.previewIndex - 1);
      else if (e.key === 'ArrowRight' && mlState.previewIndex < mlState.filtered.length - 1) openPreview(mlState.previewIndex + 1);
    };
    document.addEventListener('keydown', overlay._keyHandler);
  }

  function closePreview() {
    const existing = document.getElementById('mlPreviewOverlay');
    if (existing) {
      if (existing._keyHandler) document.removeEventListener('keydown', existing._keyHandler);
      existing.remove();
    }
    mlState.previewIndex = -1;
  }

  // ---- Event Binding ---------------------------------------------------------
  function bindEvents() {
    el.refreshBtn?.addEventListener('click', () => {
      mlState.selected.clear();
      loadMockups();
      loadManifests();
    });

    el.selectAllBtn?.addEventListener('click', selectAll);
    el.downloadSelectedBtn?.addEventListener('click', downloadSelected);

    el.searchInput?.addEventListener('input', debounce(filterMockups, 300));
    el.batchFilter?.addEventListener('change', filterMockups);
    el.sortOrder?.addEventListener('change', filterMockups);

    // Event delegation on grid for card clicks
    el.grid?.addEventListener('click', (e) => {
      const card = e.target.closest('.ml-card');
      if (!card) return;

      const action = e.target.dataset?.action || e.target.closest('[data-action]')?.dataset?.action;
      const filename = card.dataset.filename;
      const index = parseInt(card.dataset.index, 10);

      if (action === 'check') {
        toggleSelect(filename);
      } else if (action === 'download') {
        e.stopPropagation();
        downloadMockup(filename);
      } else {
        // Click on card body — open preview
        openPreview(index);
      }
    });
  }

  // ---- Public API ------------------------------------------------------------
  window.initMockupLibraryView = function () {
    if (!mlInitialized) {
      cacheElements();
      bindEvents();
      mlInitialized = true;
    }

    // Load data
    loadMockups();
    loadManifests();
  };

})();
