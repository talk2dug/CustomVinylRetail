/**
 * Automated Email Marketing Sequences
 *
 * Sequences:
 * 1. Welcome Series (3 emails over 7 days)
 * 2. Abandoned Cart Recovery (3 emails over 48 hours)
 * 3. Post-Purchase Follow-up (3 emails over 14 days)
 * 4. Win-Back Campaign (2 emails at 30/60 days)
 * 5. Review Request (1 email 7 days after delivery)
 */

const path = require('path');
const fs = require('fs');

const STORE_URL = process.env.STORE_BASE_URL || 'https://blueridgecustomco.com';
const STORE_NAME = 'BlueRidgeCustomCo';
const FROM_EMAIL = 'orders@swayzecustomvinyl.com';

// ============================================================================
// EMAIL TEMPLATES
// ============================================================================

function baseTemplate(content, preheader = '') {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${STORE_NAME}</title>
  ${preheader ? `<span style="display:none;font-size:1px;color:#fff;max-height:0;overflow:hidden;">${preheader}</span>` : ''}
</head>
<body style="margin:0;padding:0;font-family:'Helvetica Neue',Arial,sans-serif;background:#f4f4f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:20px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#2563eb,#7c3aed);padding:24px 32px;text-align:center;">
            <h1 style="color:#ffffff;margin:0;font-size:24px;font-weight:700;">${STORE_NAME}</h1>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:32px;">
            ${content}
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="background:#f8fafc;padding:24px 32px;text-align:center;border-top:1px solid #e2e8f0;">
            <p style="color:#94a3b8;font-size:12px;margin:0;">
              ${STORE_NAME} | Custom Vinyl Decals, Apparel & Wall Art<br>
              <a href="${STORE_URL}" style="color:#2563eb;">Visit our store</a> |
              <a href="${STORE_URL}/unsubscribe" style="color:#94a3b8;">Unsubscribe</a>
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ============================================================================
// WELCOME SERIES (3 emails)
// ============================================================================

const welcomeSeries = [
  {
    delay: 0, // Immediate
    subject: 'Welcome to BlueRidgeCustomCo! Here\'s 10% Off',
    preheader: 'Your exclusive welcome discount is inside',
    generate: (customer) => baseTemplate(`
      <h2 style="color:#1e293b;margin:0 0 16px;">Welcome aboard, ${customer.name || 'friend'}!</h2>
      <p style="color:#475569;line-height:1.6;">
        We're thrilled you've joined the ${STORE_NAME} family. We handcraft premium vinyl decals,
        custom apparel, stunning metal wall art, and more — all made with care right here in the USA.
      </p>

      <div style="background:linear-gradient(135deg,#2563eb,#7c3aed);border-radius:12px;padding:24px;text-align:center;margin:24px 0;">
        <p style="color:#ffffff;font-size:14px;margin:0 0 8px;">YOUR EXCLUSIVE WELCOME DISCOUNT</p>
        <p style="color:#ffffff;font-size:36px;font-weight:800;margin:0 0 8px;">10% OFF</p>
        <p style="color:#e2e8f0;font-size:14px;margin:0 0 16px;">Use code at checkout:</p>
        <div style="background:#ffffff;display:inline-block;padding:12px 32px;border-radius:8px;">
          <span style="color:#2563eb;font-size:20px;font-weight:700;letter-spacing:2px;">WELCOME10</span>
        </div>
      </div>

      <h3 style="color:#1e293b;margin:24px 0 12px;">What We Make:</h3>
      <table width="100%" cellpadding="8" cellspacing="0">
        <tr>
          <td style="text-align:center;padding:12px;">
            <div style="font-size:32px;">🎨</div>
            <p style="color:#1e293b;font-weight:600;margin:8px 0 4px;">Custom Stickers</p>
            <p style="color:#64748b;font-size:13px;margin:0;">From $4</p>
          </td>
          <td style="text-align:center;padding:12px;">
            <div style="font-size:32px;">👕</div>
            <p style="color:#1e293b;font-weight:600;margin:8px 0 4px;">Custom Apparel</p>
            <p style="color:#64748b;font-size:13px;margin:0;">From $25</p>
          </td>
          <td style="text-align:center;padding:12px;">
            <div style="font-size:32px;">🖼️</div>
            <p style="color:#1e293b;font-weight:600;margin:8px 0 4px;">Metal Prints</p>
            <p style="color:#64748b;font-size:13px;margin:0;">From $39.75</p>
          </td>
        </tr>
      </table>

      <div style="text-align:center;margin:24px 0;">
        <a href="${STORE_URL}/catalog.html" style="display:inline-block;background:#2563eb;color:#ffffff;padding:14px 40px;border-radius:8px;text-decoration:none;font-weight:600;font-size:16px;">
          Shop Now & Save 10%
        </a>
      </div>
    `, 'Your exclusive welcome discount is inside')
  },
  {
    delay: 3 * 24 * 60 * 60 * 1000, // 3 days
    subject: 'Our Most Popular Products (Your Favorites)',
    preheader: 'See what everyone is buying',
    generate: (customer) => baseTemplate(`
      <h2 style="color:#1e293b;margin:0 0 16px;">Our Best Sellers</h2>
      <p style="color:#475569;line-height:1.6;">
        Hey ${customer.name || 'there'}! Here's what our customers can't stop ordering. These are the designs
        and products flying off our production line.
      </p>

      <div style="background:#f8fafc;border-radius:12px;padding:20px;margin:20px 0;">
        <h3 style="color:#1e293b;margin:0 0 12px;">🔥 Trending This Week</h3>
        <ul style="color:#475569;line-height:2;padding-left:20px;">
          <li><strong>Custom Vinyl Decals</strong> — Weatherproof, UV-resistant, lasts 5+ years</li>
          <li><strong>Bella+Canvas Heavyweight Tees</strong> — Premium feel, vibrant prints</li>
          <li><strong>40oz Insulated Tumblers</strong> — 16 colors, keeps drinks cold 24hrs</li>
          <li><strong>HD Metal Wall Art</strong> — Museum-quality prints on aluminum</li>
        </ul>
      </div>

      <p style="color:#475569;line-height:1.6;">
        Remember, your <strong>WELCOME10</strong> code is still active! Use it before it expires.
      </p>

      <div style="text-align:center;margin:24px 0;">
        <a href="${STORE_URL}/catalog.html" style="display:inline-block;background:#2563eb;color:#ffffff;padding:14px 40px;border-radius:8px;text-decoration:none;font-weight:600;">
          Browse Best Sellers
        </a>
      </div>
    `, 'See what everyone is buying')
  },
  {
    delay: 7 * 24 * 60 * 60 * 1000, // 7 days
    subject: 'Last Chance: Your 10% Off Expires Tonight',
    preheader: 'Don\'t miss out on your welcome discount',
    generate: (customer) => baseTemplate(`
      <h2 style="color:#1e293b;margin:0 0 16px;">⏰ Your Discount Expires Tonight</h2>
      <p style="color:#475569;line-height:1.6;">
        Hey ${customer.name || 'there'}, just a heads up — your exclusive 10% welcome discount
        expires at midnight tonight. Don't let it go to waste!
      </p>

      <div style="background:#fef2f2;border:2px solid #fecaca;border-radius:12px;padding:20px;text-align:center;margin:20px 0;">
        <p style="color:#dc2626;font-weight:700;font-size:18px;margin:0 0 8px;">FINAL HOURS</p>
        <p style="color:#1e293b;margin:0;">Code: <strong style="font-size:20px;color:#2563eb;">WELCOME10</strong></p>
      </div>

      <h3 style="color:#1e293b;margin:20px 0 12px;">Quick Picks Under $20:</h3>
      <table width="100%" cellpadding="8">
        <tr>
          <td style="background:#f8fafc;border-radius:8px;padding:16px;text-align:center;">
            <p style="font-weight:600;color:#1e293b;margin:0 0 4px;">5-Sticker Pack</p>
            <p style="color:#dc2626;font-size:18px;font-weight:700;margin:0;"><s style="color:#94a3b8;">$20</s> $18</p>
          </td>
          <td style="background:#f8fafc;border-radius:8px;padding:16px;text-align:center;">
            <p style="font-weight:600;color:#1e293b;margin:0 0 4px;">Custom Beanie</p>
            <p style="color:#dc2626;font-size:18px;font-weight:700;margin:0;"><s style="color:#94a3b8;">$15</s> $13.50</p>
          </td>
          <td style="background:#f8fafc;border-radius:8px;padding:16px;text-align:center;">
            <p style="font-weight:600;color:#1e293b;margin:0 0 4px;">40oz Tumbler</p>
            <p style="color:#dc2626;font-size:18px;font-weight:700;margin:0;"><s style="color:#94a3b8;">$18</s> $16.20</p>
          </td>
        </tr>
      </table>

      <div style="text-align:center;margin:24px 0;">
        <a href="${STORE_URL}/catalog.html" style="display:inline-block;background:#dc2626;color:#ffffff;padding:14px 40px;border-radius:8px;text-decoration:none;font-weight:600;font-size:16px;">
          Use My 10% Off Now
        </a>
      </div>
    `, 'Don\'t miss your 10% welcome discount')
  }
];

// ============================================================================
// ABANDONED CART RECOVERY (3 emails)
// ============================================================================

const abandonedCartSeries = [
  {
    delay: 1 * 60 * 60 * 1000, // 1 hour
    subject: 'Did you forget something?',
    preheader: 'Your cart is waiting for you',
    generate: (customer, cart) => {
      const itemRows = (cart.items || []).map(item => `
        <tr>
          <td style="padding:12px;border-bottom:1px solid #f1f5f9;">
            <strong style="color:#1e293b;">${item.title}</strong>
            ${item.variant ? `<br><span style="color:#94a3b8;font-size:13px;">${item.variant}</span>` : ''}
          </td>
          <td style="padding:12px;border-bottom:1px solid #f1f5f9;text-align:center;">${item.quantity || 1}</td>
          <td style="padding:12px;border-bottom:1px solid #f1f5f9;text-align:right;font-weight:600;">$${(item.price / 100).toFixed(2)}</td>
        </tr>
      `).join('');

      return baseTemplate(`
        <h2 style="color:#1e293b;margin:0 0 16px;">You left something behind!</h2>
        <p style="color:#475569;line-height:1.6;">
          Hey ${customer.name || 'there'}, looks like you were checking out some great stuff
          but didn't finish your order. No worries — we saved your cart for you!
        </p>

        <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
          <thead>
            <tr style="background:#f8fafc;">
              <th style="padding:12px;text-align:left;color:#64748b;font-size:13px;">Item</th>
              <th style="padding:12px;text-align:center;color:#64748b;font-size:13px;">Qty</th>
              <th style="padding:12px;text-align:right;color:#64748b;font-size:13px;">Price</th>
            </tr>
          </thead>
          <tbody>${itemRows}</tbody>
        </table>

        <div style="text-align:center;margin:24px 0;">
          <a href="${cart.checkoutUrl || STORE_URL}" style="display:inline-block;background:#2563eb;color:#ffffff;padding:14px 40px;border-radius:8px;text-decoration:none;font-weight:600;font-size:16px;">
            Complete My Order
          </a>
        </div>

        <p style="color:#94a3b8;font-size:13px;text-align:center;">
          Your items are reserved but won't last forever!
        </p>
      `, 'Your cart is waiting for you');
    }
  },
  {
    delay: 24 * 60 * 60 * 1000, // 24 hours
    subject: 'Still thinking it over? Here\'s what others say...',
    preheader: 'See why our customers love their orders',
    generate: (customer, cart) => baseTemplate(`
      <h2 style="color:#1e293b;margin:0 0 16px;">Still thinking about it?</h2>
      <p style="color:#475569;line-height:1.6;">
        We get it — shopping decisions aren't always instant. Here's what real customers
        are saying about their ${STORE_NAME} orders:
      </p>

      <div style="background:#f0fdf4;border-left:4px solid #22c55e;padding:16px 20px;margin:20px 0;border-radius:0 8px 8px 0;">
        <p style="color:#1e293b;font-style:italic;margin:0 0 8px;">"The quality of the vinyl decal blew me away. It's been on my truck for 6 months and still looks brand new."</p>
        <p style="color:#64748b;font-size:13px;margin:0;">— Mike R. ⭐⭐⭐⭐⭐</p>
      </div>

      <div style="background:#f0fdf4;border-left:4px solid #22c55e;padding:16px 20px;margin:20px 0;border-radius:0 8px 8px 0;">
        <p style="color:#1e293b;font-style:italic;margin:0 0 8px;">"Ordered a custom metal print for my office — absolutely stunning. Better than expected!"</p>
        <p style="color:#64748b;font-size:13px;margin:0;">— Sarah K. ⭐⭐⭐⭐⭐</p>
      </div>

      <p style="color:#475569;line-height:1.6;">
        Your cart is still saved. Ready to join the happy customers club?
      </p>

      <div style="text-align:center;margin:24px 0;">
        <a href="${cart.checkoutUrl || STORE_URL}" style="display:inline-block;background:#2563eb;color:#ffffff;padding:14px 40px;border-radius:8px;text-decoration:none;font-weight:600;">
          Return to My Cart
        </a>
      </div>
    `, 'See why our customers love their orders')
  },
  {
    delay: 48 * 60 * 60 * 1000, // 48 hours
    subject: 'Final offer: 10% off your cart (expires in 24hrs)',
    preheader: 'We saved you 10% — but only for 24 hours',
    generate: (customer, cart) => baseTemplate(`
      <h2 style="color:#1e293b;margin:0 0 16px;">We don't want you to miss out</h2>
      <p style="color:#475569;line-height:1.6;">
        Hey ${customer.name || 'there'}, your cart has been waiting for 2 days.
        We'd really love for you to have these items, so here's an exclusive offer:
      </p>

      <div style="background:linear-gradient(135deg,#dc2626,#ea580c);border-radius:12px;padding:24px;text-align:center;margin:24px 0;">
        <p style="color:#ffffff;font-size:14px;margin:0 0 8px;">EXCLUSIVE CART RECOVERY OFFER</p>
        <p style="color:#ffffff;font-size:36px;font-weight:800;margin:0 0 8px;">10% OFF</p>
        <p style="color:#fef2f2;margin:0 0 16px;">Expires in 24 hours</p>
        <div style="background:#ffffff;display:inline-block;padding:12px 32px;border-radius:8px;">
          <span style="color:#dc2626;font-size:20px;font-weight:700;letter-spacing:2px;">COMEBACK10</span>
        </div>
      </div>

      <div style="text-align:center;margin:24px 0;">
        <a href="${cart.checkoutUrl || STORE_URL}" style="display:inline-block;background:#dc2626;color:#ffffff;padding:16px 48px;border-radius:8px;text-decoration:none;font-weight:700;font-size:18px;">
          Claim My 10% Off
        </a>
      </div>

      <p style="color:#94a3b8;font-size:13px;text-align:center;">
        This is our final reminder. After 24 hours, your cart and this discount will expire.
      </p>
    `, 'We saved you 10% — but only for 24 hours')
  }
];

// ============================================================================
// POST-PURCHASE SERIES (3 emails)
// ============================================================================

const postPurchaseSeries = [
  {
    delay: 0, // Immediate (order confirmation enhancement)
    subject: 'Your order is in good hands!',
    preheader: 'Here\'s what happens next with your order',
    generate: (customer, order) => baseTemplate(`
      <h2 style="color:#1e293b;margin:0 0 16px;">Thanks for your order! 🎉</h2>
      <p style="color:#475569;line-height:1.6;">
        Hey ${customer.name || 'there'}, we're so excited to make your order!
        Here's what happens next:
      </p>

      <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;">
        <tr>
          <td style="padding:12px 0;">
            <div style="display:flex;align-items:flex-start;">
              <div style="background:#22c55e;color:#fff;width:32px;height:32px;border-radius:50%;text-align:center;line-height:32px;font-weight:700;flex-shrink:0;">1</div>
              <div style="margin-left:16px;">
                <p style="color:#1e293b;font-weight:600;margin:0;">Order Received ✓</p>
                <p style="color:#64748b;font-size:13px;margin:4px 0 0;">We've got your order and it's queued for production.</p>
              </div>
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding:12px 0;">
            <div style="display:flex;align-items:flex-start;">
              <div style="background:#2563eb;color:#fff;width:32px;height:32px;border-radius:50%;text-align:center;line-height:32px;font-weight:700;flex-shrink:0;">2</div>
              <div style="margin-left:16px;">
                <p style="color:#1e293b;font-weight:600;margin:0;">Production (1-3 business days)</p>
                <p style="color:#64748b;font-size:13px;margin:4px 0 0;">Your custom items are being handcrafted with care.</p>
              </div>
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding:12px 0;">
            <div style="display:flex;align-items:flex-start;">
              <div style="background:#94a3b8;color:#fff;width:32px;height:32px;border-radius:50%;text-align:center;line-height:32px;font-weight:700;flex-shrink:0;">3</div>
              <div style="margin-left:16px;">
                <p style="color:#1e293b;font-weight:600;margin:0;">Shipped + Tracking</p>
                <p style="color:#64748b;font-size:13px;margin:4px 0 0;">You'll get a tracking number as soon as it ships!</p>
              </div>
            </div>
          </td>
        </tr>
      </table>

      <p style="color:#475569;line-height:1.6;">
        <strong>Pro tip:</strong> Follow us on social media to see behind-the-scenes of your order being made!
      </p>
    `, 'Here\'s what happens next with your order')
  },
  {
    delay: 7 * 24 * 60 * 60 * 1000, // 7 days (review request)
    subject: 'How\'s your new gear? (Quick 30-sec review)',
    preheader: 'Share your experience and get 15% off your next order',
    generate: (customer, order) => baseTemplate(`
      <h2 style="color:#1e293b;margin:0 0 16px;">How are you liking your order?</h2>
      <p style="color:#475569;line-height:1.6;">
        Hey ${customer.name || 'there'}, you should have received your ${STORE_NAME} order by now.
        We'd love to hear what you think!
      </p>

      <div style="background:#eff6ff;border-radius:12px;padding:20px;text-align:center;margin:20px 0;">
        <p style="color:#1e293b;font-weight:600;margin:0 0 12px;">Leave a review & get rewarded</p>
        <p style="color:#2563eb;font-size:24px;font-weight:800;margin:0;">15% OFF</p>
        <p style="color:#64748b;font-size:13px;margin:4px 0 0;">your next order when you leave a review</p>
      </div>

      <p style="color:#475569;line-height:1.6;">
        <strong>Bonus:</strong> Include a photo of your product in action and we'll feature you
        on our social media (with your permission, of course)!
      </p>

      <div style="text-align:center;margin:24px 0;">
        <a href="${STORE_URL}/review?order=${order.id || ''}" style="display:inline-block;background:#2563eb;color:#ffffff;padding:14px 40px;border-radius:8px;text-decoration:none;font-weight:600;">
          Leave a Review
        </a>
      </div>

      <table width="100%" cellpadding="12" style="margin:16px 0;">
        <tr>
          <td style="text-align:center;font-size:28px;cursor:pointer;">⭐⭐⭐⭐⭐</td>
        </tr>
        <tr>
          <td style="text-align:center;color:#94a3b8;font-size:13px;">Tap a star to start your review</td>
        </tr>
      </table>
    `, 'Share your experience and get 15% off')
  },
  {
    delay: 14 * 24 * 60 * 60 * 1000, // 14 days (cross-sell)
    subject: 'Based on your order: products you\'ll love',
    preheader: 'Personalized picks just for you',
    generate: (customer, order) => baseTemplate(`
      <h2 style="color:#1e293b;margin:0 0 16px;">Picked just for you</h2>
      <p style="color:#475569;line-height:1.6;">
        Hey ${customer.name || 'there'}, based on your recent purchase, we think you'll love these:
      </p>

      <h3 style="color:#1e293b;margin:24px 0 12px;">Customers who bought your items also ordered:</h3>

      <table width="100%" cellpadding="8">
        <tr>
          <td style="background:#f8fafc;border-radius:8px;padding:16px;text-align:center;width:33%;">
            <div style="font-size:28px;margin-bottom:8px;">🎨</div>
            <p style="font-weight:600;color:#1e293b;margin:0 0 4px;">Sticker Pack</p>
            <p style="color:#2563eb;font-weight:700;margin:0;">$15.00</p>
          </td>
          <td style="background:#f8fafc;border-radius:8px;padding:16px;text-align:center;width:33%;">
            <div style="font-size:28px;margin-bottom:8px;">☕</div>
            <p style="font-weight:600;color:#1e293b;margin:0 0 4px;">Custom Tumbler</p>
            <p style="color:#2563eb;font-weight:700;margin:0;">$18.00</p>
          </td>
          <td style="background:#f8fafc;border-radius:8px;padding:16px;text-align:center;width:33%;">
            <div style="font-size:28px;margin:0 0 8px;">🧢</div>
            <p style="font-weight:600;color:#1e293b;margin:0 0 4px;">Trucker Hat</p>
            <p style="color:#2563eb;font-weight:700;margin:0;">$20.00</p>
          </td>
        </tr>
      </table>

      <div style="text-align:center;margin:24px 0;">
        <a href="${STORE_URL}/catalog.html" style="display:inline-block;background:#2563eb;color:#ffffff;padding:14px 40px;border-radius:8px;text-decoration:none;font-weight:600;">
          Shop More Products
        </a>
      </div>
    `, 'Personalized picks just for you')
  }
];

// ============================================================================
// WIN-BACK SERIES (2 emails)
// ============================================================================

const winBackSeries = [
  {
    delay: 30 * 24 * 60 * 60 * 1000, // 30 days since last purchase
    subject: 'We miss you! Here\'s 15% off to come back',
    preheader: 'It\'s been a while — we\'ve got new stuff!',
    generate: (customer) => baseTemplate(`
      <h2 style="color:#1e293b;margin:0 0 16px;">It's been a while!</h2>
      <p style="color:#475569;line-height:1.6;">
        Hey ${customer.name || 'there'}, we noticed it's been about a month since your last order.
        We've been busy adding new designs and products, and we'd love for you to check them out.
      </p>

      <div style="background:linear-gradient(135deg,#059669,#10b981);border-radius:12px;padding:24px;text-align:center;margin:24px 0;">
        <p style="color:#ffffff;font-size:14px;margin:0 0 8px;">WELCOME BACK OFFER</p>
        <p style="color:#ffffff;font-size:36px;font-weight:800;margin:0 0 12px;">15% OFF</p>
        <div style="background:#ffffff;display:inline-block;padding:12px 32px;border-radius:8px;">
          <span style="color:#059669;font-size:20px;font-weight:700;letter-spacing:2px;">MISSYOU15</span>
        </div>
      </div>

      <h3 style="color:#1e293b;margin:20px 0 12px;">What's New:</h3>
      <ul style="color:#475569;line-height:2;padding-left:20px;">
        <li>New design collections dropping weekly</li>
        <li>Expanded metal print sizes (up to 40x60"!)</li>
        <li>Custom 3D-printed organization systems</li>
        <li>More apparel colors and styles</li>
      </ul>

      <div style="text-align:center;margin:24px 0;">
        <a href="${STORE_URL}/catalog.html" style="display:inline-block;background:#059669;color:#ffffff;padding:14px 40px;border-radius:8px;text-decoration:none;font-weight:600;">
          See What's New
        </a>
      </div>
    `, 'It\'s been a while — here\'s 15% off')
  },
  {
    delay: 60 * 24 * 60 * 60 * 1000, // 60 days
    subject: 'Last chance: Your 20% off expires soon',
    preheader: 'Our biggest discount — just for you',
    generate: (customer) => baseTemplate(`
      <h2 style="color:#1e293b;margin:0 0 16px;">We really miss you, ${customer.name || 'friend'}</h2>
      <p style="color:#475569;line-height:1.6;">
        It's been 2 months and we haven't seen you around! We want to make it easy
        for you to come back, so here's our biggest discount ever:
      </p>

      <div style="background:linear-gradient(135deg,#dc2626,#ea580c);border-radius:12px;padding:24px;text-align:center;margin:24px 0;">
        <p style="color:#ffffff;font-size:14px;margin:0 0 8px;">OUR BIGGEST OFFER EVER</p>
        <p style="color:#ffffff;font-size:42px;font-weight:800;margin:0 0 12px;">20% OFF</p>
        <p style="color:#fef2f2;margin:0 0 16px;">Everything in the store</p>
        <div style="background:#ffffff;display:inline-block;padding:12px 32px;border-radius:8px;">
          <span style="color:#dc2626;font-size:20px;font-weight:700;letter-spacing:2px;">COMEBACK20</span>
        </div>
      </div>

      <div style="text-align:center;margin:24px 0;">
        <a href="${STORE_URL}/catalog.html" style="display:inline-block;background:#dc2626;color:#ffffff;padding:16px 48px;border-radius:8px;text-decoration:none;font-weight:700;font-size:18px;">
          Shop Now — 20% Off Everything
        </a>
      </div>

      <p style="color:#94a3b8;font-size:13px;text-align:center;">
        This is our highest discount and final outreach. We hope to see you back!
      </p>
    `, 'Our biggest discount — just for you')
  }
];

// ============================================================================
// SEQUENCE SCHEDULER & MANAGER
// ============================================================================

/**
 * Get the email sequence configuration
 */
function getSequences() {
  return {
    welcome: welcomeSeries,
    abandoned_cart: abandonedCartSeries,
    post_purchase: postPurchaseSeries,
    win_back: winBackSeries
  };
}

/**
 * Generate an email from a sequence
 * @param {string} sequenceType - welcome, abandoned_cart, post_purchase, win_back
 * @param {number} stepIndex - 0-based index of the email in the sequence
 * @param {object} customer - Customer data { name, email }
 * @param {object} context - Additional context (cart, order, etc.)
 * @returns {object} { subject, html, text, delay }
 */
function generateSequenceEmail(sequenceType, stepIndex, customer, context = {}) {
  const sequences = getSequences();
  const sequence = sequences[sequenceType];

  if (!sequence || !sequence[stepIndex]) {
    throw new Error(`Invalid sequence: ${sequenceType}[${stepIndex}]`);
  }

  const step = sequence[stepIndex];
  const html = step.generate(customer, context);

  // Generate plain text version by stripping HTML
  const text = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    subject: step.subject,
    preheader: step.preheader,
    html,
    text,
    delay: step.delay,
    from: FROM_EMAIL
  };
}

