// =============== Multiboard Parts Browser View ===============
// Embedded browser for browsing and downloading Multiboard STL parts

const MULTIBOARD_CATALOG = {
  partsLibrary: {
    label: 'Parts Library',
    items: [
      { label: 'All Parts', url: 'https://www.multiboard.io/parts-library' },
      { label: 'Mounting Systems', url: 'https://www.multiboard.io/parts-library/mounting-systems' },
      { label: 'Snaps', url: 'https://www.multiboard.io/parts-library/snaps' },
      { label: 'Accessories', url: 'https://www.multiboard.io/parts-library/accessories' },
      { label: 'Shelves & Brackets', url: 'https://www.multiboard.io/parts-library/shelves-brackets' },
      { label: 'Beams', url: 'https://www.multiboard.io/parts-library/beams' }
    ]
  },
  multibin: {
    label: 'Multibin',
    items: [
      { label: 'Shells', url: 'https://www.multiboard.io/parts-library/multibin/shells' },
      { label: 'Grids', url: 'https://www.multiboard.io/parts-library/multibin/grids' },
      { label: 'Inserts', url: 'https://www.multiboard.io/parts-library/multibin/inserts' },
      { label: 'Drawers', url: 'https://www.multiboard.io/parts-library/multibin/drawers' },
      { label: 'Dividers', url: 'https://www.multiboard.io/parts-library/multibin/dividers' },
      { label: 'Other', url: 'https://www.multiboard.io/parts-library/multibin/other' }
    ]
  },
  multipoint: {
    label: 'Multipoint',
    items: [
      { label: 'Bin Connections', url: 'https://www.multiboard.io/parts-library/multipoint/bin-connections' }
    ]
  },
  remixing: {
    label: 'Remixing Files',
    items: [
      { label: 'STEP & STL Bases', url: 'https://www.multiboard.io/parts-library/remixing' },
      { label: 'STL Inserts', url: 'https://www.multiboard.io/parts-library/remixing/stl-inserts' }
    ]
  },
  special: {
    label: 'Special',
    items: [
      { label: 'Early Access', url: 'https://www.multiboard.io/parts-library/early-access' },
      { label: 'Learning Packs', url: 'https://www.multiboard.io/parts-library/learning-packs' }
    ]
  },
  tools: {
    label: 'Tools & Docs',
    items: [
      { label: 'Tile Planner', url: 'https://www.multiboard.io/planner' },
      { label: 'Knowledge Hub', url: 'https://docs.multiboard.io' },
      { label: 'Printing Guidelines', url: 'https://docs.multiboard.io/beginner-section/printing-guidelines' },
      { label: 'Community', url: 'https://community.multiboard.io' },
      { label: 'Get Started', url: 'https://www.multiboard.io/get-started' }
    ]
  },
  thangs: {
    label: 'Thangs Downloads',
    items: [
      { label: 'All Multiboard', url: 'https://thangs.com/designer/Multiboard' },
      { label: '8x8 Core Tile', url: 'https://thangs.com/designer/Multiboard/3d-model/8x8%20Multiboard%20Core%20Tile-974214' },
      { label: '8x8 Core 4x Stack', url: 'https://thangs.com/designer/Multiboard/3d-model/8x8%20MU%20Core%20-%20Multiboard%20Border%20Tile%20x4%20Stack-974386' },
      { label: '8x8 Border Tile', url: 'https://thangs.com/designer/Multiboard/3d-model/8x8%20MU%20Single%20-%20Multiboard%20Border%20Tile-1320746' },
      { label: 'Snap', url: 'https://thangs.com/designer/Multiboard/3d-model/Multiboard%20Snap-1311031' },
      { label: '2x1x4 Drawer', url: 'https://thangs.com/designer/Multiboard/3d-model/2x1x4-Deep%20-%20Multibin%20Simple%20Drawer-1128859' },
      { label: 'Under Desk Drawers Pack', url: 'https://thangs.com/designer/Multiboard/3d-model/Under%20Desk%20Drawers%20%231%20-%20Multiboard%20Pack%20(%2B%20Video%20Tutorial)-1136378' },
      { label: 'Search All', url: 'https://thangs.com/search/multiboard?view=list&searchScope=thangs' }
    ]
  },
  community: {
    label: 'Community Remixes',
    items: [
      { label: 'Tool Holders (Printables)', url: 'https://www.printables.com/model/738772-multiboard-tool-holders' },
      { label: 'Multigrid Shelves', url: 'https://www.printables.com/model/712125-multigrid-shelves-for-the-multiboard-storage-syste' },
      { label: 'Gridfinity Shelves', url: 'https://www.printables.com/model/710796-multiboard-gridfinify-shelves' },
      { label: 'Drawer Insert Bins', url: 'https://www.printables.com/model/1301208-multiboard-drawer-insert-bins' },
      { label: 'Spool Holder', url: 'https://thangs.com/designer/bpitanga/3d-model/Multiboard%20-%20Bolt-locked%20Spool%20Holder-1204525' },
      { label: 'Angled Drill Holder', url: 'https://thangs.com/designer/gray.tim1/3d-model/Multiboard%20Angled%20Drill%20Holder-997393' },
      { label: 'Deburring Tool Holder', url: 'https://www.printables.com/model/943912-cnc-kitchen-deburring-tool-multiboard-holder' },
      { label: 'Bambu AMS Shelf', url: 'https://thangs.com/designer/FroznBits/3d-model/Bambu%20AMS%20Shelf%20for%20Multiboard%20Heavy%20Insert%20Bracket-1135299' }
    ]
  }
};

