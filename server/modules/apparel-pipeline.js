/**
 * Apparel Pipeline Orchestrator
 *
 * Autonomous workflow: categorize designs → match models → generate mockups →
 * publish to Shopify → create TikTok reels → notify via Telegram.
 *
 * Entry point: processNewCollection(categoryName)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { categorizeDesign, categorizeCollection, getDesignCategory, THEMES } = require('./design-categorizer');
const { TIKTOK_VIDEOS_DIR, TIKTOK_MUSIC_DIR, PIPELINE_OUTPUT_DIR, PRODUCT_BLANKS_DIR } = require('../paths');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const CATALOG_PATH = path.join(APP_ROOT, 'web', 'catalog.json');
const TEMP_DIR = path.join(TIKTOK_VIDEOS_DIR, 'tmp');
const FONT_PATH = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const FONTS = {
  hook: '/usr/share/fonts/truetype/custom-tiktok/BebasNeue-Regular.ttf',
  body: '/usr/share/fonts/truetype/custom-tiktok/Poppins-ExtraBold.ttf',
  cta:  '/usr/share/fonts/truetype/custom-tiktok/Anton-Regular.ttf'
};
const JOURNAL_PATH = path.join(APP_ROOT, 'data', 'apparel-pipeline-log.json');

const API_BASE = `http://localhost:${process.env.PORT || 4000}`;
const API_KEY = process.env.INTERNAL_API_KEY || '';

const WIDTH = 1080;
const HEIGHT = 1920;
const SLIDE_DURATION = 3.5; // seconds per image slide
const MIN_REEL_IMAGES = 4;
const MAX_REEL_IMAGES = 5; // chunk reels into 4-5 images each
const REEL_CHUNK_SIZE = 5;

// Pipeline step definitions for progress tracking
const PIPELINE_STEPS = [
  { key: 'load',             index: 0, label: 'Loading Designs' },
  { key: 'categorize',       index: 1, label: 'Categorizing' },
  { key: 'match-models',     index: 2, label: 'Matching Models' },
  { key: 'lifestyle-mockups', index: 3, label: 'Lifestyle Mockups' },
  { key: 'product-blanks',   index: 4, label: 'Product Blanks' },
  { key: 'shopify-publish',  index: 5, label: 'Shopify Publish' },
  { key: 'create-reels',     index: 6, label: 'Creating Reels' },
  { key: 'landing-pages',    index: 7, label: 'Landing Pages' },
  { key: 'complete',         index: 8, label: 'Complete' }
];

fs.mkdirSync(TIKTOK_VIDEOS_DIR, { recursive: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });

// ============================================================================
// THEME COPY — hardcoded for authenticity
// ============================================================================

const THEME_COPY = {
  'outdoor-adventure': {
    hooks: ['Adventure starts here', 'For the wild at heart', 'Mountains are calling'],
    body: 'Vintage-inspired outdoor tees. Printed in Asheville — because we know mountains.',
    ctas: ['Shop the collection', 'Link in bio', 'BlueRidgeCustomCo.com']
  },
  'moto-garage': {
    hooks: ['Old school garage vibes', 'Built different', 'Ride or die'],
    body: 'Retro motorcycle tees that look like they came from a 1970s shop.',
    ctas: ['Shop the collection', 'Fuel your style', 'BlueRidgeCustomCo.com']
  },
  'faith-inspirational': {
    hooks: ['Wear your faith', 'Let your tee do the talking', 'More than a shirt'],
    body: 'Premium graphic tees with designs that speak louder than words.',
    ctas: ['Shop the collection', 'Wear what you believe', 'BlueRidgeCustomCo.com']
  },
  'retro-vintage': {
    hooks: ['Worn-in look. Fresh off the press', 'Old soul. New tee', 'Throwback vibes'],
    body: 'These vintage-style graphic tees hit different. Every design tells a story.',
    ctas: ['Shop the collection', 'Get yours', 'BlueRidgeCustomCo.com']
  },
  'edgy-urban': {
    hooks: ['Street ready', 'Not your average tee', 'Make a statement'],
    body: 'Bold designs for bold people. Custom printed in Asheville, NC.',
    ctas: ['Shop now', 'Stand out', 'BlueRidgeCustomCo.com']
  },
  'humor-fun': {
    hooks: ["Life's too short for boring tees", 'Wear the laugh', 'Good vibes only'],
    body: 'Fun graphic tees that start conversations. Locally printed with love.',
    ctas: ['Shop the fun', 'Get laughs', 'BlueRidgeCustomCo.com']
  },
  'nature-animals': {
    hooks: ['Wild by nature', 'Nature never goes out of style', 'Wear the wild'],
    body: 'Nature-inspired designs on premium heavyweight tees.',
    ctas: ['Shop the wild side', 'BlueRidgeCustomCo.com']
  },
  default: {
    hooks: ['Custom Graphic Tees', 'Made in Asheville, NC', 'Premium quality'],
    body: 'Unique designs on heavyweight Bella Canvas tees. Printed locally.',
    ctas: ['Shop the collection', 'BlueRidgeCustomCo.com']
  }
};

// ============================================================================
// HELPERS
// ============================================================================

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function apiFetch(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const resp = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(options.timeout || 120000)
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`API ${resp.status}: ${text.substring(0, 200)}`);
  }
  return resp.json();
}

async function sendTelegram(text, parseMode = '') {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  const body = { chat_id: chatId, text };
  if (parseMode) body.parse_mode = parseMode;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000)
    });
  } catch (e) {
    console.error('[ApparelPipeline] Telegram send failed:', e.message);
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function loadCatalog() {
  if (!fs.existsSync(CATALOG_PATH)) throw new Error('Catalog not found: ' + CATALOG_PATH);
  return JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
}

function logToJournal(entry) {
  let journal = [];
  try {
    if (fs.existsSync(JOURNAL_PATH)) journal = JSON.parse(fs.readFileSync(JOURNAL_PATH, 'utf8'));
  } catch (_) {}
  journal.push({ ...entry, timestamp: new Date().toISOString() });
  if (journal.length > 500) journal = journal.slice(-500);
  fs.writeFileSync(JOURNAL_PATH, JSON.stringify(journal, null, 2));
}

// ============================================================================
// SMART MODEL MATCHING
// ============================================================================

// Track recently used models to rotate
const _recentModels = [];
const MAX_RECENT = 20;

/**
 * Match a model to a design based on the model's full profile.
 *
 * This thinks like a creative director:
 * 1. First check sells_best_with — does the model's profile say it sells this type of design?
 * 2. Then check style alignment — pinup designs need pinup-style models
 * 3. Then check demographic fit — sarcastic humor needs everyday relatable models
 * 4. Rotate to avoid using the same model twice in a row
 */

// Map design themes to what sells_best_with tags to look for
const THEME_TO_DESIGN_TAGS = {
  'outdoor-adventure': ['nature-outdoor', 'retro-americana'],
  'moto-garage': ['motorcycle-garage', 'skull-dark', 'retro-americana'],
  'faith-inspirational': ['faith-scripture', 'typography-quote'],
  'retro-vintage': ['retro-americana', 'vintage-pinup', 'typography-quote'],
  'edgy-urban': ['skull-dark', 'abstract-art', 'music-band'],
  'humor-fun': ['sarcastic-humor', 'pop-culture', 'cute-kawaii'],
  'nature-animals': ['animal-nature', 'nature-outdoor'],
  'sports-fitness': ['sports', 'typography-quote'],
  'music-culture': ['music-band', 'pop-culture', 'retro-americana'],
  'abstract-artistic': ['abstract-art', 'typography-quote']
};

// Map design themes to preferred model styles
const THEME_TO_MODEL_STYLE = {
  'outdoor-adventure': ['outdoor-active', 'casual-everyday', 'skater-youth'],
  'moto-garage': ['edgy-urban', 'pinup-retro', 'casual-everyday'],
  'faith-inspirational': ['casual-everyday', 'preppy-clean', 'country-southern'],
  'retro-vintage': ['pinup-retro', 'edgy-urban', 'bohemian-artsy'],
  'edgy-urban': ['edgy-urban', 'pinup-retro', 'skater-youth'],
  'humor-fun': ['casual-everyday', 'skater-youth', 'preppy-clean'],
  'nature-animals': ['outdoor-active', 'casual-everyday', 'bohemian-artsy'],
  'sports-fitness': ['fitness-athletic', 'outdoor-active', 'casual-everyday'],
  'music-culture': ['edgy-urban', 'pinup-retro', 'bohemian-artsy', 'skater-youth'],
  'abstract-artistic': ['bohemian-artsy', 'casual-everyday', 'professional-minimal']
};

// Special collection keyword → design tag mapping for collections with obvious intent
const COLLECTION_KEYWORDS = {
  'pinup': 'vintage-pinup',
  'pin-up': 'vintage-pinup',
  'pin up': 'vintage-pinup',
  'skeleton': 'skull-dark',
  'skull': 'skull-dark',
  'sarcastic': 'sarcastic-humor',
  'funny': 'sarcastic-humor',
  'outdoor': 'nature-outdoor',
  'camping': 'nature-outdoor',
  'biker': 'motorcycle-garage',
  'motorcycle': 'motorcycle-garage',
  'faith': 'faith-scripture',
  'christian': 'faith-scripture',
  'bible': 'faith-scripture',
  'retro': 'retro-americana',
  'vintage': 'retro-americana'
};

