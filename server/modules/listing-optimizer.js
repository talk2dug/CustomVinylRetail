/**
 * Marketplace Listing Optimizer
 *
 * Generates optimized product titles, descriptions, tags, and metadata
 * tailored for each marketplace (Shopify, Etsy, eBay, Amazon, TikTok Shop).
 *
 * Each platform has different algorithms, character limits, and SEO rules.
 */

const STORE_NAME = 'BlueRidgeCustomCo';

// Platform-specific character limits
const LIMITS = {
  shopify: { title: 255, description: 5000, tags: 250 },
  etsy: { title: 140, description: 2000, tags: 13 },  // 13 tags max
  ebay: { title: 80, description: 4000, tags: 30 },
  amazon: { title: 200, description: 2000, bullets: 5 },
  tiktok: { title: 100, description: 1000, tags: 10 }
};

// Category-specific keyword banks for SEO
const KEYWORD_BANK = {
  sticker: {
    primary: ['custom vinyl sticker', 'vinyl decal', 'custom decal'],
    secondary: ['weatherproof sticker', 'car decal', 'laptop sticker', 'water bottle sticker', 'bumper sticker'],
    long_tail: ['personalized vinyl sticker', 'custom die cut sticker', 'outdoor vinyl decal', 'UV resistant sticker'],
    etsy_tags: ['custom sticker', 'vinyl decal', 'car decal', 'laptop sticker', 'personalized', 'weatherproof', 'custom vinyl', 'bumper sticker', 'die cut sticker', 'custom decal', 'water bottle sticker', 'UV resistant', 'handmade sticker']
  },
  tshirt: {
    primary: ['custom t-shirt', 'graphic tee', 'custom printed shirt'],
    secondary: ['personalized t-shirt', 'custom design tee', 'heavyweight t-shirt'],
    long_tail: ['bella canvas custom print', 'premium graphic t-shirt', 'custom text t-shirt'],
    etsy_tags: ['custom tshirt', 'graphic tee', 'personalized shirt', 'custom print', 'bella canvas', 'heavyweight tee', 'custom design', 'printed tshirt', 'custom text shirt', 'unisex tee', 'gift for him', 'gift for her', 'custom apparel']
  },
  hoodie: {
    primary: ['custom hoodie', 'personalized hoodie', 'custom pullover'],
    secondary: ['fleece hoodie', 'custom printed hoodie', 'graphic hoodie'],
    long_tail: ['custom design fleece hoodie', 'personalized pullover hoodie'],
    etsy_tags: ['custom hoodie', 'personalized hoodie', 'graphic hoodie', 'fleece pullover', 'custom print', 'unisex hoodie', 'custom design', 'printed hoodie', 'gift hoodie', 'cozy hoodie', 'winter hoodie', 'custom apparel', 'streetwear']
  },
  hat: {
    primary: ['custom hat', 'custom trucker hat', 'custom baseball cap'],
    secondary: ['personalized cap', 'custom logo hat', 'printed hat'],
    long_tail: ['custom design trucker hat', 'personalized baseball cap'],
    etsy_tags: ['custom hat', 'trucker hat', 'baseball cap', 'custom cap', 'personalized hat', 'custom logo', 'snapback', 'mesh back hat', 'printed hat', 'dad hat', 'custom headwear', 'gift for him', 'adjustable hat']
  },
  beanie: {
    primary: ['custom beanie', 'personalized beanie', 'knit beanie'],
    secondary: ['winter beanie', 'cuff beanie', 'custom knit hat'],
    long_tail: ['personalized knit cuff beanie', 'custom winter beanie hat'],
    etsy_tags: ['custom beanie', 'knit beanie', 'winter hat', 'personalized beanie', 'cuff beanie', 'custom knit', 'warm beanie', 'fleece lined', 'gift', 'unisex beanie', 'cold weather', 'custom hat', 'cozy beanie']
  },
  drinkware: {
    primary: ['custom tumbler', 'personalized tumbler', 'custom cup'],
    secondary: ['40oz tumbler', 'stainless steel tumbler', 'insulated tumbler'],
    long_tail: ['custom 40oz stainless steel tumbler', 'personalized insulated water bottle'],
    etsy_tags: ['custom tumbler', 'personalized tumbler', '40oz tumbler', 'stainless steel', 'insulated cup', 'custom drinkware', 'water bottle', 'gift for her', 'custom name', 'travel mug', 'bridesmaid gift', 'teacher gift', 'coffee tumbler']
  },
  'metal-print': {
    primary: ['metal wall art', 'aluminum print', 'metal photo print'],
    secondary: ['HD metal print', 'custom metal art', 'wall art print'],
    long_tail: ['custom metal photo wall art', 'HD aluminum wall print', 'museum quality metal print'],
    etsy_tags: ['metal wall art', 'aluminum print', 'metal photo', 'custom wall art', 'HD print', 'home decor', 'modern art', 'gallery wall', 'metal sign', 'photo gift', 'office decor', 'custom print', 'wall hanging']
  },
  multiboard: {
    primary: ['modular pegboard', 'wall organizer', '3D printed organizer'],
    secondary: ['tool organizer', 'garage organizer', 'custom pegboard'],
    long_tail: ['3D printed modular wall organization system', 'custom garage tool organizer board'],
    etsy_tags: ['wall organizer', 'pegboard', '3D printed', 'modular system', 'tool organizer', 'garage storage', 'custom organizer', 'home organization', 'workshop', 'craft room', 'desk organizer', 'entryway', 'key holder']
  }
};