const MPB_HOME_URL = 'https://www.multiboard.io/parts-library';

const mpbState = {
  initialized: false,
  webview: null,
  importCount: 0,
  importHistory: [],
  downloadUnsub: { start: null, progress: null, complete: null },
  expandedGroups: new Set(['partsLibrary', 'thangs']),
  currentUrl: MPB_HOME_URL
};

// =============== INITIALIZATION ===============

function initMultiboardPartsBrowserView() {
  if (!mpbState.initialized) {
    mpbState.initialized = true;
    mpbBuildCategoryTree();
    mpbSetupEventListeners();
    mpbCreateWebview();
    mpbSubscribeDownloadEvents();
    mpbSetupMissingPanel();
  } else if (mpbState.webview) {
    mpbState.webview.style.display = '';
  }
  mpbUpdateImportCount();
}

function cleanupMultiboardPartsBrowser() {
  if (mpbState.webview) {
    mpbState.webview.style.display = 'none';
  }
}

// =============== WEBVIEW ===============

function mpbCreateWebview() {
  const container = document.getElementById('mpbWebviewContainer');
  if (!container) return;

  const existing = container.querySelector('webview');
  if (existing) existing.remove();

  const wv = document.createElement('webview');
  wv.setAttribute('src', MPB_HOME_URL);
  wv.setAttribute('partition', 'persist:multiboard-browser');
  wv.setAttribute('allowpopups', '');
  wv.style.cssText = 'width:100%;height:100%;border:none;';

  wv.addEventListener('did-start-loading', () => {
    const overlay = document.getElementById('mpbLoadingOverlay');
    if (overlay) overlay.style.display = 'flex';
  });

  wv.addEventListener('did-stop-loading', () => {
    const overlay = document.getElementById('mpbLoadingOverlay');
    if (overlay) overlay.style.display = 'none';
  });

  wv.addEventListener('did-navigate', (e) => {
    mpbState.currentUrl = e.url;
    const urlBar = document.getElementById('mpbUrlBar');
    if (urlBar) urlBar.value = e.url;
    mpbUpdateNavButtons();
  });

  wv.addEventListener('did-navigate-in-page', (e) => {
    if (e.isMainFrame) {
      mpbState.currentUrl = e.url;
      const urlBar = document.getElementById('mpbUrlBar');
      if (urlBar) urlBar.value = e.url;
      mpbUpdateNavButtons();
    }
  });

  wv.addEventListener('page-title-updated', (e) => {
    const statusEl = document.getElementById('mpbStatusText');
    if (statusEl) statusEl.textContent = e.title || 'Ready';
  });

  // Handle target="_blank" links — load in same webview
  wv.addEventListener('new-window', (e) => {
    e.preventDefault();
    wv.loadURL(e.url);
  });

  container.appendChild(wv);
  mpbState.webview = wv;
}

