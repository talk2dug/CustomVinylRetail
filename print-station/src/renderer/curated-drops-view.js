/**
 * Curated Drops View
 *
 * Browse S&S catalog, pair designs with premium apparel,
 * generate mockups, and launch limited-run campaigns.
 */

const curatedDropsState = {
  initialized: false,
  ssawResults: [],
  selectedStyle: null,
  selectedVariants: [],
  selectedColor: null,
  designCatalog: [],
  designCategories: [],
  selectedDesign: null,
  pairings: [],
  currentMockups: [],
  zone: 'front-chest',
  size: 'large',
  generating: false,
  theme: 'default',
  quantity: 25,
  dropDuration: '48 hours',
  dropName: ''
};

function initCuratedDropsView() {
  if (curatedDropsState.initialized) return;
  curatedDropsState.initialized = true;
  setupCuratedDropsListeners();
  loadDesignCatalog();
}

// ── Event Listeners ──────────────────────────────────────────────────────────

function setupCuratedDropsListeners() {
  // S&S Search
  const searchBtn = document.getElementById('cd-ssaw-search-btn');
  const searchInput = document.getElementById('cd-ssaw-search');
  if (searchBtn) searchBtn.addEventListener('click', () => searchSSAW());
  if (searchInput) searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') searchSSAW();
  });

  // Design search
  const designSearch = document.getElementById('cd-design-search');
  if (designSearch) designSearch.addEventListener('input', () => filterDesigns());

  // Design category filter
  const catFilter = document.getElementById('cd-design-category');
  if (catFilter) catFilter.addEventListener('change', () => filterDesigns());

  // Zone/size controls
  const zoneSelect = document.getElementById('cd-zone');
  if (zoneSelect) zoneSelect.addEventListener('change', (e) => { curatedDropsState.zone = e.target.value; });
  const sizeSelect = document.getElementById('cd-size');
  if (sizeSelect) sizeSelect.addEventListener('change', (e) => { curatedDropsState.size = e.target.value; });

  // Preview mockup
  const previewBtn = document.getElementById('cd-preview-btn');
  if (previewBtn) previewBtn.addEventListener('click', () => previewMockup());

  // Add pairing
  const addPairingBtn = document.getElementById('cd-add-pairing-btn');
  if (addPairingBtn) addPairingBtn.addEventListener('click', () => addPairing());

  // Launch
  const launchBtn = document.getElementById('cd-launch-btn');
  if (launchBtn) launchBtn.addEventListener('click', () => launchDrop());

  // Generate copy preview
  const copyBtn = document.getElementById('cd-preview-copy-btn');
  if (copyBtn) copyBtn.addEventListener('click', () => previewCopy());

  // Theme select
  const themeSelect = document.getElementById('cd-theme');
  if (themeSelect) themeSelect.addEventListener('change', (e) => { curatedDropsState.theme = e.target.value; });
}

// ── S&S Catalog Search ───────────────────────────────────────────────────────

