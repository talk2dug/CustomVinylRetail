/**
 * Print Station Web API Adapter
 * Replaces Electron IPC with direct HTTP fetch calls
 * Provides the same interface as the Electron preload.js
 */

// Configuration - matches the Electron app's config structure
const config = {
  serverBaseUrl: localStorage.getItem('ps_serverBaseUrl') || 'https://blueridgecustomco.com',
  apiKey: localStorage.getItem('ps_apiKey') || '',
  // Aliases for compatibility
  get serverUrl() { return this.serverBaseUrl; }
};

// Helper to build URLs
function buildUrl(path) {
  const base = config.serverBaseUrl.replace(/\/$/, '');
  return `${base}${path}`;
}

// Generic API request helper
async function apiRequest(path, options = {}) {
  const url = buildUrl(path);
  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    ...(config.apiKey ? { 'X-API-Key': config.apiKey } : {}),
    ...(options.headers || {})
  };

  const fetchOptions = {
    method: options.method || 'GET',
    headers,
    ...(options.body ? { body: JSON.stringify(options.body) } : {})
  };

  try {
    const response = await fetch(url, fetchOptions);
    const contentType = response.headers.get('content-type') || '';

    let data;
    if (contentType.includes('application/json')) {
      data = await response.json();
    } else {
      data = await response.text();
    }

    if (!response.ok) {
      const error = new Error(data?.error || data?.message || `HTTP ${response.status}`);
      error.status = response.status;
      error.data = data;
      throw error;
    }

    return data;
  } catch (err) {
    console.error(`[API] ${options.method || 'GET'} ${path} failed:`, err.message);
    throw err;
  }
}

