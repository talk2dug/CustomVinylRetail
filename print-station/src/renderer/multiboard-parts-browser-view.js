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
