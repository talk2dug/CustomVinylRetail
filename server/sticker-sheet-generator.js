/**
 * Sticker Sheet Generator
 *
 * Generates print-ready PNG sheets and cut-ready SVG files for Cricut
 *
 * Features:
 * - Grid layout engine for consistent sticker placement
 * - PNG composite output at 300 DPI for printing
 * - SVG cut file with offset paths for die-cutting
 * - Supports manual selection, bulk export, and Shopify order fulfillment
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { execSync } = require('child_process');
const taskTracker = require('./task-tracker');
const paper = require('paper');
const potrace = require('potrace');
const { NestingEngine, createNestingEngine } = require('./nesting-engine');
const contourTrainer = require('./lib/contour-trainer');

// Note: Using custom NestingEngine with polygon-clipping for contour-aware nesting
// Supports both MANUAL (efficiency) and ORDER (grouped by order) packing modes

// Temp folder for background-removed images
const TEMP_FOLDER = path.join(__dirname, '..', 'temp_stickers');

// Web directory - use __dirname for reliability across different working directories
const WEB_DIR = path.join(__dirname, '..', 'web');

// Sheet configuration - Standard 8.5" x 11" letter size
// Both PNG and SVG must be exactly the same dimensions for alignment
const SHEET_CONFIG = {
  // Standard letter size (8.5" x 11")
  widthInches: 8.5,
  heightInches: 11,
  dpi: 300,
  // Calculated pixel dimensions
  get widthPx() { return Math.floor(this.widthInches * this.dpi); },  // 2550
  get heightPx() { return Math.floor(this.heightInches * this.dpi); }, // 3300
  // Margins for printable area (leave space for registration/bleed)
  marginInches: 0.5,
  get marginPx() { return Math.floor(this.marginInches * this.dpi); }, // 150
  // Gap between stickers
  gapInches: 0.125,
  get gapPx() { return Math.floor(this.gapInches * this.dpi); } // ~37
};

// Default sticker size
const DEFAULT_STICKER_SIZE_INCHES = 3;
const DEFAULT_OFFSET_MM = 0.25; // Offset from sticker edge to cut line (tight cut)

// ============================================================================
// LEARNED CONTOUR STYLE PARAMETERS
// Loaded from database based on analysis of Jack's manual Studio3 cut paths
// Falls back to defaults if no trained profile exists
// ============================================================================
let _learnedStyleProfile = null;
let _styleProfileLoaded = false;

/**
 * Get learned potrace parameters from trained style profile
 * @param {string} mode - 'vinyl' (blocky) or 'sticker' (smooth)
 * @returns {Object} Potrace parameters
 */
function getLearnedPotraceParams(mode = 'sticker') {
  // Try to load profile from database if not already loaded
  if (!_styleProfileLoaded) {
    try {
      const db = require('./db');
      _learnedStyleProfile = contourTrainer.loadStyleProfile(db.getDb());
      _styleProfileLoaded = true;
      if (_learnedStyleProfile) {
        console.log('[ContourStyle] Loaded trained style profile:', {
          sampleCount: _learnedStyleProfile.sampleCount,
          cornerSharpness: _learnedStyleProfile.cornerSharpness?.toFixed(2),
          detailLevel: _learnedStyleProfile.detailLevel?.toFixed(3),
          smoothness: _learnedStyleProfile.smoothness?.toFixed(2)
        });
      }
    } catch (err) {
      console.warn('[ContourStyle] Could not load style profile:', err.message);
      _styleProfileLoaded = true; // Don't retry
    }
  }

  // Default parameters based on mode
  const defaults = {
    vinyl: {
      threshold: 128,
      turnPolicy: potrace.Potrace.TURNPOLICY_MINORITY,
      turdSize: 10,
      optCurve: false,
      optTolerance: 0.2,
      alphaMax: 0
    },
    sticker: {
      threshold: 128,
      turnPolicy: potrace.Potrace.TURNPOLICY_MINORITY,
      turdSize: 2,
      optCurve: true,
      optTolerance: 0.2,
      alphaMax: 1.0
    }
  };

  const baseParams = defaults[mode] || defaults.sticker;

  // Override with learned parameters if available
  if (_learnedStyleProfile?.valid && _learnedStyleProfile.recommendedParams) {
    const learned = _learnedStyleProfile.recommendedParams;
    return {
      ...baseParams,
      turdSize: learned.turdSize ?? baseParams.turdSize,
      optCurve: learned.optCurve ?? baseParams.optCurve,
      optTolerance: learned.optTolerance ?? baseParams.optTolerance,
      alphaMax: learned.alphaMax ?? baseParams.alphaMax
    };
  }

  return baseParams;
}

/**
 * Force reload of style profile (call after training)
 */
function reloadStyleProfile() {
  _styleProfileLoaded = false;
  _learnedStyleProfile = null;
  console.log('[ContourStyle] Style profile cache cleared');
}

// ============================================================================
// SILHOUETTE REGISTRATION MARK SETTINGS
// These marks are required for Print & Cut alignment on Silhouette Cameo
// ============================================================================
const REGMARK_CONFIG = {
  // Square size (the filled corner square)
  squareSizeMm: 5,
  // Line length extending from the square
  lineLengthMm: 20,
  // Line width/thickness
  lineWidthMm: 0.5,
  // Distance from page edge to registration mark
  marginMm: 10,
  // Convert mm to pixels at sheet DPI
  get squareSizePx() { return Math.round(this.squareSizeMm / 25.4 * SHEET_CONFIG.dpi); },
  get lineLengthPx() { return Math.round(this.lineLengthMm / 25.4 * SHEET_CONFIG.dpi); },
  get lineWidthPx() { return Math.max(1, Math.round(this.lineWidthMm / 25.4 * SHEET_CONFIG.dpi)); },
  get marginPx() { return Math.round(this.marginMm / 25.4 * SHEET_CONFIG.dpi); }
};

/**
 * Create registration mark SVG buffers for compositing onto print sheet
 * Returns array of composite operations for sharp
 */
async function createRegistrationMarkComposites() {
  const sq = REGMARK_CONFIG.squareSizePx;
  const lineLen = REGMARK_CONFIG.lineLengthPx;
  const lineW = REGMARK_CONFIG.lineWidthPx;
  const margin = REGMARK_CONFIG.marginPx;
  const totalW = sq + lineLen;
  const totalH = sq + lineLen;

  const composites = [];

  // Top-Left L-mark (square at origin, lines extend right and down)
  const tlSvg = `<svg width="${totalW}" height="${totalH}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="${sq}" height="${sq}" fill="black"/>
    <rect x="${sq}" y="0" width="${lineLen}" height="${lineW}" fill="black"/>
    <rect x="0" y="${sq}" width="${lineW}" height="${lineLen}" fill="black"/>
  </svg>`;
  composites.push({
    input: Buffer.from(tlSvg),
    left: margin,
    top: margin
  });

  // Top-Right L-mark (square at right, lines extend left and down)
  const trSvg = `<svg width="${totalW}" height="${totalH}" xmlns="http://www.w3.org/2000/svg">
    <rect x="${lineLen}" y="0" width="${sq}" height="${sq}" fill="black"/>
    <rect x="0" y="0" width="${lineLen}" height="${lineW}" fill="black"/>
    <rect x="${lineLen + sq - lineW}" y="${sq}" width="${lineW}" height="${lineLen}" fill="black"/>
  </svg>`;
  composites.push({
    input: Buffer.from(trSvg),
    left: SHEET_CONFIG.widthPx - margin - totalW,
    top: margin
  });

  // Bottom-Left L-mark (square at bottom, lines extend right and up)
  const blSvg = `<svg width="${totalW}" height="${totalH}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="${lineLen}" width="${sq}" height="${sq}" fill="black"/>
    <rect x="${sq}" y="${lineLen + sq - lineW}" width="${lineLen}" height="${lineW}" fill="black"/>
    <rect x="0" y="0" width="${lineW}" height="${lineLen}" fill="black"/>
  </svg>`;
  composites.push({
    input: Buffer.from(blSvg),
    left: margin,
    top: SHEET_CONFIG.heightPx - margin - totalH
  });

  return composites;
}

/**
 * Get registration mark info for Silhouette (in mm)
 * Used when sending cut file to Cameo
 */
function getRegmarkInfo() {
  const sheetWidthMm = SHEET_CONFIG.widthInches * 25.4;
  const sheetHeightMm = SHEET_CONFIG.heightInches * 25.4;
  const marginMm = REGMARK_CONFIG.marginMm;
  const sqMm = REGMARK_CONFIG.squareSizeMm;

  return {
    originX: marginMm,
    originY: marginMm,
    width: sheetWidthMm - (2 * marginMm) - sqMm,
    length: sheetHeightMm - (2 * marginMm) - sqMm
  };
}

/**
 * Generate SVG registration marks for cut file
 * These must match exactly the printed marks
 */
function generateRegmarkSvgElements() {
  const sheetWidthMm = SHEET_CONFIG.widthInches * 25.4;
  const sheetHeightMm = SHEET_CONFIG.heightInches * 25.4;
  const margin = REGMARK_CONFIG.marginMm;
  const sq = REGMARK_CONFIG.squareSizeMm;
  const lineLen = REGMARK_CONFIG.lineLengthMm;
  const lineW = REGMARK_CONFIG.lineWidthMm;

  let svg = '';

  // Top-Left
  svg += `  <g id="regmark-tl" transform="translate(${margin}, ${margin})">
    <rect x="0" y="0" width="${sq}" height="${sq}" fill="black"/>
    <rect x="${sq}" y="0" width="${lineLen}" height="${lineW}" fill="black"/>
    <rect x="0" y="${sq}" width="${lineW}" height="${lineLen}" fill="black"/>
  </g>\n`;

  // Top-Right
  svg += `  <g id="regmark-tr" transform="translate(${sheetWidthMm - margin - sq - lineLen}, ${margin})">
    <rect x="${lineLen}" y="0" width="${sq}" height="${sq}" fill="black"/>
    <rect x="0" y="0" width="${lineLen}" height="${lineW}" fill="black"/>
    <rect x="${lineLen + sq - lineW}" y="${sq}" width="${lineW}" height="${lineLen}" fill="black"/>
  </g>\n`;

  // Bottom-Left
  svg += `  <g id="regmark-bl" transform="translate(${margin}, ${sheetHeightMm - margin - sq - lineLen})">
    <rect x="0" y="${lineLen}" width="${sq}" height="${sq}" fill="black"/>
    <rect x="${sq}" y="${lineLen + sq - lineW}" width="${lineLen}" height="${lineW}" fill="black"/>
    <rect x="0" y="0" width="${lineW}" height="${lineLen}" fill="black"/>
  </g>\n`;

  return svg;
}

/**
 * Remove background from an image using rembg (Python AI tool)
 * @param {string} inputPath - Path to input image
 * @returns {Promise<string>} Path to background-removed image (or original if rembg fails)
 */
async function removeBackground(inputPath) {
  // Ensure temp folder exists
  if (!fs.existsSync(TEMP_FOLDER)) {
    fs.mkdirSync(TEMP_FOLDER, { recursive: true });
  }

  // Check if image already has significant transparency (skip rembg if so)
  try {
    const metadata = await sharp(inputPath).metadata();
    if (metadata.hasAlpha) {
      // Check if there's actual transparency in the image
      const { data, info } = await sharp(inputPath)
        .resize(100, 100, { fit: 'inside' }) // Small sample for speed
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      // Count transparent pixels (alpha < 250)
      let transparentPixels = 0;
      const totalPixels = info.width * info.height;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] < 250) transparentPixels++;
      }

      const transparencyRatio = transparentPixels / totalPixels;
      // If more than 5% of pixels are transparent, assume background is already removed
      if (transparencyRatio > 0.05) {
        console.log(`  ✓ Image already has transparency (${(transparencyRatio * 100).toFixed(1)}%), skipping rembg: ${path.basename(inputPath)}`);
        return inputPath;
      }
    }
  } catch (checkErr) {
    console.warn(`  ! Could not check transparency: ${checkErr.message}`);
    // Continue with rembg if check fails
  }

  const baseName = path.basename(inputPath, path.extname(inputPath));
  const timestamp = Date.now();
  const noBgPath = path.join(TEMP_FOLDER, `${baseName}_${timestamp}_nobg.png`);

  try {
    // Try full path first (Linux), then fall back to just 'rembg' (Windows/PATH)
    const rembgCmd = process.platform === 'win32' ? 'rembg' : '/home/ubuntu/.local/bin/rembg';
    execSync(`${rembgCmd} i "${inputPath}" "${noBgPath}"`, { stdio: 'pipe' });
    console.log(`  ✓ Background removed: ${path.basename(inputPath)}`);
    return noBgPath;
  } catch (error) {
    // Fallback: try without full path
    try {
      execSync(`rembg i "${inputPath}" "${noBgPath}"`, { stdio: 'pipe' });
      console.log(`  ✓ Background removed: ${path.basename(inputPath)}`);
      return noBgPath;
    } catch (e2) {
      // rembg not available - return original path
      console.warn(`  ! Could not remove background (rembg not available): ${path.basename(inputPath)}`);
      return inputPath;
    }
  }
}

/**
 * Clean up temporary background-removed files
 * @param {Array<string>} filePaths - Array of file paths to clean up
 */
