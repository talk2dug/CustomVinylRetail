/**
 * Multiboard Mockup Generator
 * Takes multiboard designer output (JSON) and creates photorealistic mockups:
 * 1. Render design JSON → flat layout image using Sharp
 * 2. Send to Gemini → photorealistic 3D render
 * 3. Optionally place into a room/garage scene
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const crypto = require('crypto');
const { NanoBananaService } = require('./nano-banana-service');
const { ImagePromptGenerator } = require('./leonardo-prompt-generator');

// Color palette for different part types
const PART_COLORS = {
  tile: { r: 60, g: 60, b: 60 },       // Dark gray
  hook: { r: 30, g: 120, b: 200 },      // Blue
  bin: { r: 200, g: 80, b: 30 },        // Orange
  shelf: { r: 80, g: 160, b: 60 },      // Green
  peg: { r: 160, g: 60, b: 160 },       // Purple
  hardware: { r: 180, g: 180, b: 50 },  // Yellow
  accessory: { r: 200, g: 50, b: 80 }   // Red
};

// Scene types for room placement
const ROOM_SCENES = {
  garage: {
    label: 'Garage Workshop',
    prompt: 'Place this modular wall organizer system on the wall of a clean, well-lit garage workshop. The garage has concrete floor, workbench nearby, and good overhead lighting. The organizer holds tools and supplies. Lifestyle photography, photorealistic, organized garage aesthetic.'
  },
  workshop: {
    label: 'Workshop',
    prompt: 'Mount this modular wall organizer on the wall of a well-organized workshop. Wooden workbench below, good task lighting, and a tidy workspace atmosphere. The organizer has tools neatly arranged on hooks and in bins. Professional photography, photorealistic.'
  },
  office: {
    label: 'Home Office',
    prompt: 'Display this modular wall organizer above a home office desk. Modern, clean aesthetic with the organizer holding office supplies, cables, and accessories. Natural lighting from a window. Interior design photography, photorealistic.'
  },
  laundry: {
    label: 'Laundry Room',
    prompt: 'Install this modular wall organizer in a bright, modern laundry room. The organizer holds cleaning supplies, detergent bottles, and laundry accessories. Clean, organized utility space aesthetic. Lifestyle photography, photorealistic.'
  },
  kitchen: {
    label: 'Kitchen',
    prompt: 'Mount this modular wall organizer on a kitchen wall. The organizer holds cooking utensils, spice containers, and kitchen tools. Modern kitchen with good lighting. Food and lifestyle photography aesthetic, photorealistic.'
  },
  craft_room: {
    label: 'Craft Room',
    prompt: 'Display this modular wall organizer in a bright craft room. The organizer holds art supplies, scissors, tape, markers, and craft materials in bins and on hooks. Creative, colorful workspace. Lifestyle photography, photorealistic.'
  }
};

class MultiboardMockupGenerator {
  constructor(options = {}) {
    this.service = options.service || new NanoBananaService(options);
    this.outputDir = path.join(
      options.outputDir || path.join(__dirname, '..', 'web', 'images', 'ai-generated'),
      'multiboard-mockups'
    );

    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }

    const claudeKey = options.claudeApiKey || process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
    if (claudeKey) {
      this.promptGenerator = new ImagePromptGenerator(claudeKey);
    }
  }

  /**
   * Render a design JSON into a flat layout image using Sharp
   */
  async createFlatLayout(designData, options = {}) {
    const {
      wallWidth = designData.wall_width || 48,
      wallHeight = designData.wall_height || 36,
      pixelsPerInch = 15,
      backgroundColor = { r: 230, g: 230, b: 230 }
    } = options;

    const canvasWidth = wallWidth * pixelsPerInch;
    const canvasHeight = wallHeight * pixelsPerInch;

    // Parse components
    const components = typeof designData.components_json === 'string'
      ? JSON.parse(designData.components_json)
      : (designData.components_json || designData.components || []);

    // Create SVG overlay for labels and components
    const svgParts = [];
    svgParts.push(`<svg width="${canvasWidth}" height="${canvasHeight}" xmlns="http://www.w3.org/2000/svg">`);

    // Draw grid lines
    for (let x = 0; x <= canvasWidth; x += pixelsPerInch) {
      svgParts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${canvasHeight}" stroke="#ccc" stroke-width="0.5"/>`);
    }
    for (let y = 0; y <= canvasHeight; y += pixelsPerInch) {
      svgParts.push(`<line x1="0" y1="${y}" x2="${canvasWidth}" y2="${y}" stroke="#ccc" stroke-width="0.5"/>`);
    }

    // Draw components
    for (const comp of components) {
      const type = (comp.type || 'tile').toLowerCase();
      const color = PART_COLORS[type] || PART_COLORS.tile;
      const x = (comp.x || 0) * pixelsPerInch;
      const y = (comp.y || 0) * pixelsPerInch;
      const w = (comp.width || 4) * pixelsPerInch;
      const h = (comp.height || 4) * pixelsPerInch;

      // Filled rectangle with border
      svgParts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="rgb(${color.r},${color.g},${color.b})" stroke="#333" stroke-width="2" rx="3"/>`);

      // Label
      const label = comp.name || comp.label || type;
      const fontSize = Math.min(14, w / label.length * 1.5);
      svgParts.push(`<text x="${x + w / 2}" y="${y + h / 2}" text-anchor="middle" dominant-baseline="middle" fill="white" font-family="Arial" font-size="${fontSize}" font-weight="bold">${label}</text>`);
    }

    // Title
    const title = designData.name || 'Multiboard Design';
    svgParts.push(`<text x="${canvasWidth / 2}" y="20" text-anchor="middle" fill="#333" font-family="Arial" font-size="16" font-weight="bold">${title}</text>`);

    svgParts.push('</svg>');

    const svgBuffer = Buffer.from(svgParts.join(''));

    // Compose: background + SVG overlay
    const filename = `layout_${crypto.randomUUID().slice(0, 8)}.png`;
    const outputPath = path.join(this.outputDir, filename);

    await sharp({
      create: {
        width: canvasWidth,
        height: canvasHeight,
        channels: 3,
        background: backgroundColor
      }
    })
      .composite([{ input: svgBuffer, top: 0, left: 0 }])
      .png()
      .toFile(outputPath);

    console.log(`[MultiboardMockup] Flat layout created: ${filename} (${canvasWidth}x${canvasHeight})`);
    return outputPath;
  }

  /**
   * Transform flat layout into a photorealistic 3D render
   */
  async renderRealistic(layoutImagePath, options = {}) {
    const prompt = `Transform this wall organizer layout diagram into a photorealistic 3D render. The layout shows a modular wall-mounted organizer system with color-coded components: gray tiles form the base grid, blue hooks for hanging items, orange bins for storage, green shelves, and purple pegs. Make each component look like high-quality 3D printed plastic with realistic materials - matte finish on bins, semi-gloss on hooks, subtle texture on tiles. Show proper depth, shadows, and realistic mounting hardware. The overall look should be a premium wall organization product. Product photography, photorealistic, high detail, clean white background.`;

    return this.service.generateScene(layoutImagePath, prompt, {
      subDir: 'multiboard-mockups',
      sceneType: 'realistic_render'
    });
  }

  /**
   * Place a rendered design into a room scene
   */
  async placeInScene(renderedImagePath, sceneType = 'garage', options = {}) {
    const scene = ROOM_SCENES[sceneType];
    if (!scene && !options.customPrompt) {
      throw new Error(`Unknown scene type: ${sceneType}. Available: ${Object.keys(ROOM_SCENES).join(', ')}`);
    }

    const scenePrompt = options.customPrompt || scene.prompt;

    return this.service.generateScene(renderedImagePath, scenePrompt, {
      subDir: 'multiboard-mockups',
      sceneType
    });
  }

  /**
   * Full pipeline: design JSON → flat layout → realistic render → room scene
   */
  async fullMockupPipeline(designData, options = {}) {
    const { sceneType = 'garage', skipRealistic = false } = options;

    console.log('[MultiboardMockup] Starting full pipeline...');

    // Step 1: Create flat layout
    console.log('[MultiboardMockup] Step 1: Creating flat layout...');
    const layoutPath = await this.createFlatLayout(designData, options);

    // Step 2: Render realistic (optional — can go straight to scene)
    let realisticPath = layoutPath;
    let realisticResults = null;
    if (!skipRealistic) {
      console.log('[MultiboardMockup] Step 2: Rendering realistic...');
      realisticResults = await this.renderRealistic(layoutPath);
      if (realisticResults.length > 0) {
        realisticPath = realisticResults[0].localPath;
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // Step 3: Place in scene
    console.log(`[MultiboardMockup] Step 3: Placing in ${sceneType} scene...`);
    const sceneResults = await this.placeInScene(realisticPath, sceneType);

    return {
      flatLayoutPath: layoutPath,
      realisticRender: realisticResults,
      sceneImages: sceneResults,
      sceneType
    };
  }

  /**
   * Full pipeline from a design ID in the database
   */
  async fullMockupFromDesignId(db, designId, options = {}) {
    const design = db.prepare('SELECT * FROM multiboard_designs WHERE id = ?').get(designId);
    if (!design) {
      throw new Error(`Design not found: ${designId}`);
    }

    return this.fullMockupPipeline(design, options);
  }

  /**
   * Get available room scene types
   */
  static getRoomScenes() {
    return Object.entries(ROOM_SCENES).map(([key, value]) => ({
      type: key,
      label: value.label
    }));
  }
}

module.exports = { MultiboardMockupGenerator, ROOM_SCENES };
