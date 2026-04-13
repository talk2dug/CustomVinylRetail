/**
 * Batch Room Mockup Generator
 *
 * Generates AI room mockups for metal print campaigns:
 * - Single print: art placed on wall in room context
 * - Multi-print: gallery wall / multi-print layout for garages, hallways, etc.
 *
 * Uses NanoBananaAI.compositeImages() (Gemini) for AI compositing.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { METAL_PRINT_PIPELINE_DIR, PIPELINE_OUTPUT_DIR } = require('../paths');
const { apiFetch, sleep } = require('../modules/pipeline-utils');
const { NanoBananaAI } = require('../nano-banana-ai');

fs.mkdirSync(METAL_PRINT_PIPELINE_DIR, { recursive: true });

// ── Prompt templates per room type ──────────────────────────────────────────

const ROOM_PROMPTS = {
  'living-room': {
    single: `Place this metal print artwork prominently on the main wall of this living room.
The artwork should be a high-quality HD metal print on brushed aluminum — it should look vivid,
glossy, and reflective with slightly metallic sheen. Make it the focal point of the room,
properly sized relative to the furniture (roughly 24x36 inches). Ensure correct perspective
and natural lighting/shadows on the print.`,
    multi: `Create an elegant gallery wall arrangement in this living room using these metal prints.
Each print is HD sublimation on brushed aluminum with vivid, glossy, metallic finish.
Arrange them in an aesthetically pleasing layout on the main wall — vary sizes slightly
(16x20, 24x36, 20x30). Maintain proper perspective, natural shadows, and consistent lighting.`
  },
  'garage': {
    single: `Hang this metal print artwork on the wall of this garage/workshop space.
The print is HD sublimation on aluminum — vivid colors, glossy metallic finish.
Make it look natural in the space, properly sized (24x36 inches), with correct perspective.`,
    multi: `Create an impressive gallery wall in this garage/workshop using these metal prints.
Each is HD sublimation on brushed aluminum with vivid, glossy finish. Arrange in a bold,
masculine layout — like a curated collection. Mix sizes (20x30, 24x36, 16x24).
These should look like they belong in a premium garage/man-cave.`
  },
  'hallway': {
    single: `Place this metal print artwork on this hallway wall. The print is HD sublimation
on aluminum with vivid, glossy metallic finish. Apply correct perspective correction for
the hallway angle. Size approximately 20x30 inches. Natural lighting and shadows.`,
    multi: `Arrange these metal prints in a row along this hallway wall. Each is HD sublimation
on brushed aluminum — glossy, vivid, metallic. Create a gallery-style progression down
the hallway, with prints slightly staggered or in a clean line. Proper perspective for
the hallway depth.`
  },
  'bedroom': {
    single: `Place this metal print artwork above the bed or on the main wall of this bedroom.
HD sublimation on aluminum — vivid, glossy, metallic sheen. Size approximately 30x40 inches
as a statement piece. Proper perspective and soft, natural lighting.`,
    multi: `Create a curated arrangement of these metal prints in this bedroom. Each is HD
sublimation on brushed aluminum with vivid metallic finish. Arrange above the bed or on the
main wall in a balanced, modern layout. Mix sizes tastefully.`
  },
  'office': {
    single: `Place this metal print artwork on the wall behind/beside the desk in this office.
HD sublimation on aluminum — vivid, glossy, professional metallic finish. Size approximately
24x36 inches. Should look professional and inspiring.`,
    multi: `Arrange these metal prints in this office space. Each is HD sublimation on brushed
aluminum — vivid, glossy, metallic finish. Create a professional gallery arrangement on
the main wall. Clean, modern, inspiring layout.`
  },
  'default': {
    single: `Place this metal print artwork on the main wall of this room. The artwork is
HD sublimation on brushed aluminum — vivid colors, glossy, slightly metallic reflective
finish. Size it naturally (roughly 24x36 inches). Correct perspective and natural lighting.`,
    multi: `Arrange these metal prints on the wall of this room. Each is HD sublimation on
brushed aluminum with vivid, glossy metallic finish. Create a balanced gallery arrangement
with varied sizes. Proper perspective and natural lighting.`
  }
};

/**
 * Apply the metal print filter (Sharp) to make art POP.
 * Replicates the server's handleApplyMetalPrintFilter logic.
 */