/**
 * Generate an optimized listing for a specific platform
 */
function generateListing(product, platform) {
  const category = (product.category || 'sticker').toLowerCase().replace(/\s+/g, '-');
  const keywords = KEYWORD_BANK[category] || KEYWORD_BANK.sticker;

  switch (platform) {
    case 'shopify': return generateShopifyListing(product, keywords);
    case 'etsy': return generateEtsyListing(product, keywords);
    case 'ebay': return generateEbayListing(product, keywords);
    case 'amazon': return generateAmazonListing(product, keywords);
    case 'tiktok': return generateTikTokListing(product, keywords);
    default: return generateShopifyListing(product, keywords);
  }
}

function generateShopifyListing(product, keywords) {
  const title = product.title || 'Custom Product';

  return {
    title: `${title} | ${keywords.primary[0]} | ${STORE_NAME}`.slice(0, LIMITS.shopify.title),
    description: generateRichDescription(product, keywords, 'shopify'),
    tags: [...keywords.primary, ...keywords.secondary].join(', ').slice(0, LIMITS.shopify.tags),
    seo: {
      metaTitle: `${title} - ${keywords.primary[0]} | ${STORE_NAME}`.slice(0, 70),
      metaDescription: `${product.description || keywords.long_tail[0]}. Premium quality, fast shipping. Shop ${STORE_NAME} for custom vinyl, apparel & more.`.slice(0, 160)
    }
  };
}

function generateEtsyListing(product, keywords) {
  // Etsy rewards keyword-rich titles — front-load important terms
  const title = product.title || 'Custom Product';
  const primaryKw = keywords.primary[0];
  const secondaryKw = keywords.secondary[0];

  return {
    title: `${primaryKw} - ${title} - ${secondaryKw} - Personalized Gift - Handmade`.slice(0, LIMITS.etsy.title),
    description: generateRichDescription(product, keywords, 'etsy'),
    tags: keywords.etsy_tags.slice(0, 13), // Etsy allows exactly 13 tags
    materials: ['vinyl', 'premium materials'],
    who_made: 'i_did',
    when_made: 'made_to_order',
    is_customizable: true,
    personalization_instructions: 'Please include your custom text or design notes in the "Personalization" field. We\'ll create a proof for your approval before production.'
  };
}

