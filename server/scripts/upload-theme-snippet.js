require('dotenv').config();
const { putAsset, getAsset } = require('../integrations/shopify.js');

const THEME_ID = 184076632352;

const snippetContent = `{% comment %}
  Renders a vinyl color selector for decal/sticker products
  Uses the custom.available_colors metafield to populate options
{% endcomment %}

{%- assign available_colors = product.metafields.custom.available_colors | default: '' -%}
{%- if available_colors != blank -%}
  {%- assign color_list = available_colors | split: ', ' -%}
  <div class="product-form__input product-form__input--color-selector" style="margin-bottom: 1.5rem;">
    <label class="form__label" for="vinyl-color-{{ product.id }}" style="display: block; margin-bottom: 0.5rem; font-weight: 500;">
      Vinyl Color <span style="color: #c00;">*</span>
    </label>
    <div class="select" style="position: relative;">
      <select
        id="vinyl-color-{{ product.id }}"
        name="properties[Vinyl Color]"
        class="select__select"
        required
        style="width: 100%; padding: 12px 40px 12px 12px; border: 1px solid #ccc; border-radius: 4px; appearance: none; background: #fff; font-size: 14px;"
      >
        <option value="">-- Select a Color --</option>
        {%- for color in color_list -%}
          <option value="{{ color }}">{{ color }}</option>
        {%- endfor -%}
      </select>
      <svg aria-hidden="true" focusable="false" style="position: absolute; right: 12px; top: 50%; transform: translateY(-50%); pointer-events: none; width: 12px; height: 12px;" viewBox="0 0 10 6">
        <path fill-rule="evenodd" clip-rule="evenodd" d="M9.354.646a.5.5 0 00-.708 0L5 4.293 1.354.646a.5.5 0 00-.708.708l4 4a.5.5 0 00.708 0l4-4a.5.5 0 000-.708z" fill="currentColor"></path>
      </svg>
    </div>
    <p style="font-size: 0.85em; color: #666; margin-top: 0.5rem;">
      Please select your preferred vinyl color for this decal.
    </p>
  </div>
{%- endif -%}
`;

// Updated product.decal.json template with color selector block
const decalTemplateContent = `{
  "sections": {
    "custom_liquid_hEPkyw": {
      "type": "custom-liquid",
      "name": "t:sections.custom-liquid.presets.name",
      "settings": {
        "custom_liquid": "{% render 'dynamic-mockup' %}",
        "color_scheme": "",
        "padding_top": 40,
        "padding_bottom": 52
      }
    },
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
        "variant_picker": {
          "type": "variant_picker",
          "settings": {
            "picker_type": "dropdown",
            "swatch_shape": "circle"
          }
        },
        "vinyl_color_selector": {
          "type": "custom_liquid",
          "settings": {
            "custom_liquid": "{% render 'vinyl-color-selector', product: product %}"
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
            "show_gift_card_recipient": true
          }
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
        "variant_picker",
        "vinyl_color_selector",
        "quantity_selector",
        "buy_buttons",
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
        "heading": "Related products",
        "heading_size": "h2",
        "products_to_show": 4,
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
    "custom_liquid_hEPkyw",
    "main",
    "related-products"
  ]
}`;

async function uploadThemeAssets() {
  console.log('=== Uploading Vinyl Color Selector Snippet ===');

  try {
    // Upload the snippet
    const snippetResult = await putAsset(THEME_ID, 'snippets/vinyl-color-selector.liquid', snippetContent);
    console.log('✓ Snippet uploaded successfully');
    console.log('  Key:', snippetResult?.asset?.key);

    // Update the decal template
    console.log('\n=== Updating product.decal.json Template ===');
    const templateResult = await putAsset(THEME_ID, 'templates/product.decal.json', decalTemplateContent);
    console.log('✓ Template updated successfully');
    console.log('  Key:', templateResult?.asset?.key);

    // Verify both uploads
    console.log('\n=== Verifying Uploads ===');
    const verifySnippet = await getAsset(THEME_ID, 'snippets/vinyl-color-selector.liquid');
    console.log('Snippet exists:', !!verifySnippet?.value);

    const verifyTemplate = await getAsset(THEME_ID, 'templates/product.decal.json');
    const templateParsed = JSON.parse(verifyTemplate?.value || '{}');
    const hasColorSelector = templateParsed?.sections?.main?.blocks?.vinyl_color_selector;
    console.log('Template has color selector block:', !!hasColorSelector);

    console.log('\n✓ All uploads complete!');
    console.log('\nNext steps:');
    console.log('1. Go to Shopify Admin > Online Store > Themes');
    console.log('2. Assign the "product.decal" template to your decal products');
    console.log('3. The color selector will appear automatically for products with the available_colors metafield');

  } catch (error) {
    console.error('Error uploading assets:', error.message);
    console.error(error);
  }
}

uploadThemeAssets();
