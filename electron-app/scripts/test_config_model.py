#!/usr/bin/env python3
"""
Dry-run Hermes model settings: YAML shape + load_config merge + resolve_runtime_provider.

Uses a temporary HERMES_HOME so your real ~/.hermes is never touched.

Usage (from repo root):

  .venv\\Scripts\\python.exe electron-app\\scripts\\test_config_model.py
  .venv\\Scripts\\python.exe electron-app\\scripts\\test_config_model.py path\\to\\config.yaml
  .venv\\Scripts\\python.exe electron-app\\scripts\\test_config_model.py --env %USERPROFILE%\\.hermes\\.env electron-app\\seed\\hermes-home\\config.yaml

Exit code 0 if YAML parses and load_config succeeds; runtime resolution errors are printed
but do not change exit code unless --strict is set.

Use --skip-resolve to only check YAML + load_config (no API keys required).
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import tempfile
import traceback
from pathlib import Path


def _repo_root() -> Path:
    # electron-app/scripts/test_config_model.py -> repo root
    return Path(__file__).resolve().parent.parent.parent


def _clear_config_caches() -> None:
    import hermes_cli.config as hc

    hc._LOAD_CONFIG_CACHE.clear()
    hc._RAW_CONFIG_CACHE.clear()
    hc._LAST_EXPANDED_CONFIG_BY_PATH.clear()


def _load_env_file(path: Path) -> None:
    try:
        from dotenv import dotenv_values
    except ImportError:
        print("ERROR: python-dotenv is required for --env (pip install python-dotenv)", file=sys.stderr)
        raise SystemExit(2)
    data = dotenv_values(path)
    for k, v in data.items():
        if k and v is not None and str(v).strip() != "":
            os.environ.setdefault(k, str(v))


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate config.yaml model section using Hermes load_config + runtime resolution."
    )
    parser.add_argument(
        "config",
        nargs="?",
        default=None,
        help="Path to config.yaml (default: electron-app/seed/hermes-home/config.yaml under repo root)",
    )
    parser.add_argument(
        "--env",
        dest="env_file",
        default=None,
        metavar="PATH",
        help="Optional .env file: merge into environment before resolution (API keys)",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Exit with code 1 if resolve_runtime_provider raises",
    )
    parser.add_argument(
        "--traceback",
        action="store_true",
        help="Print full traceback when runtime resolution fails",
    )
    parser.add_argument(
        "--keep-hermes-home",
        action="store_true",
        help="Do not delete temp HERMES_HOME; print its path",
    )
    parser.add_argument(
        "--skip-resolve",
        action="store_true",
        help="Skip resolve_runtime_provider() (no API keys needed; tests YAML + load_config only)",
    )
    args = parser.parse_args()

    root = _repo_root()
    cfg_path = (
        Path(args.config).expanduser().resolve()
        if args.config
        else (root / "electron-app" / "seed" / "hermes-home" / "config.yaml").resolve()
    )
    if not cfg_path.is_file():
        print(f"ERROR: config file not found: {cfg_path}", file=sys.stderr)
        return 1

    try:
        import yaml
    except ImportError:
        print("ERROR: PyYAML is required (pip install pyyaml)", file=sys.stderr)
        return 2

    with cfg_path.open(encoding="utf-8") as f:
        raw_doc = yaml.safe_load(f)

    if not isinstance(raw_doc, dict):
        print("ERROR: config.yaml must parse to a mapping (dict) at top level", file=sys.stderr)
        return 1

    raw_model = raw_doc.get("model")
    print("=== Raw YAML: model ===")
    if raw_model is None:
        print("  (missing top-level 'model:' — Hermes will use defaults from DEFAULT_CONFIG only)")
    elif isinstance(raw_model, dict):
        for k in sorted(raw_model.keys()):
            print(f"  {k}: {raw_model[k]!r}")
    else:
        print(f"  (unexpected type {type(raw_model).__name__!r}, value {raw_model!r})")

    tmp = Path(tempfile.mkdtemp(prefix="lingtan-config-test-"))
    try:
        os.environ["HERMES_HOME"] = str(tmp)
        shutil.copy(cfg_path, tmp / "config.yaml")

        if args.env_file:
            env_p = Path(args.env_file).expanduser().resolve()
            if not env_p.is_file():
                print(f"ERROR: --env file not found: {env_p}", file=sys.stderr)
                return 1
            _load_env_file(env_p)

        # Import only after HERMES_HOME points at our temp dir.
        _clear_config_caches()
        import hermes_cli.config as hc

        merged = hc.load_config()
        model_merged = merged.get("model") or {}
        print("\n=== After load_config() merge + normalize (model keys) ===")
        if not isinstance(model_merged, dict):
            print(f"  (unexpected: model is {type(model_merged).__name__})")
        else:
            for k in sorted(model_merged.keys()):
                v = model_merged[k]
                lk = k.lower()
                if "key" in lk or "secret" in lk or "password" in lk:
                    v = "<redacted>" if v else v
                print(f"  {k}: {v!r}")

        if args.skip_resolve:
            print("\n=== resolve_runtime_provider() ===")
            print("  (skipped --skip-resolve)")
            return 0

        print("\n=== resolve_runtime_provider() ===")
        from hermes_cli.runtime_provider import resolve_runtime_provider

        try:
            rt = resolve_runtime_provider()
        except Exception as e:
            print(f"  FAILED: {e}")
            if args.traceback:
                traceback.print_exc()
            return 1 if args.strict else 0

        for k in sorted(rt.keys()):
            v = rt[k]
            if k == "api_key" and v:
                s = str(v)
                print(f"  {k}: <set, length {len(s)}>")
            else:
                print(f"  {k}: {v!r}")

    finally:
        if args.keep_hermes_home:
            print(f"\n(temp HERMES_HOME kept at {tmp})")
        else:
            shutil.rmtree(tmp, ignore_errors=True)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
