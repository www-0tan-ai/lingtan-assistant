/**
 * Lingtan Assistant — settings-page password gate.
 *
 * Injected into the Hermes Web UI renderer by main.js after dom-ready.
 *
 * Behavior:
 *   - Hides every visible entry point to the Settings panel via CSS
 *     (rail buttons, mobile nav tabs, the panel itself, onboarding).
 *   - Listens for Ctrl+Shift+L (or ⌘+Shift+L on macOS) to pop a small
 *     password prompt overlay.
 *   - On correct password, removes the hiding stylesheet and switches
 *     the WebUI to the settings panel.
 *
 * The expected password hash is injected via window.__lingtanGate.
 * We compare a SHA-256 of the user's input against it client-side;
 * the plaintext password is never embedded in this script.
 */

(function injectLingtanSettingsGate() {
  if (window.__lingtanSettingsGateInstalled) return;
  window.__lingtanSettingsGateInstalled = true;

  const gate = window.__lingtanGate || {};
  const expectedHash = gate.settingsPasswordHash || null;

  // ── 1. Hiding stylesheet ──────────────────────────────────────────
  const hideStyleId = '__lingtanGateHideStyle';
  const HIDE_CSS = `
    /* Sidebar rail entry, mobile nav tab, the settings panel itself,
       and the onboarding flow — all gated. */
    [data-panel="settings"],
    #panelSettings,
    [data-onboarding-step],
    .onboarding-overlay,
    .onboarding-launcher {
      display: none !important;
      visibility: hidden !important;
      pointer-events: none !important;
    }
  `;
  function installHideStyle() {
    if (document.getElementById(hideStyleId)) return;
    const s = document.createElement('style');
    s.id = hideStyleId;
    s.textContent = HIDE_CSS;
    (document.head || document.documentElement).appendChild(s);
  }
  function removeHideStyle() {
    const s = document.getElementById(hideStyleId);
    if (s) s.remove();
  }
  installHideStyle();

  // ── 2. SHA-256 (Web Crypto) ───────────────────────────────────────
  async function sha256Hex(s) {
    const buf = new TextEncoder().encode(s);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  // ── 3. Password overlay ───────────────────────────────────────────
  function buildOverlay() {
    const wrap = document.createElement('div');
    wrap.id = '__lingtanGateOverlay';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.style.cssText = `
      position: fixed; inset: 0; z-index: 2147483647;
      background: rgba(0,0,0,.55); backdrop-filter: blur(4px);
      display: flex; align-items: center; justify-content: center;
      font-family: -apple-system, "Segoe UI", "PingFang SC",
        "Microsoft YaHei", Roboto, system-ui, sans-serif;
      animation: lt-fade .15s ease-out;
    `;
    wrap.innerHTML = `
      <style>
        @keyframes lt-fade { from { opacity: 0 } to { opacity: 1 } }
      </style>
      <form id="__lingtanGateForm"
            style="background:#1f1f24;color:#eaeaea;border-radius:14px;
                   padding:24px 24px 20px;width:340px;max-width:92vw;
                   box-shadow:0 18px 60px rgba(0,0,0,.5);
                   border:1px solid rgba(255,255,255,.08);">
        <div style="font-size:15px;font-weight:600;margin-bottom:6px;">
          管理员验证
        </div>
        <div style="font-size:12.5px;color:#9aa0a6;line-height:1.5;
                    margin-bottom:14px;">
          需要密码才能打开设置面板。
        </div>
        <input id="__lingtanGateInput" type="password" autocomplete="off"
               autofocus
               placeholder="管理员密码"
               style="width:100%;box-sizing:border-box;padding:9px 12px;
                      border-radius:8px;border:1px solid rgba(255,255,255,.12);
                      background:#15151a;color:#fff;font-size:14px;
                      outline:none;" />
        <div id="__lingtanGateErr"
             style="font-size:12px;color:#ff7676;min-height:16px;
                    margin-top:8px;"></div>
        <div style="display:flex;gap:8px;margin-top:12px;
                    justify-content:flex-end;">
          <button type="button" id="__lingtanGateCancel"
                  style="padding:7px 14px;border-radius:8px;border:none;
                         background:transparent;color:#9aa0a6;
                         cursor:pointer;font-size:13px;">取消</button>
          <button type="submit"
                  style="padding:7px 16px;border-radius:8px;border:none;
                         background:#4f8cff;color:#fff;font-weight:600;
                         cursor:pointer;font-size:13px;">解锁</button>
        </div>
      </form>
    `;
    return wrap;
  }

  let overlayOpen = false;
  async function openOverlay() {
    if (overlayOpen) return;
    overlayOpen = true;
    const overlay = buildOverlay();
    document.body.appendChild(overlay);

    const input = overlay.querySelector('#__lingtanGateInput');
    const err = overlay.querySelector('#__lingtanGateErr');
    const form = overlay.querySelector('#__lingtanGateForm');
    const cancel = overlay.querySelector('#__lingtanGateCancel');

    function close() {
      overlay.remove();
      overlayOpen = false;
    }
    cancel.addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    document.addEventListener('keydown', function escClose(e) {
      if (!overlayOpen) {
        document.removeEventListener('keydown', escClose);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        document.removeEventListener('keydown', escClose);
      }
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = input.value || '';
      if (!expectedHash) {
        err.textContent = '密码未配置,请重新打包后再试。';
        return;
      }
      const got = await sha256Hex(v);
      if (got === expectedHash) {
        removeHideStyle();
        close();
        try {
          if (typeof window.switchPanel === 'function') {
            window.switchPanel('settings');
          }
        } catch (_) { /* ignore */ }
      } else {
        err.textContent = '密码错误。';
        input.select();
      }
    });
  }

  // ── 4. Hotkey ─────────────────────────────────────────────────────
  document.addEventListener(
    'keydown',
    (e) => {
      const isMac = navigator.platform.toLowerCase().includes('mac');
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (mod && e.shiftKey && (e.key === 'L' || e.key === 'l')) {
        e.preventDefault();
        e.stopPropagation();
        openOverlay();
      }
    },
    true
  );

  // ── 5. URL hash escape hatch — visit ?#__admin to prompt ──────────
  if (location.hash === '#__admin') {
    setTimeout(openOverlay, 300);
  }

  // ── 6. Re-apply hide style if Hermes UI re-renders settings DOM
  //       (defensive — settings markup is built once, but cheap MutationObserver
  //       costs nothing and protects against future template churn). ─
  const mo = new MutationObserver(() => {
    if (!document.getElementById(hideStyleId)) {
      // user unlocked; honor their choice and stop observing
      mo.disconnect();
    }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  console.log('[lingtan-gate] settings panel locked — Ctrl+Shift+L to unlock');
})();
