/**
 * 3MF File Parser
 * Extracts mesh objects and plate definitions from 3MF archives.
 * Supports PrusaSlicer, BambuStudio, and OrcaSlicer 3MF formats.
 *
 * 3MF is a ZIP archive containing:
 *   - 3D/3dmodel.model (XML with mesh data and build items)
 *   - 3D/Objects/*.model (BambuStudio per-object models)
 *   - Metadata/plate_N.json (BambuStudio/OrcaSlicer plate definitions)
 */

const AdmZip = require('adm-zip');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ---------------------------------------------------------------------------
// XML helpers (no external deps — 3MF XML is very structured)
// ---------------------------------------------------------------------------

function extractTag(xml, tagName) {
  // Returns array of { attrs, inner } for all occurrences of <tagName ...>...</tagName>
  // Also handles self-closing <tagName ... />
  const results = [];
  const openPattern = new RegExp(`<${tagName}(\\s[^>]*)?>`, 'gi');
  let match;
  while ((match = openPattern.exec(xml)) !== null) {
    const attrStr = match[1] || '';
    const attrs = parseAttrs(attrStr);
    const afterOpen = match.index + match[0].length;

    if (match[0].endsWith('/>')) {
      results.push({ attrs, inner: '' });
      continue;
    }

    // Find closing tag (handle nesting by counting)
    let depth = 1;
    let pos = afterOpen;
    const openRe = new RegExp(`<${tagName}(\\s|>|/>)`, 'gi');
    const closeRe = new RegExp(`</${tagName}\\s*>`, 'gi');
    openRe.lastIndex = pos;
    closeRe.lastIndex = pos;

    let closeMatch;
    while (depth > 0) {
      closeMatch = closeRe.exec(xml);
      if (!closeMatch) break;
      // Count opens between pos and closeMatch
      openRe.lastIndex = pos;
      let om;
      while ((om = openRe.exec(xml)) !== null && om.index < closeMatch.index) {
        if (!om[0].endsWith('/>')) depth++;
      }
      depth--;
      pos = closeMatch.index + closeMatch[0].length;
    }

    const endIdx = closeMatch ? closeMatch.index : xml.length;
    results.push({ attrs, inner: xml.slice(afterOpen, endIdx) });
  }
  return results;
}

function extractSelfClosing(xml, tagName) {
  const results = [];
  const re = new RegExp(`<${tagName}\\s([^>]*?)\\s*/>`, 'gi');
  let m;
  while ((m = re.exec(xml)) !== null) {
    results.push(parseAttrs(m[1]));
  }
  return results;
}

function parseAttrs(str) {
  const attrs = {};
  const re = /(\w[\w:.|-]*)="([^"]*)"/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

// ---------------------------------------------------------------------------
// Mesh extraction
// ---------------------------------------------------------------------------

function parseMeshFromXml(xml) {
  // Parse <vertex x="" y="" z=""/> and <triangle v1="" v2="" v3=""/>
  const vertices = [];
  const triangles = [];

  const vertexRe = /<vertex\s+x="([^"]+)"\s+y="([^"]+)"\s+z="([^"]+)"\s*\/>/gi;
  let m;
  while ((m = vertexRe.exec(xml)) !== null) {
    vertices.push([parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])]);
  }

  const triRe = /<triangle\s+v1="([^"]+)"\s+v2="([^"]+)"\s+v3="([^"]+)"[^/]*\/>/gi;
  while ((m = triRe.exec(xml)) !== null) {
    triangles.push([parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)]);
  }

  return { vertices, triangles };
}

function parseObjectsFromModel(xml) {
  const objects = {};
  const objTags = extractTag(xml, 'object');

  for (const obj of objTags) {
    const id = obj.attrs.id;
    if (!id) continue;

    const name = obj.attrs.name || obj.attrs['p:name'] || obj.attrs['3mf:name'] || null;
    const type = obj.attrs.type || 'model';

    // Check for mesh
    const meshTags = extractTag(obj.inner, 'mesh');
    let mesh = null;
    if (meshTags.length > 0) {
      mesh = parseMeshFromXml(meshTags[0].inner);
    }

    // Check for components (assembly references)
    const components = extractSelfClosing(obj.inner, 'component');

    objects[id] = { id, name, type, mesh, components };
  }

  return objects;
}

