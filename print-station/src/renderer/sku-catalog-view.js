// =============== SKU Catalog View - POS System ===============

// API Helper - uses server URL from config
const skuApi = {
  getServerUrl() {
    return window.printStationConfig?.serverBaseUrl || window.APP_CONFIG?.serverUrl || 'https://store.swayzecustomvinyl.com';
  },
  getHeaders() {
    return {
      'Content-Type': 'application/json',
      'x-api-key': window.printStationConfig?.apiKey || window.APP_CONFIG?.internalKey || ''
    };
  },
  async get(path) {
    const response = await fetch(`${this.getServerUrl()}${path}`, { headers: this.getHeaders() });
    return response.json();
  },
  async post(path, data) {
    const response = await fetch(`${this.getServerUrl()}${path}`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(data)
    });
    return response.json();
  },
  async put(path, data) {
    const response = await fetch(`${this.getServerUrl()}${path}`, {
      method: 'PUT',
      headers: this.getHeaders(),
      body: JSON.stringify(data)
    });
    return response.json();
  },
  async delete(path) {
    const response = await fetch(`${this.getServerUrl()}${path}`, {
      method: 'DELETE',
      headers: this.getHeaders()
    });
    return response.json();
  }
};

const skuCatalogState = {
  designs: [],
  selectedDesign: null,
  variants: [],
  priceTable: null,
  initialized: false
};

// =============== INITIALIZATION ===============
async function initSkuCatalogView() {
  if (!skuCatalogState.initialized) {
    skuCatalogState.initialized = true;
    setupSkuCatalogEventListeners();
    await loadPriceTable();
  }
  await loadSkuDesigns();
}

function setupSkuCatalogEventListeners() {
  // Import from Studio3 button
  const importBtn = document.getElementById('skuImportStudio3Btn');
  if (importBtn) {
    importBtn.addEventListener('click', openStudio3ImportForSku);
  }

  // Create Design button
  const createBtn = document.getElementById('skuCreateDesignBtn');
  if (createBtn) {
    createBtn.addEventListener('click', showCreateDesignModal);
  }

  // Refresh button
  const refreshBtn = document.getElementById('skuRefreshBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', loadSkuDesigns);
  }

  // Add Variant button
  const addVariantBtn = document.getElementById('skuAddVariantBtn');
  if (addVariantBtn) {
    addVariantBtn.addEventListener('click', () => {
      document.getElementById('skuVariantColor').focus();
    });
  }

  // Generate All Sizes button
  const generateAllBtn = document.getElementById('skuGenerateAllBtn');
  if (generateAllBtn) {
    generateAllBtn.addEventListener('click', generateAllSizeVariants);
  }

  // Variant form
  const variantForm = document.getElementById('skuVariantForm');
  if (variantForm) {
    variantForm.addEventListener('submit', handleVariantFormSubmit);
  }

  // Size change - update price
  const sizeSelect = document.getElementById('skuVariantSize');
  if (sizeSelect) {
    sizeSelect.addEventListener('change', updateVariantPricePreview);
  }

  // Preview Labels button
  const previewLabelsBtn = document.getElementById('skuPreviewLabelsBtn');
  if (previewLabelsBtn) {
    previewLabelsBtn.addEventListener('click', previewSkuLabels);
  }

  // Print Labels button
  const printLabelsBtn = document.getElementById('skuPrintLabelsBtn');
  if (printLabelsBtn) {
    printLabelsBtn.addEventListener('click', printSkuLabels);
  }
}

// =============== DATA LOADING ===============
async function loadPriceTable() {
  try {
    const response = await skuApi.get('/api/sku/pricing');
    if (response.success) {
      skuCatalogState.priceTable = response.priceTable;
    }
  } catch (err) {
    console.error('[SKU Catalog] Failed to load price table:', err);
  }
}

async function loadSkuDesigns() {
  try {
    const designsList = document.getElementById('skuDesignsList');
    const countEl = document.getElementById('skuDesignCount');

    designsList.innerHTML = '<p class="placeholder">Loading...</p>';

    const response = await skuApi.get('/api/sku/designs');
    if (response.success) {
      skuCatalogState.designs = response.designs;
      countEl.textContent = `${response.designs.length} designs`;
      renderSkuDesignsList();
    } else {
      designsList.innerHTML = '<p class="placeholder">Failed to load designs</p>';
    }
  } catch (err) {
    console.error('[SKU Catalog] Failed to load designs:', err);
    document.getElementById('skuDesignsList').innerHTML = '<p class="placeholder">Error loading designs</p>';
  }
}

