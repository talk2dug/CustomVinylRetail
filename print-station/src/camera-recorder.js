/**
 * Camera Recorder Service
 *
 * Manages IP camera configuration, ONVIF RTSP URL fetching (via Python),
 * live preview, segmented recording via ffmpeg, and auto-reconnect.
 *
 * LaView cameras rotate RTSP tokens on reboot, so we always fetch the
 * current RTSP URI through ONVIF before starting/reconnecting ffmpeg.
 *
 * Future-proofed for multiple cameras and Frigate NVR integration.
 */

const { app } = require('electron');
const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const CAMERAS_FILE = path.join(app.getPath('userData'), 'cameras.json');
const TEMP_DIR = path.join(app.getPath('temp'), 'print-station-recordings');
const PYTHON_SCRIPT = path.join(__dirname, 'scripts', 'get_rtsp_url.py');

// Ensure dirs exist
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// FFmpeg binary — prefer system install, fall back to bundled ffmpeg-static
// ---------------------------------------------------------------------------
let ffmpegPath = 'ffmpeg';
let ffprobePath = 'ffprobe';

const SYSTEM_FFMPEG_PATHS = [
  'C:\\ffmpeg\\bin\\ffmpeg.exe',
  'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
];
const systemFfmpeg = SYSTEM_FFMPEG_PATHS.find(p => fs.existsSync(p));
if (systemFfmpeg) {
  ffmpegPath = systemFfmpeg;
  ffprobePath = systemFfmpeg.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1');
  if (!fs.existsSync(ffprobePath)) ffprobePath = 'ffprobe';
} else {
  try {
    ffmpegPath = require('ffmpeg-static');
    ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1');
    if (!fs.existsSync(ffprobePath)) ffprobePath = 'ffprobe';
  } catch (_) { /* rely on system PATH */ }
}

// ---------------------------------------------------------------------------
// Event emitter — the Electron main process subscribes to these and
// forwards them to the renderer via webContents.send().
// ---------------------------------------------------------------------------
const emitter = new EventEmitter();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let cameras = [];                       // loaded from JSON
const activeRecordings = new Map();     // cameraId → RecordingSession
const activePreviews = new Map();       // cameraId → { running, stop() }

