// =============== Trend Monitor View ===============

const trendApi = {
  getServerUrl() {
    return window.printStationConfig?.serverBaseUrl || window.APP_CONFIG?.serverUrl || 'https://store.swayzecustomvinyl.com';
  },
  getHeaders() {
    return {
      'Content-Type': 'application/json',
      'x-api-key': window.printStationConfig?.apiKey || window.APP_CONFIG?.internalKey || ''
    };
  },
  async get(path) {
    const response = await fetch(`${this.getServerUrl()}${path}`, { headers: this.getHeaders() });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Request failed: ${response.status}`);
    }
    return response.json();
  },
  async post(path, data) {
    const response = await fetch(`${this.getServerUrl()}${path}`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(data || {})
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || `Request failed: ${response.status}`);
    }
    return response.json();
  },
  async put(path, data) {
    const response = await fetch(`${this.getServerUrl()}${path}`, {
      method: 'PUT',
      headers: this.getHeaders(),
      body: JSON.stringify(data)
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || `Request failed: ${response.status}`);
    }
    return response.json();
  },
  async del(path) {
    const response = await fetch(`${this.getServerUrl()}${path}`, {
      method: 'DELETE',
      headers: this.getHeaders()
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || `Request failed: ${response.status}`);
    }
    return response.json();
  }
};

const trendMonitorState = {
  initialized: false,
  trends: [],
  designs: [],
  settings: {},
  stats: {},
  activeTab: 'trends',
  refreshInterval: null
};

// =============================================================================
// INITIALIZATION
// =============================================================================

async function initTrendMonitorView() {
  if (trendMonitorState.initialized) {
    refreshTrendMonitorData();
    return;
  }
  trendMonitorState.initialized = true;
  setupTrendMonitorListeners();
  await refreshTrendMonitorData();

  // Auto-refresh every 2 minutes while view is active
  if (trendMonitorState.refreshInterval) clearInterval(trendMonitorState.refreshInterval);
  trendMonitorState.refreshInterval = setInterval(() => {
    const view = document.getElementById('trendMonitorView');
    if (view && view.classList.contains('active')) {
      refreshTrendMonitorStats();
    }
  }, 120000);
}

async function refreshTrendMonitorData() {
  try {
    const [trendsRes, designsRes, statsRes, settingsRes] = await Promise.all([
      trendApi.get('/api/trends/').catch(() => ({ trends: [] })),
      trendApi.get('/api/trends/designs').catch(() => ({ designs: [] })),
      trendApi.get('/api/trends/stats').catch(() => ({})),
      trendApi.get('/api/trends/settings').catch(() => ({}))
    ]);
    trendMonitorState.trends = trendsRes.trends || [];
    trendMonitorState.designs = designsRes.designs || [];
    trendMonitorState.stats = statsRes;
    trendMonitorState.settings = settingsRes;
    renderTrendMonitorActiveTab();
    renderTrendMonitorStats();
  } catch (err) {
    console.error('[TrendMonitor] Data refresh error:', err.message);
  }
}

async function refreshTrendMonitorStats() {
  try {
    const stats = await trendApi.get('/api/trends/stats');
    trendMonitorState.stats = stats;
    renderTrendMonitorStats();
  } catch (_) {}
}

// =============================================================================
// EVENT LISTENERS
// =============================================================================

function setupTrendMonitorListeners() {
  // Sub-tab switching
  document.querySelectorAll('[data-trendtab]').forEach(btn => {
    btn.addEventListener('click', () => {
      trendMonitorState.activeTab = btn.dataset.trendtab;
      document.querySelectorAll('[data-trendtab]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderTrendMonitorActiveTab();
    });
  });

  // Scan Now button
  document.getElementById('trendScanNowBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('trendScanNowBtn');
    btn.disabled = true;
    btn.textContent = 'Scanning...';
    try {
      await trendApi.post('/api/trends/scan');
      showTrendNotification('Scan started! This may take a few minutes.', 'info');
      // Poll for completion
      setTimeout(() => refreshTrendMonitorData(), 15000);
      setTimeout(() => refreshTrendMonitorData(), 45000);
      setTimeout(() => refreshTrendMonitorData(), 90000);
      setTimeout(() => refreshTrendMonitorData(), 180000);
    } catch (err) {
      showTrendNotification('Scan failed: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Scan Now';
    }
  });

  // Refresh button
  document.getElementById('trendRefreshBtn')?.addEventListener('click', () => {
    refreshTrendMonitorData();
  });

  // Settings save
  document.getElementById('trendSettingsSaveBtn')?.addEventListener('click', saveTrendSettings);
}

// =============================================================================
// STATS BAR
// =============================================================================

function renderTrendMonitorStats() {
  const stats = trendMonitorState.stats;
  const el = document.getElementById('trendStatsBar');
  if (!el) return;

  const lastScan = stats.lastScanAt ? timeAgo(stats.lastScanAt) : 'Never';
  const scanStatus = stats.scanRunning
    ? '<span style="color:#f59e0b;">Scanning...</span>'
    : `<span style="color:#94a3b8;">${lastScan}</span>`;

  el.innerHTML = `
    <div class="trend-stat"><strong>${stats.activeTrends || 0}</strong><span>Active Trends</span></div>
    <div class="trend-stat"><strong>${stats.pendingDesigns || 0}</strong><span>Pending Designs</span></div>
    <div class="trend-stat"><strong>${stats.totalApproved || 0}</strong><span>Approved</span></div>
    <div class="trend-stat"><strong>${stats.totalListed || 0}</strong><span>Listed</span></div>
    <div class="trend-stat"><strong>${stats.totalScans || 0}</strong><span>Total Scans</span></div>
    <div class="trend-stat"><span>Last Scan</span>${scanStatus}</div>
  `;
}

// =============================================================================
// TAB RENDERING
// =============================================================================

function renderTrendMonitorActiveTab() {
  const container = document.getElementById('trendMonitorContent');
  if (!container) return;

  switch (trendMonitorState.activeTab) {
    case 'trends': renderTrendsTab(container); break;
    case 'designs': renderDesignsTab(container); break;
    case 'settings': renderSettingsTab(container); break;
    case 'history': renderHistoryTab(container); break;
    default: renderTrendsTab(container);
  }
}

// =============================================================================
// TRENDS TAB
// =============================================================================

function renderTrendsTab(container) {
  const trends = trendMonitorState.trends;

  if (!trends.length) {
    container.innerHTML = `
      <div style="text-align:center;padding:60px 20px;color:#94a3b8;">
        <div style="font-size:3rem;margin-bottom:16px;">📡</div>
        <h3 style="color:#e2e8f0;">No trends found yet</h3>
        <p>Click "Scan Now" to fetch the latest trends from Reddit and Google Trends.</p>
      </div>`;
    return;
  }

  let html = '<div class="trend-cards">';

  for (const trend of trends) {
    const scoreColor = trend.score >= 90 ? '#22c55e' : trend.score >= 75 ? '#f59e0b' : trend.score >= 65 ? '#3b82f6' : '#94a3b8';
    const sourceBadge = trend.source === 'reddit'
      ? `<span class="trend-badge" style="background:#ff4500;">Reddit${trend.subreddit ? ` r/${trend.subreddit}` : ''}</span>`
      : `<span class="trend-badge" style="background:#4285f4;">Google Trends</span>`;
    const audienceBadge = trend.aiAnalysis?.targetAudience
      ? `<span class="trend-badge" style="background:#6366f1;">${trend.aiAnalysis.targetAudience}</span>`
      : '';
    const humorBadge = trend.aiAnalysis?.humorStyle
      ? `<span class="trend-badge" style="background:#8b5cf6;">${trend.aiAnalysis.humorStyle}</span>`
      : '';
    const statusBadge = trend.status !== 'new'
      ? `<span class="trend-badge" style="background:#475569;">${trend.status}</span>`
      : '';

    const phrases = (trend.aiAnalysis?.suggestedPhrases || []).map(p =>
      `<div class="trend-phrase">"${escTrend(p)}"</div>`
    ).join('');

    const metrics = [];
    if (trend.upvotes) metrics.push(`${formatNum(trend.upvotes)} upvotes`);
    if (trend.comments) metrics.push(`${formatNum(trend.comments)} comments`);
    if (trend.searchVolume) metrics.push(trend.searchVolume);

    html += `
      <div class="trend-card" data-trendid="${trend.id}">
        <div class="trend-card-header">
          <div class="trend-score" style="border-color:${scoreColor};color:${scoreColor};">${trend.score}</div>
          <div class="trend-card-title">
            <h4 style="margin:0;">${escTrend(trend.title.slice(0, 120))}</h4>
            <div class="trend-badges">${sourceBadge}${audienceBadge}${humorBadge}${statusBadge}</div>
          </div>
        </div>
        ${metrics.length ? `<div class="trend-metrics">${metrics.join(' · ')}</div>` : ''}
        ${trend.aiAnalysis?.reasoning ? `<p class="trend-reasoning">${escTrend(trend.aiAnalysis.reasoning)}</p>` : ''}
        ${phrases ? `<div class="trend-phrases"><strong>Design phrases:</strong>${phrases}</div>` : ''}
        <div class="trend-card-actions">
          <button class="primary small" onclick="trendGenerateDesign('${trend.id}')" ${trend.status === 'designed' ? 'disabled' : ''}>
            ${trend.status === 'designed' ? 'Designs Generated' : 'Generate Design'}
          </button>
          <button class="secondary small" onclick="trendDismiss('${trend.id}')">Dismiss</button>
          ${trend.url ? `<a href="${trend.url}" target="_blank" class="secondary small" style="text-decoration:none;display:inline-block;text-align:center;">View Source</a>` : ''}
        </div>
      </div>`;
  }

  html += '</div>';
  container.innerHTML = html;
}

// =============================================================================
// DESIGNS TAB
// =============================================================================

function renderDesignsTab(container) {
  const designs = trendMonitorState.designs;

  if (!designs.length) {
    container.innerHTML = `
      <div style="text-align:center;padding:60px 20px;color:#94a3b8;">
        <div style="font-size:3rem;margin-bottom:16px;">🎨</div>
        <h3 style="color:#e2e8f0;">No designs yet</h3>
        <p>Designs will appear here once trends are analyzed and images are generated.</p>
      </div>`;
    return;
  }

  // Group by status
  const pending = designs.filter(d => d.status === 'pending');
  const approved = designs.filter(d => d.status === 'approved');
  const listed = designs.filter(d => d.status === 'listed');
  const rejected = designs.filter(d => d.status === 'rejected');

  let html = '';

  if (pending.length) {
    html += `<h3 style="margin:16px 0 8px;color:#f59e0b;">Pending Review (${pending.length})</h3>`;
    html += renderDesignGrid(pending, true);
  }
  if (approved.length) {
    html += `<h3 style="margin:16px 0 8px;color:#22c55e;">Approved (${approved.length})</h3>`;
    html += renderDesignGrid(approved, false);
  }
  if (listed.length) {
    html += `<h3 style="margin:16px 0 8px;color:#3b82f6;">Listed on Shopify (${listed.length})</h3>`;
    html += renderDesignGrid(listed, false);
  }
  if (rejected.length) {
    html += `<details style="margin-top:16px;"><summary style="cursor:pointer;color:#94a3b8;">Rejected (${rejected.length})</summary>`;
    html += renderDesignGrid(rejected, false);
    html += '</details>';
  }

  container.innerHTML = html;
}

function renderDesignGrid(designs, showActions) {
  const serverUrl = trendApi.getServerUrl();
  let html = '<div class="design-grid">';

  for (const design of designs) {
    const imgSrc = design.imageUrl || `${serverUrl}${design.imagePath}`;
    const statusColor = {
      pending: '#f59e0b', approved: '#22c55e', listed: '#3b82f6', rejected: '#ef4444'
    }[design.status] || '#94a3b8';

    let actions = '';
    if (showActions && design.status === 'pending') {
      actions = `
        <div class="design-actions">
          <button class="primary small" onclick="trendApproveDesign('${design.id}')">Approve</button>
          <button class="danger small" onclick="trendRejectDesign('${design.id}')">Reject</button>
          <button class="secondary small" onclick="trendRegenerateDesign('${design.id}')">Regenerate</button>
        </div>`;
    } else if (design.status === 'approved') {
      actions = `
        <div class="design-actions">
          <button class="primary small" onclick="trendListDesign('${design.id}')">List to Shopify</button>
        </div>`;
    } else if (design.status === 'listed' && design.shopifyProductUrl) {
      actions = `
        <div class="design-actions">
          <a href="${design.shopifyProductUrl}" target="_blank" class="secondary small" style="text-decoration:none;display:inline-block;text-align:center;">View on Shopify</a>
        </div>`;
    }

    html += `
      <div class="design-card">
        <div class="design-image" style="position:relative;">
          <img src="${imgSrc}" alt="${escTrend(design.phrase)}" loading="lazy"
               onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22200%22 height=%22200%22><rect fill=%22%23334155%22 width=%22200%22 height=%22200%22/><text fill=%22%2394a3b8%22 x=%2250%25%22 y=%2250%25%22 text-anchor=%22middle%22 dy=%22.3em%22 font-size=%2214%22>No preview</text></svg>'">
          <span class="design-status-dot" style="background:${statusColor};"></span>
        </div>
        <div class="design-info">
          <p class="design-phrase">"${escTrend(design.phrase)}"</p>
          <span class="trend-badge small" style="background:#475569;">${design.printMethod || 'dtf'}</span>
          <span style="color:#64748b;font-size:0.8rem;">${timeAgo(design.createdAt)}</span>
        </div>
        ${actions}
      </div>`;
  }

  html += '</div>';
  return html;
}

// =============================================================================
// SETTINGS TAB
// =============================================================================

function renderSettingsTab(container) {
  const s = trendMonitorState.settings;

  container.innerHTML = `
    <div class="trend-settings-form">
      <div class="settings-section">
        <h3>Scan Settings</h3>
        <div class="form-row">
          <label>Scan Interval (hours)</label>
          <input type="number" id="trendSettingScanInterval" value="${s.scanIntervalHours || 4}" min="1" max="24">
        </div>
        <div class="form-row">
          <label>Enabled</label>
          <input type="checkbox" id="trendSettingEnabled" ${s.enabled !== false ? 'checked' : ''}>
        </div>
        <div class="form-row">
          <label>Auto-generate Designs</label>
          <input type="checkbox" id="trendSettingAutoDesign" ${s.autoGenerateDesigns !== false ? 'checked' : ''}>
        </div>
        <div class="form-row">
          <label>Max Trends Per Scan</label>
          <input type="number" id="trendSettingMaxTrends" value="${s.maxTrendsPerScan || 20}" min="5" max="50">
        </div>
      </div>

      <div class="settings-section">
        <h3>Score Thresholds</h3>
        <div class="form-row">
          <label>Min Score for Design (0-100)</label>
          <input type="number" id="trendSettingMinDesign" value="${s.minScoreForDesign || 65}" min="0" max="100">
        </div>
        <div class="form-row">
          <label>Min Score for Alert (0-100)</label>
          <input type="number" id="trendSettingMinAlert" value="${s.minScoreForAlert || 80}" min="0" max="100">
        </div>
      </div>

      <div class="settings-section">
        <h3>Notifications</h3>
        <div class="form-row">
          <label>SMS Alerts</label>
          <input type="checkbox" id="trendSettingSms" ${s.notifySms !== false ? 'checked' : ''}>
        </div>
        <div class="form-row">
          <label>Email Alerts</label>
          <input type="checkbox" id="trendSettingEmail" ${s.notifyEmail ? 'checked' : ''}>
        </div>
        <div class="form-row">
          <label>Desktop Notifications</label>
          <input type="checkbox" id="trendSettingDesktop" ${s.notifyDesktop !== false ? 'checked' : ''}>
        </div>
        <div class="form-row">
          <label>SMS Recipients (comma-separated)</label>
          <input type="text" id="trendSettingSmsRecipients" value="${(s.smsRecipients || []).join(', ')}" placeholder="+18001234567">
        </div>
        <div class="form-row">
          <label>Email Recipients (comma-separated)</label>
          <input type="text" id="trendSettingEmailRecipients" value="${(s.emailRecipients || []).join(', ')}" placeholder="email@example.com">
        </div>
      </div>

      <div class="settings-section">
        <h3>Reddit Subreddits</h3>
        <div class="form-row">
          <label>Subreddits to monitor (comma-separated)</label>
          <textarea id="trendSettingSubreddits" rows="3" style="width:100%;font-family:monospace;font-size:0.9rem;">${(s.redditSubreddits || []).join(', ')}</textarea>
        </div>
      </div>

      <div class="settings-section">
        <h3>Product Defaults</h3>
        <div class="form-row">
          <label>Default Price ($)</label>
          <input type="number" id="trendSettingPrice" value="${((s.defaultPriceCents || 2499) / 100).toFixed(2)}" step="0.01" min="1">
        </div>
        <div class="form-row">
          <label>Shopify Collection Name</label>
          <input type="text" id="trendSettingCollection" value="${s.shopifyCollectionTitle || 'Trending Designs'}">
        </div>
        <div class="form-row">
          <label>Design Style</label>
          <input type="text" id="trendSettingStyle" value="${s.designStyle || 'sarcastic, witty, comical, playful'}">
        </div>
      </div>

      <div style="margin-top:20px;">
        <button id="trendSettingsSaveBtn" class="primary">Save Settings</button>
      </div>
    </div>`;

  // Re-wire save button since we just replaced the DOM
  document.getElementById('trendSettingsSaveBtn')?.addEventListener('click', saveTrendSettings);
}

async function saveTrendSettings() {
  const settings = {
    scanIntervalHours: parseInt(document.getElementById('trendSettingScanInterval')?.value || '4', 10),
    enabled: document.getElementById('trendSettingEnabled')?.checked ?? true,
    autoGenerateDesigns: document.getElementById('trendSettingAutoDesign')?.checked ?? true,
    maxTrendsPerScan: parseInt(document.getElementById('trendSettingMaxTrends')?.value || '20', 10),
    minScoreForDesign: parseInt(document.getElementById('trendSettingMinDesign')?.value || '65', 10),
    minScoreForAlert: parseInt(document.getElementById('trendSettingMinAlert')?.value || '80', 10),
    notifySms: document.getElementById('trendSettingSms')?.checked ?? true,
    notifyEmail: document.getElementById('trendSettingEmail')?.checked ?? false,
    notifyDesktop: document.getElementById('trendSettingDesktop')?.checked ?? true,
    smsRecipients: (document.getElementById('trendSettingSmsRecipients')?.value || '').split(',').map(s => s.trim()).filter(Boolean),
    emailRecipients: (document.getElementById('trendSettingEmailRecipients')?.value || '').split(',').map(s => s.trim()).filter(Boolean),
    redditSubreddits: (document.getElementById('trendSettingSubreddits')?.value || '').split(',').map(s => s.trim()).filter(Boolean),
    defaultPriceCents: Math.round(parseFloat(document.getElementById('trendSettingPrice')?.value || '24.99') * 100),
    shopifyCollectionTitle: document.getElementById('trendSettingCollection')?.value || 'Trending Designs',
    designStyle: document.getElementById('trendSettingStyle')?.value || 'sarcastic, witty, comical, playful'
  };

  try {
    await trendApi.put('/api/trends/settings', settings);
    trendMonitorState.settings = { ...trendMonitorState.settings, ...settings };
    showTrendNotification('Settings saved', 'success');
  } catch (err) {
    showTrendNotification('Failed to save: ' + err.message, 'error');
  }
}

// =============================================================================
// HISTORY TAB
// =============================================================================

async function renderHistoryTab(container) {
  container.innerHTML = '<div style="text-align:center;padding:40px;color:#94a3b8;">Loading history...</div>';

  try {
    const data = await trendApi.get('/api/trends/history?limit=50');
    const trends = data.trends || [];

    if (!trends.length) {
      container.innerHTML = '<div style="text-align:center;padding:60px 20px;color:#94a3b8;"><h3 style="color:#e2e8f0;">No archived trends yet</h3></div>';
      return;
    }

    let html = '<table class="trend-history-table"><thead><tr><th>Trend</th><th>Source</th><th>Score</th><th>Status</th><th>Discovered</th></tr></thead><tbody>';
    for (const t of trends) {
      html += `<tr>
        <td>${escTrend(t.title?.slice(0, 80) || '')}</td>
        <td>${t.source || ''}</td>
        <td>${t.score || '-'}</td>
        <td>${t.status || ''}</td>
        <td>${t.discoveredAt ? new Date(t.discoveredAt).toLocaleDateString() : ''}</td>
      </tr>`;
    }
    html += '</tbody></table>';
    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = `<div style="color:#ef4444;padding:20px;">Error loading history: ${err.message}</div>`;
  }
}

// =============================================================================
// ACTIONS (global functions called from onclick)
// =============================================================================

async function trendGenerateDesign(trendId) {
  const trend = trendMonitorState.trends.find(t => t.id === trendId);
  if (!trend) return;

  showTrendNotification(`Generating designs for "${trend.title.slice(0, 40)}..."`, 'info');

  // Trigger a scan-like action for just this trend — we re-use regenerate endpoint
  // by finding any existing design or creating via scan
  try {
    await trendApi.post('/api/trends/scan');
    setTimeout(() => refreshTrendMonitorData(), 30000);
    setTimeout(() => refreshTrendMonitorData(), 90000);
  } catch (err) {
    showTrendNotification('Design generation failed: ' + err.message, 'error');
  }
}

async function trendDismiss(trendId) {
  try {
    await trendApi.del(`/api/trends/${trendId}`);
    trendMonitorState.trends = trendMonitorState.trends.filter(t => t.id !== trendId);
    renderTrendMonitorActiveTab();
    showTrendNotification('Trend dismissed', 'success');
  } catch (err) {
    showTrendNotification('Failed: ' + err.message, 'error');
  }
}

async function trendApproveDesign(designId) {
  try {
    await trendApi.post(`/api/trends/designs/${designId}/approve`);
    const design = trendMonitorState.designs.find(d => d.id === designId);
    if (design) {
      design.status = 'approved';
      design.approvedAt = new Date().toISOString();
    }
    renderTrendMonitorActiveTab();
    refreshTrendMonitorStats();
    showTrendNotification('Design approved!', 'success');

    // Desktop notification
    if (trendMonitorState.settings.notifyDesktop && Notification.permission === 'granted') {
      new Notification('Design Approved', { body: design?.phrase || 'Design approved and ready to list' });
    }
  } catch (err) {
    showTrendNotification('Approval failed: ' + err.message, 'error');
  }
}

async function trendRejectDesign(designId) {
  try {
    await trendApi.post(`/api/trends/designs/${designId}/reject`);
    const design = trendMonitorState.designs.find(d => d.id === designId);
    if (design) design.status = 'rejected';
    renderTrendMonitorActiveTab();
    refreshTrendMonitorStats();
    showTrendNotification('Design rejected', 'success');
  } catch (err) {
    showTrendNotification('Rejection failed: ' + err.message, 'error');
  }
}

async function trendRegenerateDesign(designId) {
  try {
    await trendApi.post(`/api/trends/designs/${designId}/regenerate`);
    showTrendNotification('Regenerating design... this may take a minute.', 'info');
    setTimeout(() => refreshTrendMonitorData(), 30000);
    setTimeout(() => refreshTrendMonitorData(), 90000);
  } catch (err) {
    showTrendNotification('Regeneration failed: ' + err.message, 'error');
  }
}

async function trendListDesign(designId) {
  try {
    await trendApi.post(`/api/trends/designs/${designId}/list`);
    showTrendNotification('Listing to Shopify... this may take a moment.', 'info');
    setTimeout(() => refreshTrendMonitorData(), 10000);
    setTimeout(() => refreshTrendMonitorData(), 30000);
  } catch (err) {
    showTrendNotification('Listing failed: ' + err.message, 'error');
  }
}

// =============================================================================
// UTILITIES
// =============================================================================

function escTrend(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function formatNum(n) {
  if (!n) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function timeAgo(dateStr) {
  if (!dateStr) return 'Never';
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function showTrendNotification(message, type = 'info') {
  // Use existing notification system if available
  if (typeof showNotification === 'function') {
    showNotification(type, message);
    return;
  }
  // Fallback: toast at top of view
  const existing = document.getElementById('trendToast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'trendToast';
  const colors = { success: '#22c55e', error: '#ef4444', info: '#3b82f6', warning: '#f59e0b' };
  toast.style.cssText = `position:fixed;top:20px;right:20px;z-index:9999;padding:12px 20px;border-radius:8px;color:white;font-weight:500;background:${colors[type] || colors.info};box-shadow:0 4px 12px rgba(0,0,0,0.3);transition:opacity 0.3s;`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 4000);
}

// Request notification permission on load
if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
  Notification.requestPermission();
}