/**
 * Get sequence overview (for dashboard display)
 */
function getSequenceOverview() {
  return {
    welcome: {
      name: 'Welcome Series',
      steps: welcomeSeries.length,
      triggers: 'New subscriber / account creation',
      emails: welcomeSeries.map((s, i) => ({
        step: i + 1,
        subject: s.subject,
        delay: s.delay,
        delayLabel: formatDelay(s.delay)
      }))
    },
    abandoned_cart: {
      name: 'Abandoned Cart Recovery',
      steps: abandonedCartSeries.length,
      triggers: 'Cart abandoned (no checkout within 1 hour)',
      emails: abandonedCartSeries.map((s, i) => ({
        step: i + 1,
        subject: s.subject,
        delay: s.delay,
        delayLabel: formatDelay(s.delay)
      }))
    },
    post_purchase: {
      name: 'Post-Purchase Follow-up',
      steps: postPurchaseSeries.length,
      triggers: 'Order completed',
      emails: postPurchaseSeries.map((s, i) => ({
        step: i + 1,
        subject: s.subject,
        delay: s.delay,
        delayLabel: formatDelay(s.delay)
      }))
    },
    win_back: {
      name: 'Win-Back Campaign',
      steps: winBackSeries.length,
      triggers: 'No purchase in 30+ days',
      emails: winBackSeries.map((s, i) => ({
        step: i + 1,
        subject: s.subject,
        delay: s.delay,
        delayLabel: formatDelay(s.delay)
      }))
    }
  };
}

