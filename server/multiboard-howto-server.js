/**
 * Multiboard How-To Server
 * API routes for the how-to content library and build document generator.
 */

const fs = require('fs');
const path = require('path');
const { parseBody, sendJson, sendError } = require('./utils/http');

// Images root directory — configurable via env var, defaults to MultiBoardScraper/multiboard-images
const MULTIBOARD_IMAGES_DIR = process.env.MULTIBOARD_IMAGES_DIR
  || path.join(__dirname, '..', 'MultiBoardScraper', 'multiboard-images');

// MIME types for image serving
const MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

// Assembly order for build document generation
const ASSEMBLY_ORDER = [
  { tag: 'wall-mount',    label: '1. Wall Mounting & Tile Setup' },
  { tag: 'snaps',         label: '2. Snap Installation' },
  { tag: 'bolt-lock',     label: '3. Bolt-Locked Brackets' },
  { tag: 'multipoint',    label: '4. Multipoint Connections' },
  { tag: 'shells',        label: '5. Bins & Shells' },
  { tag: 'inserts',       label: '6. Inserts, Drawers & Tops' },
  { tag: 'assembly',      label: '7. Accessories (Hooks, Shelves, Trays)' },
];

/**
 * Handle How-To API routes
 * @param {string} pathname
 * @param {object} req
 * @param {object} res
 * @param {object} db - Database module
 * @returns {boolean}
 */
