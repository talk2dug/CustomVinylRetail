/**
 * Telegram Printer Bot — Real-time 3D printer notifications + /printerstatus command
 *
 * Architecture:
 * - Electron app pushes printer status heartbeats (every 60s) with webcam snapshots
 * - This module caches that data in memory
 * - Polls Telegram for /printerstatus commands and responds with cached data
 * - Handles printer event notifications (started, paused, completed, etc.)
 */

const telegram = require('../lib/telegram-notifier');

// In-memory cache of printer statuses (pushed by Electron app heartbeat)
let printerCache = {
  printers: [],   // [{ id, name, model, state, temps, progress, filename, printDuration, totalDuration, snapshot }]
  updatedAt: null
};

let pollingActive = false;
let updateOffset = 0;

// ============================================================================
// CACHE
// ============================================================================

function updateCache(data) {
  if (!data || !Array.isArray(data.printers)) return;

  printerCache.printers = data.printers.map(p => ({
    ...p,
    // Convert base64 snapshot to Buffer if present
    snapshot: p.snapshot ? Buffer.from(p.snapshot, 'base64') : null
  }));
  printerCache.updatedAt = Date.now();
}

// ============================================================================
// FORMAT HELPERS
// ============================================================================

/** Escape Telegram legacy Markdown special chars in dynamic text */
function esc(str) {
  if (!str) return '';
  return String(str).replace(/([_*`\[])/g, '\\$1');
}

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatProgress(progress) {
  if (progress == null) return '0%';
  return `${Math.round(progress * 100)}%`;
}

function stateEmoji(state) {
  const map = {
    printing: '🟢 Printing',
    paused: '⏸️ Paused',
    complete: '✅ Complete',
    error: '🔴 Error',
    cancelled: '❌ Cancelled',
    standby: '⚪ Idle',
    offline: '🔌 Offline',
    unknown: '❓ Unknown'
  };
  return map[state] || map.unknown;
}

// ============================================================================
// /printerstatus COMMAND HANDLER
// ============================================================================

async function handlePrinterStatusCommand() {
  // Check if cache is fresh (< 2 minutes old)
  if (!printerCache.updatedAt || Date.now() - printerCache.updatedAt > 120000) {
    await telegram.sendMessage('⚠️ *Print Station Not Connected*\n\nNo recent data from the print station app. Make sure it is running.', 'Markdown');
    return;
  }

  const printers = printerCache.printers;
  if (!printers.length) {
    await telegram.sendMessage('ℹ️ No printers configured in the fleet.');
    return;
  }

  // Build status text for all printers
  const lines = printers.map(p => {
    const status = stateEmoji(p.state);
    let info = `🖨️ *${esc(p.name || 'Printer')}*${p.model ? ' (' + esc(p.model) + ')' : ''}\n`;
    info += `Status: ${status}\n`;

    if (p.state === 'printing' || p.state === 'paused') {
      if (p.filename) info += `📄 File: ${esc(p.filename)}\n`;
      info += `📊 Progress: ${formatProgress(p.progress)}\n`;
      const elapsed = formatDuration(p.printDuration);
      let remaining = '';
      if (p.progress > 0.01 && p.printDuration > 0) {
        const estTotal = p.printDuration / p.progress;
        const remSec = Math.max(0, estTotal - p.printDuration);
        remaining = ` | Remaining: ~${formatDuration(remSec)}`;
      }
      info += `🕐 Elapsed: ${elapsed}${remaining}\n`;
    }

    if (p.temps) {
      const ext = p.temps.extruder || {};
      const bed = p.temps.bed || {};
      info += `🌡️ Nozzle: ${Math.round(ext.current || 0)}°C/${Math.round(ext.target || 0)}°C | Bed: ${Math.round(bed.current || 0)}°C/${Math.round(bed.target || 0)}°C`;
    }

    if (p.state === 'standby' || p.state === 'unknown') {
      info += '\nNo active print';
    }

    return info;
  });

  const text = `🖨️ *Printer Fleet Status*\n\n${lines.join('\n\n')}`;
  await telegram.sendMessage(text, 'Markdown');

  // Send webcam snapshots
  for (const p of printers) {
    if (p.snapshot && Buffer.isBuffer(p.snapshot) && p.snapshot.length > 100) {
      try {
        await telegram.sendPhoto(p.snapshot, `📷 ${p.name || 'Printer'}`);
      } catch (err) {
        console.warn(`[PrinterBot] Failed to send snapshot for ${p.name}:`, err.message);
      }
    }
  }
}

// ============================================================================
// PRINTER EVENT NOTIFICATIONS
// ============================================================================

async function handlePrinterEvent(eventData) {
  const { event, printer_name, printer_model, filename, progress, duration_min, message, snapshot } = eventData;

  const name = esc(printer_name || 'Unknown Printer');
  const fname = esc(filename);
  const pct = progress != null ? `${Math.round(progress * 100)}%` : '';
  const dur = duration_min ? formatDuration(duration_min * 60) : '';
  const msg = esc(message);

  const templates = {
    print_started:   { icon: '🖨️', title: 'Print Started',   body: `${name} started printing${fname ? ' ' + fname : ''}` },
    print_paused:    { icon: '⏸️', title: 'Print Paused',    body: `${name} paused${pct ? ' at ' + pct : ''}` },
    print_resumed:   { icon: '▶️', title: 'Print Resumed',   body: `${name} resumed${pct ? ' at ' + pct : ''}` },
    print_completed: { icon: '✅', title: 'Print Complete',   body: `${name} finished${fname ? ' ' + fname : ''}${dur ? ' (' + dur + ')' : ''}` },
    print_failed:    { icon: '🚨', title: 'Print Failed',    body: `${name}${msg ? ': ' + msg : ' encountered an error'}` },
    print_cancelled: { icon: '❌', title: 'Print Cancelled',  body: `${name} cancelled${pct ? ' at ' + pct : ''}` },
    printer_offline: { icon: '🔌', title: 'Printer Offline',  body: `${name} is offline` },
    printer_online:  { icon: '🟢', title: 'Printer Online',   body: `${name} is back online` }
  };

  const tmpl = templates[event];
  if (!tmpl) {
    console.warn('[PrinterBot] Unknown event:', event);
    return;
  }

  const text = `${tmpl.icon} *${tmpl.title}*\n\n${tmpl.body}`;
  await telegram.sendMessage(text, 'Markdown');

  // Send snapshot if available
  if (snapshot) {
    try {
      const buf = typeof snapshot === 'string' ? Buffer.from(snapshot, 'base64') : snapshot;
      if (buf && buf.length > 100) {
        await telegram.sendPhoto(buf, `📷 ${name}`);
      }
    } catch (err) {
      console.warn('[PrinterBot] Failed to send event snapshot:', err.message);
    }
  }
}

// ============================================================================
// TELEGRAM BOT POLLING
// ============================================================================

async function startPolling() {
  if (!telegram.isConfigured()) {
    console.log('[PrinterBot] Telegram not configured, skipping bot polling');
    return;
  }

  pollingActive = true;
  console.log('[PrinterBot] Starting Telegram bot polling for /printerstatus commands');

  while (pollingActive) {
    try {
      const updates = await telegram.getUpdates(updateOffset, 10);

      for (const update of updates) {
        updateOffset = update.update_id + 1;

        const text = update.message?.text || '';
        const cmd = text.trim().toLowerCase();

        if (cmd === '/printerstatus' || cmd === '/printer_status' || cmd === '/status') {
          console.log('[PrinterBot] Received /printerstatus command');
          try {
            await handlePrinterStatusCommand();
          } catch (err) {
            console.error('[PrinterBot] Error handling /printerstatus:', err.message);
            try {
              await telegram.sendMessage('❌ Error fetching printer status: ' + err.message);
            } catch {}
          }
        }
      }
    } catch (err) {
      console.warn('[PrinterBot] Polling error:', err.message);
      // Wait before retrying on error
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

function stopPolling() {
  pollingActive = false;
}

module.exports = {
  startPolling,
  stopPolling,
  updateCache,
  handlePrinterEvent
};
