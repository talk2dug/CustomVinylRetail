/**
 * kit-resolver.js
 * Parses an Actobotics kit BOM and resolves parts against the stl_catalog DB.
 * Returns printable parts queue and hardware sourcing list.
 */

const Database = require('better-sqlite3');
const path = require('path');

// Match your existing db.js path convention
const DB_PATH = process.env.DB_PATH || '/home/ubuntu/vinylApp/server/data/store.db';

// Parts that are never worth printing — always source as hardware
const HARDWARE_KEYWORDS = [
  'screw', 'bolt', 'nut', 'locknut', 'washer', 'standoff',
  'grommet', 'bearing', 'gearmotor', 'motor', 'tire', 'battery',
  'wire', 'cable', 'switch'
];

// Material profile assignments by keyword in part name
// Used to group parts onto plates with matching print settings
const MATERIAL_PROFILES = {
  ASA_STRUCTURAL: {
    label: 'ASA – Structural',
    settings: {
      filament: 'ASA',
      nozzle_temp: 255,
      bed_temp: 100,
      layer_height: 0.2,
      perimeters: 5,
      top_bottom_layers: 6,
      infill_percent: 50,
      infill_pattern: 'gyroid',
      print_speed_perimeters: 45,
      cooling: false,
      notes: 'Enclosure recommended. Glue stick on PEI for adhesion.'
    }
  },
  TPU_FLEX: {
    label: 'TPU – Flexible',
    settings: {
      filament: 'TPU 95A',
      nozzle_temp: 230,
      bed_temp: 45,
      layer_height: 0.2,
      perimeters: 4,
      top_bottom_layers: 5,
      infill_percent: 40,
      infill_pattern: 'gyroid',
      print_speed_perimeters: 25,
      cooling: true,
      notes: 'Slow print speed critical for TPU. Direct drive preferred.'
    }
  }
};

// Keywords that suggest TPU is more appropriate
const TPU_KEYWORDS = ['tire', 'wheel', 'grip', 'pad', 'bumper', 'shock'];

/**
 * Parse the raw kit BOM text (the bullet list format)
 * Handles formats like:
 *   * (6) Revolver Wheels (82062)
 *   * (96) #6 Standard Washers     <- no part number
 */
function parseBOM(rawText) {
  const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
  const parts = [];

  for (const line of lines) {
    // Match quantity
    const qtyMatch = line.match(/\((\d+)\)/);
    const qty = qtyMatch ? parseInt(qtyMatch[1]) : 1;

    // Match part number — last parenthesized value that looks like a part number
    // Actobotics part numbers are numeric or alphanumeric like 82062, 9753K65
    const partNumMatches = [...line.matchAll(/\(([A-Z0-9]{4,})\)/g)];

    // The first match is qty, last match (if different position) is part number
    let partNumber = null;
    if (partNumMatches.length >= 2) {
      partNumber = partNumMatches[partNumMatches.length - 1][1];
    } else if (partNumMatches.length === 1 && !/^\d+$/.test(partNumMatches[0][1])) {
      // Single match that's NOT a plain integer = part number (e.g. 9753K65)
      partNumber = partNumMatches[0][1];
    } else if (partNumMatches.length === 1) {
      // Could be qty or part number — if qty already captured same value, skip
      const val = partNumMatches[0][1];
      if (val !== String(qty)) partNumber = val;
    }

    // Extract name — strip leading bullet/asterisk, strip qty and part number parens
    let name = line
      .replace(/^\*\s*/, '')
      .replace(/\(\d+\)\s*/, '')         // remove qty
      .replace(/\([A-Z0-9]{4,}\)\s*$/, '') // remove trailing part number
      .trim();

    parts.push({ qty, name, partNumber });
  }

  return parts;
}

/**
 * Determine if a part should always be sourced as hardware
 */
function isHardware(part) {
  const nameLower = part.name.toLowerCase();
  return HARDWARE_KEYWORDS.some(kw => nameLower.includes(kw));
}

/**
 * Determine material profile for a part
 */
function getMaterialProfile(part) {
  const nameLower = part.name.toLowerCase();
  if (TPU_KEYWORDS.some(kw => nameLower.includes(kw))) {
    return 'TPU_FLEX';
  }
  return 'ASA_STRUCTURAL';
}

/**
 * Query stl_catalog for a part number
 * File names are part numbers, so we search by filename stem
 */
function lookupPart(db, partNumber) {
  // Try exact filename match (with or without extension)
  const row = db.prepare(`
    SELECT * FROM stl_catalog 
    WHERE filename = ? 
       OR filename = ? 
       OR filename LIKE ?
    LIMIT 1
  `).get(
    partNumber,
    `${partNumber}.stl`,
    `${partNumber}%`
  );
  return row || null;
}

/**
 * Main resolver function
 * @param {string} rawBOM - Raw text of the kit parts list
 * @returns {{ printQueue: Array, hardwareList: Array, notFound: Array }}
 */
function resolveKit(rawBOM) {
  const db = new Database(DB_PATH, { readonly: true });

  const parts = parseBOM(rawBOM);
  const printQueue = [];
  const hardwareList = [];
  const notFound = [];

  for (const part of parts) {
    // No part number = skip (per your preference)
    if (!part.partNumber) {
      hardwareList.push({
        ...part,
        reason: 'no_part_number'
      });
      continue;
    }

    // Known hardware categories = source list
    if (isHardware(part)) {
      hardwareList.push({
        ...part,
        reason: 'hardware'
      });
      continue;
    }

    // Query the catalog
    const catalogEntry = lookupPart(db, part.partNumber);

    if (!catalogEntry) {
      notFound.push({
        ...part,
        reason: 'not_in_catalog'
      });
      continue;
    }

    const materialKey = getMaterialProfile(part);

    printQueue.push({
      partNumber: part.partNumber,
      name: part.name,
      qty: part.qty,
      stlPath: catalogEntry.filepath || catalogEntry.path || catalogEntry.stl_path,
      catalogEntry,
      materialProfile: materialKey,
      materialSettings: MATERIAL_PROFILES[materialKey]
    });
  }

  db.close();

  return { printQueue, hardwareList, notFound };
}

module.exports = { resolveKit, parseBOM, MATERIAL_PROFILES };