async function searchSSAW() {
  const query = document.getElementById('cd-ssaw-search')?.value?.trim();
  if (!query) return;

  const grid = document.getElementById('cd-ssaw-results');
  const btn = document.getElementById('cd-ssaw-search-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Searching...'; }

  try {
    const data = await printStation.curatedDrop.searchSSAW(query);
    curatedDropsState.ssawResults = data.styles || [];
    renderSSAWResults();
  } catch (err) {
    if (grid) grid.innerHTML = `<div class="cd-error">Search failed: ${err.message}</div>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Search'; }
  }
}

function renderSSAWResults() {
  const grid = document.getElementById('cd-ssaw-results');
  if (!grid) return;

  const styles = curatedDropsState.ssawResults;
  if (!styles.length) {
    grid.innerHTML = '<div class="cd-empty">No results found. Try a different search term.</div>';
    return;
  }

  grid.innerHTML = styles.map(s => `
    <div class="cd-ssaw-card ${curatedDropsState.selectedStyle?.styleID === s.styleID ? 'selected' : ''}"
         onclick="selectSSAWStyle(${s.styleID})">
      <img src="${s.imageUrl || ''}" alt="${s.title}" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2280%22 height=%2280%22><rect fill=%22%23333%22 width=%2280%22 height=%2280%22/><text x=%2240%22 y=%2244%22 text-anchor=%22middle%22 fill=%22%23666%22 font-size=%2212%22>No Image</text></svg>'">
      <div class="cd-ssaw-card-info">
        <div class="cd-ssaw-card-title">${s.title || s.styleName}</div>
        <div class="cd-ssaw-card-brand">${s.brandName || ''}</div>
        <div class="cd-ssaw-card-type">${s.baseCategory || s.productType || ''}</div>
      </div>
    </div>
  `).join('');
}

async function selectSSAWStyle(styleId) {
  const style = curatedDropsState.ssawResults.find(s => s.styleID === styleId);
  if (!style) return;
  curatedDropsState.selectedStyle = style;
  renderSSAWResults(); // update selection highlight

  // Load variants (colors/sizes)
  const colorGrid = document.getElementById('cd-color-picker');
  if (colorGrid) colorGrid.innerHTML = '<div class="cd-loading">Loading colors...</div>';

  try {
    const data = await printStation.curatedDrop.getProducts(styleId);
    const variants = data.variants || [];

    // Deduplicate by color, prefer ones with front images
    const colorMap = {};
    variants.forEach(v => {
      if (!colorMap[v.color] || (v.frontImageUrl && !colorMap[v.color].frontImageUrl)) {
        colorMap[v.color] = v;
      }
    });
    curatedDropsState.selectedVariants = Object.values(colorMap);
    curatedDropsState.selectedColor = null;
    renderColorPicker();
  } catch (err) {
    if (colorGrid) colorGrid.innerHTML = `<div class="cd-error">Failed to load variants: ${err.message}</div>`;
  }
}

function renderColorPicker() {
  const grid = document.getElementById('cd-color-picker');
  if (!grid) return;

  const variants = curatedDropsState.selectedVariants;
  if (!variants.length) {
    grid.innerHTML = '<div class="cd-empty">No color variants available.</div>';
    return;
  }

  grid.innerHTML = variants.map(v => `
    <div class="cd-color-chip ${curatedDropsState.selectedColor?.sku === v.sku ? 'selected' : ''}"
         onclick="selectColor('${v.sku}')" title="${v.color} - $${v.piecePrice || '?'}">
      <img src="${v.frontImageUrl || v.imageUrl || ''}" alt="${v.color}"
           onerror="this.style.display='none'">
      <span>${v.color}</span>
      <span class="cd-price">$${(v.piecePrice || 0).toFixed(2)}</span>
    </div>
  `).join('');

  // Update garment preview
  updateGarmentPreview();
}

function selectColor(sku) {
  const v = curatedDropsState.selectedVariants.find(v => v.sku === sku);
  if (!v) return;
  curatedDropsState.selectedColor = v;
  renderColorPicker();
  updateGarmentPreview();
}

function updateGarmentPreview() {
  const preview = document.getElementById('cd-garment-preview');
  if (!preview) return;

  const color = curatedDropsState.selectedColor;
  const style = curatedDropsState.selectedStyle;

  if (!color && !style) {
    preview.innerHTML = '<div class="cd-preview-placeholder">Select a garment and color to preview</div>';
    return;
  }

  const imgUrl = color ? (color.frontImageUrl || color.imageUrl) : style?.imageUrl;
  const backUrl = color?.backImageUrl || '';
  const title = style?.title || '';
  const colorName = color?.color || '';
  const price = color?.piecePrice ? `$${color.piecePrice.toFixed(2)}` : '';

  preview.innerHTML = `
    <div class="cd-garment-preview-inner">
      <div class="cd-garment-images">
        <img src="${imgUrl}" alt="${title} - ${colorName}" class="cd-garment-img active" id="cd-garment-front">
        ${backUrl ? `<img src="${backUrl}" alt="${title} back" class="cd-garment-img" id="cd-garment-back">` : ''}
      </div>
      ${backUrl ? `<div class="cd-garment-toggle">
        <button class="cd-toggle-btn active" onclick="toggleGarmentView('front')">Front</button>
        <button class="cd-toggle-btn" onclick="toggleGarmentView('back')">Back</button>
      </div>` : ''}
      <div class="cd-garment-info">
        <strong>${title}</strong>
        <span>${colorName} ${price}</span>
        <span class="cd-brand">${style?.brandName || ''}</span>
      </div>
    </div>`;
}

function toggleGarmentView(side) {
  const front = document.getElementById('cd-garment-front');
  const back = document.getElementById('cd-garment-back');
  if (!front || !back) return;

  document.querySelectorAll('.cd-toggle-btn').forEach(b => b.classList.remove('active'));
  if (side === 'back') {
    front.classList.remove('active');
    back.classList.add('active');
    document.querySelectorAll('.cd-toggle-btn')[1]?.classList.add('active');
    document.getElementById('cd-zone').value = 'back';
    curatedDropsState.zone = 'back';
  } else {
    back.classList.remove('active');
    front.classList.add('active');
    document.querySelectorAll('.cd-toggle-btn')[0]?.classList.add('active');
    document.getElementById('cd-zone').value = 'front-chest';
    curatedDropsState.zone = 'front-chest';
  }
}

// ── Design Catalog ───────────────────────────────────────────────────────────

function getCdServerUrl() {
  return window.printStationConfig?.serverBaseUrl || window.APP_CONFIG?.serverUrl || 'https://store.swayzecustomvinyl.com';
}

async function loadDesignCatalog() {
  try {
    const baseUrl = getCdServerUrl();
    const resp = await fetch(`${baseUrl}/web/catalog.json`);
    const data = await resp.json();
    const categories = data.categories || [];
    const allDesigns = [];
    const catNames = [];

    categories.forEach(cat => {
      if (!cat.designs?.length) return;
      // Skip non-apparel categories
      const skip = ['human models', 'mockup backgrounds', 'sticker sheets', 'stickerpackages', 'jdm stickers', 'car stickers', 'meme stickers'];
      if (skip.some(s => cat.name.toLowerCase().includes(s))) return;

      catNames.push(cat.name);
      cat.designs.forEach(d => {
        allDesigns.push({ ...d, category: cat.name });
      });
    });

    curatedDropsState.designCatalog = allDesigns;
    curatedDropsState.designCategories = catNames.sort();

    // Populate category dropdown
    const catSelect = document.getElementById('cd-design-category');
    if (catSelect) {
      catSelect.innerHTML = '<option value="">All Categories</option>' +
        catNames.map(c => `<option value="${c}">${c} (${categories.find(cc => cc.name === c)?.designs?.length || 0})</option>`).join('');
    }
  } catch (err) {
    console.error('[CuratedDrops] Failed to load catalog:', err);
  }
}

function filterDesigns() {
  const query = (document.getElementById('cd-design-search')?.value || '').toLowerCase().trim();
  const category = document.getElementById('cd-design-category')?.value || '';

  let designs = curatedDropsState.designCatalog;
  if (category) designs = designs.filter(d => d.category === category);
  if (query) designs = designs.filter(d => (d.name || '').toLowerCase().includes(query));

  renderDesignGrid(designs.slice(0, 60));
}

function renderDesignGrid(designs) {
  const grid = document.getElementById('cd-design-results');
  if (!grid) return;

  if (!designs.length) {
    grid.innerHTML = '<div class="cd-empty">No designs found. Try a different search or category.</div>';
    return;
  }

  grid.innerHTML = designs.map(d => `
    <div class="cd-design-card ${curatedDropsState.selectedDesign?.id === d.id ? 'selected' : ''}"
         onclick="selectDesign('${d.id}')">
      <img src="${d.image}" alt="${d.name}" loading="lazy"
           onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2280%22 height=%2280%22><rect fill=%22%23222%22 width=%2280%22 height=%2280%22/></svg>'">
      <div class="cd-design-card-name">${d.name || 'Untitled'}</div>
    </div>
  `).join('');
}

function selectDesign(designId) {
  const d = curatedDropsState.designCatalog.find(d => d.id === designId);
  if (!d) return;
  curatedDropsState.selectedDesign = d;

  // Re-render to show selection
  const cards = document.querySelectorAll('.cd-design-card');
  cards.forEach(c => c.classList.remove('selected'));
  const selected = [...cards].find(c => c.getAttribute('onclick')?.includes(designId));
  if (selected) selected.classList.add('selected');

  // Update design preview
  const preview = document.getElementById('cd-design-preview');
  if (preview) {
    preview.innerHTML = `
      <img src="${d.image}" alt="${d.name}">
      <div class="cd-design-preview-name">${d.name}</div>
      <div class="cd-design-preview-cat">${d.category}</div>
    `;
  }
}

// ── Mockup Preview ───────────────────────────────────────────────────────────

async function previewMockup() {
  const color = curatedDropsState.selectedColor;
  const design = curatedDropsState.selectedDesign;
  const zone = curatedDropsState.zone;

  if (!color) return showCdToast('Select a garment color first', 'warning');
  if (!design) return showCdToast('Select a design first', 'warning');

  const garmentImageUrl = zone === 'back' ? (color.backImageUrl || color.frontImageUrl) : color.frontImageUrl;
  if (!garmentImageUrl) return showCdToast('No garment image available for this view', 'warning');

  const previewArea = document.getElementById('cd-mockup-preview');
  const btn = document.getElementById('cd-preview-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Generating...'; }
  if (previewArea) previewArea.innerHTML = '<div class="cd-loading">Generating mockup with Gemini AI... This takes 10-30 seconds.</div>';
  curatedDropsState.generating = true;

  try {
    const result = await printStation.curatedDrop.previewMockup({
      garmentImageUrl,
      designImageUrl: design.image,
      zone,
      size: curatedDropsState.size,
      garmentType: curatedDropsState.selectedStyle?.productType || curatedDropsState.selectedStyle?.baseCategory || 'apparel'
    });

    const mockups = result.mockups || [];
    curatedDropsState.currentMockups = mockups;

    if (!mockups.length) {
      previewArea.innerHTML = '<div class="cd-error">No mockups generated. Try again.</div>';
      return;
    }

    // Build the server URL for the image
    previewArea.innerHTML = mockups.map((m, i) => {
      const imgSrc = `${getCdServerUrl()}/api/curated-drop/image/${encodeURIComponent(m.filename)}`;
      return `
        <div class="cd-mockup-result">
          <img src="${imgSrc}" alt="Mockup ${i + 1}" onclick="window.open(this.src, '_blank')">
          <div class="cd-mockup-label">
            ${design.name} on ${curatedDropsState.selectedStyle?.title || 'garment'} (${color.color}) — ${zone}
          </div>
        </div>`;
    }).join('');
  } catch (err) {
    if (previewArea) previewArea.innerHTML = `<div class="cd-error">Mockup generation failed: ${err.message}</div>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Preview Mockup'; }
    curatedDropsState.generating = false;
  }
}

