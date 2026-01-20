require('dotenv').config();
const { getAsset, putAsset, createCustomCollection, findCustomCollectionByTitle, updateCustomCollection } = require('../integrations/shopify.js');

const THEME_ID = 184076632352;

// Collection template for stickers - shows bundle deal banner at the top
const stickerCollectionTemplate = `{
  "sections": {
    "banner": {
      "type": "custom-liquid",
      "settings": {
        "custom_liquid": "{% render 'sticker-collection-banner' %}",
        "color_scheme": "",
        "padding_top": 0,
        "padding_bottom": 0
      }
    },
    "main-collection-product-grid": {
      "type": "main-collection-product-grid",
      "settings": {
        "products_per_page": 24,
        "columns_desktop": 4,
        "columns_mobile": "2",
        "color_scheme": "scheme-1",
        "image_ratio": "square",
        "image_shape": "default",
        "show_secondary_image": true,
        "show_vendor": false,
        "show_rating": false,
        "enable_quick_add": true,
        "enable_filtering": false,
        "enable_sorting": true,
        "padding_top": 16,
        "padding_bottom": 36
      }
    }
  },
  "order": [
    "banner",
    "main-collection-product-grid"
  ]
}`;

// Banner snippet for sticker collection page
const stickerCollectionBanner = `{% comment %}
  Banner for sticker collection pages showing the bundle deal
{% endcomment %}

<div class="sticker-collection-banner" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 2rem; text-align: center; margin-bottom: 2rem;">
  <div style="max-width: 800px; margin: 0 auto;">
    <h1 style="font-size: 2.5em; margin: 0 0 0.5rem 0; font-weight: bold;">
      🎉 Sticker Packs
    </h1>
    <p style="font-size: 1.3em; margin: 0 0 1rem 0; opacity: 0.95;">
      Mix & Match Any Designs!
    </p>
    <div style="display: flex; justify-content: center; gap: 1rem; flex-wrap: wrap;">
      <div style="background: rgba(255,255,255,0.2); padding: 1rem 1.5rem; border-radius: 10px;">
        <div style="font-size: 1.8em; font-weight: bold;">10 for $5</div>
        <div style="font-size: 0.9em; opacity: 0.9;">$0.50 each</div>
      </div>
      <div style="background: rgba(255,255,255,0.3); padding: 1rem 1.5rem; border-radius: 10px; transform: scale(1.05);">
        <div style="font-size: 1.8em; font-weight: bold;">20 for $10</div>
        <div style="font-size: 0.9em; opacity: 0.9;">Best Deal!</div>
      </div>
      <div style="background: rgba(255,255,255,0.2); padding: 1rem 1.5rem; border-radius: 10px;">
        <div style="font-size: 1.8em; font-weight: bold;">50 for $25</div>
        <div style="font-size: 0.9em; opacity: 0.9;">Party Pack</div>
      </div>
    </div>
    <p style="margin-top: 1.5rem; font-size: 1em; opacity: 0.85;">
      Add any stickers to your cart - they're all the same price!
    </p>
  </div>
</div>

<style>
  .sticker-collection-banner {
    box-shadow: 0 4px 20px rgba(102, 126, 234, 0.3);
  }
</style>
`;

