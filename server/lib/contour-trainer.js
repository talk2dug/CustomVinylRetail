/**
 * Contour Training System
 * Analyzes Studio3 files to learn Jack's contour style preferences
 * Uses paired data (image + manual cut path) to improve auto-generation
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

/**
 * Analyze a single Studio3 file's contour characteristics
 * @param {Object} parsed - Parsed Studio3 data {images, paths, metadata}
 * @returns {Object} Contour style metrics
 */
function analyzeContourStyle(parsed) {
  const { paths, images } = parsed;

  if (!paths || paths.length === 0) {
    return { valid: false, reason: 'No paths found' };
  }

  const metrics = {
    valid: true,
    pathCount: paths.length,
    imageCount: images?.length || 0,

    // Per-path metrics
    pathMetrics: [],

    // Aggregate metrics
    avgPointsPerPath: 0,
    avgSegmentLength: 0,
    avgCornerAngle: 0,
    cornerSharpness: 0,  // 0 = very rounded, 1 = very sharp
    detailLevel: 0,      // Points per unit area
    smoothness: 0,       // How smooth the curves are
    offsetFromEdge: 0,   // Estimated offset from image edge
  };

  let totalPoints = 0;
  let totalSegments = 0;
  let totalSegmentLength = 0;
  let totalCornerAngles = [];

  for (const pathPoints of paths) {
    if (pathPoints.length < 3) continue;

    const pathMetric = analyzePathGeometry(pathPoints);
    metrics.pathMetrics.push(pathMetric);

    totalPoints += pathPoints.length;
    totalSegments += pathPoints.length - 1;
    totalSegmentLength += pathMetric.totalLength;
    totalCornerAngles.push(...pathMetric.cornerAngles);
  }

  // Calculate aggregates
  metrics.avgPointsPerPath = totalPoints / paths.length;
  metrics.avgSegmentLength = totalSegmentLength / Math.max(totalSegments, 1);

  if (totalCornerAngles.length > 0) {
    metrics.avgCornerAngle = totalCornerAngles.reduce((a, b) => a + b, 0) / totalCornerAngles.length;
    // Sharp corners have angles close to 90°, rounded have angles close to 180°
    metrics.cornerSharpness = 1 - (metrics.avgCornerAngle / 180);
  }

  // Calculate detail level (points per 1000 sq units of bounding box)
  const bounds = calculateBounds(paths.flat());
  const area = bounds.width * bounds.height;
  metrics.detailLevel = area > 0 ? (totalPoints / area) * 1000 : 0;

  // Estimate smoothness from segment length variance
  const segmentLengths = metrics.pathMetrics.flatMap(p => p.segmentLengths);
  if (segmentLengths.length > 1) {
    const variance = calculateVariance(segmentLengths);
    // Lower variance = more uniform = smoother
    metrics.smoothness = 1 / (1 + Math.sqrt(variance) / metrics.avgSegmentLength);
  }

  return metrics;
}

/**
 * Analyze geometry of a single path
 */
function analyzePathGeometry(points) {
  const segmentLengths = [];
  const cornerAngles = [];
  let totalLength = 0;

  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i];
    const p2 = points[i + 1];
    const length = Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));
    segmentLengths.push(length);
    totalLength += length;
  }

  // Calculate corner angles (for points with neighbors on both sides)
  for (let i = 1; i < points.length - 1; i++) {
    const p0 = points[i - 1];
    const p1 = points[i];
    const p2 = points[i + 1];

    const angle = calculateAngle(p0, p1, p2);
    cornerAngles.push(angle);
  }

  return {
    pointCount: points.length,
    totalLength,
    segmentLengths,
    cornerAngles,
    avgSegmentLength: totalLength / Math.max(segmentLengths.length, 1),
    bounds: calculateBounds(points)
  };
}

/**
 * Calculate angle at point p1 (in degrees)
 */
function calculateAngle(p0, p1, p2) {
  const v1 = { x: p0.x - p1.x, y: p0.y - p1.y };
  const v2 = { x: p2.x - p1.x, y: p2.y - p1.y };

  const dot = v1.x * v2.x + v1.y * v2.y;
  const mag1 = Math.sqrt(v1.x * v1.x + v1.y * v1.y);
  const mag2 = Math.sqrt(v2.x * v2.x + v2.y * v2.y);

  if (mag1 === 0 || mag2 === 0) return 180;

  const cosAngle = Math.max(-1, Math.min(1, dot / (mag1 * mag2)));
  return Math.acos(cosAngle) * (180 / Math.PI);
}

/**
 * Calculate bounding box
 */
function calculateBounds(points) {
  if (!points || points.length === 0) {
    return { minX: 0, maxX: 0, minY: 0, maxY: 0, width: 0, height: 0 };
  }

  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);

  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  return {
    minX, maxX, minY, maxY,
    width: maxX - minX,
    height: maxY - minY
  };
}

/**
 * Calculate variance of an array
 */
