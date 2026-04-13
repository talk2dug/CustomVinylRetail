/**
 * Metal Print Pipeline Orchestrator
 *
 * Autonomous workflow: pick designs → apply metal filter → match rooms →
 * generate room mockups (AI compositing) → publish to Shopify with size variants →
 * hand off to reel-studio for reels → notify via Telegram.
 *
 * Mirrors apparel-pipeline.js structure but with room-based mockups instead of
 * model-based apparel mockups.
 *
 * Entry point: runMetalPrintPipeline(options)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { METAL_PRINT_PIPELINE_DIR } = require('../paths');
const { pick, apiFetch, sendTelegram, sleep, loadCatalog, logToJournal, APP_ROOT } = require('./pipeline-utils');
const { applyMetalFilter, generateRoomMockup, generateMultiPrintMockup } = require('../scripts/batch-room-mockup-generator');
const { publishBatch: publishMetalPrintBatch } = require('../scripts/shopify-metal-print-publisher');

const JOURNAL_PATH = path.join(APP_ROOT, 'data', 'metal-print-pipeline-log.json');

// Pipeline step definitions for progress tracking
const PIPELINE_STEPS = [
  { key: 'load',          index: 0, label: 'Loading Designs' },
  { key: 'filter',        index: 1, label: 'Applying Metal Filter' },
  { key: 'match-rooms',   index: 2, label: 'Matching Rooms' },
  { key: 'room-mockups',  index: 3, label: 'Generating Room Mockups' },
  { key: 'shopify-publish', index: 4, label: 'Shopify Publish' },
  { key: 'complete',      index: 5, label: 'Complete' }
];

fs.mkdirSync(METAL_PRINT_PIPELINE_DIR, { recursive: true });

/**
 * Resolve a design's graphic file to a local filesystem path.
 * Catalog designs have: image (URL), sources: { svg, png, jpg }
 */
function resolveDesignPath(design) {
  const candidates = [
    design.image,
    design.previewImage,
    design.preview,
    design.sources?.png,
    design.sources?.jpg,
    design.sources?.svg,
    design.pngSource,
    design.svgSource,
    design.source
  ].filter(Boolean);

  for (const candidate of candidates) {
    let fsPath = candidate;

    // Full URL: extract the /library/ path portion
    if (candidate.startsWith('http')) {
      const urlObj = new URL(candidate);
      fsPath = urlObj.pathname;
    }

    // Web path → filesystem
    if (fsPath.startsWith('/library/')) {
      fsPath = path.join('/mnt/websit', fsPath.replace('/library/', ''));
    } else if (fsPath.startsWith('/web/library/')) {
      fsPath = path.join('/mnt/websit', fsPath.replace('/web/library/', ''));
    } else if (fsPath.startsWith('library/')) {
      // Relative path like "library/uploads/custom-art/..."
      fsPath = path.join('/mnt/websit', fsPath.replace('library/', ''));
    }

    if (fs.existsSync(fsPath)) return fsPath;
  }
  return null;
}

/**
 * Load designs by IDs or category.
 * Supports both custom art artwork (art_* IDs from DB) and catalog designs.
 */
