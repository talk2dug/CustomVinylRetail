/**
 * Slicer Service
 * PrusaSlicer CLI wrapper for server-side slicing
 * Handles settings mapping, G-code caching, process spawning
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const STL_LIBRARY = path.join(DATA_DIR, 'stl-library');
const STL_MODELS = path.join(STL_LIBRARY, 'models');
const STL_THUMBNAILS = path.join(STL_LIBRARY, 'thumbnails');
const GCODE_CACHE = path.join(DATA_DIR, 'gcode-cache');
const PROFILES_DIR = path.join(DATA_DIR, 'profiles');

// Ensure directories exist
[STL_LIBRARY, STL_MODELS, STL_THUMBNAILS, GCODE_CACHE, PROFILES_DIR,
 path.join(PROFILES_DIR, 'printers'),
 path.join(PROFILES_DIR, 'filaments'),
 path.join(PROFILES_DIR, 'prints'),
 path.join(GCODE_CACHE, 'kobra3'),
 path.join(GCODE_CACHE, 'kobra3_v2'),
 path.join(GCODE_CACHE, 'ender3_s1pro'),
 path.join(GCODE_CACHE, 'ender3_v3_ke')
].forEach(d => fs.mkdirSync(d, { recursive: true }));

// PrusaSlicer path from env
const SLICER_PATH = process.env.PRUSA_SLICER_PATH || 'prusa-slicer';

// ============================================================================
// HUMAN-READABLE OPTIONS MAPPING
// ============================================================================

const QUALITY_MAP = {
  draft:      { layer_height: 0.28, label: 'Draft',      description: 'Fast, visible layers' },
  standard:   { layer_height: 0.20, label: 'Standard',   description: 'Good balance of speed and quality' },
  fine:       { layer_height: 0.12, label: 'Fine',       description: 'Smooth surface, slower' },
  ultra_fine: { layer_height: 0.08, label: 'Ultra Fine', description: 'Maximum detail, very slow' }
};

const STRENGTH_MAP = {
  light:  { infill: 10, perimeters: 2, top_layers: 3, bottom_layers: 3, label: 'Light',  description: 'Decorative, minimal strength' },
  normal: { infill: 20, perimeters: 3, top_layers: 4, bottom_layers: 4, label: 'Normal', description: 'Everyday use' },
  strong: { infill: 40, perimeters: 4, top_layers: 5, bottom_layers: 5, label: 'Strong', description: 'Structural, load-bearing' },
  solid:  { infill: 100, perimeters: 4, top_layers: 6, bottom_layers: 6, label: 'Solid', description: 'Maximum strength, heaviest' }
};

const SPEED_MAP = {
  slow:   { multiplier: 0.7, label: 'Slow',   description: 'Better quality, less vibration' },
  normal: { multiplier: 1.0, label: 'Normal', description: 'Default speed' },
  fast:   { multiplier: 1.3, label: 'Fast',   description: 'Quicker prints, may reduce quality' },
  turbo:  { multiplier: 1.6, label: 'Turbo',  description: 'Maximum speed, quality tradeoff' }
};

const TEXTURE_MAP = {
  smooth:     { fuzzy_skin: 'none',     label: 'Smooth',     description: 'Standard smooth finish' },
  fuzzy:      { fuzzy_skin: 'external', label: 'Fuzzy',      description: 'Textured outer walls' },
  full_fuzzy: { fuzzy_skin: 'all',      label: 'Full Fuzzy', description: 'Textured everywhere' }
};

const SUPPORTS_MAP = {
  none:       { enabled: false, threshold: 0,  buildplate_only: true,  label: 'None',       description: 'No support material' },
  light:      { enabled: true,  threshold: 55, buildplate_only: true,  label: 'Light',      description: 'Minimal supports, easy removal' },
  full:       { enabled: true,  threshold: 45, buildplate_only: true,  label: 'Full',       description: 'More supports for complex overhangs' },
  everywhere: { enabled: true,  threshold: 30, buildplate_only: false, label: 'Everywhere', description: 'Supports from all surfaces' }
};

const MATERIALS_MAP = {
  pla:        { hotend: 210, bed: 60,  retract_length: 0.8, retract_speed: 60, label: 'PLA',        description: 'Standard, easy to print' },
  petg:       { hotend: 235, bed: 80,  retract_length: 1.0, retract_speed: 50, label: 'PETG',       description: 'Durable, heat resistant' },
  abs:        { hotend: 250, bed: 100, retract_length: 0.8, retract_speed: 60, label: 'ABS',        description: 'Strong, needs enclosure' },
  tpu:        { hotend: 225, bed: 60,  retract_length: 1.5, retract_speed: 25, label: 'TPU',        description: 'Flexible, rubber-like' },
  rapid_pla:  { hotend: 220, bed: 60,  retract_length: 0.8, retract_speed: 60, label: 'Rapid PLA',  description: 'High-speed PLA' },
  rapid_petg: { hotend: 245, bed: 80,  retract_length: 1.0, retract_speed: 50, label: 'Rapid PETG', description: 'High-speed PETG' }
};

const PRINTERS_MAP = {
  kobra3:       { name: 'Kobra 3',           build: '250x250x260', nozzle: 0.4, profile: 'printer_kobra3.ini' },
  kobra3_v2:    { name: 'Kobra 3 V2',        build: '255x255x260', nozzle: 0.4, profile: 'printer_kobra3v2.ini' },
  ender3_s1pro: { name: 'Ender 3 S1 Pro',    build: '220x220x270', nozzle: 0.4, profile: 'printer_s1pro.ini' },
  ender3_v3_ke: { name: 'Ender 3 V3 KE',     build: '220x220x240', nozzle: 0.4, profile: 'printer_ke.ini' }
};

// Map material key to filament profile filename
const FILAMENT_PROFILES = {
  pla:        'filament_pla.ini',
  petg:       'filament_petg.ini',
  abs:        'filament_abs.ini',
  tpu:        'filament_tpu.ini',
  rapid_pla:  'filament_rapid_pla.ini',
  rapid_petg: 'filament_rapid_petg.ini'
};

// Map quality key to print preset filename
const PRINT_PROFILES = {
  draft:      'print_draft.ini',
  standard:   'print_standard.ini',
  fine:       'print_fine.ini',
  ultra_fine: 'print_ultra_fine.ini'
};

// ============================================================================
// SETTINGS → CLI ARGS
// ============================================================================

/**
 * Map human-readable options to PrusaSlicer CLI arguments
 */
