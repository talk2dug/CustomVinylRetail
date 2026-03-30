/**
 * Campaign View — pipeline-integrated campaign management
 *
 * Handles: 2-slot apparel chooser, pipeline execution + progress polling,
 * pipeline run history, reel results display, cross-platform analytics.
 *
 * Depends on: window.printStation.pipeline.*, window.state, index.js globals
 */
'use strict';

const campaignViewState = {
  initialized: false,
  pipelinePollingInterval: null,
  currentRunId: null
};

const PIPELINE_STEPS = [
  { key: 'load',              label: 'Loading' },
  { key: 'categorize',        label: 'Categorizing' },
  { key: 'match-models',      label: 'Matching Models' },
  { key: 'lifestyle-mockups',  label: 'Lifestyle Mockups' },
  { key: 'product-blanks',    label: 'Product Blanks' },
  { key: 'shopify-publish',   label: 'Shopify Publish' },
  { key: 'create-reels',      label: 'Creating Reels' },
  { key: 'landing-pages',     label: 'Landing Pages' },
  { key: 'complete',          label: 'Complete' }
];

// ============================================================================
// INIT
// ============================================================================

function initCampaignView() {
  if (campaignViewState.initialized) return;
  campaignViewState.initialized = true;

  // Apparel chooser buttons
  setupApparelSlotButton('campaignApparel1SsawBtn', 0, 'ssaw');
  setupApparelSlotButton('campaignApparel1InventoryBtn', 0, 'inventory');
  setupApparelSlotButton('campaignApparel2SsawBtn', 1, 'ssaw');
  setupApparelSlotButton('campaignApparel2InventoryBtn', 1, 'inventory');

  const clear1 = document.getElementById('campaignApparel1ClearBtn');
  if (clear1) clear1.addEventListener('click', () => clearApparelSlot(0));
  const clear2 = document.getElementById('campaignApparel2ClearBtn');
  if (clear2) clear2.addEventListener('click', () => clearApparelSlot(1));

  // Pipeline run button
  const runBtn = document.getElementById('campaignRunPipelineBtn');
  if (runBtn) runBtn.addEventListener('click', handleRunPipeline);

  // Pipeline history refresh
  const histRefresh = document.getElementById('campaignPipelineHistoryRefresh');
  if (histRefresh) histRefresh.addEventListener('click', () => {
    if (window.state?.campaign?.slug) loadPipelineHistory(window.state.campaign.slug);
  });

  // Analytics refresh
  const analyticsRefresh = document.getElementById('campaignAnalyticsRefresh');
  if (analyticsRefresh) analyticsRefresh.addEventListener('click', () => {
    if (window.state?.campaign?.slug) loadCampaignAnalytics(window.state.campaign.slug);
  });
}
window.initCampaignView = initCampaignView;

// Called when a campaign is loaded — refresh pipeline-specific data
function onCampaignLoaded(campaign) {
  if (!campaign) return;
  // Migrate old single apparel to apparelChoices array
  if (!campaign.apparelChoices && campaign.apparel) {
    campaign.apparelChoices = [campaign.apparel, null];
  }
  if (!campaign.apparelChoices) campaign.apparelChoices = [null, null];

  renderApparelSlot(0, campaign.apparelChoices[0]);
  renderApparelSlot(1, campaign.apparelChoices[1]);

  if (campaign.slug) {
    loadPipelineHistory(campaign.slug);
    loadCampaignReels(campaign.slug);
    loadCampaignAnalytics(campaign.slug);
  }

  // Reset pipeline progress UI
  const progEl = document.getElementById('campaignPipelineProgress');
  if (progEl) progEl.hidden = true;
  const statusEl = document.getElementById('campaignPipelineStatus');
  if (statusEl) statusEl.textContent = 'Ready';
}
window.onCampaignLoaded = onCampaignLoaded;

// ============================================================================
// APPAREL CHOOSER (2 slots)
// ============================================================================

