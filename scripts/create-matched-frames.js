#!/usr/bin/env node
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

async function main() {
  const outputDir = '/tmp/reveal-frames';
  const endFramePath = path.join(outputDir, 'end_frame.png');
  
  const metadata = await sharp(endFramePath).metadata();
  const W = metadata.width;
  const H = metadata.height;
  console.log(`End frame: ${W}x${H}`);

  // Fold: entire bottom half folded UP, covering the chest/design area
  // The fold line is horizontal across the middle of the shirt
  // Everything below the fold line is flipped up, showing plain white fabric
  
  // The shirt occupies roughly 10-88% width, 8-85% height in the Gemini image
  // Fold line at about 45% height - covers the design which is centered around 40-55%
  const foldY = Math.round(H * 0.30); // fold line position
  const shirtLeft = Math.round(W * 0.08);
  const shirtRight = Math.round(W * 0.92);
  const shirtBottom = Math.round(H * 0.85);

  const foldSvg = `<svg width="${W}" height="${H}">
    <defs>
      <filter id="shadow" x="-5%" y="-5%" width="110%" height="110%">
        <feDropShadow dx="0" dy="-3" stdDeviation="4" flood-color="rgba(0,0,0,0.12)"/>
      </filter>
      <linearGradient id="foldGrad" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0%" stop-color="rgb(245,245,245)"/>
        <stop offset="30%" stop-color="rgb(252,252,252)"/>
        <stop offset="100%" stop-color="rgb(255,255,255)"/>
      </linearGradient>
    </defs>
    <!-- Folded bottom half - rectangle from fold line down to shirt bottom -->
    <rect 
      x="${shirtLeft}" y="${foldY}" 
      width="${shirtRight - shirtLeft}" height="${shirtBottom - foldY}"
      fill="url(#foldGrad)"
      filter="url(#shadow)"
      rx="3"
    />
    <!-- Fold crease line -->
    <line 
      x1="${shirtLeft}" y1="${foldY}" 
      x2="${shirtRight}" y2="${foldY}" 
      stroke="rgba(0,0,0,0.08)" stroke-width="2"
    />
  </svg>`;

  const foldOverlay = await sharp(Buffer.from(foldSvg)).png().toBuffer();

  const startFrame = await sharp(endFramePath)
    .composite([{ input: foldOverlay, left: 0, top: 0, blend: 'over' }])
    .png()
    .toBuffer();

  fs.writeFileSync(path.join(outputDir, 'start_frame_matched.png'), startFrame);
  console.log(`START frame saved (${(startFrame.length / 1024).toFixed(0)}KB)`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
