#!/usr/bin/env node
/**
 * T-Shirt Reveal Video Generator — Chained Gemini Frame Generation
 * Blue Ridge Custom Co — TikTok Content Pipeline
 *
 * Generates progressive unfolding frames using Gemini image generation,
 * then stitches them into a TikTok-ready vertical video.
 *
 * Usage:
 *   node tshirt-reveal-chained.js <design-image-url> [output-name]
 */

require('dotenv').config({ path: '/home/ubuntu/vinylApp/.env' });
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execSync } = require('child_process');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) { console.error('Missing GEMINI_API_KEY'); process.exit(1); }

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// ─── CONFIG ─────────────────────────────────────────────────────────────────

const FPS = 8;
const FRAME_DELAY_MS = 2500;  // rate limit buffer between API calls
const OUTPUT_DIR = '/tmp/reveal-chained';
const WEB_DIR = '/home/ubuntu/vinylApp/web';

// ─── HELPERS ────────────────────────────────────────────────────────────────

function downloadImage(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : require('http');
    mod.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadImage(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── PROMPTS ────────────────────────────────────────────────────────────────
//
// Identical camera/scene description across ALL frames for consistency.
// The graphic is referenced only as "the design from the reference image"
// — never described by content.

const BASE_SETUP =
  'Shot directly overhead, perfectly flat lay, centered on a clean rustic wooden table surface. ' +
  'Bright, even studio lighting, no shadows, no perspective distortion. ' +
  'Hands visible at edges only when unfolding. ' +
  'Photorealistic product photography style. ' +
  'Vertical frame, portrait orientation. ';

const FRAME_HOLD = 1.0;  // seconds each frame is held (slower reveal)

function buildPrompts() {
  // Hex ID for the design — keeps it anonymous
  const hexId = crypto.randomBytes(4).toString('hex').toUpperCase();

  return [
    // Frame 0 — fully folded, design completely hidden
    {
      prompt: BASE_SETUP +
        'A white t-shirt sits neatly folded into a compact rectangle in the center of the frame. ' +
        'The shirt is folded tightly — sleeves tucked in, body folded in thirds. ' +
        'No graphic is visible. The shirt looks like a retail store fold.',
      useReference: false,
    },

    // Frame 1 — hands just arriving
    {
      prompt: BASE_SETUP +
        'A white t-shirt sits neatly folded into a compact rectangle on the table. ' +
        'Two hands enter from the sides and are reaching toward the folded shirt, ' +
        'fingertips just touching the top fold. The shirt is still fully folded. No graphic visible.',
      useReference: false,
    },

    // Frame 2 — top fold being lifted
    {
      prompt: BASE_SETUP +
        'A white t-shirt is beginning to be unfolded. Two hands have just ' +
        'started opening the top fold of the shirt. The shirt is still mostly compact but the top ' +
        'layer is being lifted and pulled apart. No graphic visible yet.',
      useReference: false,
    },

    // Frame 3 — top open, sleeves starting to spread
    {
      prompt: BASE_SETUP +
        'A white t-shirt is being unfolded. The top fold has been opened revealing the neckline ' +
        'and upper chest area. The sleeves are starting to be pulled outward. ' +
        'The shirt is still partially folded in the lower half. No graphic visible yet — ' +
        'the design area is still covered by the remaining folds.',
      useReference: false,
    },

    // Frame 4 — halfway unfolded, design peeking
    {
      prompt: BASE_SETUP +
        'A white t-shirt is halfway unfolded. The sleeves have been spread outward and the shirt ' +
        'body is partially open. The graphic on the chest is just beginning to peek through the ' +
        'center fold — a hint of the design is visible but not fully revealed. ' +
        `The graphic is the design from the reference image (product SKU ${hexId}).`,
      useReference: true,
    },

    // Frame 5 — mostly open, design mostly visible
    {
      prompt: BASE_SETUP +
        'A white t-shirt is mostly unfolded on the table. The sleeves are extended outward. ' +
        'The chest graphic is about three-quarters visible — the top and middle of the design ' +
        'can be seen clearly but the very bottom is still hidden under a small remaining fold. ' +
        `The design from the reference image (product SKU ${hexId}) on the chest is becoming clear.`,
      useReference: true,
    },

    // Frame 6 — almost fully open
    {
      prompt: BASE_SETUP +
        'A white t-shirt is almost completely unfolded and laid flat. The sleeves are fully ' +
        'extended. The chest graphic is mostly visible but the bottom hem still has a slight fold. ' +
        `The design from the reference image (product SKU ${hexId}) on the chest is clearly visible and centered.`,
      useReference: true,
    },

    // Frame 7 — fully open, full reveal (money shot)
    {
      prompt: BASE_SETUP +
        'A white t-shirt lies completely flat and fully unfolded, perfectly centered. ' +
        'Both sleeves are extended. The shirt is smooth with no folds. ' +
        `The design from the reference image (product SKU ${hexId}) graphic is fully revealed on the chest, ` +
        'centered and sharp. This is the money shot — the full product reveal.',
      useReference: true,
    },
  ];
}

// ─── FRAME GENERATION ───────────────────────────────────────────────────────

async function generateFrame(prompt, useReference, designBase64, frameIndex) {
  console.log(`\n[Frame ${frameIndex}] Generating...`);
  console.log(`  Prompt: ${prompt.substring(0, 80)}...`);
  console.log(`  Reference image: ${useReference ? 'YES' : 'no'}`);

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash-image',
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
  });

  const parts = [];

  if (useReference && designBase64) {
    parts.push({
      inlineData: { mimeType: 'image/jpeg', data: designBase64 }
    });
  }

  parts.push({ text: prompt });

  const result = await model.generateContent(parts);

  for (const c of result.response.candidates || []) {
    for (const p of c.content?.parts || []) {
      if (p.inlineData && p.inlineData.mimeType?.startsWith('image/')) {
        const buf = Buffer.from(p.inlineData.data, 'base64');
        const framePath = path.join(OUTPUT_DIR, `frame_${String(frameIndex).padStart(2, '0')}.png`);
        fs.writeFileSync(framePath, buf);
        console.log(`  Saved: ${framePath} (${(buf.length / 1024).toFixed(0)}KB)`);
        return framePath;
      }
    }
  }

  // If no image, log what we got
  const text = result.response.text?.() || '';
  throw new Error(`No image in response for frame ${frameIndex}. Text: ${text.substring(0, 200)}`);
}

