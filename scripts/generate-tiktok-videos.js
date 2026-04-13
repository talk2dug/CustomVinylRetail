#!/usr/bin/env node
/**
 * TikTok Video Generator — Batch process catalog designs into short videos
 *
 * Takes designs from catalog.json and generates animated product videos
 * using Wan2GP on the gaming laptop GPU bridge.
 *
 * Usage:
 *   node scripts/generate-tiktok-videos.js [options]
 *
 * Options:
 *   --category <slug>   Process only one category
 *   --limit <n>         Stop after N videos
 *   --prompt <text>     Override default motion prompt
 *   --resolution <WxH>  Video resolution (default: 480x832 for TikTok portrait)
 *   --frames <n>        Number of frames (default: 41 ≈ 2.5sec)
 *   --dry-run           Show what would be generated
 *   --skip-existing     Skip designs that already have videos
 */

const fs = require('fs');
const path = require('path');

// Load .env
const envPath = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
}

const videoGen = require('../server/lib/wan2gp-video-generator');
let telegram;
try {
  telegram = require('../server/lib/telegram-notifier');
} catch (e) {
  telegram = { isConfigured: () => false };
}

// Default motion prompts by product type
const MOTION_PROMPTS = {
  'sticker': 'The sticker design gently animates with a subtle 3D rotation, light reflections move across the glossy vinyl surface revealing the texture.',
  'vinyl-decal': 'The vinyl decal gently peels and applies to a smooth surface, with light catching the edges.',
  't-shirt': 'The t-shirt design gently sways as if worn by someone walking, fabric ripples naturally.',
  'hoodie': 'The hoodie design moves slightly as the fabric shifts, subtle wind effect on the material.',
  'mug': 'The mug slowly rotates revealing the design, steam rises gently from the top.',
  'default': 'The product design gently animates with subtle movement and a soft zoom effect, revealing fine details.'
};

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    category: null,
    limit: Infinity,
    prompt: null,
    resolution: '480x832',
    frames: 41,
    dryRun: false,
    skipExisting: true,
    steps: 20,
    guidanceScale: 5.0
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--category': opts.category = args[++i]; break;
      case '--limit': opts.limit = parseInt(args[++i], 10) || Infinity; break;
      case '--prompt': opts.prompt = args[++i]; break;
      case '--resolution': opts.resolution = args[++i]; break;
      case '--frames': opts.frames = parseInt(args[++i], 10) || 41; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--skip-existing': opts.skipExisting = true; break;
      case '--no-skip': opts.skipExisting = false; break;
      case '--steps': opts.steps = parseInt(args[++i], 10) || 20; break;
      case '--guidance': opts.guidanceScale = parseFloat(args[++i]) || 5.0; break;
    }
  }
  return opts;
}

