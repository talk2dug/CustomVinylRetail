/**
 * Social Marketing Module - Facebook Post Creator
 *
 * Generates engaging Facebook posts using Claude AI,
 * creates collage images, and publishes/schedules posts.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
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

let envLoaded = false;
for (const envPath of possibleEnvPaths) {
  if (fs.existsSync(envPath)) {
    require('dotenv').config({ path: envPath });
    console.log('[Social Marketing] Loaded .env from:', envPath);
    envLoaded = true;
    break;
  }
}

if (!envLoaded) {
  console.warn('[Social Marketing] No .env file found. Tried:', possibleEnvPaths);
}

// Clean environment values
function cleanKey(value) {
  if (!value) return '';
  let trimmed = String(value).trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    trimmed = trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Clean AI-generated filenames by removing common prefixes and UUID suffixes.
 * Example: "Lucid Origin a cinematic photo of 2008 Subaru Impreza WRX STI 3 74ee28cc 669d 470d ba39 2e97d6052182"
 * becomes: "2008 Subaru Impreza WRX STI"
 * @param {string} name - The AI-generated filename
 * @returns {string} - Cleaned name
 */
function cleanAiGeneratedName(name) {
  if (!name || typeof name !== 'string') return name;

  let cleaned = name;

  // Remove common AI generation prefixes (case-insensitive)
  const prefixPatterns = [
    /^Lucid\s+Origin\s*/i,
    /^a\s+cinematic\s+photo\s+of\s*/i,
    /^a\s+photo\s+of\s*/i,
    /^a\s+realistic\s+photo\s+of\s*/i,
    /^an?\s+image\s+of\s*/i,
    /^photo\s+of\s*/i,
    /^cinematic\s+shot\s+of\s*/i,
    /^professional\s+photo\s+of\s*/i,
  ];

  for (const pattern of prefixPatterns) {
    cleaned = cleaned.replace(pattern, '');
  }

  // Remove trailing UUID pattern (8-4-4-4-12 hex format with or without dashes, with spaces)
  cleaned = cleaned.replace(/\s+\d*\s*[a-f0-9]{8}[\s-][a-f0-9]{4}[\s-][a-f0-9]{4}[\s-][a-f0-9]{4}[\s-][a-f0-9]{12}\s*$/i, '');

  // Also handle compact UUID without separators (32 hex chars at end)
  cleaned = cleaned.replace(/\s+\d*\s*[a-f0-9]{32}\s*$/i, '');

  // Remove trailing numbers that might be sequence numbers (like " 3" at end)
  cleaned = cleaned.replace(/\s+\d+\s*$/, '');

  return cleaned.trim();
}

