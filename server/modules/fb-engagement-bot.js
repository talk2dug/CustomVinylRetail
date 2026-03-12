/**
 * Facebook Engagement Bot
 *
 * Monitors comments on recent FB page posts and auto-replies with helpful
 * product info, pricing, shop links, and answers to common questions.
 *
 * Strategy:
 * - Polls recent posts every 15 minutes for new comments
 * - Uses Ollama to generate contextual, authentic replies
 * - Includes UTM-tagged shop links in replies
 * - Tracks replied comments to avoid duplicates
 * - Rate-limits replies to avoid looking spammy
 *
 * Exports: init(db), handleRoute(), getStatus()
 */

const https = require('https');
const ollamaClient = require('../lib/ollama-client');
const { tagUrl } = require('./utm-attribution');

const TAG = '[FBEngagement]';

const PAGE_ID = process.env.FB_PAGE_ID;
const PAGE_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;
const STORE_URL = process.env.STORE_BASE_URL || process.env.ASSET_BASE_URL || 'https://blueridgecustomco.com';

const POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_REPLIES_PER_HOUR = 10;
const LOOKBACK_DAYS = 7; // Only check posts from last 7 days
const REPLY_DELAY_MS = 30000; // 30s delay between replies to look natural

let _db = null;
let _timer = null;
let _repliesThisHour = 0;
let _hourResetTimer = null;
let _lastPoll = null;
let _stats = { totalReplies: 0, commentsProcessed: 0, lastError: null };

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fb_comment_replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      facebook_post_id TEXT NOT NULL,
      comment_id TEXT UNIQUE NOT NULL,
      comment_text TEXT,
      commenter_name TEXT,
      reply_text TEXT,
      replied_at TEXT DEFAULT (datetime('now')),
      post_product_name TEXT,
      post_campaign TEXT
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_fb_replies_post ON fb_comment_replies(facebook_post_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_fb_replies_comment ON fb_comment_replies(comment_id)`);
}

// ---------------------------------------------------------------------------
// Graph API helpers
// ---------------------------------------------------------------------------

function graphGet(path) {
  return new Promise((resolve, reject) => {
    const separator = path.includes('?') ? '&' : '?';
    const fullPath = `${path}${separator}access_token=${PAGE_TOKEN}`;
    const req = https.request({
      hostname: 'graph.facebook.com',
      path: `/v21.0${fullPath}`,
      method: 'GET'
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.error) reject(new Error(result.error.message));
          else resolve(result);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function graphPost(path, body) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ ...body, access_token: PAGE_TOKEN });
    const req = https.request({
      hostname: 'graph.facebook.com',
      path: `/v21.0${path}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.error) reject(new Error(result.error.message));
          else resolve(result);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Get recent posts with their comments
// ---------------------------------------------------------------------------

async function getRecentPostsWithComments() {
  const since = new Date();
  since.setDate(since.getDate() - LOOKBACK_DAYS);
  const sinceTs = Math.floor(since.getTime() / 1000);

  // Get recent page posts
  const postsResult = await graphGet(
    `/${PAGE_ID}/posts?fields=id,message,created_time&since=${sinceTs}&limit=25`
  );

  const posts = postsResult.data || [];
  const postsWithComments = [];

  for (const post of posts) {
    try {
      // Get comments for each post
      const commentsResult = await graphGet(
        `/${post.id}/comments?fields=id,message,from,created_time&limit=50`
      );
      const comments = commentsResult.data || [];
      if (comments.length > 0) {
        postsWithComments.push({ ...post, comments });
      }
    } catch (e) {
      // Some posts may not allow comment reading
      console.warn(TAG, `Could not fetch comments for post ${post.id}: ${e.message}`);
    }
  }

  return postsWithComments;
}

// ---------------------------------------------------------------------------
// Check if we already replied to a comment
// ---------------------------------------------------------------------------

function hasReplied(commentId) {
  const row = _db.prepare('SELECT 1 FROM fb_comment_replies WHERE comment_id = ?').get(commentId);
  return !!row;
}

// ---------------------------------------------------------------------------
// Get product context for a post (from scheduled_facebook_posts table)
// ---------------------------------------------------------------------------

function getPostContext(facebookPostId) {
  // Try to find the post in our scheduled posts table
  const post = _db.prepare(`
    SELECT product_name, campaign_slug, campaign_type, collection_url, post_text
    FROM scheduled_facebook_posts
    WHERE facebook_post_id = ?
  `).get(facebookPostId);

  if (post) return post;

  // Also check fb_marketplace_listings
  const listing = _db.prepare(`
    SELECT product_title AS product_name, 'fb-marketplace' AS campaign_slug
    FROM fb_marketplace_listings
    WHERE fb_post_id = ?
  `).get(facebookPostId);

  return listing || null;
}

