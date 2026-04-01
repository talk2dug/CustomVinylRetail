/**
 * TikTok AI Creative Director
 *
 * Uses Gemini 2.5 Flash to analyze footage library clips and generate
 * complete Remotion props for TikTok video assembly.
 *
 * Pipeline:
 *   1. Gather analyzed clips from footage_library
 *   2. Smart-select 3-6 clips based on content type & quality
 *   3. Generate creative brief via Gemini (text-only, no images)
 *   4. Validate output matches TikTokPropsSchema
 *   5. Store brief in tiktok_briefs table
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENV_PATH = path.resolve(__dirname, '..', '..', '.env');
if (fs.existsSync(ENV_PATH)) {
  require('dotenv').config({ path: ENV_PATH });
}

function cleanKey(k) { return (k || '').replace(/['"]/g, '').trim(); }

const GEMINI_API_KEY = cleanKey(process.env.GEMINI_API_KEY || '');
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=`;

const MUSIC_DIR = '/mnt/websit/tiktok-music';

const CONTENT_TYPES = [
  'satisfying-process',
  'before-after',
  'product-showcase',
  'packing-video',
  'behind-the-scenes'
];

// ============================================================================
// DB helpers
// ============================================================================

function getRawDb(db) {
  return db.db || db;
}

function saveBrief(db, brief) {
  const rawDb = getRawDb(db);
  const id = crypto.randomUUID();
  rawDb.prepare(`INSERT INTO tiktok_briefs (id, content_type, props, rationale, clip_ids, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    id, brief.contentType, JSON.stringify(brief.props), brief.rationale,
    JSON.stringify(brief.selectedClips.map(c => c.id)), new Date().toISOString()
  );
  return id;
}

function getRecentBriefs(db, limit = 5) {
  const rawDb = getRawDb(db);
  return rawDb.prepare('SELECT * FROM tiktok_briefs ORDER BY created_at DESC LIMIT ?').all(limit);
}

// ============================================================================
// Content type rotation
// ============================================================================

function pickContentType(db) {
  const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / 86400000);
  const baseIndex = dayOfYear % CONTENT_TYPES.length;

  // Check recent briefs to avoid repeating last 2
  let recentTypes = [];
  try {
    const recent = getRecentBriefs(db, 2);
    recentTypes = recent.map(b => b.content_type);
  } catch (_) { /* table may not exist yet */ }

  // Try base index first, then rotate forward until we find one not recently used
  for (let offset = 0; offset < CONTENT_TYPES.length; offset++) {
    const candidate = CONTENT_TYPES[(baseIndex + offset) % CONTENT_TYPES.length];
    if (!recentTypes.includes(candidate)) return candidate;
  }

  // Fallback: just use the base
  return CONTENT_TYPES[baseIndex];
}

// ============================================================================
// Clip selection
// ============================================================================

function selectFootageForBrief(db, clips, contentType) {
  // Filter to quality > 0.6
  const qualityClips = clips.filter(clip => {
    try {
      const analysis = typeof clip.ai_analysis === 'string' ? JSON.parse(clip.ai_analysis) : clip.ai_analysis;
      return (analysis.overall_quality || 0) > 0.6;
    } catch (_) {
      return false;
    }
  });

  if (qualityClips.length < 3) {
    // Relax quality filter if not enough clips
    if (clips.length >= 3) {
      return selectByContentType(clips, contentType);
    }
    throw new Error('Not enough analyzed footage');
  }

  return selectByContentType(qualityClips, contentType);
}

