#!/usr/bin/env node
/**
 * Batch Catalog Classifier — LLaVA Vision AI
 *
 * Processes all designs in catalog.json through LLaVA vision model
 * to generate descriptions, categories, tags, and product types.
 *
 * Usage:
 *   node scripts/classify-catalog.js [options]
 *
 * Options:
 *   --category <slug>   Classify only one category (default: all)
 *   --force             Re-classify items that already have classifications
 *   --dry-run           Show what would be classified without calling LLaVA
 *   --delay <ms>        Delay between items (default: 500)
 *   --limit <n>         Stop after N items (for testing)
 *   --concurrency <n>   Parallel requests (default: 1, max: 3)
 */

const fs = require('fs');
const path = require('path');

// Load .env
const envPath = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
}

const catalogClassifier = require('../server/lib/catalog-classifier');
let telegram;
try {
  telegram = require('../server/lib/telegram-notifier');
} catch (e) {
  telegram = { isConfigured: () => false };
}

// Parse CLI arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    category: null,
    force: false,
    dryRun: false,
    delay: 500,
    limit: Infinity,
    concurrency: 1
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--category':
        opts.category = args[++i];
        break;
      case '--force':
        opts.force = true;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--delay':
        opts.delay = parseInt(args[++i], 10) || 500;
        break;
      case '--limit':
        opts.limit = parseInt(args[++i], 10) || Infinity;
        break;
      case '--concurrency':
        opts.concurrency = Math.min(parseInt(args[++i], 10) || 1, 6);
        break;
      default:
        if (args[i].startsWith('--')) {
          console.warn(`Unknown option: ${args[i]}`);
        }
    }
  }

  return opts;
}

/**
 * Atomic write: write to .tmp file then rename
 */
function atomicWrite(filePath, data) {
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
}

/**
 * Send Telegram notification (safe — never throws)
 */
async function notify(severity, title, body) {
  try {
    if (telegram.isConfigured && telegram.isConfigured()) {
      await telegram.sendAlert(severity, title, body);
    }
  } catch (e) {
    console.warn(`[telegram] Failed to send notification: ${e.message}`);
  }
}

/**
 * Format duration in human-readable form
 */
function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Process a batch of items concurrently
 */
async function processBatch(items, categorySlug, opts) {
  const results = [];
  for (const design of items) {
    try {
      const result = await catalogClassifier.classifyDesign(design, {
        currentCategory: categorySlug,
        timeout: 120000
      });
      results.push({ design, result, error: null });
    } catch (e) {
      results.push({ design, result: null, error: e.message });
    }
  }
  return results;
}

