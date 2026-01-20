/**
 * Metal Prints Server
 * Handles image uploads and order management for Premium Metal Prints
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const db = require('./db');

const router = express.Router();

// Configure multer for image uploads
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../uploads/metal-prints');
    await fs.mkdir(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueId = crypto.randomBytes(16).toString('hex');
    const ext = path.extname(file.originalname);
    cb(null, `metal-print-${uniqueId}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB max
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|heic/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only JPG, PNG, and HEIC images are allowed'));
    }
  }
});

/**
 * Initialize database tables for metal prints
 */
function initDatabase() {
  const dbClient = db.getDb();

  // Create metal_print_orders table
  dbClient.exec(`
    CREATE TABLE IF NOT EXISTS metal_print_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT NOT NULL,
      line_item_id TEXT NOT NULL,
      shopify_order_id TEXT,
      size TEXT NOT NULL,
      price REAL NOT NULL,
      customer_email TEXT,
      customer_name TEXT,
      image_path TEXT,
      image_width INTEGER,
      image_height INTEGER,
      marketing_consent INTEGER DEFAULT 0,
      upload_token TEXT UNIQUE,
      status TEXT DEFAULT 'awaiting_upload',
      created_at TEXT DEFAULT (datetime('now')),
      uploaded_at TEXT,
      produced_at TEXT,
      shipped_at TEXT,
      shipping_address_json TEXT,
      lumaprints_order_id TEXT,
      lumaprints_status TEXT,
      UNIQUE(order_number, line_item_id)
    )
  `);

  // Add columns if they don't exist (for existing databases)
  try {
    dbClient.exec(`ALTER TABLE metal_print_orders ADD COLUMN shipping_address_json TEXT`);
  } catch (e) { /* column exists */ }
  try {
    dbClient.exec(`ALTER TABLE metal_print_orders ADD COLUMN lumaprints_order_id TEXT`);
  } catch (e) { /* column exists */ }
  try {
    dbClient.exec(`ALTER TABLE metal_print_orders ADD COLUMN lumaprints_status TEXT`);
  } catch (e) { /* column exists */ }
  try {
    dbClient.exec(`ALTER TABLE metal_print_orders ADD COLUMN tracking_carrier TEXT`);
  } catch (e) { /* column exists */ }
  try {
    dbClient.exec(`ALTER TABLE metal_print_orders ADD COLUMN tracking_number TEXT`);
  } catch (e) { /* column exists */ }
  try {
    dbClient.exec(`ALTER TABLE metal_print_orders ADD COLUMN sales_channel TEXT DEFAULT 'shopify'`);
  } catch (e) { /* column exists */ }
  try {
    dbClient.exec(`ALTER TABLE metal_print_orders ADD COLUMN channel_order_id TEXT`);
  } catch (e) { /* column exists */ }

  console.log('✅ Metal prints database initialized');
}

/**
 * Create a new metal print order (called after sales channel order webhook)
 * @param {object} orderData - Order data
 * @param {string} orderData.salesChannel - Source channel: 'shopify', 'ebay', 'etsy', 'tiktok', 'facebook'
 * @param {string} orderData.channelOrderId - The order ID on the sales channel (for fulfillment updates)
 */
async function createMetalPrintOrder(orderData) {
  const {
    orderNumber,
    lineItemId,
    shopifyOrderId,
    size,
    price,
    customerEmail,
    customerName,
    shippingAddress,
    salesChannel = 'shopify',
    channelOrderId
  } = orderData;

  const uploadToken = crypto.randomBytes(32).toString('hex');
  const dbClient = await db.getDb();
  const shippingJson = shippingAddress ? JSON.stringify(shippingAddress) : null;

  await dbClient.run(`
    INSERT INTO metal_print_orders (
      order_number,
      line_item_id,
      shopify_order_id,
      size,
      price,
      customer_email,
      customer_name,
      upload_token,
      status,
      shipping_address_json,
      sales_channel,
      channel_order_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_upload', ?, ?, ?)
  `, [orderNumber, lineItemId, shopifyOrderId, size, price, customerEmail, customerName, uploadToken, shippingJson, salesChannel, channelOrderId || shopifyOrderId]);

  return uploadToken;
}

