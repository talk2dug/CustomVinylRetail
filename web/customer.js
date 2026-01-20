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
const REGISTER_ENDPOINT = `${API_BASE}/api/auth/register`;
const LOGIN_ENDPOINT = `${API_BASE}/api/auth/login`;
const LOGOUT_ENDPOINT = `${API_BASE}/api/auth/logout`;
const REQUEST_EMAIL_CONFIRM_ENDPOINT = `${API_BASE}/api/auth/request-email-confirmation`;
const CONFIRM_EMAIL_ENDPOINT = `${API_BASE}/api/auth/confirm-email`;
const REQUEST_PASSWORD_RESET_ENDPOINT = `${API_BASE}/api/auth/request-password-reset`;
const RESET_PASSWORD_ENDPOINT = `${API_BASE}/api/auth/reset-password`;
const CUSTOMER_ORDERS_ENDPOINT = `${API_BASE}/api/customer/orders`;
const CUSTOMER_PROFILE_ENDPOINT = `${API_BASE}/api/customer/profile`;
const CUSTOMER_REORDER_ENDPOINT = (id) =>
  `${API_BASE}/api/customer/orders/${encodeURIComponent(id)}/reorder`;
// Use general checkout endpoint for payment links
const CREATE_PAYMENT_LINK_ENDPOINT = (id) =>
  `${API_BASE}/api/orders/${encodeURIComponent(id)}/checkout`;
const CUSTOMER_RACE_QUOTES_ENDPOINT = `${API_BASE}/api/customer/race-quotes`;
const CUSTOMER_RACE_QUOTE_CHECKOUT_ENDPOINT = (id) =>
  `${API_BASE}/api/customer/race-quotes/${encodeURIComponent(id)}/checkout`;
const CUSTOMER_RACE_QUOTE_DETAIL_ENDPOINT = (id) =>
  `${API_BASE}/api/customer/race-quotes/${encodeURIComponent(id)}`;
const CUSTOMER_RACE_QUOTE_MESSAGES_ENDPOINT = (id) =>
  `${API_BASE}/api/customer/race-quotes/${encodeURIComponent(id)}/messages`;
const CUSTOMER_RACE_QUOTE_DECISION_ENDPOINT = (id) =>
  `${API_BASE}/api/customer/race-quotes/${encodeURIComponent(id)}/decision`;
const CUSTOMER_RACE_QUOTE_FILES_ENDPOINT = (id) =>
  `${API_BASE}/api/customer/race-quotes/${encodeURIComponent(id)}/files`;
const SAVED_FILE_URL = (file) => `${API_BASE}/files/saved/${encodeURIComponent(file)}`;
const REFRESH_ENDPOINT = `${API_BASE}/api/auth/refresh`;
const PUBLIC_CONFIG_ENDPOINT = `${API_BASE}/api/public/config`;

const USD_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD'
});

const state = {
  orders: [],
  raceQuotes: [],
  token: null,
  customer: null,
  loading: false,
  loadingQuotes: false,
  view: 'login',
  pendingResetToken: null
};
state.raceQuoteDetails = Object.create(null);

const APPAREL_BUNDLE_LABELS = {
  'apparel-shirts-5': 'Team Apparel Bundle · 5 T-shirts (25% off with decal package)',
  'apparel-shirts-hats': 'Crew Combo · 5 T-shirts + 5 hats (30% off with decal package)',
  'apparel-full-crew': 'Full Crew Bundle · 5 T-shirts, 5 hats, 5 hoodies (35% off with decal package)'
};

const SPONSOR_SIZE_OPTIONS = [
  { value: 'small', label: 'Small (18" and under)' },
  { value: 'medium', label: 'Medium (door panels)' },
  { value: 'large', label: 'Large (hood/quarter panels)' }
];

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

const COUNTRY_OPTIONS = COUNTRY_DATA.split('\n').map((line) => {
  const [value, label] = line.split('|');
  return { value, label };
});

const COUNTRY_LABELS = COUNTRY_OPTIONS.reduce((acc, option) => {
  acc[option.value] = option.label;
  return acc;
}, Object.create(null));

const RACE_BODY_NOTES = {
  ARA: 'ARA: Follow the official visual package templates for door placards, windshield, and rear glass decals.',
  SCCA: 'SCCA: Numbers 8" minimum on both sides with class letters beside them. Confirm GCR appendix for your class.',
  NASA:
    'NASA: Numbers on both sides and roof with class ID beside the door numbers. Check your series appendix for exact sizes.'
};

const elements = {
  authCard: document.getElementById('authCard'),
  loginForm: document.getElementById('loginForm'),
  loginEmail: document.getElementById('loginEmail'),
  loginPassword: document.getElementById('loginPassword'),
  registerForm: document.getElementById('registerForm'),
  registerName: document.getElementById('registerName'),
  registerEmail: document.getElementById('registerEmail'),
  registerPassword: document.getElementById('registerPassword'),
  registerConfirm: document.getElementById('registerConfirm'),
  registerPhone: document.getElementById('registerPhone'),
  registerAddress: document.getElementById('registerAddress'),
  registerSmsOptIn: document.getElementById('registerSmsOptIn'),
  showRegister: document.getElementById('showRegister'),
  registerBackToLogin: document.getElementById('registerBackToLogin'),
  ordersContainer: document.getElementById('ordersContainer'),
  shortcuts: document.getElementById('shortcuts'),
  uploadButton: document.getElementById('uploadButton'),
  uploadInput: document.getElementById('uploadInput'),
  forgotPasswordLink: document.getElementById('forgotPasswordLink'),
  resetRequestForm: document.getElementById('resetRequestForm'),
  resetRequestEmail: document.getElementById('resetRequestEmail'),
  backToLogin: document.getElementById('backToLogin'),
  resetPasswordForm: document.getElementById('resetPasswordForm'),
  resetNewPassword: document.getElementById('resetNewPassword'),
  resetConfirmPassword: document.getElementById('resetConfirmPassword'),
  resetTokenInput: document.getElementById('resetTokenInput'),
  resetCancelButton: document.getElementById('resetCancelButton'),
  statusBar: document.getElementById('statusBar'),
  orderTemplate: document.getElementById('customerOrderTemplate'),
  accountBar: document.getElementById('accountBar'),
  accountName: document.getElementById('accountName'),
  accountEmail: document.getElementById('accountEmail'),
  // Preferences
  prefsCard: document.getElementById('prefsCard'),
  smsPrefCheckbox: document.getElementById('smsPrefCheckbox'),
  savePrefsButton: document.getElementById('savePrefsButton'),
  prefsStatus: document.getElementById('prefsStatus'),
  logoutButton: document.getElementById('logoutButton'),
  verifyBanner: document.getElementById('verifyBanner'),
  openQuoteModal: document.getElementById('openQuoteModal'),
  quoteModal: document.getElementById('quoteModal'),
  closeQuoteModal: document.getElementById('closeQuoteModal'),
  closeQuoteModalFooter: document.getElementById('closeQuoteModalFooter'),
  resendVerification: document.getElementById('resendVerification'),
  racePackagesCard: document.getElementById('racePackagesCard'),
  raceQuotesCard: document.getElementById('raceQuotesCard'),
  raceQuoteForm: document.getElementById('raceQuoteForm'),
  raceQuoteBusiness: document.getElementById('raceQuoteBusiness'),
  raceQuoteCustomer: document.getElementById('raceQuoteCustomer'),
  raceQuoteRacingBody: document.getElementById('raceQuoteRacingBody'),
  raceQuoteBodyNote: document.getElementById('raceQuoteBodyNote'),
  raceQuoteCarNumber: document.getElementById('raceQuoteCarNumber'),
  raceQuoteCoDriver: document.getElementById('raceQuoteCoDriver'),
  raceQuoteDriverCountry: document.getElementById('raceQuoteDriverCountry'),
  raceQuoteCoDriverCountry: document.getElementById('raceQuoteCoDriverCountry'),
  raceQuoteDate: document.getElementById('raceQuoteDate'),
  raceQuoteVehicle: document.getElementById('raceQuoteVehicle'),
  raceQuoteColors: document.getElementById('raceQuoteColors'),
  raceQuoteNotes: document.getElementById('raceQuoteNotes'),
  raceQuoteSponsorsList: document.getElementById('raceQuoteSponsorsList'),
  raceQuoteAddSponsor: document.getElementById('raceQuoteAddSponsor'),
  raceQuotePackages: document.querySelectorAll('input[name="racePackage"]'),
  raceApparelOptions: document.querySelectorAll('input[name="raceApparelBundle"]'),
  raceQuoteAddons: document.querySelectorAll('.race-addons input[type="checkbox"]'),
  raceQuotesList: document.getElementById('raceQuotesList')
};