// ─── VIDEO STITCHING ────────────────────────────────────────────────────────

function stitchVideo(framePaths, outputPath) {
  const crossfadeDuration = 0.8;  // seconds of crossfade between frames
  const holdDuration = 3.0;       // hold final reveal
  const frameDuration = FRAME_HOLD + crossfadeDuration; // total each frame is on screen

  console.log(`\n[Video] Stitching ${framePaths.length} frames with ${crossfadeDuration}s crossfades...`);

  // Scale all frames to 1080x1920 first
  const scaledPaths = [];
  for (let i = 0; i < framePaths.length; i++) {
    const scaled = path.join(OUTPUT_DIR, `scaled_${String(i).padStart(2, '0')}.png`);
    execSync(
      `ffmpeg -y -i "${framePaths[i]}" -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2" "${scaled}"`,
      { stdio: 'pipe' }
    );
    scaledPaths.push(scaled);
  }

  // Build a complex ffmpeg filter with xfade crossfades between each pair
  // Each frame is a static image looped for frameDuration
  let inputs = '';
  let filterParts = [];
  const n = scaledPaths.length;

  for (let i = 0; i < n; i++) {
    const isLast = i === n - 1;
    const dur = isLast ? holdDuration : frameDuration;
    inputs += ` -loop 1 -t ${dur} -i "${scaledPaths[i]}"`;
  }

  // Chain xfade filters: [0][1] -> [v01], [v01][2] -> [v012], etc.
  let prevLabel = '0:v';
  let offset = frameDuration - crossfadeDuration;  // first crossfade starts here

  for (let i = 1; i < n; i++) {
    const outLabel = i < n - 1 ? `v${i}` : 'vout';
    filterParts.push(
      `[${prevLabel}][${i}:v]xfade=transition=fade:duration=${crossfadeDuration}:offset=${offset.toFixed(2)}[${outLabel}]`
    );
    prevLabel = outLabel;
    // Next offset: previous offset + (next frame's visible time minus crossfade overlap)
    const nextDur = (i === n - 1) ? holdDuration : frameDuration;
    offset += nextDur - crossfadeDuration;
  }

  const filter = filterParts.join(';');
  const cmd = `ffmpeg -y${inputs} -filter_complex "${filter}" -map "[vout]" -r 24 -pix_fmt yuv420p -c:v libx264 "${outputPath}"`;

  execSync(cmd, { stdio: 'pipe' });

  const stat = fs.statSync(outputPath);
  const totalDur = offset + crossfadeDuration;  // approximate
  console.log(`  Saved: ${outputPath} (${(stat.size / 1024).toFixed(0)}KB)`);
  console.log(`  Duration: ~${totalDur.toFixed(1)}s`);
}

// ─── MAIN ───────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const designUrl = process.argv[2];
  const outputName = process.argv[3] || 'reveal';

  if (!designUrl) {
    console.error('Usage: node tshirt-reveal-chained.js <design-image-url> [output-name]');
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log('  BRCC T-Shirt Reveal Generator');
  console.log(`  Design: ${designUrl.split('/').pop()}`);
  console.log(`  Frames: 8`);
  console.log('='.repeat(60));

  // Download design image
  console.log('\n[Setup] Downloading design image...');
  const designBuf = await downloadImage(designUrl);
  const designBase64 = designBuf.toString('base64');
  fs.writeFileSync(path.join(OUTPUT_DIR, 'design_reference.jpg'), designBuf);
  console.log(`  Design: ${(designBuf.length / 1024).toFixed(0)}KB`);

  // Build prompts
  const prompts = buildPrompts();

  // Generate frames
  const framePaths = [];

  for (let i = 0; i < prompts.length; i++) {
    try {
      const framePath = await generateFrame(
        prompts[i].prompt,
        prompts[i].useReference,
        designBase64,
        i
      );
      framePaths.push(framePath);
    } catch (e) {
      console.error(`  Frame ${i} failed: ${e.message}`);
      // Continue with remaining frames
    }

    // Rate limit buffer
    if (i < prompts.length - 1) {
      console.log(`  Waiting ${FRAME_DELAY_MS / 1000}s...`);
      await sleep(FRAME_DELAY_MS);
    }
  }

  if (framePaths.length < 3) {
    console.error('\nToo few frames generated. Aborting.');
    process.exit(1);
  }

  // Stitch video
  const outputPath = path.join(WEB_DIR, `tshirt_reveal_${outputName}.mp4`);
  stitchVideo(framePaths, outputPath);

  console.log('\n' + '='.repeat(60));
  console.log('  Done!');
  console.log(`  ${outputPath}`);
  console.log(`  https://blueridgecustomco.com/tshirt_reveal_${outputName}.mp4`);
  console.log('='.repeat(60));
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
