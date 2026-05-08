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
const { spawnSync } = require('child_process');
const { encrypt, sha256Hex } = require('../lib/crypto-utils.cjs');

const HERMES_HOME =
  process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SEED_DIR = path.join(__dirname, '..', 'seed');
const HERMES_HOME_SEED = path.join(SEED_DIR, 'hermes-home');
const AGENT_SEED = path.join(SEED_DIR, 'hermes-agent');
const PYDEPS_SEED = path.join(SEED_DIR, 'python-deps');
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

// ──────────────────────────────────────────────────────────────────────
// Agent source vendoring.
//
// hermes-webui's `from run_agent import AIAgent` probe and the agent
// dir discovery logic both demand a directory that contains
// `run_agent.py` plus the rest of the agent package tree.  We are
// shipping that subtree as a sibling of resources/hermes-webui inside
// the .exe — see package.json -> build.extraResources.
//
// `INCLUDE_TOPLEVEL_PY` mirrors the agent's own pyproject.toml
// `tool.setuptools.py-modules`, which is the canonical list of single-
// file Python modules we have to ship for the agent to import cleanly.
// `INCLUDE_DIRS` mirrors the `tool.setuptools.packages.find.include`
// list with one carve-out: gateway/tui_gateway/plugins are not on the
// chat path and skipping them shaves ~9 MB off the .exe.
// ──────────────────────────────────────────────────────────────────────

const INCLUDE_TOPLEVEL_PY = [
  'run_agent.py',
  'model_tools.py',
  'toolsets.py',
  'cli.py',
  'hermes_constants.py',
  'hermes_state.py',
  'hermes_time.py',
  'hermes_logging.py',
  'utils.py',
  'toolset_distributions.py',
  'trajectory_compressor.py',
  'mcp_serve.py',
  'batch_runner.py',
];

const INCLUDE_DIRS = [
  'agent',
  'tools',
  'hermes_cli',
  'providers',
  'cron',
  'acp_adapter',
  'skills', // bundled skills the agent loads at runtime
];

const SKIP_NAMES = new Set([
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.ty_cache',
  '.git',
  'node_modules',
  'tests',  // every package-level tests/ dir is dev-only
]);

function copyTreeFiltered(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP_NAMES.has(entry.name)) continue;
    const sp = path.join(src, entry.name);
    const dp = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyTreeFiltered(sp, dp);
    } else if (entry.isFile()) {
      // Skip Python build artefacts and editor backups.
      if (
        entry.name.endsWith('.pyc') ||
        entry.name.endsWith('.pyo') ||
        entry.name.endsWith('~') ||
        entry.name === '.DS_Store'
      ) {
        continue;
      }
      fs.copyFileSync(sp, dp);
    }
  }
}

function vendorAgentSource() {
  console.log('[seed] vendoring agent source from', REPO_ROOT);
  rmrf(AGENT_SEED);
  fs.mkdirSync(AGENT_SEED, { recursive: true });

  let copiedFiles = 0;
  for (const name of INCLUDE_TOPLEVEL_PY) {
    const src = path.join(REPO_ROOT, name);
    if (!fs.existsSync(src)) {
      console.warn(`[seed]   skip missing top-level: ${name}`);
      continue;
    }
    fs.copyFileSync(src, path.join(AGENT_SEED, name));
    copiedFiles += 1;
  }
  for (const dir of INCLUDE_DIRS) {
    const src = path.join(REPO_ROOT, dir);
    if (!fs.existsSync(src)) {
      console.warn(`[seed]   skip missing dir: ${dir}/`);
      continue;
    }
    copyTreeFiltered(src, path.join(AGENT_SEED, dir));
  }

  // Drop a synthetic .env-stub so the agent's load_dotenv calls can
  // open ${HERMES_WEBUI_AGENT_DIR}/.env without a "file not found"
  // error.  Empty stub: we inject the real keys via env vars at spawn
  // time (the L3 promise) and python-dotenv's override=True only
  // overwrites os.environ values that the .env explicitly sets.
  fs.writeFileSync(
    path.join(AGENT_SEED, '.env'),
    '# Lingtan Assistant: real keys come from the parent process env.\n',
    'utf8'
  );

  console.log(`[seed] hermes-agent/ vendored: ${copiedFiles} top-level + ${INCLUDE_DIRS.length} packages`);
}

// ──────────────────────────────────────────────────────────────────────
// Python dependency vendoring (pip install --target).
//
// We pin to a hand-curated subset of the agent's pyproject.toml
// dependencies that's actually exercised on the chat path.  Heavy
// optional extras (matrix, voice, tinker, etc.) are intentionally
// excluded — including them inflates the .exe by 100+ MB for features
// the desktop user isn't going to touch.
// ──────────────────────────────────────────────────────────────────────