// Configuration
const CLAUDE_MODEL = cleanKey(process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514');
const ANTHROPIC_API_KEY = cleanKey(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || '');
const FB_PAGE_ACCESS_TOKEN = cleanKey(process.env.FB_PAGE_ACCESS_TOKEN || process.env.FB_ACCESS_TOKEN || '');
const FB_PAGE_ID = cleanKey(process.env.FB_PAGE_ID || '');

// Swayze's Custom Vinyl page (for apparel/stickers)
const FB_PAGE_ACCESS_TOKEN_SWAYZE = cleanKey(process.env.FB_PAGE_ACCESS_TOKEN_SWAYZE || '');
const FB_PAGE_ID_SWAYZE = cleanKey(process.env.FB_PAGE_ID_SWAYZE || '');

// Product categories that should go to Swayze's Custom Vinyl
const SWAYZE_CATEGORIES = ['apparel', 'stickers', 'sticker', 'bumper', 'clothing', 't-shirt', 'tshirt', 'shirt', 'hoodie', 'decal', 'decals', 'vinyl'];

/**
 * Get Facebook credentials based on product category
 */
function getFacebookCredentials(category) {
  const categoryLower = (category || '').toLowerCase();
  const isSwayzeCategory = SWAYZE_CATEGORIES.some(cat => categoryLower.includes(cat));

  if (isSwayzeCategory && FB_PAGE_ID_SWAYZE && FB_PAGE_ACCESS_TOKEN_SWAYZE) {
    return {
      pageId: FB_PAGE_ID_SWAYZE,
      accessToken: FB_PAGE_ACCESS_TOKEN_SWAYZE,
      pageName: "Swayze's Custom Vinyl"
    };
  }

  return {
    pageId: FB_PAGE_ID,
    accessToken: FB_PAGE_ACCESS_TOKEN,
    pageName: 'Blue Ridge Custom Co'
  };
}

// Debug: Log configuration status
console.log('[Social Marketing] Config status:', {
  hasAnthropicKey: ANTHROPIC_API_KEY ? `Yes (${ANTHROPIC_API_KEY.substring(0, 10)}...)` : 'No',
  hasFBToken: FB_PAGE_ACCESS_TOKEN ? 'Yes' : 'No',
  hasFBPageId: FB_PAGE_ID ? 'Yes' : 'No',
  hasFBTokenSwayze: FB_PAGE_ACCESS_TOKEN_SWAYZE ? 'Yes' : 'No',
  hasFBPageIdSwayze: FB_PAGE_ID_SWAYZE ? 'Yes' : 'No',
  model: CLAUDE_MODEL
});

// Initialize Anthropic client
const anthropicClient = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

// In-memory store for scheduled posts (in production, use a database)
const scheduledPosts = new Map();

/**
 * Download image from URL
 */
async function downloadImage(url) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const encodedUrl = url.replace(/ /g, '%20');
    const client = url.startsWith('https:') ? https : http;

    const makeRequest = (requestUrl) => {
      client.get(requestUrl, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 307 || response.statusCode === 308) {
          if (response.headers.location) {
            makeRequest(response.headers.location);
            return;
          }
        }

        if (response.statusCode !== 200) {
          reject(new Error(`Failed to download image: ${response.statusCode}`));
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
 * Generate engaging post content using Claude AI
 */
async function generatePostContent(items, options = {}) {
  if (!anthropicClient) {
    throw new Error('ANTHROPIC_API_KEY not configured. Add it to .env file.');
  }

  const {
    style = 'showcase',
    collectionUrl = '',
    productType = 'other',
    campaign = null
  } = options;

  // Prepare images for Claude (up to 6)
  const selectedItems = items.slice(0, 6);
  const imageContents = [];

  console.log('[Social Marketing] Processing', selectedItems.length, 'items');

  for (const item of selectedItems) {
    try {
      let imagePath = item.image || item.imagePath;
      console.log('[Social Marketing] Item:', item.name, '- Image path:', imagePath);

      if (!imagePath) {
        console.warn('[Social Marketing] No image path for item:', item.name);
        continue;
      }

      let imageBuffer;

      // Handle HTTP/HTTPS URLs
      if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
        console.log('[Social Marketing] Downloading image from URL:', imagePath);
        try {
          const downloaded = await downloadImage(imagePath);
          imageBuffer = await sharp(downloaded)
            .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 85 })
            .toBuffer();
        } catch (downloadErr) {
          console.error('[Social Marketing] Failed to download:', downloadErr.message);
          continue;
        }
      }
      // Handle server-relative URLs (like /api/library/...)
      else if (imagePath.startsWith('/')) {
        // Try to build full URL using server base
        const serverUrl = process.env.ASSET_BASE_URL || 'https://blueridgecustomco.com';
        const fullUrl = serverUrl + imagePath;
        console.log('[Social Marketing] Trying server URL:', fullUrl);
        try {
          const downloaded = await downloadImage(fullUrl);
          imageBuffer = await sharp(downloaded)
            .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 85 })
            .toBuffer();
        } catch (downloadErr) {
          console.error('[Social Marketing] Failed to download from server:', downloadErr.message);
          continue;
        }
      }
      // Handle relative or absolute local paths
      else {
        // Try common base paths
        const possiblePaths = [
          imagePath,
          path.resolve(__dirname, '..', '..', 'web', imagePath),
          path.resolve(__dirname, '..', '..', imagePath),
          path.resolve('/Volumes/New Volume 2/Vinyl Stuff/web', imagePath),
          path.resolve('/Volumes/New Volume 2/Vinyl Stuff', imagePath)
        ];

        let foundPath = null;
        for (const p of possiblePaths) {
          if (fs.existsSync(p)) {
            foundPath = p;
            break;
          }
        }

        if (foundPath) {
          console.log('[Social Marketing] Found local file:', foundPath);
          imageBuffer = await sharp(foundPath)
            .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 85 })
            .toBuffer();
        } else {
          console.warn('[Social Marketing] File not found. Tried:', possiblePaths.slice(0, 3));
        }
      }

      if (imageBuffer) {
        imageContents.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/jpeg',
            data: imageBuffer.toString('base64')
          }
        });
        console.log('[Social Marketing] Successfully processed image for:', item.name);
      }
    } catch (err) {
      console.error(`[Social Marketing] Failed to process image for ${item.name}:`, err.message);
    }
  }

  console.log('[Social Marketing] Processed', imageContents.length, 'images successfully');

  if (imageContents.length === 0) {
    throw new Error('No valid images found in selected items');
  }

  /**
   * Extract apparel info from an item
   * Each item can have its own apparel object with styleName, colorName, brandName
   */
  function getItemApparelInfo(item) {
    const apparel = item.apparel || {};

    // Get type from various possible fields
    let type = apparel.styleName || apparel.styleDescription || apparel.productType ||
               apparel.type || item.apparelType || '';

    // Get color
    const color = apparel.colorName || apparel.color || item.colorName || item.color || '';

    // Get brand
    const brand = apparel.brandName || apparel.brand || '';

    // Get description
    const description = apparel.description || apparel.styleDescription || '';

    return { type, color, brand, description };
  }

  // Build product list with per-item apparel details
  const productList = selectedItems
    .map(item => {
      const name = cleanAiGeneratedName(item.name) || 'Custom Design';
      const category = item.category ? ` (${item.category})` : '';

      // Check for per-item apparel info
      const apparelInfo = getItemApparelInfo(item);
      let apparelDetails = '';

      if (apparelInfo.type || apparelInfo.color || apparelInfo.brand) {
        const parts = [];
        if (apparelInfo.type) parts.push(`Style: ${apparelInfo.type}`);
        if (apparelInfo.brand) parts.push(`Brand: ${apparelInfo.brand}`);
        if (apparelInfo.color) parts.push(`Color: ${apparelInfo.color}`);
        if (apparelInfo.description) parts.push(`Description: ${apparelInfo.description}`);
        apparelDetails = `\n    Apparel: ${parts.join(', ')}`;
      }

      return `- ${name}${category}${apparelDetails}`;
    })
    .join('\n');

  // Detect Multiboard products
  const campaignProductType = (campaign?.productType || productType || '').toLowerCase();
  const campaignSlug = (campaign?.slug || '').toLowerCase();
  const isMultiboard = campaignProductType === 'multiboard' ||
                       campaignSlug.includes('multiboard') ||
                       (selectedItems.some(item => item.name && /multiboard|wall.?organiz|tile.?grid/i.test(item.name)));

  // Product type descriptions
  const productTypeDescriptions = {
    apparel: 'custom printed apparel (t-shirts, hoodies, etc.)',
    stickers: 'custom vinyl stickers and decals',
    tumblers: 'custom printed tumblers and drinkware',
    multiboard: 'modular wall organization systems (snap-together tiles, hooks, bins, shelves)',
    other: 'custom printed products'
  };

  // Style-specific prompts
  const multiboardStylePrompts = {
    showcase: 'Highlight the modular design and how the system solves wall organization.',
    lifestyle: 'Show how this transforms a specific room — use the room context provided.',
    quality: 'Emphasize 3D print quality, local Asheville production, and the snap system.',
    urgency: 'Focus on the package deal value and expandability.'
  };

  const defaultStylePrompts = {
    showcase: 'Create a product showcase post highlighting the variety and quality of these items.',
    lifestyle: 'Create a lifestyle-focused post showing how these products fit into everyday life.',
    quality: 'Create a post emphasizing the craftsmanship, durability, and premium quality.',
    urgency: 'Create an urgency-driven post with limited availability or seasonal appeal.'
  };

  const stylePrompts = isMultiboard ? multiboardStylePrompts : defaultStylePrompts;

  // Build campaign context string (general campaign info, apparel info is now per-item above)
  let campaignContextStr = '';
  if (campaign) {
    const parts = [];
    if (campaign.title) parts.push(`Campaign: "${campaign.title}"`);
    if (campaign.subtitle) parts.push(`Tagline: "${campaign.subtitle}"`);
    if (campaign.description) parts.push(`Description: ${campaign.description}`);
    if (campaign.salesInitiative) parts.push(`Sales Focus: ${campaign.salesInitiative}`);
    if (campaign.benefits) parts.push(`Key Benefits: ${campaign.benefits}`);
    if (campaign.socialProof) parts.push(`Social Proof: ${campaign.socialProof}`);
    // Campaign-level apparel info as fallback context
    if (campaign.apparelType) parts.push(`Default Apparel Style: ${campaign.apparelType}`);
    if (campaign.apparelBrand) parts.push(`Default Brand: ${campaign.apparelBrand}`);
    if (campaign.apparelColor) parts.push(`Default Color: ${campaign.apparelColor}`);
    if (campaign.apparelDescription) parts.push(`Apparel Description: ${campaign.apparelDescription}`);

    if (parts.length > 0) {
      campaignContextStr = `\n\nCAMPAIGN CONTEXT (use this to craft relevant messaging):\n${parts.join('\n')}`;
    }
  }

  const systemPrompt = isMultiboard
    ? `You are a social media expert for Blue Ridge Custom Co — Authorized Multiboard Reseller.
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
- Don't use "our design" or "we designed"`
    : `You are a social media marketing expert for Blue Ridge Custom Co, a custom vinyl decals, stickers, and apparel company.
Your posts are engaging, authentic, and drive action without being pushy.
You understand Facebook's algorithm and craft content that encourages engagement.
Keep posts casual and friendly - avoid corporate speak.
You craft posts that speak directly to the target audience and highlight the unique value of the products.`;

  const userPrompt = `Create an engaging Facebook post for these ${selectedItems.length} ${productTypeDescriptions[productType] || productTypeDescriptions.other}:

${productList}

Product Type: ${productType.charAt(0).toUpperCase() + productType.slice(1)}
Style: ${stylePrompts[style] || stylePrompts.showcase}
${collectionUrl ? `Shop link: ${collectionUrl}` : ''}${campaignContextStr}

Generate 3 post variations. For each, provide:
1. The post text (2-4 sentences with a strong hook first, tailored to the product type and any campaign context provided)
   - If apparel info is provided for an item (Style, Brand, Color, Description), USE IT to make the post specific
   - For example: "This design looks amazing on our Gildan Heavy Cotton tee in Black!" not just "Check out this tee!"
   - Mention the specific garment type (t-shirt, hoodie, tank top, etc.) and color when available
2. A call to action
3. 10-15 strategic hashtags using this mix for maximum reach:
   - 2-3 HIGH VOLUME hashtags (500k+ posts) for broad discovery (e.g. #WallArt #HomeDecor #GiftIdeas)
   - 3-4 MEDIUM VOLUME niche hashtags (50k-500k posts) for targeted reach (e.g. #MetalPrints #CarArt #GarageDecor)
   - 3-4 SPECIFIC hashtags based on what's IN the image (e.g. #SubaruWRX #JDM #RallyLife)
   - 2-3 COMMUNITY hashtags that fans actively follow (e.g. #SubieNation #CarCommunity #PetrolHead)
   - 1-2 BUYING INTENT hashtags (e.g. #ShopSmall #UniqueGifts #CustomArt)
   - For apparel: include relevant apparel hashtags like #GraphicTee #CustomHoodie #StreetWear based on the garment type
4. Recommended posting time for the target audience

IMPORTANT:
- Analyze the actual image content to generate hashtags that will reach people interested in THAT SPECIFIC subject (car make/model, animal breed, hobby, sport, etc.)
- If this is apparel, make sure to mention the specific type of garment and its color in the post text

Output as JSON:
{
  "posts": [
    {
      "type": "variation1",
      "text": "post content with emojis",
      "cta": "call to action text",
      "hashtags": ["#tag1", "#tag2"],
      "bestTime": "Tuesday 10am",
      "hook": "first few attention-grabbing words"
    }
  ],
  "recommendedHashtags": ["#topHashtag1", "#topHashtag2"],
  "audienceInsight": "brief note about who this appeals to and what communities to target"
}`;

  const messages = [{
    role: 'user',
    content: [
      ...imageContents,
      { type: 'text', text: userPrompt }
    ]
  }];

  const response = await anthropicClient.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1500,
    system: systemPrompt,
    messages
  });

  const responseText = response.content[0].text;

  // Extract JSON from response
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Failed to parse AI response');
  }

  const result = JSON.parse(jsonMatch[0]);

  return {
    ...result,
    itemCount: selectedItems.length,
    generatedAt: new Date().toISOString()
  };
}

