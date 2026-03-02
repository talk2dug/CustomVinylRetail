/**
 * SEO Engine — Structured Data, Sitemap, and Meta Tag Generation
 *
 * Generates:
 * - XML sitemap for all products and pages
 * - JSON-LD structured data (Product, Organization, LocalBusiness)
 * - robots.txt
 * - Open Graph meta tags
 */

const fs = require('fs');
const path = require('path');

const STORE_URL = process.env.STORE_BASE_URL || 'https://blueridgecustomco.com';
const BUSINESS_NAME = 'BlueRidgeCustomCo';

/**
 * Generate JSON-LD structured data for a product
 */
function generateProductSchema(product) {
  const price = product.price_cents
    ? (product.price_cents / 100).toFixed(2)
    : product.price || '0.00';

  const schema = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.title || product.name,
    description: product.description || `Custom ${product.category || 'product'} from ${BUSINESS_NAME}`,
    image: product.image || product.photo_path
      ? `${STORE_URL}${product.photo_path || product.image}`
      : `${STORE_URL}/images/BlueRidgeCustomCoLogo.png`,
    brand: {
      '@type': 'Brand',
      name: BUSINESS_NAME
    },
    offers: {
      '@type': 'Offer',
      url: `${STORE_URL}/product.html?id=${product.id || product.handle}`,
      priceCurrency: 'USD',
      price,
      availability: 'https://schema.org/InStock',
      seller: {
        '@type': 'Organization',
        name: BUSINESS_NAME
      }
    }
  };

  // Add aggregate rating if reviews exist
  if (product.reviewCount && product.averageRating) {
    schema.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: product.averageRating,
      reviewCount: product.reviewCount
    };
  }

  return schema;
}

/**
 * Generate Organization structured data
 */
function generateOrganizationSchema() {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: BUSINESS_NAME,
    url: STORE_URL,
    logo: `${STORE_URL}/images/BlueRidgeCustomCoLogo.png`,
    description: 'Premium custom vinyl decals, apparel, metal wall art, and personalized products. Handmade quality with professional results.',
    contactPoint: {
      '@type': 'ContactPoint',
      email: 'orders@swayzecustomvinyl.com',
      contactType: 'customer service'
    },
    sameAs: []
  };
}

/**
 * Generate LocalBusiness structured data
 */
function generateLocalBusinessSchema() {
  return {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: BUSINESS_NAME,
    url: STORE_URL,
    image: `${STORE_URL}/images/BlueRidgeCustomCoLogo.png`,
    description: 'Custom vinyl decals, apparel, metal prints, and 3D printed organization systems.',
    priceRange: '$4 - $650',
    paymentAccepted: 'Credit Card, Debit Card',
    currenciesAccepted: 'USD'
  };
}

/**
 * Generate XML sitemap
 */
function generateSitemap(products = [], categories = []) {
  const now = new Date().toISOString().split('T')[0];

  const staticPages = [
    { url: '/', priority: '1.0', changefreq: 'weekly' },
    { url: '/catalog.html', priority: '0.9', changefreq: 'daily' },
    { url: '/apparel.html', priority: '0.8', changefreq: 'weekly' },
    { url: '/custom-stickers.html', priority: '0.8', changefreq: 'weekly' },
    { url: '/art-showcase-index.html', priority: '0.7', changefreq: 'weekly' },
    { url: '/landing.html', priority: '0.6', changefreq: 'monthly' }
  ];

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

  // Static pages
  for (const page of staticPages) {
    xml += '  <url>\n';
    xml += `    <loc>${STORE_URL}${page.url}</loc>\n`;
    xml += `    <lastmod>${now}</lastmod>\n`;
    xml += `    <changefreq>${page.changefreq}</changefreq>\n`;
    xml += `    <priority>${page.priority}</priority>\n`;
    xml += '  </url>\n';
  }

  // Product pages
  for (const product of products) {
    const slug = product.handle || product.id || '';
    xml += '  <url>\n';
    xml += `    <loc>${STORE_URL}/product.html?id=${slug}</loc>\n`;
    xml += `    <lastmod>${product.updated_at ? product.updated_at.split('T')[0] : now}</lastmod>\n`;
    xml += '    <changefreq>weekly</changefreq>\n';
    xml += '    <priority>0.7</priority>\n';
    xml += '  </url>\n';
  }

  // Category pages
  for (const category of categories) {
    xml += '  <url>\n';
    xml += `    <loc>${STORE_URL}/catalog.html?category=${encodeURIComponent(category)}</loc>\n`;
    xml += `    <lastmod>${now}</lastmod>\n`;
    xml += '    <changefreq>weekly</changefreq>\n';
    xml += '    <priority>0.6</priority>\n';
    xml += '  </url>\n';
  }

  xml += '</urlset>';
  return xml;
}

/**
 * Generate robots.txt
 */
function generateRobotsTxt() {
  return `User-agent: *
Allow: /
Disallow: /api/
Disallow: /admin/
Disallow: /kiosk-admin.html

Sitemap: ${STORE_URL}/sitemap.xml

# Welcome search engines! BlueRidgeCustomCo - Custom vinyl decals, apparel, metal prints & more
`;
}

