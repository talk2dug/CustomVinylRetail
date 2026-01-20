/**
 * Export Campaign Mockups to Google Drive Folder Structure
 *
 * This script organizes mockups from campaigns into a structured folder
 * hierarchy suitable for syncing to Google Drive.
 *
 * Folder Structure:
 * exports/
 * └── google-drive-mockups/
 *     ├── campaigns/
 *     │   ├── premium-metal-prints/
 *     │   │   ├── mockups/
 *     │   │   ├── ad-creatives/
 *     │   │   └── campaign-info.json
 *     │   └── [other-campaigns]/
 *     ├── apparel/
 *     │   ├── t-shirts/
 *     │   ├── hoodies/
 *     │   ├── long-sleeves/
 *     │   └── tank-tops/
 *     ├── customer-orders/
 *     │   └── [date-organized]/
 *     └── templates/
 *         └── [mockup-templates]/
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const EXPORTS_DIR = path.join(PROJECT_ROOT, 'exports', 'google-drive-mockups');

// Directories to scan for mockups
const SOURCES = {
  savedDesigns: path.join(PROJECT_ROOT, 'saved-designs'),
  mockupPro: path.join(PROJECT_ROOT, 'web', 'mockup-pro'),
  humanModels: path.join(PROJECT_ROOT, 'web', 'library', 'human-models'),
  campaigns: PROJECT_ROOT, // Campaign JSON files in root
  customArtMockups: path.join(PROJECT_ROOT, 'web', 'images', 'custom-art'), // Generated mockups
  // Campaign mockups from library
  libraryCampaigns: path.join(PROJECT_ROOT, 'web', 'library', 'data', 'campaigns'),
  campaignItemMockups: path.join(PROJECT_ROOT, 'web', 'library', 'Campaign Assets', 'uploads', 'previews'),
};

/**
 * Create the Google Drive folder structure
 */
function createFolderStructure() {
  const folders = [
    'campaigns',
    'apparel/t-shirts',
    'apparel/hoodies',
    'apparel/long-sleeves',
    'apparel/tank-tops',
    'customer-orders',
    'templates/mockup-templates',
    'templates/human-models',
  ];

  folders.forEach(folder => {
    const fullPath = path.join(EXPORTS_DIR, folder);
    fs.mkdirSync(fullPath, { recursive: true });
    console.log(`✓ Created: ${folder}`);
  });
}

/**
 * Parse campaign JSON files and organize them
 */
function processCampaigns() {
  const campaignFiles = fs.readdirSync(PROJECT_ROOT)
    .filter(f => f.startsWith('facebook-campaign-') && f.endsWith('.json'));

  console.log(`\nFound ${campaignFiles.length} facebook campaign files`);

  campaignFiles.forEach(file => {
    try {
      const content = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, file), 'utf-8'));
      const campaignName = slugify(content.meta?.productName || file.replace('.json', ''));
      const campaignDir = path.join(EXPORTS_DIR, 'campaigns', campaignName);

      // Create campaign folder
      fs.mkdirSync(path.join(campaignDir, 'mockups'), { recursive: true });
      fs.mkdirSync(path.join(campaignDir, 'ad-creatives'), { recursive: true });

      // Copy campaign info
      fs.writeFileSync(
        path.join(campaignDir, 'campaign-info.json'),
        JSON.stringify(content, null, 2)
      );

      // Create a summary file for easy reading
      const summary = createCampaignSummary(content, file);
      fs.writeFileSync(path.join(campaignDir, 'README.txt'), summary);

      console.log(`✓ Processed facebook campaign: ${campaignName}`);
    } catch (err) {
      console.error(`✗ Error processing ${file}:`, err.message);
    }
  });
}

/**
 * Process library campaigns with their apparel mockups
 */