// ── Pairings Management ──────────────────────────────────────────────────────

function addPairing() {
  const style = curatedDropsState.selectedStyle;
  const color = curatedDropsState.selectedColor;
  const design = curatedDropsState.selectedDesign;
  const mockups = curatedDropsState.currentMockups;

  if (!style || !color || !design) return showCdToast('Select a garment, color, and design first', 'warning');

  const zone = curatedDropsState.zone;
  const garmentImageUrl = zone === 'back' ? (color.backImageUrl || color.frontImageUrl) : color.frontImageUrl;

  const pairing = {
    id: `pair_${Date.now()}`,
    garmentStyleId: style.styleID,
    garmentTitle: style.title,
    garmentBrand: style.brandName,
    garmentStyle: style.styleName,
    garmentType: style.productType || style.baseCategory || 'apparel',
    color: color.color,
    sku: color.sku,
    garmentImageUrl,
    garmentBackImageUrl: color.backImageUrl,
    designId: design.id,
    designName: design.name,
    designImageUrl: design.image,
    designCategory: design.category,
    zone,
    size: curatedDropsState.size,
    mockups: mockups.map(m => ({ ...m })),
    piecePrice: color.piecePrice
  };

  curatedDropsState.pairings.push(pairing);
  renderPairings();
  showCdToast(`Added: ${design.name} on ${style.title} (${color.color})`, 'success');
}

