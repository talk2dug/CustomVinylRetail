const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

async function computePhash(filePath) {
  const image = sharp(filePath).grayscale().resize(8, 8, { fit: 'fill' });
  const { data } = await image.raw().toBuffer({ resolveWithObject: true });
  let sum = 0; for (let i = 0; i < data.length; i++) sum += data[i];
  const avg = sum / data.length;
  let bits = '';
  for (let i = 0; i < data.length; i++) bits += data[i] > avg ? '1' : '0';
  let hex = '';
  for (let i = 0; i < 64; i += 4) { hex += parseInt(bits.slice(i, i + 4), 2).toString(16); }
  return hex;
}

function hammingHex(a, b) {
  const x = BigInt('0x' + a) ^ BigInt('0x' + b);
  let count = 0n; let y = x; while (y) { y &= y - 1n; count++; }
  return Number(count);
}

async function main() {
  const tmp = path.join(process.cwd(), '.smoke-userdata');
  fs.mkdirSync(tmp, { recursive: true });
  const baseSvg = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="300" height="180"><rect width="300" height="180" fill="#fff"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-size="40" fill="#000">HELLO</text></svg>`;
  const varSvg  = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="300" height="180"><rect width="300" height="180" fill="#fff"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-size="42" fill="#000">HELLO!</text></svg>`;
  const a = path.join(tmp, 'a.jpg');
  const b = path.join(tmp, 'b.jpg');
  await sharp(Buffer.from(baseSvg)).jpeg({ quality: 92 }).toFile(a);
  await sharp(Buffer.from(varSvg)).jpeg({ quality: 92 }).toFile(b);
  const ha = await computePhash(a); const hb = await computePhash(b);
  const d = hammingHex(ha, hb);
  console.log('pHash a:', ha, 'b:', hb, 'distance:', d);
  process.exit(d <= 10 ? 0 : 1);
}

main().catch((e) => { console.error('smoke-phash failed:', e); process.exit(1); });

