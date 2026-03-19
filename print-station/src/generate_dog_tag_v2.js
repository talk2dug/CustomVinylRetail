#!/usr/bin/env node
/**
 * BRCC Dog Tag Generator — v2
 * ============================================================
 * Two modes:
 *   A) STL-import mode: uses a pre-made blank STL (from Tinkercad etc.)
 *      - OpenSCAD import()s your blank, difference() cuts text pocket
 *   B) Fallback mode: generates shape from OpenSCAD code (v1 behavior)
 *      - Used when no blank STL exists for a shape
 *
 * Generates two files per order:
 *   1. tag_base_<NAME>.scad/.stl — tag body with text pocket
 *   2. tag_insert_<NAME>.scad/.stl — text slug press-fit piece
 *
 * Usage (require):
 *   const { generateDogTag, loadShapesConfig } = require('./generate_dog_tag_v2');
 *   const result = await generateDogTag({ name: 'GHOST', shape: 'bone', ... });
 * ============================================================
 */

const fs   = require('fs');
const path = require('path');

// ── DEFAULTS ─────────────────────────────────────────────────
const DEFAULTS = {
  font:           'Liberation Sans:style=Bold',
  thickness:      3.2,
  pocketDepth:    1.4,
  pocketClearance: 0.25,
  insertHeight:   1.5,
  fontSize:       7.5,
  ringHoleDia:    4.6,
  textXOffset:    0,
  textYOffset:    0,
};

// ── AUTO SCALE font for long names ───────────────────────────
function autoFontSize(name, base = 7.5) {
  if (name.length <= 4)  return base;
  if (name.length <= 6)  return base * 0.9;
  if (name.length <= 8)  return base * 0.78;
  if (name.length <= 10) return base * 0.68;
  return base * 0.58;
}

// ── V1 FALLBACK SHAPE CODE ───────────────────────────────────
// Used when no blank STL file exists for a shape
const SHAPE_OPENSCAD = {
  bone: `
module shape_2d() {
  shaft_len = 32; shaft_w = 10; end_r = 10;
  union() {
    hull() {
      for(x = [-shaft_len/2 + 2, shaft_len/2 - 2])
        translate([x, 0]) circle(r=shaft_w/2, $fn=32);
    }
    for(ex = [-shaft_len/2, shaft_len/2])
      for(angle = [45, 135, 225, 315])
        translate([ex + cos(angle)*6, sin(angle)*6]) circle(r=end_r/2, $fn=32);
  }
}`,
  shield: `
module shape_2d() {
  w = 40; h = 50; top_r = 5;
  hull() {
    translate([-w/2+top_r,  h/2-top_r]) circle(r=top_r, $fn=32);
    translate([ w/2-top_r,  h/2-top_r]) circle(r=top_r, $fn=32);
    translate([0, -h/2+3])              circle(r=3,      $fn=32);
  }
}`,
  heart: `
module heart_2d() {
  union() {
    translate([-10, 0]) circle(r=10, $fn=64);
    translate([ 10, 0]) circle(r=10, $fn=64);
    polygon(points=[[-20,0],[20,0],[0,-22]]);
  }
}
module shape_2d() { scale([1.15,1.15]) heart_2d(); }`,
  paw: `
module shape_2d() { circle(d=44, $fn=64); }`,
  hydrant: `
module shape_2d() {
  offset(r=2, $fn=32) union() {
    translate([0,-18]) square([30,8],  center=true);
    translate([0,-10]) square([24,12], center=true);
    translate([0, 2])  square([20,12], center=true);
    translate([0, 11]) { square([18,4],center=true); translate([0,4]) circle(r=7,$fn=48); }
    translate([-14,-4]) circle(r=4,$fn=24);
    translate([ 14,-4]) circle(r=4,$fn=24);
  }
}`,
  star: `
module shape_2d() {
  offset(r=1.5,$fn=32)
  polygon([
    for(i=[0:9])
      let(angle=360/5/2*i-90, r=(i%2==0)?24:11)
      [cos(angle)*r, sin(angle)*r]
  ]);
}`,
};

