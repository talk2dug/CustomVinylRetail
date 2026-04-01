'use strict';

/**
 * Footage Analyzer
 * AI-powered video footage analysis using Gemini 2.5 Flash Vision API.
 * Extracts keyframes from video clips via FFmpeg, sends them to Gemini
 * for structured analysis useful for TikTok content creation.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ENV_PATH = path.resolve(__dirname, '..', '..', '.env');
if (fs.existsSync(ENV_PATH)) {
  require('dotenv').config({ path: ENV_PATH });
}

// Gemini setup (same pattern as human-model-analyzer.js)
function cleanKey(k) {
  if (!k) return '';
  let trimmed = String(k).trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    trimmed = trimmed.slice(1, -1);
  }
  return trimmed;
}

const GEMINI_API_KEY = cleanKey(process.env.GEMINI_API_KEY || '');
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=`;

const ANALYSIS_PROMPT = `You are analyzing raw video footage for TikTok content creation. Each keyframe is labeled with its timestamp in the video (e.g. "Frame at 12.5s"). Use these timestamps to identify WHEN things happen.

Return JSON with this exact structure:
{
  "summary": "Brief description of what's happening in the footage",
  "content_type": "process|reveal|packing|lifestyle|product-closeup|b-roll|tutorial|unboxing",
  "scenes": [
    {
      "frame_index": 0,
      "timestamp_seconds": 0,
      "description": "What's shown in this frame",
      "subjects": ["person", "product", "tool"],
      "action": "pressing vinyl onto shirt",
      "visible_product": "description of the specific print/design visible, or null if none",
      "quality_score": 0.8,
      "lighting": "good|fair|poor",
      "focus": "sharp|soft|blurry",
      "framing": "good|tight|wide|awkward",
      "hook_potential": 0.7,
      "role_suggestion": "hook|process|reveal|cta|b-roll|transition"
    }
  ],
  "product_segments": [
    {
      "product_description": "Mushroom print on metal blank",
      "start_seconds": 10,
      "end_seconds": 45,
      "phases": {
        "setup_start": 10,
        "setup_end": 15,
        "process_start": 15,
        "process_end": 35,
        "reveal_start": 35,
        "reveal_end": 45
      }
    }
  ],
  "best_moments": {
    "hook": { "frame_index": 0, "timestamp_seconds": 0, "reason": "Dramatic close-up" },
    "reveal": { "frame_index": 4, "timestamp_seconds": 30, "reason": "Finished product shown clearly" },
    "cta": { "frame_index": 5, "timestamp_seconds": 40, "reason": "Product displayed" }
  },
  "overall_quality": 0.75,
  "usable_for_tiktok": true,
  "tags": ["vinyl", "heat-press", "custom", "satisfying"]
}

IMPORTANT: The "product_segments" array should identify each distinct print/product being worked on in the video, with timestamps for each phase (setup, process/pressing, reveal/peel). This is critical for editing — we need to know exactly when each product appears and what happens to it.`;

/**
 * Parse Gemini response text into structured analysis JSON.
 * Strips markdown code fences if present and validates required fields.
 */
function parseAnalysisResponse(text) {
  let jsonStr = text.trim();

  // Strip markdown code fences
  if (jsonStr.includes('```')) {
    const match = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (match) jsonStr = match[1].trim();
  }

  // Find JSON object if there's extra text
  if (!jsonStr.startsWith('{')) {
    const braceMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (braceMatch) jsonStr = braceMatch[0];
  }

  const analysis = JSON.parse(jsonStr);

  // Validate required fields
  if (!analysis.summary) throw new Error('Missing required field: summary');
  if (!analysis.content_type) throw new Error('Missing required field: content_type');
  if (!Array.isArray(analysis.scenes)) throw new Error('Missing required field: scenes');
  if (typeof analysis.overall_quality !== 'number') throw new Error('Missing required field: overall_quality');
  if (typeof analysis.usable_for_tiktok !== 'boolean') throw new Error('Missing required field: usable_for_tiktok');

  return analysis;
}

/**
 * Extract keyframes from a video clip using FFmpeg scene detection.
 * Falls back to evenly-spaced frames if scene detection yields fewer than `count` frames.
 *
 * @param {string} clipPath - Absolute path to the video file
 * @param {number} count - Target number of keyframes (default 6)
 * @returns {{ frames: string[], tmpDir: string, cleanup: Function }}
 */
