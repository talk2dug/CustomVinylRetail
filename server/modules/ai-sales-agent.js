/**
 * AI Sales Agent — Autonomous Online Store Manager
 *
 * Brain module that orchestrates all sales automation:
 * - Tracks engagement on social media posts
 * - Learns what content works via Ollama (free, local AI)
 * - Plans and generates content across product categories
 * - Adapts strategy based on performance data
 * - Reports to owner via Telegram
 * - Presents paid options for approval
 * - A/B tests caption styles, hooks, CTAs (Bayesian)
 *
 * Runs every 30 minutes, integrates with pipeline monitor.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const ollamaClient = require('../lib/ollama-client');
const { tagUrl } = require('./utm-attribution');
const Database = require('better-sqlite3');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const DB_PATH = path.join(APP_ROOT, 'data', 'store.db');
const CONFIG_PATH = path.join(APP_ROOT, 'data', 'ai-sales-agent.json');

let _db = null;
let _interval = null;
let _cycleCount = 0;
let _lastCycleAt = null;
let _running = false;

// ============================================================================
// DATABASE
// ============================================================================

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS engagement_tracking (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id TEXT NOT NULL,
      facebook_post_id TEXT,
      platform TEXT DEFAULT 'facebook',
      product_uid TEXT,
      product_category TEXT,
      campaign_slug TEXT,
      caption_style TEXT,
      posted_at TEXT,
      posted_hour INTEGER,
      posted_day_of_week INTEGER,
      likes INTEGER DEFAULT 0,
      comments INTEGER DEFAULT 0,
      shares INTEGER DEFAULT 0,
      clicks INTEGER DEFAULT 0,
      engagement_rate REAL DEFAULT 0,
      collected_at TEXT NOT NULL,
      UNIQUE(post_id, collected_at)
    );
    CREATE INDEX IF NOT EXISTS idx_engagement_platform ON engagement_tracking(platform);
    CREATE INDEX IF NOT EXISTS idx_engagement_category ON engagement_tracking(product_category);
    CREATE INDEX IF NOT EXISTS idx_engagement_style ON engagement_tracking(caption_style);
    CREATE INDEX IF NOT EXISTS idx_engagement_posted ON engagement_tracking(posted_at);

    CREATE TABLE IF NOT EXISTS agent_strategy_log (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      cycle_number INTEGER,
      analysis_json TEXT,
      strategy_json TEXT,
      decisions_json TEXT,
      executed INTEGER DEFAULT 0,
      confidence_score REAL
    );
    CREATE INDEX IF NOT EXISTS idx_strategy_ts ON agent_strategy_log(timestamp);

    CREATE TABLE IF NOT EXISTS content_calendar (
      id TEXT PRIMARY KEY,
      planned_date TEXT NOT NULL,
      planned_time TEXT,
      platform TEXT NOT NULL,
      product_category TEXT,
      product_uid TEXT,
      product_title TEXT,
      caption_style TEXT,
      status TEXT DEFAULT 'planned',
      scheduled_post_id TEXT,
      reason TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_calendar_date ON content_calendar(planned_date);
    CREATE INDEX IF NOT EXISTS idx_calendar_status ON content_calendar(status);

    CREATE TABLE IF NOT EXISTS agent_approvals (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      action_type TEXT NOT NULL,
      description TEXT,
      details_json TEXT,
      telegram_message_id TEXT,
      status TEXT DEFAULT 'pending',
      responded_at TEXT,
      response_data_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_approvals_status ON agent_approvals(status);

    -- A/B Testing tables (Phase 5)
    CREATE TABLE IF NOT EXISTS ab_tests (
      id TEXT PRIMARY KEY,
      test_name TEXT NOT NULL,
      test_variable TEXT NOT NULL,
      category TEXT,
      variant_a TEXT NOT NULL,
      variant_b TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      min_posts_per_variant INTEGER DEFAULT 10,
      min_duration_days INTEGER DEFAULT 14,
      max_duration_days INTEGER DEFAULT 30,
      winner TEXT,
      probability_a_better REAL,
      conclusion_reason TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      concluded_at TEXT
    );

    CREATE TABLE IF NOT EXISTS ab_test_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      test_id TEXT NOT NULL,
      post_id TEXT NOT NULL,
      variant TEXT NOT NULL,
      weighted_score REAL DEFAULT 0,
      assigned_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (test_id) REFERENCES ab_tests(id)
    );
    CREATE INDEX IF NOT EXISTS idx_ab_assignments_test ON ab_test_assignments(test_id);
  `);

  // Phase 1b: Add weighted_score column (safe for existing DB)
  try { db.exec(`ALTER TABLE engagement_tracking ADD COLUMN weighted_score REAL DEFAULT 0`); } catch (e) { /* column exists */ }

  // Phase 2d: Add hook_formula columns
  try { db.exec(`ALTER TABLE content_calendar ADD COLUMN hook_formula TEXT`); } catch (e) { /* column exists */ }
  try { db.exec(`ALTER TABLE scheduled_facebook_posts ADD COLUMN hook_formula TEXT`); } catch (e) { /* column exists */ }
}

// ============================================================================
// CONFIG
// ============================================================================

const DEFAULT_CONFIG = {
  version: 2,
  agentState: {
    enabled: true,
    lastCycleAt: null,
    cycleCount: 0,
    currentStrategy: null
  },
  platforms: {
    facebook: { enabled: true, postsPerDay: 2, bestHours: [10, 14, 19], maxPostsPerWeek: 14 },
    pinterest: { enabled: false, postsPerDay: 0, note: 'Token expired - needs PINTEREST_ACCESS_TOKEN' },
    tiktok: { enabled: true, postsPerDay: 0, note: 'TikTok Shop active via Shopify channel' },
    instagram: { enabled: !!process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID, postsPerDay: 2, note: 'Cross-posts from FB — set INSTAGRAM_BUSINESS_ACCOUNT_ID env var to enable' }
  },
  tiktokShop: {
    enabled: true,
    maxProducts: 100,
    warnThreshold: 90,
    preferredCategories: ['metal-print', 'multiboard'],
    boostWeight: 1.3
  },
  categories: {
    'metal-print': {
      displayName: 'Metal Prints',
      enabled: true,
      postingWeight: 0.20,
      fbPage: 'blueridge',
      shopifyProductTypes: ['Metal Print', 'Metal Print Wall Art', 'Metal art', 'Metal art piece'],
      captionStyles: { showcase: 0.3, lifestyle: 0.3, quality: 0.2, humor: 0.1, urgency: 0.1 },
      defaultHashtags: '#metalprint #wallart #homedecor #metalwallart #artprint #BlueRidgeCustomCo',
      targetAudience: 'Homeowners, interior design enthusiasts, car lovers, art collectors'
    },
    'tshirt': {
      displayName: 'T-Shirts & Apparel',
      enabled: true,
      postingWeight: 0.15,
      fbPage: 'swayze',
      shopifyProductTypes: ['tshirt', 'T-Shirt'],
      captionStyles: { humor: 0.4, showcase: 0.2, urgency: 0.2, lifestyle: 0.2 },
      defaultHashtags: '#customtee #graphictee #tshirt #trending #shopsmall #SwayzeCustomVinyl',
      targetAudience: 'GenX, Millennials, meme culture, casual fashion'
    },
    'sticker': {
      displayName: 'Stickers & Decals',
      enabled: true,
      postingWeight: 0.15,
      fbPage: 'swayze',
      shopifyProductTypes: ['sticker', 'sticker-pack', 'Decals', 'Decal', 'Bumper stickers', 'Sticker Pack'],
      captionStyles: { humor: 0.4, showcase: 0.3, lifestyle: 0.2, urgency: 0.1 },
      defaultHashtags: '#stickers #vinylsticker #customsticker #stickerlife #SwayzeCustomVinyl',
      targetAudience: 'Young adults, sticker collectors, laptop customizers'
    },
    'racing': {
      displayName: 'Race Car Decals & Apparel',
      enabled: true,
      postingWeight: 0.15,
      fbPage: 'swayze',
      shopifyProductTypes: ['racing', 'Race Decal', 'Number Kit', 'Livery'],
      captionStyles: { showcase: 0.3, lifestyle: 0.3, urgency: 0.2, quality: 0.2 },
      defaultHashtags: '#grassrootsracing #racecar #SCCA #ARA #NASA #numberkits #racelivery #SwayzeCustomVinyl',
      targetAudience: 'Amateur racers, SCCA/ARA/NASA competitors, car enthusiasts, motorsports fans'
    },
    'custom-vinyl': {
      displayName: 'Custom Vinyl',
      enabled: true,
      postingWeight: 0.15,
      fbPage: 'swayze',
      shopifyProductTypes: ['custom-vinyl', 'Custom Vinyl', 'Car Decal', 'Heat Transfer'],
      captionStyles: { showcase: 0.3, lifestyle: 0.3, quality: 0.2, urgency: 0.2 },
      defaultHashtags: '#customvinyl #cardecals #heattransfer #vinylcutting #customdesign #SwayzeCustomVinyl',
      targetAudience: 'Car enthusiasts, DIY crafters, small businesses, sports teams'
    },
    'multiboard': {
      displayName: 'MultiBoard',
      enabled: true,
      postingWeight: 0.10,
      fbPage: 'blueridge',
      shopifyProductTypes: ['multiboard', 'Multiboard', 'Wall Organizer'],
      captionStyles: { showcase: 0.3, lifestyle: 0.3, quality: 0.2, urgency: 0.2 },
      defaultHashtags: '#multiboard #wallorganizer #3dprinted #homeorganization #modular #BlueRidgeCustomCo',
      targetAudience: 'Homeowners, organizers, makers, garage enthusiasts, craft room owners'
    },
    'laser-engraving': {
      displayName: 'Laser Engraving',
      enabled: true,
      postingWeight: 0.10,
      fbPage: 'blueridge',
      shopifyProductTypes: ['laser-engraving', 'Laser Engraving', 'Engraved'],
      captionStyles: { showcase: 0.3, quality: 0.3, lifestyle: 0.2, urgency: 0.2 },
      defaultHashtags: '#laserengraving #customgifts #personalizedgifts #woodengraving #BlueRidgeCustomCo',
      targetAudience: 'Gift buyers, couples, corporate buyers, wedding planners, personalization lovers'
    }
  },
  // Phase 2a: Psychology-enriched caption style definitions
  captionStyleDefinitions: {
    showcase: {
      description: 'Highlight the product quality, details, and craftsmanship. Describe what makes it special.',
      psychology: 'Contrast Effect — show before/after or compare to generic alternatives. Anchoring — lead with the premium aspect so everything else feels like bonus value.',
      structure: 'AIDA — Attention (visual hook), Interest (unique detail), Desire (imagine owning it), Action (soft CTA)',
      hookFormulas: ['curiosity_gap', 'pattern_interrupt', 'specific_number'],
      bannedPhrases: ['transform your space', 'elevate your', 'perfect for any room', 'ALERT', 'must-have', 'game-changer', 'next level'],
      exampleCTA: 'Tag someone who needs this on their wall'
    },
    lifestyle: {
      description: 'Show the product in context. Describe a scene where it fits. Make it aspirational.',
      psychology: 'Identity Signaling — the product says something about who you are. Mere Exposure Effect — paint a familiar scene the audience already loves.',
      structure: 'BAB — Before (life without it), After (life with it), Bridge (this product)',
      hookFormulas: ['before_after', 'scenario_paint', 'identity_call'],
      bannedPhrases: ['transform your space', 'elevate your', 'perfect for any room', 'imagine this', 'picture this'],
      exampleCTA: 'What room would you put this in?'
    },
    humor: {
      description: 'Use wit, puns, or relatable humor. Be playful and casual. Match Gen X/Millennial humor.',
      psychology: 'Humor Effect — funny content gets shared more and remembered longer. In-Group Signaling — reference shared experiences that make the audience feel "seen".',
      structure: 'Story — Setup (relatable situation) + Punchline (unexpected twist) + Product tie-in',
      hookFormulas: ['pattern_interrupt', 'hot_take', 'relatable_confession'],
      bannedPhrases: ['ALERT', 'stop scrolling', 'you NEED this', 'obsessed', 'literally dying'],
      exampleCTA: 'Drop a [emoji] if this is you'
    },
    urgency: {
      description: 'Create FOMO. Limited availability, trending now, selling fast. Drive immediate action.',
      psychology: 'Loss Aversion — people feel losses 2x more than gains. Scarcity — limited quantity or time triggers action. Social Proof — others buying validates the choice.',
      structure: 'PAS — Problem (you\'re missing out), Agitate (everyone else has it), Solve (get yours now)',
      hookFormulas: ['social_proof_opener', 'scarcity_signal', 'urgency_stat'],
      bannedPhrases: ['ALERT', 'ACT NOW', 'BUY NOW', 'don\'t miss out', 'limited time only', 'while supplies last'],
      exampleCTA: 'Link in comments (only a few left)'
    },
    quality: {
      description: 'Focus on materials, durability, craftsmanship. Premium positioning.',
      psychology: 'Authority Bias — technical details signal expertise. Zero-Risk Bias — quality emphasis reduces purchase anxiety.',
      structure: 'AIDA — Attention (surprising quality fact), Interest (process/material detail), Desire (longevity/value), Action (learn more)',
      hookFormulas: ['specific_number', 'myth_buster', 'behind_the_scenes'],
      bannedPhrases: ['top-notch', 'world-class', 'best in class', 'premium quality', 'second to none'],
      exampleCTA: 'Ask me anything about our process'
    }
  },
  // Phase 6b: Content pillar rotation by day of week
  contentPillars: {
    0: { style: 'lifestyle', weight: 1.2, label: 'Sunday Lifestyle' },
    1: { style: 'showcase', weight: 1.0, label: 'Monday Showcase' },
    2: { style: 'humor', weight: 1.0, label: 'Tuesday Fun' },
    3: { style: 'quality', weight: 1.0, label: 'Wednesday Craft' },
    4: { style: 'lifestyle', weight: 1.0, label: 'Thursday Lifestyle' },
    5: { style: 'urgency', weight: 1.2, label: 'Friday Deals' },
    6: { style: 'showcase', weight: 1.0, label: 'Saturday Showcase' }
  },
  strategy: {
    learningRate: 0.1,
    underexposedBoostDays: 7,
    repostCooldownDays: 14,
    abTestMinSample: 10,
    engagementWindowDays: 30,
    recycleMinAgeDays: 28,
    recycleMinScoreMultiplier: 1.5,
    recycleChance: 0.2,
    maxCategoryPostsPerWeek: 3,
    maxStylePerCategoryPerWeek: 2,
    minPostSpacingHours: 6
  },
  telegram: {
    dailyReportHour: 20,
    weeklyReportDay: 1,  // Monday
    viralThreshold: 50,
    approvalRequiredFor: ['paid_ads', 'new_channel']
  }
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      return deepMerge(DEFAULT_CONFIG, data);
    } else if (fs.existsSync(CONFIG_PATH + '.tmp')) {
      const data = JSON.parse(fs.readFileSync(CONFIG_PATH + '.tmp', 'utf8'));
      fs.renameSync(CONFIG_PATH + '.tmp', CONFIG_PATH);
      console.log('[AI Agent] Config recovered from .tmp file');
      return deepMerge(DEFAULT_CONFIG, data);
    }
  } catch (e) {
    console.error('[AI Agent] Error loading config:', e.message);
  }
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

