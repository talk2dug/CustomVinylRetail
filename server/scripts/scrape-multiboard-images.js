#!/usr/bin/env node
/**
 * Multiboard Image Scraper
 *
 * Scrapes public pages from multiboard.io for product images.
 * Respects robots.txt, downloads images to data/media/multiboard/scraped/,
 * and inserts metadata into the multiboard_media table (ready=0).
 *
 * Usage:
 *   node server/scripts/scrape-multiboard-images.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// Try to load sharp for dimension detection
let sharp;
try {
  sharp = require('sharp');
} catch (e) {
  console.warn('[Scraper] sharp not available — dimensions will not be detected');
}

require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const db = require('../db');

const DRY_RUN = process.argv.includes('--dry-run');

const BASE_URL = 'https://multiboard.io';
const OUTPUT_DIR = path.resolve(__dirname, '..', '..', 'data', 'media', 'multiboard', 'scraped');

// Pages to scrape (public only)
const PAGES_TO_SCRAPE = [
  '/',
  '/about',
  '/gallery',
  '/products'
];

// Disallowed paths (will be populated from robots.txt)
let disallowedPaths = [];

// ============================================================================
// Squarespace URL Helpers
// ============================================================================

/**
 * Strips the ?format=NNNw query parameter from a Squarespace CDN URL.
 * Used for deduplication: the same image may appear with ?format=100w,
 * ?format=300w, etc. — we want to treat them as the same base image.
 */
function getBaseImageUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('squarespace-cdn.com')) {
      u.searchParams.delete('format');
      return u.toString();
    }
  } catch (e) { /* not a valid URL */ }
  return url;
}

/**
 * Upgrades Squarespace CDN image URLs to request the largest available
 * resolution (1500w) instead of the thumbnail size (100w, 300w, etc.).
 */
function upgradeSquarespaceUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('squarespace-cdn.com')) {
      const fmt = u.searchParams.get('format');
      if (fmt && /^\d+w$/.test(fmt)) {
        u.searchParams.set('format', '1500w');
        return u.toString();
      }
    }
  } catch (e) { /* not a valid URL */ }
  return url;
}

// ============================================================================
// HTTP Helpers
// ============================================================================

function fetch(url) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    proto.get(url, { headers: { 'User-Agent': 'BlueRidgeCustomCo-ImageScraper/1.0' } }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return fetch(redirectUrl).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        res.resume();
        return;
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function fetchText(url) {
  const buf = await fetch(url);
  return buf.toString('utf-8');
}

// ============================================================================
// Robots.txt Parser
// ============================================================================

async function loadRobotsTxt() {
  try {
    const text = await fetchText(`${BASE_URL}/robots.txt`);
    console.log('[Scraper] robots.txt loaded');

    let isOurAgent = false;
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.toLowerCase().startsWith('user-agent:')) {
        const agent = trimmed.split(':')[1].trim();
        isOurAgent = agent === '*' || agent.toLowerCase().includes('blueridge');
      }
      if (isOurAgent && trimmed.toLowerCase().startsWith('disallow:')) {
        const disallowed = trimmed.split(':').slice(1).join(':').trim();
        if (disallowed) {
          disallowedPaths.push(disallowed);
        }
      }
    }

    console.log(`[Scraper] ${disallowedPaths.length} disallowed paths found`);
  } catch (e) {
    console.warn('[Scraper] Could not fetch robots.txt:', e.message);
  }
}

function isAllowed(urlPath) {
  for (const disallowed of disallowedPaths) {
    if (urlPath.startsWith(disallowed)) {
      return false;
    }
  }
  return true;
}

// ============================================================================
// Image Extraction
// ============================================================================

function extractImageUrls(html, pageUrl) {
  const images = new Set();

  // Match <img src="..."> and <img srcset="...">
  const imgRegex = /<img[^>]+(?:src|srcset)\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = imgRegex.exec(html)) !== null) {
    const src = match[1].split(/[,\s]/)[0]; // Take first URL from srcset
    if (src && /\.(jpg|jpeg|png|webp|gif)/i.test(src)) {
      const fullUrl = src.startsWith('http') ? src : new URL(src, pageUrl).href;
      images.add(fullUrl);
    }
  }

  // Match background-image: url(...)
  const bgRegex = /background-image\s*:\s*url\(['"]?([^'")\s]+)['"]?\)/gi;
  while ((match = bgRegex.exec(html)) !== null) {
    const src = match[1];
    if (src && /\.(jpg|jpeg|png|webp|gif)/i.test(src)) {
      const fullUrl = src.startsWith('http') ? src : new URL(src, pageUrl).href;
      images.add(fullUrl);
    }
  }

  // Match og:image and similar meta tags
  const metaRegex = /<meta[^>]+content\s*=\s*["']([^"']+\.(jpg|jpeg|png|webp))["']/gi;
  while ((match = metaRegex.exec(html)) !== null) {
    const src = match[1];
    const fullUrl = src.startsWith('http') ? src : new URL(src, pageUrl).href;
    images.add(fullUrl);
  }

  return Array.from(images);
}

function guessRoom(url, pageContext) {
  const combined = `${url} ${pageContext}`.toLowerCase();
  if (/kitchen|cook|spice|utensil/i.test(combined)) return 'kitchen';
  if (/garage|workshop|tool|wrench/i.test(combined)) return 'garage';
  if (/craft|maker|sewing|supply/i.test(combined)) return 'craft';
  if (/desk|office|pen|cable/i.test(combined)) return 'desk';
  return 'general';
}

// ============================================================================
// Main Scraper
// ============================================================================