async function applyMetalFilter(inputPath) {
  const inputBuffer = await fs.promises.readFile(inputPath);
  const processedBuffer = await sharp(inputBuffer)
    .modulate({ brightness: 1.05, saturation: 1.4 })
    .linear(1.3, -(128 * 0.3))
    .recomb([
      [1.0, 0.0, 0.0],
      [0.0, 1.05, 0.0],
      [0.0, 0.0, 1.08]
    ])
    .png({ quality: 95 })
    .toBuffer();
  return processedBuffer;
}

/**
 * Generate a single-print room mockup.
 */
async function generateRoomMockup(filteredArtPath, roomImagePath, options = {}) {
  const { roomType = 'default', outputDir = METAL_PRINT_PIPELINE_DIR, designSlug = 'design', roomSlug = 'room' } = options;

  const outputFilename = `metal-mockup-${designSlug}-${roomSlug}-${Date.now()}.png`;
  const outputPath = path.join(outputDir, outputFilename);

  // Check dedup
  if (fs.existsSync(outputPath)) {
    console.log(`[RoomMockup] Skipping (exists): ${outputFilename}`);
    return { outputPath, outputFilename, skipped: true };
  }

  const prompts = ROOM_PROMPTS[roomType] || ROOM_PROMPTS.default;
  const prompt = prompts.single;

  try {
    const ai = new NanoBananaAI(process.env.GEMINI_API_KEY);
    const result = await ai.compositeImages([roomImagePath, filteredArtPath], prompt);

    if (result.images && result.images.length > 0) {
      const imgData = Buffer.from(result.images[0].data, 'base64');
      await fs.promises.mkdir(outputDir, { recursive: true });
      await fs.promises.writeFile(outputPath, imgData);
      console.log(`[RoomMockup] Generated: ${outputFilename} (${(imgData.length / 1024).toFixed(0)}KB)`);
      return { outputPath, outputFilename, skipped: false };
    }
    throw new Error('No images returned from Gemini compositing');
  } catch (err) {
    console.error(`[RoomMockup] Failed for ${designSlug}/${roomSlug}:`, err.message);
    return { outputPath: null, outputFilename, error: err.message };
  }
}

/**
 * Generate a multi-print (gallery wall) room mockup.
 */
async function generateMultiPrintMockup(filteredArtPaths, roomImagePath, options = {}) {
  const { roomType = 'garage', outputDir = METAL_PRINT_PIPELINE_DIR, roomSlug = 'room', designSlugs = [] } = options;

  const slugPart = designSlugs.slice(0, 3).join('-') || 'multi';
  const outputFilename = `metal-gallery-${slugPart}-${roomSlug}-${Date.now()}.png`;
  const outputPath = path.join(outputDir, outputFilename);

  const prompts = ROOM_PROMPTS[roomType] || ROOM_PROMPTS.default;
  const prompt = prompts.multi;

  try {
    const ai = new NanoBananaAI(process.env.GEMINI_API_KEY);
    const result = await ai.compositeImages([roomImagePath, ...filteredArtPaths], prompt);

    if (result.images && result.images.length > 0) {
      const imgData = Buffer.from(result.images[0].data, 'base64');
      await fs.promises.mkdir(outputDir, { recursive: true });
      await fs.promises.writeFile(outputPath, imgData);
      console.log(`[RoomMockup] Gallery generated: ${outputFilename} (${(imgData.length / 1024).toFixed(0)}KB)`);
      return { outputPath, outputFilename, skipped: false };
    }
    throw new Error('No images returned from Gemini compositing');
  } catch (err) {
    console.error(`[RoomMockup] Gallery failed for ${roomSlug}:`, err.message);
    return { outputPath: null, outputFilename, error: err.message };
  }
}

/**
 * Run a batch of room mockup generations.
 */
