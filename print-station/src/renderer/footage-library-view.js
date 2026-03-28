/**
 * Footage Library View
 * Full mirror of web/footage.html with live camera recording.
 * Tabs: Record | Upload | Library | Cameras
 */

const footageState = {
  initialized: false,
  activeTab: 'record',
  // Recording
  currentCameraId: null,
  previewUnsub: null,
  recordingCameraId: null,  // cameraId currently recording
  recordingSegments: [],     // completed segment file paths
  recordingTickUnsub: null,
  recordingStartedAt: null,
  timerInterval: null,
  // Upload
  selectedFile: null,
  // Library
  clips: [],
  products: [],
  // Cameras
  cameras: []
};

// ============================================================================
// Init
// ============================================================================
function initFootageLibraryView() {
  if (!footageState.initialized) {
    footageState.initialized = true;
    setupFootageTabs();
    setupFootageRecordTab();
    setupFootageUploadTab();
    setupFootageLibraryTab();
    setupFootageCamerasTab();
    setupFootageModal();
  }
  loadFootageCameras();
  loadFootageProducts();
  checkFfmpegStatus();
}
window.initFootageLibraryView = initFootageLibraryView;

// ============================================================================
// Tab Switching
// ============================================================================
function setupFootageTabs() {
  document.querySelectorAll('[data-footagetab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.footagetab;
      document.querySelectorAll('[data-footagetab]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('[data-footagepanel]').forEach(p => {
        p.classList.toggle('active', p.dataset.footagepanel === tab);
      });
      footageState.activeTab = tab;
      if (tab === 'library') loadFootageLibrary();
      if (tab === 'cameras') loadFootageCameraList();
      // Stop preview if leaving record tab
      if (tab !== 'record' && footageState.currentCameraId) {
        stopFootagePreview();
      }
    });
  });
}

// ============================================================================
// Pill Selection (shared)
// ============================================================================
function setupPillGroup(container) {
  if (!container) return;
  container.querySelectorAll('.tag-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      // Single select per group
      container.querySelectorAll('.tag-pill').forEach(p => p.classList.remove('selected'));
      pill.classList.add('selected');
    });
  });
}

function getSelectedPill(groupName) {
  const group = document.querySelector(`[data-pillgroup="${groupName}"]`);
  if (!group) return '';
  const sel = group.querySelector('.tag-pill.selected');
  return sel ? sel.dataset.value : '';
}

function clearPillGroup(groupName) {
  const group = document.querySelector(`[data-pillgroup="${groupName}"]`);
  if (group) group.querySelectorAll('.tag-pill').forEach(p => p.classList.remove('selected'));
}

// Init all pill groups
document.querySelectorAll('.footage-pill-grid').forEach(g => setupPillGroup(g));

// ============================================================================
// RECORD TAB
// ============================================================================
function setupFootageRecordTab() {
  const cameraSelect = document.getElementById('footageCameraSelect');
  const startBtn = document.getElementById('footageStartRecBtn');
  const stopBtn = document.getElementById('footageStopRecBtn');
  const uploadRecBtn = document.getElementById('footageUploadRecBtn');
  const discardRecBtn = document.getElementById('footageDiscardRecBtn');

  cameraSelect.addEventListener('change', () => {
    const cameraId = cameraSelect.value;
    if (cameraId) {
      startFootagePreview(cameraId);
      startBtn.disabled = false;
    } else {
      stopFootagePreview();
      startBtn.disabled = true;
    }
  });

  startBtn.addEventListener('click', startFootageRecording);
  stopBtn.addEventListener('click', stopFootageRecording);
  uploadRecBtn.addEventListener('click', uploadFootageRecording);
  discardRecBtn.addEventListener('click', discardFootageRecording);

  // Subscribe to preview frames
  footageState.previewUnsub = window.printStation.footage.onPreviewFrame(({ cameraId, frame, error }) => {
    if (cameraId !== footageState.currentCameraId) return;
    const img = document.getElementById('footagePreviewImg');
    const placeholder = document.getElementById('footagePreviewPlaceholder');
    if (frame) {
      img.src = `data:image/jpeg;base64,${frame}`;
      img.style.display = 'block';
      placeholder.style.display = 'none';
    } else if (error) {
      placeholder.querySelector('span').textContent = `Preview error: ${error}`;
    }
  });

  // Subscribe to recording ticks
  footageState.recordingTickUnsub = window.printStation.footage.onRecordingTick(data => {
    if (data.cameraId === footageState.recordingCameraId && data.active) {
      document.getElementById('footageRecordingTimer').textContent = formatDuration(data.elapsed);
      // Update segment count display
      const segInfo = document.getElementById('footageSegmentInfo');
      if (segInfo && data.segmentCount > 0) {
        segInfo.textContent = `${data.segmentCount} segment(s)`;
      }
    }
  });

  // Subscribe to recorder events
  window.printStation.footage.onEvent('segment-complete', data => {
    if (footageState.recordingCameraId) {
      footageState.recordingSegments.push(data.file);
    }
  });

  window.printStation.footage.onEvent('reconnecting', data => {
    showFootageToast('Camera disconnected — reconnecting in 10s...', true);
  });

  window.printStation.footage.onEvent('error', data => {
    console.warn('[Footage] Recorder error:', data.error);
  });
}

