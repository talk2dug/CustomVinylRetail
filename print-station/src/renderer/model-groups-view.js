/**
 * Model Groups View
 *
 * Lets users create and manage curated groups of human models
 * for use with the apparel pipeline.
 */

(function () {
  const mgState = {
    initialized: false,
    groups: [],
    selectedGroupId: null,
    selectedGroupMembers: [],
    allModels: [],        // cached for the add-models modal
    modalSelected: new Set()
  };

  const NO_IMG = "data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 130%22><rect fill=%22%231a1a2e%22 width=%22100%22 height=%22130%22/><text x=%2250%22 y=%2265%22 fill=%22%23555%22 text-anchor=%22middle%22 font-size=%228%22>No Image</text></svg>";

  function getThumbUrl(model) {
    const p = model.thumbnailPath || model.thumbnail_path || model.optimizedPath || model.optimized_path || model.filePath || model.file_path || '';
    if (!p) return NO_IMG;
    if (p.startsWith('http') || p.startsWith('data:')) return p;
    // Server-relative paths like /library/human-models/... need the server base URL prepended
    const serverBase = window.printStationConfig?.serverBaseUrl || window.state?.config?.serverBaseUrl || '';
    if (serverBase && p.startsWith('/')) return serverBase + p;
    if (typeof resolveArtworkUrl === 'function') return resolveArtworkUrl(p, { width: 200, quality: 75 }) || NO_IMG;
    return p;
  }

  function esc(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }

  // ── API helpers ──────────────────────────────────────────────────────
  const api = () => window.printStation?.modelGroups;

  async function loadGroups() {
    try {
      const resp = await api().list();
      mgState.groups = resp.groups || resp || [];
    } catch (err) {
      console.error('[ModelGroups] load failed:', err);
      mgState.groups = [];
    }
    renderGroupList();
  }

  async function loadGroupDetail(groupId) {
    try {
      const resp = await api().get(groupId);
      mgState.selectedGroupId = groupId;
      mgState.selectedGroupMembers = resp.members || [];
      renderGroupDetail(resp.group, resp.members || []);
    } catch (err) {
      console.error('[ModelGroups] detail load failed:', err);
    }
  }

  // ── Group List (left panel) ──────────────────────────────────────────
  function renderGroupList() {
    const container = document.getElementById('mgGroupCards');
    if (!container) return;

    if (!mgState.groups.length) {
      container.innerHTML = '<p style="color:var(--text-secondary);font-size:13px;padding:12px;">No groups yet. Click "+ New Group" to create one.</p>';
      return;
    }

    container.innerHTML = mgState.groups.map(g => {
      const isSelected = g.id === mgState.selectedGroupId;
      return `
        <div class="mg-group-card ${isSelected ? 'mg-selected' : ''}" data-group-id="${esc(g.id)}"
             style="padding:10px 12px;border:1px solid ${isSelected ? 'var(--accent)' : 'var(--border)'};border-radius:8px;cursor:pointer;background:${isSelected ? 'var(--bg-secondary)' : 'var(--bg-primary)'};transition:border-color 0.15s;">
          <div style="font-weight:600;font-size:14px;">${esc(g.name)}</div>
          <div style="font-size:12px;color:var(--text-secondary);margin-top:2px;">${g.member_count || 0} model${(g.member_count || 0) === 1 ? '' : 's'}</div>
          ${g.description ? `<div style="font-size:11px;color:var(--text-secondary);margin-top:4px;opacity:0.7;">${esc(g.description).substring(0, 60)}</div>` : ''}
        </div>`;
    }).join('');

    container.querySelectorAll('.mg-group-card').forEach(card => {
      card.addEventListener('click', () => loadGroupDetail(card.dataset.groupId));
    });
  }

  // ── Group Detail (right panel) ───────────────────────────────────────
  function renderGroupDetail(group, members) {
    const placeholder = document.getElementById('mgDetailPlaceholder');
    const content = document.getElementById('mgDetailContent');
    if (!group) {
      if (placeholder) placeholder.style.display = '';
      if (content) content.style.display = 'none';
      return;
    }
    if (placeholder) placeholder.style.display = 'none';
    if (content) content.style.display = '';

    document.getElementById('mgDetailName').textContent = group.name;
    document.getElementById('mgDetailDesc').textContent = group.description || '';
    document.getElementById('mgMemberCount').textContent = `${members.length} model${members.length === 1 ? '' : 's'} in this group`;

    const grid = document.getElementById('mgMemberGrid');
    if (!members.length) {
      grid.innerHTML = '<p style="color:var(--text-secondary);font-size:13px;grid-column:1/-1;text-align:center;padding:40px;">No models in this group yet. Click "+ Add Models" to get started.</p>';
      return;
    }

    grid.innerHTML = members.map(m => `
      <div class="mg-member-card" style="position:relative;border:1px solid var(--border);border-radius:8px;overflow:hidden;background:var(--bg-secondary);min-height:200px;">
        <img src="${esc(getThumbUrl(m))}" alt="${esc(m.title || '')}"
             style="width:100%;height:180px;min-height:180px;object-fit:cover;display:block;background:#1a1a2e;"
             onerror="this.style.height='180px';this.style.background='#1a1a2e';" />
        <div style="padding:6px 8px;">
          <div style="font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(m.title || m.id)}</div>
          <div style="font-size:10px;color:var(--text-secondary);margin-top:2px;">${esc(m.style || '')} ${m.demographic ? '/ ' + esc(m.demographic) : ''}</div>
        </div>
        <button class="mg-remove-btn" data-model-id="${esc(m.id)}" title="Remove from group"
                style="position:absolute;top:4px;right:4px;background:rgba(0,0,0,0.65);border:none;color:#ff6b6b;cursor:pointer;width:24px;height:24px;border-radius:50%;font-size:14px;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity 0.15s;">x</button>
      </div>
    `).join('');

    // Show remove button on hover
    grid.querySelectorAll('.mg-member-card').forEach(card => {
      const btn = card.querySelector('.mg-remove-btn');
      card.addEventListener('mouseenter', () => btn.style.opacity = '1');
      card.addEventListener('mouseleave', () => btn.style.opacity = '0');
    });

    // Remove model handler
    grid.querySelectorAll('.mg-remove-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const modelId = btn.dataset.modelId;
        try {
          await api().removeModels(mgState.selectedGroupId, [modelId]);
          await loadGroupDetail(mgState.selectedGroupId);
          await loadGroups(); // refresh counts
        } catch (err) {
          console.error('[ModelGroups] remove failed:', err);
        }
      });
    });
  }

  // ── Inline prompt (Electron blocks window.prompt) ────────────────────
  function showInputModal(title, fields, callback) {
    const existing = document.getElementById('mgInputModal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'mgInputModal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;';
    modal.innerHTML = `
      <div style="background:var(--bg-primary);border:1px solid var(--border);border-radius:12px;padding:20px;width:360px;max-width:90vw;">
        <h3 style="margin:0 0 12px;">${esc(title)}</h3>
        ${fields.map((f, i) => `
          <label style="display:block;margin-bottom:10px;">
            <span style="font-size:13px;color:var(--text-secondary);">${esc(f.label)}</span>
            <input id="mgInput${i}" type="text" value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}"
              style="display:block;width:100%;margin-top:4px;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--bg-secondary);color:var(--text-primary);box-sizing:border-box;">
          </label>
        `).join('')}
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;">
          <button id="mgInputCancel" class="btn" style="padding:6px 16px;">Cancel</button>
          <button id="mgInputOk" class="btn btn-primary" style="padding:6px 16px;">OK</button>
        </div>
      </div>`;
    document.body.appendChild(modal);

    const firstInput = modal.querySelector('input');
    if (firstInput) setTimeout(() => firstInput.focus(), 50);

    modal.querySelector('#mgInputCancel').onclick = () => { modal.remove(); };
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    modal.querySelector('#mgInputOk').onclick = () => {
      const values = fields.map((_, i) => document.getElementById(`mgInput${i}`).value.trim());
      modal.remove();
      callback(values);
    };
    // Enter key submits
    modal.querySelectorAll('input').forEach(inp => {
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') modal.querySelector('#mgInputOk').click();
      });
    });
  }

  // ── Create Group ─────────────────────────────────────────────────────
  function handleCreateGroup() {
    showInputModal('New Group', [
      { label: 'Group name', placeholder: 'e.g. Pinup Girls' },
      { label: 'Description (optional)', placeholder: '' }
    ], async ([name, description]) => {
      if (!name) return;
      try {
        const resp = await api().create({ name, description });
        await loadGroups();
        if (resp.group?.id) loadGroupDetail(resp.group.id);
      } catch (err) {
        showInputModal('Error', [{ label: 'Failed to create group: ' + (err.message || err), value: '' }], () => {});
      }
    });
  }

  // ── Edit Group ───────────────────────────────────────────────────────
  function handleEditGroup() {
    if (!mgState.selectedGroupId) return;
    const current = mgState.groups.find(g => g.id === mgState.selectedGroupId);
    showInputModal('Edit Group', [
      { label: 'Group name', value: current?.name || '' },
      { label: 'Description', value: current?.description || '' }
    ], async ([name, description]) => {
      if (!name) return;
      try {
        await api().update(mgState.selectedGroupId, { name, description });
        await loadGroups();
        await loadGroupDetail(mgState.selectedGroupId);
      } catch (err) {
        console.error('Failed to update group:', err);
      }
    });
  }

  // ── Delete Group ─────────────────────────────────────────────────────
  async function handleDeleteGroup() {
    if (!mgState.selectedGroupId) return;
    const current = mgState.groups.find(g => g.id === mgState.selectedGroupId);
    showInputModal(`Delete "${current?.name}"?`, [
      { label: 'Type "delete" to confirm', placeholder: 'delete' }
    ], async ([val]) => {
      if (val !== 'delete') return;
      try {
        await api().delete(mgState.selectedGroupId);
        mgState.selectedGroupId = null;
        renderGroupDetail(null);
        await loadGroups();
      } catch (err) {
        console.error('Failed to delete group:', err);
      }
    });
  }

  // ── Add Models Modal ─────────────────────────────────────────────────
  async function openAddModelsModal() {
    const modal = document.getElementById('mgAddModelsModal');
    if (!modal) return;
    modal.style.display = 'flex';
    mgState.modalSelected.clear();
    updateModalSelectedCount();

    // Fetch all models if not cached
    if (!mgState.allModels.length) {
      try {
        const resp = await window.printStation.humanModels.list({ limit: 2000, activeOnly: true });
        mgState.allModels = resp.models || resp.items || resp || [];
      } catch (err) {
        console.error('[ModelGroups] model list fetch failed:', err);
      }
    }

    renderModalGrid();
  }

  function closeAddModelsModal() {
    const modal = document.getElementById('mgAddModelsModal');
    if (modal) modal.style.display = 'none';
    mgState.modalSelected.clear();
  }

  function renderModalGrid() {
    const grid = document.getElementById('mgModalGrid');
    if (!grid) return;

    const search = (document.getElementById('mgModelSearch')?.value || '').toLowerCase();
    const styleFilter = document.getElementById('mgModelStyleFilter')?.value || '';
    const genderFilter = document.getElementById('mgModelGenderFilter')?.value || '';

    // Exclude models already in the group
    const existingIds = new Set(mgState.selectedGroupMembers.map(m => m.id));

    const filtered = mgState.allModels.filter(m => {
      if (existingIds.has(m.id)) return false;
      if (search && !(m.title || '').toLowerCase().includes(search) && !(m.style || '').toLowerCase().includes(search) && !(m.demographic || '').toLowerCase().includes(search)) return false;
      if (styleFilter && m.style !== styleFilter) return false;
      if (genderFilter && m.gender !== genderFilter) return false;
      return true;
    });

    if (!filtered.length) {
      grid.innerHTML = '<p style="color:var(--text-secondary);grid-column:1/-1;text-align:center;padding:40px;">No matching models found</p>';
      return;
    }

    grid.innerHTML = filtered.map(m => {
      const selected = mgState.modalSelected.has(m.id);
      return `
        <div class="mg-modal-model ${selected ? 'mg-modal-selected' : ''}" data-model-id="${esc(m.id)}"
             style="border:2px solid ${selected ? 'var(--accent)' : 'var(--border)'};border-radius:8px;overflow:hidden;cursor:pointer;position:relative;background:var(--bg-secondary);transition:border-color 0.12s;min-height:170px;">
          <img src="${esc(getThumbUrl(m))}" alt="${esc(m.title || '')}"
               style="width:100%;height:140px;min-height:140px;object-fit:cover;display:block;background:#1a1a2e;"
               onerror="this.style.height='140px';this.style.background='#1a1a2e';" />
          ${selected ? '<div style="position:absolute;top:4px;right:4px;background:var(--accent);color:white;width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:bold;">&#10003;</div>' : ''}
          <div style="padding:4px 6px;">
            <div style="font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(m.title || m.id)}</div>
            <div style="font-size:10px;color:var(--text-secondary);">${esc(m.style || 'untagged')}</div>
          </div>
        </div>`;
    }).join('');

    grid.querySelectorAll('.mg-modal-model').forEach(card => {
      card.addEventListener('click', () => {
        const mid = card.dataset.modelId;
        if (mgState.modalSelected.has(mid)) {
          mgState.modalSelected.delete(mid);
        } else {
          mgState.modalSelected.add(mid);
        }
        renderModalGrid(); // re-render to show selection state
      });
    });

    updateModalSelectedCount();
  }

  function updateModalSelectedCount() {
    const countEl = document.getElementById('mgModalSelectedCount');
    const addBtn = document.getElementById('mgModalAddBtn');
    const n = mgState.modalSelected.size;
    if (countEl) countEl.textContent = `${n} selected`;
    if (addBtn) addBtn.disabled = n === 0;
  }

  async function handleModalAdd() {
    if (!mgState.modalSelected.size || !mgState.selectedGroupId) return;
    const modelIds = Array.from(mgState.modalSelected);
    try {
      await api().addModels(mgState.selectedGroupId, modelIds);
      closeAddModelsModal();
      await loadGroupDetail(mgState.selectedGroupId);
      await loadGroups(); // refresh counts
    } catch (err) {
      console.error('Failed to add models:', err);
    }
  }

  // ── Init ─────────────────────────────────────────────────────────────
  function init() {
    // Always re-bind events (DOM elements are fresh after view switch)
    console.log('[ModelGroups] init called');
    // Toolbar
    const newBtn = document.getElementById('mgNewGroupBtn');
    console.log('[ModelGroups] newBtn:', newBtn);
    if (newBtn) { newBtn.onclick = () => { console.log('[ModelGroups] New Group clicked'); handleCreateGroup(); }; }

    // Detail buttons
    const editBtn = document.getElementById('mgEditGroupBtn');
    if (editBtn) editBtn.onclick = handleEditGroup;
    const addBtn = document.getElementById('mgAddModelsBtn');
    if (addBtn) addBtn.onclick = openAddModelsModal;
    const delBtn = document.getElementById('mgDeleteGroupBtn');
    if (delBtn) delBtn.onclick = handleDeleteGroup;

    // Modal controls
    const closeBtn = document.getElementById('mgModalCloseBtn');
    if (closeBtn) closeBtn.onclick = closeAddModelsModal;
    const modalAddBtn = document.getElementById('mgModalAddBtn');
    if (modalAddBtn) modalAddBtn.onclick = handleModalAdd;

    // Modal filters
    let searchTimer;
    const searchEl = document.getElementById('mgModelSearch');
    if (searchEl) searchEl.oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderModalGrid, 250); };
    const styleFilter = document.getElementById('mgModelStyleFilter');
    if (styleFilter) styleFilter.onchange = renderModalGrid;
    const genderFilter = document.getElementById('mgModelGenderFilter');
    if (genderFilter) genderFilter.onchange = renderModalGrid;

    // Close modal on backdrop click
    const addModal = document.getElementById('mgAddModelsModal');
    if (addModal) addModal.onclick = (e) => { if (e.target === addModal) closeAddModelsModal(); };

    mgState.initialized = true;
    loadGroups();
  }

  window.initModelGroupsView = init;
})();