populateCountrySelect(elements.raceQuoteDriverCountry);
populateCountrySelect(elements.raceQuoteCoDriverCountry);

function setStatus(message, type = 'info') {
  const bar = elements.statusBar;
  if (!bar) return;
  bar.textContent = message || '';
  bar.className = `status ${type === 'error' ? 'error' : type === 'success' ? 'success' : ''}`;
}

function presetRaceQuoteForm() {
  if (elements.raceQuoteDate && !elements.raceQuoteDate.value) {
    elements.raceQuoteDate.value = new Date().toISOString().slice(0, 10);
  }
  if (elements.raceQuotePackages?.length) {
    let hasChecked = false;
    elements.raceQuotePackages.forEach((input) => {
      if (input.value === 'basic' && !hasChecked) {
        input.checked = true;
        hasChecked = true;
      }
    });
  }
  elements.raceQuoteAddons?.forEach((input) => {
    input.checked = false;
  });
  elements.raceApparelOptions?.forEach((input) => {
    input.checked = input.value === 'none';
  });
  if (elements.raceQuoteRacingBody) {
    elements.raceQuoteRacingBody.value = '';
    updateRaceBodyNote();
  }
  if (elements.raceQuoteCarNumber) {
    elements.raceQuoteCarNumber.value = '';
  }
  if (elements.raceQuoteCoDriver) {
    elements.raceQuoteCoDriver.value = '';
  }
  if (elements.raceQuoteDriverCountry) {
    elements.raceQuoteDriverCountry.value = '';
  }
  if (elements.raceQuoteCoDriverCountry) {
    elements.raceQuoteCoDriverCountry.value = '';
  }
  resetSponsorEntries();
}

function updateRaceBodyNote() {
  const note = elements.raceQuoteBodyNote;
  if (!note) return;
  const key = elements.raceQuoteRacingBody?.value || '';
  note.textContent = RACE_BODY_NOTES[key] || 'Share details about your series so we can tailor decals to the rulebook.';
}

function resetSponsorEntries() {
  if (!elements.raceQuoteSponsorsList) return;
  elements.raceQuoteSponsorsList.innerHTML = '';
  addSponsorEntry();
}

function addSponsorEntry(sponsor = {}) {
  if (!elements.raceQuoteSponsorsList) return;
  const entry = document.createElement('div');
  entry.className = 'sponsor-entry';

  const row = document.createElement('div');
  row.className = 'sponsor-entry-row';

  const nameLabel = document.createElement('label');
  const nameSpan = document.createElement('span');
  nameSpan.textContent = 'Sponsor name';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'Sponsor';
  nameInput.className = 'sponsor-name';
  nameInput.value = sponsor.name || '';
  nameLabel.appendChild(nameSpan);
  nameLabel.appendChild(nameInput);
  row.appendChild(nameLabel);

  const sizeLabel = document.createElement('label');
  const sizeSpan = document.createElement('span');
  sizeSpan.textContent = 'Decal size';
  const sizeSelect = document.createElement('select');
  sizeSelect.className = 'sponsor-size';
  SPONSOR_SIZE_OPTIONS.forEach(({ value, label }) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    if ((sponsor.size || 'medium').toLowerCase() === value) {
      option.selected = true;
    }
    sizeSelect.appendChild(option);
  });
  sizeLabel.appendChild(sizeSpan);
  sizeLabel.appendChild(sizeSelect);
  row.appendChild(sizeLabel);

  const colorLabel = document.createElement('label');
  const colorSpan = document.createElement('span');
  colorSpan.textContent = 'Color preference';
  const colorInput = document.createElement('input');
  colorInput.type = 'text';
  colorInput.placeholder = 'e.g. White on black';
  colorInput.className = 'sponsor-color';
  colorInput.value = sponsor.color || '';
  colorLabel.appendChild(colorSpan);
  colorLabel.appendChild(colorInput);
  row.appendChild(colorLabel);

  const apparelLabel = document.createElement('label');
  apparelLabel.className = 'sponsor-apparel-label';
  const apparelSpan = document.createElement('span');
  apparelSpan.textContent = 'Include on apparel';
  const apparelInput = document.createElement('input');
  apparelInput.type = 'checkbox';
  apparelInput.className = 'sponsor-apparel';
  apparelInput.checked = Boolean(sponsor.apparel);
  apparelLabel.appendChild(apparelSpan);
  apparelLabel.appendChild(apparelInput);
  row.appendChild(apparelLabel);

  entry.appendChild(row);

  const actions = document.createElement('div');
  actions.className = 'sponsor-entry-actions';
  const removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.className = 'danger';
  removeButton.textContent = 'Remove sponsor';
  removeButton.addEventListener('click', () => {
    if (elements.raceQuoteSponsorsList.children.length > 1) {
      entry.remove();
    } else {
      nameInput.value = '';
      sizeSelect.value = 'medium';
      colorInput.value = '';
      apparelInput.checked = false;
    }
  });
  actions.appendChild(removeButton);
  entry.appendChild(actions);

  elements.raceQuoteSponsorsList.appendChild(entry);
}

function collectSponsorEntries() {
  if (!elements.raceQuoteSponsorsList) return [];
  const sponsors = [];
  elements.raceQuoteSponsorsList.querySelectorAll('.sponsor-entry').forEach((entry) => {
    const name = entry.querySelector('.sponsor-name')?.value.trim();
    const size = entry.querySelector('.sponsor-size')?.value || 'medium';
    const color = entry.querySelector('.sponsor-color')?.value.trim();
    const apparel = entry.querySelector('.sponsor-apparel')?.checked || false;
    if (name) {
      sponsors.push({ name, size, color, apparel });
    }
  });
  return sponsors;
}

function showElement(element) {
  if (!element) return;
  element.classList.remove('hidden');
  element.removeAttribute('hidden');
}

function hideElement(element) {
  if (!element) return;
  element.classList.add('hidden');
  element.setAttribute('hidden', 'hidden');
}

function populateCountrySelect(select) {
  if (!select) return;
  select.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Choose country…';
  select.appendChild(placeholder);
  COUNTRY_OPTIONS.forEach(({ value, label }) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  });
}

function formatCountryLabel(code) {
  if (!code) return '';
  const normalized = String(code).trim().toUpperCase();
  return COUNTRY_LABELS[normalized] || normalized;
}

function formatNameWithCountry(name, country) {
  if (!name) return '';
  const label = formatCountryLabel(country);
  return label ? `${name} (${label})` : name;
}

function switchView(view) {
  state.view = view;
  const showRegister = view === 'register';
  if (showRegister) {
    showElement(elements.registerForm);
    hideElement(elements.loginForm);
  } else {
    showElement(elements.loginForm);
    hideElement(elements.registerForm);
  }
  hideElement(elements.resetRequestForm);
  hideElement(elements.resetPasswordForm);
}

function showResetRequestView() {
  state.view = 'reset-request';
  hideElement(elements.loginForm);
  hideElement(elements.registerForm);
  hideElement(elements.resetPasswordForm);
  showElement(elements.resetRequestForm);
}

function showResetPasswordView(token) {
  state.view = 'reset-password';
  hideElement(elements.loginForm);
  hideElement(elements.registerForm);
  hideElement(elements.resetRequestForm);
  showElement(elements.resetPasswordForm);
  state.pendingResetToken = token;
  if (elements.resetTokenInput) {
    elements.resetTokenInput.value = token;
  }
}

function returnToLoginViews() {
  state.pendingResetToken = null;
  hideElement(elements.resetRequestForm);
  hideElement(elements.resetPasswordForm);
  switchView('login');
}