function selectByContentType(clips, contentType) {
  // Sort by used_in_count ascending (prefer less-used clips)
  const sorted = [...clips].sort((a, b) => (a.used_in_count || 0) - (b.used_in_count || 0));

  // Parse analyses
  const withAnalysis = sorted.map(clip => {
    try {
      const analysis = typeof clip.ai_analysis === 'string' ? JSON.parse(clip.ai_analysis) : clip.ai_analysis;
      return { ...clip, parsedAnalysis: analysis };
    } catch (_) {
      return { ...clip, parsedAnalysis: {} };
    }
  });

  let selected = [];

  switch (contentType) {
    case 'satisfying-process':
    case 'behind-the-scenes': {
      // Need hook + process + reveal clips
      const hookClips = withAnalysis.filter(c =>
        c.parsedAnalysis.hook_potential > 0.6 ||
        (c.parsedAnalysis.content_type || '').includes('hook')
      );
      const processClips = withAnalysis.filter(c =>
        (c.parsedAnalysis.content_type || '').includes('process') ||
        (c.parsedAnalysis.summary || '').toLowerCase().includes('process') ||
        (c.parsedAnalysis.summary || '').toLowerCase().includes('making')
      );
      const revealClips = withAnalysis.filter(c =>
        (c.parsedAnalysis.content_type || '').includes('reveal') ||
        (c.parsedAnalysis.summary || '').toLowerCase().includes('reveal') ||
        (c.parsedAnalysis.summary || '').toLowerCase().includes('finished')
      );

      // Pick best from each category
      if (hookClips.length) selected.push(hookClips[0]);
      // Add 1-3 process clips
      const procToAdd = processClips.filter(c => !selected.find(s => s.id === c.id)).slice(0, 3);
      selected.push(...procToAdd);
      // Add reveal
      const revToAdd = revealClips.filter(c => !selected.find(s => s.id === c.id)).slice(0, 1);
      selected.push(...revToAdd);
      break;
    }

    case 'product-showcase': {
      // Need multiple product/close-up clips
      const productClips = withAnalysis.filter(c =>
        (c.parsedAnalysis.content_type || '').includes('product') ||
        (c.parsedAnalysis.content_type || '').includes('showcase') ||
        (c.parsedAnalysis.content_type || '').includes('close-up') ||
        (c.parsedAnalysis.summary || '').toLowerCase().includes('product')
      );
      selected = productClips.slice(0, 5);
      break;
    }

    case 'packing-video': {
      const packingClips = withAnalysis.filter(c =>
        (c.parsedAnalysis.content_type || '').includes('packing') ||
        (c.parsedAnalysis.summary || '').toLowerCase().includes('pack') ||
        (c.parsedAnalysis.summary || '').toLowerCase().includes('box')
      );
      selected = packingClips.slice(0, 5);
      break;
    }

    case 'before-after': {
      const beforeClips = withAnalysis.filter(c =>
        (c.parsedAnalysis.content_type || '').includes('before') ||
        (c.parsedAnalysis.content_type || '').includes('process')
      );
      const afterClips = withAnalysis.filter(c =>
        (c.parsedAnalysis.content_type || '').includes('after') ||
        (c.parsedAnalysis.content_type || '').includes('reveal')
      );
      if (beforeClips.length) selected.push(beforeClips[0]);
      if (afterClips.length) selected.push(...afterClips.slice(0, 2));
      break;
    }

    default:
      break;
  }

  // If we don't have enough from content-type filtering, fill with best available
  if (selected.length < 3) {
    const remaining = withAnalysis.filter(c => !selected.find(s => s.id === c.id));
    const needed = 3 - selected.length;
    selected.push(...remaining.slice(0, needed));
  }

  // Cap at 6
  return selected.slice(0, 6);
}

// ============================================================================
// Transition selection
// ============================================================================

function selectTransitions(scenes) {
  if (!scenes || scenes.length <= 1) return [];

  const transitions = [];
  for (let i = 0; i < scenes.length - 1; i++) {
    const current = scenes[i];
    const next = scenes[i + 1];

    let transition;

    if (current.role === 'hook') {
      // After hook → hard cut (energy)
      transition = { type: 'cut', durationFrames: 0 };
    } else if (next.role === 'reveal') {
      // Before reveal → fade (drama)
      transition = { type: 'fade', durationFrames: 15 };
    } else if (next.role === 'cta') {
      // Before CTA → cut
      transition = { type: 'cut', durationFrames: 0 };
    } else if (
      current.role === 'process' ||
      (current.role && current.role.includes('process'))
    ) {
      // Between process shots → slide or wipe
      const pick = i % 2 === 0 ? 'slide' : 'wipe';
      transition = { type: pick, durationFrames: 10 };
    } else {
      // Default: cut
      transition = { type: 'cut', durationFrames: 0 };
    }

    transitions.push(transition);
  }

  return transitions;
}

// ============================================================================
// Music track selection
// ============================================================================

function getRandomMusicTrack() {
  try {
    if (!fs.existsSync(MUSIC_DIR)) return null;
    const files = fs.readdirSync(MUSIC_DIR).filter(f =>
      /\.(mp3|wav|m4a|aac|ogg)$/i.test(f)
    );
    if (files.length === 0) return null;
    const pick = files[Math.floor(Math.random() * files.length)];
    return path.join(MUSIC_DIR, pick);
  } catch (_) {
    return null;
  }
}

// ============================================================================
// Gemini API call
// ============================================================================

