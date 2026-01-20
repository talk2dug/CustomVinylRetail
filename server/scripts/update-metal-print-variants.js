/**
 * Update Metal Print Products with All Variants
 *
 * This script finds all metal print products in Shopify and updates them
 * to include all size variants from pricing.json
 *
 * Usage: node server/scripts/update-metal-print-variants.js [--dry-run]
 */

const path = require('path');
const fs = require('fs');

// Load environment
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const shopify = require('../integrations/shopify');
const pricing = require('../data/pricing.json');

const DRY_RUN = process.argv.includes('--dry-run');

async function findMetalPrintProducts() {
  console.log('Finding all Metal Print products in Shopify...\n');

  const allProducts = [];
  let lastId = null;

  // Paginate through all products
  while (true) {
    const { products, lastId: nextId } = await shopify.listProducts({ limit: 250, since_id: lastId });
    if (!products || products.length === 0) break;

    // Filter for metal print products
    const metalPrints = products.filter(p =>
      p.product_type === 'Metal Print' ||
      (p.tags && p.tags.toLowerCase().includes('metal-print'))
    );

    allProducts.push(...metalPrints);
    lastId = nextId;

    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`Found ${allProducts.length} Metal Print products\n`);
  return allProducts;
}

async function updateProductVariants(product) {
  const metalPrintPricing = pricing['metal-print'];
  if (!metalPrintPricing || !metalPrintPricing.sizes) {
    throw new Error('Metal print pricing not found in pricing.json');
  }

  const sizes = metalPrintPricing.sizes;
  const sizeNames = Object.keys(sizes);

  // Get current variants
  const currentVariants = product.variants || [];
  const currentSizes = currentVariants.map(v => v.option1 || v.title).filter(Boolean);

  console.log(`  Current sizes: ${currentSizes.join(', ') || 'none'}`);
  console.log(`  Target sizes: ${sizeNames.length} variants`);

  // Build new variants array
  const newVariants = [];

  for (const [sizeName, sizeData] of Object.entries(sizes)) {
    // Check if this size already exists
    const existingVariant = currentVariants.find(v =>
      (v.option1 || v.title) === sizeName
    );

    const variant = {
      option1: sizeName,
      price: (sizeData.priceCents / 100).toFixed(2),
      sku: sizeData.sku || `METAL-${sizeName.replace('x', '')}`,
      inventory_management: 'shopify',
      inventory_policy: 'continue',
      requires_shipping: true,
      taxable: true
    };

    // Preserve existing variant ID if it exists
    if (existingVariant && existingVariant.id) {
      variant.id = existingVariant.id;
    }

    newVariants.push(variant);
  }

  // Calculate changes
  const addedSizes = sizeNames.filter(s => !currentSizes.includes(s));
  const removedSizes = currentSizes.filter(s => !sizeNames.includes(s));

  if (addedSizes.length > 0) {
    console.log(`  Adding sizes: ${addedSizes.join(', ')}`);
  }
  if (removedSizes.length > 0) {
    console.log(`  Removing sizes: ${removedSizes.join(', ')}`);
  }

  if (addedSizes.length === 0 && removedSizes.length === 0) {
    // Just check if prices need updating
    let priceUpdates = 0;
    for (const variant of currentVariants) {
      const sizeName = variant.option1 || variant.title;
      const expectedPrice = sizes[sizeName] ? (sizes[sizeName].priceCents / 100).toFixed(2) : null;
      if (expectedPrice && variant.price !== expectedPrice) {
        priceUpdates++;
      }
    }

    if (priceUpdates === 0) {
      console.log(`  No variant changes needed`);
      // Still publish to all channels even if variants are up to date
      if (!DRY_RUN) {
        try {
          await shopify.publishEverywhere(product.id);
          console.log(`  ✓ Published to all sales channels`);
        } catch (pubErr) {
          console.log(`  ⚠ Publishing warning: ${pubErr.message}`);
        }
      }
      return { updated: false, reason: 'no changes', published: true };
    }
    console.log(`  Updating ${priceUpdates} variant prices`);
  }

  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would update product with ${newVariants.length} variants`);
    return { updated: false, dryRun: true };
  }

  // Update product options and variants
  const updatePayload = {
    options: [{ name: 'Size', values: sizeNames }],
    variants: newVariants
  };

  try {
    await shopify.updateProduct(product.id, updatePayload);
    console.log(`  ✓ Updated successfully with ${newVariants.length} variants`);

    // Publish to all sales channels (Online Store, POS, Facebook, TikTok, etc.)
    try {
      await shopify.publishEverywhere(product.id);
      console.log(`  ✓ Published to all sales channels`);
    } catch (pubErr) {
      console.log(`  ⚠ Publishing warning: ${pubErr.message}`);
    }

    return { updated: true, variantCount: newVariants.length };
  } catch (err) {
    console.error(`  ✗ Failed to update: ${err.message}`);
    return { updated: false, error: err.message };
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('Metal Print Variant Updater');
  console.log('='.repeat(60));

  if (DRY_RUN) {
    console.log('\n*** DRY RUN MODE - No changes will be made ***\n');
  }

  if (!shopify.isConfigured()) {
    console.error('Error: Shopify is not configured. Check your .env file.');
    process.exit(1);
  }

  // Show pricing info
  const metalPrintPricing = pricing['metal-print'];
  if (!metalPrintPricing || !metalPrintPricing.sizes) {
    console.error('Error: Metal print pricing not found in pricing.json');
    process.exit(1);
  }

  const sizes = metalPrintPricing.sizes;
  console.log(`\nMetal Print sizes in pricing.json: ${Object.keys(sizes).length}`);
  console.log('Sizes:', Object.keys(sizes).join(', '));
  console.log('');

  // Find all metal print products
  const products = await findMetalPrintProducts();

  if (products.length === 0) {
    console.log('No Metal Print products found in Shopify.');
    return;
  }

  // Update each product
  const results = {
    updated: 0,
    skipped: 0,
    failed: 0,
    dryRun: 0
  };

  for (let i = 0; i < products.length; i++) {
    const product = products[i];
    console.log(`\n[${i + 1}/${products.length}] ${product.title} (ID: ${product.id})`);

    try {
      const result = await updateProductVariants(product);

      if (result.dryRun) {
        results.dryRun++;
      } else if (result.updated) {
        results.updated++;
      } else if (result.error) {
        results.failed++;
      } else {
        results.skipped++;
      }
    } catch (err) {
      console.error(`  ✗ Error: ${err.message}`);
      results.failed++;
    }

    // Rate limit delay
    await new Promise(r => setTimeout(r, 600));
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('Summary');
  console.log('='.repeat(60));
  console.log(`Total products: ${products.length}`);
  console.log(`Updated: ${results.updated}`);
  console.log(`Skipped (no changes): ${results.skipped}`);
  console.log(`Failed: ${results.failed}`);
  if (DRY_RUN) {
    console.log(`Dry run (would update): ${results.dryRun}`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