async function notify(severity, title, body) {
  try {
    if (telegram.isConfigured && telegram.isConfigured()) {
      await telegram.sendAlert(severity, title, body);
    }
  } catch (e) {
    console.warn(`[telegram] ${e.message}`);
  }
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

async function main() {
  const opts = parseArgs();
  const catalogPath = path.resolve(__dirname, '..', 'web', 'catalog.json');
  const videosDir = path.resolve(__dirname, '..', 'web', 'videos');

  if (!fs.existsSync(catalogPath)) {
    console.error('catalog.json not found at:', catalogPath);
    process.exit(1);
  }

  // Ensure output directory
  fs.mkdirSync(videosDir, { recursive: true });

  // Load catalog
  console.log('Loading catalog...');
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  let categories = catalog.categories || catalog;
  if (!Array.isArray(categories)) {
    console.error('Invalid catalog format');
    process.exit(1);
  }

  if (opts.category) {
    categories = categories.filter(c => c.slug === opts.category || c.name === opts.category);
    if (categories.length === 0) {
      console.error(`Category not found: ${opts.category}`);
      process.exit(1);
    }
  }

  // Build work queue
  const queue = [];
  for (const cat of categories) {
    if (!cat.designs || !Array.isArray(cat.designs)) continue;
    for (const design of cat.designs) {
      if (!design.image) continue;

      // Skip if video already exists
      if (opts.skipExisting) {
        const videoFile = path.join(videosDir, `${design.id}.mp4`);
        if (fs.existsSync(videoFile)) continue;
        if (design.videoPath) continue;
      }

      // Prefer classified designs (they have better metadata for prompts)
      queue.push({
        design,
        categorySlug: cat.slug,
        productType: design.productType || 'default'
      });
    }
  }

  const workItems = queue.slice(0, opts.limit);
  console.log(`\nDesigns to process: ${workItems.length}${opts.limit < queue.length ? ` (limited from ${queue.length})` : ''}`);
  console.log(`Resolution: ${opts.resolution}, Frames: ${opts.frames}, Steps: ${opts.steps}`);

  if (workItems.length === 0) {
    console.log('Nothing to process.');
    return;
  }

  if (opts.dryRun) {
    console.log('\nDRY RUN — would generate videos for:');
    for (const item of workItems.slice(0, 20)) {
      const prompt = opts.prompt || MOTION_PROMPTS[item.productType] || MOTION_PROMPTS.default;
      console.log(`  [${item.categorySlug}] ${item.design.name} (${item.design.id})`);
      console.log(`    Prompt: ${prompt.slice(0, 80)}...`);
    }
    if (workItems.length > 20) console.log(`  ... and ${workItems.length - 20} more`);
    return;
  }

  // Check if Wan2GP is accessible
  console.log('\nChecking Wan2GP...');
  const health = await videoGen.checkHealth();
  if (!health.running) {
    console.log('Wan2GP not running. Attempting to start...');
    const started = await videoGen.startWan2GP();
    if (!started) {
      console.error('Failed to start Wan2GP. Is the gaming laptop online?');
      await notify('critical', 'Video Generation Failed', 'Could not start Wan2GP on gaming laptop');
      process.exit(1);
    }
  }
  console.log('Wan2GP is ready!\n');

  await notify('info', 'TikTok Video Generation Started',
    `Videos to generate: ${workItems.length}\nResolution: ${opts.resolution}\nFrames: ${opts.frames}`
  );

  const startTime = Date.now();
  let generated = 0;
  let errors = 0;

  for (let i = 0; i < workItems.length; i++) {
    const item = workItems[i];
    const { design } = item;

    // Build motion prompt
    let prompt = opts.prompt || MOTION_PROMPTS[item.productType] || MOTION_PROMPTS.default;

    // If design has a description from classifier, enhance the prompt
    if (design.visualDescription) {
      prompt = `${design.visualDescription}. ${prompt}`;
    }

    const outputFilename = `${design.id}.mp4`;

    try {
      console.log(`[${i + 1}/${workItems.length}] Generating video for "${design.name}"...`);

      const result = await videoGen.generateVideoHeadless({
        imageUrl: design.image,
        prompt,
        resolution: opts.resolution,
        numFrames: opts.frames,
        guidanceScale: opts.guidanceScale,
        steps: opts.steps,
        outputFilename
      });

      generated++;

      // Store video path in design
      design.videoPath = `videos/${outputFilename}`;
      design.videoGeneratedAt = new Date().toISOString();

      const elapsed = Date.now() - startTime;
      const avgPerItem = elapsed / (generated + errors);
      const remaining = workItems.length - (generated + errors);
      const eta = formatDuration(avgPerItem * remaining);

      console.log(`  Done in ${result.elapsed.toFixed(0)}s -> ${result.videoPath} (ETA: ${eta})`);

      // Save catalog every 5 videos
      if (generated % 5 === 0) {
        const tmpPath = catalogPath + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(catalog, null, 2));
        fs.renameSync(tmpPath, catalogPath);
        console.log(`  [save] catalog.json updated (${generated} videos)`);
      }

      // Telegram every 10
      if ((generated + errors) % 10 === 0) {
        const pct = ((generated + errors) / workItems.length * 100).toFixed(1);
        await notify('info', `Video Batch ${Math.floor((generated + errors) / 10)}`,
          `Done: ${generated + errors}/${workItems.length} (${pct}%)\nGenerated: ${generated}, Errors: ${errors}\nETA: ${eta}`
        );
      }

    } catch (err) {
      errors++;
      console.error(`  ERROR: ${err.message}`);
    }
  }

  // Final save
  const tmpPath = catalogPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(catalog, null, 2));
  fs.renameSync(tmpPath, catalogPath);

  const totalTime = Date.now() - startTime;
  console.log('\n========================================');
  console.log('Video Generation Complete');
  console.log('========================================');
  console.log(`Generated: ${generated} / ${workItems.length}`);
  console.log(`Errors: ${errors}`);
  console.log(`Total time: ${formatDuration(totalTime)}`);

  await notify('success', 'TikTok Video Generation Complete',
    `Generated: ${generated}/${workItems.length}\nErrors: ${errors}\nTotal time: ${formatDuration(totalTime)}`
  );
}

process.on('uncaughtException', async (err) => {
  console.error('FATAL:', err);
  await notify('critical', 'Video Generation Crashed', `Error: ${err.message}`);
  process.exit(1);
});

main().catch(async (err) => {
  console.error('Failed:', err);
  await notify('critical', 'Video Generation Failed', `Error: ${err.message}`);
  process.exit(1);
});
