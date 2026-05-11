#!/usr/bin/env node
/**
 * Lingtan: remove Hermes WebUI sidebar "Insights" (中文界面显示为「统计」) and
 * related panel / main view / settings sync toggle.
 *
 * `hermes-webui/` is typically gitignored (cloned upstream). This runs before
 * `build-seed.cjs` on every `npm run dist` so packaged builds stay consistent.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const INDEX = path.join(REPO_ROOT, 'hermes-webui', 'static', 'index.html');
const PANELS = path.join(REPO_ROOT, 'hermes-webui', 'static', 'panels.js');
const STYLE = path.join(REPO_ROOT, 'hermes-webui', 'static', 'style.css');

const SLIM_CHAT_CHROME_MARKER = '/* lingtan-slim-chat-chrome';
const SLIM_CHAT_CHROME_CSS = `

/* lingtan-slim-chat-chrome — Lingtan Assistant: hide sidebar project strip (All / Unassigned / +)
   and the bottom composer controls row (profile, workspace, model, reasoning, toolsets, mic). */
#sessionList .project-bar{display:none!important;}
.composer-box #micStatus,.composer-box #voiceModeBar{display:none!important;}
.composer-footer .composer-left #btnMic,
.composer-footer .composer-left #btnVoiceMode,
.composer-footer .composer-left .composer-divider,
.composer-footer .composer-left #yoloPill,
.composer-footer .composer-left .composer-profile-wrap,
.composer-footer .composer-left .composer-ws-wrap,
.composer-footer .composer-model-wrap,
.composer-footer #composerReasoningWrap,
.composer-footer #composerToolsetsWrap,
.composer-footer #composerMobileConfigBtn,
.composer-footer #composerMobileConfigPanel{display:none!important;}
`;

function main() {
  if (fs.existsSync(STYLE)) {
    let css = fs.readFileSync(STYLE, 'utf8');
    if (!css.includes(SLIM_CHAT_CHROME_MARKER)) {
      css += SLIM_CHAT_CHROME_CSS;
      fs.writeFileSync(STYLE, css, 'utf8');
      console.log('[lingtan-webui] appended slim chat chrome rules to style.css');
    } else {
      console.log('[lingtan-webui] slim chat chrome CSS already present — skip style.css');
    }
  } else {
    console.warn('[lingtan-webui] style.css missing — skip slim chat chrome patch');
  }

  if (!fs.existsSync(INDEX) || !fs.existsSync(PANELS)) {
    console.warn('[lingtan-webui] hermes-webui/static missing — skip Lingtan UI patches');
    return;
  }

  let html = fs.readFileSync(INDEX, 'utf8');
  if (!html.includes('data-panel="insights"') && !html.includes('id="settingsSyncInsights"')) {
    console.log('[lingtan-webui] insights UI already removed — skip index.html');
  } else {
    html = html.replace(
      /<button class="rail-btn nav-tab has-tooltip" data-panel="insights"[\s\S]*?<\/button>\s*\r?\n/g,
      '',
    );
    html = html.replace(
      /<button class="nav-tab has-tooltip has-tooltip--bottom" data-panel="insights"[\s\S]*?<\/button>\s*\r?\n/g,
      '',
    );

    const insPanel = html.indexOf('<!-- Insights panel -->');
    const wsPanel = html.indexOf('<!-- Workspaces panel -->', insPanel);
    if (insPanel !== -1 && wsPanel !== -1) {
      html = html.slice(0, insPanel) + html.slice(wsPanel);
    }

    const mainIns = html.indexOf('<div id="mainInsights"');
    const mainLogs = html.indexOf('<div id="mainLogs"', mainIns);
    if (mainIns !== -1 && mainLogs !== -1) {
      html = html.slice(0, mainIns) + html.slice(mainLogs);
    }

    html = html.replace(
      /<div class="settings-field">\s*<label style="display:flex;align-items:center;gap:8px;cursor:pointer">\s*<input type="checkbox" id="settingsSyncInsights"[^>]*>\s*<span data-i18n="settings_label_sync_insights">[\s\S]*?<\/span>\s*<\/label>\s*<div[^>]*data-i18n="settings_desc_sync_insights"[^>]*>[\s\S]*?<\/div>\s*<\/div>\s*/g,
      '',
    );

    fs.writeFileSync(INDEX, html, 'utf8');
    console.log('[lingtan-webui] patched index.html (removed Insights / 统计)');
  }

  let js = fs.readFileSync(PANELS, 'utf8');
  if (!js.includes("insights: 'tab_insights'") && !js.includes("const nextPanel = name || 'chat'")) {
    console.log('[lingtan-webui] panels.js already patched — skip');
    return;
  }

  js = js.replace(
    "  profiles: 'tab_profiles', todos: 'tab_todos', insights: 'tab_insights', logs: 'tab_logs', settings: 'tab_settings',",
    "  profiles: 'tab_profiles', todos: 'tab_todos', logs: 'tab_logs', settings: 'tab_settings',",
  );
  js = js.replace(
    /async function switchPanel\(name, opts = \{\}\) \{\r?\n  const nextPanel = name \|\| 'chat';/,
    "async function switchPanel(name, opts = {}) {\n  let nextPanel = name || 'chat';\n  if (nextPanel === 'insights') nextPanel = 'chat';",
  );
  js = js.replace(
    "['settings','skills','memory','tasks','kanban','workspaces','profiles','insights','logs']",
    "['settings','skills','memory','tasks','kanban','workspaces','profiles','logs']",
  );
  js = js.replace(/\r?\n  if \(nextPanel === 'insights'\) await loadInsights\(\);\r?\n/, '\n');
  fs.writeFileSync(PANELS, js, 'utf8');
  console.log('[lingtan-webui] patched panels.js');
}

main();
