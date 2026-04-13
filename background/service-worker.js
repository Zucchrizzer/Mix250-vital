/**
 * service-worker.js — Background service worker (Manifest V3)
 *
 * Responsibilities:
 *  - Receive VERIFY_CLAIMS messages from the content script
 *  - Call the verification API (stub — replace with real endpoint)
 *  - Cache results in session storage keyed by tab ID
 *  - Relay results back to the content script
 */

// ── Config ────────────────────────────────────────────────────────────────────

const VERIFY_API_URL = 'https://your-verification-api.example.com/verify';

// ── Verification ──────────────────────────────────────────────────────────────

/**
 * Sends claims to the verification API and returns enriched claim objects.
 * Replace this stub with your actual API integration.
 *
 * @param {string[]} claimTexts
 * @returns {Promise<Array<{text: string, verdict: string, sourceUrl?: string}>>}
 */
async function verifyClaims(claimTexts) {
  // --- STUB: remove and replace with real fetch call ---
  // Simulates a short delay and returns all claims as 'unverified'
  await new Promise(resolve => setTimeout(resolve, 300));

  return claimTexts.map(text => ({
    text,
    verdict: 'unverified', // 'verified' | 'disputed' | 'unverified'
    sourceUrl: null,
  }));

  // --- Real implementation template (uncomment when ready) ---
  // const response = await fetch(VERIFY_API_URL, {
  //   method: 'POST',
  //   headers: { 'Content-Type': 'application/json' },
  //   body: JSON.stringify({ claims: claimTexts }),
  // });
  // if (!response.ok) throw new Error(`API error: ${response.status}`);
  // const data = await response.json();
  // return data.results; // expected shape: { text, verdict, sourceUrl? }[]
}

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'VERIFY_CLAIMS') return false;

  (async () => {
    let claims = [];

    try {
      claims = await verifyClaims(message.claims ?? []);

      // Persist results for this tab so the popup can load them on reopen
      if (sender.tab?.id != null) {
        const key = `claims_${sender.tab.id}`;
        await chrome.storage.session.set({ [key]: claims });
      }
    } catch (err) {
      console.error('[service-worker] Verification failed:', err);
      claims = (message.claims ?? []).map(text => ({
        text,
        verdict: 'unverified',
        sourceUrl: null,
      }));
    }

    sendResponse({ claims });
  })();

  return true; // keep channel open for async sendResponse
});

// ── Tab cleanup ───────────────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const key = `claims_${tabId}`;
  await chrome.storage.session.remove(key);
});
