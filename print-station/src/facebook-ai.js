/**
 * Facebook Marketing AI - Print Station Integration
 *
 * Uses Claude to analyze campaign images and generate:
 * - Precise audience targeting
 * - High-converting ad copy
 * - Budget recommendations
 * - Facebook Ads API JSON
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const sharp = require('sharp');
const { Anthropic } = require('@anthropic-ai/sdk');

// Load environment from multiple possible locations (including packaged app)
const possibleEnvPaths = [
  path.resolve(__dirname, '..', '..', '.env'),           // Development: /print-station/src/../../.env
  path.resolve(__dirname, '..', '.env'),                 // Development: /print-station/src/../.env
  path.resolve(process.cwd(), '.env'),                   // Current working directory
  path.resolve(process.cwd(), '..', '.env'),             // Parent of cwd
  process.resourcesPath ? path.join(process.resourcesPath, '.env') : null,  // Packaged Electron app
  process.resourcesPath ? path.join(process.resourcesPath, '..', '.env') : null,  // Next to packaged app
  'g:\\Vinyl Stuff\\.env',                               // Absolute fallback (Windows)
  '/Volumes/New Volume 2/Vinyl Stuff/.env'               // Absolute fallback (Mac)
].filter(Boolean);

for (const envPath of possibleEnvPaths) {
  if (fs.existsSync(envPath)) {
    require('dotenv').config({ path: envPath });
    console.log('[Facebook AI] Loaded .env from:', envPath);
    break;
  }
}

const CLAUDE_MODEL = (process.env.CLAUDE_MODEL || 'claude-3-5-sonnet-20240620').trim();

function cleanKey(value) {
  if (!value) return '';
  let trimmed = String(value).trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    trimmed = trimmed.slice(1, -1);
  }
  return trimmed;
}

const ANTHROPIC_API_KEY = cleanKey(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || '');
const anthropicClient = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

/**
 * Call Claude API
 */
async function callClaude(messages, systemPrompt, maxTokens = 2048) {
  if (!anthropicClient) {
    throw new Error('Anthropic API key not configured. Add ANTHROPIC_API_KEY to .env file.');
  }

  const result = await anthropicClient.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    temperature: 0.7,
    system: systemPrompt,
    messages: messages
  });

  return result.content[0].text.trim();
}

/**
 * Download image from URL
 */
