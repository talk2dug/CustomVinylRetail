/**
 * Facebook Post Scheduler
 *
 * Handles automated Facebook posting for campaigns:
 * 1. Loads pending scheduled posts
 * 2. Generates mockups by compositing artwork onto templates
 * 3. Generates AI post content if not provided
 * 4. Posts to Facebook
 * 5. Updates post status
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const ollamaClient = require('./ollama-client');
const { compositeArtwork, generateMockupToFile } = require('./mockup-compositor');
const sharp = require('sharp');
const { tagUrl } = require('../modules/utm-attribution');
// Anthropic SDK removed — all LLM calls go through ollama-client (GPU bridge → local fallback)

// Load environment
const envPath = path.resolve(__dirname, '..', '..', '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
}

// Configuration
// Configuration - Support multiple Facebook pages
const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN || process.env.FB_ACCESS_TOKEN || "";
const FB_PAGE_ID = process.env.FB_PAGE_ID || "";

// Instagram Business Account (linked to FB Page — uses same FB_PAGE_ACCESS_TOKEN)
const INSTAGRAM_BUSINESS_ACCOUNT_ID = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID || "";

// Swayzes Custom Vinyl page (for apparel/stickers)
const FB_PAGE_ACCESS_TOKEN_SWAYZE = process.env.FB_PAGE_ACCESS_TOKEN_SWAYZE || "";
const FB_PAGE_ID_SWAYZE = process.env.FB_PAGE_ID_SWAYZE || "";

// Product categories that should go to Swayzes Custom Vinyl
const SWAYZE_CATEGORIES = ["apparel", "stickers", "sticker", "bumper", "clothing", "t-shirt", "tshirt", "shirt", "hoodie", "decal", "decals", "vinyl", "racing", "custom-vinyl"];

/**
 * Get Facebook credentials based on product category
 */
function getFacebookCredentials(category) {
  const categoryLower = (category || "").toLowerCase();
  const isSwayzeCategory = SWAYZE_CATEGORIES.some(cat => categoryLower.includes(cat));
  
  if (isSwayzeCategory && FB_PAGE_ID_SWAYZE && FB_PAGE_ACCESS_TOKEN_SWAYZE) {
    return {
      pageId: FB_PAGE_ID_SWAYZE,
      accessToken: FB_PAGE_ACCESS_TOKEN_SWAYZE,
      pageName: "Swayzes Custom Vinyl"
    };
  }
  
  return {
    pageId: FB_PAGE_ID,
    accessToken: FB_PAGE_ACCESS_TOKEN,
    pageName: "Blue Ridge Custom Co"
  };
}
const GENERATED_MOCKUPS_DIR = path.resolve(__dirname, '..', '..', 'data', 'generated-mockups');
const SERVER_BASE_URL = process.env.SERVER_BASE_URL || 'https://blueridgecustomco.com';

// Ensure directories exist
fs.mkdirSync(GENERATED_MOCKUPS_DIR, { recursive: true });

// AI Configuration
function cleanKey(value) {
  if (!value) return '';
  let trimmed = String(value).trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    trimmed = trimmed.slice(1, -1);
  }
  return trimmed;
}

// LLM handled by ollamaClient (imported above) — GPU bridge → local fallback

/**
 * Generate unique AI post content for a single item
 * @param {Object} item - The campaign item
 * @param {Object} campaign - The campaign data
 * @param {string} style - Post style: showcase, lifestyle, quality, urgency
 * @param {string} collectionUrl - Optional shop URL
 * @returns {Promise<{text: string, hashtags: string}>}
 */
