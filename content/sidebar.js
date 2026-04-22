/**
 * sidebar.js — Injects the VITAL sidebar (iframe + toggle tab) into every page.
 * The iframe contains panel/panel.html, running in the full extension context.
 * Reads showFloatingButton + floatingButtonSide from chrome.storage.sync and
 * updates live when settings change.
 */

(function () {
  const CONTAINER_ID = 'vital-sidebar-root';
  const FRAME_ID     = 'vital-sidebar-frame';
  const BTN_ID       = 'vital-sidebar-tab';
  const STYLE_ID     = 'vital-sidebar-styles';
  const PANEL_W      = 420;  // wide enough for tabbar + gear icon
  const TAB_W        = 36;
  const TAB_H        = 56;   // button height — not full screen

  let isOpen = false;

  // ── Styles ──────────────────────────────────────────────────────────────────

  function applyStyles(side) {
    let el = document.getElementById(STYLE_ID);
    if (!el) {
      el = document.createElement('style');
      el.id = STYLE_ID;
      document.head.appendChild(el);
    }

    const isRight = side !== 'left';

    el.textContent = `
      #${CONTAINER_ID} {
        position: fixed !important;
        top: 0 !important;
        ${isRight ? 'right: 0' : 'left: 0'} !important;
        height: 100dvh !important;
        width: ${PANEL_W + TAB_W}px !important;
        z-index: 2147483646 !important;
        display: flex !important;
        flex-direction: ${isRight ? 'row' : 'row-reverse'} !important;
        align-items: stretch !important;
        pointer-events: none !important;
        transform: translateX(${isRight ? `calc(100% - ${TAB_W}px)` : `calc(-100% + ${TAB_W}px)`}) !important;
        transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important;
      }
      #${CONTAINER_ID}.vital-open {
        transform: translateX(0) !important;
      }
      #${BTN_ID} {
        width: ${TAB_W}px !important;
        min-width: ${TAB_W}px !important;
        height: ${TAB_H}px !important;
        align-self: center !important;
        background: #3b82f6 !important;
        color: #fff !important;
        border: none !important;
        cursor: pointer !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        font-family: 'Poppins', sans-serif !important;
        font-size: 16px !important;
        font-weight: 600 !important;
        letter-spacing: -0.5px !important;
        border-radius: ${isRight ? '8px 0 0 8px' : '0 8px 8px 0'} !important;
        box-shadow: ${isRight ? '-3px 0 10px rgba(0,0,0,0.2)' : '3px 0 10px rgba(0,0,0,0.2)'} !important;
        pointer-events: all !important;
        user-select: none !important;
        flex-shrink: 0 !important;
        transition: background 0.15s !important;
        padding: 0 !important;
        margin: 0 !important;
        outline: none !important;
      }
      #${BTN_ID}:hover  { background: #2563eb !important; }
      #${BTN_ID}:active { background: #1d4ed8 !important; }
      #${FRAME_ID} {
        width: ${PANEL_W}px !important;
        height: 100% !important;
        border: none !important;
        pointer-events: all !important;
        display: block !important;
        background: #fafafa !important;
        box-shadow: ${isRight ? '-6px 0 32px rgba(2,26,72,0.13)' : '6px 0 32px rgba(2,26,72,0.13)'} !important;
        flex-shrink: 0 !important;
      }
    `;
  }

  // ── Build ────────────────────────────────────────────────────────────────────

  function build({ show, side }) {
    const old = document.getElementById(CONTAINER_ID);
    if (old) old.remove();
    if (!show) return;

    applyStyles(side);

    const container = document.createElement('div');
    container.id = CONTAINER_ID;
    if (isOpen) container.classList.add('vital-open');

    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.setAttribute('aria-label', 'Åpne / lukk VITAL');
    btn.textContent = 'V';
    btn.addEventListener('click', toggle);

    const frame = document.createElement('iframe');
    frame.id  = FRAME_ID;
    frame.src = chrome.runtime.getURL('panel/panel.html');
    frame.setAttribute('title', 'VITAL');
    frame.setAttribute('allowtransparency', 'true');

    container.appendChild(btn);
    container.appendChild(frame);
    document.body.appendChild(container);
  }

  // ── Toggle ───────────────────────────────────────────────────────────────────

  function toggle() {
    isOpen = !isOpen;
    const c = document.getElementById(CONTAINER_ID);
    if (c) c.classList.toggle('vital-open', isOpen);
  }

  // ── Settings ─────────────────────────────────────────────────────────────────

  function readSettings(cb) {
    chrome.storage.sync.get('vitalSettings', result => {
      const s = result.vitalSettings || {};
      cb({
        show: s.showFloatingButton !== false,
        side: s.floatingButtonSide  || 'right',
      });
    });
  }

  // ── Init ─────────────────────────────────────────────────────────────────────

  function init() {
    readSettings(build);
  }

  if (document.body) {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }

  // Live settings changes
  chrome.storage.onChanged.addListener(changes => {
    if (!changes.vitalSettings) return;
    const s = changes.vitalSettings.newValue || {};
    build({
      show: s.showFloatingButton !== false,
      side: s.floatingButtonSide  || 'right',
    });
  });

  // Toolbar icon / service worker toggle
  chrome.runtime.onMessage.addListener(message => {
    if (message.action === 'toggleSidebar') toggle();
  });
})();
