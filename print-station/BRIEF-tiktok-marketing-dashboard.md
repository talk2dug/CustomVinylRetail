# Brief: TikTok Marketing Dashboard for Print Station

## Overview

Add a new view to the Print Station Electron app that gives the owner visibility and control over the autonomous marketing team's TikTok video pipeline. This is a dashboard for reviewing, approving, and tracking TikTok content before and after it goes live.

## Architecture Context

- **Electron app**: `/home/ubuntu/vinylApp/print-station/`
- **Renderer views**: `src/renderer/` (vanilla JS, no React/Vue)
- **View pattern**: each view is a JS file in `src/renderer/` with a corresponding HTML section in `src/renderer/index.html`. Views are switched via `switchView()`.
- **IPC pattern**: `main.js` has `ipcMain.handle()` handlers → calls server API via `slicerFetch()`. `preload.js` exposes methods via `contextBridge`. Renderer calls `printStation.slicer.fetch()` for server API access.
- **Server API base**: `http://<server>:4000` with `X-API-Key` header
- **Existing view examples**: `slicer-view.js`, `printer-fleet-view.js`, `build-plate-view.js`
- **CSS**: `src/renderer/styles.css` — uses CSS variables (--bg, --card, --accent, --border, etc.), `.dashboard-card`, `.inventory-table`, `.modal` patterns
- **Three existing modal patterns in the codebase** to reference: `fleetAiMonitorModal`, `fleetDetailModal`, `fleetWebUIModal` in `printer-fleet-view.js`

## What to Build

### 1. Pipeline Launcher Panel

A section at the top of the view where the user can:

- **Select a design collection** from a dropdown populated by the catalog categories
  - API: `GET /api/catalog` → returns `{ categories: [{ name, slug, designs: [...] }] }`
- **Kick off the full pipeline** with one button click
  - API: `POST /api/apparel-pipeline/run` with `{ "category": "<collection name>" }`
  - Returns immediately with `{ status: "started" }` — pipeline runs in background
- **Show pipeline status** — a progress area that updates:
  - "Categorizing designs..." → "Generating mockups..." → "Publishing to Shopify..." → "Creating reels..."
  - The pipeline sends Telegram notifications at each step; polling the batch-mockups and shopify-apparel APIs can give progress
- **Pipeline history** — list of previous pipeline runs (stored in manifests at `/mnt/dbFiles/apparel-mockups/batch_*.json` and `shopify_publish_*.json`, accessible via `GET /api/batch-mockups/manifests`)

### 2. TikTok Video Preview & Approval Area

The main content area showing all generated TikTok videos:

- **Video grid/list** showing all generated TikTok videos
  - API: `GET /api/tiktok-videos` → returns array of `{ filename, url, size, duration, createdAt }`
  - Videos are served at `GET /api/tiktok-videos/<filename>.mp4`
- **Each video card shows**:
  - Video thumbnail (first frame or embedded `<video>` player with controls)
  - Duration, file size, creation date
  - Template used (if available from filename: `tiktok-pinup-collection-*`, `tiktok-product-reveal-*`, `tiktok-behind-the-scenes-*`, etc.)
  - Status: Draft / Approved / Published / Rejected
- **Preview modal**: Click a video to open a modal with:
  - Full video player (HTML5 `<video>` element)
  - Approve / Reject buttons
  - Option to add/edit caption text before publishing
  - "Regenerate" button to create a new version
  - Delete button
- **Approval workflow**:
  - Videos start as "Draft"
  - Owner clicks "Approve" → status changes, video is queued for posting
  - Owner clicks "Reject" → video is marked rejected, won't be posted
  - This needs a simple tracking mechanism — could be a JSON file or a DB table `tiktok_videos` with columns: `id, filename, url, template, status (draft|approved|published|rejected), caption, published_at, created_at`

### 3. Published Videos Tracker

A table/section showing videos that have been published:

- **Published date and time**
- **Platform** (TikTok, Facebook, Instagram)
- **Engagement metrics** (if available — views, likes, comments, shares)
  - Initially this can be placeholder columns that get filled in later as we integrate platform analytics
- **Link to the live post** (if URL is known)
- **Which collection/designs the video featured**
- **Sort by date, filter by platform**

### 4. Video Templates Section

Show available video templates and let the user trigger generation:

- API: `GET /api/tiktok-videos/templates` → returns template list with `{ key, name, description, roles, defaultTexts }`
- Each template card shows: name, description, segment count
- "Generate" button on each → opens a modal to customize texts (hook, CTA, etc.) then calls `POST /api/tiktok-videos/assemble`