async function generateAiPostForItem(item, campaign, style = 'showcase', collectionUrl = '') {
  try {
    // Get image path - check artworkPath for metal prints/custom art
    const imagePath = item.mockupImage || item.mockup || item.artworkPath || item.image || item.imagePath || item.artwork;

    // Prepare image for vision model (optional — works without image too)
    let imageBase64 = null;
    if (imagePath) {
      try {
        let imageBuffer = null;
        if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
          const downloaded = await downloadImage(imagePath);
          imageBuffer = await sharp(downloaded)
            .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 85 })
            .toBuffer();
        } else if (imagePath.startsWith('/')) {
          const fullUrl = `${SERVER_BASE_URL}${imagePath}`;
          const downloaded = await downloadImage(fullUrl);
          imageBuffer = await sharp(downloaded)
            .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 85 })
            .toBuffer();
        } else {
          const possiblePaths = [
            imagePath,
            path.resolve(__dirname, '..', '..', 'web', imagePath),
            path.resolve(__dirname, '..', '..', imagePath)
          ];
          for (const p of possiblePaths) {
            if (fs.existsSync(p)) {
              imageBuffer = await sharp(p)
                .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 85 })
                .toBuffer();
              break;
            }
          }
        }
        if (imageBuffer) {
          imageBase64 = imageBuffer.toString('base64');
        }
      } catch (imgErr) {
        console.warn(`[FB Scheduler] Could not load image for ${item.name}, continuing without vision:`, imgErr.message);
      }
    }

    // Build apparel info
    const apparel = item.apparel || {};
    const apparelType = apparel.styleName || apparel.styleDescription || apparel.productType || '';
    const apparelColor = apparel.colorName || apparel.color || item.colorName || item.color || '';
    const apparelBrand = apparel.brandName || apparel.brand || '';

    // Detect product type from campaign slug and productType
    const campaignProductType = (campaign?.productType || '').toLowerCase();
    const campaignSlug = (campaign?.slug || '').toLowerCase();
    const isSticker = campaignProductType === 'sticker' || campaignSlug.includes('sticker') || campaignSlug.includes('decal') || campaignSlug.includes('bumper');
    const isRacing = campaignProductType === 'racing' || campaignSlug.includes('racing') || campaignSlug.includes('race') || campaignSlug.includes('livery');
    const isCustomVinyl = campaignProductType === 'custom-vinyl' || campaignSlug.includes('custom-vinyl') || campaignSlug.includes('custom vinyl');
    const isLaserEngraving = campaignProductType === 'laser-engraving' || campaignSlug.includes('laser') || campaignSlug.includes('engrav');
    const isMetalPrint = !isSticker && !isRacing && !isCustomVinyl && !isLaserEngraving && (campaignProductType === 'custom-art' || campaignProductType === 'metal-print');
    const isMultiboard = campaignProductType === 'multiboard' ||
                         campaignSlug.includes('multiboard') ||
                         (item.name && /multiboard|wall.?organiz|tile.?grid/i.test(item.name));

    console.log(`[FB Scheduler] AI detection - apparelType: "${apparelType}", campaignProductType: "${campaignProductType}", campaignSlug: "${campaignSlug}"`);

    // Art products include metal prints and stickers (not apparel, not multiboard, not new categories)
    const isArtProduct = !apparelType && !isMultiboard && !isRacing && !isCustomVinyl && !isLaserEngraving && (
      isMetalPrint || isSticker ||
      ['canvas', 'poster', 'wall-art', 'decal', 'sticker'].includes(campaignProductType) ||
      (item.name && /lighthouse|print|art|canvas|poster|wall|decor/i.test(item.name))
    );
    console.log(`[FB Scheduler] AI detection result - isArtProduct: ${isArtProduct}, isSticker: ${isSticker}, isMetalPrint: ${isMetalPrint}, isMultiboard: ${isMultiboard}, isRacing: ${isRacing}, isCustomVinyl: ${isCustomVinyl}, isLaser: ${isLaserEngraving}`);

    // Style prompts - enriched with psychology & copy frameworks (Phase 2c)
    const artStylePrompts = {
      showcase: 'Use AIDA structure: hook with a visual detail from the image, build interest with what makes it unique, create desire by describing the feeling of owning it. Contrast this piece against generic wall art.',
      lifestyle: 'Use BAB structure: paint a "before" scene of a bare/boring wall, then the "after" with this art as the centerpiece. Use identity signaling — what does owning this say about the person?',
      quality: 'Use AIDA: lead with a surprising quality fact about sublimation metal printing, build interest with process details, desire through longevity. Apply Authority Bias — technical details signal expertise.',
      urgency: 'Use PAS: the problem is missing out on something everyone else is noticing. Agitate with social proof hints. Apply Loss Aversion — frame what they lose by not acting.'
    };

    const apparelStylePrompts = {
      showcase: 'Use AIDA: hook with a specific design detail visible in the image. Create desire through identity signaling — who wears this design and what it says about them.',
      lifestyle: 'Use BAB: boring outfit before, statement piece after. Paint a specific scene — at the coffee shop, at a cookout, walking the dog. Make it aspirational but relatable.',
      quality: 'Use AIDA: lead with a material or printing quality fact. Build expertise through Authority Bias. End with Zero-Risk positioning — this is an investment piece.',
      urgency: 'Use PAS: trending designs move fast. Agitate with social proof (this design is getting attention). Apply Scarcity — unique designs in limited runs.'
    };

    const multiboardStylePrompts = {
      showcase: 'Use AIDA: hook with the specific organization problem this solves. Build interest with the modular snap system. Contrast against cheap alternatives that fall apart.',
      lifestyle: 'Use BAB: messy/chaotic room before, organized zen-like space after. Use the specific room context provided. Apply Identity Signaling — organized people choose systems, not quick fixes.',
      quality: 'Use AIDA: lead with a 3D printing quality detail, interest in local Asheville production, desire through the expandable system concept. Authority Bias through manufacturing details.',
      urgency: 'Use PAS: disorganization costs time daily. Agitate the frustration. Package deal value as the solve. Apply Loss Aversion — calculate time wasted looking for things.'
    };

    const racingStylePrompts = {
      showcase: 'Use AIDA: hook with a specific racing detail visible in the image. Build interest with the customization options. Create desire through identity — what this says about the racer. Contrast against generic number stickers.',
      lifestyle: 'Use BAB: bare/stock car before, race-ready look after. Paint a race day scene — grid, paddock, victory lap. Use Identity Signaling — you built this car, the livery should match your ambition.',
      quality: 'Use AIDA: lead with material durability (track-rated vinyl, 3M laminate). Build interest with precision cuts and color matching. Authority Bias through racing experience.',
      urgency: 'Use PAS: race season is here and your car needs to stand out. Agitate — plain cars get forgotten. Apply Scarcity — custom work has lead times, book early.'
    };

    const customVinylStylePrompts = {
      showcase: 'Use AIDA: hook with the transformation — what bare surface becomes with custom vinyl. Build interest with the design process. Create desire through personalization.',
      lifestyle: 'Use BAB: generic car/wall/laptop before, personalized statement after. Paint a specific scene. Identity Signaling — custom vinyl says you care about details.',
      quality: 'Use AIDA: lead with vinyl durability (weatherproof, UV-rated, 5+ year outdoor life). Build interest with the free online designer tool. Authority Bias through material specs.',
      urgency: 'Use PAS: everyone has the same look. Agitate the sameness. Custom vinyl is the solve. Social Proof — show what others have created.'
    };

    const laserEngravingStylePrompts = {
      showcase: 'Use AIDA: hook with the precision and detail visible in the engraving. Build interest with the material choice. Create desire through the permanence — this lasts forever.',
      lifestyle: 'Use BAB: generic gift before, personalized keepsake after. Paint a specific gifting moment — wedding, anniversary, graduation. Identity Signaling — thoughtful people give personalized gifts.',
      quality: 'Use AIDA: lead with laser precision specs. Build interest with material options (wood, leather, acrylic, glass, metal). Authority Bias through craftsmanship details.',
      urgency: 'Use PAS: generic gifts get forgotten. Agitate — another gift card? Apply Scarcity — custom work needs lead time, order early for special occasions.'
    };

    const stylePrompts = isRacing ? racingStylePrompts :
                         isCustomVinyl ? customVinylStylePrompts :
                         isLaserEngraving ? laserEngravingStylePrompts :
                         isMultiboard ? multiboardStylePrompts :
                         isArtProduct ? artStylePrompts :
                         apparelStylePrompts;

    // Different system prompts for stickers, metal prints, multiboard, and apparel (Phase 2c)
    const BANNED_PHRASES_GLOBAL = 'NEVER use: "transform your space", "elevate your", "perfect for any room", "ALERT", "must-have", "game-changer", "next level", "ACT NOW", "BUY NOW", "don\'t miss out", "obsessed", "literally dying", "stop scrolling"';
    const NO_LINKS_RULE = 'CRITICAL: Do NOT include any links or URLs in the post body. The link will be added as a comment separately.';

    let systemPrompt;
    if (isRacing) {
      systemPrompt = `You are a social media expert for Swayze Custom Vinyl — vinyl and apparel for grassroots racers.
We serve SCCA, ARA, NASA, and club-level competitors.
- Speak racer-to-racer — we race too
- Practical, direct, and enthusiastic about the sport
- Focus on individual racers building their look on a budget
- Mention our services: number kits, sponsor panels, full liveries, crew apparel
- Frame us as the shop that gets racing
- End with a conversational CTA like "What series do you run?" — NOT "Shop now"
${BANNED_PHRASES_GLOBAL}
${NO_LINKS_RULE}`;
    } else if (isCustomVinyl) {
      systemPrompt = `You are a social media expert for Swayze Custom Vinyl.
We create custom cut vinyl — car decals, stickers, heat transfers, wall art, and more.
- Highlight our free online designer tool and upload-your-own-design option
- Casual, creative, maker-friendly tone
- Emphasize customization and self-expression
- Mention quality materials (weatherproof, UV-rated vinyl)
- End with a conversational CTA like "What would you design?" — NOT "Shop now"
${BANNED_PHRASES_GLOBAL}
${NO_LINKS_RULE}`;
    } else if (isLaserEngraving) {
      systemPrompt = `You are a social media expert for Blue Ridge Custom Co — precision laser engraving in Asheville, NC.
We engrave on wood, leather, acrylic, glass, coated metal, and slate.
- Focus on the personalization angle — names, dates, messages, logos
- Great for gifts (weddings, anniversaries, graduations, corporate)
- Mention we accept custom designs and "bring your own item"
- Warm, personal tone — these are keepsakes and memories
- End with a conversational CTA like "Who would you engrave something for?" — NOT "Shop now"
${BANNED_PHRASES_GLOBAL}
${NO_LINKS_RULE}`;
    } else if (isMultiboard) {
      systemPrompt = `You are a social media expert for Blue Ridge Custom Co — Authorized Multiboard Reseller.
We 3D print modular wall organization systems under license from Multiboard.
- Practical and direct — no fluff or hype language
- Light humor is fine
- Printed locally in Asheville, NC
- Frame Multiboard as "the system" — not just hooks and bins
- Always include "Authorized Multiboard Reseller" in product-focused posts
- Say "wall tiles" not "MU tiles", "storage bins" not "Multibins"
CONTENT RULES:
- Lead with the problem being solved
- Use specific room contexts (kitchen, garage, craft room, desk)
- Include price in conversion posts
- Mention expandability
- Don't claim to be the manufacturer
- Don't use "our design" or "we designed"
- End with a conversational CTA like "What room would you organize first?" — NOT "Shop now"
${BANNED_PHRASES_GLOBAL}
${NO_LINKS_RULE}`;
    } else if (isSticker) {
      systemPrompt = `You are a social media expert for Blue Ridge Custom Co.
We create eye-catching vinyl stickers and decals with bold designs.
Write fun, punchy posts that show personality and make people want to slap these on their stuff.
Be playful, authentic, and tap into the sticker collector vibe. Use 1-2 fun emojis.
NEVER use boring corporate language.
End with a conversational CTA like "Tag a friend who needs this" — NOT "Shop now" or "Buy now".
${BANNED_PHRASES_GLOBAL}
${NO_LINKS_RULE}`;
    } else if (isArtProduct) {
      systemPrompt = `You are a passionate art curator and social media expert for Blue Ridge Custom Co.
We create stunning sublimation metal prints and wall art.
Write posts that make people FEEL something - nostalgia, wonder, desire.
Be authentic, evocative, and paint vivid pictures with words. Use 1-2 well-placed emojis.
End with a conversational CTA like "Tag someone who needs this on their wall" — NOT "Shop now".
${BANNED_PHRASES_GLOBAL}
${NO_LINKS_RULE}`;
    } else {
      systemPrompt = `You are a social media expert for Blue Ridge Custom Co, a custom apparel printing business.
Generate engaging, authentic posts that drive engagement and sales.
Keep posts casual, friendly, and avoid sounding like an ad. Use emojis sparingly but effectively.
End with a conversational CTA like "Drop a [emoji] if this is you" — NOT "Shop now" or "Buy now".
${BANNED_PHRASES_GLOBAL}
${NO_LINKS_RULE}`;
    }

    let userPrompt;
    if (isMultiboard) {
      const room = item.room_use_case || item.room || campaign?.room || 'home';
      userPrompt = `Create ONE engaging Facebook post for this Multiboard product:

Product: ${item.name || 'Multiboard Wall Organization System'}
Room: ${room}
${campaign?.title ? `Campaign: ${campaign.title}` : ''}
${collectionUrl ? `Shop: ${collectionUrl}` : ''}

Style Guidance: ${stylePrompts[style] || stylePrompts.showcase}

Write a post that:
- Leads with the problem (messy/disorganized ${room})
- Introduces the modular wall tile solution (2-3 sentences max)
- Mentions it's 3D printed locally in Asheville, NC
- Mentions "Authorized Multiboard Reseller"
- Ends with a call to action

Then add 8-10 hashtags mixing:
- Organization/home improvement tags
- Room-specific tags
- Local/3D printing tags
- Multiboard community tags

Output as JSON:
{
  "text": "Your practical, engaging post here",
  "hashtags": ["#tag1", "#tag2"]
}`;
    } else if (isSticker) {
      userPrompt = `Create ONE punchy Facebook post for this design:

Design: ${item.name || 'Custom Sticker'}
${campaign?.title ? `Collection: ${campaign.title}` : ''}
${collectionUrl ? `Shop: ${collectionUrl}` : ''}

Write a post that:
- Opens with a fun, attention-grabbing hook about the design
- Describes what makes this sticker cool/funny/unique (2-3 sentences max)
- Naturally mentions it's a vinyl sticker/decal WITHOUT being sales-y
- Ends with a playful call to action

Then add 6-8 hashtags mixing:
- Sticker/decal tags
- Design style tags
- Interest/hobby tags relevant to the design

Output as JSON:
{
  "text": "Your fun, engaging post here",
  "hashtags": ["#tag1", "#tag2"]
}`;
    } else if (isArtProduct) {
      userPrompt = `Create ONE compelling Facebook post for this artwork:

Title: ${item.name || 'Custom Art Print'}
${campaign?.title ? `Collection: ${campaign.title}` : ''}
${collectionUrl ? `Shop: ${collectionUrl}` : ''}

Style Guidance: ${stylePrompts[style] || stylePrompts.showcase}

Write a post that:
- Starts with a vivid, emotional hook
- Tells a mini-story or evokes a specific feeling/memory (2-3 sentences max)
- Naturally mentions it's available as a metal print WITHOUT sounding salesy
- Ends with subtle call to action

Then add 8-10 hashtags mixing:
- Art/decor specific tags
- Emotional/vibe tags
- Location tags if relevant

Output as JSON:
{
  "text": "Your emotionally engaging post here",
  "hashtags": ["#tag1", "#tag2"]
}`;
    } else {
      userPrompt = `Create ONE engaging Facebook post for this product:

Product: ${item.name || 'Custom Design'}
${apparelType ? `Style: ${apparelType}` : ''}
${apparelBrand ? `Brand: ${apparelBrand}` : ''}
${apparelColor ? `Color: ${apparelColor}` : ''}
${campaign?.title ? `Campaign: ${campaign.title}` : ''}

Style: ${stylePrompts[style] || stylePrompts.showcase}

Generate:
1. Post text (2-3 sentences with a strong hook)
2. 8-12 relevant hashtags

Output as JSON:
{
  "text": "Your engaging post text here",
  "hashtags": ["#tag1", "#tag2"]
}`;
    }

    let responseText;

    // Try vision model (llava) if we have an image
    if (imageBase64) {
      try {
        responseText = await ollamaClient.vision(
          `${systemPrompt}\n\n${userPrompt}`,
          [imageBase64],
          { temperature: 0.8, maxTokens: 500, timeout: 180000 }
        );
        console.log(`[FB Scheduler] Vision AI (llava) generated text for: ${item.name}`);
      } catch (visionErr) {
        console.warn(`[FB Scheduler] Vision model failed for ${item.name}, falling back to text-only:`, visionErr.message);
      }
    }

    // Fallback: text-only chat (no image)
    if (!responseText) {
      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ];
      responseText = await ollamaClient.chat(messages, { temperature: 0.8, timeout: 120000 });
      console.log(`[FB Scheduler] Text AI (ollama chat) generated text for: ${item.name}`);
    }

    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('[FB Scheduler] Could not parse AI response');
      return null;
    }

    const result = JSON.parse(jsonMatch[0]);
    console.log(`[FB Scheduler] Generated AI text for: ${item.name}`);

    return {
      text: result.text || '',
      hashtags: Array.isArray(result.hashtags) ? result.hashtags.join(' ') : (result.hashtags || '')
    };
  } catch (err) {
    console.error(`[FB Scheduler] AI generation failed for ${item.name}:`, err.message);
    return null;
  }
}