async function handleHowtoRoute(pathname, req, res, db) {
  const basePath = '/api/howtos';

  if (!pathname.startsWith(basePath)) {
    return false;
  }

  const route = pathname.slice(basePath.length) || '/';

  // ── GET /api/howtos — List all howtos (with optional filters) ──
  if (req.method === 'GET' && route === '/') {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const filters = {};
      if (url.searchParams.get('category')) filters.category = url.searchParams.get('category');
      if (url.searchParams.get('tag')) filters.tag = url.searchParams.get('tag');
      if (url.searchParams.get('slug')) filters.slug = url.searchParams.get('slug');
      const howtos = db.listHowtos(filters);
      sendJson(res, 200, { howtos });
    } catch (err) {
      console.error('[Howtos] List error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // ── POST /api/howtos/for-design — Howtos for a full design ──
  if (req.method === 'POST' && route === '/for-design') {
    try {
      const body = await parseBody(req);
      const partIds = body.part_ids || [];
      if (!Array.isArray(partIds)) {
        sendError(res, 400, 'part_ids must be an array');
        return true;
      }
      const result = db.getHowtosForDesign(partIds);
      sendJson(res, 200, result);
    } catch (err) {
      console.error('[Howtos] For-design error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // ── POST /api/howtos/build-doc — Generate build document for a design ──
  if (req.method === 'POST' && route === '/build-doc') {
    try {
      const body = await parseBody(req);
      const partIds = body.part_ids || [];
      const partsList = body.parts_list || []; // [{partId, name, qty}]
      const designName = body.design_name || 'Multiboard Design';
      const format = body.format || 'html'; // 'html' or 'markdown'
      const designTags = body.tags || []; // tags derived from placed part types

      let result;
      if (designTags.length > 0) {
        // Match howtos by tag (preferred — works for all part types)
        result = db.getHowtosForTags(designTags);
      } else if (partIds.length > 0) {
        // Fallback: match by catalog part IDs
        result = db.getHowtosForDesign(partIds);
      } else {
        result = { howtos: [], images: [], videos: [] };
      }
      // Derive base URL for absolute image paths in the HTML document
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const host = req.headers['host'] || 'store.swayzecustomvinyl.com';
      const baseUrl = `${proto}://${host}`;
      const doc = generateBuildDoc(designName, partsList, result, format, baseUrl);
      sendJson(res, 200, { document: doc, format });
    } catch (err) {
      console.error('[Howtos] Build-doc error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // ── GET /api/howtos/images/:filename — Serve howto images ──
  const imageMatch = route.match(/^\/images\/(.+)$/);
  if (req.method === 'GET' && imageMatch) {
    const filename = decodeURIComponent(imageMatch[1]);
    // Security: prevent path traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      sendError(res, 400, 'Invalid filename');
      return true;
    }
    const filePath = path.join(MULTIBOARD_IMAGES_DIR, filename);
    if (!fs.existsSync(filePath)) {
      sendError(res, 404, 'Image not found');
      return true;
    }
    const ext = path.extname(filename).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*'
    });
    fs.createReadStream(filePath).pipe(res);
    return true;
  }

  // ── GET /api/howtos/for-part/:partId — Howtos for a specific part ──
  const forPartMatch = route.match(/^\/for-part\/(\d+)$/);
  if (req.method === 'GET' && forPartMatch) {
    try {
      const partId = parseInt(forPartMatch[1]);
      const howtos = db.getHowtosForPart(partId);
      sendJson(res, 200, { howtos });
    } catch (err) {
      console.error('[Howtos] For-part error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  // ── GET /api/howtos/:slug — Single howto with images and videos ──
  const slugMatch = route.match(/^\/([a-zA-Z0-9_-]+)$/);
  if (req.method === 'GET' && slugMatch) {
    try {
      const slug = slugMatch[1];
      const result = db.getHowtoBySlug(slug);
      if (!result) {
        sendError(res, 404, 'Howto not found');
        return true;
      }
      sendJson(res, 200, result);
    } catch (err) {
      console.error('[Howtos] Get slug error:', err);
      sendError(res, 500, err.message);
    }
    return true;
  }

  return false;
}

// ─────────────────────────────────────────────────────────
// BUILD DOCUMENT GENERATOR
// ─────────────────────────────────────────────────────────

/**
 * Generate a build document from design parts and matched howtos.
 * @param {string} designName
 * @param {Array} partsList - [{partId, name, qty, unitPrice?}]
 * @param {object} howtosResult - {howtos, images, videos} from getHowtosForDesign
 * @param {string} format - 'html' or 'markdown'
 * @returns {string}
 */
function generateBuildDoc(designName, partsList, howtosResult, format, baseUrl = '') {
  const { howtos, images, videos } = howtosResult;

  // Build image lookup: slug → [images]
  const imagesBySlugs = {};
  for (const img of images) {
    if (!imagesBySlugs[img.howto_slug]) imagesBySlugs[img.howto_slug] = [];
    imagesBySlugs[img.howto_slug].push(img);
  }

  // Sort howtos by assembly order, then by slug
  const tagOrder = {};
  ASSEMBLY_ORDER.forEach((step, i) => { tagOrder[step.tag] = i; });
  const sortedHowtos = [...howtos].sort((a, b) => {
    const aTags = JSON.parse(a.tags || '[]');
    const bTags = JSON.parse(b.tags || '[]');
    const aOrder = Math.min(...aTags.map(t => tagOrder[t] ?? 99));
    const bOrder = Math.min(...bTags.map(t => tagOrder[t] ?? 99));
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.slug.localeCompare(b.slug);
  });

  // Filter to page-level howtos only (sections are included inline via parent)
  const pageHowtos = sortedHowtos.filter(h => h.level === 'page');
  const sectionHowtos = sortedHowtos.filter(h => h.level !== 'page');

  // Determine which assembly steps are relevant
  const allTags = new Set();
  howtos.forEach(h => {
    const tags = JSON.parse(h.tags || '[]');
    tags.forEach(t => allTags.add(t));
  });
  const relevantSteps = ASSEMBLY_ORDER.filter(step => allTags.has(step.tag));

  if (format === 'markdown') {
    return generateMarkdown(designName, partsList, pageHowtos, sectionHowtos, imagesBySlugs, videos, relevantSteps, baseUrl);
  }
  return generateHtml(designName, partsList, pageHowtos, sectionHowtos, imagesBySlugs, videos, relevantSteps, baseUrl);
}

function generateMarkdown(designName, partsList, pageHowtos, sectionHowtos, imagesBySlugs, videos, relevantSteps, baseUrl = '') {
  let md = `# Build Guide: ${designName}\n\n`;

  // Parts list
  md += `## Parts in This Design\n\n`;
  for (const p of partsList) {
    md += `- **${p.name}** x ${p.qty}${p.unitPrice ? ` ($${p.unitPrice.toFixed(2)} each)` : ''}\n`;
  }
  md += '\n';

  // How-To Guides
  if (pageHowtos.length > 0) {
    md += `## How-To Guides\n\n`;
    for (const h of pageHowtos) {
      md += `### ${h.title}\n\n`;
      if (h.content) {
        md += h.content.trim() + '\n\n';
      }
      // Inline images
      const imgs = imagesBySlugs[h.slug] || [];
      const contentImgs = imgs.filter(i => !i.filename.includes('logo'));
      for (const img of contentImgs) {
        md += `![${img.alt || img.caption || ''}](${baseUrl}/api/howtos/images/${img.filename})\n`;
        if (img.caption) md += `*${img.caption}*\n`;
        md += '\n';
      }
      // Child sections
      const children = sectionHowtos.filter(s => s.parent === h.slug);
      for (const child of children) {
        md += `#### ${child.title}\n\n`;
        if (child.content) md += child.content.trim() + '\n\n';
      }
    }
  }

  // Assembly Order
  if (relevantSteps.length > 0) {
    md += `## Assembly Order\n\n`;
    for (const step of relevantSteps) {
      md += `- ${step.label}\n`;
    }
    md += '\n';
  }

  // Videos
  if (videos.length > 0) {
    md += `## Video Tutorials\n\n`;
    for (const v of videos) {
      md += `- [${v.title}](${v.url})`;
      if (v.description) md += ` — ${v.description}`;
      md += '\n';
    }
    md += '\n';
  }

  return md;
}

function generateHtml(designName, partsList, pageHowtos, sectionHowtos, imagesBySlugs, videos, relevantSteps, baseUrl = '') {
  let html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Build Guide: ${esc(designName)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; color: #222; line-height: 1.6; }
  h1 { color: #1565C0; border-bottom: 2px solid #1565C0; padding-bottom: 8px; }
  h2 { color: #333; margin-top: 30px; }
  h3 { color: #555; margin-top: 20px; }
  h4 { color: #666; }
  .parts-list { background: #f5f5f5; padding: 16px; border-radius: 8px; }
  .parts-list li { margin-bottom: 4px; }
  .howto-section { margin-bottom: 30px; padding: 16px; border: 1px solid #e0e0e0; border-radius: 8px; }
  .howto-content { white-space: pre-line; }
  .howto-images { display: flex; flex-wrap: wrap; gap: 10px; margin: 12px 0; }
  .howto-images img { max-width: 350px; border-radius: 6px; border: 1px solid #ddd; }
  .howto-images figcaption { font-size: 12px; color: #888; text-align: center; }
  .assembly-order { background: #e8f5e9; padding: 16px; border-radius: 8px; }
  .assembly-order ol { margin: 0; padding-left: 20px; }
  .video-list a { color: #1565C0; text-decoration: none; }
  .video-list a:hover { text-decoration: underline; }
  .video-desc { color: #666; font-size: 14px; }
  .no-print { margin-bottom: 16px; text-align: right; }
  @media print { body { max-width: 100%; } .howto-images img { max-width: 250px; } .no-print { display: none; } }
</style>
</head>
<body>
<div class="no-print">
  <button onclick="window.print()" style="padding:8px 20px;background:#1565C0;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:14px;">Print / Save PDF</button>
</div>
<h1>Build Guide: ${esc(designName)}</h1>
`;

  // Parts list
  html += `<h2>Parts in This Design</h2>\n<div class="parts-list"><ul>\n`;
  for (const p of partsList) {
    html += `  <li><strong>${esc(p.name)}</strong> &times; ${p.qty}${p.unitPrice ? ` ($${p.unitPrice.toFixed(2)} each)` : ''}</li>\n`;
  }
  html += `</ul></div>\n`;

  // How-To Guides
  if (pageHowtos.length > 0) {
    html += `<h2>How-To Guides</h2>\n`;
    for (const h of pageHowtos) {
      html += `<div class="howto-section">\n`;
      html += `  <h3>${esc(h.title)}</h3>\n`;
      if (h.content) {
        html += `  <div class="howto-content">${esc(h.content.trim())}</div>\n`;
      }
      // Images
      const imgs = (imagesBySlugs[h.slug] || []).filter(i => !i.filename.includes('logo'));
      if (imgs.length > 0) {
        html += `  <div class="howto-images">\n`;
        for (const img of imgs) {
          html += `    <figure><img src="${baseUrl}/api/howtos/images/${esc(img.filename)}" alt="${esc(img.alt || img.caption || '')}" loading="lazy">`;
          if (img.caption) html += `<figcaption>${esc(img.caption)}</figcaption>`;
          html += `</figure>\n`;
        }
        html += `  </div>\n`;
      }
      // Child sections
      const children = sectionHowtos.filter(s => s.parent === h.slug);
      for (const child of children) {
        html += `  <h4>${esc(child.title)}</h4>\n`;
        if (child.content) html += `  <div class="howto-content">${esc(child.content.trim())}</div>\n`;
      }
      html += `</div>\n`;
    }
  }

  // Assembly Order
  if (relevantSteps.length > 0) {
    html += `<h2>Assembly Order</h2>\n<div class="assembly-order"><ol>\n`;
    for (const step of relevantSteps) {
      html += `  <li>${esc(step.label)}</li>\n`;
    }
    html += `</ol></div>\n`;
  }

  // Videos
  if (videos.length > 0) {
    html += `<h2>Video Tutorials</h2>\n<div class="video-list"><ul>\n`;
    for (const v of videos) {
      html += `  <li><a href="${esc(v.url)}" target="_blank">${esc(v.title)}</a>`;
      if (v.description) html += ` <span class="video-desc">— ${esc(v.description)}</span>`;
      html += `</li>\n`;
    }
    html += `</ul></div>\n`;
  }

  html += `</body></html>`;
  return html;
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = { handleHowtoRoute, MULTIBOARD_IMAGES_DIR };
