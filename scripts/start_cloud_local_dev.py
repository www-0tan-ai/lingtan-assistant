"""
Start cloud/local dev stack with API server only.

Usage:
  python scripts/start_cloud_local_dev.py
"""

import os
import subprocess
import sys


def main() -> int:
    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    hermes_home = os.path.join(repo_root, ".tmp", "hermes-home")
    os.makedirs(hermes_home, exist_ok=True)

    env = os.environ.copy()
    env["HERMES_HOME"] = hermes_home
    env["API_SERVER_ENABLED"] = "true"
    env.setdefault("API_SERVER_HOST", "127.0.0.1")
    env.setdefault("API_SERVER_PORT", "8642")

    print(f"[dev] HERMES_HOME={hermes_home}")
    print(f"[dev] API server: http://{env['API_SERVER_HOST']}:{env['API_SERVER_PORT']}")
    print("[dev] starting gateway (API server only)...")

    proc = subprocess.run(
        [sys.executable, "-m", "gateway.run"],
        cwd=repo_root,
        env=env,
    )
    return int(proc.returncode)


if __name__ == "__main__":
    raise SystemExit(main())
