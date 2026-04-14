// ============================================================================
// DECAL MAKER VIEW — Professional decal design tool
// ============================================================================

(function() {
'use strict';

// ---------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------
const DM_DPI = 96;
const DM_MIN_TEXT_HEIGHT_INCHES = 0.25; // Minimum for reliable vinyl cutting
const DM_MIN_TEXT_PX = Math.round(DM_MIN_TEXT_HEIGHT_INCHES * DM_DPI);
const DM_MAX_UNDO = 50;

const DM_PRICING = {
  basePrice: { 3: 350, 4: 375, 6: 425, 8: 550, 10: 700, 12: 850 },
  perExtraColor: 50,
};

const DM_VINYL_SWATCHES = [
  { name: 'White', hex: '#FFFFFF' },
  { name: 'Black', hex: '#000000' },
  { name: 'Red', hex: '#CC0000' },
  { name: 'Blue', hex: '#0055AA' },
  { name: 'Gold', hex: '#DAA520' },
  { name: 'Silver', hex: '#A8A8A8' },
  { name: 'Hot Pink', hex: '#FF1493' },
  { name: 'Orange', hex: '#FF6600' },
  { name: 'Green', hex: '#228B22' },
  { name: 'Purple', hex: '#6A0DAD' },
  { name: 'Teal', hex: '#008080' },
  { name: 'Yellow', hex: '#FFD700' },
];

const DM_FONTS = {
  'Popular': ['Bebas Neue','Montserrat','Oswald','Pacifico','Roboto','Lobster','Anton','Permanent Marker'],
  'Script': ['Dancing Script','Great Vibes','Sacramento','Satisfy','Allura','Tangerine'],
  'Sans-Serif': ['Raleway','Open Sans','Lato','Poppins','Nunito','Quicksand','Inter'],
  'Serif': ['Playfair Display','Merriweather','Lora','Crimson Text','EB Garamond'],
  'Display': ['Righteous','Bangers','Racing Sans One','Rubik Mono One','Bungee','Monoton','Press Start 2P','Black Ops One'],
  'Handwritten': ['Caveat','Shadows Into Light','Patrick Hand','Indie Flower','Amatic SC','Rock Salt','Architects Daughter'],
};

const DM_SIZE_PRESETS = [3, 4, 6, 8, 12];

// ---------------------------------------------------------------------------
// STATE
// ---------------------------------------------------------------------------
const dmState = {
  initialized: false,
  canvas: null,
  widthInches: 4,
  heightInches: 4,
  zoomLevel: 1,
  undoStack: [],
  redoStack: [],
  ignoreChanges: false,
  catalog: null,
  catalogCategories: [],
  selectedCategory: '',
  iconPage: 0,
  iconsPerPage: 40,
  searchQuery: '',
  currentProjectId: null,
  currentProjectName: '',
  selectedColor: '#000000',
};

// ---------------------------------------------------------------------------
// INIT
// ---------------------------------------------------------------------------
function initDecalMakerView() {
  console.log('[DecalMaker] initDecalMakerView called, initialized:', dmState.initialized);
  if (dmState.initialized) return;
  const container = document.getElementById('decalMakerView');
  console.log('[DecalMaker] Container found:', !!container);
  if (!container) return;

  container.innerHTML = buildDecalMakerHTML();
  injectDecalMakerStyles();
  initDecalCanvas();
  initDecalEventHandlers();
  loadDecalCatalog();
  updateDecalPricing();
  dmState.initialized = true;
  console.log('[DecalMaker] Initialized');
}

// ---------------------------------------------------------------------------
// HTML TEMPLATE
// ---------------------------------------------------------------------------
function buildDecalMakerHTML() {
  const fontOptions = Object.entries(DM_FONTS).map(([group, fonts]) =>
    `<optgroup label="${group}">${fonts.map(f => `<option value="${f}" style="font-family:'${f}'">${f}</option>`).join('')}</optgroup>`
  ).join('');

  const swatchHTML = DM_VINYL_SWATCHES.map(s =>
    `<button class="dm-swatch" data-color="${s.hex}" title="${s.name}" style="background:${s.hex};${s.hex === '#FFFFFF' ? 'border:1px solid #555;' : ''}"></button>`
  ).join('');

  const presetBtns = DM_SIZE_PRESETS.map(s =>
    `<button class="dm-size-preset${s === 4 ? ' active' : ''}" data-size="${s}">${s}"</button>`
  ).join('');

  return `
  <!-- TOP TOOLBAR -->
  <div class="dm-toolbar">
    <div class="dm-toolbar-left">
      <div class="dm-toolbar-group">
        <label class="dm-toolbar-label">Size</label>
        <div class="dm-size-presets">${presetBtns}</div>
        <div class="dm-size-custom">
          <input type="number" id="dmWidthInput" value="4" min="1" max="12" step="0.5" class="dm-size-input" title="Width (inches)">
          <span class="dm-size-x">&times;</span>
          <input type="number" id="dmHeightInput" value="4" min="1" max="12" step="0.5" class="dm-size-input" title="Height (inches)">
          <span class="dm-size-unit">in</span>
        </div>
      </div>
      <div class="dm-toolbar-sep"></div>
      <div class="dm-toolbar-group">
        <button id="dmUndoBtn" class="dm-tb-btn" title="Undo (Ctrl+Z)" disabled>&#8630;</button>
        <button id="dmRedoBtn" class="dm-tb-btn" title="Redo (Ctrl+Y)" disabled>&#8631;</button>
      </div>
      <div class="dm-toolbar-sep"></div>
      <div class="dm-toolbar-group">
        <button id="dmZoomOutBtn" class="dm-tb-btn" title="Zoom Out">-</button>
        <span id="dmZoomLevel" class="dm-zoom-label">100%</span>
        <button id="dmZoomInBtn" class="dm-tb-btn" title="Zoom In">+</button>
        <button id="dmZoomFitBtn" class="dm-tb-btn dm-tb-btn-sm" title="Fit to View">Fit</button>
      </div>
    </div>
    <div class="dm-toolbar-right">
      <div class="dm-price-badge" id="dmPriceBadge">
        <span class="dm-price-label">Est. Price</span>
        <span class="dm-price-value" id="dmPriceValue">$3.75</span>
      </div>
      <div class="dm-color-count-badge" id="dmColorCountBadge">
        <span id="dmColorCount">1</span> color
      </div>
      <div class="dm-toolbar-sep"></div>
      <button id="dmSaveBtn" class="dm-tb-action dm-tb-save">Save</button>
      <button id="dmLoadBtn" class="dm-tb-action dm-tb-load">Load</button>
      <button id="dmExportBtn" class="dm-tb-action dm-tb-export">Export PNG</button>
      <select id="dmSaveCategory" class="dm-save-category">
        <option value="BRCC Created">BRCC Created</option>
        <option value="Customer Made">Customer Made</option>
      </select>
    </div>
  </div>

  <!-- MAIN LAYOUT -->
  <div class="dm-layout">
    <!-- LEFT SIDEBAR: Icon Browser + Text Tools -->
    <div class="dm-sidebar-left">
      <!-- Icon Browser -->
      <div class="dm-panel dm-icon-browser">
        <div class="dm-panel-header">
          <h4>Design Library</h4>
        </div>
        <div class="dm-icon-controls">
          <select id="dmCategorySelect" class="dm-category-select">
            <option value="">Loading categories...</option>
          </select>
          <div class="dm-search-wrap">
            <input type="text" id="dmIconSearch" class="dm-search-input" placeholder="Search icons...">
          </div>
        </div>
        <div id="dmIconGrid" class="dm-icon-grid">
          <div class="dm-icon-placeholder">Select a category to browse icons</div>
        </div>
        <button id="dmLoadMoreBtn" class="dm-load-more" style="display:none;">Load More</button>
      </div>

      <!-- Text Tools -->
      <div class="dm-panel dm-text-tools">
        <div class="dm-panel-header">
          <h4>Text</h4>
        </div>
        <button id="dmAddTextBtn" class="dm-add-text-btn">+ Add Text</button>
        <div class="dm-text-controls">
          <select id="dmFontSelect" class="dm-font-select">${fontOptions}</select>
          <div class="dm-text-row">
            <label class="dm-mini-label">Size</label>
            <input type="range" id="dmFontSizeSlider" min="12" max="200" value="48" class="dm-slider">
            <input type="number" id="dmFontSizeInput" value="48" min="12" max="200" class="dm-num-input dm-num-sm">
          </div>
          <div class="dm-text-height-display" id="dmTextHeightDisplay">
            <span class="dm-height-label">Letter Height:</span>
            <span class="dm-height-value" id="dmTextHeightValue">0.50"</span>
          </div>
          <div class="dm-text-toggles">
            <button id="dmBoldBtn" class="dm-toggle-btn" title="Bold"><b>B</b></button>
            <button id="dmItalicBtn" class="dm-toggle-btn" title="Italic"><i>I</i></button>
            <button id="dmUnderlineBtn" class="dm-toggle-btn" title="Underline"><u>U</u></button>
            <span class="dm-toggle-sep"></span>
            <button id="dmAlignLeftBtn" class="dm-toggle-btn" title="Align Left">&#9776;</button>
            <button id="dmAlignCenterBtn" class="dm-toggle-btn active" title="Align Center">&#9776;</button>
            <button id="dmAlignRightBtn" class="dm-toggle-btn" title="Align Right">&#9776;</button>
          </div>
          <div class="dm-text-row">
            <label class="dm-mini-label">Spacing</label>
            <input type="range" id="dmLetterSpacing" min="-50" max="200" value="0" class="dm-slider">
            <span id="dmLetterSpacingVal" class="dm-slider-val">0</span>
          </div>
        </div>
      </div>
    </div>

    <!-- CENTER: Canvas -->
    <div class="dm-canvas-area">
      <div class="dm-canvas-wrapper" id="dmCanvasWrapper">
        <div class="dm-ruler-corner"></div>
        <div class="dm-ruler-top" id="dmRulerTop"></div>
        <div class="dm-ruler-left" id="dmRulerLeft"></div>
        <div class="dm-canvas-container" id="dmCanvasContainer">
          <canvas id="dmCanvas"></canvas>
        </div>
      </div>
      <div class="dm-canvas-footer">
        <span id="dmCanvasInfo">4" &times; 4" @ 96 DPI</span>
        <span id="dmObjectInfo"></span>
      </div>
    </div>

    <!-- RIGHT SIDEBAR: Properties -->
    <div class="dm-sidebar-right">
      <div class="dm-panel dm-props-panel">
        <div class="dm-panel-header"><h4>Properties</h4></div>
        <div id="dmPropsContent" class="dm-props-content">
          <div class="dm-props-empty">Select an object to edit</div>
        </div>
      </div>

      <div class="dm-panel dm-color-panel">
        <div class="dm-panel-header"><h4>Color</h4></div>
        <div class="dm-color-picker-row">
          <input type="color" id="dmColorPicker" value="#000000" class="dm-color-input">
          <input type="text" id="dmColorHex" value="#000000" class="dm-color-hex" maxlength="7">
        </div>
        <div class="dm-swatch-grid">${swatchHTML}</div>
      </div>

      <div class="dm-panel dm-layers-panel">
        <div class="dm-panel-header">
          <h4>Layers</h4>
          <div class="dm-layer-actions">
            <button id="dmLayerUpBtn" class="dm-layer-btn" title="Bring Forward">&uarr;</button>
            <button id="dmLayerDownBtn" class="dm-layer-btn" title="Send Back">&darr;</button>
          </div>
        </div>
        <div id="dmLayersList" class="dm-layers-list">
          <div class="dm-props-empty">No objects</div>
        </div>
      </div>

      <div class="dm-panel">
        <button id="dmDeleteBtn" class="dm-delete-btn" disabled>Delete Selected</button>
      </div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// STYLES
// ---------------------------------------------------------------------------
function injectDecalMakerStyles() {
  if (document.getElementById('dmStyles')) return;
  const style = document.createElement('style');
  style.id = 'dmStyles';
  style.textContent = `
/* === DECAL MAKER CORE LAYOUT === */
#decalMakerView.active { flex-direction:column; height:100%; overflow:hidden; background:#0d0d1a; }

.dm-toolbar {
  display:flex; justify-content:space-between; align-items:center;
  padding:8px 16px; background:linear-gradient(180deg,#161628,#111122);
  border-bottom:1px solid #2a2a4a; flex-shrink:0; gap:12px; min-height:48px;
}
.dm-toolbar-left, .dm-toolbar-right { display:flex; align-items:center; gap:8px; }
.dm-toolbar-group { display:flex; align-items:center; gap:6px; }
.dm-toolbar-label { font-size:11px; color:#888; text-transform:uppercase; letter-spacing:1px; font-weight:600; }
.dm-toolbar-sep { width:1px; height:24px; background:#2a2a4a; margin:0 4px; }

.dm-tb-btn {
  width:32px; height:32px; border:1px solid #333; border-radius:6px;
  background:#1a1a2e; color:#ccc; font-size:16px; cursor:pointer;
  display:flex; align-items:center; justify-content:center; transition:all .15s;
}
.dm-tb-btn:hover:not(:disabled) { background:#252540; border-color:#555; color:#fff; }
.dm-tb-btn:disabled { opacity:0.3; cursor:default; }
.dm-tb-btn-sm { width:auto; padding:0 10px; font-size:11px; }

.dm-tb-action {
  padding:6px 16px; border:none; border-radius:6px; font-size:12px;
  font-weight:600; cursor:pointer; transition:all .15s;
}
.dm-tb-save { background:linear-gradient(135deg,#10b981,#059669); color:#fff; }
.dm-tb-save:hover { background:linear-gradient(135deg,#34d399,#10b981); }
.dm-tb-load { background:#2a2a4a; color:#ccc; border:1px solid #3a3a5a; }
.dm-tb-load:hover { background:#353550; color:#fff; }
.dm-tb-export { background:linear-gradient(135deg,#3b82f6,#2563eb); color:#fff; }
.dm-tb-export:hover { background:linear-gradient(135deg,#60a5fa,#3b82f6); }

.dm-save-category {
  padding:4px 8px; border:1px solid #333; border-radius:4px;
  background:#1a1a2e; color:#ccc; font-size:11px;
}

.dm-size-presets { display:flex; gap:3px; }
.dm-size-preset {
  padding:4px 10px; border:1px solid #333; border-radius:4px;
  background:#1a1a2e; color:#888; font-size:11px; cursor:pointer; transition:all .15s;
}
.dm-size-preset:hover { border-color:#555; color:#ccc; }
.dm-size-preset.active { background:linear-gradient(135deg,#f59e0b,#d97706); color:#fff; border-color:transparent; }
.dm-size-custom { display:flex; align-items:center; gap:4px; }
.dm-size-input { width:48px; padding:4px 6px; border:1px solid #333; border-radius:4px; background:#1a1a2e; color:#eee; font-size:12px; text-align:center; }
.dm-size-x { color:#555; font-size:12px; }
.dm-size-unit { color:#666; font-size:11px; }

.dm-price-badge {
  display:flex; align-items:center; gap:6px; padding:4px 14px;
  background:linear-gradient(135deg,#064e3b,#065f46); border:1px solid #10b981;
  border-radius:20px;
}
.dm-price-label { font-size:10px; color:#6ee7b7; text-transform:uppercase; letter-spacing:0.5px; }
.dm-price-value { font-size:14px; color:#34d399; font-weight:700; font-family:'Bebas Neue',sans-serif; letter-spacing:1px; }

.dm-color-count-badge {
  padding:4px 12px; background:#1e1e32; border:1px solid #3b82f6;
  border-radius:20px; font-size:11px; color:#93c5fd;
}

.dm-zoom-label { font-size:11px; color:#888; min-width:40px; text-align:center; }

/* === MAIN 3-COLUMN LAYOUT === */
.dm-layout { display:flex; flex:1; overflow:hidden; }

/* === LEFT SIDEBAR === */
.dm-sidebar-left {
  width:280px; min-width:280px; display:flex; flex-direction:column;
  background:#111122; border-right:1px solid #1e1e36; overflow-y:auto;
}

.dm-panel { padding:12px; border-bottom:1px solid #1e1e36; }
.dm-panel-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; }
.dm-panel-header h4 { margin:0; font-size:12px; text-transform:uppercase; letter-spacing:1.5px; color:#888; font-weight:600; }

/* Icon Browser */
.dm-icon-browser { flex:1; display:flex; flex-direction:column; min-height:0; }
.dm-icon-controls { display:flex; flex-direction:column; gap:6px; margin-bottom:10px; }
.dm-category-select {
  width:100%; padding:7px 10px; border:1px solid #2a2a4a; border-radius:6px;
  background:#1a1a2e; color:#eee; font-size:12px;
}
.dm-search-wrap { position:relative; }
.dm-search-input {
  width:100%; padding:7px 10px; border:1px solid #2a2a4a; border-radius:6px;
  background:#1a1a2e; color:#eee; font-size:12px; box-sizing:border-box;
}
.dm-search-input::placeholder { color:#555; }

.dm-icon-grid {
  overflow-y:auto; display:grid;
  grid-template-columns:repeat(3,1fr);
  gap:6px; padding:4px 0;
  max-height:270px; min-height:80px;
}
.dm-icon-thumb {
  aspect-ratio:1; border:1px solid #2a2a4a; border-radius:6px;
  background:#1a1a2e; cursor:pointer; overflow:hidden; transition:all .15s;
  display:flex; align-items:center; justify-content:center; position:relative;
}
.dm-icon-thumb:hover { border-color:#f59e0b; transform:scale(1.05); box-shadow:0 0 12px rgba(245,158,11,0.2); }
.dm-icon-thumb img { width:100%; height:100%; object-fit:contain; padding:4px; }
.dm-icon-placeholder { grid-column:1/-1; text-align:center; color:#555; font-size:12px; padding:30px 10px; }
.dm-load-more {
  width:100%; padding:8px; border:1px dashed #333; border-radius:6px;
  background:transparent; color:#888; font-size:11px; cursor:pointer; margin-top:6px;
}
.dm-load-more:hover { border-color:#f59e0b; color:#f59e0b; }

/* Text Tools */
.dm-text-tools { flex-shrink:0; }
.dm-add-text-btn {
  width:100%; padding:10px; border:2px dashed #3b82f6; border-radius:8px;
  background:rgba(59,130,246,0.08); color:#60a5fa; font-size:13px; font-weight:600;
  cursor:pointer; transition:all .15s; margin-bottom:10px;
}
.dm-add-text-btn:hover { background:rgba(59,130,246,0.15); border-color:#60a5fa; }

.dm-text-controls { display:flex; flex-direction:column; gap:8px; }
.dm-font-select {
  width:100%; padding:6px 8px; border:1px solid #2a2a4a; border-radius:6px;
  background:#1a1a2e; color:#eee; font-size:12px;
}
.dm-text-row { display:flex; align-items:center; gap:6px; }
.dm-mini-label { font-size:10px; color:#666; min-width:40px; text-transform:uppercase; letter-spacing:0.5px; }
.dm-slider { flex:1; accent-color:#f59e0b; }
.dm-num-input { padding:3px 6px; border:1px solid #2a2a4a; border-radius:4px; background:#1a1a2e; color:#eee; font-size:11px; }
.dm-num-sm { width:48px; text-align:center; }
.dm-slider-val { font-size:11px; color:#888; min-width:28px; text-align:right; }

.dm-text-height-display {
  display:flex; align-items:center; justify-content:space-between;
  padding:6px 10px; background:linear-gradient(135deg,#1a2332,#162030);
  border:1px solid #234; border-radius:6px;
}
.dm-height-label { font-size:10px; color:#6ee7b7; text-transform:uppercase; letter-spacing:0.5px; }
.dm-height-value { font-size:16px; color:#34d399; font-weight:700; font-family:'Bebas Neue',sans-serif; letter-spacing:1px; }

.dm-text-toggles { display:flex; gap:3px; align-items:center; }
.dm-toggle-btn {
  width:30px; height:28px; border:1px solid #2a2a4a; border-radius:4px;
  background:#1a1a2e; color:#888; font-size:13px; cursor:pointer; transition:all .15s;
  display:flex; align-items:center; justify-content:center;
}
.dm-toggle-btn:hover { border-color:#555; color:#ccc; }
.dm-toggle-btn.active { background:#2a2a4a; color:#f59e0b; border-color:#f59e0b; }
.dm-toggle-sep { width:1px; height:20px; background:#2a2a4a; margin:0 4px; }

/* === CENTER CANVAS === */
.dm-canvas-area { flex:1; display:flex; flex-direction:column; overflow:hidden; background:#0a0a16; }

.dm-canvas-wrapper {
  flex:1; display:grid; grid-template-columns:28px 1fr; grid-template-rows:28px 1fr;
  overflow:auto; position:relative;
}
.dm-ruler-corner { background:#111122; border-right:1px solid #1e1e36; border-bottom:1px solid #1e1e36; }
.dm-ruler-top {
  background:#111122; border-bottom:1px solid #1e1e36;
  overflow:hidden; position:relative;
}
.dm-ruler-left {
  background:#111122; border-right:1px solid #1e1e36;
  overflow:hidden; position:relative;
}
.dm-canvas-container {
  display:flex; align-items:center; justify-content:center;
  padding:30px; overflow:auto; background:#0a0a16;
}
.dm-canvas-container canvas {
  box-shadow:0 4px 30px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05);
  border-radius:2px;
}

.dm-canvas-footer {
  display:flex; justify-content:space-between; padding:6px 16px;
  background:#111122; border-top:1px solid #1e1e36;
  font-size:11px; color:#555; flex-shrink:0;
}

/* === RIGHT SIDEBAR === */
.dm-sidebar-right {
  width:260px; min-width:260px; display:flex; flex-direction:column;
  background:#111122; border-left:1px solid #1e1e36; overflow-y:auto;
}

.dm-props-content { display:flex; flex-direction:column; gap:8px; }
.dm-props-empty { text-align:center; color:#444; font-size:12px; padding:20px 10px; font-style:italic; }

.dm-props-row { display:flex; align-items:center; gap:6px; }
.dm-props-label { font-size:10px; color:#666; min-width:32px; text-transform:uppercase; letter-spacing:0.5px; }
.dm-props-input {
  flex:1; padding:4px 6px; border:1px solid #2a2a4a; border-radius:4px;
  background:#1a1a2e; color:#eee; font-size:11px; min-width:0;
}

/* Color Panel */
.dm-color-picker-row { display:flex; align-items:center; gap:8px; margin-bottom:8px; }
.dm-color-input { width:40px; height:32px; border:1px solid #333; border-radius:4px; cursor:pointer; background:none; padding:0; }
.dm-color-hex { flex:1; padding:5px 8px; border:1px solid #2a2a4a; border-radius:4px; background:#1a1a2e; color:#eee; font-size:12px; font-family:monospace; }

.dm-swatch-grid { display:grid; grid-template-columns:repeat(6,1fr); gap:4px; }
.dm-swatch {
  aspect-ratio:1; border:2px solid transparent; border-radius:6px;
  cursor:pointer; transition:all .15s;
}
.dm-swatch:hover { transform:scale(1.15); }
.dm-swatch.active { border-color:#f59e0b; box-shadow:0 0 8px rgba(245,158,11,0.4); }

/* Layers Panel */
.dm-layers-list { display:flex; flex-direction:column; gap:3px; max-height:200px; overflow-y:auto; }
.dm-layer-item {
  display:flex; align-items:center; gap:6px; padding:5px 8px;
  background:#1a1a2e; border:1px solid #2a2a4a; border-radius:4px;
  font-size:11px; color:#ccc; cursor:pointer; transition:all .1s;
}
.dm-layer-item:hover { border-color:#555; }
.dm-layer-item.active { border-color:#f59e0b; background:#1e1e36; }
.dm-layer-icon { font-size:10px; color:#666; }
.dm-layer-name { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

.dm-layer-actions { display:flex; gap:3px; }
.dm-layer-btn {
  width:24px; height:24px; border:1px solid #2a2a4a; border-radius:4px;
  background:#1a1a2e; color:#888; font-size:12px; cursor:pointer;
  display:flex; align-items:center; justify-content:center;
}
.dm-layer-btn:hover { border-color:#555; color:#ccc; }

.dm-delete-btn {
  width:100%; padding:8px; border:1px solid #ef4444; border-radius:6px;
  background:rgba(239,68,68,0.1); color:#ef4444; font-size:12px; font-weight:600;
  cursor:pointer; transition:all .15s;
}
.dm-delete-btn:hover:not(:disabled) { background:rgba(239,68,68,0.2); }
.dm-delete-btn:disabled { opacity:0.3; cursor:default; }

/* Project Load Modal */
.dm-modal-overlay {
  position:fixed; inset:0; background:rgba(0,0,0,0.7); z-index:10000;
  display:flex; align-items:center; justify-content:center;
}
.dm-modal {
  background:#1a1a2e; border:1px solid #2a2a4a; border-radius:12px;
  padding:24px; max-width:700px; width:90%; max-height:80vh; overflow-y:auto;
}
.dm-modal h3 { margin:0 0 16px; color:#eee; font-size:16px; }
.dm-modal-close { float:right; background:none; border:none; color:#888; font-size:20px; cursor:pointer; }
.dm-project-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:12px; }
.dm-project-card {
  border:1px solid #2a2a4a; border-radius:8px; background:#111122;
  cursor:pointer; overflow:hidden; transition:all .15s;
}
.dm-project-card:hover { border-color:#f59e0b; transform:translateY(-2px); box-shadow:0 4px 12px rgba(0,0,0,0.3); }
.dm-project-card-preview { width:100%; aspect-ratio:1; background:#0a0a16; display:flex; align-items:center; justify-content:center; }
.dm-project-card-preview img { max-width:100%; max-height:100%; object-fit:contain; }
.dm-project-card-info { padding:8px 10px; }
.dm-project-card-name { font-size:12px; color:#eee; font-weight:600; margin-bottom:2px; }
.dm-project-card-meta { font-size:10px; color:#666; }

/* Scrollbar */
.dm-sidebar-left::-webkit-scrollbar, .dm-sidebar-right::-webkit-scrollbar,
.dm-icon-grid::-webkit-scrollbar, .dm-layers-list::-webkit-scrollbar { width:5px; }
.dm-sidebar-left::-webkit-scrollbar-thumb, .dm-sidebar-right::-webkit-scrollbar-thumb,
.dm-icon-grid::-webkit-scrollbar-thumb, .dm-layers-list::-webkit-scrollbar-thumb {
  background:#333; border-radius:3px;
}
.dm-sidebar-left::-webkit-scrollbar-track, .dm-sidebar-right::-webkit-scrollbar-track { background:transparent; }
`;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// CANVAS INIT
// ---------------------------------------------------------------------------
function initDecalCanvas() {
  const w = dmState.widthInches * DM_DPI;
  const h = dmState.heightInches * DM_DPI;

  dmState.canvas = new fabric.Canvas('dmCanvas', {
    width: w,
    height: h,
    backgroundColor: '#FFFFFF',
    selection: true,
    preserveObjectStacking: true,
  });

  dmState.canvas.on('object:modified', () => saveDecalUndoState());
  dmState.canvas.on('object:added', () => { if (!dmState.ignoreChanges) saveDecalUndoState(); });
  dmState.canvas.on('selection:created', updateDecalPropertiesPanel);
  dmState.canvas.on('selection:updated', updateDecalPropertiesPanel);
  dmState.canvas.on('selection:cleared', updateDecalPropertiesPanel);
  dmState.canvas.on('object:modified', updateDecalColorCount);
  dmState.canvas.on('object:added', updateDecalColorCount);
  dmState.canvas.on('object:removed', updateDecalColorCount);
  dmState.canvas.on('selection:created', updateDecalLayersList);
  dmState.canvas.on('selection:updated', updateDecalLayersList);
  dmState.canvas.on('selection:cleared', updateDecalLayersList);
  dmState.canvas.on('object:added', updateDecalLayersList);
  dmState.canvas.on('object:removed', updateDecalLayersList);

  drawDecalRulers();
  updateDecalCanvasInfo();
  saveDecalUndoState();
}

// ---------------------------------------------------------------------------
// RULERS
// ---------------------------------------------------------------------------
function drawDecalRulers() {
  const topRuler = document.getElementById('dmRulerTop');
  const leftRuler = document.getElementById('dmRulerLeft');
  if (!topRuler || !leftRuler) return;

  const w = dmState.widthInches;
  const h = dmState.heightInches;
  const ppi = DM_DPI * dmState.zoomLevel;

  // Top ruler
  let topHTML = '';
  for (let i = 0; i <= w; i++) {
    const x = i * ppi;
    topHTML += `<div style="position:absolute;left:${x}px;top:0;height:100%;width:1px;background:#333;"></div>`;
    topHTML += `<div style="position:absolute;left:${x + 3}px;top:4px;font-size:9px;color:#555;">${i}</div>`;
    if (i < w) {
      for (let q = 1; q < 4; q++) {
        const qx = x + q * (ppi / 4);
        topHTML += `<div style="position:absolute;left:${qx}px;bottom:0;height:${q === 2 ? '50%' : '30%'};width:1px;background:#222;"></div>`;
      }
    }
  }
  topRuler.innerHTML = topHTML;
  topRuler.style.width = (w * ppi) + 'px';

  // Left ruler
  let leftHTML = '';
  for (let i = 0; i <= h; i++) {
    const y = i * ppi;
    leftHTML += `<div style="position:absolute;top:${y}px;left:0;width:100%;height:1px;background:#333;"></div>`;
    leftHTML += `<div style="position:absolute;top:${y + 3}px;left:4px;font-size:9px;color:#555;">${i}</div>`;
    if (i < h) {
      for (let q = 1; q < 4; q++) {
        const qy = y + q * (ppi / 4);
        leftHTML += `<div style="position:absolute;top:${qy}px;right:0;width:${q === 2 ? '50%' : '30%'};height:1px;background:#222;"></div>`;
      }
    }
  }
  leftRuler.innerHTML = leftHTML;
  leftRuler.style.height = (h * ppi) + 'px';
}

// ---------------------------------------------------------------------------
// EVENT HANDLERS
// ---------------------------------------------------------------------------
function initDecalEventHandlers() {
  // Size presets
  document.querySelectorAll('.dm-size-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const size = parseFloat(btn.dataset.size);
      setDecalSize(size, size);
      document.querySelectorAll('.dm-size-preset').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Custom size inputs
  const widthInput = document.getElementById('dmWidthInput');
  const heightInput = document.getElementById('dmHeightInput');
  if (widthInput) widthInput.addEventListener('change', () => {
    setDecalSize(parseFloat(widthInput.value) || 4, parseFloat(heightInput.value) || 4);
  });
  if (heightInput) heightInput.addEventListener('change', () => {
    setDecalSize(parseFloat(widthInput.value) || 4, parseFloat(heightInput.value) || 4);
  });

  // Zoom
  document.getElementById('dmZoomInBtn')?.addEventListener('click', () => setDecalZoom(dmState.zoomLevel + 0.25));
  document.getElementById('dmZoomOutBtn')?.addEventListener('click', () => setDecalZoom(dmState.zoomLevel - 0.25));
  document.getElementById('dmZoomFitBtn')?.addEventListener('click', fitDecalZoom);

  // Undo/Redo
  document.getElementById('dmUndoBtn')?.addEventListener('click', decalUndo);
  document.getElementById('dmRedoBtn')?.addEventListener('click', decalRedo);

  // Add Text
  document.getElementById('dmAddTextBtn')?.addEventListener('click', addDecalText);

  // Font controls
  document.getElementById('dmFontSelect')?.addEventListener('change', applyDecalTextProp);
  document.getElementById('dmFontSizeSlider')?.addEventListener('input', (e) => {
    document.getElementById('dmFontSizeInput').value = e.target.value;
    applyDecalTextProp();
    updateDecalTextHeight();
  });
  document.getElementById('dmFontSizeInput')?.addEventListener('change', (e) => {
    document.getElementById('dmFontSizeSlider').value = e.target.value;
    applyDecalTextProp();
    updateDecalTextHeight();
  });
  document.getElementById('dmBoldBtn')?.addEventListener('click', () => toggleDecalTextToggle('dmBoldBtn'));
  document.getElementById('dmItalicBtn')?.addEventListener('click', () => toggleDecalTextToggle('dmItalicBtn'));
  document.getElementById('dmUnderlineBtn')?.addEventListener('click', () => toggleDecalTextToggle('dmUnderlineBtn'));

  ['dmAlignLeftBtn','dmAlignCenterBtn','dmAlignRightBtn'].forEach(id => {
    document.getElementById(id)?.addEventListener('click', () => {
      document.querySelectorAll('#dmAlignLeftBtn,#dmAlignCenterBtn,#dmAlignRightBtn').forEach(b => b.classList.remove('active'));
      document.getElementById(id)?.classList.add('active');
      applyDecalTextProp();
    });
  });

  document.getElementById('dmLetterSpacing')?.addEventListener('input', (e) => {
    document.getElementById('dmLetterSpacingVal').textContent = e.target.value;
    applyDecalTextProp();
  });

  // Color picker
  document.getElementById('dmColorPicker')?.addEventListener('input', (e) => {
    dmState.selectedColor = e.target.value;
    document.getElementById('dmColorHex').value = e.target.value;
    applyDecalColor(e.target.value);
  });
  document.getElementById('dmColorHex')?.addEventListener('change', (e) => {
    const hex = e.target.value.startsWith('#') ? e.target.value : '#' + e.target.value;
    dmState.selectedColor = hex;
    document.getElementById('dmColorPicker').value = hex;
    applyDecalColor(hex);
  });
  document.querySelectorAll('.dm-swatch').forEach(btn => {
    btn.addEventListener('click', () => {
      const hex = btn.dataset.color;
      dmState.selectedColor = hex;
      document.getElementById('dmColorPicker').value = hex;
      document.getElementById('dmColorHex').value = hex;
      document.querySelectorAll('.dm-swatch').forEach(s => s.classList.remove('active'));
      btn.classList.add('active');
      applyDecalColor(hex);
    });
  });

  // Layer buttons
  document.getElementById('dmLayerUpBtn')?.addEventListener('click', () => {
    const obj = dmState.canvas?.getActiveObject();
    if (obj) { dmState.canvas.bringForward(obj); dmState.canvas.renderAll(); updateDecalLayersList(); }
  });
  document.getElementById('dmLayerDownBtn')?.addEventListener('click', () => {
    const obj = dmState.canvas?.getActiveObject();
    if (obj) { dmState.canvas.sendBackwards(obj); dmState.canvas.renderAll(); updateDecalLayersList(); }
  });

  // Delete
  document.getElementById('dmDeleteBtn')?.addEventListener('click', () => {
    const obj = dmState.canvas?.getActiveObject();
    if (obj) {
      dmState.canvas.remove(obj);
      dmState.canvas.discardActiveObject();
      dmState.canvas.renderAll();
      saveDecalUndoState();
    }
  });

  // Save / Load / Export
  document.getElementById('dmSaveBtn')?.addEventListener('click', saveDecalProject);
  document.getElementById('dmLoadBtn')?.addEventListener('click', showDecalLoadModal);
  document.getElementById('dmExportBtn')?.addEventListener('click', exportDecalPNG);

  // Search icons
  let searchTimeout;
  document.getElementById('dmIconSearch')?.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      dmState.searchQuery = e.target.value.toLowerCase();
      dmState.iconPage = 0;
      renderDecalIcons();
    }, 300);
  });

  // Category select
  document.getElementById('dmCategorySelect')?.addEventListener('change', (e) => {
    dmState.selectedCategory = e.target.value;
    dmState.iconPage = 0;
    dmState.searchQuery = '';
    document.getElementById('dmIconSearch').value = '';
    renderDecalIcons();
  });

  // Load more
  document.getElementById('dmLoadMoreBtn')?.addEventListener('click', () => {
    dmState.iconPage++;
    renderDecalIcons(true);
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (!dmState.canvas || document.getElementById('decalMakerView')?.style.display === 'none') return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

    if (e.ctrlKey && e.key === 'z') { e.preventDefault(); decalUndo(); }
    if (e.ctrlKey && e.key === 'y') { e.preventDefault(); decalRedo(); }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const obj = dmState.canvas.getActiveObject();
      if (obj && !obj.isEditing) {
        e.preventDefault();
        dmState.canvas.remove(obj);
        dmState.canvas.discardActiveObject();
        dmState.canvas.renderAll();
        saveDecalUndoState();
      }
    }
  });
}

// ---------------------------------------------------------------------------
// CANVAS SIZE
// ---------------------------------------------------------------------------
function setDecalSize(w, h) {
  w = Math.max(1, Math.min(12, w));
  h = Math.max(1, Math.min(12, h));
  dmState.widthInches = w;
  dmState.heightInches = h;

  document.getElementById('dmWidthInput').value = w;
  document.getElementById('dmHeightInput').value = h;

  const canvas = dmState.canvas;
  canvas.setWidth(w * DM_DPI);
  canvas.setHeight(h * DM_DPI);
  canvas.renderAll();

  drawDecalRulers();
  updateDecalCanvasInfo();
  updateDecalPricing();
}

function updateDecalCanvasInfo() {
  const el = document.getElementById('dmCanvasInfo');
  if (el) el.textContent = `${dmState.widthInches}" \u00d7 ${dmState.heightInches}" @ ${DM_DPI} DPI`;
}

// ---------------------------------------------------------------------------
// ZOOM
// ---------------------------------------------------------------------------
function setDecalZoom(level) {
  level = Math.max(0.25, Math.min(4, level));
  dmState.zoomLevel = level;
  const canvas = dmState.canvas;
  canvas.setZoom(level);
  canvas.setWidth(dmState.widthInches * DM_DPI * level);
  canvas.setHeight(dmState.heightInches * DM_DPI * level);
  canvas.renderAll();
  document.getElementById('dmZoomLevel').textContent = Math.round(level * 100) + '%';
  drawDecalRulers();
}

function fitDecalZoom() {
  const container = document.getElementById('dmCanvasContainer');
  if (!container) return;
  const cw = container.clientWidth - 60;
  const ch = container.clientHeight - 60;
  const canvasW = dmState.widthInches * DM_DPI;
  const canvasH = dmState.heightInches * DM_DPI;
  const zoom = Math.min(cw / canvasW, ch / canvasH, 2);
  setDecalZoom(Math.round(zoom * 4) / 4);
}

// ---------------------------------------------------------------------------
// UNDO / REDO
// ---------------------------------------------------------------------------
function saveDecalUndoState() {
  if (dmState.ignoreChanges) return;
  const json = JSON.stringify(dmState.canvas.toJSON(['name']));
  dmState.undoStack.push(json);
  if (dmState.undoStack.length > DM_MAX_UNDO) dmState.undoStack.shift();
  dmState.redoStack = [];
  updateDecalUndoButtons();
}

function decalUndo() {
  if (dmState.undoStack.length <= 1) return;
  const current = dmState.undoStack.pop();
  dmState.redoStack.push(current);
  const prev = dmState.undoStack[dmState.undoStack.length - 1];
  loadDecalCanvasFromJSON(prev);
  updateDecalUndoButtons();
}

function decalRedo() {
  if (dmState.redoStack.length === 0) return;
  const next = dmState.redoStack.pop();
  dmState.undoStack.push(next);
  loadDecalCanvasFromJSON(next);
  updateDecalUndoButtons();
}

function loadDecalCanvasFromJSON(json) {
  dmState.ignoreChanges = true;
  dmState.canvas.loadFromJSON(json, () => {
    dmState.canvas.renderAll();
    dmState.ignoreChanges = false;
    updateDecalLayersList();
    updateDecalColorCount();
  });
}

function updateDecalUndoButtons() {
  const undoBtn = document.getElementById('dmUndoBtn');
  const redoBtn = document.getElementById('dmRedoBtn');
  if (undoBtn) undoBtn.disabled = dmState.undoStack.length <= 1;
  if (redoBtn) redoBtn.disabled = dmState.redoStack.length === 0;
}

// ---------------------------------------------------------------------------
// TEXT
// ---------------------------------------------------------------------------
function addDecalText() {
  const font = document.getElementById('dmFontSelect')?.value || 'Montserrat';
  const size = parseInt(document.getElementById('dmFontSizeInput')?.value) || 48;

  const text = new fabric.IText('Your Text', {
    left: (dmState.widthInches * DM_DPI) / 2,
    top: (dmState.heightInches * DM_DPI) / 2,
    fontFamily: font,
    fontSize: Math.max(size, DM_MIN_TEXT_PX),
    fill: dmState.selectedColor,
    fontWeight: document.getElementById('dmBoldBtn')?.classList.contains('active') ? 'bold' : 'normal',
    fontStyle: document.getElementById('dmItalicBtn')?.classList.contains('active') ? 'italic' : 'normal',
    underline: document.getElementById('dmUnderlineBtn')?.classList.contains('active') || false,
    textAlign: document.getElementById('dmAlignLeftBtn')?.classList.contains('active') ? 'left' :
               document.getElementById('dmAlignRightBtn')?.classList.contains('active') ? 'right' : 'center',
    charSpacing: parseInt(document.getElementById('dmLetterSpacing')?.value) || 0,
    originX: 'center',
    originY: 'center',
    name: 'Text',
  });

  dmState.canvas.add(text);
  dmState.canvas.setActiveObject(text);
  dmState.canvas.renderAll();
  text.enterEditing();
}

function applyDecalTextProp() {
  const obj = dmState.canvas?.getActiveObject();
  if (!obj || obj.type !== 'i-text') return;

  obj.set({
    fontFamily: document.getElementById('dmFontSelect')?.value || obj.fontFamily,
    fontSize: Math.max(parseInt(document.getElementById('dmFontSizeInput')?.value) || obj.fontSize, DM_MIN_TEXT_PX),
    fontWeight: document.getElementById('dmBoldBtn')?.classList.contains('active') ? 'bold' : 'normal',
    fontStyle: document.getElementById('dmItalicBtn')?.classList.contains('active') ? 'italic' : 'normal',
    underline: document.getElementById('dmUnderlineBtn')?.classList.contains('active') || false,
    textAlign: document.getElementById('dmAlignLeftBtn')?.classList.contains('active') ? 'left' :
               document.getElementById('dmAlignRightBtn')?.classList.contains('active') ? 'right' : 'center',
    charSpacing: parseInt(document.getElementById('dmLetterSpacing')?.value) || 0,
  });
  dmState.canvas.renderAll();
  updateDecalTextHeight();
}

function toggleDecalTextToggle(id) {
  document.getElementById(id)?.classList.toggle('active');
  applyDecalTextProp();
}

function updateDecalTextHeight() {
  const el = document.getElementById('dmTextHeightValue');
  if (!el) return;

  const obj = dmState.canvas?.getActiveObject();
  if (obj && obj.type === 'i-text') {
    // Actual rendered height of the text (accounts for font, scale, etc.)
    const heightPx = obj.fontSize * obj.scaleY;
    const heightInches = heightPx / DM_DPI;
    el.textContent = heightInches.toFixed(2) + '"';

    // Also show total bounding box in the footer
    const totalH = (obj.height * obj.scaleY) / DM_DPI;
    const totalW = (obj.width * obj.scaleX) / DM_DPI;
    const footer = document.getElementById('dmObjectInfo');
    if (footer) footer.textContent = `Text: ${totalW.toFixed(2)}" wide \u00d7 ${totalH.toFixed(2)}" tall | Letter height: ${heightInches.toFixed(2)}"`;
  } else {
    el.textContent = '--';
    const footer = document.getElementById('dmObjectInfo');
    if (footer) footer.textContent = obj ? `${((obj.width * obj.scaleX) / DM_DPI).toFixed(2)}" \u00d7 ${((obj.height * obj.scaleY) / DM_DPI).toFixed(2)}"` : '';
  }
}

// ---------------------------------------------------------------------------
// COLOR
// ---------------------------------------------------------------------------
function applyDecalColor(hex) {
  const obj = dmState.canvas?.getActiveObject();
  if (!obj) return;
  obj.set('fill', hex);
  dmState.canvas.renderAll();
  updateDecalColorCount();
}

function updateDecalColorCount() {
  const canvas = dmState.canvas;
  if (!canvas) return;
  const colors = new Set();
  canvas.getObjects().forEach(obj => {
    const fill = obj.fill || obj.stroke;
    if (fill && typeof fill === 'string') colors.add(fill.toUpperCase());
  });
  const count = Math.max(1, colors.size);
  const el = document.getElementById('dmColorCount');
  if (el) el.textContent = count;
  const badge = document.getElementById('dmColorCountBadge');
  if (badge) badge.innerHTML = `<span id="dmColorCount">${count}</span> color${count !== 1 ? 's' : ''}`;
  updateDecalPricing();
}

// ---------------------------------------------------------------------------
// PRICING
// ---------------------------------------------------------------------------
function updateDecalPricing() {
  const maxDim = Math.max(dmState.widthInches, dmState.heightInches);
  const colorCount = parseInt(document.getElementById('dmColorCount')?.textContent) || 1;

  // Find closest size bracket
  const sizes = Object.keys(DM_PRICING.basePrice).map(Number).sort((a, b) => a - b);
  let bracket = sizes[sizes.length - 1];
  for (const s of sizes) {
    if (maxDim <= s) { bracket = s; break; }
  }

  // Interpolate for in-between sizes
  let baseCents = DM_PRICING.basePrice[bracket];
  if (!DM_PRICING.basePrice[bracket]) {
    // Linear interpolation
    const lower = sizes.filter(s => s <= maxDim).pop() || sizes[0];
    const upper = sizes.filter(s => s >= maxDim).shift() || sizes[sizes.length - 1];
    const lPrice = DM_PRICING.basePrice[lower];
    const uPrice = DM_PRICING.basePrice[upper];
    const ratio = upper !== lower ? (maxDim - lower) / (upper - lower) : 0;
    baseCents = Math.round(lPrice + ratio * (uPrice - lPrice));
  }

  const totalCents = baseCents + Math.max(0, colorCount - 1) * DM_PRICING.perExtraColor;
  const el = document.getElementById('dmPriceValue');
  if (el) el.textContent = '$' + (totalCents / 100).toFixed(2);
}

// ---------------------------------------------------------------------------
// PROPERTIES PANEL
// ---------------------------------------------------------------------------
function updateDecalPropertiesPanel() {
  const content = document.getElementById('dmPropsContent');
  const deleteBtn = document.getElementById('dmDeleteBtn');
  if (!content) return;

  const obj = dmState.canvas?.getActiveObject();
  if (!obj) {
    content.innerHTML = '<div class="dm-props-empty">Select an object to edit</div>';
    if (deleteBtn) deleteBtn.disabled = true;
    return;
  }

  if (deleteBtn) deleteBtn.disabled = false;

  const isText = obj.type === 'i-text';
  const wInches = ((obj.width * obj.scaleX) / DM_DPI).toFixed(2);
  const hInches = ((obj.height * obj.scaleY) / DM_DPI).toFixed(2);
  const xInches = (obj.left / DM_DPI).toFixed(2);
  const yInches = (obj.top / DM_DPI).toFixed(2);
  const rotation = Math.round(obj.angle || 0);
  const opacity = Math.round((obj.opacity || 1) * 100);

  let html = `
    <div class="dm-props-row"><span class="dm-props-label">Type</span><span style="color:#ccc;font-size:11px;">${isText ? 'Text' : 'Image'}</span></div>
    <div class="dm-props-row">
      <span class="dm-props-label">Pos</span>
      <input type="number" class="dm-props-input" value="${xInches}" step="0.1" data-prop="left" onchange="dmSetProp(this)"> &times;
      <input type="number" class="dm-props-input" value="${yInches}" step="0.1" data-prop="top" onchange="dmSetProp(this)">
    </div>
    <div class="dm-props-row">
      <span class="dm-props-label">Size</span>
      <input type="number" class="dm-props-input" value="${wInches}" step="0.1" min="0.25" data-prop="width" onchange="dmSetProp(this)"> &times;
      <input type="number" class="dm-props-input" value="${hInches}" step="0.1" min="0.25" data-prop="height" onchange="dmSetProp(this)">
      <span style="font-size:10px;color:#555;">in</span>
    </div>
    <div class="dm-props-row">
      <span class="dm-props-label">Rot</span>
      <input type="range" class="dm-slider" value="${rotation}" min="0" max="360" style="flex:1;" oninput="dmSetRotation(this.value)">
      <span style="font-size:10px;color:#888;min-width:30px;text-align:right;">${rotation}&deg;</span>
    </div>
    <div class="dm-props-row">
      <span class="dm-props-label">Opac</span>
      <input type="range" class="dm-slider" value="${opacity}" min="0" max="100" style="flex:1;" oninput="dmSetOpacity(this.value)">
      <span style="font-size:10px;color:#888;min-width:30px;text-align:right;">${opacity}%</span>
    </div>
  `;

  // Update text controls to match selected text
  if (isText) {
    const fontSel = document.getElementById('dmFontSelect');
    const sizeSl = document.getElementById('dmFontSizeSlider');
    const sizeIn = document.getElementById('dmFontSizeInput');
    if (fontSel) fontSel.value = obj.fontFamily;
    if (sizeSl) sizeSl.value = obj.fontSize;
    if (sizeIn) sizeIn.value = obj.fontSize;
    if (obj.fontWeight === 'bold') document.getElementById('dmBoldBtn')?.classList.add('active');
    else document.getElementById('dmBoldBtn')?.classList.remove('active');
    if (obj.fontStyle === 'italic') document.getElementById('dmItalicBtn')?.classList.add('active');
    else document.getElementById('dmItalicBtn')?.classList.remove('active');
    if (obj.underline) document.getElementById('dmUnderlineBtn')?.classList.add('active');
    else document.getElementById('dmUnderlineBtn')?.classList.remove('active');
    document.querySelectorAll('#dmAlignLeftBtn,#dmAlignCenterBtn,#dmAlignRightBtn').forEach(b => b.classList.remove('active'));
    if (obj.textAlign === 'left') document.getElementById('dmAlignLeftBtn')?.classList.add('active');
    else if (obj.textAlign === 'right') document.getElementById('dmAlignRightBtn')?.classList.add('active');
    else document.getElementById('dmAlignCenterBtn')?.classList.add('active');
    document.getElementById('dmLetterSpacing').value = obj.charSpacing || 0;
    document.getElementById('dmLetterSpacingVal').textContent = obj.charSpacing || 0;
  }

  // Update color picker
  if (obj.fill && typeof obj.fill === 'string') {
    document.getElementById('dmColorPicker').value = obj.fill;
    document.getElementById('dmColorHex').value = obj.fill;
  }

  content.innerHTML = html;
  updateDecalLayersList();
  updateDecalTextHeight();
}

// Global prop setters (called from inline onchange)
window.dmSetProp = function(el) {
  const obj = dmState.canvas?.getActiveObject();
  if (!obj) return;
  const val = parseFloat(el.value);
  const prop = el.dataset.prop;
  if (prop === 'left' || prop === 'top') obj.set(prop, val * DM_DPI);
  else if (prop === 'width') obj.scaleX = (val * DM_DPI) / obj.width;
  else if (prop === 'height') obj.scaleY = (val * DM_DPI) / obj.height;
  dmState.canvas.renderAll();
  saveDecalUndoState();
};

window.dmSetRotation = function(val) {
  const obj = dmState.canvas?.getActiveObject();
  if (!obj) return;
  obj.set('angle', parseInt(val));
  dmState.canvas.renderAll();
};

window.dmSetOpacity = function(val) {
  const obj = dmState.canvas?.getActiveObject();
  if (!obj) return;
  obj.set('opacity', parseInt(val) / 100);
  dmState.canvas.renderAll();
};

// ---------------------------------------------------------------------------
// LAYERS
// ---------------------------------------------------------------------------
function updateDecalLayersList() {
  const list = document.getElementById('dmLayersList');
  if (!list) return;
  const objects = dmState.canvas?.getObjects() || [];
  const activeObj = dmState.canvas?.getActiveObject();

  if (objects.length === 0) {
    list.innerHTML = '<div class="dm-props-empty">No objects</div>';
    return;
  }

  list.innerHTML = [...objects].reverse().map((obj, i) => {
    const realIdx = objects.length - 1 - i;
    const isActive = obj === activeObj;
    const icon = obj.type === 'i-text' ? 'T' : '&#9638;';
    const name = obj.name || (obj.type === 'i-text' ? (obj.text || '').substring(0, 20) : `Object ${realIdx + 1}`);
    return `<div class="dm-layer-item${isActive ? ' active' : ''}" onclick="dmSelectLayer(${realIdx})">
      <span class="dm-layer-icon">${icon}</span>
      <span class="dm-layer-name">${name}</span>
    </div>`;
  }).join('');
}

window.dmSelectLayer = function(idx) {
  const objects = dmState.canvas?.getObjects();
  if (objects && objects[idx]) {
    dmState.canvas.setActiveObject(objects[idx]);
    dmState.canvas.renderAll();
  }
};

// ---------------------------------------------------------------------------
// ICON CATALOG
// ---------------------------------------------------------------------------
async function loadDecalCatalog() {
  try {
    const data = await window.printStation?.decalMaker?.fetchCatalogIcons();
    if (!data) {
      console.warn('[DecalMaker] No catalog data');
      return;
    }

    // The catalog is an object with category arrays
    dmState.catalog = data;
    dmState.catalogCategories = Array.isArray(data.categories)
      ? data.categories.map(c => ({ name: c.name || c.category, designs: c.designs || [] }))
      : Object.keys(data).filter(k => k !== 'metadata').map(k => ({ name: k, designs: data[k] }));

    const select = document.getElementById('dmCategorySelect');
    if (select) {
      select.innerHTML = '<option value="">-- Select Category --</option>' +
        dmState.catalogCategories.map(c =>
          `<option value="${c.name}">${c.name} (${c.designs.length})</option>`
        ).join('');
    }
    console.log(`[DecalMaker] Catalog loaded: ${dmState.catalogCategories.length} categories`);
  } catch (err) {
    console.error('[DecalMaker] Failed to load catalog:', err);
  }
}

function renderDecalIcons(append) {
  const grid = document.getElementById('dmIconGrid');
  const loadMoreBtn = document.getElementById('dmLoadMoreBtn');
  if (!grid) return;

  if (!append) grid.innerHTML = '';

  let designs = [];
  if (dmState.searchQuery) {
    // Search across all categories
    for (const cat of dmState.catalogCategories) {
      for (const d of cat.designs) {
        if ((d.name || d.id || '').toLowerCase().includes(dmState.searchQuery)) {
          designs.push(d);
        }
      }
    }
  } else if (dmState.selectedCategory) {
    const cat = dmState.catalogCategories.find(c => c.name === dmState.selectedCategory);
    if (cat) designs = cat.designs;
  }

  const start = dmState.iconPage * dmState.iconsPerPage;
  const page = designs.slice(start, start + dmState.iconsPerPage);
  const hasMore = start + dmState.iconsPerPage < designs.length;

  if (page.length === 0 && !append) {
    grid.innerHTML = '<div class="dm-icon-placeholder">No icons found</div>';
  }

  for (const d of page) {
    const thumb = document.createElement('div');
    thumb.className = 'dm-icon-thumb';
    thumb.title = d.name || d.id || '';
    thumb.innerHTML = `<img src="${d.image || d.thumbnail || ''}" loading="lazy" alt="${d.name || ''}">`;
    thumb.addEventListener('click', () => addDecalIcon(d));
    grid.appendChild(thumb);
  }

  if (loadMoreBtn) loadMoreBtn.style.display = hasMore ? 'block' : 'none';
}

function addDecalIcon(design) {
  const url = design.image || design.thumbnail;
  if (!url) return;

  fabric.Image.fromURL(url, (img) => {
    if (!img) {
      console.error('[DecalMaker] Failed to load icon image');
      return;
    }

    // Scale to fit 2 inches
    const targetPx = 2 * DM_DPI;
    const scale = targetPx / Math.max(img.width, img.height);

    img.set({
      left: (dmState.widthInches * DM_DPI) / 2,
      top: (dmState.heightInches * DM_DPI) / 2,
      scaleX: scale,
      scaleY: scale,
      originX: 'center',
      originY: 'center',
      name: design.name || 'Icon',
    });

    dmState.canvas.add(img);
    dmState.canvas.setActiveObject(img);
    dmState.canvas.renderAll();
  }, { crossOrigin: 'anonymous' });
}

// ---------------------------------------------------------------------------
// SAVE / LOAD / EXPORT
// ---------------------------------------------------------------------------
function showDecalNameModal(defaultName) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'dm-modal-overlay';
    overlay.innerHTML = `
      <div class="dm-modal" style="max-width:400px;">
        <h3 style="margin:0 0 12px;">Project Name</h3>
        <input type="text" id="dmNameInput" value="${defaultName || ''}"
          style="width:100%;padding:10px;border:1px solid #2a2a4a;border-radius:6px;background:#1a1a2e;color:#eee;font-size:14px;box-sizing:border-box;margin-bottom:16px;"
          autofocus />
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button id="dmNameCancel" class="dm-tb-action dm-tb-load">Cancel</button>
          <button id="dmNameOk" class="dm-tb-action dm-tb-save">Save</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const input = overlay.querySelector('#dmNameInput');
    input.focus();
    input.select();

    const finish = (val) => { overlay.remove(); resolve(val); };

    overlay.querySelector('#dmNameOk').onclick = () => finish(input.value.trim() || null);
    overlay.querySelector('#dmNameCancel').onclick = () => finish(null);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(null); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(input.value.trim() || null);
      if (e.key === 'Escape') finish(null);
    });
  });
}

async function saveDecalProject() {
  const canvas = dmState.canvas;
  if (!canvas) return;

  let name = dmState.currentProjectName;
  if (!name) {
    name = await showDecalNameModal('Decal ' + new Date().toLocaleDateString());
    if (!name) return;
  }

  const category = document.getElementById('dmSaveCategory')?.value || 'BRCC Created';
  const colorCount = parseInt(document.getElementById('dmColorCount')?.textContent) || 1;
  const canvasJSON = JSON.stringify(canvas.toJSON(['name']));
  const previewPNG = canvas.toDataURL({ format: 'png', multiplier: 1 });

  // Collect colors
  const colors = new Set();
  canvas.getObjects().forEach(obj => {
    if (obj.fill && typeof obj.fill === 'string') colors.add(obj.fill);
  });

  const project = {
    name,
    canvas_json: canvasJSON,
    canvas_width_inches: dmState.widthInches,
    canvas_height_inches: dmState.heightInches,
    preview_png: previewPNG,
    category,
    color_count: colorCount,
    colors_used: JSON.stringify([...colors]),
    price_cents: parseDecalPrice(),
    created_by: 'internal',
  };

  try {
    let result;
    if (dmState.currentProjectId) {
      result = await window.printStation.decalMaker.updateProject(dmState.currentProjectId, project);
      if (typeof showToast === 'function') showToast('Project updated!', 'success');
    } else {
      result = await window.printStation.decalMaker.saveProject(project);
      if (result && result.id) dmState.currentProjectId = result.id;
      if (typeof showToast === 'function') showToast('Project saved!', 'success');
    }
    dmState.currentProjectName = name;
  } catch (err) {
    console.error('[DecalMaker] Save failed:', err);
    if (typeof showToast === 'function') showToast('Save failed: ' + err.message, 'error');
  }
}

function parseDecalPrice() {
  const text = document.getElementById('dmPriceValue')?.textContent || '$0';
  return Math.round(parseFloat(text.replace('$', '')) * 100);
}

async function showDecalLoadModal() {
  try {
    const projects = await window.printStation.decalMaker.listProjects({ limit: 50 });
    const list = Array.isArray(projects) ? projects : (projects?.projects || []);

    const overlay = document.createElement('div');
    overlay.className = 'dm-modal-overlay';
    overlay.innerHTML = `
      <div class="dm-modal">
        <button class="dm-modal-close" onclick="this.closest('.dm-modal-overlay').remove()">&times;</button>
        <h3>Load Project</h3>
        ${list.length === 0
          ? '<div class="dm-props-empty">No saved projects</div>'
          : `<div class="dm-project-grid">${list.map(p => `
            <div class="dm-project-card" data-id="${p.id}">
              <div class="dm-project-card-preview">
                ${p.preview_png ? `<img src="${p.preview_png}" alt="${p.name}">` : '<span style="color:#444;">No preview</span>'}
              </div>
              <div class="dm-project-card-info">
                <div class="dm-project-card-name">${p.name || 'Untitled'}</div>
                <div class="dm-project-card-meta">${p.canvas_width_inches || '?'}" x ${p.canvas_height_inches || '?'}" &bull; ${p.category || ''}</div>
              </div>
            </div>
          `).join('')}</div>`
        }
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    overlay.querySelectorAll('.dm-project-card').forEach(card => {
      card.addEventListener('click', async () => {
        const id = card.dataset.id;
        overlay.remove();
        await loadDecalProject(id);
      });
    });
  } catch (err) {
    console.error('[DecalMaker] Load modal failed:', err);
    if (typeof showToast === 'function') showToast('Failed to load projects: ' + err.message, 'error');
  }
}

async function loadDecalProject(id) {
  try {
    const project = await window.printStation.decalMaker.getProject(id);
    if (!project || !project.canvas_json) {
      if (typeof showToast === 'function') showToast('Project data not found', 'error');
      return;
    }

    setDecalSize(project.canvas_width_inches || 4, project.canvas_height_inches || 4);

    dmState.ignoreChanges = true;
    dmState.canvas.loadFromJSON(project.canvas_json, () => {
      dmState.canvas.renderAll();
      dmState.ignoreChanges = false;
      dmState.currentProjectId = id;
      dmState.currentProjectName = project.name || '';
      dmState.undoStack = [JSON.stringify(dmState.canvas.toJSON(['name']))];
      dmState.redoStack = [];
      updateDecalUndoButtons();
      updateDecalColorCount();
      updateDecalLayersList();
      if (typeof showToast === 'function') showToast(`Loaded: ${project.name}`, 'success');
    });
  } catch (err) {
    console.error('[DecalMaker] Load failed:', err);
    if (typeof showToast === 'function') showToast('Load failed: ' + err.message, 'error');
  }
}

function exportDecalPNG() {
  const canvas = dmState.canvas;
  if (!canvas) return;

  // Export at higher resolution (300 DPI equivalent)
  const multiplier = 300 / DM_DPI;
  const dataUrl = canvas.toDataURL({ format: 'png', multiplier });

  const link = document.createElement('a');
  link.download = `decal-${dmState.widthInches}x${dmState.heightInches}-${Date.now()}.png`;
  link.href = dataUrl;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  if (typeof showToast === 'function') showToast('PNG exported at 300 DPI!', 'success');
}

// ---------------------------------------------------------------------------
// EXPOSE
// ---------------------------------------------------------------------------
window.initDecalMakerView = initDecalMakerView;

})();
