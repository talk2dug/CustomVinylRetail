const nodemailer = require('nodemailer');

const SMTP_HOST = process.env.SMTP_HOST || 'smtp.dreamhost.com';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);

const ORDER_EMAIL_USER = process.env.ORDERS_SMTP_USER || 'orders@swayzecustomvinyl.com';
const ORDER_EMAIL_PASS = process.env.ORDERS_SMTP_PASS || '';

const ACCOUNTS_EMAIL_USER = process.env.ACCOUNTS_SMTP_USER || 'accounts@swayzecustomvinyl.com';
const ACCOUNTS_EMAIL_PASS = process.env.ACCOUNTS_SMTP_PASS || '';

// IMPORTANT: Email passwords MUST be set via environment variables
// Do NOT hardcode credentials in source code
if (!ORDER_EMAIL_PASS || !ACCOUNTS_EMAIL_PASS) {
  console.warn('[Mailer] WARNING: ORDERS_SMTP_PASS and/or ACCOUNTS_SMTP_PASS not set in environment');
}

function buildTransport(user, pass) {
  const useSecure = SMTP_PORT === 465;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: useSecure,
    requireTLS: !useSecure,
    auth: {
      user,
      pass
    },
    tls: useSecure
      ? { minVersion: 'TLSv1.2' }
      : {
          ciphers: 'TLS_AES_256_GCM_SHA384:TLS_AES_128_GCM_SHA256:TLS_CHACHA20_POLY1305_SHA256',
          minVersion: 'TLSv1.2'
        }
  });
}

const accountTransport = buildTransport(ACCOUNTS_EMAIL_USER, ACCOUNTS_EMAIL_PASS);
const ordersTransport = buildTransport(ORDER_EMAIL_USER, ORDER_EMAIL_PASS);

async function sendAccountEmail({ to, subject, text, html }) {
  const info = await accountTransport.sendMail({
    from: `"Swayze's Custom Vinyl Accounts" <${ACCOUNTS_EMAIL_USER}>`,
    to,
    subject,
    text,
    html
  });
  return info;
}

async function sendOrdersEmail({ to, subject, text, html, replyTo }) {
  const mailOptions = {
    from: `"Swayze's Custom Vinyl Orders" <${ORDER_EMAIL_USER}>`,
    to,
    subject,
    text,
    html
  };
  if (replyTo) mailOptions.replyTo = replyTo;
  const info = await ordersTransport.sendMail(mailOptions);
  return info;
}

// ============================================================================
// B2B METAL PRINTS EMAIL TEMPLATES
// ============================================================================

const B2B_PORTAL_URL = process.env.B2B_PORTAL_URL || 'https://b2b.swayzecustomvinyl.com';

function formatCurrency(cents) {
  return '$' + (cents / 100).toFixed(2);
}

async function sendB2BWelcomeEmail({ to, userName, companyName, tempPassword }) {
  const subject = 'Welcome to the Metal Prints B2B Portal';
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #2563eb;">Welcome to Metal Prints!</h2>
      <p>Hi ${userName},</p>
      <p>Your B2B account for <strong>${companyName}</strong> has been created. You can now access our wholesale metal prints portal.</p>

      <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
        <p style="margin: 0 0 10px;"><strong>Login URL:</strong> <a href="${B2B_PORTAL_URL}">${B2B_PORTAL_URL}</a></p>
        <p style="margin: 0 0 10px;"><strong>Email:</strong> ${to}</p>
        ${tempPassword ? `<p style="margin: 0;"><strong>Temporary Password:</strong> ${tempPassword}</p>` : ''}
      </div>

      ${tempPassword ? '<p style="color: #d97706;"><strong>Important:</strong> Please change your password after your first login.</p>' : ''}

      <h3>Wholesale Pricing</h3>
      <ul>
        <li>5x7" Metal Print - $15.00</li>
        <li>8x10" Metal Print - $22.00</li>
        <li>11x14" Metal Print - $32.00</li>
        <li>Custom sizes - Contact for quote</li>
      </ul>

      <p>If you have any questions, please reply to this email or contact your account representative.</p>

      <p style="color: #64748b; font-size: 14px; margin-top: 30px;">
        Best regards,<br>
        Swayze's Custom Vinyl Team
      </p>
    </div>
  `;

  const text = `Welcome to Metal Prints B2B Portal!

Hi ${userName},

Your B2B account for ${companyName} has been created.

Login URL: ${B2B_PORTAL_URL}
Email: ${to}
${tempPassword ? `Temporary Password: ${tempPassword}` : ''}

Wholesale Pricing:
- 5x7" Metal Print - $15.00
- 8x10" Metal Print - $22.00
- 11x14" Metal Print - $32.00
- Custom sizes - Contact for quote

If you have any questions, please reply to this email.

Best regards,
Swayze's Custom Vinyl Team`;

  return sendOrdersEmail({ to, subject, text, html });
}

