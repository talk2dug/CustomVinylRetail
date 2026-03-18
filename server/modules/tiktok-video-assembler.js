/**
 * TikTok Video Assembler
 *
 * Takes raw footage clips from the footage library and assembles them into
 * TikTok-ready videos (9:16 portrait, 1080x1920, 15-60s).
 *
 * Pipeline:
 *   1. Select clips by category/tags from footage_library
 *   2. Trim to best segments (configurable in/out points)
 *   3. Crop 16:9 → 9:16 portrait (center crop or pan)
 *   4. Add text overlays (hook, product name, CTA)
 *   5. Concatenate segments with crossfade transitions
 *   6. Output final MP4 (H.264, AAC) ready for upload
 *
 * Uses ffmpeg only — no GPU required.
 */

const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');
const crypto = require('crypto');

const FOOTAGE_DIR = '/mnt/stlFiles/footage-library';
const OUTPUT_DIR = '/mnt/websit/tiktok-videos';
const TEMP_DIR = path.join(OUTPUT_DIR, 'tmp');
const MUSIC_DIR = '/mnt/websit/tiktok-music';
const FONT_PATH = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

// TikTok specs
const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 30;
const MAX_DURATION = 60;
const MIN_DURATION = 8;

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });

// ============================================================================
// TEMPLATES — predefined video structures for different content types
// ============================================================================

const TEMPLATES = {
  'product-reveal': {
    name: 'Product Reveal',
    description: 'Process shot → dramatic reveal of finished product',
    segments: [
      { role: 'hook', category: 'process', maxDuration: 4, text: null },        // auto-set
      { role: 'process', category: 'process', maxDuration: 8, text: null },
      { role: 'reveal', category: 'reveal', maxDuration: 10, text: null },
      { role: 'cta', category: 'reveal', maxDuration: 4, text: null }
    ],
    defaultTexts: {
      hook: 'Watch this...',
      process: '',
      reveal: '',
      cta: 'Link in bio!'
    }
  },
  'behind-the-scenes': {
    name: 'Behind the Scenes',
    description: 'Full process walkthrough — heat press, transfer, reveal',
    segments: [
      { role: 'hook', category: 'process', subcategory: 'heat-press', maxDuration: 5, text: null },
      { role: 'transfer', category: 'process', subcategory: 'transfer-paper', maxDuration: 10, text: null },
      { role: 'press', category: 'process', subcategory: 'heat-press', maxDuration: 8, text: null },
      { role: 'reveal', category: 'reveal', maxDuration: 10, text: null },
      { role: 'cta', category: 'close-up', maxDuration: 5, text: null }
    ],
    defaultTexts: {
      hook: 'How we make custom prints',
      transfer: 'Transfer paper ready',
      press: '',
      reveal: 'The final result',
      cta: 'Order yours today!'
    }
  },
  'quick-showcase': {
    name: 'Quick Showcase',
    description: 'Fast cut reveal + close-up — 15s max',
    segments: [
      { role: 'hook', category: 'reveal', maxDuration: 3, text: null },
      { role: 'main', category: 'reveal', maxDuration: 6, text: null },
      { role: 'detail', category: 'close-up', maxDuration: 4, text: null },
      { role: 'cta', category: 'reveal', maxDuration: 3, text: null }
    ],
    defaultTexts: {
      hook: '',
      main: 'Handmade in Asheville, NC',
      detail: '',
      cta: 'Link in bio!'
    }
  },
  'packing-order': {
    name: 'Packing an Order',
    description: 'Satisfying packing/unboxing content',
    segments: [
      { role: 'hook', category: 'packing', maxDuration: 4, text: null },
      { role: 'packing', category: 'packing', maxDuration: 15, text: null },
      { role: 'product', category: 'reveal', maxDuration: 6, text: null },
      { role: 'cta', category: 'packing', maxDuration: 3, text: null }
    ],
    defaultTexts: {
      hook: 'Packing a custom order',
      packing: '',
      product: 'Made with love in Asheville',
      cta: 'Shop link in bio!'
    }
  }
};

// ============================================================================
// FFMPEG HELPERS
// ============================================================================

