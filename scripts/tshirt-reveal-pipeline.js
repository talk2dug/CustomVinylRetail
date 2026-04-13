#!/usr/bin/env node
/**
 * T-Shirt Reveal Pipeline
 * 1. Gemini generates flat shirt with real design
 * 2. Sharp composites white card over design area
 * 3. Veo 2 animates card peeling off
 * 4. ffmpeg trims, adds pauses, swaps in real end frame
 */

require('dotenv').config({ path: '/home/ubuntu/vinylApp/.env' });
const { GoogleGenerativeAI } = require('@google/generative-ai');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) { console.error('Missing GEMINI_API_KEY'); process.exit(1); }

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

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

function apiRequest(endpoint, body) {
  return new Promise((resolve, reject) => {
    const url = `${BASE_URL}${endpoint}?key=${GEMINI_API_KEY}`;
    const data = JSON.stringify(body);
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch(e) { resolve({ status: res.statusCode, data: body }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function apiGet(endpoint) {
  return new Promise((resolve, reject) => {
    const url = `${BASE_URL}${endpoint}?key=${GEMINI_API_KEY}`;
    https.get(url, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch(e) { resolve({ status: res.statusCode, data: body }); }
      });
    }).on('error', reject);
  });
}

async function main() {
  const outputDir = '/tmp/reveal-pipeline';
  fs.mkdirSync(outputDir, { recursive: true });

  // Get design from CLI arg or use default
  const designUrl = process.argv[2] || 'https://blueridgecustomco.com/library/80ssimplified/uploads/previews/heman2-1763415421278.jpg';
  const designName = process.argv[3] || 'He-Man';

  console.log(`\n=== T-Shirt Reveal Pipeline ===`);
  console.log(`Design: ${designName}`);
  console.log(`URL: ${designUrl}\n`);

  // Step 1: Download design
  console.log('[1/5] Downloading design...');
  const designBuf = await downloadImage(designUrl);
  const designBase64 = designBuf.toString('base64');
  fs.writeFileSync(path.join(outputDir, 'design.jpg'), designBuf);
  console.log(`  Design: ${(designBuf.length/1024).toFixed(0)}KB`);

  // Step 2: Generate flat shirt with design using Gemini
  console.log('[2/5] Generating shirt with design (Gemini)...');
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash-image',
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
  });

  const shirtResult = await model.generateContent([
    { inlineData: { mimeType: 'image/jpeg', data: designBase64 } },
    { text: `Generate a photorealistic product photo. A plain white t-shirt is laid completely flat on a rustic wooden table, photographed from directly above (bird's eye view). Both sleeves are fully extended outward. The design from the reference image is clearly printed/screen-printed on the center chest area of the t-shirt. The design looks naturally applied to the fabric.

Photorealistic product photography, soft even lighting, portrait orientation 9:16.` }
  ]);

  let shirtBuf = null;
  for (const c of shirtResult.response.candidates || []) {
    for (const p of c.content?.parts || []) {
      if (p.inlineData && p.inlineData.mimeType?.startsWith('image/')) {
        shirtBuf = Buffer.from(p.inlineData.data, 'base64');
      }
    }
  }
  if (!shirtBuf) { console.error('Failed to generate shirt image'); process.exit(1); }
  fs.writeFileSync(path.join(outputDir, 'shirt_with_design.png'), shirtBuf);
  console.log(`  Shirt image: ${(shirtBuf.length/1024).toFixed(0)}KB`);

  // Step 3: Composite white card over the design area
  console.log('[3/5] Compositing cover card...');
  const meta = await sharp(shirtBuf).metadata();
  const W = meta.width;
  const H = meta.height;

  // Card covers the chest area — roughly center of shirt, sized proportionally
  const cardW = Math.round(W * 0.45);
  const cardH = Math.round(H * 0.35);
  const cardX = Math.round((W - cardW) / 2);
  const cardY = Math.round(H * 0.25);

  const cardSvg = `<svg width="${W}" height="${H}">
    <defs>
      <filter id="shadow" x="-2%" y="-2%" width="104%" height="104%">
        <feDropShadow dx="2" dy="2" stdDeviation="3" flood-color="rgba(0,0,0,0.15)"/>
      </filter>
    </defs>
    <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}"
      fill="white" rx="4" filter="url(#shadow)"
      stroke="rgba(220,220,220,0.5)" stroke-width="1"/>
  </svg>`;

  const coveredBuf = await sharp(shirtBuf)
    .composite([{ input: Buffer.from(cardSvg), left: 0, top: 0, blend: 'over' }])
    .png()
    .toBuffer();

  fs.writeFileSync(path.join(outputDir, 'shirt_covered.png'), coveredBuf);
  console.log(`  Covered image: ${(coveredBuf.length/1024).toFixed(0)}KB (card: ${cardW}x${cardH} at ${cardX},${cardY})`);

  // Step 4: Veo 2 — animate the card peeling off
  console.log('[4/5] Generating reveal video (Veo 2)...');
  const imageBase64 = coveredBuf.toString('base64');

  const veoBody = {
    instances: [{
      prompt: "Overhead bird eye view of a white t-shirt flat on a wooden table. A white sheet of paper covers the chest area. The paper slowly peels back from left to right, sliding off the shirt and revealing a colorful printed graphic design underneath on the chest. The paper slides smoothly to the right and off the shirt. The t-shirt stays completely still. Smooth, satisfying reveal. No hands visible. Product photography.",
      image: { bytesBase64Encoded: imageBase64, mimeType: "image/png" }
    }],
    parameters: {
      aspectRatio: "9:16",
      personGeneration: "dont_allow",
      durationSeconds: 5
    }
  };

  const result = await apiRequest('/models/veo-2.0-generate-001:predictLongRunning', veoBody);
  if (result.status !== 200) {
    console.error('Veo 2 error:', JSON.stringify(result.data, null, 2));
    process.exit(1);
  }

  const opName = result.data.name;
  console.log(`  Operation: ${opName}`);

  // Poll
  let videos = [];
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 10000));
    const check = await apiGet(`/${opName}`);
    if (check.data.done) {
      console.log(`  Completed after ${(i+1)*10}s`);
      videos = check.data.response?.generateVideoResponse?.generatedSamples || [];
      break;
    }
    process.stdout.write(`  Polling ${i+1}...\r`);
  }

  if (videos.length === 0) { console.error('No videos generated'); process.exit(1); }

  // Download best video
  const videoUri = videos[0].video.uri + (videos[0].video.uri.includes('?') ? '&' : '?') + 'key=' + GEMINI_API_KEY;
  const videoBuf = await downloadImage(videoUri);
  const rawVideoPath = path.join(outputDir, 'raw_reveal.mp4');
  fs.writeFileSync(rawVideoPath, videoBuf);
  console.log(`  Raw video: ${(videoBuf.length/1024).toFixed(0)}KB`);

  // Download second video if available
  if (videos.length > 1) {
    const videoUri2 = videos[1].video.uri + (videos[1].video.uri.includes('?') ? '&' : '?') + 'key=' + GEMINI_API_KEY;
    const videoBuf2 = await downloadImage(videoUri2);
    fs.writeFileSync(path.join(outputDir, 'raw_reveal_alt.mp4'), videoBuf2);
    console.log(`  Alt video: ${(videoBuf2.length/1024).toFixed(0)}KB`);
  }

  // Step 5: ffmpeg post-processing
  console.log('[5/5] Post-processing with ffmpeg...');
  const webDir = '/home/ubuntu/vinylApp/web';

  // Slow to 2x, trim 3s-5s (the good peel section)
  execSync(`ffmpeg -y -i ${rawVideoPath} -vf "setpts=2.0*PTS,fps=24" -pix_fmt yuv420p -an ${outputDir}/slowed.mp4`, { stdio: 'pipe' });
  execSync(`ffmpeg -y -ss 3 -to 5 -i ${outputDir}/slowed.mp4 -c:v libx264 -pix_fmt yuv420p ${outputDir}/trimmed.mp4`, { stdio: 'pipe' });

  // Use the REAL shirt-with-design as the end hold frame
  execSync(`ffmpeg -y -i ${outputDir}/trimmed.mp4 -vframes 1 ${outputDir}/first_frame.png`, { stdio: 'pipe' });

  // Create start pause (1.5s) from first frame of trimmed clip
  execSync(`ffmpeg -y -loop 1 -i ${outputDir}/first_frame.png -t 1.5 -vf "fps=24" -pix_fmt yuv420p ${outputDir}/pause_start.mp4`, { stdio: 'pipe' });

  // Create end pause (3s) from the REAL design image
  // Scale the shirt image to match video dimensions
  const trimMeta = execSync(`ffprobe -v quiet -print_format json -show_streams ${outputDir}/trimmed.mp4`).toString();
  const trimInfo = JSON.parse(trimMeta).streams[0];
  const vW = trimInfo.width;
  const vH = trimInfo.height;

  execSync(`ffmpeg -y -i ${outputDir}/shirt_with_design.png -vf "scale=${vW}:${vH}" ${outputDir}/end_frame_scaled.png`, { stdio: 'pipe' });
  execSync(`ffmpeg -y -loop 1 -i ${outputDir}/end_frame_scaled.png -t 3.0 -vf "fps=24" -pix_fmt yuv420p ${outputDir}/pause_end.mp4`, { stdio: 'pipe' });

  // Concat: start pause + peel clip + end pause (with real design)
  const concatList = `file '${outputDir}/pause_start.mp4'\nfile '${outputDir}/trimmed.mp4'\nfile '${outputDir}/pause_end.mp4'`;
  fs.writeFileSync(`${outputDir}/concat.txt`, concatList);
  execSync(`ffmpeg -y -f concat -safe 0 -i ${outputDir}/concat.txt -c copy ${webDir}/tshirt_reveal_${designName.toLowerCase().replace(/\s+/g, '_')}.mp4`, { stdio: 'pipe' });

  // Also save the raw versions for review
  execSync(`cp ${outputDir}/slowed.mp4 ${webDir}/tshirt_reveal_raw_slowed.mp4`, { stdio: 'pipe' });

  const finalPath = `${webDir}/tshirt_reveal_${designName.toLowerCase().replace(/\s+/g, '_')}.mp4`;
  const stat = fs.statSync(finalPath);
  console.log(`\n=== Done ===`);
  console.log(`Final: ${finalPath} (${(stat.size/1024).toFixed(0)}KB)`);
  console.log(`URL: https://blueridgecustomco.com/tshirt_reveal_${designName.toLowerCase().replace(/\s+/g, '_')}.mp4`);
  console.log(`\nAlso saved raw slowed version for manual trimming if needed.`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