/**
 * Generate AI post using local Ollama (fallback when Anthropic API unavailable)
 */
async function generateAiPostViaOllama(item, campaign, style = 'showcase') {
  try {
    const productName = item.name || 'Custom Design';
    const campaignSlug = (campaign?.slug || '').toLowerCase();

    const prompt = `You are a social media expert for Blue Ridge Custom Co, a custom apparel brand.
Write ONE engaging Facebook post for this trending t-shirt design: "${productName}"
Campaign: ${campaign?.title || campaignSlug || 'Trending Designs'}
Style: ${style === 'urgency' ? "Create FOMO and urgency - this is a trending design that won't last" : 'Highlight the design quality and style'}

Requirements:
- 2-3 sentences with a strong hook
- Casual, fun tone - not corporate
- Use 1-2 emojis
- Then list 6-8 relevant hashtags

Output as JSON: {"text": "your post", "hashtags": ["#tag1", "#tag2"]}`;

    const result = await ollamaClient.generate(prompt, { temperature: 0.8, maxTokens: 400, timeout: 120000 });

    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('[FB Scheduler] Ollama: Could not parse JSON, using template');
      return { text: `Check out our new ${productName}! Grab yours before it's gone \u{1F525}`, hashtags: '#TrendingNow #BlueRidgeCustomCo #NewDesign #ShopNow' };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    console.log(`[FB Scheduler] Ollama generated text for: ${productName}`);
    return {
      text: parsed.text || '',
      hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags.join(' ') : (parsed.hashtags || '')
    };
  } catch (err) {
    console.error(`[FB Scheduler] Ollama generation failed:`, err.message);
    return null;
  }
}

/**
 * Check if a path is a URL
 */
function isUrl(str) {
  return str && (str.startsWith('http://') || str.startsWith('https://'));
}

/**
 * Resolve an image path to a full public URL
 * All images should be fetched via public URLs, not local file paths
 * Handles:
 * - Full URLs (http/https) - returned as-is
 * - /api/library/ paths - converted to full URLs
 * - /uploads/ or other server paths - converted to full URLs
 */
function resolveImagePath(imagePath) {
  if (!imagePath) return null;

  // Already a full URL
  if (isUrl(imagePath)) {
    return { type: 'url', path: imagePath };
  }

  // Absolute local filesystem path (already resolved)
  if (imagePath.startsWith('/') && fs.existsSync(imagePath)) {
    return { type: 'local', path: imagePath };
  }

  // App-relative paths like /data/... or /images/... - resolve to vinylApp directory
  if (imagePath.startsWith('/')) {
    const VINYL_APP_ROOT = '/home/ubuntu/vinylApp';
    const appRelativePath = path.join(VINYL_APP_ROOT, imagePath);
    if (fs.existsSync(appRelativePath)) {
      console.log(`[FB Scheduler] Resolved app-relative path to local: ${appRelativePath}`);
      return { type: 'local', path: appRelativePath };
    }
    const webRelativePath = path.join(VINYL_APP_ROOT, 'web', imagePath);
    if (fs.existsSync(webRelativePath)) {
      console.log(`[FB Scheduler] Resolved web-relative path to local: ${webRelativePath}`);
      return { type: 'local', path: webRelativePath };
    }
  }

  // Check local filesystem first for relative paths (e.g. library/uploads/custom-art/...)
  if (!imagePath.startsWith('/')) {
    const APP_DIR = path.resolve(__dirname, '..', '..');
    const possiblePaths = [
      path.resolve(APP_DIR, imagePath),
      path.resolve(APP_DIR, 'web', imagePath)
    ];
    for (const localPath of possiblePaths) {
      if (fs.existsSync(localPath)) {
        console.log(`[FB Scheduler] Resolved to local file: ${localPath}`);
        return { type: 'local', path: localPath };
      }
    }
  }

  // Server-relative paths -> convert to full URL
  // This handles /api/library/, /uploads/, etc.
  if (imagePath.startsWith('/')) {
    const fullUrl = `${SERVER_BASE_URL}${imagePath}`;
    console.log(`[FB Scheduler] Resolved server path to URL: ${fullUrl}`);
    return { type: 'url', path: fullUrl };
  }

  // Relative path without leading slash - fallback to URL
  const fullUrl = `${SERVER_BASE_URL}/${imagePath}`;
  console.log(`[FB Scheduler] Resolved relative path to URL: ${fullUrl}`);
  return { type: 'url', path: fullUrl };
}

