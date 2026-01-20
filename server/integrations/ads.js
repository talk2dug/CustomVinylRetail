const https = require('https');
const { renderTemplate } = require('../utils/template');
const fs = require('fs');
const path = require('path');

// Env config
const META_TOKEN = process.env.META_ACCESS_TOKEN || process.env.FACEBOOK_ACCESS_TOKEN || '';
const META_AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID || process.env.FACEBOOK_AD_ACCOUNT_ID || '';
const TIKTOK_TOKEN = process.env.TIKTOK_ACCESS_TOKEN || '';
const TIKTOK_AD_ACCOUNT_ID = process.env.TIKTOK_AD_ACCOUNT_ID || '';

const DATA_DIR = path.join(path.resolve(__dirname, '..', '..'), 'data');
const AUDIENCE_MAP_FILE = path.join(DATA_DIR, 'audience-map.json');
const TEMPLATES_FILE = path.join(DATA_DIR, 'ad-templates.json');
const PERF_FILE = path.join(DATA_DIR, 'ads-performance.json');

function readAudienceMap() {
  try {
    const raw = fs.readFileSync(AUDIENCE_MAP_FILE, 'utf8');
    return JSON.parse(raw || '{}');
  } catch (e) {
    return { audience_map: {} };
  }
}

function readTemplates() {
  try {
    const raw = fs.readFileSync(TEMPLATES_FILE, 'utf8');
    return JSON.parse(raw || '{}');
  } catch (e) {
    return { templates: { default: { headline: '{title}', body: '{description}', cta: 'Shop Now' } } };
  }
}

function mapAudienceToAds(audienceSegment) {
  const mapping = readAudienceMap();
  const entry = mapping.audience_map?.[audienceSegment] || null;
  return entry || null;
}

function httpJson(method, fullUrl, headers, body) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(fullUrl);
      const req = https.request(
        {
          method,
          hostname: u.hostname,
          port: u.port || 443,
          path: u.pathname + (u.search || ''),
          headers: headers || {}
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try { json = JSON.parse(text || '{}'); } catch (_) {}
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(json || { ok: true });
            } else {
              const err = new Error((json && (json.error?.message || json.message)) || text || `HTTP ${res.statusCode}`);
              err.status = res.statusCode;
              err.detail = json || text;
              reject(err);
            }
          });
        }
      );
      req.on('error', reject);
      if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

function generateAdCreative(product, templateKey, overrides = {}) {
  const title = product?.title || product?.name || 'Great product';
  const description = product?.body_html ? String(product.body_html).replace(/<[^>]+>/g, '') : (product?.description || '');
  const profile = overrides?.marketing_profile || {};
  const segment = profile.audience_segment || overrides?.audience_segment || 'general';
  const interests = Array.isArray(profile.interests) ? profile.interests.join(', ') : '';
  const storeBase = process.env.STORE_BASE_URL || '';
  const productUrl = overrides?.product_url || (product?.handle && storeBase ? `${storeBase.replace(/\/$/,'')}/products/${product.handle}` : storeBase || '');
  const utmParams = overrides?.utm || { utm_source: 'ads', utm_medium: 'paid', utm_campaign: segment, utm_content: templateKey || 'default' };
  const linkUrl = addUtmParams(productUrl, utmParams);
  const vars = {
    title,
    description,
    audience_segment: segment,
    interests,
    mockup_url: overrides?.mockup_url || product?.image || product?.image?.src || ''
  };
  const all = readTemplates();
  const templates = all.templates || {};
  // Choose template with fallbacks by provided key, marketing tone, audience, then default
  const toneKey = (overrides?.marketing_profile?.tone || '').toLowerCase();
  const audienceKey = templateKey || overrides?.marketing_profile?.ad_template || `template_${(overrides?.marketing_profile?.audience_segment || '').toLowerCase()}`;
  const tpl = templates[audienceKey] || (toneKey && templates[toneKey]) || templates.default || { headline: '{title}', body: '{description}', cta: 'Shop Now' };
  return {
    headline: renderTemplate(tpl.headline, vars),
    body: renderTemplate(tpl.body, vars),
    cta: tpl.cta,
    image_url: vars.mockup_url,
    link_url: linkUrl
  };
}

