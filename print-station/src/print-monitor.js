/**
 * AI Print Monitor — Ollama Vision-based print quality monitoring
 *
 * Periodically captures webcam snapshots from printing printers,
 * sends them to Ollama (llava vision model) for analysis, and
 * raises alerts for spaghetti, temp/speed issues, and other problems.
 *
 * Failover: GPU bridge first → local Ollama fallback
 */

const http = require('http');
const path = require('path');
const fs = require('fs');

// Load .env for GPU bridge config
const envPath = path.resolve(__dirname, '..', '..', '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
}

// GPU bridge config (try first) — falls back to OLLAMA_HOST if GPU_BRIDGE_HOST not set
const GPU_BRIDGE_HOST = process.env.GPU_BRIDGE_HOST || process.env.OLLAMA_HOST || '';
const GPU_BRIDGE_PORT = parseInt(process.env.GPU_BRIDGE_PORT || process.env.OLLAMA_PORT, 10) || 11434;
const GPU_BRIDGE_VISION_MODEL = process.env.GPU_BRIDGE_VISION_MODEL || 'llava:13b';

// Local Ollama config (fallback)
const LOCAL_HOST = '127.0.0.1';
const LOCAL_PORT = 11434;
const LOCAL_VISION_MODEL = 'llava:13b';

// Timing
const ANALYSIS_INTERVAL_MS = 45000;  // 45 seconds between analyses per printer
const SNAPSHOT_TIMEOUT_MS = 8000;
const OLLAMA_TIMEOUT_MS = 90000;     // vision model can be slow
const HEALTH_CHECK_TIMEOUT = 3000;
const HEALTH_CACHE_TTL = 30000;      // 30 seconds

// Alert severity levels
const SEVERITY = { OK: 'ok', WARNING: 'warning', CRITICAL: 'critical' };

// Per-printer monitor state
const monitors = new Map();

// GPU bridge health cache
let _bridgeHealth = { healthy: false, checkedAt: 0, error: null };

// Stats
const _stats = {
  gpuRequests: 0,
  localRequests: 0,
  gpuFailovers: 0,
  totalAnalyses: 0
};

// ==================== GPU Bridge Failover ====================

function isBridgeConfigured() {
  return !!GPU_BRIDGE_HOST;
}