async function loadSkuVariants(designId) {
  try {
    const response = await skuApi.get(`/api/sku/designs/${designId}`);
    if (response.success) {
      skuCatalogState.selectedDesign = response.design;
      skuCatalogState.variants = response.variants;
      renderSkuVariants();
      updateDesignInfoPanel();
      enableVariantControls(true);
    }
  } catch (err) {
    console.error('[SKU Catalog] Failed to load variants:', err);
  }
}

// =============== RENDERING ===============
function renderSkuDesignsList() {
  const container = document.getElementById('skuDesignsList');
  const designs = skuCatalogState.designs;

  if (designs.length === 0) {
    container.innerHTML = '<p class="placeholder">No designs yet. Import from Studio3 or create one.</p>';
    return;
  }

  container.innerHTML = designs.map(design => `
    <div class="sku-design-item ${skuCatalogState.selectedDesign?.id === design.id ? 'selected' : ''}"
         data-design-id="${design.id}"
         onclick="selectSkuDesign('${design.id}')"
         style="display:flex;gap:10px;padding:10px;border-bottom:1px solid var(--border);cursor:pointer;align-items:center;">
      ${design.thumbnail
        ? `<img src="${design.thumbnail}" alt="${design.name}" style="width:50px;height:50px;object-fit:contain;background:#fff;border-radius:4px;">`
        : '<div style="width:50px;height:50px;background:#ddd;border-radius:4px;display:flex;align-items:center;justify-content:center;color:#888;">?</div>'
      }
      <div style="flex:1;">
        <div style="font-weight:600;">${escapeHtml(design.name)}</div>
        <div class="muted" style="font-size:0.85rem;">SKU: ${escapeHtml(design.slug)}</div>
        <div class="muted" style="font-size:0.85rem;">${design.variantCount || 0} variants</div>
      </div>
      <button class="secondary" style="padding:4px 8px;" onclick="event.stopPropagation();deleteSkuDesign('${design.id}')">×</button>
    </div>
  `).join('');
}

function renderSkuVariants() {
  const tbody = document.getElementById('skuVariantsBody');
  const variants = skuCatalogState.variants;

  if (variants.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="placeholder">No variants. Create one below.</td></tr>';
    document.getElementById('skuPreviewLabelsBtn').disabled = true;
    document.getElementById('skuPrintLabelsBtn').disabled = true;
    return;
  }

  tbody.innerHTML = variants.map(v => `
    <tr>
      <td><code>${escapeHtml(v.sku)}</code></td>
      <td>${v.sizeInches}"</td>
      <td>
        <span style="display:inline-flex;align-items:center;gap:4px;">
          <span style="width:14px;height:14px;background:${v.colorHex || '#ccc'};border-radius:50%;border:1px solid #999;"></span>
          ${escapeHtml(v.colorName)}
        </span>
      </td>
      <td>$${(v.priceCents / 100).toFixed(2)}</td>
      <td>
        <button class="secondary" style="padding:2px 6px;font-size:0.8rem;" onclick="showVariantQr('${v.id}', '${v.sku}')">QR</button>
      </td>
      <td>
        <button class="secondary" style="padding:2px 6px;font-size:0.8rem;" onclick="deleteSkuVariant('${v.id}')">×</button>
      </td>
    </tr>
  `).join('');

  document.getElementById('skuPreviewLabelsBtn').disabled = false;
  document.getElementById('skuPrintLabelsBtn').disabled = false;
}

function updateDesignInfoPanel() {
  const design = skuCatalogState.selectedDesign;
  const panel = document.getElementById('skuSelectedDesignInfo');

  if (!design) {
    panel.style.display = 'none';
    return;
  }

  panel.style.display = 'block';
  document.getElementById('skuSelectedDesignThumb').src = design.thumbnail || '';
  document.getElementById('skuSelectedDesignName').textContent = design.name;
  document.getElementById('skuSelectedDesignSlug').textContent = `SKU Prefix: ${design.slug}`;

  if (design.originalWidthMm && design.originalHeightMm) {
    const widthIn = (design.originalWidthMm / 25.4).toFixed(1);
    const heightIn = (design.originalHeightMm / 25.4).toFixed(1);
    document.getElementById('skuSelectedDesignSize').textContent = `Original: ${widthIn}" × ${heightIn}"`;
  } else {
    document.getElementById('skuSelectedDesignSize').textContent = '';
  }
}

