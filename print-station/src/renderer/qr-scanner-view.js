// =============== QR Scanner View - POS System ===============

// API Helper - uses server URL from config
const scannerApi = {
  getServerUrl() {
    return window.printStationConfig?.serverBaseUrl || window.APP_CONFIG?.serverUrl || 'https://store.swayzecustomvinyl.com';
  },
  getHeaders() {
    return {
      'Content-Type': 'application/json',
      'x-api-key': window.printStationConfig?.internalKey || window.APP_CONFIG?.internalKey || ''
    };
  },
  async get(path) {
    const response = await fetch(`${this.getServerUrl()}${path}`, { headers: this.getHeaders() });
    return response.json();
  },
  async post(path, data) {
    const response = await fetch(`${this.getServerUrl()}${path}`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(data)
    });
    return response.json();
  },
  async put(path, data) {
    const response = await fetch(`${this.getServerUrl()}${path}`, {
      method: 'PUT',
      headers: this.getHeaders(),
      body: JSON.stringify(data)
    });
    return response.json();
  },
  async delete(path) {
    const response = await fetch(`${this.getServerUrl()}${path}`, {
      method: 'DELETE',
      headers: this.getHeaders()
    });
    return response.json();
  }
};

const scannerState = {
  cartId: null,
  cartItems: [],
  totalCents: 0,
  scanning: false,
  html5QrScanner: null,
  currentCameraId: null,
  recentScans: [],
  initialized: false
};

const TAX_RATE = 0.07; // 7% tax

// =============== INITIALIZATION ===============
async function initQrScannerView() {
  if (!scannerState.initialized) {
    scannerState.initialized = true;
    setupScannerEventListeners();
  }

  // Load or create active cart
  await loadOrCreateCart();

  // Populate camera list
  await populateCameraList();
}

function setupScannerEventListeners() {
  // New Cart button
  const newCartBtn = document.getElementById('scannerNewCartBtn');
  if (newCartBtn) {
    newCartBtn.addEventListener('click', createNewCart);
  }

  // Start Scanner button
  const startBtn = document.getElementById('scannerStartBtn');
  if (startBtn) {
    startBtn.addEventListener('click', startScanner);
  }

  // Stop Scanner button
  const stopBtn = document.getElementById('scannerStopBtn');
  if (stopBtn) {
    stopBtn.addEventListener('click', stopScanner);
  }

  // Camera select
  const cameraSelect = document.getElementById('scannerCameraSelect');
  if (cameraSelect) {
    cameraSelect.addEventListener('change', async () => {
      if (scannerState.scanning) {
        await stopScanner();
        await startScanner();
      }
    });
  }

  // Manual SKU form
  const manualForm = document.getElementById('scannerManualForm');
  if (manualForm) {
    manualForm.addEventListener('submit', handleManualSkuSubmit);
  }

  // Clear Cart button
  const clearCartBtn = document.getElementById('scannerClearCartBtn');
  if (clearCartBtn) {
    clearCartBtn.addEventListener('click', clearCart);
  }

  // Checkout button
  const checkoutBtn = document.getElementById('scannerCheckoutBtn');
  if (checkoutBtn) {
    checkoutBtn.addEventListener('click', checkoutCart);
  }
}

// =============== CART FUNCTIONS ===============
async function loadOrCreateCart() {
  try {
    const response = await scannerApi.get('/api/cart/active');
    if (response.success) {
      scannerState.cartId = response.cart.id;
      scannerState.cartItems = response.items || [];
      scannerState.totalCents = response.cart.totalCents || 0;
      updateCartDisplay();
    }
  } catch (err) {
    console.error('[Scanner] Failed to load cart:', err);
    await createNewCart();
  }
}

async function createNewCart() {
  try {
    // Mark current cart as abandoned if exists
    if (scannerState.cartId) {
      await scannerApi.delete(`/api/cart/${scannerState.cartId}`);
    }

    const response = await scannerApi.post('/api/cart', {});
    if (response.success) {
      scannerState.cartId = response.cart.id;
      scannerState.cartItems = [];
      scannerState.totalCents = 0;
      updateCartDisplay();
      addRecentScan('Cart', 'New cart created');
    }
  } catch (err) {
    console.error('[Scanner] Failed to create cart:', err);
  }
}

async function addToCart(sku) {
  if (!scannerState.cartId) {
    await createNewCart();
  }

  try {
    const response = await scannerApi.post(`/api/cart/${scannerState.cartId}/items`, { sku });

    if (response.success) {
      scannerState.cartItems = response.items;
      scannerState.totalCents = response.cart.totalCents;
      updateCartDisplay();

      // Show last scan info
      const lastScan = document.getElementById('scannerLastScan');
      lastScan.style.display = 'block';
      document.getElementById('scannerLastSku').textContent = sku;
      document.getElementById('scannerLastName').textContent =
        response.addedDesign ? `${response.addedDesign.name} - ${response.addedVariant.colorName}` : '';

      addRecentScan(sku, 'Added to cart');

      // Play success sound or beep
      playBeep(true);
    } else {
      addRecentScan(sku, `Error: ${response.error}`);
      playBeep(false);
    }
  } catch (err) {
    console.error('[Scanner] Add to cart error:', err);
    addRecentScan(sku, `Error: ${err.message}`);
    playBeep(false);
  }
}

