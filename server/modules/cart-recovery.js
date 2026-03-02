/**
 * Abandoned Cart Recovery System
 *
 * Tracks shopping carts via Shopify webhooks, detects abandonment,
 * and triggers automated email recovery sequences.
 *
 * Expected Recovery Rate: 15-25% of abandoned carts
 * Revenue Impact: Recovers ~$3-5 per abandoned cart on average
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, '..', '..', 'data');
const CARTS_FILE = path.join(DATA_DIR, 'abandoned-carts.json');
const RECOVERY_LOG = path.join(DATA_DIR, 'cart-recovery-log.json');

// Timing configuration
const ABANDONMENT_THRESHOLD = 60 * 60 * 1000; // 1 hour = cart is "abandoned"
const SEQUENCE_DELAYS = [
  1 * 60 * 60 * 1000,   // Email 1: 1 hour after abandonment
  24 * 60 * 60 * 1000,  // Email 2: 24 hours
  48 * 60 * 60 * 1000   // Email 3: 48 hours (with 10% discount)
];
const CART_EXPIRY = 7 * 24 * 60 * 60 * 1000; // Remove carts older than 7 days

/**
 * Load active abandoned carts from disk
 */
function loadCarts() {
  try {
    if (fs.existsSync(CARTS_FILE)) {
      return JSON.parse(fs.readFileSync(CARTS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[CartRecovery] Error loading carts:', e.message);
  }
  return { carts: {}, stats: { total_abandoned: 0, total_recovered: 0, total_revenue_recovered: 0 } };
}

/**
 * Save carts to disk
 */
function saveCarts(data) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CARTS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[CartRecovery] Error saving carts:', e.message);
  }
}

/**
 * Track a new or updated cart (called from Shopify webhook or checkout event)
 */
function trackCart(cartData) {
  const data = loadCarts();
  const cartId = cartData.id || cartData.token;

  if (!cartId) return;

  data.carts[cartId] = {
    id: cartId,
    customer: {
      email: cartData.email || cartData.customer?.email,
      name: cartData.customer?.first_name || cartData.customer?.name || ''
    },
    items: (cartData.line_items || cartData.items || []).map(item => ({
      title: item.title || item.name,
      variant: item.variant_title,
      quantity: item.quantity,
      price: item.price ? Math.round(parseFloat(item.price) * 100) : item.price_cents || 0,
      image: item.image || item.featured_image?.url
    })),
    totalCents: cartData.total_price
      ? Math.round(parseFloat(cartData.total_price) * 100)
      : cartData.total_cents || 0,
    checkoutUrl: cartData.abandoned_checkout_url || cartData.checkout_url || '',
    createdAt: cartData.created_at || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'active', // active, abandoned, recovered, expired
    emailsSent: 0,
    lastEmailAt: null
  };

  saveCarts(data);
  console.log(`[CartRecovery] Tracking cart ${cartId} (${data.carts[cartId].items.length} items, $${(data.carts[cartId].totalCents / 100).toFixed(2)})`);
  return data.carts[cartId];
}

/**
 * Mark a cart as completed (order placed — stop recovery emails)
 */
function markCartRecovered(cartId, orderTotal = 0) {
  const data = loadCarts();
  const cart = data.carts[cartId];

  if (cart) {
    cart.status = 'recovered';
    cart.recoveredAt = new Date().toISOString();
    data.stats.total_recovered++;
    data.stats.total_revenue_recovered += orderTotal;
    saveCarts(data);
    logRecovery({ action: 'recovered', cartId, orderTotal });
    console.log(`[CartRecovery] Cart ${cartId} recovered! Revenue: $${(orderTotal / 100).toFixed(2)}`);
  }
}

/**
 * Mark a cart as recovered by customer email (for Shopify order webhooks)
 */
function markCartRecoveredByEmail(email, orderTotal = 0) {
  const data = loadCarts();
  let found = false;

  for (const [cartId, cart] of Object.entries(data.carts)) {
    if (cart.customer?.email === email && (cart.status === 'active' || cart.status === 'abandoned')) {
      cart.status = 'recovered';
      cart.recoveredAt = new Date().toISOString();
      data.stats.total_recovered++;
      data.stats.total_revenue_recovered += orderTotal;
      found = true;
      logRecovery({ action: 'recovered_by_email', cartId, email, orderTotal });
      console.log(`[CartRecovery] Cart recovered for ${email}! Revenue: $${(orderTotal / 100).toFixed(2)}`);
    }
  }

  if (found) saveCarts(data);
  return found;
}

/**
 * Process abandoned carts and return emails that need to be sent
 * Call this on a timer (e.g., every 15 minutes)
 */
function processAbandonedCarts() {
  const data = loadCarts();
  const now = Date.now();
  const emailsToSend = [];

  for (const [cartId, cart] of Object.entries(data.carts)) {
    // Skip non-active carts
    if (cart.status !== 'active' && cart.status !== 'abandoned') continue;

    // Skip carts without customer email
    if (!cart.customer?.email) continue;

    // Skip expired carts
    const cartAge = now - new Date(cart.createdAt).getTime();
    if (cartAge > CART_EXPIRY) {
      cart.status = 'expired';
      continue;
    }

    // Check if cart is abandoned (>1 hour with no checkout)
    const timeSinceUpdate = now - new Date(cart.updatedAt).getTime();
    if (timeSinceUpdate < ABANDONMENT_THRESHOLD) continue;

    // Mark as abandoned if not already
    if (cart.status === 'active') {
      cart.status = 'abandoned';
      data.stats.total_abandoned++;
      console.log(`[CartRecovery] Cart ${cartId} marked as abandoned (${cart.customer.email})`);
    }

    // Determine which email to send next
    const nextEmailIndex = cart.emailsSent;
    if (nextEmailIndex >= SEQUENCE_DELAYS.length) continue; // All emails sent

    // Check if it's time to send the next email
    const timeSinceAbandoned = now - new Date(cart.updatedAt).getTime();
    if (timeSinceAbandoned >= SEQUENCE_DELAYS[nextEmailIndex]) {
      // Check we haven't sent this email too recently
      if (cart.lastEmailAt) {
        const timeSinceLastEmail = now - new Date(cart.lastEmailAt).getTime();
        if (timeSinceLastEmail < 30 * 60 * 1000) continue; // Wait at least 30 min between emails
      }

      emailsToSend.push({
        cartId,
        cart,
        sequenceStep: nextEmailIndex,
        customer: cart.customer
      });
    }
  }

  saveCarts(data);
  return emailsToSend;
}

/**
 * Record that an email was sent for a cart
 */
function recordEmailSent(cartId) {
  const data = loadCarts();
  const cart = data.carts[cartId];
  if (cart) {
    cart.emailsSent++;
    cart.lastEmailAt = new Date().toISOString();
    saveCarts(data);
    logRecovery({
      action: 'email_sent',
      cartId,
      email: cart.customer?.email,
      step: cart.emailsSent,
      totalSteps: SEQUENCE_DELAYS.length
    });
  }
}

/**
 * Get abandoned cart statistics
 */
function getStats() {
  const data = loadCarts();
  const carts = Object.values(data.carts);

  const active = carts.filter(c => c.status === 'active').length;
  const abandoned = carts.filter(c => c.status === 'abandoned').length;
  const recovered = carts.filter(c => c.status === 'recovered').length;
  const expired = carts.filter(c => c.status === 'expired').length;

  const totalAbandoned = data.stats.total_abandoned;
  const totalRecovered = data.stats.total_recovered;
  const recoveryRate = totalAbandoned > 0
    ? ((totalRecovered / totalAbandoned) * 100).toFixed(1)
    : '0.0';

  return {
    current: { active, abandoned, recovered, expired },
    lifetime: {
      totalAbandoned,
      totalRecovered,
      recoveryRate: `${recoveryRate}%`,
      revenueRecovered: `$${(data.stats.total_revenue_recovered / 100).toFixed(2)}`
    },
    pendingEmails: carts
      .filter(c => c.status === 'abandoned' && c.emailsSent < SEQUENCE_DELAYS.length)
      .length
  };
}

/**
 * Log recovery activity
 */
function logRecovery(entry) {
  try {
    let log = [];
    if (fs.existsSync(RECOVERY_LOG)) {
      log = JSON.parse(fs.readFileSync(RECOVERY_LOG, 'utf8'));
    }
    log.push({ ...entry, timestamp: new Date().toISOString() });
    if (log.length > 500) log = log.slice(-500);
    fs.writeFileSync(RECOVERY_LOG, JSON.stringify(log, null, 2));
  } catch (e) {
    // Non-critical, just log
  }
}

/**
 * Get recent recovery log
 */
function getRecoveryLog(limit = 25) {
  try {
    if (fs.existsSync(RECOVERY_LOG)) {
      const log = JSON.parse(fs.readFileSync(RECOVERY_LOG, 'utf8'));
      return log.slice(-limit).reverse();
    }
  } catch (e) {
    // ignore
  }
  return [];
}

/**
 * Handle cart recovery API routes
 */
function handleCartRecoveryRoute(req, res, parsedUrl, sendJson) {
  const pathname = parsedUrl.pathname;

  if (pathname === '/api/cart-recovery/stats' && req.method === 'GET') {
    sendJson(res, getStats());
    return true;
  }

  if (pathname === '/api/cart-recovery/log' && req.method === 'GET') {
    sendJson(res, getRecoveryLog());
    return true;
  }

  if (pathname === '/api/cart-recovery/process' && req.method === 'POST') {
    const pending = processAbandonedCarts();
    sendJson(res, { pending: pending.length, carts: pending.map(p => ({
      cartId: p.cartId,
      email: p.customer.email,
      step: p.sequenceStep + 1,
      items: p.cart.items.length,
      total: `$${(p.cart.totalCents / 100).toFixed(2)}`
    }))});
    return true;
  }

  return false;
}

module.exports = {
  trackCart,
  markCartRecovered,
  markCartRecoveredByEmail,
  processAbandonedCarts,
  recordEmailSent,
  getStats,
  getRecoveryLog,
  handleCartRecoveryRoute
};
