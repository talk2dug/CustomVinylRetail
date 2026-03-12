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
const SLICER_PATH = process.env.PRUSA_SLICER_PATH || '/home/ubuntu/vinylApp/squashfs-root-2.8.1/usr/bin/prusa-slicer';

// Concurrency control: only one PrusaSlicer process at a time to prevent CPU overload
const MAX_CONCURRENT_SLICES = 1;
const SLICER_THREADS = 4; // Cap threads so server stays responsive (8 cores total)
let activeSlices = 0;
const sliceQueue = [];

function acquireSliceLock() {
  return new Promise((resolve) => {
    if (activeSlices < MAX_CONCURRENT_SLICES) {
      activeSlices++;
      resolve();
    } else {
      sliceQueue.push(resolve);
    }
  });
}

function releaseSliceLock() {
  activeSlices--;
  if (sliceQueue.length > 0 && activeSlices < MAX_CONCURRENT_SLICES) {
    activeSlices++;
    const next = sliceQueue.shift();
    next();
  }
}

// ============================================================================
// AUTO-ORIENT STL — Rotate model for best build plate placement
// ============================================================================

const os = require('os');

/**
 * Parse a binary STL file into arrays of triangles with normals and vertices.
 * Returns { triangleCount, normals: Float32Array, vertices: Float32Array }
 */
function parseSTLBinary(buffer) {
  // Binary STL: 80-byte header, 4-byte uint32 triangle count, then 50 bytes per triangle
  const dataView = new DataView(buffer.buffer || buffer, buffer.byteOffset || 0);
  const triangleCount = dataView.getUint32(80, true);
  const normals = new Float32Array(triangleCount * 3);
  const vertices = new Float32Array(triangleCount * 9);

  for (let i = 0; i < triangleCount; i++) {
    const offset = 84 + i * 50;
    // Normal
    normals[i * 3]     = dataView.getFloat32(offset, true);
    normals[i * 3 + 1] = dataView.getFloat32(offset + 4, true);
    normals[i * 3 + 2] = dataView.getFloat32(offset + 8, true);
    // Vertex 1
    vertices[i * 9]     = dataView.getFloat32(offset + 12, true);
    vertices[i * 9 + 1] = dataView.getFloat32(offset + 16, true);
    vertices[i * 9 + 2] = dataView.getFloat32(offset + 20, true);
    // Vertex 2
    vertices[i * 9 + 3] = dataView.getFloat32(offset + 24, true);
    vertices[i * 9 + 4] = dataView.getFloat32(offset + 28, true);
    vertices[i * 9 + 5] = dataView.getFloat32(offset + 32, true);
    // Vertex 3
    vertices[i * 9 + 6] = dataView.getFloat32(offset + 36, true);
    vertices[i * 9 + 7] = dataView.getFloat32(offset + 40, true);
    vertices[i * 9 + 8] = dataView.getFloat32(offset + 44, true);
  }

  return { triangleCount, normals, vertices };
}

/**
 * Compute the area of a triangle given 3 vertices (9 floats: v0x,v0y,v0z,v1x,v1y,v1z,v2x,v2y,v2z)
 */
function triangleArea(v, offset) {
  const ax = v[offset + 3] - v[offset], ay = v[offset + 4] - v[offset + 1], az = v[offset + 5] - v[offset + 2];
  const bx = v[offset + 6] - v[offset], by = v[offset + 7] - v[offset + 1], bz = v[offset + 8] - v[offset + 2];
  const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
  return 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
}

/**
 * Find the best "bottom face" normal by clustering triangle normals weighted by area.
 * Uses hemisphere quantization — buckets normals by direction, picks the largest cluster.
 * Returns the normal vector [nx, ny, nz] that should face downward.
 */
function findBestBottomNormal(normals, vertices, triangleCount) {
  // Quantize each normal to a bucket (angular resolution ~15°)
  const buckets = new Map();
  const ANGULAR_RES = 15; // degrees
  const RAD = Math.PI / 180;

  for (let i = 0; i < triangleCount; i++) {
    let nx = normals[i * 3], ny = normals[i * 3 + 1], nz = normals[i * 3 + 2];
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len < 1e-8) continue;
    nx /= len; ny /= len; nz /= len;

    // Compute area
    const area = triangleArea(vertices, i * 9);
    if (area < 1e-10) continue;

    // Quantize normal direction (spherical coords)
    const theta = Math.round(Math.acos(Math.max(-1, Math.min(1, nz))) / (ANGULAR_RES * RAD));
    const phi = Math.round(Math.atan2(ny, nx) / (ANGULAR_RES * RAD));
    const key = `${theta},${phi}`;

    if (buckets.has(key)) {
      const b = buckets.get(key);
      b.area += area;
      b.nx += nx * area;
      b.ny += ny * area;
      b.nz += nz * area;
    } else {
      buckets.set(key, { area, nx: nx * area, ny: ny * area, nz: nz * area });
    }
  }

  // Find largest bucket
  let bestBucket = null;
  let bestArea = 0;
  for (const b of buckets.values()) {
    if (b.area > bestArea) {
      bestArea = b.area;
      bestBucket = b;
    }
  }

  if (!bestBucket) return [0, 0, -1]; // Default: no rotation needed

  // Normalize the area-weighted normal
  const len = Math.sqrt(bestBucket.nx ** 2 + bestBucket.ny ** 2 + bestBucket.nz ** 2);
  if (len < 1e-8) return [0, 0, -1];

  return [bestBucket.nx / len, bestBucket.ny / len, bestBucket.nz / len];
}

/**
 * Build rotation matrix to align vector 'from' to vector 'to'.
 * Uses Rodrigues' rotation formula.
 * Returns 3x3 matrix as [r00, r01, r02, r10, r11, r12, r20, r21, r22]
 */
function rotationMatrixFromTo(from, to) {
  // Cross product
  const cx = from[1] * to[2] - from[2] * to[1];
  const cy = from[2] * to[0] - from[0] * to[2];
  const cz = from[0] * to[1] - from[1] * to[0];
  const sinA = Math.sqrt(cx * cx + cy * cy + cz * cz);
  const cosA = from[0] * to[0] + from[1] * to[1] + from[2] * to[2];

  if (sinA < 1e-8) {
    // Vectors are parallel
    if (cosA > 0) return [1, 0, 0, 0, 1, 0, 0, 0, 1]; // same direction
    // Opposite direction — rotate 180° around any perpendicular axis
    // Pick axis with least alignment to 'from'
    let ax = 1, ay = 0, az = 0;
    if (Math.abs(from[0]) > 0.9) { ax = 0; ay = 1; }
    // Cross with from to get perpendicular axis
    const px = from[1] * az - from[2] * ay;
    const py = from[2] * ax - from[0] * az;
    const pz = from[0] * ay - from[1] * ax;
    const plen = Math.sqrt(px * px + py * py + pz * pz);
    const ux = px / plen, uy = py / plen, uz = pz / plen;
    // 180° rotation around [ux, uy, uz]: R = 2 * u*u^T - I
    return [
      2 * ux * ux - 1, 2 * ux * uy,     2 * ux * uz,
      2 * uy * ux,     2 * uy * uy - 1,  2 * uy * uz,
      2 * uz * ux,     2 * uz * uy,      2 * uz * uz - 1
    ];
  }

  // Skew-symmetric cross-product matrix
  const vx = cx / sinA, vy = cy / sinA, vz = cz / sinA;
  const t = 1 - cosA;
  return [
    cosA + vx * vx * t,      vx * vy * t - vz * sinA,  vx * vz * t + vy * sinA,
    vy * vx * t + vz * sinA, cosA + vy * vy * t,       vy * vz * t - vx * sinA,
    vz * vx * t - vy * sinA, vz * vy * t + vx * sinA,  cosA + vz * vz * t
  ];
}

/**
 * Auto-orient an STL file for optimal build plate placement.
 * Finds the largest flat face and rotates the model so it sits flat on Z=0.
 * Writes a rotated copy to a temp file.
 * @param {string} stlPath - Path to the original STL
 * @returns {string|null} - Path to the rotated temp STL, or null if no rotation needed
 */
