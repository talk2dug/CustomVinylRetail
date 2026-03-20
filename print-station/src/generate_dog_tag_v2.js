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

// ── FONT LIST (OpenSCAD-compatible system fonts) ─────────────
const FONT_LIST = [
  { value: 'Liberation Sans:style=Bold', label: 'Liberation Sans Bold', category: 'block' },
  { value: 'Arial:style=Bold',           label: 'Arial Bold',           category: 'block' },
  { value: 'Impact',                      label: 'Impact',               category: 'block' },
  { value: 'Georgia:style=Bold',          label: 'Georgia Bold',         category: 'block' },
  { value: 'Times New Roman:style=Bold',  label: 'Times New Roman Bold', category: 'block' },
  { value: 'Verdana:style=Bold',          label: 'Verdana Bold',         category: 'block' },
  { value: 'Comic Sans MS:style=Bold',    label: 'Comic Sans Bold',     category: 'block' },
  { value: 'Courier New:style=Bold',      label: 'Courier New Bold',    category: 'block' },
  { value: 'Segoe Script',                label: 'Segoe Script',         category: 'script' },
  { value: 'Lucida Handwriting',           label: 'Lucida Handwriting',  category: 'script' },
  { value: 'Brush Script MT',             label: 'Brush Script',         category: 'script' },
];

// ── AUTO SCALE font for long names ───────────────────────────
function autoFontSize(name, base = 7.5) {
  if (name.length <= 4)  return base;
  if (name.length <= 6)  return base * 0.9;
  if (name.length <= 8)  return base * 0.78;
  if (name.length <= 10) return base * 0.68;
  return base * 0.58;
}

// No predefined shapes — all shapes come from user-uploaded STL blanks.
// SHAPE_DEFAULTS is kept as an empty object for backward compat.
const SHAPE_OPENSCAD = {};
const SHAPE_DEFAULTS = {};

// ── LOAD SHAPES CONFIG ───────────────────────────────────────
// Reads tag_shapes.json — all shapes are user-uploaded STL blanks
function loadShapesConfig(configPath) {
  let userConfig = {};
  if (configPath && fs.existsSync(configPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      userConfig = raw.shapes || raw;
    } catch (_) {}
  }

  const shapes = {};
  for (const [id, cfg] of Object.entries(userConfig)) {
    shapes[id] = { ...cfg };
    if (!shapes[id].label) shapes[id].label = id.charAt(0).toUpperCase() + id.slice(1);
    // Default geometry values for shapes that don't have them
    if (shapes[id].thickness == null) shapes[id].thickness = DEFAULTS.thickness;
    if (shapes[id].pocketDepth == null) shapes[id].pocketDepth = DEFAULTS.pocketDepth;
    if (shapes[id].fontSize == null) shapes[id].fontSize = DEFAULTS.fontSize;
    if (shapes[id].textXOffset == null) shapes[id].textXOffset = 0;
    if (shapes[id].textYOffset == null) shapes[id].textYOffset = 0;
  }
  return shapes;
}

// Save shapes config
function saveShapesConfig(configPath, shapesObj) {
  const out = {
    _comment: 'BRCC Keychain Shape Config — user-uploaded STL blanks',
    shapes: shapesObj,
  };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(out, null, 2));
}

