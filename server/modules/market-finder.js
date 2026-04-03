/**
 * Market Finder — Automated vendor market/event discovery
 *
 * Searches Eventbrite, Google, and local sources for craft fairs, maker markets,
 * pop-ups, and vendor events near Asheville NC. Uses Claude to evaluate product fit.
 * Stores leads in market_leads table, sends Telegram digest of new finds.
 */

const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { parseBody, sendJson, sendError } = require('../utils/http');

const DATA_DIR = path.resolve(__dirname, '..', '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'market-finder.json');

// ─── Config ───────────────────────────────────────────────────────────────────

const SEARCH_LOCATION = 'Asheville, NC';
const SEARCH_RADIUS_MILES = 60;
const SEARCH_LAT = 35.5951;
const SEARCH_LNG = -82.5515;

const PRODUCT_PROFILE = {
  business: 'Blue Ridge Custom Co',
  types: [
    'Custom vinyl stickers & decals',
    'DTF-printed apparel (t-shirts, hoodies, hats)',
    'Metal photo prints on aluminum',
    'Laser-engraved tumblers & drinkware',
    '3D printed wall organization systems (Multiboard)'
  ],
  keywords: ['handmade', 'custom', 'maker', 'craft', 'print', 'vinyl', 'apparel'],
  disqualifiers: [
    'food vendors only',
    'produce only',
    'farmers market - agricultural products only',
    'fine art juried (painting/sculpture only)',
    'MLM / direct sales only',
    'non-profit / charity booths only',
    'food truck rally'
  ]
};

const SEARCH_QUERIES = [
  'craft fair vendor booth Asheville NC',
  'maker market Asheville NC 2026',
  'vendor event Western North Carolina',
  'pop up market Asheville',
  'craft show booth rental Asheville NC',
  'artisan market WNC',
  'flea market vendor Asheville',
  'holiday craft fair Asheville NC',
  'handmade market North Carolina mountains',
  'vendor event Hendersonville Brevard NC',
  'craft fair booth Black Mountain NC',
  'art walk vendor Asheville River Arts District'
];

const EVENTBRITE_CATEGORIES = ['105', '113', '117', '119']; // Arts, Community, Home, Hobbies

// ─── State persistence ────────────────────────────────────────────────────────

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[MarketFinder] Failed to load state:', e.message);
  }
  return {
    lastRun: null,
    lastEventbriteRun: null,
    lastWebSearchRun: null,
    totalLeadsFound: 0,
    settings: {
      enabled: true,
      radiusMiles: SEARCH_RADIUS_MILES,
      autoRunIntervalHours: 168, // weekly
      notifyTelegram: true,
      minFitScore: 50
    }
  };
}

function saveState(state) {
  try {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.error('[MarketFinder] Failed to save state:', e.message);
  }
}

// ─── DB setup ─────────────────────────────────────────────────────────────────

let _rawDb = null;

function getRawDb(db) {
  if (_rawDb) return _rawDb;
  // db may be the module wrapper (with getDb()) or raw better-sqlite3 instance
  _rawDb = (typeof db.getDb === 'function') ? db.getDb() : db;
  return _rawDb;
}

let _tableReady = false;