function saveConfig(config) {
  try {
    const tmp = CONFIG_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
    fs.renameSync(tmp, CONFIG_PATH);
  } catch (e) {
    console.error('[AI Agent] Error saving config:', e.message);
  }
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

// ============================================================================
// OLLAMA HELPER
// ============================================================================

async function callOllama(prompt, options = {}) {
  return ollamaClient.generate(prompt, options);
}

/**
 * Extract a JSON object from LLM response text.
 * Handles markdown code fences, extra prose, trailing commas, etc.
 */
function extractJSON(text) {
  if (!text || typeof text !== 'string') return null;

  // Step 1: Strip markdown code fences (```json ... ``` or ``` ... ```)
  let cleaned = text.replace(/```(?:json)?\s*\n?([\s\S]*?)```/g, '$1').trim();

  // Step 2: Try parsing the whole cleaned text directly
  try { return JSON.parse(cleaned); } catch (_) {}

  // Step 3: Find the outermost { ... } using bracket balancing (not greedy regex)
  const start = cleaned.indexOf('{');
  if (start !== -1) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\' && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) {
        let candidate = cleaned.substring(start, i + 1);
        try { return JSON.parse(candidate); } catch (_) {}
        // Step 4: Fix trailing commas before } or ]
        candidate = candidate.replace(/,\s*([}\]])/g, '$1');
        try { return JSON.parse(candidate); } catch (_) {}
        break;
      }}
    }
  }

  return null;
}

// ============================================================================
// ENGAGEMENT TRACKING
// ============================================================================

