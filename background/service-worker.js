/**
 * service-worker.js — Background service worker (Manifest V3)
 *
 * Responsibilities:
 *  - Toggle the custom sidebar when the toolbar icon is clicked
 *  - Handle { action: "analyse", tabId } messages from the panel
 *  - Enforce a per-tab 60-second cooldown
 *  - Retrieve article text from the content script
 *  - POST to the Claude API and parse the structured JSON response
 *  - Store the result in chrome.storage.session keyed by tab ID
 *  - Send the result (or an error) back to the panel
 */

const USE_MOCK = true;

// config.js defines ANTHROPIC_API_KEY as a global.
// Path is resolved from the extension root, not from this file's directory.
// Not required in mock mode — wrap so the worker loads without the file.
try {
  importScripts('config.js');
} catch {
  // eslint-disable-next-line no-global-assign
  if (typeof ANTHROPIC_API_KEY === 'undefined') ANTHROPIC_API_KEY = 'YOUR_API_KEY_HERE';
}

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-20250514';

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

    // ── 2. Mock mode (skips content script entirely) ─────────────────────────
    if (USE_MOCK) {
      await new Promise(resolve => setTimeout(resolve, 1500));

      let dataset;
      try {
        const dataUrl = chrome.runtime.getURL('dummy_data_2.json');
        dataset = await fetch(dataUrl).then(r => r.json());
      } catch (err) {
        console.error('[vital:sw] Failed to load dummy_data.json:', err);
        sendResponse({ error: 'parse_failed' });
        return;
      }

      let currentUrl = '';
      try {
        const tab = await chrome.tabs.get(tabId);
        currentUrl = tab.url || '';
      } catch { /* tab may have been closed */ }

      // Match by exact URL first, then by domain, then fall back to first article
      let article = dataset.articles.find(a => a.url === currentUrl);
      if (!article) {
        try {
          const hostname = new URL(currentUrl).hostname;
          article = dataset.articles.find(a => {
            try { return new URL(a.url).hostname === hostname; } catch { return false; }
          });
        } catch { /* invalid URL */ }
      }
      article = article ?? dataset.articles[0];

      if (!article) {
        sendResponse({ error: 'no_article' });
        return;
      }

      const result = {
        claims:          article.claims          || [],
        framing:         article.framing         || {},
        warnings:        article.warnings        || [],
        source:          article.source          || null,
        author:          article.author          || null,
        results_summary: article.results_summary || '',
        main_claim:      article.main_claim      || null,
        truncated:       false,
      };

      await chrome.storage.session.set({ [`analysis_${tabId}`]: result });
      sendResponse(result);
      return;
    }

    // ── 3. Retrieve article text from content script ──────────────────────────
    let articleText, articleTitle;
    try {
      const res = await chrome.tabs.sendMessage(tabId, { action: 'getArticleText' });
      if (res.error) {
        sendResponse({ error: res.error });
        return;
      }
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

    // ── 6. Call the Claude API ────────────────────────────────────────────────
    let rawText;
    try {
      const apiResponse = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 4096,
          messages: [
            {
              role: 'user',
              content: buildPrompt(articleTitle, articleText, truncated),
            },
          ],
        }),
      });

      if (!apiResponse.ok) {
        const body = await apiResponse.text().catch(() => '');
        console.error('[hcv:sw] API error', apiResponse.status, body);
        sendResponse({ error: 'api_error', status: apiResponse.status });
        return;
      }

      const data = await apiResponse.json();
      rawText = data?.content?.[0]?.text ?? '';
    } catch (err) {
      console.error('[hcv:sw] Network error:', err);
      sendResponse({ error: 'network_error' });
      return;
    }

    // ── 7. Parse structured JSON response ─────────────────────────────────────
    let result;
    try {
      // Strip optional markdown code fences the model sometimes adds
      const jsonStr = rawText
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```\s*$/, '')
        .trim();
      result = JSON.parse(jsonStr);
    } catch (err) {
      console.error('[hcv:sw] JSON parse failed:', err, '\nRaw:', rawText);
      sendResponse({ error: 'parse_failed' });
      return;
    }

    // ── 8. Persist and respond ─────────────────────────────────────────────────
    await chrome.storage.session.set({ [`analysis_${tabId}`]: result });
    sendResponse({ ...result, truncated });
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