function mapOptionsToSlicerArgs(options) {
  const args = [];
  const quality = QUALITY_MAP[options.quality] || QUALITY_MAP.standard;
  const strength = STRENGTH_MAP[options.strength] || STRENGTH_MAP.normal;
  const speed = SPEED_MAP[options.speed] || SPEED_MAP.normal;
  const texture = TEXTURE_MAP[options.texture] || TEXTURE_MAP.smooth;
  const supports = SUPPORTS_MAP[options.supports] || SUPPORTS_MAP.none;
  const material = MATERIALS_MAP[options.material] || MATERIALS_MAP.pla;

  // Quality
  args.push('--layer-height', String(quality.layer_height));

  // Strength
  args.push('--fill-density', `${strength.infill}%`);
  args.push('--perimeters', String(strength.perimeters));
  args.push('--top-solid-layers', String(strength.top_layers));
  args.push('--bottom-solid-layers', String(strength.bottom_layers));

  // Speed multiplier (applied to base speeds)
  const basePerimeter = 45;
  const baseInfill = 80;
  const baseTravel = 150;
  const baseSolidInfill = 60;
  const baseTopSolid = 40;
  const mult = speed.multiplier;
  args.push('--perimeter-speed', String(Math.round(basePerimeter * mult)));
  args.push('--infill-speed', String(Math.round(baseInfill * mult)));
  args.push('--travel-speed', String(Math.round(baseTravel * mult)));
  args.push('--solid-infill-speed', String(Math.round(baseSolidInfill * mult)));
  args.push('--top-solid-infill-speed', String(Math.round(baseTopSolid * mult)));

  // Texture
  args.push('--fuzzy-skin', texture.fuzzy_skin);

  // Supports (PrusaSlicer 2.4 uses boolean flags, not 0/1 values)
  if (supports.enabled) {
    args.push('--support-material');
    args.push('--support-material-threshold', String(supports.threshold));
    if (supports.buildplate_only) {
      args.push('--support-material-buildplate-only');
    }
  } else {
    args.push('--no-support-material');
  }

  // Material temperatures
  args.push('--temperature', String(material.hotend));
  args.push('--bed-temperature', String(material.bed));
  args.push('--retract-length', String(material.retract_length));
  args.push('--retract-speed', String(material.retract_speed));

  return args;
}

