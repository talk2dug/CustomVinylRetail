/**
 * Reel Copywriter — generates hooks, per-item captions, and explanations
 * for the Reel Studio using local Ollama (no cloud APIs).
 *
 * Template types:
 *   - "apparel" — for MockupReel (apparel drops)
 *   - "metal-print" — for MetalPrintStory (art + process + mockups)
 */

const ollamaClient = require('../lib/ollama-client');

const BRAND = 'BlueRidge Custom Co';
const LOCATION = 'Asheville, NC';

/**
 * Generate copy for an apparel drop reel.
 * @param {object} opts
 * @param {Array<{title, theme, mood, colors, keywords, description}>} opts.items
 * @param {string} [opts.vibe] - overall vibe ("bold moto", "retro humor", etc.)
 * @returns {Promise<{hook, outro, ctaText, items: Array<{caption, subtitle}>}>}
 */
async function writeApparelCopy(opts) {
  const { items = [], vibe = '' } = opts;
  if (items.length === 0) return fallbackApparelCopy([]);

  const themes = [...new Set(items.map(i => i.theme).filter(Boolean))];
  const moods = [...new Set(items.map(i => i.mood).filter(Boolean))];

  const itemList = items
    .map((item, i) => {
      const parts = [`${i + 1}. "${item.title || 'untitled'}"`];
      if (item.theme) parts.push(`theme: ${item.theme}`);
      if (item.mood) parts.push(`mood: ${item.mood}`);
      if (item.keywords && item.keywords.length) parts.push(`keywords: ${item.keywords.slice(0, 4).join(', ')}`);
      return parts.join(' — ');
    })
    .join('\n');

  const prompt = `You are a TikTok copywriter for ${BRAND}, a custom apparel print shop in ${LOCATION}. Write punchy, authentic copy for a product drop reel.

${vibe ? `Overall vibe: ${vibe}\n` : ''}Themes: ${themes.join(', ') || 'mixed'}
Moods: ${moods.join(', ') || 'mixed'}

${items.length} designs in this reel:
${itemList}

Output ONLY valid JSON (no markdown, no explanation) matching this exact shape:
{
  "hook": "1 line, max 35 chars, punchy opener",
  "outro": "1 line tagline for the end card, max 30 chars",
  "ctaText": "short call to action, 2-3 words",
  "items": [
    { "caption": "max 20 chars", "subtitle": "max 25 chars" },
    ...one entry per design in order
  ],
  "hashtags": ["#tag1", "#tag2", "#tag3", "#tag4", "#tag5"]
}

Rules:
- Be direct, avoid generic phrases like "check out"
- Reference ${LOCATION} or "local" in the outro when it fits
- No hashtags in hook/outro/captions/subtitles text fields, no emojis
- Captions should feel like hand-written titles, not descriptions

Hashtag strategy (EXACTLY 5 hashtags — TikTok 5-tag rule):
- 1 branded: #BlueRidgeCustomCo
- 1 location: #AshevilleNC or #828
- 1 broad/trending: e.g. #tiktokmademebuyit, #smallbusiness, #apparel
- 2 niche: specific to theme/mood/keywords (e.g. #sarcasticshirts, #motoculture, #outdoorwear)
- Lowercase, no spaces, must start with #`;

  try {
    const text = await ollamaClient.generate(prompt, {
      temperature: 0.8,
      maxTokens: 1500,
      timeout: 90000,
    });
    return validateApparelCopy(parseJson(text), items.length);
  } catch (err) {
    console.warn('[reel-copywriter] Ollama apparel copy failed, using fallback:', err.message);
    return fallbackApparelCopy(items);
  }
}

/**
 * Generate copy for a metal-print story reel.
 * @param {object} opts
 * @param {Array<{title, theme, mood, colors, keywords, description}>} opts.items - artwork metadata
 * @param {string} [opts.sceneContext] - description of the lifestyle mockup scenes
 * @returns {Promise<{hook, processIntro, artExplainer, whyMetal, ctaText, outro}>}
 */
async function writeMetalPrintCopy(opts) {
  const { items = [], sceneContext = '' } = opts;
  if (items.length === 0) return fallbackMetalCopy();

  const themes = [...new Set(items.map(i => i.theme).filter(Boolean))];
  const titles = items.map(i => i.title).filter(Boolean).slice(0, 3);
  const allKeywords = [...new Set(items.flatMap(i => i.keywords || []))].slice(0, 8);

  const prompt = `You are a copywriter for ${BRAND}, a fine art metal print studio in ${LOCATION}. Write cinematic, evocative copy for a metal print reel that shows the process, the finished art, and installation mockups.

Featured artwork: ${titles.join(' • ') || 'curated collection'}
Themes: ${themes.join(', ') || 'mixed'}
Keywords: ${allKeywords.join(', ')}
${sceneContext ? `Scene context: ${sceneContext}\n` : ''}

The reel has these parts in order:
1. HOOK — opening attention grabber
2. PROCESS — intro to the making-of footage
3. ART EXPLAINER — what the art captures, why it matters
4. WHY METAL — one sentence on why metal prints (durability, depth, light interaction, museum-grade)
5. CTA — short call to action
6. OUTRO — brand tagline

Output ONLY valid JSON (no markdown, no explanation):
{
  "hook": "max 40 chars, cinematic opener",
  "processIntro": "max 30 chars, teases the making-of",
  "artExplainer": "2 short lines, 40 chars each, about the art",
  "whyMetal": "one sentence, max 80 chars, what makes metal special",
  "ctaText": "short action, 2-3 words",
  "outro": "max 30 chars, tagline",
  "hashtags": ["#tag1", "#tag2", "#tag3", "#tag4", "#tag5"]
}

Rules:
- Be evocative, not salesy
- Reference craft, detail, permanence, or ${LOCATION} when it fits
- No hashtags in hook/outro text fields, no emojis
- Use short, declarative sentences

Hashtag strategy (EXACTLY 5 hashtags — TikTok 5-tag rule):
- 1 branded: #BlueRidgeCustomCo
- 1 location: #AshevilleNC or #828
- 1 broad/art-related: e.g. #metalprint, #wallart, #homedecor
- 2 niche: specific to theme/subject (e.g. #motorsport, #mountainbiking, #carart)
- Lowercase, no spaces, must start with #`;

  try {
    const text = await ollamaClient.generate(prompt, {
      temperature: 0.75,
      maxTokens: 1500,
      timeout: 90000,
    });
    return validateMetalCopy(parseJson(text));
  } catch (err) {
    console.warn('[reel-copywriter] Ollama metal copy failed, using fallback:', err.message);
    return fallbackMetalCopy();
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseJson(text) {
  if (!text) throw new Error('Empty response from Ollama');
  // Strip markdown code fences if present
  let clean = text.trim();
  const fenceMatch = clean.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) clean = fenceMatch[1].trim();
  // Find first { and last }
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start >= 0 && end > start) clean = clean.slice(start, end + 1);
  return JSON.parse(clean);
}

