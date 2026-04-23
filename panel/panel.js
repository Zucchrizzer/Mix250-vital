/**
 * panel.js — Side panel UI controller
 *
 * Data shape (from service worker / dummy_data_2.json):
 *   claims:          [{quote, verdict, explanation, sources?}]
 *   framing:         {source_type, perspective, emotional_intensity, epistemic_certainty, headline_accuracy}
 *                    each value is either a float OR {score: float, explanation: string}
 *   warnings:        [{type, severity, title, description}]   (optional)
 *   source:          {outlet, domain, description}            (optional)
 *   author:          {name, bio}                              (optional)
 *   results_summary: string                                   (optional)
 *   main_claim:      {summary, verdict, explanation, sources[{title, url, stance}]}
 *
 * verdict values: "probable" | "disputed" | "unverifiable"
 */

// ── State ─────────────────────────────────────────────────────────────────────

let appState     = 'empty';
let activeTab    = 'oppsummering';
let activeFilter = 'all';
let analysisData = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────

const views = {
  empty:          document.getElementById('view-empty'),
  loading:        document.getElementById('view-loading'),
  error:          document.getElementById('view-error'),
  oppsummering:   document.getElementById('view-oppsummering'),
  pastander:      document.getElementById('view-pastander'),
  vinkling:       document.getElementById('view-vinkling'),
  innstillinger:  document.getElementById('view-innstillinger'),
};

const tabBtns     = document.querySelectorAll('.tab[data-tab]');
const analyseBtn  = document.getElementById('analyseBtn');
const rescanBtn   = document.getElementById('rescanBtn');
const retryBtn    = document.getElementById('retryBtn');
const downloadBtn = document.getElementById('downloadBtn');
const settingsBtn = document.getElementById('settingsBtn');
const domainHint  = document.getElementById('domainHint');
const errorMsgEl  = document.getElementById('errorMessage');
const filterChips = document.querySelectorAll('.filter-chip[data-filter]');

// ── State machine ─────────────────────────────────────────────────────────────

function showState(newState) {
  appState = newState;
  Object.values(views).forEach(el => { if (el) el.hidden = true; });

  if (newState === 'results') {
    const v = views[activeTab];
    if (v) v.hidden = false;
  } else {
    const v = views[newState];
    if (v) v.hidden = false;
  }

  tabBtns.forEach(btn => {
    const isActive = newState === 'results' && btn.dataset.tab === activeTab;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', String(isActive));
  });

  settingsBtn.classList.toggle('active', newState === 'innstillinger');
}

// ── Tab switching ─────────────────────────────────────────────────────────────

tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    activeTab = btn.dataset.tab;
    if (analysisData) {
      showState('results');
    } else if (appState !== 'loading') {
      showState('empty');
    }
  });
});

// ── Error messages ────────────────────────────────────────────────────────────

function friendlyError(code, extra = {}) {
  switch (code) {
    case 'cooldown':              return `Vent ${extra.remaining || ''}s før du analyserer på nytt.`;
    case 'content_script_unreachable': return 'Gå til en artikkel på vg.no eller nrk.no for å starte.';
    case 'no_article':            return 'Fant ikke artikkelinnhold på denne siden.';
    case 'extraction_failed':     return 'Klarte ikke lese artikkelteksten. Prøv å laste siden på nytt.';
    case 'api_error':             return `API-feil (HTTP ${extra.status || ''}). Sjekk API-nøkkelen i config.js.`;
    case 'network_error':         return 'Nettverksfeil. Sjekk internettforbindelsen og prøv igjen.';
    case 'parse_failed':          return 'Kunne ikke laste analysedata. Prøv igjen.';
    default:                      return `Uventet feil: ${code}`;
  }
}

// ── Analysis ──────────────────────────────────────────────────────────────────

async function runAnalysis() {
  showState('loading');

  // Clear any existing highlights from the previous analysis
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    chrome.tabs.sendMessage(tab.id, { action: 'removeHighlights' }).catch(() => {});
  } catch { /* content script may not be present — that's fine */ }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const response = await chrome.runtime.sendMessage({ action: 'analyse', tabId: tab.id });

    if (chrome.runtime.lastError) throw new Error(chrome.runtime.lastError.message);

    if (!response || response.error) {
      errorMsgEl.textContent = friendlyError(response?.error, response);
      showState('error');
      return;
    }

    analysisData = response;
    activeTab    = 'oppsummering';
    renderAll(response);
    showState('results');

    // Highlight claims in the article (respects showHighlights setting)
    if (settings.showHighlights) {
      chrome.tabs.sendMessage(tab.id, {
        action: 'highlightClaims',
        claims: response.claims || [],
      }).catch(() => {});
    }

  } catch (err) {
    console.error('[vital:panel]', err);
    errorMsgEl.textContent = 'Noe gikk galt. Prøv igjen.';
    showState('error');
  }
}

