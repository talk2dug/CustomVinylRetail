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
    return this._post(apiUrl, `/printer/print/start?filename=${encodeURIComponent(filename)}`);
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
   * Home all axes and run bed mesh calibration, then start printing.
   * Moonraker queues G-code commands, so we send them in sequence with
   * generous timeouts since homing/leveling can take a while.
   */
  async homeAndPrint(apiUrl, filename, aceSlot = null) {
    // Select ACE tool before homing if specified
    if (aceSlot != null && aceSlot >= 0 && aceSlot <= 3) {
      console.log(`[PrinterService] Selecting ACE slot T${aceSlot}...`);
      try {
        await this.sendGcode(apiUrl, `T${aceSlot}`, 30000);
      } catch (aceErr) {
        // Printer may not have an ACE/multi-color hub — log warning and continue
        console.warn(`[PrinterService] ACE tool change T${aceSlot} failed (printer may not have a filament hub): ${aceErr.message}`);
      }
    }

    console.log('[PrinterService] Homing all axes...');
    await this.sendGcode(apiUrl, 'G28', 60000); // 60s for homing

    console.log('[PrinterService] Running bed mesh calibration...');
    try {
      await this.sendGcode(apiUrl, 'BED_MESH_CALIBRATE', 120000); // 2min for bed mesh
    } catch (meshErr) {
      // Some printers may not have bed mesh configured — log and continue
      console.log('[PrinterService] BED_MESH_CALIBRATE not available or failed, skipping:', meshErr.message);
    }

    console.log('[PrinterService] Starting print:', filename);
    return this.startPrint(apiUrl, filename);
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