function cleanupTempFiles(filePaths) {
  for (const filePath of filePaths) {
    if (filePath && filePath.includes(TEMP_FOLDER) && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  }
}

/**
 * Extract contour from a transparent PNG image
 * Uses Moore-Neighbor boundary tracing to follow the actual sticker outline
 * @param {string} imagePath - Path to PNG with transparency
 * @param {number} simplifyTolerance - Tolerance for path simplification
 * @returns {Promise<Array>} Array of {x, y} points forming the contour
 */
async function extractContour(imagePath, simplifyTolerance = 2) {
  const image = sharp(imagePath);
  const metadata = await image.metadata();
  const { width, height } = metadata;

  // Scale down for smoother contour tracing (avoid pixel-level jaggies)
  // Target ~800px on the longest side for tracing (higher = more accurate contours)
  const maxTraceSize = 800;
  const scaleFactor = Math.min(1, maxTraceSize / Math.max(width, height));
  const traceWidth = Math.round(width * scaleFactor);
  const traceHeight = Math.round(height * scaleFactor);

  console.log(`[Contour] Original: ${width}x${height}, Tracing at: ${traceWidth}x${traceHeight}`);

  // Get scaled alpha channel
  const rawBuffer = await image
    .resize(traceWidth, traceHeight, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer();

  // Use very high threshold - only consider fully opaque pixels as part of the sticker
  // This helps cut closer to the actual artwork, not semi-transparent edges
  const alphaThreshold = 240;

  // Find bounding box of opaque pixels
  let minX = traceWidth, minY = traceHeight, maxX = 0, maxY = 0;
  let hasOpaquePixels = false;

  for (let y = 0; y < traceHeight; y++) {
    for (let x = 0; x < traceWidth; x++) {
      const idx = (y * traceWidth + x) * 4;
      if (rawBuffer[idx + 3] > alphaThreshold) {
        hasOpaquePixels = true;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  if (!hasOpaquePixels) {
    console.log(`[Contour] No opaque pixels found, using full image bounds`);
    return [
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: height },
      { x: 0, y: height }
    ];
  }

  // Add minimal padding for boundary tracing algorithm
  const padding = 1;
  minX = Math.max(0, minX - padding);
  minY = Math.max(0, minY - padding);
  maxX = Math.min(traceWidth - 1, maxX + padding);
  maxY = Math.min(traceHeight - 1, maxY + padding);

  const boundWidth = maxX - minX + 1;
  const boundHeight = maxY - minY + 1;

  console.log(`[Contour] Opaque region: ${boundWidth}x${boundHeight} at (${minX},${minY})`);

  // Create padded mask with 1px border of zeros
  const paddedWidth = boundWidth + 2;
  const paddedHeight = boundHeight + 2;
  const mask = new Uint8Array(paddedWidth * paddedHeight);

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const srcIdx = (y * traceWidth + x) * 4;
      const dstX = x - minX + 1;
      const dstY = y - minY + 1;
      mask[dstY * paddedWidth + dstX] = rawBuffer[srcIdx + 3] > alphaThreshold ? 1 : 0;
    }
  }

  // Trace the OUTER boundary using marching squares on edges
  // We find edges between opaque and transparent pixels
  const contour = [];

  // Find starting point - look for transition from 0 to 1 on top edge of each row
  let startX = -1, startY = -1;
  outer: for (let y = 0; y < paddedHeight; y++) {
    for (let x = 0; x < paddedWidth - 1; x++) {
      const curr = mask[y * paddedWidth + x];
      const next = mask[y * paddedWidth + x + 1];
      if (curr === 0 && next === 1) {
        startX = x + 1;
        startY = y;
        break outer;
      }
    }
  }

  if (startX === -1) {
    console.log(`[Contour] No boundary found, using bounding box`);
    const invScale = 1 / scaleFactor;
    return [
      { x: minX * invScale, y: minY * invScale },
      { x: (maxX + 1) * invScale, y: minY * invScale },
      { x: (maxX + 1) * invScale, y: (maxY + 1) * invScale },
      { x: minX * invScale, y: (maxY + 1) * invScale }
    ];
  }

  // 4-connected boundary trace (smoother than 8-connected)
  // Direction: 0=right, 1=down, 2=left, 3=up
  const dx = [1, 0, -1, 0];
  const dy = [0, 1, 0, -1];

  const getMask = (x, y) => {
    if (x < 0 || x >= paddedWidth || y < 0 || y >= paddedHeight) return 0;
    return mask[y * paddedWidth + x];
  };

  let x = startX, y = startY;
  let dir = 0; // Start moving right
  const maxIterations = paddedWidth * paddedHeight * 4;
  let iterations = 0;
  const visited = new Set();

  do {
    const key = `${x},${y}`;
    if (!visited.has(key)) {
      // Store point in original image coordinates
      const origX = (x - 1 + minX) / scaleFactor;
      const origY = (y - 1 + minY) / scaleFactor;
      contour.push({ x: origX, y: origY });
      visited.add(key);
    }

    // Turn left, then try straight, then right, then back
    // This follows the left wall (outer boundary)
    let found = false;
    const checkOrder = [(dir + 3) % 4, dir, (dir + 1) % 4, (dir + 2) % 4];

    for (const checkDir of checkOrder) {
      const nx = x + dx[checkDir];
      const ny = y + dy[checkDir];
      if (getMask(nx, ny) === 1) {
        x = nx;
        y = ny;
        dir = checkDir;
        found = true;
        break;
      }
    }

    if (!found) break;
    iterations++;
    if (iterations > maxIterations) {
      console.warn('[Contour] Max iterations reached');
      break;
    }
  } while (x !== startX || y !== startY || iterations < 4);

  console.log(`[Contour] Traced ${contour.length} boundary points`);

  if (contour.length < 4) {
    const invScale = 1 / scaleFactor;
    return [
      { x: minX * invScale, y: minY * invScale },
      { x: (maxX + 1) * invScale, y: minY * invScale },
      { x: (maxX + 1) * invScale, y: (maxY + 1) * invScale },
      { x: minX * invScale, y: (maxY + 1) * invScale }
    ];
  }

  // Simplify the contour - use tolerance proportional to original size
  // Lower tolerance = more accurate contour following (was 0.5%, now 0.2%)
  const tolerance = Math.max(1, Math.max(width, height) * 0.002); // 0.2% of size
  const simplified = simplifyPath(contour, tolerance);

  console.log(`[Contour] Simplified from ${contour.length} to ${simplified.length} points (tolerance: ${tolerance.toFixed(1)})`);

  // Ensure we have enough points for a smooth curve
  if (simplified.length < 40 && contour.length > 50) {
    // Re-sample for smoother result - use more points for better accuracy
    const step = Math.max(1, Math.floor(contour.length / 120));
    const sampled = contour.filter((_, i) => i % step === 0);
    console.log(`[Contour] Re-sampled to ${sampled.length} points`);
    return sampled;
  }

  return simplified;
}

// ============================================================================
// COLOR DETECTION FOR VINYL CUTTING
// Maps pixels to basic colors: red, blue, green, yellow, orange, purple,
// pink, cyan, brown, black, white, grey
// ============================================================================

// Basic color palette for vinyl cutting - maps detected colors to these
const BASIC_COLORS = {
  RED:    { hex: '#FF0000', r: 255, g: 0,   b: 0   },
  BLUE:   { hex: '#0000FF', r: 0,   g: 0,   b: 255 },
  GREEN:  { hex: '#00FF00', r: 0,   g: 255, b: 0   },
  YELLOW: { hex: '#FFFF00', r: 255, g: 255, b: 0   },
  ORANGE: { hex: '#FF8000', r: 255, g: 128, b: 0   },
  PURPLE: { hex: '#800080', r: 128, g: 0,   b: 128 },
  PINK:   { hex: '#FF80C0', r: 255, g: 128, b: 192 },
  CYAN:   { hex: '#00FFFF', r: 0,   g: 255, b: 255 },
  BROWN:  { hex: '#804000', r: 128, g: 64,  b: 0   },
  BLACK:  { hex: '#000000', r: 0,   g: 0,   b: 0   },
  WHITE:  { hex: '#FFFFFF', r: 255, g: 255, b: 255 },
  GREY:   { hex: '#808080', r: 128, g: 128, b: 128 },
};

/**
 * Map an RGB color to the nearest basic color name
 * Uses HSL for better color matching
 */
function mapToBasicColor(r, g, b) {
  // Convert to HSL for better color classification
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2 / 255; // 0-1
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1)) / 255;

  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  h *= 360; // Convert to degrees

  // Check for achromatic colors first (black, white, grey)
  if (s < 0.15) {
    // Low saturation = grey scale
    if (l < 0.2) return 'BLACK';
    if (l > 0.85) return 'WHITE';
    return 'GREY';
  }

  // Check for very dark or very light colors
  if (l < 0.15) return 'BLACK';
  if (l > 0.9) return 'WHITE';

  // Map hue to color name - WIDER ranges to avoid splitting similar colors
  // Red: 0-20, 340-360
  // Orange: 20-25 (very narrow - only TRUE orange like #FF8000)
  // Yellow: 25-75 (wide - includes gold, mustard, orangish-yellow)
  // Green: 75-165
  // Cyan: 165-195
  // Blue: 195-260
  // Purple: 260-290
  // Pink/Magenta: 290-340

  if (h < 20 || h >= 340) {
    // Red zone - could also be brown or pink based on lightness/saturation
    if (l < 0.35 && s < 0.5) return 'BROWN';
    if (l > 0.6 && s < 0.6) return 'PINK';
    return 'RED';
  }
  if (h < 25) {
    // Very narrow orange zone - only true bright orange
    // Dark orange = brown, light orange = yellow
    if (l < 0.4) return 'BROWN';
    if (l > 0.6) return 'YELLOW'; // Light orange → yellow
    return 'ORANGE';
  }
  if (h < 75) {
    // Yellow range - includes orangish-yellow, gold, mustard
    // Very dark yellows become brown
    if (l < 0.3) return 'BROWN';
    return 'YELLOW';
  }
  if (h < 165) return 'GREEN';
  if (h < 195) return 'CYAN';
  if (h < 260) return 'BLUE';
  if (h < 290) return 'PURPLE';
  // 290-340: pink/magenta
  return 'PINK';
}

/**
 * Detect dominant colors in an image for vinyl cutting color separation
 * Maps all colors to basic color names (red, blue, green, yellow, black, white, etc.)
 * @param {string} imagePath - Path to image file
 * @param {number} maxColors - Maximum number of colors to return (default 6)
 * @returns {Promise<Array<{hex: string, name: string, count: number, percentage: number}>>}
 */
async function detectColors(imagePath, maxColors = 6) {
  try {
    // Read image and get raw pixel data
    const { data, info } = await sharp(imagePath)
      .ensureAlpha()
      .resize(200, 200, { fit: 'inside' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { channels } = info;
    const colorCounts = new Map();
    let totalVisiblePixels = 0;

    // Count pixels by basic color name
    for (let i = 0; i < data.length; i += channels) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];

      // Skip transparent pixels
      if (a < 128) continue;

      totalVisiblePixels++;

      // Map to basic color
      const colorName = mapToBasicColor(r, g, b);
      colorCounts.set(colorName, (colorCounts.get(colorName) || 0) + 1);
    }

    // Convert to array with hex values and sort by count
    const colors = Array.from(colorCounts.entries())
      .map(([name, count]) => ({
        name,
        hex: BASIC_COLORS[name].hex,
        count,
        percentage: Math.round((count / totalVisiblePixels) * 100)
      }))
      .sort((a, b) => b.count - a.count);

    // Filter out WHITE (background) and colors with less than 1% coverage (noise)
    // WHITE is almost always the background in vinyl cutting designs
    const filtered = colors.filter(c => c.name !== 'WHITE' && c.percentage >= 1);

    // Limit to maxColors
    const result = filtered.slice(0, maxColors);

    console.log(`[DetectColors] Found ${result.length} basic colors (excluding WHITE):`, result.map(c => `${c.name} ${c.hex} (${c.percentage}%)`).join(', '));
    return result;

  } catch (err) {
    console.error('[DetectColors] Error:', err.message);
    return [];
  }
}

// ============================================================================
// BEZIER-PRESERVING CONTOUR PIPELINE (Phase 1 Fix)
// Uses potrace for native bezier curves, paper.js for bezier-preserving offset
// Silhouette Cameo handles bezier curves natively - no need to polygonize
// ============================================================================

/**
 * Extract contours for each color in an image - this is how vinyl cutting works!
 * Each color layer gets its own cut path that traces ONLY that color's areas.
 * Uses basic color mapping (red, blue, green, etc.) for consistent results.
 * @param {string} imagePath - Path to image file
 * @param {number} maxColors - Maximum colors to extract (default 6)
 * @returns {Promise<{colors: Array<{hex, name, contourPath, count, percentage}>, width, height}>}
 */
async function extractColorContours(imagePath, maxColors = 6) {
  const image = sharp(imagePath);
  const metadata = await image.metadata();
  const origWidth = metadata.width;
  const origHeight = metadata.height;

  // Downsample for faster processing - cut paths don't need pixel-perfect resolution
  // Max dimension 800px is enough for clean contours
  const MAX_DIMENSION = 800;
  let processWidth = origWidth;
  let processHeight = origHeight;
  let scaleFactor = 1;

  if (origWidth > MAX_DIMENSION || origHeight > MAX_DIMENSION) {
    scaleFactor = MAX_DIMENSION / Math.max(origWidth, origHeight);
    processWidth = Math.round(origWidth * scaleFactor);
    processHeight = Math.round(origHeight * scaleFactor);
  }

  console.log(`[ColorContours] Processing ${origWidth}x${origHeight} -> ${processWidth}x${processHeight}: ${path.basename(imagePath)}`);

  // First, detect the dominant basic colors
  const colors = await detectColors(imagePath, maxColors);
  if (colors.length === 0) {
    console.warn('[ColorContours] No colors detected');
    return { colors: [], width: origWidth, height: origHeight };
  }

  console.log(`[ColorContours] Extracting contours for ${colors.length} basic colors:`, colors.map(c => c.name).join(', '));

  // Read downsampled raw pixel data for color isolation
  const { data, info } = await sharp(imagePath)
    .resize(processWidth, processHeight, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const resultColors = [];

  // For each detected basic color, create a mask by mapping pixels to basic colors
  for (const colorInfo of colors) {
    const targetColorName = colorInfo.name;

    console.log(`[ColorContours] Creating mask for ${targetColorName} (${colorInfo.hex})...`);

    // Create a binary mask: white where this basic color exists, black elsewhere
    const maskData = Buffer.alloc(processWidth * processHeight);
    let pixelCount = 0;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];

      // Skip transparent pixels
      if (a < 128) continue;

      // Map this pixel to a basic color and check if it matches
      const pixelBasicColor = mapToBasicColor(r, g, b);

      const pixelIdx = i / 4;
      if (pixelBasicColor === targetColorName) {
        maskData[pixelIdx] = 255; // White = this color
        pixelCount++;
      }
    }

    console.log(`[ColorContours] ${targetColorName}: ${pixelCount} pixels matched`);

    // Skip if no pixels matched (shouldn't happen but just in case)
    if (pixelCount === 0) {
      console.log(`[ColorContours] ${targetColorName}: skipping, no pixels`);
      continue;
    }

    // Save mask as temporary PNG for potrace
    const tempMaskPath = path.join(TEMP_FOLDER, `mask_${Date.now()}_${targetColorName}.png`);

    await sharp(maskData, {
      raw: { width: processWidth, height: processHeight, channels: 1 }
    })
      .png()
      .toFile(tempMaskPath);

    // Trace the mask with potrace
    // Uses learned parameters from Studio3 training, falls back to blocky defaults
    const vinylParams = getLearnedPotraceParams('vinyl');
    try {
      const contourResult = await new Promise((resolve, reject) => {
        potrace.trace(tempMaskPath, vinylParams, (err, svg) => {
          // Clean up temp file
          try { fs.unlinkSync(tempMaskPath); } catch (e) { /* ignore */ }

          if (err) {
            reject(err);
            return;
          }

          // Extract path data
          const pathMatch = svg.match(/d="([^"]+)"/);
          if (!pathMatch) {
            console.log(`[ColorContours] ${targetColorName}: potrace returned no path`);
            resolve([]); // No path for this color (might be too sparse)
            return;
          }

          // Scale the path back to original dimensions if we downsampled
          let pathData = pathMatch[1];
          console.log(`[ColorContours] ${targetColorName}: raw potrace path length ${pathData.length} chars`);

          if (scaleFactor !== 1) {
            pathData = scaleSvgPath(pathData, 1 / scaleFactor);
            console.log(`[ColorContours] ${targetColorName}: scaled path length ${pathData.length} chars`);
          }

          // Clean up the path and split into SEPARATE paths for each contour
          // This is critical so the cutter LIFTS between shapes instead of cutting travel lines
          // Use very light simplification (1.0) to preserve shape accuracy
          const pathsArray = cleanSvgPathForVinyl(pathData, 1.0, 0);
          console.log(`[ColorContours] ${targetColorName}: cleaned to ${pathsArray.length} paths`);

          resolve(pathsArray);
        });
      });

      if (contourResult && contourResult.length > 0) {
        // contourResult is now an ARRAY of separate path strings
        const totalChars = contourResult.reduce((sum, p) => sum + (p?.length || 0), 0);
        console.log(`[ColorContours] ${targetColorName}: ${contourResult.length} separate paths, total ${totalChars} chars`);
        resultColors.push({
          hex: colorInfo.hex,
          name: targetColorName,
          // Store as array of separate paths - ensures cutter lifts between shapes
          contourPaths: contourResult,
          // Keep single path for backward compatibility (joined)
          contourPath: contourResult.join(' '),
          count: colorInfo.count,
          percentage: colorInfo.percentage
        });
      } else {
        console.log(`[ColorContours] ${targetColorName}: no contour found (too sparse)`);
      }
    } catch (err) {
      console.warn(`[ColorContours] Failed to trace ${targetColorName}:`, err.message);
      // Clean up temp file on error
      try { fs.unlinkSync(tempMaskPath); } catch (e) { /* ignore */ }
    }
  }

  console.log(`[ColorContours] Extracted ${resultColors.length} color contours`);
  return { colors: resultColors, width: origWidth, height: origHeight };
}

/**
 * Extract contour from image as native SVG bezier path using potrace
 * This preserves curve fidelity instead of converting to polygon points
 * @param {string} imagePath - Path to PNG with transparency
 * @returns {Promise<{svgPath: string, width: number, height: number}>} SVG path data with beziers
 */
async function extractContourBezier(imagePath) {
  const image = sharp(imagePath);
  const metadata = await image.metadata();
  const { width, height } = metadata;

  console.log(`[ContourBezier] Processing at FULL resolution: ${width}x${height}`);

  // Extract alpha channel and create a grayscale PNG for potrace
  // Potrace traces boundaries between black and white
  // We make opaque areas WHITE and transparent areas BLACK
  const tempPngPath = path.join(TEMP_FOLDER, `contour_${Date.now()}.png`);

  await image
    .ensureAlpha()
    .extractChannel(3) // Alpha channel
    .negate()          // Invert: now opaque=black, transparent=white (potrace traces black)
    .png()
    .toFile(tempPngPath);

  // Use learned parameters from Studio3 training, falls back to sticker defaults
  const stickerParams = getLearnedPotraceParams('sticker');

  return new Promise((resolve, reject) => {
    potrace.trace(tempPngPath, stickerParams, (err, svg) => {
      // Clean up temp file
      try { fs.unlinkSync(tempPngPath); } catch (e) { /* ignore */ }

      if (err) {
        console.error('[ContourBezier] Potrace failed:', err.message);
        reject(err);
        return;
      }

      // Extract the path data from the SVG
      // Potrace outputs: <svg ...><path d="..." .../></svg>
      const pathMatch = svg.match(/d="([^"]+)"/);
      if (!pathMatch) {
        console.error('[ContourBezier] No path found in potrace output');
        reject(new Error('No path in potrace output'));
        return;
      }

      const svgPath = pathMatch[1];
      console.log(`[ContourBezier] Extracted bezier path (${svgPath.length} chars)`);

      resolve({
        svgPath,
        width,
        height
      });
    });
  });
}

/**
 * Offset an SVG path using paper.js while PRESERVING bezier curves
 * Unlike offsetPolygon, this does NOT flatten curves to line segments
 * @param {string} svgPathData - SVG path d attribute (with bezier curves)
 * @param {number} offset - Offset amount in same units as path
 * @returns {string} Offset SVG path data with bezier curves preserved
 */
