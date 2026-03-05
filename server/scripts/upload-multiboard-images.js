#!/usr/bin/env node
/**
 * Upload multiboard product images to Shopify
 *
 * Reads tagged images from multiboard_media table,
 * matches them to products by room, and uploads via Shopify API.
 *
 * Usage:
 *   node server/scripts/upload-multiboard-images.js [--dry-run]
 *
 * Prerequisites:
 *   - Products must exist in Shopify (run seed-multiboard-products.js --shopify first)
 *   - Images must be scraped and tagged (run scrape-multiboard-images.js first)
 */

const path = require('path');
const fs = require('fs');
process.chdir(path.join(__dirname, '..', '..'));
require('dotenv').config();

const db = require('../db');
const shopify = require('../integrations/shopify');

const MEDIA_DIR = path.join(process.cwd(), 'data/media/multiboard/scraped');
const DRY_RUN = process.argv.includes('--dry-run');

// Map rooms to preferred image assignments
// Best image per product, based on visual review
const PRODUCT_IMAGE_MAP = {
  'mb-garage-workshop': ['mb-22.jpg', 'mb-26.jpg', 'mb-3.jpg'],
  'mb-kitchen-command': ['mb-28.jpg', 'mb-24.jpg'],
  'mb-craft-maker': ['mb-39.jpg', 'mb-42.jpg', 'mb-30.jpg'],
  'mb-desk-starter': ['mb-24.jpg', 'mb-5.jpg'],
  // Addons get general product renders
  'mb-bin-bundle': ['mb-46.png', 'mb-12.png'],
  'mb-hook-bundle': ['mb-12.png', 'mb-17.png'],
  'mb-tile-expansion': ['mb-14.png', 'mb-16.png'],
  'mb-drawer-unit': ['mb-19.png', 'mb-48.png'],
  'mb-label-holder-set': ['mb-49.png'],
  'mb-heavy-duty-upgrade': ['mb-18.png', 'mb-49.png'],
  'mb-color-accent-pack': ['mb-15.png', 'mb-12.png']
};

async function uploadImages() {
  console.log('=== Upload Multiboard Images to Shopify ===\n');

  if (DRY_RUN) console.log('  [DRY RUN MODE]\n');

  const products = db.listMultiboardProducts({ activeOnly: true });
  let uploaded = 0;
  let skipped = 0;
  let errors = 0;

  for (const product of products) {
    if (!product.shopify_product_id) {
      console.log(`  SKIP: ${product.name} — no Shopify product ID`);
      skipped++;
      continue;
    }

    const imageFiles = PRODUCT_IMAGE_MAP[product.id] || [];
    if (!imageFiles.length) {
      console.log(`  SKIP: ${product.name} — no images mapped`);
      skipped++;
      continue;
    }

    console.log(`  ${product.name} (Shopify ID: ${product.shopify_product_id})`);

    for (let i = 0; i < imageFiles.length; i++) {
      const filename = imageFiles[i];
      const filePath = path.join(MEDIA_DIR, filename);

      if (!fs.existsSync(filePath)) {
        console.log(`    SKIP: ${filename} not found`);
        continue;
      }

      if (DRY_RUN) {
        console.log(`    [DRY] Would upload: ${filename} (position ${i + 1})`);
        continue;
      }

      try {
        const imageBuffer = fs.readFileSync(filePath);
        const base64 = imageBuffer.toString('base64');
        const ext = path.extname(filename).toLowerCase();
        const alt = `${product.name} - Multiboard wall organization`;

        await shopify.addProductImage(product.shopify_product_id, {
          attachment: base64,
          filename: `${product.slug}-${i + 1}${ext}`,
          alt,
          position: i + 1
        });

        console.log(`    UPLOAD: ${filename} → position ${i + 1}`);
        uploaded++;

        // Rate limit
        await new Promise(r => setTimeout(r, 500));
      } catch (e) {
        console.error(`    ERROR: ${filename} — ${e.message}`);
        errors++;
      }
    }
  }

  console.log(`\n=== Done ===`);
  console.log(`  Uploaded: ${uploaded}`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Errors: ${errors}`);
}

uploadImages().then(() => process.exit(0)).catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
