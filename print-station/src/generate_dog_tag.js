#!/usr/bin/env node
/**
 * BRCC Dog Tag Generator
 * ============================================================
 * Generates two STL-ready OpenSCAD files:
 *   1. tag_base_<name>.scad  — tag with text pocket cut out
 *   2. tag_text_<name>.scad  — text insert that presses into pocket
 *
 * Usage:
 *   node generate_dog_tag.js --name "BUDDY" --shape bone --output ./output
 *
 * Shapes: bone | shield | heart | paw | hydrant | star
 *
 * print-station integration:
 *   const { generateDogTag } = require('./generate_dog_tag');
 *   await generateDogTag({ name: "BUDDY", shape: "bone", outputDir: "./stl_queue" });
 * ============================================================
 */

const fs   = require('fs');
const path = require('path');

// ──────────────────────────────────────────────
// CONFIG DEFAULTS
// ──────────────────────────────────────────────
const DEFAULTS = {
  font:            'Liberation Sans:style=Bold',
  thickness:       3.2,   // total tag thickness (mm)
  pocketDepth:     1.4,   // how deep the text pocket sinks (mm)
  pocketClearance: 0.25,  // xy clearance so insert slides in (mm)
  textHeight:      1.5,   // height of the text insert block (mm)
  textSize:        7.5,   // font size (mm) – auto-scaled per shape
  ringHoleDia:     4.6,
  textCx:          null,  // override text X position (null = use shape default)
  textCy:          null,  // override text Y position (null = use shape default)
  textSz:          null,  // override text size (null = use shape default)
};

// ──────────────────────────────────────────────
// SHAPE LIBRARIES  (returns OpenSCAD module strings)
// Each shape exposes:
//   - shape_2d()          — 2D profile
//   - ring_hole_offset()  — [x, y] for ring hole center
//   - text_center()       — [x, y] for name centroid
//   - text_size           — suggested font size
// ──────────────────────────────────────────────

function shapeOpenSCAD(shape, cfg) {
  const shapes = {

    // ── BONE ──────────────────────────────────────
    bone: `
// Bone shape
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
}
ring_x = -44; ring_y = 0;
text_cx = 0;  text_cy = -2;
text_sz = 7;
`,

    // ── SHIELD ────────────────────────────────────
    shield: `
// Shield shape
module shape_2d() {
  w = 40; h = 50; top_r = 5;
  hull() {
    translate([-w/2+top_r,  h/2-top_r]) circle(r=top_r, $fn=32);
    translate([ w/2-top_r,  h/2-top_r]) circle(r=top_r, $fn=32);
    translate([0, -h/2+3])              circle(r=3,      $fn=32);
  }
}
ring_x = 0; ring_y = 20;
text_cx = 0; text_cy = -6;
text_sz = 8;
`,

    // ── HEART ─────────────────────────────────────
    heart: `
// Heart shape
module heart_2d() {
  union() {
    translate([-10, 0]) circle(r=10, $fn=64);
    translate([ 10, 0]) circle(r=10, $fn=64);
    polygon(points=[[-20,0],[20,0],[0,-22]]);
  }
}
module shape_2d() { scale([1.15,1.15]) heart_2d(); }
ring_x = 0; ring_y = 10;
text_cx = 0; text_cy = -8;
text_sz = 7.5;
`,

    // ── PAW ROUND ─────────────────────────────────
    paw: `
// Round paw tag
module shape_2d() { circle(d=44, $fn=64); }
ring_x = 0; ring_y = 24;   // sits on tab
text_cx = 0; text_cy = -13;
text_sz = 6.5;
`,

    // ── HYDRANT ───────────────────────────────────
    hydrant: `
// Fire hydrant tag
module shape_2d() {
  offset(r=2, $fn=32) union() {
    translate([0,-18]) square([30,8],  center=true);
    translate([0,-10]) square([24,12], center=true);
    translate([0, 2])  square([20,12], center=true);
    translate([0, 11]) { square([18,4],center=true); translate([0,4]) circle(r=7,$fn=48); }
    translate([-14,-4]) circle(r=4,$fn=24);
    translate([ 14,-4]) circle(r=4,$fn=24);
  }
}
ring_x = 0; ring_y = 22;
text_cx = 0; text_cy = -13;
text_sz = 6;
`,

    // ── STAR ──────────────────────────────────────
    star: `
// Sheriff star
module shape_2d() {
  offset(r=1.5,$fn=32)
  polygon([
    for(i=[0:9])
      let(angle=360/5/2*i-90, r=(i%2==0)?24:11)
      [cos(angle)*r, sin(angle)*r]
  ]);
}
ring_x = 0; ring_y = 27;
text_cx = 0; text_cy = -2;
text_sz = 6.5;
`,
  };

  if (!shapes[shape]) throw new Error(`Unknown shape: "${shape}". Valid: bone, shield, heart, paw, hydrant, star`);
  return shapes[shape];
}

