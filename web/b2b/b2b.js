// B2B Metal Prints Portal - Client-Side JavaScript

const B2B = {
  token: null,
  user: null,
  company: null,

  // Initialize
  init() {
    this.token = localStorage.getItem('b2b_token');
    const userData = localStorage.getItem('b2b_user');
    if (userData) {
      try { this.user = JSON.parse(userData); } catch (e) {}
    }
  },

  // Check if logged in
  isLoggedIn() {
    return !!this.token;
  },

  // API helper
  async api(endpoint, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...(this.token ? { 'Authorization': `Bearer ${this.token}` } : {})
    };

    const response = await fetch(`/api/b2b${endpoint}`, {
      ...options,
      headers: { ...headers, ...options.headers }
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Request failed');
    }
    return data;
  },

  // Login
  async login(email, password) {
    const data = await this.api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });

    this.token = data.token;
    this.user = data.user;
    localStorage.setItem('b2b_token', data.token);
    localStorage.setItem('b2b_user', JSON.stringify(data.user));
    return data;
  },

  // Logout
  async logout() {
    try {
      await this.api('/auth/logout', { method: 'POST' });
    } catch (e) {}
    this.token = null;
    this.user = null;
    localStorage.removeItem('b2b_token');
    localStorage.removeItem('b2b_user');
    window.location.href = '/b2b/';
  },

  // Get profile
  async getProfile() {
    const data = await this.api('/auth/profile');
    this.user = data.user;
    this.company = data.company;
    localStorage.setItem('b2b_user', JSON.stringify(data.user));
    return data;
  },

  // Orders
  async listOrders(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.api(`/orders${query ? '?' + query : ''}`);
  },

  async getOrder(orderId) {
    return this.api(`/orders/${orderId}`);
  },

  async createOrder(data) {
    return this.api('/orders', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  async updateOrder(orderId, data) {
    return this.api(`/orders/${orderId}`, {
      method: 'PATCH',
      body: JSON.stringify(data)
    });
  },

  async addItem(orderId, data) {
    return this.api(`/orders/${orderId}/items`, {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  async uploadImage(orderId, itemId, file) {
    const formData = new FormData();
    formData.append('image', file);

    const response = await fetch(`/api/b2b/orders/${orderId}/items/${itemId}/upload`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`
      },
      body: formData
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Upload failed');
    }
    return data;
  },

  async deleteItem(orderId, itemId) {
    return this.api(`/orders/${orderId}/items/${itemId}`, {
      method: 'DELETE'
    });
  },

  async submitOrder(orderId) {
    return this.api(`/orders/${orderId}/submit`, { method: 'POST' });
  },

  async checkout(orderId) {
    return this.api(`/orders/${orderId}/checkout`, { method: 'POST' });
  },

  // Users
  async listUsers() {
    return this.api('/company/users');
  },

  async addUser(data) {
    return this.api('/company/users', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  async updateUser(userId, data) {
    return this.api(`/company/users/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify(data)
    });
  },

  async deleteUser(userId) {
    return this.api(`/company/users/${userId}`, { method: 'DELETE' });
  },

  // Pricing
  async getPricing() {
    return this.api('/pricing');
  }
};

// Format currency
function formatCurrency(cents) {
  return '$' + (cents / 100).toFixed(2);
}

// Format date
function formatDate(dateStr) {
  if (!dateStr) return '-';
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}

// Format date/time
function formatDateTime(dateStr) {
  if (!dateStr) return '-';
  const date = new Date(dateStr);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

// Get initials
function getInitials(name) {
  if (!name) return '?';
  return name.split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase();
}

// Show toast notification
function showToast(message, type = 'info') {
  const existing = document.querySelector('.b2b-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `b2b-toast b2b-alert b2b-alert-${type}`;
  toast.style.cssText = 'position: fixed; bottom: 1rem; right: 1rem; z-index: 9999; max-width: 400px;';
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => toast.remove(), 4000);
}

// Require auth on protected pages
function requireAuth() {
  B2B.init();
  if (!B2B.isLoggedIn()) {
    window.location.href = '/b2b/';
    return false;
  }
  return true;
}

// Update header with user info
function updateHeader() {
  const userName = document.getElementById('userName');
  const userNav = document.getElementById('userNav');

  if (userName && B2B.user) {
    userName.textContent = B2B.user.name;
  }

  // Show/hide admin link
  const adminLink = document.getElementById('adminLink');
  if (adminLink && B2B.user) {
    adminLink.style.display = B2B.user.role === 'admin' ? '' : 'none';
  }
}

// Initialize on DOMContentLoaded
document.addEventListener('DOMContentLoaded', () => {
  B2B.init();
});
