/**
 * AI Print Monitor — Analyzes webcam snapshots for 3D print failures
 *
 * Uses Ollama vision (LLaVA) via GPU bridge with local fallback.
 * Checks every 45 seconds while a printer is actively printing.
 * Stores results in memory + DB for UI display and history.
 */

const ollamaClient = require('../lib/ollama-client');

const ANALYSIS_INTERVAL = 45000; // 45 seconds
const CONFIDENCE_ALERT_THRESHOLD = 0.7; // Alert if any issue confidence > 70%

// In-memory state
const monitorState = {
  results: {},    // printerId -> latest analysis result
  enabled: true,
  timer: null,
  analyzing: false,
  stats: { totalAnalyses: 0, issuesDetected: 0, lastAnalysis: null, errors: 0 }
};

// Reference to dependencies (set during init)
let getPrinterCache = null;
let telegramNotify = null;
let db = null;
let printServerUrl = null;
let apiKey = null;

const ANALYSIS_PROMPT = `You are a 3D print quality inspector analyzing a webcam image of an active 3D print.

Analyze the image and assess for these specific failure modes:

1. **Spaghetti** — filament not adhering, creating tangled mess of plastic strings
2. **Layer Shift** — visible horizontal displacement where layers don't align
3. **Warping** — corners or edges lifting from the print bed
4. **Stringing** — thin strings of filament between parts that shouldn't be connected
5. **Under-extrusion** — gaps, thin walls, or missing layers
6. **Bed Adhesion Failure** — print detaching from the build plate
7. **Blob/Zit** — excess material buildup in spots

For each issue, rate confidence 0.0 to 1.0 (0 = not present, 1 = clearly visible).

Also provide:
- **overall_quality**: 0.0 (total failure) to 1.0 (perfect print)
- **needs_attention**: true/false (should the operator check this print?)
- **summary**: One sentence describing the print status

Respond ONLY in this exact JSON format, no other text:
{"spaghetti":0.0,"layer_shift":0.0,"warping":0.0,"stringing":0.0,"under_extrusion":0.0,"bed_adhesion_failure":0.0,"blob":0.0,"overall_quality":0.0,"needs_attention":false,"summary":"description"}`;

/**
 * Initialize the print monitor
 * @param {object} options - { getCache, notify, db }
 */