function loadDesigns({ designIds, category, limit }) {
  const db = require('../db');
  let designs = [];

  if (designIds && designIds.length) {
    // Custom art artwork (art_* IDs)
    for (const id of designIds) {
      if (id.startsWith('art_')) {
        const artwork = db.getCustomArtArtworkById ? db.getCustomArtArtworkById(id) : null;
        if (artwork) {
          designs.push({
            id: artwork.id,
            name: artwork.title || artwork.id,
            category: artwork.category || '',
            image: artwork.filePath || artwork.file_path || '',
            previewImage: artwork.previewPath || artwork.thumbnailPath || artwork.preview_path || artwork.thumbnail_path || '',
            sources: {}
          });
        }
      }
    }

    // Fall back to catalog for non-art_ IDs or if nothing found
    if (!designs.length) {
      try {
        const catalogData = loadCatalog();
        for (const cat of (catalogData.categories || [])) {
          for (const d of (cat.designs || [])) {
            if (designIds.includes(d.id) || designIds.includes(d.name)) {
              designs.push({ ...d, category: d.category || cat.name || '' });
            }
          }
        }
      } catch (e) {
        console.warn('[MetalPrintPipeline] Catalog load failed:', e.message);
      }
    }
  } else if (category) {
    // Search custom art artwork by category first
    const allArtwork = db.listCustomArtArtwork ? db.listCustomArtArtwork({ category }) : [];
    if (allArtwork && allArtwork.length) {
      designs = allArtwork.map(a => ({
        id: a.id,
        name: a.title || a.id,
        category: a.category || category,
        image: a.filePath || a.file_path || '',
        previewImage: a.previewPath || a.thumbnailPath || a.preview_path || a.thumbnail_path || '',
        sources: {}
      }));
    }

    // Also search catalog
    if (!designs.length) {
      try {
        const catalogData = loadCatalog();
        const catLower = category.toLowerCase();
        for (const cat of (catalogData.categories || [])) {
          if ((cat.name || '').toLowerCase().includes(catLower) || (cat.slug || '').toLowerCase().includes(catLower)) {
            designs.push(...(cat.designs || []).map(d => ({ ...d, category: cat.name || '' })));
          }
        }
      } catch (e) {
        console.warn('[MetalPrintPipeline] Catalog load failed:', e.message);
      }
    }
  }

  if (limit && designs.length > limit) {
    designs = designs.slice(0, limit);
  }

  return designs;
}

/**
 * Load room group members for the campaign.
 */
async function loadRoomGroup(roomGroupId) {
  const db = require('../db');
  const group = db.getRoomGroupById(roomGroupId);
  if (!group) throw new Error(`Room group not found: ${roomGroupId}`);
  const members = db.getRoomGroupMembers(roomGroupId);
  if (!members.length) throw new Error(`Room group "${group.name}" has no rooms`);
  return { group, members };
}

/**
 * Main pipeline function.
 *
 * @param {Object} options
 * @param {string[]} options.designIds - specific design IDs to process
 * @param {string} options.category - design category name (alternative to designIds)
 * @param {string} options.roomGroupId - room group to use for mockups
 * @param {string} options.campaignSlug - campaign identifier
 * @param {string} options.campaignTitle - human-readable title
 * @param {number} options.limit - max designs to process
 * @param {boolean} options.skipShopify - skip Shopify publishing
 * @param {string} options.pipelineRunId - existing pipeline_runs row ID
 * @param {Function} options.onProgress - progress callback
 */