// ── Read STL bounding box + top-surface centroid (binary STL) ─
function readStlBounds(stlPath) {
  try {
    const buf = fs.readFileSync(stlPath);
    // Binary STL: 80-byte header, 4-byte triangle count, then 50 bytes per triangle
    const triCount = buf.readUInt32LE(80);
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < triCount; i++) {
      const offset = 84 + i * 50;
      for (let v = 0; v < 3; v++) {
        const x = buf.readFloatLE(offset + 12 + v * 12);
        const y = buf.readFloatLE(offset + 12 + v * 12 + 4);
        const z = buf.readFloatLE(offset + 12 + v * 12 + 8);
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
    }

    const height = maxZ - minZ;

    // Compute centroid of top-surface triangles (z near maxZ)
    // This gives a much better text center than bounding box center
    // for asymmetric shapes like bones where the shaft is offset
    const topThreshold = maxZ - height * 0.3; // top 30% of height
    let topSumX = 0, topSumY = 0, topArea = 0;
    for (let i = 0; i < triCount; i++) {
      const offset = 84 + i * 50;
      const vx = [], vy = [], vz = [];
      for (let v = 0; v < 3; v++) {
        vx.push(buf.readFloatLE(offset + 12 + v * 12));
        vy.push(buf.readFloatLE(offset + 12 + v * 12 + 4));
        vz.push(buf.readFloatLE(offset + 12 + v * 12 + 8));
      }
      // Check if this triangle is on the top surface
      const avgZ = (vz[0] + vz[1] + vz[2]) / 3;
      if (avgZ >= topThreshold) {
        // Triangle centroid and area (using cross product)
        const cx = (vx[0] + vx[1] + vx[2]) / 3;
        const cy = (vy[0] + vy[1] + vy[2]) / 3;
        const ax = vx[1] - vx[0], ay = vy[1] - vy[0], az = vz[1] - vz[0];
        const bx = vx[2] - vx[0], by = vy[2] - vy[0], bz = vz[2] - vz[0];
        const area = 0.5 * Math.sqrt(
          (ay*bz - az*by)**2 + (az*bx - ax*bz)**2 + (ax*by - ay*bx)**2
        );
        topSumX += cx * area;
        topSumY += cy * area;
        topArea += area;
      }
    }

    // Use top-surface centroid if available, else bounding box center
    const surfaceCenterX = topArea > 0 ? topSumX / topArea : (maxX + minX) / 2;
    const surfaceCenterY = topArea > 0 ? topSumY / topArea : (maxY + minY) / 2;

    return {
      minX, maxX, minY, maxY, minZ, maxZ,
      width: maxX - minX,
      depth: maxY - minY,
      height,
      centerX: surfaceCenterX,
      centerY: surfaceCenterY,
      // Also keep bounding box center for reference
      bboxCenterX: (maxX + minX) / 2,
      bboxCenterY: (maxY + minY) / 2,
    };
  } catch (e) {
    return null;
  }
}