function ensureTable(db) {
  if (_tableReady) return;
  const rawDb = getRawDb(db);
  _tableReady = true;
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS market_leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      source TEXT,
      source_url TEXT,
      location TEXT,
      address TEXT,
      date_start TEXT,
      date_end TEXT,
      recurrence TEXT,
      booth_cost TEXT,
      application_deadline TEXT,
      organizer TEXT,
      organizer_contact TEXT,
      description TEXT,
      restrictions TEXT,
      fit_score INTEGER DEFAULT 0,
      fit_reasoning TEXT,
      fit_category TEXT DEFAULT 'unknown',
      status TEXT DEFAULT 'new',
      notes TEXT,
      eventbrite_id TEXT,
      distance_miles REAL,
      weekly_visitors TEXT,
      vendor_count TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      dismissed_at TEXT,
      promoted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_market_leads_status ON market_leads(status);
    CREATE INDEX IF NOT EXISTS idx_market_leads_fit ON market_leads(fit_score);
    CREATE INDEX IF NOT EXISTS idx_market_leads_source_url ON market_leads(source_url);
    CREATE INDEX IF NOT EXISTS idx_market_leads_eventbrite_id ON market_leads(eventbrite_id);
  `);
  console.log('[MarketFinder] Table market_leads ready');
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function httpGet(url, headers = {}, retries = 0) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const proto = u.protocol === 'http:' ? http : https;
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + (u.search || ''),
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'BlueRidgeCustomCo-MarketFinder/1.0',
        ...headers
      },
      timeout: 30000
    };

    const req = proto.request(opts, (res) => {
      // Follow redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return httpGet(res.headers.location, headers, retries).then(resolve).catch(reject);
      }
      // Rate limit retry
      if (res.statusCode === 429 && retries < 3) {
        const backoff = Math.pow(2, retries + 1) * 1000;
        res.resume();
        return setTimeout(() => httpGet(url, headers, retries + 1).then(resolve).catch(reject), backoff);
      }

      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, body: text });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.end();
  });
}

function httpPost(url, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const proto = u.protocol === 'http:' ? http : https;
    const postData = typeof data === 'string' ? data : JSON.stringify(data);
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + (u.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        ...headers
      },
      timeout: 30000
    };

    const req = proto.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body: text });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(postData);
    req.end();
  });
}

// ─── Eventbrite Search ────────────────────────────────────────────────────────

async function searchEventbrite() {
  const token = process.env.EVENTBRITE_PRIVATE_TOKEN;
  if (!token) {
    console.log('[MarketFinder] No Eventbrite token configured, skipping');
    return [];
  }

  console.log('[MarketFinder] Searching Eventbrite...');
  const results = [];

  const queries = [
    'craft fair', 'maker market', 'vendor market', 'craft show',
    'artisan market', 'pop up market', 'handmade market', 'flea market'
  ];

  for (const q of queries) {
    try {
      const params = new URLSearchParams({
        q,
        'location.address': SEARCH_LOCATION,
        'location.within': `${SEARCH_RADIUS_MILES}mi`,
        'categories': EVENTBRITE_CATEGORIES.join(','),
        'start_date.keyword': 'this_month',
        'expand': 'venue'
      });

      const url = `https://www.eventbriteapi.com/v3/events/search/?${params}`;
      const resp = await httpGet(url, { 'Authorization': `Bearer ${token}` });

      if (resp.status === 200) {
        const data = JSON.parse(resp.body);
        if (data.events) {
          for (const event of data.events) {
            results.push({
              name: event.name?.text || event.name?.html || 'Unknown',
              source: 'eventbrite',
              source_url: event.url,
              eventbrite_id: event.id,
              description: (event.description?.text || '').slice(0, 2000),
              date_start: event.start?.local,
              date_end: event.end?.local,
              location: event.venue ? `${event.venue.name || ''}, ${event.venue.address?.city || ''}, ${event.venue.address?.region || ''}` : '',
              address: event.venue?.address?.localized_address_display || '',
              organizer: event.organizer?.name || ''
            });
          }
          console.log(`[MarketFinder] Eventbrite "${q}": ${data.events.length} events`);
        }
      } else if (resp.status === 401 || resp.status === 403) {
        console.log(`[MarketFinder] Eventbrite auth error (${resp.status}) — search API may need whitelisting`);
        break; // Don't keep trying with bad auth
      } else {
        console.log(`[MarketFinder] Eventbrite "${q}": HTTP ${resp.status}`);
      }

      // Rate limit: wait between requests
      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      console.error(`[MarketFinder] Eventbrite search error for "${q}":`, err.message);
    }
  }

  return results;
}

// ─── Direct site scraping (reliable event listing sites) ──────────────────────

// Known sites that list vendor markets, craft fairs, etc. near Asheville
const TARGET_SITES = [
  { url: 'https://www.fairsandfestivals.net/states/NC/', title: 'Fairs and Festivals - North Carolina' },
  { url: 'https://craftshows.net/Asheville-NC', title: 'Craft Shows - Asheville NC' },
  { url: 'https://craftshows.net/North-Carolina', title: 'Craft Shows - North Carolina' },
  { url: 'https://www.artscraftsshowbusiness.com/eventlistings.aspx?state=NC', title: 'Arts Crafts Show Business - NC' },
  { url: 'https://www.festivalnet.com/state/north-carolina/craft-shows', title: 'FestivalNet NC Craft Shows' },
  { url: 'https://www.10times.com/asheville-us/crafts', title: '10Times Asheville Crafts' },
  { url: 'https://www.10times.com/asheville-us/tradeshows', title: '10Times Asheville Trade Shows' },
  { url: 'https://www.aboutasheville.com/best-arts-and-crafts-markets-in-asheville/', title: 'About Asheville - Arts & Crafts Markets' },
  { url: 'https://hometownvendormarket.com/', title: 'Hometown Vendor Market' },
  { url: 'https://southernhighlandguild.org/fairs/', title: 'Southern Highland Craft Guild Fairs' },
  { url: 'https://www.thecraftmap.com/blog/best-craft-fairs-in-north-carolina-2026', title: 'The Craft Map - NC Craft Fairs 2026' },
  { url: 'https://mountainx.com/events/', title: 'Mountain Xpress Events' },
  { url: 'https://www.ashevillefarmsteadmarket.com/', title: 'Asheville Farmstead Market' },
  { url: 'https://www.eventbrite.com/d/nc--asheville/craft-fair/', title: 'Eventbrite Asheville Craft Fairs' },
  { url: 'https://www.eventbrite.com/d/nc--asheville/vendor-market/', title: 'Eventbrite Asheville Vendor Markets' },
  { url: 'https://www.eventbrite.com/d/nc--asheville/pop-up-market/', title: 'Eventbrite Asheville Pop Up Markets' },
  { url: 'https://www.eventbrite.com/d/nc--hendersonville/craft-fair/', title: 'Eventbrite Hendersonville Craft Fairs' },
  { url: 'https://www.eventbrite.com/d/nc--brevard/craft-fair/', title: 'Eventbrite Brevard Craft Fairs' },
  { url: 'https://www.eventbrite.com/d/sc--greenville/vendor-market/', title: 'Eventbrite Greenville Vendor Markets' },
];

