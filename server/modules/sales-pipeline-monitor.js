/**
 * Autonomous Sales Pipeline Monitor
 *
 * Runs as a daemon (every 15 min) to monitor and optimize the entire sales funnel:
 * 1. Health Monitor — site up, products live, images working, social queue depth
 * 2. Metrics Collector — gathers numbers from Shopify, Facebook, DB
 * 3. Decision Engine — rule-based evaluation with cooldowns
 * 4. Action Executor — triggers content generation, alerts, discounts, emails
 * 5. Daily Report — summarizes pipeline status and actions taken
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const Database = require('better-sqlite3');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const DB_PATH = path.join(APP_ROOT, 'data', 'store.db');
const STORE_URL = process.env.STORE_BASE_URL || 'https://blueridgecustomco.com';
const STORE_DOMAIN = process.env.STORE_DOMAIN || 'blueridgecustomco.com';
const LOG_PREFIX = '[Pipeline Monitor]';

// ============================================================================
// STATE
// ============================================================================

let _db = null;
let _intervalId = null;
let _cycleNumber = 0;
let _config = {
  intervalMinutes: 15,
  enableAlerts: true,
  enableActions: true,
  alertPhone: process.env.ALERT_PHONE || '',
  thresholds: {
    minProductCount: 400,
    minSocialQueueDays: 7,       // alert if < 7 days of posts
    postsPerDay: 2,              // expected FB posts per day
    maxFailedPosts: 2,           // alert if > 2 failed in 24h
    noEngagementDays: 2,         // alert if 0 engagement after 2 days
    minSocialQueuePosts: 14,     // auto-generate if below
    noOrdersDaysFlash: 7,        // days before creating flash discount
    cartAbandonMinutes: 60,      // minutes before cart is abandoned
    lowAovCents: 6000,           // $60 entry price point
    highAbandonmentPct: 50,
    deadProductDays: 30,
  },
  cooldowns: {
    social_queue_low: 24 * 60 * 60 * 1000,       // 24h
    social_failures: 60 * 60 * 1000,              // 1h
    no_engagement: 7 * 24 * 60 * 60 * 1000,       // 7d
    broken_images: 60 * 60 * 1000,                // 1h
    store_unreachable: 5 * 60 * 1000,             // 5m
    first_order: Infinity,                         // once ever
    no_orders_flash: 3 * 24 * 60 * 60 * 1000,     // 3d
    cart_abandoned: 0,                             // per-cart
    new_customer: 0,                               // per-customer
    low_aov: 7 * 24 * 60 * 60 * 1000,             // 7d
    high_abandonment: 3 * 24 * 60 * 60 * 1000,    // 3d
    category_performing: 7 * 24 * 60 * 60 * 1000,  // 7d
    dead_products: 14 * 24 * 60 * 60 * 1000,       // 14d
    content_refresh: 7 * 24 * 60 * 60 * 1000,      // 7d
  }
};

let _lastDailyReport = null;
let _lastRuleTriggers = {};   // { ruleName: timestamp }
let _daemonStartedAt = null;
let _lastCycleAt = null;
let _lastCycleResults = null;

// ============================================================================
// DATABASE SETUP
// ============================================================================

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_monitor_log (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      cycle_number INTEGER,
      category TEXT NOT NULL,
      subcategory TEXT,
      severity TEXT DEFAULT 'info',
      message TEXT NOT NULL,
      data_json TEXT,
      action_taken TEXT,
      outcome TEXT
    );

    CREATE TABLE IF NOT EXISTS pipeline_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      metric_name TEXT NOT NULL,
      metric_value REAL,
      dimensions_json TEXT
    );

    CREATE TABLE IF NOT EXISTS pipeline_actions (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      trigger_reason TEXT NOT NULL,
      action_type TEXT NOT NULL,
      action_details_json TEXT,
      status TEXT DEFAULT 'pending',
      result_json TEXT,
      evaluated_at TEXT
    );
  `);

  // Create index if not exists
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_metrics_name_ts ON pipeline_metrics(metric_name, timestamp);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_monitor_log_ts ON pipeline_monitor_log(timestamp);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_monitor_log_cat ON pipeline_monitor_log(category);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_actions_status ON pipeline_actions(status);`);
  } catch (e) {
    // indexes may already exist
  }
}

// ============================================================================
// LOGGING HELPERS
// ============================================================================

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

function now() {
  return new Date().toISOString();
}

function logEntry(category, subcategory, severity, message, data, actionTaken) {
  if (!_db) return;
  try {
    _db.prepare(`
      INSERT INTO pipeline_monitor_log (id, timestamp, cycle_number, category, subcategory, severity, message, data_json, action_taken)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(uid(), now(), _cycleNumber, category, subcategory, severity, message,
      data ? JSON.stringify(data) : null, actionTaken || null);
  } catch (e) {
    console.error(LOG_PREFIX, 'Failed to log:', e.message);
  }
}

function recordMetric(name, value, dimensions) {
  if (!_db) return;
  try {
    _db.prepare(`
      INSERT INTO pipeline_metrics (timestamp, metric_name, metric_value, dimensions_json)
      VALUES (?, ?, ?, ?)
    `).run(now(), name, value, dimensions ? JSON.stringify(dimensions) : null);
  } catch (e) {
    console.error(LOG_PREFIX, 'Failed to record metric:', e.message);
  }
}

function recordAction(triggerReason, actionType, details) {
  if (!_db) return;
  const id = uid();
  try {
    _db.prepare(`
      INSERT INTO pipeline_actions (id, timestamp, trigger_reason, action_type, action_details_json, status)
      VALUES (?, ?, ?, ?, ?, 'pending')
    `).run(id, now(), triggerReason, actionType, details ? JSON.stringify(details) : null);
  } catch (e) {
    console.error(LOG_PREFIX, 'Failed to record action:', e.message);
  }
  return id;
}

function updateAction(id, status, result) {
  if (!_db) return;
  try {
    _db.prepare(`
      UPDATE pipeline_actions SET status = ?, result_json = ?, evaluated_at = ? WHERE id = ?
    `).run(status, result ? JSON.stringify(result) : null, now(), id);
  } catch (e) {
    // ignore
  }
}

// ============================================================================
// HTTP HELPERS
// ============================================================================

function httpGet(urlStr, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const proto = urlStr.startsWith('https') ? https : http;
    const req = proto.get(urlStr, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function httpHead(urlStr, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const proto = urlStr.startsWith('https') ? https : http;
    const u = new URL(urlStr);
    const req = proto.request({ method: 'HEAD', hostname: u.hostname, port: u.port, path: u.pathname + u.search, timeout: timeoutMs }, (res) => {
      resolve({ statusCode: res.statusCode, headers: res.headers });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ============================================================================
// 1. HEALTH MONITOR
// ============================================================================

async function runHealthChecks() {
  const results = { checks: [], allHealthy: true };

  // 1a. Store reachable
  try {
    const resp = await httpGet(`https://${STORE_DOMAIN}`, 15000);
    const ok = resp.statusCode >= 200 && resp.statusCode < 400;  // includes 301/302 redirects
    results.checks.push({ name: 'store_reachable', ok, statusCode: resp.statusCode });
    if (!ok) {
      results.allHealthy = false;
      logEntry('health', 'site_check', 'critical', `Store returned HTTP ${resp.statusCode}`, { statusCode: resp.statusCode });
    } else {
      logEntry('health', 'site_check', 'info', `Store UP (${resp.statusCode})`);
    }
  } catch (e) {
    results.allHealthy = false;
    results.checks.push({ name: 'store_reachable', ok: false, error: e.message });
    logEntry('health', 'site_check', 'critical', `Store unreachable: ${e.message}`, { error: e.message });
  }

  // 1b. Product count via Shopify API
  try {
    const shopify = require('../integrations/shopify');
    if (shopify.isConfigured()) {
      const { products } = await shopify.listProducts({ limit: 1 });
      // Use count endpoint for accurate number
      const countUrl = shopify.adminUrl('/products/count.json');
      const countResp = await shopify.httpJson('GET', countUrl);
      const count = countResp?.count || products.length;
      recordMetric('shopify_product_count', count);
      const ok = count >= _config.thresholds.minProductCount;
      results.checks.push({ name: 'product_count', ok, count });
      if (!ok) {
        results.allHealthy = false;
        logEntry('health', 'product_count', 'warning', `Product count ${count} below threshold ${_config.thresholds.minProductCount}`, { count });
      } else {
        logEntry('health', 'product_count', 'info', `Products: ${count}`);
      }
    } else {
      results.checks.push({ name: 'product_count', ok: false, error: 'Shopify not configured' });
    }
  } catch (e) {
    results.checks.push({ name: 'product_count', ok: false, error: e.message });
    logEntry('health', 'product_count', 'warning', `Product count check failed: ${e.message}`);
  }

  // 1c. Social post queue depth
  try {
    const pending = _db.prepare(`
      SELECT COUNT(*) as cnt FROM scheduled_facebook_posts WHERE status = 'pending'
    `).get();
    const pendingCount = pending?.cnt || 0;
    const daysOfContent = pendingCount / Math.max(1, _config.thresholds.postsPerDay);
    recordMetric('social_queue_pending', pendingCount);
    recordMetric('social_queue_days', daysOfContent);

    const ok = daysOfContent >= _config.thresholds.minSocialQueueDays;
    results.checks.push({ name: 'social_queue', ok, pending: pendingCount, daysOfContent: Math.round(daysOfContent * 10) / 10 });
    if (!ok) {
      results.allHealthy = false;
      logEntry('health', 'social_queue', 'warning',
        `Social queue low: ${pendingCount} posts (${daysOfContent.toFixed(1)} days)`,
        { pending: pendingCount, days: daysOfContent });
    } else {
      logEntry('health', 'social_queue', 'info', `Social queue: ${pendingCount} posts (${daysOfContent.toFixed(1)} days)`);
    }
  } catch (e) {
    results.checks.push({ name: 'social_queue', ok: false, error: e.message });
  }

  // 1d. Social post failures
  try {
    const failed = _db.prepare(`
      SELECT COUNT(*) as cnt FROM scheduled_facebook_posts
      WHERE status = 'failed' AND retry_count < 3
        AND updated_at > datetime('now', '-24 hours')
    `).get();
    const failedCount = failed?.cnt || 0;
    recordMetric('social_post_failures_24h', failedCount);

    const ok = failedCount <= _config.thresholds.maxFailedPosts;
    results.checks.push({ name: 'social_failures', ok, failedCount });
    if (!ok) {
      results.allHealthy = false;
      logEntry('health', 'social_failures', 'warning',
        `${failedCount} failed social posts in last 24h`,
        { failedCount });
    }
  } catch (e) {
    results.checks.push({ name: 'social_failures', ok: false, error: e.message });
  }

  // 1e. Image CDN spot check (3 random product images)
  try {
    const shopify = require('../integrations/shopify');
    if (shopify.isConfigured()) {
      const { products } = await shopify.listProducts({ limit: 10 });
      const imagesChecked = [];
      const productsWithImages = products.filter(p => p.images && p.images.length > 0);
      const sample = productsWithImages.sort(() => Math.random() - 0.5).slice(0, 3);

      for (const product of sample) {
        const imgUrl = product.images[0]?.src;
        if (!imgUrl) continue;
        try {
          const headResp = await httpHead(imgUrl);
          const ok = headResp.statusCode >= 200 && headResp.statusCode < 400;
          imagesChecked.push({ product: product.title, url: imgUrl, ok, status: headResp.statusCode });
          if (!ok) {
            logEntry('health', 'image_cdn', 'warning', `Broken image for "${product.title}": HTTP ${headResp.statusCode}`, { product: product.title, url: imgUrl });
          }
        } catch (imgErr) {
          imagesChecked.push({ product: product.title, url: imgUrl, ok: false, error: imgErr.message });
        }
      }

      const brokenCount = imagesChecked.filter(i => !i.ok).length;
      const allOk = brokenCount === 0;
      results.checks.push({ name: 'image_cdn', ok: allOk, checked: imagesChecked.length, broken: brokenCount });
      if (!allOk) {
        results.allHealthy = false;
        logEntry('health', 'image_cdn', 'warning', `${brokenCount}/${imagesChecked.length} images broken`, { images: imagesChecked });
      }
    }
  } catch (e) {
    results.checks.push({ name: 'image_cdn', ok: false, error: e.message });
  }

  // 1f. Published vs failed post counts
  try {
    const published = _db.prepare(`
      SELECT COUNT(*) as cnt FROM scheduled_facebook_posts WHERE status = 'published'
    `).get();
    const publishedToday = _db.prepare(`
      SELECT COUNT(*) as cnt FROM scheduled_facebook_posts
      WHERE status = 'published' AND published_at > datetime('now', '-24 hours')
    `).get();
    recordMetric('social_posts_published_total', published?.cnt || 0);
    recordMetric('social_posts_published_today', publishedToday?.cnt || 0);
    results.checks.push({ name: 'social_published', ok: true, total: published?.cnt || 0, today: publishedToday?.cnt || 0 });
  } catch (e) {
    // non-critical
  }

  return results;
}

// ============================================================================
// 2. METRICS COLLECTOR
// ============================================================================

async function collectMetrics() {
  const metrics = {};

  // 2a. Social post breakdown
  try {
    const statusCounts = _db.prepare(`
      SELECT status, COUNT(*) as cnt FROM scheduled_facebook_posts GROUP BY status
    `).all();
    for (const row of statusCounts) {
      recordMetric(`social_posts_${row.status}`, row.cnt);
      metrics[`social_posts_${row.status}`] = row.cnt;
    }
  } catch (e) {
    // ignore
  }

  // 2b. Facebook engagement for recently published posts
  try {
    const recentPublished = _db.prepare(`
      SELECT facebook_post_id, product_name, published_at
      FROM scheduled_facebook_posts
      WHERE status = 'published'
        AND facebook_post_id IS NOT NULL
        AND published_at > datetime('now', '-7 days')
      ORDER BY published_at DESC
      LIMIT 20
    `).all();

    if (recentPublished.length > 0) {
      const fbScheduler = require('../facebook-post-scheduler');
      if (fbScheduler.getBulkPostInsights) {
        const postIds = recentPublished.map(p => p.facebook_post_id).filter(Boolean);
        if (postIds.length > 0) {
          const insights = await fbScheduler.getBulkPostInsights(postIds);
          let totalLikes = 0, totalComments = 0, totalShares = 0, totalImpressions = 0;

          for (const insight of insights) {
            if (insight.success) {
              totalLikes += insight.likes || 0;
              totalComments += insight.comments || 0;
              totalShares += insight.shares || 0;
              totalImpressions += insight.impressions || 0;
            }
          }

          recordMetric('fb_total_likes_7d', totalLikes);
          recordMetric('fb_total_comments_7d', totalComments);
          recordMetric('fb_total_shares_7d', totalShares);
          recordMetric('fb_total_impressions_7d', totalImpressions);
          recordMetric('fb_posts_with_insights', insights.filter(i => i.success).length);

          metrics.fb_engagement = { likes: totalLikes, comments: totalComments, shares: totalShares, impressions: totalImpressions };

          logEntry('metric', 'fb_engagement', 'info',
            `FB 7d: ${totalLikes} likes, ${totalComments} comments, ${totalShares} shares, ${totalImpressions} impressions`,
            { likes: totalLikes, comments: totalComments, shares: totalShares, impressions: totalImpressions, postsAnalyzed: insights.length });
        }
      }
    }
  } catch (e) {
    logEntry('metric', 'fb_engagement', 'warning', `Failed to collect FB insights: ${e.message}`);
  }

  // 2c. Shopify order count (if scope allows)
  try {
    const shopify = require('../integrations/shopify');
    if (shopify.isConfigured() && shopify.getAllOrders) {
      const countUrl = shopify.adminUrl('/orders/count.json?status=any');
      const countResp = await shopify.httpJson('GET', countUrl);
      if (countResp?.count !== undefined) {
        recordMetric('shopify_order_count', countResp.count);
        metrics.shopify_order_count = countResp.count;
        logEntry('metric', 'orders', 'info', `Shopify orders: ${countResp.count}`);
      }
    }
  } catch (e) {
    // Likely read_orders scope missing — this is expected initially
    if (e.message && (e.message.includes('403') || e.message.includes('scope') || e.message.includes('access'))) {
      logEntry('metric', 'orders', 'info', 'Order tracking unavailable (read_orders scope needed)');
      metrics.orders_scope_missing = true;
    } else {
      logEntry('metric', 'orders', 'warning', `Order check failed: ${e.message}`);
    }
  }

  // 2d. Content queue by campaign/category
  try {
    const byCampaign = _db.prepare(`
      SELECT campaign_slug, status, COUNT(*) as cnt
      FROM scheduled_facebook_posts
      GROUP BY campaign_slug, status
    `).all();
    metrics.content_by_campaign = byCampaign;
  } catch (e) {
    // ignore
  }

  return metrics;
}

// ============================================================================
// 3. DECISION ENGINE
// ============================================================================

function canTriggerRule(ruleName) {
  const cooldown = _config.cooldowns[ruleName];
  if (cooldown === undefined) return true;
  if (cooldown === 0) return true;
  const lastTriggered = _lastRuleTriggers[ruleName] || 0;
  return (Date.now() - lastTriggered) >= cooldown;
}

function markRuleTriggered(ruleName) {
  _lastRuleTriggers[ruleName] = Date.now();
}

async function evaluateRules(healthResults, metrics) {
  const actions = [];

  // ---- Phase 1 Rules (work immediately) ----

  // Rule: Social queue low → generate content
  if (canTriggerRule('social_queue_low')) {
    const queueCheck = healthResults.checks.find(c => c.name === 'social_queue');
    if (queueCheck && !queueCheck.ok) {
      markRuleTriggered('social_queue_low');
      actions.push({
        trigger: 'low_social_queue',
        type: 'generate_social_content',
        details: { pending: queueCheck.pending, daysLeft: queueCheck.daysOfContent },
        message: `Social queue low (${queueCheck.pending} posts, ${queueCheck.daysOfContent} days). Generating content.`
      });
    }
  }

  // Rule: Social failures accumulating → auto-reset
  if (canTriggerRule('social_failures')) {
    const failCheck = healthResults.checks.find(c => c.name === 'social_failures');
    if (failCheck && !failCheck.ok) {
      markRuleTriggered('social_failures');
      actions.push({
        trigger: 'social_failures_accumulating',
        type: 'reset_failed_posts',
        details: { failedCount: failCheck.failedCount },
        message: `${failCheck.failedCount} failed posts detected. Resetting for retry.`
      });
    }
  }

  // Rule: No FB engagement after 48h → log alert
  if (canTriggerRule('no_engagement') && metrics.fb_engagement) {
    const totalEngagement = (metrics.fb_engagement.likes || 0) +
      (metrics.fb_engagement.comments || 0) +
      (metrics.fb_engagement.shares || 0);
    if (totalEngagement === 0) {
      // Check if we have any posts older than 48h
      try {
        const oldPosts = _db.prepare(`
          SELECT COUNT(*) as cnt FROM scheduled_facebook_posts
          WHERE status = 'published'
            AND published_at < datetime('now', '-48 hours')
            AND published_at > datetime('now', '-7 days')
        `).get();
        if (oldPosts?.cnt > 0) {
          markRuleTriggered('no_engagement');
          actions.push({
            trigger: 'no_fb_engagement',
            type: 'send_alert',
            details: { publishedPosts: oldPosts.cnt, engagement: 0 },
            message: `0 engagement on ${oldPosts.cnt} published posts (48h+). Consider refreshing content style.`
          });
        }
      } catch (e) {
        // ignore
      }
    }
  }

  // Rule: Store unreachable → immediate alert
  if (canTriggerRule('store_unreachable')) {
    const storeCheck = healthResults.checks.find(c => c.name === 'store_reachable');
    if (storeCheck && !storeCheck.ok) {
      markRuleTriggered('store_unreachable');
      actions.push({
        trigger: 'store_unreachable',
        type: 'send_alert',
        severity: 'critical',
        details: { error: storeCheck.error || `HTTP ${storeCheck.statusCode}` },
        message: `CRITICAL: Store is unreachable! ${storeCheck.error || 'HTTP ' + storeCheck.statusCode}`
      });
    }
  }


  // Rule: Approved trend designs → fast-track to Shopify + social (no cooldown, trends are urgent)
  {
    try {
      const trendMonitor = require('./trend-monitor');
      const trendData = trendMonitor.loadData();
      const pendingDesigns = (trendData.designs || []).filter(d => d.status === 'approved' && !d.shopifyProductId);
      if (pendingDesigns.length > 0) {
        actions.push({
          trigger: 'trend_designs_pending',
          type: 'process_trend_designs',
          details: { count: pendingDesigns.length, designs: pendingDesigns.map(d => d.phrase).slice(0, 5) },
          message: `${pendingDesigns.length} approved trend designs ready to fast-track to Shopify + social`
        });
      }
    } catch (e) {
      // trend-monitor not available, skip
    }
  }

  // ---- Phase 2 Rules (after read_orders scope) ----

  if (metrics.shopify_order_count !== undefined && !metrics.orders_scope_missing) {
    const orderCount = metrics.shopify_order_count;

    // Rule: First order celebration!
    if (canTriggerRule('first_order') && orderCount > 0) {
      markRuleTriggered('first_order');
      actions.push({
        trigger: 'first_order',
        type: 'send_alert',
        severity: 'info',
        details: { orderCount },
        message: `MILESTONE: First order received! Total orders: ${orderCount}`
      });
    }

    // Rule: No orders after 7 days → flash discount
    if (canTriggerRule('no_orders_flash') && orderCount === 0 && _daemonStartedAt) {
      const daysSinceStart = (Date.now() - _daemonStartedAt) / (24 * 60 * 60 * 1000);
      if (daysSinceStart >= _config.thresholds.noOrdersDaysFlash) {
        markRuleTriggered('no_orders_flash');
        actions.push({
          trigger: 'no_orders_after_7d',
          type: 'create_discount',
          details: { daysSinceStart: Math.round(daysSinceStart), orderCount },
          message: `No orders after ${Math.round(daysSinceStart)} days. Creating 10% flash discount.`
        });
      }
    }
  }

  return actions;
}

// ============================================================================
// 4. ACTION EXECUTOR
// ============================================================================

async function executeActions(actions) {
  const results = [];

  for (const action of actions) {
    const actionId = recordAction(action.trigger, action.type, action.details);
    console.log(`${LOG_PREFIX} ACTION: ${action.message}`);
    logEntry('action', action.type, action.severity || 'info', action.message, action.details, action.type);

    try {
      let result;
      switch (action.type) {

        case 'generate_social_content':
          result = await executeGenerateSocialContent(action.details);
          break;

        case 'reset_failed_posts':
          result = executeResetFailedPosts();
          break;

        case 'send_alert':
          result = await executeSendAlert(action);
          break;

        case 'create_discount':
          result = await executeCreateDiscount(action.details);
          break;

        case 'collect_fb_insights':
          result = await executeCollectFbInsights();
          break;

        case 'enqueue_email':
          result = await executeEnqueueEmail(action.details);
          break;


        case 'process_trend_designs':
          result = await processTrendDesigns();
          break;

        case 'process_carts':
          result = executeProcessCarts();
          break;

        default:
          result = { skipped: true, reason: `Unknown action type: ${action.type}` };
      }

      updateAction(actionId, result?.skipped ? 'skipped' : 'executed', result);
      results.push({ action: action.type, success: true, result });

    } catch (e) {
      console.error(`${LOG_PREFIX} Action failed (${action.type}):`, e.message);
      updateAction(actionId, 'failed', { error: e.message });
      results.push({ action: action.type, success: false, error: e.message });
    }
  }

  return results;
}

// --- Action implementations ---

async function executeGenerateSocialContent(details) {
  // Try to find a category with the fewest pending posts to diversify
  let targetCategory = null;
  try {
    const campaigns = _db.prepare(`
      SELECT campaign_slug, COUNT(*) as cnt
      FROM scheduled_facebook_posts
      WHERE status = 'pending'
      GROUP BY campaign_slug
      ORDER BY cnt ASC
      LIMIT 1
    `).get();
    targetCategory = campaigns?.campaign_slug || null;
  } catch (e) {
    // fallback
  }

  // Attempt to call the social content generator script
  const scriptPath = path.join(APP_ROOT, 'scripts', 'social-content-generator.js');
  const args = ['--schedule', '--posts-per-day', '2'];
  if (targetCategory) {
    args.push('--category', targetCategory);
  }

  return new Promise((resolve) => {
    try {
      const child = execFile('node', [scriptPath, ...args], {
        cwd: APP_ROOT,
        timeout: 120000,
        env: { ...process.env }
      }, (error, stdout, stderr) => {
        if (error) {
          // Check if it's an API credits issue
          if (stderr && (stderr.includes('credit') || stderr.includes('rate') || stderr.includes('quota'))) {
            resolve({ executed: false, reason: 'AI credits exhausted or rate limited', stderr: stderr.slice(0, 200) });
          } else {
            resolve({ executed: false, error: error.message, stderr: stderr?.slice(0, 200) });
          }
        } else {
          resolve({ executed: true, category: targetCategory, stdout: stdout?.slice(0, 500) });
        }
      });
    } catch (e) {
      resolve({ executed: false, error: e.message, reason: 'Failed to spawn content generator' });
    }
  });
}

function executeResetFailedPosts() {
  try {
    const result = _db.prepare(`
      UPDATE scheduled_facebook_posts
      SET status = 'pending', retry_count = 0, error_message = NULL, updated_at = datetime('now')
      WHERE status = 'failed' AND retry_count < 3
    `).run();
    const resetCount = result.changes;
    console.log(`${LOG_PREFIX} Reset ${resetCount} failed posts for retry`);
    return { resetCount };
  } catch (e) {
    return { error: e.message };
  }
}

async function executeSendAlert(action) {
  const message = `[Pipeline Monitor] ${action.severity === 'critical' ? 'CRITICAL: ' : ''}${action.message}`;
  console.log(`${LOG_PREFIX} ALERT: ${message}`);

  // Try SMS if configured
  if (_config.enableAlerts && _config.alertPhone) {
    try {
      const sms = require('../sms');
      if (sms.isConfigured()) {
        await sms.sendSms({ to: _config.alertPhone, body: message });
        return { sent: true, channel: 'sms' };
      }
    } catch (e) {
      // SMS not available, just log
    }
  }

  return { sent: true, channel: 'console_only' };
}

async function executeCreateDiscount(details) {
  try {
    const shopify = require('../integrations/shopify');
    if (!shopify.isConfigured() || !shopify.createPercentageDiscount) {
      return { skipped: true, reason: 'Shopify discount functions not available' };
    }

    const code = `FLASH${Date.now().toString(36).toUpperCase()}`;
    const result = await shopify.createPercentageDiscount({
      code,
      percentage: -10,
      title: 'Flash Sale - 10% Off',
      startsAt: new Date().toISOString(),
      endsAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
    });

    logEntry('action', 'create_discount', 'info',
      `Created flash discount: ${code} (10% off, 48h)`,
      { code, result });

    return { created: true, code, expiresIn: '48h' };
  } catch (e) {
    return { created: false, error: e.message };
  }
}

async function executeCollectFbInsights() {
  try {
    const recentPublished = _db.prepare(`
      SELECT facebook_post_id, product_name
      FROM scheduled_facebook_posts
      WHERE status = 'published'
        AND facebook_post_id IS NOT NULL
        AND published_at > datetime('now', '-7 days')
      ORDER BY published_at DESC
      LIMIT 20
    `).all();

    if (recentPublished.length === 0) {
      return { collected: 0, reason: 'No recent published posts' };
    }

    const fbScheduler = require('../facebook-post-scheduler');
    const postIds = recentPublished.map(p => p.facebook_post_id).filter(Boolean);
    const insights = await fbScheduler.getBulkPostInsights(postIds);

    let collected = 0;
    for (const insight of insights) {
      if (insight.success) {
        recordMetric('fb_post_likes', insight.likes, { postId: insight.postId });
        recordMetric('fb_post_comments', insight.comments, { postId: insight.postId });
        recordMetric('fb_post_shares', insight.shares, { postId: insight.postId });
        recordMetric('fb_post_impressions', insight.impressions, { postId: insight.postId });
        collected++;
      }
    }

    return { collected, total: postIds.length };
  } catch (e) {
    return { collected: 0, error: e.message };
  }
}

async function executeEnqueueEmail(details) {
  try {
    const emailSequences = require('./email-sequences');
    if (details.sequenceType && details.customer) {
      emailSequences.enqueueSequence(details.sequenceType, details.customer, details.context || {});
      return { enqueued: true, sequence: details.sequenceType };
    }
    return { skipped: true, reason: 'Missing sequence type or customer' };
  } catch (e) {
    return { error: e.message };
  }
}

function executeProcessCarts() {
  try {
    const cartRecovery = require('./cart-recovery');
    const pending = cartRecovery.processAbandonedCarts();
    return { processed: pending.length };
  } catch (e) {
    return { error: e.message };
  }
}


// ============================================================================
// TREND DESIGN FAST-TRACK
// ============================================================================

async function processTrendDesigns() {
  const results = { processed: 0, listed: 0, mockupsGenerated: 0, postsScheduled: 0, errors: [] };

  try {
    const trendMonitor = require('./trend-monitor');
    const data = trendMonitor.loadData();
    const designs = (data.designs || []).filter(d => d.status === 'approved' && !d.shopifyProductId);

    if (designs.length === 0) {
      return { processed: 0, reason: 'No approved designs pending' };
    }

    console.log(`${LOG_PREFIX} Processing ${designs.length} approved trend designs...`);
    const { generateMockupToFile } = require('../lib/mockup-compositor');
    const shopify = require('../integrations/shopify');

    // Load t-shirt mockup template from DB
    const template = _db.prepare(
      "SELECT * FROM mockup_templates WHERE id = 'mockup-tpl-tshirt-white-front' AND is_active = 1"
    ).get();

    if (!template) {
      return { processed: 0, error: 'No t-shirt mockup template found in DB' };
    }

    const templateConfig = {
      mockupImagePath: template.mockup_image_path,
      artworkPosition: JSON.parse(template.artwork_position_json),
      blendMode: template.blend_mode || 'normal',
      outputFormat: template.output_format || 'jpeg',
      outputQuality: template.output_quality || 92
    };

    for (const design of designs) {
      try {
        console.log(`${LOG_PREFIX} Fast-tracking: "${(design.phrase || '').slice(0, 50)}"`);

        // Step 1: Generate t-shirt mockup
        const artworkPath = path.join(APP_ROOT, 'web', design.imagePath);
        if (!fs.existsSync(artworkPath)) {
          results.errors.push({ design: design.id, error: 'Artwork not found: ' + design.imagePath });
          continue;
        }

        const mockupFilename = `trend-${design.id}-mockup-${Date.now()}.jpg`;
        const mockupDir = path.join(APP_ROOT, 'data', 'generated-mockups');
        fs.mkdirSync(mockupDir, { recursive: true });
        const mockupOutputPath = path.join(mockupDir, mockupFilename);

        const mockupResult = await generateMockupToFile(templateConfig, artworkPath, mockupOutputPath);
        results.mockupsGenerated++;
        console.log(`${LOG_PREFIX} Mockup generated: ${mockupFilename} (${mockupResult.size} bytes)`);

        // Step 2: List to Shopify via trend monitor's function
        const trend = (data.trends || []).find(t => t.id === design.trendId) || {
          title: design.phrase, aiAnalysis: { targetAudience: 'all', humorStyle: 'witty' }
        };
        const settings = data.settings || {};

        let shopifyResult;
        try {
          shopifyResult = await trendMonitor.listDesignToShopify(design, trend, settings);
          results.listed++;
          console.log(`${LOG_PREFIX} Listed to Shopify: product ${shopifyResult.shopifyProductId}`);
        } catch (shopErr) {
          results.errors.push({ design: design.id, error: 'Shopify listing failed: ' + shopErr.message });
          continue;
        }

        // Step 3: Upload mockup as additional product image
        if (shopifyResult.shopifyProductId && fs.existsSync(mockupOutputPath)) {
          try {
            const mockupBase64 = fs.readFileSync(mockupOutputPath).toString('base64');
            await shopify.addProductImage(shopifyResult.shopifyProductId, {
              attachment: mockupBase64,
              filename: mockupFilename,
              alt: `${design.phrase || 'Trending design'} - T-Shirt Mockup`
            });
            console.log(`${LOG_PREFIX} Mockup image uploaded to Shopify product`);
          } catch (imgErr) {
            console.error(`${LOG_PREFIX} Failed to upload mockup image:`, imgErr.message);
          }
        }

        // Step 4: Schedule Facebook post ASAP
        try {
          const postId = crypto.randomBytes(8).toString('hex');
          const collectionUrl = shopifyResult.shopifyProductUrl || 'https://blueridgecustomco.com';
          const mockupRelPath = '/data/generated-mockups/' + mockupFilename;

          _db.prepare(`
            INSERT INTO scheduled_facebook_posts
            (id, campaign_slug, product_uid, product_name, campaign_type,
             artwork_path, mockup_path, post_text, post_hashtags,
             collection_url, scheduled_for, status, generate_ai_on_post, ai_style)
            VALUES (?, 'trending-designs', ?, ?, 'apparel', ?, ?, '', '', ?, datetime('now'), 'pending', 1, 'urgency')
          `).run(
            postId,
            design.id,
            design.phrase || 'Trending Design',
            design.imagePath,
            mockupRelPath,
            collectionUrl
          );
          results.postsScheduled++;
          console.log(`${LOG_PREFIX} Facebook post scheduled: ${postId} (next FB cycle picks it up)`);
        } catch (postErr) {
          console.error(`${LOG_PREFIX} Failed to schedule FB post:`, postErr.message);
        }

        // Step 5: Mark design as listed in trend monitor data
        design.status = 'listed';
        design.listedAt = new Date().toISOString();
        design.shopifyProductId = shopifyResult.shopifyProductId;
        design.shopifyProductUrl = shopifyResult.shopifyProductUrl;
        design.mockupPath = mockupOutputPath;
        data.stats.totalListed = (data.stats.totalListed || 0) + 1;

        results.processed++;

        logEntry('action', 'trend_design_listed', 'info',
          `Trend design fast-tracked: "${(design.phrase || '').slice(0, 50)}"`,
          { designId: design.id, shopifyProductId: shopifyResult.shopifyProductId, mockup: mockupFilename });

        // Rate limit between Shopify API calls
        await new Promise(r => setTimeout(r, 1500));

      } catch (designErr) {
        results.errors.push({ design: design.id, error: designErr.message });
        console.error(`${LOG_PREFIX} Error processing design ${design.id}:`, designErr.message);
      }
    }

    // Save updated trend data
    trendMonitor.saveData(data);

    console.log(`${LOG_PREFIX} Trend processing complete: ${results.processed} processed, ${results.listed} listed, ${results.mockupsGenerated} mockups, ${results.postsScheduled} posts`);

  } catch (e) {
    results.errors.push({ error: e.message });
    console.error(`${LOG_PREFIX} processTrendDesigns error:`, e.message);
  }

  return results;
}

// ============================================================================
// 5. DAILY REPORT GENERATOR
// ============================================================================

function generateDailyReport() {
  const today = new Date().toISOString().split('T')[0];
  const report = { date: today, sections: {} };

  // Health summary
  try {
    const recentHealth = _db.prepare(`
      SELECT subcategory, severity, message
      FROM pipeline_monitor_log
      WHERE category = 'health' AND timestamp > datetime('now', '-24 hours')
      ORDER BY timestamp DESC
    `).all();

    const criticals = recentHealth.filter(h => h.severity === 'critical');
    const warnings = recentHealth.filter(h => h.severity === 'warning');

    report.sections.health = {
      status: criticals.length > 0 ? 'CRITICAL' : warnings.length > 0 ? 'DEGRADED' : 'ALL SYSTEMS OPERATIONAL',
      criticals: criticals.length,
      warnings: warnings.length,
      details: recentHealth.slice(0, 10).map(h => h.message)
    };
  } catch (e) {
    report.sections.health = { status: 'UNKNOWN', error: e.message };
  }

  // Metrics summary
  try {
    const latestMetrics = _db.prepare(`
      SELECT metric_name, metric_value, timestamp
      FROM pipeline_metrics
      WHERE timestamp > datetime('now', '-24 hours')
      ORDER BY timestamp DESC
    `).all();

    // Deduplicate: latest value per metric
    const metricMap = {};
    for (const m of latestMetrics) {
      if (!metricMap[m.metric_name]) {
        metricMap[m.metric_name] = { value: m.metric_value, at: m.timestamp };
      }
    }
    report.sections.metrics = metricMap;
  } catch (e) {
    report.sections.metrics = { error: e.message };
  }

  // Social stats
  try {
    const socialStats = {};
    const pendingPosts = _db.prepare(`SELECT COUNT(*) as cnt FROM scheduled_facebook_posts WHERE status = 'pending'`).get();
    const publishedToday = _db.prepare(`SELECT COUNT(*) as cnt FROM scheduled_facebook_posts WHERE status = 'published' AND published_at > datetime('now', '-24 hours')`).get();
    const failedPosts = _db.prepare(`SELECT COUNT(*) as cnt FROM scheduled_facebook_posts WHERE status = 'failed'`).get();
    const publishedTotal = _db.prepare(`SELECT COUNT(*) as cnt FROM scheduled_facebook_posts WHERE status = 'published'`).get();

    socialStats.queuePending = pendingPosts?.cnt || 0;
    socialStats.publishedToday = publishedToday?.cnt || 0;
    socialStats.publishedTotal = publishedTotal?.cnt || 0;
    socialStats.failedTotal = failedPosts?.cnt || 0;
    socialStats.queueDays = (socialStats.queuePending / Math.max(1, _config.thresholds.postsPerDay)).toFixed(1);

    report.sections.social = socialStats;
  } catch (e) {
    report.sections.social = { error: e.message };
  }

  // Actions taken today
  try {
    const todayActions = _db.prepare(`
      SELECT timestamp, action_type, trigger_reason, status, result_json
      FROM pipeline_actions
      WHERE timestamp > datetime('now', '-24 hours')
      ORDER BY timestamp ASC
    `).all();

    report.sections.actions = todayActions.map(a => ({
      time: a.timestamp.split('T')[1]?.slice(0, 5) || a.timestamp,
      type: a.action_type,
      trigger: a.trigger_reason,
      status: a.status,
      result: a.result_json ? JSON.parse(a.result_json) : null
    }));
  } catch (e) {
    report.sections.actions = [];
  }

  // Capabilities / blockers
  report.sections.capabilities = getCapabilities();

  // Recommendations
  report.sections.recommendations = [];
  if (report.sections.capabilities.blockers.includes('read_orders_scope')) {
    report.sections.recommendations.push('Add read_orders scope to Shopify token for full funnel tracking');
  }
  if (report.sections.capabilities.blockers.includes('anthropic_credits')) {
    report.sections.recommendations.push('Add Anthropic API credits for AI content generation');
  }
  report.sections.recommendations.push('Consider Facebook/Instagram ad campaign ($5/day test budget)');

  // Generate formatted text
  report.formatted = formatDailyReport(report);

  // Store in log
  logEntry('report', 'daily', 'info', `Daily report for ${today}`, report);
  _lastDailyReport = report;

  return report;
}

function formatDailyReport(report) {
  const lines = [];
  lines.push(`=== Daily Sales Pipeline Report - ${report.date} ===`);
  lines.push('');

  // Health
  const h = report.sections.health;
  lines.push(`HEALTH: ${h.status}`);
  if (h.details) {
    for (const d of h.details.slice(0, 5)) {
      lines.push(`  - ${d}`);
    }
  }
  lines.push('');

  // Social
  const s = report.sections.social;
  if (s && !s.error) {
    lines.push('SOCIAL:');
    lines.push(`  - Queue: ${s.queuePending} pending (${s.queueDays} days)`);
    lines.push(`  - Published today: ${s.publishedToday} | Total: ${s.publishedTotal}`);
    lines.push(`  - Failed: ${s.failedTotal}`);
  }
  lines.push('');

  // Funnel
  const m = report.sections.metrics;
  lines.push('FUNNEL:');
  if (m.shopify_product_count) {
    lines.push(`  - Products: ${m.shopify_product_count.value}`);
  }
  if (m.shopify_order_count) {
    lines.push(`  - Orders: ${m.shopify_order_count.value}`);
  } else {
    lines.push('  - Orders: [requires read_orders scope]');
  }
  if (m.fb_total_impressions_7d) {
    lines.push(`  - FB impressions (7d): ${m.fb_total_impressions_7d.value}`);
  }
  lines.push('');

  // Actions
  const a = report.sections.actions;
  if (a && a.length > 0) {
    lines.push('ACTIONS TAKEN:');
    for (const act of a) {
      lines.push(`  - ${act.time} - [${act.type}] ${act.trigger} (${act.status})`);
    }
  } else {
    lines.push('ACTIONS TAKEN: None');
  }
  lines.push('');

  // Recommendations
  const r = report.sections.recommendations;
  if (r && r.length > 0) {
    lines.push('RECOMMENDATIONS:');
    for (const rec of r) {
      lines.push(`  - ${rec}`);
    }
  }
  lines.push('');

  // Blockers
  const blockers = report.sections.capabilities?.blockers || [];
  if (blockers.length > 0) {
    lines.push('BLOCKERS:');
    for (const b of blockers) {
      const labels = {
        'read_orders_scope': 'Cannot track orders (missing Shopify read_orders scope)',
        'anthropic_credits': 'Cannot generate AI content (credits exhausted/missing)',
        'pinterest_access': 'Cannot automate Pinterest (standard access needed)',
      };
      lines.push(`  - ${labels[b] || b}`);
    }
  }

  return lines.join('\n');
}

function generateWeeklyReport() {
  const report = { period: '7 days', generated: now() };

  // Metric trends over the week
  try {
    const weekMetrics = _db.prepare(`
      SELECT metric_name,
             MIN(metric_value) as min_val,
             MAX(metric_value) as max_val,
             AVG(metric_value) as avg_val,
             COUNT(*) as samples
      FROM pipeline_metrics
      WHERE timestamp > datetime('now', '-7 days')
      GROUP BY metric_name
    `).all();

    report.metricTrends = weekMetrics;
  } catch (e) {
    report.metricTrends = [];
  }

  // Action summary
  try {
    const weekActions = _db.prepare(`
      SELECT action_type, status, COUNT(*) as cnt
      FROM pipeline_actions
      WHERE timestamp > datetime('now', '-7 days')
      GROUP BY action_type, status
    `).all();

    report.actionSummary = weekActions;
  } catch (e) {
    report.actionSummary = [];
  }

  // Health incident count
  try {
    const incidents = _db.prepare(`
      SELECT severity, COUNT(*) as cnt
      FROM pipeline_monitor_log
      WHERE category = 'health' AND severity IN ('warning', 'critical')
        AND timestamp > datetime('now', '-7 days')
      GROUP BY severity
    `).all();

    report.healthIncidents = incidents;
  } catch (e) {
    report.healthIncidents = [];
  }

  logEntry('report', 'weekly', 'info', 'Weekly pipeline report', report);
  return report;
}

// ============================================================================
// CAPABILITIES CHECK
// ============================================================================

function getCapabilities() {
  const caps = {
    enabled: [],
    disabled: [],
    blockers: []
  };

  // Check Shopify
  try {
    const shopify = require('../integrations/shopify');
    if (shopify.isConfigured()) {
      caps.enabled.push('shopify_products');
      caps.enabled.push('shopify_collections');
      caps.enabled.push('shopify_discounts');
    } else {
      caps.disabled.push('shopify');
      caps.blockers.push('shopify_not_configured');
    }
  } catch (e) {
    caps.disabled.push('shopify');
  }

  // Check orders scope (look at recent metrics)
  try {
    const recentOrderMetric = _db.prepare(`
      SELECT metric_value FROM pipeline_metrics
      WHERE metric_name = 'shopify_order_count'
      ORDER BY timestamp DESC LIMIT 1
    `).get();
    if (recentOrderMetric) {
      caps.enabled.push('shopify_orders');
    } else {
      caps.disabled.push('shopify_orders');
      caps.blockers.push('read_orders_scope');
    }
  } catch (e) {
    caps.disabled.push('shopify_orders');
    caps.blockers.push('read_orders_scope');
  }

  // Check Facebook
  if (process.env.FB_PAGE_ACCESS_TOKEN && process.env.FB_PAGE_ID) {
    caps.enabled.push('facebook_posting');
    caps.enabled.push('facebook_insights');
  } else {
    caps.disabled.push('facebook');
    caps.blockers.push('facebook_not_configured');
  }

  // Check Anthropic
  if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY) {
    caps.enabled.push('ai_content_generation');
  } else {
    caps.disabled.push('ai_content_generation');
    caps.blockers.push('anthropic_credits');
  }

  // Check SMS
  try {
    const sms = require('../sms');
    if (sms.isConfigured()) {
      caps.enabled.push('sms_alerts');
    } else {
      caps.disabled.push('sms_alerts');
    }
  } catch (e) {
    caps.disabled.push('sms_alerts');
  }

  return caps;
}

// ============================================================================
// MAIN CYCLE
// ============================================================================

async function runCycle() {
  _cycleNumber++;
  const cycleStart = Date.now();
  console.log(`${LOG_PREFIX} === Cycle #${_cycleNumber} starting ===`);
  logEntry('health', 'cycle_start', 'info', `Cycle #${_cycleNumber} starting`);

  let healthResults = { checks: [], allHealthy: true };
  let metrics = {};
  let actions = [];
  let actionResults = [];

  try {
    // Step 1: Health checks
    healthResults = await runHealthChecks();

    // Step 2: Collect metrics
    metrics = await collectMetrics();

    // Step 3: Evaluate rules
    if (_config.enableActions) {
      actions = await evaluateRules(healthResults, metrics);
    }

    // Step 4: Execute actions
    if (actions.length > 0) {
      actionResults = await executeActions(actions);
    }

    // Step 5: Daily report (once per day)
    const todayDate = new Date().toISOString().split('T')[0];
    if (!_lastDailyReport || _lastDailyReport.date !== todayDate) {
      // Generate daily report at first cycle of each day
      const hourNow = new Date().getHours();
      // Generate report after 6am to have meaningful data
      if (hourNow >= 6 || !_lastDailyReport) {
        try {
          const report = generateDailyReport();
          console.log(`${LOG_PREFIX} Daily report generated`);
          console.log(report.formatted);
        } catch (e) {
          console.error(`${LOG_PREFIX} Daily report failed:`, e.message);
        }
      }
    }

    // Weekly report on Mondays
    const dayOfWeek = new Date().getDay();
    if (dayOfWeek === 1 && _cycleNumber % 4 === 0) {
      // ~once on Monday (every 4th cycle = ~1h into Monday)
      try {
        generateWeeklyReport();
        console.log(`${LOG_PREFIX} Weekly report generated`);
      } catch (e) {
        // non-critical
      }
    }

  } catch (e) {
    console.error(`${LOG_PREFIX} Cycle error:`, e.message);
    logEntry('health', 'cycle_error', 'critical', `Cycle error: ${e.message}`, { stack: e.stack?.slice(0, 500) });
  }

  const cycleDuration = Date.now() - cycleStart;
  _lastCycleAt = now();
  _lastCycleResults = {
    cycle: _cycleNumber,
    timestamp: _lastCycleAt,
    durationMs: cycleDuration,
    health: healthResults,
    metricsCollected: Object.keys(metrics).length,
    actionsTriggered: actions.length,
    actionResults
  };

  logEntry('health', 'cycle_complete', 'info',
    `Cycle #${_cycleNumber} complete in ${cycleDuration}ms. ${actions.length} actions triggered.`,
    { durationMs: cycleDuration, actions: actions.length });

  console.log(`${LOG_PREFIX} === Cycle #${_cycleNumber} complete (${cycleDuration}ms, ${actions.length} actions) ===`);

  // Clean old data periodically (every 24 cycles = ~6h)
  if (_cycleNumber % 24 === 0) {
    cleanOldData();
  }
}

function cleanOldData() {
  try {
    // Keep 30 days of logs
    _db.prepare(`DELETE FROM pipeline_monitor_log WHERE timestamp < datetime('now', '-30 days')`).run();
    // Keep 90 days of metrics
    _db.prepare(`DELETE FROM pipeline_metrics WHERE timestamp < datetime('now', '-90 days')`).run();
    // Keep 90 days of actions
    _db.prepare(`DELETE FROM pipeline_actions WHERE timestamp < datetime('now', '-90 days')`).run();
    console.log(`${LOG_PREFIX} Cleaned old monitoring data`);
  } catch (e) {
    // non-critical
  }
}

// ============================================================================
// DAEMON
// ============================================================================

function startMonitorDaemon(db, options = {}) {
  if (_intervalId) {
    console.log(`${LOG_PREFIX} Daemon already running, skipping`);
    return { stop: () => {} };
  }

  // Open our own DB connection (the passed db is a wrapper module, not raw better-sqlite3)
  _db = new Database(DB_PATH);
  const interval = (options.intervalMinutes || 15) * 60 * 1000;

  if (options.enableAlerts !== undefined) _config.enableAlerts = options.enableAlerts;
  if (options.alertPhone) _config.alertPhone = options.alertPhone;

  // Ensure tables exist
  ensureTables(_db);

  _daemonStartedAt = Date.now();
  _cycleNumber = 0;

  console.log(`${LOG_PREFIX} Starting daemon (interval: ${options.intervalMinutes || 15}m)`);
  logEntry('health', 'daemon_start', 'info', `Pipeline monitor daemon started (interval: ${options.intervalMinutes || 15}m)`);

  // Run first cycle after a short delay (let other services start)
  setTimeout(() => runCycle(), 10000);

  // Then run on interval
  _intervalId = setInterval(() => runCycle(), interval);

  return {
    stop: () => {
      if (_intervalId) {
        clearInterval(_intervalId);
        _intervalId = null;
        console.log(`${LOG_PREFIX} Daemon stopped`);
        logEntry('health', 'daemon_stop', 'info', 'Pipeline monitor daemon stopped');
      }
    }
  };
}

// ============================================================================
// API ROUTE HANDLER
// ============================================================================

function handlePipelineRoute(req, res, parsedUrl, sendJson, db) {
  const pathname = parsedUrl.pathname;

  // GET /api/pipeline/status — current health status
  if (pathname === '/api/pipeline/status' && req.method === 'GET') {
    sendJson(res, 200, {
      running: !!_intervalId,
      daemonStartedAt: _daemonStartedAt ? new Date(_daemonStartedAt).toISOString() : null,
      lastCycleAt: _lastCycleAt,
      cycleNumber: _cycleNumber,
      lastCycleResults: _lastCycleResults,
      config: {
        intervalMinutes: _config.intervalMinutes,
        enableAlerts: _config.enableAlerts,
        enableActions: _config.enableActions
      }
    });
    return true;
  }

  // GET /api/pipeline/metrics — recent metrics
  if (pathname === '/api/pipeline/metrics' && req.method === 'GET') {
    const name = parsedUrl.searchParams?.get('name') || null;
    const days = parseInt(parsedUrl.searchParams?.get('days') || '7');
    try {
      let rows;
      if (name) {
        rows = _db.prepare(`
          SELECT * FROM pipeline_metrics
          WHERE metric_name = ? AND timestamp > datetime('now', '-' || ? || ' days')
          ORDER BY timestamp DESC LIMIT 500
        `).all(name, days);
      } else {
        rows = _db.prepare(`
          SELECT * FROM pipeline_metrics
          WHERE timestamp > datetime('now', '-' || ? || ' days')
          ORDER BY timestamp DESC LIMIT 500
        `).all(days);
      }
      sendJson(res, 200, { count: rows.length, metrics: rows });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  // GET /api/pipeline/actions — action history
  if (pathname === '/api/pipeline/actions' && req.method === 'GET') {
    const status = parsedUrl.searchParams?.get('status') || null;
    try {
      let rows;
      if (status) {
        rows = _db.prepare(`
          SELECT * FROM pipeline_actions WHERE status = ? ORDER BY timestamp DESC LIMIT 100
        `).all(status);
      } else {
        rows = _db.prepare(`
          SELECT * FROM pipeline_actions ORDER BY timestamp DESC LIMIT 100
        `).all();
      }
      sendJson(res, 200, { count: rows.length, actions: rows });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  // GET /api/pipeline/report/daily
  if (pathname === '/api/pipeline/report/daily' && req.method === 'GET') {
    if (_lastDailyReport) {
      sendJson(res, 200, _lastDailyReport);
    } else {
      // Generate on demand
      try {
        if (!_db) _db = db;
        const report = generateDailyReport();
        sendJson(res, 200, report);
      } catch (e) {
        sendJson(res, 500, { error: e.message });
      }
    }
    return true;
  }

  // GET /api/pipeline/report/weekly
  if (pathname === '/api/pipeline/report/weekly' && req.method === 'GET') {
    try {
      if (!_db) _db = db;
      const report = generateWeeklyReport();
      sendJson(res, 200, report);
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  // GET /api/pipeline/config
  if (pathname === '/api/pipeline/config' && req.method === 'GET') {
    sendJson(res, 200, {
      intervalMinutes: _config.intervalMinutes,
      enableAlerts: _config.enableAlerts,
      enableActions: _config.enableActions,
      thresholds: _config.thresholds,
      cooldowns: Object.fromEntries(
        Object.entries(_config.cooldowns).map(([k, v]) => [k, v === Infinity ? 'once' : `${v / 1000}s`])
      )
    });
    return true;
  }

  // PUT /api/pipeline/config
  if (pathname === '/api/pipeline/config' && req.method === 'PUT') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const updates = JSON.parse(body);
        if (updates.enableAlerts !== undefined) _config.enableAlerts = !!updates.enableAlerts;
        if (updates.enableActions !== undefined) _config.enableActions = !!updates.enableActions;
        if (updates.alertPhone) _config.alertPhone = String(updates.alertPhone);
        if (updates.thresholds) {
          Object.assign(_config.thresholds, updates.thresholds);
        }
        logEntry('action', 'config_update', 'info', 'Pipeline config updated', updates);
        sendJson(res, 200, { success: true, config: _config });
      } catch (e) {
        sendJson(res, 400, { error: e.message });
      }
    });
    return true;
  }

  // POST /api/pipeline/run — trigger immediate cycle
  if (pathname === '/api/pipeline/run' && req.method === 'POST') {
    if (!_db) _db = db;
    ensureTables(_db);
    runCycle().then(() => {
      sendJson(res, 200, { success: true, cycle: _cycleNumber, results: _lastCycleResults });
    }).catch(e => {
      sendJson(res, 500, { error: e.message });
    });
    return true;
  }

  // GET /api/pipeline/capabilities
  if (pathname === '/api/pipeline/capabilities' && req.method === 'GET') {
    if (!_db) _db = db;
    sendJson(res, 200, getCapabilities());
    return true;
  }

  // GET /api/pipeline/log — monitor log
  if (pathname === '/api/pipeline/log' && req.method === 'GET') {
    const category = parsedUrl.searchParams?.get('category') || null;
    const severity = parsedUrl.searchParams?.get('severity') || null;
    const limit = parseInt(parsedUrl.searchParams?.get('limit') || '50');
    try {
      let sql = 'SELECT * FROM pipeline_monitor_log WHERE 1=1';
      const params = [];
      if (category) { sql += ' AND category = ?'; params.push(category); }
      if (severity) { sql += ' AND severity = ?'; params.push(severity); }
      sql += ' ORDER BY timestamp DESC LIMIT ?';
      params.push(limit);
      const rows = _db.prepare(sql).all(...params);
      sendJson(res, 200, { count: rows.length, log: rows });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  return false;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  startMonitorDaemon,
  handlePipelineRoute,
  runCycle,
  getCapabilities,
  generateDailyReport,
  generateWeeklyReport
};
