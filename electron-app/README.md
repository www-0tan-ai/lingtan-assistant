# Lingtan Assistant — Electron Desktop

This folder contains the Electron wrapper that turns the
[`hermes-webui`](../hermes-webui) Python web server into a native
Windows desktop application (`.exe`).

The Electron main process:

1. Discovers a Python interpreter (prefers `<repo>/.venv/Scripts/python.exe`,
   falls back to `python` / `py` on `PATH`).
2. Picks a free port (default `8787`, auto-increments if taken).
3. Launches `hermes-webui/server.py` as a child process.
4. Shows a splash window, polls `http://127.0.0.1:<port>/`, and once the
   server responds loads it inside a `BrowserWindow`.
5. Cleanly terminates the Python child (and its descendants on Windows
   via `taskkill /T /F`) when the user quits.

## Prerequisites

- **Node.js 20+** (for development and `electron-builder`)
- **Python 3.11+** on `PATH`, *or* a `.venv` at the repository root with
  the `hermes-webui` requirements installed (`pyyaml`).

```powershell
# from repo root
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r hermes-webui\requirements.txt
```

## Run in development

```powershell
cd electron-app
npm install
npm run dev
```

`LINGTAN_DEV=1` is set automatically by `npm run dev`, which opens devtools
once the UI loads. Override the port via `LINGTAN_PORT` and the interpreter
via `LINGTAN_PYTHON` if needed.

## Build the Windows `.exe`

```powershell
cd electron-app
npm install
npm run dist            # NSIS installer + portable exe (default)
npm run dist:portable   # only the portable single-file .exe
```

Output is written to `electron-app/dist/`:

- `Lingtan Assistant-Setup-<version>.exe` — installer with shortcuts
- `Lingtan Assistant-Portable-<version>.exe` — single-file portable

The build bundles `../hermes-webui/` as `extraResources`; tests, docs,
Docker assets and `__pycache__` are filtered out (see `package.json` →
`build.extraResources.filter`). Python itself is **not** bundled — the
end user must have Python 3.11+ on `PATH`. If you need a fully
self-contained installer, point `LINGTAN_PYTHON` at a PyInstaller-frozen
`server.exe` and add it to `extraResources`.

## Environment variables

| Var | Purpose |
| --- | --- |
| `LINGTAN_PYTHON` | Absolute path to a Python interpreter |
| `LINGTAN_PORT` | Preferred port (auto-increments on collision) |
| `LINGTAN_DEV` | `1` to force devtools / dev-mode resource paths |
