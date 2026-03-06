/**
 * GPU Bridge — Entry point
 *
 * Orchestrates:
 * - System tray icon with health status
 * - Ollama monitoring (local GPU)
 * - Tailscale monitoring (network connectivity)
 * - Status HTTP server for dashboard
 */

const { createTray, updateTrayIcon } = require('./tray');
const { checkOllama, getOllamaStatus } = require('./ollama-monitor');
const { checkTailscale, getTailscaleStatus } = require('./tailscale-monitor');
const { getStats, incrementRequest, getUptime } = require('./stats');
const { startStatusServer } = require('./status-server');

const CHECK_INTERVAL = 10000; // 10 seconds

let currentState = 'red'; // red | yellow | green

async function healthCheckLoop() {
  try {
    const tailscale = await checkTailscale();
    const ollama = await checkOllama();

    let newState;
    if (!tailscale.connected) {
      newState = 'red';
    } else if (!ollama.healthy) {
      newState = 'yellow';
    } else {
      newState = 'green';
    }

    if (newState !== currentState) {
      currentState = newState;
      updateTrayIcon(newState);
      console.log(`[GPU Bridge] State changed to ${newState.toUpperCase()}`);
    }
  } catch (e) {
    console.error('[GPU Bridge] Health check error:', e.message);
  }
}

async function main() {
  console.log('[GPU Bridge] Starting...');

  // Start the status HTTP server
  startStatusServer(19876, () => ({
    state: currentState,
    ollama: getOllamaStatus(),
    tailscale: getTailscaleStatus(),
    stats: getStats(),
    uptime: getUptime()
  }));

  // Create system tray
  createTray();

  // Run initial check
  await healthCheckLoop();

  // Start periodic health checks
  setInterval(healthCheckLoop, CHECK_INTERVAL);

  console.log('[GPU Bridge] Running. Tray icon active.');
}

main().catch(e => {
  console.error('[GPU Bridge] Fatal error:', e);
  process.exit(1);
});