async function searchWeb() {
  console.log(`[MarketFinder] Scraping ${TARGET_SITES.length} event listing sites...`);
  const allResults = [];

  for (const site of TARGET_SITES) {
    try {
      console.log(`[MarketFinder] Fetching: ${site.url}`);
      const resp = await httpGet(site.url, {
        'Accept': 'text/html',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0'
      });

      if (resp.status === 200 && resp.body.length > 200) {
        allResults.push({
          url: site.url,
          title: site.title,
          _body: resp.body // keep raw HTML for AI processing
        });
        console.log(`[MarketFinder] Got ${(resp.body.length / 1024).toFixed(0)}KB from ${site.title}`);
      } else {
        console.log(`[MarketFinder] ${site.title}: HTTP ${resp.status} (${resp.body.length}b)`);
      }

      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      console.error(`[MarketFinder] Failed to fetch ${site.url}:`, err.message);
    }
  }

  console.log(`[MarketFinder] Successfully fetched ${allResults.length}/${TARGET_SITES.length} sites`);
  return allResults;
}

// ─── Page content fetcher ─────────────────────────────────────────────────────

async function fetchPageContent(url) {
  try {
    const resp = await httpGet(url, {
      'Accept': 'text/html',
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'
    });
    if (resp.status !== 200) return null;

    // Strip HTML tags, get text content
    let text = resp.body
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();

    // Limit to first 4000 chars for AI analysis
    return text.slice(0, 4000);
  } catch (err) {
    return null;
  }
}

// ─── AI helpers (Gemini primary, Ollama fallback) ─────────────────────────────

async function aiChat(prompt) {
  // Try Gemini first (free, fast, good at extraction)
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    try {
      const resp = await httpPost(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
        { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 8192 } }
      );
      if (resp.status === 200) {
        const data = JSON.parse(resp.body);
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (text) {
          console.log('[MarketFinder] AI response via Gemini');
          return text;
        }
      } else {
        console.warn(`[MarketFinder] Gemini HTTP ${resp.status}: ${resp.body.slice(0, 200)}`);
      }
    } catch (err) {
      console.warn('[MarketFinder] Gemini error, falling back to Ollama:', err.message);
    }
  }

  // Fallback: Ollama (local, free)
  try {
    const ollama = require('../lib/ollama-client');
    if (ollama.isConfigured()) {
      const text = await ollama.generate(prompt, { temperature: 0.3, timeout: 120000 });
      console.log('[MarketFinder] AI response via Ollama');
      return text;
    }
  } catch (err) {
    console.error('[MarketFinder] Ollama fallback error:', err.message);
  }

  return null;
}

function parseAiJson(text) {
  if (!text) return null;

  // 1. Try extracting from markdown fences first (most common from Gemini)
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch (e) {
      console.warn('[MarketFinder] Fenced JSON parse error:', e.message, '| preview:', fenced[1].slice(0, 100));
    }
  }

  // 2. Try raw parse
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch { /* fall through */ }

  // 3. Find first { and last } — extract the JSON object
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try { return JSON.parse(text.slice(firstBrace, lastBrace + 1)); } catch { /* fall through */ }
  }

  // 4. Find first [ and last ] — extract array
  const firstBracket = text.indexOf('[');
  const lastBracket = text.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    try { return JSON.parse(text.slice(firstBracket, lastBracket + 1)); } catch { /* fall through */ }
  }

  // 5. Last resort: the JSON is likely truncated. Try to find complete event objects
  //    by matching individual {...} blocks within an events array
  try {
    const eventsMatch = text.match(/"events"\s*:\s*\[/);
    if (eventsMatch) {
      const startIdx = text.indexOf('[', eventsMatch.index);
      const eventsStr = text.slice(startIdx);
      // Find all complete event objects
      const eventRegex = /\{[^{}]*\}/g;
      const events = [];
      let m;
      while ((m = eventRegex.exec(eventsStr)) !== null) {
        try {
          const evt = JSON.parse(m[0]);
          if (evt.name) events.push(evt);
        } catch { /* skip malformed */ }
      }
      if (events.length > 0) {
        console.log(`[MarketFinder] Recovered ${events.length} events from truncated JSON`);
        return { events };
      }
    }
  } catch { /* fall through */ }

  console.warn('[MarketFinder] All JSON parse attempts failed. Preview:', text.slice(0, 300));
  return null;
}