function offsetSvgPathBezier(svgPathData, offset) {
  if (!svgPathData || offset === 0) return svgPathData;

  try {
    // Initialize paper.js for Node.js (without DOM canvas)
    paper.setup(new paper.Size(1, 1));

    // Import the SVG path directly - this preserves bezier curves!
    const pathItem = new paper.Path(svgPathData);

    if (!pathItem || pathItem.segments.length < 3) {
      console.warn('[OffsetBezier] Invalid path, returning original');
      return svgPathData;
    }

    // Close the path if not already closed
    if (!pathItem.closed) {
      pathItem.closePath();
    }

    // Use paper.js offset method if available
    let offsetPath;
    if (typeof pathItem.offset === 'function') {
      offsetPath = pathItem.offset(offset, { join: 'round' });
    } else {
      // Manual offset using normals - but preserve bezier structure
      offsetPath = new paper.Path();
      const pathLength = pathItem.length;
      const numSamples = Math.max(pathItem.segments.length * 3, 50);
      const step = pathLength / numSamples;

      for (let d = 0; d < pathLength; d += step) {
        const point = pathItem.getPointAt(d);
        const normal = pathItem.getNormalAt(d);
        if (point && normal) {
          offsetPath.add(point.add(normal.multiply(offset)));
        }
      }
      offsetPath.closePath();
      // Smooth to regenerate bezier curves
      offsetPath.smooth({ type: 'continuous' });
    }

    // CRITICAL: Export path data WITHOUT flattening!
    // This preserves the native bezier curves
    const resultPath = offsetPath.pathData;

    // Cleanup
    pathItem.remove();
    offsetPath.remove();

    console.log(`[OffsetBezier] Offset applied, beziers preserved (${resultPath.length} chars)`);
    return resultPath;

  } catch (err) {
    console.error('[OffsetBezier] Error:', err.message);
    return svgPathData; // Return original on error
  }
}

/**
 * Scale an SVG path by a factor
 * @param {string} svgPathData - SVG path d attribute
 * @param {number} scale - Scale factor
 * @returns {string} Scaled SVG path data
 */
function scaleSvgPath(svgPathData, scale) {
  if (!svgPathData || scale === 1) return svgPathData;

  try {
    // Initialize paper.js for Node.js (without DOM canvas)
    paper.setup(new paper.Size(1, 1));

    const pathItem = new paper.Path(svgPathData);
    pathItem.scale(scale, new paper.Point(0, 0));

    const result = pathItem.pathData;
    pathItem.remove();

    return result;
  } catch (err) {
    console.error('[ScaleSvgPath] Error:', err.message);
    return svgPathData;
  }
}

/**
 * Simplify an SVG path to remove unnecessary points and create cleaner geometry
 * This is essential for blocky/pixel art where potrace creates jagged paths
 * @param {string} svgPathData - SVG path d attribute
 * @param {number} tolerance - Simplification tolerance (higher = more aggressive, default 2.0)
 * @returns {string} Simplified SVG path data
 */
function simplifySvgPath(svgPathData, tolerance = 2.0) {
  if (!svgPathData) return svgPathData;

  try {
    paper.setup(new paper.Size(1, 1));

    // Parse the path - may contain multiple subpaths (M...Z M...Z)
    const compoundPath = new paper.CompoundPath(svgPathData);

    if (!compoundPath || compoundPath.children.length === 0) {
      // Try as single path
      const singlePath = new paper.Path(svgPathData);
      if (singlePath && singlePath.segments.length > 0) {
        singlePath.simplify(tolerance);
        const result = singlePath.pathData;
        singlePath.remove();
        return result;
      }
      return svgPathData;
    }

    // Simplify each child path
    for (const child of compoundPath.children) {
      if (child instanceof paper.Path) {
        child.simplify(tolerance);
      }
    }

    const result = compoundPath.pathData;
    compoundPath.remove();

    return result;
  } catch (err) {
    console.error('[SimplifySvgPath] Error:', err.message);
    return svgPathData;
  }
}

/**
 * Clean up SVG path for vinyl cutting - makes paths more geometric
 * Uses a multi-step approach:
 * 1. Extract ONLY outer contours (remove internal holes/boundaries)
 * 2. Simplify to remove jagged pixel-level detail
 * 3. Flatten curves to straight segments where appropriate
 *
 * IMPORTANT: Returns an ARRAY of separate path strings, one per contour.
 * This ensures the cutter lifts between shapes instead of cutting travel lines.
 *
 * @param {string} svgPathData - SVG path d attribute
 * @param {number} simplifyTolerance - Initial simplification (default 3.0 for blocky art)
 * @param {number} flattenTolerance - Curve flattening tolerance (default 1.0)
 * @returns {string[]} Array of cleaned SVG path data strings, one per outer contour
 */
function cleanSvgPathForVinyl(svgPathData, simplifyTolerance = 3.0, flattenTolerance = 1.0) {
  if (!svgPathData) return [];

  try {
    paper.setup(new paper.Size(1, 1));

    // Try to parse as a CompoundPath first (handles multiple subpaths)
    let pathItem;
    try {
      pathItem = new paper.CompoundPath(svgPathData);
    } catch (e) {
      // If that fails, try as regular Path
      pathItem = new paper.Path(svgPathData);
    }

    if (!pathItem) {
      console.warn('[CleanSvgPath] Could not parse path data');
      return [];
    }

    console.log(`[CleanSvgPath] Parsed path type: ${pathItem.className}, children: ${pathItem.children?.length || 0}`);

    // If it's a simple path (not compound), just lightly simplify and return
    if (pathItem.className === 'Path' || !pathItem.children || pathItem.children.length === 0) {
      if (pathItem.segments && pathItem.segments.length > 2) {
        const absArea = Math.abs(pathItem.area || 0);
        console.log(`[CleanSvgPath] Simple path with ${pathItem.segments.length} segments, area ${absArea.toFixed(0)}`);

        if (absArea > 50) { // Minimum area threshold
          // Light simplification only - don't distort the path
          if (simplifyTolerance > 0) {
            pathItem.simplify(simplifyTolerance * 0.5);
          }
          const result = pathItem.pathData;
          pathItem.remove();
          console.log(`[CleanSvgPath] Simplified simple path: ${result.length} chars`);
          return [result];
        }
      }
      pathItem.remove();
      console.warn('[CleanSvgPath] Path too small or invalid');
      return [];
    }

    // It's a CompoundPath with children - extract meaningful outer contours
    // Strategy: Take paths with significant area (absolute value), sort by area descending
    // The largest paths are typically the main shapes, smaller ones are holes or noise

    const allPaths = [];
    const minArea = 50; // Minimum absolute area to keep

    for (const child of pathItem.children) {
      if (child instanceof paper.Path && child.segments && child.segments.length > 2) {
        const absArea = Math.abs(child.area || 0);
        const signedArea = child.area || 0;

        console.log(`[CleanSvgPath] Child path: ${child.segments.length} segs, signed area ${signedArea.toFixed(0)}, abs area ${absArea.toFixed(0)}`);

        if (absArea > minArea) {
          allPaths.push({
            path: child,
            area: absArea,
            signedArea: signedArea
          });
        }
      }
    }

    // Sort by absolute area (largest first)
    allPaths.sort((a, b) => b.area - a.area);

    console.log(`[CleanSvgPath] Found ${allPaths.length} significant paths`);

    // For vinyl cutting, we typically want:
    // 1. Outer boundaries of shapes (usually have the largest area)
    // 2. Skip internal holes (smaller paths that are inside larger ones)

    // Heuristic: Keep paths where signed area has the same sign as the largest path
    // OR keep all paths with significant area if they represent separate shapes

    const outerPaths = [];

    if (allPaths.length > 0) {
      // Determine the "outer" winding direction from the largest path
      const largestSignedArea = allPaths[0].signedArea;
      const outerIsPositive = largestSignedArea > 0;

      for (const { path, signedArea, area } of allPaths) {
        const isOuter = outerIsPositive ? (signedArea > 0) : (signedArea < 0);

        if (isOuter) {
          // This is an outer contour - keep it with minimal processing
          // Don't over-simplify - potrace already produces reasonable paths
          // Just do a light simplification to remove redundant points
          if (simplifyTolerance > 0) {
            path.simplify(simplifyTolerance * 0.5); // Much lighter simplification
          }
          outerPaths.push(path.pathData);
          console.log(`[CleanSvgPath] Keeping outer path, area ${area.toFixed(0)}, segments: ${path.segments?.length || 0}`);
        } else {
          console.log(`[CleanSvgPath] Skipping hole, area ${area.toFixed(0)}`);
        }
      }
    }

    pathItem.remove();

    if (outerPaths.length === 0) {
      console.warn('[CleanSvgPath] No valid outer paths extracted');
      return [];
    }

    console.log(`[CleanSvgPath] Extracted ${outerPaths.length} outer contours`);
    return outerPaths;

  } catch (err) {
    console.error('[CleanSvgPath] Error:', err.message, err.stack);
    return [];
  }
}

/**
 * Translate an SVG path by x, y offset
 * @param {string} svgPathData - SVG path d attribute
 * @param {number} tx - X translation
 * @param {number} ty - Y translation
 * @returns {string} Translated SVG path data
 */
function translateSvgPath(svgPathData, tx, ty) {
  if (!svgPathData || (tx === 0 && ty === 0)) return svgPathData;

  try {
    // Initialize paper.js for Node.js (without DOM canvas)
    paper.setup(new paper.Size(1, 1));

    const pathItem = new paper.Path(svgPathData);
    pathItem.translate(new paper.Point(tx, ty));

    const result = pathItem.pathData;
    pathItem.remove();

    return result;
  } catch (err) {
    console.error('[TranslateSvgPath] Error:', err.message);
    return svgPathData;
  }
}

/**
 * Rotate an SVG path by angle (degrees) around its center
 * @param {string} svgPathData - SVG path d attribute
 * @param {number} angleDeg - Rotation angle in degrees
 * @returns {string} Rotated SVG path data
 */
function rotateSvgPath(svgPathData, angleDeg) {
  if (!svgPathData || angleDeg === 0) return svgPathData;

  try {
    // Initialize paper.js for Node.js (without DOM canvas)
    paper.setup(new paper.Size(1, 1));

    const pathItem = new paper.Path(svgPathData);
    const center = pathItem.bounds.center;
    pathItem.rotate(angleDeg, center);

    const result = pathItem.pathData;
    pathItem.remove();

    return result;
  } catch (err) {
    console.error('[RotateSvgPath] Error:', err.message);
    return svgPathData;
  }
}

/**
 * Process design and extract bezier contour (new pipeline)
 * @param {object} design - Design object with imagePath
 * @param {number} targetSize - Target size in pixels
 * @param {boolean} scaleByLargestDimension - Scale mode
 * @returns {Promise<object>} Processed design with bezier contour
 */
async function processDesignBezier(design, targetSize, scaleByLargestDimension = false) {
  // Remove background
  const noBgPath = await removeBackground(design.imagePath);
  const isTemp = noBgPath !== design.imagePath;

  // Get image dimensions
  const metadata = await sharp(noBgPath).metadata();

  // Calculate scale
  let scale;
  if (scaleByLargestDimension) {
    const largestDim = Math.max(metadata.width, metadata.height);
    scale = targetSize / largestDim;
  } else {
    scale = targetSize / metadata.height;
  }

  const scaledWidth = Math.round(metadata.width * scale);
  const scaledHeight = Math.round(metadata.height * scale);

  console.log(`[ProcessBezier] ${design.title}: ${metadata.width}x${metadata.height} -> ${scaledWidth}x${scaledHeight}`);

  // Extract bezier contour using potrace
  let bezierData;
  try {
    bezierData = await extractContourBezier(noBgPath);
  } catch (err) {
    console.warn(`[ProcessBezier] Bezier extraction failed, falling back to polygon: ${err.message}`);
    // Fallback to old polygon method
    const rawContour = await extractContour(noBgPath);
    const contour = rawContour.map(p => ({ x: p.x * scale, y: p.y * scale }));
    const bounds = getContourBounds(contour);
    return {
      ...design,
      processedPath: noBgPath,
      isTemp,
      contour, // Polygon points (fallback)
      svgContour: null,
      bounds,
      width: scaledWidth,
      height: scaledHeight,
      originalWidth: metadata.width,
      originalHeight: metadata.height,
      scale,
      useBezier: false
    };
  }

  // Scale the bezier path
  const scaledSvgPath = scaleSvgPath(bezierData.svgPath, scale);

  return {
    ...design,
    processedPath: noBgPath,
    isTemp,
    contour: null, // Not using polygon points
    svgContour: scaledSvgPath, // Native bezier SVG path
    bounds: {
      minX: 0, minY: 0,
      maxX: scaledWidth, maxY: scaledHeight,
      width: scaledWidth, height: scaledHeight
    },
    width: scaledWidth,
    height: scaledHeight,
    originalWidth: metadata.width,
    originalHeight: metadata.height,
    scale,
    useBezier: true
  };
}

// ============================================================================
// END BEZIER-PRESERVING PIPELINE
// ============================================================================

/**
 * Calculate polygon area using shoelace formula
 */
function polygonArea(points) {
  let area = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += points[i].x * points[j].y;
    area -= points[j].x * points[i].y;
  }
  return area / 2;
}

/**
 * Compute convex hull using Graham scan algorithm
 * @param {Array} points - Array of {x, y} points
 * @returns {Array} Convex hull points in counter-clockwise order
 */
function computeConvexHull(points) {
  if (points.length < 3) return points;

  // Find the point with lowest y (and leftmost if tie)
  let lowest = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].y < points[lowest].y ||
        (points[i].y === points[lowest].y && points[i].x < points[lowest].x)) {
      lowest = i;
    }
  }

  const pivot = points[lowest];

  // Sort points by polar angle with respect to pivot
  const sorted = points
    .filter((_, i) => i !== lowest)
    .map(p => ({
      point: p,
      angle: Math.atan2(p.y - pivot.y, p.x - pivot.x),
      dist: (p.x - pivot.x) ** 2 + (p.y - pivot.y) ** 2
    }))
    .sort((a, b) => {
      if (Math.abs(a.angle - b.angle) < 1e-10) {
        return a.dist - b.dist; // Same angle: closer first
      }
      return a.angle - b.angle;
    })
    .map(p => p.point);

  // Graham scan
  const hull = [pivot];

  for (const p of sorted) {
    // Remove points that make clockwise turn
    while (hull.length > 1 && crossProduct(hull[hull.length - 2], hull[hull.length - 1], p) <= 0) {
      hull.pop();
    }
    hull.push(p);
  }

  return hull;
}

/**
 * Cross product of vectors OA and OB where O is origin point
 * Positive = counter-clockwise, Negative = clockwise, Zero = collinear
 */
function crossProduct(o, a, b) {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/**
 * Simplify a path using Douglas-Peucker algorithm
 * @param {Array} points - Array of {x, y} points
 * @param {number} tolerance - Distance tolerance for point removal
 * @returns {Array} Simplified path
 */
function simplifyPath(points, tolerance) {
  if (points.length <= 2) return points;

  // Find the point with maximum distance from line between first and last
  let maxDist = 0;
  let maxIndex = 0;
  const first = points[0];
  const last = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const dist = pointToLineDistance(points[i], first, last);
    if (dist > maxDist) {
      maxDist = dist;
      maxIndex = i;
    }
  }

  // If max distance is greater than tolerance, recursively simplify
  if (maxDist > tolerance) {
    const left = simplifyPath(points.slice(0, maxIndex + 1), tolerance);
    const right = simplifyPath(points.slice(maxIndex), tolerance);
    return left.slice(0, -1).concat(right);
  } else {
    return [first, last];
  }
}

/**
 * Calculate perpendicular distance from point to line
 */
function pointToLineDistance(point, lineStart, lineEnd) {
  const dx = lineEnd.x - lineStart.x;
  const dy = lineEnd.y - lineStart.y;
  const lenSq = dx * dx + dy * dy;

  if (lenSq === 0) {
    return Math.sqrt(
      (point.x - lineStart.x) ** 2 + (point.y - lineStart.y) ** 2
    );
  }

  const t = Math.max(0, Math.min(1,
    ((point.x - lineStart.x) * dx + (point.y - lineStart.y) * dy) / lenSq
  ));

  const projX = lineStart.x + t * dx;
  const projY = lineStart.y + t * dy;

  return Math.sqrt((point.x - projX) ** 2 + (point.y - projY) ** 2);
}

/**
 * Get bounding box of a contour
 * @param {Array} contour - Array of {x, y} points
 * @returns {object} {minX, minY, maxX, maxY, width, height}
 */
function getContourBounds(contour) {
  let minX = Infinity, minY = Infinity;
  let maxX = -Infinity, maxY = -Infinity;

  for (const p of contour) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }

  return {
    minX, minY, maxX, maxY,
    width: maxX - minX,
    height: maxY - minY
  };
}

