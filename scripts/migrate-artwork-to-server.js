#!/usr/bin/env node
/**
 * Migrate local artwork files to server
 *
 * This script:
 * 1. Fetches all artwork from the server
 * 2. For each artwork with a local Windows path, reads the local file
 * 3. Uploads the file to the server
 * 4. Updates the artwork record with the new server-relative path
 */

const fs = require('fs');
const path = require('path');

const SERVER_URL = 'https://blueridgecustomco.com';
const API_KEY = 'laZHEthV92qDq0adO07UnqoH3O4baZmV';

async function fetchArtwork() {
  const response = await fetch(`${SERVER_URL}/api/custom-art/artwork?limit=1000&activeOnly=false`, {
    headers: { 'X-API-Key': API_KEY }
  });
  const data = await response.json();
  return data.artwork || [];
}

async function uploadFile(filePath) {
  // Read file as base64
  const fileBuffer = fs.readFileSync(filePath);
  const base64Data = fileBuffer.toString('base64');
  const filename = path.basename(filePath);

  const response = await fetch(`${SERVER_URL}/api/custom-art/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY
    },
    body: JSON.stringify({
      imageData: base64Data,
      filename: filename,
      type: 'artwork'
    })
  });

  const result = await response.json();
  if (!response.ok || !result.success) {
    throw new Error(result.error || 'Upload failed');
  }
  return result.filePath; // Server-relative path like "uploads/custom-art/filename.jpg"
}

async function updateArtwork(id, filePath) {
  const response = await fetch(`${SERVER_URL}/api/custom-art/artwork/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY
    },
    body: JSON.stringify({ filePath })
  });
  const result = await response.json();
  if (!response.ok || !result.success) {
    throw new Error(result.error || 'Update failed');
  }
  return result;
}

function isLocalWindowsPath(p) {
  if (!p) return false;
  // Match paths like C:\... or D:\...
  return /^[A-Za-z]:[\\/]/.test(p);
}

async function main() {
  console.log('Fetching artwork from server...');
  const artworks = await fetchArtwork();
  console.log(`Found ${artworks.length} artwork records`);

  // Filter to only those with local Windows paths
  const needsMigration = artworks.filter(art => isLocalWindowsPath(art.filePath));
  console.log(`${needsMigration.length} artworks have local Windows paths and need migration`);

  let migrated = 0;
  let failed = 0;
  let skipped = 0;

  for (const art of needsMigration) {
    const localPath = art.filePath;

    // Check if local file exists
    if (!fs.existsSync(localPath)) {
      console.log(`SKIP: ${art.id} - File not found: ${localPath}`);
      skipped++;
      continue;
    }

    try {
      console.log(`Migrating ${art.id}: ${path.basename(localPath)}...`);

      // Upload to server
      const serverPath = await uploadFile(localPath);
      console.log(`  Uploaded to: ${serverPath}`);

      // Update artwork record
      await updateArtwork(art.id, serverPath);
      console.log(`  Updated artwork record`);

      migrated++;
    } catch (err) {
      console.error(`FAILED: ${art.id} - ${err.message}`);
      failed++;
    }
  }

  console.log('\n--- Migration Summary ---');
  console.log(`Migrated: ${migrated}`);
  console.log(`Failed: ${failed}`);
  console.log(`Skipped (file not found): ${skipped}`);
  console.log(`Total: ${needsMigration.length}`);
}

main().catch(err => {
  console.error('Migration error:', err);
  process.exit(1);
});