/**
 * Download an image from a URL and return as buffer
 */
function downloadImage(url) {
  return new Promise((resolve, reject) => {
    // Properly encode URL - handle spaces and special characters
    // Parse the URL, encode the pathname part only (not the protocol/domain)
    try {
      const urlObj = new URL(url);
      // Encode each path segment separately to avoid double-encoding
      const pathSegments = urlObj.pathname.split('/').map(seg => encodeURIComponent(decodeURIComponent(seg)));
      urlObj.pathname = pathSegments.join('/');
      url = urlObj.toString();
    } catch (e) {
      // If URL parsing fails, fall back to simple space encoding
      url = url.replace(/ /g, '%20');
    }

    const protocol = url.startsWith('https') ? https : http;

    const request = protocol.get(url, (response) => {
      // Handle redirects
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        downloadImage(response.headers.location).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download image: HTTP ${response.statusCode}`));
        return;
      }

      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });

    request.on('error', reject);
    request.setTimeout(30000, () => {
      request.destroy();
      reject(new Error('Image download timeout'));
    });
  });
}

/**
 * Get image buffer from a path or URL
 * Automatically resolves server paths to full URLs
 */
async function getImageBuffer(pathOrUrl) {
  // Resolve the path to a full URL if needed
  const resolved = resolveImagePath(pathOrUrl);
  if (!resolved) {
    throw new Error(`Could not resolve image path: ${pathOrUrl}`);
  }

  const finalPath = resolved.path;

  if (isUrl(finalPath)) {
    console.log(`[FB Scheduler] Downloading image from URL: ${finalPath.substring(0, 100)}...`);
    return await downloadImage(finalPath);
  } else {
    // This should rarely happen now since resolveImagePath converts most paths to URLs
    if (!fs.existsSync(finalPath)) {
      throw new Error(`Local image not found: ${finalPath}`);
    }
    return fs.readFileSync(finalPath);
  }
}

/**
 * Generate a mockup for a scheduled post
 */
async function generateMockupForPost(post, template, options = {}) {
  if (!template) {
    throw new Error('No template provided for mockup generation');
  }

  if (!post.artworkPath) {
    throw new Error('No artwork path specified for post');
  }

  // Build output path
  const timestamp = Date.now();
  const outputFilename = `${post.campaignSlug}-${post.productUid || 'product'}-${timestamp}.jpg`;
  const outputPath = path.join(GENERATED_MOCKUPS_DIR, outputFilename);

  // Generate the mockup
  const result = await generateMockupToFile(
    {
      mockupImagePath: template.mockupImagePath,
      artworkPosition: template.artworkPosition,
      blendMode: template.blendMode,
      outputFormat: template.outputFormat || 'jpeg',
      outputQuality: template.outputQuality || 90
    },
    post.artworkPath,
    outputPath,
    options
  );

  return {
    path: result.path,
    size: result.size,
    filename: outputFilename
  };
}

/**
 * Post image to Facebook Page
 * @param {string|Buffer} imagePathOrBuffer - Either a local file path, URL, or Buffer containing image data
 * @param {string} text - Post text
 */
async function postToFacebook(imagePathOrBuffer, text, category = "") {
  const creds = getFacebookCredentials(category);
  const pageAccessToken = creds.accessToken;
  const pageId = creds.pageId;
  
  console.log("[Facebook] Category:", category, "-> Posting to:", creds.pageName, "(ID:", pageId, ")");
  
  if (!pageAccessToken || !pageId) {
    throw new Error('Facebook credentials not configured. Set FB_PAGE_ACCESS_TOKEN and FB_PAGE_ID in .env');
  }

  // Get image buffer based on input type
  let imageBuffer;
  if (Buffer.isBuffer(imagePathOrBuffer)) {
    imageBuffer = imagePathOrBuffer;
  } else {
    // It's a path or URL string
    imageBuffer = await getImageBuffer(imagePathOrBuffer);
  }
  const boundary = '----FormBoundary' + Math.random().toString(36).substring(2);

  const photoData = Buffer.concat([
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="source"; filename="mockup.jpg"\r\n`),
    Buffer.from(`Content-Type: image/jpeg\r\n\r\n`),
    imageBuffer,
    Buffer.from(`\r\n--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="message"\r\n\r\n`),
    Buffer.from(`${text}\r\n`),
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="access_token"\r\n\r\n`),
    Buffer.from(`${pageAccessToken}\r\n`),
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="published"\r\n\r\n`),
    Buffer.from(`true\r\n`),
    Buffer.from(`--${boundary}--\r\n`)
  ]);

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'graph.facebook.com',
      path: `/v21.0/${pageId}/photos`,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': photoData.length
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.error) {
            reject(new Error(result.error.message));
          } else {
            resolve({
              success: true,
              postId: result.post_id || result.id,
              photoId: result.id
            });
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(photoData);
    req.end();
  });
}

/**
 * Publish a photo to Instagram via the Instagram Graph API.
 * Requires an Instagram Business account linked to the Facebook Page and
 * FB_PAGE_ACCESS_TOKEN with instagram_basic + instagram_content_publish permissions.
 *
 * Two-step process:
 *   1. POST /{ig-user-id}/media  (creates a container)
 *   2. POST /{ig-user-id}/media_publish  (publishes the container)
 *
 * @param {string} imageUrl - A publicly accessible image URL (IG fetches it server-side)
 * @param {string} caption - Post caption text
 * @param {string} hashtags - Additional hashtags to append
 * @param {string} category - Product category (for credential lookup)
 * @returns {Promise<{success: boolean, igPostId: string}>}
 */
async function publishToInstagram(imageUrl, caption, hashtags = "", category = "") {
  if (!INSTAGRAM_BUSINESS_ACCOUNT_ID) {
    return { success: false, skipped: true, reason: 'INSTAGRAM_BUSINESS_ACCOUNT_ID not configured' };
  }

  const creds = getFacebookCredentials(category);
  const accessToken = creds.accessToken;

  if (!accessToken) {
    throw new Error('No FB_PAGE_ACCESS_TOKEN available for Instagram publishing');
  }

  // Build full caption with hashtags
  const fullCaption = hashtags ? `${caption}\n\n${hashtags}` : caption;

  console.log(`[Instagram] Publishing to IG account ${INSTAGRAM_BUSINESS_ACCOUNT_ID}...`);

  // Step 1: Create media container
  const containerId = await new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      image_url: imageUrl,
      caption: fullCaption,
      access_token: accessToken
    });

    const req = https.request({
      hostname: 'graph.facebook.com',
      path: `/v18.0/${INSTAGRAM_BUSINESS_ACCOUNT_ID}/media`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.error) {
            reject(new Error(`IG container creation failed: ${result.error.message}`));
          } else if (!result.id) {
            reject(new Error(`IG container creation returned no ID: ${data}`));
          } else {
            console.log(`[Instagram] Container created: ${result.id}`);
            resolve(result.id);
          }
        } catch (e) {
          reject(new Error(`IG container parse error: ${e.message} — raw: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });

  // Step 2: Publish the container
  // Brief delay to allow IG to process the container
  await new Promise(r => setTimeout(r, 3000));

  const publishResult = await new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      creation_id: containerId,
      access_token: accessToken
    });

    const req = https.request({
      hostname: 'graph.facebook.com',
      path: `/v18.0/${INSTAGRAM_BUSINESS_ACCOUNT_ID}/media_publish`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.error) {
            reject(new Error(`IG publish failed: ${result.error.message}`));
          } else {
            console.log(`[Instagram] Published successfully: ${result.id}`);
            resolve(result);
          }
        } catch (e) {
          reject(new Error(`IG publish parse error: ${e.message} — raw: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });

  return {
    success: true,
    igPostId: publishResult.id
  };
}

/**
 * Phase 1a: Post a comment on a Facebook post (used for shop link as first comment)
 * @param {string} postId - The Facebook post ID to comment on
 * @param {string} message - Comment text
 * @param {string} category - Product category (for credential lookup)
 */
