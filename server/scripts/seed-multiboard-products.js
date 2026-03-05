#!/usr/bin/env node
/**
 * Seed Multiboard Products
 *
 * Seeds the 11 Multiboard products (4 base packages + 7 add-ons)
 * into the multiboard_products table and optionally creates them in Shopify.
 *
 * Usage:
 *   node server/scripts/seed-multiboard-products.js [--shopify] [--dry-run]
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const db = require('../db');

const SKIP_SHOPIFY = !process.argv.includes('--shopify');
const DRY_RUN = process.argv.includes('--dry-run');

// Cost per gram for 3D printed parts
const COST_PER_GRAM = 0.11;

// Attribution line for all Shopify listings
const ATTRIBUTION = 'Printed under license from Multiboard - multiboard.io';

// ============================================================================
// Product Definitions
// ============================================================================

const BASE_PACKAGES = [
  {
    id: 'mb-desk-starter',
    name: 'Desk Starter Kit',
    slug: 'multiboard-desk-starter-kit',
    product_category: 'multiboard_base',
    hero_description: 'Transform your desk from chaos to command center — modular wall tiles that hold everything you need within arm\'s reach.',
    description: 'The Desk Starter Kit is your entry into modular wall organization. Mount the 4x4 tile grid above your desk and snap on the included accessories to keep pens, cables, and small tools organized. Expand anytime with add-on packs.',
    whats_included: ['4x4 wall tile grid (16 tiles)', '2x pen/pencil holders', '1x cable management clip set (4 clips)', '1x small shelf', 'Mounting hardware kit'],
    price_cents: 4499,
    est_weight_g: 150,
    room_use_case: 'desk',
    grid_size: '4x4',
    compatible_addons: ['tile-expansion', 'hook-bundle', 'label-holder-set', 'color-accent-pack']
  },
  {
    id: 'mb-kitchen-command',
    name: 'Kitchen Command Kit',
    slug: 'multiboard-kitchen-command-kit',
    product_category: 'multiboard_base',
    hero_description: 'Reclaim your counter space — a snap-together wall system that puts spices, utensils, and towels exactly where you need them.',
    description: 'The Kitchen Command Kit gives you a 6x4 tile grid perfect for mounting next to the stove or above the counter. Includes hooks for utensils, a spice shelf, and towel bar. Everything snaps in and rearranges in seconds.',
    whats_included: ['6x4 wall tile grid (24 tiles)', '4x utensil hooks', '1x spice rack shelf', '1x towel bar', '2x small bins', 'Mounting hardware kit'],
    price_cents: 7499,
    est_weight_g: 250,
    room_use_case: 'kitchen',
    grid_size: '6x4',
    compatible_addons: ['tile-expansion', 'bin-bundle', 'hook-bundle', 'label-holder-set', 'color-accent-pack']
  },
  {
    id: 'mb-craft-maker',
    name: 'Craft & Maker Kit',
    slug: 'multiboard-craft-maker-kit',
    product_category: 'multiboard_base',
    hero_description: 'Your creative space, organized — modular wall storage that keeps every tool, supply, and material visible and ready to grab.',
    description: 'The Craft & Maker Kit provides an 8x4 tile grid with deep bins for supplies, hooks for scissors and tools, and label holders so you always know where things are. Perfect for craft rooms, sewing stations, and maker benches.',
    whats_included: ['8x4 wall tile grid (32 tiles)', '4x deep storage bins', '6x tool hooks (assorted)', '2x label holder strips', '1x tape dispenser mount', 'Mounting hardware kit'],
    price_cents: 10999,
    est_weight_g: 380,
    room_use_case: 'craft',
    grid_size: '8x4',
    compatible_addons: ['tile-expansion', 'bin-bundle', 'hook-bundle', 'drawer-unit', 'label-holder-set', 'color-accent-pack']
  },
  {
    id: 'mb-garage-workshop',
    name: 'Garage / Workshop Starter',
    slug: 'multiboard-garage-workshop-starter',
    product_category: 'multiboard_base',
    hero_description: 'Build the ultimate tool wall — heavy-duty modular tiles that hold wrenches, drills, and bins full of hardware without breaking a sweat.',
    description: 'The Garage / Workshop Starter gives you the biggest grid at 8x6, built for heavy tools and serious organization. Includes heavy-duty hooks, large bins, and a drawer unit. Upgrade with the Heavy Duty pack for even more holding power.',
    whats_included: ['8x6 wall tile grid (48 tiles)', '8x heavy-duty hooks (assorted)', '4x large storage bins', '1x drawer unit', '2x label holder strips', 'Heavy-duty mounting hardware kit'],
    price_cents: 16999,
    est_weight_g: 580,
    room_use_case: 'garage',
    grid_size: '8x6',
    compatible_addons: ['tile-expansion', 'bin-bundle', 'hook-bundle', 'drawer-unit', 'label-holder-set', 'heavy-duty-upgrade', 'color-accent-pack']
  }
];

const ADDONS = [
  {
    id: 'mb-tile-expansion',
    name: 'Tile Expansion Pack',
    slug: 'tile-expansion',
    product_category: 'multiboard_addon',
    hero_description: 'Need more space? Snap on extra tiles to grow your wall system in any direction.',
    description: 'Add 8 extra wall tiles to expand your Multiboard grid. Tiles snap together seamlessly with the existing grid — extend sideways, upward, or start a second section.',
    whats_included: ['8x wall tiles', '4x connector clips'],
    price_cents: 1499,
    est_weight_g: 60,
    room_use_case: 'general',
    grid_size: null,
    compatible_addons: []
  },
  {
    id: 'mb-bin-bundle',
    name: 'Bin Bundle',
    slug: 'bin-bundle',
    product_category: 'multiboard_addon',
    hero_description: 'Snap-in storage bins in three sizes — keep small parts, supplies, and tools corralled and easy to grab.',
    description: 'A set of 6 snap-in storage bins (2 large, 2 medium, 2 small) that click into any Multiboard tile grid. Great for screws, craft supplies, kitchen items, or desk accessories.',
    whats_included: ['2x large bins', '2x medium bins', '2x small bins'],
    price_cents: 1999,
    est_weight_g: 120,
    room_use_case: 'general',
    grid_size: null,
    compatible_addons: []
  },
  {
    id: 'mb-hook-bundle',
    name: 'Hook Bundle',
    slug: 'hook-bundle',
    product_category: 'multiboard_addon',
    hero_description: 'Hooks for everything — from kitchen utensils to garage tools, in a mix of sizes that fits any need.',
    description: 'A variety pack of 10 snap-in hooks in 4 sizes. Holds tools, utensils, keys, cables, and more. Works with any Multiboard tile grid.',
    whats_included: ['3x small hooks', '3x medium hooks', '2x large hooks', '2x double hooks'],
    price_cents: 1299,
    est_weight_g: 80,
    room_use_case: 'general',
    grid_size: null,
    compatible_addons: []
  },
  {
    id: 'mb-drawer-unit',
    name: 'Drawer Unit',
    slug: 'drawer-unit',
    product_category: 'multiboard_addon',
    hero_description: 'A pull-out drawer that snaps right into your wall grid — hide away small items while keeping them within reach.',
    description: 'Snap-in drawer unit with smooth sliding action. Takes up a 2x2 tile space and holds small parts, batteries, office supplies, or craft materials. Includes label slot on the front.',
    whats_included: ['1x drawer unit with slide mechanism', '1x label insert'],
    price_cents: 2499,
    est_weight_g: 95,
    room_use_case: 'general',
    grid_size: null,
    compatible_addons: []
  },
  {
    id: 'mb-label-holder-set',
    name: 'Label Holder Set',
    slug: 'label-holder-set',
    product_category: 'multiboard_addon',
    hero_description: 'Label everything — snap-on label holders that make your organized wall even easier to navigate.',
    description: 'A set of 10 snap-in label holders with blank label cards. Attach to any bin, hook section, or shelf on your Multiboard grid. Write-on or print labels for a clean, organized look.',
    whats_included: ['10x label holders', '20x blank label cards'],
    price_cents: 899,
    est_weight_g: 30,
    room_use_case: 'general',
    grid_size: null,
    compatible_addons: []
  },
  {
    id: 'mb-heavy-duty-upgrade',
    name: 'Heavy Duty Upgrade Kit',
    slug: 'heavy-duty-upgrade',
    product_category: 'multiboard_addon',
    hero_description: 'Built for weight — reinforced brackets and anchors that let your wall system hold power tools and heavy gear.',
    description: 'Upgrade your Multiboard installation for heavier loads. Includes reinforced mounting brackets, heavy-duty wall anchors, and support rails. Recommended for garage and workshop setups holding power tools.',
    whats_included: ['4x reinforced brackets', '8x heavy-duty wall anchors', '2x support rails'],
    price_cents: 1699,
    est_weight_g: 200,
    room_use_case: 'garage',
    grid_size: null,
    compatible_addons: []
  },
  {
    id: 'mb-color-accent-pack',
    name: 'Color Accent Pack',
    slug: 'color-accent-pack',
    product_category: 'multiboard_addon',
    hero_description: 'Add a pop of color — accent tiles and bin fronts in 4 colors to personalize your wall system.',
    description: 'A set of colored accent tiles and bin face plates that snap over existing tiles. Comes in 4 colors to color-code sections or just add personality to your wall organization.',
    whats_included: ['8x colored accent tiles (2 each in 4 colors)', '4x colored bin face plates'],
    price_cents: 1299,
    est_weight_g: 50,
    room_use_case: 'general',
    grid_size: null,
    compatible_addons: []
  }
];

const ALL_PRODUCTS = [...BASE_PACKAGES, ...ADDONS];

// ============================================================================
// Shopify Product Body HTML Template
// ============================================================================

function buildProductHtml(product) {
  const price = (product.price_cents / 100).toFixed(2);
  const included = product.whats_included.map(item => `<li>${item}</li>`).join('\n');

  let addonsSection = '';
  if (product.compatible_addons && product.compatible_addons.length > 0) {
    const addonNames = product.compatible_addons.map(slug => {
      const addon = ADDONS.find(a => a.slug === slug);
      return addon ? addon.name : slug;
    });
    addonsSection = `
<h3>Expand Your System</h3>
<p>Compatible add-ons:</p>
<ul>
${addonNames.map(n => `<li>${n}</li>`).join('\n')}
</ul>`;
  }

  return `
<div class="multiboard-product">
  <p><strong>${product.hero_description}</strong></p>

  <h3>What's Included</h3>
  <ul>
  ${included}
  </ul>

  ${product.grid_size ? `<p><strong>Grid Size:</strong> ${product.grid_size} (${product.grid_size.split('x').reduce((a, b) => a * b, 1)} tiles)</p>` : ''}

  ${addonsSection}

  <h3>About Multiboard</h3>
  <p>Multiboard is a modular wall organization system. Tiles snap together to create a custom grid, then accessories click in and rearrange anytime. No tools needed to reconfigure — just snap and go.</p>

  <h3>FAQ</h3>
  <dl>
    <dt>How does it mount?</dt>
    <dd>Each kit includes a mounting hardware kit with screws and anchors. Installs on drywall, wood, or concrete.</dd>
    <dt>Can I expand later?</dt>
    <dd>Yes! Add tile expansion packs and any compatible accessories at any time. The system is designed to grow.</dd>
    <dt>What's it made of?</dt>
    <dd>3D printed locally in Asheville, NC using durable PETG/PLA+ filament.</dd>
  </dl>

  <p><em>${ATTRIBUTION}</em></p>
</div>`;
}

// ============================================================================
// Main Seed Function
// ============================================================================

async function seedProducts() {
  console.log('=== Seeding Multiboard Products ===\n');

  let created = 0;
  let skipped = 0;

  for (const product of ALL_PRODUCTS) {
    // Calculate cost and margin
    const cost_cents = Math.round(product.est_weight_g * COST_PER_GRAM * 100);
    const margin_pct = Math.round(((product.price_cents - cost_cents) / product.price_cents) * 100 * 10) / 10;

    const productData = {
      ...product,
      cost_cents,
      margin_pct
    };

    if (DRY_RUN) {
      console.log(`[DRY RUN] Would create: ${product.name} ($${(product.price_cents / 100).toFixed(2)}, cost $${(cost_cents / 100).toFixed(2)}, margin ${margin_pct}%)`);
      created++;
      continue;
    }

    // Check if already exists
    const existing = db.getMultiboardProduct(product.id);
    if (existing) {
      console.log(`  SKIP: ${product.name} (already exists)`);
      skipped++;
      continue;
    }

    try {
      db.createMultiboardProduct(productData);
      console.log(`  CREATE: ${product.name} - $${(product.price_cents / 100).toFixed(2)} (cost $${(cost_cents / 100).toFixed(2)}, margin ${margin_pct}%)`);
      created++;
    } catch (err) {
      console.error(`  ERROR: ${product.name} - ${err.message}`);
    }
  }

  console.log(`\nDatabase: ${created} created, ${skipped} skipped\n`);

  // Shopify integration
  if (!SKIP_SHOPIFY) {
    await seedShopify();
  } else {
    console.log('Shopify: skipped (run with --shopify to create Shopify products)\n');
  }

  // Verify
  const allProducts = db.listMultiboardProducts();
  console.log(`Verification: ${allProducts.length} products in multiboard_products table`);
  for (const p of allProducts) {
    console.log(`  [${p.product_category}] ${p.name} - $${(p.price_cents / 100).toFixed(2)} (${p.room_use_case})`);
  }
}

async function seedShopify() {
  let shopify;
  try {
    shopify = require('../integrations/shopify');
  } catch (e) {
    console.error('Shopify module not available:', e.message);
    return;
  }

  if (!shopify.isConfigured()) {
    console.log('Shopify: not configured (missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ACCESS_TOKEN)');
    return;
  }

  console.log('=== Creating Shopify Products ===\n');

  // Create collection
  let collectionId;
  try {
    const collection = await shopify.createCustomCollection('Multiboard Wall Organization', {
      body_html: '<p>Modular wall organization systems — snap-together tiles with hooks, bins, shelves, and more. 3D printed locally in Asheville, NC. Authorized Multiboard Reseller.</p>'
    });
    collectionId = collection.id;
    console.log(`  Collection created: ${collection.title} (ID: ${collectionId})`);
  } catch (e) {
    console.error('  Failed to create collection:', e.message);
    // Try to find existing
    try {
      const existing = await shopify.findCustomCollectionByTitle('Multiboard Wall Organization');
      if (existing) {
        collectionId = existing.id;
        console.log(`  Using existing collection: ${existing.title} (ID: ${collectionId})`);
      }
    } catch (e2) { /* ignore */ }
  }

  for (const product of ALL_PRODUCTS) {
    const existing = db.getMultiboardProduct(product.id);
    if (existing && existing.shopify_product_id) {
      console.log(`  SKIP: ${product.name} (already in Shopify: ${existing.shopify_product_id})`);
      continue;
    }

    const price = (product.price_cents / 100).toFixed(2);
    const tags = [
      'multiboard',
      product.product_category,
      `room:${product.room_use_case}`,
      product.grid_size ? `grid:${product.grid_size}` : null
    ].filter(Boolean).join(', ');

    try {
      const shopifyProduct = await shopify.createProduct({
        title: product.name,
        body_html: buildProductHtml(product),
        vendor: 'Blue Ridge Custom Co',
        product_type: 'multiboard',
        tags,
        variants: [{ price, inventory_management: 'shopify' }]
      });

      const shopifyId = shopifyProduct.id;
      const handle = shopifyProduct.handle;
      const variantId = shopifyProduct.variants && shopifyProduct.variants[0] ? shopifyProduct.variants[0].id : null;
      console.log(`  CREATE: ${product.name} (Shopify ID: ${shopifyId}, Variant: ${variantId})`);

      // Store Shopify info back in DB
      db.updateMultiboardProduct(product.id, {
        shopify_product_id: String(shopifyId),
        shopify_handle: handle,
        shopify_collection_id: collectionId ? String(collectionId) : null,
        shopify_variant_id: variantId ? String(variantId) : null
      });

      // Add to collection
      if (collectionId) {
        try {
          await shopify.addProductToCollection(shopifyId, collectionId);
          console.log(`    Added to collection`);
        } catch (e) {
          console.error(`    Failed to add to collection:`, e.message);
        }
      }

      // Publish everywhere
      try {
        const pubResult = await shopify.publishEverywhere(shopifyId);
        console.log(`    Published to ${pubResult.count} channels`);
      } catch (e) {
        console.error(`    Failed to publish:`, e.message);
      }

      // Rate limit delay
      await new Promise(r => setTimeout(r, 700));
    } catch (e) {
      console.error(`  ERROR: ${product.name} - ${e.message}`);
    }
  }
}

// Run
seedProducts().then(() => {
  console.log('\nDone.');
  process.exit(0);
}).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