const SEGMENT_SECONDS = 300;            // 5-minute MP4 segments
const RECONNECT_DELAY_MS = 10_000;      // wait 10 s before reconnect
const PI_PULL_DIR = path.join(app.getPath('temp'), 'print-station-pi-pulls');
if (!fs.existsSync(PI_PULL_DIR)) fs.mkdirSync(PI_PULL_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
let logStream = null;

function openLog(outputDir) {
  try {
    const logFile = path.join(outputDir, 'camera-recorder.log');
    logStream = fs.createWriteStream(logFile, { flags: 'a' });
  } catch (_) { /* non-fatal */ }
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log('[CameraRecorder]', msg);
  if (logStream) { try { logStream.write(line + '\n'); } catch (_) {} }
}

// ---------------------------------------------------------------------------
// Camera Config CRUD
// ---------------------------------------------------------------------------
function loadCameras() {
  try {
    if (fs.existsSync(CAMERAS_FILE)) {
      cameras = JSON.parse(fs.readFileSync(CAMERAS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[CameraRecorder] Failed to load cameras:', e.message);
    cameras = [];
  }
  // Seed default LaView camera if empty
  if (cameras.length === 0) {
    cameras.push({
      id: crypto.randomUUID(),
      name: 'Workshop Camera (LaView)',
      rtspUrl: '',                    // fetched dynamically via ONVIF
      onvifHost: '192.168.0.145',
      onvifPort: 8000,
      onvifUser: 'admin',
      onvifPass: '0000011111',
      onvifProfile: 'PROFILE_16415', // main stream (sub = PROFILE_16417)
      enabled: true,
      rotation: 90,                   // physically rotated for TikTok portrait
      stream: 'main'                  // 'main' or 'sub'
    });
    saveCameras();
  }
  return cameras;
}

function saveCameras() {
  fs.writeFileSync(CAMERAS_FILE, JSON.stringify(cameras, null, 2));
}

function listCameras() {
  if (!cameras.length) loadCameras();
  return cameras;
}

function getCamera(id) {
  return cameras.find(c => c.id === id) || null;
}

function addCamera(config) {
  const cam = {
    id: crypto.randomUUID(),
    name: config.name || 'New Camera',
    rtspUrl: config.rtspUrl || '',
    onvifHost: config.onvifHost || '',
    onvifPort: config.onvifPort || 8000,
    onvifUser: config.onvifUser || '',
    onvifPass: config.onvifPass || '',
    onvifProfile: config.onvifProfile || '',
    enabled: config.enabled !== false,
    rotation: config.rotation || 0,
    stream: config.stream || 'main',
    // Pi camera fields
    piHost: config.piHost || '',
    piPort: config.piPort || 8080,
    piRtspPort: config.piRtspPort || 8554,
    piRtspPath: config.piRtspPath || '/cam'
  };
  cameras.push(cam);
  saveCameras();
  return cam;
}

function updateCamera(id, updates) {
  const idx = cameras.findIndex(c => c.id === id);
  if (idx < 0) return null;
  Object.assign(cameras[idx], updates);
  saveCameras();
  return cameras[idx];
}

function removeCamera(id) {
  cameras = cameras.filter(c => c.id !== id);
  saveCameras();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// ONVIF RTSP URL Fetching (via Python)
// ---------------------------------------------------------------------------

/**
 * Call the Python ONVIF script to get the current RTSP URI.
 * The token embedded in the URL rotates on camera reboot.
 */
function fetchRtspUrl(cam) {
  return new Promise((resolve, reject) => {
    const profile = cam.onvifProfile ||
      (cam.stream === 'sub' ? 'PROFILE_16417' : 'PROFILE_16415');

    const args = [
      PYTHON_SCRIPT,
      '--host', cam.onvifHost,
      '--port', String(cam.onvifPort || 8000),
      '--user', cam.onvifUser || 'admin',
      '--pass', cam.onvifPass || '',
      '--profile', profile
    ];

    log(`Fetching RTSP URL: python ${args.join(' ')}`);
    const proc = spawn('python', args, { windowsHide: true });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('ONVIF fetch timed out after 15 s'));
    }, 15_000);

    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) {
        const url = stdout.trim();
        log(`Got RTSP URL: ${url.replace(/\/\/[^@]+@/, '//***@')}`); // redact creds in log
        resolve(url);
      } else {
        const err = stderr.trim() || `python exited with code ${code}`;
        log(`ONVIF fetch failed: ${err}`);
        reject(new Error(err));
      }
    });

    proc.on('error', e => {
      clearTimeout(timer);
      reject(new Error(`Failed to run python: ${e.message}`));
    });
  });
}

/**
 * Get an RTSP URL for a camera.
 * If rtspUrl is hardcoded (e.g. Frigate re-stream), use it directly.
 * Otherwise, fetch via ONVIF Python script.
 */
async function getRtspUrl(cam) {
  // Pi camera — build RTSP URL from pi config
  if (isPiCamera(cam)) return piRtspUrl(cam);

  // Static URL (Frigate, manual entry, etc.)
  if (cam.rtspUrl) return cam.rtspUrl;

  // ONVIF dynamic fetch
  if (cam.onvifHost) {
    return fetchRtspUrl(cam);
  }

  return null;
}

// ---------------------------------------------------------------------------
// ONVIF Discovery — full profile + device info
// ---------------------------------------------------------------------------
async function discoverCamera(config) {
  if (!config.onvifHost) throw new Error('No ONVIF host provided');

  return new Promise((resolve, reject) => {
    const args = [
      PYTHON_SCRIPT,
      '--host', config.onvifHost,
      '--port', String(config.onvifPort || 8000),
      '--user', config.onvifUser || 'admin',
      '--pass', config.onvifPass || '',
      '--discover'
    ];

    log(`Discovering camera at ${config.onvifHost}:${config.onvifPort || 8000}...`);
    const proc = spawn('python', args, { windowsHide: true });

    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('Discovery timed out after 20 s'));
    }, 20_000);

    proc.on('close', code => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(stdout.trim());
        if (result.success) {
          log(`Discovered ${result.device?.manufacturer || 'camera'} ${result.device?.model || ''} — ${result.profiles?.length || 0} profiles`);
        }
        resolve(result);
      } catch (_) {
        const err = stderr.trim() || stdout.trim() || `Discovery failed (exit ${code})`;
        log(`Discovery error: ${err}`);
        resolve({ success: false, error: err });
      }
    });

    proc.on('error', e => {
      clearTimeout(timer);
      resolve({ success: false, error: `Failed to run python: ${e.message}` });
    });
  });
}

