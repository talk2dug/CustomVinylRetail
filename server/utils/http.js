/**
 * Shared HTTP Utilities
 * Consolidated from: save-design-server.js, leonardo-server.js
 */

// Default CORS headers for API responses
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key'
};

/**
 * Parse JSON body from incoming HTTP request
 * @param {http.IncomingMessage} req - The HTTP request
 * @returns {Promise<object>} Parsed JSON body or empty object
 */
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Send JSON response with CORS headers
 * @param {http.ServerResponse} res - The HTTP response
 * @param {number} statusCode - HTTP status code
 * @param {object} payload - JSON payload to send
 */
function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    ...CORS_HEADERS,
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

/**
 * Send error response
 * @param {http.ServerResponse} res - The HTTP response
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 */
function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

/**
 * Handle CORS preflight OPTIONS request
 * @param {http.ServerResponse} res - The HTTP response
 */
function handleOptions(res) {
  res.writeHead(204, {
    ...CORS_HEADERS,
    'Access-Control-Max-Age': '86400'
  });
  res.end();
}

/**
 * Get URL path without query string
 * @param {string} url - The full URL
 * @returns {string} Path only
 */
function getPathname(url) {
  try {
    return new URL(url, 'http://localhost').pathname;
  } catch {
    return url.split('?')[0];
  }
}

/**
 * Parse query string from URL
 * @param {string} url - The full URL
 * @returns {URLSearchParams} Parsed query parameters
 */
function getQueryParams(url) {
  try {
    return new URL(url, 'http://localhost').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

module.exports = {
  CORS_HEADERS,
  parseBody,
  sendJson,
  sendError,
  handleOptions,
  getPathname,
  getQueryParams
};
