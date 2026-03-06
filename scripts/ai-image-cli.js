#!/usr/bin/env node
/**
 * AI Image CLI - Command-line interface for Nano Banana (Gemini) image generation
 * Replaces scripts/leonardo-cli.js
 *
 * Usage:
 *   node scripts/ai-image-cli.js generate "1967 Ford Mustang red"
 *   node scripts/ai-image-cli.js generate "modern living room" --aspect 16:9 --count 2
 *   node scripts/ai-image-cli.js edit photo.jpg "make it look more cinematic"
 *   node scripts/ai-image-cli.js vectorize product-image.png
 *   node scripts/ai-image-cli.js scene metal-print.jpg --scene modern_living_room
 *   node scripts/ai-image-cli.js variation artwork.png "different color palette"
 *   node scripts/ai-image-cli.js status
 *   node scripts/ai-image-cli.js history
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path = require('path');

const args = process.argv.slice(2);
const command = args[0];

function printUsage() {
  console.log(`
AI Image CLI - Nano Banana (Gemini) Image Generation

Usage:
  node scripts/ai-image-cli.js <command> [options]

Commands:
  generate <keywords>          Generate images from keywords (full workflow)
    --aspect <ratio>           Aspect ratio (1:1, 4:3, 16:9, etc.) [default: 1:1]
    --count <n>                Number of images (1-4) [default: 1]
    --prompt <text>            Use exact prompt instead of keywords
    --no-artwork               Don't add to artwork table

  edit <image> <prompt>        Edit an existing image with instructions

  vectorize <image>            Enhance image to clean vector style
    --style <style>            Style: clean, bold, minimal [default: clean]

  scene <image>                Generate room scene with subject
    --scene <type>             Scene type: modern_living_room, office, bedroom,
                               gallery, restaurant, man_cave, gaming_room

  variation <image> [prompt]   Create a variation of existing artwork

  crop <image>                 Smart crop an image
    --aspect <ratio>           Target aspect ratio

  status                       Check API status and stats
  history                      Show recent generations

Examples:
  node scripts/ai-image-cli.js generate "1967 Ford Mustang, red, three-quarter view"
  node scripts/ai-image-cli.js generate "modern living room" --aspect 16:9
  node scripts/ai-image-cli.js edit photo.jpg "remove the background and make it cleaner"
  node scripts/ai-image-cli.js vectorize catalog-item.png --style bold
  node scripts/ai-image-cli.js scene metal-print.jpg --scene man_cave
  node scripts/ai-image-cli.js variation artwork.png "same style but blue color palette"
  `);
}

function getFlag(flag, defaultVal = null) {
  const idx = args.indexOf(flag);
  if (idx === -1) return defaultVal;
  return args[idx + 1] || defaultVal;
}

function hasFlag(flag) {
  return args.includes(flag);
}

async function main() {
  if (!command || command === '--help' || command === '-h') {
    printUsage();
    process.exit(0);
  }

  try {
    switch (command) {
      case 'generate': {
        const { NanoBananaWorkflow, MODELS } = require('../server/nano-banana-workflow');
        const wf = new NanoBananaWorkflow();

        const keywords = args[1];
        const promptText = getFlag('--prompt');
        const aspectRatio = getFlag('--aspect', '1:1');
        const numImages = parseInt(getFlag('--count', '1'), 10);
        const addToArtwork = !hasFlag('--no-artwork');

        if (!keywords && !promptText) {
          console.error('Error: Keywords or --prompt required');
          process.exit(1);
        }

        let result;
        if (promptText) {
          result = await wf.runWithPrompt(promptText, { aspectRatio, numImages, addToArtwork });
        } else {
          result = await wf.run(keywords, { aspectRatio, numImages, addToArtwork });
        }

        if (result.success) {
          console.log(`\nGenerated ${result.images.length} image(s):`);
          result.images.forEach(img => {
            console.log(`  - ${img.localPath}`);
          });
        } else {
          console.error(`\nError: ${result.error}`);
        }

        wf.close();
        break;
      }

      case 'edit': {
        const { NanoBananaService } = require('../server/nano-banana-service');
        const svc = new NanoBananaService();

        const imagePath = path.resolve(args[1]);
        const editPrompt = args[2];

        if (!imagePath || !editPrompt) {
          console.error('Error: Image path and edit prompt required');
          process.exit(1);
        }

        const results = await svc.editImage(imagePath, editPrompt);
        console.log(`\nEdited ${results.length} image(s):`);
        results.forEach(img => console.log(`  - ${img.localPath}`));
        break;
      }

      case 'vectorize': {
        const { NanoBananaService } = require('../server/nano-banana-service');
        const svc = new NanoBananaService();

        const imagePath = path.resolve(args[1]);
        const style = getFlag('--style', 'clean');

        if (!imagePath) {
          console.error('Error: Image path required');
          process.exit(1);
        }

        const results = await svc.vectorizeImage(imagePath, { style });
        console.log(`\nVectorized ${results.length} image(s):`);
        results.forEach(img => console.log(`  - ${img.localPath}`));
        break;
      }

      case 'scene': {
        const { MetalPrintSceneGenerator } = require('../server/metal-print-scenes');
        const gen = new MetalPrintSceneGenerator();

        const imagePath = path.resolve(args[1]);
        const sceneType = getFlag('--scene', 'modern_living_room');

        if (!imagePath) {
          console.error('Error: Image path required');
          process.exit(1);
        }

        const results = await gen.generateScene(imagePath, { sceneType });
        console.log(`\nGenerated scene (${sceneType}):`);
        results.forEach(img => console.log(`  - ${img.localPath}`));
        break;
      }

      case 'variation': {
        const { NanoBananaService } = require('../server/nano-banana-service');
        const svc = new NanoBananaService();

        const imagePath = path.resolve(args[1]);
        const variationPrompt = args[2] || null;

        if (!imagePath) {
          console.error('Error: Image path required');
          process.exit(1);
        }

        const results = await svc.createVariation(imagePath, variationPrompt);
        console.log(`\nCreated ${results.length} variation(s):`);
        results.forEach(img => console.log(`  - ${img.localPath}`));
        break;
      }

      case 'crop': {
        const { NanoBananaService } = require('../server/nano-banana-service');
        const svc = new NanoBananaService();

        const imagePath = path.resolve(args[1]);
        const targetRatio = getFlag('--aspect', '1:1');

        if (!imagePath) {
          console.error('Error: Image path required');
          process.exit(1);
        }

        const results = await svc.smartCrop(imagePath, targetRatio);
        console.log(`\nCropped to ${targetRatio}:`);
        results.forEach(img => console.log(`  - ${img.localPath}`));
        break;
      }

      case 'status': {
        const { NanoBananaWorkflow } = require('../server/nano-banana-workflow');
        const wf = new NanoBananaWorkflow();

        const status = await wf.checkStatus();
        const stats = wf.getStats();

        console.log('\nAPI Status:', JSON.stringify(status, null, 2));
        console.log('\nStats:');
        console.log(`  Prompts: ${stats.totalPrompts}`);
        console.log(`  Generations: ${stats.totalGenerations}`);
        console.log(`  Images: ${stats.totalImages}`);
        if (stats.legacyImages) {
          console.log(`  Legacy (Leonardo): ${stats.legacyImages}`);
        }
        if (stats.byCategory.length > 0) {
          console.log('\n  By Category:');
          stats.byCategory.forEach(c => console.log(`    ${c.category}: ${c.count}`));
        }

        wf.close();
        break;
      }

      case 'history': {
        const { NanoBananaWorkflow } = require('../server/nano-banana-workflow');
        const wf = new NanoBananaWorkflow();

        const limit = parseInt(getFlag('--limit', '10'), 10);
        const generations = wf.getRecentGenerations(limit);

        console.log(`\nRecent generations (${generations.length}):`);
        generations.forEach(g => {
          console.log(`  [${g.created_at}] ${g.provider || 'gemini'} | ${g.prompt?.substring(0, 60)}...`);
        });

        wf.close();
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        printUsage();
        process.exit(1);
    }
  } catch (error) {
    console.error(`\nError: ${error.message}`);
    if (process.env.DEBUG) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main();
