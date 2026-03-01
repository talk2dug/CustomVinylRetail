/**
 * Multiboard Dependency Recipe Engine
 *
 * Matches parts by name/type and resolves their companion hardware.
 * Based on the Multiboard Reference Guide:
 *   - Trays: Method A (light) vs Method B (heavy)
 *   - Bins: flush snaps
 *   - Shelves: bolt-locked brackets + snaps
 *   - Hooks/pegs: self-attaching (no extra hardware)
 *   - Magnet-mount: embedded (no extra hardware)
 */

// ── Helpers ──

/** Convert MU dimensions to CU (1 CU = 2 MU) */
function muToCu(mu) {
  return Math.ceil(mu / 2);
}

// ── Recipes ──
// Each recipe: { id, name, match(part) → bool, resolve(part) → result }
// Result: { requiresHardware: [{partId, qty}], methods?: [{id, name, description, hardware}] }

const RECIPES = [
  // ─── Trays / LU Trays ───
  {
    id: 'tray',
    name: 'Tray (Method Choice)',
    match(part) {
      const n = (part.name || '').toLowerCase();
      return /\btray\b/.test(n) || /\blu\b.*\btray\b/.test(n) || /\bmultibin\b/.test(n);
    },
    resolve(part) {
      const w = part.gridWidth || 2;
      const h = part.gridHeight || 2;
      const cuW = muToCu(w);
      const cuH = muToCu(h);

      // Method A — Light Duty: Drawer Shell + Rail Pop-Ins + Moderate Snaps
      const methodA = {
        id: 'method-a',
        name: 'Method A — Light Duty',
        description: 'Drawer Shell + Rail Pop-Ins + Moderate Snaps. Best for lightweight items.',
        hardware: [
          { partId: 'drawer-shell', qty: 1 },
          { partId: 'rail-popin', qty: 2 },
          { partId: 'moderate-snap', qty: Math.max(2, cuW + cuH) },
          { partId: 'drawer-stopper-pin', qty: 1 }
        ]
      };

      // Method B — Heavy Duty: Bolt-Locked Brackets + Heavy Hook Snap + Snaps + Bolts + Adapters
      const methodB = {
        id: 'method-b',
        name: 'Method B — Heavy Duty',
        description: 'Bolt-Locked Brackets + Heavy Hook Snaps + Locking Bolts. Best for heavy items.',
        hardware: [
          { partId: 'bolt-locked-bracket', qty: 2 },
          { partId: 'heavy-hook-snap', qty: 2 },
          { partId: 'flush-snap', qty: 2 },
          { partId: 'locking-bolt', qty: 4 },
          { partId: 'bracket-multipoint', qty: 2 },
          { partId: 'multipoint-connector', qty: Math.max(2, cuW * cuH) }
        ]
      };

      return {
        requiresHardware: methodA.hardware, // default to lighter method
        methods: [methodA, methodB]
      };
    }
  },

  // ─── Bins (snap-mount) ───
  {
    id: 'bin',
    name: 'Bin',
    match(part) {
      const n = (part.name || '').toLowerCase();
      const type = part._mbType || '';
      return type === 'bin' || /\bbin\b/.test(n);
    },
    resolve(part) {
      const w = part.gridWidth || 2;
      const h = part.gridHeight || 2;
      const snapCount = Math.max(2, Math.ceil((w * h) / 4));
      return {
        requiresHardware: [
          { partId: 'flush-snap', qty: snapCount }
        ]
      };
    }
  },

  // ─── Shelves (bolt-locked) ───
  {
    id: 'shelf',
    name: 'Shelf',
    match(part) {
      const n = (part.name || '').toLowerCase();
      const type = part._mbType || '';
      return type === 'shelf' || /\bshelf\b/.test(n) || /\bshelve?s?\b/.test(n);
    },
    resolve(part) {
      return {
        requiresHardware: [
          { partId: 'shelf-support-bracket', qty: 2 },
          { partId: 'heavy-hook-snap', qty: 2 },
          { partId: 'flush-snap', qty: 2 },
          { partId: 'locking-bolt', qty: 4 }
        ]
      };
    }
  },

  // ─── Hooks / Pegs (self-attaching to pegboard holes) ───
  {
    id: 'hook',
    name: 'Hook / Peg',
    match(part) {
      const n = (part.name || '').toLowerCase();
      const type = part._mbType || '';
      return type === 'hook' || type === 'peg' || /\bhook\b/.test(n) || /\bpeg\b/.test(n);
    },
    resolve() {
      return { requiresHardware: [] };
    }
  },

  // ─── Magnet-mount parts (magnets embedded, no snaps needed) ───
  {
    id: 'magnet',
    name: 'Magnet Mount',
    match(part) {
      const mount = part._mountType || '';
      return mount === 'magnet';
    },
    resolve() {
      return { requiresHardware: [] };
    }
  },

  // ─── DS Snap offset-mount accessories ───
  {
    id: 'ds-snap',
    name: 'DS Snap Mount',
    match(part) {
      const n = (part.name || '').toLowerCase();
      return /\bds[\s-]*snap\b/.test(n);
    },
    resolve() {
      return {
        requiresHardware: [
          { partId: 'ds-snap-a', qty: 1 },
          { partId: 'ds-snap-b', qty: 1 }
        ]
      };
    }
  },

  // ─── Tiles (need wall mounts — already handled by static catalog, but catch dynamic tiles) ───
  {
    id: 'tile',
    name: 'Tile',
    match(part) {
      const type = part._mbType || '';
      return type === 'tile';
    },
    resolve(part) {
      const w = part.gridWidth || 4;
      const h = part.gridHeight || 4;
      const mountCount = (w >= 6 || h >= 6) ? 4 : 2;
      return {
        requiresHardware: [
          { partId: 'wall-mount', qty: mountCount }
        ]
      };
    }
  },

  // ─── Generic snap-mount fallback (accessories that attach to multiholes) ───
  {
    id: 'generic-snap',
    name: 'Generic Snap Mount',
    match(part) {
      const attach = part.attachesTo || '';
      return attach === 'multihole';
    },
    resolve(part) {
      const w = part.gridWidth || 2;
      const h = part.gridHeight || 2;
      const snapCount = Math.max(1, Math.ceil((w * h) / 4));
      return {
        requiresHardware: [
          { partId: 'flush-snap', qty: snapCount }
        ]
      };
    }
  }
];

/**
 * Resolve hardware dependencies for a part.
 * Tries recipes in order; first match wins.
 *
 * @param {object} part - Designer part object (from catalogItemToDesignerPart)
 * @returns {{ requiresHardware: Array<{partId: string, qty: number}>, methods?: Array }}
 */
function resolvePartDependencies(part) {
  for (const recipe of RECIPES) {
    if (recipe.match(part)) {
      return recipe.resolve(part);
    }
  }
  // No recipe matched — no hardware needed
  return { requiresHardware: [] };
}

module.exports = { resolvePartDependencies, RECIPES };
