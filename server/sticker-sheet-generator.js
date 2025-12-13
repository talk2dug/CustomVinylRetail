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

// Temp folder for background-removed images
const TEMP_FOLDER = path.join(__dirname, '..', 'temp_stickers');

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
const DEFAULT_OFFSET_MM = 3;

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
 * Extract contour from a transparent PNG image using alpha channel
 * Uses marching squares algorithm to trace the outline
 * @param {string} imagePath - Path to PNG with transparency
 * @param {number} simplifyTolerance - Tolerance for point reduction (higher = fewer points)
 * @returns {Promise<Array>} Array of {x, y} points forming the contour
 */
async function extractContour(imagePath, simplifyTolerance = 2) {
  const image = sharp(imagePath);
  const metadata = await image.metadata();
  const { width, height } = metadata;

  // Get raw pixel data with alpha channel
  const rawBuffer = await image
    .ensureAlpha()
    .raw()
    .toBuffer();

  // Create binary mask from alpha channel (1 = opaque, 0 = transparent)
  const mask = [];
  for (let y = 0; y < height; y++) {
    mask[y] = [];
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      mask[y][x] = rawBuffer[i + 3] > 128 ? 1 : 0; // Alpha threshold
    }
  }

  // Find edge pixels using simple edge detection
  const edgePoints = [];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      if (mask[y][x] === 1) {
        // Check if this pixel is on the edge (has a transparent neighbor)
        if (mask[y-1][x] === 0 || mask[y+1][x] === 0 ||
            mask[y][x-1] === 0 || mask[y][x+1] === 0) {
          edgePoints.push({ x, y });
        }
      }
    }
  }

  if (edgePoints.length === 0) {
    // No contour found, return rectangle
    return [
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: height },
      { x: 0, y: height }
    ];
  }

  // Sort edge points to form a continuous path (convex hull approach for simplicity)
  const hull = convexHull(edgePoints);

  // Simplify the path using Douglas-Peucker algorithm
  const simplified = simplifyPath(hull, simplifyTolerance);

  return simplified;
}

/**
 * Compute convex hull using Graham scan algorithm
 * @param {Array} points - Array of {x, y} points
 * @returns {Array} Convex hull points in counter-clockwise order
 */
function convexHull(points) {
  if (points.length < 3) return points;

  // Find the bottom-most point (or left-most in case of tie)
  let start = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].y > points[start].y ||
        (points[i].y === points[start].y && points[i].x < points[start].x)) {
      start = i;
    }
  }

  // Swap start point to beginning
  [points[0], points[start]] = [points[start], points[0]];
  const pivot = points[0];

  // Sort by polar angle with respect to pivot
  const sorted = points.slice(1).sort((a, b) => {
    const angleA = Math.atan2(a.y - pivot.y, a.x - pivot.x);
    const angleB = Math.atan2(b.y - pivot.y, b.x - pivot.x);
    return angleA - angleB;
  });

  // Build hull using stack
  const hull = [pivot];
  for (const point of sorted) {
    while (hull.length > 1) {
      const top = hull[hull.length - 1];
      const second = hull[hull.length - 2];
      const cross = (top.x - second.x) * (point.y - second.y) -
                    (top.y - second.y) * (point.x - second.x);
      if (cross <= 0) {
        hull.pop();
      } else {
        break;
      }
    }
    hull.push(point);
  }

  return hull;
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
 * @param {number} targetHeight - Target height in pixels for the sticker
 * @returns {Promise<object>} Processed design with contour, dimensions, temp file
 */
async function processDesign(design, targetHeight) {
  // Remove background
  const noBgPath = await removeBackground(design.imagePath);
  const isTemp = noBgPath !== design.imagePath;

  // Get image dimensions
  const metadata = await sharp(noBgPath).metadata();
  const scale = targetHeight / metadata.height;
  const scaledWidth = Math.round(metadata.width * scale);
  const scaledHeight = targetHeight;

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
 * Offset a polygon path using a simple approach
 * For production, we'll use clipper-lib, but this is a fallback
 * @param {Array} points - Array of {x, y} points
 * @param {number} offset - Offset amount in pixels
 * @returns {Array} Offset points
 */
function offsetPolygon(points, offset) {
  if (points.length < 3) return points;

  const result = [];
  const n = points.length;

  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n];
    const curr = points[i];
    const next = points[(i + 1) % n];

    // Calculate edge vectors
    const dx1 = curr.x - prev.x;
    const dy1 = curr.y - prev.y;
    const dx2 = next.x - curr.x;
    const dy2 = next.y - curr.y;

    // Normalize and get normals
    const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1) || 1;
    const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2) || 1;

    const nx1 = -dy1 / len1;
    const ny1 = dx1 / len1;
    const nx2 = -dy2 / len2;
    const ny2 = dx2 / len2;

    // Average the normals for smooth corners
    let nx = (nx1 + nx2) / 2;
    let ny = (ny1 + ny2) / 2;
    const nlen = Math.sqrt(nx * nx + ny * ny) || 1;
    nx /= nlen;
    ny /= nlen;

    // Scale factor for miter join
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
 * Generate a contour-based cut path for a sticker
 * @param {object} placement - Sticker placement with x, y, contour
 * @param {number} offsetMm - Offset in millimeters for die-cut margin
 * @param {number} dpi - Dots per inch for conversion
 * @returns {string} SVG path element
 */
