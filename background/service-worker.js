/**
 * service-worker.js — Background service worker (Manifest V3)
 *
 * Responsibilities:
 *  - Open the side panel when the extension icon is clicked
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
importScripts('config.js');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-20250514';

// ~8 000 tokens at ~4 chars/token
const MAX_ARTICLE_CHARS = 32_000;

// 60-second cooldown per tab
const COOLDOWN_MS = 60_000;

// In-memory cooldown map: tabId (number) → timestamp (ms)
const lastAnalysisAt = {};

// ── Side panel behaviour ───────────────────────────────────────────────────────

// Open the side panel automatically when the toolbar icon is clicked.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(console.error);

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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

    // ── 2. Retrieve article text from content script ──────────────────────────
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
      // Content script is not present — user is probably not on a supported site
      sendResponse({ error: 'content_script_unreachable' });
      return;
    }

    // ── 3. Mock mode ──────────────────────────────────────────────────────────
    if (USE_MOCK) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      const mockResult = {
        claims: [
          {
            quote: "menn har en høyere risiko for å dø som følge av korona",
            verdict: "probable",
            explanation: "Dette er godt dokumentert i flere store internasjonale studier og støttes av WHO-data fra hele pandemien."
          },
          {
            quote: "kvinner rammes hardest av senskader",
            verdict: "probable",
            explanation: "Flere studier fra Russland, Storbritannia og Bangladesh peker i samme retning, selv om den eksakte andelen varierer mellom studiene."
          },
          {
            quote: "kvinner kan oppleve langtidseffekter av korona hele fire ganger oftere enn menn",
            verdict: "disputed",
            explanation: "Dette tallet kommer fra tidlige, ikke fagfellevurderte meldinger fra Paris-sykehus og er ikke bekreftet av større kontrollerte studier."
          },
          {
            quote: "andelen kvinner som får senskader ligger på omtrent 55 prosent",
            verdict: "probable",
            explanation: "Funnet stammer fra en publisert studie fra Bangladesh, men generaliserbarheten til norske forhold er usikker."
          },
          {
            quote: "andelen kvinner med senskader kan være opptil 70–80 prosent",
            verdict: "disputed",
            explanation: "Dette er ett enkeltestimat fra én forsker og avviker betydelig fra andre studier. Det er ikke støttet av meta-analyser på feltet."
          },
          {
            quote: "31 prosent av dem som har gjennomgått koronasykdom rapporterer om utmattelse her i Norge",
            verdict: "probable",
            explanation: "Tallet er hentet fra den norske koronastudien ved Oslo universitetssykehus, basert på svar fra over 150 000 nordmenn."
          },
          {
            quote: "covid-19 kan gi alvorlige hjerneskader, og hele 10 prosent opplever hukommelsesproblemer",
            verdict: "probable",
            explanation: "Nevrologiske senskader etter covid-19 er dokumentert i flere fagfellevurderte studier, inkludert fra The Lancet."
          },
          {
            quote: "Risikoen er fire ganger høyere for å få ME (kronisk utmattelsessyndrom), som er en typisk senskade",
            verdict: "probable",
            explanation: "Økt ME-risiko hos kvinner etter virusinfeksjoner er etablert i forskning som går forut for covid-19-pandemien."
          },
          {
            quote: "rester av koronaviruset blir igjen i kroppen i flere måneder",
            verdict: "disputed",
            explanation: "Teorien om viruspersistens er omdiskutert. Noen studier har funnet virusfragmenter i vev, men årsakssammenhengen med senskader er ikke fastslått."
          },
          {
            quote: "ikke noe psykisk",
            verdict: "disputed",
            explanation: "Selv om senskadene er reelle, er det forskning som tyder på at psykologiske faktorer også spiller en rolle i utmattelse etter covid-19. Bildet er sammensatt."
          }
        ],
        framing: {
          source_type: 0.65,
          perspective: 0.6,
          tone: 0.45,
          headline_accuracy: 0.85
        }
      };
      await chrome.storage.session.set({ [`analysis_${tabId}`]: mockResult });
      sendResponse({ ...mockResult, truncated: false });
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
