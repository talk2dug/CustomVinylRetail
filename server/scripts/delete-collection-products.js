#!/usr/bin/env node
/**
 * Delete all products from a collection
 * Usage: node delete-collection-products.js <collection-id-or-title>
 */

const path = require('path');
// Load from server/.env first, then fallback to parent vinylApp/.env
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const shopify = require('../integrations/shopify');

async function main() {
  const arg = process.argv[2];

  if (!arg) {
    console.error('Usage: node delete-collection-products.js <collection-id-or-title>');
    console.error('Example: node delete-collection-products.js "Rally Heritage Metal Prints"');
    console.error('Example: node delete-collection-products.js 123456789');
    process.exit(1);
  }

  if (!shopify.isConfigured()) {
    console.error('Error: Shopify is not configured. Check your .env file.');
    process.exit(1);
  }

  let collectionId = arg;

  // If not a number, search by title
  if (isNaN(Number(arg))) {
    console.log(`Searching for collection: "${arg}"...`);
    const collection = await shopify.findCustomCollectionByTitle(arg);
    if (!collection) {
      console.error(`Collection not found: "${arg}"`);
      process.exit(1);
    }
    collectionId = collection.id;
    console.log(`Found collection: ${collection.title} (ID: ${collectionId})`);
  }

  console.log(`\nFetching products from collection ${collectionId}...`);
  const products = await shopify.getCollectionProducts(collectionId);

  if (products.length === 0) {
    console.log('No products found in this collection.');
    process.exit(0);
  }

  console.log(`Found ${products.length} products to delete:\n`);
  products.forEach((p, i) => {
    console.log(`  ${i + 1}. ${p.title} (ID: ${p.id})`);
  });

  console.log('\n⚠️  WARNING: This will permanently delete these products!');
  console.log('Press Ctrl+C within 5 seconds to cancel...\n');

  await new Promise(r => setTimeout(r, 5000));

  console.log('Deleting products...\n');

  let deleted = 0;
  let failed = 0;

  for (const product of products) {
    try {
      await shopify.deleteProduct(product.id);
      console.log(`  ✓ Deleted: ${product.title}`);
      deleted++;
      // Rate limit delay
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.error(`  ✗ Failed to delete ${product.title}: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Deletion complete: ${deleted} deleted, ${failed} failed`);
  console.log(`${'='.repeat(50)}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
