/**
 * Shared Ollama Client with GPU Bridge Failover
 *
 * Provides generate() and chat() methods that:
 * 1. Try remote GPU bridge first (if configured)
 * 2. Fall back to local Ollama on failure
 * 3. Cache health checks for 30 seconds
 * 4. Log which source served each request
 */

const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');

// Load .env if not already loaded
const envPath = path.resolve(__dirname, '..', '..', '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
}

// Configuration
const LOCAL_HOST = '127.0.0.1';
const LOCAL_PORT = 11434;
const LOCAL_MODEL = 'llama3.1:8b';

const GPU_BRIDGE_HOST = process.env.GPU_BRIDGE_HOST || '';
const GPU_BRIDGE_PORT = parseInt(process.env.GPU_BRIDGE_PORT, 10) || 11434;
const GPU_BRIDGE_MODEL = process.env.GPU_BRIDGE_MODEL || '';

// Health check cache
let _healthCache = { healthy: false, checkedAt: 0, error: null };
const HEALTH_CACHE_TTL = 30000; // 30 seconds
const HEALTH_CHECK_TIMEOUT = 2000; // 2 seconds

// Stats
let _stats = {
  gpuRequests: 0,
  localRequests: 0,
  gpuFailovers: 0,
  lastGpuRequest: null,
  lastLocalRequest: null,
  startedAt: new Date().toISOString()
};

/**
 * Check if GPU bridge is configured
 */
function isConfigured() {
  return !!GPU_BRIDGE_HOST;
}

/**
 * Health check the remote GPU bridge via GET /api/tags
 * Results cached for 30 seconds
 */
async function checkRemoteHealth() {
  if (!isConfigured()) return false;

  const now = Date.now();
  if (now - _healthCache.checkedAt < HEALTH_CACHE_TTL) {
    return _healthCache.healthy;
  }

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
        res.on('end', () => {
          resolve(res.statusCode === 200);
        });
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    });

    _healthCache = { healthy, checkedAt: now, error: null };
    return healthy;
  } catch (e) {
    _healthCache = { healthy: false, checkedAt: now, error: e.message };
    return false;
  }
}

/**
 * Make an HTTP request to an Ollama endpoint
 */
