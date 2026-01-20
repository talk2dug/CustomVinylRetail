/**
 * Copy Generator Module - AI-Powered Ad Copy for Campaigns
 *
 * Generates high-converting marketing copy for campaigns/collections:
 * - Headlines (attention, benefit, urgency, curiosity, social proof)
 * - Body copy (short/medium/long formats)
 * - Product descriptions (feature/benefit/emotional)
 * - Email subject lines
 * - Social media posts
 * - Ad angles for A/B testing
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const sharp = require('sharp');
const { Anthropic } = require('@anthropic-ai/sdk');

// Load environment from multiple possible locations
const possibleEnvPaths = [
  path.resolve(__dirname, '..', '..', '.env'),
  path.resolve(__dirname, '..', '.env'),
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '..', '.env'),
  process.resourcesPath ? path.join(process.resourcesPath, '.env') : null,
  process.resourcesPath ? path.join(process.resourcesPath, '..', '.env') : null,
  'g:\\Vinyl Stuff\\.env',
  '/Volumes/New Volume 2/Vinyl Stuff/.env'
].filter(Boolean);

let envLoaded = false;
for (const envPath of possibleEnvPaths) {
  if (fs.existsSync(envPath)) {
    require('dotenv').config({ path: envPath });
    console.log('[Copy Generator] Loaded .env from:', envPath);
    envLoaded = true;
    break;
  }
}

if (!envLoaded) {
  console.warn('[Copy Generator] No .env file found');
}

function cleanKey(value) {
  if (!value) return '';
  let trimmed = String(value).trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    trimmed = trimmed.slice(1, -1);
  }
  return trimmed;
}

const CLAUDE_MODEL = cleanKey(process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514');
const ANTHROPIC_API_KEY = cleanKey(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || '');
const anthropicClient = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

console.log('[Copy Generator] Config:', {
  hasApiKey: ANTHROPIC_API_KEY ? 'Yes' : 'No',
  model: CLAUDE_MODEL
});

/**
 * Download image from URL
 */
async function downloadImage(url) {
  return new Promise((resolve, reject) => {
    const encodedUrl = url.replace(/ /g, '%20');
    const client = url.startsWith('https:') ? https : http;

    const makeRequest = (requestUrl) => {
      client.get(requestUrl, (response) => {
        if ([301, 302, 307, 308].includes(response.statusCode) && response.headers.location) {
          makeRequest(response.headers.location);
          return;
        }
        if (response.statusCode !== 200) {
          reject(new Error(`Failed to download: ${response.statusCode}`));
          return;
        }
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks)));
        response.on('error', reject);
      }).on('error', reject);
    };
    makeRequest(encodedUrl);
  });
}

/**
 * Prepare image for Claude vision
 */
async function prepareImage(imagePath) {
  let imageBuffer;

  if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
    imageBuffer = await downloadImage(imagePath);
  } else if (imagePath.startsWith('/')) {
    const serverUrl = process.env.ASSET_BASE_URL || 'https://blueridgecustomco.com';
    imageBuffer = await downloadImage(serverUrl + imagePath);
  } else if (fs.existsSync(imagePath)) {
    imageBuffer = fs.readFileSync(imagePath);
  } else {
    throw new Error(`Image not found: ${imagePath}`);
  }

  const resized = await sharp(imageBuffer)
    .resize({ width: 1024, height: 1024, fit: 'inside' })
    .jpeg({ quality: 85 })
    .toBuffer();

  return resized.toString('base64');
}

/**
 * Call Claude API with retry
 */
async function callClaude(messages, systemPrompt, maxTokens = 2048) {
  if (!anthropicClient) {
    throw new Error('ANTHROPIC_API_KEY not configured. Add it to .env file.');
  }

  const result = await anthropicClient.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    temperature: 0.8,
    system: systemPrompt,
    messages
  });

  return result.content[0].text.trim();
}

/**
 * Generate comprehensive ad copy for a campaign
 *
 * @param {Object} campaign - Campaign/collection data
 * @param {Object} options - Generation options
 * @returns {Object} Complete copy package
 */
