/**
 * content.js — Content script for Health Claim Verifier
 *
 * Handles three messages from the panel / service worker:
 *   getArticleText   → extract article text with Readability
 *   highlightClaims  → find claim quotes in the DOM and wrap them
 *   removeHighlights → clean up all injected <mark> elements
 */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'getArticleText') {
    try {
      const docClone = document.cloneNode(true);
      const reader   = new Readability(docClone);
      const article  = reader.parse();

      if (!article || !article.textContent || article.textContent.trim().length < 100) {
        sendResponse({ error: 'no_article' });
        return true;
      }

      sendResponse({
        text:  article.textContent.trim(),
        title: article.title || document.title,
      });
    } catch (err) {
      console.error('[vital:content] Readability failed:', err);
      sendResponse({ error: 'extraction_failed' });
    }
    return true;
  }

  if (message.action === 'highlightClaims') {
    removeHighlights();
    injectHighlightStyles();
    (message.claims || []).forEach(claim => {
      highlightQuote(claim.quote, claim.verdict);
    });
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === 'removeHighlights') {
    removeHighlights();
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === 'scrollToHighlight') {
    const quote = (message.quote || '').toLowerCase().trim();
    if (quote) {
      const marks = document.querySelectorAll('mark.vital-highlight');
      let target = null;
      for (const mark of marks) {
        if (mark.textContent.toLowerCase().trim() === quote) { target = mark; break; }
      }
      // Fallback: partial match (quote may be truncated vs article text)
      if (!target) {
        for (const mark of marks) {
          if (mark.textContent.toLowerCase().includes(quote.slice(0, 40))) { target = mark; break; }
        }
      }
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.add('vital-highlight--active');
        setTimeout(() => target.classList.remove('vital-highlight--active'), 1200);
      }
    }
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

// ── Styles ────────────────────────────────────────────────────────────────────

function injectHighlightStyles() {
  if (document.getElementById('vital-highlight-styles')) return;
  const style = document.createElement('style');
  style.id = 'vital-highlight-styles';
  style.textContent = `
    mark.vital-highlight {
      background: transparent;
      border-bottom: 2px solid transparent;
      border-radius: 0;
      padding: 0 0 1px;
      cursor: pointer;
    }
    mark.vital-highlight--probable {
      background-color: #e4f2ff;
      border-bottom-color: #3b82f6;
    }
    mark.vital-highlight--disputed {
      background-color: #ffebdb;
      border-bottom-color: #da5f00;
    }
    mark.vital-highlight--unverifiable {
      background-color: #eeeeee;
      border-bottom-color: #8e8e8e;
    }
    mark.vital-highlight--active {
      animation: vital-pulse 1.2s ease-out forwards;
    }
    @keyframes vital-pulse {
      0%   { outline: 2px solid rgba(59,130,246,0.8); outline-offset: 3px; }
      100% { outline: 2px solid rgba(59,130,246,0);   outline-offset: 6px; }
    }
  `;
  document.head.appendChild(style);
}

// ── Highlight a single quote ──────────────────────────────────────────────────

function highlightQuote(quote, verdict) {
  if (!quote || !quote.trim()) return;

  const lowerQuote = quote.toLowerCase().trim();

  // Collect text nodes up front to avoid TreeWalker invalidation after DOM edits
  const textNodes = [];
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const el = node.parentElement;
        if (!el) return NodeFilter.FILTER_REJECT;
        const tag = el.tagName.toLowerCase();
        if (tag === 'script' || tag === 'style' || tag === 'noscript') return NodeFilter.FILTER_REJECT;
        if (el.closest('mark.vital-highlight')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );

  let n;
  while ((n = walker.nextNode())) textNodes.push(n);

  for (const node of textNodes) {
    const text = node.textContent;
    const idx  = text.toLowerCase().indexOf(lowerQuote);
    if (idx === -1) continue;

    const before  = text.slice(0, idx);
    const matched = text.slice(idx, idx + quote.length);
    const after   = text.slice(idx + quote.length);

    const mark = document.createElement('mark');
    mark.className = `vital-highlight vital-highlight--${verdict}`;
    mark.textContent = matched;
    mark.addEventListener('click', () => {
      // Open sidebar if it's currently closed
      const sidebar = document.getElementById('vital-sidebar-root');
      if (sidebar && !sidebar.classList.contains('vital-open')) {
        sidebar.classList.add('vital-open');
      }
      chrome.runtime.sendMessage({ action: 'openClaim', quote: matched });
    });

    const frag = document.createDocumentFragment();
    if (before)  frag.appendChild(document.createTextNode(before));
    frag.appendChild(mark);
    if (after)   frag.appendChild(document.createTextNode(after));

    node.parentNode.replaceChild(frag, node);
    break; // first occurrence only
  }
}

// ── Remove all highlights ─────────────────────────────────────────────────────

function removeHighlights() {
  document.querySelectorAll('mark.vital-highlight').forEach(mark => {
    const parent = mark.parentNode;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  });
}
