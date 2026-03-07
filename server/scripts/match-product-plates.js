#!/usr/bin/env node
/**
 * Match Multiboard Product Kits to STL Parts & Auto-Pack into Build Plates
 *
 * For each base product kit:
 *   1. Matches "whats_included" items to actual STL parts in the catalog
 *   2. Resolves hardware dependencies (snaps, bolts, brackets, wall mounts)
 *   3. Packs into build plates using plate-packer
 *   4. Flags tile plates as "stacked" for correct slicer settings
 *
 * Usage: node server/scripts/match-product-plates.js [--dry-run]
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const db = require('../db');
db.initDatabase();
const { packQuoteItems, BED_SIZES } = require('../plate-packer');
const { resolvePartDependencies } = require('../multiboard-dependency-recipes');

const DRY_RUN = process.argv.includes('--dry-run');

// ============================================================================
// Hardware ID → STL Catalog ID mapping
// Maps symbolic recipe partIds to actual STL catalog entries
// ============================================================================

const HARDWARE_MAP = {
  'flush-snap':            5865,  // Multiboard Flush Snap
  'locking-bolt':          5856,  // Folded Locking Bolt
  'wall-mount':            3768,  // SS Multipoint Plate   Screw On Mount (2x2 MU)
  'bolt-locked-bracket':   5932,  // 2x2 MU Bracket   Bolt Locked Inserts
  'shelf-support-bracket': 5967,  // 2 CU   Bolt Locked Shelf Support Bracket
  'heavy-hook-snap':       5949,  // Raised Heavy Weight Bearing Hook Snap
  'drawer-shell':          6116,  // 1x1x1 LU   Topped Rail   MultiBin Shell
  'rail-popin':            3763,  // Bolt Locked Insert   OI Rail Pop In
  'drawer-stopper-pin':    7412,  // Drawer Stopper   Outer Corner Pin
  'moderate-snap':         5865,  // Use flush snap as fallback
  'multipoint-connector':  3752,  // 2L Bolt Locked Insert   Multipoint Rail
  'bracket-multipoint':    3752,  // Same as multipoint connector
  'ds-snap-a':             5822,  // 12.5 mm   Dual Offset Snaps (DS Part A)
  'ds-snap-b':             7381,  // DS Snaps   Grip Removal Tool
};

// ============================================================================
// Product Kit Part Definitions
// Each kit maps to specific STL parts with quantities
// ============================================================================

const PRODUCT_KITS = {
  'mb-desk-starter': {
    name: 'Desk Starter Kit',
    parts: [
      { role: 'tile', qty: 16, desc: '4x4 wall tile grid', prefer: 'core' },
      { role: 'hook', qty: 2, desc: 'pen/pencil holders', prefer: 'push fit' },
      { role: 'snap', qty: 4, desc: 'cable management clips', prefer: 'clip' },
      { role: 'shelf', qty: 1, desc: 'small shelf', prefer: '2x1' },
    ]
  },
  'mb-kitchen-command': {
    name: 'Kitchen Command Kit',
    parts: [
      { role: 'tile', qty: 24, desc: '6x4 wall tile grid', prefer: 'core' },
      { role: 'hook', qty: 4, desc: 'utensil hooks', prefer: 'push fit' },
      { role: 'shelf', qty: 1, desc: 'spice rack shelf', prefer: '2x2' },
      { role: 'peg', qty: 1, desc: 'towel bar', prefer: '150 mm' },
      { role: 'bin', qty: 2, desc: 'small bins', prefer: '1 LU' },
    ]
  },
  'mb-craft-maker': {
    name: 'Craft & Maker Kit',
    parts: [
      { role: 'tile', qty: 32, desc: '8x4 wall tile grid', prefer: 'core' },
      { role: 'bin', qty: 4, desc: 'deep storage bins', prefer: '2' },
      { role: 'hook', qty: 6, desc: 'tool hooks assorted', prefer: 'push fit' },
      { role: 'label', qty: 2, desc: 'label holder strips', prefer: '2 CU' },
      { role: 'mount', qty: 1, desc: 'tape dispenser mount', prefer: 'mount' },
    ]
  },
  'mb-garage-workshop': {
    name: 'Garage / Workshop Starter',
    parts: [
      { role: 'tile', qty: 48, desc: '8x6 wall tile grid', prefer: 'core' },
      { role: 'hook', qty: 8, desc: 'heavy-duty hooks assorted', prefer: 'bolt locked' },
      { role: 'bin', qty: 4, desc: 'large storage bins', prefer: '2' },
      { role: 'drawer', qty: 1, desc: 'drawer unit', prefer: '1x1' },
      { role: 'label', qty: 2, desc: 'label holder strips', prefer: '2 CU' },
    ]
  }
};

// ============================================================================
// STL Matching
// ============================================================================

function findBestMatch(role, prefer, allParts) {
  let candidates = allParts.filter(p => p.mb_type === role);

  if (candidates.length === 0) {
    candidates = allParts.filter(p =>
      p.name.toLowerCase().includes(role)
    );
  }

  if (candidates.length === 0) return null;

  const preferLower = (prefer || '').toLowerCase();
  const scored = candidates.map(c => {
    let score = 0;
    const nameLower = c.name.toLowerCase();

    if (preferLower && nameLower.includes(preferLower)) score += 10;

    const maxDim = Math.max(c.mu_width || 1, c.mu_height || 1) * 40;
    if (maxDim <= 80) score += 10;
    else if (maxDim <= 120) score += 5;
    else if (maxDim <= 160) score += 1;
    else score -= 5;

    if (nameLower.includes('multiboard')) score += 3;
    if (nameLower.includes('simple')) score += 2;
    if (nameLower.includes('test') || nameLower.includes('prototype')) score -= 5;

    return { part: c, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.part || null;
}

// ============================================================================
// Hardware Resolution
// ============================================================================

function resolveHardware(matchedPart, partSpec, allParts) {
  // Build a recipe-engine-compatible part object
  const recipePart = {
    name: matchedPart.name,
    _mbType: partSpec.role,
    _mountType: matchedPart.mount_type || '',
    gridWidth: matchedPart.mu_width || 2,
    gridHeight: matchedPart.mu_height || 2,
    attachesTo: matchedPart.mount_type === 'snap' ? 'multihole' : ''
  };

  const deps = resolvePartDependencies(recipePart);
  const hardware = [];

  for (const hw of deps.requiresHardware) {
    const stlId = HARDWARE_MAP[hw.partId];
    if (!stlId) {
      console.log(`    ⚠ Unknown hardware "${hw.partId}" — skipping`);
      continue;
    }
    const stlPart = allParts.find(p => p.id === stlId);
    if (!stlPart) {
      console.log(`    ⚠ Hardware STL ID ${stlId} not found for "${hw.partId}"`);
      continue;
    }
    // Multiply hardware qty by the number of this part in the kit
    hardware.push({
      stl_catalog_id: stlId,
      name: stlPart.name,
      qty: hw.qty * partSpec.qty,
      role: 'hardware',
      forPart: hw.partId,
      _stlRow: stlPart
    });
  }

  return hardware;
}

// ============================================================================
// Main
// ============================================================================

function main() {
  console.log('=== Matching Product Kits to STL Parts ===\n');

  const allParts = db.getDb().prepare(
    "SELECT * FROM stl_catalog WHERE mb_type IS NOT NULL AND mb_type != '' ORDER BY name"
  ).all();
  console.log(`Loaded ${allParts.length} classified STL parts\n`);

  for (const [productId, kit] of Object.entries(PRODUCT_KITS)) {
    console.log(`\n--- ${kit.name} (${productId}) ---`);

    if (!DRY_RUN) {
      db.deleteProductBuildPlates(productId);
    }

    // Match each part and resolve hardware
    const mainItems = [];
    const hardwareItems = [];
    const tileItems = []; // separate for stacking

    for (const partSpec of kit.parts) {
      const match = findBestMatch(partSpec.role, partSpec.prefer, allParts);
      if (match) {
        console.log(`  ✓ ${partSpec.desc} (×${partSpec.qty}) → ${match.name} [ID: ${match.id}]`);

        const item = {
          id: `match_${productId}_${partSpec.role}_${mainItems.length}`,
          stl_catalog_id: match.id,
          name: match.name,
          qty: partSpec.qty,
          material: 'PLA',
          _stlRow: match
        };

        if (partSpec.role === 'tile') {
          tileItems.push(item);
        } else {
          mainItems.push(item);
        }

        // Resolve hardware dependencies
        const hw = resolveHardware(match, partSpec, allParts);
        for (const h of hw) {
          console.log(`    + ${h.name} ×${h.qty} (${h.forPart})`);
          // Merge with existing hardware of same ID
          const existing = hardwareItems.find(e => e.stl_catalog_id === h.stl_catalog_id);
          if (existing) {
            existing.qty += h.qty;
          } else {
            hardwareItems.push({
              id: `hw_${productId}_${h.forPart}_${hardwareItems.length}`,
              stl_catalog_id: h.stl_catalog_id,
              name: h.name,
              qty: h.qty,
              material: 'PLA',
              _stlRow: h._stlRow
            });
          }
        }
      } else {
        console.log(`  ✗ ${partSpec.desc} (×${partSpec.qty}) → NO MATCH (${partSpec.role})`);
      }
    }

    // Summary
    console.log(`\n  Parts: ${mainItems.length + tileItems.length} matched, Hardware: ${hardwareItems.length} types`);
    if (hardwareItems.length > 0) {
      console.log('  Hardware totals:');
      for (const h of hardwareItems) {
        console.log(`    ${h.name} ×${h.qty}`);
      }
    }

    // ── TILE PLATES (stacked) ──
    // Tiles are identical, so we stack them. At 2×2 MU (80mm), we fit 4 per layer.
    // Stack height depends on bed Z, but typically 10-15 tiles stacked.
    // For now, group tiles into plates of 4 (one layer) and mark as stacked.
    let plateIndex = 0;

    if (tileItems.length > 0) {
      const tile = tileItems[0]; // all tiles are the same part
      const totalTiles = tile.qty;
      const tilesPerLayer = 4; // 2×2 tiles at 80mm each on a 220mm bed (2×2 grid)
      const stackHeight = 8;   // stack 8 tiles per position (reasonable for adhesion)
      const tilesPerPlate = tilesPerLayer * stackHeight; // 32 tiles per plate
      const tilePlates = Math.ceil(totalTiles / tilesPerPlate);

      console.log(`\n  Tile plates: ${totalTiles} tiles → ${tilePlates} plate(s) (${tilesPerLayer}/layer × ${stackHeight} stacked)`);

      let remaining = totalTiles;
      for (let i = 0; i < tilePlates; i++) {
        const qtyThisPlate = Math.min(remaining, tilesPerPlate);
        remaining -= qtyThisPlate;
        const plateName = `${kit.name} - Tiles ${i + 1}/${tilePlates} (STACKED)`;

        console.log(`    Tile Plate ${i + 1}: ${qtyThisPlate} tiles (${tilesPerLayer} positions × ${Math.ceil(qtyThisPlate / tilesPerLayer)} stacks)`);

        if (!DRY_RUN) {
          db.createProductBuildPlate({
            product_id: productId,
            plate_index: plateIndex++,
            name: plateName,
            items: [{
              stl_catalog_id: tile.stl_catalog_id,
              name: tile.name,
              qty: qtyThisPlate
            }],
            material: 'PLA',
            printer_model: 'kobra3',
            settings: JSON.stringify({
              stacked: true,
              stack_height: stackHeight,
              positions_per_layer: tilesPerLayer,
              slicer_overrides: {
                // Stacked tiles need different settings
                first_layer_height: '0.3',
                layer_height: '0.2',
                perimeters: 3,
                top_solid_layers: 4,
                bottom_solid_layers: 3,
                fill_density: '15%',
                // Reduced speed for stacked parts
                perimeter_speed: 60,
                infill_speed: 80,
                // Object-by-object printing for stacks
                complete_objects: 1,
                extruder_clearance_height: 40,
                extruder_clearance_radius: 40
              }
            })
          });
        }
      }
    }

    // ── MAIN PARTS PLATES (accessories) ──
    if (mainItems.length > 0) {
      const plates = packQuoteItems(mainItems, { printerModel: 'kobra3', margin: 5 });
      console.log(`\n  Accessory plates: ${plates.length}`);

      for (let i = 0; i < plates.length; i++) {
        const plate = plates[i];
        const itemSummary = plate.items.map(it => `${it.name} ×${it.qty_on_plate}`).join(', ');
        const plateName = `${kit.name} - Parts ${i + 1}/${plates.length}`;

        console.log(`    Parts Plate ${i + 1}: ${itemSummary}`);

        if (!DRY_RUN) {
          db.createProductBuildPlate({
            product_id: productId,
            plate_index: plateIndex++,
            name: plateName,
            items: plate.items.map(it => ({
              stl_catalog_id: it.stl_catalog_id,
              name: it.name,
              qty: it.qty_on_plate
            })),
            material: plate.material,
            printer_model: 'kobra3'
          });
        }
      }
    }

    // ── HARDWARE PLATES (stacked where possible) ──
    if (hardwareItems.length > 0) {
      console.log(`\n  Hardware plates:`);

      // For each hardware type, calculate how many fit per bed layer,
      // then stack identical items to reduce plate count
      for (const hw of hardwareItems) {
        const row = hw._stlRow || {};
        const fw = (row.mu_width || 1) * 40;
        const fh = (row.mu_height || 1) * 40;
        const bed = BED_SIZES.kobra3;
        const margin = 3;
        const perRow = Math.floor((bed.w + margin) / (fw + margin));
        const rows = Math.floor((bed.h + margin) / (fh + margin));
        const perLayer = Math.max(1, perRow * rows);

        // Stack small hardware (< 80mm in any dimension)
        const canStack = Math.max(fw, fh) <= 80;
        const stackHeight = canStack ? 10 : 1;
        const perPlate = perLayer * stackHeight;
        const numPlates = Math.ceil(hw.qty / perPlate);

        let remaining = hw.qty;
        for (let i = 0; i < numPlates; i++) {
          const qtyThisPlate = Math.min(remaining, perPlate);
          remaining -= qtyThisPlate;
          const plateName = `${kit.name} - HW: ${hw.name.split('  ')[0]}${canStack ? ' (STACKED)' : ''} ${i + 1}/${numPlates}`;

          console.log(`    ${plateName}: ×${qtyThisPlate} (${perLayer}/layer${canStack ? ' × ' + stackHeight + ' stacks' : ''})`);

          if (!DRY_RUN) {
            db.createProductBuildPlate({
              product_id: productId,
              plate_index: plateIndex++,
              name: plateName,
              items: [{
                stl_catalog_id: hw.stl_catalog_id,
                name: hw.name,
                qty: qtyThisPlate,
                role: 'hardware'
              }],
              material: 'PLA',
              printer_model: 'kobra3',
              settings: JSON.stringify({
                hardware_plate: true,
                stacked: canStack,
                stack_height: canStack ? stackHeight : 1,
                positions_per_layer: perLayer,
                slicer_overrides: canStack ? {
                  layer_height: '0.2',
                  perimeters: 2,
                  fill_density: '20%',
                  complete_objects: 1,
                  extruder_clearance_height: 30,
                  extruder_clearance_radius: 30
                } : {
                  layer_height: '0.2',
                  perimeters: 2,
                  fill_density: '20%',
                  perimeter_speed: 80,
                  infill_speed: 120
                }
              })
            });
          }
        }
      }
    }

    console.log(`\n  Total plates for ${kit.name}: ${plateIndex}`);
  }

  console.log('\n=== Done ===');

  if (!DRY_RUN) {
    const allPlates = db.listProductBuildPlates();
    console.log(`\nVerification: ${allPlates.length} product build plates in database`);
    for (const p of allPlates) {
      const items = JSON.parse(p.items || '[]');
      const settings = JSON.parse(p.settings || '{}');
      const totalQty = items.reduce((sum, it) => sum + (it.qty || 0), 0);
      const flags = [];
      if (settings.stacked) flags.push('STACKED');
      if (settings.hardware_plate) flags.push('HW');
      const flagStr = flags.length ? ` [${flags.join(',')}]` : '';
      console.log(`  [${p.product_id}] ${p.name} — ${totalQty} items, ${p.material}${flagStr}`);
    }
  }
}

main();
