# Multiboard Designer - Implementation Spec

## For: Claude Code
## Project: G:/Vinyl Stuff (print-station)
## Deploy: See .vscode/sftp.json for server details, PM2 for process management

---

## Overview

Build a Three.js-based 3D Multiboard wall designer that integrates into the existing print-station Node.js application. The tool lets users design a custom Multiboard wall layout by placing tiles and accessories in a 3D environment, then generates an itemized parts list with pricing and a production order.

**Multiboard** is a modular 3D-printed wall organization system. Everything snaps together on a 25mm grid. Tiles mount to the wall, accessories attach to the tiles. We are a licensed reseller building a design + quoting tool.

---

## File Structure

Add these to the existing project:

```
G:/Vinyl Stuff/
├── ... (existing print-station files)
├── public/
│   ├── multiboard/
│   │   ├── designer.html          # Main Three.js app page
│   │   ├── css/
│   │   │   └── designer.css       # UI styling
│   │   ├── js/
│   │   │   ├── designer-app.js    # Main app controller
│   │   │   ├── scene-manager.js   # Three.js scene setup, camera, lighting
│   │   │   ├── grid-system.js     # Wall grid + tile snapping logic
│   │   │   ├── component-library.js  # Part definitions + 3D geometry generators
│   │   │   ├── interaction.js     # Drag/drop, raycasting, selection
│   │   │   ├── parts-list.js      # BOM calculation + pricing
│   │   │   ├── ui-panels.js       # Sidebar UI, property panels, quote display
│   │   │   └── export.js          # Save/load designs, generate PDF quotes
│   │   ├── models/                # (optional future) .glb/.gltf 3D models
│   │   └── textures/              # Grid texture, PLA material textures
├── routes/
│   ├── ... (existing routes)
│   └── multiboard.js             # API routes for designs + orders
├── models/
│   ├── ... (existing models)
│   └── MultiboardDesign.js       # Database model for saved designs
└── data/
    └── multiboard-parts.json     # Part catalog - SINGLE SOURCE OF TRUTH
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| 3D Engine | Three.js r128 (already in project scope) |
| Frontend UI | Vanilla JS + HTML/CSS panels overlaying Three.js canvas |
| Backend | Express.js (existing print-station server) |
| Database | Whatever print-station currently uses |
| Deployment | SFTP + PM2 restart (see .vscode/sftp.json) |

---

## Multiboard Grid System

**CRITICAL** - the entire Multiboard system is on a 25mm grid. Get this right and everything else works.

| Property | Value |
|----------|-------|
| Grid spacing | 25mm between hole centers |
| Tile unit | 1 unit = 25mm. A "4x4" tile = 100mm x 100mm |
| Common tile sizes | 4x4, 6x6, 8x8, 12x12 |
| Tile thickness | ~4-5mm |
| Multiholes (big) | 25mm apart - accept snaps, big thread bolts |
| Pegboard holes (small) | 25mm apart - accept pegboard accessories, small thread bolts |
| Wall standoff | 6.25mm offset from wall |
| Load capacity | ~20kg (44 lbs) per peg hole |

### 3D Coordinate Mapping

- **1 Multiboard unit (25mm) = 1 world unit** in Three.js
- Wall plane sits on the **XY plane at Z=0**
- Tiles placed on XY plane, extending in **+Z** (tile thickness)
- Accessories extend further in **+Z** from tile surface
- Camera starts **facing the wall head-on**, OrbitControls for rotation

---

## Parts Catalog (data/multiboard-parts.json)

This is the SINGLE SOURCE OF TRUTH for all part definitions. Both the Three.js frontend and backend pricing reference this file.

```json
{
  "parts": [
    {
      "id": "tile-4x4",
      "name": "Tile 4x4",
      "category": "tiles",
      "gridWidth": 4,
      "gridHeight": 4,
      "thickness": 0.2,
      "attachesTo": "wall",
      "snapType": null,
      "providesSnaps": ["multihole", "pegboard"],
      "requiresHardware": [
        { "partId": "wall-mount", "qty": 2 }
      ],
      "weightGrams": 30,
      "costUSD": 0.80,
      "priceUSD": 3.00,
      "colors": ["#333333", "#FFFFFF", "#1B5E20", "#1565C0", "#E65100"],
      "geometry": {
        "type": "tile",
        "cornerRadius": 0.1
      }
    },
    {
      "id": "tile-6x6",
      "name": "Tile 6x6",
      "category": "tiles",
      "gridWidth": 6,
      "gridHeight": 6,
      "thickness": 0.2,
      "attachesTo": "wall",
      "snapType": null,
      "providesSnaps": ["multihole", "pegboard"],
      "requiresHardware": [
        { "partId": "wall-mount", "qty": 4 }
      ],
      "weightGrams": 60,
      "costUSD": 1.50,
      "priceUSD": 4.50,
      "colors": ["#333333", "#FFFFFF", "#1B5E20", "#1565C0", "#E65100"],
      "geometry": {
        "type": "tile",
        "cornerRadius": 0.1
      }
    },
    {
      "id": "tile-8x8",
      "name": "Tile 8x8",
      "category": "tiles",
      "gridWidth": 8,
      "gridHeight": 8,
      "thickness": 0.2,
      "attachesTo": "wall",
      "snapType": null,
      "providesSnaps": ["multihole", "pegboard"],
      "requiresHardware": [
        { "partId": "wall-mount", "qty": 4 }
      ],
      "weightGrams": 100,
      "costUSD": 2.50,
      "priceUSD": 6.00,
      "colors": ["#333333", "#FFFFFF", "#1B5E20", "#1565C0", "#E65100"],
      "geometry": {
        "type": "tile",
        "cornerRadius": 0.1
      }
    },
    {
      "id": "wall-mount",
      "name": "Wall Mount Standoff",
      "category": "hardware",
      "gridWidth": 1,
      "gridHeight": 1,
      "thickness": 0.25,
      "attachesTo": "wall",
      "snapType": null,
      "providesSnaps": [],
      "requiresHardware": [],
      "weightGrams": 5,
      "costUSD": 0.15,
      "priceUSD": 0.00,
      "colors": ["#333333"],
      "geometry": { "type": "mount" },
      "hidden": true
    },
    {
      "id": "snap",
      "name": "Snap Connector",
      "category": "hardware",
      "gridWidth": 1,
      "gridHeight": 1,
      "thickness": 0.4,
      "attachesTo": "multihole",
      "snapType": "multihole",
      "providesSnaps": ["pushfit"],
      "requiresHardware": [],
      "weightGrams": 3,
      "costUSD": 0.10,
      "priceUSD": 0.50,
      "colors": ["#333333", "#FFFFFF"],
      "geometry": { "type": "snap" }
    },
    {
      "id": "hook-small",
      "name": "Small Hook",
      "category": "hooks",
      "gridWidth": 1,
      "gridHeight": 1,
      "thickness": 2.0,
      "attachesTo": "pegboard",
      "snapType": "pegboard",
      "providesSnaps": [],
      "requiresHardware": [],
      "weightGrams": 8,
      "costUSD": 0.20,
      "priceUSD": 1.00,
      "colors": ["#333333", "#FFFFFF"],
      "geometry": {
        "type": "hook",
        "style": "single-peg",
        "length": 1.5
      }
    },
    {
      "id": "hook-large",
      "name": "Large Hook",
      "category": "hooks",
      "gridWidth": 1,
      "gridHeight": 2,
      "thickness": 3.0,
      "attachesTo": "pegboard",
      "snapType": "pegboard",
      "providesSnaps": [],
      "requiresHardware": [],
      "weightGrams": 15,
      "costUSD": 0.35,
      "priceUSD": 1.50,
      "colors": ["#333333", "#FFFFFF"],
      "geometry": {
        "type": "hook",
        "style": "double-peg",
        "length": 2.5
      }
    },
    {
      "id": "bin-small",
      "name": "Small Bin",
      "category": "bins",
      "gridWidth": 2,
      "gridHeight": 2,
      "thickness": 2.0,
      "attachesTo": "multihole",
      "snapType": "multihole",
      "providesSnaps": [],
      "requiresHardware": [
        { "partId": "t-bolt", "qty": 2 }
      ],
      "weightGrams": 25,
      "costUSD": 0.60,
      "priceUSD": 2.50,
      "colors": ["#333333", "#FFFFFF", "#1B5E20"],
      "geometry": {
        "type": "bin",
        "depth": 1.5,
        "wallThickness": 0.08
      }
    },
    {
      "id": "bin-large",
      "name": "Large Bin",
      "category": "bins",
      "gridWidth": 3,
      "gridHeight": 3,
      "thickness": 3.0,
      "attachesTo": "multihole",
      "snapType": "multihole",
      "providesSnaps": [],
      "requiresHardware": [
        { "partId": "t-bolt", "qty": 4 }
      ],
      "weightGrams": 45,
      "costUSD": 1.00,
      "priceUSD": 4.00,
      "colors": ["#333333", "#FFFFFF", "#1B5E20"],
      "geometry": {
        "type": "bin",
        "depth": 2.5,
        "wallThickness": 0.08
      }
    },
    {
      "id": "shelf-4",
      "name": "Shelf (4-wide)",
      "category": "shelves",
      "gridWidth": 4,
      "gridHeight": 1,
      "thickness": 2.5,
      "attachesTo": "multihole",
      "snapType": "multihole",
      "providesSnaps": [],
      "requiresHardware": [
        { "partId": "shelf-bracket", "qty": 2 },
        { "partId": "t-bolt", "qty": 4 }
      ],
      "weightGrams": 55,
      "costUSD": 1.50,
      "priceUSD": 5.00,
      "colors": ["#333333", "#FFFFFF"],
      "geometry": {
        "type": "shelf",
        "depth": 3.0
      }
    },
    {
      "id": "shelf-bracket",
      "name": "Shelf Bracket",
      "category": "hardware",
      "gridWidth": 1,
      "gridHeight": 1,
      "thickness": 1.5,
      "attachesTo": "multihole",
      "snapType": "multihole",
      "providesSnaps": [],
      "requiresHardware": [
        { "partId": "t-bolt", "qty": 2 }
      ],
      "weightGrams": 12,
      "costUSD": 0.30,
      "priceUSD": 1.50,
      "colors": ["#333333"],
      "geometry": { "type": "bracket" },
      "hidden": true
    },
    {
      "id": "t-bolt",
      "name": "T-Bolt",
      "category": "hardware",
      "gridWidth": 0,
      "gridHeight": 0,
      "thickness": 0,
      "attachesTo": "thread",
      "snapType": null,
      "providesSnaps": [],
      "requiresHardware": [],
      "weightGrams": 2,
      "costUSD": 0.05,
      "priceUSD": 0.25,
      "colors": ["#333333"],
      "geometry": { "type": "bolt" },
      "hidden": true
    },
    {
      "id": "mid-bolt",
      "name": "Mid-Thread Bolt",
      "category": "hardware",
      "gridWidth": 0,
      "gridHeight": 0,
      "thickness": 0,
      "attachesTo": "thread",
      "snapType": null,
      "providesSnaps": [],
      "requiresHardware": [],
      "weightGrams": 2,
      "costUSD": 0.05,
      "priceUSD": 0.25,
      "colors": ["#333333"],
      "geometry": { "type": "bolt" },
      "hidden": true
    }
  ],
  "serviceRates": {
    "designOnly": { "flat": 35.00 },
    "designBuild": { "perSqFt": 10.00, "minimum": 50.00 },
    "turnkey": { "perSqFt": 17.50, "minimum": 150.00, "perMileBeyond30": 1.00 }
  },
  "colorPresets": [
    { "name": "Black", "hex": "#333333" },
    { "name": "White", "hex": "#FFFFFF" },
    { "name": "Slate Gray", "hex": "#5D6D7E" },
    { "name": "Forest Green", "hex": "#1B5E20" },
    { "name": "Navy Blue", "hex": "#1565C0" },
    { "name": "Burnt Orange", "hex": "#E65100" }
  ]
}
```

---

## Design Data Schema

Each saved design is a JSON document:

```json
{
  "id": "uuid",
  "name": "Johnson Garage Wall",
  "customer": {
    "name": "Mike Johnson",
    "phone": "828-555-1234",
    "email": "mike@example.com"
  },
  "wall": { "width": 48, "height": 36, "unit": "inches" },
  "components": [
    {
      "partId": "tile-6x6",
      "position": { "x": 0, "y": 0 },
      "color": "#333333",
      "id": "comp-uuid-1"
    },
    {
      "partId": "hook-small",
      "position": { "x": 2, "y": 3 },
      "attachedTo": "comp-uuid-1",
      "snapPoint": "pegboard",
      "color": "#333333",
      "id": "comp-uuid-2"
    }
  ],
  "serviceLevel": "design-build",
  "pricing": {
    "partsTotal": 145.50,
    "laborTotal": 40.00,
    "installTotal": 0,
    "grandTotal": 185.50
  },
  "status": "quoted",
  "createdAt": "2026-02-11T...",
  "updatedAt": "2026-02-11T..."
}
```

---

## Backend API Endpoints

Add in `routes/multiboard.js`, register in main server file:

| Method | Route | Purpose |
|--------|-------|---------|
| GET | /api/multiboard/parts | Return full parts catalog with pricing |
| GET | /api/multiboard/designs | List saved designs |
| GET | /api/multiboard/designs/:id | Load specific design |
| POST | /api/multiboard/designs | Save new design |
| PUT | /api/multiboard/designs/:id | Update existing design |
| DELETE | /api/multiboard/designs/:id | Delete design |
| POST | /api/multiboard/quote | Generate PDF quote from design data |
| POST | /api/multiboard/order | Create production order from design |

---

## Interaction System

| Action | Behavior |
|--------|----------|
| Place Tile | Select from sidebar → click wall grid → snaps to grid. Green=valid, red=overlap |
| Place Accessory | Select from sidebar → hover tile → valid snap points highlight → click to place |
| Move Part | Click to select (outline highlight) → drag to new position → snaps during drag |
| Delete Part | Select → Delete key or trash icon. Warn if tile has attached accessories |
| Orbit/Zoom | Right-click drag=orbit, scroll=zoom, middle-click=pan. Limit to prevent flipping |
| Color | Picker in sidebar, presets available. Apply to next or selected part |
| Undo/Redo | Ctrl+Z / Ctrl+Y, action history stack |

### Raycasting & Snapping

- Raycaster hits wall plane (Z=0) for tile placement
- Raycaster hits tile surfaces for accessory placement
- Snap to nearest valid grid position (round to nearest integer in world units)
- Different accessories attach to different hole types - check `snapType` vs tile's `providesSnaps`

---

## UI Layout

Full-screen Three.js canvas with overlay panels:

### Left Sidebar: Component Library
- Collapsible categories: Tiles, Hooks, Bins, Shelves
- Each part: thumbnail icon, name, price
- Click to select for placement
- Hidden parts (hardware) don't show here - they're auto-included

### Right Sidebar: Design Properties
- Wall dimensions input (width × height in inches)
- Color picker / preset swatches
- Selected part properties + delete button

### Bottom Panel: Parts List & Quote
- Live-updating BOM as parts are placed
- Columns: Part Name, Qty, Unit Price, Line Total, Weight
- Auto-includes required hardware
- Running totals: Parts, Cost, Weight, Retail Price
- Buttons: "Generate Quote" / "Save Design" / "Create Order"

### Top Bar
- Project name, customer name
- Save / Load / New / Export
- Undo / Redo
- View controls: reset camera, toggle grid, toggle dimensions

---

## Build Phases

### Phase 1: Scene + Grid + Tiles (START HERE)
- [ ] Three.js scene: wall plane, grid overlay, camera, OrbitControls
- [ ] Wall dimension inputs that resize the grid
- [ ] Tile placement: sidebar → click grid → tile snaps
- [ ] Tile overlap detection
- [ ] Select + delete tiles
- [ ] Basic parts list updates on add/remove
- **Test:** Can build a tile layout and see parts count

### Phase 2: Accessories + Snap System
- [ ] Add hooks, bins, shelves to sidebar
- [ ] Snap-point highlighting on tile hover
- [ ] Accessory placement on valid snap points only
- [ ] Auto-include required hardware in BOM
- [ ] Color picker
- **Test:** Full design with tiles + accessories + auto BOM

### Phase 3: Pricing + Quotes
- [ ] Live pricing panel
- [ ] Service level selector (Design Only / Design+Build / Turnkey)
- [ ] Labor cost calculation
- [ ] PDF quote generation
- **Test:** Generate professional quote PDF from design

### Phase 4: Save/Load + Orders
- [ ] Save/load designs via API
- [ ] Customer info fields
- [ ] "Create Order" → print-station production queue
- [ ] Order status tracking
- **Test:** End-to-end from design to production order

### Phase 5: Polish + Tablet Mode
- [ ] Touch-friendly interactions for booth tablet
- [ ] Responsive layout for iPad
- [ ] Preset templates ("Garage Starter", "Kitchen Organizer", etc.)
- [ ] Undo/redo
- [ ] Camera presets
- **Test:** Usable on tablet at farmers market booth

---

## Key Implementation Notes

### Performance
- **DO NOT** render individual holes on tiles as geometry - use texture/bump map
- Use InstancedMesh for repeated small geometry
- Keep total mesh count under 500 for tablet performance

### Three.js Specifics
- Use **r128** (already in project)
- **DO NOT** use THREE.CapsuleGeometry (introduced r142) - use Cylinder+Sphere instead
- OrbitControls: limit polar angle to prevent flipping behind wall
- Set minDistance/maxDistance for zoom bounds
- Separate raycaster targets: wall plane vs. tile surfaces

### 3D Geometry Approach (MVP)
- **Tiles:** BoxGeometry with rounded edges. Hole pattern as texture, NOT individual meshes
- **Hooks:** CylinderGeometry + TubeGeometry along CatmullRomCurve3
- **Bins:** BoxGeometry with open top (remove top face), visible wall thickness
- **Shelves:** Flat BoxGeometry with bracket attachment points
- **Bolts:** Not rendered - auto-included in BOM only

### Data Flow
- Parts catalog loads once from /api/multiboard/parts on page init
- All design state lives client-side in a state manager object
- BOM recalculates on every add/remove/move
- Save/load serializes component array + wall dimensions to JSON

### Deployment
- Check `.vscode/sftp.json` for server connection
- Upload changed files via SFTP
- `pm2 restart [process-name]` after backend changes
- Frontend-only changes (public/) don't need PM2 restart

---

## Pricing Reference

These are ESTIMATES - update in multiboard-parts.json as actual costs are confirmed.

| Part | COGS | Retail | Weight |
|------|------|--------|--------|
| Tile 4x4 | $0.80 | $3.00 | ~30g |
| Tile 6x6 | $1.50 | $4.50 | ~60g |
| Tile 8x8 | $2.50 | $6.00 | ~100g |
| Small Hook | $0.20 | $1.00 | ~8g |
| Large Hook | $0.35 | $1.50 | ~15g |
| Small Bin | $0.60 | $2.50 | ~25g |
| Large Bin | $1.00 | $4.00 | ~45g |
| Shelf (4-wide) | $1.50 | $5.00 | ~55g |
| T-Bolt | $0.05 | $0.25 | ~2g |
| Wall Mount | $0.15 | incl. | ~5g |
