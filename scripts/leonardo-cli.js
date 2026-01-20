#!/usr/bin/env node
/**
 * Leonardo.ai CLI Tool
 * Command-line interface for generating AI images
 *
 * Usage:
 *   node scripts/leonardo-cli.js generate "1967 Ford Mustang red"
 *   node scripts/leonardo-cli.js generate "modern living room" --aspect 16:9 --count 2
 *   node scripts/leonardo-cli.js prompt "Subaru WRX rally car"
 *   node scripts/leonardo-cli.js status
 *   node scripts/leonardo-cli.js history
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { LeonardoWorkflow, MODELS, ASPECT_RATIOS } = require('../server/leonardo-workflow');
const { LeonardoPromptGenerator } = require('../server/leonardo-prompt-generator');

// Parse command line arguments
const args = process.argv.slice(2);
const command = args[0];

// Parse options
function parseOptions(args) {
  const options = {};
  let keywords = [];

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];

    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = args[i + 1];

      switch (key) {
        case 'aspect':
        case 'ratio':
          options.aspectRatio = value;
          i++;
          break;
        case 'count':
        case 'num':
          options.numImages = parseInt(value, 10);
          i++;
          break;
        case 'model':
          options.model = MODELS[value.toUpperCase().replace(/-/g, '_')] || value;
          i++;
          break;
        case 'category':
          options.category = value;
          i++;
          break;
        case 'style':
          options.style = value;
          i++;
          break;
        case 'no-artwork':
          options.addToArtwork = false;
          break;
        default:
          console.warn(`Unknown option: ${arg}`);
      }
    } else {
      keywords.push(arg);
    }
  }

  return { keywords: keywords.join(' '), options };
}

// Display help
function showHelp() {
  console.log(`
Leonardo.ai CLI Tool
====================

Commands:
  generate <keywords>  Generate images from keywords (full workflow)
  prompt <keywords>    Generate a prompt only (no image generation)
  run-prompt <prompt>  Generate images from an existing prompt
  status               Check API token balance
  history              Show recent generations
  prompts              Show saved prompts
  aspects              List available aspect ratios
  models               List available models

Options:
  --aspect <ratio>     Aspect ratio (1:1, 4:3, 16:9, etc.)
  --count <num>        Number of images (1-4)
  --model <name>       Model to use (PHOENIX_1_0, LUCID_ORIGIN, etc.)
  --category <cat>     Force category (vehicle, room, model, marketing, artwork)
  --style <style>      Style hint for prompt generation
  --no-artwork         Don't add to artwork database

Examples:
  node scripts/leonardo-cli.js generate "1967 Ford Mustang Shelby GT500 red"
  node scripts/leonardo-cli.js generate "modern minimalist living room" --aspect 16:9
  node scripts/leonardo-cli.js generate "woman wearing graphic tee" --category model --count 2
  node scripts/leonardo-cli.js prompt "Subaru WRX STI rally car"
  node scripts/leonardo-cli.js status
`);
}

// List aspect ratios
function showAspects() {
  console.log('\nAvailable Aspect Ratios:');
  console.log('========================');
  Object.entries(ASPECT_RATIOS).forEach(([key, value]) => {
    console.log(`  ${key.padEnd(8)} - ${value.width}x${value.height} (${value.label})`);
  });
}

// List models
function showModels() {
  console.log('\nAvailable Models:');
  console.log('=================');
  Object.entries(MODELS).forEach(([key, value]) => {
    console.log(`  ${key.padEnd(15)} - ${value}`);
  });
}

// Main CLI handler
async function main() {
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    showHelp();
    return;
  }

  // Commands that don't need full initialization
  if (command === 'aspects') {
    showAspects();
    return;
  }

  if (command === 'models') {
    showModels();
    return;
  }

  // Check for required API keys
  if (!process.env.LEONARDO_API_KEY) {
    console.error('Error: LEONARDO_API_KEY not set in .env file');
    console.log('\nAdd this to your .env file:');
    console.log('LEONARDO_API_KEY=your-api-key-here');
    process.exit(1);
  }

  // Initialize workflow
  let workflow;
  try {
    workflow = new LeonardoWorkflow();
  } catch (error) {
    console.error('Error initializing workflow:', error.message);
    process.exit(1);
  }

  try {
    switch (command) {
      case 'generate': {
        const { keywords, options } = parseOptions(args);
        if (!keywords) {
          console.error('Error: Keywords required');
          console.log('Usage: node scripts/leonardo-cli.js generate "your keywords here"');
          process.exit(1);
        }

        console.log('\n🎨 Leonardo.ai Image Generator');
        console.log('================================');
        console.log(`Keywords: ${keywords}`);
        console.log(`Aspect Ratio: ${options.aspectRatio || '1:1'}`);
        console.log(`Images: ${options.numImages || 1}`);
        console.log('');

        const result = await workflow.run(keywords, options);

        if (result.success) {
          console.log('\n✅ Success!');
          console.log('\nGenerated Images:');
          result.images.forEach((img, i) => {
            console.log(`  ${i + 1}. ${img.filename}`);
            console.log(`     Path: ${img.localPath}`);
            console.log(`     Tags: ${img.tags.join(', ')}`);
            if (img.artworkId) {
              console.log(`     Artwork ID: ${img.artworkId}`);
            }
          });
        } else {
          console.error('\n❌ Failed:', result.error);
        }
        break;
      }

      case 'prompt': {
        const { keywords, options } = parseOptions(args);
        if (!keywords) {
          console.error('Error: Keywords required');
          process.exit(1);
        }

        const generator = new LeonardoPromptGenerator(process.env.ANTHROPIC_API_KEY);
        const result = await generator.generatePrompt(keywords, options);

        console.log('\n📝 Generated Prompt');
        console.log('===================');
        console.log(`Category: ${result.category}`);
        console.log(`\nPrompt:\n${result.prompts[0]}`);
        if (result.negativePrompt) {
          console.log(`\nNegative Prompt:\n${result.negativePrompt}`);
        }
        break;
      }

      case 'run-prompt': {
        const { keywords: prompt, options } = parseOptions(args);
        if (!prompt) {
          console.error('Error: Prompt required');
          process.exit(1);
        }

        const result = await workflow.runWithPrompt(prompt, options);

        if (result.success) {
          console.log('\n✅ Success!');
          result.images.forEach((img, i) => {
            console.log(`  ${i + 1}. ${img.filename} -> ${img.artworkId || 'no artwork'}`);
          });
        } else {
          console.error('\n❌ Failed:', result.error);
        }
        break;
      }

      case 'status': {
        console.log('\n📊 API Status');
        console.log('=============');
        const tokens = await workflow.checkTokens();
        if (tokens.error) {
          console.error('Error checking tokens:', tokens.error);
        } else {
          console.log(`Plan: ${tokens.plan || 'Unknown'}`);
          console.log(`Tokens/Slots: ${JSON.stringify(tokens, null, 2)}`);
        }

        const stats = workflow.getStats();
        console.log('\n📈 Local Statistics');
        console.log('===================');
        console.log(`Total Prompts Saved: ${stats.totalPrompts}`);
        console.log(`Total Generations: ${stats.totalGenerations}`);
        console.log(`Total Images: ${stats.totalImages}`);

        if (stats.byCategory.length > 0) {
          console.log('\nImages by Category:');
          stats.byCategory.forEach(cat => {
            console.log(`  ${cat.category || 'uncategorized'}: ${cat.count}`);
          });
        }
        break;
      }

      case 'history': {
        const generations = workflow.getRecentGenerations(20);
        console.log('\n📜 Recent Generations');
        console.log('=====================');

        if (generations.length === 0) {
          console.log('No generations yet.');
        } else {
          generations.forEach((gen, i) => {
            const date = new Date(gen.created_at).toLocaleString();
            console.log(`\n${i + 1}. [${gen.status}] ${date}`);
            console.log(`   Prompt: ${gen.prompt.substring(0, 60)}...`);
            console.log(`   Images: ${gen.image_count} | Aspect: ${gen.aspect_ratio}`);
          });
        }
        break;
      }

      case 'prompts': {
        const prompts = workflow.getPrompts({ limit: 20 });
        console.log('\n📝 Saved Prompts');
        console.log('================');

        if (prompts.length === 0) {
          console.log('No prompts saved yet.');
        } else {
          prompts.forEach((p, i) => {
            console.log(`\n${i + 1}. [${p.category}] ${p.keywords}`);
            console.log(`   ${p.prompt.substring(0, 80)}...`);
            console.log(`   Used: ${p.times_used} times`);
          });
        }
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        showHelp();
        process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  } finally {
    workflow.close();
  }
}

// Run
main().catch(console.error);