function buildMetaTargetingFromProfile(profile = {}, mapping = {}) {
  const t = {};
  // Age
  const ar = String(profile?.demographics?.age_range || '').toLowerCase();
  const ageMap = {
    '18-24': { min: 18, max: 24 },
    '25-34': { min: 25, max: 34 },
    '35-44': { min: 35, max: 44 },
    '45-54': { min: 45, max: 54 },
    '55+': { min: 55, max: 65 }
  };
  if (ageMap[ar]) { t.age_min = ageMap[ar].min; t.age_max = ageMap[ar].max; }
  // Gender
  const g = String(profile?.demographics?.gender || '').toLowerCase();
  if (g === 'male') t.genders = [1]; else if (g === 'female') t.genders = [2];
  // Locations (countries only unless you provide keys)
  const locs = Array.isArray(profile?.locations) ? profile.locations : [];
  const countries = Array.from(new Set(locs.map((l) => String(l.country || '').toUpperCase()).filter(Boolean)));
  t.geo_locations = { countries: countries.length ? countries : ['US'] };
  // Interests via mapping (IDs)
  const ids = Array.isArray(mapping.meta_interest_ids) ? mapping.meta_interest_ids : [];
  if (ids.length) {
    t.flexible_spec = [ { interests: ids.map((id) => ({ id: String(id) })) } ];
  }
  // Saved audience (if provided)
  if (mapping.meta_audience_id) t.saved_audience_id = String(mapping.meta_audience_id);
  return t;
}

async function createMetaCampaign({ name, objective = 'TRAFFIC', dailyBudgetCents = 500, creative, targeting }) {
  if (!META_TOKEN || !META_AD_ACCOUNT_ID) throw new Error('Meta ads not configured');
  const base = `https://graph.facebook.com/v17.0/act_${encodeURIComponent(META_AD_ACCOUNT_ID)}`;
  const headers = { 'Content-Type': 'application/json' };
  const auth = `access_token=${encodeURIComponent(META_TOKEN)}`;
  // Create campaign
  const campaign = await httpJson('POST', `${base}/campaigns?${auth}`, headers, {
    name,
    objective,
    status: 'PAUSED'
  });
  // Minimal ad set + ad stubs; in production you’d set targeting and creative properly.
  const adsetPayload = {
    name: `${name} Set`,
    optimization_goal: 'OFFSITE_CONVERSIONS',
    billing_event: 'IMPRESSIONS',
    daily_budget: String(dailyBudgetCents),
    campaign_id: campaign?.id,
    status: 'PAUSED'
  };
  if (targeting && Object.keys(targeting).length) adsetPayload.targeting = targeting;
  const adset = await httpJson('POST', `${base}/adsets?${auth}`, headers, adsetPayload);
  const ad = await httpJson('POST', `${base}/ads?${auth}`, headers, {
    name: `${name} Ad`,
    adset_id: adset?.id,
    creative: { object_story_spec: { link_data: { name: creative?.headline, message: creative?.body, link: creative?.link_url || 'https://example.com' } } },
    status: 'PAUSED'
  });
  return { campaign, adset, ad };
}

async function createTikTokCampaign({ name, objective = 'TRAFFIC', dailyBudget = 5, creative, targeting }) {
  if (!TIKTOK_TOKEN || !TIKTOK_AD_ACCOUNT_ID) throw new Error('TikTok ads not configured');
  const base = 'https://business-api.tiktok.com/open_api/v1.3';
  const headers = {
    'Content-Type': 'application/json',
    'Access-Token': TIKTOK_TOKEN
  };
  // Create campaign (simplified)
  const campaign = await httpJson('POST', `${base}/campaign/create/`, headers, {
    advertiser_id: TIKTOK_AD_ACCOUNT_ID,
    campaign_name: name,
    objective_type: objective,
    budget_mode: 'BUDGET_MODE_DAY',
    budget: dailyBudget
  });
  return { campaign, targeting_applied: targeting || null };
}

function buildTikTokTargetingFromProfile(profile = {}, mapping = {}) {
  const t = {};
  // Age mapping
  const ar = String(profile?.demographics?.age_range || '').toLowerCase();
  const ageMap = {
    '18-24': ['AGE_18_24'],
    '25-34': ['AGE_25_34'],
    '35-44': ['AGE_35_44'],
    '45-54': ['AGE_45_54'],
    '55+': ['AGE_55_PLUS']
  };
  if (ageMap[ar]) t.age = ageMap[ar];
  // Gender
  const g = String(profile?.demographics?.gender || '').toLowerCase();
  if (g === 'male') t.gender = 'GENDER_MALE'; else if (g === 'female') t.gender = 'GENDER_FEMALE'; else t.gender = 'GENDER_ALL';
  // Locations (countries); TikTok expects location list codes; use countries only by default
  const locs = Array.isArray(profile?.locations) ? profile.locations : [];
  const countries = Array.from(new Set(locs.map((l) => String(l.country || '').toUpperCase()).filter(Boolean)));
  if (countries.length) t.location = { location_types: ['CURRENT'], countries };
  // Interests
  const ids = Array.isArray(mapping.tiktok_interest_ids) ? mapping.tiktok_interest_ids : [];
  if (ids.length) t.interest_category_v2 = { interest_categories: ids.map((id) => String(id)) };
  return t;
}