function removePairing(pairingId) {
  curatedDropsState.pairings = curatedDropsState.pairings.filter(p => p.id !== pairingId);
  renderPairings();
}

function renderPairings() {
  const container = document.getElementById('cd-pairings-list');
  const count = document.getElementById('cd-pairings-count');
  if (count) count.textContent = curatedDropsState.pairings.length;

  if (!container) return;

  if (!curatedDropsState.pairings.length) {
    container.innerHTML = '<div class="cd-empty">No pairings yet. Select a garment + design and click "Add Pairing".</div>';
    return;
  }

  container.innerHTML = curatedDropsState.pairings.map(p => {
    const mockupImg = p.mockups?.[0]?.filename
      ? `<img src="${getCdServerUrl()}/api/curated-drop/image/${encodeURIComponent(p.mockups[0].filename)}" alt="mockup">`
      : `<img src="${p.designImageUrl}" alt="design">`;

    return `
      <div class="cd-pairing-card">
        <div class="cd-pairing-mockup">${mockupImg}</div>
        <div class="cd-pairing-info">
          <strong>${p.designName}</strong>
          <span>${p.garmentTitle} — ${p.color}</span>
          <span class="cd-pairing-meta">${p.zone} / ${p.size} / $${(p.piecePrice || 0).toFixed(2)} cost</span>
        </div>
        <button class="cd-remove-btn" onclick="removePairing('${p.id}')" title="Remove">✕</button>
      </div>`;
  }).join('');
}

