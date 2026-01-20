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

async function addStickersToCategory() {
  console.log('=== Adding "stickers" to Collection Category Metafield ===\n');

  // Get COLLECTION metafield definitions
  const listQuery = `
    query {
      metafieldDefinitions(first: 50, ownerType: COLLECTION) {
        edges {
          node {
            id
            name
            namespace
            key
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

  console.log('Fetching collection metafield definitions...');
  const listResult = await graphqlRequest(listQuery);

  if (listResult.errors) {
    console.error('GraphQL errors:', listResult.errors);
    return;
  }

  const definitions = listResult.data?.metafieldDefinitions?.edges || [];
  console.log(`Found ${definitions.length} collection metafield definitions\n`);

  // Find the category metafield
  const categoryDef = definitions.find(d =>
    d.node.namespace === 'custom' && d.node.key === 'category'
  );

  if (!categoryDef) {
    console.log('Category metafield not found!');
    return;
  }

  console.log('Found category metafield:');
  console.log('  ID:', categoryDef.node.id);
  console.log('  Name:', categoryDef.node.name);
  console.log('  Namespace:', categoryDef.node.namespace);
  console.log('  Key:', categoryDef.node.key);

  const validations = categoryDef.node.validations || [];
  const choicesValidation = validations.find(v => v.name === 'choices');

  if (!choicesValidation) {
    console.log('No choices validation found!');
    return;
  }

  console.log('\nCurrent choices:', choicesValidation.value);

  // Parse and add stickers
  let choices = JSON.parse(choicesValidation.value);
  console.log('Parsed choices:', choices);

  if (choices.includes('stickers')) {
    console.log('\n✓ "stickers" already exists in choices');
    return;
  }

  choices.push('stickers');
  console.log('\nAdding "stickers" to choices...');
  console.log('New choices will be:', choices);

  // Update the metafield definition using the correct mutation format
  const updateMutation = `
    mutation metafieldDefinitionUpdate($definition: MetafieldDefinitionUpdateInput!) {
      metafieldDefinitionUpdate(definition: $definition) {
        updatedDefinition {
          id
          validations {
            name
            value
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const updateResult = await graphqlRequest(updateMutation, {
    definition: {
      namespace: 'custom',
      key: 'category',
      ownerType: 'COLLECTION',
      validations: [
        { name: 'choices', value: JSON.stringify(choices) }
      ]
    }
  });

  if (updateResult.errors) {
    console.error('\nGraphQL errors:', updateResult.errors);
    return;
  }

  const userErrors = updateResult.data?.metafieldDefinitionUpdate?.userErrors || [];
  if (userErrors.length) {
    console.error('\nUser errors:', userErrors);
    return;
  }

  console.log('\n✓ Successfully added "stickers" to category choices!');
  console.log('Updated validations:', updateResult.data?.metafieldDefinitionUpdate?.updatedDefinition?.validations);
}

addStickersToCategory().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
