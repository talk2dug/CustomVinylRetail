#!/usr/bin/env node
/**
 * Generate T-Shirt Reveal Video using Google Veo 2
 * Veo 2 understands physics and motion - no frame interpolation tricks needed
 */

require('dotenv').config({ path: '/home/ubuntu/vinylApp/.env' });
const fs = require('fs');
const path = require('path');
const https = require('https');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) { console.error('Missing GEMINI_API_KEY'); process.exit(1); }

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

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

function downloadUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadUrl(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function main() {
  const outputDir = '/tmp/reveal-frames';
  
  // Use the Gemini-generated end frame (flat shirt with design) as the starting image
  // We want Veo to animate FROM the folded state, so let's use the folded image
  // Actually - Veo generates video from an image, so give it the folded shirt
  // and ask it to unfold and reveal the design
  
  // First try: use the Gemini start frame (plain folded shirt from nano banana)
  // and prompt Veo to unfold it
  
  // Generate a proper folded shirt image with Gemini first
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  
  console.log('=== Generating folded shirt image with Gemini ===');
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash-image',
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
  });

  // Load the design image
  const catalogPath = '/home/ubuntu/vinylApp/web/catalog.json';
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const cats = catalog.categories || catalog;
  let testDesign = null;
  for (const cat of cats) {
    if (!cat.designs) continue;
    for (const d of cat.designs) {
      if (d.classifiedAt && d.image && d.visualDescription) { testDesign = d; break; }
    }
    if (testDesign) break;
  }
  console.log(`Design: "${testDesign.name}"`);

  // Download design
  const designBuf = await downloadUrl(testDesign.image);
  const designBase64 = designBuf.toString('base64');

  // Generate a folded shirt image where bottom half is folded up
  const foldResult = await model.generateContent([
    { inlineData: { mimeType: 'image/jpeg', data: designBase64 } },
    { text: `Generate a photorealistic product photo of a white t-shirt on a rustic wooden table, bird's eye view.

Generate a photorealistic image. DO NOT use the reference image in the output. 

A plain white t-shirt is laid completely flat on a rustic wooden table, bird eye view from above. Both sleeves are extended outward. A thick, completely opaque white rectangular card (like a blank index card or piece of cardboard) is placed on top of the chest area of the shirt. The card is plain solid white with NO printing, NO images, NO design on it whatsoever. It is just a blank white rectangle sitting on the shirt.

The card covers the center chest area. You can see the t-shirt neckline above the card, sleeves on both sides, and the bottom hem below the card.

Photorealistic, soft lighting, portrait orientation 9:16.` }
  ]);

  let foldedImageBuf = null;
  for (const candidate of foldResult.response.candidates || []) {
    for (const part of candidate.content?.parts || []) {
      if (part.inlineData && part.inlineData.mimeType?.startsWith('image/')) {
        foldedImageBuf = Buffer.from(part.inlineData.data, 'base64');
      }
    }
  }
  
  if (!foldedImageBuf) {
    console.error('Failed to generate folded shirt image');
    process.exit(1);
  }
  fs.writeFileSync(path.join(outputDir, 'folded_for_veo.png'), foldedImageBuf);
  console.log(`Folded shirt image saved (${(foldedImageBuf.length/1024).toFixed(0)}KB)`);

  // Now call Veo 2 to generate video
  console.log('\n=== Calling Veo 2 for video generation ===');
  const imageBase64 = foldedImageBuf.toString('base64');

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

  console.log('Submitting Veo 2 generation request...');
  const result = await apiRequest('/models/veo-2.0-generate-001:predictLongRunning', veoBody);
  console.log('Response status:', result.status);
  
  if (result.status !== 200) {
    console.error('Veo 2 error:', JSON.stringify(result.data, null, 2));
    process.exit(1);
  }

  const operationName = result.data.name;
  console.log('Operation:', operationName);
  console.log('Polling for completion...');

  // Poll for completion
  let done = false;
  let attempts = 0;
  while (!done && attempts < 60) {
    await new Promise(r => setTimeout(r, 10000)); // 10s between polls
    attempts++;
    
    const check = await apiGet(`/${operationName}`);
    const op = check.data;
    
    if (op.done) {
      done = true;
      console.log(`\nCompleted after ${attempts * 10}s`);
      
      if (op.error) {
        console.error('Generation failed:', JSON.stringify(op.error, null, 2));
        process.exit(1);
      }

      const videos = op.response?.generateVideoResponse?.generatedSamples || 
                     op.response?.generatedSamples || [];
      
      if (videos.length === 0) {
        console.log('Full response:', JSON.stringify(op, null, 2));
        console.error('No videos in response');
        process.exit(1);
      }

      console.log('Response keys:', JSON.stringify(Object.keys(op.response || op)));
      console.log('Video sample keys:', videos.length > 0 ? JSON.stringify(Object.keys(videos[0])) : 'none');
      if (videos.length > 0 && videos[0].video) console.log('Video obj keys:', JSON.stringify(Object.keys(videos[0].video)));
      for (let i = 0; i < videos.length; i++) {
        const video = videos[i];
        if (video.video?.uri) {
          console.log(`Downloading video ${i}...`);
          const videoUri = video.video.uri + (video.video.uri.includes('?') ? '&' : '?') + 'key=' + GEMINI_API_KEY;
          console.log('Video URI:', videoUri.substring(0, 100) + '...');
          const videoBuf = await downloadUrl(videoUri);
          const outPath = path.join(outputDir, `veo2_reveal_${i}.mp4`);
          fs.writeFileSync(outPath, videoBuf);
          console.log(`Saved: ${outPath} (${(videoBuf.length/1024).toFixed(0)}KB)`);
        } else if (video.video?.bytesBase64Encoded) {
          const videoBuf = Buffer.from(video.video.bytesBase64Encoded, 'base64');
          const outPath = path.join(outputDir, `veo2_reveal_${i}.mp4`);
          fs.writeFileSync(outPath, videoBuf);
          console.log(`Saved: ${outPath} (${(videoBuf.length/1024).toFixed(0)}KB)`);
        }
      }
    } else {
      const progress = op.metadata?.progress || '?';
      process.stdout.write(`  Polling ${attempts}... (${progress}%)\r`);
    }
  }

  if (!done) {
    console.error('Timed out after 10 minutes');
    process.exit(1);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
