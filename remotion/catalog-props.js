#!/usr/bin/env node
/**
 * Catalog Props Helper
 * Fetches artwork/mockups from vinylApp and generates Remotion props JSON
 *
 * Usage:
 *   node catalog-props.js artwork [category] [limit]
 *   node catalog-props.js mockups [campaignSlug] [limit]
 *   node catalog-props.js categories
 *   node catalog-props.js showcase <category> [limit]  — full CatalogShowcase props
 *   node catalog-props.js reel <campaignSlug> [limit]  — full MockupReel props
 */

const http = require('http');
const path = require('path');

const API_BASE = 'http://localhost:4000';
const API_KEY = process.env.INTERNAL_API_KEY || 'laZHEthV92qDq0adO07UnqoH3O4baZmV';

function fetch(urlPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, API_BASE);
    http.get(url, { headers: { 'x-api-key': API_KEY } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(data)); }
      });
    }).on('error', reject);
  });
}

function assetUrl(filePath) {
  if (!filePath) return '';
  if (filePath.startsWith('http')) return filePath;
  if (filePath.startsWith('library/')) return `${API_BASE}/${filePath}`;
  if (filePath.startsWith('/mnt/websit/')) return `${API_BASE}/library/${filePath.replace('/mnt/websit/', '')}`;
  if (filePath.startsWith('/mnt/dbFiles/')) return `${API_BASE}/library/dbfiles/${filePath.replace('/mnt/dbFiles/', '')}`;
  return `${API_BASE}/${filePath}`;
}

async function main() {
  const [,, cmd, arg1, arg2] = process.argv;

  if (!cmd || cmd === 'help') {
    console.log(`
Catalog Props Helper — generate Remotion props from your catalog

  node catalog-props.js categories                    List all artwork categories
  node catalog-props.js artwork [category] [limit]    List artwork items
  node catalog-props.js mockups [campaign] [limit]    List mockup items
  node catalog-props.js showcase <category> [limit]   Generate CatalogShowcase props JSON
  node catalog-props.js reel <campaign> [limit]       Generate MockupReel props JSON
`);
    return;
  }

  if (cmd === 'categories') {
    const data = await fetch('/api/custom-art/artwork/categories');
    console.log('\nCategories:');
    for (const c of data.categories) {
      if (typeof c === 'string') {
        console.log(`  ${c}`);
      } else {
        console.log(`  ${c.category} (${c.count} items)`);
      }
    }
    return;
  }

  if (cmd === 'artwork') {
    const params = new URLSearchParams({ activeOnly: 'false', limit: arg2 || '20' });
    if (arg1) params.set('category', arg1);
    const data = await fetch(`/api/custom-art/artwork?${params}`);
    console.log(`\n${data.artwork.length} artwork items${arg1 ? ` in "${arg1}"` : ''}:\n`);
    for (const a of data.artwork) {
      console.log(`  ${a.id}  ${a.title || '(untitled)'}  [${a.theme}/${a.mood}]`);
      console.log(`    → ${assetUrl(a.thumbnailPath || a.filePath)}`);
    }
    return;
  }

  if (cmd === 'mockups') {
    const params = new URLSearchParams({ activeOnly: 'false' });
    if (arg1) params.set('campaignSlug', arg1);
    const data = await fetch(`/api/custom-art/mockups?${params}`);
    const mockups = Array.isArray(data) ? data : data.mockups || [];
    const limited = mockups.slice(0, Number(arg2) || 20);
    console.log(`\n${limited.length} mockups${arg1 ? ` for campaign "${arg1}"` : ''}:\n`);
    for (const m of limited) {
      console.log(`  #${m.id}  ${m.garment_type || 'unknown'} ${m.clothing_color || ''}`);
      console.log(`    → ${assetUrl(m.file_path)}`);
    }
    return;
  }

  if (cmd === 'showcase') {
    const category = arg1;
    const limit = Number(arg2) || 6;
    if (!category) {
      console.error('Usage: node catalog-props.js showcase <category> [limit]');
      process.exit(1);
    }
    const params = new URLSearchParams({ activeOnly: 'false', limit: String(limit), category });
    const data = await fetch(`/api/custom-art/artwork?${params}`);
    const artwork = data.artwork || [];

    const props = {
      title: category.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      subtitle: 'Made in Asheville, NC',
      images: artwork.map(a => assetUrl(a.thumbnailPath || a.filePath)),
      names: artwork.map(a => a.title || ''),
      bgStart: '#0f0c29',
      bgEnd: '#302b63',
      accent: '#e94560',
      showCta: true,
      ctaText: 'Shop Now →',
      categoryBadge: category.replace(/-/g, ' '),
    };

    console.log('\n--- CatalogShowcase Props ---\n');
    console.log(JSON.stringify(props, null, 2));
    return;
  }

  if (cmd === 'reel') {
    const campaign = arg1;
    const limit = Number(arg2) || 8;
    if (!campaign) {
      console.error('Usage: node catalog-props.js reel <campaignSlug> [limit]');
      process.exit(1);
    }
    const params = new URLSearchParams({ activeOnly: 'false', campaignSlug: campaign });
    const data = await fetch(`/api/custom-art/mockups?${params}`);
    const mockups = (Array.isArray(data) ? data : data.mockups || []).slice(0, limit);

    const props = {
      mockupImages: mockups.map(m => assetUrl(m.file_path)),
      labels: mockups.map(m => [m.garment_type, m.clothing_color].filter(Boolean).join(' - ')),
      hookText: 'Check out our latest drops',
      brandName: 'BlueRidge Custom Co.',
      location: 'Asheville, NC',
      bgColor: '#111111',
      accent: '#ff6b35',
      transition: 'zoom',
    };

    console.log('\n--- MockupReel Props ---\n');
    console.log(JSON.stringify(props, null, 2));
    return;
  }

  console.error(`Unknown command: ${cmd}. Run with "help" for usage.`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
