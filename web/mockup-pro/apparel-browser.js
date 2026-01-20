/**
 * Apparel Browser Module for Mockup Pro
 * Handles inventory browsing from in-stock and S&S Activewear
 */

const SSAW_CATEGORIES = [
  { id: 'tshirt', label: 'T-Shirts', query: 't-shirt' },
  { id: 'longsleeve', label: 'Long Sleeve Tees', query: 'long sleeve' },
  { id: 'polo', label: 'Polos', query: 'polo' },
  { id: 'hoodie', label: 'Hoodies & Sweatshirts', query: 'hood' },
  { id: 'outerwear', label: 'Jackets & Outerwear', query: 'jacket' },
  { id: 'hat', label: 'Hats & Caps', query: 'cap' },
  { id: 'beanie', label: 'Beanies', query: 'beanie' },
  { id: 'tanktop', label: 'Tank Tops', query: 'tank' }
];

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

// Calculate retail price with 30% markup
function calculateRetailPrice(wholesaleCents) {
  if (!Number.isFinite(wholesaleCents)) return null;
  const markedUp = wholesaleCents * 1.30;
  const dollars = markedUp / 100;
  return Math.round(dollars * 4) / 4 * 100; // Round to nearest quarter dollar
}

class ApparelBrowser {
  constructor(options = {}) {
    this.onSelectVariant = options.onSelectVariant || (() => {});
    this.onApparelColorChange = options.onApparelColorChange || (() => {});

    this.currentSource = 'ssaw'; // 'inventory' or 'ssaw'
    this.currentCategory = null;
    this.currentBrand = null;
    this.currentStyle = null;
    this.cachedStyles = new Map();
    this.cachedVariants = new Map();

    // DOM elements
    this.els = {
      apparelTabs: document.querySelectorAll('.apparel-tab'),
      apparelPanel: document.getElementById('apparelPanel'),
      apparelBrowser: document.getElementById('apparelBrowser'),
      apparelCategories: document.getElementById('apparelCategories'),
      apparelBrands: document.getElementById('apparelBrands'),
      apparelItems: document.getElementById('apparelItems'),
      apparelLoading: document.getElementById('apparelLoading'),

      // Variant modal
      variantModal: document.getElementById('variantModal'),
      variantModalTitle: document.getElementById('variantModalTitle'),
      variantColorGrid: document.getElementById('variantColorGrid'),
      variantSizeGrid: document.getElementById('variantSizeGrid'),
      variantPreviewImg: document.getElementById('variantPreviewImg'),
      variantSelectedInfo: document.getElementById('variantSelectedInfo'),
      variantPrice: document.getElementById('variantPrice'),
      variantConfirmBtn: document.getElementById('variantConfirmBtn')
    };

    this.selectedVariant = null;

    this.init();
  }