// ---------------------------------------------------------------------------
// Determine if a comment needs a reply
// ---------------------------------------------------------------------------

function shouldReply(comment, postMessage) {
  // Skip if it's from our own page
  if (comment.from && comment.from.id === PAGE_ID) return false;

  const text = (comment.message || '').toLowerCase();

  // Always reply to questions
  if (text.includes('?')) return true;

  // Reply to price/shipping/availability inquiries
  const triggerWords = [
    'price', 'cost', 'how much', 'shipping', 'ship', 'deliver',
    'available', 'stock', 'order', 'buy', 'purchase', 'want',
    'interested', 'need', 'where', 'link', 'website', 'site',
    'custom', 'customize', 'personalize', 'size', 'color',
    'local', 'pickup', 'pick up', 'asheville',
    'dm', 'message', 'info', 'details', 'more'
  ];

  if (triggerWords.some(w => text.includes(w))) return true;

  // Reply to positive engagement (builds community)
  const positiveWords = ['love', 'awesome', 'amazing', 'great', 'beautiful', 'nice', 'cool', 'want this', 'need this'];
  if (positiveWords.some(w => text.includes(w))) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Generate reply using Ollama
// ---------------------------------------------------------------------------

async function generateReply(comment, postContext) {
  const productName = postContext?.product_name || 'our product';
  const campaignType = postContext?.campaign_type || '';

  // Build a shop link with UTM
  const shopLink = postContext?.collection_url || tagUrl(STORE_URL, {
    source: 'facebook',
    medium: 'social-reply',
    campaign: 'engagement-bot'
  });

  const systemPrompt = `You are the social media manager for Blue Ridge Custom Co, a small business in Asheville, NC that makes custom products (metal prints, apparel, stickers, laser engraved items, 3D printed items, and Multiboard accessories).

Your job is to reply to Facebook comments on our posts. Be:
- Friendly and authentic (small business owner vibe, not corporate)
- Helpful — answer the question or acknowledge the compliment
- Brief — 1-3 sentences max
- Include the shop link ONLY if they're asking about buying/pricing/availability
- Mention local pickup in Asheville when relevant
- Never be pushy or salesy
- Use casual punctuation, maybe one emoji max
- Never use hashtags in replies

Shop link: ${shopLink}
Product: ${productName}
Location: Asheville, NC`;

  const userPrompt = `Comment on our post about "${productName}":
"${comment.message}"

Write a brief, friendly reply:`;

  try {
    const reply = await ollamaClient.chat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ], { temperature: 0.7, maxTokens: 150 });

    if (!reply) return null;

    // Clean up — remove quotes if Ollama wrapped the reply
    let cleaned = reply.trim();
    if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
      cleaned = cleaned.slice(1, -1);
    }
    // Remove any "Reply:" prefix
    cleaned = cleaned.replace(/^(reply|response|comment):\s*/i, '');

    return cleaned;
  } catch (e) {
    console.error(TAG, 'Ollama reply generation failed:', e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Post a reply to a comment
// ---------------------------------------------------------------------------

async function replyToComment(commentId, message) {
  return graphPost(`/${commentId}/comments`, { message });
}

// ---------------------------------------------------------------------------
// Main engagement cycle
// ---------------------------------------------------------------------------

async function runEngagementCycle() {
  if (!PAGE_TOKEN || !PAGE_ID) {
    console.warn(TAG, 'Missing FB_PAGE_ACCESS_TOKEN or FB_PAGE_ID');
    return;
  }

  console.log(TAG, 'Polling for new comments...');
  _lastPoll = new Date().toISOString();

  try {
    const posts = await getRecentPostsWithComments();
    let newComments = 0;
    let replied = 0;

    for (const post of posts) {
      const postContext = getPostContext(post.id);

      for (const comment of post.comments) {
        // Skip already-replied comments
        if (hasReplied(comment.id)) continue;
        newComments++;

        // Check rate limit
        if (_repliesThisHour >= MAX_REPLIES_PER_HOUR) {
          console.log(TAG, `Rate limit reached (${MAX_REPLIES_PER_HOUR}/hr), will continue next cycle`);
          return;
        }

        // Decide if we should reply
        if (!shouldReply(comment, post.message)) {
          // Record as processed but no reply needed
          _db.prepare(`
            INSERT OR IGNORE INTO fb_comment_replies (facebook_post_id, comment_id, comment_text, commenter_name, reply_text, post_product_name, post_campaign)
            VALUES (?, ?, ?, ?, NULL, ?, ?)
          `).run(
            post.id,
            comment.id,
            comment.message || '',
            comment.from?.name || 'Unknown',
            postContext?.product_name || null,
            postContext?.campaign_slug || null
          );
          continue;
        }

        // Generate and post reply
        const replyText = await generateReply(comment, postContext);
        if (!replyText) {
          console.warn(TAG, `No reply generated for comment ${comment.id}`);
          continue;
        }

        try {
          // Delay between replies
          if (replied > 0) {
            await new Promise(r => setTimeout(r, REPLY_DELAY_MS));
          }

          await replyToComment(comment.id, replyText);
          _repliesThisHour++;
          replied++;
          _stats.totalReplies++;

          // Record the reply
          _db.prepare(`
            INSERT OR IGNORE INTO fb_comment_replies (facebook_post_id, comment_id, comment_text, commenter_name, reply_text, post_product_name, post_campaign)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            post.id,
            comment.id,
            comment.message || '',
            comment.from?.name || 'Unknown',
            replyText,
            postContext?.product_name || null,
            postContext?.campaign_slug || null
          );

          console.log(TAG, `Replied to ${comment.from?.name || 'someone'}: "${(comment.message || '').slice(0, 50)}..." → "${replyText.slice(0, 50)}..."`);
        } catch (e) {
          console.error(TAG, `Failed to reply to comment ${comment.id}:`, e.message);
          _stats.lastError = e.message;
        }
      }
    }

    _stats.commentsProcessed += newComments;
    console.log(TAG, `Cycle complete: ${newComments} new comments, ${replied} replies sent`);
  } catch (e) {
    console.error(TAG, 'Engagement cycle error:', e.message);
    _stats.lastError = e.message;
  }
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

function handleRoute(pathname, req, res, db) {
  // GET /api/fb-engagement/status
  if (pathname === '/api/fb-engagement/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getStatus()));
    return true;
  }

  // GET /api/fb-engagement/replies?limit=50
  if (pathname === '/api/fb-engagement/replies' && req.method === 'GET') {
    const parsed = new URL(req.url, 'http://localhost');
    const limit = parseInt(parsed.searchParams.get('limit') || '50', 10);
    const replies = _db.prepare(`
      SELECT * FROM fb_comment_replies
      WHERE reply_text IS NOT NULL
      ORDER BY replied_at DESC LIMIT ?
    `).all(limit);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ replies }));
    return true;
  }

  // POST /api/fb-engagement/run — trigger immediate cycle
  if (pathname === '/api/fb-engagement/run' && req.method === 'POST') {
    runEngagementCycle().then(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, stats: _stats }));
    }).catch(e => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
    return true;
  }

  return false;
}

function getStatus() {
  const totalReplies = _db ? _db.prepare('SELECT COUNT(*) AS c FROM fb_comment_replies WHERE reply_text IS NOT NULL').get().c : 0;
  return {
    running: !!_db,
    configured: !!(PAGE_TOKEN && PAGE_ID),
    pollInterval: '15 min',
    maxRepliesPerHour: MAX_REPLIES_PER_HOUR,
    repliesThisHour: _repliesThisHour,
    totalReplies,
    lastPoll: _lastPoll,
    stats: _stats
  };
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function init(db) {
  _db = db;
  ensureTables(db);

  if (!PAGE_TOKEN || !PAGE_ID) {
    console.warn(TAG, 'Missing FB_PAGE_ACCESS_TOKEN or FB_PAGE_ID — bot disabled');
    return;
  }

  // Reset hourly rate limit
  _hourResetTimer = setInterval(() => { _repliesThisHour = 0; }, 60 * 60 * 1000);
  if (_hourResetTimer.unref) _hourResetTimer.unref();

  // First run after 60s, then every 15 min
  setTimeout(() => {
    runEngagementCycle().catch(e => console.error(TAG, 'Initial cycle error:', e.message));
  }, 60000);

  _timer = setInterval(() => {
    runEngagementCycle().catch(e => console.error(TAG, 'Cycle error:', e.message));
  }, POLL_INTERVAL_MS);

  if (_timer.unref) _timer.unref();
  console.log(TAG, `Initialized (${MAX_REPLIES_PER_HOUR} replies/hr, ${LOOKBACK_DAYS}d lookback, 15min poll)`);
}

module.exports = {
  init,
  handleRoute,
  getStatus,
  runEngagementCycle
};
