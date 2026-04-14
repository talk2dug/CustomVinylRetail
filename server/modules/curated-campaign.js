/**
 * Curated Drop Campaign Module
 *
 * Creates limited-run, premium apparel campaigns using S&S Activewear products
 * paired with specific designs. Generates mockups, marketing copy, and publishes
 * to Shopify with scarcity/urgency positioning.
 */

const fs = require('fs');
const path = require('path');
const ssaw = require('../vendor-ssaw.js');

const OUTPUT_DIR = path.join(__dirname, '..', '..', 'data', 'curated-drops');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// ── Limited Drop Marketing Copy ──────────────────────────────────────────────

const DROP_COPY = {
  'moto-garage': {
    hooks: [
      'Only {qty} ever made.',
      'Built for the ride. Limited drop.',
      'Once they\'re gone, they\'re gone.',
      'Not sold in stores. Ever.',
      '{qty} pieces. That\'s it.'
    ],
    body: [
      'Handcrafted in Asheville, NC. Premium heavyweight apparel with custom screen-printed artwork. This is a one-time limited run — when it sells out, it\'s retired forever.',
      'Small batch. Big attitude. Each piece is printed by hand in our Asheville studio on premium blank apparel. No restocks, no reruns.',
      'From our studio in the Blue Ridge Mountains to your door. Premium fabric, original artwork, limited quantity. This drop won\'t come back.'
    ],
    ctas: [
      'Grab yours before they\'re gone →',
      'Shop the drop',
      'Don\'t sleep on this',
      'Claim yours now',
      'Limited run — shop now'
    ],
    vibes: ['raw', 'rebellious', 'authentic'],
    adHooks: [
      'POV: You found the coolest hoodie that only {qty} people will ever own',
      'We made {qty} of these and they\'re already moving fast',
      'This design on this {garment}? Yeah, we only made {qty}.',
      'Small batch drop from Asheville, NC. {qty} pieces. No restock.'
    ]
  },
  'retro-vintage': {
    hooks: [
      'Limited edition. {qty} made.',
      'Old soul, new drop.',
      'Vintage vibes, limited run.',
      'They don\'t make \'em like this anymore.',
      '{qty} pieces. Hand-printed in Asheville.'
    ],
    body: [
      'Retro-inspired artwork on premium blank apparel. Handmade in our Asheville, NC studio. Limited to {qty} pieces — once they\'re gone, they\'re retired.',
      'Throwback style meets modern quality. Printed by hand on heavyweight apparel in the Blue Ridge Mountains. This is a one-time drop.',
      'Vintage-inspired, locally made, and extremely limited. Each piece from this collection is numbered and won\'t be reprinted.'
    ],
    ctas: [
      'Shop the limited drop',
      'Get yours while they last',
      'Don\'t miss this one',
      'Grab it before it\'s gone →',
      'Limited run — claim yours'
    ],
    vibes: ['nostalgic', 'warm', 'authentic'],
    adHooks: [
      'We paired this vintage design with a {garment} and only made {qty}',
      'Limited drop alert 🚨 {qty} pieces, handmade in Asheville NC',
      'This retro design hits different on a premium {garment}',
      'When it\'s gone it\'s gone. {qty} made. Zero restocks.'
    ]
  },
  'edgy-urban': {
    hooks: [
      '{qty} pieces. No restocks.',
      'Street-ready. Limited drop.',
      'Not for everyone. Only {qty} made.',
      'Exclusive drop. Asheville-made.',
      'Limited run. Big energy.'
    ],
    body: [
      'Bold artwork on premium heavyweight blanks. Handprinted in our Asheville studio. This is a limited drop of {qty} — no reprints, no exceptions.',
      'Street-level art meets mountain-made quality. Each piece is hand-printed in Asheville, NC on premium apparel. When they sell out, they\'re done.',
      'Raw, unapologetic design on the heaviest blanks we could find. Limited to {qty}. Made in Asheville.'
    ],
    ctas: [
      'Cop yours now',
      'Limited drop — don\'t sleep',
      'Shop before it\'s gone',
      '{qty} left. Get yours.',
      'Exclusive drop → shop now'
    ],
    vibes: ['bold', 'raw', 'exclusive'],
    adHooks: [
      'This {garment} goes hard and we only made {qty} of them',
      'Drop alert: {qty} pieces, handmade in Asheville NC, no restock',
      'When we say limited we mean LIMITED. {qty} total. That\'s it.',
      'Street art meets premium apparel. {qty} made. Asheville, NC.'
    ]
  },
  'outdoor-adventure': {
    hooks: [
      'Made in the mountains. Limited to {qty}.',
      'Adventure-ready. {qty} ever printed.',
      'From our studio in the Blue Ridge.',
      'Limited edition outdoor drop.',
      '{qty} pieces. Mountain-made.'
    ],
    body: [
      'Designed and printed in the heart of the Blue Ridge Mountains. Premium heavyweight apparel with original outdoor artwork. Limited to just {qty} pieces.',
      'From Asheville, NC with love. Each piece is hand-printed on premium blanks with artwork inspired by the outdoors. This is a one-time run.',
      'Mountain-made, adventure-ready. Original artwork on premium apparel, limited to {qty}. When they\'re gone, they\'re retired.'
    ],
    ctas: [
      'Shop the mountain drop',
      'Gear up — limited run',
      'Grab yours before they\'re gone',
      'Adventure awaits → shop now',
      'Only {qty} made. Get yours.'
    ],
    vibes: ['rugged', 'authentic', 'adventurous'],
    adHooks: [
      'We printed {qty} of these in our mountain studio and that\'s all we\'re making',
      'Premium outdoor gear, handmade in Asheville NC. {qty} pieces.',
      'This design on a heavyweight {garment}? Chef\'s kiss. Only {qty} made.',
      'Blue Ridge Mountains → your closet. {qty} pieces. No restock.'
    ]
  },
  'faith-inspirational': {
    hooks: [
      'Limited faith drop. {qty} made.',
      'Wear your faith. Limited edition.',
      '{qty} pieces. Hand-printed with purpose.',
      'Made with intention. Limited run.',
      'Faith-forward. {qty} ever made.'
    ],
    body: [
      'Faith-inspired artwork hand-printed on premium apparel in our Asheville, NC studio. This limited run of {qty} pieces is made with intention and care.',
      'Wear what you believe. Premium heavyweight apparel with original faith-inspired artwork. Made in the Blue Ridge Mountains, limited to {qty}.',
      'Purpose-driven design on premium blanks. Each piece is hand-printed in Asheville. Limited to {qty} — when they\'re gone, they\'re gone.'
    ],
    ctas: [
      'Shop the faith drop',
      'Wear your faith →',
      'Limited run — get yours',
      'Claim yours before they\'re gone',
      'Shop with purpose'
    ],
    vibes: ['purposeful', 'warm', 'uplifting'],
    adHooks: [
      'Faith meets fashion. {qty} pieces, handmade in Asheville NC.',
      'This faith design on a premium {garment} hits different. Only {qty} made.',
      'Limited faith drop from our mountain studio. {qty} pieces total.',
      'Wear your faith loud. {qty} made. No restocks.'
    ]
  },
  default: {
    hooks: [
      'Limited drop. {qty} made.',
      'Handmade in Asheville. Only {qty}.',
      'One-time run. {qty} pieces.',
      'Not available anywhere else.',
      'When it\'s gone, it\'s gone. {qty} total.'
    ],
    body: [
      'Original artwork hand-printed on premium blank apparel in our Asheville, NC studio. This limited drop of {qty} pieces won\'t be restocked.',
      'Small batch, big quality. Each piece is handmade in the Blue Ridge Mountains on heavyweight apparel. Limited to {qty}.',
      'Locally made in Asheville, NC. Premium fabric, original art, extremely limited. {qty} total and that\'s it.'
    ],
    ctas: [
      'Shop the limited drop',
      'Get yours before they sell out',
      'Don\'t miss this →',
      'Limited run — shop now',
      '{qty} made. Grab yours.'
    ],
    vibes: ['exclusive', 'authentic', 'premium'],
    adHooks: [
      'Only {qty} of these exist. Handmade in Asheville, NC.',
      'We made {qty} of these and that\'s all we\'re making',
      'Limited drop from our mountain studio. {qty} pieces. No restock.',
      'This design on a premium {garment}? Only {qty} ever made.'
    ]
  }
};

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function fillTemplate(str, vars) {
  let result = str;
  for (const [k, v] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
  }
  return result;
}

