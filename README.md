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

   Enable Twilio SMS alerts (optional) so the crew receives a text whenever a new order or race quote hits the queue:
   ```bash
   export TWILIO_ACCOUNT_SID=ACxxxx
   export TWILIO_AUTH_TOKEN=super-secret
   export TWILIO_FROM_NUMBER='+15551234567'        # or set TWILIO_MESSAGING_SERVICE_SID
   export SMS_ADMIN_RECIPIENTS='+15559876543,+15557654321'
   ```
   The server only sends texts when all required Twilio values are present and at least one recipient number is configured.

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

## Kiosk Mode

- The kiosk-friendly interface lives at `http://<save-server>:4000/web/kiosk.html`. It provides a simple canvas, sticker pricing, catalog artwork picker, and a lightweight checkout form designed for trade-show booths or in-store tablets.
- Payment is flagged as **awaiting collection** so the print station team can take cash or run Square before completing the job.
- Regenerate the catalog (`npm run generate-catalog`) after adding new artwork so the kiosk sees the latest graphics.

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
