/**
 * Marketing Team Orchestrator
 *
 * Coordinates the AI Sales Agent, Trend Monitor, and Shopify Analytics
 * into a unified autonomous marketing team. Provides:
 * - Daily standups via Telegram (8 AM Eastern)
 * - Weekly strategy meetings via Telegram (Monday 8 AM Eastern)
 * - Learning journal (tracks decisions, outcomes, lessons)
 * - Budget management ($0 default, adjustable in meetings)
 * - Shopify funnel analysis (visits → carts → purchases)
 * - Dashboard updates for the Electron app
 */

const path = require('path');
const fs = require('fs');
const https = require('https');
const Database = require('better-sqlite3');
const shopifyAnalytics = require('./shopify-analytics');
const ollamaClient = require('../lib/ollama-client');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(APP_ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'marketing-team.json');
const DB_PATH = path.join(DATA_DIR, 'store.db');

const EASTERN_TZ = 'America/New_York';
const STANDUP_HOUR = 8;
const ANALYSIS_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours
const SCHEDULER_INTERVAL_MS = 60 * 1000;          // 60 seconds
const MAX_JOURNAL_ENTRIES = 500;
const MAX_MEETING_LOG = 52;

let _db = null;
let _schedulerTimer = null;
let _analysisTimer = null;
let _lastAnalysisAt = null;

// ============================================================================
// STATE
// ============================================================================

let state = {
  budget: {
    daily: 0,
    weekly: 0,
    monthly: 0,
    spent: { today: 0, thisWeek: 0, thisMonth: 0 }
  },
  lastStandup: null,
  lastWeeklyMeeting: null,
  journal: [],
  meetingLog: [],
  weeklyGoals: [],
  actionItems: [],
  performanceBaseline: null,
  teamMembers: {
    salesAgent: { status: 'active', lastCycle: null },
    trendMonitor: { status: 'active', lastScan: null },
    shopifyAnalytics: { status: 'active', lastPull: null },
    contentCreator: { status: 'active', lastPost: null }
  }
};

// ============================================================================
// STATE PERSISTENCE
// ============================================================================

function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      state = { ...state, ...raw };
      console.log('[MarketingTeam] State loaded from', DATA_FILE);
    } else if (fs.existsSync(DATA_FILE + '.tmp')) {
      // Recover from interrupted atomic write
      const raw = JSON.parse(fs.readFileSync(DATA_FILE + '.tmp', 'utf8'));
      state = { ...state, ...raw };
      fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
      console.log('[MarketingTeam] State recovered from .tmp file');
    } else {
      console.log('[MarketingTeam] No existing state file, using defaults');
    }
  } catch (e) {
    console.error('[MarketingTeam] Error loading state (using defaults):', e.message);
  }
}

function saveState() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error('[MarketingTeam] Error saving state:', e.message);
  }
}

