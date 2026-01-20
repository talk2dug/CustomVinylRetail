(() => {
  const els = {
    title: document.getElementById('title'),
    subtitle: document.getElementById('subtitle'),
    hero: document.getElementById('hero'),
    heroImg: document.getElementById('heroImg'),
    itemsGrid: document.getElementById('itemsGrid'),
    status: document.getElementById('status'),
    cartBar: document.getElementById('cartBar'),
    cartCount: document.getElementById('cartCount'),
    cartTotal: document.getElementById('cartTotal'),
    checkoutBtn: document.getElementById('checkoutBtn'),
    viewCartBtn: document.getElementById('viewCartBtn'),
    modal: document.getElementById('itemModal'),
    modalImg: document.getElementById('modalImg'),
    modalTitle: document.getElementById('modalTitle'),
    modalMeta: document.getElementById('modalMeta'),
    sizeRow: document.getElementById('sizeRow'),
    sizeSelect: document.getElementById('sizeSelect'),
    qtyInput: document.getElementById('qtyInput'),
    addToCartBtn: document.getElementById('addToCartBtn'),
    closeModalBtn: document.getElementById('closeModalBtn')
  };

  const state = { cart: [] };

  const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

  // Minimal apparel pricing model (mirrors web/script.js)
  const GARMENT_COST_CENTS = { tshirt: 350, hoodie: 1500, hat: 300, beanie: 375, headband: 200, accessory: 400, drinkware: 850 };
  const VINYL_COST_PER_SQFT_DOLLARS = 4 / 1200; // $4 per 1200 sqft roll
  const APPAREL_VINYL_USAGE_SQFT = { tshirt: 1, hoodie: 1.2, hat: 0.5, beanie: 0.45, headband: 0.25, accessory: 0.35, drinkware: 0.6 };
  const LABOR_RATE_PER_HOUR = 50;
  const LABOR_MINUTES_PER_ITEM = 10;
  const PROFIT_MARGIN = 0.3;
  const COLOR_ADDON_CENTS = 100;

  function calcApparelUnitPriceCents(productType = 'tshirt', colorCount = 1) {
    const garmentCost = GARMENT_COST_CENTS[productType] ?? GARMENT_COST_CENTS.tshirt;
    const vinylUsage = APPAREL_VINYL_USAGE_SQFT[productType] ?? APPAREL_VINYL_USAGE_SQFT.tshirt;
    const vinylCostCents = Math.round(vinylUsage * VINYL_COST_PER_SQFT_DOLLARS * 100);
    const laborCents = Math.round((LABOR_RATE_PER_HOUR / 60) * LABOR_MINUTES_PER_ITEM * 100);
    const baseCost = garmentCost + vinylCostCents + laborCents;
    const profitAdjusted = Math.round(baseCost * (1 + PROFIT_MARGIN));
    const extraColors = Math.max(0, Number(colorCount || 1) - 1);
    return roundUpToQuarterDollar(profitAdjusted + extraColors * COLOR_ADDON_CENTS);
  }

  function roundUpToQuarterDollar(cents) {
    const value = Math.max(0, Math.round(Number(cents) || 0));
    return Math.ceil(value / 25) * 25;
  }

  function getBulkDiscountRate(quantity) {
    const qty = Math.max(0, Number(quantity) || 0);
    if (qty >= 30) return 0.25;
    if (qty >= 21) return 0.15;
    if (qty >= 10) return 0.10;
    return 0;
  }

  function setStatus(msg) {
    if (els.status) els.status.textContent = msg || '';
  }

  function getParam(name) {
    const url = new URL(window.location.href);
    return url.searchParams.get(name) || '';
  }

  function resolveCampaignSlug() {
    return getParam('c') || getParam('campaign') || '';
  }

  async function fetchJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return res.json();
    const text = await res.text();
    throw new Error(`Unexpected response (${res.status}) ${text.slice(0, 120)}`);
  }

  async function parseJsonSafe(res) {
    const ct = res.headers?.get?.('content-type') || '';
    if (ct.includes('application/json')) {
      return res.json();
    }
    const text = await res.text();
    const status = res.status || 0;
    throw new Error(`Unexpected response (${status}) ${text.slice(0, 120)}`);
  }

  async function loadCampaign() {
    const slug = resolveCampaignSlug();
    if (!slug) throw new Error('Missing campaign id. Use ?c=your-campaign');
    const data = await fetchJson(`/api/public/campaigns/${encodeURIComponent(slug)}`);
    if (!data?.campaign) throw new Error('Campaign unavailable.');
    return data.campaign;
  }

  function getUnitPriceCents(item) {
    if (String(item.productType || '').toLowerCase() === 'sticker') {
      if (item.priceCents != null && Number.isFinite(Number(item.priceCents))) {
        return roundUpToQuarterDollar(Number(item.priceCents));
      }
      if (item.price != null && Number.isFinite(Number(item.price))) {
        return roundUpToQuarterDollar(Number(item.price) * 100);
      }
      return 0;
    }
    return calcApparelUnitPriceCents(item.productType, item.colors || 1);
  }

  function createItemCard(campaign, item, index) {
    const card = document.createElement('div');
    card.className = 'campaign-card';

    const media = document.createElement('div');
    media.className = 'campaign-card__media';
    const img = document.createElement('img');
    img.alt = item.name || 'Item';
    img.src = item.image;
    img.crossOrigin = 'anonymous';
    media.appendChild(img);
    card.appendChild(media);

    const body = document.createElement('div');
    body.className = 'campaign-card__body';
    const title = document.createElement('p');
    title.className = 'campaign-card__title';
    title.textContent = item.name || `Item ${index + 1}`;
    const meta = document.createElement('div');
    meta.className = 'campaign-card__meta';
    const unit = getUnitPriceCents(item);
    const typeLabel = String(item.productType || '').toUpperCase();
    const sizeLabel = item.size || item.sizeLabel || '';
    meta.textContent = `${typeLabel}${sizeLabel ? ' • ' + sizeLabel : ''} • ${USD.format(unit / 100)}`;
    body.appendChild(title);
    body.appendChild(meta);
    card.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'campaign-card__actions';
    const viewBtn = document.createElement('button');
    viewBtn.className = 'btn';
    viewBtn.textContent = 'View';
    viewBtn.addEventListener('click', () => openItemModal(campaign, item));
    const addBtn = document.createElement('button');
    addBtn.className = 'btn btn--primary';
    addBtn.textContent = 'Add to Cart';
    addBtn.disabled = !unit || unit <= 0;
    addBtn.addEventListener('click', () => addToCartQuick(campaign, item));
    actions.appendChild(viewBtn);
    actions.appendChild(addBtn);
    card.appendChild(actions);
    return card;
  }

  function formatMoney(cents) {
    return USD.format((cents || 0) / 100);
  }

  function updateCartBar() {
    const count = state.cart.reduce((sum, it) => sum + it.quantity, 0);
    const total = state.cart.reduce((sum, it) => sum + it.unitPriceCents * it.quantity, 0);
    if (els.cartCount) els.cartCount.textContent = `${count} item${count === 1 ? '' : 's'}`;
    if (els.cartTotal) els.cartTotal.textContent = formatMoney(total);
    if (els.cartBar) els.cartBar.classList.toggle('hidden', state.cart.length === 0);
  }

  function addToCartQuick(campaign, item) {
    const unit = getUnitPriceCents(item);
    if (!unit) return;
    const entry = {
      id: item.designId || item.id || item.name || String(Date.now()),
      name: item.name || campaign.title,
      productType: item.productType || 'tshirt',
      image: item.image,
      quantity: 1,
      unitPriceCents: unit,
      size: undefined
    };
    const idx = state.cart.findIndex((it) => it.id === entry.id && it.size === entry.size);
    if (idx >= 0) state.cart[idx].quantity += 1; else state.cart.push(entry);
    updateCartBar();
  }

  function openItemModal(campaign, item) {
    els.modalImg.src = item.image;
    els.modalTitle.textContent = item.name || campaign.title;
    const unit = getUnitPriceCents(item);
    els.modalMeta.textContent = `${String(item.productType || '').toUpperCase()} • ${formatMoney(unit)}`;
    els.qtyInput.value = String(item.quantity || 1);
    const isApparel = String(item.productType || '').toLowerCase() !== 'sticker';
    els.sizeRow.classList.toggle('hidden', !isApparel);
    if (isApparel) {
      const sizes = ['YXS','YS','YM','YL','YXL','XS','S','M','L','XL','2XL','3XL','4XL'];
      els.sizeSelect.innerHTML = '';
      sizes.forEach((s) => { const opt = document.createElement('option'); opt.value = s; opt.textContent = s; els.sizeSelect.appendChild(opt); });
    }
    els.addToCartBtn.onclick = () => {
      const qty = Math.max(1, Number(els.qtyInput.value || 1));
      const size = els.sizeRow.classList.contains('hidden') ? undefined : els.sizeSelect.value;
      // base unit
      const baseUnit = getUnitPriceCents(item);
      // apply bulk discount per line quantity
      const rate = getBulkDiscountRate(qty);
      const unit = rate > 0 ? roundUpToQuarterDollar(Math.round(baseUnit * (1 - rate))) : baseUnit;
      const entry = {
        id: item.designId || item.id || item.name || String(Date.now()),
        name: item.name || campaign.title,
        productType: item.productType || 'tshirt',
        image: item.image,
        quantity: qty,
        unitPriceCents: unit,
        size
      };
      const idx = state.cart.findIndex((it) => it.id === entry.id && it.size === entry.size);
      if (idx >= 0) {
        state.cart[idx].quantity += qty;
        // Recompute unit for new quantity
        const newQty = state.cart[idx].quantity;
        const newRate = getBulkDiscountRate(newQty);
        const newUnit = newRate > 0 ? roundUpToQuarterDollar(Math.round(baseUnit * (1 - newRate))) : baseUnit;
        state.cart[idx].unitPriceCents = newUnit;
      } else {
        state.cart.push(entry);
      }
      closeModal();
      updateCartBar();
    };
    els.modal.classList.remove('hidden');
    els.modal.setAttribute('aria-hidden', 'false');
  }

  function closeModal() {
    els.modal.classList.add('hidden');
    els.modal.setAttribute('aria-hidden', 'true');
  }

  async function imageToPngDataUrl(imgEl) {
    await imgEl.decode?.().catch(() => {});
    const iw = imgEl.naturalWidth || imgEl.width || 1000;
    const ih = imgEl.naturalHeight || imgEl.height || 1000;
    const MAX_DIM_START = 1000; // Start target for longest side
    const MIN_DIM = 360; // Don't go smaller than this
    const MAX_BASE64_LEN = 800 * 1024; // ~800 KB base64 (~600 KB binary)

    let targetMax = Math.min(MAX_DIM_START, Math.max(iw, ih));
    let dataUrl = '';

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const scale = Math.min(1, targetMax / Math.max(iw, ih));
      const w = Math.max(1, Math.round(iw * scale));
      const h = Math.max(1, Math.round(ih * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(imgEl, 0, 0, w, h);
      dataUrl = canvas.toDataURL('image/png');
      if (dataUrl.length <= MAX_BASE64_LEN || Math.max(w, h) <= MIN_DIM) break;
      // Reduce target and retry
      targetMax = Math.max(MIN_DIM, Math.floor(targetMax * 0.75));
    }
    return dataUrl;
  }

  async function handleBuyNow(campaign, item, imgEl, qtyInput) {
    try {
      const quantity = Math.max(1, Number(qtyInput.value || item.quantity || 1));
      setStatus('Preparing…');
      const dataUrl = await imageToPngDataUrl(imgEl);
      const baseUnit = getUnitPriceCents(item);
      const rate = getBulkDiscountRate(quantity);
      const unitPriceCents = rate > 0 ? roundUpToQuarterDollar(Math.round(baseUnit * (1 - rate))) : baseUnit;
      const totalCents = unitPriceCents * quantity;

      const payload = {
        imageData: dataUrl,
        designName: item.name || campaign.title,
        productType: item.productType || 'tshirt',
        category: `Campaign: ${campaign.title}`,
        quantity,
        campaign: campaign.slug,
        size: item.size || item.sizeLabel || undefined,
        utm: campaign.utm || { source: 'facebook', medium: 'social', campaign: campaign.slug },
        pricing: {
          productType: item.productType || 'tshirt',
          descriptor: `${item.name || campaign.title}${item.size ? ' • ' + item.size : ''}`,
          currency: 'USD',
          unitPriceCents,
          quantity,
          totalCents
        }
      };

      setStatus('Saving order…');
      const saveRes = await fetch('/api/save-design', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const saved = await parseJsonSafe(saveRes);
      if (!saveRes.ok) throw new Error(saved?.error || `Unable to save (HTTP ${saveRes.status}).`);
      const orderId = saved?.id;
      if (!orderId) throw new Error('Order id missing.');

      setStatus('Starting checkout…');
      const checkoutRes = await fetch(`/api/orders/${encodeURIComponent(orderId)}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const checkout = await parseJsonSafe(checkoutRes);
      if (!checkoutRes.ok || !checkout?.url) {
        throw new Error(checkout?.error || `Unable to start checkout (HTTP ${checkoutRes.status}).`);
      }
      window.location.href = checkout.url;
    } catch (err) {
      console.error(err);
      setStatus(err?.message || String(err));
      alert('Unable to start checkout: ' + (err?.message || err));
    }
  }

  async function handleCheckoutCart(campaign) {
    try {
      if (!state.cart.length) return;
      setStatus('Preparing checkout…');
      const images = await Promise.all(
        state.cart.map((it) => new Promise((resolve) => {
          const im = new Image();
          im.crossOrigin = 'anonymous';
          im.onload = () => resolve({ img: im, it });
          im.onerror = () => resolve({ img: null, it });
          im.src = it.image;
        }))
      );
      const valid = images.filter((e) => e.img);
      const cols = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(valid.length))));
      const tile = 280; const gap = 8; const rows = Math.ceil(valid.length / cols);
      const width = cols * tile + (cols - 1) * gap;
      const height = rows * tile + (rows - 1) * gap;
      const canvas = document.createElement('canvas');
      canvas.width = Math.min(1000, width);
      canvas.height = Math.min(1400, height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      let x = 0, y = 0; let colIndex = 0;
      valid.forEach(({ img }) => {
        const scale = Math.min(tile / img.width, tile / img.height, 1);
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const cx = x + Math.round((tile - w) / 2);
        const cy = y + Math.round((tile - h) / 2);
        ctx.drawImage(img, cx, cy, w, h);
        colIndex += 1; x += tile + gap;
        if (colIndex >= cols) { colIndex = 0; x = 0; y += tile + gap; }
      });
      const dataUrl = canvas.toDataURL('image/png');

      const totalCents = state.cart.reduce((sum, it) => sum + it.unitPriceCents * it.quantity, 0);
      const payload = {
        imageData: dataUrl,
        designName: `${campaign.title} · ${state.cart.length} items`,
        productType: 'bundle',
        category: `Campaign: ${campaign.title}`,
        quantity: 1,
        campaign: campaign.slug,
        cart: state.cart.map((it) => ({
          name: it.name, productType: it.productType, size: it.size, quantity: it.quantity, unitPriceCents: it.unitPriceCents
        })),
        pricing: { productType: 'bundle', descriptor: `${campaign.title} bundle`, currency: 'USD', unitPriceCents: totalCents, quantity: 1, totalCents }
      };

      const saveRes = await fetch('/api/save-design', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const saved = await parseJsonSafe(saveRes);
      if (!saveRes.ok) throw new Error(saved?.error || `Unable to save (HTTP ${saveRes.status}).`);
      const orderId = saved?.id; if (!orderId) throw new Error('Order id missing.');
      const checkoutRes = await fetch(`/api/orders/${encodeURIComponent(orderId)}/checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const checkout = await parseJsonSafe(checkoutRes);
      if (!checkoutRes.ok || !checkout?.url) throw new Error(checkout?.error || `Unable to start checkout (HTTP ${checkoutRes.status}).`);
      window.location.href = checkout.url;
    } catch (err) {
      console.error(err); setStatus(err?.message || String(err)); alert('Unable to checkout: ' + (err?.message || err));
    }
  }

  async function init() {
    try {
      const campaign = await loadCampaign();
      document.title = `${campaign.title} · Swayze's Custom Vinyl`;
      els.title.textContent = campaign.title;
      els.subtitle.textContent = campaign.subtitle || '';
      if (campaign.hero?.image) {
        els.heroImg.src = campaign.hero.image;
        els.hero.removeAttribute('hidden');
      }
      els.itemsGrid.innerHTML = '';
      (campaign.items || []).forEach((item, idx) => {
        els.itemsGrid.appendChild(createItemCard(campaign, item, idx));
      });
      setStatus(`${campaign.items?.length || 0} items`);

      // Cart controls
      els.checkoutBtn?.addEventListener('click', () => handleCheckoutCart(campaign));
      els.viewCartBtn?.addEventListener('click', () => alert('Cart feature coming soon.'));
      els.closeModalBtn?.addEventListener('click', closeModal);
      els.modal?.addEventListener('click', (e) => {
        if (e.target === els.modal || e.target.classList.contains('c-modal__backdrop')) closeModal();
      });
    } catch (err) {
      console.error(err);
      setStatus(err?.message || 'Failed to load campaign.');
    }
  }

  init();
})();