function autoOrientSTL(stlPath) {
  const fileBuffer = fs.readFileSync(stlPath);

  // Check if ASCII STL (starts with "solid")
  const header = fileBuffer.slice(0, 5).toString('ascii');
  if (header === 'solid' && fileBuffer.indexOf(0x00, 0, 80) === -1) {
    console.log('[Slicer] Auto-orient: ASCII STL detected, skipping (binary only)');
    return null;
  }

  const { triangleCount, normals, vertices } = parseSTLBinary(fileBuffer);
  if (triangleCount < 4) return null;

  // Find the dominant flat face normal
  const bottomNormal = findBestBottomNormal(normals, vertices, triangleCount);

  // We want this normal to point DOWN (-Z), so we rotate bottomNormal → [0, 0, -1]
  const target = [0, 0, -1];
  const dot = bottomNormal[0] * target[0] + bottomNormal[1] * target[1] + bottomNormal[2] * target[2];

  // If already aligned (within ~10°), skip rotation
  if (dot > 0.985) {
    console.log('[Slicer] Auto-orient: Model already well-oriented, skipping');
    return null;
  }

  const R = rotationMatrixFromTo(bottomNormal, target);

  // Apply rotation to all vertices
  const rotatedVertices = new Float32Array(vertices.length);
  for (let i = 0; i < vertices.length; i += 3) {
    const x = vertices[i], y = vertices[i + 1], z = vertices[i + 2];
    rotatedVertices[i]     = R[0] * x + R[1] * y + R[2] * z;
    rotatedVertices[i + 1] = R[3] * x + R[4] * y + R[5] * z;
    rotatedVertices[i + 2] = R[6] * x + R[7] * y + R[8] * z;
  }

  // Also rotate normals
  const rotatedNormals = new Float32Array(normals.length);
  for (let i = 0; i < normals.length; i += 3) {
    const nx = normals[i], ny = normals[i + 1], nz = normals[i + 2];
    rotatedNormals[i]     = R[0] * nx + R[1] * ny + R[2] * nz;
    rotatedNormals[i + 1] = R[3] * nx + R[4] * ny + R[5] * nz;
    rotatedNormals[i + 2] = R[6] * nx + R[7] * ny + R[8] * nz;
  }

  // Shift model so min Z = 0 (ensure it sits on the build plate)
  let minZ = Infinity;
  for (let i = 2; i < rotatedVertices.length; i += 3) {
    if (rotatedVertices[i] < minZ) minZ = rotatedVertices[i];
  }
  if (minZ !== 0) {
    for (let i = 2; i < rotatedVertices.length; i += 3) {
      rotatedVertices[i] -= minZ;
    }
  }

  // Write rotated binary STL to temp file
  const outputSize = 84 + triangleCount * 50;
  const outputBuffer = Buffer.alloc(outputSize);

  // Copy original 80-byte header
  fileBuffer.copy(outputBuffer, 0, 0, 80);
  // Triangle count
  outputBuffer.writeUInt32LE(triangleCount, 80);

  const dv = new DataView(outputBuffer.buffer, outputBuffer.byteOffset);
  for (let i = 0; i < triangleCount; i++) {
    const off = 84 + i * 50;
    // Normal
    dv.setFloat32(off, rotatedNormals[i * 3], true);
    dv.setFloat32(off + 4, rotatedNormals[i * 3 + 1], true);
    dv.setFloat32(off + 8, rotatedNormals[i * 3 + 2], true);
    // Vertex 1
    dv.setFloat32(off + 12, rotatedVertices[i * 9], true);
    dv.setFloat32(off + 16, rotatedVertices[i * 9 + 1], true);
    dv.setFloat32(off + 20, rotatedVertices[i * 9 + 2], true);
    // Vertex 2
    dv.setFloat32(off + 24, rotatedVertices[i * 9 + 3], true);
    dv.setFloat32(off + 28, rotatedVertices[i * 9 + 4], true);
    dv.setFloat32(off + 32, rotatedVertices[i * 9 + 5], true);
    // Vertex 3
    dv.setFloat32(off + 36, rotatedVertices[i * 9 + 6], true);
    dv.setFloat32(off + 40, rotatedVertices[i * 9 + 7], true);
    dv.setFloat32(off + 44, rotatedVertices[i * 9 + 8], true);
    // Attribute byte count (copy original)
    const origAttr = fileBuffer.readUInt16LE(84 + i * 50 + 48);
    outputBuffer.writeUInt16LE(origAttr, off + 48);
  }

  const tmpPath = path.join(os.tmpdir(), `oriented_${path.basename(stlPath)}`);
  fs.writeFileSync(tmpPath, outputBuffer);

  console.log(`[Slicer] Auto-orient: Rotated ${path.basename(stlPath)} (dot=${dot.toFixed(3)}) → ${tmpPath}`);
  return tmpPath;
}

// ============================================================================
// TRANSFORM BAKING — apply client-side transforms into STL vertex data
// ============================================================================

/**
 * Check if a transform differs from identity (no-op).
 */
function hasNonIdentityTransform(t) {
  return (t.rx || 0) !== 0 || (t.ry || 0) !== 0 || (t.rz || 0) !== 0 ||
         ((t.scale || 1) !== 1) || (t.posX || 0) !== 0 || (t.posZ || 0) !== 0;
}

/**
 * Build a 3x3 rotation+scale matrix from Euler angles and uniform scale.
 *
 * Coordinate system mapping:
 *   THREE.js (client): X = right, Y = up, Z = toward camera
 *   STL/PrusaSlicer:   X = right, Y = depth, Z = up
 *
 * The client stores rotations as THREE.js rotateX/Y/Z incremental Euler angles.
 * In the THREE.js Y-up system:
 *   rotateX(rx) = rotation around X axis
 *   rotateY(ry) = rotation around Y axis (up)
 *   rotateZ(rz) = rotation around Z axis
 *
 * We need to remap to Z-up for the STL file:
 *   THREE Y-up → STL Z-up coordinate swap: (x, y, z) → (x, z, -y)
 *   But since bpLoadAllModels applies rotations to geometry BEFORE computing the
 *   centered bounding box (in Y-up space), and the STL is already in its native
 *   coordinate system, we apply the same rotation matrix in the STL's own space.
 *
 * Since the STL files are parsed in their native coordinate system (typically Z-up),
 * and the Three.js loader preserves the raw vertex data, the rotation that the client
 * applied in Y-up space to the geometry (via geometry.rotateX/Y/Z) is equivalent to
 * applying the same rotations to the raw STL vertices. The centering translation
 * and Y-floor are baked afterward.
 */
function buildRotationMatrix(rx, ry, rz) {
  // Rotation around X axis
  const cosX = Math.cos(rx), sinX = Math.sin(rx);
  const Rx = [
    1,    0,     0,
    0, cosX, -sinX,
    0, sinX,  cosX
  ];

  // Rotation around Y axis
  const cosY = Math.cos(ry), sinY = Math.sin(ry);
  const Ry = [
     cosY, 0, sinY,
        0, 1,    0,
    -sinY, 0, cosY
  ];

  // Rotation around Z axis
  const cosZ = Math.cos(rz), sinZ = Math.sin(rz);
  const Rz = [
    cosZ, -sinZ, 0,
    sinZ,  cosZ, 0,
       0,     0, 1
  ];

  // Combined: R = Rz * Ry * Rx (same order as THREE.js default Euler 'XYZ')
  // Actually THREE.js rotateX/Y/Z are incremental object-space rotations,
  // which means: final = Rz * Ry * Rx applied in that order
  function mul3x3(A, B) {
    const C = new Array(9);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
      }
    }
    return C;
  }

  return mul3x3(Rz, mul3x3(Ry, Rx));
}

/**
 * Bake a transform (rotation, scale, position) into an STL file.
 * Returns path to a temp file with the baked STL, or null if transform is identity.
 *
 * @param {string} stlPath - Path to the original STL file
 * @param {object} transform - { rx, ry, rz, scale, posX, posZ }
 * @param {string|number} stlId - STL ID for naming the temp file
 * @returns {string|null} - Path to baked temp STL, or null
 */
