#!/usr/bin/env node
/**
 * Smoke test: connect to a running Lingtan Assistant via the Chrome
 * DevTools Protocol and assert that the settings-gate JS injection
 * actually took effect.
 *
 * Usage: node scripts/probe-gate.cjs
 *   (the app must already be running with --remote-debugging-port=9222)
 */
'use strict';

const http = require('http');

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function main() {
  const tabs = await getJson('http://127.0.0.1:9222/json');
  const main = tabs.find((t) => t.url && t.url.startsWith('http://127.0.0.1:8787'));
  if (!main) {
    console.error('[probe] no main tab found');
    process.exit(2);
  }
  console.log('[probe] main tab:', main.title, main.url);

  // CDP requires WebSocket; Node 22 has a built-in WebSocket client.
  const ws = new WebSocket(main.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const _id = ++id;
      pending.set(_id, { resolve, reject });
      ws.send(JSON.stringify({ id: _id, method, params }));
    });
  }

  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(msg.error) : resolve(msg.result);
    }
  });

  await send('Runtime.enable');

  async function evalJs(expression) {
    const r = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  }

  // Wait up to 5s for the gate to install (did-finish-load + injection
  // happens after we open the WS, depending on timing).
  let installed = false;
  for (let i = 0; i < 25; i++) {
    installed = await evalJs('!!window.__lingtanSettingsGateInstalled');
    if (installed) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log('[probe] gate installed:', installed);

  const hashConfigured = await evalJs(
    'typeof window.__lingtanGate === "object" && !!window.__lingtanGate.settingsPasswordHash'
  );
  console.log('[probe] hash bundled in window:', hashConfigured);

  const settingsHidden = await evalJs(`(() => {
    const el = document.querySelector('[data-panel="settings"]');
    if (!el) return 'no-button';
    const cs = getComputedStyle(el);
    return cs.display === 'none' ? 'hidden' : 'visible:'+cs.display;
  })()`);
  console.log('[probe] settings rail button:', settingsHidden);

  const panelHidden = await evalJs(`(() => {
    const el = document.getElementById('panelSettings');
    if (!el) return 'no-panel';
    return getComputedStyle(el).display === 'none' ? 'hidden' : 'visible';
  })()`);
  console.log('[probe] settings panel #panelSettings:', panelHidden);

  // Verify the password works (the bundled default is "lingtan2026").
  const pwOk = await evalJs(`(async () => {
    const buf = new TextEncoder().encode('lingtan2026');
    const h = await crypto.subtle.digest('SHA-256', buf);
    const hex = Array.from(new Uint8Array(h)).map(b=>b.toString(16).padStart(2,'0')).join('');
    return hex === window.__lingtanGate.settingsPasswordHash;
  })()`);
  console.log('[probe] default password unlocks gate:', pwOk);

  ws.close();
  const ok = installed && hashConfigured && settingsHidden === 'hidden' && panelHidden === 'hidden' && pwOk;
  console.log(ok ? '[probe] ALL OK' : '[probe] FAIL');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('[probe] error:', e); process.exit(3); });
