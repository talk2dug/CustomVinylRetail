function resolveApiBase(port = '4000') {
  try {
    const current = new URL(window.location.href);
    const isDefaultPort = !current.port || current.port === '80' || current.port === '443';
    if (isDefaultPort) {
      return current.origin;
    }
    current.port = port;
    return current.origin;
  } catch (error) {
    const { protocol, hostname, port: currentPort } = window.location;
    const isDefaultPort = !currentPort || currentPort === '80' || currentPort === '443';
    if (isDefaultPort) {
      return `${protocol}//${hostname}`;
    }
    return `${protocol}//${hostname}:${port}`;
  }
}

const API_BASE = resolveApiBase();
const ORDER_ENDPOINT = `${API_BASE}/api/orders`;
const UPDATE_ORDER_ENDPOINT = (id) => `${API_BASE}/api/orders/${encodeURIComponent(id)}`;
const ARTWORK_UPLOAD_ENDPOINT = `${API_BASE}/api/admin/artwork`;
const SPECIALS_ENDPOINT = `${API_BASE}/api/admin/specials`;
const ADMIN_RACE_QUOTES_ENDPOINT = `${API_BASE}/api/admin/race-quotes`;
const ADMIN_RACE_QUOTE_UPDATE_ENDPOINT = (id) =>
  `${API_BASE}/api/admin/race-quotes/${encodeURIComponent(id)}`;
const ADMIN_RACE_QUOTE_PAYMENT_ENDPOINT = (id) =>
  `${API_BASE}/api/admin/race-quotes/${encodeURIComponent(id)}/payment-link`;
const SAVED_FILE_URL = (file) => `${API_BASE}/files/saved/${encodeURIComponent(file)}`;
const SSAW_CONFIG_ENDPOINT = `${API_BASE}/api/vendors/ssaw/config`;
const MAX_SPECIAL_ITEMS = 4;
const RACE_PACKAGE_LABELS = {
  basic: 'Basic Number Kit',
  sponsor: 'Sponsor Kit',
  pro: 'Pro Package',
  elite: 'Elite Custom Kit'
};
const APPAREL_BUNDLE_LABELS = {
  'apparel-shirts-5': 'Team Apparel Bundle · 5 T-shirts (25% off with decal package)',
  'apparel-shirts-hats': 'Crew Combo · 5 T-shirts + 5 hats (30% off with decal package)',
  'apparel-full-crew': 'Full Crew Bundle · 5 T-shirts, 5 hats, 5 hoodies (35% off with decal package)'
};
const RACE_QUOTE_STATUSES = [
  { value: 'submitted', label: 'Submitted' },
  { value: 'in_review', label: 'In review' },
  { value: 'quoted', label: 'Quote ready' },
  { value: 'awaiting_payment', label: 'Awaiting payment' },
  { value: 'approved', label: 'Approved' },
  { value: 'paid', label: 'Paid' },
  { value: 'cancelled', label: 'Cancelled' }
];

const state = {
  orders: [],
  categories: [],
  specials: [],
  raceQuotes: [],
  assetRoot: '',
  loading: false,
  specialsLoading: false,
  raceQuotesLoading: false
};

const elements = {
  ordersContainer: document.getElementById('ordersContainer'),
  statusBar: document.getElementById('statusBar'),
  refreshButton: document.getElementById('refreshButton'),
  orderCardTemplate: document.getElementById('orderCardTemplate'),
  artForm: document.getElementById('artUploadForm'),
  artCategorySelect: document.getElementById('artCategorySelect'),
  artCategoryModeExisting: document.getElementById('artCategoryModeExisting'),
  artCategoryModeNew: document.getElementById('artCategoryModeNew'),
  artNewCategoryInput: document.getElementById('artNewCategoryInput'),
  artDisplayName: document.getElementById('artDisplayName'),
  artPreviewInput: document.getElementById('artPreviewInput'),
  artSourcesInput: document.getElementById('artSourcesInput'),
  artUploadStatus: document.getElementById('artUploadStatus'),
  specialsCard: document.getElementById('specialsCard'),
  specialsForm: document.getElementById('specialsForm'),
  specialsCategorySelect: document.getElementById('specialsCategorySelect'),
  specialsDesignSelect: document.getElementById('specialsDesignSelect'),
  specialsTitleInput: document.getElementById('specialsTitleInput'),
  specialsTaglineInput: document.getElementById('specialsTaglineInput'),
  specialsList: document.getElementById('specialsList'),
  specialsStatus: document.getElementById('specialsStatus'),
  raceQuotesCard: document.getElementById('raceQuotesCard'),
  raceQuotesList: document.getElementById('raceQuotesList'),
  // Visual picker modal
  openVisualPicker: document.getElementById('openVisualPicker'),
  visualPickerModal: document.getElementById('visualPickerModal'),
  visualPickerClose: document.getElementById('visualPickerClose'),
  visualPickerCrumbs: document.getElementById('visualPickerCrumbs'),
  visualPickerGrid: document.getElementById('visualPickerGrid'),
  visualPickerStatus: document.getElementById('visualPickerStatus')
};

// Settings elements
elements.storefrontSettingsForm = document.getElementById('storefrontSettingsForm');
elements.preferredWarehouseInput = document.getElementById('preferredWarehouseInput');
elements.storefrontSettingsStatus = document.getElementById('storefrontSettingsStatus');