function parseBuildItems(xml) {
  const buildTags = extractTag(xml, 'build');
  if (!buildTags.length) return [];

  return extractSelfClosing(buildTags[0].inner, 'item').map(attrs => ({
    objectid: attrs.objectid,
    transform: attrs.transform || null,
    printable: attrs.printable !== '0'
  }));
}

// ---------------------------------------------------------------------------
// Resolve assembled objects (components → flat meshes)
// ---------------------------------------------------------------------------

function applyTransform(vertices, transformStr) {
  if (!transformStr) return vertices;
  const vals = transformStr.split(/\s+/).map(Number);
  if (vals.length < 12) return vertices;

  // 3MF transform is a 4x3 affine matrix stored row-major:
  // [m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32]
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22, m30, m31, m32] = vals;

  return vertices.map(([x, y, z]) => [
    m00 * x + m10 * y + m20 * z + m30,
    m01 * x + m11 * y + m21 * z + m31,
    m02 * x + m12 * y + m22 * z + m32
  ]);
}

function flattenObject(objId, objects, transform, visited) {
  if (!visited) visited = new Set();
  if (visited.has(objId)) return { vertices: [], triangles: [] };
  visited.add(objId);

  const obj = objects[objId];
  if (!obj) return { vertices: [], triangles: [] };

  // If object has a direct mesh, use it
  if (obj.mesh && obj.mesh.vertices.length > 0) {
    let verts = obj.mesh.vertices;
    if (transform) verts = applyTransform(verts, transform);
    return { vertices: verts, triangles: [...obj.mesh.triangles] };
  }

  // Otherwise, resolve components
  if (obj.components && obj.components.length > 0) {
    const allVerts = [];
    const allTris = [];

    for (const comp of obj.components) {
      const compId = comp.objectid;
      const compTransform = comp.transform || null;
      const resolved = flattenObject(compId, objects, compTransform, visited);

      const offset = allVerts.length;
      allVerts.push(...resolved.vertices);
      for (const tri of resolved.triangles) {
        allTris.push([tri[0] + offset, tri[1] + offset, tri[2] + offset]);
      }
    }

    if (transform) {
      const transformed = applyTransform(allVerts, transform);
      return { vertices: transformed, triangles: allTris };
    }
    return { vertices: allVerts, triangles: allTris };
  }

  return { vertices: [], triangles: [] };
}

// ---------------------------------------------------------------------------
// Binary STL writer
// ---------------------------------------------------------------------------

function writeBinaryStl(filePath, vertices, triangles) {
  const triCount = triangles.length;
  const buf = Buffer.alloc(84 + triCount * 50);

  // 80-byte header
  buf.write('Binary STL from 3MF import', 0, 80, 'ascii');
  // Triangle count
  buf.writeUInt32LE(triCount, 80);

  let offset = 84;
  for (const [v1i, v2i, v3i] of triangles) {
    const v1 = vertices[v1i] || [0, 0, 0];
    const v2 = vertices[v2i] || [0, 0, 0];
    const v3 = vertices[v3i] || [0, 0, 0];

    // Compute face normal
    const ux = v2[0] - v1[0], uy = v2[1] - v1[1], uz = v2[2] - v1[2];
    const wx = v3[0] - v1[0], wy = v3[1] - v1[1], wz = v3[2] - v1[2];
    let nx = uy * wz - uz * wy;
    let ny = uz * wx - ux * wz;
    let nz = ux * wy - uy * wx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 0) { nx /= len; ny /= len; nz /= len; }

    buf.writeFloatLE(nx, offset); offset += 4;
    buf.writeFloatLE(ny, offset); offset += 4;
    buf.writeFloatLE(nz, offset); offset += 4;

    buf.writeFloatLE(v1[0], offset); offset += 4;
    buf.writeFloatLE(v1[1], offset); offset += 4;
    buf.writeFloatLE(v1[2], offset); offset += 4;

    buf.writeFloatLE(v2[0], offset); offset += 4;
    buf.writeFloatLE(v2[1], offset); offset += 4;
    buf.writeFloatLE(v2[2], offset); offset += 4;

    buf.writeFloatLE(v3[0], offset); offset += 4;
    buf.writeFloatLE(v3[1], offset); offset += 4;
    buf.writeFloatLE(v3[2], offset); offset += 4;

    // Attribute byte count
    buf.writeUInt16LE(0, offset); offset += 2;
  }

  fs.writeFileSync(filePath, buf);
}

