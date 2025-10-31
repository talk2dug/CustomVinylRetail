const printStation = window.printStation;

const state = {
  config: null,
  queue: [],
  filteredQueue: [],
  selectedOrderId: null,
  queueIdSet: new Set(),
  pollTimer: null,
  pollInFlight: false,
  quotes: [],
  filteredQuotes: [],
  selectedQuoteId: null,
  quotesLoading: false,
  catalog: null,
  catalogCacheMeta: null,
  catalogFilter: {
    category: '',
    search: ''
  },
  upload: {
    previewPath: null,
    sourcePaths: [],
    isApparel: false,
    apparelType: 'tshirt'
  },
  lastPreviewOpenedFor: null,
  notificationPermissionRequested: false,
  inventoryItems: [],
  inventoryMaterial: 'regular-vinyl',
  inventoryLoading: false,
  inventoryError: null,
  inventoryInitialized: false,
  apparelTypes: []
};
state.quoteDetails = Object.create(null);

const SPONSOR_SIZE_LABELS = {
  small: 'Small (18" and under)',
  medium: 'Medium (door panels)',
  large: 'Large (hood/quarter panels)'
};

const COUNTRY_DATA = `
AF|Afghanistan
AX|Aland Islands
AL|Albania
DZ|Algeria
AS|American Samoa
AD|Andorra
AO|Angola
AI|Anguilla
AQ|Antarctica
AG|Antigua and Barbuda
AR|Argentina
AM|Armenia
AW|Aruba
AU|Australia
AT|Austria
AZ|Azerbaijan
BS|Bahamas
BH|Bahrain
BD|Bangladesh
BB|Barbados
BY|Belarus
BE|Belgium
BZ|Belize
BJ|Benin
BM|Bermuda
BT|Bhutan
BO|Bolivia
BQ|Bonaire
BA|Bosnia and Herzegovina
BW|Botswana
BV|Bouvet Island
BR|Brazil
IO|British Indian Ocean Territory
BN|Brunei
BG|Bulgaria
BF|Burkina Faso
BI|Burundi
KH|Cambodia
CM|Cameroon
CA|Canada
CV|Cape Verde
KY|Cayman Islands
CF|Central African Republic
TD|Chad
CL|Chile
CN|China
CX|Christmas Island
CC|Cocos Islands
CO|Colombia
KM|Comoros
CG|Congo
CD|Congo (DRC)
CK|Cook Islands
CR|Costa Rica
CI|Cote d'Ivoire
HR|Croatia
CU|Cuba
CW|Curacao
CY|Cyprus
CZ|Czech Republic
DK|Denmark
DJ|Djibouti
DM|Dominica
DO|Dominican Republic
EC|Ecuador
EG|Egypt
SV|El Salvador
GQ|Equatorial Guinea
ER|Eritrea
EE|Estonia
SZ|Eswatini
ET|Ethiopia
FK|Falkland Islands
FO|Faroe Islands
FJ|Fiji
FI|Finland
FR|France
GF|French Guiana
PF|French Polynesia
TF|French Southern Territories
GA|Gabon
GM|Gambia
GE|Georgia
DE|Germany
GH|Ghana
GI|Gibraltar
GR|Greece
GL|Greenland
GD|Grenada
GP|Guadeloupe
GU|Guam
GT|Guatemala
GG|Guernsey
GN|Guinea
GW|Guinea-Bissau
GY|Guyana
HT|Haiti
HM|Heard Island and McDonald Islands
VA|Vatican City
HN|Honduras
HK|Hong Kong
HU|Hungary
IS|Iceland
IN|India
ID|Indonesia
IR|Iran
IQ|Iraq
IE|Ireland
IM|Isle of Man
IL|Israel
IT|Italy
JM|Jamaica
JP|Japan
JE|Jersey
JO|Jordan
KZ|Kazakhstan
KE|Kenya
KI|Kiribati
KP|North Korea
KR|South Korea
KW|Kuwait
KG|Kyrgyzstan
LA|Laos
LV|Latvia
LB|Lebanon
LS|Lesotho
LR|Liberia
LY|Libya
LI|Liechtenstein
LT|Lithuania
LU|Luxembourg
MO|Macau
MG|Madagascar
MW|Malawi
MY|Malaysia
MV|Maldives
ML|Mali
MT|Malta
MH|Marshall Islands
MQ|Martinique
MR|Mauritania
MU|Mauritius
YT|Mayotte
MX|Mexico
FM|Micronesia
MD|Moldova
MC|Monaco
MN|Mongolia
ME|Montenegro
MS|Montserrat
MA|Morocco
MZ|Mozambique
MM|Myanmar
NA|Namibia
NR|Nauru
NP|Nepal
NL|Netherlands
NC|New Caledonia
NZ|New Zealand
NI|Nicaragua
NE|Niger
NG|Nigeria
NU|Niue
NF|Norfolk Island
MK|North Macedonia
MP|Northern Mariana Islands
NO|Norway
OM|Oman
PK|Pakistan
PW|Palau
PS|Palestine
PA|Panama
PG|Papua New Guinea
PY|Paraguay
PE|Peru
PH|Philippines
PN|Pitcairn Islands
PL|Poland
PT|Portugal
PR|Puerto Rico
QA|Qatar
RE|Reunion
RO|Romania
RU|Russia
RW|Rwanda
BL|Saint Barthelemy
SH|Saint Helena
KN|Saint Kitts and Nevis
LC|Saint Lucia
MF|Saint Martin
PM|Saint Pierre and Miquelon
VC|Saint Vincent and the Grenadines
WS|Samoa
SM|San Marino
ST|Sao Tome and Principe
SA|Saudi Arabia
SN|Senegal
RS|Serbia
SC|Seychelles
SL|Sierra Leone
SG|Singapore
SX|Sint Maarten
SK|Slovakia
SI|Slovenia
SB|Solomon Islands
SO|Somalia
ZA|South Africa
GS|South Georgia and South Sandwich Islands
SS|South Sudan
ES|Spain
LK|Sri Lanka
SD|Sudan
SR|Suriname
SJ|Svalbard and Jan Mayen
SE|Sweden
CH|Switzerland
SY|Syria
TW|Taiwan
TJ|Tajikistan
TZ|Tanzania
TH|Thailand
TL|Timor-Leste
TG|Togo
TK|Tokelau
TO|Tonga
TT|Trinidad and Tobago
TN|Tunisia
TR|Turkey
TM|Turkmenistan
TC|Turks and Caicos Islands
TV|Tuvalu
UG|Uganda
UA|Ukraine
AE|United Arab Emirates
GB|United Kingdom
US|United States
UM|United States Minor Outlying Islands
VI|United States Virgin Islands
UY|Uruguay
UZ|Uzbekistan
VU|Vanuatu
VE|Venezuela
VN|Vietnam
VG|British Virgin Islands
WF|Wallis and Futuna
EH|Western Sahara
YE|Yemen
ZM|Zambia
ZW|Zimbabwe
`.trim();

const COUNTRY_NAMES = COUNTRY_DATA.split('\n').reduce((acc, line) => {
  const [code, name] = line.split('|');
  if (code && name) {
    acc[code] = name;
  }
  return acc;
}, Object.create(null));

const APPAREL_TYPES_STORAGE_KEY = 'inventoryApparelTypes';
const DEFAULT_APPAREL_TYPES = [
  { value: 'tshirt', label: 'T-shirt' },
  { value: 'hoodie', label: 'Hoodie' },
  { value: 'hat', label: 'Hat' },
  { value: 'beanie', label: 'Beanie' }
];
const APPAREL_SIZE_OPTIONS = ['S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'One size fits all'];

const elements = {
  connectionStatus: document.getElementById('connectionStatus'),
  tabButtons: Array.from(document.querySelectorAll('.tab-button')),
  views: Array.from(document.querySelectorAll('.view')),
  queueTableBody: document.getElementById('queueTableBody'),
  queueDetail: document.getElementById('queueDetailPanel'),
  refreshQueueButton: document.getElementById('refreshQueueButton'),
  queueSearchInput: document.getElementById('queueSearchInput'),
  pollIntervalInput: document.getElementById('pollIntervalInput'),
  quotesTableBody: document.getElementById('quotesTableBody'),
  quoteDetail: document.getElementById('quoteDetailPanel'),
  refreshQuotesButton: document.getElementById('refreshQuotesButton'),
  quoteSearchInput: document.getElementById('quoteSearchInput'),
  toastContainer: document.getElementById('toastContainer'),
  catalogCategorySelect: document.getElementById('catalogCategorySelect'),
  catalogSearchInput: document.getElementById('catalogSearchInput'),
  catalogGrid: document.getElementById('catalogGrid'),
  catalogStatus: document.getElementById('catalogStatus'),
  reloadCatalogButton: document.getElementById('reloadCatalogButton'),
  uploadForm: document.getElementById('uploadForm'),
  existingCategoryRow: document.getElementById('existingCategoryRow'),
  existingCategorySelect: document.getElementById('existingCategorySelect'),
  newCategoryRow: document.getElementById('newCategoryRow'),
  newCategoryInput: document.getElementById('newCategoryInput'),
  displayNameInput: document.getElementById('displayNameInput'),
  uploadApparelToggle: document.getElementById('uploadApparelToggle'),
  uploadApparelType: document.getElementById('uploadApparelType'),
  uploadApparelTypeRow: document.getElementById('uploadApparelTypeRow'),
  inventoryApparelForm: document.getElementById('inventoryApparelForm'),
  inventoryApparelTypeSelect: document.getElementById('inventoryApparelTypeSelect'),
  inventoryApparelTypeOtherRow: document.getElementById('inventoryApparelTypeOtherRow'),
  inventoryApparelTypeOtherInput: document.getElementById('inventoryApparelTypeOtherInput'),
  inventoryApparelQuantity: document.getElementById('inventoryApparelQuantity'),
  inventoryApparelSizeSelect: document.getElementById('inventoryApparelSizeSelect'),
  inventoryApparelColorInput: document.getElementById('inventoryApparelColorInput'),
  inventoryApparelCostInput: document.getElementById('inventoryApparelCostInput'),
  choosePreviewButton: document.getElementById('choosePreviewButton'),
  previewFileLabel: document.getElementById('previewFileLabel'),
  chooseSourcesButton: document.getElementById('chooseSourcesButton'),
  sourceFilesLabel: document.getElementById('sourceFilesLabel'),
  uploadStatus: document.getElementById('uploadStatus'),
  resetUploadButton: document.getElementById('resetUploadButton'),
  settingsForm: document.getElementById('settingsForm'),
  serverUrlInput: document.getElementById('serverUrlInput'),
  assetUrlInput: document.getElementById('assetUrlInput'),
  apiKeyInput: document.getElementById('apiKeyInput'),
  employeeNameInput: document.getElementById('employeeNameInput'),
  autoOpenPreviewCheckbox: document.getElementById('autoOpenPreviewCheckbox'),
  settingsStatus: document.getElementById('settingsStatus'),
  testConnectionButton: document.getElementById('testConnectionButton'),
  inventoryStatus: document.getElementById('inventoryStatus'),
  inventoryList: document.getElementById('inventoryList'),
  inventoryMaterialSelect: document.getElementById('inventoryMaterialSelect'),
  inventoryRefreshButton: document.getElementById('inventoryRefreshButton'),
  inventoryAddForm: document.getElementById('inventoryAddForm'),
  inventoryAddName: document.getElementById('inventoryAddName'),
  inventoryAddColor: document.getElementById('inventoryAddColor'),
  inventoryAddMaterial: document.getElementById('inventoryAddMaterial'),
  inventoryAddQuantity: document.getElementById('inventoryAddQuantity'),
  inventoryAddUnit: document.getElementById('inventoryAddUnit'),
  inventoryAddCost: document.getElementById('inventoryAddCost'),
  inventoryAddUrl: document.getElementById('inventoryAddUrl'),
  inventoryAddNotes: document.getElementById('inventoryAddNotes'),
  inventoryAdjustForm: document.getElementById('inventoryAdjustForm'),
  inventoryAdjustItemSelect: document.getElementById('inventoryAdjustItemSelect'),
  inventoryAdjustAmount: document.getElementById('inventoryAdjustAmount'),
  inventoryAdjustReason: document.getElementById('inventoryAdjustReason'),
  inventoryAdjustNotes: document.getElementById('inventoryAdjustNotes'),
  inventoryEditForm: document.getElementById('inventoryEditForm'),
  inventoryEditItemSelect: document.getElementById('inventoryEditItemSelect'),
  inventoryEditName: document.getElementById('inventoryEditName'),
  inventoryEditMaterial: document.getElementById('inventoryEditMaterial'),
  inventoryEditColor: document.getElementById('inventoryEditColor'),
  inventoryEditUnit: document.getElementById('inventoryEditUnit'),
  inventoryEditCost: document.getElementById('inventoryEditCost'),
  inventoryEditUrl: document.getElementById('inventoryEditUrl'),
  inventoryEditNotes: document.getElementById('inventoryEditNotes')
};

function showToast(message, variant = 'info', timeout = 4000) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${variant}`;
  toast.textContent = message;
  elements.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => {
      toast.remove();
    }, 300);
  }, timeout);
}

function setConnectionStatus(connected, message) {
  elements.connectionStatus.textContent = message;
  elements.connectionStatus.classList.toggle('connected', connected);
}

function switchView(viewId) {
  elements.views.forEach((view) => {
    view.classList.toggle('active', view.id === viewId);
  });
  elements.tabButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.view === viewId);
  });
  if (viewId === 'quotesView' && !state.quotesLoading && !state.quotes.length) {
    refreshQuotes({ silent: true });
  }
  if (viewId === 'inventoryView' && !state.inventoryInitialized && !state.inventoryLoading) {
    loadInventory(state.inventoryMaterial);
  }
}

function formatDate(value) {
  if (!value) return '—';
  try {
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) return value;
    return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    })}`;
  } catch {
    return value;
  }
}

