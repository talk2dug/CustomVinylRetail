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
 *
 * Runs every 30 minutes, integrates with pipeline monitor.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const Database = require('better-sqlite3');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const DB_PATH = path.join(APP_ROOT, 'data', 'store.db');
const CONFIG_PATH = path.join(APP_ROOT, 'data', 'ai-sales-agent.json');
const OLLAMA_HOST = '127.0.0.1';
const OLLAMA_PORT = 11434;
const OLLAMA_MODEL = 'llama3.1:8b';

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
  `);
}

// ============================================================================
// CONFIG
// ============================================================================

const DEFAULT_CONFIG = {
  version: 1,
  agentState: {
    enabled: true,
    lastCycleAt: null,
    cycleCount: 0,
    currentStrategy: null
  },
  platforms: {
    facebook: { enabled: true, postsPerDay: 2, bestHours: [10, 14, 19], maxPostsPerWeek: 14 },
    pinterest: { enabled: false, postsPerDay: 0, note: 'Token expired - needs PINTEREST_ACCESS_TOKEN' },
    tiktok: { enabled: false, postsPerDay: 0, note: 'Needs TIKTOK_ACCESS_TOKEN and audit' },
    instagram: { enabled: false, postsPerDay: 0, note: 'Needs IG Business account linked to FB page' }
  },
  categories: {
    'metal-print': {
      displayName: 'Metal Prints',
      enabled: true,
      postingWeight: 0.55,
      shopifyProductTypes: ['Metal Print', 'Metal Print Wall Art', 'Metal art', 'Metal art piece'],
      captionStyles: { showcase: 0.3, lifestyle: 0.3, quality: 0.2, humor: 0.1, urgency: 0.1 },
      defaultHashtags: '#metalprint #wallart #homedecor #metalwallart #artprint #BlueRidgeCustomCo',
      targetAudience: 'Homeowners, interior design enthusiasts, car lovers, art collectors'
    },
    'tshirt': {
      displayName: 'T-Shirts',
      enabled: true,
      postingWeight: 0.30,
      shopifyProductTypes: ['tshirt', 'T-Shirt'],
      captionStyles: { humor: 0.4, showcase: 0.2, urgency: 0.2, lifestyle: 0.2 },
      defaultHashtags: '#customtee #graphictee #tshirt #trending #shopsmall #BlueRidgeCustomCo',
      targetAudience: 'GenX, Millennials, meme culture, casual fashion'
    },
    'sticker': {
      displayName: 'Stickers',
      enabled: true,
      postingWeight: 0.15,
      shopifyProductTypes: ['sticker', 'sticker-pack', 'Decals', 'Decal', 'Bumper stickers', 'Sticker Pack'],
      captionStyles: { humor: 0.4, showcase: 0.3, lifestyle: 0.2, urgency: 0.1 },
      defaultHashtags: '#stickers #vinylsticker #customsticker #stickerlife #BlueRidgeCustomCo',
      targetAudience: 'Young adults, sticker collectors, laptop customizers'
    }
  },
  captionStyleDefinitions: {
    showcase: 'Highlight the product quality, details, and craftsmanship. Describe what makes it special.',
    lifestyle: 'Show the product in context. Describe a scene where it fits. Make it aspirational.',
    humor: 'Use wit, puns, or relatable humor. Be playful and casual. Match Gen X/Millennial humor.',
    urgency: 'Create FOMO. Limited availability, trending now, selling fast. Drive immediate action.',
    quality: 'Focus on materials, durability, craftsmanship. Premium positioning.'
  },
  strategy: {
    learningRate: 0.1,
    underexposedBoostDays: 7,
    repostCooldownDays: 14,
    abTestMinSample: 10,
    engagementWindowDays: 30
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
      // Merge with defaults to fill any missing keys
      return deepMerge(DEFAULT_CONFIG, data);
    }
  } catch (e) {
    console.error('[AI Agent] Error loading config:', e.message);
  }
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
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
  const timeout = options.timeout || 180000;
  const temperature = options.temperature || 0.7;

  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      options: { temperature, num_predict: options.maxTokens || 800 }
    });

    const req = http.request({
      hostname: OLLAMA_HOST,
      port: OLLAMA_PORT,
      path: '/api/generate',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.response || '');
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Ollama timeout')); });
    req.write(postData);
    req.end();
  });
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
    // Collect every 6 hours for first 3 days, then every 24 hours
    const collectInterval = hoursOld < 72 ? 6 : 24;
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
    const total = likes + comments + shares;
    const engagementRate = insight.reach > 0 ? (total / insight.reach * 100) : 0;

    try {
      _db.prepare(`
        INSERT OR REPLACE INTO engagement_tracking
        (post_id, facebook_post_id, platform, product_uid, product_category,
         campaign_slug, caption_style, posted_at, posted_hour, posted_day_of_week,
         likes, comments, shares, clicks, engagement_rate, collected_at)
        VALUES (?, ?, 'facebook', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        post.id, post.facebook_post_id, post.product_uid, category,
        post.campaign_slug, style, post.published_at,
        postedAt.getUTCHours(), postedAt.getUTCDay(),
        likes, comments, shares, clicks, engagementRate, now
      );
      collected++;
    } catch (e) {
      console.error('[AI Agent] DB insert error:', e.message);
    }
  }

  console.log(`[AI Agent] Collected engagement for ${collected}/${batch.length} posts`);
  return { collected, total: publishedPosts.length };
}