function resolveAssetUrl(pathValue, { width, quality } = {}) {
  if (!pathValue) return '';
  if (/^https?:/i.test(pathValue)) {
    try {
      const current = new URL(window.location.href);
      const url = new URL(pathValue);
      url.protocol = current.protocol;
      url.hostname = current.hostname;
      url.port = current.port;
      if (width || quality) {
        if (width) {
        const clampedWidth = Math.min(Math.max(Math.round(width), 1), 2400);
        url.searchParams.set('w', String(clampedWidth));
        }
        if (quality) {
          url.searchParams.set('q', String(Math.min(Math.max(quality, 40), 95)));
        }
      }
      return url.toString();
    } catch (error) {
      return pathValue;
    }
  }
  if (/^(data:|blob:)/i.test(pathValue)) return pathValue;
  if (pathValue.startsWith('/api/')) {
    const url = new URL(pathValue, window.location.origin);
    if (width) {
      const clampedWidth = Math.min(Math.max(Math.round(width), 1), 2400);
      url.searchParams.set('w', String(clampedWidth));
    }
    if (quality) {
      url.searchParams.set('q', String(Math.min(Math.max(quality, 40), 95)));
    }
    return url.toString();
  }

  const base = state.assetRoot;
  if (!base) return pathValue;

  let baseUrl;
  try {
    if (/^https?:\/\//i.test(base)) {
      baseUrl = base;
    } else if (base.startsWith('/')) {
      baseUrl = `${window.location.origin}${base}`;
    } else {
      baseUrl = `${window.location.origin}/${base}`;
    }
    baseUrl = baseUrl.replace(/\/+$/, '') + '/';
    const cleanedPath = pathValue.replace(/^\.\//, '');
    const url = new URL(cleanedPath, baseUrl);
    if (width) {
      const clampedWidth = Math.min(Math.max(Math.round(width), 1), 2400);
      url.searchParams.set('w', String(clampedWidth));
    }
    if (quality) {
      url.searchParams.set('q', String(Math.min(Math.max(quality, 40), 95)));
    }
    return url.href;
  } catch (error) {
    return pathValue;
  }
}

function setUploadStatus(message, type = 'info') {
  if (!elements.artUploadStatus) return;
  elements.artUploadStatus.textContent = message || '';
  elements.artUploadStatus.className = `status-message ${type === 'success' ? 'success' : type === 'error' ? 'error' : ''}`;
}

function setStatus(message, type = 'info') {
  const bar = elements.statusBar;
  if (!bar) return;
  bar.textContent = message || '';
  bar.className = `status-bar ${type === 'success' ? 'success' : type === 'error' ? 'error' : ''}`;
}

async function loadStorefrontSettings() {
  if (!elements.storefrontSettingsForm) return;
  try {
    const res = await fetch(SSAW_CONFIG_ENDPOINT, { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    const pref = (data && data.preferredWarehouse) || '';
    if (elements.preferredWarehouseInput) {
      elements.preferredWarehouseInput.value = pref || '';
    }
    if (elements.storefrontSettingsStatus) {
      elements.storefrontSettingsStatus.textContent = pref ? `Using ${pref}` : 'Not set';
    }
  } catch (error) {
    if (elements.storefrontSettingsStatus) {
      elements.storefrontSettingsStatus.textContent = 'Unable to load settings';
    }
  }
}

async function handleStorefrontSettingsSubmit(event) {
  event.preventDefault();
  if (!elements.preferredWarehouseInput) return;
  let value = (elements.preferredWarehouseInput.value || '').trim().toUpperCase();
  value = value.replace(/[^A-Z]/g, '').slice(0, 4);
  try {
    const res = await fetch(SSAW_CONFIG_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preferredWarehouse: value })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || 'Unable to save settings');
    }
    if (elements.storefrontSettingsStatus) {
      elements.storefrontSettingsStatus.textContent = value ? `Saved (${value})` : 'Saved';
    }
  } catch (error) {
    if (elements.storefrontSettingsStatus) {
      elements.storefrontSettingsStatus.textContent = error.message || 'Save failed';
    }
  }
}

function formatAddonLabel(value) {
  if (!value) return '';
  return APPAREL_BUNDLE_LABELS[value] || value;
}

function formatAddonList(addons) {
  if (!Array.isArray(addons) || !addons.length) return '';
  return addons.map((addon) => formatAddonLabel(addon)).join(', ');
}

async function fetchOrders() {
  if (state.loading) return;
  state.loading = true;
  setStatus('Loading orders…');

  try {
    const response = await fetch(ORDER_ENDPOINT);
    if (!response.ok) {
      throw new Error(`Failed to load orders (${response.status})`);
    }
    const data = await response.json();
    state.orders = Array.isArray(data.orders) ? data.orders : [];
    renderOrders();
    if (state.orders.length) {
      setStatus(`Loaded ${state.orders.length} order${state.orders.length === 1 ? '' : 's'}.`, 'success');
    } else {
      setStatus('No orders saved yet.', 'info');
    }
  } catch (error) {
    console.error('Unable to fetch orders:', error);
    setStatus(`Unable to fetch orders: ${error.message}`, 'error');
  } finally {
    state.loading = false;
  }
}