// ── Copy Preview ─────────────────────────────────────────────────────────────

async function previewCopy() {
  const theme = document.getElementById('cd-theme')?.value || 'default';
  const qty = parseInt(document.getElementById('cd-quantity')?.value) || 25;
  const duration = document.getElementById('cd-duration')?.value || '48 hours';
  const name = document.getElementById('cd-drop-name')?.value || 'Limited Drop';

  const firstPairing = curatedDropsState.pairings[0];

  const copyArea = document.getElementById('cd-copy-preview');
  if (copyArea) copyArea.innerHTML = '<div class="cd-loading">Generating copy...</div>';

  try {
    const copy = await printStation.curatedDrop.generateCopy({
      theme,
      quantity: qty,
      garmentType: firstPairing?.garmentType || 'apparel',
      designName: firstPairing?.designName || 'Custom Design',
      dropName: name,
      dropDuration: duration,
      garmentBrand: firstPairing?.garmentBrand || '',
      garmentStyle: firstPairing?.garmentStyle || ''
    });

    if (copyArea) {
      copyArea.innerHTML = `
        <div class="cd-copy-section">
          <h4>Hook</h4>
          <p class="cd-copy-text">${copy.hook}</p>
        </div>
        <div class="cd-copy-section">
          <h4>Body</h4>
          <p class="cd-copy-text">${copy.body}</p>
        </div>
        <div class="cd-copy-section">
          <h4>CTA</h4>
          <p class="cd-copy-text">${copy.cta}</p>
        </div>
        <div class="cd-copy-section">
          <h4>TikTok Ad Hook</h4>
          <p class="cd-copy-text">${copy.adHook}</p>
        </div>
        <div class="cd-copy-section">
          <h4>TikTok Caption</h4>
          <p class="cd-copy-text cd-mono">${copy.tiktokCaption?.replace(/\n/g, '<br>')}</p>
        </div>
        <div class="cd-copy-section">
          <h4>Facebook Caption</h4>
          <p class="cd-copy-text cd-mono">${copy.facebookCaption?.replace(/\n/g, '<br>')}</p>
        </div>
        <div class="cd-copy-section">
          <h4>Shopify Description</h4>
          <div class="cd-copy-shopify">${copy.shopifyDescription}</div>
        </div>
      `;
    }
  } catch (err) {
    if (copyArea) copyArea.innerHTML = `<div class="cd-error">Copy generation failed: ${err.message}</div>`;
  }
}