/**
 * Process a design: remove background, extract contour, get dimensions
 * @param {object} design - Design object with imagePath
 * @param {number} targetSize - Target size in pixels for the sticker
 * @param {boolean} scaleByLargestDimension - If true, scale so largest side = targetSize
 * @returns {Promise<object>} Processed design with contour, dimensions, temp file
 */
async function processDesign(design, targetSize, scaleByLargestDimension = false) {
  // Remove background
  const noBgPath = await removeBackground(design.imagePath);
  const isTemp = noBgPath !== design.imagePath;

  // Get image dimensions
  const metadata = await sharp(noBgPath).metadata();

  // Calculate scale based on mode - allows both scaling up AND down to match targetSize
  let scale;
  if (scaleByLargestDimension) {
    // Scale so the largest dimension becomes targetSize
    const largestDim = Math.max(metadata.width, metadata.height);
    scale = targetSize / largestDim;
  } else {
    // Original behavior: scale by height
    scale = targetSize / metadata.height;
  }

  const scaledWidth = Math.round(metadata.width * scale);
  const scaledHeight = Math.round(metadata.height * scale);

  console.log(`[Scale] ${design.title}: ${metadata.width}x${metadata.height} -> ${scaledWidth}x${scaledHeight} (scale: ${scale.toFixed(2)}x, target: ${targetSize}px)`);
  if (scale > 1) {
    console.log(`[Scale] Scaling UP by ${((scale - 1) * 100).toFixed(0)}%`);
  } else if (scale < 1) {
    console.log(`[Scale] Scaling DOWN by ${((1 - scale) * 100).toFixed(0)}%`);
  }

  // Extract contour from the background-removed image
  const rawContour = await extractContour(noBgPath);

  // Scale contour to target size
  const contour = rawContour.map(p => ({
    x: p.x * scale,
    y: p.y * scale
  }));

  const bounds = getContourBounds(contour);

  return {
    ...design,
    processedPath: noBgPath,
    isTemp,
    contour,
    bounds,
    width: scaledWidth,
    height: scaledHeight,
    originalWidth: metadata.width,
    originalHeight: metadata.height,
    scale
  };
}

/**
 * Calculate grid layout for stickers on a sheet
 * @param {number} stickerSizeInches - Size of each sticker (square)
 * @returns {object} Grid configuration
 */
function calculateGridLayout(stickerSizeInches = DEFAULT_STICKER_SIZE_INCHES) {
  const stickerSizePx = Math.floor(stickerSizeInches * SHEET_CONFIG.dpi);

  // Available area after margins
  const availableWidth = SHEET_CONFIG.widthPx - (2 * SHEET_CONFIG.marginPx);
  const availableHeight = SHEET_CONFIG.heightPx - (2 * SHEET_CONFIG.marginPx);

  // Calculate how many stickers fit
  const cols = Math.floor((availableWidth + SHEET_CONFIG.gapPx) / (stickerSizePx + SHEET_CONFIG.gapPx));
  const rows = Math.floor((availableHeight + SHEET_CONFIG.gapPx) / (stickerSizePx + SHEET_CONFIG.gapPx));

  // Center the grid
  const totalGridWidth = cols * stickerSizePx + (cols - 1) * SHEET_CONFIG.gapPx;
  const totalGridHeight = rows * stickerSizePx + (rows - 1) * SHEET_CONFIG.gapPx;
  const offsetX = Math.floor((SHEET_CONFIG.widthPx - totalGridWidth) / 2);
  const offsetY = Math.floor((SHEET_CONFIG.heightPx - totalGridHeight) / 2);

  return {
    cols,
    rows,
    capacity: cols * rows,
    stickerSizePx,
    stickerSizeInches,
    offsetX,
    offsetY,
    gapPx: SHEET_CONFIG.gapPx,
    sheetWidthPx: SHEET_CONFIG.widthPx,
    sheetHeightPx: SHEET_CONFIG.heightPx
  };
}

/**
 * Get position for a sticker at a given index
 * @param {number} index - Sticker index (0-based)
 * @param {object} grid - Grid configuration from calculateGridLayout
 * @returns {object} {x, y} position in pixels
 */
function getStickerPosition(index, grid) {
  const col = index % grid.cols;
  const row = Math.floor(index / grid.cols);

  return {
    x: grid.offsetX + col * (grid.stickerSizePx + grid.gapPx),
    y: grid.offsetY + row * (grid.stickerSizePx + grid.gapPx),
    width: grid.stickerSizePx,
    height: grid.stickerSizePx
  };
}

/**
 * Group designs into sheets based on grid capacity
 * @param {Array} designs - Array of {imagePath, quantity} objects
 * @param {number} stickerSizeInches - Size of stickers
 * @returns {Array} Array of sheets, each containing design placements
 */
function groupIntoSheets(designs, stickerSizeInches = DEFAULT_STICKER_SIZE_INCHES) {
  const grid = calculateGridLayout(stickerSizeInches);
  const sheets = [];
  let currentSheet = [];

  // Expand designs by quantity
  const expandedDesigns = [];
  for (const design of designs) {
    const qty = Math.max(1, parseInt(design.quantity) || 1);
    for (let i = 0; i < qty; i++) {
      expandedDesigns.push({
        imagePath: design.imagePath,
        title: design.title || path.basename(design.imagePath, path.extname(design.imagePath))
      });
    }
  }

  // Group into sheets
  for (const design of expandedDesigns) {
    if (currentSheet.length >= grid.capacity) {
      sheets.push(currentSheet);
      currentSheet = [];
    }

    const position = getStickerPosition(currentSheet.length, grid);
    currentSheet.push({
      ...design,
      ...position,
      index: currentSheet.length
    });
  }

  // Don't forget the last sheet
  if (currentSheet.length > 0) {
    sheets.push(currentSheet);
  }

  return {
    sheets,
    grid,
    totalStickers: expandedDesigns.length,
    totalSheets: sheets.length
  };
}

/**
 * Generate print-ready PNG sheet
 * @param {Array} placements - Array of sticker placements from groupIntoSheets
 * @param {object} grid - Grid configuration
 * @param {string} outputPath - Where to save the PNG
 * @param {object} options - Options including removeBackgrounds
 * @returns {Promise<string>} Path to generated file
 */
async function generatePrintSheet(placements, grid, outputPath, options = {}) {
  const { removeBackgrounds = true } = options;

  // Create base white sheet
  const baseSheet = sharp({
    create: {
      width: grid.sheetWidthPx,
      height: grid.sheetHeightPx,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 }
    }
  });

  // Prepare composite operations
  const composites = [];
  const tempFiles = []; // Track temp files for cleanup

  for (const placement of placements) {
    try {
      let imagePath = placement.imagePath;

      // Remove background if enabled
      if (removeBackgrounds) {
        const processedPath = await removeBackground(imagePath);
        if (processedPath !== imagePath) {
          tempFiles.push(processedPath);
          imagePath = processedPath;
        }
      }

      // Read and resize sticker image
      const stickerBuffer = await sharp(imagePath)
        .resize(placement.width, placement.height, {
          fit: 'contain',
          background: { r: 255, g: 255, b: 255, alpha: 0 }
        })
        .png()
        .toBuffer();

      composites.push({
        input: stickerBuffer,
        left: placement.x,
        top: placement.y
      });
    } catch (err) {
      console.error(`Failed to process sticker ${placement.imagePath}:`, err.message);
    }
  }

  // Composite all stickers onto sheet
  const result = await baseSheet
    .composite(composites)
    .png({ quality: 100 })
    .toFile(outputPath);

  // Clean up temp files
  cleanupTempFiles(tempFiles);

  return outputPath;
}

/**
 * Parse SVG path data into points
 * @param {string} pathData - SVG path d attribute
 * @returns {Array} Array of {x, y} points
 */
function parseSvgPath(pathData) {
  const points = [];
  const commands = pathData.match(/[MLHVCSQTAZ][^MLHVCSQTAZ]*/gi) || [];

  let currentX = 0;
  let currentY = 0;
  let startX = 0;
  let startY = 0;

  for (const cmd of commands) {
    const type = cmd[0].toUpperCase();
    const isRelative = cmd[0] === cmd[0].toLowerCase();
    const args = cmd.slice(1).trim().split(/[\s,]+/).map(parseFloat).filter(n => !isNaN(n));

    switch (type) {
      case 'M': // Move to
        if (isRelative) {
          currentX += args[0];
          currentY += args[1];
        } else {
          currentX = args[0];
          currentY = args[1];
        }
        startX = currentX;
        startY = currentY;
        points.push({ x: currentX, y: currentY });
        break;

      case 'L': // Line to
        for (let i = 0; i < args.length; i += 2) {
          if (isRelative) {
            currentX += args[i];
            currentY += args[i + 1];
          } else {
            currentX = args[i];
            currentY = args[i + 1];
          }
          points.push({ x: currentX, y: currentY });
        }
        break;

      case 'H': // Horizontal line
        for (const arg of args) {
          currentX = isRelative ? currentX + arg : arg;
          points.push({ x: currentX, y: currentY });
        }
        break;

      case 'V': // Vertical line
        for (const arg of args) {
          currentY = isRelative ? currentY + arg : arg;
          points.push({ x: currentX, y: currentY });
        }
        break;

      case 'C': // Cubic bezier - sample points along curve
        for (let i = 0; i < args.length; i += 6) {
          const x1 = isRelative ? currentX + args[i] : args[i];
          const y1 = isRelative ? currentY + args[i + 1] : args[i + 1];
          const x2 = isRelative ? currentX + args[i + 2] : args[i + 2];
          const y2 = isRelative ? currentY + args[i + 3] : args[i + 3];
          const x3 = isRelative ? currentX + args[i + 4] : args[i + 4];
          const y3 = isRelative ? currentY + args[i + 5] : args[i + 5];

          // Sample bezier curve
          for (let t = 0.1; t <= 1; t += 0.1) {
            const px = bezierPoint(currentX, x1, x2, x3, t);
            const py = bezierPoint(currentY, y1, y2, y3, t);
            points.push({ x: px, y: py });
          }

          currentX = x3;
          currentY = y3;
        }
        break;

      case 'Z': // Close path
        if (points.length > 0 && (currentX !== startX || currentY !== startY)) {
          points.push({ x: startX, y: startY });
        }
        currentX = startX;
        currentY = startY;
        break;
    }
  }

  return points;
}

function bezierPoint(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  const mt = 1 - t;
  const mt2 = mt * mt;
  const mt3 = mt2 * mt;
  return mt3 * p0 + 3 * mt2 * t * p1 + 3 * mt * t2 * p2 + t3 * p3;
}

/**
 * Offset a polygon path using paper.js for smooth bezier curves
 * @param {Array} points - Array of {x, y} points
 * @param {number} offset - Offset amount in pixels (positive = outward)
 * @returns {Array} Offset points
 */
function offsetPolygon(points, offset) {
  if (points.length < 3) return points;

  try {
    // Initialize paper.js with a virtual canvas
    const canvas = new paper.Canvas(1, 1);
    paper.setup(canvas);

    // Create a path from points
    const path = new paper.Path();
    points.forEach((p, i) => {
      if (i === 0) {
        path.moveTo(new paper.Point(p.x, p.y));
      } else {
        path.lineTo(new paper.Point(p.x, p.y));
      }
    });
    path.closePath();

    // Smooth the path to create bezier curves that follow the contour
    path.smooth({ type: 'continuous' });

    // Use paper.js offset method if available, otherwise use manual offset
    let offsetPath;
    if (typeof path.offset === 'function') {
      offsetPath = path.offset(offset, { join: 'round' });
    } else {
      // Manual offset: expand each segment outward
      offsetPath = new paper.Path();
      const segments = path.segments;

      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const point = seg.point;

        // Get normal at this point
        const location = path.getLocationOf(point);
        if (location) {
          const normal = path.getNormalAt(location.offset);
          if (normal) {
            const newPoint = point.add(normal.multiply(offset));
            offsetPath.add(newPoint);
          } else {
            offsetPath.add(point);
          }
        } else {
          offsetPath.add(point);
        }
      }
      offsetPath.closePath();
      offsetPath.smooth({ type: 'continuous' });
    }

    // Extract points from the offset path
    const result = [];
    const flattenedPath = offsetPath.clone();
    flattenedPath.flatten(1); // Flatten to 1px tolerance for tighter contour following

    flattenedPath.segments.forEach(seg => {
      result.push({ x: seg.point.x, y: seg.point.y });
    });

    // Cleanup paper.js
    path.remove();
    offsetPath.remove();
    flattenedPath.remove();

    return result.length >= 3 ? result : points;
  } catch (err) {
    console.warn('[Contour] paper.js offset failed, using fallback:', err.message);
    return offsetPolygonFallback(points, offset);
  }
}

/**
 * Fallback polygon offset when paper.js fails
 */
function offsetPolygonFallback(points, offset) {
  if (points.length < 3) return points;

  const result = [];
  const n = points.length;

  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n];
    const curr = points[i];
    const next = points[(i + 1) % n];

    const dx1 = curr.x - prev.x;
    const dy1 = curr.y - prev.y;
    const dx2 = next.x - curr.x;
    const dy2 = next.y - curr.y;

    const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1) || 1;
    const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2) || 1;

    const nx1 = -dy1 / len1;
    const ny1 = dx1 / len1;
    const nx2 = -dy2 / len2;
    const ny2 = dx2 / len2;

    let nx = (nx1 + nx2) / 2;
    let ny = (ny1 + ny2) / 2;
    const nlen = Math.sqrt(nx * nx + ny * ny) || 1;
    nx /= nlen;
    ny /= nlen;

    const dot = nx1 * nx2 + ny1 * ny2;
    const miter = 1 / Math.max(0.5, (1 + dot) / 2);

    result.push({
      x: curr.x + nx * offset * Math.min(miter, 2),
      y: curr.y + ny * offset * Math.min(miter, 2)
    });
  }

  return result;
}

/**
 * Convert contour points to smooth bezier SVG path using paper.js
 * @param {Array} points - Array of {x, y} points
 * @returns {string} SVG path d attribute with bezier curves
 */
function pointsToBezierPath(points) {
  if (points.length < 3) return pointsToSvgPath(points);

  try {
    const canvas = new paper.Canvas(1, 1);
    paper.setup(canvas);

    // Create path from points
    const path = new paper.Path();
    points.forEach((p, i) => {
      if (i === 0) {
        path.moveTo(new paper.Point(p.x, p.y));
      } else {
        path.lineTo(new paper.Point(p.x, p.y));
      }
    });
    path.closePath();

    // Smooth to bezier curves
    path.smooth({ type: 'continuous' });

    // Export as SVG path data
    const pathData = path.pathData;
    path.remove();

    return pathData || pointsToSvgPath(points);
  } catch (err) {
    console.warn('[Contour] paper.js bezier conversion failed:', err.message);
    return pointsToSvgPath(points);
  }
}

/**
 * Convert points back to SVG path
 * @param {Array} points - Array of {x, y} points
 * @returns {string} SVG path d attribute
 */
function pointsToSvgPath(points) {
  if (points.length === 0) return '';

  let d = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;

  for (let i = 1; i < points.length; i++) {
    d += ` L ${points[i].x.toFixed(2)} ${points[i].y.toFixed(2)}`;
  }

  d += ' Z';
  return d;
}

/**
 * Generate a simple rectangular cut path for a sticker
 * @param {object} placement - Sticker placement with x, y, width, height
 * @param {number} offsetMm - Offset in millimeters
 * @param {number} dpi - Dots per inch for conversion
 * @returns {string} SVG path element
 */
function generateRectCutPath(placement, offsetMm = DEFAULT_OFFSET_MM, dpi = SHEET_CONFIG.dpi) {
  // Convert mm to pixels (1 inch = 25.4mm)
  const offsetPx = (offsetMm / 25.4) * dpi;

  const x = placement.x - offsetPx;
  const y = placement.y - offsetPx;
  const w = placement.width + 2 * offsetPx;
  const h = placement.height + 2 * offsetPx;
  const r = offsetPx; // Corner radius

  // Rounded rectangle path
  const path = `M ${(x + r).toFixed(2)} ${y.toFixed(2)} ` +
    `L ${(x + w - r).toFixed(2)} ${y.toFixed(2)} ` +
    `Q ${(x + w).toFixed(2)} ${y.toFixed(2)} ${(x + w).toFixed(2)} ${(y + r).toFixed(2)} ` +
    `L ${(x + w).toFixed(2)} ${(y + h - r).toFixed(2)} ` +
    `Q ${(x + w).toFixed(2)} ${(y + h).toFixed(2)} ${(x + w - r).toFixed(2)} ${(y + h).toFixed(2)} ` +
    `L ${(x + r).toFixed(2)} ${(y + h).toFixed(2)} ` +
    `Q ${x.toFixed(2)} ${(y + h).toFixed(2)} ${x.toFixed(2)} ${(y + h - r).toFixed(2)} ` +
    `L ${x.toFixed(2)} ${(y + r).toFixed(2)} ` +
    `Q ${x.toFixed(2)} ${y.toFixed(2)} ${(x + r).toFixed(2)} ${y.toFixed(2)} Z`;

  return `<path d="${path}" fill="none" stroke="#FF0000" stroke-width="0.5"/>`;
}

