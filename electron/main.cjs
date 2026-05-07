/**
 * Electron main: spawn Python sidecar (0tan shell → hermes_electron), open BrowserWindow.
 */
const { app, BrowserWindow } = require("electron");
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");

let mainWindow = null;
let pyProc = null;

function repoRoot() {
  if (app.isPackaged) {
    return process.resourcesPath;
  }
  return path.join(__dirname, "..");
}

function rendererStaticDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "renderer");
  }
  return path.join(__dirname, "renderer");
}

/** Window / taskbar icon (PNG). Packaged copy lives under extraResources. */
function appIconPath() {
  if (app.isPackaged) {
    const p = path.join(process.resourcesPath, "app-icon.png");
    return fs.existsSync(p) ? p : undefined;
  }
  const p = path.join(__dirname, "build", "icon.png");
  return fs.existsSync(p) ? p : undefined;
}

function bundledSidecarPath() {
  const dir = path.join(process.resourcesPath, "sidecar");
  if (process.platform === "win32") {
    return path.join(dir, "hermes-electron-sidecar.exe");
  }
  return path.join(dir, "hermes-electron-sidecar");
}

function pythonExe() {
  if (app.isPackaged) {
    const p = bundledSidecarPath();
    if (fs.existsSync(p)) return p;
  }
  const root = repoRoot();
  const winVenv = path.join(root, ".venv", "Scripts", "python.exe");
  const posixVenv = path.join(root, ".venv", "bin", "python");
  if (process.platform === "win32" && fs.existsSync(winVenv)) return winVenv;
  if (fs.existsSync(posixVenv)) return posixVenv;
  return process.env.PYTHON || "python3";
}

function startSidecar() {
  const staticDir = rendererStaticDir();
  const py = pythonExe();
  const base = path.basename(py).toLowerCase();
  const useFrozenSidecar =
    base === "hermes-electron-sidecar.exe" || base === "hermes-electron-sidecar";
  const args = useFrozenSidecar ? [] : ["-m", "hermes_electron"];
  const env = {
    ...process.env,
    PYTHONUTF8: "1",
    HERMES_ELECTRON_RENDERER: staticDir,
  };
  if (app.isPackaged) {
    const deskData = path.join(path.dirname(process.execPath), "0tan_data");
    env.HERMES_HOME = deskData;
  }

  const cwd = useFrozenSidecar ? path.dirname(py) : repoRoot();

  pyProc = spawn(py, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      reject(new Error("sidecar: timeout waiting for HERMES_ELECTRON_READY"));
    }, 60000);

    let buf = "";
    const onChunk = (chunk) => {
      buf += chunk.toString();
      const idx = buf.indexOf("HERMES_ELECTRON_READY");
      if (idx === -1) return;
      const rest = buf.slice(idx + "HERMES_ELECTRON_READY".length).trim();
      const nl = rest.indexOf("\n");
      const jsonLine = nl === -1 ? rest : rest.slice(0, nl);
      try {
        const meta = JSON.parse(jsonLine);
        clearTimeout(deadline);
        pyProc.stdout.off("data", onChunk);
        resolve(meta);
      } catch (e) {
        clearTimeout(deadline);
        reject(e);
      }
    };

    pyProc.stdout.on("data", onChunk);
    pyProc.stderr.on("data", (d) => {
      process.stderr.write(d);
    });
    pyProc.on("error", (err) => {
      clearTimeout(deadline);
      reject(err);
    });
    pyProc.on("exit", (code, sig) => {
      if (code !== 0 && code !== null) {
        clearTimeout(deadline);
        reject(new Error(`sidecar exited: code=${code} sig=${sig}`));
      }
    });
  });
}

/**
 * @param {import("electron").BrowserWindow} win
 * @param {string} url
 */
async function loadURLWithRetry(win, url) {
  const attempts = 8;
  const delayMs = 300;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await win.loadURL(url);
      return;
    } catch (e) {
      lastErr = e;
      console.warn(`[0tan] loadURL attempt ${i + 1}/${attempts}:`, e?.message || e);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

/**
 * Extra guard after READY: some Windows builds still throw ERR_NETWORK_CHANGED (-21)
 * on the first Chromium navigation to loopback.
 */
function probeHttpOnce(urlStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        method: "GET",
        timeout: 4000,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("probe timeout"));
    });
    req.end();
  });
}

async function probeHttpRetry(urlStr, attempts = 10, delayMs = 200) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await probeHttpOnce(urlStr);
      return;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

function killSidecar() {
  if (!pyProc) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pyProc.pid), "/f", "/t"]);
    } else {
      pyProc.kill("SIGTERM");
    }
  } catch {
    /* ignore */
  }
  pyProc = null;
}

async function createWindow() {
  let meta;
  try {
    meta = await startSidecar();
  } catch (e) {
    console.error(e);
    const { dialog } = require("electron");
    const hint = app.isPackaged
      ? "便携版：请确认 resources\\sidecar 目录完整；配置与密钥写在 EXE 同目录的 0tan_data\\。"
      : "开发模式：请在仓库根目录 pip install -e \".[electron-shell]\" 并使用 .venv。";
    dialog.showErrorBox("0tan", `无法启动 Python 侧车。\n\n${String(e.message || e)}\n\n${hint}`);
    app.quit();
    return;
  }

  const { port, token } = meta;
  const url = `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;

  try {
    await probeHttpRetry(url);
  } catch (e) {
    console.error("[0tan] HTTP probe failed:", e);
  }

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 560,
    title: "0tan",
    icon: appIconPath(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  try {
    await loadURLWithRetry(mainWindow, url);
  } catch (e) {
    console.error(e);
    const { dialog } = require("electron");
    dialog.showErrorBox(
      "0tan",
      `无法加载界面 (${url.slice(0, 48)}…)\n\n${String(e.message || e)}\n\n` +
        "若偶发 ERR_NETWORK_CHANGED，可重试；若每次失败，请检查侧车日志。",
    );
    mainWindow?.destroy();
    mainWindow = null;
    killSidecar();
    app.quit();
    return;
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  killSidecar();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  killSidecar();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