function renderOrders() {
  const container = elements.ordersContainer;
  if (!container) return;

  container.innerHTML = '';

  if (!state.orders.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No saved customer requests yet. Ask customers to build a mockup on the store page.';
    container.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  state.orders.forEach((order) => {
    const card = buildOrderCard(order);
    fragment.appendChild(card);
  });

  container.appendChild(fragment);
}

async function loadRaceQuotesAdmin() {
  if (state.raceQuotesLoading) return;
  state.raceQuotesLoading = true;
  try {
    const response = await fetch(ADMIN_RACE_QUOTES_ENDPOINT, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Failed to load race quotes (${response.status})`);
    }
    const data = await response.json();
    state.raceQuotes = Array.isArray(data.quotes) ? data.quotes : [];
    renderRaceQuotesAdmin();
  } catch (error) {
    console.error('Unable to load race quotes:', error);
    if (elements.raceQuotesList) {
      elements.raceQuotesList.innerHTML =
        '<div class="empty-state">Unable to load race quotes.</div>';
    }
  } finally {
    state.raceQuotesLoading = false;
  }
}

function renderRaceQuotesAdmin() {
  const container = elements.raceQuotesList;
  if (!container) return;
  container.innerHTML = '';

  if (!state.raceQuotes.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No race quote requests yet.';
    container.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  state.raceQuotes.forEach((quote) => {
    fragment.appendChild(buildRaceQuoteAdminCard(quote));
  });
  container.appendChild(fragment);
}

function getCategoryMode() {
  return elements.artCategoryModeNew?.checked ? 'new' : 'existing';
}

function applyCategoryMode(mode) {
  const select = elements.artCategorySelect;
  const newInput = elements.artNewCategoryInput;
  if (mode === 'new') {
    if (select) {
      select.disabled = true;
    }
    if (newInput) {
      newInput.disabled = false;
      newInput.focus();
    }
  } else {
    if (select) {
      select.disabled = !state.categories.length;
      if (!select.value && select.options.length > 1) {
        select.selectedIndex = 1;
      }
    }
    if (newInput) {
      newInput.value = '';
      newInput.disabled = true;
    }
  }
}

function handleCategoryModeChange() {
  const mode = getCategoryMode();
  applyCategoryMode(mode);
}

async function robustFetchJson(url, { cache = 'no-cache' } = {}) {
  // Try parsing via text to catch truncated bodies; retry with cache-bust; then fallback to plain file
  const attempts = [
    { url, cache },
    { url: `${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}`, cache },
  ];
  for (const attempt of attempts) {
    try {
      const res = await fetch(attempt.url, { cache: attempt.cache });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch (parseErr) {
        // continue to next attempt
        console.warn('JSON parse failed for', attempt.url, parseErr?.message || parseErr);
      }
    } catch (err) {
      console.warn('Fetch failed for', attempt.url, err?.message || err);
    }
  }
  // Fallback to static catalog.json in the same origin (if served)
  try {
    const fallback = new URL('/catalog.json', window.location.origin).toString();
    const res = await fetch(`${fallback}?_=${Date.now()}`, { cache: 'no-store' });
    const text = await res.text();
    return JSON.parse(text);
  } catch (err) {
    throw err;
  }
}

async function loadCategories(options = {}) {
  if (!elements.artCategorySelect) return null;
  const { preserveSelection = false, selectSlug = '' } = options;
  const select = elements.artCategorySelect;
  const previousValue = preserveSelection ? select.value : '';
  try {
    const catalogUrl = new URL('/api/catalog', window.location.origin).toString();
    const catalog = await robustFetchJson(catalogUrl, { cache: 'no-cache' });
    state.assetRoot = catalog.assetRoot || '';
    const categories = Array.isArray(catalog.categories) ? catalog.categories : [];
    state.categories = categories;

    select.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.disabled = true;
    placeholder.textContent = categories.length ? 'Select a category…' : 'No categories found';
    select.appendChild(placeholder);

    categories.forEach((category) => {
      const option = document.createElement('option');
      option.value = category.slug;
      option.textContent = category.name;
      select.appendChild(option);
    });

    let targetValue = selectSlug;
    if (preserveSelection && !targetValue) {
      targetValue = categories.some((category) => category.slug === previousValue)
        ? previousValue
        : '';
    }

    const hasTarget = targetValue && categories.some((category) => category.slug === targetValue);
    if (hasTarget) {
      select.value = targetValue;
      placeholder.selected = false;
      if (select.selectedIndex <= 0) {
        const foundIndex = Array.from(select.options).findIndex(
          (option) => option.value === targetValue
        );
        if (foundIndex > 0) {
          select.selectedIndex = foundIndex;
        }
      }
    } else if (categories.length) {
      const preferred = categories.find((c) => (c.name || '').toLowerCase().includes('car'))
        || categories.find((c) => (c.slug || '').toLowerCase().includes('car'))
        || categories[0];
      select.value = preferred.slug;
      placeholder.selected = false;
      if (select.selectedIndex <= 0 && select.options.length > 1) {
        select.selectedIndex = 1;
      }
    } else {
      select.value = '';
      placeholder.selected = true;
    }

    select.disabled = !categories.length || getCategoryMode() === 'new';
    refreshSpecialsFormOptions();
    return categories;
  } catch (error) {
    console.error('Unable to load categories:', error);
    state.categories = [];
    select.innerHTML = '';
    const option = document.createElement('option');
    option.value = '';
    option.disabled = true;
    option.selected = true;
    option.textContent = 'Unable to load categories';
    select.appendChild(option);
    select.disabled = true;
    setUploadStatus('Unable to load categories. Refresh and try again.', 'error');
    refreshSpecialsFormOptions();
    return null;
  }
}

function getCategoryBySlug(slug) {
  return state.categories.find((category) => category.slug === slug) || null;
}

function getDesignFromCatalog(categorySlug, designId) {
  const category = getCategoryBySlug(categorySlug);
  if (!category || !Array.isArray(category.designs)) {
    return { category: null, design: null };
  }
  const design = category.designs.find((entry) => entry.id === designId) || null;
  return { category, design };
}

function refreshSpecialsFormOptions() {
  const categorySelect = elements.specialsCategorySelect;
  if (!categorySelect) return;

  const previousValue = categorySelect.value;
  categorySelect.innerHTML = '';

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.disabled = true;
  placeholder.textContent = state.categories.length
    ? 'Select category…'
    : 'No categories available';
  categorySelect.appendChild(placeholder);

  state.categories.forEach((category) => {
    const option = document.createElement('option');
    option.value = category.slug;
    option.textContent = category.name;
    categorySelect.appendChild(option);
  });

  if (state.categories.some((category) => category.slug === previousValue)) {
    categorySelect.value = previousValue;
    placeholder.selected = false;
  } else {
    categorySelect.value = '';
    placeholder.selected = true;
  }

  updateSpecialsDesignOptions();
}

function updateSpecialsDesignOptions() {
  const designSelect = elements.specialsDesignSelect;
  if (!designSelect) return;

  const categorySlug = elements.specialsCategorySelect?.value || '';
  designSelect.innerHTML = '';

  if (!categorySlug) {
    const option = document.createElement('option');
    option.value = '';
    option.disabled = true;
    option.selected = true;
    option.textContent = 'Select a category first';
    designSelect.appendChild(option);
    designSelect.disabled = true;
    fillSpecialTitleFromDesign(null);
    updateSpecialsFormAvailability();
    return;
  }

  const category = getCategoryBySlug(categorySlug);
  if (!category || !Array.isArray(category.designs) || category.designs.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.disabled = true;
    option.selected = true;
    option.textContent = 'No designs in this category';
    designSelect.appendChild(option);
    designSelect.disabled = true;
    fillSpecialTitleFromDesign(null);
    updateSpecialsFormAvailability();
    return;
  }

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.disabled = true;
  placeholder.selected = true;
  placeholder.textContent = 'Select design…';
  designSelect.appendChild(placeholder);

  category.designs.forEach((design) => {
    const option = document.createElement('option');
    option.value = design.id;
    option.textContent = design.name || design.id;
    designSelect.appendChild(option);
  });

  designSelect.disabled = false;
  fillSpecialTitleFromDesign(null);
  updateSpecialsFormAvailability();
}

function fillSpecialTitleFromDesign(design) {
  const titleInput = elements.specialsTitleInput;
  if (!titleInput) return;
  const current = titleInput.value.trim();
  const autoValue = titleInput.dataset.autofillValue || '';
  if (!design) {
    if (!current || current === autoValue) {
      titleInput.value = '';
      titleInput.dataset.autofillValue = '';
    }
    return;
  }
  const suggested = design.name || design.id.replace(/[-_]+/g, ' ');
  if (!current || current === autoValue) {
    titleInput.value = suggested;
    titleInput.dataset.autofillValue = suggested;
  }
}

function setSpecialsStatus(message, type = 'info') {
  const target = elements.specialsStatus;
  if (!target) return;
  target.textContent = message || '';
  target.className = `status-message ${type === 'success' ? 'success' : type === 'error' ? 'error' : ''}`;
}

function updateSpecialsFormAvailability() {
  const limitReached = state.specials.length >= MAX_SPECIAL_ITEMS;
  const isSaving = state.specialsLoading;
  const categorySelect = elements.specialsCategorySelect;
  const designSelect = elements.specialsDesignSelect;
  const titleInput = elements.specialsTitleInput;
  const taglineInput = elements.specialsTaglineInput;
  const submitButton = elements.specialsForm?.querySelector('button[type="submit"]');

  if (categorySelect) {
    categorySelect.disabled =
      !state.categories.length || limitReached || isSaving;
  }
  if (designSelect) {
    designSelect.disabled =
      limitReached ||
      isSaving ||
      !elements.specialsCategorySelect?.value ||
      designSelect.options.length === 0 ||
      (designSelect.options.length === 1 && designSelect.options[0].value === '');
  }
  if (titleInput) {
    titleInput.disabled = limitReached || isSaving;
  }
  if (taglineInput) {
    taglineInput.disabled = limitReached || isSaving;
  }
  if (submitButton) {
    submitButton.disabled =
      limitReached ||
      isSaving ||
      !elements.specialsDesignSelect ||
      !elements.specialsDesignSelect.value;
  }
}

function renderSpecialsList() {
  const container = elements.specialsList;
  if (!container) return;

  container.innerHTML = '';
  if (!state.specials.length) {
    container.classList.add('empty');
    container.textContent = 'No specials selected yet. Choose up to four designs to feature.';
    updateSpecialsFormAvailability();
    return;
  }

  container.classList.remove('empty');
  const fragment = document.createDocumentFragment();

  state.specials.forEach((item, index) => {
    const card = document.createElement('article');
    card.className = 'special-item';

    if (item.image) {
      const preview = document.createElement('img');
      preview.src = resolveAssetUrl(item.image, { width: 360, quality: 80 });
      preview.alt = item.designName || item.title || 'Featured artwork';
      preview.loading = 'lazy';
      preview.decoding = 'async';
      card.appendChild(preview);
    }

    const body = document.createElement('div');
    body.className = 'special-item__details';

    const title = document.createElement('h3');
    title.textContent = item.title || item.designName || 'Featured artwork';
    body.appendChild(title);

    if (item.tagline) {
      const tagline = document.createElement('p');
      tagline.className = 'special-item__tagline';
      tagline.textContent = item.tagline;
      body.appendChild(tagline);
    }

    const meta = document.createElement('p');
    meta.className = 'special-item__meta';
    const parts = [];
    if (item.categoryName) parts.push(item.categoryName);
    if (item.designName && item.designName !== item.title) {
      parts.push(item.designName);
    }
    meta.textContent = parts.join(' • ') || 'Catalog design';
    body.appendChild(meta);

    if (item.missing) {
      const warning = document.createElement('p');
      warning.className = 'special-item__warning';
      warning.textContent = 'Design missing from catalog. Remove or re-add after regenerating the catalog.';
      body.appendChild(warning);
    }

    const actions = document.createElement('div');
    actions.className = 'special-item__actions';

    const moveUp = document.createElement('button');
    moveUp.type = 'button';
    moveUp.className = 'ghost';
    moveUp.textContent = 'Move up';
    moveUp.disabled = index === 0 || state.specialsLoading;
    moveUp.addEventListener('click', () => moveSpecial(index, -1));
    actions.appendChild(moveUp);

    const moveDown = document.createElement('button');
    moveDown.type = 'button';
    moveDown.className = 'ghost';
    moveDown.textContent = 'Move down';
    moveDown.disabled = index === state.specials.length - 1 || state.specialsLoading;
    moveDown.addEventListener('click', () => moveSpecial(index, 1));
    actions.appendChild(moveDown);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger';
    remove.textContent = 'Remove';
    remove.disabled = state.specialsLoading;
    remove.addEventListener('click', () => removeSpecial(index));
    actions.appendChild(remove);

    body.appendChild(actions);
    card.appendChild(body);
    fragment.appendChild(card);
  });

  container.appendChild(fragment);
  updateSpecialsFormAvailability();
}

function serializeSpecials(items) {
  return items.map((item) => ({
    categorySlug: item.categorySlug,
    designId: item.designId,
    title: item.title || '',
    tagline: item.tagline || ''
  }));
}

async function loadSpecials({ silent = false } = {}) {
  if (!elements.specialsList) return;
  if (!silent) {
    setSpecialsStatus('Loading featured artwork…');
  }
  try {
    const response = await fetch(SPECIALS_ENDPOINT, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Failed to load specials (${response.status})`);
    }
    const data = await response.json();
    state.specials = Array.isArray(data.items) ? data.items : [];
    renderSpecialsList();
    if (!state.specials.length) {
      setSpecialsStatus('Choose up to four designs to feature on the landing page.', 'info');
    } else {
      setSpecialsStatus('', 'info');
    }
  } catch (error) {
    console.error('Unable to load specials:', error);
    setSpecialsStatus(error.message || 'Unable to load specials.', 'error');
    state.specials = [];
    renderSpecialsList();
  }
}

