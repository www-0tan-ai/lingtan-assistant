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

  // First-launch detection: marker file we drop into target after seeding.
  const seededMarker = path.join(target, '.lingtan-seeded');
  if (fs.existsSync(seededMarker)) {
    return target;
  }

  if (fs.existsSync(seedSrc)) {
    _copyDirRecursive(seedSrc, target);
  }

  fs.writeFileSync(
    seededMarker,
    JSON.stringify(
      { seededAt: new Date().toISOString(), version: 1 },
      null,
      2
    )
  );
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
