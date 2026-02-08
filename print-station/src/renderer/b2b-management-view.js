// =============== B2B Partner Management View ===============

const b2bApi = {
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
      body: JSON.stringify(data)
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || `Request failed: ${response.status}`);
    }
    return response.json();
  },
  async patch(path, data) {
    const response = await fetch(`${this.getServerUrl()}${path}`, {
      method: 'PATCH',
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

const b2bState = {
  companies: [],
  selectedCompany: null,
  users: [],
  orders: [],
  initialized: false
};

// =============== INITIALIZATION ===============
async function initB2BManagementView() {
  if (!b2bState.initialized) {
    b2bState.initialized = true;
    setupB2BListeners();
  }
  await loadB2BCompanies();
}

function setupB2BListeners() {
  document.getElementById('b2bRefreshBtn').addEventListener('click', () => {
    loadB2BCompanies();
  });

  document.getElementById('b2bAddCompanyBtn').addEventListener('click', () => {
    openB2BCompanyModal();
  });

  document.getElementById('b2bAddUserBtn').addEventListener('click', () => {
    if (b2bState.selectedCompany) {
      openB2BUserModal(b2bState.selectedCompany.id);
    }
  });

  document.getElementById('b2bCompanyForm').addEventListener('submit', handleB2BCompanySubmit);
  document.getElementById('b2bUserForm').addEventListener('submit', handleB2BUserSubmit);
}

// =============== COMPANIES ===============
async function loadB2BCompanies() {
  const container = document.getElementById('b2bCompaniesList');
  container.innerHTML = '<div class="b2b-empty-state">Loading companies...</div>';

  try {
    const data = await b2bApi.get('/api/internal/b2b/companies');
    b2bState.companies = data.companies || [];

    if (b2bState.companies.length === 0) {
      container.innerHTML = '<div class="b2b-empty-state">No B2B partners yet. Click "Add Company" to create one.</div>';
      return;
    }

    container.innerHTML = b2bState.companies.map(company => `
      <div class="b2b-list-item ${b2bState.selectedCompany?.id === company.id ? 'selected' : ''}"
           onclick="selectB2BCompany('${company.id}')">
        <div class="b2b-item-header">
          <strong>${escapeHtml(company.companyName)}</strong>
          <span class="b2b-status b2b-status-${company.status}">${company.status}</span>
        </div>
        <div class="b2b-item-details">
          <span>${escapeHtml(company.contactEmail)}</span>
          ${company.contactPhone ? `<span>${escapeHtml(company.contactPhone)}</span>` : ''}
        </div>
        <div class="b2b-item-actions">
          <button class="small secondary" onclick="event.stopPropagation(); editB2BCompany('${company.id}')">Edit</button>
        </div>
      </div>
    `).join('');

  } catch (err) {
    console.error('[B2B] Load companies failed:', err);
    container.innerHTML = `<div class="b2b-empty-state error">Error: ${escapeHtml(err.message)}</div>`;
  }
}

async function selectB2BCompany(companyId) {
  b2bState.selectedCompany = b2bState.companies.find(c => c.id === companyId) || null;

  // Update selected state in UI
  document.querySelectorAll('#b2bCompaniesList .b2b-list-item').forEach(el => {
    el.classList.toggle('selected', el.onclick?.toString().includes(companyId));
  });

  // Update company name header
  document.getElementById('b2bSelectedCompanyName').textContent =
    b2bState.selectedCompany ? `- ${b2bState.selectedCompany.companyName}` : '';

  // Show add user button
  document.getElementById('b2bAddUserBtn').style.display = b2bState.selectedCompany ? '' : 'none';

  // Load users
  await loadB2BUsers(companyId);

  // Load orders
  await loadB2BCompanyOrders(companyId);
}

function editB2BCompany(companyId) {
  const company = b2bState.companies.find(c => c.id === companyId);
  if (!company) return;
  openB2BCompanyModal(company);
}

function openB2BCompanyModal(company = null) {
  const modal = document.getElementById('b2bCompanyModal');
  const title = document.getElementById('b2bCompanyModalTitle');
  const adminFields = document.getElementById('b2bAdminUserFields');

  title.textContent = company ? 'Edit Company' : 'Add Company';
  adminFields.style.display = company ? 'none' : '';

  // Populate form
  document.getElementById('b2bCompanyId').value = company?.id || '';
  document.getElementById('b2bCompanyName').value = company?.companyName || '';
  document.getElementById('b2bCompanyEmail').value = company?.contactEmail || '';
  document.getElementById('b2bCompanyPhone').value = company?.contactPhone || '';
  document.getElementById('b2bCompanyBillingAddress').value = company?.billingAddress || '';
  document.getElementById('b2bCompanyShippingAddress').value = company?.shippingAddress || '';
  document.getElementById('b2bCompanyStatus').value = company?.status || 'active';
  document.getElementById('b2bCompanyNotes').value = company?.notes || '';
  document.getElementById('b2bAdminName').value = '';
  document.getElementById('b2bAdminPassword').value = '';

  // Update required fields
  document.getElementById('b2bAdminName').required = !company;
  document.getElementById('b2bAdminPassword').required = !company;

  modal.style.display = 'flex';
}

function closeB2BCompanyModal() {
  document.getElementById('b2bCompanyModal').style.display = 'none';
}

async function handleB2BCompanySubmit(e) {
  e.preventDefault();

  const companyId = document.getElementById('b2bCompanyId').value;
  const isEdit = !!companyId;

  const btn = document.getElementById('b2bCompanySaveBtn');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    if (isEdit) {
      // Update existing company
      await b2bApi.patch(`/api/internal/b2b/companies/${companyId}`, {
        companyName: document.getElementById('b2bCompanyName').value,
        contactEmail: document.getElementById('b2bCompanyEmail').value,
        contactPhone: document.getElementById('b2bCompanyPhone').value,
        billingAddress: document.getElementById('b2bCompanyBillingAddress').value,
        shippingAddress: document.getElementById('b2bCompanyShippingAddress').value,
        status: document.getElementById('b2bCompanyStatus').value,
        notes: document.getElementById('b2bCompanyNotes').value
      });
    } else {
      // Create new company with admin user
      await b2bApi.post('/api/internal/b2b/companies', {
        companyName: document.getElementById('b2bCompanyName').value,
        adminEmail: document.getElementById('b2bCompanyEmail').value,
        adminPassword: document.getElementById('b2bAdminPassword').value,
        adminName: document.getElementById('b2bAdminName').value,
        contactPhone: document.getElementById('b2bCompanyPhone').value,
        billingAddress: document.getElementById('b2bCompanyBillingAddress').value,
        shippingAddress: document.getElementById('b2bCompanyShippingAddress').value,
        notes: document.getElementById('b2bCompanyNotes').value
      });
    }

    closeB2BCompanyModal();
    await loadB2BCompanies();
    showToast(isEdit ? 'Company updated' : 'Company created', 'success');

  } catch (err) {
    console.error('[B2B] Save company failed:', err);
    showToast(`Error: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Company';
  }
}

// =============== USERS ===============
async function loadB2BUsers(companyId) {
  const container = document.getElementById('b2bUsersList');

  if (!companyId) {
    container.innerHTML = '<div class="b2b-empty-state">Select a company to view users</div>';
    return;
  }

  container.innerHTML = '<div class="b2b-empty-state">Loading users...</div>';

  try {
    // Get users for the company - we need to get company details which includes users
    // Actually, we need a different endpoint. Let me check the internal API
    // The internal API doesn't have a direct users list endpoint for a company
    // We'll need to use the B2B auth to get users, but that requires a B2B token
    // For now, let's show a message and provide a way to add users

    // Actually, looking at the API, there's no internal endpoint to list users for a company
    // The /api/b2b/company/users requires B2B auth. We need to add an internal endpoint.
    // For now, let's show a placeholder

    container.innerHTML = `
      <div class="b2b-empty-state">
        <p>User management requires B2B portal login.</p>
        <p style="font-size:12px;color:#888;margin-top:8px;">
          Users can be added when creating a company (admin user) or from the B2B portal itself.
        </p>
      </div>
    `;

  } catch (err) {
    console.error('[B2B] Load users failed:', err);
    container.innerHTML = `<div class="b2b-empty-state error">Error: ${escapeHtml(err.message)}</div>`;
  }
}

function openB2BUserModal(companyId, user = null) {
  const modal = document.getElementById('b2bUserModal');
  const title = document.getElementById('b2bUserModalTitle');

  title.textContent = user ? 'Edit User' : 'Add User';

  // Populate form
  document.getElementById('b2bUserId').value = user?.id || '';
  document.getElementById('b2bUserCompanyId').value = companyId;
  document.getElementById('b2bUserName').value = user?.name || '';
  document.getElementById('b2bUserEmail').value = user?.email || '';
  document.getElementById('b2bUserEmail').disabled = !!user;
  document.getElementById('b2bUserPhone').value = user?.phone || '';
  document.getElementById('b2bUserPassword').value = '';
  document.getElementById('b2bUserRole').value = user?.role || 'user';
  document.getElementById('b2bUserStatus').value = user?.status || 'active';

  // Update password hint
  document.getElementById('b2bPasswordHint').textContent = user ? '(leave blank to keep current)' : '(required for new users)';
  document.getElementById('b2bUserPassword').required = !user;

  modal.style.display = 'flex';
}

function closeB2BUserModal() {
  document.getElementById('b2bUserModal').style.display = 'none';
}

async function handleB2BUserSubmit(e) {
  e.preventDefault();

  // Note: This would require internal API endpoints for user management
  // For now, show a message that users should use the B2B portal
  showToast('User management is done through the B2B portal', 'info');
  closeB2BUserModal();
}

// =============== ORDERS ===============
async function loadB2BCompanyOrders(companyId) {
  const statsCard = document.getElementById('b2bCompanyStats');
  const container = document.getElementById('b2bOrdersList');

  if (!companyId) {
    statsCard.style.display = 'none';
    return;
  }

  statsCard.style.display = '';
  container.innerHTML = '<div class="b2b-empty-state">Loading orders...</div>';

  try {
    // Note: We need to filter orders by company - the current internal API
    // doesn't support filtering by company ID, so we'll get all and filter
    const data = await b2bApi.get('/api/internal/b2b/orders?limit=100');
    const orders = (data.orders || []).filter(o => o.companyId === companyId);
    b2bState.orders = orders;

    if (orders.length === 0) {
      container.innerHTML = '<div class="b2b-empty-state">No orders from this company yet</div>';
      return;
    }

    container.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="text-align:left;border-bottom:1px solid #ddd;">
            <th style="padding:8px;">Order #</th>
            <th style="padding:8px;">Status</th>
            <th style="padding:8px;">Payment</th>
            <th style="padding:8px;">Total</th>
            <th style="padding:8px;">Date</th>
            <th style="padding:8px;">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${orders.map(order => `
            <tr style="border-bottom:1px solid #eee;">
              <td style="padding:8px;"><strong>#${order.orderNumber}</strong></td>
              <td style="padding:8px;"><span class="b2b-status b2b-status-${order.status}">${order.status.replace('_', ' ')}</span></td>
              <td style="padding:8px;"><span class="b2b-status b2b-status-${order.paymentStatus}">${order.paymentStatus}</span></td>
              <td style="padding:8px;">$${(order.totalCents / 100).toFixed(2)}</td>
              <td style="padding:8px;">${new Date(order.createdAt).toLocaleDateString()}</td>
              <td style="padding:8px;">
                <button class="small secondary" onclick="viewB2BOrderDetails('${order.id}')">View</button>
                ${order.paymentStatus === 'paid' && order.status === 'received' ?
                  `<button class="small primary" onclick="updateB2BOrderStatus('${order.id}', 'being_printed')">Start Print</button>` : ''}
                ${order.status === 'being_printed' ?
                  `<button class="small primary" onclick="showAddTrackingModal('${order.id}')">Add Tracking</button>` : ''}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;

  } catch (err) {
    console.error('[B2B] Load orders failed:', err);
    container.innerHTML = `<div class="b2b-empty-state error">Error: ${escapeHtml(err.message)}</div>`;
  }
}

async function viewB2BOrderDetails(orderId) {
  try {
    const data = await b2bApi.get(`/api/internal/b2b/orders/${orderId}`);
    const order = data.order;
    const items = data.items || [];

    const itemsList = items.map(item => `
      <div style="display:flex;gap:12px;padding:8px;border-bottom:1px solid #eee;">
        <div style="width:60px;height:60px;background:#f0f0f0;border-radius:4px;display:flex;align-items:center;justify-content:center;">
          ${item.imagePath ?
            `<img src="${b2bApi.getServerUrl()}/api/b2b/orders/${orderId}/items/${item.id}/image" style="width:100%;height:100%;object-fit:cover;border-radius:4px;">` :
            '<span style="color:#888;">No image</span>'}
        </div>
        <div style="flex:1;">
          <strong>${item.size}" Metal Print</strong>
          <div style="font-size:12px;color:#666;">Qty: ${item.quantity} | $${(item.lineTotalCents / 100).toFixed(2)}</div>
        </div>
      </div>
    `).join('');

    const shippingAddress = [
      order.shippingName,
      order.shippingAddressLine1,
      order.shippingAddressLine2,
      `${order.shippingCity}, ${order.shippingState} ${order.shippingZip}`
    ].filter(Boolean).join('<br>');

    // Create a modal or alert to show order details
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.style.display = 'flex';
    modal.innerHTML = `
      <div class="modal-dialog" style="max-width:600px;">
        <div class="modal-header">
          <h3>Order #${order.orderNumber}</h3>
          <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">&times;</button>
        </div>
        <div class="modal-body" style="max-height:60vh;overflow-y:auto;">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px;">
            <div>
              <strong>Status:</strong> <span class="b2b-status b2b-status-${order.status}">${order.status.replace('_', ' ')}</span>
            </div>
            <div>
              <strong>Payment:</strong> <span class="b2b-status b2b-status-${order.paymentStatus}">${order.paymentStatus}</span>
            </div>
          </div>

          <h4 style="margin:16px 0 8px;">Items (${items.length})</h4>
          ${itemsList}

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px;">
            <div>
              <h4 style="margin:0 0 8px;">Shipping To</h4>
              <div style="font-size:13px;line-height:1.6;">${shippingAddress}</div>
            </div>
            <div>
              <h4 style="margin:0 0 8px;">Order Total</h4>
              <div style="font-size:13px;">
                Subtotal: $${(order.subtotalCents / 100).toFixed(2)}<br>
                Shipping: $${(order.shippingCents / 100).toFixed(2)}<br>
                <strong>Total: $${(order.totalCents / 100).toFixed(2)}</strong>
              </div>
            </div>
          </div>

          ${order.trackingNumber ? `
            <div style="margin-top:16px;padding:12px;background:#e8f5e9;border-radius:6px;">
              <strong>Tracking:</strong> ${order.trackingCarrier} - ${order.trackingNumber}
            </div>
          ` : ''}
        </div>
        <div class="modal-footer">
          <button class="secondary" onclick="this.closest('.modal-overlay').remove()">Close</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

  } catch (err) {
    console.error('[B2B] View order failed:', err);
    showToast(`Error: ${err.message}`, 'error');
  }
}

async function updateB2BOrderStatus(orderId, status) {
  try {
    await b2bApi.patch(`/api/internal/b2b/orders/${orderId}/status`, { status });
    showToast(`Order status updated to "${status.replace('_', ' ')}"`, 'success');

    // Refresh orders
    if (b2bState.selectedCompany) {
      await loadB2BCompanyOrders(b2bState.selectedCompany.id);
    }
  } catch (err) {
    console.error('[B2B] Update status failed:', err);
    showToast(`Error: ${err.message}`, 'error');
  }
}

function showAddTrackingModal(orderId) {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.style.display = 'flex';
  modal.innerHTML = `
    <div class="modal-dialog" style="max-width:400px;">
      <div class="modal-header">
        <h3>Add Tracking Information</h3>
        <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">&times;</button>
      </div>
      <form onsubmit="submitB2BTracking(event, '${orderId}', this)">
        <div class="modal-body">
          <div class="form-row">
            <label>Carrier *</label>
            <select id="trackingCarrierInput" required>
              <option value="USPS">USPS</option>
              <option value="UPS">UPS</option>
              <option value="FedEx">FedEx</option>
              <option value="Other">Other</option>
            </select>
          </div>
          <div class="form-row">
            <label>Tracking Number *</label>
            <input type="text" id="trackingNumberInput" required placeholder="Enter tracking number">
          </div>
        </div>
        <div class="modal-footer">
          <button type="button" class="secondary" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
          <button type="submit" class="primary">Save & Mark Shipped</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);
}

async function submitB2BTracking(e, orderId, form) {
  e.preventDefault();

  const carrier = form.querySelector('#trackingCarrierInput').value;
  const trackingNumber = form.querySelector('#trackingNumberInput').value;

  try {
    await b2bApi.post(`/api/internal/b2b/orders/${orderId}/tracking`, {
      carrier,
      trackingNumber
    });

    form.closest('.modal-overlay').remove();
    showToast('Tracking added and order marked as shipped', 'success');

    // Refresh orders
    if (b2bState.selectedCompany) {
      await loadB2BCompanyOrders(b2bState.selectedCompany.id);
    }
  } catch (err) {
    console.error('[B2B] Add tracking failed:', err);
    showToast(`Error: ${err.message}`, 'error');
  }
}

// =============== UTILITIES ===============
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function showToast(message, type = 'info') {
  // Use existing toast system if available, otherwise create one
  if (typeof window.showNotification === 'function') {
    window.showNotification(message, type);
  } else {
    console.log(`[${type.toUpperCase()}] ${message}`);
    alert(message);
  }
}

// Make functions globally available
window.initB2BManagementView = initB2BManagementView;
window.selectB2BCompany = selectB2BCompany;
window.editB2BCompany = editB2BCompany;
window.openB2BCompanyModal = openB2BCompanyModal;
window.closeB2BCompanyModal = closeB2BCompanyModal;
window.openB2BUserModal = openB2BUserModal;
window.closeB2BUserModal = closeB2BUserModal;
window.viewB2BOrderDetails = viewB2BOrderDetails;
window.updateB2BOrderStatus = updateB2BOrderStatus;
window.showAddTrackingModal = showAddTrackingModal;
window.submitB2BTracking = submitB2BTracking;
