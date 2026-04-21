/**
 * panel.js — Side panel UI controller
 *
 * Data shape (from service worker / dummy_data.json):
 *   claims:          [{quote, verdict, explanation, sources?}]
 *   framing:         {source_type, perspective, emotional_intensity, epistemic_certainty, headline_accuracy}
 *                    each value is either a float OR {score: float, explanation: string}
 *   warnings:        [{type, severity, title, description}]   (optional)
 *   source:          {outlet, domain, description}            (optional)
 *   author:          {name, bio}                              (optional)
 *   results_summary: string                                   (optional)
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
  empty:        document.getElementById('view-empty'),
  loading:      document.getElementById('view-loading'),
  error:        document.getElementById('view-error'),
  oppsummering: document.getElementById('view-oppsummering'),
  pastander:    document.getElementById('view-pastander'),
  vinkling:     document.getElementById('view-vinkling'),
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
}

// ── Tab switching ─────────────────────────────────────────────────────────────

tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    if (appState !== 'results') return;
    activeTab = btn.dataset.tab;
    showState('results');
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

    // Highlight claims in the article
    chrome.tabs.sendMessage(tab.id, {
      action: 'highlightClaims',
      claims: response.claims || [],
    }).catch(() => { /* content script absent — highlights are optional */ });

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

// ── Settings ──────────────────────────────────────────────────────────────────

settingsBtn.addEventListener('click', () => {
  if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
});

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

  // ── Main claim card — lead with most notable disputed, else first claim ──
  const mainClaim = disputed[0] || claims[0];
  if (mainClaim) {
    const isDisputed     = mainClaim.verdict === 'disputed';
    const isUnverifiable = mainClaim.verdict === 'unverifiable';
    const card = document.getElementById('mainClaimCard');
    card.classList.toggle('disputed', isDisputed);
    document.getElementById('mainVerdictLabel').textContent = verdictLabel(mainClaim.verdict);
    document.getElementById('mainClaimQuote').textContent   = mainClaim.quote;
    document.getElementById('mainBadgeText').textContent    = verdictLabel(mainClaim.verdict);
    document.getElementById('mainBadgeIcon').innerHTML      = verdictBadgeIcon(mainClaim.verdict);
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

// ── Re-run when the user switches tabs ───────────────────────────────────────

chrome.tabs.onActivated.addListener(() => {
  analysisData = null;
  runAnalysis();
});

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

restoreSession();
checkDomainDisclaimer();
