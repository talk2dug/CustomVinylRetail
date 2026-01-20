#!/usr/bin/env node
/**
 * Seed human models from the library/human-models folder into the database
 */

const path = require('path');
const fs = require('fs');

// Adjust path to db.js relative to this script
const db = require('../db');

const MODELS_DIR = path.join(__dirname, '..', '..', 'web', 'library', 'human-models');

async function seedHumanModels() {
  console.log('Seeding human models from:', MODELS_DIR);

  if (!fs.existsSync(MODELS_DIR)) {
    console.error('Human models directory not found:', MODELS_DIR);
    process.exit(1);
  }

  const files = fs.readdirSync(MODELS_DIR);
  const jpgFiles = files.filter(f => f.endsWith('.jpg') && !f.includes('_thumb'));

  console.log(`Found ${jpgFiles.length} model images`);

  // Get existing models to avoid duplicates
  const existingModels = db.listHumanModels({ activeOnly: false, limit: 10000 });
  const existingPaths = new Set(existingModels.map(m => m.file_path));

  let added = 0;
  let skipped = 0;

  for (const file of jpgFiles) {
    const baseName = file.replace('.jpg', '');
    const thumbFile = `${baseName}_thumb.jpg`;
    const hasThumb = files.includes(thumbFile);

    const filePath = `library/human-models/${file}`;
    const thumbPath = hasThumb ? `library/human-models/${thumbFile}` : null;

    // Check if already exists
    if (existingPaths.has(filePath)) {
      skipped++;
      continue;
    }

    // Generate a simple title from filename
    const title = `Human Model ${added + 1}`;

    try {
      db.createHumanModel({
        title,
        description: '',
        tags: '',
        category: 'Uncategorized',
        gender: 'unspecified',
        poseType: 'standing',
        seoFilename: baseName,
        filePath,
        optimizedPath: filePath,
        thumbnailPath: thumbPath || filePath,
        status: 'active'
      });
      added++;
      console.log(`Added: ${title} (${file})`);
    } catch (err) {
      console.error(`Failed to add ${file}:`, err.message);
    }
  }

  console.log(`\nDone! Added: ${added}, Skipped (already exists): ${skipped}`);
}

seedHumanModels().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
