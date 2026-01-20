require('dotenv').config();
const { getAsset, putAsset } = require('../integrations/shopify.js');

const THEME_ID = 184076632352;

// Simple sticker template - no color/size options, just quantity with bundle deal messaging
const stickerTemplateContent = `{
  "sections": {
    "main": {
      "type": "main-product",
      "blocks": {
        "title": {
          "type": "title",
          "settings": {}
        },
        "price": {
          "type": "price",
          "settings": {}
        },
        "bundle_deal": {
          "type": "custom_liquid",
          "settings": {
            "custom_liquid": "{% render 'sticker-bundle-deal', product: product %}"
          }
        },
        "quantity_selector": {
          "type": "quantity_selector",
          "settings": {}
        },
        "buy_buttons": {
          "type": "buy_buttons",
          "settings": {
            "show_dynamic_checkout": true,
            "show_gift_card_recipient": false
          }
        },
        "description": {
          "type": "description",
          "settings": {}
        },
        "share": {
          "type": "share",
          "settings": {
            "share_label": "Share"
          }
        }
      },
      "block_order": [
        "title",
        "price",
        "bundle_deal",
        "quantity_selector",
        "buy_buttons",
        "description",
        "share"
      ],
      "settings": {
        "enable_sticky_info": false,
        "color_scheme": "scheme-1",
        "media_size": "large",
        "constrain_to_viewport": false,
        "media_fit": "contain",
        "gallery_layout": "stacked",
        "mobile_thumbnails": "hide",
        "media_position": "left",
        "image_zoom": "lightbox",
        "hide_variants": true,
        "enable_video_looping": false,
        "padding_top": 16,
        "padding_bottom": 0
      }
    },
    "related-products": {
      "type": "related-products",
      "settings": {
        "heading": "More Stickers",
        "heading_size": "h2",
        "products_to_show": 8,
        "columns_desktop": 4,
        "columns_mobile": "2",
        "color_scheme": "scheme-1",
        "image_ratio": "square",
        "image_shape": "default",
        "show_secondary_image": true,
        "show_vendor": false,
        "show_rating": false,
        "padding_top": 8,
        "padding_bottom": 28
      }
    }
  },
  "order": [
    "main",
    "related-products"
  ]
}`;

// Sticker bundle deal snippet - shows the 20 for $10 deal prominently
const stickerBundleDealSnippet = `{% comment %}
  Displays bundle deal messaging for sticker products
  20 stickers for $10 ($0.50 each)
{% endcomment %}

<div class="sticker-bundle-deal" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 1rem 1.5rem; border-radius: 12px; margin: 1rem 0; text-align: center;">
  <div style="font-size: 1.4em; font-weight: bold; margin-bottom: 0.5rem;">
    🎉 Bundle Deal!
  </div>
  <div style="font-size: 1.1em;">
    Get <strong>20 stickers for just $10</strong>
  </div>
  <div style="font-size: 0.9em; opacity: 0.9; margin-top: 0.5rem;">
    Only $0.50 each • Mix and match any designs
  </div>
</div>

<style>
  .sticker-bundle-deal {
    box-shadow: 0 4px 15px rgba(102, 126, 234, 0.3);
    transition: transform 0.2s ease, box-shadow 0.2s ease;
  }
  .sticker-bundle-deal:hover {
    transform: translateY(-2px);
    box-shadow: 0 6px 20px rgba(102, 126, 234, 0.4);
  }
</style>
`;

async function createStickerTemplate() {
  console.log('=== Creating Sticker Product Template ===\n');

  try {
    // 1. Upload the bundle deal snippet
    console.log('Uploading sticker-bundle-deal.liquid snippet...');
    await putAsset(THEME_ID, 'snippets/sticker-bundle-deal.liquid', stickerBundleDealSnippet);
    console.log('✓ sticker-bundle-deal.liquid uploaded');

    // 2. Upload the sticker template
    console.log('Uploading product.sticker.json template...');
    await putAsset(THEME_ID, 'templates/product.sticker.json', stickerTemplateContent);
    console.log('✓ product.sticker.json uploaded');

    // 3. Verify uploads
    console.log('\n=== Verifying Uploads ===');
    const verifySnippet = await getAsset(THEME_ID, 'snippets/sticker-bundle-deal.liquid');
    console.log('Bundle deal snippet exists:', !!verifySnippet?.value);

    const verifyTemplate = await getAsset(THEME_ID, 'templates/product.sticker.json');
    console.log('Sticker template exists:', !!verifyTemplate?.value);

    console.log('\n✓ Sticker product template created successfully!');
    console.log('\nSticker products will now:');
    console.log('- Display the bundle deal banner (20 for $10)');
    console.log('- Show quantity selector only (no size/color options)');
    console.log('- Use the simple sticker template');

  } catch (error) {
    console.error('Error creating sticker template:', error.message || JSON.stringify(error));
    throw error;
  }
}

createStickerTemplate().catch(e => {
  console.error('Failed:', e);
  process.exit(1);
});