// ── Repair non-manifold STL ───────────────────────────────────
// OpenSCAD 2021 CGAL requires watertight meshes. Tinkercad often
// exports STLs with non-manifold edges (>2 faces sharing an edge).
// This repairs the mesh by rebuilding it: deduplicating vertices,
// removing degenerate/duplicate faces, and filling small holes.
function repairStl(srcPath, dstPath) {
  const buf = fs.readFileSync(srcPath);
  const triCount = buf.readUInt32LE(80);

  // Parse all triangles
  const vertMap = new Map(); // "x,y,z" -> index
  const verts = [];
  const faces = [];

  function getVertIdx(x, y, z) {
    // Round to avoid floating-point near-duplicates
    const key = `${x.toFixed(5)},${y.toFixed(5)},${z.toFixed(5)}`;
    if (vertMap.has(key)) return vertMap.get(key);
    const idx = verts.length;
    verts.push([x, y, z]);
    vertMap.set(key, idx);
    return idx;
  }

  for (let i = 0; i < triCount; i++) {
    const off = 84 + i * 50;
    const nx = buf.readFloatLE(off);
    const ny = buf.readFloatLE(off + 4);
    const nz = buf.readFloatLE(off + 8);
    const v = [];
    for (let j = 0; j < 3; j++) {
      const x = buf.readFloatLE(off + 12 + j * 12);
      const y = buf.readFloatLE(off + 12 + j * 12 + 4);
      const z = buf.readFloatLE(off + 12 + j * 12 + 8);
      v.push(getVertIdx(x, y, z));
    }
    // Skip degenerate faces (two or more vertices the same)
    if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) continue;
    faces.push({ v, normal: [nx, ny, nz] });
  }

  // Remove duplicate faces (same 3 vertex indices in any order)
  const faceSet = new Set();
  const uniqueFaces = [];
  for (const face of faces) {
    const key = [...face.v].sort((a, b) => a - b).join(',');
    if (faceSet.has(key)) continue;
    faceSet.add(key);
    uniqueFaces.push(face);
  }

  // Build edge map to find non-manifold edges
  const edgeMap = new Map();
  for (let fi = 0; fi < uniqueFaces.length; fi++) {
    const f = uniqueFaces[fi];
    for (let e = 0; e < 3; e++) {
      const a = f.v[e], b = f.v[(e + 1) % 3];
      const key = [Math.min(a, b), Math.max(a, b)].join(',');
      if (!edgeMap.has(key)) edgeMap.set(key, []);
      edgeMap.get(key).push(fi);
    }
  }

  // Remove faces that create non-manifold edges (keep first 2 per edge)
  const removeFaces = new Set();
  for (const [, faceIndices] of edgeMap) {
    if (faceIndices.length > 2) {
      for (let i = 2; i < faceIndices.length; i++) {
        removeFaces.add(faceIndices[i]);
      }
    }
  }

  const cleanFaces = uniqueFaces.filter((_, i) => !removeFaces.has(i));

  // Rebuild edge map after removals to find boundary edges (holes)
  const edgeMap2 = new Map();
  for (let fi = 0; fi < cleanFaces.length; fi++) {
    const f = cleanFaces[fi];
    for (let e = 0; e < 3; e++) {
      const a = f.v[e], b = f.v[(e + 1) % 3];
      const key = [Math.min(a, b), Math.max(a, b)].join(',');
      edgeMap2.set(key, (edgeMap2.get(key) || 0) + 1);
    }
  }

  // Find boundary edges (shared by only 1 face = hole)
  const boundaryEdges = [];
  for (const [key, count] of edgeMap2) {
    if (count === 1) {
      const [a, b] = key.split(',').map(Number);
      boundaryEdges.push([a, b]);
    }
  }

  // Fill holes with fan triangulation
  // Group boundary edges into loops
  const newFaces = [];
  if (boundaryEdges.length > 0) {
    const edgeAdj = new Map();
    for (const [a, b] of boundaryEdges) {
      if (!edgeAdj.has(a)) edgeAdj.set(a, []);
      if (!edgeAdj.has(b)) edgeAdj.set(b, []);
      edgeAdj.get(a).push(b);
      edgeAdj.get(b).push(a);
    }

    const visited = new Set();
    for (const startVert of edgeAdj.keys()) {
      if (visited.has(startVert)) continue;
      // Walk the loop
      const loop = [startVert];
      visited.add(startVert);
      let current = startVert;
      while (true) {
        const neighbors = edgeAdj.get(current) || [];
        const next = neighbors.find(n => !visited.has(n));
        if (next === undefined) break;
        loop.push(next);
        visited.add(next);
        current = next;
      }
      // Create fan triangles to fill the hole
      if (loop.length >= 3) {
        const center = loop[0];
        for (let i = 1; i < loop.length - 1; i++) {
          newFaces.push({
            v: [center, loop[i + 1], loop[i]], // reversed winding to face inward
            normal: [0, 0, 0] // OpenSCAD recomputes normals
          });
        }
      }
    }
  }

  const allFaces = [...cleanFaces, ...newFaces];

  // Write repaired binary STL
  const outBuf = Buffer.alloc(84 + allFaces.length * 50);
  buf.copy(outBuf, 0, 0, 80); // preserve header
  outBuf.writeUInt32LE(allFaces.length, 80);
  for (let i = 0; i < allFaces.length; i++) {
    const off = 84 + i * 50;
    const f = allFaces[i];
    outBuf.writeFloatLE(f.normal[0], off);
    outBuf.writeFloatLE(f.normal[1], off + 4);
    outBuf.writeFloatLE(f.normal[2], off + 8);
    for (let j = 0; j < 3; j++) {
      const v = verts[f.v[j]];
      outBuf.writeFloatLE(v[0], off + 12 + j * 12);
      outBuf.writeFloatLE(v[1], off + 12 + j * 12 + 4);
      outBuf.writeFloatLE(v[2], off + 12 + j * 12 + 8);
    }
    outBuf.writeUInt16LE(0, off + 48); // attribute byte count
  }
  fs.writeFileSync(dstPath, outBuf);
  return {
    originalTris: triCount,
    repairedTris: allFaces.length,
    removedFaces: removeFaces.size,
    holesPatched: newFaces.length,
    boundaryEdges: boundaryEdges.length,
  };
}

