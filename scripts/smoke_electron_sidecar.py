"""One-shot smoke test: hermes_electron serves static UI + prints READY line."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.request


def main() -> int:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    env = os.environ.copy()
    env["HERMES_ELECTRON_RENDERER"] = os.path.join(root, "electron", "renderer")
    p = subprocess.Popen(
        [sys.executable, "-m", "hermes_electron"],
        cwd=root,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    line = p.stdout.readline()
    assert "HERMES_ELECTRON_READY" in line, line
    meta = json.loads(line.split("HERMES_ELECTRON_READY", 1)[1].strip())
    port = int(meta["port"])
    url = f"http://127.0.0.1:{port}/"
    with urllib.request.urlopen(url, timeout=10) as r:
        html = r.read().decode("utf-8", errors="replace")
    assert "Hermes" in html or "hermes" in html.lower(), html[:200]
    print("smoke_electron_sidecar OK", port, "bytes", len(html))
    p.terminate()
    try:
        p.wait(timeout=8)
    except subprocess.TimeoutExpired:
        p.kill()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
