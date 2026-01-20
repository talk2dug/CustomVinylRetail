/**
 * Setup Collection Category Metafield
 *
 * This script creates a metafield definition for collections
 * to categorize them (apparel, decals, custom-art, metal-prints)
 *
 * Usage: node scripts/setup-collection-category-metafield.js
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const shopify = require('../server/integrations/shopify');

async function setupMetafieldDefinition() {
  console.log('🔧 Setting up Collection Category Metafield...\n');

  if (!shopify.isConfigured()) {
    console.error('❌ Shopify not configured. Set SHOPIFY_STORE_DOMAIN and SHOPIFY_ACCESS_TOKEN in .env');
    process.exit(1);
  }

  // Create metafield definition using GraphQL
  const mutation = `
    mutation CreateMetafieldDefinition($definition: MetafieldDefinitionInput!) {
      metafieldDefinitionCreate(definition: $definition) {
        createdDefinition {
          id
          name
          namespace
          key
          type {
            name
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    definition: {
      name: "Category",
      namespace: "custom",
      key: "category",
      description: "The product category this collection belongs to (apparel, decals, custom-art, metal-prints)",
      type: "single_line_text_field",
      ownerType: "COLLECTION",
      validations: [
        {
          name: "choices",
          value: JSON.stringify(["apparel", "decals", "custom-art", "metal-prints"])
        }
      ]
    }
  };

  try {
    const result = await shopify.graphql(mutation, variables);

    if (result.data?.metafieldDefinitionCreate?.userErrors?.length > 0) {
      const errors = result.data.metafieldDefinitionCreate.userErrors;

      // Check if it already exists
      if (errors.some(e => e.message.includes('already exists'))) {
        console.log('✅ Metafield definition already exists!\n');
        console.log('You can now add the "category" metafield to your collections in Shopify Admin.\n');
        return;
      }

      console.error('❌ Errors creating metafield definition:');
      errors.forEach(e => console.error(`   - ${e.field}: ${e.message}`));
      process.exit(1);
    }

    const created = result.data?.metafieldDefinitionCreate?.createdDefinition;
    if (created) {
      console.log('✅ Metafield definition created successfully!\n');
      console.log(`   Name: ${created.name}`);
      console.log(`   Namespace: ${created.namespace}`);
      console.log(`   Key: ${created.key}`);
      console.log(`   Type: ${created.type.name}\n`);
    }
  } catch (err) {
    console.error('❌ Error:', err.message);
    if (err.detail) {
      console.error('   Details:', JSON.stringify(err.detail, null, 2));
    }
    process.exit(1);
  }

  console.log('📋 Next Steps:');
  console.log('   1. Go to Shopify Admin > Collections');
  console.log('   2. Edit each collection');
  console.log('   3. Scroll down to "Metafields" section');
  console.log('   4. Set the "Category" field to one of:');
  console.log('      - apparel');
  console.log('      - decals');
  console.log('      - custom-art');
  console.log('      - metal-prints');
  console.log('');
}

setupMetafieldDefinition().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