/**
 * Create a collage image from multiple images
 */
async function createCollage(images) {
  if (!images || images.length === 0) {
    throw new Error('No images provided for collage');
  }

  const maxImages = Math.min(images.length, 6);
  const selectedImages = images.slice(0, maxImages);

  // Determine grid layout based on image count
  const layouts = {
    1: { cols: 1, rows: 1, width: 1200, height: 1200 },
    2: { cols: 2, rows: 1, width: 1200, height: 600 },
    3: { cols: 3, rows: 1, width: 1200, height: 400 },
    4: { cols: 2, rows: 2, width: 1200, height: 1200 },
    5: { cols: 3, rows: 2, width: 1200, height: 800 },
    6: { cols: 3, rows: 2, width: 1200, height: 800 }
  };

  const layout = layouts[maxImages];
  const cellWidth = Math.floor(layout.width / layout.cols);
  const cellHeight = Math.floor(layout.height / layout.rows);

  // Process and resize images
  const processedImages = [];
  for (const img of selectedImages) {
    let imagePath = img.image || img.imagePath || img;
    console.log('[Social Marketing] Processing image:', imagePath);

    try {
      let imageBuffer;

      // Check if it's a URL
      if (imagePath && imagePath.startsWith('http')) {
        console.log('[Social Marketing] Downloading image from URL:', imagePath);
        imageBuffer = await downloadImage(imagePath);
      } else {
        // Handle relative paths (check for both Unix and Windows absolute paths)
        const isAbsolute = imagePath && (
          imagePath.startsWith('/') ||
          /^[a-zA-Z]:[\\/]/.test(imagePath)  // Windows drive letter
        );

        if (imagePath && !isAbsolute) {
          const possiblePaths = [
            path.resolve(__dirname, '..', '..', 'web', imagePath),
            path.resolve(__dirname, '..', '..', imagePath),
            path.resolve(process.cwd(), 'web', imagePath),
            path.resolve(process.cwd(), imagePath),
            path.resolve('g:/Vinyl Stuff/web', imagePath),  // Windows fallback
            path.resolve('/Volumes/New Volume 2/Vinyl Stuff/web', imagePath),  // Mac fallback
            imagePath
          ];

          for (const p of possiblePaths) {
            if (fs.existsSync(p)) {
              imagePath = p;
              break;
            }
          }
        }

        if (imagePath && fs.existsSync(imagePath)) {
          console.log('[Social Marketing] Using local image:', imagePath);
          imageBuffer = fs.readFileSync(imagePath);
        } else {
          console.warn('[Social Marketing] Image not found:', imagePath, 'Original:', img.image || img.imagePath || img);
          continue;
        }
      }

      if (imageBuffer) {
        const resized = await sharp(imageBuffer)
          .resize(cellWidth, cellHeight, { fit: 'cover' })
          .toBuffer();
        processedImages.push(resized);
      }
    } catch (error) {
      console.error('[Social Marketing] Error processing image:', imagePath, error.message);
    }
  }

  if (processedImages.length === 0) {
    throw new Error('No valid images found for collage. Check console for image path details.');
  }

  // Create composite inputs
  const compositeInputs = processedImages.map((buffer, idx) => {
    const col = idx % layout.cols;
    const row = Math.floor(idx / layout.cols);
    return {
      input: buffer,
      left: col * cellWidth,
      top: row * cellHeight
    };
  });

  // Create the collage
  const collage = await sharp({
    create: {
      width: layout.width,
      height: layout.height,
      channels: 3,
      background: { r: 255, g: 255, b: 255 }
    }
  })
    .composite(compositeInputs)
    .jpeg({ quality: 90 })
    .toBuffer();

  // Save to temp file
  const tempPath = path.join(require('os').tmpdir(), `collage-${Date.now()}.jpg`);
  fs.writeFileSync(tempPath, collage);

  return {
    path: tempPath,
    width: layout.width,
    height: layout.height,
    imageCount: processedImages.length,
    base64: collage.toString('base64')
  };
}