// ============================================================================
// DATABASE TABLES
// ============================================================================

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS marketing_journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      type TEXT NOT NULL,
      category TEXT,
      action TEXT NOT NULL,
      context TEXT,
      outcome TEXT,
      score REAL,
      tags TEXT,
      related_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mj_type ON marketing_journal(type);
    CREATE INDEX IF NOT EXISTS idx_mj_category ON marketing_journal(category);
    CREATE INDEX IF NOT EXISTS idx_mj_timestamp ON marketing_journal(timestamp);

    CREATE TABLE IF NOT EXISTS marketing_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      metric_type TEXT NOT NULL,
      data TEXT NOT NULL,
      UNIQUE(date, metric_type)
    );
    CREATE INDEX IF NOT EXISTS idx_mm_date ON marketing_metrics(date);
    CREATE INDEX IF NOT EXISTS idx_mm_type ON marketing_metrics(metric_type);
  `);
  console.log('[MarketingTeam] DB tables ensured');
}

// ============================================================================
// TIMEZONE HELPERS
// ============================================================================

function getEasternNow() {
  const now = new Date();
  const eastern = new Date(now.toLocaleString('en-US', { timeZone: EASTERN_TZ }));
  return eastern;
}

function getEasternDateStr(date) {
  if (!date) date = new Date();
  return date.toLocaleDateString('en-CA', { timeZone: EASTERN_TZ }); // YYYY-MM-DD
}

function getEasternHour() {
  return getEasternNow().getHours();
}

function getEasternDayOfWeek() {
  return getEasternNow().getDay(); // 0=Sunday, 1=Monday
}

function isWeekday() {
  const d = getEasternDayOfWeek();
  return d >= 1 && d <= 5;
}

function todayEasternStr() {
  return getEasternDateStr();
}

function yesterdayEasternStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return getEasternDateStr(d);
}

// ============================================================================
// HTTP HELPERS
// ============================================================================

function httpsPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const postData = typeof body === 'string' ? body : JSON.stringify(body);
    const opts = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + (u.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        ...headers
      }
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(text)); }
        catch (_) { resolve(text); }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(new Error('Request timeout')); });
    req.write(postData);
    req.end();
  });
}

// ============================================================================
// TELEGRAM
// ============================================================================

async function sendTelegram(message, parseMode = 'Markdown') {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn('[MarketingTeam] Telegram not configured');
    return null;
  }

  // Telegram message limit is 4096 chars
  const truncated = message.length > 4096 ? message.slice(0, 4090) + '\n...' : message;

  const postData = JSON.stringify({
    chat_id: chatId,
    text: truncated,
    parse_mode: parseMode,
    disable_web_page_preview: true
  });

  return new Promise((resolve, reject) => {
    const req = https.request(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 10000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.ok) console.error('[MarketingTeam] Telegram API error:', parsed.description);
          resolve(parsed);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', (err) => {
      console.error('[MarketingTeam] Telegram error:', err.message);
      reject(err);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Telegram timeout')); });
    req.write(postData);
    req.end();
  });
}

// ============================================================================
// LLM (Ollama GPU Bridge → Claude API fallback)
// ============================================================================

async function callLLM(systemPrompt, userPrompt, maxTokens = 4096) {
  // Try Ollama first (GPU bridge with local fallback, built into ollama-client)
  try {
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];
    const result = await ollamaClient.chat(messages, {
      temperature: 0.7,
      timeout: 120000
    });
    if (result && result.trim()) {
      console.log('[MarketingTeam] LLM response via Ollama');
      return result;
    }
  } catch (e) {
    console.error('[MarketingTeam] Ollama failed (GPU bridge + local):', e.message);
    return null;
  }
}

// Keep backward-compatible alias
const callClaude = callLLM;

// ============================================================================
// DATA COLLECTION HELPERS
// ============================================================================

async function getYesterdaySales(db) {
  const yesterday = yesterdayEasternStr();
  try {
    // Try local Shopify orders table first
    const orders = db.prepare(`
      SELECT COUNT(*) as count,
             COALESCE(SUM(CAST(total_price AS REAL)), 0) as revenue
      FROM shopify_orders
      WHERE date(created_at) = ?
    `).get(yesterday);
    if (orders.count > 0) {
      const avgOrder = (orders.revenue / orders.count).toFixed(2);
      return { date: yesterday, orders: orders.count, revenue: orders.revenue.toFixed(2), avgOrderValue: avgOrder };
    }
  } catch (e) { /* table may not exist */ }

  // Fallback: pull from Shopify API
  try {
    if (shopifyAnalytics.isConfigured()) {
      const snapshot = await shopifyAnalytics.getDailySnapshot();
      return {
        date: yesterday,
        orders: snapshot.today.orders || 0,
        revenue: (snapshot.today.revenue || 0).toFixed(2),
        avgOrderValue: (snapshot.today.avgOrderValue || 0).toFixed(2),
        vsPriorDay: snapshot.vsPriorDay,
        vsLastWeek: snapshot.vsLastWeek,
        source: 'shopify-api'
      };
    }
  } catch (e) {
    console.error('[MarketingTeam] Shopify API fallback error:', e.message);
  }
  return { date: yesterday, orders: 0, revenue: '0.00', avgOrderValue: '0.00' };
}

async function getAbandonedCarts(db) {
  const yesterday = yesterdayEasternStr();
  try {
    const carts = db.prepare(`
      SELECT COUNT(*) as count,
             COALESCE(SUM(CAST(total_price AS REAL)), 0) as value
      FROM shopify_checkouts
      WHERE date(created_at) = ? AND completed_at IS NULL
    `).get(yesterday);
    if (carts.count > 0) return { count: carts.count, value: carts.value.toFixed(2) };
  } catch (e) { /* table may not exist */ }

  // Fallback: Shopify API
  try {
    if (shopifyAnalytics.isConfigured()) {
      const checkouts = await shopifyAnalytics.getAbandonedCheckouts(yesterday);
      const total = checkouts.reduce((s, c) => s + parseFloat(c.total_price || 0), 0);
      return { count: checkouts.length, value: total.toFixed(2), source: 'shopify-api' };
    }
  } catch (e) {
    console.error('[MarketingTeam] Abandoned carts API error:', e.message);
  }
  return { count: 0, value: '0.00' };
}

function getTopProducts(db, dateStr, limit = 5) {
  try {
    const rows = db.prepare(`
      SELECT li.title, COUNT(*) as units, SUM(CAST(li.price AS REAL)) as revenue
      FROM shopify_order_line_items li
      JOIN shopify_orders o ON o.id = li.order_id
      WHERE date(o.created_at) = ?
      GROUP BY li.title
      ORDER BY units DESC
      LIMIT ?
    `).all(dateStr, limit);
    return rows;
  } catch (e) {
    return [];
  }
}

function getYesterdayPosts(db) {
  const yesterday = yesterdayEasternStr();
  try {
    const posts = db.prepare(`
      SELECT COUNT(*) as count,
             COALESCE(AVG(weighted_score), 0) as avgScore
      FROM engagement_tracking
      WHERE date(posted_at) = ?
    `).get(yesterday);

    const bestPost = db.prepare(`
      SELECT product_category, caption_style, weighted_score, engagement_rate
      FROM engagement_tracking
      WHERE date(posted_at) = ?
      ORDER BY weighted_score DESC
      LIMIT 1
    `).get(yesterday);

    return {
      count: posts.count,
      avgScore: posts.avgScore.toFixed(2),
      bestPost
    };
  } catch (e) {
    return { count: 0, avgScore: '0.00', bestPost: null };
  }
}

function getContentCalendarToday(db) {
  const today = todayEasternStr();
  try {
    const items = db.prepare(`
      SELECT product_category, caption_style, planned_time, status
      FROM content_calendar
      WHERE planned_date = ?
      ORDER BY planned_time ASC
    `).all(today);
    return items;
  } catch (e) {
    return [];
  }
}

function getActiveABTests(db) {
  try {
    return db.prepare(`
      SELECT test_name, test_variable, variant_a, variant_b, category,
             (SELECT COUNT(*) FROM ab_test_assignments WHERE test_id = ab_tests.id) as total_assignments
      FROM ab_tests
      WHERE status = 'active'
    `).all();
  } catch (e) {
    return [];
  }
}

async function getWeeklySales(db, weeksBack = 0) {
  const endDate = new Date();
  endDate.setDate(endDate.getDate() - (weeksBack * 7));
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - 7);
  const start = getEasternDateStr(startDate);
  const end = getEasternDateStr(endDate);

  try {
    const result = db.prepare(`
      SELECT date(created_at) as day,
             COUNT(*) as orders,
             COALESCE(SUM(CAST(total_price AS REAL)), 0) as revenue
      FROM shopify_orders
      WHERE date(created_at) BETWEEN ? AND ?
      GROUP BY date(created_at)
      ORDER BY day ASC
    `).all(start, end);

    const totals = db.prepare(`
      SELECT COUNT(*) as orders,
             COALESCE(SUM(CAST(total_price AS REAL)), 0) as revenue
      FROM shopify_orders
      WHERE date(created_at) BETWEEN ? AND ?
    `).get(start, end);

    if (totals.orders > 0) return { start, end, daily: result, totals };
  } catch (e) { /* table may not exist */ }

  // Fallback: Shopify API
  try {
    if (shopifyAnalytics.isConfigured()) {
      const metrics = await shopifyAnalytics.getFunnelMetrics(
        startDate.toISOString(), endDate.toISOString()
      );
      return {
        start, end,
        daily: metrics.byDay || [],
        totals: { orders: metrics.orders || 0, revenue: metrics.revenue || 0 },
        source: 'shopify-api'
      };
    }
  } catch (e) {
    console.error('[MarketingTeam] Weekly sales API error:', e.message);
  }
  return { start, end, daily: [], totals: { orders: 0, revenue: 0 } };
}

function getWeeklyEngagement(db) {
  try {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const since = getEasternDateStr(sevenDaysAgo);

    const byStyle = db.prepare(`
      SELECT caption_style, COUNT(*) as posts,
             AVG(weighted_score) as avg_score,
             SUM(likes) as likes, SUM(comments) as comments, SUM(shares) as shares
      FROM engagement_tracking
      WHERE date(posted_at) >= ?
      GROUP BY caption_style
      ORDER BY avg_score DESC
    `).all(since);

    const byCategory = db.prepare(`
      SELECT product_category, COUNT(*) as posts,
             AVG(weighted_score) as avg_score
      FROM engagement_tracking
      WHERE date(posted_at) >= ?
      GROUP BY product_category
      ORDER BY avg_score DESC
    `).all(since);

    return { byStyle, byCategory };
  } catch (e) {
    return { byStyle: [], byCategory: [] };
  }
}

function getTrendMonitorSummary() {
  try {
    const trendsFile = path.join(DATA_DIR, 'trend-monitor.json');
    if (fs.existsSync(trendsFile)) {
      const data = JSON.parse(fs.readFileSync(trendsFile, 'utf8'));
      return {
        lastScan: data.lastScanAt,
        totalScans: data.stats?.totalScans || 0,
        activeTrends: (data.trends || []).length,
        topTrends: (data.trends || []).slice(0, 5).map(t => ({
          title: t.title,
          score: t.score,
          source: t.source
        })),
        designsGenerated: data.stats?.totalDesignsGenerated || 0
      };
    }
  } catch (e) { /* ignore */ }
  return { lastScan: null, totalScans: 0, activeTrends: 0, topTrends: [], designsGenerated: 0 };
}

function getSalesAgentSummary() {
  try {
    const configPath = path.join(DATA_DIR, 'ai-sales-agent.json');
    if (fs.existsSync(configPath)) {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return {
        enabled: data.agentState?.enabled,
        lastCycle: data.agentState?.lastCycleAt,
        cycleCount: data.agentState?.cycleCount || 0,
        platforms: Object.entries(data.platforms || {})
          .filter(([_, v]) => v.enabled)
          .map(([k]) => k)
      };
    }
  } catch (e) { /* ignore */ }
  return { enabled: false, lastCycle: null, cycleCount: 0, platforms: [] };
}

function getRecentJournalInsights(limit = 5) {
  const lessons = state.journal
    .filter(j => j.type === 'lesson' || j.type === 'observation')
    .slice(-limit);
  return lessons;
}

// ============================================================================
// STANDUP GENERATION
// ============================================================================

async function generateStandup(db = _db) {
  console.log('[MarketingTeam] Generating daily standup...');

  const sales = await getYesterdaySales(db);
  const carts = await getAbandonedCarts(db);
  const topProducts = getTopProducts(db, yesterdayEasternStr());
  const posts = getYesterdayPosts(db);
  const todayPlan = getContentCalendarToday(db);
  const abTests = getActiveABTests(db);
  const recentInsights = getRecentJournalInsights();
  const trendSummary = getTrendMonitorSummary();
  const agentSummary = getSalesAgentSummary();

  // Compare to day before yesterday
  const twoDaysAgo = new Date();
  twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
  const prevDayStr = getEasternDateStr(twoDaysAgo);
  const prevDaySales = getTopProducts(db, prevDayStr, 1); // just to get prev day data
  let prevRevenue = 0;
  try {
    const prev = db.prepare(`
      SELECT COALESCE(SUM(CAST(total_price AS REAL)), 0) as revenue
      FROM shopify_orders WHERE date(created_at) = ?
    `).get(prevDayStr);
    prevRevenue = prev ? prev.revenue : 0;
  } catch (e) { /* ok */ }

  const revenueChange = prevRevenue > 0
    ? (((parseFloat(sales.revenue) - prevRevenue) / prevRevenue) * 100).toFixed(1)
    : 'N/A';

  const rawData = {
    date: yesterdayEasternStr(),
    today: todayEasternStr(),
    sales,
    revenueChangePercent: revenueChange,
    abandonedCarts: carts,
    topProducts,
    socialMedia: posts,
    todayPlan,
    abTests,
    recentInsights,
    trendMonitor: trendSummary,
    salesAgent: agentSummary,
    budget: state.budget,
    weeklyGoals: state.weeklyGoals,
    actionItems: state.actionItems.filter(a => a.status !== 'done')
  };

  const systemPrompt = `You are the Marketing Director for Swayz Custom Vinyl and Blue Ridge Custom Co, two small e-commerce brands selling custom vinyl decals, t-shirts, stickers, metal prints, laser engravings, multiboard organizers, and race car decals.