function processLibraryCampaigns() {
  const campaignsDir = SOURCES.libraryCampaigns;
  const mockupsDir = path.join(campaignsDir, 'mockups');
  const itemMockupsDir = SOURCES.campaignItemMockups;

  if (!fs.existsSync(campaignsDir)) {
    console.log('No library campaigns folder found');
    return;
  }

  const campaignFiles = fs.readdirSync(campaignsDir)
    .filter(f => f.endsWith('.json'));

  console.log(`\nFound ${campaignFiles.length} library campaigns`);

  let totalItemMockups = 0;

  campaignFiles.forEach(file => {
    try {
      const content = JSON.parse(fs.readFileSync(path.join(campaignsDir, file), 'utf-8'));
      const campaignSlug = content.slug || file.replace('.json', '');
      const campaignDir = path.join(EXPORTS_DIR, 'campaigns', campaignSlug);

      // Create campaign folder with mockups subfolder
      fs.mkdirSync(path.join(campaignDir, 'mockups'), { recursive: true });

      // Copy campaign JSON
      fs.writeFileSync(
        path.join(campaignDir, 'campaign.json'),
        JSON.stringify(content, null, 2)
      );

      // Create summary
      const summary = `Campaign: ${content.title || campaignSlug}
=====================================
Slug: ${campaignSlug}
Items: ${(content.items || []).length}
Updated: ${content.updatedAt || 'Unknown'}

APPAREL TYPES
-------------
${(content.apparel?.productTypes || []).join(', ') || 'N/A'}
`;
      fs.writeFileSync(path.join(campaignDir, 'README.txt'), summary);

      // Copy campaign-level mockup if exists
      if (fs.existsSync(mockupsDir)) {
        const campaignMockups = fs.readdirSync(mockupsDir)
          .filter(f => f.includes(campaignSlug) && (f.endsWith('.jpg') || f.endsWith('.png')));

        campaignMockups.forEach(mockupFile => {
          const src = path.join(mockupsDir, mockupFile);
          const dest = path.join(campaignDir, 'mockups', mockupFile);
          fs.copyFileSync(src, dest);
        });

        if (campaignMockups.length > 0) {
          console.log(`  ✓ Copied ${campaignMockups.length} campaign mockups`);
        }
      }

      // Copy item-level mockups AND original design images
      const items = content.items || [];
      let itemMockupCount = 0;
      let itemImageCount = 0;

      // Create designs subfolder for original images
      fs.mkdirSync(path.join(campaignDir, 'designs'), { recursive: true });

      items.forEach((item, idx) => {
        // Copy mockup image (apparel preview)
        if (item.mockupImage) {
          const mockupFilename = path.basename(decodeURIComponent(item.mockupImage));
          const srcPath = path.join(itemMockupsDir, mockupFilename);

          if (fs.existsSync(srcPath)) {
            const destPath = path.join(campaignDir, 'mockups', mockupFilename);
            fs.copyFileSync(srcPath, destPath);
            itemMockupCount++;
          }
        }

        // Copy original design image (the PNG/JPG artwork)
        if (item.image) {
          try {
            // Parse the URL to get the local path
            // URL format: https://blueridgecustomco.com/web/library/RockBand Cartoons/uploads/previews/file.png
            const imageUrl = decodeURIComponent(item.image);
            const urlPath = imageUrl.replace(/^https?:\/\/[^\/]+\//, ''); // Remove domain
            const localPath = path.join(PROJECT_ROOT, urlPath);

            if (fs.existsSync(localPath)) {
              const filename = path.basename(localPath);
              const destPath = path.join(campaignDir, 'designs', filename);
              fs.copyFileSync(localPath, destPath);
              itemImageCount++;
            }
          } catch (err) {
            // Skip if path parsing fails
          }
        }
      });

      totalItemMockups += itemMockupCount;
      console.log(`✓ ${campaignSlug}: ${items.length} items, ${itemMockupCount} mockups, ${itemImageCount} designs copied`);

    } catch (err) {
      console.error(`✗ Error processing ${file}:`, err.message);
    }
  });

  console.log(`\nTotal item mockups exported: ${totalItemMockups}`);
}

/**
 * Process saved customer designs/orders
 */
function processSavedDesigns() {
  if (!fs.existsSync(SOURCES.savedDesigns)) {
    console.log('No saved-designs folder found');
    return;
  }

  const files = fs.readdirSync(SOURCES.savedDesigns);
  const designs = files.filter(f => f.endsWith('.json'));

  console.log(`\nFound ${designs.length} saved designs`);

  designs.forEach(jsonFile => {
    try {
      const content = JSON.parse(
        fs.readFileSync(path.join(SOURCES.savedDesigns, jsonFile), 'utf-8')
      );

      // Organize by date
      const savedAt = new Date(content.savedAt || Date.now());
      const dateFolder = savedAt.toISOString().split('T')[0]; // YYYY-MM-DD
      const orderDir = path.join(EXPORTS_DIR, 'customer-orders', dateFolder);

      fs.mkdirSync(orderDir, { recursive: true });

      // Create design folder
      const designName = content.designName || content.id || path.basename(jsonFile, '.json');
      const designFolder = path.join(orderDir, slugify(designName));
      fs.mkdirSync(designFolder, { recursive: true });

      // Copy files
      const baseName = path.basename(jsonFile, '.json');
      const relatedFiles = files.filter(f => f.startsWith(baseName));

      relatedFiles.forEach(relFile => {
        const src = path.join(SOURCES.savedDesigns, relFile);
        const dest = path.join(designFolder, relFile);
        fs.copyFileSync(src, dest);
      });

      // Create order summary
      const orderSummary = createOrderSummary(content);
      fs.writeFileSync(path.join(designFolder, 'order-info.txt'), orderSummary);

      console.log(`✓ Exported: ${designName} (${dateFolder})`);
    } catch (err) {
      console.error(`✗ Error processing ${jsonFile}:`, err.message);
    }
  });
}

/**
 * Export apparel mockup templates
 */
async function processApparelTemplates() {
  const mockupProDir = SOURCES.mockupPro;

  if (!fs.existsSync(mockupProDir)) {
    console.log('No mockup-pro folder found');
    return;
  }

  console.log('\nProcessing apparel mockup templates...');

  // Copy 3D models
  const modelsDir = path.join(mockupProDir, 'models');
  if (fs.existsSync(modelsDir)) {
    const models = fs.readdirSync(modelsDir, { withFileTypes: true });

    models.forEach(modelEntry => {
      // Skip directories
      if (modelEntry.isDirectory()) {
        console.log(`  Skipping directory: ${modelEntry.name}`);
        return;
      }

      const model = modelEntry.name;
      const modelName = path.basename(model, path.extname(model));
      let targetFolder = 'templates/mockup-templates';

      // Categorize by apparel type
      if (modelName.includes('tshirt') || modelName.includes('t-shirt')) {
        targetFolder = 'apparel/t-shirts';
      } else if (modelName.includes('hoodie')) {
        targetFolder = 'apparel/hoodies';
      } else if (modelName.includes('long') || modelName.includes('longsleeve')) {
        targetFolder = 'apparel/long-sleeves';
      } else if (modelName.includes('tank')) {
        targetFolder = 'apparel/tank-tops';
      }

      const src = path.join(modelsDir, model);
      const dest = path.join(EXPORTS_DIR, targetFolder, model);
      fs.copyFileSync(src, dest);
      console.log(`✓ Copied model: ${model} → ${targetFolder}`);
    });
  }

  // Copy SVG templates
  const svgFiles = fs.readdirSync(mockupProDir).filter(f => f.endsWith('.svg'));
  svgFiles.forEach(svg => {
    const src = path.join(mockupProDir, svg);
    const dest = path.join(EXPORTS_DIR, 'templates/mockup-templates', svg);
    fs.copyFileSync(src, dest);
    console.log(`✓ Copied template: ${svg}`);
  });
}

/**
 * Process human model files
 */
function processHumanModels() {
  const modelsDir = SOURCES.humanModels;

  if (!fs.existsSync(modelsDir)) {
    console.log('No human-models folder found');
    return;
  }

  console.log('\nProcessing human model files...');

  const files = fs.readdirSync(modelsDir);
  const destDir = path.join(EXPORTS_DIR, 'templates/human-models');

  files.forEach(file => {
    const src = path.join(modelsDir, file);
    const dest = path.join(destDir, file);

    // Only copy thumbnails (skip large zip files by default)
    if (file.endsWith('.jpg') || file.endsWith('.png')) {
      fs.copyFileSync(src, dest);
      console.log(`✓ Copied: ${file}`);
    }
  });
}

/**
 * Create a manifest of all exported files
 */
function createManifest() {
  const manifest = {
    exportedAt: new Date().toISOString(),
    rootFolder: EXPORTS_DIR,
    structure: {},
    stats: {
      campaigns: 0,
      customerOrders: 0,
      apparelTemplates: 0,
      totalFiles: 0,
    }
  };

  function scanDir(dir, relativePath = '') {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    const result = {};

    items.forEach(item => {
      const itemPath = path.join(relativePath, item.name);
      if (item.isDirectory()) {
        result[item.name] = scanDir(path.join(dir, item.name), itemPath);
      } else {
        result[item.name] = {
          size: fs.statSync(path.join(dir, item.name)).size,
          type: path.extname(item.name).slice(1) || 'unknown'
        };
        manifest.stats.totalFiles++;
      }
    });

    return result;
  }

  manifest.structure = scanDir(EXPORTS_DIR);

  // Count specific items
  const campaignsDir = path.join(EXPORTS_DIR, 'campaigns');
  if (fs.existsSync(campaignsDir)) {
    manifest.stats.campaigns = fs.readdirSync(campaignsDir, { withFileTypes: true })
      .filter(d => d.isDirectory()).length;
  }

  const ordersDir = path.join(EXPORTS_DIR, 'customer-orders');
  if (fs.existsSync(ordersDir)) {
    manifest.stats.customerOrders = countNestedFolders(ordersDir);
  }

  fs.writeFileSync(
    path.join(EXPORTS_DIR, 'manifest.json'),
    JSON.stringify(manifest, null, 2)
  );

  console.log('\n✓ Created manifest.json');
  console.log(`  - Campaigns: ${manifest.stats.campaigns}`);
  console.log(`  - Customer Orders: ${manifest.stats.customerOrders}`);
  console.log(`  - Total Files: ${manifest.stats.totalFiles}`);
}

// Helper functions
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function createCampaignSummary(campaign, filename) {
  const meta = campaign.meta || {};
  const targeting = campaign.targeting || {};
  const creative = campaign.creative || {};

  return `Campaign: ${meta.productName || 'Unknown'}
=====================================
Original File: ${filename}
Generated: ${meta.generatedAt || 'Unknown'}
Price: $${meta.price || 'N/A'}

TARGET AUDIENCE
---------------
Age: ${targeting.demographics?.age_min || '?'} - ${targeting.demographics?.age_max || '?'}
Locations: ${targeting.locations?.regions?.join(', ') || 'N/A'}
Interests: ${targeting.interests?.slice(0, 5).join(', ') || 'N/A'}...

CREATIVE
--------
Headlines:
${(creative.headlines || []).map(h => `  • ${h}`).join('\n')}

Descriptions:
${(creative.descriptions || []).map(d => `  • ${d}`).join('\n')}

BUDGET
------
Daily: $${campaign.budget?.recommended?.dailyBudget || 'N/A'}
Lifetime: $${campaign.budget?.recommended?.lifetimeBudget || 'N/A'}
Strategy: ${campaign.budget?.recommended?.bidStrategy || 'N/A'}
`;
}

function createOrderSummary(order) {
  return `Design Order Summary
====================
Design: ${order.designName || order.id || 'Unknown'}
Category: ${order.category || 'N/A'}
Saved: ${order.savedAt || 'Unknown'}

SPECIFICATIONS
--------------
Size: ${order.size || 'N/A'} inches
Color: ${order.color || 'N/A'}
Background: ${order.background || 'N/A'}
Quantity: ${order.quantity || 1}

CUSTOMER
--------
Name: ${order.customer?.name || 'N/A'}
Email: ${order.customer?.email || 'N/A'}
Phone: ${order.customer?.phone || 'N/A'}
Address: ${order.customer?.address || 'N/A'}

Payment Status: ${order.paid ? 'PAID' : 'UNPAID'}

FILES INCLUDED
--------------
${(order.sourceCopies || []).map(s => `• ${s.file} (${s.format.toUpperCase()})`).join('\n')}
`;
}

function countNestedFolders(dir) {
  let count = 0;
  const items = fs.readdirSync(dir, { withFileTypes: true });
  items.forEach(item => {
    if (item.isDirectory()) {
      count++;
      count += countNestedFolders(path.join(dir, item.name));
    }
  });
  return count;
}

/**
 * Sync exports to Google Drive using rclone
 */
async function syncToGoogleDrive() {
  const { execSync } = require('child_process');

  console.log('\nSyncing to Google Drive...');

  try {
    // Check if rclone is available
    execSync('which rclone', { stdio: 'pipe' });

    // Sync to Google Drive
    execSync(
      `rclone sync "${EXPORTS_DIR}" gdrive:Canva`,
      { encoding: 'utf-8', stdio: 'inherit' }
    );

    console.log('✓ Synced to Google Drive: Canva');
    return true;
  } catch (err) {
    if (err.message && err.message.includes('which rclone')) {
      console.log('  rclone not installed - skipping Google Drive sync');
    } else {
      console.log(`  Google Drive sync error: ${err.message || 'unknown'}`);
    }
    return false;
  }
}

// Main execution
async function main() {
  console.log('='.repeat(50));
  console.log('Exporting Mockups for Google Drive');
  console.log('='.repeat(50));
  console.log(`\nExport destination: ${EXPORTS_DIR}\n`);

  // Clear existing exports
  if (fs.existsSync(EXPORTS_DIR)) {
    console.log('Clearing previous export...');
    fs.rmSync(EXPORTS_DIR, { recursive: true });
  }

  // Run export steps
  createFolderStructure();
  processCampaigns();
  processLibraryCampaigns();  // Process apparel campaigns with mockups
  processSavedDesigns();
  await processApparelTemplates();
  processHumanModels();
  createManifest();

  // Auto-sync to Google Drive if rclone is available
  await syncToGoogleDrive();

  console.log('\n' + '='.repeat(50));
  console.log('Export complete!');
  console.log('='.repeat(50));
  console.log(`\nLocal folder: ${EXPORTS_DIR}`);
  console.log('Google Drive: VinylApp-Mockups');
}

main().catch(console.error);