analyseBtn.addEventListener('click', runAnalysis);
rescanBtn.addEventListener('click', runAnalysis);
retryBtn.addEventListener('click', runAnalysis);

// ── Download ──────────────────────────────────────────────────────────────────

downloadBtn.addEventListener('click', () => {
  if (!analysisData) return;
  const blob = new Blob([JSON.stringify(analysisData, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: 'vital-rapport.json' });
  a.click();
  URL.revokeObjectURL(url);
});

// ── Settings state ────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  showHighlights:     true,
  showFloatingButton: true,
  floatingButtonSide: 'right',
  analyseModus:       'manuelt',
  autoScanSites:      [],
  blockedSites:       [],
  notifyWhen:         'analyzing',
  notifyHow:          ['popup', 'badge'],
  skipLoggedIn:       true,
  sendAnonymousData:  false,
  highContrast:       false,
  largeText:          false,
};

let settings = { ...DEFAULT_SETTINGS };

async function loadSettings() {
  try {
    const stored = await chrome.storage.sync.get('vitalSettings');
    if (stored.vitalSettings) settings = { ...DEFAULT_SETTINGS, ...stored.vitalSettings };
  } catch { /* use defaults */ }
  applySettings();
}

async function persistSettings() {
  try { await chrome.storage.sync.set({ vitalSettings: settings }); } catch {}
  applySettings();
}

function applySettings() {
  document.body.classList.toggle('high-contrast', !!settings.highContrast);
  document.body.classList.toggle('large-text',    !!settings.largeText);
}

// ── Settings button ───────────────────────────────────────────────────────────

settingsBtn.addEventListener('click', () => {
  if (appState === 'innstillinger') {
    // Return to previous meaningful state
    if (analysisData) { showState('results'); }
    else { showState('empty'); }
  } else {
    showState('innstillinger');
    renderSettings();
  }
});

// ── Render: Innstillinger ─────────────────────────────────────────────────────

