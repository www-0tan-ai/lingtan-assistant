#!/usr/bin/env node
/**
 * End-to-end smoke test against a running Lingtan Assistant:
 *   - Connects via Chrome DevTools Protocol on :9222
 *   - Triggers AIAgent import on the Python side via a known WebUI endpoint
 *   - Asserts the in-page DOM does not show "AIAgent not available"
 *
 * The agent_health endpoint (/api/agent/health) is what hermes-webui
 * uses internally to surface the "AIAgent not available" banner.
 */
'use strict';

const http = require('http');

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { resolve(body); }
      });
    }).on('error', reject);
  });
}

async function main() {
  // 1. Hit the python health endpoint directly to surface its agent state.
  const candidates = [
    '/api/agent_health',
    '/api/agent-health',
    '/api/agent/health',
    '/api/dashboard_probe',
    '/api/health',
    '/api/system_health',
  ];
  for (const p of candidates) {
    try {
      const r = await getJson(`http://127.0.0.1:8787${p}`);
      console.log(`[probe] ${p}:`, typeof r === 'string' ? r.slice(0, 200) : JSON.stringify(r).slice(0, 400));
    } catch (e) {
      console.log(`[probe] ${p}: ${e.message}`);
    }
  }

  // 2. Use CDP to look for the error banner in the actual DOM.
  const tabs = await getJson('http://127.0.0.1:9222/json');
  const main = tabs.find((t) => t.url && t.url.startsWith('http://127.0.0.1:8787'));
  if (!main) {
    console.error('[probe] no main tab');
    process.exit(2);
  }
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
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(m.error) : resolve(m.result);
    }
  });
  await send('Runtime.enable');

  async function evalJs(expr) {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  }

  // Surface any visible "AIAgent" or "agent not available" text.
  const errs = await evalJs(`
    (() => {
      const txt = document.body.innerText || '';
      const lines = txt.split('\\n').filter(l => /agent\\s*not\\s*available|AIAgent\\s*not|hermes-agent.*sys.path/i.test(l));
      return lines.slice(0, 8);
    })()
  `);
  console.log('[probe] error-banner text:', JSON.stringify(errs));

  // Pull whatever the WebUI's agent badge area is showing.
  const badgeProbe = await evalJs(`
    (() => {
      const sels = [
        '[data-testid=agent-status]',
        '.agent-status', '.agent-badge', '.composer-status',
        '#composerError', '.composer-error',
      ];
      const found = {};
      for (const s of sels) {
        const e = document.querySelector(s);
        if (e) found[s] = (e.innerText || '').slice(0, 160);
      }
      return found;
    })()
  `);
  console.log('[probe] badge probe:', JSON.stringify(badgeProbe));

  ws.close();
  const ok = !errs.length;
  console.log(ok ? '[probe] AGENT IMPORT OK (no error banner visible)' : '[probe] FAIL — agent error still showing');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('[probe] error:', e); process.exit(3); });
