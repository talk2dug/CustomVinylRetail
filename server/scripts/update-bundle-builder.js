require('dotenv').config();
const { putAsset } = require('../integrations/shopify.js');

const THEME_ID = 184076632352;

const bundleBuilderSnippet = `{% comment %}
  Sticker Bundle Builder - Let customers pick their own stickers
  Updated to show ALL stickers with pagination (up to 250)
{% endcomment %}

<style>
  .bundle-builder {
    max-width: 1400px;
    margin: 0 auto;
    padding: 0 20px;
  }
  .bundle-header {
    text-align: center;
    margin-bottom: 30px;
  }
  .bundle-header h1 {
    font-size: 2.5em;
    margin-bottom: 10px;
  }
  .bundle-tiers {
    display: flex;
    justify-content: center;
    gap: 15px;
    margin-bottom: 30px;
    flex-wrap: wrap;
  }
  .tier-btn {
    padding: 15px 30px;
    border: 2px solid #667eea;
    background: white;
    border-radius: 10px;
    cursor: pointer;
    transition: all 0.2s;
    font-size: 1.1em;
  }
  .tier-btn:hover {
    background: #f0f0ff;
  }
  .tier-btn.active {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    border-color: transparent;
  }
  .tier-btn .price {
    font-weight: bold;
    font-size: 1.2em;
  }
  .tier-btn .per-sticker {
    font-size: 0.8em;
    opacity: 0.8;
  }
  .bundle-progress {
    background: #f5f5f5;
    border-radius: 10px;
    padding: 20px;
    margin-bottom: 30px;
    position: sticky;
    top: 10px;
    z-index: 100;
    box-shadow: 0 2px 10px rgba(0,0,0,0.1);
  }
  .progress-bar-container {
    background: #ddd;
    border-radius: 20px;
    height: 30px;
    overflow: hidden;
    margin-bottom: 15px;
  }
  .progress-bar {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    height: 100%;
    transition: width 0.3s ease;
    display: flex;
    align-items: center;
    justify-content: center;
    color: white;
    font-weight: bold;
  }
  .progress-info {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
  }
  .selected-count {
    font-size: 1.2em;
  }
  .add-to-cart-btn {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    border: none;
    padding: 15px 40px;
    border-radius: 8px;
    font-size: 1.1em;
    cursor: pointer;
    transition: transform 0.2s, box-shadow 0.2s;
  }
  .add-to-cart-btn:hover:not(:disabled) {
    transform: translateY(-2px);
    box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
  }
  .add-to-cart-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .sticker-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 20px;
  }
  .sticker-card {
    border: 2px solid #eee;
    border-radius: 12px;
    overflow: hidden;
    cursor: pointer;
    transition: all 0.2s;
    position: relative;
  }
  .sticker-card:hover {
    border-color: #667eea;
    transform: translateY(-3px);
    box-shadow: 0 4px 15px rgba(0,0,0,0.1);
  }
  .sticker-card.selected {
    border-color: #667eea;
    background: #f0f0ff;
  }
  .sticker-card.selected::after {
    content: '✓';
    position: absolute;
    top: 10px;
    right: 10px;
    background: #667eea;
    color: white;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: bold;
  }
  .sticker-card img {
    width: 100%;
    aspect-ratio: 1;
    object-fit: cover;
  }
  .sticker-card .sticker-title {
    padding: 10px;
    font-size: 0.9em;
    text-align: center;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sticker-count-info {
    text-align: center;
    color: #666;
    margin-bottom: 20px;
    font-size: 1.1em;
  }
  @media (max-width: 600px) {
    .sticker-grid {
      grid-template-columns: repeat(2, 1fr);
      gap: 10px;
    }
    .tier-btn {
      padding: 10px 20px;
    }
  }
</style>

<div class="bundle-builder">
  <div class="bundle-header">
    <h1>Build Your Sticker Pack</h1>
    <p>Pick your favorites and save! The more you add, the more you save.</p>
  </div>

  <div class="bundle-tiers">
    <button class="tier-btn" data-count="10" data-price="500">
      <div class="price">10 for $5</div>
      <div class="per-sticker">$0.50 each</div>
    </button>
    <button class="tier-btn active" data-count="20" data-price="1000">
      <div class="price">20 for $10</div>
      <div class="per-sticker">Best Value!</div>
    </button>
    <button class="tier-btn" data-count="50" data-price="2500">
      <div class="price">50 for $25</div>
      <div class="per-sticker">Party Pack!</div>
    </button>
  </div>

  <div class="bundle-progress">
    <div class="progress-bar-container">
      <div class="progress-bar" id="progressBar" style="width: 0%">
        <span id="progressText">0 / 20</span>
      </div>
    </div>
    <div class="progress-info">
      <div>
        <span class="selected-count"><span id="selectedCount">0</span> stickers selected</span>
        <button class="clear-btn" onclick="clearSelection()" style="background:#999;color:white;border:none;padding:8px 20px;border-radius:6px;cursor:pointer;margin-left:10px;">Clear All</button>
        <button onclick="selectRandom()" style="background:#ff6b6b;color:white;border:none;padding:8px 20px;border-radius:8px;cursor:pointer;margin-left:10px;">Random Fill</button>
      </div>
      <button class="add-to-cart-btn" id="addToCartBtn" disabled onclick="addBundleToCart()">
        Select <span id="remainingCount">20</span> more stickers
      </button>
    </div>
  </div>

  <div class="sticker-count-info">
    {% assign sticker_count = 0 %}
    {% for product in collections['stickers'].products limit: 250 %}
      {% unless product.title contains 'Mystery' or product.title contains 'Bundle' %}
        {% assign sticker_count = sticker_count | plus: 1 %}
      {% endunless %}
    {% endfor %}
    {{ sticker_count }} stickers available to choose from
  </div>

  <div class="sticker-grid" id="stickerGrid">
    {% paginate collections['stickers'].products by 250 %}
      {% for product in collections['stickers'].products %}
        {% unless product.title contains 'Mystery' or product.title contains 'Bundle' %}
          <div class="sticker-card"
               data-variant-id="{{ product.variants.first.id }}"
               data-product-id="{{ product.id }}"
               data-title="{{ product.title | escape }}"
               onclick="toggleSticker(this)">
            <img src="{{ product.featured_image | image_url: width: 300 }}" alt="{{ product.title | escape }}" loading="lazy">
            <div class="sticker-title">{{ product.title | truncate: 30 }}</div>
          </div>
        {% endunless %}
      {% endfor %}
    {% endpaginate %}
  </div>
</div>

<script>
  let selectedStickers = new Set();
  let targetCount = 20;
  let bundlePrice = 1000;

  function updateProgress() {
    const count = selectedStickers.size;
    const percent = Math.min((count / targetCount) * 100, 100);

    document.getElementById('progressBar').style.width = percent + '%';
    document.getElementById('progressText').textContent = count + ' / ' + targetCount;
    document.getElementById('selectedCount').textContent = count;

    const btn = document.getElementById('addToCartBtn');
    const remaining = targetCount - count;

    if (count >= targetCount) {
      btn.disabled = false;
      btn.textContent = 'Add Bundle to Cart - $' + (bundlePrice / 100).toFixed(2);
    } else {
      btn.disabled = true;
      btn.textContent = 'Select ' + remaining + ' more sticker' + (remaining === 1 ? '' : 's');
    }
  }

  function toggleSticker(card) {
    const variantId = card.dataset.variantId;

    if (selectedStickers.has(variantId)) {
      selectedStickers.delete(variantId);
      card.classList.remove('selected');
    } else {
      if (selectedStickers.size < targetCount) {
        selectedStickers.add(variantId);
        card.classList.add('selected');
      } else {
        const bar = document.getElementById('progressBar');
        bar.style.background = '#ff6b6b';
        setTimeout(() => {
          bar.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
        }, 300);
      }
    }
    updateProgress();
  }

  function clearSelection() {
    selectedStickers.clear();
    document.querySelectorAll('.sticker-card.selected').forEach(card => {
      card.classList.remove('selected');
    });
    updateProgress();
  }

  function selectRandom() {
    clearSelection();
    const cards = Array.from(document.querySelectorAll('.sticker-card'));
    const shuffled = cards.sort(() => Math.random() - 0.5);

    for (let i = 0; i < Math.min(targetCount, shuffled.length); i++) {
      const card = shuffled[i];
      selectedStickers.add(card.dataset.variantId);
      card.classList.add('selected');
    }
    updateProgress();
  }

  document.querySelectorAll('.tier-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.tier-btn').forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      targetCount = parseInt(this.dataset.count);
      bundlePrice = parseInt(this.dataset.price);

      if (selectedStickers.size > targetCount) {
        const arr = Array.from(selectedStickers);
        selectedStickers = new Set(arr.slice(0, targetCount));
        document.querySelectorAll('.sticker-card').forEach(card => {
          if (!selectedStickers.has(card.dataset.variantId)) {
            card.classList.remove('selected');
          }
        });
      }
      updateProgress();
    });
  });

  async function addBundleToCart() {
    if (selectedStickers.size < targetCount) return;

    const btn = document.getElementById('addToCartBtn');
    btn.disabled = true;
    btn.textContent = 'Adding to cart...';

    const items = Array.from(selectedStickers).map(variantId => ({
      id: parseInt(variantId),
      quantity: 1,
      properties: {
        '_bundle': 'sticker-pack-' + targetCount,
        '_bundle_price': bundlePrice
      }
    }));

    try {
      const response = await fetch('/cart/add.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items })
      });

      if (response.ok) {
        window.location.href = '/cart';
      } else {
        throw new Error('Failed to add to cart');
      }
    } catch (err) {
      alert('Error adding to cart. Please try again.');
      btn.disabled = false;
      updateProgress();
    }
  }

  updateProgress();
</script>
`;

async function updateSnippet() {
  console.log('Updating sticker-bundle-builder.liquid snippet...');
  console.log('Theme ID:', THEME_ID);

  try {
    await putAsset(THEME_ID, 'snippets/sticker-bundle-builder.liquid', bundleBuilderSnippet);
    console.log('✓ Successfully updated snippet!');
    console.log('\nThe bundle builder page should now show all stickers (up to 250).');
  } catch (error) {
    console.error('Error:', error.message);
    throw error;
  }
}

updateSnippet().catch(e => {
  console.error('Failed:', e);
  process.exit(1);
});
