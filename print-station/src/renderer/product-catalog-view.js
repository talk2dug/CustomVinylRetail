// =============== Product Catalog View ===============

const productApi = {
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
      method: 'POST', headers: this.getHeaders(), body: JSON.stringify(data)
    });
    return response.json();
  },
  async put(path, data) {
    const response = await fetch(`${this.getServerUrl()}${path}`, {
      method: 'PUT', headers: this.getHeaders(), body: JSON.stringify(data)
    });
    return response.json();
  },
  async del(path) {
    const response = await fetch(`${this.getServerUrl()}${path}`, {
      method: 'DELETE', headers: this.getHeaders()
    });
    return response.json();
  },
  async uploadPhoto(productId, file) {
    const form = new FormData();
    form.append('photo', file);
    const response = await fetch(`${this.getServerUrl()}/api/products/${productId}/photo`, {
      method: 'POST',
      headers: { 'x-api-key': this.getHeaders()['x-api-key'] },
      body: form
    });
    return response.json();
  }
};

const productCatalogState = {
  products: [],
  categories: [],
  selectedProduct: null,
  selectedForLabels: new Set(),
  initialized: false
};

// =============== INITIALIZATION ===============
async function initProductCatalogView() {
  if (!productCatalogState.initialized) {
    productCatalogState.initialized = true;
    setupProductCatalogListeners();
  }
  await loadProductList();
  await loadProductCategories();
}

function setupProductCatalogListeners() {
  // Add product
  document.getElementById('productAddBtn').addEventListener('click', createNewProduct);
  document.getElementById('productRefreshBtn').addEventListener('click', async () => {
    await loadProductList();
    await loadProductCategories();
  });

  // Search
  let searchTimer;
  document.getElementById('productSearchInput').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadProductList, 300);
  });

  // Category filter
  document.getElementById('productCategoryFilter').addEventListener('change', loadProductList);

  // Save
  document.getElementById('productSaveBtn').addEventListener('click', saveProduct);

  // Delete
  document.getElementById('productDeleteBtn').addEventListener('click', deleteProduct);

  // Photo change
  document.getElementById('productChangePhotoBtn').addEventListener('click', () => {
    document.getElementById('productPhotoInput').click();
  });
  document.getElementById('productDetailPhoto').addEventListener('click', () => {
    document.getElementById('productPhotoInput').click();
  });
  document.getElementById('productPhotoInput').addEventListener('change', handlePhotoUpload);

  // QR buttons
  document.getElementById('productCopyUrlBtn').addEventListener('click', copyProductUrl);
  document.getElementById('productDownloadQrBtn').addEventListener('click', downloadProductQr);
  document.getElementById('productPrintQrBtn').addEventListener('click', printProductQrLabel);

  // Shopify sync
  document.getElementById('productPushShopifyBtn').addEventListener('click', pushProductToShopify);

  // Label printing
  document.getElementById('productPrintLabelsBtn').addEventListener('click', generateProductLabels);
  document.getElementById('productSelectAllCheckbox').addEventListener('change', (e) => {
    const checked = e.target.checked;
    productCatalogState.selectedForLabels.clear();
    if (checked) {
      productCatalogState.products.forEach(p => productCatalogState.selectedForLabels.add(p.id));
    }
    renderProductList();
    updateLabelSelectionUI();
  });
}

// =============== LOAD DATA ===============
async function loadProductList() {
  const search = document.getElementById('productSearchInput').value.trim();
  const category = document.getElementById('productCategoryFilter').value;

  let qs = '?activeOnly=false';
  if (search) qs += `&search=${encodeURIComponent(search)}`;
  if (category) qs += `&category=${encodeURIComponent(category)}`;

  try {
    const data = await productApi.get(`/api/products${qs}`);
    productCatalogState.products = data.products || [];
    renderProductList();
    document.getElementById('productStatusText').textContent =
      `${productCatalogState.products.length} product${productCatalogState.products.length !== 1 ? 's' : ''}`;
  } catch (err) {
    console.error('[Products] Load error:', err);
    document.getElementById('productStatusText').textContent = 'Failed to load';
  }
}

