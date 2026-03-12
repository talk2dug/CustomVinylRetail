/**
 * Sales Analytics Dashboard
 *
 * Aggregates data from all sales channels and provides KPI tracking:
 * - Revenue by channel and product
 * - Conversion rates
 * - Average order value (AOV)
 * - Customer acquisition cost (CAC)
 * - Email sequence performance
 * - Cart recovery metrics
 * - Top products and categories
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, '..', '..', 'data');
const ANALYTICS_FILE = path.join(DATA_DIR, 'sales-analytics.json');
const DAILY_FILE = path.join(DATA_DIR, 'daily-metrics.json');

/**
 * Load analytics data
 */
function loadAnalytics() {
  try {
    if (fs.existsSync(ANALYTICS_FILE)) {
      return JSON.parse(fs.readFileSync(ANALYTICS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[Analytics] Error loading data:', e.message);
  }
  return createEmptyAnalytics();
}

function createEmptyAnalytics() {
  return {
    orders: [],
    revenue: { total: 0, byChannel: {}, byProduct: {}, byCategory: {} },
    customers: { total: 0, new: 0, returning: 0, emails: new Set() },
    email: { sent: 0, opened: 0, clicked: 0, bySequence: {} },
    ads: { spend: 0, impressions: 0, clicks: 0, conversions: 0 },
    lastUpdated: null
  };
}

/**
 * Save analytics
 */
function saveAnalytics(data) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // Convert Sets to arrays for JSON serialization
    const serializable = JSON.parse(JSON.stringify(data, (key, value) =>
      value instanceof Set ? [...value] : value
    ));
    const tmp = ANALYTICS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(serializable, null, 2));
    fs.renameSync(tmp, ANALYTICS_FILE);
  } catch (e) {
    console.error('[Analytics] Error saving data:', e.message);
  }
}

/**
 * Record an order event
 */
function recordOrder(order) {
  const data = loadAnalytics();
  const channel = order.channel || 'shopify';
  const totalCents = order.totalCents || 0;

  data.orders.push({
    id: order.id,
    channel,
    totalCents,
    itemCount: order.items?.length || 0,
    items: (order.items || []).map(i => ({
      category: i.category,
      title: i.title,
      priceCents: i.priceCents,
      quantity: i.quantity || 1
    })),
    customerEmail: order.customerEmail,
    isNewCustomer: order.isNewCustomer || false,
    source: order.source || 'direct', // direct, email, ad, referral, organic
    createdAt: new Date().toISOString()
  });

  // Update revenue totals
  data.revenue.total += totalCents;
  data.revenue.byChannel[channel] = (data.revenue.byChannel[channel] || 0) + totalCents;

  // Update per-product and per-category revenue
  for (const item of (order.items || [])) {
    const cat = item.category || 'other';
    data.revenue.byCategory[cat] = (data.revenue.byCategory[cat] || 0) + (item.priceCents || 0);
    if (item.title) {
      data.revenue.byProduct[item.title] = (data.revenue.byProduct[item.title] || 0) + (item.priceCents || 0);
    }
  }

  // Customer tracking
  const emails = new Set(data.customers.emails || []);
  if (order.customerEmail) {
    if (!emails.has(order.customerEmail)) {
      emails.add(order.customerEmail);
      data.customers.new++;
    } else {
      data.customers.returning++;
    }
    data.customers.emails = [...emails];
  }
  data.customers.total = emails.size;

  // Keep last 10000 orders
  if (data.orders.length > 10000) {
    data.orders = data.orders.slice(-10000);
  }

  data.lastUpdated = new Date().toISOString();
  saveAnalytics(data);

  // Update daily metrics
  recordDailyMetric('orders', 1);
  recordDailyMetric('revenue', totalCents);
}

/**
 * Record email metrics
 */
function recordEmailEvent(event, sequenceType) {
  const data = loadAnalytics();

  if (event === 'sent') data.email.sent++;
  else if (event === 'opened') data.email.opened++;
  else if (event === 'clicked') data.email.clicked++;

  if (sequenceType) {
    if (!data.email.bySequence[sequenceType]) {
      data.email.bySequence[sequenceType] = { sent: 0, opened: 0, clicked: 0, converted: 0 };
    }
    data.email.bySequence[sequenceType][event] = (data.email.bySequence[sequenceType][event] || 0) + 1;
  }

  saveAnalytics(data);
  recordDailyMetric(`email_${event}`, 1);
}