async function handlePayAllUnpaid() {
  if (!state.token) {
    setStatus('Please sign in to pay for your orders.', 'error');
    return;
  }
  setStatus('Preparing your combined invoice…');
  try {
    const response = await fetch(`${API_BASE}/api/customer/orders/pay-all`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${state.token}` }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.url) {
      throw new Error(data.error || `Unable to create combined invoice (${response.status})`);
    }
    window.location.href = data.url;
  } catch (error) {
    console.error('Pay-all error:', error);
    setStatus(error.message || 'Unable to create combined invoice.', 'error');
  }
}

function setAuthenticated(customer, token) {
  const previousRemember = state.customer?.rememberToken || localStorage.getItem('stickerPortalRememberToken');
  state.token = token;
  if (token) {
    localStorage.setItem('stickerPortalToken', token);
  }
  const rememberToken = customer.rememberToken || previousRemember || null;
  state.customer = { ...customer, rememberToken };
  localStorage.setItem('stickerPortalCustomer', JSON.stringify(state.customer));
  if (rememberToken) {
    localStorage.setItem('stickerPortalRememberToken', rememberToken);
  }

  elements.accountBar.classList.remove('hidden');
  elements.accountName.textContent = customer.name || customer.email;
  elements.accountEmail.textContent = customer.email;
  elements.authCard.classList.add('hidden');
  elements.shortcuts?.classList.remove('hidden');
  elements.racePackagesCard?.classList.remove('hidden');
  elements.raceQuotesCard?.classList.remove('hidden');
  presetRaceQuoteForm();
  if (customer.emailVerified) {
    elements.verifyBanner?.classList.add('hidden');
  } else {
    elements.verifyBanner?.classList.remove('hidden');
  }
  loadRaceQuotes();
  // Fetch orders immediately after login
  fetchCustomerOrders();
  // Load profile preferences
  loadCustomerProfile();
}

function clearAuthentication() {
  state.customer = null;
  state.token = null;
  localStorage.removeItem('stickerPortalToken');
  localStorage.removeItem('stickerPortalCustomer');
  localStorage.removeItem('stickerPortalRememberToken');

  elements.accountBar.classList.add('hidden');
  elements.authCard.classList.remove('hidden');
  elements.shortcuts?.classList.add('hidden');
  elements.verifyBanner?.classList.add('hidden');
  elements.racePackagesCard?.classList.add('hidden');
  elements.raceQuotesCard?.classList.add('hidden');
  state.raceQuotes = [];
  state.raceQuoteDetails = Object.create(null);
  renderRaceQuotes([]);
  switchView('login');
  renderOrders([]);
  hideElement(elements.prefsCard);
}

async function loadCustomerProfile() {
  if (!state.token) return;
  try {
    const response = await fetch(CUSTOMER_PROFILE_ENDPOINT, {
      headers: { Authorization: `Bearer ${state.token}` }
    });
    if (!response.ok) return;
    const data = await response.json().catch(() => ({}));
    const customer = data.customer || null;
    if (customer) {
      showElement(elements.prefsCard);
      if (typeof customer.smsOptIn === 'boolean') {
        elements.smsPrefCheckbox.checked = customer.smsOptIn;
      }
    }
  } catch (e) {
    // ignore
  }
}

async function fetchCustomerOrders() {
  if (!state.token) return;
  if (state.loading) return;
  state.loading = true;
  setStatus('Loading your orders…');

  try {
    const response = await fetch(CUSTOMER_ORDERS_ENDPOINT, {
      headers: { Authorization: `Bearer ${state.token}` }
    });
    if (!response.ok) {
      if (response.status === 401) {
        const rememberToken = state.customer?.rememberToken || localStorage.getItem('stickerPortalRememberToken');
        if (rememberToken) {
          try {
            const refreshed = await refreshSession(rememberToken);
            setAuthenticated(refreshed.customer, refreshed.token);
            state.loading = false;
            return fetchCustomerOrders();
          } catch (error) {
            console.warn('Refresh after 401 failed:', error);
          }
        }
        clearAuthentication();
        setStatus('Please sign in again.', 'error');
        return;
      }
      throw new Error(`Unable to load orders (${response.status})`);
    }
    const payload = await response.json();
    state.orders = Array.isArray(payload.orders) ? payload.orders : [];
    renderOrders(state.orders);
    if (state.orders.length) {
      setStatus(`Showing ${state.orders.length} order${state.orders.length === 1 ? '' : 's'}.`, 'success');
    } else {
      // Do not show a status banner when there are no orders
      setStatus('');
    }
  } catch (error) {
    console.error('fetchCustomerOrders error:', error);
    setStatus(error.message || 'Unable to load orders.', 'error');
  } finally {
    state.loading = false;
  }
}

async function loadRaceQuotes({ silent = false } = {}) {
  if (!state.token || state.loadingQuotes) return;
  state.loadingQuotes = true;
  if (!silent) {
    setStatus('Loading your race quotes…');
  }
  try {
    const response = await fetch(CUSTOMER_RACE_QUOTES_ENDPOINT, {
      headers: { Authorization: `Bearer ${state.token}` }
    });
    if (!response.ok) {
      if (response.status === 401) {
        const rememberToken =
          state.customer?.rememberToken || localStorage.getItem('stickerPortalRememberToken');
        if (rememberToken) {
          try {
            const refreshed = await refreshSession(rememberToken);
            setAuthenticated(refreshed.customer, refreshed.token);
            state.loadingQuotes = false;
            return loadRaceQuotes({ silent: true });
          } catch (error) {
            console.warn('Unable to refresh race quote session:', error);
          }
        }
        clearAuthentication();
        setStatus('Please sign in again.', 'error');
        return;
      }
      throw new Error(`Unable to load race quotes (${response.status})`);
    }
    const payload = await response.json();
    state.raceQuotes = Array.isArray(payload.quotes) ? payload.quotes : [];
    state.raceQuotes.forEach((quote) => {
      if (state.raceQuoteDetails[quote.id]) {
        state.raceQuoteDetails[quote.id].quote = quote;
      }
    });
    renderRaceQuotes(state.raceQuotes);
    if (!silent) {
      if (state.raceQuotes.length) {
        setStatus(`Loaded ${state.raceQuotes.length} race quote${state.raceQuotes.length === 1 ? '' : 's'}.`, 'success');
      } else {
        setStatus('No race quotes yet. Submit the form below to get started.', 'info');
      }
    }
  } catch (error) {
    console.error('loadRaceQuotes error:', error);
    if (!silent) {
      setStatus(error.message || 'Unable to load race quotes.', 'error');
    }
    state.raceQuotes = [];
    renderRaceQuotes([]);
  } finally {
    state.loadingQuotes = false;
  }
}

async function handleLogin(event) {
  event.preventDefault();
  const email = elements.loginEmail.value.trim();
  const password = elements.loginPassword.value.trim();
  if (!email || !password) {
    setStatus('Please enter your email and password.', 'error');
    return;
  }

  setStatus('Signing in…');
  try {
    const response = await fetch(LOGIN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Invalid email or password.');
    }
    const payload = await response.json();
    setAuthenticated(payload.customer, payload.token);
    setStatus('Welcome back!', 'success');
    await fetchCustomerOrders();
  } catch (error) {
    console.error('Login failed:', error);
    setStatus(error.message || 'Unable to log in.', 'error');
  }
}

async function handleRegister(event) {
  event.preventDefault();
  const name = elements.registerName.value.trim();
  const email = elements.registerEmail.value.trim();
  const password = elements.registerPassword.value.trim();
  const confirm = elements.registerConfirm.value.trim();
  if (!name || !email || !password) {
    setStatus('Name, email, and password are required.', 'error');
    return;
  }
  if (password !== confirm) {
    setStatus('Passwords do not match.', 'error');
    return;
  }

  const phone = elements.registerPhone.value.trim();
  const address = elements.registerAddress.value.trim();
  const smsOptIn = Boolean(elements.registerSmsOptIn?.checked);

  setStatus('Creating your account…');
  try {
    const response = await fetch(REGISTER_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password, phone, address, smsOptIn })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Unable to register.');
    }
    const payload = await response.json();
    setAuthenticated(payload.customer, payload.token);
    let message = 'Account created! Check your email to confirm ownership.';
    if (payload.verification?.previewUrl) {
      message += ` Preview: ${payload.verification.previewUrl}`;
    }
    setStatus(message, 'success');
    await fetchCustomerOrders();
  } catch (error) {
    console.error('Registration failed:', error);
    setStatus(error.message || 'Unable to create account.', 'error');
  }
}

async function handleLogout() {
  if (!state.token) {
    clearAuthentication();
    return;
  }
  try {
    await fetch(LOGOUT_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${state.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ rememberToken: state.customer?.rememberToken })
    });
  } catch (error) {
    console.warn('Logout request failed (ignored):', error);
  } finally {
    clearAuthentication();
    setStatus('You have signed out.', 'success');
  }
}

async function handleResendVerification() {
  if (!state.token) {
    setStatus('Sign in to request a confirmation email.', 'error');
    return;
  }
  setStatus('Sending confirmation email…');
  try {
    const response = await fetch(REQUEST_EMAIL_CONFIRM_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${state.token}` }
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Request failed (${response.status})`);
    }
    const data = await response.json();
    let message = 'Check your inbox for the confirmation email.';
    if (data.previewUrl) {
      message += ` Preview: ${data.previewUrl}`;
    }
    setStatus(message, 'success');
  } catch (error) {
    console.error('Resend verification failed:', error);
    setStatus(error.message || 'Unable to send confirmation email.', 'error');
  }
}

async function handleResetRequest(event) {
  event.preventDefault();
  const email = elements.resetRequestEmail.value.trim();
  if (!email) {
    setStatus('Enter the email associated with your account.', 'error');
    return;
  }
  setStatus('Sending password reset link…');
  try {
    const response = await fetch(REQUEST_PASSWORD_RESET_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `Request failed (${response.status})`);
    }
    state.pendingResetToken = data.token || null;
    let message = 'If an account exists for that email, we just sent reset instructions.';
    if (data.previewUrl) {
      message += ` Preview: ${data.previewUrl}`;
    }
    setStatus(message, 'success');
    if (data.token) {
      showResetPasswordView(data.token);
    }
  } catch (error) {
    console.error('Reset request failed:', error);
    setStatus(error.message || 'Unable to send reset email.', 'error');
  }
}

async function handleResetPassword(event) {
  event.preventDefault();
  const password = elements.resetNewPassword.value.trim();
  const confirm = elements.resetConfirmPassword.value.trim();
  const token = elements.resetTokenInput.value || state.pendingResetToken;
  if (!token) {
    setStatus('Reset token missing. Request a new link.', 'error');
    return;
  }
  if (!password || password.length < 6) {
    setStatus('Choose a password with at least 6 characters.', 'error');
    return;
  }
  if (password !== confirm) {
    setStatus('Passwords do not match.', 'error');
    return;
  }
  setStatus('Updating your password…');
  try {
    const response = await fetch(RESET_PASSWORD_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `Reset failed (${response.status})`);
    }
    state.pendingResetToken = null;
    elements.resetTokenInput.value = '';
    elements.resetNewPassword.value = '';
    elements.resetConfirmPassword.value = '';
    setAuthenticated(data.customer, data.token);
    setStatus('Password updated! You are signed in.', 'success');
    await fetchCustomerOrders();
  } catch (error) {
    console.error('Reset password failed:', error);
    setStatus(error.message || 'Unable to update password.', 'error');
  }
}

function renderOrders(orders) {
  const container = elements.ordersContainer;
  if (!container) return;
  container.innerHTML = '';

  if (!orders.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No saved orders yet. Once you create a sticker mockup it will show up here.';
    container.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  orders.forEach((order) => fragment.appendChild(buildOrderCard(order)));
  container.appendChild(fragment);
}

function buildDetailLine(label, value) {
  const wrapper = document.createElement('p');
  wrapper.className = 'detail-line';
  const strong = document.createElement('strong');
  strong.textContent = label;
  const span = document.createElement('span');
  span.textContent = value || '—';
  wrapper.appendChild(strong);
  wrapper.appendChild(span);
  return wrapper;
}

function renderRaceQuotes(quotes) {
  const container = elements.raceQuotesList;
  if (!container) return;
  container.innerHTML = '';

  if (!quotes.length) {
    const empty = document.createElement('div');
    empty.className = 'race-quote-empty';
    empty.textContent = 'No race quotes yet. Submit the request form to start a new package.';
    container.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  quotes.forEach((quote) => {
    fragment.appendChild(buildRaceQuoteCard(quote));
  });
  container.appendChild(fragment);
}

function buildRaceQuoteCard(quote) {
  const card = document.createElement('article');
  card.className = 'race-quote-card';

  const header = document.createElement('header');
  const title = document.createElement('h3');
  title.textContent = quote.quoteNumber ? `Quote #${quote.quoteNumber}` : 'Race quote';
  header.appendChild(title);

  const status = document.createElement('span');
  status.className = 'quote-status';
  status.dataset.status = quote.status || 'submitted';
  status.textContent = formatQuoteStatus(quote.status);
  header.appendChild(status);

  card.appendChild(header);

  const meta = document.createElement('div');
  meta.className = 'race-quote-meta';
  if (quote.requestDate) meta.appendChild(buildDetailLine('Requested', quote.requestDate));
  meta.appendChild(buildDetailLine('Business', quote.business || '—'));
  const driverLine = formatNameWithCountry(quote.contactName || '', quote.driverCountry);
  meta.appendChild(buildDetailLine('Driver', driverLine || '—'));
  if (quote.racingBody) meta.appendChild(buildDetailLine('Series', quote.racingBody));
  if (quote.carNumber) meta.appendChild(buildDetailLine('Car #', quote.carNumber));
  const coDriverLine = formatNameWithCountry(quote.coDriver || '', quote.coDriverCountry);
  if (coDriverLine) meta.appendChild(buildDetailLine('Co-driver', coDriverLine));
  if (quote.vehicle) meta.appendChild(buildDetailLine('Vehicle', quote.vehicle));
  if (quote.colors) meta.appendChild(buildDetailLine('Primary colors', quote.colors));
  if (quote.packageOption) {
    meta.appendChild(buildDetailLine('Package', getRacePackageLabel(quote.packageOption)));
  }
  if (quote.addons?.length) {
    const addonText = formatAddonList(quote.addons);
    if (addonText) meta.appendChild(buildDetailLine('Add-ons', addonText));
  }
  if (quote.notes) meta.appendChild(buildDetailLine('Customer notes', quote.notes));
  if (quote.adminNotes) meta.appendChild(buildDetailLine('Shop notes', quote.adminNotes));
  if (quote.timelineText) meta.appendChild(buildDetailLine('Timeline', quote.timelineText));
  if (quote.deliveryText) meta.appendChild(buildDetailLine('Delivery', quote.deliveryText));
  if (quote.pricingNotes) meta.appendChild(buildDetailLine('Pricing notes', quote.pricingNotes));
  if (quote.quoteValidUntil) meta.appendChild(buildDetailLine('Valid until', quote.quoteValidUntil));
  card.appendChild(meta);

  if (Number.isFinite(quote.totalCents) && quote.totalCents > 0) {
    const amounts = document.createElement('div');
    amounts.className = 'quote-amounts';
    if (Number.isFinite(quote.baseCents)) {
      amounts.appendChild(buildAmountRow('Base package', formatMoney(quote.baseCents)));
    }
    if (Number.isFinite(quote.addonsCents) && quote.addonsCents > 0) {
      amounts.appendChild(buildAmountRow('Add-ons', formatMoney(quote.addonsCents)));
    }
    if (Number.isFinite(quote.subtotalCents) && quote.subtotalCents !== quote.totalCents) {
      amounts.appendChild(buildAmountRow('Subtotal', formatMoney(quote.subtotalCents)));
    }
    if (Number.isFinite(quote.taxCents) && quote.taxCents > 0) {
      amounts.appendChild(buildAmountRow('Sales tax', formatMoney(quote.taxCents)));
    }
    amounts.appendChild(buildAmountRow('Total', formatMoney(quote.totalCents)));
    card.appendChild(amounts);
  }

  if (quote.paymentLink && quote.paymentStatus !== 'PAID') {
    const link = document.createElement('div');
    link.appendChild(
      buildDetailLine('Payment link', 'Available — click "Approve & pay" to continue')
    );
    card.appendChild(link);
  }

  const actions = document.createElement('div');
  actions.className = 'race-quote-actions';

  if ((quote.paymentStatus || '').toUpperCase() === 'PAID') {
    const paidBadge = document.createElement('span');
    paidBadge.className = 'quote-status';
    paidBadge.dataset.status = 'paid';
    paidBadge.textContent = 'Paid';
    actions.appendChild(paidBadge);
  }

  if (quote.status === 'submitted' || quote.status === 'in_review') {
    const waitingSpan = document.createElement('span');
    waitingSpan.className = 'quote-status';
    waitingSpan.dataset.status = 'submitted';
    waitingSpan.textContent = 'We are reviewing your details';
    actions.appendChild(waitingSpan);
  }

  const allowDecision = ['quoted', 'approved', 'awaiting_payment'].includes(
    (quote.status || '').toLowerCase()
  );
  if (allowDecision && (quote.customerResponse || '').toLowerCase() !== 'accepted') {
    const approveQuoteButton = document.createElement('button');
    approveQuoteButton.type = 'button';
    approveQuoteButton.className = 'primary';
    approveQuoteButton.textContent = 'Approve quote';
    approveQuoteButton.addEventListener('click', () => handleRaceQuoteDecision(quote, 'approve', approveQuoteButton));
    actions.appendChild(approveQuoteButton);

    if (quote.paymentLink) {
      const approvePayButton = document.createElement('button');
      approvePayButton.type = 'button';
      approvePayButton.className = 'secondary';
      approvePayButton.textContent = 'Approve & pay';
      approvePayButton.addEventListener('click', () => startRaceQuoteCheckout(quote.id, approvePayButton));
      actions.appendChild(approvePayButton);
    }
  }

  if ((quote.customerResponse || '').toLowerCase() !== 'declined' && quote.status !== 'cancelled') {
    const declineButton = document.createElement('button');
    declineButton.type = 'button';
    declineButton.className = 'secondary';
    declineButton.textContent = 'Decline quote';
    declineButton.addEventListener('click', () => handleRaceQuoteDecision(quote, 'decline', declineButton));
    actions.appendChild(declineButton);
  }

  if (quote.customerResponse) {
    const responseBadge = document.createElement('span');
    responseBadge.className = 'quote-status';
    responseBadge.dataset.status = quote.customerResponse.toLowerCase();
    responseBadge.textContent = `You ${quote.customerResponse}`;
    actions.appendChild(responseBadge);
  }

  card.appendChild(actions);

  const sponsorsSection = buildSponsorList(quote.sponsors || []);
  if (sponsorsSection) {
    card.appendChild(sponsorsSection);
  }

  const attachmentsSection = document.createElement('section');
  attachmentsSection.className = 'race-quote-attachments';
  const attachmentsHeader = document.createElement('h4');
  attachmentsHeader.textContent = 'Files';
  attachmentsSection.appendChild(attachmentsHeader);

  const filesContainer = document.createElement('div');
  filesContainer.className = 'race-quote-files';
  filesContainer.textContent = 'Loading files…';
  attachmentsSection.appendChild(filesContainer);

  const fileForm = document.createElement('form');
  fileForm.className = 'race-quote-file-form';
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.png,.jpg,.jpeg,.gif,.webp,.pdf,.ai,.eps,.svg,.zip';
  const uploadButton = document.createElement('button');
  uploadButton.type = 'submit';
  uploadButton.className = 'secondary';
  uploadButton.textContent = 'Upload file';
  fileForm.appendChild(fileInput);
  fileForm.appendChild(uploadButton);
  fileForm.addEventListener('submit', (event) => {
    event.preventDefault();
    handleRaceQuoteFileUpload(quote, fileInput, uploadButton, filesContainer);
  });
  attachmentsSection.appendChild(fileForm);

  card.appendChild(attachmentsSection);

  const conversation = document.createElement('section');
  conversation.className = 'race-quote-conversation';
  const conversationHeader = document.createElement('h4');
  conversationHeader.textContent = 'Conversation';
  conversation.appendChild(conversationHeader);

  const messagesContainer = document.createElement('div');
  messagesContainer.className = 'race-quote-messages';
  messagesContainer.textContent = 'Loading messages…';
  conversation.appendChild(messagesContainer);

  const messageForm = document.createElement('form');
  messageForm.className = 'race-quote-message-form';
  const textarea = document.createElement('textarea');
  textarea.rows = 3;
  textarea.placeholder = 'Add a note or question for the shop…';
  const submitButton = document.createElement('button');
  submitButton.type = 'submit';
  submitButton.className = 'secondary';
  submitButton.textContent = 'Send message';
  messageForm.appendChild(textarea);
  messageForm.appendChild(submitButton);
  messageForm.addEventListener('submit', (event) => {
    event.preventDefault();
    handleRaceQuoteMessageSubmit(quote, textarea, submitButton, messagesContainer);
  });
  conversation.appendChild(messageForm);

  card.appendChild(conversation);

  ensureRaceQuoteDetail(quote, messagesContainer, filesContainer);

  return card;
}

function buildAmountRow(label, value) {
  const span = document.createElement('span');
  const left = document.createElement('strong');
  left.textContent = label;
  const right = document.createElement('strong');
  right.textContent = value;
  span.appendChild(left);
  span.appendChild(right);
  return span;
}

function buildSponsorList(sponsors) {
  if (!Array.isArray(sponsors) || !sponsors.length) {
    return null;
  }

  const validSponsors = sponsors.filter((entry) => entry && entry.name);
  if (!validSponsors.length) {
    return null;
  }

  const section = document.createElement('section');
  section.className = 'race-quote-sponsors';

  const header = document.createElement('header');
  const title = document.createElement('h4');
  title.textContent = 'Sponsor decals requested';
  header.appendChild(title);
  const subtitle = document.createElement('p');
  subtitle.className = 'muted';
  subtitle.textContent = 'We will prep proofs for these logos and placements.';
  header.appendChild(subtitle);
  section.appendChild(header);

  const list = document.createElement('div');
  list.className = 'sponsor-list sponsor-list--summary';

  validSponsors.forEach((sponsor) => {
    const item = document.createElement('div');
    item.className = 'sponsor-entry sponsor-entry--summary';

    const name = document.createElement('strong');
    name.className = 'sponsor-entry__name';
    name.textContent = sponsor.name;
    item.appendChild(name);

    const meta = document.createElement('p');
    meta.className = 'sponsor-entry__meta';
    const sizeOption = SPONSOR_SIZE_OPTIONS.find((option) => option.value === sponsor.size);
    const details = [];
    if (sizeOption) {
      details.push(sizeOption.label);
    } else if (sponsor.size) {
      details.push(sponsor.size);
    }
    if (sponsor.color) {
      details.push(`Color: ${sponsor.color}`);
    }
    if (sponsor.apparel) {
      details.push('Include on apparel');
    }
    meta.textContent = details.join(' • ') || 'No specific details provided.';
    item.appendChild(meta);

    list.appendChild(item);
  });

  section.appendChild(list);
  return section;
}

function updateRaceQuoteInState(updated) {
  if (!updated || !updated.id) return;
  const index = state.raceQuotes.findIndex((quote) => quote.id === updated.id);
  if (index >= 0) {
    state.raceQuotes[index] = updated;
  } else {
    state.raceQuotes.unshift(updated);
  }
}

function renderRaceQuoteMessages(container, messages = []) {
  if (!container) return;
  container.innerHTML = '';
  if (!messages.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No messages yet.';
    container.appendChild(empty);
    return;
  }
  messages.forEach((entry) => {
    const bubble = document.createElement('div');
    bubble.className = `quote-message quote-message--${entry.sender || 'customer'}`;
    const meta = document.createElement('span');
    meta.className = 'quote-message__meta';
    const when = entry.createdAt ? new Date(entry.createdAt).toLocaleString() : '';
    meta.textContent = `${entry.sender === 'shop' ? 'Shop' : 'You'} · ${when}`;
    const body = document.createElement('p');
    body.className = 'quote-message__body';
    body.textContent = entry.message;
    bubble.appendChild(meta);
    bubble.appendChild(body);
    container.appendChild(bubble);
  });
}

function renderRaceQuoteFiles(container, files = []) {
  if (!container) return;
  container.innerHTML = '';
  if (!files.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No files uploaded yet.';
    container.appendChild(empty);
    return;
  }
  const list = document.createElement('ul');
  list.className = 'quote-file-list';
  files.forEach((file) => {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = file.url || '#';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = file.originalName || 'Download file';
    const meta = document.createElement('span');
    meta.className = 'quote-file-meta';
    const sizeKb = file.size ? `${(file.size / 1024).toFixed(1)} KB` : '';
    const uploaded = file.createdAt ? new Date(file.createdAt).toLocaleString() : '';
    meta.textContent = [sizeKb, uploaded].filter(Boolean).join(' · ');
    item.appendChild(link);
    if (meta.textContent) {
      item.appendChild(meta);
    }
    list.appendChild(item);
  });
  container.appendChild(list);
}

async function fetchRaceQuoteDetail(id) {
  if (!state.token) return null;
  try {
    const response = await fetch(CUSTOMER_RACE_QUOTE_DETAIL_ENDPOINT(id), {
      headers: {
        Authorization: `Bearer ${state.token}`
      }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.error || `Unable to load quote (${response.status})`);
    }
    if (payload?.quote) {
      updateRaceQuoteInState(payload.quote);
    }
    const cache = {
      quote: payload.quote || null,
      messages: Array.isArray(payload.messages) ? payload.messages : [],
      files: Array.isArray(payload.files) ? payload.files : []
    };
    state.raceQuoteDetails[id] = cache;
    return cache;
  } catch (error) {
    console.error('fetchRaceQuoteDetail error:', error);
    return null;
  }
}

function ensureRaceQuoteDetail(quote, messagesContainer, filesContainer) {
  if (!quote?.id) return;
  const cached = state.raceQuoteDetails[quote.id];
  if (cached) {
    if (messagesContainer) {
      renderRaceQuoteMessages(messagesContainer, cached.messages);
    }
    if (filesContainer) {
      renderRaceQuoteFiles(filesContainer, cached.files);
    }
    return;
  }
  if (messagesContainer) {
    messagesContainer.textContent = 'Loading messages…';
  }
  if (filesContainer) {
    filesContainer.textContent = 'Loading files…';
  }
  fetchRaceQuoteDetail(quote.id).then((detail) => {
    if (!detail) {
      if (messagesContainer) {
        messagesContainer.textContent = 'Unable to load messages right now.';
      }
      if (filesContainer) {
        filesContainer.textContent = 'Unable to load files right now.';
      }
      return;
    }
    if (messagesContainer) {
      renderRaceQuoteMessages(messagesContainer, detail.messages);
    }
    if (filesContainer) {
      renderRaceQuoteFiles(filesContainer, detail.files);
    }
  });
}

async function handleRaceQuoteMessageSubmit(quote, textarea, button, container) {
  if (!state.token || !quote?.id) {
    setStatus('Sign in to send a message.', 'error');
    return;
  }
  const message = textarea.value.trim();
  if (!message) {
    setStatus('Enter a message before sending.', 'error');
    return;
  }
  button.disabled = true;
  try {
    const response = await fetch(CUSTOMER_RACE_QUOTE_MESSAGES_ENDPOINT(quote.id), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${state.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ message })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.error || `Unable to send message (${response.status})`);
    }
    textarea.value = '';
    const cache = state.raceQuoteDetails[quote.id] || { quote: quote, messages: [] };
    cache.messages = [...(cache.messages || []), payload.message].sort((a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
    state.raceQuoteDetails[quote.id] = cache;
    renderRaceQuoteMessages(container, cache.messages);
    setStatus('Message sent.', 'success');
  } catch (error) {
    console.error('handleRaceQuoteMessageSubmit error:', error);
    setStatus(error.message || 'Unable to send message.', 'error');
  } finally {
    button.disabled = false;
  }
}

async function handleRaceQuoteDecision(quote, decision, button) {
  if (!state.token || !quote?.id) {
    setStatus('Sign in to manage your quotes.', 'error');
    return;
  }
  const normalized = decision === 'approve' ? 'approve' : 'decline';
  if (normalized === 'decline') {
    const confirmDecline = window.confirm('Are you sure you want to decline this quote?');
    if (!confirmDecline) {
      return;
    }
  }

  button.disabled = true;
  try {
    const response = await fetch(CUSTOMER_RACE_QUOTE_DECISION_ENDPOINT(quote.id), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${state.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ decision: normalized })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.error || `Unable to update quote (${response.status})`);
    }
    if (payload?.quote) {
      updateRaceQuoteInState(payload.quote);
      state.raceQuoteDetails[payload.quote.id] = null;
      renderRaceQuotes(state.raceQuotes);
      setStatus(
        normalized === 'approve'
          ? 'Thanks! We have your approval and will follow up shortly.'
          : 'Quote declined. We will review your decision.',
        'success'
      );
    } else {
      await loadRaceQuotes({ silent: true });
    }
  } catch (error) {
    console.error('handleRaceQuoteDecision error:', error);
    setStatus(error.message || 'Unable to update quote.', 'error');
  } finally {
    button.disabled = false;
  }
}