function bakeTransformToSTL(stlPath, transform, stlId) {
  if (!transform._forceBake && !hasNonIdentityTransform(transform)) return null;

  const fileBuffer = fs.readFileSync(stlPath);

  // Check if ASCII STL. Use size-based validation: binary STLs have
  // exactly 84 + triangleCount * 50 bytes, where triangleCount is at offset 80.
  // Many binary STLs start with "solid" in their text header — don't rely on
  // null-byte detection which produces false positives for those files.
  if (fileBuffer.length >= 84) {
    const expectedBinarySize = 84 + fileBuffer.readUInt32LE(80) * 50;
    const header5 = fileBuffer.slice(0, 5).toString('ascii');
    if (header5 === 'solid' && fileBuffer.length !== expectedBinarySize) {
      console.log('[Slicer] Transform bake: ASCII STL detected (size mismatch), skipping');
      return null;
    }
  } else {
    console.log('[Slicer] Transform bake: file too small to be valid STL, skipping');
    return null;
  }

  const { triangleCount, normals, vertices } = parseSTLBinary(fileBuffer);
  if (triangleCount < 1) return null;

  const rx = transform.rx || 0;
  const ry = transform.ry || 0;
  const rz = transform.rz || 0;
  const scale = transform.scale || 1;
  const posX = transform.posX || 0;
  const posZ = transform.posZ || 0;

  // Build rotation matrix.
  //
  // The Three.js preview converts STL Z-up → Three.js Y-up via rotateX(-PI/2).
  // User rotations in that Y-up space need to be converted back to STL Z-up.
  // The conjugation Rx(PI/2) * R_threejs * Rx(-PI/2) gives:
  //   R_stl = Ry(-threejs_rz) * Rz(threejs_ry) * Rx(threejs_rx)
  // Applied directly to raw STL vertices (no Y↔Z swap needed).
  const hasRotation = (rx !== 0 || ry !== 0 || rz !== 0);
  let R;
  if (hasRotation) {
    // Build Rx(rx), Rz(ry), Ry(-rz) and multiply: R = Ry(-rz) * Rz(ry) * Rx(rx)
    const cx1 = Math.cos(rx), sx1 = Math.sin(rx);
    const cz1 = Math.cos(ry), sz1 = Math.sin(ry);
    const cy1 = Math.cos(rz), sy1 = Math.sin(rz);
    const Rx1 = [1, 0, 0, 0, cx1, -sx1, 0, sx1, cx1];
    const Rz1 = [cz1, -sz1, 0, sz1, cz1, 0, 0, 0, 1];
    const Ry1 = [cy1, 0, -sy1, 0, 1, 0, sy1, 0, cy1]; // Ry(-rz): negated off-diagonals
    function mul(A, B) {
      const C = new Array(9);
      for (let r = 0; r < 3; r++)
        for (let c = 0; c < 3; c++)
          C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
      return C;
    }
    R = mul(Ry1, mul(Rz1, Rx1));
  }

  // Apply rotation + scale to vertices (no coordinate swap — R_stl is already in STL space)
  const bakedVertices = new Float32Array(vertices.length);
  if (hasRotation) {
    for (let i = 0; i < vertices.length; i += 3) {
      const x = vertices[i], y = vertices[i + 1], z = vertices[i + 2];
      bakedVertices[i]     = (R[0] * x + R[1] * y + R[2] * z) * scale;
      bakedVertices[i + 1] = (R[3] * x + R[4] * y + R[5] * z) * scale;
      bakedVertices[i + 2] = (R[6] * x + R[7] * y + R[8] * z) * scale;
    }
  } else {
    for (let i = 0; i < vertices.length; i += 3) {
      bakedVertices[i]     = vertices[i] * scale;
      bakedVertices[i + 1] = vertices[i + 1] * scale;
      bakedVertices[i + 2] = vertices[i + 2] * scale;
    }
  }

  // Apply rotation to normals (no scale, no coordinate swap)
  const bakedNormals = new Float32Array(normals.length);
  if (hasRotation) {
    for (let i = 0; i < normals.length; i += 3) {
      const nx = normals[i], ny = normals[i + 1], nz = normals[i + 2];
      bakedNormals[i]     = R[0] * nx + R[1] * ny + R[2] * nz;
      bakedNormals[i + 1] = R[3] * nx + R[4] * ny + R[5] * nz;
      bakedNormals[i + 2] = R[6] * nx + R[7] * ny + R[8] * nz;
    }
  } else {
    bakedNormals.set(normals);
  }

  // Center the model on its own XY footprint (matching what bpLoadAllModels does)
  // The client centers geometry in XZ (which maps to XY in STL Z-up),
  // then positions at posX, posZ on the bed.
  // In STL coordinates: X = bed X, Y = bed Y (depth), Z = height
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity;
  for (let i = 0; i < bakedVertices.length; i += 3) {
    if (bakedVertices[i] < minX) minX = bakedVertices[i];
    if (bakedVertices[i] > maxX) maxX = bakedVertices[i];
    if (bakedVertices[i + 1] < minY) minY = bakedVertices[i + 1];
    if (bakedVertices[i + 1] > maxY) maxY = bakedVertices[i + 1];
    if (bakedVertices[i + 2] < minZ) minZ = bakedVertices[i + 2];
  }

  // Center in XY, floor to Z=0
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  for (let i = 0; i < bakedVertices.length; i += 3) {
    bakedVertices[i]     -= cx;
    bakedVertices[i + 1] -= cy;
    bakedVertices[i + 2] -= minZ; // floor to Z=0
  }

  // Now translate to the bed position.
  // Client: mesh.position.x = bed X position (center of model on bed)
  // Client: mesh.position.z = bed Y position (depth on bed, center of model)
  // STL: X = bed X, Y = bed Y
  // The client positions represent the center of the model on the bed,
  // so we translate directly.
  for (let i = 0; i < bakedVertices.length; i += 3) {
    bakedVertices[i]     += posX;  // Client X → STL X
    bakedVertices[i + 1] += posZ;  // Client Z (depth) → STL Y
  }

  // Write baked binary STL to temp file
  const outputSize = 84 + triangleCount * 50;
  const outputBuffer = Buffer.alloc(outputSize);

  // Copy original 80-byte header
  fileBuffer.copy(outputBuffer, 0, 0, 80);
  // Triangle count
  outputBuffer.writeUInt32LE(triangleCount, 80);

  const dv = new DataView(outputBuffer.buffer, outputBuffer.byteOffset);
  for (let i = 0; i < triangleCount; i++) {
    const off = 84 + i * 50;
    // Normal
    dv.setFloat32(off, bakedNormals[i * 3], true);
    dv.setFloat32(off + 4, bakedNormals[i * 3 + 1], true);
    dv.setFloat32(off + 8, bakedNormals[i * 3 + 2], true);
    // Vertex 1
    dv.setFloat32(off + 12, bakedVertices[i * 9], true);
    dv.setFloat32(off + 16, bakedVertices[i * 9 + 1], true);
    dv.setFloat32(off + 20, bakedVertices[i * 9 + 2], true);
    // Vertex 2
    dv.setFloat32(off + 24, bakedVertices[i * 9 + 3], true);
    dv.setFloat32(off + 28, bakedVertices[i * 9 + 4], true);
    dv.setFloat32(off + 32, bakedVertices[i * 9 + 5], true);
    // Vertex 3
    dv.setFloat32(off + 36, bakedVertices[i * 9 + 6], true);
    dv.setFloat32(off + 40, bakedVertices[i * 9 + 7], true);
    dv.setFloat32(off + 44, bakedVertices[i * 9 + 8], true);
    // Attribute byte count (copy original)
    const origAttr = fileBuffer.readUInt16LE(84 + i * 50 + 48);
    outputBuffer.writeUInt16LE(origAttr, off + 48);
  }

  const tmpPath = path.join(os.tmpdir(), `baked_${stlId}_${path.basename(stlPath.trim())}`);
  fs.writeFileSync(tmpPath, outputBuffer);

  console.log(`[Slicer] Transform bake: ${path.basename(stlPath)} → ${tmpPath} (rx=${rx.toFixed(2)} ry=${ry.toFixed(2)} rz=${rz.toFixed(2)} scale=${scale.toFixed(2)} pos=${posX.toFixed(1)},${posZ.toFixed(1)})`);
  return tmpPath;
}

/**
 * Merge multiple binary STL files into a single binary STL.
 * Combines all triangles and updates the triangle count in the header.
 * This preserves absolute vertex positions, so models baked at different
 * bed locations remain correctly placed relative to each other.
 *
 * @param {string[]} stlPaths - Array of paths to binary STL files
 * @returns {string} Path to the merged temp STL file
 */
