const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('printStation', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config) => ipcRenderer.invoke('config:set', config),
  readFileAsBase64: (filePath) => ipcRenderer.invoke('file:readAsBase64', filePath),
  fetchImageAsBase64: (url) => ipcRenderer.invoke('file:fetchAsBase64', url),
  fetchQueue: (options) => ipcRenderer.invoke('queue:fetch', options),
  markDownloaded: (payload) => ipcRenderer.invoke('queue:ack', payload),
  markCompleted: (payload) => ipcRenderer.invoke('queue:complete', payload),
  listOrders: () => ipcRenderer.invoke('orders:list'),
  updateOrder: (payload) => ipcRenderer.invoke('orders:update', payload || {}),
  fetchCatalog: (options) => ipcRenderer.invoke('catalog:fetch', options || {}),
  catalogMove: (payload) => ipcRenderer.invoke('catalog:move', payload || {}),
  catalogRename: (payload) => ipcRenderer.invoke('catalog:rename', payload || {}),
  catalogDelete: (payload) => ipcRenderer.invoke('catalog:delete', payload || {}),
  catalogCreateFolder: (payload) => ipcRenderer.invoke('catalog:folder:create', payload || {}),
  catalogExtractZip: (zipPath) => ipcRenderer.invoke('catalog:extract-zip', zipPath),
  cleanupTempDir: (dirPath) => ipcRenderer.invoke('util:cleanupTempDir', dirPath),
  uploadArtwork: (payload) => ipcRenderer.invoke('artwork:upload', payload),
  // Local catalogging
  selectFolder: (options) => ipcRenderer.invoke('dialog:selectFolder', options || {}),
  scanLocal: (payload) => ipcRenderer.invoke('local:scan', payload || {}),
  importLocal: (payload) => ipcRenderer.invoke('local:import', payload || {}),
  listLocal: (options) => ipcRenderer.invoke('local:list', options || {}),
  updateLocal: (id, updates) => ipcRenderer.invoke('local:update', { id, updates } || {}),
  deleteLocal: (id) => ipcRenderer.invoke('local:delete', id),
  listLocalCategories: () => ipcRenderer.invoke('local:categories'),
  approveLocal: (ids) => ipcRenderer.invoke('local:approve', { ids } || {}),
  approveLocalCategory: (category) => ipcRenderer.invoke('local:approveCategory', category),
  exportLocal: (payload) => ipcRenderer.invoke('local:export', payload || {}),
  generateLocalMockups: (payload) => ipcRenderer.invoke('local:mockups', payload || {}),
  watchImportNow: () => ipcRenderer.invoke('watch:importNow'),
  onMockupsProgress: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const handler = (_e, data) => cb(data || {});
    ipcRenderer.on('local:mockups:progress', handler);
    return () => ipcRenderer.off('local:mockups:progress', handler);
  },
  onRemoveBgProgress: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const handler = (_e, data) => cb(data || {});
    ipcRenderer.on('local:previews:remove-bg:progress', handler);
    return () => ipcRenderer.off('local:previews:remove-bg:progress', handler);
  },
  removeBgFromPreviews: (payload) => ipcRenderer.invoke('local:previews:remove-bg', payload || {}),
  cancelJob: (jobId) => ipcRenderer.invoke('jobs:cancel', jobId),
  genJobId: () => `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  optimizeLocal: (id) => ipcRenderer.invoke('local:optimize', id),
  optimizeLocalMany: async (ids = []) => {
    const results = [];
    for (const id of Array.isArray(ids) ? ids : []) {
      try { results.push(await ipcRenderer.invoke('local:optimize', id)); } catch (e) { results.push(null); }
    }
    return results;
  },
  publishLocal: (ids) => ipcRenderer.invoke('local:publish', { ids } || {}),
  // OCR
  ocrLocal: (payload) => ipcRenderer.invoke('local:ocr', payload || {}),
  ocrFromUrl: (url) => ipcRenderer.invoke('ocr:fromUrl', url),
  ocrCategoryLocal: (payload) => ipcRenderer.invoke('ocr:categoryLocal', payload || {}),
  onOcrProgress: (channel, callback) => {
    ipcRenderer.on(channel, (_event, data) => callback(data));
    return () => ipcRenderer.removeAllListeners(channel);
  },
  openExternal: (target) => ipcRenderer.invoke('system:openExternal', target),
  selectFiles: (options) => ipcRenderer.invoke('dialog:selectFiles', options),
  fetchRaceQuotes: () => ipcRenderer.invoke('quotes:fetch'),
  fetchRaceQuoteDetail: (id) => ipcRenderer.invoke('quotes:detail', id),
  updateRaceQuote: (id, payload) => ipcRenderer.invoke('quotes:update', { id, payload }),
  postRaceQuoteMessage: (id, message) =>
    ipcRenderer.invoke('quotes:message', { id, message }),
  generateQuoteAssets: (id) => ipcRenderer.invoke('quotes:generate-assets', { id }),
  fetchInventory: (options) => ipcRenderer.invoke('inventory:list', options || {}),
  createInventoryItem: (payload) => ipcRenderer.invoke('inventory:create', payload || {}),
  adjustInventory: (payload) => ipcRenderer.invoke('inventory:adjust', payload || {}),
  updateInventoryItem: (payload) => ipcRenderer.invoke('inventory:update', payload || {}),
  deleteInventoryItem: (payload) => ipcRenderer.invoke('inventory:delete', payload || {}),
  fetchApparelCategories: () => ipcRenderer.invoke('apparel:categories:list'),
  createApparelCategory: (payload) => ipcRenderer.invoke('apparel:categories:create', payload || {}),
  fetchApparelStore: () => ipcRenderer.invoke('apparel:store'),
  updateApparelStoreItem: (payload) => ipcRenderer.invoke('apparel:store:update', payload || {}),
  fetchSsawStyles: (params) => ipcRenderer.invoke('vendor:ssaw:styles', params || {}),
  fetchSsawProducts: (style) => ipcRenderer.invoke('vendor:ssaw:products', style),
  createVendorOrder: (payload) => ipcRenderer.invoke('vendor:ssaw:order:create', payload || {}),
  fetchSsawOrders: (params) => ipcRenderer.invoke('vendor:ssaw:orders:list', params || {}),
  fetchLocalVendorOrders: (params) => ipcRenderer.invoke('vendor:local:orders', params || {}),
  updateLocalVendorOrder: (id, updates) => ipcRenderer.invoke('vendor:local:orders:update', { id, updates } || {}),
  createLocalVendorOrderDraft: (payload) => ipcRenderer.invoke('vendor:local:orders:create', payload || {}),
  approveLocalVendorOrder: (id) => ipcRenderer.invoke('vendor:local:orders:approve', id),
  rejectLocalVendorOrder: (id) => ipcRenderer.invoke('vendor:local:orders:reject', id),
  fetchLocalTopVendorItems: (params) => ipcRenderer.invoke('vendor:local:orders:top', params || {}),
  fetchSsawConfig: () => ipcRenderer.invoke('vendor:ssaw:config'),
  updateSsawConfig: (payload) => ipcRenderer.invoke('vendor:ssaw:config:update', payload || {}),
  listImageFiles: (payload) => ipcRenderer.invoke('fs:listImages', payload || {}),
  downloadFile: (payload) => ipcRenderer.invoke('files:download', payload || {}),
  // AI Recolor
  checkRecolorCache: (payload) => ipcRenderer.invoke('recolor:checkCache', payload || {}),
  generateRecolor: (payload) => ipcRenderer.invoke('recolor:generate', payload || {}),
  // Campaigns
  createCampaign: (payload) => ipcRenderer.invoke('campaigns:create', payload || {}),
  listCampaigns: () => ipcRenderer.invoke('campaigns:list'),
  getCampaign: (slug) => ipcRenderer.invoke('campaigns:get', slug),
  updateCampaign: (slug, payload) => ipcRenderer.invoke('campaigns:update', { slug, payload } || {}),
  deleteCampaign: (slug) => ipcRenderer.invoke('campaigns:delete', slug),
  // Admin cleanup
  listOrphanOrders: () => ipcRenderer.invoke('admin:orders:orphans'),
  cleanupOrders: (payload) => ipcRenderer.invoke('admin:orders:cleanup', payload || {}),
  deleteOrderAdmin: (id) => ipcRenderer.invoke('admin:orders:delete', id),
  sendTestSms: (payload) => ipcRenderer.invoke('admin:sms:test', payload || {})
  ,
  listInboundMessages: (query) => ipcRenderer.invoke('admin:inbound:list', query || {}),
  sendSms: (payload) => ipcRenderer.invoke('admin:sms:send', payload || {}),
  // Sales reports
  fetchSalesSummary: (query) => ipcRenderer.invoke('reports:sales:summary', query || {}),
  fetchSalesByDay: (query) => ipcRenderer.invoke('reports:sales:by-day', query || {}),
  fetchSalesByCategory: (query) => ipcRenderer.invoke('reports:sales:by-category', query || {}),
  fetchSalesByColor: (query) => ipcRenderer.invoke('reports:sales:by-color', query || {}),
  fetchSalesByCampaign: (query) => ipcRenderer.invoke('reports:sales:by-campaign', query || {}),
  fetchTopDesigns: (query) => ipcRenderer.invoke('reports:sales:top-designs', query || {})
  ,
  fetchCampaignPerformance: (query) => ipcRenderer.invoke('reports:campaigns', query || {})
  ,
  testInternalApi: () => ipcRenderer.invoke('internal:test')
  ,
  testLlm: () => ipcRenderer.invoke('llm:test')
  ,
  // Marketing/admin
  fetchAudienceMap: () => ipcRenderer.invoke('marketing:audience-map'),
  marketingClassify: (product) => ipcRenderer.invoke('marketing:classify', product || {}),
  marketingLaunch: (payload) => ipcRenderer.invoke('marketing:launch', payload || {}),
  marketingPreview: (payload) => ipcRenderer.invoke('marketing:preview', payload || {}),
  marketingLlmClassify: (payload) => ipcRenderer.invoke('marketing:llm:classify', payload || {}),
  fetchAdTemplates: () => ipcRenderer.invoke('marketing:ad-templates'),
  fetchAdsPerformance: (limit) => ipcRenderer.invoke('ads:performance:list', limit || 200),
  // Shopify test: carts webhook storage
  listShopifyTestCarts: () => ipcRenderer.invoke('shopify:test:carts:list'),
  clearShopifyTestCarts: () => ipcRenderer.invoke('shopify:test:carts:clear'),
  getCollectionMarketingProfile: (id) => ipcRenderer.invoke('shopify:collection:get', id),
  updateCollectionMarketingProfile: (id, profile) => ipcRenderer.invoke('shopify:collection:update', { id, profile }),
  listShopifyCollections: (query) => ipcRenderer.invoke('shopify:collections:list', query || {})
  ,
  // Campaign → Shopify export
  exportCampaignToShopify: (slug, only, force, skipMockups) => ipcRenderer.invoke('shopify:campaign:export', { slug, only, force, skipMockups })
  ,
  // Campaign → Shopify landing page
  createShopifyCampaignPage: (slug) => ipcRenderer.invoke('shopify:campaign:page', slug)
  ,
  // Campaign → Shopify refresh descriptions
  refreshShopifyCampaignDescriptions: (slug) => ipcRenderer.invoke('shopify:campaign:refresh-descriptions', slug)
  ,
  // Export job status
  getShopifyExportStatus: (slug) => ipcRenderer.invoke('shopify:campaign:export:status', slug)
  ,
  cancelShopifyExport: (slug) => ipcRenderer.invoke('shopify:campaign:export:cancel', slug)
  ,
  // Promo/discount stats
  getPromoStats: (discountId) => ipcRenderer.invoke('shopify:promo:stats', discountId)
  ,
  // Pricing sheet
  getPricing: () => ipcRenderer.invoke('pricing:get')
  ,
  savePricing: (pricing) => ipcRenderer.invoke('pricing:save', pricing)
  ,
  // POD fulfillment
  fulfillPod: (payload) => ipcRenderer.invoke('pod:fulfill', payload || {})
  ,
  // Guided mockup composition
  composeMockup: (payload) => ipcRenderer.invoke('mockup:compose', payload || {})
  ,
  // Vectorize an image (convert raster to SVG)
  vectorizeImage: (imagePath) => ipcRenderer.invoke('image:vectorize', imagePath)
  ,
  // Remove background from an image
  removeImageBackground: (payload) => ipcRenderer.invoke('image:removeBackground', payload || {})
  ,
  // Save a data URL to a temp image file
  saveTempImage: (payload) => ipcRenderer.invoke('image:saveTemp', payload || {})
  ,
  // Image tools preflight
  imageToolsPreflight: () => ipcRenderer.invoke('image:preflight')
  ,
  // Facebook AI
  generateFacebookAds: (payload) => ipcRenderer.invoke('facebook-ai:generate', payload || {})
  ,
  optimizeFacebookShop: (payload) => ipcRenderer.invoke('facebook-shop:optimize', payload || {})
  ,
  // Social Marketing - Facebook Posts
  generateFacebookPost: (payload) => ipcRenderer.invoke('social:fb:generate', payload || {}),
  publishFacebookPost: (payload) => ipcRenderer.invoke('social:fb:publish', payload || {}),
  scheduleFacebookPost: (payload) => ipcRenderer.invoke('social:fb:schedule', payload || {}),
  createCollageImage: (payload) => ipcRenderer.invoke('social:collage:create', payload || {}),
  listScheduledPosts: () => ipcRenderer.invoke('social:fb:scheduled:list'),
  cancelScheduledPost: (id) => ipcRenderer.invoke('social:fb:scheduled:cancel', id),

  // Inventory Input (AI-powered rapid product entry)
  inventoryInput: {
    snapshot: (cameraId) => ipcRenderer.invoke('inventory:snapshot', cameraId),
    analyze: (payload) => ipcRenderer.invoke('inventory:analyze', payload || {}),
    matchDesign: (payload) => ipcRenderer.invoke('inventory:matchDesign', payload || {}),
    pricing: (params) => ipcRenderer.invoke('inventory:pricing', params || {}),
    categories: () => ipcRenderer.invoke('inventory:input:categories'),
    saveCategory: (payload) => ipcRenderer.invoke('inventory:input:categories:save', payload || {}),
    saveProduct: (payload) => ipcRenderer.invoke('inventory:input:saveProduct', payload || {}),
    startPreview: (cameraId) => ipcRenderer.invoke('inventory:preview:start', cameraId),
    stopPreview: (cameraId) => ipcRenderer.invoke('inventory:preview:stop', cameraId),
    onPreviewFrame: (cb) => {
      if (typeof cb !== 'function') return () => {};
      const handler = (_e, data) => cb(data || {});
      ipcRenderer.on('inventory:preview:frame', handler);
      return () => ipcRenderer.off('inventory:preview:frame', handler);
    },
  },

  // Social Marketing - TikTok Posts
  tiktok: {
    getAuthUrl: () => ipcRenderer.invoke('social:tiktok:authUrl'),
    getStatus: () => ipcRenderer.invoke('social:tiktok:status'),
    getUserInfo: () => ipcRenderer.invoke('social:tiktok:userInfo'),
    uploadVideo: (payload) => ipcRenderer.invoke('social:tiktok:upload', payload || {}),
    uploadVideoFromUrl: (payload) => ipcRenderer.invoke('social:tiktok:uploadFromUrl', payload || {}),
    getPublishStatus: (publishId) => ipcRenderer.invoke('social:tiktok:publishStatus', publishId),
    generateCaption: (payload) => ipcRenderer.invoke('social:tiktok:generateCaption', payload || {}),
    disconnect: () => ipcRenderer.invoke('social:tiktok:disconnect')
  },

  // ============================================================================
  // TIKTOK MARKETING DASHBOARD
  // ============================================================================
  tiktokDash: {
    // Generated videos (from assembler)
    listVideos: (query) => ipcRenderer.invoke('tiktok-dash:videos', query || {}),
    listTemplates: () => ipcRenderer.invoke('tiktok-dash:templates'),
    assembleVideo: (payload) => ipcRenderer.invoke('tiktok-dash:assemble', payload || {}),
    deleteVideo: (filename) => ipcRenderer.invoke('tiktok-dash:deleteVideo', filename),
    getVideoUrl: (filename) => ipcRenderer.invoke('tiktok-dash:videoUrl', filename),
    // Managed video tracking (approval workflow)
    managed: {
      list: (filters) => ipcRenderer.invoke('tiktok-dash:managed:list', filters || {}),
      stats: () => ipcRenderer.invoke('tiktok-dash:managed:stats'),
      create: (data) => ipcRenderer.invoke('tiktok-dash:managed:create', data || {}),
      update: (id, updates) => ipcRenderer.invoke('tiktok-dash:managed:update', { id, updates }),
      delete: (id) => ipcRenderer.invoke('tiktok-dash:managed:delete', id)
    },
    // Pipeline
    getCatalog: () => ipcRenderer.invoke('tiktok-dash:catalog'),
    runPipeline: (payload) => ipcRenderer.invoke('tiktok-dash:pipeline:run', payload || {}),
    getManifests: () => ipcRenderer.invoke('tiktok-dash:pipeline:manifests')
  },

  // ============================================================================
  // PIPELINE (campaign-linked pipeline execution)
  // ============================================================================
  pipeline: {
    run: (payload) => ipcRenderer.invoke('pipeline:run', payload || {}),
    getStatus: (runId) => ipcRenderer.invoke('pipeline:status', runId),
    listRuns: (campaignSlug) => ipcRenderer.invoke('pipeline:list-runs', campaignSlug),
    approveReel: (videoId) => ipcRenderer.invoke('pipeline:approve-reel', videoId)
  },

  // ============================================================================
  // PRINTER API
  // ============================================================================
  printer: {
    getPrinters: () => ipcRenderer.invoke('print:getPrinters'),
    getDefaultPrinter: () => ipcRenderer.invoke('print:getDefault'),
    print: (options) => ipcRenderer.invoke('print:print', options),
    printWithDialog: (options) => ipcRenderer.invoke('print:printWithDialog', options),
    printToPdf: (options) => ipcRenderer.invoke('print:toPdf', options),
    selectFile: () => ipcRenderer.invoke('print:selectFile'),
    savePdfDialog: () => ipcRenderer.invoke('print:savePdfDialog')
  },

  // ============================================================================
  // AUTO-UPDATE API
  // ============================================================================
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    getStatus: () => ipcRenderer.invoke('update:getStatus'),
    getVersion: () => ipcRenderer.invoke('update:getVersion'),
    onStatusChange: (callback) => {
      const handler = (_event, status) => callback(status);
      ipcRenderer.on('update:status', handler);
      return () => ipcRenderer.off('update:status', handler);
    }
  },

  // ============================================================================
  // FACEBOOK SCHEDULE MANAGER API (Server-based campaign scheduling)
  // ============================================================================
  listMockupTemplates: () => ipcRenderer.invoke('fb-schedule:list-templates'),
  createMockupTemplate: (template) => ipcRenderer.invoke('fb-schedule:create-template', template),
  listFbScheduledPosts: () => ipcRenderer.invoke('fb-schedule:list-posts'),
  scheduleCampaignPosts: (options) => ipcRenderer.invoke('fb-schedule:schedule-campaign', options),
  processPendingPosts: () => ipcRenderer.invoke('fb-schedule:process-pending'),
  postScheduledNow: (postId) => ipcRenderer.invoke('fb-schedule:post-now', postId),
  deleteFbScheduledPost: (postId) => ipcRenderer.invoke('fb-schedule:delete-post', postId),
  retryScheduledPost: (postId) => ipcRenderer.invoke('fb-schedule:retry-post', postId),

  // Facebook Insights API
  getFbPostInsights: (facebookPostId) => ipcRenderer.invoke('fb-insights:get-post', facebookPostId),
  getFbScheduledPostsInsights: (options) => ipcRenderer.invoke('fb-insights:get-all', options || {}),
  getFbInsightsSummary: (options) => ipcRenderer.invoke('fb-insights:get-summary', options || {}),

  // ============================================================================
  // CUSTOM ART API
  // ============================================================================

  // Custom Art - Rooms
  customArt: {
    // Rooms
    listRooms: (query) => ipcRenderer.invoke('custom-art:rooms:list', query || {}),
    getRoom: (id) => ipcRenderer.invoke('custom-art:rooms:get', id),
    createRoom: (payload) => ipcRenderer.invoke('custom-art:rooms:create', payload || {}),
    updateRoom: (id, payload) => ipcRenderer.invoke('custom-art:rooms:update', { id, payload }),
    deleteRoom: (id) => ipcRenderer.invoke('custom-art:rooms:delete', id),
    generateRoomMetadata: (imagePath) => ipcRenderer.invoke('custom-art:rooms:ai-metadata', imagePath),

    // Artwork
    listArtwork: (query) => ipcRenderer.invoke('custom-art:artwork:list', query || {}),
    getArtworkCategories: () => ipcRenderer.invoke('custom-art:artwork:categories'),
    getArtwork: (id) => ipcRenderer.invoke('custom-art:artwork:get', id),
    createArtwork: (payload) => ipcRenderer.invoke('custom-art:artwork:create', payload || {}),
    updateArtwork: (id, payload) => ipcRenderer.invoke('custom-art:artwork:update', { id, payload }),
    deleteArtwork: (id) => ipcRenderer.invoke('custom-art:artwork:delete', id),
    generateAIMetadata: (id) => ipcRenderer.invoke('custom-art:artwork:ai-metadata', id),

    // Materials
    listMaterials: (query) => ipcRenderer.invoke('custom-art:materials:list', query || {}),
    getMaterial: (id) => ipcRenderer.invoke('custom-art:materials:get', id),
    createMaterial: (payload) => ipcRenderer.invoke('custom-art:materials:create', payload || {}),
    updateMaterial: (id, payload) => ipcRenderer.invoke('custom-art:materials:update', { id, payload }),
    deleteMaterial: (id) => ipcRenderer.invoke('custom-art:materials:delete', id),

    // Products
    listProducts: (query) => ipcRenderer.invoke('custom-art:products:list', query || {}),
    getProduct: (id) => ipcRenderer.invoke('custom-art:products:get', id),
    createProduct: (payload) => ipcRenderer.invoke('custom-art:products:create', payload || {}),
    updateProduct: (id, payload) => ipcRenderer.invoke('custom-art:products:update', { id, payload }),
    deleteProduct: (id) => ipcRenderer.invoke('custom-art:products:delete', id),

    // Product Variants
    listVariants: (productId) => ipcRenderer.invoke('custom-art:variants:list', productId),
    createVariant: (productId, payload) => ipcRenderer.invoke('custom-art:variants:create', { productId, payload }),
    updateVariant: (id, payload) => ipcRenderer.invoke('custom-art:variants:update', { id, payload }),
    deleteVariant: (id) => ipcRenderer.invoke('custom-art:variants:delete', id),

    // Mockups CRUD (full management)
    listMockups: (query) => ipcRenderer.invoke('custom-art:mockups:list', query || {}),
    getMockup: (id) => ipcRenderer.invoke('custom-art:mockups:get', id),
    createMockup: (payload) => ipcRenderer.invoke('custom-art:mockups:create', payload || {}),
    updateMockup: (id, payload) => ipcRenderer.invoke('custom-art:mockups:update', { id, payload }),
    deleteMockup: (id, hard) => ipcRenderer.invoke('custom-art:mockups:delete', { id, hard: !!hard }),

    // File operations
    selectFile: (options) => ipcRenderer.invoke('custom-art:select-file', options || {}),
    selectFiles: (options) => ipcRenderer.invoke('custom-art:select-files', options || {}),
    scanFolder: (directory) => ipcRenderer.invoke('custom-art:scan-folder', directory),
    uploadFile: (filePath, type) => ipcRenderer.invoke('custom-art:upload', { filePath, type }),
    extractZip: (zipPath) => ipcRenderer.invoke('custom-art:extract-zip', zipPath),

    // Mockup save
    saveMockup: (payload) => ipcRenderer.invoke('custom-art:mockup:save', payload || {}),

    // Tiled artwork save (for wall tiling patterns)
    saveTiledArtwork: (payload) => ipcRenderer.invoke('custom-art:tiled-artwork:save', payload || {}),

    // Generate tiles (split artwork into panels)
    generateTiles: (payload) => ipcRenderer.invoke('custom-art:tiles:generate', payload || {}),

    // Split artwork into grid tiles (for mockup modal)
    splitArtwork: (payload) => ipcRenderer.invoke('custom-art:split-artwork', payload || {}),

    // Shopify export
    exportToShopify: (payload) => ipcRenderer.invoke('custom-art:shopify:export', payload || {}),

    // Metal print sublimation filter
    applyMetalPrintFilter: (payload) => ipcRenderer.invoke('metal-print:apply-filter', payload || {}),

    // Sublimation print preparation (mirror + bleed + resize)
    prepareSublimation: (payload) => ipcRenderer.invoke('custom-art:prepare-sublimation', payload || {}),

    // Batch generate thumbnails for all artwork missing them
    generateThumbnails: () => ipcRenderer.invoke('custom-art:generate-thumbnails')
  },

  // Campaign API (for campaign mockups and other campaign-specific operations)
  campaign: {
    saveCampaignMockup: (payload) => ipcRenderer.invoke('campaign:save-mockup', payload || {})
  },

  // Metal Print Campaign API
  metalPrint: {
    applyFilter: (payload) => ipcRenderer.invoke('metal-print:apply-filter', payload || {}),
    exportCampaign: (payload) => ipcRenderer.invoke('metal-print:export-campaign', payload || {}),
    getExportStatus: (slug) => ipcRenderer.invoke('metal-print:export-status', slug || '')
  },

  // Sticker Sheets API
  stickerSheets: {
    getCategories: () => ipcRenderer.invoke('sticker-sheets:categories'),
    getCatalog: (category) => ipcRenderer.invoke('sticker-sheets:catalog', { category }),
    getGridInfo: (stickerSizeInches) => ipcRenderer.invoke('sticker-sheets:grid-info', { stickerSizeInches }),
    generate: (payload) => ipcRenderer.invoke('sticker-sheets:generate', payload || {}),
    generateFromLayout: (layoutData) => ipcRenderer.invoke('sticker-sheets:generate-from-layout', layoutData || {}),
    fromOrder: (payload) => ipcRenderer.invoke('sticker-sheets:from-order', payload || {}),
    list: () => ipcRenderer.invoke('sticker-sheets:list'),
    // New methods for order-based storage
    listSavedOrders: () => ipcRenderer.invoke('sticker-sheets:list-saved-orders'),
    getOrderSheets: (orderNumber) => ipcRenderer.invoke('sticker-sheets:get-order-sheets', { orderNumber }),
    sendToCameo: (payload) => ipcRenderer.invoke('sticker-sheets:send-to-cameo', payload || {}),
    // Lazy contour generation
    getContour: (imagePath, options) => ipcRenderer.invoke('sticker-sheets:get-contour', { imagePath, ...(options || {}) }),
    // AI-powered sticker sheet generation
    aiGenerate: (payload) => ipcRenderer.invoke('sticker-sheets:ai-generate', payload || {}),
    // Delete a batch
    deleteBatch: (batchName) => ipcRenderer.invoke('sticker-sheets:delete-batch', { batchName })
  },

  // Vinyl Cutter API
  vinylCutter: {
    vectorize: (imagePath, options) => ipcRenderer.invoke('vinyl-cutter:vectorize', { imagePath, ...(options || {}) }),
    generate: (data) => ipcRenderer.invoke('vinyl-cutter:generate', data || {}),
    list: () => ipcRenderer.invoke('vinyl-cutter:list'),
    delete: (batchName) => ipcRenderer.invoke('vinyl-cutter:delete', { batchName }),
    sendToSilhouette: (payload) => ipcRenderer.invoke('vinyl-cutter:send-to-silhouette', payload || {}),
    generateDriverNames: (data) => ipcRenderer.invoke('vinyl-cutter:driver-names', data || {}),
    // AI-powered methods
    aiContour: (imagePath, options) => ipcRenderer.invoke('vinyl-cutter:ai-contour', { imagePath, ...(options || {}) }),
    aiColorSeparate: (imagePath, options) => ipcRenderer.invoke('vinyl-cutter:ai-color-separate', { imagePath, ...(options || {}) }),
    aiGenerate: (data) => ipcRenderer.invoke('vinyl-cutter:ai-generate', data || {})
  },

  // Silhouette Cameo API (local cutting via sendto_silhouette.py)
  cameo: {
    openCutFile: (options) => ipcRenderer.invoke('cameo:open-cut-file', options || {}),
    getScriptPath: () => ipcRenderer.invoke('cameo:get-script-path')
  },

  // Studio3 Parser API (for .studio3 file import)
  studio3: {
    // Parse a complete .studio3 file - returns images, paths, metadata, svg
    parse: (filepath) => ipcRenderer.invoke('studio3:parse', filepath),
    // Extract just the embedded PNG images
    extractImages: (filepath) => ipcRenderer.invoke('studio3:extractImages', filepath),
    // Extract just the cut paths as coordinate arrays
    extractPaths: (filepath) => ipcRenderer.invoke('studio3:extractPaths', filepath),
    // Convert cut paths to SVG string
    toSvg: (filepath, options) => ipcRenderer.invoke('studio3:toSvg', filepath, options || {}),
    // Save extracted images to a directory
    saveImages: (filepath, outputDir) => ipcRenderer.invoke('studio3:saveImages', filepath, outputDir),
    // Open file browser for .studio3 files
    browse: () => ipcRenderer.invoke('studio3:browse'),
    // Batch parse multiple files (for catalog building)
    batchParse: (filepaths) => ipcRenderer.invoke('studio3:batchParse', filepaths)
  },

  // Google Drive Sync API
  gdrive: {
    list: (folder) => ipcRenderer.invoke('gdrive:list', folder),
    syncCustomArt: (fileIds) => ipcRenderer.invoke('gdrive:sync-custom-art', fileIds),
    syncCatalog: (items) => ipcRenderer.invoke('gdrive:sync-catalog', items),
    syncMockups: (filenames) => ipcRenderer.invoke('gdrive:sync-mockups', filenames),
    syncRooms: (filenames) => ipcRenderer.invoke('gdrive:sync-rooms', filenames),
    sync: (files) => ipcRenderer.invoke('gdrive:sync', files),
    // Pull (reverse sync) methods
    pullCollection: (categories) => ipcRenderer.invoke('gdrive:pull-collection', categories),
    pullCustomArt: () => ipcRenderer.invoke('gdrive:pull-custom-art'),
    pullMockups: () => ipcRenderer.invoke('gdrive:pull-mockups'),
    pullRooms: () => ipcRenderer.invoke('gdrive:pull-rooms')
  },

  // Human Models API
  humanModels: {
    list: (query) => ipcRenderer.invoke('human-models:list', query || {}),
    getCategories: () => ipcRenderer.invoke('human-models:categories'),
    get: (id) => ipcRenderer.invoke('human-models:get', id),
    create: (payload) => ipcRenderer.invoke('human-models:create', payload || {}),
    update: (id, payload) => ipcRenderer.invoke('human-models:update', { id, payload }),
    delete: (id) => ipcRenderer.invoke('human-models:delete', id),
    selectFile: (options) => ipcRenderer.invoke('human-models:select-file', options || {}),
    selectFiles: (options) => ipcRenderer.invoke('human-models:select-files', options || {}),
    uploadFile: (filePath) => ipcRenderer.invoke('human-models:upload', { filePath }),
    extractZip: (zipPath) => ipcRenderer.invoke('human-models:extract-zip', zipPath),
    analyzeMetadata: (modelId) => ipcRenderer.invoke('human-models:analyze-metadata', modelId),
    // AI-powered garment recoloring
    recolor: (modelId, color, garmentType, force) => ipcRenderer.invoke('human-models:recolor', { modelId, color, garmentType, force }),
    listColorVariants: (modelId) => ipcRenderer.invoke('human-models:color-variants', modelId)
  },

  // Model Groups API
  modelGroups: {
    list: () => ipcRenderer.invoke('model-groups:list'),
    get: (id) => ipcRenderer.invoke('model-groups:get', id),
    create: (payload) => ipcRenderer.invoke('model-groups:create', payload),
    update: (id, payload) => ipcRenderer.invoke('model-groups:update', { id, payload }),
    delete: (id) => ipcRenderer.invoke('model-groups:delete', id),
    addModels: (groupId, modelIds) => ipcRenderer.invoke('model-groups:add-models', { groupId, modelIds }),
    removeModels: (groupId, modelIds) => ipcRenderer.invoke('model-groups:remove-models', { groupId, modelIds })
  },

  // Mockup Backgrounds API (for decal mockups)
  mockupBackgrounds: {
    list: (query) => ipcRenderer.invoke('mockup-backgrounds:list', query || {}),
    getCategories: () => ipcRenderer.invoke('mockup-backgrounds:categories'),
    get: (id) => ipcRenderer.invoke('mockup-backgrounds:get', id),
    create: (payload) => ipcRenderer.invoke('mockup-backgrounds:create', payload || {}),
    update: (id, payload) => ipcRenderer.invoke('mockup-backgrounds:update', { id, payload }),
    delete: (id) => ipcRenderer.invoke('mockup-backgrounds:delete', id),
    selectFile: (options) => ipcRenderer.invoke('mockup-backgrounds:select-file', options || {}),
    uploadFile: (filePath) => ipcRenderer.invoke('mockup-backgrounds:upload', { filePath })
  },

  // Dashboard APIs
  dashboard: {
    getStats: (period) => ipcRenderer.invoke('dashboard:stats', { period }),
    getServerStats: () => ipcRenderer.invoke('dashboard:server-stats'),
    getSocialStats: (period) => ipcRenderer.invoke('dashboard:social-stats', { period })
  },

  // AI Sales Agent APIs
  agent: {
    getStatus: () => ipcRenderer.invoke('agent:status'),
    getEngagementSummary: () => ipcRenderer.invoke('agent:engagement-summary'),
    getStrategy: () => ipcRenderer.invoke('agent:strategy'),
    getCategories: () => ipcRenderer.invoke('agent:categories'),
    updateCategory: (name, data) => ipcRenderer.invoke('agent:update-category', { name, data }),
    getCalendar: () => ipcRenderer.invoke('agent:calendar'),
    getDailyReport: () => ipcRenderer.invoke('agent:daily-report'),
    getApprovals: () => ipcRenderer.invoke('agent:approvals'),
    triggerRun: () => ipcRenderer.invoke('agent:run'),
  },

  // Shopify Manager APIs
  shopifyManager: {
    listProducts: (query) => ipcRenderer.invoke('shopify-manager:products:list', query || {}),
    getProduct: (id) => ipcRenderer.invoke('shopify-manager:products:get', id),
    updateProduct: (id, updates) => ipcRenderer.invoke('shopify-manager:products:update', { id, updates }),
    updateVariant: (id, updates) => ipcRenderer.invoke('shopify-manager:variants:update', { id, updates }),
    bulkUpdate: (payload) => ipcRenderer.invoke('shopify-manager:bulk:update', payload || {}),
    listCollections: () => ipcRenderer.invoke('shopify-manager:collections:list'),
    getCollectionProducts: (collectionId) => ipcRenderer.invoke('shopify-manager:collections:products', collectionId)
  },

  // Copy Generator APIs - AI-powered ad copy
  copyGenerator: {
    generateCampaignCopy: (campaign, options) => ipcRenderer.invoke('copy:campaign:generate', { campaign, options }),
    generateHeadlines: (campaign, count, options) => ipcRenderer.invoke('copy:headlines:generate', { campaign, count, options }),
    generateDescription: (product, options) => ipcRenderer.invoke('copy:description:generate', { product, options }),
    generateEmailSubjects: (campaign, count, options) => ipcRenderer.invoke('copy:email:generate', { campaign, count, options }),
    generateABTest: (originalCopy, element, count) => ipcRenderer.invoke('copy:abtest:generate', { originalCopy, element, count }),
    improveCopy: (existingCopy, options) => ipcRenderer.invoke('copy:improve', { existingCopy, options })
  },

  // Native confirm dialog (avoids focus issues with window.confirm in Electron)
  showConfirm: (message, title) => ipcRenderer.invoke('dialog:confirm', { message, title }),

  // Preview image caching (fetches and stores previews locally for faster loading)
  previewCache: {
    get: (url, forceRefresh) => ipcRenderer.invoke('preview:getCached', { url, forceRefresh }),
    batch: (urls) => ipcRenderer.invoke('preview:batchCache', { urls }),
    clear: () => ipcRenderer.invoke('preview:clearCache'),
    stats: () => ipcRenderer.invoke('preview:cacheStats')
  },

  // Multiboard Parts Browser — download events from webview
  multiboardBrowser: {
    onDownloadStart: (cb) => {
      const handler = (_e, data) => cb(data || {});
      ipcRenderer.on('multiboard:download-start', handler);
      return () => ipcRenderer.off('multiboard:download-start', handler);
    },
    onDownloadProgress: (cb) => {
      const handler = (_e, data) => cb(data || {});
      ipcRenderer.on('multiboard:download-progress', handler);
      return () => ipcRenderer.off('multiboard:download-progress', handler);
    },
    onDownloadComplete: (cb) => {
      const handler = (_e, data) => cb(data || {});
      ipcRenderer.on('multiboard:download-complete', handler);
      return () => ipcRenderer.off('multiboard:download-complete', handler);
    }
  },

  // ============================================================================
  // 3D PRINTER FLEET API
  // ============================================================================
  printerFleet: {
    // Printer CRUD
    listPrinters: (query) => ipcRenderer.invoke('fleet:printers:list', query || {}),
    getPrinter: (id) => ipcRenderer.invoke('fleet:printers:get', id),
    upsertPrinter: (printer) => ipcRenderer.invoke('fleet:printers:upsert', printer || {}),
    updatePrinter: (id, updates) => ipcRenderer.invoke('fleet:printers:update', { id, updates }),
    removePrinter: (id) => ipcRenderer.invoke('fleet:printers:remove', id),

    // Status
    getStatus: (id) => ipcRenderer.invoke('fleet:printers:status', id),
    getAllStatus: () => ipcRenderer.invoke('fleet:printers:statusAll'),
    reconnect: (id) => ipcRenderer.invoke('fleet:printers:reconnect', id),
    testConnection: (apiUrl) => ipcRenderer.invoke('fleet:printers:testConnection', apiUrl),
    getBuildVolume: (id) => ipcRenderer.invoke('fleet:printers:buildVolume', id),

    // Files
    selectGcodeFile: () => ipcRenderer.invoke('fleet:files:select'),
    uploadGcode: (printerId, filePath) => ipcRenderer.invoke('fleet:files:upload', { printerId, filePath }),
    listFiles: (printerId) => ipcRenderer.invoke('fleet:files:list', { printerId }),
    deleteFile: (printerId, filename) => ipcRenderer.invoke('fleet:files:delete', { printerId, filename }),

    // Webcam
    getWebcamUrls: (printerId) => ipcRenderer.invoke('fleet:webcam:urls', printerId),

    // Print control
    startPrint: (printerId, filename, shopifyOrderId) =>
      ipcRenderer.invoke('fleet:print:start', { printerId, filename, shopifyOrderId }),
    pausePrint: (printerId) => ipcRenderer.invoke('fleet:print:pause', { printerId }),
    resumePrint: (printerId) => ipcRenderer.invoke('fleet:print:resume', { printerId }),
    cancelPrint: (printerId) => ipcRenderer.invoke('fleet:print:cancel', { printerId }),
    emergencyStop: (printerId) => ipcRenderer.invoke('fleet:print:emergencyStop', { printerId }),
    sendGcode: (printerId, command) => ipcRenderer.invoke('fleet:gcode:send', { printerId, command }),

    // Jobs
    listJobs: (query) => ipcRenderer.invoke('fleet:jobs:list', query || {}),
    getActiveJobs: () => ipcRenderer.invoke('fleet:jobs:active'),
    getJobStats: () => ipcRenderer.invoke('fleet:jobs:stats'),
    clearStaleJobs: () => ipcRenderer.invoke('fleet:jobs:clearStale'),

    // Real-time status events
    onPrinterStatus: (cb) => {
      if (typeof cb !== 'function') return () => {};
      const handler = (_e, data) => cb(data || {});
      ipcRenderer.on('fleet:printer:status', handler);
      return () => ipcRenderer.off('fleet:printer:status', handler);
    }
  },

  // ============================================================================
  // INKJET PRINTER API (proxied to Pi print server)
  // ============================================================================
  inkjetFleet: {
    // Printer CRUD
    listPrinters: (query) => ipcRenderer.invoke('inkjet:printers:list', query || {}),
    getPrinter: (id) => ipcRenderer.invoke('inkjet:printers:get', id),
    addPrinter: (printer) => ipcRenderer.invoke('inkjet:printers:add', printer),
    updatePrinter: (id, updates) => ipcRenderer.invoke('inkjet:printers:update', { id, updates }),
    removePrinter: (id) => ipcRenderer.invoke('inkjet:printers:remove', id),

    // Status & Capabilities
    getCapabilities: (id) => ipcRenderer.invoke('inkjet:printers:capabilities', id),
    getInkLevels: (id) => ipcRenderer.invoke('inkjet:printers:inkLevels', id),
    getAllInkLevels: () => ipcRenderer.invoke('inkjet:printers:allInkLevels'),
    getStatus: () => ipcRenderer.invoke('inkjet:printers:status'),
    discover: () => ipcRenderer.invoke('inkjet:printers:discover'),

    // Jobs
    submitJob: (job) => ipcRenderer.invoke('inkjet:jobs:submit', job),
    listJobs: (query) => ipcRenderer.invoke('inkjet:jobs:list', query || {}),
    cancelJob: (id) => ipcRenderer.invoke('inkjet:jobs:cancel', id),
    getActiveJobs: () => ipcRenderer.invoke('inkjet:jobs:active'),
  },

  // Combined print server status
  printServerStatus: () => ipcRenderer.invoke('print-server:status'),

  // ============================================================================
  // 3D SLICER API (STL catalog, slicing, G-code cache)
  // ============================================================================
  slicer: {
    // Generic server API fetch (for print monitor, etc.)
    fetch: (endpoint, options) => ipcRenderer.invoke('server:apiFetch', endpoint, options || {}),

    // Presets (human-readable options)
    getPresets: () => ipcRenderer.invoke('slicer:presets'),

    // STL Catalog
    listCatalog: (query) => ipcRenderer.invoke('slicer:catalog:list', query || {}),
    getCategories: () => ipcRenderer.invoke('slicer:catalog:categories'),
    getCategoriesWithCounts: () => ipcRenderer.invoke('slicer:catalog:categories:counts'),
    mergeCategories: (from_categories, to_category) => ipcRenderer.invoke('slicer:catalog:categories:merge', { from_categories, to_category }),
    renameCategory: (old_name, new_name) => ipcRenderer.invoke('slicer:catalog:categories:rename', { old_name, new_name }),
    removeCategory: (category) => ipcRenderer.invoke('slicer:catalog:categories:remove', { category }),
    bulkSetCategory: (stl_ids, category) => ipcRenderer.invoke('slicer:catalog:bulk-category', { stl_ids, category }),
    listFolders: (category) => ipcRenderer.invoke('slicer:catalog:folders', category),
    bulkSetFolder: (stl_ids, folder) => ipcRenderer.invoke('slicer:catalog:bulk-folder', { stl_ids, folder }),
    renameFolder: (category, old_name, new_name) => ipcRenderer.invoke('slicer:catalog:folders:rename', { category, old_name, new_name }),
    removeFolder: (category, folder) => ipcRenderer.invoke('slicer:catalog:folders:remove', { category, folder }),
    toggleProduct: (id, is_product) => ipcRenderer.invoke('slicer:catalog:toggle-product', { id, is_product }),
    listProductItems: () => ipcRenderer.invoke('slicer:catalog:products'),
    createProductFromStl: (stl_id) => ipcRenderer.invoke('slicer:catalog:create-product', { stl_id }),
    bulkMove: (stl_ids, category, folder) => ipcRenderer.invoke('slicer:catalog:bulk-move', { stl_ids, category, folder }),
    getCatalogItem: (id) => ipcRenderer.invoke('slicer:catalog:get', id),
    getPartGuide: (id) => ipcRenderer.invoke('slicer:catalog:guide', id),
    uploadStl: (opts) => ipcRenderer.invoke('slicer:catalog:create', opts),
    updateCatalogItem: (id, updates) => ipcRenderer.invoke('slicer:catalog:update', { id, updates }),
    deleteCatalogItem: (id) => ipcRenderer.invoke('slicer:catalog:delete', id),
    parsePartInfo: (name, description) => ipcRenderer.invoke('slicer:catalog:parsePartInfo', { name, description }),
    fetchStlBytes: (stlId) => ipcRenderer.invoke('slicer:stl:fetch', stlId),

    // Mount Merger
    addMount: (opts) => ipcRenderer.invoke('slicer:stl:addMount', opts),

    // Slicing
    slice: (options) => ipcRenderer.invoke('slicer:slice', options),
    sliceAndPrint: (sliceOptions, printerId) => ipcRenderer.invoke('slicer:sliceAndPrint', { sliceOptions, printerId }),
    slicePlate: (options) => ipcRenderer.invoke('slicer:slicePlate', options),
    slicePlateAndPrint: (sliceOptions, printerId, opts) => ipcRenderer.invoke('slicer:slicePlateAndPrint', { sliceOptions, printerId, ...(opts || {}) }),
    printGcode: (gcodeId, printerId, opts) => ipcRenderer.invoke('slicer:printGcode', { gcodeId, printerId, ...(opts || {}) }),
    fetchGcodeText: (gcodeId) => ipcRenderer.invoke('slicer:gcode:fetchText', gcodeId),

    // Progress events from main process (step-by-step print progress)
    onPrintProgress: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('slicer:printProgress', handler);
      return () => ipcRenderer.removeListener('slicer:printProgress', handler);
    },

    // G-code cache
    getGcodeForStl: (stlId) => ipcRenderer.invoke('slicer:gcodeForStl', stlId),
    listCache: () => ipcRenderer.invoke('slicer:cache:list'),
    deleteCache: (id) => ipcRenderer.invoke('slicer:cache:delete', id),
    clearCache: () => ipcRenderer.invoke('slicer:cache:clear'),

    // File dialog
    selectStlFile: () => ipcRenderer.invoke('slicer:selectStlFile'),
    extractZip: (zipPath) => ipcRenderer.invoke('slicer:extractZip', zipPath),
    cleanupTemp: (dirPath) => ipcRenderer.invoke('slicer:cleanupTemp', dirPath),

    // 3MF import
    import3mf: (opts) => ipcRenderer.invoke('slicer:import3mf', opts),

    // Bulk import
    bulkScan: (directory) => ipcRenderer.invoke('slicer:stl:bulkScan', directory),
    bulkUploadOne: (opts) => ipcRenderer.invoke('slicer:stl:bulkUploadOne', opts),

    // STL thumbnail disk cache
    getThumbsCached: (stlIds) => ipcRenderer.invoke('slicer:thumb:batchGet', stlIds),
    saveThumbCache: (stlId, dataUrl) => ipcRenderer.invoke('slicer:thumb:save', { stlId, dataUrl }),
    deleteThumbCache: (stlId) => ipcRenderer.invoke('slicer:thumb:delete', stlId),
    clearThumbCache: () => ipcRenderer.invoke('slicer:thumb:clear'),

    // Saved Build Plates
    listPlates: () => ipcRenderer.invoke('slicer:plates:list'),
    getPlate: (id) => ipcRenderer.invoke('slicer:plates:get', id),
    createPlate: (data) => ipcRenderer.invoke('slicer:plates:create', data),
    updatePlate: (id, updates) => ipcRenderer.invoke('slicer:plates:update', { id, updates }),
    deletePlate: (id) => ipcRenderer.invoke('slicer:plates:delete', id),

    // Product Build Plates (pre-configured from product kits)
    listProductPlates: (productId) => ipcRenderer.invoke('slicer:product-plates:list', productId),
    createProductPlate: (data) => ipcRenderer.invoke('slicer:product-plates:create', data),
    updateProductPlate: (id, updates) => ipcRenderer.invoke('slicer:product-plates:update', { id, updates }),
    deleteProductPlate: (id) => ipcRenderer.invoke('slicer:product-plates:delete', id),

    // Thangs Parts Sync
    thangsStatus: () => ipcRenderer.invoke('slicer:thangs-sync:status'),
    thangsMissing: (opts) => ipcRenderer.invoke('slicer:thangs-sync:missing', opts),
    thangsRunSync: () => ipcRenderer.invoke('slicer:thangs-sync:run'),
    thangsImport: (models) => ipcRenderer.invoke('slicer:thangs-sync:import', models),
    thangsSkip: (modelId) => ipcRenderer.invoke('slicer:thangs-sync:skip', modelId),
    thangsMatch: (modelId, catalogId) => ipcRenderer.invoke('slicer:thangs-sync:match', { modelId, catalogId })
  },

  // ============================================================================
  // DOG TAG GENERATOR API (BRCC Custom Pet Dog Tags)
  // ============================================================================
  dogTag: {
    generate: (payload) => ipcRenderer.invoke('dog-tag:generate', payload || {}),
    getShapes: () => ipcRenderer.invoke('dog-tag:shapes'),
    getQueue: () => ipcRenderer.invoke('dog-tag:queue'),
    getHistory: () => ipcRenderer.invoke('dog-tag:history'),
    openOutput: (jobId) => ipcRenderer.invoke('dog-tag:openOutput', jobId),
    checkOpenscad: () => ipcRenderer.invoke('dog-tag:openscad-check'),
    sendToSlicer: (payload) => ipcRenderer.invoke('dog-tag:send-to-slicer', payload || {}),
    // Batch queue
    batchList: () => ipcRenderer.invoke('dog-tag:batch:list'),
    batchAdd: (item) => ipcRenderer.invoke('dog-tag:batch:add', item || {}),
    batchRemove: (id) => ipcRenderer.invoke('dog-tag:batch:remove', id),
    batchClear: () => ipcRenderer.invoke('dog-tag:batch:clear'),
    batchGenerateAll: () => ipcRenderer.invoke('dog-tag:batch:generate-all'),
    // v2: Blank STL management
    openTagsFolder: () => ipcRenderer.invoke('dog-tag:open-tags-folder'),
    importBlank: (shapeId) => ipcRenderer.invoke('dog-tag:import-blank', shapeId),
    loadBlankStl: (shapeId) => ipcRenderer.invoke('dog-tag:load-blank-stl', shapeId),
    deleteShape: (shapeId) => ipcRenderer.invoke('dog-tag:shapes:delete', shapeId),
    updateShape: (shapeId, updates) => ipcRenderer.invoke('dog-tag:shapes:update', { shapeId, updates }),
  },

  // ============================================================================
  // FOOTAGE LIBRARY & CAMERA RECORDING API
  // ============================================================================
  footage: {
    // Clips CRUD (proxied to server)
    listClips: (filters) => ipcRenderer.invoke('footage:clips:list', filters || {}),
    getClip: (id) => ipcRenderer.invoke('footage:clips:get', id),
    updateClip: (id, data) => ipcRenderer.invoke('footage:clips:update', { id, data }),
    deleteClip: (id) => ipcRenderer.invoke('footage:clips:delete', id),
    getStats: () => ipcRenderer.invoke('footage:stats'),
    getCategories: () => ipcRenderer.invoke('footage:categories'),
    getProducts: () => ipcRenderer.invoke('footage:products'),
    upload: (filePath, meta) => ipcRenderer.invoke('footage:upload', { filePath, meta }),
    getFileUrl: (filename) => ipcRenderer.invoke('footage:fileUrl', filename),
    getThumbUrl: (filename) => ipcRenderer.invoke('footage:thumbUrl', filename),

    // Camera management
    listCameras: () => ipcRenderer.invoke('footage:cameras:list'),
    addCamera: (config) => ipcRenderer.invoke('footage:cameras:add', config || {}),
    updateCamera: (id, data) => ipcRenderer.invoke('footage:cameras:update', { id, data }),
    removeCamera: (id) => ipcRenderer.invoke('footage:cameras:remove', id),
    testCamera: (config) => ipcRenderer.invoke('footage:cameras:test', config || {}),
    discoverCamera: (config) => ipcRenderer.invoke('footage:cameras:discover', config || {}),

    // Recording (segmented, auto-reconnect)
    startRecording: (cameraId, outputDir, stream) =>
      ipcRenderer.invoke('footage:record:start', { cameraId, outputDir, stream }),
    stopRecording: (cameraId) => ipcRenderer.invoke('footage:record:stop', cameraId),
    getRecordingStatus: () => ipcRenderer.invoke('footage:record:status'),
    getCameraRecordingStatus: (cameraId) => ipcRenderer.invoke('footage:record:cameraStatus', cameraId),

    // Live preview
    startPreview: (cameraId) => ipcRenderer.invoke('footage:preview:start', cameraId),
    stopPreview: (cameraId) => ipcRenderer.invoke('footage:preview:stop', cameraId),
    onPreviewFrame: (cb) => {
      if (typeof cb !== 'function') return () => {};
      const handler = (_e, data) => cb(data || {});
      ipcRenderer.on('footage:preview:frame', handler);
      return () => ipcRenderer.off('footage:preview:frame', handler);
    },

    // Recording progress (elapsed time ticks)
    onRecordingTick: (cb) => {
      if (typeof cb !== 'function') return () => {};
      const handler = (_e, data) => cb(data || {});
      ipcRenderer.on('footage:record:tick', handler);
      return () => ipcRenderer.off('footage:record:tick', handler);
    },

    // Recorder events: recording-started, recording-stopped, reconnecting, error, segment-complete
    onEvent: (eventName, cb) => {
      if (typeof cb !== 'function') return () => {};
      const channel = `footage:event:${eventName}`;
      const handler = (_e, data) => cb(data || {});
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.off(channel, handler);
    },

    // Pi Camera remote operations
    pi: {
      status: (cameraId) => ipcRenderer.invoke('footage:pi:status', cameraId),
      recordings: (cameraId) => ipcRenderer.invoke('footage:pi:recordings', cameraId),
      pull: (cameraId, filename) => ipcRenderer.invoke('footage:pi:pull', { cameraId, filename }),
      pullAndUpload: (cameraId, filename, meta) =>
        ipcRenderer.invoke('footage:pi:pull-and-upload', { cameraId, filename, meta }),
      delete: (cameraId, filename) => ipcRenderer.invoke('footage:pi:delete', { cameraId, filename }),
      onPullProgress: (cb) => {
        if (typeof cb !== 'function') return () => {};
        const handler = (_e, data) => cb(data || {});
        ipcRenderer.on('footage:pi:pull-progress', handler);
        return () => ipcRenderer.off('footage:pi:pull-progress', handler);
      }
    },

    // Preflight checks
    checkFfmpeg: () => ipcRenderer.invoke('footage:ffmpeg:check'),
    checkPython: () => ipcRenderer.invoke('footage:python:check'),

    // Select a video file via native dialog
    selectVideoFile: () => ipcRenderer.invoke('footage:selectVideoFile')
  },

  printQuotes: {
    list:         (query)                         => ipcRenderer.invoke('pq:list', query),
    get:          (id)                            => ipcRenderer.invoke('pq:get', id),
    create:       (data)                          => ipcRenderer.invoke('pq:create', data),
    update:       (id, updates)                   => ipcRenderer.invoke('pq:update', { id, updates }),
    delete:       (id)                            => ipcRenderer.invoke('pq:delete', id),
    replaceItems: (quoteId, items)                => ipcRenderer.invoke('pq:items:replace', { quoteId, items }),
    packPlates:   (quoteId, printerModel)         => ipcRenderer.invoke('pq:plates:pack', { quoteId, printerModel }),
    listPlates:   (quoteId)                       => ipcRenderer.invoke('pq:plates:list', quoteId),
    updatePlate:  (quoteId, plateId, updates)     => ipcRenderer.invoke('pq:plates:update', { quoteId, plateId, updates })
  }
});