async function handleRaceQuoteFileUpload(quote, input, button, container) {
  if (!state.token || !quote?.id) {
    setStatus('Sign in to upload files.', 'error');
    return;
  }
  const file = input.files?.[0];
  if (!file) {
    setStatus('Choose a file before uploading.', 'error');
    return;
  }
  const formData = new FormData();
  formData.append('file', file);
  button.disabled = true;
  try {
    const response = await fetch(CUSTOMER_RACE_QUOTE_FILES_ENDPOINT(quote.id), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${state.token}`
      },
      body: formData
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.error || `Unable to upload file (${response.status})`);
    }
    input.value = '';
    const cache = state.raceQuoteDetails[quote.id] || { quote, messages: [], files: [] };
    cache.files = [...(cache.files || []), payload.file];
    state.raceQuoteDetails[quote.id] = cache;
    renderRaceQuoteFiles(container, cache.files);
    setStatus('File uploaded.', 'success');
  } catch (error) {
    console.error('handleRaceQuoteFileUpload error:', error);
    setStatus(error.message || 'Unable to upload file.', 'error');
  } finally {
    button.disabled = false;
  }
}

function formatQuoteStatus(status) {
  switch ((status || '').toLowerCase()) {
    case 'in_review':
      return 'In review';
    case 'quoted':
      return 'Quote ready';
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

function formatAddonLabel(value) {
  if (!value) return '';
  return APPAREL_BUNDLE_LABELS[value] || value;
}

function formatAddonList(addons) {
  if (!Array.isArray(addons) || !addons.length) return '';
  return addons.map((addon) => formatAddonLabel(addon)).join(', ');
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

function buildOrderCard(order) {
  const template = elements.orderTemplate.content.cloneNode(true);
  const article = template.querySelector('.order-card');
  const body = template.querySelector('.order-body');

  template.querySelector('h3').textContent = order.orderNumber
    ? `Order #${order.orderNumber} · ${order.designName || 'Sticker order'}`
    : order.designName || 'Sticker order';

  const pill = template.querySelector('.status-pill');
  if (order.paid || order.paymentStatus === 'PAID') {
    pill.textContent = 'Paid';
    pill.classList.remove('pending');
    pill.classList.add('paid');
  } else {
    const status = order.paymentStatus || 'Payment pending';
    pill.textContent = status;
    pill.classList.remove('paid');
    pill.classList.add('pending');
  }

  const img = template.querySelector('img');
  if (order.previewFile) {
    img.src = SAVED_FILE_URL(order.previewFile);
  } else {
    img.alt = 'Preview not available';
  }

  const meta = template.querySelector('.meta');
  if (order.orderNumber) appendMeta(meta, 'Order #', order.orderNumber);
  appendMeta(meta, 'Requested on', formatDate(order.savedAt));
  appendMeta(meta, 'Quantity', order.quantity);
  appendMeta(meta, 'Vinyl color', order.color?.toUpperCase() || '—');
  appendMeta(meta, 'Width', `${Number(order.size || 0).toFixed(1)}"`);
  appendMeta(meta, 'Background', order.background?.toUpperCase() || '—');
  appendMeta(meta, 'Notes', order.notes || '—');
  if (order.pricing) {
    appendMeta(meta, 'Product', order.pricing.descriptor || 'Custom item');
    appendMeta(meta, 'Unit price', formatMoney(order.pricing.unitPriceCents));
    appendMeta(meta, 'Subtotal', formatMoney(order.pricing.subtotalCents));
    appendMeta(meta, 'Shipping', formatMoney(order.pricing.shippingCents));
    appendMeta(meta, 'Total', formatMoney(order.pricing.totalCents));
  }
  if (order.paymentDetails?.receipt) {
    appendMeta(meta, 'Receipt', order.paymentDetails.receipt);
  }

  if (order.apparelItems?.length && body) {
    const apparelSection = document.createElement('div');
    apparelSection.className = 'order-apparel';
    const heading = document.createElement('h4');
    heading.textContent = 'Apparel add-ons';
    apparelSection.appendChild(heading);
    const list = document.createElement('ul');
    list.className = 'order-apparel-list';
    order.apparelItems.forEach((item) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'order-apparel-name';
      name.textContent = `${item.quantity} × ${item.title || item.handle || 'Apparel item'}`;
      li.appendChild(name);
      const metaLine = document.createElement('span');
      metaLine.className = 'order-apparel-meta';
      const parts = [];
      if (item.color) parts.push(item.color);
      if (item.size) parts.push(item.size);
      parts.push(`SKU ${item.sku}`);
      metaLine.textContent = parts.join(' • ');
      li.appendChild(metaLine);
      if (Number.isFinite(item.unitPriceCents) || Number.isFinite(item.lineTotalCents)) {
        const priceLine = document.createElement('span');
        priceLine.className = 'order-apparel-meta';
        const unit = Number.isFinite(item.unitPriceCents) ? item.unitPriceCents : 0;
        const lineTotal = Number.isFinite(item.lineTotalCents)
          ? item.lineTotalCents
          : unit * Math.max(1, Number(item.quantity) || 1);
        priceLine.textContent = `${formatMoney(unit)} each · ${formatMoney(lineTotal)}`;
        li.appendChild(priceLine);
      }
      if (item.productUrl) {
        const link = document.createElement('a');
        link.href = item.productUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'Product page';
        li.appendChild(link);
      }
      list.appendChild(li);
    });
    apparelSection.appendChild(list);
    const apparelSubtotal = order.apparelItems.reduce((sum, entry) => {
      if (Number.isFinite(entry.lineTotalCents)) return sum + entry.lineTotalCents;
      if (Number.isFinite(entry.unitPriceCents)) {
        return sum + entry.unitPriceCents * Math.max(1, Number(entry.quantity) || 1);
      }
      return sum;
    }, 0);
    if (apparelSubtotal > 0) {
      const subtotalLine = document.createElement('div');
      subtotalLine.className = 'order-apparel-summary-total';
      subtotalLine.textContent = `Apparel subtotal: ${formatMoney(apparelSubtotal)}`;
      apparelSection.appendChild(subtotalLine);
    }
    const textLayersNode = body.querySelector('.text-layers');
    if (textLayersNode) {
      body.insertBefore(apparelSection, textLayersNode);
    } else {
      body.appendChild(apparelSection);
    }
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
      link.textContent = `${(source.format || '').toUpperCase()} (${formatBytes(source.size)})`;
      sourceContainer.appendChild(link);
    });
  } else {
    const span = document.createElement('span');
    span.className = 'text-layer';
    span.textContent = 'No source files saved yet.';
    sourceContainer.appendChild(span);
  }

  const previewLink = template.querySelector('.download-link');
  if (order.previewFile) {
    previewLink.href = SAVED_FILE_URL(order.previewFile);
  } else {
    previewLink.href = '#';
    previewLink.addEventListener('click', (event) => event.preventDefault());
  }

  const footer = template.querySelector('.order-footer');
  if (!order.paid && order.paymentStatus !== 'PAID' && order.pricing?.totalCents > 0) {
    const payButton = document.createElement('button');
    payButton.type = 'button';
    payButton.className = 'primary';
    payButton.textContent = 'Pay now';
    payButton.addEventListener('click', () => {
      if (order.paymentLink) {
        window.location.href = order.paymentLink;
      } else {
        startPayment(order.id, payButton);
      }
    });
    footer.insertBefore(payButton, previewLink);
  }

  // Allow deleting unpaid orders
  if (!order.paid && order.paymentStatus !== 'PAID') {
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'secondary';
    deleteButton.textContent = 'Delete';
    deleteButton.addEventListener('click', () => handleDeleteOrder(order.id, deleteButton));
    footer.insertBefore(deleteButton, previewLink);
  }

  const reorderButton = template.querySelector('.reorder-button');
  reorderButton.addEventListener('click', () => handleReorder(order.id));

  return article;
}