async function loadProductCategories() {
  try {
    const data = await productApi.get('/api/products/categories');
    productCatalogState.categories = data.categories || [];
    const sel = document.getElementById('productCategoryFilter');
    const current = sel.value;
    sel.innerHTML = '<option value="">All Categories</option>';
    const dl = document.getElementById('productCategorySuggestions');
    dl.innerHTML = '';
    productCatalogState.categories.forEach(c => {
      sel.innerHTML += `<option value="${escHtml(c)}">${escHtml(c)}</option>`;
      dl.innerHTML += `<option value="${escHtml(c)}">`;
    });
    sel.value = current;
  } catch (_) {}
}

// =============== RENDER ===============
function renderProductList() {
  const container = document.getElementById('productListContainer');
  const products = productCatalogState.products;

  if (products.length === 0) {
    container.innerHTML = '<div style="text-align:center;padding:40px;color:#666;">No products found</div>';
    return;
  }

  const baseUrl = productApi.getServerUrl();
  const selectedLabels = productCatalogState.selectedForLabels;
  container.innerHTML = products.map(p => `
    <div class="product-list-item ${productCatalogState.selectedProduct?.id === p.id ? 'selected' : ''}"
         data-id="${p.id}" style="display:flex;align-items:center;gap:10px;padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--border);transition:background 0.15s;">
      <input type="checkbox" class="product-label-checkbox" data-id="${p.id}" ${selectedLabels.has(p.id) ? 'checked' : ''}
             style="flex-shrink:0;cursor:pointer;width:16px;height:16px;" title="Select for label printing">
      ${p.photoUrl
        ? `<img src="${baseUrl}${p.photoUrl}" style="width:40px;height:40px;border-radius:4px;object-fit:cover;flex-shrink:0;">`
        : `<div style="width:40px;height:40px;border-radius:4px;background:#222;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:#555;font-size:1.2rem;">&#128247;</div>`}
      <div style="flex:1;min-width:0;">
        <div style="font-weight:600;font-size:0.9rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(p.title)}</div>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
          <span style="color:#22c55e;font-size:0.85rem;">$${(p.priceCents / 100).toFixed(2)}</span>
          ${p.quantity > 1 ? `<span style="font-size:0.7rem;color:#aaa;">x${p.quantity}</span>` : ''}
          ${p.isHeatTransfer ? `<span style="font-size:0.6rem;padding:1px 4px;background:#b45309;border-radius:2px;color:#fff;">HT</span>` : ''}
          ${p.category ? `<span style="font-size:0.75rem;padding:1px 6px;background:#333;border-radius:3px;color:#aaa;">${escHtml(p.category)}</span>` : ''}
        </div>
        ${p.size || p.color ? `<div style="font-size:0.7rem;color:#888;">${[p.size, p.color].filter(Boolean).join(' / ')}</div>` : ''}
      </div>
      ${!p.active ? '<span style="font-size:0.7rem;color:#ef4444;">inactive</span>' : ''}
    </div>
  `).join('');

  // Checkbox click (stop propagation so it doesn't trigger selectProduct)
  container.querySelectorAll('.product-label-checkbox').forEach(cb => {
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', (e) => {
      const id = e.target.dataset.id;
      if (e.target.checked) {
        productCatalogState.selectedForLabels.add(id);
      } else {
        productCatalogState.selectedForLabels.delete(id);
      }
      updateLabelSelectionUI();
    });
  });

  // Hover + click
  container.querySelectorAll('.product-list-item').forEach(el => {
    el.addEventListener('mouseenter', () => el.style.background = 'rgba(59,130,246,0.1)');
    el.addEventListener('mouseleave', () => {
      el.style.background = productCatalogState.selectedProduct?.id === el.dataset.id ? 'rgba(59,130,246,0.15)' : '';
    });
    el.addEventListener('click', () => selectProduct(el.dataset.id));
  });

  // Highlight selected
  if (productCatalogState.selectedProduct) {
    const sel = container.querySelector(`[data-id="${productCatalogState.selectedProduct.id}"]`);
    if (sel) sel.style.background = 'rgba(59,130,246,0.15)';
  }

  // Update select-all checkbox state
  const allCb = document.getElementById('productSelectAllCheckbox');
  if (allCb) {
    allCb.checked = products.length > 0 && selectedLabels.size === products.length;
    allCb.indeterminate = selectedLabels.size > 0 && selectedLabels.size < products.length;
  }
}

function selectProduct(id) {
  const product = productCatalogState.products.find(p => p.id === id);
  if (!product) return;
  productCatalogState.selectedProduct = product;

  document.getElementById('productDetailPlaceholder').style.display = 'none';
  document.getElementById('productDetailContent').style.display = 'block';

  const baseUrl = productApi.getServerUrl();

  // Photo
  const photoEl = document.getElementById('productDetailPhoto');
  if (product.photoUrl) {
    photoEl.innerHTML = `<img src="${baseUrl}${product.photoUrl}" style="width:100%;height:100%;object-fit:cover;">`;
  } else {
    photoEl.innerHTML = '<span style="color:#555;font-size:3rem;">&#128247;</span>';
  }

  // Fields
  document.getElementById('productEditTitle').value = product.title;
  document.getElementById('productEditDescription').value = product.description || '';
  document.getElementById('productEditPrice').value = (product.priceCents / 100).toFixed(2);
  document.getElementById('productEditCategory').value = product.category || '';
  document.getElementById('productEditSize').value = product.size || '';
  document.getElementById('productEditColor').value = product.color || '';
  document.getElementById('productEditDecalText').value = product.decalText || '';
  document.getElementById('productEditHeatTransfer').checked = product.isHeatTransfer || false;
  document.getElementById('productEditQuantity').value = product.quantity || 1;

  // QR Code
  const qrContainer = document.getElementById('productQrCode');
  qrContainer.innerHTML = '';
  const productUrl = `${baseUrl}/web/product.html?id=${product.id}`;
  document.getElementById('productQrUrl').textContent = productUrl;

  if (typeof QRCode !== 'undefined') {
    new QRCode(qrContainer, {
      text: productUrl, width: 150, height: 150,
      correctLevel: QRCode.CorrectLevel.M
    });
  }

  // Shopify status
  const shopifyStatus = document.getElementById('productShopifyStatus');
  const shopifyLink = document.getElementById('productShopifyLink');
  const pushBtn = document.getElementById('productPushShopifyBtn');
  if (product.shopifyProductId) {
    shopifyStatus.textContent = `Synced (ID: ${product.shopifyProductId})`;
    shopifyStatus.style.color = '#22c55e';
    pushBtn.textContent = 'Update on Shopify';
    shopifyLink.style.display = 'inline-block';
    shopifyLink.href = `https://admin.shopify.com/store/0q8gcb-qc/products/${product.shopifyProductId}`;
  } else {
    shopifyStatus.textContent = 'Not yet synced to Shopify';
    shopifyStatus.style.color = '#888';
    pushBtn.textContent = 'Push to Shopify';
    shopifyLink.style.display = 'none';
  }

  renderProductList(); // Update selection highlight
}

