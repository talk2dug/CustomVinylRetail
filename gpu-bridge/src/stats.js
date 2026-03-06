/**
 * Stats — Request counter, uptime tracking
 */

const startTime = Date.now();

let _stats = {
  totalRequests: 0,
  lastRequestAt: null
};

function incrementRequest() {
  _stats.totalRequests++;
  _stats.lastRequestAt = new Date().toISOString();
}

function getStats() {
  return { ..._stats };
}

function getUptime() {
  const ms = Date.now() - startTime;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m ${seconds % 60}s`;
}

module.exports = { getStats, incrementRequest, getUptime };
