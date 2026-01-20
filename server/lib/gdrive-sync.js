/**
 * Google Drive Sync via rclone
 * Syncs custom art, mockups, rooms and collection items to Google Drive Canva folder
 */

const { exec } = require('child_process');
const path = require('path');
const fs = require('fs').promises;

// Base paths
const CUSTOM_ART_PATH = '/mnt/dbFiles/uploads/custom-art';
const LIBRARY_PATH = '/home/ubuntu/vinylApp/web/library';
const DECAL_ICONS_PATH = '/home/ubuntu/vinylApp/dbFiles/DecalCreatorIcons';
const CAMPAIGN_PREVIEWS_PATH = '/home/ubuntu/vinylApp/web/library/Campaign Assets/uploads/previews';

// Google Drive paths
const GDRIVE_BASE = 'gdrive:Canva';

/**
 * Copy a single file to Google Drive
 * @param {string} localPath - Full local file path
 * @param {string} remotePath - Remote path in Google Drive (relative to Canva folder)
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function syncFileToGDrive(localPath, remotePath) {
  return new Promise((resolve) => {
    const fullRemotePath = `${GDRIVE_BASE}/${remotePath}`;
    const cmd = `rclone copy "${localPath}" "${path.dirname(fullRemotePath)}" --progress`;

    console.log('[GDrive Sync] Running:', cmd);

    exec(cmd, { timeout: 120000 }, (error, stdout, stderr) => {
      if (error) {
        console.error('[GDrive Sync] Error:', error.message);
        resolve({ success: false, message: error.message });
      } else {
        console.log('[GDrive Sync] Success:', stdout || 'File synced');
        resolve({ success: true, message: 'File synced to Google Drive' });
      }
    });
  });
}

/**
 * Sync multiple files to Google Drive
 * @param {Array<{localPath: string, remotePath: string}>} files - Array of file objects
 * @returns {Promise<{success: boolean, synced: number, failed: number, errors: string[]}>}
 */
async function syncFilesToGDrive(files) {
  const results = { success: true, synced: 0, failed: 0, errors: [] };

  for (const file of files) {
    try {
      // Check if file exists
      await fs.access(file.localPath);

      const result = await syncFileToGDrive(file.localPath, file.remotePath);
      if (result.success) {
        results.synced++;
      } else {
        results.failed++;
        results.errors.push(`${file.localPath}: ${result.message}`);
      }
    } catch (err) {
      results.failed++;
      results.errors.push(`${file.localPath}: File not found`);
    }
  }

  results.success = results.failed === 0;
  return results;
}

/**
 * Sync custom art files by their IDs
 * @param {Array<string>} fileIds - Array of custom art file names/IDs
 * @returns {Promise<object>}
 */
async function syncCustomArt(fileIds) {
  const files = fileIds.map(id => ({
    localPath: path.join(CUSTOM_ART_PATH, id),
    remotePath: `Custom Art/${id}`
  }));

  return syncFilesToGDrive(files);
}

/**
 * Sync catalog/library items by their paths (to Collection folder)
 * Supports both library items and decal-icons
 * @param {Array<{category: string, subPath: string, source?: string}>} items - Catalog items with category, subPath, and optional source
 * @returns {Promise<object>}
 */
async function syncCatalogItems(items) {
  const files = items.map(item => {
    // item.category is the category folder name
    // item.subPath is the rest of the path (e.g., uploads/previews/filename.png or BUTTERFLIES JPGS/btr.jpg)
    // item.source is 'library' or 'decal-icons' (defaults to 'library' for backwards compatibility)

    let localPath;
    let gdriveFolder;

    if (item.source === 'decal-icons') {
      // Decal icons: /home/ubuntu/vinylApp/dbFiles/DecalCreatorIcons/CATEGORY/SUBFOLDER/file.jpg
      localPath = path.join(DECAL_ICONS_PATH, item.category, item.subPath);
      gdriveFolder = 'Decal Icons';
    } else {
      // Library items: /home/ubuntu/vinylApp/web/library/Category/uploads/previews/file.png
      localPath = path.join(LIBRARY_PATH, item.category, item.subPath);
      gdriveFolder = 'Collection';
    }

    // For GDrive, just use category/filename (flatten the structure)
    const filename = path.basename(item.subPath);
    return {
      localPath,
      remotePath: `${gdriveFolder}/${item.category}/${filename}`
    };
  });

  return syncFilesToGDrive(files);
}

/**
 * Sync campaign mockup previews
 * @param {Array<string>} filenames - Preview filenames
 * @returns {Promise<object>}
 */
async function syncMockups(filenames) {
  const files = filenames.map(filename => ({
    localPath: path.join(CAMPAIGN_PREVIEWS_PATH, filename),
    remotePath: `Mockups/${filename}`
  }));

  return syncFilesToGDrive(files);
}

/**
 * Sync room background images
 * @param {Array<string>} filenames - Room image filenames
 * @returns {Promise<object>}
 */
