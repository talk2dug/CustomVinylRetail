/**
 * TikTok Marketing Dashboard View
 * Pipeline launcher, video preview/approval, published tracker, templates
 */

const ttDashState = {
  initialized: false,
  videos: [],           // generated videos from assembler
  managedVideos: [],    // tracked videos with status
  templates: [],
  categories: [],
  manifests: [],
  pipelinePolling: null,
  refreshInterval: null
};

// ============================================================================
// Init
// ============================================================================
function initTiktokMarketingView() {
  if (!ttDashState.initialized) {
    ttDashState.initialized = true;
    setupTTDashPipeline();
    setupTTDashVideoGrid();
    setupTTDashPublished();
    setupTTDashTemplates();
    setupTTDashModal();
  }
  loadTTDashData();
  // Auto-refresh every 30s when visible
  clearInterval(ttDashState.refreshInterval);
  ttDashState.refreshInterval = setInterval(() => {
    const view = document.getElementById('tiktokMarketingView');
    if (view && view.classList.contains('active')) {
      loadTTDashVideos();
      loadTTDashManaged();
    }
  }, 30000);
}
window.initTiktokMarketingView = initTiktokMarketingView;

function loadTTDashData() {
  loadTTDashCatalog();
  loadTTDashVideos();
  loadTTDashManaged();
  loadTTDashTemplates();
  loadTTDashManifests();
}

// ============================================================================
// PIPELINE LAUNCHER
// ============================================================================
function setupTTDashPipeline() {
  document.getElementById('ttPipelineRunBtn').addEventListener('click', runTTPipeline);
  document.getElementById('ttDashRefreshBtn').addEventListener('click', loadTTDashData);
}

async function loadTTDashCatalog() {
  try {
    const result = await window.printStation.tiktokDash.getCatalog();
    const cats = result.categories || result || [];
    ttDashState.categories = cats;
    const select = document.getElementById('ttPipelineCollection');
    select.innerHTML = '<option value="">Select collection...</option>';
    cats.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.name || c.slug || c;
      opt.textContent = `${c.name || c} (${c.designs?.length || 0} designs)`;
      select.appendChild(opt);
    });
  } catch (e) {
    console.warn('[TT Dash] Catalog load error:', e.message);
  }
}

async function runTTPipeline() {
  const collection = document.getElementById('ttPipelineCollection').value;
  if (!collection) { ttToast('Select a collection first', true); return; }

  const btn = document.getElementById('ttPipelineRunBtn');
  const statusEl = document.getElementById('ttPipelineStatus');
  btn.disabled = true;
  btn.textContent = 'Starting...';
  statusEl.innerHTML = '<span style="color:var(--accent);">Starting pipeline...</span>';

  try {
    await window.printStation.tiktokDash.runPipeline({ category: collection });
    statusEl.innerHTML = '<span style="color:var(--accent);">Pipeline running — check progress below...</span>';
    btn.textContent = 'Running...';
    // Poll for completion
    startPipelinePolling();
  } catch (e) {
    statusEl.innerHTML = `<span style="color:var(--danger);">Failed: ${e.message}</span>`;
    btn.disabled = false;
    btn.textContent = 'Run Pipeline';
  }
}

function startPipelinePolling() {
  clearInterval(ttDashState.pipelinePolling);
  let pollCount = 0;
  ttDashState.pipelinePolling = setInterval(async () => {
    pollCount++;
    try {
      await loadTTDashManifests();
      await loadTTDashVideos();
      // Stop polling after 5 minutes
      if (pollCount > 60) {
        clearInterval(ttDashState.pipelinePolling);
        document.getElementById('ttPipelineRunBtn').disabled = false;
        document.getElementById('ttPipelineRunBtn').textContent = 'Run Pipeline';
        document.getElementById('ttPipelineStatus').innerHTML = '<span class="muted">Pipeline may have finished — check videos below</span>';
      }
    } catch (_) {}
  }, 5000);
}