function mpbUpdateNavButtons() {
  if (!mpbState.webview) return;
  const backBtn = document.getElementById('mpbBackBtn');
  const fwdBtn = document.getElementById('mpbForwardBtn');
  if (backBtn) backBtn.disabled = !mpbState.webview.canGoBack();
  if (fwdBtn) fwdBtn.disabled = !mpbState.webview.canGoForward();
}

// =============== SIDEBAR CATEGORY TREE ===============

function mpbBuildCategoryTree() {
  const container = document.getElementById('mpbCategoryTree');
  if (!container) return;

  let html = '';
  for (const [groupKey, group] of Object.entries(MULTIBOARD_CATALOG)) {
    const isExpanded = mpbState.expandedGroups.has(groupKey);
    html += `
      <div class="mpb-group" data-group="${groupKey}">
        <div class="mpb-group-header" data-group="${groupKey}"
             style="display:flex;align-items:center;gap:6px;padding:6px 8px;cursor:pointer;border-radius:4px;font-weight:600;font-size:0.85rem;user-select:none;">
          <span style="font-size:0.7rem;transition:transform 0.15s;${isExpanded ? 'transform:rotate(90deg);' : ''}"
                class="mpb-chevron">&#9654;</span>
          <span>${group.label}</span>
        </div>
        <div class="mpb-group-items" style="${isExpanded ? '' : 'display:none;'}padding-left:20px;">`;

    for (const item of group.items) {
      html += `
          <div class="mpb-link" data-url="${item.url}"
               style="padding:4px 8px;cursor:pointer;border-radius:4px;font-size:0.8rem;color:var(--text-secondary,#94a3b8);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
               title="${item.url}">
            ${item.label}
          </div>`;
    }

    html += `
        </div>
      </div>`;
  }

  container.innerHTML = html;

  // Event delegation
  container.addEventListener('click', (e) => {
    const header = e.target.closest('.mpb-group-header');
    if (header) {
      const groupKey = header.dataset.group;
      const group = header.closest('.mpb-group');
      const items = group.querySelector('.mpb-group-items');
      const chevron = header.querySelector('.mpb-chevron');
      if (mpbState.expandedGroups.has(groupKey)) {
        mpbState.expandedGroups.delete(groupKey);
        items.style.display = 'none';
        chevron.style.transform = '';
      } else {
        mpbState.expandedGroups.add(groupKey);
        items.style.display = '';
        chevron.style.transform = 'rotate(90deg)';
      }
      return;
    }

    const link = e.target.closest('.mpb-link');
    if (link && mpbState.webview) {
      const url = link.dataset.url;
      mpbState.webview.loadURL(url);
      // Highlight active link
      container.querySelectorAll('.mpb-link').forEach(l => {
        l.style.background = '';
        l.style.color = 'var(--text-secondary,#94a3b8)';
      });
      link.style.background = 'rgba(56, 189, 248, 0.15)';
      link.style.color = 'var(--accent,#38bdf8)';
    }
  });

  // Hover effects
  container.addEventListener('mouseover', (e) => {
    const link = e.target.closest('.mpb-link');
    if (link && !link.style.background.includes('248')) {
      link.style.background = 'rgba(255,255,255,0.05)';
    }
    const header = e.target.closest('.mpb-group-header');
    if (header) header.style.background = 'rgba(255,255,255,0.05)';
  });

  container.addEventListener('mouseout', (e) => {
    const link = e.target.closest('.mpb-link');
    if (link && !link.style.background.includes('248')) {
      link.style.background = '';
    }
    const header = e.target.closest('.mpb-group-header');
    if (header) header.style.background = '';
  });
}