async function checkBridgeHealth() {
  if (!isBridgeConfigured()) return false;
  const now = Date.now();
  if (now - _bridgeHealth.checkedAt < HEALTH_CACHE_TTL) return _bridgeHealth.healthy;

  try {
    const healthy = await new Promise((resolve) => {
      const req = http.request({
        hostname: GPU_BRIDGE_HOST,
        port: GPU_BRIDGE_PORT,
        path: '/api/tags',
        method: 'GET',
        timeout: HEALTH_CHECK_TIMEOUT
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(res.statusCode === 200));
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    });
    _bridgeHealth = { healthy, checkedAt: now, error: null };
    return healthy;
  } catch (e) {
    _bridgeHealth = { healthy: false, checkedAt: now, error: e.message };
    return false;
  }
}

/**
 * Make an Ollama HTTP request to a specific host/port
 */
function ollamaRequest(host, port, payload, timeout) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      hostname: host,
      port,
      path: '/api/generate',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.response || '');
        } catch (e) {
          reject(new Error(`Failed to parse Ollama response: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Ollama request timeout')); });
    req.write(body);
    req.end();
  });
}

/**
 * Send vision request with GPU bridge → local failover
 */
async function ollamaVisionRequest(payload) {
  // Try GPU bridge first
  if (isBridgeConfigured()) {
    const bridgeHealthy = await checkBridgeHealth();
    if (bridgeHealthy) {
      try {
        const model = GPU_BRIDGE_VISION_MODEL || LOCAL_VISION_MODEL;
        const bridgePayload = { ...payload, model };
        const result = await ollamaRequest(GPU_BRIDGE_HOST, GPU_BRIDGE_PORT, bridgePayload, OLLAMA_TIMEOUT_MS);
        _stats.gpuRequests++;
        console.log(`[PrintMonitor] Vision analysis served by GPU bridge (${GPU_BRIDGE_HOST})`);
        return result;
      } catch (e) {
        console.warn(`[PrintMonitor] GPU bridge failed, falling back to local: ${e.message}`);
        _stats.gpuFailovers++;
        _bridgeHealth = { healthy: false, checkedAt: Date.now(), error: e.message };
      }
    }
  }

  // Fallback to local Ollama
  try {
    const localPayload = { ...payload, model: LOCAL_VISION_MODEL };
    const result = await ollamaRequest(LOCAL_HOST, LOCAL_PORT, localPayload, OLLAMA_TIMEOUT_MS);
    _stats.localRequests++;
    console.log(`[PrintMonitor] Vision analysis served by local Ollama`);
    return result;
  } catch (e) {
    throw new Error(`Vision analysis failed (both GPU bridge and local): ${e.message}`);
  }
}

// ==================== Monitor Lifecycle ====================

/**
 * Start monitoring a printer
 */
function startMonitoring(printerId, { getSnapshot, getStatus, onAlert, onAnalysis }) {
  if (monitors.has(printerId)) stopMonitoring(printerId);

  const state = {
    printerId,
    active: true,
    getSnapshot,
    getStatus,
    onAlert,
    onAnalysis,
    interval: null,
    lastAnalysis: null,
    alertHistory: [],
    consecutiveOk: 0,
    consecutiveWarnings: 0,
    analysisCount: 0
  };

  monitors.set(printerId, state);

  // Run first analysis after a short delay
  setTimeout(() => runAnalysis(printerId), 5000);

  // Set up periodic analysis
  state.interval = setInterval(() => runAnalysis(printerId), ANALYSIS_INTERVAL_MS);

  console.log(`[PrintMonitor] Started monitoring printer ${printerId}`);
  return true;
}

/**
 * Stop monitoring a printer
 */
function stopMonitoring(printerId) {
  const state = monitors.get(printerId);
  if (!state) return false;

  state.active = false;
  if (state.interval) clearInterval(state.interval);
  monitors.delete(printerId);

  console.log(`[PrintMonitor] Stopped monitoring printer ${printerId}`);
  return true;
}

/**
 * Stop all monitors
 */
function stopAll() {
  for (const [id] of monitors) stopMonitoring(id);
}

/**
 * Check if a printer is being monitored
 */
function isMonitoring(printerId) {
  return monitors.has(printerId);
}

/**
 * Get current monitor state for a printer
 */
function getMonitorState(printerId) {
  const state = monitors.get(printerId);
  if (!state) return null;
  return {
    active: state.active,
    lastAnalysis: state.lastAnalysis,
    alertHistory: state.alertHistory.slice(-20),
    analysisCount: state.analysisCount,
    consecutiveWarnings: state.consecutiveWarnings
  };
}

/**
 * Get states for all monitored printers
 */
function getAllStates() {
  const result = {};
  for (const [id] of monitors) {
    result[id] = getMonitorState(id);
  }
  return result;
}

// ==================== Analysis ====================

/**
 * Run a single analysis cycle for a printer
 */
async function runAnalysis(printerId) {
  const state = monitors.get(printerId);
  if (!state || !state.active) return;

  try {
    // Get current printer status
    const status = await state.getStatus();
    if (!status || status.state !== 'printing') {
      // Only analyze while actively printing
      return;
    }

    // Capture snapshot as base64
    const snapshotB64 = await state.getSnapshot();
    if (!snapshotB64) {
      console.log(`[PrintMonitor] No snapshot available for printer ${printerId}`);
      return;
    }

    // Build context from printer status
    const context = buildContext(status);

    // Send to Ollama vision model (GPU bridge → local fallback)
    const analysis = await analyzeWithVision(snapshotB64, context);

    _stats.totalAnalyses++;
    state.analysisCount++;
    state.lastAnalysis = {
      timestamp: Date.now(),
      source: _stats.gpuRequests > (_stats.localRequests + _stats.gpuFailovers) ? 'gpu' : 'local',
      ...analysis
    };

    // Track alert streaks
    if (analysis.severity === SEVERITY.OK) {
      state.consecutiveOk++;
      state.consecutiveWarnings = 0;
    } else {
      state.consecutiveOk = 0;
      state.consecutiveWarnings++;
    }

    // Store in history
    state.alertHistory.push({
      timestamp: Date.now(),
      severity: analysis.severity,
      summary: analysis.summary
    });
    // Keep last 50 entries
    if (state.alertHistory.length > 50) state.alertHistory.shift();

    // Notify renderer of analysis result
    if (state.onAnalysis) {
      state.onAnalysis(printerId, state.lastAnalysis);
    }

    // Fire alert callback for warnings/critical
    if (analysis.severity !== SEVERITY.OK && state.onAlert) {
      // Only alert if we've seen 2+ consecutive warnings (avoid false positives)
      if (state.consecutiveWarnings >= 2 || analysis.severity === SEVERITY.CRITICAL) {
        state.onAlert(printerId, analysis);
      }
    }

  } catch (err) {
    console.error(`[PrintMonitor] Analysis failed for printer ${printerId}:`, err.message);
  }
}

/**
 * Build context string from printer status
 */
function buildContext(status) {
  const parts = [];
  if (status.temperatures) {
    const ext = status.temperatures.extruder;
    const bed = status.temperatures.bed;
    if (ext) parts.push(`Nozzle: ${Math.round(ext.current)}°C (target ${Math.round(ext.target)}°C)`);
    if (bed) parts.push(`Bed: ${Math.round(bed.current)}°C (target ${Math.round(bed.target)}°C)`);
  }
  if (status.progress != null) parts.push(`Progress: ${Math.round(status.progress * 100)}%`);
  if (status.filename) parts.push(`File: ${status.filename}`);
  if (status.printDuration) parts.push(`Duration: ${Math.round(status.printDuration / 60)} min`);
  return parts.join('\n');
}

/**
 * Analyze a webcam snapshot with Ollama vision model
 */
async function analyzeWithVision(imageBase64, context) {
  const prompt = `You are an expert 3D print quality monitor. Analyze this webcam image of a 3D printer mid-print.

Current printer status:
${context}

Evaluate the print for these issues:
1. **Spaghetti/Failed print** — Are there strings, blobs, or tangled filament indicating a failed print?
2. **Layer adhesion** — Do layers look properly bonded or is there visible separation/warping?
3. **Stringing/Oozing** — Excessive stringing between parts suggesting temperature is too high?
4. **Under-extrusion** — Gaps in layers suggesting temperature too low or speed too fast?
5. **Warping/Lifting** — Is the print lifting from the bed?
6. **General quality** — Any other visible issues?

Respond in this EXACT JSON format (no markdown, no code fences):
{
  "severity": "ok|warning|critical",
  "summary": "One sentence overall assessment",
  "spaghetti": false,
  "spaghetti_confidence": 0.0,
  "temp_recommendation": "none|increase|decrease",
  "temp_reason": "reason or null",
  "speed_recommendation": "none|increase|decrease",
  "speed_reason": "reason or null",
  "issues": ["list of specific issues found"],
  "quality_score": 8
}

- severity: "ok" = print looks normal, "warning" = minor issues detected, "critical" = print has failed or needs immediate attention
- spaghetti_confidence: 0.0 to 1.0 confidence that spaghetti/failure is occurring
- quality_score: 1-10 (10 = perfect)
- If the image is too dark/unclear to assess, set severity to "ok" and note it in summary`;

  const payload = {
    model: LOCAL_VISION_MODEL, // overridden by failover logic
    prompt,
    images: [imageBase64],
    stream: false,
    options: {
      temperature: 0.1,
      num_predict: 500
    }
  };

  const raw = await ollamaVisionRequest(payload);

  // Parse the JSON response
  try {
    // Strip any markdown fences if model wraps them
    let cleaned = raw.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }
    const parsed = JSON.parse(cleaned);
    return {
      severity: parsed.severity || SEVERITY.OK,
      summary: parsed.summary || 'Analysis complete',
      spaghetti: !!parsed.spaghetti,
      spaghettiConfidence: parsed.spaghetti_confidence || 0,
      tempRecommendation: parsed.temp_recommendation || 'none',
      tempReason: parsed.temp_reason || null,
      speedRecommendation: parsed.speed_recommendation || 'none',
      speedReason: parsed.speed_reason || null,
      issues: parsed.issues || [],
      qualityScore: parsed.quality_score || 0
    };
  } catch (parseErr) {
    // If JSON parse fails, extract what we can from the raw text
    console.warn(`[PrintMonitor] Failed to parse Ollama JSON response, using fallback`);
    const hasSpaghetti = /spaghetti|fail|tangl/i.test(raw);
    const hasCritical = /critical|emergency|stop/i.test(raw);
    return {
      severity: hasCritical ? SEVERITY.CRITICAL : hasSpaghetti ? SEVERITY.WARNING : SEVERITY.OK,
      summary: raw.slice(0, 200),
      spaghetti: hasSpaghetti,
      spaghettiConfidence: hasSpaghetti ? 0.5 : 0,
      tempRecommendation: 'none',
      tempReason: null,
      speedRecommendation: 'none',
      speedReason: null,
      issues: [],
      qualityScore: 5,
      rawResponse: raw
    };
  }
}

// ==================== Health Check ====================

/**
 * Check if Ollama is available and has a vision model (checks both GPU bridge and local)
 */
async function checkOllamaVision() {
  const checkEndpoint = (host, port) => new Promise((resolve) => {
    const req = http.request({
      hostname: host, port, path: '/api/tags', method: 'GET', timeout: HEALTH_CHECK_TIMEOUT
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const models = parsed.models || [];
          const isVision = m => m.name.startsWith('llava') || m.name.startsWith('bakllava') || m.name.startsWith('moondream') || m.name.includes('vision');
          resolve({
            available: true,
            hasVision: models.some(isVision),
            visionModels: models.filter(isVision).map(m => m.name),
            allModels: models.map(m => m.name)
          });
        } catch (_) {
          resolve({ available: true, hasVision: false, visionModels: [], allModels: [] });
        }
      });
    });
    req.on('error', () => resolve({ available: false, hasVision: false, visionModels: [], allModels: [] }));
    req.on('timeout', () => { req.destroy(); resolve({ available: false, hasVision: false, visionModels: [], allModels: [] }); });
    req.end();
  });

  // Check GPU bridge first
  let gpuResult = { available: false, hasVision: false, visionModels: [], allModels: [] };
  if (isBridgeConfigured()) {
    gpuResult = await checkEndpoint(GPU_BRIDGE_HOST, GPU_BRIDGE_PORT);
  }

  // Check local
  const localResult = await checkEndpoint(LOCAL_HOST, LOCAL_PORT);

  return {
    gpuBridge: {
      configured: isBridgeConfigured(),
      host: GPU_BRIDGE_HOST || null,
      port: GPU_BRIDGE_PORT,
      model: GPU_BRIDGE_VISION_MODEL || null,
      ...gpuResult
    },
    local: {
      host: LOCAL_HOST,
      port: LOCAL_PORT,
      model: LOCAL_VISION_MODEL,
      ...localResult
    },
    // True if either has a vision model
    ready: gpuResult.hasVision || localResult.hasVision,
    stats: { ..._stats }
  };
}

// ==================== Snapshot Fetch ====================

/**
 * Fetch a webcam snapshot as base64 from a URL
 */
function fetchSnapshotAsBase64(snapshotUrl) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(snapshotUrl);
    const client = urlObj.protocol === 'https:' ? require('https') : http;
    const req = client.request(snapshotUrl, { timeout: SNAPSHOT_TIMEOUT_MS }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (buf.length < 1000) {
          reject(new Error('Snapshot too small — camera may be offline'));
          return;
        }
        resolve(buf.toString('base64'));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Snapshot fetch timeout')); });
    req.end();
  });
}

module.exports = {
  startMonitoring,
  stopMonitoring,
  stopAll,
  isMonitoring,
  getMonitorState,
  getAllStates,
  checkOllamaVision,
  fetchSnapshotAsBase64,
  SEVERITY
};