// =============== CRUD ===============
async function createNewProduct() {
  const title = prompt('Product title:');
  if (!title || !title.trim()) return;

  try {
    const data = await productApi.post('/api/products', { title: title.trim(), priceCents: 0 });
    if (data.success && data.product) {
      await loadProductList();
      await loadProductCategories();
      selectProduct(data.product.id);
    }
  } catch (err) {
    alert('Failed to create product: ' + err.message);
  }
}

async function saveProduct() {
  const product = productCatalogState.selectedProduct;
  if (!product) return;

  const title = document.getElementById('productEditTitle').value.trim();
  if (!title) { alert('Title is required'); return; }

  const priceCents = Math.round(parseFloat(document.getElementById('productEditPrice').value || '0') * 100);
  const description = document.getElementById('productEditDescription').value.trim();
  const category = document.getElementById('productEditCategory').value.trim();
  const size = document.getElementById('productEditSize').value.trim();
  const color = document.getElementById('productEditColor').value.trim();
  const decalText = document.getElementById('productEditDecalText').value.trim();
  const isHeatTransfer = document.getElementById('productEditHeatTransfer').checked;
  const quantity = parseInt(document.getElementById('productEditQuantity').value, 10) || 1;

  try {
    const data = await productApi.put(`/api/products/${product.id}`, {
      title, description, priceCents, category, size, color, decalText, isHeatTransfer, quantity
    });
    if (data.success) {
      document.getElementById('productStatusText').textContent = 'Saved';
      setTimeout(() => loadProductList(), 500);
      await loadProductCategories();
      // Update local state
      Object.assign(productCatalogState.selectedProduct, data.product);
    }
  } catch (err) {
    alert('Save failed: ' + err.message);
  }
}