## API Endpoints Summary

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/api/catalog` | List design collections |
| `POST` | `/api/apparel-pipeline/run` | Start full pipeline `{ category }` |
| `GET` | `/api/batch-mockups` | List generated mockups |
| `GET` | `/api/batch-mockups/manifests` | List batch run results |
| `POST` | `/api/batch-mockups/generate` | Generate mockups `{ category, limit, modelFilter }` |
| `GET` | `/api/shopify-apparel/pricing` | Show pricing config |
| `POST` | `/api/shopify-apparel/publish` | Publish to Shopify `{ category, limit }` |
| `GET` | `/api/tiktok-videos` | List all generated videos |
| `GET` | `/api/tiktok-videos/templates` | List video templates |
| `POST` | `/api/tiktok-videos/assemble` | Generate video from template |
| `GET` | `/api/tiktok-videos/<file>.mp4` | Stream/download video |
| `DELETE` | `/api/tiktok-videos/<file>.mp4` | Delete video |
| `GET` | `/api/human-models` | List models with profiles |
| `POST` | `/api/human-models/<id>/analyze` | Analyze model photo |

## DB Table Needed

Create a `tiktok_videos` table in the main store.db (add via `ensureColumn` or table creation in `db.js`):

```sql
CREATE TABLE IF NOT EXISTS tiktok_videos (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  url TEXT,
  template TEXT,
  collection TEXT,
  designs TEXT,  -- JSON array of design IDs featured
  duration REAL,
  file_size INTEGER,
  status TEXT DEFAULT 'draft',  -- draft, approved, published, rejected
  caption TEXT,
  platform TEXT,  -- tiktok, facebook, instagram
  published_at TEXT,
  published_url TEXT,
  views INTEGER DEFAULT 0,
  likes INTEGER DEFAULT 0,
  comments INTEGER DEFAULT 0,
  shares INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

Add CRUD endpoints for this table:
- `GET /api/tiktok-videos/managed` — list tracked videos with status
- `POST /api/tiktok-videos/managed` — create tracking record
- `PATCH /api/tiktok-videos/managed/:id` — update status, caption, metrics
- `DELETE /api/tiktok-videos/managed/:id` — remove tracking record

## UI Layout (suggested)

```
┌─────────────────────────────────────────────────────┐
│  TikTok Marketing Dashboard                    [⟳] │
├─────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────┐ │
│ │ PIPELINE LAUNCHER                               │ │
│ │ Collection: [dropdown ▾]  [Run Pipeline]        │ │
│ │ Status: Idle / Running... (Step 3/5)            │ │
│ └─────────────────────────────────────────────────┘ │
│                                                     │
│ ┌──── DRAFT VIDEOS (awaiting approval) ──────────┐ │
│ │ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐               │ │
│ │ │video│ │video│ │video│ │video│               │ │
│ │ │thumb│ │thumb│ │thumb│ │thumb│               │ │
│ │ │ 30s │ │ 24s │ │ 15s │ │ 30s │               │ │
│ │ │[✓][✗]│ │[✓][✗]│ │[✓][✗]│ │[✓][✗]│             │ │
│ │ └─────┘ └─────┘ └─────┘ └─────┘               │ │
│ └─────────────────────────────────────────────────┘ │
│                                                     │
│ ┌──── PUBLISHED VIDEOS ──────────────────────────┐ │
│ │ Date       Platform  Views  Likes  Collection   │ │
│ │ 03/28 8am  TikTok    1.2k   89    PinUp Girls  │ │
│ │ 03/27 8am  TikTok    856    45    95 T-Shirts   │ │
│ │ 03/26 8am  Facebook  2.1k   156   Metal Prints  │ │
│ └─────────────────────────────────────────────────┘ │
│                                                     │
│ ┌──── TEMPLATES ─────────────────────────────────┐ │
│ │ Product Reveal │ Behind Scenes │ Quick Showcase │ │
│ │ [Generate]     │ [Generate]    │ [Generate]     │ │
│ └─────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

## Important Notes

- All API calls go through `printStation.slicer.fetch()` which proxies to the server
- Use the existing modal pattern from `printer-fleet-view.js` — create modals dynamically with `document.createElement('div')`, class `modal`, with `modal-dialog` inside
- Videos should be playable inline using HTML5 `<video>` tags pointing at the API URL
- The view should auto-refresh the video list every 30 seconds when visible
- Pipeline status can be polled by checking `GET /api/batch-mockups/manifests` for new entries
- Keep the UI consistent with the existing dark theme (var(--bg), var(--card), var(--accent), etc.)
- Add the view to the navigation sidebar in `index.html` alongside existing views
- Register in `index.js` view switching logic
