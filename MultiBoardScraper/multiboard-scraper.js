#!/usr/bin/env node
/**
 * Multiboard How-To Scraper
 * ─────────────────────────
 * Run this locally (where you have browser access to docs.multiboard.io).
 * Scrapes text + image URLs from the Knowledge Hub and outputs a structured
 * JSON seed file for Claude Code to use to populate your print-station DB.
 *
 * Usage:
 *   npm install axios cheerio
 *   node multiboard-scraper.js
 *
 * Output:
 *   multiboard-howtos-seed.json   ← hand this to Claude Code
 *   /images/                      ← all scraped images saved locally
 */

const axios  = require('axios');
const cheerio = require('cheerio');
const fs     = require('fs');
const path   = require('path');
const https  = require('https');
const http   = require('http');

// ── Config ────────────────────────────────────────────────────────────────
const BASE_URL    = 'https://docs.multiboard.io';
const OUTPUT_JSON = path.join(__dirname, 'multiboard-howtos-seed.json');
const IMAGE_DIR   = path.join(__dirname, 'multiboard-images');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Referer': 'https://docs.multiboard.io/',
};

// All known doc pages to scrape
const PAGES = [
  {
    url:      '/beginner-section/core-parts-documentation',
    slug:     'core-parts',
    title:    'Core Parts Documentation',
    category: 'reference',
    tags:     ['tiles', 'snaps', 'shells', 'multibin', 'multipoint', 'threads', 'peg-click'],
  },
  {
    url:      '/beginner-section/common-connections',
    slug:     'common-connections',
    title:    'Common Connections',
    category: 'howto',
    tags:     ['connections', 'assembly', 'diagram'],
  },
  {
    url:      '/beginner-section/printing-guidelines',
    slug:     'printing-guidelines',
    title:    'Printing Guidelines',
    category: 'printing',
    tags:     ['print-settings', 'stack-printing', 'ironing', 'material'],
  },
  {
    url:      '/beginner-section/tile-mounting-guide',
    slug:     'tile-mounting-guide',
    title:    'Tile Mounting Guide',
    category: 'howto',
    tags:     ['mounting', 'wall-mount', 'ds-snaps', 'offset-snaps', 'cleat'],
  },
  {
    url:      '/beginner-section/learning-packs',
    slug:     'learning-packs',
    title:    'Learning Packs',
    category: 'reference',
    tags:     ['learning', 'packs', 'video-tutorials'],
  },
  {
    url:      '/',
    slug:     'get-started',
    title:    'Get Started',
    category: 'reference',
    tags:     ['overview', 'beginner'],
  },
];

// Known images from core-parts page (hashes extracted from live page source)
// These are used as fallback if scraping doesn't find them
const KNOWN_IMAGES = [
  { filename: 'multiboard_common-connections-4b433970f396897c7f5d5432da71b3f1.png',   topic: 'common-connections',  caption: 'Common Connections Diagram' },
  { filename: 'multiboard_1-multiboard_tile-655f60acf9bcdee82d2a5b358351b0d1.png',    topic: 'core-parts',          caption: 'Multiboard Tile' },
  { filename: 'multiboard_2-snaps-b-640750d0e2b392393ba1d82002579d5a.png',            topic: 'core-parts',          caption: 'Snap Types' },
  { filename: 'multiboard_3-bolt-locked-friction-fit-921de339879fcaf9e2a92cfcb438568b.png', topic: 'core-parts',  caption: 'Bolt-Locked and Friction-Fit Inserts' },
  { filename: 'multiboard_4-peg-click-0fd61d53683097c8ccfd6a508986aa33.png',          topic: 'core-parts',          caption: 'Peg Click' },
  { filename: 'multiboard_5-threads-d5883d597a863d340b1bc1b8500f730c.png',            topic: 'core-parts',          caption: 'Thread Types' },
  { filename: 'multiboard_6-1-6-2-shell-7f599f6fd4f5317862c8de2ecfc9b377.png',        topic: 'core-parts',          caption: 'Multibin Shell' },
  { filename: 'multiboard_6-3-shell-8da119a205dcba6bb29fd50528487081.png',            topic: 'core-parts',          caption: 'Shell Base' },
  { filename: 'multiboard_6-4-shell-2-04b0dd73694662134a3a118c1bc70c9f.png',          topic: 'core-parts',          caption: 'Multipoint Rail Wall' },
  { filename: 'multiboard_7-multibin-plates-0e579d21af1c9dde7b14f9ff0e1b58f3.png',    topic: 'core-parts',          caption: 'Multibin Plates' },
  { filename: 'multiboard_8-inserts-9b5c31ae1225db9b55c79ed5dc51e8ff.png',            topic: 'core-parts',          caption: 'Multibin Inserts' },
  { filename: 'multiboard_poster-test-11-1--68a307f05b82b1b8e8355b77c81b898f.png',    topic: 'core-parts',          caption: 'Core Parts Poster' },
];

// ── Helpers ───────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchPage(url) {
  try {
    const res = await axios.get(url, { headers: HEADERS, timeout: 15000 });
    return res.data;
  } catch (err) {
    console.warn(`  ⚠ Could not fetch ${url}: ${err.message}`);
    return null;
  }
}