function categorizeProduct(campaignType, campaignSlug) {
  if (!campaignType && !campaignSlug) return 'other';
  const slug = (campaignSlug || '').toLowerCase();
  const type = (campaignType || '').toLowerCase();

  if (type === 'apparel' || slug.includes('trend') || slug.includes('shirt') || slug.includes('apparel')) return 'tshirt';
  if (slug.includes('sticker') || slug.includes('decal') || slug.includes('bumper')) return 'sticker';
  if (type === 'custom-art' || slug.includes('metal') || slug.includes('print') || slug.includes('art')) return 'metal-print';
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

  const byCategory = _db.prepare(`
    ${latestSnapshotCTE}
    SELECT e.product_category,
           COUNT(*) as post_count,
           ROUND(AVG(e.engagement_rate), 2) as avg_engagement,
           SUM(e.likes) as total_likes,
           SUM(e.comments) as total_comments,
           SUM(e.shares) as total_shares,
           SUM(e.clicks) as total_clicks
    FROM engagement_tracking e
    JOIN latest l ON e.post_id = l.post_id AND e.collected_at = l.max_collected
    GROUP BY e.product_category
    ORDER BY avg_engagement DESC
  `).all();

  const byStyle = _db.prepare(`
    ${latestSnapshotCTE}
    SELECT e.caption_style,
           COUNT(*) as post_count,
           ROUND(AVG(e.engagement_rate), 2) as avg_engagement,
           SUM(e.likes) as total_likes,
           SUM(e.clicks) as total_clicks
    FROM engagement_tracking e
    JOIN latest l ON e.post_id = l.post_id AND e.collected_at = l.max_collected
    GROUP BY e.caption_style
    ORDER BY avg_engagement DESC
  `).all();

  const byHour = _db.prepare(`
    ${latestSnapshotCTE}
    SELECT e.posted_hour,
           COUNT(*) as post_count,
           ROUND(AVG(e.engagement_rate), 2) as avg_engagement
    FROM engagement_tracking e
    JOIN latest l ON e.post_id = l.post_id AND e.collected_at = l.max_collected
    GROUP BY e.posted_hour
    ORDER BY avg_engagement DESC
  `).all();

  const byDayOfWeek = _db.prepare(`
    ${latestSnapshotCTE}
    SELECT e.posted_day_of_week,
           COUNT(*) as post_count,
           ROUND(AVG(e.engagement_rate), 2) as avg_engagement
    FROM engagement_tracking e
    JOIN latest l ON e.post_id = l.post_id AND e.collected_at = l.max_collected
    GROUP BY e.posted_day_of_week
    ORDER BY avg_engagement DESC
  `).all();

  const topPosts = _db.prepare(`
    ${latestSnapshotCTE}
    SELECT e.post_id, e.product_uid, e.product_category, e.caption_style,
           e.posted_hour, e.likes, e.comments, e.shares, e.engagement_rate
    FROM engagement_tracking e
    JOIN latest l ON e.post_id = l.post_id AND e.collected_at = l.max_collected
    ORDER BY (e.likes + e.comments + e.shares) DESC
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
  const catSummary = analysis.byCategory.map(c => `${c.category}: ${c.avg_engagement.toFixed(1)} avg eng, ${c.total_posts} posts`).join('; ');
  const styleSummary = analysis.byStyle.slice(0, 5).map(s => `${s.caption_style}: ${s.avg_engagement.toFixed(1)} avg`).join('; ');
  const hourSummary = analysis.byHour.slice(0, 3).map(h => `${h.hour}:00=${h.avg_engagement.toFixed(1)}`).join(', ');

  const prompt = `Marketing strategy for online store (metal prints, t-shirts, stickers).
Data: ${catSummary}. Styles: ${styleSummary}. Best hours: ${hourSummary}.
Current weights: ${JSON.stringify(currentWeights)}.
Output ONLY JSON: {"categoryWeightAdjustments":{"metal-print":0.55,"tshirt":0.30,"sticker":0.15},"bestPostingHours":[10,14,19],"recommendations":["one tip"],"confidence":0.7}`;

  try {
    const result = await callOllama(prompt, { temperature: 0.5, maxTokens: 300, timeout: 240000 });
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('[AI Agent] Ollama strategy: could not parse JSON response');
      return null;
    }
    return JSON.parse(jsonMatch[0]);
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
    // Pick category by weight
    const category = pickWeighted(enabledCategories.map(([name, cfg]) => ({
      value: name, weight: cfg.postingWeight
    })));
    const catConfig = config.categories[category];

    // Pick caption style by weight
    const style = pickWeighted(Object.entries(catConfig.captionStyles).map(([name, weight]) => ({
      value: name, weight
    })));

    // Pick posting time
    const hour = bestHours[i % bestHours.length];
    const daysAhead = Math.floor(i / postsPerDay) + 1;
    const plannedDate = new Date();
    plannedDate.setDate(plannedDate.getDate() + daysAhead);
    const dateStr = plannedDate.toISOString().slice(0, 10);
    const timeStr = `${String(hour).padStart(2, '0')}:00`;

    planned.push({
      id: crypto.randomUUID(),
      planned_date: dateStr,
      planned_time: timeStr,
      platform: 'facebook',
      product_category: category,
      caption_style: style,
      status: 'planned',
      reason: `Weighted selection: ${category} (${Math.round(catConfig.postingWeight * 100)}%), style: ${style}`
    });
  }

  // Insert into content_calendar
  const insert = _db.prepare(`
    INSERT INTO content_calendar (id, planned_date, planned_time, platform, product_category, caption_style, status, reason)
    VALUES (?, ?, ?, ?, ?, ?, 'planned', ?)
  `);

  for (const p of planned) {
    insert.run(p.id, p.planned_date, p.planned_time, p.platform, p.product_category, p.caption_style, p.reason);
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
      const product = await selectProduct(entry.product_category, catConfig);
      if (!product) {
        console.log(`[AI Agent] No product found for category: ${entry.product_category}`);
        _db.prepare(`UPDATE content_calendar SET status = 'skipped', reason = 'No product found' WHERE id = ?`).run(entry.id);
        continue;
      }

      // Generate caption via Ollama
      const styleDef = config.captionStyleDefinitions[entry.caption_style] || '';
      const caption = await generateCaption(product, entry.product_category, entry.caption_style, styleDef, catConfig);

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
      const hashtags = catConfig.defaultHashtags || '';
      const collectionUrl = `https://blueridgecustomco.us/collections/all`;

      const postText = caption.text || `Check out ${product.title}! Available now at Blue Ridge Custom Co.`;
      const postHashtags = caption.hashtags || hashtags;

      _db.prepare(`
        INSERT INTO scheduled_facebook_posts
        (id, campaign_slug, product_uid, product_name, campaign_type,
         artwork_path, post_text, post_hashtags,
         collection_url, scheduled_for, status, generate_ai_on_post, ai_style)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)
      `).run(
        postId,
        `agent-${entry.product_category}`,
        String(product.id),
        product.title,
        entry.product_category === 'tshirt' ? 'apparel' : 'custom-art',
        imageUrl,
        postText,
        postHashtags,
        collectionUrl,
        scheduledFor,
        entry.caption_style
      );

      // Update calendar entry
      _db.prepare(`
        UPDATE content_calendar SET status = 'scheduled', scheduled_post_id = ?, product_uid = ?, product_title = ?, updated_at = ?
        WHERE id = ?
      `).run(postId, String(product.id), product.title, new Date().toISOString(), entry.id);

      generated++;
      console.log(`[AI Agent] Scheduled: "${product.title}" (${entry.product_category}/${entry.caption_style}) for ${scheduledFor}`);

    } catch (e) {
      console.error(`[AI Agent] Content execution error:`, e.message);
      _db.prepare(`UPDATE content_calendar SET status = 'skipped', reason = ? WHERE id = ?`).run(e.message, entry.id);
    }
  }

  return { generated };
}

