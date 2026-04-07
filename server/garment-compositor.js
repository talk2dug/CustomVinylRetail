/**
 * Garment Compositor — pixel-based graphic placement on apparel photos
 *
 * Uses sharp (libvips) to composite design graphics onto model photos
 * with realistic fabric blending. Key technique: multiply blend mode
 * makes the graphic follow the garment's shadows, wrinkles, and contours
 * so it looks screen-printed rather than photoshopped.
 *
 * Steps:
 *   1. Extract the garment luminance from the chest zone (wrinkle map)
 *   2. Resize + position the graphic onto the target zone
 *   3. Multiply-blend: graphic × fabric luminance → natural shadows
 *   4. Composite the blended graphic back onto the original photo
 */

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const PATHS = require('./paths');

const OUTPUT_DIR = PATHS.APPAREL_MOCKUPS_DIR;
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Zone definitions: where on the model image to place the graphic
// Values are percentages of image width/height
// Zone presets for different photo types
const ZONES_PRODUCT = {
  // Product catalog shots (head-to-hip, white background, centered model)
  // Chest zone starts below the collar (~35% down) with moderate width
  'front-chest': { x: 0.27, y: 0.35, w: 0.46, h: 0.32 },
  'front-center': { x: 0.25, y: 0.32, w: 0.50, h: 0.36 },
  'back': { x: 0.25, y: 0.28, w: 0.50, h: 0.38 },
  'left-sleeve': { x: 0.08, y: 0.28, w: 0.16, h: 0.18 },
  'right-sleeve': { x: 0.76, y: 0.28, w: 0.16, h: 0.18 }
};

const ZONES_LIFESTYLE = {
  // Lifestyle photos — varied crops, generally head-to-waist or full body
  // Chest area typically 25-40% down from top
  'front-chest': { x: 0.25, y: 0.25, w: 0.50, h: 0.30 },
  'front-center': { x: 0.22, y: 0.22, w: 0.56, h: 0.35 },
  'back': { x: 0.22, y: 0.20, w: 0.56, h: 0.35 },
  'left-sleeve': { x: 0.05, y: 0.22, w: 0.18, h: 0.18 },
  'right-sleeve': { x: 0.77, y: 0.22, w: 0.18, h: 0.18 }
};

// Default to product zones
const ZONES = ZONES_PRODUCT;

// Size multipliers relative to the zone
const SIZES = {
  'small': 0.4,
  'medium': 0.65,
  'large': 0.85,
  'full': 0.95,
  'auto': 0.7
};

/**
 * Composite a graphic design onto a model photo with realistic fabric blending.
 *
 * @param {string} modelImagePath - Path to the model/garment photo
 * @param {string} graphicPath - Path to the design graphic (PNG with transparency)
 * @param {object} options
 * @param {string} options.zone - Placement zone (front-chest, back, etc.)
 * @param {string} options.size - Size within zone (small, medium, large, full, auto)
 * @param {number} options.adjustX - X offset in percent (-50 to 50)
 * @param {number} options.adjustY - Y offset in percent (-50 to 50)
 * @param {number} options.adjustScale - Scale adjustment in percent (50-200)
 * @param {string} options.garmentType - t-shirt, hoodie, etc.
 * @param {number} options.blendOpacity - Wrinkle blend strength 0-1 (default 0.7)
 * @returns {{ imagePath, webPath, filename }}
 */
