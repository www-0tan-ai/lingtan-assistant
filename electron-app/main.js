/**
 * Lingtan Assistant — Electron main process.
 *
 * Responsibilities:
 *   1. Locate a usable Python interpreter (bundled .venv → system PATH).
 *   2. Spawn `hermes-webui/server.py` as a child process on a free port.
 *   3. Show a splash window, wait until the HTTP server is reachable,
 *      then load the UI inside a frameless BrowserWindow.
 *   4. Tear the Python child down cleanly when the user quits.
 */

const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');
const os = require('os');
const { loadSeed } = require('./lib/seed-runtime.cjs');

const IS_DEV = process.env.LINGTAN_DEV === '1' || !app.isPackaged;
const HOST = '127.0.0.1';
const DEFAULT_PORT = parseInt(process.env.LINGTAN_PORT || '8787', 10);

let mainWindow = null;
let splashWindow = null;
let pyProc = null;
let pyPort = DEFAULT_PORT;
let isQuitting = false;

// Populated in app.whenReady() once Electron has settled enough to
// resolve userData.  Holds:
//   { extraEnv, settingsPasswordHash, hermesHome, secretCount }
let seed = null;

// File logger.  GUI-subsystem .exe on Windows discards process.stdout, so
// without this any Python startup error is invisible.  Synchronous writes
// (appendFileSync) — startup crashes happen so fast that an async stream
// loses its buffer; we accept the perf hit because volume is tiny.
let logFilePath = null;
function _initLogFile() {
  try {
    // Use a fixed location that doesn't depend on app.getPath('userData')
    // resolving correctly, so we can capture even very early startup errors.
    const dir = path.join(
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'lingtan-assistant',
      'logs'
    );
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    logFilePath = path.join(dir, `lingtan-${stamp}.log`);
    fs.appendFileSync(
      logFilePath,
      `[${new Date().toISOString()}] log opened: ${logFilePath}\n`
    );
  } catch (e) {
    // last-ditch attempt: log dir creation failed (perms?). Try temp dir.
    try {
      const tmp = path.join(os.tmpdir(), 'lingtan-bootstrap.log');
      fs.appendFileSync(tmp, `[${new Date().toISOString()}] _initLogFile failed in primary dir: ${e && e.message}; falling back to ${tmp}\n`);
      logFilePath = tmp;
    } catch { /* nothing we can do */ }
  }
}
function flog(line) {
  const text = `[${new Date().toISOString()}] ${line}\n`;
  try { process.stdout.write(text); } catch {}
  if (logFilePath) { try { fs.appendFileSync(logFilePath, text); } catch {} }
}
function flogChunk(prefix, buf) {
  if (!logFilePath) return;
  try {
    fs.appendFileSync(
      logFilePath,
      `[${new Date().toISOString()}] ${prefix} ${buf}`
    );
  } catch {}
}

// Top-level safety net — if any uncaught exception fires before we reach
// app.whenReady(), at least try to log it.  _initLogFile() is also called
// at the very top of the file (immediately below) so the path is set up
// before any other module-level code that could throw.
process.on('uncaughtException', (e) => {
  flog(`UNCAUGHT EXCEPTION: ${e && e.stack ? e.stack : e}`);
});
process.on('unhandledRejection', (r) => {
  flog(`UNHANDLED REJECTION: ${r && r.stack ? r.stack : r}`);
});

_initLogFile();
flog(`main.js loaded, pid=${process.pid}, cwd=${process.cwd()}, argv=${JSON.stringify(process.argv)}`);

// ─────────────────────────────────────────────────────────────────────
// Path helpers — work in both dev and packaged (asar + extraResources).
// ─────────────────────────────────────────────────────────────────────

function getRepoRoot() {
  // In dev:    electron-app/main.js → repo root is one level up.
  // Packaged:  resources/hermes-webui lives next to the app, repo root
  //            isn't meaningful; we use process.resourcesPath instead.
  return path.resolve(__dirname, '..');
}

function getWebuiDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'hermes-webui');
  }
  return path.join(getRepoRoot(), 'hermes-webui');
}

function getAgentDir() {
  // hermes-webui's discovery looks for `run_agent.py` in the directory
  // we point it at.  In dev that's the parent project root.  When
  // packaged we ship a vendored agent tree under resources/seed/hermes-agent
  // (built by scripts/build-seed.cjs).
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'seed', 'hermes-agent');
  }
  return getRepoRoot();
}

function getVendoredPyDepsDir() {
  // Vendored pip dependencies live next to the agent source.  Returns
  // null in dev — there we let the developer's own Python env supply
  // the agent's dependencies.
  if (app.isPackaged) {
    const p = path.join(process.resourcesPath, 'seed', 'python-deps');
    return fs.existsSync(p) ? p : null;
  }
  return null;
}