async function generateCampaignCopy(campaign, options = {}) {
  const {
    imagePath = null,
    platform = 'all', // 'facebook', 'email', 'shopify', 'all'
    tone = 'casual', // 'casual', 'professional', 'urgent', 'playful'
    targetAudience = null,
    pricePoint = null
  } = options;

  // Build campaign context
  const campaignContext = buildCampaignContext(campaign, pricePoint);

  // Prepare image if provided
  let imageContent = null;
  if (imagePath) {
    try {
      const base64Image = await prepareImage(imagePath);
      imageContent = {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: base64Image
        }
      };
    } catch (err) {
      console.warn('[Copy Generator] Could not load image:', err.message);
    }
  }

  const systemPrompt = `You are an elite e-commerce copywriter specializing in custom vinyl decals, stickers, and apparel.
Your copy is:
- Benefit-focused, not feature-focused
- Emotionally resonant and authentic
- Optimized for the specific platform
- Action-oriented with clear CTAs
- Free of corporate jargon and clichés

Brand voice: ${tone === 'casual' ? 'Friendly, relatable, like a cool friend recommending something' :
              tone === 'professional' ? 'Confident, trustworthy, quality-focused' :
              tone === 'urgent' ? 'Energetic, time-sensitive, exciting' :
              'Fun, witty, personality-driven'}

Output ONLY valid JSON - no markdown, no explanation, no code blocks.`;

  const userPrompt = `Create comprehensive marketing copy for this campaign:

${campaignContext}

${targetAudience ? `Target Audience: ${targetAudience}` : ''}

Generate copy for ${platform === 'all' ? 'all platforms' : platform} as JSON:

{
  "headlines": {
    "attention": ["<scroll-stopping headline 1>", "<scroll-stopping headline 2>", "<scroll-stopping headline 3>"],
    "benefit": ["<benefit-focused headline 1>", "<benefit-focused headline 2>", "<benefit-focused headline 3>"],
    "curiosity": ["<curiosity-driven headline 1>", "<curiosity-driven headline 2>"],
    "urgency": ["<urgency headline 1>", "<urgency headline 2>"],
    "socialProof": ["<social proof headline 1>", "<social proof headline 2>"]
  },
  "bodyText": {
    "short": {
      "text": "<90 chars - Stories/Reels>",
      "hook": "<first 3-5 attention-grabbing words>"
    },
    "medium": {
      "text": "<150 chars - News Feed/Ads>",
      "hook": "<first 3-5 words>"
    },
    "long": {
      "text": "<300 chars - detailed description>",
      "hook": "<first 3-5 words>"
    }
  },
  "productDescriptions": {
    "feature": "<50-80 word description focused on what the product IS>",
    "benefit": "<50-80 word description focused on what it DOES for the customer>",
    "emotional": "<50-80 word description focused on how it makes them FEEL>",
    "seo": "<100-150 word SEO-optimized product description with keywords>"
  },
  "emailSubjectLines": [
    {"subject": "<subject line 1>", "preheader": "<preview text>", "angle": "<strategy>"},
    {"subject": "<subject line 2>", "preheader": "<preview text>", "angle": "<strategy>"},
    {"subject": "<subject line 3>", "preheader": "<preview text>", "angle": "<strategy>"},
    {"subject": "<subject line 4>", "preheader": "<preview text>", "angle": "<strategy>"},
    {"subject": "<subject line 5>", "preheader": "<preview text>", "angle": "<strategy>"}
  ],
  "socialPosts": {
    "facebook": {
      "post": "<engaging FB post with emojis, 2-4 sentences>",
      "hashtags": ["#tag1", "#tag2", "#tag3", "#tag4", "#tag5"]
    },
    "instagram": {
      "caption": "<IG caption with personality, emojis, line breaks>",
      "hashtags": ["#tag1", "#tag2", "...up to 10 relevant hashtags"]
    },
    "twitter": {
      "tweet": "<280 char max tweet>",
      "hashtags": ["#tag1", "#tag2"]
    }
  },
  "adAngles": [
    {
      "name": "Problem/Solution",
      "headline": "<headline>",
      "body": "<ad body text>",
      "cta": "<call to action>",
      "targetEmotion": "<primary emotion>"
    },
    {
      "name": "Social Proof",
      "headline": "<headline>",
      "body": "<ad body text>",
      "cta": "<call to action>",
      "targetEmotion": "<primary emotion>"
    },
    {
      "name": "Lifestyle/Identity",
      "headline": "<headline>",
      "body": "<ad body text>",
      "cta": "<call to action>",
      "targetEmotion": "<primary emotion>"
    },
    {
      "name": "Urgency/Scarcity",
      "headline": "<headline>",
      "body": "<ad body text>",
      "cta": "<call to action>",
      "targetEmotion": "<primary emotion>"
    },
    {
      "name": "Value Stack",
      "headline": "<headline>",
      "body": "<ad body text>",
      "cta": "<call to action>",
      "targetEmotion": "<primary emotion>"
    }
  ],
  "callsToAction": [
    {"primary": "<main CTA>", "context": "<when to use>"},
    {"primary": "<secondary CTA>", "context": "<when to use>"},
    {"primary": "<soft CTA>", "context": "<when to use>"}
  ],
  "taglines": [
    "<catchy tagline 1>",
    "<catchy tagline 2>",
    "<catchy tagline 3>"
  ],
  "audienceInsights": {
    "primaryAudience": "<who this appeals to most>",
    "secondaryAudience": "<secondary audience>",
    "painPoints": ["<pain 1>", "<pain 2>", "<pain 3>"],
    "desires": ["<desire 1>", "<desire 2>", "<desire 3>"],
    "objections": ["<objection 1>", "<objection 2>"],
    "objectionsHandled": ["<how to overcome objection 1>", "<how to overcome objection 2>"]
  }
}`;

  const messageContent = imageContent
    ? [imageContent, { type: 'text', text: userPrompt }]
    : [{ type: 'text', text: userPrompt }];

  const response = await callClaude(
    [{ role: 'user', content: messageContent }],
    systemPrompt,
    4000
  );

  // Extract JSON from response
  let jsonStr = response;
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    jsonStr = jsonMatch[0];
  }

  const copyResult = JSON.parse(jsonStr);

  return {
    meta: {
      campaignTitle: campaign.title || campaign.name || 'Untitled',
      generatedAt: new Date().toISOString(),
      platform,
      tone,
      model: CLAUDE_MODEL
    },
    ...copyResult
  };
}

