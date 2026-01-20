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
const { compositeArtwork, generateMockupToFile } = require('./mockup-compositor');
const sharp = require('sharp');
const { Anthropic } = require('@anthropic-ai/sdk');

// Load environment
const envPath = path.resolve(__dirname, '..', '..', '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
}

// Configuration
const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN || process.env.FB_ACCESS_TOKEN || '';
const FB_PAGE_ID = process.env.FB_PAGE_ID || '';
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

const CLAUDE_MODEL = cleanKey(process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514');
const ANTHROPIC_API_KEY = cleanKey(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || '');
const anthropicClient = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

/**
 * Generate unique AI post content for a single item
 * @param {Object} item - The campaign item
 * @param {Object} campaign - The campaign data
 * @param {string} style - Post style: showcase, lifestyle, quality, urgency
 * @param {string} collectionUrl - Optional shop URL
 * @returns {Promise<{text: string, hashtags: string}>}
 */
async function generateAiPostForItem(item, campaign, style = 'showcase', collectionUrl = '') {
  if (!anthropicClient) {
    console.warn('[FB Scheduler] No Anthropic API key - using default text');
    return null;
  }

  try {
    // Get image path - check artworkPath for metal prints/custom art
    const imagePath = item.mockupImage || item.mockup || item.artworkPath || item.image || item.imagePath || item.artwork;
    if (!imagePath) {
      console.warn(`[FB Scheduler] No image for item ${item.name} - using default text`);
      return null;
    }

    // Prepare image for Claude
    let imageBuffer = null;
    try {
      if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
        const downloaded = await downloadImage(imagePath);
        imageBuffer = await sharp(downloaded)
          .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 85 })
          .toBuffer();
      } else if (imagePath.startsWith('/')) {
        // Server-relative path - download from server
        const fullUrl = `${SERVER_BASE_URL}${imagePath}`;
        const downloaded = await downloadImage(fullUrl);
        imageBuffer = await sharp(downloaded)
          .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 85 })
          .toBuffer();
      } else {
        // Local file path
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
    } catch (imgErr) {
      console.warn(`[FB Scheduler] Could not load image for ${item.name}:`, imgErr.message);
      return null;
    }

    if (!imageBuffer) {
      console.warn(`[FB Scheduler] No valid image buffer for ${item.name}`);
      return null;
    }

    // Build apparel info
    const apparel = item.apparel || {};
    const apparelType = apparel.styleName || apparel.styleDescription || apparel.productType || '';
    const apparelColor = apparel.colorName || apparel.color || item.colorName || item.color || '';
    const apparelBrand = apparel.brandName || apparel.brand || '';

    // Detect product type from campaign slug and productType
    const campaignProductType = (campaign?.productType || '').toLowerCase();
    const campaignSlug = (campaign?.slug || '').toLowerCase();
    const isSticker = campaignSlug.includes('sticker') || campaignSlug.includes('decal') || campaignSlug.includes('bumper');
    const isMetalPrint = !isSticker && (campaignProductType === 'custom-art' || campaignProductType === 'metal-print');

    console.log(`[FB Scheduler] AI detection - apparelType: "${apparelType}", campaignProductType: "${campaignProductType}", campaignSlug: "${campaignSlug}"`);

    // Art products include both metal prints and stickers (not apparel)
    const isArtProduct = !apparelType && (
      isMetalPrint || isSticker ||
      ['canvas', 'poster', 'wall-art', 'decal', 'sticker'].includes(campaignProductType) ||
      (item.name && /lighthouse|print|art|canvas|poster|wall|decor/i.test(item.name))
    );
    console.log(`[FB Scheduler] AI detection result - isArtProduct: ${isArtProduct}, isSticker: ${isSticker}, isMetalPrint: ${isMetalPrint}`);

    // Style prompts - different for art vs apparel
    const artStylePrompts = {
      showcase: 'Highlight the artistic beauty and visual impact of this piece.',
      lifestyle: 'Paint a picture of where this art could transform a space.',
      quality: 'Emphasize the premium sublimation printing and lasting quality.',
      urgency: 'Create excitement around the limited nature of this artwork.'
    };

    const apparelStylePrompts = {
      showcase: 'Highlight the design quality and style.',
      lifestyle: 'Show how this fits into everyday life.',
      quality: 'Emphasize craftsmanship and premium materials.',
      urgency: 'Create urgency with seasonal or trending appeal.'
    };

    const stylePrompts = isArtProduct ? artStylePrompts : apparelStylePrompts;

    // Different system prompts for stickers, metal prints, and apparel
    let systemPrompt;
    if (isSticker) {
      systemPrompt = `You are a social media expert for Blue Ridge Custom Co.
We create eye-catching vinyl stickers and decals with bold designs.
Write fun, punchy posts that show personality and make people want to slap these on their stuff.
Be playful, authentic, and tap into the sticker collector vibe. Use 1-2 fun emojis.
NEVER use boring corporate language.`;
    } else if (isArtProduct) {
      systemPrompt = `You are a passionate art curator and social media expert for Blue Ridge Custom Co.
We create stunning sublimation metal prints and wall art that transform spaces.
Write posts that make people FEEL something - nostalgia, wonder, desire.
Be authentic, evocative, and paint vivid pictures with words. Use 1-2 well-placed emojis.
NEVER use generic phrases like "elevate your space" or "perfect for any room".`;
    } else {
      systemPrompt = `You are a social media expert for Blue Ridge Custom Co, a custom apparel printing business.
Generate engaging, authentic posts that drive engagement and sales.
Keep posts casual, friendly, and avoid sounding like an ad. Use emojis sparingly but effectively.`;
    }

    let userPrompt;
    if (isSticker) {
      userPrompt = `Look at this design and create ONE punchy Facebook post:

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
- Design style tags based on the image
- Interest/hobby tags relevant to the design

Output as JSON:
{
  "text": "Your fun, engaging post here",
  "hashtags": ["#tag1", "#tag2"]
}`;
    } else if (isArtProduct) {
      userPrompt = `Look at this artwork and create ONE compelling Facebook post:

Title: ${item.name || 'Custom Art Print'}
${campaign?.title ? `Collection: ${campaign.title}` : ''}
${collectionUrl ? `Shop: ${collectionUrl}` : ''}

Style Guidance: ${stylePrompts[style] || stylePrompts.showcase}

Write a post that:
- Starts with a vivid, emotional hook that connects to the artwork you see
- Tells a mini-story or evokes a specific feeling/memory (2-3 sentences max)
- Naturally mentions it's available as a metal print WITHOUT sounding salesy
- Ends with subtle call to action

Then add 8-10 hashtags mixing:
- Art/decor specific tags
- Emotional/vibe tags based on the image
- Location tags if relevant to the artwork

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

    const response = await anthropicClient.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 500,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data: imageBuffer.toString('base64')
            }
          },
          { type: 'text', text: userPrompt }
        ]
      }]
    });

    const responseText = response.content[0].text;
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
    console.error(`[FB Scheduler] Full error:`, err);
    if (err.error) console.error(`[FB Scheduler] Error details:`, err.error);
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

  // Server-relative paths -> convert to full URL
  // This handles /api/library/, /uploads/, etc.
  if (imagePath.startsWith('/')) {
    const fullUrl = `${SERVER_BASE_URL}${imagePath}`;
    console.log(`[FB Scheduler] Resolved server path to URL: ${fullUrl}`);
    return { type: 'url', path: fullUrl };
  }

  // Relative path without leading slash - assume it's relative to server root
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
async function postToFacebook(imagePathOrBuffer, text) {
  if (!FB_PAGE_ACCESS_TOKEN || !FB_PAGE_ID) {
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
    Buffer.from(`${FB_PAGE_ACCESS_TOKEN}\r\n`),
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="published"\r\n\r\n`),
    Buffer.from(`true\r\n`),
    Buffer.from(`--${boundary}--\r\n`)
  ]);

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'graph.facebook.com',
      path: `/v18.0/${FB_PAGE_ID}/photos`,
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
    // Mode 3: Fallback - just use artwork as the image
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
          // Fallback to default text
          postText = `Check out ${post.productName}! Available now.`;
          console.log(`[FB Scheduler] AI failed, using fallback for: ${post.productName}`);
        }
      } catch (aiError) {
        console.error(`[FB Scheduler] AI generation error:`, aiError.message);
        postText = `Check out ${post.productName}! Available now.`;
      }
    }

    // Add prefix for custom-art posts (metal prints, stickers, decals)
    if (post.campaignType === 'custom-art') {
      // Detect product type from campaign slug
      const campaignSlug = (post.campaignSlug || '').toLowerCase();
      const isSticker = campaignSlug.includes('sticker') || campaignSlug.includes('decal') || campaignSlug.includes('bumper');

      if (isSticker) {
        postText = `New Sticker Design just dropped ✨\n\n${postText}`;
      } else {
        postText = `New Metal Print Artwork just dropped ✨\n\n${postText}`;
      }
    }

    // Append hashtags and collection URL
    if (postHashtags) {
      postText += '\n\n' + postHashtags;
    }
    if (post.collectionUrl) {
      postText += `\n\n🛒 Shop: ${post.collectionUrl}`;
    }

    if (!postText.trim()) {
      throw new Error('No post text provided');
    }

    // Post to Facebook
    if (onProgress) onProgress('posting', post);

    const fbResult = await postToFacebook(imagePath, postText);

    // Mark as published
    db.markScheduledPostPublished(post.id, fbResult.postId);

    if (onProgress) onProgress('completed', post, fbResult);

    return {
      success: true,
      postId: post.id,
      facebookPostId: fbResult.postId,
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
  const pendingPosts = db.getPendingScheduledPosts();

  console.log(`[FB Scheduler] Found ${pendingPosts.length} pending posts to process`);

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

  // Fetch basic engagement (likes, comments, shares) and insights in one call
  const fields = [
    'id',
    'message',
    'created_time',
    'permalink_url',
    'shares',
    'likes.summary(true).limit(0)',
    'comments.summary(true).limit(0)',
    'insights.metric(post_impressions,post_impressions_unique,post_engaged_users,post_clicks)'
  ].join(',');

  const url = `https://graph.facebook.com/v18.0/${facebookPostId}?fields=${encodeURIComponent(fields)}&access_token=${FB_PAGE_ACCESS_TOKEN}`;

  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);

          if (result.error) {
            console.error('[FB Insights] API Error:', result.error);
            reject(new Error(result.error.message));
            return;
          }

          // Parse the response into a cleaner format
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

          // Parse insights data
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
                  insights.clicks = value;
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

          resolve(insights);
        } catch (e) {
          console.error('[FB Insights] Parse error:', e);
          reject(e);
        }
      });
    }).on('error', reject);
  });
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

module.exports = {
  generateMockupForPost,
  postToFacebook,
  processScheduledPost,
  processPendingPosts,
  schedulePostsForCampaign,
  startSchedulerDaemon,
  getPostInsights,
  getBulkPostInsights,
  GENERATED_MOCKUPS_DIR
};
