#!/usr/bin/env node
/**
 * Find existing Shopify products for Series 3 catalog items
 * and optionally create/update a campaign file with the product IDs
 */

const path = require('path');
const fs = require('fs');

// Load environment
const ENV_PATH = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(ENV_PATH)) {
  require('dotenv').config({ path: ENV_PATH });
}

const shopify = require('../server/integrations/shopify');

async function main() {
  if (!shopify.isConfigured()) {
    console.error('❌ Shopify not configured');
    process.exit(1);
  }

  console.log('🔍 Searching for Shopify products with "series-3" tags...\n');

  try {
    // Search for products with series-3 related tags
    const products = [];

    // Try different tag patterns
    const tagPatterns = [
      'campaign:series-3',
      'category:series-3',
      'Series 3',
      'series-3'
    ];

    for (const tag of tagPatterns) {
      console.log(`Searching for tag: "${tag}"...`);
      try {
        const found = await shopify.findProductByTag(tag);
        if (found && found.id) {
          console.log(`  ✓ Found product: ${found.title}`);
          products.push(found);
        } else {
          console.log(`  - No product found`);
        }
      } catch (err) {
        console.log(`  - No product found (${err.message})`);
      }
    }

    // Also try searching for products by title pattern "Series 3"
    console.log(`\nSearching for products with "Series 3" in title...`);
    try {
      // Use GraphQL to search by title
      const query = `
        query {
          products(first: 50, query: "title:*Series 3*") {
            edges {
              node {
                id
                title
                tags
              }
            }
          }
        }
      `;
      const result = await shopify.graphql(query);
      const foundProducts = result?.data?.products?.edges || [];
      if (foundProducts.length > 0) {
        console.log(`  ✓ Found ${foundProducts.length} products with "Series 3" in title`);
        foundProducts.forEach(edge => {
          const p = edge.node;
          const numericId = p.id.split('/').pop();
          products.push({
            id: numericId,
            title: p.title,
            tags: p.tags?.join(', ') || ''
          });
        });
      }
    } catch (err) {
      console.log(`  - Search failed: ${err.message}`);
    }

    // Deduplicate by ID
    const uniqueProducts = Array.from(
      new Map(products.map(p => [p.id, p])).values()
    );

    console.log(`\n📦 Total unique products found: ${uniqueProducts.length}\n`);

    if (uniqueProducts.length === 0) {
      console.log('No Shopify products found for Series 3.');
      console.log('This means either:');
      console.log('  1. Products haven\'t been exported yet');
      console.log('  2. Products exist but don\'t have the expected tags');
      console.log('  3. Products were created with a different campaign name');
      return;
    }

    // Display found products
    console.log('Found products:');
    uniqueProducts.slice(0, 10).forEach((p, i) => {
      console.log(`  ${i + 1}. ${p.title} (ID: ${p.id})`);
      console.log(`     Tags: ${p.tags}`);
    });

    if (uniqueProducts.length > 10) {
      console.log(`  ... and ${uniqueProducts.length - 10} more`);
    }

    console.log('\n💡 Next steps:');
    console.log('  1. Create a campaign in Print Station from Series 3 catalog items');
    console.log('  2. Export with force=1 to update these products with proper UIDs');
    console.log('  3. Or manually delete duplicates from Shopify admin');

  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.stack) console.error(error.stack);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
