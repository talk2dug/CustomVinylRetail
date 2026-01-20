require('dotenv').config();
const shopify = require('../integrations/shopify.js');

async function check() {
  // Find the collection
  const url = shopify.adminUrl('/custom_collections.json?handle=light-houses&limit=5');
  const res = await shopify.httpJson('GET', url);
  const collection = res.custom_collections && res.custom_collections[0];

  if (!collection) {
    console.log('Collection not found!');
    return;
  }

  console.log('Collection:', collection.title, '(ID:', collection.id, ')');

  // Get products in collection
  const prodUrl = shopify.adminUrl('/collections/' + collection.id + '/products.json?limit=10');
  const prodRes = await shopify.httpJson('GET', prodUrl);
  const products = prodRes.products || [];

  console.log('Products in collection:', products.length);

  if (products.length > 0) {
    console.log('First product:', products[0].title);
    console.log('  Variants:', products[0].variants ? products[0].variants.length : 0);
    console.log('  Images:', products[0].images ? products[0].images.length : 0);
  }

  // Search for lighthouse products anywhere
  const searchUrl = shopify.adminUrl('/products.json?limit=50');
  const searchRes = await shopify.httpJson('GET', searchUrl);
  const allProducts = searchRes.products || [];

  // Filter for lighthouse-related titles
  const lighthouseProducts = allProducts.filter(p =>
    p.title.toLowerCase().includes('lighthouse') ||
    p.title.toLowerCase().includes('point') ||
    p.title.toLowerCase().includes('head')
  );

  console.log('\nRecent products that might be lighthouses:', lighthouseProducts.length);
  lighthouseProducts.slice(0, 5).forEach(p => {
    console.log('  -', p.title);
    console.log('    ID:', p.id);
    console.log('    Variants:', p.variants ? p.variants.length : 0);
    console.log('    Images:', p.images ? p.images.length : 0);
  });
}

check().catch(e => console.error(e));
