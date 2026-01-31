# Vinyl Sticker Store Front

This folder now includes a lightweight web app you can use to browse and preview every sticker design before sending an order.

## Get set up

1. Install dependencies (only needed once after cloning or updating dependencies):
   ```bash
   npm install
   ```

2. Regenerate the product catalog whenever you add or remove artwork files:
   ```bash
   export LIBRARY_ROOT=/mnt/websit   # ensure this matches your artwork library root
   node scripts/generate-catalog.js
   ```
   This scans every category folder (ANGELS, BIRDS, etc.) and writes `web/catalog.json`. Only image files (`.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`) are used for previews. Matching vector/source files (`.ai`, `.eps`, `.pdf`, `.svg`) are linked automatically when they share the same filename.

3. Start a simple static server from the project root so the browser can load local files without CORS errors:
   ```bash
   # pick one of these options
   python3 -m http.server 8000
   # or, if you have Node's serve utility
   npx serve .
   ```
Then open `http://192.168.0.67:8000/web/` (the root now serves the landing page) or go directly to `http://192.168.0.67:8000/web/catalog.html` to jump straight into the sticker catalog.

4. Run the save server in a second terminal to capture customer mockups and handle authentication:
   ```bash
   export LIBRARY_ROOT=/mnt/websit   # path containing the web folder and artwork categories
   npm run save-server
   ```
   The first run creates `data/store.db` (SQLite). Saved previews (PNG), matching JSON metadata, and order/account records are persisted automatically.
   Configure email credentials with environment variables if you don't want to use the bundled defaults:
   ```bash
   export SMTP_HOST=smtp.dreamhost.com
   export SMTP_PORT=587
   export ACCOUNTS_SMTP_USER=accounts@swayzecustomvinyl.com
   export ACCOUNTS_SMTP_PASS='***REDACTED***'
   export ORDERS_SMTP_USER=orders@swayzecustomvinyl.com
   export ORDERS_SMTP_PASS='***REDACTED***'
   ```
   (The defaults match the credentials you provided, but setting env vars keeps secrets out of the repo.)

   To enable Square checkout links, add your Square credentials as well:
   ```bash
   export SQUARE_ACCESS_TOKEN='your-square-access-token'
   # optional: export SQUARE_LOCATION_ID='your-square-location-id'
   # optional: export SQUARE_ENV=production
   ```
   If no location ID is supplied, the save server will automatically use the first active Square location on your account.

   To receive payment status updates, add a Square webhook pointing to `https://<your-domain>/api/webhooks/square` and subscribe to the `payment.updated` event. Set the signature key as `SQUARE_WEBHOOK_SIGNATURE_KEY` in your environment so the server can verify incoming webhooks.

   Enable SMS alerts (optional) so the crew receives a text whenever a new order or race quote hits the queue.

   SMS via SimpleTexting:
   ```bash
   export SMS_PROVIDER=simpletexting
   export SIMPLETEXTING_API_KEY='your-simpletexting-api-key'
   # optional (if your account requires/uses a specific sender):
   export SIMPLETEXTING_FROM='+15551234567'
   # optional overrides if your account uses a different API base or path
   # export SIMPLETEXTING_API_BASE='https://api.simpletexting.com'
   # export SIMPLETEXTING_SEND_PATH='/v2/messages'
   export SMS_ADMIN_RECIPIENTS='+15559876543,+15557654321'
   ```
   The server only sends texts when SimpleTexting is configured and at least one recipient number is provided in `SMS_ADMIN_RECIPIENTS`.

   > DreamHost expects STARTTLS on port 587 (or implicit SSL on port 465). The mailer automatically enables STARTTLS whenever `SMTP_PORT=587`.

   If you plan to run the print/download station, issue it a private API key:
   ```bash
   export INTERNAL_API_KEY='super-secret-key-for-print-station'
   ```
   The desktop app must send this value in the `x-api-key` header when calling `/api/internal/orders/...`.

5. Open the owner dashboard at `http://192.168.0.67:8000/web/admin.html` to review new requests, toggle payment status, and download production files. The dashboard talks to the save server on port 4000, so keep it running in the background.

### Enable HTTPS on the save server

- Point `ASSET_BASE_URL` in `.env` at the public HTTPS origin (for example `https://store.swayzecustomvinyl.com`) so kiosk and admin tools resolve artwork correctly.
- To terminate TLS directly inside the Node service, supply certificate paths before starting:
  ```bash
  export HTTPS_KEY_PATH=/etc/letsencrypt/live/store.swayzecustomvinyl.com/privkey.pem
  export HTTPS_CERT_PATH=/etc/letsencrypt/live/store.swayzecustomvinyl.com/fullchain.pem
  # optional:
  # export HTTPS_CA_PATH=/etc/letsencrypt/live/store.swayzecustomvinyl.com/chain.pem
  # export HTTPS_PASSPHRASE='your-key-passphrase'
  npm run save-server
  ```