// =============== EVENT LISTENERS ===============

function mpbSetupEventListeners() {
  document.getElementById('mpbBackBtn')?.addEventListener('click', () => {
    if (mpbState.webview && mpbState.webview.canGoBack()) mpbState.webview.goBack();
  });

  document.getElementById('mpbForwardBtn')?.addEventListener('click', () => {
    if (mpbState.webview && mpbState.webview.canGoForward()) mpbState.webview.goForward();
  });

  document.getElementById('mpbReloadBtn')?.addEventListener('click', () => {
    if (mpbState.webview) mpbState.webview.reload();
  });

  document.getElementById('mpbHomeBtn')?.addEventListener('click', () => {
    if (mpbState.webview) mpbState.webview.loadURL(MPB_HOME_URL);
  });

  document.getElementById('mpbOpenExternalBtn')?.addEventListener('click', () => {
    if (mpbState.currentUrl && window.printStation?.openExternal) {
      window.printStation.openExternal(mpbState.currentUrl);
    }
  });
}

// =============== DOWNLOAD EVENTS ===============

function mpbSubscribeDownloadEvents() {
  const api = window.printStation?.multiboardBrowser;
  if (!api) {
    console.warn('[MPB] multiboardBrowser API not available');
    return;
  }

  mpbState.downloadUnsub.start = api.onDownloadStart((data) => {
    const progressEl = document.getElementById('mpbDownloadProgress');
    const filenameEl = document.getElementById('mpbDownloadFilename');
    const statusEl = document.getElementById('mpbStatusText');

    if (progressEl) progressEl.style.display = 'flex';
    if (filenameEl) filenameEl.textContent = data.filename;
    document.getElementById('mpbDownloadPercent').textContent = '0%';
    document.getElementById('mpbDownloadBar').style.width = '0%';
    if (statusEl) statusEl.textContent = 'Downloading: ' + data.filename;
  });

  mpbState.downloadUnsub.progress = api.onDownloadProgress((data) => {
    if (data.totalBytes > 0) {
      const pct = Math.round((data.receivedBytes / data.totalBytes) * 100);
      const pctEl = document.getElementById('mpbDownloadPercent');
      const barEl = document.getElementById('mpbDownloadBar');
      if (pctEl) pctEl.textContent = pct + '%';
      if (barEl) barEl.style.width = pct + '%';
    }
  });

  mpbState.downloadUnsub.complete = api.onDownloadComplete((data) => {
    const progressEl = document.getElementById('mpbDownloadProgress');
    const statusEl = document.getElementById('mpbStatusText');

    if (progressEl) progressEl.style.display = 'none';

    if (data.success) {
      const triangles = data.model?.triangle_count;
      const msg = triangles
        ? 'Imported: ' + data.filename + ' (' + triangles.toLocaleString() + ' triangles)'
        : 'Downloaded: ' + data.filename;
      if (statusEl) statusEl.textContent = msg;

      // Add to import history
      mpbState.importHistory.unshift({
        filename: data.filename,
        time: Date.now(),
        model: data.model || null
      });
      if (mpbState.importHistory.length > 5) mpbState.importHistory.pop();
      mpbRenderImportHistory();
      mpbUpdateImportCount();

      // Refresh missing parts list after successful import (auto-match may have updated index)
      const missingTab = document.querySelector('.mpb-tab[data-tab="missing"]');
      if (missingTab && missingTab.classList.contains('active')) {
        setTimeout(() => { mpbLoadSyncStatus(); mpbLoadMissing(true); }, 1500);
      } else {
        // Update badge count even if not on missing tab
        setTimeout(() => mpbLoadSyncStatus(), 1500);
      }

      if (typeof window.showToast === 'function') {
        window.showToast('Imported: ' + data.filename, 'success');
      }
    } else {
      if (statusEl) statusEl.textContent = 'Download failed: ' + data.filename + ' (' + (data.error || 'unknown') + ')';
      if (typeof window.showToast === 'function') {
        window.showToast('Download failed: ' + data.filename, 'error');
      }
    }
  });
}