function buildGeminiPrompt(selectedClips, contentType) {
  const clipAnalyses = selectedClips.map((clip, i) => {
    const a = clip.parsedAnalysis || {};
    return `Clip ${i + 1} (filename: ${clip.filename || clip.id}):
  - Summary: ${a.summary || 'N/A'}
  - Scenes: ${JSON.stringify(a.scenes || [])}
  - Quality: ${a.overall_quality || 'N/A'}
  - Content Type: ${a.content_type || 'N/A'}
  - Hook Potential: ${a.hook_potential || 'N/A'}
  - Duration: ${clip.duration || 'unknown'}s`;
  }).join('\n\n');

  return `You are an AI Creative Director for TikTok. Given analyzed footage clips, create a complete video assembly plan.

RULES:
- Hook in first 1-3 seconds: Use the clip/moment with highest hook_potential
- Pattern interrupt every 3-5 seconds: speed change, angle switch, text pop
- Total video: 15-30 seconds for best completion rate
- Text overlays: MAX 6 words each, bold and readable
- CTA only in last 2 seconds
- Prefer clips with quality_score > 0.7
- Match the content type: ${contentType}
- Brand: Blue Ridge Custom Co, Asheville NC — locally handmade

AVAILABLE CLIPS:
${clipAnalyses}

OUTPUT FORMAT (JSON only, no extra text):
{
  "rationale": "Brief explanation of creative choices",
  "scenes": [
    { "clipFilename": "uuid.mp4", "trimStart": 0, "trimEnd": 3, "playbackRate": 1, "role": "hook" }
  ],
  "transitions": [
    { "type": "cut", "durationFrames": 0 }
  ],
  "textOverlays": [
    { "text": "Watch this...", "startFrame": 0, "durationFrames": 60, "position": "center", "animation": "pop", "style": { "fontSize": 64, "color": "#FFFFFF" } }
  ],
  "musicTrack": null,
  "musicVolume": 0.35,
  "brandWatermark": true
}`;
}

async function callGemini(prompt) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');

  const url = GEMINI_URL + GEMINI_API_KEY;
  console.log(`[CreativeDirector] Calling Gemini (prompt: ${prompt.length} chars)`);

  const body = {
    contents: [{
      parts: [{ text: prompt }]
    }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 4096,
      thinkingConfig: { thinkingBudget: 0 }
    }
  };

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000)
    });
  } catch (fetchErr) {
    console.error(`[CreativeDirector] Gemini fetch error: ${fetchErr.message}`);
    throw fetchErr;
  }

  console.log(`[CreativeDirector] Gemini response status: ${resp.status}`);

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    console.error(`[CreativeDirector] Gemini API error: ${resp.status} ${errText.substring(0, 300)}`);
    throw new Error(`Gemini API ${resp.status}: ${errText.substring(0, 200)}`);
  }

  const data = await resp.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  console.log(`[CreativeDirector] Gemini parts count: ${parts.length}, types: ${parts.map(p => p.thought ? 'thought' : 'text').join(',')}`);

  // Filter out thought parts, find text parts
  let text = parts.filter(p => p.text && !p.thought).map(p => p.text).join('\n');
  if (!text) text = parts.map(p => p.text || '').join('\n');
  if (!text) {
    console.error('[CreativeDirector] No text in Gemini response:', JSON.stringify(data).substring(0, 300));
    throw new Error('No text in Gemini response');
  }

  console.log(`[CreativeDirector] Gemini raw response (${text.length} chars): ${text.substring(0, 300)}`);

  // Strip code fences
  let jsonStr = text.trim();
  if (jsonStr.includes('```')) {
    const match = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (match) jsonStr = match[1].trim();
  }
  if (!jsonStr.startsWith('{')) {
    const braceMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (braceMatch) jsonStr = braceMatch[0];
  }

  return JSON.parse(jsonStr);
}

// ============================================================================
// Validation
// ============================================================================