function generateEbayListing(product, keywords) {
  const title = product.title || 'Custom Product';
  // eBay: 80 chars max, buyers search specific terms
  return {
    title: `${title} ${keywords.primary[0]} Custom Made Personalized`.slice(0, LIMITS.ebay.title),
    description: generateRichDescription(product, keywords, 'ebay'),
    itemSpecifics: {
      Brand: STORE_NAME,
      Type: keywords.primary[0],
      'Custom Made': 'Yes',
      Material: product.material || 'Premium Vinyl',
      Country: 'United States',
      'Handmade': 'Yes'
    },
    returnPolicy: {
      returnsAccepted: true,
      refundMethod: 'MoneyBack',
      returnPeriod: 'Days_30',
      returnShippingCostPaidBy: 'Buyer'
    },
    shippingOptions: [
      { type: 'USPS First Class', cost: 0, freeShipping: true },
      { type: 'USPS Priority', cost: 499, freeShipping: false }
    ]
  };
}

function generateAmazonListing(product, keywords) {
  const title = product.title || 'Custom Product';
  const price = product.price_cents ? `$${(product.price_cents / 100).toFixed(2)}` : '';

  return {
    title: `${STORE_NAME} ${title} - ${keywords.primary[0]} - Custom Made, Premium Quality, Personalized`.slice(0, LIMITS.amazon.title),
    bulletPoints: [
      `PREMIUM QUALITY: ${keywords.long_tail[0] || 'Handcrafted with premium materials'} for lasting durability`,
      `CUSTOM MADE: Personalized just for you — send us your design, text, or idea and we bring it to life`,
      `WEATHER RESISTANT: UV-protected and built to last outdoors or indoors for years`,
      `FAST SHIPPING: Made to order and shipped within 1-3 business days from the USA`,
      `SATISFACTION GUARANTEED: Love it or we\'ll make it right. Premium custom products at fair prices`
    ].slice(0, LIMITS.amazon.bullets),
    description: generateRichDescription(product, keywords, 'amazon'),
    searchTerms: [...keywords.primary, ...keywords.secondary, ...keywords.long_tail].join(' ').slice(0, 250)
  };
}

function generateTikTokListing(product, keywords) {
  const title = product.title || 'Custom Product';

  return {
    title: `${title} - Custom ${keywords.primary[0]}`.slice(0, LIMITS.tiktok.title),
    description: `${keywords.long_tail[0] || 'Custom made just for you!'}\n\nPremium quality ${keywords.primary[0]} made with care. Perfect for gifts, personal use, or showing off your style!\n\nShips fast from the USA.`.slice(0, LIMITS.tiktok.description),
    tags: keywords.etsy_tags?.slice(0, 10) || keywords.primary
  };
}

/**
 * Generate a rich HTML/text description optimized for each platform
 */
