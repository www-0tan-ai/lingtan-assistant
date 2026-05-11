# Lingtan Assistant — Electron Desktop

This folder contains the Electron wrapper that turns the
[`hermes-webui`](../hermes-webui) Python web server into a native
Windows desktop application (`.exe`).

The Electron main process:

1. Discovers a Python interpreter. **Packaged Windows `.exe`:** uses the
   official embeddable CPython shipped under `resources/seed/python-embed/`
   (downloaded at build time — see `scripts/vendor-python-embed.cjs`).
   **Dev:** prefers `<repo>/.venv/Scripts/python.exe`, then `python` on `PATH`.
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

## Persona (`SOUL.md`) — how it loads

At runtime `HERMES_HOME` points to `%APPDATA%\lingtan-assistant\hermes-home\`.
The Python agent reads `SOUL.md` there as **system-prompt slot #1** (via
`load_soul_md()` in `agent/prompt_builder.py`). When `LINGTAN_BRANDING=1`
(main process sets this on the spawned Python child), Web UI builds that use
`skip_context_files=True` still force `load_soul_identity=True` so `SOUL.md`
is never skipped.

**Source → bundle:** `electron-app/assets/soul.lingtan.md` is copied into
`seed/hermes-home/SOUL.md` by `scripts/build-seed.cjs` (`npm run seed`).
That seed ships inside the installer under `resources/seed/hermes-home/`.

**Iterate without `npm run dist`:** edit `assets/soul.lingtan.md`, then run
`npm run seed` and restart `npm run dev` — no electron-builder step.

**Iterate on an installed `.exe`:** by default each launch re-copies bundled
`SOUL.md` into `hermes-home` so upgrades fix stale personas. To **stop** that
sync and edit the file by hand, set `LINGTAN_SKIP_SOUL_SEED_SYNC=1` before
starting the app (user or system environment), then edit
`%APPDATA%\lingtan-assistant\hermes-home\SOUL.md` and restart.

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
`build.extraResources.filter`). On **Windows**, `npm run seed` also
downloads the official **embeddable Python** (default 3.11.9) into
`seed/python-embed/`, which ships inside the installer so end users do
not need a system Python. Override the version with
`LINGTAN_PYTHON_EMBED_VERSION` when running the seed script if needed.

## Environment variables

| Var | Purpose |
| --- | --- |
| `LINGTAN_PYTHON` | Absolute path to a Python interpreter |
| `LINGTAN_PYTHON_EMBED_VERSION` | (build-time, optional) Embed zip version, e.g. `3.11.9`. Default `3.11.9`. |
| `LINGTAN_PORT` | Preferred port (auto-increments on collision) |
| `LINGTAN_DEV` | `1` to force devtools / dev-mode resource paths |
| `LINGTAN_SETTINGS_PASSWORD` | (build-time only) Password to unlock the in-app Settings panel. Default `lingtan2026`. Only its SHA-256 is bundled. |
| `LINGTAN_SKIP_SOUL_SEED_SYNC` | `1` / `true`: do not overwrite `hermes-home/SOUL.md` from bundled seed on each launch — use when tuning persona without rebuilding the installer (edit `%APPDATA%\...\hermes-home\SOUL.md`). |
| `HERMES_HOME` | (build-time only, optional) Directory whose `.env` is encrypted into `secrets.enc` when running `npm run seed`. Default `~/.hermes`. Does **not** affect `config.yaml` — that is always `assets/hermes-home/config.yaml`. |

## Bundled "zero-config" install (security-sensitive)

`npm run seed` reads your local `~/.hermes/.env` (and the repo) and
produces a `seed/` folder containing:

- `seed/secrets.enc` — AES-256-GCM encrypted bundle of your `~/.hermes/.env`.
  Decrypted at runtime in `main.js` (`lib/seed-runtime.cjs`) and **only** injected as
  env vars into the Python child process — it is *never* written to disk
  on the end-user's machine.
- `seed/hermes-home/config.yaml` — non-secret config copied from the
  **repo template** `electron-app/assets/hermes-home/config.yaml` (not from
  `~/.hermes/config.yaml`).  Seeded into
  `%APPDATA%\lingtan-assistant\hermes-home\` on first launch (strategy A:
  preserves user edits across launches).
- `seed/hermes-agent/` — vendored copy of the agent source tree
  (`run_agent.py` + `agent/` + `tools/` + `hermes_cli/` + `providers/` +
  `cron/` + `acp_adapter/` + `skills/` + the top-level helper modules).
  This is what `from run_agent import AIAgent` resolves against in the
  packaged build, so the end-user's machine does not need the
  hermes-agent repo or `pip install -e .`.  ~18 MB.
- `seed/python-deps/` — vendored Python dependencies installed via
  `pip install --target` against a curated subset of the agent's
  `pyproject.toml` (openai, anthropic, httpx, pydantic, jinja2,
  prompt_toolkit, croniter, etc.).  Cached across builds — bump
  `markerVersion` in `scripts/build-seed.cjs` to force a rebuild.
  ~40 MB.

main.js prepends both vendored dirs to `PYTHONPATH` when spawning
Python so the user's system interpreter doesn't need any of the
agent's runtime dependencies installed.

`npm run dist` automatically runs `npm run seed` first (`predist` hook),
so every release captures the *current* bundled `config.yaml` template and
your local `~/.hermes/.env` keys — not your personal `~/.hermes/config.yaml`.

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