function setupApparelSlotButton(buttonId, slotIndex, source) {
  const btn = document.getElementById(buttonId);
  if (!btn) return;
  btn.addEventListener('click', () => {
    // Set a special state flag so the existing S&S/Inventory modal knows
    // which apparel slot to populate on selection
    window.state.campaignApparelSlotIndex = slotIndex;
    // Flag for the existing modal callback to use
    window.state.campaignApparelSelectIndex = 0; // required to trigger campaign mode in modal

    if (source === 'ssaw') {
      if (typeof window.openSsawVisual === 'function') window.openSsawVisual();
    } else {
      if (typeof window.openInventoryApparelModal === 'function') window.openInventoryApparelModal();
    }
  });
}

/**
 * Called from S&S/Inventory modal when an apparel item is selected.
 * Intercepts the selection and routes it to the correct slot.
 */
function handleApparelSelected(apparelData) {
  const slotIndex = window.state.campaignApparelSlotIndex;
  if (typeof slotIndex !== 'number') return false; // not in slot mode

  if (!window.state.campaign.apparelChoices) {
    window.state.campaign.apparelChoices = [null, null];
  }
  window.state.campaign.apparelChoices[slotIndex] = apparelData;
  renderApparelSlot(slotIndex, apparelData);

  // Also update the legacy apparel field for backward compat
  window.state.campaign.apparel = window.state.campaign.apparelChoices[0];

  // Clean up
  window.state.campaignApparelSlotIndex = null;
  window.state.campaignApparelSelectIndex = null;

  return true; // consumed
}
window.handleApparelSelected = handleApparelSelected;

function renderApparelSlot(slotIndex, apparel) {
  const num = slotIndex + 1;
  const preview = document.getElementById(`campaignApparel${num}Preview`);
  if (!preview) return;

  if (!apparel) {
    preview.innerHTML = `<span class="muted">Choice ${num} — click to select</span>`;
    preview.style.border = '2px dashed var(--border)';
    return;
  }

  const imgSrc = apparel.imageUrl || apparel.image || '';
  const label = [apparel.colorName || apparel.color || '', apparel.styleName || apparel.brandName || '', apparel.type || ''].filter(Boolean).join(' · ');

  preview.innerHTML = imgSrc
    ? `<img src="${imgSrc}" alt="${label}" style="width:100%;height:100%;object-fit:contain;border-radius:6px;">
       <div style="position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,0.7);color:#fff;font-size:11px;padding:4px 8px;border-radius:0 0 6px 6px;">${escCampaignHtml(label)}</div>`
    : `<span style="font-size:12px;padding:8px;text-align:center;">${escCampaignHtml(label)}</span>`;
  preview.style.border = '2px solid var(--accent)';
  preview.style.position = 'relative';
}

function clearApparelSlot(slotIndex) {
  if (!window.state.campaign.apparelChoices) window.state.campaign.apparelChoices = [null, null];
  window.state.campaign.apparelChoices[slotIndex] = null;
  renderApparelSlot(slotIndex, null);
}

/**
 * Get the 2 apparel choices formatted for the pipeline API.
 */
function getApparelChoicesForPipeline() {
  const choices = window.state.campaign?.apparelChoices || [];
  return choices.filter(Boolean).map(a => ({
    type: a.type || a.styleName || 'T-shirt',
    color: a.colorName || a.color || 'White',
    label: a.label || `${a.colorName || ''} ${a.styleName || a.type || ''}`.trim()
  }));
}
window.getApparelChoicesForPipeline = getApparelChoicesForPipeline;

// ============================================================================
// RUN PIPELINE
// ============================================================================

