/**
 * Cross-Sell & Upsell Recommendation Engine
 *
 * Strategies:
 * 1. Category-based cross-sell (buy sticker → suggest hat)
 * 2. Bundle recommendations (combine products for discount)
 * 3. Free shipping upsell ($X more for free shipping)
 * 4. Size/quantity upsell (buy more, save more)
 * 5. Complementary product matching
 */

const FREE_SHIPPING_THRESHOLD = 3500; // $35.00 in cents

// Cross-sell rules: what to recommend based on what's in the cart
const CROSS_SELL_RULES = {
  sticker: {
    suggestions: ['hat', 'drinkware', 'accessory', 'tshirt'],
    message: 'Complete the look',
    items: [
      { category: 'hat', pitch: 'Add a matching hat', discount: null },
      { category: 'drinkware', pitch: 'Personalize a tumbler too', discount: null },
      { category: 'tshirt', pitch: 'Get a matching tee', discount: null }
    ]
  },
  tshirt: {
    suggestions: ['sticker', 'hoodie', 'hat'],
    message: 'Pair it up',
    items: [
      { category: 'sticker', pitch: 'Add matching stickers for just $3 each', discountCents: 100 },
      { category: 'hoodie', pitch: 'Layer up with a matching hoodie', discount: null },
      { category: 'hat', pitch: 'Top it off with a custom hat', discount: null }
    ]
  },
  hoodie: {
    suggestions: ['beanie', 'sticker', 'tshirt'],
    message: 'Cold weather essentials',
    items: [
      { category: 'beanie', pitch: 'Stay warm with a matching beanie', discount: null },
      { category: 'sticker', pitch: 'Throw in some stickers', discountCents: 100 },
      { category: 'tshirt', pitch: 'Get the matching tee', discount: null }
    ]
  },
  hat: {
    suggestions: ['sticker', 'tshirt', 'drinkware'],
    message: 'Goes great with',
    items: [
      { category: 'sticker', pitch: 'Add stickers to match', discount: null },
      { category: 'tshirt', pitch: 'Grab a matching shirt', discount: null },
      { category: 'drinkware', pitch: 'Custom tumbler for the road', discount: null }
    ]
  },
  beanie: {
    suggestions: ['hoodie', 'sticker', 'accessory'],
    message: 'Winter bundle up',
    items: [
      { category: 'hoodie', pitch: 'Complete the winter look with a hoodie', discount: null },
      { category: 'sticker', pitch: 'Add some stickers too', discount: null }
    ]
  },
  drinkware: {
    suggestions: ['sticker', 'accessory', 'tshirt'],
    message: 'While you\'re here',
    items: [
      { category: 'sticker', pitch: 'Decorate with matching stickers', discount: null },
      { category: 'tshirt', pitch: 'Rep the brand with a tee', discount: null }
    ]
  },
  'metal-print': {
    suggestions: ['metal-print', 'sticker'],
    message: 'Build your gallery',
    items: [
      { category: 'metal-print', pitch: 'Add a second print at 15% off', discountPercent: 15 },
      { category: 'sticker', pitch: 'Matching sticker for your laptop', discount: null }
    ]
  },
  accessory: {
    suggestions: ['sticker', 'drinkware', 'hat'],
    message: 'Customers also bought',
    items: [
      { category: 'sticker', pitch: 'Add custom stickers', discount: null },
      { category: 'drinkware', pitch: 'Personalized tumbler', discount: null }
    ]
  }
};

