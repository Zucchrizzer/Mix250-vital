/**
 * popup.js — Popup UI controller
 *
 * Responsibilities:
 *  - Trigger a page scan via message to the content script
 *  - Receive claim results from storage / background
 *  - Render claims in the list
 */

const scanButton   = document.getElementById('scanButton');
const statusBadge  = document.getElementById('statusBadge');
const claimsSection = document.getElementById('claimsSection');
const claimsList   = document.getElementById('claimsList');
const claimsCount  = document.getElementById('claimsCount');
const emptyState   = document.getElementById('emptyState');

// ── Helpers ───────────────────────────────────────────────────────────────────

function setStatus(status, label) {
  statusBadge.textContent = label;
  statusBadge.dataset.status = status;
}

function renderClaims(claims) {
  claimsList.innerHTML = '';

  if (!claims || claims.length === 0) {
    claimsSection.hidden = true;
    emptyState.hidden = false;
    return;
  }

  claimsSection.hidden = false;
  emptyState.hidden = true;
  claimsCount.textContent = claims.length;

  for (const claim of claims) {
    const li = document.createElement('li');
    li.className = 'claim-item';
    li.dataset.verdict = claim.verdict ?? 'unverified';

    const text = document.createElement('p');
    text.className = 'claim-text';
    text.textContent = claim.text;

    const verdict = document.createElement('span');
    verdict.className = 'claim-verdict-label';
    verdict.textContent = claim.verdict ?? 'Unverified';

    li.appendChild(text);
    li.appendChild(verdict);

    if (claim.sourceUrl) {
      const link = document.createElement('a');
      link.className = 'claim-source-link';
      link.href = claim.sourceUrl;
      link.textContent = 'View source';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      li.appendChild(link);
    }

    claimsList.appendChild(li);
  }
}

// ── Load persisted claims for this tab on open ────────────────────────────────

async function loadExistingClaims() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const key = `claims_${tab.id}`;
  const result = await chrome.storage.session.get(key);
  const claims = result[key];

  if (claims) {
    renderClaims(claims);
    setStatus('done', `${claims.length} found`);
  }
}

// ── Scan button ───────────────────────────────────────────────────────────────

scanButton.addEventListener('click', async () => {
  scanButton.disabled = true;
  setStatus('scanning', 'Scanning…');
  claimsSection.hidden = true;
  emptyState.hidden = true;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'SCAN_PAGE' });

    if (response?.claims) {
      renderClaims(response.claims);
      setStatus('done', `${response.claims.length} found`);
    } else {
      setStatus('error', 'Error');
      emptyState.hidden = false;
    }
  } catch (err) {
    console.error('[popup] Scan failed:', err);
    setStatus('error', 'Error');
    emptyState.hidden = false;
  } finally {
    scanButton.disabled = false;
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────

loadExistingClaims();
