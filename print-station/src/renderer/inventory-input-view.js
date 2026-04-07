/**
 * Inventory Input View — AI-powered rapid product entry
 * Workflow: select camera → select category → SNAP → AI analyzes → confirm → save
 */
/* global printStation */

(function () {
  'use strict';

  const state = {
    cameras: [],
    currentCameraId: null,
    previewUnsub: null,
    categories: [],
    lastAnalysis: null,
    lastImageBase64: null,
    recentItems: [],
    analyzing: false,
    initialized: false,
    // Analysis queue — snap saves immediately, AI runs in background
    analysisQueue: [],
    analysisRunning: false,
  };

  // ── Init ──────────────────────────────────────────────────────────────────
  window.initInventoryInputView = async function () {
    if (state.initialized) return;
    state.initialized = true;

    await loadCameras();
    await loadCategories();
    bindEvents();
  };

  // ── Cleanup (called when leaving view) ─────────────────────────────────
  window.cleanupInventoryInputView = function () {
    stopPreview();
  };

  // ── Camera ────────────────────────────────────────────────────────────────
  async function loadCameras() {
    try {
      state.cameras = await printStation.footage.listCameras();
    } catch (e) {
      console.error('[InvInput] Failed to load cameras:', e);
      state.cameras = [];
    }

    const sel = document.getElementById('invInputCameraSelect');
    sel.innerHTML = '<option value="">Select camera...</option>';
    for (const cam of state.cameras) {
      const opt = document.createElement('option');
      opt.value = cam.id;
      opt.textContent = cam.name || cam.id;
      sel.appendChild(opt);
    }
  }

  function startPreview(cameraId) {
    stopPreview();
    state.currentCameraId = cameraId;

    const img = document.getElementById('invInputPreviewImg');
    const placeholder = document.getElementById('invInputPreviewPlaceholder');
    placeholder.style.display = 'flex';
    img.style.display = 'none';

    state.previewUnsub = printStation.inventoryInput.onPreviewFrame(({ cameraId: cid, frame, error }) => {
      if (cid !== state.currentCameraId) return;
      if (frame) {
        state.lastPreviewFrame = frame;
        img.src = `data:image/jpeg;base64,${frame}`;
        img.style.display = 'block';
        placeholder.style.display = 'none';
      } else if (error) {
        // Only show error if we never got a frame (still on placeholder)
        if (img.style.display === 'none') {
          placeholder.querySelector('span').textContent = `Connecting...`;
        }
        // Otherwise silently retry — RTSP timeouts are transient
      }
    });

    printStation.inventoryInput.startPreview(cameraId);
    updateSnapButton();
  }

  function stopPreview() {
    if (state.currentCameraId) {
      printStation.inventoryInput.stopPreview(state.currentCameraId);
    }
    if (state.previewUnsub) {
      state.previewUnsub();
      state.previewUnsub = null;
    }
    state.currentCameraId = null;
  }

  // ── Categories ────────────────────────────────────────────────────────────
  async function loadCategories() {
    try {
      const resp = await printStation.inventoryInput.categories();
      state.categories = resp.categories || [];
    } catch (e) {
      console.error('[InvInput] Failed to load categories:', e);
      state.categories = [{ name: 'Decals', subcategories: [], hasPricing: true, builtIn: true }];
    }

    const sel = document.getElementById('invInputCategory');
    sel.innerHTML = '<option value="">Select category...</option>';
    for (const cat of state.categories) {
      const opt = document.createElement('option');
      opt.value = cat.name;
      opt.textContent = cat.name + (cat.hasPricing ? '' : ' (no pricing)');
      sel.appendChild(opt);
    }
  }

  // Category-specific size options
  const CATEGORY_SIZES = {
    'Metal Prints': ['5x7', '8x10', '11x14', '11x17'],
    'Decals': ['2', '3', '4', '6', '8', '10', '12'],
    'Bumper Stickers': ['3', '4', '6', '8', '10', '12'],
    'Heat Transfer Decals': ['2', '3', '4', '6', '8', '10', '12'],
  };

  // Categories where subcategory represents a single longest-dimension in inches
  const SINGLE_DIM_CATEGORIES = ['Decals', 'Bumper Stickers', 'Heat Transfer Decals'];

  // Categories with a price surcharge (in cents)
  const CATEGORY_SURCHARGE = {
    'Heat Transfer Decals': 100, // +$1.00
  };

  function updateSubcategories(categoryName) {
    const sel = document.getElementById('invInputSubcategory');
    sel.innerHTML = '<option value="">Select size...</option>';

    // Use predefined sizes if available
    const sizes = CATEGORY_SIZES[categoryName];
    if (sizes) {
      const isSingleDim = SINGLE_DIM_CATEGORIES.includes(categoryName);
      for (const sz of sizes) {
        const opt = document.createElement('option');
        opt.value = sz;
        opt.textContent = isSingleDim ? `${sz}"` : sz;
        sel.appendChild(opt);
      }
      return;
    }

    // Fallback: use server-provided subcategories
    const cat = state.categories.find(c => c.name === categoryName);
    if (cat && cat.subcategories) {
      for (const sub of cat.subcategories) {
        const opt = document.createElement('option');
        opt.value = sub.name;
        opt.textContent = sub.name;
        sel.appendChild(opt);
      }
    }
  }

  // ── Events ────────────────────────────────────────────────────────────────
  function bindEvents() {
    document.getElementById('invInputCameraSelect').addEventListener('change', (e) => {
      if (e.target.value) {
        startPreview(e.target.value);
      } else {
        stopPreview();
        updateSnapButton();
      }
    });

    document.getElementById('invInputCategory').addEventListener('change', (e) => {
      updateSubcategories(e.target.value);
      document.getElementById('invInputNewCategory').value = '';
      updateSnapButton();
    });

    document.getElementById('invInputNewCategory').addEventListener('input', (e) => {
      if (e.target.value.trim()) {
        document.getElementById('invInputCategory').value = '';
        document.getElementById('invInputSubcategory').innerHTML = '<option value="">None</option>';
      }
    });

    document.getElementById('invInputSnapBtn').addEventListener('click', handleSnap);
    document.getElementById('invInputConfirmBtn').addEventListener('click', handleConfirm);
    document.getElementById('invInputRetryBtn').addEventListener('click', handleRetry);
  }

  function updateSnapButton() {
    const btn = document.getElementById('invInputSnapBtn');
    const hasCamera = !!state.currentCameraId;
    const hasCategory = !!(document.getElementById('invInputCategory').value || document.getElementById('invInputNewCategory').value.trim());
    btn.disabled = !hasCamera || !hasCategory || state.analyzing;
  }

  // ── SNAP (queue-based — saves immediately, AI analyzes in background) ────
  async function handleSnap() {
    if (!state.currentCameraId) return;

    const base64 = state.lastPreviewFrame;
    if (!base64) { setStatus('No preview frame — wait for camera'); return; }

    const category = getSelectedCategory();
    const subcategory = getSelectedSubcategory();
    if (!category) { setStatus('Select a category first'); return; }

    // 1. Get price immediately (no AI needed)
    let pricingResp;
    try {
      pricingResp = await printStation.inventoryInput.pricing({
        category, subcategory,
        printSize: getSelectedSize(),
        size: '0',
        colorCount: '1'
      });
    } catch (e) {
      pricingResp = { ok: true, found: false };
    }

    if (!pricingResp.found) {
      // No pricing — fall back to old flow (need manual price entry)
      await handleSnapLegacy(base64, category, subcategory);
      return;
    }

    // 2. Save immediately with known price + placeholder description
    const surcharge = CATEGORY_SURCHARGE[category] || 0;
    const priceCents = pricingResp.priceCents + surcharge;
    const quantity = parseInt(document.getElementById('invInputQuantity').value, 10) || 1;

    try {
      const resp = await window.printStation.inventoryInput.saveProduct({
        title: `${category} ${subcategory || ''} item`.trim(),
        description: '',
        priceCents,
        photoBase64: base64,
        category,
        size: getSelectedSize(),
        color: '',
        quantity
      });

      // Add to recent items immediately
      state.recentItems.unshift({
        title: `${category} ${subcategory || ''}`.trim(),
        category, subcategory, priceCents,
        size: getSelectedSize(),
        colors: 1, quantity,
        timestamp: new Date().toLocaleTimeString(),
        productId: resp?.product?.id || resp?.id || null,
        aiPending: true
      });
      if (state.recentItems.length > 50) state.recentItems.pop();
      renderRecentItems();

      // 3. Queue AI analysis in background
      const productId = resp?.product?.id || resp?.id || null;
      if (productId) {
        state.analysisQueue.push({ productId, imageBase64: base64 });
        updateQueueCount();
        processAnalysisQueue(); // fire-and-forget
      }

      setStatus(`Saved! $${(priceCents / 100).toFixed(2)} — snap next`);
    } catch (err) {
      console.error('[InvInput] Save error:', err);
      setStatus(`Save error: ${err.message}`);
    }
  }

  // Legacy flow for when pricing isn't known (manual price entry needed)
  async function handleSnapLegacy(base64, category, subcategory) {
    state.analyzing = true;
    updateSnapButton();
    setStatus('Analyzing with AI...');
    showAnalyzing(true);

    try {
      state.snapshotBase64 = base64;
      await printStation.inventoryInput.stopPreview(state.currentCameraId);
      state.lastImageBase64 = base64;

      const img = document.getElementById('invInputPreviewImg');
      img.src = `data:image/jpeg;base64,${base64}`;
      img.style.display = 'block';

      const analyzeResp = await printStation.inventoryInput.analyze({ imageBase64: base64, mimeType: 'image/jpeg' });
      if (!analyzeResp.ok) throw new Error(analyzeResp.error || 'Analysis failed');

      const analysis = analyzeResp.analysis;
      state.lastAnalysis = analysis;

      const pricingResp = { ok: true, found: false };
      showResults(analysis, pricingResp, category, subcategory);
      setStatus('Set pricing and confirm.');
    } catch (err) {
      console.error('[InvInput] Snap error:', err);
      setStatus(`Error: ${err.message}`);
    } finally {
      state.analyzing = false;
      showAnalyzing(false);
      updateSnapButton();
    }
  }

  // ── Background Analysis Queue ───────────────────────────────────────────
  async function processAnalysisQueue() {
    if (state.analysisRunning) return; // already processing
    state.analysisRunning = true;

    while (state.analysisQueue.length > 0) {
      const job = state.analysisQueue[0];
      try {
        console.log(`[InvInput] Analyzing ${job.productId} in background (${state.analysisQueue.length} in queue)...`);
        const analyzeResp = await printStation.inventoryInput.analyze({
          imageBase64: job.imageBase64, mimeType: 'image/jpeg'
        });

        if (analyzeResp.ok && analyzeResp.analysis) {
          // Update the product with AI description
          try {
            await window.printStation.inventoryInput.updateProduct(job.productId, {
              title: analyzeResp.analysis.description || undefined,
              ai_description: analyzeResp.analysis.description || '',
              color_count: analyzeResp.analysis.colorCount || 1,
              longest_dimension: analyzeResp.analysis.longestDimensionInches || 0
            });
          } catch (e) {
            console.warn('[InvInput] Failed to update product with AI data:', e.message);
          }

          // Update recent item display
          const recent = state.recentItems.find(r => r.productId === job.productId);
          if (recent) {
            recent.title = analyzeResp.analysis.description || recent.title;
            recent.colors = analyzeResp.analysis.colorCount || 1;
            recent.aiPending = false;
            renderRecentItems();
          }
        }
      } catch (err) {
        console.warn(`[InvInput] Background analysis failed for ${job.productId}:`, err.message);
        // Mark as done anyway — don't block the queue
        const recent = state.recentItems.find(r => r.productId === job.productId);
        if (recent) { recent.aiPending = false; renderRecentItems(); }
      }

      state.analysisQueue.shift();
      updateQueueCount();
    }

    state.analysisRunning = false;
    updateQueueCount();
  }

  function updateQueueCount() {
    const el = document.getElementById('invInputQueueCount');
    if (!el) return;
    const n = state.analysisQueue.length;
    if (n > 0) {
      el.textContent = `AI queue: ${n}`;
      el.style.display = '';
    } else {
      el.textContent = '';
      el.style.display = 'none';
    }
  }

  // ── Results ───────────────────────────────────────────────────────────────
  function showResults(analysis, pricing, category, subcategory) {
    const panel = document.getElementById('invInputResultPanel');
    const body = document.getElementById('invInputResultBody');

    const surcharge = CATEGORY_SURCHARGE[category] || 0;
    const totalPriceCents = pricing.found ? pricing.priceCents + surcharge : 0;
    const priceStr = pricing.found
      ? `$${(totalPriceCents / 100).toFixed(2)}${surcharge ? ' <span style="color:var(--muted);font-size:11px;">(+$' + (surcharge/100).toFixed(2) + ' heat transfer)</span>' : ''}`
      : '<span style="color:#c00;">No pricing set</span>';

    body.innerHTML = `
      <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:13px;">
        <strong>Size:</strong> <span>${subcategory || category}</span>
        <strong>Colors:</strong> <span>${analysis.colorCount || '?'} — ${(analysis.colors || []).join(', ') || 'N/A'}</span>
        <strong>Type:</strong> <span>${analysis.itemType || 'unknown'}</span>
        <strong>Description:</strong> <span>${analysis.description || 'N/A'}</span>
        <strong>Category:</strong> <span>${category}${subcategory ? ' / ' + subcategory : ''}</span>
        <strong>Price:</strong> <span>${priceStr} (${pricing.source || 'none'})</span>
        <strong>Confidence:</strong> <span>${((analysis.confidence || 0) * 100).toFixed(0)}%</span>
      </div>
    `;

    // If no pricing, show add-pricing form
    if (!pricing.found) {
      body.innerHTML += `
        <div style="margin-top:10px;padding:8px;background:rgba(255,243,205,0.1);border:1px solid var(--border);border-radius:4px;color:var(--text);">
          <strong style="font-size:12px;">Set price for "${category}":</strong>
          <div style="display:flex;gap:6px;margin-top:4px;align-items:center;">
            <span>$</span>
            <input type="number" id="invInputNewPrice" step="0.01" min="0" style="width:80px;padding:4px;" placeholder="0.00">
            <button id="invInputSavePriceBtn" class="secondary" style="font-size:12px;padding:4px 8px;">Save</button>
          </div>
        </div>
      `;
      setTimeout(() => {
        const saveBtn = document.getElementById('invInputSavePriceBtn');
        if (saveBtn) {
          saveBtn.addEventListener('click', async () => {
            const val = parseFloat(document.getElementById('invInputNewPrice').value);
            if (isNaN(val) || val <= 0) return;
            try {
              await printStation.inventoryInput.saveCategory({
                category,
                subcategory: subcategory || '',
                basePriceCents: Math.round(val * 100)
              });
              // Reload categories and re-show
              await loadCategories();
              const newPricing = await printStation.inventoryInput.pricing({
                category, subcategory,
                printSize: getSelectedSize(),
                size: String(analysis.longestDimensionInches || 0),
                colorCount: String(analysis.colorCount || 1)
              });
              showResults(analysis, newPricing, category, subcategory);
              setStatus('Price saved!');
            } catch (e) {
              setStatus(`Error saving price: ${e.message}`);
            }
          });
        }
      }, 0);
    }

    panel.style.display = 'block';
    document.getElementById('invInputConfirmBtn').disabled = !pricing.found;

  }

  function hideResults() {
    document.getElementById('invInputResultPanel').style.display = 'none';
    state.lastAnalysis = null;
  }

  // ── Confirm / Save ────────────────────────────────────────────────────────
  async function handleConfirm() {
    if (!state.lastAnalysis) return;
    const category = getSelectedCategory();
    const subcategory = getSelectedSubcategory();

    try {
      const pricingResp = await printStation.inventoryInput.pricing({
        category, subcategory,
        printSize: getSelectedSize(),
        size: String(state.lastAnalysis.longestDimensionInches || 0),
        colorCount: String(state.lastAnalysis.colorCount || 1)
      });
      if (!pricingResp.found) {
        setStatus('Set pricing first!');
        return;
      }
      const surcharge = CATEGORY_SURCHARGE[category] || 0;
      await saveItem(state.lastAnalysis, pricingResp.priceCents + surcharge, category, subcategory);
      setStatus('Saved! Ready for next.');
      hideResults();
      // Resume preview
      if (state.currentCameraId) startPreview(state.currentCameraId);
    } catch (e) {
      setStatus(`Save error: ${e.message}`);
    }
  }

  function handleRetry() {
    hideResults();
    setStatus('Ready — click SNAP');
    if (state.currentCameraId) startPreview(state.currentCameraId);
  }

  async function saveItem(analysis, priceCents, category, subcategory) {
    const quantity = parseInt(document.getElementById('invInputQuantity').value, 10) || 1;
    const title = analysis.description || `${category} item`;
    const size = getSelectedSize();

    // Save as qr_product via server API (include captured photo)
    const photo = state.snapshotBase64 || state.lastPreviewFrame || state.lastImageBase64 || null;
    console.log('[InvInput] saveItem photoBase64:', photo ? photo.length + ' chars' : 'NONE',
      'snapshotBase64:', !!state.snapshotBase64, 'lastPreviewFrame:', !!state.lastPreviewFrame, 'lastImageBase64:', !!state.lastImageBase64);
    const resp = await window.printStation.inventoryInput.saveProduct({
      title,
      description: analysis.description || '',
      priceCents,
      photoBase64: photo,
      category,
      size,
      color: (analysis.colors || []).join(', '),
      quantity
    });

    // Add to recent items
    state.recentItems.unshift({
      title,
      category,
      subcategory,
      priceCents,
      size,
      colors: analysis.colorCount,
      quantity,
      timestamp: new Date().toLocaleTimeString()
    });
    if (state.recentItems.length > 20) state.recentItems.pop();
    renderRecentItems();

    return resp;
  }

  // ── Recent Items ──────────────────────────────────────────────────────────
  function renderRecentItems() {
    const container = document.getElementById('invInputRecentItems');
    container.innerHTML = '';

    for (const item of state.recentItems) {
      const el = document.createElement('div');
      el.style.cssText = 'padding:8px;background:var(--card);border:1px solid var(--border);border-radius:6px;font-size:12px;color:var(--text);';
      const aiTag = item.aiPending ? '<span style="color:#FF9800;font-size:10px;margin-left:4px;">analyzing...</span>' : '';
      el.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <strong style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px;">${escapeHtml(item.title)}${aiTag}</strong>
          <span style="color:#2196F3;font-weight:600;">$${(item.priceCents / 100).toFixed(2)}</span>
        </div>
        <div style="color:#888;margin-top:2px;">${escapeHtml(item.category)}${item.subcategory ? ' / ' + escapeHtml(item.subcategory) : ''} &middot; ${item.size} &middot; ${item.colors} color${item.colors !== 1 ? 's' : ''} &middot; qty ${item.quantity} &middot; ${item.timestamp}</div>
      `;
      container.appendChild(el);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function getSelectedCategory() {
    return document.getElementById('invInputNewCategory').value.trim() || document.getElementById('invInputCategory').value;
  }

  function getSelectedSubcategory() {
    return document.getElementById('invInputNewSubcategory').value.trim() || document.getElementById('invInputSubcategory').value;
  }

  function getSelectedSize() {
    return getSelectedSubcategory() || getSelectedCategory();
  }

  function setStatus(msg) {
    document.getElementById('invInputStatus').textContent = msg;
  }

  function showAnalyzing(show) {
    const el = document.getElementById('invInputAnalyzing');
    el.style.display = show ? 'flex' : 'none';
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }
})();