// ─── AI Analysis ──────────────────────────────────────────────────────────────

async function analyzeLeadWithAI(lead) {
  const prompt = `You are evaluating whether a vendor market/event is a good fit for a small business.

BUSINESS PROFILE:
- Name: ${PRODUCT_PROFILE.business}
- Location: Asheville, NC
- Products: ${PRODUCT_PROFILE.types.join(', ')}
- We are NOT: food vendors, farmers, fine artists (painting), MLM/direct sales

EVENT/MARKET INFO:
- Name: ${lead.name}
- Location: ${lead.location || lead.address || 'Unknown'}
- Date: ${lead.date_start || 'Unknown'}
- Description: ${(lead.description || '').slice(0, 1500)}
- Source URL: ${lead.source_url || ''}
- Restrictions noted: ${lead.restrictions || 'None found'}

Analyze this event and respond in EXACTLY this JSON format (no markdown fences):
{
  "fit_score": <0-100 integer>,
  "fit_category": "<great_fit|good_fit|possible|poor_fit|not_applicable>",
  "fit_reasoning": "<1-2 sentence explanation>",
  "booth_cost_estimate": "<estimated cost or 'unknown'>",
  "restrictions_found": "<any vendor restrictions you can identify>",
  "application_deadline": "<if mentioned, otherwise 'unknown'>",
  "event_type": "<craft_fair|maker_market|flea_market|pop_up|art_walk|festival|farmers_market|other>",
  "recurrence": "<one-time|weekly|monthly|annual|unknown>",
  "estimated_visitors": "<estimate or 'unknown'>"
}

Score guide:
- 80-100: Perfect fit — craft/maker/vendor market welcoming custom goods
- 60-79: Good fit — general market that likely accepts our products
- 40-59: Possible — might work but unclear restrictions or mixed event
- 20-39: Poor fit — mostly food/produce/fine art, probably won't accept us
- 0-19: Not applicable — not a vendor market, or explicitly excludes our products`;

  try {
    const text = await aiChat(prompt);
    const analysis = parseAiJson(text);
    if (!analysis) return null;

    return {
      fit_score: Math.max(0, Math.min(100, analysis.fit_score || 0)),
      fit_reasoning: analysis.fit_reasoning || '',
      fit_category: analysis.fit_category || 'unknown',
      booth_cost: analysis.booth_cost_estimate || null,
      restrictions: analysis.restrictions_found || null,
      application_deadline: analysis.application_deadline || null,
      recurrence: analysis.recurrence || null,
      weekly_visitors: analysis.estimated_visitors || null,
      event_type: analysis.event_type || null
    };
  } catch (err) {
    console.error('[MarketFinder] AI analysis error:', err.message);
    return null;
  }
}

// ─── Geo pre-filter for large pages ───────────────────────────────────────────

// Cities within ~60mi of Asheville we care about
const NEARBY_CITIES = [
  'asheville', 'hendersonville', 'brevard', 'waynesville', 'black mountain',
  'weaverville', 'arden', 'fletcher', 'flat rock', 'mars hill', 'canton',
  'sylva', 'maggie valley', 'burnsville', 'marion', 'morganton', 'spruce pine',
  'lake lure', 'chimney rock', 'saluda', 'tryon', 'columbus', 'rutherfordton',
  'forest city', 'old fort', 'swannanoa', 'montreat', 'woodfin', 'enka',
  'river arts', 'pack square', 'biltmore', 'west asheville', 'north asheville',
  'leicester', 'fairview', 'bat cave', 'mills river', 'pisgah', 'etowah',
  'greenville', 'spartanburg', 'greer', // SC within range
  'highlands', 'franklin', 'cashiers', 'bryson city', 'cherokee', 'murphy',
  'wnc', 'western north carolina', 'blue ridge', 'appalachian', 'smoky',
];

