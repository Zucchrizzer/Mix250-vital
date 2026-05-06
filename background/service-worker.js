/**
 * service-worker.js — Background service worker (Manifest V3)
 *
 * Responsibilities:
 *  - Toggle the custom sidebar when the toolbar icon is clicked
 *  - Handle { action: "analyse", tabId } messages from the panel
 *  - Enforce a per-tab 60-second cooldown
 *  - Retrieve article text from the content script
 *  - POST to the Gemini API and parse the structured JSON response
 *  - Fall back to dummy data if the API call fails
 *  - Store the result in chrome.storage.session keyed by tab ID
 *  - Send the result (or an error) back to the panel
 */

// ── Toggle this to disable live API calls (uses dummy data instead) ───────────
const USE_LIVE_API = false;

// config.js defines GEMINI_API_KEY as a global.
// Not required when USE_LIVE_API = false — wrap so the worker loads without it.
try {
  importScripts('config.js');
} catch {
  // eslint-disable-next-line no-global-assign
  if (typeof GEMINI_API_KEY === 'undefined') GEMINI_API_KEY = '';
}

const MODEL = 'gemini-2.0-flash';

// ~8 000 tokens at ~4 chars/token
const MAX_ARTICLE_CHARS = 32_000;

// 60-second cooldown per tab
const COOLDOWN_MS = 60_000;

// In-memory cooldown map: tabId (number) → timestamp (ms)
const lastAnalysisAt = {};

// ── Toolbar icon — toggle custom sidebar ──────────────────────────────────────

chrome.action.onClicked.addListener(tab => {
  chrome.tabs.sendMessage(tab.id, { action: 'toggleSidebar' }).catch(() => {
    // Content script not present on this page (e.g. chrome:// URLs) — ignore
  });
});

// ── Dummy data loader ─────────────────────────────────────────────────────────