Your job is to synthesize raw marketing data into a concise, actionable daily standup report for the owner. Be direct, specific, and data-driven. Highlight what matters most. If data is missing or zero, note it briefly and focus on what IS available.

Format the output as a Telegram message using this exact structure (use these emoji headers):

📊 DAILY STANDUP — [Date]

💰 SALES
• Revenue: $X (+/-Y% vs yesterday)
• Orders: N (avg $X per order)
• Abandoned carts: N ($X left behind)

📱 SOCIAL MEDIA
• Posts yesterday: N
• Total engagement: X (best: [post summary])
• Best performing style: [style]

📈 WHAT'S WORKING
• [insight from journal/data]

⚠️ ATTENTION NEEDED
• [any issues or anomalies]

📋 TODAY'S PLAN
• [planned posts/actions]

💡 RECOMMENDATION
• [one actionable suggestion based on data]

Keep it under 3500 characters. Use plain text with emoji, not Markdown formatting (no asterisks for bold).`;

  const userPrompt = `Here is today's raw data. Synthesize into the standup format:\n\n${JSON.stringify(rawData, null, 2)}`;

  const aiReport = await callClaude(systemPrompt, userPrompt);

  if (aiReport) {
    // Record standup
    state.lastStandup = new Date().toISOString();
    state.teamMembers.shopifyAnalytics.lastPull = new Date().toISOString();
    saveState();

    // Store metric snapshot
    try {
      db.prepare(`
        INSERT OR REPLACE INTO marketing_metrics (date, metric_type, data)
        VALUES (?, 'daily_standup', ?)
      `).run(todayEasternStr(), JSON.stringify(rawData));
    } catch (e) {
      console.error('[MarketingTeam] Error saving standup metrics:', e.message);
    }

    return aiReport;
  }

  // Fallback: generate without AI
  const fallback = `📊 DAILY STANDUP — ${yesterdayEasternStr()}

💰 SALES
• Revenue: $${sales.revenue} (${revenueChange}% vs prior day)
• Orders: ${sales.orders} (avg $${sales.avgOrderValue}/order)
• Abandoned carts: ${carts.count} ($${carts.value} left behind)

📱 SOCIAL MEDIA
• Posts yesterday: ${posts.count}
• Avg engagement score: ${posts.avgScore}
${posts.bestPost ? `• Best: ${posts.bestPost.product_category}/${posts.bestPost.caption_style} (score: ${posts.bestPost.weighted_score})` : '• No post data available'}

📋 TODAY'S PLAN
${todayPlan.length > 0 ? todayPlan.map(p => `• ${p.product_category} (${p.caption_style}) at ${p.planned_time || 'TBD'}`).join('\n') : '• No planned posts'}

⚠️ Claude API unavailable — showing raw data`;

  state.lastStandup = new Date().toISOString();
  saveState();
  return fallback;
}

