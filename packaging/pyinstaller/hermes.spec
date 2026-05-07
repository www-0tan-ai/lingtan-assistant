# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec for Hermes CLI (hermes.exe on Windows).

Build from repository root::

  pip install -e ".[cli,web,pty]" pyinstaller
  pyinstaller packaging/pyinstaller/hermes.spec

Or:  .\\scripts\\build_windows_exe.ps1

Produces ``dist/hermes/`` (onedir): ``hermes.exe`` plus ``_internal/``.
"""
from __future__ import annotations

from pathlib import Path

from PyInstaller.building.api import COLLECT, EXE, PYZ
from PyInstaller.building.build_main import Analysis
from PyInstaller.utils.hooks import collect_submodules

block_cipher = None

# Directory containing this spec → repo root is two levels up
ROOT = Path(SPECPATH).resolve().parent.parent

entry_script = ROOT / "packaging" / "pyinstaller" / "entry.py"

datas: list = []

# Hook-style (src, dest_dir) pairs — directories are walked recursively by PyInstaller.
for tree_name in ("skills", "optional-skills", "plugins"):
    src = ROOT / tree_name
    if src.is_dir():
        datas.append((str(src), tree_name))

web_dist = ROOT / "hermes_cli" / "web_dist"
if web_dist.is_dir():
    datas.append((str(web_dist), "hermes_cli/web_dist"))

hiddenimports: list = []
for pkg in (
    "tools",
    "gateway",
    "plugins",
    "agent",
    "hermes_cli",
    "cron",
    "acp_adapter",
    "tui_gateway",
):
    try:
        hiddenimports += collect_submodules(pkg)
    except Exception:
        pass

a = Analysis(
    [str(entry_script)],
    pathex=[str(ROOT)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "pytest",
        "pytest_asyncio",
        "IPython",
        "jupyter",
    ],
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
    name="hermes",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
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
    name="hermes",
)