function renderSettings() {
  const body = document.getElementById('settingsBody');

  body.innerHTML = `
    <h1 class="panel-title">Innstillinger</h1>

    <p class="settings-section-label">Analyse</p>
    <div class="settings-card">

      <div class="settings-section">
        <div class="settings-desc">
          <p class="settings-title">Standard analysemodus</p>
          <p class="settings-sub">Hvordan VITAL starter analyse på nye sider</p>
        </div>
        <select class="settings-select" id="s-analyseModus">
          <option value="manuelt"    ${settings.analyseModus === 'manuelt'    ? 'selected' : ''}>Manuelt</option>
          <option value="automatisk" ${settings.analyseModus === 'automatisk' ? 'selected' : ''}>Automatisk</option>
        </select>
      </div>

      <div class="settings-section settings-section--sep">
        <div class="settings-desc">
          <p class="settings-title">Automatisk skann på disse sidene</p>
          <p class="settings-sub">Overstyrer standardmodus – skannes alltid automatisk</p>
        </div>
        <div id="s-autoScanList" class="settings-site-list"></div>
        <div class="settings-add-row">
          <input type="text" class="settings-input" id="s-autoScanInput" placeholder="Legg til et nettsted...">
          <button class="settings-add-btn" id="s-autoScanAdd">
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true"><path d="M5.5 1v9M1 5.5h9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
            Legg til
          </button>
        </div>
      </div>

      <div class="settings-section settings-section--sep">
        <div class="settings-desc">
          <p class="settings-title">Blokkerte nettsteder</p>
          <p class="settings-sub">VITAL vil aldri analysere disse sidene</p>
        </div>
        <div id="s-blockedList" class="settings-site-list"></div>
        <div class="settings-add-row">
          <input type="text" class="settings-input" id="s-blockedInput" placeholder="Legg til et nettsted...">
          <button class="settings-add-btn" id="s-blockedAdd">
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true"><path d="M5.5 1v9M1 5.5h9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
            Legg til
          </button>
        </div>
      </div>

    </div>

    <p class="settings-section-label">Notifikasjoner</p>
    <div class="settings-card">

      <div class="settings-section">
        <p class="settings-title">Når skal vi varsle deg?</p>
        <div class="settings-options">
          ${[['analyzing','Mens VITAL analyserer'],['done','Kun når VITAL er ferdig å analysere'],['never','Aldri']].map(([v,label]) => `
            <label class="settings-radio"><input type="radio" name="notifyWhen" value="${v}" ${settings.notifyWhen === v ? 'checked' : ''}><span class="settings-radio-dot"></span>${esc(label)}</label>
          `).join('')}
        </div>
      </div>

      <div class="settings-section settings-section--sep">
        <p class="settings-title">Hvordan skal vi varsle deg?</p>
        <div class="settings-options">
          ${[['popup','Som pop-up'],['badge','Som badge på extension ikon'],['panel','Åpne sidepanel automatisk']].map(([v,label]) => `
            <label class="settings-checkbox"><input type="checkbox" name="notifyHow" value="${v}" ${settings.notifyHow.includes(v) ? 'checked' : ''}><span class="settings-check-box"></span>${esc(label)}</label>
          `).join('')}
        </div>
      </div>

    </div>

    <p class="settings-section-label">Utseende og tilgjengelighet</p>
    <div class="settings-card">

      <div class="settings-section">
        <div class="settings-desc">
          <p class="settings-title">Vis uthevelse i teksten</p>
          <p class="settings-sub">Om VITAL skal markere påstandene i artikkelen</p>
        </div>
        <div class="settings-options">
          <label class="settings-radio"><input type="radio" name="showHighlights" value="true"  ${settings.showHighlights  ? 'checked' : ''}><span class="settings-radio-dot"></span>Ja</label>
          <label class="settings-radio"><input type="radio" name="showHighlights" value="false" ${!settings.showHighlights ? 'checked' : ''}><span class="settings-radio-dot"></span>Nei</label>
        </div>
      </div>

      <div class="settings-section settings-section--sep">
        <p class="settings-title">Tilgjengelighet</p>
        <div class="settings-options">
          <label class="settings-switch-row">
            <span>Høykontrast</span>
            <button role="switch" aria-checked="${settings.highContrast}" class="settings-switch${settings.highContrast ? ' on' : ''}" id="s-highContrast"></button>
          </label>
          <label class="settings-switch-row">
            <span>Stor tekststørrelse</span>
            <button role="switch" aria-checked="${settings.largeText}" class="settings-switch${settings.largeText ? ' on' : ''}" id="s-largeText"></button>
          </label>
        </div>
      </div>

      <div class="settings-section settings-section--sep">
        <div class="settings-inline-toggle">
          <div class="settings-desc">
            <p class="settings-title">Vis hurtigknapp i siden</p>
            <p class="settings-sub">En V-knapp i kanten av skjermen som åpner VITAL</p>
          </div>
          <button role="switch" aria-checked="${settings.showFloatingButton}" class="settings-switch${settings.showFloatingButton ? ' on' : ''}" id="s-showFloatingButton"></button>
        </div>
        <div class="settings-options" id="s-floatingSideOptions" ${!settings.showFloatingButton ? 'hidden' : ''}>
          <label class="settings-radio"><input type="radio" name="floatingButtonSide" value="right" ${settings.floatingButtonSide === 'right' ? 'checked' : ''}><span class="settings-radio-dot"></span>Høyre side</label>
          <label class="settings-radio"><input type="radio" name="floatingButtonSide" value="left"  ${settings.floatingButtonSide === 'left'  ? 'checked' : ''}><span class="settings-radio-dot"></span>Venstre side</label>
        </div>
      </div>

    </div>

    <p class="settings-section-label">Personvern</p>
    <div class="settings-card">

      <div class="settings-section">
        <div class="settings-inline-toggle">
          <div class="settings-desc">
            <p class="settings-title">Ikke analyser sider jeg er innlogget på</p>
            <p class="settings-sub">Hopper over sider med aktiv innlogging</p>
          </div>
          <button role="switch" aria-checked="${settings.skipLoggedIn}" class="settings-switch${settings.skipLoggedIn ? ' on' : ''}" id="s-skipLoggedIn"></button>
        </div>
      </div>

      <div class="settings-section settings-section--sep">
        <div class="settings-inline-toggle">
          <div class="settings-desc">
            <p class="settings-title">Send anonym bruksdata</p>
            <p class="settings-sub">Hjelper oss forbedre VITAL — ingen artikkelinnhold lagres</p>
          </div>
          <button role="switch" aria-checked="${settings.sendAnonymousData}" class="settings-switch${settings.sendAnonymousData ? ' on' : ''}" id="s-sendAnonymousData"></button>
        </div>
      </div>

    </div>

    <p class="settings-section-label">Om VITAL</p>
    <div class="settings-card">
      <div class="settings-section settings-info-row">
        <p class="settings-title">Versjon</p>
        <p class="settings-sub">0.1.0</p>
      </div>
      <div class="settings-section settings-section--sep settings-info-row">
        <p class="settings-title">Personvernerklæring</p>
        <span class="settings-ext-link" tabindex="0">Åpne
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M5 2H2.5A1.5 1.5 0 0 0 1 3.5v6A1.5 1.5 0 0 0 2.5 11h6A1.5 1.5 0 0 0 10 9.5V7M7 1h4m0 0v4m0-4L5.5 6.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </span>
      </div>
      <div class="settings-section settings-section--sep settings-info-row">
        <p class="settings-title">Kontakt oss</p>
        <span class="settings-ext-link" tabindex="0">Åpne
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M5 2H2.5A1.5 1.5 0 0 0 1 3.5v6A1.5 1.5 0 0 0 2.5 11h6A1.5 1.5 0 0 0 10 9.5V7M7 1h4m0 0v4m0-4L5.5 6.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </span>
      </div>
    </div>

    <button class="btn-secondary" id="s-reset" style="align-self:center">Tilbakestill innstillinger</button>
  `;

  // ── Domain lists ──
  renderSiteList('autoScan');
  renderSiteList('blocked');

  // ── Event wiring ──

  body.querySelector('#s-analyseModus').addEventListener('change', e => {
    settings.analyseModus = e.target.value;
    persistSettings();
  });

  // Radio: notifyWhen
  body.querySelectorAll('input[name="notifyWhen"]').forEach(r => {
    r.addEventListener('change', () => { settings.notifyWhen = r.value; persistSettings(); });
  });

  // Checkboxes: notifyHow
  body.querySelectorAll('input[name="notifyHow"]').forEach(cb => {
    cb.addEventListener('change', () => {
      const vals = [...body.querySelectorAll('input[name="notifyHow"]:checked')].map(c => c.value);
      settings.notifyHow = vals;
      persistSettings();
    });
  });

  // Radio: showHighlights
  body.querySelectorAll('input[name="showHighlights"]').forEach(r => {
    r.addEventListener('change', () => { settings.showHighlights = r.value === 'true'; persistSettings(); });
  });

  // Toggles
  ['highContrast', 'largeText', 'skipLoggedIn', 'sendAnonymousData'].forEach(key => {
    const btn = body.querySelector(`#s-${key}`);
    if (!btn) return;
    btn.addEventListener('click', () => {
      settings[key] = !settings[key];
      btn.classList.toggle('on', settings[key]);
      btn.setAttribute('aria-checked', String(settings[key]));
      persistSettings();
    });
  });

  // Floating button toggle — also shows/hides the side options
  const floatBtn   = body.querySelector('#s-showFloatingButton');
  const sideOpts   = body.querySelector('#s-floatingSideOptions');
  if (floatBtn) {
    floatBtn.addEventListener('click', () => {
      settings.showFloatingButton = !settings.showFloatingButton;
      floatBtn.classList.toggle('on', settings.showFloatingButton);
      floatBtn.setAttribute('aria-checked', String(settings.showFloatingButton));
      if (sideOpts) sideOpts.hidden = !settings.showFloatingButton;
      persistSettings();
    });
  }

  // Floating button side radio
  body.querySelectorAll('input[name="floatingButtonSide"]').forEach(r => {
    r.addEventListener('change', () => { settings.floatingButtonSide = r.value; persistSettings(); });
  });

  // Add site buttons
  function wireAddSite(type) {
    const inputId = `s-${type}Input`;
    const addId   = `s-${type}Add`;
    const input   = body.querySelector(`#${inputId}`);
    const btn     = body.querySelector(`#${addId}`);
    if (!input || !btn) return;
    const doAdd = () => {
      const val = input.value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
      if (!val) return;
      const key = type === 'autoScan' ? 'autoScanSites' : 'blockedSites';
      if (!settings[key].includes(val)) {
        settings[key] = [...settings[key], val];
        persistSettings();
        renderSiteList(type);
      }
      input.value = '';
    };
    btn.addEventListener('click', doAdd);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') doAdd(); });
  }
  wireAddSite('autoScan');
  wireAddSite('blocked');

  // Reset
  body.querySelector('#s-reset').addEventListener('click', () => {
    settings = { ...DEFAULT_SETTINGS };
    persistSettings();
    renderSettings();
  });
}

