const state = {
  apiBase: '',
  apiKey: '',
  orders: [],
  quotes: []
};

const els = {
  status: document.getElementById('psmStatus'),
  tabs: Array.from(document.querySelectorAll('.psm-tabbar .tab')),
  views: Array.from(document.querySelectorAll('.view')),
  queueList: document.getElementById('queueList'),
  queueEmpty: document.getElementById('queueEmpty'),
  queueRefresh: document.getElementById('queueRefresh'),
  queueSearch: document.getElementById('queueSearch'),
  quotesList: document.getElementById('quotesList'),
  quotesEmpty: document.getElementById('quotesEmpty'),
  quotesRefresh: document.getElementById('quotesRefresh'),
  quoteSearch: document.getElementById('quoteSearch'),
  serverInput: document.getElementById('serverInput'),
  apiKeyInput: document.getElementById('apiKeyInput'),
  settingsForm: document.getElementById('psmSettings'),
  settingsStatus: document.getElementById('settingsStatus'),
  testButton: document.getElementById('testButton'),
  orderItemTemplate: document.getElementById('orderItemTemplate')
};

function ensureTrailingSlash(url) { return url.endsWith('/') ? url : url + '/'; }
function buildUrl(pathname) {
  const base = state.apiBase || window.location.origin;
  try { return new URL(pathname, ensureTrailingSlash(base)).toString(); } catch { return pathname; }
}

async function api(pathname, { method = 'GET', body } = {}) {
  const url = buildUrl(pathname);
  const headers = new Headers({ Accept: 'application/json' });
  if (state.apiKey) headers.set('X-API-Key', state.apiKey);
  let payload = undefined;
  if (body && typeof body === 'object') {
    headers.set('Content-Type', 'application/json');
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, { method, headers, body: payload });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) {
    const msg = data && typeof data === 'object' && data.error ? data.error : `HTTP ${res.status}`;
    const err = new Error(msg); err.status = res.status; err.detail = data; throw err;
  }
  return data;
}

function loadSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem('psmSettings') || '{}');
    state.apiBase = stored.apiBase || '';
    state.apiKey = stored.apiKey || '';
    state.operatorName = stored.operatorName || '';
    if (state.apiBase) els.serverInput.value = state.apiBase;
    if (state.apiKey) els.apiKeyInput.value = state.apiKey;
    if (state.operatorName) (document.getElementById('operatorInput') || {}).value = state.operatorName;
  } catch (_) {}
}

function saveSettings() {
  state.apiBase = els.serverInput.value.trim();
  state.apiKey = els.apiKeyInput.value.trim();
  state.operatorName = (document.getElementById('operatorInput') || {}).value?.trim() || '';
  localStorage.setItem('psmSettings', JSON.stringify({ apiBase: state.apiBase, apiKey: state.apiKey, operatorName: state.operatorName }));
  setStatus('Settings saved', true);
}

function setStatus(text, ok) {
  els.status.textContent = text;
  els.status.classList.toggle('ok', !!ok);
}

function switchView(id) {
  els.views.forEach((v) => v.classList.toggle('active', v.id === id));
  els.tabs.forEach((t) => t.classList.toggle('active', t.dataset.view === id));
}