function mergeSTLFiles(stlPaths) {
  if (stlPaths.length === 1) return stlPaths[0];

  let totalTriangles = 0;
  const allTriangleData = [];

  for (const p of stlPaths) {
    const buf = fs.readFileSync(p);
    if (buf.length < 84) {
      console.warn(`[Slicer] mergeSTL: skipping too-small file ${path.basename(p)}`);
      continue;
    }
    const triCount = buf.readUInt32LE(80);
    const expectedSize = 84 + triCount * 50;
    if (buf.length < expectedSize) {
      console.warn(`[Slicer] mergeSTL: file truncated ${path.basename(p)} (expected ${expectedSize}, got ${buf.length})`);
      continue;
    }
    totalTriangles += triCount;
    allTriangleData.push(buf.slice(84, 84 + triCount * 50));
  }

  const outputSize = 84 + totalTriangles * 50;
  const outputBuffer = Buffer.alloc(outputSize);

  // Header: 80 bytes (copy from first file)
  const firstBuf = fs.readFileSync(stlPaths[0]);
  firstBuf.copy(outputBuffer, 0, 0, 80);

  // Triangle count
  outputBuffer.writeUInt32LE(totalTriangles, 80);

  // Concatenate triangle data
  let offset = 84;
  for (const triData of allTriangleData) {
    triData.copy(outputBuffer, offset);
    offset += triData.length;
  }

  const tmpPath = path.join(os.tmpdir(), `merged_plate_${Date.now()}.stl`);
  fs.writeFileSync(tmpPath, outputBuffer);
  console.log(`[Slicer] Merged ${stlPaths.length} STLs → ${tmpPath} (${totalTriangles} triangles, ${(outputSize / 1024 / 1024).toFixed(1)}MB)`);
  return tmpPath;
}

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
  light:  { infill: 10, perimeters: 2, top_layers: 4, bottom_layers: 3, fill_pattern: 'gyroid',       label: 'Light',  description: 'Decorative, minimal strength' },
  normal: { infill: 20, perimeters: 3, top_layers: 5, bottom_layers: 4, fill_pattern: 'gyroid',       label: 'Normal', description: 'Everyday use' },
  strong: { infill: 40, perimeters: 4, top_layers: 5, bottom_layers: 5, fill_pattern: 'gyroid',       label: 'Strong', description: 'Structural, load-bearing' },
  solid:  { infill: 100, perimeters: 4, top_layers: 6, bottom_layers: 6, fill_pattern: 'rectilinear', label: 'Solid', description: 'Maximum strength, heaviest' }
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

const SURFACE_MAP = {
  standard:   { top_fill: 'monotonic',  ironing: false,                                                     label: 'Standard',   description: 'Clean monotonic top surface' },
  polished:   { top_fill: 'monotonic',  ironing: true, ironing_flowrate: '15%', ironing_spacing: 0.1, ironing_speed: 15, label: 'Polished',   description: 'Ironed smooth top, for premium products' },
  concentric: { top_fill: 'concentric', ironing: false,                                                     label: 'Concentric', description: 'Circular pattern, best for round shapes' }
};

const SUPPORTS_MAP = {
  none:       { enabled: false, label: 'None',       description: 'No support material' },
  light:      { enabled: true,  threshold: 55, buildplate_only: true,  style: 'organic', contact_distance: 0.3, interface_layers: 2, bottom_interface_layers: 0, interface_spacing: 0.3, support_spacing: 3.5, label: 'Light',      description: 'Minimal organic supports, easy removal' },
  full:       { enabled: true,  threshold: 45, buildplate_only: true,  style: 'organic', contact_distance: 0.3, interface_layers: 2, bottom_interface_layers: 0, interface_spacing: 0.3, support_spacing: 3.5, label: 'Full',       description: 'More supports for complex overhangs' },
  everywhere: { enabled: true,  threshold: 30, buildplate_only: false, style: 'organic', contact_distance: 0.3, interface_layers: 2, bottom_interface_layers: 0, interface_spacing: 0.3, support_spacing: 3.5, label: 'Everywhere', description: 'Supports from all surfaces' }
};