function mpbRenderImportHistory() {
  const container = document.getElementById('mpbImportHistory');
  if (!container) return;

  container.innerHTML = mpbState.importHistory.map(item => {
    const seconds = Math.floor((Date.now() - item.time) / 1000);
    const timeAgo = seconds < 60 ? 'just now' : seconds < 3600 ? Math.floor(seconds / 60) + 'm ago' : Math.floor(seconds / 3600) + 'h ago';
    return '<span style="background:rgba(56,189,248,0.15);color:var(--accent,#38bdf8);padding:2px 8px;border-radius:4px;white-space:nowrap;font-size:0.75rem;" title="Imported ' + timeAgo + '">' + item.filename + '</span>';
  }).join('');
}

async function mpbUpdateImportCount() {
  try {
    if (window.printStation?.stlManager?.count) {
      const count = await window.printStation.stlManager.count({ category: 'Multiboard' });
      mpbState.importCount = count;
      const el = document.getElementById('mpbImportCount');
      if (el) el.textContent = count + ' imported';
    }
  } catch (err) {
    console.warn('[MPB] Could not get import count:', err);
  }
}

// =============== MISSING PARTS PANEL ===============

const mpbMissingState = {
  items: [],
  totalMissing: 0,
  offset: 0,
  limit: 50,
  search: '',
  searchTimeout: null,
  syncing: false
};

function mpbSetupMissingPanel() {
  // Tab switching
  const tabCat = document.getElementById('mpbTabCategories');
  const tabMissing = document.getElementById('mpbTabMissing');
  const panelCat = document.getElementById('mpbCategoriesPanel');
  const panelMissing = document.getElementById('mpbMissingPanel');

  if (tabCat && tabMissing) {
    tabCat.addEventListener('click', () => {
      tabCat.classList.add('active');
      tabMissing.classList.remove('active');
      if (panelCat) panelCat.style.display = '';
      if (panelMissing) panelMissing.style.display = 'none';
    });
    tabMissing.addEventListener('click', () => {
      tabMissing.classList.add('active');
      tabCat.classList.remove('active');
      if (panelCat) panelCat.style.display = 'none';
      if (panelMissing) panelMissing.style.display = '';
      mpbLoadMissing(true);
    });
  }

  // Search
  const searchEl = document.getElementById('mpbMissingSearch');
  if (searchEl) {
    searchEl.addEventListener('input', () => {
      clearTimeout(mpbMissingState.searchTimeout);
      mpbMissingState.searchTimeout = setTimeout(() => {
        mpbMissingState.search = searchEl.value.trim();
        mpbLoadMissing(true);
      }, 300);
    });
  }

  // Load more
  const loadMoreBtn = document.getElementById('mpbLoadMoreBtn');
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener('click', () => mpbLoadMissing(false));
  }

  // Sync button
  const syncBtn = document.getElementById('mpbSyncNowBtn');
  if (syncBtn) {
    syncBtn.addEventListener('click', mpbRunSync);
  }

  // Load initial status
  mpbLoadSyncStatus();
}

