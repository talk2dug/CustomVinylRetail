#!/usr/bin/env node
/**
 * Upload Custom Art theme files to Shopify
 * Uploads product template, sections, and CSS assets
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
  console.log('Uploading Custom Art Theme Files to Shopify');
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
    { path: 'templates/product.custom-art.json', key: 'templates/product.custom-art.json' },
    { path: 'sections/custom-art-hero.liquid', key: 'sections/custom-art-hero.liquid' },
    { path: 'sections/custom-art-details.liquid', key: 'sections/custom-art-details.liquid' },
    { path: 'assets/custom-art.css', key: 'assets/custom-art.css' }
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

  console.log();
  console.log('='.repeat(50));
  console.log(`Results: ${results.success} succeeded, ${results.failed} failed`);
  console.log('='.repeat(50));

  if (results.success > 0) {
    console.log();
    console.log('Next steps:');
    console.log('1. Go to Shopify Admin > Products > [Your Product]');
    console.log('2. In the "Theme template" dropdown, select "custom-art"');
    console.log('3. Save and preview the product page');
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
