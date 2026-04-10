/**
 * Remotion Render API - called from vinylApp server
 * Renders compositions to video files programmatically
 */

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const REMOTION_DIR = __dirname;
const OUT_DIR = path.join(REMOTION_DIR, 'out');
const ENTRY = path.join(REMOTION_DIR, 'src', 'index.ts');

// Ensure output dir exists
if (!fs.existsSync(OUT_DIR)) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

/**
 * Render a Remotion composition to video
 * @param {object} opts
 * @param {string} opts.compositionId - e.g. "ProductShowcase", "TikTokPromo", "StickerReveal"
 * @param {object} opts.props - Input props for the composition
 * @param {string} [opts.outputFile] - Output filename (auto-generated if not provided)
 * @param {string} [opts.codec] - Video codec, default "h264"
 * @returns {Promise<{filePath: string, durationMs: number}>}
 */
function renderVideo(opts) {
  const {
    compositionId,
    props = {},
    outputFile,
    codec = 'h264',
  } = opts;

  const filename = outputFile || `${compositionId}-${Date.now()}.mp4`;
  const outPath = path.join(OUT_DIR, filename);

  return new Promise((resolve, reject) => {
    const start = Date.now();
    const args = [
      'render',
      ENTRY,
      compositionId,
      outPath,
      '--codec', codec,
    ];

    if (Object.keys(props).length > 0) {
      args.push('--props', JSON.stringify(props));
    }

    const remotionBin = path.join(REMOTION_DIR, 'node_modules', '.bin', 'remotion');

    execFile(remotionBin, args, {
      cwd: REMOTION_DIR,
      timeout: 300000, // 5 min max
      env: { ...process.env, NODE_OPTIONS: '' },
    }, (err, stdout, stderr) => {
      if (err) {
        console.error('[remotion] render failed:', stderr);
        return reject(new Error(`Render failed: ${err.message}\n${stderr}`));
      }
      console.log('[remotion] render complete:', outPath);
      resolve({
        filePath: outPath,
        durationMs: Date.now() - start,
      });
    });
  });
}

/**
 * Render a still frame from a composition
 * @param {object} opts
 * @param {string} opts.compositionId
 * @param {object} opts.props
 * @param {number} [opts.frame] - Frame number to capture (default 0)
 * @param {string} [opts.format] - "png" or "jpeg" (default "png")
 * @param {string} [opts.outputFile]
 * @returns {Promise<{filePath: string}>}
 */
function renderStill(opts) {
  const {
    compositionId,
    props = {},
    frame = 0,
    format = 'png',
    outputFile,
  } = opts;

  const filename = outputFile || `${compositionId}-still-${Date.now()}.${format}`;
  const outPath = path.join(OUT_DIR, filename);

  return new Promise((resolve, reject) => {
    const args = [
      'still',
      ENTRY,
      compositionId,
      outPath,
      '--frame', String(frame),
      '--image-format', format,
    ];

    if (Object.keys(props).length > 0) {
      args.push('--props', JSON.stringify(props));
    }

    const remotionBin = path.join(REMOTION_DIR, 'node_modules', '.bin', 'remotion');

    execFile(remotionBin, args, {
      cwd: REMOTION_DIR,
      timeout: 60000,
      env: { ...process.env, NODE_OPTIONS: '' },
    }, (err, stdout, stderr) => {
      if (err) {
        console.error('[remotion] still render failed:', stderr);
        return reject(new Error(`Still render failed: ${err.message}\n${stderr}`));
      }
      resolve({ filePath: outPath });
    });
  });
}

module.exports = { renderVideo, renderStill, OUT_DIR };
