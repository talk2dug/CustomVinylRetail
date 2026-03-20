/**
 * Telegram Printer Bot — Real-time 3D printer notifications + /printerstatus command
 *
 * Architecture:
 * - Server polls Pi print server every 30s for printer status + webcam snapshots
 * - Also accepts heartbeats from Electron app (legacy, optional)
 * - Caches data in memory for /printerstatus Telegram command
 * - Handles printer event notifications (started, paused, completed, etc.)
 * - Detects state transitions (idle→printing, printing→complete, etc.) and sends alerts
 */

const telegram = require('../lib/telegram-notifier');

// In-memory cache of printer statuses
let printerCache = {
  printers: [],   // [{ id, name, model, state, temps, progress, filename, printDuration, totalDuration, snapshot }]
  updatedAt: null
};

let pollingActive = false;
let updateOffset = 0;
let statusPollTimer = null;
let printServerUrl = null;
let internalApiKey = '';
// Track previous state per printer for transition detection
const prevPrinterStates = {};

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
    printer_online:  { icon: '🟢', title: 'Printer Online',   body: `${name} is back online` },
    // Inkjet events
    inkjet_started:   { icon: '🖨️', title: 'Inkjet Print Started',   body: `${name} started printing${fname ? ' ' + fname : ''}` },
    inkjet_completed: { icon: '✅', title: 'Inkjet Print Complete',   body: `${name} finished${fname ? ' ' + fname : ''}` },
    inkjet_failed:    { icon: '🚨', title: 'Inkjet Print Failed',    body: `${name}${msg ? ': ' + msg : ' encountered an error'}` },
    inkjet_cancelled: { icon: '❌', title: 'Inkjet Print Cancelled',  body: `${name} cancelled` },
    ink_low:          { icon: '🪫', title: 'Low Ink Alert',          body: `${name}${msg ? ': ' + msg : ' ink is running low'}` }
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

function getCache() {
  return {
    printers: printerCache.printers.map(p => ({
      ...p,
      snapshot: p.snapshot ? p.snapshot.toString('base64') : null
    })),
    updatedAt: printerCache.updatedAt
  };
}

// ============================================================================
// SERVER-SIDE STATUS POLLING (from Pi print server)
// ============================================================================

function mapTransition(prev, curr) {
  if (prev === curr) return null;
  if (curr === 'printing' && prev === 'paused') return 'print_resumed';
  if (curr === 'printing' && prev !== 'printing') return 'print_started';
  if (curr === 'complete') return 'print_completed';
  if (curr === 'paused') return 'print_paused';
  if (curr === 'error') return 'print_failed';
  if (curr === 'cancelled') return 'print_cancelled';
  if (curr === 'offline' && prev !== 'offline' && prev !== 'unknown') return 'printer_offline';
  if (prev === 'offline' && curr !== 'offline') return 'printer_online';
  return null;
}

async function pollPrintServer() {
  if (!printServerUrl) return;

  try {
    const headers = {};
    if (internalApiKey) headers['X-API-Key'] = internalApiKey;

    const resp = await fetch(`${printServerUrl}/api/3d/printers?active=true`, {
      headers, signal: AbortSignal.timeout(10000)
    });
    if (!resp.ok) return;

    const printers = await resp.json();
    if (!Array.isArray(printers)) return;

    const statuses = [];
    for (const p of printers) {
      const ls = p.live_status || {};
      const status = {
        id: p.id,
        name: p.name,
        model: p.model || '',
        state: ls.state || 'unknown',
        progress: ls.progress || 0,
        filename: ls.filename || '',
        printDuration: ls.print_duration || 0,
        totalDuration: ls.total_duration || 0,
        temperatures: ls.temperatures || null,
        snapshot: null
      };

      // Detect state transitions and send Telegram notifications
      const prevState = prevPrinterStates[p.id] || 'unknown';
      const event = mapTransition(prevState, status.state);
      if (event) {
        console.log(`[PrinterBot] State change: ${p.name} ${prevState} → ${status.state} (${event})`);
        try {
          await handlePrinterEvent({
            event,
            printer_name: p.name,
            printer_model: p.model,
            filename: status.filename,
            progress: status.progress,
            duration_min: status.printDuration ? Math.round(status.printDuration / 60) : 0,
            snapshot: null // snapshot fetched below
          });
        } catch (err) {
          console.warn(`[PrinterBot] Event notification failed for ${p.name}:`, err.message);
        }
      }
      prevPrinterStates[p.id] = status.state;

      // Fetch webcam snapshot
      try {
        const snapResp = await fetch(`${printServerUrl}/api/3d/printers/${p.id}/snapshot`, {
          headers, signal: AbortSignal.timeout(5000)
        });
        if (snapResp.ok) {
          const data = await snapResp.json();
          if (data.snapshot) {
            status.snapshot = Buffer.from(data.snapshot, 'base64');
          }
        }
      } catch (_) { /* webcam optional */ }

      statuses.push(status);
    }

    // Update cache
    printerCache.printers = statuses;
    printerCache.updatedAt = Date.now();

  } catch (err) {
    // Only log on first failure, not every 30s
    if (!pollPrintServer._lastError || Date.now() - pollPrintServer._lastError > 300000) {
      console.warn('[PrinterBot] Print server poll failed:', err.message);
      pollPrintServer._lastError = Date.now();
    }
  }
}

function startStatusPolling(options = {}) {
  printServerUrl = options.printServerUrl || process.env.PRINT_SERVER_URL || 'http://100.64.0.7:5000';
  internalApiKey = options.apiKey || process.env.INTERNAL_API_KEY || '';

  if (statusPollTimer) clearInterval(statusPollTimer);

  // Initial poll immediately
  pollPrintServer();
  // Then every 30 seconds
  statusPollTimer = setInterval(pollPrintServer, 30000);
  console.log(`[PrinterBot] Status polling started (${printServerUrl}, every 30s)`);
}

function stopStatusPolling() {
  if (statusPollTimer) {
    clearInterval(statusPollTimer);
    statusPollTimer = null;
  }
}

module.exports = {
  startPolling,
  stopPolling,
  startStatusPolling,
  stopStatusPolling,
  updateCache,
  handlePrinterEvent,
  getCache
};