function extractKeyframes(clipPath, count = 15) {
  if (!fs.existsSync(clipPath)) {
    throw new Error(`Clip not found: ${clipPath}`);
  }

  const tmpDir = path.join(os.tmpdir(), 'footage-analyzer-' + crypto.randomUUID());
  fs.mkdirSync(tmpDir, { recursive: true });

  // Get video duration
  let duration;
  try {
    const durationOutput = execSync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${clipPath}"`,
      { encoding: 'utf8', timeout: 15000 }
    ).trim();
    duration = parseFloat(durationOutput);
    console.log(`[FootageAnalyzer] Clip duration: ${duration}s`);
  } catch (err) {
    console.error(`[FootageAnalyzer] Failed to get duration: ${err.message}`);
    // Clean up and throw
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(`Cannot read video file: ${err.message}`);
  }

  // Try scene detection first
  try {
    execSync(
      `ffmpeg -i "${clipPath}" -vf "select='gt(scene,0.3)',showinfo" -vsync vfn -frame_pts true -f image2 "${tmpDir}/frame_%03d.jpg" 2>&1`,
      { encoding: 'utf8', timeout: 60000 }
    );
  } catch (err) {
    // ffmpeg returns non-zero sometimes even on success; check if frames were written
    console.log(`[FootageAnalyzer] Scene detection command exited (may still have frames)`);
  }

  let frames = fs.readdirSync(tmpDir)
    .filter(f => f.endsWith('.jpg'))
    .sort()
    .map(f => path.join(tmpDir, f));

  console.log(`[FootageAnalyzer] Scene detection found ${frames.length} keyframes`);

  // Fallback to evenly-spaced if fewer than count frames
  if (frames.length < count && duration > 0) {
    console.log(`[FootageAnalyzer] Falling back to evenly-spaced frames (target: ${count})`);

    // Clean existing frames
    for (const f of frames) {
      try { fs.unlinkSync(f); } catch (_) {}
    }

    const interval = Math.max(duration / count, 0.5);
    try {
      execSync(
        `ffmpeg -i "${clipPath}" -vf "fps=1/${interval}" -f image2 "${tmpDir}/frame_%03d.jpg" 2>&1`,
        { encoding: 'utf8', timeout: 60000 }
      );
    } catch (err) {
      console.log(`[FootageAnalyzer] Evenly-spaced extraction exited (may still have frames)`);
    }

    frames = fs.readdirSync(tmpDir)
      .filter(f => f.endsWith('.jpg'))
      .sort()
      .map(f => path.join(tmpDir, f));

    console.log(`[FootageAnalyzer] Evenly-spaced extraction found ${frames.length} frames`);
  }

  if (frames.length === 0) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw new Error('No keyframes could be extracted from clip');
  }

  // Limit to requested count
  if (frames.length > count) {
    // Remove excess frames, keep evenly distributed subset
    const step = frames.length / count;
    const kept = [];
    for (let i = 0; i < count; i++) {
      kept.push(frames[Math.min(Math.floor(i * step), frames.length - 1)]);
    }
    // Delete frames we're not keeping
    for (const f of frames) {
      if (!kept.includes(f)) {
        try { fs.unlinkSync(f); } catch (_) {}
      }
    }
    frames = kept;
  }

  // Calculate timestamp for each frame based on its position
  const frameTimestamps = frames.map((f, i) => {
    // For evenly-spaced frames, timestamp = index * interval
    const interval = duration / frames.length;
    return Math.round(i * interval * 10) / 10;
  });

  const cleanup = () => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  };

  return { frames, frameTimestamps, duration, tmpDir, cleanup };
}

/**
 * Analyze a single clip: extract keyframes, send to Gemini, store results.
 *
 * @param {Object} db - Database module (with db.db as raw better-sqlite3 instance)
 * @param {string|number} clipId - ID of the clip in footage_library
 * @returns {Object} The analysis object from Gemini
 */
