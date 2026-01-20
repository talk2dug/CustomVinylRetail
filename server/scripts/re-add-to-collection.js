require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const shopify = require('../integrations/shopify.js');

const COLLECTION_HANDLE = 'light-houses';

async function main() {
  console.log('Re-adding products to collection...');

  // Find the collection
  const collUrl = shopify.adminUrl(`/custom_collections.json?handle=${encodeURIComponent(COLLECTION_HANDLE)}&limit=5`);
  const collRes = await shopify.httpJson('GET', collUrl);
  const collection = collRes.custom_collections && collRes.custom_collections[0];

  if (!collection) {
    console.error('Collection not found!');
    process.exit(1);
  }

  console.log(`Found collection: ${collection.title} (ID: ${collection.id})`);

  // Get ALL products and filter for lighthouse ones by tag
  let allProducts = [];
  let pageInfo = null;
  let pageNum = 1;

  while (true) {
    let url = shopify.adminUrl('/products.json?limit=250');
    if (pageInfo) {
      url += `&page_info=${pageInfo}`;
    }

    console.log(`Fetching page ${pageNum}...`);
    const res = await shopify.httpJson('GET', url);
    const products = res.products || [];

    if (products.length === 0) break;

    allProducts.push(...products);

    // Check for pagination
    const linkHeader = res._linkHeader || '';
    const nextMatch = linkHeader.match(/page_info=([^>&]+)[^>]*>;\s*rel="next"/);
    if (nextMatch) {
      pageInfo = nextMatch[1];
      pageNum++;
    } else {
      break;
    }

    if (products.length < 250) break;
  }

  console.log(`Found ${allProducts.length} total products`);

  // Filter for lighthouse products (they should have the light-houses tag)
  const lighthouseProducts = allProducts.filter(p => {
    const tags = (p.tags || '').toLowerCase();
    return tags.includes('light-houses') || tags.includes('lighthouse');
  });

  console.log(`Found ${lighthouseProducts.length} lighthouse products to add to collection`);

  // Add each to the collection
  let added = 0;
  let errors = 0;

  for (const product of lighthouseProducts) {
    try {
      await shopify.addProductToCollection(product.id, collection.id);
      added++;
      console.log(`  ✓ Added: ${product.title} (${product.id})`);
    } catch (e) {
      errors++;
      console.log(`  ✗ Failed to add ${product.title}: ${e.message}`);
    }

    // Rate limit
    await new Promise(r => setTimeout(r, 200));
  }

  console.log('');
  console.log(`Done! Added: ${added}, Errors: ${errors}`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
