/**
 * Facebook Group Poster
 *
 * Manages posting to Facebook Groups for organic reach.
 * Since FB API requires special group permissions most users don't have,
 * this module prepares group-optimized content and delivers it to Telegram
 * with deep links so the owner can tap → paste → post in seconds.
 *
 * Groups hate obvious ads, so copy is rewritten to be value-first:
 * share something interesting, mention you made it, soft CTA.
 *
 * Flow:
 *   1. AI Sales Agent or pipeline creates a page post
 *   2. This module picks relevant groups by category
 *   3. Ollama rewrites the caption for group context
 *   4. Sends image + group-optimized text to Telegram
 *   5. User taps group link, pastes text, posts
 */

const path = require('path');
const fs = require('fs');

const ENV_PATH = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(ENV_PATH)) require('dotenv').config({ path: ENV_PATH });

let _db = null;

function getDb() {
  if (!_db) _db = require('../db');
  return _db;
}

// ─── DB Setup ────────────────────────────────────────────────────────────────

function ensureTable() {
  const db = getDb();
  db.getDb().exec(`
    CREATE TABLE IF NOT EXISTS fb_target_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      fb_group_id TEXT,
      url TEXT,
      category TEXT DEFAULT 'general',
      post_frequency TEXT DEFAULT 'weekly',
      last_posted_at TEXT,
      posts_this_week INTEGER DEFAULT 0,
      enabled INTEGER DEFAULT 1,
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

// ─── Group Management ────────────────────────────────────────────────────────

function listGroups(category) {
  ensureTable();
  const db = getDb();
  if (category) {
    return db.getDb().prepare(
      `SELECT * FROM fb_target_groups WHERE enabled = 1 AND category = ? ORDER BY name`
    ).all(category);
  }
  return db.getDb().prepare(
    `SELECT * FROM fb_target_groups WHERE enabled = 1 ORDER BY category, name`
  ).all();
}

function addGroup({ name, fbGroupId, url, category, postFrequency, notes }) {
  ensureTable();
  const db = getDb();
  const id = `fbg_${require('crypto').randomBytes(6).toString('hex')}`;
  db.getDb().prepare(`
    INSERT INTO fb_target_groups (id, name, fb_group_id, url, category, post_frequency, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, fbGroupId || null, url || null, category || 'general', postFrequency || 'weekly', notes || null);
  return { id, name, category };
}

function removeGroup(id) {
  ensureTable();
  const db = getDb();
  db.getDb().prepare(`DELETE FROM fb_target_groups WHERE id = ?`).run(id);
}

function updateGroup(id, updates) {
  ensureTable();
  const db = getDb();
  const fields = [];
  const values = [];
  for (const [key, val] of Object.entries(updates)) {
    if (['name', 'fb_group_id', 'url', 'category', 'post_frequency', 'notes', 'enabled'].includes(key)) {
      fields.push(`${key} = ?`);
      values.push(val);
    }
  }
  if (fields.length === 0) return;
  values.push(id);
  db.getDb().prepare(`UPDATE fb_target_groups SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

// ─── Group-Optimized Copy ────────────────────────────────────────────────────

const GROUP_COPY_PROMPT = `You are rewriting a Facebook business post for sharing in a community Facebook Group.

Group rules: NO obvious ads, NO "shop now", NO corporate tone. Members WILL report blatant ads.

Rewrite the post so it:
- Leads with something interesting, useful, or relatable (NOT the product)
- Sounds like a real person sharing something they made/found, not a brand posting
- Mentions it's handmade/local only casually ("I make these in my shop in Asheville")
- Has NO hashtags (groups don't use them)
- Has NO links in the main text (you can mention "link in comments" at most)
- Asks a genuine question to spark discussion
- Is 2-4 sentences max

Return JSON only, no markdown:
{"text": "your rewritten group post", "comment": "optional first comment with the shop link"}`;

async function rewriteForGroup(originalCaption, groupName, category, shopUrl) {
  try {
    const ollamaClient = require('../lib/ollama-client');
    const prompt = `${GROUP_COPY_PROMPT}

Original post: ${originalCaption}
Group name: ${groupName}
Product category: ${category}
Shop URL: ${shopUrl || ''}

Rewrite for this group:`;

    const result = await ollamaClient.generate(prompt, { temperature: 0.7, maxTokens: 300 });
    // Extract JSON from response
    let parsed = null;
    try {
      const cleaned = (result || '').replace(/```(?:json)?\s*\n?([\s\S]*?)```/g, '$1').trim();
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start !== -1 && end > start) parsed = JSON.parse(cleaned.substring(start, end + 1));
    } catch (_) {}
    if (parsed && parsed.text) return parsed;
  } catch (e) {
    console.warn(`[GroupPoster] AI rewrite failed: ${e.message}`);
  }

  // Fallback: strip hashtags and add casual tone
  const stripped = originalCaption.replace(/#\w+/g, '').replace(/\s{2,}/g, ' ').trim();
  return {
    text: stripped,
    comment: shopUrl ? `If anyone's interested: ${shopUrl}` : ''
  };
}

// ─── Post to Groups via Telegram ─────────────────────────────────────────────

/**
 * Prepare and send group posts to Telegram for manual sharing.
 *
 * @param {object} post - The original post data
 * @param {string} post.text - Original caption
 * @param {string} post.imageUrl - Public image URL (or local path)
 * @param {string} post.category - Product category for group matching
 * @param {string} post.shopUrl - Product/collection URL
 * @param {object} [options]
 * @param {string[]} [options.groupIds] - Specific group IDs (default: all matching)
 * @param {boolean} [options.rewrite] - Rewrite copy for groups (default: true)
 */
async function sendToGroups(post, options = {}) {
  ensureTable();
  const { rewrite = true, groupIds } = options;

  // Find matching groups
  let groups;
  if (groupIds && groupIds.length) {
    const db = getDb();
    groups = db.getDb().prepare(
      `SELECT * FROM fb_target_groups WHERE id IN (${groupIds.map(() => '?').join(',')}) AND enabled = 1`
    ).all(...groupIds);
  } else {
    groups = getGroupsForCategory(post.category);
  }

  if (!groups.length) {
    console.log(`[GroupPoster] No matching groups for category: ${post.category}`);
    return { sent: 0, groups: [] };
  }

  const telegram = require('../lib/telegram-notifier');
  if (!telegram.isConfigured()) {
    console.warn('[GroupPoster] Telegram not configured, cannot deliver group posts');
    return { sent: 0, error: 'Telegram not configured' };
  }

  const results = [];

  for (const group of groups) {
    // Check posting frequency
    if (!shouldPostToGroup(group)) {
      console.log(`[GroupPoster] Skipping ${group.name} (frequency limit)`);
      continue;
    }

    // Rewrite copy for this group
    let groupCopy;
    if (rewrite) {
      groupCopy = await rewriteForGroup(post.text, group.name, post.category, post.shopUrl);
    } else {
      groupCopy = { text: post.text, comment: post.shopUrl ? `Shop: ${post.shopUrl}` : '' };
    }

    // Build Telegram message
    const groupUrl = group.url || (group.fb_group_id ? `https://www.facebook.com/groups/${group.fb_group_id}` : null);

    let tgMessage = `📢 *Post to Group: ${group.name}*\n\n`;
    tgMessage += `📋 *Copy this text:*\n\`\`\`\n${groupCopy.text}\n\`\`\``;
    if (groupCopy.comment) {
      tgMessage += `\n\n💬 *First comment:*\n\`\`\`\n${groupCopy.comment}\n\`\`\``;
    }
    if (groupUrl) {
      tgMessage += `\n\n👉 Open group: ${groupUrl}`;
    }

    try {
      // If we have a local image, send as photo with caption
      if (post.imagePath && fs.existsSync(post.imagePath)) {
        const imageBuffer = fs.readFileSync(post.imagePath);
        await telegram.sendPhoto(imageBuffer, tgMessage);
      } else {
        await telegram.sendMessage(tgMessage);
      }

      // Track the post
      markGroupPosted(group.id);
      results.push({ groupId: group.id, groupName: group.name, sent: true });
      console.log(`[GroupPoster] Sent to Telegram for group: ${group.name}`);
    } catch (e) {
      console.error(`[GroupPoster] Failed to send for ${group.name}: ${e.message}`);
      results.push({ groupId: group.id, groupName: group.name, sent: false, error: e.message });
    }
  }

  return { sent: results.filter(r => r.sent).length, groups: results };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const CATEGORY_GROUP_MAP = {
  'metal-print':      ['home-decor', 'art', 'general', 'asheville'],
  'multiboard':       ['home-decor', '3d-printing', 'organization', 'general', 'asheville'],
  'tshirt':           ['apparel', 'humor', 'pop-culture', 'general', 'asheville'],
  'sticker':          ['stickers', 'pop-culture', 'general'],
  'racing':           ['racing', 'motorsports', 'car-enthusiasts'],
  'custom-vinyl':     ['car-enthusiasts', 'diy', 'general'],
  'laser-engraving':  ['woodworking', 'crafts', 'gifts', 'asheville'],
  'mountain-biking':  ['mountain-biking', 'cycling', 'outdoor', 'asheville'],
};

function getGroupsForCategory(category) {
  const matchingCategories = CATEGORY_GROUP_MAP[category] || ['general'];
  const allGroups = listGroups();
  return allGroups.filter(g =>
    matchingCategories.includes(g.category) || g.category === 'general'
  );
}

function shouldPostToGroup(group) {
  const freq = group.post_frequency || 'weekly';
  const lastPosted = group.last_posted_at ? new Date(group.last_posted_at) : null;
  if (!lastPosted) return true;

  const now = new Date();
  const hoursSince = (now - lastPosted) / (1000 * 60 * 60);

  const minHours = {
    'daily': 20,
    'every-other-day': 44,
    'weekly': 156,       // ~6.5 days
    'twice-weekly': 72,  // ~3 days
  };

  return hoursSince >= (minHours[freq] || 156);
}

function markGroupPosted(groupId) {
  const db = getDb();
  db.getDb().prepare(`
    UPDATE fb_target_groups
    SET last_posted_at = CURRENT_TIMESTAMP,
        posts_this_week = posts_this_week + 1
    WHERE id = ?
  `).run(groupId);
}

// Reset weekly counters (call from a cron/interval)
function resetWeeklyCounters() {
  ensureTable();
  const db = getDb();
  db.getDb().prepare(`UPDATE fb_target_groups SET posts_this_week = 0`).run();
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  ensureTable,
  listGroups,
  addGroup,
  removeGroup,
  updateGroup,
  sendToGroups,
  rewriteForGroup,
  getGroupsForCategory,
  resetWeeklyCounters,
  CATEGORY_GROUP_MAP,
};