async function main() {
  const opts = parseArgs();
  const catalogPath = path.resolve(__dirname, '..', 'web', 'catalog.json');

  if (!fs.existsSync(catalogPath)) {
    console.error('catalog.json not found at:', catalogPath);
    process.exit(1);
  }

  // Load catalog
  console.log('Loading catalog.json...');
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

  if (!catalog.categories || !Array.isArray(catalog.categories)) {
    console.error('Invalid catalog format: missing categories array');
    process.exit(1);
  }

  // Filter categories
  let categories = catalog.categories;
  if (opts.category) {
    categories = categories.filter(c => c.slug === opts.category || c.name === opts.category);
    if (categories.length === 0) {
      console.error(`Category not found: ${opts.category}`);
      console.log('Available:', catalog.categories.map(c => c.slug).join(', '));
      process.exit(1);
    }
  }

  // Build work queue — designs needing classification
  const queue = [];
  for (const cat of categories) {
    if (!cat.designs || !Array.isArray(cat.designs)) continue;
    for (const design of cat.designs) {
      if (!opts.force && design.classifiedAt) continue; // already classified
      if (!design.image) continue; // no image to analyze
      queue.push({ design, categorySlug: cat.slug });
    }
  }

  // Apply limit
  const workItems = queue.slice(0, opts.limit);
  const totalDesigns = catalog.categories.reduce((sum, c) => sum + (c.designs?.length || 0), 0);
  const alreadyClassified = totalDesigns - queue.length;

  console.log(`\nCatalog: ${totalDesigns} total designs across ${catalog.categories.length} categories`);
  console.log(`Already classified: ${alreadyClassified}`);
  console.log(`To classify: ${workItems.length}${opts.limit < queue.length ? ` (limited from ${queue.length})` : ''}`);
  console.log(`Concurrency: ${opts.concurrency}, Delay: ${opts.delay}ms`);
  if (opts.force) console.log('Force mode: re-classifying all items');
  if (opts.dryRun) console.log('DRY RUN: no changes will be made');
  console.log('');

  if (workItems.length === 0) {
    console.log('Nothing to classify. Use --force to re-classify existing items.');
    return;
  }

  if (opts.dryRun) {
    console.log('Items that would be classified:');
    for (const item of workItems.slice(0, 50)) {
      console.log(`  - [${item.categorySlug}] ${item.design.name} (${item.design.id})`);
    }
    if (workItems.length > 50) console.log(`  ... and ${workItems.length - 50} more`);
    return;
  }

  // Send start notification
  await notify('info', 'Catalog Classification Started',
    `Items to classify: ${workItems.length}\n` +
    `Category filter: ${opts.category || 'all'}\n` +
    `Concurrency: ${opts.concurrency}`
  );

  const startTime = Date.now();
  let classified = 0;
  let errors = 0;
  let lastSaveAt = 0;
  // Notify every 10 items
  const milestoneInterval = 10;
  let nextMilestone = milestoneInterval;
  const categoryCompletionTracker = {};

  // Track last 10 outcomes for milestone notifications
  let recentResults = [];

  // Track per-category progress
  for (const cat of categories) {
    if (!cat.designs) continue;
    const total = cat.designs.length;
    const done = cat.designs.filter(d => d.classifiedAt).length;
    const remaining = cat.designs.filter(d => !d.classifiedAt && d.image).length;
    categoryCompletionTracker[cat.slug] = { total, done, remaining };
  }

  // Process items
  for (let i = 0; i < workItems.length; i += opts.concurrency) {
    const batch = workItems.slice(i, i + opts.concurrency);

    const results = await processBatch(
      batch.map(b => b.design),
      batch[0].categorySlug,
      opts
    );

    // Apply results to catalog
    for (let j = 0; j < results.length; j++) {
      const { design, result, error } = results[j];
      const item = batch[j];

      if (error) {
        errors++;
        recentResults.push({ name: design.name, error: true, category: item.categorySlug });
        console.error(`  [${classified + errors}/${workItems.length}] ERROR "${design.name}": ${error}`);
        continue;
      }

      // Store classification in the design object (mutates catalog in memory)
      design.visualDescription = result.description;
      design.suggestedCategory = result.suggestedCategory;
      design.tags = result.tags;
      design.productType = result.productType;
      design.classifiedAt = result.classifiedAt;

      classified++;

      // Track recent result for milestone notification
      recentResults.push({
        name: design.name,
        error: false,
        category: result.suggestedCategory,
        productType: result.productType,
        tags: result.tags,
        description: result.description
      });

      // Track category completion
      if (categoryCompletionTracker[item.categorySlug]) {
        categoryCompletionTracker[item.categorySlug].done++;
        categoryCompletionTracker[item.categorySlug].remaining--;
      }

      const elapsed = Date.now() - startTime;
      const avgPerItem = elapsed / (classified + errors);
      const remaining = workItems.length - (classified + errors);
      const eta = formatDuration(avgPerItem * remaining);

      console.log(
        `  [${classified + errors}/${workItems.length}] Classified "${design.name}" -> ` +
        `${result.suggestedCategory}, ${result.productType}, ${result.tags.length} tags ` +
        `(ETA: ${eta})`
      );

      // Check category completion
      const tracker = categoryCompletionTracker[item.categorySlug];
      if (tracker && tracker.remaining === 0) {
        // Find all tags for this category
        const catObj = categories.find(c => c.slug === item.categorySlug);
        const allTags = {};
        if (catObj && catObj.designs) {
          for (const d of catObj.designs) {
            if (d.tags) d.tags.forEach(t => { allTags[t] = (allTags[t] || 0) + 1; });
          }
        }
        const topTags = Object.entries(allTags)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([t]) => t);

        await notify('success', `Category Complete: ${item.categorySlug}`,
          `Classified: ${tracker.total} items\nTop tags: ${topTags.join(', ')}`
        );
      }
    }

    // Incremental save every 10 classified items
    if (classified - lastSaveAt >= 10) {
      atomicWrite(catalogPath, catalog);
      lastSaveAt = classified;
      console.log(`  [save] catalog.json saved (${classified} classified so far)`);
    }

    // Milestone notification every 10 items — includes outcomes
    if (classified + errors >= nextMilestone) {
      const elapsed = Date.now() - startTime;
      const avgPerItem = elapsed / (classified + errors);
      const remaining = workItems.length - (classified + errors);
      const eta = formatDuration(avgPerItem * remaining);
      const pct = ((classified + errors) / workItems.length * 100).toFixed(1);

      // Build outcome summary from last 10
      const batchErrors = recentResults.filter(r => r.error).length;
      const batchOk = recentResults.filter(r => !r.error);
      let outcomeLines = batchOk.map(r =>
        `  "${r.name}" -> ${r.category}, ${r.productType}, ${r.tags.length} tags`
      ).join('\n');
      if (batchErrors > 0) {
        outcomeLines += `\n  (${batchErrors} errors)`;
      }

      // Collect unique categories and product types from batch
      const batchCats = [...new Set(batchOk.map(r => r.category))].join(', ');
      const batchTypes = [...new Set(batchOk.map(r => r.productType))].join(', ');

      await notify('info', `Classification Batch ${Math.floor(nextMilestone / 10)}`,
        `Done: ${classified + errors} / ${workItems.length} (${pct}%)\n` +
        `Avg: ${(avgPerItem / 1000).toFixed(1)}s/item | ETA: ${eta}\n` +
        `Errors so far: ${errors}\n\n` +
        `Last ${recentResults.length} items:\n${outcomeLines}\n\n` +
        `Categories: ${batchCats}\nTypes: ${batchTypes}`
      );

      // Reset recent results for next batch
      recentResults = [];
      nextMilestone += milestoneInterval;
    }

    // Delay between batches
    if (i + opts.concurrency < workItems.length && opts.delay > 0) {
      await sleep(opts.delay);
    }
  }

  // Final save
  atomicWrite(catalogPath, catalog);
  console.log(`\n[save] Final catalog.json save complete`);

  const totalTime = Date.now() - startTime;

  // Summary
  console.log('\n========================================');
  console.log('Classification Complete');
  console.log('========================================');
  console.log(`Classified: ${classified} / ${workItems.length}`);
  console.log(`Errors: ${errors}`);
  console.log(`Total time: ${formatDuration(totalTime)}`);
  if (classified > 0) {
    console.log(`Avg time per item: ${((totalTime / (classified + errors)) / 1000).toFixed(1)}s`);
  }

  // Top categories breakdown
  const categoryCounts = {};
  for (const cat of catalog.categories) {
    if (!cat.designs) continue;
    for (const d of cat.designs) {
      if (d.suggestedCategory) {
        categoryCounts[d.suggestedCategory] = (categoryCounts[d.suggestedCategory] || 0) + 1;
      }
    }
  }
  const topCats = Object.entries(categoryCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([cat, count]) => `${cat} (${count})`)
    .join(', ');

  if (topCats) console.log(`Top categories: ${topCats}`);

  // Send completion notification
  await notify('success', 'Catalog Classification Complete',
    `Classified: ${classified} / ${workItems.length}\n` +
    `Errors: ${errors}\n` +
    `Total time: ${formatDuration(totalTime)}\n` +
    (topCats ? `Top categories: ${topCats}` : '')
  );
}

// Handle uncaught errors
process.on('uncaughtException', async (err) => {
  console.error('FATAL:', err);
  await notify('critical', 'Classification Stopped', `Fatal error: ${err.message}`);
  process.exit(1);
});

process.on('unhandledRejection', async (err) => {
  console.error('FATAL (unhandled rejection):', err);
  await notify('critical', 'Classification Stopped', `Unhandled rejection: ${err.message || err}`);
  process.exit(1);
});

main().catch(async (err) => {
  console.error('Classification failed:', err);
  await notify('critical', 'Classification Stopped', `Error: ${err.message}`);
  process.exit(1);
});
