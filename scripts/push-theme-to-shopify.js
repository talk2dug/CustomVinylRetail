/**
 * Push Theme Files to Shopify
 *
 * Uploads local theme files to the live Shopify theme
 * Usage: node scripts/push-theme-to-shopify.js
 */

const fs = require('fs');
const path = require('path');

// Load .env from project root
const envPath = path.resolve(__dirname, '..', '.env');
console.log(`Loading .env from: ${envPath}`);
require('dotenv').config({ path: envPath });

console.log(`SHOPIFY_SHOP: ${process.env.SHOPIFY_SHOP}`);
console.log(`SHOPIFY_ACCESS_TOKEN: ${process.env.SHOPIFY_ACCESS_TOKEN ? 'SET' : 'NOT SET'}`);

const shopify = require('../server/integrations/shopify');

const THEME_DIR = path.resolve(__dirname, '..', 'shopify-theme');

// Files to push (relative to theme directory)
const FILES_TO_PUSH = [
  // Sections
  { local: 'sections/dynamic-collections-showcase.liquid', remote: 'sections/dynamic-collections-showcase.liquid' },
  { local: 'sections/homepage-hero.liquid', remote: 'sections/homepage-hero.liquid' },
  { local: 'sections/homepage-story.liquid', remote: 'sections/homepage-story.liquid' },
  { local: 'sections/homepage-featured.liquid', remote: 'sections/homepage-featured.liquid' },
  { local: 'sections/category-hero.liquid', remote: 'sections/category-hero.liquid' },
  { local: 'sections/campaign-hero.liquid', remote: 'sections/campaign-hero.liquid' },
  { local: 'sections/category-collections-grid.liquid', remote: 'sections/category-collections-grid.liquid' },
  { local: 'sections/campaign-product-grid.liquid', remote: 'sections/campaign-product-grid.liquid' },
  { local: 'sections/custom-art-hero.liquid', remote: 'sections/custom-art-hero.liquid' },
  { local: 'sections/custom-art-details.liquid', remote: 'sections/custom-art-details.liquid' },
  { local: 'sections/tiled-art-hero.liquid', remote: 'sections/tiled-art-hero.liquid' },
  { local: 'sections/tiled-art-product-form.liquid', remote: 'sections/tiled-art-product-form.liquid' },
  { local: 'sections/metal-prints-masonry.liquid', remote: 'sections/metal-prints-masonry.liquid' },
  // Snippets
  { local: 'snippets/campaign-product-card.liquid', remote: 'snippets/campaign-product-card.liquid' },
  // Assets
  { local: 'assets/collections-showcase.css', remote: 'assets/collections-showcase.css' },
  { local: 'assets/campaign-grid.css', remote: 'assets/campaign-grid.css' },
  { local: 'assets/custom-art.css', remote: 'assets/custom-art.css' },
  { local: 'assets/tiled-art.css', remote: 'assets/tiled-art.css' },
  // Templates
  { local: 'templates/index.json', remote: 'templates/index.json' },
  { local: 'templates/product.custom-art.json', remote: 'templates/product.custom-art.json' },
  { local: 'templates/product.tiled-art.json', remote: 'templates/product.tiled-art.json' },
  { local: 'templates/collection.json', remote: 'templates/collection.json' },
  { local: 'templates/collection.campaign.json', remote: 'templates/collection.campaign.json' },
  { local: 'templates/collection.category-landing.json', remote: 'templates/collection.category-landing.json' },
  { local: 'templates/collection.metal-prints.json', remote: 'templates/collection.metal-prints.json' },
  // Category Landing Pages
  { local: 'templates/page.apparel.json', remote: 'templates/page.apparel.json' },
  { local: 'templates/page.stickers-decals.json', remote: 'templates/page.stickers-decals.json' },
  { local: 'templates/page.custom-art.json', remote: 'templates/page.custom-art.json' },
  { local: 'templates/page.metal-prints.json', remote: 'templates/page.metal-prints.json' }
];

async function pushThemeFiles() {
  console.log('🚀 Pushing theme files to Shopify...\n');

  if (!shopify.isConfigured()) {
    console.error('❌ Shopify not configured. Set SHOPIFY_STORE_DOMAIN and SHOPIFY_ACCESS_TOKEN in .env');
    process.exit(1);
  }

  // Get the main theme ID
  let themeId;
  try {
    themeId = await shopify.getMainThemeId();
    if (!themeId) {
      console.error('❌ Could not find main theme');
      process.exit(1);
    }
    console.log(`📦 Found main theme ID: ${themeId}\n`);
  } catch (err) {
    console.error('❌ Error getting main theme:', err.message);
    process.exit(1);
  }

  // Push each file
  let successCount = 0;
  let failCount = 0;

  for (const file of FILES_TO_PUSH) {
    const localPath = path.join(THEME_DIR, file.local);

    if (!fs.existsSync(localPath)) {
      console.log(`⚠️  Skipping ${file.local} (file not found)`);
      continue;
    }

    try {
      const content = fs.readFileSync(localPath, 'utf8');
      console.log(`📤 Uploading ${file.remote}...`);

      await shopify.putAsset(themeId, file.remote, content);
      console.log(`   ✅ Success`);
      successCount++;
    } catch (err) {
      // Better error handling for Shopify API errors
      let errorMsg = err.message || 'Unknown error';
      if (err.detail) {
        if (typeof err.detail === 'object') {
          errorMsg = JSON.stringify(err.detail, null, 2);
        } else {
          errorMsg = String(err.detail);
        }
      }
      console.log(`   ❌ Failed: ${errorMsg}`);
      failCount++;
    }
  }

  console.log(`\n📊 Summary: ${successCount} uploaded, ${failCount} failed`);

  if (successCount > 0) {
    console.log('\n✨ Theme files pushed successfully!');
    console.log('   Visit your Shopify store to see the changes.');
  }
}

// Run
pushThemeFiles().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
