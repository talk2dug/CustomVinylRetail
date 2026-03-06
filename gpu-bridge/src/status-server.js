/**
 * Status Server — Local HTTP server for status dashboard
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

let _getStatusFn = null;

function startStatusServer(port, getStatusFn) {
  _getStatusFn = getStatusFn;

  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      // Serve status page
      const htmlPath = path.join(__dirname, '..', 'web', 'status.html');
      try {
        const html = fs.readFileSync(htmlPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Could not load status page: ' + e.message);
      }
    } else if (req.url === '/api/status') {
      // JSON status API
      const status = _getStatusFn ? _getStatusFn() : {};
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify(status));
    } else if (req.url === '/api/gpu-info') {
      // GPU info via nvidia-smi
      const { execFile } = require('child_process');
      execFile('nvidia-smi', ['--query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total,driver_version', '--format=csv,noheader,nounits'], { timeout: 5000 }, (err, stdout) => {
        if (err) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ available: false, error: err.message }));
          return;
        }
        const parts = stdout.trim().split(', ');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          available: true,
          name: parts[0] || 'Unknown',
          temperature: parseInt(parts[1]) || 0,
          utilization: parseInt(parts[2]) || 0,
          memoryUsed: parseInt(parts[3]) || 0,
          memoryTotal: parseInt(parts[4]) || 0,
          driverVersion: parts[5] || 'Unknown'
        }));
      });
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`[GPU Bridge] Status server at http://localhost:${port}`);
  });

  return server;
}

module.exports = { startStatusServer };