async function syncRooms(filenames) {
  const files = filenames.map(filename => ({
    localPath: path.join(CUSTOM_ART_PATH, filename),
    remotePath: `Rooms/${filename}`
  }));

  return syncFilesToGDrive(files);
}

/**
 * List files in a Google Drive folder
 * @param {string} remotePath - Path relative to Canva folder
 * @returns {Promise<{success: boolean, files: string[]}>}
 */
async function listGDriveFolder(remotePath = '') {
  return new Promise((resolve) => {
    const fullPath = remotePath ? `${GDRIVE_BASE}/${remotePath}` : GDRIVE_BASE;
    const cmd = `rclone lsf "${fullPath}" 2>/dev/null`;

    exec(cmd, { timeout: 30000 }, (error, stdout) => {
      if (error) {
        resolve({ success: false, files: [] });
      } else {
        const files = stdout.trim().split('\n').filter(f => f);
        resolve({ success: true, files });
      }
    });
  });
}

/**
 * Sync files FROM Google Drive back to server
 * @param {string} remotePath - Remote path in Google Drive (relative to Canva folder)
 * @param {string} localPath - Local destination path
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function syncFromGDrive(remotePath, localPath) {
  return new Promise((resolve) => {
    const fullRemotePath = `${GDRIVE_BASE}/${remotePath}`;
    const cmd = `rclone copy "${fullRemotePath}" "${localPath}" --progress`;

    console.log('[GDrive Sync] Pulling from GDrive:', cmd);

    exec(cmd, { timeout: 300000 }, (error, stdout, stderr) => {
      if (error) {
        console.error('[GDrive Sync] Error:', error.message);
        resolve({ success: false, message: error.message });
      } else {
        console.log('[GDrive Sync] Pull complete:', stdout);
        resolve({ success: true, message: 'Synced from Google Drive' });
      }
    });
  });
}

/**
 * Sync Collection folder from Google Drive back to server library
 * Syncs all categories or specific ones
 * @param {Array<string>} categories - Optional list of category names to sync. If empty, syncs all.
 * @returns {Promise<object>}
 */
async function syncCollectionFromGDrive(categories = []) {
  const results = { synced: 0, failed: 0, errors: [] };

  try {
    // If no specific categories, list all from GDrive
    if (categories.length === 0) {
      const listResult = await listGDriveFolder('Collection');
      if (listResult.success && listResult.files.length > 0) {
        // Filter to only directories (end with /)
        categories = listResult.files
          .filter(f => f.endsWith('/'))
          .map(f => f.slice(0, -1)); // Remove trailing slash
      }
    }

    console.log('[GDrive Sync] Syncing categories from GDrive:', categories);

    for (const category of categories) {
      const remotePath = `Collection/${category}`;
      const localPath = path.join(LIBRARY_PATH, category, 'uploads', 'previews');

      // Ensure local directory exists
      await fs.mkdir(localPath, { recursive: true });

      const result = await syncFromGDrive(remotePath, localPath);
      if (result.success) {
        results.synced++;
      } else {
        results.failed++;
        results.errors.push({ category, error: result.message });
      }
    }

    results.success = results.failed === 0;
    return results;
  } catch (err) {
    console.error('[GDrive Sync] Error syncing from GDrive:', err);
    return { success: false, synced: 0, failed: 1, errors: [err.message] };
  }
}

/**
 * Sync Custom Art from Google Drive back to server
 * @returns {Promise<object>}
 */
async function syncCustomArtFromGDrive() {
  try {
    await fs.mkdir(CUSTOM_ART_PATH, { recursive: true });
    const result = await syncFromGDrive('Custom Art', CUSTOM_ART_PATH);
    return { success: result.success, message: result.message };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Sync Mockups from Google Drive back to server
 * @returns {Promise<object>}
 */
async function syncMockupsFromGDrive() {
  try {
    await fs.mkdir(CAMPAIGN_PREVIEWS_PATH, { recursive: true });
    const result = await syncFromGDrive('Mockups', CAMPAIGN_PREVIEWS_PATH);
    return { success: result.success, message: result.message };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Sync Rooms from Google Drive back to server
 * @returns {Promise<object>}
 */
async function syncRoomsFromGDrive() {
  try {
    await fs.mkdir(CUSTOM_ART_PATH, { recursive: true });
    const result = await syncFromGDrive('Rooms', CUSTOM_ART_PATH);
    return { success: result.success, message: result.message };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

module.exports = {
  syncFileToGDrive,
  syncFilesToGDrive,
  syncCustomArt,
  syncCatalogItems,
  syncMockups,
  syncRooms,
  listGDriveFolder,
  // Reverse sync functions
  syncFromGDrive,
  syncCollectionFromGDrive,
  syncCustomArtFromGDrive,
  syncMockupsFromGDrive,
  syncRoomsFromGDrive
};