function addUtmParams(url, params) {
  try {
    const u = new URL(url);
    Object.entries(params || {}).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
    });
    return u.toString();
  } catch (e) {
    return url;
  }
}

async function createAdCampaign(platform, { name, audience_id, creative, budget = 500, targeting }) {
  if (platform === 'meta') {
    return createMetaCampaign({ name, dailyBudgetCents: budget, creative, targeting });
  }
  if (platform === 'tiktok') {
    return createTikTokCampaign({ name, dailyBudget: Math.round(budget / 100), creative });
  }
  throw new Error(`Unsupported platform: ${platform}`);
}

function readPerformance(limit = 200) {
  try {
    const cur = fs.existsSync(PERF_FILE) ? JSON.parse(fs.readFileSync(PERF_FILE, 'utf8') || '{"records":[]}') : { records: [] };
    const records = Array.isArray(cur.records) ? cur.records : [];
    return records.slice(-Math.max(1, Math.min(1000, Number(limit)||200)));
  } catch (_) {
    return [];
  }
}

/**
 * Fetch Meta/Facebook Ad Account Insights
 * @param {string} period - '7d', '30d', '90d', or custom date range
 * @returns {Promise<Object>} Aggregated insights data
 */
async function getMetaInsights(period = '7d') {
  if (!META_TOKEN || !META_AD_ACCOUNT_ID) {
    return { error: 'Meta ads not configured', configured: false };
  }

  try {
    // Calculate date range
    const now = new Date();
    let since, until;

    switch (period) {
      case '7d':
        since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case '30d':
        since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      case '90d':
        since = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
        break;
      default:
        since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    }
    until = now;

    const sinceStr = since.toISOString().split('T')[0];
    const untilStr = until.toISOString().split('T')[0];

    const base = `https://graph.facebook.com/v18.0/act_${encodeURIComponent(META_AD_ACCOUNT_ID)}`;
    const auth = `access_token=${encodeURIComponent(META_TOKEN)}`;

    // Fetch account-level insights
    const fields = [
      'impressions',
      'clicks',
      'spend',
      'reach',
      'cpc',
      'cpm',
      'ctr',
      'actions',
      'cost_per_action_type',
      'website_ctr'
    ].join(',');

    const insightsUrl = `${base}/insights?${auth}&fields=${fields}&time_range={"since":"${sinceStr}","until":"${untilStr}"}&level=account`;

    const result = await httpJson('GET', insightsUrl, {});

    // Parse the response
    const data = result?.data?.[0] || {};

    // Extract action metrics (purchases, add to cart, page views, etc.)
    const actions = Array.isArray(data.actions) ? data.actions : [];
    const costPerAction = Array.isArray(data.cost_per_action_type) ? data.cost_per_action_type : [];

    const getActionValue = (actionType) => {
      const action = actions.find(a => a.action_type === actionType);
      return action ? parseInt(action.value, 10) : 0;
    };

    const getCostPerAction = (actionType) => {
      const cost = costPerAction.find(a => a.action_type === actionType);
      return cost ? parseFloat(cost.value) : 0;
    };

    // Calculate ROAS
    const spend = parseFloat(data.spend || 0);
    const purchaseValue = getActionValue('omni_purchase') || getActionValue('purchase');
    const purchases = getActionValue('omni_purchase') || getActionValue('purchase') || getActionValue('offsite_conversion.fb_pixel_purchase');

    // Estimate revenue (if conversion value tracking is set up)
    const conversionValueActions = actions.filter(a =>
      a.action_type?.includes('purchase') && a.value
    );
    let estimatedRevenue = 0;
    conversionValueActions.forEach(a => {
      estimatedRevenue += parseFloat(a.value || 0);
    });

    const roas = spend > 0 && estimatedRevenue > 0 ? (estimatedRevenue / spend) : 0;

    return {
      success: true,
      configured: true,
      period,
      dateRange: { since: sinceStr, until: untilStr },
      metrics: {
        // Traffic & Engagement
        impressions: parseInt(data.impressions || 0, 10),
        reach: parseInt(data.reach || 0, 10),
        clicks: parseInt(data.clicks || 0, 10),
        ctr: parseFloat(data.ctr || 0),

        // Cost metrics
        spend: spend,
        cpc: parseFloat(data.cpc || 0),
        cpm: parseFloat(data.cpm || 0),

        // Conversions
        pageViews: getActionValue('landing_page_view') || getActionValue('view_content'),
        addToCart: getActionValue('omni_add_to_cart') || getActionValue('add_to_cart') || getActionValue('offsite_conversion.fb_pixel_add_to_cart'),
        initiateCheckout: getActionValue('omni_initiated_checkout') || getActionValue('initiate_checkout'),
        purchases: purchases,

        // Value metrics
        purchaseValue: estimatedRevenue,
        roas: roas,
        costPerPurchase: getCostPerAction('omni_purchase') || getCostPerAction('purchase')
      },
      raw: data
    };
  } catch (e) {
    console.error('[Meta Insights] Error fetching insights:', e.message);
    return {
      error: e.message,
      configured: true,
      success: false
    };
  }
}

