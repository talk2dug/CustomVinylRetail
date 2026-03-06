/**
 * Vectorize Service - Enhance catalog product images to clean vector-style graphics
 * Uses Nano Banana (Gemini) to improve image quality and make them more vector-like
 */

const path = require('path');
const { NanoBananaService } = require('./nano-banana-service');

class VectorizeService {
  constructor(options = {}) {
    this.service = options.service || new NanoBananaService(options);
  }

  /**
   * Enhance a single catalog item's image
   */
  async enhanceCatalogImage(imagePath, options = {}) {
    const { style = 'clean' } = options;
    return this.service.vectorizeImage(imagePath, { style });
  }

  /**
   * Batch enhance multiple catalog images
   */
  async batchEnhanceCatalog(imagePaths, options = {}) {
    const { style = 'clean', onProgress } = options;

    return this.service.processBatch(
      imagePaths,
      async (imagePath) => {
        return this.service.vectorizeImage(imagePath, { style });
      },
      { onProgress }
    );
  }

  /**
   * Enhance a catalog image from its database ID
   * Requires a DB instance with stl_catalog table
   */
  async enhanceCatalogById(db, catalogId, options = {}) {
    const item = db.prepare('SELECT * FROM stl_catalog WHERE id = ?').get(catalogId);
    if (!item) {
      throw new Error(`Catalog item not found: ${catalogId}`);
    }

    const thumbnailPath = item.thumbnail_path;
    if (!thumbnailPath) {
      throw new Error(`No thumbnail for catalog item: ${catalogId}`);
    }

    const results = await this.enhanceCatalogImage(thumbnailPath, options);

    // Update catalog with enhanced path if successful
    if (results.length > 0) {
      try {
        db.prepare('UPDATE stl_catalog SET enhanced_thumbnail_path = ? WHERE id = ?')
          .run(results[0].localPath, catalogId);
      } catch (e) {
        // Column may not exist, try adding it
        try {
          db.exec('ALTER TABLE stl_catalog ADD COLUMN enhanced_thumbnail_path TEXT');
          db.prepare('UPDATE stl_catalog SET enhanced_thumbnail_path = ? WHERE id = ?')
            .run(results[0].localPath, catalogId);
        } catch (e2) {
          console.warn('[VectorizeService] Could not save enhanced path to DB:', e2.message);
        }
      }
    }

    return results;
  }
}

module.exports = { VectorizeService };