function calculateVariance(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return arr.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / arr.length;
}

/**
 * Aggregate metrics from multiple Studio3 files to create a "style profile"
 * @param {Array} allMetrics - Array of metrics from analyzeContourStyle()
 * @returns {Object} Aggregated style profile
 */
function createStyleProfile(allMetrics) {
  const validMetrics = allMetrics.filter(m => m.valid);

  if (validMetrics.length === 0) {
    return { valid: false, reason: 'No valid metrics to aggregate' };
  }

  const profile = {
    valid: true,
    sampleCount: validMetrics.length,

    // Average characteristics
    avgPointsPerPath: average(validMetrics.map(m => m.avgPointsPerPath)),
    avgSegmentLength: average(validMetrics.map(m => m.avgSegmentLength)),
    avgCornerAngle: average(validMetrics.map(m => m.avgCornerAngle)),

    // Style indicators
    cornerSharpness: average(validMetrics.map(m => m.cornerSharpness)),
    detailLevel: average(validMetrics.map(m => m.detailLevel)),
    smoothness: average(validMetrics.map(m => m.smoothness)),

    // Ranges (min/max observed)
    ranges: {
      pointsPerPath: { min: Math.min(...validMetrics.map(m => m.avgPointsPerPath)), max: Math.max(...validMetrics.map(m => m.avgPointsPerPath)) },
      segmentLength: { min: Math.min(...validMetrics.map(m => m.avgSegmentLength)), max: Math.max(...validMetrics.map(m => m.avgSegmentLength)) },
      detailLevel: { min: Math.min(...validMetrics.map(m => m.detailLevel)), max: Math.max(...validMetrics.map(m => m.detailLevel)) },
    },

    // Recommended potrace parameters based on analysis
    recommendedParams: {}
  };

  // Derive recommended potrace parameters from the style profile
  profile.recommendedParams = derivePotraceParams(profile);

  return profile;
}

/**
 * Derive optimal potrace parameters from style profile
 */
function derivePotraceParams(profile) {
  const params = {
    // Base parameters
    threshold: 128,
    turnPolicy: 'minority',

    // Derived from style analysis
    turdSize: 2,      // Default
    optCurve: true,   // Default
    optTolerance: 0.2,
    alphaMax: 1.0,
  };

  // Adjust turdSize based on detail level
  // Higher detail level = lower turdSize (keep more detail)
  if (profile.detailLevel > 0.5) {
    params.turdSize = 1;
  } else if (profile.detailLevel > 0.2) {
    params.turdSize = 2;
  } else if (profile.detailLevel > 0.1) {
    params.turdSize = 5;
  } else {
    params.turdSize = 10;
  }

  // Adjust corner handling based on sharpness preference
  // Higher sharpness = disable curve optimization, lower alphaMax
  if (profile.cornerSharpness > 0.7) {
    params.optCurve = false;
    params.alphaMax = 0;
  } else if (profile.cornerSharpness > 0.5) {
    params.optCurve = true;
    params.alphaMax = 0.5;
  } else {
    params.optCurve = true;
    params.alphaMax = 1.0;
  }

  // Adjust tolerance based on smoothness
  // Higher smoothness = higher tolerance (more curve fitting)
  if (profile.smoothness > 0.7) {
    params.optTolerance = 0.4;
  } else if (profile.smoothness > 0.4) {
    params.optTolerance = 0.2;
  } else {
    params.optTolerance = 0.1;
  }

  return params;
}

/**
 * Helper: Calculate average
 */