function generateContourCutPath(placement, offsetMm = DEFAULT_OFFSET_MM, dpi = SHEET_CONFIG.dpi) {
  const offsetPx = (offsetMm / 25.4) * dpi;

  // If no contour, fall back to rectangle
  if (!placement.contour || placement.contour.length < 3) {
    return generateRectCutPath(placement, offsetMm, dpi);
  }

  // Offset the contour outward for die-cut margin
  const offsetContour = offsetPolygon(placement.contour, offsetPx);

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
  // SVG header with dimensions in inches for Cricut
  const widthIn = (grid.sheetWidthPx / SHEET_CONFIG.dpi).toFixed(4);
  const heightIn = (grid.sheetHeightPx / SHEET_CONFIG.dpi).toFixed(4);

  let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     width="${widthIn}in"
     height="${heightIn}in"
     viewBox="0 0 ${grid.sheetWidthPx} ${grid.sheetHeightPx}">
  <title>Sticker Cut Lines</title>
  <desc>Generated cut paths for Cricut Print Then Cut</desc>
  <g id="cut-paths" fill="none" stroke="#FF0000" stroke-width="1">
`;

  // Generate cut path for each sticker
  for (const placement of placements) {
    // Use contour path if available and enabled, otherwise fall back to rectangle
    if (useContours && placement.contour && placement.contour.length >= 3) {
      svg += `    ${generateContourCutPath(placement, offsetMm)}\n`;
    } else {
      svg += `    ${generateRectCutPath(placement, offsetMm)}\n`;
    }
  }

  svg += `  </g>
</svg>`;

  await fs.promises.writeFile(outputPath, svg, 'utf8');
  return outputPath;
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
 * @returns {Array} Array of sheets with placements
 */
function packDesignsOnSheets(processedDesigns, sheetConfig, gapPx) {
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
        y: shelfY
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
          y: shelfY
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
          y: shelfY
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
    removeBackgrounds = true  // Default to removing backgrounds
  } = options;

  // Ensure output directory exists
  await fs.promises.mkdir(outputDir, { recursive: true });

  const targetHeight = Math.floor(stickerSizeInches * SHEET_CONFIG.dpi);
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
    for (let i = 0; i < qty; i++) {
      expandedDesigns.push({
        imagePath: design.imagePath,
        title: design.title || path.basename(design.imagePath, path.extname(design.imagePath))
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
        const processed = await processDesign(design, targetHeight);
        processedDesigns.push(processed);
        if (processed.isTemp) {
          tempFiles.push(processed.processedPath);
        }
      } else {
        // Just get dimensions without processing
        const metadata = await sharp(design.imagePath).metadata();
        const scale = targetHeight / metadata.height;
        processedDesigns.push({
          ...design,
          processedPath: design.imagePath,
          isTemp: false,
          contour: null,
          width: Math.round(metadata.width * scale),
          height: targetHeight,
          scale
        });
      }
    } catch (err) {
      console.error(`  Failed to process ${design.title}:`, err.message);
      taskTracker.logTask(taskId, `Failed: ${design.title} - ${err.message}`);
    }
  }

  console.log(`Step 2: Packing ${processedDesigns.length} stickers onto sheets...`);

  // Pack designs onto sheets based on actual bounding boxes
  const sheetConfig = {
    widthPx: SHEET_CONFIG.widthPx,
    heightPx: SHEET_CONFIG.heightPx,
    marginPx: SHEET_CONFIG.marginPx
  };
  const sheets = packDesignsOnSheets(processedDesigns, sheetConfig, SHEET_CONFIG.gapPx);

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

  // Prepare composite operations
  const composites = [];

  for (const placement of placements) {
    try {
      const imagePath = placement.processedPath || placement.imagePath;

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
      console.error(`Failed to composite sticker ${placement.title}:`, err.message);
    }
  }

  // Composite all stickers onto sheet
  await baseSheet
    .composite(composites)
    .png({ quality: 100 })
    .toFile(outputPath);

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

module.exports = {
  SHEET_CONFIG,
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
  scanStickerCatalog,
  listStickerCategories,
  // Background removal and contour utilities
  removeBackground,
  extractContour,
  processDesign,
  packDesignsOnSheets,
  // Low-level utilities for advanced use
  parseSvgPath,
  offsetPolygon,
  pointsToSvgPath,
  generateRectCutPath,
  generateContourCutPath,
  convexHull,
  simplifyPath,
  getContourBounds
};