function validateApparelCopy(obj, itemCount) {
  const result = {
    hook: String(obj.hook || 'New drops live').slice(0, 40),
    outro: String(obj.outro || `Made in ${LOCATION}`).slice(0, 35),
    ctaText: String(obj.ctaText || 'Shop Now').slice(0, 20),
    items: [],
    hashtags: normalizeHashtags(obj.hashtags, [
      '#BlueRidgeCustomCo',
      '#AshevilleNC',
      '#smallbusiness',
      '#apparel',
      '#tiktokmademebuyit',
    ]),
  };
  const items = Array.isArray(obj.items) ? obj.items : [];
  for (let i = 0; i < itemCount; i++) {
    const it = items[i] || {};
    result.items.push({
      caption: String(it.caption || '').slice(0, 25),
      subtitle: String(it.subtitle || '').slice(0, 30),
    });
  }
  return result;
}

function validateMetalCopy(obj) {
  return {
    hook: String(obj.hook || 'Metal print, hand finished').slice(0, 50),
    processIntro: String(obj.processIntro || 'Watch it come to life').slice(0, 35),
    artExplainer: String(obj.artExplainer || 'Captured once. Pressed forever.').slice(0, 100),
    whyMetal: String(obj.whyMetal || 'Museum-grade metal reveals depth and light nothing else can.').slice(0, 100),
    ctaText: String(obj.ctaText || 'Shop Now').slice(0, 20),
    outro: String(obj.outro || `${LOCATION} Studio`).slice(0, 35),
    hashtags: normalizeHashtags(obj.hashtags, [
      '#BlueRidgeCustomCo',
      '#AshevilleNC',
      '#metalprint',
      '#wallart',
      '#homedecor',
    ]),
  };
}

/**
 * Normalize hashtags: lowercase, prefix #, strip spaces, exactly 5.
 * Falls back to provided defaults if fewer than 5 valid tags.
 */
function normalizeHashtags(input, defaults) {
  const raw = Array.isArray(input) ? input : [];
  const cleaned = [];
  const seen = new Set();
  for (const tag of raw) {
    if (typeof tag !== 'string') continue;
    let t = tag.trim().replace(/\s+/g, '').toLowerCase();
    if (!t) continue;
    if (!t.startsWith('#')) t = '#' + t;
    // remove anything that isn't letters/digits/underscore after the #
    t = '#' + t.slice(1).replace(/[^a-z0-9_]/g, '');
    if (t.length < 2 || seen.has(t)) continue;
    seen.add(t);
    cleaned.push(t);
  }
  // Preserve original casing for branded tags
  const cased = cleaned.map((tag) => {
    if (tag === '#blueridgecustomco') return '#BlueRidgeCustomCo';
    if (tag === '#ashevillenc') return '#AshevilleNC';
    if (tag === '#tiktokmademebuyit') return '#TikTokMadeMeBuyIt';
    return tag;
  });
  // Pad with defaults if needed, dedupe
  const result = [...cased];
  for (const d of defaults) {
    if (result.length >= 5) break;
    const lower = d.toLowerCase();
    if (!result.map((t) => t.toLowerCase()).includes(lower)) result.push(d);
  }
  return result.slice(0, 5);
}

// Offline fallbacks (used if Ollama is unreachable)
function fallbackApparelCopy(items) {
  return {
    hook: 'New drops just landed',
    outro: `Printed in ${LOCATION}`,
    ctaText: 'Shop Now',
    items: items.map((it) => ({
      caption: (it?.title || '').slice(0, 25),
      subtitle: it?.theme?.replace(/-/g, ' ') || '',
    })),
    hashtags: [
      '#BlueRidgeCustomCo',
      '#AshevilleNC',
      '#smallbusiness',
      '#apparel',
      '#TikTokMadeMeBuyIt',
    ],
  };
}

function fallbackMetalCopy() {
  return {
    hook: 'Hand-finished metal prints',
    processIntro: 'See how they are made',
    artExplainer: 'Every detail pressed into metal.\nMade to live in the light.',
    whyMetal: 'Museum-grade metal catches light and color that paper cannot.',
    ctaText: 'Shop Now',
    outro: `${LOCATION} Studio`,
    hashtags: [
      '#BlueRidgeCustomCo',
      '#AshevilleNC',
      '#metalprint',
      '#wallart',
      '#homedecor',
    ],
  };
}

module.exports = { writeApparelCopy, writeMetalPrintCopy };