// ============================================================================
// WEEKLY MEETING GENERATION
// ============================================================================

async function generateWeeklyMeeting(db = _db) {
  console.log('[MarketingTeam] Generating weekly strategy meeting...');

  const thisWeek = await getWeeklySales(db, 0);
  const lastWeek = await getWeeklySales(db, 1);
  const engagement = getWeeklyEngagement(db);
  const trendSummary = getTrendMonitorSummary();
  const agentSummary = getSalesAgentSummary();
  const abTests = getActiveABTests(db);
  const recentInsights = getRecentJournalInsights(10);

  // Concluded A/B tests this week
  let concludedTests = [];
  try {
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    concludedTests = db.prepare(`
      SELECT test_name, test_variable, winner, probability_a_better, conclusion_reason
      FROM ab_tests
      WHERE status = 'concluded' AND concluded_at >= ?
    `).all(weekAgo.toISOString());
  } catch (e) { /* ok */ }

  // Week-over-week comparison
  const wowRevenue = lastWeek.totals.revenue > 0
    ? (((thisWeek.totals.revenue - lastWeek.totals.revenue) / lastWeek.totals.revenue) * 100).toFixed(1)
    : 'N/A';
  const wowOrders = lastWeek.totals.orders > 0
    ? (((thisWeek.totals.orders - lastWeek.totals.orders) / lastWeek.totals.orders) * 100).toFixed(1)
    : 'N/A';

  // Journal outcomes from this week
  const weekJournal = state.journal.filter(j => {
    const entryDate = new Date(j.timestamp);
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    return entryDate >= weekAgo;
  });

  const rawData = {
    period: `${thisWeek.start} to ${thisWeek.end}`,
    thisWeek: {
      ...thisWeek,
      totalRevenue: thisWeek.totals.revenue,
      totalOrders: thisWeek.totals.orders
    },
    lastWeek: {
      totalRevenue: lastWeek.totals.revenue,
      totalOrders: lastWeek.totals.orders
    },
    weekOverWeek: { revenueChange: wowRevenue, orderChange: wowOrders },
    engagement,
    trendMonitor: trendSummary,
    salesAgent: agentSummary,
    abTests: { active: abTests, concluded: concludedTests },
    journal: weekJournal,
    recentInsights,
    budget: state.budget,
    currentGoals: state.weeklyGoals,
    pendingActionItems: state.actionItems.filter(a => a.status !== 'done'),
    completedActionItems: state.actionItems.filter(a => a.status === 'done')
  };

  const systemPrompt = `You are the Marketing Director leading the weekly strategy meeting for Swayz Custom Vinyl and Blue Ridge Custom Co. These are small e-commerce brands selling custom vinyl, t-shirts, stickers, metal prints, laser engravings, multiboard organizers, and race car decals.

Synthesize the raw data into a comprehensive but readable weekly strategy report. Be analytical, specific, and strategic. Propose concrete, measurable goals.

Structure the report as:

📈 WEEKLY STRATEGY MEETING — [Date Range]

💰 SALES RECAP
[Daily breakdown, totals, WoW comparison]

📱 SOCIAL MEDIA RECAP
[What styles/categories worked, engagement trends]

🔍 TREND MONITOR
[What's trending, design opportunities]

🧪 A/B TEST RESULTS
[Any concluded tests, what we learned]

📓 JOURNAL INSIGHTS
[Key lessons and observations from the week]

💵 BUDGET DISCUSSION
[Current budget status, ROI of any spend, recommendations]

🎯 GOALS FOR THIS WEEK
[3-5 specific, measurable goals]

📋 ACTION ITEMS
[Concrete next steps with owners]

💡 STRATEGIC RECOMMENDATIONS
[2-3 strategic recommendations for the coming week]

Keep it under 3800 characters. Use plain text with emoji, not Markdown formatting.`;

  const userPrompt = `Here is this week's raw data for the strategy meeting:\n\n${JSON.stringify(rawData, null, 2)}`;

  const aiReport = await callClaude(systemPrompt, userPrompt);

  if (aiReport) {
    // Archive to meeting log
    state.meetingLog.push({
      date: todayEasternStr(),
      type: 'weekly',
      summary: aiReport.slice(0, 500),
      rawData: { revenue: thisWeek.totals.revenue, orders: thisWeek.totals.orders }
    });
    if (state.meetingLog.length > MAX_MEETING_LOG) {
      state.meetingLog = state.meetingLog.slice(-MAX_MEETING_LOG);
    }
    state.lastWeeklyMeeting = new Date().toISOString();
    saveState();

    // Store metric snapshot
    try {
      db.prepare(`
        INSERT OR REPLACE INTO marketing_metrics (date, metric_type, data)
        VALUES (?, 'weekly_meeting', ?)
      `).run(todayEasternStr(), JSON.stringify(rawData));
    } catch (e) {
      console.error('[MarketingTeam] Error saving weekly metrics:', e.message);
    }

    return aiReport;
  }

  // Fallback
  const fallback = `📈 WEEKLY STRATEGY MEETING — ${thisWeek.start} to ${thisWeek.end}

💰 SALES: $${thisWeek.totals.revenue.toFixed(2)} revenue, ${thisWeek.totals.orders} orders
WoW: Revenue ${wowRevenue}%, Orders ${wowOrders}%

📱 ENGAGEMENT: ${engagement.byStyle.length} styles tracked
${engagement.byStyle.map(s => `• ${s.caption_style}: ${s.posts} posts, avg ${(s.avg_score || 0).toFixed(2)}`).join('\n')}

🔍 TRENDS: ${trendSummary.activeTrends} active trends found

⚠️ Claude API unavailable — showing raw data`;

  state.lastWeeklyMeeting = new Date().toISOString();
  saveState();
  return fallback;
}