/**
 * Fetch Meta Pixel events data
 * Requires pixel_id to be set
 */
async function getMetaPixelEvents(period = '7d') {
  const pixelId = process.env.META_PIXEL_ID || process.env.FACEBOOK_PIXEL_ID || '';

  if (!META_TOKEN || !pixelId) {
    return { error: 'Meta Pixel not configured', configured: false };
  }

  try {
    const now = new Date();
    let since;

    switch (period) {
      case '7d':
        since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case '30d':
        since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      case '90d':
        since = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
        break;
      default:
        since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    }

    const sinceStr = since.toISOString().split('T')[0];
    const untilStr = now.toISOString().split('T')[0];

    const auth = `access_token=${encodeURIComponent(META_TOKEN)}`;
    const url = `https://graph.facebook.com/v18.0/${pixelId}/stats?${auth}&start_time=${sinceStr}&end_time=${untilStr}`;

    const result = await httpJson('GET', url, {});

    return {
      success: true,
      configured: true,
      period,
      data: result?.data || []
    };
  } catch (e) {
    console.error('[Meta Pixel] Error fetching events:', e.message);
    return {
      error: e.message,
      configured: true,
      success: false
    };
  }
}

/**
 * Get combined social/marketing stats for dashboard
 */
async function getDashboardSocialStats(period = '7d') {
  // Try to get Meta insights
  const metaInsights = await getMetaInsights(period);

  if (metaInsights.success && metaInsights.metrics) {
    const m = metaInsights.metrics;
    return {
      success: true,
      configured: true,
      period,
      // Map to dashboard format
      pageViews: m.pageViews || 0,
      visitors: m.reach || 0,
      addToCart: m.addToCart || 0,
      conversions: m.purchases || 0,
      adSpend: m.spend || 0,
      roas: m.roas || 0,
      cpc: m.cpc || 0,
      ctr: m.ctr || 0,
      // Additional metrics
      impressions: m.impressions || 0,
      clicks: m.clicks || 0,
      revenue: m.purchaseValue || 0
    };
  }

  // Return placeholder if not configured or error
  return {
    success: false,
    configured: metaInsights.configured || false,
    error: metaInsights.error || 'Unable to fetch social stats',
    period,
    pageViews: 0,
    visitors: 0,
    addToCart: 0,
    conversions: 0,
    adSpend: 0,
    roas: 0,
    cpc: 0,
    ctr: 0
  };
}

function updateTargetingFromPerformance(data) {
  try {
    const cur = fs.existsSync(PERF_FILE) ? JSON.parse(fs.readFileSync(PERF_FILE, 'utf8') || '{"records":[]}') : { records: [] };
    const records = Array.isArray(cur.records) ? cur.records : [];
    records.push({ ts: new Date().toISOString(), ...data });
    const next = { records };
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PERF_FILE, JSON.stringify(next, null, 2), 'utf8');
    return { success: true };
  } catch (e) {
    return { success: false, error: e?.message || String(e) };
  }
}

module.exports = {
  readAudienceMap,
  readTemplates,
  mapAudienceToAds,
  generateAdCreative,
  createAdCampaign,
  buildMetaTargetingFromProfile,
  addUtmParams,
  updateTargetingFromPerformance,
  readPerformance,
  // Dashboard/Insights
  getMetaInsights,
  getMetaPixelEvents,
  getDashboardSocialStats
};
