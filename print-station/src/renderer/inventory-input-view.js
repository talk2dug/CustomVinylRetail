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
        placeholder.querySelector('span').textContent = `Preview error: ${error}`;
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

  function updateSubcategories(categoryName) {
    const sel = document.getElementById('invInputSubcategory');
    sel.innerHTML = '<option value="">None</option>';
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

  // ── SNAP ──────────────────────────────────────────────────────────────────
  async function handleSnap() {
    if (state.analyzing || !state.currentCameraId) return;

    state.analyzing = true;
    updateSnapButton();
    setStatus('Capturing...');
    showAnalyzing(true);

    try {
      // 1. Use the last preview frame (avoids opening a second ffmpeg RTSP connection)
      const base64 = state.lastPreviewFrame;
      if (!base64) throw new Error('No preview frame available — wait for camera to load');

      // Stop preview while analyzing
      await printStation.inventoryInput.stopPreview(state.currentCameraId);

      state.lastImageBase64 = base64;

      // Show captured image
      const img = document.getElementById('invInputPreviewImg');
      img.src = `data:image/jpeg;base64,${base64}`;
      img.style.display = 'block';

      // 2. Analyze with Gemini Vision
      setStatus('Analyzing with AI...');
      const analyzeResp = await printStation.inventoryInput.analyze({ imageBase64: base64, mimeType: 'image/jpeg' });
      if (!analyzeResp.ok) throw new Error(analyzeResp.error || 'Analysis failed');

      const analysis = analyzeResp.analysis;
      state.lastAnalysis = analysis;

      // 3. Lookup pricing
      const category = getSelectedCategory();
      const subcategory = getSelectedSubcategory();
      setStatus('Looking up pricing...');

      let pricingResp;
      try {
        pricingResp = await printStation.inventoryInput.pricing({
          category,
          subcategory,
          printSize: getSelectedSize(),
          size: String(analysis.longestDimensionInches || 0),
          colorCount: String(analysis.colorCount || 1)
        });
      } catch (e) {
        pricingResp = { ok: true, found: false };
      }

      // 4. Show results
      showResults(analysis, pricingResp, category, subcategory);

      // 5. Auto-accept?
      const autoAccept = document.getElementById('invInputAutoAccept').checked;
      if (autoAccept && pricingResp.found) {
        await saveItem(analysis, pricingResp.priceCents, category, subcategory);
        setStatus('Auto-saved! Ready for next.');
        hideResults();
        // Resume preview
        startPreview(state.currentCameraId);
      } else {
        setStatus('Review results and confirm.');
      }
    } catch (err) {
      console.error('[InvInput] Snap error:', err);
      setStatus(`Error: ${err.message}`);
    } finally {
      state.analyzing = false;
      showAnalyzing(false);
      updateSnapButton();
    }
  }

  // ── Results ───────────────────────────────────────────────────────────────
  function showResults(analysis, pricing, category, subcategory) {
    const panel = document.getElementById('invInputResultPanel');
    const body = document.getElementById('invInputResultBody');

    const priceStr = pricing.found
      ? `$${(pricing.priceCents / 100).toFixed(2)}`
      : '<span style="color:#c00;">No pricing set</span>';

    body.innerHTML = `
      <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:13px;">
        <strong>Measured:</strong> <span>${analysis.widthInches || '?'}" x ${analysis.heightInches || '?'}"</span>
        <strong>Size:</strong> <span><select id="invInputSizeSelect" style="padding:2px 4px;background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:4px;">
          <option value="5x7">5x7</option><option value="8x10">8x10</option><option value="11x14">11x14</option><option value="11x17">11x17</option>
        </select></span>
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

    // Auto-select closest print size in dropdown
    const sizeSel = document.getElementById('invInputSizeSelect');
    if (sizeSel && analysis.widthInches && analysis.heightInches) {
      const short = Math.min(analysis.widthInches, analysis.heightInches);
      const long = Math.max(analysis.widthInches, analysis.heightInches);
      const sizes = [
        { val: '5x7', s: 5, l: 7 }, { val: '8x10', s: 8, l: 10 },
        { val: '11x14', s: 11, l: 14 }, { val: '11x17', s: 11, l: 17 }
      ];
      let best = '11x14', bestDist = Infinity;
      for (const sz of sizes) {
        const d = Math.abs(short - sz.s) + Math.abs(long - sz.l);
        if (d < bestDist) { bestDist = d; best = sz.val; }
      }
      sizeSel.value = best;
    }
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
      await saveItem(state.lastAnalysis, pricingResp.priceCents, category, subcategory);
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

    // Save as qr_product via server API
    const resp = await window.printStation.inventoryInput.saveProduct({
      title,
      description: analysis.description || '',
      priceCents,
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
      el.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <strong style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px;">${escapeHtml(item.title)}</strong>
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
    const sel = document.getElementById('invInputSizeSelect');
    return sel ? sel.value : '';
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