function ffprobe(filePath) {
  try {
    const raw = execSync(
      `ffprobe -v quiet -print_format json -show_format -show_streams "${filePath}"`,
      { timeout: 15000, encoding: 'utf8' }
    );
    const info = JSON.parse(raw);
    const vs = (info.streams || []).find(s => s.codec_type === 'video');
    return {
      duration: parseFloat(info.format?.duration) || 0,
      width: vs?.width || 0,
      height: vs?.height || 0,
      fps: vs?.r_frame_rate ? eval(vs.r_frame_rate) : 30
    };
  } catch (e) {
    return { duration: 0, width: 0, height: 0, fps: 30 };
  }
}

/**
 * Trim + crop a clip to 9:16 portrait.
 * Center-crops horizontally from 16:9 source.
 */
function prepareSegment(inputPath, outputPath, { startTime = 0, duration, text, textPosition = 'center' }) {
  const meta = ffprobe(inputPath);
  const srcW = meta.width || 1920;
  const srcH = meta.height || 1080;
  const dur = Math.min(duration || meta.duration, meta.duration - startTime);

  // Calculate crop: take the tallest 9:16 rectangle from center
  // For 1920x1080 source: 9:16 crop = 607.5x1080, then scale up to 1080x1920
  const targetRatio = WIDTH / HEIGHT; // 0.5625
  const srcRatio = srcW / srcH;

  let cropW, cropH;
  if (srcRatio > targetRatio) {
    // Source is wider than target — crop sides
    cropH = srcH;
    cropW = Math.round(srcH * targetRatio);
  } else {
    // Source is taller — crop top/bottom
    cropW = srcW;
    cropH = Math.round(srcW / targetRatio);
  }

  let filterChain = `crop=${cropW}:${cropH}:(in_w-${cropW})/2:(in_h-${cropH})/2,scale=${WIDTH}:${HEIGHT}:flags=lanczos,setsar=1`;

  // Add text overlay if provided
  // TikTok safe zones: right ~15% has like/comment/share buttons,
  // bottom ~20% has captions/music info, left ~5% margin.
  // Keep text centered but within the safe middle ~70% of width.
  if (text && text.trim()) {
    const escaped = text.replace(/'/g, "'\\''").replace(/:/g, '\\:');
    const fontSize = text.length > 30 ? 44 : 56;
    const yPos = textPosition === 'top' ? '(h*0.15)' :
                 textPosition === 'bottom' ? '(h*0.68)' : '(h*0.42)';
    // x: center text but clamp within safe zone (15% left margin, 15% right margin = 70% usable)
    const safeMargin = Math.round(WIDTH * 0.15); // ~162px each side

    // Text with dark background box, horizontally centered in safe zone
    filterChain += `,drawtext=fontfile='${FONT_PATH}':text='${escaped}':fontcolor=white:fontsize=${fontSize}:x=if(gt(text_w\\,w-${safeMargin * 2})\\,${safeMargin}\\,(w-text_w)/2):y=${yPos}:box=1:boxcolor=black@0.55:boxborderw=14`;
  }

  const cmd = [
    'ffmpeg', '-y',
    '-ss', startTime.toFixed(2),
    '-i', `"${inputPath}"`,
    '-t', dur.toFixed(2),
    '-vf', `"${filterChain}"`,
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
    '-r', FPS,
    '-an',
    '-movflags', '+faststart',
    `"${outputPath}"`
  ].join(' ');

  execSync(cmd, { timeout: 120000, stdio: 'pipe' });
  return outputPath;
}

/**
 * Pick a random music track from the local library.
 */
function pickMusicTrack() {
  if (!fs.existsSync(MUSIC_DIR)) return null;
  const tracks = fs.readdirSync(MUSIC_DIR).filter(f => f.endsWith('.ogg') || f.endsWith('.mp3'));
  if (!tracks.length) return null;
  const pick = tracks[Math.floor(Math.random() * tracks.length)];
  return path.join(MUSIC_DIR, pick);
}

/**
 * Concatenate video segments and mix in a background music track.
 * Music is looped to cover the full video duration, faded in/out,
 * and mixed at a lower volume so voiceover/TikTok sounds can layer on top.
 */
function concatenateSegments(segmentPaths, outputPath, { crossfadeDuration = 0.3 } = {}) {
  if (segmentPaths.length === 0) throw new Error('No segments to concatenate');

  // Step 1: Concat video segments (no audio)
  let concatVideoPath;
  if (segmentPaths.length === 1) {
    concatVideoPath = segmentPaths[0];
  } else {
    concatVideoPath = path.join(TEMP_DIR, `concat-video-${Date.now()}.mp4`);
    const listPath = path.join(TEMP_DIR, `concat-${Date.now()}.txt`);
    const listContent = segmentPaths.map(p => `file '${p}'`).join('\n');
    fs.writeFileSync(listPath, listContent);

    const concatCmd = [
      'ffmpeg', '-y',
      '-f', 'concat', '-safe', '0',
      '-i', `"${listPath}"`,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
      '-an',
      '-movflags', '+faststart',
      `"${concatVideoPath}"`
    ].join(' ');

    execSync(concatCmd, { timeout: 180000, stdio: 'pipe' });
    try { fs.unlinkSync(listPath); } catch (_) {}
  }

  // Step 2: Mix in background music
  const musicTrack = pickMusicTrack();
  if (musicTrack) {
    try {
      // Get video duration
      const videoMeta = ffprobe(concatVideoPath);
      const videoDur = videoMeta.duration || 30;
      const fadeDur = Math.min(2, videoDur * 0.1); // 2s fade or 10% of video

      // Mix music: loop to cover video, fade in/out, volume at 35%
      const mixCmd = [
        'ffmpeg', '-y',
        '-i', `"${concatVideoPath}"`,
        '-stream_loop', '-1', '-i', `"${musicTrack}"`,
        '-filter_complex',
        `"[1:a]atrim=0:${videoDur.toFixed(1)},afade=t=in:st=0:d=${fadeDur.toFixed(1)},afade=t=out:st=${(videoDur - fadeDur).toFixed(1)}:d=${fadeDur.toFixed(1)},volume=0.85[music];[music]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[aout]"`,
        '-map', '0:v', '-map', '[aout]',
        '-c:v', 'copy',
        '-c:a', 'aac', '-b:a', '128k',
        '-shortest',
        '-movflags', '+faststart',
        `"${outputPath}"`
      ].join(' ');

      execSync(mixCmd, { timeout: 180000, stdio: 'pipe' });

      const trackName = path.basename(musicTrack, path.extname(musicTrack));
      console.log(`[TikTok] Mixed music: ${trackName} (vol 35%, ${fadeDur.toFixed(1)}s fade)`);

      // Cleanup intermediate concat file
      if (concatVideoPath !== segmentPaths[0]) {
        try { fs.unlinkSync(concatVideoPath); } catch (_) {}
      }
      return outputPath;
    } catch (err) {
      console.warn(`[TikTok] Music mixing failed, using video without music:`, err.message);
      // Fall through to copy without music
    }
  }

  // No music or mixing failed — just use the concat video
  if (concatVideoPath !== outputPath) {
    if (concatVideoPath === segmentPaths[0]) {
      fs.copyFileSync(concatVideoPath, outputPath);
    } else {
      fs.renameSync(concatVideoPath, outputPath);
    }
  }
  return outputPath;
}

// ============================================================================
// CLIP SELECTION
// ============================================================================

/**
 * Get the raw better-sqlite3 instance from the db module.
 * The server passes `require('./db')` which exposes `.db` as the raw instance.
 */
function getRawDb(db) {
  if (db && typeof db.prepare === 'function') return db;  // already raw
  if (db && db.db && typeof db.db.prepare === 'function') return db.db;  // db module wrapper
  throw new Error('Cannot get raw database instance');
}

/**
 * Find footage clips matching criteria from the database.
 */
function findClips(db, { category, subcategory, status, excludeIds = [], productGroup } = {}) {
  const rawDb = getRawDb(db);
  let sql = 'SELECT * FROM footage_library WHERE 1=1';
  const params = [];

  if (category) { sql += ' AND category = ?'; params.push(category); }
  if (subcategory) { sql += ' AND subcategory = ?'; params.push(subcategory); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (excludeIds.length) {
    sql += ` AND id NOT IN (${excludeIds.map(() => '?').join(',')})`;
    params.push(...excludeIds);
  }

  // If a product group is specified, filter to clips in that group
  if (productGroup) {
    if (productGroup.productId) {
      sql += ' AND product_id = ?';
      params.push(productGroup.productId);
    } else if (productGroup.noteKeywords) {
      // Match by keywords found in notes (for clips without product_id)
      for (const kw of productGroup.noteKeywords) {
        sql += ' AND LOWER(notes) LIKE ?';
        params.push(`%${kw.toLowerCase()}%`);
      }
    }
  }

  sql += ' ORDER BY RANDOM()';
  return rawDb.prepare(sql).all(...params);
}

/**
 * Group all clips by product — using product_id first, then matching notes.
 * Returns array of { productLabel, productId, noteKeywords, clips[] }
 */
function groupClipsByProduct(db) {
  const rawDb = getRawDb(db);
  const allClips = rawDb.prepare('SELECT * FROM footage_library ORDER BY created_at').all();
  const groups = new Map(); // key -> { productLabel, productId, noteKeywords, clips }

  for (const clip of allClips) {
    let key, label, productId = null, noteKeywords = null;

    if (clip.product_id) {
      // Clip has an explicit product link
      key = `pid:${clip.product_id}`;
      label = clip.product_name || clip.product_id;
      productId = clip.product_id;
    } else if (clip.notes) {
      // Try to extract a product description from notes
      // Look for patterns like "Product is the X" or common product keywords
      const notes = clip.notes.toLowerCase();
      const productMatch = notes.match(/product\s+is\s+(?:the\s+)?(.+?)(?:\.|$)/i);
      if (productMatch) {
        const productDesc = productMatch[1].trim();
        key = `notes:${productDesc}`;
        label = productMatch[1].trim();
        // Extract 2-3 word keywords for matching related clips
        noteKeywords = productDesc.split(/\s+/).filter(w => w.length > 2).slice(0, 4);
      } else {
        // Check if notes mention a known product from other clips
        let matched = false;
        for (const [gKey, group] of groups) {
          if (group.noteKeywords) {
            const matchCount = group.noteKeywords.filter(kw => notes.includes(kw)).length;
            if (matchCount >= 2 || (group.noteKeywords.length <= 2 && matchCount >= 1)) {
              group.clips.push(clip);
              matched = true;
              break;
            }
          }
        }
        if (matched) continue;
        // Unmatched clip with notes — use notes as a rough group
        key = `notes:${clip.notes.substring(0, 40)}`;
        label = clip.notes.substring(0, 60);
      }
    } else {
      // No product or notes — generic/untagged
      key = 'generic';
      label = 'Generic footage';
    }

    if (!groups.has(key)) {
      groups.set(key, { productLabel: label, productId, noteKeywords, clips: [] });
    }
    groups.get(key).clips.push(clip);
  }

  return Array.from(groups.values());
}

/**
 * Find a product group that has both process and reveal clips — ideal for a full reel.
 */
function findCompleteProductGroup(db) {
  const groups = groupClipsByProduct(db);
  // Prioritize groups with both process + reveal categories
  const complete = groups.filter(g => {
    const cats = new Set(g.clips.map(c => c.category));
    return cats.has('process') && cats.has('reveal');
  });
  // Sort by least used (spread content across products)
  complete.sort((a, b) => {
    const aUsed = a.clips.reduce((s, c) => s + (c.used_in_count || 0), 0);
    const bUsed = b.clips.reduce((s, c) => s + (c.used_in_count || 0), 0);
    return aUsed - bUsed;
  });
  return complete.length ? complete[0] : null;
}

/**
 * Pick the best start time for a clip segment.
 * For reveal clips, start near the end (where the reveal happens).
 * For process clips, start near the beginning for context.
 */
function pickStartTime(clipDuration, segmentDuration, role) {
  if (clipDuration <= segmentDuration) return 0;

  if (role === 'reveal' || role === 'cta') {
    // Reveal is usually at the end of the clip — start from last portion
    const revealStart = Math.max(0, clipDuration - segmentDuration - 5);
    return revealStart;
  }

  if (role === 'hook') {
    // Hook should be visually interesting — skip the very start
    return Math.min(2, clipDuration * 0.1);
  }

  // Process clips — start from early-middle
  const safeStart = Math.max(0, clipDuration * 0.05);
  const safeEnd = clipDuration - segmentDuration;
  if (safeEnd <= safeStart) return 0;
  return safeStart + Math.random() * Math.min(safeEnd - safeStart, 10);
}

// ============================================================================
// MAIN ASSEMBLY FUNCTIONS
// ============================================================================

/**
 * Assemble a TikTok video from a template.
 *
 * @param {Database} db - better-sqlite3 instance
 * @param {object} options
 * @param {string} options.template - template key from TEMPLATES
 * @param {object} [options.texts] - override text overlays { role: 'text' }
 * @param {object} [options.clipOverrides] - force specific clips { role: clipId }
 * @param {string} [options.outputName] - custom output filename
 * @returns {{ outputPath, duration, segments, template }}
 */
function assembleVideo(db, options = {}) {
  const rawDb = getRawDb(db);
  const templateKey = options.template || 'product-reveal';
  const template = TEMPLATES[templateKey];
  if (!template) throw new Error(`Unknown template: ${templateKey}. Available: ${Object.keys(TEMPLATES).join(', ')}`);

  const texts = { ...template.defaultTexts, ...(options.texts || {}) };
  const clipOverrides = options.clipOverrides || {};
  const usedClipIds = [];
  const segmentPaths = [];
  const segmentInfo = [];

  // --- Product-aware clip selection ---
  // First, find a product group that has complete coverage (process + reveal).
  // If a specific productId is requested, use that; otherwise auto-detect.
  let productGroup = null;
  let productLabel = '';

  if (options.productId) {
    const clips = rawDb.prepare('SELECT * FROM footage_library WHERE product_id = ?').all(options.productId);
    if (clips.length) {
      productGroup = { productId: options.productId, clips };
      productLabel = clips[0].product_name || options.productId;
    }
  }

  if (!productGroup) {
    // Auto-detect: find the best product group with both process + reveal
    productGroup = findCompleteProductGroup(db);
    if (productGroup) {
      productLabel = productGroup.productLabel;
      console.log(`[TikTok] Auto-selected product: "${productLabel}" (${productGroup.clips.length} clips)`);
    }
  }

  // If we found a product, inject its name into text overlays where empty
  if (productLabel) {
    if (!texts.reveal) texts.reveal = productLabel;
    // Capitalize first letter for display
    const displayName = productLabel.charAt(0).toUpperCase() + productLabel.slice(1);
    if (!texts.main) texts.main = displayName;
  }

  console.log(`[TikTok] Assembling "${template.name}" video${productLabel ? ` for "${productLabel}"` : ''}...`);

  for (const seg of template.segments) {
    // Find a clip for this segment
    let clip;
    if (clipOverrides[seg.role]) {
      clip = rawDb.prepare('SELECT * FROM footage_library WHERE id = ?').get(clipOverrides[seg.role]);
    }
    if (!clip && productGroup) {
      // First try: find a clip from this product matching the segment category
      const productClips = productGroup.clips.filter(c =>
        c.category === seg.category &&
        (!seg.subcategory || c.subcategory === seg.subcategory) &&
        !usedClipIds.includes(c.id)
      );
      // If no subcategory match, relax to just category
      clip = productClips[0] || productGroup.clips.find(c =>
        c.category === seg.category && !usedClipIds.includes(c.id)
      );
      // For CTA/ending segments: reuse the reveal clip (different time range)
      // rather than pulling in unrelated footage from another product
      if (!clip && (seg.role === 'cta' || seg.role === 'detail')) {
        clip = productGroup.clips.find(c => c.category === 'reveal');
      }
    }
    if (!clip) {
      // Fallback: find any clip matching category (generic footage)
      // But ONLY for non-CTA segments — for CTA, prefer reusing a product clip
      if (seg.role === 'cta' && productGroup) {
        // Reuse any product clip rather than pulling random footage
        clip = productGroup.clips[productGroup.clips.length - 1];
      } else {
        const candidates = findClips(db, {
          category: seg.category,
          subcategory: seg.subcategory,
          excludeIds: usedClipIds
        });
        clip = candidates[0];
      }
    }

    if (!clip) {
      console.warn(`[TikTok] No clip found for segment "${seg.role}" (${seg.category}/${seg.subcategory || '*'}), skipping`);
      continue;
    }

    const clipPath = path.join(FOOTAGE_DIR, clip.filename);
    if (!fs.existsSync(clipPath)) {
      console.warn(`[TikTok] File missing for clip ${clip.id}: ${clipPath}, skipping`);
      continue;
    }

    usedClipIds.push(clip.id);

    const segDuration = Math.min(seg.maxDuration, clip.duration_seconds || seg.maxDuration);
    const startTime = pickStartTime(clip.duration_seconds || 0, segDuration, seg.role);
    const segFile = path.join(TEMP_DIR, `seg-${seg.role}-${Date.now()}.mp4`);

    const textOverlay = texts[seg.role] || '';
    const textPosition = seg.role === 'hook' ? 'center' :
                         seg.role === 'cta' ? 'center' : 'bottom';

    try {
      prepareSegment(clipPath, segFile, {
        startTime,
        duration: segDuration,
        text: textOverlay,
        textPosition
      });
      segmentPaths.push(segFile);
      segmentInfo.push({
        role: seg.role,
        clipId: clip.id,
        clipName: clip.original_name,
        startTime: Math.round(startTime * 10) / 10,
        duration: segDuration,
        text: textOverlay
      });
      console.log(`[TikTok]   ${seg.role}: ${clip.original_name} (${segDuration}s from ${startTime.toFixed(1)}s)${textOverlay ? ` — "${textOverlay}"` : ''}`);
    } catch (err) {
      console.error(`[TikTok] Failed to prepare segment "${seg.role}":`, err.message);
    }
  }

  if (segmentPaths.length === 0) {
    throw new Error('No segments could be prepared — check footage library has clips matching template categories');
  }

  // Concatenate all segments
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outputName = options.outputName || `tiktok-${templateKey}-${timestamp}.mp4`;
  const outputPath = path.join(OUTPUT_DIR, outputName);

  console.log(`[TikTok] Concatenating ${segmentPaths.length} segments...`);
  concatenateSegments(segmentPaths, outputPath);

  // Get final duration
  const finalMeta = ffprobe(outputPath);

  // Clean up temp segments
  for (const p of segmentPaths) {
    try { fs.unlinkSync(p); } catch (_) {}
  }

  // Mark used clips
  for (const id of usedClipIds) {
    try {
      rawDb.prepare('UPDATE footage_library SET used_in_count = COALESCE(used_in_count, 0) + 1, status = CASE WHEN status = ? THEN ? ELSE status END WHERE id = ?')
        .run('raw', 'used', id);
    } catch (_) {}
  }

  const result = {
    outputPath,
    outputUrl: `/api/tiktok-videos/${outputName}`,
    duration: Math.round(finalMeta.duration * 10) / 10,
    width: WIDTH,
    height: HEIGHT,
    segments: segmentInfo,
    template: templateKey,
    templateName: template.name,
    product: productLabel || null,
    productId: productGroup?.productId || null,
    createdAt: new Date().toISOString()
  };

  console.log(`[TikTok] Done! ${outputName} — ${result.duration}s, ${segmentPaths.length} segments`);
  return result;
}

/**
 * Assemble from explicit clip list (no template).
 * Each entry: { clipId, startTime, duration, text, textPosition }
 */
function assembleFromClips(db, clips, options = {}) {
  const rawDb = getRawDb(db);
  const segmentPaths = [];
  const segmentInfo = [];

  console.log(`[TikTok] Assembling custom video from ${clips.length} clips...`);

  for (let i = 0; i < clips.length; i++) {
    const entry = clips[i];
    const clip = rawDb.prepare('SELECT * FROM footage_library WHERE id = ?').get(entry.clipId);
    if (!clip) { console.warn(`[TikTok] Clip ${entry.clipId} not found, skipping`); continue; }

    const clipPath = path.join(FOOTAGE_DIR, clip.filename);
    if (!fs.existsSync(clipPath)) { console.warn(`[TikTok] File missing: ${clipPath}`); continue; }

    const segFile = path.join(TEMP_DIR, `custom-${i}-${Date.now()}.mp4`);
    const duration = Math.min(entry.duration || 10, clip.duration_seconds || 10);
    const startTime = entry.startTime || 0;

    try {
      prepareSegment(clipPath, segFile, {
        startTime,
        duration,
        text: entry.text || '',
        textPosition: entry.textPosition || 'bottom'
      });
      segmentPaths.push(segFile);
      segmentInfo.push({
        clipId: clip.id, clipName: clip.original_name,
        startTime, duration, text: entry.text || ''
      });
    } catch (err) {
      console.error(`[TikTok] Segment ${i} failed:`, err.message);
    }
  }

  if (!segmentPaths.length) throw new Error('No segments prepared');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outputName = options.outputName || `tiktok-custom-${timestamp}.mp4`;
  const outputPath = path.join(OUTPUT_DIR, outputName);

  concatenateSegments(segmentPaths, outputPath);
  const finalMeta = ffprobe(outputPath);

  for (const p of segmentPaths) { try { fs.unlinkSync(p); } catch (_) {} }

  return {
    outputPath, outputUrl: `/api/tiktok-videos/${outputName}`,
    duration: Math.round(finalMeta.duration * 10) / 10,
    width: WIDTH, height: HEIGHT,
    segments: segmentInfo, template: 'custom',
    createdAt: new Date().toISOString()
  };
}

/**
 * List all generated TikTok videos.
 */
function listVideos() {
  if (!fs.existsSync(OUTPUT_DIR)) return [];
  return fs.readdirSync(OUTPUT_DIR)
    .filter(f => f.endsWith('.mp4') && f.startsWith('tiktok-'))
    .map(f => {
      const filePath = path.join(OUTPUT_DIR, f);
      const stat = fs.statSync(filePath);
      const meta = ffprobe(filePath);
      return {
        filename: f,
        url: `/api/tiktok-videos/${f}`,
        size: stat.size,
        duration: Math.round(meta.duration * 10) / 10,
        createdAt: stat.mtime.toISOString()
      };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

/**
 * Delete a generated video.
 */
function deleteVideo(filename) {
  const filePath = path.join(OUTPUT_DIR, filename);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}

// ============================================================================
// API ROUTE HANDLER
// ============================================================================

async function handleTikTokVideoRoute(pathname, req, res, db) {
  const basePath = '/api/tiktok-videos';
  if (!pathname.startsWith(basePath)) return false;
  const route = pathname.slice(basePath.length) || '/';

  const sendJson = (data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(data));
  };
  const sendError = (msg, status = 400) => sendJson({ error: msg }, status);

  // CORS
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key'
    });
    res.end();
    return true;
  }

  // GET /api/tiktok-videos/templates — list available templates
  if (route === '/templates' && req.method === 'GET') {
    const templateList = Object.entries(TEMPLATES).map(([key, t]) => ({
      key, name: t.name, description: t.description,
      segmentCount: t.segments.length,
      roles: t.segments.map(s => s.role),
      defaultTexts: t.defaultTexts
    }));
    return sendJson(templateList);
  }

  // GET /api/tiktok-videos — list generated videos
  if (route === '/' && req.method === 'GET') {
    return sendJson(listVideos());
  }

  // POST /api/tiktok-videos/assemble — assemble a video from template
  if (route === '/assemble' && req.method === 'POST') {
    try {
      const body = await parseBodyJson(req);
      const result = assembleVideo(db, {
        template: body.template || 'product-reveal',
        texts: body.texts || {},
        clipOverrides: body.clipOverrides || {},
        outputName: body.outputName
      });
      return sendJson(result, 201);
    } catch (err) {
      console.error('[TikTok] Assembly error:', err);
      return sendError(err.message, 500);
    }
  }

  // POST /api/tiktok-videos/assemble-custom — assemble from explicit clip list
  if (route === '/assemble-custom' && req.method === 'POST') {
    try {
      const body = await parseBodyJson(req);
      if (!Array.isArray(body.clips) || !body.clips.length) {
        return sendError('clips array required');
      }
      const result = assembleFromClips(db, body.clips, { outputName: body.outputName });
      return sendJson(result, 201);
    } catch (err) {
      console.error('[TikTok] Custom assembly error:', err);
      return sendError(err.message, 500);
    }
  }

  // GET /api/tiktok-videos/:filename — serve a generated video
  const fileMatch = route.match(/^\/([^/]+\.mp4)$/);
  if (fileMatch && req.method === 'GET') {
    const filePath = path.join(OUTPUT_DIR, fileMatch[1]);
    if (!fs.existsSync(filePath)) return sendError('Video not found', 404);

    const stat = fs.statSync(filePath);
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': 'video/mp4',
        'Access-Control-Allow-Origin': '*'
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': stat.size,
        'Access-Control-Allow-Origin': '*'
      });
      fs.createReadStream(filePath).pipe(res);
    }
    return true;
  }

  // DELETE /api/tiktok-videos/:filename
  const delMatch = route.match(/^\/([^/]+\.mp4)$/);
  if (delMatch && req.method === 'DELETE') {
    const ok = deleteVideo(delMatch[1]);
    return sendJson({ ok });
  }

  return false;
}

function parseBodyJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

module.exports = {
  TEMPLATES,
  assembleVideo,
  assembleFromClips,
  groupClipsByProduct,
  findCompleteProductGroup,
  listVideos,
  deleteVideo,
  handleTikTokVideoRoute
};
