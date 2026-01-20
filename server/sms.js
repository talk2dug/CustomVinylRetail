const https = require('https');

// SimpleTexting configuration
const ST_API_KEY = process.env.SIMPLETEXTING_API_KEY || process.env.ST_API_KEY || '';
const ST_FROM = process.env.SIMPLETEXTING_FROM || process.env.ST_FROM || '';
// Default to v1 host and path if not specified; many accounts still use app2.simpletexting.com v1
const ST_API_BASE = (process.env.SIMPLETEXTING_API_BASE || process.env.ST_API_BASE || 'https://app2.simpletexting.com').replace(/\/$/, '');
// Path: v1 = /v1/send (GET with query), v2 = /v2/messages (POST JSON)
const RAW_PATH = process.env.SIMPLETEXTING_SEND_PATH || process.env.ST_SEND_PATH || '/v1/send';
const ST_SEND_PATH = RAW_PATH.startsWith('/') ? RAW_PATH : `/${RAW_PATH}`;

function isConfigured() {
  return Boolean(ST_API_KEY);
}

function normalizeRecipient(recipient) {
  if (!recipient) return null;
  const trimmed = String(recipient).trim();
  if (!trimmed) return null;
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/[^\d+]/g, '');
  if (hasPlus && digits.startsWith('+')) {
    return digits;
  }
  if (digits.startsWith('1') && digits.length === 11) {
    return `+${digits}`;
  }
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  return hasPlus ? trimmed : digits;
}

function parseRecipientList(value) {
  if (!value) return [];
  return value
    .split(/[,;\n]+/)
    .map((entry) => normalizeRecipient(entry))
    .filter(Boolean);
}

async function sendSms({ to, body }) {
  const recipient = normalizeRecipient(to);
  if (!recipient) {
    throw new Error('A valid destination phone number is required.');
  }
  const message = (body || '').toString();
  if (!message.trim()) {
    throw new Error('SMS body is required.');
  }

  if (!ST_API_KEY) {
    throw new Error('SimpleTexting SMS is not configured.');
  }
  return sendViaSimpleTexting({ to: recipient, body: message });
}

function httpJsonRequest(method, fullUrl, headers, data) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(fullUrl);
      const opts = {
        method,
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + (u.search || ''),
        headers: headers || {}
      };
      const req = https.request(opts, (res) => {
        let chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const text = buf.toString('utf8');
          const ct = (res.headers['content-type'] || '').toLowerCase();
          let json = null;
          if (ct.includes('application/json')) {
            try { json = JSON.parse(text || '{}'); } catch (_) { json = null; }
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json || { ok: true, status: res.statusCode, body: text });
          } else {
            const err = new Error((json && (json.error || json.message)) || text || `HTTP ${res.statusCode}`);
            err.status = res.statusCode;
            err.detail = json || text;
            reject(err);
          }
        });
      });
      req.on('error', reject);
      if (data) {
        req.write(typeof data === 'string' ? data : JSON.stringify(data));
      }
      req.end();
    } catch (error) {
      reject(error);
    }
  });
}

async function sendViaSimpleTexting({ to, body }) {
  // Detect mode by path / base.
  const isV1 = /\/v1\//.test(ST_SEND_PATH) || /app2\.simpletexting\.com$/i.test(ST_API_BASE);
  if (isV1) {
    // V1: GET with query: /v1/send?token=API&phone=E164&message=...
    const url = `${ST_API_BASE}${ST_SEND_PATH}?token=${encodeURIComponent(ST_API_KEY)}&phone=${encodeURIComponent(to)}&message=${encodeURIComponent(body)}`;
    return httpJsonRequest('GET', url, {}, null);
  }
  // V2: POST JSON with Authorization header
  const url = `${ST_API_BASE}${ST_SEND_PATH}`;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${ST_API_KEY}`,
    'X-Authorization': ST_API_KEY
  };
  const payload = { phoneNumber: to, message: body };
  if (ST_FROM) payload.from = ST_FROM;
  return httpJsonRequest('POST', url, headers, payload);
}

async function sendBulkSms({ to = [], body }) {
  const recipients = Array.isArray(to) ? to : [to];
  const normalized = recipients.map((entry) => normalizeRecipient(entry)).filter(Boolean);
  if (!normalized.length) {
    return [];
  }
  return Promise.all(
    normalized.map((recipient) =>
      sendSms({ to: recipient, body }).catch((error) => {
        console.error('Failed to send SMS:', error?.message || error);
        return null;
      })
    )
  );
}

module.exports = {
  isConfigured,
  sendSms,
  sendBulkSms,
  parseRecipientList
};
