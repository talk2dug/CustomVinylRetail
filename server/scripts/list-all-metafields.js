require('dotenv').config();
const https = require('https');

const SHOP = process.env.SHOPIFY_SHOP || process.env.SHOPIFY_SHOP_DOMAIN || process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

function graphqlRequest(query, variables = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query, variables });
    const req = https.request({
      hostname: SHOP,
      path: '/admin/api/2024-01/graphql.json',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': TOKEN
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function listAllMetafields() {
  console.log('=== Listing ALL Metafield Definitions ===\n');
  console.log('Using shop:', SHOP, '\n');

  // Check product metafields
  const ownerTypes = ['PRODUCT', 'COLLECTION', 'SHOP'];

  for (const ownerType of ownerTypes) {
    const query = `
      query {
        metafieldDefinitions(first: 100, ownerType: ${ownerType}) {
          edges {
            node {
              id
              name
              namespace
              key
              description
              type {
                name
              }
              validations {
                name
                value
              }
            }
          }
        }
      }
    `;

    console.log(`\n=== ${ownerType} Metafields ===`);
    const result = await graphqlRequest(query);

    if (result.errors) {
      console.error('Errors:', result.errors);
      continue;
    }

    const defs = result.data?.metafieldDefinitions?.edges || [];
    if (defs.length === 0) {
      console.log('  (none)');
    } else {
      defs.forEach(d => {
        const node = d.node;
        console.log(`\n  ${node.namespace}.${node.key}`);
        console.log(`    Name: ${node.name}`);
        console.log(`    Type: ${node.type?.name}`);
        if (node.description) console.log(`    Desc: ${node.description}`);
        if (node.validations?.length) {
          console.log(`    Validations:`);
          node.validations.forEach(v => {
            console.log(`      - ${v.name}: ${v.value.substring(0, 100)}${v.value.length > 100 ? '...' : ''}`);
          });
        }
      });
    }
  }

  // Also check custom metafields on a sample product
  console.log('\n\n=== Sample Product Metafields ===');
  const productQuery = `
    query {
      products(first: 1) {
        edges {
          node {
            id
            title
            metafields(first: 50) {
              edges {
                node {
                  namespace
                  key
                  value
                  type
                }
              }
            }
          }
        }
      }
    }
  `;

  const productResult = await graphqlRequest(productQuery);
  if (!productResult.errors) {
    const products = productResult.data?.products?.edges || [];
    if (products.length) {
      const p = products[0].node;
      console.log(`Product: ${p.title}`);
      const metas = p.metafields?.edges || [];
      if (metas.length === 0) {
        console.log('  (no metafields)');
      } else {
        metas.forEach(m => {
          console.log(`  - ${m.node.namespace}.${m.node.key}: ${m.node.value?.substring(0, 50) || '(empty)'} (${m.node.type})`);
        });
      }
    }
  }
}

listAllMetafields().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
