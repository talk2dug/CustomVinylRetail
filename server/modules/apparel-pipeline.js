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

const APP_ROOT = path.resolve(__dirname, '..', '..');
const CATALOG_PATH = path.join(APP_ROOT, 'web', 'catalog.json');
const OUTPUT_DIR = '/mnt/websit/tiktok-videos';
const MUSIC_DIR = '/mnt/websit/tiktok-music';
const TEMP_DIR = path.join(OUTPUT_DIR, 'tmp');
const FONT_PATH = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const JOURNAL_PATH = path.join(APP_ROOT, 'data', 'apparel-pipeline-log.json');

const API_BASE = `http://localhost:${process.env.PORT || 4000}`;
const API_KEY = process.env.INTERNAL_API_KEY || '';

const WIDTH = 1080;
const HEIGHT = 1920;
const SLIDE_DURATION = 3.5; // seconds per image slide
const MIN_REEL_IMAGES = 4;

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
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
  if (!fs.existsSync(MUSIC_DIR)) return null;
  const tracks = fs.readdirSync(MUSIC_DIR).filter(f => /\.(mp3|ogg|m4a|wav)$/.test(f));
  if (!tracks.length) return null;
  return path.join(MUSIC_DIR, pick(tracks));
}

function escapeFFText(text) {
  return text.replace(/'/g, "'\\''").replace(/:/g, '\\:').replace(/%/g, '%%');
}

/**
 * Build a single slide image (1080x1920) from a mockup image with text overlay.
 * Uses ffmpeg to resize/pad + draw text.
 */
function buildSlide(inputPath, outputPath, { text, textPosition = 'bottom', fontSize = 48 }) {
  const escaped = text ? escapeFFText(text) : '';
  const safeMargin = Math.round(WIDTH * 0.15); // 15% each side

  let filterChain = `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2:black`;

  if (escaped) {
    const yPos = textPosition === 'top' ? '(h*0.12)' :
                 textPosition === 'bottom' ? '(h*0.68)' : '(h*0.42)';

    filterChain += `,drawtext=fontfile='${FONT_PATH}':text='${escaped}':fontcolor=white:fontsize=${fontSize}:x=if(gt(text_w\\,w-${safeMargin * 2})\\,${safeMargin}\\,(w-text_w)/2):y=${yPos}:box=1:boxcolor=black@0.55:boxborderw=16`;
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

    if (i === 0) {
      // Hook slide — big text
      text = pick(copy.hooks);
      textPosition = 'center';
      fontSize = 64;
    } else if (i === mockupPaths.length - 1) {
      // CTA slide
      text = pick(copy.ctas);
      textPosition = 'bottom';
      fontSize = 56;
    } else if (designNames[i]) {
      // Middle slide — design name
      text = designNames[i];
      textPosition = 'bottom';
      fontSize = 44;
    }

    const slideFile = path.join(TEMP_DIR, `slide-${runId}-${i}.png`);
    try {
      buildSlide(imgPath, slideFile, { text, textPosition, fontSize });
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
  const outputPath = path.join(OUTPUT_DIR, outputName);
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
// FULL PIPELINE
// ============================================================================

/**
 * Run the full apparel pipeline for a collection category.
 *
 * @param {string} collectionCategory - Category name from catalog.json
 * @param {object} [options]
 * @param {number} [options.limit] - Max designs to process
 * @param {string} [options.modelFilter] - Model filter (e.g. 'phoenix')
 * @param {string} [options.size] - Mockup size
 * @param {boolean} [options.skipShopify] - Skip Shopify publish step
 * @param {boolean} [options.skipReels] - Skip reel generation step
 * @param {boolean} [options.notify] - Send Telegram notifications (default true)
 * @returns {object} Pipeline results
 */
async function runFullPipeline(collectionCategory, options = {}) {
  const notify = options.notify !== false;
  const results = {
    category: collectionCategory,
    categorized: 0,
    mockupsGenerated: 0,
    shopifyPublished: 0,
    reelsCreated: 0,
    reelUrls: [],
    errors: [],
    startedAt: new Date().toISOString()
  };

  try {
    // ------------------------------------------------------------------
    // Step 1: Load catalog and get designs for this category
    // ------------------------------------------------------------------
    console.log(`[ApparelPipeline] Step 1: Loading designs for "${collectionCategory}"`);
    const catalog = loadCatalog();
    const cat = catalog.categories.find(c =>
      c.name.toLowerCase().includes(collectionCategory.toLowerCase()) ||
      (c.slug && c.slug.toLowerCase().includes(collectionCategory.toLowerCase()))
    );
    if (!cat) throw new Error(`Category not found: "${collectionCategory}"`);

    const designs = cat.designs || [];
    const limit = options.limit || designs.length;
    const designsToProcess = designs.slice(0, limit);

    if (!designsToProcess.length) throw new Error(`No designs found in category "${collectionCategory}"`);

    if (notify) {
      await sendTelegram(
        `🏭 *Apparel Pipeline Started*\nCategory: ${cat.name}\nDesigns: ${designsToProcess.length}`,
        'Markdown'
      );
    }

    // ------------------------------------------------------------------
    // Step 2: Categorize designs by theme
    // ------------------------------------------------------------------
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
      } catch (err) {
        console.warn(`[ApparelPipeline] Failed to categorize ${design.name || design.id}: ${err.message}`);
        // Put uncategorized designs in default
        if (!themeGroups.default) themeGroups.default = [];
        themeGroups.default.push({ design, category: null, name: design.name || 'Unknown' });
        results.categorized++;
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
    console.log('[ApparelPipeline] Step 3: Matching models to designs');
    let models = [];
    try {
      const modelData = await apiFetch('/api/human-models');
      models = Array.isArray(modelData) ? modelData : (modelData.models || modelData.items || []);
    } catch (err) {
      console.warn('[ApparelPipeline] Could not fetch models:', err.message);
      results.errors.push('Model fetch failed: ' + err.message);
    }

    if (models.length) {
      for (const theme of Object.keys(themeGroups)) {
        for (const item of themeGroups[theme]) {
          item.matchedModel = matchModelToDesign(theme, models, collectionCategory);
        }
      }
      console.log(`[ApparelPipeline] Matched models for ${results.categorized} designs`);
    }

    // ------------------------------------------------------------------
    // Step 4: Generate mockups via batch API
    // ------------------------------------------------------------------
    console.log('[ApparelPipeline] Step 4: Generating mockups');
    if (notify) await sendTelegram('🎨 Generating mockups...');

    let mockupJobId = null;
    try {
      const mockupResp = await apiFetch('/api/batch-mockups/generate', {
        method: 'POST',
        body: JSON.stringify({
          category: collectionCategory,
          limit: limit,
          modelFilter: options.modelFilter || 'phoenix',
          size: options.size || 'medium'
        })
      });
      mockupJobId = mockupResp.jobId || mockupResp.id;
      results.mockupsGenerated = mockupResp.count || mockupResp.queued || 0;
      console.log(`[ApparelPipeline] Mockup job started: ${mockupJobId}, count: ${results.mockupsGenerated}`);
    } catch (err) {
      console.error('[ApparelPipeline] Mockup generation failed:', err.message);
      results.errors.push('Mockup generation failed: ' + err.message);
    }

    // ------------------------------------------------------------------
    // Step 5: Poll for mockup completion
    // ------------------------------------------------------------------
    if (mockupJobId) {
      console.log('[ApparelPipeline] Step 5: Waiting for mockups to complete');
      const maxPolls = 60; // 10 minutes max
      let completed = false;

      for (let i = 0; i < maxPolls; i++) {
        await sleep(10000); // 10s between polls
        try {
          const status = await apiFetch(`/api/batch-mockups/${mockupJobId || ''}`, {
            timeout: 15000
          });
          const progress = status.completed || status.progress || 0;
          const total = status.total || results.mockupsGenerated || 1;

          if (status.status === 'complete' || status.done || progress >= total) {
            results.mockupsGenerated = progress;
            completed = true;
            console.log(`[ApparelPipeline] Mockups complete: ${progress}/${total}`);
            break;
          }
          if (status.status === 'error' || status.failed) {
            results.errors.push('Mockup job failed: ' + (status.error || 'unknown'));
            break;
          }
          if (i % 6 === 5) {
            console.log(`[ApparelPipeline] Mockup progress: ${progress}/${total}`);
          }
        } catch (err) {
          // Poll endpoint might not exist as a GET — that's ok, just wait
          if (i === 5) console.warn('[ApparelPipeline] Mockup poll failed, will assume done after timeout');
        }
      }

      if (!completed) {
        console.log('[ApparelPipeline] Mockup poll timed out, proceeding anyway');
      }
    }

    if (notify) {
      await sendTelegram(`✅ Lifestyle mockups generated: ${results.mockupsGenerated}`);
    }

    // ------------------------------------------------------------------
    // Step 5b: Generate product blank mockups (what they'll actually get)
    // ------------------------------------------------------------------
    console.log('[ApparelPipeline] Step 5b: Generating product blank mockups');
    if (notify) await sendTelegram('👕 Generating product blank mockups (white tee, black tee, + theme pick)...');

    try {
      const { generateProductMockups } = require('./product-blank-mockup');
      const LIBRARY_ROOT = process.env.LIBRARY_ROOT || path.join(APP_ROOT, 'web', 'library');
      let blankCount = 0;

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
          const existingBlanks = fs.existsSync('/mnt/dbFiles/product-blank-mockups')
            ? fs.readdirSync('/mnt/dbFiles/product-blank-mockups').filter(f => f.includes(item.design.id.substring(0, 30)))
            : [];
          if (existingBlanks.length >= 2) continue; // already done

          try {
            const blanks = await generateProductMockups(item.design.id, graphicPath, theme);
            blankCount += blanks.length;
          } catch (err) {
            console.warn(`[ApparelPipeline] Product blank failed for ${item.design.id}: ${err.message}`);
          }
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
      console.log('[ApparelPipeline] Step 6: Publishing to Shopify');
      if (notify) await sendTelegram('🛍 Publishing to Shopify...');

      try {
        const shopifyResp = await apiFetch('/api/shopify-apparel/publish', {
          method: 'POST',
          body: JSON.stringify({
            category: collectionCategory,
            limit: limit
          }),
          timeout: 300000 // 5 min for Shopify
        });
        results.shopifyPublished = shopifyResp.published || shopifyResp.count || 0;
        console.log(`[ApparelPipeline] Published ${results.shopifyPublished} to Shopify`);

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
    // Step 7: Generate themed reels
    // ------------------------------------------------------------------
    if (!options.skipReels) {
      console.log('[ApparelPipeline] Step 7: Generating themed reels');
      if (notify) await sendTelegram('🎬 Generating TikTok reels...');

      const mockupDir = '/mnt/dbFiles/apparel-mockups';

      for (const [theme, items] of Object.entries(themeGroups)) {
        if (items.length < MIN_REEL_IMAGES) {
          console.log(`[ApparelPipeline] Skipping reel for "${theme}" — only ${items.length} designs (need ${MIN_REEL_IMAGES})`);
          continue;
        }

        // Find mockup images for these designs
        const mockupPaths = [];
        const designNames = [];

        for (const item of items) {
          const designId = item.design.id || item.design.slug || '';
          // Look for mockup files matching this design
          if (fs.existsSync(mockupDir)) {
            const files = fs.readdirSync(mockupDir).filter(f =>
              f.includes(designId) && /\.(png|jpg|jpeg|webp)$/i.test(f)
            );
            if (files.length) {
              mockupPaths.push(path.join(mockupDir, files[0]));
              designNames.push(item.name);
            }
          }
          // Fallback to design preview image
          if (mockupPaths.length === designNames.length - 1 || (!mockupPaths.length && !designNames.length)) {
            const preview = item.design.preview || item.design.image;
            if (preview) {
              const previewPath = path.join(APP_ROOT, 'web', preview);
              if (fs.existsSync(previewPath)) {
                mockupPaths.push(previewPath);
                designNames.push(item.name);
              }
            }
          }
        }

        if (mockupPaths.length < MIN_REEL_IMAGES) {
          console.log(`[ApparelPipeline] Not enough mockup images for "${theme}" reel (${mockupPaths.length}/${MIN_REEL_IMAGES})`);
          continue;
        }

        try {
          const reel = generateThemedReel(theme, mockupPaths, { designNames });
          results.reelsCreated++;
          results.reelUrls.push(reel.outputUrl);
          console.log(`[ApparelPipeline] Reel created: ${reel.outputUrl}`);

          // Save reel → product association in DB
          try {
            const db = require('../db');
            const designIds = items.map(item => item.design?.id).filter(Boolean);

            // Find Shopify product IDs for these designs from the publish manifest
            let shopifyProductIds = [];
            const manifestDir = '/mnt/dbFiles/apparel-mockups';
            if (fs.existsSync(manifestDir)) {
              const manifests = fs.readdirSync(manifestDir)
                .filter(f => f.startsWith('shopify_publish_'))
                .sort().reverse();
              if (manifests.length) {
                const manifest = JSON.parse(fs.readFileSync(path.join(manifestDir, manifests[0]), 'utf8'));
                shopifyProductIds = (manifest.results || [])
                  .filter(r => r.shopifyId && designIds.some(did => r.designId?.includes(did.substring(0, 20))))
                  .map(r => String(r.shopifyId));
              }
            }

            const videoId = `tv_${crypto.randomBytes(8).toString('hex')}`;
            db.createTiktokVideo({
              id: videoId,
              filename: path.basename(reel.outputPath || reel.outputUrl),
              url: reel.outputUrl,
              template: theme,
              collection: collectionCategory,
              designs: JSON.stringify(designIds),
              shopifyProductIds: JSON.stringify(shopifyProductIds),
              duration: reel.duration || null,
              fileSize: reel.size || null,
              status: 'draft',
              caption: THEME_COPY[theme]?.hooks?.[0] + ' ' + (THEME_COPY[theme]?.body || '')
            });

            console.log(`[ApparelPipeline] Saved reel record: ${videoId} with ${shopifyProductIds.length} product associations`);
          } catch (dbErr) {
            console.warn(`[ApparelPipeline] Could not save reel record: ${dbErr.message}`);
          }
        } catch (err) {
          console.error(`[ApparelPipeline] Reel generation failed for "${theme}": ${err.message}`);
          results.errors.push(`Reel ${theme} failed: ${err.message}`);
        }
      }

      if (notify && results.reelsCreated > 0) {
        await sendTelegram(`🎬 Created ${results.reelsCreated} TikTok reels`);
      }
    }

    // ------------------------------------------------------------------
    // Step 7b: Publish featured products to TikTok Shop
    // ------------------------------------------------------------------
    // Products in the reels should be on TikTok Shop so customers can buy
    // what they see in the video. Respects the 100-product TikTok limit.
    if (results.reelsCreated > 0 && !options.skipShopify) {
      console.log('[ApparelPipeline] Step 7b: Publishing reel products to TikTok Shop');
      if (notify) await sendTelegram('🛒 Adding reel products to TikTok Shop...');

      try {
        const shopify = require('../integrations/shopify');
        const tiktokPub = await shopify.findTikTokPublication();

        if (tiktokPub) {
          // Get products currently on TikTok to check count
          const currentTikTok = await shopify.getProductsOnPublication(tiktokPub.id).catch(() => []);
          const currentCount = currentTikTok.length;
          console.log(`[ApparelPipeline] TikTok Shop: ${currentCount}/100 products currently`);

          // Collect Shopify product IDs from the latest publish manifest
          const manifestDir = '/mnt/dbFiles/apparel-mockups';
          const manifests = fs.existsSync(manifestDir)
            ? fs.readdirSync(manifestDir).filter(f => f.startsWith('shopify_publish_')).sort().reverse()
            : [];

          if (manifests.length) {
            const latest = JSON.parse(fs.readFileSync(path.join(manifestDir, manifests[0]), 'utf8'));
            const productIds = (latest.results || [])
              .filter(r => r.shopifyId)
              .map(r => r.shopifyId);

            // Only add up to the 100 limit
            const available = 100 - currentCount;
            const toAdd = productIds.slice(0, Math.max(0, available));

            if (toAdd.length > 0) {
              let added = 0;
              for (const pid of toAdd) {
                try {
                  await shopify.publishToPublications(pid, [tiktokPub.id]);
                  added++;
                } catch (err) {
                  console.warn(`[ApparelPipeline] TikTok publish failed for ${pid}: ${err.message}`);
                }
                await new Promise(r => setTimeout(r, 500)); // rate limit
              }
              console.log(`[ApparelPipeline] Added ${added} products to TikTok Shop (${currentCount + added}/100)`);
              if (notify) await sendTelegram(`🛒 Added ${added} products to TikTok Shop (${currentCount + added}/100 total)`);
            } else {
              console.log(`[ApparelPipeline] TikTok Shop at capacity (${currentCount}/100), skipping`);
              if (notify) await sendTelegram(`⚠️ TikTok Shop at capacity (${currentCount}/100)`);
            }
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
    // Step 8: Final summary
    // ------------------------------------------------------------------
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

      await sendTelegram(
        `🏭 *Pipeline Complete — ${cat.name}*\n` +
        `⏱ Duration: ${durationMin}min\n` +
        `📊 Categorized: ${results.categorized}\n` +
        `🎨 Mockups: ${results.mockupsGenerated}\n` +
        `🛍 Shopify: ${results.shopifyPublished}\n` +
        `🎬 Reels: ${results.reelsCreated}\n` +
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
      await sendTelegram(`❌ *Pipeline Failed*\n${collectionCategory}\n${err.message}`, 'Markdown');
    }

    logToJournal({
      type: 'pipeline-error',
      category: collectionCategory,
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
  THEME_COPY
};
