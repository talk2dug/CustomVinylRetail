/**
 * Tailscale Monitor — Check tailscale status --json
 */

const { execFile } = require('child_process');
const path = require('path');

let _status = {
  connected: false,
  ip: null,
  hostname: null,
  peers: 0,
  lastCheck: null,
  lastError: null
};

// Common Tailscale CLI locations on Windows
const TAILSCALE_PATHS = [
  'C:\\Program Files\\Tailscale\\tailscale.exe',
  'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
  'tailscale' // PATH fallback
];

function findTailscale() {
  const fs = require('fs');
  for (const p of TAILSCALE_PATHS) {
    if (p === 'tailscale') return p; // PATH fallback always last
    try {
      fs.accessSync(p);
      return p;
    } catch (e) {
      continue;
    }
  }
  return 'tailscale';
}

const tailscaleExe = findTailscale();

async function checkTailscale() {
  try {
    const result = await new Promise((resolve, reject) => {
      execFile(tailscaleExe, ['status', '--json'], { timeout: 5000 }, (err, stdout) => {
        if (err) return reject(err);
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(new Error('Invalid JSON from tailscale status'));
        }
      });
    });

    const selfIP = result.TailscaleIPs?.[0] || result.Self?.TailscaleIPs?.[0] || null;
    const hostname = result.Self?.HostName || null;
    const peers = result.Peer ? Object.keys(result.Peer).length : 0;
    const connected = result.BackendState === 'Running';

    _status = {
      connected,
      ip: selfIP,
      hostname,
      peers,
      lastCheck: new Date().toISOString(),
      lastError: null
    };

    return { connected, ip: selfIP, hostname, peers };
  } catch (e) {
    _status = {
      connected: false,
      ip: null,
      hostname: null,
      peers: 0,
      lastCheck: new Date().toISOString(),
      lastError: e.message
    };
    return { connected: false, error: e.message };
  }
}

function getTailscaleStatus() {
  return { ..._status };
}

module.exports = { checkTailscale, getTailscaleStatus };