// ──────────────────────────────────────────────
// BASE TAG SCAD  (tag with pocket + ring hole)
// ──────────────────────────────────────────────
function buildBaseTag(petName, shape, cfg) {
  const shapeLib = shapeOpenSCAD(shape, cfg);
  const sanitized = petName.toUpperCase();

  // Extra tab for paw/star/hydrant ring holes
  const needsTab = ['paw', 'star', 'hydrant', 'shield'].includes(shape);
  const tabModule = needsTab ? `
module ring_tab() {
  translate([ring_x, ring_y, 0]) cylinder(d=10, h=thickness, $fn=32);
}
` : `module ring_tab() { /* no tab needed */ }`;

  return `// ============================================================
// BRCC Dog Tag - BASE (${shape.toUpperCase()}) - Print in COLOR A
// Pet name: ${sanitized}
// Blue Ridge Custom Co | blueridgecustomco.us
// ============================================================
// HOW TO PRINT:
//   - This is the tag body. Print in your PRIMARY color.
//   - The name pocket is pre-cut. Do NOT fill it.
//   - After printing, press the text insert (COLOR B) into the pocket.
//   - A drop of CA glue holds it permanently.
// ============================================================

${shapeLib.trim()}

// Text position overrides (last assignment wins in OpenSCAD)
${cfg.textCx !== null ? `text_cx = ${cfg.textCx};` : '// text_cx: using shape default'}
${cfg.textCy !== null ? `text_cy = ${cfg.textCy};` : '// text_cy: using shape default'}
${cfg.textSz !== null ? `text_sz = ${cfg.textSz};` : '// text_sz: using shape default'}

thickness        = ${cfg.thickness};
pocket_depth     = ${cfg.pocketDepth};
pocket_clearance = ${cfg.pocketClearance};
ring_hole_dia    = ${cfg.ringHoleDia};
font             = "${cfg.font}";
pet_name         = "${sanitized}";

${tabModule}

module ring_hole() {
  translate([ring_x, ring_y, -1])
    cylinder(d=ring_hole_dia, h=thickness+2, $fn=28);
}

// The pocket is the text geometry expanded by clearance, sunk from top face
module text_pocket() {
  translate([text_cx, text_cy, thickness - pocket_depth])
  linear_extrude(height=pocket_depth + 0.01)
    offset(r=pocket_clearance, $fn=16)
      text(pet_name, size=text_sz, font=font,
           halign="center", valign="center");
}

// Outer chamfer groove (decorative)
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

// ──────────────────────────────────────────────
// TEXT INSERT SCAD  (solid text on a base plate)
// ──────────────────────────────────────────────
function buildTextInsert(petName, shape, cfg) {
  const shapeLib = shapeOpenSCAD(shape, cfg);
  const sanitized = petName.toUpperCase();

  // Insert: a thin backing plate the size of the text bounding box
  // + raised text letters on top. Total height = pocketDepth - 0.1 (slight undersize)
  const insertHeight = (cfg.pocketDepth - 0.05).toFixed(2);
  const letterHeight = (cfg.textHeight).toFixed(2);

  return `// ============================================================
// BRCC Dog Tag - TEXT INSERT (${shape.toUpperCase()}) - Print in COLOR B
// Pet name: ${sanitized}
// Blue Ridge Custom Co | blueridgecustomco.us
// ============================================================
// HOW TO PRINT:
//   - Print this FLAT on the bed. No supports needed.
//   - Print in your ACCENT color.
//   - Press into the pocket of the base tag after both are printed.
//   - Optional: thin CA glue on the back before pressing in.
// ============================================================
// INSERT DIMENSIONS:
//   Total height: ${insertHeight}mm (fits pocket of ${cfg.pocketDepth}mm depth)
//   Letter height: ${letterHeight}mm above base slab
// ============================================================

${shapeLib.trim()}

// Text position overrides (last assignment wins in OpenSCAD)
${cfg.textCx !== null ? `text_cx = ${cfg.textCx};` : '// text_cx: using shape default'}
${cfg.textCy !== null ? `text_cy = ${cfg.textCy};` : '// text_cy: using shape default'}
${cfg.textSz !== null ? `text_sz = ${cfg.textSz};` : '// text_sz: using shape default'}

font      = "${cfg.font}";
pet_name  = "${sanitized}";

insert_h  = ${insertHeight};   // fits pocket
letter_h  = ${letterHeight};   // raised letter height above slab

// The base slab exactly matches the text outline (+ clearance already handled in base)
module text_slab() {
  linear_extrude(height=insert_h)
    text(pet_name, size=text_sz, font=font,
         halign="center", valign="center");
}

// Raised letters on top of slab
module raised_letters() {
  translate([0, 0, insert_h])
  linear_extrude(height=letter_h)
    text(pet_name, size=text_sz, font=font,
         halign="center", valign="center");
}

// Final insert: slab + raised letters, positioned at origin
translate([0, 0, 0]) {
  text_slab();
  raised_letters();
}
`;
}

// ──────────────────────────────────────────────
// MAIN GENERATOR FUNCTION (export for print-station)
// ──────────────────────────────────────────────
async function generateDogTag({ name, shape = 'bone', outputDir = '.', options = {} }) {
  if (!name || name.trim() === '') throw new Error('Pet name is required');

  const cfg = { ...DEFAULTS, ...options };
  const safeName   = name.trim().toUpperCase().replace(/[^A-Z0-9\s]/g, '').replace(/\s+/g, '_');
  const safeShape  = shape.toLowerCase().trim();

  fs.mkdirSync(outputDir, { recursive: true });

  const baseFile = path.join(outputDir, `tag_base_${safeShape}_${safeName}.scad`);
  const textFile = path.join(outputDir, `tag_text_${safeShape}_${safeName}.scad`);

  const baseContent = buildBaseTag(name.trim(), safeShape, cfg);
  const textContent = buildTextInsert(name.trim(), safeShape, cfg);

  fs.writeFileSync(baseFile, baseContent);
  fs.writeFileSync(textFile, textContent);

  const result = {
    baseSCAD:  baseFile,
    textSCAD:  textFile,
    petName:   safeName,
    shape:     safeShape,
    printNotes: {
      baseColor:   'Primary tag color (e.g. black, silver, gold)',
      insertColor: 'Accent/text color (e.g. white, yellow, red)',
      layerHeight: '0.15mm recommended for crisp text',
      supports:    'None needed — print both flat',
      assembly:    'Press text insert into pocket. Optional CA glue.',
    }
  };

  return result;
}

// ──────────────────────────────────────────────
// CLI INTERFACE
// ──────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  const get  = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i+1] : null; };

  const name      = get('--name');
  const shape     = get('--shape')  || 'bone';
  const outputDir = get('--output') || './dog_tag_output';

  if (!name) {
    console.error(`
BRCC Dog Tag Generator
Usage:
  node generate_dog_tag.js --name "BUDDY" --shape bone --output ./output

Shapes: bone | shield | heart | paw | hydrant | star

Output:
  tag_base_<shape>_<NAME>.scad   → print in COLOR A (tag body)
  tag_text_<shape>_<NAME>.scad   → print in COLOR B (text insert)
`);
    process.exit(1);
  }

  generateDogTag({ name, shape, outputDir })
    .then(result => {
      console.log('\n✅ Dog tag files generated!\n');
      console.log(`  Base tag (COLOR A): ${path.basename(result.baseSCAD)}`);
      console.log(`  Text insert (COLOR B): ${path.basename(result.textSCAD)}`);
      console.log('\nPrint notes:');
      Object.entries(result.printNotes).forEach(([k,v]) => console.log(`  ${k}: ${v}`));
      console.log('\nOpen both .scad files in OpenSCAD → F6 → Export STL');
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}

// ──────────────────────────────────────────────
// SHAPE GEOMETRY DATA (for frontend canvas rendering)
// Returns drawable path data matching the OpenSCAD shapes
// ──────────────────────────────────────────────
const SHAPE_GEOMETRY = {
  bone: {
    type: 'bone',
    width: 64, height: 30,
    textCx: 0, textCy: -2, textSz: 7,
    ringX: -32, ringY: 0,
    // shaft + end knobs
    draw: 'bone',
  },
  shield: {
    type: 'shield',
    width: 40, height: 50,
    textCx: 0, textCy: -6, textSz: 8,
    ringX: 0, ringY: 20,
    draw: 'shield',
  },
  heart: {
    type: 'heart',
    width: 46, height: 44,
    textCx: 0, textCy: -8, textSz: 7.5,
    ringX: 0, ringY: 10,
    draw: 'heart',
  },
  paw: {
    type: 'paw',
    width: 44, height: 44,
    textCx: 0, textCy: -13, textSz: 6.5,
    ringX: 0, ringY: 24,
    draw: 'paw',
  },
  hydrant: {
    type: 'hydrant',
    width: 40, height: 50,
    textCx: 0, textCy: -13, textSz: 6,
    ringX: 0, ringY: 22,
    draw: 'hydrant',
  },
  star: {
    type: 'star',
    width: 50, height: 50,
    textCx: 0, textCy: -2, textSz: 6.5,
    ringX: 0, ringY: 27,
    draw: 'star',
  },
};

function getShapeGeometry(shapeId) {
  return SHAPE_GEOMETRY[shapeId] || null;
}

function getAllShapeGeometry() {
  return { ...SHAPE_GEOMETRY };
}

module.exports = { generateDogTag, getShapeGeometry, getAllShapeGeometry, DEFAULTS };