// Printstation API - mirrors Electron preload interface
window.printStation = {
  // ============================================================================
  // ELECTRON DIALOG REPLACEMENTS (Web versions)
  // ============================================================================
  showConfirm: (message, title) => {
    return Promise.resolve(window.confirm(message));
  },

  showAlert: (message, title) => {
    window.alert(message);
    return Promise.resolve();
  },

  showError: (message, title) => {
    window.alert(`Error: ${message}`);
    return Promise.resolve();
  },

  selectFolder: (options) => {
    // Web can't select folders easily, return empty
    console.warn('[API] selectFolder not available in web version');
    return Promise.resolve([]);
  },

  selectFiles: (options) => {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      if (options?.filters?.[0]?.extensions) {
        input.accept = options.filters[0].extensions.map(e => `.${e}`).join(',');
      }
      input.onchange = (e) => {
        const files = Array.from(e.target.files);
        resolve(files.length > 0 ? files.map(f => f.name) : []);
      };
      input.click();
    });
  },

  // ============================================================================
  // STUB METHODS (features not fully ported to web yet)
  // ============================================================================
  getPricing: () => apiRequest('/api/pricing').catch(() => ({ pricing: {} })),
  savePricing: (data) => apiRequest('/api/pricing', { method: 'POST', body: data }),
  listShopifyTestCarts: () => apiRequest('/api/shopify/test-carts').catch(() => ({ carts: [] })),
  fetchAudienceMap: () => apiRequest('/api/marketing/audience-map').catch(() => ({})),
  marketingClassify: (data) => apiRequest('/api/marketing/classify', { method: 'POST', body: data }),
  marketingLaunch: (data) => apiRequest('/api/marketing/launch', { method: 'POST', body: data }),
  fetchAdTemplates: () => apiRequest('/api/marketing/templates').catch(() => ({ templates: [] })),
  marketingPreview: (data) => apiRequest('/api/marketing/preview', { method: 'POST', body: data }),
  marketingLlmClassify: (data) => apiRequest('/api/marketing/llm-classify', { method: 'POST', body: data }),
  getCollectionMarketingProfile: (id) => apiRequest(`/api/marketing/collections/${id}/profile`),
  updateCollectionMarketingProfile: (id, data) => apiRequest(`/api/marketing/collections/${id}/profile`, { method: 'PATCH', body: data }),
  fetchAdsPerformance: (limit) => apiRequest(`/api/marketing/ads-performance?limit=${limit || 100}`).catch(() => ({ ads: [] })),
  listShopifyCollections: (query) => apiRequest(`/api/shopify/collections${query ? '?' + new URLSearchParams(query) : ''}`),

  // Local catalog
  listLocalCategories: () => apiRequest('/api/local/categories').catch(() => []),
  listLocal: (query) => apiRequest(`/api/local${query ? '?' + new URLSearchParams(query) : ''}`).catch(() => []),
  scanLocal: (data) => Promise.resolve({ items: [], message: 'Folder scanning not available in web version' }),
  importLocal: (data) => apiRequest('/api/local/import', { method: 'POST', body: data }),
  publishLocal: (ids) => apiRequest('/api/local/publish', { method: 'POST', body: { ids } }),

  // Apparel types
  getApparelTypes: () => Promise.resolve(JSON.parse(localStorage.getItem('apparelTypes') || '[]')),
  saveApparelTypes: (types) => {
    localStorage.setItem('apparelTypes', JSON.stringify(types));
    return Promise.resolve({ success: true });
  },

  // Apparel categories - used by loadApparelCategories()
  fetchApparelCategories: () => apiRequest('/api/apparel/categories').catch(() => ({ categories: [] })),

  // SSAW Config - used by initCuratorState()
  fetchSsawConfig: () => apiRequest('/api/ssaw/config').catch(() => ({
    defaultCategory: 'general',
    categories: [],
    aspectRatios: { landscape: '16:9', portrait: '9:16', square: '1:1' }
  })),
  saveSsawConfig: (data) => apiRequest('/api/ssaw/config', { method: 'POST', body: data }),

  // ============================================================================
  // CONFIGURATION
  // ============================================================================
  getConfig: () => {
    // Return config in the same format the Electron app expects
    // Load ALL settings from localStorage
    const storedConfig = JSON.parse(localStorage.getItem('ps_config') || '{}');
    return Promise.resolve({
      serverBaseUrl: config.serverBaseUrl,
      serverUrl: config.serverBaseUrl, // alias
      apiKey: config.apiKey,
      stickersCutSettings: JSON.parse(localStorage.getItem('ps_cutSettings') || '{}'),
      // Spread all other stored settings
      ...storedConfig
    });
  },

  saveConfig: (newConfig) => {
    try {
      console.log('[API] saveConfig called with:', newConfig);
      console.log('[API] serverBaseUrl in newConfig:', newConfig.serverBaseUrl);
      console.log('[API] apiKey in newConfig:', newConfig.apiKey ? '(set)' : '(empty)');

      // Load existing config
      const storedConfig = JSON.parse(localStorage.getItem('ps_config') || '{}');

      // Handle serverBaseUrl (primary) or serverUrl (alias) - these go in main config object
      if (newConfig.serverBaseUrl) {
        config.serverBaseUrl = newConfig.serverBaseUrl;
        localStorage.setItem('ps_serverBaseUrl', newConfig.serverBaseUrl);
        console.log('[API] Saved serverBaseUrl to localStorage:', newConfig.serverBaseUrl);
      } else if (newConfig.serverUrl) {
        config.serverBaseUrl = newConfig.serverUrl;
        localStorage.setItem('ps_serverBaseUrl', newConfig.serverUrl);
        console.log('[API] Saved serverUrl to localStorage:', newConfig.serverUrl);
      }

      if (newConfig.apiKey !== undefined) {
        config.apiKey = newConfig.apiKey;
        localStorage.setItem('ps_apiKey', newConfig.apiKey);
        console.log('[API] Saved apiKey to localStorage');
      }

      // Handle stickers cut settings separately
      if (newConfig.stickersCutSettings) {
        localStorage.setItem('ps_cutSettings', JSON.stringify(newConfig.stickersCutSettings));
      }

      // Store ALL other config fields in one localStorage object
      const updatedConfig = { ...storedConfig, ...newConfig };
      // Remove fields we store separately
      delete updatedConfig.serverBaseUrl;
      delete updatedConfig.serverUrl;
      delete updatedConfig.apiKey;
      delete updatedConfig.stickersCutSettings;
      localStorage.setItem('ps_config', JSON.stringify(updatedConfig));

      // Verify save worked
      console.log('[API] Verifying localStorage:');
      console.log('  ps_serverBaseUrl:', localStorage.getItem('ps_serverBaseUrl'));
      console.log('  ps_apiKey:', localStorage.getItem('ps_apiKey') ? '(set)' : '(empty)');
      console.log('  ps_config keys:', Object.keys(JSON.parse(localStorage.getItem('ps_config') || '{}')));

      // Return the complete merged config (app expects this)
      const result = {
        serverBaseUrl: config.serverBaseUrl,
        serverUrl: config.serverBaseUrl,
        apiKey: config.apiKey,
        stickersCutSettings: JSON.parse(localStorage.getItem('ps_cutSettings') || '{}'),
        ...updatedConfig
      };
      console.log('[API] saveConfig returning:', Object.keys(result));
      return Promise.resolve(result);
    } catch (err) {
      console.error('[API] saveConfig ERROR:', err);
      return Promise.reject(err);
    }
  },

  // ============================================================================
  // ORDERS
  // ============================================================================
  orders: {
    list: (query) => apiRequest(`/api/orders${query ? '?' + new URLSearchParams(query) : ''}`),
    get: (id) => apiRequest(`/api/orders/${encodeURIComponent(id)}`),
    update: (id, data) => apiRequest(`/api/orders/${encodeURIComponent(id)}`, { method: 'PATCH', body: data }),
    acknowledge: (id, data) => apiRequest(`/api/internal/orders/${encodeURIComponent(id)}/acknowledge`, { method: 'PATCH', body: data }),
    complete: (id, data) => apiRequest(`/api/internal/orders/${encodeURIComponent(id)}/completed`, { method: 'PATCH', body: data })
  },

  // ============================================================================
  // RACE QUOTES
  // ============================================================================
  quotes: {
    list: () => apiRequest('/api/admin/race-quotes'),
    get: (id) => apiRequest(`/api/admin/race-quotes/${encodeURIComponent(id)}`),
    update: (id, data) => apiRequest(`/api/admin/race-quotes/${encodeURIComponent(id)}`, { method: 'PATCH', body: data })
  },

  // ============================================================================
  // CATALOG
  // ============================================================================
  catalog: {
    list: (query) => apiRequest(`/api/catalog${query ? '?' + new URLSearchParams(query) : ''}`),
    categories: () => apiRequest('/api/catalog/categories'),
    get: (id) => apiRequest(`/api/catalog/${encodeURIComponent(id)}`),
    search: (q) => apiRequest(`/api/catalog/search?q=${encodeURIComponent(q)}`),
    generateMetadata: (data) => apiRequest('/api/catalog/generate-metadata', { method: 'POST', body: data })
  },

  // ============================================================================
  // STICKER SHEETS
  // ============================================================================
  stickerSheets: {
    getCategories: () => apiRequest('/api/sticker-sheets/categories'),
    getCatalog: (category) => apiRequest(`/api/sticker-sheets/catalog${category ? '?category=' + encodeURIComponent(category) : ''}`),
    getGridInfo: (sizeInches) => apiRequest(`/api/sticker-sheets/grid-info?size=${sizeInches || 3}`),
    generate: (data) => apiRequest('/api/sticker-sheets/generate', { method: 'POST', body: data }),
    fromOrder: (data) => apiRequest('/api/sticker-sheets/from-order', { method: 'POST', body: data }),
    listSavedOrders: () => apiRequest('/api/sticker-sheets/saved-orders'),
    getOrderSheets: (orderNumber) => apiRequest(`/api/sticker-sheets/order/${encodeURIComponent(orderNumber)}`),
    list: () => apiRequest('/api/sticker-sheets/list')
  },

  // ============================================================================
  // CAMPAIGNS
  // ============================================================================
  campaigns: {
    list: () => apiRequest('/api/campaigns'),
    get: (id) => apiRequest(`/api/campaigns/${encodeURIComponent(id)}`),
    create: (data) => apiRequest('/api/campaigns', { method: 'POST', body: data }),
    update: (id, data) => apiRequest(`/api/campaigns/${encodeURIComponent(id)}`, { method: 'PATCH', body: data }),
    delete: (id) => apiRequest(`/api/campaigns/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    addItems: (id, items) => apiRequest(`/api/campaigns/${encodeURIComponent(id)}/items`, { method: 'POST', body: { items } }),
    removeItem: (id, itemId) => apiRequest(`/api/campaigns/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}`, { method: 'DELETE' }),
    publish: (id, options) => apiRequest(`/api/campaigns/${encodeURIComponent(id)}/publish`, { method: 'POST', body: options })
  },

  // ============================================================================
  // SALES / SHOPIFY
  // ============================================================================
  sales: {
    summary: (period) => apiRequest(`/api/sales/summary${period ? '?period=' + period : ''}`),
    orders: (query) => apiRequest(`/api/shopify/orders${query ? '?' + new URLSearchParams(query) : ''}`)
  },

  shopify: {
    orders: (query) => apiRequest(`/api/shopify/orders${query ? '?' + new URLSearchParams(query) : ''}`),
    products: (query) => apiRequest(`/api/shopify/products${query ? '?' + new URLSearchParams(query) : ''}`),
    collections: () => apiRequest('/api/shopify/collections')
  },

  // ============================================================================
  // FACEBOOK / SOCIAL
  // ============================================================================
  facebook: {
    createPost: (data) => apiRequest('/api/facebook/create-post', { method: 'POST', body: data }),
    schedulePost: (data) => apiRequest('/api/facebook/schedule-post', { method: 'POST', body: data }),
    getScheduledPosts: (options) => apiRequest(`/api/facebook/scheduled-posts${options ? '?' + new URLSearchParams(options) : ''}`),
    deleteScheduledPost: (id) => apiRequest(`/api/facebook/scheduled-posts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    getInsights: (options) => apiRequest(`/api/facebook/scheduled-posts/insights${options ? '?' + new URLSearchParams(options) : ''}`)
  },

  // ============================================================================
  // AI / COPY GENERATION
  // ============================================================================
  ai: {
    generateCopy: (data) => apiRequest('/api/ai/generate-copy', { method: 'POST', body: data }),
    generateDescription: (data) => apiRequest('/api/ai/generate-description', { method: 'POST', body: data })
  },

  leonardo: {
    generate: (data) => apiRequest('/api/leonardo/generate', { method: 'POST', body: data }),
    getStatus: (id) => apiRequest(`/api/leonardo/status/${encodeURIComponent(id)}`),
    getGenerations: () => apiRequest('/api/leonardo/generations')
  },

  // ============================================================================
  // MOCKUPS
  // ============================================================================
  mockups: {
    generate: (data) => apiRequest('/api/mockups/generate', { method: 'POST', body: data }),
    templates: () => apiRequest('/api/mockups/templates'),
    backgrounds: (query) => apiRequest(`/api/mockup-backgrounds${query ? '?' + new URLSearchParams(query) : ''}`)
  },

  // ============================================================================
  // HUMAN MODELS
  // ============================================================================
  humanModels: {
    list: (query) => apiRequest(`/api/human-models${query ? '?' + new URLSearchParams(query) : ''}`),
    categories: () => apiRequest('/api/human-models/categories'),
    get: (id) => apiRequest(`/api/human-models/${encodeURIComponent(id)}`)
  },

  // ============================================================================
  // INVENTORY
  // ============================================================================
  inventory: {
    list: () => apiRequest('/api/inventory'),
    get: (id) => apiRequest(`/api/inventory/${encodeURIComponent(id)}`),
    update: (id, data) => apiRequest(`/api/inventory/${encodeURIComponent(id)}`, { method: 'PATCH', body: data }),
    alerts: () => apiRequest('/api/inventory/alerts')
  },

  // ============================================================================
  // SERVER HEALTH / DASHBOARD
  // ============================================================================
  server: {
    health: () => apiRequest('/api/internal/health'),
    tasks: () => apiRequest('/api/internal/tasks'),
    stats: () => apiRequest('/api/internal/stats')
  },

  dashboard: {
    getData: () => apiRequest('/api/internal/dashboard'),
    getStats: (period) => apiRequest(`/api/internal/dashboard/stats${period ? '?period=' + period : ''}`),
    getServerStats: () => apiRequest('/api/internal/server-stats'),
    getSocialStats: (period) => apiRequest(`/api/internal/social-stats${period ? '?period=' + period : ''}`)
  },

  // ============================================================================
  // TIKTOK
  // ============================================================================
  tiktok: {
    getStatus: () => apiRequest('/api/tiktok/status'),
    getUserInfo: () => apiRequest('/api/tiktok/user'),
    getAuthUrl: () => apiRequest('/api/tiktok/auth-url'),
    disconnect: () => apiRequest('/api/tiktok/disconnect', { method: 'POST' }),
    generateCaption: (data) => apiRequest('/api/tiktok/generate-caption', { method: 'POST', body: data }),
    uploadVideo: (data) => apiRequest('/api/tiktok/upload', { method: 'POST', body: data }),
    uploadVideoFromUrl: (data) => apiRequest('/api/tiktok/upload-from-url', { method: 'POST', body: data })
  },

  // ============================================================================
  // SHOPIFY MANAGER
  // ============================================================================
  shopifyManager: {
    listCollections: () => apiRequest('/api/shopify/collections'),
    getCollectionProducts: (id) => apiRequest(`/api/shopify/collections/${encodeURIComponent(id)}/products`)
  },

  // ============================================================================
  // CUSTOM ART / WALL ART
  // ============================================================================
  customArt: {
    listRooms: (query) => apiRequest(`/api/custom-art/rooms${query ? '?' + new URLSearchParams(query) : ''}`),
    createRoom: (data) => apiRequest('/api/custom-art/rooms', { method: 'POST', body: data }),
    updateRoom: (id, data) => apiRequest(`/api/custom-art/rooms/${encodeURIComponent(id)}`, { method: 'PATCH', body: data }),
    deleteRoom: (id) => apiRequest(`/api/custom-art/rooms/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    generateRoomMetadata: (imagePath) => apiRequest('/api/custom-art/rooms/generate-metadata', { method: 'POST', body: { imagePath } }),

    listArtwork: (query) => apiRequest(`/api/custom-art/artwork${query ? '?' + new URLSearchParams(query) : ''}`),
    getArtworkCategories: () => apiRequest('/api/custom-art/artwork/categories'),
    updateArtwork: (id, data) => apiRequest(`/api/custom-art/artwork/${encodeURIComponent(id)}`, { method: 'PATCH', body: data }),
    generateAIMetadata: (id) => apiRequest(`/api/custom-art/artwork/${encodeURIComponent(id)}/generate-metadata`, { method: 'POST' }),

    listProducts: (query) => apiRequest(`/api/custom-art/products${query ? '?' + new URLSearchParams(query) : ''}`),
    createProduct: (data) => apiRequest('/api/custom-art/products', { method: 'POST', body: data }),
    updateProduct: (id, data) => apiRequest(`/api/custom-art/products/${encodeURIComponent(id)}`, { method: 'PATCH', body: data }),
    deleteProduct: (id) => apiRequest(`/api/custom-art/products/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    exportToShopify: (data) => apiRequest('/api/custom-art/export-to-shopify', { method: 'POST', body: data }),

    listMaterials: (query) => apiRequest(`/api/custom-art/materials${query ? '?' + new URLSearchParams(query) : ''}`),
    createMaterial: (data) => apiRequest('/api/custom-art/materials', { method: 'POST', body: data }),
    updateMaterial: (id, data) => apiRequest(`/api/custom-art/materials/${encodeURIComponent(id)}`, { method: 'PATCH', body: data }),
    deleteMaterial: (id) => apiRequest(`/api/custom-art/materials/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    generateTiles: (data) => apiRequest('/api/custom-art/generate-tiles', { method: 'POST', body: data }),

    // File operations - web versions
    selectFile: async (options) => {
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = options?.accept || 'image/*';
        input.onchange = (e) => {
          const file = e.target.files[0];
          if (file) {
            resolve({ filePath: file, fileName: file.name, file });
          } else {
            resolve({ cancelled: true });
          }
        };
        input.click();
      });
    },
    selectFiles: async (options) => {
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = options?.accept || 'image/*,.zip';
        input.multiple = true;
        input.onchange = (e) => {
          const files = Array.from(e.target.files);
          if (files.length > 0) {
            resolve({ filePaths: files.map(f => f.name), files });
          } else {
            resolve({ cancelled: true });
          }
        };
        input.click();
      });
    },
    uploadFile: async (file, type) => {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('type', type || 'room');

      const response = await fetch(buildUrl('/api/custom-art/upload'), {
        method: 'POST',
        headers: config.apiKey ? { 'X-API-Key': config.apiKey } : {},
        body: formData
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || `Upload failed: ${response.status}`);
      }
      return response.json();
    },
    extractZip: (file) => {
      // ZIP extraction would need to be handled server-side for web
      return Promise.reject(new Error('ZIP extraction not available in web version. Please upload individual images.'));
    }
  },

  // ============================================================================
  // PREVIEW CACHE (Web version - no-op or use browser cache)
  // ============================================================================
  previewCache: {
    batch: (items) => Promise.resolve(items.map(item => ({ ...item, cached: false })))
  },

  // ============================================================================
  // PRINTER (Web version - opens print dialog)
  // ============================================================================
  printer: {
    printWithDialog: async ({ imageUrls }) => {
      // In web, we open images in new tabs for printing
      // Or create a print-friendly page
      const printWindow = window.open('', '_blank');
      if (!printWindow) {
        return { success: false, error: 'Popup blocked. Please allow popups.' };
      }

      const imagesHtml = imageUrls.map(url =>
        `<img src="${url}" style="max-width:100%;page-break-after:always;" />`
      ).join('');

      printWindow.document.write(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Print Sticker Sheets</title>
          <style>
            * { margin: 0; padding: 0; }
            body { background: white; }
            img { display: block; max-width: 8.5in; max-height: 11in; }
            @media print {
              img { page-break-after: always; }
            }
          </style>
        </head>
        <body>
          ${imagesHtml}
          <script>
            window.onload = function() {
              setTimeout(function() { window.print(); }, 500);
            };
          </script>
        </body>
        </html>
      `);
      printWindow.document.close();

      return { success: true };
    },

    getPrinters: () => Promise.resolve({ printers: [] }) // Not available in web
  },

  // ============================================================================
  // CAMEO (Web version - downloads SVG files)
  // ============================================================================
  cameo: {
    openCutFile: async ({ url }) => {
      // In web, we just download the SVG file
      const link = document.createElement('a');
      link.href = url;
      link.download = url.split('/').pop() || 'cut-file.svg';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      return { success: true, message: 'SVG downloaded. Open in Silhouette Studio.' };
    }
  },

  // ============================================================================
  // UPLOAD
  // ============================================================================
  upload: {
    artwork: async (file, metadata) => {
      const formData = new FormData();
      formData.append('file', file);
      if (metadata) {
        formData.append('metadata', JSON.stringify(metadata));
      }

      const response = await fetch(buildUrl('/api/upload/artwork'), {
        method: 'POST',
        headers: config.apiKey ? { 'X-API-Key': config.apiKey } : {},
        body: formData
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || `Upload failed: ${response.status}`);
      }

      return response.json();
    }
  },

  // ============================================================================
  // UTILITIES
  // ============================================================================
  utils: {
    resolveAssetUrl: (path) => {
      if (!path) return '';
      if (path.startsWith('http://') || path.startsWith('https://')) return path;
      if (path.startsWith('/')) return buildUrl(path);
      return buildUrl(`/library/${path}`);
    }
  }
};

// Global helper for resolving asset URLs
window.resolveAssetUrl = printStation.utils.resolveAssetUrl;

// Export config setter for settings page
window.setPrintStationConfig = (newConfig) => {
  if (newConfig.serverBaseUrl) {
    config.serverBaseUrl = newConfig.serverBaseUrl;
    localStorage.setItem('ps_serverBaseUrl', newConfig.serverBaseUrl);
  } else if (newConfig.serverUrl) {
    config.serverBaseUrl = newConfig.serverUrl;
    localStorage.setItem('ps_serverBaseUrl', newConfig.serverUrl);
  }
  if (newConfig.apiKey) {
    config.apiKey = newConfig.apiKey;
    localStorage.setItem('ps_apiKey', newConfig.apiKey);
  }
};

window.getPrintStationConfig = () => ({
  serverBaseUrl: config.serverBaseUrl,
  serverUrl: config.serverBaseUrl,
  apiKey: config.apiKey
});

console.log('[Print Station Web] API adapter loaded. Server:', config.serverBaseUrl);
