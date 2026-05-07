/**
 * Electron main: spawn Python sidecar (hermes_electron), open BrowserWindow.
 */
const { app, BrowserWindow } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

let mainWindow = null;
let pyProc = null;

function repoRoot() {
  return path.join(__dirname, "..");
}

function pythonExe() {
  const winVenv = path.join(repoRoot(), ".venv", "Scripts", "python.exe");
  const posixVenv = path.join(repoRoot(), ".venv", "bin", "python");
  if (process.platform === "win32" && fs.existsSync(winVenv)) return winVenv;
  if (fs.existsSync(posixVenv)) return posixVenv;
  return process.env.PYTHON || "python3";
}

function startSidecar() {
  const staticDir = path.join(__dirname, "renderer");
  const py = pythonExe();
  const args = ["-m", "hermes_electron"];
  const env = {
    ...process.env,
    PYTHONUTF8: "1",
    HERMES_ELECTRON_RENDERER: staticDir,
  };

  pyProc = spawn(py, args, {
    cwd: repoRoot(),
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
    dialog.showErrorBox(
      "Hermes Electron",
      `无法启动 Python 侧车。\n\n${String(e.message || e)}\n\n请确认已在仓库根目录执行:\n  pip install -e ".[web]"\n并且使用仓库内的 .venv。`,
    );
    app.quit();
    return;
  }

  const { port, token } = meta;
  const url = `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 560,
    title: "Hermes",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  await mainWindow.loadURL(url);
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
