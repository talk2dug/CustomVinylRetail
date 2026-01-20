require('dotenv').config();
const { createProduct, findCustomCollectionByTitle, addProductToCollection, putAsset, getAsset } = require('../integrations/shopify.js');

const THEME_ID = 184076632352;

// Random Pack Products
const randomPacks = [
  {
    title: 'Mystery Sticker Pack - 10 Stickers',
    price: '5.00',
    compareAt: '7.00',
    quantity: 10,
    description: `<p><strong>🎲 Let us surprise you!</strong></p>
<p>Get 10 random stickers from our collection - a fun mix of designs curated just for you!</p>
<ul>
<li>10 high-quality vinyl stickers</li>
<li>Waterproof & weatherproof</li>
<li>Perfect for laptops, water bottles, cars & more</li>
<li>Great gift idea!</li>
</ul>
<p><em>Note: We'll pick a variety of designs - no duplicates!</em></p>`
  },
  {
    title: 'Mystery Sticker Pack - 20 Stickers',
    price: '10.00',
    compareAt: '15.00',
    quantity: 20,
    description: `<p><strong>🎲 Our most popular pack!</strong></p>
<p>Get 20 random stickers from our collection - the perfect mix for sticker lovers!</p>
<ul>
<li>20 high-quality vinyl stickers</li>
<li>Waterproof & weatherproof</li>
<li>Best value - only $0.50 each!</li>
<li>Perfect for laptops, water bottles, cars & more</li>
</ul>
<p><em>Note: We'll pick a variety of designs - no duplicates!</em></p>`
  },
  {
    title: 'Mystery Sticker Pack - 50 Stickers',
    price: '25.00',
    compareAt: '40.00',
    quantity: 50,
    description: `<p><strong>🎲 The Ultimate Sticker Haul!</strong></p>
<p>Get 50 random stickers from our collection - perfect for sharing or covering everything you own!</p>
<ul>
<li>50 high-quality vinyl stickers</li>
<li>Waterproof & weatherproof</li>
<li>Party pack - great for events!</li>
<li>Share with friends or keep them all</li>
</ul>
<p><em>Note: We'll pick an awesome variety - minimal to no duplicates!</em></p>`
  }
];

// Bundle Builder Page Template
const bundleBuilderPageTemplate = `{
  "sections": {
    "main": {
      "type": "custom-liquid",
      "settings": {
        "custom_liquid": "{% render 'sticker-bundle-builder' %}",
        "color_scheme": "",
        "padding_top": 20,
        "padding_bottom": 36
      }
    }
  },
  "order": ["main"]
}`;

// Bundle Builder Snippet - the actual interactive component
const bundleBuilderSnippet = `{% comment %}
  Sticker Bundle Builder - Let customers pick their own stickers
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
  .bundle-options {
    display: flex;
    gap: 20px;
    margin-bottom: 30px;
    flex-wrap: wrap;
  }
  .bundle-option-card {
    flex: 1;
    min-width: 280px;
    border: 2px solid #eee;
    border-radius: 12px;
    padding: 20px;
    text-align: center;
  }
  .bundle-option-card h3 {
    margin-bottom: 10px;
  }
  .random-btn {
    background: #ff6b6b;
    color: white;
    border: none;
    padding: 12px 25px;
    border-radius: 8px;
    cursor: pointer;
    font-size: 1em;
    margin-top: 10px;
  }
  .random-btn:hover {
    background: #ee5a5a;
  }
  .clear-btn {
    background: #999;
    color: white;
    border: none;
    padding: 8px 20px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.9em;
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
    <h1>🎨 Build Your Sticker Pack</h1>
    <p>Pick your favorites and save! The more you add, the more you save.</p>
  </div>

  <div class="bundle-tiers">
    <button class="tier-btn" data-count="10" data-price="500">
      <div class="price">10 for $5</div>
      <div class="per-sticker">$0.50 each</div>
    </button>
    <button class="tier-btn active" data-count="20" data-price="1000">
      <div class="price">20 for $10 ⭐</div>
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
        <button class="clear-btn" onclick="clearSelection()">Clear All</button>
        <button class="random-btn" onclick="selectRandom()" style="margin-left:10px;">🎲 Random Fill</button>
      </div>
      <button class="add-to-cart-btn" id="addToCartBtn" disabled onclick="addBundleToCart()">
        Select <span id="remainingCount">20</span> more stickers
      </button>
    </div>
  </div>

  <div class="sticker-grid" id="stickerGrid">
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
  </div>
</div>

<script>
  let selectedStickers = new Set();
  let targetCount = 20;
  let bundlePrice = 1000; // cents

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
        // Flash the progress bar to indicate limit reached
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

      // If we have more selected than new target, trim selection
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

    // Add all selected stickers to cart
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
        // Redirect to cart or show success
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

  // Initialize
  updateProgress();
</script>
`;