// ---------------------------------------------------------------------------
// Pi Camera HTTP API helpers
// ---------------------------------------------------------------------------

function isPiCamera(cam) {
  return !!(cam && cam.piHost);
}

function piBaseUrl(cam) {
  const host = cam.piHost || '192.168.0.141';
  const port = cam.piPort || 8080;
  return `http://${host}:${port}`;
}

async function piFetch(cam, endpoint, options = {}) {
  const url = `${piBaseUrl(cam)}${endpoint}`;
  log(`Pi API: ${options.method || 'GET'} ${url}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || 10_000);
  try {
    const resp = await fetch(url, {
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...options.headers },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(text || `HTTP ${resp.status}`);
    }
    return resp.json();
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === 'AbortError') throw new Error('Pi camera request timed out');
    throw e;
  }
}

/** Get Pi server status */
async function piStatus(cam) {
  return piFetch(cam, '/api/status');
}

/** Start recording on the Pi */
async function piStartRecording(cam, prefix) {
  return piFetch(cam, '/api/record/start', {
    method: 'POST',
    body: prefix ? { prefix } : {}
  });
}

/** Stop recording on the Pi */
async function piStopRecording(cam) {
  return piFetch(cam, '/api/record/stop', { method: 'POST' });
}

/** List recordings on the Pi */
async function piListRecordings(cam) {
  return piFetch(cam, '/api/recordings');
}

/** Delete a recording from the Pi */
async function piDeleteRecording(cam, filename) {
  return piFetch(cam, `/api/recordings/${encodeURIComponent(filename)}`, { method: 'DELETE' });
}

/** Download a recording from the Pi to local temp dir, return local path */
async function piPullRecording(cam, filename, progressCb) {
  const url = `${piBaseUrl(cam)}/api/recordings/${encodeURIComponent(filename)}`;
  const localPath = path.join(PI_PULL_DIR, filename);
  log(`Pi pull: ${url} → ${localPath}`);

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Download failed: HTTP ${resp.status}`);

  const totalBytes = parseInt(resp.headers.get('content-length') || '0', 10);
  const fileStream = fs.createWriteStream(localPath);

  // resp.body is a ReadableStream (web stream), use async iteration
  let downloaded = 0;
  const reader = resp.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      fileStream.write(Buffer.from(value));
      downloaded += value.byteLength;
      if (progressCb && totalBytes > 0) {
        progressCb({ downloaded, totalBytes, percent: Math.round((downloaded / totalBytes) * 100) });
      }
    }
  } catch (err) {
    fileStream.end();
    throw err;
  }
  fileStream.end();
  log(`Pi pull complete: ${filename} (${downloaded} bytes)`);
  return localPath;
}

/**
 * Test a Pi camera connection — checks HTTP API and RTSP.
 */
async function testPiCamera(config) {
  try {
    const status = await piFetch(config, '/api/status');
    const result = { success: true, piStatus: status };
    // Also test RTSP if we can build the URL
    const rtsp = piRtspUrl(config);
    if (rtsp) {
      try {
        await probeRtsp(rtsp);
        result.rtspOk = true;
      } catch (e) {
        result.rtspOk = false;
        result.rtspError = e.message;
      }
    }
    return result;
  } catch (e) {
    return { success: false, error: e.message || 'Pi camera connection failed' };
  }
}

/** Build the RTSP URL for a Pi camera */
function piRtspUrl(cam) {
  if (cam.rtspUrl) return cam.rtspUrl;
  const host = cam.piHost || '192.168.0.141';
  const rtspPort = cam.piRtspPort || 8554;
  const rtspPath = cam.piRtspPath || '/cam';
  return `rtsp://${host}:${rtspPort}${rtspPath}`;
}

// ---------------------------------------------------------------------------
// Test Camera Connection
// ---------------------------------------------------------------------------
async function testCamera(config) {
  // Pi camera — test HTTP API + RTSP
  if (isPiCamera(config)) return testPiCamera(config);

  try {
    let url;
    if (config.rtspUrl) {
      url = config.rtspUrl;
    } else if (config.onvifHost) {
      url = await fetchRtspUrl(config);
    } else {
      return { success: false, error: 'No RTSP URL or ONVIF host configured' };
    }
    await probeRtsp(url);
    return { success: true, url };
  } catch (e) {
    return { success: false, error: e.message || 'Connection failed' };
  }
}