const MATERIALS_MAP = {
  pla:        { hotend: 210, bed: 60,  retract_length: 0.8, retract_speed: 60, label: 'PLA',        description: 'Standard, easy to print' },
  petg:       { hotend: 235, bed: 80,  retract_length: 1.0, retract_speed: 50, label: 'PETG',       description: 'Durable, heat resistant' },
  abs:        { hotend: 250, bed: 100, retract_length: 0.8, retract_speed: 60, label: 'ABS',        description: 'Strong, needs enclosure' },
  tpu:        { hotend: 225, bed: 60,  retract_length: 1.5, retract_speed: 25, label: 'TPU',        description: 'Flexible, rubber-like' },
  rapid_pla:  { hotend: 220, bed: 60,  retract_length: 0.8, retract_speed: 60, label: 'Rapid PLA',  description: 'High-speed PLA' },
  rapid_petg: { hotend: 250, bed: 80,  retract_length: 1.0, retract_speed: 50, label: 'Rapid PETG', description: 'High-speed PETG' }
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

// Print profile presets — one-click settings bundles (overrides individual settings)
const PRINT_PROFILE_PRESETS = {
  custom: {
    label: 'Custom', description: 'Set each option individually', category: 'general',
    overrides: null
  },
  'multiboard-standard': {
    label: 'Multiboard — Standard',
    description: 'Official spec: 3 walls, 15% infill, random seam, no supports',
    category: 'multiboard',
    overrides: {
      layer_height: 0.2, perimeters: 3, top_layers: 4, bottom_layers: 4,
      infill: 15, fill_pattern: 'gyroid',
      seam_position: 'random', ironing: false, supports: false,
      speed_multiplier: 1.0, fuzzy_skin: 'none', brim_width: 0
    },
    // Closest existing preset keys for visual button highlighting
    visual: { quality: 'standard', strength: 'normal', speed: 'normal', texture: 'smooth', surface: 'standard', supports: 'none' }
  },
  'multiboard-market': {
    label: 'Multiboard — Market Grade',
    description: 'Extra durability for retail: 4 walls, 25% infill',
    category: 'multiboard',
    overrides: {
      layer_height: 0.2, perimeters: 4, top_layers: 5, bottom_layers: 5,
      infill: 25, fill_pattern: 'gyroid',
      seam_position: 'random', ironing: false, supports: false,
      speed_multiplier: 1.0, fuzzy_skin: 'none', brim_width: 0
    },
    visual: { quality: 'standard', strength: 'strong', speed: 'normal', texture: 'smooth', surface: 'standard', supports: 'none' }
  },
  'multiboard-heavy-duty': {
    label: 'Multiboard — Heavy Duty',
    description: 'Max strength: 5 walls, 40% infill, 0.15mm layers',
    category: 'multiboard',
    overrides: {
      layer_height: 0.15, perimeters: 5, top_layers: 6, bottom_layers: 6,
      infill: 40, fill_pattern: 'gyroid',
      seam_position: 'random', ironing: false, supports: false,
      speed_multiplier: 0.7, fuzzy_skin: 'none', brim_width: 0
    },
    visual: { quality: 'fine', strength: 'strong', speed: 'slow', texture: 'smooth', surface: 'standard', supports: 'none' }
  },
  'multiboard-stack': {
    label: 'Multiboard — Stack',
    description: 'Vertically stacked tiles with ironing between each for clean separation',
    hint: 'Copies are stacked on top of each other (not side by side). Ironing between each tile creates a smooth release layer so they snap apart after printing. Set Copies to the number of tiles you want in the stack.',
    category: 'multiboard',
    stackVertical: true,  // Stack copies in Z instead of XY grid
    overrides: {
      layer_height: 0.2, perimeters: 3, top_layers: 4, bottom_layers: 4,
      infill: 15, fill_pattern: 'gyroid',
      seam_position: 'random', ironing: true, supports: false,
      speed_multiplier: 1.0, fuzzy_skin: 'none', brim_width: 0,
      ironing_type: 'top', ironing_flowrate: 15, ironing_spacing: 0.1, ironing_speed: 15
    },
    visual: { quality: 'standard', strength: 'normal', speed: 'normal', texture: 'smooth', surface: 'polished', supports: 'none' }
  }
};

// ============================================================================
// SETTINGS → CLI ARGS
// ============================================================================

/**
 * Map human-readable options to PrusaSlicer CLI arguments.
 * If options.profile points to a preset with overrides, those values
 * are used directly instead of the individual preset maps.
 */
function mapOptionsToSlicerArgs(options) {
  const args = [];

  // ── Profile override: use exact values instead of preset maps ──
  const profilePreset = PRINT_PROFILE_PRESETS[options.profile];
  if (profilePreset && profilePreset.overrides) {
    const o = profilePreset.overrides;
    const material = MATERIALS_MAP[options.material] || MATERIALS_MAP.pla;

    // Quality
    args.push('--layer-height', String(o.layer_height));

    // Strength
    args.push('--fill-density', `${o.infill}%`);
    args.push('--fill-pattern', o.fill_pattern);
    args.push('--perimeters', String(o.perimeters));
    args.push('--top-solid-layers', String(o.top_layers));
    args.push('--bottom-solid-layers', String(o.bottom_layers));

    // Seam position
    args.push('--seam-position', o.seam_position);

    // Brim
    if (o.brim_width > 0) args.push('--brim-width', String(o.brim_width));

    // Speed — use high-speed values for rapid materials on Kobra printers
    const isRapidMaterial = (options.material || '').startsWith('rapid_');
    const isKobra = (options.printer_model || '').startsWith('kobra');
    const useHighSpeed = isRapidMaterial && isKobra && profilePreset.category !== 'general';

    let perimeterSpeed, extPerimeterSpeed, infillSpeed, travelSpeed, solidInfillSpeed, topSolidSpeed, firstLayerSpeed;
    if (useHighSpeed) {
      // Kobra 3 + rapid material: push speeds for fast multiboard production
      perimeterSpeed = 200;
      extPerimeterSpeed = 150;
      infillSpeed = 300;
      travelSpeed = 500;
      solidInfillSpeed = 250;
      topSolidSpeed = 150;
      firstLayerSpeed = 50;
    } else {
      // Conservative speeds for standard materials / non-Kobra printers
      const basePerimeter = 45;
      const baseInfill = 80;
      const baseTravel = 150;
      const baseSolidInfill = 60;
      const baseTopSolid = 40;
      const mult = o.speed_multiplier;
      perimeterSpeed = Math.round(basePerimeter * mult);
      extPerimeterSpeed = Math.round(perimeterSpeed * 0.7);
      infillSpeed = Math.round(baseInfill * mult);
      travelSpeed = Math.round(baseTravel * mult);
      solidInfillSpeed = Math.round(baseSolidInfill * mult);
      topSolidSpeed = Math.round(baseTopSolid * mult);
      firstLayerSpeed = 0; // let PrusaSlicer use default
    }
    args.push('--perimeter-speed', String(perimeterSpeed));
    args.push('--external-perimeter-speed', String(extPerimeterSpeed));
    args.push('--infill-speed', String(infillSpeed));
    args.push('--travel-speed', String(travelSpeed));
    args.push('--solid-infill-speed', String(solidInfillSpeed));
    args.push('--top-solid-infill-speed', String(topSolidSpeed));
    if (firstLayerSpeed > 0) {
      args.push('--first-layer-speed', `${firstLayerSpeed}`);
    }

    if (useHighSpeed) {
      console.log(`[Slicer] High-speed mode: Kobra + ${options.material} → perimeter=${perimeterSpeed} infill=${infillSpeed} travel=${travelSpeed}`);
    }

    // Texture
    args.push('--fuzzy-skin', o.fuzzy_skin);

    // Surface / Ironing
    args.push('--top-fill-pattern', 'monotonic');
    if (o.ironing) {
      args.push('--ironing');
      args.push('--ironing-type', o.ironing_type || 'top');
      args.push('--ironing-flowrate', `${o.ironing_flowrate || 15}%`);
      // Ironing speed scales up too for rapid materials
      const ironingSpeed = useHighSpeed ? 50 : (o.ironing_speed || 15);
      args.push('--ironing-speed', String(ironingSpeed));
      args.push('--ironing-spacing', String(o.ironing_spacing || 0.1));
    }

    // Supports
    args.push('--no-support-material');

    // Material (still user-selected)
    args.push('--temperature', String(material.hotend));
    args.push('--first-layer-temperature', String(material.hotend + 5));
    args.push('--bed-temperature', String(material.bed));
    args.push('--first-layer-bed-temperature', String(material.bed + 5));
    args.push('--retract-length', String(material.retract_length));
    args.push('--retract-speed', String(material.retract_speed));

    return args;
  }

  // ── Custom mode: use individual preset maps ──
  const quality = QUALITY_MAP[options.quality] || QUALITY_MAP.standard;
  const strength = STRENGTH_MAP[options.strength] || STRENGTH_MAP.normal;
  const speed = SPEED_MAP[options.speed] || SPEED_MAP.normal;
  const texture = TEXTURE_MAP[options.texture] || TEXTURE_MAP.smooth;
  const surface = SURFACE_MAP[options.surface] || SURFACE_MAP.standard;
  const supports = SUPPORTS_MAP[options.supports] || SUPPORTS_MAP.none;
  const material = MATERIALS_MAP[options.material] || MATERIALS_MAP.pla;

  // Quality
  args.push('--layer-height', String(quality.layer_height));

  // Strength
  args.push('--fill-density', `${strength.infill}%`);
  args.push('--fill-pattern', strength.fill_pattern);
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
  const perimeterSpeed = Math.round(basePerimeter * mult);
  args.push('--perimeter-speed', String(perimeterSpeed));
  args.push('--external-perimeter-speed', String(Math.round(perimeterSpeed * 0.7)));
  args.push('--infill-speed', String(Math.round(baseInfill * mult)));
  args.push('--travel-speed', String(Math.round(baseTravel * mult)));
  args.push('--solid-infill-speed', String(Math.round(baseSolidInfill * mult)));
  args.push('--top-solid-infill-speed', String(Math.round(baseTopSolid * mult)));

  // Texture
  args.push('--fuzzy-skin', texture.fuzzy_skin);

  // Surface finish
  args.push('--top-fill-pattern', surface.top_fill);
  if (surface.ironing) {
    args.push('--ironing');
    args.push('--ironing-type', 'top');
    args.push('--ironing-flowrate', surface.ironing_flowrate || '15%');
    args.push('--ironing-speed', String(surface.ironing_speed || 15));
    args.push('--ironing-spacing', String(surface.ironing_spacing || 0.1));
  }

  // Supports — organic tree supports with optimized interface
  // Always use same extruder for supports (single-extruder printers)
  if (supports.enabled) {
    args.push('--support-material');
    args.push('--support-material-extruder', '0');
    args.push('--support-material-interface-extruder', '0');
    args.push('--support-material-threshold', String(supports.threshold));
    if (supports.style) {
      args.push('--support-material-style', supports.style);
    }
    if (supports.buildplate_only) {
      args.push('--support-material-buildplate-only');
    }
    args.push('--support-material-contact-distance', String(supports.contact_distance));
    args.push('--support-material-interface-layers', String(supports.interface_layers));
    args.push('--support-material-bottom-interface-layers', String(supports.bottom_interface_layers));
    args.push('--support-material-interface-spacing', String(supports.interface_spacing));
    args.push('--support-material-spacing', String(supports.support_spacing));
  } else {
    args.push('--no-support-material');
  }

  // Material temperatures
  args.push('--temperature', String(material.hotend));
  args.push('--first-layer-temperature', String(material.hotend + 5));
  args.push('--bed-temperature', String(material.bed));
  args.push('--first-layer-bed-temperature', String(material.bed + 5));
  args.push('--retract-length', String(material.retract_length));
  args.push('--retract-speed', String(material.retract_speed));

  return args;
}

/**
 * Get concatenated mtimes of all profile files used for slicing.
 * Including this in the cache hash ensures profile edits bust cached G-code.
 */
function getProfileMtimes(options) {
  const files = [
    path.join(PROFILES_DIR, 'printers', (PRINTERS_MAP[options.printer_model] || PRINTERS_MAP.kobra3).profile),
    path.join(PROFILES_DIR, 'filaments', FILAMENT_PROFILES[options.material] || FILAMENT_PROFILES.pla),
    path.join(PROFILES_DIR, 'prints', PRINT_PROFILES[options.quality] || PRINT_PROFILES.standard)
  ];
  return files.map(f => {
    try { return fs.statSync(f).mtimeMs; } catch { return '0'; }
  }).join(':');
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

  // Include profile file mtimes so profile edits bust the cache
  const profileMtimes = getProfileMtimes(options);

  // Include transform in hash so scaled/rotated models bust the cache
  const t = options.transform;
  const transformStr = t ? `${t.rx||0}:${t.ry||0}:${t.rz||0}:${t.scale||1}:${t.posX||0}:${t.posZ||0}` : 'none';

  const settingsStr = [
    fileInfo,
    options.profile || 'custom',
    options.printer_model || 'kobra3',
    options.material || 'pla',
    options.quality || 'standard',
    options.strength || 'normal',
    options.speed || 'normal',
    options.texture || 'smooth',
    options.surface || 'standard',
    options.supports || 'none',
    options.auto_orient ? 'oriented' : 'raw',
    profileMtimes,
    transformStr,
    `copies:${parseInt(options.copies, 10) || 1}`
  ].join('|');

  return crypto.createHash('sha256').update(settingsStr).digest('hex').substring(0, 16);
}

/**
 * Generate SHA256 hash for a multi-STL plate (order-independent)
 */
function generatePlateHash(stlPaths, options) {
  const fileInfos = stlPaths.map(p => {
    try {
      const stat = fs.statSync(p);
      return `${stat.size}:${stat.mtimeMs}`;
    } catch {
      return p;
    }
  }).sort();

  const profileMtimes = getProfileMtimes(options);

  let settingsStr = [
    fileInfos.join('+'),
    options.profile || 'custom',
    options.printer_model || 'kobra3',
    options.material || 'pla',
    options.quality || 'standard',
    options.strength || 'normal',
    options.speed || 'normal',
    options.texture || 'smooth',
    options.surface || 'standard',
    options.supports || 'none',
    options.auto_orient ? 'oriented' : 'raw',
    profileMtimes
  ].join('|');

  // Include per-instance transforms in hash so different arrangements bust cache
  if (options.instance_transforms && options.instance_transforms.length > 0) {
    settingsStr += '|IT:' + JSON.stringify(options.instance_transforms);
  }

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

  // Bake user transform (scale, rotation, position) into a temp STL if provided
  const copies = Math.max(1, Math.min(100, parseInt(options.copies, 10) || 1));
  let bakedPath = null;
  if (options.transform && hasNonIdentityTransform(options.transform)) {
    try {
      // Strip position from the bake — --center handles bed placement for single items,
      // and for copies PrusaSlicer needs the model centered for grid arrangement.
      const bakeTransform = { ...options.transform, posX: 0, posZ: 0 };
      bakedPath = bakeTransformToSTL(stlPath, bakeTransform, options.stl_id || 'single');
    } catch (err) {
      console.warn(`[Slicer] Transform bake failed, using original: ${err.message}`);
    }
  }

  // Auto-orient only if user hasn't manually set a rotation
  const t = options.transform;
  const userSetRotation = t && ((t.rx || 0) !== 0 || (t.ry || 0) !== 0 || (t.rz || 0) !== 0);
  let orientedPath = null;
  if (options.auto_orient && !userSetRotation) {
    try {
      orientedPath = autoOrientSTL(bakedPath || stlPath);
    } catch (err) {
      console.warn(`[Slicer] Auto-orient failed, using original: ${err.message}`);
    }
  }
  const slicePath = orientedPath || bakedPath || stlPath;

  // Calculate bed center from printer build volume (e.g. '250x250x260')
  const [bedX, bedY] = (printerInfo.build || '220x220x250').split('x').map(Number);
  const centerX = bedX / 2;
  const centerY = bedY / 2;

  // For multiple copies, build a merged STL with copies arranged on the bed.
  // PrusaSlicer's --duplicate is unreliable in CLI mode (places items off-bed),
  // so we handle arrangement ourselves and slice the merged result as one model.
  //
  // Stack profiles (e.g. multiboard-stack) arrange copies vertically in Z
  // instead of in an XY grid, so ironing creates separation layers between tiles.
  const profilePresetForCopies = PRINT_PROFILE_PRESETS[options.profile];
  const isVerticalStack = profilePresetForCopies?.stackVertical === true;
  console.log(`[Slicer] Profile: ${options.profile || 'custom'}, copies: ${copies}, stackVertical: ${isVerticalStack}`);
  let actualCopies = copies;
  let mergedCopiesPath = null;
  if (copies > 1 && isVerticalStack) {
    try {
      const stlBuf = fs.readFileSync(slicePath);
      const { triangleCount, normals, vertices } = parseSTLBinary(stlBuf);

      // Compute model Z height
      let minZ = Infinity, maxZ = -Infinity;
      for (let i = 2; i < vertices.length; i += 3) {
        if (vertices[i] < minZ) minZ = vertices[i];
        if (vertices[i] > maxZ) maxZ = vertices[i];
      }
      const modelHeight = maxZ - minZ;

      // Check vertical stack fits within printer Z height
      const [, , bedZ] = (printerInfo.build || '220x220x250').split('x').map(Number);
      const maxStack = Math.max(1, Math.floor(bedZ / modelHeight));
      actualCopies = Math.min(copies, maxStack);

      console.log(`[Slicer] Vertical stack: ${actualCopies} copies, model height ${modelHeight.toFixed(1)}mm, total ${(actualCopies * modelHeight).toFixed(1)}mm (bed Z: ${bedZ}mm)`);

      // Build merged binary STL with copies stacked in Z
      const totalTriangles = triangleCount * actualCopies;
      const outputSize = 84 + totalTriangles * 50;
      const outputBuffer = Buffer.alloc(outputSize);
      stlBuf.copy(outputBuffer, 0, 0, 80); // copy header
      outputBuffer.writeUInt32LE(totalTriangles, 80);

      const dv = new DataView(outputBuffer.buffer, outputBuffer.byteOffset);
      let triIdx = 0;
      for (let layer = 0; layer < actualCopies; layer++) {
        const offsetZ = layer * modelHeight - minZ; // stack each copy on top
        for (let t = 0; t < triangleCount; t++) {
          const outOff = 84 + triIdx * 50;
          // Normal (unchanged)
          dv.setFloat32(outOff, normals[t * 3], true);
          dv.setFloat32(outOff + 4, normals[t * 3 + 1], true);
          dv.setFloat32(outOff + 8, normals[t * 3 + 2], true);
          // Vertices (offset Z only)
          for (let v = 0; v < 3; v++) {
            const si = t * 9 + v * 3;
            dv.setFloat32(outOff + 12 + v * 12,     vertices[si], true);       // X unchanged
            dv.setFloat32(outOff + 12 + v * 12 + 4, vertices[si + 1], true);   // Y unchanged
            dv.setFloat32(outOff + 12 + v * 12 + 8, vertices[si + 2] + offsetZ, true); // Z stacked
          }
          // Attribute byte count
          outputBuffer.writeUInt16LE(0, outOff + 48);
          triIdx++;
        }
      }

      mergedCopiesPath = path.join(os.tmpdir(), `stack_${actualCopies}_${path.basename(slicePath)}`);
      fs.writeFileSync(mergedCopiesPath, outputBuffer);
    } catch (err) {
      console.warn(`[Slicer] Vertical stack failed, falling back to grid: ${err.message}`);
      mergedCopiesPath = null;
    }
  }
  if (copies > 1 && !mergedCopiesPath) {
    try {
      const stlBuf = fs.readFileSync(slicePath);
      const { triangleCount, normals, vertices } = parseSTLBinary(stlBuf);

      // Compute model XY bounding box
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity;
      for (let i = 0; i < vertices.length; i += 3) {
        if (vertices[i] < minX) minX = vertices[i];
        if (vertices[i] > maxX) maxX = vertices[i];
        if (vertices[i + 1] < minY) minY = vertices[i + 1];
        if (vertices[i + 1] > maxY) maxY = vertices[i + 1];
        if (vertices[i + 2] < minZ) minZ = vertices[i + 2];
      }
      const modelW = maxX - minX;
      const modelH = maxY - minY;
      const modelCX = (minX + maxX) / 2;
      const modelCY = (minY + maxY) / 2;

      // Calculate grid that fits on bed
      const gap = 3; // mm between copies
      const margin = 3; // mm from bed edge
      const usableX = bedX - margin * 2;
      const usableY = bedY - margin * 2;
      const maxCols = Math.max(1, Math.floor((usableX + gap) / (modelW + gap)));
      const maxRows = Math.max(1, Math.floor((usableY + gap) / (modelH + gap)));
      actualCopies = Math.min(copies, maxCols * maxRows);

      // Determine cols/rows for the actual count
      let cols = Math.min(maxCols, actualCopies);
      let rows = Math.ceil(actualCopies / cols);
      if (rows > maxRows) { rows = maxRows; cols = Math.ceil(actualCopies / rows); actualCopies = cols * rows; }

      // Calculate grid cell positions centered on the bed
      const gridW = cols * modelW + (cols - 1) * gap;
      const gridH = rows * modelH + (rows - 1) * gap;
      const startX = (bedX - gridW) / 2 + modelW / 2;
      const startY = (bedY - gridH) / 2 + modelH / 2;

      console.log(`[Slicer] Pre-arranging ${actualCopies} copies in ${cols}x${rows} grid (model ${modelW.toFixed(1)}x${modelH.toFixed(1)}mm, bed ${bedX}x${bedY}mm, requested ${copies})`);

      // Build merged binary STL with all copies offset to grid positions
      const totalTriangles = triangleCount * actualCopies;
      const outputSize = 84 + totalTriangles * 50;
      const outputBuffer = Buffer.alloc(outputSize);
      stlBuf.copy(outputBuffer, 0, 0, 80); // copy header
      outputBuffer.writeUInt32LE(totalTriangles, 80);

      const dv = new DataView(outputBuffer.buffer, outputBuffer.byteOffset);
      let triIdx = 0;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (triIdx / triangleCount >= actualCopies) break;
          const offsetX = startX + c * (modelW + gap) - modelCX;
          const offsetY = startY + r * (modelH + gap) - modelCY;
          const offsetZ = -minZ; // floor to Z=0
          for (let t = 0; t < triangleCount; t++) {
            const outOff = 84 + triIdx * 50;
            // Normal (unchanged)
            dv.setFloat32(outOff, normals[t * 3], true);
            dv.setFloat32(outOff + 4, normals[t * 3 + 1], true);
            dv.setFloat32(outOff + 8, normals[t * 3 + 2], true);
            // Vertices (offset to grid position)
            for (let v = 0; v < 3; v++) {
              const si = t * 9 + v * 3;
              dv.setFloat32(outOff + 12 + v * 12,     vertices[si]     + offsetX, true);
              dv.setFloat32(outOff + 12 + v * 12 + 4, vertices[si + 1] + offsetY, true);
              dv.setFloat32(outOff + 12 + v * 12 + 8, vertices[si + 2] + offsetZ, true);
            }
            // Attribute byte count
            outputBuffer.writeUInt16LE(0, outOff + 48);
            triIdx++;
          }
        }
      }

      mergedCopiesPath = path.join(os.tmpdir(), `grid_${actualCopies}_${path.basename(slicePath)}`);
      fs.writeFileSync(mergedCopiesPath, outputBuffer);
    } catch (err) {
      console.warn(`[Slicer] Grid pre-arrange failed, falling back to --duplicate: ${err.message}`);
      mergedCopiesPath = null;
    }
  }

  // Build CLI args — if we pre-arranged, slice the merged STL as one object (no --duplicate)
  const finalSlicePath = mergedCopiesPath || slicePath;
  const cliArgs = [
    '--export-gcode',
    '--dont-arrange',
    '--ensure-on-bed',
    '--center', `${centerX},${centerY}`,
    '--load', printProfile,
    '--load', filamentProfile,
    '--load', printerProfile,
    ...mapOptionsToSlicerArgs(options),
    ...(!mergedCopiesPath && copies > 1 ? ['--duplicate', String(copies)] : []),
    '--output', gcodeAbsPath,
    finalSlicePath
  ];

  // Add thread cap to CLI args so PrusaSlicer doesn't eat all CPU cores
  cliArgs.unshift('--threads', String(SLICER_THREADS));

  console.log(`[Slicer] Slicing: ${path.basename(stlPath)} → ${gcodeFilename} (${actualCopies} copies${mergedCopiesPath ? ', pre-arranged grid' : ''})`);
  console.log(`[Slicer] CLI: ${SLICER_PATH} ${cliArgs.join(' ')}`);

  // Wait for concurrency slot (only 1 PrusaSlicer at a time)
  if (activeSlices >= MAX_CONCURRENT_SLICES) {
    console.log(`[Slicer] Queue: waiting for active slice to finish (${sliceQueue.length} ahead)...`);
  }
  await acquireSliceLock();

  // Spawn PrusaSlicer
  let result;
  try {
    result = await new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const proc = spawn(SLICER_PATH, cliArgs, {
        timeout: 600000, // 10 minute timeout for multi-copy slices
        env: { ...process.env, DISPLAY: '' } // Headless
      });
      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });
      proc.on('close', (code, signal) => {
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          const output = stderr || stdout;
          if (output.includes('gcode path conflicts')) {
            reject(new Error(`Models overlap on the build plate — ${actualCopies > 1 ? `${actualCopies} copies won't fit. Try fewer copies or a smaller model.` : 'the model may be too large for the bed.'}`));
          } else {
            const detail = signal ? `killed by signal ${signal}` : `exited with code ${code}`;
            console.error(`[Slicer] PrusaSlicer ${detail}. stderr: ${output.slice(0, 500)}`);
            reject(new Error(`PrusaSlicer ${detail}: ${output}`));
          }
        }
      });
      proc.on('error', (err) => {
        reject(new Error(`Failed to spawn PrusaSlicer: ${err.message}`));
      });
    });
  } finally {
    // Clean up temp files before releasing lock — avoids race where a queued
    // request with the same stl_id can have its baked file deleted after it's written
    if (mergedCopiesPath) { try { fs.unlinkSync(mergedCopiesPath); } catch {} }
    if (orientedPath) { try { fs.unlinkSync(orientedPath); } catch {} }
    if (bakedPath) { try { fs.unlinkSync(bakedPath); } catch {} }
    releaseSliceLock();
  }

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
    INSERT INTO gcode_cache (stl_catalog_id, settings_hash, printer_model, material, quality, strength, speed, texture, surface, supports, gcode_path, gcode_filename, est_weight_g, est_time_min, file_size)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    options.surface || 'standard',
    options.supports || 'none',
    gcodeRelPath.replace(/\\/g, '/'),
    gcodeFilename,
    estimates.est_weight_g,
    estimates.est_time_min,
    fileSize
  );

  console.log(`[Slicer] Done: ${gcodeFilename} (${estimates.est_weight_g || '?'}g, ${estimates.est_time_min || '?'}min, ${actualCopies} copies)`);

  return {
    gcode_id: info.lastInsertRowid,
    gcode_filename: gcodeFilename,
    gcode_path: gcodeRelPath.replace(/\\/g, '/'),
    est_weight_g: estimates.est_weight_g,
    est_time_min: estimates.est_time_min,
    file_size: fileSize,
    cached: false,
    actual_copies: actualCopies
  };
}