async function postFirstComment(postId, message, category = "") {
  const creds = getFacebookCredentials(category);
  const pageAccessToken = creds.accessToken;

  if (!pageAccessToken || !postId) {
    throw new Error('Missing credentials or post ID for comment');
  }

  const postData = JSON.stringify({
    message,
    access_token: pageAccessToken
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'graph.facebook.com',
      path: `/v21.0/${postId}/comments`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.error) {
            reject(new Error(result.error.message));
          } else {
            resolve({ success: true, commentId: result.id });
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/**
 * Process a single scheduled post
 *
 * Handles two modes:
 * 1. Custom Art: Has templateId + artworkPath -> generates mockup by compositing
 * 2. Apparel: Has mockupPath directly -> uses existing mockup image as-is
 */
async function processScheduledPost(post, db, options = {}) {
  const { onProgress } = options;

  try {
    if (onProgress) onProgress('starting', post);

    let rawImagePath = null;

    // Mode 1: Apparel/Pre-rendered - use existing mockup directly
    if (post.mockupPath) {
      rawImagePath = post.mockupPath;
      if (onProgress) onProgress('using-existing-mockup', post);
    }
    // Mode 2: Apparel with template - generate mockup from template + artwork
    // For Facebook posts, ONLY generate mockups for apparel campaigns
    // Metal prints/custom art should use artwork directly (skip to Mode 3)
    else if (post.templateId && post.artworkPath && post.campaignType === 'apparel') {
      // Check if we already generated it
      if (post.generatedMockupPath && fs.existsSync(post.generatedMockupPath)) {
        rawImagePath = post.generatedMockupPath;
      } else {
        const template = db.getMockupTemplateById(post.templateId);
        if (!template) {
          throw new Error(`Template not found: ${post.templateId}`);
        }

        if (onProgress) onProgress('generating-mockup', post);

        const mockupResult = await generateMockupForPost(post, template);
        rawImagePath = mockupResult.path;

        // Update post with generated mockup path
        db.updateScheduledPost(post.id, {
          generatedMockupPath: rawImagePath
        });
      }
    }
    // Mode 3: Multiboard - pull media from multiboard_media table
    else if (post.campaignType === 'multiboard' && db.getMultiboardMediaForPillar) {
      const pillar = post.aiStyle === 'lifestyle' ? 'consideration' :
                     post.aiStyle === 'quality' ? 'trust' :
                     post.aiStyle === 'urgency' ? 'conversion' : 'awareness';
      const media = db.getMultiboardMediaForPillar(pillar, post.room || null);
      if (media && media.file_path) {
        rawImagePath = media.file_path;
        if (onProgress) onProgress('using-multiboard-media', post);
      }
    }
    // Mode 4: Fallback - just use artwork as the image
    else if (post.artworkPath) {
      rawImagePath = post.artworkPath;
    }

    // Validate we have an image path/URL
    if (!rawImagePath) {
      throw new Error('No image path or URL available for post');
    }

    // Resolve the image path to a full URL
    const resolved = resolveImagePath(rawImagePath);
    if (!resolved) {
      throw new Error(`Could not resolve image path: ${rawImagePath}`);
    }

    const imagePath = resolved.path;
    console.log(`[FB Scheduler] Processing image URL: ${imagePath.substring(0, 120)}...`);

    // Build post text
    let postText = post.postText || '';
    let postHashtags = post.postHashtags || '';

    // Generate AI text at posting time if flagged
    // Always regenerate when flag is true - don't use cached text
    if (post.generateAiOnPost) {
      console.log(`[FB Scheduler] Generating fresh AI text for: ${post.productName}`);
      if (onProgress) onProgress('generating-ai-text', post);

      try {
        // Build item data for AI generation
        const itemData = {
          name: post.productName,
          uid: post.productUid,
          mockupImage: post.mockupPath,
          artworkPath: post.artworkPath
        };

        // Get campaign data if available
        let campaignData = null;
        try {
          campaignData = db.getCampaign ? db.getCampaign(post.campaignSlug) : null;
        } catch (e) {
          // Campaign lookup failed, continue without it
        }

        const aiResult = await generateAiPostForItem(
          itemData,
          campaignData || { slug: post.campaignSlug, productType: post.campaignType },
          post.aiStyle || 'showcase',
          post.collectionUrl
        );

        if (aiResult) {
          postText = aiResult.text;
          postHashtags = aiResult.hashtags || postHashtags;
          console.log(`[FB Scheduler] AI generated text for: ${post.productName}`);

          // Save the generated text back to the post record
          db.updateScheduledPost(post.id, {
            postText: postText,
            postHashtags: postHashtags
          });
        } else {
          postText = `Check out ${post.productName}! Available now.`;
          console.log(`[FB Scheduler] AI generation returned null, using default for: ${post.productName}`);
        }
      } catch (aiError) {
        console.error(`[FB Scheduler] AI generation error for ${post.productName}:`, aiError.message);
        postText = `Check out ${post.productName}! Available now.`;
      }
    }

    // Add prefix for specific campaign types
    const cType = (post.campaignType || '').toLowerCase();
    if (cType === 'custom-art') {
      const campaignSlug = (post.campaignSlug || '').toLowerCase();
      const isSticker = campaignSlug.includes('sticker') || campaignSlug.includes('decal') || campaignSlug.includes('bumper');
      if (isSticker) {
        postText = `New Sticker Design just dropped ✨\n\n${postText}`;
      } else {
        postText = `New Metal Print Artwork just dropped ✨\n\n${postText}`;
      }
    } else if (cType === 'racing') {
      postText = `🏁 Race-Ready Vinyl\n\n${postText}`;
    } else if (cType === 'custom-vinyl') {
      postText = `✂️ Custom Vinyl\n\n${postText}`;
    } else if (cType === 'laser-engraving') {
      postText = `🔥 Laser Engraved\n\n${postText}`;
    }

    // Append hashtags (Phase 1a: link moved to first comment)
    if (postHashtags) {
      postText += '\n\n' + postHashtags;
    }
    // NOTE: Shop link is now posted as first comment, NOT in post body (improves reach)

    if (!postText.trim()) {
      throw new Error('No post text provided');
    }

    // Post to Facebook
    if (onProgress) onProgress('posting', post);

    const fbResult = await postToFacebook(imagePath, postText, post.category || post.productCategory || post.campaignSlug || post.campaignProductType || "");

    // Phase 1a: Post shop link as first comment (non-fatal if it fails)
    if (post.collectionUrl && fbResult.postId) {
      try {
        await postFirstComment(fbResult.postId, `🛒 Shop this item: ${post.collectionUrl}`, post.category || post.productCategory || post.campaignSlug || "");
        console.log(`[FB Scheduler] Posted shop link as first comment on ${fbResult.postId}`);
      } catch (commentErr) {
        console.warn(`[FB Scheduler] Failed to post first comment (non-fatal): ${commentErr.message}`);
      }
    }

    // Cross-post to Instagram (non-fatal — only if configured)
    let igResult = null;
    if (INSTAGRAM_BUSINESS_ACCOUNT_ID) {
      try {
        // Instagram requires a publicly accessible image URL (not a buffer/local path)
        let igImageUrl = imagePath;
        if (!igImageUrl.startsWith('http://') && !igImageUrl.startsWith('https://')) {
          // Convert local path to a public URL via the server
          const relativePath = igImageUrl.startsWith('/') && igImageUrl.includes('/data/')
            ? igImageUrl.substring(igImageUrl.indexOf('/data/'))
            : igImageUrl;
          igImageUrl = `${SERVER_BASE_URL}${relativePath}`;
        }

        const postCategory = post.category || post.productCategory || post.campaignSlug || post.campaignProductType || "";
        igResult = await publishToInstagram(igImageUrl, postText, "", postCategory);
        if (igResult.success) {
          console.log(`[FB Scheduler] Instagram cross-post successful: ${igResult.igPostId}`);
        }
      } catch (igErr) {
        console.warn(`[FB Scheduler] Instagram cross-post failed (non-fatal): ${igErr.message}`);
        igResult = { success: false, error: igErr.message };
      }
    }

    // Mark as published
    db.markScheduledPostPublished(post.id, fbResult.postId);

    // Queue group posts (non-blocking) — sends group-optimized content to Telegram
    try {
      const groupPoster = require('../modules/fb-group-poster');
      const groups = groupPoster.getGroupsForCategory(
        post.category || post.productCategory || post.campaignType || ''
      );
      if (groups.length > 0) {
        const shopUrl = post.collectionUrl || '';
        groupPoster.sendToGroups({
          text: postText,
          imagePath: imagePath,
          category: post.category || post.productCategory || post.campaignType || '',
          shopUrl
        }, { rewrite: true }).then(r => {
          if (r.sent > 0) console.log(`[FB Scheduler] Queued ${r.sent} group posts to Telegram`);
        }).catch(e => console.warn(`[FB Scheduler] Group posting failed (non-fatal): ${e.message}`));
      }
    } catch (groupErr) {
      // Non-fatal — don't break the main posting flow
      console.warn(`[FB Scheduler] Group poster error: ${groupErr.message}`);
    }

    if (onProgress) onProgress('completed', post, fbResult);

    return {
      success: true,
      postId: post.id,
      facebookPostId: fbResult.postId,
      instagramPostId: igResult && igResult.success ? igResult.igPostId : null,
      imagePath
    };

  } catch (error) {
    console.error(`[FB Scheduler] Failed to process post ${post.id}:`, error.message);

    // Mark as failed
    db.markScheduledPostFailed(post.id, error.message);

    if (onProgress) onProgress('failed', post, error);

    return {
      success: false,
      postId: post.id,
      error: error.message
    };
  }
}

/**
 * Process all pending scheduled posts that are due
 */
async function processPendingPosts(db, options = {}) {
  const allPending = db.getPendingScheduledPosts();

  // Filter out non-Facebook posts (e.g. pinterest) - those need their own publisher
  // Note: instagram posts are now handled via cross-posting from Facebook
  const pendingPosts = allPending.filter(post => {
    const ctype = (post.campaignType || '').toLowerCase();
    if (ctype === 'pinterest') {
      console.log(`[FB Scheduler] Skipping ${ctype} post ${post.id} (${post.productName}) - not a Facebook post`);
      return false;
    }
    return true;
  });

  console.log(`[FB Scheduler] Found ${pendingPosts.length} Facebook posts to process (${allPending.length - pendingPosts.length} non-Facebook skipped)`);

  const results = [];

  for (const post of pendingPosts) {
    const result = await processScheduledPost(post, db, options);
    results.push(result);

    // Small delay between posts to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  return {
    processed: results.length,
    successful: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
    results
  };
}

/**
 * Schedule posts for all products in a campaign
 *
 * Handles two campaign types:
 * - 'apparel': Each item has its own mockupImage, use directly
 * - 'custom-art': Use templateId to composite artwork onto base mockup
 *
 * When generateAiPerItem is true, generates unique AI text for each item.
 * Otherwise uses postText for all items (or buildDefaultPostText if not provided).
 */
async function schedulePostsForCampaign(campaignData, db, options = {}) {
  const {
    campaignType,  // 'apparel' or 'custom-art' (auto-detected if not provided)
    templateId,    // Required for custom-art
    postText,
    postHashtags,
    collectionUrl,
    startDate,
    intervalHours = 24, // Default: one post per day
    excludeProductUids = [],
    generateAiPerItem = false,  // When true, generate unique AI text for each item
    aiStyle = 'showcase'        // AI generation style: showcase, lifestyle, quality, urgency
  } = options;

  const items = campaignData.items || [];
  const scheduledPosts = [];

  // Check for campaign-level mockup
  const campaignMockup = campaignData.mockupImage || null;

  // Auto-detect campaign type if not specified
  // Check productType field first - only apparel campaigns use mockups for FB posts
  // Metal prints, custom art, decals, stickers all use just the artwork image
  const campaignProductType = (campaignData.productType || '').toLowerCase();
  const isApparelCampaign = campaignProductType === 'apparel' ||
                           campaignProductType === 'tshirt' ||
                           campaignProductType === 'hoodie' ||
                           campaignProductType === 'sweatshirt' ||
                           items.some(item => item.apparel || item.mockupImage);

  const detectedType = campaignType || (isApparelCampaign ? 'apparel' : 'custom-art');

  console.log(`[FB Scheduler] Campaign productType: ${campaignProductType}, detected as: ${detectedType}`);

  // Campaign-level apparel info as fallback
  const campaignApparelType = campaignData.apparelType || campaignData.apparel_type || null;
  const campaignApparelColor = campaignData.apparelColor || campaignData.apparel_color || null;

  /**
   * Extract apparel info from an item
   * Each item can have its own apparel object with styleName, colorName, brandName
   * Falls back to campaign-level info if not available on item
   */
  function getItemApparelInfo(item) {
    const apparel = item.apparel || {};

    // Try to get type from item.apparel.styleName or item.apparel.productType, fallback to campaign level
    let type = apparel.styleName || apparel.styleDescription || apparel.productType ||
               apparel.type || item.apparelType || campaignApparelType;

    // Normalize common style names to types
    if (type) {
      const lowerType = type.toLowerCase();
      if (lowerType.includes('hoodie') || lowerType.includes('hooded')) {
        type = 'hoodie';
      } else if (lowerType.includes('long sleeve') || lowerType.includes('longsleeve')) {
        type = 'longsleeve';
      } else if (lowerType.includes('tank')) {
        type = 'tanktop';
      } else if (lowerType.includes('sweatshirt') || lowerType.includes('crew')) {
        type = 'sweatshirt';
      } else if (lowerType.includes('tee') || lowerType.includes('t-shirt') || lowerType.includes('tshirt')) {
        type = 'tshirt';
      }
    }

    // Get color from item.apparel.colorName or item.colorName, fallback to campaign level
    const color = apparel.colorName || apparel.color || item.colorName || item.color || campaignApparelColor;

    // Get brand from item.apparel.brandName
    const brand = apparel.brandName || apparel.brand || null;

    return { type, color, brand };
  }

  // Build apparel-aware default post text for a specific item
  function buildDefaultPostText(item) {
    const itemName = item.name;

    if (detectedType === 'apparel') {
      const { type, color } = getItemApparelInfo(item);

      if (type) {
        // Format apparel type for display (e.g., "tshirt" -> "t-shirt", "hoodie" -> "hoodie")
        const apparelLabel = formatApparelType(type);
        const colorPart = color ? ` in ${color}` : '';
        return `Check out this ${itemName || 'design'} on our ${apparelLabel}${colorPart}! 🎨👕`;
      }
    }
    return `Check out our ${itemName || 'custom design'}! 🎨`;
  }

  // Build apparel-aware default hashtags for a specific item
  function buildDefaultHashtags(item) {
    if (detectedType === 'apparel') {
      const { type } = getItemApparelInfo(item);

      if (type) {
        const baseHashtags = ['#customapparel', '#graphictee', '#shopsmall'];
        // Add type-specific hashtags
        const typeHashtags = {
          tshirt: ['#tshirt', '#tshirts', '#teelife'],
          hoodie: ['#hoodie', '#hoodies', '#hoodieseason'],
          longsleeve: ['#longsleeve', '#longsleevetee'],
          tanktop: ['#tanktop', '#tanks'],
          sweatshirt: ['#sweatshirt', '#crewneck']
        };
        const typeSpecific = typeHashtags[type.toLowerCase()] || [`#${type.toLowerCase()}`];
        return [...baseHashtags, ...typeSpecific].join(' ');
      }
    }
    return '#customart #vinyl #decals';
  }

  let currentDate = new Date(startDate || Date.now());

  // Log AI generation mode
  if (generateAiPerItem) {
    console.log(`[FB Scheduler] AI generation enabled for ${items.length} items (style: ${aiStyle})`);
  }

  for (const item of items) {
    // Skip excluded products
    if (excludeProductUids.includes(item.uid)) continue;

    // Get item-specific apparel info for logging
    const itemApparel = getItemApparelInfo(item);

    // Determine post text and hashtags
    // If generateAiPerItem is true, we defer AI generation to posting time
    // This makes scheduling fast and allows preview before posting
    let itemPostText;
    let itemPostHashtags;
    let deferAiGeneration = false;

    if (generateAiPerItem && !postText) {
      // Defer AI generation to posting time - just use placeholder for now
      itemPostText = ''; // Empty signals AI generation needed
      itemPostHashtags = postHashtags || '';
      deferAiGeneration = true;
      console.log(`[FB Scheduler] Scheduling ${item.name} with deferred AI generation`);
    } else {
      // Use provided text or defaults
      itemPostText = postText || buildDefaultPostText(item);
      itemPostHashtags = postHashtags || buildDefaultHashtags(item);
    }

    let postData = {
      campaignSlug: campaignData.slug,
      productUid: item.uid,
      productName: item.name,
      campaignType: detectedType,
      postText: itemPostText,
      postHashtags: itemPostHashtags,
      collectionUrl,
      scheduledFor: currentDate.toISOString(),
      generateAiOnPost: deferAiGeneration,  // Flag to generate AI when posting
      aiStyle: deferAiGeneration ? aiStyle : null  // Store style for later generation
    };

    if (detectedType === 'apparel') {
      // Apparel: use existing mockup directly
      // Try item-specific mockup first, then fall back to campaign-level mockup
      const mockupPath = item.mockupImage || item.mockup || campaignMockup;
      if (!mockupPath) {
        console.log(`[FB Scheduler] Skipping apparel item ${item.uid || item.name} - no mockupImage`);
        continue; // Skip apparel items without mockup
      }

      postData.mockupPath = mockupPath;
      const mockupSource = (item.mockupImage || item.mockup) ? 'item-level' : 'campaign-level';
      console.log(`[FB Scheduler] Scheduled apparel post for ${item.name}, type: ${itemApparel.type || 'unknown'}, color: ${itemApparel.color || 'unknown'}, mockup (${mockupSource}): ${mockupPath}`);
    } else {
      // Custom Art / Metal Print / Decal: use artwork image directly (NO mockup)
      const artworkPath = item.image || item.artworkPath || item.artwork;
      if (!artworkPath) {
        console.log(`[FB Scheduler] Skipping ${detectedType} item ${item.uid || item.name} - no artwork image`);
        continue; // Skip items without artwork
      }

      // For custom-art campaigns with templateId, store it for mockup generation
      // For metal-print/decal campaigns, templateId is not used - just post the artwork
      if (templateId) {
        postData.templateId = templateId;
      }
      postData.artworkPath = artworkPath;
      console.log(`[FB Scheduler] Scheduled ${detectedType} post for ${item.name}, artwork: ${artworkPath}${templateId ? `, template: ${templateId}` : ''}`);
    }

    const post = db.createScheduledPost(postData);
    scheduledPosts.push(post);

    // Advance to next scheduled time
    currentDate = new Date(currentDate.getTime() + intervalHours * 60 * 60 * 1000);
  }

  return {
    campaign: campaignData.slug,
    campaignType: detectedType,
    postsScheduled: scheduledPosts.length,
    startDate: startDate || new Date().toISOString(),
    endDate: currentDate.toISOString(),
    posts: scheduledPosts
  };
}

/**
 * Format apparel type for display
 * Converts slug-style to human-readable
 */
function formatApparelType(type) {
  if (!type) return 'apparel';
  const typeMap = {
    tshirt: 't-shirt',
    't-shirt': 't-shirt',
    hoodie: 'hoodie',
    longsleeve: 'long sleeve shirt',
    'long-sleeve': 'long sleeve shirt',
    tanktop: 'tank top',
    'tank-top': 'tank top',
    sweatshirt: 'sweatshirt',
    crewneck: 'crewneck'
  };
  return typeMap[type.toLowerCase()] || type;
}

/**
 * Start the scheduler daemon (runs periodically)
 */
function startSchedulerDaemon(db, options = {}) {
  const { intervalMinutes = 5, onCycleComplete } = options;

  console.log(`[FB Scheduler] Starting daemon, checking every ${intervalMinutes} minutes`);

  const runCycle = async () => {
    try {
      const results = await processPendingPosts(db, options);

      if (results.processed > 0) {
        console.log(`[FB Scheduler] Cycle complete: ${results.successful} successful, ${results.failed} failed`);
      }

      if (onCycleComplete) {
        onCycleComplete(results);
      }
    } catch (error) {
      console.error('[FB Scheduler] Cycle error:', error.message);
    }
  };

  // Run immediately
  runCycle();

  // Then run on interval
  const intervalId = setInterval(runCycle, intervalMinutes * 60 * 1000);

  return {
    stop: () => {
      clearInterval(intervalId);
      console.log('[FB Scheduler] Daemon stopped');
    }
  };
}

/**
 * Fetch insights/analytics for a Facebook post
 * @param {string} facebookPostId - The Facebook post ID
 * @returns {Promise<Object>} Post insights data
 */
async function getPostInsights(facebookPostId) {
  if (!FB_PAGE_ACCESS_TOKEN) {
    throw new Error('Facebook credentials not configured');
  }

  if (!facebookPostId) {
    throw new Error('Facebook post ID is required');
  }

  const API_VERSION = 'v21.0';

  // Helper to make a Graph API GET request and parse JSON
  function fbGet(url) {
    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      }).on('error', reject);
    });
  }

  // Helper to parse a Graph API result into our insights format
  function parseInsightsResult(result) {
    const insights = {
      postId: result.id,
      message: result.message,
      createdTime: result.created_time,
      permalinkUrl: result.permalink_url,
      likes: result.likes?.summary?.total_count || 0,
      comments: result.comments?.summary?.total_count || 0,
      shares: result.shares?.count || 0,
      impressions: 0,
      reach: 0,
      engagedUsers: 0,
      clicks: 0
    };

    // Parse insights data if available
    if (result.insights?.data) {
      for (const metric of result.insights.data) {
        const value = metric.values?.[0]?.value || 0;
        switch (metric.name) {
          case 'post_impressions':
            insights.impressions = value;
            break;
          case 'post_impressions_unique':
            insights.reach = value;
            break;
          case 'post_engaged_users':
            insights.engagedUsers = value;
            break;
          case 'post_clicks':
          case 'post_clicks_by_type':
            // post_clicks_by_type returns an object; sum its values
            if (typeof value === 'object' && value !== null) {
              insights.clicks = Object.values(value).reduce((a, b) => a + b, 0);
            } else {
              insights.clicks = value;
            }
            break;
        }
      }
    }

    // Calculate engagement rate
    if (insights.reach > 0) {
      insights.engagementRate = ((insights.likes + insights.comments + insights.shares) / insights.reach * 100).toFixed(2);
    } else {
      insights.engagementRate = '0.00';
    }

    return insights;
  }

  // Strategy 1: Try with full insights metrics
  const insightsFields = [
    'id',
    'message',
    'created_time',
    'permalink_url',
    'shares',
    'likes.summary(true).limit(0)',
    'comments.summary(true).limit(0)',
    'insights.metric(post_impressions,post_impressions_unique,post_engaged_users,post_clicks_by_type)'
  ].join(',');

  const insightsUrl = `https://graph.facebook.com/${API_VERSION}/${facebookPostId}?fields=${encodeURIComponent(insightsFields)}&access_token=${FB_PAGE_ACCESS_TOKEN}`;

  try {
    const result = await fbGet(insightsUrl);

    if (!result.error) {
      return parseInsightsResult(result);
    }

    // If insights metric error (#100), fall back to basic fields only
    if (result.error.code === 100 || (result.error.message && result.error.message.includes('insights metric'))) {
      console.warn('[FB Insights] Insights metrics unavailable, falling back to basic engagement fields. Error:', result.error.message);
    } else {
      // Some other error — still try fallback but log it
      console.error('[FB Insights] API Error (will try fallback):', result.error);
    }
  } catch (e) {
    console.error('[FB Insights] Request error (will try fallback):', e.message);
  }

  // Strategy 2: Fallback — basic engagement fields only (no insights subquery)
  const basicFields = [
    'id',
    'message',
    'created_time',
    'permalink_url',
    'shares',
    'likes.summary(true).limit(0)',
    'comments.summary(true).limit(0)'
  ].join(',');

  const basicUrl = `https://graph.facebook.com/${API_VERSION}/${facebookPostId}?fields=${encodeURIComponent(basicFields)}&access_token=${FB_PAGE_ACCESS_TOKEN}`;

  const basicResult = await fbGet(basicUrl);

  if (basicResult.error) {
    console.error('[FB Insights] Fallback also failed:', basicResult.error);
    throw new Error(basicResult.error.message);
  }

  const insights = parseInsightsResult(basicResult);
  insights._fallback = true; // Flag that we only got basic data
  console.log(`[FB Insights] Got basic engagement for ${facebookPostId}: ${insights.likes} likes, ${insights.comments} comments, ${insights.shares} shares`);
  return insights;
}

