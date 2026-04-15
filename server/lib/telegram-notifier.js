/**
 * Telegram Notifier - Sends messages to owner via Telegram Bot API
 * Used by AI Sales Agent and Pipeline Monitor for alerts, reports, approvals
 */

const https = require('https');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

function isConfigured() {
  return !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);
}

/**
 * Send a message via Telegram Bot API
 */
async function sendMessage(text, parseMode = 'Markdown') {
  if (!isConfigured()) {
    console.warn('[Telegram] Not configured (missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID)');
    return null;
  }

  // Truncate to Telegram's 4096 char limit
  const truncated = text.length > 4096 ? text.slice(0, 4090) + '\n...' : text;

  const postData = JSON.stringify({
    chat_id: TELEGRAM_CHAT_ID,
    text: truncated,
    parse_mode: parseMode,
    disable_web_page_preview: true
  });

  return new Promise((resolve, reject) => {
    const req = https.request(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.ok) {
            console.error('[Telegram] API error:', parsed.description);
          }
          resolve(parsed);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', (err) => {
      console.error('[Telegram] Request error:', err.message);
      reject(err);
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Telegram request timeout'));
    });
    req.write(postData);
    req.end();
  });
}

/**
 * Send a formatted alert
 */
async function sendAlert(severity, title, body) {
  const icons = {
    info: 'ℹ️',
    warning: '⚠️',
    critical: '🚨',
    success: '✅',
    milestone: '🎉'
  };
  const icon = icons[severity] || 'ℹ️';
  const text = `${icon} *${title}*\n\n${body}`;
  return sendMessage(text);
}

/**
 * Send daily report (Phase 4c: enriched with hook formula, saturation, weighted score trend)
 */
async function sendDailyReport(report) {
  let text = `📊 *Daily Sales Agent Report — ${report.date || new Date().toISOString().slice(0, 10)}*\n\n` +
    `*Posts Published Today:* ${report.postsPublished || 0}\n` +
    (report.topPost ? `*Best Post:* ${report.topPost.name} (${report.topPost.engagement} weighted score)\n` : '') +
    `\n*Engagement (7-day):*\n` +
    `• Total Likes: ${report.totalLikes || 0}\n` +
    `• Total Comments: ${report.totalComments || 0}\n` +
    `• Total Shares: ${report.totalShares || 0}\n` +
    `• Avg Weighted Score: ${report.avgWeightedScore || 0}\n`;

  // Weighted score trend
  if (report.weightedScoreTrend) {
    const trend = report.weightedScoreTrend;
    const arrow = trend.change > 0 ? '📈' : trend.change < 0 ? '📉' : '➡️';
    text += `\n*Score Trend:* ${arrow} ${trend.thisWeek} (${trend.change >= 0 ? '+' : ''}${trend.change}% vs last week)\n`;
  }

  // Best hook formula
  if (report.bestHookFormula) {
    text += `\n*Top Hook Formula (7d):* ${report.bestHookFormula.hook_formula} (avg score: ${report.bestHookFormula.avg_score}, n=${report.bestHookFormula.count})\n`;
  }

  text += `\n*Queue:* ${report.queueDepth || 0} posts pending (${report.queueDays || 0} days)\n`;

  // Saturation warnings
  if (report.saturationWarnings && report.saturationWarnings.length > 0) {
    text += `\n⚠️ *Saturation Warnings:*\n${report.saturationWarnings.map(w => `• ${w}`).join('\n')}\n`;
  }

  if (report.strategyNote) {
    text += `\n*Strategy:* ${report.strategyNote}`;
  }

  if (report.alerts && report.alerts.length > 0) {
    text += `\n\n*Alerts:*\n${report.alerts.map(a => `• ${a}`).join('\n')}`;
  }

  return sendMessage(text);
}

/**
 * Send weekly strategy report (Phase 4c: enriched with matrix, recycling, trends)
 */
async function sendWeeklyReport(report) {
  let text = `📈 *Weekly Strategy Report — ${report.dateRange || 'This Week'}*\n\n` +
    `*What Worked:*\n${(report.worked || ['No data yet']).map(w => `✅ ${w}`).join('\n')}\n\n` +
    `*What Didn't Work:*\n${(report.didntWork || ['No data yet']).map(w => `❌ ${w}`).join('\n')}\n\n` +
    `*Adjustments Made:*\n${(report.adjustments || ['None yet']).map(a => `🔄 ${a}`).join('\n')}\n\n` +
    `*Recommendations:*\n${(report.recommendations || ['Gathering data...']).map((r, i) => `${i + 1}. ${r}`).join('\n')}\n`;

  // Week-over-week posting volume
  if (report.weekOverWeek) {
    const wow = report.weekOverWeek;
    text += `\n*Volume:* ${wow.thisWeek} posts this week (vs ${wow.lastWeek} last week)\n`;
  }

  // Category x Style matrix
  if (report.categoryStyleMatrix && report.categoryStyleMatrix.length > 0) {
    text += `\n*Category × Style Performance:*\n`;
    for (const row of report.categoryStyleMatrix.slice(0, 8)) {
      text += `• ${row.product_category}/${row.caption_style}: ${row.avg_weighted_score} wtd (n=${row.post_count})\n`;
    }
  }

  // Recycling candidates
  if (report.recyclingCandidates && report.recyclingCandidates.length > 0) {
    text += `\n♻️ *Repost Candidates:*\n`;
    for (const c of report.recyclingCandidates) {
      text += `• "${c.name}" (${c.category}, score: ${c.score})\n`;
    }
  }

  // Active A/B tests
  if (report.activeABTests && report.activeABTests.length > 0) {
    text += `\n🧪 *Active A/B Tests:*\n`;
    for (const t of report.activeABTests) {
      text += `• ${t.test_name}: ${t.variant_a} vs ${t.variant_b}\n`;
    }
  }

  text += `\n*Next Week Plan:* ${report.nextWeekPlan || 'Continue current strategy'}`;

  return sendMessage(text);
}