function formatMoney(cents) {
  if (cents == null) return '—';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
      cents / 100
    );
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

function ensureTrailingSlash(value) {
  if (!value) return '';
  return value.endsWith('/') ? value : `${value}/`;
}

function applyImageOptions(urlString, { width, quality } = {}) {
  if (!urlString || (!width && !quality)) return urlString;
  try {
    const url = new URL(urlString);
    if (width) {
      const clampedWidth = Math.min(Math.max(Math.round(width), 1), 2400);
      url.searchParams.set('w', String(clampedWidth));
    }
    if (quality) {
      url.searchParams.set('q', String(Math.min(Math.max(Math.round(quality), 40), 95)));
    }
    return url.toString();
  } catch {
    return urlString;
  }
}

function resolveWithBase(base, pathValue, options) {
  if (!base) return null;
  let absoluteBase = base;
  try {
    if (!/^https?:/i.test(base)) {
      const serverBase = state.config?.serverBaseUrl?.trim();
      if (!serverBase) return null;
      absoluteBase = new URL(base, ensureTrailingSlash(serverBase)).toString();
    }
    const cleaned = pathValue.startsWith('/') ? pathValue : pathValue.replace(/^\.\//, '');
    const resolved = new URL(cleaned, ensureTrailingSlash(absoluteBase));
    return applyImageOptions(resolved.toString(), options);
  } catch {
    return null;
  }
}

function buildServerUrl(pathname) {
  if (!state.config || !state.config.serverBaseUrl) return null;
  try {
    return new URL(pathname, ensureTrailingSlash(state.config.serverBaseUrl)).toString();
  } catch {
    return null;
  }
}

function resolveAssetUrl(pathValue, options = {}) {
  if (!pathValue) return '';
  if (/^data:/i.test(pathValue)) return pathValue;
  if (/^https?:/i.test(pathValue)) {
    return applyImageOptions(pathValue, options);
  }

  const bases = [
    state.catalog?.assetRoot?.trim(),
    state.config?.assetBaseUrl?.trim(),
    state.config?.serverBaseUrl?.trim()
  ].filter(Boolean);

  for (const base of bases) {
    const resolved = resolveWithBase(base, pathValue, options);
    if (resolved) {
      return resolved;
    }
  }

  if (pathValue.startsWith('/')) {
    const serverBase = state.config?.serverBaseUrl?.trim();
    if (serverBase) {
      try {
        const resolved = new URL(pathValue, ensureTrailingSlash(serverBase));
        return applyImageOptions(resolved.toString(), options);
      } catch {
        // ignore and fall through
      }
    }
  }

  return pathValue;
}

function slugifyFilename(value, fallback = 'catalog-design') {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return slug || fallback;
}

function extractFileExtension(pathValue, fallback = 'png') {
  if (!pathValue) return fallback;
  const match = /\.[a-z0-9]+(?=$|\?)/i.exec(pathValue);
  if (match && match[0]) {
    return match[0].slice(1).toLowerCase();
  }
  return fallback;
}

async function handleCatalogImageDownload({ id, name, image }) {
  const sourcePath = image || '';
  const resolvedUrl = resolveAssetUrl(sourcePath);
  if (!resolvedUrl) {
    showToast('Unable to resolve preview URL for this item.', 'error', 5000);
    return;
  }

  const extension = extractFileExtension(sourcePath, 'png');
  const filename = `${slugifyFilename(name || id || 'catalog-design')}.${extension}`;

  try {
    const result = await printStation.downloadFile({
      url: resolvedUrl,
      filename
    });
    if (result?.canceled) {
      showToast('Download canceled.', 'warning', 4000);
    } else {
      showToast('Catalog preview downloaded.', 'success');
    }
  } catch (error) {
    showToast(error.message || 'Unable to download preview.', 'error', 6000);
  }
}

function ensureNotificationPermission() {
  if (state.notificationPermissionRequested) return;
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
  state.notificationPermissionRequested = true;
}

function notifyNewOrders(orders) {
  if (!orders.length) return;
  const count = orders.length;
  const titles = orders.slice(0, 3).map((order) => `#${order.orderNumber} • ${order.designName}`);
  const body =
    count > 3
      ? `${titles.join('\n')}\n+ ${count - 3} more`
      : titles.join('\n') || 'New print job ready.';

  showToast(`${count} new print job${count === 1 ? '' : 's'} added to the queue.`, 'success');
  ensureNotificationPermission();
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('New print job ready', {
      body
    });
  }
}