function matchModelToDesign(designCategory, models, collectionName = '') {
  if (!models || !models.length) return null;

  const theme = (designCategory || '').toLowerCase();
  const collectionLower = (collectionName || '').toLowerCase();

  // Determine what design tags to look for in models
  const desiredTags = new Set(THEME_TO_DESIGN_TAGS[theme] || []);

  // Check collection name for obvious keywords (e.g., "PinUp Girls" → vintage-pinup)
  for (const [keyword, tag] of Object.entries(COLLECTION_KEYWORDS)) {
    if (collectionLower.includes(keyword)) {
      desiredTags.add(tag);
    }
  }

  // Preferred model styles for this theme
  const preferredStyles = THEME_TO_MODEL_STYLE[theme] || [];

  let scored = models.map(m => {
    let score = 0;

    // STRONGEST SIGNAL: model's sells_best_with matches the design type
    const modelTags = Array.isArray(m.sellsBestWith) ? m.sellsBestWith : [];
    for (const tag of modelTags) {
      if (desiredTags.has(tag)) score += 5;
    }

    // STRONG SIGNAL: model's style matches preferred styles for this theme
    if (m.style && preferredStyles.includes(m.style)) {
      const styleRank = preferredStyles.indexOf(m.style);
      score += (4 - styleRank); // First preferred style gets +4, second +3, etc.
    }

    // MODERATE SIGNAL: model's demographic fits the design audience
    if (theme === 'humor-fun' && (m.demographic === 'everyday-mom' || m.demographic === 'everyday-dad' || m.demographic === 'millennial-parent')) score += 3;
    if (theme === 'outdoor-adventure' && m.demographic === 'outdoor-enthusiast') score += 3;
    if (theme === 'faith-inspirational' && m.demographic === 'faith-community') score += 3;
    if (theme === 'moto-garage' && m.demographic === 'biker-gearhead') score += 3;
    if ((theme === 'edgy-urban' || theme === 'retro-vintage') && m.demographic === 'alt-subculture') score += 3;

    // LIGHT SIGNAL: setting vibe
    if (theme === 'outdoor-adventure' && (m.setting === 'outdoor-nature' || m.setting === 'beach-coastal' || m.setting === 'park')) score += 1;
    if ((theme === 'moto-garage' || theme === 'edgy-urban') && (m.setting === 'urban-street' || m.setting === 'alley-gritty' || m.setting === 'industrial')) score += 1;

    // Penalize recently used models to ensure variety
    const recentIdx = _recentModels.indexOf(m.id);
    if (recentIdx !== -1) score -= 3;

    return { model: m, score };
  });

  // Sort by score descending, randomize ties
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return Math.random() - 0.5;
  });

  // CRITICAL: Only use models that actually fit the design.
  // Score models WITHOUT the recency penalty first to find true matches,
  // then apply recency as a tiebreaker within the good pool.
  const strongMatches = scored.filter(s => {
    // Recalculate score without recency penalty to find true matches
    const trueScore = s.score + (_recentModels.includes(s.model.id) ? 3 : 0);
    return trueScore >= 5;
  });

  let pool;
  if (strongMatches.length > 0) {
    // Sort strong matches by actual score (with recency penalty = prefer least recent)
    strongMatches.sort((a, b) => b.score - a.score || Math.random() - 0.5);
    pool = strongMatches;
  } else {
    pool = scored;
  }

  const chosen = pool[0].model;
  console.log(`[Pipeline] Model match: "${(chosen.title || chosen.id).substring(0, 35)}" (style=${chosen.style}, demo=${chosen.demographic}, score=${pool[0].score}) for theme=${theme} [strong: ${strongMatches.length}, total: ${scored.length}]`);

  // Track usage — cycle through strong matches, reset when all used
  _recentModels.push(chosen.id);
  if (_recentModels.length > MAX_RECENT) _recentModels.shift();

  return chosen;
}

// ============================================================================
// THEMED REEL GENERATOR (ffmpeg image slideshow)
// ============================================================================

function pickMusicTrack() {
  if (!fs.existsSync(TIKTOK_MUSIC_DIR)) return null;
  const tracks = fs.readdirSync(TIKTOK_MUSIC_DIR).filter(f => /\.(mp3|ogg|m4a|wav)$/.test(f));
  if (!tracks.length) return null;
  return path.join(TIKTOK_MUSIC_DIR, pick(tracks));
}