async function scrape() {
  console.log('=== Multiboard Image Scraper ===\n');

  // Ensure output directory exists
  if (!DRY_RUN) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Load robots.txt
  await loadRobotsTxt();

  const allImages = [];
  const seenBaseUrls = new Set();  // deduplicate by base URL (sans format param)

  for (const pagePath of PAGES_TO_SCRAPE) {
    if (!isAllowed(pagePath)) {
      console.log(`  SKIP (robots.txt): ${pagePath}`);
      continue;
    }

    const pageUrl = `${BASE_URL}${pagePath}`;
    console.log(`\nScraping: ${pageUrl}`);

    try {
      const html = await fetchText(pageUrl);
      const imageUrls = extractImageUrls(html, pageUrl);
      console.log(`  Found ${imageUrls.length} images`);

      for (const imgUrl of imageUrls) {
        // Deduplicate by base URL: same image may appear as ?format=100w
        // on one page and ?format=300w on another — we only want it once.
        const baseUrl = getBaseImageUrl(imgUrl);
        if (seenBaseUrls.has(baseUrl)) {
          console.log(`  DEDUP (already seen): ${imgUrl}`);
          continue;
        }
        seenBaseUrls.add(baseUrl);

        // Check image URL path is allowed
        try {
          const urlObj = new URL(imgUrl);
          if (urlObj.hostname.includes('multiboard.io') && !isAllowed(urlObj.pathname)) {
            console.log(`  SKIP (robots.txt): ${imgUrl}`);
            continue;
          }
        } catch (e) { continue; }

        // Skip tiny icons and social media badges
        if (/favicon|icon|logo-small|badge|social/i.test(imgUrl)) continue;

        // Upgrade Squarespace CDN URLs to highest resolution
        const upgradedUrl = upgradeSquarespaceUrl(imgUrl);
        if (upgradedUrl !== imgUrl) {
          console.log(`  UPGRADE: ${imgUrl}  =>  ${upgradedUrl}`);
        }

        allImages.push({
          url: upgradedUrl,
          originalUrl: imgUrl,
          pageContext: pagePath,
          room: guessRoom(imgUrl, pagePath)
        });
      }

      // Rate limit between pages
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      console.error(`  ERROR scraping ${pageUrl}: ${e.message}`);
    }
  }

  console.log(`\nTotal unique images found: ${allImages.length}`);

  if (DRY_RUN) {
    console.log('\n[DRY RUN] Would download:');
    for (const img of allImages) {
      console.log(`  ${img.url} (${img.room})`);
    }
    return;
  }

  // ------------------------------------------------------------------
  // Clean up previous scrape: remove old files and DB rows so we can
  // re-download at full resolution without creating duplicates.
  // ------------------------------------------------------------------
  console.log('\nCleaning up previous scrape...');

  // Remove existing scraped image files (keep index.json removal for later)
  const existingFiles = fs.readdirSync(OUTPUT_DIR).filter(f => f.startsWith('mb-'));
  for (const f of existingFiles) {
    fs.unlinkSync(path.join(OUTPUT_DIR, f));
  }
  console.log(`  Removed ${existingFiles.length} old image files`);

  // Delete old DB rows for scraped images
  const rawDb = db.getDb();
  const deleteResult = rawDb.prepare(
    "DELETE FROM multiboard_media WHERE asset_type = 'scraped'"
  ).run();
  console.log(`  Removed ${deleteResult.changes} old DB rows`);

  // Download and index images
  const indexEntries = [];
  let downloaded = 0;
  let dbInserted = 0;

  for (const img of allImages) {
    try {
      const urlObj = new URL(img.url);
      const ext = path.extname(urlObj.pathname) || '.jpg';
      const filename = `mb-${downloaded + 1}${ext}`;
      const filePath = path.join(OUTPUT_DIR, filename);

      console.log(`  Downloading: ${img.url}`);
      const imageData = await fetch(img.url);

      // Skip very small images (likely icons)
      if (imageData.length < 5000) {
        console.log(`    SKIP: too small (${imageData.length} bytes)`);
        continue;
      }

      fs.writeFileSync(filePath, imageData);
      downloaded++;

      // Get dimensions if sharp is available
      let dimensions = null;
      if (sharp) {
        try {
          const meta = await sharp(filePath).metadata();
          dimensions = { width: meta.width, height: meta.height, format: meta.format };
        } catch (e) { /* ignore */ }
      }

      const entry = {
        filename,
        source_url: img.url,
        page_context: img.pageContext,
        room: img.room,
        asset_type: 'scraped',
        dimensions: dimensions,
        scraped_at: new Date().toISOString()
      };

      indexEntries.push(entry);

      // Insert into database
      try {
        db.createMultiboardMedia({
          filename,
          file_path: filePath,
          source_url: img.url,
          asset_type: 'scraped',
          pillar: null, // Will be assigned during review
          room: img.room,
          page_context: img.pageContext,
          dimensions_json: dimensions,
          ready: 0, // Needs manual review before use
          scraped_at: entry.scraped_at
        });
        dbInserted++;
      } catch (e) {
        console.error(`    DB insert error: ${e.message}`);
      }

      // Rate limit downloads
      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      console.error(`  ERROR downloading ${img.url}: ${e.message}`);
    }
  }

  // Write index.json
  const indexPath = path.join(OUTPUT_DIR, 'index.json');
  fs.writeFileSync(indexPath, JSON.stringify(indexEntries, null, 2));

  console.log(`\n=== Scrape Complete ===`);
  console.log(`Downloaded: ${downloaded} images`);
  console.log(`DB entries: ${dbInserted} rows in multiboard_media (ready=0)`);
  console.log(`Index: ${indexPath}`);
  console.log(`Output: ${OUTPUT_DIR}`);
}

// Run
scrape().then(() => {
  process.exit(0);
}).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
