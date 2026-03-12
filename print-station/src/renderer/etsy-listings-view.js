/**
 * Etsy Listings View
 *
 * Electron renderer view for managing Etsy listing copy.
 * Fetches generated listings from the server, displays them in a
 * master-detail layout, allows editing, copying to clipboard,
 * and marking as listed.
 */

const etsyState = {
  initialized: false,
  listings: [],
  selectedId: null,
  loading: false
};

// ---------------------------------------------------------------------------
// Server API calls (via fetch to the local server)
// ---------------------------------------------------------------------------

async function etsyFetch(path, options = {}) {
  const base = window.printStation?.getConfig
    ? (await window.printStation.getConfig()).serverUrl || 'http://localhost:4000'
    : 'http://localhost:4000';
  const resp = await fetch(`${base}${path}`, {
    headers: { 'Content-Type': 'application/json', 'x-internal-key': 'laZHEthV92qDq0adO07UnqoH3O4baZmV' },
    ...options
  });
  return resp.json();
}

// ---------------------------------------------------------------------------
// Load listings
// ---------------------------------------------------------------------------

async function etsyLoadListings() {
  const listEl = document.getElementById('etsyListingsList');
  if (!listEl) return;

  listEl.innerHTML = '<div class="placeholder" style="padding:20px;">Loading...</div>';
  etsyState.loading = true;

  try {
    const data = await etsyFetch('/api/etsy-listings');
    etsyState.listings = data.listings || [];
    etsyRenderList();
  } catch (e) {
    listEl.innerHTML = `<div class="placeholder" style="padding:20px;color:red;">Error: ${e.message}</div>`;
  } finally {
    etsyState.loading = false;
  }
}

// ---------------------------------------------------------------------------
// Render listing list
// ---------------------------------------------------------------------------

function etsyRenderList() {
  const listEl = document.getElementById('etsyListingsList');
  if (!listEl) return;

  if (etsyState.listings.length === 0) {
    listEl.innerHTML = '<div class="placeholder" style="padding:20px;">No listings generated yet. Select a collection and click "Generate All".</div>';
    return;
  }

  listEl.innerHTML = etsyState.listings.map(l => {
    const img = (l.image_urls && l.image_urls[0]) || '';
    const statusColor = l.listed_on_etsy ? '#4caf50' : (l.status === 'draft' ? '#ff9800' : '#888');
    const statusText = l.listed_on_etsy ? 'Listed' : 'Draft';
    const selected = etsyState.selectedId === l.id ? 'background:#e3f2fd;' : '';

    return `
      <div class="etsy-listing-item" data-id="${l.id}" style="display:flex;gap:10px;padding:10px;border-bottom:1px solid #eee;cursor:pointer;${selected}">
        ${img ? `<img src="${img}" style="width:60px;height:60px;object-fit:cover;border-radius:6px;border:1px solid #ddd;flex-shrink:0;" />` : '<div style="width:60px;height:60px;background:#f0f0f0;border-radius:6px;flex-shrink:0;"></div>'}
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;font-size:0.9rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtmlEtsy(l.etsy_title || l.original_title)}</div>
          <div style="font-size:0.8rem;color:#888;margin-top:2px;">$${(l.price || 0).toFixed(2)}</div>
          <span style="font-size:0.7rem;padding:2px 6px;border-radius:3px;background:${statusColor};color:white;">${statusText}</span>
        </div>
      </div>
    `;
  }).join('');

  // Click handlers
  listEl.querySelectorAll('.etsy-listing-item').forEach(el => {
    el.addEventListener('click', () => {
      const id = parseInt(el.dataset.id);
      etsySelectListing(id);
    });
  });
}

