# Vinyl Print Station Desktop App

The `print-station` folder contains a lightweight Electron application for Windows operators to manage paid orders, download production assets, and keep the catalog fresh without relying on the browser-based dashboard.

## Features

- **Live print queue** – polls `/api/internal/orders/queue` and highlights newly paid jobs.
- **Order details** – shows customer info, text layers, pricing, and quick links to previews and source files.
- **Completion workflow** – mark jobs as downloaded or completed (writes to the same database fields the web dashboard uses).
- **Catalog browser** – browse and search the generated catalog locally, open artwork directly from the save server.
- **Artwork uploads** – add new designs or categories by uploading previews and vector files; the server regenerates `catalog.json` automatically.

## Prerequisites

1. Node.js ≥ 18 (use the same LTS runtime you installed for the save server; `nvm use 20` is recommended).
2. The save server (`npm run save-server`) must be running with:
   - `LIBRARY_ROOT` pointing at the artwork library (`/mnt/websit` on your host).
   - `ASSET_BASE_URL` set to an HTTP origin that exposes the library (e.g. `http://<server>:4000`).
   - `PRINT_STATION_API_KEY` (or `INTERNAL_API_KEY`) defined if you want to require authentication for internal endpoints.
3. Regenerate the catalog after pulling these changes so design paths are library-relative:
   ```bash
   npm run generate-catalog
   ```

## Install & Run

```bash
cd print-station
npm install
npm run dev   # launches Electron with live reload
```

The first launch prompts you to enter the save server URL, optional asset URL, internal API key, operator name, and polling interval. Settings persist in the user’s app-data folder.

## Run in Docker (macOS troubleshooting)

The repo now ships with a development container so you can launch the Electron app without installing Node/Electron globally on macOS.

1. **Build the image**
   ```bash
   cd print-station
   docker compose build
   ```
2. **Choose your display option**
   - **Interactive UI (recommended):** Install [XQuartz](https://www.xquartz.org/) and enable “Allow connections from network clients” in its preferences. Start XQuartz, then in a terminal:
     ```bash
     xhost +127.0.0.1
     DISPLAY=host.docker.internal:0 docker compose up
     ```
     Electron connects to the host display, so the window appears on your Mac desktop.
   - **Headless logging:** Simply run `docker compose up`. The entrypoint spins up an internal Xvfb display so Electron can boot. You won’t see the UI, but console logs and devtools output are available for debugging.
3. **Persisted data & live edits**
   - The source folder is bind mounted, so edits on the host trigger hot reloads inside the container.
   - `print_station_node_modules` keeps `node_modules` inside Docker (avoids clobbering your host).
   - `print_station_store` holds the Electron settings store so your app configuration survives restarts.

To run the container manually without Compose:

```bash
cd print-station
docker build -t print-station-dev .
docker run --rm -it \
  -e DISPLAY=host.docker.internal:0 \
  -v "$PWD":/app \
  -v print_station_node_modules:/app/node_modules \
  -v print_station_store:/root/.config/print-station-settings \
  print-station-dev
```

Omit the `DISPLAY` line if you want the container to fall back to Xvfb.

### Packaging for Windows

From a Windows machine (or Windows VM with Node/Electron installed):

```bash
npm install
npm run build:win   # produces an NSIS installer in dist/
```

Electron Builder bundles the app as “Vinyl Print Station – Setup.exe”. You can upload the installer to your shared drive for other operators.

## Configuration Fields

| Setting | Purpose |
| ------- | ------- |
| **Save server URL** | Base URL for the Node save server (default `http://localhost:4000`). |
| **Asset base URL** | Optional override if catalog images are hosted elsewhere; leave blank to reuse the save server URL. |
| **Internal API key** | Matches `PRINT_STATION_API_KEY` or `INTERNAL_API_KEY` in `.env` so the app can hit `/api/internal/...` routes. |
| **Operator name** | Stored locally and used when you mark an order as downloaded. |
| **Auto-open preview** | When enabled, the preview PNG launches automatically when you select a job. |
| **Polling interval** | How frequently (seconds) the queue is refreshed; minimum 5 seconds. |

## Troubleshooting

- **New jobs don’t appear** – verify the order is paid, then confirm the save server log shows “Queue” calls returning results. Check that the desktop app’s API key matches the server’s `.env`.
- **Images missing in catalog/queue** – ensure `ASSET_BASE_URL` points at the save server origin and re-run `npm run generate-catalog` so `catalog.json` stores library-relative paths.
- **Upload failures** – the preview must be PNG/JPG/GIF/WEBP and under 50 MB. Source files must be AI/EPS/PDF/SVG. Errors from the server surface in the status bar.
- **Installer signing** – Electron Builder generates an unsigned NSIS installer by default. Use your usual Windows code-signing workflow if required before distributing internally.

## Repository Layout

```
print-station/
  package.json     # Electron project manifest & build scripts
  src/
    main.js        # Main process (window lifecycle, IPC, API calls)
    preload.js     # Secure bridge exposing whitelisted IPC functions
    renderer/
      index.html   # UI shell with queue, catalog, upload, settings views
      index.js     # Front-end state management and event handlers
      styles.css   # Styling (dark theme to match the print station environment)
```

The desktop app is decoupled from the web dashboard, but it relies on the same save server APIs. Keep the server running in the background so operators receive queue updates and can upload artwork without restarting services.
