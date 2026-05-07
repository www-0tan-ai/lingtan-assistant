# -*- mode: python ; coding: utf-8 -*-
"""Python sidecar for 0tan desktop (Electron). Build from repo root::

  pip install -e ".[cli,electron-shell]" "pyinstaller>=6.3,<7"
  pyinstaller packaging/pyinstaller/hermes_electron_sidecar.spec

Output: dist/hermes-electron-sidecar/hermes-electron-sidecar.exe (+ _internal).
"""
from __future__ import annotations

from pathlib import Path

from PyInstaller.building.api import COLLECT, EXE, PYZ
from PyInstaller.building.build_main import Analysis
from PyInstaller.utils.hooks import collect_submodules

block_cipher = None

ROOT = Path(SPECPATH).resolve().parent.parent
entry_script = ROOT / "packaging" / "pyinstaller" / "electron_sidecar_entry.py"
bundled = ROOT / "packaging" / "bundled" / "otan_desk"

datas = []
if bundled.is_dir():
    datas.append((str(bundled), "bundled_config"))

for tree_name in ("skills", "optional-skills", "plugins"):
    src = ROOT / tree_name
    if src.is_dir():
        datas.append((str(src), tree_name))

web_dist = ROOT / "hermes_cli" / "web_dist"
if web_dist.is_dir():
    datas.append((str(web_dist), "hermes_cli/web_dist"))

hiddenimports = []
for pkg in (
    "tools",
    "gateway",
    "plugins",
    "agent",
    "hermes_cli",
    "cron",
    "acp_adapter",
    "tui_gateway",
    "hermes_electron",
):
    try:
        hiddenimports += collect_submodules(pkg)
    except Exception:
        pass

hiddenimports += [
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.protocols",
    "uvicorn.protocols.http",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.websockets",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan",
    "uvicorn.lifespan.on",
]

a = Analysis(
    [str(entry_script)],
    pathex=[str(ROOT)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["pytest", "pytest_asyncio", "IPython", "jupyter", "PySide6"],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="hermes-electron-sidecar",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="hermes-electron-sidecar",
)
