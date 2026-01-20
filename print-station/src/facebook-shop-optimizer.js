/**
 * Facebook Shop Optimizer - Print Station Integration
 *
 * Uses Claude to optimize product listings for Facebook Shop and Marketplace:
 * - Search-optimized titles
 * - Marketplace-friendly descriptions
 * - Category recommendations
 * - SEO keywords
 * - Pricing strategies
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
    console.log('[Facebook Shop Optimizer] Loaded .env from:', envPath);
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
async function callClaude(messages, systemPrompt, maxTokens = 1500) {
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
 * Optimize a single product for Facebook Shop/Marketplace
 * @param {Object} item - Product item with name, image, price, etc.
 * @returns {Object} Optimized product data
 */
async function optimizeProduct(item) {
  if (!item.image) {
    throw new Error('Item image is required');
  }

  const base64Image = await prepareImage(item.image);

  // Detect if this is apparel with a custom design
  const isApparel = item.productType === 'tshirt' || item.productType === 'hoodie' || item.productType === 'apparel' || item.apparel;
  const hasApparelDetails = item.apparel && (item.apparel.name || item.apparel.description);

  const systemPrompt = `You are a Facebook Marketplace and Facebook Shop optimization expert.
Analyze product images and generate optimized listings that:
- Rank well in Marketplace search
- Convert browsers into buyers
- Follow Facebook Commerce best practices
- Use clear, direct language (not overly promotional)
Output as valid JSON only - no markdown, no explanation.`;

  // Build context about what we're actually selling
  let productContext = `Product: ${item.name || 'Unknown Product'}
Current Description: ${item.description || item.autoDescription || 'None'}
Price: $${(item.priceCents || item.price || 0) / 100}
Category: ${item.categorySlug || item.productType || 'Unknown'}`;

  // Add apparel context if applicable
  if (isApparel && hasApparelDetails) {
    productContext += `

IMPORTANT CONTEXT:
- This is APPAREL (${item.apparel.name || item.productType || 'T-Shirt'}) with a custom GRAPHIC/DESIGN
- The image shows the DESIGN/GRAPHIC that will be printed on the apparel
- DO NOT describe this as a sticker, decal, or trading card
- Focus on the APPAREL PRODUCT with this design/graphic on it

Apparel Details:
- Type: ${item.apparel.name || item.productType || 'T-Shirt'}
- Description: ${item.apparel.description || 'Premium quality apparel'}
- Color: ${item.apparel.colorName || item.apparel.color || 'Available in multiple colors'}
- Size: ${item.apparel.size || 'Multiple sizes available'}

The graphic/design shown in the image will be printed on this apparel item.`;
  }

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
          text: `${productContext}

Generate optimized Facebook Shop/Marketplace listing as JSON:

{
  "title": {
    "original": "${item.name || ''}",
    "optimized": "<search-optimized title with keywords, 80 chars max>",
    "reasoning": "<why this title works better>"
  },
  "description": {
    "original": "${item.description || item.autoDescription || ''}",
    "optimized": "<Marketplace-style description with bullets, emojis, clear value props, 500 chars max${isApparel && hasApparelDetails ? '. For apparel items, describe the GARMENT with the graphic/design, not just the design itself. Example: Premium cotton t-shirt featuring [design theme] graphic' : ''}>",
    "reasoning": "<why this description converts better>"
  },
  "category": {
    "current": "${item.categorySlug || item.productType || ''}",
    "recommended": "<Facebook product category>",
    "subcategory": "<more specific subcategory>",
    "reasoning": "<why this category>"
  },
  "keywords": [
    "<keyword 1>",
    "<keyword 2>",
    "<keyword 3>",
    ...10-15 search keywords people use
  ],
  "pricing": {
    "current": ${(item.priceCents || item.price || 0) / 100},
    "recommended": <number>,
    "competitiveRange": { "low": <number>, "high": <number> },
    "reasoning": "<pricing strategy explanation>"
  },
  "marketplaceTips": [
    "<tip 1 for better sales>",
    "<tip 2 for better sales>",
    "<tip 3 for better sales>"
  ],
  "bundleOpportunities": [
    "<suggested bundle 1>",
    "<suggested bundle 2>"
  ],
  "shippingRecommendation": {
    "method": "standard" | "expedited" | "local_pickup",
    "offerLocalPickup": true | false,
    "suggestedShippingCost": <number>,
    "reasoning": "<why this shipping strategy>"
  }
}`
        }
      ]
    }
  ];

  const response = await callClaude(messages, systemPrompt, 1800);

  // Extract JSON from response
  let jsonStr = response;
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    jsonStr = jsonMatch[0];
  }

  const optimized = JSON.parse(jsonStr);

  return {
    itemId: item.designId || item.name,
    itemName: item.name,
    original: {
      title: item.name,
      description: item.description || item.autoDescription || '',
      price: (item.priceCents || item.price || 0) / 100,
      category: item.categorySlug || item.productType
    },
    optimized: optimized,
    generatedAt: new Date().toISOString()
  };
}

/**
 * Optimize all items in a campaign
 * @param {Array} items - Campaign items array
 * @param {Function} progressCallback - Called with (current, total) progress
 * @returns {Array} Array of optimization results
 */
async function optimizeCampaignProducts(items, progressCallback = null) {
  const results = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    if (progressCallback) {
      progressCallback(i, items.length);
    }

    try {
      const result = await optimizeProduct(item);
      results.push({
        success: true,
        index: i,
        ...result
      });
    } catch (error) {
      results.push({
        success: false,
        index: i,
        itemId: item.designId || item.name,
        itemName: item.name,
        error: error.message
      });
    }
  }

  if (progressCallback) {
    progressCallback(items.length, items.length);
  }

  return results;
}

/**
 * Check if Facebook Shop optimizer is configured
 */
function isConfigured() {
  return Boolean(ANTHROPIC_API_KEY);
}

module.exports = {
  optimizeProduct,
  optimizeCampaignProducts,
  isConfigured
};