function startFootagePreview(cameraId) {
  if (footageState.currentCameraId) {
    window.printStation.footage.stopPreview(footageState.currentCameraId);
  }
  footageState.currentCameraId = cameraId;
  document.getElementById('footagePreviewPlaceholder').querySelector('span').textContent = 'Connecting to camera...';
  document.getElementById('footagePreviewPlaceholder').style.display = 'flex';
  document.getElementById('footagePreviewImg').style.display = 'none';
  window.printStation.footage.startPreview(cameraId);
}

function stopFootagePreview() {
  if (footageState.currentCameraId) {
    window.printStation.footage.stopPreview(footageState.currentCameraId);
    footageState.currentCameraId = null;
  }
  document.getElementById('footagePreviewImg').style.display = 'none';
  document.getElementById('footagePreviewPlaceholder').style.display = 'flex';
  document.getElementById('footagePreviewPlaceholder').querySelector('span').textContent = 'Select a camera to see live preview';
}

async function startFootageRecording() {
  const cameraId = document.getElementById('footageCameraSelect').value;
  if (!cameraId) return;

  document.getElementById('footageStartRecBtn').disabled = true;
  document.getElementById('footageStartRecBtn').textContent = 'Connecting...';

  try {
    const result = await window.printStation.footage.startRecording(cameraId);
    footageState.recordingCameraId = cameraId;
    footageState.recordingSegments = [];
    footageState.recordingStartedAt = Date.now();

    // UI updates
    document.getElementById('footageStartRecBtn').style.display = 'none';
    document.getElementById('footageStartRecBtn').textContent = 'Start Recording';
    document.getElementById('footageStopRecBtn').style.display = '';
    document.getElementById('footageStopRecBtn').disabled = false;
    document.getElementById('footageCameraSelect').disabled = true;
    document.getElementById('footageRecordingIndicator').classList.remove('hidden');
    document.getElementById('footageRecordingTimer').textContent = '00:00';

    // Local timer fallback
    footageState.timerInterval = setInterval(() => {
      const elapsed = Math.round((Date.now() - footageState.recordingStartedAt) / 1000);
      document.getElementById('footageRecordingTimer').textContent = formatDuration(elapsed);
    }, 1000);

    showFootageToast('Recording started — saving 5-min segments');
  } catch (e) {
    document.getElementById('footageStartRecBtn').disabled = false;
    document.getElementById('footageStartRecBtn').textContent = 'Start Recording';
    showFootageToast('Failed to start recording: ' + e.message, true);
  }
}

async function stopFootageRecording() {
  if (!footageState.recordingCameraId) return;
  try {
    document.getElementById('footageStopRecBtn').disabled = true;
    const result = await window.printStation.footage.stopRecording(footageState.recordingCameraId);
    clearInterval(footageState.timerInterval);

    // Collect all segment files
    footageState.recordingSegments = (result.segments || []).map(s => {
      // segments are basenames; full paths are in outputDir
      return result.outputDir ? result.outputDir + '/' + s : s;
    });

    // Show tag form
    document.getElementById('footageRecordingIndicator').classList.add('hidden');
    document.getElementById('footageStopRecBtn').style.display = 'none';
    document.getElementById('footageStartRecBtn').style.display = '';
    document.getElementById('footageStartRecBtn').disabled = true;

    const tagForm = document.getElementById('footageRecordTagForm');
    tagForm.classList.remove('hidden');

    const segCount = footageState.recordingSegments.length;
    document.getElementById('footageRecordPreview').innerHTML =
      `<p style="margin:0;color:var(--text-muted);">Recording stopped: ${formatDuration(result.elapsed)} total &middot; ${segCount} segment(s)</p>
       ${segCount > 0 ? `<p style="margin:4px 0 0;font-size:0.8rem;color:#888;">Each segment will be uploaded individually with the same tags.</p>` : ''}`;
  } catch (e) {
    showFootageToast('Failed to stop recording: ' + e.message, true);
  }
}

