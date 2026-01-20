const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

async function main() {
  const tmpDir = path.join(process.cwd(), '.smoke-userdata');
  fs.mkdirSync(tmpDir, { recursive: true });
  const imagePath = path.join(tmpDir, 'ocr-sample.jpg');
  const svg = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="600" height="240"><rect x="0" y="0" width="600" height="240" fill="#ffffff"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-size="48" fill="#000000" font-family="Arial">HELLO VINYL</text></svg>`;
  await sharp(Buffer.from(svg))
    .jpeg({ quality: 90 })
    .toFile(imagePath);

  const { createWorker } = require('../print-station/node_modules/tesseract.js');
  const worker = await createWorker();
  await worker.loadLanguage('eng');
  await worker.initialize('eng');
  const { data } = await worker.recognize(imagePath);
  const text = String(data?.text || '').trim().replace(/\s+/g, ' ');
  console.log('OCR text:', text);
  await worker.terminate();
}

main().catch((err) => {
  console.error('Smoke OCR failed:', err);
  process.exit(1);
});
