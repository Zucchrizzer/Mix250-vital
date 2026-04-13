/**
 * panel.js — Side panel UI controller (v1)
 *
 * Responsibilities:
 *  - Send { action: "analyse", tabId } to the service worker on button click
 *  - Show a loading state while the analysis runs
 *  - On success: console.log the full parsed result
 *  - On error: display a plain-text error message
 */

const analyseBtn = document.getElementById('analyseBtn');
const statusEl   = document.getElementById('status');
const errorEl    = document.getElementById('error');

// ── Helpers ───────────────────────────────────────────────────────────────────

function setLoading(loading) {
  analyseBtn.disabled = loading;
  statusEl.hidden = !loading;
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

function clearError() {
  errorEl.textContent = '';
  errorEl.hidden = true;
}

function errorMessage(code, extra) {
  switch (code) {
    case 'cooldown':
      return `Please wait ${extra.remaining}s before analysing again.`;
    case 'content_script_unreachable':
      return 'This site is not supported yet. Navigate to an article on vg.no or nrk.no.';
    case 'no_article':
      return 'Could not find article content on this page.';
    case 'extraction_failed':
      return 'Failed to read the article text. Try refreshing the page.';
    case 'api_error':
      return `API error (HTTP ${extra.status}). Check your API key in config.js.`;
    case 'network_error':
      return 'Network error. Check your internet connection and try again.';
    case 'parse_failed':
      return 'The AI returned an unexpected response. Try again.';
    default:
      return `Unexpected error: ${code}`;
  }
}

// ── Domain check on load ──────────────────────────────────────────────────────

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const hostname = new URL(tab.url).hostname;
    const supported = hostname.endsWith('vg.no') || hostname.endsWith('nrk.no');
    if (!supported) {
      analyseBtn.disabled = true;
      showError('Navigate to an article on vg.no or nrk.no to get started.');
    }
  } catch {
    // tab.url may be empty on chrome:// pages — leave button enabled so
    // the service worker's own error handling covers it
  }
})();

// ── Analyse button ────────────────────────────────────────────────────────────

analyseBtn.addEventListener('click', async () => {
  clearError();
  setLoading(true);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    const response = await chrome.runtime.sendMessage({
      action: 'analyse',
      tabId: tab.id,
    });

    // ── Diagnostics ───────────────────────────────────────────────────────────
    if (chrome.runtime.lastError) {
      console.error('Runtime error:', chrome.runtime.lastError.message);
      showError('Something went wrong. Please try again.');
      return;
    }

    console.log('Raw response from service worker:', response);

    if (response.error) {
      showError(errorMessage(response.error, response));
      return;
    }

    // ── Success ───────────────────────────────────────────────────────────────
    console.log('[hcv:panel] Analysis complete:', response);
    if (response.truncated) {
      console.warn('[hcv:panel] Article was truncated before analysis.');
    }
    // TODO (step 4): render claims list
    // TODO (step 5): render framing sliders
  } catch (err) {
    console.error('[hcv:panel] Unexpected error:', err);
    showError('Something went wrong. Please try again.');
  } finally {
    setLoading(false);
  }
});