async function handleRunPipeline() {
  const campaign = window.state?.campaign;
  if (!campaign) {
    showToast('No campaign loaded.', 'error');
    return;
  }
  if (!campaign.slug) {
    showToast('Save the campaign first.', 'error');
    return;
  }
  if (!campaign.items || !campaign.items.length) {
    showToast('Add items to the campaign first.', 'error');
    return;
  }

  const apparelChoices = getApparelChoicesForPipeline();
  if (apparelChoices.length < 1) {
    showToast('Select at least one apparel choice.', 'error');
    return;
  }

  // Collect design IDs from campaign items
  const designIds = campaign.items
    .map(item => item.designId || item.id || item.uid)
    .filter(Boolean);

  if (!designIds.length) {
    showToast('No valid design IDs in campaign items.', 'error');
    return;
  }

  const runBtn = document.getElementById('campaignRunPipelineBtn');
  if (runBtn) { runBtn.disabled = true; runBtn.textContent = 'Starting...'; }

  try {
    // Save campaign first
    if (typeof window.handleCampaignSaveSilently === 'function') {
      await window.handleCampaignSaveSilently();
    }

    const result = await window.printStation.pipeline.run({
      designIds,
      campaignSlug: campaign.slug,
      campaignTitle: campaign.title || campaign.slug,
      apparelChoices
    });

    if (result.runId) {
      campaignViewState.currentRunId = result.runId;
      startPipelinePolling(result.runId);
      showToast('Pipeline started.', 'success');
    } else {
      showToast('Pipeline started (no run ID returned).', 'warning');
    }
  } catch (err) {
    showToast('Pipeline failed to start: ' + (err.message || err), 'error');
    if (runBtn) { runBtn.disabled = false; runBtn.textContent = 'Run Pipeline'; }
  }
}

// ============================================================================
// PIPELINE PROGRESS POLLING
// ============================================================================

function startPipelinePolling(runId) {
  const progEl = document.getElementById('campaignPipelineProgress');
  if (progEl) progEl.hidden = false;
  const statusEl = document.getElementById('campaignPipelineStatus');
  if (statusEl) statusEl.textContent = 'Running...';

  renderPipelineSteps(null);

  // Clear any existing polling
  if (campaignViewState.pipelinePollingInterval) {
    clearInterval(campaignViewState.pipelinePollingInterval);
  }

  // Poll every 3 seconds
  campaignViewState.pipelinePollingInterval = setInterval(async () => {
    try {
      const status = await window.printStation.pipeline.getStatus(runId);
      renderPipelineProgress(status);

      if (status.status === 'complete' || status.status === 'error') {
        clearInterval(campaignViewState.pipelinePollingInterval);
        campaignViewState.pipelinePollingInterval = null;

        const runBtn = document.getElementById('campaignRunPipelineBtn');
        if (runBtn) { runBtn.disabled = false; runBtn.textContent = 'Run Pipeline'; }

        const statusEl = document.getElementById('campaignPipelineStatus');

        if (status.status === 'complete') {
          if (statusEl) statusEl.textContent = 'Complete';
          showToast('Pipeline complete!', 'success');
          onPipelineComplete(status);
        } else {
          if (statusEl) statusEl.textContent = 'Error';
          showToast('Pipeline failed: ' + (status.error_message || 'Unknown error'), 'error');
        }
      }
    } catch (err) {
      console.warn('[CampaignView] Pipeline poll error:', err);
    }
  }, 3000);
}

function renderPipelineSteps(currentStep) {
  const container = document.getElementById('campaignPipelineSteps');
  if (!container) return;

  container.innerHTML = PIPELINE_STEPS.map(step => {
    const stepDef = PIPELINE_STEPS.find(s => s.key === currentStep);
    const currentIdx = stepDef ? stepDef.index : -1;
    const thisIdx = PIPELINE_STEPS.indexOf(step);

    let cls = 'pipeline-step';
    let icon = '';
    if (thisIdx < currentIdx) {
      cls += ' step-done';
      icon = '&#10003; ';
    } else if (step.key === currentStep) {
      cls += ' step-active';
      icon = '&#9654; ';
    } else {
      cls += ' step-pending';
    }

    return `<span class="${cls}" style="font-size:11px;padding:3px 8px;border-radius:4px;white-space:nowrap;
      ${thisIdx < currentIdx ? 'background:#10b981;color:#fff;' : ''}
      ${step.key === currentStep ? 'background:#22d3ee;color:#000;font-weight:600;' : ''}
      ${thisIdx > currentIdx && currentIdx >= 0 ? 'background:rgba(148,163,184,0.15);color:#94a3b8;' : ''}
      ${currentIdx < 0 ? 'background:rgba(148,163,184,0.15);color:#94a3b8;' : ''}
    ">${icon}${step.label}</span>`;
  }).join('');
}

