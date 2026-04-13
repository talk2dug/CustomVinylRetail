#!/usr/bin/env node
/**
 * Generate T-Shirt Reveal Frames using Gemini
 * START: folded shirt, design HIDDEN
 * END: flat shirt, design VISIBLE
 */

require('dotenv').config({ path: '/home/ubuntu/vinylApp/.env' });
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const https = require('https');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) { console.error('Missing GEMINI_API_KEY'); process.exit(1); }

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const catalogPath = '/home/ubuntu/vinylApp/web/catalog.json';
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
const cats = catalog.categories || catalog;
let testDesign = null;
for (const cat of cats) {
  if (!cat.designs) continue;
  for (const d of cat.designs) {
    if (d.classifiedAt && d.image && d.visualDescription) {
      testDesign = d;
      break;
    }
  }
  if (testDesign) break;
}
if (!testDesign) { console.error('No classified design found'); process.exit(1); }
console.log(`Using design: "${testDesign.name}"`);
console.log(`Image: ${testDesign.image}`);

function downloadImage(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 30000 }, (res) => {
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

async function generateImage(prompt, referenceImageBase64) {
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash-image',
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
  });

  const parts = [];
  if (referenceImageBase64) {
    parts.push({
      inlineData: { mimeType: 'image/jpeg', data: referenceImageBase64 }
    });
  }
  parts.push({ text: prompt });

  const result = await model.generateContent(parts);
  const response = result.response;

  for (const candidate of response.candidates || []) {
    for (const part of candidate.content?.parts || []) {
      if (part.inlineData && part.inlineData.mimeType?.startsWith('image/')) {
        return Buffer.from(part.inlineData.data, 'base64');
      }
    }
  }
  throw new Error('No image in response. Text: ' + (response.text?.() || 'none'));
}

async function main() {
  const outputDir = '/tmp/reveal-frames';
  fs.mkdirSync(outputDir, { recursive: true });

  console.log('\nDownloading reference design...');
  const designBuffer = await downloadImage(testDesign.image);
  const designBase64 = designBuffer.toString('base64');
  fs.writeFileSync(path.join(outputDir, 'reference_design.jpg'), designBuffer);
  console.log(`Reference saved (${(designBuffer.length / 1024).toFixed(0)}KB)`);

  // START frame: NO reference image sent — just a plain folded white tee
  console.log('\n--- Generating START frame (folded shirt, no design visible) ---');
  const startPrompt = `Generate a photorealistic product photo in portrait orientation (9:16 aspect ratio).

Scene: A plain white t-shirt lying on a rustic wooden table, photographed from directly above (bird's eye view / flat lay).

The t-shirt is folded IN HALF diagonally — the bottom-right corner has been lifted all the way up to the top-left shoulder, folding the entire front of the shirt in half along a diagonal line from bottom-left to top-right. This massive diagonal fold completely covers and hides the ENTIRE chest, stomach, and torso of the shirt. Only the sleeves and the folded-over white fabric triangle are visible. You cannot see any of the shirt's front surface at all.

CRITICAL: This is a PLAIN WHITE t-shirt with absolutely NO design, NO graphics, NO print. The shirt is completely blank. The huge diagonal fold hides everything.

Details:
- Rustic wooden table/surface background with visible wood grain
- Soft, even lighting
- The fold is a large, dramatic diagonal fold covering the whole front
- Plain white cotton t-shirt, completely blank
- No logos, no text, no graphics anywhere
- Portrait orientation (taller than wide)
- Photorealistic product photography`;

  try {
    // Don't send reference image for start frame
    const startImage = await generateImage(startPrompt, null);
    fs.writeFileSync(path.join(outputDir, 'start_frame.png'), startImage);
    console.log(`START frame saved (${(startImage.length / 1024).toFixed(0)}KB)`);
  } catch (e) {
    console.error('START frame failed:', e.message);
  }

  // END frame: send reference image, ask it to place on shirt
  console.log('\n--- Generating END frame (flat shirt with design revealed) ---');
  const endPrompt = `Generate a photorealistic product photo in portrait orientation (9:16 aspect ratio).

Scene: A plain white t-shirt lying completely flat on a rustic wooden table, photographed from directly above (bird's eye view / flat lay). The t-shirt is fully unfolded with no creases.

The attached reference image is a DESIGN/GRAPHIC. Place this exact design printed on the center chest area of the t-shirt. The design should look naturally screen-printed onto the fabric.

Details:
- Same rustic wooden table/surface background with visible wood grain
- Soft, even lighting
- T-shirt is completely flat and open, no folds at all
- The design from the reference image is clearly visible and centered on the chest
- White cotton t-shirt
- Portrait orientation (taller than wide)
- Photorealistic product photography
- Design looks naturally printed on the fabric, not pasted on`;

  try {
    const endImage = await generateImage(endPrompt, designBase64);
    fs.writeFileSync(path.join(outputDir, 'end_frame.png'), endImage);
    console.log(`END frame saved (${(endImage.length / 1024).toFixed(0)}KB)`);
  } catch (e) {
    console.error('END frame failed:', e.message);
  }

  console.log(`\nFrames saved in ${outputDir}/`);
  for (const f of fs.readdirSync(outputDir)) {
    const stat = fs.statSync(path.join(outputDir, f));
    console.log(`  ${f} (${(stat.size / 1024).toFixed(0)}KB)`);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