async function sendB2BOrderConfirmationEmail({ to, order, items }) {
  const subject = `B2B Order #${order.orderNumber} Confirmed`;

  const itemsList = items.map(item =>
    `<tr>
      <td style="padding: 10px; border-bottom: 1px solid #e2e8f0;">${item.size}" Metal Print</td>
      <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; text-align: center;">${item.quantity}</td>
      <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; text-align: right;">${formatCurrency(item.lineTotalCents)}</td>
    </tr>`
  ).join('');

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #2563eb;">Order Confirmed!</h2>
      <p>Thank you for your order. We've received it and will begin production shortly.</p>

      <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
        <p style="margin: 0;"><strong>Order #:</strong> ${order.orderNumber}</p>
      </div>

      <h3>Order Details</h3>
      <table style="width: 100%; border-collapse: collapse;">
        <thead>
          <tr style="background: #f8fafc;">
            <th style="padding: 10px; text-align: left;">Item</th>
            <th style="padding: 10px; text-align: center;">Qty</th>
            <th style="padding: 10px; text-align: right;">Price</th>
          </tr>
        </thead>
        <tbody>
          ${itemsList}
        </tbody>
        <tfoot>
          <tr>
            <td colspan="2" style="padding: 10px; text-align: right;"><strong>Subtotal:</strong></td>
            <td style="padding: 10px; text-align: right;">${formatCurrency(order.subtotalCents)}</td>
          </tr>
          <tr>
            <td colspan="2" style="padding: 10px; text-align: right;"><strong>Shipping:</strong></td>
            <td style="padding: 10px; text-align: right;">${formatCurrency(order.shippingCents)}</td>
          </tr>
          <tr style="font-size: 18px;">
            <td colspan="2" style="padding: 10px; text-align: right;"><strong>Total:</strong></td>
            <td style="padding: 10px; text-align: right;"><strong>${formatCurrency(order.totalCents)}</strong></td>
          </tr>
        </tfoot>
      </table>

      <h3>Shipping To</h3>
      <p>
        ${order.shippingName}<br>
        ${order.shippingAddressLine1}<br>
        ${order.shippingAddressLine2 ? order.shippingAddressLine2 + '<br>' : ''}
        ${order.shippingCity}, ${order.shippingState} ${order.shippingZip}
      </p>

      <p style="margin-top: 20px;">
        <a href="${B2B_PORTAL_URL}/order-detail.html?id=${order.id}" style="display: inline-block; background: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px;">View Order Status</a>
      </p>

      <p style="color: #64748b; font-size: 14px; margin-top: 30px;">
        Best regards,<br>
        Swayze's Custom Vinyl Team
      </p>
    </div>
  `;

  const itemsText = items.map(item => `- ${item.size}" Metal Print x${item.quantity}: ${formatCurrency(item.lineTotalCents)}`).join('\n');

  const text = `Order Confirmed!

Thank you for your order. We've received it and will begin production shortly.

Order #: ${order.orderNumber}

Items:
${itemsText}

Subtotal: ${formatCurrency(order.subtotalCents)}
Shipping: ${formatCurrency(order.shippingCents)}
Total: ${formatCurrency(order.totalCents)}

Shipping To:
${order.shippingName}
${order.shippingAddressLine1}
${order.shippingAddressLine2 || ''}
${order.shippingCity}, ${order.shippingState} ${order.shippingZip}

View your order: ${B2B_PORTAL_URL}/order-detail.html?id=${order.id}

Best regards,
Swayze's Custom Vinyl Team`;

  return sendOrdersEmail({ to, subject, text, html });
}

async function sendB2BShippingNotificationEmail({ to, order, trackingCarrier, trackingNumber }) {
  const subject = `B2B Order #${order.orderNumber} Has Shipped!`;

  let trackingUrl = '#';
  const carrier = (trackingCarrier || '').toLowerCase();
  if (carrier.includes('usps')) trackingUrl = `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`;
  else if (carrier.includes('ups')) trackingUrl = `https://www.ups.com/track?tracknum=${trackingNumber}`;
  else if (carrier.includes('fedex')) trackingUrl = `https://www.fedex.com/fedextrack/?trknbr=${trackingNumber}`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #22c55e;">Your Order Has Shipped!</h2>
      <p>Great news! Order #${order.orderNumber} is on its way.</p>

      <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
        <p style="margin: 0 0 10px;"><strong>Carrier:</strong> ${trackingCarrier}</p>
        <p style="margin: 0;"><strong>Tracking #:</strong> <a href="${trackingUrl}">${trackingNumber}</a></p>
      </div>

      <p>
        <a href="${trackingUrl}" style="display: inline-block; background: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px;">Track Package</a>
      </p>

      <h3>Shipping To</h3>
      <p>
        ${order.shippingName}<br>
        ${order.shippingAddressLine1}<br>
        ${order.shippingAddressLine2 ? order.shippingAddressLine2 + '<br>' : ''}
        ${order.shippingCity}, ${order.shippingState} ${order.shippingZip}
      </p>

      <p style="color: #64748b; font-size: 14px; margin-top: 30px;">
        Best regards,<br>
        Swayze's Custom Vinyl Team
      </p>
    </div>
  `;

  const text = `Your Order Has Shipped!

Great news! Order #${order.orderNumber} is on its way.

Carrier: ${trackingCarrier}
Tracking #: ${trackingNumber}

Track your package: ${trackingUrl}

Shipping To:
${order.shippingName}
${order.shippingAddressLine1}
${order.shippingAddressLine2 || ''}
${order.shippingCity}, ${order.shippingState} ${order.shippingZip}

Best regards,
Swayze's Custom Vinyl Team`;

  return sendOrdersEmail({ to, subject, text, html });
}

module.exports = {
  sendAccountEmail,
  sendOrdersEmail,
  // B2B Email Templates
  sendB2BWelcomeEmail,
  sendB2BOrderConfirmationEmail,
  sendB2BShippingNotificationEmail,
  constants: {
    SMTP_HOST,
    SMTP_PORT,
    ORDER_EMAIL_USER,
    ACCOUNTS_EMAIL_USER,
    B2B_PORTAL_URL
  }
};