async function mpbLoadSyncStatus() {
  try {
    const api = window.printStation?.slicer;
    if (!api?.thangsStatus) return;
    const status = await api.thangsStatus();
    const statsEl = document.getElementById('mpbSyncStats');
    const badgeEl = document.getElementById('mpbMissingBadge');
    const lastSyncEl = document.getElementById('mpbLastSync');

    if (statsEl) {
      statsEl.innerHTML = `<span style="color:var(--success,#10b981);">${status.matched || 0}</span> matched &middot; <span style="color:var(--warning,#eab308);">${status.missing || 0}</span> missing &middot; <span style="color:var(--text-secondary);">${status.skipped || 0}</span> skipped`;
    }
    if (badgeEl && status.missing > 0) {
      badgeEl.textContent = status.missing > 999 ? '999+' : status.missing;
      badgeEl.style.display = 'inline';
    }
    if (lastSyncEl && status.lastSync) {
      const ago = mpbTimeAgo(new Date(status.lastSync));
      lastSyncEl.textContent = `Last sync: ${ago}`;
    } else if (lastSyncEl) {
      lastSyncEl.textContent = 'Never synced';
    }
    mpbMissingState.totalMissing = status.missing || 0;
  } catch (err) {
    console.warn('[MPB] Failed to load sync status:', err);
  }
}

async function mpbLoadMissing(reset) {
  try {
    const api = window.printStation?.slicer;
    if (!api?.thangsMissing) return;

    // Load all missing parts at once for grouping
    const parts = await api.thangsMissing({
      search: mpbMissingState.search || undefined,
      limit: 5000,
      offset: 0
    });

    mpbMissingState.items = parts;
    mpbRenderMissingList();

    // Hide load-more since we fetch all
    const loadMoreEl = document.getElementById('mpbMissingLoadMore');
    if (loadMoreEl) loadMoreEl.style.display = 'none';
  } catch (err) {
    console.warn('[MPB] Failed to load missing parts:', err);
  }
}

function mpbClassifyPart(title) {
  const t = title.toLowerCase();
  if (t.includes('multibin') && t.includes('insert')) return 'MultiBin Insert';
  if (t.includes('multibin') && t.includes('shell')) return 'MultiBin Shell';
  if (t.includes('multibin') && t.includes('panel')) return 'MultiBin Panel';
  if (t.includes('multibin') && t.includes('lid')) return 'MultiBin Lid';
  if (t.includes('multibin')) return 'MultiBin Other';
  if (t.includes('octagon') && t.includes('plate')) return 'MultiBoard Octagon Plate';
  if (t.includes('square') && t.includes('plate')) return 'MultiBoard Square Plate';
  if (t.includes('plate')) return 'MultiBoard Plate';
  if (t.includes('beam')) return 'MultiBoard Beam';
  if (t.includes('side')) return 'MultiBoard Side';
  if (t.includes('multigrid')) return 'MultiGrid';
  if (t.includes('snap')) return 'MultiBoard Snap';
  if (t.includes('honeycomb')) return 'MultiBoard Honeycomb';
  if (t.includes('remix')) return 'Remixing Files';
  return 'Other';
}

