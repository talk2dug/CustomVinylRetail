/**
 * Timelapse Capture Service
 * ============================================================================
 * Monitors active prints via the Pi print server. When a printer's layer
 * changes, captures a webcam frame (the head has already parked via G-code).
 * After the print completes, stitches frames into an MP4 video with ffmpeg.
 *
 * Architecture:
 *   - Polls Pi print server every 2s for active prints + current layer
 *   - On layer change: fetches webcam snapshot and saves as numbered frame
 *   - On print complete: spawns ffmpeg to encode frames → MP4
 *   - Frames stored in /mnt/stlFiles/timelapse/{jobKey}/frames/
 *   - Videos stored in /mnt/stlFiles/timelapse/{jobKey}/timelapse.mp4
 *
 * The slicer profile injects G-code that parks the head at X278 Y200
 * before each layer, with a 800ms dwell (G4 P800) for the camera to settle.
 * This service captures the frame during that dwell window.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, exec } = require('child_process');

// ============================================================================
// STATE
// ============================================================================

let printServerUrl = '';
let apiKey = '';
let db = null;  // DB reference for footage library integration
let pollTimer = null;
let enabled = false;
const POLL_INTERVAL = 2000; // 2 seconds
const TIMELAPSE_DIR = '/mnt/stlFiles/timelapse';
const FOOTAGE_DIR = '/mnt/stlFiles/footage-library';
const FOOTAGE_THUMB_DIR = path.join(FOOTAGE_DIR, 'thumbnails');

// Track active timelapse sessions per printer
// { [printerId]: { filename, lastLayer, frameCount, framesDir, startedAt, printerName } }
const sessions = {};

// ============================================================================
// INITIALIZATION
// ============================================================================

function init(options = {}) {
  printServerUrl = options.printServerUrl || process.env.PRINT_SERVER_URL || 'http://100.64.0.7:5000';
  apiKey = options.apiKey || process.env.INTERNAL_API_KEY || '';
  db = options.db || null; // For footage library integration

  // Ensure base directory exists
  try {
    fs.mkdirSync(TIMELAPSE_DIR, { recursive: true });
  } catch (e) {
    console.warn('[Timelapse] Could not create timelapse dir:', e.message);
  }

  enabled = true;
  pollTimer = setInterval(pollPrintServer, POLL_INTERVAL);
  console.log(`[Timelapse] Capture service started (polling ${printServerUrl} every ${POLL_INTERVAL / 1000}s)`);

  // Initial poll
  pollPrintServer();
}

function stop() {
  enabled = false;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  console.log('[Timelapse] Capture service stopped');
}

// ============================================================================
// POLLING
// ============================================================================

async function pollPrintServer() {
  if (!enabled) return;

  try {
    const headers = {};
    if (apiKey) headers['X-API-Key'] = apiKey;

    const resp = await fetch(`${printServerUrl}/api/3d/printers?active=true`, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return;

    const printers = await resp.json();
    if (!Array.isArray(printers)) return;

    const activePrinterIds = new Set();

    for (const p of printers) {
      const ls = p.live_status || {};
      const printerId = String(p.id);

      if (ls.state === 'printing' && ls.filename) {
        activePrinterIds.add(printerId);

        const progress = ls.progress || 0;
        const filename = ls.filename || 'unknown';

        if (!sessions[printerId]) {
          startSession(printerId, p.name || `Printer ${printerId}`, filename);
        } else if (sessions[printerId].filename !== filename) {
          await finishSession(printerId, 'new_file');
          startSession(printerId, p.name || `Printer ${printerId}`, filename);
        }

        const session = sessions[printerId];
        if (session) {
          // Capture a frame every ~0.5% progress increment
          // This gives ~200 frames for a full print → ~7s video at 30fps
          const progressStep = 0.005;
          const lastProg = session.lastProgress || 0;
          if (progress - lastProg >= progressStep || (progress > 0.001 && session.frameCount === 0)) {
            session.lastProgress = progress;
            captureFrame(printerId);
          }
        }
      }

      // Check for completed/cancelled prints
      if ((ls.state === 'complete' || ls.state === 'cancelled' || ls.state === 'error') && sessions[printerId]) {
        await finishSession(printerId, ls.state);
      }

      if (ls.state === 'standby' && sessions[printerId]) {
        await finishSession(printerId, 'standby');
      }
    }

    // Check for sessions where the printer disappeared (went offline)
    for (const printerId of Object.keys(sessions)) {
      if (!activePrinterIds.has(printerId) && sessions[printerId]) {
        // Printer no longer in active list — might have gone offline
        const session = sessions[printerId];
        const elapsed = Date.now() - (session.lastFrameAt || session.startedAt);
        // If no frame for 5 minutes, finish the session
        if (elapsed > 300000) {
          await finishSession(printerId, 'offline');
        }
      }
    }

  } catch (err) {
    // Silent — only log on first failure
    if (!pollPrintServer._lastError || Date.now() - pollPrintServer._lastError > 300000) {
      console.warn('[Timelapse] Poll error:', err.message);
      pollPrintServer._lastError = Date.now();
    }
  }
}

// ============================================================================
// SESSION MANAGEMENT
// ============================================================================

function startSession(printerId, printerName, filename) {
  const safeName = filename.replace(/\.gcode$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const jobKey = `${safeName}_${printerName.replace(/[^a-zA-Z0-9]/g, '_')}_${timestamp}`;
  const framesDir = path.join(TIMELAPSE_DIR, jobKey, 'frames');

  try {
    fs.mkdirSync(framesDir, { recursive: true });
  } catch (e) {
    console.error('[Timelapse] Could not create frames dir:', e.message);
    return;
  }

  sessions[printerId] = {
    jobKey,
    printerId,
    filename,
    printerName,
    lastProgress: 0,
    frameCount: 0,
    framesDir,
    startedAt: Date.now(),
    lastFrameAt: null,
  };

  console.log(`[Timelapse] Session started: ${printerName} → ${filename} (${jobKey})`);
}

async function finishSession(printerId, reason) {
  const session = sessions[printerId];
  if (!session) return;

  delete sessions[printerId];

  const { jobKey, printerName, filename, frameCount } = session;
  console.log(`[Timelapse] Session ended: ${printerName} — ${filename} (${reason}, ${frameCount} frames)`);

  if (frameCount < 5) {
    console.log(`[Timelapse] Only ${frameCount} frames captured, skipping video render`);
    return;
  }

  // Stitch frames into video
  try {
    const videoPath = await renderVideo(session);
    console.log(`[Timelapse] Video rendered: ${videoPath} (${frameCount} frames)`);

    // Write metadata
    const metaPath = path.join(TIMELAPSE_DIR, jobKey, 'metadata.json');
    fs.writeFileSync(metaPath, JSON.stringify({
      printer: printerName,
      filename,
      frameCount,
      startedAt: new Date(session.startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      reason,
      videoPath,
    }, null, 2));

    // Auto-upload to footage library
    try {
      await uploadToFootageLibrary(videoPath, {
        printerName,
        filename,
        frameCount,
        jobKey,
      });
    } catch (flErr) {
      console.error(`[Timelapse] Footage library upload failed:`, flErr.message);
    }

  } catch (err) {
    console.error(`[Timelapse] Video render failed for ${jobKey}:`, err.message);
  }
}

// ============================================================================
// FRAME CAPTURE
// ============================================================================

async function captureFrame(printerId) {
  const session = sessions[printerId];
  if (!session) return;

  try {
    const headers = {};
    if (apiKey) headers['X-API-Key'] = apiKey;

    // Fetch snapshot via Pi print server proxy
    const snapResp = await fetch(`${printServerUrl}/api/3d/printers/${printerId}/snapshot`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });

    if (!snapResp.ok) {
      // Fallback: try direct webcam access (if VPS can reach printer LAN)
      return;
    }

    const data = await snapResp.json();
    if (!data.snapshot) return;

    const buf = Buffer.from(data.snapshot, 'base64');
    if (buf.length < 500) return; // too small to be a real image

    // Save frame with zero-padded number
    const frameNum = String(session.frameCount).padStart(5, '0');
    const framePath = path.join(session.framesDir, `frame_${frameNum}.jpg`);
    fs.writeFileSync(framePath, buf);

    session.frameCount++;
    session.lastFrameAt = Date.now();

  } catch (err) {
    // Silent — frames can be missed, video still works
  }
}

// ============================================================================
// VIDEO RENDERING (ffmpeg)
// ============================================================================

function renderVideo(session) {
  return new Promise((resolve, reject) => {
    const jobDir = path.join(TIMELAPSE_DIR, session.jobKey);
    const framesPattern = path.join(session.framesDir, 'frame_%05d.jpg');
    const videoPath = path.join(jobDir, 'timelapse.mp4');

    // ffmpeg: input frames at 30fps, encode with H.264, good quality
    const args = [
      '-y',                           // overwrite output
      '-framerate', '30',             // input framerate (30fps = smooth timelapse)
      '-i', framesPattern,            // input frame pattern
      '-c:v', 'libx264',             // H.264 codec
      '-preset', 'medium',            // encoding speed/quality tradeoff
      '-crf', '23',                   // quality (lower = better, 23 is default)
      '-pix_fmt', 'yuv420p',         // compatibility
      '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', // ensure even dimensions
      videoPath,
    ];

    execFile('ffmpeg', args, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`ffmpeg failed: ${err.message}\n${stderr?.slice(0, 500)}`));
        return;
      }

      if (fs.existsSync(videoPath)) {
        const stat = fs.statSync(videoPath);
        resolve(videoPath);
      } else {
        reject(new Error('ffmpeg produced no output file'));
      }
    });
  });
}

// ============================================================================
// API HELPERS
// ============================================================================

function getActiveSessions() {
  return Object.entries(sessions).map(([printerId, s]) => ({
    printerId,
    printerName: s.printerName,
    filename: s.filename,
    frameCount: s.frameCount,
    progress: s.lastProgress,
    startedAt: s.startedAt,
    lastFrameAt: s.lastFrameAt,
  }));
}

function listTimelapses() {
  try {
    if (!fs.existsSync(TIMELAPSE_DIR)) return [];
    const dirs = fs.readdirSync(TIMELAPSE_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => {
        const metaPath = path.join(TIMELAPSE_DIR, d.name, 'metadata.json');
        const videoPath = path.join(TIMELAPSE_DIR, d.name, 'timelapse.mp4');
        let meta = null;
        try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (_) {}
        return {
          jobKey: d.name,
          hasVideo: fs.existsSync(videoPath),
          videoSize: fs.existsSync(videoPath) ? fs.statSync(videoPath).size : 0,
          ...meta,
        };
      })
      .filter(t => t.hasVideo || t.frameCount > 0)
      .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
    return dirs;
  } catch (_) {
    return [];
  }
}

function getVideoPath(jobKey) {
  const videoPath = path.join(TIMELAPSE_DIR, jobKey, 'timelapse.mp4');
  return fs.existsSync(videoPath) ? videoPath : null;
}

// ============================================================================
// EXPORTS
// ============================================================================

// ============================================================================
// FOOTAGE LIBRARY INTEGRATION
// ============================================================================

/**
 * Copy rendered timelapse video to footage library, generate thumbnail,
 * and create a DB record so it appears alongside IP camera recordings.
 */
