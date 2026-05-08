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
| `LINGTAN_SETTINGS_PASSWORD` | (build-time only) Password to unlock the in-app Settings panel. Default `lingtan2026`. Only its SHA-256 is bundled. |
| `HERMES_HOME` | (build-time only, optional) Source dir to seed from when running `npm run seed`. Default `~/.hermes`. |

## Bundled "zero-config" install (security-sensitive)

`npm run seed` reads your local `~/.hermes/` and produces a
`seed/` folder containing:

- `seed/secrets.enc` — AES-256-GCM encrypted bundle of your `~/.hermes/.env`.
  Decrypted at runtime in `main.js` (`lib/seed-runtime.cjs`) and **only** injected as
  env vars into the Python child process — it is *never* written to disk
  on the end-user's machine.
- `seed/hermes-home/config.yaml` — non-secret config copied verbatim
  from `~/.hermes/config.yaml`.  Seeded into
  `%APPDATA%\Lingtan Assistant\hermes-home\` on first launch (strategy A:
  preserves user edits across launches).

`npm run dist` automatically runs `npm run seed` first (`predist` hook),
so every release captures the *current* state of your local Hermes
config.

`seed/` is gitignored.  **Never commit it.**

### Settings panel password gate

The Settings panel (`[data-panel="settings"]`, `#panelSettings`,
onboarding overlays) is hidden by a CSS injection.  Press
**Ctrl+Shift+L** (⌘+Shift+L on macOS) to pop a password prompt, or
visit any URL with `#__admin` in the hash.  The plaintext password
never leaves the developer machine — only its SHA-256 ships in
`secrets.enc`.

### Threat model — read this before shipping

The encryption is **anti-grep, not anti-reverse-engineer**.  The
passphrase that derives the AES key is hardcoded inside
`lib/crypto-utils.cjs`; anyone who unpacks the asar and reads that
file can decrypt `secrets.enc`.  Treat any credential bundled this
way as already-leaked when planning quotas, rotations, and audits.
For untrusted distribution, use a backend proxy and ship only its
URL in the .exe.