function renderQueueTable() {
  const search = elements.queueSearchInput.value.trim().toLowerCase();
  const filtered = state.queue.filter((order) => {
    if (!search) return true;
    const haystack = [
      order.orderNumber,
      order.designName,
      order.designId,
      order.customer?.name,
      order.customer?.email,
      order.category
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(search);
  });

  state.filteredQueue = filtered;
  elements.queueTableBody.innerHTML = '';

  if (!filtered.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.className = 'placeholder';
    cell.textContent = 'No orders match your filters.';
    row.appendChild(cell);
    elements.queueTableBody.appendChild(row);
    state.selectedOrderId = null;
    renderQueueDetail();
    return;
  }

  filtered.forEach((order) => {
    const row = document.createElement('tr');
    row.dataset.id = order.id;
    row.classList.toggle('selected', order.id === state.selectedOrderId);

    const customer = order.customer?.name || order.customer?.email || '—';
    const paymentBadge =
      order.paymentStatus === 'PAID' || order.paid
        ? '<span class="badge success">Paid</span>'
        : '<span class="badge warning">Unpaid</span>';

    row.innerHTML = `
      <td>${order.orderNumber ?? '—'}</td>
      <td>${order.designName || order.designId || 'Untitled design'}</td>
      <td>${order.quantity ?? '—'}</td>
      <td>${customer}</td>
      <td>${formatDate(order.savedAt)}</td>
      <td>${paymentBadge}</td>
    `;

    row.addEventListener('click', () => {
      state.selectedOrderId = order.id;
      state.lastPreviewOpenedFor = null;
      renderQueueTable();
      renderQueueDetail(order);
    });

    elements.queueTableBody.appendChild(row);
  });

  const selected = filtered.find((order) => order.id === state.selectedOrderId);
  if (selected) {
    renderQueueDetail(selected);
  } else {
    state.selectedOrderId = filtered[0]?.id || null;
    renderQueueDetail(filtered[0]);
    renderQueueTable(); // re-render to highlight first if needed
  }
}

function filterQuotes() {
  const term = elements.quoteSearchInput.value.trim().toLowerCase();
  state.filteredQuotes = state.quotes.filter((quote) => {
    if (!term) return true;
    const haystack = [
      quote.quoteNumber,
      quote.business,
      quote.contactName,
      quote.packageOption,
      quote.status
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(term);
  });
  renderQuotesTable();
}

function renderQuotesTable() {
  if (!elements.quotesTableBody) return;
  elements.quotesTableBody.innerHTML = '';
  const list = state.filteredQuotes.length ? state.filteredQuotes : state.quotes;
  if (!list.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.className = 'placeholder';
    cell.textContent = state.quotesLoading ? 'Loading race quotes…' : 'No race quotes found.';
    row.appendChild(cell);
    elements.quotesTableBody.appendChild(row);
    renderQuoteDetail(null);
    return;
  }

  list.forEach((quote) => {
    const row = document.createElement('tr');
    row.dataset.id = quote.id;
    row.classList.toggle('selected', quote.id === state.selectedQuoteId);
    row.innerHTML = `
      <td>${quote.quoteNumber ?? '—'}</td>
      <td>${quote.business || '—'}</td>
      <td>${getRacePackageLabel(quote.packageOption || '')}</td>
      <td>${quote.contactName || '—'}</td>
      <td>${formatQuoteStatus(quote.status)}</td>
      <td>${formatDate(quote.updatedAt || quote.createdAt)}</td>
    `;
    row.addEventListener('click', () => {
      state.selectedQuoteId = quote.id;
      renderQuotesTable();
      renderQuoteDetail(quote);
      if (!state.quoteDetails[quote.id]) {
        loadQuoteDetail(quote.id);
      }
    });
    elements.quotesTableBody.appendChild(row);
  });

  const selected = list.find((quote) => quote.id === state.selectedQuoteId);
  if (selected) {
    renderQuoteDetail(selected);
    if (!state.quoteDetails[selected.id]) {
      loadQuoteDetail(selected.id);
    }
  }
}

function renderQuoteDetail(quote) {
  if (!elements.quoteDetail) return;
  if (!quote) {
    elements.quoteDetail.innerHTML = '<p class="placeholder">Select a race quote to review details.</p>';
    return;
  }

  const detail = state.quoteDetails[quote.id];
  const current = detail?.quote || quote;
  const packageLabel = getRacePackageLabel(current.packageOption || '');
  const addonsLabel = (current.addons || []).map((addon) => formatAddonLabel(addon)).join(', ');
  const driverSummary = formatNameWithCountry(current.contactName || '', current.driverCountry);
  const coDriverSummary = formatNameWithCountry(current.coDriver || '', current.coDriverCountry);
  const quoteSummaryLines = [];
  if (driverSummary) {
    quoteSummaryLines.push(`<p class="muted">Driver: ${driverSummary}</p>`);
  }
  if (coDriverSummary) {
    quoteSummaryLines.push(`<p class="muted">Co-driver: ${coDriverSummary}</p>`);
  }
  if (current.carNumber) {
    quoteSummaryLines.push(`<p class="muted">Car #: ${current.carNumber}</p>`);
  }
  if (current.racingBody) {
    quoteSummaryLines.push(`<p class="muted">Series: ${current.racingBody}</p>`);
  }
  if (current.requestDate) {
    quoteSummaryLines.push(
      `<p class="muted">Requested: ${formatDate(current.requestDate)}</p>`
    );
  }

  const metaParts = [
    driverSummary ? `Driver: ${driverSummary}` : '',
    coDriverSummary ? `Co-driver: ${coDriverSummary}` : '',
    current.carNumber ? `Car #: ${current.carNumber}` : '',
    `Package: ${packageLabel}`,
    addonsLabel ? `Add-ons: ${addonsLabel}` : '',
    current.vehicle ? `Vehicle: ${current.vehicle}` : '',
    current.colors ? `Primary colors: ${current.colors}` : '',
    current.notes ? `Customer notes: ${current.notes}` : '',
    current.timelineText ? `Timeline: ${current.timelineText}` : '',
    current.deliveryText ? `Delivery: ${current.deliveryText}` : '',
    current.pricingNotes ? `Pricing notes: ${current.pricingNotes}` : '',
    current.quoteValidUntil ? `Valid until: ${current.quoteValidUntil}` : '',
    current.adminNotes ? `Shop notes: ${current.adminNotes}` : ''
  ]
    .filter(Boolean)
    .map((text) => `<p>${text}</p>`)
    .join('');
  const metaContent = metaParts || '<p>No additional details yet.</p>';
  const sponsorMarkup = renderSponsorSummary(current.sponsors);

  elements.quoteDetail.innerHTML = `
    <div class="quote-summary">
      <h3>${current.business || 'Race quote'}</h3>
      <p class="muted">Contact: ${current.contactName || '—'} · ${current.customer?.email || ''}</p>
      <p class="muted">Status: ${formatQuoteStatus(current.status)}</p>
      ${quoteSummaryLines.join('')}
    </div>

    <form id="quotePricingForm" class="quote-form">
      <fieldset>
        <legend>Pricing</legend>
        <label>
          <span>Base package</span>
          <input type="number" step="0.01" id="quoteBaseInput" />
        </label>
        <label>
          <span>Add-ons</span>
          <input type="number" step="0.01" id="quoteAddonsInput" />
        </label>
        <label>
          <span>Subtotal</span>
          <input type="number" step="0.01" id="quoteSubtotalInput" />
        </label>
        <label>
          <span>Sales tax</span>
          <input type="number" step="0.01" id="quoteTaxInput" />
        </label>
        <label>
          <span>Total</span>
          <input type="number" step="0.01" id="quoteTotalInput" />
        </label>
        <label>
          <span>Pricing notes</span>
          <textarea id="quotePricingNotesInput" rows="2"></textarea>
        </label>
      </fieldset>

      <fieldset>
        <legend>Timeline & Delivery</legend>
        <label>
          <span>Timeline</span>
          <input type="text" id="quoteTimelineInput" placeholder="e.g. Proof in 2 days, install next week" />
        </label>
        <label>
          <span>Delivery</span>
          <input type="text" id="quoteDeliveryInput" placeholder="e.g. Pick up at shop, shipping available" />
        </label>
        <label>
          <span>Valid until</span>
          <input type="text" id="quoteValidInput" placeholder="Optional date or timeframe" />
        </label>
        <label>
          <span>Shop notes (private)</span>
          <textarea id="quoteAdminNotesInput" rows="2"></textarea>
        </label>
      </fieldset>

      <label>
        <span>Status</span>
        <select id="quoteStatusSelect">
          <option value="submitted">Submitted</option>
          <option value="in_review">In review</option>
          <option value="quoted">Quoted</option>
          <option value="awaiting_payment">Awaiting payment</option>
          <option value="approved">Approved</option>
          <option value="paid">Paid</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </label>

      <div class="quote-form-actions">
        <button type="submit" class="primary">Save updates</button>
        <button type="button" class="secondary" id="quoteGenerateAssetsButton">Generate cut JPEGs</button>
      </div>
    </form>

    <section class="quote-meta">
      <h4>Request summary</h4>
      ${metaContent}
      ${sponsorMarkup}
    </section>

    <section class="quote-files">
      <h4>Files</h4>
      <div id="quoteFilesContainer" class="quote-files-list">Loading files…</div>
    </section>

    <section class="quote-messages">
      <h4>Conversation</h4>
      <div id="quoteMessagesContainer" class="quote-messages-list">Loading messages…</div>
      <form id="quoteMessageForm" class="quote-message-form">
        <textarea id="quoteMessageInput" rows="3" placeholder="Send an update to the customer…"></textarea>
        <button type="submit" class="secondary">Send message</button>
      </form>
    </section>
  `;

  const fields = {
    base: document.getElementById('quoteBaseInput'),
    addons: document.getElementById('quoteAddonsInput'),
    subtotal: document.getElementById('quoteSubtotalInput'),
    tax: document.getElementById('quoteTaxInput'),
    total: document.getElementById('quoteTotalInput'),
    pricingNotes: document.getElementById('quotePricingNotesInput'),
    timeline: document.getElementById('quoteTimelineInput'),
    delivery: document.getElementById('quoteDeliveryInput'),
    valid: document.getElementById('quoteValidInput'),
    adminNotes: document.getElementById('quoteAdminNotesInput'),
    status: document.getElementById('quoteStatusSelect')
  };

  const toDollars = (cents) => (Number.isFinite(cents) ? (cents / 100).toFixed(2) : '');

  fields.base.value = toDollars(current.baseCents);
  fields.addons.value = toDollars(current.addonsCents);
  fields.subtotal.value = toDollars(current.subtotalCents);
  fields.tax.value = toDollars(current.taxCents);
  fields.total.value = toDollars(current.totalCents);
  fields.pricingNotes.value = current.pricingNotes || '';
  fields.timeline.value = current.timelineText || '';
  fields.delivery.value = current.deliveryText || '';
  fields.valid.value = current.quoteValidUntil || '';
  fields.adminNotes.value = current.adminNotes || '';
  fields.status.value = (current.status || 'submitted').toLowerCase();

  const pricingForm = document.getElementById('quotePricingForm');
  pricingForm.addEventListener('submit', (event) => {
    event.preventDefault();
    handleQuoteUpdate(current.id, fields, pricingForm.querySelector('button[type="submit"]'));
  });

  const generateButton = document.getElementById('quoteGenerateAssetsButton');
  if (generateButton) {
    generateButton.addEventListener('click', () => {
      handleQuoteGenerateAssets(current.id, generateButton);
    });
  }

  const messageForm = document.getElementById('quoteMessageForm');
  const messageInput = document.getElementById('quoteMessageInput');
  const messagesContainer = document.getElementById('quoteMessagesContainer');
  const filesContainer = document.getElementById('quoteFilesContainer');
  messageForm.addEventListener('submit', (event) => {
    event.preventDefault();
    handleQuoteMessageSend(current.id, messageInput, messagesContainer, messageForm.querySelector('button'));
  });

  if (detail) {
    renderQuoteMessages(messagesContainer, detail.messages);
    renderQuoteAttachments(filesContainer, detail.files);
  } else {
    messagesContainer.textContent = 'Loading messages…';
    filesContainer.textContent = 'Loading files…';
  }
}

async function handleQuoteUpdate(quoteId, fields, submitButton) {
  if (!quoteId) return;
  const payload = {
    status: fields.status.value,
    pricingNotes: fields.pricingNotes.value.trim(),
    timelineText: fields.timeline.value.trim(),
    deliveryText: fields.delivery.value.trim(),
    quoteValidUntil: fields.valid.value.trim(),
    adminNotes: fields.adminNotes.value.trim()
  };

  const parseMoney = (input) => {
    const value = parseFloat(input.value);
    if (Number.isFinite(value)) {
      return Math.round(value * 100);
    }
    return null;
  };

  const baseCents = parseMoney(fields.base);
  const addonsCents = parseMoney(fields.addons);
  const subtotalCents = parseMoney(fields.subtotal);
  const taxCents = parseMoney(fields.tax);
  const totalCents = parseMoney(fields.total);

  if (baseCents !== null) payload.baseCents = baseCents;
  if (addonsCents !== null) payload.addonsCents = addonsCents;
  if (subtotalCents !== null) payload.subtotalCents = subtotalCents;
  if (taxCents !== null) payload.taxCents = taxCents;
  if (totalCents !== null) payload.totalCents = totalCents;

  submitButton.disabled = true;
  try {
    const response = await printStation.updateRaceQuote(quoteId, payload);
    if (response?.quote) {
      updateQuoteInState(response.quote);
      state.quoteDetails[quoteId] = null;
      renderQuotesTable();
      showToast('Quote updated.', 'success');
    }
  } catch (error) {
    console.error('handleQuoteUpdate error:', error);
    showToast(error.message || 'Unable to update quote.', 'error', 5000);
  } finally {
    submitButton.disabled = false;
  }
}

async function handleQuoteGenerateAssets(quoteId, button) {
  if (!quoteId) return;
  if (button) {
    button.disabled = true;
  }
  showToast('Generating cut JPEGs…', 'info');
  try {
    const response = await printStation.generateQuoteAssets(quoteId);
    if (response?.success) {
      const count = Array.isArray(response.files) ? response.files.length : 0;
      const suffix = count === 1 ? '' : 's';
      const detail = response.outputDir ? ` → ${response.outputDir}` : '';
      showToast(`Generated ${count} JPEG${suffix}${detail}`, 'success', 6000);
    } else if (response?.cancelled) {
      showToast('Generation cancelled.', 'info');
    } else {
      throw new Error(response?.error || 'Unable to generate JPEGs.');
    }
  } catch (error) {
    console.error('handleQuoteGenerateAssets error:', error);
    showToast(error.message || 'Unable to generate JPEGs.', 'error', 6000);
  } finally {
    if (button) {
      button.disabled = false;
    }
  }
}

function renderQuoteMessages(container, messages = []) {
  if (!container) return;
  container.innerHTML = '';
  if (!messages.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'No messages yet.';
    container.appendChild(empty);
    return;
  }
  messages.forEach((message) => {
    const bubble = document.createElement('div');
    bubble.className = `quote-message quote-message--${message.sender || 'customer'}`;
    const meta = document.createElement('span');
    meta.className = 'quote-message__meta';
    const when = message.createdAt ? new Date(message.createdAt).toLocaleString() : '';
    meta.textContent = `${message.sender === 'shop' ? 'Shop' : 'Customer'} · ${when}`;
    const body = document.createElement('p');
    body.className = 'quote-message__body';
    body.textContent = message.message;
    bubble.appendChild(meta);
    bubble.appendChild(body);
    container.appendChild(bubble);
  });
}

function renderQuoteAttachments(container, files = []) {
  if (!container) return;
  container.innerHTML = '';
  if (!files.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'No files uploaded yet.';
    container.appendChild(empty);
    return;
  }
  const list = document.createElement('ul');
  list.className = 'quote-file-list';
  files.forEach((file) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary';
    button.textContent = file.originalName || 'Download';
    button.disabled = !file.url;
    button.addEventListener('click', () => {
      if (file.url) {
        const target = file.url.startsWith('http') ? file.url : buildServerUrl(file.url);
        if (target) {
          printStation.openExternal(target);
        }
      }
    });
    const meta = document.createElement('span');
    meta.className = 'quote-file-meta';
    const sizeKb = file.size ? `${(file.size / 1024).toFixed(1)} KB` : '';
    const uploaded = file.createdAt ? new Date(file.createdAt).toLocaleString() : '';
    meta.textContent = [sizeKb, uploaded].filter(Boolean).join(' · ');
    item.appendChild(button);
    if (meta.textContent) {
      item.appendChild(meta);
    }
    list.appendChild(item);
  });
  container.appendChild(list);
}

async function handleQuoteMessageSend(quoteId, input, container, button) {
  const message = input.value.trim();
  if (!message) {
    showToast('Enter a message before sending.', 'error');
    return;
  }
  button.disabled = true;
  try {
    const response = await printStation.postRaceQuoteMessage(quoteId, message);
    if (response?.message) {
      const cache = state.quoteDetails[quoteId] || { quote: null, messages: [], files: [] };
      cache.messages = [...(cache.messages || []), response.message];
      state.quoteDetails[quoteId] = cache;
      input.value = '';
      renderQuoteMessages(container, cache.messages);
      showToast('Message sent.', 'success');
    }
  } catch (error) {
    console.error('handleQuoteMessageSend error:', error);
    showToast(error.message || 'Unable to send message.', 'error');
  } finally {
    button.disabled = false;
  }
}

async function loadQuoteDetail(id) {
  try {
    const detail = await printStation.fetchRaceQuoteDetail(id);
    if (detail?.quote) {
      updateQuoteInState(detail.quote);
      state.quoteDetails[id] = {
        quote: detail.quote,
        messages: Array.isArray(detail.messages) ? detail.messages : [],
        files: Array.isArray(detail.files) ? detail.files : []
      };
      if (state.selectedQuoteId === id) {
        renderQuoteDetail(detail.quote);
      }
    }
  } catch (error) {
    console.error('loadQuoteDetail error:', error);
    showToast(error.message || 'Unable to load quote detail.', 'error');
  }
}

async function refreshQuotes({ silent = false } = {}) {
  if (state.quotesLoading) return;
  if (!silent) {
    showToast('Refreshing race quotes…', 'info');
  }
  state.quotesLoading = true;
  try {
    const payload = await printStation.fetchRaceQuotes();
    state.quotes = Array.isArray(payload?.quotes) ? payload.quotes : [];
    state.quotes.forEach((quote) => {
      if (state.quoteDetails[quote.id]) {
        state.quoteDetails[quote.id].quote = quote;
      }
    });
    filterQuotes();
  } catch (error) {
    console.error('refreshQuotes error:', error);
    showToast(error.message || 'Unable to load race quotes.', 'error');
  } finally {
    state.quotesLoading = false;
  }
}

function updateQuoteInState(updated) {
  if (!updated) return;
  const index = state.quotes.findIndex((quote) => quote.id === updated.id);
  if (index >= 0) {
    state.quotes[index] = updated;
  } else {
    state.quotes.unshift(updated);
  }
  if (state.quoteDetails[updated.id]) {
    state.quoteDetails[updated.id].quote = updated;
  }
  filterQuotes();
}

function formatQuoteStatus(status) {
  switch ((status || '').toLowerCase()) {
    case 'in_review':
      return 'In review';
    case 'quoted':
      return 'Quoted';
    case 'awaiting_payment':
      return 'Awaiting payment';
    case 'approved':
      return 'Approved';
    case 'paid':
      return 'Paid';
    case 'cancelled':
      return 'Cancelled';
    case 'submitted':
    default:
      return 'Submitted';
  }
}

function getRacePackageLabel(value) {
  switch ((value || '').toLowerCase()) {
    case 'basic':
      return 'Basic Number Kit';
    case 'sponsor':
      return 'Sponsor Kit';
    case 'pro':
      return 'Pro Package';
    case 'elite':
      return 'Elite Custom Kit';
    default:
      return value || 'Package';
  }
}

function getSponsorSizeLabel(value) {
  if (!value) return '';
  const key = String(value).toLowerCase();
  return SPONSOR_SIZE_LABELS[key] || value;
}

function formatAddonLabel(value) {
  if (!value) return '';
  return value
    .split(/[-_]/g)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

function formatCountryLabel(code) {
  if (!code) return '';
  const normalized = String(code).trim().toUpperCase();
  return COUNTRY_NAMES[normalized] || normalized;
}

function formatNameWithCountry(name, country) {
  if (!name) return '';
  const label = formatCountryLabel(country);
  return label ? `${name} (${label})` : name;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderTextLayers(list = []) {
  if (!Array.isArray(list) || !list.length) {
    return '<p class="hint">No custom text layers.</p>';
  }
  return `
    <div class="text-layer-list">
      ${list
        .map(
          (layer, idx) => `
            <div class="text-layer-item">
              <strong>Line ${idx + 1}:</strong> ${layer.content || ''}
              <div class="hint">
                Font: ${layer.font || '—'} • Size: ${layer.fontSize || '—'} • Color: ${
            layer.color || '—'
          }
              </div>
            </div>
          `
        )
        .join('')}
    </div>
  `;
}

function renderSponsorSummary(list = []) {
  if (!Array.isArray(list) || !list.length) {
    return '';
  }
  const sponsors = list.filter((entry) => entry && entry.name);
  if (!sponsors.length) {
    return '';
  }

  const items = sponsors
    .map((sponsor) => {
      const details = [];
      const sizeLabel = getSponsorSizeLabel(sponsor.size);
      if (sizeLabel) {
        details.push(sizeLabel);
      }
      if (sponsor.color) {
        details.push(`Color: ${sponsor.color}`);
      }
      if (sponsor.apparel) {
        details.push('Include on apparel');
      }
      const detailText = details.length
        ? `<span class="quote-sponsor-meta">${details.join(' • ')}</span>`
        : '';
      return `
        <li>
          <span class="quote-sponsor-name">${sponsor.name}</span>
          ${detailText}
        </li>
      `;
    })
    .join('');

  if (!items) {
    return '';
  }

  return `
    <div class="quote-sponsors">
      <h4>Sponsor decals</h4>
      <ul class="quote-sponsor-list">
        ${items}
      </ul>
    </div>
  `;
}

function renderApparelItems(list = []) {
  if (!Array.isArray(list) || !list.length) {
    return '';
  }
  const subtotalCents = list.reduce((sum, item) => {
    if (Number.isFinite(item.lineTotalCents)) return sum + item.lineTotalCents;
    if (Number.isFinite(item.unitPriceCents)) {
      return sum + item.unitPriceCents * Math.max(1, Number(item.quantity) || 1);
    }
    return sum;
  }, 0);
  const items = list
    .map((item) => {
      const quantityLabel = escapeHtml(String(item.quantity || 1));
      const quantityValue = Math.max(1, Number(item.quantity) || 1);
      const title = escapeHtml(item.title || item.handle || 'Apparel item');
      const parts = [];
      if (item.color) parts.push(item.color);
      if (item.size) parts.push(item.size);
      parts.push(`SKU ${item.sku}`);
      const meta = escapeHtml(parts.join(' • '));
      const productLink = item.productUrl
        ? `<button type="button" class="link-button" data-action="open-apparel" data-url="${encodeURIComponent(
            item.productUrl
          )}">Product page</button>`
        : '';
      const imageLink = item.imageUrl
        ? `<button type="button" class="link-button" data-action="open-apparel-image" data-url="${encodeURIComponent(
            item.imageUrl
          )}">Open image</button>`
        : '';
      const lineTotalCents = Number.isFinite(item.lineTotalCents) ? item.lineTotalCents : 0;
      const unitPriceCents = Number.isFinite(item.unitPriceCents)
        ? item.unitPriceCents
        : lineTotalCents && quantityValue > 0
        ? Math.round(lineTotalCents / quantityValue)
        : 0;
      const price = lineTotalCents
        ? `<div class="queue-apparel-price">${escapeHtml(
            `${formatMoney(unitPriceCents)} each · ${formatMoney(lineTotalCents)}`
          )}</div>`
        : '';
      let warningText = '';
      if (!item.imageUrl && item.imageStatus?.status) {
        warningText =
          item.imageStatus.status === 403
            ? 'Preview blocked by vendor (HTTP 403).'
            : `Preview unavailable (HTTP ${item.imageStatus.status}).`;
      }
      const warning = warningText
        ? `<div class="queue-apparel-warning">${escapeHtml(warningText)}</div>`
        : '';
      return `
        <li>
          <div class="queue-apparel-name">${quantityLabel} × ${title}</div>
          <div class="queue-apparel-meta">${meta}</div>
          ${productLink}
          ${imageLink}
          ${price}
          ${warning}
        </li>
      `;
    })
    .join('');
  const subtotalLine = subtotalCents
    ? `<div class="queue-apparel-total">Apparel subtotal: ${escapeHtml(formatMoney(subtotalCents))}</div>`
    : '';
  return `
    <div class="queue-apparel">
      <h4>Apparel add-ons</h4>
      <ul>${items}</ul>
      ${subtotalLine}
    </div>
  `;
}

function renderInventoryUsage(list = []) {
  if (!Array.isArray(list) || !list.length) {
    return '';
  }
  const items = list
    .map((entry) => {
      const name = escapeHtml(entry.name || entry.itemName || entry.itemId || 'Inventory item');
      const quantity = Number(entry.quantity || 0);
      const unit = escapeHtml(entry.unit || 'unit');
      const material = entry.material ? escapeHtml(formatInventoryMaterial(entry.material)) : '';
      const color = entry.color ? escapeHtml(entry.color) : '';
      const metaParts = [];
      if (material) metaParts.push(material);
      if (color) metaParts.push(color);
      if (entry.reason) metaParts.push(escapeHtml(entry.reason));
      const meta = metaParts.length
        ? `<div class="queue-inventory-meta">${metaParts.join(' • ')}</div>`
        : '';
      const swatch = entry.color
        ? `<span class="inventory-swatch" style="background-color: ${entry.color};"></span>`
        : '';
      return `<li><span class="queue-inventory-qty">${quantity} ${unit}</span>${swatch}<span class="queue-inventory-name">${name}</span>${meta}</li>`;
    })
    .join('');
  return `
    <div class="queue-inventory-usage">
      <h4>Inventory usage</h4>
      <ul>${items}</ul>
    </div>
  `;
}

function formatInventoryMaterial(value) {
  const material = String(value || '').toLowerCase();
  if (!material) return 'Inventory';
  if (material === 'regular-vinyl') return 'Regular vinyl';
  if (material === 'heat-transfer') return 'Heat transfer vinyl';
  if (material === 'apparel') return 'Apparel';
  return material.replace(/[-_]/g, ' ').replace(/\b\w/g, (match) => match.toUpperCase());
}

function formatInventoryQuantity(item) {
  const quantity = Number(item?.quantity || 0);
  const unit = item?.unit || 'unit';
  return `${quantity} ${unit}`;
}

function slugify(value, fallback = 'item') {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  if (slug === 't-shirt') return 'tshirt';
  return slug || fallback;
}

function formatApparelTypeLabel(value) {
  const slug = String(value || '').trim().toLowerCase();
  if (!slug) return 'Apparel';
  if (slug === 'tshirt' || slug === 't-shirt' || slug === 'tee') return 'T-shirt';
  if (slug === 'hoodie') return 'Hoodie';
  if (slug === 'beanie') return 'Beanie';
  if (slug === 'hat' || slug === 'cap') return 'Hat';
  const parts = slug.split(/[-_]/).filter(Boolean);
  return parts
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function normalizeApparelTypeEntry(entry) {
  if (!entry) return null;
  const rawValue = entry.value || entry;
  const rawLabel = entry.label || entry;
  const slug = slugify(rawValue || rawLabel);
  if (!slug || slug === 'other') return null;
  const label = entry.label ? String(entry.label).trim() : formatApparelTypeLabel(slug);
  return { value: slug, label: label || formatApparelTypeLabel(slug) };
}

function loadStoredApparelTypes() {
  try {
    const raw = localStorage.getItem(APPAREL_TYPES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeApparelTypeEntry).filter(Boolean);
  } catch (error) {
    console.warn('Unable to load stored apparel types:', error);
    return [];
  }
}

function saveApparelTypes(types) {
  try {
    localStorage.setItem(APPAREL_TYPES_STORAGE_KEY, JSON.stringify(types));
  } catch (error) {
    console.warn('Unable to persist apparel types:', error);
  }
}

function setApparelTypes(types = []) {
  const unique = new Map();
  types.forEach((entry) => {
    if (entry && entry.value) {
      unique.set(entry.value, { value: entry.value, label: entry.label });
    }
  });
  state.apparelTypes = Array.from(unique.values()).sort((a, b) =>
    a.label.localeCompare(b.label)
  );
  renderApparelTypeOptions();
}

function renderApparelTypeOptions(selectedValue) {
  if (!elements.inventoryApparelTypeSelect) return;
  const select = elements.inventoryApparelTypeSelect;
  const previous = selectedValue || select.value || 'tshirt';
  select.innerHTML = '';
  state.apparelTypes.forEach((entry) => {
    const option = document.createElement('option');
    option.value = entry.value;
    option.textContent = entry.label;
    select.appendChild(option);
  });
  const otherOption = document.createElement('option');
  otherOption.value = 'other';
  otherOption.textContent = 'Other…';
  select.appendChild(otherOption);
  if (state.apparelTypes.some((entry) => entry.value === previous)) {
    select.value = previous;
  } else if (state.apparelTypes.length) {
    select.value = state.apparelTypes[0].value;
  } else {
    select.value = 'tshirt';
  }
  handleInventoryApparelTypeChange();
}

function showInventoryApparelOtherRow(show) {
  if (!elements.inventoryApparelTypeOtherRow) return;
  elements.inventoryApparelTypeOtherRow.classList.toggle('hidden', !show);
  if (!show && elements.inventoryApparelTypeOtherInput) {
    elements.inventoryApparelTypeOtherInput.value = '';
  }
  if (show && elements.inventoryApparelTypeOtherInput) {
    elements.inventoryApparelTypeOtherInput.focus();
  }
}

function handleInventoryApparelTypeChange() {
  if (!elements.inventoryApparelTypeSelect) return;
  const value = elements.inventoryApparelTypeSelect.value;
  showInventoryApparelOtherRow(value === 'other');
  populateInventoryApparelSizes();
}

function populateInventoryApparelSizes() {
  if (!elements.inventoryApparelSizeSelect) return;
  const select = elements.inventoryApparelSizeSelect;
  select.innerHTML = '';
  const type = elements.inventoryApparelTypeSelect?.value || 'tshirt';
  const preferred = type === 'hat' || type === 'beanie' ? 'One size fits all' : 'M';
  APPAREL_SIZE_OPTIONS.forEach((size) => {
    const option = document.createElement('option');
    option.value = size;
    option.textContent = size;
    if (size === preferred) {
      option.selected = true;
    }
    select.appendChild(option);
  });
  if (!APPAREL_SIZE_OPTIONS.includes(select.value)) {
    select.value = APPAREL_SIZE_OPTIONS[0];
  }
}

function addApparelType(label) {
  const normalizedLabel = formatApparelTypeLabel(label);
  const value = slugify(normalizedLabel);
  if (!value || value === 'other') return value;
  if (!state.apparelTypes.some((entry) => entry.value === value)) {
    const next = [...state.apparelTypes, { value, label: normalizedLabel }].sort((a, b) =>
      a.label.localeCompare(b.label)
    );
    setApparelTypes(next);
    saveApparelTypes(next);
    showToast(`Added apparel type: ${normalizedLabel}`, 'success');
  }
  return value;
}

function ensureApparelTypesInitialized() {
  const stored = loadStoredApparelTypes();
  const merged = [...DEFAULT_APPAREL_TYPES, ...stored];
  setApparelTypes(merged);
  saveApparelTypes(state.apparelTypes);
  populateInventoryApparelSizes();
}

function getInventoryItem(itemId) {
  return state.inventoryItems.find((item) => item.id === itemId) || null;
}

function centsToDisplay(cents) {
  if (!Number.isFinite(cents)) return '';
  return (cents / 100).toFixed(2);
}

function fillInventoryEditForm(itemId) {
  if (!elements.inventoryEditForm) return;
  const item = itemId ? getInventoryItem(itemId) : null;
  const disabled = !item;
  const inputs = [
    elements.inventoryEditName,
    elements.inventoryEditMaterial,
    elements.inventoryEditColor,
    elements.inventoryEditUnit,
    elements.inventoryEditCost,
    elements.inventoryEditUrl,
    elements.inventoryEditNotes
  ].filter(Boolean);
  const submitButton = elements.inventoryEditForm?.querySelector('button[type="submit"]');
  inputs.forEach((input) => {
    input.disabled = disabled;
  });
  if (submitButton) {
    submitButton.disabled = disabled;
  }
  if (!item) {
    if (elements.inventoryEditName) elements.inventoryEditName.value = '';
    if (elements.inventoryEditMaterial) elements.inventoryEditMaterial.value = '';
    if (elements.inventoryEditColor) elements.inventoryEditColor.value = '';
    if (elements.inventoryEditUnit) elements.inventoryEditUnit.value = '';
    if (elements.inventoryEditCost) elements.inventoryEditCost.value = '';
    if (elements.inventoryEditUrl) elements.inventoryEditUrl.value = '';
    if (elements.inventoryEditNotes) elements.inventoryEditNotes.value = '';
    return;
  }

  if (elements.inventoryEditName) elements.inventoryEditName.value = item.name || '';
  if (elements.inventoryEditMaterial) {
    elements.inventoryEditMaterial.value = item.material || '';
  }
  if (elements.inventoryEditColor) elements.inventoryEditColor.value = item.color || '';
  if (elements.inventoryEditUnit) elements.inventoryEditUnit.value = item.unit || '';
  if (elements.inventoryEditCost)
    elements.inventoryEditCost.value = centsToDisplay(item.unitCostCents);
  if (elements.inventoryEditUrl) elements.inventoryEditUrl.value = item.itemUrl || '';
  if (elements.inventoryEditNotes) elements.inventoryEditNotes.value = item.notes || '';
}

function setInventoryStatus(message, variant = 'muted') {
  if (!elements.inventoryStatus) return;
  elements.inventoryStatus.textContent = message;
  elements.inventoryStatus.className = `inventory-status ${variant}`;
}

function populateInventorySelects() {
  const adjustSelect = elements.inventoryAdjustItemSelect;
  const editSelect = elements.inventoryEditItemSelect;
  if (adjustSelect) {
    adjustSelect.innerHTML = '';
    if (!state.inventoryItems.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No inventory items';
      adjustSelect.appendChild(option);
      adjustSelect.disabled = true;
    } else {
      adjustSelect.disabled = false;
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Select an item';
      adjustSelect.appendChild(placeholder);
      state.inventoryItems.forEach((item) => {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = `${item.name} · ${formatInventoryQuantity(item)}`;
        adjustSelect.appendChild(option);
      });
    }
  }

  if (editSelect) {
    const previous = editSelect.value;
    editSelect.innerHTML = '';
    if (!state.inventoryItems.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No inventory items';
      editSelect.appendChild(option);
      editSelect.disabled = true;
      fillInventoryEditForm(null);
    } else {
      editSelect.disabled = false;
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Select an item';
      editSelect.appendChild(placeholder);
      state.inventoryItems.forEach((item) => {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = `${item.name} · ${formatInventoryQuantity(item)}`;
        editSelect.appendChild(option);
      });
      const nextValue = previous && getInventoryItem(previous) ? previous : state.inventoryItems[0].id;
      editSelect.value = nextValue || '';
      fillInventoryEditForm(editSelect.value || null);
    }
  }
}

function renderInventoryList() {
  if (!elements.inventoryList) return;
  if (state.inventoryLoading) {
    elements.inventoryList.innerHTML = '<p class="placeholder">Loading inventory…</p>';
    return;
  }
  if (state.inventoryError) {
    elements.inventoryList.innerHTML = `<p class="placeholder error">${escapeHtml(
      state.inventoryError
    )}</p>`;
    return;
  }
  if (!state.inventoryItems.length) {
    elements.inventoryList.innerHTML =
      '<p class="placeholder">No inventory items yet. Add stock to get started.</p>';
    return;
  }

  const rows = state.inventoryItems
    .map((item) => {
      const name = escapeHtml(item.name || 'Inventory item');
      const material = escapeHtml(formatInventoryMaterial(item.material));
      const quantity = formatInventoryQuantity(item);
      let colorDisplay = item.color || '';
      let colorIsHex =
        !!colorDisplay && /^#([0-9A-F]{3}|[0-9A-F]{6})$/i.test(colorDisplay);
      if ((!colorDisplay || colorDisplay === '#') && item.material === 'apparel') {
        const match = /Color:\s*([^|]+)/i.exec(item.notes || '');
        if (match) {
          colorDisplay = match[1].trim();
          colorIsHex = /^#([0-9A-F]{3}|[0-9A-F]{6})$/i.test(colorDisplay);
        }
      }
      const colorCell = colorDisplay
        ? colorIsHex
          ? `<span class="inventory-swatch" style="background-color: ${colorDisplay};"></span>${escapeHtml(
              colorDisplay
            )}`
          : escapeHtml(colorDisplay)
        : '—';
      const cost = Number.isFinite(item.unitCostCents)
        ? formatMoney(item.unitCostCents)
        : '—';
      const used =
        Number.isFinite(item.totalRemoved) && item.totalRemoved
          ? `${Math.abs(Math.round(item.totalRemoved))} ${item.unit || 'unit'}`
          : '—';
      const notes = item.notes ? escapeHtml(item.notes) : '—';
      return `
        <tr>
          <td>${name}</td>
          <td>${material}</td>
          <td>${colorCell}</td>
          <td>${escapeHtml(quantity)}</td>
          <td>${escapeHtml(cost)}</td>
          <td>${escapeHtml(used)}</td>
          <td>${notes}</td>
        </tr>
      `;
    })
    .join('');

  elements.inventoryList.innerHTML = `
    <table class="inventory-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Material</th>
          <th>Color</th>
          <th>On hand</th>
          <th>Cost/unit</th>
          <th>Used</th>
          <th>Notes</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

async function loadInventory(material = state.inventoryMaterial, { silent = false } = {}) {
  if (state.inventoryLoading && !silent) {
    return;
  }
  const targetMaterial = material || state.inventoryMaterial || 'regular-vinyl';
  state.inventoryLoading = true;
  state.inventoryError = null;
  if (!silent) {
    setInventoryStatus('Loading inventory…', 'muted');
    renderInventoryList();
  }
  try {
    const data = await printStation.fetchInventory({ material: targetMaterial });
    const items = Array.isArray(data?.items) ? data.items.slice() : [];
    items.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    state.inventoryItems = items;
    state.inventoryMaterial = targetMaterial;
    if (elements.inventoryMaterialSelect) {
      elements.inventoryMaterialSelect.value = targetMaterial;
    }
    const label = targetMaterial === 'all' ? 'All inventory' : formatInventoryMaterial(targetMaterial);
    setInventoryStatus(
      `${items.length} item${items.length === 1 ? '' : 's'} · ${label}`,
      'muted'
    );
    state.inventoryLoading = false;
    renderInventoryList();
    populateInventorySelects();
    state.inventoryInitialized = true;
  } catch (error) {
    console.error('Unable to load inventory:', error);
    state.inventoryItems = [];
    state.inventoryError = error.message || 'Unable to load inventory.';
    setInventoryStatus(state.inventoryError, 'error');
    state.inventoryLoading = false;
    renderInventoryList();
    populateInventorySelects();
    state.inventoryInitialized = false;
  } finally {
    state.inventoryLoading = false;
  }
}

async function handleInventoryAddSubmit(event) {
  event.preventDefault();
  const name = elements.inventoryAddName?.value.trim();
  if (!name) {
    showToast('Enter a name for the inventory item.', 'error');
    return;
  }
  const quantityValue = Number(elements.inventoryAddQuantity?.value);
  const payload = {
    name,
    color: elements.inventoryAddColor?.value.trim() || undefined,
    material: elements.inventoryAddMaterial?.value || 'regular-vinyl',
    quantity: Number.isFinite(quantityValue) ? Math.round(quantityValue) : 0,
    unit: elements.inventoryAddUnit?.value.trim() || 'unit',
    unitCost: elements.inventoryAddCost?.value.trim() || undefined,
    itemUrl: elements.inventoryAddUrl?.value.trim() || undefined,
    notes: elements.inventoryAddNotes?.value.trim() || undefined
  };

  try {
    elements.inventoryAddForm.classList.add('busy');
    setInventoryStatus('Saving inventory item…', 'muted');
    await printStation.createInventoryItem(payload);
    showToast('Inventory item saved.', 'success');
    elements.inventoryAddForm.reset();
    if (elements.inventoryAddUnit) {
      elements.inventoryAddUnit.value = payload.unit || 'unit';
    }
    if (elements.inventoryAddMaterial) {
      elements.inventoryAddMaterial.value = payload.material;
    }
    if (elements.inventoryAddQuantity) {
      elements.inventoryAddQuantity.value = '0';
    }
    await loadInventory(state.inventoryMaterial, { silent: true });
  } catch (error) {
    console.error(error);
    showToast(error.message || 'Unable to save inventory item.', 'error', 6000);
    setInventoryStatus(error.message || 'Unable to save inventory item.', 'error');
  } finally {
    elements.inventoryAddForm.classList.remove('busy');
  }
}

async function handleInventoryApparelSubmit(event) {
  event.preventDefault();
  if (!elements.inventoryApparelTypeSelect) return;

  let typeValue = elements.inventoryApparelTypeSelect.value || 'tshirt';
  let typeLabel;
  if (typeValue === 'other') {
    const custom = elements.inventoryApparelTypeOtherInput?.value.trim();
    if (!custom) {
      showToast('Enter a new apparel type.', 'error');
      elements.inventoryApparelTypeOtherInput?.focus();
      return;
    }
    typeValue = addApparelType(custom);
    typeLabel = formatApparelTypeLabel(custom);
    renderApparelTypeOptions(typeValue);
  } else {
    const entry = state.apparelTypes.find((item) => item.value === typeValue);
    typeLabel = entry?.label || formatApparelTypeLabel(typeValue);
  }

  if (!typeValue) {
    showToast('Unable to determine apparel type.', 'error');
    return;
  }

  const quantityRaw = Number(elements.inventoryApparelQuantity?.value);
  if (!Number.isFinite(quantityRaw) || quantityRaw <= 0) {
    showToast('Enter a quantity greater than zero.', 'error');
    elements.inventoryApparelQuantity?.focus();
    return;
  }
  const quantity = Math.round(quantityRaw);

  const sizeValue = elements.inventoryApparelSizeSelect?.value || '';
  const colorInput = elements.inventoryApparelColorInput?.value.trim() || '';
  const costInput = elements.inventoryApparelCostInput?.value.trim() || '';
  if (!colorInput) {
    showToast('Enter a color for this apparel item.', 'error');
    elements.inventoryApparelColorInput?.focus();
    return;
  }
  if (!costInput) {
    showToast('Enter the cost per unit for this apparel item.', 'error');
    elements.inventoryApparelCostInput?.focus();
    return;
  }
  const normalizedCostNumber = Number(costInput.replace(/,/g, '.').replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(normalizedCostNumber) || normalizedCostNumber < 0) {
    showToast('Enter a valid cost per unit.', 'error');
    elements.inventoryApparelCostInput?.focus();
    return;
  }

  const hexPattern = /^#?[0-9a-f]{3,6}$/i;
  const colorPayload = colorInput && hexPattern.test(colorInput) ? colorInput : undefined;
  const colorDisplay = colorInput || '';

  const notesParts = [`Apparel type: ${typeLabel}`];
  if (sizeValue) notesParts.push(`Size: ${sizeValue}`);
  if (colorDisplay) notesParts.push(`Color: ${colorDisplay}`);
  const notes = notesParts.join(' | ').slice(0, 160);

  const nameParts = [typeLabel];
  if (colorDisplay) nameParts.push(colorDisplay);
  if (sizeValue) nameParts.push(sizeValue);
  const itemName = nameParts
    .join(' - ')
    .trim()
    .slice(0, 120);

  const payload = {
    name: itemName,
    material: 'apparel',
    quantity,
    unit: 'unit',
    size: sizeValue || undefined,
    notes,
    unitCostCents: Math.round(normalizedCostNumber * 100)
  };
  if (colorPayload) {
    payload.color = colorPayload;
  }

  try {
    elements.inventoryApparelForm?.classList.add('busy');
    setInventoryStatus('Saving apparel item…', 'muted');
    await printStation.createInventoryItem(payload);
    showToast('Apparel item saved.', 'success');
    if (elements.inventoryApparelForm) {
      elements.inventoryApparelForm.reset();
    }
    if (elements.inventoryApparelQuantity) {
      elements.inventoryApparelQuantity.value = '1';
    }
    populateInventoryApparelSizes();
    renderApparelTypeOptions(typeValue);
    showInventoryApparelOtherRow(false);
    await loadInventory(state.inventoryMaterial === 'apparel' ? 'apparel' : state.inventoryMaterial, {
      silent: true
    });
  } catch (error) {
    console.error(error);
    showToast(error.message || 'Unable to save apparel item.', 'error', 6000);
    setInventoryStatus(error.message || 'Unable to save apparel item.', 'error');
  } finally {
    elements.inventoryApparelForm?.classList.remove('busy');
  }
}

async function handleInventoryAdjustSubmit(event) {
  event.preventDefault();
  const itemId = elements.inventoryAdjustItemSelect?.value;
  if (!itemId) {
    showToast('Select an inventory item to adjust.', 'error');
    return;
  }
  const changeValue = Number(elements.inventoryAdjustAmount?.value);
  if (!Number.isFinite(changeValue) || Math.round(changeValue) === 0) {
    showToast('Enter a non-zero adjustment amount.', 'error');
    return;
  }
  const payload = {
    itemId,
    change: Math.round(changeValue),
    reason: elements.inventoryAdjustReason?.value.trim() || undefined,
    notes: elements.inventoryAdjustNotes?.value.trim() || undefined
  };

  try {
    elements.inventoryAdjustForm.classList.add('busy');
    setInventoryStatus('Updating inventory…', 'muted');
    await printStation.adjustInventory(payload);
    showToast('Inventory updated.', 'success');
    elements.inventoryAdjustForm.reset();
    await loadInventory(state.inventoryMaterial, { silent: true });
  } catch (error) {
    console.error(error);
    showToast(error.message || 'Unable to adjust inventory.', 'error', 6000);
    setInventoryStatus(error.message || 'Unable to adjust inventory.', 'error');
  } finally {
    elements.inventoryAdjustForm.classList.remove('busy');
  }
}

function handleInventoryMaterialChange(event) {
  const value = event.target.value || 'regular-vinyl';
  loadInventory(value);
}

function handleInventoryRefresh() {
  setInventoryStatus('Loading inventory…', 'muted');
  loadInventory(state.inventoryMaterial);
}

function handleInventoryEditSelectionChange() {
  const itemId = elements.inventoryEditItemSelect?.value || '';
  if (!itemId) {
    fillInventoryEditForm(null);
  } else {
    fillInventoryEditForm(itemId);
  }
}

async function handleInventoryEditSubmit(event) {
  event.preventDefault();
  const itemId = elements.inventoryEditItemSelect?.value;
  if (!itemId) {
    showToast('Select an inventory item to edit.', 'error');
    return;
  }
  const current = getInventoryItem(itemId);
  const payload = { itemId };
  const name = elements.inventoryEditName?.value.trim();
  if (name) payload.name = name;
  const material = elements.inventoryEditMaterial?.value;
  if (material) payload.material = material;
  const colorRaw = elements.inventoryEditColor?.value;
  if (colorRaw !== undefined) {
    const color = colorRaw.trim();
    if (color) {
      payload.color = color;
    } else if (current?.color) {
      payload.color = '';
    }
  }
  const unit = elements.inventoryEditUnit?.value.trim();
  if (unit) payload.unit = unit;
  const cost = elements.inventoryEditCost?.value.trim();
  if (cost) {
    payload.unitCost = cost;
  } else if (
    elements.inventoryEditCost &&
    current &&
    current.unitCostCents !== null &&
    current.unitCostCents !== undefined
  ) {
    payload.unitCost = '';
  }
  const url = elements.inventoryEditUrl?.value.trim();
  if (elements.inventoryEditUrl) {
    const rawUrl = elements.inventoryEditUrl.value.trim();
    if (rawUrl) {
      payload.itemUrl = rawUrl;
    } else if (current?.itemUrl) {
      payload.itemUrl = '';
    }
  }
  if (elements.inventoryEditNotes) {
    const notesRaw = elements.inventoryEditNotes.value;
    if (notesRaw.trim()) {
      payload.notes = notesRaw.trim();
    } else if (notesRaw !== undefined && current?.notes) {
      payload.notes = '';
    }
  }

  if (Object.keys(payload).length === 1) {
    showToast('Enter at least one field to update.', 'warning');
    return;
  }

  try {
    elements.inventoryEditForm?.classList.add('busy');
    setInventoryStatus('Updating inventory item…', 'muted');
    await printStation.updateInventoryItem(payload);
    showToast('Inventory item updated.', 'success');
    await loadInventory(state.inventoryMaterial, { silent: true });
    if (elements.inventoryEditItemSelect) {
      elements.inventoryEditItemSelect.value = itemId;
      fillInventoryEditForm(itemId);
    }
  } catch (error) {
    console.error(error);
    showToast(error.message || 'Unable to update inventory item.', 'error', 6000);
    setInventoryStatus(error.message || 'Unable to update inventory item.', 'error');
  } finally {
    elements.inventoryEditForm?.classList.remove('busy');
  }
}

function renderQueueDetail(order) {
  if (!order) {
    elements.queueDetail.innerHTML = '<p class="placeholder">Select an order to view details.</p>';
    return;
  }

  const customer = order.customer || {};
  const previewUrl = order.previewFile
    ? buildServerUrl(`/files/saved/${encodeURIComponent(order.previewFile)}`)
    : null;

  const sources =
    Array.isArray(order.sourceCopies) && order.sourceCopies.length
      ? order.sourceCopies
      : [];

  const downloadBy = state.config?.employeeName || '';
  const isRaceQuoteOrder = (order.category || '').toLowerCase().includes('race quote');

  elements.queueDetail.innerHTML = `
    ${
      isRaceQuoteOrder
        ? '<div class="queue-alert">Race quote request · update pricing & timeline from the “Race Quotes” tab.</div>'
        : ''
    }
    <h3>
      <span>Order #${order.orderNumber ?? order.id}</span>
      <span class="badge ${
        order.paymentStatus === 'PAID' || order.paid ? 'success' : 'warning'
      }">${order.paymentStatus || (order.paid ? 'PAID' : 'UNPAID')}</span>
    </h3>
    <div class="meta-grid">
      <div>
        <span>Design</span>
        ${order.designName || 'Untitled'}
      </div>
      <div>
        <span>Category</span>
        ${order.category || '—'}
      </div>
      <div>
        <span>Quantity</span>
        ${order.quantity ?? '—'}
      </div>
      <div>
        <span>Width</span>
        ${order.size ? `${Number(order.size).toFixed(1)}"` : '—'}
      </div>
      <div>
        <span>Vinyl</span>
        ${order.color || '—'}
      </div>
      <div>
        <span>Background</span>
        ${order.background || '—'}
      </div>
      <div>
        <span>Saved</span>
        ${formatDate(order.savedAt)}
      </div>
      <div>
        <span>Total</span>
        ${formatMoney(order.pricing?.totalCents)}
      </div>
    </div>

    <div class="meta-grid">
      <div>
        <span>Customer</span>
        ${customer.name || '—'}
      </div>
      <div>
        <span>Email</span>
        <a href="mailto:${customer.email || ''}">${customer.email || '—'}</a>
      </div>
      <div>
        <span>Phone</span>
        ${customer.phone || '—'}
      </div>
      <div>
        <span>Address</span>
        ${customer.address || '—'}
      </div>
    </div>

    <div class="actions">
      ${
        previewUrl
          ? `<button class="primary" data-action="open-preview">Open Preview</button>
             <button class="secondary" data-action="download-preview">Download Preview</button>`
          : ''
      }
      ${
        sources.length
          ? sources
              .map(
                (source) => `
              <button class="secondary" data-action="open-source" data-file="${encodeURIComponent(
                source.file
              )}">
                ${source.format?.toUpperCase() || 'Source'}
              </button>`
              )
              .join('')
          : ''
      }
      <button class="secondary" data-action="mark-downloaded">Mark Downloaded</button>
      <button class="primary" data-action="mark-completed">Mark Completed</button>
    </div>

    <label class="inline">
      Downloaded by
      <input id="downloadedByInput" type="text" value="${downloadBy}" placeholder="Operator name" />
    </label>
    <textarea id="completionNoteInput" class="notes-textarea" placeholder="Internal completion note (optional)"></textarea>

    ${renderApparelItems(order.apparelItems)}
    ${renderInventoryUsage(order.inventoryUsage)}

    <div>
      <h4>Custom text layers</h4>
      ${renderTextLayers(order.textLayers)}
    </div>

    <div class="notes">
      <strong>Customer notes:</strong>
      <div>${order.notes ? order.notes.replace(/\n/g, '<br>') : '<span class="hint">No notes.</span>'}</div>
    </div>
  `;

  const previewButton = elements.queueDetail.querySelector('[data-action="open-preview"]');
  if (previewButton && previewUrl) {
    previewButton.addEventListener('click', () => {
      state.lastPreviewOpenedFor = order.id;
      printStation.openExternal(previewUrl);
    });
    if (state.config?.autoOpenPreview && state.lastPreviewOpenedFor !== order.id) {
      state.lastPreviewOpenedFor = order.id;
      printStation.openExternal(previewUrl);
    }
  }

  const downloadPreviewButton = elements.queueDetail.querySelector('[data-action="download-preview"]');
  if (downloadPreviewButton && previewUrl) {
    const originalLabel = downloadPreviewButton.textContent;
    downloadPreviewButton.addEventListener('click', async () => {
      try {
        downloadPreviewButton.disabled = true;
        downloadPreviewButton.textContent = 'Downloading…';
        const defaultFile =
          order.previewFile ||
          order.savedPreview ||
          `order-${order.orderNumber || order.id}.png`;
        const result = await printStation.downloadFile({
          url: previewUrl,
          filename: defaultFile
        });
        if (result?.canceled) {
          showToast('Download canceled.', 'warning', 4000);
        } else {
          showToast('Preview downloaded.', 'success');
        }
      } catch (error) {
        showToast(error.message || 'Unable to download preview.', 'error', 6000);
      } finally {
        downloadPreviewButton.disabled = false;
        downloadPreviewButton.textContent = originalLabel;
      }
    });
  }

  elements.queueDetail.querySelectorAll('[data-action="open-source"]').forEach((button) => {
    button.addEventListener('click', () => {
      const file = button.dataset.file;
      if (!file) return;
      const url = buildServerUrl(`/files/saved/${file}`);
      if (url) {
        printStation.openExternal(url);
      }
    });
  });

  elements.queueDetail.querySelectorAll('[data-action="open-apparel"]').forEach((button) => {
    button.addEventListener('click', () => {
      const encodedUrl = button.dataset.url || '';
      if (!encodedUrl) return;
      const url = decodeURIComponent(encodedUrl);
      if (url) {
        printStation.openExternal(url);
      }
    });
  });

  elements.queueDetail.querySelectorAll('[data-action="open-apparel-image"]').forEach((button) => {
    button.addEventListener('click', () => {
      const encodedUrl = button.dataset.url || '';
      if (!encodedUrl) return;
      const rawUrl = decodeURIComponent(encodedUrl);
      const url = /^https?:/i.test(rawUrl) ? rawUrl : buildServerUrl(rawUrl);
      if (url) {
        printStation.openExternal(url);
      }
    });
  });

  const downloadButton = elements.queueDetail.querySelector('[data-action="mark-downloaded"]');
  if (downloadButton) {
    downloadButton.addEventListener('click', async () => {
      try {
        downloadButton.disabled = true;
        const downloadedBy = document.getElementById('downloadedByInput')?.value?.trim();
        await printStation.markDownloaded({
          orderId: order.id,
          downloadedBy: downloadedBy || undefined
        });
        showToast(`Order #${order.orderNumber} marked as downloaded.`, 'success');
        await refreshQueue({ silent: true });
      } catch (error) {
        showToast(error.message || 'Failed to mark downloaded.', 'error', 6000);
      } finally {
        downloadButton.disabled = false;
      }
    });
  }

  const completeButton = elements.queueDetail.querySelector('[data-action="mark-completed"]');
  if (completeButton) {
    completeButton.addEventListener('click', async () => {
      try {
        completeButton.disabled = true;
        const note = document.getElementById('completionNoteInput')?.value?.trim();
        await printStation.markCompleted({
          orderId: order.id,
          note: note || undefined
        });
        showToast(`Order #${order.orderNumber} completed.`, 'success');
        await refreshQueue({ silent: true });
      } catch (error) {
        showToast(error.message || 'Failed to mark completed.', 'error', 6000);
      } finally {
        completeButton.disabled = false;
      }
    });
  }
}