async function runBatch(options = {}) {
  const {
    designPaths = [],
    roomPaths = [],
    roomType = 'living-room',
    multiPrint = false,
    outputDir = METAL_PRINT_PIPELINE_DIR,
    delayMs = 3000
  } = options;

  console.log(`[RoomMockup] Starting batch: ${designPaths.length} designs, ${roomPaths.length} rooms, multiPrint=${multiPrint}`);

  const results = [];
  fs.mkdirSync(outputDir, { recursive: true });

  for (const roomEntry of roomPaths) {
    const roomPath = typeof roomEntry === 'string' ? roomEntry : roomEntry.path;
    const roomSlug = path.basename(roomPath, path.extname(roomPath)).replace(/[^a-z0-9]/gi, '-').substring(0, 30);
    const entryRoomType = (typeof roomEntry === 'object' && roomEntry.roomType) || roomType;

    if (multiPrint && designPaths.length > 1) {
      // Gallery wall with all designs
      const result = await generateMultiPrintMockup(designPaths, roomPath, {
        roomType: entryRoomType,
        outputDir,
        roomSlug,
        designSlugs: designPaths.map(p => path.basename(p, path.extname(p)).substring(0, 15))
      });
      results.push(result);
    } else {
      // Single print per room
      for (const designPath of designPaths) {
        const designSlug = path.basename(designPath, path.extname(designPath)).replace(/[^a-z0-9]/gi, '-').substring(0, 30);
        const result = await generateRoomMockup(designPath, roomPath, {
          roomType: entryRoomType,
          outputDir,
          designSlug,
          roomSlug
        });
        results.push(result);
        if (delayMs > 0) await sleep(delayMs);
      }
    }
    if (delayMs > 0) await sleep(delayMs);
  }

  const success = results.filter(r => r.outputPath && !r.error).length;
  const failed = results.filter(r => r.error).length;
  console.log(`[RoomMockup] Batch complete: ${success} success, ${failed} failed`);

  return {
    generatedAt: new Date().toISOString(),
    total: results.length,
    success,
    failed,
    results
  };
}

/**
 * API route handler for batch room mockup generation.
 */
async function handleBatchRoomMockupRoute(pathname, req, res, db) {
  const { parseBody, sendJson, sendError } = require('../utils/http');

  // POST /api/batch-room-mockups/generate
  if (pathname === '/api/batch-room-mockups/generate' && req.method === 'POST') {
    const body = await parseBody(req);
    const { designPaths, roomPaths, roomType, multiPrint, outputDir, delayMs } = body;

    if (!designPaths || !designPaths.length) {
      return sendError(res, 400, 'designPaths array required');
    }
    if (!roomPaths || !roomPaths.length) {
      return sendError(res, 400, 'roomPaths array required');
    }

    // Run in background
    runBatch({ designPaths, roomPaths, roomType, multiPrint, outputDir, delayMs }).then(result => {
      console.log(`[RoomMockup] Background batch finished: ${result.success}/${result.total}`);
    }).catch(err => {
      console.error('[RoomMockup] Background batch failed:', err);
    });

    sendJson(res, 200, { status: 'started', designCount: designPaths.length, roomCount: roomPaths.length });
    return true;
  }

  // GET /api/batch-room-mockups — list generated mockups
  if (pathname === '/api/batch-room-mockups' && req.method === 'GET') {
    const dir = METAL_PRINT_PIPELINE_DIR;
    if (!fs.existsSync(dir)) {
      return sendJson(res, 200, { mockups: [] });
    }
    const files = fs.readdirSync(dir)
      .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
      .map(f => {
        const stat = fs.statSync(path.join(dir, f));
        return { filename: f, size: stat.size, createdAt: stat.mtime.toISOString() };
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    sendJson(res, 200, { mockups: files, count: files.length });
    return true;
  }

  return false;
}

// CLI support
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log('Usage: node batch-room-mockup-generator.js <design-path> <room-path> [--multi] [--room-type=living-room]');
    process.exit(1);
  }
  const designPaths = [args[0]];
  const roomPaths = [args[1]];
  const multiPrint = args.includes('--multi');
  const roomTypeArg = args.find(a => a.startsWith('--room-type='));
  const roomType = roomTypeArg ? roomTypeArg.split('=')[1] : 'living-room';

  runBatch({ designPaths, roomPaths, multiPrint, roomType }).then(result => {
    console.log(JSON.stringify(result, null, 2));
  }).catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  generateRoomMockup,
  generateMultiPrintMockup,
  applyMetalFilter,
  runBatch,
  handleBatchRoomMockupRoute,
  ROOM_PROMPTS
};