function renderPipelineProgress(status) {
  // Update step indicators
  renderPipelineSteps(status.current_step);

  // Update progress bar
  const bar = document.getElementById('campaignPipelineProgressBar');
  const label = document.getElementById('campaignPipelineProgressLabel');
  const stepLabel = document.getElementById('campaignPipelineStepLabel');

  const stepDef = PIPELINE_STEPS.find(s => s.key === status.current_step);
  const overallPct = stepDef
    ? Math.round(((stepDef.index || 0) / PIPELINE_STEPS.length) * 100)
    : 0;

  if (bar) bar.style.width = overallPct + '%';
  if (label) label.textContent = overallPct + '%';
  if (stepLabel) {
    const detail = status.step_total > 0
      ? `${stepDef?.label || status.current_step} (${status.step_progress}/${status.step_total})`
      : (stepDef?.label || status.current_step || '');
    stepLabel.textContent = detail;
  }

  // Show errors
  const errEl = document.getElementById('campaignPipelineError');
  if (errEl) {
    if (status.error_message) {
      errEl.hidden = false;
      errEl.textContent = status.error_message;
    } else {
      errEl.hidden = true;
    }
  }
}

function onPipelineComplete(status) {
  if (window.state?.campaign?.slug) {
    loadPipelineHistory(window.state.campaign.slug);
    loadCampaignReels(window.state.campaign.slug);
    loadCampaignAnalytics(window.state.campaign.slug);
  }
}

// ============================================================================
// PIPELINE HISTORY
// ============================================================================

async function loadPipelineHistory(campaignSlug) {
  const container = document.getElementById('campaignPipelineHistory');
  if (!container || !campaignSlug) return;

  try {
    const data = await window.printStation.pipeline.listRuns(campaignSlug);
    const runs = data.runs || data || [];

    if (!runs.length) {
      container.innerHTML = '<p class="muted" style="font-size:12px;">No pipeline runs yet.</p>';
      return;
    }

    container.innerHTML = runs.map(run => {
      const date = run.started_at ? new Date(run.started_at).toLocaleString() : 'Unknown';
      const statusBadge = run.status === 'complete'
        ? '<span style="color:#10b981;font-weight:600;">Complete</span>'
        : run.status === 'error'
          ? '<span style="color:#ef4444;font-weight:600;">Error</span>'
          : run.status === 'running'
            ? '<span style="color:#22d3ee;font-weight:600;">Running</span>'
            : '<span class="muted">Pending</span>';

      let apparelSummary = '';
      try {
        const choices = JSON.parse(run.apparel_choices || '[]');
        apparelSummary = choices.map(c => `${c.color || ''} ${c.type || ''}`).filter(Boolean).join(', ');
      } catch (_) {}

      let resultsSummary = '';
      try {
        const r = JSON.parse(run.results_json || 'null');
        if (r) {
          resultsSummary = [
            r.mockupsGenerated ? `${r.mockupsGenerated} mockups` : '',
            r.shopifyPublished ? `${r.shopifyPublished} published` : '',
            r.reelsCreated ? `${r.reelsCreated} reels` : '',
            (r.landingPages || []).length ? `${r.landingPages.length} pages` : ''
          ].filter(Boolean).join(' · ');
        }
      } catch (_) {}

      return `<div style="padding:8px 0;border-bottom:1px solid rgba(148,163,184,0.15);font-size:12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span>${date}</span>
          ${statusBadge}
        </div>
        ${apparelSummary ? `<div class="muted" style="margin-top:2px;">${escCampaignHtml(apparelSummary)}</div>` : ''}
        ${resultsSummary ? `<div style="margin-top:2px;color:#94a3b8;">${escCampaignHtml(resultsSummary)}</div>` : ''}
        ${run.error_message ? `<div style="color:#ef4444;margin-top:2px;">${escCampaignHtml(run.error_message)}</div>` : ''}
      </div>`;
    }).join('');
  } catch (err) {
    container.innerHTML = `<p class="muted" style="font-size:12px;">Failed to load: ${escCampaignHtml(err.message)}</p>`;
  }
}

