function classifyMarketingProfile(product = {}) {
  const text = `${product.title || ''} ${stripHtml(product.body_html || product.description || '')}`.toLowerCase();
  const out = {
    audience_segment: 'general',
    interests: [],
    generation: '',
    tone: '',
    ad_template: 'default',
    ad_audience_id: '',
    campaign_priority: 0,
    keywords: []
  };

  const add = (arr, v) => { if (v && !arr.includes(v)) arr.push(v); };

  // Heuristics
  if (/(race|racing|motorsport|nascar|track|pit|car|drift)/.test(text)) {
    out.audience_segment = 'car_enthusiasts';
    add(out.interests, 'racing');
    add(out.interests, 'cars');
    out.tone = out.tone || 'energetic';
    add(out.keywords, 'racing');
    add(out.keywords, 'motorsport');
  }
  if (/(retro|vintage|classic|throwback)/.test(text)) {
    out.generation = out.generation || 'gen_x';
    out.tone = out.tone || 'nostalgic';
    add(out.keywords, 'retro');
    add(out.keywords, 'vintage');
  }
  if (/(funny|humor|joke|meme)/.test(text)) {
    out.tone = out.tone || 'humorous';
  }
  if (/(mom|dad|family|kids|child)/.test(text)) {
    out.audience_segment = out.audience_segment === 'general' ? 'family' : out.audience_segment;
    add(out.interests, 'family');
  }
  if (/(truck|offroad|4x4|atv)/.test(text)) {
    out.audience_segment = 'truck_offroad';
    add(out.interests, 'offroad');
  }

  // Defaults if still general
  if (out.audience_segment === 'general') {
    out.tone = out.tone || 'informative';
  }

  return out;
}

function stripHtml(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ');
}

module.exports = { classifyMarketingProfile };