/**
 * Generate quick headlines only
 */
async function generateHeadlines(campaign, count = 10, options = {}) {
  const { style = 'mixed', imagePath = null } = options;
  const campaignContext = buildCampaignContext(campaign);

  let imageContent = null;
  if (imagePath) {
    try {
      const base64Image = await prepareImage(imagePath);
      imageContent = {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: base64Image
        }
      };
    } catch (err) {
      console.warn('[Copy Generator] Could not load image:', err.message);
    }
  }

  const systemPrompt = `You are an expert headline writer. Create scroll-stopping, click-worthy headlines.
Output ONLY valid JSON array - no markdown, no explanation.`;

  const styleGuide = {
    mixed: 'Mix of attention-grabbing, benefit-focused, curiosity-driven, and urgency headlines',
    attention: 'Bold, pattern-interrupt headlines that stop the scroll',
    benefit: 'Headlines focused on what the customer gains',
    curiosity: 'Headlines that create an open loop or curiosity gap',
    urgency: 'Headlines with time pressure or scarcity'
  };

  const userPrompt = `Create ${count} headlines for:

${campaignContext}

Style: ${styleGuide[style] || styleGuide.mixed}

Output as JSON array:
[
  {"headline": "<headline text>", "type": "<attention|benefit|curiosity|urgency|socialProof>", "hook": "<first 3 words>"},
  ...
]`;

  const messageContent = imageContent
    ? [imageContent, { type: 'text', text: userPrompt }]
    : [{ type: 'text', text: userPrompt }];

  const response = await callClaude(
    [{ role: 'user', content: messageContent }],
    systemPrompt,
    1500
  );

  const jsonMatch = response.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error('Failed to parse headlines response');
  }

  return JSON.parse(jsonMatch[0]);
}

