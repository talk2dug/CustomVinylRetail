const fs = require('fs');
const path = require('path');

/**
 * Parse an STL file and extract metadata.
 * Handles both binary and ASCII formats.
 * Returns: { format, triangleCount, dimensions: {x,y,z}, boundingBox, fileSize }
 */
function parseStlFile(filePath) {
  const stat = fs.statSync(filePath);
  const buffer = fs.readFileSync(filePath);

  const isAscii = detectAscii(buffer);
  let triangleCount = 0;
  let boundingBox = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };

  if (isAscii) {
    const result = parseAscii(buffer.toString('utf8'));
    triangleCount = result.triangleCount;
    boundingBox = result.boundingBox;
  } else {
    const result = parseBinary(buffer);
    triangleCount = result.triangleCount;
    boundingBox = result.boundingBox;
  }

  const dimensions = {
    x: boundingBox.maxX === -Infinity ? 0 : Math.round((boundingBox.maxX - boundingBox.minX) * 100) / 100,
    y: boundingBox.maxY === -Infinity ? 0 : Math.round((boundingBox.maxY - boundingBox.minY) * 100) / 100,
    z: boundingBox.maxZ === -Infinity ? 0 : Math.round((boundingBox.maxZ - boundingBox.minZ) * 100) / 100
  };

  return {
    format: isAscii ? 'ascii' : 'binary',
    triangleCount,
    dimensions,
    boundingBox,
    fileSize: stat.size
  };
}

/**
 * Detect if STL is ASCII format.
 * ASCII STL starts with "solid" and contains "facet normal".
 * Binary STL has an 80-byte header followed by a 4-byte triangle count.
 */
function detectAscii(buffer) {
  // Check if starts with "solid"
  const header = buffer.slice(0, 80).toString('utf8').trim();
  if (!header.startsWith('solid')) return false;

  // Some binary files can start with "solid" in header text
  // Check if file contains "facet normal" to confirm ASCII
  const sample = buffer.slice(0, Math.min(buffer.length, 1000)).toString('utf8');
  return sample.includes('facet normal') || sample.includes('facet\n');
}

/**
 * Parse ASCII STL format.
 */
function parseAscii(text) {
  let triangleCount = 0;
  const boundingBox = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };

  const vertexRegex = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
  let match;
  let vertexCount = 0;

  while ((match = vertexRegex.exec(text)) !== null) {
    const x = parseFloat(match[1]);
    const y = parseFloat(match[2]);
    const z = parseFloat(match[3]);

    if (!isNaN(x) && !isNaN(y) && !isNaN(z)) {
      boundingBox.minX = Math.min(boundingBox.minX, x);
      boundingBox.maxX = Math.max(boundingBox.maxX, x);
      boundingBox.minY = Math.min(boundingBox.minY, y);
      boundingBox.maxY = Math.max(boundingBox.maxY, y);
      boundingBox.minZ = Math.min(boundingBox.minZ, z);
      boundingBox.maxZ = Math.max(boundingBox.maxZ, z);
      vertexCount++;
    }
  }

  triangleCount = Math.floor(vertexCount / 3);

  return { triangleCount, boundingBox };
}

/**
 * Parse binary STL format.
 * Layout: 80-byte header | 4-byte uint32 triangle count | N * 50-byte triangles
 * Each triangle: 12-byte normal + 3 * 12-byte vertices + 2-byte attribute
 */
function parseBinary(buffer) {
  const boundingBox = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };

  if (buffer.length < 84) {
    return { triangleCount: 0, boundingBox };
  }

  const triangleCount = buffer.readUInt32LE(80);

  // Each triangle is 50 bytes: 12 (normal) + 36 (3 vertices * 12) + 2 (attribute)
  const expectedSize = 84 + (triangleCount * 50);
  const actualTriangles = Math.min(triangleCount, Math.floor((buffer.length - 84) / 50));

  for (let i = 0; i < actualTriangles; i++) {
    const offset = 84 + (i * 50);

    // Skip normal (12 bytes), read 3 vertices
    for (let v = 0; v < 3; v++) {
      const vOffset = offset + 12 + (v * 12);
      if (vOffset + 12 > buffer.length) break;

      const x = buffer.readFloatLE(vOffset);
      const y = buffer.readFloatLE(vOffset + 4);
      const z = buffer.readFloatLE(vOffset + 8);

      if (isFinite(x) && isFinite(y) && isFinite(z)) {
        boundingBox.minX = Math.min(boundingBox.minX, x);
        boundingBox.maxX = Math.max(boundingBox.maxX, x);
        boundingBox.minY = Math.min(boundingBox.minY, y);
        boundingBox.maxY = Math.max(boundingBox.maxY, y);
        boundingBox.minZ = Math.min(boundingBox.minZ, z);
        boundingBox.maxZ = Math.max(boundingBox.maxZ, z);
      }
    }
  }

  return { triangleCount: actualTriangles, boundingBox };
}

/**
 * Recursively walk a directory and find all .stl files.
 */
async function walkForStlFiles(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      results.push(...await walkForStlFiles(fullPath));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.stl')) {
      results.push(fullPath);
    }
  }

  return results;
}

module.exports = { parseStlFile, walkForStlFiles };