function downloadImage(url, destPath) {
  return new Promise((resolve) => {
    if (fs.existsSync(destPath)) {
      resolve({ success: true, cached: true });
      return;
    }
    const proto = url.startsWith('https') ? https : http;
    const file  = fs.createWriteStream(destPath);
    const req   = proto.get(url, { headers: HEADERS }, (res) => {
      if (res.statusCode === 200) {
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve({ success: true }); });
      } else {
        file.close();
        fs.unlink(destPath, () => {});
        resolve({ success: false, status: res.statusCode });
      }
    });
    req.on('error', (e) => {
      fs.unlink(destPath, () => {});
      resolve({ success: false, error: e.message });
    });
    req.setTimeout(15000, () => {
      req.destroy();
      resolve({ success: false, error: 'timeout' });
    });
  });
}

// Extract sections from scraped HTML
function extractSections($, pageSlug) {
  const sections = [];
  let currentH2 = null;
  let currentH3 = null;
  let buffer    = [];

  const flushBuffer = (parentSlug, level) => {
    if (buffer.length === 0) return;
    const text = buffer.join('\n').trim();
    if (text.length > 20) {
      const target = level === 'h3' ? currentH3 : currentH2;
      if (target) target.content = (target.content || '') + '\n' + text;
    }
    buffer = [];
  };

  $('article, .theme-doc-markdown, main').first().find('h1, h2, h3, h4, p, ul, ol, li, table').each((i, el) => {
    const tag  = el.tagName.toLowerCase();
    const text = $(el).text().trim();

    if (tag === 'h1') {
      // Skip top-level title, already in page metadata
      return;
    }

    if (tag === 'h2') {
      flushBuffer(pageSlug, 'h2');
      currentH2 = {
        slug:     `${pageSlug}--${text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
        title:    text,
        level:    'h2',
        parent:   pageSlug,
        content:  '',
        images:   [],
      };
      currentH3 = null;
      sections.push(currentH2);
      return;
    }

    if (tag === 'h3') {
      flushBuffer(pageSlug, 'h3');
      currentH3 = {
        slug:     `${pageSlug}--${text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
        title:    text,
        level:    'h3',
        parent:   currentH2 ? currentH2.slug : pageSlug,
        content:  '',
        images:   [],
      };
      sections.push(currentH3);
      return;
    }

    if (['p', 'li'].includes(tag) && text.length > 5) {
      buffer.push(text);
    }
  });

  flushBuffer(pageSlug, 'h2');
  return sections;
}

// Find all image URLs on a page
function extractImages($, pageSlug) {
  const images = [];
  $('img').each((i, el) => {
    let src = $(el).attr('src') || '';
    if (!src) return;
    if (src.startsWith('/')) src = BASE_URL + src;
    if (!src.includes('multiboard')) return; // skip logos etc
    const alt      = $(el).attr('alt') || '';
    const filename = path.basename(src.split('?')[0]);
    images.push({ src, filename, alt, topic: pageSlug });
  });
  return images;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('Multiboard How-To Scraper');
  console.log('═'.repeat(50));

  // Ensure image dir exists
  if (!fs.existsSync(IMAGE_DIR)) fs.mkdirSync(IMAGE_DIR, { recursive: true });

  const seed = {
    meta: {
      generated_at:  new Date().toISOString(),
      source:        BASE_URL,
      description:   'Multiboard how-to content seed for print-station DB. Generated by multiboard-scraper.js.',
      image_dir:     './multiboard-images/',
      instructions:  [
        'Pass this file to Claude Code with the instruction:',
        '"Populate the multiboard_howtos and multiboard_howto_images tables using this seed file."',
        'Images are stored locally in ./multiboard-images/ relative to this file.',
        'local_path in each image record is the filename within that directory.',
      ],
    },
    howtos:        [],  // one record per doc page + per section
    images:        [],  // one record per image
    youtube_links: [],  // assembly tutorial videos
  };

  // ── Known YouTube links ──────────────────────────────────────────────
  seed.youtube_links = [
    {
      slug:        'tile-learning-pack-assembly',
      title:       'Multiboard Tile Learning Pack — Assembly Tutorial',
      url:         'https://youtu.be/Oge0fgVxRHY',
      topic_tags:  ['tiles', 'snaps', 'assembly', 'bolt-lock', 'friction-fit'],
      description: 'Official video walkthrough of the Tile Learning Pack. Covers snaps, inserts, peg clicks, and tile wall mounting.',
    },
    {
      slug:        'multibin-learning-pack-assembly',
      title:       'Multibin Learning Pack — Assembly Tutorial',
      url:         'https://youtu.be/hd5f1XGMeTs',
      topic_tags:  ['multibin', 'shells', 'inserts', 'drawers', 'multipoint', 'assembly'],
      description: 'Official video walkthrough of the Multibin Learning Pack. Covers shells, inserts, drawers, tops, and multipoint connections.',
    },
    {
      slug:        'stack-printing-ironing',
      title:       'Stack Printing — Ironing Method',
      url:         'https://www.youtube.com/watch?v=xs2urfM0MRM',
      topic_tags:  ['printing', 'stack-printing', 'ironing', 'tiles'],
      description: 'How to set up and tune ironing stack printing for batch tile production.',
    },
    {
      slug:        'on-grid-update-overview',
      title:       'On-Grid Update Overview',
      url:         'https://youtu.be/me-3o1WuwBw',
      topic_tags:  ['update', 'grid', 'offset-snaps', 'beams', 'border-tiles'],
      description: 'Overview of the major On-Grid update — new parts, updated snaps, beams, border tiles.',
    },
  ];

  // ── Scrape each page ─────────────────────────────────────────────────
  for (const page of PAGES) {
    const fullUrl = BASE_URL + page.url;
    console.log(`\nScraping: ${fullUrl}`);

    const html = await fetchPage(fullUrl);
    await sleep(1200); // be polite

    // Page-level howto record
    const pageRecord = {
      slug:        page.slug,
      title:       page.title,
      category:    page.category,
      tags:        page.tags,
      source_url:  fullUrl,
      level:       'page',
      parent:      null,
      content:     '',
      images:      [],
      sections:    [],
    };

    if (html) {
      const $ = cheerio.load(html);

      // Extract main content text
      const mainText = $('article, .theme-doc-markdown, main').first().text().trim();
      pageRecord.content = mainText.substring(0, 3000); // cap at 3k chars

      // Extract sections
      const sections = extractSections($, page.slug);
      pageRecord.sections = sections.map(s => s.slug);
      seed.howtos.push(...sections.map(s => ({ ...s, source_url: fullUrl, category: page.category, tags: page.tags })));

      // Extract images from page
      const pageImages = extractImages($, page.slug);
      pageRecord.images = pageImages.map(i => i.filename);

      for (const img of pageImages) {
        const localPath = path.join(IMAGE_DIR, img.filename);
        console.log(`  ↓ ${img.filename}`);
        const result = await downloadImage(img.src, localPath);
        console.log(`    ${result.success ? (result.cached ? '✓ cached' : '✓ saved') : `✗ failed (${result.status || result.error})`}`);

        seed.images.push({
          filename:    img.filename,
          source_url:  img.src,
          local_path:  img.filename,
          alt:         img.alt,
          topic:       img.topic,
          caption:     img.alt || img.filename.replace(/-[a-f0-9]{32}\.png$/, '').replace(/_/g, ' '),
          downloaded:  result.success,
        });
      }

      console.log(`  ✓ ${sections.length} sections, ${pageImages.length} images found on page`);
    } else {
      console.log('  ✗ Page fetch failed — record will have empty content');
    }

    seed.howtos.unshift(pageRecord);
  }

  // ── Attempt known images that scraper may have missed ─────────────────
  console.log('\nAttempting known image list...');
  const alreadyHave = new Set(seed.images.map(i => i.filename));

  for (const img of KNOWN_IMAGES) {
    if (alreadyHave.has(img.filename)) continue;

    const src       = `${BASE_URL}/assets/images/${img.filename}`;
    const localPath = path.join(IMAGE_DIR, img.filename);
    console.log(`  ↓ ${img.filename}`);
    const result = await downloadImage(src, localPath);
    console.log(`    ${result.success ? '✓ saved' : `✗ failed (${result.status || result.error})`}`);

    seed.images.push({
      filename:   img.filename,
      source_url: src,
      local_path: img.filename,
      alt:        img.caption,
      topic:      img.topic,
      caption:    img.caption,
      downloaded: result.success,
    });
  }

  // ── Write seed file ───────────────────────────────────────────────────
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(seed, null, 2));

  // ── Summary ───────────────────────────────────────────────────────────
  const downloaded  = seed.images.filter(i => i.downloaded).length;
  const failed      = seed.images.filter(i => !i.downloaded).length;

  console.log('\n' + '═'.repeat(50));
  console.log('Done!');
  console.log(`  Howto records : ${seed.howtos.length}`);
  console.log(`  Images total  : ${seed.images.length}`);
  console.log(`  Downloaded    : ${downloaded}`);
  console.log(`  Failed        : ${failed}`);
  console.log(`  YouTube links : ${seed.youtube_links.length}`);
  console.log(`\n  Seed file → ${OUTPUT_JSON}`);
  console.log(`  Images    → ${IMAGE_DIR}/`);

  if (failed > 0) {
    console.log('\n  ⚠ Some images failed (likely Cloudflare blocked).');
    console.log('  Open the URLs below in your browser and save manually:');
    seed.images.filter(i => !i.downloaded).forEach(i => {
      console.log(`    ${i.source_url}`);
      console.log(`    → Save as: multiboard-images/${i.filename}`);
    });
  }

  console.log('\n  Hand multiboard-howtos-seed.json to Claude Code with:');
  console.log('  "Create the multiboard_howtos and multiboard_howto_images tables');
  console.log('   and seed them from this file. Images are in ./multiboard-images/"');
}

main().catch(console.error);
