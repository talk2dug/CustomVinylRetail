/**
 * Room Groups View
 *
 * Lets users create and manage curated groups of rooms
 * for use with the metal print pipeline.
 */

(function () {
  const rgState = {
    initialized: false,
    groups: [],
    selectedGroupId: null,
    selectedGroupMembers: [],
    allRooms: [],
    modalSelected: new Set()
  };

  const NO_IMG = "data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 160 100%22><rect fill=%22%231a1a2e%22 width=%22160%22 height=%22100%22/><text x=%2280%22 y=%2250%22 fill=%22%23555%22 text-anchor=%22middle%22 font-size=%228%22>No Image</text></svg>";

  function getThumbUrl(room) {
    const p = room.image_path || room.imagePath || room.thumbnail_path || room.thumbnailPath || room.preview || '';
    if (!p) return NO_IMG;
    if (p.startsWith('http') || p.startsWith('data:')) return p;
    const serverBase = window.printStationConfig?.serverBaseUrl || window.state?.config?.serverBaseUrl || '';
    if (serverBase && p.startsWith('/')) return serverBase + p;
    return p;
  }

  function esc(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }

  const api = () => window.printStation?.roomGroups;

  async function loadGroups() {
    try {
      const resp = await api().list();
      rgState.groups = resp.groups || resp || [];
    } catch (err) {
      console.error('[RoomGroups] load failed:', err);
      rgState.groups = [];
    }
    renderGroupList();
  }

  async function loadGroupDetail(groupId) {
    try {
      const resp = await api().get(groupId);
      rgState.selectedGroupId = groupId;
      rgState.selectedGroupMembers = resp.members || [];
      renderGroupDetail(resp.group, resp.members || []);
    } catch (err) {
      console.error('[RoomGroups] detail load failed:', err);
    }
  }

  // ── Group List (left panel) ──────────────────────────────────────────
  function renderGroupList() {
    const container = document.getElementById('rgGroupCards');
    if (!container) return;

    if (!rgState.groups.length) {
      container.innerHTML = '<p style="color:var(--text-secondary);font-size:13px;padding:12px;">No room groups yet. Click "+ New Group" to create one.</p>';
      return;
    }

    container.innerHTML = rgState.groups.map(g => {
      const isSelected = g.id === rgState.selectedGroupId;
      return `
        <div class="rg-group-card ${isSelected ? 'rg-selected' : ''}" data-group-id="${esc(g.id)}"
             style="padding:10px 12px;border:1px solid ${isSelected ? 'var(--accent)' : 'var(--border)'};border-radius:8px;cursor:pointer;background:${isSelected ? 'var(--bg-secondary)' : 'var(--bg-primary)'};transition:border-color 0.15s;">
          <div style="font-weight:600;font-size:14px;">${esc(g.name)}</div>
          <div style="font-size:12px;color:var(--text-secondary);margin-top:2px;">${g.member_count || 0} room${(g.member_count || 0) === 1 ? '' : 's'}</div>
          ${g.description ? `<div style="font-size:11px;color:var(--text-secondary);margin-top:4px;opacity:0.7;">${esc(g.description).substring(0, 60)}</div>` : ''}
        </div>`;
    }).join('');

    container.querySelectorAll('.rg-group-card').forEach(card => {
      card.addEventListener('click', () => loadGroupDetail(card.dataset.groupId));
    });
  }

  // ── Group Detail (right panel) ───────────────────────────────────────
  function renderGroupDetail(group, members) {
    const placeholder = document.getElementById('rgDetailPlaceholder');
    const content = document.getElementById('rgDetailContent');
    if (!group) {
      if (placeholder) placeholder.style.display = '';
      if (content) content.style.display = 'none';
      return;
    }
    if (placeholder) placeholder.style.display = 'none';
    if (content) content.style.display = '';

    document.getElementById('rgDetailName').textContent = group.name;
    document.getElementById('rgDetailDesc').textContent = group.description || '';
    document.getElementById('rgMemberCount').textContent = `${members.length} room${members.length === 1 ? '' : 's'} in this group`;

    const grid = document.getElementById('rgMemberGrid');
    if (!members.length) {
      grid.innerHTML = '<p style="color:var(--text-secondary);font-size:13px;grid-column:1/-1;text-align:center;padding:40px;">No rooms in this group yet. Click "+ Add Rooms" to get started.</p>';
      return;
    }

    grid.innerHTML = members.map(m => `
      <div class="rg-member-card" style="position:relative;border:1px solid var(--border);border-radius:8px;overflow:hidden;background:var(--bg-secondary);min-height:180px;">
        <img src="${esc(getThumbUrl(m))}" alt="${esc(m.title || m.name || '')}"
             style="width:100%;height:140px;min-height:140px;object-fit:cover;display:block;background:#1a1a2e;"
             onerror="this.style.height='140px';this.style.background='#1a1a2e';" />
        <div style="padding:6px 8px;">
          <div style="font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(m.title || m.name || m.id)}</div>
          <div style="font-size:10px;color:var(--text-secondary);margin-top:2px;">
            ${esc(m.room_type || 'room')}${m.multi_print ? ' &bull; gallery wall' : ''}
          </div>
        </div>
        <button class="rg-remove-btn" data-room-id="${esc(m.id)}" title="Remove from group"
                style="position:absolute;top:4px;right:4px;background:rgba(0,0,0,0.65);border:none;color:#ff6b6b;cursor:pointer;width:24px;height:24px;border-radius:50%;font-size:14px;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity 0.15s;">x</button>
      </div>
    `).join('');

    grid.querySelectorAll('.rg-member-card').forEach(card => {
      const btn = card.querySelector('.rg-remove-btn');
      card.addEventListener('mouseenter', () => btn.style.opacity = '1');
      card.addEventListener('mouseleave', () => btn.style.opacity = '0');
    });

    grid.querySelectorAll('.rg-remove-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const roomId = btn.dataset.roomId;
        try {
          await api().removeRooms(rgState.selectedGroupId, [roomId]);
          await loadGroupDetail(rgState.selectedGroupId);
          await loadGroups();
        } catch (err) {
          console.error('[RoomGroups] remove failed:', err);
        }
      });
    });
  }

  // ── Inline prompt ────────────────────────────────────────────────────
  function showInputModal(title, fields, callback) {
    const existing = document.getElementById('rgInputModal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'rgInputModal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;';
    modal.innerHTML = `
      <div style="background:var(--bg-primary);border:1px solid var(--border);border-radius:12px;padding:20px;width:360px;max-width:90vw;">
        <h3 style="margin:0 0 12px;">${esc(title)}</h3>
        ${fields.map((f, i) => `
          <label style="display:block;margin-bottom:10px;">
            <span style="font-size:13px;color:var(--text-secondary);">${esc(f.label)}</span>
            <input id="rgInput${i}" type="text" value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}"
              style="display:block;width:100%;margin-top:4px;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--bg-secondary);color:var(--text-primary);box-sizing:border-box;">
          </label>
        `).join('')}
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;">
          <button id="rgInputCancel" class="btn" style="padding:6px 16px;">Cancel</button>
          <button id="rgInputOk" class="btn btn-primary" style="padding:6px 16px;">OK</button>
        </div>
      </div>`;
    document.body.appendChild(modal);

    const firstInput = modal.querySelector('input');
    if (firstInput) setTimeout(() => firstInput.focus(), 50);

    modal.querySelector('#rgInputCancel').onclick = () => { modal.remove(); };
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    modal.querySelector('#rgInputOk').onclick = () => {
      const values = fields.map((_, i) => document.getElementById(`rgInput${i}`).value.trim());
      modal.remove();
      callback(values);
    };
    modal.querySelectorAll('input').forEach(inp => {
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') modal.querySelector('#rgInputOk').click();
      });
    });
  }

  // ── CRUD handlers ─────────────────────────────────────────────────────
  function handleCreateGroup() {
    showInputModal('New Room Group', [
      { label: 'Group name', placeholder: 'e.g. Modern Living Rooms' },
      { label: 'Description (optional)', placeholder: '' }
    ], async ([name, description]) => {
      if (!name) return;
      try {
        const resp = await api().create({ name, description });
        await loadGroups();
        if (resp.group?.id) loadGroupDetail(resp.group.id);
      } catch (err) {
        showInputModal('Error', [{ label: 'Failed: ' + (err.message || err), value: '' }], () => {});
      }
    });
  }

  function handleEditGroup() {
    if (!rgState.selectedGroupId) return;
    const current = rgState.groups.find(g => g.id === rgState.selectedGroupId);
    showInputModal('Edit Room Group', [
      { label: 'Group name', value: current?.name || '' },
      { label: 'Description', value: current?.description || '' }
    ], async ([name, description]) => {
      if (!name) return;
      try {
        await api().update(rgState.selectedGroupId, { name, description });
        await loadGroups();
        await loadGroupDetail(rgState.selectedGroupId);
      } catch (err) {
        console.error('Failed to update room group:', err);
      }
    });
  }

  async function handleDeleteGroup() {
    if (!rgState.selectedGroupId) return;
    const current = rgState.groups.find(g => g.id === rgState.selectedGroupId);
    showInputModal(`Delete "${current?.name}"?`, [
      { label: 'Type "delete" to confirm', placeholder: 'delete' }
    ], async ([val]) => {
      if (val !== 'delete') return;
      try {
        await api().delete(rgState.selectedGroupId);
        rgState.selectedGroupId = null;
        renderGroupDetail(null);
        await loadGroups();
      } catch (err) {
        console.error('Failed to delete room group:', err);
      }
    });
  }

  // ── Add Rooms Modal ───────────────────────────────────────────────────
  async function openAddRoomsModal() {
    const modal = document.getElementById('rgAddRoomsModal');
    if (!modal) return;
    modal.style.display = 'flex';
    rgState.modalSelected.clear();
    updateModalSelectedCount();

    if (!rgState.allRooms.length) {
      try {
        const resp = await window.printStation.customArt?.rooms?.list?.() || { rooms: [] };
        rgState.allRooms = resp.rooms || resp.items || resp || [];
      } catch (err) {
        console.error('[RoomGroups] rooms list fetch failed:', err);
      }
    }

    renderModalGrid();
  }

  function closeAddRoomsModal() {
    const modal = document.getElementById('rgAddRoomsModal');
    if (modal) modal.style.display = 'none';
    rgState.modalSelected.clear();
  }

  function renderModalGrid() {
    const grid = document.getElementById('rgModalGrid');
    if (!grid) return;

    const search = (document.getElementById('rgRoomSearch')?.value || '').toLowerCase();
    const existingIds = new Set(rgState.selectedGroupMembers.map(m => m.id));

    const filtered = rgState.allRooms.filter(r => {
      if (existingIds.has(r.id)) return false;
      if (search && !(r.title || r.name || '').toLowerCase().includes(search) && !(r.description || '').toLowerCase().includes(search)) return false;
      return true;
    });

    if (!filtered.length) {
      grid.innerHTML = '<p style="color:var(--text-secondary);grid-column:1/-1;text-align:center;padding:40px;">No matching rooms found</p>';
      return;
    }

    grid.innerHTML = filtered.map(r => {
      const selected = rgState.modalSelected.has(r.id);
      return `
        <div class="rg-modal-room ${selected ? 'rg-modal-selected' : ''}" data-room-id="${esc(r.id)}"
             style="border:2px solid ${selected ? 'var(--accent)' : 'var(--border)'};border-radius:8px;overflow:hidden;cursor:pointer;position:relative;background:var(--bg-secondary);transition:border-color 0.12s;min-height:150px;">
          <img src="${esc(getThumbUrl(r))}" alt="${esc(r.title || r.name || '')}"
               style="width:100%;height:120px;min-height:120px;object-fit:cover;display:block;background:#1a1a2e;"
               onerror="this.style.height='120px';this.style.background='#1a1a2e';" />
          ${selected ? '<div style="position:absolute;top:4px;right:4px;background:var(--accent);color:white;width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:bold;">&#10003;</div>' : ''}
          <div style="padding:4px 6px;">
            <div style="font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(r.title || r.name || r.id)}</div>
            <div style="font-size:10px;color:var(--text-secondary);">${esc(r.room_type || r.description || '')}</div>
          </div>
        </div>`;
    }).join('');

    grid.querySelectorAll('.rg-modal-room').forEach(card => {
      card.addEventListener('click', () => {
        const rid = card.dataset.roomId;
        if (rgState.modalSelected.has(rid)) {
          rgState.modalSelected.delete(rid);
        } else {
          rgState.modalSelected.add(rid);
        }
        renderModalGrid();
      });
    });

    updateModalSelectedCount();
  }

  function updateModalSelectedCount() {
    const countEl = document.getElementById('rgModalSelectedCount');
    const addBtn = document.getElementById('rgModalAddBtn');
    const n = rgState.modalSelected.size;
    if (countEl) countEl.textContent = `${n} selected`;
    if (addBtn) addBtn.disabled = n === 0;
  }

  async function handleModalAdd() {
    if (!rgState.modalSelected.size || !rgState.selectedGroupId) return;
    const roomIds = Array.from(rgState.modalSelected);
    const roomType = document.getElementById('rgModalRoomType')?.value || 'living-room';
    const multiPrint = document.getElementById('rgModalMultiPrint')?.checked || false;

    const rooms = roomIds.map(id => ({ roomId: id, roomType, multiPrint }));
    try {
      await api().addRooms(rgState.selectedGroupId, rooms);
      closeAddRoomsModal();
      await loadGroupDetail(rgState.selectedGroupId);
      await loadGroups();
    } catch (err) {
      console.error('Failed to add rooms:', err);
    }
  }

  // ── Pipeline launcher ─────────────────────────────────────────────────
  async function openPipelineModal() {
    const modal = document.getElementById('rgPipelineModal');
    if (!modal) return;
    modal.style.display = 'flex';

    // Populate room group dropdown
    const select = document.getElementById('rgPipelineRoomGroup');
    if (select) {
      select.innerHTML = '<option value="">Select a room group...</option>';
      rgState.groups.forEach(g => {
        const opt = document.createElement('option');
        opt.value = g.id;
        opt.textContent = `${g.name} (${g.member_count || 0} rooms)`;
        if (g.id === rgState.selectedGroupId) opt.selected = true;
        select.appendChild(opt);
      });
    }

    document.getElementById('rgPipelineStatus').style.display = 'none';
  }

  function closePipelineModal() {
    const modal = document.getElementById('rgPipelineModal');
    if (modal) modal.style.display = 'none';
  }

  async function handleRunPipeline() {
    const category = document.getElementById('rgPipelineCategory')?.value?.trim();
    const roomGroupId = document.getElementById('rgPipelineRoomGroup')?.value;
    const campaignTitle = document.getElementById('rgPipelineTitle')?.value?.trim();
    const skipShopify = document.getElementById('rgPipelineSkipShopify')?.checked || false;
    const limit = parseInt(document.getElementById('rgPipelineLimit')?.value) || 10;

    if (!category) {
      const statusEl = document.getElementById('rgPipelineStatus');
      statusEl.style.display = 'block';
      statusEl.textContent = 'Please enter a design category or design IDs.';
      statusEl.style.color = '#ff6b6b';
      return;
    }

    const statusEl = document.getElementById('rgPipelineStatus');
    statusEl.style.display = 'block';
    statusEl.textContent = 'Starting metal print pipeline...';
    statusEl.style.color = 'var(--text-primary)';

    try {
      const payload = {
        category,
        roomGroupId: roomGroupId || undefined,
        campaignTitle: campaignTitle || category,
        campaignSlug: (campaignTitle || category).replace(/[^a-zA-Z0-9]/g, '-').toLowerCase(),
        skipShopify,
        limit
      };

      const resp = await window.printStation.metalPrintPipeline.run(payload);
      statusEl.innerHTML = `Pipeline started! Run ID: <strong>${resp.runId || 'unknown'}</strong><br>Check Telegram for progress updates.`;
      statusEl.style.color = '#2ecc71';
    } catch (err) {
      statusEl.textContent = 'Pipeline failed: ' + (err.message || err);
      statusEl.style.color = '#ff6b6b';
    }
  }

  // ── Init ──────────────────────────────────────────────────────────────
  function init() {
    console.log('[RoomGroups] init called');

    const newBtn = document.getElementById('rgNewGroupBtn');
    if (newBtn) newBtn.onclick = handleCreateGroup;

    const launchBtn = document.getElementById('rgLaunchPipelineBtn');
    if (launchBtn) launchBtn.onclick = openPipelineModal;

    const editBtn = document.getElementById('rgEditGroupBtn');
    if (editBtn) editBtn.onclick = handleEditGroup;
    const addBtn = document.getElementById('rgAddRoomsBtn');
    if (addBtn) addBtn.onclick = openAddRoomsModal;
    const delBtn = document.getElementById('rgDeleteGroupBtn');
    if (delBtn) delBtn.onclick = handleDeleteGroup;

    // Add Rooms modal controls
    const closeBtn = document.getElementById('rgModalCloseBtn');
    if (closeBtn) closeBtn.onclick = closeAddRoomsModal;
    const modalAddBtn = document.getElementById('rgModalAddBtn');
    if (modalAddBtn) modalAddBtn.onclick = handleModalAdd;

    let searchTimer;
    const searchEl = document.getElementById('rgRoomSearch');
    if (searchEl) searchEl.oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderModalGrid, 250); };

    const addModal = document.getElementById('rgAddRoomsModal');
    if (addModal) addModal.onclick = (e) => { if (e.target === addModal) closeAddRoomsModal(); };

    // Pipeline modal controls
    const pipelineCancelBtn = document.getElementById('rgPipelineCancelBtn');
    if (pipelineCancelBtn) pipelineCancelBtn.onclick = closePipelineModal;
    const pipelineRunBtn = document.getElementById('rgPipelineRunBtn');
    if (pipelineRunBtn) pipelineRunBtn.onclick = handleRunPipeline;
    const pipelineModal = document.getElementById('rgPipelineModal');
    if (pipelineModal) pipelineModal.onclick = (e) => { if (e.target === pipelineModal) closePipelineModal(); };

    rgState.initialized = true;
    loadGroups();
  }

  window.initRoomGroupsView = init;
})();
