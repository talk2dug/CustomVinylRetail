/* ========================================
   Multiboard Storefront — Package Selector + Cart
   ======================================== */

(function () {
  'use strict';

  // ---- State ----
  let allProducts = [];
  let basePackages = [];
  let addons = [];
  let heroImages = [];
  let shopifyDomain = '';

  const cart = {
    base: null,
    addons: [],  // [{ product, quantity }]
    getTotal() {
      let total = 0;
      if (this.base) total += this.base.priceCents;
      for (const a of this.addons) {
        total += a.product.priceCents * a.quantity;
      }
      return total;
    },
    getItemCount() {
      let count = this.base ? 1 : 0;
      for (const a of this.addons) count += a.quantity;
      return count;
    }
  };

  // ---- Room icons ----
  const ROOM_ICONS = {
    kitchen: '🍳',
    garage: '🔧',
    craft: '🎨',
    office: '🖥️',
    desk: '🖥️'
  };

  // ---- Init ----
  document.addEventListener('DOMContentLoaded', async () => {
    await loadProducts();
    renderHeroGallery();
    renderPackages();
    renderAddons();
    initFAQ();
    initSmoothScroll();
    document.getElementById('checkout-btn').addEventListener('click', doCheckout);
  });

  async function loadProducts() {
    try {
      const res = await fetch('/api/multiboard-store/products');
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Failed to load products');
      allProducts = data.products;
      heroImages = data.heroImages || [];
      shopifyDomain = data.shopifyDomain || '';
      basePackages = allProducts.filter(p => p.category === 'multiboard_base');
      addons = allProducts.filter(p => p.category === 'multiboard_addon');
    } catch (err) {
      console.error('Failed to load products:', err);
      document.getElementById('package-cards').innerHTML =
        '<p style="color:var(--text-gray);text-align:center;grid-column:1/-1;">Unable to load products. Please refresh.</p>';
    }
  }

  // ---- Render hero gallery ----
  function renderHeroGallery() {
    const container = document.getElementById('hero-gallery');
    if (!heroImages.length || !container) return;
    container.innerHTML = heroImages.slice(0, 5).map(img =>
      `<img src="${escAttr(img.url)}" alt="Multiboard wall organization system" loading="lazy">`
    ).join('');
  }

  // ---- Render packages ----
  function renderPackages() {
    const container = document.getElementById('package-cards');
    if (!basePackages.length) return;

    container.innerHTML = basePackages.map(pkg => {
      const room = pkg.room || '';
      const icon = ROOM_ICONS[room] || '📦';
      const price = formatPrice(pkg.priceCents);
      const included = (pkg.whatsIncluded || [])
        .map(item => `<li>${escHtml(item)}</li>`).join('');

      return `
        <div class="package-card" data-id="${escAttr(pkg.id)}" data-room="${escAttr(room)}">
          <span class="selected-check">✓</span>
          ${pkg.image ? `<img class="package-image" src="${escAttr(pkg.image)}" alt="${escAttr(pkg.name)}" loading="lazy">` : ''}
          <div class="package-room-icon">${icon}</div>
          <div class="package-name">${escHtml(pkg.name)}</div>
          <div class="package-grid-size">${escHtml(pkg.gridSize || '')}</div>
          <div class="package-description">${escHtml(pkg.heroDescription || pkg.description || '')}</div>
          <ul class="package-included">${included}</ul>
          <div class="package-price">${price} <span class="price-label">kit</span></div>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.package-card').forEach(card => {
      card.addEventListener('click', () => selectPackage(card.dataset.id));
    });
  }

  function selectPackage(id) {
    const pkg = basePackages.find(p => p.id === id);
    if (!pkg) return;

    cart.base = pkg;
    // Reset addon quantities when switching base
    cart.addons = [];

    // Highlight selected card
    document.querySelectorAll('.package-card').forEach(c => c.classList.remove('selected'));
    const selected = document.querySelector(`.package-card[data-id="${CSS.escape(id)}"]`);
    if (selected) selected.classList.add('selected');

    renderAddons();
    updateCartBar();
  }

  // ---- Render add-ons ----
  function renderAddons() {
    const container = document.getElementById('addon-cards');
    const emptyMsg = document.getElementById('addon-empty');

    if (!cart.base) {
      container.innerHTML = '';
      emptyMsg.style.display = 'block';
      return;
    }
    emptyMsg.style.display = 'none';

    const compatibleSlugs = cart.base.compatibleAddons || [];

    container.innerHTML = addons.map(addon => {
      const isCompat = compatibleSlugs.includes(addon.slug);
      const existing = cart.addons.find(a => a.product.id === addon.id);
      const qty = existing ? existing.quantity : 0;

      return `
        <div class="addon-card ${isCompat ? '' : 'incompatible'} ${qty > 0 ? 'has-quantity' : ''}" data-id="${escAttr(addon.id)}">
          ${addon.image ? `<img class="addon-image" src="${escAttr(addon.image)}" alt="${escAttr(addon.name)}" loading="lazy">` : ''}
          <div class="addon-name">${escHtml(addon.name)}</div>
          <div class="addon-description">${escHtml(addon.heroDescription || addon.description || '')}</div>
          <div class="addon-bottom">
            <span class="addon-price">${formatPrice(addon.priceCents)}</span>
            ${isCompat ? `
              <div class="qty-control">
                <button class="qty-btn qty-minus" data-id="${escAttr(addon.id)}">−</button>
                <span class="qty-value">${qty}</span>
                <button class="qty-btn qty-plus" data-id="${escAttr(addon.id)}">+</button>
              </div>
            ` : ''}
          </div>
        </div>
      `;
    }).join('');

    // Wire up +/- buttons
    container.querySelectorAll('.qty-plus').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        changeAddonQty(btn.dataset.id, 1);
      });
    });
    container.querySelectorAll('.qty-minus').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        changeAddonQty(btn.dataset.id, -1);
      });
    });
  }

  function changeAddonQty(addonId, delta) {
    const addon = addons.find(a => a.id === addonId);
    if (!addon) return;

    let entry = cart.addons.find(a => a.product.id === addonId);
    if (!entry) {
      entry = { product: addon, quantity: 0 };
      cart.addons.push(entry);
    }

    entry.quantity = Math.max(0, Math.min(5, entry.quantity + delta));

    // Remove if 0
    cart.addons = cart.addons.filter(a => a.quantity > 0);

    renderAddons();
    updateCartBar();
  }

  // ---- Cart bar ----
  function updateCartBar() {
    const bar = document.getElementById('cart-bar');
    const count = cart.getItemCount();

    if (count === 0) {
      bar.style.display = 'none';
      document.body.classList.remove('cart-visible');
      return;
    }

    bar.style.display = 'block';
    document.body.classList.add('cart-visible');

    document.getElementById('cart-count').textContent = count + (count === 1 ? ' item' : ' items');
    document.getElementById('cart-total').textContent = formatPrice(cart.getTotal());

    // Build item list
    const parts = [];
    if (cart.base) parts.push(cart.base.name);
    for (const a of cart.addons) {
      parts.push(a.quantity > 1 ? `${a.quantity}x ${a.product.name}` : a.product.name);
    }
    document.getElementById('cart-items-list').textContent = parts.join(', ');
  }

  // ---- Checkout ----
  function doCheckout() {
    if (!cart.base) return;

    const url = buildShopifyCartUrl();
    if (url) {
      window.location.href = url;
    } else {
      alert('Unable to build checkout link. Shopify variant IDs may not be configured yet.');
    }
  }

  function buildShopifyCartUrl() {
    if (!shopifyDomain) return null;

    const items = [];
    if (cart.base && cart.base.shopifyVariantId) {
      items.push(cart.base.shopifyVariantId + ':1');
    }
    for (const a of cart.addons) {
      if (a.quantity > 0 && a.product.shopifyVariantId) {
        items.push(a.product.shopifyVariantId + ':' + a.quantity);
      }
    }

    if (!items.length) return null;
    return 'https://' + shopifyDomain + '/cart/' + items.join(',');
  }

  // ---- FAQ accordion ----
  function initFAQ() {
    document.querySelectorAll('.faq-question').forEach(btn => {
      btn.addEventListener('click', () => {
        const item = btn.closest('.faq-item');
        const wasOpen = item.classList.contains('open');
        // Close all
        document.querySelectorAll('.faq-item').forEach(i => i.classList.remove('open'));
        // Toggle current
        if (!wasOpen) item.classList.add('open');
      });
    });
  }

  // ---- Smooth scroll for anchor links ----
  function initSmoothScroll() {
    document.querySelectorAll('a[href^="#"]').forEach(link => {
      link.addEventListener('click', (e) => {
        const target = document.querySelector(link.getAttribute('href'));
        if (target) {
          e.preventDefault();
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    });
  }

  // ---- Helpers ----
  function formatPrice(cents) {
    return '$' + (cents / 100).toFixed(2);
  }

  function escHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function escAttr(str) {
    return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

})();