/**
 * Generate product description
 */
async function generateProductDescription(product, options = {}) {
  const { style = 'benefit', length = 'medium', imagePath = null } = options;

  let imageContent = null;
  if (imagePath) {
    try {
      const base64Image = await prepareImage(imagePath);
      imageContent = {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: base64Image
        }
      };
    } catch (err) {
      console.warn('[Copy Generator] Could not load image:', err.message);
    }
  }

  const lengthGuide = {
    short: '30-50 words',
    medium: '60-100 words',
    long: '120-180 words'
  };

  const styleGuide = {
    feature: 'Focus on product specifications, materials, and what it is',
    benefit: 'Focus on what the product does for the customer and how it improves their life',
    emotional: 'Focus on feelings, identity, and emotional connection',
    seo: 'SEO-optimized with natural keyword integration'
  };

  const systemPrompt = `You are a product description expert for custom vinyl products and apparel.
Write compelling, conversion-focused descriptions.
Output ONLY the description text - no JSON, no markdown.`;

  const productInfo = `
Product: ${product.title || product.name || 'Custom Product'}
Type: ${product.productType || product.product_type || 'vinyl decal'}
${product.price ? `Price: $${product.price}` : ''}
${product.tags ? `Tags: ${product.tags}` : ''}
${product.description ? `Current Description: ${product.description}` : ''}
`;

  const userPrompt = `Write a ${lengthGuide[length]} product description.

${productInfo}

Style: ${styleGuide[style]}

Requirements:
- No generic phrases like "high quality" or "premium materials"
- Speak directly to the customer using "you" and "your"
- Include a soft call to action
- Make it scannable with short sentences`;

  const messageContent = imageContent
    ? [imageContent, { type: 'text', text: userPrompt }]
    : [{ type: 'text', text: userPrompt }];

  const response = await callClaude(
    [{ role: 'user', content: messageContent }],
    systemPrompt,
    500
  );

  return {
    description: response,
    style,
    length,
    generatedAt: new Date().toISOString()
  };
}

/**
 * Generate email subject lines
 */
async function generateEmailSubjects(campaign, count = 10, options = {}) {
  const { angle = 'mixed' } = options;
  const campaignContext = buildCampaignContext(campaign);

  const systemPrompt = `You are an email marketing expert with high open rates.
Create subject lines that get opened without being spammy.
Output ONLY valid JSON array - no markdown.`;

  const angleGuide = {
    mixed: 'Various angles including curiosity, benefit, urgency, personalization, and social proof',
    curiosity: 'Open loops and curiosity gaps that demand to be clicked',
    benefit: 'Clear value proposition and what they\'ll gain',
    urgency: 'Time-sensitive language and scarcity',
    personal: 'Personalization and direct address'
  };

  const userPrompt = `Create ${count} email subject lines for:

${campaignContext}

Angle: ${angleGuide[angle] || angleGuide.mixed}

Output as JSON array:
[
  {
    "subject": "<subject line - 50 chars max>",
    "preheader": "<preview text - 80 chars max>",
    "angle": "<curiosity|benefit|urgency|personal|social>",
    "openRateEstimate": "<low|medium|high>"
  },
  ...
]`;

  const response = await callClaude(
    [{ role: 'user', content: [{ type: 'text', text: userPrompt }] }],
    systemPrompt,
    2000
  );

  const jsonMatch = response.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error('Failed to parse email subjects response');
  }

  return JSON.parse(jsonMatch[0]);
}

/**
 * Generate A/B test variations
 */
async function generateABTestVariations(originalCopy, element = 'headline', count = 3) {
  const systemPrompt = `You are an A/B testing expert. Create variations that test different psychological triggers.
Output ONLY valid JSON array - no markdown.`;

  const userPrompt = `Create ${count} A/B test variations for this ${element}:

Original: "${originalCopy}"

Each variation should test a different:
- Emotional trigger
- Value proposition angle
- Word choice/framing

Output as JSON array:
[
  {
    "variation": "<new copy>",
    "hypothesis": "<what we're testing>",
    "trigger": "<psychological trigger being tested>",
    "expectedLift": "<estimated improvement %>"
  },
  ...
]`;

  const response = await callClaude(
    [{ role: 'user', content: [{ type: 'text', text: userPrompt }] }],
    systemPrompt,
    1500
  );

  const jsonMatch = response.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error('Failed to parse A/B test response');
  }

  return JSON.parse(jsonMatch[0]);
}

