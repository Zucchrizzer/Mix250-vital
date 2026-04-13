/**
 * content.js — Content script
 *
 * Responsibilities:
 *  - Listen for SCAN_PAGE messages from the popup
 *  - Extract candidate health claim sentences from the article body
 *  - Send claims to the background service worker for verification
 *  - Highlight verified / disputed / unverified claims in the DOM
 */

// ── Claim extraction ──────────────────────────────────────────────────────────

/**
 * Pulls visible paragraph text from the page and returns candidate sentences
 * that look like health claims. Extend HEALTH_KEYWORDS to broaden detection.
 *
 * @returns {string[]} Array of candidate claim sentences
 */
function extractClaimCandidates() {
  const HEALTH_KEYWORDS = [
    'cure', 'treat', 'prevent', 'reduce', 'increase', 'boost',
    'cause', 'linked', 'associated', 'risk', 'benefit', 'study',
    'research', 'evidence', 'proven', 'effective', 'safe', 'toxic',
    'immune', 'cancer', 'diabetes', 'heart', 'blood', 'weight',
  ];

  const paragraphs = Array.from(
    document.querySelectorAll('article p, main p, [role="main"] p')
  );

  // Fallback: if no article/main context found, use all paragraphs
  const sources = paragraphs.length > 0
    ? paragraphs
    : Array.from(document.querySelectorAll('p'));

  const sentences = sources
    .flatMap(p => p.innerText.split(/(?<=[.!?])\s+/))
    .map(s => s.trim())
    .filter(s => s.length > 20);

  const pattern = new RegExp(HEALTH_KEYWORDS.join('|'), 'i');
  return sentences.filter(s => pattern.test(s));
}

// ── DOM highlighting ──────────────────────────────────────────────────────────

/**
 * Wraps matching text nodes in a <mark> with a semantic class
 * reflecting the claim's verdict.
 *
 * @param {string} claimText
 * @param {'verified'|'disputed'|'unverified'} verdict
 */
function highlightClaim(claimText, verdict) {
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    null
  );

  const targets = [];
  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeValue.includes(claimText.slice(0, 40))) {
      targets.push(node);
    }
  }

  for (const textNode of targets) {
    const mark = document.createElement('mark');
    mark.className = `claim-highlight claim-highlight--${verdict}`;
    mark.dataset.claimVerdict = verdict;
    mark.title = `Verdict: ${verdict}`;

    const range = document.createRange();
    range.selectNode(textNode);
    range.surroundContents(mark);
    break; // highlight first occurrence only
  }
}

// ── Inject minimal highlight styles ──────────────────────────────────────────

function injectHighlightStyles() {
  if (document.getElementById('hcv-styles')) return;

  const style = document.createElement('style');
  style.id = 'hcv-styles';
  style.textContent = `
    .claim-highlight {
      border-radius: 2px;
      cursor: help;
    }
    .claim-highlight--verified  { background: rgba(134, 239, 172, 0.4); }
    .claim-highlight--disputed  { background: rgba(252, 165, 165, 0.4); }
    .claim-highlight--unverified{ background: rgba(253, 230, 138, 0.4); }
  `;
  document.head.appendChild(style);
}

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'SCAN_PAGE') return false;

  (async () => {
    const candidates = extractClaimCandidates();

    // Ask the background worker to verify the claims
    let claims = [];
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'VERIFY_CLAIMS',
        claims: candidates,
      });
      claims = response?.claims ?? [];
    } catch (err) {
      console.error('[content] Verification request failed:', err);
      // Return unverified claims so the popup can still display them
      claims = candidates.map(text => ({ text, verdict: 'unverified' }));
    }

    injectHighlightStyles();
    for (const claim of claims) {
      highlightClaim(claim.text, claim.verdict);
    }

    sendResponse({ claims });
  })();

  return true; // keep message channel open for async sendResponse
});