// ── Launch Drop ──────────────────────────────────────────────────────────────

async function launchDrop() {
  if (!curatedDropsState.pairings.length) return showCdToast('Add at least one pairing first', 'warning');

  const name = document.getElementById('cd-drop-name')?.value || 'Limited Drop';
  const theme = document.getElementById('cd-theme')?.value || 'default';
  const qty = parseInt(document.getElementById('cd-quantity')?.value) || 25;
  const duration = document.getElementById('cd-duration')?.value || '48 hours';

  const btn = document.getElementById('cd-launch-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Launching...'; }

  const statusArea = document.getElementById('cd-launch-status');
  if (statusArea) statusArea.innerHTML = '<div class="cd-loading">Generating mockups and marketing assets... This may take a few minutes.</div>';

  try {
    const campaign = await printStation.curatedDrop.launch({
      name,
      theme,
      quantity: qty,
      dropDuration: duration,
      pairings: curatedDropsState.pairings
    });

    if (statusArea) {
      const successMockups = (campaign.mockups || []).filter(m => !m.error);
      const failedMockups = (campaign.mockups || []).filter(m => m.error);

      statusArea.innerHTML = `
        <div class="cd-success">
          <h3>Drop "${campaign.name}" is ready!</h3>
          <p>Campaign ID: <code>${campaign.id}</code></p>
          <p>Status: <strong>${campaign.status}</strong></p>
          <p>Mockups generated: ${successMockups.length} ${failedMockups.length ? `(${failedMockups.length} failed)` : ''}</p>
          <div class="cd-launch-mockups">
            ${successMockups.map(m => `
              <div class="cd-launch-mockup-thumb">
                <img src="${getCdServerUrl()}/api/curated-drop/image/${encodeURIComponent(m.filename)}" alt="${m.designName}"
                     onclick="window.open(this.src, '_blank')">
                <span>${m.designName} — ${m.color}</span>
              </div>
            `).join('')}
          </div>
          <div class="cd-launch-copy">
            <h4>Marketing Copy</h4>
            <p><strong>Hook:</strong> ${campaign.copy?.hook || ''}</p>
            <p><strong>Ad Hook:</strong> ${campaign.copy?.adHook || ''}</p>
            <p><strong>CTA:</strong> ${campaign.copy?.cta || ''}</p>
          </div>
        </div>
      `;
    }

    showCdToast(`Drop "${campaign.name}" launched successfully!`, 'success');
  } catch (err) {
    if (statusArea) statusArea.innerHTML = `<div class="cd-error">Launch failed: ${err.message}</div>`;
    showCdToast('Launch failed: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Launch Drop'; }
  }
}

// ── Utilities ────────────────────────────────────────────────────────────────

function showCdToast(msg, type = 'info') {
  // Use existing toast system if available
  if (typeof window.showToast === 'function') {
    window.showToast(msg, type);
    return;
  }
  console.log(`[CuratedDrops] ${type}: ${msg}`);
}

// Expose functions globally
window.initCuratedDropsView = initCuratedDropsView;
window.selectSSAWStyle = selectSSAWStyle;
window.selectColor = selectColor;
window.selectDesign = selectDesign;
window.toggleGarmentView = toggleGarmentView;
window.removePairing = removePairing;