async function uploadFootageRecording() {
  const segments = footageState.recordingSegments;
  if (!segments.length) {
    showFootageToast('No segments to upload', true);
    return;
  }

  const category = getSelectedPill('rec-category');
  const subcategory = getSelectedPill('rec-subcategory');
  const productName = document.getElementById('footageRecProductInput').value.trim();
  const notes = document.getElementById('footageRecNotes').value.trim();
  const tags = [category, subcategory].filter(Boolean).join(',');

  const progressEl = document.getElementById('footageRecUploadProgress');
  progressEl.classList.remove('hidden');

  let uploaded = 0;
  let failed = 0;

  for (const segPath of segments) {
    progressEl.querySelector('.footage-progress-text').textContent =
      `Uploading segment ${uploaded + 1} of ${segments.length}...`;
    try {
      await window.printStation.footage.upload(segPath, {
        category,
        subcategory,
        product_name: productName,
        tags,
        notes: notes ? `${notes} [segment ${uploaded + 1}/${segments.length}]` : `segment ${uploaded + 1}/${segments.length}`,
        source: 'print-station'
      });
      uploaded++;
    } catch (e) {
      console.error(`[Footage] Upload segment failed:`, e);
      failed++;
    }
  }

  if (failed > 0) {
    showFootageToast(`Uploaded ${uploaded}/${segments.length} segments (${failed} failed)`, true);
  } else {
    showFootageToast(`All ${uploaded} segment(s) uploaded!`);
  }
  resetRecordForm();
}

function discardFootageRecording() {
  footageState.recordingSegments = [];
  resetRecordForm();
  showFootageToast('Recording discarded');
}

function resetRecordForm() {
  footageState.recordingSegments = [];
  footageState.recordingCameraId = null;
  clearInterval(footageState.timerInterval);

  document.getElementById('footageRecordTagForm').classList.add('hidden');
  document.getElementById('footageRecUploadProgress').classList.add('hidden');
  document.getElementById('footageStartRecBtn').style.display = '';
  document.getElementById('footageStartRecBtn').disabled = !document.getElementById('footageCameraSelect').value;
  document.getElementById('footageStopRecBtn').style.display = 'none';
  document.getElementById('footageCameraSelect').disabled = false;
  document.getElementById('footageRecordingIndicator').classList.add('hidden');

  clearPillGroup('rec-category');
  clearPillGroup('rec-subcategory');
  document.getElementById('footageRecProductInput').value = '';
  document.getElementById('footageRecNotes').value = '';
}

// ============================================================================
// UPLOAD TAB
// ============================================================================
function setupFootageUploadTab() {
  const zone = document.getElementById('footageUploadZone');
  const fileInput = document.getElementById('footageFileInput');
  const uploadBtn = document.getElementById('footageUploadBtn');

  zone.addEventListener('click', () => fileInput.click());
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('dragover');
    if (e.dataTransfer.files.length) selectUploadFile(e.dataTransfer.files[0]);
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) selectUploadFile(fileInput.files[0]);
  });

  uploadBtn.addEventListener('click', uploadFootageFile);
}

function selectUploadFile(file) {
  footageState.selectedFile = file;
  document.getElementById('footageSelectedFileName').textContent = `${file.name} (${formatBytes(file.size)})`;
  document.getElementById('footageUploadBtn').disabled = false;

  // Video preview
  const preview = document.getElementById('footageUploadPreview');
  const video = document.getElementById('footageUploadVideoPreview');
  if (file.type.startsWith('video/')) {
    video.src = URL.createObjectURL(file);
    preview.classList.remove('hidden');
  } else {
    preview.classList.add('hidden');
  }
}

async function uploadFootageFile() {
  // For Electron, we need to get the file path — use dialog if drag/drop doesn't give us one
  let filePath = footageState.selectedFile?.path;
  if (!filePath) {
    // Fallback: use native dialog
    filePath = await window.printStation.footage.selectVideoFile();
    if (!filePath) return;
  }

  const category = getSelectedPill('upload-category');
  const subcategory = getSelectedPill('upload-subcategory');
  const productName = document.getElementById('footageUploadProductInput').value.trim();
  const notes = document.getElementById('footageUploadNotes').value.trim();

  const progressEl = document.getElementById('footageUploadProgress');
  progressEl.classList.remove('hidden');
  progressEl.querySelector('.footage-progress-text').textContent = 'Uploading...';

  try {
    const tags = [category, subcategory].filter(Boolean).join(',');
    await window.printStation.footage.upload(filePath, {
      category,
      subcategory,
      product_name: productName,
      tags,
      notes,
      source: 'print-station'
    });
    showFootageToast('Clip uploaded successfully!');
    resetUploadForm();
  } catch (e) {
    showFootageToast('Upload failed: ' + e.message, true);
    progressEl.classList.add('hidden');
  }
}