function generateRichDescription(product, keywords, platform) {
  const title = product.title || 'Custom Product';
  const category = product.category || 'product';
  const price = product.price_cents ? `$${(product.price_cents / 100).toFixed(2)}` : '';

  if (platform === 'etsy') {
    // Etsy: conversational, story-driven, emphasize handmade
    return `
${title} — Handcrafted by ${STORE_NAME}

Looking for the perfect ${keywords.primary[0]}? You've found it! Each piece is custom made to order with premium materials and attention to detail.

✨ WHAT YOU GET:
• Custom ${category} designed just for you
• Premium quality materials that last
• Handcrafted with care in the USA

🎨 HOW TO ORDER:
1. Add to cart
2. Include your custom text/design in the personalization field
3. We'll create and ship within 1-3 business days

💪 QUALITY PROMISE:
• Weather-resistant and UV-protected
• Premium grade materials
• Professional finish every time

📦 SHIPPING:
• Ships within 1-3 business days
• USPS tracking included
• Packaged with care to arrive perfect

❤️ WHY CHOOSE US:
We're a small business that takes pride in every single order. Your satisfaction is our top priority — if you're not happy, we'll make it right!

Tags: ${keywords.primary.join(', ')}, ${keywords.secondary.join(', ')}
`.trim();
  }

  if (platform === 'ebay') {
    // eBay: structured, professional, trust-building
    return `
<div style="font-family:Arial,sans-serif;max-width:800px;margin:0 auto;">
  <h1 style="color:#333;border-bottom:2px solid #2563eb;padding-bottom:10px;">${title}</h1>

  <h2 style="color:#2563eb;">Product Details</h2>
  <ul>
    <li><strong>Type:</strong> Custom ${keywords.primary[0]}</li>
    <li><strong>Material:</strong> Premium grade</li>
    <li><strong>Made:</strong> Custom made to order in the USA</li>
    <li><strong>Turnaround:</strong> 1-3 business days production</li>
  </ul>

  <h2 style="color:#2563eb;">Why Choose ${STORE_NAME}?</h2>
  <ul>
    <li>✅ Premium materials — built to last</li>
    <li>✅ Custom made just for you</li>
    <li>✅ Fast shipping with tracking</li>
    <li>✅ 30-day money-back guarantee</li>
    <li>✅ Excellent customer service</li>
  </ul>

  <h2 style="color:#2563eb;">How to Customize</h2>
  <p>After purchasing, send us a message with your custom text, design, or idea.
  We'll create your item and ship it within 1-3 business days.</p>

  <h2 style="color:#2563eb;">Shipping</h2>
  <p><strong>FREE Standard Shipping</strong> via USPS with tracking.
  Priority shipping available at checkout.</p>

  <p style="background:#f0f9ff;padding:15px;border-radius:8px;text-align:center;">
    <strong>⭐ ${STORE_NAME} — Premium Custom Products Since Day One ⭐</strong>
  </p>
</div>
`.trim();
  }

  if (platform === 'amazon') {
    return `${title} by ${STORE_NAME}

Custom made ${keywords.primary[0]} crafted with premium materials. Each piece is made to order, ensuring you get a unique, high-quality product every time.

Our ${category} products feature professional-grade materials that are weather-resistant, UV-protected, and built to last for years. Whether it's for your car, laptop, wall, or wardrobe — we've got you covered.

CUSTOMIZATION: Send us your design, text, or idea after ordering. We'll bring your vision to life with professional quality.

SHIPPING: Made to order and shipped within 1-3 business days from the USA. All orders include tracking.

${STORE_NAME} is committed to quality and customer satisfaction. If you're not 100% happy with your order, contact us and we'll make it right.`.trim();
  }

  // Default (Shopify)
  return `
<div>
  <p>${product.description || `Premium ${keywords.primary[0]} custom made by ${STORE_NAME}. Handcrafted with premium materials for lasting quality.`}</p>

  <h3>Features:</h3>
  <ul>
    <li>Custom made to order</li>
    <li>Premium quality materials</li>
    <li>Weather-resistant & UV-protected</li>
    <li>Ships within 1-3 business days</li>
    <li>Made in the USA</li>
  </ul>

  <h3>How to Order Custom:</h3>
  <p>Add to cart, then include your custom text or design in the order notes. We'll create your unique piece and ship it fast!</p>
</div>
`.trim();
}

/**
 * Generate listings for all platforms at once
 */
function generateAllPlatformListings(product) {
  return {
    shopify: generateListing(product, 'shopify'),
    etsy: generateListing(product, 'etsy'),
    ebay: generateListing(product, 'ebay'),
    amazon: generateListing(product, 'amazon'),
    tiktok: generateListing(product, 'tiktok')
  };
}

/**
 * Handle listing optimizer API routes
 */
function handleListingRoute(req, res, parsedUrl, sendJson, db) {
  const pathname = parsedUrl.pathname;

  // Generate optimized listing for a product
  if (pathname === '/api/listings/optimize' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { productId, platform } = JSON.parse(body);
        const product = db.prepare('SELECT * FROM qr_products WHERE id = ?').get(productId);
        if (!product) {
          sendJson(res, { error: 'Product not found' }, 404);
          return;
        }

        if (platform) {
          sendJson(res, generateListing(product, platform));
        } else {
          sendJson(res, generateAllPlatformListings(product));
        }
      } catch (err) {
        sendJson(res, { error: err.message }, 500);
      }
    });
    return true;
  }

  // Get keyword bank for a category
  if (pathname === '/api/listings/keywords' && req.method === 'GET') {
    const category = parsedUrl.searchParams?.get('category') || 'sticker';
    sendJson(res, KEYWORD_BANK[category] || KEYWORD_BANK.sticker);
    return true;
  }

  return false;
}

module.exports = {
  generateListing,
  generateAllPlatformListings,
  generateRichDescription,
  KEYWORD_BANK,
  LIMITS,
  handleListingRoute
};