/**
 * Generate upload URL for customer
 */
function getUploadUrl(orderNumber, lineItemId, uploadToken) {
  const baseUrl = process.env.SHOPIFY_STORE_URL || 'https://store.swayzecustomvinyl.com';
  return `${baseUrl}/pages/metal-print-upload?order=${orderNumber}&item=${lineItemId}&token=${uploadToken}`;
}

/**
 * API: Get order information
 */
router.get('/api/order-info', async (req, res) => {
  try {
    const { order, item, token } = req.query;

    if (!order || !item) {
      return res.status(400).json({ success: false, error: 'Missing order or item parameter' });
    }

    const dbClient = await db.getDb();
    const orderInfo = await dbClient.get(`
      SELECT
        order_number,
        line_item_id,
        size,
        price,
        status,
        image_path,
        uploaded_at
      FROM metal_print_orders
      WHERE order_number = ? AND line_item_id = ?
    `, [order, item]);

    if (!orderInfo) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    // Verify token if provided (optional for now, can enforce later)
    // This allows checking order status without token

    res.json({
      success: true,
      orderNumber: orderInfo.order_number,
      size: orderInfo.size,
      price: orderInfo.price,
      status: orderInfo.status,
      uploaded: !!orderInfo.image_path,
      uploadedAt: orderInfo.uploaded_at
    });
  } catch (error) {
    console.error('Error fetching order info:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * API: Upload image
 */
router.post('/api/upload', upload.single('image'), async (req, res) => {
  try {
    const { order, item, marketingConsent, width, height } = req.body;

    if (!order || !item) {
      return res.status(400).json({ success: false, error: 'Missing order or item parameter' });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No image file provided' });
    }

    const dbClient = await db.getDb();

    // Verify order exists
    const orderInfo = await dbClient.get(`
      SELECT id, status, image_path
      FROM metal_print_orders
      WHERE order_number = ? AND line_item_id = ?
    `, [order, item]);

    if (!orderInfo) {
      // Clean up uploaded file
      await fs.unlink(req.file.path);
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    if (orderInfo.image_path) {
      // Already uploaded - replace old file
      try {
        await fs.unlink(orderInfo.image_path);
      } catch (err) {
        console.warn('Could not delete old image:', err.message);
      }
    }

    // Update order with image info
    await dbClient.run(`
      UPDATE metal_print_orders
      SET
        image_path = ?,
        image_width = ?,
        image_height = ?,
        marketing_consent = ?,
        uploaded_at = datetime('now'),
        status = 'ready_to_produce'
      WHERE id = ?
    `, [req.file.path, parseInt(width), parseInt(height), marketingConsent === 'true' ? 1 : 0, orderInfo.id]);

    console.log(`✅ Metal print image uploaded for order ${order}, item ${item}`);

    // TODO: Send confirmation email
    // TODO: Notify production system

    res.json({
      success: true,
      message: 'Image uploaded successfully',
      orderId: orderInfo.id
    });
  } catch (error) {
    console.error('Error uploading image:', error);

    // Clean up file if it was uploaded
    if (req.file) {
      try {
        await fs.unlink(req.file.path);
      } catch (err) {
        console.warn('Could not clean up file:', err.message);
      }
    }

    res.status(500).json({ success: false, error: 'Upload failed' });
  }
});

/**
 * API: Get pending orders (for admin/production dashboard)
 */
router.get('/api/pending-orders', async (req, res) => {
  try {
    const dbClient = await db.getDb();
    const orders = await dbClient.all(`
      SELECT
        id,
        order_number,
        line_item_id,
        shopify_order_id,
        size,
        price,
        customer_email,
        customer_name,
        image_path,
        image_width,
        image_height,
        marketing_consent,
        status,
        created_at,
        uploaded_at,
        shipping_address_json,
        lumaprints_order_id,
        lumaprints_status,
        tracking_carrier,
        tracking_number,
        sales_channel,
        channel_order_id
      FROM metal_print_orders
      WHERE status IN ('awaiting_upload', 'ready_to_produce', 'in_production')
      ORDER BY
        CASE status
          WHEN 'ready_to_produce' THEN 1
          WHEN 'in_production' THEN 2
          WHEN 'awaiting_upload' THEN 3
        END,
        created_at DESC
    `);

    res.json({
      success: true,
      orders: orders.map(o => ({
        id: o.id,
        orderNumber: o.order_number,
        lineItemId: o.line_item_id,
        shopifyOrderId: o.shopify_order_id,
        size: o.size,
        price: o.price,
        customerEmail: o.customer_email,
        customerName: o.customer_name,
        imagePath: o.image_path,
        imageWidth: o.image_width,
        imageHeight: o.image_height,
        marketingConsent: o.marketing_consent === 1,
        status: o.status,
        createdAt: o.created_at,
        uploadedAt: o.uploaded_at,
        hasShippingAddress: !!o.shipping_address_json,
        lumaprintsOrderId: o.lumaprints_order_id,
        lumaprintsStatus: o.lumaprints_status,
        trackingCarrier: o.tracking_carrier,
        trackingNumber: o.tracking_number,
        salesChannel: o.sales_channel || 'shopify',
        channelOrderId: o.channel_order_id
      }))
    });
  } catch (error) {
    console.error('Error fetching pending orders:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * API: Update order status
 */
router.post('/api/update-status', async (req, res) => {
  try {
    const { orderId, status } = req.body;

    if (!orderId || !status) {
      return res.status(400).json({ success: false, error: 'Missing orderId or status' });
    }

    const validStatuses = ['awaiting_upload', 'ready_to_produce', 'in_production', 'shipped', 'completed'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, error: 'Invalid status' });
    }

    const dbClient = await db.getDb();

    // Set timestamp fields based on status
    const timestampField = status === 'in_production' ? 'produced_at' :
                          status === 'shipped' ? 'shipped_at' : null;

    let query = `UPDATE metal_print_orders SET status = ?`;
    const params = [status];

    if (timestampField) {
      query += `, ${timestampField} = datetime('now')`;
    }

    query += ` WHERE id = ?`;
    params.push(orderId);

    await dbClient.run(query, params);

    console.log(`✅ Metal print order ${orderId} status updated to ${status}`);

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating order status:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * API: Get order image (for admin viewing)
 */
router.get('/api/order-image/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;

    const dbClient = await db.getDb();
    const order = await dbClient.get(`
      SELECT image_path
      FROM metal_print_orders
      WHERE id = ?
    `, [orderId]);

    if (!order || !order.image_path) {
      return res.status(404).json({ success: false, error: 'Image not found' });
    }

    // Check if file exists
    try {
      await fs.access(order.image_path);
    } catch {
      return res.status(404).json({ success: false, error: 'Image file not found on disk' });
    }

    // Send file
    res.sendFile(path.resolve(order.image_path));
  } catch (error) {
    console.error('Error fetching order image:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * Shopify webhook: Order created
 * Automatically create metal print order when Shopify order contains metal print product
 */
async function handleShopifyOrderCreated(shopifyOrder) {
  try {
    // Find metal print line items
    // Product SKU or title should contain "Premium Metal Print" or similar identifier
    const metalPrintItems = shopifyOrder.line_items.filter(item => {
      return item.title?.includes('Premium Metal Print') ||
             item.sku?.includes('METAL-PRINT');
    });

    if (metalPrintItems.length === 0) {
      return; // No metal prints in this order
    }

    console.log(`📦 Found ${metalPrintItems.length} metal print(s) in order ${shopifyOrder.order_number}`);

    // Extract shipping address from Shopify order
    const shippingAddr = shopifyOrder.shipping_address;
    const shippingAddress = shippingAddr ? {
      firstName: shippingAddr.first_name || '',
      lastName: shippingAddr.last_name || '',
      company: shippingAddr.company || '',
      addressLine1: shippingAddr.address1 || '',
      addressLine2: shippingAddr.address2 || '',
      city: shippingAddr.city || '',
      state: shippingAddr.province_code || shippingAddr.province || '',
      zipCode: shippingAddr.zip || '',
      country: shippingAddr.country_code || 'US',
      phone: shippingAddr.phone || shopifyOrder.phone || ''
    } : null;

    for (const item of metalPrintItems) {
      // Parse size from variant title (e.g., "5x7", "8x10", "11x17")
      const size = item.variant_title || 'Unknown';

      const orderData = {
        orderNumber: shopifyOrder.order_number.toString(),
        lineItemId: item.id.toString(),
        shopifyOrderId: shopifyOrder.id.toString(),
        size,
        price: parseFloat(item.price),
        customerEmail: shopifyOrder.email,
        customerName: `${shopifyOrder.customer?.first_name || ''} ${shopifyOrder.customer?.last_name || ''}`.trim(),
        shippingAddress
      };

      const uploadToken = await createMetalPrintOrder(orderData);
      const uploadUrl = getUploadUrl(orderData.orderNumber, orderData.lineItemId, uploadToken);

      console.log(`✅ Created metal print order: ${orderData.orderNumber}-${orderData.lineItemId}`);
      console.log(`   Upload URL: ${uploadUrl}`);

      // TODO: Send email with upload link
      // await sendUploadEmail(orderData.customerEmail, uploadUrl, size);
    }
  } catch (error) {
    console.error('Error handling Shopify order webhook:', error);
  }
}

/**
 * API: Send order to Lumaprints POD fulfillment
 */
router.post('/api/send-to-pod', async (req, res) => {
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({ success: false, error: 'Order ID required' });
    }

    const dbClient = await db.getDb();
    const order = await dbClient.get(`
      SELECT id, order_number, line_item_id, size, price, customer_email, customer_name,
             image_path, shipping_address_json, lumaprints_order_id, status
      FROM metal_print_orders
      WHERE id = ?
    `, [orderId]);

    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    // Check if already sent
    if (order.lumaprints_order_id) {
      return res.status(400).json({
        success: false,
        error: 'Order already sent to Lumaprints',
        lumaprintsOrderId: order.lumaprints_order_id
      });
    }

    // Check if image uploaded
    if (!order.image_path) {
      return res.status(400).json({ success: false, error: 'Customer has not uploaded image yet' });
    }

    // Parse shipping address
    let shippingAddress;
    try {
      shippingAddress = order.shipping_address_json ? JSON.parse(order.shipping_address_json) : null;
    } catch (e) {
      shippingAddress = null;
    }

    if (!shippingAddress || !shippingAddress.addressLine1) {
      return res.status(400).json({ success: false, error: 'No shipping address on file for this order' });
    }

    // Build public image URL
    const imageUrl = `${process.env.ASSET_BASE_URL || 'https://blueridgecustomco.com'}/apps/metal-prints/api/order-image/${order.id}`;

    // Load Lumaprints integration
    const lumaprints = require('./integrations/lumaprints');

    // Submit to Lumaprints
    const result = await lumaprints.submitMetalPrintOrder({
      orderId: `${order.order_number}-${order.line_item_id}`,
      recipient: shippingAddress,
      prints: [{
        imageUrl,
        size: order.size,
        quantity: 1,
        surface: 'glossy_white',
        hanging: 'inset_frame'
      }],
      shippingMethod: 'default',
      productionTime: 'regular'
    });

    // Update order with Lumaprints info
    await dbClient.run(`
      UPDATE metal_print_orders
      SET lumaprints_order_id = ?, lumaprints_status = 'submitted', status = 'in_production'
      WHERE id = ?
    `, [result.orderNumber || result.id || 'submitted', orderId]);

    console.log(`✅ Metal print order ${orderId} sent to Lumaprints`);

    res.json({
      success: true,
      message: 'Order sent to Lumaprints for fulfillment',
      lumaprintsOrderId: result.orderNumber || result.id
    });
  } catch (error) {
    console.error('Error sending to Lumaprints:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to send to Lumaprints' });
  }
});

module.exports = {
  router,
  initDatabase,
  createMetalPrintOrder,
  getUploadUrl,
  handleShopifyOrderCreated
};