// Updated sticker bundle deal snippet for product pages with quick add buttons
const stickerBundleDealSnippet = `{% comment %}
  Displays bundle deal messaging for sticker products with quick quantity buttons
  20 stickers for $10 ($0.50 each)
{% endcomment %}

<div class="sticker-bundle-deal" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 1.25rem 1.5rem; border-radius: 12px; margin: 1rem 0; text-align: center;">
  <div style="font-size: 1.3em; font-weight: bold; margin-bottom: 0.75rem;">
    🎉 Bundle & Save!
  </div>
  <div style="display: flex; justify-content: center; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.75rem;">
    <button type="button" class="sticker-qty-btn" data-qty="10" style="background: rgba(255,255,255,0.2); border: 2px solid rgba(255,255,255,0.5); color: white; padding: 0.5rem 1rem; border-radius: 8px; cursor: pointer; font-weight: bold; transition: all 0.2s;">
      10 = $5
    </button>
    <button type="button" class="sticker-qty-btn" data-qty="20" style="background: rgba(255,255,255,0.35); border: 2px solid white; color: white; padding: 0.5rem 1rem; border-radius: 8px; cursor: pointer; font-weight: bold; transition: all 0.2s;">
      20 = $10 ⭐
    </button>
    <button type="button" class="sticker-qty-btn" data-qty="50" style="background: rgba(255,255,255,0.2); border: 2px solid rgba(255,255,255,0.5); color: white; padding: 0.5rem 1rem; border-radius: 8px; cursor: pointer; font-weight: bold; transition: all 0.2s;">
      50 = $25
    </button>
  </div>
  <div style="font-size: 0.85em; opacity: 0.9;">
    Click a bundle or enter any quantity below • Only $0.50 each
  </div>
</div>

<script>
  document.addEventListener('DOMContentLoaded', function() {
    const qtyBtns = document.querySelectorAll('.sticker-qty-btn');
    qtyBtns.forEach(btn => {
      btn.addEventListener('click', function() {
        const qty = this.getAttribute('data-qty');
        const qtyInput = document.querySelector('input[name="quantity"]');
        if (qtyInput) {
          qtyInput.value = qty;
          // Trigger change event for any listeners
          qtyInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
      btn.addEventListener('mouseenter', function() {
        this.style.transform = 'scale(1.05)';
        this.style.background = 'rgba(255,255,255,0.4)';
      });
      btn.addEventListener('mouseleave', function() {
        this.style.transform = 'scale(1)';
        this.style.background = this.getAttribute('data-qty') === '20' ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.2)';
      });
    });
  });
</script>

<style>
  .sticker-bundle-deal {
    box-shadow: 0 4px 15px rgba(102, 126, 234, 0.3);
  }
  .sticker-qty-btn:hover {
    transform: scale(1.05);
  }
</style>
`;

async function setupStickersCategory() {
  console.log('=== Setting Up Stickers Category ===\n');

  try {
    // 1. Create or find the Stickers collection
    console.log('1. Creating/finding Stickers collection...');
    let collection = await findCustomCollectionByTitle('Stickers');

    if (collection) {
      console.log('   Found existing collection:', collection.id);
      // Update to use stickers template
      await updateCustomCollection(collection.id, { template_suffix: 'stickers' });
      console.log('   Updated template_suffix to "stickers"');
    } else {
      collection = await createCustomCollection('Stickers', {
        template_suffix: 'stickers',
        body_html: '<p>Mix and match stickers! 20 for $10 - only $0.50 each!</p>'
      });
      console.log('   Created new collection:', collection.id);
    }

    // 2. Upload the collection banner snippet
    console.log('\n2. Uploading sticker-collection-banner.liquid...');
    await putAsset(THEME_ID, 'snippets/sticker-collection-banner.liquid', stickerCollectionBanner);
    console.log('   ✓ Uploaded');

    // 3. Upload the stickers collection template
    console.log('\n3. Uploading collection.stickers.json template...');
    await putAsset(THEME_ID, 'templates/collection.stickers.json', stickerCollectionTemplate);
    console.log('   ✓ Uploaded');

    // 4. Update the sticker bundle deal snippet with quick quantity buttons
    console.log('\n4. Updating sticker-bundle-deal.liquid with quick add buttons...');
    await putAsset(THEME_ID, 'snippets/sticker-bundle-deal.liquid', stickerBundleDealSnippet);
    console.log('   ✓ Uploaded');

    // 5. Verify all uploads
    console.log('\n=== Verifying Uploads ===');
    const verifyBanner = await getAsset(THEME_ID, 'snippets/sticker-collection-banner.liquid');
    console.log('Collection banner snippet:', verifyBanner?.value ? '✓' : '✗');

    const verifyCollTemplate = await getAsset(THEME_ID, 'templates/collection.stickers.json');
    console.log('Collection template:', verifyCollTemplate?.value ? '✓' : '✗');

    const verifyBundleDeal = await getAsset(THEME_ID, 'snippets/sticker-bundle-deal.liquid');
    console.log('Bundle deal snippet:', verifyBundleDeal?.value ? '✓' : '✗');

    console.log('\n=== Setup Complete! ===');
    console.log('\nStickers Collection:');
    console.log('  - ID:', collection.id);
    console.log('  - Handle:', collection.handle || 'stickers');
    console.log('  - Template: collection.stickers');
    console.log('\nProduct Template: product.sticker');
    console.log('\nFeatures:');
    console.log('  - Collection page shows bundle deal banner');
    console.log('  - Product page has quick quantity buttons (10, 20, 50)');
    console.log('  - $0.50 per sticker pricing');

  } catch (error) {
    console.error('Error:', error.message || JSON.stringify(error));
    throw error;
  }
}

setupStickersCategory().catch(e => {
  console.error('Failed:', e);
  process.exit(1);
});