// ── SCAD: TEXT CUTTER (standalone, for manifold boolean) ──────
// Generates the text cutter solid(s) — no import().
// OpenSCAD renders this to an STL, then manifold-3d subtracts it
// from the user's blank STL in Node.js.
// Supports multiple text lines via cfg.lines array.
function buildTextCutterScad(cfg) {
  const bounds = readStlBounds(cfg.baseStlPath);
  if (!bounds) return null;

  const actualThickness = bounds.height;
  const cutDepth = cfg.pocketDepth + 0.2;
  const lines = cfg.lines || [{ text: cfg.name, font: cfg.font, fontSize: cfg.fontSize, textXOffset: cfg.textXOffset, textYOffset: cfg.textYOffset }];

  let scad = `// ============================================================
// BRCC Keychain — TEXT CUTTER (for boolean subtraction)
// Lines: ${lines.map(l => l.text).join(', ')}
// ============================================================

tag_thickness = ${actualThickness.toFixed(2)};
pocket_clear  = ${cfg.pocketClearance};
cut_depth     = ${cutDepth.toFixed(2)};

`;

  // Generate a cutter module for each line
  lines.forEach((line, i) => {
    const fs_size = line.fontSize || autoFontSize(line.text, DEFAULTS.fontSize);
    const font = line.font || cfg.font || DEFAULTS.font;
    const tx = (bounds.centerX + (line.textXOffset || 0)).toFixed(2);
    const ty = (bounds.centerY + (line.textYOffset || 0)).toFixed(2);
    console.log(`[DogTag] Line ${i+1} "${line.text}": drag=(${(line.textXOffset||0).toFixed(2)}, ${(line.textYOffset||0).toFixed(2)}) + center=(${bounds.centerX.toFixed(2)}, ${bounds.centerY.toFixed(2)}) => SCAD=(${tx}, ${ty})`);

    scad += `// Line ${i + 1}: "${line.text}"
translate([${tx}, ${ty}, tag_thickness - cut_depth])
linear_extrude(height = cut_depth + 0.01)
  offset(r = pocket_clear, $fn = 16)
    text("${line.text}", size = ${fs_size.toFixed(2)}, font = "${font}",
         halign = "center", valign = "center");

`;
  });

  return scad;
}

// ── SCAD: STANDALONE NAME (text only, no base plate) ─────────
// Generates extruded text with optional offset to connect letters.
function buildStandaloneNameScad(cfg) {
  return `// ============================================================
// BRCC Keychain — STANDALONE NAME
// Text: ${cfg.text}
// ============================================================

font           = "${cfg.font || DEFAULTS.font}";
name_text      = "${cfg.text}";
font_size      = ${(cfg.fontSize || 10).toFixed(2)};
thickness      = ${(cfg.thickness || 3.0).toFixed(2)};
connect_expand = ${(cfg.connectExpand || 0).toFixed(2)};

linear_extrude(height = thickness)
  offset(r = connect_expand, $fn = 16)
    text(name_text, size = font_size, font = font,
         halign = "center", valign = "center");
`;
}

// ── MANIFOLD BOOLEAN: subtract text cutter STL from blank STL ──
// Uses manifold-3d (same engine as OpenSCAD 2024+) which handles
// non-manifold meshes that OpenSCAD 2021 CGAL cannot.
// Runs in a child process to avoid WASM issues in Electron main process.
const cp = require('child_process');

