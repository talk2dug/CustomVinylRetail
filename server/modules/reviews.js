/**
 * Customer Review & Social Proof System
 *
 * Collects, manages, and displays customer reviews.
 * Integrates with email sequences for automated review requests.
 * Generates aggregate ratings for SEO structured data.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.resolve(__dirname, '..', '..', 'data');
const REVIEWS_FILE = path.join(DATA_DIR, 'reviews.json');

/**
 * Load reviews from disk
 */
function loadReviews() {
  try {
    if (fs.existsSync(REVIEWS_FILE)) {
      return JSON.parse(fs.readFileSync(REVIEWS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[Reviews] Error loading reviews:', e.message);
  }
  return { reviews: [], stats: {} };
}

/**
 * Save reviews to disk
 */
function saveReviews(data) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(REVIEWS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[Reviews] Error saving reviews:', e.message);
  }
}

/**
 * Submit a new review
 */
function submitReview({ productId, customerName, customerEmail, rating, title, body, photoUrl, orderId }) {
  if (!productId || !rating || rating < 1 || rating > 5) {
    throw new Error('Product ID and rating (1-5) are required');
  }

  const data = loadReviews();
  const reviewId = 'rev_' + crypto.randomBytes(8).toString('hex');

  const review = {
    id: reviewId,
    productId,
    customerName: customerName || 'Anonymous',
    customerEmail: customerEmail || null,
    rating: Math.round(rating),
    title: title || '',
    body: body || '',
    photoUrl: photoUrl || null,
    orderId: orderId || null,
    verified: !!orderId, // Verified purchase if order ID provided
    helpful: 0,
    reported: false,
    featured: false,
    status: 'published', // published, pending, hidden
    createdAt: new Date().toISOString()
  };

  data.reviews.push(review);
  updateProductStats(data, productId);
  saveReviews(data);

  console.log(`[Reviews] New ${rating}-star review for product ${productId} by ${customerName}`);
  return review;
}

/**
 * Update aggregate stats for a product
 */
function updateProductStats(data, productId) {
  const productReviews = data.reviews.filter(
    r => r.productId === productId && r.status === 'published'
  );

  if (productReviews.length === 0) {
    delete data.stats[productId];
    return;
  }

  const totalRating = productReviews.reduce((sum, r) => sum + r.rating, 0);
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  productReviews.forEach(r => distribution[r.rating]++);

  data.stats[productId] = {
    averageRating: Math.round((totalRating / productReviews.length) * 10) / 10,
    totalReviews: productReviews.length,
    verifiedReviews: productReviews.filter(r => r.verified).length,
    withPhotos: productReviews.filter(r => r.photoUrl).length,
    distribution
  };
}

/**
 * Get reviews for a product
 */
function getProductReviews(productId, options = {}) {
  const data = loadReviews();
  let reviews = data.reviews.filter(
    r => r.productId === productId && r.status === 'published'
  );

  // Sort options
  const sortBy = options.sort || 'recent';
  if (sortBy === 'recent') {
    reviews.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } else if (sortBy === 'highest') {
    reviews.sort((a, b) => b.rating - a.rating);
  } else if (sortBy === 'lowest') {
    reviews.sort((a, b) => a.rating - b.rating);
  } else if (sortBy === 'helpful') {
    reviews.sort((a, b) => b.helpful - a.helpful);
  }

  // Filter by rating
  if (options.rating) {
    reviews = reviews.filter(r => r.rating === parseInt(options.rating));
  }

  // Pagination
  const page = options.page || 1;
  const limit = options.limit || 10;
  const offset = (page - 1) * limit;

  return {
    reviews: reviews.slice(offset, offset + limit),
    total: reviews.length,
    page,
    totalPages: Math.ceil(reviews.length / limit),
    stats: data.stats[productId] || null
  };
}

/**
 * Get aggregate stats for a product (for structured data / display)
 */
function getProductStats(productId) {
  const data = loadReviews();
  return data.stats[productId] || null;
}

/**
 * Get all reviews (admin)
 */
function getAllReviews(options = {}) {
  const data = loadReviews();
  let reviews = [...data.reviews];

  if (options.status) {
    reviews = reviews.filter(r => r.status === options.status);
  }

  reviews.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const page = options.page || 1;
  const limit = options.limit || 25;
  const offset = (page - 1) * limit;

  return {
    reviews: reviews.slice(offset, offset + limit),
    total: reviews.length,
    page,
    totalPages: Math.ceil(reviews.length / limit)
  };
}

/**
 * Mark a review as helpful
 */
function markHelpful(reviewId) {
  const data = loadReviews();
  const review = data.reviews.find(r => r.id === reviewId);
  if (review) {
    review.helpful++;
    saveReviews(data);
  }
  return review;
}

/**
 * Feature/unfeature a review (for homepage display)
 */
function toggleFeatured(reviewId) {
  const data = loadReviews();
  const review = data.reviews.find(r => r.id === reviewId);
  if (review) {
    review.featured = !review.featured;
    saveReviews(data);
  }
  return review;
}

/**
 * Get featured reviews (for homepage social proof)
 */
function getFeaturedReviews(limit = 6) {
  const data = loadReviews();
  return data.reviews
    .filter(r => r.featured && r.status === 'published')
    .sort((a, b) => b.rating - a.rating || new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, limit);
}

/**
 * Get overall store stats (for trust badges)
 */
function getStoreReviewStats() {
  const data = loadReviews();
  const published = data.reviews.filter(r => r.status === 'published');

  if (published.length === 0) {
    return { averageRating: 0, totalReviews: 0, fiveStarPercent: '0' };
  }

  const totalRating = published.reduce((sum, r) => sum + r.rating, 0);
  const fiveStars = published.filter(r => r.rating === 5).length;

  return {
    averageRating: Math.round((totalRating / published.length) * 10) / 10,
    totalReviews: published.length,
    fiveStarPercent: ((fiveStars / published.length) * 100).toFixed(0),
    verifiedPurchases: published.filter(r => r.verified).length,
    withPhotos: published.filter(r => r.photoUrl).length
  };
}

/**
 * Moderate a review (admin)
 */
function moderateReview(reviewId, action) {
  const data = loadReviews();
  const review = data.reviews.find(r => r.id === reviewId);
  if (!review) return null;

  if (action === 'approve') review.status = 'published';
  else if (action === 'hide') review.status = 'hidden';
  else if (action === 'delete') {
    data.reviews = data.reviews.filter(r => r.id !== reviewId);
  }

  updateProductStats(data, review.productId);
  saveReviews(data);
  return review;
}

/**
 * Handle review API routes
 */
function handleReviewRoute(req, res, parsedUrl, sendJson) {
  const pathname = parsedUrl.pathname;

  // Submit a review
  if (pathname === '/api/reviews' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const reviewData = JSON.parse(body);
        const review = submitReview(reviewData);
        sendJson(res, review, 201);
      } catch (err) {
        sendJson(res, { error: err.message }, 400);
      }
    });
    return true;
  }

  // Get reviews for a product
  if (pathname.startsWith('/api/reviews/product/') && req.method === 'GET') {
    const productId = pathname.split('/api/reviews/product/')[1];
    const sort = parsedUrl.searchParams?.get('sort') || 'recent';
    const rating = parsedUrl.searchParams?.get('rating');
    const page = parseInt(parsedUrl.searchParams?.get('page') || '1');
    const reviews = getProductReviews(productId, { sort, rating, page });
    sendJson(res, reviews);
    return true;
  }

  // Get featured reviews
  if (pathname === '/api/reviews/featured' && req.method === 'GET') {
    const limit = parseInt(parsedUrl.searchParams?.get('limit') || '6');
    sendJson(res, getFeaturedReviews(limit));
    return true;
  }

  // Get store-wide stats
  if (pathname === '/api/reviews/stats' && req.method === 'GET') {
    sendJson(res, getStoreReviewStats());
    return true;
  }

  // Mark review as helpful
  if (pathname.startsWith('/api/reviews/') && pathname.endsWith('/helpful') && req.method === 'POST') {
    const reviewId = pathname.split('/api/reviews/')[1].replace('/helpful', '');
    const review = markHelpful(reviewId);
    sendJson(res, review || { error: 'Review not found' }, review ? 200 : 404);
    return true;
  }

  // Admin: Get all reviews
  if (pathname === '/api/admin/reviews' && req.method === 'GET') {
    const status = parsedUrl.searchParams?.get('status');
    const page = parseInt(parsedUrl.searchParams?.get('page') || '1');
    sendJson(res, getAllReviews({ status, page }));
    return true;
  }

  // Admin: Moderate review
  if (pathname.startsWith('/api/admin/reviews/') && req.method === 'PATCH') {
    const reviewId = pathname.split('/api/admin/reviews/')[1];
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { action } = JSON.parse(body);
        const review = moderateReview(reviewId, action);
        sendJson(res, review || { error: 'Review not found' }, review ? 200 : 404);
      } catch (err) {
        sendJson(res, { error: err.message }, 400);
      }
    });
    return true;
  }

  // Admin: Toggle featured
  if (pathname.startsWith('/api/admin/reviews/') && pathname.endsWith('/feature') && req.method === 'POST') {
    const reviewId = pathname.split('/api/admin/reviews/')[1].replace('/feature', '');
    const review = toggleFeatured(reviewId);
    sendJson(res, review || { error: 'Review not found' }, review ? 200 : 404);
    return true;
  }

  return false;
}

module.exports = {
  submitReview,
  getProductReviews,
  getProductStats,
  getAllReviews,
  getFeaturedReviews,
  getStoreReviewStats,
  markHelpful,
  toggleFeatured,
  moderateReview,
  handleReviewRoute
};