// Updated collection template with links to both options
const stickerCollectionBannerUpdated = `{% comment %}
  Banner for sticker collection pages showing bundle options
{% endcomment %}

<div class="sticker-collection-banner" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 2rem; text-align: center; margin-bottom: 2rem;">
  <div style="max-width: 900px; margin: 0 auto;">
    <h1 style="font-size: 2.2em; margin: 0 0 0.5rem 0; font-weight: bold;">
      🎨 Sticker Packs
    </h1>
    <p style="font-size: 1.2em; margin: 0 0 1.5rem 0; opacity: 0.95;">
      Mix & Match or Let Us Surprise You!
    </p>

    <div style="display: flex; justify-content: center; gap: 20px; flex-wrap: wrap; margin-bottom: 1.5rem;">
      <a href="/pages/sticker-bundle-builder" style="background: white; color: #667eea; padding: 15px 30px; border-radius: 10px; text-decoration: none; font-weight: bold; font-size: 1.1em; transition: transform 0.2s;">
        🎨 Build Your Own Pack
      </a>
      <a href="#mystery-packs" style="background: rgba(255,255,255,0.2); color: white; padding: 15px 30px; border-radius: 10px; text-decoration: none; font-weight: bold; font-size: 1.1em; border: 2px solid white;">
        🎲 Mystery Packs
      </a>
    </div>

    <div style="display: flex; justify-content: center; gap: 1rem; flex-wrap: wrap;">
      <div style="background: rgba(255,255,255,0.2); padding: 0.8rem 1.2rem; border-radius: 10px;">
        <div style="font-size: 1.4em; font-weight: bold;">10 for $5</div>
      </div>
      <div style="background: rgba(255,255,255,0.3); padding: 0.8rem 1.2rem; border-radius: 10px; transform: scale(1.05);">
        <div style="font-size: 1.4em; font-weight: bold;">20 for $10 ⭐</div>
      </div>
      <div style="background: rgba(255,255,255,0.2); padding: 0.8rem 1.2rem; border-radius: 10px;">
        <div style="font-size: 1.4em; font-weight: bold;">50 for $25</div>
      </div>
    </div>
  </div>
</div>

<style>
  .sticker-collection-banner a:hover {
    transform: translateY(-2px);
  }
</style>
`;

async function setupStickerBundles() {
  console.log('=== Setting Up Sticker Bundle System ===\n');

  try {
    // 1. Find Stickers collection
    console.log('1. Finding Stickers collection...');
    const stickersCollection = await findCustomCollectionByTitle('Stickers');
    if (!stickersCollection) {
      throw new Error('Stickers collection not found! Run setup-stickers-category.js first.');
    }
    console.log('   Found collection ID:', stickersCollection.id);

    // 2. Create Mystery Pack products
    console.log('\n2. Creating Mystery Pack products...');
    for (const pack of randomPacks) {
      console.log(`   Creating: ${pack.title}...`);
      try {
        const product = await createProduct({
          title: pack.title,
          body_html: pack.description,
          vendor: 'Blue Ridge Custom Co',
          product_type: 'Sticker Pack',
          tags: ['sticker-pack', 'mystery-pack', 'bundle', `pack-${pack.quantity}`],
          variants: [{
            price: pack.price,
            compare_at_price: pack.compareAt,
            inventory_management: null,
            inventory_policy: 'continue'
          }],
          status: 'active'
        });
        console.log(`   ✓ Created: ${product.id}`);

        // Add to Stickers collection
        await addProductToCollection(product.id, stickersCollection.id);
        console.log(`   ✓ Added to Stickers collection`);
      } catch (err) {
        if (err.message && err.message.includes('already exists')) {
          console.log(`   ⚠ Already exists, skipping`);
        } else {
          console.log(`   ✗ Error: ${err.message}`);
        }
      }
    }

    // 3. Upload bundle builder snippet
    console.log('\n3. Uploading sticker-bundle-builder.liquid snippet...');
    await putAsset(THEME_ID, 'snippets/sticker-bundle-builder.liquid', bundleBuilderSnippet);
    console.log('   ✓ Uploaded');

    // 4. Create bundle builder page template
    console.log('\n4. Creating page.sticker-bundle-builder.json template...');
    await putAsset(THEME_ID, 'templates/page.sticker-bundle-builder.json', bundleBuilderPageTemplate);
    console.log('   ✓ Uploaded');

    // 5. Update collection banner
    console.log('\n5. Updating sticker-collection-banner.liquid...');
    await putAsset(THEME_ID, 'snippets/sticker-collection-banner.liquid', stickerCollectionBannerUpdated);
    console.log('   ✓ Uploaded');

    // 6. Verify
    console.log('\n=== Verifying ===');
    const verifySnippet = await getAsset(THEME_ID, 'snippets/sticker-bundle-builder.liquid');
    console.log('Bundle builder snippet:', verifySnippet?.value ? '✓' : '✗');

    const verifyTemplate = await getAsset(THEME_ID, 'templates/page.sticker-bundle-builder.json');
    console.log('Page template:', verifyTemplate?.value ? '✓' : '✗');

    console.log('\n=== Setup Complete! ===');
    console.log('\nNext steps:');
    console.log('1. Go to Shopify Admin > Online Store > Pages');
    console.log('2. Create a new page called "Sticker Bundle Builder"');
    console.log('3. Set the template to "page.sticker-bundle-builder"');
    console.log('4. The Mystery Pack products are now in your Stickers collection');
    console.log('\nNote: You may need to set up a Shopify Script or discount for the bundle pricing');

  } catch (error) {
    console.error('Error:', error.message);
    throw error;
  }
}

setupStickerBundles().catch(e => {
  console.error('Failed:', e);
  process.exit(1);
});