- When these variables are present and readable, the API will serve `https://` directly. If they are omitted (or the files cannot be read) the server falls back to plain HTTP on the same port, so you can still reverse-proxy through Nginx/Apache if you prefer.

## Kiosk Display System

The kiosk system drives remote display screens at trade shows, markets, and in-store TVs. It uses WebSockets so an admin can push content to any connected screen in real time.

### URLs

| Page | URL | Purpose |
|------|-----|---------|
| **Admin Panel** | `https://store.swayzecustomvinyl.com/kiosk-admin?key=YOUR_API_KEY` | Control panel for managing all connected displays |
| **Display Client** | `https://store.swayzecustomvinyl.com/kiosk?key=YOUR_API_KEY` | Full-screen display page (runs on kiosk devices) |
| **Kiosk Storefront** | `https://store.swayzecustomvinyl.com/kiosk.html` | Customer-facing sticker builder for booths/tablets |

Replace `YOUR_API_KEY` with the value of `INTERNAL_API_KEY` from your `.env` file.

### Admin Panel Features

- **Displays tab** -- see all connected screens, push content (welcome, QR code, social handles, images, slideshows, "now printing" status), rename displays
- **Promotions tab** -- upload promotional images/banners, set schedules, assign to specific displays or broadcast to all
- **Shopify tab** -- pull product collections from Shopify, build product slideshows for displays
- **Service Slides** -- rotating HTML slide decks that cycle across displays automatically
- **Broadcast** -- send the same content to every connected display at once

### Content Types

The admin can push these content types to any display:

- `welcome` -- branded welcome screen with service list
- `qr` -- large QR code pointing customers to the online store
- `social` -- social media handles
- `image` -- any uploaded image/banner
- `video` -- looping video content
- `slideshow` -- auto-advancing image carousel
- `shopify-slideshow` -- product showcase from Shopify collections
- `now-printing` -- live job preview with progress bar
- `rally` -- motorsport team card (car number, team name, series)

### API Endpoints

All endpoints require `?key=YOUR_API_KEY` query param or `x-api-key` header.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/kiosk/displays` | List connected displays |
| GET | `/api/kiosk/content` | List available content items |
| GET | `/api/kiosk/campaigns` | Get campaigns for slideshow display |
| POST | `/api/kiosk/display/:id/content` | Push content to a specific display |
| POST | `/api/kiosk/display/:id/rename` | Rename a display |
| POST | `/api/kiosk/broadcast` | Send content to all displays |
| GET | `/api/kiosk/promotions` | List all promotions |
| POST | `/api/kiosk/promotions` | Create a promotion (multipart upload) |
| PUT | `/api/kiosk/promotions/:id` | Update a promotion |
| DELETE | `/api/kiosk/promotions/:id` | Delete a promotion |
| GET | `/api/kiosk/shopify/collections` | List Shopify collections |
| POST | `/api/kiosk/shopify/slideshow` | Save a Shopify slideshow config |
| POST | `/api/kiosk/rotating-slides` | Toggle rotating service slides |

### Kiosk Storefront (Trade-Show Booth)

The customer-facing kiosk at `/kiosk.html` provides a simple canvas, sticker pricing, catalog artwork picker, and a lightweight checkout form designed for trade-show booths or in-store tablets. Payment is flagged as **awaiting collection** so the print station team can take cash or run Square before completing the job. Regenerate the catalog (`npm run generate-catalog`) after adding new artwork so the kiosk sees the latest graphics.

### Raspberry Pi Kiosk Setup

Use a Raspberry Pi (3B+ or newer recommended) to drive a TV or monitor as a kiosk display.

#### 1. Flash the OS

1. Download **Raspberry Pi OS Lite (64-bit)** from https://www.raspberrypi.com/software/
2. Flash to an SD card with Raspberry Pi Imager
3. In Imager settings, enable SSH, set hostname (e.g. `kiosk-1`), configure Wi-Fi credentials, and set a password

#### 2. Boot and Update

```bash
sudo apt update && sudo apt upgrade -y
```

#### 3. Install Display Server and Chromium

```bash
# Install X server, Chromium, and utilities
sudo apt install -y xserver-xorg x11-xserver-utils xinit chromium-browser unclutter
```

#### 4. Configure Auto-Login

```bash
sudo raspi-config
# Navigate to: System Options > Boot / Auto Login > Console Autologin
```

#### 5. Create the Kiosk Launch Script

```bash
cat > ~/kiosk.sh << 'SCRIPT'
#!/bin/bash

# Disable screen blanking and power management
xset s off
xset -dpms
xset s noblank