// ============================================================================
// REEL RESULTS
// ============================================================================

async function loadCampaignReels(campaignSlug) {
  const card = document.getElementById('campaignReelResultsCard');
  const grid = document.getElementById('campaignReelGrid');
  if (!card || !grid || !campaignSlug) return;

  try {
    // Fetch videos from managed list filtered by collection (campaign slug)
    const data = await window.printStation.tiktokDash.managed.list({ collection: campaignSlug });
    const videos = data.items || data.videos || data || [];

    if (!videos.length) {
      card.hidden = true;
      return;
    }

    card.hidden = false;
    renderReelGrid(grid, videos);
  } catch (err) {
    console.warn('[CampaignView] Failed to load reels:', err);
    card.hidden = true;
  }
}

function renderReelGrid(grid, videos) {
  const serverBase = window.state?.config?.serverBaseUrl || '';

  grid.innerHTML = videos.map((v, i) => {
    const videoUrl = v.url || (v.filename ? `/api/tiktok-videos/${v.filename}` : '');
    const fullVideoUrl = videoUrl.startsWith('http') ? videoUrl : `${serverBase}${videoUrl}`;
    const platform = v.platform || 'shopify';
    const platformLabel = platform === 'tiktok-shop' ? 'TikTok Shop' : 'Shopify';
    const platformColor = platform === 'tiktok-shop' ? '#e879f9' : '#10b981';
    const statusLabel = v.status || 'draft';
    const statusColor = statusLabel === 'approved' ? '#10b981' : statusLabel === 'published' ? '#60a5fa' : '#94a3b8';
    const pageLink = v.shopify_page_url ? `<a href="${escCampaignHtml(v.shopify_page_url)}" target="_blank" style="font-size:11px;color:#22d3ee;">Landing Page</a>` : '';
    const duration = v.duration ? `${v.duration}s` : '';

    return `<div style="border:1px solid var(--border);border-radius:8px;overflow:hidden;background:rgba(148,163,184,0.05);">
      <div style="aspect-ratio:9/16;background:#111;display:flex;align-items:center;justify-content:center;position:relative;max-height:280px;">
        <video src="${escCampaignHtml(fullVideoUrl)}" style="width:100%;height:100%;object-fit:cover;" preload="metadata" controls></video>
        <span style="position:absolute;top:6px;right:6px;background:${platformColor};color:#fff;font-size:10px;padding:2px 8px;border-radius:12px;font-weight:600;">${platformLabel}</span>
      </div>
      <div style="padding:8px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <span style="font-size:12px;font-weight:600;">Reel ${i + 1}</span>
          <span style="font-size:10px;color:${statusColor};text-transform:uppercase;font-weight:600;">${statusLabel}</span>
        </div>
        ${duration ? `<div class="muted" style="font-size:11px;">${duration}</div>` : ''}
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;">
          ${pageLink}
          ${statusLabel === 'draft' ? `<button type="button" class="secondary campaign-approve-reel" data-video-id="${escCampaignHtml(v.id)}" style="font-size:11px;padding:3px 10px;">Approve</button>` : ''}
        </div>
        ${v.views > 0 || v.likes > 0 ? `<div style="font-size:11px;color:#94a3b8;margin-top:4px;">${formatNum(v.views || 0)} views · ${formatNum(v.likes || 0)} likes</div>` : ''}
      </div>
    </div>`;
  }).join('');

  // Wire approve buttons
  grid.querySelectorAll('.campaign-approve-reel').forEach(btn => {
    btn.addEventListener('click', async () => {
      const videoId = btn.dataset.videoId;
      if (!videoId) return;
      btn.disabled = true;
      btn.textContent = 'Approving...';
      try {
        await window.printStation.pipeline.approveReel(videoId);
        showToast('Reel approved.', 'success');
        // Reload reels
        if (window.state?.campaign?.slug) loadCampaignReels(window.state.campaign.slug);
      } catch (err) {
        showToast('Approve failed: ' + (err.message || err), 'error');
        btn.disabled = false;
        btn.textContent = 'Approve';
      }
    });
  });
}