async function persistSpecialsList(nextItems) {
  const previousItems = state.specials.map((item) => ({ ...item }));
  state.specials = nextItems.map((item) => ({ ...item }));
  renderSpecialsList();
  state.specialsLoading = true;
  setSpecialsStatus('Saving featured artwork…');
  updateSpecialsFormAvailability();

  try {
    const response = await fetch(SPECIALS_ENDPOINT, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: serializeSpecials(nextItems) })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `Save failed (${response.status})`);
    }
    state.specials = Array.isArray(data.items) ? data.items : state.specials;
    renderSpecialsList();
    setSpecialsStatus('Specials updated.', 'success');
    return state.specials;
  } catch (error) {
    console.error('Failed to save specials:', error);
    state.specials = previousItems;
    renderSpecialsList();
    setSpecialsStatus(error.message || 'Unable to save specials.', 'error');
    return null;
  } finally {
    state.specialsLoading = false;
    updateSpecialsFormAvailability();
  }
}

async function removeSpecial(index) {
  if (index < 0 || index >= state.specials.length || state.specialsLoading) return;
  const updated = state.specials.filter((_, idx) => idx !== index);
  await persistSpecialsList(updated);
}

async function moveSpecial(index, offset) {
  if (state.specialsLoading) return;
  const newIndex = index + offset;
  if (newIndex < 0 || newIndex >= state.specials.length) return;
  const updated = state.specials.map((item) => ({ ...item }));
  const [item] = updated.splice(index, 1);
  updated.splice(newIndex, 0, item);
  await persistSpecialsList(updated);
}

async function handleSpecialsFormSubmit(event) {
  event.preventDefault();
  if (state.specialsLoading) return;

  const categorySlug = elements.specialsCategorySelect?.value || '';
  const designId = elements.specialsDesignSelect?.value || '';
  const title = elements.specialsTitleInput?.value?.trim() || '';
  const tagline = elements.specialsTaglineInput?.value?.trim() || '';

  if (!categorySlug || !designId) {
    setSpecialsStatus('Choose a category and design to feature.', 'error');
    return;
  }

  if (state.specials.some((item) => item.categorySlug === categorySlug && item.designId === designId)) {
    setSpecialsStatus('This design is already featured.', 'error');
    return;
  }

  if (state.specials.length >= MAX_SPECIAL_ITEMS) {
    setSpecialsStatus(`Remove a design before adding another. You can feature up to ${MAX_SPECIAL_ITEMS}.`, 'error');
    return;
  }

  const { category, design } = getDesignFromCatalog(categorySlug, designId);
  if (!design) {
    setSpecialsStatus('Selected design is no longer in the catalog. Refresh and try again.', 'error');
    return;
  }

  const nextItem = {
    id: `${categorySlug}:${designId}`,
    categorySlug,
    designId,
    title: title || design.name || design.id,
    tagline,
    image: design.image,
    categoryName: category?.name || null,
    designName: design.name || design.id,
    sources: design.sources || {},
    missing: false
  };

  const updated = [...state.specials, nextItem];
  const saved = await persistSpecialsList(updated);
  if (saved) {
    elements.specialsForm?.reset();
    if (elements.specialsTitleInput) {
      elements.specialsTitleInput.dataset.autofillValue = '';
    }
    updateSpecialsDesignOptions();
  }
}

