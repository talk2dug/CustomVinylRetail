#!/usr/bin/env node
/**
 * Animated Apparel Mockup Pipeline
 *
 * Generates animated product videos from catalog designs + human model photos.
 * Composites designs onto models via AiApparelMockupService, then animates
 * via Wan2GP (local GPU) or Veo 3.1 (cloud).
 *
 * Usage:
 *   node scripts/animate-mockups.js [options]
 *
 * Options:
 *   --design-url <url>         Single design by URL
 *   --design-id <id>           Single design by catalog ID
 *   --category <slug>          Batch by category
 *   --limit <n>                Max videos (default: Infinity)
 *   --gender <male|female>     Filter human models
 *   --apparel <t-shirt|hoodie> Filter by apparel type
 *   --engine <wan2gp|veo31|auto>  Video engine (default: auto)
 *   --animation <single|turnaround>  Animation style (default: single)
 *   --motion <twirl|smile|...> Specific motion type (default: random)
 *   --color <hex>              Recolor garment (e.g., #ff0000)
 *   --dry-run                  Preview only, don't generate
 *   --skip-existing            Skip designs that already have animated mockups
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync, exec } = require('child_process');

// App root
const APP_ROOT = path.resolve(__dirname, '..');

// Load .env
const envPath = path.join(APP_ROOT, '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
}

const Database = require('better-sqlite3');
const { AiApparelMockupService } = require('../server/ai-apparel-mockup');
const videoGen = require('../server/lib/wan2gp-video-generator');

let telegram;
try {
  telegram = require('../server/lib/telegram-notifier');
} catch (e) {
  telegram = { isConfigured: () => false, sendMessage: async () => null, sendAlert: async () => null, sendPhoto: async () => null };
}

// ─── Constants ────────────────────────────────────────────────────────────────

const OUTPUT_DIR = '/mnt/dbFiles/animated-mockups';
const VEO_COUNT_FILE = path.join(APP_ROOT, 'data', 'veo-daily-count.json');
const VEO_DAILY_LIMIT = 5;
const COMPOSITING_DELAY_MS = 2500; // Between Gemini compositing calls
const DB_PATH = path.join(APP_ROOT, 'data', 'store.db');

// ─── Motion Prompt Library ───────────────────────────────────────────────────

const MOTION_PROMPTS = {
  female: {
    twirl: [
      'The young woman does a playful half-spin showing off her graphic t-shirt, her hair catches the light, she smiles naturally at the camera.',
      'She twirls around with a carefree smile, the t-shirt design clearly visible, natural movement with slight hair bounce.',
      'A fun half-turn showing the shirt design, she laughs and does a cute pose at the end, relaxed energy.'
    ],
    smile: [
      'The woman makes warm eye contact with the camera, does a slight head tilt, and gently adjusts her shirt hem to show the design.',
      'She smiles confidently at the camera, shifts her weight casually, the graphic on her shirt is clearly displayed.',
      'Natural smile with a small wave, she looks down at her shirt proudly then back at the camera.'
    ],
    shirt_pull: [
      'She grabs the hem of her t-shirt and pulls it taut to display the graphic design clearly, then releases with a smile.',
      'The woman stretches her shirt flat to show off the design, gives a thumbs up, then lets the fabric relax.',
      'She pinches the bottom of her shirt and pulls it forward to show the print, then drops it with a playful grin.'
    ],
    girly: [
      'She does a cute shoulder shimmy, flashes a peace sign, and does a little bounce on her toes showing the shirt design.',
      'A playful little dance move, she points at the shirt graphic and does a cheerful head bob.',
      'She bounces lightly, waves at the camera, and strikes a cute pose showing off the t-shirt.'
    ],
    turnaround: [
      'She starts with her back to the camera then slowly turns around to reveal the graphic t-shirt design on the front, ending with a confident smile.',
      'Starting facing away, she gracefully spins to face the camera, the shirt design comes into full view as she completes the turn.',
      'With her back initially to the camera, she pivots smoothly to show the front of her graphic tee, finishing with a casual pose.'
    ]
  },
  male: {
    shuffle: [
      'The guy does a cool side-to-side step, gives a slight nod, hands moving in and out of pockets, the shirt design clearly visible.',
      'He shuffles casually side to side, confident stance, adjusts his collar, the graphic tee on full display.',
      'A relaxed side-step shuffle, he crosses his arms briefly then drops them, showing the shirt design.'
    ],
    smile: [
      'He gives a confident grin at the camera, crosses his arms briefly showing the t-shirt design, then relaxes into a casual stance.',
      'The man smiles naturally, shifts his weight, the graphic on his shirt is clearly displayed as he stands confidently.',
      'A relaxed smile with a subtle nod, he adjusts his shirt slightly to show the design.'
    ],
    hair: [
      'He runs his hand through his hair with a slight smile, casual and confident, the graphic t-shirt design is visible throughout.',
      'A cool hand-through-hair move, he looks off camera then back with a relaxed grin, shirt design on display.',
      'He pushes his hair back casually, drops his hand to his side, and gives a confident look showing the tee design.'
    ],
    turnaround: [
      'He starts with his back to the camera, then turns smoothly to face forward revealing the graphic t-shirt design, ending with a confident stance.',
      'Starting facing away, he pivots around to show the front of his graphic tee, finishing with arms slightly crossed.',
      'With his back to camera initially, he casually turns to reveal the shirt design, ending with a relaxed nod.'
    ]
  }
};

// Motion types available per gender
const MOTION_TYPES = {
  female: ['twirl', 'smile', 'shirt_pull', 'girly', 'turnaround'],
  male: ['shuffle', 'smile', 'hair', 'turnaround']
};

// ─── CLI Parsing ─────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    designUrl: null,
    designId: null,
    category: null,
    limit: Infinity,
    gender: null,       // male, female, or null for random
    apparel: null,      // t-shirt, hoodie, etc.
    engine: 'auto',     // wan2gp, veo31, auto
    animation: 'single', // single or turnaround
    motion: null,       // specific motion type or null for random
    color: null,        // hex color for garment recoloring
    dryRun: false,
    skipExisting: false
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--design-url': opts.designUrl = args[++i]; break;
      case '--design-id': opts.designId = args[++i]; break;
      case '--category': opts.category = args[++i]; break;
      case '--limit': opts.limit = parseInt(args[++i], 10) || Infinity; break;
      case '--gender': opts.gender = args[++i]; break;
      case '--apparel': opts.apparel = args[++i]; break;
      case '--engine': opts.engine = args[++i]; break;
      case '--animation': opts.animation = args[++i]; break;
      case '--motion': opts.motion = args[++i]; break;
      case '--color': opts.color = args[++i]; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--skip-existing': opts.skipExisting = true; break;
      default:
        if (args[i].startsWith('-')) {
          console.error(`Unknown option: ${args[i]}`);
          process.exit(1);
        }
    }
  }

  return opts;
}

// ─── Database ────────────────────────────────────────────────────────────────

function initDatabase(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS animated_mockups (
      id TEXT PRIMARY KEY,
      design_id TEXT,
      design_url TEXT,
      human_model_id TEXT,
      mockup_path TEXT,
      video_path TEXT,
      video_url TEXT,
      engine TEXT,
      animation_type TEXT,
      motion_prompt TEXT,
      motion_type TEXT,
      gender TEXT,
      apparel_type TEXT,
      clothing_color TEXT,
      duration_seconds REAL,
      resolution TEXT,
      status TEXT DEFAULT 'pending',
      error_message TEXT,
      marketing_metadata TEXT,
      marketing_status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    )
  `);

  // Create indexes for common queries
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_animated_mockups_design_id ON animated_mockups(design_id);
    CREATE INDEX IF NOT EXISTS idx_animated_mockups_status ON animated_mockups(status);
    CREATE INDEX IF NOT EXISTS idx_animated_mockups_engine ON animated_mockups(engine);
    CREATE INDEX IF NOT EXISTS idx_animated_mockups_marketing ON animated_mockups(marketing_status);
  `);
}

// ─── Veo 3.1 Rate Limiting ──────────────────────────────────────────────────

function getVeoDailyCount() {
  try {
    if (!fs.existsSync(VEO_COUNT_FILE)) return { date: '', count: 0 };
    const data = JSON.parse(fs.readFileSync(VEO_COUNT_FILE, 'utf8'));
    const today = new Date().toISOString().slice(0, 10);
    if (data.date !== today) return { date: today, count: 0 };
    return data;
  } catch {
    return { date: '', count: 0 };
  }
}

function incrementVeoCount() {
  const today = new Date().toISOString().slice(0, 10);
  const data = getVeoDailyCount();
  if (data.date !== today) {
    data.date = today;
    data.count = 0;
  }
  data.count++;
  fs.writeFileSync(VEO_COUNT_FILE, JSON.stringify(data, null, 2));
  return data.count;
}

function canUseVeo() {
  const data = getVeoDailyCount();
  const today = new Date().toISOString().slice(0, 10);
  if (data.date !== today) return true;
  return data.count < VEO_DAILY_LIMIT;
}

// ─── GPU Contention Check ────────────────────────────────────────────────────

function isClassifierRunning() {
  try {
    const result = execSync(
      `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no swayze@100.64.0.13 "tasklist /fi \\"imagename eq python.exe\\" /fo csv /nh 2>nul"`,
      { timeout: 10000 }
    ).toString();
    // Check if ollama or llava processes are active (classifier uses llava via Ollama)
    const ollamaResult = execSync(
      `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no swayze@100.64.0.13 "tasklist /fi \\"imagename eq ollama_llama_server.exe\\" /fo csv /nh 2>nul"`,
      { timeout: 10000 }
    ).toString();
    return ollamaResult.includes('ollama_llama_server');
  } catch {
    return false; // Can't check — assume it's fine
  }
}

// ─── Model Selection ─────────────────────────────────────────────────────────

function selectHumanModel(db, opts = {}) {
  const { gender, apparel, animation } = opts;
  let sql = 'SELECT * FROM human_models WHERE active = 1';
  const params = [];

  if (gender) {
    sql += ' AND gender = ?';
    params.push(gender);
  }
  if (apparel) {
    sql += ' AND apparel_type = ?';
    params.push(apparel);
  }
  // For turnaround, prefer front-facing models (we'll synthesize the back-facing start)
  if (animation === 'turnaround') {
    sql += ' AND facing = ?';
    params.push('front');
  }

  sql += ' ORDER BY RANDOM() LIMIT 1';
  return db.prepare(sql).get(...params);
}

// ─── Motion Prompt Selection ─────────────────────────────────────────────────

function selectMotionPrompt(gender, motionType) {
  const genderPrompts = MOTION_PROMPTS[gender];
  if (!genderPrompts) {
    throw new Error(`No prompts for gender: ${gender}`);
  }

  // If no motion type specified, pick random (non-turnaround unless specifically asked)
  if (!motionType) {
    const types = MOTION_TYPES[gender].filter(t => t !== 'turnaround');
    motionType = types[Math.floor(Math.random() * types.length)];
  }

  const variants = genderPrompts[motionType];
  if (!variants || variants.length === 0) {
    throw new Error(`No prompt variants for ${gender}/${motionType}`);
  }

  const prompt = variants[Math.floor(Math.random() * variants.length)];
  return { motionType, prompt };
}

// ─── Engine Selection ────────────────────────────────────────────────────────

function selectEngine(opts) {
  if (opts.engine !== 'auto') return opts.engine;

  // Turnaround animations → prefer Veo 3.1 (better at frame interpolation)
  if (opts.animation === 'turnaround' && canUseVeo()) {
    return 'veo31';
  }

  // Everything else → Wan2GP (unlimited, local GPU)
  return 'wan2gp';
}

// ─── Design Fetching ─────────────────────────────────────────────────────────

function getDesignsFromCatalog(db, opts) {
  const designs = [];

  if (opts.designUrl) {
    // Single design by URL
    designs.push({
      id: crypto.randomUUID().slice(0, 8),
      url: opts.designUrl,
      name: path.basename(opts.designUrl, path.extname(opts.designUrl)),
      tags: [],
      category: 'custom'
    });
    return designs;
  }

  if (opts.designId) {
    // Look up from catalog in DB
    const row = db.prepare('SELECT * FROM catalog WHERE id = ?').get(opts.designId);
    if (!row) {
      console.error(`Design not found: ${opts.designId}`);
      process.exit(1);
    }
    designs.push({
      id: row.id,
      url: row.preview_url || row.image_url || row.url,
      name: row.name || row.title || opts.designId,
      tags: row.tags ? JSON.parse(row.tags) : [],
      category: row.category || row.suggestedCategory || 'uncategorized'
    });
    return designs;
  }

  // Batch by category from catalog.json
  const catalogPath = path.join(APP_ROOT, 'web', 'catalog.json');
  if (!fs.existsSync(catalogPath)) {
    console.error('catalog.json not found');
    process.exit(1);
  }

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

  for (const cat of categories) {
    if (!cat.designs || !Array.isArray(cat.designs)) continue;
    for (const d of cat.designs) {
      if (!d.image) continue;

      if (opts.skipExisting) {
        const existing = db.prepare('SELECT id FROM animated_mockups WHERE design_id = ? AND status = ?').get(d.id, 'completed');
        if (existing) continue;
      }

      designs.push({
        id: d.id,
        url: d.image,
        name: d.name || d.id,
        tags: d.tags ? (typeof d.tags === 'string' ? JSON.parse(d.tags) : d.tags) : [],
        category: cat.slug,
        visualDescription: d.visualDescription,
        suggestedCategory: d.suggestedCategory
      });
    }
  }

  return designs.slice(0, opts.limit);
}

// ─── Marketing Metadata ─────────────────────────────────────────────────────

function generateMarketingMeta(design, model, motionType, apparelType) {
  const tags = Array.isArray(design.tags) ? design.tags : [];
  const category = design.suggestedCategory || design.category || 'custom';

  // Generate hashtags from tags and category (max 5 for TikTok)
  const hashtagPool = [
    ...tags.map(t => `#${t.replace(/\s+/g, '').toLowerCase()}`),
    `#${apparelType.replace(/[- ]/g, '')}`,
    `#${category.replace(/[- ]/g, '')}`,
    '#graphictee', '#ootd', '#fashiontok', '#tshirtdesign', '#streetstyle'
  ];
  // Deduplicate and limit to 5
  const hashtags = [...new Set(hashtagPool)].slice(0, 5);

  // Auto-generate caption from design name + tags
  const caption = tags.length > 0
    ? `Check out this ${tags.slice(0, 3).join(', ')} design! ${hashtags.join(' ')}`
    : `New ${apparelType} drop! ${design.name} ${hashtags.join(' ')}`;

  return {
    designId: design.id,
    designName: design.name,
    designTags: tags,
    category,
    gender: model.gender || 'unisex',
    motionType,
    apparelType,
    suggestedHashtags: hashtags,
    suggestedCaption: caption,
    status: 'ready_for_marketing'
  };
}

// ─── Video Generation ────────────────────────────────────────────────────────

async function generateWithWan2GP(mockupPath, motionPrompt, outputPath) {
  const result = await videoGen.generateVideoHeadless({
    imagePath: mockupPath,
    prompt: motionPrompt,
    resolution: '480x832',
    numFrames: 41,
    guidanceScale: 5.0,
    steps: 20,
    outputFilename: path.basename(outputPath)
  });

  // Move to final location if different
  if (result.videoPath !== outputPath) {
    fs.copyFileSync(result.videoPath, outputPath);
    try { fs.unlinkSync(result.videoPath); } catch {}
  }

  return { duration: (41 / 16).toFixed(1), resolution: '480x832' };
}

async function generateWithVeo31(mockupPath, motionPrompt, outputPath, animation) {
  const scriptPath = path.join(APP_ROOT, 'scripts', 'veo31-interpolate.py');

  const args = [
    'python3', scriptPath,
    '--first-frame', mockupPath,
    '--prompt', motionPrompt,
    '--output', outputPath,
    '--duration', '8',
    '--aspect-ratio', '9:16'
  ];

  return new Promise((resolve, reject) => {
    const child = exec(args.join(' '), {
      timeout: 600000, // 10 minutes
      maxBuffer: 5 * 1024 * 1024,
      env: { ...process.env, GEMINI_API_KEY: process.env.GEMINI_API_KEY }
    }, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(`Veo 3.1 failed: ${stderr || err.message}`));
      }

      // Parse result JSON from stdout
      const jsonMatch = stdout.match(/__RESULT_JSON__:(.+)/);
      if (jsonMatch) {
        try {
          const result = JSON.parse(jsonMatch[1]);
          incrementVeoCount();
          resolve({ duration: '8.0', resolution: '9:16' });
          return;
        } catch {}
      }

      // Fallback: check if output exists
      if (fs.existsSync(outputPath)) {
        incrementVeoCount();
        resolve({ duration: '8.0', resolution: '9:16' });
      } else {
        reject(new Error('Veo 3.1 produced no output'));
      }
    });

    // Log stdout in real-time
    child.stdout.on('data', (data) => {
      const lines = data.toString().trim().split('\n');
      for (const line of lines) {
        if (!line.startsWith('__')) console.log(`  [veo] ${line}`);
      }
    });
  });
}

// ─── Telegram Helpers ────────────────────────────────────────────────────────

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

// ─── Main Pipeline ───────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  console.log('========================================');
  console.log('  Animated Apparel Mockup Pipeline');
  console.log('========================================');

  // Open database
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  initDatabase(db);

  // Initialize apparel mockup service
  const mockupService = new AiApparelMockupService({
    outputDir: path.join(APP_ROOT, 'web', 'images', 'ai-generated')
  });

  // Ensure output directory
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // Get designs to process
  const designs = getDesignsFromCatalog(db, opts);
  console.log(`\nDesigns to process: ${designs.length}`);
  console.log(`Engine: ${opts.engine}, Animation: ${opts.animation}`);
  if (opts.gender) console.log(`Gender filter: ${opts.gender}`);
  if (opts.apparel) console.log(`Apparel filter: ${opts.apparel}`);
  if (opts.motion) console.log(`Motion type: ${opts.motion}`);
  if (opts.color) console.log(`Garment color: ${opts.color}`);

  if (designs.length === 0) {
    console.log('\nNothing to process.');
    db.close();
    return;
  }

  // Dry run
  if (opts.dryRun) {
    console.log('\nDRY RUN — would process:');
    for (const d of designs.slice(0, 20)) {
      const engine = selectEngine(opts);
      const gender = opts.gender || (Math.random() > 0.5 ? 'female' : 'male');
      const { motionType } = selectMotionPrompt(gender, opts.motion || (opts.animation === 'turnaround' ? 'turnaround' : null));
      console.log(`  [${d.category}] ${d.name} → ${engine} / ${gender} / ${motionType}`);
    }
    if (designs.length > 20) console.log(`  ... and ${designs.length - 20} more`);
    db.close();
    return;
  }

  // GPU contention check for Wan2GP
  const engine = selectEngine(opts);
  if (engine === 'wan2gp' || opts.engine === 'auto') {
    if (isClassifierRunning()) {
      console.error('\nERROR: Catalog classifier is running on the gaming laptop GPU.');
      console.error('Cannot run Wan2GP concurrently. Wait for classifier to finish or pause it.');
      await notify('warning', 'Animated Mockup Blocked', 'Catalog classifier is using the GPU. Cannot start Wan2GP.');
      db.close();
      process.exit(1);
    }

    // Check laptop is reachable (headless mode doesn't need Gradio server)
    try {
      execSync(`ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no swayze@100.64.0.13 "echo ok"`, { timeout: 10000 });
      console.log('Gaming laptop is reachable.');
    } catch (e) {
      if (opts.engine === 'wan2gp') {
        console.error('Gaming laptop not reachable via SSH.');
        await notify('critical', 'Animated Mockup Failed', 'Gaming laptop not reachable');
        db.close();
        process.exit(1);
      }
      console.warn('Gaming laptop not reachable, will try Veo 3.1 for applicable items.');
    }
  }

  // Start batch
  await notify('info', 'Animated Mockup Batch Started',
    `Designs: ${designs.length}\nEngine: ${opts.engine}\nAnimation: ${opts.animation}`
  );

  const startTime = Date.now();
  let completed = 0;
  let errors = 0;

  // Prepared statements
  const insertStmt = db.prepare(`
    INSERT INTO animated_mockups (id, design_id, design_url, human_model_id, mockup_path,
      video_path, video_url, engine, animation_type, motion_prompt, motion_type,
      gender, apparel_type, clothing_color, duration_seconds, resolution,
      status, error_message, marketing_metadata, marketing_status, created_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (let i = 0; i < designs.length; i++) {
    const design = designs[i];
    const recordId = crypto.randomUUID();
    const itemEngine = selectEngine({ ...opts, animation: opts.animation });

    console.log(`\n[${i + 1}/${designs.length}] ${design.name} (${design.id})`);

    try {
      // 1. Select human model
      const modelGender = opts.gender || (Math.random() > 0.5 ? 'female' : 'male');
      const model = selectHumanModel(db, {
        gender: modelGender,
        apparel: opts.apparel || 't-shirt',
        animation: opts.animation
      });

      if (!model) {
        throw new Error(`No human model found for gender=${modelGender}, apparel=${opts.apparel || 't-shirt'}`);
      }
      console.log(`  Model: ${model.title || model.id} (${model.gender}, ${model.apparel_type})`);

      // 2. Resolve model image path
      let modelImagePath = model.optimized_path || model.file_path;
      if (!path.isAbsolute(modelImagePath) || modelImagePath.startsWith('/library/')) {
        const libRoot = process.env.LIBRARY_ROOT || path.join(APP_ROOT, 'web', 'library');
        modelImagePath = path.join(libRoot, modelImagePath.replace(/^\/library\//, '').replace(/^library\//, ''));
      }

      if (!fs.existsSync(modelImagePath)) {
        throw new Error(`Model image not found: ${modelImagePath}`);
      }

      // 3. Download design image
      const designTmpPath = `/tmp/animate-mockup-${recordId}-design.png`;
      console.log(`  Downloading design...`);
      await videoGen.downloadImage(design.url, designTmpPath);

      // 4. Composite design onto model via AiApparelMockupService
      console.log(`  Compositing design onto model...`);
      const mockupResult = await mockupService.placeGraphic(modelImagePath, designTmpPath, {
        zone: 'front-chest',
        size: 'auto',
        garmentType: opts.apparel || 't-shirt'
      });

      const mockupPath = mockupResult.localPath || mockupResult.imagePath;
      if (!mockupPath || !fs.existsSync(mockupPath)) {
        throw new Error('Compositing failed — no output image');
      }

      // Save mockup to output dir
      const mockupFilename = `mockup_${recordId}.png`;
      const savedMockupPath = path.join(OUTPUT_DIR, mockupFilename);
      fs.copyFileSync(mockupPath, savedMockupPath);
      console.log(`  Mockup saved: ${mockupFilename}`);

      // Rate limit between compositing calls
      await new Promise(r => setTimeout(r, COMPOSITING_DELAY_MS));

      // 5. Select motion prompt
      const motionTypeOverride = opts.motion || (opts.animation === 'turnaround' ? 'turnaround' : null);
      const { motionType, prompt: motionPrompt } = selectMotionPrompt(model.gender || modelGender, motionTypeOverride);
      console.log(`  Motion: ${motionType} (${itemEngine})`);

      // 6. Generate video
      const videoFilename = `video_${recordId}.mp4`;
      const videoPath = path.join(OUTPUT_DIR, videoFilename);

      let genResult;
      if (itemEngine === 'veo31') {
        if (!canUseVeo()) {
          console.warn(`  Veo daily limit reached (${VEO_DAILY_LIMIT}), falling back to wan2gp`);
          genResult = await generateWithWan2GP(savedMockupPath, motionPrompt, videoPath);
        } else {
          genResult = await generateWithVeo31(savedMockupPath, motionPrompt, videoPath, opts.animation);
        }
      } else {
        genResult = await generateWithWan2GP(savedMockupPath, motionPrompt, videoPath);
      }

      console.log(`  Video generated: ${videoFilename}`);

      // 7. Generate marketing metadata
      const marketingMeta = generateMarketingMeta(design, model, motionType, opts.apparel || 't-shirt');

      // Write sidecar JSON
      const metaPath = path.join(OUTPUT_DIR, `${path.basename(videoFilename, '.mp4')}.meta.json`);
      const metaJson = {
        videoPath: videoPath,
        ...marketingMeta
      };
      fs.writeFileSync(metaPath, JSON.stringify(metaJson, null, 2));
      console.log(`  Marketing metadata: ${path.basename(metaPath)}`);

      // 8. Insert DB record
      const now = new Date().toISOString();
      insertStmt.run(
        recordId, design.id, design.url, model.id, savedMockupPath,
        videoPath, null, itemEngine, opts.animation, motionPrompt, motionType,
        model.gender || modelGender, opts.apparel || 't-shirt', opts.color || null,
        parseFloat(genResult.duration), genResult.resolution,
        'completed', null, JSON.stringify(marketingMeta), 'pending', now, now
      );

      completed++;

      // 9. Telegram notification — every item
      const elapsed = Date.now() - startTime;
      const avgTime = elapsed / (completed + errors);
      const remaining = designs.length - (completed + errors);
      const eta = formatDuration(avgTime * remaining);

      await notify('success', `Mockup Animation ${completed}`,
        `Design: ${design.name}\nModel: ${model.title || model.id}\nMotion: ${motionType}\nEngine: ${itemEngine}\nETA: ${eta}`
      );

      // Batch summary every 10
      if ((completed + errors) % 10 === 0) {
        const pct = ((completed + errors) / designs.length * 100).toFixed(1);
        await notify('info', `Batch Progress ${Math.floor((completed + errors) / 10)}`,
          `Done: ${completed + errors}/${designs.length} (${pct}%)\nCompleted: ${completed}, Errors: ${errors}\nETA: ${eta}`
        );
      }

      // Cleanup temp design file
      try { fs.unlinkSync(designTmpPath); } catch {}

    } catch (err) {
      errors++;
      console.error(`  ERROR: ${err.message}`);

      // Record error in DB
      const now = new Date().toISOString();
      try {
        insertStmt.run(
          recordId, design.id, design.url, null, null,
          null, null, itemEngine, opts.animation, null, null,
          opts.gender || null, opts.apparel || null, opts.color || null,
          null, null,
          'failed', err.message, null, 'pending', now, null
        );
      } catch (dbErr) {
        console.error(`  DB error: ${dbErr.message}`);
      }

      await notify('warning', 'Mockup Animation Error',
        `Design: ${design.name}\nError: ${err.message}`
      );
    }
  }

  // Final summary
  const totalTime = Date.now() - startTime;
  console.log('\n========================================');
  console.log('  Animated Mockup Pipeline Complete');
  console.log('========================================');
  console.log(`Completed: ${completed} / ${designs.length}`);
  console.log(`Errors: ${errors}`);
  console.log(`Total time: ${formatDuration(totalTime)}`);
  console.log(`Output: ${OUTPUT_DIR}`);

  const veoCount = getVeoDailyCount();
  if (veoCount.count > 0) {
    console.log(`Veo 3.1 used today: ${veoCount.count}/${VEO_DAILY_LIMIT}`);
  }

  await notify('success', 'Animated Mockup Pipeline Complete',
    `Completed: ${completed}/${designs.length}\nErrors: ${errors}\nTotal time: ${formatDuration(totalTime)}`
  );

  db.close();
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

process.on('uncaughtException', async (err) => {
  console.error('FATAL:', err);
  await notify('critical', 'Animated Mockup Crashed', `Error: ${err.message}`);
  process.exit(1);
});

main().catch(async (err) => {
  console.error('Failed:', err);
  await notify('critical', 'Animated Mockup Failed', `Error: ${err.message}`);
  process.exit(1);
});