/**
 * Slice multiple STL files as a single plate
 * PrusaSlicer auto-arranges multiple positional STL args onto the bed
 */
async function slicePlate(stlPaths, options, dbInstance) {
  if (!stlPaths || stlPaths.length === 0) throw new Error('No STL files provided');

  // Check if this is a stackable plate — all items are the same STL and profile supports stacking.
  // Delegate to sliceSTL which handles vertical stacking with copies > 1.
  const profilePreset = PRINT_PROFILE_PRESETS[options.profile];
  const allSamePath = stlPaths.length > 0 && stlPaths.every(p => p === stlPaths[0]);
  if (allSamePath && profilePreset?.stackVertical && stlPaths.length > 1) {
    console.log(`[Slicer] Plate has ${stlPaths.length} copies of same STL with stack profile — delegating to sliceSTL for vertical stacking`);
    const it = options.instance_transforms;
    if (it && it[0] && !options.transform) {
      options.transform = it[0];
    }
    options.copies = stlPaths.length;
    return sliceSTL(stlPaths[0], options, dbInstance);
  }

  if (stlPaths.length === 1) {
    // Single item — pass first instance transform as options.transform for sliceSTL
    const it = options.instance_transforms;
    if (it && it[0] && !options.transform) {
      options.transform = it[0];
    }
    return sliceSTL(stlPaths[0], options, dbInstance);
  }

  const printerModel = options.printer_model || 'kobra3';
  const hash = generatePlateHash(stlPaths, options);

  // Check cache
  const cached = dbInstance.prepare('SELECT * FROM gcode_cache WHERE settings_hash = ?').get(hash);
  if (cached) {
    const fullPath = path.join(GCODE_CACHE, cached.gcode_path);
    if (fs.existsSync(fullPath)) {
      console.log(`[Slicer] Plate cache hit: ${hash} → ${cached.gcode_filename}`);
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
    dbInstance.prepare('DELETE FROM gcode_cache WHERE id = ?').run(cached.id);
  }

  // Resolve profiles
  const printerInfo = PRINTERS_MAP[printerModel];
  if (!printerInfo) throw new Error(`Unknown printer model: ${printerModel}`);

  const printerProfile = path.join(PROFILES_DIR, 'printers', printerInfo.profile);
  const filamentProfile = path.join(PROFILES_DIR, 'filaments', FILAMENT_PROFILES[options.material] || FILAMENT_PROFILES.pla);
  const printProfile = path.join(PROFILES_DIR, 'prints', PRINT_PROFILES[options.quality] || PRINT_PROFILES.standard);

  // Build output path
  const gcodeFilename = `plate_${stlPaths.length}items_${printerModel}_${options.quality || 'standard'}_${options.material || 'pla'}_${hash}.gcode`;
  const gcodeRelPath = path.join(printerModel, gcodeFilename);
  const gcodeAbsPath = path.join(GCODE_CACHE, gcodeRelPath);

  fs.mkdirSync(path.dirname(gcodeAbsPath), { recursive: true });

  // Auto-orient each STL if requested
  const orientedTempFiles = [];
  const bakedTempFiles = [];
  let slicePaths = [...stlPaths];

  // Per-instance transforms: ordered array matching stl_ids, each instance gets its own position
  const instanceTransforms = options.instance_transforms || [];
  const hasTransforms = instanceTransforms.some(t => t && hasNonIdentityTransform(t));

  if (options.auto_orient && !hasTransforms) {
    // Only auto-orient if no user transforms are provided (user positioned manually)
    slicePaths = stlPaths.map(p => {
      try {
        const oriented = autoOrientSTL(p);
        if (oriented) {
          orientedTempFiles.push(oriented);
          return oriented;
        }
      } catch (err) {
        console.warn(`[Slicer] Auto-orient failed for ${path.basename(p)}: ${err.message}`);
      }
      return p;
    });
  }

  // Bake per-instance transforms (rotation, scale, position) into temp STL files.
  // When ANY item has a transform, bake ALL items — even identity transforms need
  // centering/flooring so they merge correctly with positioned items.
  if (hasTransforms) {
    slicePaths = slicePaths.map((p, idx) => {
      const t = instanceTransforms[idx];
      if (t) {
        // Force a position for items without explicit positions so they get
        // centered/floored consistently with the rest of the merged plate
        const tWithDefaults = {
          rx: t.rx || 0, ry: t.ry || 0, rz: t.rz || 0,
          scale: t.scale || 1,
          posX: t.posX || 0, posZ: t.posZ || 0,
          _forceBake: true  // signal to bakeTransformToSTL to always bake
        };
        try {
          const baked = bakeTransformToSTL(p, tWithDefaults, `inst${idx}`);
          if (baked) {
            bakedTempFiles.push(baked);
            return baked;
          }
        } catch (err) {
          console.warn(`[Slicer] Transform bake failed for ${path.basename(p)}: ${err.message}`);
        }
      }
      return p;
    });
  }

  // When user transforms are present, models have been baked with absolute bed positions.
  // PrusaSlicer re-centers each STL on import, so passing them as separate files loses
  // the relative positioning. Merge all baked STLs into a single binary STL so PrusaSlicer
  // treats them as one object — the relative positions are preserved in the vertex data.
  let mergedTmpPath = null;
  let finalSlicePaths = slicePaths;
  if (hasTransforms && slicePaths.length > 1) {
    mergedTmpPath = mergeSTLFiles(slicePaths);
    finalSlicePaths = [mergedTmpPath];
  }

  // Use bed center for --center so PrusaSlicer places the merged plate in the middle of the bed.
  // The items are already positioned relative to each other in the merged STL,
  // so centering the group on the bed is all that's needed.
  const [bedX, bedY] = (printerInfo.build || '220x220x250').split('x').map(Number);
  const centerArg = hasTransforms
    ? ['--center', `${(bedX / 2).toFixed(1)},${(bedY / 2).toFixed(1)}`]
    : [];  // No center arg when auto-arranging
  if (hasTransforms) {
    console.log(`[Slicer] Using bed center: ${bedX / 2},${bedY / 2} (bed: ${bedX}x${bedY})`);
  } else {
    console.log(`[Slicer] No transforms — PrusaSlicer will auto-arrange ${slicePaths.length} items`);
  }

  const cliArgs = [
    '--export-gcode',
    ...(hasTransforms ? ['--dont-arrange', '--ensure-on-bed'] : []),
    ...centerArg,
    '--load', printProfile,
    '--load', filamentProfile,
    '--load', printerProfile,
    ...mapOptionsToSlicerArgs(options),
    '--output', gcodeAbsPath,
    ...finalSlicePaths
  ];

  // Add thread cap to CLI args so PrusaSlicer doesn't eat all CPU cores
  cliArgs.unshift('--threads', String(SLICER_THREADS));

  console.log(`[Slicer] Plating ${stlPaths.length} STLs → ${gcodeFilename}`);
  console.log(`[Slicer] CLI: ${SLICER_PATH} ${cliArgs.join(' ')}`);

  // Wait for concurrency slot (only 1 PrusaSlicer at a time)
  if (activeSlices >= MAX_CONCURRENT_SLICES) {
    console.log(`[Slicer] Queue: waiting for active slice to finish (${sliceQueue.length} ahead)...`);
  }
  await acquireSliceLock();

  // Helper to run PrusaSlicer with given args
  const runSlicer = (args) => new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const proc = spawn(SLICER_PATH, args, {
      timeout: 600000, // 10 min for plates
      env: { ...process.env, DISPLAY: '' }
    });
    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });
    proc.on('close', (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const detail = signal ? `killed by signal ${signal}` : `exited with code ${code}`;
        console.error(`[Slicer] PrusaSlicer ${detail}. stderr: ${stderr.slice(0, 500)}`);
        reject(new Error(`PrusaSlicer ${detail}: ${stderr || stdout}`));
      }
    });
    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn PrusaSlicer: ${err.message}`));
    });
  });

  let result;
  try {
    try {
      result = await runSlicer(cliArgs);
    } catch (mergedErr) {
      // If the merged/positioned approach crashed, fall back to separate files + auto-arrange
      if (mergedTmpPath && slicePaths.length > 1) {
        console.warn(`[Slicer] Merged plate slice crashed (${mergedErr.message}). Retrying with auto-arrange...`);
        const fallbackArgs = [
          '--threads', '1',  // Single-threaded for stability
          '--export-gcode',
          '--load', printProfile,
          '--load', filamentProfile,
          '--load', printerProfile,
          ...mapOptionsToSlicerArgs(options),
          '--output', gcodeAbsPath,
          ...slicePaths  // Pass individual STLs, let PrusaSlicer arrange
        ];
        console.log(`[Slicer] Fallback CLI: ${SLICER_PATH} ${fallbackArgs.join(' ')}`);
        result = await runSlicer(fallbackArgs);
      } else {
        throw mergedErr;
      }
    }
  } finally {
    // Clean up temp files before releasing lock — avoids race where a queued
    // request with the same stl_id can have its baked file deleted after it's written
    for (const tmp of orientedTempFiles) {
      try { fs.unlinkSync(tmp); } catch {}
    }
    for (const tmp of bakedTempFiles) {
      try { fs.unlinkSync(tmp); } catch {}
    }
    if (mergedTmpPath) {
      try { fs.unlinkSync(mergedTmpPath); } catch {}
    }
    releaseSliceLock();
  }

  const combined = result.stdout + '\n' + result.stderr;
  const estimates = parseSlicerOutput(combined);

  let fileSize = 0;
  try { fileSize = fs.statSync(gcodeAbsPath).size; } catch {}

  const stlIds = options.stl_ids || [];
  const primaryStlId = stlIds[0] || 0;

  const ins = dbInstance.prepare(`
    INSERT INTO gcode_cache (stl_catalog_id, settings_hash, printer_model, material, quality, strength, speed, texture, surface, supports, gcode_path, gcode_filename, est_weight_g, est_time_min, file_size, plate_stl_ids)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const info = ins.run(
    primaryStlId,
    hash,
    printerModel,
    options.material || 'pla',
    options.quality || 'standard',
    options.strength || 'normal',
    options.speed || 'normal',
    options.texture || 'smooth',
    options.surface || 'standard',
    options.supports || 'none',
    gcodeRelPath.replace(/\\/g, '/'),
    gcodeFilename,
    estimates.est_weight_g,
    estimates.est_time_min,
    fileSize,
    JSON.stringify(stlIds)
  );

  console.log(`[Slicer] Plate done: ${gcodeFilename} (${estimates.est_weight_g || '?'}g, ${estimates.est_time_min || '?'}min)`);

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
    surface: Object.entries(SURFACE_MAP).map(([key, v]) => ({
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
    })),
    profiles: Object.entries(PRINT_PROFILE_PRESETS).map(([key, v]) => ({
      key, label: v.label, description: v.description, category: v.category,
      hint: v.hint || null, visual: v.visual || null
    }))
  };
}