function formatDelay(ms) {
  if (ms === 0) return 'Immediate';
  const hours = ms / (60 * 60 * 1000);
  if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''}`;
  const days = hours / 24;
  return `${days} day${days > 1 ? 's' : ''}`;
}

// ============================================================================
// EMAIL SEQUENCE SCHEDULER ENGINE
// Tracks active sequences per customer and triggers emails on schedule
// ============================================================================

const SEQUENCE_STATE_FILE = path.join(path.resolve(__dirname, '..', '..', 'data'), 'email-sequence-state.json');

function loadSequenceState() {
  try {
    if (fs.existsSync(SEQUENCE_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(SEQUENCE_STATE_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[EmailSeq] Error loading state:', e.message);
  }
  return { active: [], completed: [], stats: { sent: 0, errors: 0 } };
}

function saveSequenceState(state) {
  try {
    const dir = path.dirname(SEQUENCE_STATE_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SEQUENCE_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('[EmailSeq] Error saving state:', e.message);
  }
}

/**
 * Enqueue a customer into an email sequence
 * @param {string} sequenceType - welcome, post_purchase, win_back
 * @param {object} customer - { email, name }
 * @param {object} context - Additional context (cart, order, etc.)
 */
function enqueueSequence(sequenceType, customer, context = {}) {
  if (!customer?.email) return;

  const state = loadSequenceState();
  const key = `${sequenceType}:${customer.email.toLowerCase()}`;

  // Don't duplicate active sequences for the same customer + type
  if (state.active.find(s => s.key === key)) {
    console.log(`[EmailSeq] Sequence ${key} already active, skipping`);
    return;
  }

  const sequences = getSequences();
  const sequence = sequences[sequenceType];
  if (!sequence || sequence.length === 0) return;

  state.active.push({
    key,
    sequenceType,
    customer: { email: customer.email.toLowerCase(), name: customer.name || '' },
    context,
    currentStep: 0,
    totalSteps: sequence.length,
    nextSendAt: Date.now() + sequence[0].delay,
    createdAt: new Date().toISOString()
  });

  saveSequenceState(state);
  console.log(`[EmailSeq] Enqueued ${sequenceType} for ${customer.email} (${sequence.length} emails)`);
}

/**
 * Cancel all active sequences for a customer (e.g., when they make a purchase, cancel win-back)
 */
function cancelSequence(sequenceType, email) {
  const state = loadSequenceState();
  const key = `${sequenceType}:${email.toLowerCase()}`;
  const before = state.active.length;
  state.active = state.active.filter(s => s.key !== key);
  if (state.active.length < before) {
    saveSequenceState(state);
    console.log(`[EmailSeq] Cancelled ${sequenceType} for ${email}`);
  }
}

/**
 * Process pending sequence emails — call this on a timer (every 5 minutes)
 * @param {function} sendEmailFn - Function to send email: (to, subject, html) => Promise
 */
async function processSequenceQueue(sendEmailFn) {
  const state = loadSequenceState();
  const now = Date.now();
  let processed = 0;

  for (let i = state.active.length - 1; i >= 0; i--) {
    const entry = state.active[i];

    // Check if it's time to send
    if (entry.nextSendAt > now) continue;

    try {
      // Generate the email
      const email = generateSequenceEmail(
        entry.sequenceType,
        entry.currentStep,
        entry.customer,
        entry.context
      );

      // Send it
      await sendEmailFn(entry.customer.email, email.subject, email.html);
      processed++;
      state.stats.sent++;

      console.log(`[EmailSeq] Sent ${entry.sequenceType} step ${entry.currentStep + 1}/${entry.totalSteps} to ${entry.customer.email}`);

      // Advance to next step
      entry.currentStep++;

      if (entry.currentStep >= entry.totalSteps) {
        // Sequence complete — move to completed
        state.completed.push({
          ...entry,
          completedAt: new Date().toISOString()
        });
        state.active.splice(i, 1);
      } else {
        // Schedule next email
        const sequences = getSequences();
        const nextStep = sequences[entry.sequenceType][entry.currentStep];
        entry.nextSendAt = now + (nextStep?.delay || 86400000); // default 24h
      }
    } catch (err) {
      console.error(`[EmailSeq] Error sending ${entry.sequenceType} to ${entry.customer.email}:`, err.message);
      state.stats.errors++;
      // Don't remove on error — will retry next cycle
      entry.nextSendAt = now + 600000; // Retry in 10 minutes
    }
  }

  // Keep completed list manageable
  if (state.completed.length > 500) {
    state.completed = state.completed.slice(-500);
  }

  if (processed > 0) {
    saveSequenceState(state);
  }
  return processed;
}

/**
 * Get scheduler status (for dashboard)
 */
function getSchedulerStatus() {
  const state = loadSequenceState();
  return {
    activeSequences: state.active.length,
    completedTotal: state.completed.length,
    emailsSent: state.stats.sent,
    errors: state.stats.errors,
    active: state.active.map(s => ({
      type: s.sequenceType,
      email: s.customer.email,
      step: `${s.currentStep + 1}/${s.totalSteps}`,
      nextSendAt: new Date(s.nextSendAt).toISOString()
    }))
  };
}

/**
 * Handle email sequence API routes
 */
function handleEmailSequenceRoute(req, res, parsedUrl, sendJson) {
  const pathname = parsedUrl.pathname;

  // Get sequence overview
  if (pathname === '/api/email-sequences' && req.method === 'GET') {
    sendJson(res, getSequenceOverview());
    return true;
  }

  // Get scheduler status
  if (pathname === '/api/email-sequences/status' && req.method === 'GET') {
    sendJson(res, getSchedulerStatus());
    return true;
  }

  // Enqueue a customer into a sequence
  if (pathname === '/api/email-sequences/enqueue' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { sequenceType, customer, context } = JSON.parse(body);
        enqueueSequence(sequenceType, customer, context);
        sendJson(res, { success: true, queued: sequenceType });
      } catch (err) {
        sendJson(res, { error: err.message }, 400);
      }
    });
    return true;
  }

  // Cancel a sequence
  if (pathname === '/api/email-sequences/cancel' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { sequenceType, email } = JSON.parse(body);
        cancelSequence(sequenceType, email);
        sendJson(res, { success: true });
      } catch (err) {
        sendJson(res, { error: err.message }, 400);
      }
    });
    return true;
  }

  return false;
}

module.exports = {
  getSequences,
  generateSequenceEmail,
  getSequenceOverview,
  welcomeSeries,
  abandonedCartSeries,
  postPurchaseSeries,
  winBackSeries,
  // Scheduler
  enqueueSequence,
  cancelSequence,
  processSequenceQueue,
  getSchedulerStatus,
  handleEmailSequenceRoute
};