async function compositeOnGarment(modelImagePath, graphicPath, options = {}) {
  const {
    zone = 'front-chest',
    size = 'large',
    adjustX = 0,
    adjustY = 0,
    adjustScale = 100,
    blendOpacity = 0.7
  } = options;

  const photoType = options.photoType || 'product'; // 'product' or 'lifestyle'

  // Load model image metadata
  const modelMeta = await sharp(modelImagePath).metadata();
  const imgW = modelMeta.width;
  const imgH = modelMeta.height;

  // Calculate placement zone in pixels
  const zoneSet = photoType === 'lifestyle' ? ZONES_LIFESTYLE : ZONES_PRODUCT;
  const zoneDef = zoneSet[zone] || zoneSet['front-chest'];
  const sizeMult = (SIZES[size] || SIZES['auto']) * (adjustScale / 100);

  const zoneX = Math.round(zoneDef.x * imgW);
  const zoneY = Math.round(zoneDef.y * imgH);
  const zoneW = Math.round(zoneDef.w * imgW);
  const zoneH = Math.round(zoneDef.h * imgH);

  // Load and resize graphic to fit within the zone
  const graphicMeta = await sharp(graphicPath).metadata();
  const graphicAspect = graphicMeta.width / graphicMeta.height;

  // Target size within the zone
  let targetW = Math.round(zoneW * sizeMult);
  let targetH = Math.round(targetW / graphicAspect);

  // If too tall, constrain by height
  if (targetH > zoneH * sizeMult) {
    targetH = Math.round(zoneH * sizeMult);
    targetW = Math.round(targetH * graphicAspect);
  }

  // Center within zone + adjustments
  const offsetX = Math.round(zoneX + (zoneW - targetW) / 2 + (adjustX / 100) * zoneW);
  const offsetY = Math.round(zoneY + (zoneH - targetH) / 2 + (adjustY / 100) * zoneH);

  console.log(`[GarmentComp] Model: ${imgW}x${imgH}, Zone: ${zone} (${zoneX},${zoneY} ${zoneW}x${zoneH})`);
  console.log(`[GarmentComp] Graphic: ${graphicMeta.width}x${graphicMeta.height} → ${targetW}x${targetH} at (${offsetX},${offsetY})`);

  // Resize the graphic
  const resizedGraphic = await sharp(graphicPath)
    .resize(targetW, targetH, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer();

  // Extract the garment region under the graphic placement for wrinkle/shadow mapping
  const extractW = Math.min(targetW, imgW - Math.max(0, offsetX));
  const extractH = Math.min(targetH, imgH - Math.max(0, offsetY));

  const garmentRegion = await sharp(modelImagePath)
    .extract({
      left: Math.max(0, offsetX),
      top: Math.max(0, offsetY),
      width: extractW,
      height: extractH
    })
    .greyscale()
    .toBuffer();

  // Get average brightness of the garment zone
  const garmentStats = await sharp(garmentRegion).stats();
  const avgBrightness = garmentStats.channels[0].mean;
  console.log(`[GarmentComp] Garment brightness: ${avgBrightness.toFixed(0)} (${avgBrightness < 100 ? 'dark' : 'light'} garment)`);

  // Apply subtle fabric texture effect using per-pixel alpha modulation.
  // The wrinkle map from the garment surface modulates the graphic's opacity:
  //   - Where fabric is smooth/bright → graphic at full opacity
  //   - Where fabric has wrinkles/shadows → graphic slightly more transparent
  // This creates a natural "printed on fabric" look without the grey rectangle problem.

  const wrinkleMap = await sharp(garmentRegion)
    .resize(targetW, targetH, { fit: 'fill' })
    .normalise()
    .toBuffer();

  // Extract graphic as raw RGBA pixels for per-pixel alpha modulation
  const graphicResized = sharp(resizedGraphic).ensureAlpha();
  const { data: graphicRaw, info: graphicInfo } = await graphicResized.raw().toBuffer({ resolveWithObject: true });
  const { data: wrinkleRaw } = await sharp(wrinkleMap).raw().toBuffer({ resolveWithObject: true });

  // Modulate alpha per-pixel using fabric wrinkle map:
  //   - Transparent pixels stay transparent (no grey rectangle)
  //   - Visible pixels get slightly reduced opacity at shadow/wrinkle areas
  //   - This creates a subtle "printed on fabric" look
  const modulated = Buffer.from(graphicRaw);
  const pixelCount = graphicInfo.width * graphicInfo.height;
  for (let i = 0; i < pixelCount; i++) {
    const alphaIdx = i * 4 + 3;
    const origAlpha = modulated[alphaIdx];
    if (origAlpha === 0) continue; // keep transparent areas transparent

    const wrinkle = wrinkleRaw[i] / 255; // 0=dark/shadow, 1=bright/smooth
    const shadowEffect = 1.0 - (blendOpacity * (1.0 - wrinkle));
    modulated[alphaIdx] = Math.round(origAlpha * Math.max(0.3, shadowEffect));
  }

  // Rebuild the graphic from modified RGBA buffer
  const finalGraphic = await sharp(modulated, {
    raw: { width: graphicInfo.width, height: graphicInfo.height, channels: 4 }
  }).png().toBuffer();

  // Composite the blended graphic onto the original model photo
  const filename = `apparel_${zone}_${Date.now()}_0.png`;
  const outputPath = path.join(OUTPUT_DIR, filename);

  await sharp(modelImagePath)
    .composite([{
      input: finalGraphic,
      left: Math.max(0, offsetX),
      top: Math.max(0, offsetY),
      blend: 'over'
    }])
    .toFile(outputPath);

  const webPath = `/images/ai-generated/apparel-mockups/${filename}`;
  console.log(`[GarmentComp] Saved: ${filename}`);

  return {
    imagePath: outputPath,
    webPath,
    filename,
    zone,
    size
  };
}

module.exports = { compositeOnGarment, ZONES_PRODUCT, ZONES_LIFESTYLE, SIZES };