/**
 * Publish a post to Facebook
 */
async function publishPost(options) {
  const { text, images, collectionUrl, imageFormat, category } = options;

  // Get credentials based on category
  const creds = getFacebookCredentials(category);
  const pageAccessToken = creds.accessToken;
  const pageId = creds.pageId;

  console.log('[Social Marketing] Category:', category, '-> Posting to:', creds.pageName, '(ID:', pageId, ')');

  if (!pageAccessToken || !pageId) {
    throw new Error('Facebook credentials not configured. Add FB_PAGE_ACCESS_TOKEN and FB_PAGE_ID to .env');
  }

  // Build the full post text
  let fullText = text;
  if (collectionUrl) {
    fullText += `\n\n🛒 Shop now: ${collectionUrl}`;
  }

  // Handle different image formats
  if (imageFormat === 'collage' || images.length === 1) {
    // Single image post (or collage)
    let imagePath;
    if (imageFormat === 'collage' && images.length > 1) {
      const collageResult = await createCollage(images);
      imagePath = collageResult.path;
    } else {
      imagePath = images[0].image || images[0].imagePath || images[0];
      // Resolve path
      if (!imagePath.startsWith('/')) {
        const possiblePaths = [
          path.resolve(__dirname, '..', '..', 'web', imagePath),
          path.resolve(__dirname, '..', '..', imagePath)
        ];
        for (const p of possiblePaths) {
          if (fs.existsSync(p)) {
            imagePath = p;
            break;
          }
        }
      }
    }

    return await postPhotoToFacebook(fullText, imagePath);
  } else {
    // Carousel post (multiple images)
    return await postCarouselToFacebook(fullText, images);
  }
}