async function loadTTDashManifests() {
  try {
    const result = await window.printStation.tiktokDash.getManifests();
    const manifests = result.manifests || result || [];
    ttDashState.manifests = manifests;
    renderPipelineHistory(manifests);
  } catch (_) {}
}

function renderPipelineHistory(manifests) {
  const el = document.getElementById('ttPipelineHistory');
  if (!manifests.length) {
    el.innerHTML = '<p class="muted">No pipeline runs yet.</p>';
    return;
  }
  // Show last 5 runs
  const recent = manifests.slice(0, 5);
  el.innerHTML = recent.map(m => {
    const name = m.filename || m.name || 'Unknown';
    const date = m.created_at || m.date || '';
    return `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border);">
      <span style="font-size:0.85rem;">${name}</span>
      <span class="muted" style="font-size:0.8rem;">${date ? new Date(date).toLocaleString() : ''}</span>
    </div>`;
  }).join('');
}

// ============================================================================
// VIDEO GRID (Draft videos awaiting approval)
// ============================================================================
function setupTTDashVideoGrid() {
  document.getElementById('ttVideoRefreshBtn').addEventListener('click', loadTTDashVideos);
}

async function loadTTDashVideos() {
  try {
    const result = await window.printStation.tiktokDash.listVideos();
    const videos = result.videos || result || [];
    ttDashState.videos = videos;
    renderTTDashVideoGrid(videos);
  } catch (e) {
    document.getElementById('ttVideoGrid').innerHTML =
      `<p class="muted" style="padding:16px;">Failed to load videos: ${e.message}</p>`;
  }
}