function buildOrderCard(order) {
  const template = elements.orderCardTemplate.content.cloneNode(true);
  const article = template.querySelector('.order-card');
  article.dataset.orderId = order.id;

  const title = template.querySelector('.order-card__title');
  title.textContent = order.orderNumber
    ? `Order #${order.orderNumber} · ${order.designName || 'Order'}`
    : order.designName || 'Order';

  const meta = template.querySelector('.order-card__meta');
  const metaParts = [];
  if (order.category) metaParts.push(`Category: ${order.category}`);
  metaParts.push(`Saved: ${formatDate(order.savedAt)}`);
  meta.textContent = metaParts.join(' • ');

  const paidToggle = template.querySelector('.paid-toggle input');
  paidToggle.checked = Boolean(order.paid);
  paidToggle.addEventListener('change', () => {
    updateOrderPaid(order.id, paidToggle.checked);
  });

  const previewImg = template.querySelector('.order-card__preview img');
  if (order.previewFile) {
    previewImg.src = SAVED_FILE_URL(order.previewFile);
  } else {
    previewImg.alt = 'Preview not available';
  }

  const previewButton = template.querySelector('.download-button');
  if (order.previewFile) {
    previewButton.href = SAVED_FILE_URL(order.previewFile);
  } else {
    previewButton.href = '#';
    previewButton.addEventListener('click', (event) => event.preventDefault());
  }

  const details = template.querySelector('.detail-list');
  appendDetail(details, 'Order #', order.orderNumber || '—');
  appendDetail(details, 'Customer', order.customer?.name || '—');
  appendDetail(details, 'Email', order.customer?.email || '—');
  appendDetail(details, 'Phone', order.customer?.phone || '—');
  appendDetail(details, 'Address', order.customer?.address || '—');
  appendDetail(details, 'Quantity', order.quantity);
  appendDetail(details, 'Width', `${Number(order.size || 0).toFixed(1)}"`);
  appendDetail(details, 'Vinyl', order.color?.toUpperCase() || '-');
  appendDetail(details, 'Background', order.background?.toUpperCase() || '-');
  appendDetail(details, 'Notes', order.notes || '—');
  if (order.pricing) {
    appendDetail(details, 'Product', order.pricing.descriptor || 'Custom item');
    appendDetail(details, 'Unit price', formatMoney(order.pricing.unitPriceCents));
    appendDetail(details, 'Subtotal', formatMoney(order.pricing.subtotalCents));
    appendDetail(details, 'Shipping', formatMoney(order.pricing.shippingCents));
    appendDetail(details, 'Total', formatMoney(order.pricing.totalCents));
  }
  if (order.internalNotes) {
    appendDetail(details, 'Internal notes', order.internalNotes);
  }
  appendDetail(details, 'Paid', order.paid ? 'Yes' : 'No');
  appendDetail(details, 'Payment status', order.paymentStatus || 'UNPAID');
  if (order.metadataPath || order.metadataFile) {
    appendDetail(details, 'Metadata', order.metadataPath || order.metadataFile);
  }
  if (order.paymentLink) {
    appendDetail(details, 'Payment link', order.paymentLink);
  }
  if (order.paymentDetails?.receipt) {
    appendDetail(details, 'Receipt', order.paymentDetails.receipt);
  }

  const textLayerContainer = template.querySelector('.text-layers');
  if (order.textLayers?.length) {
    order.textLayers.forEach((layer, index) => {
      const div = document.createElement('div');
      div.className = 'text-layer';
      div.innerHTML = `<strong>Line ${index + 1}:</strong> "${layer.content}"<br>
        Size: ${layer.fontSize}px • Font: ${layer.fontFamily}<br>
        Rotation: ${layer.rotation}° • Curve: ${layer.curve}°`;
      textLayerContainer.appendChild(div);
    });
  } else {
    const div = document.createElement('div');
    div.className = 'text-layer';
    div.textContent = 'No custom text.';
    textLayerContainer.appendChild(div);
  }

  const sourceContainer = template.querySelector('.source-files');
  if (order.sourceCopies?.length) {
    order.sourceCopies.forEach((source) => {
      const link = document.createElement('a');
      link.href = SAVED_FILE_URL(source.file);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = `${source.format.toUpperCase()} (${formatBytes(source.size)})`;
      sourceContainer.appendChild(link);
    });
  } else {
    const span = document.createElement('span');
    span.className = 'text-layer';
    span.textContent = 'No source files captured.';
    sourceContainer.appendChild(span);
  }

  return article;
}