function mpbRenderMissingList() {
  const container = document.getElementById('mpbMissingList');
  if (!container) return;

  if (mpbMissingState.items.length === 0) {
    container.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-secondary);font-size:0.8rem;">No missing parts found</div>';
    return;
  }

  // Group by type
  const groups = {};
  for (const item of mpbMissingState.items) {
    const type = mpbClassifyPart(item.title);
    if (!groups[type]) groups[type] = [];
    groups[type].push(item);
  }

  // Sort groups by count descending
  const sortedTypes = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length);

  container.innerHTML = sortedTypes.map(type => {
    const items = groups[type];
    return `
      <div class="mpb-missing-group" data-group="${type}">
        <div class="mpb-mg-header" data-toggle="${type}">
          <span class="mpb-mg-arrow">&#9654;</span>
          <span class="mpb-mg-name">${type}</span>
          <span class="mpb-mg-count">${items.length}</span>
        </div>
        <div class="mpb-mg-items" style="display:none;">
          ${items.map(item => {
            const thumb = item.thumbnail_url
              ? `<img class="mpb-mi-thumb" src="${item.thumbnail_url}" loading="lazy" onerror="this.style.display='none'">`
              : `<div class="mpb-mi-thumb" style="display:flex;align-items:center;justify-content:center;font-size:0.6rem;color:var(--text-secondary);">STL</div>`;
            return `
              <div class="mpb-missing-item" data-model-id="${item.thangs_model_id}" data-url="${item.download_url || ''}" title="${item.title}\n${item.owner || ''}">
                ${thumb}
                <span class="mpb-mi-title">${item.title}</span>
                <button class="mpb-mi-skip" data-skip="${item.thangs_model_id}" title="Skip this part">Skip</button>
              </div>`;
          }).join('')}
        </div>
      </div>`;
  }).join('');

  // Toggle group collapse
  container.querySelectorAll('.mpb-mg-header').forEach(header => {
    header.addEventListener('click', () => {
      const group = header.closest('.mpb-missing-group');
      const itemsEl = group.querySelector('.mpb-mg-items');
      const arrow = header.querySelector('.mpb-mg-arrow');
      const isOpen = itemsEl.style.display !== 'none';
      itemsEl.style.display = isOpen ? 'none' : '';
      arrow.innerHTML = isOpen ? '&#9654;' : '&#9660;';
      header.classList.toggle('open', !isOpen);
    });
  });

  // Click to navigate webview
  container.querySelectorAll('.mpb-missing-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.mpb-mi-skip')) return;
      const url = el.dataset.url;
      if (url && mpbState.webview) {
        mpbState.webview.loadURL(url);
      }
    });
  });

  // Skip buttons
  container.querySelectorAll('.mpb-mi-skip').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const modelId = btn.dataset.skip;
      try {
        const api = window.printStation?.slicer;
        if (api?.thangsSkip) {
          await api.thangsSkip(modelId);
          const itemEl = btn.closest('.mpb-missing-item');
          if (itemEl) itemEl.remove();
          mpbMissingState.items = mpbMissingState.items.filter(i => i.thangs_model_id !== modelId);
          // Update group count
          const groupEl = btn.closest('.mpb-missing-group');
          if (groupEl) {
            const countEl = groupEl.querySelector('.mpb-mg-count');
            const remaining = groupEl.querySelectorAll('.mpb-missing-item').length;
            if (countEl) countEl.textContent = remaining;
            if (remaining === 0) groupEl.remove();
          }
          mpbLoadSyncStatus();
        }
      } catch (err) {
        console.warn('[MPB] Skip failed:', err);
      }
    });
  });
}

async function mpbRunSync() {
  if (mpbMissingState.syncing) return;
  const btn = document.getElementById('mpbSyncNowBtn');
  const lastSyncEl = document.getElementById('mpbLastSync');

  try {
    mpbMissingState.syncing = true;
    if (btn) { btn.textContent = 'Crawling Thangs...'; btn.style.opacity = '0.6'; }
    if (lastSyncEl) lastSyncEl.textContent = 'Crawling Thangs API...';

    // Phase 1: Crawl Thangs search API from this local machine (bypasses Cloudflare)
    const models = await mpbCrawlThangsAPI();

    if (btn) btn.textContent = 'Importing...';
    if (lastSyncEl) lastSyncEl.textContent = `Importing ${models.length} models...`;

    // Phase 2: Send crawled data to server for import + matching
    const api = window.printStation?.slicer;
    if (api?.thangsImport) {
      const result = await api.thangsImport(models);
      if (typeof window.showToast === 'function') {
        window.showToast(`Sync complete: ${result.matched || 0} matched, ${result.missing || 0} missing`, 'success');
      }
    }

    mpbMissingState.syncing = false;
    if (btn) { btn.textContent = 'Sync with Thangs'; btn.style.opacity = '1'; }
    await mpbLoadSyncStatus();
    await mpbLoadMissing(true);

  } catch (err) {
    console.error('[MPB] Sync failed:', err);
    mpbMissingState.syncing = false;
    if (btn) { btn.textContent = 'Sync with Thangs'; btn.style.opacity = '1'; }
    if (typeof window.showToast === 'function') {
      window.showToast('Sync failed: ' + err.message, 'error');
    }
  }
}

