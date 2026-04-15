/**
 * reel-followup.js
 *
 * Post-reel pipeline steps, extracted from apparel-pipeline.js so they can
 * run on demand after reels are created manually in reel-studio.
 *
 * Exports:
 *   - publishTiktokShopReelProducts(reelRecords, ctx) — step 7b
 *   - createReelLandingPages(reelRecords, ctx) — step 7c
 *
 * reelRecords shape (same as apparel-pipeline allReelRecords):
 *   {
 *     videoId, theme, chunkIdx, isTikTokShopReel,
 *     reel: { outputUrl, outputPath, ... },
 *     designIds, designNames, shopifyProductIds, items
 *   }
 *
 * ctx shape:
 *   {
 *     notify: boolean,
 *     apparelChoices: [...],
 *     allReelRecords: [...],  // for "part X of Y" numbering
 *     results: {...},         // mutated: results.landingPages, results.errors
 *     reportProgress: fn,
 *     sendTelegram: fn        // optional override
 *   }
 */

// Lazy-loaded to avoid circular dependency with apparel-pipeline.js
function getPipelineHelpers() {
  const p = require('./apparel-pipeline');
  return {
    THEME_COPY: p.THEME_COPY,
    formatThemeName: p.formatThemeName,
    buildReelLandingPageHtml: p.buildReelLandingPageHtml
  };
}

// Local pick helper (apparel-pipeline.js doesn't export its own `pick`)
function pick(arr) {
  if (!Array.isArray(arr) || !arr.length) return '';
  return arr[Math.floor(Math.random() * arr.length)];
}

// Default no-op sendTelegram so callers can skip notifications
async function defaultSendTelegram() { /* no-op */ }

/**
 * Step 7b: Publish the "first reel per theme" products to the TikTok Shop
 * publication. Only products associated with isTikTokShopReel=true reels are
 * added, capped at 100 total products on TikTok Shop.
 */