function appendMeta(dl, label, value) {
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = value;
  dl.appendChild(dt);
  dl.appendChild(dd);
}

async function handleReorder(orderId) {
  if (!state.token) {
    setStatus('Please sign in first before re-ordering.', 'error');
    return;
  }
  setStatus('Duplicating your order…');
  try {
    const response = await fetch(CUSTOMER_REORDER_ENDPOINT(orderId), {
      method: 'POST',
      headers: { Authorization: `Bearer ${state.token}` }
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Reorder failed (${response.status})`);
    }
    setStatus('We queued your reorder. It will appear above shortly.', 'success');
    await fetchCustomerOrders();
  } catch (error) {
    console.error('Reorder failed:', error);
    setStatus(error.message || 'Unable to duplicate order.', 'error');
  }
}

// Delete an unpaid order for the signed-in customer
async function handleDeleteOrder(orderId, button) {
  if (!state.token) {
    setStatus('Please sign in first.', 'error');
    return;
  }
  const confirmed = window.confirm('Delete this order? This cannot be undone.');
  if (!confirmed) return;
  try {
    if (button) button.disabled = true;
    const response = await fetch(`${API_BASE}/api/customer/orders/${encodeURIComponent(orderId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${state.token}` }
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Delete failed (${response.status})`);
    }
    setStatus('Order deleted.', 'success');
    await fetchCustomerOrders();
  } catch (error) {
    console.error('Delete order failed:', error);
    setStatus(error.message || 'Unable to delete order.', 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

function formatDate(value) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

async function startPayment(orderId, button) {
  if (!state.token) {
    setStatus('Sign in to pay for your order.', 'error');
    return;
  }
  setStatus('Generating secure Square checkout…');
  if (button) {
    button.disabled = true;
  }
  try {
    const response = await fetch(CREATE_PAYMENT_LINK_ENDPOINT(orderId), {
      method: 'POST',
      headers: { Authorization: `Bearer ${state.token}` }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.url) {
      throw new Error(data.error || `Unable to create payment link (${response.status})`);
    }
    window.location.href = data.url;
  } catch (error) {
    console.error('Payment link error:', error);
    setStatus(error.message || 'Unable to start payment.', 'error');
    if (button) {
      button.disabled = false;
    }
  }
}

async function startRaceQuoteCheckout(quoteId, button) {
  if (!state.token) {
    setStatus('Please sign in to approve your quote.', 'error');
    return;
  }
  const originalText = button?.textContent || '';
  if (button) {
    button.disabled = true;
    button.textContent = 'Opening checkout…';
  }
  try {
    const response = await fetch(CUSTOMER_RACE_QUOTE_CHECKOUT_ENDPOINT(quoteId), {
      method: 'POST',
      headers: { Authorization: `Bearer ${state.token}` }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.error || `Checkout failed (${response.status})`);
    }
    if (data?.quote) {
      state.raceQuotes = state.raceQuotes.map((existing) =>
        existing.id === data.quote.id ? data.quote : existing
      );
      renderRaceQuotes(state.raceQuotes);
    }
    const url = data?.url || data?.quote?.paymentLink;
    if (url) {
      window.location.href = url;
    } else {
      setStatus('Payment link unavailable. Please contact us.', 'error');
    }
  } catch (error) {
    console.error('startRaceQuoteCheckout error:', error);
    setStatus(error.message || 'Unable to start checkout.', 'error');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText || 'Approve & pay';
    }
    loadRaceQuotes({ silent: true });
  }
}

async function submitRaceQuote(event) {
  event.preventDefault();
  if (!state.token) {
    setStatus('Sign in before requesting a quote.', 'error');
    return;
  }

  const business = elements.raceQuoteBusiness?.value.trim();
  const contactName = elements.raceQuoteCustomer?.value.trim();
  if (!business || !contactName) {
    setStatus('Business and customer name are required.', 'error');
    return;
  }

  const packageInput = document.querySelector('input[name="racePackage"]:checked');
  if (!packageInput) {
    setStatus('Select a package option before submitting.', 'error');
    return;
  }

  const addons = Array.from(document.querySelectorAll('.race-addons input[type="checkbox"]'))
    .filter((input) => input.checked)
    .map((input) => input.value);
  const apparelInput = document.querySelector('input[name="raceApparelBundle"]:checked');
  if (apparelInput && apparelInput.value && apparelInput.value !== 'none') {
    addons.push(apparelInput.value);
  }

  const sponsors = collectSponsorEntries();
  const driverCountry = (elements.raceQuoteDriverCountry?.value || '').toUpperCase();
  const coDriverCountry = (elements.raceQuoteCoDriverCountry?.value || '').toUpperCase();

  const payload = {
    business,
    customer: contactName,
    date: elements.raceQuoteDate?.value || '',
    vehicle: elements.raceQuoteVehicle?.value.trim() || '',
    primaryColors: elements.raceQuoteColors?.value.trim() || '',
    packageOption: packageInput.value,
    addons,
    notes: elements.raceQuoteNotes?.value.trim() || '',
    racingBody: elements.raceQuoteRacingBody?.value || '',
    carNumber: elements.raceQuoteCarNumber?.value.trim() || '',
    coDriver: elements.raceQuoteCoDriver?.value.trim() || '',
    driverCountry,
    coDriverCountry,
    sponsors
  };

  try {
    const response = await fetch(CUSTOMER_RACE_QUOTES_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${state.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.error || `Quote request failed (${response.status})`);
    }
    setStatus('Quote request received! We will review and follow up shortly.', 'success');
    const newQuote = data?.quote;
    if (newQuote) {
      const existingIndex = state.raceQuotes.findIndex((quote) => quote.id === newQuote.id);
      if (existingIndex >= 0) {
        state.raceQuotes[existingIndex] = newQuote;
      } else {
        state.raceQuotes = [newQuote, ...state.raceQuotes];
      }
      renderRaceQuotes(state.raceQuotes);
    }
    elements.raceQuoteForm?.reset();
    presetRaceQuoteForm();
    // Close modal after successful submit
    const modal = document.getElementById('quoteModal');
    if (modal) modal.classList.add('hidden');
    await loadRaceQuotes({ silent: true });
  } catch (error) {
    console.error('submitRaceQuote error:', error);
    setStatus(error.message || 'Unable to submit quote request.', 'error');
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'file';
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
  return USD_FORMATTER.format(rounded);
}

async function refreshSession(rememberToken) {
  const response = await fetch(REFRESH_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rememberToken })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Unable to refresh session (${response.status})`);
  }
  return data;
}

async function confirmEmailFromToken(token) {
  if (!token) return;
  setStatus('Confirming your email…');
  try {
    const response = await fetch(CONFIRM_EMAIL_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `Unable to confirm email (${response.status})`);
    }
    const message = 'Email confirmed!';
    if (data.customer && data.token) {
      setAuthenticated(data.customer, data.token);
      setStatus(`${message} You are signed in.`, 'success');
      await fetchCustomerOrders();
    } else {
      setStatus(`${message} You can sign in now.`, 'success');
    }
  } catch (error) {
    console.error('Confirm email error:', error);
    setStatus(error.message || 'Unable to confirm email.', 'error');
  }
}

function handleQueryParams() {
  const params = new URLSearchParams(window.location.search);
  const verifyToken = params.get('verify');
  const resetToken = params.get('resetToken');
  const paidFlag = params.get('paid');
  const sessionParam = params.get('session');
  const emailParam = params.get('email');
  const codeParam = params.get('code');
  if (verifyToken) {
    confirmEmailFromToken(verifyToken);
  }
  if (resetToken) {
    showResetPasswordView(resetToken);
    setStatus('Enter a new password to finish resetting your account.', 'info');
  }
  if (sessionParam) {
    // Attempt session login using provided token
    (async () => {
      try {
        const response = await fetch(`${API_BASE}/api/customer/profile`, { headers: { Authorization: `Bearer ${sessionParam}` } });
        if (response.ok) {
          const data = await response.json().catch(() => ({}));
          const customer = data?.customer || null;
          if (customer) {
            setAuthenticated(customer, sessionParam);
            setStatus('Signed in via QR link.', 'success');
            await fetchCustomerOrders();
          }
        } else {
          setStatus('Session link invalid or expired. Please sign in.', 'error');
        }
      } catch (_) {
        setStatus('Session link invalid or expired. Please sign in.', 'error');
      }
    })();
  }
  if (emailParam && codeParam) {
    // Magic link from kiosk QR: verify code automatically
    (async () => {
      try {
        const response = await fetch(`${API_BASE}/api/auth/login-code/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: emailParam, code: codeParam })
        });
        const data = await response.json().catch(() => ({}));
        if (response.ok && data?.token && data?.customer) {
          setAuthenticated(data.customer, data.token);
          setStatus('Signed in via code link.', 'success');
          await fetchCustomerOrders();
        } else {
          setStatus('Code link invalid or expired. Please sign in.', 'error');
        }
      } catch (_) {
        setStatus('Code link invalid or expired. Please sign in.', 'error');
      }
    })();
  }
  if (paidFlag === '1') {
    setStatus('Thanks! We will confirm your payment and update your order shortly.', 'success');
  }
  if (verifyToken || resetToken || paidFlag) {
    params.delete('verify');
    params.delete('resetToken');
    params.delete('paid');
  }
  if (sessionParam || (emailParam && codeParam)) {
    params.delete('session');
    params.delete('email');
    params.delete('code');
    const newSearch = params.toString();
    const newUrl = `${window.location.pathname}${newSearch ? `?${newSearch}` : ''}`;
    window.history.replaceState({}, '', newUrl);
  }
}

