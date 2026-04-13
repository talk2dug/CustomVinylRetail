/**
 * Centralized path configuration for all asset storage.
 *
 * ALL media files live on mounted drives — nothing on root partition.
 *
 * Drive layout:
 *   /mnt/websit   (49G) — Web-served assets (images, models, videos, music)
 *   /mnt/dbFiles   (98G) — Pipeline data, design icons, caches, backups
 *   /mnt/stlFiles  (98G) — 3D models, video footage, timelapse
 *   /mnt/usrdata   (32G) — Electron updates, scraper data
 */

const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..');

// ── Web-served assets (nginx serves /library/ from /mnt/websit/) ──────────
const WEBSIT = '/mnt/websit';

const PATHS = {
  // Root references
  APP_ROOT,
  WEB_DIR: path.join(APP_ROOT, 'web'),

  // ── /mnt/websit — served by nginx at /library/* ──
  WEBSIT,
  HUMAN_MODELS_DIR:      path.join(WEBSIT, 'human-models'),
  MOCKUP_BACKGROUNDS_DIR: path.join(WEBSIT, 'mockup-backgrounds'),
  CUSTOM_ART_DIR:        path.join(WEBSIT, 'custom-art-images'),
  APPAREL_MOCKUPS_DIR:   path.join(WEBSIT, 'ai-generated-apparel-mockups'),
  VINYL_CUTS_DIR:        path.join(WEBSIT, 'vinyl-cuts'),
  STICKER_SHEETS_DIR:    path.join(WEBSIT, 'sticker-sheets'),
  TIKTOK_VIDEOS_DIR:     path.join(WEBSIT, 'tiktok-videos'),
  TIKTOK_MUSIC_DIR:      path.join(WEBSIT, 'tiktok-music'),
  CAMPAIGNS_DIR:         path.join(WEBSIT, 'campaigns'),
  PRODUCT_IMAGES_DIR:    path.join(WEBSIT, 'product-images'),
  UPLOADS_DIR:           path.join(WEBSIT, 'uploads'),
  IMAGES_DIR:            path.join(WEBSIT, 'images'),
  VIDEOS_DIR:            path.join(WEBSIT, 'videos'),
  LIBRARY_IMAGES_AI_DIR: path.join(WEBSIT, 'library-images-ai-generated'),

  // ── /mnt/dbFiles — pipeline output, caches, large libraries ──
  DB_FILES:              '/mnt/dbFiles',
  DECAL_ICONS_DIR:       '/mnt/dbFiles/DecalCreatorIcons',
  PIPELINE_OUTPUT_DIR:   '/mnt/dbFiles/apparel-pipeline',
  METAL_PRINT_PIPELINE_DIR: '/mnt/dbFiles/metal-print-pipeline',
  PRODUCT_BLANKS_DIR:    '/mnt/dbFiles/product-blank-mockups',
  BLANK_IMAGES_DIR:      '/mnt/dbFiles/blank-images',
  SAVED_DESIGNS_DIR:     '/mnt/dbFiles/saved-designs',
  GCODE_CACHE_DIR:       '/mnt/dbFiles/gcode-cache',
  DB_BACKUPS_DIR:        '/mnt/dbFiles/db-backups',
  GDRIVE_CUSTOM_ART_DIR: '/mnt/dbFiles/uploads/custom-art',
  DESIGN_CATEGORIES_PATH: '/mnt/dbFiles/design-categories.json',
  ARTWORK_IDS_PATH:      '/mnt/dbFiles/artwork-identifications.json',

  // ── /mnt/stlFiles — 3D printing + video production ──
  STL_LIBRARY_DIR:       '/mnt/stlFiles/stl-library',
  FOOTAGE_DIR:           '/mnt/stlFiles/footage-library',
  TIMELAPSE_DIR:         '/mnt/stlFiles/timelapse',

  // ── /mnt/usrdata — releases + misc ──
  PRINT_STATION_UPDATES: '/mnt/usrdata/print-station-updates',

  // ── URL path mappings (for resolving web URLs to filesystem) ──
  URL_MAPPINGS: [
    { prefix: '/library/',     localRoot: '/mnt/websit/' },
    { prefix: '/web/library/', localRoot: '/mnt/websit/' },
    { prefix: '/api/library/', localRoot: '/mnt/websit/' },
    { prefix: '/dbFiles/',     localRoot: '/mnt/dbFiles/' },
  ],
};

/**
 * Resolve a web URL path (like /library/human-models/foo.jpg)
 * to a local filesystem path.
 */
function resolveWebPathToLocal(urlPath) {
  if (!urlPath) return null;
  for (const { prefix, localRoot } of PATHS.URL_MAPPINGS) {
    if (urlPath.startsWith(prefix)) {
      return path.join(localRoot, urlPath.slice(prefix.length));
    }
  }
  // Fallback: treat as relative to /mnt/websit
  if (urlPath.startsWith('/')) {
    return path.join(WEBSIT, urlPath.slice(1));
  }
  return null;
}

PATHS.resolveWebPathToLocal = resolveWebPathToLocal;

module.exports = PATHS;