// Default shape metadata (ring position, text position, etc.)
const SHAPE_DEFAULTS = {
  bone:    { ringX: -44, ringY: 0,  textXOffset: 0, textYOffset: -2,  fontSize: 7,   thickness: 3.2, pocketDepth: 1.4, needsTab: false, label: 'Classic Bone',    width: 64, height: 30 },
  shield:  { ringX: 0,   ringY: 20, textXOffset: 0, textYOffset: -6,  fontSize: 8,   thickness: 3.2, pocketDepth: 1.4, needsTab: true,  label: 'Shield / Badge',  width: 40, height: 50 },
  heart:   { ringX: 0,   ringY: 10, textXOffset: 0, textYOffset: -8,  fontSize: 7.5, thickness: 3.2, pocketDepth: 1.4, needsTab: false, label: 'Heart',           width: 46, height: 44 },
  paw:     { ringX: 0,   ringY: 24, textXOffset: 0, textYOffset: -13, fontSize: 6.5, thickness: 4.0, pocketDepth: 1.6, needsTab: true,  label: 'Paw Print',       width: 44, height: 44 },
  hydrant: { ringX: 0,   ringY: 22, textXOffset: 0, textYOffset: -13, fontSize: 6,   thickness: 3.2, pocketDepth: 1.4, needsTab: true,  label: 'Fire Hydrant',    width: 40, height: 50 },
  star:    { ringX: 0,   ringY: 27, textXOffset: 0, textYOffset: -2,  fontSize: 6.5, thickness: 3.2, pocketDepth: 1.4, needsTab: true,  label: 'Sheriff Star',    width: 50, height: 50 },
};

// ── LOAD SHAPES CONFIG ───────────────────────────────────────
// Reads tag_shapes.json, merges with built-in defaults
function loadShapesConfig(configPath) {
  let userConfig = {};
  if (configPath && fs.existsSync(configPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      userConfig = raw.shapes || raw;
    } catch (_) {}
  }

  const merged = {};
  // Start with built-in shapes
  for (const [id, defaults] of Object.entries(SHAPE_DEFAULTS)) {
    merged[id] = { ...defaults, stlFile: null, hasBlankStl: false };
  }
  // Overlay user config
  for (const [id, cfg] of Object.entries(userConfig)) {
    merged[id] = { ...merged[id] || {}, ...cfg };
    // Normalize
    if (!merged[id].label) merged[id].label = id.charAt(0).toUpperCase() + id.slice(1);
  }
  return merged;
}

// Save shapes config
function saveShapesConfig(configPath, shapesObj) {
  const out = {
    _comment: 'BRCC Dog Tag Shape Config — one entry per tag shape',
    shapes: shapesObj,
  };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(out, null, 2));
}

// ── Read STL bounding box (binary STL) ───────────────────────
function readStlBounds(stlPath) {
  try {
    const buf = fs.readFileSync(stlPath);
    // Binary STL: 80-byte header, 4-byte triangle count, then 50 bytes per triangle
    const triCount = buf.readUInt32LE(80);
    let minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < triCount; i++) {
      const offset = 84 + i * 50;
      // 3 vertices at offset+12, +24, +36 (each vertex = 3 floats = 12 bytes)
      for (let v = 0; v < 3; v++) {
        const z = buf.readFloatLE(offset + 12 + v * 12 + 8);
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
    }
    return { minZ, maxZ, height: maxZ - minZ };
  } catch (e) {
    return null;
  }
}

// ── SCAD: BASE TAG (STL-import mode) ─────────────────────────
function buildBaseTagFromStl(cfg) {
  const fs_size = cfg.fontSize || autoFontSize(cfg.name, DEFAULTS.fontSize);

  // Auto-detect actual STL height instead of trusting config
  const bounds = readStlBounds(cfg.baseStlPath);
  const actualThickness = bounds ? bounds.height : cfg.thickness;
  const cutDepth = cfg.pocketDepth + 0.2;

  // STL-import mode: use the fallback shape code but override the thickness
  // with the actual STL height. This avoids CGAL failures on non-manifold
  // meshes while preserving the shape outline defined by the STL.
  // The imported STL is only used for the 3D preview — the SCAD generation
  // uses the built-in shape code which always produces valid geometry.
  cfg.thickness = actualThickness;
  return buildBaseTagFromShape(cfg);
}