elements.loginForm?.addEventListener('submit', handleLogin);
elements.registerForm?.addEventListener('submit', handleRegister);
elements.showRegister?.addEventListener('click', (event) => {
  event.preventDefault();
  switchView('register');
});
elements.logoutButton?.addEventListener('click', handleLogout);
elements.forgotPasswordLink?.addEventListener('click', (event) => {
  event.preventDefault();
  showResetRequestView();
});
elements.backToLogin?.addEventListener('click', (event) => {
  event.preventDefault();
  returnToLoginViews();
});
elements.registerBackToLogin?.addEventListener('click', (event) => {
  event.preventDefault();
  returnToLoginViews();
});
elements.resetCancelButton?.addEventListener('click', (event) => {
  event.preventDefault();
  returnToLoginViews();
});
elements.resetRequestForm?.addEventListener('submit', handleResetRequest);
elements.resetPasswordForm?.addEventListener('submit', handleResetPassword);
elements.resendVerification?.addEventListener('click', handleResendVerification);
elements.raceQuoteForm?.addEventListener('submit', submitRaceQuote);
elements.raceQuoteRacingBody?.addEventListener('change', updateRaceBodyNote);
elements.raceQuoteAddSponsor?.addEventListener('click', (event) => {
  event.preventDefault();
  addSponsorEntry();
});

