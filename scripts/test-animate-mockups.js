#!/usr/bin/env node
/**
 * Test: Animate the two existing apparel mockups from the database
 * Uses their metadata (human_model_id → gender) to pick motion prompts
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const APP_ROOT = '/home/ubuntu/vinylApp';
const envPath = path.join(APP_ROOT, '.env');
if (fs.existsSync(envPath)) require('dotenv').config({ path: envPath });

const Database = require('better-sqlite3');
const videoGen = require(path.join(APP_ROOT, 'server/lib/wan2gp-video-generator'));
const telegram = require(path.join(APP_ROOT, 'server/lib/telegram-notifier'));

const DB_PATH = path.join(APP_ROOT, 'data', 'store.db');
const OUTPUT_DIR = '/mnt/dbFiles/animated-mockups';

// Motion prompts (from animate-mockups.js)
const MOTION_PROMPTS = {
  female: {
    twirl: [
      'The young woman does a playful half-spin showing off her graphic t-shirt, her hair catches the light, she smiles naturally at the camera.',
      'She twirls around with a carefree smile, the t-shirt design clearly visible, natural movement with slight hair bounce.',
    ],
    smile: [
      'The woman makes warm eye contact with the camera, does a slight head tilt, and gently adjusts her shirt hem to show the design.',
    ],
    shirt_pull: [
      'She grabs the hem of her t-shirt and pulls it taut to display the graphic design clearly, then releases with a smile.',
    ],
    girly: [
      'She does a cute shoulder shimmy, flashes a peace sign, and does a little bounce on her toes showing the shirt design.',
    ],
  },
  male: {
    shuffle: [
      'The guy does a cool side-to-side step, gives a slight nod, hands moving in and out of pockets, the shirt design clearly visible.',
    ],
    smile: [
      'He gives a confident grin at the camera, crosses his arms briefly showing the t-shirt design, then relaxes into a casual stance.',
    ],
  }
};

function pickMotion(gender) {
  const types = Object.keys(MOTION_PROMPTS[gender]);
  const type = types[Math.floor(Math.random() * types.length)];
  const variants = MOTION_PROMPTS[gender][type];
  return { motionType: type, prompt: variants[Math.floor(Math.random() * variants.length)] };
}

async function main() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // Ensure animated_mockups table exists
  db.exec(`CREATE TABLE IF NOT EXISTS animated_mockups (
    id TEXT PRIMARY KEY, design_id TEXT, design_url TEXT, human_model_id TEXT,
    mockup_path TEXT, video_path TEXT, video_url TEXT, engine TEXT,
    animation_type TEXT, motion_prompt TEXT, motion_type TEXT, gender TEXT,
    apparel_type TEXT, clothing_color TEXT, duration_seconds REAL, resolution TEXT,
    status TEXT DEFAULT 'pending', error_message TEXT, marketing_metadata TEXT,
    marketing_status TEXT DEFAULT 'pending', created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT
  )`);

  // Get the two mockups
  const mockups = db.prepare(`
    SELECT m.*, hm.gender, hm.apparel_type as model_apparel
    FROM custom_art_mockups m
    LEFT JOIN human_models hm ON m.human_model_id = hm.id
    WHERE m.mockup_type = 'apparel-ai'
    ORDER BY m.created_at DESC
    LIMIT 2
  `).all();

  console.log('========================================');
  console.log('  Test: Animate Existing Apparel Mockups');
  console.log('========================================');
  console.log(`Found ${mockups.length} mockups to animate\n`);

  if (mockups.length === 0) {
    console.log('No apparel mockups found!');
    process.exit(1);
  }

  await telegram.sendAlert('info', 'Animated Mockup Test Started',
    `Testing with ${mockups.length} existing apparel mockups`);

  const insertStmt = db.prepare(`
    INSERT INTO animated_mockups (id, design_id, design_url, human_model_id, mockup_path,
      video_path, video_url, engine, animation_type, motion_prompt, motion_type,
      gender, apparel_type, clothing_color, duration_seconds, resolution,
      status, error_message, marketing_metadata, marketing_status, created_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (let i = 0; i < mockups.length; i++) {
    const m = mockups[i];
    const gender = m.gender || 'female';
    const { motionType, prompt } = pickMotion(gender);
    const recordId = crypto.randomUUID();

    console.log(`[${i + 1}/${mockups.length}] ${m.title}`);
    console.log(`  Gender: ${gender} | Garment: ${m.garment_type} | Color: ${m.clothing_color}`);
    console.log(`  Motion: ${motionType}`);
    console.log(`  Prompt: ${prompt.slice(0, 80)}...`);

    // Resolve mockup image path
    let mockupPath = m.file_path;
    if (!fs.existsSync(mockupPath)) {
      // Try /mnt/dbFiles/apparel-mockups/
      mockupPath = path.join('/mnt/dbFiles/apparel-mockups', m.filename);
    }
    if (!fs.existsSync(mockupPath)) {
      console.error(`  ERROR: Image not found at ${mockupPath}`);
      continue;
    }
    console.log(`  Image: ${mockupPath}`);

    try {
      const videoFilename = `video_${recordId}.mp4`;
      const videoPath = path.join(OUTPUT_DIR, videoFilename);

      console.log(`  Generating video via Wan2GP...`);
      const startTime = Date.now();

      const result = await videoGen.generateVideoHeadless({
        imagePath: mockupPath,
        prompt: prompt,
        resolution: '480x832',
        numFrames: 41,
        guidanceScale: 5.0,
        steps: 20,
        outputFilename: videoFilename
      });

      // Move video to output dir
      if (result.videoPath !== videoPath) {
        fs.copyFileSync(result.videoPath, videoPath);
        try { fs.unlinkSync(result.videoPath); } catch {}
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log(`  Video generated in ${elapsed}s: ${videoPath}`);

      // Marketing metadata sidecar
      const meta = {
        videoPath,
        designId: m.id,
        designName: m.graphic_name || m.title,
        designTags: m.tags ? JSON.parse(m.tags) : [],
        category: 'apparel-mockup',
        gender,
        motionType,
        apparelType: m.garment_type || 't-shirt',
        suggestedHashtags: ['#tshirt', '#graphictee', '#ootd', '#fashiontok', '#streetstyle'],
        suggestedCaption: `Check out this ${m.garment_type || 't-shirt'} design! ${m.title}`,
        status: 'ready_for_marketing'
      };
      const metaPath = path.join(OUTPUT_DIR, `${path.basename(videoFilename, '.mp4')}.meta.json`);
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      console.log(`  Meta: ${metaPath}`);

      // DB record
      const now = new Date().toISOString();
      insertStmt.run(
        recordId, m.id, null, m.human_model_id, mockupPath,
        videoPath, null, 'wan2gp', 'single', prompt, motionType,
        gender, m.garment_type || 't-shirt', m.clothing_color || null,
        2.5, '480x832',
        'completed', null, JSON.stringify(meta), 'pending', now, now
      );
      console.log(`  DB record: ${recordId}`);

      // Telegram
      await telegram.sendAlert('success', `Test Mockup ${i + 1}/${mockups.length}`,
        `Title: ${m.title}\nGender: ${gender}\nMotion: ${motionType}\nTime: ${elapsed}s\nVideo: ${videoPath}`);

    } catch (err) {
      console.error(`  ERROR: ${err.message}`);
      const now = new Date().toISOString();
      insertStmt.run(
        recordId, m.id, null, m.human_model_id, mockupPath,
        null, null, 'wan2gp', 'single', prompt, motionType,
        gender, m.garment_type || 't-shirt', m.clothing_color || null,
        null, null,
        'failed', err.message, null, 'pending', now, null
      );
      await telegram.sendAlert('warning', 'Test Mockup Error', `${m.title}: ${err.message}`);
    }
  }

  // Final check
  const results = db.prepare('SELECT id, status, video_path, motion_type FROM animated_mockups ORDER BY created_at DESC LIMIT 2').all();
  console.log('\n========================================');
  console.log('  Results');
  console.log('========================================');
  for (const r of results) {
    console.log(`  ${r.id} | ${r.status} | ${r.motion_type} | ${r.video_path || 'N/A'}`);
  }

  // Check files
  const files = fs.readdirSync(OUTPUT_DIR).filter(f => f.endsWith('.mp4') || f.endsWith('.meta.json'));
  console.log(`\nOutput files in ${OUTPUT_DIR}:`);
  for (const f of files) {
    const stat = fs.statSync(path.join(OUTPUT_DIR, f));
    console.log(`  ${f} (${(stat.size / 1024).toFixed(0)}KB)`);
  }

  await telegram.sendAlert('success', 'Animated Mockup Test Complete',
    `Processed: ${mockups.length} mockups\nCheck ${OUTPUT_DIR} for videos`);

  db.close();
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