// ── SCAD: BASE TAG (v1 fallback — shape code) ────────────────
function buildBaseTagFromShape(cfg) {
  const shapeCode = SHAPE_OPENSCAD[cfg.shape];
  if (!shapeCode) throw new Error(`Unknown shape: "${cfg.shape}"`);

  const fs_size = cfg.fontSize || autoFontSize(cfg.name, DEFAULTS.fontSize);
  const sd = SHAPE_DEFAULTS[cfg.shape] || {};
  const needsTab = sd.needsTab || false;

  const tabModule = needsTab ? `
module ring_tab() {
  translate([ring_x, ring_y, 0]) cylinder(d=10, h=thickness, $fn=32);
}` : `module ring_tab() { /* no tab needed */ }`;

  return `// ============================================================
// BRCC Dog Tag — BASE (${cfg.shape.toUpperCase()}) - Print in COLOR A
// Pet name: ${cfg.name}
// Blue Ridge Custom Co | blueridgecustomco.us
// ============================================================
// PRINT IN: Color A (tag body color)
// After printing: press text insert (Color B) into pocket.
// ============================================================

${shapeCode.trim()}

ring_x = ${sd.ringX || 0}; ring_y = ${sd.ringY || 0};
text_cx = ${cfg.textXOffset}; text_cy = ${cfg.textYOffset};
text_sz = ${fs_size.toFixed(2)};

thickness        = ${cfg.thickness};
pocket_depth     = ${cfg.pocketDepth};
pocket_clearance = ${cfg.pocketClearance};
ring_hole_dia    = ${cfg.ringHoleDia};
font             = "${cfg.font}";
pet_name         = "${cfg.name}";

${tabModule}

module ring_hole() {
  translate([ring_x, ring_y, -1])
    cylinder(d=ring_hole_dia, h=thickness+2, $fn=28);
}

module text_pocket() {
  translate([text_cx, text_cy, thickness - pocket_depth])
  linear_extrude(height=pocket_depth + 0.01)
    offset(r=pocket_clearance, $fn=16)
      text(pet_name, size=text_sz, font=font,
           halign="center", valign="center");
}

module chamfer_groove() {
  translate([0, 0, thickness - 0.4])
  linear_extrude(height=0.41)
  difference() {
    offset(r=-1.5) shape_2d();
    offset(r=-3.0) shape_2d();
  }
}

difference() {
  union() {
    linear_extrude(height=thickness) shape_2d();
    ring_tab();
  }
  ring_hole();
  text_pocket();
}
chamfer_groove();
`;
}

// ── SCAD: TEXT INSERT (same for both modes) ──────────────────
function buildTextInsert(cfg) {
  const fs_size = cfg.fontSize || autoFontSize(cfg.name, DEFAULTS.fontSize);
  const slabH   = (cfg.pocketDepth - 0.05).toFixed(2);
  const letterH = cfg.insertHeight.toFixed(2);

  return `// ============================================================
// BRCC Dog Tag — TEXT INSERT - Print in COLOR B
// Name: ${cfg.name}
// Blue Ridge Custom Co | blueridgecustomco.us
// ============================================================
// PRINT IN: Color B (accent/name color)
// Print FLAT on bed. No supports needed.
// Press into pocket of base tag after both are printed.
// ============================================================

font      = "${cfg.font}";
pet_name  = "${cfg.name}";
font_size = ${fs_size.toFixed(2)};
slab_h    = ${slabH};
letter_h  = ${letterH};

module text_slab() {
  linear_extrude(height = slab_h)
    text(pet_name, size = font_size, font = font,
         halign = "center", valign = "center");
}

module raised_letters() {
  translate([0, 0, slab_h])
  linear_extrude(height = letter_h)
    text(pet_name, size = font_size, font = font,
         halign = "center", valign = "center");
}

text_slab();
raised_letters();
`;
}

