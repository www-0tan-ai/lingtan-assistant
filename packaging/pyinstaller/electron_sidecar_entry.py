"""PyInstaller entry: Hermes Electron Python sidecar (FastAPI + tui_gateway WebSocket).

HermesDesk 便携版由 Electron 主进程设置 ``HERMES_HOME``（通常为 EXE 同目录下的
``hermes_data``）。若未设置且为 frozen 构建，则回退到侧车 exe 旁（仅调试）。
"""
from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path


def _resolve_hermes_home() -> Path | None:
    raw = (os.environ.get("HERMES_HOME") or "").strip()
    if raw:
        return Path(raw)
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent / "hermes_data"
    return None


def _ensure_portable_hermes_home() -> None:
    home = _resolve_hermes_home()
    if home is None:
        return
    home.mkdir(parents=True, exist_ok=True)
    os.environ["HERMES_HOME"] = str(home.resolve())

    cfg = home / "config.yaml"
    if not cfg.exists():
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            src = Path(meipass) / "bundled_config" / "config.defaults.yaml"
            if src.is_file():
                shutil.copy(src, cfg)

    env_file = home / ".env"
    if not env_file.exists():
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            sample = Path(meipass) / "bundled_config" / "env.sample"
            if sample.is_file():
                shutil.copy(sample, env_file)


_ensure_portable_hermes_home()

from hermes_electron.sidecar import main  # noqa: E402

if __name__ == "__main__":
    main()