async function analyzeClip(db, clipId) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');

  // Get clip from DB
  const rawDb = db.db || db;
  const clip = rawDb.prepare('SELECT * FROM footage_library WHERE id = ?').get(clipId);
  if (!clip) throw new Error(`Clip not found in DB: ${clipId}`);

  const clipPath = clip.file_path;
  if (!fs.existsSync(clipPath)) {
    throw new Error(`Clip file not found on disk: ${clipPath}`);
  }

  console.log(`[FootageAnalyzer] Analyzing clip ${clipId}: ${clipPath}`);

  // Extract keyframes
  const { frames, frameTimestamps, duration: clipDuration, cleanup } = extractKeyframes(clipPath);

  try {
    // Read frames as base64, interleave with timestamp labels
    const contentParts = [];
    for (let i = 0; i < frames.length; i++) {
      const data = fs.readFileSync(frames[i]).toString('base64');
      contentParts.push({ text: `Frame ${i} at ${frameTimestamps[i]}s:` });
      contentParts.push({ inlineData: { mimeType: 'image/jpeg', data } });
    }

    const totalKB = contentParts.filter(p => p.inlineData).reduce((sum, p) => sum + p.inlineData.data.length, 0) / 1024 | 0;
    console.log(`[FootageAnalyzer] Sending ${frames.length} frames to Gemini (${totalKB}KB total, clip duration: ${clipDuration}s)`);

    // Build Gemini request with all frames + prompt
    const parts = [
      ...contentParts,
      { text: ANALYSIS_PROMPT + `\n\nThis clip is ${clipDuration} seconds long. Analyze these ${frames.length} keyframes. Each frame is labeled with its timestamp. Use the timestamps to identify when each product/print appears and what phase it's in (setup, pressing, reveal).` }
    ];

    const url = GEMINI_URL + GEMINI_API_KEY;
    const body = {
      contents: [{ parts }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 8192,
        thinkingConfig: { thinkingBudget: 0 }
      }
    };

    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000)
      });
    } catch (fetchErr) {
      console.error(`[FootageAnalyzer] Gemini fetch error: ${fetchErr.message}`);
      throw fetchErr;
    }

    console.log(`[FootageAnalyzer] Gemini response status: ${resp.status}`);

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.error(`[FootageAnalyzer] Gemini API error: ${resp.status} ${errText.substring(0, 300)}`);
      throw new Error(`Gemini API ${resp.status}: ${errText.substring(0, 200)}`);
    }

    const data = await resp.json();

    // Handle thinking parts vs text parts (same as human-model-analyzer.js)
    const responseParts = data.candidates?.[0]?.content?.parts || [];
    console.log(`[FootageAnalyzer] Gemini parts count: ${responseParts.length}, types: ${responseParts.map(p => p.thought ? 'thought' : 'text').join(',')}`);

    // Concatenate all text parts (skip thought parts)
    let text = responseParts.filter(p => p.text && !p.thought).map(p => p.text).join('\n');
    if (!text) text = responseParts.map(p => p.text || '').join('\n'); // fallback: include everything
    if (!text) {
      console.error('[FootageAnalyzer] No text in Gemini response:', JSON.stringify(data).substring(0, 300));
      throw new Error('No text in Gemini response');
    }

    console.log(`[FootageAnalyzer] Gemini raw response (${text.length} chars): ${text.substring(0, 300)}`);

    // Parse analysis
    const analysis = parseAnalysisResponse(text);
    console.log(`[FootageAnalyzer] Analysis parsed OK: content_type=${analysis.content_type}, quality=${analysis.overall_quality}`);

    // Store in DB via direct SQL (updateFootage may not support these columns)
    rawDb.prepare(
      'UPDATE footage_library SET ai_analysis = ?, ai_scenes = ?, analyzed_at = ? WHERE id = ?'
    ).run(
      JSON.stringify(analysis),
      JSON.stringify(analysis.scenes),
      new Date().toISOString(),
      clipId
    );

    console.log(`[FootageAnalyzer] Stored analysis for clip ${clipId}`);

    return analysis;

  } finally {
    // Always clean up temp frames
    cleanup();
  }
}

/**
 * Batch-analyze all unanalyzed clips in footage_library.
 *
 * @param {Object} db - Database module
 * @param {Function|null} progressCallback - Called with { current, total, clipId, status }
 * @returns {{ total: number, success: number, failed: number }}
 */
async function batchAnalyze(db, progressCallback = null) {
  const rawDb = db.db || db;
  const clips = rawDb.prepare(
    'SELECT * FROM footage_library WHERE analyzed_at IS NULL ORDER BY created_at'
  ).all();

  const total = clips.length;
  let current = 0;
  let success = 0;
  let failed = 0;

  console.log(`[FootageAnalyzer] Batch analyzing ${total} clips...`);

  for (const clip of clips) {
    current++;

    if (progressCallback) {
      progressCallback({ current, total, clipId: clip.id, status: 'analyzing' });
    }

    try {
      console.log(`[FootageAnalyzer] [${current}/${total}] Analyzing clip ${clip.id}`);
      await analyzeClip(db, clip.id);
      success++;

      if (progressCallback) {
        progressCallback({ current, total, clipId: clip.id, status: 'complete' });
      }
    } catch (err) {
      console.error(`[FootageAnalyzer] Failed to analyze clip ${clip.id}: ${err.message}`);
      failed++;

      if (progressCallback) {
        progressCallback({ current, total, clipId: clip.id, status: 'error', error: err.message });
      }
    }

    // Rate limiting - 500ms between API calls
    if (current < total) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  console.log(`[FootageAnalyzer] Batch complete: ${success} success, ${failed} failed out of ${total}`);
  return { total, success, failed };
}

/**
 * Retrieve the stored AI analysis for a clip.
 *
 * @param {Object} db - Database module
 * @param {string|number} clipId - ID of the clip in footage_library
 * @returns {Object|null} Parsed analysis object or null
 */
function getAnalysis(db, clipId) {
  const rawDb = db.db || db;
  const row = rawDb.prepare(
    'SELECT ai_analysis, ai_scenes, analyzed_at FROM footage_library WHERE id = ?'
  ).get(clipId);

  if (!row || !row.ai_analysis) return null;

  try {
    const analysis = JSON.parse(row.ai_analysis);
    analysis._analyzed_at = row.analyzed_at;
    return analysis;
  } catch (err) {
    console.error(`[FootageAnalyzer] Failed to parse stored analysis for clip ${clipId}: ${err.message}`);
    return null;
  }
}

module.exports = { extractKeyframes, analyzeClip, batchAnalyze, getAnalysis };