async function uploadToFootageLibrary(videoPath, meta) {
  if (!db || !db.createFootage) {
    console.log('[Timelapse] No DB available — skipping footage library upload');
    return;
  }

  try {
    fs.mkdirSync(FOOTAGE_DIR, { recursive: true });
    fs.mkdirSync(FOOTAGE_THUMB_DIR, { recursive: true });
  } catch (_) {}

  const id = crypto.randomUUID();
  const ext = path.extname(videoPath) || '.mp4';
  const destFilename = `${id}${ext}`;
  const destPath = path.join(FOOTAGE_DIR, destFilename);

  // Copy video to footage library
  fs.copyFileSync(videoPath, destPath);
  const stat = fs.statSync(destPath);

  // Generate thumbnail
  const thumbFilename = `${id}.jpg`;
  const thumbPath = path.join(FOOTAGE_THUMB_DIR, thumbFilename);
  await new Promise(resolve => {
    exec(`ffmpeg -i "${destPath}" -ss 00:00:01 -vframes 1 -vf "scale=320:-1" -y "${thumbPath}" 2>/dev/null`, () => resolve());
  });

  // Get video metadata
  const videoMeta = await new Promise(resolve => {
    exec(`ffprobe -v quiet -print_format json -show_format -show_streams "${destPath}"`, (err, stdout) => {
      if (err) return resolve({});
      try {
        const info = JSON.parse(stdout);
        const vs = (info.streams || []).find(s => s.codec_type === 'video');
        resolve({
          duration_seconds: info.format ? parseFloat(info.format.duration) || null : null,
          width: vs ? vs.width : null,
          height: vs ? vs.height : null,
        });
      } catch (_) { resolve({}); }
    });
  });

  // Build descriptive name: "Timelapse - PrinterName - filename"
  const printName = (meta.filename || '').replace(/\.gcode$/i, '');
  const originalName = `Timelapse - ${meta.printerName || 'Printer'} - ${printName}`;

  // Create footage library record
  db.createFootage({
    id,
    filename: destFilename,
    original_name: originalName,
    file_path: destPath,
    file_size: stat.size,
    duration_seconds: videoMeta.duration_seconds || null,
    width: videoMeta.width || null,
    height: videoMeta.height || null,
    mime_type: 'video/mp4',
    category: 'timelapse',
    subcategory: 'finished-print',
    tags: 'timelapse,finished-print',
    notes: `Auto-captured from ${meta.printerName || 'printer'} (${meta.frameCount} frames)`,
    thumbnail_path: fs.existsSync(thumbPath) ? thumbPath : null,
    status: 'raw',
    source: 'timelapse-capture',
  });

  console.log(`[Timelapse] Uploaded to footage library: ${originalName} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
}

module.exports = {
  init,
  stop,
  getActiveSessions,
  listTimelapses,
  getVideoPath,
  TIMELAPSE_DIR,
};