function init(options = {}) {
  getPrinterCache = options.getCache || (() => ({ printers: [] }));
  telegramNotify = options.notify || null;
  db = options.db || null;
  printServerUrl = options.printServerUrl || process.env.PRINT_SERVER_URL || 'http://100.64.0.7:5000';
  apiKey = options.apiKey || process.env.INTERNAL_API_KEY || '';

  // Ensure DB table exists
  if (db && db.db) {
    db.db.prepare(`
      CREATE TABLE IF NOT EXISTS print_monitor_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        printer_id INTEGER NOT NULL,
        printer_name TEXT,
        analysis_json TEXT,
        overall_quality REAL,
        needs_attention INTEGER DEFAULT 0,
        summary TEXT,
        snapshot_base64 TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
    // Keep last 500 entries
    db.db.prepare('DELETE FROM print_monitor_log WHERE id NOT IN (SELECT id FROM print_monitor_log ORDER BY id DESC LIMIT 500)').run();
  }

  startMonitoring();
  console.log('[PrintMonitor] Initialized, checking every ' + (ANALYSIS_INTERVAL / 1000) + 's');
}

function startMonitoring() {
  if (monitorState.timer) clearInterval(monitorState.timer);
  monitorState.timer = setInterval(runAnalysisCycle, ANALYSIS_INTERVAL);
}

function stopMonitoring() {
  if (monitorState.timer) {
    clearInterval(monitorState.timer);
    monitorState.timer = null;
  }
}

/**
 * Fetch printers + snapshots directly from the Pi print server
 * This is the primary data source — no Electron client dependency
 */
async function fetchPrintersFromPi() {
  const headers = {};
  if (apiKey) headers['X-API-Key'] = apiKey;

  try {
    // Get printer list with live status
    const resp = await fetch(`${printServerUrl}/api/3d/printers?active=true`, {
      headers, signal: AbortSignal.timeout(10000)
    });
    if (!resp.ok) return [];
    const printers = await resp.json();

    // Filter to only printing printers, then fetch snapshots
    const printing = (Array.isArray(printers) ? printers : []).filter(p =>
      p.live_status && p.live_status.state === 'printing'
    );

    const results = [];
    for (const p of printing) {
      try {
        const snapResp = await fetch(`${printServerUrl}/api/3d/printers/${p.id}/snapshot`, {
          headers, signal: AbortSignal.timeout(8000)
        });
        if (snapResp.ok) {
          const data = await snapResp.json();
          results.push({
            id: p.id,
            name: p.name,
            state: 'printing',
            snapshot: data.snapshot, // base64
            progress: p.live_status.progress,
            filename: p.live_status.filename,
            temperatures: p.live_status.temperatures
          });
        }
      } catch (_) {
        // Skip printers where snapshot fails
      }
    }
    return results;
  } catch (err) {
    console.error('[PrintMonitor] Failed to fetch from print server:', err.message);
    return [];
  }
}

/**
 * Main analysis cycle — checks all actively printing printers
 * Pulls snapshots directly from Pi print server (no Electron dependency)
 */
async function runAnalysisCycle() {
  if (!monitorState.enabled || monitorState.analyzing) return;

  // Primary: fetch direct from Pi print server
  let activePrinters = await fetchPrintersFromPi();

  // Fallback: use Electron heartbeat cache if Pi unreachable
  if (!activePrinters.length) {
    const cache = getPrinterCache();
    if (cache && cache.printers) {
      activePrinters = cache.printers.filter(p => p.state === 'printing' && p.snapshot);
    }
  }

  if (!activePrinters.length) return;

  monitorState.analyzing = true;

  for (const printer of activePrinters) {
    try {
      const result = await analyzePrintSnapshot(printer);
      if (result) {
        monitorState.results[printer.id] = result;
        monitorState.stats.totalAnalyses++;
        monitorState.stats.lastAnalysis = new Date().toISOString();

        // Log to DB
        if (db && db.db) {
          try {
            db.db.prepare(`
              INSERT INTO print_monitor_log (printer_id, printer_name, analysis_json, overall_quality, needs_attention, summary)
              VALUES (?, ?, ?, ?, ?, ?)
            `).run(
              printer.id, printer.name,
              JSON.stringify(result.analysis),
              result.analysis.overall_quality,
              result.analysis.needs_attention ? 1 : 0,
              result.analysis.summary
            );
          } catch (_) {}
        }

        // Alert via Telegram if attention needed
        if (result.analysis.needs_attention && telegramNotify) {
          const highIssues = [];
          for (const [key, val] of Object.entries(result.analysis)) {
            if (typeof val === 'number' && val >= CONFIDENCE_ALERT_THRESHOLD && key !== 'overall_quality') {
              highIssues.push(`${key.replace(/_/g, ' ')}: ${Math.round(val * 100)}%`);
            }
          }
          if (highIssues.length) {
            monitorState.stats.issuesDetected++;
            try {
              await telegramNotify(
                `⚠️ *Print Alert — ${printer.name}*\n\n` +
                `Quality: ${Math.round(result.analysis.overall_quality * 100)}%\n` +
                `Issues: ${highIssues.join(', ')}\n` +
                `${result.analysis.summary}\n\n` +
                `_Check the print or view details in Print Station._`,
                printer.snapshot // Send the snapshot as photo
              );
            } catch (_) {}
          }
        }
      }
    } catch (err) {
      console.error(`[PrintMonitor] Error analyzing printer ${printer.name}:`, err.message);
      monitorState.stats.errors++;
    }
  }

  monitorState.analyzing = false;
}

/**
 * Analyze a single printer's snapshot
 */
async function analyzePrintSnapshot(printer) {
  if (!printer.snapshot) return null;

  // snapshot is a Buffer (from telegram-printer-bot cache)
  const base64 = Buffer.isBuffer(printer.snapshot)
    ? printer.snapshot.toString('base64')
    : printer.snapshot;

  try {
    const response = await ollamaClient.vision(ANALYSIS_PROMPT, [base64], {
      model: 'llava:13b',
      temperature: 0.2,
      maxTokens: 400,
      timeout: 60000
    });

    // Parse JSON from response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('[PrintMonitor] Could not parse JSON from vision response');
      return null;
    }

    const analysis = JSON.parse(jsonMatch[0]);

    return {
      printerId: printer.id,
      printerName: printer.name,
      analysis,
      timestamp: new Date().toISOString(),
      progress: printer.progress || null,
      filename: printer.filename || null
    };
  } catch (err) {
    console.error('[PrintMonitor] Vision analysis failed:', err.message);
    return null;
  }
}

/**
 * Manual analysis trigger — analyze a specific printer right now
 */
async function analyzeNow(printerId) {
  // Try Pi print server first
  const headers = {};
  if (apiKey) headers['X-API-Key'] = apiKey;
  let printer = null;

  try {
    const snapResp = await fetch(`${printServerUrl}/api/3d/printers/${printerId}/snapshot`, {
      headers, signal: AbortSignal.timeout(8000)
    });
    if (snapResp.ok) {
      const data = await snapResp.json();
      printer = { id: printerId, name: data.printer_name, snapshot: data.snapshot, state: 'printing' };
    }
  } catch (_) {}

  // Fallback to heartbeat cache
  if (!printer) {
    const cache = getPrinterCache();
    printer = (cache.printers || []).find(p => p.id === printerId || p.id === String(printerId));
  }

  if (!printer) throw new Error('Printer not found');
  if (!printer.snapshot) throw new Error('No snapshot available for this printer');

  const result = await analyzePrintSnapshot(printer);
  if (result) {
    monitorState.results[printerId] = result;
    monitorState.stats.totalAnalyses++;
    monitorState.stats.lastAnalysis = new Date().toISOString();

    if (db && db.db) {
      try {
        db.db.prepare(`
          INSERT INTO print_monitor_log (printer_id, printer_name, analysis_json, overall_quality, needs_attention, summary)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(printerId, printer.name, JSON.stringify(result.analysis), result.analysis.overall_quality, result.analysis.needs_attention ? 1 : 0, result.analysis.summary);
      } catch (_) {}
    }
  }
  return result;
}