// ---------------------------------------------------------------------------
// Plate detection
// ---------------------------------------------------------------------------

function detectBambuPlates(zip) {
  const plates = [];
  for (const entry of zip.getEntries()) {
    const m = entry.entryName.match(/Metadata\/plate_(\d+)\.json$/i);
    if (m) {
      try {
        const data = JSON.parse(entry.getData().toString('utf-8'));
        plates.push({ index: parseInt(m[1], 10), data });
      } catch {}
    }
  }
  plates.sort((a, b) => a.index - b.index);
  return plates;
}

function detectPrusaPlates(zip) {
  // PrusaSlicer stores plate info in Metadata/Slic3r_PE_model.config
  // Each <plate> element lists the objects on it
  for (const entry of zip.getEntries()) {
    if (entry.entryName.match(/Metadata\/Slic3r_PE_model\.config$/i)) {
      try {
        const xml = entry.getData().toString('utf-8');
        const plateTags = extractTag(xml, 'plate');
        if (plateTags.length > 1) {
          // Multi-plate PrusaSlicer project
          return plateTags.map((pt, idx) => {
            const instances = extractSelfClosing(pt.inner, 'instance');
            return {
              index: idx + 1,
              instances: instances.map(inst => ({
                object_id: inst.object_id,
                instance_id: inst.instance_id || '0'
              }))
            };
          });
        }
      } catch {}
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Main parse function
// ---------------------------------------------------------------------------

function parse3MF(filePath) {
  const zip = new AdmZip(filePath);
  const entries = zip.getEntries();

  // Collect all model XML sources
  let mainModelXml = null;
  const subModels = {}; // path -> xml

  for (const entry of entries) {
    const name = entry.entryName;
    if (/^3D\/3dmodel\.model$/i.test(name)) {
      mainModelXml = entry.getData().toString('utf-8');
    } else if (/^3D\/Objects\/.*\.model$/i.test(name)) {
      subModels[name] = entry.getData().toString('utf-8');
    } else if (/\.model$/i.test(name) && !mainModelXml) {
      mainModelXml = entry.getData().toString('utf-8');
    }
  }

  if (!mainModelXml) throw new Error('No 3D model found in 3MF file');

  // Parse objects from main model
  const objects = parseObjectsFromModel(mainModelXml);

  // Parse sub-model objects (BambuStudio style)
  for (const [subPath, subXml] of Object.entries(subModels)) {
    const subObjects = parseObjectsFromModel(subXml);
    for (const [id, obj] of Object.entries(subObjects)) {
      // Prefix sub-model IDs to avoid collision
      const prefix = subPath.replace(/[^a-zA-Z0-9]/g, '_');
      objects[`${prefix}_${id}`] = obj;
      // Also store under original id if not already present (BambuStudio references by original id)
      if (!objects[id]) objects[id] = obj;
    }
  }

  // Parse build items from main model
  const buildItems = parseBuildItems(mainModelXml);

  // Detect plates
  const bambuPlates = detectBambuPlates(zip);
  const prusaPlates = detectPrusaPlates(zip);

  // Resolve which objects are on which plate
  let plates = [];

  if (bambuPlates.length > 0) {
    // BambuStudio/OrcaSlicer plate format
    for (const bp of bambuPlates) {
      const plateObjects = [];
      if (bp.data && bp.data.objects) {
        for (const po of bp.data.objects) {
          const objId = String(po.obj_id || po.identify_id || po.id);
          plateObjects.push({ objectId: objId, instances: po.instances || [{}] });
        }
      }
      plates.push({
        index: bp.index,
        name: bp.data?.name || `Plate ${bp.index}`,
        objects: plateObjects
      });
    }
  } else if (prusaPlates.length > 1) {
    // PrusaSlicer multi-plate
    for (const pp of prusaPlates) {
      const plateObjects = pp.instances.map(inst => ({
        objectId: inst.object_id,
        instances: [{}]
      }));
      plates.push({
        index: pp.index,
        name: `Plate ${pp.index}`,
        objects: plateObjects
      });
    }
  } else {
    // Single plate — all build items go on one plate
    const plateObjects = buildItems
      .filter(bi => bi.printable !== false)
      .map(bi => ({
        objectId: bi.objectid,
        instances: [{}]
      }));
    if (plateObjects.length > 0) {
      plates.push({
        index: 1,
        name: 'Plate 1',
        objects: plateObjects
      });
    }
  }

  // If no plates were found at all, create one plate per object
  if (plates.length === 0) {
    const objIds = Object.keys(objects).filter(id => {
      const obj = objects[id];
      return obj.mesh && obj.mesh.vertices.length > 0;
    });
    if (objIds.length > 0) {
      plates.push({
        index: 1,
        name: 'Plate 1',
        objects: objIds.map(id => ({ objectId: id, instances: [{}] }))
      });
    }
  }

  return { objects, buildItems, plates };
}

// ---------------------------------------------------------------------------
// Extract to temp STL files and build plate definitions
// ---------------------------------------------------------------------------

function extract3MFToStls(filePath) {
  const { objects, buildItems, plates } = parse3MF(filePath);
  const tempDir = path.join(os.tmpdir(), `3mf-import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(tempDir, { recursive: true });

  const baseName = path.basename(filePath, path.extname(filePath)).replace(/[^a-zA-Z0-9_\-. ]/g, '_');

  // Collect unique object IDs referenced by plates
  const referencedIds = new Set();
  for (const plate of plates) {
    for (const po of plate.objects) {
      referencedIds.add(String(po.objectId));
    }
  }

  // If no plates reference anything, include all objects with meshes
  if (referencedIds.size === 0) {
    for (const [id, obj] of Object.entries(objects)) {
      if (obj.mesh && obj.mesh.vertices.length > 0) {
        referencedIds.add(id);
      }
    }
  }

  // Flatten and write each referenced object as an STL
  const stlMap = {}; // objectId -> { filePath, name, triangleCount }

  for (const objId of referencedIds) {
    const obj = objects[objId];
    if (!obj) continue;

    const { vertices, triangles } = flattenObject(objId, objects, null, new Set());
    if (vertices.length === 0 || triangles.length === 0) continue;

    const objName = obj.name || `${baseName}_object_${objId}`;
    const safeName = objName.replace(/[^a-zA-Z0-9_\-. ]/g, '_');
    let stlPath = path.join(tempDir, `${safeName}.stl`);

    // Avoid collisions
    let counter = 1;
    while (fs.existsSync(stlPath)) {
      stlPath = path.join(tempDir, `${safeName}_${counter}.stl`);
      counter++;
    }

    writeBinaryStl(stlPath, vertices, triangles);

    stlMap[objId] = {
      filePath: stlPath,
      name: objName.replace(/[_-]/g, ' '),
      triangleCount: triangles.length
    };
  }

  // Build plate definitions referencing extracted STLs
  const plateDefinitions = plates.map(plate => {
    const items = [];
    for (const po of plate.objects) {
      const stlInfo = stlMap[String(po.objectId)];
      if (!stlInfo) continue;
      const qty = po.instances ? po.instances.length : 1;
      items.push({
        objectId: String(po.objectId),
        stlFilePath: stlInfo.filePath,
        stlName: stlInfo.name,
        qty: Math.max(1, qty)
      });
    }
    return {
      index: plate.index,
      name: plate.name,
      items
    };
  }).filter(p => p.items.length > 0);

  return {
    tempDir,
    baseName,
    stlFiles: Object.entries(stlMap).map(([objId, info]) => ({
      objectId: objId,
      ...info
    })),
    plates: plateDefinitions,
    totalObjects: Object.keys(stlMap).length,
    totalPlates: plateDefinitions.length
  };
}

module.exports = { parse3MF, extract3MFToStls };