function renderSiteList(type) {
  const key      = type === 'autoScan' ? 'autoScanSites' : 'blockedSites';
  const accentCls = type === 'autoScan' ? 'auto' : 'blocked';
  const listEl   = document.querySelector(`#s-${type}List`);
  if (!listEl) return;
  listEl.innerHTML = '';
  settings[key].forEach(site => {
    const item = document.createElement('div');
    item.className = `settings-site-item settings-site-item--${accentCls}`;
    item.innerHTML = `
      <span class="settings-site-name">${esc(site)}</span>
      <button class="settings-site-remove" aria-label="Fjern ${esc(site)}">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
      </button>
    `;
    item.querySelector('.settings-site-remove').addEventListener('click', () => {
      settings[key] = settings[key].filter(s => s !== site);
      persistSettings();
      renderSiteList(type);
    });
    listEl.appendChild(item);
  });
}

// ── Scroll to claim in article ────────────────────────────────────────────────

async function scrollToClaimInArticle(quote) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    chrome.tabs.sendMessage(tab.id, { action: 'scrollToHighlight', quote }).catch(() => {});
  } catch { /* content script absent — scroll is optional */ }
}

// ── Open claim from article click ─────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'openClaim') {
    openClaimInPanel(message.quote);
  }
});

function openClaimInPanel(quote) {
  if (appState !== 'results' || !analysisData) return;

  // Switch to Påstander tab, reset filter to show all claims
  activeTab    = 'pastander';
  activeFilter = 'all';
  renderPastander(analysisData);
  showState('results');

  // Find and open the matching card
  const lowerQuote = quote.toLowerCase().trim();
  const cards = document.querySelectorAll('#claimsList .claim-card');
  for (const card of cards) {
    const quoteEl = card.querySelector('.claim-card-quote');
    if (!quoteEl) continue;
    const cardText = quoteEl.textContent.toLowerCase().trim();
    if (cardText.includes(lowerQuote.slice(0, 40)) || lowerQuote.includes(cardText.slice(0, 40))) {
      card.classList.add('open');
      card.querySelector('.claim-explanation').hidden = false;
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      break;
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function verdictLabel(verdict) {
  if (verdict === 'disputed')     return 'Omdiskutert';
  if (verdict === 'unverifiable') return 'Ikke verifiserbar';
  return 'Støttet';
}

// Reads a framing value that may be a flat float OR {score, explanation}
function framingScore(framing, key) {
  const val = framing?.[key];
  if (val == null) return 0.5;
  if (typeof val === 'object') return val.score ?? 0.5;
  return Number(val);
}

function framingExplanation(framing, key) {
  const val = framing?.[key];
  if (val && typeof val === 'object') return val.explanation || null;
  return null;
}

// ── SVG snippets ──────────────────────────────────────────────────────────────

const SVG_CHECK_SM = `<svg width="9" height="9" viewBox="0 0 9 9" fill="none" aria-hidden="true"><path d="M2 4.5l2 2 3-3" stroke="white" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const SVG_WARN_SM  = `<svg width="9" height="9" viewBox="0 0 9 9" fill="none" aria-hidden="true"><path d="M4.5 2v2.5M4.5 6.2v.4" stroke="white" stroke-width="1.2" stroke-linecap="round"/></svg>`;
const SVG_DASH_SM  = `<svg width="9" height="9" viewBox="0 0 9 9" fill="none" aria-hidden="true"><path d="M2 4.5h5" stroke="white" stroke-width="1.2" stroke-linecap="round"/></svg>`;

const SVG_CIRCLE_CHECK = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="8.5" stroke="currentColor" stroke-width="1.25"/><path d="M6.5 10.5l2.5 2.5 4.5-5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const SVG_CIRCLE_WARN  = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="8.5" stroke="currentColor" stroke-width="1.25"/><path d="M10 6.5v4M10 13v.3" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>`;

const SVG_CHEVRON = `<svg class="claim-chevron" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M3.5 5.5l3.5 3.5 3.5-3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function verdictBadgeIcon(verdict) {
  if (verdict === 'disputed')     return SVG_WARN_SM;
  if (verdict === 'unverifiable') return SVG_DASH_SM;
  return SVG_CHECK_SM;
}

function verdictFindingIcon(verdict) {
  return verdict === 'probable' ? SVG_CIRCLE_CHECK : SVG_CIRCLE_WARN;
}

// ── Accordion helper ──────────────────────────────────────────────────────────

function wireAccordion(accordionEl, btnEl, bodyEl) {
  btnEl.onclick = () => {
    const open = accordionEl.classList.toggle('open');
    bodyEl.hidden = !open;
    btnEl.setAttribute('aria-expanded', String(open));
  };
}

// ── Render: Oppsummering ──────────────────────────────────────────────────────

function renderOppsummering(data) {
  const claims       = data.claims        || [];
  const warnings     = data.warnings      || [];
  const source       = data.source        || null;
  const author       = data.author        || null;
  const summary      = data.results_summary || null;

  const supported    = claims.filter(c => c.verdict === 'probable');
  const disputed     = claims.filter(c => c.verdict === 'disputed');
  const unverifiable = claims.filter(c => c.verdict === 'unverifiable');

  // ── Counts & subtitle ──
  document.getElementById('countSupported').textContent    = supported.length;
  document.getElementById('countDisputed').textContent     = disputed.length;
  document.getElementById('countUnverifiable').textContent = unverifiable.length;
  document.getElementById('oppsummeringSubtitle').textContent =
    `${claims.length} påstand${claims.length === 1 ? '' : 'er'} analysert`;

  // ── Warnings ──
  const warningsEl = document.getElementById('warningsList');
  warningsEl.innerHTML = '';
  if (warnings.length) {
    const list = document.createElement('div');
    list.className = 'warnings-list';
    warnings.forEach(w => {
      const card = document.createElement('div');
      card.className = `warning-card ${w.severity || 'low'}`;
      card.innerHTML = `
        <p class="warning-title">${esc(w.title)}</p>
        <p class="warning-description">${esc(w.description)}</p>
      `;
      list.appendChild(card);
    });
    warningsEl.appendChild(list);
  }

  // ── Main claim card ──
  const mainClaim = data.main_claim;
  if (mainClaim) {
    const card = document.getElementById('mainClaimCard');
    card.classList.toggle('disputed', mainClaim.verdict === 'disputed');
    document.getElementById('mainVerdictLabel').textContent = verdictLabel(mainClaim.verdict);
    document.getElementById('mainClaimQuote').textContent   = mainClaim.summary;
    document.getElementById('mainBadgeText').textContent    = verdictLabel(mainClaim.verdict);
    document.getElementById('mainBadgeIcon').innerHTML      = verdictBadgeIcon(mainClaim.verdict);

    // "Les hvorfor" toggle
    const toggle = document.getElementById('mainClaimToggle');
    const why    = document.getElementById('mainClaimWhy');
    if (toggle && why) {
      let sourcesHtml = '';
      if (mainClaim.sources && mainClaim.sources.length) {
        const items = mainClaim.sources.map(s => `
          <div class="claim-source-item">
            <a class="claim-source-link" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>
            <span class="stance-badge ${esc(s.stance || 'neutral')}">${esc(stanceLabel(s.stance))}</span>
          </div>
        `).join('');
        sourcesHtml = `<div class="claim-sources">${items}</div>`;
      }
      const paras = ['explanation', 'explanation_p2', 'explanation_p3', 'explanation_p4']
        .map(k => mainClaim[k])
        .filter(Boolean);
      why.innerHTML = `
        <div class="main-claim-explanation-body">
          ${paras.map(p => `<p class="main-claim-explanation">${esc(p)}</p>`).join('')}
        </div>
        ${sourcesHtml}
      `;
      // Reset toggle state on each render
      toggle.setAttribute('aria-expanded', 'false');
      why.hidden = true;
      toggle.onclick = () => {
        const open = toggle.getAttribute('aria-expanded') === 'true';
        toggle.setAttribute('aria-expanded', String(!open));
        why.hidden = open;
      };
    }
  }

  // ── Summary text ──
  if (summary) {
    document.getElementById('summaryText').textContent = summary;
  } else {
    const parts = [];
    if (supported.length)    parts.push(`${supported.length} støttende`);
    if (disputed.length)     parts.push(`${disputed.length} omdiskuterte`);
    if (unverifiable.length) parts.push(`${unverifiable.length} ikke verifiserbare`);
    document.getElementById('summaryText').textContent =
      `Artikkelen inneholder ${claims.length} påstand${claims.length === 1 ? '' : 'er'}: ${parts.join(', ')}.`;
  }

  // ── Key findings — lead with disputed, fill with supported, max 3 ──
  const findings     = [...disputed.slice(0, 2), ...supported.slice(0, 1)].slice(0, 3);
  const findingsList = document.getElementById('findingsList');
  findingsList.innerHTML = '';
  findings.forEach(claim => {
    const div = document.createElement('div');
    div.className = `finding-card ${claim.verdict === 'disputed' ? 'disputed' : 'probable'}`;
    div.style.cursor = 'pointer';
    div.innerHTML = `
      <div class="finding-icon">${verdictFindingIcon(claim.verdict)}</div>
      <p class="finding-text">${esc(claim.quote)}</p>
    `;
    div.addEventListener('click', () => scrollToClaimInArticle(claim.quote));
    findingsList.appendChild(div);
  });

  // ── Source accordion ──
  const sourceAccordion = document.getElementById('sourceAccordion');
  const sourceBtn       = document.getElementById('sourceAccordionBtn');
  const sourceBody      = document.getElementById('sourceBody');
  if (source) {
    document.getElementById('sourceOutletName').textContent = source.outlet || source.domain || '';
    sourceBody.innerHTML = `
      <p class="accordion-description">${esc(source.description || '')}</p>
      ${source.domain ? `<div class="accordion-meta"><span>${esc(source.domain)}</span></div>` : ''}
    `;
    sourceAccordion.hidden = false;
    wireAccordion(sourceAccordion, sourceBtn, sourceBody);
  } else {
    sourceAccordion.hidden = true;
  }

  // ── Author accordion ──
  const authorAccordion = document.getElementById('authorAccordion');
  const authorBtn       = document.getElementById('authorAccordionBtn');
  const authorBody      = document.getElementById('authorBody');
  if (author) {
    document.getElementById('authorNameSpan').textContent = author.name || '';
    authorBody.innerHTML = `
      <p class="accordion-description">${esc(author.bio || '')}</p>
    `;
    authorAccordion.hidden = false;
    wireAccordion(authorAccordion, authorBtn, authorBody);
  } else {
    authorAccordion.hidden = true;
  }
}

// ── Render: Påstander ─────────────────────────────────────────────────────────

function renderPastander(data) {
  const claims = data.claims || [];

  document.getElementById('pastanderCount').textContent =
    `${claims.length} påstand${claims.length === 1 ? '' : 'er'}`;

  function buildList(filter) {
    const filtered = filter === 'all' ? claims : claims.filter(c => c.verdict === filter);
    const listEl   = document.getElementById('claimsList');
    listEl.innerHTML = '';

    filtered.forEach(claim => {
      const originalIndex = claims.indexOf(claim);
      const v             = claim.verdict;
      const statusIcon    = v === 'disputed'
        ? `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><circle cx="6" cy="6" r="5" stroke="currentColor" stroke-width="1.1"/><path d="M6 4v2.5M6 7.8v.4" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>`
        : v === 'unverifiable'
        ? `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><circle cx="6" cy="6" r="5" stroke="currentColor" stroke-width="1.1"/><path d="M4 6h4" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>`
        : `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><circle cx="6" cy="6" r="5" stroke="currentColor" stroke-width="1.1"/><path d="M4 6l1.5 1.5 2.5-3" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

      // Build sources HTML if available
      let sourcesHtml = '';
      if (claim.sources && claim.sources.length) {
        const items = claim.sources.map(s => `
          <div class="claim-source-item">
            <a class="claim-source-link" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>
            <span class="stance-badge ${esc(s.stance || 'neutral')}">${esc(stanceLabel(s.stance))}</span>
          </div>
        `).join('');
        sourcesHtml = `<div class="claim-sources">${items}</div>`;
      }

      const card = document.createElement('div');
      card.className = `claim-card ${v}`;
      card.setAttribute('role', 'listitem');
      card.innerHTML = `
        <div class="claim-card-inner">
          <div class="claim-badge-circle">${originalIndex + 1}</div>
          <div class="claim-card-content">
            <p class="claim-card-quote">${esc(claim.quote)}</p>
            <div class="claim-card-meta">
              <span class="claim-status">${statusIcon} ${esc(verdictLabel(v))}</span>
              ${SVG_CHEVRON}
            </div>
          </div>
        </div>
        <div class="claim-explanation" hidden>
          <p class="claim-explanation-text">${esc(claim.explanation)}</p>
          ${sourcesHtml}
        </div>
      `;

      card.querySelector('.claim-card-inner').addEventListener('click', () => {
        const open        = card.classList.toggle('open');
        card.querySelector('.claim-explanation').hidden = !open;
        scrollToClaimInArticle(claim.quote);
      });

      listEl.appendChild(card);
    });
  }

  buildList(activeFilter);

  filterChips.forEach(chip => {
    chip.classList.toggle('active', chip.dataset.filter === activeFilter);
    chip.onclick = () => {
      activeFilter = chip.dataset.filter;
      filterChips.forEach(c => c.classList.toggle('active', c === chip));
      buildList(activeFilter);
    };
  });
}

