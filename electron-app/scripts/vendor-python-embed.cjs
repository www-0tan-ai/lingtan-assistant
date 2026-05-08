#!/usr/bin/env node
/**
 * Download the official Windows embeddable CPython zip and unpack it into
 * seed/python-embed/ so packaged Lingtan builds ship a zero-setup interpreter.
 *
 * Only runs on win32.  Other platforms keep using system Python in dev.
 *
 * See: https://docs.python.org/3/using/windows.html#the-embeddable-package
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawnSync } = require('child_process');

const PYTHON_EMBED_VERSION = process.env.LINGTAN_PYTHON_EMBED_VERSION || '3.11.9';
const MARKER_NAME = '.lingtan-python-embed.json';

function rmrf(p) {
  if (!fs.existsSync(p)) return;
  fs.rmSync(p, { recursive: true, force: true });
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function downloadToFile(url, dest, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 8) {
      reject(new Error('too many HTTP redirects'));
      return;
    }
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, url).href;
        res.resume();
        downloadToFile(next, dest, redirectCount + 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', reject);
    });
    req.on('error', reject);
  });
}

function unzip(zipPath, destDir) {
  ensureDir(destDir);
  // Windows 10+ ships bsdtar that understands zip.
  let r = spawnSync('tar', ['-xf', zipPath, '-C', destDir], {
    stdio: 'inherit',
    windowsHide: true,
    shell: false,
  });
  if (r.status === 0) return true;

  const ps = [
    'Expand-Archive',
    '-LiteralPath',
    zipPath,
    '-DestinationPath',
    destDir,
    '-Force',
  ].join(' ');
  r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    stdio: 'inherit',
    windowsHide: true,
  });
  return r.status === 0;
}

function enableImportSite(embedRoot) {
  const entries = fs.readdirSync(embedRoot, { withFileTypes: true });
  const pth = entries.find((e) => e.isFile() && /^python\d+\._pth$/i.test(e.name));
  if (!pth) {
    console.warn('[python-embed] no python*. _pth file found — site may be disabled');
    return;
  }
  const pthPath = path.join(embedRoot, pth.name);
  let text = fs.readFileSync(pthPath, 'utf8');
  // Uncomment `#import site` (all common spellings in official zips).
  const next = text
    .replace(/^#\s*import\s+site\s*$/im, 'import site')
    .replace(/^#\s*import\s+site\s*;/im, 'import site');
  if (next !== text) {
    fs.writeFileSync(pthPath, next, 'utf8');
    console.log(`[python-embed] enabled import site in ${pth.name}`);
  } else if (!/^import\s+site\s*$/m.test(text)) {
    fs.appendFileSync(pthPath, '\r\nimport site\r\n', 'utf8');
    console.log(`[python-embed] appended import site to ${pth.name}`);
  }
}

/**
 * Drop a sitecustomize.py into the embed root so that PYTHONPATH (and
 * an explicit LINGTAN_PYPATH list passed by main.js) get appended to
 * sys.path. The official ._pth file fully governs sys.path and
 * deliberately ignores PYTHONPATH; without this hook the spawned
 * server.py cannot see hermes-webui / hermes-agent / vendored deps and
 * dies with `ModuleNotFoundError: No module named 'api'`.
 */
function writeSiteCustomize(embedRoot) {
  const dst = path.join(embedRoot, 'sitecustomize.py');
  const body = [
    '"""Lingtan Assistant: restore PYTHONPATH for embeddable Python."""',
    'import os',
    'import sys',
    '',
    'def _add(p):',
    '    if p and p not in sys.path:',
    '        sys.path.insert(0, p)',
    '',
    '# 1) LINGTAN_PYPATH = ordered list, highest priority first.',
    "for _p in (os.environ.get('LINGTAN_PYPATH') or '').split(os.pathsep):",
    '    _add(_p)',
    '',
    '# 2) Standard PYTHONPATH (embed _pth ignores it otherwise).',
    "for _p in (os.environ.get('PYTHONPATH') or '').split(os.pathsep):",
    '    _add(_p)',
    '',
  ].join('\r\n');
  fs.writeFileSync(dst, body, 'utf8');
  console.log('[python-embed] wrote sitecustomize.py for PYTHONPATH bridge');
}

/**
 * @param {{ force?: boolean, seedDir: string }} opts
 */
function vendorPythonEmbed(opts) {
  const { force = false, seedDir } = opts;
  if (process.platform !== 'win32') {
    console.log('[python-embed] skip (not Windows)');
    return;
  }

  const dest = path.join(seedDir, 'python-embed');
  const markerPath = path.join(seedDir, MARKER_NAME);
  const markerVersion = 1;

  if (!force && fs.existsSync(path.join(dest, 'python.exe'))) {
    try {
      const meta = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      if (
        meta.version === markerVersion &&
        meta.python === PYTHON_EMBED_VERSION
      ) {
        console.log(
          `[python-embed] seed/python-embed/ already present (${PYTHON_EMBED_VERSION}) — skip`
        );
        return;
      }
    } catch {
      /* rebuild */
    }
  }

  const zipName = `python-${PYTHON_EMBED_VERSION}-embed-amd64.zip`;
  const url = `https://www.python.org/ftp/python/${PYTHON_EMBED_VERSION}/${zipName}`;
  const tmpZip = path.join(seedDir, `.tmp-${zipName}`);

  console.log(`[python-embed] downloading ${url} …`);
  ensureDir(seedDir);
  rmrf(dest);
  if (fs.existsSync(tmpZip)) fs.unlinkSync(tmpZip);

  return downloadToFile(url, tmpZip)
    .then(() => {
      console.log('[python-embed] unpacking …');
      if (!unzip(tmpZip, dest)) {
        throw new Error('failed to unzip embeddable Python');
      }
      try {
        fs.unlinkSync(tmpZip);
      } catch {
        /* ignore */
      }
      const pyExe = path.join(dest, 'python.exe');
      if (!fs.existsSync(pyExe)) {
        throw new Error(`python.exe missing after unzip: ${pyExe}`);
      }
      enableImportSite(dest);
      writeSiteCustomize(dest);
      const probe = spawnSync(pyExe, ['--version'], {
        stdio: 'pipe',
        windowsHide: true,
        encoding: 'utf8',
      });
      if (probe.status !== 0) {
        throw new Error(
          `bundled python.exe --version failed: ${probe.stderr || probe.stdout || probe.error}`
        );
      }
      console.log('[python-embed] probe:', (probe.stdout || '').trim());

      fs.writeFileSync(
        markerPath,
        JSON.stringify(
          {
            version: markerVersion,
            python: PYTHON_EMBED_VERSION,
            builtAt: new Date().toISOString(),
            source: url,
          },
          null,
          2
        ),
        'utf8'
      );
      console.log('[python-embed] done →', dest);
    })
    .catch((e) => {
      console.error('[python-embed] FAILED:', e.message || e);
      rmrf(dest);
      try {
        if (fs.existsSync(tmpZip)) fs.unlinkSync(tmpZip);
      } catch {
        /* ignore */
      }
      throw e;
    });
}

module.exports = { vendorPythonEmbed, PYTHON_EMBED_VERSION };

if (require.main === module) {
  const seedDir = path.join(__dirname, '..', 'seed');
  const force = process.argv.includes('--force');
  vendorPythonEmbed({ force, seedDir }).catch(() => process.exit(1));
}