function probeRtsp(url) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffprobePath, [
      '-rtsp_transport', 'tcp',
      '-analyzeduration', '3000000',
      '-probesize', '2000000',
      '-timeout', '8000000',
      '-i', url,
      '-show_format',
      '-print_format', 'json',
      '-v', 'quiet'
    ], { windowsHide: true });

    let out = '';
    proc.stdout.on('data', d => { out += d; });
    const timer = setTimeout(() => { proc.kill(); reject(new Error('timeout')); }, 12_000);

    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(true);
      else reject(new Error(`ffprobe exited ${code}`));
    });
    proc.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

// ---------------------------------------------------------------------------
// Live Preview (RTSP snapshot stream via ffmpeg)
// ---------------------------------------------------------------------------

function grabSnapshot(rtspUrl, rotation = 0) {
  return new Promise((resolve, reject) => {
    const vfFilters = [];
    if (rotation === 90) vfFilters.push('transpose=1');
    else if (rotation === 180) vfFilters.push('transpose=1,transpose=1');
    else if (rotation === 270) vfFilters.push('transpose=2');

    const args = [
      '-rtsp_transport', 'tcp',
      '-i', rtspUrl,
      '-frames:v', '1',
    ];
    if (vfFilters.length) args.push('-vf', vfFilters.join(','));
    args.push('-f', 'image2', '-c:v', 'mjpeg', '-q:v', '5', 'pipe:1');

    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    const chunks = [];
    proc.stdout.on('data', d => chunks.push(d));

    const timer = setTimeout(() => { proc.kill(); reject(new Error('snapshot timeout')); }, 15000);

    proc.on('close', code => {
      clearTimeout(timer);
      if (chunks.length > 0) resolve(Buffer.concat(chunks).toString('base64'));
      else reject(new Error(`snapshot failed, code ${code}`));
    });
    proc.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

function startPreviewLoop(cameraId, callback, intervalMs = 750) {
  const cam = getCamera(cameraId);
  if (!cam) throw new Error('Camera not found');

  stopPreviewLoop(cameraId);

  let running = true;
  let currentUrl = null;

  const loop = async () => {
    // Fetch RTSP URL once at start
    try {
      currentUrl = await getRtspUrl(cam);
    } catch (e) {
      callback(null, `Failed to get RTSP URL: ${e.message}`);
      return;
    }
    if (!currentUrl) {
      callback(null, 'No RTSP URL for camera');
      return;
    }

    while (running) {
      try {
        const frame = await grabSnapshot(currentUrl, cam.rotation);
        if (running) callback(frame);
      } catch (e) {
        if (running) callback(null, e.message);
      }
      await new Promise(r => setTimeout(r, intervalMs));
    }
  };

  const state = { running: true, stop: () => { running = false; } };
  activePreviews.set(cameraId, state);
  loop();

  return state;
}

function stopPreviewLoop(cameraId) {
  const p = activePreviews.get(cameraId);
  if (p) {
    p.stop();
    activePreviews.delete(cameraId);
  }
}

// ---------------------------------------------------------------------------
// Recording Session — segmented MP4, auto-reconnect
// ---------------------------------------------------------------------------

class RecordingSession {
  constructor(cameraId, outputDir, stream = 'main') {
    this.id = crypto.randomUUID();
    this.cameraId = cameraId;
    this.cam = getCamera(cameraId);
    if (!this.cam) throw new Error('Camera not found');

    this.outputDir = outputDir || TEMP_DIR;
    if (!fs.existsSync(this.outputDir)) fs.mkdirSync(this.outputDir, { recursive: true });

    this.stream = stream;
    this.active = false;
    this.stopping = false;
    this.proc = null;
    this.currentSegment = null;
    this.segments = [];
    this.startedAt = null;
    this.errors = [];
    this.reconnectTimer = null;
  }

  async start() {
    if (this.active) return;
    this.active = true;
    this.stopping = false;
    this.startedAt = Date.now();
    openLog(this.outputDir);
    log(`Recording session ${this.id} starting for camera "${this.cam.name}"`);
    emitter.emit('recording-started', this.toStatus());
    await this._launchFfmpeg();
  }

  async stop() {
    if (!this.active) return this.toStatus();
    this.stopping = true;
    this.active = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    log(`Stopping recording session ${this.id}`);

    if (this.proc) {
      await this._gracefulStop();
    }

    emitter.emit('recording-stopped', this.toStatus());
    log(`Session ${this.id} stopped. ${this.segments.length} segment(s) recorded.`);
    return this.toStatus();
  }

  async _launchFfmpeg() {
    if (this.stopping) return;

    let rtspUrl;
    try {
      // Always re-fetch URL in case token rotated
      rtspUrl = await getRtspUrl(this.cam);
      if (!rtspUrl) throw new Error('No RTSP URL');
    } catch (e) {
      const msg = `Failed to get RTSP URL: ${e.message}`;
      log(msg);
      this.errors.push({ time: new Date().toISOString(), message: msg });
      emitter.emit('error', { sessionId: this.id, error: msg });
      this._scheduleReconnect();
      return;
    }

    // Segment filename pattern: laview_YYYYMMDD_HHMMSS_%03d.mp4
    const now = new Date();
    const ts = now.toISOString().replace(/[-:T]/g, '').replace(/\..+/, '').slice(0, 14);
    const segPattern = path.join(this.outputDir, `laview_${ts}_%03d.mp4`);

    // Build ffmpeg args — rotation requires re-encoding
    const rotation = this.cam.rotation || 0;
    const needsRotation = rotation !== 0;

    const vfFilters = [];
    if (rotation === 90) vfFilters.push('transpose=1');
    else if (rotation === 180) vfFilters.push('transpose=1,transpose=1');
    else if (rotation === 270) vfFilters.push('transpose=2');

    const args = [
      '-rtsp_transport', 'tcp',
      '-i', rtspUrl,
    ];

    if (needsRotation) {
      // Must re-encode to apply rotation (produces actual portrait pixels)
      // Downscale to 1080x1920 (TikTok native) for encoding speed + compatibility
      vfFilters.push('scale=1080:1920');
      args.push('-vf', vfFilters.join(','));
      args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23');
    } else {
      args.push('-c:v', 'copy');
    }

    args.push(
      '-an',                           // drop audio (PCMA not supported in MP4)
      '-f', 'segment',
      '-segment_time', String(SEGMENT_SECONDS),
      '-segment_format', 'mp4',
      '-reset_timestamps', '1',
      '-strftime', '0',               // use %03d numbering
      '-y',
      segPattern.replace(/\\/g, '/')   // ffmpeg on Windows needs forward slashes
    );

    log(`Launching ffmpeg: ${ffmpegPath} ${args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`);

    this.proc = spawn(ffmpegPath, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.currentSegment = segPattern.replace('%03d', '000').replace(/\\/g, '/');

    // Watch stderr for segment completion messages and errors
    let stderrBuf = '';
    this.proc.stderr.on('data', chunk => {
      stderrBuf += chunk.toString();
      // ffmpeg segment muxer logs "Opening '...' for writing" when starting a new segment
      const matches = stderrBuf.match(/Opening '([^']+)' for writing/g);
      if (matches) {
        const lastMatch = matches[matches.length - 1];
        const segFile = lastMatch.match(/Opening '([^']+)'/)?.[1];
        const normSeg = segFile ? segFile.replace(/\\/g, '/') : null;
        if (normSeg && normSeg !== this.currentSegment) {
          // Previous segment is complete
          if (this.currentSegment && fs.existsSync(this.currentSegment)) {
            this.segments.push(this.currentSegment);
            log(`Segment complete: ${path.basename(this.currentSegment)}`);
            emitter.emit('segment-complete', {
              sessionId: this.id,
              file: this.currentSegment,
              index: this.segments.length - 1
            });
          }
          this.currentSegment = normSeg;
        }
        // Clear processed lines to prevent unbounded buffer growth
        const lastNewline = stderrBuf.lastIndexOf('\n');
        if (lastNewline > -1) stderrBuf = stderrBuf.slice(lastNewline + 1);
      }
    });

    this.proc.on('close', (code) => {
      // Capture the final segment
      if (this.currentSegment && fs.existsSync(this.currentSegment)) {
        const stat = fs.statSync(this.currentSegment);
        if (stat.size > 0) {
          this.segments.push(this.currentSegment);
          log(`Final segment: ${path.basename(this.currentSegment)} (${stat.size} bytes)`);
          emitter.emit('segment-complete', {
            sessionId: this.id,
            file: this.currentSegment,
            index: this.segments.length - 1
          });
        }
      }

      if (this.stopping) {
        this.proc = null;
        return; // intentional stop
      }

      // Unexpected death — auto-reconnect
      const msg = `ffmpeg exited unexpectedly with code ${code}`;
      log(msg);
      this.errors.push({ time: new Date().toISOString(), message: msg });
      emitter.emit('error', { sessionId: this.id, error: msg });
      this.proc = null;
      this._scheduleReconnect();
    });

    this.proc.on('error', (err) => {
      const msg = `ffmpeg spawn error: ${err.message}`;
      log(msg);
      this.errors.push({ time: new Date().toISOString(), message: msg });
      emitter.emit('error', { sessionId: this.id, error: msg });
      this.proc = null;
      if (!this.stopping) this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    if (this.stopping || !this.active) return;
    log(`Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
    emitter.emit('reconnecting', { sessionId: this.id, delayMs: RECONNECT_DELAY_MS });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.active && !this.stopping) {
        log('Reconnecting now — re-fetching RTSP URL via ONVIF');
        this._launchFfmpeg();
      }
    }, RECONNECT_DELAY_MS);
  }

  _gracefulStop() {
    return new Promise(resolve => {
      if (!this.proc) return resolve();

      // Send 'q' for graceful finalization of current MP4 segment
      try { this.proc.stdin.write('q'); } catch (_) {}

      const forceTimer = setTimeout(() => {
        log('Force-killing ffmpeg after 8s timeout');
        try { this.proc.kill('SIGKILL'); } catch (_) {}
      }, 8000);

      this.proc.on('close', () => {
        clearTimeout(forceTimer);
        this.proc = null;
        resolve();
      });
    });
  }

  toStatus() {
    return {
      sessionId: this.id,
      cameraId: this.cameraId,
      cameraName: this.cam?.name || '',
      active: this.active,
      currentSegment: this.currentSegment ? path.basename(this.currentSegment) : null,
      segmentCount: this.segments.length,
      segments: this.segments.map(s => path.basename(s)),
      elapsed: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      startedAt: this.startedAt,
      errors: this.errors.slice(-5), // last 5 errors
      outputDir: this.outputDir
    };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start recording from a camera.
 * @param {string} cameraId
 * @param {string} outputDir — where to save segments (defaults to temp dir)
 * @param {string} stream — 'main' or 'sub'
 * @returns {Promise<object>} — session status
 */
async function startRecording(cameraId, outputDir, stream) {
  if (activeRecordings.has(cameraId)) {
    throw new Error('Camera is already recording');
  }

  const cam = getCamera(cameraId);
  if (!cam) throw new Error('Camera not found');

  // Pi camera — delegate to Pi HTTP API
  if (isPiCamera(cam)) {
    const result = await piStartRecording(cam, cam.name?.replace(/\s+/g, '_').toLowerCase());
    const piSession = {
      type: 'pi',
      cameraId,
      cam,
      sessionId: result.session_id,
      active: true,
      startedAt: Date.now(),
      toStatus() {
        return {
          sessionId: this.sessionId,
          cameraId: this.cameraId,
          cameraName: this.cam?.name || '',
          active: this.active,
          piCamera: true,
          elapsed: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
          startedAt: this.startedAt,
          segments: [],
          segmentCount: 0,
          errors: []
        };
      }
    };
    activeRecordings.set(cameraId, piSession);
    emitter.emit('recording-started', piSession.toStatus());
    log(`Pi recording started: session ${result.session_id}`);
    return piSession.toStatus();
  }

  const session = new RecordingSession(cameraId, outputDir || TEMP_DIR, stream || 'main');
  activeRecordings.set(cameraId, session);
  await session.start();
  return session.toStatus();
}

/**
 * Stop recording for a camera.
 * @param {string} cameraId
 * @returns {Promise<object>} — final session status with all segments
 */
async function stopRecording(cameraId) {
  const session = activeRecordings.get(cameraId);
  if (!session) throw new Error('No active recording for this camera');

  // Pi camera — stop via HTTP API
  if (session.type === 'pi') {
    const result = await piStopRecording(session.cam);
    session.active = false;
    activeRecordings.delete(cameraId);
    const status = {
      ...session.toStatus(),
      active: false,
      piCamera: true,
      piFiles: result.files || [],
      elapsed: session.startedAt ? Math.round((Date.now() - session.startedAt) / 1000) : 0
    };
    emitter.emit('recording-stopped', status);
    log(`Pi recording stopped: ${(result.files || []).length} file(s)`);
    return status;
  }

  const status = await session.stop();
  activeRecordings.delete(cameraId);
  return status;
}

/**
 * Get status of all active recordings.
 */
function getRecordingStatus() {
  const result = {};
  for (const [camId, session] of activeRecordings) {
    result[camId] = session.toStatus();
  }
  return result;
}

/**
 * Get status for a single camera's recording.
 */
function getStatus(cameraId) {
  const session = activeRecordings.get(cameraId);
  if (!session) return { active: false, cameraId };
  const status = session.toStatus();
  // For Pi cameras, fetch live status from Pi to get segment count
  return status;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
function cleanupTempFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    console.error('[CameraRecorder] cleanup error:', e.message);
  }
}

/**
 * Clean shutdown — finalize all active recordings.
 * Call this from app 'before-quit'.
 */
async function shutdown() {
  log('Shutting down — finalizing all recordings...');
  const promises = [];
  for (const [camId] of activeRecordings) {
    promises.push(stopRecording(camId).catch(e => log(`Shutdown stop error: ${e.message}`)));
  }
  await Promise.all(promises);
  if (logStream) { try { logStream.end(); } catch (_) {} }
}

// ---------------------------------------------------------------------------
// Check ffmpeg availability
// ---------------------------------------------------------------------------
function checkFfmpeg() {
  return new Promise(resolve => {
    try {
      const proc = spawn(ffmpegPath, ['-version'], { windowsHide: true });
      let ver = '';
      proc.stdout.on('data', d => { ver += d; });
      proc.on('close', code => {
        resolve({ available: code === 0, version: ver.split('\n')[0] || '', path: ffmpegPath });
      });
      proc.on('error', () => resolve({ available: false, version: '', path: ffmpegPath }));
    } catch (_) {
      resolve({ available: false, version: '', path: ffmpegPath });
    }
  });
}

// ---------------------------------------------------------------------------
// Check python + onvif-zeep availability
// ---------------------------------------------------------------------------
function checkPython() {
  return new Promise(resolve => {
    try {
      const proc = spawn('python', ['--version'], { windowsHide: true });
      let ver = '';
      proc.stdout.on('data', d => { ver += d; });
      proc.stderr.on('data', d => { ver += d; }); // python --version may output to stderr
      proc.on('close', code => {
        if (code === 0) {
          // Also check onvif-zeep
          // Check for onvif package (works with both onvif-zeep and onvif-zeep-async)
          const pip = spawn('python', ['-c', 'import onvif; print(getattr(onvif, "__version__", "installed"))'], { windowsHide: true });
          let onvifVer = '';
          pip.stdout.on('data', d => { onvifVer += d; });
          pip.on('close', c2 => {
            resolve({
              python: true,
              pythonVersion: ver.trim(),
              onvifZeep: c2 === 0,
              onvifVersion: onvifVer.trim()
            });
          });
          pip.on('error', () => resolve({ python: true, pythonVersion: ver.trim(), onvifZeep: false }));
        } else {
          resolve({ python: false });
        }
      });
      proc.on('error', () => resolve({ python: false }));
    } catch (_) {
      resolve({ python: false });
    }
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
function init() {
  loadCameras();
  log(`Loaded ${cameras.length} camera(s). ffmpeg: ${ffmpegPath}`);
}

module.exports = {
  // EventEmitter — subscribe with .on('recording-started', handler), etc.
  events: emitter,

  // Init / config
  init,
  loadCameras,
  listCameras,
  getCamera,
  addCamera,
  updateCamera,
  removeCamera,

  // RTSP / ONVIF
  getRtspUrl,
  fetchRtspUrl,
  discoverCamera,
  testCamera,

  // Preview
  grabSnapshot,
  startPreviewLoop,
  stopPreviewLoop,

  // Recording
  startRecording,
  stopRecording,
  getRecordingStatus,
  getStatus,

  // Pi Camera
  isPiCamera,
  piStatus,
  piStartRecording,
  piStopRecording,
  piListRecordings,
  piDeleteRecording,
  piPullRecording,

  // Utilities
  cleanupTempFile,
  checkFfmpeg,
  checkPython,
  shutdown,

  TEMP_DIR,
  PI_PULL_DIR,
  SEGMENT_SECONDS
};
