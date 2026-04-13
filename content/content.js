/**
 * content.js — Content script for Health Claim Verifier
 *
 * Responsibilities (v1):
 *  - Listen for { action: "getArticleText" } messages from the service worker
 *  - Use Mozilla Readability (injected before this script) to extract article text
 *  - Return { text, title } or { error } via sendResponse
 *
 * Readability is available as a global because lib/Readability.js is listed
 * first in the manifest content_scripts array and runs in the same context.
 */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action !== 'getArticleText') return false;

  try {
    // Readability mutates the document, so always work on a clone
    const docClone = document.cloneNode(true);
    const reader = new Readability(docClone);
    const article = reader.parse();

    if (!article || !article.textContent || article.textContent.trim().length < 100) {
      sendResponse({ error: 'no_article' });
      return true;
    }

    sendResponse({
      text: article.textContent.trim(),
      title: article.title || document.title,
    });
  } catch (err) {
    console.error('[hcv:content] Readability failed:', err);
    sendResponse({ error: 'extraction_failed' });
  }

  return true; // keep channel open for async sendResponse
});