/**
 * Crawl Thangs search API from the Electron renderer (local machine).
 * Cloudflare blocks datacenter IPs but allows residential/dev machines.
 */
async function mpbCrawlThangsAPI() {
  const OWNERS = new Set(['multiboard', 'multibuild', 'keep making']);
  const PAGE_SIZE = 50;
  const MAX_PAGES = 200;
  const searchTerms = ['multiboard', 'multibin', 'multigrid'];
  const allModels = new Map();

  for (const term of searchTerms) {
    let page = 0;
    let consecutiveEmpty = 0;

    while (page < MAX_PAGES) {
      const url = `https://thangs.com/api/models/v3/search-by-text?searchTerm=${encodeURIComponent(term)}&scope=thangs&pageSize=${PAGE_SIZE}&page=${page}&collapse=true&freeModels=true`;

      try {
        const resp = await fetch(url, {
          headers: {
            'Accept': 'application/json',
            'Origin': 'https://thangs.com',
            'Referer': 'https://thangs.com/'
          }
        });
        if (resp.status === 429) {
          await new Promise(r => setTimeout(r, 10000));
          continue;
        }
        if (!resp.ok) break;

        const data = await resp.json();
        const results = data.results || [];

        if (!results.length) {
          consecutiveEmpty++;
          if (consecutiveEmpty >= 2) break;
          page++;
          continue;
        }

        consecutiveEmpty = 0;
        for (const model of results) {
          const owner = (model.ownerUsername || '').toLowerCase();
          if (!OWNERS.has(owner)) continue;
          const modelId = String(model.modelId || model.id);
          if (allModels.has(modelId)) continue;
          allModels.set(modelId, {
            thangs_model_id: modelId,
            title: model.name || 'Unknown',
            filename: model.modelFileName || null,
            thumbnail_url: model.thumbnailUrl || null,
            owner: model.ownerUsername || null,
            part_ids: (model.parts || []).map(p => String(p.modelId || p.id || '')).filter(Boolean),
            download_url: model.modelPageUrl || `https://thangs.com/m/${modelId}`
          });
        }

        // Update status in UI
        const lastSyncEl = document.getElementById('mpbLastSync');
        if (lastSyncEl) lastSyncEl.textContent = `Found ${allModels.size} models...`;

        page++;
        await new Promise(r => setTimeout(r, 300));
      } catch (err) {
        console.warn(`[MPB] Crawl error page ${page}:`, err);
        break;
      }
    }
  }

  return [...allModels.values()];
}

function mpbTimeAgo(date) {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
  return Math.floor(seconds / 86400) + 'd ago';
}

// =============== PUBLIC API ===============

/**
 * Switch to the Parts Browser view and search for a term.
 * Called externally (e.g. from Print Quotes view) when a missing part needs to be found.
 * @param {string} searchTerm
 */
window.mpbOpenSearch = function (searchTerm) {
  // Switch to the parts browser view
  if (typeof switchView === 'function') {
    switchView('multiboardPartsBrowserView');
  }

  const searchUrl = 'https://thangs.com/search?q=' + encodeURIComponent('multiboard ' + searchTerm);

  // If the webview is already initialized, navigate immediately
  if (mpbState.webview) {
    mpbState.webview.loadURL(searchUrl);
  } else {
    // Not yet initialized — init the view then navigate after webview is ready
    initMultiboardPartsBrowserView();
    const poll = setInterval(() => {
      if (mpbState.webview) {
        clearInterval(poll);
        mpbState.webview.loadURL(searchUrl);
      }
    }, 100);
  }
};