function stanceLabel(stance) {
  if (stance === 'supports')    return 'Støtter';
  if (stance === 'contradicts') return 'Motstrider';
  return 'Nøytral';
}

// ── Render: Vinkling ──────────────────────────────────────────────────────────

// Dataset framing keys — semantics:
//   source_type:          0 = personal/anecdotal  →  1 = documentation-based
//   perspective:          0 = one-sided           →  1 = nuanced/balanced
//   emotional_intensity:  0 = low                 →  1 = high
//   epistemic_certainty:  0 = cautious language   →  1 = overconfident language
//   headline_accuracy:    0 = doesn't match body  →  1 = matches body

const SLIDER_CONFIGS = [
  { section: 'Kilder og søk', key: 'source_type',        title: 'Kildeorientering',      labelLeft: 'Personlige erfaringer', labelRight: 'Dokumentasjonsbasert',  fallback: () => '' },
  {                            key: 'perspective',         title: 'Perspektiv',            labelLeft: 'Ensidig',               labelRight: 'Nyansert',              fallback: () => '' },
  { section: 'Språk og tone', key: 'emotional_intensity', title: 'Emosjonell intensitet', labelLeft: 'Lav',                   labelRight: 'Høy',                   fallback: () => '' },
  {                            key: 'epistemic_certainty', title: 'Hvor sikkert språket er', labelLeft: 'Forsiktig formulert', labelRight: 'Skråsikkert formulert', fallback: () => '' },
  { section: 'Overskrift',    key: 'headline_accuracy',   title: 'Overskrift og innhold', labelLeft: 'Dekker ikke innhold',   labelRight: 'Dekker innhold',        fallback: () => '' },
];