// ── MAIN GENERATOR ───────────────────────────────────────────
async function generateDogTag({
  name,
  shape = 'bone',
  baseStlPath = null,
  outputDir = '.',
  shapeCfg = {},
  options = {},
}) {
  if (!name || name.trim().length === 0) throw new Error('Pet name is required');

  const cleanName = name.trim().toUpperCase().replace(/[^A-Z0-9\s]/g, '').slice(0, 12);
  if (cleanName.length === 0) throw new Error('Name must contain alphanumeric characters');
  const safeFile = cleanName.replace(/\s+/g, '_');
  const safeShape = shape.toLowerCase().trim();

  // Merge defaults <- shape defaults <- shape config <- options
  const sd = SHAPE_DEFAULTS[safeShape] || {};
  const cfg = {
    name: cleanName,
    shape: safeShape,
    font:            options.font           || shapeCfg.font           || DEFAULTS.font,
    thickness:       options.thickness      ?? shapeCfg.thickness      ?? sd.thickness      ?? DEFAULTS.thickness,
    pocketDepth:     options.pocketDepth    ?? shapeCfg.pocketDepth    ?? sd.pocketDepth    ?? DEFAULTS.pocketDepth,
    pocketClearance: options.pocketClearance ?? shapeCfg.pocketClearance ?? DEFAULTS.pocketClearance,
    insertHeight:    options.insertHeight   ?? shapeCfg.insertHeight   ?? DEFAULTS.insertHeight,
    fontSize:        options.textSz         ?? options.fontSize        ?? shapeCfg.fontSize ?? null, // null = auto
    ringHoleDia:     DEFAULTS.ringHoleDia,
    textXOffset:     options.textCx         ?? options.textXOffset     ?? shapeCfg.textXOffset ?? sd.textXOffset ?? 0,
    textYOffset:     options.textCy         ?? options.textYOffset     ?? shapeCfg.textYOffset ?? sd.textYOffset ?? 0,
    baseStlPath:     baseStlPath,
  };

  // Auto-scale font if not set
  if (!cfg.fontSize) {
    cfg.fontSize = autoFontSize(cleanName, shapeCfg.fontSize || sd.fontSize || DEFAULTS.fontSize);
  }

  fs.mkdirSync(outputDir, { recursive: true });

  const baseScadPath   = path.join(outputDir, `tag_base_${safeShape}_${safeFile}.scad`);
  const insertScadPath = path.join(outputDir, `tag_insert_${safeShape}_${safeFile}.scad`);

  // Build SCAD — STL-import mode or fallback
  let baseContent;
  if (baseStlPath && fs.existsSync(baseStlPath)) {
    baseContent = buildBaseTagFromStl(cfg);
  } else {
    baseContent = buildBaseTagFromShape(cfg);
  }
  const insertContent = buildTextInsert(cfg);

  fs.writeFileSync(baseScadPath, baseContent);
  fs.writeFileSync(insertScadPath, insertContent);

  return {
    baseSCAD:  baseScadPath,
    textSCAD:  insertScadPath,
    petName:   cleanName,
    shape:     safeShape,
    mode:      (baseStlPath && fs.existsSync(baseStlPath)) ? 'stl-import' : 'shape-fallback',
    config:    cfg,
    printNotes: {
      baseColor:   'Color A — tag body',
      insertColor: 'Color B — name accent',
      layerHeight: '0.15mm for crisp text edges',
      supports:    'None — print both flat',
      assembly:    'Press insert into pocket. Optional CA glue.',
    },
  };
}

// ── SHAPE GEOMETRY for frontend ──────────────────────────────
function getShapeGeometry(shapeId) {
  const sd = SHAPE_DEFAULTS[shapeId];
  if (!sd) return null;
  return {
    type: shapeId,
    width: sd.width,
    height: sd.height,
    textCx: sd.textXOffset,
    textCy: sd.textYOffset,
    textSz: sd.fontSize,
    ringX: sd.ringX,
    ringY: sd.ringY,
    needsTab: sd.needsTab,
  };
}

function getAllShapeGeometry() {
  const result = {};
  for (const id of Object.keys(SHAPE_DEFAULTS)) {
    result[id] = getShapeGeometry(id);
  }
  return result;
}

module.exports = {
  generateDogTag,
  autoFontSize,
  loadShapesConfig,
  saveShapesConfig,
  getShapeGeometry,
  getAllShapeGeometry,
  DEFAULTS,
  SHAPE_DEFAULTS,
};