async function updateItemQuantity(itemId, newQuantity) {
  if (newQuantity < 1) {
    await removeItem(itemId);
    return;
  }

  try {
    const response = await scannerApi.put(
      `/api/cart/${scannerState.cartId}/items/${itemId}`,
      { quantity: newQuantity }
    );

    if (response.success) {
      scannerState.cartItems = response.items;
      scannerState.totalCents = response.cart.totalCents;
      updateCartDisplay();
    }
  } catch (err) {
    console.error('[Scanner] Update quantity error:', err);
  }
}

async function removeItem(itemId) {
  try {
    const response = await scannerApi.delete(
      `/api/cart/${scannerState.cartId}/items/${itemId}`
    );

    if (response.success) {
      scannerState.cartItems = response.items;
      scannerState.totalCents = response.cart.totalCents;
      updateCartDisplay();
    }
  } catch (err) {
    console.error('[Scanner] Remove item error:', err);
  }
}

async function clearCart() {
  if (!scannerState.cartId) return;

  try {
    await scannerApi.post(`/api/cart/${scannerState.cartId}/clear`, {});
    scannerState.cartItems = [];
    scannerState.totalCents = 0;
    updateCartDisplay();
    addRecentScan('Cart', 'Cleared');
  } catch (err) {
    console.error('[Scanner] Clear cart error:', err);
  }
}

async function checkoutCart() {
  if (!scannerState.cartId || scannerState.cartItems.length === 0) {
    alert('Cart is empty');
    return;
  }

  const statusEl = document.getElementById('scannerCheckoutStatus');
  statusEl.textContent = 'Creating checkout...';

  try {
    const response = await scannerApi.post(`/api/cart/${scannerState.cartId}/checkout`, {});

    if (response.success) {
      statusEl.innerHTML = `
        <a href="${response.paymentLink}" target="_blank" style="color:#007bff;">
          Open Payment Link
        </a>
      `;

      // Copy to clipboard
      navigator.clipboard.writeText(response.paymentLink).then(() => {
        statusEl.innerHTML += ' (copied to clipboard)';
      });

      addRecentScan('Checkout', 'Payment link created');

      // Create new cart for next customer
      await createNewCart();
    } else {
      statusEl.textContent = 'Error: ' + response.error;
    }
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
  }
}

// =============== UI UPDATE ===============
function updateCartDisplay() {
  const cartIdEl = document.getElementById('scannerCartId');
  const itemCountEl = document.getElementById('scannerItemCount');
  const itemsContainer = document.getElementById('scannerCartItems');
  const subtotalEl = document.getElementById('scannerSubtotal');
  const taxEl = document.getElementById('scannerTax');
  const totalEl = document.getElementById('scannerTotal');
  const checkoutBtn = document.getElementById('scannerCheckoutBtn');

  // Update cart ID
  cartIdEl.textContent = scannerState.cartId ? `Cart: ${scannerState.cartId.slice(0, 12)}...` : '';

  // Update item count
  const totalItems = scannerState.cartItems.reduce((sum, item) => sum + item.quantity, 0);
  itemCountEl.textContent = `${totalItems} item${totalItems !== 1 ? 's' : ''}`;

  // Render items
  if (scannerState.cartItems.length === 0) {
    itemsContainer.innerHTML = '<p class="placeholder">Cart is empty. Scan items to add.</p>';
    checkoutBtn.disabled = true;
  } else {
    itemsContainer.innerHTML = scannerState.cartItems.map(item => `
      <div class="cart-item" style="display:flex;justify-content:space-between;align-items:center;padding:8px;border-bottom:1px solid var(--border);">
        <div style="flex:1;">
          <div style="font-weight:600;font-size:0.9rem;">${escapeHtml(item.sku)}</div>
          <div class="muted" style="font-size:0.85rem;">$${(item.unitPriceCents / 100).toFixed(2)} each</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <button class="secondary" style="padding:2px 8px;" onclick="updateItemQuantity('${item.id}', ${item.quantity - 1})">-</button>
          <span style="min-width:24px;text-align:center;">${item.quantity}</span>
          <button class="secondary" style="padding:2px 8px;" onclick="updateItemQuantity('${item.id}', ${item.quantity + 1})">+</button>
          <span style="min-width:60px;text-align:right;font-weight:600;">$${(item.lineTotalCents / 100).toFixed(2)}</span>
          <button class="secondary" style="padding:2px 6px;color:#c00;" onclick="removeItem('${item.id}')">×</button>
        </div>
      </div>
    `).join('');
    checkoutBtn.disabled = false;
  }

  // Calculate totals
  const subtotal = scannerState.totalCents;
  const tax = Math.round(subtotal * TAX_RATE);
  const total = subtotal + tax;

  subtotalEl.textContent = `$${(subtotal / 100).toFixed(2)}`;
  taxEl.textContent = `$${(tax / 100).toFixed(2)}`;
  totalEl.textContent = `$${(total / 100).toFixed(2)}`;
}