/**
 * Rotate a contour 90 degrees clockwise around its center
 * @param {Array} contour - Array of {x, y} points
 * @param {number} origWidth - Original width before rotation
 * @param {number} origHeight - Original height before rotation
 * @returns {Array} Rotated contour points
 */
function rotateContour90(contour, origWidth, origHeight) {
  // Rotate 90° clockwise: (x, y) -> (y, origHeight - x)
  // After rotation, the new dimensions are (origHeight, origWidth)
  return contour.map(p => ({
    x: p.y,
    y: origWidth - p.x
  }));
}

/**
 * Rotate contour points by arbitrary angle around center
 * @param {Array} contour - Array of {x, y} points
 * @param {number} angleDeg - Rotation angle in degrees
 * @param {number} origWidth - Original width for center calculation
 * @param {number} origHeight - Original height for center calculation
 * @returns {Array} Rotated contour points
 */
function rotateContour(contour, angleDeg, origWidth, origHeight) {
  if (angleDeg === 0) return contour;
  if (angleDeg === 90) return rotateContour90(contour, origWidth, origHeight);
  if (angleDeg === -90 || angleDeg === 270) {
    // Rotate -90° (or 270°): (x, y) -> (origHeight - y, x)
    return contour.map(p => ({
      x: origHeight - p.y,
      y: p.x
    }));
  }

  // General rotation around center
  const angleRad = angleDeg * Math.PI / 180;
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  const cx = origWidth / 2;
  const cy = origHeight / 2;

  // Calculate new bounding box
  const bbox = getRotatedBoundingBox(origWidth, origHeight, angleDeg);
  const newCx = bbox.width / 2;
  const newCy = bbox.height / 2;

  return contour.map(p => {
    // Translate to origin, rotate, translate to new center
    const dx = p.x - cx;
    const dy = p.y - cy;
    return {
      x: dx * cos - dy * sin + newCx,
      y: dx * sin + dy * cos + newCy
    };
  });
}

/**
 * Generate a contour-based cut path for a sticker
 * Uses bezier-preserving pipeline when svgContour is available
 * @param {object} placement - Sticker placement with x, y, contour or svgContour
 * @param {number} offsetMm - Offset in millimeters for die-cut margin
 * @param {number} dpi - Dots per inch for conversion
 * @returns {string} SVG path element
 */
function generateContourCutPath(placement, offsetMm = DEFAULT_OFFSET_MM, dpi = SHEET_CONFIG.dpi) {
  const offsetPx = (offsetMm / 25.4) * dpi;

  // NEW: Use bezier-preserving pipeline if svgContour is available
  if (placement.svgContour && placement.useBezier) {
    let svgPath = placement.svgContour;

    // Handle rotation if needed
    const rotationAngle = placement.rotationAngle || (placement.rotated ? 90 : 0);
    if (rotationAngle !== 0) {
      svgPath = rotateSvgPath(svgPath, rotationAngle);
    }

    // Offset using bezier-preserving method
    svgPath = offsetSvgPathBezier(svgPath, offsetPx);

    // Translate to placement position
    svgPath = translateSvgPath(svgPath, placement.x, placement.y);

    console.log(`[CutPath] Using BEZIER path for ${placement.title || 'sticker'}`);
    return `<path d="${svgPath}" fill="none" stroke="#FF0000" stroke-width="0.5"/>`;
  }

  // FALLBACK: Use polygon-based path (legacy)
  // If no contour, fall back to rectangle
  if (!placement.contour || placement.contour.length < 3) {
    return generateRectCutPath(placement, offsetMm, dpi);
  }

  // Get contour, rotating if necessary
  let contour = placement.contour;
  const rotationAngle = placement.rotationAngle || (placement.rotated ? 90 : 0);
  if (rotationAngle !== 0 && placement.originalWidth && placement.originalHeight) {
    contour = rotateContour(contour, rotationAngle, placement.originalWidth, placement.originalHeight);
  }

  // Offset the contour outward for die-cut margin
  const offsetContour = offsetPolygon(contour, offsetPx);

  // Translate contour to placement position
  const translatedContour = offsetContour.map(p => ({
    x: p.x + placement.x,
    y: p.y + placement.y
  }));

  // Convert to SVG path
  const pathData = pointsToSvgPath(translatedContour);

  return `<path d="${pathData}" fill="none" stroke="#FF0000" stroke-width="0.5"/>`;
}

/**
 * Generate combined SVG file with embedded PNG image and cut paths
 * This is the format Cricut Design Space needs for Print Then Cut
 * @param {Array} placements - Array of sticker placements
 * @param {object} grid - Grid configuration
 * @param {string} pngPath - Path to the print PNG file
 * @param {string} outputPath - Where to save the combined SVG
 * @param {number} offsetMm - Offset for cut paths in millimeters
 * @param {boolean} useContours - Whether to use contour paths (true) or rectangles (false)
 * @returns {Promise<string>} Path to generated file
 */
async function generateCombinedSvg(placements, grid, pngPath, outputPath, offsetMm = DEFAULT_OFFSET_MM, useContours = true) {
  // Read PNG and convert to base64 data URI
  // Cricut requires embedded images, not external references
  const pngBuffer = await fs.promises.readFile(pngPath);
  const base64Png = pngBuffer.toString('base64');
  const dataUri = `data:image/png;base64,${base64Png}`;

  // SVG header with dimensions in inches for Cricut
  const widthIn = (grid.sheetWidthPx / SHEET_CONFIG.dpi).toFixed(4);
  const heightIn = (grid.sheetHeightPx / SHEET_CONFIG.dpi).toFixed(4);

  let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:xlink="http://www.w3.org/1999/xlink"
     width="${widthIn}in"
     height="${heightIn}in"
     viewBox="0 0 ${grid.sheetWidthPx} ${grid.sheetHeightPx}">
  <title>Sticker Sheet - Print Then Cut</title>
  <desc>Combined print image and cut paths for Cricut Print Then Cut</desc>

  <!-- Embedded print image as base64 -->
  <image x="0" y="0" width="${grid.sheetWidthPx}" height="${grid.sheetHeightPx}"
         href="${dataUri}"
         xlink:href="${dataUri}"/>

  <!-- Cut paths layer -->
  <g id="cut-paths" fill="none" stroke="#FF0000" stroke-width="1">
`;

  // Generate cut path for each sticker
  for (const placement of placements) {
    if (useContours && placement.contour && placement.contour.length >= 3) {
      svg += `    ${generateContourCutPath(placement, offsetMm)}\n`;
    } else {
      svg += `    ${generateRectCutPath(placement, offsetMm)}\n`;
    }
  }

  svg += `  </g>
</svg>`;

  await fs.promises.writeFile(outputPath, svg, 'utf8');
  console.log(`  Generated combined SVG: ${path.basename(outputPath)}`);
  return outputPath;
}

/**
 * Generate SVG cut file for a sheet (cut paths only, no image)
 * @param {Array} placements - Array of sticker placements
 * @param {object} grid - Grid configuration
 * @param {string} outputPath - Where to save the SVG
 * @param {number} offsetMm - Offset for cut paths in millimeters
 * @param {boolean} useContours - Whether to use contour paths (true) or rectangles (false)
 * @returns {Promise<string>} Path to generated file
 */
async function generateCutFile(placements, grid, outputPath, offsetMm = DEFAULT_OFFSET_MM, useContours = true) {
  // SVG dimensions in mm for Silhouette compatibility
  const sheetWidthMm = SHEET_CONFIG.widthInches * 25.4;
  const sheetHeightMm = SHEET_CONFIG.heightInches * 25.4;
  const dpi = SHEET_CONFIG.dpi;

  let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
     width="${sheetWidthMm}mm"
     height="${sheetHeightMm}mm"
     viewBox="0 0 ${sheetWidthMm} ${sheetHeightMm}">
  <title>Sticker Cut Lines</title>
  <desc>Cut paths for Silhouette Cameo - registration marks are on the printed sheet only</desc>

  <!-- NOTE: Registration marks are NOT included in the cut SVG -->
  <!-- The Cameo's optical sensor reads them from the printed PNG sheet -->

  <!-- Cut Paths Layer -->
  <g inkscape:groupmode="layer" inkscape:label="Cut" id="cut-paths" fill="none" stroke="#FF0000" stroke-width="0.1">
`;

  // Generate cut path for each sticker (convert from pixels to mm)
  for (const placement of placements) {
    // Convert placement from pixels to mm
    const placementMm = {
      ...placement,
      x: (placement.x / dpi) * 25.4,
      y: (placement.y / dpi) * 25.4,
      width: (placement.width / dpi) * 25.4,
      height: (placement.height / dpi) * 25.4,
      contour: placement.contour ? placement.contour.map(p => ({
        x: (p.x || p[0]) / dpi * 25.4,
        y: (p.y || p[1]) / dpi * 25.4
      })) : null
    };

    // Use contour path if available and enabled, otherwise fall back to rectangle
    if (useContours && placementMm.contour && placementMm.contour.length >= 3) {
      svg += `    ${generateContourCutPathMm(placementMm, offsetMm)}\n`;
    } else {
      svg += `    ${generateRectCutPathMm(placementMm, offsetMm)}\n`;
    }
  }

  svg += `  </g>
</svg>`;

  await fs.promises.writeFile(outputPath, svg, 'utf8');
  console.log(`  ✓ Generated Silhouette-compatible cut file with registration marks`);
  return outputPath;
}

/**
 * Generate rectangle cut path in mm for Silhouette
 */
function generateRectCutPathMm(placement, offsetMm) {
  const x = placement.x - offsetMm;
  const y = placement.y - offsetMm;
  const w = placement.width + 2 * offsetMm;
  const h = placement.height + 2 * offsetMm;
  const r = 2; // Corner radius in mm

  // Rounded rectangle path
  const path =
    `M ${(x + r).toFixed(2)} ${y.toFixed(2)} ` +
    `L ${(x + w - r).toFixed(2)} ${y.toFixed(2)} ` +
    `Q ${(x + w).toFixed(2)} ${y.toFixed(2)} ${(x + w).toFixed(2)} ${(y + r).toFixed(2)} ` +
    `L ${(x + w).toFixed(2)} ${(y + h - r).toFixed(2)} ` +
    `Q ${(x + w).toFixed(2)} ${(y + h).toFixed(2)} ${(x + w - r).toFixed(2)} ${(y + h).toFixed(2)} ` +
    `L ${(x + r).toFixed(2)} ${(y + h).toFixed(2)} ` +
    `Q ${x.toFixed(2)} ${(y + h).toFixed(2)} ${x.toFixed(2)} ${(y + h - r).toFixed(2)} ` +
    `L ${x.toFixed(2)} ${(y + r).toFixed(2)} ` +
    `Q ${x.toFixed(2)} ${y.toFixed(2)} ${(x + r).toFixed(2)} ${y.toFixed(2)} Z`;

  return `<path d="${path}" fill="none" stroke="#FF0000" stroke-width="0.1"/>`;
}

/**
 * Generate contour cut path in mm for Silhouette using smooth bezier curves
 * Uses bezier-preserving pipeline when svgContour is available
 */
function generateContourCutPathMm(placement, offsetMm) {
  // NEW: Use bezier-preserving pipeline if svgContour is available
  // Note: svgContour is already in mm coordinates when passed to this function
  if (placement.svgContour && placement.useBezier) {
    let svgPath = placement.svgContour;

    // Handle rotation if needed
    const rotationAngle = placement.rotationAngle || (placement.rotated ? 90 : 0);
    if (rotationAngle !== 0) {
      svgPath = rotateSvgPath(svgPath, rotationAngle);
    }

    // Offset using bezier-preserving method (in mm)
    svgPath = offsetSvgPathBezier(svgPath, offsetMm);

    // Translate to placement position (already in mm)
    svgPath = translateSvgPath(svgPath, placement.x, placement.y);

    console.log(`[CutPathMm] Using BEZIER path for ${placement.title || 'sticker'}`);
    return `<path d="${svgPath}" fill="none" stroke="#FF0000" stroke-width="0.1"/>`;
  }

  // FALLBACK: Use polygon-based path (legacy)
  if (!placement.contour || placement.contour.length < 3) {
    return generateRectCutPathMm(placement, offsetMm);
  }

  // Offset the contour outward using paper.js for smooth curves
  const offsetContour = offsetPolygonMm(placement.contour, offsetMm);

  // Translate contour to placement position
  const translatedContour = offsetContour.map(p => ({
    x: p.x + placement.x,
    y: p.y + placement.y
  }));

  // Convert to smooth bezier SVG path
  const pathData = pointsToBezierPathMm(translatedContour);

  return `<path d="${pathData}" fill="none" stroke="#FF0000" stroke-width="0.1"/>`;
}

/**
 * Convert mm contour points to smooth bezier SVG path
 */
function pointsToBezierPathMm(points) {
  if (points.length < 3) {
    // Fallback to linear path
    let d = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
    for (let i = 1; i < points.length; i++) {
      d += ` L ${points[i].x.toFixed(2)} ${points[i].y.toFixed(2)}`;
    }
    return d + ' Z';
  }

  try {
    const canvas = new paper.Canvas(1, 1);
    paper.setup(canvas);

    // Create path from points
    const path = new paper.Path();
    points.forEach((p, i) => {
      if (i === 0) {
        path.moveTo(new paper.Point(p.x, p.y));
      } else {
        path.lineTo(new paper.Point(p.x, p.y));
      }
    });
    path.closePath();

    // Smooth to create bezier curves
    path.smooth({ type: 'continuous' });

    // Export as SVG path data
    const pathData = path.pathData;
    path.remove();

    return pathData;
  } catch (err) {
    // Fallback to linear path
    let d = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
    for (let i = 1; i < points.length; i++) {
      d += ` L ${points[i].x.toFixed(2)} ${points[i].y.toFixed(2)}`;
    }
    return d + ' Z';
  }
}

/**
 * Polygon offset for mm coordinates using paper.js
 */
function offsetPolygonMm(polygon, offsetMm) {
  if (polygon.length < 3) return polygon;

  try {
    const canvas = new paper.Canvas(1, 1);
    paper.setup(canvas);

    // Create path from points
    const path = new paper.Path();
    polygon.forEach((p, i) => {
      if (i === 0) {
        path.moveTo(new paper.Point(p.x, p.y));
      } else {
        path.lineTo(new paper.Point(p.x, p.y));
      }
    });
    path.closePath();
    path.smooth({ type: 'continuous' });

    // Manual offset using normals - use more sample points for accuracy
    const offsetPath = new paper.Path();
    const len = path.length;
    const step = len / Math.max(polygon.length * 4, 100); // More samples for tighter following

    for (let offset = 0; offset < len; offset += step) {
      const point = path.getPointAt(offset);
      const normal = path.getNormalAt(offset);
      if (point && normal) {
        offsetPath.add(point.add(normal.multiply(offsetMm)));
      }
    }
    offsetPath.closePath();
    offsetPath.smooth({ type: 'continuous' });

    // Flatten and extract points
    offsetPath.flatten(0.25); // Tighter tolerance for more accurate contour
    const result = offsetPath.segments.map(seg => ({
      x: seg.point.x,
      y: seg.point.y
    }));

    path.remove();
    offsetPath.remove();

    return result.length >= 3 ? result : polygon;
  } catch (err) {
    // Fallback: simple centroid-based offset
    let cx = 0, cy = 0;
    for (const p of polygon) {
      cx += p.x;
      cy += p.y;
    }
    cx /= polygon.length;
    cy /= polygon.length;

    return polygon.map(p => {
      const dx = p.x - cx;
      const dy = p.y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 0.001) return p;
      const scale = (dist + offsetMm) / dist;
      return { x: cx + dx * scale, y: cy + dy * scale };
    });
  }
}

/**
 * Generate Cricut Print Then Cut SVG
 *
 * Creates a single SVG file containing:
 * - Embedded PNG of all sticker artwork (Cricut reads as "Print" layer)
 * - Vector cut paths around each sticker (Cricut reads as "Cut" layer)
 *
 * Workflow:
 * 1. Import this ONE file into Cricut Design Space
 * 2. DS automatically separates print layer and cut layer
 * 3. Hit "Make It" → Print Then Cut
 * 4. Cricut adds registration marks automatically during printing
 *
 * No manual registration marks needed! Cricut handles alignment automatically.
 *
 * @param {Array} placements - Array of sticker placements with x, y, width, height, contour
 * @param {object} grid - Grid configuration with sheetWidthPx, sheetHeightPx
 * @param {string} pngPath - Path to the print PNG file (stickers only, transparent background)
 * @param {string} outputPath - Where to save the Cricut-ready SVG
 * @param {number} offsetMm - Offset/bleed for cut paths in millimeters
 * @param {boolean} useContours - Whether to use contour paths (true) or rectangles (false)
 * @returns {Promise<string>} Path to generated file
 */
