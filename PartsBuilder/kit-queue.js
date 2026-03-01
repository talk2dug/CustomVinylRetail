#!/usr/bin/env node
/**
 * kit-queue.js
 * CLI entry point for resolving a kit BOM into print plates.
 *
 * Usage:
 *   node kit-queue.js --kit "Actobotics Rover" --bom ./rover-bom.txt
 *   node kit-queue.js --kit "Actobotics Rover" --bom ./rover-bom.txt --output ./output/
 *   node kit-queue.js --kit "Actobotics Rover" --bom ./rover-bom.txt --copy-stls
 *
 * Options:
 *   --kit       Kit name (used in plate IDs and output filenames)
 *   --bom       Path to BOM text file (the bullet list format)
 *   --output    Output directory for manifests (default: ./kit-output/)
 *   --copy-stls Copy STL files into output/<kit>/stls/ folder
 *   --dry-run   Parse and resolve but don't write files
 */

const fs = require('fs');
const path = require('path');
const { resolveKit } = require('./kit-resolver');
const { buildPlates, summarizePlates } = require('./plate-builder');

// ── Argument parsing ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (flag) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
};
const hasFlag = (flag) => args.includes(flag);

const kitName = getArg('--kit') || 'Kit';
const bomPath = getArg('--bom');
const outputDir = getArg('--output') || './kit-output';
const copyStls = hasFlag('--copy-stls');
const dryRun = hasFlag('--dry-run');

if (!bomPath) {
  console.error('❌  --bom <path> is required');
  process.exit(1);
}

if (!fs.existsSync(bomPath)) {
  console.error(`❌  BOM file not found: ${bomPath}`);
  process.exit(1);
}

// ── Main ──────────────────────────────────────────────────────────────────────
const rawBOM = fs.readFileSync(bomPath, 'utf8');

console.log(`\n🔧  Resolving kit: ${kitName}`);
console.log(`📄  BOM: ${bomPath}\n`);

const { printQueue, hardwareList, notFound } = resolveKit(rawBOM);

// ── Results summary ───────────────────────────────────────────────────────────
console.log(`✅  Printable parts found:    ${printQueue.length} types`);
console.log(`🔩  Hardware to source:        ${hardwareList.length} types`);
if (notFound.length > 0) {
  console.log(`⚠️   Not found in catalog:     ${notFound.length} types`);
}

// ── Build plates ──────────────────────────────────────────────────────────────
const plates = buildPlates(printQueue, kitName);
const summary = summarizePlates(plates);

console.log(`\n🖨️   Plates generated: ${summary.totalPlates}`);
console.log(`     Total part instances: ${summary.totalParts}`);
for (const [mat, data] of Object.entries(summary.byMaterial)) {
  console.log(`     ${mat}: ${data.plates} plate(s), ${data.parts} part(s)`);
}

if (dryRun) {
  console.log('\n🏃  Dry run — no files written.\n');
  process.exit(0);
}

// ── Write output ──────────────────────────────────────────────────────────────
const kitSlug = kitName.replace(/\s+/g, '_');
const kitOutputDir = path.join(outputDir, kitSlug);
const stlOutputDir = path.join(kitOutputDir, 'stls');

fs.mkdirSync(kitOutputDir, { recursive: true });
if (copyStls) fs.mkdirSync(stlOutputDir, { recursive: true });

// Write plate manifests (one JSON per plate)
for (const plate of plates) {
  const plateFile = path.join(kitOutputDir, `${plate.plateId}.json`);
  fs.writeFileSync(plateFile, JSON.stringify(plate, null, 2));
  console.log(`\n📦  ${plate.plateId}`);
  console.log(`     Material: ${plate.materialLabel}`);
  console.log(`     Parts: ${plate.parts.map(p => p.instanceLabel).join(', ')}`);
  console.log(`     → ${plateFile}`);
}

// Write full print queue JSON
const queueFile = path.join(kitOutputDir, `${kitSlug}_print_queue.json`);
fs.writeFileSync(queueFile, JSON.stringify({
  kitName,
  generatedAt: new Date().toISOString(),
  summary,
  plates,
  hardwareList,
  notFound
}, null, 2));
console.log(`\n📋  Full queue: ${queueFile}`);

// Write hardware sourcing list (human readable)
if (hardwareList.length > 0) {
  const hwLines = ['HARDWARE TO SOURCE', '==================', ''];
  for (const item of hardwareList) {
    const pn = item.partNumber ? ` (${item.partNumber})` : ' [no part number]';
    hwLines.push(`  x${item.qty}  ${item.name}${pn}`);
  }
  const hwFile = path.join(kitOutputDir, `${kitSlug}_hardware.txt`);
  fs.writeFileSync(hwFile, hwLines.join('\n'));
  console.log(`🔩  Hardware list: ${hwFile}`);
}

// Write not-found list
if (notFound.length > 0) {
  const nfLines = ['PARTS NOT FOUND IN CATALOG', '==========================', ''];
  for (const item of notFound) {
    nfLines.push(`  x${item.qty}  ${item.name} (${item.partNumber})`);
  }
  const nfFile = path.join(kitOutputDir, `${kitSlug}_not_found.txt`);
  fs.writeFileSync(nfFile, nfLines.join('\n'));
  console.log(`⚠️   Not found: ${nfFile}`);
}

// Optionally copy STL files
if (copyStls) {
  console.log('\n📂  Copying STL files...');
  let copied = 0;
  for (const item of printQueue) {
    if (item.stlPath && fs.existsSync(item.stlPath)) {
      const dest = path.join(stlOutputDir, path.basename(item.stlPath));
      fs.copyFileSync(item.stlPath, dest);
      copied++;
    }
  }
  console.log(`     Copied ${copied}/${printQueue.length} STL files → ${stlOutputDir}`);
}

console.log('\n✅  Done.\n');