async function renderTTDashVideoGrid(videos) {
  const grid = document.getElementById('ttVideoGrid');
  if (!videos.length) {
    grid.innerHTML = '<p class="muted" style="padding:16px;">No generated videos found. Run the pipeline or generate from templates.</p>';
    return;
  }

  // Get managed records to show status
  const managedMap = {};
  ttDashState.managedVideos.forEach(m => { managedMap[m.filename] = m; });

  grid.innerHTML = videos.map(v => {
    const managed = managedMap[v.filename];
    const status = managed?.status || 'untracked';
    const statusClass = status === 'approved' ? 'tt-status-approved' :
                        status === 'published' ? 'tt-status-published' :
                        status === 'rejected' ? 'tt-status-rejected' : 'tt-status-draft';
    const template = v.filename.replace(/\.mp4$/, '').replace(/^tiktok-/, '').replace(/-\d+$/, '').replace(/-/g, ' ');
    const size = v.size ? ttFormatBytes(v.size) : '';
    const dur = v.duration ? ttFormatDuration(v.duration) : '';

    return `
      <div class="tt-video-card" data-filename="${v.filename}">
        <div class="tt-video-thumb">
          <video muted preload="metadata" style="width:100%;height:100%;object-fit:cover;border-radius:6px 6px 0 0;">
            <source src="" data-lazy-src="${v.filename}" type="video/mp4" />
          </video>
          <div class="tt-video-duration">${dur}</div>
        </div>
        <div class="tt-video-info">
          <div class="tt-video-name" title="${v.filename}">${template}</div>
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span class="tt-status-badge ${statusClass}">${status}</span>
            <span class="muted" style="font-size:0.75rem;">${size}</span>
          </div>
          <div class="tt-video-actions">
            <button class="secondary small tt-approve-btn" data-fn="${v.filename}" ${status === 'approved' || status === 'published' ? 'disabled' : ''}>Approve</button>
            <button class="danger small tt-reject-btn" data-fn="${v.filename}" ${status === 'rejected' ? 'disabled' : ''}>Reject</button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Lazy-load video sources
  grid.querySelectorAll('.tt-video-card').forEach(card => {
    const fn = card.dataset.filename;
    const source = card.querySelector('source[data-lazy-src]');
    if (source) {
      window.printStation.tiktokDash.getVideoUrl(fn).then(url => {
        source.src = url;
        source.parentElement.load();
      }).catch(() => {});
    }
    // Click to open preview
    card.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      openTTVideoPreview(fn);
    });
  });

  // Quick approve/reject buttons
  grid.querySelectorAll('.tt-approve-btn').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); quickApproveVideo(btn.dataset.fn); });
  });
  grid.querySelectorAll('.tt-reject-btn').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); quickRejectVideo(btn.dataset.fn); });
  });
}

async function ensureManagedRecord(filename) {
  // Find or create a managed record for this video
  let managed = ttDashState.managedVideos.find(m => m.filename === filename);
  if (!managed) {
    const video = ttDashState.videos.find(v => v.filename === filename);
    managed = await window.printStation.tiktokDash.managed.create({
      filename,
      url: video?.url || '',
      duration: video?.duration || null,
      file_size: video?.size || null,
      template: filename.replace(/\.mp4$/, '').replace(/-\d+$/, ''),
      status: 'draft'
    });
    ttDashState.managedVideos.push(managed);
  }
  return managed;
}

async function quickApproveVideo(filename) {
  try {
    const managed = await ensureManagedRecord(filename);
    await window.printStation.tiktokDash.managed.update(managed.id, { status: 'approved' });
    ttToast('Video approved');
    await loadTTDashManaged();
    renderTTDashVideoGrid(ttDashState.videos);
  } catch (e) {
    ttToast('Approve failed: ' + e.message, true);
  }
}

async function quickRejectVideo(filename) {
  try {
    const managed = await ensureManagedRecord(filename);
    await window.printStation.tiktokDash.managed.update(managed.id, { status: 'rejected' });
    ttToast('Video rejected');
    await loadTTDashManaged();
    renderTTDashVideoGrid(ttDashState.videos);
  } catch (e) {
    ttToast('Reject failed: ' + e.message, true);
  }
}

// ============================================================================
// VIDEO PREVIEW MODAL
// ============================================================================
function setupTTDashModal() {
  const modal = document.getElementById('ttVideoModal');
  document.getElementById('ttModalCloseBtn').addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', e => { if (e.target === modal) modal.classList.add('hidden'); });
}

async function openTTVideoPreview(filename) {
  const modal = document.getElementById('ttVideoModal');
  const body = document.getElementById('ttModalBody');
  document.getElementById('ttModalTitle').textContent = filename;

  const managed = ttDashState.managedVideos.find(m => m.filename === filename);
  const video = ttDashState.videos.find(v => v.filename === filename);
  let videoUrl = '';
  try { videoUrl = await window.printStation.tiktokDash.getVideoUrl(filename); } catch (_) {}

  const status = managed?.status || 'untracked';
  const caption = managed?.caption || '';

  body.innerHTML = `
    ${videoUrl ? `<video controls autoplay style="width:100%;max-height:400px;border-radius:6px;background:#000;" src="${videoUrl}"></video>` : '<p class="muted">Video not available</p>'}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px;">
      <div><small class="muted">Status</small><br/><span class="tt-status-badge tt-status-${status}">${status}</span></div>
      <div><small class="muted">Size</small><br/>${video?.size ? ttFormatBytes(video.size) : '-'}</div>
      <div><small class="muted">Duration</small><br/>${video?.duration ? ttFormatDuration(video.duration) : '-'}</div>
      <div><small class="muted">Created</small><br/>${video?.createdAt ? new Date(video.createdAt).toLocaleString() : '-'}</div>
    </div>
    <div style="margin-top:12px;">
      <label class="footage-label">Caption</label>
      <textarea id="ttModalCaption" class="text-input" rows="3" placeholder="Add caption for posting...">${caption}</textarea>
    </div>
    <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;">
      <button id="ttModalApproveBtn" class="primary small">Approve</button>
      <button id="ttModalRejectBtn" class="danger small">Reject</button>
      <button id="ttModalSaveCaptionBtn" class="secondary small">Save Caption</button>
      <button id="ttModalDeleteBtn" class="danger small" style="margin-left:auto;">Delete</button>
    </div>
  `;

  // Wire buttons
  document.getElementById('ttModalApproveBtn').addEventListener('click', async () => {
    const m = await ensureManagedRecord(filename);
    const cap = document.getElementById('ttModalCaption').value.trim();
    await window.printStation.tiktokDash.managed.update(m.id, { status: 'approved', caption: cap });
    ttToast('Approved');
    modal.classList.add('hidden');
    await loadTTDashManaged();
    renderTTDashVideoGrid(ttDashState.videos);
  });

  document.getElementById('ttModalRejectBtn').addEventListener('click', async () => {
    const m = await ensureManagedRecord(filename);
    await window.printStation.tiktokDash.managed.update(m.id, { status: 'rejected' });
    ttToast('Rejected');
    modal.classList.add('hidden');
    await loadTTDashManaged();
    renderTTDashVideoGrid(ttDashState.videos);
  });

  document.getElementById('ttModalSaveCaptionBtn').addEventListener('click', async () => {
    const m = await ensureManagedRecord(filename);
    const cap = document.getElementById('ttModalCaption').value.trim();
    await window.printStation.tiktokDash.managed.update(m.id, { caption: cap });
    ttToast('Caption saved');
  });

  document.getElementById('ttModalDeleteBtn').addEventListener('click', async () => {
    if (!confirm('Delete this video permanently?')) return;
    try {
      await window.printStation.tiktokDash.deleteVideo(filename);
      if (managed) await window.printStation.tiktokDash.managed.delete(managed.id);
      ttToast('Video deleted');
      modal.classList.add('hidden');
      loadTTDashVideos();
      loadTTDashManaged();
    } catch (e) {
      ttToast('Delete failed: ' + e.message, true);
    }
  });

  modal.classList.remove('hidden');
}

// ============================================================================
// PUBLISHED VIDEOS TRACKER
// ============================================================================
function setupTTDashPublished() {
  document.getElementById('ttPublishedFilterPlatform').addEventListener('change', renderTTDashPublished);
}

async function loadTTDashManaged() {
  try {
    const result = await window.printStation.tiktokDash.managed.list();
    ttDashState.managedVideos = result.items || result || [];
    renderTTDashPublished();
    // Update stats
    const stats = await window.printStation.tiktokDash.managed.stats();
    document.getElementById('ttStatTotal').textContent = stats.total || 0;
    const draft = (stats.by_status || []).find(s => s.status === 'draft');
    const approved = (stats.by_status || []).find(s => s.status === 'approved');
    const published = (stats.by_status || []).find(s => s.status === 'published');
    document.getElementById('ttStatDraft').textContent = draft?.count || 0;
    document.getElementById('ttStatApproved').textContent = approved?.count || 0;
    document.getElementById('ttStatPublished').textContent = published?.count || 0;
  } catch (e) {
    console.warn('[TT Dash] Managed load error:', e.message);
  }
}

function renderTTDashPublished() {
  const platformFilter = document.getElementById('ttPublishedFilterPlatform').value;
  const tbody = document.getElementById('ttPublishedBody');

  let published = ttDashState.managedVideos.filter(m => m.status === 'published');
  if (platformFilter) published = published.filter(m => m.platform === platformFilter);
  published.sort((a, b) => (b.published_at || b.updated_at || '').localeCompare(a.published_at || a.updated_at || ''));

  if (!published.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="muted" style="text-align:center;padding:16px;">No published videos yet</td></tr>';
    return;
  }

  tbody.innerHTML = published.map(v => `
    <tr>
      <td>${v.published_at ? new Date(v.published_at).toLocaleDateString() : '-'}</td>
      <td>${v.platform || '-'}</td>
      <td title="${v.filename}">${(v.template || v.filename || '').substring(0, 30)}</td>
      <td>${v.collection || '-'}</td>
      <td>${v.views || 0}</td>
      <td>${v.likes || 0}</td>
      <td>${v.published_url ? `<a href="${v.published_url}" target="_blank" style="color:var(--accent);">View</a>` : '-'}</td>
    </tr>
  `).join('');
}

// ============================================================================
// TEMPLATES
// ============================================================================
function setupTTDashTemplates() {}

async function loadTTDashTemplates() {
  try {
    const result = await window.printStation.tiktokDash.listTemplates();
    const templates = result.templates || result || [];
    ttDashState.templates = templates;
    renderTTDashTemplates(templates);
  } catch (e) {
    document.getElementById('ttTemplateGrid').innerHTML =
      `<p class="muted" style="padding:16px;">Failed to load templates: ${e.message}</p>`;
  }
}

function renderTTDashTemplates(templates) {
  const grid = document.getElementById('ttTemplateGrid');
  if (!templates.length) {
    grid.innerHTML = '<p class="muted" style="padding:16px;">No video templates available.</p>';
    return;
  }

  grid.innerHTML = templates.map(t => `
    <div class="tt-template-card">
      <div style="flex:1;">
        <strong>${t.name || t.key}</strong>
        <p class="muted" style="margin:4px 0 0;font-size:0.8rem;">${t.description || ''}</p>
        ${t.roles ? `<span class="muted" style="font-size:0.75rem;">${t.roles.length} segment(s)</span>` : ''}
      </div>
      <button class="primary small tt-generate-btn" data-template="${t.key}">Generate</button>
    </div>
  `).join('');

  grid.querySelectorAll('.tt-generate-btn').forEach(btn => {
    btn.addEventListener('click', () => openTemplateGenerator(btn.dataset.template));
  });
}

async function openTemplateGenerator(templateKey) {
  const template = ttDashState.templates.find(t => t.key === templateKey);
  if (!template) return;

  const modal = document.getElementById('ttVideoModal');
  const body = document.getElementById('ttModalBody');
  document.getElementById('ttModalTitle').textContent = `Generate: ${template.name || templateKey}`;

  const defaultTexts = template.defaultTexts || {};
  const textFields = Object.entries(defaultTexts).map(([key, val]) => `
    <div style="margin-bottom:8px;">
      <label class="footage-label">${key}</label>
      <input type="text" class="text-input tt-tmpl-text" data-key="${key}" value="${val}" />
    </div>
  `).join('');

  body.innerHTML = `
    <p class="muted">${template.description || ''}</p>
    ${textFields || '<p class="muted">No customizable text fields</p>'}
    <div style="margin-top:12px;">
      <button id="ttTmplGenerateBtn" class="primary">Generate Video</button>
      <span id="ttTmplStatus" class="muted" style="margin-left:8px;"></span>
    </div>
  `;

  document.getElementById('ttTmplGenerateBtn').addEventListener('click', async () => {
    const btn = document.getElementById('ttTmplGenerateBtn');
    const statusEl = document.getElementById('ttTmplStatus');
    btn.disabled = true;
    statusEl.textContent = 'Generating...';

    const texts = {};
    body.querySelectorAll('.tt-tmpl-text').forEach(input => {
      texts[input.dataset.key] = input.value;
    });

    try {
      await window.printStation.tiktokDash.assembleVideo({ template: templateKey, texts });
      statusEl.textContent = 'Done!';
      ttToast('Video generated!');
      setTimeout(() => { modal.classList.add('hidden'); loadTTDashVideos(); }, 1000);
    } catch (e) {
      statusEl.textContent = `Failed: ${e.message}`;
      btn.disabled = false;
      ttToast('Generation failed: ' + e.message, true);
    }
  });

  modal.classList.remove('hidden');
}

// ============================================================================
// Helpers
// ============================================================================
function ttFormatBytes(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function ttFormatDuration(sec) {
  if (!sec && sec !== 0) return '-';
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${String(m).padStart(2, '0')}:${String(rs).padStart(2, '0')}`;
}

function ttToast(msg, isError = false) {
  let toast = document.getElementById('ttDashToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'ttDashToast';
    toast.className = 'footage-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.background = isError ? 'var(--danger, #d32f2f)' : 'var(--success, #2e7d32)';
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2500);
}
