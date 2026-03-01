/**
 * Multiboard Part Description Parser
 *
 * Extracts from a part's description text:
 *   - mount_type     (snap | magnet | screw | rail | pegboard | unknown)
 *   - mount_hardware (JSON — magnets size/qty, screw specs, etc.)
 *   - requires_tray  (boolean)
 *   - tray_size      (e.g. "2x4" if detectable)
 *   - tray_notes     (raw text hint about tray requirement)
 *
 * Usage:
 *   const { parsePart } = require('./multiboard-part-parser');
 *   const result = parsePart(item.name, item.description);
 *   // result: { mount_type, mount_hardware, requires_tray, tray_size, tray_notes }
 */

// ─────────────────────────────────────────────────────────────────────────────
// PARSER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize text for matching — lowercase, collapse whitespace
 */
function normalize(text) {
  if (!text) return '';
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Parse mount type from description + filename
 * Returns: 'snap' | 'magnet' | 'screw' | 'rail' | 'pegboard' | 'unknown'
 */
function parseMountType(name, description) {
  const text = normalize(`${name} ${description}`);

  // Magnet — check first, magnet parts sometimes also mention snaps for the tile
  if (
    text.includes('magnet') ||
    text.includes('magnetic')
  ) return 'magnet';

  // Screw / bolt mount
  if (
    text.match(/m[2345]\s*(screw|bolt|insert|hex)/) ||
    text.match(/m[2345]\s*x\s*\d/) ||
    text.includes('heat set') ||
    text.includes('heatset') ||
    text.includes('threaded insert') ||
    text.includes('bolt mount') ||
    text.includes('screw mount')
  ) return 'screw';

  // Rail / T-slot / slide
  if (
    text.includes('rail') ||
    text.includes('t-slot') ||
    text.includes('tslot') ||
    text.includes('slide-in') ||
    text.includes('slides into')
  ) return 'rail';

  // Pegboard adapter
  if (
    text.includes('pegboard') ||
    text.includes('peg board')
  ) return 'pegboard';

  // Snap — most common, covers direct snap-in to tile holes
  if (
    text.includes('snap') ||
    text.includes('press fit') ||
    text.includes('press-fit') ||
    text.includes('clicks into') ||
    text.includes('snaps into') ||
    text.includes('snaps onto') ||
    text.includes('plug into') ||
    text.includes('fits into tile') ||
    text.includes('attaches to tile') ||
    text.includes('mounts to tile') ||
    text.includes('multiboard tile') ||
    text.includes('directly to the board') ||
    text.includes('directly to board')
  ) return 'snap';

  return 'unknown';
}

/**
 * Parse hardware requirements from description
 * Returns array of hardware objects or null
 *
 * Examples detected:
 *   "4x 20x3mm magnets"   → { type: 'magnet', size: '20x3mm', qty: 4 }
 *   "2x M3x8 screws"      → { type: 'screw', spec: 'M3x8', qty: 2 }
 *   "M4 heat set inserts"  → { type: 'insert', spec: 'M4', qty: null }
 */
function parseMountHardware(description) {
  const text = normalize(description);
  const hardware = [];

  // ── Magnets ──
  // Patterns: "4x 20x3mm magnets", "20x3 magnets x4", "requires 6mm x 2mm disc magnets"
  const magnetPatterns = [
    /(\d+)\s*[x×]\s*(\d+\s*[x×]\s*\d+\s*mm)\s*magnets?/g,  // 4x 20x3mm magnets
    /(\d+\s*[x×]\s*\d+\s*mm)\s*magnets?\s*[x×]?\s*(\d+)/g,  // 20x3mm magnets x4
    /(\d+)\s*magnets?\s*[\(,]?\s*(\d+\s*[x×]\s*\d+\s*mm)/g, // 4 magnets (20x3mm)
    /magnet[s]?\s*:\s*(\d+\s*[x×]\s*\d+\s*mm)/g,             // magnets: 20x3mm
    /(\d+)\s*[x×]\s*(\d+mm\s*[x×]\s*\d+mm)/g,                // 4x 20mm x 3mm
  ];

  for (const pattern of magnetPatterns) {
    let match;
    const src = normalize(description);
    while ((match = pattern.exec(src)) !== null) {
      // Figure out which group is qty vs size
      const g1 = match[1], g2 = match[2];
      const isG1Size = /\d+\s*[x×]\s*\d+/.test(g1);
      hardware.push({
        type: 'magnet',
        size: isG1Size ? g1 : g2,
        qty: isG1Size ? (parseInt(g2) || null) : (parseInt(g1) || null),
      });
      break; // one match per pattern is enough
    }
    if (hardware.length) break;
  }

  // Fallback: magnet mentioned but no size parsed
  if (!hardware.length && text.includes('magnet')) {
    hardware.push({ type: 'magnet', size: null, qty: null });
  }

  // ── Screws ──
  // Patterns: "2x M3x8 screws", "M3 x 12mm screws", "4 M4 bolts", bare "M3x8"
  const screwPattern = /(\d+)\s*[x×]?\s*(m[2345]\s*[x×]?\s*\d*\s*mm?)\s*(screw|bolt|cap)?/gi;
  let sm;
  while ((sm = screwPattern.exec(description)) !== null) {
    hardware.push({
      type: 'screw',
      spec: sm[2].replace(/\s+/g, '').toUpperCase(),
      qty: parseInt(sm[1]) || null,
    });
  }

  // ── Heat-set inserts ──
  const insertPattern = /(m[2345])\s*(heat[\s-]?set|threaded)\s*insert/gi;
  let im;
  while ((im = insertPattern.exec(description)) !== null) {
    hardware.push({
      type: 'insert',
      spec: im[1].toUpperCase(),
      qty: null,
    });
  }

  return hardware.length ? hardware : null;
}

/**
 * Detect if the part requires a tray / base plate
 * Returns: { requires_tray, tray_size, tray_notes }
 */
function parseTrayRequirement(name, description) {
  const text = normalize(`${name} ${description}`);

  // Keywords that strongly indicate a tray is needed
  const trayKeywords = [
    'requires tray',
    'requires a tray',
    'needs a tray',
    'needs tray',
    'tray required',
    'tray is required',
    'use with tray',
    'used with tray',
    'place in tray',
    'sits in tray',
    'sits in a tray',
    'fits in tray',
    'fits in a tray',
    'designed for tray',
    'designed for the tray',
    'insert tray',
    'bin tray',
    'multibin tray',
    'multi bin tray',
    'requires multibin',
    'requires a multibin',
    'base tray',
    'shelf tray',
    'drawer tray',
    'cup tray',
    'insert for tray',
    'drop-in tray',
    'drop in tray',
  ];

  // Part name patterns that almost always need a tray — require "tray" or "bin"
  // context nearby to avoid false positives (e.g. "Allen Key Insert" is not a tray)
  const trayNamePatterns = [
    /\bdivider\b/,
    /\bdrawer insert\b/,
    /\bin-tray\b/,
    /\bin tray\b/,
    /\bcup insert\b/,
    /\bbin liner\b/,
    /\bbin divider\b/,
  ];

  // Standalone "insert" only counts if near tray/bin/multibin context
  const insertNearTray = /\binsert\b/.test(text) && /\b(tray|bin|multibin|drawer)\b/.test(text);

  let requires_tray = false;
  let tray_notes = null;

  // Check description for explicit keywords
  for (const kw of trayKeywords) {
    if (text.includes(kw)) {
      requires_tray = true;
      tray_notes = kw;
      break;
    }
  }

  // Check name patterns if not already found
  if (!requires_tray) {
    for (const pattern of trayNamePatterns) {
      if (pattern.test(text)) {
        requires_tray = true;
        tray_notes = `name contains "${pattern.source}"`;
        break;
      }
    }
  }

  // Standalone insert near tray context
  if (!requires_tray && insertNearTray) {
    requires_tray = true;
    tray_notes = 'insert near tray/bin context';
  }

  // Try to extract tray size from description
  // Patterns: "2x4 tray", "4x4 multibin tray", "fits 1x2 tray"
  let tray_size = null;
  if (requires_tray) {
    const sizeMatch = text.match(/(\d+\s*[x×]\s*\d+)\s*(mu\s*)?(tray|multibin|bin|shelf)/);
    if (sizeMatch) {
      tray_size = sizeMatch[1].replace(/\s/g, '').toLowerCase();
    }
  }

  return { requires_tray, tray_size, tray_notes };
}

/**
 * Main export — parse everything from a part's name + description
 */
function parsePart(name, description) {
  const mount_type     = parseMountType(name, description);
  const mount_hardware = parseMountHardware(description || '');
  const { requires_tray, tray_size, tray_notes } = parseTrayRequirement(name, description || '');

  return {
    mount_type,
    mount_hardware: mount_hardware ? JSON.stringify(mount_hardware) : null,
    requires_tray:  requires_tray ? 1 : 0,
    tray_size,
    tray_notes,
  };
}

module.exports = { parsePart, parseMountType, parseMountHardware, parseTrayRequirement };
