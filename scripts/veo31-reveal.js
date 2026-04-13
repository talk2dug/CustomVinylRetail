#!/usr/bin/env node
/**
 * T-Shirt Reveal using Veo 3.1 First+Last Frame Interpolation
 * 1. Gemini generates START frame (shirt with card covering design)
 * 2. Gemini generates END frame (shirt with design revealed)
 * 3. Veo 3.1 interpolates between them
 */

require('dotenv').config({ path: '/home/ubuntu/vinylApp/.env' });
const { GoogleGenerativeAI } = require('@google/generative-ai');
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

async function generateGeminiImage(prompt, referenceBase64) {
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash-image',
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
  });
  const parts = [];
  if (referenceBase64) {
    parts.push({ inlineData: { mimeType: 'image/jpeg', data: referenceBase64 } });
  }
  parts.push({ text: prompt });
  const result = await model.generateContent(parts);
  for (const c of result.response.candidates || []) {
    for (const p of c.content?.parts || []) {
      if (p.inlineData && p.inlineData.mimeType?.startsWith('image/')) {
        return Buffer.from(p.inlineData.data, 'base64');
      }
    }
  }
  throw new Error('No image in Gemini response');
}

async function main() {
  const outputDir = '/tmp/reveal-pipeline';
  fs.mkdirSync(outputDir, { recursive: true });

  const designUrl = process.argv[2] || 'https://blueridgecustomco.com/library/80ssimplified/uploads/previews/heman2-1763415421278.jpg';
  const designName = process.argv[3] || 'He-Man';

  console.log(`\n=== Veo 3.1 T-Shirt Reveal ===`);
  console.log(`Design: ${designName}`);

  // Download design
  console.log('[1/4] Downloading design...');
  const designBuf = await downloadImage(designUrl);
  const designBase64 = designBuf.toString('base64');
  console.log(`  ${(designBuf.length/1024).toFixed(0)}KB`);

  // Generate START frame: shirt with opaque card covering design
  console.log('[2/4] Generating START frame (card covering design)...');
  const startBuf = await generateGeminiImage(
    `Generate a photorealistic image. DO NOT use the reference image in the output.

A plain white t-shirt is laid completely flat on a rustic wooden table, bird eye view from above. Both sleeves are extended outward. The shirt is completely blank — no design, no graphics, no print, no logos. Just a plain white t-shirt.

Photorealistic, soft lighting, portrait orientation 9:16.`,
    null  // NO reference image for start frame
  );
  fs.writeFileSync(path.join(outputDir, 'start_frame.png'), startBuf);
  console.log(`  Start frame: ${(startBuf.length/1024).toFixed(0)}KB`);

  // Generate END frame: shirt with design visible
  console.log('[3/4] Generating END frame (design revealed)...');
  const endBuf = await generateGeminiImage(
    `Generate a photorealistic product photo. A plain white t-shirt is laid completely flat on a rustic wooden table, photographed from directly above (bird's eye view). Both sleeves are fully extended outward. The design from the reference image is clearly printed/screen-printed on the center chest area of the t-shirt. The design looks naturally applied to the fabric.

The t-shirt should look identical to a flat lay product photo — same rustic wooden table, same soft lighting, same bird eye angle. Portrait orientation 9:16.`,
    designBase64
  );
  fs.writeFileSync(path.join(outputDir, 'end_frame.png'), endBuf);
  console.log(`  End frame: ${(endBuf.length/1024).toFixed(0)}KB`);

  // Veo 3.1 — first + last frame interpolation
  console.log('[4/4] Generating video (Veo 3.1 interpolation)...');
  const startBase64 = startBuf.toString('base64');
  const endBase64 = endBuf.toString('base64');

  const veoBody = {
    instances: [{
      prompt: "A design slowly appears on the blank t-shirt. Smooth, slow reveal.",
      image: { bytesBase64Encoded: startBase64, mimeType: 'image/png' },
      lastFrame: { bytesBase64Encoded: endBase64, mimeType: 'image/png' }
    }],
    parameters: {
      aspectRatio: "9:16",
      durationSeconds: 8
    }
  };

  const result = await apiRequest('/models/veo-3.1-generate-preview:predictLongRunning', veoBody);
  if (result.status !== 200) {
    console.error('Veo 3.1 error:', JSON.stringify(result.data, null, 2));
    process.exit(1);
  }

  const opName = result.data.name;
  console.log(`  Operation: ${opName}`);

  // Poll for completion
  let videos = [];
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 10000));
    const check = await apiGet(`/${opName}`);
    if (check.data.done) {
      console.log(`  Completed after ${(i+1)*10}s`);
      if (check.data.error) {
        console.error('Error:', JSON.stringify(check.data.error, null, 2));
        process.exit(1);
      }
      console.log('Full response:', JSON.stringify(check.data, null, 2).substring(0, 2000));
      videos = check.data.response?.generateVideoResponse?.generatedSamples || [];
      break;
    }
    process.stdout.write(`  Polling ${i+1}...\r`);
  }

  if (videos.length === 0) { console.error('No videos generated'); process.exit(1); }

  // Download videos
  for (let i = 0; i < videos.length; i++) {
    const uri = videos[i].video.uri + (videos[i].video.uri.includes('?') ? '&' : '?') + 'key=' + GEMINI_API_KEY;
    const buf = await downloadImage(uri);
    const outPath = `/home/ubuntu/vinylApp/web/tshirt_reveal_${designName.toLowerCase().replace(/\s+/g, '_')}_${i}.mp4`;
    fs.writeFileSync(outPath, buf);
    console.log(`  Video ${i}: ${outPath} (${(buf.length/1024).toFixed(0)}KB)`);
    console.log(`  URL: https://blueridgecustomco.com/tshirt_reveal_${designName.toLowerCase().replace(/\s+/g, '_')}_${i}.mp4`);
  }

  console.log('\nDone!');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