const SVG_INFO = `<svg class="slider-info-icon" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
  <circle cx="7" cy="7" r="5.75" stroke="currentColor" stroke-width="1.1"/>
  <path d="M7 6.5v3.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>
  <circle cx="7" cy="4.5" r="0.6" fill="currentColor"/>
</svg>`;

function renderVinkling(data) {
  const framing = data.framing || {};
  const listEl  = document.getElementById('slidersList');
  listEl.innerHTML = '';

  SLIDER_CONFIGS.forEach(cfg => {
    if (cfg.section) {
      const heading = document.createElement('p');
      heading.className = 'slider-section-heading';
      heading.textContent = cfg.section;
      listEl.appendChild(heading);
    }

    const score   = framingScore(framing, cfg.key);
    const explain = framingExplanation(framing, cfg.key) || cfg.fallback(score);
    const pct     = Math.round(score * 100);

    const group = document.createElement('div');
    group.className = 'slider-group';
    group.innerHTML = `
      <div class="slider-header">
        <span class="slider-title">${esc(cfg.title)}</span>
        ${SVG_INFO}
      </div>
      <div class="slider-track-wrap" role="img" aria-label="${esc(cfg.title)}: ${pct}%">
        <div class="slider-track">
          <div class="slider-fill"  style="width:${pct}%"></div>
          <div class="slider-thumb" style="left:${pct}%"></div>
        </div>
      </div>
      <div class="slider-labels">
        <span>${esc(cfg.labelLeft)}</span>
        <span>${esc(cfg.labelRight)}</span>
      </div>
      <p class="slider-explanation">${esc(explain)}</p>
    `;
    listEl.appendChild(group);
  });
}