function escapeFFText(text) {
  return text.replace(/'/g, "'\\''").replace(/:/g, '\\:').replace(/%/g, '%%');
}

/**
 * Build a single slide image (1080x1920) from a mockup image with text overlay.
 * Uses ffmpeg to resize/pad + draw text.
 */
function buildSlide(inputPath, outputPath, { text, textPosition = 'bottom', fontSize = 48, role = 'body' }) {
  const escaped = text ? escapeFFText(text) : '';

  let filterChain = `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2:black`;

  if (escaped) {
    // Role-based font and color styling
    let fontFile, fontColor, outlineColor, outlineWidth;
    if (role === 'hook') {
      fontFile = FONTS.hook;
      fontSize = text.length > 30 ? 72 : 96;
      fontColor = 'white';
      outlineColor = 'black';
      outlineWidth = 3;
    } else if (role === 'cta') {
      fontFile = FONTS.cta;
      fontSize = text.length > 30 ? 52 : 68;
      fontColor = '#FFD700';
      outlineColor = 'black';
      outlineWidth = 3;
    } else {
      fontFile = FONTS.body;
      fontColor = 'white';
      outlineColor = 'black';
      outlineWidth = 2;
    }

    const yPos = textPosition === 'top' ? '(h*0.12)' :
                 textPosition === 'bottom' ? '(h*0.68)' : '(h*0.42)';
    const xExpr = '(w-text_w)/2';

    // Shadow layer
    filterChain += `,drawtext=fontfile='${fontFile}':text='${escaped}':fontcolor=black@0.8:fontsize=${fontSize}:x=${xExpr}+4:y=${yPos}+4`;
    // Main text with outline
    filterChain += `,drawtext=fontfile='${fontFile}':text='${escaped}':fontcolor=${fontColor}:fontsize=${fontSize}:borderw=${outlineWidth}:bordercolor=${outlineColor}:x=${xExpr}:y=${yPos}`;
  }

  const cmd = [
    'ffmpeg', '-y',
    '-i', `"${inputPath}"`,
    '-vf', `"${filterChain}"`,
    '-frames:v', '1',
    `"${outputPath}"`
  ].join(' ');

  execSync(cmd, { timeout: 30000, stdio: 'pipe' });
  return outputPath;
}

/**
 * Generate a themed TikTok reel from mockup images.
 *
 * @param {string} theme - Theme key from THEME_COPY
 * @param {string[]} mockupPaths - Array of mockup image file paths
 * @param {object} [options]
 * @param {string[]} [options.designNames] - Names for middle slides
 * @param {number} [options.slideDuration] - Seconds per slide
 * @returns {{ outputPath, outputUrl, duration, slideCount }}
 */
function generateThemedReel(theme, mockupPaths, options = {}) {
  if (!mockupPaths || mockupPaths.length < MIN_REEL_IMAGES) {
    throw new Error(`Need at least ${MIN_REEL_IMAGES} mockups for a reel, got ${mockupPaths?.length || 0}`);
  }

  const copy = THEME_COPY[theme] || THEME_COPY.default;
  const slideDuration = options.slideDuration || SLIDE_DURATION;
  const designNames = options.designNames || [];
  const slideFiles = [];
  const runId = Date.now();

  console.log(`[ApparelPipeline] Building reel for theme "${theme}" with ${mockupPaths.length} images`);

  // Build slides with text overlays
  for (let i = 0; i < mockupPaths.length; i++) {
    const imgPath = mockupPaths[i];
    if (!fs.existsSync(imgPath)) {
      console.warn(`[ApparelPipeline] Missing mockup: ${imgPath}, skipping`);
      continue;
    }

    let text = '';
    let textPosition = 'bottom';
    let fontSize = 48;

    let slideRole = 'body';
    if (i === 0) {
      // Hook slide — big text
      text = pick(copy.hooks);
      textPosition = 'center';
      fontSize = 64;
      slideRole = 'hook';
    } else if (i === mockupPaths.length - 1) {
      // CTA slide
      text = pick(copy.ctas);
      textPosition = 'bottom';
      fontSize = 56;
      slideRole = 'cta';
    } else if (designNames[i]) {
      // Middle slide — design name
      text = designNames[i];
      textPosition = 'bottom';
      fontSize = 44;
    }

    const slideFile = path.join(TEMP_DIR, `slide-${runId}-${i}.png`);
    try {
      buildSlide(imgPath, slideFile, { text, textPosition, fontSize, role: slideRole });
      slideFiles.push(slideFile);
    } catch (err) {
      console.warn(`[ApparelPipeline] Slide build failed for ${imgPath}: ${err.message}`);
    }
  }

  if (slideFiles.length < MIN_REEL_IMAGES) {
    // Clean up
    slideFiles.forEach(f => { try { fs.unlinkSync(f); } catch (_) {} });
    throw new Error(`Only ${slideFiles.length} slides built, need at least ${MIN_REEL_IMAGES}`);
  }

  // Build video from image slides with Ken Burns zoom effect
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outputName = `reel-${theme}-${timestamp}.mp4`;
  const outputPath = path.join(TIKTOK_VIDEOS_DIR, outputName);
  const concatPath = path.join(TEMP_DIR, `concat-${runId}.txt`);

  // Create concat file — each image shown for slideDuration
  const concatContent = slideFiles.map(f =>
    `file '${f}'\nduration ${slideDuration}`
  ).join('\n') + `\nfile '${slideFiles[slideFiles.length - 1]}'`; // ffmpeg needs last file repeated
  fs.writeFileSync(concatPath, concatContent);

  const totalDuration = slideFiles.length * slideDuration;

  // Ken Burns: gentle zoom from 100% to 110% over each slide
  // zoompan: z goes from 1 to 1.1 over the duration of each slide
  const framesPerSlide = Math.round(slideDuration * 30);
  const kenBurns = `zoompan=z='min(zoom+0.0003,1.10)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${framesPerSlide}:s=${WIDTH}x${HEIGHT}:fps=30`;

  // Two-pass: first build video from slides with Ken Burns, then add music
  const slideVideoPath = path.join(TEMP_DIR, `slides-${runId}.mp4`);

  // For Ken Burns, we process each slide individually then concat
  const segmentFiles = [];
  for (let i = 0; i < slideFiles.length; i++) {
    const segPath = path.join(TEMP_DIR, `kbseg-${runId}-${i}.mp4`);
    const cmd = [
      'ffmpeg', '-y',
      '-loop', '1', '-i', `"${slideFiles[i]}"`,
      '-vf', `"${kenBurns}"`,
      '-t', slideDuration.toFixed(1),
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-an',
      `"${segPath}"`
    ].join(' ');
    try {
      execSync(cmd, { timeout: 60000, stdio: 'pipe' });
      segmentFiles.push(segPath);
    } catch (err) {
      console.warn(`[ApparelPipeline] Ken Burns segment ${i} failed: ${err.message}`);
      // Fallback: static image as video
      const fallbackCmd = [
        'ffmpeg', '-y',
        '-loop', '1', '-i', `"${slideFiles[i]}"`,
        '-t', slideDuration.toFixed(1),
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        '-pix_fmt', 'yuv420p', '-r', '30',
        '-an',
        `"${segPath}"`
      ].join(' ');
      try {
        execSync(fallbackCmd, { timeout: 30000, stdio: 'pipe' });
        segmentFiles.push(segPath);
      } catch (_) {}
    }
  }

  if (!segmentFiles.length) {
    // Clean up
    slideFiles.forEach(f => { try { fs.unlinkSync(f); } catch (_) {} });
    try { fs.unlinkSync(concatPath); } catch (_) {}
    throw new Error('Failed to build any video segments');
  }

  // Concat all Ken Burns segments
  const segListPath = path.join(TEMP_DIR, `seglist-${runId}.txt`);
  fs.writeFileSync(segListPath, segmentFiles.map(f => `file '${f}'`).join('\n'));

  const concatCmd = [
    'ffmpeg', '-y',
    '-f', 'concat', '-safe', '0',
    '-i', `"${segListPath}"`,
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
    '-an', '-movflags', '+faststart',
    `"${slideVideoPath}"`
  ].join(' ');
  execSync(concatCmd, { timeout: 120000, stdio: 'pipe' });

  // Add background music
  const musicTrack = pickMusicTrack();
  let finalOutput = slideVideoPath;

  if (musicTrack) {
    try {
      const fadeDur = Math.min(2, totalDuration * 0.1);
      const mixCmd = [
        'ffmpeg', '-y',
        '-i', `"${slideVideoPath}"`,
        '-stream_loop', '-1', '-i', `"${musicTrack}"`,
        '-filter_complex',
        `"[1:a]atrim=0:${totalDuration.toFixed(1)},afade=t=in:st=0:d=${fadeDur.toFixed(1)},afade=t=out:st=${(totalDuration - fadeDur).toFixed(1)}:d=${fadeDur.toFixed(1)},volume=0.85[music];[music]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[aout]"`,
        '-map', '0:v', '-map', '[aout]',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
        '-shortest', '-movflags', '+faststart',
        `"${outputPath}"`
      ].join(' ');
      execSync(mixCmd, { timeout: 120000, stdio: 'pipe' });
      finalOutput = outputPath;
      console.log(`[ApparelPipeline] Added music: ${path.basename(musicTrack)}`);
    } catch (err) {
      console.warn(`[ApparelPipeline] Music mix failed, using video only: ${err.message}`);
    }
  }

  // If no music or music failed, move the slideVideo to output
  if (finalOutput !== outputPath) {
    fs.copyFileSync(slideVideoPath, outputPath);
  }

  // Clean up temp files
  slideFiles.forEach(f => { try { fs.unlinkSync(f); } catch (_) {} });
  segmentFiles.forEach(f => { try { fs.unlinkSync(f); } catch (_) {} });
  [concatPath, segListPath, slideVideoPath].forEach(f => {
    if (f !== outputPath) try { fs.unlinkSync(f); } catch (_) {}
  });

  const result = {
    outputPath,
    outputUrl: `/api/tiktok-videos/${outputName}`,
    duration: Math.round(totalDuration * 10) / 10,
    slideCount: slideFiles.length,
    theme,
    createdAt: new Date().toISOString()
  };

  console.log(`[ApparelPipeline] Reel done: ${outputName} (${result.duration}s, ${result.slideCount} slides)`);
  return result;
}

// ============================================================================
// LANDING PAGE BUILDER
// ============================================================================

function formatThemeName(theme) {
  return (theme || 'default')
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Build responsive HTML for a reel landing page showing featured products.
 */
// ============================================================================
// LANDING PAGE BUILDER — editorial drop broadsheet
// ----------------------------------------------------------------------------
// Self-contained HTML for Shopify page body_html. Dispatches per dominant
// product type (apparel / metal-print / sticker / drinkware / stl / default),
// each reusing the same editorial bones but with a different accent palette,
// copy voice, and layout rhythm. All styles scoped under .brl (Blue-Ridge
// Landing) to avoid clobbering theme CSS.
// ============================================================================

function normalizeProductType(raw) {
  const s = String(raw || '').toLowerCase();
  if (/t.?shirt|tee\b|hoodie|sweatshirt|long.?sleeve|tank|apparel|garment|crewneck|raglan/.test(s)) return 'apparel';
  if (/sticker|decal|vinyl[- ]?cut/.test(s)) return 'sticker';
  if (/metal[- ]?print|wall[- ]?art|poster|canvas|framed/.test(s)) return 'metal-print';
  if (/mug|tumbler|drinkware|bottle|cup|glass/.test(s)) return 'drinkware';
  if (/mount|stl|3d|holder|bracket|multiboard|print[- ]?in[- ]?place/.test(s)) return 'stl';
  return 'apparel';
}

function detectDominantType(products) {
  const counts = {};
  for (const p of products || []) {
    const t = normalizeProductType(p.productType || p.type || '');
    counts[t] = (counts[t] || 0) + 1;
  }
  let max = 0, dominant = 'apparel';
  for (const [t, c] of Object.entries(counts)) {
    if (c > max) { max = c; dominant = t; }
  }
  return dominant;
}

// Palette + voice per product family — each one gives the page its identity.
const LANDING_THEMES = {
  'apparel': {
    bg: '#F3EEE4',           // warm cream paper
    ink: '#17140F',          // deep espresso
    accent: '#C6381C',       // rust red
    muted: '#7A7066',
    line: 'rgba(23,20,15,0.14)',
    eyebrow: 'NEW DROP',
    ctaLabel: 'Pick Your Size & Color',
    seeMore: 'See the full drop',
    provenance: 'Printed in Asheville, North Carolina',
    craftNote: 'Soft, pre-shrunk cotton. Water-based inks. One run at a time.'
  },
  'metal-print': {
    bg: '#0D0D0F',
    ink: '#F3F1EC',
    accent: '#D4A351',       // brushed brass
    muted: '#847E73',
    line: 'rgba(243,241,236,0.12)',
    eyebrow: 'LIMITED GALLERY RUN',
    ctaLabel: 'Choose Size',
    seeMore: 'See the full gallery',
    provenance: 'Pressed onto 0.045" aluminum · Asheville NC',
    craftNote: 'Hi-def sublimation. Mounted and ready to hang.'
  },
  'sticker': {
    bg: '#FFF8E8',
    ink: '#14120B',
    accent: '#F25C2B',
    muted: '#7A6E55',
    line: 'rgba(20,18,11,0.14)',
    eyebrow: 'STICK ANYWHERE',
    ctaLabel: 'Grab This Sticker',
    seeMore: 'Browse all stickers',
    provenance: 'Die-cut vinyl · weatherproof · Asheville NC',
    craftNote: 'Thick premium vinyl. Laminated. Survives rain, sun, and suds.'
  },
  'drinkware': {
    bg: '#EFEBE2',
    ink: '#1C170F',
    accent: '#8C5A2B',       // coffee
    muted: '#7A6E60',
    line: 'rgba(28,23,15,0.12)',
    eyebrow: 'MORNING ROTATION',
    ctaLabel: 'Fill Your Cup',
    seeMore: 'All drinkware',
    provenance: 'Printed and packed in Asheville NC',
    craftNote: 'Hand-wash recommended. Dishwasher safe on top rack.'
  },
  'stl': {
    bg: '#0E0F11',
    ink: '#E6E5E0',
    accent: '#7EC8B1',       // mint filament
    muted: '#7A7D80',
    line: 'rgba(230,229,224,0.12)',
    eyebrow: 'PRINT-IN-PLACE',
    ctaLabel: 'Configure & Print',
    seeMore: 'All mounts & files',
    provenance: 'Designed in Asheville NC · Multiboard compatible',
    craftNote: 'Tested prints. Tuned for a 0.4mm nozzle. No supports.'
  }
};

function buildReelLandingPageHtml(ctx) {
  const dominantType = detectDominantType(ctx.products);
  return renderLandingPage(dominantType, ctx);
}

function renderLandingPage(type, ctx) {
  const palette = LANDING_THEMES[type] || LANDING_THEMES['apparel'];
  const {
    title,
    hook,
    body,
    products,
    collectionHandle,
    reelUrl,
    theme,
    isTikTokShopReel,
    apparelChoices
  } = ctx;

  const safe = escapeHtml;
  const fmtPrice = (p) => {
    const n = Number(p);
    if (Number.isFinite(n)) return n.toFixed(2).replace(/\.00$/, '');
    return String(p || '0');
  };

  // Build a human-readable color label from the campaign's apparel choices
  const colorNames = (apparelChoices || [])
    .filter(Boolean)
    .map(a => a.color || a.colorName || '')
    .filter(Boolean);
  const colorLabel = colorNames.length > 1
    ? colorNames.slice(0, -1).join(', ') + ' & ' + colorNames[colorNames.length - 1]
    : colorNames[0] || '';

  // Reel video embed (the attention grabber)
  const videoHtml = reelUrl ? `
    <video class="brl-reel" autoplay muted loop playsinline preload="metadata" poster="${safe(products[0]?.image || '')}">
      <source src="${safe(reelUrl)}" type="video/mp4">
    </video>` : (products[0]?.image
      ? `<img class="brl-reel brl-reel--static" src="${safe(products[0].image)}" alt="${safe(title)}">`
      : '');

  // Per-product cards — mockup is the grabber, variants are the sale
  const productCardsHtml = products.map((p, idx) => {
    const productUrl = p.handle ? `/products/${p.handle}` : '#';
    const mockup = p.image
      ? `<img class="brl-card__mockup" src="${safe(p.image)}" alt="${safe(p.title)}" loading="lazy">`
      : '';

    // Variant thumbnails (the actual items) — use images[1..] which are blanks
    const variantImgs = (p.images || []).slice(1, 5);
    const variantChips = variantImgs.length
      ? variantImgs.map((img, i) => `
          <a href="${productUrl}" class="brl-chip" aria-label="View variant ${i + 1}">
            <img src="${safe(img)}" alt="${safe(p.title)} variant ${i + 1}" loading="lazy">
          </a>`).join('')
      : '';

    const price = fmtPrice(p.price);
    const isAlt = idx % 2 === 1;

    return `
      <article class="brl-card${isAlt ? ' brl-card--alt' : ''}" style="--i:${idx};">
        <div class="brl-card__index"><span>${String(idx + 1).padStart(2, '0')}</span> / ${String(products.length).padStart(2, '0')}</div>
        <a class="brl-card__mockup-wrap" href="${productUrl}" aria-label="${safe(p.title)}">
          ${mockup}
          <span class="brl-card__scrim"></span>
        </a>
        <div class="brl-card__body">
          <h3 class="brl-card__title">${safe(p.title)}</h3>
          <div class="brl-card__meta">
            <span class="brl-card__price">$${safe(price)}</span>
            <span class="brl-card__dot">·</span>
            <span class="brl-card__tag">${safe((p.productType || '').toUpperCase() || 'MADE TO ORDER')}</span>
          </div>
          ${variantChips ? `
          <p class="brl-card__variant-label">The real thing — pick your fit</p>
          <div class="brl-card__chips">${variantChips}</div>
          ` : ''}
          <a class="brl-card__cta" href="${productUrl}">
            <span>${safe(palette.ctaLabel)}</span>
            <svg width="18" height="12" viewBox="0 0 18 12" fill="none" aria-hidden="true">
              <path d="M1 6h16M12 1l5 5-5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/>
            </svg>
          </a>
        </div>
      </article>`;
  }).join('\n');

  // Eyebrow line (date + drop + optional channel flag)
  const now = new Date();
  const issueLabel = `${now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }).toUpperCase()} · ISSUE ${String(now.getDate()).padStart(2, '0')}`;

  // The whole thing — self-contained, scoped under .brl
  return `<style>
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,700;9..144,900&family=Manrope:wght@400;500;600;700&display=swap');

.brl {
  --brl-bg: ${palette.bg};
  --brl-ink: ${palette.ink};
  --brl-accent: ${palette.accent};
  --brl-muted: ${palette.muted};
  --brl-line: ${palette.line};
  --brl-serif: 'Fraunces', 'Times New Roman', Georgia, serif;
  --brl-sans: 'Manrope', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif;

  position: relative;
  max-width: 1280px;
  margin: 0 auto;
  padding: 64px 28px 80px;
  background: var(--brl-bg);
  color: var(--brl-ink);
  font-family: var(--brl-sans);
  font-weight: 400;
  line-height: 1.5;
  overflow: hidden;
  isolation: isolate;
}
.brl *, .brl *::before, .brl *::after { box-sizing: border-box; }
.brl a { color: inherit; text-decoration: none; }
.brl img { display: block; max-width: 100%; height: auto; }

/* Subtle paper grain, layered beneath everything */
.brl::before {
  content: "";
  position: absolute;
  inset: 0;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix type='matrix' values='0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.08 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>");
  opacity: 0.9;
  pointer-events: none;
  mix-blend-mode: multiply;
  z-index: 0;
}
.brl > * { position: relative; z-index: 1; }

/* ── Masthead ─────────────────────────────────────────────────────────── */
.brl-masthead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--brl-line);
  margin-bottom: 36px;
  font-family: var(--brl-sans);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--brl-muted);
}
.brl-masthead__brand {
  color: var(--brl-ink);
  font-family: var(--brl-serif);
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.01em;
  text-transform: none;
}
.brl-masthead__brand em {
  font-style: italic;
  font-weight: 400;
  color: var(--brl-muted);
}
.brl-masthead__drop {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}
.brl-masthead__drop::before {
  content: "";
  width: 8px;
  height: 8px;
  background: var(--brl-accent);
  border-radius: 50%;
  display: inline-block;
  animation: brl-pulse 2.4s ease-in-out infinite;
}
@keyframes brl-pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.4); opacity: 0.6; }
}

/* ── Hero: video on left, editorial headline on right ────────────────── */
.brl-hero {
  display: grid;
  grid-template-columns: 1.15fr 1fr;
  gap: 44px;
  align-items: end;
  margin-bottom: 72px;
}
@media (max-width: 860px) {
  .brl-hero { grid-template-columns: 1fr; gap: 32px; }
  .brl { padding: 40px 20px 60px; }
}
.brl-reel-frame {
  position: relative;
  aspect-ratio: 9 / 16;
  border-radius: 2px;
  overflow: hidden;
  background: var(--brl-ink);
  box-shadow:
    0 1px 0 var(--brl-line),
    0 30px 60px -30px rgba(0,0,0,0.35),
    0 10px 20px -10px rgba(0,0,0,0.2);
  max-height: 640px;
}
.brl-reel {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.brl-reel-frame::after {
  content: "LIVE CUT · ${safe((theme || 'DROP').toUpperCase())}";
  position: absolute;
  top: 16px;
  left: 16px;
  padding: 6px 10px;
  background: var(--brl-bg);
  color: var(--brl-ink);
  font-family: var(--brl-sans);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.14em;
  border: 1px solid var(--brl-line);
}
.brl-reel-frame::before {
  content: "";
  position: absolute;
  bottom: 16px;
  right: 16px;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: var(--brl-accent);
  box-shadow: 0 0 0 2px var(--brl-bg), 0 10px 30px rgba(0,0,0,0.4);
  animation: brl-bob 3s ease-in-out infinite;
  z-index: 2;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 20 20'><path d='M6 4l10 6-10 6z' fill='white'/></svg>");
  background-repeat: no-repeat;
  background-position: center;
}
@keyframes brl-bob {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-6px); }
}

.brl-headline {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.brl-eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--brl-accent);
}
.brl-eyebrow::before {
  content: "";
  width: 28px;
  height: 1px;
  background: var(--brl-accent);
}
.brl-h1 {
  margin: 0;
  font-family: var(--brl-serif);
  font-weight: 400;
  font-size: clamp(44px, 6.5vw, 96px);
  line-height: 0.92;
  letter-spacing: -0.03em;
  color: var(--brl-ink);
}
.brl-h1 em {
  font-style: italic;
  font-weight: 300;
  color: var(--brl-accent);
}
.brl-dek {
  margin: 0;
  max-width: 46ch;
  font-family: var(--brl-serif);
  font-weight: 400;
  font-size: 19px;
  line-height: 1.45;
  color: var(--brl-ink);
  opacity: 0.82;
}
.brl-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 14px 22px;
  padding-top: 14px;
  margin-top: 6px;
  border-top: 1px solid var(--brl-line);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--brl-muted);
}
.brl-meta strong {
  color: var(--brl-ink);
  font-weight: 700;
}

/* ── Section rule ─────────────────────────────────────────────────────── */
.brl-rule {
  display: flex;
  align-items: baseline;
  gap: 20px;
  margin: 20px 0 40px;
}
.brl-rule__label {
  flex-shrink: 0;
  font-family: var(--brl-sans);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--brl-muted);
}
.brl-rule__line {
  flex: 1;
  height: 1px;
  background: var(--brl-line);
}
.brl-rule__count {
  font-family: var(--brl-serif);
  font-size: 22px;
  font-style: italic;
  color: var(--brl-ink);
}

/* ── Product cards (the drop) ─────────────────────────────────────────── */
.brl-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 48px 36px;
}
.brl-card {
  display: flex;
  flex-direction: column;
  gap: 18px;
  position: relative;
  animation: brl-rise 0.8s ease-out both;
  animation-delay: calc(var(--i, 0) * 60ms);
}
@keyframes brl-rise {
  from { opacity: 0; transform: translateY(24px); }
  to { opacity: 1; transform: translateY(0); }
}
.brl-card__index {
  font-family: var(--brl-sans);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.18em;
  color: var(--brl-muted);
}
.brl-card__index span {
  color: var(--brl-accent);
  font-size: 14px;
}
.brl-card__mockup-wrap {
  position: relative;
  display: block;
  aspect-ratio: 4 / 5;
  overflow: hidden;
  background: var(--brl-line);
  transition: transform 0.5s ease;
}
.brl-card__mockup {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 0.9s cubic-bezier(0.22, 1, 0.36, 1), filter 0.5s ease;
}
.brl-card__mockup-wrap:hover .brl-card__mockup {
  transform: scale(1.06);
  filter: saturate(1.1);
}
.brl-card__scrim {
  position: absolute;
  inset: auto 0 0 0;
  height: 38%;
  background: linear-gradient(to top, rgba(0,0,0,0.35), transparent);
  pointer-events: none;
}
.brl-card--alt .brl-card__mockup-wrap { aspect-ratio: 4 / 5; }
.brl-card--alt { padding-top: 28px; }

.brl-card__body { display: flex; flex-direction: column; gap: 10px; }
.brl-card__title {
  margin: 0;
  font-family: var(--brl-serif);
  font-weight: 400;
  font-size: 24px;
  line-height: 1.1;
  letter-spacing: -0.01em;
  color: var(--brl-ink);
}
.brl-card__meta {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  letter-spacing: 0.08em;
  color: var(--brl-muted);
  text-transform: uppercase;
}
.brl-card__price {
  font-family: var(--brl-serif);
  font-size: 22px;
  font-weight: 700;
  color: var(--brl-accent);
  letter-spacing: -0.01em;
  text-transform: none;
}
.brl-card__dot { opacity: 0.5; }
.brl-card__tag { font-weight: 700; font-size: 11px; }

.brl-card__variant-label {
  margin: 10px 0 0;
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--brl-muted);
  font-weight: 600;
}
.brl-card__chips {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 4px;
}
.brl-chip {
  position: relative;
  width: 56px;
  height: 56px;
  overflow: hidden;
  border: 1px solid var(--brl-line);
  background: var(--brl-bg);
  transition: transform 0.25s ease, border-color 0.25s ease;
}
.brl-chip:hover {
  transform: translateY(-2px);
  border-color: var(--brl-accent);
}
.brl-chip img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.brl-card__cta {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 14px;
  padding: 14px 18px;
  background: var(--brl-ink);
  color: var(--brl-bg);
  font-family: var(--brl-sans);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  transition: background 0.3s ease, transform 0.3s ease;
}
.brl-card__cta:hover {
  background: var(--brl-accent);
  transform: translateX(2px);
}
.brl-card__cta svg { transition: transform 0.3s ease; }
.brl-card__cta:hover svg { transform: translateX(4px); }

/* ── Collection CTA ───────────────────────────────────────────────────── */
.brl-collection {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 32px;
  align-items: center;
  padding: 56px 44px;
  margin: 96px 0 40px;
  border-top: 1px solid var(--brl-line);
  border-bottom: 1px solid var(--brl-line);
}
@media (max-width: 720px) {
  .brl-collection { grid-template-columns: 1fr; padding: 36px 0; }
}
.brl-collection__title {
  margin: 0 0 8px;
  font-family: var(--brl-serif);
  font-weight: 300;
  font-style: italic;
  font-size: clamp(32px, 4.5vw, 52px);
  line-height: 1;
  letter-spacing: -0.02em;
  color: var(--brl-ink);
}
.brl-collection__title strong {
  font-style: normal;
  font-weight: 700;
  color: var(--brl-accent);
}
.brl-collection__sub {
  margin: 0;
  font-size: 14px;
  font-family: var(--brl-sans);
  color: var(--brl-muted);
}
.brl-collection__cta {
  display: inline-flex;
  align-items: center;
  gap: 14px;
  padding: 20px 32px;
  background: var(--brl-accent);
  color: #fff;
  font-family: var(--brl-sans);
  font-size: 13px;
  font-weight: 800;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  transition: background 0.3s ease, transform 0.3s ease;
  white-space: nowrap;
}
.brl-collection__cta:hover {
  background: var(--brl-ink);
  transform: translateX(4px);
}

/* ── Colophon ─────────────────────────────────────────────────────────── */
.brl-colophon {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 24px;
  padding-top: 28px;
  margin-top: 48px;
  border-top: 1px solid var(--brl-line);
  font-size: 12px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--brl-muted);
}
.brl-colophon__mark {
  font-family: var(--brl-serif);
  font-size: 14px;
  font-style: italic;
  text-transform: none;
  letter-spacing: 0;
  color: var(--brl-ink);
}

@media (max-width: 720px) {
  .brl-card__title { font-size: 22px; }
  .brl-colophon { flex-direction: column; align-items: flex-start; gap: 10px; }
}
</style>
<div class="brl">

  <!-- Masthead -->
  <header class="brl-masthead">
    <div class="brl-masthead__brand">Blue Ridge <em>Custom Co.</em></div>
    <div class="brl-masthead__drop">${safe(palette.eyebrow)} · ${safe(issueLabel)}</div>
  </header>

  <!-- Hero -->
  <section class="brl-hero">
    <div class="brl-reel-frame">${videoHtml}</div>
    <div class="brl-headline">
      <span class="brl-eyebrow">${safe(palette.eyebrow)}</span>
      <h1 class="brl-h1">${safe(hook || title)}</h1>
      ${body ? `<p class="brl-dek">${safe(body)}</p>` : ''}
      <div class="brl-meta">
        <span>${products.length} <strong>Designs</strong></span>
        ${colorLabel ? `<span>In <strong>${safe(colorLabel)}</strong></span>` : ''}
        <span><strong>${safe(palette.craftNote)}</strong></span>
      </div>
    </div>
  </section>

  <!-- Drop rule -->
  <div class="brl-rule">
    <span class="brl-rule__label">The Drop</span>
    <span class="brl-rule__line"></span>
    <span class="brl-rule__count">${products.length} pieces</span>
  </div>

  <!-- Product grid -->
  <section class="brl-grid">
    ${productCardsHtml}
  </section>

  <!-- Collection CTA -->
  <section class="brl-collection">
    <div>
      <h2 class="brl-collection__title">Not the <strong>one</strong>? <em>See the rest.</em></h2>
      <p class="brl-collection__sub">${safe(palette.provenance)}</p>
    </div>
    <a class="brl-collection__cta" href="/collections/${safe(collectionHandle)}">
      <span>${safe(palette.seeMore)}</span>
      <svg width="22" height="14" viewBox="0 0 22 14" fill="none" aria-hidden="true">
        <path d="M1 7h20M15 1l6 6-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="square"/>
      </svg>
    </a>
  </section>

  <!-- Colophon -->
  <footer class="brl-colophon">
    <span class="brl-colophon__mark">Made slow. Printed local. <em>Shipped warm.</em></span>
    <span>${safe(palette.provenance)}</span>
  </footer>

</div>`;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================================
// FULL PIPELINE
// ============================================================================

/**
 * Run the full apparel pipeline.
 *
 * Accepts either a category name OR an array of specific design IDs (for campaign mode).
 *
 * @param {string} collectionCategory - Category name from catalog.json (can be null if designIds provided)
 * @param {object} [options]
 * @param {string[]} [options.designIds] - Specific design IDs to process (overrides category lookup)
 * @param {string} [options.campaignSlug] - Campaign slug for tracking
 * @param {string} [options.campaignTitle] - Campaign title for display
 * @param {number} [options.limit] - Max designs to process
 * @param {string} [options.modelFilter] - Model filter (e.g. 'phoenix')
 * @param {string} [options.size] - Mockup size
 * @param {boolean} [options.skipShopify] - Skip Shopify publish step
 * @param {boolean} [options.skipReels] - Skip reel generation step
 * @param {boolean} [options.notify] - Send Telegram notifications (default true)
 * @param {Array<{type: string, color: string}>} [options.apparelChoices] -
 *   User-selected apparel items (2 items). Overrides auto tier system.
 *   e.g. [{type:'T-shirt',color:'Black'},{type:'Hoodie',color:'Navy'}]
 * @param {function} [options.onProgress] - Progress callback: ({ step, stepIndex, stepLabel, progress, total })
 * @returns {object} Pipeline results
 */
async function runFullPipeline(collectionCategory, options = {}) {
  const notify = options.notify !== false;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  // NEW: Reels are now created manually in reel-studio by default.
  // Pass skipReels: false explicitly to run the legacy inline reel generation.
  const skipReels = options.skipReels !== false; // default true
  const pipelineRunId = options.pipelineRunId || null;
  const results = {
    category: collectionCategory || options.campaignTitle || 'Campaign',
    campaignSlug: options.campaignSlug || null,
    categorized: 0,
    mockupsGenerated: 0,
    shopifyPublished: 0,
    reelsCreated: 0,
    reelUrls: [],
    errors: [],
    startedAt: new Date().toISOString()
  };

  function reportProgress(stepKey, extra = {}) {
    const stepDef = PIPELINE_STEPS.find(s => s.key === stepKey) || { key: stepKey, index: 0, label: stepKey };
    if (onProgress) {
      try {
        onProgress({ step: stepKey, stepIndex: stepDef.index, stepLabel: stepDef.label, totalSteps: PIPELINE_STEPS.length, ...extra });
      } catch (_) {}
    }
  }

  try {
    // ------------------------------------------------------------------
    // Step 1: Load designs (from designIds or category)
    // ------------------------------------------------------------------
    reportProgress('load', { progress: 0, total: 1 });

    let designsToProcess = [];
    let categoryLabel = collectionCategory || options.campaignTitle || 'Campaign';

    if (options.designIds && Array.isArray(options.designIds) && options.designIds.length) {
      // Campaign mode — find specific designs across all categories
      console.log(`[ApparelPipeline] Step 1: Loading ${options.designIds.length} specific designs`);
      const catalog = loadCatalog();
      const idSet = new Set(options.designIds.map(id => String(id)));

      for (const cat of (catalog.categories || [])) {
        for (const design of (cat.designs || [])) {
          if (idSet.has(String(design.id))) {
            designsToProcess.push(design);
            idSet.delete(String(design.id));
          }
        }
        if (idSet.size === 0) break;
      }

      if (idSet.size > 0) {
        console.warn(`[ApparelPipeline] ${idSet.size} design IDs not found in catalog: ${[...idSet].slice(0, 5).join(', ')}`);
      }

      categoryLabel = options.campaignTitle || `Campaign (${designsToProcess.length} designs)`;
    } else {
      // Category mode — original behavior
      console.log(`[ApparelPipeline] Step 1: Loading designs for "${collectionCategory}"`);
      const catalog = loadCatalog();
      const cat = catalog.categories.find(c =>
        c.name.toLowerCase().includes(collectionCategory.toLowerCase()) ||
        (c.slug && c.slug.toLowerCase().includes(collectionCategory.toLowerCase()))
      );
      if (!cat) throw new Error(`Category not found: "${collectionCategory}"`);

      const designs = cat.designs || [];
      const limit = options.limit || designs.length;
      designsToProcess = designs.slice(0, limit);
    }

    if (!designsToProcess.length) throw new Error(`No designs found for "${categoryLabel}"`);

    const limit = options.limit || designsToProcess.length;
    if (limit < designsToProcess.length) designsToProcess = designsToProcess.slice(0, limit);

    reportProgress('load', { progress: 1, total: 1 });

    if (notify) {
      await sendTelegram(
        `🏭 *Apparel Pipeline Started*\n${options.campaignSlug ? 'Campaign: ' + options.campaignSlug + '\n' : ''}Source: ${categoryLabel}\nDesigns: ${designsToProcess.length}`,
        'Markdown'
      );
    }

    // ------------------------------------------------------------------
    // Step 2: Categorize designs by theme
    // ------------------------------------------------------------------
    reportProgress('categorize', { progress: 0, total: designsToProcess.length });
    console.log(`[ApparelPipeline] Step 2: Categorizing ${designsToProcess.length} designs`);
    const themeGroups = {}; // theme -> [{ design, category }]

    for (const design of designsToProcess) {
      try {
        // Try cached first
        let catResult = getDesignCategory(design.preview || design.image);
        if (!catResult && design.preview) {
          const imgPath = path.join(APP_ROOT, 'web', design.preview);
          if (fs.existsSync(imgPath)) {
            catResult = await categorizeDesign(imgPath);
          }
        }

        const theme = catResult?.theme || 'default';
        if (!themeGroups[theme]) themeGroups[theme] = [];
        themeGroups[theme].push({
          design,
          category: catResult,
          name: design.name || design.title || path.basename(design.preview || '', '.png')
        });
        results.categorized++;
        reportProgress('categorize', { progress: results.categorized, total: designsToProcess.length });
      } catch (err) {
        console.warn(`[ApparelPipeline] Failed to categorize ${design.name || design.id}: ${err.message}`);
        if (!themeGroups.default) themeGroups.default = [];
        themeGroups.default.push({ design, category: null, name: design.name || 'Unknown' });
        results.categorized++;
        reportProgress('categorize', { progress: results.categorized, total: designsToProcess.length });
      }
    }

    const themeList = Object.keys(themeGroups).map(t => `${t} (${themeGroups[t].length})`).join(', ');
    console.log(`[ApparelPipeline] Categorized into themes: ${themeList}`);

    if (notify) {
      await sendTelegram(
        `📊 Categorized ${results.categorized} designs\nThemes: ${themeList}`,
        'Markdown'
      );
    }

    // ------------------------------------------------------------------
    // Step 3: Match models to designs
    // ------------------------------------------------------------------
    reportProgress('match-models', { progress: 0, total: results.categorized });
    console.log('[ApparelPipeline] Step 3: Matching models to designs');
    let models = [];
    try {
      // Bump limit so group members beyond the default 100 are included.
      const modelData = await apiFetch('/api/human-models?limit=10000');
      models = Array.isArray(modelData) ? modelData : (modelData.models || modelData.items || []);
    } catch (err) {
      console.warn('[ApparelPipeline] Could not fetch models:', err.message);
      results.errors.push('Model fetch failed: ' + err.message);
    }

    // Filter to a specific model group if requested. Rather than intersecting
    // the (paginated) human-models response, fetch group members directly so
    // the user's selection is always honored even if a member is outside the
    // top 10000.
    if (options.modelGroupId) {
      try {
        const groupData = await apiFetch(`/api/model-groups/${encodeURIComponent(options.modelGroupId)}`);
        const groupMembers = Array.isArray(groupData.members) ? groupData.members : [];
        if (groupMembers.length) {
          console.log(`[ApparelPipeline] Using model group "${groupData.group?.name}": ${groupMembers.length} members`);
          models = groupMembers;
        } else {
          console.warn(`[ApparelPipeline] Model group "${options.modelGroupId}" has no members, using all ${models.length}`);
        }
      } catch (err) {
        console.warn('[ApparelPipeline] Model group fetch failed, using all models:', err.message);
      }
    }

    if (models.length) {
      for (const theme of Object.keys(themeGroups)) {
        for (const item of themeGroups[theme]) {
          item.matchedModel = matchModelToDesign(theme, models, collectionCategory || categoryLabel);
        }
      }
      console.log(`[ApparelPipeline] Matched models for ${results.categorized} designs`);
    }
    reportProgress('match-models', { progress: results.categorized, total: results.categorized });

    // ------------------------------------------------------------------
    // Step 4: Generate mockups via batch API
    // ------------------------------------------------------------------
    reportProgress('lifestyle-mockups', { progress: 0, total: designsToProcess.length });
    console.log('[ApparelPipeline] Step 4: Generating mockups');
    if (notify) await sendTelegram('🎨 Generating mockups...');

    // Map design themes to appropriate model demographics/styles
    const THEME_MODEL_FILTERS = {
      'humor-fun':           { demographic: ['everyday-mom', 'millennial-parent', 'young-adult'], excludeStyle: ['pinup-retro'] },
      'faith-inspirational': { demographic: ['everyday-mom', 'everyday-dad', 'millennial-parent'], excludeStyle: ['pinup-retro', 'edgy-urban'] },
      'outdoor-adventure':   { style: ['casual-everyday', 'outdoor-active'], excludeStyle: ['pinup-retro'] },
      'moto-garage':         { style: ['edgy-urban', 'casual-everyday'] },
      'retro-vintage':       { style: ['casual-everyday', 'pinup-retro'] },
      'edgy-urban':          { style: ['edgy-urban', 'skater-youth'] },
      'nature-animals':      { style: ['casual-everyday', 'outdoor-active'], excludeStyle: ['pinup-retro'] },
      'music-culture':       { style: ['casual-everyday', 'edgy-urban', 'skater-youth'] },
      'abstract-artistic':   { style: ['casual-everyday'], excludeStyle: ['pinup-retro'] },
      'sports-fitness':      { style: ['casual-everyday', 'fitness-athletic'] },
      'default':             { style: ['casual-everyday'], excludeStyle: ['pinup-retro'] }
    };

    // Pick the dominant theme for model selection
    const dominantTheme = Object.entries(themeGroups).sort((a, b) => b[1].length - a[1].length)[0]?.[0] || 'default';
    const themeModelFilter = THEME_MODEL_FILTERS[dominantTheme] || THEME_MODEL_FILTERS['default'];
    console.log(`[ApparelPipeline] Dominant theme: "${dominantTheme}" → model filter: ${JSON.stringify(themeModelFilter)}`);

    let mockupJobId = null;
    try {
      const mockupPayload = {
        category: collectionCategory || categoryLabel,
        limit: limit,
        modelFilter: themeModelFilter,
        size: options.size || 'medium'
      };
      if (options.designIds && options.designIds.length) {
        mockupPayload.designIds = options.designIds;
      }
      // If the user picked a model group, lock the generator to its members.
      // This overrides the theme-based style filter above so the user's
      // selection is never widened by the default heuristics.
      if (options.modelGroupId) {
        mockupPayload.modelGroupId = options.modelGroupId;
      }
      const mockupResp = await apiFetch('/api/batch-mockups/generate', {
        method: 'POST',
        body: JSON.stringify(mockupPayload)
      });
      mockupJobId = mockupResp.jobId || mockupResp.id;
      results.mockupsGenerated = mockupResp.count || mockupResp.queued || 0;
      console.log(`[ApparelPipeline] Mockup job started: ${mockupJobId}, count: ${results.mockupsGenerated}`);
    } catch (err) {
      console.error('[ApparelPipeline] Mockup generation failed:', err.message);
      results.errors.push('Mockup generation failed: ' + err.message);
    }

    // ------------------------------------------------------------------
    // Step 5: Poll for mockup completion (or check disk for existing mockups)
    // ------------------------------------------------------------------
    if (mockupJobId) {
      console.log('[ApparelPipeline] Step 5: Waiting for mockups to complete');

      // Smart check: count mockups already on disk for our designs
      const mockupDir = PIPELINE_OUTPUT_DIR;
      const countMockupsOnDisk = () => {
        if (!fs.existsSync(mockupDir)) return 0;
        const files = fs.readdirSync(mockupDir).filter(f => f.startsWith('mockup_') && f.endsWith('.jpg'));
        return designsToProcess.filter(d => files.some(f => f.includes(d.id.substring(0, 30)))).length;
      };

      const maxPolls = 90; // 15 minutes max (10s each)
      let completed = false;
      let pollFailed = false;

      for (let i = 0; i < maxPolls; i++) {
        await sleep(10000);

        // Check disk — if all mockups exist, we're done regardless of poll status
        const diskCount = countMockupsOnDisk();
        reportProgress('lifestyle-mockups', { progress: diskCount, total: designsToProcess.length });

        if (diskCount >= designsToProcess.length) {
          results.mockupsGenerated = diskCount;
          completed = true;
          console.log(`[ApparelPipeline] All ${diskCount} mockups found on disk — done`);
          break;
        }

        // Also try the poll endpoint
        if (!pollFailed) {
          try {
            const status = await apiFetch(`/api/batch-mockups/${mockupJobId || ''}`, { timeout: 15000 });
            const progress = status.completed || status.progress || 0;
            const total = status.total || results.mockupsGenerated || 1;
            if (status.status === 'complete' || status.done || progress >= total) {
              results.mockupsGenerated = progress;
              completed = true;
              console.log(`[ApparelPipeline] Mockups complete via poll: ${progress}/${total}`);
              break;
            }
          } catch (err) {
            if (i === 3) {
              console.warn('[ApparelPipeline] Mockup poll endpoint unavailable, relying on disk check');
              pollFailed = true;
            }
          }
        }

        if (i % 6 === 5) {
          console.log(`[ApparelPipeline] Mockup progress: ${diskCount}/${designsToProcess.length} on disk`);
        }
      }

      if (!completed) {
        const finalCount = countMockupsOnDisk();
        results.mockupsGenerated = finalCount;
        console.log(`[ApparelPipeline] Mockup poll timed out, ${finalCount}/${designsToProcess.length} on disk, proceeding`);
      }
    }

    // Mark lifestyle mockups as done regardless of poll success
    reportProgress('lifestyle-mockups', { progress: designsToProcess.length, total: designsToProcess.length });

    if (notify) {
      await sendTelegram(`✅ Lifestyle mockups generated: ${results.mockupsGenerated}`);
    }

    // ------------------------------------------------------------------
    // Step 5b: Generate product blank mockups (what they'll actually get)
    // ------------------------------------------------------------------
    reportProgress('product-blanks', { progress: 0, total: designsToProcess.length });
    console.log('[ApparelPipeline] Step 5b: Generating product blank mockups');
    if (notify) await sendTelegram('👕 Generating product blank mockups (white tee, black tee, + theme pick)...');

    try {
      const { generateProductMockups } = require('./product-blank-mockup');
      const LIBRARY_ROOT = process.env.LIBRARY_ROOT || path.join(APP_ROOT, 'web', 'library');
      let blankCount = 0;
      let blankDesignsProcessed = 0;

      for (const theme of Object.keys(themeGroups)) {
        for (const item of themeGroups[theme]) {
          // Resolve graphic path
          let graphicPath = null;
          if (item.design?.image) {
            let imgPath = item.design.image;
            if (imgPath.startsWith('http')) {
              try { imgPath = decodeURIComponent(new URL(imgPath).pathname); } catch (_) {}
            }
            if (imgPath.startsWith('/library/')) {
              graphicPath = path.join(LIBRARY_ROOT, imgPath.slice('/library/'.length));
            } else if (imgPath.startsWith('/')) {
              graphicPath = path.join(APP_ROOT, 'web', imgPath.slice(1));
            }
          }

          if (!graphicPath || !fs.existsSync(graphicPath)) continue;

          // Check if product blanks already exist for this design
          const existingBlanks = fs.existsSync(PRODUCT_BLANKS_DIR)
            ? fs.readdirSync(PRODUCT_BLANKS_DIR).filter(f => f.includes(item.design.id.substring(0, 30)))
            : [];
          if (existingBlanks.length >= 2) continue; // already done

          try {
            const blanks = await generateProductMockups(item.design.id, graphicPath, theme, { apparelChoices: options.apparelChoices });
            blankCount += blanks.length;
          } catch (err) {
            console.warn(`[ApparelPipeline] Product blank failed for ${item.design.id}: ${err.message}`);
          }
          blankDesignsProcessed++;
          reportProgress('product-blanks', { progress: blankDesignsProcessed, total: designsToProcess.length });
        }
      }

      console.log(`[ApparelPipeline] Generated ${blankCount} product blank mockups`);
      if (notify) await sendTelegram(`👕 Generated ${blankCount} product blank mockups`);
    } catch (err) {
      console.error('[ApparelPipeline] Product blank step failed:', err.message);
      if (notify) await sendTelegram(`⚠️ Product blank step failed: ${err.message}`);
    }

    // ------------------------------------------------------------------
    // Persist campaign state for reel-studio EARLY (right after mockups
    // are done, BEFORE Shopify publish) so the user can start creating
    // reels in reel-studio while Shopify step 6 is still running.
    // publish_manifest is updated again after step 6 completes.
    // ------------------------------------------------------------------
    if (pipelineRunId) {
      try {
        const db = require('../db');
        const slimThemeGroups = {};
        for (const [theme, items] of Object.entries(themeGroups)) {
          slimThemeGroups[theme] = items.map(it => ({
            name: it.name,
            designId: it.design?.id || it.design?.slug || null,
            designSlug: it.design?.slug || null,
            preview: it.design?.preview || it.design?.image || null,
            category: it.category || null
          }));
        }
        db.updatePipelineRun(pipelineRunId, {
          collection: collectionCategory || options.campaignTitle || categoryLabel,
          theme_groups: JSON.stringify(slimThemeGroups),
          mockup_dir: PIPELINE_OUTPUT_DIR
        });
        console.log('[ApparelPipeline] Campaign state persisted early — reel-studio can see this run now');
      } catch (err) {
        console.warn('[ApparelPipeline] Could not persist early campaign state:', err.message);
      }
    }

    // ------------------------------------------------------------------
    // Step 6: Publish to Shopify
    // ------------------------------------------------------------------
    if (!options.skipShopify) {
      reportProgress('shopify-publish', { progress: 0, total: designsToProcess.length });
      console.log('[ApparelPipeline] Step 6: Publishing to Shopify');
      if (notify) await sendTelegram('🛍 Publishing to Shopify...');

      try {
        // Call publishBatch directly (not via HTTP) so we can await completion
        const { publishBatch } = require('../scripts/shopify-apparel-publisher');
        const shopifyOpts = {
          category: collectionCategory || categoryLabel,
          limit: limit
        };
        if (options.designIds && options.designIds.length) {
          shopifyOpts.designIds = options.designIds;
        }
        const shopifyResult = await publishBatch(shopifyOpts);
        results.shopifyPublished = shopifyResult.success || 0;
        results.shopifyManifest = shopifyResult.results || [];
        console.log(`[ApparelPipeline] Published ${results.shopifyPublished} to Shopify`);
        reportProgress('shopify-publish', { progress: results.shopifyPublished, total: designsToProcess.length });

        if (notify) {
          await sendTelegram(`🛍 Published ${results.shopifyPublished} products to Shopify`);
        }
      } catch (err) {
        console.error('[ApparelPipeline] Shopify publish failed:', err.message);
        results.errors.push('Shopify publish failed: ' + err.message);
        if (notify) await sendTelegram(`⚠️ Shopify publish failed: ${err.message}`);
      }
    }

    // ------------------------------------------------------------------
    // Update publish_manifest now that step 6 is done (theme_groups etc.
    // were already persisted before step 6 so reel-studio could see them
    // while Shopify was still publishing).
    // ------------------------------------------------------------------
    if (pipelineRunId && results.shopifyManifest) {
      try {
        const db = require('../db');
        db.updatePipelineRun(pipelineRunId, {
          publish_manifest: JSON.stringify(results.shopifyManifest)
        });
      } catch (err) {
        console.warn('[ApparelPipeline] Could not persist publish_manifest:', err.message);
      }
    }

    // ------------------------------------------------------------------
    // Step 7: Generate themed reels (legacy inline mode)
    // ------------------------------------------------------------------
    // By default this step is SKIPPED — reels are now created manually in
    // reel-studio against the persisted pipeline_runs row. Pass
    // skipReels: false to opt into the legacy auto-generation path.
    //
    // When legacy mode: each theme's images are split into chunks of 4-5.
    // First reel per theme → TikTok Shop. Remaining → Shopify landing pages.
    // ------------------------------------------------------------------
    const allReelRecords = []; // collect for Step 7c landing pages

    if (!skipReels) {
      reportProgress('create-reels', { progress: 0, total: Object.keys(themeGroups).length });
      console.log('[ApparelPipeline] Step 7: Generating themed reels (chunked, 4-5 images each)');
      if (notify) await sendTelegram('🎬 Generating TikTok reels (4-5 images each)...');

      const mockupDir = PIPELINE_OUTPUT_DIR;

      // Use Shopify manifest from direct publishBatch call, or fall back to disk
      let publishManifest = results.shopifyManifest || [];
      if (!publishManifest.length) {
        const manifestDir = PIPELINE_OUTPUT_DIR;
        if (fs.existsSync(manifestDir)) {
          const manifests = fs.readdirSync(manifestDir)
            .filter(f => f.startsWith('shopify_publish_'))
            .sort().reverse();
          if (manifests.length) {
            try {
              const mf = JSON.parse(fs.readFileSync(path.join(manifestDir, manifests[0]), 'utf8'));
              publishManifest = mf.results || [];
            } catch (_) {}
          }
        }
      }
      console.log(`[ApparelPipeline] Shopify manifest: ${publishManifest.filter(r => r.shopifyId).length} products with IDs`);

      for (const [theme, items] of Object.entries(themeGroups)) {
        // Gather all mockup paths + design info for this theme
        const allMockups = []; // { path, name, designId, item }

        for (const item of items) {
          const designId = item.design.id || item.design.slug || '';
          let foundPath = null;

          // Look for mockup files matching this design
          if (fs.existsSync(mockupDir)) {
            const files = fs.readdirSync(mockupDir).filter(f =>
              f.includes(designId) && /\.(png|jpg|jpeg|webp)$/i.test(f)
            );
            if (files.length) {
              foundPath = path.join(mockupDir, files[0]);
            }
          }

          // Fallback to design preview image
          if (!foundPath) {
            const preview = item.design.preview || item.design.image;
            if (preview) {
              const previewPath = path.join(APP_ROOT, 'web', preview);
              if (fs.existsSync(previewPath)) foundPath = previewPath;
            }
          }

          if (foundPath) {
            allMockups.push({ path: foundPath, name: item.name, designId, item });
          }
        }

        if (allMockups.length < MIN_REEL_IMAGES) {
          console.log(`[ApparelPipeline] Skipping reels for "${theme}" — only ${allMockups.length} images (need ${MIN_REEL_IMAGES})`);
          continue;
        }

        // Chunk mockups into groups of REEL_CHUNK_SIZE (4-5 per reel)
        const chunks = [];
        for (let i = 0; i < allMockups.length; i += REEL_CHUNK_SIZE) {
          const chunk = allMockups.slice(i, i + REEL_CHUNK_SIZE);
          // If the last chunk is too small, merge it with the previous one
          if (chunk.length < MIN_REEL_IMAGES && chunks.length > 0) {
            chunks[chunks.length - 1].push(...chunk);
          } else if (chunk.length >= MIN_REEL_IMAGES) {
            chunks.push(chunk);
          } else {
            // Single small chunk — still create a reel if we have enough
            chunks.push(chunk);
          }
        }

        // Filter out any chunks that ended up below minimum
        const validChunks = chunks.filter(c => c.length >= MIN_REEL_IMAGES);
        if (!validChunks.length) {
          console.log(`[ApparelPipeline] No valid reel chunks for "${theme}" after chunking`);
          continue;
        }

        console.log(`[ApparelPipeline] Theme "${theme}": ${allMockups.length} images → ${validChunks.length} reels`);

        for (let chunkIdx = 0; chunkIdx < validChunks.length; chunkIdx++) {
          const chunk = validChunks[chunkIdx];
          const mockupPaths = chunk.map(m => m.path);
          const designNames = chunk.map(m => m.name);
          const chunkDesignIds = chunk.map(m => m.designId).filter(Boolean);
          const isTikTokShopReel = chunkIdx === 0; // first reel → TikTok Shop

          try {
            const reelLabel = validChunks.length > 1 ? `${theme}-pt${chunkIdx + 1}` : theme;
            const reel = generateThemedReel(theme, mockupPaths, { designNames });
            results.reelsCreated++;
            results.reelUrls.push(reel.outputUrl);
            console.log(`[ApparelPipeline] Reel ${chunkIdx + 1}/${validChunks.length} created: ${reel.outputUrl} (${isTikTokShopReel ? 'TikTok Shop' : 'Shopify'})`);

            // Find Shopify product IDs for designs in this chunk
            const shopifyProductIds = publishManifest
              .filter(r => r.shopifyId && chunkDesignIds.some(did => r.designId?.includes(did.substring(0, 20))))
              .map(r => String(r.shopifyId));

            // Save reel → product association in DB
            try {
              const db = require('../db');
              const videoId = `tv_${crypto.randomBytes(8).toString('hex')}`;
              const platform = isTikTokShopReel ? 'tiktok-shop' : 'shopify';
              db.createTiktokVideo({
                id: videoId,
                filename: path.basename(reel.outputPath || reel.outputUrl),
                url: reel.outputUrl,
                template: theme,
                collection: options.campaignSlug || collectionCategory || categoryLabel,
                designs: JSON.stringify(chunkDesignIds),
                shopifyProductIds: JSON.stringify(shopifyProductIds),
                duration: reel.duration || null,
                fileSize: reel.size || null,
                status: 'draft',
                platform,
                caption: THEME_COPY[theme]?.hooks?.[0] + ' ' + (THEME_COPY[theme]?.body || '')
              });

              allReelRecords.push({
                videoId,
                theme,
                chunkIdx,
                isTikTokShopReel,
                reel,
                designIds: chunkDesignIds,
                designNames,
                shopifyProductIds,
                items: chunk.map(m => m.item)
              });

              console.log(`[ApparelPipeline] Saved reel record: ${videoId} (${platform}) with ${shopifyProductIds.length} products`);
            } catch (dbErr) {
              console.warn(`[ApparelPipeline] Could not save reel record: ${dbErr.message}`);
            }
          } catch (err) {
            console.error(`[ApparelPipeline] Reel generation failed for "${theme}" chunk ${chunkIdx + 1}: ${err.message}`);
            results.errors.push(`Reel ${theme} chunk ${chunkIdx + 1} failed: ${err.message}`);
          }
        }
      }

      if (notify && results.reelsCreated > 0) {
        const tiktokCount = allReelRecords.filter(r => r.isTikTokShopReel).length;
        const shopifyCount = allReelRecords.filter(r => !r.isTikTokShopReel).length;
        await sendTelegram(`🎬 Created ${results.reelsCreated} reels (${tiktokCount} TikTok Shop, ${shopifyCount} Shopify)`);
        reportProgress('create-reels', { progress: results.reelsCreated, total: results.reelsCreated });
      }
    }

    // ------------------------------------------------------------------
    // Step 7b + 7c: TikTok Shop publishing + Shopify landing pages
    // (Extracted to server/modules/reel-followup.js so they can also run
    // later, after reels are made manually in reel-studio.)
    // ------------------------------------------------------------------
    results.landingPages = [];
    if (allReelRecords.length > 0 && !options.skipShopify) {
      const reelFollowup = require('./reel-followup');
      const followupCtx = {
        notify,
        apparelChoices: options.apparelChoices,
        sendTelegram,
        reportProgress,
        results
      };
      await reelFollowup.publishTiktokShopReelProducts(allReelRecords, followupCtx);
      await reelFollowup.createReelLandingPages(allReelRecords, followupCtx);
    }

    // ------------------------------------------------------------------
    // Step 8: Final summary
    // ------------------------------------------------------------------
    reportProgress('complete', { progress: 1, total: 1 });
    results.completedAt = new Date().toISOString();
    const durationMs = new Date(results.completedAt) - new Date(results.startedAt);
    const durationMin = Math.round(durationMs / 60000);

    if (notify) {
      const reelList = results.reelUrls.length
        ? results.reelUrls.map(u => `  ${u}`).join('\n')
        : '  (none)';
      const errorNote = results.errors.length
        ? `\n⚠️ Errors: ${results.errors.length}`
        : '';

      const pageCount = (results.landingPages || []).length;
      await sendTelegram(
        `🏭 *Pipeline Complete — ${categoryLabel}*\n` +
        `⏱ Duration: ${durationMin}min\n` +
        `📊 Categorized: ${results.categorized}\n` +
        `🎨 Mockups: ${results.mockupsGenerated}\n` +
        `🛍 Shopify: ${results.shopifyPublished}\n` +
        `🎬 Reels: ${results.reelsCreated}\n` +
        `📄 Landing Pages: ${pageCount}\n` +
        `Reel URLs:\n${reelList}${errorNote}`,
        'Markdown'
      );
    }

    logToJournal({
      type: 'pipeline-run',
      category: collectionCategory,
      results: {
        categorized: results.categorized,
        mockups: results.mockupsGenerated,
        shopify: results.shopifyPublished,
        reels: results.reelsCreated,
        errors: results.errors.length
      },
      durationMin
    });

  } catch (err) {
    results.error = err.message;
    results.errors.push(err.message);
    console.error('[ApparelPipeline] Pipeline failed:', err);

    if (notify) {
      await sendTelegram(`❌ *Pipeline Failed*\n${collectionCategory || categoryLabel}\n${err.message}`, 'Markdown');
    }

    logToJournal({
      type: 'pipeline-error',
      category: collectionCategory || categoryLabel,
      error: err.message
    });
  }

  return results;
}

// ============================================================================
// ENTRY POINT — called by marketing team
// ============================================================================

/**
 * Process a new collection end-to-end.
 * This is the main entry point the marketing team automation calls.
 *
 * @param {string} categoryName - Collection/category name from catalog
 * @param {object} [options] - Pipeline options
 * @returns {object} Pipeline results
 */
async function processNewCollection(categoryName, options = {}) {
  console.log(`[ApparelPipeline] === Processing new collection: ${categoryName} ===`);

  await sendTelegram(
    `🚀 *New Collection Drop*\nStarting pipeline for: ${categoryName}`,
    'Markdown'
  );

  const results = await runFullPipeline(categoryName, {
    notify: true,
    ...options
  });

  // Log to marketing journal
  logToJournal({
    type: 'collection-drop',
    category: categoryName,
    summary: `Processed ${results.categorized} designs, ${results.mockupsGenerated} mockups, ${results.shopifyPublished} published, ${results.reelsCreated} reels`,
    results
  });

  return results;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  runFullPipeline,
  processNewCollection,
  generateThemedReel,
  matchModelToDesign,
  buildReelLandingPageHtml,
  formatThemeName,
  PIPELINE_STEPS,
  THEME_COPY
};
