/**
 * Pi-side Timelapse Capture Module
 *
 * Runs on the Pi print server alongside printer-service.js.
 * Hooks into the WebSocket status callback to detect layer changes
 * in real-time, waits for head to park, then captures webcam snapshot.
 *
 * Frames are stored locally on the Pi at /home/pi/print-server/data/timelapse/
 * The VPS downloads frames when the print completes.
 */

const fs = require('fs');
const path = require('path');

const TIMELAPSE_DIR = path.join(__dirname, 'data', 'timelapse');
const PARK_DELAY_MS = 1500; // Wait for head to reach park position after layer change

// Active timelapse sessions keyed by printer api_url
const sessions = {};

/**
 * Initialize timelapse capture for a printer service instance.
 * Call this from server.js after printerService is set up.
 */
function init(printerService) {
  // Ensure timelapse directory exists
  fs.mkdirSync(TIMELAPSE_DIR, { recursive: true });

  // Hook into the status update callback
  const originalCallback = printerService._onStatusUpdate;

  return {
    /**
     * Handle a status update from the WebSocket subscription.
     * Called from server.js's onStatusUpdate callback.
     */
    onStatusUpdate(apiUrl, status, printerInfo) {
      if (!status || !printerInfo) return;

      const printerId = printerInfo.id;
      const printerName = printerInfo.name;
      const state = status.state;
      const currentLayer = status.currentLayer || 0;

      // Start session when printing begins
      if (state === 'printing' && !sessions[apiUrl]) {
        const filename = status.filename || 'unknown';
        const safeName = `${filename.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60)}_${printerName.replace(/\s+/g, '_')}_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
        const sessionDir = path.join(TIMELAPSE_DIR, safeName);
        const framesDir = path.join(sessionDir, 'frames');
        fs.mkdirSync(framesDir, { recursive: true });

        sessions[apiUrl] = {
          printerId,
          printerName,
          apiUrl,
          filename,
          sessionDir,
          framesDir,
          frameCount: 0,
          lastLayer: 0,
          pendingCapture: false,
          startedAt: Date.now(),
        };
        console.log(`[Timelapse] Started session for ${printerName}: ${filename}`);
      }

      // Track layer changes
      const session = sessions[apiUrl];
      if (session && state === 'printing' && currentLayer > 0) {
        session.lastLayer = currentLayer;
      }

      // Capture when printer pauses (triggered by PAUSE in before_layer_gcode)
      // The head is guaranteed parked and stationary at this point
      if (session && state === 'paused' && !session.pendingCapture) {
        session.pendingCapture = true;
        // Small delay to ensure head has fully stopped
        setTimeout(async () => {
          try {
            await captureFrame(session, printerService);
            // Resume the print via Moonraker API
            await resumePrint(session.apiUrl);
          } catch (err) {
            console.error(`[Timelapse] Capture/resume error ${session.printerName}:`, err.message);
            // Still try to resume even if capture failed
            try { await resumePrint(session.apiUrl); } catch (_) {}
          }
          session.pendingCapture = false;
        }, 500); // 500ms to ensure complete stop
      }

      // End session when print completes or is cancelled
      if (session && (state === 'complete' || state === 'cancelled' || state === 'error' || state === 'standby')) {
        if (session.frameCount > 0) {
          // Write metadata for VPS to pick up
          const meta = {
            printerName: session.printerName,
            printerId: session.printerId,
            filename: session.filename,
            frameCount: session.frameCount,
            totalLayers: session.lastLayer,
            startedAt: session.startedAt,
            completedAt: Date.now(),
            state,
          };
          fs.writeFileSync(path.join(session.sessionDir, 'metadata.json'), JSON.stringify(meta, null, 2));
          console.log(`[Timelapse] Session ended for ${session.printerName}: ${session.frameCount} frames captured over ${session.lastLayer} layers (${state})`);
        } else {
          // No frames captured, clean up empty directory
          try { fs.rmSync(session.sessionDir, { recursive: true }); } catch (_) {}
        }
        delete sessions[apiUrl];
      }
    },

    /**
     * List completed timelapse sessions (with metadata.json).
     * Called by VPS to discover ready-to-download sessions.
     */
    listCompleted() {
      const results = [];
      if (!fs.existsSync(TIMELAPSE_DIR)) return results;
      for (const dir of fs.readdirSync(TIMELAPSE_DIR)) {
        const metaPath = path.join(TIMELAPSE_DIR, dir, 'metadata.json');
        if (fs.existsSync(metaPath)) {
          try {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            meta.sessionKey = dir;
            results.push(meta);
          } catch (_) {}
        }
      }
      return results;
    },

    /**
     * Get frames for a session as an array of {index, path} objects.
     */
    getFrames(sessionKey) {
      const framesDir = path.join(TIMELAPSE_DIR, sessionKey, 'frames');
      if (!fs.existsSync(framesDir)) return [];
      return fs.readdirSync(framesDir)
        .filter(f => f.endsWith('.jpg'))
        .sort()
        .map((f, i) => ({ index: i, path: path.join(framesDir, f), filename: f }));
    },

    /**
     * Delete a completed session after VPS has downloaded it.
     */
    deleteSession(sessionKey) {
      const dir = path.join(TIMELAPSE_DIR, sessionKey);
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true });
        console.log(`[Timelapse] Deleted session: ${sessionKey}`);
      }
    },

    /** Get active sessions info */
    getActive() {
      return Object.values(sessions).map(s => ({
        printerName: s.printerName,
        filename: s.filename,
        frameCount: s.frameCount,
        lastLayer: s.lastLayer,
      }));
    },
  };
}

/**
 * Resume a paused print via Moonraker API.
 */
async function resumePrint(apiUrl) {
  const resp = await fetch(`${apiUrl}/printer/print/resume`, {
    method: 'POST',
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) {
    throw new Error(`Resume failed: ${resp.status} ${resp.statusText}`);
  }
}

/**
 * Capture a single frame from the printer's webcam.
 */
async function captureFrame(session, printerService) {
  const buf = await printerService.getWebcamSnapshot(session.apiUrl);
  if (!buf || buf.length < 500) {
    console.warn(`[Timelapse] ${session.printerName}: empty/invalid snapshot at layer ${session.lastLayer}`);
    return;
  }

  session.frameCount++;
  const frameNum = String(session.frameCount).padStart(5, '0');
  const framePath = path.join(session.framesDir, `frame_${frameNum}.jpg`);
  fs.writeFileSync(framePath, buf);

  if (session.frameCount <= 3 || session.frameCount % 10 === 0) {
    console.log(`[Timelapse] ${session.printerName}: layer ${session.lastLayer}, frame ${session.frameCount}`);
  }
}

module.exports = { init };