function getStateDir() {
  // Per-user, OS-appropriate location. Survives uninstall by default.
  return path.join(app.getPath('userData'), 'webui-state');
}

// ─────────────────────────────────────────────────────────────────────
// Python interpreter discovery.
// ─────────────────────────────────────────────────────────────────────

function isUsableVenvPython(pyPath) {
  // Requires both python.exe and pyvenv.cfg — broken/half-deleted venvs
  // (e.g. python.exe present but Lib gone, or vice versa) abort early
  // so we can fall through to system Python.
  if (!fs.existsSync(pyPath)) return false;
  const venvRoot = path.resolve(path.dirname(pyPath), '..');
  return fs.existsSync(path.join(venvRoot, 'pyvenv.cfg'));
}

function canRunPythonCommand(cmd, extraArgs = []) {
  try {
    const probe = spawnSync(cmd, [...extraArgs, '--version'], {
      windowsHide: true,
      stdio: 'pipe',
      shell: false,
      timeout: 10_000,
    });
    // ENOENT and similar startup failures surface as probe.error.
    if (probe.error) return false;
    return probe.status === 0;
  } catch {
    return false;
  }
}

function findPythonExecutable() {
  const candidates = [];
  const repoRoot = getRepoRoot();

  if (process.env.LINGTAN_PYTHON) candidates.push({ path: process.env.LINGTAN_PYTHON, kind: 'env' });

  // Bundled / sibling venv (dev workflow)
  if (process.platform === 'win32') {
    candidates.push({ path: path.join(repoRoot, '.venv', 'Scripts', 'python.exe'), kind: 'venv' });
    candidates.push({ path: path.join(repoRoot, 'venv', 'Scripts', 'python.exe'), kind: 'venv' });
  } else {
    candidates.push({ path: path.join(repoRoot, '.venv', 'bin', 'python'), kind: 'venv' });
    candidates.push({ path: path.join(repoRoot, 'venv', 'bin', 'python'), kind: 'venv' });
  }

  // System PATH fallbacks
  if (process.platform === 'win32') {
    // "py" launcher often exists without any installed interpreter on end-user
    // machines and exits with Windows code 9009 at runtime. Prefer real python.
    for (const n of ['python.exe', 'python']) candidates.push({ path: n, kind: 'path' });
  } else {
    for (const n of ['python3', 'python']) candidates.push({ path: n, kind: 'path' });
  }

  for (const c of candidates) {
    if (!c.path) continue;
    if (c.kind === 'venv') {
      if (isUsableVenvPython(c.path)) return c.path;
      continue;
    }
    if (path.isAbsolute(c.path)) {
      if (fs.existsSync(c.path)) return c.path;
    } else {
      // Validate PATH candidate up-front so we fail with a clear "python missing"
      // dialog instead of a later opaque backend exit code.
      if (canRunPythonCommand(c.path)) return c.path;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// Free-port + readiness probes.
// ─────────────────────────────────────────────────────────────────────

function findFreePort(preferred) {
  return new Promise((resolve) => {
    const tryPort = (port, attemptsLeft) => {
      const srv = net.createServer();
      srv.unref();
      srv.on('error', () => {
        if (attemptsLeft <= 0) {
          srv.close(() => resolve(0));
          return;
        }
        tryPort(port + 1, attemptsLeft - 1);
      });
      srv.listen({ port, host: HOST }, () => {
        const { port: bound } = srv.address();
        srv.close(() => resolve(bound));
      });
    };
    tryPort(preferred, 25);
  });
}

function pingServer(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: HOST, port, path: '/', timeout: 1500 },
      (res) => {
        res.resume();
        resolve(res.statusCode > 0);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForServer(port, timeoutMs = 60_000) {
  const start = Date.now();
  // small initial backoff, cap at 500ms
  let delay = 100;
  while (Date.now() - start < timeoutMs) {
    if (await pingServer(port)) return true;
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay + 50, 500);
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────
// Python sidecar lifecycle.
// ─────────────────────────────────────────────────────────────────────

function startPythonServer(port) {
  const python = findPythonExecutable();
  if (!python) {
    dialog.showErrorBox(
      'Python not found',
      'Lingtan Assistant requires Python 3.11+ on your system.\n' +
        'Please install Python from https://www.python.org/ and try again.'
    );
    app.exit(1);
    return null;
  }

  const webuiDir = getWebuiDir();
  const serverPy = path.join(webuiDir, 'server.py');
  if (!fs.existsSync(serverPy)) {
    dialog.showErrorBox(
      '后台服务文件缺失',
      `未找到 ${serverPy}。\n应用安装可能已损坏，请尝试重新安装。`
    );
    app.exit(1);
    return null;
  }

  const stateDir = getStateDir();
  fs.mkdirSync(stateDir, { recursive: true });

  // Build a PYTHONPATH that prepends the vendored agent + deps when
  // packaged, so `from run_agent import AIAgent` resolves against the
  // shipped source tree and bundled dependency wheels — the user's
  // system Python doesn't need to have the agent or its 14+ deps
  // installed system-wide.
  const agentDir = getAgentDir();
  const pyDepsDir = getVendoredPyDepsDir();
  const pathSep = process.platform === 'win32' ? ';' : ':';
  const pyPathParts = [];
  if (app.isPackaged) pyPathParts.push(agentDir);
  if (pyDepsDir) pyPathParts.push(pyDepsDir);
  if (process.env.PYTHONPATH) pyPathParts.push(process.env.PYTHONPATH);

  // Seed-supplied env (HERMES_HOME + decrypted API keys) takes precedence
  // over the user's shell env so a stale OPENAI_API_KEY in their PATH
  // can't shadow the bundled one.  Webui-specific overrides come last
  // because they're per-launch values we computed just now.
  const env = {
    ...process.env,
    ...(seed ? seed.extraEnv : {}),
    HERMES_WEBUI_HOST: HOST,
    HERMES_WEBUI_PORT: String(port),
    HERMES_WEBUI_STATE_DIR: stateDir,
    HERMES_WEBUI_AGENT_DIR: agentDir,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1',
    ...(pyPathParts.length ? { PYTHONPATH: pyPathParts.join(pathSep) } : {}),
  };

  flog(`python      = ${python}`);
  flog(`cwd         = ${webuiDir}`);
  flog(`port        = ${port}`);
  flog(`agent dir   = ${agentDir}`);
  if (pyDepsDir) flog(`py-deps     = ${pyDepsDir}`);
  if (seed) {
    flog(`HERMES_HOME = ${seed.hermesHome}`);
    flog(`bundled keys = ${seed.secretCount}`);
  }
  flog(`PYTHONPATH  = ${env.PYTHONPATH || '(empty)'}`);
  flog(`HERMES_WEBUI_AGENT_DIR = ${env.HERMES_WEBUI_AGENT_DIR}`);
  flog(`AZURE_FOUNDRY_API_KEY  = ${env.AZURE_FOUNDRY_API_KEY ? '<set len=' + env.AZURE_FOUNDRY_API_KEY.length + '>' : '<MISSING>'}`);
  flog(`AZURE_FOUNDRY_BASE_URL = ${env.AZURE_FOUNDRY_BASE_URL || '<MISSING>'}`);

  const proc = spawn(python, ['server.py'], {
    cwd: webuiDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  proc.on('error', (err) => {
    const msg = String((err && err.message) || err || '');
    flog(`python spawn error: ${msg}`);
    if (!isQuitting) {
      dialog.showErrorBox(
        '后台启动失败',
        `无法启动 Python 运行时：${msg}\n\n` +
          '此版本需要目标机器安装 Python 3.11+，或改用内置 Python 的安装包。'
      );
      app.quit();
    }
  });

  proc.stdout.on('data', (d) => {
    try { process.stdout.write(`[webui] ${d}`); } catch {}
    flogChunk('[webui]    ', d);
  });
  proc.stderr.on('data', (d) => {
    try { process.stderr.write(`[webui:err] ${d}`); } catch {}
    flogChunk('[webui:err]', d);
  });

  proc.on('exit', (code, signal) => {
    flog(`python server exited code=${code} signal=${signal}`);
    pyProc = null;
    if (!isQuitting && code !== 0 && code !== null) {
      const detail =
        code === 9009
          ? `0tan 后台服务异常退出（退出码 ${code}）。\n` +
            '检测到系统缺少可用 Python 运行时（或命令不可执行）。\n' +
            '请先安装 Python 3.11+，再启动应用。'
          : `0tan 后台服务异常退出（退出码 ${code}）。\n` +
            '可在开发者工具或日志中查看详情。';
      dialog.showErrorBox(
        '后台已停止',
        detail
      );
      app.quit();
    }
  });

  return proc;
}

function killPythonServer() {
  if (!pyProc) return;
  const proc = pyProc;
  pyProc = null;
  try {
    if (process.platform === 'win32') {
      // Force kill the whole process tree (server + any spawned children).
      spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } else {
      proc.kill('SIGTERM');
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* already gone */ }
      }, 3000);
    }
  } catch (e) {
    console.error('[lingtan] failed to kill python:', e);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Windows.
// ─────────────────────────────────────────────────────────────────────

function createSplash() {
  splashWindow = new BrowserWindow({
    width: 420,
    height: 260,
    frame: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    transparent: false,
    backgroundColor: '#1a1a1a',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  splashWindow.loadFile(path.join(__dirname, 'splash.html'));
  splashWindow.once('ready-to-show', () => splashWindow && splashWindow.show());
}

function createMainWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1a1a1a',
    show: false,
    autoHideMenuBar: true,
    title: 'Lingtan Assistant',
    icon: path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  // Open external links (http/https not pointing at our server) in default browser.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    try {
      const u = new URL(target);
      const isLocal =
        (u.hostname === HOST || u.hostname === 'localhost') &&
        (u.port === String(pyPort) || u.port === '');
      if (!isLocal && (u.protocol === 'http:' || u.protocol === 'https:')) {
        shell.openExternal(target);
        return { action: 'deny' };
      }
    } catch {
      /* fall through */
    }
    return { action: 'allow' };
  });

  mainWindow.webContents.on('will-navigate', (e, target) => {
    try {
      const u = new URL(target);
      const isLocal =
        (u.hostname === HOST || u.hostname === 'localhost') &&
        (u.port === String(pyPort) || u.port === '');
      if (!isLocal) {
        e.preventDefault();
        shell.openExternal(target);
      }
    } catch {
      /* allow */
    }
  });

  mainWindow.once('ready-to-show', () => {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
    splashWindow = null;
    mainWindow.show();
    if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  // Inject the settings-page gate every time the renderer finishes a
  // navigation.  We re-inject on every did-finish-load so reloads /
  // route changes inside the SPA can't bypass the lock.
  mainWindow.webContents.on('did-finish-load', () => {
    injectSettingsGate(mainWindow.webContents);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadURL(url);
}

let _gateScriptCache = null;
function _readGateScript() {
  if (_gateScriptCache) return _gateScriptCache;
  const p = path.join(__dirname, 'lib', 'settings-gate.js');
  _gateScriptCache = fs.readFileSync(p, 'utf8');
  return _gateScriptCache;
}

function injectSettingsGate(webContents) {
  const hash = (seed && seed.settingsPasswordHash) || null;
  if (!hash) return; // no password configured — skip gating entirely
  const init =
    `;(function(){window.__lingtanGate=${JSON.stringify({ settingsPasswordHash: hash })};})();`;
  const body = _readGateScript();
  webContents
    .executeJavaScript(init + '\n' + body, true)
    .catch((e) => console.warn('[lingtan] settings-gate inject failed:', e.message));
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '文件',
      submenu: [
        {
          label: '重新加载',
          accelerator: 'CmdOrCtrl+R',
          click: () => mainWindow && mainWindow.reload(),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: '视图',
      submenu: [
        { role: 'togglefullscreen' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
        { type: 'separator' },
        {
          label: '切换开发者工具',
          accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
          click: () => mainWindow && mainWindow.webContents.toggleDevTools(),
        },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 Lingtan Assistant',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: '关于',
              message: 'Lingtan Assistant',
              detail:
                `版本：${app.getVersion()}\n` +
                `Electron：${process.versions.electron}\n` +
                `Node：${process.versions.node}\n` +
                `平台：${process.platform} (${os.arch()})\n\n` +
                `后台服务：0tan Web UI 运行于 http://${HOST}:${pyPort}`,
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─────────────────────────────────────────────────────────────────────
// App lifecycle.
// ─────────────────────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(async () => {
  flog(`app ready, isPackaged=${app.isPackaged} userData=${app.getPath('userData')}`);

  try {
    seed = loadSeed(app);
    flog(`seed loaded: keys=${seed.secretCount} hermesHome=${seed.hermesHome}`);
  } catch (e) {
    flog(`seed load failed: ${e && e.stack ? e.stack : e}`);
    seed = null;
  }

  buildMenu();
  createSplash();

  pyPort = (await findFreePort(DEFAULT_PORT)) || DEFAULT_PORT;
  flog(`chosen port = ${pyPort}`);
  pyProc = startPythonServer(pyPort);
  if (!pyProc) { flog(`startPythonServer returned null — aborting`); return; }

  const url = `http://${HOST}:${pyPort}/`;
  flog(`waiting for ${url} (90s timeout)...`);
  const ok = await waitForServer(pyPort, 90_000);
  flog(`waitForServer result = ${ok}`);
  if (!ok) {
    dialog.showErrorBox(
      '后台启动超时',
      `0tan 后台服务在 90 秒内未能启动。\n\n` +
        `尝试访问的地址：${url}\n\n` +
        `如果是首次启动，Python 可能正在安装依赖——请稍候再试，或查看控制台输出。`
    );
    app.quit();
    return;
  }

  createMainWindow(url);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && pyPort) {
    createMainWindow(`http://${HOST}:${pyPort}/`);
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  killPythonServer();
});

process.on('exit', killPythonServer);
process.on('SIGINT', () => { killPythonServer(); process.exit(0); });
process.on('SIGTERM', () => { killPythonServer(); process.exit(0); });