// ── Render all ────────────────────────────────────────────────────────────────

function renderAll(data) {
  renderOppsummering(data);
  renderPastander(data);
  renderVinkling(data);
}

// ── Restore from session storage ──────────────────────────────────────────────

async function restoreSession() {
  try {
    const [tab]  = await chrome.tabs.query({ active: true, currentWindow: true });
    const result = await chrome.storage.session.get(`analysis_${tab.id}`);
    const cached = result[`analysis_${tab.id}`];
    if (cached && cached.claims) {
      analysisData = cached;
      activeTab    = 'oppsummering';
      renderAll(cached);
      showState('results');
      return;
    }
  } catch {
    // session storage unavailable — start fresh
  }
  showState('empty');
}

// ── Domain disclaimer ─────────────────────────────────────────────────────────

const DEMO_ARTICLES = [
  { label: 'NRK',         url: 'https://www.nrk.no/norge/studier_-kvinner-rammes-hardere-av-senskader-etter-koronasykdom-1.15535409' },
  { label: 'TV 2',        url: 'https://www.tv2.no/nyheter/nye-piller-kan-innta-norge-i-ar-mulig-bakside/18726591/' },
  { label: 'Natural News', url: 'https://www.naturalnews.com/2026-04-19-study-powerful-link-food-choices-cardiovascular-health.html' },
];

const SUPPORTED_HOSTS = new Set(['nrk.no', 'www.nrk.no', 'tv2.no', 'www.tv2.no', 'naturalnews.com', 'www.naturalnews.com']);

async function checkDomainDisclaimer() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const hostname = tab.url ? new URL(tab.url).hostname : '';
    if (!SUPPORTED_HOSTS.has(hostname)) {
      const hint = document.getElementById('domainHint');
      hint.innerHTML =
        'Dette er bare en demo. Gå til en av artiklene under for å teste:<br>' +
        DEMO_ARTICLES.map(a =>
          `<a href="${esc(a.url)}" target="_blank" rel="noopener" class="hint-link">${esc(a.label)}</a>`
        ).join('  ·  ');
      hint.hidden = false;
    }
  } catch { /* tab URL unreadable (e.g. chrome:// page) — stay silent */ }
}

// ── Init ──────────────────────────────────────────────────────────────────────

loadSettings();
restoreSession();
checkDomainDisclaimer();