/**
 * Post a single photo to Facebook
 */
async function postPhotoToFacebook(text, imagePath) {
  const imageBuffer = fs.readFileSync(imagePath);
  const boundary = '----FormBoundary' + Math.random().toString(36).substring(2);

  const photoData = Buffer.concat([
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="source"; filename="post.jpg"\r\n`),
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
      path: `/v18.0/${pageId}/photos`,
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
              photoId: result.id,
              message: 'Post published successfully!'
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
 * Post multiple photos as a carousel/album
 */
async function postCarouselToFacebook(text, images) {
  // First, upload each photo as unpublished
  const photoIds = [];

  for (const img of images.slice(0, 6)) {
    let imagePath = img.image || img.imagePath || img;

    // Resolve path
    if (!imagePath.startsWith('/')) {
      const possiblePaths = [
        path.resolve(__dirname, '..', '..', 'web', imagePath),
        path.resolve(__dirname, '..', '..', imagePath)
      ];
      for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
          imagePath = p;
          break;
        }
      }
    }

    if (!fs.existsSync(imagePath)) continue;

    try {
      const result = await uploadUnpublishedPhoto(imagePath);
      if (result.id) {
        photoIds.push(result.id);
      }
    } catch (err) {
      console.error(`Failed to upload photo: ${err.message}`);
    }
  }

  if (photoIds.length === 0) {
    throw new Error('No photos were successfully uploaded');
  }

  // Now create a feed post with all the photos attached
  return await createMultiPhotoPost(text, photoIds);
}

/**
 * Upload a photo as unpublished (for carousel)
 */
function uploadUnpublishedPhoto(imagePath) {
  const imageBuffer = fs.readFileSync(imagePath);
  const boundary = '----FormBoundary' + Math.random().toString(36).substring(2);

  const photoData = Buffer.concat([
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="source"; filename="photo.jpg"\r\n`),
    Buffer.from(`Content-Type: image/jpeg\r\n\r\n`),
    imageBuffer,
    Buffer.from(`\r\n--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="access_token"\r\n\r\n`),
    Buffer.from(`${pageAccessToken}\r\n`),
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="published"\r\n\r\n`),
    Buffer.from(`false\r\n`),
    Buffer.from(`--${boundary}--\r\n`)
  ]);

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'graph.facebook.com',
      path: `/v18.0/${pageId}/photos`,
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
            resolve(result);
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
 * Create a multi-photo post
 */
function createMultiPhotoPost(text, photoIds) {
  return new Promise((resolve, reject) => {
    const attachedMedia = photoIds.map(id => ({ media_fbid: id }));

    const postData = new URLSearchParams({
      message: text,
      attached_media: JSON.stringify(attachedMedia),
      access_token: FB_PAGE_ACCESS_TOKEN
    }).toString();

    const options = {
      hostname: 'graph.facebook.com',
      path: `/v18.0/${pageId}/feed`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
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
              postId: result.id,
              photoCount: photoIds.length,
              message: `Posted ${photoIds.length} photos successfully!`
            });
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
 * Schedule a post for later
 */
async function schedulePost(options) {
  const { text, images, collectionUrl, imageFormat, scheduledTime, category } = options;

  // Get credentials based on category
  const creds = getFacebookCredentials(category);
  
  console.log('[Social Marketing] Scheduling for:', creds.pageName, 'at', scheduledTime);

  if (!creds.accessToken || !creds.pageId) {
    throw new Error('Facebook credentials not configured');
  }

  // Parse scheduled time
  const publishTime = new Date(scheduledTime);
  if (isNaN(publishTime.getTime())) {
    throw new Error('Invalid scheduled time');
  }

  // Facebook requires scheduling at least 10 minutes in the future
  const minTime = new Date(Date.now() + 10 * 60 * 1000);
  if (publishTime < minTime) {
    throw new Error('Scheduled time must be at least 10 minutes in the future');
  }

  // Max 75 days in the future
  const maxTime = new Date(Date.now() + 75 * 24 * 60 * 60 * 1000);
  if (publishTime > maxTime) {
    throw new Error('Scheduled time cannot be more than 75 days in the future');
  }

  const scheduledTimestamp = Math.floor(publishTime.getTime() / 1000);

  // Build the full post text
  let fullText = text;
  if (collectionUrl) {
    fullText += `\n\n🛒 Shop now: ${collectionUrl}`;
  }

  // For scheduled posts, we need to handle it differently
  // Facebook's scheduled posts API requires a page access token with manage_pages permission

  // For now, store in memory and use a simple approach
  // In production, you'd want to use a proper job queue
  const postId = `scheduled-${Date.now()}`;
  scheduledPosts.set(postId, {
    id: postId,
    text: fullText,
    images,
    imageFormat,
    category,
    scheduledTime: publishTime.toISOString(),
    status: 'scheduled',
    createdAt: new Date().toISOString()
  });

  // Set up the scheduled execution
  const delay = publishTime.getTime() - Date.now();
  setTimeout(async () => {
    try {
      const post = scheduledPosts.get(postId);
      if (post && post.status === 'scheduled') {
        await publishPost({
          text: post.text,
          images: post.images,
          imageFormat: post.imageFormat,
          category: post.category
        });
        post.status = 'published';
        post.publishedAt = new Date().toISOString();
        console.log(`[Social Marketing] Scheduled post ${postId} published successfully`);
      }
    } catch (err) {
      const post = scheduledPosts.get(postId);
      if (post) {
        post.status = 'failed';
        post.error = err.message;
      }
      console.error(`[Social Marketing] Failed to publish scheduled post ${postId}:`, err.message);
    }
  }, delay);

  return {
    success: true,
    postId,
    scheduledTime: publishTime.toISOString(),
    message: `Post scheduled for ${publishTime.toLocaleString()}`
  };
}

/**
 * List all scheduled posts
 */
async function listScheduledPosts() {
  return Array.from(scheduledPosts.values())
    .filter(post => post.status === 'scheduled')
    .sort((a, b) => new Date(a.scheduledTime) - new Date(b.scheduledTime));
}

/**
 * Cancel a scheduled post
 */
async function cancelScheduledPost(postId) {
  const post = scheduledPosts.get(postId);
  if (!post) {
    throw new Error('Scheduled post not found');
  }

  if (post.status !== 'scheduled') {
    throw new Error(`Cannot cancel post with status: ${post.status}`);
  }

  post.status = 'cancelled';
  post.cancelledAt = new Date().toISOString();

  return { success: true, message: 'Post cancelled' };
}

/**
 * Check if module is configured
 */
function isConfigured() {
  return Boolean(ANTHROPIC_API_KEY && FB_PAGE_ACCESS_TOKEN && FB_PAGE_ID);
}

/**
 * Generate a Multiboard-specific social media post using pillar-based content strategy
 *
 * @param {Object} product - Multiboard product from DB
 * @param {string} pillar - 'awareness' | 'consideration' | 'trust' | 'conversion'
 * @param {string} room - 'kitchen' | 'garage' | 'craft' | 'desk' | 'general'
 * @param {Object} options - Additional options
 * @returns {Promise<{text: string, hashtags: string, pillar: string, room: string, productId: string}>}
 */
async function generateMultiboardPost(product, pillar, room, options = {}) {
  if (!anthropicClient) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  const price = product.price_cents ? `$${(product.price_cents / 100).toFixed(2)}` : '';
  const included = product.whats_included
    ? (typeof product.whats_included === 'string' ? JSON.parse(product.whats_included) : product.whats_included)
    : [];

  const systemPromptText = `You are a social media expert for Blue Ridge Custom Co — Authorized Multiboard Reseller.
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
- Don't use "our design" or "we designed"`;

  const pillarPrompts = {
    awareness: `Write an educational Facebook post explaining what Multiboard is and how wall tiles solve ${room} clutter.
The audience has never heard of Multiboard. Explain the snap-together concept in simple terms.
Focus on the PROBLEM (messy ${room}, no wall organization) and introduce the SOLUTION (modular wall tiles).
Do NOT mention price or specific products. This is about education and awareness.
2-3 sentences, conversational tone.`,

    consideration: `Write a use-case Facebook post showing how the ${product.name} transforms a ${room}.
The reader knows what Multiboard is but hasn't bought yet. Paint a specific scenario.
Mention what's included: ${included.join(', ')}.
Show how it solves a real daily frustration in the ${room}.
2-3 sentences, focus on the transformation.`,

    trust: `Write a trust-building Facebook post about our local 3D printing quality and authorized reseller status.
Mention: printed in Asheville NC, authorized Multiboard reseller, quality PETG/PLA+ filament.
Focus on why buying from a local authorized reseller matters (quality control, support, customization).
2-3 sentences, genuine and warm tone.`,

    conversion: `Write a conversion Facebook post for ${product.name} at ${price}.
What's included: ${included.join(', ')}.
Grid size: ${product.grid_size || 'N/A'}.
Hero angle: ${product.hero_description || ''}
Include the price. List key items included. Mention expandability with add-ons.
End with a clear call to action.
2-4 sentences, direct and value-focused.`
  };

  const userPrompt = `${pillarPrompts[pillar] || pillarPrompts.awareness}

Room context: ${room}
Product: ${product.name}

Generate the post and hashtags as JSON:
{
  "text": "Your post text here",
  "hashtags": "#Multiboard #WallOrganization and 6-8 more relevant tags"
}`;

  const styleMap = {
    awareness: 'showcase',
    consideration: 'lifestyle',
    trust: 'quality',
    conversion: 'urgency'
  };

  try {
    const response = await anthropicClient.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 500,
      system: systemPromptText,
      messages: [{ role: 'user', content: userPrompt }]
    });

    const responseText = response.content[0].text;
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Failed to parse AI response');
    }

    const result = JSON.parse(jsonMatch[0]);

    return {
      text: result.text,
      hashtags: typeof result.hashtags === 'string' ? result.hashtags : (result.hashtags || []).join(' '),
      pillar,
      room,
      productId: product.id,
      style: styleMap[pillar] || 'showcase'
    };
  } catch (err) {
    console.error(`[Social Marketing] Multiboard post generation failed:`, err.message);
    throw err;
  }
}

module.exports = {
  generatePostContent,
  generateMultiboardPost,
  createCollage,
  publishPost,
  schedulePost,
  listScheduledPosts,
  cancelScheduledPost,
  isConfigured
};