/**
 * Record ad spend/performance
 */
function recordAdMetrics({ spend = 0, impressions = 0, clicks = 0, conversions = 0, platform = 'meta' }) {
  const data = loadAnalytics();
  data.ads.spend += spend;
  data.ads.impressions += impressions;
  data.ads.clicks += clicks;
  data.ads.conversions += conversions;
  saveAnalytics(data);
}

/**
 * Record a daily metric
 */
function recordDailyMetric(metric, value) {
  try {
    let daily = {};
    if (fs.existsSync(DAILY_FILE)) {
      daily = JSON.parse(fs.readFileSync(DAILY_FILE, 'utf8'));
    }

    const today = new Date().toISOString().split('T')[0];
    if (!daily[today]) daily[today] = {};
    daily[today][metric] = (daily[today][metric] || 0) + value;

    // Keep last 90 days
    const keys = Object.keys(daily).sort();
    if (keys.length > 90) {
      const keysToRemove = keys.slice(0, keys.length - 90);
      keysToRemove.forEach(k => delete daily[k]);
    }

    const tmp = DAILY_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(daily, null, 2));
    fs.renameSync(tmp, DAILY_FILE);
  } catch (e) {
    // Non-critical
  }
}

/**
 * Get dashboard summary
 */
function getDashboardSummary(period = 30) {
  const data = loadAnalytics();
  const cutoff = new Date(Date.now() - period * 24 * 60 * 60 * 1000);

  const recentOrders = data.orders.filter(o => new Date(o.createdAt) > cutoff);
  const totalRevenue = recentOrders.reduce((sum, o) => sum + o.totalCents, 0);

  // Revenue by channel
  const revenueByChannel = {};
  recentOrders.forEach(o => {
    revenueByChannel[o.channel] = (revenueByChannel[o.channel] || 0) + o.totalCents;
  });

  // Revenue by category
  const revenueByCategory = {};
  recentOrders.forEach(o => {
    (o.items || []).forEach(item => {
      const cat = item.category || 'other';
      revenueByCategory[cat] = (revenueByCategory[cat] || 0) + (item.priceCents || 0) * (item.quantity || 1);
    });
  });

  // Top products
  const productSales = {};
  recentOrders.forEach(o => {
    (o.items || []).forEach(item => {
      if (item.title) {
        if (!productSales[item.title]) productSales[item.title] = { units: 0, revenue: 0 };
        productSales[item.title].units += item.quantity || 1;
        productSales[item.title].revenue += (item.priceCents || 0) * (item.quantity || 1);
      }
    });
  });

  const topProducts = Object.entries(productSales)
    .map(([title, data]) => ({ title, ...data }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10);

  // Calculate KPIs
  const uniqueCustomers = new Set(recentOrders.map(o => o.customerEmail).filter(Boolean));
  const aovCents = recentOrders.length > 0 ? Math.round(totalRevenue / recentOrders.length) : 0;
  const newCustomers = recentOrders.filter(o => o.isNewCustomer).length;
  const returningCustomers = recentOrders.length - newCustomers;

  // Traffic sources
  const ordersBySource = {};
  recentOrders.forEach(o => {
    ordersBySource[o.source || 'direct'] = (ordersBySource[o.source || 'direct'] || 0) + 1;
  });

  // Email metrics
  const emailOpenRate = data.email.sent > 0
    ? ((data.email.opened / data.email.sent) * 100).toFixed(1)
    : '0.0';
  const emailClickRate = data.email.opened > 0
    ? ((data.email.clicked / data.email.opened) * 100).toFixed(1)
    : '0.0';

  // Ad metrics
  const adCPC = data.ads.clicks > 0
    ? (data.ads.spend / data.ads.clicks / 100).toFixed(2)
    : '0.00';
  const adROAS = data.ads.spend > 0
    ? (totalRevenue / data.ads.spend).toFixed(2)
    : '0.00';

  return {
    period: `${period} days`,
    kpis: {
      totalRevenue: `$${(totalRevenue / 100).toFixed(2)}`,
      totalOrders: recentOrders.length,
      averageOrderValue: `$${(aovCents / 100).toFixed(2)}`,
      uniqueCustomers: uniqueCustomers.size,
      newCustomers,
      returningCustomers,
      repeatRate: uniqueCustomers.size > 0
        ? `${((returningCustomers / uniqueCustomers.size) * 100).toFixed(1)}%`
        : '0.0%'
    },
    revenue: {
      total: `$${(totalRevenue / 100).toFixed(2)}`,
      byChannel: Object.fromEntries(
        Object.entries(revenueByChannel).map(([k, v]) => [k, `$${(v / 100).toFixed(2)}`])
      ),
      byCategory: Object.fromEntries(
        Object.entries(revenueByCategory)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => [k, `$${(v / 100).toFixed(2)}`])
      )
    },
    topProducts,
    sources: ordersBySource,
    email: {
      totalSent: data.email.sent,
      openRate: `${emailOpenRate}%`,
      clickRate: `${emailClickRate}%`,
      bySequence: data.email.bySequence
    },
    ads: {
      totalSpend: `$${(data.ads.spend / 100).toFixed(2)}`,
      impressions: data.ads.impressions,
      clicks: data.ads.clicks,
      conversions: data.ads.conversions,
      cpc: `$${adCPC}`,
      roas: `${adROAS}x`
    }
  };
}