async function deleteProduct() {
  const product = productCatalogState.selectedProduct;
  if (!product) return;
  if (!confirm(`Delete "${product.title}"?`)) return;

  try {
    await productApi.del(`/api/products/${product.id}`);
    productCatalogState.selectedProduct = null;
    document.getElementById('productDetailPlaceholder').style.display = 'block';
    document.getElementById('productDetailContent').style.display = 'none';
    await loadProductList();
    await loadProductCategories();
  } catch (err) {
    alert('Delete failed: ' + err.message);
  }
}

// =============== PHOTO ===============
async function handlePhotoUpload(e) {
  const file = e.target.files[0];
  if (!file || !productCatalogState.selectedProduct) return;

  document.getElementById('productChangePhotoBtn').textContent = 'Uploading...';
  document.getElementById('productChangePhotoBtn').disabled = true;

  try {
    const data = await productApi.uploadPhoto(productCatalogState.selectedProduct.id, file);
    if (data.success && data.product) {
      productCatalogState.selectedProduct.photoUrl = data.product.photoUrl;
      const baseUrl = productApi.getServerUrl();
      document.getElementById('productDetailPhoto').innerHTML =
        `<img src="${baseUrl}${data.product.photoUrl}" style="width:100%;height:100%;object-fit:cover;">`;
      await loadProductList();
    }
  } catch (err) {
    alert('Upload failed: ' + err.message);
  }

  document.getElementById('productChangePhotoBtn').textContent = 'Change Photo';
  document.getElementById('productChangePhotoBtn').disabled = false;
  e.target.value = '';
}

// =============== QR CODE ===============
function copyProductUrl() {
  const url = document.getElementById('productQrUrl').textContent;
  if (url) {
    navigator.clipboard.writeText(url);
    document.getElementById('productCopyUrlBtn').textContent = 'Copied!';
    setTimeout(() => document.getElementById('productCopyUrlBtn').textContent = 'Copy URL', 2000);
  }
}

function downloadProductQr() {
  const canvas = document.getElementById('productQrCode').querySelector('canvas');
  if (!canvas) return;
  const a = document.createElement('a');
  const product = productCatalogState.selectedProduct;
  a.download = `qr-${product ? product.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase() : 'product'}.png`;
  a.href = canvas.toDataURL('image/png');
  a.click();
}

function printProductQrLabel() {
  const product = productCatalogState.selectedProduct;
  if (!product) return;
  const canvas = document.getElementById('productQrCode').querySelector('canvas');
  if (!canvas) return;

  const qrDataUrl = canvas.toDataURL('image/png');
  const price = '$' + (product.priceCents / 100).toFixed(2);

  const printWindow = window.open('', '_blank', 'width=400,height=300');
  printWindow.document.write(`<!DOCTYPE html><html><head><title>QR Label</title>
    <style>
      @page { size: 3in 2in; margin: 0; }
      body { margin: 0; padding: 8px; font-family: Arial, sans-serif; display: flex; align-items: center; gap: 10px; }
      .qr { width: 120px; height: 120px; }
      .info { flex: 1; }
      .title { font-weight: bold; font-size: 12px; margin-bottom: 4px; }
      .price { font-size: 16px; font-weight: bold; margin-bottom: 4px; }
      .category { font-size: 10px; color: #666; }
    </style></head><body>
    <img class="qr" src="${qrDataUrl}">
    <div class="info">
      <div class="title">${escHtml(product.title)}</div>
      <div class="price">${price}</div>
      ${product.category ? `<div class="category">${escHtml(product.category)}</div>` : ''}
    </div>
  </body></html>`);
  printWindow.document.close();
  setTimeout(() => { printWindow.print(); printWindow.close(); }, 500);
}