function escapeHtmlEtsy(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Select and display listing detail
// ---------------------------------------------------------------------------

function etsySelectListing(id) {
  const listing = etsyState.listings.find(l => l.id === id);
  if (!listing) return;

  etsyState.selectedId = id;
  etsyRenderList(); // Update selection highlight

  const detailEl = document.getElementById('etsyListingDetail');
  detailEl.style.display = 'block';

  const img = (listing.image_urls && listing.image_urls[0]) || '';
  document.getElementById('etsyDetailImage').src = img || '';
  document.getElementById('etsyDetailImage').style.display = img ? 'block' : 'none';
  document.getElementById('etsyDetailOrigTitle').textContent = listing.original_title || '';
  document.getElementById('etsyDetailPrice').textContent = `$${(listing.price || 0).toFixed(2)}`;

  const statusEl = document.getElementById('etsyDetailStatus');
  if (listing.listed_on_etsy) {
    statusEl.textContent = 'Listed on Etsy';
    statusEl.style.cssText = 'background:#4caf50;color:white;padding:2px 8px;border-radius:4px;font-size:0.8rem;';
  } else {
    statusEl.textContent = 'Draft';
    statusEl.style.cssText = 'background:#ff9800;color:white;padding:2px 8px;border-radius:4px;font-size:0.8rem;';
  }

  document.getElementById('etsyDetailTitle').value = listing.etsy_title || '';
  document.getElementById('etsyDetailDesc').value = listing.etsy_description || '';
  document.getElementById('etsyDetailTags').value = listing.etsy_tags || '';
  document.getElementById('etsyDetailCategory').textContent = listing.etsy_category || 'Not suggested';

  updateTitleCount();
  updateTagCount();
}

function updateTitleCount() {
  const input = document.getElementById('etsyDetailTitle');
  const count = document.getElementById('etsyDetailTitleCount');
  if (input && count) {
    const len = (input.value || '').length;
    count.textContent = `${len}/140`;
    count.style.color = len > 140 ? 'red' : '#888';
  }
}

function updateTagCount() {
  const input = document.getElementById('etsyDetailTags');
  const count = document.getElementById('etsyDetailTagCount');
  if (input && count) {
    const tags = (input.value || '').split(',').map(t => t.trim()).filter(Boolean);
    count.textContent = `${tags.length}/13 tags`;
    count.style.color = tags.length > 13 ? 'red' : '#888';
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function etsySaveListing() {
  if (!etsyState.selectedId) return;

  const data = {
    etsy_title: document.getElementById('etsyDetailTitle').value,
    etsy_description: document.getElementById('etsyDetailDesc').value,
    etsy_tags: document.getElementById('etsyDetailTags').value
  };

  try {
    await etsyFetch(`/api/etsy-listings/${etsyState.selectedId}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    });
    // Reload to reflect changes
    await etsyLoadListings();
    etsySelectListing(etsyState.selectedId);
  } catch (e) {
    alert('Save failed: ' + e.message);
  }
}

async function etsyRegenerateListing() {
  if (!etsyState.selectedId) return;

  const btn = document.getElementById('etsyDetailRegenBtn');
  btn.disabled = true;
  btn.textContent = 'Generating...';

  try {
    await etsyFetch(`/api/etsy-listings/regenerate/${etsyState.selectedId}`, { method: 'POST' });
    await etsyLoadListings();
    etsySelectListing(etsyState.selectedId);
  } catch (e) {
    alert('Regenerate failed: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Regenerate';
  }
}

async function etsyMarkAsListed() {
  if (!etsyState.selectedId) return;

  try {
    await etsyFetch(`/api/etsy-listings/${etsyState.selectedId}`, {
      method: 'PUT',
      body: JSON.stringify({ listed_on_etsy: true, status: 'listed' })
    });
    await etsyLoadListings();
    etsySelectListing(etsyState.selectedId);
  } catch (e) {
    alert('Failed: ' + e.message);
  }
}

function etsyCopyToClipboard() {
  const title = document.getElementById('etsyDetailTitle').value || '';
  const desc = document.getElementById('etsyDetailDesc').value || '';
  const tags = document.getElementById('etsyDetailTags').value || '';
  const category = document.getElementById('etsyDetailCategory').textContent || '';

  const text = `TITLE:\n${title}\n\nDESCRIPTION:\n${desc}\n\nTAGS:\n${tags}\n\nSUGGESTED CATEGORY:\n${category}`;

  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('etsyDetailCopyBtn');
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = orig; }, 2000);
  }).catch(() => {
    // Fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  });
}

async function etsyGenerateBulk() {
  const collectionId = document.getElementById('etsyCollectionFilter').value;
  const btn = document.getElementById('etsyGenerateBulkBtn');

  btn.disabled = true;
  btn.textContent = 'Generating...';

  const listEl = document.getElementById('etsyListingsList');
  listEl.innerHTML = '<div class="placeholder" style="padding:20px;">Generating listings with AI... This may take a few minutes.</div>';

  try {
    const result = await etsyFetch('/api/etsy-listings/generate', {
      method: 'POST',
      body: JSON.stringify({
        collectionId: collectionId || undefined,
        skipExisting: true,
        limit: 50
      })
    });

    const msg = `Generated: ${result.generated || 0}, Skipped: ${result.skipped || 0}, Failed: ${result.failed || 0}`;
    await etsyLoadListings();
    alert(msg);
  } catch (e) {
    alert('Bulk generation failed: ' + e.message);
    await etsyLoadListings();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate All';
  }
}

// ---------------------------------------------------------------------------
// Load Shopify collections into the filter dropdown
// ---------------------------------------------------------------------------

async function etsyLoadCollections() {
  try {
    const data = await etsyFetch('/api/kiosk/shopify/collections');
    const select = document.getElementById('etsyCollectionFilter');
    if (!select || !data.collections) return;

    // Keep the "All Products" and "Laser Engraving" defaults
    const existing = new Set();
    select.querySelectorAll('option').forEach(o => existing.add(o.value));

    for (const c of data.collections) {
      if (!existing.has(String(c.id))) {
        const opt = document.createElement('option');
        opt.value = String(c.id);
        opt.textContent = c.title;
        select.appendChild(opt);
      }
    }
  } catch (e) {
    console.warn('[EtsyView] Could not load collections:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function initEtsyListingsView() {
  if (etsyState.initialized) {
    etsyLoadListings();
    return;
  }

  // Wire events
  document.getElementById('etsyRefreshBtn')?.addEventListener('click', etsyLoadListings);
  document.getElementById('etsyGenerateBulkBtn')?.addEventListener('click', etsyGenerateBulk);
  document.getElementById('etsyDetailSaveBtn')?.addEventListener('click', etsySaveListing);
  document.getElementById('etsyDetailRegenBtn')?.addEventListener('click', etsyRegenerateListing);
  document.getElementById('etsyDetailCopyBtn')?.addEventListener('click', etsyCopyToClipboard);
  document.getElementById('etsyDetailMarkListedBtn')?.addEventListener('click', etsyMarkAsListed);

  document.getElementById('etsyDetailTitle')?.addEventListener('input', updateTitleCount);
  document.getElementById('etsyDetailTags')?.addEventListener('input', updateTagCount);

  etsyLoadCollections();
  etsyLoadListings();

  etsyState.initialized = true;
}