function validateProps(props) {
  if (!props || typeof props !== 'object') {
    throw new Error('Props must be an object');
  }

  // Scenes validation
  if (!Array.isArray(props.scenes) || props.scenes.length === 0) {
    throw new Error('Props must have at least one scene');
  }
  for (const scene of props.scenes) {
    if (!scene.clipFilename) throw new Error('Each scene must have clipFilename');
    if (typeof scene.trimStart !== 'number') scene.trimStart = 0;
    if (typeof scene.trimEnd !== 'number') scene.trimEnd = 5;
    if (typeof scene.playbackRate !== 'number') scene.playbackRate = 1;
    if (!scene.role) scene.role = 'main';
  }

  // Transitions — provide defaults if missing
  if (!Array.isArray(props.transitions)) {
    props.transitions = selectTransitions(props.scenes);
  }

  // Text overlays defaults
  if (!Array.isArray(props.textOverlays)) {
    props.textOverlays = [];
  }
  for (const overlay of props.textOverlays) {
    if (!overlay.text) continue;
    if (typeof overlay.startFrame !== 'number') overlay.startFrame = 0;
    if (typeof overlay.durationFrames !== 'number') overlay.durationFrames = 60;
    if (!overlay.position) overlay.position = 'center';
    if (!overlay.animation) overlay.animation = 'pop';
    if (!overlay.style) overlay.style = { fontSize: 64, color: '#FFFFFF' };
  }

  // Defaults for music and watermark
  if (typeof props.musicVolume !== 'number') props.musicVolume = 0.35;
  if (typeof props.brandWatermark !== 'boolean') props.brandWatermark = true;

  return props;
}

// ============================================================================
// Main entry point
// ============================================================================

async function generateCreativeBrief(db, options = {}) {
  const rawDb = getRawDb(db);

  // 1. Gather analyzed clips
  let clips;
  try {
    clips = rawDb.prepare(
      `SELECT * FROM footage_library
       WHERE analyzed_at IS NOT NULL AND ai_analysis IS NOT NULL
       ORDER BY used_in_count ASC, created_at DESC`
    ).all();
  } catch (err) {
    console.error('[CreativeDirector] DB query error:', err.message);
    throw new Error('Failed to query footage library: ' + err.message);
  }

  // 2. Determine content type
  let contentType = options.contentType;
  if (contentType && !CONTENT_TYPES.includes(contentType)) {
    console.warn(`[CreativeDirector] Unknown content type "${contentType}", falling back to rotation`);
    contentType = null;
  }
  if (!contentType) {
    contentType = pickContentType(db);
  }
  console.log(`[CreativeDirector] Content type: ${contentType}`);

  // Filter by content type if specified in options
  if (options.contentType) {
    const filtered = clips.filter(clip => {
      try {
        const analysis = typeof clip.ai_analysis === 'string' ? JSON.parse(clip.ai_analysis) : clip.ai_analysis;
        return (analysis.content_type || '').includes(options.contentType);
      } catch (_) { return false; }
    });
    // Only use filtered if we have enough; otherwise fall back to all clips
    if (filtered.length >= 3) {
      clips = filtered;
    }
  }

  // 3. Check minimum clip count
  if (clips.length < 3) {
    throw new Error('Not enough analyzed footage');
  }

  // 4. Select clips
  const selectedClips = selectFootageForBrief(db, clips, contentType);
  console.log(`[CreativeDirector] Selected ${selectedClips.length} clips: ${selectedClips.map(c => c.filename || c.id).join(', ')}`);

  // 5. Build prompt and call Gemini
  const prompt = buildGeminiPrompt(selectedClips, contentType);
  let geminiResult = await callGemini(prompt);

  // 6. Extract and validate props
  const rationale = geminiResult.rationale || 'AI-generated creative brief';
  delete geminiResult.rationale;
  const props = validateProps(geminiResult);

  // Check for music tracks
  if (!props.musicTrack) {
    const track = getRandomMusicTrack();
    if (track) {
      props.musicTrack = track;
    }
  }

  // 7. Store brief in DB
  const brief = {
    contentType,
    props,
    rationale,
    selectedClips
  };

  let id;
  try {
    id = saveBrief(db, brief);
  } catch (err) {
    console.error('[CreativeDirector] Failed to save brief:', err.message);
    // Non-fatal — still return the brief
    id = crypto.randomUUID();
  }

  // 8. Increment used_in_count for selected clips
  try {
    const updateStmt = rawDb.prepare('UPDATE footage_library SET used_in_count = COALESCE(used_in_count, 0) + 1 WHERE id = ?');
    for (const clip of selectedClips) {
      updateStmt.run(clip.id);
    }
  } catch (err) {
    console.warn('[CreativeDirector] Failed to update used_in_count:', err.message);
  }

  console.log(`[CreativeDirector] Brief generated: ${id} (${contentType}, ${selectedClips.length} clips)`);

  return {
    id,
    props,
    rationale,
    contentType,
    selectedClips: selectedClips.map(c => ({
      id: c.id,
      filename: c.filename,
      duration: c.duration,
      content_type: c.parsedAnalysis?.content_type
    }))
  };
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  generateCreativeBrief,
  selectFootageForBrief,
  selectTransitions,
  CONTENT_TYPES,
  getRecentBriefs
};
