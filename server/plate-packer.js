'use strict';
/**
 * plate-packer.js — Bin-packing for 3D print plates
 *
 * Groups quote items by material, then packs them onto bed-sized plates
 * using a simple row-packing strategy. Each item's footprint is estimated
 * from its STL catalog dimensions (mu_width × mu_height in 40mm grid units)
 * or falls back to a default 80×80mm footprint.
 */

const MU_MM = 40; // one multiboard unit in mm
const DEFAULT_FOOTPRINT_MM = 80; // fallback footprint for unknown parts

/**
 * Bed sizes (usable area, mm) for each printer model.
 * Add more models here as needed.
 */
const BED_SIZES = {
  ke:     { w: 220, h: 220 },
  s1pro:  { w: 256, h: 256 },
  default:{ w: 220, h: 220 }
};

/**
 * Estimate the footprint of one STL item in mm.
 * If the catalog row has mu_width / mu_height, use those × MU_MM.
 * Otherwise fall back to DEFAULT_FOOTPRINT_MM.
 *
 * @param {object} item - print_quote_items row (may have stl_catalog_row attached)
 * @returns {{ w: number, h: number }}
 */
function itemFootprint(item) {
  const row = item._stlRow || {};
  const w = row.mu_width  ? row.mu_width  * MU_MM : DEFAULT_FOOTPRINT_MM;
  const h = row.mu_height ? row.mu_height * MU_MM : DEFAULT_FOOTPRINT_MM;
  return { w, h };
}

/**
 * Pack a list of items (each with a qty and footprint) onto plates of the
 * given bed size. Returns an array of plates, each being an array of
 * { item, qty } objects that fit on one bed.
 *
 * Strategy: Row-based packing.
 *   - Sort items by height DESC (tallest first) to reduce wasted space.
 *   - Start a new row when current item doesn't fit horizontally.
 *   - Start a new plate when current row doesn't fit vertically.
 *
 * @param {object[]} items - quote items to pack (each expanded for qty)
 * @param {{ w: number, h: number }} bed - bed dimensions
 * @param {number} margin - gap between items (mm)
 * @returns {Array<Array<{ item: object, instance: number }>>}
 */
function rowPack(items, bed, margin = 5) {
  // Expand items by quantity into individual instances
  const instances = [];
  for (const item of items) {
    const fp = itemFootprint(item);
    for (let i = 0; i < item.qty; i++) {
      instances.push({ item, instance: i, fp });
    }
  }

  // Sort tallest-first
  instances.sort((a, b) => b.fp.h - a.fp.h);

  const plates = [];
  let plate = [];
  let curX = 0;
  let curY = 0;
  let rowHeight = 0;

  function newPlate() {
    if (plate.length > 0) plates.push(plate);
    plate = [];
    curX = 0;
    curY = 0;
    rowHeight = 0;
  }

  for (const inst of instances) {
    const fw = inst.fp.w + margin;
    const fh = inst.fp.h + margin;

    // Item too wide for any row — just place it alone on its own plate
    if (fw > bed.w + margin) {
      newPlate();
      plate.push(inst);
      newPlate();
      continue;
    }

    // Does it fit in the current row?
    if (curX + fw <= bed.w + margin) {
      // It fits horizontally — check vertical space
      if (curY + fh > bed.h + margin) {
        // Doesn't fit vertically — new plate
        newPlate();
      }
      plate.push(inst);
      curX += fw;
      rowHeight = Math.max(rowHeight, fh);
    } else {
      // Start a new row
      curY += rowHeight;
      curX = 0;
      rowHeight = 0;

      if (curY + fh > bed.h + margin) {
        // New plate
        newPlate();
      }
      plate.push(inst);
      curX += fw;
      rowHeight = fh;
    }
  }

  if (plate.length > 0) plates.push(plate);
  return plates;
}

/**
 * Pack a list of print_quote_items onto plates, grouped by material.
 *
 * @param {object[]} items - rows from print_quote_items (with optional _stlRow attached)
 * @param {object} options
 * @param {string} [options.printerModel='default'] - key into BED_SIZES
 * @param {number} [options.margin=5] - gap between items in mm
 * @returns {object[]} Array of plate descriptors:
 *   { material, plate_index, items: [{ item_id, stl_catalog_id, name, qty_on_plate, instance }] }
 */
function packQuoteItems(items, { printerModel = 'default', margin = 5 } = {}) {
  const bed = BED_SIZES[printerModel] || BED_SIZES.default;

  // Group by material
  const byMaterial = {};
  for (const item of items) {
    if (item.missing_stl) continue; // skip items without STL — can't slice
    const mat = (item.material || 'PLA').toUpperCase();
    if (!byMaterial[mat]) byMaterial[mat] = [];
    byMaterial[mat].push(item);
  }

  const plates = [];
  let globalPlateIndex = 0;

  for (const [material, matItems] of Object.entries(byMaterial)) {
    const packedPlates = rowPack(matItems, bed, margin);
    for (const plateFill of packedPlates) {
      // Aggregate instances back into { item_id, qty_on_plate } groups
      const slotMap = new Map();
      for (const inst of plateFill) {
        const key = inst.item.id;
        if (!slotMap.has(key)) {
          slotMap.set(key, {
            item_id: inst.item.id,
            stl_catalog_id: inst.item.stl_catalog_id || null,
            name: inst.item.name,
            qty_on_plate: 0
          });
        }
        slotMap.get(key).qty_on_plate++;
      }

      plates.push({
        material,
        plate_index: globalPlateIndex++,
        items: [...slotMap.values()],
        stl_item_ids: plateFill.map(inst => inst.item.id)
      });
    }
  }

  return plates;
}

module.exports = { packQuoteItems, BED_SIZES, itemFootprint };