/**
 * Generate Open Graph meta tags for a product
 */
function generateOgTags(product) {
  const price = product.price_cents
    ? (product.price_cents / 100).toFixed(2)
    : product.price || '';

  return {
    'og:type': 'product',
    'og:title': `${product.title || product.name} | ${BUSINESS_NAME}`,
    'og:description': product.description || `Custom ${product.category || 'product'} - professionally made, fast shipping.`,
    'og:url': `${STORE_URL}/product.html?id=${product.id || product.handle}`,
    'og:image': product.image || (product.photo_path ? `${STORE_URL}${product.photo_path}` : `${STORE_URL}/images/BlueRidgeCustomCoLogo.png`),
    'og:site_name': BUSINESS_NAME,
    'product:price:amount': price,
    'product:price:currency': 'USD'
  };
}

/**
 * Generate SEO-optimized product description
 */
function generateSeoDescription(product) {
  const category = (product.category || 'custom product').toLowerCase();
  const templates = {
    sticker: `Premium custom ${product.title || 'vinyl sticker'} - weatherproof, UV-resistant vinyl. Perfect for cars, laptops, water bottles & more. Made in the USA with professional-grade materials. Ships fast!`,
    decal: `High-quality ${product.title || 'vinyl decal'} - durable outdoor vinyl that lasts 5+ years. Easy to apply, no bubbles. Professional custom vinyl graphics for any surface.`,
    tshirt: `${product.title || 'Custom printed t-shirt'} - premium Bella+Canvas heavyweight tee. Soft, comfortable, and built to last. Available in multiple sizes and colors.`,
    hoodie: `${product.title || 'Custom hoodie'} - cozy fleece pullover with vibrant, long-lasting print. Perfect for layering or lounging. Unisex sizing available.`,
    hat: `${product.title || 'Custom hat'} - structured profile cap with professional embroidery-quality print. Adjustable fit, breathable mesh back. One size fits most.`,
    beanie: `${product.title || 'Custom beanie'} - warm knit cuff beanie with custom design. Premium Port Authority quality. Perfect for cold weather style.`,
    drinkware: `${product.title || 'Custom tumbler'} - 40oz stainless steel tumbler, double-wall insulated. Keeps drinks cold 24hrs / hot 12hrs. Personalized with your design.`,
    'metal-print': `${product.title || 'Metal wall art'} - stunning HD print on premium aluminum. Vivid colors, ultra-durable, ready to hang. Transform any space with museum-quality metal prints.`
  };

  return templates[category] || `${product.title || 'Custom product'} from ${BUSINESS_NAME} - premium quality, handcrafted with care. Fast shipping and satisfaction guaranteed.`;
}

/**
 * Handle SEO-related HTTP routes
 */
function handleSeoRoute(req, res, parsedUrl, db) {
  const pathname = parsedUrl.pathname;

  // Serve robots.txt
  if (pathname === '/robots.txt') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(generateRobotsTxt());
    return true;
  }

  // Serve sitemap.xml
  if (pathname === '/sitemap.xml') {
    try {
      // Get all active products
      const products = db.prepare(
        'SELECT id, title, category, updated_at FROM qr_products WHERE active = 1'
      ).all();

      // Get unique categories
      const categories = db.prepare(
        'SELECT DISTINCT category FROM qr_products WHERE active = 1 AND category IS NOT NULL'
      ).all().map(r => r.category);

      const sitemap = generateSitemap(products, categories);
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(sitemap);
    } catch (err) {
      // Fallback: generate sitemap without DB products
      const sitemap = generateSitemap([], []);
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(sitemap);
    }
    return true;
  }

  // API: Get structured data for a product
  if (pathname === '/api/seo/product-schema' && req.method === 'GET') {
    const productId = parsedUrl.searchParams?.get('id') || new URL(req.url, 'http://localhost').searchParams.get('id');
    if (!productId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Product ID required' }));
      return true;
    }

    try {
      const product = db.prepare('SELECT * FROM qr_products WHERE id = ?').get(productId);
      if (!product) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Product not found' }));
        return true;
      }

      const schema = generateProductSchema(product);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(schema, null, 2));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  // API: Get organization schema
  if (pathname === '/api/seo/org-schema') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(generateOrganizationSchema(), null, 2));
    return true;
  }

  // API: Generate SEO description for a product
  if (pathname === '/api/seo/description' && req.method === 'GET') {
    const productId = parsedUrl.searchParams?.get('id') || new URL(req.url, 'http://localhost').searchParams.get('id');
    if (!productId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Product ID required' }));
      return true;
    }

    try {
      const product = db.prepare('SELECT * FROM qr_products WHERE id = ?').get(productId);
      if (!product) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Product not found' }));
        return true;
      }

      const description = generateSeoDescription(product);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ description }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return true;
  }

  return false;
}

module.exports = {
  generateProductSchema,
  generateOrganizationSchema,
  generateLocalBusinessSchema,
  generateSitemap,
  generateRobotsTxt,
  generateOgTags,
  generateSeoDescription,
  handleSeoRoute
};