async function selectProduct(category, catConfig) {
  const shopify = require('../integrations/shopify');
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

  // Filter out recently posted
  const candidates = products.filter(p => !recentlyPosted.includes(String(p.id)));

  // If all products have been posted recently, just pick from all
  const pool = candidates.length > 0 ? candidates : products;

  // Pick random from pool (weighted toward those with images)
  const withImages = pool.filter(p => p.images?.length > 0 || p.image);
  const finalPool = withImages.length > 0 ? withImages : pool;

  return finalPool[Math.floor(Math.random() * finalPool.length)];
}

async function generateCaption(product, category, style, styleDef, catConfig) {
  const prompt = `You are a social media expert for Blue Ridge Custom Co.
Write ONE engaging Facebook post for this product.

Product: ${product.title}
Category: ${catConfig.displayName}
Target audience: ${catConfig.targetAudience}

Style: ${style} — ${styleDef}

Requirements:
- 2-3 sentences with a strong opening hook
- Casual, authentic tone - not corporate
- Use 1-2 emojis naturally
- End with a subtle call to action

Then provide 6-8 relevant hashtags.

Output ONLY valid JSON:
{"text": "your post text here", "hashtags": "#tag1 #tag2 #tag3"}`;

  try {
    const result = await callOllama(prompt, { temperature: 0.8, maxTokens: 400 });
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        text: parsed.text || '',
        hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags.join(' ') : (parsed.hashtags || catConfig.defaultHashtags)
      };
    }
  } catch (e) {
    console.log(`[AI Agent] Caption generation failed: ${e.message}`);
  }

  // Fallback
  return {
    text: `Check out ${product.title}! Available now at Blue Ridge Custom Co.`,
    hashtags: catConfig.defaultHashtags
  };
}

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
           SUM(e.clicks) as clicks
    FROM engagement_tracking e
    JOIN latest l ON e.post_id = l.post_id AND e.collected_at = l.max_collected
  `).get() || {};

  const queueDepth = _db.prepare(`
    SELECT COUNT(*) as count FROM scheduled_facebook_posts WHERE status = 'pending'
  `).get()?.count || 0;

  const postsPerDay = loadConfig().platforms.facebook.postsPerDay || 2;

  return {
    date: today,
    postsPublished,
    totalLikes: engagement7d.likes || 0,
    totalComments: engagement7d.comments || 0,
    totalShares: engagement7d.shares || 0,
    totalClicks: engagement7d.clicks || 0,
    queueDepth,
    queueDays: Math.round(queueDepth / postsPerDay)
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
    if (best.avg_engagement > 0) worked.push(`${best.product_category}: ${best.avg_engagement}% avg engagement (${best.total_likes} likes)`);
    if (worst.avg_engagement === 0 && worst.post_count > 0) didntWork.push(`${worst.product_category}: 0% engagement across ${worst.post_count} posts`);
  }

  if (analysis.byStyle.length > 0) {
    const bestStyle = analysis.byStyle[0];
    if (bestStyle.avg_engagement > 0) worked.push(`${bestStyle.caption_style} style: ${bestStyle.avg_engagement}% avg engagement`);
  }

  if (analysis.byHour.length > 0) {
    const bestHour = analysis.byHour[0];
    if (bestHour.avg_engagement > 0) worked.push(`Posting at ${bestHour.posted_hour}:00: ${bestHour.avg_engagement}% engagement`);
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

  return {
    dateRange: `${dateStart} to ${dateEnd}`,
    worked: worked.length > 0 ? worked : ['Not enough data yet'],
    didntWork: didntWork.length > 0 ? didntWork : ['Not enough data yet'],
    adjustments,
    recommendations,
    nextWeekPlan: `${config.platforms.facebook.postsPerDay * 7} posts planned across ${Object.keys(config.categories).filter(k => config.categories[k].enabled).length} categories`
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

  const results = { cycle: _cycleCount, engagement: null, analysis: null, strategy: null, content: null };

  try {
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

  // Check for viral posts
  const viral = _db.prepare(`
    WITH latest AS (
      SELECT post_id, MAX(collected_at) as max_collected
      FROM engagement_tracking WHERE posted_at > datetime('now', '-3 days')
      GROUP BY post_id
    )
    SELECT e.post_id, e.product_category, (e.likes + e.comments + e.shares) as total_engagement
    FROM engagement_tracking e
    JOIN latest l ON e.post_id = l.post_id AND e.collected_at = l.max_collected
    WHERE (e.likes + e.comments + e.shares) >= ?
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
        `"${productName}" has ${post.total_engagement} engagements! (${post.product_category})`);

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
        postsTracked: _db?.prepare(`SELECT COUNT(DISTINCT post_id) as c FROM engagement_tracking`).get()?.c || 0
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
  analyzePerformance,
  planNextContent,
  executeContentPlan,
  generateDailyReportData,
  generateWeeklyReportData,
  handleAgentRoute,
  loadConfig,
  saveConfig
};
