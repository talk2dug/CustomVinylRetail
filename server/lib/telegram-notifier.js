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
 * Send daily report
 */
async function sendDailyReport(report) {
  const text = `📊 *Daily Sales Agent Report — ${report.date || new Date().toISOString().slice(0, 10)}*\n\n` +
    `*Posts Published Today:* ${report.postsPublished || 0}\n` +
    (report.topPost ? `*Best Post:* ${report.topPost.name} (${report.topPost.engagement} engagements)\n` : '') +
    `\n*Engagement (7-day):*\n` +
    `• Total Likes: ${report.totalLikes || 0}\n` +
    `• Total Comments: ${report.totalComments || 0}\n` +
    `• Total Shares: ${report.totalShares || 0}\n` +
    `\n*Queue:* ${report.queueDepth || 0} posts pending (${report.queueDays || 0} days)\n` +
    (report.strategyNote ? `\n*Strategy:* ${report.strategyNote}` : '') +
    (report.alerts && report.alerts.length > 0 ? `\n\n*Alerts:*\n${report.alerts.map(a => `• ${a}`).join('\n')}` : '');
  return sendMessage(text);
}

/**
 * Send weekly strategy report
 */
async function sendWeeklyReport(report) {
  const text = `📈 *Weekly Strategy Report — ${report.dateRange || 'This Week'}*\n\n` +
    `*What Worked:*\n${(report.worked || ['No data yet']).map(w => `✅ ${w}`).join('\n')}\n\n` +
    `*What Didn't Work:*\n${(report.didntWork || ['No data yet']).map(w => `❌ ${w}`).join('\n')}\n\n` +
    `*Adjustments Made:*\n${(report.adjustments || ['None yet']).map(a => `🔄 ${a}`).join('\n')}\n\n` +
    `*Recommendations:*\n${(report.recommendations || ['Gathering data...']).map((r, i) => `${i + 1}. ${r}`).join('\n')}\n\n` +
    `*Next Week Plan:* ${report.nextWeekPlan || 'Continue current strategy'}`;
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

module.exports = {
  isConfigured,
  sendMessage,
  sendAlert,
  sendDailyReport,
  sendWeeklyReport,
  sendApprovalRequest
};
