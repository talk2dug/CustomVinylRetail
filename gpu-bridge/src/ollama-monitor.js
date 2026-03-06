/**
 * Ollama Monitor — Health-check local Ollama via /api/tags
 */

const http = require('http');

const OLLAMA_HOST = '127.0.0.1';
const OLLAMA_PORT = 11434;
const HEALTH_TIMEOUT = 3000;

let _status = {
  healthy: false,
  models: [],
  lastCheck: null,
  lastError: null
};

async function checkOllama() {
  try {
    const result = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: OLLAMA_HOST,
        port: OLLAMA_PORT,
        path: '/api/tags',
        method: 'GET',
        timeout: HEALTH_TIMEOUT
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed);
          } catch (e) {
            reject(new Error('Invalid JSON from Ollama'));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      req.end();
    });

    const models = (result.models || []).map(m => ({
      name: m.name,
      size: m.size,
      modified: m.modified_at
    }));

    _status = {
      healthy: true,
      models,
      lastCheck: new Date().toISOString(),
      lastError: null
    };

    return { healthy: true, models };
  } catch (e) {
    _status = {
      healthy: false,
      models: [],
      lastCheck: new Date().toISOString(),
      lastError: e.message
    };
    return { healthy: false, error: e.message };
  }
}

function getOllamaStatus() {
  return { ..._status };
}

module.exports = { checkOllama, getOllamaStatus };