// Bundle definitions
const BUNDLES = [
  {
    id: 'starter-pack',
    name: 'Starter Pack',
    description: '5 custom stickers at a killer price',
    items: [
      { category: 'sticker', quantity: 5 }
    ],
    originalCents: 2000,
    bundleCents: 1500,
    savingsPercent: 25,
    badge: 'Most Popular'
  },
  {
    id: 'custom-combo',
    name: 'Custom Combo',
    description: 'T-shirt + 3 matching stickers',
    items: [
      { category: 'tshirt', quantity: 1 },
      { category: 'sticker', quantity: 3 }
    ],
    originalCents: 3700,
    bundleCents: 2999,
    savingsPercent: 19,
    badge: 'Best Value'
  },
  {
    id: 'gift-set',
    name: 'Gift Set',
    description: '40oz tumbler + 2 stickers — perfect gift',
    items: [
      { category: 'drinkware', quantity: 1 },
      { category: 'sticker', quantity: 2 }
    ],
    originalCents: 2600,
    bundleCents: 2200,
    savingsPercent: 15,
    badge: 'Great Gift'
  },
  {
    id: 'ultimate-fan',
    name: 'Ultimate Fan Pack',
    description: 'Hoodie + Hat + 5 stickers — the full experience',
    items: [
      { category: 'hoodie', quantity: 1 },
      { category: 'hat', quantity: 1 },
      { category: 'sticker', quantity: 5 }
    ],
    originalCents: 8500,
    bundleCents: 6999,
    savingsPercent: 18,
    badge: 'Save $15'
  },
  {
    id: 'metal-duo',
    name: 'Metal Art Duo',
    description: 'Two 8x10 metal prints — build your gallery wall',
    items: [
      { category: 'metal-print', quantity: 2, size: '8x10' }
    ],
    originalCents: 9500,
    bundleCents: 7999,
    savingsPercent: 16,
    badge: 'Gallery Deal'
  },
  {
    id: 'sticker-bomb',
    name: 'Sticker Bomb',
    description: '10 custom stickers — cover everything',
    items: [
      { category: 'sticker', quantity: 10 }
    ],
    originalCents: 4000,
    bundleCents: 2800,
    savingsPercent: 30,
    badge: 'Best Savings'
  }
];

/**
 * Get cross-sell recommendations based on cart contents
 */
function getCartRecommendations(cartItems) {
  const recommendations = [];
  const cartCategories = new Set(cartItems.map(item =>
    (item.category || '').toLowerCase().replace(/\s+/g, '-')
  ));

  for (const item of cartItems) {
    const category = (item.category || '').toLowerCase().replace(/\s+/g, '-');
    const rules = CROSS_SELL_RULES[category];
    if (!rules) continue;

    for (const suggestion of rules.items) {
      // Don't suggest categories already in cart (unless it's metal prints)
      if (cartCategories.has(suggestion.category) && suggestion.category !== 'metal-print') continue;

      // Avoid duplicate suggestions
      if (recommendations.find(r => r.category === suggestion.category)) continue;

      recommendations.push({
        category: suggestion.category,
        pitch: suggestion.pitch,
        discountCents: suggestion.discountCents || null,
        discountPercent: suggestion.discountPercent || null,
        triggeredBy: category
      });
    }
  }

  return recommendations.slice(0, 3); // Max 3 recommendations
}

/**
 * Get free shipping upsell message
 */
function getFreeShippingUpsell(cartTotalCents) {
  if (cartTotalCents >= FREE_SHIPPING_THRESHOLD) {
    return {
      qualified: true,
      message: 'You qualify for FREE shipping!',
      badge: 'Free Shipping'
    };
  }

  const remaining = FREE_SHIPPING_THRESHOLD - cartTotalCents;
  return {
    qualified: false,
    remainingCents: remaining,
    message: `Add $${(remaining / 100).toFixed(2)} more for FREE shipping!`,
    suggestions: getSuggestionsUnder(remaining + 200) // Suggest items near the threshold
  };
}

/**
 * Get product suggestions under a certain price (for free shipping upsell)
 */
function getSuggestionsUnder(maxCents) {
  const suggestions = [
    { category: 'sticker', title: 'Custom Sticker', priceCents: 400 },
    { category: 'accessory', title: 'Can Holder', priceCents: 1200 },
    { category: 'beanie', title: 'Custom Beanie', priceCents: 1500 },
    { category: 'drinkware', title: '40oz Tumbler', priceCents: 1800 },
    { category: 'hat', title: 'Custom Hat', priceCents: 2000 }
  ];

  return suggestions.filter(s => s.priceCents <= maxCents).slice(0, 3);
}

/**
 * Get quantity upsell for a product
 */