function buildRaceQuoteAdminCard(quote) {
  const card = document.createElement('article');
  card.className = 'race-quote-admin';
  card.dataset.quoteId = quote.id;

  const header = document.createElement('header');
  const title = document.createElement('h3');
  title.textContent = quote.quoteNumber ? `Quote #${quote.quoteNumber}` : 'Race quote';
  header.appendChild(title);

  const requester = document.createElement('p');
  requester.className = 'race-quote-admin__requester';
  requester.textContent = `${quote.business || 'Business'} • ${quote.contactName || 'Contact'}${
    quote.customer?.email ? ` (${quote.customer.email})` : ''
  }`;
  header.appendChild(requester);

  card.appendChild(header);

  const meta = document.createElement('div');
  meta.className = 'race-quote-admin__meta';
  meta.appendChild(createMetaRow('Requested', quote.requestDate || formatDate(quote.createdAt)));
  meta.appendChild(createMetaRow('Vehicle', quote.vehicle || '—'));
  meta.appendChild(createMetaRow('Colors', quote.colors || '—'));
  meta.appendChild(createMetaRow('Package', RACE_PACKAGE_LABELS[quote.packageOption] || quote.packageOption || '—'));
  if (quote.addons?.length) {
    const addonText = formatAddonList(quote.addons);
    if (addonText) {
      meta.appendChild(createMetaRow('Add-ons', addonText));
    }
  }
  if (quote.notes) {
    meta.appendChild(createMetaRow('Customer notes', quote.notes));
  }
  card.appendChild(meta);

  const form = document.createElement('form');
  form.dataset.quoteId = quote.id;
  form.className = 'race-quote-admin__form';
  form.addEventListener('submit', handleRaceQuoteUpdate);

  const moneyFields = document.createElement('div');
  moneyFields.className = 'race-quote-admin__amounts';
  moneyFields.appendChild(buildMoneyInput('Base package', 'baseAmount', quote.baseCents));
  moneyFields.appendChild(buildMoneyInput('Add-ons', 'addonsAmount', quote.addonsCents));
  moneyFields.appendChild(buildMoneyInput('Subtotal', 'subtotalAmount', quote.subtotalCents));
  moneyFields.appendChild(buildMoneyInput('Sales tax', 'taxAmount', quote.taxCents));
  moneyFields.appendChild(buildMoneyInput('Total', 'totalAmount', quote.totalCents, true));
  form.appendChild(moneyFields);

  const statusRow = document.createElement('div');
  statusRow.className = 'race-quote-admin__status';
  const statusLabel = document.createElement('label');
  statusLabel.textContent = 'Status';
  const statusSelect = document.createElement('select');
  statusSelect.name = 'status';
  RACE_QUOTE_STATUSES.forEach((option) => {
    const opt = document.createElement('option');
    opt.value = option.value;
    opt.textContent = option.label;
    if ((quote.status || '').toLowerCase() === option.value) {
      opt.selected = true;
    }
    statusSelect.appendChild(opt);
  });
  statusLabel.appendChild(statusSelect);
  statusRow.appendChild(statusLabel);

  const paymentStatus = document.createElement('p');
  paymentStatus.className = 'race-quote-admin__payment';
  paymentStatus.textContent = `Payment status: ${quote.paymentStatus || 'UNPAID'}`;
  statusRow.appendChild(paymentStatus);
  form.appendChild(statusRow);

  const notesLabel = document.createElement('label');
  notesLabel.className = 'race-quote-admin__notes';
  notesLabel.textContent = 'Internal notes';
  const notesTextarea = document.createElement('textarea');
  notesTextarea.name = 'adminNotes';
  notesTextarea.rows = 3;
  notesTextarea.placeholder = 'Add proofing or production notes for this package';
  notesTextarea.value = quote.adminNotes || '';
  notesLabel.appendChild(notesTextarea);
  form.appendChild(notesLabel);

  const formActions = document.createElement('div');
  formActions.className = 'race-quote-admin__actions';

  const saveButton = document.createElement('button');
  saveButton.type = 'submit';
  saveButton.className = 'primary';
  saveButton.textContent = 'Save update';
  formActions.appendChild(saveButton);

  const linkButton = document.createElement('button');
  linkButton.type = 'button';
  linkButton.className = 'ghost';
  linkButton.textContent = quote.paymentLink ? 'Refresh payment link' : 'Generate payment link';
  linkButton.addEventListener('click', () => handleRaceQuotePayment(quote.id, linkButton));
  formActions.appendChild(linkButton);

  if (quote.paymentLink) {
    const link = document.createElement('a');
    link.href = quote.paymentLink;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.className = 'race-quote-admin__link';
    link.textContent = 'Open payment link';
    formActions.appendChild(link);
  }

  form.appendChild(formActions);
  card.appendChild(form);
  return card;
}

function createMetaRow(label, value) {
  const row = document.createElement('div');
  row.className = 'race-quote-admin__meta-row';
  const strong = document.createElement('strong');
  strong.textContent = `${label}:`;
  const span = document.createElement('span');
  span.textContent = value || '—';
  row.appendChild(strong);
  row.appendChild(span);
  return row;
}

function buildMoneyInput(label, name, cents, emphasize = false) {
  const wrapper = document.createElement('label');
  wrapper.className = 'race-quote-admin__money';
  const span = document.createElement('span');
  span.textContent = label;
  wrapper.appendChild(span);
  const input = document.createElement('input');
  input.type = 'number';
  input.name = name;
  input.step = '0.01';
  input.min = '0';
  input.placeholder = '$0.00';
  input.value = cents ? (cents / 100).toFixed(2) : '';
  if (emphasize) {
    input.classList.add('emphasis');
  }
  wrapper.appendChild(input);
  return wrapper;
}

function appendDetail(dl, label, value) {
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = value;
  dl.appendChild(dt);
  dl.appendChild(dd);
}

async function updateOrderPaid(id, paid) {
  setStatus(`Updating order ${id}…`);
  try {
    const response = await fetch(UPDATE_ORDER_ENDPOINT(id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paid })
    });
    if (!response.ok) {
      throw new Error(`Update failed (${response.status})`);
    }
    setStatus(`Marked order ${id} as ${paid ? 'paid' : 'unpaid'}.`, 'success');
    await fetchOrders();
  } catch (error) {
    console.error('Unable to update order:', error);
    setStatus(`Unable to update order: ${error.message}`, 'error');
  }
}

function formatDate(value) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

async function handleRaceQuoteUpdate(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const quoteId = form.dataset.quoteId;
  if (!quoteId) return;

  const payload = {
    status: form.elements.status?.value || undefined,
    adminNotes: form.elements.adminNotes?.value?.trim() || ''
  };

  ['baseAmount', 'addonsAmount', 'subtotalAmount', 'taxAmount', 'totalAmount'].forEach((name) => {
    if (form.elements[name]) {
      payload[name] = form.elements[name].value;
    }
  });

  setStatus(`Updating quote ${quoteId}…`);
  try {
    const response = await fetch(ADMIN_RACE_QUOTE_UPDATE_ENDPOINT(quoteId), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.error || `Unable to update quote (${response.status})`);
    }
    if (data?.quote) {
      updateRaceQuoteInState(data.quote);
      setStatus(`Updated quote ${data.quote.quoteNumber || quoteId}.`, 'success');
    } else {
      await loadRaceQuotesAdmin();
      setStatus('Quote updated.', 'success');
    }
  } catch (error) {
    console.error('Race quote update failed:', error);
    setStatus(error.message || 'Unable to update quote.', 'error');
  }
}

async function handleRaceQuotePayment(quoteId, button) {
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = 'Creating link…';
  try {
    const response = await fetch(ADMIN_RACE_QUOTE_PAYMENT_ENDPOINT(quoteId), {
      method: 'POST'
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.error || `Unable to create payment link (${response.status})`);
    }
    if (data?.quote) {
      updateRaceQuoteInState(data.quote);
      setStatus('Payment link ready.', 'success');
    } else {
      await loadRaceQuotesAdmin();
      setStatus('Payment link generated.', 'success');
    }
  } catch (error) {
    console.error('Race quote payment link error:', error);
    setStatus(error.message || 'Unable to create payment link.', 'error');
  } finally {
    button.disabled = false;
    button.textContent = originalText || 'Generate payment link';
  }
}

