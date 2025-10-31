const nodemailer = require('nodemailer');

const SMTP_HOST = process.env.SMTP_HOST || 'smtp.dreamhost.com';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);

const ORDER_EMAIL_USER =
  process.env.ORDERS_SMTP_USER || 'orders@swayzecustomvinyl.com';
const ORDER_EMAIL_PASS =
  process.env.ORDERS_SMTP_PASS || '***REDACTED***';

const ACCOUNTS_EMAIL_USER =
  process.env.ACCOUNTS_SMTP_USER || 'accounts@swayzecustomvinyl.com';
const ACCOUNTS_EMAIL_PASS =
  process.env.ACCOUNTS_SMTP_PASS || '***REDACTED***';

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

async function sendOrdersEmail({ to, subject, text, html }) {
  const info = await ordersTransport.sendMail({
    from: `"Swayze's Custom Vinyl Orders" <${ORDER_EMAIL_USER}>`,
    to,
    subject,
    text,
    html
  });
  return info;
}

module.exports = {
  sendAccountEmail,
  sendOrdersEmail,
  constants: {
    SMTP_HOST,
    SMTP_PORT,
    ORDER_EMAIL_USER,
    ACCOUNTS_EMAIL_USER
  }
};