function resetUploadForm() {
  footageState.selectedFile = null;
  document.getElementById('footageFileInput').value = '';
  document.getElementById('footageSelectedFileName').textContent = '';
  document.getElementById('footageUploadBtn').disabled = true;
  document.getElementById('footageUploadProgress').classList.add('hidden');
  document.getElementById('footageUploadPreview').classList.add('hidden');
  clearPillGroup('upload-category');
  clearPillGroup('upload-subcategory');
  document.getElementById('footageUploadProductInput').value = '';
  document.getElementById('footageUploadNotes').value = '';
}

// ============================================================================
// LIBRARY TAB
// ============================================================================
function setupFootageLibraryTab() {
  document.getElementById('footageFilterCategory').addEventListener('change', loadFootageLibrary);
  document.getElementById('footageFilterStatus').addEventListener('change', loadFootageLibrary);
  document.getElementById('footageSearchInput').addEventListener('input', debounce(loadFootageLibrary, 300));
  document.getElementById('footageRefreshBtn').addEventListener('click', loadFootageLibrary);
}

async function loadFootageLibrary() {
  const category = document.getElementById('footageFilterCategory').value;
  const status = document.getElementById('footageFilterStatus').value;
  const search = document.getElementById('footageSearchInput').value.trim();

  try {
    const [clipsResult, stats] = await Promise.all([
      window.printStation.footage.listClips({ category, status, search, limit: 200 }),
      window.printStation.footage.getStats()
    ]);

    const clips = clipsResult.items || clipsResult || [];
    footageState.clips = clips;

    // Stats
    document.getElementById('footageStatTotal').textContent = stats.total_clips || 0;
    document.getElementById('footageStatStorage').textContent = formatBytes(stats.total_bytes || 0);
    document.getElementById('footageStatRaw').textContent = stats.raw_count || 0;

    // Grid
    renderFootageGrid(clips);
  } catch (e) {
    console.error('[Footage] Load library error:', e);
    document.getElementById('footageClipGrid').innerHTML =
      `<p class="muted" style="padding:24px;">Failed to load clips: ${e.message}</p>`;
  }
}

