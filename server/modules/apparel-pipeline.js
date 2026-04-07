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
const { TIKTOK_VIDEOS_DIR, TIKTOK_TIKTOK_MUSIC_DIR, PIPELINE_TIKTOK_VIDEOS_DIR, PRODUCT_BLANKS_DIR } = require('../paths');

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
function buildReelLandingPageHtml({ title, hook, body, products, collectionHandle, reelUrl, theme, isTikTokShopReel, apparelChoices }) {
  // Build color label from apparel choices
  const colorNames = (apparelChoices || [])
    .filter(Boolean)
    .map(a => a.color || a.colorName || '')
    .filter(Boolean);
  const colorLabel = colorNames.length > 1
    ? colorNames.slice(0, -1).join(', ') + ' & ' + colorNames[colorNames.length - 1]
    : colorNames[0] || 'multiple colors';

  const productGridHtml = products.map(p => {
    const productUrl = p.handle ? `/products/${p.handle}` : '#';

    // Hero image (lifestyle mockup) — first image
    const heroImg = p.image
      ? `<img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.title)}" style="width:100%;height:auto;border-radius:8px;aspect-ratio:3/4;object-fit:cover;" loading="lazy">`
      : '';

    // Product blank images (the actual shirt colors)
    const blankImgs = (p.images || []).slice(1, 3).map(img =>
      `<img src="${escapeHtml(img)}" alt="${escapeHtml(p.title)}" style="width:100%;height:auto;border-radius:6px;aspect-ratio:1/1;object-fit:cover;" loading="lazy">`
    ).join('');

    return `
      <div style="text-align:center;border:1px solid #eee;border-radius:12px;overflow:hidden;background:#fff;">
        <a href="${productUrl}" style="text-decoration:none;color:inherit;">
          ${heroImg}
        </a>
        <div style="padding:12px 16px;">
          <h3 style="margin:0 0 4px;font-size:15px;font-weight:600;color:#1a1a1a;">${escapeHtml(p.title)}</h3>
          <p style="margin:0 0 8px;font-size:18px;font-weight:700;color:#2d2d2d;">From $${escapeHtml(p.price)}</p>
          ${blankImgs ? `
          <p style="font-size:12px;color:#888;margin:0 0 8px;">Available in ${escapeHtml(colorLabel)}</p>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px;">
            ${blankImgs}
          </div>` : ''}
          <a href="${productUrl}" style="display:inline-block;width:100%;padding:10px 0;background:#1a1a1a;color:#fff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">Choose Color &amp; Size</a>
        </div>
      </div>`;
  }).join('\n');

  return `
<div style="max-width:900px;margin:0 auto;padding:20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <!-- Hero Section -->
  <div style="text-align:center;margin-bottom:32px;">
    <h1 style="font-size:28px;font-weight:800;margin:0 0 8px;color:#1a1a1a;">${escapeHtml(hook || title)}</h1>
    <p style="font-size:16px;color:#555;margin:0 0 12px;max-width:600px;display:inline-block;">${escapeHtml(body || '')}</p>
    <p style="font-size:14px;color:#1a1a1a;margin:0 0 4px;font-weight:600;">Each design is available in ${escapeHtml(colorLabel)}.</p>
    <p style="font-size:13px;color:#888;margin:0;">Select your color and size on the product page. Printed locally in Asheville, NC.</p>
  </div>

  <!-- Product Grid -->
  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:20px;margin-bottom:40px;">
    ${productGridHtml}
  </div>

  <!-- See More Button -->
  <div style="text-align:center;margin:40px 0;">
    <a href="/collections/${escapeHtml(collectionHandle)}" style="display:inline-block;padding:16px 48px;background:#2d2d2d;color:#fff;text-decoration:none;border-radius:8px;font-size:18px;font-weight:700;letter-spacing:0.5px;">See More Designs</a>
  </div>

  <!-- Footer -->
  <div style="text-align:center;padding:24px 0;border-top:1px solid #eee;margin-top:20px;">
    <p style="font-size:13px;color:#999;margin:0;">Handmade in Asheville, NC | Blue Ridge Custom Co</p>
  </div>
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
      const modelData = await apiFetch('/api/human-models');
      models = Array.isArray(modelData) ? modelData : (modelData.models || modelData.items || []);
    } catch (err) {
      console.warn('[ApparelPipeline] Could not fetch models:', err.message);
      results.errors.push('Model fetch failed: ' + err.message);
    }

    // Filter to a specific model group if requested
    if (models.length && options.modelGroupId) {
      try {
        const groupData = await apiFetch(`/api/model-groups/${encodeURIComponent(options.modelGroupId)}`);
        const memberIds = new Set((groupData.members || []).map(m => m.id));
        const filtered = models.filter(m => memberIds.has(m.id));
        if (filtered.length) {
          console.log(`[ApparelPipeline] Filtered to model group "${groupData.group?.name}": ${filtered.length} of ${models.length} models`);
          models = filtered;
        } else {
          console.warn(`[ApparelPipeline] Model group "${options.modelGroupId}" has no matching models, using all ${models.length}`);
        }
      } catch (err) {
        console.warn('[ApparelPipeline] Model group filter failed, using all models:', err.message);
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
    // Step 7: Generate themed reels (chunked into 4-5 images per reel)
    // ------------------------------------------------------------------
    // Each theme's images are split into chunks of 4-5.
    // First reel per theme → TikTok Shop (products associated to video).
    // Remaining reels → Shopify store (with landing pages).
    // ------------------------------------------------------------------
    const allReelRecords = []; // collect for Step 7c landing pages

    if (!options.skipReels) {
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
    // Step 7b: Publish TikTok Shop reel products only
    // ------------------------------------------------------------------
    // Only the first reel per theme goes to TikTok Shop. Associate those
    // specific products so customers can buy what they see in the video.
    const tiktokShopReels = allReelRecords.filter(r => r.isTikTokShopReel);
    if (tiktokShopReels.length > 0 && !options.skipShopify) {
      console.log(`[ApparelPipeline] Step 7b: Publishing ${tiktokShopReels.length} TikTok Shop reel products`);
      if (notify) await sendTelegram('🛒 Adding TikTok Shop reel products...');

      try {
        const shopify = require('../integrations/shopify');
        const tiktokPub = await shopify.findTikTokPublication();

        if (tiktokPub) {
          const currentTikTok = await shopify.getProductsOnPublication(tiktokPub.id).catch(() => []);
          let currentCount = currentTikTok.length;
          console.log(`[ApparelPipeline] TikTok Shop: ${currentCount}/100 products currently`);

          // Only add products from TikTok Shop reels
          const tiktokProductIds = [];
          for (const rec of tiktokShopReels) {
            tiktokProductIds.push(...rec.shopifyProductIds);
          }
          const uniqueIds = [...new Set(tiktokProductIds)];

          const available = 100 - currentCount;
          const toAdd = uniqueIds.slice(0, Math.max(0, available));

          if (toAdd.length > 0) {
            let added = 0;
            for (const pid of toAdd) {
              try {
                await shopify.publishToPublications(pid, [tiktokPub.id]);
                added++;
              } catch (err) {
                console.warn(`[ApparelPipeline] TikTok publish failed for ${pid}: ${err.message}`);
              }
              await new Promise(r => setTimeout(r, 500));
            }
            console.log(`[ApparelPipeline] Added ${added} products to TikTok Shop (${currentCount + added}/100)`);
            if (notify) await sendTelegram(`🛒 Added ${added} products to TikTok Shop (${currentCount + added}/100 total)`);
          } else {
            console.log(`[ApparelPipeline] TikTok Shop at capacity (${currentCount}/100), skipping`);
            if (notify) await sendTelegram(`⚠️ TikTok Shop at capacity (${currentCount}/100)`);
          }
        } else {
          console.log('[ApparelPipeline] TikTok Shop channel not found in Shopify');
        }
      } catch (err) {
        console.error('[ApparelPipeline] TikTok Shop publish error:', err.message);
        if (notify) await sendTelegram(`⚠️ TikTok Shop publish failed: ${err.message}`);
      }
    }

    // ------------------------------------------------------------------
    // Step 7c: Create Shopify landing pages for each reel
    // ------------------------------------------------------------------
    // Each reel gets a dedicated landing page showing the featured products
    // with images, prices, and a "See More" button to the full collection.
    results.landingPages = [];

    if (allReelRecords.length > 0 && !options.skipShopify) {
      reportProgress('landing-pages', { progress: 0, total: allReelRecords.length });
      console.log(`[ApparelPipeline] Step 7c: Creating Shopify landing pages for ${allReelRecords.length} reels`);
      if (notify) await sendTelegram('📄 Creating Shopify landing pages for reels...');

      try {
        const shopify = require('../integrations/shopify');
        const db = require('../db');

        // Find the apparel collection handle for the "See More" link
        let collectionHandle = 'apparel';
        try {
          const collections = await shopify.listCollections();
          const apparelCol = (collections || []).find(c =>
            (c.title || '').toLowerCase().includes('apparel')
          );
          if (apparelCol && apparelCol.handle) collectionHandle = apparelCol.handle;
        } catch (_) {}

        for (const rec of allReelRecords) {
          try {
            // Fetch product details from Shopify for the landing page
            const productCards = [];
            for (const pid of rec.shopifyProductIds) {
              try {
                const product = await shopify.getProduct(pid);
                if (product) {
                  const allImages = Array.isArray(product.images) ? product.images.map(img => img.src) : [];
                  const heroImage = allImages[0] || (product.image?.src || '');
                  const price = product.variants?.[0]?.price || '24.99';
                  const handle = product.handle || '';
                  productCards.push({
                    title: product.title || 'Custom Tee',
                    image: heroImage,
                    images: allImages,
                    price,
                    handle,
                    id: pid
                  });
                }
              } catch (err) {
                console.warn(`[ApparelPipeline] Could not fetch product ${pid}: ${err.message}`);
              }
            }

            if (!productCards.length) {
              console.log(`[ApparelPipeline] No products found for reel ${rec.videoId}, skipping landing page`);
              continue;
            }

            // Build the landing page HTML
            const copy = THEME_COPY[rec.theme] || THEME_COPY.default;
            const reelNum = rec.chunkIdx + 1;
            const pageTitle = `${formatThemeName(rec.theme)} Collection${allReelRecords.filter(r => r.theme === rec.theme).length > 1 ? ` - Part ${reelNum}` : ''}`;
            const pageHandle = `reel-${rec.theme}${rec.chunkIdx > 0 ? '-pt' + reelNum : ''}-${Date.now()}`;

            const bodyHtml = buildReelLandingPageHtml({
              title: pageTitle,
              hook: pick(copy.hooks),
              body: copy.body,
              products: productCards,
              collectionHandle,
              reelUrl: rec.reel.outputUrl,
              theme: rec.theme,
              isTikTokShopReel: rec.isTikTokShopReel,
              apparelChoices: options.apparelChoices
            });

            // Check if page already exists (avoid duplicates)
            const existing = await shopify.findPageByTitle(pageTitle).catch(() => null);
            let page;
            if (existing) {
              page = await shopify.updatePage(existing.id, { body_html: bodyHtml, published: true });
              console.log(`[ApparelPipeline] Updated existing landing page: ${existing.id}`);
            } else {
              page = await shopify.createPage({ title: pageTitle, body_html: bodyHtml, published: true });
              console.log(`[ApparelPipeline] Created landing page: ${page.id} — "${pageTitle}"`);
            }

            // Update the tiktok_videos record with the Shopify page info
            if (page && page.id) {
              const pageUrl = `/pages/${page.handle || pageHandle}`;
              try {
                db.updateTiktokVideo(rec.videoId, {
                  shopify_page_id: String(page.id),
                  shopify_page_url: pageUrl
                });
              } catch (_) {}

              results.landingPages.push({
                videoId: rec.videoId,
                theme: rec.theme,
                pageId: page.id,
                pageUrl,
                productCount: productCards.length,
                isTikTokShopReel: rec.isTikTokShopReel
              });
            }
          } catch (err) {
            console.error(`[ApparelPipeline] Landing page failed for reel ${rec.videoId}: ${err.message}`);
            results.errors.push(`Landing page ${rec.videoId} failed: ${err.message}`);
          }
          reportProgress('landing-pages', { progress: results.landingPages.length, total: allReelRecords.length });
        }

        if (notify && results.landingPages.length > 0) {
          await sendTelegram(`📄 Created ${results.landingPages.length} Shopify landing pages`);
        }
      } catch (err) {
        console.error('[ApparelPipeline] Landing page step failed:', err.message);
        if (notify) await sendTelegram(`⚠️ Landing page step failed: ${err.message}`);
      }
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