elements.openQuoteModal?.addEventListener('click', (event) => {
  event.preventDefault();
  if (!state.token) {
    setStatus('Please sign in to request a quote.', 'error');
    return;
  }
  presetRaceQuoteForm();
  elements.quoteModal?.classList.remove('hidden');
});

elements.closeQuoteModal?.addEventListener('click', () => elements.quoteModal?.classList.add('hidden'));
elements.closeQuoteModalFooter?.addEventListener('click', () => elements.quoteModal?.classList.add('hidden'));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    elements.quoteModal?.classList.add('hidden');
  }
});

elements.uploadButton?.addEventListener('click', () => {
  elements.uploadInput?.click();
});

elements.uploadInput?.addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  setStatus(`Received ${file.name}. We’ll prep it for cutting and follow up shortly.`, 'success');
  event.target.value = '';
});

elements.savePrefsButton?.addEventListener('click', async () => {
  if (!state.token) { setStatus('Please sign in first.', 'error'); return; }
  if (elements.prefsStatus) {
    elements.prefsStatus.textContent = 'Saving…';
    elements.prefsStatus.className = 'status';
  }
  try {
    const smsOptIn = Boolean(elements.smsPrefCheckbox?.checked);
    const response = await fetch(CUSTOMER_PROFILE_ENDPOINT, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}` },
      body: JSON.stringify({ smsOptIn })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Save failed (${response.status})`);
    if (elements.prefsStatus) {
      elements.prefsStatus.textContent = 'Preferences saved.';
      elements.prefsStatus.className = 'status success';
    }
    setStatus('Preferences saved.', 'success');
  } catch (error) {
    if (elements.prefsStatus) {
      elements.prefsStatus.textContent = error?.message || 'Unable to save preferences.';
      elements.prefsStatus.className = 'status error';
    }
    setStatus(error?.message || 'Unable to save preferences.', 'error');
  }
});