async function refreshQueue({ silent = false } = {}) {
  if (state.pollInFlight) return;
  try {
    state.pollInFlight = true;
    const response = await printStation.fetchQueue();
    const orders = Array.isArray(response?.orders) ? response.orders : [];
    const sorted = orders.slice().sort((a, b) => {
      return new Date(a.savedAt).getTime() - new Date(b.savedAt).getTime();
    });

    const previousIds = new Set(state.queue.map((order) => order.id));
    state.queue = sorted;
    state.queueIdSet = new Set(sorted.map((order) => order.id));
    renderQueueTable();

    const newOrders = sorted.filter((order) => !previousIds.has(order.id));
    if (!silent && newOrders.length) {
      notifyNewOrders(newOrders);
    }

    setConnectionStatus(true, `Connected to ${state.config.serverBaseUrl}`);
  } catch (error) {
    if (!silent) {
      showToast(error.message || 'Unable to load queue.', 'error', 6000);
    }
    setConnectionStatus(false, 'Connection failed');
  } finally {
    state.pollInFlight = false;
  }
}

function schedulePolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  const interval = Number(state.config?.pollIntervalMs || 0);
  if (interval >= 5000) {
    state.pollTimer = setInterval(() => {
      refreshQueue({ silent: true });
    }, interval);
  }
}