async function collectEngagementData() {
  const fbScheduler = require('../lib/facebook-post-scheduler');

  // Get published posts from last 30 days with facebook_post_id
  const publishedPosts = _db.prepare(`
    SELECT id, facebook_post_id, campaign_slug, product_uid, product_name,
           campaign_type, ai_style, published_at
    FROM scheduled_facebook_posts
    WHERE status = 'published'
      AND facebook_post_id IS NOT NULL
      AND published_at > datetime('now', '-30 days')
  `).all();

  if (publishedPosts.length === 0) {
    console.log('[AI Agent] No published posts to collect engagement for');
    return { collected: 0 };
  }

  // Filter to posts needing engagement update
  const needsUpdate = publishedPosts.filter(post => {
    const lastCollected = _db.prepare(`
      SELECT MAX(collected_at) as last FROM engagement_tracking WHERE post_id = ?
    `).get(post.id);

    const hoursOld = (Date.now() - new Date(post.published_at).getTime()) / 3600000;
    // Collect every 1 hour for first 6 hours (catch viral window), every 6 hours for first 3 days, then every 24 hours
    const collectInterval = hoursOld < 6 ? 1 : hoursOld < 72 ? 6 : 24;
    return !lastCollected?.last ||
      (Date.now() - new Date(lastCollected.last).getTime()) > collectInterval * 3600000;
  });

  if (needsUpdate.length === 0) {
    console.log('[AI Agent] All posts up to date, no engagement collection needed');
    return { collected: 0 };
  }

  // Collect insights (max 20 per cycle to avoid rate limits)
  const batch = needsUpdate.slice(0, 20);
  const postIds = batch.map(p => p.facebook_post_id);

  let insights;
  try {
    insights = await fbScheduler.getBulkPostInsights(postIds);
  } catch (e) {
    console.error('[AI Agent] Failed to get insights:', e.message);
    return { collected: 0, error: e.message };
  }

  let collected = 0;
  const now = new Date().toISOString();

  for (let i = 0; i < batch.length; i++) {
    const post = batch[i];
    const insight = insights[i];
    if (!insight) continue;

    const postedAt = new Date(post.published_at);
    const category = categorizeProduct(post.campaign_type, post.campaign_slug);
    const style = post.ai_style || 'showcase';

    const likes = insight.likes || 0;
    const comments = insight.comments || 0;
    const shares = insight.shares || 0;
    const clicks = insight.clicks || 0;
    // Phase 1b: Weighted scoring — comments and shares signal deeper engagement
    const weightedScore = likes + (comments * 3) + (shares * 5);
    const total = likes + comments + shares;
    const engagementRate = insight.reach > 0 ? (total / insight.reach * 100) : 0;

    try {
      _db.prepare(`
        INSERT OR REPLACE INTO engagement_tracking
        (post_id, facebook_post_id, platform, product_uid, product_category,
         campaign_slug, caption_style, posted_at, posted_hour, posted_day_of_week,
         likes, comments, shares, clicks, engagement_rate, weighted_score, collected_at)
        VALUES (?, ?, 'facebook', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        post.id, post.facebook_post_id, post.product_uid, category,
        post.campaign_slug, style, post.published_at,
        postedAt.getUTCHours(), postedAt.getUTCDay(),
        likes, comments, shares, clicks, engagementRate, weightedScore, now
      );
      collected++;

      // Phase 5d: Update A/B test assignments with weighted score
      try {
        _db.prepare(`
          UPDATE ab_test_assignments SET weighted_score = ?
          WHERE post_id = ?
        `).run(weightedScore, post.id);
      } catch (e) { /* no assignment for this post */ }

    } catch (e) {
      console.error('[AI Agent] DB insert error:', e.message);
    }
  }

  console.log(`[AI Agent] Collected engagement for ${collected}/${batch.length} posts`);
  return { collected, total: publishedPosts.length };
}

// ============================================================================
// TIKTOK SHOP DATA COLLECTION
// ============================================================================

let _tiktokShopData = null;

async function collectTikTokShopData() {
  const config = loadConfig();
  if (!config.tiktokShop?.enabled) {
    return null;
  }

  try {
    const shopify = require('../integrations/shopify');
    if (!shopify.isConfigured()) {
      console.log('[AI Agent] TikTok Shop: Shopify not configured, skipping');
      return null;
    }

    const pub = await shopify.findTikTokPublication();
    if (!pub) {
      console.log('[AI Agent] TikTok Shop: Publication not found');
      _tiktokShopData = { capacity: { current: 0, max: 100, available: 100 }, breakdown: {}, publicationId: null };
      return _tiktokShopData;
    }

    const products = await shopify.getProductsOnPublication(pub.id);
    const productCount = products.length;

    // Build breakdown from local DB
    const breakdown = { multiboard: 0, metal: 0, tshirt: 0, other: 0 };
    try {
      const Database = require('better-sqlite3');
      const tiktokDb = new Database(DB_PATH);
      for (const p of products) {
        const local = tiktokDb.prepare('SELECT source FROM tiktok_shop_products WHERE shopify_product_id = ?').get(p.numericId);
        const src = local?.source || 'other';
        if (src === 'multiboard') breakdown.multiboard++;
        else if (src === 'metal') breakdown.metal++;
        else if (src === 'tshirt') breakdown.tshirt++;
        else breakdown.other++;
      }
      tiktokDb.close();
    } catch (e) {
      // Fallback: just count total without breakdown
      breakdown.other = productCount;
    }

    _tiktokShopData = {
      capacity: { current: productCount, max: 100, available: Math.max(0, 100 - productCount) },
      breakdown,
      publicationId: pub.id
    };

    console.log(`[AI Agent] TikTok Shop: ${productCount}/100 products (multiboard: ${breakdown.multiboard}, metal: ${breakdown.metal}, tshirt: ${breakdown.tshirt}, other: ${breakdown.other})`);
    return _tiktokShopData;
  } catch (e) {
    console.error('[AI Agent] TikTok Shop data collection failed:', e.message);
    return null;
  }
}

function categorizeProduct(campaignType, campaignSlug) {
  if (!campaignType && !campaignSlug) return 'other';
  const slug = (campaignSlug || '').toLowerCase();
  const type = (campaignType || '').toLowerCase();

  // Direct campaign_type matches first
  if (type === 'racing') return 'racing';
  if (type === 'custom-vinyl') return 'custom-vinyl';
  if (type === 'multiboard') return 'multiboard';
  if (type === 'laser-engraving') return 'laser-engraving';
  if (type === 'sticker') return 'sticker';
  if (type === 'apparel') return 'tshirt';
  if (type === 'custom-art') return 'metal-print';

  // Keyword-based fallback from slug
  if (slug.includes('race') || slug.includes('racing') || slug.includes('number kit') || slug.includes('livery') || slug.includes('scca') || slug.includes('nasa-racing') || slug.includes('ara')) return 'racing';
  if (slug.includes('custom vinyl') || slug.includes('custom-vinyl') || slug.includes('heat transfer') || slug.includes('car decal') || slug.includes('custom cut')) return 'custom-vinyl';
  if (slug.includes('multiboard') || slug.includes('wall organiz') || slug.includes('pegboard')) return 'multiboard';
  if (slug.includes('laser') || slug.includes('engrav') || slug.includes('etch')) return 'laser-engraving';
  if (slug.includes('sticker') || slug.includes('decal') || slug.includes('bumper')) return 'sticker';
  if (slug.includes('trend') || slug.includes('shirt') || slug.includes('apparel') || slug.includes('hoodie')) return 'tshirt';
  if (slug.includes('metal') || slug.includes('print') || slug.includes('art')) return 'metal-print';
  return 'other';
}

// ============================================================================
// PERFORMANCE ANALYSIS
// ============================================================================

function analyzePerformance() {
  const windowDays = loadConfig().strategy.engagementWindowDays || 30;

  // Latest snapshot per post (avoid double-counting from multiple collections)
  const latestSnapshotCTE = `
    WITH latest AS (
      SELECT post_id, MAX(collected_at) as max_collected
      FROM engagement_tracking
      WHERE posted_at > datetime('now', '-${windowDays} days')
      GROUP BY post_id
    )
  `;

  // Phase 3a: Use weighted_score in analysis
  const byCategory = _db.prepare(`
    ${latestSnapshotCTE}
    SELECT e.product_category,
           COUNT(*) as post_count,
           ROUND(AVG(e.engagement_rate), 2) as avg_engagement,
           ROUND(AVG(e.weighted_score), 2) as avg_weighted_score,
           SUM(e.likes) as total_likes,
           SUM(e.comments) as total_comments,
           SUM(e.shares) as total_shares,
           SUM(e.clicks) as total_clicks
    FROM engagement_tracking e
    JOIN latest l ON e.post_id = l.post_id AND e.collected_at = l.max_collected
    GROUP BY e.product_category
    ORDER BY avg_weighted_score DESC
  `).all();

  const byStyle = _db.prepare(`
    ${latestSnapshotCTE}
    SELECT e.caption_style,
           COUNT(*) as post_count,
           ROUND(AVG(e.engagement_rate), 2) as avg_engagement,
           ROUND(AVG(e.weighted_score), 2) as avg_weighted_score,
           SUM(e.likes) as total_likes,
           SUM(e.clicks) as total_clicks
    FROM engagement_tracking e
    JOIN latest l ON e.post_id = l.post_id AND e.collected_at = l.max_collected
    GROUP BY e.caption_style
    ORDER BY avg_weighted_score DESC
  `).all();

  const byHour = _db.prepare(`
    ${latestSnapshotCTE}
    SELECT e.posted_hour,
           COUNT(*) as post_count,
           ROUND(AVG(e.engagement_rate), 2) as avg_engagement,
           ROUND(AVG(e.weighted_score), 2) as avg_weighted_score
    FROM engagement_tracking e
    JOIN latest l ON e.post_id = l.post_id AND e.collected_at = l.max_collected
    GROUP BY e.posted_hour
    ORDER BY avg_weighted_score DESC
  `).all();

  const byDayOfWeek = _db.prepare(`
    ${latestSnapshotCTE}
    SELECT e.posted_day_of_week,
           COUNT(*) as post_count,
           ROUND(AVG(e.engagement_rate), 2) as avg_engagement,
           ROUND(AVG(e.weighted_score), 2) as avg_weighted_score
    FROM engagement_tracking e
    JOIN latest l ON e.post_id = l.post_id AND e.collected_at = l.max_collected
    GROUP BY e.posted_day_of_week
    ORDER BY avg_weighted_score DESC
  `).all();

  // Phase 3a: Category x Style cross-tabulation
  const byCategoryStyle = _db.prepare(`
    ${latestSnapshotCTE}
    SELECT e.product_category, e.caption_style,
           COUNT(*) as post_count,
           ROUND(AVG(e.weighted_score), 2) as avg_weighted_score,
           ROUND(AVG(e.engagement_rate), 2) as avg_engagement
    FROM engagement_tracking e
    JOIN latest l ON e.post_id = l.post_id AND e.collected_at = l.max_collected
    GROUP BY e.product_category, e.caption_style
    ORDER BY e.product_category, avg_weighted_score DESC
  `).all();

  const topPosts = _db.prepare(`
    ${latestSnapshotCTE}
    SELECT e.post_id, e.product_uid, e.product_category, e.caption_style,
           e.posted_hour, e.likes, e.comments, e.shares, e.engagement_rate,
           e.weighted_score
    FROM engagement_tracking e
    JOIN latest l ON e.post_id = l.post_id AND e.collected_at = l.max_collected
    ORDER BY e.weighted_score DESC
    LIMIT 10
  `).all();

  const totalPosts = _db.prepare(`
    SELECT COUNT(DISTINCT post_id) as count FROM engagement_tracking
    WHERE posted_at > datetime('now', '-${windowDays} days')
  `).get();

  return {
    byCategory,
    byStyle,
    byHour: byHour.slice(0, 8),
    byDayOfWeek,
    byCategoryStyle,
    topPosts: topPosts.slice(0, 5),
    totalPostsTracked: totalPosts?.count || 0,
    windowDays
  };
}

// ============================================================================
// STRATEGY ENGINE (Ollama-powered)
// ============================================================================

async function callOllamaForStrategy(analysis) {
  const config = loadConfig();
  const currentWeights = {};
  for (const [cat, cfg] of Object.entries(config.categories)) {
    if (cfg.enabled) {
      currentWeights[cat] = { weight: cfg.postingWeight, styles: cfg.captionStyles };
    }
  }

  // Compact summary to keep prompt short for Ollama CPU speed
  const catSummary = analysis.byCategory.map(c => `${c.product_category}: ${(c.avg_weighted_score || 0).toFixed(1)} wtd score, ${c.post_count} posts`).join('; ');
  const styleSummary = analysis.byStyle.slice(0, 5).map(s => `${s.caption_style}: ${(s.avg_weighted_score || 0).toFixed(1)} wtd`).join('; ');
  const hourSummary = analysis.byHour.slice(0, 3).map(h => `${h.posted_hour}:00=${(h.avg_weighted_score || 0).toFixed(1)}`).join(', ');

  const catKeys = Object.keys(currentWeights);
  const defaultWeights = Object.fromEntries(catKeys.map(k => [k, currentWeights[k].weight]));

  // Include TikTok Shop data if available
  const tiktokInfo = _tiktokShopData
    ? `TikTok Shop: ${_tiktokShopData.capacity.current}/${_tiktokShopData.capacity.max} products (${_tiktokShopData.capacity.available} slots free). Breakdown: ${JSON.stringify(_tiktokShopData.breakdown)}.`
    : '';

  const prompt = `You are a JSON API. Respond with ONLY raw JSON, no explanation, no markdown, no code fences.

Marketing strategy for online store (metal prints, t-shirts, stickers, racing decals, custom vinyl, multiboard, laser engraving).
Data: ${catSummary}. Styles: ${styleSummary}. Best hours: ${hourSummary}.${tiktokInfo ? ' ' + tiktokInfo : ''}
Current weights: ${JSON.stringify(currentWeights)}.

Respond with ONLY this JSON format (no other text):
{"categoryWeightAdjustments":${JSON.stringify(defaultWeights)},"bestPostingHours":[10,14,19],"recommendations":["one tip"],"tiktokShopRecommendations":["prioritize category X for TikTok"],"confidence":0.7}`;

  try {
    const result = await callOllama(prompt, { temperature: 0.5, maxTokens: 300, timeout: 240000 });
    const parsed = extractJSON(result);
    if (!parsed) {
      console.warn('[AI Agent] Ollama strategy: could not parse JSON response, raw:', result?.substring(0, 200));
      return null;
    }
    return parsed;
  } catch (e) {
    console.error('[AI Agent] Ollama strategy failed:', e.message);
    return null;
  }
}

function applyStrategyAdjustments(strategy) {
  if (!strategy) return [];

  const config = loadConfig();
  const lr = config.strategy.learningRate;

  // Adjust category weights
  if (strategy.categoryWeightAdjustments) {
    for (const [cat, newWeight] of Object.entries(strategy.categoryWeightAdjustments)) {
      if (config.categories[cat] && config.categories[cat].enabled) {
        const current = config.categories[cat].postingWeight;
        config.categories[cat].postingWeight = current * (1 - lr) + newWeight * lr;
      }
    }
    // Normalize
    const total = Object.values(config.categories)
      .filter(c => c.enabled)
      .reduce((sum, c) => sum + c.postingWeight, 0);
    if (total > 0) {
      for (const cat of Object.values(config.categories)) {
        if (cat.enabled) cat.postingWeight = Math.round(cat.postingWeight / total * 100) / 100;
      }
    }
  }

  // Adjust caption style weights per category
  if (strategy.styleWeightAdjustments) {
    for (const [cat, styles] of Object.entries(strategy.styleWeightAdjustments)) {
      if (config.categories[cat]?.captionStyles) {
        for (const [style, newWeight] of Object.entries(styles)) {
          const current = config.categories[cat].captionStyles[style] || 0;
          config.categories[cat].captionStyles[style] = current * (1 - lr) + newWeight * lr;
        }
        // Normalize
        const styleTotal = Object.values(config.categories[cat].captionStyles).reduce((s, w) => s + w, 0);
        if (styleTotal > 0) {
          for (const style of Object.keys(config.categories[cat].captionStyles)) {
            config.categories[cat].captionStyles[style] =
              Math.round(config.categories[cat].captionStyles[style] / styleTotal * 100) / 100;
          }
        }
      }
    }
  }

  // Update best hours
  if (strategy.bestPostingHours && Array.isArray(strategy.bestPostingHours)) {
    for (const platform of Object.keys(config.platforms)) {
      if (config.platforms[platform].enabled) {
        config.platforms[platform].bestHours = strategy.bestPostingHours.slice(0, 5);
      }
    }
  }

  // Log the decision
  _db.prepare(`
    INSERT INTO agent_strategy_log (id, timestamp, cycle_number, analysis_json, strategy_json, decisions_json, executed, confidence_score)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)
  `).run(
    crypto.randomUUID(), new Date().toISOString(), _cycleCount,
    '{}', JSON.stringify(strategy),
    JSON.stringify({ weights: Object.fromEntries(Object.entries(config.categories).map(([k, v]) => [k, v.postingWeight])) }),
    strategy.confidence || 0
  );

  saveConfig(config);
  return strategy.recommendations || [];
}

// ============================================================================
// CONTENT PLANNING & GENERATION
// ============================================================================

// Phase 3c: Find high-performing posts eligible for recycling
function findRecyclablePosts() {
  const config = loadConfig();
  const minAge = config.strategy.recycleMinAgeDays || 28;
  const scoreMultiplier = config.strategy.recycleMinScoreMultiplier || 1.5;

  // Get average weighted score
  const avgScore = _db.prepare(`
    WITH latest AS (
      SELECT post_id, MAX(collected_at) as max_collected
      FROM engagement_tracking WHERE posted_at > datetime('now', '-90 days')
      GROUP BY post_id
    )
    SELECT AVG(e.weighted_score) as avg_score
    FROM engagement_tracking e
    JOIN latest l ON e.post_id = l.post_id AND e.collected_at = l.max_collected
  `).get()?.avg_score || 0;

  if (avgScore <= 0) return [];

  const minScore = avgScore * scoreMultiplier;

  return _db.prepare(`
    WITH latest AS (
      SELECT post_id, MAX(collected_at) as max_collected
      FROM engagement_tracking WHERE posted_at > datetime('now', '-90 days')
      GROUP BY post_id
    )
    SELECT e.post_id, e.product_uid, e.product_category, e.caption_style,
           e.weighted_score, e.posted_at,
           s.product_name, s.artwork_path, s.collection_url
    FROM engagement_tracking e
    JOIN latest l ON e.post_id = l.post_id AND e.collected_at = l.max_collected
    JOIN scheduled_facebook_posts s ON e.post_id = s.id
    WHERE e.weighted_score >= ?
      AND e.posted_at < datetime('now', '-${minAge} days')
      AND e.post_id NOT IN (
        SELECT product_uid FROM scheduled_facebook_posts
        WHERE status = 'pending' AND product_uid IS NOT NULL
      )
    ORDER BY e.weighted_score DESC
    LIMIT 10
  `).all(minScore);
}

async function planNextContent() {
  const config = loadConfig();

  // Check current queue depth
  const pending = _db.prepare(`
    SELECT COUNT(*) as count FROM scheduled_facebook_posts
    WHERE status = 'pending' AND scheduled_for > datetime('now')
  `).get();

  const postsPerDay = config.platforms.facebook.postsPerDay || 2;
  const targetQueueDays = 7;
  const targetPosts = postsPerDay * targetQueueDays;
  const needed = targetPosts - (pending?.count || 0);

  if (needed <= 0) {
    console.log(`[AI Agent] Queue has ${pending.count} pending posts (${Math.round(pending.count / postsPerDay)} days). No new content needed.`);
    return { planned: 0, queueDepth: pending.count };
  }

  const toGenerate = Math.min(needed, postsPerDay * 2); // Max 2 days of content per cycle
  console.log(`[AI Agent] Queue needs ${needed} posts. Generating ${toGenerate} posts.`);

  // Select products using weighted category rotation
  const shopify = require('../integrations/shopify');
  const enabledCategories = Object.entries(config.categories).filter(([_, c]) => c.enabled);

  const planned = [];
  const bestHours = config.platforms.facebook.bestHours || [10, 14, 19];

  for (let i = 0; i < toGenerate; i++) {
    // Pick category by weight (boost TikTok Shop categories for cross-channel amplification)
    const tiktokBoost = config.tiktokShop?.boostWeight || 1.3;
    const tiktokPreferred = config.tiktokShop?.preferredCategories || [];
    let category = pickWeighted(enabledCategories.map(([name, cfg]) => ({
      value: name,
      weight: cfg.postingWeight * (_tiktokShopData && _tiktokShopData.capacity.current > 0 && tiktokPreferred.includes(name) ? tiktokBoost : 1)
    })));
    const catConfig = config.categories[category];

    // Phase 3b: Diminishing returns prevention
    const maxCatPerWeek = config.strategy.maxCategoryPostsPerWeek || 3;
    const recentCatPosts = _db.prepare(`
      SELECT COUNT(*) as count FROM content_calendar
      WHERE product_category = ? AND planned_date > date('now', '-7 days') AND status != 'skipped'
    `).get(category)?.count || 0;

    if (recentCatPosts >= maxCatPerWeek) {
      console.log(`[AI Agent] Diminishing returns: ${category} has ${recentCatPosts} posts in 7 days, re-rolling`);
      // Re-roll with boosted weights for other categories
      const alternatives = enabledCategories
        .filter(([name]) => name !== category)
        .map(([name, cfg]) => ({ value: name, weight: cfg.postingWeight * 1.5 }));
      if (alternatives.length > 0) {
        category = pickWeighted(alternatives);
      }
    }

    // Phase 3c: Content recycling (~20% chance)
    const recycleChance = config.strategy.recycleChance || 0.2;
    let isRecycled = false;
    let recycledPost = null;

    if (Math.random() < recycleChance) {
      const recyclable = findRecyclablePosts();
      if (recyclable.length > 0) {
        recycledPost = recyclable[Math.floor(Math.random() * Math.min(3, recyclable.length))];
        isRecycled = true;
        console.log(`[AI Agent] Recycling top performer: "${recycledPost.product_name}" (score: ${recycledPost.weighted_score})`);
      }
    }

    // Pick caption style by weight, with pillar day preference
    const dayOfWeek = new Date().getDay();
    const pillar = config.contentPillars?.[dayOfWeek];
    let style;

    // Phase 3b: Style saturation check
    const maxStylePerCat = config.strategy.maxStylePerCategoryPerWeek || 2;

    if (pillar && catConfig.captionStyles[pillar.style] !== undefined) {
      // Boost the pillar day style
      const adjustedStyles = Object.entries(catConfig.captionStyles).map(([name, weight]) => ({
        value: name, weight: name === pillar.style ? weight * (pillar.weight || 1.2) : weight
      }));
      style = pickWeighted(adjustedStyles);
    } else {
      style = pickWeighted(Object.entries(catConfig.captionStyles).map(([name, weight]) => ({
        value: name, weight
      })));
    }

    // Check style saturation
    const recentStylePosts = _db.prepare(`
      SELECT COUNT(*) as count FROM content_calendar
      WHERE product_category = ? AND caption_style = ? AND planned_date > date('now', '-7 days') AND status != 'skipped'
    `).get(category, style)?.count || 0;

    if (recentStylePosts >= maxStylePerCat) {
      console.log(`[AI Agent] Diminishing returns: ${category}/${style} has ${recentStylePosts} posts in 7 days, re-rolling style`);
      const altStyles = Object.entries(catConfig.captionStyles)
        .filter(([name]) => name !== style)
        .map(([name, weight]) => ({ value: name, weight: weight * 1.5 }));
      if (altStyles.length > 0) {
        style = pickWeighted(altStyles);
      }
    }

    // Phase 2b: Select hook formula from style definition
    const styleDef = config.captionStyleDefinitions[style];
    const hookFormulas = (styleDef && styleDef.hookFormulas) || ['curiosity_gap'];
    const hookFormula = hookFormulas[Math.floor(Math.random() * hookFormulas.length)];

    // Pick posting time
    const hour = bestHours[i % bestHours.length];
    const daysAhead = Math.floor(i / postsPerDay) + 1;
    const plannedDate = new Date();
    plannedDate.setDate(plannedDate.getDate() + daysAhead);
    const dateStr = plannedDate.toISOString().slice(0, 10);
    let timeStr = `${String(hour).padStart(2, '0')}:00`;

    // Phase 6a: Enforce 6+ hour spacing
    const minSpacing = config.strategy.minPostSpacingHours || 6;
    const existingForDate = _db.prepare(`
      SELECT planned_time FROM content_calendar
      WHERE planned_date = ? AND status != 'skipped'
      UNION
      SELECT substr(scheduled_for, 12, 5) as planned_time FROM scheduled_facebook_posts
      WHERE date(scheduled_for) = ? AND status = 'pending'
    `).all(dateStr, dateStr);

    if (existingForDate.length > 0) {
      const existingHours = existingForDate.map(e => parseInt((e.planned_time || '12:00').split(':')[0]));
      let proposedHour = hour;
      let shifted = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        const tooClose = existingHours.some(h => Math.abs(h - proposedHour) < minSpacing);
        if (!tooClose) break;
        proposedHour = (proposedHour + minSpacing) % 24;
        shifted = true;
      }
      if (shifted) {
        timeStr = `${String(proposedHour).padStart(2, '0')}:00`;
        console.log(`[AI Agent] Shifted time from ${hour}:00 to ${timeStr} (${minSpacing}h spacing) for ${dateStr}`);
      }
    }

    // Check if this category has products on TikTok Shop (cross-channel boost)
    const tiktokShopListed = _tiktokShopData && _tiktokShopData.capacity.current > 0 &&
      (config.tiktokShop?.preferredCategories || []).includes(isRecycled ? recycledPost.product_category : category);

    const calendarId = crypto.randomUUID();
    planned.push({
      id: calendarId,
      planned_date: dateStr,
      planned_time: timeStr,
      platform: 'facebook',
      product_category: isRecycled ? recycledPost.product_category : category,
      product_uid: isRecycled ? recycledPost.product_uid : null,
      caption_style: style,
      hook_formula: hookFormula,
      tiktok_shop_listed: tiktokShopListed ? 1 : 0,
      status: 'planned',
      reason: isRecycled
        ? `Recycled top performer (score: ${recycledPost.weighted_score})`
        : `Weighted selection: ${category} (${Math.round(catConfig.postingWeight * 100)}%), style: ${style}, hook: ${hookFormula}${tiktokShopListed ? ', TikTok Shop cross-channel' : ''}`
    });
  }

  // Insert into content_calendar
  const insert = _db.prepare(`
    INSERT INTO content_calendar (id, planned_date, planned_time, platform, product_category, product_uid, caption_style, hook_formula, status, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?)
  `);

  for (const p of planned) {
    insert.run(p.id, p.planned_date, p.planned_time, p.platform, p.product_category, p.product_uid, p.caption_style, p.hook_formula, p.reason);
  }

  console.log(`[AI Agent] Planned ${planned.length} calendar entries`);
  return { planned: planned.length, queueDepth: pending.count };
}

async function executeContentPlan() {
  const config = loadConfig();

  // Get unexecuted calendar entries for today and tomorrow
  const entries = _db.prepare(`
    SELECT * FROM content_calendar
    WHERE status = 'planned'
      AND planned_date <= date('now', '+1 day')
    ORDER BY planned_date, planned_time
    LIMIT 4
  `).all();

  if (entries.length === 0) {
    return { generated: 0 };
  }

  const shopify = require('../integrations/shopify');
  let generated = 0;

  for (const entry of entries) {
    try {
      const catConfig = config.categories[entry.product_category];
      if (!catConfig) continue;

      // Find a product to post about
      const product = await selectProduct(entry.product_category, catConfig, entry.product_uid);
      if (!product) {
        console.log(`[AI Agent] No product found for category: ${entry.product_category}`);
        _db.prepare(`UPDATE content_calendar SET status = 'skipped', reason = 'No product found' WHERE id = ?`).run(entry.id);
        continue;
      }

      // Product-category mismatch guard: if the product's actual type doesn't match
      // the planned category, correct the category so the caption describes the right product
      let effectiveCategory = entry.product_category;
      let effectiveCatConfig = catConfig;
      const productType = (product.product_type || '').toLowerCase();
      const CATEGORY_TYPE_MAP = {
        'metal-print': ['metal print', 'metal art', 'metal art piece', 'metal print wall art'],
        'tshirt': ['tshirt', 't-shirt', 'apparel', 'hoodie', 'sweatshirt'],
        'sticker': ['sticker', 'sticker-pack', 'decal', 'decals', 'bumper stickers', 'sticker pack'],
        'laser-engraving': ['laser-engraving', 'laser engraving', 'engraved'],
        'multiboard': ['multiboard', 'wall organizer'],
        'racing': ['racing', 'race decal', 'number kit', 'livery'],
        'custom-vinyl': ['custom-vinyl', 'custom vinyl', 'car decal', 'heat transfer']
      };
      if (productType) {
        const matchesPlannedCategory = (CATEGORY_TYPE_MAP[effectiveCategory] || [])
          .some(t => productType.includes(t));
        if (!matchesPlannedCategory) {
          // Find the correct category for this product type
          for (const [cat, types] of Object.entries(CATEGORY_TYPE_MAP)) {
            if (types.some(t => productType.includes(t)) && config.categories[cat]) {
              console.log(`[AI Agent] Category mismatch fix: product "${product.title}" (type: ${product.product_type}) reclassified from ${effectiveCategory} to ${cat}`);
              effectiveCategory = cat;
              effectiveCatConfig = config.categories[cat];
              break;
            }
          }
        }
      }

      // Phase 2b: Generate caption with psychology-enriched prompt
      const styleDef = config.captionStyleDefinitions[entry.caption_style];
      const hookFormula = entry.hook_formula || 'curiosity_gap';
      const caption = await generateCaption(product, effectiveCategory, entry.caption_style, styleDef, effectiveCatConfig, hookFormula);

      // Get product image URL
      const imageUrl = product.images?.[0]?.src || product.image?.src || null;
      if (!imageUrl) {
        console.log(`[AI Agent] No image for product: ${product.title}`);
        _db.prepare(`UPDATE content_calendar SET status = 'skipped', reason = 'No product image' WHERE id = ?`).run(entry.id);
        continue;
      }

      // Schedule the post
      const scheduledFor = `${entry.planned_date}T${entry.planned_time || '12:00'}:00Z`;
      const postId = crypto.randomUUID().slice(0, 20);
      const hashtags = effectiveCatConfig.defaultHashtags || '';
      const rawCollectionUrl = COLLECTION_URL_MAP[effectiveCategory] || 'https://blueridgecustomco.us/collections/all';
      const collectionUrl = tagUrl(rawCollectionUrl, {
        source: 'facebook',
        medium: 'social',
        campaign: `agent-${effectiveCategory}`,
        content: product.handle || String(product.id)
      });

      const postText = caption.text || `Check out ${product.title}! Available now at Blue Ridge Custom Co.`;
      const postHashtags = caption.hashtags || hashtags;

      // Phase 5d: Check active A/B tests for this category
      let abVariant = null;
      const activeTest = getActiveTestForCategory(effectiveCategory);
      if (activeTest) {
        abVariant = assignToTest(activeTest, postId);
        console.log(`[AI Agent] A/B test "${activeTest.test_name}": assigned variant ${abVariant} to post ${postId}`);
      }

      // A3: Use proper campaign_type mapping for correct FB page routing
      const campaignType = getCampaignType(effectiveCategory);

      _db.prepare(`
        INSERT INTO scheduled_facebook_posts
        (id, campaign_slug, product_uid, product_name, campaign_type,
         artwork_path, post_text, post_hashtags,
         collection_url, scheduled_for, status, generate_ai_on_post, ai_style, hook_formula)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
      `).run(
        postId,
        `agent-${effectiveCategory}`,
        String(product.id),
        product.title,
        campaignType,
        imageUrl,
        postText,
        postHashtags,
        collectionUrl,
        scheduledFor,
        entry.caption_style,
        hookFormula
      );

      // Update calendar entry
      _db.prepare(`
        UPDATE content_calendar SET status = 'scheduled', scheduled_post_id = ?, product_uid = ?, product_title = ?, updated_at = ?
        WHERE id = ?
      `).run(postId, String(product.id), product.title, new Date().toISOString(), entry.id);

      generated++;
      console.log(`[AI Agent] Scheduled: "${product.title}" (${effectiveCategory}/${entry.caption_style}/${hookFormula}) for ${scheduledFor}`);

    } catch (e) {
      console.error(`[AI Agent] Content execution error:`, e.message);
      _db.prepare(`UPDATE content_calendar SET status = 'skipped', reason = ? WHERE id = ?`).run(e.message, entry.id);
    }
  }

  return { generated };
}

async function selectProduct(category, catConfig, preferredUid) {
  // If we have a preferred UID (e.g. from recycling), try to find it
  if (preferredUid) {
    const shopify = require('../integrations/shopify');
    try {
      const product = await shopify.getProduct(preferredUid);
      if (product) return product;
    } catch (e) { /* fall through to normal selection */ }
  }

  const shopify = require('../integrations/shopify');

  // A6: Category-specific product selection
  if (category === 'racing') {
    return await selectRacingProduct();
  }
  if (category === 'multiboard') {
    return await selectMultiboardProduct();
  }
  if (category === 'laser-engraving') {
    return await selectLaserProduct(shopify);
  }
  if (category === 'custom-vinyl') {
    return await selectCustomVinylProduct(shopify);
  }

  // Default Shopify product type selection (metal-print, tshirt, sticker)
  const productTypes = catConfig.shopifyProductTypes || [];

  // Get recently posted product IDs (avoid repeats)
  const recentlyPosted = _db.prepare(`
    SELECT DISTINCT product_uid FROM scheduled_facebook_posts
    WHERE campaign_slug LIKE 'agent-%'
      AND created_at > datetime('now', '-14 days')
      AND product_uid IS NOT NULL
  `).all().map(r => r.product_uid);

  // Fetch products from Shopify
  let products = [];
  try {
    for (const pType of productTypes.slice(0, 2)) {
      const batch = await shopify.listProducts({ product_type: pType, limit: 50, status: 'active' });
      if (batch?.products) products.push(...batch.products);
    }
  } catch (e) {
    console.error(`[AI Agent] Shopify product fetch error:`, e.message);
    return null;
  }

  if (products.length === 0) return null;

  // Safety-net: filter to only products whose product_type matches this category
  const typeSet = new Set(productTypes.map(t => t.toLowerCase()));
  const typeMatched = products.filter(p => p.product_type && typeSet.has(p.product_type.toLowerCase()));
  if (typeMatched.length > 0) {
    products = typeMatched;
  } else {
    console.warn(`[AI Agent] No products matched types ${JSON.stringify(productTypes)} — using unfiltered pool (${products.length})`);
  }

  // Filter out recently posted
  const candidates = products.filter(p => !recentlyPosted.includes(String(p.id)));

  // If all products have been posted recently, just pick from all
  const pool = candidates.length > 0 ? candidates : products;

  // Pick random from pool (weighted toward those with images)
  const withImages = pool.filter(p => p.images?.length > 0 || p.image);
  const finalPool = withImages.length > 0 ? withImages : pool;

  return finalPool[Math.floor(Math.random() * finalPool.length)];
}

// A6: Racing product selection — uses car_templates DB table
async function selectRacingProduct() {
  try {
    const templates = _db.prepare(`
      SELECT * FROM car_templates WHERE active = 1 ORDER BY RANDOM() LIMIT 1
    `).get();
    if (templates) {
      // Build a product-like object from the car template
      const imagePath = templates.preview_image || templates.image_path;
      return {
        id: `racing-${templates.id}`,
        title: templates.name || `Race Car Number Kit - ${templates.car_make || 'Custom'}`,
        images: imagePath ? [{ src: imagePath }] : [],
        product_type: 'racing',
        body_html: templates.description || 'Custom race car decal package — number kits, sponsor panels, full liveries.'
      };
    }
  } catch (e) {
    console.log(`[AI Agent] car_templates query failed, using generic racing post: ${e.message}`);
  }

  // Fallback: generic racing product post
  return {
    id: 'racing-generic',
    title: 'Custom Race Car Number Kit & Decal Package',
    images: [],
    product_type: 'racing',
    body_html: 'Number kits, sponsor panels, full liveries for SCCA, ARA, NASA racers.'
  };
}

// A6: MultiBoard product selection — uses multiboard_products DB table
async function selectMultiboardProduct() {
  try {
    const product = _db.prepare(`
      SELECT * FROM multiboard_products WHERE shopify_product_id IS NOT NULL ORDER BY RANDOM() LIMIT 1
    `).get();
    if (product) {
      const shopify = require('../integrations/shopify');
      try {
        const shopifyProduct = await shopify.getProduct(product.shopify_product_id);
        if (shopifyProduct) return shopifyProduct;
      } catch (e) { /* fall through */ }

      // Return DB product as product-like object
      return {
        id: product.shopify_product_id || `multiboard-${product.id}`,
        title: product.name || 'Multiboard Wall Organization Kit',
        images: product.image_url ? [{ src: product.image_url }] : [],
        product_type: 'multiboard',
        body_html: product.description || 'Modular 3D printed wall organization system.'
      };
    }
  } catch (e) {
    console.log(`[AI Agent] multiboard_products query failed: ${e.message}`);
  }

  return {
    id: 'multiboard-generic',
    title: 'Multiboard Starter Kit - Wall Organization System',
    images: [],
    product_type: 'multiboard',
    body_html: '3D printed modular wall tiles. Snap-together system for any room.'
  };
}

// A6: Laser engraving product selection
async function selectLaserProduct(shopify) {
  // Try Shopify first
  try {
    const batch = await shopify.listProducts({ product_type: 'Laser Engraving', limit: 50, status: 'active' });
    if (batch?.products?.length > 0) {
      const withImages = batch.products.filter(p => p.images?.length > 0);
      const pool = withImages.length > 0 ? withImages : batch.products;
      return pool[Math.floor(Math.random() * pool.length)];
    }
  } catch (e) { /* fall through */ }

  // Try keyword search — only match products that are actually laser-engraved
  // Avoid broad keywords like 'wood' or 'acrylic' which pull in metal prints, apparel, etc.
  const NON_LASER_TYPES = ['metal print', 'metal art', 'tshirt', 't-shirt', 'sticker', 'decal', 'custom vinyl', 'car decal', 'heat transfer', 'racing', 'multiboard', 'apparel', 'hoodie'];
  try {
    for (const keyword of ['laser', 'engrav']) {
      const batch = await shopify.listProducts({ title: keyword, limit: 20, status: 'active' });
      if (batch?.products?.length > 0) {
        // Filter out products that clearly belong to other categories
        const laserOnly = batch.products.filter(p => {
          const pType = (p.product_type || '').toLowerCase();
          return !NON_LASER_TYPES.some(t => pType.includes(t));
        });
        if (laserOnly.length > 0) {
          return laserOnly[Math.floor(Math.random() * laserOnly.length)];
        }
      }
    }
  } catch (e) { /* fall through */ }

  // Generic fallback
  return {
    id: 'laser-generic',
    title: 'Custom Laser Engraving - Personalized Gifts',
    images: [],
    product_type: 'laser-engraving',
    body_html: 'Precision laser engraving on wood, leather, acrylic, glass, and coated metal.'
  };
}

// A6: Custom vinyl product selection
async function selectCustomVinylProduct(shopify) {
  // Try Shopify with relevant product types
  try {
    for (const pType of ['Custom Vinyl', 'Car Decal', 'custom-vinyl']) {
      const batch = await shopify.listProducts({ product_type: pType, limit: 50, status: 'active' });
      if (batch?.products?.length > 0) {
        const withImages = batch.products.filter(p => p.images?.length > 0);
        const pool = withImages.length > 0 ? withImages : batch.products;
        return pool[Math.floor(Math.random() * pool.length)];
      }
    }
  } catch (e) { /* fall through */ }

  // Fallback: promote the designer tool
  return {
    id: 'custom-vinyl-designer',
    title: 'Custom Vinyl - Design Your Own Decals & Stickers',
    images: [],
    product_type: 'custom-vinyl',
    body_html: 'Use our free online designer or upload your own artwork. Custom cut vinyl for cars, laptops, walls, and more.'
  };
}

// Phase 2b: Psychology-enriched caption generation
async function generateCaption(product, category, style, styleDef, catConfig, hookFormula) {
  // Build rich prompt using style definition
  const isRichStyle = styleDef && typeof styleDef === 'object';

  const psychologyInstruction = isRichStyle ? `\nPsychology to apply: ${styleDef.psychology}` : '';
  const structureInstruction = isRichStyle ? `\nCopy structure: ${styleDef.structure}` : '';

  // Hook formula descriptions
  const hookDescriptions = {
    curiosity_gap: 'Open with an incomplete thought that creates an information gap the reader must resolve',
    pattern_interrupt: 'Start with something unexpected that breaks the scroll pattern',
    specific_number: 'Lead with a specific, concrete number or statistic',
    before_after: 'Paint a vivid before/after contrast in the opening line',
    scenario_paint: 'Drop the reader into a specific sensory scene',
    identity_call: 'Call out a specific identity or tribe ("Fellow plant parents...")',
    hot_take: 'Lead with a mildly controversial opinion related to the product category',
    relatable_confession: 'Start with a self-deprecating or relatable admission',
    social_proof_opener: 'Reference what others are doing or buying',
    scarcity_signal: 'Hint at limited availability without being pushy',
    urgency_stat: 'Open with a trending-now data point',
    myth_buster: 'Challenge a common misconception',
    behind_the_scenes: 'Reveal something about how the product is made'
  };

  const hookInstruction = hookFormula && hookDescriptions[hookFormula]
    ? `\nHook approach: ${hookDescriptions[hookFormula]}`
    : '';

  const bannedList = isRichStyle && styleDef.bannedPhrases
    ? `\nNEVER use these phrases: ${styleDef.bannedPhrases.join(', ')}`
    : '';

  const ctaExample = isRichStyle && styleDef.exampleCTA
    ? `\nCTA style (conversational, not "Shop now"): Example — "${styleDef.exampleCTA}"`
    : '';

  const styleDescription = isRichStyle ? styleDef.description : (styleDef || '');

  // A7: Category-specific context for richer AI prompts
  const categoryContextMap = {
    'racing': 'Grassroots racing community (SCCA, ARA, NASA). Individual racers building their look on a budget. Number kits, sponsor panels, full liveries. We are fellow racers — speak their language.',
    'custom-vinyl': 'Custom cut vinyl — car decals, stickers, heat transfers, wall art. Use our free online designer tool or upload your own design. Fast turnaround, professional results.',
    'multiboard': '3D printed modular wall organizers. Authorized Multiboard Reseller. Snap-together wall tiles for kitchen, garage, craft room, desk. Printed locally in Asheville, NC.',
    'laser-engraving': 'Precision laser engraving on wood, leather, acrylic, glass, coated metal, slate. Personalized gifts, custom pieces, corporate orders. Local Asheville craftsmanship.',
    'metal-print': 'Vibrant sublimation metal prints on brushed aluminum. Scratch-resistant, waterproof, UV-safe. Stunning wall art that lasts a lifetime.',
    'tshirt': 'Custom graphic tees, hoodies, and apparel. Trending designs, pop culture, humor. DTG and screen printing.',
    'sticker': 'Vinyl stickers and decals. Weatherproof, durable, fun designs. Bumper stickers, laptop stickers, custom cuts.'
  };
  const categoryContext = categoryContextMap[category] || '';
  const categoryLine = categoryContext ? `\nCategory context: ${categoryContext}` : '';

  const prompt = `You are a social media expert for Blue Ridge Custom Co.
Write ONE engaging Facebook post for this product.

Product: ${product.title}
Category: ${catConfig.displayName}
Target audience: ${catConfig.targetAudience}${categoryLine}

Style: ${style} — ${styleDescription}${psychologyInstruction}${structureInstruction}${hookInstruction}${bannedList}${ctaExample}

Requirements:
- 2-3 sentences with a strong opening hook
- Casual, authentic tone - not corporate
- Use 1-2 emojis naturally
- End with a conversational call to action (NOT "Shop now" or "Buy now")
- Do NOT include any links or URLs in the post
- IMPORTANT: Describe the product accurately based on its title and what it actually is. Do NOT call it laser engraved if it is a metal print, t-shirt, or apparel item. Do NOT mislabel the production method.

Then provide 6-8 relevant hashtags.

Respond with ONLY raw JSON, no explanation, no markdown, no code fences:
{"text": "your post text here", "hashtags": "#tag1 #tag2 #tag3", "hook_formula": "${hookFormula || 'curiosity_gap'}"}`;

  try {
    const result = await callOllama(prompt, { temperature: 0.8, maxTokens: 400 });
    const parsed = extractJSON(result);
    if (parsed) {
      // Validate against banned phrases
      let text = parsed.text || '';
      if (isRichStyle && styleDef.bannedPhrases) {
        for (const phrase of styleDef.bannedPhrases) {
          const regex = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
          text = text.replace(regex, '');
        }
        // Clean up double spaces from removals
        text = text.replace(/\s{2,}/g, ' ').trim();
      }

      return {
        text,
        hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags.join(' ') : (parsed.hashtags || catConfig.defaultHashtags),
        hook_formula: parsed.hook_formula || hookFormula
      };
    }
  } catch (e) {
    console.log(`[AI Agent] Caption generation failed: ${e.message}`);
  }

  // Fallback
  return {
    text: `Check out ${product.title}! Available now at Blue Ridge Custom Co.`,
    hashtags: catConfig.defaultHashtags,
    hook_formula: hookFormula
  };
}

// A3: Map agent category to campaign_type for FB scheduler routing
function getCampaignType(category) {
  const map = {
    'metal-print': 'custom-art',
    'tshirt': 'apparel',
    'sticker': 'sticker',
    'racing': 'racing',
    'custom-vinyl': 'custom-vinyl',
    'multiboard': 'multiboard',
    'laser-engraving': 'laser-engraving'
  };
  return map[category] || 'custom-art';
}

// A5: Map each category to its Shopify collection URL
const COLLECTION_URL_MAP = {
  'metal-print': 'https://blueridgecustomco.us/collections/metal-prints',
  'tshirt': 'https://blueridgecustomco.us/collections/apparel',
  'sticker': 'https://blueridgecustomco.us/collections/stickers',
  'racing': 'https://blueridgecustomco.us/collections/racing',
  'custom-vinyl': 'https://blueridgecustomco.us/collections/custom-vinyl',
  'multiboard': 'https://blueridgecustomco.us/collections/multiboard',
  'laser-engraving': 'https://blueridgecustomco.us/collections/laser-engraving'
};

function pickWeighted(items) {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let random = Math.random() * total;
  for (const item of items) {
    random -= item.weight;
    if (random <= 0) return item.value;
  }
  return items[items.length - 1].value;
}

// ============================================================================
// A/B TESTING (Phase 5)
// ============================================================================

// Phase 5b: Bayesian Beta-Binomial with Monte Carlo simulation

// Marsaglia-Tsang method for Gamma sampling
function gammaSample(alpha, beta) {
  if (alpha < 1) {
    // Boost method for alpha < 1
    return gammaSample(alpha + 1, beta) * Math.pow(Math.random(), 1.0 / alpha);
  }
  const d = alpha - 1.0 / 3.0;
  const c = 1.0 / Math.sqrt(9.0 * d);
  while (true) {
    let x, v;
    do {
      x = boxMullerNormal();
      v = 1.0 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v / beta;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v / beta;
  }
}

// Box-Muller transform for normal distribution
function boxMullerNormal() {
  let u1, u2;
  do { u1 = Math.random(); } while (u1 === 0);
  u2 = Math.random();
  return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
}

function betaSample(alpha, beta) {
  const x = gammaSample(alpha, 1);
  const y = gammaSample(beta, 1);
  return x / (x + y);
}

/**
 * Bayesian A/B test analysis
 * Returns P(A > B) using Monte Carlo simulation
 */
function bayesianAnalysis(scoresA, scoresB, nSimulations = 10000) {
  // Convert weighted scores to success/total using median as threshold
  const allScores = [...scoresA, ...scoresB].filter(s => s > 0);
  const median = allScores.length > 0
    ? allScores.sort((a, b) => a - b)[Math.floor(allScores.length / 2)]
    : 1;

  const successesA = scoresA.filter(s => s >= median).length;
  const successesB = scoresB.filter(s => s >= median).length;
  const totalA = scoresA.length;
  const totalB = scoresB.length;

  // Beta prior (weakly informative)
  const priorAlpha = 1;
  const priorBeta = 1;

  let aWins = 0;
  for (let i = 0; i < nSimulations; i++) {
    const sampleA = betaSample(priorAlpha + successesA, priorBeta + totalA - successesA);
    const sampleB = betaSample(priorAlpha + successesB, priorBeta + totalB - successesB);
    if (sampleA > sampleB) aWins++;
  }

  return {
    probabilityABetter: aWins / nSimulations,
    successRateA: totalA > 0 ? successesA / totalA : 0,
    successRateB: totalB > 0 ? successesB / totalB : 0,
    samplesA: totalA,
    samplesB: totalB,
    avgScoreA: scoresA.length > 0 ? scoresA.reduce((s, v) => s + v, 0) / scoresA.length : 0,
    avgScoreB: scoresB.length > 0 ? scoresB.reduce((s, v) => s + v, 0) / scoresB.length : 0
  };
}

// Phase 5c: Test management

function createTest(testName, testVariable, category, variantA, variantB) {
  // Enforce max 1 test per category
  const existingCat = _db.prepare(`
    SELECT id FROM ab_tests WHERE category = ? AND status = 'active'
  `).get(category);
  if (existingCat) {
    throw new Error(`Active test already exists for category "${category}": ${existingCat.id}`);
  }

  // Enforce max 2 concurrent tests
  const activeCount = _db.prepare(`SELECT COUNT(*) as c FROM ab_tests WHERE status = 'active'`).get()?.c || 0;
  if (activeCount >= 2) {
    throw new Error(`Maximum 2 concurrent tests allowed (currently ${activeCount} active)`);
  }

  const id = crypto.randomUUID();
  _db.prepare(`
    INSERT INTO ab_tests (id, test_name, test_variable, category, variant_a, variant_b, status)
    VALUES (?, ?, ?, ?, ?, ?, 'active')
  `).run(id, testName, testVariable, category, variantA, variantB);

  console.log(`[AI Agent] A/B test created: "${testName}" (${variantA} vs ${variantB}) for ${category}`);
  return { id, testName, testVariable, category, variantA, variantB, status: 'active' };
}

function getActiveTestForCategory(category) {
  return _db.prepare(`
    SELECT * FROM ab_tests WHERE category = ? AND status = 'active'
  `).get(category) || null;
}

function assignToTest(test, postId) {
  // Round-robin assignment (not random) for balanced samples
  const counts = _db.prepare(`
    SELECT variant, COUNT(*) as c FROM ab_test_assignments
    WHERE test_id = ? GROUP BY variant
  `).all(test.id);

  const countA = counts.find(c => c.variant === 'a')?.c || 0;
  const countB = counts.find(c => c.variant === 'b')?.c || 0;
  const variant = countA <= countB ? 'a' : 'b';

  _db.prepare(`
    INSERT INTO ab_test_assignments (test_id, post_id, variant)
    VALUES (?, ?, ?)
  `).run(test.id, postId, variant);

  return variant;
}

function evaluateTests() {
  const activeTests = _db.prepare(`SELECT * FROM ab_tests WHERE status = 'active'`).all();
  const results = [];

  for (const test of activeTests) {
    const assignments = _db.prepare(`
      SELECT variant, weighted_score FROM ab_test_assignments WHERE test_id = ?
    `).all(test.id);

    const scoresA = assignments.filter(a => a.variant === 'a').map(a => a.weighted_score || 0);
    const scoresB = assignments.filter(a => a.variant === 'b').map(a => a.weighted_score || 0);

    const daysSinceCreation = (Date.now() - new Date(test.created_at).getTime()) / 86400000;
    const minPostsPerVariant = test.min_posts_per_variant || 10;
    const hasMinSamples = scoresA.length >= minPostsPerVariant && scoresB.length >= minPostsPerVariant;
    const pastMaxDuration = daysSinceCreation >= (test.max_duration_days || 30);

    let conclusion = null;

    if (hasMinSamples || pastMaxDuration) {
      const analysis = bayesianAnalysis(scoresA, scoresB);

      // Decision threshold: P(A>B) >= 0.85 or P(B>A) >= 0.85
      if (analysis.probabilityABetter >= 0.85) {
        conclusion = { winner: 'a', prob: analysis.probabilityABetter, reason: `P(A>B)=${analysis.probabilityABetter.toFixed(3)}`, analysis };
      } else if (analysis.probabilityABetter <= 0.15) {
        conclusion = { winner: 'b', prob: 1 - analysis.probabilityABetter, reason: `P(B>A)=${(1 - analysis.probabilityABetter).toFixed(3)}`, analysis };
      } else if (pastMaxDuration) {
        conclusion = { winner: 'inconclusive', prob: analysis.probabilityABetter, reason: `Max duration reached, P(A>B)=${analysis.probabilityABetter.toFixed(3)}`, analysis };
      }

      if (conclusion) {
        _db.prepare(`
          UPDATE ab_tests SET status = 'concluded', winner = ?, probability_a_better = ?,
            conclusion_reason = ?, concluded_at = ?
          WHERE id = ?
        `).run(conclusion.winner, analysis.probabilityABetter, conclusion.reason, new Date().toISOString(), test.id);

        console.log(`[AI Agent] A/B test "${test.test_name}" concluded: winner=${conclusion.winner}, ${conclusion.reason}`);

        // Send Telegram alert
        try {
          const telegram = require('../lib/telegram-notifier');
          telegram.sendAlert('milestone', `A/B Test Complete: ${test.test_name}`,
            `Winner: ${conclusion.winner === 'a' ? test.variant_a : conclusion.winner === 'b' ? test.variant_b : 'Inconclusive'}\n` +
            `${conclusion.reason}\n` +
            `Avg score A (${test.variant_a}): ${conclusion.analysis.avgScoreA.toFixed(1)} (n=${conclusion.analysis.samplesA})\n` +
            `Avg score B (${test.variant_b}): ${conclusion.analysis.avgScoreB.toFixed(1)} (n=${conclusion.analysis.samplesB})`
          ).catch(() => {});
        } catch (e) { /* telegram not configured */ }

        results.push({ testId: test.id, testName: test.test_name, ...conclusion });
      }
    } else {
      results.push({
        testId: test.id,
        testName: test.test_name,
        status: 'in_progress',
        samplesA: scoresA.length,
        samplesB: scoresB.length,
        daysSinceCreation: Math.round(daysSinceCreation)
      });
    }
  }

  return results;
}

// ============================================================================
// REPORTS
// ============================================================================

function generateDailyReportData() {
  const today = new Date().toISOString().slice(0, 10);

  const postsPublished = _db.prepare(`
    SELECT COUNT(*) as count FROM scheduled_facebook_posts
    WHERE status = 'published' AND date(published_at) = ?
  `).get(today)?.count || 0;

  const engagement7d = _db.prepare(`
    WITH latest AS (
      SELECT post_id, MAX(collected_at) as max_collected
      FROM engagement_tracking WHERE posted_at > datetime('now', '-7 days')
      GROUP BY post_id
    )
    SELECT SUM(e.likes) as likes, SUM(e.comments) as comments, SUM(e.shares) as shares,
           SUM(e.clicks) as clicks, ROUND(AVG(e.weighted_score), 2) as avg_weighted_score
    FROM engagement_tracking e
    JOIN latest l ON e.post_id = l.post_id AND e.collected_at = l.max_collected
  `).get() || {};

  const queueDepth = _db.prepare(`
    SELECT COUNT(*) as count FROM scheduled_facebook_posts WHERE status = 'pending'
  `).get()?.count || 0;

  const postsPerDay = loadConfig().platforms.facebook.postsPerDay || 2;

  // Phase 4a: Best performing hook formula (7-day window)
  const bestHook = _db.prepare(`
    WITH latest AS (
      SELECT post_id, MAX(collected_at) as max_collected
      FROM engagement_tracking WHERE posted_at > datetime('now', '-7 days')
      GROUP BY post_id
    )
    SELECT s.hook_formula, ROUND(AVG(e.weighted_score), 2) as avg_score, COUNT(*) as count
    FROM engagement_tracking e
    JOIN latest l ON e.post_id = l.post_id AND e.collected_at = l.max_collected
    JOIN scheduled_facebook_posts s ON e.post_id = s.id
    WHERE s.hook_formula IS NOT NULL
    GROUP BY s.hook_formula
    HAVING count >= 2
    ORDER BY avg_score DESC
    LIMIT 1
  `).get() || null;

  // Phase 4a: Category saturation warnings
  const saturationWarnings = [];
  const config = loadConfig();
  const maxCatPerWeek = config.strategy.maxCategoryPostsPerWeek || 3;
  for (const [cat, cfg] of Object.entries(config.categories)) {
    if (!cfg.enabled) continue;
    const count = _db.prepare(`
      SELECT COUNT(*) as c FROM content_calendar
      WHERE product_category = ? AND planned_date > date('now', '-7 days') AND status != 'skipped'
    `).get(cat)?.c || 0;
    if (count >= maxCatPerWeek) {
      saturationWarnings.push(`${cfg.displayName}: ${count} posts in 7 days (limit: ${maxCatPerWeek})`);
    }
  }

  // Phase 4a: Weighted score trend (this week vs last week)
  const thisWeekScore = _db.prepare(`
    WITH latest AS (
      SELECT post_id, MAX(collected_at) as max_collected
      FROM engagement_tracking WHERE posted_at > datetime('now', '-7 days')
      GROUP BY post_id
    )
    SELECT ROUND(AVG(e.weighted_score), 2) as avg FROM engagement_tracking e
    JOIN latest l ON e.post_id = l.post_id AND e.collected_at = l.max_collected
  `).get()?.avg || 0;

  const lastWeekScore = _db.prepare(`
    WITH latest AS (
      SELECT post_id, MAX(collected_at) as max_collected
      FROM engagement_tracking
      WHERE posted_at > datetime('now', '-14 days') AND posted_at <= datetime('now', '-7 days')
      GROUP BY post_id
    )
    SELECT ROUND(AVG(e.weighted_score), 2) as avg FROM engagement_tracking e
    JOIN latest l ON e.post_id = l.post_id AND e.collected_at = l.max_collected
  `).get()?.avg || 0;

  const topPost = _db.prepare(`
    WITH latest AS (
      SELECT post_id, MAX(collected_at) as max_collected
      FROM engagement_tracking WHERE posted_at > datetime('now', '-7 days')
      GROUP BY post_id
    )
    SELECT e.post_id, s.product_name as name, e.weighted_score as engagement
    FROM engagement_tracking e
    JOIN latest l ON e.post_id = l.post_id AND e.collected_at = l.max_collected
    JOIN scheduled_facebook_posts s ON e.post_id = s.id
    ORDER BY e.weighted_score DESC LIMIT 1
  `).get() || null;

  return {
    date: today,
    postsPublished,
    topPost,
    totalLikes: engagement7d.likes || 0,
    totalComments: engagement7d.comments || 0,
    totalShares: engagement7d.shares || 0,
    totalClicks: engagement7d.clicks || 0,
    avgWeightedScore: engagement7d.avg_weighted_score || 0,
    queueDepth,
    queueDays: Math.round(queueDepth / postsPerDay),
    bestHookFormula: bestHook,
    saturationWarnings,
    weightedScoreTrend: {
      thisWeek: thisWeekScore,
      lastWeek: lastWeekScore,
      change: lastWeekScore > 0 ? Math.round((thisWeekScore - lastWeekScore) / lastWeekScore * 100) : 0
    },
    tiktokShop: _tiktokShopData ? {
      capacity: _tiktokShopData.capacity,
      breakdown: _tiktokShopData.breakdown,
      availableSlots: _tiktokShopData.capacity.available
    } : null
  };
}

function generateWeeklyReportData() {
  const analysis = analyzePerformance();
  const config = loadConfig();

  const worked = [];
  const didntWork = [];

  // Analyze what's working
  if (analysis.byCategory.length > 0) {
    const best = analysis.byCategory[0];
    const worst = analysis.byCategory[analysis.byCategory.length - 1];
    if (best.avg_weighted_score > 0) worked.push(`${best.product_category}: ${best.avg_weighted_score} avg weighted score (${best.total_likes} likes)`);
    if (worst.avg_weighted_score === 0 && worst.post_count > 0) didntWork.push(`${worst.product_category}: 0 weighted score across ${worst.post_count} posts`);
  }

  if (analysis.byStyle.length > 0) {
    const bestStyle = analysis.byStyle[0];
    if (bestStyle.avg_weighted_score > 0) worked.push(`${bestStyle.caption_style} style: ${bestStyle.avg_weighted_score} avg weighted score`);
  }

  if (analysis.byHour.length > 0) {
    const bestHour = analysis.byHour[0];
    if (bestHour.avg_weighted_score > 0) worked.push(`Posting at ${bestHour.posted_hour}:00: ${bestHour.avg_weighted_score} weighted score`);
  }

  // Get recent strategy recommendations
  const recentStrategy = _db.prepare(`
    SELECT strategy_json FROM agent_strategy_log
    ORDER BY timestamp DESC LIMIT 1
  `).get();

  let recommendations = ['Gathering more data...'];
  let adjustments = ['None yet — collecting baseline data'];
  if (recentStrategy?.strategy_json) {
    try {
      const s = JSON.parse(recentStrategy.strategy_json);
      if (s.recommendations) recommendations = s.recommendations;
      if (s.newTactics) recommendations.push(...s.newTactics);
    } catch (e) { /* ignore */ }
  }

  const dateEnd = new Date().toISOString().slice(0, 10);
  const dateStart = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

  // Phase 4b: Category x Style matrix
  const categoryStyleMatrix = analysis.byCategoryStyle || [];

  // Phase 4b: Recycling candidates
  const recyclingCandidates = findRecyclablePosts().slice(0, 3).map(p => ({
    name: p.product_name,
    category: p.product_category,
    score: p.weighted_score,
    postedAt: p.posted_at
  }));

  // Phase 4b: Week-over-week trend
  const thisWeekPosts = _db.prepare(`
    SELECT COUNT(*) as c FROM scheduled_facebook_posts
    WHERE status = 'published' AND published_at > datetime('now', '-7 days')
  `).get()?.c || 0;
  const lastWeekPosts = _db.prepare(`
    SELECT COUNT(*) as c FROM scheduled_facebook_posts
    WHERE status = 'published' AND published_at > datetime('now', '-14 days') AND published_at <= datetime('now', '-7 days')
  `).get()?.c || 0;

  // Active A/B tests summary
  const activeTests = _db.prepare(`SELECT test_name, variant_a, variant_b, created_at FROM ab_tests WHERE status = 'active'`).all();

  // TikTok Shop summary
  const tiktokShopSummary = _tiktokShopData ? {
    capacity: _tiktokShopData.capacity,
    breakdown: _tiktokShopData.breakdown,
    recommendations: _tiktokShopData.capacity.available < 10
      ? ['TikTok Shop nearly full — consider rotating low-performing products']
      : _tiktokShopData.capacity.available > 50
        ? ['TikTok Shop has room — consider adding more metal prints and multiboards']
        : ['TikTok Shop capacity healthy']
  } : null;

  return {
    dateRange: `${dateStart} to ${dateEnd}`,
    worked: worked.length > 0 ? worked : ['Not enough data yet'],
    didntWork: didntWork.length > 0 ? didntWork : ['Not enough data yet'],
    adjustments,
    recommendations,
    nextWeekPlan: `${config.platforms.facebook.postsPerDay * 7} posts planned across ${Object.keys(config.categories).filter(k => config.categories[k].enabled).length} categories`,
    categoryStyleMatrix,
    recyclingCandidates,
    weekOverWeek: { thisWeek: thisWeekPosts, lastWeek: lastWeekPosts },
    activeABTests: activeTests,
    tiktokShop: tiktokShopSummary
  };
}

// ============================================================================
// MAIN CYCLE
// ============================================================================

async function runAgentCycle() {
  if (_running) {
    console.log('[AI Agent] Cycle already running, skipping');
    return;
  }

  _running = true;
  _cycleCount++;
  const cycleStart = Date.now();
  console.log(`[AI Agent] === Cycle #${_cycleCount} starting ===`);

  const results = { cycle: _cycleCount, engagement: null, analysis: null, strategy: null, content: null, abTests: null, tiktokShop: null };

  try {
    // Phase 0: Collect TikTok Shop data (used by strategy + content planning)
    results.tiktokShop = await collectTikTokShopData();

    // Phase 1: Collect engagement data
    results.engagement = await collectEngagementData();

    // Phase 2: Analyze performance
    results.analysis = analyzePerformance();

    // Phase 3: Strategy (only if we have enough data)
    const config = loadConfig();
    if (results.analysis.totalPostsTracked >= (config.strategy.abTestMinSample || 10)) {
      const ollamaStrategy = await callOllamaForStrategy(results.analysis);
      if (ollamaStrategy) {
        const recommendations = applyStrategyAdjustments(ollamaStrategy);
        results.strategy = { applied: true, recommendations };
        console.log(`[AI Agent] Strategy updated: ${recommendations.length} recommendations`);
      }
    } else {
      console.log(`[AI Agent] Only ${results.analysis.totalPostsTracked} posts tracked, need ${config.strategy.abTestMinSample} for strategy adaptation`);
    }

    // Phase 3.5: Evaluate A/B tests
    try {
      results.abTests = evaluateTests();
      if (results.abTests.length > 0) {
        const concluded = results.abTests.filter(t => t.winner);
        if (concluded.length > 0) {
          console.log(`[AI Agent] ${concluded.length} A/B test(s) concluded this cycle`);
        }
      }
    } catch (e) {
      console.error('[AI Agent] A/B test evaluation error:', e.message);
    }

    // Phase 4: Plan and generate content
    const planResult = await planNextContent();
    results.content = planResult;

    if (planResult.planned > 0) {
      const execResult = await executeContentPlan();
      results.content.generated = execResult.generated;
    }

    // Phase 5: Check for Telegram reports
    const now = new Date();
    const hour = now.getUTCHours();

    // Daily report at configured hour
    if (hour === (config.telegram.dailyReportHour || 20)) {
      try {
        const telegram = require('../lib/telegram-notifier');
        const reportData = generateDailyReportData();
        await telegram.sendDailyReport(reportData);
        console.log('[AI Agent] Daily report sent to Telegram');
      } catch (e) {
        console.error('[AI Agent] Daily report send failed:', e.message);
      }
    }

    // Weekly report on configured day at 9 AM
    if (now.getUTCDay() === (config.telegram.weeklyReportDay || 1) && hour === 13) { // 9 AM EST = 13 UTC
      try {
        const telegram = require('../lib/telegram-notifier');
        const weeklyData = generateWeeklyReportData();
        await telegram.sendWeeklyReport(weeklyData);
        console.log('[AI Agent] Weekly report sent to Telegram');
      } catch (e) {
        console.error('[AI Agent] Weekly report send failed:', e.message);
      }
    }

    // Phase 6: Check for viral posts or notable events
    await checkAlerts();

  } catch (e) {
    console.error(`[AI Agent] Cycle #${_cycleCount} error:`, e.message);
    results.error = e.message;
  } finally {
    _running = false;
    _lastCycleAt = new Date().toISOString();

    // Update config state
    const config = loadConfig();
    config.agentState.lastCycleAt = _lastCycleAt;
    config.agentState.cycleCount = _cycleCount;
    saveConfig(config);
  }

  const elapsed = Date.now() - cycleStart;
  console.log(`[AI Agent] === Cycle #${_cycleCount} complete (${elapsed}ms) ===`);
  return results;
}

async function checkAlerts() {
  const telegram = require('../lib/telegram-notifier');
  if (!telegram.isConfigured()) return;

  const config = loadConfig();
  const viralThreshold = config.telegram.viralThreshold || 50;

  // Check for viral posts (use weighted_score)
  const viral = _db.prepare(`
    WITH latest AS (
      SELECT post_id, MAX(collected_at) as max_collected
      FROM engagement_tracking WHERE posted_at > datetime('now', '-3 days')
      GROUP BY post_id
    )
    SELECT e.post_id, e.product_category, e.weighted_score as total_engagement
    FROM engagement_tracking e
    JOIN latest l ON e.post_id = l.post_id AND e.collected_at = l.max_collected
    WHERE e.weighted_score >= ?
  `).all(viralThreshold);

  // Check if we already alerted for these
  for (const post of viral) {
    const alreadyAlerted = _db.prepare(`
      SELECT 1 FROM pipeline_actions
      WHERE trigger_reason = 'viral_post' AND action_details_json LIKE ?
      AND timestamp > datetime('now', '-7 days')
    `).get(`%${post.post_id}%`);

    if (!alreadyAlerted) {
      const productName = _db.prepare(`SELECT product_name FROM scheduled_facebook_posts WHERE id = ?`).get(post.post_id)?.product_name || 'Unknown';
      await telegram.sendAlert('milestone', 'Viral Post Detected!',
        `"${productName}" has ${post.total_engagement} weighted engagements! (${post.product_category})`);

      _db.prepare(`INSERT INTO pipeline_actions (id, timestamp, trigger_reason, action_type, action_details_json, status)
        VALUES (?, ?, 'viral_post', 'send_alert', ?, 'executed')`
      ).run(crypto.randomUUID(), new Date().toISOString(), JSON.stringify({ post_id: post.post_id, engagement: post.total_engagement }));
    }
  }
}

// ============================================================================
// DAEMON
// ============================================================================

function startAgent(db, options = {}) {
  const intervalMinutes = options.intervalMinutes || 30;

  try {
    _db = new Database(DB_PATH);
    ensureTables(_db);
  } catch (e) {
    console.error('[AI Agent] DB init failed:', e.message);
    return;
  }

  // Create default config if missing
  if (!fs.existsSync(CONFIG_PATH)) {
    saveConfig(DEFAULT_CONFIG);
    console.log('[AI Agent] Created default config at', CONFIG_PATH);
  }

  // Run first cycle after a delay (let other services start first)
  setTimeout(() => {
    runAgentCycle().catch(e => console.error('[AI Agent] Initial cycle error:', e.message));
  }, 60000); // 1 minute delay

  // Then run on interval
  _interval = setInterval(() => {
    runAgentCycle().catch(e => console.error('[AI Agent] Cycle error:', e.message));
  }, intervalMinutes * 60 * 1000);

  console.log(`[AI Agent] Started (interval: ${intervalMinutes}m)`);
}

function stopAgent() {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
  if (_db) {
    _db.close();
    _db = null;
  }
}

function isRunning() {
  return !!_interval;
}

// ============================================================================
// API ROUTES
// ============================================================================

function handleAgentRoute(req, res, parsedUrl, sendJson) {
  const subpath = parsedUrl.pathname.replace('/api/agent', '').replace(/^\//, '');
  const method = req.method;

  try {
    // GET /api/agent/status
    if (method === 'GET' && subpath === 'status') {
      const config = loadConfig();
      sendJson(res, 200, {
        running: isRunning(),
        cycleCount: _cycleCount,
        lastCycleAt: _lastCycleAt,
        enabledPlatforms: Object.entries(config.platforms).filter(([_, p]) => p.enabled).map(([n]) => n),
        enabledCategories: Object.entries(config.categories).filter(([_, c]) => c.enabled).map(([n, c]) => ({
          name: n, weight: c.postingWeight
        })),
        queueDepth: _db?.prepare(`SELECT COUNT(*) as c FROM scheduled_facebook_posts WHERE status = 'pending'`).get()?.c || 0,
        postsTracked: _db?.prepare(`SELECT COUNT(DISTINCT post_id) as c FROM engagement_tracking`).get()?.c || 0,
        tiktokShop: _tiktokShopData || null
      });
      return true;
    }

    // GET /api/agent/engagement
    if (method === 'GET' && subpath === 'engagement') {
      const days = parseInt(parsedUrl.query?.days) || 30;
      const category = parsedUrl.query?.category;

      let query = `SELECT * FROM engagement_tracking WHERE posted_at > datetime('now', '-${days} days')`;
      if (category) query += ` AND product_category = '${category.replace(/'/g, '')}'`;
      query += ` ORDER BY posted_at DESC LIMIT 100`;

      sendJson(res, 200, { data: _db.prepare(query).all() });
      return true;
    }

    // GET /api/agent/engagement/summary
    if (method === 'GET' && (subpath === 'engagement/summary' || subpath === 'engagement%2Fsummary')) {
      sendJson(res, 200, analyzePerformance());
      return true;
    }

    // GET /api/agent/strategy
    if (method === 'GET' && subpath === 'strategy') {
      const config = loadConfig();
      const recent = _db.prepare(`SELECT * FROM agent_strategy_log ORDER BY timestamp DESC LIMIT 5`).all();
      sendJson(res, 200, {
        currentWeights: Object.fromEntries(Object.entries(config.categories).map(([k, v]) => [k, { weight: v.postingWeight, styles: v.captionStyles }])),
        recentDecisions: recent.map(r => ({
          ...r,
          strategy_json: r.strategy_json ? JSON.parse(r.strategy_json) : null,
          decisions_json: r.decisions_json ? JSON.parse(r.decisions_json) : null
        }))
      });
      return true;
    }

    // GET /api/agent/calendar
    if (method === 'GET' && subpath === 'calendar') {
      const entries = _db.prepare(`
        SELECT * FROM content_calendar
        WHERE planned_date >= date('now', '-1 day')
        ORDER BY planned_date, planned_time
        LIMIT 50
      `).all();
      sendJson(res, 200, { data: entries });
      return true;
    }

    // GET /api/agent/categories
    if (method === 'GET' && subpath === 'categories') {
      const config = loadConfig();
      sendJson(res, 200, { categories: config.categories });
      return true;
    }

    // PUT /api/agent/categories/:name
    if (method === 'PUT' && subpath.startsWith('categories/')) {
      const catName = subpath.replace('categories/', '');
      const config = loadConfig();
      if (!config.categories[catName]) {
        sendJson(res, 404, { error: `Category ${catName} not found` });
        return true;
      }
      // Read body and merge
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const updates = JSON.parse(body);
          config.categories[catName] = { ...config.categories[catName], ...updates };
          saveConfig(config);
          sendJson(res, 200, { success: true, category: config.categories[catName] });
        } catch (e) {
          sendJson(res, 400, { error: e.message });
        }
      });
      return true;
    }

    // POST /api/agent/run
    if (method === 'POST' && subpath === 'run') {
      runAgentCycle().then(result => {
        sendJson(res, 200, { success: true, result });
      }).catch(e => {
        sendJson(res, 500, { error: e.message });
      });
      return true;
    }

    // GET /api/agent/approvals
    if (method === 'GET' && subpath === 'approvals') {
      const approvals = _db.prepare(`SELECT * FROM agent_approvals ORDER BY timestamp DESC LIMIT 20`).all();
      sendJson(res, 200, { data: approvals });
      return true;
    }

    // POST /api/agent/approval-callback
    if (method === 'POST' && (subpath === 'approval-callback' || subpath === 'approval%2Dcallback')) {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { command } = JSON.parse(body);
          const match = command.match(/^\/(approve|deny)_(.+)$/);
          if (!match) {
            sendJson(res, 400, { error: 'Invalid command format' });
            return;
          }
          const [_, action, approvalId] = match;
          const approval = _db.prepare(`SELECT * FROM agent_approvals WHERE id = ? AND status = 'pending'`).get(approvalId);
          if (!approval) {
            sendJson(res, 404, { message: 'No pending approval found with that ID' });
            return;
          }
          _db.prepare(`UPDATE agent_approvals SET status = ?, responded_at = ? WHERE id = ?`)
            .run(action === 'approve' ? 'approved' : 'denied', new Date().toISOString(), approvalId);
          sendJson(res, 200, { message: `${action === 'approve' ? 'Approved' : 'Denied'}: ${approval.description}` });
        } catch (e) {
          sendJson(res, 400, { error: e.message });
        }
      });
      return true;
    }

    // GET /api/agent/report/daily
    if (method === 'GET' && (subpath === 'report/daily' || subpath === 'report%2Fdaily')) {
      sendJson(res, 200, generateDailyReportData());
      return true;
    }

    // GET /api/agent/report/weekly
    if (method === 'GET' && (subpath === 'report/weekly' || subpath === 'report%2Fweekly')) {
      sendJson(res, 200, generateWeeklyReportData());
      return true;
    }

    // GET /api/agent/config
    if (method === 'GET' && subpath === 'config') {
      sendJson(res, 200, loadConfig());
      return true;
    }

    // PUT /api/agent/config
    if (method === 'PUT' && subpath === 'config') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const updates = JSON.parse(body);
          const config = loadConfig();
          const merged = deepMerge(config, updates);
          saveConfig(merged);
          sendJson(res, 200, { success: true });
        } catch (e) {
          sendJson(res, 400, { error: e.message });
        }
      });
      return true;
    }

    // ========== Phase 5e: A/B Test API endpoints ==========

    // GET /api/agent/ab-tests
    if (method === 'GET' && subpath === 'ab-tests') {
      const tests = _db.prepare(`SELECT * FROM ab_tests ORDER BY created_at DESC`).all();
      sendJson(res, 200, { data: tests });
      return true;
    }

    // POST /api/agent/ab-tests
    if (method === 'POST' && subpath === 'ab-tests') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { testName, testVariable, category, variantA, variantB } = JSON.parse(body);
          if (!testName || !testVariable || !category || !variantA || !variantB) {
            sendJson(res, 400, { error: 'Required: testName, testVariable, category, variantA, variantB' });
            return;
          }
          const test = createTest(testName, testVariable, category, variantA, variantB);
          sendJson(res, 201, test);
        } catch (e) {
          sendJson(res, 400, { error: e.message });
        }
      });
      return true;
    }

    // GET /api/agent/ab-tests/:id
    if (method === 'GET' && subpath.startsWith('ab-tests/') && !subpath.includes('evaluate')) {
      const testId = subpath.replace('ab-tests/', '');
      const test = _db.prepare(`SELECT * FROM ab_tests WHERE id = ?`).get(testId);
      if (!test) {
        sendJson(res, 404, { error: 'Test not found' });
        return true;
      }
      const assignments = _db.prepare(`
        SELECT * FROM ab_test_assignments WHERE test_id = ? ORDER BY assigned_at
      `).all(testId);

      // Run analysis if enough data
      const scoresA = assignments.filter(a => a.variant === 'a').map(a => a.weighted_score || 0);
      const scoresB = assignments.filter(a => a.variant === 'b').map(a => a.weighted_score || 0);
      let analysis = null;
      if (scoresA.length >= 3 && scoresB.length >= 3) {
        analysis = bayesianAnalysis(scoresA, scoresB);
      }

      sendJson(res, 200, { test, assignments, analysis });
      return true;
    }

    // DELETE /api/agent/ab-tests/:id
    if (method === 'DELETE' && subpath.startsWith('ab-tests/')) {
      const testId = subpath.replace('ab-tests/', '');
      _db.prepare(`UPDATE ab_tests SET status = 'cancelled', concluded_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), testId);
      sendJson(res, 200, { success: true, message: 'Test cancelled' });
      return true;
    }

    // POST /api/agent/ab-tests/evaluate
    if (method === 'POST' && (subpath === 'ab-tests/evaluate' || subpath === 'ab-tests%2Fevaluate')) {
      const results = evaluateTests();
      sendJson(res, 200, { results });
      return true;
    }

  } catch (e) {
    console.error('[AI Agent] Route error:', e.message);
    sendJson(res, 500, { error: e.message });
    return true;
  }

  return false; // Route not matched
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  startAgent,
  stopAgent,
  isRunning,
  runAgentCycle,
  collectEngagementData,
  collectTikTokShopData,
  analyzePerformance,
  planNextContent,
  executeContentPlan,
  generateDailyReportData,
  generateWeeklyReportData,
  handleAgentRoute,
  loadConfig,
  saveConfig,
  findRecyclablePosts,
  createTest,
  evaluateTests,
  bayesianAnalysis
};