/**
 * Fetch insights for multiple Facebook posts
 * @param {string[]} facebookPostIds - Array of Facebook post IDs
 * @returns {Promise<Object[]>} Array of post insights
 */
async function getBulkPostInsights(facebookPostIds) {
  if (!facebookPostIds || facebookPostIds.length === 0) {
    return [];
  }

  const results = [];

  // Process in batches to avoid rate limits
  for (const postId of facebookPostIds) {
    try {
      const insights = await getPostInsights(postId);
      results.push({ success: true, ...insights });
    } catch (error) {
      results.push({
        success: false,
        postId,
        error: error.message
      });
    }

    // Small delay between requests to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  return results;
}

/**
 * Schedule Multiboard posts using pillar-based weekly rotation
 *
 * Weekly schedule:
 *   Monday:    Awareness (educational explainer)
 *   Wednesday: Consideration (use-case, room rotates weekly)
 *   Friday:    Conversion (product with price)
 *   Sunday:    Trust (behind the scenes / print process)
 *
 * Room rotation: kitchen → garage → craft → desk (cycles each week)
 *
 * @param {Object} db - Database instance
 * @param {Object} options - Scheduling options
 * @returns {Array} Created scheduled post entries
 */
function scheduleMultiboardPosts(db, options = {}) {
  const {
    weeksAhead = 4,
    startDate = null
  } = options;

  const ROOMS = ['kitchen', 'garage', 'craft', 'desk'];
  const PILLAR_SCHEDULE = [
    { day: 1, pillar: 'awareness', style: 'showcase' },    // Monday
    { day: 3, pillar: 'consideration', style: 'lifestyle' }, // Wednesday
    { day: 5, pillar: 'conversion', style: 'urgency' },     // Friday
    { day: 0, pillar: 'trust', style: 'quality' }           // Sunday
  ];

  // Determine base week offset from existing scheduled multiboard posts
  let weekOffset = 0;
  try {
    const existingPosts = db.listScheduledPosts ? db.listScheduledPosts() : [];
    const mbPosts = existingPosts.filter(p => p.campaignType === 'multiboard');
    weekOffset = Math.floor(mbPosts.length / PILLAR_SCHEDULE.length) % ROOMS.length;
  } catch (e) {
    // Start from 0 if we can't check
  }

  const start = startDate ? new Date(startDate) : new Date();
  const created = [];

  for (let week = 0; week < weeksAhead; week++) {
    const currentRoom = ROOMS[(weekOffset + week) % ROOMS.length];

    for (const schedule of PILLAR_SCHEDULE) {
      // Find next occurrence of this day of week
      const postDate = new Date(start);
      postDate.setDate(postDate.getDate() + (week * 7));
      // Adjust to the correct day of week
      const currentDay = postDate.getDay();
      let daysUntil = schedule.day - currentDay;
      if (daysUntil < 0) daysUntil += 7;
      postDate.setDate(postDate.getDate() + daysUntil);

      // Set posting time to 10:00 AM ET
      postDate.setHours(10, 0, 0, 0);

      // Don't schedule in the past
      if (postDate <= new Date()) continue;

      const postData = {
        campaignSlug: 'multiboard',
        campaignType: 'multiboard',
        productName: `Multiboard ${schedule.pillar} - ${currentRoom}`,
        productUid: `multiboard-${schedule.pillar}-${currentRoom}-${week}`,
        scheduledAt: postDate.toISOString(),
        postText: '', // Will be generated at posting time
        postHashtags: '',
        aiStyle: schedule.style,
        generateAiOnPost: 1,
        room: currentRoom,
        status: 'pending'
      };

      try {
        if (db.createScheduledPost) {
          const post = db.createScheduledPost(postData);
          created.push(post);
          console.log(`[MB Scheduler] Scheduled ${schedule.pillar} post for ${postDate.toDateString()} (${currentRoom})`);
        }
      } catch (e) {
        console.error(`[MB Scheduler] Failed to schedule ${schedule.pillar} post:`, e.message);
      }
    }
  }

  console.log(`[MB Scheduler] Scheduled ${created.length} multiboard posts over ${weeksAhead} weeks`);
  return created;
}

// ============================================================================
// VIDEO / REEL PUBLISHING — Facebook + Instagram
// ============================================================================

/**
 * Publish a video to a Facebook Page as a Reel/video post.
 * Uses the Graph API v21.0 /{page-id}/videos endpoint with file_url
 * (the video must be publicly accessible).
 *
 * @param {string} publicVideoUrl - Publicly accessible URL to the .mp4
 * @param {string} description   - Caption with hashtags, URLs, etc.
 * @param {string} category      - Product category (for credential routing)
 * @returns {Promise<{success: boolean, videoId: string, postId: string}>}
 */
async function publishVideoToFacebook(publicVideoUrl, description, category = '') {
  const creds = getFacebookCredentials(category);
  if (!creds.accessToken || !creds.pageId) {
    throw new Error('Facebook credentials not configured');
  }

  console.log(`[Facebook] Publishing video reel to ${creds.pageName} (${creds.pageId})...`);

  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      file_url: publicVideoUrl,
      description: description,
      access_token: creds.accessToken
    });

    const req = https.request({
      hostname: 'graph-video.facebook.com',
      path: `/v21.0/${creds.pageId}/videos`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.error) {
            console.error('[Facebook] Video publish error:', result.error.message);
            reject(new Error(result.error.message));
          } else {
            console.log(`[Facebook] Video published: id=${result.id}`);
            resolve({
              success: true,
              videoId: result.id,
              postId: result.post_id || result.id,
              page: creds.pageName
            });
          }
        } catch (e) {
          reject(new Error(`Failed to parse response: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/**
 * Publish a video as an Instagram Reel.
 * Uses the two-step container flow:
 *   1. POST /{ig-user-id}/media with media_type=REELS + video_url
 *   2. Poll until container status is FINISHED
 *   3. POST /{ig-user-id}/media_publish with creation_id
 *
 * @param {string} publicVideoUrl - Publicly accessible URL to the .mp4
 * @param {string} caption        - Full caption text
 * @returns {Promise<{success: boolean, igPostId: string}>}
 */
async function publishReelToInstagram(publicVideoUrl, caption) {
  if (!INSTAGRAM_BUSINESS_ACCOUNT_ID) {
    return { success: false, skipped: true, reason: 'INSTAGRAM_BUSINESS_ACCOUNT_ID not configured' };
  }
  const accessToken = FB_PAGE_ACCESS_TOKEN;
  if (!accessToken) {
    throw new Error('No FB_PAGE_ACCESS_TOKEN for Instagram publishing');
  }

  console.log(`[Instagram] Publishing reel to IG account ${INSTAGRAM_BUSINESS_ACCOUNT_ID}...`);

  // Step 1: Create media container
  const containerId = await new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      media_type: 'REELS',
      video_url: publicVideoUrl,
      caption: caption,
      access_token: accessToken
    });
    const req = https.request({
      hostname: 'graph.facebook.com',
      path: `/v21.0/${INSTAGRAM_BUSINESS_ACCOUNT_ID}/media`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(data);
          if (r.error) reject(new Error(r.error.message));
          else resolve(r.id);
        } catch (e) { reject(new Error('Parse failed: ' + data.substring(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });

  console.log(`[Instagram] Reel container created: ${containerId}, polling...`);

  // Step 2: Poll until FINISHED (up to 2 min)
  for (let attempt = 0; attempt < 24; attempt++) {
    await new Promise(r => setTimeout(r, 5000));
    const status = await new Promise((resolve, reject) => {
      const url = `https://graph.facebook.com/v21.0/${containerId}?fields=status_code,status&access_token=${accessToken}`;
      https.get(url, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
        });
      }).on('error', reject);
    });

    if (status.status_code === 'FINISHED') break;
    if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') {
      throw new Error(`IG container ${status.status_code}: ${status.status || 'unknown'}`);
    }
    console.log(`[Instagram] Container status: ${status.status_code} (attempt ${attempt + 1})`);
  }

  // Step 3: Publish
  const igPostId = await new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      creation_id: containerId,
      access_token: accessToken
    });
    const req = https.request({
      hostname: 'graph.facebook.com',
      path: `/v21.0/${INSTAGRAM_BUSINESS_ACCOUNT_ID}/media_publish`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(data);
          if (r.error) reject(new Error(r.error.message));
          else resolve(r.id);
        } catch (e) { reject(new Error('Parse failed: ' + data.substring(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });

  console.log(`[Instagram] Reel published: ${igPostId}`);
  return { success: true, igPostId };
}

module.exports = {
  generateMockupForPost,
  postToFacebook,
  publishToInstagram,
  publishVideoToFacebook,
  publishReelToInstagram,
  postFirstComment,
  processScheduledPost,
  processPendingPosts,
  schedulePostsForCampaign,
  scheduleMultiboardPosts,
  startSchedulerDaemon,
  getPostInsights,
  getBulkPostInsights,
  GENERATED_MOCKUPS_DIR
};