function getQuantityUpsell(category, currentQuantity = 1) {
  const upsells = {
    sticker: [
      { quantity: 3, discountPercent: 10, message: 'Buy 3, save 10%' },
      { quantity: 5, discountPercent: 15, message: 'Buy 5, save 15%' },
      { quantity: 10, discountPercent: 25, message: 'Buy 10, save 25%' }
    ],
    'metal-print': [
      { quantity: 2, discountPercent: 15, message: 'Buy 2, save 15% — build a gallery wall' }
    ],
    tshirt: [
      { quantity: 2, discountPercent: 10, message: 'Buy 2 tees, save 10%' },
      { quantity: 3, discountPercent: 15, message: 'Buy 3 tees, save 15%' }
    ]
  };

  const categoryUpsells = upsells[category] || [];
  return categoryUpsells.filter(u => u.quantity > currentQuantity);
}

/**
 * Get recommended bundles based on cart contents
 */
function getRecommendedBundles(cartItems) {
  const cartCategories = new Set(cartItems.map(item =>
    (item.category || '').toLowerCase().replace(/\s+/g, '-')
  ));

  // Recommend bundles that include items already in cart (upgrade path)
  // or bundles for categories not yet in cart
  return BUNDLES.filter(bundle => {
    const bundleCategories = bundle.items.map(i => i.category);
    // At least one item category overlaps with cart, or cart is small
    return bundleCategories.some(c => cartCategories.has(c)) || cartItems.length <= 1;
  }).slice(0, 3);
}

/**
 * Get post-purchase recommendations (for thank you page / follow-up email)
 */
function getPostPurchaseRecommendations(purchasedItems) {
  const recommendations = [];
  const purchasedCategories = new Set(purchasedItems.map(item =>
    (item.category || '').toLowerCase().replace(/\s+/g, '-')
  ));

  for (const item of purchasedItems) {
    const category = (item.category || '').toLowerCase().replace(/\s+/g, '-');
    const rules = CROSS_SELL_RULES[category];
    if (!rules) continue;

    for (const suggestion of rules.items) {
      if (recommendations.find(r => r.category === suggestion.category)) continue;

      recommendations.push({
        category: suggestion.category,
        pitch: suggestion.pitch,
        reason: `Because you bought a ${category}`
      });
    }
  }

  return recommendations.slice(0, 4);
}

/**
 * Handle cross-sell API routes
 */
function handleCrossSellRoute(req, res, parsedUrl, sendJson) {
  const pathname = parsedUrl.pathname;

  // Get cart recommendations
  if (pathname === '/api/cross-sell/cart' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { items, totalCents } = JSON.parse(body);
        const result = {
          crossSell: getCartRecommendations(items || []),
          freeShipping: getFreeShippingUpsell(totalCents || 0),
          bundles: getRecommendedBundles(items || [])
        };
        sendJson(res, result);
      } catch (err) {
        sendJson(res, { error: err.message }, 400);
      }
    });
    return true;
  }

  // Get quantity upsells for a category
  if (pathname === '/api/cross-sell/quantity' && req.method === 'GET') {
    const category = parsedUrl.searchParams?.get('category') || 'sticker';
    const qty = parseInt(parsedUrl.searchParams?.get('quantity') || '1');
    sendJson(res, getQuantityUpsell(category, qty));
    return true;
  }

  // Get all bundles
  if (pathname === '/api/bundles' && req.method === 'GET') {
    sendJson(res, BUNDLES);
    return true;
  }

  // Get post-purchase recommendations
  if (pathname === '/api/cross-sell/post-purchase' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { items } = JSON.parse(body);
        sendJson(res, getPostPurchaseRecommendations(items || []));
      } catch (err) {
        sendJson(res, { error: err.message }, 400);
      }
    });
    return true;
  }

  return false;
}

module.exports = {
  getCartRecommendations,
  getFreeShippingUpsell,
  getQuantityUpsell,
  getRecommendedBundles,
  getPostPurchaseRecommendations,
  BUNDLES,
  CROSS_SELL_RULES,
  FREE_SHIPPING_THRESHOLD,
  handleCrossSellRoute
};