function populateCatalogCategories() {
  const categories = Array.isArray(state.catalog?.categories) ? state.catalog.categories : [];
  const selectElements = [elements.catalogCategorySelect, elements.existingCategorySelect];
  selectElements.forEach((select) => {
    select.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = categories.length ? 'All categories' : 'No categories';
    if (select === elements.existingCategorySelect) {
      placeholder.textContent = categories.length ? 'Select a category…' : 'No categories';
      placeholder.disabled = true;
    }
    select.appendChild(placeholder);
    categories.forEach((category) => {
      const option = document.createElement('option');
      option.value = category.slug;
      option.textContent = `${category.name} (${category.designs.length})`;
      select.appendChild(option);
    });
  });
}

function renderCatalog() {
  const categories = Array.isArray(state.catalog?.categories) ? state.catalog.categories : [];
  if (!categories.length) {
    elements.catalogGrid.innerHTML =
      '<p class="hint">No catalog data found. Generate catalog on the server first.</p>';
    return;

  }
  let designs = categories.flatMap((category) =>
    (category.designs || []).map((design) => ({
      ...design,
      categoryName: category.name,
      categorySlug: category.slug
    }))
  );

  if (state.catalogFilter.category) {
    designs = designs.filter((design) => design.categorySlug === state.catalogFilter.category);
  }

  if (state.catalogFilter.search) {
    const term = state.catalogFilter.search.toLowerCase();
    designs = designs.filter((design) => design.name.toLowerCase().includes(term));
  }

  if (!designs.length) {
    elements.catalogGrid.innerHTML =
      '<p class="hint">No designs matched your filters.</p>';
    return;
  }

  elements.catalogGrid.innerHTML = designs
    .map((design) => {
      const previewUrl = resolveAssetUrl(design.image, { width: 480, quality: 80 });
      const rawName = design.name || 'Catalog design';
      const designIdAttr = escapeHtml(design.id || rawName);
      const safeName = escapeHtml(rawName);
      const safeCategory = escapeHtml(design.categoryName || '');
      const downloadSourceAttr = escapeHtml(design.image || '');
      const downloadNameAttr = escapeHtml(rawName);
      const sourceLinks = design.sources
        ? Object.entries(design.sources).map(
            ([format, url]) => `
              <button class="secondary catalog-source" data-source="${encodeURIComponent(
                url
              )}">
                ${escapeHtml(format.toUpperCase())}
              </button>
            `
          )
        : [];
      return `
        <article class="catalog-card" data-design="${designIdAttr}">
          <img
            src="${previewUrl}"
            alt="${safeName}"
            loading="lazy"
            decoding="async"
            data-download-src="${downloadSourceAttr}"
            data-download-name="${downloadNameAttr}"
            title="Click to download preview"
          />
          <h3>${safeName}</h3>
          <p class="hint">${safeCategory}</p>
          ${
            sourceLinks.length
              ? `<div class="sources">${sourceLinks.join('')}</div>`
              : '<p class="hint">No source files</p>'
          }
        </article>
      `;
    })
    .join('');

  elements.catalogGrid.querySelectorAll('.catalog-source').forEach((button) => {
    button.addEventListener('click', () => {
      const source = decodeURIComponent(button.dataset.source || '');
      const url = resolveAssetUrl(source);
      if (url) {
        printStation.openExternal(url);
      }
    });
  });

  elements.catalogGrid.querySelectorAll('.catalog-card img').forEach((img) => {
    img.addEventListener('click', () => {
      const parent = img.closest('.catalog-card');
      const designId = parent?.dataset.design || '';
      const name = img.dataset.downloadName || designId || 'catalog-design';
      const imagePath = img.dataset.downloadSrc || '';
      void handleCatalogImageDownload({ id: designId, name, image: imagePath });
    });
  });
}

