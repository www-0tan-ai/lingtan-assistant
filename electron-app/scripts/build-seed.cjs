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
const {
  LINGTAN_NO_KEYS_YAML_BANNER,
  neutralizeModelProviderWhenNoSecrets,
} = require('../lib/lingtan-zero-keys-config.cjs');
const { vendorPythonEmbed } = require('./vendor-python-embed.cjs');

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
// list with one carve-out: tui_gateway / plugins are not on the chat
// path and skipping them shaves ~5 MB off the .exe.
//
// gateway/ is a special case.  We do NOT ship the full package (the
// platform adapters under gateway/platforms/ pull in heavy deps —
// telethon / discord.py / slack_sdk / matrix-nio — that the desktop
// chat surface never exercises).  But agent/prompt_builder.py and
// several tools/*.py modules lazily do `from gateway.session_context
// import get_session_env` on the chat path, so we synthesize a
// minimal gateway/ subpackage in the seed: an empty __init__.py
// (suppresses gateway/__init__.py's eager config/session/delivery
// imports) plus the real session_context.py (stdlib-only, no deps).
// See `vendorGatewayStub()` below.
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

  vendorGatewayStub();
}

// Minimal gateway/ subpackage so that
// `from gateway.session_context import get_session_env` resolves.
// We deliberately ship an empty __init__.py instead of the upstream one
// (which eagerly imports config/session/delivery — extra surface we
// don't need on the desktop chat path).  session_context.py itself is
// stdlib-only, so no extra runtime deps are required.
function vendorGatewayStub() {
  const dst = path.join(AGENT_SEED, 'gateway');
  fs.mkdirSync(dst, { recursive: true });
  fs.writeFileSync(
    path.join(dst, '__init__.py'),
    '# Lingtan Assistant: minimal gateway stub.\n' +
      '# The desktop chat surface only needs gateway.session_context,\n' +
      '# so we suppress the upstream package __init__ to avoid pulling\n' +
      '# config/session/delivery and their messaging-platform deps.\n',
    'utf8'
  );
  const sessionCtxSrc = path.join(REPO_ROOT, 'gateway', 'session_context.py');
  if (!fs.existsSync(sessionCtxSrc)) {
    throw new Error(
      `[seed] gateway/session_context.py missing at ${sessionCtxSrc} — ` +
        `cannot vendor minimal gateway stub.`
    );
  }
  fs.copyFileSync(
    sessionCtxSrc,
    path.join(dst, 'session_context.py')
  );
  console.log('[seed]   + gateway/ stub (__init__.py + session_context.py)');
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
  // v2 (2026-05-09): pin pip to cp311-win_amd64 wheels so the vendored
  // pydantic-core / yaml / brotli native extensions match the bundled
  // embeddable Python 3.11.9 ABI.  v1 was built against whatever Python
  // was on PATH at the time (cp314 on this dev box), which produced
  // `_pydantic_core.cp314-win_amd64.pyd` and made `from openai import
  // OpenAI` raise `ModuleNotFoundError: pydantic_core._pydantic_core`
  // on the user's machine.
  const markerVersion = 2;
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

  // Force pip to resolve wheels for the embed Python's exact ABI
  // (cp311 / win_amd64).  Without these flags, pip uses the host
  // Python's tag and happily downloads cp314 wheels for pydantic-core
  // et al., which the bundled 3.11 embed cannot dlopen.
  // `--only-binary=:all:` rejects sdists outright so we never fall
  // through to a build that compiles against the host Python.
  const args = [
    '-m', 'pip', 'install',
    '--target', PYDEPS_SEED,
    '--no-cache-dir',
    '--disable-pip-version-check',
    '--upgrade',
    '--python-version', '3.11',
    '--platform', 'win_amd64',
    '--abi', 'cp311',
    '--implementation', 'cp',
    '--only-binary=:all:',
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

function stampWebuiVersion() {
  const apiDir = path.join(REPO_ROOT, 'hermes-webui', 'api');
  if (!fs.existsSync(apiDir)) {
    console.warn(`[seed] hermes-webui/api/ missing at ${apiDir} — skipping _version.py stamp`);
    return;
  }
  const pkgJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
  );
  const version = `lingtan-${pkgJson.version}-${Date.now()}`;
  const body = [
    '"""Auto-generated build stamp written by Lingtan Assistant build-seed.',
    '',
    'Used by api.updates._detect_webui_version() when the packaged dist has no',
    '.git directory — without it WEBUI_VERSION resolves to "unknown" and the',
    'browser Service Worker (sw.js) keys its cache on a constant string,',
    'silently serving stale CSS/JS to end users across upgrades.',
    '"""',
    `__version__ = '${version}'`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(apiDir, '_version.py'), body, 'utf8');
  console.log(`[seed] wrote hermes-webui/api/_version.py = ${version}`);
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
  // Bundled desktop default: prefer repo asset so you can pin model + api_key
  // in one file. Remove assets/hermes-home/config.yaml to fall back to
  // HERMES_HOME/config.yaml again.
  const assetCfg = path.join(__dirname, '..', 'assets', 'hermes-home', 'config.yaml');
  if (fs.existsSync(assetCfg)) {
    console.log('[seed] hermes-home/config.yaml source: assets/hermes-home/config.yaml');
    return fs.readFileSync(assetCfg, 'utf8');
  }
  const cfgPath = path.join(HERMES_HOME, 'config.yaml');
  if (!fs.existsSync(cfgPath)) {
    return null;
  }
  console.log('[seed] hermes-home/config.yaml source:', cfgPath);
  return fs.readFileSync(cfgPath, 'utf8');
}

/**
 * Fail the build early when the bundled config pins a provider but the
 * corresponding API key is missing from HERMES_HOME/.env (avoids installers
 * that "work" until the first chat message).
 */
function validateBundledKeysForSeedConfig(cfgText, secrets, hermesHome) {
  if (!cfgText || typeof cfgText !== 'string' || !secrets || typeof secrets !== 'object') {
    return;
  }
  const has = (k) => Boolean(secrets[k] && String(secrets[k]).trim());
  const envHint = path.join(hermesHome, '.env');
  // Root `model:` block is always near the top of our seed YAML; keep this heuristic simple.
  if (/model:\s*[\s\S]*?provider:\s*deepseek\b/.test(cfgText) && !has('DEEPSEEK_API_KEY')) {
    throw new Error(
      `[seed] model.provider is deepseek but DEEPSEEK_API_KEY is missing from bundled secrets.\n` +
        `  Add DEEPSEEK_API_KEY=... to ${envHint} then rebuild (npm run seed / npm run dist).`
    );
  }
  if (/model:\s*[\s\S]*?provider:\s*azure-foundry\b/.test(cfgText) && !has('AZURE_FOUNDRY_API_KEY')) {
    throw new Error(
      `[seed] model.provider is azure-foundry but AZURE_FOUNDRY_API_KEY is missing from bundled secrets.\n` +
        `  Add AZURE_FOUNDRY_API_KEY=... to ${envHint} then rebuild.`
    );
  }
}

async function main() {
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
  // Hard-fail on accidental zero-key builds.  Every desktop release is
  // expected to ship the developer's API keys baked in (that's the
  // whole point of "open the .exe and it just chats").  A 0-key
  // build looks fine in the installer but explodes the moment the
  // user sends a message with `RuntimeError: Provider 'deepseek' /
  // 'azure-foundry' is set in config.yaml but no API key was found`.  This guard
  // caught a real regression where a stray HERMES_HOME export from a
  // smoke test pointed build-seed at an empty temp dir.
  // Use --allow-empty-secrets if you genuinely want a bring-your-own
  // -key build (e.g. for distribution to a different account).
  const allowEmpty = process.argv.includes('--allow-empty-secrets');
  if (count === 0 && !allowEmpty) {
    const envPath = path.join(HERMES_HOME, '.env');
    throw new Error(
      `[seed] refusing to build with 0 bundled API keys.\n` +
        `  HERMES_HOME = ${HERMES_HOME}\n` +
        `  .env path   = ${envPath} (${fs.existsSync(envPath) ? 'exists' : 'MISSING'})\n` +
        `  This usually means HERMES_HOME is pointing at the wrong directory.\n` +
        `  Unset stale HERMES_HOME env vars (echo $HERMES_HOME), or pass\n` +
        `  --allow-empty-secrets if a key-less build is what you actually want.`
    );
  }

  const cfg = readConfigYamlSanitized();
  if (count > 0) {
    validateBundledKeysForSeedConfig(cfg, secrets, HERMES_HOME);
  }

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
  const outCfgPath = path.join(HERMES_HOME_SEED, 'config.yaml');
  if (cfg !== null) {
    let cfgOut = cfg;
    if (count === 0) {
      cfgOut = neutralizeModelProviderWhenNoSecrets(cfg);
      console.log(
        '[seed] 0 bundled keys — adjusted config.yaml (root model.provider → auto if it was pinned)',
      );
    }
    fs.writeFileSync(outCfgPath, cfgOut, 'utf8');
    console.log(`[seed] hermes-home/config.yaml written (${cfgOut.length} bytes)`);
  } else {
    // Fallback minimal config so the agent still has *something* to read.
    // With no bundled keys, `openai` would fail the same way as azure-foundry;
    // `auto` routes through the normal resolver and surfaces a generic prompt.
    const fallback =
      count === 0
        ? [
            LINGTAN_NO_KEYS_YAML_BANNER.trimEnd(),
            'model:',
            '  provider: auto',
            '  default: openai/gpt-5.4-mini',
            'onboarding:',
            '  seen:',
            '    busy_input_prompt: true',
            '    openclaw_residue_cleanup: true',
            '',
          ].join('\n')
        : [
            'model:',
            '  provider: openai',
            '  default: gpt-4o-mini',
            'onboarding:',
            '  seen:',
            '    busy_input_prompt: true',
            '    openclaw_residue_cleanup: true',
            '',
          ].join('\n');
    fs.writeFileSync(outCfgPath, fallback, 'utf8');
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

  // ── 3. Lingtan persona (SOUL.md) ───────────────────────────────────
  // Hermes loads HERMES_HOME/SOUL.md as system-prompt slot #1.  By
  // baking the 灵碳云智 persona in here, the seeded HERMES_HOME on
  // first launch already has the correct identity and the model never
  // gets to fall back to DEFAULT_AGENT_IDENTITY (which still mentions
  // "Hermes Agent" and "Nous Research").
  const soulSrc = path.join(__dirname, '..', 'assets', 'soul.lingtan.md');
  const soulDst = path.join(HERMES_HOME_SEED, 'SOUL.md');
  if (fs.existsSync(soulSrc)) {
    fs.copyFileSync(soulSrc, soulDst);
    console.log(`[seed] SOUL.md (Lingtan persona) bundled (${fs.statSync(soulDst).size} bytes)`);
  } else {
    console.warn(`[seed] WARNING: ${soulSrc} not found — packaged build will NOT have Lingtan persona`);
  }

  // ── 4. agent source vendoring ──────────────────────────────────────
  vendorAgentSource();

  // ── 4b. Windows embeddable Python (packaged .exe — no system install) ──
  await vendorPythonEmbed({ force, seedDir: SEED_DIR });

  // ── 5. Python deps vendoring (cached) ──────────────────────────────
  vendorPythonDeps({ force });

  // ── 6. WebUI build-version stamp ───────────────────────────────────
  // The packaged dist contains no .git, so api/updates.py:
  // _detect_webui_version() falls back to api/_version.py and (failing
  // that) returns 'unknown'.  Service Worker (sw.js) keys its cache on
  // that string, so two consecutive builds end up with cache key
  // `hermes-shell-unknown` and the user is permanently stuck on the
  // first style.css/index.html ever cached.  We write a fresh
  // _version.py per build so the SW cache invalidates and our CSS /
  // HTML edits actually reach the browser.
  stampWebuiVersion();

  console.log('[seed] done.');
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[seed] fatal:', e && e.stack ? e.stack : e);
    process.exit(1);
  });
}