function renderReelResults(results) {
  // Called from onPipelineComplete — reload from DB for full data
  if (window.state?.campaign?.slug) {
    loadCampaignReels(window.state.campaign.slug);
  }
}

// ============================================================================
// CROSS-PLATFORM ANALYTICS
// ============================================================================

async function loadCampaignAnalytics(campaignSlug) {
  const card = document.getElementById('campaignAnalyticsCard');
  if (!card || !campaignSlug) return;

  try {
    // Load reel data for TikTok metrics
    const runsData = await window.printStation.pipeline.listRuns(campaignSlug);
    const runs = runsData.runs || runsData || [];

    let tiktokTotals = { views: 0, likes: 0, comments: 0, shares: 0 };
    let hasData = false;

    // Aggregate from completed runs that have reel results
    for (const run of runs) {
      if (run.status !== 'complete') continue;
      try {
        const r = JSON.parse(run.results_json || 'null');
        if (!r) continue;
        // If reel records have metrics, aggregate them
        // For now, show the reel count as a proxy
        if (r.reelsCreated > 0) hasData = true;
      } catch (_) {}
    }

    // TODO: fetch actual TikTok/FB/IG metrics when those APIs are wired
    // For now show what we have from the tiktok_videos table
    try {
      const videoData = await window.printStation.tiktokDash.managed.list({ collection: campaignSlug });
      const videos = videoData.items || videoData.videos || videoData || [];
      for (const v of videos) {
        tiktokTotals.views += v.views || 0;
        tiktokTotals.likes += v.likes || 0;
        tiktokTotals.comments += v.comments || 0;
        tiktokTotals.shares += v.shares || 0;
        if (v.views > 0 || v.likes > 0) hasData = true;
      }
    } catch (_) {}

    if (hasData) {
      card.hidden = false;
    }

    // Update TikTok numbers
    setText('tiktokViews', formatNum(tiktokTotals.views));
    setText('tiktokLikes', formatNum(tiktokTotals.likes));
    setText('tiktokComments', formatNum(tiktokTotals.comments));
    setText('tiktokShares', formatNum(tiktokTotals.shares));

    // FB/IG — placeholder until APIs wired
    setText('fbReach', '--');
    setText('fbEngagement', '--');
    setText('fbClicks', '--');
    setText('fbShares', '--');
    setText('igImpressions', '--');
    setText('igLikes', '--');
    setText('igComments', '--');
    setText('igSaves', '--');
  } catch (err) {
    console.warn('[CampaignView] Analytics load error:', err);
  }
}

// ============================================================================
// HELPERS
// ============================================================================

function escCampaignHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function formatNum(n) {
  if (!n || n === 0) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function showToast(message, type) {
  // Use existing showToast if available, otherwise console
  if (typeof window.showToast === 'function') {
    window.showToast(message, type);
  } else if (typeof window.showNotification === 'function') {
    window.showNotification(message, type);
  } else {
    console.log(`[CampaignView] ${type}: ${message}`);
  }
}