function addRecentScan(sku, message) {
  const timestamp = new Date().toLocaleTimeString();
  scannerState.recentScans.unshift({ timestamp, sku, message });

  // Keep only last 50
  if (scannerState.recentScans.length > 50) {
    scannerState.recentScans.pop();
  }

  const container = document.getElementById('scannerRecentScans');
  container.innerHTML = scannerState.recentScans.map(scan => `
    <div style="padding:4px 0;border-bottom:1px solid var(--border);">
      <span class="muted">${scan.timestamp}</span>
      <span style="font-weight:600;margin:0 8px;">${escapeHtml(scan.sku)}</span>
      <span>${escapeHtml(scan.message)}</span>
    </div>
  `).join('');
}

// =============== SCANNER FUNCTIONS ===============
async function populateCameraList() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter(d => d.kind === 'videoinput');

    const select = document.getElementById('scannerCameraSelect');
    select.innerHTML = '<option value="">Select camera...</option>';

    videoDevices.forEach((device, index) => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || `Camera ${index + 1}`;
      select.appendChild(option);
    });

    // Select first camera by default
    if (videoDevices.length > 0) {
      select.value = videoDevices[0].deviceId;
    }
  } catch (err) {
    console.error('[Scanner] Failed to enumerate cameras:', err);
  }
}

async function startScanner() {
  if (scannerState.scanning) return;

  const startBtn = document.getElementById('scannerStartBtn');
  const stopBtn = document.getElementById('scannerStopBtn');
  const cameraSelect = document.getElementById('scannerCameraSelect');

  try {
    startBtn.disabled = true;
    startBtn.textContent = 'Starting...';

    // Check if Html5QrcodeScanner is available
    if (typeof Html5Qrcode === 'undefined') {
      throw new Error('QR Scanner library not loaded. Please install html5-qrcode.');
    }

    const cameraId = cameraSelect.value;
    if (!cameraId) {
      throw new Error('Please select a camera');
    }

    scannerState.html5QrScanner = new Html5Qrcode('scannerVideoContainer');

    await scannerState.html5QrScanner.start(
      cameraId,
      {
        fps: 10,
        qrbox: { width: 250, height: 250 },
        aspectRatio: 1.0
      },
      onQrCodeScanned,
      (errorMessage) => {
        // Ignore scan errors (no QR found)
      }
    );

    scannerState.scanning = true;
    scannerState.currentCameraId = cameraId;

    startBtn.style.display = 'none';
    stopBtn.disabled = false;
    stopBtn.style.display = 'inline-block';

    addRecentScan('Scanner', 'Started');
  } catch (err) {
    console.error('[Scanner] Start error:', err);
    alert('Failed to start scanner: ' + err.message);
    startBtn.disabled = false;
    startBtn.textContent = 'Start Scanner';
  }
}

async function stopScanner() {
  if (!scannerState.scanning || !scannerState.html5QrScanner) return;

  const startBtn = document.getElementById('scannerStartBtn');
  const stopBtn = document.getElementById('scannerStopBtn');

  try {
    await scannerState.html5QrScanner.stop();
    scannerState.html5QrScanner.clear();
    scannerState.html5QrScanner = null;
    scannerState.scanning = false;

    startBtn.style.display = 'inline-block';
    startBtn.disabled = false;
    startBtn.textContent = 'Start Scanner';
    stopBtn.style.display = 'none';

    addRecentScan('Scanner', 'Stopped');
  } catch (err) {
    console.error('[Scanner] Stop error:', err);
  }
}

let lastScannedCode = null;
let lastScanTime = 0;

function onQrCodeScanned(decodedText) {
  // Debounce - don't scan same code within 2 seconds
  const now = Date.now();
  if (decodedText === lastScannedCode && now - lastScanTime < 2000) {
    return;
  }

  lastScannedCode = decodedText;
  lastScanTime = now;

  console.log('[Scanner] QR Code scanned:', decodedText);

  // Parse the QR URL to extract SKU
  let sku = null;

  try {
    const url = new URL(decodedText);
    sku = url.searchParams.get('sku');
  } catch {
    // Not a URL, assume it's the SKU directly
    sku = decodedText;
  }

  if (sku) {
    addToCart(sku);
  } else {
    addRecentScan('Invalid', 'Could not parse QR code');
    playBeep(false);
  }
}

async function handleManualSkuSubmit(e) {
  e.preventDefault();
  const input = document.getElementById('scannerManualSku');
  const sku = input.value.trim().toUpperCase();

  if (sku) {
    await addToCart(sku);
    input.value = '';
  }
}

// =============== AUDIO FEEDBACK ===============
function playBeep(success) {
  try {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    oscillator.frequency.value = success ? 800 : 300;
    oscillator.type = 'sine';
    gainNode.gain.value = 0.3;

    oscillator.start();
    setTimeout(() => {
      oscillator.stop();
      audioContext.close();
    }, success ? 150 : 300);
  } catch (err) {
    // Audio not supported
  }
}

// =============== UTILITY ===============
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