async function generateCricutSvg(placements, grid, pngPath, outputPath, offsetMm = DEFAULT_OFFSET_MM, useContours = true) {
  const dpi = SHEET_CONFIG.dpi;

  // Read the print PNG and convert to base64 for embedding
  const pngBuffer = await fs.promises.readFile(pngPath);
  const base64Png = pngBuffer.toString('base64');

  // SVG dimensions - use 72 DPI for SVG (standard) but viewBox in pixels
  // This ensures proper scaling when imported into Design Space
  const widthIn = (grid.sheetWidthPx / dpi).toFixed(4);
  const heightIn = (grid.sheetHeightPx / dpi).toFixed(4);

  // Calculate offset in pixels for cut paths
  const offsetPx = (offsetMm / 25.4) * dpi;

  // Build cut path elements
  // Using black stroke (#000000) - Cricut interprets this as cut lines
  let cutPaths = '';

  for (const placement of placements) {
    if (useContours && placement.contour && placement.contour.length >= 3) {
      // Use contour path with offset
      const offsetContour = offsetPolygon(placement.contour, offsetPx);
      if (offsetContour.length >= 3) {
        // Convert to SVG path data
        const pathData = offsetContour.map((p, i) => {
          const x = placement.x + p[0];
          const y = placement.y + p[1];
          return i === 0 ? `M ${x} ${y}` : `L ${x} ${y}`;
        }).join(' ') + ' Z';

        cutPaths += `    <path d="${pathData}" fill="none" stroke="#000000" stroke-width="1"/>\n`;
      }
    } else {
      // Rectangle with offset
      const x = placement.x - offsetPx;
      const y = placement.y - offsetPx;
      const w = placement.width + 2 * offsetPx;
      const h = placement.height + 2 * offsetPx;

      // Rectangular path
      const pathData = `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`;
      cutPaths += `    <path d="${pathData}" fill="none" stroke="#000000" stroke-width="1"/>\n`;
    }
  }

  // Generate the complete SVG
  // Structure:
  // 1. Print layer (embedded PNG image) - Cricut sees this as printable artwork
  // 2. Cut layer (vector paths) - Cricut sees these as cut lines
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:xlink="http://www.w3.org/1999/xlink"
     width="${widthIn}in"
     height="${heightIn}in"
     viewBox="0 0 ${grid.sheetWidthPx} ${grid.sheetHeightPx}">
  <title>Sticker Sheet - Print Then Cut</title>
  <desc>Combined print image and cut paths for Cricut Design Space</desc>

  <!-- Print Layer: Embedded sticker artwork PNG -->
  <image
    x="0" y="0"
    width="${grid.sheetWidthPx}" height="${grid.sheetHeightPx}"
    xlink:href="data:image/png;base64,${base64Png}"
    id="print-layer"/>

  <!-- Cut Layer: Vector cut paths -->
  <g id="cut-layer" fill="none" stroke="#000000" stroke-width="1">
${cutPaths}  </g>

</svg>`;

  await fs.promises.writeFile(outputPath, svg, 'utf8');
  console.log(`  Generated Cricut SVG: ${path.basename(outputPath)}`);
  return outputPath;
}

/**
 * Generate PDF for Cricut Print Then Cut (legacy/alternative format)
 * Creates a PDF with the print image and cut paths overlaid
 * @param {Array} placements - Array of sticker placements
 * @param {object} grid - Grid configuration
 * @param {string} pngPath - Path to the print PNG file
 * @param {string} outputPath - Where to save the PDF
 * @param {number} offsetMm - Offset for cut paths in millimeters
 * @param {boolean} useContours - Whether to use contour paths (true) or rectangles (false)
 * @returns {Promise<string>} Path to generated file
 */
async function generateCricutPdf(placements, grid, pngPath, outputPath, offsetMm = DEFAULT_OFFSET_MM, useContours = true) {
  const PDFDocument = require('pdfkit');

  // Create PDF at letter size (8.5" x 11" = 612 x 792 points at 72 DPI)
  const doc = new PDFDocument({
    size: 'letter',
    margins: { top: 0, bottom: 0, left: 0, right: 0 }
  });

  // Pipe to file
  const writeStream = fs.createWriteStream(outputPath);
  doc.pipe(writeStream);

  // PDF uses 72 points per inch, our images are 300 DPI
  // Scale factor: 72/300 = 0.24
  const scaleFactor = 72 / SHEET_CONFIG.dpi;
  const pageWidth = grid.sheetWidthPx * scaleFactor;  // 612 points (8.5")
  const pageHeight = grid.sheetHeightPx * scaleFactor; // 792 points (11")

  // Add the PNG image as background (full page)
  doc.image(pngPath, 0, 0, {
    width: pageWidth,
    height: pageHeight
  });

  // Draw cut paths in red
  doc.strokeColor('#FF0000')
     .lineWidth(0.5);

  // Convert mm offset to pixels then to points
  const offsetPx = (offsetMm / 25.4) * SHEET_CONFIG.dpi;

  for (const placement of placements) {
    if (useContours && placement.contour && placement.contour.length >= 3) {
      // Use contour path
      const offsetContour = offsetPolygon(placement.contour, offsetPx);
      if (offsetContour.length >= 3) {
        // Translate contour to placement position and convert to PDF points
        const firstPoint = offsetContour[0];
        doc.moveTo(
          (placement.x + firstPoint[0]) * scaleFactor,
          (placement.y + firstPoint[1]) * scaleFactor
        );

        for (let i = 1; i < offsetContour.length; i++) {
          const point = offsetContour[i];
          doc.lineTo(
            (placement.x + point[0]) * scaleFactor,
            (placement.y + point[1]) * scaleFactor
          );
        }
        doc.closePath().stroke();
      }
    } else {
      // Use rectangle
      const x = (placement.x - offsetPx) * scaleFactor;
      const y = (placement.y - offsetPx) * scaleFactor;
      const w = (placement.width + 2 * offsetPx) * scaleFactor;
      const h = (placement.height + 2 * offsetPx) * scaleFactor;

      doc.rect(x, y, w, h).stroke();
    }
  }

  // Finalize PDF
  doc.end();

  // Wait for write to complete
  await new Promise((resolve, reject) => {
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
  });

  console.log(`  Generated Cricut PDF: ${path.basename(outputPath)}`);
  return outputPath;
}

/**
 * Pack processed designs onto sheets using bounding box packing
 * Uses a simple shelf-based algorithm for efficient packing
 * @param {Array} processedDesigns - Array of processed designs with dimensions
 * @param {object} sheetConfig - Sheet configuration
 * @param {number} gapPx - Gap between stickers in pixels
 * @param {boolean} useRotation - Whether to try rotating stickers for better fit
 * @returns {Array} Array of sheets with placements
 */
function packDesignsOnSheets(processedDesigns, sheetConfig, gapPx, useRotation = false) {
  if (useRotation) {
    return packDesignsWithRotation(processedDesigns, sheetConfig, gapPx);
  }

  const sheets = [];
  let currentSheet = [];
  let shelfY = sheetConfig.marginPx;
  let shelfHeight = 0;
  let currentX = sheetConfig.marginPx;

  const maxWidth = sheetConfig.widthPx - 2 * sheetConfig.marginPx;
  const maxHeight = sheetConfig.heightPx - 2 * sheetConfig.marginPx;

  for (const design of processedDesigns) {
    const itemWidth = design.width + gapPx;
    const itemHeight = design.height + gapPx;

    // Check if item fits on current shelf
    if (currentX + design.width <= sheetConfig.marginPx + maxWidth) {
      // Fits on current shelf
      currentSheet.push({
        ...design,
        x: currentX,
        y: shelfY,
        rotated: false
      });
      currentX += itemWidth;
      shelfHeight = Math.max(shelfHeight, design.height);
    } else {
      // Start new shelf
      shelfY += shelfHeight + gapPx;
      shelfHeight = design.height;
      currentX = sheetConfig.marginPx;

      // Check if new shelf fits on current sheet
      if (shelfY + design.height <= sheetConfig.marginPx + maxHeight) {
        currentSheet.push({
          ...design,
          x: currentX,
          y: shelfY,
          rotated: false
        });
        currentX += itemWidth;
      } else {
        // Start new sheet
        if (currentSheet.length > 0) {
          sheets.push(currentSheet);
        }
        currentSheet = [];
        shelfY = sheetConfig.marginPx;
        shelfHeight = design.height;
        currentX = sheetConfig.marginPx;

        currentSheet.push({
          ...design,
          x: currentX,
          y: shelfY,
          rotated: false
        });
        currentX += itemWidth;
      }
    }
  }

  // Don't forget the last sheet
  if (currentSheet.length > 0) {
    sheets.push(currentSheet);
  }

  return sheets;
}

/**
 * Calculate bounding box for a rotated rectangle
 * @param {number} w - Original width
 * @param {number} h - Original height
 * @param {number} angleDeg - Rotation angle in degrees
 * @returns {object} {width, height} of bounding box
 */
function getRotatedBoundingBox(w, h, angleDeg) {
  const angleRad = angleDeg * Math.PI / 180;
  const cos = Math.abs(Math.cos(angleRad));
  const sin = Math.abs(Math.sin(angleRad));
  return {
    width: Math.ceil(w * cos + h * sin),
    height: Math.ceil(w * sin + h * cos)
  };
}

/**
 * Simple MaxRects bin packing with 90° rotation support
 * Uses bounding boxes and MaxRects algorithm for reliable packing
 * @param {Array} processedDesigns - Array of processed designs with dimensions
 * @param {object} sheetConfig - Sheet configuration
 * @param {number} gapPx - Gap between stickers in pixels
 * @returns {Array} Array of sheets with placements
 */
function packDesignsWithRotation(processedDesigns, sheetConfig, gapPx) {
  const sheets = [];
  const margin = sheetConfig.marginPx;
  const maxWidth = sheetConfig.widthPx - 2 * margin;
  const maxHeight = sheetConfig.heightPx - 2 * margin;

  console.log(`[Packing] Sheet usable area: ${maxWidth}x${maxHeight}px (${(maxWidth/300).toFixed(2)}"x${(maxHeight/300).toFixed(2)}")`);
  console.log(`[Packing] Processing ${processedDesigns.length} stickers...`);

  // Sort by area (largest first) for better packing
  const sortedDesigns = [...processedDesigns].sort((a, b) => {
    return (b.width * b.height) - (a.width * a.height);
  });

  // Simple MaxRects packer
  class MaxRectsPacker {
    constructor(width, height) {
      this.binWidth = width;
      this.binHeight = height;
      this.freeRects = [{ x: 0, y: 0, width, height }];
      this.placements = [];
    }

    findBestPosition(w, h) {
      let bestScore = Infinity;
      let bestRect = null;
      let bestRotated = false;

      for (const freeRect of this.freeRects) {
        // Try normal orientation
        if (w <= freeRect.width && h <= freeRect.height) {
          const score = freeRect.y * 10000 + freeRect.x; // Bottom-left heuristic
          if (score < bestScore) {
            bestScore = score;
            bestRect = { x: freeRect.x, y: freeRect.y };
            bestRotated = false;
          }
        }

        // Try rotated (90°)
        if (h <= freeRect.width && w <= freeRect.height) {
          const score = freeRect.y * 10000 + freeRect.x;
          if (score < bestScore) {
            bestScore = score;
            bestRect = { x: freeRect.x, y: freeRect.y };
            bestRotated = true;
          }
        }
      }

      return bestRect ? { ...bestRect, rotated: bestRotated } : null;
    }

    splitFreeRects(x, y, w, h) {
      const newFreeRects = [];

      for (const freeRect of this.freeRects) {
        // Check if placed rect overlaps
        if (x >= freeRect.x + freeRect.width || x + w <= freeRect.x ||
            y >= freeRect.y + freeRect.height || y + h <= freeRect.y) {
          newFreeRects.push(freeRect);
          continue;
        }

        // Left
        if (x > freeRect.x) {
          newFreeRects.push({
            x: freeRect.x,
            y: freeRect.y,
            width: x - freeRect.x,
            height: freeRect.height
          });
        }

        // Right
        if (x + w < freeRect.x + freeRect.width) {
          newFreeRects.push({
            x: x + w,
            y: freeRect.y,
            width: freeRect.x + freeRect.width - (x + w),
            height: freeRect.height
          });
        }

        // Top
        if (y > freeRect.y) {
          newFreeRects.push({
            x: freeRect.x,
            y: freeRect.y,
            width: freeRect.width,
            height: y - freeRect.y
          });
        }

        // Bottom
        if (y + h < freeRect.y + freeRect.height) {
          newFreeRects.push({
            x: freeRect.x,
            y: y + h,
            width: freeRect.width,
            height: freeRect.y + freeRect.height - (y + h)
          });
        }
      }

      // Remove contained rectangles
      this.freeRects = [];
      for (let i = 0; i < newFreeRects.length; i++) {
        let dominated = false;
        for (let j = 0; j < newFreeRects.length; j++) {
          if (i !== j &&
              newFreeRects[i].x >= newFreeRects[j].x &&
              newFreeRects[i].y >= newFreeRects[j].y &&
              newFreeRects[i].x + newFreeRects[i].width <= newFreeRects[j].x + newFreeRects[j].width &&
              newFreeRects[i].y + newFreeRects[i].height <= newFreeRects[j].y + newFreeRects[j].height) {
            dominated = true;
            break;
          }
        }
        if (!dominated) {
          this.freeRects.push(newFreeRects[i]);
        }
      }
    }

    insert(design) {
      const w = design.width + gapPx;
      const h = design.height + gapPx;

      const pos = this.findBestPosition(w, h);
      if (!pos) return null;

      const actualW = pos.rotated ? design.height : design.width;
      const actualH = pos.rotated ? design.width : design.height;

      this.splitFreeRects(pos.x, pos.y, actualW + gapPx, actualH + gapPx);

      const placement = {
        ...design,
        x: margin + pos.x,
        y: margin + pos.y,
        width: actualW,
        height: actualH,
        rotated: pos.rotated,
        rotationAngle: pos.rotated ? 90 : 0,
        originalWidth: design.width,
        originalHeight: design.height
      };

      this.placements.push(placement);
      return placement;
    }
  }

  // Pack designs onto sheets
  let currentPacker = new MaxRectsPacker(maxWidth, maxHeight);
  let sheetNum = 1;
  let rotatedCount = 0;

  for (const design of sortedDesigns) {
    let placement = currentPacker.insert(design);

    if (!placement) {
      console.log(`[Packing] Sheet ${sheetNum}: ${currentPacker.placements.length} stickers`);
      if (currentPacker.placements.length > 0) {
        sheets.push(currentPacker.placements);
        sheetNum++;
      }
      currentPacker = new MaxRectsPacker(maxWidth, maxHeight);
      placement = currentPacker.insert(design);

      if (!placement) {
        console.warn(`[Packing] Design too large for sheet: ${design.width}x${design.height}`);
        currentPacker.placements.push({
          ...design,
          x: margin,
          y: margin,
          width: Math.min(design.width, maxWidth),
          height: Math.min(design.height, maxHeight),
          rotated: false,
          rotationAngle: 0,
          originalWidth: design.width,
          originalHeight: design.height
        });
      }
    }

    if (placement && placement.rotated) rotatedCount++;
  }

  if (currentPacker.placements.length > 0) {
    console.log(`[Packing] Sheet ${sheetNum}: ${currentPacker.placements.length} stickers`);
    sheets.push(currentPacker.placements);
  }

  const totalStickers = sheets.reduce((sum, s) => sum + s.length, 0);
  console.log(`[Packing] Done! ${totalStickers} stickers on ${sheets.length} sheets (avg ${(totalStickers/sheets.length).toFixed(1)}/sheet, ${rotatedCount} rotated)`);

  return sheets;
}

/**
 * Generate complete sticker sheet set (print + cut files)
 * NEW FLOW: Process designs first (remove bg, extract contours), then pack efficiently
 * @param {Array} designs - Array of {imagePath, quantity, title} objects
 * @param {object} options - Generation options
 * @returns {Promise<object>} Result with file paths
 */
async function generateStickerSheets(designs, options = {}) {
  const {
    stickerSizeInches = DEFAULT_STICKER_SIZE_INCHES,
    offsetMm = DEFAULT_OFFSET_MM,
    outputDir = path.join(process.cwd(), 'sticker-sheets'),
    filenamePrefix = 'sticker-sheet',
    removeBackgrounds = true,  // Default to removing backgrounds
    scaleByLargestDimension = true,  // Scale by largest dimension so stickers don't overflow
    useRotationPacking = true  // Enable rotation-aware packing for better efficiency
  } = options;

  // Ensure output directory exists
  await fs.promises.mkdir(outputDir, { recursive: true });

  const targetSize = Math.floor(stickerSizeInches * SHEET_CONFIG.dpi);
  const tempFiles = [];

  // Calculate total items for task tracking
  let totalItems = 0;
  for (const design of designs) {
    totalItems += Math.max(1, parseInt(design.quantity) || 1);
  }

  // Create task for tracking
  const taskId = taskTracker.createTask(
    taskTracker.TaskType.STICKER_SHEETS,
    `Generating sticker sheets (${totalItems} stickers)`,
    { totalStickers: totalItems, removeBackgrounds }
  );
  taskTracker.startTask(taskId, totalItems);

  console.log('Step 1: Processing designs (removing backgrounds, extracting contours)...');

  // Expand designs by quantity and process each one
  const expandedDesigns = [];
  for (const design of designs) {
    const qty = Math.max(1, parseInt(design.quantity) || 1);
    // Decode URL-encoded paths (e.g., %20 -> space)
    let imagePath = design.imagePath;
    try {
      imagePath = decodeURIComponent(imagePath);
    } catch (e) {
      // Already decoded or invalid encoding, use as-is
    }
    for (let i = 0; i < qty; i++) {
      expandedDesigns.push({
        imagePath: imagePath,
        title: design.title || path.basename(imagePath, path.extname(imagePath))
      });
    }
  }

  // Process all designs (remove background, extract contour)
  const processedDesigns = [];
  for (let i = 0; i < expandedDesigns.length; i++) {
    const design = expandedDesigns[i];
    console.log(`  Processing ${i + 1}/${expandedDesigns.length}: ${design.title}`);

    // Update task progress
    taskTracker.updateProgress(taskId, i + 1, `Processing: ${design.title}`);

    try {
      if (removeBackgrounds) {
        const processed = await processDesign(design, targetSize, scaleByLargestDimension);
        processedDesigns.push(processed);
        if (processed.isTemp) {
          tempFiles.push(processed.processedPath);
        }
      } else {
        // Just get dimensions without processing - allows both scaling up AND down
        const metadata = await sharp(design.imagePath).metadata();
        let scale;
        if (scaleByLargestDimension) {
          const largestDim = Math.max(metadata.width, metadata.height);
          scale = targetSize / largestDim;
        } else {
          scale = targetSize / metadata.height;
        }
        const scaledWidth = Math.round(metadata.width * scale);
        const scaledHeight = Math.round(metadata.height * scale);

        console.log(`[Scale] ${design.title}: ${metadata.width}x${metadata.height} -> ${scaledWidth}x${scaledHeight} (scale: ${scale.toFixed(2)}x, target: ${targetSize}px)`);
        if (scale > 1) {
          console.log(`[Scale] Scaling UP by ${((scale - 1) * 100).toFixed(0)}%`);
        }

        processedDesigns.push({
          ...design,
          processedPath: design.imagePath,
          isTemp: false,
          contour: null,
          width: scaledWidth,
          height: scaledHeight,
          scale
        });
      }
    } catch (err) {
      console.error(`  Failed to process ${design.title}:`, err.message);
      taskTracker.logTask(taskId, `Failed: ${design.title} - ${err.message}`);
    }
  }

  console.log(`Step 2: Packing ${processedDesigns.length} stickers onto sheets...`);

  // Pack designs onto sheets using SVGNest algorithm (or fallback)
  const sheetConfig = {
    widthPx: SHEET_CONFIG.widthPx,
    heightPx: SHEET_CONFIG.heightPx,
    marginPx: SHEET_CONFIG.marginPx
  };

  // Use contour-aware packing with rotation for optimal nesting
  const sheets = packDesignsOnSheets(processedDesigns, sheetConfig, SHEET_CONFIG.gapPx, useRotationPacking);

  console.log(`  Packed into ${sheets.length} sheet(s)`);

  // Create grid info for compatibility
  const grid = {
    sheetWidthPx: SHEET_CONFIG.widthPx,
    sheetHeightPx: SHEET_CONFIG.heightPx,
    stickerSizeInches
  };

  const results = {
    sheets: [],
    totalStickers: processedDesigns.length,
    totalSheets: sheets.length,
    grid: {
      stickerSizeInches
    },
    outputDir
  };

  console.log('Step 3: Generating print and cut files...');

  // Generate timestamp for this batch
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  // Generate each sheet
  for (let i = 0; i < sheets.length; i++) {
    const sheetNum = String(i + 1).padStart(2, '0');
    // File naming:
    // - _PRINT.png: Print-only image (stickers with transparent/white background)
    // - _CRICUT.svg: SVG with embedded PNG + cut paths for Cricut Design Space
    // - _CUT.svg: Cut paths only (for other workflows)
    const baseName = `${filenamePrefix}_${timestamp}_Sheet${sheetNum}`;
    const printFilename = `${baseName}_PRINT.png`;
    const cricutFilename = `${baseName}_CRICUT.svg`;   // SVG with embedded PNG + cut paths
    const cutFilename = `${baseName}_CUT.svg`;         // Cut paths only SVG
    const printPath = path.join(outputDir, printFilename);
    const cricutPath = path.join(outputDir, cricutFilename);
    const cutPath = path.join(outputDir, cutFilename);

    console.log(`  Generating sheet ${i + 1}/${sheets.length}...`);

    // Generate print file (images already have backgrounds removed)
    await generatePrintSheetFromProcessed(sheets[i], grid, printPath);

    // Generate Cricut SVG (embedded PNG as print layer + vector cut paths)
    // This is the file to import into Cricut Design Space
    // DS will automatically separate print and cut layers
    await generateCricutSvg(sheets[i], grid, printPath, cricutPath, offsetMm, true);

    // Also generate cut-only SVG for other workflows
    await generateCutFile(sheets[i], grid, cutPath, offsetMm, true);

    // Calculate web URLs (relative to web root)
    const webBasePath = outputDir.includes('/web/')
      ? outputDir.split('/web/')[1]
      : outputDir.replace(/^.*[/\\]web[/\\]/, '');
    const printUrl = `/${webBasePath}/${printFilename}`.replace(/\\/g, '/');
    const cricutUrl = `/${webBasePath}/${cricutFilename}`.replace(/\\/g, '/');
    const cutUrl = `/${webBasePath}/${cutFilename}`.replace(/\\/g, '/');

    results.sheets.push({
      sheetNumber: i + 1,
      sheetName: `Sheet ${sheetNum}`,
      stickerCount: sheets[i].length,
      printFile: printPath,
      cricutFile: cricutPath,  // SVG with embedded PNG + cut paths for Cricut
      cutFile: cutPath,
      printFilename,
      cricutFilename,
      cutFilename,
      printUrl,
      cricutUrl,  // Use this for Cricut Print Then Cut
      cutUrl,
      placements: sheets[i].map(p => ({
        title: p.title,
        x: p.x,
        y: p.y,
        width: p.width,
        height: p.height,
        hasContour: !!(p.contour && p.contour.length >= 3)
      }))
    });
  }

  // Clean up temp files
  console.log('Cleaning up temporary files...');
  cleanupTempFiles(tempFiles);

  // Mark task as complete
  taskTracker.completeTask(taskId, {
    sheetsGenerated: results.totalSheets,
    stickersProcessed: results.totalStickers
  });

  console.log(`Done! Generated ${results.totalSheets} sheet(s) with ${results.totalStickers} sticker(s)`);

  return results;
}

/**
 * Generate print sheet from pre-processed designs
 * @param {Array} placements - Array of processed placements with processedPath
 * @param {object} grid - Grid configuration
 * @param {string} outputPath - Where to save the PNG
 * @returns {Promise<string>} Path to generated file
 */
async function generatePrintSheetFromProcessed(placements, grid, outputPath) {
  // Create base white sheet
  const baseSheet = sharp({
    create: {
      width: grid.sheetWidthPx,
      height: grid.sheetHeightPx,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 }
    }
  });

  // Prepare composite operations - start with registration marks
  const regmarkComposites = await createRegistrationMarkComposites();
  const composites = [...regmarkComposites];

  for (const placement of placements) {
    try {
      const imagePath = placement.processedPath || placement.imagePath;

      // Get the original dimensions for proper sizing
      const origWidth = placement.originalWidth || placement.width;
      const origHeight = placement.originalHeight || placement.height;

      let stickerBuffer;
      const rotationAngle = placement.rotationAngle || (placement.rotated ? 90 : 0);

      if (rotationAngle !== 0) {
        // For rotated stickers: resize to original dimensions first, then rotate
        // Sharp's rotate() handles the bounding box expansion automatically
        stickerBuffer = await sharp(imagePath)
          .resize(origWidth, origHeight, {
            fit: 'contain',
            background: { r: 255, g: 255, b: 255, alpha: 0 }
          })
          .rotate(rotationAngle, { background: { r: 255, g: 255, b: 255, alpha: 0 } })
          .png()
          .toBuffer();
      } else {
        // Normal orientation - just resize
        stickerBuffer = await sharp(imagePath)
          .resize(placement.width, placement.height, {
            fit: 'contain',
            background: { r: 255, g: 255, b: 255, alpha: 0 }
          })
          .png()
          .toBuffer();
      }

      composites.push({
        input: stickerBuffer,
        left: placement.x,
        top: placement.y
      });
    } catch (err) {
      console.error(`Failed to composite sticker ${placement.title}:`, err.message);
    }
  }

  // Composite all stickers and registration marks onto sheet
  await baseSheet
    .composite(composites)
    .png({ quality: 100 })
    .toFile(outputPath);

  console.log(`  ✓ Added Silhouette registration marks to print sheet`);
  return outputPath;
}

/**
 * Recursively scan a directory for image files
 * @param {string} dirPath - Directory to scan
 * @param {string} category - Category name for the stickers
 * @param {Array} results - Array to push results to
 */
async function scanDirectoryRecursive(dirPath, category, results) {
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        // Recursively scan subdirectories
        await scanDirectoryRecursive(fullPath, category, results);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        // Only include JPG/PNG images (skip AI, EPS, PDF)
        if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
          results.push({
            category: category,
            filename: entry.name,
            title: path.basename(entry.name, ext).replace(/[-_]/g, ' '),
            imagePath: fullPath
          });
        }
      }
    }
  } catch (err) {
    console.error(`Error scanning directory ${dirPath}:`, err.message);
  }
}

/**
 * Scan sticker catalog directory for available designs
 * @param {string} catalogRoot - Root directory of sticker catalog
 * @param {string} category - Optional category filter
 * @returns {Promise<Array>} Array of available stickers
 */
async function scanStickerCatalog(catalogRoot, category = null) {
  const stickers = [];

  try {
    const entries = await fs.promises.readdir(catalogRoot, { withFileTypes: true });
    const categories = entries.filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'data');

    for (const cat of categories) {
      if (category && cat.name.toLowerCase() !== category.toLowerCase()) continue;

      const catPath = path.join(catalogRoot, cat.name);
      // Recursively scan the category folder and all subfolders
      await scanDirectoryRecursive(catPath, cat.name, stickers);
    }
  } catch (err) {
    console.error('Error scanning sticker catalog:', err.message);
  }

  return stickers;
}

/**
 * List available sticker categories
 * @param {string} catalogRoot - Root directory of sticker catalog
 * @returns {Promise<Array>} Array of category names
 */
async function listStickerCategories(catalogRoot) {
  try {
    const entries = await fs.promises.readdir(catalogRoot, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'data')
      .map(e => e.name)
      .sort();
  } catch (err) {
    console.error('Error listing sticker categories:', err.message);
    return [];
  }
}

/**
 * Generate a single sticker sheet from a manual layout (user-arranged placements)
 * This function takes pre-positioned stickers and renders them at their specified locations
 * @param {Array} placements - Array of {imagePath, x, y, width, height, angle, title}
 * @param {object} options - Options including outputDir, sheetNum, stickerSizeInches, offsetMm
 * @returns {Promise<object>} Result with printPath, cutPath, cricutPath
 */
async function generateSheetFromLayout(placements, options = {}) {
  const {
    outputDir,
    sheetNum = '01',
    stickerSizeInches = 3,
    offsetMm = 0.25
  } = options;

  if (!placements || placements.length === 0) {
    throw new Error('No sticker placements provided');
  }

  console.log(`[Layout Sheet] Generating sheet ${sheetNum} with ${placements.length} stickers`);

  // Generate timestamp for filenames
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const baseName = `layout_${timestamp}_Sheet${sheetNum}`;
  const printPath = path.join(outputDir, `${baseName}_PRINT.png`);
  const cutPath = path.join(outputDir, `${baseName}_CUT.svg`);
  const cricutPath = path.join(outputDir, `${baseName}_CRICUT.svg`);

  // Create base white sheet
  const baseSheet = sharp({
    create: {
      width: SHEET_CONFIG.widthPx,
      height: SHEET_CONFIG.heightPx,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 }
    }
  });

  // Prepare composite operations and contour data
  const composites = [];
  const cutData = [];
  const tempFiles = [];

  for (const placement of placements) {
    try {
      let imagePath = placement.imagePath;
      let noBgPath;

      // Check if this sticker already has background removed (client-side processed dataUrl)
      if (placement.backgroundRemoved && placement.processedDataUrl) {
        // Save the dataUrl to a temporary file
        const dataUrlMatch = placement.processedDataUrl.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/);
        if (dataUrlMatch) {
          const ext = dataUrlMatch[1] === 'jpeg' ? 'jpg' : dataUrlMatch[1];
          const base64Data = dataUrlMatch[2];
          const tempPath = path.join(outputDir, `temp_bg_removed_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.${ext}`);
          await fs.promises.writeFile(tempPath, Buffer.from(base64Data, 'base64'));
          noBgPath = tempPath;
          tempFiles.push(tempPath);
          console.log('[Layout Sheet] Using client-processed background-removed image');
        } else {
          console.warn('[Layout Sheet] Invalid processedDataUrl format, falling back to server processing');
          // Fall through to normal processing
        }
      }

      // If not already processed, do normal path resolution and background removal
      if (!noBgPath) {
        console.log('[Layout Sheet] Resolving image path:', imagePath);

        // Handle URL-based paths
        if (imagePath && imagePath.startsWith('http')) {
          try {
            const imageUrl = new URL(imagePath);
            const urlPath = imageUrl.pathname;
            imagePath = path.join(WEB_DIR, urlPath);
          } catch (e) {
            console.warn('[Layout Sheet] Could not parse image URL:', placement.imagePath);
          }
        }

        // Decode URL-encoded paths
        try {
          imagePath = decodeURIComponent(imagePath);
        } catch (e) {
          // Already decoded or invalid
        }

        // Resolve various path formats to actual file path
        // WEB_DIR is defined at module level using __dirname

        // Check if path is an absolute server path (from API response)
        if (imagePath.includes('/vinylApp/web/')) {
          // Extract the path relative to web folder
          const webRelative = imagePath.split('/vinylApp/web/')[1];
          imagePath = path.join(WEB_DIR, webRelative);
        } else if (imagePath.includes('/home/ubuntu/') && imagePath.includes('/web/')) {
          // Another format of server path
          const webRelative = imagePath.split('/web/')[1];
          imagePath = path.join(WEB_DIR, webRelative);
        } else if (imagePath.startsWith('/library/') || imagePath.startsWith('library/')) {
          // Relative path from web root
          const cleanPath = imagePath.startsWith('/') ? imagePath.slice(1) : imagePath;
          imagePath = path.join(WEB_DIR, cleanPath);
        } else if (!path.isAbsolute(imagePath)) {
          // Relative path - assume it's relative to web folder
          imagePath = path.join(WEB_DIR, imagePath);
        }

        console.log('[Layout Sheet] Resolved to:', imagePath);

        // Verify file exists
        if (!fs.existsSync(imagePath)) {
          console.error('[Layout Sheet] File not found:', imagePath);
          throw new Error(`Image file not found: ${placement.imagePath}`);
        }

        // Remove background
        noBgPath = await removeBackground(imagePath);
        if (noBgPath !== imagePath) {
          tempFiles.push(noBgPath);
        }
      }

      // Get image metadata
      const metadata = await sharp(noBgPath).metadata();

      // Calculate rotation
      const angle = placement.angle || 0;
      const radians = (angle * Math.PI) / 180;

      // Prepare image with rotation if needed
      let stickerBuffer;
      if (angle !== 0) {
        // For rotated images, the placement.width/height is the BOUNDING BOX size
        // We need to rotate first, then resize to fit the bounding box
        // Sharp's rotate expands the canvas to fit the rotated image
        stickerBuffer = await sharp(noBgPath)
          .rotate(angle, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .resize(Math.round(placement.width), Math.round(placement.height), {
            fit: 'inside',  // Use 'inside' to fit within bounding box without distortion
            background: { r: 255, g: 255, b: 255, alpha: 0 }
          })
          .png()
          .toBuffer();
      } else {
        stickerBuffer = await sharp(noBgPath)
          .resize(Math.round(placement.width), Math.round(placement.height), {
            fit: 'contain',
            background: { r: 255, g: 255, b: 255, alpha: 0 }
          })
          .png()
          .toBuffer();
      }

      composites.push({
        input: stickerBuffer,
        left: Math.round(placement.x),
        top: Math.round(placement.y)
      });

      // Use custom contour if provided (user-edited), otherwise extract from image
      let finalContour = null;

      if (placement.customContour && placement.customContour.length >= 3) {
        // Use the custom contour provided by the user (already in absolute coordinates)
        finalContour = placement.customContour;
        console.log(`  Using custom contour with ${finalContour.length} points`);
      } else {
        // Extract contour from the image
        const contour = await extractContour(noBgPath);
        if (contour && contour.length > 3) {
          // Scale contour to placement size
          const scaleX = placement.width / metadata.width;
          const scaleY = placement.height / metadata.height;

          let scaledContour = contour.map(p => ({
            x: p.x * scaleX + placement.x,
            y: p.y * scaleY + placement.y
          }));

          // Rotate contour if needed
          if (angle !== 0) {
            const centerX = placement.x + placement.width / 2;
            const centerY = placement.y + placement.height / 2;
            scaledContour = scaledContour.map(p => {
              const dx = p.x - centerX;
              const dy = p.y - centerY;
              return {
                x: centerX + dx * Math.cos(radians) - dy * Math.sin(radians),
                y: centerY + dx * Math.sin(radians) + dy * Math.cos(radians)
              };
            });
          }

          finalContour = scaledContour;
        }
      }

      if (finalContour && finalContour.length > 3) {
        cutData.push({
          title: placement.title || 'sticker',
          contour: finalContour,
          x: placement.x,
          y: placement.y,
          width: placement.width,
          height: placement.height,
          angle
        });
      } else {
        // Fallback to rectangular cut
        cutData.push({
          title: placement.title || 'sticker',
          contour: null,
          x: placement.x,
          y: placement.y,
          width: placement.width,
          height: placement.height,
          angle
        });
      }

      console.log(`  ✓ Added: ${placement.title || 'sticker'} at (${placement.x}, ${placement.y})`);
    } catch (err) {
      console.error(`  ✗ Failed to add sticker: ${err.message}`);
    }
  }

  // Add registration marks
  const regMarkComposites = await createRegistrationMarkComposites();
  composites.push(...regMarkComposites);

  // Composite all stickers and registration marks onto sheet
  await baseSheet
    .composite(composites)
    .png({ quality: 100 })
    .toFile(printPath);

  console.log(`[Layout Sheet] Print sheet saved: ${printPath}`);

  // Generate cut file SVG
  const sheetWidthMm = SHEET_CONFIG.widthInches * 25.4;
  const sheetHeightMm = SHEET_CONFIG.heightInches * 25.4;
  const pxToMm = 25.4 / SHEET_CONFIG.dpi;
  const offsetPx = (offsetMm / 25.4) * SHEET_CONFIG.dpi;

  let cutSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
     width="${sheetWidthMm}mm" height="${sheetHeightMm}mm"
     viewBox="0 0 ${sheetWidthMm} ${sheetHeightMm}">
  <title>Layout Sheet ${sheetNum} - Cut Paths</title>
  <desc>Cut paths for Silhouette Cameo - registration marks are on the printed sheet only</desc>
`;

  // NOTE: Registration marks are NOT included in the cut SVG - they're only on the printed PNG sheet
  // The Cameo's optical sensor reads them from the printed sheet to align the cuts

  // Add cut paths group
  cutSvg += `  <g inkscape:groupmode="layer" inkscape:label="Cut" id="cut-paths" fill="none" stroke="#FF0000" stroke-width="0.5">\n`;

  for (const item of cutData) {
    if (item.contour && item.contour.length > 3) {
      // Use contour with offset - convert pixels to mm
      const offsetContour = offsetPolygon(item.contour, offsetPx);
      // Convert contour points from pixels to mm
      const contourMm = offsetContour.map(p => ({
        x: p.x * pxToMm,
        y: p.y * pxToMm
      }));
      const pathData = pointsToBezierPath(contourMm);
      cutSvg += `    <path d="${pathData}" data-title="${item.title}"/>\n`;
    } else {
      // Rectangular fallback with offset
      const x = (item.x - offsetPx) * pxToMm;
      const y = (item.y - offsetPx) * pxToMm;
      const w = (item.width + 2 * offsetPx) * pxToMm;
      const h = (item.height + 2 * offsetPx) * pxToMm;

      if (item.angle && item.angle !== 0) {
        const cx = (item.x + item.width / 2) * pxToMm;
        const cy = (item.y + item.height / 2) * pxToMm;
        cutSvg += `    <rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" rx="1" ry="1" transform="rotate(${item.angle} ${cx.toFixed(2)} ${cy.toFixed(2)})" data-title="${item.title}"/>\n`;
      } else {
        cutSvg += `    <rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" rx="1" ry="1" data-title="${item.title}"/>\n`;
      }
    }
  }

  cutSvg += `  </g>\n</svg>`;

  await fs.promises.writeFile(cutPath, cutSvg, 'utf-8');
  console.log(`[Layout Sheet] Cut file saved: ${cutPath}`);

  // Generate Cricut SVG (embedded PNG + cut paths)
  const printFilename = path.basename(printPath);
  const printBase64 = (await fs.promises.readFile(printPath)).toString('base64');

  let cricutSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     width="${sheetWidthMm}mm" height="${sheetHeightMm}mm"
     viewBox="0 0 ${sheetWidthMm} ${sheetHeightMm}">
  <title>Layout Sheet ${sheetNum} - Cricut Print Then Cut</title>

  <!-- Print Layer (embedded PNG) -->
  <image id="print-layer" x="0" y="0" width="${sheetWidthMm}" height="${sheetHeightMm}"
         xlink:href="data:image/png;base64,${printBase64}"/>

  <!-- Cut Layer -->
  <g id="cut-layer" fill="none" stroke="red" stroke-width="0.5">
`;

  for (const item of cutData) {
    if (item.contour && item.contour.length > 3) {
      // Use contour with offset - convert pixels to mm
      const offsetContour = offsetPolygon(item.contour, offsetPx);
      // Convert contour points from pixels to mm
      const contourMm = offsetContour.map(p => ({
        x: p.x * pxToMm,
        y: p.y * pxToMm
      }));
      const pathData = pointsToBezierPath(contourMm);
      cricutSvg += `    <path d="${pathData}"/>\n`;
    } else {
      const x = (item.x - offsetPx) * pxToMm;
      const y = (item.y - offsetPx) * pxToMm;
      const w = (item.width + 2 * offsetPx) * pxToMm;
      const h = (item.height + 2 * offsetPx) * pxToMm;

      if (item.angle && item.angle !== 0) {
        const cx = (item.x + item.width / 2) * pxToMm;
        const cy = (item.y + item.height / 2) * pxToMm;
        cricutSvg += `    <rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" rx="1" ry="1" transform="rotate(${item.angle} ${cx.toFixed(2)} ${cy.toFixed(2)})"/>\n`;
      } else {
        cricutSvg += `    <rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" rx="1" ry="1"/>\n`;
      }
    }
  }

  cricutSvg += `  </g>\n</svg>`;

  await fs.promises.writeFile(cricutPath, cricutSvg, 'utf-8');
  console.log(`[Layout Sheet] Cricut file saved: ${cricutPath}`);

  // Cleanup temp files
  cleanupTempFiles(tempFiles);

  return {
    printPath,
    cutPath,
    cricutPath,
    stickerCount: placements.length
  };
}