async function downloadImage(url) {
  return new Promise((resolve, reject) => {
    // Simply replace spaces with %20 - don't over-encode
    const encodedUrl = url.replace(/ /g, '%20');

    const client = url.startsWith('https:') ? https : http;

    const makeRequest = (requestUrl) => {
      client.get(requestUrl, (response) => {
        // Handle redirects
        if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 307 || response.statusCode === 308) {
          if (response.headers.location) {
            makeRequest(response.headers.location);
            return;
          }
        }

        if (response.statusCode !== 200) {
          reject(new Error(`Failed to download image: ${response.statusCode} ${response.statusMessage}`));
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

  // Check if it's a URL or local path
  if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
    imageBuffer = await downloadImage(imagePath);
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
 * Generate Facebook Ads for a campaign
 * @param {Object} campaign - Campaign data with title, items, etc.
 * @param {string} imagePath - Path to campaign mockup image
 * @param {number} budget - Daily budget in dollars
 * @returns {Object} Complete Facebook Ads campaign configuration
 */
async function generateCampaignAds(campaign, imagePath, budget = 20) {
  const base64Image = await prepareImage(imagePath);

  // Calculate average price from campaign items
  const avgPrice = campaign.items && campaign.items.length > 0
    ? campaign.items.reduce((sum, item) => sum + (item.price || 0), 0) / campaign.items.length
    : 15;

  const systemPrompt = `You are a Facebook Ads expert specializing in e-commerce campaigns for custom vinyl decals and apparel.
Analyze the campaign image and generate a complete Facebook Ads strategy.
Output as valid JSON only - no markdown, no explanation.`;

  const messages = [
    {
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/jpeg',
            data: base64Image
          }
        },
        {
          type: 'text',
          text: `Campaign: ${campaign.title || 'Untitled Campaign'}
Subtitle: ${campaign.subtitle || ''}
Average Price: $${avgPrice.toFixed(2)}
Budget: $${budget}/day
Number of Products: ${campaign.items?.length || 0}

Generate a Facebook Ads campaign as JSON:

{
  "targeting": {
    "demographics": {
      "age_min": <18-65>,
      "age_max": <18-65>,
      "genders": ["all" | "male" | "female"],
      "description": "<why these demographics>"
    },
    "interests": [
      "<Facebook interest 1>",
      "<Facebook interest 2>",
      ...up to 15 specific interests
    ],
    "behaviors": [
      "<behavior 1>",
      "<behavior 2>"
    ],
    "locations": {
      "countries": ["US"],
      "description": "<targeting rationale>"
    },
    "psychographics": {
      "lifestyle": "<typical customer lifestyle>",
      "values": ["<value 1>", "<value 2>"],
      "painPoints": ["<pain 1>", "<pain 2>"]
    }
  },
  "creative": {
    "headlines": [
      "<headline 1 - direct benefit>",
      "<headline 2 - curiosity>",
      "<headline 3 - social proof>",
      "<headline 4 - urgency>",
      "<headline 5 - question>"
    ],
    "primaryText": [
      {
        "version": "short",
        "text": "<90 chars for Stories>",
        "hook": "<first 3 words>"
      },
      {
        "version": "medium",
        "text": "<125 chars for News Feed>",
        "hook": "<first 3 words>"
      },
      {
        "version": "long",
        "text": "<250 chars detailed>",
        "hook": "<first 3 words>"
      }
    ],
    "descriptions": [
      "<description 1 - features>",
      "<description 2 - benefits>",
      "<description 3 - emotional>"
    ],
    "callsToAction": [
      {
        "text": "Shop Now",
        "type": "SHOP_NOW",
        "rationale": "<why>"
      },
      {
        "text": "Learn More",
        "type": "LEARN_MORE",
        "rationale": "<why>"
      }
    ]
  },
  "budget": {
    "dailyBudget": ${budget},
    "lifetimeBudget": ${budget * 30},
    "bidStrategy": "LOWEST_COST_WITH_BID_CAP" | "LOWEST_COST",
    "bidCap": <number or null>,
    "expectedMetrics": {
      "estimatedReach": <number>,
      "estimatedClicks": <number>,
      "estimatedCPC": <number>,
      "estimatedCTR": "<percentage>",
      "estimatedConversions": <number>,
      "targetROAS": <number>
    },
    "reasoning": "<budget strategy explanation>"
  },
  "recommendations": [
    "<recommendation 1>",
    "<recommendation 2>",
    "<recommendation 3>"
  ]
}`
        }
      ]
    }
  ];

  const response = await callClaude(messages, systemPrompt, 2500);

  // Extract JSON from response
  let jsonStr = response;
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    jsonStr = jsonMatch[0];
  }

  const aiResult = JSON.parse(jsonStr);

  // Build complete campaign response
  return {
    meta: {
      campaignTitle: campaign.title || 'Untitled Campaign',
      generatedAt: new Date().toISOString(),
      model: CLAUDE_MODEL,
      budget: budget
    },
    targeting: aiResult.targeting,
    creative: aiResult.creative,
    budget: aiResult.budget,
    recommendations: aiResult.recommendations || [],
    facebookAdsAPI: {
      campaign: {
        name: `${campaign.title || 'Campaign'} - Sales`,
        objective: 'OUTCOME_SALES',
        status: 'PAUSED',
        special_ad_categories: []
      },
      adSet: {
        name: `${campaign.title || 'Campaign'} - Cold Audience`,
        optimization_goal: 'OFFSITE_CONVERSIONS',
        billing_event: 'IMPRESSIONS',
        bid_amount: aiResult.budget?.bidCap || null,
        daily_budget: Math.round((aiResult.budget?.dailyBudget || budget) * 100),
        targeting: {
          geo_locations: {
            countries: aiResult.targeting.locations.countries
          },
          age_min: aiResult.targeting.demographics.age_min,
          age_max: aiResult.targeting.demographics.age_max,
          genders: aiResult.targeting.demographics.genders.includes('all') ? [0] :
                   aiResult.targeting.demographics.genders.includes('male') ? [1] : [2],
          interests: aiResult.targeting.interests.slice(0, 10).map(interest => ({ name: interest })),
          behaviors: aiResult.targeting.behaviors.slice(0, 5).map(behavior => ({ name: behavior }))
        },
        status: 'PAUSED'
      },
      ads: aiResult.creative.headlines.slice(0, 3).map((headline, idx) => ({
        name: `${campaign.title || 'Campaign'} - Ad ${idx + 1}`,
        status: 'PAUSED',
        creative: {
          object_story_spec: {
            page_id: '<YOUR_PAGE_ID>',
            link_data: {
              link: '<YOUR_CAMPAIGN_URL>',
              message: aiResult.creative.primaryText[1]?.text || headline,
              name: headline,
              description: aiResult.creative.descriptions[0] || '',
              call_to_action: {
                type: aiResult.creative.callsToAction[0]?.type || 'SHOP_NOW',
                value: {
                  link: '<YOUR_CAMPAIGN_URL>'
                }
              }
            }
          }
        }
      }))
    }
  };
}

/**
 * Generate a Multiboard-specific Facebook Ad campaign
 *
 * @param {Object} campaign - Campaign data with product info
 * @param {string} imagePath - Path to campaign image
 * @param {string} tier - 'awareness' | 'consideration' | 'conversion'
 * @returns {Object} Complete Facebook Ads campaign configuration
 */
async function generateMultiboardAdCampaign(campaign, imagePath, tier = 'awareness') {
  const base64Image = await prepareImage(imagePath);

  const product = campaign.product || {};
  const price = product.price_cents ? `$${(product.price_cents / 100).toFixed(2)}` : (campaign.price || '');
  const room = product.room_use_case || campaign.room || 'general';

  const tierConfigs = {
    awareness: {
      objective: 'REACH',
      budgetMin: 5,
      budgetMax: 10,
      cta: 'LEARN_MORE',
      description: 'Cold audience — introduce Multiboard concept'
    },
    consideration: {
      objective: 'LINK_CLICKS',
      budgetMin: 8,
      budgetMax: 15,
      cta: 'SHOP_NOW',
      description: 'Warm audience — retarget engaged users with room-specific use cases'
    },
    conversion: {
      objective: 'CONVERSIONS',
      budgetMin: 10,
      budgetMax: 20,
      cta: 'SHOP_NOW',
      description: 'Hot audience — retarget product page visitors with specific product + price'
    }
  };

  const config = tierConfigs[tier] || tierConfigs.awareness;

  const systemPrompt = `You are a Facebook Ads expert specializing in home organization and 3D printed products.
You are creating ads for Blue Ridge Custom Co — Authorized Multiboard Reseller.
Multiboard is a modular, snap-together wall organization system. We 3D print it locally in Asheville, NC.
Output as valid JSON only - no markdown, no explanation.`;

  const messages = [
    {
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/jpeg',
            data: base64Image
          }
        },
        {
          type: 'text',
          text: `Campaign: ${campaign.title || product.name || 'Multiboard Wall Organization'}
Product: ${product.name || 'Multiboard System'}
Price: ${price}
Room: ${room}
Tier: ${tier} — ${config.description}
Objective: ${config.objective}
Budget: $${config.budgetMin}-$${config.budgetMax}/day
CTA: ${config.cta}

Generate a Facebook Ads campaign as JSON:

{
  "targeting": {
    "demographics": {
      "age_min": 25,
      "age_max": 55,
      "genders": ["all"],
      "description": "<why these demographics>"
    },
    "interests": [
      "Home improvement",
      "Home organization",
      "DIY projects",
      "3D printing",
      "<add 6-8 more specific interests relevant to ${room} organization>"
    ],
    "behaviors": [
      "Engaged Shoppers",
      "Online Buyers",
      "<add 1-2 more relevant behaviors>"
    ],
    "locations": {
      "countries": ["US"],
      "description": "<targeting rationale>"
    },
    "psychographics": {
      "lifestyle": "<typical customer lifestyle>",
      "values": ["<value 1>", "<value 2>"],
      "painPoints": ["<${room} organization pain point 1>", "<pain point 2>"]
    }
  },
  "creative": {
    "headlines": [
      "<headline 1 - problem/solution for ${room}>",
      "<headline 2 - modular/expandable angle>",
      "<headline 3 - local 3D printed quality>",
      "<headline 4 - ${tier === 'conversion' ? 'price/value' : 'curiosity'}>",
      "<headline 5 - social proof or question>"
    ],
    "primaryText": [
      {
        "version": "short",
        "text": "<90 chars — ${tier} focused>",
        "hook": "<first 3 words>"
      },
      {
        "version": "medium",
        "text": "<125 chars — ${tier} focused>",
        "hook": "<first 3 words>"
      },
      {
        "version": "long",
        "text": "<250 chars — ${tier} focused, ${tier === 'conversion' ? 'include price and what is included' : 'focus on the problem and system'}>",
        "hook": "<first 3 words>"
      }
    ],
    "descriptions": [
      "<description 1 - features>",
      "<description 2 - benefits>",
      "<description 3 - trust/local>"
    ],
    "callsToAction": [
      {
        "text": "${config.cta === 'LEARN_MORE' ? 'Learn More' : 'Shop Now'}",
        "type": "${config.cta}",
        "rationale": "<why this CTA for ${tier} tier>"
      }
    ]
  },
  "budget": {
    "dailyBudget": ${Math.round((config.budgetMin + config.budgetMax) / 2)},
    "bidStrategy": "LOWEST_COST_WITHOUT_CAP"
  },
  "adSet": {
    "name": "Multiboard ${tier.charAt(0).toUpperCase() + tier.slice(1)} - ${room}",
    "targeting": {},
    "daily_budget": ${Math.round((config.budgetMin + config.budgetMax) / 2) * 100},
    "billing_event": "IMPRESSIONS",
    "optimization_goal": "${config.objective === 'REACH' ? 'REACH' : config.objective === 'LINK_CLICKS' ? 'LINK_CLICKS' : 'OFFSITE_CONVERSIONS'}",
    "status": "PAUSED"
  },
  "ads": [
    {
      "name": "Multiboard ${tier} - ${room} - V1",
      "status": "PAUSED",
      "creative": {
        "object_story_spec": {
          "page_id": "<PAGE_ID>",
          "link_data": {
            "message": "<primary text>",
            "link": "<CAMPAIGN_URL>",
            "name": "<headline>",
            "description": "<description>",
            "call_to_action": {
              "type": "${config.cta}",
              "value": { "link": "<CAMPAIGN_URL>" }
            }
          }
        }
      }
    }
  ]
}

IMPORTANT for ${tier} tier:
${tier === 'awareness' ? '- Focus on education: what IS Multiboard, why wall tiles matter\n- Broad targeting, low budget, Learn More CTA' : ''}
${tier === 'consideration' ? '- Focus on specific room use cases and transformations\n- Retarget engaged users, medium budget, Shop Now CTA' : ''}
${tier === 'conversion' ? '- Focus on specific product, include price and what\'s included\n- Retarget product page visitors, higher budget, Shop Now CTA' : ''}`
        }
      ]
    }
  ];

  const response = await anthropicClient.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 2000,
    system: systemPrompt,
    messages
  });

  const responseText = response.content[0].text;
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Failed to parse Multiboard ad campaign response');
  }

  const result = JSON.parse(jsonMatch[0]);

  return {
    ...result,
    tier,
    room,
    product: product.name || campaign.title,
    generatedAt: new Date().toISOString()
  };
}

/**
 * Check if Facebook AI is configured
 */
function isConfigured() {
  return Boolean(ANTHROPIC_API_KEY);
}

module.exports = {
  generateCampaignAds,
  generateMultiboardAdCampaign,
  isConfigured
};