/**
 * Generate SHA256 hash from STL file stats + all settings for cache deduplication
 */
function generateSettingsHash(stlPath, options) {
  let fileInfo = '';
  try {
    const stat = fs.statSync(stlPath);
    fileInfo = `${stat.size}:${stat.mtimeMs}`;
  } catch {
    fileInfo = stlPath;
  }

  const settingsStr = [
    fileInfo,
    options.printer_model || 'kobra3',
    options.material || 'pla',
    options.quality || 'standard',
    options.strength || 'normal',
    options.speed || 'normal',
    options.texture || 'smooth',
    options.supports || 'none'
  ].join('|');

  return crypto.createHash('sha256').update(settingsStr).digest('hex').substring(0, 16);
}

// ============================================================================
// SLICER OUTPUT PARSING
// ============================================================================

/**
 * Parse PrusaSlicer stdout/stderr for estimates
 */
function parseSlicerOutput(output) {
  const result = { est_weight_g: null, est_time_min: null, filament_used_m: null };

  // Filament used: 3.45m (10.2g)
  const filamentMatch = output.match(/Filament used:\s*([\d.]+)m\s*\(([\d.]+)g\)/i);
  if (filamentMatch) {
    result.filament_used_m = parseFloat(filamentMatch[1]);
    result.est_weight_g = parseFloat(filamentMatch[2]);
  }

  // Estimated printing time: 1h 23m 45s OR  1d 2h 30m 15s
  const timeMatch = output.match(/estimated printing time[:\s]*(?:(\d+)d\s*)?(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?/i);
  if (timeMatch) {
    const days = parseInt(timeMatch[1] || '0', 10);
    const hours = parseInt(timeMatch[2] || '0', 10);
    const mins = parseInt(timeMatch[3] || '0', 10);
    const secs = parseInt(timeMatch[4] || '0', 10);
    result.est_time_min = days * 1440 + hours * 60 + mins + secs / 60;
  }

  return result;
}

// ============================================================================
// CORE SLICING
// ============================================================================

/**
 * Slice an STL file with the given options
 * @param {string} stlPath - Absolute path to the STL file
 * @param {object} options - { printer_model, material, quality, strength, speed, texture, supports }
 * @param {object} dbInstance - The raw better-sqlite3 database instance
 * @returns {Promise<object>} - { gcode_id, gcode_filename, gcode_path, est_weight_g, est_time_min, cached }
 */
async function sliceSTL(stlPath, options, dbInstance) {
  const printerModel = options.printer_model || 'kobra3';
  const hash = generateSettingsHash(stlPath, options);

  // Check cache first
  const cached = dbInstance.prepare('SELECT * FROM gcode_cache WHERE settings_hash = ?').get(hash);
  if (cached) {
    const fullPath = path.join(GCODE_CACHE, cached.gcode_path);
    if (fs.existsSync(fullPath)) {
      console.log(`[Slicer] Cache hit: ${hash} → ${cached.gcode_filename}`);
      return {
        gcode_id: cached.id,
        gcode_filename: cached.gcode_filename,
        gcode_path: cached.gcode_path,
        est_weight_g: cached.est_weight_g,
        est_time_min: cached.est_time_min,
        file_size: cached.file_size,
        cached: true
      };
    }
    // Cache entry exists but file is missing — remove stale entry
    dbInstance.prepare('DELETE FROM gcode_cache WHERE id = ?').run(cached.id);
  }

  // Resolve profile paths
  const printerInfo = PRINTERS_MAP[printerModel];
  if (!printerInfo) throw new Error(`Unknown printer model: ${printerModel}`);

  const printerProfile = path.join(PROFILES_DIR, 'printers', printerInfo.profile);
  const filamentProfile = path.join(PROFILES_DIR, 'filaments', FILAMENT_PROFILES[options.material] || FILAMENT_PROFILES.pla);
  const printProfile = path.join(PROFILES_DIR, 'prints', PRINT_PROFILES[options.quality] || PRINT_PROFILES.standard);

  // Build output path
  const stlBasename = path.basename(stlPath, path.extname(stlPath));
  const gcodeFilename = `${stlBasename}_${printerModel}_${options.quality || 'standard'}_${options.material || 'pla'}_${hash}.gcode`;
  const gcodeRelPath = path.join(printerModel, gcodeFilename);
  const gcodeAbsPath = path.join(GCODE_CACHE, gcodeRelPath);

  // Ensure output directory exists
  fs.mkdirSync(path.dirname(gcodeAbsPath), { recursive: true });

  // Calculate bed center from printer build volume (e.g. '250x250x260')
  const [bedX, bedY] = (printerInfo.build || '220x220x250').split('x').map(Number);
  const centerX = bedX / 2;
  const centerY = bedY / 2;

  // Build CLI args
  const cliArgs = [
    '--export-gcode',
    '--load', printProfile,
    '--load', filamentProfile,
    '--load', printerProfile,
    ...mapOptionsToSlicerArgs(options),
    '--center', `${centerX},${centerY}`,
    '--output', gcodeAbsPath,
    stlPath
  ];

  console.log(`[Slicer] Slicing: ${path.basename(stlPath)} → ${gcodeFilename}`);
  console.log(`[Slicer] CLI: ${SLICER_PATH} ${cliArgs.join(' ')}`);

  // Spawn PrusaSlicer
  const result = await new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    const proc = spawn(SLICER_PATH, cliArgs, {
      timeout: 300000, // 5 minute timeout
      env: { ...process.env, DISPLAY: '' } // Headless
    });

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`PrusaSlicer exited with code ${code}: ${stderr || stdout}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn PrusaSlicer: ${err.message}`));
    });
  });

  // Parse output
  const combined = result.stdout + '\n' + result.stderr;
  const estimates = parseSlicerOutput(combined);

  // Get file size
  let fileSize = 0;
  try {
    const stat = fs.statSync(gcodeAbsPath);
    fileSize = stat.size;
  } catch {}

  // Get stl_catalog_id from stlPath
  const stlRelPath = path.relative(STL_MODELS, stlPath).replace(/\\/g, '/');
  const catalogItem = dbInstance.prepare('SELECT id FROM stl_catalog WHERE stl_path = ?').get(stlRelPath);
  const stlCatalogId = catalogItem ? catalogItem.id : (options.stl_id || 0);

  // Insert into cache
  const ins = dbInstance.prepare(`
    INSERT INTO gcode_cache (stl_catalog_id, settings_hash, printer_model, material, quality, strength, speed, texture, supports, gcode_path, gcode_filename, est_weight_g, est_time_min, file_size)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const info = ins.run(
    stlCatalogId,
    hash,
    printerModel,
    options.material || 'pla',
    options.quality || 'standard',
    options.strength || 'normal',
    options.speed || 'normal',
    options.texture || 'smooth',
    options.supports || 'none',
    gcodeRelPath.replace(/\\/g, '/'),
    gcodeFilename,
    estimates.est_weight_g,
    estimates.est_time_min,
    fileSize
  );

  console.log(`[Slicer] Done: ${gcodeFilename} (${estimates.est_weight_g || '?'}g, ${estimates.est_time_min || '?'}min)`);

  return {
    gcode_id: info.lastInsertRowid,
    gcode_filename: gcodeFilename,
    gcode_path: gcodeRelPath.replace(/\\/g, '/'),
    est_weight_g: estimates.est_weight_g,
    est_time_min: estimates.est_time_min,
    file_size: fileSize,
    cached: false
  };
}

/**
 * Get model info using PrusaSlicer --info
 */
async function getModelInfo(stlPath) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    const proc = spawn(SLICER_PATH, ['--info', stlPath], {
      timeout: 30000,
      env: { ...process.env, DISPLAY: '' }
    });

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        const info = parseModelInfo(stdout + '\n' + stderr);
        resolve(info);
      } else {
        // --info not available in all versions; return null rather than error
        resolve(null);
      }
    });

    proc.on('error', () => {
      resolve(null);
    });
  });
}

/**
 * Parse --info output for triangle count, dimensions
 */
function parseModelInfo(output) {
  const info = { triangle_count: null, dim_x: null, dim_y: null, dim_z: null };

  const triMatch = output.match(/(\d+)\s*triangles/i);
  if (triMatch) info.triangle_count = parseInt(triMatch[1], 10);

  // Look for dimensions like "size: 50.00 x 30.00 x 20.00"
  const dimMatch = output.match(/size[:\s]*([\d.]+)\s*x\s*([\d.]+)\s*x\s*([\d.]+)/i);
  if (dimMatch) {
    info.dim_x = parseFloat(dimMatch[1]);
    info.dim_y = parseFloat(dimMatch[2]);
    info.dim_z = parseFloat(dimMatch[3]);
  }

  return info;
}

// ============================================================================
// PRESETS ENDPOINT DATA
// ============================================================================

function getPresets() {
  return {
    quality: Object.entries(QUALITY_MAP).map(([key, v]) => ({
      key, label: v.label, description: v.description, layer_height: `${v.layer_height}mm`
    })),
    strength: Object.entries(STRENGTH_MAP).map(([key, v]) => ({
      key, label: v.label, description: v.description, infill: `${v.infill}%`, walls: v.perimeters
    })),
    speed: Object.entries(SPEED_MAP).map(([key, v]) => ({
      key, label: v.label, description: v.description, multiplier: `${v.multiplier}x`
    })),
    texture: Object.entries(TEXTURE_MAP).map(([key, v]) => ({
      key, label: v.label, description: v.description
    })),
    supports: Object.entries(SUPPORTS_MAP).map(([key, v]) => ({
      key, label: v.label, description: v.description
    })),
    materials: Object.entries(MATERIALS_MAP).map(([key, v]) => ({
      key, label: v.label, description: v.description, hotend: v.hotend, bed: v.bed
    })),
    printers: Object.entries(PRINTERS_MAP).map(([model, v]) => ({
      model, name: v.name, build: v.build, nozzle: v.nozzle
    }))
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Core slicing
  sliceSTL,
  getModelInfo,
  generateSettingsHash,
  mapOptionsToSlicerArgs,
  parseSlicerOutput,
  // Presets
  getPresets,
  // Maps (for reference)
  QUALITY_MAP,
  STRENGTH_MAP,
  SPEED_MAP,
  TEXTURE_MAP,
  SUPPORTS_MAP,
  MATERIALS_MAP,
  PRINTERS_MAP,
  // Paths
  STL_LIBRARY,
  STL_MODELS,
  STL_THUMBNAILS,
  GCODE_CACHE,
  PROFILES_DIR,
  DATA_DIR
};