function formatDate(value) {
  try { return new Date(value).toLocaleString(); } catch { return value || '—'; }
}
function formatMoney(cents) {
  if (!Number.isFinite(cents)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

async function loadQueue() {
  try {
    const data = await api('/api/orders');
    const orders = Array.isArray(data?.orders) ? data.orders : [];
    const search = els.queueSearch.value.trim().toLowerCase();
    const filtered = orders.filter((o) => {
      const hay = [o.orderNumber, o.designName, o.customer?.name, o.customer?.email].filter(Boolean).join(' ').toLowerCase();
      return !search || hay.includes(search);
    });
    state.orders = filtered;
    renderQueue();
    setStatus(`Loaded ${filtered.length} orders`, true);
  } catch (e) {
    setStatus(e.message || 'Unable to load orders');
  }
}

function renderQueue() {
  els.queueList.innerHTML = '';
  if (!state.orders.length) { els.queueEmpty.style.display = 'block'; return; }
  els.queueEmpty.style.display = 'none';
  const frag = document.createDocumentFragment();
  state.orders.forEach((o) => {
    const node = els.orderItemTemplate.content.cloneNode(true);
    node.querySelector('.item-title').textContent = `#${o.orderNumber ?? o.id} · ${o.designName || 'Untitled'}`;
    node.querySelector('.item-sub').textContent = `${formatDate(o.savedAt)} · ${formatMoney(o.pricing?.totalCents)} · ${(o.paymentStatus || (o.paid ? 'PAID' : 'UNPAID'))}`;
    const actions = node.querySelector('.item-actions');
    // Tap anywhere to open detail
    node.querySelector('.item').addEventListener('click', (ev) => {
      if (ev.target.closest('button')) return; // action buttons
      openOrderSheet(o);
    });
    if (o.previewFile) {
      const open = document.createElement('button'); open.className = 'secondary btn-sm'; open.textContent = 'Preview';
      open.addEventListener('click', () => window.open(buildUrl(`/files/saved/${encodeURIComponent(o.previewFile)}`), '_blank'));
      actions.appendChild(open);
    }
    if (!(o.paymentStatus === 'PAID' || o.paid)) {
      const paid = document.createElement('button'); paid.className = 'primary btn-sm'; paid.textContent = 'Mark Paid';
      paid.addEventListener('click', () => markPaid(o));
      actions.appendChild(paid);
    }
    frag.appendChild(node);
  });
  els.queueList.appendChild(frag);
}

async function markPaid(order) {
  try {
    const method = prompt('Payment method (cash/square)?', 'cash') || 'cash';
    const note = prompt('Optional note (cashier, last 4, change)') || '';
    await api(`/api/orders/${encodeURIComponent(order.id)}`, {
      method: 'PATCH',
      body: { paid: true, paymentStatus: 'PAID', paymentDetails: { method, note, at: new Date().toISOString() } }
    });
    await loadQueue();
  } catch (e) {
    alert(e.message || 'Unable to mark paid');
  }
}

async function loadQuotes() {
  try {
    const data = await api('/api/admin/race-quotes');
    const list = Array.isArray(data?.quotes) ? data.quotes : [];
    const search = els.quoteSearch.value.trim().toLowerCase();
    state.quotes = list.filter((q) => {
      const hay = [q.business, q.contactName, q.status].filter(Boolean).join(' ').toLowerCase();
      return !search || hay.includes(search);
    });
    renderQuotes();
    setStatus(`Loaded ${state.quotes.length} quotes`, true);
  } catch (e) {
    setStatus(e.message || 'Unable to load quotes');
  }
}

function renderQuotes() {
  els.quotesList.innerHTML = '';
  if (!state.quotes.length) { els.quotesEmpty.style.display = 'block'; return; }
  els.quotesEmpty.style.display = 'none';
  const frag = document.createDocumentFragment();
  state.quotes.forEach((q) => {
    const node = els.orderItemTemplate.content.cloneNode(true);
    node.querySelector('.item-title').textContent = `${q.business || 'Quote'} · #${q.quoteNumber ?? q.id}`;
    const tag = (q.status || '').replace(/_/g, ' ');
    node.querySelector('.item-sub').textContent = `${tag} · ${formatDate(q.updatedAt || q.createdAt)}`;
    frag.appendChild(node);
  });
  els.quotesList.appendChild(frag);
}

function openOrderSheet(order) {
  const sheet = document.getElementById('orderSheet');
  if (!sheet) return;
  const title = document.getElementById('sheetTitle');
  const sub = document.getElementById('sheetSub');
  const body = document.getElementById('sheetBody');
  const closeBtn = document.getElementById('sheetClose');
  title.textContent = `Order #${order.orderNumber ?? order.id}`;
  const status = (order.paymentStatus || (order.paid ? 'PAID' : 'UNPAID'));
  sub.textContent = `${formatDate(order.savedAt)} · ${formatMoney(order.pricing?.totalCents)} · ${status}`;
  body.innerHTML = `
    <div>
      <div><strong>Design:</strong> ${order.designName || 'Untitled'}</div>
      <div><strong>Customer:</strong> ${order.customer?.name || order.customer?.email || '—'}</div>
    </div>
    <div class="actions" style="display:flex;gap:8px;flex-wrap:wrap;">
      ${order.previewFile ? `<button id="sheetPreview" class="secondary btn-sm">Open Preview</button>` : ''}
      ${!(order.paymentStatus === 'PAID' || order.paid) ? `<button id="sheetPaid" class="primary btn-sm">Mark Paid</button>` : ''}
      <button id="sheetDownloaded" class="secondary btn-sm">Mark Downloaded</button>
      <button id="sheetCompleted" class="primary btn-sm">Mark Completed</button>
    </div>
    <label class="inline"><span style="font-size:12px;color:var(--muted)">Downloaded by</span>
      <input id="sheetDownloadedBy" type="text" value="${state.operatorName || ''}" placeholder="Operator" />
    </label>
    <label class="inline"><span style="font-size:12px;color:var(--muted)">Completion note</span>
      <input id="sheetCompleteNote" type="text" placeholder="Optional note" />
    </label>
  `;
  sheet.classList.add('show');
  sheet.classList.remove('hidden');
  closeBtn.onclick = () => { sheet.classList.remove('show'); sheet.classList.add('hidden'); };
  if (order.previewFile) {
    document.getElementById('sheetPreview').onclick = () => {
      window.open(buildUrl(`/files/saved/${encodeURIComponent(order.previewFile)}`), '_blank');
    };
  }
  const paidBtn = document.getElementById('sheetPaid');
  if (paidBtn) {
    paidBtn.onclick = () => markPaid(order);
  }
  document.getElementById('sheetDownloaded').onclick = async () => {
    const by = (document.getElementById('sheetDownloadedBy').value || '').trim();
    try {
      await api(`/api/internal/orders/${encodeURIComponent(order.id)}/acknowledge`, { method: 'PATCH', body: by ? { downloadedBy: by } : {} });
      await loadQueue();
      sheet.classList.remove('show'); sheet.classList.add('hidden');
    } catch (e) { alert(e.message || 'Unable to mark downloaded'); }
  };
  document.getElementById('sheetCompleted').onclick = async () => {
    const note = (document.getElementById('sheetCompleteNote').value || '').trim();
    try {
      await api(`/api/internal/orders/${encodeURIComponent(order.id)}/completed`, { method: 'PATCH', body: note ? { note } : {} });
      await loadQueue();
      sheet.classList.remove('show'); sheet.classList.add('hidden');
    } catch (e) { alert(e.message || 'Unable to mark completed'); }
  };
}

function initTabs() {
  els.tabs.forEach((t) => t.addEventListener('click', () => {
    switchView(t.dataset.view);
    if (t.dataset.view === 'queueView') loadQueue();
    if (t.dataset.view === 'quotesView') loadQuotes();
  }));
}

function initSettings() {
  els.settingsForm.addEventListener('submit', (e) => { e.preventDefault(); saveSettings(); });
  els.testButton.addEventListener('click', async () => {
    try {
      const res = await api('/api/public/config');
      els.settingsStatus.textContent = `OK · msgs/mo=${res?.smsMsgsPerMonth ?? 'n/a'}`;
      els.settingsStatus.classList.add('ok');
      setStatus('Connected', true);
    } catch (e) {
      els.settingsStatus.textContent = e.message || 'Test failed';
      els.settingsStatus.classList.remove('ok');
      setStatus('Test failed');
    }
  });
}

(function bootstrap() {
  loadSettings();
  initTabs();
  initSettings();
  // Auto load queue on start
  switchView('queueView');
  loadQueue();
})();
