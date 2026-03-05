#!/usr/bin/env node
/**
 * Generate Multiboard Content Batch
 *
 * Generates 16 initial posts (4 base packages x 4 pillars) and stores
 * them in both multiboard_scheduled_content and facebook_post_content tables.
 *
 * Usage:
 *   node server/scripts/generate-multiboard-content.js [--dry-run]
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const db = require('../db');

const DRY_RUN = process.argv.includes('--dry-run');

// Load the social marketing module for generateMultiboardPost
let generateMultiboardPost;
try {
  const socialMarketing = require('../../print-station/src/social-marketing');
  generateMultiboardPost = socialMarketing.generateMultiboardPost;
} catch (e) {
  console.error('Failed to load social-marketing module:', e.message);
  console.error('Make sure ANTHROPIC_API_KEY is set in your .env file');
  process.exit(1);
}

const PILLARS = ['awareness', 'consideration', 'trust', 'conversion'];
const PILLAR_STYLES = {
  awareness: 'showcase',
  consideration: 'lifestyle',
  trust: 'quality',
  conversion: 'urgency'
};

async function generateContent() {
  console.log('=== Generating Multiboard Content Batch ===\n');

  // Load base packages only
  const products = db.listMultiboardProducts({ category: 'multiboard_base' });

  if (products.length === 0) {
    console.error('No multiboard base products found. Run seed-multiboard-products.js first.');
    process.exit(1);
  }

  console.log(`Found ${products.length} base packages:`);
  for (const p of products) {
    console.log(`  - ${p.name} (${p.room_use_case})`);
  }
  console.log();

  let generated = 0;
  let failed = 0;

  for (const product of products) {
    const room = product.room_use_case || 'general';

    for (const pillar of PILLARS) {
      const label = `${product.name} / ${pillar} / ${room}`;
      console.log(`Generating: ${label}...`);

      if (DRY_RUN) {
        console.log(`  [DRY RUN] Would generate ${pillar} post for ${product.name} (${room})`);
        generated++;
        continue;
      }

      try {
        const result = await generateMultiboardPost(product, pillar, room);

        // Store in multiboard_scheduled_content
        db.createMultiboardContent({
          product_id: product.id,
          pillar,
          room,
          post_text: result.text,
          hashtags: result.hashtags,
          style: PILLAR_STYLES[pillar]
        });

        // Also store in facebook_post_content table if available
        try {
          if (db.saveFacebookPostContent) {
            db.saveFacebookPostContent({
              campaignSlug: 'multiboard',
              productUid: product.id,
              postText: result.text,
              hashtags: result.hashtags,
              style: PILLAR_STYLES[pillar]
            });
          }
        } catch (e) {
          // Not critical — the primary table is multiboard_scheduled_content
        }

        console.log(`  OK: ${result.text.substring(0, 80)}...`);
        generated++;

        // Rate limit between API calls
        await new Promise(r => setTimeout(r, 1500));
      } catch (e) {
        console.error(`  FAIL: ${e.message}`);
        failed++;

        // Longer wait after failure (rate limit recovery)
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }

  console.log(`\n=== Content Generation Complete ===`);
  console.log(`Generated: ${generated}`);
  console.log(`Failed: ${failed}`);
  console.log(`Expected: ${products.length * PILLARS.length} (${products.length} products x ${PILLARS.length} pillars)`);

  // Verify
  const allContent = db.listMultiboardContent({});
  console.log(`\nVerification: ${allContent.length} rows in multiboard_scheduled_content`);

  // Summary by pillar
  for (const pillar of PILLARS) {
    const count = allContent.filter(c => c.pillar === pillar).length;
    console.log(`  ${pillar}: ${count} posts`);
  }
}

// Run
generateContent().then(() => {
  console.log('\nDone.');
  process.exit(0);
}).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