// ============================================================================
// LEARNING JOURNAL
// ============================================================================

function addJournalEntry(entry) {
  const journalEntry = {
    timestamp: entry.timestamp || new Date().toISOString(),
    type: entry.type || 'observation', // decision, observation, outcome, lesson
    category: entry.category || null,  // content, pricing, targeting, product, trend
    action: entry.action,
    context: entry.context || null,
    outcome: entry.outcome || null,
    score: entry.score != null ? entry.score : null, // -1 to 1
    tags: entry.tags || [],
    related_id: entry.related_id || null
  };

  // Add to in-memory journal
  state.journal.push(journalEntry);
  if (state.journal.length > MAX_JOURNAL_ENTRIES) {
    state.journal = state.journal.slice(-MAX_JOURNAL_ENTRIES);
  }
  saveState();

  // Also persist to DB
  if (_db) {
    try {
      _db.prepare(`
        INSERT INTO marketing_journal (timestamp, type, category, action, context, outcome, score, tags, related_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        journalEntry.timestamp,
        journalEntry.type,
        journalEntry.category,
        journalEntry.action,
        journalEntry.context,
        journalEntry.outcome,
        journalEntry.score,
        JSON.stringify(journalEntry.tags),
        journalEntry.related_id
      );
    } catch (e) {
      console.error('[MarketingTeam] Error saving journal entry to DB:', e.message);
    }
  }

  console.log(`[MarketingTeam] Journal entry added: [${journalEntry.type}] ${journalEntry.action}`);
  return journalEntry;
}

// ============================================================================
// JOURNAL OUTCOME REVIEW
// ============================================================================

async function reviewJournalOutcomes(db = _db) {
  console.log('[MarketingTeam] Reviewing journal outcomes...');

  // Find entries that have actions but no outcomes yet
  const pendingEntries = state.journal.filter(j =>
    j.action && !j.outcome && j.type === 'decision'
  );

  if (pendingEntries.length === 0) {
    console.log('[MarketingTeam] No pending journal outcomes to review');
    return;
  }

  // Limit to reviewing 10 at a time
  const toReview = pendingEntries.slice(0, 10);
  let updated = 0;

  for (const entry of toReview) {
    try {
      // Check if enough time has passed (at least 24 hours)
      const entryAge = Date.now() - new Date(entry.timestamp).getTime();
      if (entryAge < 24 * 60 * 60 * 1000) continue;

      // Try to measure outcome based on category
      let outcome = null;
      let score = null;

      if (entry.category === 'content' && entry.related_id) {
        // Check engagement for related post
        try {
          const post = db.prepare(`
            SELECT weighted_score, likes, comments, shares
            FROM engagement_tracking
            WHERE post_id = ?
          `).get(entry.related_id);
          if (post) {
            const avgScore = db.prepare(`
              SELECT AVG(weighted_score) as avg FROM engagement_tracking
              WHERE posted_at >= datetime('now', '-30 days')
            `).get();
            const avg = avgScore ? avgScore.avg : 0;
            score = avg > 0 ? Math.min(1, Math.max(-1, (post.weighted_score - avg) / avg)) : 0;
            outcome = `Engagement: ${post.likes} likes, ${post.comments} comments, ${post.shares} shares. Score: ${post.weighted_score} (avg: ${(avg || 0).toFixed(2)})`;
          }
        } catch (e) { /* ok */ }
      }

      if (outcome) {
        entry.outcome = outcome;
        entry.score = score;
        updated++;

        // Update DB record too
        try {
          db.prepare(`
            UPDATE marketing_journal SET outcome = ?, score = ?
            WHERE timestamp = ? AND action = ?
          `).run(outcome, score, entry.timestamp, entry.action);
        } catch (e) { /* ok */ }

        // If we learned something, add a lesson entry
        if (score !== null && Math.abs(score) > 0.3) {
          addJournalEntry({
            type: 'lesson',
            category: entry.category,
            action: score > 0
              ? `SUCCESS: "${entry.action}" performed well (score: ${score.toFixed(2)})`
              : `UNDERPERFORMED: "${entry.action}" did not work well (score: ${score.toFixed(2)})`,
            context: outcome,
            tags: [...(entry.tags || []), 'auto-reviewed']
          });
        }
      }
    } catch (e) {
      console.error('[MarketingTeam] Error reviewing journal entry:', e.message);
    }
  }

  if (updated > 0) {
    saveState();
    console.log(`[MarketingTeam] Updated ${updated} journal outcomes`);
  }
}

// ============================================================================
// ANALYSIS CYCLE
// ============================================================================

async function runAnalysisCycle(db = _db) {
  console.log('[MarketingTeam] Running analysis cycle...');
  _lastAnalysisAt = new Date();

  try {
    // Update team member statuses from their data files
    const agentSummary = getSalesAgentSummary();
    state.teamMembers.salesAgent.lastCycle = agentSummary.lastCycle;
    state.teamMembers.salesAgent.status = agentSummary.enabled ? 'active' : 'paused';

    const trendSummary = getTrendMonitorSummary();
    state.teamMembers.trendMonitor.lastScan = trendSummary.lastScan;

    // Store daily metrics snapshot
    const today = todayEasternStr();
    const todaySales = await getYesterdaySales(db); // gets yesterday since today isn't over
    const engagement = getWeeklyEngagement(db);

    try {
      db.prepare(`
        INSERT OR REPLACE INTO marketing_metrics (date, metric_type, data)
        VALUES (?, 'daily_snapshot', ?)
      `).run(today, JSON.stringify({
        sales: todaySales,
        engagement: engagement,
        teamStatus: state.teamMembers,
        timestamp: new Date().toISOString()
      }));
    } catch (e) {
      console.error('[MarketingTeam] Error saving daily snapshot:', e.message);
    }

    // Review journal outcomes
    await reviewJournalOutcomes(db);

    // Update performance baseline if none exists
    if (!state.performanceBaseline) {
      state.performanceBaseline = {
        setAt: new Date().toISOString(),
        avgDailyRevenue: parseFloat(todaySales.revenue),
        avgDailyOrders: todaySales.orders,
        avgEngagementScore: engagement.byStyle.length > 0
          ? engagement.byStyle.reduce((sum, s) => sum + (s.avg_score || 0), 0) / engagement.byStyle.length
          : 0
      };
    }

    state.teamMembers.shopifyAnalytics.lastPull = new Date().toISOString();
    saveState();
    console.log('[MarketingTeam] Analysis cycle complete');
  } catch (e) {
    console.error('[MarketingTeam] Analysis cycle error:', e.message);
  }
}

// ============================================================================
// SCHEDULER
// ============================================================================

function startScheduler(db = _db) {
  if (_schedulerTimer) {
    clearInterval(_schedulerTimer);
  }

  console.log('[MarketingTeam] Starting scheduler (60s interval)');

  _schedulerTimer = setInterval(async () => {
    try {
      const hour = getEasternHour();
      const dayOfWeek = getEasternDayOfWeek();
      const today = todayEasternStr();

      // Check if it's standup time (8 AM Eastern, weekdays)
      if (hour === STANDUP_HOUR && isWeekday()) {
        const alreadySent = state.lastStandup && getEasternDateStr(new Date(state.lastStandup)) === today;

        if (!alreadySent) {
          if (dayOfWeek === 1) {
            // Monday: weekly meeting instead of standup
            const alreadyMet = state.lastWeeklyMeeting && getEasternDateStr(new Date(state.lastWeeklyMeeting)) === today;
            if (!alreadyMet) {
              console.log('[MarketingTeam] Monday 8 AM — generating weekly meeting');
              const report = await generateWeeklyMeeting(db);
              if (report) {
                await sendTelegram(report, 'HTML').catch(() =>
                  sendTelegram(report, '').catch(e =>
                    console.error('[MarketingTeam] Failed to send weekly meeting:', e.message)
                  )
                );
              }
            }
          } else {
            // Tue-Fri: daily standup
            console.log('[MarketingTeam] 8 AM — generating daily standup');
            const report = await generateStandup(db);
            if (report) {
              await sendTelegram(report, 'HTML').catch(() =>
                sendTelegram(report, '').catch(e =>
                  console.error('[MarketingTeam] Failed to send standup:', e.message)
                )
              );
            }
          }
        }
      }

      // Check if it's time for analysis (every 2 hours)
      if (!_lastAnalysisAt || (Date.now() - _lastAnalysisAt.getTime()) >= ANALYSIS_INTERVAL_MS) {
        await runAnalysisCycle(db);
      }
    } catch (e) {
      console.error('[MarketingTeam] Scheduler error:', e.message);
    }
  }, SCHEDULER_INTERVAL_MS);

  // Prevent timer from blocking process exit
  if (_schedulerTimer.unref) _schedulerTimer.unref();
}

// ============================================================================
// PUBLIC API
// ============================================================================

function getTeamStatus() {
  const agentSummary = getSalesAgentSummary();
  const trendSummary = getTrendMonitorSummary();

  return {
    orchestrator: {
      status: _schedulerTimer ? 'running' : 'stopped',
      lastStandup: state.lastStandup,
      lastWeeklyMeeting: state.lastWeeklyMeeting,
      lastAnalysis: _lastAnalysisAt ? _lastAnalysisAt.toISOString() : null
    },
    teamMembers: {
      salesAgent: {
        ...state.teamMembers.salesAgent,
        ...agentSummary
      },
      trendMonitor: {
        ...state.teamMembers.trendMonitor,
        ...trendSummary
      },
      shopifyAnalytics: state.teamMembers.shopifyAnalytics,
      contentCreator: state.teamMembers.contentCreator
    },
    budget: state.budget,
    weeklyGoals: state.weeklyGoals,
    pendingActionItems: state.actionItems.filter(a => a.status !== 'done').length,
    journalEntries: state.journal.length,
    meetingsHeld: state.meetingLog.length
  };
}

function getDashboardData(db = _db) {
  const status = getTeamStatus();
  const recentJournal = state.journal.slice(-20).reverse();
  const recentMeetings = state.meetingLog.slice(-4).reverse();

  // Get recent metrics from DB
  let recentMetrics = [];
  try {
    recentMetrics = db.prepare(`
      SELECT date, metric_type, data
      FROM marketing_metrics
      WHERE date >= date('now', '-7 days')
      ORDER BY date DESC
    `).all().map(r => ({
      date: r.date,
      type: r.metric_type,
      data: JSON.parse(r.data)
    }));
  } catch (e) { /* ok */ }

  // Active recommendations from journal lessons
  const recommendations = state.journal
    .filter(j => j.type === 'lesson' && j.score !== null)
    .slice(-10)
    .reverse()
    .map(j => ({
      action: j.action,
      score: j.score,
      category: j.category,
      date: j.timestamp
    }));

  return {
    status,
    recentJournal,
    recentMeetings,
    recentMetrics,
    recommendations,
    budget: state.budget,
    weeklyGoals: state.weeklyGoals,
    actionItems: state.actionItems,
    performanceBaseline: state.performanceBaseline
  };
}

async function triggerMeeting(type = 'standup') {
  console.log(`[MarketingTeam] Manually triggered ${type} meeting`);

  let report;
  if (type === 'weekly') {
    report = await generateWeeklyMeeting(_db);
  } else {
    report = await generateStandup(_db);
  }

  if (report) {
    // Try HTML first, fall back to plain text
    await sendTelegram(report, 'HTML').catch(() =>
      sendTelegram(report, '').catch(e =>
        console.error(`[MarketingTeam] Failed to send ${type} report:`, e.message)
      )
    );
  }

  return report;
}

function updateBudget(newBudget) {
  if (newBudget.daily !== undefined) state.budget.daily = Number(newBudget.daily) || 0;
  if (newBudget.weekly !== undefined) state.budget.weekly = Number(newBudget.weekly) || 0;
  if (newBudget.monthly !== undefined) state.budget.monthly = Number(newBudget.monthly) || 0;

  saveState();
  console.log('[MarketingTeam] Budget updated:', state.budget);

  addJournalEntry({
    type: 'decision',
    category: 'pricing',
    action: `Budget updated: daily=$${state.budget.daily}, weekly=$${state.budget.weekly}, monthly=$${state.budget.monthly}`,
    context: 'Manual budget update',
    tags: ['budget']
  });

  return state.budget;
}

// ============================================================================
// INIT
// ============================================================================

function init() {
  console.log('[MarketingTeam] Initializing...');

  try {
    _db = new Database(DB_PATH);
  } catch (e) {
    console.error('[MarketingTeam] DB init failed:', e.message);
    return;
  }

  loadState();
  ensureTables(_db);
  startScheduler(_db);

  // Run initial analysis after a short delay to let server finish booting
  setTimeout(() => {
    runAnalysisCycle(_db).catch(e =>
      console.error('[MarketingTeam] Initial analysis error:', e.message)
    );
  }, 10000);

  console.log('[MarketingTeam] Initialized successfully');
  console.log(`[MarketingTeam]   Last standup: ${state.lastStandup || 'never'}`);
  console.log(`[MarketingTeam]   Last weekly meeting: ${state.lastWeeklyMeeting || 'never'}`);
  console.log(`[MarketingTeam]   Journal entries: ${state.journal.length}`);
  console.log(`[MarketingTeam]   Meeting log: ${state.meetingLog.length}`);
}

// ============================================================================
// EXPORTS
// ============================================================================

function getBudget() {
  return state.budget;
}

module.exports = {
  init,
  generateStandup,
  generateWeeklyMeeting,
  addJournalEntry,
  reviewJournalOutcomes,
  getTeamStatus,
  getDashboardData,
  triggerMeeting,
  updateBudget,
  getBudget
};