/**
 * Improve existing copy
 */
async function improveCopy(existingCopy, options = {}) {
  const { goal = 'conversion', context = '' } = options;

  const systemPrompt = `You are a copy optimization expert. Improve copy while maintaining the core message.
Output ONLY valid JSON - no markdown.`;

  const goalGuide = {
    conversion: 'Make it more action-oriented and compelling',
    clarity: 'Make it clearer and easier to understand',
    emotional: 'Add more emotional resonance',
    concise: 'Shorten without losing impact',
    seo: 'Optimize for search while keeping it readable'
  };

  const userPrompt = `Improve this copy:

"${existingCopy}"

${context ? `Context: ${context}` : ''}

Goal: ${goalGuide[goal]}

Output as JSON:
{
  "improved": "<improved copy>",
  "changes": ["<change 1>", "<change 2>", "<change 3>"],
  "reasoning": "<why these changes improve the copy>",
  "alternativeVersion": "<a completely different approach>"
}`;

  const response = await callClaude(
    [{ role: 'user', content: [{ type: 'text', text: userPrompt }] }],
    systemPrompt,
    1000
  );

  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Failed to parse improvement response');
  }

  return JSON.parse(jsonMatch[0]);
}

/**
 * Build campaign context string
 */
function buildCampaignContext(campaign, pricePoint = null) {
  const parts = [];

  if (campaign.title || campaign.name) {
    parts.push(`Campaign/Collection: "${campaign.title || campaign.name}"`);
  }
  if (campaign.subtitle) {
    parts.push(`Tagline: "${campaign.subtitle}"`);
  }
  if (campaign.description || campaign.body_html) {
    const desc = (campaign.description || campaign.body_html || '').replace(/<[^>]*>/g, '').trim();
    if (desc) parts.push(`Description: ${desc.substring(0, 200)}`);
  }

  // Product type
  const productType = campaign.productType || campaign.product_type ||
    (campaign.items && campaign.items[0]?.productType) || 'vinyl decal';
  parts.push(`Product Type: ${productType}`);

  // Price info
  if (pricePoint) {
    parts.push(`Price Point: $${pricePoint}`);
  } else if (campaign.items && campaign.items.length > 0) {
    const prices = campaign.items.filter(i => i.price).map(i => i.price);
    if (prices.length > 0) {
      const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
      parts.push(`Average Price: $${avgPrice.toFixed(2)}`);
    }
  }

  // Item count
  if (campaign.items && campaign.items.length > 0) {
    parts.push(`Products in collection: ${campaign.items.length}`);
    // Sample product names
    const sampleNames = campaign.items.slice(0, 5).map(i => i.name || i.title).filter(Boolean);
    if (sampleNames.length > 0) {
      parts.push(`Sample products: ${sampleNames.join(', ')}`);
    }
  }

  // Tags
  if (campaign.tags) {
    parts.push(`Tags: ${campaign.tags}`);
  }

  // Additional context
  if (campaign.salesInitiative) {
    parts.push(`Sales Focus: ${campaign.salesInitiative}`);
  }
  if (campaign.benefits) {
    parts.push(`Key Benefits: ${campaign.benefits}`);
  }
  if (campaign.apparelType) {
    parts.push(`Apparel: ${campaign.apparelBrand || ''} ${campaign.apparelType} in ${campaign.apparelColor || 'various colors'}`);
  }

  return parts.join('\n');
}

/**
 * Check if module is configured
 */
function isConfigured() {
  return Boolean(ANTHROPIC_API_KEY);
}

module.exports = {
  generateCampaignCopy,
  generateHeadlines,
  generateProductDescription,
  generateEmailSubjects,
  generateABTestVariations,
  improveCopy,
  isConfigured
};
