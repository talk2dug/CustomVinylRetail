/**
 * Wan2GP Video Generator — VPS Integration
 *
 * Generates I2V (image-to-video) animations from catalog designs
 * using Wan2GP running on the gaming laptop GPU bridge.
 *
 * Two modes:
 * 1. Gradio API mode — call running Wan2GP web server
 * 2. Headless mode — SSH into laptop and run via --process flag
 *
 * The headless mode is more reliable for batch operations.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync, exec } = require('child_process');

// Configuration
const WAN2GP_HOST = process.env.WAN2GP_HOST || '100.64.0.13';
const WAN2GP_PORT = process.env.WAN2GP_PORT || 7860;
const WAN2GP_SSH_USER = process.env.WAN2GP_SSH_USER || 'swayze';
const WAN2GP_PATH = process.env.WAN2GP_PATH || 'C:\\Users\\swayze\\Wan2GP';
const OUTPUT_DIR = process.env.VIDEO_OUTPUT_DIR || path.join(__dirname, '..', 'web', 'videos');

/**
 * Check if Wan2GP is running and accessible
 */
async function checkHealth() {
  return new Promise((resolve) => {
    const req = http.get(`http://${WAN2GP_HOST}:${WAN2GP_PORT}/`, { timeout: 5000 }, (res) => {
      resolve({ running: res.statusCode === 200, mode: 'gradio' });
    });
    req.on('error', () => resolve({ running: false, mode: null }));
    req.on('timeout', () => { req.destroy(); resolve({ running: false, mode: null }); });
  });
}

/**
 * Download an image from URL and save locally
 */
