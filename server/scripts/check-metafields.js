require('dotenv').config();
const { findCustomCollectionByTitle, getCustomCollection } = require('../integrations/shopify.js');

async function checkMetafields() {
  console.log('=== Checking Shopify Category/Metafields ===\n');

  // Get the Stickers collection
  const collection = await findCustomCollectionByTitle('Stickers');
  console.log('Stickers Collection:');
  if (collection) {
    console.log('  ID:', collection.id);
    console.log('  Handle:', collection.handle);
    console.log('  Template suffix:', collection.template_suffix);
    console.log('  Title:', collection.title);
  } else {
    console.log('  NOT FOUND');
  }

  // Check using direct API call for metafield definitions
  const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN;
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;

  console.log('\n=== Product Metafield Definitions ===');
  const metaRes = await fetch(`https://${shopDomain}/admin/api/2024-01/metafield_definitions.json?owner_resource=product`, {
    headers: {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json'
    }
  });
  const metaData = await metaRes.json();

  if (metaData.metafield_definitions && metaData.metafield_definitions.length > 0) {
    metaData.metafield_definitions.forEach(def => {
      console.log(`  - ${def.namespace}.${def.key}: ${def.name} (${def.type?.name || def.type})`);
    });
  } else {
    console.log('  No metafield definitions found');
  }

  // Check Shopify's standard product category taxonomy
  console.log('\n=== Checking Standard Category Field ===');
  console.log('Note: Shopify uses "product_category" or "category" in the product object');
  console.log('This is different from metafields - it\'s a built-in taxonomy field');
}

checkMetafields().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
