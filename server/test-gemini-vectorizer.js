#!/usr/bin/env node
/**
 * Test suite for Gemini Vectorizer
 * Tests all strategies with diverse image types
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const { GeminiVectorizer } = require('./gemini-vectorizer');

const RESULTS_DIR = path.join(__dirname, 'data', 'gemini-vectorizer', 'test-results');
if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

// Test images
const STICKER_IMG = path.join(__dirname, '..', 'saved-designs', 'angel-13-2025-10-11T20-35-28-764Z.png');
const DECAL_IMG = path.join(__dirname, '..', 'saved-designs', 'foo-fighters2-2025-10-12T19-25-53-301Z.png');
const APPAREL_IMG = path.join(__dirname, '..', 'web', 'library', 'images', 'ai-generated', 'apparel-mockups',
  'tshirt-graphic-design-3rd-consecutive-a0bcfb-0.png');
const CATALOG_IMG = path.join(__dirname, '..', 'web', 'images', 'catalog', 'anime-preview-1.jpg');
const CAKE_IMG = path.join(__dirname, '..', 'saved-designs', 'cake-2025-10-11T19-44-33-531Z.png');

function saveSvgResult(name, result) {
  if (!result.svgPath) return;
  const svgFile = path.join(RESULTS_DIR, `${name}.svg`);
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${result.width}" height="${result.height}" viewBox="0 0 ${result.width} ${result.height}">
  <path d="${result.svgPath}" fill="none" stroke="red" stroke-width="2"/>
</svg>`;
  fs.writeFileSync(svgFile, svg);
  console.log(`    Saved: ${name}.svg (${result.svgPath.length} chars)`);
}

async function runTest(label, fn) {
  console.log(`\n  ${label}`);
  const start = Date.now();
  try {
    const result = await fn();
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`  ✓ ${elapsed}s — strategy=${result.strategy}, confidence=${(result.confidence || 0).toFixed(2)}`);
    return { success: true, elapsed, ...result };
  } catch (err) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`  ✗ ${elapsed}s — ${err.message.substring(0, 150)}`);
    return { success: false, elapsed, error: err.message };
  }
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║             GEMINI VECTORIZER — TEST SUITE                          ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');

  const v = new GeminiVectorizer();
  const results = {};

  // ---- TEST 1: Direct SVG on multiple images ----
  console.log('\n═══ TEST 1: Direct SVG Contour Generation ═══');

  const r1a = await runTest('Sticker (angel, RGBA 174x185)', async () => {
    const r = await v.generateContourSVG(STICKER_IMG);
    saveSvgResult('direct-svg_angel', r);
    return r;
  });
  results['direct-svg-sticker'] = r1a;

  await new Promise(r => setTimeout(r, 2000));

  const r1b = await runTest('Decal (foo-fighters, RGBA 735x735)', async () => {
    const r = await v.generateContourSVG(DECAL_IMG);
    saveSvgResult('direct-svg_foo-fighters', r);
    return r;
  });
  results['direct-svg-decal'] = r1b;

  await new Promise(r => setTimeout(r, 2000));

  const r1c = await runTest('Apparel (t-shirt graphic, RGB 1024x1024)', async () => {
    const r = await v.generateContourSVG(APPAREL_IMG);
    saveSvgResult('direct-svg_apparel', r);
    return r;
  });
  results['direct-svg-apparel'] = r1c;

  await new Promise(r => setTimeout(r, 2000));

  // ---- TEST 2: Clean Mask + Trace ----
  console.log('\n═══ TEST 2: Clean Mask + Potrace Trace ═══');

  const r2a = await runTest('Sticker (angel)', async () => {
    const r = await v.cleanAndTrace(STICKER_IMG);
    saveSvgResult('clean-trace_angel', r);
    console.log(`    Mask file: ${path.basename(r.maskPath)}`);
    return r;
  });
  results['clean-trace-sticker'] = r2a;

  await new Promise(r => setTimeout(r, 2000));

  const r2b = await runTest('Decal (foo-fighters)', async () => {
    const r = await v.cleanAndTrace(DECAL_IMG);
    saveSvgResult('clean-trace_foo-fighters', r);
    console.log(`    Mask file: ${path.basename(r.maskPath)}`);
    return r;
  });
  results['clean-trace-decal'] = r2b;

  await new Promise(r => setTimeout(r, 2000));

  // ---- TEST 3: Color Separation (2-step) ----
  console.log('\n═══ TEST 3: Color Separation for Vinyl ═══');

  const r3a = await runTest('Sticker (angel, expect 1 color)', async () => {
    const r = await v.separateColors(STICKER_IMG, { maxColors: 4 });
    for (const c of r.colors) {
      console.log(`    ${c.name} (${c.hex}): ${c.percentage}%, ${(c.svgPaths || []).length} paths`);
    }
    return r;
  });
  results['color-sep-sticker'] = r3a;

  await new Promise(r => setTimeout(r, 2000));

  const r3b = await runTest('Decal (foo-fighters, expect multi-color)', async () => {
    const r = await v.separateColors(DECAL_IMG, { maxColors: 4 });
    for (const c of r.colors) {
      console.log(`    ${c.name} (${c.hex}): ${c.percentage}%, ${(c.svgPaths || []).length} paths`);
    }
    return r;
  });
  results['color-sep-decal'] = r3b;

  await new Promise(r => setTimeout(r, 2000));

  // ---- TEST 4: Hybrid (auto fallback) ----
  console.log('\n═══ TEST 4: Hybrid Auto-Fallback ═══');

  const r4a = await runTest('Catalog image (anime JPEG, no alpha)', async () => {
    const r = await v.generateContour(CATALOG_IMG);
    saveSvgResult('hybrid_anime', r);
    return r;
  });
  results['hybrid-catalog'] = r4a;

  await new Promise(r => setTimeout(r, 2000));

  const r4b = await runTest('Cake sticker', async () => {
    const r = await v.generateContour(CAKE_IMG);
    saveSvgResult('hybrid_cake', r);
    return r;
  });
  results['hybrid-cake'] = r4b;

  // ---- SUMMARY ----
  console.log('\n\n' + '═'.repeat(70));
  console.log('SUMMARY');
  console.log('═'.repeat(70));

  let passed = 0, failed = 0;
  for (const [name, r] of Object.entries(results)) {
    const icon = r.success ? '✓' : '✗';
    if (r.success) passed++; else failed++;
    const detail = r.success
      ? `${r.elapsed}s, confidence=${(r.confidence || 0).toFixed(2)}, strategy=${r.strategy}`
      : `${r.elapsed}s, ${r.error?.substring(0, 80)}`;
    console.log(`  ${icon} ${name}: ${detail}`);
  }
  console.log(`\n  TOTAL: ${passed} passed, ${failed} failed out of ${passed + failed}`);

  // Save results
  const resultsFile = path.join(RESULTS_DIR, 'test-results.json');
  fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));

  // List output files
  const files = fs.readdirSync(RESULTS_DIR);
  console.log(`\n  Output files in ${RESULTS_DIR}:`);
  for (const f of files) {
    const sz = fs.statSync(path.join(RESULTS_DIR, f)).size;
    console.log(`    ${f} (${(sz / 1024).toFixed(1)} KB)`);
  }
}

main().catch(err => {
  console.error('\nFATAL:', err);
  process.exit(1);
});
