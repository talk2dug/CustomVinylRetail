(() => {
  const PAGE_SIZE = 48;
  const REMOTE_ASSET_BASE = 'https://store.swayzecustomvinyl.com';

  function resolveSaveServerBase() {
    try {
      const url = new URL(window.location.href);
      const serverOverride = (url.searchParams.get('server') || '').trim();
      if (serverOverride) {
        try { return new URL(serverOverride).origin; } catch (_) {}
      }
    } catch (_) {}
    try {
      const current = new URL(window.location.href);
      if (current.protocol === 'http:' || current.protocol === 'https:') return current.origin;
    } catch (_) {}
    return 'http://127.0.0.1:4000';
  }

  // Get API key from URL parameter (passed from Print Station)
  function getApiKey() {
    try {
      const url = new URL(window.location.href);
      return url.searchParams.get('apiKey') || '';
    } catch (_) {
      return '';
    }
  }

  // Build fetch options with API key header
  function buildFetchOptions(options = {}) {
    const apiKey = getApiKey();
    const headers = { ...(options.headers || {}) };
    if (apiKey) {
      headers['X-API-Key'] = apiKey;
    }
    return { ...options, headers };
  }

  function buildServerEndpoint(pathname = '/') {
    const normalized = typeof pathname === 'string' && pathname.startsWith('/') ? pathname : `/${pathname || ''}`;
    try {
      const base = resolveSaveServerBase();
      const root = base.endsWith('/') ? base : `${base}/`;
      return new URL(normalized.replace(/^\//, ''), root).toString();
    } catch (_) {
      return normalized;
    }
  }

  // SSAW endpoints for background chooser
  const SSAW_STYLES_ENDPOINT = buildServerEndpoint('/api/vendors/ssaw/styles');
  const SSAW_PRODUCTS_ENDPOINT = buildServerEndpoint('/api/vendors/ssaw/products');
  const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

  // Calculate retail price with 30% markup and round to nearest quarter dollar
  function calculateRetailPrice(wholesaleCents) {
    if (!Number.isFinite(wholesaleCents)) return Infinity;
    // Apply 30% markup
    const markedUp = wholesaleCents * 1.30;
    // Convert to dollars and round to nearest quarter
    const dollars = markedUp / 100;
    const roundedDollars = Math.round(dollars * 4) / 4;
    // Convert back to cents
    return Math.round(roundedDollars * 100);
  }

  const els = {
    search: document.getElementById('searchInput'),
    category: document.getElementById('categorySelect'),
    catalog: document.getElementById('catalogList'),
    loadMore: document.getElementById('loadMoreBtn'),
    resultsInfo: document.getElementById('resultsInfo'),
    bgChooseBtn: document.getElementById('bgChooseBtn'),
    bgModal: document.getElementById('bgChooserModal'),
    bgClose: document.getElementById('bgChooserClose'),
    bgGrid: document.getElementById('bgChooserGrid'),
    variantModal: document.getElementById('variantPickerModal'),
    variantClose: document.getElementById('variantPickerClose'),
    variantGrid: document.getElementById('variantPickerGrid'),
    variantTitle: document.getElementById('variantPickerTitle'),
    variantSubtitle: document.getElementById('variantPickerSubtitle'),
    sizeModal: document.getElementById('sizePickerModal'),
    sizeClose: document.getElementById('sizePickerClose'),
    sizeGrid: document.getElementById('sizePickerGrid'),
    sizeTitle: document.getElementById('sizePickerTitle'),
    sizeSubtitle: document.getElementById('sizePickerSubtitle'),
    frontBackToggle: document.getElementById('frontBackToggle'),
    frontBackLabel: document.getElementById('frontBackLabel'),
    clearBtn: document.getElementById('clearBtn'),
    vectorizeBtn: document.getElementById('vectorizeBtn'),
    downloadPngBtn: document.getElementById('downloadPngBtn'),
    vectorizeRemoveWhite: document.getElementById('vectorizeRemoveWhite'),
    canvasEl: document.getElementById('mockupCanvas'),
    stageWrap: document.querySelector('.mockups__stage-wrap'),
    loading: document.getElementById('vectorizeLoading')
  };
  // Save controls
  els.productType = document.getElementById('productTypeSelect');
  els.saveCategory = document.getElementById('saveCategorySelect');
  els.saveCategoryInput = document.getElementById('saveCategoryInput');

  const state = {
    catalog: null,
    flatDesigns: [],
    filtered: [],
    visibleCount: 0,
    usingRemoteAssets: false,
    previews: [],
    apparelProducts: [],
    apparelLoaded: false,
    bgOpen: false,
    bgCategoryId: null,
    // Front/Back view management
    currentView: 'front', // 'front' or 'back'
    frontImageUrl: null,
    backImageUrl: null,
    frontCanvasState: null,
    backCanvasState: null,
    backgroundImageObject: null, // Store the current background image object
    // Selected apparel variant info for cart
    selectedApparel: null // { brand, styleName, color, size, sku, price, frontImageUrl, backImageUrl }
  };

  // Canvas setup
  if (!window.fabric) {
    console.error('Fabric.js not loaded yet.');
  }
  const canvas = new fabric.Canvas(els.canvasEl, {
    backgroundColor: '#fff',
    preserveObjectStacking: true
  });

  function setStatus(message, type = 'info', ttlMs = 2500) {
    if (!els.resultsInfo) return;
    const prev = els.resultsInfo.textContent;
    const prevColor = els.resultsInfo.style.color;
    els.resultsInfo.style.color = type === 'error' ? '#b91c1c' : '#6b7280';
    els.resultsInfo.textContent = String(message || '');
    if (ttlMs > 0) {
      setTimeout(() => {
        els.resultsInfo.style.color = prevColor || '#6b7280';
        els.resultsInfo.textContent = prev || '';
      }, ttlMs);
    }
  }

  function setCanvasSizeToFit(width, height) {
    // Constrain to viewport width
    const maxW = Math.min(1200, Math.floor((document.querySelector('.mockups__stage-wrap')?.clientWidth || 1200) - 24));
    const maxH = 900;
    const scale = Math.min(maxW / width, maxH / height, 1);
    const w = Math.round(width * scale);
    const h = Math.round(height * scale);
    canvas.setWidth(w);
    canvas.setHeight(h);
    canvas.renderAll();
  }

  function getActiveImageElement() {
    const obj = canvas.getActiveObject();
    if (!obj) return { obj: null, imgEl: null };
    // Prefer plain image objects
    if (obj.type === 'image' && (obj._originalElement || obj._element)) {
      return { obj, imgEl: obj._originalElement || obj._element };
    }
    // If group or other object, try to render to a canvas snapshot
    try {
      const dataUrl = obj.toDataURL({ format: 'png', multiplier: 2 });
      const tmp = new Image();
      tmp.crossOrigin = 'anonymous';
      return { obj, imgEl: tmp, dataUrl };
    } catch (_) {
      return { obj, imgEl: null };
    }
  }

  function setLoadingText(message = 'Vectorizing…') {
    if (els.loading) {
      const span = els.loading.querySelector('#vectorizeStepText') || els.loading.querySelector('span');
      if (span) span.textContent = message;
    }
  }

  function setProgress(pct) {
    const bar = els.progressBar || document.getElementById('vectorizeProgressBar');
    if (!bar) return;
    const clamped = Math.max(0, Math.min(100, Math.round(pct)));
    bar.style.width = clamped + '%';
  }

  function showLoading(message = 'Vectorizing…') {
    if (els.loading) {
      setLoadingText(message);
      setProgress(0);
      els.loading.hidden = false;
      document.body.style.cursor = 'progress';
    } else {
      setStatus(message, 'info', 0);
    }
  }

  function hideLoading() {
    if (els.loading) {
      els.loading.hidden = true;
      document.body.style.cursor = '';
    } else {
      setStatus('', 'info', 0);
    }
  }

  async function vectorizeSelected() {
    await ensureImageTracer();
    if (typeof ImageTracer === 'undefined') {
      setStatus('Vectorizer not available. Place web/imagetracer.min.js', 'error', 4000);
      alert('Vectorizer library not loaded. Ensure web/imagetracer.min.js exists and reload.');
      return;
    }
    showLoading('Preparing image…');
    // Allow the overlay to render before heavy work
    await new Promise((r) => setTimeout(r, 30));
    const { obj, imgEl, dataUrl } = getActiveImageElement();
    if (!obj) {
      setStatus('Select an overlay to vectorize.', 'error', 2500);
      hideLoading();
      return;
    }
    if (!imgEl) {
      setStatus('Unable to read selected object.', 'error', 2500);
      hideLoading();
      return;
    }
    // Ensure image source is ready
    if (dataUrl) imgEl.src = dataUrl;
    await new Promise((resolve) => {
      if (imgEl.complete && imgEl.naturalWidth) return resolve();
      imgEl.onload = () => resolve();
      imgEl.onerror = () => resolve();
    });
    setLoadingText('Scaling source…');
    setProgress(10);
    const iw = imgEl.naturalWidth || imgEl.width || 0;
    const ih = imgEl.naturalHeight || imgEl.height || 0;
    if (!iw || !ih) {
      setStatus('Invalid image dimensions.', 'error');
      hideLoading();
      return;
    }
    // Cap the vectorization resolution for performance
    const MAX_VECT_W = 1000;
    const scale = Math.min(MAX_VECT_W / iw, 1);
    const tw = Math.max(1, Math.round(iw * scale));
    const th = Math.max(1, Math.round(ih * scale));
    const off = document.createElement('canvas');
    off.width = tw;
    off.height = th;
    const octx = off.getContext('2d');
    octx.drawImage(imgEl, 0, 0, tw, th);
    setLoadingText('Extracting pixels…');
    setProgress(25);
    const imgData = octx.getImageData(0, 0, tw, th);

    // keep overlay visible; no status timeout here
    // Multi-color trace; tune params for quality vs. speed
    const options = {
      numberofcolors: 6,
      colorquantcycles: 3,
      strokewidth: 0,
      ltres: 1, // line threshold
      qtres: 1, // curve threshold
      pathomit: 8
    };
    // Optional: auto‑remove background (detect dominant edge color and remove similar)
    if (els.vectorizeRemoveWhite && els.vectorizeRemoveWhite.checked) {
      try {
        setLoadingText('Removing background…');
        setProgress(32);
        autoRemoveBackground(imgData);
      } catch (_) { /* ignore */ }
    }
    let svgstr = null;
    setLoadingText('Tracing paths…');
    let fake = 30; setProgress(fake);
    let ticking = true;
    const tick = () => { if (!ticking) return; fake = Math.min(85, fake + 3 + Math.random()*4); setProgress(fake); setTimeout(tick, 180); };
    setTimeout(tick, 180);
    try {
      svgstr = ImageTracer.imagedataToSVG(imgData, options);
    } catch (err) {
      console.error('Vectorize error:', err);
      setStatus('Vectorization failed', 'error');
      hideLoading();
      return;
    }
    ticking = false;
    if (!svgstr) {
      setStatus('Vectorization failed', 'error');
      hideLoading();
      return;
    }
    setLoadingText('Importing SVG…');
    setProgress(92);

    // Parse and add SVG via Fabric
    fabric.loadSVGFromString(svgstr, (objects, options) => {
      try {
        const group = (fabric.util && fabric.util.groupSVGElements)
          ? fabric.util.groupSVGElements(objects, options)
          : new fabric.Group(objects);

        // Ensure the group has measurable bounds before scaling
        canvas.add(group);
        group.set({ originX: 'center', originY: 'center' });

        // Target the same visual size as the raster object
        const center = obj.getCenterPoint();
        const targetW = obj.getScaledWidth() || obj.width || 1;
        const currW = group.getScaledWidth() || group.width || 1;
        let scale = 1;
        if (currW > 0 && Number.isFinite(currW)) {
          scale = targetW / currW;
        }
        group.scale(scale);
        group.set({ left: center.x, top: center.y });
        setObjectDefaults(group);
        group.objectCaching = false;
        group.setCoords();

        // Remove the raster and focus the new vector
        canvas.remove(obj);
        canvas.setActiveObject(group);
        canvas.requestRenderAll();
        setProgress(100);
        setStatus('Vectorized');
        hideLoading();
      } catch (e) {
        console.error('SVG import failed:', e);
        setStatus('Vectorized SVG import failed', 'error');
        hideLoading();
      }
    });
  }

  function autoRemoveBackground(imgData) {
    const { data, width, height } = imgData;
    if (!data || !width || !height) return;

    // Sample edge pixels to estimate background color
    let sr = 0, sg = 0, sb = 0, n = 0;
    const step = Math.max(1, Math.floor(Math.min(width, height) / 80)); // adaptive sampling density
    // Top and bottom rows
    for (let x = 0; x < width; x += step) {
      const i1 = (0 * width + x) * 4;
      const i2 = ((height - 1) * width + x) * 4;
      sr += data[i1]; sg += data[i1 + 1]; sb += data[i1 + 2]; n++;
      sr += data[i2]; sg += data[i2 + 1]; sb += data[i2 + 2]; n++;
    }
    // Left and right columns
    for (let y = 0; y < height; y += step) {
      const i1 = (y * width + 0) * 4;
      const i2 = (y * width + (width - 1)) * 4;
      sr += data[i1]; sg += data[i1 + 1]; sb += data[i1 + 2]; n++;
      sr += data[i2]; sg += data[i2 + 1]; sb += data[i2 + 2]; n++;
    }
    if (!n) return;
    const br = sr / n, bg = sg / n, bb = sb / n;

    // Compute distance stats on border samples to choose threshold
    let sum = 0, sumSq = 0, cnt = 0;
    const dist = (r, g, b) => {
      const dr = r - br, dg = g - bg, db = b - bb;
      return Math.sqrt(dr * dr + dg * dg + db * db);
    };
    for (let x = 0; x < width; x += step) {
      let i = (0 * width + x) * 4; let d = dist(data[i], data[i+1], data[i+2]); sum += d; sumSq += d * d; cnt++;
      i = ((height - 1) * width + x) * 4; d = dist(data[i], data[i+1], data[i+2]); sum += d; sumSq += d * d; cnt++;
    }
    for (let y = 0; y < height; y += step) {
      let i = (y * width + 0) * 4; let d = dist(data[i], data[i+1], data[i+2]); sum += d; sumSq += d * d; cnt++;
      i = (y * width + (width - 1)) * 4; d = dist(data[i], data[i+1], data[i+2]); sum += d; sumSq += d * d; cnt++;
    }
    const mean = cnt ? sum / cnt : 0;
    const variance = Math.max(0, (sumSq / Math.max(1, cnt)) - mean * mean);
    const std = Math.sqrt(variance);
    // Threshold: mean + 2*std, clamped to a sane range
    const thr = Math.max(20, Math.min(80, mean + 2 * std));

    // Remove pixels similar to background color
    for (let i = 0; i < data.length; i += 4) {
      const dr = data[i] - br, dg = data[i + 1] - bg, db = data[i + 2] - bb;
      const d = Math.sqrt(dr * dr + dg * dg + db * db);
      if (d <= thr) {
        data[i + 3] = 0; // transparent
      }
    }
  }

  // Dynamically load ImageTracer from local paths only (no CDN)
  function ensureImageTracer() {
    const tryLoad = (src) => new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = () => resolve(true);
      s.onerror = () => resolve(false);
      document.head.appendChild(s);
    });
    return new Promise(async (resolve) => {
      if (typeof ImageTracer !== 'undefined') return resolve(true);
      // 1) Relative path next to the page (works when served from /web/)
      const okRel = await tryLoad('./imagetracer.min.js');
      if (okRel && typeof ImageTracer !== 'undefined') return resolve(true);
      // 2) Same-origin root path on save server
      const okRoot = await tryLoad(buildServerEndpoint('/web/imagetracer.min.js'));
      if (okRoot && typeof ImageTracer !== 'undefined') return resolve(true);
      // 3) Same-origin vendor path on save server (optional fallback)
      const okVendor = await tryLoad(buildServerEndpoint('/web/vendor/imagetracer.min.js'));
      if (okVendor && typeof ImageTracer !== 'undefined') return resolve(true);
      resolve(false);
    });
  }

  function loadBackgroundFromUrl(url, categoryId) {
    if (!url) return;
    try {
      setStatus('Loading background…');
      const imgEl = new Image();
      if (!/^data:/i.test(url)) {
        imgEl.crossOrigin = 'anonymous';
      }
      imgEl.onload = () => {
        try {
          const iw = imgEl.naturalWidth || imgEl.width || 1000;
          const ih = imgEl.naturalHeight || imgEl.height || 1000;
          setCanvasSizeToFit(iw, ih);
          if (categoryId) state.bgCategoryId = categoryId;
          const fabricImg = new fabric.Image(imgEl);
          fabricImg.objectCaching = false; // avoid cross-origin cache taint issues
          const scale = Math.min(canvas.getWidth() / iw, canvas.getHeight() / ih);
          fabricImg.scale(scale);
          canvas.setBackgroundImage(fabricImg, canvas.renderAll.bind(canvas), {
            originX: 'left',
            originY: 'top',
            left: 0,
            top: 0
          });
          state.backgroundImageObject = fabricImg;
          setStatus('Background set');
        } catch (e) {
          console.error('Failed to set background:', e);
          setStatus('Failed to set background', 'error');
        }
      };
      imgEl.onerror = () => {
        console.error('Background image failed to load:', url);
        setStatus('Image failed to load', 'error');
      };
      imgEl.src = url;
    } catch (err) {
      console.error('loadBackgroundFromUrl error:', err);
      setStatus('Unable to load background', 'error');
    }
  }

  // Load apparel with both front and back images
  function loadApparelBackground(frontUrl, backUrl, categoryId) {
    state.frontImageUrl = frontUrl;
    state.backImageUrl = backUrl;
    state.currentView = 'front';
    state.frontCanvasState = null;
    state.backCanvasState = null;

    // Show toggle button if we have both front and back images
    if (els.frontBackToggle) {
      if (backUrl) {
        els.frontBackToggle.style.display = '';
        updateFrontBackLabel();
      } else {
        els.frontBackToggle.style.display = 'none';
      }
    }

    // Load front image
    loadBackgroundFromUrl(frontUrl, categoryId);
  }

  // Save current canvas state and switch views
  function toggleFrontBackView() {
    // Save current view's canvas state (objects only, not background)
    const currentState = canvas.toJSON(['selectable']);
    if (state.currentView === 'front') {
      state.frontCanvasState = currentState;
      state.currentView = 'back';
    } else {
      state.backCanvasState = currentState;
      state.currentView = 'front';
    }

    // Clear all objects from canvas (but keep background for now)
    const objects = canvas.getObjects();
    objects.forEach(obj => canvas.remove(obj));

    // Load the appropriate background
    const targetUrl = state.currentView === 'front' ? state.frontImageUrl : state.backImageUrl;
    if (targetUrl) {
      loadBackgroundFromUrl(targetUrl);
    }

    // Restore saved canvas state for target view
    const targetState = state.currentView === 'front' ? state.frontCanvasState : state.backCanvasState;
    if (targetState && targetState.objects) {
      // Load objects from saved state
      fabric.util.enlivenObjects(targetState.objects, (objects) => {
        objects.forEach((obj) => {
          canvas.add(obj);
        });
        canvas.renderAll();
      });
    }

    updateFrontBackLabel();
  }

  function updateFrontBackLabel() {
    if (!els.frontBackLabel) return;
    if (state.currentView === 'front') {
      els.frontBackLabel.textContent = 'Front';
      if (els.frontBackToggle) {
        els.frontBackToggle.innerHTML = '<span id="frontBackLabel" style="font-weight:700;">Front</span> ▸ Back';
      }
    } else {
      els.frontBackLabel.textContent = 'Back';
      if (els.frontBackToggle) {
        els.frontBackToggle.innerHTML = 'Front ▸ <span id="frontBackLabel" style="font-weight:700;">Back</span>';
      }
    }
    // Re-get the label element since innerHTML replaced it
    els.frontBackLabel = document.getElementById('frontBackLabel');
  }

  function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // Apparel background chooser
  async function loadApparelProducts() {
    if (state.apparelLoaded) return state.apparelProducts;
    try {
      const res = await fetch(buildServerEndpoint('/api/apparel/products'), buildFetchOptions({ cache: 'no-store' }));
      const data = await res.json().catch(() => ({}));
      const products = Array.isArray(data?.products) ? data.products : [];
      // Reduce to one preview image per product (first variant with image)
      state.apparelProducts = products
        .map((p) => {
          const v = (Array.isArray(p.variants) ? p.variants : []).find((vi) => vi.imageUrl);
          const image = v?.imageUrl || null;
          return image ? { title: p.title || p.handle || 'Apparel', productType: p.productType || 'tshirt', image } : null;
        })
        .filter(Boolean);
      state.apparelLoaded = true;
      return state.apparelProducts;
    } catch (err) {
      console.error('Unable to load apparel products:', err);
      state.apparelProducts = [];
      state.apparelLoaded = true;
      return [];
    }
  }

  function openBgModal() {
    if (!els.bgModal) return;
    els.bgModal.removeAttribute('hidden');
    state.bgOpen = true;
    // Render tabbed browser with In-Stock and Premium S&S options
    renderBgChooserWithTabs();
  }

  function closeBgModal() {
    if (!els.bgModal) return;
    els.bgModal.setAttribute('hidden', '');
    state.bgOpen = false;
  }

  // Helper function to create card elements
  function card(title, imageUrl, meta) {
    const el = document.createElement('div');
    el.className = 'card';
    const prev = document.createElement('div');
    prev.className = 'card__preview';
    const img = document.createElement('img');
    img.className = 'card__img';
    img.alt = title || 'Item';
    img.loading = 'lazy';
    img.decoding = 'async';
    if (imageUrl) img.src = imageUrl;
    prev.appendChild(img);
    el.appendChild(prev);
    const body = document.createElement('div');
    body.className = 'card__body';
    const titleEl = document.createElement('p');
    titleEl.className = 'card__title';
    titleEl.textContent = title || '—';
    body.appendChild(titleEl);
    if (meta) {
      const m = document.createElement('span');
      m.className = 'card__meta';
      m.textContent = meta;
      body.appendChild(m);
    }
    el.appendChild(body);
    return el;
  }

  function openVariantPicker(styleName, variants) {
    if (!els.variantModal || !variants || !variants.length) return;

    // Update modal title
    if (els.variantTitle) els.variantTitle.textContent = `Choose Variant - ${styleName}`;
    if (els.variantSubtitle) els.variantSubtitle.textContent = `${variants.length} variants available`;

    // Group variants by color for better organization
    const byColor = new Map();
    variants.forEach((v) => {
      const color = v.color || 'Unknown';
      if (!byColor.has(color)) byColor.set(color, []);
      byColor.get(color).push(v);
    });

    // Render variant cards
    if (els.variantGrid) {
      els.variantGrid.innerHTML = '';
      const frag = document.createDocumentFragment();

      byColor.forEach((colorVariants, color) => {
        // Show one card per color, with size info
        const firstVariant = colorVariants[0];
        const sizes = colorVariants.map(v => v.size).filter(Boolean).join(', ');
        const retailCents = calculateRetailPrice(firstVariant.piecePriceCents);
        const price = Number.isFinite(retailCents)
          ? USD.format(retailCents / 100)
          : 'Price varies';

        const el = card(
          `${color}`,
          firstVariant.imageUrl,
          `${price} · ${colorVariants.length} sizes`
        );

        // Add click handler to open size picker
        el.addEventListener('click', () => {
          openSizePicker(styleName, color, colorVariants);
        });

        frag.appendChild(el);
      });

      els.variantGrid.appendChild(frag);
    }

    // Show modal
    els.variantModal.removeAttribute('hidden');
  }

  function closeVariantPicker() {
    if (!els.variantModal) return;
    els.variantModal.setAttribute('hidden', '');
  }

  // Size picker modal
  function openSizePicker(styleName, color, colorVariants) {
    if (!els.sizeModal || !colorVariants || !colorVariants.length) return;

    // Update modal title
    if (els.sizeTitle) els.sizeTitle.textContent = `Choose Size - ${styleName}`;
    if (els.sizeSubtitle) els.sizeSubtitle.textContent = `${color} · ${colorVariants.length} sizes available`;

    // Render size buttons
    if (els.sizeGrid) {
      els.sizeGrid.innerHTML = '';
      const frag = document.createDocumentFragment();

      colorVariants.forEach((variant) => {
        const btn = document.createElement('button');
        btn.className = 'btn';
        btn.style.cssText = 'padding: 1rem; font-size: 1rem; font-weight: 600;';
        btn.textContent = variant.size || 'One Size';
        btn.type = 'button';

        btn.addEventListener('click', () => {
          // Store the selected apparel variant
          const retailCents = calculateRetailPrice(variant.piecePriceCents);
          state.selectedApparel = {
            brand: variant.brandName,
            styleName: variant.styleName,
            color: variant.color,
            size: variant.size,
            sku: variant.sku,
            price: retailCents,
            frontImageUrl: variant.frontImageUrl || variant.imageUrl,
            backImageUrl: variant.backImageUrl
          };

          // Load the background images
          const frontUrl = variant.frontImageUrl || variant.imageUrl;
          const backUrl = variant.backImageUrl;
          if (frontUrl) {
            loadApparelBackground(frontUrl, backUrl);
          }

          closeSizePicker();
          closeVariantPicker();
          closeBgModal();
        });

        frag.appendChild(btn);
      });

      els.sizeGrid.appendChild(frag);
    }

    // Show modal
    els.sizeModal.removeAttribute('hidden');
  }

  function closeSizePicker() {
    if (!els.sizeModal) return;
    els.sizeModal.setAttribute('hidden', '');
  }

  // Tabbed browser for In-Stock vs Premium (S&S) apparel
  function renderBgChooserWithTabs() {
    if (!els.bgGrid) return;
    els.bgGrid.innerHTML = '';

    // Create tab container
    const tabsContainer = document.createElement('div');
    tabsContainer.className = 'bgchooser-tabs';
    tabsContainer.style.cssText = 'display:flex;gap:0.5rem;padding:1rem;border-bottom:1px solid #e5e7eb;margin-bottom:1rem;';

    const inStockTab = document.createElement('button');
    inStockTab.className = 'btn';
    inStockTab.textContent = 'In-Stock Apparel';
    inStockTab.style.cssText = 'flex:1;';

    const premiumTab = document.createElement('button');
    premiumTab.className = 'btn';
    premiumTab.textContent = '✨ Premium (S&S Activewear)';
    premiumTab.style.cssText = 'flex:1;';

    const contentContainer = document.createElement('div');
    contentContainer.className = 'bgchooser-content';

    tabsContainer.appendChild(inStockTab);
    tabsContainer.appendChild(premiumTab);
    els.bgGrid.appendChild(tabsContainer);
    els.bgGrid.appendChild(contentContainer);

    function showInStock() {
      inStockTab.className = 'btn btn--primary';
      premiumTab.className = 'btn';
      renderInStockApparel(contentContainer);
    }

    function showPremium() {
      inStockTab.className = 'btn';
      premiumTab.className = 'btn btn--primary';
      renderBgChooserSsaw(contentContainer);
    }

    inStockTab.addEventListener('click', showInStock);
    premiumTab.addEventListener('click', showPremium);

    // Default to Premium S&S tab
    showPremium();
  }

  // Render in-stock apparel items
  async function renderInStockApparel(container) {
    container.innerHTML = '<p style="padding:1rem;text-align:center;color:#6b7280;">Loading in-stock items...</p>';
    const products = await loadApparelProducts();

    container.innerHTML = '';
    if (!products || !products.length) {
      container.innerHTML = '<p style="padding:2rem;text-align:center;color:#6b7280;">No in-stock apparel items available.<br>Try the Premium (S&S) tab for more options.</p>';
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'mockups__catalog';
    grid.style.cssText = 'padding:1rem;';

    products.forEach((product) => {
      const card = document.createElement('div');
      card.className = 'card';

      const preview = document.createElement('div');
      preview.className = 'card__preview';
      const img = document.createElement('img');
      img.className = 'card__img';
      img.src = product.image || '';
      img.alt = product.title || 'Apparel';
      img.loading = 'lazy';
      preview.appendChild(img);

      const body = document.createElement('div');
      body.className = 'card__body';
      const title = document.createElement('p');
      title.className = 'card__title';
      title.textContent = product.title || 'Apparel Item';
      body.appendChild(title);

      const badge = document.createElement('span');
      badge.className = 'card__meta';
      badge.textContent = 'In Stock';
      badge.style.cssText = 'color:#10b981;font-weight:600;';
      body.appendChild(badge);

      card.appendChild(preview);
      card.appendChild(body);

      card.addEventListener('click', () => {
        if (product.image) {
          loadBackgroundFromUrl(product.image);
          closeBgModal();
        }
      });

      grid.appendChild(card);
    });

    container.appendChild(grid);
  }

  // Visual SSAW browser inside background chooser
  function renderBgChooserSsaw(container) {
    if (!container) container = els.bgGrid;
    container.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'bgchooser';

    const categoriesPane = document.createElement('div');
    categoriesPane.className = 'bgchooser__pane';
    const categoriesTitle = document.createElement('h4');
    categoriesTitle.textContent = 'Categories';
    const categoriesRoot = document.createElement('div');
    categoriesRoot.className = 'bgchooser__list';
    categoriesPane.appendChild(categoriesTitle);
    categoriesPane.appendChild(categoriesRoot);

    const brandsPane = document.createElement('div');
    brandsPane.className = 'bgchooser__pane';
    const brandsTitle = document.createElement('h4');
    brandsTitle.textContent = 'Brands';
    const brandsRoot = document.createElement('div');
    brandsRoot.className = 'bgchooser__list';
    brandsPane.appendChild(brandsTitle);
    brandsPane.appendChild(brandsRoot);

    const itemsPane = document.createElement('div');
    itemsPane.className = 'bgchooser__pane';
    const itemsTitle = document.createElement('h4');
    itemsTitle.textContent = 'Items';
    const itemsRoot = document.createElement('div');
    itemsRoot.className = 'bgchooser__list';
    itemsPane.appendChild(itemsTitle);
    itemsPane.appendChild(itemsRoot);

    wrap.appendChild(categoriesPane);
    wrap.appendChild(brandsPane);
    wrap.appendChild(itemsPane);
    container.appendChild(wrap);

    let SSAW_CATEGORIES = [
      { id: 'tshirt', label: 'T‑Shirts', query: 't-shirt' },
      { id: 'longsleeve', label: 'Long‑Sleeve Tees', query: 'long sleeve' },
      { id: 'polo', label: 'Polos', query: 'polo' },
      { id: 'hoodie', label: 'Hoodies & Sweatshirts', query: 'hood' },
      { id: 'outerwear', label: 'Jackets & Outerwear', query: 'jacket' },
      { id: 'hat', label: 'Hats & Caps', query: 'cap' },
      { id: 'beanie', label: 'Beanies', query: 'beanie' },
      { id: 'accessory', label: 'Accessories', query: 'accessor' }
    ];

    const view = { category: null, brand: null };

    // Removed unused setCrumbs function - breadcrumbs not needed in three-column layout

    async function fetchStyles({ q = '', brand = '' } = {}) {
      const url = `${SSAW_STYLES_ENDPOINT}?${q ? `q=${encodeURIComponent(q)}` : ''}${brand ? `&brand=${encodeURIComponent(brand)}` : ''}`;
      console.log('[SSAW] Fetching styles:', { q, brand, url });
      try {
        const res = await fetch(url, { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        const styles = Array.isArray(data.styles) ? data.styles : [];
        console.log('[SSAW] Fetched', styles.length, 'styles for brand:', brand || '(all)');
        return styles;
      } catch (err) {
        console.error('[SSAW] Error fetching styles:', err);
        return [];
      }
    }

    async function showCategories() {
      view.category = null; view.brand = null;
      categoriesRoot.innerHTML = ''; brandsRoot.innerHTML = ''; itemsRoot.innerHTML = '';
      categoriesRoot.innerHTML = '<p style="padding:1rem;color:#6b7280;text-align:center;">Loading categories...</p>';

      const frag = document.createDocumentFragment();
      for (const cat of SSAW_CATEGORIES) {
        // Fetch one style to get a representative image
        const styles = await fetchStyles({ q: cat.query });
        const imageUrl = styles[0]?.imageUrl || null;
        const count = styles.length;
        const c = card(cat.label, imageUrl, count > 0 ? `${count} styles` : '');
        c.addEventListener('click', () => showBrands(cat));
        frag.appendChild(c);
      }
      categoriesRoot.innerHTML = '';
      categoriesRoot.appendChild(frag);
    }

    async function showBrands(cat) {
      view.category = cat; view.brand = null;
      brandsRoot.innerHTML = '<p style="padding:1rem;color:#6b7280;text-align:center;">Loading brands...</p>';
      itemsRoot.innerHTML = '';

      const styles = await fetchStyles({ q: cat.query });

      if (!styles || styles.length === 0) {
        brandsRoot.innerHTML = '<p style="padding:1rem;color:#6b7280;text-align:center;">No brands found for this category.</p>';
        return;
      }

      const byBrand = new Map();
      styles.forEach((s) => {
        const brand = (s.brandName || 'Other').trim();
        if (!byBrand.has(brand)) byBrand.set(brand, []);
        byBrand.get(brand).push(s);
      });
      const entries = Array.from(byBrand.entries()).sort((a,b)=>b[1].length-a[1].length).slice(0, 24);
      const frag = document.createDocumentFragment();
      entries.forEach(([brand, list]) => {
        const img = list.find((s)=>s.imageUrl)?.imageUrl || '';
        const c = card(brand, img, `${list.length} style(s)`);
        c.addEventListener('click', () => showItems(cat, brand));
        frag.appendChild(c);
      });
      brandsRoot.innerHTML = '';
      brandsRoot.appendChild(frag);
    }

    async function showItems(cat, brand) {
      view.brand = brand;
      itemsRoot.innerHTML = '<p style="padding:1rem;color:#6b7280;text-align:center;">Loading items...</p>';

      // Fetch all styles for the category (API doesn't support brand filtering)
      const allStyles = await fetchStyles({ q: cat.query });

      // Filter client-side by brand
      const styles = allStyles.filter((s) => {
        const sBrand = (s.brandName || '').trim();
        return sBrand === brand;
      });

      console.log('[SSAW] Filtered to', styles.length, 'styles for brand:', brand, 'from', allStyles.length, 'total');

      if (!styles || styles.length === 0) {
        itemsRoot.innerHTML = '<p style="padding:1rem;color:#6b7280;text-align:center;">No items found for this brand.</p>';
        return;
      }

      const frag = document.createDocumentFragment();
      styles.slice(0, 36).forEach((s) => {
        const el = card(`${s.styleName || ''} ${s.title || ''}`.trim() || s.brandName, s.imageUrl, 'Fetching price…');

        // Store variants data for variant picker
        let cachedVariants = null;
        let bestImage = s.imageUrl;
        const styleName = `${s.styleName || ''} ${s.title || ''}`.trim() || s.brandName;

        // Add click handler immediately so it works even if product fetch fails
        el.addEventListener('click', () => {
          // If we have variants, show the variant picker
          if (cachedVariants && cachedVariants.length > 0) {
            openVariantPicker(styleName, cachedVariants);
          } else if (bestImage) {
            // Fallback: load the style image directly if no variants available
            loadBackgroundFromUrl(bestImage);
            closeBgModal();
          }
        });

        frag.appendChild(el);

        // Fetch product details asynchronously for pricing, variants, and better image
        (async () => {
          try {
            const res = await fetch(`${SSAW_PRODUCTS_ENDPOINT}?style=${encodeURIComponent(s.styleID)}`, { cache: 'no-store' });
            if (!res.ok) {
              console.warn('[SSAW] Products API returned', res.status, 'for style', s.styleID);
              el.querySelector('.card__meta')?.replaceChildren(document.createTextNode('✨ Premium'));
              return;
            }
            const data = await res.json().catch(() => ({}));
            const variants = Array.isArray(data.variants) ? data.variants : [];
            if (!variants.length) {
              el.querySelector('.card__meta')?.replaceChildren(document.createTextNode('Unavailable'));
              return;
            }
            // Store variants for the variant picker
            cachedVariants = variants;
            let min = Infinity; let repImg = null;
            variants.forEach((v) => {
              const cents = Number(v.piecePriceCents) || Infinity;
              if (cents < min) min = cents;
              if (!repImg && v.imageUrl) repImg = v.imageUrl;
            });
            // Calculate retail price with 30% markup and quarter-dollar rounding
            const retailCents = calculateRetailPrice(min);
            const meta = Number.isFinite(retailCents) ? `✨ Premium · ${USD.format(retailCents/100)}` : '✨ Premium';
            const metaEl = el.querySelector('.card__meta');
            if (metaEl) {
              metaEl.textContent = meta;
              metaEl.style.cssText = 'color:#8b5cf6;font-weight:600;';
            }
            // Update image if we found a better one
            if (repImg) {
              bestImage = repImg;
              const img = el.querySelector('img');
              if (img && !img.src) img.src = repImg;
            }
          } catch (err) {
            console.error('[SSAW] Error fetching products for style', s.styleID, ':', err);
            const metaEl = el.querySelector('.card__meta');
            if (metaEl) metaEl.textContent = '✨ Premium';
          }
        })();
      });
      itemsRoot.innerHTML = '';
      itemsRoot.appendChild(frag);
    }

    /* variants view removed in three-column layout */
    async function showVariants(style) { /* not used */ return; }

    showCategories();
  }

  // Catalog loading
  async function tryFetchJson(url) {
    try {
      const res = await fetch(url, { credentials: 'omit', cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      return JSON.parse(text);
    } catch (_) { return null; }
  }

  async function loadCatalog() {
    // Match catalog.html and custom-stickers: try API first, then local snapshot
    const attempts = [
      '/api/catalog',
      './catalog.json'
    ];
    for (const u of attempts) {
      // If relative URL, resolve against same base
      const url = u.startsWith('/api/') ? buildServerEndpoint(u) : u;
      const data = await tryFetchJson(url);
      if (data && Array.isArray(data.categories)) {
        state.catalog = data;
        state.usingRemoteAssets = (u === './catalog.json');
        return;
      }
    }
    // Final fallback — empty catalog but keep UI usable
    state.catalog = { categories: [], assetRoot: '' };
    state.usingRemoteAssets = true;
  }

  function renderSaveCategoryOptions(catalog) {
    const select = els.saveCategory;
    if (!select) return;
    const categories = Array.isArray(catalog?.categories) ? catalog.categories : [];
    // Remember previous selection
    const prev = select.value;
    // Clear
    select.innerHTML = '';
    // Build options from catalog categories
    const optionFor = (slug, name) => {
      const opt = document.createElement('option');
      opt.value = slug;
      opt.textContent = name;
      return opt;
    };
    categories.forEach((c) => select.appendChild(optionFor(c.slug, c.name)));
    // Ensure Our Clothing Apparel exists as a choice
    if (!categories.some((c) => c.slug === 'our-clothing-apparel')) {
      select.appendChild(optionFor('our-clothing-apparel', 'Our Clothing Apparel'));
    }
    // Divider-like disabled option
    const sep = document.createElement('option');
    sep.disabled = true; sep.textContent = '──────────';
    select.appendChild(sep);
    // New category option
    const newOpt = document.createElement('option');
    newOpt.value = '__new__';
    newOpt.textContent = 'Create new category…';
    select.appendChild(newOpt);

    // Restore or default to Our Clothing Apparel
    const defaultSlug = prev || 'our-clothing-apparel';
    select.value = defaultSlug;
    if (select.value !== defaultSlug) {
      // if not found, default to first
      select.selectedIndex = 0;
    }
    toggleNewCategoryInput();
  }

  function toggleNewCategoryInput() {
    if (!els.saveCategory || !els.saveCategoryInput) return;
    const isNew = els.saveCategory.value === '__new__';
    els.saveCategoryInput.style.display = isNew ? '' : 'none';
  }

  function resolveImageUrl(image) {
    if (!image) return null;
    const v = String(image);
    if (/^(data:|https?:)/i.test(v)) return v;
    if (v.startsWith('/api/')) {
      return state.usingRemoteAssets ? (REMOTE_ASSET_BASE + v) : v;
    }
    // relative path inside web/ folder
    return v;
  }

  function flattenDesigns(catalog) {
    const flat = [];
    (catalog.categories || []).forEach((cat) => {
      const designs = Array.isArray(cat.designs) ? cat.designs : [];
      designs.forEach((d) => {
        flat.push({
          id: d.id,
          name: d.name || d.id,
          image: resolveImageUrl(d.image),
          categorySlug: cat.slug,
          categoryName: cat.name
        });
      });
    });
    return flat;
  }

  function renderCategoryOptions(catalog) {
    const sel = els.category;
    // Clear existing except first
    while (sel.options.length > 1) sel.remove(1);
    (catalog.categories || []).forEach((cat) => {
      const opt = document.createElement('option');
      opt.value = cat.slug;
      opt.textContent = cat.name;
      sel.appendChild(opt);
    });
  }

  function applyFilters() {
    const q = (els.search.value || '').trim().toLowerCase();
    const cat = (els.category.value || '').trim();
    state.filtered = state.flatDesigns.filter((d) => {
      if (cat && d.categorySlug !== cat) return false;
      if (!q) return true;
      return d.name.toLowerCase().includes(q);
    });
    state.visibleCount = 0;
    renderMore();
  }

  function createCard(design) {
    const card = document.createElement('div');
    card.className = 'card';

    const preview = document.createElement('div');
    preview.className = 'card__preview';

    const img = document.createElement('img');
    img.className = 'card__img';
    img.alt = design.name;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.crossOrigin = 'anonymous';
    img.src = design.image;
    img.style.width = '100%';
    img.style.height = '100%';
    img.style.objectFit = 'contain';
    img.addEventListener('load', () => {
      try {
        state.previews.push({ preview, img });
        resizePreview(preview, img);
      } catch {}
    }, { once: true });
    // Enable drag from catalog to stage
    img.draggable = true;
    img.addEventListener('dragstart', (ev) => {
      try {
        ev.dataTransfer.setData('application/x-design-json', JSON.stringify({
          id: design.id,
          name: design.name,
          image: design.image
        }));
      } catch {}
      // Also include URL for interoperability
      try { ev.dataTransfer.setData('text/uri-list', design.image); } catch {}
      try { ev.dataTransfer.setData('text/plain', design.image); } catch {}
    });
    img.addEventListener('click', () => addDesignToCanvas(design));
    preview.appendChild(img);
    card.appendChild(preview);

    const body = document.createElement('div');
    body.className = 'card__body';
    const title = document.createElement('p');
    title.className = 'card__title';
    title.textContent = design.name;
    body.appendChild(title);

    const addBtn = document.createElement('button');
    addBtn.className = 'btn card__btn';
    addBtn.type = 'button';
    addBtn.textContent = 'Add';
    addBtn.addEventListener('click', () => addDesignToCanvas(design));
    body.appendChild(addBtn);

    card.appendChild(body);
    return card;
  }

  function resizePreview(preview, img) {
    if (!preview || !img) return;
    const rect = preview.getBoundingClientRect();
    const containerWidth = rect.width || preview.clientWidth || 320;
    const iw = img.naturalWidth || img.width || 1;
    const ih = img.naturalHeight || img.height || 1;
    const h = Math.max(Math.round((containerWidth * ih) / iw), 60);
    preview.style.height = h + 'px';
  }

  let resizeQueued = false;
  function resizeAllPreviewsChunk(startIndex = 0) {
    const list = state.previews || [];
    if (!list.length) return;
    const BATCH = 40; // limit work per frame to avoid long rAF
    const end = Math.min(startIndex + BATCH, list.length);
    for (let i = startIndex; i < end; i++) {
      const item = list[i];
      if (item && item.preview && item.img) resizePreview(item.preview, item.img);
    }
    if (end < list.length) {
      requestAnimationFrame(() => resizeAllPreviewsChunk(end));
    }
  }

  function queueResizeAllPreviews() {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => {
      resizeQueued = false;
      resizeAllPreviewsChunk(0);
    });
  }

  window.addEventListener('resize', () => {
    // Recompute heights on resize (throttled in rAF and chunked)
    queueResizeAllPreviews();
  });

  function renderMore() {
    const list = els.catalog;
    if (state.visibleCount === 0) {
      list.innerHTML = '';
      state.previews = [];
    }
    const slice = state.filtered.slice(state.visibleCount, state.visibleCount + PAGE_SIZE);
    slice.forEach((d) => list.appendChild(createCard(d)));
    state.visibleCount += slice.length;
    const rest = Math.max(0, state.filtered.length - state.visibleCount);
    els.loadMore.disabled = rest === 0;
    els.resultsInfo.textContent = `${state.visibleCount} / ${state.filtered.length}`;
    // After DOM updates, recompute preview heights (throttled)
    queueResizeAllPreviews();
  }

  function setObjectDefaults(obj) {
    obj.set({
      cornerColor: '#1d4ed8',
      cornerStrokeColor: '#1d4ed8',
      borderColor: '#1d4ed8',
      transparentCorners: false,
      cornerSize: 10
    });
  }

  function addDesignToCanvas(design) {
    const url = resolveImageUrl(design.image);
    if (!url) return;
    fabric.Image.fromURL(url, (img) => {
      if (!img) return;
      // Scale down if too large
      const maxW = canvas.getWidth() * 0.65;
      const maxH = canvas.getHeight() * 0.65;
      const iw = img.width || 512;
      const ih = img.height || 512;
      const scale = Math.min(maxW / iw, maxH / ih, 1);
      img.objectCaching = false; // prevent white box from CORS-tainted cache
      img.scale(scale);
      img.set({ left: canvas.getWidth() / 2, top: canvas.getHeight() / 2, originX: 'center', originY: 'center' });
      setObjectDefaults(img);
      canvas.add(img);
      canvas.setActiveObject(img);
      canvas.renderAll();
    }, { crossOrigin: 'anonymous' });
  }

  async function uploadToApparel() {
    try {
      if (!canvas || !els.canvasEl) throw new Error('Canvas not ready');
      const defaultName = `Mockup ${new Date().toLocaleString()}`;
      const displayName = window.prompt('Name this apparel design', defaultName);
      if (!displayName) return; // user cancelled

      setStatus('Rendering image…');
      const dataUrl = canvas.toDataURL({ format: 'png', multiplier: 2 });
      const blob = await (await fetch(dataUrl)).blob();
      const fileName = `${displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'mockup'}-${Date.now()}.png`;
      const file = new File([blob], fileName, { type: 'image/png' });

      const form = new FormData();
      form.append('displayName', displayName);
      // Library category (for preview storage)
      const saveCatSelect = els.saveCategory;
      const saveCatInput = els.saveCategoryInput;
      let libraryCategorySlug = (saveCatSelect && saveCatSelect.value) || 'our-clothing-apparel';
      let apparelCategoryName = '';
      if (libraryCategorySlug === '__new__') {
        const newName = (saveCatInput && saveCatInput.value.trim()) || '';
        if (!newName) throw new Error('Enter a new category name.');
        apparelCategoryName = newName;
        form.append('categoryMode', 'new');
        form.append('newCategoryName', newName);
      } else {
        form.append('existingCategory', libraryCategorySlug || 'our-clothing-apparel');
        // Use option label as apparel display name
        const opt = saveCatSelect && saveCatSelect.options[saveCatSelect.selectedIndex];
        apparelCategoryName = (opt && opt.textContent) || 'Our Clothing Apparel';
      }
      form.append('preview', file, file.name);
      // Also register in apparel store
      form.append('apparelEnabled', '1');
      const productType = (els.productType && els.productType.value) || 'tshirt';
      form.append('apparelProductType', productType);
      form.append('apparelCategory', apparelCategoryName || 'Our Clothing Apparel');

      setStatus('Uploading to apparel…');
      const res = await fetch('/api/admin/artwork', { method: 'POST', body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || `Upload failed (HTTP ${res.status})`);
      }

      setStatus('Saved! Refreshing catalog…');
      await loadCatalog();
      renderCategoryOptions(state.catalog);
      // Auto-select the Our Clothing Apparel category so the new item is visible
      const targetSlug = libraryCategorySlug === '__new__' ? (apparelCategoryName ? (apparelCategoryName.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-')) : 'our-clothing-apparel') : libraryCategorySlug;
      renderSaveCategoryOptions(state.catalog);
      if (els.category) {
        els.category.value = targetSlug;
      }
      if (els.saveCategory) {
        els.saveCategory.value = targetSlug;
        toggleNewCategoryInput();
      }
      state.flatDesigns = flattenDesigns(state.catalog);
      applyFilters();
      setStatus('Catalog refreshed', 'info', 2000);
    } catch (err) {
      console.error('Upload failed:', err);
      setStatus(String(err?.message || err) || 'Upload failed', 'error', 4000);
      alert('Unable to save to apparel: ' + (err?.message || err));
    }
  }

  // Events
  els.search.addEventListener('input', applyFilters);
  els.category.addEventListener('change', applyFilters);
  if (els.saveCategory) {
    els.saveCategory.addEventListener('change', toggleNewCategoryInput);
  }
  els.loadMore.addEventListener('click', renderMore);
  els.clearBtn.addEventListener('click', () => {
    const bg = canvas.backgroundImage;
    canvas.getObjects().forEach((o) => canvas.remove(o));
    canvas.renderAll();
  });
  els.downloadPngBtn.addEventListener('click', uploadToApparel);
  if (els.vectorizeBtn) {
    els.vectorizeBtn.addEventListener('click', vectorizeSelected);
  }
  if (els.bgChooseBtn) {
    els.bgChooseBtn.addEventListener('click', () => openBgModal());
  }
  if (els.frontBackToggle) {
    els.frontBackToggle.addEventListener('click', toggleFrontBackView);
  }
  if (els.bgClose) {
    els.bgClose.addEventListener('click', () => closeBgModal());
  }
  if (els.bgModal) {
    els.bgModal.addEventListener('click', (e) => {
      const t = e.target;
      if (t && t.getAttribute && t.getAttribute('data-close') === 'bg') {
        closeBgModal();
      }
    });
  }

  // Variant picker event listeners
  if (els.variantClose) {
    els.variantClose.addEventListener('click', () => closeVariantPicker());
  }
  if (els.variantModal) {
    els.variantModal.addEventListener('click', (e) => {
      const t = e.target;
      if (t && t.getAttribute && t.getAttribute('data-close') === 'variant') {
        closeVariantPicker();
      }
    });
  }

  // Size picker event listeners
  if (els.sizeClose) {
    els.sizeClose.addEventListener('click', () => closeSizePicker());
  }
  if (els.sizeModal) {
    els.sizeModal.addEventListener('click', (e) => {
      const t = e.target;
      if (t && t.getAttribute && t.getAttribute('data-close') === 'size') {
        closeSizePicker();
      }
    });
  }

  if (els.productType) {
    els.productType.addEventListener('change', () => { if (state.bgOpen) renderBgChoices(); });
  }

  // Drag & drop: add designs or set background
  if (els.stageWrap) {
    els.stageWrap.addEventListener('dragover', (ev) => {
      ev.preventDefault();
    });
    els.stageWrap.addEventListener('drop', async (ev) => {
      ev.preventDefault();
      const dt = ev.dataTransfer;
      if (!dt) return;
      // Prefer explicit design JSON (from catalog cards)
      const designJson = dt.getData('application/x-design-json');
      if (designJson) {
        try {
          const design = JSON.parse(designJson);
          if (design && design.image) {
            addDesignToCanvas(design);
            return;
          }
        } catch {}
      }
      if (dt.files && dt.files.length) {
        const file = Array.from(dt.files).find((f) => /^image\//i.test(f.type));
        if (file) {
          const url = await readFileAsDataURL(file);
          loadBackgroundFromUrl(url);
          return;
        }
      }
      const url = dt.getData('text/uri-list') || dt.getData('text/plain');
      if (url && /^https?:/i.test(url)) {
        const u = url.trim();
        // Heuristic: library previews should be added as overlays, not as background
        if (/\/api\/library\//i.test(u)) {
          addDesignToCanvas({ image: u, name: 'Dropped design' });
        } else {
          loadBackgroundFromUrl(u);
        }
      }
    });
  }

  // ============================================
  // Human Model Feature
  // ============================================
  const humanModelEls = {
    btn: document.getElementById('humanModelBtn'),
    modal: document.getElementById('humanModelModal'),
    close: document.getElementById('humanModelClose'),
    grid: document.getElementById('humanModelGrid'),
    empty: document.getElementById('humanModelEmpty'),
    categoryFilter: document.getElementById('humanModelCategoryFilter'),
    genderFilter: document.getElementById('humanModelGenderFilter'),
    poseFilter: document.getElementById('humanModelPoseFilter'),
    colorPicker: document.getElementById('humanModelColorPicker'),
    colorLabel: document.getElementById('humanModelColorLabel'),
    colorPresets: document.getElementById('humanModelColorPresets'),
    cancelBtn: document.getElementById('humanModelCancelBtn'),
    applyBtn: document.getElementById('humanModelApplyBtn')
  };

  const humanModelState = {
    models: [],
    categories: [],
    selectedModel: null,
    clothingColor: '#ffffff',
    loaded: false
  };

  // Fetch human models from API
  async function loadHumanModels() {
    if (humanModelState.loaded && humanModelState.models.length > 0) return;
    try {
      const res = await fetch(buildServerEndpoint('/api/human-models?activeOnly=true&limit=500'), buildFetchOptions());
      if (!res.ok) throw new Error('Failed to load human models');
      const data = await res.json();
      humanModelState.models = data.models || [];
      humanModelState.categories = [...new Set(humanModelState.models.map(m => m.category).filter(Boolean))];
      humanModelState.loaded = true;
      populateHumanModelCategories();
      console.log('[Human Models] Loaded', humanModelState.models.length, 'models');
    } catch (err) {
      console.error('loadHumanModels error:', err);
      humanModelState.models = [];
      humanModelState.loaded = false;
    }
  }

  function populateHumanModelCategories() {
    if (!humanModelEls.categoryFilter) return;
    humanModelEls.categoryFilter.innerHTML = '<option value="">All Categories</option>' +
      humanModelState.categories.map(c => `<option value="${c}">${c}</option>`).join('');
  }

  function renderHumanModelGrid() {
    if (!humanModelEls.grid) return;

    const category = humanModelEls.categoryFilter?.value || '';
    const gender = humanModelEls.genderFilter?.value || '';
    const pose = humanModelEls.poseFilter?.value || '';

    let filtered = humanModelState.models;
    if (category) filtered = filtered.filter(m => m.category === category);
    if (gender) filtered = filtered.filter(m => m.gender === gender);
    if (pose) filtered = filtered.filter(m => m.pose_type === pose);

    if (filtered.length === 0) {
      humanModelEls.grid.innerHTML = '';
      humanModelEls.empty.style.display = 'block';
      return;
    }

    humanModelEls.empty.style.display = 'none';
    humanModelEls.grid.innerHTML = filtered.map(model => {
      const thumbUrl = model.thumbnailPath || model.thumbnail_path || model.optimizedPath || model.optimized_path || model.filePath || model.file_path || '';
      const fullUrl = thumbUrl.startsWith('http') ? thumbUrl : buildServerEndpoint(thumbUrl.startsWith('/library/') ? '/api' + thumbUrl : thumbUrl.startsWith('library/') ? '/api/' + thumbUrl : thumbUrl);
      const isSelected = humanModelState.selectedModel?.id === model.id;
      return `
        <div class="human-model-card ${isSelected ? 'selected' : ''}" data-model-id="${model.id}" style="
          cursor:pointer;
          border-radius:8px;
          overflow:hidden;
          background:#1e293b;
          border:2px solid ${isSelected ? '#3b82f6' : 'transparent'};
          transition:border-color 0.2s;
        ">
          <div style="aspect-ratio:3/4;background:#0f172a;display:flex;align-items:center;justify-content:center;overflow:hidden;">
            <img src="${fullUrl}" alt="${model.title || 'Model'}" style="width:100%;height:100%;object-fit:cover;" loading="lazy" />
          </div>
          <div style="padding:8px;">
            <div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${model.title || 'Untitled'}</div>
            <div style="font-size:11px;color:#64748b;">${model.category || ''} ${(model.poseType || model.pose_type) ? '· ' + (model.poseType || model.pose_type) : ''}</div>
          </div>
        </div>
      `;
    }).join('');
  }

  function selectHumanModel(modelId) {
    const model = humanModelState.models.find(m => String(m.id) === String(modelId));
    humanModelState.selectedModel = model || null;
    humanModelEls.applyBtn.disabled = !model;
    renderHumanModelGrid();
  }

  function setClothingColor(color) {
    humanModelState.clothingColor = color;
    if (humanModelEls.colorPicker) humanModelEls.colorPicker.value = color;
    if (humanModelEls.colorLabel) humanModelEls.colorLabel.textContent = color;
    // Update preset selection
    humanModelEls.colorPresets?.querySelectorAll('.color-preset').forEach(btn => {
      btn.style.border = btn.dataset.color === color ? '2px solid #3b82f6' : '1px solid #475569';
    });
  }

  // Apply color tint to white clothing in image using canvas
  async function applyClothingColorToImage(imageUrl, targetColor) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = img.width;
        tempCanvas.height = img.height;
        const ctx = tempCanvas.getContext('2d');

        // Draw original image
        ctx.drawImage(img, 0, 0);

        // Get image data
        const imageData = ctx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
        const data = imageData.data;

        // Parse target color
        const r2 = parseInt(targetColor.slice(1, 3), 16);
        const g2 = parseInt(targetColor.slice(3, 5), 16);
        const b2 = parseInt(targetColor.slice(5, 7), 16);

        // If target is white, no need to process
        if (r2 === 255 && g2 === 255 && b2 === 255) {
          resolve(imageUrl);
          return;
        }

        // Process each pixel - tint white/light areas
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          const a = data[i + 3];

          // Skip transparent pixels
          if (a < 10) continue;

          // Calculate brightness and saturation
          const brightness = (r + g + b) / 3;
          const maxC = Math.max(r, g, b);
          const minC = Math.min(r, g, b);
          const saturation = maxC === 0 ? 0 : (maxC - minC) / maxC;

          // Only tint light, low-saturation pixels (white/gray clothing)
          // Higher threshold for brightness, lower for saturation
          if (brightness > 180 && saturation < 0.2) {
            // Blend factor based on how white the pixel is
            const whiteness = Math.min(1, (brightness - 180) / 75);
            const factor = whiteness * (1 - saturation * 2);

            // Apply color tint with multiplicative blending
            data[i] = Math.round(r * (r2 / 255) * factor + r * (1 - factor));
            data[i + 1] = Math.round(g * (g2 / 255) * factor + g * (1 - factor));
            data[i + 2] = Math.round(b * (b2 / 255) * factor + b * (1 - factor));
          }
        }

        ctx.putImageData(imageData, 0, 0);
        resolve(tempCanvas.toDataURL('image/png'));
      };
      img.onerror = () => reject(new Error('Failed to load image for color processing'));
      img.src = imageUrl;
    });
  }

  async function applySelectedHumanModel() {
    if (!humanModelState.selectedModel) return;

    const model = humanModelState.selectedModel;
    const imageUrl = model.optimizedPath || model.optimized_path || model.filePath || model.file_path || '';
    const fullUrl = imageUrl.startsWith('http') ? imageUrl : buildServerEndpoint(imageUrl.startsWith('/library/') ? '/api' + imageUrl : imageUrl.startsWith('library/') ? '/api/' + imageUrl : imageUrl);

    try {
      // Apply clothing color tint
      const tintedUrl = await applyClothingColorToImage(fullUrl, humanModelState.clothingColor);

      // Load as background
      loadBackgroundFromUrl(tintedUrl);

      // Close modal
      humanModelEls.modal.hidden = true;
    } catch (err) {
      console.error('applySelectedHumanModel error:', err);
      alert('Failed to apply human model: ' + err.message);
    }
  }

  function openHumanModelModal() {
    loadHumanModels().then(() => {
      renderHumanModelGrid();
      humanModelEls.modal.hidden = false;
    });
  }

  function closeHumanModelModal() {
    humanModelEls.modal.hidden = true;
  }

  // Human Model event listeners
  if (humanModelEls.btn) {
    humanModelEls.btn.addEventListener('click', openHumanModelModal);
  }
  if (humanModelEls.close) {
    humanModelEls.close.addEventListener('click', closeHumanModelModal);
  }
  if (humanModelEls.cancelBtn) {
    humanModelEls.cancelBtn.addEventListener('click', closeHumanModelModal);
  }
  if (humanModelEls.applyBtn) {
    humanModelEls.applyBtn.addEventListener('click', applySelectedHumanModel);
  }
  if (humanModelEls.modal) {
    humanModelEls.modal.querySelector('.designer-modal__backdrop')?.addEventListener('click', closeHumanModelModal);
  }
  if (humanModelEls.categoryFilter) {
    humanModelEls.categoryFilter.addEventListener('change', renderHumanModelGrid);
  }
  if (humanModelEls.genderFilter) {
    humanModelEls.genderFilter.addEventListener('change', renderHumanModelGrid);
  }
  if (humanModelEls.poseFilter) {
    humanModelEls.poseFilter.addEventListener('change', renderHumanModelGrid);
  }
  if (humanModelEls.colorPicker) {
    humanModelEls.colorPicker.addEventListener('input', (e) => setClothingColor(e.target.value));
  }
  if (humanModelEls.colorPresets) {
    humanModelEls.colorPresets.addEventListener('click', (e) => {
      const btn = e.target.closest('.color-preset');
      if (btn?.dataset.color) setClothingColor(btn.dataset.color);
    });
  }
  if (humanModelEls.grid) {
    humanModelEls.grid.addEventListener('click', (e) => {
      const card = e.target.closest('.human-model-card');
      if (card?.dataset.modelId) selectHumanModel(card.dataset.modelId);
    });
  }

  // Initialize
  (async function init() {
    // Try to load a placeholder background if present
    try { loadBackgroundFromUrl('images/race-crew-shirt.jpg'); } catch {}

    try {
      await loadCatalog();
      renderCategoryOptions(state.catalog);
      renderSaveCategoryOptions(state.catalog);
      state.flatDesigns = flattenDesigns(state.catalog);
      applyFilters();
    } catch (err) {
      els.catalog.innerHTML = '<p style="padding:12px;color:#b91c1c;">Failed to load catalog.</p>';
      console.error(err);
    }
  })();
})();