function updateRaceQuoteInState(updatedQuote) {
  state.raceQuotes = state.raceQuotes.map((quote) =>
    quote.id === updatedQuote.id ? updatedQuote : quote
  );
  renderRaceQuotesAdmin();
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown size';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exponent);
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function formatMoney(cents) {
  if (!Number.isFinite(cents)) return '-';
  const dollars = cents / 100;
  const rounded = Math.round(dollars * 2) / 2;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(rounded);
}

  elements.refreshButton?.addEventListener('click', fetchOrders);
  elements.storefrontSettingsForm?.addEventListener('submit', handleStorefrontSettingsSubmit);

async function initSpecialsManager() {
  if (!elements.specialsForm || !elements.specialsList) return;

  refreshSpecialsFormOptions();
  updateSpecialsFormAvailability();

  // Wire visual picker
  if (elements.openVisualPicker) {
    elements.openVisualPicker.addEventListener('click', async () => {
      if (!state.categories.length) {
        await loadCategories({ preserveSelection: true });
      }
      openVisualPickerModal();
    });
  }

  elements.specialsCategorySelect?.addEventListener('change', () => {
    updateSpecialsDesignOptions();
    setSpecialsStatus('');
  });

  elements.specialsDesignSelect?.addEventListener('change', () => {
    const categorySlug = elements.specialsCategorySelect?.value || '';
    const designId = elements.specialsDesignSelect?.value || '';
    const { design } = getDesignFromCatalog(categorySlug, designId);
    fillSpecialTitleFromDesign(design);
    updateSpecialsFormAvailability();
  });

  elements.specialsTitleInput?.addEventListener('input', () => {
    if (elements.specialsTitleInput) {
      elements.specialsTitleInput.dataset.autofillValue = '';
    }
  });

  elements.specialsForm.addEventListener('submit', handleSpecialsFormSubmit);

  await loadSpecials();
}

// Visual Picker Implementation (categories -> designs)
function openVisualPickerModal() {
  if (!elements.visualPickerModal) return;
  renderVisualPickerCategories();
  elements.visualPickerModal.removeAttribute('hidden');
  attachVisualPickerEvents();
}

function closeVisualPickerModal() {
  if (!elements.visualPickerModal) return;
  elements.visualPickerModal.setAttribute('hidden', '');
}

function attachVisualPickerEvents() {
  if (elements.visualPickerClose) {
    elements.visualPickerClose.onclick = closeVisualPickerModal;
  }
  if (elements.visualPickerModal) {
    elements.visualPickerModal.addEventListener('click', (e) => {
      const target = e.target;
      if (target && target.getAttribute && target.getAttribute('data-picker-close') === 'true') {
        closeVisualPickerModal();
      }
    });
  }
}

function renderPickerCrumbs(parts = []) {
  const nav = elements.visualPickerCrumbs;
  if (!nav) return;
  nav.innerHTML = '';
  parts.forEach((part, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = part.label;
    if (part.onClick) btn.addEventListener('click', part.onClick);
    if (idx === parts.length - 1) btn.classList.add('current');
    nav.appendChild(btn);
    if (idx !== parts.length - 1) {
      const sep = document.createElement('span');
      sep.textContent = '›';
      sep.style.opacity = '0.6';
      sep.style.margin = '0 4px';
      nav.appendChild(sep);
    }
  });
}

function buildPickerCard({ title, meta, imageUrl, onClick }) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'picker-card';
  card.addEventListener('click', onClick);
  const media = document.createElement('div');
  media.className = 'picker-card__media';
  if (imageUrl) {
    const img = document.createElement('img');
    img.src = resolveAssetUrl(imageUrl, { width: 600, quality: 80 });
    img.alt = title || 'Preview';
    img.loading = 'lazy';
    media.appendChild(img);
  }
  const body = document.createElement('div');
  body.className = 'picker-card__body';
  const h = document.createElement('div');
  h.className = 'picker-card__title';
  h.textContent = title || 'Untitled';
  body.appendChild(h);
  if (meta) {
    const p = document.createElement('div');
    p.className = 'picker-card__meta';
    p.textContent = meta;
    body.appendChild(p);
  }
  card.appendChild(media);
  card.appendChild(body);
  return card;
}

function renderVisualPickerCategories() {
  const grid = elements.visualPickerGrid;
  const status = elements.visualPickerStatus;
  if (!grid || !status) return;
  renderPickerCrumbs([{ label: 'Categories' }]);
  status.textContent = '';
  grid.innerHTML = '';
  const frag = document.createDocumentFragment();
  state.categories.forEach((category) => {
    const firstDesign = Array.isArray(category.designs) ? category.designs[0] : null;
    const imageUrl = firstDesign?.image || '';
    const meta = `${Array.isArray(category.designs) ? category.designs.length : 0} design(s)`;
    const card = buildPickerCard({
      title: category.name,
      meta,
      imageUrl,
      onClick: () => renderVisualPickerDesigns(category.slug)
    });
    frag.appendChild(card);
  });
  grid.appendChild(frag);
}

function renderVisualPickerDesigns(categorySlug) {
  const { category } = getDesignFromCatalog(categorySlug, '__noop__');
  if (!category) return;
  const grid = elements.visualPickerGrid;
  const status = elements.visualPickerStatus;
  if (!grid || !status) return;
  renderPickerCrumbs([
    { label: 'Categories', onClick: () => renderVisualPickerCategories() },
    { label: category.name }
  ]);
  status.textContent = 'Click a design to select it.';
  grid.innerHTML = '';
  const frag = document.createDocumentFragment();
  category.designs.forEach((design) => {
    const card = buildPickerCard({
      title: design.name || design.id,
      meta: '',
      imageUrl: design.image,
      onClick: () => selectDesignFromPicker(category.slug, design.id)
    });
    frag.appendChild(card);
  });
  grid.appendChild(frag);
}

function selectDesignFromPicker(categorySlug, designId) {
  if (elements.specialsCategorySelect) {
    elements.specialsCategorySelect.value = categorySlug;
    updateSpecialsDesignOptions();
  }
  if (elements.specialsDesignSelect) {
    elements.specialsDesignSelect.value = designId;
    const { design } = getDesignFromCatalog(categorySlug, designId);
    fillSpecialTitleFromDesign(design);
    updateSpecialsFormAvailability();
  }
  closeVisualPickerModal();
}

async function initArtworkUploader() {
  if (!elements.artForm) return;
  await loadCategories();
  applyCategoryMode(getCategoryMode());
  await initSpecialsManager();

  elements.artCategoryModeExisting?.addEventListener('change', handleCategoryModeChange);
  elements.artCategoryModeNew?.addEventListener('change', handleCategoryModeChange);
  elements.artCategorySelect?.addEventListener('change', () => {
    if (elements.artCategoryModeExisting && !elements.artCategoryModeExisting.checked) {
      elements.artCategoryModeExisting.checked = true;
      handleCategoryModeChange();
    }
  });
  elements.artNewCategoryInput?.addEventListener('input', () => {
    if (elements.artCategoryModeNew && !elements.artCategoryModeNew.checked) {
      elements.artCategoryModeNew.checked = true;
      handleCategoryModeChange();
    }
  });

  elements.artForm.addEventListener('submit', handleArtworkUpload);
}