/**
 * Get latest results for all printers
 */
function getResults() {
  return { ...monitorState.results };
}

/**
 * Get result for a specific printer
 */
function getResult(printerId) {
  return monitorState.results[printerId] || null;
}

/**
 * Get analysis history for a printer
 */
function getHistory(printerId, limit = 20) {
  if (!db || !db.db) return [];
  return db.db.prepare(
    'SELECT id, printer_id, printer_name, analysis_json, overall_quality, needs_attention, summary, created_at FROM print_monitor_log WHERE printer_id = ? ORDER BY id DESC LIMIT ?'
  ).all(printerId, limit);
}

/**
 * Get monitor status
 */
function getStatus() {
  return {
    enabled: monitorState.enabled,
    analyzing: monitorState.analyzing,
    stats: { ...monitorState.stats },
    activePrinters: Object.keys(monitorState.results).length,
    ollamaStatus: ollamaClient.getStatus()
  };
}

/**
 * Enable/disable monitoring
 */
function setEnabled(enabled) {
  monitorState.enabled = enabled;
  if (enabled && !monitorState.timer) startMonitoring();
  if (!enabled) stopMonitoring();
}

module.exports = {
  init,
  startMonitoring,
  stopMonitoring,
  analyzeNow,
  getResults,
  getResult,
  getHistory,
  getStatus,
  setEnabled,
  runAnalysisCycle
};
