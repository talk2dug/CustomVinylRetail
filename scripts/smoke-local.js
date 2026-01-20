const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { LocalCatalogDB } = require('../print-station/src/local-db');

async function main() {
  const tmpDir = path.join(process.cwd(), '.smoke-userdata');
  fs.mkdirSync(tmpDir, { recursive: true });
  const app = { getPath: (name) => tmpDir };

  // Create sample SVG
  const svgPath = path.join(tmpDir, 'sample.svg');
  const svg = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect x="0" y="0" width="512" height="512" fill="#111827"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-size="48" fill="#22d3ee" font-family="Arial">SMOKE</text></svg>`;
  fs.writeFileSync(svgPath, svg, 'utf8');

  // Rasterize with sharp (tests libvips + sharp install)
  const outJpg = path.join(tmpDir, 'sample.jpg');
  await sharp(Buffer.from(svg))
    .resize({ width: 800, height: 800, fit: 'inside' })
    .jpeg({ quality: 80 })
    .toFile(outJpg);
  const size = fs.statSync(outJpg).size;

  // Test SQLite via LocalCatalogDB
  const db = new LocalCatalogDB(app);
  const rec = db.upsert({
    path: svgPath,
    category: 'Test',
    title: 'Smoke Test',
    file_type: 'svg',
    size
  });
  const list = db.list({ status: 'all', limit: 10 });
  console.log('Local DB upsert OK:', !!rec?.id, 'List count:', list.length);
}

main().catch((err) => {
  console.error('Smoke test failed:', err);
  process.exit(1);
});