  init() {
    // Tab switching
    this.els.apparelTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        this.switchSource(tab.dataset.source);
      });
    });

    // Variant modal events
    if (this.els.variantModal) {
      this.els.variantModal.addEventListener('click', (e) => {
        if (e.target.hasAttribute('data-close') || e.target.closest('[data-close]')) {
          this.closeVariantModal();
        }
      });
    }

    if (this.els.variantConfirmBtn) {
      this.els.variantConfirmBtn.addEventListener('click', () => {
        if (this.selectedVariant) {
          this.onSelectVariant(this.selectedVariant);
          this.closeVariantModal();
        }
      });
    }

    // Initial load
    this.loadCategories();
  }

  switchSource(source) {
    this.currentSource = source;
    this.currentCategory = null;
    this.currentBrand = null;
    this.currentStyle = null;

    // Update tabs
    this.els.apparelTabs.forEach(tab => {
      tab.classList.toggle('apparel-tab--active', tab.dataset.source === source);
    });

    // Reload categories
    this.loadCategories();
  }

  showLoading(show = true) {
    if (this.els.apparelLoading) {
      this.els.apparelLoading.hidden = !show;
    }
  }

  async loadCategories() {
    const categoriesList = this.els.apparelCategories?.querySelector('.apparel-list');
    const brandsList = this.els.apparelBrands?.querySelector('.apparel-list');
    const itemsList = this.els.apparelItems?.querySelector('.apparel-list');

    if (!categoriesList) return;

    // Clear all columns
    categoriesList.innerHTML = '';
    if (brandsList) brandsList.innerHTML = '<div class="apparel-item__meta" style="padding:1rem;text-align:center;">Select a category</div>';
    if (itemsList) itemsList.innerHTML = '<div class="apparel-item__meta" style="padding:1rem;text-align:center;">Select a brand</div>';

    if (this.currentSource === 'inventory') {
      // Load from in-stock apparel
      await this.loadInventoryCategories(categoriesList);
    } else {
      // Load S&S categories
      this.loadSSAWCategories(categoriesList);
    }
  }

  async loadInventoryCategories(container) {
    this.showLoading(true);

    try {
      const res = await fetch('/api/apparel/products');
      const data = await res.json().catch(() => ({}));
      const products = Array.isArray(data?.products) ? data.products : [];

      if (!products.length) {
        container.innerHTML = '<div class="apparel-item__meta" style="padding:1rem;text-align:center;">No in-stock items available</div>';
        this.showLoading(false);
        return;
      }

      // Group by product type
      const byType = new Map();
      products.forEach(p => {
        const type = p.productType || 'Other';
        if (!byType.has(type)) byType.set(type, []);
        byType.get(type).push(p);
      });

      container.innerHTML = '';
      byType.forEach((items, type) => {
        const item = this.createApparelItem({
          name: type,
          meta: `${items.length} item(s)`,
          image: items[0]?.variants?.[0]?.imageUrl
        });

        item.addEventListener('click', () => {
          this.selectCategory(type, items);
          this.highlightItem(container, item);
        });

        container.appendChild(item);
      });

    } catch (err) {
      console.error('Failed to load inventory:', err);
      container.innerHTML = '<div class="apparel-item__meta" style="padding:1rem;text-align:center;color:#ef4444;">Failed to load inventory</div>';
    }

    this.showLoading(false);
  }

  loadSSAWCategories(container) {
    container.innerHTML = '';

    SSAW_CATEGORIES.forEach(cat => {
      const item = this.createApparelItem({
        name: cat.label,
        meta: 'Premium'
      });

      item.addEventListener('click', () => {
        this.selectSSAWCategory(cat);
        this.highlightItem(container, item);
      });

      container.appendChild(item);
    });
  }

  selectCategory(type, items) {
    this.currentCategory = type;
    this.currentBrand = null;

    const brandsList = this.els.apparelBrands?.querySelector('.apparel-list');
    const itemsList = this.els.apparelItems?.querySelector('.apparel-list');

    if (!brandsList) return;

    // For inventory, show items directly (no brand grouping)
    brandsList.innerHTML = '';
    itemsList.innerHTML = '';

    items.forEach(product => {
      const variant = product.variants?.[0];
      const item = this.createApparelItem({
        name: product.title || product.handle,
        meta: variant ? USD.format((variant.price || 0) / 100) : '',
        image: variant?.imageUrl
      });

      item.addEventListener('click', () => {
        this.openVariantModal(product.title, product.variants || []);
      });

      brandsList.appendChild(item);
    });
  }

  async selectSSAWCategory(category) {
    this.currentCategory = category;
    this.currentBrand = null;

    const brandsList = this.els.apparelBrands?.querySelector('.apparel-list');
    const itemsList = this.els.apparelItems?.querySelector('.apparel-list');

    if (!brandsList) return;

    brandsList.innerHTML = '<div class="apparel-item__meta" style="padding:1rem;text-align:center;">Loading brands...</div>';
    itemsList.innerHTML = '<div class="apparel-item__meta" style="padding:1rem;text-align:center;">Select a brand</div>';

    this.showLoading(true);

    try {
      // Fetch styles for this category
      const styles = await this.fetchSSAWStyles(category.query);

      if (!styles.length) {
        brandsList.innerHTML = '<div class="apparel-item__meta" style="padding:1rem;text-align:center;">No styles found</div>';
        this.showLoading(false);
        return;
      }

      // Group by brand
      const byBrand = new Map();
      styles.forEach(s => {
        const brand = s.brandName || 'Other';
        if (!byBrand.has(brand)) byBrand.set(brand, []);
        byBrand.get(brand).push(s);
      });

      // Sort by count
      const sortedBrands = Array.from(byBrand.entries())
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, 20);

      brandsList.innerHTML = '';
      sortedBrands.forEach(([brand, brandStyles]) => {
        const firstStyle = brandStyles.find(s => s.imageUrl);
        const item = this.createApparelItem({
          name: brand,
          meta: `${brandStyles.length} style(s)`,
          image: firstStyle?.imageUrl
        });

        item.addEventListener('click', () => {
          this.selectSSAWBrand(brand, brandStyles);
          this.highlightItem(brandsList, item);
        });

        brandsList.appendChild(item);
      });

    } catch (err) {
      console.error('Failed to load SSAW styles:', err);
      brandsList.innerHTML = '<div class="apparel-item__meta" style="padding:1rem;text-align:center;color:#ef4444;">Failed to load</div>';
    }

    this.showLoading(false);
  }

  selectSSAWBrand(brand, styles) {
    this.currentBrand = brand;

    const itemsList = this.els.apparelItems?.querySelector('.apparel-list');
    if (!itemsList) return;

    itemsList.innerHTML = '';

    styles.slice(0, 30).forEach(style => {
      const item = this.createApparelItem({
        name: `${style.styleName || ''} ${style.title || ''}`.trim() || style.brandName,
        meta: 'Loading price...',
        image: style.imageUrl
      });

      // Store style info
      item.styleData = style;

      item.addEventListener('click', () => {
        this.selectSSAWStyle(style, item);
      });

      itemsList.appendChild(item);

      // Fetch price asynchronously
      this.fetchSSAWProducts(style.styleID).then(variants => {
        if (variants.length) {
          const minPrice = Math.min(...variants.map(v => v.piecePriceCents || Infinity));
          const retailPrice = calculateRetailPrice(minPrice);
          const metaEl = item.querySelector('.apparel-item__meta');
          if (metaEl && retailPrice) {
            metaEl.textContent = `From ${USD.format(retailPrice / 100)}`;
            metaEl.style.color = '#10b981';
          }
          // Cache variants
          this.cachedVariants.set(style.styleID, variants);
        }
      });
    });
  }

  async selectSSAWStyle(style, itemEl) {
    this.currentStyle = style;

    // Get variants (from cache or fetch)
    let variants = this.cachedVariants.get(style.styleID);
    if (!variants) {
      this.showLoading(true);
      variants = await this.fetchSSAWProducts(style.styleID);
      this.cachedVariants.set(style.styleID, variants);
      this.showLoading(false);
    }

    if (variants.length) {
      const styleName = `${style.styleName || ''} ${style.title || ''}`.trim() || style.brandName;
      this.openVariantModal(styleName, variants);
    }
  }

  async fetchSSAWStyles(query) {
    const cacheKey = `styles_${query}`;
    if (this.cachedStyles.has(cacheKey)) {
      return this.cachedStyles.get(cacheKey);
    }

    try {
      const res = await fetch(`/api/vendors/ssaw/styles?q=${encodeURIComponent(query)}`);
      const data = await res.json().catch(() => ({}));
      const styles = Array.isArray(data.styles) ? data.styles : [];
      this.cachedStyles.set(cacheKey, styles);
      return styles;
    } catch (err) {
      console.error('Failed to fetch SSAW styles:', err);
      return [];
    }
  }

  async fetchSSAWProducts(styleID) {
    try {
      const res = await fetch(`/api/vendors/ssaw/products?style=${encodeURIComponent(styleID)}`);
      const data = await res.json().catch(() => ({}));
      return Array.isArray(data.variants) ? data.variants : [];
    } catch (err) {
      console.error('Failed to fetch SSAW products:', err);
      return [];
    }
  }

  createApparelItem({ name, meta, image }) {
    const item = document.createElement('div');
    item.className = 'apparel-item';
    item.innerHTML = `
      ${image ? `<img class="apparel-item__img" src="${image}" alt="${name}" loading="lazy" />` : ''}
      <div class="apparel-item__info">
        <div class="apparel-item__name">${name}</div>
        ${meta ? `<div class="apparel-item__meta">${meta}</div>` : ''}
      </div>
    `;
    return item;
  }

  highlightItem(container, selectedItem) {
    container.querySelectorAll('.apparel-item').forEach(item => {
      item.classList.toggle('selected', item === selectedItem);
    });
  }

  // ========================================
  // VARIANT MODAL
  // ========================================

  openVariantModal(styleName, variants) {
    if (!this.els.variantModal || !variants.length) return;

    this.els.variantModalTitle.textContent = styleName;
    this.selectedVariant = null;
    this.currentVariants = variants;
    this.selectedColor = null;
    this.selectedSize = null;

    // Group variants by color
    const byColor = new Map();
    variants.forEach(v => {
      const color = v.color || 'Default';
      if (!byColor.has(color)) byColor.set(color, []);
      byColor.get(color).push(v);
    });

    // Render color options
    this.els.variantColorGrid.innerHTML = '';
    byColor.forEach((colorVariants, color) => {
      const firstVariant = colorVariants[0];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'variant-color-btn';
      btn.title = color;
      btn.innerHTML = `
        ${firstVariant.imageUrl ? `<img src="${firstVariant.imageUrl}" alt="${color}" />` : ''}
        <div class="variant-color-btn__swatch" style="background:${this.colorNameToHex(color)}"></div>
      `;

      btn.addEventListener('click', () => {
        this.selectColor(color, colorVariants);
        this.els.variantColorGrid.querySelectorAll('.variant-color-btn').forEach(b => {
          b.classList.toggle('selected', b === btn);
        });
      });

      this.els.variantColorGrid.appendChild(btn);
    });

    // Clear size grid
    this.els.variantSizeGrid.innerHTML = '<div style="padding:0.5rem;color:#64748b;font-size:0.75rem;">Select a color first</div>';

    // Reset preview
    this.updateVariantPreview();

    // Disable confirm button
    this.els.variantConfirmBtn.disabled = true;

    // Show modal
    this.els.variantModal.hidden = false;
  }

  selectColor(color, variants) {
    this.selectedColor = color;
    this.selectedSize = null;

    // Update preview image
    const firstVariant = variants[0];
    if (firstVariant?.imageUrl) {
      this.els.variantPreviewImg.src = firstVariant.imageUrl;
    }

    // Update apparel color in editor
    if (firstVariant) {
      const hexColor = this.colorNameToHex(color);
      this.onApparelColorChange(hexColor);
    }

    // Render size options
    this.els.variantSizeGrid.innerHTML = '';

    // Get unique sizes in order
    const sizes = [...new Set(variants.map(v => v.size))].sort((a, b) => {
      const order = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL'];
      const ai = order.indexOf(a);
      const bi = order.indexOf(b);
      if (ai >= 0 && bi >= 0) return ai - bi;
      if (ai >= 0) return -1;
      if (bi >= 0) return 1;
      return a.localeCompare(b);
    });

    sizes.forEach(size => {
      const variant = variants.find(v => v.size === size);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'variant-size-btn';
      btn.textContent = size || 'One Size';

      btn.addEventListener('click', () => {
        this.selectSize(size, variant);
        this.els.variantSizeGrid.querySelectorAll('.variant-size-btn').forEach(b => {
          b.classList.toggle('selected', b === btn);
        });
      });

      this.els.variantSizeGrid.appendChild(btn);
    });

    this.updateVariantPreview();
  }

  selectSize(size, variant) {
    this.selectedSize = size;
    this.selectedVariant = variant;

    // Update preview
    if (variant?.imageUrl) {
      this.els.variantPreviewImg.src = variant.imageUrl;
    }

    this.updateVariantPreview();

    // Enable confirm button
    this.els.variantConfirmBtn.disabled = false;
  }

  updateVariantPreview() {
    const colorText = this.selectedColor || '—';
    const sizeText = this.selectedSize || '—';

    this.els.variantSelectedInfo.textContent = `${colorText} / ${sizeText}`;

    if (this.selectedVariant) {
      const retailCents = calculateRetailPrice(this.selectedVariant.piecePriceCents);
      this.els.variantPrice.textContent = retailCents ? USD.format(retailCents / 100) : '';
    } else {
      this.els.variantPrice.textContent = '';
    }
  }

  closeVariantModal() {
    if (this.els.variantModal) {
      this.els.variantModal.hidden = true;
    }
  }

  // Convert common color names to hex
  colorNameToHex(colorName) {
    const colors = {
      'white': '#ffffff',
      'black': '#000000',
      'navy': '#1e3a5f',
      'navy blue': '#1e3a5f',
      'royal': '#1d4ed8',
      'royal blue': '#1d4ed8',
      'red': '#dc2626',
      'cardinal': '#991b1b',
      'maroon': '#7f1d1d',
      'burgundy': '#7f1d1d',
      'green': '#16a34a',
      'forest': '#166534',
      'forest green': '#166534',
      'kelly green': '#22c55e',
      'hunter green': '#14532d',
      'orange': '#ea580c',
      'gold': '#eab308',
      'yellow': '#facc15',
      'purple': '#7c3aed',
      'pink': '#ec4899',
      'light pink': '#f9a8d4',
      'hot pink': '#db2777',
      'gray': '#6b7280',
      'grey': '#6b7280',
      'charcoal': '#374151',
      'heather gray': '#9ca3af',
      'heather grey': '#9ca3af',
      'silver': '#d1d5db',
      'brown': '#78350f',
      'tan': '#d6b06d',
      'khaki': '#c2b280',
      'cream': '#fef3c7',
      'ivory': '#fffff0',
      'natural': '#f5f5dc',
      'sand': '#c2b280',
      'teal': '#0d9488',
      'turquoise': '#06b6d4',
      'aqua': '#22d3d8',
      'sky blue': '#38bdf8',
      'light blue': '#93c5fd',
      'carolina blue': '#7bafd4',
      'powder blue': '#b0e0e6',
      'indigo': '#4f46e5',
      'violet': '#8b5cf6',
      'lavender': '#c4b5fd',
      'coral': '#f97316',
      'salmon': '#fa8072',
      'lime': '#84cc16',
      'olive': '#84cc16',
      'camo': '#4a5f4e',
      'camouflage': '#4a5f4e',
      'safety green': '#ccff00',
      'safety orange': '#ff6600',
      'neon': '#ccff00'
    };

    const lower = (colorName || '').toLowerCase().trim();

    // Check exact match
    if (colors[lower]) return colors[lower];

    // Check partial match
    for (const [name, hex] of Object.entries(colors)) {
      if (lower.includes(name) || name.includes(lower)) {
        return hex;
      }
    }

    // Default to white
    return '#808080';
  }
}

// Export for use in main module
export { ApparelBrowser };
