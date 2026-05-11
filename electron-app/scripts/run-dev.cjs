#!/usr/bin/env node
/**
 * Dev entry: optional env files, then spawn Electron with LINGTAN_DEV=1.
 *
 *   1. Loads electron-app/.env.dev if present (KEY=value, # comments).
 *   2. If LINGTAN_DEV_ENV_FILE is set, loads that file too (relative paths
 *      resolve from electron-app/). Later file wins on duplicate keys.
 *   3. Sets LINGTAN_DEV=1 for the child process.
 *
 * Example .env.dev:
 *   LINGTAN_LOG_MODEL_CALL=1
 *   HERMES_HOME=C:\\Users\\you\\.hermes
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');

function parseEnvFile(content) {
  const out = {};
  for (let line of content.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

function loadEnvFile(p) {
  if (!fs.existsSync(p)) return;
  try {
    const parsed = parseEnvFile(fs.readFileSync(p, 'utf8'));
    Object.assign(process.env, parsed);
    console.log('[run-dev] loaded env file:', p);
  } catch (e) {
    console.warn('[run-dev] failed to load', p, e && e.message);
  }
}

function loadDevEnvFiles() {
  loadEnvFile(path.join(root, '.env.dev'));
  const extra = (process.env.LINGTAN_DEV_ENV_FILE || '').trim();
  if (extra) {
    const p = path.isAbsolute(extra) ? extra : path.join(root, extra);
    loadEnvFile(p);
  }
}

loadDevEnvFiles();
process.env.LINGTAN_DEV = '1';

const electron = require('electron');
const child = spawn(electron, ['.'], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
});
child.on('close', (code) => process.exit(code == null ? 0 : code));