// ── S&S Catalog Helpers ──────────────────────────────────────────────────────

async function searchCatalog(query) {
  if (!ssaw.isConfigured()) throw new Error('S&S Activewear credentials not configured');
  return ssaw.searchStyles({ q: query });
}

async function getStyleVariants(styleId) {
  if (!ssaw.isConfigured()) throw new Error('S&S Activewear credentials not configured');
  return ssaw.productsByStyle(styleId);
}

// ── Mockup Generation ────────────────────────────────────────────────────────

async function generateMockup(modelImageUrl, designImageUrl, options = {}) {
  const sharp = require('sharp');
  const { NanoBananaService } = require('../nano-banana-service');
  const svc = new NanoBananaService({ outputDir: OUTPUT_DIR });

  const tmpDir = path.join(OUTPUT_DIR, 'tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  // Download model image (S&S CDN)
  const modelPath = path.join(tmpDir, `model_${Date.now()}.jpg`);
  const designPath = path.join(tmpDir, `design_${Date.now()}.jpg`);

  await downloadFile(modelImageUrl, modelPath);
  await downloadFile(designImageUrl, designPath);

  const result = await svc.placeGraphicOnApparel(modelPath, designPath, {
    zone: options.zone || 'front-chest',
    size: options.size || 'large',
    garmentType: options.garmentType || 'apparel'
  });

  // Clean up tmp files
  try { fs.unlinkSync(modelPath); } catch (_) {}
  try { fs.unlinkSync(designPath); } catch (_) {}

  return result;
}

async function downloadFile(url, destPath) {
  // Handle local file paths
  if (!url.startsWith('http')) {
    if (fs.existsSync(url)) {
      fs.copyFileSync(url, destPath);
      return;
    }
    throw new Error(`Local file not found: ${url}`);
  }
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Download failed: ${resp.status} ${url}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(destPath, buf);
}

// ── Drop Copy Generation ─────────────────────────────────────────────────────

function generateDropCopy(options = {}) {
  const {
    theme = 'default',
    quantity = 25,
    garmentType = 'hoodie',
    designName = 'Custom Design',
    dropName = 'Limited Drop',
    dropDuration = '48 hours'
  } = options;

  const copy = DROP_COPY[theme] || DROP_COPY.default;
  const vars = { qty: quantity, garment: garmentType, design: designName, drop: dropName, duration: dropDuration };

  return {
    hook: fillTemplate(pick(copy.hooks), vars),
    body: fillTemplate(pick(copy.body), vars),
    cta: fillTemplate(pick(copy.ctas), vars),
    adHook: fillTemplate(pick(copy.adHooks), vars),
    vibes: copy.vibes,
    // Generate multiple options for user to pick from
    hookOptions: copy.hooks.map(h => fillTemplate(h, vars)),
    ctaOptions: copy.ctas.map(c => fillTemplate(c, vars)),
    adHookOptions: copy.adHooks.map(a => fillTemplate(a, vars)),
    // Shopify description
    shopifyDescription: buildShopifyDescription(options),
    // Social captions
    tiktokCaption: buildTikTokCaption(options, copy, vars),
    facebookCaption: buildFacebookCaption(options, copy, vars)
  };
}

function buildShopifyDescription(options) {
  const { designName = 'Custom Design', garmentType = 'apparel', quantity = 25,
    garmentBrand = '', garmentStyle = '', dropDuration = '48 hours' } = options;

  const brandLine = garmentBrand ? `Printed on ${garmentBrand} ${garmentStyle} premium ${garmentType}.` : `Premium ${garmentType}.`;

  return `<p><strong>⚡ LIMITED DROP — Only ${quantity} Ever Made</strong></p>
<p>${brandLine} Hand-printed in our Asheville, NC studio with original "${designName}" artwork. This is a one-time limited run. When they sell out, they're retired permanently.</p>
<p><strong>Details:</strong></p>
<ul>
<li>🏔️ Handmade in Asheville, NC</li>
<li>🔢 Limited to ${quantity} pieces</li>
<li>🎨 Original artwork — screen-printed by hand</li>
<li>👕 Premium heavyweight blank</li>
<li>⏰ Available for ${dropDuration} or until sold out</li>
<li>📦 Ships within 3-5 business days</li>
</ul>
<p><em>Once this drop sells out, this exact design + garment combination will never be reprinted.</em></p>`;
}

function buildTikTokCaption(options, copy, vars) {
  const hook = fillTemplate(pick(copy.adHooks), vars);
  const tags = '#limiteddrop #handmade #asheville #smallbatch #ashevillenc #locallyMade #premiumapparel #limitedrun #shopsmall';
  return `${hook}\n\n${tags}`;
}

function buildFacebookCaption(options, copy, vars) {
  const hook = fillTemplate(pick(copy.hooks), vars);
  const body = fillTemplate(pick(copy.body), vars);
  const cta = fillTemplate(pick(copy.ctas), vars);
  return `🔥 ${hook}\n\n${body}\n\n👉 ${cta}\n\n#LimitedDrop #HandmadeInAsheville #SmallBatch #PremiumApparel`;
}

// ── Campaign Persistence ─────────────────────────────────────────────────────

function saveCampaign(dbArg, campaign) {
  const db = getRawDb(dbArg);
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO curated_drops
    (id, name, slug, status, config, mockups, copy, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();
  stmt.run(
    campaign.id,
    campaign.name,
    campaign.slug,
    campaign.status || 'draft',
    JSON.stringify(campaign.config || {}),
    JSON.stringify(campaign.mockups || []),
    JSON.stringify(campaign.copy || {}),
    campaign.created_at || now,
    now
  );
  return campaign;
}

function listCampaigns(dbArg) {
  const db = getRawDb(dbArg);
  return db.prepare('SELECT * FROM curated_drops ORDER BY created_at DESC').all().map(row => ({
    ...row,
    config: JSON.parse(row.config || '{}'),
    mockups: JSON.parse(row.mockups || '[]'),
    copy: JSON.parse(row.copy || '{}')
  }));
}

function getCampaign(dbArg, id) {
  const db = getRawDb(dbArg);
  const row = db.prepare('SELECT * FROM curated_drops WHERE id = ?').get(id);
  if (!row) return null;
  return {
    ...row,
    config: JSON.parse(row.config || '{}'),
    mockups: JSON.parse(row.mockups || '[]'),
    copy: JSON.parse(row.copy || '{}')
  };
}

// ── DB Helpers ───────────────────────────────────────────────────────────────

function getRawDb(dbArg) {
  // Handle both raw better-sqlite3 instance and the db module wrapper
  if (dbArg && typeof dbArg.exec === 'function') return dbArg;
  if (dbArg && typeof dbArg.getDb === 'function') return dbArg.getDb();
  return require('../db').getDb();
}

function ensureTables(dbArg) {
  const db = getRawDb(dbArg);
  db.exec(`
    CREATE TABLE IF NOT EXISTS curated_drops (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT,
      status TEXT DEFAULT 'draft',
      config TEXT DEFAULT '{}',
      mockups TEXT DEFAULT '[]',
      copy TEXT DEFAULT '{}',
      shopify_product_ids TEXT DEFAULT '[]',
      created_at TEXT,
      updated_at TEXT
    )
  `);
}

// ── Full Campaign Launch ─────────────────────────────────────────────────────

async function launchDrop(db, config) {
  const crypto = require('crypto');
  const id = crypto.randomUUID();
  const slug = (config.name || 'drop').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + '-' + Date.now();

  const campaign = {
    id,
    name: config.name || 'Curated Drop',
    slug,
    status: 'generating',
    config,
    mockups: [],
    copy: {},
    created_at: new Date().toISOString()
  };

  ensureTables(db);
  saveCampaign(db, campaign);

  // Generate mockups for each pairing
  const mockups = [];
  for (const pairing of (config.pairings || [])) {
    try {
      console.log(`[CuratedDrop] Generating mockup: ${pairing.designName} on ${pairing.garmentTitle} (${pairing.color})`);

      const results = await generateMockup(
        pairing.garmentImageUrl,
        pairing.designImageUrl,
        {
          zone: pairing.zone || 'front-chest',
          size: pairing.size || 'large',
          garmentType: pairing.garmentType || 'apparel'
        }
      );

      for (const r of results) {
        mockups.push({
          ...r,
          pairingId: pairing.id,
          designName: pairing.designName,
          garmentTitle: pairing.garmentTitle,
          color: pairing.color,
          zone: pairing.zone
        });
      }
    } catch (err) {
      console.error(`[CuratedDrop] Mockup failed for ${pairing.designName}:`, err.message);
      mockups.push({ error: err.message, pairingId: pairing.id });
    }
  }

  // Generate copy
  const copy = generateDropCopy({
    theme: config.theme || 'default',
    quantity: config.quantity || 25,
    garmentType: config.pairings?.[0]?.garmentType || 'apparel',
    designName: config.pairings?.[0]?.designName || 'Custom Design',
    dropName: config.name,
    dropDuration: config.dropDuration || '48 hours',
    garmentBrand: config.pairings?.[0]?.garmentBrand || '',
    garmentStyle: config.pairings?.[0]?.garmentStyle || ''
  });

  campaign.mockups = mockups;
  campaign.copy = copy;
  campaign.status = 'ready';
  saveCampaign(db, campaign);

  return campaign;
}

module.exports = {
  searchCatalog,
  getStyleVariants,
  generateMockup,
  generateDropCopy,
  saveCampaign,
  listCampaigns,
  getCampaign,
  ensureTables,
  launchDrop,
  DROP_COPY,
  OUTPUT_DIR
};