/**
 * Get daily metrics for chart display
 */
function getDailyMetrics(days = 30) {
  try {
    if (!fs.existsSync(DAILY_FILE)) return [];

    const daily = JSON.parse(fs.readFileSync(DAILY_FILE, 'utf8'));
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    return Object.entries(daily)
      .filter(([date]) => new Date(date) > cutoff)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, metrics]) => ({
        date,
        orders: metrics.orders || 0,
        revenue: metrics.revenue || 0,
        revenueDisplay: `$${((metrics.revenue || 0) / 100).toFixed(2)}`,
        emailSent: metrics.email_sent || 0,
        emailOpened: metrics.email_opened || 0
      }));
  } catch (e) {
    return [];
  }
}

/**
 * Get channel performance comparison
 */
function getChannelPerformance() {
  const data = loadAnalytics();
  const channels = {};

  for (const order of data.orders) {
    const ch = order.channel || 'shopify';
    if (!channels[ch]) {
      channels[ch] = { orders: 0, revenue: 0, avgOrderValue: 0, items: 0 };
    }
    channels[ch].orders++;
    channels[ch].revenue += order.totalCents;
    channels[ch].items += order.itemCount || 0;
  }

  // Calculate averages
  for (const ch of Object.values(channels)) {
    ch.avgOrderValue = ch.orders > 0 ? Math.round(ch.revenue / ch.orders) : 0;
    ch.revenueDisplay = `$${(ch.revenue / 100).toFixed(2)}`;
    ch.avgOrderValueDisplay = `$${(ch.avgOrderValue / 100).toFixed(2)}`;
  }

  return channels;
}

/**
 * Handle analytics API routes
 */
function handleAnalyticsRoute(req, res, parsedUrl, sendJson) {
  const pathname = parsedUrl.pathname;

  // Dashboard summary
  if (pathname === '/api/analytics/dashboard' && req.method === 'GET') {
    const period = parseInt(parsedUrl.searchParams?.get('period') || '30');
    sendJson(res, getDashboardSummary(period));
    return true;
  }

  // Daily metrics for charts
  if (pathname === '/api/analytics/daily' && req.method === 'GET') {
    const days = parseInt(parsedUrl.searchParams?.get('days') || '30');
    sendJson(res, getDailyMetrics(days));
    return true;
  }

  // Channel performance
  if (pathname === '/api/analytics/channels' && req.method === 'GET') {
    sendJson(res, getChannelPerformance());
    return true;
  }

  // Record order (webhook handler)
  if (pathname === '/api/analytics/order' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const order = JSON.parse(body);
        recordOrder(order);
        sendJson(res, { success: true });
      } catch (err) {
        sendJson(res, { error: err.message }, 400);
      }
    });
    return true;
  }

  return false;
}

module.exports = {
  recordOrder,
  recordEmailEvent,
  recordAdMetrics,
  recordDailyMetric,
  getDashboardSummary,
  getDailyMetrics,
  getChannelPerformance,
  handleAnalyticsRoute
};
