'use strict';
// ============================================================================
// APPAREL MOCKUP VIEW
// Unified mockup generator for catalog graphics on human models.
// Used standalone (Create > Apparel Mockups) and in campaign mode.
// ============================================================================

(function () {

  let amInitialized = false;

  const amState = {
    // Catalog
    catalogData: null,
    catalogCategories: [],
    // Selected graphic
    selectedGraphic: null,     // { id, name, image, categoryName }
    // Preprocessing
    vectorize: false,
    removeBackground: false,
    processedGraphicPath: null,
    preprocessing: false,
    // Human models
    humanModels: [],
    humanModelCategories: [],
    modelsLoaded: false,
    frontModelId: '',
    backModelId: '',
    // Placement settings
    garmentType: 't-shirt',
    clothingColor: '#ffffff',
    zone: 'front-chest',
    size: 'auto',
    // Adjustment (post-generation)
    adjustX: 0,
    adjustY: 0,
    adjustScale: 100,
    // Result
    currentResult: null,       // { front: { imagePath }, back: { imagePath }, combined: { imagePath } }
    generating: false,
    // Campaign mode
    campaignMode: false,
    campaignItems: [],
    campaignItemIndex: -1,
    campaignTemplate: null,    // saved settings from first item
    campaignResults: {},       // { index: { front, back, combined } }
    campaignOnComplete: null,  // callback(index, data)
  };

  // ---- Cached DOM references ------------------------------------------------
  const el = {};
  function cacheElements() {
    el.categoryFilter = document.getElementById('amCategoryFilter');
    el.searchInput = document.getElementById('amSearchInput');
    el.catalogGrid = document.getElementById('amCatalogGrid');
    el.selectedGraphic = document.getElementById('amSelectedGraphic');
    el.selectedGraphicImg = document.getElementById('amSelectedGraphicImg');
    el.selectedGraphicName = document.getElementById('amSelectedGraphicName');
    el.selectedGraphicCategory = document.getElementById('amSelectedGraphicCategory');
    el.clearGraphic = document.getElementById('amClearGraphic');
    el.vectorizeCheckbox = document.getElementById('amVectorizeCheckbox');
    el.removeBgCheckbox = document.getElementById('amRemoveBgCheckbox');
    el.preprocessStatus = document.getElementById('amPreprocessStatus');
    el.preprocessPreview = document.getElementById('amPreprocessPreview');
    el.preprocessBefore = document.getElementById('amPreprocessBefore');
    el.preprocessAfter = document.getElementById('amPreprocessAfter');
    el.modelGenderFilter = document.getElementById('amModelGenderFilter');
    el.modelEthnicityFilter = document.getElementById('amModelEthnicityFilter');
    el.modelPoseFilter = document.getElementById('amModelPoseFilter');
    el.frontModelGrid = document.getElementById('amFrontModelGrid');
    el.backModelGrid = document.getElementById('amBackModelGrid');
    el.frontModelPreview = document.getElementById('amFrontModelPreview');
    el.frontModelPreviewImg = document.getElementById('amFrontModelPreviewImg');
    el.frontModelPreviewLabel = document.getElementById('amFrontModelPreviewLabel');
    el.backModelPreview = document.getElementById('amBackModelPreview');
    el.backModelPreviewImg = document.getElementById('amBackModelPreviewImg');
    el.backModelPreviewLabel = document.getElementById('amBackModelPreviewLabel');
    el.frontModelClear = document.getElementById('amFrontModelClear');
    el.backModelClear = document.getElementById('amBackModelClear');
    el.garmentType = document.getElementById('amGarmentType');
    el.zone = document.getElementById('amZone');
    el.size = document.getElementById('amSize');
    el.clothingColor = document.getElementById('amClothingColor');
    el.clothingColorLabel = document.getElementById('amClothingColorLabel');
    el.colorPresets = document.getElementById('amColorPresets');
    el.generateBtn = document.getElementById('amGenerateBtn');
    el.previewContainer = document.getElementById('amPreviewContainer');
    el.previewFront = document.getElementById('amPreviewFront');
    el.previewBack = document.getElementById('amPreviewBack');
    el.adjustControls = document.getElementById('amAdjustControls');
    el.scaleSlider = document.getElementById('amScaleSlider');
    el.scaleLabel = document.getElementById('amScaleLabel');
    el.quickAdjustBtn = document.getElementById('amQuickAdjustBtn');
    el.reblendBtn = document.getElementById('amReblendBtn');
    el.saveBtn = document.getElementById('amSaveBtn');
    el.progress = document.getElementById('amProgress');
    el.progressText = document.getElementById('amProgressText');
    // Campaign
    el.campaignQueue = document.getElementById('amCampaignQueue');
    el.campaignItems = document.getElementById('amCampaignItems');
    el.campaignProgress = document.getElementById('amCampaignProgress');
    el.campaignGenerateAll = document.getElementById('amCampaignGenerateAll');
    el.campaignSendAll = document.getElementById('amCampaignSendAll');
  }

  // ---- Helpers --------------------------------------------------------------
  function getServerBase() {
    // Access state from index.js via printStation or directly
    try {
      const configStr = localStorage.getItem('printStationConfig');
      if (configStr) {
        const config = JSON.parse(configStr);
        if (config.serverBaseUrl) return config.serverBaseUrl.replace(/\/$/, '');
      }
    } catch (_) {}
    return 'https://store.swayzecustomvinyl.com';
  }

  function resolveUrl(pathValue) {
    if (!pathValue) return '';
    if (pathValue.startsWith('http') || pathValue.startsWith('data:')) return pathValue;
    const base = getServerBase();
    return `${base}${pathValue.startsWith('/') ? '' : '/'}${pathValue}`;
  }

  function esc(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function showStatus(text, type) {
    if (el.preprocessStatus) {
      el.preprocessStatus.textContent = text;
      el.preprocessStatus.style.display = text ? '' : 'none';
      el.preprocessStatus.className = `status-bar ${type || 'muted'}`;
    }
  }

  function showProgress(text) {
    if (el.progress) el.progress.style.display = text ? 'flex' : 'none';
    if (el.progressText) el.progressText.textContent = text || '';
    if (el.generateBtn) el.generateBtn.disabled = !!text;
  }

  // ---- Catalog Browser ------------------------------------------------------
  async function loadCatalog() {
    try {
      const catalog = await printStation.fetchCatalog({ catalogType: 'apparel' });
      amState.catalogData = catalog;
      amState.catalogCategories = Array.isArray(catalog?.categories) ? catalog.categories : [];
      populateCategoryFilter();
    } catch (e) {
      console.error('[ApparelMockup] Failed to load catalog:', e);
      if (el.catalogGrid) el.catalogGrid.innerHTML = '<p class="hint" style="font-size:11px;">Failed to load catalog</p>';
    }
  }

  function populateCategoryFilter() {
    if (!el.categoryFilter) return;
    el.categoryFilter.innerHTML = '<option value="">All Categories</option>' +
      amState.catalogCategories.map(c =>
        `<option value="${esc(c.slug)}">${esc(c.name)} (${(c.designs || []).length})</option>`
      ).join('');
  }

  function renderCatalogGrid() {
    if (!el.catalogGrid) return;
    const categorySlug = el.categoryFilter?.value || '';
    const search = (el.searchInput?.value || '').toLowerCase().trim();

    let designs = amState.catalogCategories.flatMap(c =>
      (c.designs || []).map(d => ({ ...d, categoryName: c.name, categorySlug: c.slug }))
    );

    if (categorySlug) {
      designs = designs.filter(d => d.categorySlug === categorySlug);
    }
    if (search) {
      designs = designs.filter(d =>
        (d.name || '').toLowerCase().includes(search) ||
        (d.categoryName || '').toLowerCase().includes(search)
      );
    }

    if (!designs.length) {
      el.catalogGrid.innerHTML = '<p class="hint" style="font-size:11px;text-align:center;padding:12px;grid-column:1/-1;">No designs found</p>';
      return;
    }

    // Limit to 60 for performance
    const limited = designs.slice(0, 60);
    el.catalogGrid.innerHTML = limited.map(d => {
      const imgUrl = resolveUrl(d.image);
      const selected = amState.selectedGraphic?.id === d.id ? ' selected' : '';
      return `<div class="apparel-mockup-catalog-item${selected}" data-design-id="${esc(d.id)}" title="${esc(d.name)}">
        <img src="${esc(imgUrl)}" alt="${esc(d.name)}" loading="lazy" />
        <div class="catalog-item-name">${esc(d.name)}</div>
      </div>`;
    }).join('');

    // Click handlers
    el.catalogGrid.querySelectorAll('.apparel-mockup-catalog-item').forEach(item => {
      item.addEventListener('click', () => {
        const designId = item.dataset.designId;
        const design = designs.find(d => String(d.id) === String(designId));
        if (design) selectGraphic(design);
      });
    });
  }

  function selectGraphic(design) {
    amState.selectedGraphic = design;
    amState.processedGraphicPath = null; // Reset preprocessing
    if (el.selectedGraphic) el.selectedGraphic.style.display = '';
    if (el.selectedGraphicImg) el.selectedGraphicImg.src = resolveUrl(design.image);
    if (el.selectedGraphicName) el.selectedGraphicName.textContent = design.name || 'Untitled';
    if (el.selectedGraphicCategory) el.selectedGraphicCategory.textContent = design.categoryName || '';
    // Reset preprocess preview
    if (el.preprocessPreview) el.preprocessPreview.style.display = 'none';
    showStatus('', '');
    // Highlight in grid
    el.catalogGrid?.querySelectorAll('.apparel-mockup-catalog-item').forEach(item => {
      item.classList.toggle('selected', item.dataset.designId === String(design.id));
    });
  }

  function clearGraphic() {
    amState.selectedGraphic = null;
    amState.processedGraphicPath = null;
    if (el.selectedGraphic) el.selectedGraphic.style.display = 'none';
    if (el.preprocessPreview) el.preprocessPreview.style.display = 'none';
    showStatus('', '');
    el.catalogGrid?.querySelectorAll('.apparel-mockup-catalog-item').forEach(item => {
      item.classList.remove('selected');
    });
  }

  // ---- Preprocessing (Vectorize / BG Remove) --------------------------------
  async function preprocessGraphic() {
    if (!amState.selectedGraphic) return null;
    const doVectorize = el.vectorizeCheckbox?.checked;
    const doRemoveBg = el.removeBgCheckbox?.checked;

    if (!doVectorize && !doRemoveBg) {
      amState.processedGraphicPath = null;
      return null;
    }

    const serverBase = getServerBase();
    let currentPath = amState.selectedGraphic.image;
    amState.preprocessing = true;

    try {
      // Step 1: Vectorize
      if (doVectorize) {
        showStatus('Vectorizing graphic...', 'muted');
        const resp = await fetch(`${serverBase}/api/ai-images/vectorize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imagePath: currentPath, style: 'clean', background: 'transparent' })
        });
        const data = await resp.json();
        if (data.success && data.images?.length > 0) {
          currentPath = data.images[0].localPath?.replace(/.*[/\\]web[/\\]/, '/') || currentPath;
        } else {
          showStatus('Vectorize failed: ' + (data.error || 'unknown'), 'warning');
          return null;
        }
      }

      // Step 2: Remove background
      if (doRemoveBg) {
        showStatus('Removing background...', 'muted');
        const resp = await fetch(`${serverBase}/api/ai-images/remove-background`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imagePath: currentPath })
        });
        const data = await resp.json();
        if (data.success && data.image) {
          currentPath = data.image.webPath || currentPath;
        } else {
          showStatus('Background removal failed: ' + (data.error || 'unknown'), 'warning');
          return null;
        }
      }

      amState.processedGraphicPath = currentPath;
      showStatus('Preprocessing complete', 'muted');

      // Show before/after
      if (el.preprocessPreview) {
        el.preprocessPreview.style.display = '';
        if (el.preprocessBefore) el.preprocessBefore.src = resolveUrl(amState.selectedGraphic.image);
        if (el.preprocessAfter) el.preprocessAfter.src = resolveUrl(currentPath);
      }

      return currentPath;
    } catch (e) {
      showStatus('Preprocessing error: ' + e.message, 'warning');
      return null;
    } finally {
      amState.preprocessing = false;
    }
  }

  // ---- Human Model Loading --------------------------------------------------
  async function loadHumanModels() {
    if (amState.modelsLoaded && amState.humanModels.length > 0) return;
    try {
      const result = await printStation.humanModels.list({ activeOnly: true, limit: 500 });
      amState.humanModels = result?.models || [];
      amState.modelsLoaded = true;

      populateModelFilters();
      renderModelGrids();
    } catch (e) {
      console.error('[ApparelMockup] Failed to load human models:', e);
      amState.humanModels = [];
    }
  }

  function populateModelFilters() {
    // Gather distinct values
    const ethnicities = new Set();
    const poses = new Set();
    amState.humanModels.forEach(m => {
      if (m.ethnicity) ethnicities.add(m.ethnicity);
      if (m.pose_type || m.poseType) poses.add(m.pose_type || m.poseType);
    });

    if (el.modelEthnicityFilter) {
      el.modelEthnicityFilter.innerHTML = '<option value="">Ethnicity</option>' +
        [...ethnicities].sort().map(e => `<option value="${esc(e)}">${esc(e)}</option>`).join('');
    }
    if (el.modelPoseFilter) {
      el.modelPoseFilter.innerHTML = '<option value="">Pose</option>' +
        [...poses].sort().map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
    }
  }

  function getFilteredModels() {
    const gender = el.modelGenderFilter?.value || '';
    const ethnicity = el.modelEthnicityFilter?.value || '';
    const pose = el.modelPoseFilter?.value || '';
    return amState.humanModels.filter(m => {
      if (gender && m.gender !== gender) return false;
      if (ethnicity && m.ethnicity !== ethnicity) return false;
      if (pose && (m.pose_type || m.poseType) !== pose) return false;
      return true;
    });
  }

  function getModelThumbUrl(model) {
    return model.thumbnailPath || model.thumbnail_path ||
           model.optimizedPath || model.optimized_path ||
           model.filePath || model.file_path || '';
  }

  function renderModelGrids() {
    const models = getFilteredModels();
    const frontModels = models.filter(m =>
      !m.facing || m.facing === 'front' || m.facing === 'three-quarter-left' || m.facing === 'three-quarter-right'
    );
    const backModels = models.filter(m => m.facing === 'back');

    renderModelGrid(el.frontModelGrid, frontModels, 'front');
    renderModelGrid(el.backModelGrid, backModels, 'back');
  }

  function renderModelGrid(container, models, type) {
    if (!container) return;
    if (models.length === 0) {
      container.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:8px;text-align:center;">No models match filters</div>';
      return;
    }
    container.innerHTML = models.map(m => {
      const thumbUrl = resolveUrl(getModelThumbUrl(m));
      const selectedId = type === 'front' ? amState.frontModelId : amState.backModelId;
      const isSelected = String(m.id) === String(selectedId);
      return `<div class="am-model-thumb${isSelected ? ' selected' : ''}" data-model-id="${esc(m.id)}" data-type="${type}" title="${esc(m.gender || '')} ${esc(m.ethnicity || '')} ${esc(m.pose_type || m.poseType || '')}">
        <img src="${esc(thumbUrl)}" alt="" loading="lazy" />
      </div>`;
    }).join('');

    // Attach click handlers
    container.querySelectorAll('.am-model-thumb').forEach(thumb => {
      thumb.addEventListener('click', () => selectModel(thumb.dataset.type, thumb.dataset.modelId));
    });
  }

  function selectModel(type, modelId) {
    const stateKey = type === 'front' ? 'frontModelId' : 'backModelId';
    amState[stateKey] = modelId;

    const model = amState.humanModels.find(m => String(m.id) === String(modelId));
    const previewEl = type === 'front' ? el.frontModelPreview : el.backModelPreview;
    const imgEl = type === 'front' ? el.frontModelPreviewImg : el.backModelPreviewImg;
    const labelEl = type === 'front' ? el.frontModelPreviewLabel : el.backModelPreviewLabel;
    const gridEl = type === 'front' ? el.frontModelGrid : el.backModelGrid;

    if (model && previewEl) {
      imgEl.src = resolveUrl(getModelThumbUrl(model));
      const parts = [model.gender, model.ethnicity, model.pose_type || model.poseType].filter(Boolean);
      labelEl.textContent = parts.length ? parts.join(' / ') : model.title || model.id;
      previewEl.hidden = false;
    }

    // Update selected state in grid
    if (gridEl) {
      gridEl.querySelectorAll('.am-model-thumb').forEach(t => {
        t.classList.toggle('selected', t.dataset.modelId === String(modelId));
      });
    }
  }

  function clearModel(type) {
    const stateKey = type === 'front' ? 'frontModelId' : 'backModelId';
    amState[stateKey] = '';
    const previewEl = type === 'front' ? el.frontModelPreview : el.backModelPreview;
    const gridEl = type === 'front' ? el.frontModelGrid : el.backModelGrid;
    if (previewEl) previewEl.hidden = true;
    if (gridEl) gridEl.querySelectorAll('.am-model-thumb.selected').forEach(t => t.classList.remove('selected'));
  }

  // ---- Clothing Color -------------------------------------------------------
  function setClothingColor(color) {
    amState.clothingColor = color;
    if (el.clothingColor) el.clothingColor.value = color;
    if (el.clothingColorLabel) el.clothingColorLabel.textContent = color;
    el.colorPresets?.querySelectorAll('.am-color-preset').forEach(btn => {
      btn.style.border = btn.dataset.color === color ? '2px solid #3b82f6' : '1px solid var(--border)';
    });
  }

  // ---- Generate Mockup ------------------------------------------------------
  async function generateMockup() {
    const serverBase = getServerBase();
    const frontModelId = amState.frontModelId || '';
    const backModelId = amState.backModelId || '';

    if (!frontModelId && !backModelId) {
      alert('Please select at least one model (front or back).');
      return;
    }
    if (!amState.selectedGraphic) {
      alert('Please select a graphic from the catalog.');
      return;
    }

    amState.generating = true;
    showProgress('Preparing graphic...');

    try {
      // Preprocess if needed
      const needsPreprocess = (el.vectorizeCheckbox?.checked || el.removeBgCheckbox?.checked) && !amState.processedGraphicPath;
      if (needsPreprocess) {
        const result = await preprocessGraphic();
        if (!result && (el.vectorizeCheckbox?.checked || el.removeBgCheckbox?.checked)) {
          showProgress('');
          return;
        }
      }

      const graphicPath = amState.processedGraphicPath || amState.selectedGraphic.image;
      const zone = el.zone?.value || 'front-chest';
      const size = el.size?.value || 'auto';
      const garmentType = el.garmentType?.value || 't-shirt';
      const clothingColor = amState.clothingColor;

      // Build placements
      const frontPlacements = [];
      const backPlacements = [];

      if (frontModelId) {
        frontPlacements.push({
          graphicPath,
          zone: zone === 'back' ? 'front-chest' : zone,
          size,
          adjustX: amState.adjustX,
          adjustY: amState.adjustY,
          adjustScale: amState.adjustScale
        });
      }
      if (backModelId) {
        backPlacements.push({
          graphicPath,
          zone: 'back',
          size,
          adjustX: amState.adjustX,
          adjustY: amState.adjustY,
          adjustScale: amState.adjustScale
        });
      }

      showProgress('Generating mockup with AI...');

      const resp = await fetch(`${serverBase}/api/ai-images/apparel-mockup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelFrontId: frontModelId || undefined,
          modelBackId: backModelId || undefined,
          clothingColor,
          placements: frontPlacements,
          backPlacements,
          garmentType,
          generateSideBySide: !!(frontModelId && backModelId)
        })
      });

      const data = await resp.json();
      if (!data.success) {
        alert('Mockup generation failed: ' + (data.error || 'Unknown error'));
        return;
      }

      amState.currentResult = data;
      renderPreview(data);

      // Show adjust controls
      if (el.adjustControls) el.adjustControls.style.display = '';

      // Campaign mode: save result and update queue
      if (amState.campaignMode && amState.campaignItemIndex >= 0) {
        saveCampaignResult(amState.campaignItemIndex, data);
      }

    } catch (e) {
      alert('Error: ' + e.message);
    } finally {
      amState.generating = false;
      showProgress('');
    }
  }

  function renderPreview(data) {
    const serverBase = getServerBase();

    if (data.front && el.previewFront) {
      el.previewFront.innerHTML = `
        <div class="apparel-mockup-preview-label">Front</div>
        <img src="${serverBase}${data.front.imagePath}" alt="Front mockup" />
      `;
    }
    if (data.back && el.previewBack) {
      el.previewBack.innerHTML = `
        <div class="apparel-mockup-preview-label">Back</div>
        <img src="${serverBase}${data.back.imagePath}" alt="Back mockup" />
      `;
    } else if (!data.back && el.previewBack) {
      el.previewBack.innerHTML = `
        <div class="apparel-mockup-preview-label">Back</div>
        <div class="apparel-mockup-preview-placeholder">No back model selected</div>
      `;
    }
  }

  // ---- Adjustment Controls --------------------------------------------------
  function adjustDirection(dir) {
    const step = 5;
    switch (dir) {
      case 'left': amState.adjustX -= step; break;
      case 'right': amState.adjustX += step; break;
      case 'up': amState.adjustY -= step; break;
      case 'down': amState.adjustY += step; break;
      case 'bigger': amState.adjustScale = Math.min(200, amState.adjustScale + 10); break;
      case 'smaller': amState.adjustScale = Math.max(50, amState.adjustScale - 10); break;
    }
    if (el.scaleSlider) el.scaleSlider.value = amState.adjustScale;
    if (el.scaleLabel) el.scaleLabel.textContent = amState.adjustScale + '%';
  }

  async function quickAdjust() {
    if (!amState.currentResult) return;
    const serverBase = getServerBase();
    const sourceImage = amState.currentResult.front?.imagePath || amState.currentResult.back?.imagePath;
    if (!sourceImage) return;

    showProgress('Adjusting...');
    try {
      const resp = await fetch(`${serverBase}/api/ai-images/apparel-mockup/adjust`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceImage,
          adjustX: amState.adjustX,
          adjustY: amState.adjustY,
          adjustScale: amState.adjustScale
        })
      });
      const data = await resp.json();
      if (data.success) {
        // Update preview with adjusted image
        if (amState.currentResult.front) {
          amState.currentResult.front.imagePath = data.imagePath;
        } else if (amState.currentResult.back) {
          amState.currentResult.back.imagePath = data.imagePath;
        }
        renderPreview(amState.currentResult);
      }
    } catch (e) {
      console.error('[ApparelMockup] Adjust failed:', e);
    } finally {
      showProgress('');
    }
  }

  async function reblendWithAI() {
    // Re-generate with current adjust values baked into the AI prompt
    showProgress('Re-blending with AI (this takes a moment)...');
    await generateMockup();
    // Reset adjustments after successful re-blend
    amState.adjustX = 0;
    amState.adjustY = 0;
    amState.adjustScale = 100;
    if (el.scaleSlider) el.scaleSlider.value = 100;
    if (el.scaleLabel) el.scaleLabel.textContent = '100%';
  }

  // ---- Campaign Mode --------------------------------------------------------
  function enterCampaignMode(items, startIndex, onComplete) {
    amState.campaignMode = true;
    amState.campaignItems = items || [];
    amState.campaignItemIndex = startIndex || 0;
    amState.campaignOnComplete = onComplete || null;
    amState.campaignResults = {};

    if (el.campaignQueue) el.campaignQueue.style.display = '';
    renderCampaignQueue();
    loadCampaignItem(amState.campaignItemIndex);
  }

  function exitCampaignMode() {
    amState.campaignMode = false;
    amState.campaignItems = [];
    amState.campaignItemIndex = -1;
    amState.campaignTemplate = null;
    amState.campaignResults = {};
    if (el.campaignQueue) el.campaignQueue.style.display = 'none';
  }

  function renderCampaignQueue() {
    if (!el.campaignItems) return;
    const items = amState.campaignItems;
    const serverBase = getServerBase();

    if (el.campaignProgress) {
      const done = Object.keys(amState.campaignResults).length;
      el.campaignProgress.textContent = `${done}/${items.length} complete`;
    }

    el.campaignItems.innerHTML = items.map((item, i) => {
      const imgUrl = item.image ? resolveUrl(item.image) : '';
      const isActive = i === amState.campaignItemIndex ? ' active' : '';
      const isCompleted = amState.campaignResults[i] ? ' completed' : '';
      return `<div class="apparel-mockup-campaign-item${isActive}${isCompleted}" data-index="${i}">
        ${imgUrl ? `<img src="${esc(imgUrl)}" alt="${esc(item.name || '')}" />` : '<div style="aspect-ratio:1;background:var(--bg-primary);"></div>'}
        <div class="item-name">${esc(item.name || 'Item ' + (i + 1))}</div>
      </div>`;
    }).join('');

    // Click to switch items
    el.campaignItems.querySelectorAll('.apparel-mockup-campaign-item').forEach(itemEl => {
      itemEl.addEventListener('click', () => {
        const idx = parseInt(itemEl.dataset.index, 10);
        amState.campaignItemIndex = idx;
        loadCampaignItem(idx);
        renderCampaignQueue();
      });
    });
  }

  function loadCampaignItem(index) {
    const item = amState.campaignItems[index];
    if (!item) return;

    // Select this item's graphic
    if (item.image) {
      selectGraphic({
        id: item.id || `campaign-${index}`,
        name: item.name || 'Campaign Item',
        image: item.image,
        categoryName: item.categoryName || ''
      });
    }

    // If we have a saved template from a previous item, apply settings
    if (amState.campaignTemplate) {
      const t = amState.campaignTemplate;
      if (t.frontModelId) selectModel('front', t.frontModelId);
      if (t.backModelId) selectModel('back', t.backModelId);
      if (t.garmentType && el.garmentType) el.garmentType.value = t.garmentType;
      if (t.zone && el.zone) el.zone.value = t.zone;
      if (t.size && el.size) el.size.value = t.size;
      if (t.clothingColor) setClothingColor(t.clothingColor);
      if (t.vectorize !== undefined && el.vectorizeCheckbox) el.vectorizeCheckbox.checked = t.vectorize;
      if (t.removeBackground !== undefined && el.removeBgCheckbox) el.removeBgCheckbox.checked = t.removeBackground;
    }

    // If we already have a result for this item, show it
    if (amState.campaignResults[index]) {
      amState.currentResult = amState.campaignResults[index];
      renderPreview(amState.currentResult);
      if (el.adjustControls) el.adjustControls.style.display = '';
    } else {
      // Clear preview
      resetPreview();
    }
  }

  function saveCampaignResult(index, data) {
    amState.campaignResults[index] = data;

    // Save template from first successful generation
    if (!amState.campaignTemplate) {
      amState.campaignTemplate = {
        frontModelId: amState.frontModelId || '',
        backModelId: amState.backModelId || '',
        garmentType: el.garmentType?.value || 't-shirt',
        zone: el.zone?.value || 'front-chest',
        size: el.size?.value || 'auto',
        clothingColor: amState.clothingColor,
        vectorize: el.vectorizeCheckbox?.checked || false,
        removeBackground: el.removeBgCheckbox?.checked || false
      };
    }

    // Update campaign item with mockup data
    const item = amState.campaignItems[index];
    if (item) {
      const serverBase = getServerBase();
      item.mockupImage = data.front ? `${serverBase}${data.front.imagePath}` : (data.back ? `${serverBase}${data.back.imagePath}` : '');
      item.mockupParams = {
        aiMockup: true,
        humanModelFrontId: amState.frontModelId || null,
        humanModelBackId: amState.backModelId || null,
        clothingColor: amState.clothingColor,
        garmentType: el.garmentType?.value || 't-shirt',
        zone: el.zone?.value || 'front-chest',
        size: el.size?.value || 'auto'
      };
    }

    // Callback
    if (amState.campaignOnComplete) {
      amState.campaignOnComplete(index, data);
    }

    renderCampaignQueue();
  }

  async function generateAllRemaining() {
    if (!amState.campaignTemplate) {
      alert('Generate the first item mockup to set the template, then use Generate All.');
      return;
    }

    const remaining = amState.campaignItems.reduce((arr, item, i) => {
      if (!amState.campaignResults[i]) arr.push(i);
      return arr;
    }, []);

    if (!remaining.length) {
      alert('All items already have mockups.');
      return;
    }

    for (let i = 0; i < remaining.length; i++) {
      const idx = remaining[i];
      amState.campaignItemIndex = idx;
      loadCampaignItem(idx);
      renderCampaignQueue();

      showProgress(`Generating item ${i + 1}/${remaining.length}...`);

      try {
        await generateMockup();
      } catch (e) {
        console.error(`[ApparelMockup] Failed to generate campaign item ${idx}:`, e);
      }

      // Rate limit between items
      if (i < remaining.length - 1) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    showProgress('');
    renderCampaignQueue();
  }

  // ---- Save Mockup ----------------------------------------------------------
  function showSaveNameInput(defaultValue, onConfirm) {
    // Remove existing if any
    const existing = document.getElementById('amSaveNameOverlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'amSaveNameOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:9999;';
    overlay.innerHTML = `
      <div style="background:var(--bg-secondary,#1e293b);border:1px solid var(--border,#334155);border-radius:8px;padding:20px;min-width:400px;max-width:500px;">
        <h3 style="margin:0 0 12px;font-size:14px;color:var(--text-primary,#f1f5f9);">Save Mockup to Library</h3>
        <input id="amSaveNameInput" type="text" value="${defaultValue.replace(/"/g, '&quot;')}" style="width:100%;padding:8px;font-size:13px;border-radius:4px;border:1px solid var(--border,#334155);background:var(--bg-primary,#0f172a);color:var(--text-primary,#f1f5f9);box-sizing:border-box;" />
        <div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end;">
          <button id="amSaveNameCancel" type="button" class="secondary" style="font-size:12px;padding:6px 16px;">Cancel</button>
          <button id="amSaveNameConfirm" type="button" style="font-size:12px;padding:6px 16px;background:#10b981;color:#fff;border:none;border-radius:4px;cursor:pointer;">Save</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const input = document.getElementById('amSaveNameInput');
    input.focus();
    input.select();

    const cleanup = () => overlay.remove();

    document.getElementById('amSaveNameConfirm').addEventListener('click', () => {
      const val = input.value.trim();
      cleanup();
      if (val) onConfirm(val);
    });
    document.getElementById('amSaveNameCancel').addEventListener('click', cleanup);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const val = input.value.trim();
        cleanup();
        if (val) onConfirm(val);
      } else if (e.key === 'Escape') {
        cleanup();
      }
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup();
    });
  }

  function showSaveStatus(msg, isError) {
    const el = document.createElement('div');
    el.style.cssText = `position:fixed;top:20px;right:20px;padding:10px 16px;border-radius:6px;font-size:13px;z-index:9999;color:#fff;background:${isError ? '#ef4444' : '#10b981'};`;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }

  async function saveMockup() {
    if (!amState.currentResult) {
      alert('No mockup to save. Generate one first.');
      return;
    }

    // Determine which image to save (prefer front, fall back to combined or back)
    const result = amState.currentResult;
    const imagePath = result.front?.imagePath || result.combined?.imagePath || result.back?.imagePath;
    if (!imagePath) {
      alert('No mockup image found to save.');
      return;
    }

    // Build suggested name from graphic + model info
    const graphicName = amState.selectedGraphic?.name || 'Unknown Graphic';
    const frontModel = amState.humanModels.find(m => String(m.id) === String(amState.frontModelId));
    const modelInfo = frontModel ? [frontModel.gender, frontModel.ethnicity, frontModel.apparel_type || frontModel.apparelType].filter(Boolean).join(' ') : '';
    const suggestedName = `${graphicName}${modelInfo ? ' - ' + modelInfo : ''}`;

    // Show inline name input (Electron doesn't support prompt())
    showSaveNameInput(suggestedName, async (title) => {
      if (!title) return;

      const serverBase = getServerBase();

      try {
        el.saveBtn.disabled = true;
        el.saveBtn.textContent = 'Saving...';

        const resp = await fetch(`${serverBase}/api/ai-images/apparel-mockup/save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title,
            imagePath,
            humanModelId: amState.frontModelId || amState.backModelId || null,
            graphicName,
            graphicPath: amState.selectedGraphic?.image || null,
            garmentType: el.garmentType?.value || 't-shirt',
            clothingColor: amState.clothingColor || '#ffffff'
          })
        });

        const data = await resp.json();
        if (!data.success) {
          el.saveBtn.textContent = 'Save to Library';
          el.saveBtn.disabled = false;
          showSaveStatus('Save failed: ' + (data.error || 'Unknown error'), true);
          return;
        }

        el.saveBtn.textContent = 'Saved!';
        el.saveBtn.style.background = '#059669';
        setTimeout(() => {
          el.saveBtn.textContent = 'Save to Library';
          el.saveBtn.style.background = '#10b981';
          el.saveBtn.disabled = false;
        }, 2000);

        console.log(`[ApparelMockup] Saved: ${data.mockupId} → ${data.filename}`);
      } catch (e) {
        console.error('[ApparelMockup] Save error:', e);
        el.saveBtn.textContent = 'Save to Library';
        el.saveBtn.disabled = false;
        showSaveStatus('Save failed: ' + e.message, true);
      }
    });
  }

  // ---- Reset / Init ---------------------------------------------------------
  function resetPreview() {
    amState.currentResult = null;
    amState.adjustX = 0;
    amState.adjustY = 0;
    amState.adjustScale = 100;

    if (el.previewFront) {
      el.previewFront.innerHTML = `
        <div class="apparel-mockup-preview-label">Front</div>
        <div class="apparel-mockup-preview-placeholder">Select a model and graphic, then click Generate</div>
      `;
    }
    if (el.previewBack) {
      el.previewBack.innerHTML = `
        <div class="apparel-mockup-preview-label">Back</div>
        <div class="apparel-mockup-preview-placeholder">Select a back model (optional)</div>
      `;
    }
    if (el.adjustControls) el.adjustControls.style.display = 'none';
    if (el.scaleSlider) el.scaleSlider.value = 100;
    if (el.scaleLabel) el.scaleLabel.textContent = '100%';
  }

  function bindEvents() {
    // Catalog
    el.categoryFilter?.addEventListener('change', renderCatalogGrid);
    el.searchInput?.addEventListener('input', debounce(renderCatalogGrid, 300));
    el.clearGraphic?.addEventListener('click', clearGraphic);

    // Model filters
    el.modelGenderFilter?.addEventListener('change', renderModelGrids);
    el.modelEthnicityFilter?.addEventListener('change', renderModelGrids);
    el.modelPoseFilter?.addEventListener('change', renderModelGrids);
    el.frontModelClear?.addEventListener('click', () => clearModel('front'));
    el.backModelClear?.addEventListener('click', () => clearModel('back'));

    // Clothing color
    el.clothingColor?.addEventListener('input', () => {
      setClothingColor(el.clothingColor.value);
    });
    el.colorPresets?.addEventListener('click', (e) => {
      const btn = e.target.closest('.am-color-preset');
      if (btn?.dataset.color) setClothingColor(btn.dataset.color);
    });

    // Generate
    el.generateBtn?.addEventListener('click', generateMockup);

    // Adjust controls
    document.querySelectorAll('.am-adjust-btn').forEach(btn => {
      btn.addEventListener('click', () => adjustDirection(btn.dataset.dir));
    });
    el.scaleSlider?.addEventListener('input', () => {
      amState.adjustScale = parseInt(el.scaleSlider.value, 10);
      if (el.scaleLabel) el.scaleLabel.textContent = amState.adjustScale + '%';
    });
    el.quickAdjustBtn?.addEventListener('click', quickAdjust);
    el.reblendBtn?.addEventListener('click', reblendWithAI);
    el.saveBtn?.addEventListener('click', saveMockup);

    // Campaign
    el.campaignGenerateAll?.addEventListener('click', generateAllRemaining);
    el.campaignSendAll?.addEventListener('click', () => {
      // Trigger send all — dispatches custom event for index.js to handle
      window.dispatchEvent(new CustomEvent('apparel-mockup:send-all-to-shopify', {
        detail: { results: amState.campaignResults, items: amState.campaignItems }
      }));
    });
  }

  function debounce(fn, ms) {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  // ---- Public API -----------------------------------------------------------
  window.initApparelMockupView = function (options = {}) {
    if (!amInitialized) {
      cacheElements();
      bindEvents();
      amInitialized = true;
    }

    // Load data
    loadCatalog();
    loadHumanModels();

    // Campaign mode
    if (options.campaignMode && options.campaignItems) {
      enterCampaignMode(options.campaignItems, options.startIndex || 0, options.onComplete);
    } else {
      exitCampaignMode();
    }
  };

  // Expose for campaign integration
  window.apparelMockupEnterCampaign = enterCampaignMode;
  window.apparelMockupExitCampaign = exitCampaignMode;
  window.apparelMockupGetResults = function () { return amState.campaignResults; };
  window.apparelMockupGetTemplate = function () { return amState.campaignTemplate; };

})();
