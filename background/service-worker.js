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
  importScripts("config.js");
} catch {
  // eslint-disable-next-line no-global-assign
  if (typeof GEMINI_API_KEY === "undefined") GEMINI_API_KEY = "";
}

const PROVIDER_MODELS = {
  gemini: 'gemini-2.0-flash-lite',
  openai: 'gpt-4o-mini',
  claude: 'claude-haiku-4-5-20251001',
};

async function callAI(provider, key, promptText) {
  let rawText;

  if (provider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: PROVIDER_MODELS.openai,
        messages: [{ role: 'user', content: promptText }],
        max_tokens: 4096,
        temperature: 0.1,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenAI ${res.status}: ${body}`);
    }
    const data = await res.json();
    rawText = data.choices?.[0]?.message?.content ?? '';

  } else if (provider === 'claude') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: PROVIDER_MODELS.claude,
        max_tokens: 4096,
        temperature: 0.1,
        messages: [{ role: 'user', content: promptText }],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Claude ${res.status}: ${body}`);
    }
    const data = await res.json();
    rawText = data.content?.[0]?.text ?? '';

  } else {
    // Gemini (default)
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${PROVIDER_MODELS.gemini}:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: promptText }] }],
          generationConfig: { maxOutputTokens: 4096, temperature: 0.1 },
        }),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Gemini ${res.status}: ${body}`);
    }
    const data = await res.json();
    rawText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  }

  return rawText;
}

// ~8 000 tokens at ~4 chars/token
const MAX_ARTICLE_CHARS = 32_000;

// 60-second cooldown per tab
const COOLDOWN_MS = 60_000;

// In-memory cooldown map: tabId (number) → timestamp (ms)
const lastAnalysisAt = {};

// ── Toolbar icon — toggle custom sidebar ──────────────────────────────────────

chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.sendMessage(tab.id, { action: "toggleSidebar" }).catch(() => {
    // Content script not present on this page (e.g. chrome:// URLs) — ignore
  });
});

// ── Dummy data loader ─────────────────────────────────────────────────────────

async function loadDummyData(tabId) {
  const dataUrl = chrome.runtime.getURL("placeholder_data/placeholder_1.json");
  const dataset = await fetch(dataUrl).then((r) => r.json());

  let currentUrl = "";
  try {
    const tab = await chrome.tabs.get(tabId);
    currentUrl = tab.url || "";
  } catch {
    /* tab may have been closed */
  }

  const normalizeHost = (h) => h.replace(/^www\./, "");
  let article = dataset.articles.find((a) => a.url === currentUrl);
  if (!article) {
    try {
      const hostname = normalizeHost(new URL(currentUrl).hostname);
      article = dataset.articles.find((a) => {
        try {
          return normalizeHost(new URL(a.url).hostname) === hostname;
        } catch {
          return false;
        }
      });
    } catch {
      /* invalid URL */
    }
  }
  article = article ?? dataset.articles[0];

  if (!article) return null;

  return {
    claims: article.claims || [],
    framing: article.framing || {},
    warnings: article.warnings || [],
    source: article.source || null,
    author: article.author || null,
    results_summary: article.results_summary || "",
    main_claim: article.main_claim || null,
    truncated: false,
  };
}

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action !== "analyse") return false;

  const tabId = message.tabId;

  (async () => {
    // ── 1. Cooldown check ────────────────────────────────────────────────────
    const now = Date.now();
    const last = lastAnalysisAt[tabId] ?? 0;
    if (now - last < COOLDOWN_MS) {
      const remaining = Math.ceil((COOLDOWN_MS - (now - last)) / 1000);
      sendResponse({ error: "cooldown", remaining });
      return;
    }

    // ── 2. Dummy-data mode (USE_LIVE_API = false) ────────────────────────────
    if (!USE_LIVE_API) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      let result;
      try {
        result = await loadDummyData(tabId);
      } catch (err) {
        console.error("[vital:sw] Failed to load dummy data:", err);
        sendResponse({ error: "parse_failed" });
        return;
      }
      if (!result) {
        sendResponse({ error: "no_article" });
        return;
      }
      await chrome.storage.session.set({ [`analysis_${tabId}`]: result });
      sendResponse(result);
      return;
    }

    // ── 3. Retrieve article text from content script ──────────────────────────
    let articleText, articleTitle, articleUrl;
    try {
      const [res, tab] = await Promise.all([
        chrome.tabs.sendMessage(tabId, { action: "getArticleText" }),
        chrome.tabs.get(tabId),
      ]);
      if (res.error) {
        sendResponse({ error: res.error });
        return;
      }
      articleText = res.text;
      articleTitle = res.title;
      articleUrl = tab.url || "";
    } catch {
      sendResponse({ error: "content_script_unreachable" });
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

    // ── 6. Resolve provider and key ──────────────────────────────────────────
    let stored = {};
    try { stored = (await chrome.storage.sync.get("vitalSettings")).vitalSettings || {}; } catch {}
    const provider    = stored.aiProvider || "gemini";
    const resolvedKey = (stored.userApiKey || "").trim() || GEMINI_API_KEY;

    // ── 7. Call the AI provider ───────────────────────────────────────────────
    let result;
    let apiFailed = false;
    if (resolvedKey) {
      try {
        const rawText = await callAI(
          provider,
          resolvedKey,
          buildPrompt(articleTitle, articleText, articleUrl, truncated),
        );
        const jsonStr = rawText
          .replace(/^```(?:json)?\s*/i, "")
          .replace(/```\s*$/, "")
          .trim();
        result = JSON.parse(jsonStr);
        result.truncated = truncated;
      } catch (err) {
        console.error("[vital:sw] AI call failed:", err.message || err);
        apiFailed = true;
        // fall through to dummy data
      }
    } else {
      console.warn("[vital:sw] No API key configured — falling back to dummy data");
    }

    // ── 8. Fall back to dummy data if API failed ──────────────────────────────
    if (!result) {
      console.warn("[vital:sw] Falling back to dummy data");
      try {
        result = await loadDummyData(tabId);
      } catch (err) {
        console.error("[vital:sw] Failed to load dummy data:", err);
        sendResponse({ error: "parse_failed" });
        return;
      }
      if (!result) {
        sendResponse({ error: "no_article" });
        return;
      }
      if (apiFailed) result.apiFailed = true;
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

function buildPrompt(title, text, url, truncated) {
  const truncationNote = truncated
    ? "\n(Note: the article was truncated to fit within the token limit.)"
    : "";

  return `You are a health-journalism analyst. Analyse the article below and respond with ONLY a valid JSON object — no markdown, no commentary, nothing else.

Write these fields in Norwegian (Bokmål): "summary", "warnings[].title", "warnings[].description", "source.description", "author.bio", "framing.*.explanation", "results_summary", and "main_claim.explanation*". Write "claims[].explanation" and "claims[].sources" in the same language as the article. All "quote" fields must be verbatim from the article text.

The JSON must match this exact schema:
{
  "summary": "<2-4 sentence Norwegian summary of what the article is about>",

  "main_claim": {
    "summary": "<one sentence: the article's central health claim>",
    "verdict": "probable" | "disputed" | "unverifiable",
    "explanation": "<1-2 Norwegian sentences on the verdict>",
    "explanation_p2": "<optional second nuance or counterpoint — omit field if not needed>",
    "explanation_p3": "<optional third point on limitations or context — omit field if not needed>",
    "sources": [
      {
        "outlet": "<publication name and year>",
        "title": "<study or article title>",
        "url": "<URL if confidently known, otherwise omit this field>",
        "stance": "supports" | "contradicts" | "neutral"
      }
    ]
  },

  "warnings": [
    {
      "type": "<snake_case: outdated_research | misinformation_risk | conflict_of_interest | missing_sources | health_consequences | unreliable_source | speculative_timeline | opinion_piece | call_to_action>",
      "severity": "high" | "medium" | "low",
      "title": "<short Norwegian title>",
      "description": "<1-2 Norwegian sentences describing the concern>"
    }
  ],

  "source": {
    "outlet": "<news outlet name>",
    "domain": "<domain, e.g. nrk.no>",
    "description": "<1-2 Norwegian sentences on this outlet's credibility>"
  },

  "author": {
    "name": "<author name if found in the article, otherwise null>",
    "bio": "<1 Norwegian sentence bio, or null if unknown>"
  },

  "claims": [
    {
      "quote": "<exact verbatim phrase from the article, 5-20 words>",
      "verdict": "probable" | "disputed" | "unverifiable",
      "explanation": "<1-2 sentences>",
      "sources": [
        {
          "outlet": "<publication name and year>",
          "title": "<study or article title>",
          "url": "<URL if confidently known, otherwise omit this field>",
          "stance": "supports" | "contradicts" | "neutral"
        }
      ]
    }
  ],

  "framing": {
    "source_type": {
      "score": <float 0.0–1.0, where 0 = purely anecdotal/personal experience, 1 = peer-reviewed research>,
      "explanation": "<1 Norwegian sentence>"
    },
    "perspective": {
      "score": <float 0.0–1.0, where 0 = one-sided, 1 = balanced and nuanced>,
      "explanation": "<1 Norwegian sentence>"
    },
    "emotional_intensity": {
      "score": <float 0.0–1.0, where 0 = fear/anger-based language, 1 = calm and neutral>,
      "explanation": "<1 Norwegian sentence>"
    },
    "epistemic_certainty": {
      "score": <float 0.0–1.0, where 0 = speculation presented as fact, 1 = appropriately hedged>,
      "explanation": "<1 Norwegian sentence>"
    },
    "headline_accuracy": {
      "score": <float 0.0–1.0, where 0 = headline contradicts content, 1 = headline accurately reflects content>,
      "explanation": "<1 Norwegian sentence>"
    }
  },

  "results_summary": "<2-4 Norwegian sentences: overall assessment of the article's reliability>"
}

Rules:
- Extract every sentence or passage that makes a health-related claim into "claims".
- "quote" must be an exact substring of the article text — copy-paste, never paraphrase.
- Verdict options: "probable" (well-supported by scientific consensus), "disputed" (contradicted or contested), "unverifiable" (cannot be fact-checked).
- All five framing scores must be present.
- Only include "warnings" that genuinely apply — omit any that don't.
- For "source" and "author", use information from the article text or inferred from the URL.
- Do NOT invent URLs — only include a "url" field in sources if you are confident it is correct.
- Respond with the JSON object only — no other text.

Article URL: ${url}
Article title: ${title}${truncationNote}

Article text:
${text}`;
}
