#!/usr/bin/env node
/**
 * Create T-Shirt Reveal Frames using Sharp (no AI needed)
 * START: folded t-shirt hiding design
 * END: flat t-shirt showing design
 */

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const https = require('https');

// Get a test design from catalog
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

async function main() {
  const W = 480, H = 832;
  const outputDir = '/tmp/reveal-frames';
  fs.mkdirSync(outputDir, { recursive: true });

  // Download design image
  console.log('Downloading design...');
  const designBuf = await downloadImage(testDesign.image);
  fs.writeFileSync(path.join(outputDir, 'reference_design.jpg'), designBuf);
  console.log(`Design downloaded (${(designBuf.length/1024).toFixed(0)}KB)`);

  // Resize design to fit on shirt chest area (~200x200)
  const designSize = 200;
  const designResized = await sharp(designBuf)
    .resize(designSize, designSize, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
    .png()
    .toBuffer();

  // T-shirt dimensions on canvas
  const shirtW = 320, shirtH = 420;
  const shirtX = (W - shirtW) / 2; // centered
  const shirtY = 180; // offset from top

  // Design position (centered on chest area)
  const designX = Math.round((W - designSize) / 2);
  const designY = Math.round(shirtY + 100); // below neckline

  // Create wooden table background (warm brown gradient)
  const woodColor = { r: 139, g: 90, b: 43 }; // warm brown

  // --- END FRAME: flat t-shirt showing design ---
  console.log('Creating END frame (flat shirt with design)...');

  // Create SVG for t-shirt shape
  const tshirtSvg = `<svg width="${W}" height="${H}">
    <!-- Wooden table background -->
    <rect width="${W}" height="${H}" fill="rgb(${woodColor.r},${woodColor.g},${woodColor.b})"/>
    <!-- Wood grain lines -->
    <line x1="0" y1="100" x2="${W}" y2="105" stroke="rgba(0,0,0,0.08)" stroke-width="2"/>
    <line x1="0" y1="200" x2="${W}" y2="198" stroke="rgba(0,0,0,0.06)" stroke-width="1.5"/>
    <line x1="0" y1="350" x2="${W}" y2="355" stroke="rgba(0,0,0,0.07)" stroke-width="2"/>
    <line x1="0" y1="500" x2="${W}" y2="497" stroke="rgba(0,0,0,0.05)" stroke-width="1.5"/>
    <line x1="0" y1="650" x2="${W}" y2="653" stroke="rgba(0,0,0,0.06)" stroke-width="2"/>
    <line x1="0" y1="750" x2="${W}" y2="748" stroke="rgba(0,0,0,0.04)" stroke-width="1"/>
    <!-- T-shirt body -->
    <path d="
      M ${shirtX + 100} ${shirtY}
      L ${shirtX + 60} ${shirtY}
      L ${shirtX} ${shirtY + 60}
      L ${shirtX + 50} ${shirtY + 80}
      L ${shirtX + 50} ${shirtY + shirtH}
      L ${shirtX + shirtW - 50} ${shirtY + shirtH}
      L ${shirtX + shirtW - 50} ${shirtY + 80}
      L ${shirtX + shirtW} ${shirtY + 60}
      L ${shirtX + shirtW - 60} ${shirtY}
      L ${shirtX + shirtW - 100} ${shirtY}
      Q ${shirtX + shirtW/2} ${shirtY + 40} ${shirtX + 100} ${shirtY}
      Z
    " fill="white" stroke="rgba(200,200,200,0.5)" stroke-width="1"/>
    <!-- Subtle shadow -->
    <path d="
      M ${shirtX + 50} ${shirtY + shirtH}
      L ${shirtX + shirtW - 50} ${shirtY + shirtH}
      L ${shirtX + shirtW - 45} ${shirtY + shirtH + 8}
      L ${shirtX + 55} ${shirtY + shirtH + 8}
      Z
    " fill="rgba(0,0,0,0.15)"/>
  </svg>`;

  const endFrame = await sharp(Buffer.from(tshirtSvg))
    .composite([{
      input: designResized,
      left: designX,
      top: designY,
      blend: 'over'
    }])
    .png()
    .toBuffer();

  fs.writeFileSync(path.join(outputDir, 'end_frame.png'), endFrame);
  console.log(`END frame saved (${(endFrame.length/1024).toFixed(0)}KB)`);

  // --- START FRAME: folded t-shirt hiding design ---
  console.log('Creating START frame (folded shirt hiding design)...');

  // Same t-shirt but with a triangular fold covering the chest
  const foldSvg = `<svg width="${W}" height="${H}">
    <!-- Wooden table background -->
    <rect width="${W}" height="${H}" fill="rgb(${woodColor.r},${woodColor.g},${woodColor.b})"/>
    <!-- Wood grain lines -->
    <line x1="0" y1="100" x2="${W}" y2="105" stroke="rgba(0,0,0,0.08)" stroke-width="2"/>
    <line x1="0" y1="200" x2="${W}" y2="198" stroke="rgba(0,0,0,0.06)" stroke-width="1.5"/>
    <line x1="0" y1="350" x2="${W}" y2="355" stroke="rgba(0,0,0,0.07)" stroke-width="2"/>
    <line x1="0" y1="500" x2="${W}" y2="497" stroke="rgba(0,0,0,0.05)" stroke-width="1.5"/>
    <line x1="0" y1="650" x2="${W}" y2="653" stroke="rgba(0,0,0,0.06)" stroke-width="2"/>
    <line x1="0" y1="750" x2="${W}" y2="748" stroke="rgba(0,0,0,0.04)" stroke-width="1"/>
    <!-- T-shirt body -->
    <path d="
      M ${shirtX + 100} ${shirtY}
      L ${shirtX + 60} ${shirtY}
      L ${shirtX} ${shirtY + 60}
      L ${shirtX + 50} ${shirtY + 80}
      L ${shirtX + 50} ${shirtY + shirtH}
      L ${shirtX + shirtW - 50} ${shirtY + shirtH}
      L ${shirtX + shirtW - 50} ${shirtY + 80}
      L ${shirtX + shirtW} ${shirtY + 60}
      L ${shirtX + shirtW - 60} ${shirtY}
      L ${shirtX + shirtW - 100} ${shirtY}
      Q ${shirtX + shirtW/2} ${shirtY + 40} ${shirtX + 100} ${shirtY}
      Z
    " fill="white" stroke="rgba(200,200,200,0.5)" stroke-width="1"/>
    <!-- Diagonal fold: bottom-right corner folded up to top-left -->
    <!-- The fold covers the chest area where the design would be -->
    <path d="
      M ${shirtX + shirtW - 50} ${shirtY + shirtH}
      L ${shirtX + 80} ${shirtY + 60}
      L ${shirtX + shirtW - 50} ${shirtY + 80}
      Z
    " fill="rgb(245,245,245)" stroke="rgba(180,180,180,0.6)" stroke-width="1"/>
    <!-- Fold shadow line -->
    <line x1="${shirtX + 80}" y1="${shirtY + 60}" x2="${shirtX + shirtW - 50}" y2="${shirtY + shirtH}"
      stroke="rgba(0,0,0,0.1)" stroke-width="3"/>
    <!-- Subtle shadow under shirt -->
    <path d="
      M ${shirtX + 50} ${shirtY + shirtH}
      L ${shirtX + shirtW - 50} ${shirtY + shirtH}
      L ${shirtX + shirtW - 45} ${shirtY + shirtH + 8}
      L ${shirtX + 55} ${shirtY + shirtH + 8}
      Z
    " fill="rgba(0,0,0,0.15)"/>
  </svg>`;

  const startFrame = await sharp(Buffer.from(foldSvg))
    .png()
    .toBuffer();

  fs.writeFileSync(path.join(outputDir, 'start_frame.png'), startFrame);
  console.log(`START frame saved (${(startFrame.length/1024).toFixed(0)}KB)`);

  console.log(`\nFrames saved in ${outputDir}/`);
  for (const f of fs.readdirSync(outputDir)) {
    const stat = fs.statSync(path.join(outputDir, f));
    console.log(`  ${f} (${(stat.size/1024).toFixed(0)}KB)`);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
