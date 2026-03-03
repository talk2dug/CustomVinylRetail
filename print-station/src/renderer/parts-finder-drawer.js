'use strict';
/**
 * parts-finder-drawer.js — Slide-in panel for finding missing Multiboard parts
 *
 * Provides a 480px drawer that slides in from the right without navigating away
 * from the current view. Embeds a webview to browse Thangs, Printables, or Thingiverse.
 *
 * Public API:
 *   window.openPartsFinderDrawer(searchTerm)   — open and pre-search
 *   window.closePartsFinderDrawer()            — close drawer
 */
(function () {

  const SOURCES = {
    thangs:      q => `https://thangs.com/search?q=${encodeURIComponent('multiboard ' + q)}&scope=all`,
    printables:  q => `https://www.printables.com/search/models?q=${encodeURIComponent(q)}`,
    thingiverse: q => `https://www.thingiverse.com/search?q=${encodeURIComponent('multiboard ' + q)}`
  };

  let drawerWebview = null;
  let currentSource = 'thangs';
  let drawerReady   = false;

  // ── Build DOM ────────────────────────────────────────────────────────────────

  function buildDrawer() {
    if (document.getElementById('partsFinderDrawer')) return;

    // Backdrop
    const backdrop = document.createElement('div');
    backdrop.id = 'partsFinderBackdrop';
    backdrop.style.cssText =
      'display:none;position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:9899;';
    backdrop.addEventListener('click', closePartsFinderDrawer);
    document.body.appendChild(backdrop);

    // Drawer shell
    const drawer = document.createElement('div');
    drawer.id = 'partsFinderDrawer';
    drawer.style.cssText = `
      position:fixed;top:0;right:0;bottom:0;width:520px;max-width:96vw;
      background:#0d1117;border-left:2px solid #333;
      z-index:9900;
      transform:translateX(100%);
      transition:transform 0.25s cubic-bezier(0.4,0,0.2,1);
      display:flex;flex-direction:column;
      box-shadow:-6px 0 32px rgba(0,0,0,0.6);
    `;

    drawer.innerHTML = `
      <!-- Header -->
      <div style="display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid #222;flex-shrink:0;background:#111827;">
        <div style="font-weight:700;font-size:14px;color:#e0e0e0;white-space:nowrap;">Find Parts</div>
        <input id="partsFinderSearch" type="text" placeholder="Search by name…"
          style="flex:1;padding:6px 10px;font-size:13px;border-radius:5px;border:1px solid #333;background:#1a1a2e;color:#eee;min-width:0;">
        <button id="partsFinderSearchBtn"
          style="padding:6px 14px;font-size:12px;background:#1565c0;color:#fff;border:none;border-radius:4px;cursor:pointer;white-space:nowrap;">
          Search
        </button>
        <button id="partsFinderClose"
          style="background:none;border:none;color:#666;font-size:20px;cursor:pointer;padding:2px 6px;line-height:1;"
          title="Close">✕</button>
      </div>

      <!-- Source selector -->
      <div id="partsFinderSources" style="display:flex;gap:4px;padding:8px 14px;border-bottom:1px solid #1a1a2e;flex-shrink:0;background:#0d1117;">
        <button class="pfd-src active" data-source="thangs"
          style="padding:4px 12px;font-size:11px;border-radius:4px;cursor:pointer;border:1px solid #2196f3;background:#0d1e3d;color:#2196f3;">
          Thangs
        </button>
        <button class="pfd-src" data-source="printables"
          style="padding:4px 12px;font-size:11px;border-radius:4px;cursor:pointer;border:1px solid #444;background:transparent;color:#888;">
          Printables
        </button>
        <button class="pfd-src" data-source="thingiverse"
          style="padding:4px 12px;font-size:11px;border-radius:4px;cursor:pointer;border:1px solid #444;background:transparent;color:#888;">
          Thingiverse
        </button>
        <div style="margin-left:auto;font-size:11px;color:#555;align-self:center;padding-right:2px;">
          "multiboard" added to Thangs/TV searches automatically
        </div>
      </div>

      <!-- Webview container -->
      <div id="partsFinderWebviewContainer" style="flex:1;min-height:0;position:relative;background:#111;">
        <div id="partsFinderPlaceholder" style="
          position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;
          color:#555;gap:12px;font-size:13px;
        ">
          <div style="font-size:2.5rem;">🔍</div>
          <div>Enter a part name and click Search</div>
        </div>
      </div>
    `;

    document.body.appendChild(drawer);
    drawerReady = true;
    wireDrawerEvents(drawer);
  }

  // ── Events ───────────────────────────────────────────────────────────────────

  function wireDrawerEvents(drawer) {
    drawer.querySelector('#partsFinderClose')
      .addEventListener('click', closePartsFinderDrawer);

    drawer.querySelector('#partsFinderSearchBtn')
      .addEventListener('click', doSearch);

    drawer.querySelector('#partsFinderSearch')
      .addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

    drawer.querySelectorAll('.pfd-src').forEach(btn => {
      btn.addEventListener('click', () => {
        currentSource = btn.dataset.source;
        // Update button styles
        drawer.querySelectorAll('.pfd-src').forEach(b => {
          const active = b === btn;
          b.style.borderColor = active ? '#2196f3' : '#444';
          b.style.background  = active ? '#0d1e3d' : 'transparent';
          b.style.color       = active ? '#2196f3' : '#888';
          if (active) b.classList.add('active'); else b.classList.remove('active');
        });
        const q = drawer.querySelector('#partsFinderSearch').value.trim();
        if (q) doSearch();
      });
    });
  }

  // ── Webview ──────────────────────────────────────────────────────────────────

  function getOrCreateWebview() {
    if (drawerWebview) return drawerWebview;

    const container = document.getElementById('partsFinderWebviewContainer');
    const placeholder = document.getElementById('partsFinderPlaceholder');

    const wv = document.createElement('webview');
    wv.setAttribute('src', 'about:blank');
    wv.setAttribute('allowpopups', '');
    wv.setAttribute('partition', 'persist:partsfinder');
    wv.style.cssText = 'width:100%;height:100%;border:none;display:block;';

    if (placeholder) placeholder.style.display = 'none';
    container.appendChild(wv);
    drawerWebview = wv;
    return wv;
  }

  function doSearch() {
    const q = document.getElementById('partsFinderSearch').value.trim();
    if (!q) return;
    const urlFn = SOURCES[currentSource] || SOURCES.thangs;
    const url = urlFn(q);
    const placeholder = document.getElementById('partsFinderPlaceholder');
    if (placeholder) placeholder.style.display = 'none';
    const wv = getOrCreateWebview();
    wv.src = url;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  function openPartsFinderDrawer(searchTerm) {
    if (!drawerReady) buildDrawer();

    const drawer   = document.getElementById('partsFinderDrawer');
    const backdrop = document.getElementById('partsFinderBackdrop');
    const input    = document.getElementById('partsFinderSearch');

    if (!drawer) return;

    if (searchTerm) input.value = searchTerm;

    backdrop.style.display = 'block';
    // Force reflow so transition plays
    drawer.getBoundingClientRect();
    drawer.style.transform = 'translateX(0)';

    if (searchTerm) {
      // Slight delay so transition is visible before loading starts
      setTimeout(doSearch, 80);
    }
  }

  function closePartsFinderDrawer() {
    const drawer   = document.getElementById('partsFinderDrawer');
    const backdrop = document.getElementById('partsFinderBackdrop');
    if (!drawer) return;
    drawer.style.transform = 'translateX(100%)';
    backdrop.style.display = 'none';
  }

  // Build drawer immediately (hidden), expose APIs
  document.addEventListener('DOMContentLoaded', buildDrawer);

  window.openPartsFinderDrawer  = openPartsFinderDrawer;
  window.closePartsFinderDrawer = closePartsFinderDrawer;

})();