async function manifoldSubtract(baseStlPath, cutterStlPath, outputPath) {
  const workerScript = path.join(__dirname, 'manifold-worker.js');

  // Find a real Node.js binary (not electron.exe)
  // In Electron, process.execPath is electron.exe which can't run plain scripts
  let nodeBin = 'node';
  if (process.versions.electron) {
    // We're inside Electron — use system node
    nodeBin = process.platform === 'win32' ? 'node.exe' : 'node';
  } else {
    nodeBin = process.execPath; // Already plain Node.js
  }

  return new Promise((resolve, reject) => {
    // Set cwd to project root so require('manifold-3d/...') resolves from node_modules
    const projectRoot = path.join(__dirname, '..');
    const child = cp.spawn(nodeBin, [workerScript, baseStlPath, cutterStlPath, outputPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: projectRoot,
      timeout: 120000,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('close', (code) => {
      if (code !== 0) {
        let msg = `Worker exited with code ${code}`;
        try {
          const parsed = JSON.parse(stderr.trim());
          if (parsed.error) msg = parsed.error;
        } catch (_) {
          if (stderr.trim()) msg = stderr.trim().slice(0, 300);
        }
        console.error(`[DogTag] Manifold worker failed: ${msg}`);
        return reject(new Error(msg));
      }

      try {
        const lines = stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        const result = JSON.parse(lastLine);
        if (result.success) {
          console.log(`[DogTag] Manifold: base vol=${result.baseVol.toFixed(1)}, cutter vol=${result.cutterVol.toFixed(1)} → result vol=${result.volume.toFixed(1)} (${result.triCount} tris)`);
          resolve(result);
        } else {
          console.error(`[DogTag] Manifold worker error: ${result.error}`);
          reject(new Error(result.error));
        }
      } catch (parseErr) {
        console.error('[DogTag] Failed to parse manifold worker output:', stdout.slice(0, 300));
        reject(new Error('Manifold worker produced invalid output'));
      }
    });

    child.on('error', (err) => {
      console.error(`[DogTag] Manifold worker spawn error: ${err.message}`);
      reject(err);
    });
  });
}

// (v1 fallback shape code removed — all shapes are now user-uploaded STL blanks)

// ── SCAD: TEXT INSERT (same for both modes) ──────────────────
// lineOverride: optional { text, font, fontSize } for multi-line support
function buildTextInsert(cfg, lineOverride) {
  const text = lineOverride ? lineOverride.text : cfg.name;
  const font = lineOverride ? (lineOverride.font || cfg.font) : cfg.font;
  const fs_size = lineOverride ? (lineOverride.fontSize || autoFontSize(text, DEFAULTS.fontSize)) : (cfg.fontSize || autoFontSize(cfg.name, DEFAULTS.fontSize));
  const slabH   = (cfg.pocketDepth - 0.05).toFixed(2);
  const letterH = cfg.insertHeight.toFixed(2);

  return `// ============================================================
// BRCC Keychain — TEXT INSERT - Print in COLOR B
// Text: ${text}
// ============================================================
// PRINT IN: Color B (accent/name color)
// Print FLAT on bed. No supports needed.
// Press into pocket of base tag after both are printed.
// ============================================================

font      = "${font}";
pet_name  = "${text}";
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

  // Clamp font size so text fits within STL (or shape) width
  // Liberation Sans Bold uppercase averages ~0.62x font_size per char
  if (baseStlPath && fs.existsSync(baseStlPath)) {
    const bounds = readStlBounds(baseStlPath);
    if (bounds) {
      const charW = 0.62;
      const estW = cleanName.length * charW * cfg.fontSize;
      const maxW = bounds.width * 0.80; // 80% of STL width
      if (estW > maxW) {
        const clamped = maxW / (cleanName.length * charW);
        console.log(`[DogTag] Font clamped: ${cfg.fontSize.toFixed(1)}→${clamped.toFixed(1)}mm for "${cleanName}" (${cleanName.length} chars, STL width ${bounds.width.toFixed(0)}mm)`);
        cfg.fontSize = clamped;
      }
    }
  } else if (sd.width) {
    const charW = 0.62;
    const estW = cleanName.length * charW * cfg.fontSize;
    const maxW = sd.width * 0.80;
    if (estW > maxW) {
      cfg.fontSize = maxW / (cleanName.length * charW);
    }
  }

  fs.mkdirSync(outputDir, { recursive: true });

  const baseScadPath   = path.join(outputDir, `tag_base_${safeShape}_${safeFile}.scad`);
  const insertScadPath = path.join(outputDir, `tag_insert_${safeShape}_${safeFile}.scad`);

  const isStlImport = baseStlPath && fs.existsSync(baseStlPath);
  if (!isStlImport) {
    throw new Error(`No STL blank found for shape "${safeShape}". Upload a base plate STL first.`);
  }

  // Build lines array for multi-line support
  const lines = (options.lines || []).map(l => ({
    text: (l.text || '').trim().toUpperCase().replace(/[^A-Z0-9\s]/g, '').slice(0, 20),
    font: l.font || cfg.font,
    fontSize: l.fontSize || null,
    textXOffset: l.textXOffset ?? cfg.textXOffset,
    textYOffset: l.textYOffset ?? cfg.textYOffset,
  })).filter(l => l.text.length > 0);

  // Fallback: if no lines provided, use single name
  if (lines.length === 0) {
    lines.push({ text: cleanName, font: cfg.font, fontSize: cfg.fontSize, textXOffset: cfg.textXOffset, textYOffset: cfg.textYOffset });
  }

  // Auto-scale font per line if not set
  lines.forEach(l => {
    if (!l.fontSize) l.fontSize = autoFontSize(l.text, shapeCfg.fontSize || sd.fontSize || DEFAULTS.fontSize);
  });

  // Pass lines to cfg for cutter
  cfg.lines = lines;

  // Build SCAD files — STL-import mode only
  let cutterScadPath = null;
  const cutterContent = buildTextCutterScad(cfg);
  if (cutterContent) {
    cutterScadPath = path.join(outputDir, `tag_cutter_${safeShape}_${safeFile}.scad`);
    fs.writeFileSync(cutterScadPath, cutterContent);
  }
  const bounds = readStlBounds(baseStlPath);
  const refContent = `// Reference SCAD — base STL is generated via manifold-3d boolean\n// Blank: ${path.basename(baseStlPath)}\n// Dims: ${bounds ? bounds.width.toFixed(1) + ' x ' + bounds.depth.toFixed(1) + ' x ' + bounds.height.toFixed(1) : 'unknown'} mm\n`;
  fs.writeFileSync(baseScadPath, refContent);

  // Generate insert SCAD(s) — one per line
  const insertScadPaths = [];
  lines.forEach((line, i) => {
    const suffix = lines.length > 1 ? `_line${i + 1}` : '';
    const insertPath = path.join(outputDir, `tag_insert${suffix}_${safeShape}_${safeFile}.scad`);
    const insertContent = buildTextInsert(cfg, line);
    fs.writeFileSync(insertPath, insertContent);
    insertScadPaths.push(insertPath);
  });

  return {
    baseSCAD:    baseScadPath,
    textSCAD:    insertScadPaths[0],       // backward compat: line 1
    textSCADs:   insertScadPaths,          // all lines
    cutterSCAD:  cutterScadPath,
    blankStl:    baseStlPath,
    petName:     cleanName,
    shape:       safeShape,
    mode:        'stl-import',
    lines,
    config:      cfg,
    printNotes: {
      baseColor:   'Color A — keychain body',
      insertColor: 'Color B — text accent',
      layerHeight: '0.15mm for crisp text edges',
      supports:    'None — print both flat',
      assembly:    'Press insert into pocket. Optional CA glue.',
    },
  };
}

// ── STANDALONE NAME GENERATOR ────────────────────────────────
async function generateStandaloneName({
  text,
  font = DEFAULTS.font,
  fontSize = 10,
  thickness = 3.0,
  connectExpand = 0.3,
  outputDir = '.',
}) {
  if (!text || text.trim().length === 0) throw new Error('Text is required');

  const cleanText = text.trim().toUpperCase().replace(/[^A-Z0-9\s]/g, '').slice(0, 20);
  if (cleanText.length === 0) throw new Error('Text must contain alphanumeric characters');
  const safeFile = cleanText.replace(/\s+/g, '_');

  fs.mkdirSync(outputDir, { recursive: true });

  const scadPath = path.join(outputDir, `standalone_${safeFile}.scad`);
  const scadContent = buildStandaloneNameScad({ text: cleanText, font, fontSize, thickness, connectExpand });
  fs.writeFileSync(scadPath, scadContent);

  return {
    scadPath,
    text: cleanText,
    font,
    fontSize,
    thickness,
    connectExpand,
    mode: 'standalone',
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
  generateStandaloneName,
  manifoldSubtract,
  autoFontSize,
  readStlBounds,
  loadShapesConfig,
  saveShapesConfig,
  getShapeGeometry,
  getAllShapeGeometry,
  DEFAULTS,
  SHAPE_DEFAULTS,
  FONT_LIST,
};