function geoFilterContent(rawHtml) {
  // Strip scripts/styles first
  let html = rawHtml
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');

  // Split into sections by common delimiters (divs, table rows, list items, headings)
  // Use a generous split to get event-sized chunks
  const sections = html.split(/(?=<(?:div|tr|li|article|section|h[1-6])\b)/i);

  const relevantSections = [];
  const lowerCities = NEARBY_CITIES; // already lowercase

  for (const section of sections) {
    const lower = section.toLowerCase();
    if (lowerCities.some(city => lower.includes(city))) {
      // Strip HTML tags from this section
      const text = section
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim();
      if (text.length > 20) {
        relevantSections.push(text);
      }
    }
  }

  if (relevantSections.length === 0) return null;

  const filtered = relevantSections.join('\n---\n').slice(0, 15000);
  return filtered;
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Batch analyze web results ────────────────────────────────────────────────

async function analyzeWebResults(webResults) {
  const leads = [];

  for (const result of webResults) {
    let content;
    if (result._body) {
      const fullText = stripHtml(result._body);
      // If the page is large (statewide listing), geo-filter to nearby cities
      if (fullText.length > 20000) {
        content = geoFilterContent(result._body);
        if (content) {
          console.log(`[MarketFinder] Geo-filtered ${result.title}: ${(fullText.length/1024).toFixed(0)}KB → ${(content.length/1024).toFixed(0)}KB`);
        } else {
          // No local matches found, use truncated full text
          content = fullText.slice(0, 15000);
          console.log(`[MarketFinder] No local matches in ${result.title}, using first 15KB`);
        }
      } else {
        content = fullText.slice(0, 15000);
      }
    } else {
      content = await fetchPageContent(result.url);
    }
    if (!content || content.length < 100) {
      console.log(`[MarketFinder] Skipping (no content): ${result.url}`);
      continue;
    }

    try {
      const extractPrompt = `Extract vendor market/event information from this web page content.
We ONLY want events within 60 miles of Asheville, NC (including Hendersonville, Brevard, Waynesville, Black Mountain, Greenville SC, etc). Skip events in other parts of NC (Raleigh, Charlotte, Wilmington, etc).

PAGE TITLE: ${result.title}
PAGE URL: ${result.url}
PAGE CONTENT (pre-filtered to local area):
${content}

Extract all vendor markets, craft fairs, maker markets, or events where a maker/crafter could rent a booth. Only include events near Asheville (within ~60 miles). If none found, return an empty events array.

Respond in EXACTLY this JSON format (no markdown fences):
{
  "events": [
    {
      "name": "<event name>",
      "location": "<city, state>",
      "address": "<full address if available>",
      "date_start": "<YYYY-MM-DD or description>",
      "date_end": "<YYYY-MM-DD if available>",
      "description": "<1-2 sentence description>",
      "booth_cost": "<cost if mentioned>",
      "application_deadline": "<deadline if mentioned>",
      "organizer": "<organizer name if available>",
      "organizer_contact": "<email or phone if available>",
      "restrictions": "<vendor restrictions if mentioned>",
      "recurrence": "<one-time|weekly|monthly|annual|unknown>"
    }
  ]
}`;

      const text = await aiChat(extractPrompt);
      if (!text) {
        console.log(`[MarketFinder] No AI response for: ${result.url}`);
        continue;
      }
      // Try to parse — handle both {events:[...]} and bare array
      let extracted = parseAiJson(text);
      if (!extracted) {
        console.log(`[MarketFinder] Failed to parse AI response for ${result.url}: ${text.slice(0, 200)}`);
        continue;
      }

      const events = extracted.events || (Array.isArray(extracted) ? extracted : []);
      if (events.length > 0) {
        for (const event of events) {
          leads.push({
            ...event,
            source: 'web',
            source_url: result.url
          });
        }
        console.log(`[MarketFinder] Extracted ${events.length} events from ${result.url}`);
      } else {
        console.log(`[MarketFinder] No events found on: ${result.url}`);
      }

      // Rate limit AI calls
      await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      console.error(`[MarketFinder] Extract error for ${result.url}:`, err.message);
    }
  }

  return leads;
}

// ─── Deduplicate leads ────────────────────────────────────────────────────────

function deduplicateLeads(leads, db) {
  const rawDb = getRawDb(db);
  const existing = rawDb.prepare('SELECT name, source_url, eventbrite_id FROM market_leads').all();
  const existingNames = new Set(existing.map(e => e.name?.toLowerCase()));
  const existingUrls = new Set(existing.filter(e => e.source_url).map(e => e.source_url));
  const existingEbIds = new Set(existing.filter(e => e.eventbrite_id).map(e => e.eventbrite_id));

  return leads.filter(lead => {
    if (lead.eventbrite_id && existingEbIds.has(lead.eventbrite_id)) return false;
    if (lead.source_url && existingUrls.has(lead.source_url)) return false;
    if (lead.name && existingNames.has(lead.name.toLowerCase())) return false;
    return true;
  });
}

// ─── Save leads to DB ─────────────────────────────────────────────────────────

function saveLead(db, lead) {
  const rawDb = getRawDb(db);
  const stmt = rawDb.prepare(`
    INSERT INTO market_leads (name, source, source_url, location, address, date_start, date_end,
      recurrence, booth_cost, application_deadline, organizer, organizer_contact, description,
      restrictions, fit_score, fit_reasoning, fit_category, eventbrite_id, distance_miles,
      weekly_visitors, vendor_count, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  return stmt.run(
    lead.name, lead.source, lead.source_url, lead.location, lead.address,
    lead.date_start, lead.date_end, lead.recurrence, lead.booth_cost,
    lead.application_deadline, lead.organizer, lead.organizer_contact,
    lead.description, lead.restrictions, lead.fit_score || 0,
    lead.fit_reasoning, lead.fit_category || 'unknown',
    lead.eventbrite_id || null, lead.distance_miles || null,
    lead.weekly_visitors || null, lead.vendor_count || null,
    'new'
  );
}

// ─── Telegram digest ──────────────────────────────────────────────────────────

async function sendTelegramDigest(leads) {
  try {
    const telegram = require('../lib/telegram-notifier');
    if (!telegram.isConfigured()) return;

    const great = leads.filter(l => l.fit_score >= 70);
    const possible = leads.filter(l => l.fit_score >= 40 && l.fit_score < 70);

    if (great.length === 0 && possible.length === 0) {
      console.log('[MarketFinder] No qualifying leads to send');
      return;
    }

    let msg = `🎪 *Market Finder — ${leads.length} New Leads*\n\n`;

    if (great.length > 0) {
      msg += `✅ *GREAT FIT (${great.length}):*\n`;
      for (const l of great.slice(0, 10)) {
        msg += `• *${l.name}* (${l.fit_score}/100)\n`;
        msg += `  📍 ${l.location || 'Location TBD'}\n`;
        msg += `  📅 ${l.date_start || 'Date TBD'}`;
        if (l.booth_cost) msg += ` | 💰 ${l.booth_cost}`;
        msg += `\n  ${l.fit_reasoning || ''}\n\n`;
      }
    }

    if (possible.length > 0) {
      msg += `🤔 *POSSIBLE (${possible.length}):*\n`;
      for (const l of possible.slice(0, 5)) {
        msg += `• *${l.name}* (${l.fit_score}/100) — ${l.location || 'TBD'}\n`;
      }
    }

    msg += `\n🔗 View all: blueridgecustomco.com/calendar`;

    await telegram.sendMessage(msg);
    console.log('[MarketFinder] Telegram digest sent');
  } catch (err) {
    console.error('[MarketFinder] Telegram error:', err.message);
  }
}

// ─── Main scan orchestrator ───────────────────────────────────────────────────

async function runScan(db) {
  ensureTable(db);
  const state = loadState();

  console.log('[MarketFinder] ═══ Starting market scan ═══');
  const startTime = Date.now();

  // 1. Search Eventbrite
  let eventbriteLeads = [];
  try {
    eventbriteLeads = await searchEventbrite();
    state.lastEventbriteRun = new Date().toISOString();
  } catch (err) {
    console.error('[MarketFinder] Eventbrite scan failed:', err.message);
  }

  // 2. Search web
  let webResults = [];
  try {
    webResults = await searchWeb();
    state.lastWebSearchRun = new Date().toISOString();
  } catch (err) {
    console.error('[MarketFinder] Web search failed:', err.message);
  }

  // 3. Extract events from web pages using AI
  let webLeads = [];
  try {
    webLeads = await analyzeWebResults(webResults);
  } catch (err) {
    console.error('[MarketFinder] Web analysis failed:', err.message);
  }

  // 4. Combine and deduplicate
  const allLeads = [...eventbriteLeads, ...webLeads];
  console.log(`[MarketFinder] Total raw leads: ${allLeads.length} (EB: ${eventbriteLeads.length}, Web: ${webLeads.length})`);

  const newLeads = deduplicateLeads(allLeads, db);
  console.log(`[MarketFinder] New leads after dedup: ${newLeads.length}`);

  // 5. AI qualification for each new lead
  const qualifiedLeads = [];
  for (const lead of newLeads) {
    const analysis = await analyzeLeadWithAI(lead);
    if (analysis) {
      Object.assign(lead, analysis);
    }
    qualifiedLeads.push(lead);

    // Save to DB
    try {
      saveLead(db, lead);
    } catch (err) {
      console.error(`[MarketFinder] Failed to save lead "${lead.name}":`, err.message);
    }

    // Rate limit
    await new Promise(r => setTimeout(r, 300));
  }

  // 6. Send Telegram digest
  if (state.settings.notifyTelegram && qualifiedLeads.length > 0) {
    await sendTelegramDigest(qualifiedLeads);
  }

  // 7. Update state
  state.lastRun = new Date().toISOString();
  state.totalLeadsFound = (state.totalLeadsFound || 0) + qualifiedLeads.length;
  saveState(state);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[MarketFinder] ═══ Scan complete: ${qualifiedLeads.length} leads in ${elapsed}s ═══`);

  return {
    total_found: allLeads.length,
    new_leads: qualifiedLeads.length,
    great_fit: qualifiedLeads.filter(l => l.fit_score >= 70).length,
    possible: qualifiedLeads.filter(l => l.fit_score >= 40 && l.fit_score < 70).length,
    poor_fit: qualifiedLeads.filter(l => l.fit_score < 40).length,
    elapsed_seconds: parseFloat(elapsed)
  };
}

// ─── Scheduled runner ─────────────────────────────────────────────────────────

let _scanInterval = null;

function startScheduler(db) {
  ensureTable(db);
  const state = loadState();
  const intervalMs = (state.settings.autoRunIntervalHours || 168) * 60 * 60 * 1000;

  if (_scanInterval) clearInterval(_scanInterval);

  _scanInterval = setInterval(async () => {
    if (!state.settings.enabled) return;
    try {
      await runScan(db);
    } catch (err) {
      console.error('[MarketFinder] Scheduled scan error:', err.message);
    }
  }, intervalMs);

  console.log(`[MarketFinder] Scheduler started (every ${state.settings.autoRunIntervalHours}h)`);
}

// ─── Route handler ────────────────────────────────────────────────────────────

function handleMarketFinderRoute(req, res, parsedUrl, sendJsonFn, db) {
  const pathname = parsedUrl.pathname;
  const rawDb = getRawDb(db);

  ensureTable(db);

  // GET /api/market-finder/leads — list all leads
  if ((pathname === '/api/market-finder/leads' || pathname === '/api/market-finder/leads/') && req.method === 'GET') {
    const params = parsedUrl.searchParams || new URL(parsedUrl.href || `http://localhost${pathname}`, 'http://localhost').searchParams;
    const status = params.get('status');
    const minScore = parseInt(params.get('min_score') || '0', 10);
    const limit = parseInt(params.get('limit') || '100', 10);
    const offset = parseInt(params.get('offset') || '0', 10);

    let query = 'SELECT * FROM market_leads WHERE fit_score >= ?';
    const queryParams = [minScore];

    if (status && status !== 'all') {
      query += ' AND status = ?';
      queryParams.push(status);
    }

    query += ' ORDER BY fit_score DESC, created_at DESC LIMIT ? OFFSET ?';
    queryParams.push(limit, offset);

    const leads = rawDb.prepare(query).all(...queryParams);
    const total = rawDb.prepare('SELECT COUNT(*) as count FROM market_leads').get().count;

    sendJsonFn(res, { success: true, leads, total, limit, offset });
    return true;
  }

  // GET /api/market-finder/stats — summary stats
  if (pathname === '/api/market-finder/stats' && req.method === 'GET') {
    const state = loadState();
    const stats = {
      total_leads: rawDb.prepare('SELECT COUNT(*) as c FROM market_leads').get().c,
      great_fit: rawDb.prepare('SELECT COUNT(*) as c FROM market_leads WHERE fit_score >= 70').get().c,
      good_fit: rawDb.prepare('SELECT COUNT(*) as c FROM market_leads WHERE fit_score >= 50 AND fit_score < 70').get().c,
      possible: rawDb.prepare('SELECT COUNT(*) as c FROM market_leads WHERE fit_score >= 30 AND fit_score < 50').get().c,
      poor_fit: rawDb.prepare('SELECT COUNT(*) as c FROM market_leads WHERE fit_score < 30').get().c,
      new_leads: rawDb.prepare("SELECT COUNT(*) as c FROM market_leads WHERE status = 'new'").get().c,
      contacted: rawDb.prepare("SELECT COUNT(*) as c FROM market_leads WHERE status = 'contacted'").get().c,
      applied: rawDb.prepare("SELECT COUNT(*) as c FROM market_leads WHERE status = 'applied'").get().c,
      booked: rawDb.prepare("SELECT COUNT(*) as c FROM market_leads WHERE status = 'booked'").get().c,
      dismissed: rawDb.prepare("SELECT COUNT(*) as c FROM market_leads WHERE status = 'dismissed'").get().c,
      promoted: rawDb.prepare("SELECT COUNT(*) as c FROM market_leads WHERE status = 'promoted'").get().c,
      last_run: state.lastRun,
      settings: state.settings
    };
    sendJsonFn(res, { success: true, stats });
    return true;
  }

  // POST /api/market-finder/scan — trigger manual scan
  if (pathname === '/api/market-finder/scan' && req.method === 'POST') {
    sendJsonFn(res, { success: true, message: 'Scan started' });
    // Run scan async (don't block response)
    runScan(db).then(result => {
      console.log('[MarketFinder] Manual scan result:', JSON.stringify(result));
    }).catch(err => {
      console.error('[MarketFinder] Manual scan error:', err.message);
    });
    return true;
  }

  // PUT /api/market-finder/leads/:id — update lead status/notes
  const updateMatch = pathname.match(/^\/api\/market-finder\/leads\/(\d+)$/);
  if (updateMatch && req.method === 'PUT') {
    const id = parseInt(updateMatch[1], 10);
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const updates = JSON.parse(body);
        const allowed = ['status', 'notes', 'booth_cost', 'application_deadline', 'fit_score'];
        const sets = [];
        const vals = [];

        for (const key of allowed) {
          if (updates[key] !== undefined) {
            sets.push(`${key} = ?`);
            vals.push(updates[key]);
          }
        }

        if (updates.status === 'dismissed') {
          sets.push('dismissed_at = CURRENT_TIMESTAMP');
        }
        if (updates.status === 'promoted') {
          sets.push('promoted_at = CURRENT_TIMESTAMP');
        }

        sets.push('updated_at = CURRENT_TIMESTAMP');
        vals.push(id);

        rawDb.prepare(`UPDATE market_leads SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
        const lead = rawDb.prepare('SELECT * FROM market_leads WHERE id = ?').get(id);
        sendJsonFn(res, { success: true, lead });
      } catch (err) {
        sendJsonFn(res, { error: err.message }, 400);
      }
    });
    return true;
  }

  // DELETE /api/market-finder/leads/:id — delete a lead
  const deleteMatch = pathname.match(/^\/api\/market-finder\/leads\/(\d+)$/);
  if (deleteMatch && req.method === 'DELETE') {
    const id = parseInt(deleteMatch[1], 10);
    rawDb.prepare('DELETE FROM market_leads WHERE id = ?').run(id);
    sendJsonFn(res, { success: true });
    return true;
  }

  // POST /api/market-finder/leads/:id/promote — promote lead to eventCal
  const promoteMatch = pathname.match(/^\/api\/market-finder\/leads\/(\d+)\/promote$/);
  if (promoteMatch && req.method === 'POST') {
    const id = parseInt(promoteMatch[1], 10);
    const lead = rawDb.prepare('SELECT * FROM market_leads WHERE id = ?').get(id);

    if (!lead) {
      sendJsonFn(res, { error: 'Lead not found' }, 404);
      return true;
    }

    // Push to eventCal via its API
    promoteToEventCal(lead).then(result => {
      rawDb.prepare("UPDATE market_leads SET status = 'promoted', promoted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
      sendJsonFn(res, { success: true, eventCal: result, lead: rawDb.prepare('SELECT * FROM market_leads WHERE id = ?').get(id) });
    }).catch(err => {
      sendJsonFn(res, { error: err.message }, 500);
    });
    return true;
  }

  // GET /api/market-finder/settings
  if (pathname === '/api/market-finder/settings' && req.method === 'GET') {
    const state = loadState();
    sendJsonFn(res, { success: true, settings: state.settings });
    return true;
  }

  // PUT /api/market-finder/settings
  if (pathname === '/api/market-finder/settings' && req.method === 'PUT') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const updates = JSON.parse(body);
        const state = loadState();
        Object.assign(state.settings, updates);
        saveState(state);
        sendJsonFn(res, { success: true, settings: state.settings });
      } catch (err) {
        sendJsonFn(res, { error: err.message }, 400);
      }
    });
    return true;
  }

  return false;
}

// ─── Promote to EventCal ─────────────────────────────────────────────────────

async function promoteToEventCal(lead) {
  // Create market in eventCal
  const marketData = {
    market_name: lead.name,
    location: lead.location || lead.address || '',
    distance: lead.distance_miles ? `${lead.distance_miles} mi` : '',
    schedule: lead.recurrence === 'weekly' ? `Weekly` : lead.recurrence === 'monthly' ? 'Monthly' : lead.date_start || '',
    season: '',
    weekly_visitors: lead.weekly_visitors || '',
    vendor_count: lead.vendor_count || '',
    vendor_fee: lead.booth_cost || '',
    target_audience: '',
    product_fit: `${lead.fit_category} (${lead.fit_score}/100) — ${lead.fit_reasoning || ''}`,
    priority: lead.fit_score >= 70 ? 'HIGH' : lead.fit_score >= 50 ? 'MEDIUM' : 'LOW',
    notes: `Source: ${lead.source_url || lead.source}\nRestrictions: ${lead.restrictions || 'None noted'}\nOrganizer: ${lead.organizer || 'Unknown'}\nContact: ${lead.organizer_contact || 'Unknown'}`
  };

  const resp = await httpPost('http://localhost:3000/calendar/api/markets', marketData);
  if (resp.status >= 200 && resp.status < 300) {
    return JSON.parse(resp.body);
  }
  throw new Error(`EventCal API error: HTTP ${resp.status} — ${resp.body}`);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  handleMarketFinderRoute,
  runScan,
  startScheduler,
  ensureTable,
  PRODUCT_PROFILE
};