function average(arr) {
  if (!arr || arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/**
 * Compare auto-generated contour to manual Studio3 contour
 * Returns similarity score and areas of difference
 */
function compareContours(autoPath, manualPath) {
  const autoPoints = parseSvgPath(autoPath);
  const manualPoints = Array.isArray(manualPath) ? manualPath : parseSvgPath(manualPath);

  if (!autoPoints.length || !manualPoints.length) {
    return { similarity: 0, reason: 'Invalid paths' };
  }

  // Normalize both paths to same scale
  const autoBounds = calculateBounds(autoPoints);
  const manualBounds = calculateBounds(manualPoints);

  const normalizedAuto = normalizePoints(autoPoints, autoBounds);
  const normalizedManual = normalizePoints(manualPoints, manualBounds);

  // Calculate Hausdorff-like distance (max distance from any point to nearest point)
  let maxDistAutoToManual = 0;
  let maxDistManualToAuto = 0;

  for (const p of normalizedAuto) {
    const dist = minDistanceToPath(p, normalizedManual);
    maxDistAutoToManual = Math.max(maxDistAutoToManual, dist);
  }

  for (const p of normalizedManual) {
    const dist = minDistanceToPath(p, normalizedAuto);
    maxDistManualToAuto = Math.max(maxDistManualToAuto, dist);
  }

  const hausdorffDistance = Math.max(maxDistAutoToManual, maxDistManualToAuto);

  // Convert distance to similarity (0-1 scale, 1 = identical)
  // Using exponential decay: e^(-distance)
  const similarity = Math.exp(-hausdorffDistance * 2);

  // Analyze specific differences
  const autoMetrics = analyzePathGeometry(autoPoints);
  const manualMetrics = analyzePathGeometry(manualPoints);

  return {
    similarity,
    hausdorffDistance,
    differences: {
      pointCountDiff: autoMetrics.pointCount - manualMetrics.pointCount,
      lengthDiff: autoMetrics.totalLength - manualMetrics.totalLength,
      avgSegmentDiff: autoMetrics.avgSegmentLength - manualMetrics.avgSegmentLength,
    },
    autoMetrics,
    manualMetrics
  };
}

/**
 * Parse SVG path string to points array
 * Handles M, L, Z commands (basic support)
 */
function parseSvgPath(svgPath) {
  if (!svgPath || typeof svgPath !== 'string') return [];

  const points = [];
  const commands = svgPath.match(/[MLZ][^MLZ]*/gi) || [];

  for (const cmd of commands) {
    const type = cmd[0].toUpperCase();
    const coords = cmd.slice(1).trim().split(/[\s,]+/).map(Number).filter(n => !isNaN(n));

    if (type === 'M' || type === 'L') {
      for (let i = 0; i < coords.length; i += 2) {
        if (i + 1 < coords.length) {
          points.push({ x: coords[i], y: coords[i + 1] });
        }
      }
    }
  }

  return points;
}

/**
 * Normalize points to 0-1 range
 */
function normalizePoints(points, bounds) {
  if (!bounds.width || !bounds.height) return points;

  return points.map(p => ({
    x: (p.x - bounds.minX) / bounds.width,
    y: (p.y - bounds.minY) / bounds.height
  }));
}

/**
 * Find minimum distance from point to any point on path
 */
function minDistanceToPath(point, path) {
  let minDist = Infinity;

  for (const p of path) {
    const dist = Math.sqrt(Math.pow(p.x - point.x, 2) + Math.pow(p.y - point.y, 2));
    minDist = Math.min(minDist, dist);
  }

  return minDist;
}

/**
 * Train on a collection of Studio3 files and save the style profile
 */
async function trainFromStudio3Collection(studio3Files, db) {
  console.log(`[ContourTrainer] Training on ${studio3Files.length} Studio3 files...`);

  const allMetrics = [];
  const errors = [];

  for (const file of studio3Files) {
    try {
      const metrics = analyzeContourStyle(file);
      if (metrics.valid) {
        allMetrics.push(metrics);
      } else {
        errors.push({ filename: file.metadata?.filename, reason: metrics.reason });
      }
    } catch (err) {
      errors.push({ filename: file.metadata?.filename, error: err.message });
    }
  }

  console.log(`[ContourTrainer] Analyzed ${allMetrics.length} files successfully, ${errors.length} errors`);

  // Create aggregated style profile
  const profile = createStyleProfile(allMetrics);

  if (profile.valid) {
    console.log('[ContourTrainer] Style Profile:');
    console.log(`  - Corner Sharpness: ${(profile.cornerSharpness * 100).toFixed(1)}%`);
    console.log(`  - Detail Level: ${profile.detailLevel.toFixed(3)}`);
    console.log(`  - Smoothness: ${(profile.smoothness * 100).toFixed(1)}%`);
    console.log(`  - Avg Points/Path: ${profile.avgPointsPerPath.toFixed(1)}`);
    console.log(`  - Recommended turdSize: ${profile.recommendedParams.turdSize}`);
    console.log(`  - Recommended optCurve: ${profile.recommendedParams.optCurve}`);
    console.log(`  - Recommended alphaMax: ${profile.recommendedParams.alphaMax}`);
  }

  // Save profile to database if provided
  if (db) {
    try {
      const profileJson = JSON.stringify(profile);
      db.run(`
        INSERT OR REPLACE INTO contour_style_profile (id, profile_data, sample_count, created_at)
        VALUES ('default', ?, ?, datetime('now'))
      `, [profileJson, allMetrics.length]);
      console.log('[ContourTrainer] Profile saved to database');
    } catch (err) {
      console.error('[ContourTrainer] Failed to save profile:', err.message);
    }
  }

  return {
    profile,
    sampleCount: allMetrics.length,
    errors
  };
}

/**
 * Load saved style profile from database
 */
function loadStyleProfile(db) {
  try {
    const row = db.get(`SELECT profile_data FROM contour_style_profile WHERE id = 'default'`);
    if (row?.profile_data) {
      return JSON.parse(row.profile_data);
    }
  } catch (err) {
    console.error('[ContourTrainer] Failed to load profile:', err.message);
  }
  return null;
}

module.exports = {
  analyzeContourStyle,
  analyzePathGeometry,
  createStyleProfile,
  derivePotraceParams,
  compareContours,
  parseSvgPath,
  trainFromStudio3Collection,
  loadStyleProfile,
  calculateBounds
};
