/**
 * Pipeline Utilities — shared helpers for apparel + metal-print pipelines.
 */

const fs = require('fs');
const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const CATALOG_PATH = path.join(APP_ROOT, 'web', 'catalog.json');

const API_BASE = `http://localhost:${process.env.PORT || 4000}`;
const API_KEY = process.env.INTERNAL_API_KEY || '';

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function apiFetch(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const resp = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(options.timeout || 120000)
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`API ${resp.status}: ${text.substring(0, 200)}`);
  }
  return resp.json();
}

async function sendTelegram(text, parseMode = '') {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  const body = { chat_id: chatId, text };
  if (parseMode) body.parse_mode = parseMode;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000)
    });
  } catch (e) {
    console.error('[Pipeline] Telegram send failed:', e.message);
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function loadCatalog() {
  if (!fs.existsSync(CATALOG_PATH)) throw new Error('Catalog not found: ' + CATALOG_PATH);
  return JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
}

function logToJournal(journalPath, entry) {
  let journal = [];
  try {
    if (fs.existsSync(journalPath)) journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  } catch (_) {}
  journal.push({ ...entry, timestamp: new Date().toISOString() });
  if (journal.length > 500) journal = journal.slice(-500);
  fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2));
}

module.exports = {
  pick,
  apiFetch,
  sendTelegram,
  sleep,
  loadCatalog,
  logToJournal,
  API_BASE,
  API_KEY,
  APP_ROOT,
  CATALOG_PATH
};