function formatCatalogTimestamp(isoString) {
  if (!isoString) return 'unknown time';
  const date = new Date(isoString);
  const timestamp = date.getTime();
  if (!Number.isFinite(timestamp)) return 'unknown time';
  const diffMs = Date.now() - timestamp;
  if (diffMs < 0) {
    return date.toLocaleString();
  }
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  if (diffMs < minuteMs) return 'just now';
  if (diffMs < hourMs) {
    const mins = Math.round(diffMs / minuteMs);
    return `${mins} min${mins === 1 ? '' : 's'} ago`;
  }
  if (diffMs < dayMs) {
    const hours = Math.round(diffMs / hourMs);
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  if (diffMs < dayMs * 5) {
    const days = Math.round(diffMs / dayMs);
    return `${days} day${days === 1 ? '' : 's'} ago`;
  }
  return date.toLocaleString();
}

function updateCatalogStatus({ meta = state.catalogCacheMeta, statusText, variant } = {}) {
  if (!elements.catalogStatus) return;
  if (statusText) {
    const appliedVariant = variant || 'warning';
    elements.catalogStatus.textContent = statusText;
    elements.catalogStatus.className = `catalog-status ${appliedVariant}`;
    return;
  }
  if (!state.catalog) {
    elements.catalogStatus.textContent = 'Catalog not loaded.';
    elements.catalogStatus.className = 'catalog-status warning';
    return;
  }

  const cacheMeta = meta || {};
  let statusVariant = 'success';
  let descriptor = 'Fresh from server';
  if (cacheMeta.staleFallback) {
    statusVariant = 'warning';
    descriptor = 'Offline cache';
  } else if (cacheMeta.fromCache) {
    statusVariant = 'muted';
    descriptor = 'Cached copy';
  }

  const timeLabel = formatCatalogTimestamp(cacheMeta.fetchedAt);
  elements.catalogStatus.textContent = `${descriptor} • updated ${timeLabel}`;
  elements.catalogStatus.className = `catalog-status ${statusVariant}`;
}

async function loadCatalog({ silent = false, forceRefresh = false } = {}) {
  try {
    const fetchOptions = forceRefresh
      ? { forceRefresh: true, maxAgeMs: 0 }
      : undefined;
    const catalog = await printStation.fetchCatalog(fetchOptions);
    state.catalog = catalog;
    state.catalogCacheMeta = catalog?.__catalogCache || null;
    populateCatalogCategories();
    renderCatalog();
    updateCatalogStatus();
    if (!silent) {
      const meta = state.catalogCacheMeta;
      if (meta?.staleFallback) {
        showToast('Catalog loaded from offline cache.', 'warning', 6000);
      } else if (meta?.fromCache) {
        showToast('Catalog loaded from cache.', 'info', 4000);
      } else {
        showToast(forceRefresh ? 'Catalog refreshed.' : 'Catalog loaded.', 'success');
      }
    }
  } catch (error) {
    state.catalog = null;
    state.catalogCacheMeta = null;
    populateCatalogCategories();
    elements.catalogGrid.innerHTML =
      '<p class="hint">Unable to load catalog. Check the connection or regenerate it on the server.</p>';
    updateCatalogStatus({
      statusText: 'Catalog unavailable. Check connection or reload.',
      variant: 'warning'
    });
    if (!silent) {
      showToast(error.message || 'Unable to load catalog.', 'error', 6000);
    }
  }
}

function setUploadApparelType(value) {
  const normalized = typeof value === 'string' && value ? value : 'tshirt';
  state.upload.apparelType = normalized;
  if (elements.uploadApparelType) {
    elements.uploadApparelType.value = normalized;
  }
}

function setUploadApparelEnabled(enabled) {
  const active = Boolean(enabled);
  state.upload.isApparel = active;
  if (elements.uploadApparelToggle) {
    elements.uploadApparelToggle.checked = active;
  }
  if (elements.uploadApparelType) {
    elements.uploadApparelType.disabled = !active;
    if (!active) {
      setUploadApparelType('tshirt');
    } else {
      setUploadApparelType(state.upload.apparelType || 'tshirt');
    }
  }
  if (elements.uploadApparelTypeRow) {
    elements.uploadApparelTypeRow.classList.toggle('disabled', !active);
  }
}

function resetUploadForm() {
  state.upload.previewPath = null;
  state.upload.sourcePaths = [];
  elements.uploadForm.reset();
  elements.previewFileLabel.textContent = 'No file selected';
  elements.sourceFilesLabel.textContent = 'No files selected';
  elements.uploadStatus.textContent = 'Waiting for input.';
  elements.uploadStatus.className = 'status-bar muted';
  elements.existingCategoryRow.classList.remove('hidden');
  elements.newCategoryRow.classList.add('hidden');
  setUploadApparelType('tshirt');
  setUploadApparelEnabled(false);
}

function applyCategoryMode(mode) {
  if (mode === 'new') {
    elements.existingCategoryRow.classList.add('hidden');
    elements.newCategoryRow.classList.remove('hidden');
  } else {
    elements.existingCategoryRow.classList.remove('hidden');
    elements.newCategoryRow.classList.add('hidden');
  }
}

function populateSettingsForm() {
  const cfg = state.config || {};
  elements.serverUrlInput.value = cfg.serverBaseUrl || '';
  elements.assetUrlInput.value = cfg.assetBaseUrl || '';
  elements.apiKeyInput.value = cfg.apiKey || '';
  elements.employeeNameInput.value = cfg.employeeName || '';
  elements.autoOpenPreviewCheckbox.checked = Boolean(cfg.autoOpenPreview);
  const pollSeconds = Math.max(5, Math.round((cfg.pollIntervalMs || 30000) / 1000));
  elements.pollIntervalInput.value = pollSeconds;
}

async function handleSettingsSubmit(event) {
  event.preventDefault();
  const pollSeconds = Math.max(5, Number(elements.pollIntervalInput.value) || 30);
  const updated = {
    serverBaseUrl: elements.serverUrlInput.value.trim(),
    assetBaseUrl: elements.assetUrlInput.value.trim(),
    apiKey: elements.apiKeyInput.value.trim(),
    employeeName: elements.employeeNameInput.value.trim(),
    autoOpenPreview: elements.autoOpenPreviewCheckbox.checked,
    pollIntervalMs: pollSeconds * 1000
  };
  try {
    state.config = await printStation.saveConfig(updated);
    populateSettingsForm();
    schedulePolling();
    await refreshQueue({ silent: true });
    elements.settingsStatus.textContent = 'Settings saved.';
    elements.settingsStatus.className = 'status-bar success';
    showToast('Settings saved.', 'success');
  } catch (error) {
    elements.settingsStatus.textContent = error.message || 'Unable to save settings.';
    elements.settingsStatus.className = 'status-bar error';
    showToast(error.message || 'Unable to save settings.', 'error', 6000);
  }
}

async function handleTestConnection() {
  try {
    elements.testConnectionButton.disabled = true;
    await refreshQueue({ silent: true });
    await loadCatalog({ silent: true });
    elements.settingsStatus.textContent = 'Connection succeeded.';
    elements.settingsStatus.className = 'status-bar success';
    showToast('Connection succeeded.', 'success');
  } catch (error) {
    elements.settingsStatus.textContent = error.message || 'Connection failed.';
    elements.settingsStatus.className = 'status-bar error';
    showToast(error.message || 'Connection failed.', 'error', 6000);
  } finally {
    elements.testConnectionButton.disabled = false;
  }
}

async function initUploadForm() {
  elements.uploadForm.addEventListener('change', (event) => {
    if (event.target.name === 'categoryMode') {
      applyCategoryMode(event.target.value);
    }
  });

  if (elements.uploadApparelToggle) {
    setUploadApparelEnabled(elements.uploadApparelToggle.checked);
    elements.uploadApparelToggle.addEventListener('change', (event) => {
      setUploadApparelEnabled(event.target.checked);
    });
  }

  if (elements.uploadApparelType) {
    elements.uploadApparelType.addEventListener('change', (event) => {
      setUploadApparelType(event.target.value || 'tshirt');
    });
  }

  elements.choosePreviewButton.addEventListener('click', async () => {
    const files = await printStation.selectFiles({
      title: 'Select preview image',
      properties: ['openFile'],
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    if (files && files.length) {
      state.upload.previewPath = files[0];
      elements.previewFileLabel.textContent = pathFromSelection(files[0]);
    }
  });

  elements.chooseSourcesButton.addEventListener('click', async () => {
    const files = await printStation.selectFiles({
      title: 'Select source files',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Vector Files', extensions: ['ai', 'eps', 'pdf', 'svg'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    if (files && files.length) {
      state.upload.sourcePaths = files;
      elements.sourceFilesLabel.textContent = files.map(pathFromSelection).join(', ');
    }
  });

  elements.resetUploadButton.addEventListener('click', () => {
    resetUploadForm();
  });

  elements.uploadForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(elements.uploadForm);
    const categoryMode = formData.get('categoryMode') || 'existing';
    const existingCategory = elements.existingCategorySelect.value || '';
    const newCategoryName = elements.newCategoryInput.value.trim();
    const displayName = elements.displayNameInput.value.trim();
    const isApparel = Boolean(elements.uploadApparelToggle?.checked);
    const apparelType = elements.uploadApparelType?.value || 'tshirt';

    if (categoryMode === 'existing' && !existingCategory) {
      elements.uploadStatus.textContent = 'Select an existing category.';
      elements.uploadStatus.className = 'status-bar error';
      return;
    }
    if (categoryMode === 'new' && !newCategoryName) {
      elements.uploadStatus.textContent = 'Enter a new category name.';
      elements.uploadStatus.className = 'status-bar error';
      return;
    }
    if (!state.upload.previewPath) {
      elements.uploadStatus.textContent = 'Choose a preview image before uploading.';
      elements.uploadStatus.className = 'status-bar error';
      return;
    }
    if (isApparel && !apparelType) {
      elements.uploadStatus.textContent = 'Choose an apparel style before uploading.';
      elements.uploadStatus.className = 'status-bar error';
      return;
    }

    state.upload.isApparel = isApparel;
    state.upload.apparelType = apparelType;

    try {
      elements.uploadStatus.textContent = 'Uploading artwork…';
      elements.uploadStatus.className = 'status-bar muted';
      await printStation.uploadArtwork({
        previewPath: state.upload.previewPath,
        sourcePaths: state.upload.sourcePaths,
        categoryMode,
        existingCategory,
        newCategoryName,
        displayName,
        apparel: isApparel
          ? { enabled: true, productType: apparelType }
          : { enabled: false }
      });
      elements.uploadStatus.textContent = 'Artwork uploaded successfully.';
      elements.uploadStatus.className = 'status-bar success';
      showToast('Artwork uploaded and catalog updated.', 'success');
      resetUploadForm();
      await loadCatalog({ silent: true });
    } catch (error) {
      const detailMessage = error?.detail?.error || error?.detail?.message;
      elements.uploadStatus.textContent = detailMessage || error.message || 'Upload failed.';
      elements.uploadStatus.className = 'status-bar error';
      showToast(detailMessage || error.message || 'Upload failed.', 'error', 6000);
    }
  });

  resetUploadForm();
}

function pathFromSelection(fullPath) {
  if (!fullPath) return '';
  const parts = fullPath.split(/[\\/]/);
  return parts[parts.length - 1];
}

async function init() {
  ensureApparelTypesInitialized();
  handleInventoryApparelTypeChange();

  elements.tabButtons.forEach((button) => {
    button.addEventListener('click', () => switchView(button.dataset.view));
  });

  elements.queueSearchInput.addEventListener('input', () => {
    renderQueueTable();
  });

  elements.quoteSearchInput?.addEventListener('input', () => {
    filterQuotes();
  });

  elements.refreshQueueButton.addEventListener('click', () => refreshQueue());
  elements.refreshQuotesButton?.addEventListener('click', () => refreshQuotes());
  elements.inventoryMaterialSelect?.addEventListener('change', handleInventoryMaterialChange);
  elements.inventoryRefreshButton?.addEventListener('click', handleInventoryRefresh);
  elements.inventoryAddForm?.addEventListener('submit', handleInventoryAddSubmit);
  elements.inventoryApparelTypeSelect?.addEventListener('change', handleInventoryApparelTypeChange);
  elements.inventoryApparelForm?.addEventListener('submit', handleInventoryApparelSubmit);
  elements.inventoryAdjustForm?.addEventListener('submit', handleInventoryAdjustSubmit);
  elements.inventoryEditItemSelect?.addEventListener('change', handleInventoryEditSelectionChange);
  elements.inventoryEditForm?.addEventListener('submit', handleInventoryEditSubmit);

  if (elements.inventoryList) {
    elements.inventoryList.innerHTML =
      '<p class="placeholder">Select “Refresh” to load inventory.</p>';
  }
  if (elements.inventoryStatus) {
    setInventoryStatus('Select “Refresh” to load inventory.', 'muted');
  }
  populateInventorySelects();
  populateInventorySelects();

  elements.pollIntervalInput.addEventListener('change', async () => {
    const seconds = Math.max(5, Number(elements.pollIntervalInput.value) || 30);
    elements.pollIntervalInput.value = seconds;
    if (!state.config) return;
    const update = { pollIntervalMs: seconds * 1000 };
    state.config = await printStation.saveConfig(update);
    schedulePolling();
    showToast(`Polling every ${seconds} seconds.`, 'success');
  });

  elements.catalogCategorySelect.addEventListener('change', () => {
    state.catalogFilter.category = elements.catalogCategorySelect.value || '';
    renderCatalog();
  });

  elements.catalogSearchInput.addEventListener('input', () => {
    state.catalogFilter.search = elements.catalogSearchInput.value.trim();
    renderCatalog();
  });

  elements.reloadCatalogButton.addEventListener('click', () => loadCatalog({ forceRefresh: true }));

  await initUploadForm();

  elements.settingsForm.addEventListener('submit', handleSettingsSubmit);
  elements.testConnectionButton.addEventListener('click', handleTestConnection);

  try {
    state.config = await printStation.getConfig();
    populateSettingsForm();
    schedulePolling();
    await refreshQueue({ silent: true });
    await refreshQuotes({ silent: true });
    await loadCatalog({ silent: true });
    await loadInventory(state.inventoryMaterial, { silent: true });
    setConnectionStatus(true, `Connected to ${state.config.serverBaseUrl}`);
  } catch (error) {
    setConnectionStatus(false, 'Connection required');
    showToast(error.message || 'Configure settings to connect to the server.', 'warning', 6000);
  }
}

init();