function ollamaRequest(host, port, apiPath, postData, timeout) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: host,
      port: port,
      path: apiPath,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: timeout
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch (e) {
          reject(new Error(`Failed to parse Ollama response: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Ollama request timeout')); });
    req.write(JSON.stringify(postData));
    req.end();
  });
}

/**
 * Generate text using /api/generate with failover
 *
 * @param {string} prompt - The prompt text
 * @param {object} options - { temperature, maxTokens, timeout, model }
 * @returns {string} The generated response text
 */
async function generate(prompt, options = {}) {
  const timeout = options.timeout || 180000;
  const temperature = options.temperature || 0.7;
  const maxTokens = options.maxTokens || 800;

  const buildPayload = (model) => ({
    model,
    prompt,
    stream: false,
    options: { temperature, num_predict: maxTokens }
  });

  // Try GPU bridge first
  if (isConfigured()) {
    const remoteHealthy = await checkRemoteHealth();
    if (remoteHealthy) {
      try {
        const model = GPU_BRIDGE_MODEL || LOCAL_MODEL;
        const result = await ollamaRequest(GPU_BRIDGE_HOST, GPU_BRIDGE_PORT, '/api/generate', buildPayload(model), timeout);
        _stats.gpuRequests++;
        _stats.lastGpuRequest = new Date().toISOString();
        console.log(`[gpu-bridge] generate served by remote GPU (${GPU_BRIDGE_HOST})`);
        return result.response || '';
      } catch (e) {
        console.warn(`[gpu-bridge] Remote GPU failed, falling back to local: ${e.message}`);
        _stats.gpuFailovers++;
        // Invalidate health cache on request failure
        _healthCache = { healthy: false, checkedAt: Date.now(), error: e.message };
      }
    }
  }

  // Fallback to local
  try {
    const result = await ollamaRequest(LOCAL_HOST, LOCAL_PORT, '/api/generate', buildPayload(LOCAL_MODEL), timeout);
    _stats.localRequests++;
    _stats.lastLocalRequest = new Date().toISOString();
    console.log(`[local] generate served by local CPU Ollama`);
    return result.response || '';
  } catch (e) {
    throw new Error(`Ollama generate failed (both remote and local): ${e.message}`);
  }
}

/**
 * Chat using /api/chat with failover
 *
 * @param {Array} messages - Array of { role, content } message objects
 * @param {object} options - { temperature, model, timeout }
 * @returns {string} The assistant's response content
 */
async function chat(messages, options = {}) {
  const timeout = options.timeout || 180000;
  const temperature = options.temperature || 0.7;

  const buildPayload = (model) => ({
    model,
    messages,
    stream: false,
    options: { temperature }
  });

  // Try GPU bridge first
  if (isConfigured()) {
    const remoteHealthy = await checkRemoteHealth();
    if (remoteHealthy) {
      try {
        const model = GPU_BRIDGE_MODEL || options.model || LOCAL_MODEL;
        const result = await ollamaRequest(GPU_BRIDGE_HOST, GPU_BRIDGE_PORT, '/api/chat', buildPayload(model), timeout);
        _stats.gpuRequests++;
        _stats.lastGpuRequest = new Date().toISOString();
        console.log(`[gpu-bridge] chat served by remote GPU (${GPU_BRIDGE_HOST})`);
        return result.message?.content || '';
      } catch (e) {
        console.warn(`[gpu-bridge] Remote GPU chat failed, falling back to local: ${e.message}`);
        _stats.gpuFailovers++;
        _healthCache = { healthy: false, checkedAt: Date.now(), error: e.message };
      }
    }
  }

  // Fallback to local
  try {
    const model = options.model || LOCAL_MODEL;
    const result = await ollamaRequest(LOCAL_HOST, LOCAL_PORT, '/api/chat', buildPayload(model), timeout);
    _stats.localRequests++;
    _stats.lastLocalRequest = new Date().toISOString();
    console.log(`[local] chat served by local CPU Ollama`);
    return result.message?.content || '';
  } catch (e) {
    throw new Error(`Ollama chat failed (both remote and local): ${e.message}`);
  }
}


/**
 * Vision analysis using /api/generate with images (LLaVA) with failover
 *
 * @param {string} prompt - The prompt describing what to analyze
 * @param {string[]} imagesBase64 - Array of base64-encoded image strings
 * @param {object} options - { model, temperature, maxTokens, timeout }
 * @returns {string} The vision model response text
 */
async function vision(prompt, imagesBase64, options = {}) {
  const timeout = options.timeout || 120000;
  const temperature = options.temperature || 0.3;
  const maxTokens = options.maxTokens || 500;
  const visionModel = options.model || 'llava:13b';

  const buildPayload = (model) => ({
    model,
    prompt,
    images: imagesBase64,
    stream: false,
    options: { temperature, num_predict: maxTokens }
  });

  // Try GPU bridge first
  if (isConfigured()) {
    const remoteHealthy = await checkRemoteHealth();
    if (remoteHealthy) {
      try {
        const result = await ollamaRequest(GPU_BRIDGE_HOST, GPU_BRIDGE_PORT, '/api/generate', buildPayload(visionModel), timeout);
        _stats.gpuRequests++;
        _stats.lastGpuRequest = new Date().toISOString();
        console.log('[gpu-bridge] vision served by remote GPU (' + GPU_BRIDGE_HOST + '), model: ' + visionModel);
        return result.response || '';
      } catch (e) {
        console.warn('[gpu-bridge] Remote GPU vision failed, falling back to local: ' + e.message);
        _stats.gpuFailovers++;
        _healthCache = { healthy: false, checkedAt: Date.now(), error: e.message };
      }
    }
  }

  // Fallback to local
  try {
    const result = await ollamaRequest(LOCAL_HOST, LOCAL_PORT, '/api/generate', buildPayload(visionModel), timeout);
    _stats.localRequests++;
    _stats.lastLocalRequest = new Date().toISOString();
    console.log('[local] vision served by local CPU Ollama, model: ' + visionModel);
    return result.response || '';
  } catch (e) {
    throw new Error('Ollama vision failed (both remote and local): ' + e.message);
  }
}

/**
 * Get status info for monitoring
 */
function getStatus() {
  return {
    configured: isConfigured(),
    remote: {
      host: GPU_BRIDGE_HOST || null,
      port: GPU_BRIDGE_PORT,
      model: GPU_BRIDGE_MODEL || null,
      healthy: _healthCache.healthy,
      lastCheck: _healthCache.checkedAt ? new Date(_healthCache.checkedAt).toISOString() : null,
      lastError: _healthCache.error
    },
    local: {
      host: LOCAL_HOST,
      port: LOCAL_PORT,
      model: LOCAL_MODEL
    },
    stats: { ..._stats }
  };
}

module.exports = { generate, chat, vision, getStatus, isConfigured, checkRemoteHealth };
