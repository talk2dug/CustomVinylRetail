#!/usr/bin/env node
/**
 * Upload Campaign theme files to Shopify
 * Uploads campaign product grid section, card snippet, and CSS
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const shopify = require('../integrations/shopify');

const THEME_ID = 184076632352; // Spotlight theme (main)

async function uploadAsset(key, content) {
  console.log(`Uploading ${key}...`);
  try {
    await shopify.putAsset(THEME_ID, key, content);
    console.log(`  ✓ ${key} uploaded successfully`);
    return true;
  } catch (e) {
    const errorMsg = e.detail ? JSON.stringify(e.detail, null, 2) : e.message;
    console.error(`  ✗ Failed to upload ${key}:`, errorMsg);
    return false;
  }
}

async function main() {
  console.log('='.repeat(50));
  console.log('Uploading Campaign Theme Files to Shopify');
  console.log('='.repeat(50));
  console.log();

  if (!shopify.isConfigured()) {
    console.error('Error: Shopify is not configured. Check your .env file.');
    process.exit(1);
  }

  const baseDir = path.join(__dirname, '..', '..', 'shopify-theme');
  const results = { success: 0, failed: 0 };

  // Files to upload
  const files = [
    { path: 'sections/campaign-product-grid.liquid', key: 'sections/campaign-product-grid.liquid' },
    { path: 'snippets/campaign-product-card.liquid', key: 'snippets/campaign-product-card.liquid' },
    { path: 'assets/campaign-grid.css', key: 'assets/campaign-grid.css' }
  ];

  for (const file of files) {
    const filePath = path.join(baseDir, file.path);

    if (!fs.existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      results.failed++;
      continue;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const success = await uploadAsset(file.key, content);

    if (success) {
      results.success++;
    } else {
      results.failed++;
    }
  }

  // Now update the collection.campaign.json template to use our new grid
  console.log();
  console.log('Updating collection.campaign.json template...');

  const campaignTemplate = {
    "sections": {
      "campaign_hero": {
        "type": "campaign-hero",
        "settings": {
          "show_badge": true,
          "badge_text": "Limited Collection",
          "cta_text": "Shop Collection",
          "countdown_text": "Offer ends in:"
        }
      },
      "campaign_benefits": {
        "type": "campaign-benefits",
        "settings": {
          "heading": "Why Choose Us",
          "color_scheme": "background-2"
        }
      },
      "main": {
        "type": "campaign-product-grid",
        "settings": {
          "show_header": false,
          "products_per_page": 16,
          "show_count": false,
          "background_color": "#fafafa"
        }
      },
      "campaign_trust": {
        "type": "campaign-trust",
        "blocks": {
          "trust_1": {
            "type": "badge",
            "settings": {
              "icon": "shipping",
              "title": "Free Shipping",
              "description": "On orders over $50"
            }
          },
          "trust_2": {
            "type": "badge",
            "settings": {
              "icon": "quality",
              "title": "Quality Guaranteed",
              "description": "Premium materials"
            }
          },
          "trust_3": {
            "type": "badge",
            "settings": {
              "icon": "secure",
              "title": "Secure Checkout",
              "description": "SSL encrypted"
            }
          },
          "trust_4": {
            "type": "badge",
            "settings": {
              "icon": "returns",
              "title": "Easy Returns",
              "description": "30-day guarantee"
            }
          }
        },
        "block_order": [
          "trust_1",
          "trust_2",
          "trust_3",
          "trust_4"
        ],
        "settings": {
          "color_scheme": "background-2"
        }
      }
    },
    "order": [
      "campaign_hero",
      "campaign_benefits",
      "main",
      "campaign_trust"
    ]
  };

  const templateSuccess = await uploadAsset(
    'templates/collection.campaign.json',
    JSON.stringify(campaignTemplate, null, 2)
  );

  if (templateSuccess) {
    results.success++;
  } else {
    results.failed++;
  }

  console.log();
  console.log('='.repeat(50));
  console.log(`Results: ${results.success} succeeded, ${results.failed} failed`);
  console.log('='.repeat(50));

  if (results.success > 0) {
    console.log();
    console.log('Campaign template updated!');
    console.log('');
    console.log('Features:');
    console.log('  • Artwork shown by default');
    console.log('  • Mockup revealed on hover');
    console.log('  • Modern card design with animations');
    console.log('  • Quick add to cart functionality');
    console.log('  • Sale badges with savings percentage');
    console.log('  • "New" badge for products < 30 days old');
    console.log('');
    console.log('The campaign collection template is now updated.');
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
