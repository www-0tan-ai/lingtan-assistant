#!/usr/bin/env node
/**
 * Lingtan Assistant — build-time seed packer.
 *
 * Reads sensitive material from the developer machine's local Hermes
 * checkout and packages it for the .exe build:
 *
 *   ~/.hermes/.env          -> seed/secrets.enc      (encrypted, AES-256-GCM)
 *   ~/.hermes/config.yaml   -> seed/hermes-home/config.yaml  (plaintext, NO secrets)
 *
 * Run as `npm run seed` (chained automatically before `npm run dist`).
 *
 * Optional inputs (env vars):
 *   LINGTAN_SETTINGS_PASSWORD   default: "lingtan2026"
 *                                The password the end-user types to unlock
 *                                the in-app settings panel.  Only its
 *                                SHA-256 is bundled.
 *   HERMES_HOME                  source of truth for .env / config.yaml
 *                                if your local hermes lives somewhere
 *                                other than ~/.hermes.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { encrypt, sha256Hex } = require('../lib/crypto-utils.cjs');

const HERMES_HOME =
  process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
const SEED_DIR = path.join(__dirname, '..', 'seed');
const HERMES_HOME_SEED = path.join(SEED_DIR, 'hermes-home');
const SECRETS_OUT = path.join(SEED_DIR, 'secrets.enc');

const SETTINGS_PASSWORD =
  process.env.LINGTAN_SETTINGS_PASSWORD || 'lingtan2026';

function rmrf(p) {
  if (!fs.existsSync(p)) return;
  fs.rmSync(p, { recursive: true, force: true });
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function parseEnvFile(text) {
  // Mirror python-dotenv's permissive parsing: "KEY=VALUE", supports
  // # comments, blank lines, optional `export ` prefix, and surrounding
  // single/double quotes around the value.
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[m[1]] = val;
  }
  return out;
}

// We bundle every key the dev has in ~/.hermes/.env, but strip out a few
// that should obviously never travel between machines.
const SKIP_KEYS = new Set([
  'PYTHONUTF8',
  'PYTHONIOENCODING',
  'TERMINAL_TIMEOUT',
  'TERMINAL_LIFETIME_SECONDS',
  'WEB_TOOLS_DEBUG',
  'VISION_TOOLS_DEBUG',
  'MOA_TOOLS_DEBUG',
  'IMAGE_TOOLS_DEBUG',
]);

function buildSecretsBundle() {
  const envPath = path.join(HERMES_HOME, '.env');
  if (!fs.existsSync(envPath)) {
    console.warn(`[seed] WARNING: ${envPath} not found — bundle will contain no secrets.`);
    return { secrets: {}, count: 0 };
  }
  const parsed = parseEnvFile(fs.readFileSync(envPath, 'utf8'));
  const secrets = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (SKIP_KEYS.has(k)) continue;
    secrets[k] = v;
  }
  return { secrets, count: Object.keys(secrets).length };
}

function readConfigYamlSanitized() {
  const cfgPath = path.join(HERMES_HOME, 'config.yaml');
  if (!fs.existsSync(cfgPath)) {
    return null;
  }
  // We ship the user's config.yaml verbatim because it does not, by
  // convention, contain secrets — secrets live in .env.  If you ever
  // start storing keys in config.yaml, add a sanitizer here.
  return fs.readFileSync(cfgPath, 'utf8');
}

function main() {
  console.log(`[seed] HERMES_HOME = ${HERMES_HOME}`);
  rmrf(SEED_DIR);
  ensureDir(SEED_DIR);
  ensureDir(HERMES_HOME_SEED);

  // ── 1. encrypted secrets ───────────────────────────────────────────
  const { secrets, count } = buildSecretsBundle();
  const bundle = {
    v: 1,
    builtAt: new Date().toISOString(),
    builtOn: os.hostname(),
    secrets,
    settingsPasswordHash: sha256Hex(SETTINGS_PASSWORD),
  };
  const blob = encrypt(JSON.stringify(bundle));
  fs.writeFileSync(SECRETS_OUT, blob);
  console.log(
    `[seed] secrets.enc written: ${count} key(s), ${blob.length} bytes ` +
      `(plaintext password: ${SETTINGS_PASSWORD})`
  );

  // ── 2. plaintext seed for HERMES_HOME ──────────────────────────────
  const cfg = readConfigYamlSanitized();
  if (cfg !== null) {
    const out = path.join(HERMES_HOME_SEED, 'config.yaml');
    fs.writeFileSync(out, cfg, 'utf8');
    console.log(`[seed] hermes-home/config.yaml written (${cfg.length} bytes)`);
  } else {
    // Fallback minimal config so the agent still has *something* to read.
    const fallback = [
      'model:',
      '  provider: openai',
      '  default: gpt-4o-mini',
      'onboarding:',
      '  seen:',
      '    busy_input_prompt: true',
      '    openclaw_residue_cleanup: true',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(HERMES_HOME_SEED, 'config.yaml'), fallback);
    console.log('[seed] hermes-home/config.yaml: fallback minimal config used');
  }

  // Mark onboarding as already-seen so first-run flow is skipped — the
  // user "installs and just chats", per requirement #1.
  const stateMarker = {
    onboardingComplete: true,
    seededBy: 'lingtan build-seed',
    seededAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(HERMES_HOME_SEED, '.lingtan-seed.json'),
    JSON.stringify(stateMarker, null, 2)
  );
  console.log('[seed] .lingtan-seed.json marker written');

  console.log('[seed] done.');
}

if (require.main === module) {
  main();
}