async function runMetalPrintPipeline(options = {}) {
  const {
    designIds, category, roomGroupId, campaignSlug, campaignTitle,
    limit, skipShopify = false, pipelineRunId, onProgress
  } = options;

  const db = require('../db');
  const startedAt = new Date().toISOString();
  const errors = [];

  function progress(step, stepIndex, progressVal = 0, total = 0) {
    if (onProgress) {
      onProgress({ step, stepIndex, stepLabel: PIPELINE_STEPS[stepIndex]?.label, progress: progressVal, total });
    }
  }

  const campaignDir = path.join(METAL_PRINT_PIPELINE_DIR, campaignSlug || `campaign-${Date.now()}`);
  fs.mkdirSync(campaignDir, { recursive: true });

  console.log(`[MetalPrintPipeline] Starting: ${campaignTitle || category || 'campaign'}`);
  await sendTelegram(`🖼️ Metal Print Pipeline started: ${campaignTitle || category || 'campaign'}`);

  // ── Step 0: Load Designs ──────────────────────────────────────────────
  progress('load', 0);
  const designs = loadDesigns({ designIds, category, limit });
  if (!designs.length) {
    throw new Error(`No designs found for ${category || 'given IDs'}`);
  }
  console.log(`[MetalPrintPipeline] Loaded ${designs.length} designs`);
  progress('load', 0, designs.length, designs.length);

  // ── Step 1: Apply Metal Print Filter ──────────────────────────────────
  progress('filter', 1, 0, designs.length);
  const filteredArtMap = {}; // designId → filtered art path
  const designsWithPaths = [];

  for (let i = 0; i < designs.length; i++) {
    const design = designs[i];
    const sourcePath = resolveDesignPath(design);
    if (!sourcePath) {
      console.warn(`[MetalPrintPipeline] No source image for design: ${design.name}`);
      errors.push({ designId: design.id, error: 'No source image found' });
      continue;
    }

    const slug = (design.name || design.id).replace(/[^a-zA-Z0-9]/g, '-').toLowerCase().substring(0, 40);
    const filteredPath = path.join(campaignDir, `filtered-${slug}.png`);

    if (fs.existsSync(filteredPath)) {
      console.log(`[MetalPrintPipeline] Filter exists: ${slug}`);
    } else {
      try {
        const filteredBuffer = await applyMetalFilter(sourcePath);
        await fs.promises.writeFile(filteredPath, filteredBuffer);
        console.log(`[MetalPrintPipeline] Filtered: ${slug}`);
      } catch (err) {
        console.error(`[MetalPrintPipeline] Filter failed for ${slug}:`, err.message);
        errors.push({ designId: design.id, error: `Filter failed: ${err.message}` });
        continue;
      }
    }

    filteredArtMap[design.id] = filteredPath;
    designsWithPaths.push({ ...design, filteredPath, slug });
    progress('filter', 1, i + 1, designs.length);
  }

  if (!designsWithPaths.length) {
    throw new Error('No designs could be filtered successfully');
  }

  // ── Step 2: Match Rooms ───────────────────────────────────────────────
  progress('match-rooms', 2, 0, 1);

  let roomMembers = [];
  let roomGroupName = 'default';
  if (roomGroupId) {
    const { group, members } = await loadRoomGroup(roomGroupId);
    roomMembers = members;
    roomGroupName = group.name;
  } else {
    // Fallback: load all rooms from DB
    const rooms = db.listCustomArtRooms ? db.listCustomArtRooms() : [];
    roomMembers = rooms.map(r => ({
      ...r,
      room_type: r.room_type || 'living-room',
      multi_print: 0
    }));
  }

  if (!roomMembers.length) {
    throw new Error('No rooms available for mockup generation');
  }

  console.log(`[MetalPrintPipeline] Matched ${roomMembers.length} rooms from "${roomGroupName}"`);
  progress('match-rooms', 2, 1, 1);

  // ── Step 3: Generate Room Mockups ─────────────────────────────────────
  progress('room-mockups', 3, 0, designsWithPaths.length * roomMembers.length);

  const mockupResults = [];
  const mockupMap = {}; // designId → [mockupPath, ...]
  let mockupCount = 0;
  const totalMockups = designsWithPaths.length * roomMembers.length;

  for (const room of roomMembers) {
    const roomPath = resolveRoomPath(room);
    if (!roomPath) {
      console.warn(`[MetalPrintPipeline] No image for room: ${room.name}`);
      continue;
    }

    const roomSlug = (room.title || room.name || room.id).replace(/[^a-zA-Z0-9]/g, '-').toLowerCase().substring(0, 30);
    const roomType = room.group_room_type || room.room_type || 'default';
    const isMultiPrint = room.multi_print === 1;

    if (isMultiPrint && designsWithPaths.length > 1) {
      // Gallery wall: all filtered art in one room
      const filteredPaths = designsWithPaths.map(d => d.filteredPath);
      const result = await generateMultiPrintMockup(filteredPaths, roomPath, {
        roomType,
        outputDir: campaignDir,
        roomSlug,
        designSlugs: designsWithPaths.map(d => d.slug)
      });
      mockupResults.push(result);
      if (result.outputPath && !result.error) {
        // Associate with all designs
        for (const d of designsWithPaths) {
          if (!mockupMap[d.id]) mockupMap[d.id] = [];
          mockupMap[d.id].push(result.outputPath);
        }
      }
      mockupCount += designsWithPaths.length;
      progress('room-mockups', 3, mockupCount, totalMockups);
      await sleep(3000);
    } else {
      // Single print per design per room
      for (const design of designsWithPaths) {
        const result = await generateRoomMockup(design.filteredPath, roomPath, {
          roomType,
          outputDir: campaignDir,
          designSlug: design.slug,
          roomSlug
        });
        mockupResults.push(result);
        if (result.outputPath && !result.error) {
          if (!mockupMap[design.id]) mockupMap[design.id] = [];
          mockupMap[design.id].push(result.outputPath);
        }
        mockupCount++;
        progress('room-mockups', 3, mockupCount, totalMockups);
        await sleep(3000);
      }
    }
  }

  const mockupsGenerated = mockupResults.filter(r => r.outputPath && !r.error).length;
  console.log(`[MetalPrintPipeline] Generated ${mockupsGenerated} room mockups`);

  // Build theme_groups for reel-studio compatibility
  const themeGroups = {
    'metal-prints': designsWithPaths.map(d => ({
      name: d.name,
      designId: d.id,
      designSlug: d.slug,
      category: d.category || category || '',
      preview: d.previewImage || d.preview || null,
      mockupFiles: (mockupMap[d.id] || []).map(p => path.basename(p))
    }))
  };

  // Update pipeline run with mockup info
  if (pipelineRunId) {
    db.updatePipelineRun(pipelineRunId, {
      theme_groups: JSON.stringify(themeGroups),
      mockup_dir: campaignDir,
      collection: campaignTitle || category || campaignSlug
    });
  }

  // ── Step 4: Shopify Publish ───────────────────────────────────────────
  let shopifyResults = null;
  if (!skipShopify) {
    progress('shopify-publish', 4, 0, designsWithPaths.length);
    try {
      shopifyResults = await publishMetalPrintBatch({
        designs: designsWithPaths,
        mockupMap,
        filteredArtMap,
        dryRun: false,
        delayMs: 2000
      });

      if (pipelineRunId && shopifyResults.results) {
        db.updatePipelineRun(pipelineRunId, {
          publish_manifest: JSON.stringify(shopifyResults.results)
        });
      }

      console.log(`[MetalPrintPipeline] Shopify: ${shopifyResults.success} published, ${shopifyResults.failed} failed`);
      progress('shopify-publish', 4, shopifyResults.success, designsWithPaths.length);
    } catch (err) {
      console.error(`[MetalPrintPipeline] Shopify publish failed:`, err.message);
      errors.push({ step: 'shopify-publish', error: err.message });
    }
  } else {
    console.log(`[MetalPrintPipeline] Shopify publish skipped`);
  }

  // ── Step 5: Complete ──────────────────────────────────────────────────
  progress('complete', 5);

  const results = {
    campaignSlug: campaignSlug || `metal-${Date.now()}`,
    campaignTitle: campaignTitle || category || 'Metal Print Campaign',
    category: category || '',
    designCount: designsWithPaths.length,
    mockupsGenerated,
    shopifyPublished: shopifyResults ? shopifyResults.success : 0,
    mockupDir: campaignDir,
    mockupMap,
    filteredArtMap,
    themeGroups,
    errors,
    startedAt,
    completedAt: new Date().toISOString()
  };

  logToJournal(JOURNAL_PATH, {
    event: 'metal-print-pipeline-complete',
    campaignSlug: results.campaignSlug,
    designCount: results.designCount,
    mockupsGenerated: results.mockupsGenerated,
    shopifyPublished: results.shopifyPublished,
    errors: errors.length
  });

  // Telegram notification
  const summary = [
    `🖼️ Metal Print Pipeline Complete!`,
    `Campaign: ${results.campaignTitle}`,
    `Designs: ${results.designCount}`,
    `Room Mockups: ${results.mockupsGenerated}`,
    skipShopify ? 'Shopify: skipped' : `Shopify: ${results.shopifyPublished} published`,
    errors.length ? `Errors: ${errors.length}` : '',
    `→ Ready for reels in Reel Studio`
  ].filter(Boolean).join('\n');
  await sendTelegram(summary);

  return results;
}

/**
 * Resolve a room DB record to a filesystem path for its image.
 */
function resolveRoomPath(room) {
  const candidates = [
    room.image_path,
    room.imagePath,
    room.preview,
    room.previewImage
  ].filter(Boolean);

  for (const candidate of candidates) {
    let fsPath = candidate;
    if (candidate.startsWith('/library/')) {
      fsPath = path.join('/mnt/websit', candidate.replace('/library/', ''));
    } else if (candidate.startsWith('/web/library/')) {
      fsPath = path.join('/mnt/websit', candidate.replace('/web/library/', ''));
    }
    if (fs.existsSync(fsPath)) return fsPath;
  }
  return null;
}

module.exports = {
  runMetalPrintPipeline,
  PIPELINE_STEPS
};