async function loadDummyData(tabId) {
  const dataUrl = chrome.runtime.getURL('placeholder_data/placeholder_1.json');
  const dataset = await fetch(dataUrl).then(r => r.json());

  let currentUrl = '';
  try {
    const tab = await chrome.tabs.get(tabId);
    currentUrl = tab.url || '';
  } catch { /* tab may have been closed */ }

  const normalizeHost = h => h.replace(/^www\./, '');
  let article = dataset.articles.find(a => a.url === currentUrl);
  if (!article) {
    try {
      const hostname = normalizeHost(new URL(currentUrl).hostname);
      article = dataset.articles.find(a => {
        try { return normalizeHost(new URL(a.url).hostname) === hostname; } catch { return false; }
      });
    } catch { /* invalid URL */ }
  }
  article = article ?? dataset.articles[0];

  if (!article) return null;

  return {
    claims:          article.claims          || [],
    framing:         article.framing         || {},
    warnings:        article.warnings        || [],
    source:          article.source          || null,
    author:          article.author          || null,
    results_summary: article.results_summary || '',
    main_claim:      article.main_claim      || null,
    truncated:       false,
  };
}

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action !== 'analyse') return false;

  const tabId = message.tabId;

  (async () => {
    // ── 1. Cooldown check ────────────────────────────────────────────────────
    const now = Date.now();
    const last = lastAnalysisAt[tabId] ?? 0;
    if (now - last < COOLDOWN_MS) {
      const remaining = Math.ceil((COOLDOWN_MS - (now - last)) / 1000);
      sendResponse({ error: 'cooldown', remaining });
      return;
    }

    // ── 2. Dummy-data mode (USE_LIVE_API = false) ────────────────────────────
    if (!USE_LIVE_API) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      let result;
      try {
        result = await loadDummyData(tabId);
      } catch (err) {
        console.error('[vital:sw] Failed to load dummy data:', err);
        sendResponse({ error: 'parse_failed' });
        return;
      }
      if (!result) { sendResponse({ error: 'no_article' }); return; }
      await chrome.storage.session.set({ [`analysis_${tabId}`]: result });
      sendResponse(result);
      return;
    }

    // ── 3. Retrieve article text from content script ──────────────────────────
    let articleText, articleTitle;
    try {
      const res = await chrome.tabs.sendMessage(tabId, { action: 'getArticleText' });
      if (res.error) { sendResponse({ error: res.error }); return; }
      articleText = res.text;
      articleTitle = res.title;
    } catch {
      sendResponse({ error: 'content_script_unreachable' });
      return;
    }

    // ── 4. Truncate if needed ─────────────────────────────────────────────────
    let truncated = false;
    if (articleText.length > MAX_ARTICLE_CHARS) {
      articleText = articleText.slice(0, MAX_ARTICLE_CHARS);
      truncated = true;
    }

    // ── 5. Record cooldown timestamp before the network call ─────────────────
    lastAnalysisAt[tabId] = Date.now();

    // ── 6. Call the Gemini API ────────────────────────────────────────────────
    let result;
    try {
      const apiResponse = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: buildPrompt(articleTitle, articleText, truncated) }] }],
            generationConfig: { maxOutputTokens: 4096, temperature: 0.1 },
          }),
        }
      );

      if (!apiResponse.ok) {
        const body = await apiResponse.text().catch(() => '');
        console.error('[vital:sw] Gemini API error', apiResponse.status, body);
        // fall through to dummy data
      } else {
        const data = await apiResponse.json();
        const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

        // ── 7. Parse structured JSON response ─────────────────────────────────
        try {
          const jsonStr = rawText
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/```\s*$/, '')
            .trim();
          result = JSON.parse(jsonStr);
          result.truncated = truncated;
        } catch (err) {
          console.error('[vital:sw] JSON parse failed:', err, '\nRaw:', rawText);
          // fall through to dummy data
        }
      }
    } catch (err) {
      console.error('[vital:sw] Network error:', err);
      // fall through to dummy data
    }

    // ── 8. Fall back to dummy data if API failed ──────────────────────────────
    if (!result) {
      console.warn('[vital:sw] API failed — falling back to dummy data');
      try {
        result = await loadDummyData(tabId);
      } catch (err) {
        console.error('[vital:sw] Failed to load dummy data:', err);
        sendResponse({ error: 'parse_failed' });
        return;
      }
      if (!result) { sendResponse({ error: 'no_article' }); return; }
    }

    // ── 9. Persist and respond ────────────────────────────────────────────────
    await chrome.storage.session.set({ [`analysis_${tabId}`]: result });
    sendResponse(result);
  })();

  return true; // keep channel open for async sendResponse
});

// ── Tab cleanup ───────────────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  delete lastAnalysisAt[tabId];
  chrome.storage.session.remove(`analysis_${tabId}`).catch(() => {});
});

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildPrompt(title, text, truncated) {
  const truncationNote = truncated
    ? '\n(Note: the article was truncated to fit within the token limit.)'
    : '';

  return `You are a health-journalism analyst. Analyse the article below and respond with ONLY a valid JSON object — no markdown, no commentary, nothing else.

The JSON must match this exact schema:
{
  "claims": [
    {
      "quote": "<exact verbatim phrase from the article, 5-15 words, used to locate the claim in the text>",
      "verdict": "probable" | "disputed",
      "explanation": "<1-2 sentences explaining why the claim is probable or disputed>"
    }
  ],
  "framing": {
    "source_type": <float 0.0–1.0, where 0 = purely anecdotal/personal experience, 1 = research-based>,
    "perspective": <float 0.0–1.0, where 0 = one-sided, 1 = nuanced/balanced>,
    "tone": <float 0.0–1.0, where 0 = fear-based language, 1 = hope-based language>,
    "headline_accuracy": <float 0.0–1.0, where 0 = headline doesn't match content, 1 = headline reflects content accurately>
  }
}

Rules:
- Extract every sentence or passage that makes a health-related claim.
- "quote" must be an exact substring of the article text (copy-paste, not paraphrased).
- "verdict" is either "probable" (broadly supported by scientific consensus) or "disputed" (contradicted, contested, or lacking evidence).
- All four framing floats must be present.
- Respond with the JSON object only — no other text.

Article title: ${title}${truncationNote}

Article text:
${text}`;
}