(async function bootstrap() {
  // Load public config (e.g., SMS frequency) and update UI text
  try {
    const res = await fetch(PUBLIC_CONFIG_ENDPOINT, { cache: 'no-store' });
    if (res.ok) {
      const cfg = await res.json();
      const freq = Number(cfg?.smsMsgsPerMonth);
      if (Number.isFinite(freq) && freq > 0) {
        const el = document.getElementById('smsMsgsPerMonth');
        if (el) el.textContent = String(freq);
      }
    }
  } catch (_) {}

  const storedToken = localStorage.getItem('stickerPortalToken');
  const storedCustomerRaw = localStorage.getItem('stickerPortalCustomer');
  const storedRememberToken = localStorage.getItem('stickerPortalRememberToken');
  let parsedCustomer = null;

  if (storedCustomerRaw) {
    try {
      parsedCustomer = JSON.parse(storedCustomerRaw);
    } catch (error) {
      console.warn('Failed to parse stored customer:', error);
      parsedCustomer = null;
    }
  }

  try {
    if (storedToken && parsedCustomer) {
      setAuthenticated(parsedCustomer, storedToken);
      await fetchCustomerOrders();
    } else if (storedRememberToken) {
      const refreshed = await refreshSession(storedRememberToken);
      setAuthenticated(refreshed.customer, refreshed.token);
      await fetchCustomerOrders();
    } else {
      clearAuthentication();
    }
  } catch (error) {
    console.warn('Unable to restore session:', error);
    clearAuthentication();
  }

  handleQueryParams();
  const payAllButton = document.getElementById('payAllButton');
  if (payAllButton) {
    payAllButton.addEventListener('click', handlePayAllUnpaid);
  }
})();
