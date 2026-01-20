// Apparel-only helpers layered on top of mockups.js
(function(){
  function getCanvas() {
    return window.__APPAREL_FABRIC_CANVAS__ || null;
  }

  function setStatus(message, type = 'info', ttlMs = 2500) {
    const el = document.getElementById('resultsInfo');
    if (!el) return;
    const prev = el.textContent;
    const prevColor = el.style.color;
    el.style.color = type === 'error' ? '#b91c1c' : '#6b7280';
    el.textContent = String(message || '');
    if (ttlMs > 0) {
      setTimeout(() => { el.style.color = prevColor || '#6b7280'; el.textContent = prev || ''; }, ttlMs);
    }
  }

  function getGarmentWidthInches() {
    // Map by selected category (captured from background chooser)
    const map = {
      tshirt: 20,
      longsleeve: 20,
      polo: 20,
      hoodie: 22,
      outerwear: 22,
      hat: 7,
      beanie: 7,
      accessory: 10,
      drinkware: 4
    };
    const key = (window.__APPAREL_CATEGORY_ID__ || '').toLowerCase();
    return map[key] || 20;
  }

  async function estimateObjectColorCount(obj) {
    try {
      let imgEl = null; let dataUrl = null;
      if (obj.type === 'image' && (obj._originalElement || obj._element)) {
        imgEl = obj._originalElement || obj._element;
      } else {
        try { dataUrl = obj.toDataURL({ format: 'png', multiplier: 2 }); } catch (_) {}
      }
      if (dataUrl) {
        const tmp = new Image();
        tmp.crossOrigin = 'anonymous';
        tmp.src = dataUrl;
        await new Promise(r => { tmp.onload = r; tmp.onerror = r; });
        imgEl = tmp;
      }
      if (!imgEl) return 1;
      const max = 128;
      const iw = imgEl.naturalWidth || imgEl.width || 1;
      const ih = imgEl.naturalHeight || imgEl.height || 1;
      const scale = Math.min(max / Math.max(iw, ih), 1);
      const w = Math.max(1, Math.round(iw * scale));
      const h = Math.max(1, Math.round(ih * scale));
      const off = document.createElement('canvas'); off.width = w; off.height = h;
      const octx = off.getContext('2d');
      octx.drawImage(imgEl, 0, 0, w, h);
      const { data } = octx.getImageData(0, 0, w, h);
      let solid = 0; const counts = new Map();
      for (let i=0;i<data.length;i+=4) {
        const a = data[i+3]; if (a < 16) continue;
        const r = data[i] >> 4, g = data[i+1] >> 4, b = data[i+2] >> 4;
        const key = (r<<8) | (g<<4) | b;
        counts.set(key, (counts.get(key) || 0) + 1);
        solid++;
      }
      if (!solid) return 1;
      const threshold = Math.max(1, Math.floor(solid * 0.15));
      const entries = Array.from(counts.entries()).filter(([,c]) => c >= threshold);
      if (!entries.length) return 1;
      // Merge nearby colors to treat gradients as one
      const clusters = [];
      const dist = (c1, c2) => {
        const r1 = ((c1>>8)&0x0f)*16+8, g1=((c1>>4)&0x0f)*16+8, b1=(c1&0x0f)*16+8;
        const r2 = ((c2>>8)&0x0f)*16+8, g2=((c2>>4)&0x0f)*16+8, b2=(c2&0x0f)*16+8;
        const dr=r1-r2,dg=g1-g2,db=b1-b2; return Math.sqrt(dr*dr+dg*dg+db*db);
      };
      const MERGE_THRESHOLD = 30;
      entries.sort((a,b)=>b[1]-a[1]).forEach(([k,c])=>{
        let placed = false;
        for (const cl of clusters) {
          if (dist(cl.center, k) <= MERGE_THRESHOLD) { cl.total += c; placed = true; break; }
        }
        if (!placed) clusters.push({ center: k, total: c });
      });
      return Math.max(1, Math.min(4, clusters.length || 1));
    } catch (_) {
      return 1;
    }
  }

  async function handleAddToCart() {
    try {
      const canvas = getCanvas();
      if (!canvas) { setStatus('Canvas not ready', 'error', 3000); return; }
      // Require sign-in so the order is linked to the customer account
      const token = localStorage.getItem('stickerPortalToken') || '';
      let customerProfile = null;
      if (token) {
        try {
          const res = await fetch('/api/customer/profile', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
          if (res.ok) {
            const data = await res.json().catch(()=>({}));
            customerProfile = data?.customer || null;
          }
        } catch (_) { /* ignore */ }
      }
      if (!customerProfile) {
        if (confirm('Please sign in to save your order. Continue to sign in?')) {
          window.location.href = './customer.html';
        }
        return false;
      }
      // Prefer active object, else last added object
      let obj = canvas.getActiveObject();
      if (!obj) {
        const objs = canvas.getObjects();
        if (objs && objs.length) obj = objs[objs.length - 1];
      }
      if (!obj) { setStatus('Add a decal first', 'error', 3000); return false; }
      const overlayWpx = (obj.getScaledWidth && obj.getScaledWidth()) || ((obj.width || 0) * (obj.scaleX || 1));
      const canvasW = canvas.getWidth() || 1;
      const garmentWIn = getGarmentWidthInches();
      const estWidthIn = Math.max(1, Math.round((overlayWpx / canvasW) * garmentWIn));
      const colorCount = await estimateObjectColorCount(obj);
      // Create an order on the server (like catalog.html)
      const dataUrl = canvas.toDataURL({ format: 'png', multiplier: 2 });
      const productType = (function(){
        const c = (window.__APPAREL_CATEGORY_ID__ || '').toLowerCase();
        if (c.includes('hood')) return 'hoodie';
        if (c.includes('jacket') || c.includes('outer')) return 'hoodie';
        if (c.includes('hat') || c.includes('cap')) return 'hat';
        if (c.includes('beanie')) return 'beanie';
        if (c.includes('drink')) return 'drinkware';
        if (c.includes('access')) return 'accessory';
        return 'tshirt';
      })();
      const payload = {
        imageData: dataUrl,
        designId: `apparel-${Date.now()}`,
        designName: 'Custom apparel',
        category: 'Apparel',
        size: estWidthIn,
        color: '#000000',
        background: '#ffffff',
        quantity: 1,
        notes: `${productType} · approx ${estWidthIn}\" · ${colorCount} color${colorCount===1?'':'s'}`,
        productType,
        pricing: null,
        textLayers: [],
        customer: {
          name: customerProfile.name || '',
          email: customerProfile.email || '',
          phone: customerProfile.phone || '',
          address: customerProfile.address || ''
        }
      };
      const authHeaders = { 'Content-Type': 'application/json' };
      const tokenHdr = localStorage.getItem('stickerPortalToken');
      if (tokenHdr) authHeaders['Authorization'] = `Bearer ${tokenHdr}`;
      const res = await fetch('/api/save-design', { method: 'POST', headers: authHeaders, body: JSON.stringify(payload) });
      const out = await res.json().catch(()=>({}));
      if (!res.ok) { setStatus(out?.error || 'Unable to create order', 'error', 4000); return false; }
      const orderNum = out?.orderNumber || '';
      setStatus(orderNum ? `Order #${orderNum} created` : 'Order created');
      return true;
    } catch (e) {
      setStatus('Unable to add to cart', 'error', 3000);
      return false;
    }
  }

  function init() {
    const btn = document.getElementById('addToCartBtn');
    if (btn) btn.addEventListener('click', async () => {
      const ok = await handleAddToCart();
      if (ok) { updateCartCount(); openCartModal(); }
    });
    const myOrdersBtn = document.getElementById('myOrdersBtn');
    if (myOrdersBtn) myOrdersBtn.addEventListener('click', () => {
      window.location.href = './customer.html';
    });
    // Track chosen category from background chooser without modifying mockups.js
    const bgBtn = document.getElementById('bgChooseBtn');
    if (bgBtn) {
      bgBtn.addEventListener('click', () => {
        setTimeout(wireBgChooserTracking, 150);
      });
    }
    const cartBtn = document.getElementById('cartBtn');
    if (cartBtn) cartBtn.addEventListener('click', openCartModal);
    const cartClose = document.getElementById('cartClose');
    if (cartClose) cartClose.addEventListener('click', closeCartModal);
    const backdrop = document.querySelector('#cartModal .designer-modal__backdrop');
    if (backdrop) backdrop.addEventListener('click', closeCartModal);
    const checkout = document.getElementById('cartCheckout');
    if (checkout) checkout.addEventListener('click', goToCheckout);

    // Color picker for single-color decals
    initColorPicker();

    updateCartCount();
  }

  function initColorPicker() {
    const colorPickerWrapper = document.getElementById('colorPickerWrapper');
    const colorPicker = document.getElementById('decalColorPicker');
    if (!colorPickerWrapper || !colorPicker) return;

    // Listen for canvas selection events
    const checkInterval = setInterval(() => {
      const canvas = getCanvas();
      if (canvas) {
        clearInterval(checkInterval);

        // Handle selection changes
        canvas.on('selection:created', handleSelectionChange);
        canvas.on('selection:updated', handleSelectionChange);
        canvas.on('selection:cleared', () => {
          colorPickerWrapper.style.display = 'none';
        });

        // Handle color picker changes
        colorPicker.addEventListener('input', async () => {
          const selectedObj = canvas.getActiveObject();
          if (!selectedObj) return;

          const newColor = colorPicker.value;
          await applyColorToObject(selectedObj, newColor);
          canvas.renderAll();
        });
      }
    }, 100);

    async function handleSelectionChange(e) {
      const obj = e.selected && e.selected[0] ? e.selected[0] : e.target;
      if (!obj) {
        colorPickerWrapper.style.display = 'none';
        return;
      }

      // Check if object is single-color
      const colorCount = await estimateObjectColorCount(obj);

      if (colorCount === 1) {
        // Show color picker
        colorPickerWrapper.style.display = 'flex';

        // Try to set picker to current object color
        const currentColor = extractObjectColor(obj);
        if (currentColor) {
          colorPicker.value = currentColor;
        }
      } else {
        colorPickerWrapper.style.display = 'none';
      }
    }

    function extractObjectColor(obj) {
      try {
        // For SVG/path objects
        if (obj.fill && typeof obj.fill === 'string' && obj.fill.startsWith('#')) {
          return obj.fill;
        }
        if (obj.stroke && typeof obj.stroke === 'string' && obj.stroke.startsWith('#')) {
          return obj.stroke;
        }
        // For groups, try first object
        if (obj.type === 'group' && obj._objects && obj._objects.length > 0) {
          const first = obj._objects[0];
          if (first.fill && typeof first.fill === 'string' && first.fill.startsWith('#')) {
            return first.fill;
          }
        }
        return '#000000';
      } catch (_) {
        return '#000000';
      }
    }

    async function applyColorToObject(obj, color) {
      try {
        // For SVG/path objects
        if (obj.type === 'path' || obj.type === 'circle' || obj.type === 'rect' || obj.type === 'polygon') {
          if (obj.fill && obj.fill !== 'transparent') {
            obj.set('fill', color);
          }
          if (obj.stroke && obj.stroke !== 'transparent') {
            obj.set('stroke', color);
          }
        }
        // For groups (SVG groups)
        else if (obj.type === 'group' && obj._objects) {
          obj._objects.forEach((child) => {
            if (child.fill && child.fill !== 'transparent' && typeof child.fill === 'string') {
              child.set('fill', color);
            }
            if (child.stroke && child.stroke !== 'transparent' && typeof child.stroke === 'string') {
              child.set('stroke', color);
            }
          });
        }
        // For images, apply a color filter
        else if (obj.type === 'image') {
          // Remove existing filters
          obj.filters = obj.filters || [];
          // Add a tint/blend color filter (this is a simplified approach)
          // For true recoloring of single-color images, we'd need a more sophisticated filter
          // This basic implementation works best for black/white images
          const BlendColor = fabric.Image.filters.BlendColor;
          if (BlendColor) {
            obj.filters = [
              new BlendColor({
                color: color,
                mode: 'tint',
                alpha: 0.8
              })
            ];
            obj.applyFilters();
          }
        }
      } catch (e) {
        console.warn('Error applying color:', e);
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

// Cart UI helpers
(function(){
  function getCart(){ try { return JSON.parse(localStorage.getItem('cartItems')||'[]'); } catch(_) { return []; } }
  function setCart(arr){ localStorage.setItem('cartItems', JSON.stringify(arr||[])); }
  function fmtItem(it, idx){
    const div = document.createElement('div');
    div.className = 'card';
    const body = document.createElement('div');
    body.className = 'card__body';
    const title = document.createElement('p'); title.className='card__title';
    title.textContent = `Decal · ${it.widthInches}\" · ${it.colors} color${it.colors===1?'':'s'}`;
    const meta = document.createElement('span'); meta.className='card__meta';
    const dt = new Date(it.addedAt||Date.now()); meta.textContent = dt.toLocaleString();
    const rm = document.createElement('button'); rm.className='btn card__btn'; rm.type='button'; rm.textContent='Remove';
    rm.addEventListener('click', () => { const arr = getCart(); arr.splice(idx,1); setCart(arr); render(); updateCartCount(); });
    body.appendChild(title); body.appendChild(meta); body.appendChild(rm); div.appendChild(body); return div;
  }
  async function fetchUnpaidOrders() {
    try {
      const token = localStorage.getItem('stickerPortalToken') || '';
      if (!token) return [];
      const res = await fetch('/api/customer/orders', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
      if (!res.ok) return [];
      const data = await res.json().catch(()=>({}));
      const orders = Array.isArray(data.orders) ? data.orders : [];
      return orders.filter(o => !o.paid && String(o.paymentStatus||'').toUpperCase() !== 'PAID');
    } catch (_) { return []; }
  }
  function fmtOrderItem(order){
    const div = document.createElement('div');
    div.className = 'card';
    const body = document.createElement('div'); body.className = 'card__body';
    const title = document.createElement('p'); title.className='card__title';
    title.textContent = order.orderNumber ? `Order #${order.orderNumber}` : (order.designName || 'Order');
    const meta = document.createElement('span'); meta.className='card__meta';
    const qty = Number(order.quantity||1); const status = order.paymentStatus || 'UNPAID';
    meta.textContent = `Qty ${qty} · ${status}`;
    body.appendChild(title); body.appendChild(meta); div.appendChild(body);
    return div;
  }
  async function render(){
    const list = document.getElementById('cartList'); if (!list) return;
    list.innerHTML='';
    const token = localStorage.getItem('stickerPortalToken') || '';
    if (token) {
      const unpaid = await fetchUnpaidOrders();
      if (!unpaid.length) { list.innerHTML = '<p class="hint" style="padding:8px;">No unpaid orders.</p>'; return; }
      const frag = document.createDocumentFragment();
      unpaid.forEach((o)=>frag.appendChild(fmtOrderItem(o)));
      list.appendChild(frag);
      return;
    }
    const items = getCart();
    if (!items.length){ list.innerHTML = '<p class="hint" style="padding:8px;">Your cart is empty.</p>'; return; }
    const frag = document.createDocumentFragment();
    items.forEach((it, idx)=>frag.appendChild(fmtItem(it, idx)));
    list.appendChild(frag);
  }
  window.updateCartCount = async function(){
    const el = document.getElementById('cartCount'); if (!el) return;
    const token = localStorage.getItem('stickerPortalToken') || '';
    if (token) {
      const unpaid = await fetchUnpaidOrders();
      const totalQty = unpaid.reduce((sum,o)=> sum + (Number(o.quantity||1)||1), 0);
      el.textContent = String(totalQty || 0);
      return;
    }
    el.textContent = String((getCart()||[]).length);
  };
  window.openCartModal = function(){ const m = document.getElementById('cartModal'); if(!m) return; render(); m.removeAttribute('hidden'); };
  window.closeCartModal = function(){ const m = document.getElementById('cartModal'); if(!m) return; m.setAttribute('hidden',''); };
  function mapCategoryToProductType(cat){
    const c = String(cat||'').toLowerCase();
    if (c.includes('hood')) return 'hoodie';
    if (c.includes('jacket') || c.includes('outer')) return 'hoodie';
    if (c.includes('hat') || c.includes('cap')) return 'hat';
    if (c.includes('beanie')) return 'beanie';
    if (c.includes('polo')) return 'tshirt';
    if (c.includes('long')) return 'tshirt';
    if (c.includes('drink')) return 'drinkware';
    if (c.includes('access')) return 'accessory';
    return 'tshirt';
  }
  function getBackgroundImageUrl(){
    try {
      const c = window.__APPAREL_FABRIC_CANVAS__;
      const bg = c && c.backgroundImage; // fabric.Image
      const el = bg && (bg._originalElement || bg._element);
      return el && el.src ? el.src : null;
    } catch(_) { return null; }
  }
  window.goToCheckout = function(){
    const items = (function(){ try { return JSON.parse(localStorage.getItem('cartItems')||'[]'); } catch(_) { return []; } })();
    if (!items.length) { alert('Your cart is empty. Add an item first.'); return; }
    const last = items[items.length-1];
    const catId = window.__APPAREL_CATEGORY_ID__ || 'tshirt';
    const payload = {
      id: null,
      name: 'Custom apparel',
      image: getBackgroundImageUrl(),
      productType: mapCategoryToProductType(catId),
      size: '',
      quantity: 1,
      priceCents: null,
      categorySlug: catId,
      categoryName: catId
    };
    try { localStorage.setItem('storeSelection', JSON.stringify(payload)); } catch(_) {}
    // Follow custom-stickers flow: send to catalog to finalize + checkout
    window.location.href = './catalog.html?store=1';
  };
})();

// Capture category selection from the S&S background chooser (DOM-based, no mockups.js changes)
(function(){
  function mapCategoryTitleToId(title){
    const t = String(title||'').toLowerCase();
    if (t.includes('hood')) return 'hoodie';
    if (t.includes('jacket') || t.includes('outer')) return 'outerwear';
    if (t.includes('hat') || t.includes('cap')) return 'hat';
    if (t.includes('beanie')) return 'beanie';
    if (t.includes('polo')) return 'polo';
    if (t.includes('long')) return 'longsleeve';
    if (t.includes('drink')) return 'drinkware';
    if (t.includes('access')) return 'accessory';
    return 'tshirt';
  }
  window.wireBgChooserTracking = function(){
    const modal = document.getElementById('bgChooserModal'); if (!modal) return;
    // If already wired, skip
    if (modal.__wiredForCategory) return; modal.__wiredForCategory = true;
    modal.addEventListener('click', (e) => {
      const card = e.target.closest('.card'); if (!card) return;
      // Determine which pane the click came from
      const pane = e.target.closest('.bgchooser__pane');
      if (!pane) return;
      const h = pane.querySelector('h4'); const title = h ? h.textContent.trim() : '';
      if (/Categories/i.test(title)) {
        const catTitleEl = card.querySelector('.card__title');
        const catTitle = catTitleEl ? catTitleEl.textContent.trim() : '';
        window.__APPAREL_CATEGORY_ID__ = mapCategoryTitleToId(catTitle);
      }
      if (/Items/i.test(title)) {
        // If picking item without a recent category capture, infer from last stored or default
        if (!window.__APPAREL_CATEGORY_ID__) {
          // Try to infer from presence of Brands pane heading (we can't read selected value reliably), default tshirt
          window.__APPAREL_CATEGORY_ID__ = 'tshirt';
        }
      }
    }, true);
  };
})();
