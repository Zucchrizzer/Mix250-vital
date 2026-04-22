/**
 * floating-button.js — Injects the VITAL floating open button into the page.
 * Reads showFloatingButton + floatingButtonSide from chrome.storage.sync,
 * and reacts live to settings changes.
 */

(function () {
  const BTN_ID    = 'vital-floating-btn';
  const STYLE_ID  = 'vital-floating-styles';

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = `
      #vital-floating-btn {
        position: fixed;
        top: 50%;
        transform: translateY(-50%);
        z-index: 2147483647;
        width: 32px;
        height: 48px;
        background: #3b82f6;
        color: #fff;
        border: none;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: 'Poppins', sans-serif;
        font-size: 17px;
        font-weight: 600;
        letter-spacing: -0.5px;
        box-shadow: 0 2px 10px rgba(0,0,0,0.22);
        transition: background 0.15s, box-shadow 0.15s, width 0.15s;
        padding: 0;
        user-select: none;
      }
      #vital-floating-btn[data-side="right"] {
        right: 0; left: auto;
        border-radius: 8px 0 0 8px;
      }
      #vital-floating-btn[data-side="left"] {
        left: 0; right: auto;
        border-radius: 0 8px 8px 0;
      }
      #vital-floating-btn:hover {
        width: 38px;
        background: #2563eb;
        box-shadow: 0 4px 14px rgba(0,0,0,0.28);
      }
      #vital-floating-btn:active {
        background: #1d4ed8;
      }
    `;
    document.head.appendChild(s);
  }

  function readSettings(cb) {
    chrome.storage.sync.get('vitalSettings', result => {
      const s = result.vitalSettings || {};
      cb({
        show: s.showFloatingButton !== false,  // default true
        side: s.floatingButtonSide  || 'right',
      });
    });
  }

  function updateButton({ show, side }) {
    let btn = document.getElementById(BTN_ID);

    if (!show) {
      if (btn) btn.remove();
      return;
    }

    injectStyles();

    if (!btn) {
      btn = document.createElement('button');
      btn.id = BTN_ID;
      btn.setAttribute('aria-label', 'Åpne VITAL');
      btn.textContent = 'V';
      btn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'openSidePanel' });
      });
      document.body.appendChild(btn);
    }

    btn.dataset.side = side;
  }

  function init() {
    readSettings(updateButton);
  }

  if (document.body) {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }

  // React live to settings changes
  chrome.storage.onChanged.addListener((changes) => {
    if (!changes.vitalSettings) return;
    const s = changes.vitalSettings.newValue || {};
    updateButton({
      show: s.showFloatingButton !== false,
      side: s.floatingButtonSide  || 'right',
    });
  });
})();