async function handleArtworkUpload(event) {
  event.preventDefault();
  const mode = getCategoryMode();
  const selectedCategory = elements.artCategorySelect?.value || '';
  const newCategoryName = elements.artNewCategoryInput?.value?.trim();

  if (mode === 'existing' && !selectedCategory) {
    setUploadStatus('Choose a category to upload into.', 'error');
    elements.artCategorySelect?.focus();
    return;
  }
  if (mode === 'new' && !newCategoryName) {
    setUploadStatus('Enter a name for the new category folder.', 'error');
    elements.artNewCategoryInput?.focus();
    return;
  }
  const previewFile = elements.artPreviewInput?.files?.[0];
  if (!previewFile) {
    setUploadStatus('Select a preview image before uploading.', 'error');
    return;
  }

  const formData = new FormData();
  formData.append('categoryMode', mode);
  if (selectedCategory) {
    formData.append('category', selectedCategory);
  }
  if (mode === 'new') {
    formData.append('newCategoryName', newCategoryName);
  }
  formData.append('displayName', elements.artDisplayName?.value?.trim() || previewFile.name);
  formData.append('preview', previewFile, previewFile.name);
  const sourceFiles = elements.artSourcesInput?.files ? Array.from(elements.artSourcesInput.files) : [];
  sourceFiles.forEach((file) => formData.append('sources', file, file.name));

  setUploadStatus('Uploading artwork…', 'info');
  try {
    const response = await fetch(ARTWORK_UPLOAD_ENDPOINT, {
      method: 'POST',
      body: formData
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `Upload failed (${response.status})`);
    }
    setUploadStatus('Artwork uploaded and catalog updated.', 'success');
    elements.artForm.reset();
    if (data?.category?.slug) {
      await loadCategories({ selectSlug: data.category.slug });
      if (elements.artCategoryModeExisting) {
        elements.artCategoryModeExisting.checked = true;
      }
    } else {
      await loadCategories({ preserveSelection: true });
    }
    applyCategoryMode('existing');
    await fetchOrders();
  } catch (error) {
    console.error('Artwork upload failed:', error);
    setUploadStatus(error.message || 'Unable to upload artwork.', 'error');
  }
}

  fetchOrders();
  loadStorefrontSettings();
initArtworkUploader();
loadRaceQuotesAdmin();

// =====================================================
// Shopify Product Sync
// =====================================================
const SHOPIFY_SYNC_ENDPOINT = `${API_BASE}/api/admin/shopify/sync-all-products`;

const syncElements = {
  syncBtn: document.getElementById('syncAllProductsBtn'),
  syncStatus: document.getElementById('syncStatus'),
  syncInventoryInput: document.getElementById('syncInventoryInput'),
  syncProgressContainer: document.getElementById('syncProgressContainer'),
  syncProgressFill: document.getElementById('syncProgressFill'),
  syncProgressText: document.getElementById('syncProgressText'),
  syncLog: document.getElementById('syncLog')
};

function setSyncStatus(message, type = 'info') {
  if (!syncElements.syncStatus) return;
  syncElements.syncStatus.textContent = message;
  syncElements.syncStatus.className = `status-message ${type}`;
}

function appendSyncLog(html, type = 'info') {
  if (!syncElements.syncLog) return;
  const entry = document.createElement('div');
  entry.className = `sync-log-entry sync-log-${type}`;
  entry.innerHTML = html;
  syncElements.syncLog.appendChild(entry);
  syncElements.syncLog.scrollTop = syncElements.syncLog.scrollHeight;
}

function updateSyncProgress(current, total) {
  if (!syncElements.syncProgressFill || !syncElements.syncProgressText) return;
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  syncElements.syncProgressFill.style.width = `${pct}%`;
  syncElements.syncProgressText.textContent = `${current} / ${total} products`;
}

async function startShopifySync() {
  if (!syncElements.syncBtn) return;

  const defaultInventory = parseInt(syncElements.syncInventoryInput?.value || '999', 10);

  // Reset UI
  syncElements.syncBtn.disabled = true;
  syncElements.syncBtn.textContent = 'Syncing...';
  syncElements.syncProgressContainer.style.display = 'block';
  syncElements.syncLog.style.display = 'block';
  syncElements.syncLog.innerHTML = '';
  updateSyncProgress(0, 0);
  setSyncStatus('Starting sync...', 'info');

  try {
    const response = await fetch(SHOPIFY_SYNC_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Key': 'internal'
      },
      body: JSON.stringify({ defaultInventory })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          const eventType = line.slice(7).trim();
          continue;
        }
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            handleSyncEvent(data);
          } catch (e) {
            // Ignore parse errors
          }
        }
      }
    }

  } catch (error) {
    setSyncStatus(`Error: ${error.message}`, 'error');
    appendSyncLog(`<span style="color: #ef4444;">Error: ${error.message}</span>`, 'error');
  } finally {
    syncElements.syncBtn.disabled = false;
    syncElements.syncBtn.textContent = 'Sync All Products';
  }
}

function handleSyncEvent(data) {
  if (data.message) {
    // Status or progress event
    if (data.total !== undefined) {
      // Complete event
      setSyncStatus(data.message, data.errors > 0 ? 'warning' : 'success');
      appendSyncLog(`<strong style="color: #10b981;">${data.message}</strong>`, 'complete');
    } else {
      setSyncStatus(data.message, 'info');
      appendSyncLog(`<span style="color: #94a3b8;">${data.message}</span>`, 'status');
    }
  }

  if (data.index !== undefined && data.total !== undefined) {
    updateSyncProgress(data.index, data.total);

    if (data.error) {
      // Product error
      appendSyncLog(
        `<span style="color: #ef4444;">✗ [${data.index}/${data.total}] ${escapeHtml(data.title)} - ${escapeHtml(data.error)}</span>`,
        'error'
      );
    } else if (data.actions) {
      // Product success
      const actionsHtml = data.actions.map(a => `<span style="color: #64748b; font-size: 0.8em; margin-left: 1rem;">• ${escapeHtml(a)}</span>`).join('<br>');
      appendSyncLog(
        `<span style="color: #10b981;">✓ [${data.index}/${data.total}]</span> ${escapeHtml(data.title)}<br>${actionsHtml}`,
        'product'
      );
    }
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}

// Bind sync button
if (syncElements.syncBtn) {
  syncElements.syncBtn.addEventListener('click', startShopifySync);
}
