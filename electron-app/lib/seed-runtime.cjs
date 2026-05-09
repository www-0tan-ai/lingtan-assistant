/**
 * Lingtan Assistant — runtime side of the bundled-config story.
 *
 * Responsibilities (called from main.js during app boot):
 *   1. Locate the encrypted secrets bundle (resources/seed/secrets.enc
 *      when packaged, ../seed in dev) and decrypt it in memory.
 *   2. Ensure the user has a writable HERMES_HOME under app.userData,
 *      seeded from resources/seed/hermes-home on first launch only.
 *      User edits are preserved on subsequent launches (strategy A).
 *   3. Return:
 *        - extraEnv:           env vars to spread into spawn() for the
 *                              Python child (API keys + HERMES_HOME)
 *        - settingsPasswordHash: SHA-256 to hand to the renderer for
 *                              client-side admin-gate verification
 *        - hermesHome:         resolved HERMES_HOME path (for logging)
 *
 * The decrypted plaintext key material NEVER reaches the filesystem —
 * we pass it directly into child_process.spawn's env.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { decrypt } = require('./crypto-utils.cjs');

function _resolveSeedDir(app) {
  // Packaged build: resources/seed/...
  // Dev build:      <repo>/electron-app/seed/...
  if (app && app.isPackaged) {
    return path.join(process.resourcesPath, 'seed');
  }
  return path.join(__dirname, '..', 'seed');
}

function _copyDirRecursive(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const sp = path.join(src, entry.name);
    const dp = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      _copyDirRecursive(sp, dp);
    } else if (entry.isFile()) {
      fs.copyFileSync(sp, dp);
    }
  }
}

/**
 * Make sure HERMES_HOME exists under app.userData.  On first launch we
 * copy the seeded files in.  On subsequent launches we leave the user's
 * directory alone — user edits to config.yaml/skills/sessions/etc.
 * persist (strategy A).
 *
 * Returns the absolute HERMES_HOME path.
 */
function ensureHermesHome(seedDir, userDataDir) {
  const target = path.join(userDataDir, 'hermes-home');
  const seedSrc = path.join(seedDir, 'hermes-home');

  fs.mkdirSync(target, { recursive: true });

  // First-launch full seed: copy the entire seed/hermes-home tree
  // (config.yaml, .lingtan-seed.json, SOUL.md, ...) into userData.
  // Subsequent launches keep user edits to most files (strategy A),
  // but we always re-sync the brand identity (SOUL.md) from the seed
  // because it's a product-shipped constant -- if we leave it alone,
  // upgrading from a 0.3.x build that shipped Hermes-branded SOUL.md
  // would leave the persona stuck on the old text forever.
  const seededMarker = path.join(target, '.lingtan-seeded');
  const firstLaunch = !fs.existsSync(seededMarker);

  if (firstLaunch && fs.existsSync(seedSrc)) {
    _copyDirRecursive(seedSrc, target);
  }

  // Re-sync SOUL.md from seed on every launch so upgrading the .exe picks up
  // a new bundled persona.  Optional escape hatch for local iteration without
  // rebuilding installers: set LINGTAN_SKIP_SOUL_SEED_SYNC=1 in the environment
  // before launching Electron, then edit %APPDATA%\lingtan-assistant\hermes-home\SOUL.md
  // and restart — your edits persist across launches.
  const skipSoulSync = /^1|true|yes$/i.test(
    String(process.env.LINGTAN_SKIP_SOUL_SEED_SYNC || '').trim()
  );
  if (!skipSoulSync) {
    const soulSeed = path.join(seedSrc, 'SOUL.md');
    if (fs.existsSync(soulSeed)) {
      try {
        fs.copyFileSync(soulSeed, path.join(target, 'SOUL.md'));
      } catch (e) {
        console.warn('[seed-runtime] could not refresh SOUL.md:', e.message);
      }
    }
  }

  if (firstLaunch) {
    fs.writeFileSync(
      seededMarker,
      JSON.stringify(
        { seededAt: new Date().toISOString(), version: 2 },
        null,
        2
      )
    );
  }
  return target;
}

/**
 * @param {Electron.App} app
 * @returns {{ extraEnv: NodeJS.ProcessEnv, settingsPasswordHash: string|null,
 *             hermesHome: string, secretCount: number }}
 */
function loadSeed(app) {
  const seedDir = _resolveSeedDir(app);
  const secretsPath = path.join(seedDir, 'secrets.enc');

  let bundle = { secrets: {}, settingsPasswordHash: null };

  if (fs.existsSync(secretsPath)) {
    try {
      const blob = fs.readFileSync(secretsPath);
      const plain = decrypt(blob).toString('utf8');
      bundle = JSON.parse(plain);
    } catch (e) {
      console.error('[seed-runtime] failed to decrypt secrets.enc:', e.message);
    }
  } else {
    console.warn('[seed-runtime] no secrets.enc — running without bundled keys');
  }

  const hermesHome = ensureHermesHome(seedDir, app.getPath('userData'));

  const extraEnv = {
    HERMES_HOME: hermesHome,
    // L3 promise: the API keys live ONLY in this in-memory env block,
    // which we hand to spawn().  No .env is ever written to disk.
    ...(bundle.secrets || {}),
  };

  return {
    extraEnv,
    settingsPasswordHash: bundle.settingsPasswordHash || null,
    hermesHome,
    secretCount: Object.keys(bundle.secrets || {}).length,
  };
}

module.exports = { loadSeed };
