#!/usr/bin/env node
/**
 * Add UID fields to campaign items that don't have them
 *
 * Usage: node scripts/add-campaign-uids.js <campaign-slug>
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const campaignSlug = process.argv[2];

if (!campaignSlug) {
  console.error('Usage: node scripts/add-campaign-uids.js <campaign-slug>');
  process.exit(1);
}

// Determine if we should connect to remote server
const useRemote = process.env.USE_REMOTE === '1' || process.env.USE_REMOTE === 'true';

if (useRemote) {
  console.log('❌ Remote editing not supported by this script.');
  console.log('Please run this on the server directly or manually update the campaign file.');
  process.exit(1);
}

// Local path
const campaignPath = path.join(__dirname, '..', 'data', 'campaigns', `${campaignSlug}.json`);

if (!fs.existsSync(campaignPath)) {
  console.error(`Campaign file not found: ${campaignPath}`);
  process.exit(1);
}

console.log(`Reading campaign: ${campaignPath}`);
const campaign = JSON.parse(fs.readFileSync(campaignPath, 'utf8'));

if (!Array.isArray(campaign.items)) {
  console.error('Campaign has no items array');
  process.exit(1);
}

let updated = 0;

campaign.items = campaign.items.map((item, index) => {
  if (!item.uid) {
    // Generate a unique ID for this item
    const uid = crypto.randomBytes(8).toString('hex');
    updated++;
    console.log(`Item ${index + 1}: Adding uid=${uid} (${item.name})`);
    return { ...item, uid };
  }
  return item;
});

if (updated > 0) {
  // Backup original
  const backupPath = `${campaignPath}.backup-${Date.now()}`;
  fs.copyFileSync(campaignPath, backupPath);
  console.log(`\n✅ Backed up to: ${backupPath}`);

  // Write updated campaign
  fs.writeFileSync(campaignPath, JSON.stringify(campaign, null, 2));
  console.log(`✅ Updated ${updated} items with UIDs`);
  console.log(`\n📤 Upload this file to the server to apply changes.`);
} else {
  console.log('✅ All items already have UIDs');
}
