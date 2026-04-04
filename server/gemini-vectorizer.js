/**
 * Gemini Vectorizer — AI-powered contour and vector generation for vinyl/sticker cutting
 *
 * Replaces potrace-based contour extraction with Gemini Vision AI.
 * Gemini understands what the design IS, not just pixel boundaries,
 * so it handles gradients, shadows, glow effects, and complex edges properly.
 *
 * Strategies:
 *   1. "direct-svg"  — Gemini returns SVG path data as text (best quality)
 *   2. "clean-trace" — Gemini creates clean mask → potrace traces it (most reliable)
 *   3. "color-separate" — Gemini identifies colors + generates per-color masks for vinyl
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const OUTPUT_DIR = path.join(__dirname, 'data', 'gemini-vectorizer');
const TEMP_DIR = path.join(__dirname, '..', 'temp_stickers');

// Ensure directories exist
for (const dir of [OUTPUT_DIR, TEMP_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

class GeminiVectorizer {
  constructor(options = {}) {
    const apiKey = options.apiKey || process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY is required');

    this.genAI = new GoogleGenerativeAI(apiKey);
    this.model = options.model || 'gemini-2.5-flash';
    this.outputDir = options.outputDir || OUTPUT_DIR;
  }

  /**
   * Get Gemini model configured for text responses (SVG path generation)
   */
  _getTextModel() {
    return this.genAI.getGenerativeModel({
      model: this.model,
      generationConfig: {
        responseModalities: ['TEXT'],
        temperature: 0.1, // Low temp for precise SVG output
      },
    });
  }

  /**
   * Get Gemini model configured for image responses (mask generation)
   */
  _getImageModel() {
    return this.genAI.getGenerativeModel({
      model: 'gemini-2.5-flash-image',
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        temperature: 0.2,
      },
    });
  }

  /**
   * Load image as base64 inline data for Gemini
   */
  _loadImagePart(imagePath) {
    const buffer = fs.readFileSync(imagePath);
    const ext = path.extname(imagePath).toLowerCase().slice(1);
    const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
    return {
      inlineData: {
        mimeType,
        data: buffer.toString('base64'),
      },
    };
  }

  // ==========================================================================
  // STRATEGY 1: Direct SVG Path Generation
  // Gemini analyzes image and returns SVG path data as text
  // ==========================================================================

  /**
   * Generate a contour SVG path for die-cutting (stickers, decals)
   * Returns the outer boundary path that a cutter should follow.
   *
   * @param {string} imagePath - Path to the design image
   * @param {object} options - { offset: mm, simplify: boolean }
   * @returns {Promise<{svgPath: string, width: number, height: number, viewBox: string}>}
   */
  async generateContourSVG(imagePath, options = {}) {
    const { offset = 1.0 } = options;

    // Get image dimensions
    const metadata = await sharp(imagePath).metadata();
    const { width, height } = metadata;

    // Scale down for Gemini if too large (saves tokens, Gemini doesn't need full res)
    const MAX_DIM = 1024;
    let processPath = imagePath;
    let scale = 1;

    if (width > MAX_DIM || height > MAX_DIM) {
      scale = MAX_DIM / Math.max(width, height);
      const scaledW = Math.round(width * scale);
      const scaledH = Math.round(height * scale);
      processPath = path.join(TEMP_DIR, `contour_input_${Date.now()}.png`);
      await sharp(imagePath).resize(scaledW, scaledH).png().toFile(processPath);
    }

    const processedMeta = await sharp(processPath).metadata();
    const pW = processedMeta.width;
    const pH = processedMeta.height;

    const imagePart = this._loadImagePart(processPath);
    const model = this._getTextModel();

    const prompt = `You are an expert SVG path generator for vinyl/sticker cutting machines.

Analyze this image and generate a SINGLE SVG path that traces the outer contour of the design.
This path will be used as a die-cut line for a sticker or vinyl cutter (like Silhouette Cameo).

RULES:
- The viewBox is "0 0 ${pW} ${pH}" (pixel coordinates matching the image dimensions)
- Generate ONE continuous closed path using SVG path commands (M, L, C, Q, Z)
- The path should trace the OUTER BOUNDARY of the visible design content
- Add approximately ${offset}mm offset (about ${Math.round(offset * 3.78)} pixels) OUTSIDE the design edge as bleed/margin
- Ignore internal details — we only need the outer silhouette cut line
- Use cubic bezier curves (C commands) for smooth curves, not straight line segments
- The path MUST be closed (end with Z)
- Handle transparency: trace around the opaque/visible content, ignore transparent areas
- If the design has a clear rectangular/circular shape, trace that shape smoothly
- For irregular shapes (characters, text, objects), trace the outer boundary precisely
- Ignore drop shadows, glow effects, or semi-transparent decorative elements
- Keep the path clean with reasonable point count (not too many, not too few)

Return ONLY a JSON object with this exact format (no markdown, no explanation):
{"svgPath": "M ... C ... Z", "confidence": 0.95}

The confidence should be 0.0-1.0 indicating how well you could identify the design boundary.`;

    console.log(`[GeminiVectorizer] Generating contour SVG for ${path.basename(imagePath)} (${pW}x${pH})`);

    const result = await model.generateContent([{ text: prompt }, imagePart]);
    const responseText = result.response.candidates[0].content.parts
      .filter(p => p.text)
      .map(p => p.text)
      .join('');

    // Clean temp file
    if (processPath !== imagePath) {
      try { fs.unlinkSync(processPath); } catch (_) {}
    }

    // Parse response
    const parsed = this._parseJsonResponse(responseText);
    if (!parsed || !parsed.svgPath) {
      throw new Error(`Gemini did not return valid SVG path data. Response: ${responseText.substring(0, 200)}`);
    }

    // Scale path back to original dimensions if we downscaled
    let svgPath = parsed.svgPath;
    if (scale !== 1) {
      svgPath = this._scaleSvgPath(svgPath, 1 / scale);
    }

    // Validate the path
    const validation = this._validateSvgPath(svgPath, width, height);
    if (!validation.valid) {
      console.warn(`[GeminiVectorizer] Path validation warning: ${validation.reason}`);
    }

    console.log(`[GeminiVectorizer] Contour generated: ${svgPath.length} chars, confidence: ${parsed.confidence}`);

    return {
      svgPath,
      width,
      height,
      viewBox: `0 0 ${width} ${height}`,
      confidence: parsed.confidence || 0,
      strategy: 'direct-svg',
    };
  }

  // ==========================================================================
  // VINYL VECTORIZATION — Convert raster to cut-ready vector shapes
  // This is fundamentally different from contour tracing.
  // Contour = outline AROUND a design (for stickers)
  // Vinyl vector = the actual SHAPES of the design (for cutting FROM vinyl)
  // ==========================================================================

  /**
   * Convert a raster image into clean SVG vector shapes for vinyl cutting.
   * NOT a contour/outline — this produces the actual shapes to cut FROM vinyl.
   *
   * For example: text "HELLO" → cut paths for each letter H, E, L, L, O
   * A logo → cut paths for each shape in the logo
   *
   * @param {string} imagePath
   * @param {object} options - { maxColors }
   * @returns {Promise<{colors: Array<{name, hex, svgPaths}>, width, height, svgContent}>}
   */
  async vectorizeForVinyl(imagePath, options = {}) {
    const { maxColors = 6 } = options;

    const metadata = await sharp(imagePath).metadata();
    const { width, height } = metadata;

    // Scale for processing
    const MAX_DIM = 1024;
    let processPath = imagePath;
    let scale = 1;
    if (width > MAX_DIM || height > MAX_DIM) {
      scale = MAX_DIM / Math.max(width, height);
      processPath = path.join(TEMP_DIR, `vinyl_input_${Date.now()}.png`);
      await sharp(imagePath)
        .resize(Math.round(width * scale), Math.round(height * scale))
        .png()
        .toFile(processPath);
    }

    const pMeta = await sharp(processPath).metadata();
    const pW = pMeta.width;
    const pH = pMeta.height;

    const imagePart = this._loadImagePart(processPath);
    const model = this._getTextModel();

    // STEP 1: Identify colors (same as before)
    const colorPrompt = `Analyze this image for vinyl cutting.
Identify the distinct colors in the DESIGN (not background). Merge similar shades.
Image: ${pW}x${pH} pixels.

Return ONLY JSON (no markdown):
{"colors":[{"name":"Red","hex":"#FF0000","percentage":35}],"confidence":0.9}`;

    console.log(`[GeminiVectorizer] Vinyl vectorize step 1: colors in ${path.basename(imagePath)}`);

    const colorResult = await model.generateContent([{ text: colorPrompt }, imagePart]);
    const colorText = colorResult.response.candidates[0].content.parts
      .filter(p => p.text).map(p => p.text).join('');
    const colorData = this._parseJsonResponse(colorText);

    if (!colorData || !colorData.colors || colorData.colors.length === 0) {
      throw new Error(`No colors identified. Response: ${colorText.substring(0, 200)}`);
    }

    const colors = colorData.colors.slice(0, maxColors);
    console.log(`[GeminiVectorizer] Found ${colors.length} colors: ${colors.map(c => `${c.name} (${c.hex})`).join(', ')}`);

    // STEP 2: For each color, generate actual VECTOR SHAPES (not contours)
    const resultColors = [];
    for (const color of colors) {
      try {
        console.log(`[GeminiVectorizer] Vinyl vectorize step 2: shapes for ${color.name} (${color.hex})`);

        const vectorPrompt = `You are converting a raster image to precise SVG vector paths for a VINYL CUTTER.
Image dimensions: ${pW}x${pH} pixels (coordinate space).

CRITICAL: This is VINYL CUTTING, not sticker die-cutting.
- A vinyl cutter cuts shapes OUT OF a sheet of colored vinyl
- The paths you generate are the EXACT SHAPES to cut — letters, graphics, icons, shapes
- These are NOT outlines/contours around the design — they ARE the design
- Each path must be a precise, clean vector representation of the actual shape

Look at the "${color.name}" (${color.hex}) areas in this image and create SVG paths that represent those shapes exactly.

Examples of what to produce:
- Text "HELLO" → 5 separate paths, one for each letter outline
- A star shape → 1 path that IS the star
- A circle with text → paths for the circle + paths for each letter
- A logo → paths for each distinct shape in the logo

RULES:
- Use closed SVG paths (M...C...Z or M...L...Z)
- Each distinct shape/letter/element should be its own separate path
- Paths should be FILLED shapes, not outlines — they represent the vinyl to keep
- For text, convert each letter to its outline path
- Use cubic bezier curves (C) for curves, straight lines (L) for straight edges
- Be precise — the cutter follows these paths exactly
- Holes in shapes (like the inside of letters O, D, A, etc.) need separate inner paths
- Keep paths clean and efficient

Return ONLY JSON (no markdown):
{"svgPaths":["M 10 20 L 30 20 L 30 50 L 10 50 Z","M 40 20 C 50 20 60 30 60 40 Z"]}`;

        const pathResult = await model.generateContent([{ text: vectorPrompt }, imagePart]);
        const pathText = pathResult.response.candidates[0].content.parts
          .filter(p => p.text).map(p => p.text).join('');

        const pathData = this._parseJsonResponse(pathText);
        if (pathData && pathData.svgPaths && pathData.svgPaths.length > 0) {
          let paths = pathData.svgPaths;
          if (scale !== 1) {
            paths = paths.map(p => this._scaleSvgPath(p, 1 / scale));
          }
          resultColors.push({ ...color, svgPaths: paths });
          console.log(`[GeminiVectorizer] ${color.name}: ${paths.length} vector shapes`);
        } else {
          console.warn(`[GeminiVectorizer] No shapes returned for ${color.name}`);
          resultColors.push({ ...color, svgPaths: [] });
        }

        await new Promise(r => setTimeout(r, 1000));
      } catch (err) {
        console.warn(`[GeminiVectorizer] Vector generation failed for ${color.name}: ${err.message}`);
        resultColors.push({ ...color, svgPaths: [] });
      }
    }

    if (processPath !== imagePath) {
      try { fs.unlinkSync(processPath); } catch (_) {}
    }

    console.log(`[GeminiVectorizer] Vinyl vectorize complete: ${resultColors.filter(c => c.svgPaths.length > 0).length}/${resultColors.length} colors with shapes`);

    return {
      colors: resultColors,
      width,
      height,
      viewBox: `0 0 ${width} ${height}`,
      confidence: colorData.confidence || 0,
      strategy: 'vinyl-vector',
    };
  }

  // ==========================================================================
  // STRATEGY 2: AI Clean + Trace
  // Gemini creates a clean black/white mask, then potrace traces it
  // ==========================================================================

  /**
   * Use Gemini to create a clean silhouette mask optimized for potrace tracing.
   * This is the most reliable strategy — Gemini handles the "understanding",
   * potrace handles the precision path generation.
   *
   * @param {string} imagePath - Path to the design image
   * @returns {Promise<{maskPath: string, width: number, height: number}>}
   */
  async generateCleanMask(imagePath) {
    const metadata = await sharp(imagePath).metadata();
    const { width, height } = metadata;

    // Scale for Gemini processing
    const MAX_DIM = 1024;
    let processPath = imagePath;
    if (width > MAX_DIM || height > MAX_DIM) {
      const scale = MAX_DIM / Math.max(width, height);
      processPath = path.join(TEMP_DIR, `mask_input_${Date.now()}.png`);
      await sharp(imagePath)
        .resize(Math.round(width * scale), Math.round(height * scale))
        .png()
        .toFile(processPath);
    }

    const imagePart = this._loadImagePart(processPath);
    const model = this._getImageModel();

    const prompt = `Create a clean black and white silhouette mask of the design in this image.

RULES:
- The output should be the EXACT same dimensions as the input image
- Make the design area SOLID WHITE on a SOLID BLACK background
- This mask will be used for vinyl/sticker die-cutting, so:
  - Include ALL visible design elements as white
  - Ignore drop shadows, glow effects, or semi-transparent decorative borders
  - Make edges CRISP and CLEAN — no anti-aliasing, no gray pixels
  - Fill any internal holes/gaps in the design (we want the OUTER boundary only)
  - Add about 2-3 pixels of padding around the design edge
- If the design has transparent background, the transparent area should be BLACK
- If the design has a colored/white background, determine what is "design" vs "background" intelligently
- The result must be a pure black and white image — no gray, no color`;

    console.log(`[GeminiVectorizer] Generating clean mask for ${path.basename(imagePath)}`);

    const result = await model.generateContent([{ text: prompt }, imagePart]);
    const response = result.response;

    // Clean temp
    if (processPath !== imagePath) {
      try { fs.unlinkSync(processPath); } catch (_) {}
    }

    // Extract the generated mask image
    let maskData = null;
    for (const part of response.candidates[0].content.parts) {
      if (part.inlineData) {
        maskData = part.inlineData;
        break;
      }
    }

    if (!maskData) {
      // Check text response for error info
      const textParts = response.candidates[0].content.parts.filter(p => p.text);
      const text = textParts.map(p => p.text).join(' ');
      throw new Error(`Gemini did not return a mask image. Text response: ${text.substring(0, 200)}`);
    }

    // Save the mask
    const maskFilename = `mask_${crypto.randomUUID().substring(0, 8)}.png`;
    const maskPath = path.join(this.outputDir, maskFilename);
    const buffer = Buffer.from(maskData.data, 'base64');

    // Ensure it's actually black and white by thresholding with sharp
    await sharp(buffer)
      .resize(width, height, { fit: 'fill' })
      .greyscale()
      .threshold(128)
      .png()
      .toFile(maskPath);

    console.log(`[GeminiVectorizer] Clean mask saved: ${maskFilename} (${width}x${height})`);

    return { maskPath, width, height };
  }

  /**
   * Full pipeline: Gemini clean mask → potrace trace → SVG contour
   * Most reliable approach — combines AI understanding with mechanical precision.
   *
   * @param {string} imagePath
   * @param {object} options - { offset, turdSize, alphaMax }
   * @returns {Promise<{svgPath, width, height, maskPath, strategy}>}
   */
  async cleanAndTrace(imagePath, options = {}) {
    const { offset = 1.0, turdSize = 5, alphaMax = 1.0 } = options;

    // Step 1: Gemini generates clean mask
    const { maskPath, width, height } = await this.generateCleanMask(imagePath);

    // Step 2: Potrace traces the mask
    const potrace = require('potrace');
    const potraceParams = {
      turdSize,
      alphaMax,
      optCurve: true,
      optTolerance: 0.2,
      threshold: 128,
      blackOnWhite: false, // White design on black background
    };

    const svgPath = await new Promise((resolve, reject) => {
      potrace.trace(maskPath, potraceParams, (err, svg) => {
        if (err) return reject(err);
        const pathMatch = svg.match(/d="([^"]+)"/);
        if (!pathMatch) return reject(new Error('No path in potrace output'));
        resolve(pathMatch[1]);
      });
    });

    console.log(`[GeminiVectorizer] Clean+Trace complete: ${svgPath.length} chars`);

    return {
      svgPath,
      width,
      height,
      viewBox: `0 0 ${width} ${height}`,
      maskPath,
      strategy: 'clean-trace',
      confidence: 0.9, // Clean masks generally produce reliable traces
    };
  }

  // ==========================================================================
  // STRATEGY 3: AI Color Separation for Vinyl Cutting
  // Gemini identifies distinct colors and generates per-color SVG paths
  // ==========================================================================

  /**
   * Analyze image colors and generate per-color cut paths for vinyl cutting.
   * Two-step process: (1) identify colors, (2) generate paths per color individually.
   * This avoids Gemini truncating huge JSON responses.
   *
   * @param {string} imagePath
   * @param {object} options - { maxColors }
   * @returns {Promise<{colors: Array<{name, hex, svgPaths, percentage}>, width, height}>}
   */
  async separateColors(imagePath, options = {}) {
    const { maxColors = 6 } = options;

    const metadata = await sharp(imagePath).metadata();
    const { width, height } = metadata;

    // Scale for processing
    const MAX_DIM = 1024;
    let processPath = imagePath;
    let scale = 1;
    if (width > MAX_DIM || height > MAX_DIM) {
      scale = MAX_DIM / Math.max(width, height);
      processPath = path.join(TEMP_DIR, `color_input_${Date.now()}.png`);
      await sharp(imagePath)
        .resize(Math.round(width * scale), Math.round(height * scale))
        .png()
        .toFile(processPath);
    }

    const pMeta = await sharp(processPath).metadata();
    const pW = pMeta.width;
    const pH = pMeta.height;

    const imagePart = this._loadImagePart(processPath);
    const model = this._getTextModel();

    // STEP 1: Identify colors only (small response, no truncation risk)
    const colorPrompt = `Analyze this image for vinyl cutting color separation.
Identify the distinct colors used in the DESIGN (not background).
Merge similar shades. Image dimensions: ${pW}x${pH} pixels.

Return ONLY JSON (no markdown):
{"colors":[{"name":"Red","hex":"#FF0000","percentage":35}],"confidence":0.9}`;

    console.log(`[GeminiVectorizer] Step 1: Identifying colors in ${path.basename(imagePath)} (${pW}x${pH})`);

    const colorResult = await model.generateContent([{ text: colorPrompt }, imagePart]);
    const colorText = colorResult.response.candidates[0].content.parts
      .filter(p => p.text).map(p => p.text).join('');

    const colorData = this._parseJsonResponse(colorText);
    if (!colorData || !colorData.colors || colorData.colors.length === 0) {
      throw new Error(`Gemini did not identify colors. Response: ${colorText.substring(0, 200)}`);
    }

    const colors = colorData.colors.slice(0, maxColors);
    console.log(`[GeminiVectorizer] Found ${colors.length} colors: ${colors.map(c => `${c.name} (${c.hex})`).join(', ')}`);

    // STEP 2: Generate paths for each color individually
    const resultColors = [];
    for (const color of colors) {
      try {
        console.log(`[GeminiVectorizer] Step 2: Generating paths for ${color.name} (${color.hex})`);

        const pathPrompt = `You are an SVG path generator for vinyl cutting.
Image dimensions: ${pW}x${pH} pixels (viewBox: "0 0 ${pW} ${pH}").

Generate SVG path(s) that trace the areas of "${color.name}" (${color.hex}) in this image.
These paths will cut this color from vinyl.

RULES:
- Use closed SVG paths (M...C...Z) with cubic bezier curves for smooth edges
- Trace ONLY the ${color.name} regions, not other colors
- Keep paths concise — use curves, not point-by-point outlines
- Maximum 3 separate paths for the main regions of this color

Return ONLY JSON (no markdown):
{"svgPaths":["M 10 20 C 30 40 50 60 70 80 Z"]}`;

        const pathResult = await model.generateContent([{ text: pathPrompt }, imagePart]);
        const pathText = pathResult.response.candidates[0].content.parts
          .filter(p => p.text).map(p => p.text).join('');

        const pathData = this._parseJsonResponse(pathText);
        if (pathData && pathData.svgPaths && pathData.svgPaths.length > 0) {
          let paths = pathData.svgPaths;
          if (scale !== 1) {
            paths = paths.map(p => this._scaleSvgPath(p, 1 / scale));
          }
          resultColors.push({
            ...color,
            svgPaths: paths,
          });
        } else {
          console.warn(`[GeminiVectorizer] No paths returned for ${color.name}`);
          resultColors.push({ ...color, svgPaths: [] });
        }

        // Rate limit between calls
        await new Promise(r => setTimeout(r, 1000));
      } catch (err) {
        console.warn(`[GeminiVectorizer] Path generation failed for ${color.name}: ${err.message}`);
        resultColors.push({ ...color, svgPaths: [] });
      }
    }

    if (processPath !== imagePath) {
      try { fs.unlinkSync(processPath); } catch (_) {}
    }

    console.log(`[GeminiVectorizer] Color separation complete: ${resultColors.filter(c => c.svgPaths.length > 0).length}/${resultColors.length} colors with paths`);

    return {
      colors: resultColors,
      width,
      height,
      viewBox: `0 0 ${width} ${height}`,
      confidence: colorData.confidence || 0,
      strategy: 'color-separate',
    };
  }

  // ==========================================================================
  // HYBRID: Best-effort contour with automatic fallback
  // ==========================================================================

  /**
   * Generate the best possible contour using multiple strategies with fallback.
   * Tries direct SVG first, falls back to clean+trace, then raw potrace.
   *
   * @param {string} imagePath
   * @param {object} options
   * @returns {Promise<{svgPath, width, height, strategy, confidence}>}
   */
  async generateContour(imagePath, options = {}) {
    const strategies = options.strategies || ['direct-svg', 'clean-trace'];

    for (const strategy of strategies) {
      try {
        console.log(`[GeminiVectorizer] Trying strategy: ${strategy}`);

        if (strategy === 'direct-svg') {
          const result = await this.generateContourSVG(imagePath, options);
          if (result.confidence >= 0.5) {
            return result;
          }
          console.log(`[GeminiVectorizer] Direct SVG confidence too low (${result.confidence}), trying next`);
        }

        if (strategy === 'clean-trace') {
          return await this.cleanAndTrace(imagePath, options);
        }

      } catch (err) {
        console.warn(`[GeminiVectorizer] Strategy "${strategy}" failed: ${err.message}`);
      }
    }

    // Final fallback: raw potrace on original image alpha channel
    console.log('[GeminiVectorizer] All AI strategies failed, falling back to raw potrace');
    const { extractContourBezier } = require('./sticker-sheet-generator');
    const result = await extractContourBezier(imagePath);
    return {
      ...result,
      strategy: 'potrace-fallback',
      confidence: 0.5,
    };
  }

  // ==========================================================================
  // STICKER SHEET: Full automated pipeline
  // ==========================================================================

  /**
   * Generate a complete sticker sheet with AI-powered contours.
   * Takes an array of design images, generates contours, lays them out,
   * and produces print PNG + cut SVG files.
   *
   * @param {Array<{imagePath, title, quantity}>} designs
   * @param {object} options
   * @returns {Promise<{sheets, totalStickers, outputDir}>}
   */
  async generateStickerSheet(designs, options = {}) {
    const {
      stickerSizeInches = 3,
      offsetMm = 0.5,
      strategy = 'clean-trace', // Most reliable for batch
      outputDir = path.join(this.outputDir, 'sheets'),
    } = options;

    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const stickerGen = require('./sticker-sheet-generator');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const prefix = `ai-sticker-sheet_${timestamp}`;

    console.log(`[GeminiVectorizer] Generating sticker sheet: ${designs.length} designs, strategy=${strategy}`);

    // Step 1: Process each design — remove background + AI contour
    const processedDesigns = [];
    for (const design of designs) {
      for (let q = 0; q < (design.quantity || 1); q++) {
        try {
          console.log(`[GeminiVectorizer] Processing: ${design.title || path.basename(design.imagePath)}`);

          // Remove background using sharp (check for transparency first)
          const meta = await sharp(design.imagePath).metadata();
          let processedPath = design.imagePath;

          // If no alpha channel, try to remove background
          if (!meta.hasAlpha) {
            const bgRemoved = path.join(TEMP_DIR, `nobg_${Date.now()}_${crypto.randomUUID().substring(0, 6)}.png`);
            // Simple approach: use sharp to make white transparent
            const { data, info } = await sharp(design.imagePath)
              .ensureAlpha()
              .raw()
              .toBuffer({ resolveWithObject: true });

            // Make near-white pixels transparent
            for (let i = 0; i < data.length; i += 4) {
              const r = data[i], g = data[i + 1], b = data[i + 2];
              if (r > 240 && g > 240 && b > 240) {
                data[i + 3] = 0; // Transparent
              }
            }

            await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
              .png()
              .toFile(bgRemoved);
            processedPath = bgRemoved;
          }

          // Generate AI contour
          const contourResult = await this.generateContour(processedPath, {
            strategies: [strategy],
            offset: offsetMm,
          });

          // Scale to target sticker size
          const targetPx = Math.round(stickerSizeInches * 300); // 300 DPI
          const scaleFactor = targetPx / Math.max(contourResult.width, contourResult.height);
          const scaledW = Math.round(contourResult.width * scaleFactor);
          const scaledH = Math.round(contourResult.height * scaleFactor);

          // Resize image to target sticker size
          const resizedPath = path.join(TEMP_DIR, `resized_${Date.now()}_${crypto.randomUUID().substring(0, 6)}.png`);
          await sharp(processedPath)
            .resize(scaledW, scaledH, { fit: 'inside' })
            .png()
            .toFile(resizedPath);

          const resizedMeta = await sharp(resizedPath).metadata();

          processedDesigns.push({
            imagePath: design.imagePath,
            processedPath: resizedPath,
            title: design.title || path.basename(design.imagePath),
            width: resizedMeta.width,
            height: resizedMeta.height,
            svgContour: contourResult.svgPath,
            contourStrategy: contourResult.strategy,
            contourConfidence: contourResult.confidence,
            useBezier: true,
          });

        } catch (err) {
          console.error(`[GeminiVectorizer] Failed to process ${design.title}: ${err.message}`);
          // Still include it — will get rectangle fallback cut path
          processedDesigns.push({
            imagePath: design.imagePath,
            processedPath: design.imagePath,
            title: design.title || path.basename(design.imagePath),
            width: 900,
            height: 900,
            svgContour: null,
            contourStrategy: 'failed',
            contourConfidence: 0,
            useBezier: false,
          });
        }
      }
    }

    // Step 2: Pack onto sheets
    const grid = stickerGen.calculateGridLayout(stickerSizeInches);
    const sheets = stickerGen.packDesignsOnSheets(processedDesigns, {
      widthPx: stickerGen.SHEET_CONFIG.widthPx,
      heightPx: stickerGen.SHEET_CONFIG.heightPx,
      marginPx: stickerGen.SHEET_CONFIG.marginPx,
    }, stickerGen.SHEET_CONFIG.gapPx, true);

    // Step 3: Generate output files for each sheet
    const results = [];
    for (let s = 0; s < sheets.length; s++) {
      const sheetNum = String(s + 1).padStart(2, '0');
      const placements = sheets[s];

      const printPath = path.join(outputDir, `${prefix}_Sheet${sheetNum}_PRINT.png`);
      const cutPath = path.join(outputDir, `${prefix}_Sheet${sheetNum}_CUT.svg`);

      // Generate print sheet
      await stickerGen.generatePrintSheet(placements, grid, printPath);

      // Generate cut SVG
      await stickerGen.generateCutFile(placements, grid, cutPath, offsetMm, true);

      results.push({
        sheetNumber: s + 1,
        printPath,
        cutPath,
        stickerCount: placements.length,
        placements: placements.map(p => ({
          title: p.title,
          x: p.x,
          y: p.y,
          width: p.width,
          height: p.height,
          contourStrategy: p.contourStrategy,
          confidence: p.contourConfidence,
        })),
      });
    }

    console.log(`[GeminiVectorizer] Sticker sheet complete: ${results.length} sheets, ${processedDesigns.length} stickers`);

    return {
      sheets: results,
      totalStickers: processedDesigns.length,
      totalSheets: results.length,
      outputDir,
      strategy,
    };
  }

  // ==========================================================================
  // VINYL CUT FILE GENERATION
  // For multi-color vinyl cutting with per-color SVG files
  // ==========================================================================

  /**
   * Generate vinyl cut files with AI color separation.
   * Each color gets its own SVG cut file.
   *
   * @param {string} imagePath
   * @param {object} options - { maxColors, canvasWidthMm, canvasHeightMm }
   * @returns {Promise<{files: Array<{color, hex, svgPath, filePath}>, outputDir}>}
   */
  async generateVinylCutFiles(imagePath, options = {}) {
    const {
      maxColors = 6,
      canvasWidthMm = 305, // 12"
      canvasHeightMm = 305,
    } = options;

    const batchId = `vinyl-${Date.now()}`;
    const batchDir = path.join(this.outputDir, 'vinyl-output', batchId);
    if (!fs.existsSync(batchDir)) fs.mkdirSync(batchDir, { recursive: true });

    // Get AI color separation
    const colorResult = await this.separateColors(imagePath, { maxColors });

    const files = [];
    for (const color of colorResult.colors) {
      if (!color.svgPaths || color.svgPaths.length === 0) continue;

      // Scale SVG paths from pixel space to mm space
      const scaleX = canvasWidthMm / colorResult.width;
      const scaleY = canvasHeightMm / colorResult.height;
      const scale = Math.min(scaleX, scaleY);

      const scaledPaths = color.svgPaths.map(p => this._scaleSvgPath(p, scale));

      // Generate SVG file for this color
      const safeName = color.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
      const svgFilename = `cut_${safeName}_${color.hex.replace('#', '')}.svg`;
      const svgPath = path.join(batchDir, svgFilename);

      const svgContent = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     width="${canvasWidthMm}mm"
     height="${canvasHeightMm}mm"
     viewBox="0 0 ${canvasWidthMm} ${canvasHeightMm}">
  <title>Vinyl Cut - ${color.name} (${color.hex})</title>
  <desc>Color-separated cut path for ${color.name} vinyl</desc>
  <g id="cut-paths" fill="none" stroke="${color.hex}" stroke-width="0.1">
${scaledPaths.map(p => `    <path d="${p}"/>`).join('\n')}
  </g>
</svg>`;

      fs.writeFileSync(svgPath, svgContent, 'utf8');

      files.push({
        color: color.name,
        hex: color.hex,
        percentage: color.percentage,
        pathCount: scaledPaths.length,
        filePath: svgPath,
        filename: svgFilename,
      });
    }

    console.log(`[GeminiVectorizer] Vinyl cut files: ${files.length} colors in ${batchDir}`);

    return {
      files,
      outputDir: batchDir,
      batchId,
      sourceImage: imagePath,
      confidence: colorResult.confidence,
    };
  }

  // ==========================================================================
  // UTILITY METHODS
  // ==========================================================================

  /**
   * Parse JSON from Gemini response text, handling markdown code fences
   */
  _parseJsonResponse(text) {
    // Strip markdown code fences if present
    let clean = text.trim();
    clean = clean.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

    try {
      return JSON.parse(clean);
    } catch (e) {
      // Try to find JSON object in the text
      const jsonMatch = clean.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[0]);
        } catch (_) {}
      }
      console.error('[GeminiVectorizer] Failed to parse JSON:', clean.substring(0, 200));
      return null;
    }
  }

  /**
   * Scale all coordinates in an SVG path string by a factor
   */
  _scaleSvgPath(pathData, factor) {
    return pathData.replace(
      /(-?\d+\.?\d*(?:e[+-]?\d+)?)/gi,
      (match) => {
        const num = parseFloat(match);
        return (num * factor).toFixed(2);
      }
    );
  }

  /**
   * Validate an SVG path string — basic sanity checks
   */
  _validateSvgPath(pathData, expectedWidth, expectedHeight) {
    if (!pathData || pathData.length < 10) {
      return { valid: false, reason: 'Path too short' };
    }

    // Must start with M and contain Z
    if (!pathData.match(/^M/i)) {
      return { valid: false, reason: 'Path does not start with M' };
    }
    if (!pathData.match(/Z\s*$/i)) {
      return { valid: false, reason: 'Path does not end with Z (not closed)' };
    }

    // Extract all numbers and check they're in reasonable range
    const nums = pathData.match(/-?\d+\.?\d*/g);
    if (!nums || nums.length < 6) {
      return { valid: false, reason: 'Too few coordinates' };
    }

    const values = nums.map(Number);
    const maxVal = Math.max(...values.map(Math.abs));
    const expectedMax = Math.max(expectedWidth, expectedHeight) * 1.5;

    if (maxVal > expectedMax) {
      return { valid: false, reason: `Coordinates exceed expected bounds (max: ${maxVal}, expected: ~${expectedMax})` };
    }

    return { valid: true };
  }
}

module.exports = { GeminiVectorizer };
