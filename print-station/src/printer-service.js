const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

class PrinterService {
  constructor({ fetch }) {
    this.fetch = fetch;
    this.connections = new Map();  // apiUrl -> { ws, reconnectTimer, reconnectDelay, failCount, callback }
    this.statusCache = new Map(); // apiUrl -> normalized status
    this.rawCache = new Map();    // apiUrl -> raw moonraker objects (for merging partials)
    this.pollTimers = new Map();  // apiUrl -> { timer, interval, callback }
  }

  // ---- Internal helpers ----

  _apiBase(apiUrl) {
    const base = apiUrl.startsWith('http') ? apiUrl : `http://${apiUrl}`;
    return base.replace(/\/+$/, '');
  }

  _wsUrl(apiUrl) {
    const stripped = apiUrl.replace(/^https?:\/\//, '');
    return `ws://${stripped}/websocket`;
  }

  async _get(apiUrl, endpoint) {
    const resp = await this.fetch(`${this._apiBase(apiUrl)}${endpoint}`, {
      signal: AbortSignal.timeout(10000)
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Moonraker GET ${endpoint}: ${resp.status} — ${body || resp.statusText}`);
    }
    return resp.json();
  }

  async _post(apiUrl, endpoint, body = null) {
    const opts = {
      method: 'POST',
      signal: AbortSignal.timeout(10000)
    };
    if (body) {
      opts.body = JSON.stringify(body);
      opts.headers = { 'Content-Type': 'application/json' };
    }
    const resp = await this.fetch(`${this._apiBase(apiUrl)}${endpoint}`, opts);
    if (!resp.ok) {
      const respBody = await resp.text().catch(() => '');
      throw new Error(`Moonraker POST ${endpoint}: ${resp.status} — ${respBody || resp.statusText}`);
    }
    return resp.json();
  }

  async _delete(apiUrl, endpoint) {
    const resp = await this.fetch(`${this._apiBase(apiUrl)}${endpoint}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(10000)
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Moonraker DELETE ${endpoint}: ${resp.status} — ${body || resp.statusText}`);
    }
    return resp.json();
  }

  // ---- Status normalization ----

  _normalizeStatus(rawObjects) {
    const printStats = rawObjects.print_stats || {};
    const extruder = rawObjects.extruder || {};
    const bed = rawObjects.heater_bed || {};
    const vsd = rawObjects.virtual_sdcard || {};
    const display = rawObjects.display_status || {};

    const progress = vsd.progress ?? display.progress ?? 0;
    const printDuration = printStats.print_duration || 0;

    // Layer info from print_stats.info (populated by SET_PRINT_STATS_INFO in G-code)
    const info = printStats.info || {};

    return {
      state: printStats.state || 'unknown',
      temperatures: {
        extruder: { current: extruder.temperature || 0, target: extruder.target || 0 },
        bed: { current: bed.temperature || 0, target: bed.target || 0 }
      },
      progress,
      filename: printStats.filename || null,
      printDuration,
      totalDuration: printStats.total_duration || 0,
      filamentUsed: printStats.filament_used || 0,
      message: display.message || printStats.message || '',
      currentLayer: info.current_layer || 0,
      totalLayers: info.total_layer || 0,
      timestamp: Date.now()
    };
  }

  _mergeRawCache(apiUrl, partial) {
    const existing = this.rawCache.get(apiUrl) || {};
    for (const [key, value] of Object.entries(partial)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        existing[key] = { ...(existing[key] || {}), ...value };
      } else {
        existing[key] = value;
      }
    }
    this.rawCache.set(apiUrl, existing);
    const normalized = this._normalizeStatus(existing);
    this.statusCache.set(apiUrl, normalized);
    return normalized;
  }

  // ---- REST API methods ----

  async getPrinterStatus(apiUrl) {
    const data = await this._get(apiUrl,
      '/printer/objects/query?heater_bed&extruder&print_stats&display_status&virtual_sdcard&toolhead'
    );
    const objects = data?.result?.status || {};
    this.rawCache.set(apiUrl, objects);
    const normalized = this._normalizeStatus(objects);
    this.statusCache.set(apiUrl, normalized);
    return normalized;
  }

  async getPrinterInfo(apiUrl) {
    const data = await this._get(apiUrl, '/printer/info');
    return data?.result || data;
  }

  /**
   * Query the printer's build volume via Moonraker's toolhead object.
   * Returns { width, depth, height } in mm parsed from axis_minimum / axis_maximum.
   * Falls back to configfile settings if toolhead data is incomplete.
   */
  async getBuildVolume(apiUrl) {
    try {
      // Primary: query toolhead for axis limits
      const data = await this._get(apiUrl,
        '/printer/objects/query?toolhead&configfile'
      );
      const objects = data?.result?.status || {};
      const toolhead = objects.toolhead || {};
      const configfile = objects.configfile || {};

      // toolhead.axis_minimum = [x_min, y_min, z_min, e_min]
      // toolhead.axis_maximum = [x_max, y_max, z_max, e_max]
      const axisMin = toolhead.axis_minimum;
      const axisMax = toolhead.axis_maximum;

      if (Array.isArray(axisMin) && Array.isArray(axisMax) && axisMin.length >= 3 && axisMax.length >= 3) {
        const width = Math.round(axisMax[0] - axisMin[0]);
        const depth = Math.round(axisMax[1] - axisMin[1]);
        const height = Math.round(axisMax[2] - axisMin[2]);

        if (width > 0 && depth > 0 && height > 0) {
          console.log(`[PrinterService] Build volume from toolhead: ${width}x${depth}x${height}`);
          return { width, depth, height, source: 'toolhead' };
        }
      }

      // Fallback: parse configfile stepper settings
      const settings = configfile.settings || configfile.config || {};
      const stepperX = settings.stepper_x || {};
      const stepperY = settings.stepper_y || {};
      const stepperZ = settings.stepper_z || {};

      const xMax = stepperX.position_max;
      const yMax = stepperY.position_max;
      const zMax = stepperZ.position_max;
      const xMin = stepperX.position_min || 0;
      const yMin = stepperY.position_min || 0;
      const zMin = stepperZ.position_min || 0;

      if (xMax != null && yMax != null && zMax != null) {
        const width = Math.round(xMax - xMin);
        const depth = Math.round(yMax - yMin);
        const height = Math.round(zMax - zMin);

        if (width > 0 && depth > 0 && height > 0) {
          console.log(`[PrinterService] Build volume from configfile: ${width}x${depth}x${height}`);
          return { width, depth, height, source: 'configfile' };
        }
      }

      console.warn('[PrinterService] Could not determine build volume from printer');
      return null;
    } catch (err) {
      console.warn('[PrinterService] getBuildVolume error:', err.message);
      return null;
    }
  }

  async getServerInfo(apiUrl) {
    const data = await this._get(apiUrl, '/server/info');
    return data?.result || data;
  }

  async uploadGcode(apiUrl, filePath) {
    const form = new FormData();
    form.append('file', fs.createReadStream(filePath), path.basename(filePath));

    const resp = await this.fetch(`${this._apiBase(apiUrl)}/server/files/upload`, {
      method: 'POST',
      body: form,
      headers: form.getHeaders(),
      signal: AbortSignal.timeout(120000) // 2 min for large files
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Upload failed: ${resp.status} — ${body || resp.statusText}`);
    }
    return resp.json();
  }

  async startPrint(apiUrl, filename) {
    try {
      return await this._post(apiUrl, `/printer/print/start?filename=${encodeURIComponent(filename)}`);
    } catch (err) {
      const msg = err.message || '';

      // 10101: "已存在打印任务" — stale print job blocking new one.
      // Check if printer is actually idle, cancel stale job, retry.
      if (msg.includes('10101') || msg.includes('\u5df2\u5b58\u5728\u6253\u5370\u4efb\u52a1')) {
        console.log(`[PrinterService] Print start blocked by existing job (10101), checking printer state...`);
        try {
          const statusData = await this._get(apiUrl, '/printer/objects/query?print_stats');
          const printState = statusData?.result?.status?.print_stats?.state || 'unknown';
          console.log(`[PrinterService] Printer state: ${printState}`);

          if (printState === 'printing' || printState === 'paused') {
            throw new Error(
              `Printer is currently ${printState}. Cancel or finish the current job before starting a new one. ` +
              `The file has been uploaded — you can start it after the current job completes.`
            );
          }

          // Printer is idle/standby/complete/error/cancelled — cancel stale job and retry
          console.log(`[PrinterService] Cancelling stale job (state: ${printState}) and retrying...`);
          await this._post(apiUrl, '/printer/print/cancel');

          // Brief pause to let firmware clear state
          await new Promise(r => setTimeout(r, 1500));

          const retryResult = await this._post(apiUrl, `/printer/print/start?filename=${encodeURIComponent(filename)}`);
          console.log(`[PrinterService] Retry after cancel succeeded`);
          return retryResult;
        } catch (retryErr) {
          // If retry also fails, try SDCARD_PRINT_BEGIN as last resort
          console.warn(`[PrinterService] Retry after cancel failed: ${retryErr.message}, trying SDCARD_PRINT_BEGIN...`);
          try {
            await this.sendGcode(apiUrl, `SDCARD_PRINT_BEGIN FILENAME="${filename}"`, 15000);
            console.log(`[PrinterService] SDCARD_PRINT_BEGIN fallback succeeded`);
            return { result: 'ok', fallback: 'SDCARD_PRINT_BEGIN' };
          } catch (fallbackErr) {
            throw new Error(
              `G-code uploaded but could not start print: existing job blocked it (10101). ` +
              `Cancel + retry failed: ${retryErr.message}. ` +
              `The file is on the printer — you can start it from the printer screen.`
            );
          }
        }
      }

      // Rinkhals firmware routes print-start through MQTT, which fails with
      // "filament hub not exist" (code 11503) if no ACE hub is connected but
      // the [mmu_ace] section is enabled in moonraker config.
      // Fallback: send SDCARD_PRINT_BEGIN directly via Klipper gcode script
      // endpoint to bypass Rinkhals MQTT interception.
      if (msg.includes('filament hub')) {
        console.log(`[PrinterService] Moonraker print/start failed with hub error, trying SDCARD_PRINT_BEGIN fallback for "${filename}"...`);
        try {
          await this.sendGcode(apiUrl, `SDCARD_PRINT_BEGIN FILENAME="${filename}"`, 15000);
          console.log(`[PrinterService] SDCARD_PRINT_BEGIN fallback succeeded`);
          return { result: 'ok', fallback: 'SDCARD_PRINT_BEGIN' };
        } catch (fallbackErr) {
          console.warn(`[PrinterService] SDCARD_PRINT_BEGIN fallback also failed:`, fallbackErr.message);
          throw new Error(
            `G-code uploaded but failed to start print. ` +
            `Moonraker start failed ("filament hub" error) and Klipper SDCARD_PRINT_BEGIN fallback also failed: ${fallbackErr.message}. ` +
            `The file is on the printer — you can start it from the printer screen.`
          );
        }
      }
      throw err;
    }
  }

  async pausePrint(apiUrl) {
    return this._post(apiUrl, '/printer/print/pause');
  }

  async resumePrint(apiUrl) {
    return this._post(apiUrl, '/printer/print/resume');
  }

  async cancelPrint(apiUrl) {
    return this._post(apiUrl, '/printer/print/cancel');
  }

  async emergencyStop(apiUrl) {
    return this._post(apiUrl, '/printer/emergency_stop');
  }

  async sendGcode(apiUrl, command, timeoutMs = 10000) {
    const opts = {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs)
    };
    const resp = await this.fetch(
      `${this._apiBase(apiUrl)}/printer/gcode/script?script=${encodeURIComponent(command)}`,
      opts
    );
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Moonraker gcode "${command}": ${resp.status} — ${body || 'no details'}`);
    }
    return resp.json();
  }

  /**
   * Poll the printer until it is truly idle — not processing any G-code.
   *
   * Uses Klipper's `idle_timeout` object which reports:
   *   "Printing" — G-code commands are actively being processed (includes G28, BED_MESH_CALIBRATE, etc.)
   *   "Ready"    — printer is idle, heaters still on (idle timeout hasn't fired yet)
   *   "Idle"     — printer has been idle long enough that idle timeout fired (heaters off)
   *
   * This is more reliable than `print_stats.state` which only reflects print-job state
   * and stays "standby" during standalone G-code commands like homing and leveling.
   *
   * @param {string} apiUrl
   * @param {number} timeoutMs  Max time to wait (default 10 minutes)
   * @param {number} pollMs     Polling interval (default 2 seconds)
   * @returns {Promise<string>} The idle_timeout state when ready
   */
  async waitForReady(apiUrl, timeoutMs = 600000, pollMs = 2000) {
    const start = Date.now();

    // Short initial delay — give Klipper a moment to start processing the command
    // so we don't read "Ready" before the command has been picked up
    await new Promise(r => setTimeout(r, 1500));

    while (Date.now() - start < timeoutMs) {
      try {
        const data = await this._get(apiUrl,
          '/printer/objects/query?idle_timeout&print_stats'
        );
        const objects = data?.result?.status || {};
        const idleState = objects.idle_timeout?.state || 'unknown';
        const printState = (objects.print_stats?.state || 'standby').toLowerCase();

        // "Printing" means Klipper is actively processing G-code (any command, not just a print job)
        // Also check print_stats in case we're mid-print-job (belt-and-suspenders)
        const busy = idleState === 'Printing' || printState === 'printing';

        if (!busy) {
          console.log(`[PrinterService] Printer ready (idle_timeout: ${idleState}, print_stats: ${printState})`);
          return idleState;
        }

        console.log(`[PrinterService] Waiting for printer... (idle_timeout: ${idleState}, print_stats: ${printState})`);
      } catch (err) {
        console.warn('[PrinterService] Status poll error during waitForReady:', err.message);
      }

      await new Promise(r => setTimeout(r, pollMs));
    }

    // Timed out but don't throw — let the caller decide what to do
    console.warn(`[PrinterService] waitForReady timed out after ${timeoutMs / 1000}s`);
    return 'timeout';
  }

  /**
   * Run bed leveling on an Anycubic Kobra 3 / Kobra 3 V2 printer BEFORE
   * starting a print.
   *
   * The Anycubic Go-Klipper firmware blocks all probing during SD-card
   * prints, so leveling must happen via Moonraker API while idle.
   *
   * BED_MESH_CALIBRATE is a firmware macro that handles the full leviQ3
   * sequence: heat bed to 60 °C + nozzle to 170 °C, wipe nozzle, cool
   * nozzle to 140 °C for strain-gauge probing, probe 5×5 grid, then
   * TURN_OFF_HEATERS + SAVE_CONFIG.  SAVE_CONFIG persists the fresh
   * mesh to disk (the Go firmware does NOT restart on SAVE_CONFIG).
   *
   * After this method returns, the printer's heaters are off but a fresh
   * bed mesh is saved and active.  The print's start G-code will heat to
   * print temperatures normally.
   *
   * @param {string} apiUrl  Moonraker base URL (e.g. http://192.168.0.120:7125)
   */
  async runBedLeveling(apiUrl) {
    console.log(`[PrinterService] Starting pre-print bed leveling on ${apiUrl}...`);

    // Home first, then run the firmware's full leveling macro.
    // BED_MESH_CALIBRATE handles: heating → wiping → probing → save.
    // The full sequence takes ~3–5 min depending on preheat state.
    await this.sendGcode(apiUrl, 'G28\nBED_MESH_CALIBRATE', 600000);

    // Ensure all queued G-code has finished executing before returning.
    // The API may return before the macro's sub-commands complete.
    await this.waitForReady(apiUrl, 600000, 3000);

    console.log(`[PrinterService] Bed leveling complete on ${apiUrl}`);
  }

  /**
   * Download a G-code file from the printer via Moonraker.
   * Returns the file content as a Buffer.
   */
  async downloadGcode(apiUrl, filename) {
    const resp = await this.fetch(
      `${this._apiBase(apiUrl)}/server/files/gcodes/${encodeURIComponent(filename)}`,
      { signal: AbortSignal.timeout(120000) }
    );
    if (!resp.ok) {
      throw new Error(`Failed to download "${filename}": ${resp.status}`);
    }
    return Buffer.from(await resp.arrayBuffer());
  }

  // ---- Webcam ----

  async getWebcamUrls(apiUrl) {
    const base = this._apiBase(apiUrl);
    // Strip port from base to get the host (webcam is often on port 8080 or proxied)
    const urlObj = new URL(base);
    const host = urlObj.hostname;

    try {
      const data = await this._get(apiUrl, '/server/webcams/list');
      const webcams = data?.result?.webcams || [];
      if (webcams.length) {
        const cam = webcams.find(w => w.enabled) || webcams[0];
        // Resolve relative URLs against the printer host
        const resolveUrl = (url) => {
          if (!url) return null;
          if (url.startsWith('http://') || url.startsWith('https://')) return url;
          // Relative path — resolve against printer host (port 80)
          return `http://${host}${url.startsWith('/') ? '' : '/'}${url}`;
        };
        return {
          snapshot: resolveUrl(cam.snapshot_url),
          stream: resolveUrl(cam.stream_url),
          rotation: cam.rotation || 0,
          flipH: cam.flip_horizontal || false,
          flipV: cam.flip_vertical || false
        };
      }
    } catch (_) {
      // Webcam API not available, fall back to defaults
    }

    // Fallback: try common mjpg-streamer URLs
    return {
      snapshot: `http://${host}:8080/?action=snapshot`,
      stream: `http://${host}:8080/?action=stream`,
      rotation: 0,
      flipH: false,
      flipV: false
    };
  }

  async listFiles(apiUrl, root = 'gcodes') {
    const data = await this._get(apiUrl, `/server/files/list?root=${encodeURIComponent(root)}`);
    return data?.result || [];
  }

  async deleteFile(apiUrl, filename, root = 'gcodes') {
    return this._delete(apiUrl, `/server/files/${root}/${encodeURIComponent(filename)}`);
  }

  // ---- WebSocket real-time ----

  connectWebSocket(apiUrl, onStatusUpdate) {
    // Close existing connection if any
    this.disconnectWebSocket(apiUrl);

    const conn = {
      ws: null,
      reconnectTimer: null,
      reconnectDelay: 2000,
      failCount: 0,
      callback: onStatusUpdate
    };
    this.connections.set(apiUrl, conn);

    this._doConnect(apiUrl, conn);
  }

  _doConnect(apiUrl, conn) {
    const wsUrl = this._wsUrl(apiUrl);

    try {
      const ws = new WebSocket(wsUrl, { handshakeTimeout: 10000 });
      conn.ws = ws;

      ws.on('open', () => {
        console.log(`[Fleet] WS connected: ${apiUrl}`);
        conn.failCount = 0;
        conn.reconnectDelay = 2000;

        // Subscribe to printer status objects
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          method: 'printer.objects.subscribe',
          params: {
            objects: {
              heater_bed: null,
              extruder: null,
              print_stats: null,
              display_status: null,
              virtual_sdcard: null,
              toolhead: null
            }
          },
          id: 1
        }));
      });

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());

          // Initial subscription response contains full state
          if (msg.id === 1 && msg.result?.status) {
            const normalized = this._mergeRawCache(apiUrl, msg.result.status);
            if (conn.callback) conn.callback(apiUrl, normalized);
          }

          // Real-time partial updates
          if (msg.method === 'notify_status_update' && Array.isArray(msg.params)) {
            const partial = msg.params[0] || {};
            const normalized = this._mergeRawCache(apiUrl, partial);
            if (conn.callback) conn.callback(apiUrl, normalized);
          }
        } catch (_) {}
      });

      ws.on('close', (code) => {
        console.log(`[Fleet] WS closed (${code}): ${apiUrl}`);
        conn.ws = null;
        this._scheduleReconnect(apiUrl, conn);
      });

      ws.on('error', (err) => {
        console.warn(`[Fleet] WS error: ${apiUrl}:`, err.message);
        conn.failCount++;
        if (conn.failCount >= 3 && conn.callback) {
          conn.callback(apiUrl, { state: 'offline', timestamp: Date.now() });
        }
      });
    } catch (err) {
      console.warn(`[Fleet] WS connect failed: ${apiUrl}:`, err.message);
      conn.failCount++;
      this._scheduleReconnect(apiUrl, conn);
    }
  }

  _scheduleReconnect(apiUrl, conn) {
    if (conn.reconnectTimer) return;
    if (!this.connections.has(apiUrl)) return; // was intentionally disconnected

    conn.reconnectTimer = setTimeout(() => {
      conn.reconnectTimer = null;
      if (this.connections.has(apiUrl)) {
        console.log(`[Fleet] WS reconnecting: ${apiUrl} (delay: ${conn.reconnectDelay}ms)`);
        this._doConnect(apiUrl, conn);
        // Exponential backoff, max 30s
        conn.reconnectDelay = Math.min(conn.reconnectDelay * 2, 30000);
      }
    }, conn.reconnectDelay);
  }

  disconnectWebSocket(apiUrl) {
    const conn = this.connections.get(apiUrl);
    if (!conn) return;

    if (conn.reconnectTimer) {
      clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = null;
    }
    if (conn.ws) {
      try { conn.ws.close(); } catch (_) {}
      conn.ws = null;
    }
    this.connections.delete(apiUrl);
  }

  // ---- Polling fallback ----

  startPolling(apiUrl, onStatusUpdate, interval = 5000) {
    this.stopPolling(apiUrl);

    const poll = async () => {
      try {
        const status = await this.getPrinterStatus(apiUrl);
        const entry = this.pollTimers.get(apiUrl);
        if (entry) entry.failCount = 0;
        onStatusUpdate(apiUrl, status);
      } catch (err) {
        const entry = this.pollTimers.get(apiUrl);
        if (entry) {
          entry.failCount = (entry.failCount || 0) + 1;
          if (entry.failCount >= 3) {
            onStatusUpdate(apiUrl, { state: 'offline', timestamp: Date.now(), error: err.message });
          }
        }
      }
    };

    const timer = setInterval(poll, interval);
    this.pollTimers.set(apiUrl, { timer, interval, callback: onStatusUpdate, failCount: 0 });

    // Initial poll immediately
    poll();
  }

  stopPolling(apiUrl) {
    const entry = this.pollTimers.get(apiUrl);
    if (entry) {
      clearInterval(entry.timer);
      this.pollTimers.delete(apiUrl);
    }
  }

  updatePollRate(apiUrl, isPrinting) {
    const entry = this.pollTimers.get(apiUrl);
    if (!entry) return;
    const newInterval = isPrinting ? 2000 : 5000;
    if (entry.interval === newInterval) return;

    clearInterval(entry.timer);
    entry.interval = newInterval;
    entry.timer = setInterval(async () => {
      try {
        const status = await this.getPrinterStatus(apiUrl);
        entry.failCount = 0;
        if (entry.callback) entry.callback(apiUrl, status);
      } catch (err) {
        entry.failCount = (entry.failCount || 0) + 1;
        if (entry.failCount >= 3 && entry.callback) {
          entry.callback(apiUrl, { state: 'offline', timestamp: Date.now(), error: err.message });
        }
      }
    }, newInterval);
    this.pollTimers.set(apiUrl, entry);
  }

  // ---- Cached status ----

  getCachedStatus(apiUrl) {
    return this.statusCache.get(apiUrl) || null;
  }

  // ---- Cleanup ----

  disconnectAll() {
    for (const apiUrl of this.connections.keys()) {
      this.disconnectWebSocket(apiUrl);
    }
    for (const apiUrl of this.pollTimers.keys()) {
      this.stopPolling(apiUrl);
    }
    this.statusCache.clear();
    this.rawCache.clear();
  }
}

module.exports = { PrinterService };