/**
 * Send approval request with command-based response
 */
async function sendApprovalRequest(question, approvalId) {
  const text = `🔔 *Approval Request*\n\n${question}\n\n` +
    `Reply \`/approve_${approvalId}\` or \`/deny_${approvalId}\``;
  return sendMessage(text);
}

/**
 * Send a photo via Telegram Bot API (multipart/form-data)
 * @param {Buffer} imageBuffer - JPEG image data
 * @param {string} caption - Photo caption (optional)
 */
async function sendPhoto(imageBuffer, caption = '', parseMode = 'Markdown') {
  if (!isConfigured()) {
    console.warn('[Telegram] Not configured');
    return null;
  }
  if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) {
    console.warn('[Telegram] sendPhoto: invalid imageBuffer');
    return null;
  }

  const boundary = '----TelegramBotBoundary' + Date.now();
  const parts = [];

  // chat_id field
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${TELEGRAM_CHAT_ID}`);
  // parse_mode field
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="parse_mode"\r\n\r\n${parseMode}`);
  // caption field
  if (caption) {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption.slice(0, 1024)}`);
  }

  const textPart = Buffer.from(parts.join('\r\n') + '\r\n');
  const fileHeader = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="snapshot.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`);
  const fileTail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([textPart, fileHeader, imageBuffer, fileTail]);

  return new Promise((resolve, reject) => {
    const req = https.request(`${TELEGRAM_API}/sendPhoto`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      },
      timeout: 15000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.ok) console.error('[Telegram] sendPhoto API error:', parsed.description);
          resolve(parsed);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', (err) => { console.error('[Telegram] sendPhoto error:', err.message); reject(err); });
    req.on('timeout', () => { req.destroy(); reject(new Error('Telegram sendPhoto timeout')); });
    req.write(body);
    req.end();
  });
}

/**
 * Long-poll for bot updates (incoming messages/commands)
 * @param {number} offset - Update ID offset (only get updates after this ID)
 * @param {number} timeout - Long-poll timeout in seconds
 */
async function getUpdates(offset = 0, timeout = 5) {
  if (!isConfigured()) return [];

  const url = `${TELEGRAM_API}/getUpdates?offset=${offset}&timeout=${timeout}&allowed_updates=["message"]`;

  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'GET',
      timeout: (timeout + 10) * 1000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.ok ? (parsed.result || []) : []);
        } catch (e) { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
    req.end();
  });
}

/**
 * Send a video file via Telegram Bot API (multipart/form-data)
 * @param {string} filePath - Absolute path to the video file
 * @param {string} caption - Video caption (optional, max 1024 chars)
 */
async function sendVideo(filePath, caption = '', parseMode = 'Markdown') {
  if (!isConfigured()) {
    console.warn('[Telegram] Not configured');
    return null;
  }
  const fs = require('fs');
  if (!fs.existsSync(filePath)) {
    console.warn(`[Telegram] sendVideo: file not found: ${filePath}`);
    return null;
  }

  const videoData = fs.readFileSync(filePath);
  const filename = require('path').basename(filePath);
  const boundary = '----TelegramBotBoundary' + Date.now();
  const parts = [];

  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${TELEGRAM_CHAT_ID}`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="parse_mode"\r\n\r\n${parseMode}`);
  if (caption) {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption.slice(0, 1024)}`);
  }

  const textPart = Buffer.from(parts.join('\r\n') + '\r\n');
  const fileHeader = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="${filename}"\r\nContent-Type: video/mp4\r\n\r\n`);
  const fileTail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([textPart, fileHeader, videoData, fileTail]);

  return new Promise((resolve, reject) => {
    const req = https.request(`${TELEGRAM_API}/sendVideo`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      },
      timeout: 60000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.ok) console.error('[Telegram] sendVideo API error:', parsed.description);
          resolve(parsed);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', (err) => { console.error('[Telegram] sendVideo error:', err.message); reject(err); });
    req.on('timeout', () => { req.destroy(); reject(new Error('Telegram sendVideo timeout')); });
    req.write(body);
    req.end();
  });
}

module.exports = {
  isConfigured,
  sendMessage,
  sendAlert,
  sendPhoto,
  sendVideo,
  getUpdates,
  sendDailyReport,
  sendWeeklyReport,
  sendApprovalRequest
};