# Hide the mouse cursor after 3 seconds of inactivity
unclutter -idle 3 -root &

# Wait for network connectivity
sleep 5

# Launch Chromium in kiosk mode
chromium-browser \
  --noerrdialogs \
  --disable-infobars \
  --kiosk \
  --incognito \
  --disable-translate \
  --no-first-run \
  --fast \
  --fast-start \
  --disable-features=TranslateUI \
  --disk-cache-dir=/dev/null \
  --overscroll-history-navigation=0 \
  --disable-pinch \
  'https://store.swayzecustomvinyl.com/kiosk?key=YOUR_API_KEY'
SCRIPT
chmod +x ~/kiosk.sh
```

Replace `YOUR_API_KEY` with the `INTERNAL_API_KEY` value from your server `.env`.

#### 6. Auto-Start on Boot

Add to the end of `~/.bash_profile` (create if it doesn't exist):

```bash
# Start kiosk on login (only on tty1)
if [ -z "$DISPLAY" ] && [ "$(tty)" = "/dev/tty1" ]; then
  startx ~/kiosk.sh -- -nocursor
fi
```

#### 7. Prevent Screen Blanking

```bash
# Disable console blanking
sudo bash -c 'echo "consoleblank=0" >> /boot/cmdline.txt'
```

#### 8. Optional: Rotate Display

If the TV is mounted vertically:

```bash
# Add to /boot/config.txt
echo "display_rotate=1" | sudo tee -a /boot/config.txt
# 0=normal, 1=90°, 2=180°, 3=270°
```

#### 9. Optional: Scheduled Reboot

Keep things fresh with a nightly reboot:

```bash
# Reboot at 4 AM daily
echo "0 4 * * * /sbin/reboot" | sudo crontab -
```

#### 10. Reboot

```bash
sudo reboot
```

The Pi will boot directly into a full-screen Chromium window showing the kiosk display. The admin panel will show it as a connected display and you can push content to it remotely.

#### Troubleshooting

- **Black screen**: Check Wi-Fi connection (`ping store.swayzecustomvinyl.com`), verify the API key in `~/kiosk.sh`
- **Display not appearing in admin**: The WebSocket connects on page load -- check the browser console via VNC or SSH X-forwarding (`DISPLAY=:0 chromium-browser --remote-debugging-port=9222`)
- **Screen goes blank after idle**: Verify `xset` commands in `kiosk.sh` and `consoleblank=0` in `/boot/cmdline.txt`
- **Wrong resolution**: Force HDMI resolution in `/boot/config.txt`:
  ```
  hdmi_group=1
  hdmi_mode=16   # 1080p 60Hz
  ```

## Using the app

- Pick a category, search/filter designs, and click a card to load it in the preview panel.
- Adjust the slider to choose the approximate width (the canvas displays at ~20 px per inch), pick a vinyl color, and change the background color to mimic the vehicle’s paint.
- Layer custom text: choose fonts, size, color, rotation, and curvature, then drag each line exactly where you want it on the design.
- Collect the customer’s name, email, phone, and mailing address right in the order form so the request is tied to their contact info.
- Add the selection to the order summary, tweak quantities/notes, and use **Create order email** to draft a message you can send to customers or internally.
- Showcase motorsport work with the dedicated race packages page at `web/racing.html` (includes the current season promo for free crew tees).

> Tip: The preview masking works best on designs with a light background. If a design loses detail, keep both the color preview and the original thumbnail handy for customers.

Feel free to customize the styling in `web/styles.css` or tweak the interaction logic in `web/script.js` as you gather feedback from shoppers.

## Owner dashboard capabilities

- See every saved request with a live preview, size/color selections, notes, and custom text layers.
- Download the high-res preview PNG and auto-captured AI/EPS/PDF source files for immediate vinyl cutting.
- Mark orders as paid/unpaid — changes persist in the metadata so you can refresh or revisit later.
- Click **Refresh** to pull in the latest files without restarting the dashboard.

## Customer portal

- Give returning shoppers access to `http://localhost:8000/web/customer.html`.
- Customers create a password-protected account (email + password, optionally phone/address) or sign in if they already registered.
- Each order card shows its payment status, preview, notes, and download links for the production files you shared.
- Customers can tap **Re-order** to duplicate a previous design; the copy lands in your dashboard queue with a fresh timestamp so you can confirm payment and cut the vinyl again.
- Account tools include email confirmation and password reset links (tokens are returned in responses for now—wire them to your email provider when ready).
- Resend-verification and reset-password emails are now sent via DreamHost SMTP; update the environment variables above if you rotate credentials.
- Every order is assigned a sequential order number (starting at 1000) for easy cross-referencing in dashboards, emails, and production logs.