// ============================================================================
// STEP → STL CONVERSION
// ============================================================================

/**
 * Convert a STEP/STP file to binary STL using PrusaSlicer --export-stl.
 * @param {string} stepPath  Absolute path to the input STEP file
 * @param {string} stlPath   Absolute path for the output STL file
 * @returns {Promise<void>}
 */
function convertStepToStl(stepPath, stlPath) {
  return new Promise((resolve, reject) => {
    console.log(`[Slicer] Converting STEP → STL: ${stepPath}`);
    const proc = spawn(SLICER_PATH, [
      '--export-stl', '--output', stlPath, stepPath
    ], { timeout: 120000, env: { ...process.env, DISPLAY: '' } });

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) {
        console.log(`[Slicer] STEP conversion done: ${stlPath}`);
        resolve();
      } else {
        reject(new Error(`PrusaSlicer STEP conversion exited ${code}: ${stderr.slice(0, 500)}`));
      }
    });
    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn PrusaSlicer for STEP conversion: ${err.message}`));
    });
  });
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Core slicing
  sliceSTL,
  slicePlate,
  getModelInfo,
  convertStepToStl,
  generateSettingsHash,
  generatePlateHash,
  mapOptionsToSlicerArgs,
  parseSlicerOutput,
  // Presets
  getPresets,
  // Maps (for reference)
  QUALITY_MAP,
  STRENGTH_MAP,
  SPEED_MAP,
  TEXTURE_MAP,
  SURFACE_MAP,
  SUPPORTS_MAP,
  MATERIALS_MAP,
  PRINTERS_MAP,
  // Paths
  SLICER_PATH,
  STL_LIBRARY,
  STL_MODELS,
  STL_THUMBNAILS,
  GCODE_CACHE,
  PROFILES_DIR,
  DATA_DIR
};