// =============== LABEL PRINTING ===============
function updateLabelSelectionUI() {
  const count = productCatalogState.selectedForLabels.size;
  const btn = document.getElementById('productPrintLabelsBtn');
  const countEl = document.getElementById('productSelectedCount');

  if (count > 0) {
    // Calculate total labels (sum of quantities)
    let totalLabels = 0;
    for (const id of productCatalogState.selectedForLabels) {
      const p = productCatalogState.products.find(pr => pr.id === id);
      if (p) totalLabels += Math.max(1, p.quantity || 1);
    }
    btn.textContent = `Print Labels (${count} product${count !== 1 ? 's' : ''}, ${totalLabels} label${totalLabels !== 1 ? 's' : ''})`;
    btn.style.display = 'inline-block';
    countEl.textContent = `${count} selected`;
  } else {
    btn.style.display = 'none';
    countEl.textContent = '';
  }
}

async function generateProductLabels() {
  const selectedIds = Array.from(productCatalogState.selectedForLabels);
  if (selectedIds.length === 0) return;

  const btn = document.getElementById('productPrintLabelsBtn');
  const origText = btn.textContent;
  btn.textContent = 'Generating...';
  btn.disabled = true;

  try {
    const data = await productApi.post('/api/products/generate-labels', {
      productIds: selectedIds
    });

    if (data.success) {
      // Clear selection
      productCatalogState.selectedForLabels.clear();
      renderProductList();
      updateLabelSelectionUI();

      // Show result and switch to sticker sheets view if available
      const sheetCount = data.totalSheets || 0;
      const stickerCount = data.totalStickers || 0;
      document.getElementById('productStatusText').textContent =
        `Generated ${sheetCount} sheet${sheetCount !== 1 ? 's' : ''} with ${stickerCount} label${stickerCount !== 1 ? 's' : ''}`;

      // Open the sticker sheets browser to show the generated batch
      if (typeof openStickerSheetsBrowser === 'function') {
        setTimeout(() => openStickerSheetsBrowser(), 500);
      }
    } else {
      alert('Label generation failed: ' + (data.error || 'Unknown error'));
    }
  } catch (err) {
    alert('Label generation failed: ' + err.message);
  }

  btn.textContent = origText;
  btn.disabled = false;
}

// =============== SHOPIFY SYNC ===============
async function pushProductToShopify() {
  const product = productCatalogState.selectedProduct;
  if (!product) return;

  const btn = document.getElementById('productPushShopifyBtn');
  const statusEl = document.getElementById('productShopifyStatus');
  const origText = btn.textContent;
  btn.textContent = 'Syncing...';
  btn.disabled = true;
  statusEl.textContent = 'Syncing to Shopify...';
  statusEl.style.color = '#f59e0b';

  try {
    const data = await productApi.post('/api/products/shopify/export', { productId: product.id });

    if (data.success && data.results?.[0]?.success) {
      const result = data.results[0];
      product.shopifyProductId = result.shopifyProductId;
      product.shopifyHandle = result.handle;

      statusEl.textContent = `Synced (ID: ${result.shopifyProductId})`;
      statusEl.style.color = '#22c55e';
      btn.textContent = 'Update on Shopify';

      const shopifyLink = document.getElementById('productShopifyLink');
      shopifyLink.style.display = 'inline-block';
      shopifyLink.href = `https://admin.shopify.com/store/0q8gcb-qc/products/${result.shopifyProductId}`;

      document.getElementById('productStatusText').textContent =
        result.updated ? 'Updated on Shopify' : 'Pushed to Shopify';
    } else {
      const errMsg = data.results?.[0]?.error || data.error || 'Unknown error';
      statusEl.textContent = `Failed: ${errMsg}`;
      statusEl.style.color = '#ef4444';
    }
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
    statusEl.style.color = '#ef4444';
  }

  btn.textContent = origText === 'Syncing...' ? (product.shopifyProductId ? 'Update on Shopify' : 'Push to Shopify') : origText;
  btn.disabled = false;
}

// =============== UTIL ===============
function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}