// ============================================================================
// NESTING ENGINE INTEGRATION (Phase 2)
// Contour-aware polygon nesting with order grouping
// ============================================================================

/**
 * Generate sticker sheets using the nesting engine
 * MANUAL mode - pure efficiency, pack everything tight
 *
 * @param {Array} designs - Array of design objects with imagePath, quantity
 * @param {object} options - Generation options
 * @returns {Promise<object>} Result with sheets, files, and manifest
 */
async function generateNestedSheets(designs, options = {}) {
  const {
    stickerSizeInches = DEFAULT_STICKER_SIZE_INCHES,
    offsetMm = DEFAULT_OFFSET_MM,
    spacingMm = 3,
    filenamePrefix = 'nested',
    outputDir = path.join(__dirname, '..', 'test-output'),
    scaleByLargestDimension = true,
    useBezierContours = true
  } = options;

  console.log(`[NestedSheets] MANUAL mode: Processing ${designs.length} designs`);

  // Create output directory
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Process designs to extract contours
  const targetSizePx = Math.floor(stickerSizeInches * SHEET_CONFIG.dpi);
  const processedDesigns = [];

  for (const design of designs) {
    const qty = Math.max(1, parseInt(design.quantity) || 1);

    // Use bezier processing if available and enabled
    let processed;
    if (useBezierContours) {
      try {
        processed = await processDesignBezier(design, targetSizePx, scaleByLargestDimension);
      } catch (e) {
        console.warn(`[NestedSheets] Bezier processing failed for ${design.title}, using polygon`);
        processed = await processDesign(design, targetSizePx, scaleByLargestDimension);
      }
    } else {
      processed = await processDesign(design, targetSizePx, scaleByLargestDimension);
    }

    // Add quantity copies
    for (let i = 0; i < qty; i++) {
      processedDesigns.push({
        ...processed,
        id: `${processed.title || 'sticker'}_${i}`,
        title: processed.title || path.basename(design.imagePath, path.extname(design.imagePath))
      });
    }
  }

  console.log(`[NestedSheets] Processed ${processedDesigns.length} stickers`);

  // Create nesting engine
  const engine = createNestingEngine({
    spacingMm,
    dpi: SHEET_CONFIG.dpi
  });

  // Pack stickers
  const { sheets, manifest } = engine.packManual(processedDesigns);

  // Generate output files
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const results = {
    sheets: [],
    manifest: null,
    efficiency: engine.calculateEfficiency()
  };

  for (let i = 0; i < sheets.length; i++) {
    const sheetNum = String(i + 1).padStart(3, '0');
    const printPath = path.join(outputDir, `${filenamePrefix}_${timestamp}_sheet_${sheetNum}_print.png`);
    const cutPath = path.join(outputDir, `${filenamePrefix}_${timestamp}_sheet_${sheetNum}_cut.svg`);

    // Create grid config for compatibility
    const grid = {
      sheetWidthPx: engine.mmToPx(engine.config.sheetWidthMm),
      sheetHeightPx: engine.mmToPx(engine.config.sheetHeightMm)
    };

    // Generate print sheet
    await generatePrintSheetFromProcessed(sheets[i].placements, grid, printPath);

    // Generate cut file
    await generateCutFile(sheets[i].placements, grid, cutPath, offsetMm, true);

    results.sheets.push({
      sheetIndex: i,
      printFile: printPath,
      cutFile: cutPath,
      stickerCount: sheets[i].placements.length
    });
  }

  // Save manifest
  const manifestPath = path.join(outputDir, `${filenamePrefix}_${timestamp}_manifest.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  results.manifest = manifestPath;

  console.log(`[NestedSheets] Generated ${results.sheets.length} sheets`);
  console.log(`[NestedSheets] Efficiency: ${results.efficiency.efficiency}`);

  return results;
}

/**
 * Generate sticker sheets using the nesting engine
 * ORDER mode - keep orders together, don't mix across sheets
 *
 * @param {Array} orders - Array of order objects with orderId, stickers[]
 * @param {object} options - Generation options
 * @returns {Promise<object>} Result with sheets, files, and manifest
 */
async function generateNestedSheetsByOrder(orders, options = {}) {
  const {
    stickerSizeInches = DEFAULT_STICKER_SIZE_INCHES,
    offsetMm = DEFAULT_OFFSET_MM,
    spacingMm = 3,
    filenamePrefix = 'order',
    outputDir = path.join(__dirname, '..', 'test-output'),
    scaleByLargestDimension = true,
    useBezierContours = true
  } = options;

  console.log(`[NestedSheets] ORDER mode: Processing ${orders.length} orders`);

  // Create output directory
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const targetSizePx = Math.floor(stickerSizeInches * SHEET_CONFIG.dpi);

  // Process orders
  const processedOrders = [];

  for (const order of orders) {
    const processedStickers = [];

    for (const sticker of (order.stickers || [])) {
      const qty = Math.max(1, parseInt(sticker.quantity) || 1);

      let processed;
      if (useBezierContours) {
        try {
          processed = await processDesignBezier(sticker, targetSizePx, scaleByLargestDimension);
        } catch (e) {
          processed = await processDesign(sticker, targetSizePx, scaleByLargestDimension);
        }
      } else {
        processed = await processDesign(sticker, targetSizePx, scaleByLargestDimension);
      }

      for (let i = 0; i < qty; i++) {
        processedStickers.push({
          ...processed,
          id: `${order.orderId}_${processed.title || 'sticker'}_${i}`,
          title: processed.title || path.basename(sticker.imagePath, path.extname(sticker.imagePath))
        });
      }
    }

    processedOrders.push({
      orderId: order.orderId,
      orderNumber: order.orderNumber,
      customerName: order.customerName,
      stickers: processedStickers
    });
  }

  // Create nesting engine
  const engine = createNestingEngine({
    spacingMm,
    dpi: SHEET_CONFIG.dpi
  });

  // Pack by order
  const { sheets, manifest } = engine.packByOrder(processedOrders);

  // Generate output files
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const results = {
    sheets: [],
    manifest: null,
    efficiency: engine.calculateEfficiency()
  };

  for (let i = 0; i < sheets.length; i++) {
    const sheetNum = String(i + 1).padStart(3, '0');
    const orderId = sheets[i].orderId || 'mixed';
    const printPath = path.join(outputDir, `${filenamePrefix}_${orderId}_sheet_${sheetNum}_print.png`);
    const cutPath = path.join(outputDir, `${filenamePrefix}_${orderId}_sheet_${sheetNum}_cut.svg`);

    const grid = {
      sheetWidthPx: engine.mmToPx(engine.config.sheetWidthMm),
      sheetHeightPx: engine.mmToPx(engine.config.sheetHeightMm)
    };

    await generatePrintSheetFromProcessed(sheets[i].placements, grid, printPath);
    await generateCutFile(sheets[i].placements, grid, cutPath, offsetMm, true);

    results.sheets.push({
      sheetIndex: i,
      orderId: sheets[i].orderId,
      printFile: printPath,
      cutFile: cutPath,
      stickerCount: sheets[i].placements.length
    });
  }

  // Save manifest
  const manifestPath = path.join(outputDir, `${filenamePrefix}_${timestamp}_manifest.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  results.manifest = manifestPath;

  console.log(`[NestedSheets] Generated ${results.sheets.length} sheets for ${orders.length} orders`);

  return results;
}

// ============================================================================
// END NESTING ENGINE INTEGRATION
// ============================================================================

module.exports = {
  SHEET_CONFIG,
  REGMARK_CONFIG,  // Registration mark settings for Silhouette
  DEFAULT_STICKER_SIZE_INCHES,
  DEFAULT_OFFSET_MM,
  calculateGridLayout,
  getStickerPosition,
  groupIntoSheets,
  generatePrintSheet,
  generatePrintSheetFromProcessed,
  generateCutFile,
  generateCricutSvg,  // SVG with embedded PNG + cut paths for Cricut Print Then Cut
  generateStickerSheets,
  generateSheetFromLayout,  // Generate sheet from manual visual layout
  scanStickerCatalog,
  listStickerCategories,
  // Registration mark utilities for Silhouette
  getRegmarkInfo,
  createRegistrationMarkComposites,
  generateRegmarkSvgElements,
  // Background removal and contour utilities
  removeBackground,
  extractContour,
  processDesign,
  packDesignsOnSheets,
  packDesignsWithRotation,  // Rotation-aware packing algorithm
  // Low-level utilities for advanced use
  parseSvgPath,
  offsetPolygon,
  pointsToSvgPath,
  pointsToBezierPath,  // Smooth bezier SVG path using paper.js
  generateRectCutPath,
  generateContourCutPath,
  rotateContour90,  // Rotate contour points 90° for rotated placements
  simplifyPath,
  getContourBounds,
  polygonArea,
  // NEW: Color detection for vinyl cutting
  detectColors,            // Detect dominant colors in image for color separation
  extractColorContours,    // Extract per-color contours for vinyl cutting (the proper way!)
  // NEW: Bezier-preserving pipeline (Phase 1 fix)
  extractContourBezier,    // Potrace-based bezier contour extraction
  offsetSvgPathBezier,     // Bezier-preserving offset (no flattening)
  scaleSvgPath,            // Scale SVG path preserving beziers
  translateSvgPath,        // Translate SVG path preserving beziers
  rotateSvgPath,           // Rotate SVG path preserving beziers
  processDesignBezier,     // Full bezier-preserving design processing
  // NEW: Nesting Engine (Phase 2)
  NestingEngine,           // Direct access to nesting engine class
  createNestingEngine,     // Factory function for nesting engine
  generateNestedSheets,    // MANUAL mode - pack for efficiency
  generateNestedSheetsByOrder,  // ORDER mode - keep orders grouped
  // NEW: Learned contour style parameters
  getLearnedPotraceParams,  // Get potrace params from trained style
  reloadStyleProfile        // Force reload of style profile after training
};
