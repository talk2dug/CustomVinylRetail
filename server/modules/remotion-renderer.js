'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const TIKTOK_STUDIO_DIR = path.join(__dirname, '..', '..', 'tiktok-studio');
const OUTPUT_DIR = '/mnt/stlFiles/footage-library/rendered';
const RENDER_TIMEOUT = 300000; // 5 min

// Ensure output dir exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

let isRendering = false;
let currentRender = null;
const renderQueue = [];

/**
 * Write props to a temporary JSON file for Remotion CLI consumption.
 * Returns the temp file path.
 */
function writeTempProps(props) {
  const tempFile = path.join(os.tmpdir(), `remotion-props-${crypto.randomBytes(8).toString('hex')}.json`);
  fs.writeFileSync(tempFile, JSON.stringify(props, null, 2), 'utf8');
  return tempFile;
}

/**
 * Clean up a temp file, swallowing errors.
 */
function cleanupTemp(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (_) {
    // ignore cleanup errors
  }
}

/**
 * Core render function used by both renderTikTok and renderPreview.
 */
function doRender(props, outputName, extraArgs = []) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const outputPath = path.join(OUTPUT_DIR, outputName);
    let tempFile = null;

    try {
      tempFile = writeTempProps(props);
    } catch (err) {
      return resolve({ success: false, error: `Failed to write temp props: ${err.message}` });
    }

    const args = [
      'remotion', 'render', 'TikTokVideo',
      `--props=${tempFile}`,
      `--output=${outputPath}`,
      ...extraArgs,
    ];

    console.log(`[remotion-renderer] Starting render: ${outputName}`);
    console.log(`[remotion-renderer] Command: npx ${args.join(' ')}`);

    const child = spawn('npx', args, {
      cwd: TIKTOK_STUDIO_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let finished = false;

    const timeout = setTimeout(() => {
      if (!finished) {
        timedOut = true;
        child.kill('SIGKILL');
        console.error(`[remotion-renderer] Render timed out after ${RENDER_TIMEOUT}ms: ${outputName}`);
      }
    }, RENDER_TIMEOUT);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      // Log progress lines from Remotion
      const lines = text.split('\n').filter(Boolean);
      for (const line of lines) {
        console.log(`[remotion-renderer] [stdout] ${line}`);
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      const lines = text.split('\n').filter(Boolean);
      for (const line of lines) {
        console.error(`[remotion-renderer] [stderr] ${line}`);
      }
    });

    child.on('error', (err) => {
      finished = true;
      clearTimeout(timeout);
      cleanupTemp(tempFile);
      console.error(`[remotion-renderer] Spawn error: ${err.message}`);
      resolve({ success: false, error: `Spawn error: ${err.message}` });
    });

    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);

      const renderTimeMs = Date.now() - startTime;

      if (timedOut) {
        cleanupTemp(tempFile);
        return resolve({ success: false, error: `Render timed out after ${RENDER_TIMEOUT}ms` });
      }

      if (code !== 0) {
        cleanupTemp(tempFile);
        // Extract last meaningful error line from stderr
        const errLines = stderr.trim().split('\n').filter(Boolean);
        const errMsg = errLines.length > 0 ? errLines[errLines.length - 1] : `Process exited with code ${code}`;
        console.error(`[remotion-renderer] Render failed (exit ${code}): ${errMsg}`);
        return resolve({ success: false, error: errMsg });
      }

      // Success — clean up temp file
      cleanupTemp(tempFile);

      // Try to extract duration from Remotion stdout (e.g. "Duration: 15.0s")
      let duration = null;
      const durationMatch = stdout.match(/Duration[:\s]+(\d+(?:\.\d+)?)\s*s/i);
      if (durationMatch) {
        duration = parseFloat(durationMatch[1]);
      }

      console.log(`[remotion-renderer] Render complete: ${outputName} (${renderTimeMs}ms)`);

      resolve({
        success: true,
        outputPath,
        outputUrl: `/api/tiktok-studio/video/${outputName}`,
        duration,
        renderTimeMs,
      });
    });
  });
}

/**
 * Render a TikTok video at full resolution.
 * @param {Object} props - TikTok props (scenes, transitions, textOverlays, etc.)
 * @param {string} [outputName] - Output filename, defaults to tiktok-<timestamp>.mp4
 * @returns {Promise<{success: boolean, outputPath?: string, outputUrl?: string, duration?: number, renderTimeMs?: number, error?: string}>}
 */
async function renderTikTok(props, outputName) {
  const name = outputName || `tiktok-${Date.now()}.mp4`;
  return doRender(props, name);
}

/**
 * Render a preview at half resolution (540x960).
 * @param {Object} props - TikTok props
 * @returns {Promise<{success: boolean, outputPath?: string, outputUrl?: string, duration?: number, renderTimeMs?: number, error?: string}>}
 */
async function renderPreview(props) {
  const name = `preview-${Date.now()}.mp4`;
  return doRender(props, name, ['--scale=0.5']);
}

/**
 * Process the next item in the render queue.
 */
async function processQueue() {
  if (isRendering || renderQueue.length === 0) return;

  isRendering = true;
  const job = renderQueue[0];

  currentRender = {
    outputName: job.outputName,
    startedAt: new Date().toISOString(),
  };

  let result;
  try {
    if (job.isPreview) {
      result = await renderPreview(job.props);
    } else {
      result = await renderTikTok(job.props, job.outputName);
    }
  } catch (err) {
    result = { success: false, error: err.message };
  }

  // Remove completed job from queue
  renderQueue.shift();
  isRendering = false;
  currentRender = null;

  // Resolve the caller's promise
  job.resolve(result);

  // Process next in queue
  processQueue();
}

/**
 * Add a render job to the sequential queue.
 * @param {Object} props - TikTok props
 * @param {string} [outputName] - Output filename
 * @param {boolean} [isPreview=false] - Render at preview resolution
 * @returns {Promise<{success: boolean, outputPath?: string, outputUrl?: string, duration?: number, renderTimeMs?: number, error?: string}>}
 */
function queueRender(props, outputName, isPreview = false) {
  const name = isPreview
    ? `preview-${Date.now()}.mp4`
    : (outputName || `tiktok-${Date.now()}.mp4`);

  return new Promise((resolve) => {
    renderQueue.push({
      props,
      outputName: name,
      isPreview,
      resolve,
    });

    console.log(`[remotion-renderer] Queued render: ${name} (queue length: ${renderQueue.length})`);

    // Kick off processing if idle
    processQueue();
  });
}

/**
 * Get current render queue status.
 * @returns {{ isRendering: boolean, queueLength: number, currentRender: { outputName: string, startedAt: string } | null }}
 */
function getRenderStatus() {
  return {
    isRendering,
    queueLength: renderQueue.length,
    currentRender: currentRender ? { ...currentRender } : null,
  };
}

module.exports = { renderTikTok, renderPreview, queueRender, getRenderStatus };
