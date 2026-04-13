/**
 * Disk Watcher — monitors root partition usage and auto-cleans
 *
 * Runs every 30 minutes. If root partition usage exceeds threshold:
 * 1. Cleans safe targets (logs, caches, old backups)
 * 2. Sends Telegram alert if still above threshold after cleaning
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHECK_INTERVAL = 30 * 60 * 1000; // 30 minutes
const WARN_THRESHOLD_PCT = 75;          // Start cleaning at 75%
const ALERT_THRESHOLD_PCT = 85;         // Telegram alert at 85%
const TARGET_PCT = 70;                  // Try to get below 70%

let telegramNotify = null;
let timer = null;

function init(options = {}) {
  telegramNotify = options.notify || null;
  timer = setInterval(check, CHECK_INTERVAL);
  // Initial check after 60s
  setTimeout(check, 60000);
  console.log(`[DiskWatcher] Initialized — checking every ${CHECK_INTERVAL / 60000}min, warn at ${WARN_THRESHOLD_PCT}%, alert at ${ALERT_THRESHOLD_PCT}%`);
}

function getDiskUsage() {
  try {
    const output = execSync("df / | tail -1", { encoding: 'utf8' });
    const parts = output.trim().split(/\s+/);
    return {
      total: parseInt(parts[1]) * 1024,
      used: parseInt(parts[2]) * 1024,
      available: parseInt(parts[3]) * 1024,
      pct: parseInt(parts[4])
    };
  } catch (_) {
    return null;
  }
}

function formatBytes(bytes) {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + 'GB';
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(0) + 'MB';
  return (bytes / 1024).toFixed(0) + 'KB';
}

/**
 * Auto-clean safe targets in priority order
 */
function autoClean() {
  const actions = [];

  // 1. APT cache
  try {
    const before = getDiskUsage();
    execSync('sudo apt-get clean 2>/dev/null', { timeout: 10000 });
    execSync('sudo rm -rf /var/lib/apt/lists/* 2>/dev/null', { timeout: 10000 });
    const after = getDiskUsage();
    if (before && after) {
      const freed = before.used - after.used;
      if (freed > 1048576) actions.push(`APT cache: ${formatBytes(freed)}`);
    }
  } catch (_) {}

  // 2. Journal logs
  try {
    execSync('sudo journalctl --vacuum-size=20M 2>/dev/null', { timeout: 10000 });
    actions.push('Journal vacuumed to 20MB');
  } catch (_) {}

  // 3. Old log files
  try {
    execSync('sudo find /var/log -name "*.gz" -delete 2>/dev/null', { timeout: 5000 });
    execSync('sudo find /var/log -name "*.1" -delete 2>/dev/null', { timeout: 5000 });
    execSync('sudo truncate -s 0 /var/log/btmp 2>/dev/null', { timeout: 5000 });
    execSync('sudo truncate -s 0 /var/log/nginx/access.log 2>/dev/null', { timeout: 5000 });
    execSync('sudo truncate -s 0 /var/log/nginx/error.log 2>/dev/null', { timeout: 5000 });
    actions.push('Old logs cleaned');
  } catch (_) {}

  // 4. Snapd cache
  try {
    execSync('sudo rm -rf /var/lib/snapd/cache/* 2>/dev/null', { timeout: 5000 });
    actions.push('Snap cache cleaned');
  } catch (_) {}

  // 5. NPM cache
  try {
    const npmCache = path.join(process.env.HOME || '/home/ubuntu', '.npm', '_cacache');
    if (fs.existsSync(npmCache)) {
      execSync(`rm -rf "${npmCache}" 2>/dev/null`, { timeout: 10000 });
      actions.push('NPM cache cleaned');
    }
  } catch (_) {}

  // 6. DB backups — keep only 5 most recent
  try {
    const backupDir = path.resolve(__dirname, '..', '..', 'data', 'backups');
    if (fs.existsSync(backupDir)) {
      const files = fs.readdirSync(backupDir)
        .filter(f => f.endsWith('.db'))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(backupDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      const toRemove = files.slice(5);
      let freed = 0;
      for (const f of toRemove) {
        const fp = path.join(backupDir, f.name);
        freed += fs.statSync(fp).size;
        fs.unlinkSync(fp);
      }
      if (freed > 0) actions.push(`DB backups: removed ${toRemove.length} old, freed ${formatBytes(freed)}`);
    }
  } catch (_) {}

  // 7. Temp files older than 1 day
  try {
    execSync('find /tmp -type f -atime +1 -delete 2>/dev/null', { timeout: 5000 });
    actions.push('Old temp files cleaned');
  } catch (_) {}

  // 8. PM2 logs (can grow large)
  try {
    const pm2LogDir = path.join(process.env.HOME || '/home/ubuntu', '.pm2', 'logs');
    if (fs.existsSync(pm2LogDir)) {
      const logFiles = fs.readdirSync(pm2LogDir).filter(f => f.endsWith('.log'));
      let totalSize = 0;
      for (const f of logFiles) {
        const fp = path.join(pm2LogDir, f);
        const stat = fs.statSync(fp);
        if (stat.size > 50 * 1024 * 1024) { // Truncate logs over 50MB
          fs.truncateSync(fp, 1024 * 1024); // Keep last 1MB
          totalSize += stat.size;
        }
      }
      if (totalSize > 0) actions.push(`PM2 logs truncated: ${formatBytes(totalSize)}`);
    }
  } catch (_) {}

  // 9. eBay spam file
  try {
    const ebayFile = path.resolve(__dirname, '..', '..', 'data', 'ebay-account-deletions.jsonl');
    if (fs.existsSync(ebayFile)) {
      const stat = fs.statSync(ebayFile);
      if (stat.size > 1048576) { // Over 1MB
        fs.writeFileSync(ebayFile, '');
        actions.push(`eBay deletions log: ${formatBytes(stat.size)}`);
      }
    }
  } catch (_) {}

  return actions;
}

function check() {
  const usage = getDiskUsage();
  if (!usage) return;

  if (usage.pct >= WARN_THRESHOLD_PCT) {
    console.log(`[DiskWatcher] Root at ${usage.pct}% (${formatBytes(usage.available)} free) — running auto-clean...`);
    const actions = autoClean();
    const after = getDiskUsage();

    if (actions.length) {
      console.log(`[DiskWatcher] Cleaned: ${actions.join(', ')}`);
    }

    if (after) {
      console.log(`[DiskWatcher] After clean: ${after.pct}% (${formatBytes(after.available)} free)`);

      if (after.pct >= ALERT_THRESHOLD_PCT && telegramNotify) {
        telegramNotify(
          `⚠️ *Disk Space Alert*\n\n` +
          `Root partition at *${after.pct}%* (${formatBytes(after.available)} free)\n` +
          `Auto-clean ran but couldn't get below ${ALERT_THRESHOLD_PCT}%\n\n` +
          `Actions taken:\n${actions.map(a => `• ${a}`).join('\n') || '• None available'}\n\n` +
          `_Manual intervention may be needed._`
        ).catch(() => {});
      }
    }
  }
}

function getStatus() {
  const usage = getDiskUsage();
  return {
    usage,
    thresholds: { warn: WARN_THRESHOLD_PCT, alert: ALERT_THRESHOLD_PCT, target: TARGET_PCT },
    checkInterval: CHECK_INTERVAL / 60000 + ' minutes'
  };
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { init, check, getStatus, stop };