async function publishTiktokShopReelProducts(reelRecords, ctx = {}) {
  const {
    notify = false,
    sendTelegram = defaultSendTelegram,
    results = { errors: [] }
  } = ctx;

  const tiktokShopReels = (reelRecords || []).filter(r => r.isTikTokShopReel);
  if (!tiktokShopReels.length) {
    return { added: 0, skipped: true, reason: 'no TikTok Shop reels' };
  }

  console.log(`[ReelFollowup] Step 7b: Publishing ${tiktokShopReels.length} TikTok Shop reel products`);
  if (notify) await sendTelegram('🛒 Adding TikTok Shop reel products...');

  try {
    const shopify = require('../integrations/shopify');
    const tiktokPub = await shopify.findTikTokPublication();

    if (!tiktokPub) {
      console.log('[ReelFollowup] TikTok Shop channel not found in Shopify');
      return { added: 0, skipped: true, reason: 'TikTok Shop publication not found' };
    }

    const currentTikTok = await shopify.getProductsOnPublication(tiktokPub.id).catch(() => []);
    const currentCount = currentTikTok.length;
    console.log(`[ReelFollowup] TikTok Shop: ${currentCount}/100 products currently`);

    const tiktokProductIds = [];
    for (const rec of tiktokShopReels) {
      tiktokProductIds.push(...(rec.shopifyProductIds || []));
    }
    const uniqueIds = [...new Set(tiktokProductIds)];

    const available = 100 - currentCount;
    const toAdd = uniqueIds.slice(0, Math.max(0, available));

    if (!toAdd.length) {
      console.log(`[ReelFollowup] TikTok Shop at capacity (${currentCount}/100), skipping`);
      if (notify) await sendTelegram(`⚠️ TikTok Shop at capacity (${currentCount}/100)`);
      return { added: 0, capacity: currentCount };
    }

    let added = 0;
    for (const pid of toAdd) {
      try {
        await shopify.publishToPublications(pid, [tiktokPub.id]);
        added++;
      } catch (err) {
        console.warn(`[ReelFollowup] TikTok publish failed for ${pid}: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, 500));
    }

    console.log(`[ReelFollowup] Added ${added} products to TikTok Shop (${currentCount + added}/100)`);
    if (notify) await sendTelegram(`🛒 Added ${added} products to TikTok Shop (${currentCount + added}/100 total)`);
    return { added, capacity: currentCount + added };
  } catch (err) {
    console.error('[ReelFollowup] TikTok Shop publish error:', err.message);
    if (notify) await sendTelegram(`⚠️ TikTok Shop publish failed: ${err.message}`);
    if (results && Array.isArray(results.errors)) {
      results.errors.push('TikTok Shop publish failed: ' + err.message);
    }
    return { added: 0, error: err.message };
  }
}

/**
 * Step 7c: Create or update a Shopify landing page for each reel, linking the
 * reel video to the featured products with a themed template. Updates the
 * corresponding tiktok_videos row with the page id/url.
 */
async function createReelLandingPages(reelRecords, ctx = {}) {
  const {
    notify = false,
    apparelChoices,
    sendTelegram = defaultSendTelegram,
    reportProgress = () => {},
    results = { errors: [], landingPages: [] }
  } = ctx;

  if (!results.landingPages) results.landingPages = [];

  if (!reelRecords || !reelRecords.length) {
    return { created: 0, skipped: true, reason: 'no reels' };
  }

  reportProgress('landing-pages', { progress: 0, total: reelRecords.length });
  console.log(`[ReelFollowup] Step 7c: Creating Shopify landing pages for ${reelRecords.length} reels`);
  if (notify) await sendTelegram('📄 Creating Shopify landing pages for reels...');

  try {
    const shopify = require('../integrations/shopify');
    const db = require('../db');
    const { THEME_COPY, formatThemeName, buildReelLandingPageHtml } = getPipelineHelpers();

    // Find the apparel collection handle for the "See More" link
    let collectionHandle = 'apparel';
    try {
      const collections = await shopify.listCollections();
      const apparelCol = (collections || []).find(c =>
        (c.title || '').toLowerCase().includes('apparel')
      );
      if (apparelCol && apparelCol.handle) collectionHandle = apparelCol.handle;
    } catch (_) {}

    for (const rec of reelRecords) {
      try {
        // Fetch product details from Shopify for the landing page
        const productCards = [];
        for (const pid of (rec.shopifyProductIds || [])) {
          try {
            const product = await shopify.getProduct(pid);
            if (product) {
              const allImages = Array.isArray(product.images) ? product.images.map(img => img.src) : [];
              const heroImage = allImages[0] || (product.image?.src || '');
              const price = product.variants?.[0]?.price || '24.99';
              const handle = product.handle || '';
              productCards.push({
                title: product.title || 'Custom Tee',
                image: heroImage,
                images: allImages,
                price,
                handle,
                id: pid,
                productType: product.product_type || product.productType || '',
                tags: Array.isArray(product.tags) ? product.tags : (typeof product.tags === 'string' ? product.tags.split(',').map(t => t.trim()) : []),
                vendor: product.vendor || ''
              });
            }
          } catch (err) {
            console.warn(`[ReelFollowup] Could not fetch product ${pid}: ${err.message}`);
          }
        }

        if (!productCards.length) {
          console.log(`[ReelFollowup] No products found for reel ${rec.videoId}, skipping landing page`);
          continue;
        }

        // Build the landing page HTML
        const copy = THEME_COPY[rec.theme] || THEME_COPY.default;
        const reelNum = (rec.chunkIdx || 0) + 1;
        const sameThemeCount = reelRecords.filter(r => r.theme === rec.theme).length;
        const pageTitle = `${formatThemeName(rec.theme)} Collection — Reel ${reelNum} (${new Date().toISOString().slice(0, 10)})`;
        const pageHandle = `reel-${rec.theme}-${reelNum}-${Date.now()}`;

        const bodyHtml = buildReelLandingPageHtml({
          title: pageTitle,
          hook: pick(copy.hooks),
          body: copy.body,
          products: productCards,
          collectionHandle,
          reelUrl: rec.reel.outputUrl,
          theme: rec.theme,
          isTikTokShopReel: rec.isTikTokShopReel,
          apparelChoices
        });

        // Check if page already exists (avoid duplicates)
        const existing = await shopify.findPageByTitle(pageTitle).catch(() => null);
        let page;
        if (existing) {
          page = await shopify.updatePage(existing.id, { body_html: bodyHtml, published: true });
          console.log(`[ReelFollowup] Updated existing landing page: ${existing.id}`);
        } else {
          page = await shopify.createPage({ title: pageTitle, body_html: bodyHtml, published: true });
          console.log(`[ReelFollowup] Created landing page: ${page.id} — "${pageTitle}"`);
        }

        // Update the tiktok_videos record with the Shopify page info
        if (page && page.id) {
          const pageUrl = `/pages/${page.handle || pageHandle}`;
          try {
            db.updateTiktokVideo(rec.videoId, {
              shopify_page_id: String(page.id),
              shopify_page_url: pageUrl
            });
          } catch (_) {}

          results.landingPages.push({
            videoId: rec.videoId,
            theme: rec.theme,
            pageId: page.id,
            pageUrl,
            productCount: productCards.length,
            isTikTokShopReel: rec.isTikTokShopReel
          });
        }
      } catch (err) {
        console.error(`[ReelFollowup] Landing page failed for reel ${rec.videoId}: ${err.message}`);
        if (results.errors) results.errors.push(`Landing page ${rec.videoId} failed: ${err.message}`);
      }
      reportProgress('landing-pages', { progress: results.landingPages.length, total: reelRecords.length });
    }

    if (notify && results.landingPages.length > 0) {
      await sendTelegram(`📄 Created ${results.landingPages.length} Shopify landing pages`);
    }
    return { created: results.landingPages.length };
  } catch (err) {
    console.error('[ReelFollowup] Landing page step failed:', err.message);
    if (notify) await sendTelegram(`⚠️ Landing page step failed: ${err.message}`);
    return { created: results.landingPages.length, error: err.message };
  }
}

module.exports = {
  publishTiktokShopReelProducts,
  createReelLandingPages
};