const PIP_REQUIREMENTS = [
  'openai>=2.21.0,<3',
  'anthropic>=0.39.0,<1',
  'python-dotenv>=1.2.1,<2',
  'fire>=0.7.1,<1',
  'httpx[socks]>=0.28.1,<1',
  'rich>=14.3.3,<15',
  'tenacity>=9.1.4,<10',
  'pyyaml>=6.0.2,<7',
  'requests>=2.33.0,<3',
  'jinja2>=3.1.5,<4',
  'pydantic>=2.12.5,<3',
  'prompt_toolkit>=3.0.52,<4',
  'croniter>=6.0.0,<7',
  'PyJWT[crypto]>=2.12.0,<3',
];

function vendorPythonDeps({ force = false } = {}) {
  // Skip-if-fresh: vendoring is expensive (~80s download + extract)
  // and the requirements list rarely changes between dev iterations.
  // Bump the marker version to force re-vendoring.
  const markerVersion = 1;
  const marker = path.join(PYDEPS_SEED, '.lingtan-pydeps.json');
  if (!force && fs.existsSync(marker)) {
    try {
      const meta = JSON.parse(fs.readFileSync(marker, 'utf8'));
      if (meta.version === markerVersion) {
        console.log(`[seed] python-deps/ already up to date (version ${meta.version}) — skipping pip install`);
        return;
      }
    } catch { /* fall through and rebuild */ }
  }

  console.log('[seed] vendoring Python dependencies (pip install --target) — this may take a minute...');
  rmrf(PYDEPS_SEED);
  fs.mkdirSync(PYDEPS_SEED, { recursive: true });

  // Prefer system python on PATH; fall back to py launcher on Windows.
  const pythonExe =
    process.env.LINGTAN_PYTHON ||
    (process.platform === 'win32' ? 'python' : 'python3');

  const args = [
    '-m', 'pip', 'install',
    '--target', PYDEPS_SEED,
    '--no-cache-dir',
    '--disable-pip-version-check',
    '--upgrade',
    ...PIP_REQUIREMENTS,
  ];

  const result = spawnSync(pythonExe, args, {
    stdio: 'inherit',
    shell: false,
  });

  if (result.status !== 0) {
    throw new Error(
      `pip install failed (exit ${result.status}). ` +
        'Ensure Python 3.11+ is on PATH or set LINGTAN_PYTHON to a working interpreter.'
    );
  }

  // Strip pyc / dist-info bloat that pip leaves behind — saves a few MB
  // and avoids OS-specific .so / .pyd entries we don't run anyway.
  let purged = 0;
  function purge(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__pycache__' || entry.name.endsWith('.dist-info')) {
          // Keep top-level dist-info METADATA for license auditing but
          // strip everything else.  Cheap heuristic: if the dist-info
          // has more than just METADATA, scrub the rest.
          if (entry.name === '__pycache__') {
            fs.rmSync(p, { recursive: true, force: true });
            purged += 1;
            continue;
          }
        }
        purge(p);
      } else if (entry.isFile() && (entry.name.endsWith('.pyc') || entry.name.endsWith('.pyo'))) {
        fs.unlinkSync(p);
        purged += 1;
      }
    }
  }
  purge(PYDEPS_SEED);

  fs.writeFileSync(
    marker,
    JSON.stringify(
      {
        version: markerVersion,
        builtAt: new Date().toISOString(),
        requirements: PIP_REQUIREMENTS,
      },
      null,
      2
    )
  );
  console.log(`[seed] python-deps/ vendored (purged ${purged} cache files)`);
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
  const force = process.argv.includes('--force');
  console.log(`[seed] HERMES_HOME = ${HERMES_HOME}`);
  console.log(`[seed] REPO_ROOT   = ${REPO_ROOT}`);

  // We deliberately don't rmrf the whole SEED_DIR — python-deps/ is
  // expensive to rebuild and we cache it across runs.  We do clear the
  // pieces we always rebuild (secrets, hermes-home, hermes-agent).
  rmrf(SECRETS_OUT);
  rmrf(HERMES_HOME_SEED);
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

  // ── 4. agent source vendoring ──────────────────────────────────────
  vendorAgentSource();

  // ── 5. Python deps vendoring (cached) ──────────────────────────────
  vendorPythonDeps({ force });

  console.log('[seed] done.');
}

if (require.main === module) {
  main();
}
