const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('printStation', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config) => ipcRenderer.invoke('config:set', config),
  fetchQueue: (options) => ipcRenderer.invoke('queue:fetch', options),
  markDownloaded: (payload) => ipcRenderer.invoke('queue:ack', payload),
  markCompleted: (payload) => ipcRenderer.invoke('queue:complete', payload),
  listOrders: () => ipcRenderer.invoke('orders:list'),
  fetchCatalog: (options) => ipcRenderer.invoke('catalog:fetch', options || {}),
  uploadArtwork: (payload) => ipcRenderer.invoke('artwork:upload', payload),
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
  downloadFile: (payload) => ipcRenderer.invoke('files:download', payload || {})
});
