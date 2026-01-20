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

async function addStickersMetafieldOption() {
  console.log('=== Adding Stickers to Category Metafield ===\n');

  // First, get existing metafield definitions
  const listQuery = `
    query {
      metafieldDefinitions(first: 50, ownerType: PRODUCT) {
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

  console.log('Fetching existing metafield definitions...');
  const listResult = await graphqlRequest(listQuery);

  if (listResult.errors) {
    console.error('GraphQL errors:', listResult.errors);
    return;
  }

  const definitions = listResult.data?.metafieldDefinitions?.edges || [];
  console.log(`Found ${definitions.length} metafield definitions\n`);

  // Find the category metafield
  const categoryDef = definitions.find(d =>
    d.node.key === 'category' ||
    d.node.name.toLowerCase().includes('category')
  );

  if (categoryDef) {
    console.log('Found category metafield:');
    console.log('  ID:', categoryDef.node.id);
    console.log('  Name:', categoryDef.node.name);
    console.log('  Namespace:', categoryDef.node.namespace);
    console.log('  Key:', categoryDef.node.key);
    console.log('  Type:', categoryDef.node.type?.name);
    console.log('  Validations:', JSON.stringify(categoryDef.node.validations, null, 2));

    // If it has choices/validations, we need to update them
    const validations = categoryDef.node.validations || [];
    const choicesValidation = validations.find(v => v.name === 'choices');

    if (choicesValidation) {
      console.log('\nCurrent choices:', choicesValidation.value);

      // Parse and add Stickers
      let choices = [];
      try {
        choices = JSON.parse(choicesValidation.value);
      } catch (e) {
        choices = choicesValidation.value.split(',').map(c => c.trim());
      }

      if (!choices.includes('Stickers') && !choices.includes('stickers')) {
        choices.push('Stickers');
        console.log('Adding "Stickers" to choices...');

        // Update the metafield definition
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
            id: categoryDef.node.id,
            validations: [
              { name: 'choices', value: JSON.stringify(choices) }
            ]
          }
        });

        if (updateResult.errors || updateResult.data?.metafieldDefinitionUpdate?.userErrors?.length) {
          console.error('Update errors:', updateResult.errors || updateResult.data?.metafieldDefinitionUpdate?.userErrors);
        } else {
          console.log('✓ Successfully added "Stickers" to category options!');
          console.log('New choices:', updateResult.data?.metafieldDefinitionUpdate?.updatedDefinition?.validations);
        }
      } else {
        console.log('✓ "Stickers" already exists in choices');
      }
    } else {
      console.log('\nNo choices validation found - this metafield may be free-form text');
    }
  } else {
    console.log('No category metafield found.');
    console.log('\nExisting metafields:');
    definitions.forEach(d => {
      console.log(`  - ${d.node.namespace}.${d.node.key}: ${d.node.name} (${d.node.type?.name})`);
    });
  }
}

addStickersMetafieldOption().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
