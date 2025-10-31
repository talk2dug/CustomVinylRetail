const twilio = require('twilio');

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || '';
const MESSAGING_SERVICE_SID = process.env.TWILIO_MESSAGING_SERVICE_SID || '';

let client = null;

function isConfigured() {
  return Boolean(ACCOUNT_SID && AUTH_TOKEN && (FROM_NUMBER || MESSAGING_SERVICE_SID));
}

function getClient() {
  if (!isConfigured()) {
    return null;
  }
  if (!client) {
    client = twilio(ACCOUNT_SID, AUTH_TOKEN, { lazyLoading: true });
  }
  return client;
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
  const clientInstance = getClient();
  if (!clientInstance) {
    throw new Error('Twilio SMS is not configured.');
  }
  const recipient = normalizeRecipient(to);
  if (!recipient) {
    throw new Error('A valid destination phone number is required.');
  }
  if (!body || !String(body).trim()) {
    throw new Error('SMS body is required.');
  }

  const payload = {
    body: String(body),
    to: recipient
  };

  if (MESSAGING_SERVICE_SID) {
    payload.messagingServiceSid = MESSAGING_SERVICE_SID;
  } else {
    payload.from = FROM_NUMBER;
  }

  return clientInstance.messages.create(payload);
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
        console.error('Failed to send SMS via Twilio:', error?.message || error);
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