function enableVariantControls(enabled) {
  document.getElementById('skuAddVariantBtn').disabled = !enabled;
  document.getElementById('skuGenerateAllBtn').disabled = !enabled;
  document.getElementById('skuVariantSubmitBtn').disabled = !enabled;
}

// =============== ACTIONS ===============
async function selectSkuDesign(designId) {
  // Update visual selection
  document.querySelectorAll('.sku-design-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.designId === designId);
  });

  await loadSkuVariants(designId);
  updateVariantPricePreview();
}

async function openStudio3ImportForSku() {
  try {
    // Get list of Studio3 catalog entries
    const response = await skuApi.get('/api/studio3/catalog');
    if (!response.success || response.entries.length === 0) {
      alert('No Studio3 files in catalog. Import .studio3 files in the Vinyl Cutter view first.');
      return;
    }

    // Create a simple selection modal
    const entries = response.entries;
    const selection = await showStudio3SelectModal(entries);

    if (selection) {
      await importStudio3AsSkuDesign(selection);
    }
  } catch (err) {
    console.error('[SKU Catalog] Studio3 import error:', err);
    alert('Failed to load Studio3 catalog: ' + err.message);
  }
}

async function showStudio3SelectModal(entries) {
  return new Promise(resolve => {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.style.cssText = 'display:flex;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);align-items:center;justify-content:center;z-index:10000;';

    modal.innerHTML = `
      <div style="background:#fff;padding:20px;border-radius:8px;max-width:600px;max-height:80vh;overflow-y:auto;">
        <h3 style="margin-top:0;">Select Studio3 Design</h3>
        <div id="studio3SelectList" style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:16px 0;">
          ${entries.map(e => `
            <div class="studio3-select-item" data-id="${e.id}" style="cursor:pointer;padding:8px;border:2px solid transparent;border-radius:4px;text-align:center;">
              ${e.thumbnail
                ? `<img src="${e.thumbnail}" style="width:80px;height:80px;object-fit:contain;background:#f0f0f0;border-radius:4px;">`
                : '<div style="width:80px;height:80px;background:#ddd;border-radius:4px;margin:0 auto;"></div>'
              }
              <div style="font-size:0.8rem;margin-top:4px;word-break:break-word;">${escapeHtml(e.filename.replace(/\.studio3$/i, ''))}</div>
            </div>
          `).join('')}
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button class="secondary" id="studio3SelectCancel">Cancel</button>
          <button class="primary" id="studio3SelectConfirm" disabled>Import Selected</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    let selectedEntry = null;

    modal.querySelectorAll('.studio3-select-item').forEach(item => {
      item.addEventListener('click', () => {
        modal.querySelectorAll('.studio3-select-item').forEach(i => i.style.borderColor = 'transparent');
        item.style.borderColor = '#007bff';
        selectedEntry = entries.find(e => e.id === item.dataset.id);
        document.getElementById('studio3SelectConfirm').disabled = false;
      });
    });

    document.getElementById('studio3SelectCancel').addEventListener('click', () => {
      modal.remove();
      resolve(null);
    });

    document.getElementById('studio3SelectConfirm').addEventListener('click', () => {
      modal.remove();
      resolve(selectedEntry);
    });
  });
}

async function importStudio3AsSkuDesign(entry) {
  try {
    const name = entry.filename.replace(/\.studio3$/i, '');

    // Get full entry data including paths
    const fullEntry = await skuApi.get(`/api/studio3/catalog/${entry.id}`);

    const designData = {
      name: name,
      studio3Id: entry.id,
      thumbnail: entry.thumbnail,
      cutPaths: fullEntry.entry?.paths || []
    };

    // Calculate dimensions from paths if available
    if (designData.cutPaths && designData.cutPaths.length > 0) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      designData.cutPaths.forEach(path => {
        path.forEach(pt => {
          minX = Math.min(minX, pt.x);
          minY = Math.min(minY, pt.y);
          maxX = Math.max(maxX, pt.x);
          maxY = Math.max(maxY, pt.y);
        });
      });
      // Silhouette uses mm internally
      designData.originalWidthMm = maxX - minX;
      designData.originalHeightMm = maxY - minY;
    }

    const response = await skuApi.post('/api/sku/designs', designData);
    if (response.success) {
      await loadSkuDesigns();
      await selectSkuDesign(response.design.id);
      document.getElementById('skuVariantStatus').textContent = `Design "${name}" imported successfully!`;
    } else {
      alert('Failed to import: ' + response.error);
    }
  } catch (err) {
    console.error('[SKU Catalog] Import error:', err);
    alert('Failed to import design: ' + err.message);
  }
}

async function showCreateDesignModal() {
  const name = prompt('Enter design name:');
  if (!name || !name.trim()) return;

  try {
    const response = await skuApi.post('/api/sku/designs', { name: name.trim() });
    if (response.success) {
      await loadSkuDesigns();
      await selectSkuDesign(response.design.id);
    } else {
      alert('Failed to create design: ' + response.error);
    }
  } catch (err) {
    alert('Error creating design: ' + err.message);
  }
}

async function deleteSkuDesign(designId) {
  if (!confirm('Delete this design and all its variants?')) return;

  try {
    const response = await skuApi.delete(`/api/sku/designs/${designId}`);
    if (response.success) {
      if (skuCatalogState.selectedDesign?.id === designId) {
        skuCatalogState.selectedDesign = null;
        skuCatalogState.variants = [];
        renderSkuVariants();
        updateDesignInfoPanel();
        enableVariantControls(false);
      }
      await loadSkuDesigns();
    }
  } catch (err) {
    alert('Error deleting design: ' + err.message);
  }
}

async function handleVariantFormSubmit(e) {
  e.preventDefault();

  if (!skuCatalogState.selectedDesign) {
    alert('Please select a design first');
    return;
  }

  const sizeInches = parseFloat(document.getElementById('skuVariantSize').value);
  const colorName = document.getElementById('skuVariantColor').value.trim();
  const colorHex = document.getElementById('skuVariantHex').value;

  if (!colorName) {
    alert('Please enter a color name');
    return;
  }

  try {
    const response = await skuApi.post('/api/sku/variants', {
      designId: skuCatalogState.selectedDesign.id,
      sizeInches,
      colorName,
      colorHex
    });

    if (response.success) {
      document.getElementById('skuVariantColor').value = '';
      document.getElementById('skuVariantStatus').textContent = `Created SKU: ${response.variant.sku}`;
      await loadSkuVariants(skuCatalogState.selectedDesign.id);
    } else {
      document.getElementById('skuVariantStatus').textContent = 'Error: ' + response.error;
    }
  } catch (err) {
    document.getElementById('skuVariantStatus').textContent = 'Error: ' + err.message;
  }
}

async function generateAllSizeVariants() {
  if (!skuCatalogState.selectedDesign) return;

  const colorName = document.getElementById('skuVariantColor').value.trim();
  const colorHex = document.getElementById('skuVariantHex').value;

  if (!colorName) {
    alert('Please enter a color name first');
    return;
  }

  const sizes = [2, 3, 4, 6, 8, 10, 12];
  let created = 0;

  for (const size of sizes) {
    try {
      const response = await skuApi.post('/api/sku/variants', {
        designId: skuCatalogState.selectedDesign.id,
        sizeInches: size,
        colorName,
        colorHex
      });
      if (response.success) created++;
    } catch (err) {
      // Skip duplicates
    }
  }

  document.getElementById('skuVariantColor').value = '';
  document.getElementById('skuVariantStatus').textContent = `Created ${created} variants for ${colorName}`;
  await loadSkuVariants(skuCatalogState.selectedDesign.id);
}

async function deleteSkuVariant(variantId) {
  if (!confirm('Delete this variant?')) return;

  try {
    await skuApi.delete(`/api/sku/variant/${variantId}`);
    await loadSkuVariants(skuCatalogState.selectedDesign.id);
  } catch (err) {
    alert('Error deleting variant: ' + err.message);
  }
}

function updateVariantPricePreview() {
  const sizeInches = parseFloat(document.getElementById('skuVariantSize').value);
  const priceTable = skuCatalogState.priceTable;

  if (priceTable && priceTable[sizeInches]) {
    const priceCents = priceTable[sizeInches][1]; // 1 color default
    document.getElementById('skuVariantPrice').value = `$${(priceCents / 100).toFixed(2)}`;
  }
}

// =============== QR CODE FUNCTIONS ===============
async function showVariantQr(variantId, sku) {
  const variant = skuCatalogState.variants.find(v => v.id === variantId);
  if (!variant) return;

  const qrUrl = `${window.printStationConfig?.serverBaseUrl || 'https://store.swayzecustomvinyl.com'}/api/sku/scan?sku=${encodeURIComponent(sku)}`;

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.style.cssText = 'display:flex;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);align-items:center;justify-content:center;z-index:10000;';

  modal.innerHTML = `
    <div style="background:#fff;padding:20px;border-radius:8px;text-align:center;">
      <h3 style="margin-top:0;">${escapeHtml(sku)}</h3>
      <div id="qrCodeContainer" style="margin:16px 0;"></div>
      <div class="muted" style="font-size:0.8rem;word-break:break-all;max-width:300px;">${escapeHtml(qrUrl)}</div>
      <div style="margin-top:16px;">
        <button class="secondary" onclick="this.closest('.modal').remove()">Close</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Generate QR code
  if (typeof QRCode !== 'undefined') {
    new QRCode(document.getElementById('qrCodeContainer'), {
      text: qrUrl,
      width: 200,
      height: 200,
      correctLevel: QRCode.CorrectLevel.M
    });
  } else {
    document.getElementById('qrCodeContainer').innerHTML = '<p class="muted">QR library not loaded</p>';
  }
}

async function previewSkuLabels() {
  const variants = skuCatalogState.variants;
  if (variants.length === 0) return;

  const preview = document.getElementById('skuLabelPreview');
  preview.style.display = 'block';
  preview.innerHTML = '<p>Generating preview...</p>';

  const labelSize = document.getElementById('skuLabelSize').value;
  const printAll = document.getElementById('skuPrintAllVariants').checked;
  const variantsToPrint = printAll ? variants : (skuCatalogState.selectedVariant ? [skuCatalogState.selectedVariant] : variants);

  const baseUrl = window.printStationConfig?.serverBaseUrl || 'https://store.swayzecustomvinyl.com';

  let html = '<div style="display:flex;flex-wrap:wrap;gap:16px;">';

  for (const v of variantsToPrint) {
    const qrUrl = `${baseUrl}/api/sku/scan?sku=${encodeURIComponent(v.sku)}`;
    const design = skuCatalogState.selectedDesign;

    html += `
      <div class="sku-label-preview" style="border:1px solid #000;padding:8px;width:${labelSize === '2x1' ? '180px' : '270px'};display:flex;gap:8px;align-items:center;">
        <div id="qr-${v.id}" style="width:${labelSize === '2x1' ? '60px' : '100px'};height:${labelSize === '2x1' ? '60px' : '100px'};"></div>
        <div style="flex:1;font-size:${labelSize === '2x1' ? '10px' : '12px'};">
          <div style="font-weight:bold;">${escapeHtml(design?.name || '')}</div>
          <div>${escapeHtml(v.colorName)} ${v.sizeInches}"</div>
          <div style="font-family:monospace;">${escapeHtml(v.sku)}</div>
          <div style="font-weight:bold;">$${(v.priceCents / 100).toFixed(2)}</div>
        </div>
      </div>
    `;
  }

  html += '</div>';
  preview.innerHTML = html;

  // Generate QR codes
  if (typeof QRCode !== 'undefined') {
    for (const v of variantsToPrint) {
      const qrUrl = `${baseUrl}/api/sku/scan?sku=${encodeURIComponent(v.sku)}`;
      const size = labelSize === '2x1' ? 60 : 100;
      new QRCode(document.getElementById(`qr-${v.id}`), {
        text: qrUrl,
        width: size,
        height: size,
        correctLevel: QRCode.CorrectLevel.M
      });
    }
  }
}

async function printSkuLabels() {
  // First generate preview
  await previewSkuLabels();

  // Open print dialog
  const preview = document.getElementById('skuLabelPreview');
  const printContent = preview.innerHTML;

  const printWindow = window.open('', '_blank');
  printWindow.document.write(`
    <html>
      <head>
        <title>SKU Labels</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 20px; }
          .sku-label-preview { page-break-inside: avoid; margin-bottom: 8px; }
        </style>
      </head>
      <body>
        ${printContent}
        <script>window.onload = function() { window.print(); }</script>
      </body>
    </html>
  `);
  printWindow.document.close();
}

// =============== UTILITY ===============
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