async function downloadImage(imageUrl, destPath) {
  return new Promise((resolve, reject) => {
    const protocol = imageUrl.startsWith('https') ? https : http;
    const req = protocol.get(imageUrl, { timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadImage(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} downloading ${imageUrl}`));
      }
      const stream = fs.createWriteStream(destPath);
      res.pipe(stream);
      stream.on('finish', () => { stream.close(); resolve(destPath); });
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Download timeout')); });
  });
}

/**
 * Generate a Wan2GP settings JSON for headless mode
 */
function buildSettingsJson(options = {}) {
  const {
    prompt = 'The product gently rotates with subtle movement and a soft zoom effect.',
    imagePath = null,
    endImagePath = null,
    resolution = '480x832',
    numFrames = 41,
    guidanceScale = 5.0,
    steps = 20,
    seed = -1
  } = options;

  const [w, h] = resolution.split('x').map(Number);

  const params = {
    model_type: 'fun_inp_1.3B',
    prompt: prompt,
    negative_prompt: 'Bright tones, overexposed, static, blurry, bad quality, distorted, watermark, text',
    width: w,
    height: h,
    video_length: numFrames,
    num_inference_steps: steps,
    guidance_scale: guidanceScale,
    seed: seed,

  };

  // Attach image paths (relative to Wan2GP folder or absolute)
  if (imagePath) {
    params.image_start = imagePath;
  }
  if (endImagePath) {
    params.image_end = endImagePath;
  }

  return params;
}

/**
 * Transfer image to laptop and generate video via headless mode
 */
async function generateVideoHeadless(options = {}) {
  const {
    imageUrl,
    imagePath: localImagePath,
    prompt = 'The sticker design gently animates with a subtle 3D rotation, light reflections move across the surface.',
    resolution = '480x832',
    numFrames = 41,
    guidanceScale = 5.0,
    steps = 20,
    seed = -1,
    outputFilename = null,
    endImagePath: localEndImagePath = null,
    endImageUrl = null
  } = options;

  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const tmpDir = `/tmp/wan2gp-jobs/${jobId}`;

  try {
    fs.mkdirSync(tmpDir, { recursive: true });

    // Step 1: Get the image locally on VPS
    let localImage = localImagePath;
    if (imageUrl && !localImagePath) {
      const ext = path.extname(new URL(imageUrl).pathname) || '.png';
      localImage = path.join(tmpDir, `input${ext}`);
      console.log(`[${jobId}] Downloading image...`);
      await downloadImage(imageUrl, localImage);
    }

    if (!localImage || !fs.existsSync(localImage)) {
      throw new Error('No input image provided or file not found');
    }

    // Step 2: Upload image to laptop
    const remoteImagePath = `C:\\Users\\${WAN2GP_SSH_USER}\\Wan2GP\\inputs\\${jobId}_input.png`;
    console.log(`[${jobId}] Uploading image to laptop...`);

    // Ensure inputs dir exists
    execSync(`ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no ${WAN2GP_SSH_USER}@${WAN2GP_HOST} "if not exist ${WAN2GP_PATH}\\\\inputs mkdir ${WAN2GP_PATH}\\\\inputs"`, { timeout: 15000 });

    // SCP upload
    execSync(`scp -o ConnectTimeout=10 -o StrictHostKeyChecking=no "${localImage}" ${WAN2GP_SSH_USER}@${WAN2GP_HOST}:"${remoteImagePath}"`, { timeout: 60000 });

    // Step 2b: Upload end image if provided (for two-frame animation)
    let remoteEndImagePath = null;
    if (endImageUrl || localEndImagePath) {
      let localEndImage = localEndImagePath;
      if (endImageUrl && !localEndImagePath) {
        localEndImage = path.join(tmpDir, 'input_end.png');
        console.log(`[${jobId}] Downloading end image...`);
        await downloadImage(endImageUrl, localEndImage);
      }
      if (localEndImage && fs.existsSync(localEndImage)) {
        remoteEndImagePath = `C:\\Users\\${WAN2GP_SSH_USER}\\Wan2GP\\inputs\\${jobId}_end.png`;
        execSync(`scp -o ConnectTimeout=10 -o StrictHostKeyChecking=no "${localEndImage}" ${WAN2GP_SSH_USER}@${WAN2GP_HOST}:"${remoteEndImagePath}"`, { timeout: 60000 });
        console.log(`[${jobId}] End image uploaded`);
      }
    }

    // Step 3: Build settings JSON
    const settings = buildSettingsJson({
      prompt,
      imagePath: `inputs/${jobId}_input.png`,
      endImagePath: remoteEndImagePath ? `inputs/${jobId}_end.png` : null,
      resolution,
      numFrames,
      guidanceScale,
      steps,
      seed
    });

    const settingsPath = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    // Upload settings to laptop
    const remoteSettingsPath = `C:\\Users\\${WAN2GP_SSH_USER}\\Wan2GP\\inputs\\${jobId}_settings.json`;
    execSync(`scp -o ConnectTimeout=10 -o StrictHostKeyChecking=no "${settingsPath}" ${WAN2GP_SSH_USER}@${WAN2GP_HOST}:"${remoteSettingsPath}"`, { timeout: 15000 });

    // Step 4: Run Wan2GP in headless mode
    const remoteOutputDir = `C:\\Users\\${WAN2GP_SSH_USER}\\Wan2GP\\outputs\\${jobId}`;
    const cmd = `ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no ${WAN2GP_SSH_USER}@${WAN2GP_HOST} "cd ${WAN2GP_PATH} && if not exist outputs\\\\${jobId} mkdir outputs\\\\${jobId} && venv\\\\Scripts\\\\python.exe wgp.py --i2v-1-3B --process inputs\\\\${jobId}_settings.json --output-dir outputs\\\\${jobId} 2>&1"`;

    console.log(`[${jobId}] Starting video generation (headless mode)...`);
    console.log(`[${jobId}] Prompt: ${prompt}`);
    console.log(`[${jobId}] Resolution: ${resolution}, Frames: ${numFrames}, Steps: ${steps}`);

    const startTime = Date.now();
    const result = execSync(cmd, { timeout: 600000, maxBuffer: 10 * 1024 * 1024 }).toString();

    const elapsed = (Date.now() - startTime) / 1000;
    console.log(`[${jobId}] Generation complete in ${elapsed.toFixed(0)}s`);

    // Step 5: Download output video
    const fname = outputFilename || `${jobId}.mp4`;
    const localOutput = path.join(OUTPUT_DIR, fname);
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    // Find the generated video file
    const findCmd = `ssh -o ConnectTimeout=10 ${WAN2GP_SSH_USER}@${WAN2GP_HOST} "dir /b ${remoteOutputDir}\\\\*.mp4 2>&1"`;
    const remoteFiles = execSync(findCmd, { timeout: 15000 }).toString().trim().split('\n').filter(f => f.endsWith('.mp4'));

    if (remoteFiles.length === 0) {
      throw new Error('No output video found. Generation may have failed.\nOutput: ' + result.slice(-500));
    }

    // Copy video to home dir with safe name (avoids spaces + Windows path issues with SCP)
    const remoteSafeName = `${jobId}.mp4`;
    execSync(`ssh -o ConnectTimeout=10 ${WAN2GP_SSH_USER}@${WAN2GP_HOST} "copy \"${remoteOutputDir}\\*.mp4\" \"C:\\Users\\${WAN2GP_SSH_USER}\\${remoteSafeName}\""`, { timeout: 30000 });
    execSync(`scp -o ConnectTimeout=10 ${WAN2GP_SSH_USER}@${WAN2GP_HOST}:${remoteSafeName} "${localOutput}"`, { timeout: 120000 });
    // Clean up temp copy in home dir
    execSync(`ssh -o ConnectTimeout=10 ${WAN2GP_SSH_USER}@${WAN2GP_HOST} "del C:\\Users\\${WAN2GP_SSH_USER}\\${remoteSafeName} 2>nul"`, { timeout: 15000 });

    console.log(`[${jobId}] Video saved: ${localOutput}`);

    // Cleanup remote temp files
    const delFiles = `${remoteImagePath} ${remoteSettingsPath}${remoteEndImagePath ? ' ' + remoteEndImagePath : ''}`;
    execSync(`ssh -o ConnectTimeout=10 ${WAN2GP_SSH_USER}@${WAN2GP_HOST} "del ${delFiles} 2>nul"`, { timeout: 15000 });

    return {
      jobId,
      videoPath: localOutput,
      elapsed,
      resolution,
      numFrames,
      prompt
    };

  } catch (error) {
    console.error(`[${jobId}] Error:`, error.message);
    throw error;
  } finally {
    // Cleanup local temp
    try { fs.rmSync(tmpDir, { recursive: true }); } catch (e) {}
  }
}

/**
 * Generate video using Gradio API (when Wan2GP web UI is running)
 * Note: This is complex due to Wan2GP's 378-endpoint API.
 * Headless mode is recommended instead.
 */
async function generateVideoGradio(options = {}) {
  // Placeholder — Wan2GP's Gradio API is too complex for direct REST calls.
  // Use the gradio_client Python library or headless mode instead.
  throw new Error('Gradio API mode not implemented. Use headless mode.');
}

/**
 * Start Wan2GP on the laptop (via scheduled task)
 */
async function startWan2GP() {
  try {
    const cmd = `ssh -o ConnectTimeout=10 ${WAN2GP_SSH_USER}@${WAN2GP_HOST} "schtasks /run /tn Wan2GP 2>&1"`;
    execSync(cmd, { timeout: 15000 });
    console.log('[wan2gp] Started Wan2GP via scheduled task');

    // Wait for it to come up
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 10000));
      const health = await checkHealth();
      if (health.running) {
        console.log('[wan2gp] Wan2GP is ready');
        return true;
      }
    }
    console.warn('[wan2gp] Wan2GP did not start within 5 minutes');
    return false;
  } catch (e) {
    console.error('[wan2gp] Failed to start:', e.message);
    return false;
  }
}

/**
 * Stop Wan2GP on the laptop
 */
async function stopWan2GP() {
  try {
    execSync(`ssh -o ConnectTimeout=10 ${WAN2GP_SSH_USER}@${WAN2GP_HOST} "taskkill /im python.exe /f 2>&1"`, { timeout: 15000 });
    console.log('[wan2gp] Stopped Wan2GP');
    return true;
  } catch (e) {
    console.error('[wan2gp] Failed to stop:', e.message);
    return false;
  }
}

module.exports = {
  checkHealth,
  generateVideoHeadless,
  generateVideoGradio,
  startWan2GP,
  stopWan2GP,
  buildSettingsJson,
  downloadImage
};