async function renderFootageGrid(clips) {
  const grid = document.getElementById('footageClipGrid');
  if (!clips.length) {
    grid.innerHTML = '<p class="muted" style="padding:24px;">No clips found</p>';
    return;
  }

  // Resolve thumbnail URLs
  const thumbPromises = clips.map(async clip => {
    if (clip.thumbnail_path) {
      try {
        const fname = clip.thumbnail_path.split('/').pop();
        return await window.printStation.footage.getThumbUrl(fname);
      } catch (_) {}
    }
    return null;
  });
  const thumbUrls = await Promise.all(thumbPromises);

  grid.innerHTML = clips.map((clip, i) => {
    const thumb = thumbUrls[i];
    const statusClass = clip.status === 'raw' ? 'status-raw' : clip.status === 'ready' ? 'status-ready' : 'status-used';
    return `
      <div class="footage-clip-card" data-clipid="${clip.id}">
        <div class="footage-clip-thumb">
          ${thumb ? `<img src="${thumb}" alt="${clip.original_name || ''}" loading="lazy" />` : '<span class="footage-thumb-placeholder">🎬</span>'}
        </div>
        <div class="footage-clip-info">
          <span class="footage-clip-name" title="${clip.original_name || clip.filename}">${clip.original_name || clip.filename}</span>
          <div class="footage-clip-meta">
            ${clip.category ? `<span class="footage-badge">${clip.category}</span>` : ''}
            <span class="footage-badge ${statusClass}">${clip.status || 'raw'}</span>
            ${clip.duration_seconds ? `<span>${formatDuration(clip.duration_seconds)}</span>` : ''}
            <span>${formatBytes(clip.file_size || 0)}</span>
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Click handlers
  grid.querySelectorAll('.footage-clip-card').forEach(card => {
    card.addEventListener('click', () => openFootageDetail(card.dataset.clipid));
  });
}

async function openFootageDetail(clipId) {
  try {
    const clip = await window.printStation.footage.getClip(clipId);
    if (!clip) return;

    let videoUrl = '';
    try { videoUrl = await window.printStation.footage.getFileUrl(clip.filename); } catch (_) {}

    const modal = document.getElementById('footageDetailModal');
    const body = document.getElementById('footageModalBody');
    document.getElementById('footageModalTitle').textContent = clip.original_name || clip.filename;

    body.innerHTML = `
      ${videoUrl ? `<video controls style="width:100%;max-height:300px;border-radius:6px;background:#000;" src="${videoUrl}"></video>` : ''}
      <div class="footage-detail-grid">
        <div><small class="muted">Category</small><br/>${clip.category || '-'}</div>
        <div><small class="muted">What's Shown</small><br/>${clip.subcategory || '-'}</div>
        <div><small class="muted">Duration</small><br/>${clip.duration_seconds ? formatDuration(clip.duration_seconds) : '-'}</div>
        <div><small class="muted">Size</small><br/>${formatBytes(clip.file_size || 0)}</div>
        <div><small class="muted">Resolution</small><br/>${clip.width && clip.height ? `${clip.width}x${clip.height}` : '-'}</div>
        <div><small class="muted">Product</small><br/>${clip.product_name || '-'}</div>
        <div><small class="muted">Source</small><br/>${clip.source || '-'}</div>
        <div><small class="muted">Created</small><br/>${clip.created_at ? new Date(clip.created_at).toLocaleString() : '-'}</div>
      </div>
      <div style="margin-top:12px;">
        <label class="footage-label">Status</label>
        <select id="footageDetailStatus" class="select-input">
          <option value="raw" ${clip.status === 'raw' ? 'selected' : ''}>Raw</option>
          <option value="ready" ${clip.status === 'ready' ? 'selected' : ''}>Ready</option>
          <option value="used" ${clip.status === 'used' ? 'selected' : ''}>Used</option>
        </select>
      </div>
      <div style="margin-top:8px;">
        <label class="footage-label">Notes</label>
        <textarea id="footageDetailNotes" class="text-input" rows="2">${clip.notes || ''}</textarea>
      </div>
      <div style="margin-top:12px;display:flex;gap:8px;">
        <button id="footageDetailSaveBtn" class="primary small">Save Changes</button>
        <button id="footageDetailDeleteBtn" class="danger small">Delete Clip</button>
      </div>
    `;

    document.getElementById('footageDetailSaveBtn').addEventListener('click', async () => {
      const status = document.getElementById('footageDetailStatus').value;
      const notes = document.getElementById('footageDetailNotes').value;
      try {
        await window.printStation.footage.updateClip(clipId, { status, notes });
        showFootageToast('Clip updated');
        modal.classList.add('hidden');
        loadFootageLibrary();
      } catch (e) {
        showFootageToast('Update failed: ' + e.message, true);
      }
    });

    document.getElementById('footageDetailDeleteBtn').addEventListener('click', async () => {
      const confirmed = await window.printStation.showConfirm('Delete this clip permanently?', 'Delete Clip');
      if (!confirmed) return;
      try {
        await window.printStation.footage.deleteClip(clipId);
        showFootageToast('Clip deleted');
        modal.classList.add('hidden');
        loadFootageLibrary();
      } catch (e) {
        showFootageToast('Delete failed: ' + e.message, true);
      }
    });

    modal.classList.remove('hidden');
  } catch (e) {
    showFootageToast('Failed to load clip details: ' + e.message, true);
  }
}

function setupFootageModal() {
  const modal = document.getElementById('footageDetailModal');
  document.getElementById('footageModalCloseBtn').addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', e => {
    if (e.target === modal) modal.classList.add('hidden');
  });
}

// ============================================================================
// CAMERAS TAB
// ============================================================================
function setupFootageCamerasTab() {
  document.getElementById('footageAddCameraBtn').addEventListener('click', () => {
    openCameraEditor(null);
  });
}

async function loadFootageCameras() {
  try {
    const cameras = await window.printStation.footage.listCameras();
    footageState.cameras = cameras;
    populateCameraSelect(cameras);
  } catch (e) {
    console.error('[Footage] Load cameras error:', e);
  }
}

function populateCameraSelect(cameras) {
  const select = document.getElementById('footageCameraSelect');
  const currentVal = select.value;
  select.innerHTML = '<option value="">Select camera...</option>';
  cameras.filter(c => c.enabled !== false).forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name + (c.rotation ? ` (${c.rotation}\u00B0)` : '');
    select.appendChild(opt);
  });
  if (currentVal) select.value = currentVal;
}

async function loadFootageCameraList() {
  try {
    const cameras = await window.printStation.footage.listCameras();
    footageState.cameras = cameras;
    const list = document.getElementById('footageCameraList');

    if (!cameras.length) {
      list.innerHTML = '<p class="muted">No cameras configured. Click "Add Camera" to get started.</p>';
      return;
    }

    list.innerHTML = cameras.map(c => `
      <div class="footage-camera-card">
        <div class="footage-camera-info">
          <strong>${c.name}</strong>
          <span class="muted">${c.rtspUrl || `ONVIF: ${c.onvifHost || 'not set'}:${c.onvifPort || 8000}`}</span>
          <span class="muted">Rotation: ${c.rotation || 0}&deg;</span>
        </div>
        <div class="footage-camera-actions">
          <button class="secondary small" data-cam-test="${c.id}">Test</button>
          <button class="secondary small" data-cam-edit="${c.id}">Edit</button>
          <button class="danger small" data-cam-remove="${c.id}">Remove</button>
        </div>
      </div>
    `).join('');

    list.querySelectorAll('[data-cam-test]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const cam = cameras.find(c => c.id === btn.dataset.camTest);
        if (!cam) return;
        btn.textContent = 'Testing...';
        btn.disabled = true;
        try {
          const result = await window.printStation.footage.testCamera(cam);
          showFootageToast(result.success ? 'Connection OK!' : `Failed: ${result.error}`, !result.success);
        } catch (e) {
          showFootageToast('Test failed: ' + e.message, true);
        }
        btn.textContent = 'Test';
        btn.disabled = false;
      });
    });

    list.querySelectorAll('[data-cam-edit]').forEach(btn => {
      btn.addEventListener('click', () => {
        const cam = cameras.find(c => c.id === btn.dataset.camEdit);
        if (cam) openCameraEditor(cam);
      });
    });

    list.querySelectorAll('[data-cam-remove]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const confirmed = await window.printStation.showConfirm('Remove this camera?', 'Remove Camera');
        if (!confirmed) return;
        try {
          await window.printStation.footage.removeCamera(btn.dataset.camRemove);
          showFootageToast('Camera removed');
          loadFootageCameraList();
          loadFootageCameras();
        } catch (e) {
          showFootageToast('Remove failed: ' + e.message, true);
        }
      });
    });
  } catch (e) {
    console.error('[Footage] Camera list error:', e);
  }
}

function openCameraEditor(cam) {
  const isNew = !cam;
  const modal = document.getElementById('footageDetailModal');
  const body = document.getElementById('footageModalBody');
  document.getElementById('footageModalTitle').textContent = isNew ? 'Add Camera' : 'Edit Camera';

  body.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:8px;">
      <label class="footage-label">Camera Name</label>
      <input type="text" id="camEditorName" class="text-input" value="${cam?.name || ''}" placeholder="Workshop Camera" />

      <label class="footage-label">RTSP URL (manual)</label>
      <input type="text" id="camEditorRtsp" class="text-input" value="${cam?.rtspUrl || ''}" placeholder="rtsp://user:pass@192.168.0.x:554/stream1" />
      <small class="muted">Leave blank to auto-discover via ONVIF below</small>

      <label class="footage-label">ONVIF Host</label>
      <div style="display:flex;gap:8px;">
        <input type="text" id="camEditorOnvifHost" class="text-input" value="${cam?.onvifHost || ''}" placeholder="192.168.0.145" style="flex:2;" />
        <input type="number" id="camEditorOnvifPort" class="text-input" value="${cam?.onvifPort || 8000}" placeholder="8000" style="flex:1;" title="ONVIF port" />
      </div>

      <div style="display:flex;gap:8px;">
        <div style="flex:1;">
          <label class="footage-label">ONVIF User</label>
          <input type="text" id="camEditorOnvifUser" class="text-input" value="${cam?.onvifUser || ''}" placeholder="admin" />
        </div>
        <div style="flex:1;">
          <label class="footage-label">ONVIF Password</label>
          <input type="text" id="camEditorOnvifPass" class="text-input" value="${cam?.onvifPass || ''}" placeholder="password" />
        </div>
      </div>

      <div style="display:flex;gap:8px;">
        <div style="flex:1;">
          <label class="footage-label">ONVIF Profile Token</label>
          <input type="text" id="camEditorOnvifProfile" class="text-input" value="${cam?.onvifProfile || 'PROFILE_16415'}" placeholder="PROFILE_16415" />
        </div>
        <div style="flex:1;">
          <label class="footage-label">Stream</label>
          <select id="camEditorStream" class="select-input">
            <option value="main" ${(cam?.stream || 'main') === 'main' ? 'selected' : ''}>Main (high res)</option>
            <option value="sub" ${cam?.stream === 'sub' ? 'selected' : ''}>Sub (low res)</option>
          </select>
        </div>
      </div>

      <label class="footage-label">Rotation</label>
      <select id="camEditorRotation" class="select-input">
        <option value="0" ${(cam?.rotation || 0) === 0 ? 'selected' : ''}>0&deg; (no rotation)</option>
        <option value="90" ${cam?.rotation === 90 ? 'selected' : ''}>90&deg; (portrait for TikTok)</option>
        <option value="180" ${cam?.rotation === 180 ? 'selected' : ''}>180&deg;</option>
        <option value="270" ${cam?.rotation === 270 ? 'selected' : ''}>270&deg;</option>
      </select>

      <div style="display:flex;gap:8px;margin-top:8px;">
        <button id="camEditorSaveBtn" class="primary small">${isNew ? 'Add Camera' : 'Save'}</button>
        <button id="camEditorDiscoverBtn" class="secondary small">Auto-Discover RTSP</button>
        <button id="camEditorTestBtn" class="secondary small">Test Connection</button>
      </div>
      <div id="camEditorStatus" class="muted" style="margin-top:4px;"></div>
    </div>
  `;

  document.getElementById('camEditorSaveBtn').addEventListener('click', async () => {
    const data = {
      name: document.getElementById('camEditorName').value.trim() || 'Camera',
      rtspUrl: document.getElementById('camEditorRtsp').value.trim(),
      onvifHost: document.getElementById('camEditorOnvifHost').value.trim(),
      onvifPort: parseInt(document.getElementById('camEditorOnvifPort').value) || 8000,
      onvifUser: document.getElementById('camEditorOnvifUser').value.trim(),
      onvifPass: document.getElementById('camEditorOnvifPass').value.trim(),
      onvifProfile: document.getElementById('camEditorOnvifProfile').value.trim(),
      stream: document.getElementById('camEditorStream').value,
      rotation: parseInt(document.getElementById('camEditorRotation').value) || 0
    };
    try {
      if (isNew) {
        await window.printStation.footage.addCamera(data);
        showFootageToast('Camera added');
      } else {
        await window.printStation.footage.updateCamera(cam.id, data);
        showFootageToast('Camera updated');
      }
      modal.classList.add('hidden');
      loadFootageCameraList();
      loadFootageCameras();
    } catch (e) {
      showFootageToast('Save failed: ' + e.message, true);
    }
  });

  document.getElementById('camEditorDiscoverBtn').addEventListener('click', async () => {
    const status = document.getElementById('camEditorStatus');
    status.innerHTML = '<span style="color:var(--accent);">Discovering camera...</span>';
    try {
      const result = await window.printStation.footage.discoverCamera({
        onvifHost: document.getElementById('camEditorOnvifHost').value.trim(),
        onvifPort: parseInt(document.getElementById('camEditorOnvifPort').value) || 8000,
        onvifUser: document.getElementById('camEditorOnvifUser').value.trim(),
        onvifPass: document.getElementById('camEditorOnvifPass').value.trim()
      });
      if (result.success) {
        // Show device info
        const dev = result.device || {};
        let html = '';
        if (dev.manufacturer) {
          html += `<div style="margin-bottom:6px;"><strong>${dev.manufacturer} ${dev.model || ''}</strong>`;
          if (dev.firmwareVersion) html += ` <span class="muted">(FW: ${dev.firmwareVersion})</span>`;
          html += '</div>';
          // Auto-fill camera name if empty
          const nameField = document.getElementById('camEditorName');
          if (!nameField.value.trim()) {
            nameField.value = `${dev.manufacturer} ${dev.model || ''}`.trim();
          }
        }

        // Show discovered profiles as selectable cards
        if (result.profiles && result.profiles.length > 0) {
          html += '<div style="margin-top:6px;"><strong>Profiles found:</strong></div>';
          html += '<div style="display:flex;flex-direction:column;gap:4px;margin-top:4px;">';
          for (const p of result.profiles) {
            const v = p.video || {};
            const res = v.width && v.height ? `${v.width}x${v.height}` : '?';
            const enc = v.encoding || '?';
            const fps = v.fps ? `${v.fps}fps` : '';
            const bitrate = v.bitrate ? `${v.bitrate}kbps` : '';
            const label = p.name || p.token;
            const details = [enc, res, fps, bitrate].filter(Boolean).join(' · ');
            html += `<button class="secondary small cam-profile-pick"
              data-token="${p.token}" data-rtsp="${p.rtspUrl || ''}"
              style="text-align:left;padding:6px 10px;display:flex;justify-content:space-between;align-items:center;">
              <span><strong>${label}</strong></span>
              <span class="muted" style="font-size:0.8rem;">${details}</span>
            </button>`;
          }
          html += '</div>';
          html += '<small class="muted">Click a profile to select it</small>';
        }

        status.innerHTML = html;

        // Wire up profile selection buttons
        status.querySelectorAll('.cam-profile-pick').forEach(btn => {
          btn.addEventListener('click', () => {
            const token = btn.dataset.token;
            const rtsp = btn.dataset.rtsp;
            document.getElementById('camEditorOnvifProfile').value = token;
            if (rtsp) document.getElementById('camEditorRtsp').value = rtsp;
            // Highlight selected
            status.querySelectorAll('.cam-profile-pick').forEach(b => b.style.borderColor = '');
            btn.style.borderColor = 'var(--accent)';
            showFootageToast(`Selected profile: ${token}`);
          });
        });

        // Auto-select first profile with best resolution
        if (result.profiles.length > 0) {
          const best = result.profiles.reduce((a, b) => {
            const aRes = (a.video?.width || 0) * (a.video?.height || 0);
            const bRes = (b.video?.width || 0) * (b.video?.height || 0);
            return bRes > aRes ? b : a;
          });
          document.getElementById('camEditorOnvifProfile').value = best.token;
          if (best.rtspUrl) document.getElementById('camEditorRtsp').value = best.rtspUrl;
        }
      } else {
        status.innerHTML = `<span style="color:var(--danger);">${result.error || 'Discovery failed'}</span>`;
      }
    } catch (e) {
      status.innerHTML = `<span style="color:var(--danger);">Error: ${e.message}</span>`;
    }
  });

  document.getElementById('camEditorTestBtn').addEventListener('click', async () => {
    const status = document.getElementById('camEditorStatus');
    status.textContent = 'Testing connection...';
    try {
      const result = await window.printStation.footage.testCamera({
        rtspUrl: document.getElementById('camEditorRtsp').value.trim(),
        onvifHost: document.getElementById('camEditorOnvifHost').value.trim(),
        onvifPort: parseInt(document.getElementById('camEditorOnvifPort').value) || 8000,
        onvifUser: document.getElementById('camEditorOnvifUser').value.trim(),
        onvifPass: document.getElementById('camEditorOnvifPass').value.trim(),
        onvifProfile: document.getElementById('camEditorOnvifProfile').value.trim()
      });
      status.textContent = result.success ? 'Connection successful!' : `Failed: ${result.error}`;
    } catch (e) {
      status.textContent = 'Error: ' + e.message;
    }
  });

  modal.classList.remove('hidden');
}

// ============================================================================
// Products (for autocomplete)
// ============================================================================
async function loadFootageProducts() {
  try {
    const products = await window.printStation.footage.getProducts();
    footageState.products = products.items || products || [];
    // Populate datalists
    const items = footageState.products;
    ['footageRecProductList', 'footageUploadProductList'].forEach(listId => {
      const dl = document.getElementById(listId);
      if (!dl) return;
      dl.innerHTML = items.map(p => `<option value="${p.title || p.name || ''}">`).join('');
    });
  } catch (e) {
    console.warn('[Footage] Products load error:', e.message);
  }
}

// ============================================================================
// FFmpeg Status
// ============================================================================
async function checkFfmpegStatus() {
  const el = document.getElementById('footageFfmpegStatus');
  const lines = [];
  try {
    const ffResult = await window.printStation.footage.checkFfmpeg();
    if (ffResult.available) {
      lines.push(`<span style="color:var(--success);">ffmpeg OK</span> <small class="muted">${ffResult.version}</small>`);
    } else {
      lines.push('<span style="color:var(--danger);">ffmpeg not found — install to C:\\ffmpeg\\bin or add to PATH</span>');
    }
  } catch (_) {
    lines.push('<span style="color:var(--danger);">ffmpeg check failed</span>');
  }
  try {
    const pyResult = await window.printStation.footage.checkPython();
    if (pyResult.python && pyResult.onvifZeep) {
      lines.push(`<span style="color:var(--success);">Python + onvif-zeep OK</span> <small class="muted">${pyResult.pythonVersion}</small>`);
    } else if (pyResult.python) {
      lines.push('<span style="color:var(--warning, #e65100);">Python found but onvif-zeep missing — run: pip install onvif-zeep</span>');
    } else {
      lines.push('<span style="color:var(--danger);">Python not found — needed for ONVIF camera discovery</span>');
    }
  } catch (_) {}
  el.innerHTML = lines.join('<br/>');
}

// ============================================================================
// Helpers
// ============================================================================
function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatDuration(sec) {
  if (!sec && sec !== 0) return '-';
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${String(m).padStart(2, '0')}:${String(rs).padStart(2, '0')}`;
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function showFootageToast(msg, isError = false) {
  // Reuse existing toast if available, else create one
  let toast = document.getElementById('footageToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'footageToast';
    toast.className = 'footage-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.background = isError ? 'var(--danger, #d32f2f)' : 'var(--success, #2e7d32)';
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2500);
}
