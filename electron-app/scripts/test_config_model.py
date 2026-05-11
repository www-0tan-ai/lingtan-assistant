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

Use --json to print one JSON object on stdout (raw_model, merged_model, resolve);
human-readable blocks are omitted so you can pipe to jq or save to a file.

Prove end-to-end config + keys with a real model call:

  .venv\\Scripts\\python.exe electron-app\\scripts\\test_config_model.py --env %USERPROFILE%\\.hermes\\.env --ping-model --strict
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
import traceback
from pathlib import Path
from typing import Any, Dict, Tuple, Union


def _repo_root() -> Path:
    # electron-app/scripts/test_config_model.py -> repo root
    return Path(__file__).resolve().parent.parent.parent


def _clear_config_caches() -> None:
    import hermes_cli.config as hc

    hc._LOAD_CONFIG_CACHE.clear()
    hc._RAW_CONFIG_CACHE.clear()
    hc._LAST_EXPANDED_CONFIG_BY_PATH.clear()


def _json_safe_model(d: object) -> object:
    if not isinstance(d, dict):
        return d
    out = {}
    for k, v in d.items():
        lk = str(k).lower()
        if "key" in lk or "secret" in lk or "password" in lk:
            out[k] = f"<redacted len={len(str(v))}>" if v else v
        else:
            out[k] = v
    return out


def _json_safe_runtime(rt: dict) -> dict:
    """Strip non-JSON-serializable objects from resolve_runtime_provider result."""
    out = {}
    for k, v in rt.items():
        if k == "api_key":
            out[k] = (f"<set len={len(str(v))}>" if v else "")
        elif k == "credential_pool":
            out[k] = bool(v)
        else:
            try:
                json.dumps(v)
                out[k] = v
            except (TypeError, ValueError):
                out[k] = repr(v)
    return out


def _extract_responses_text(resp: Any) -> str:
    """Best-effort assistant text from OpenAI SDK Responses object."""
    chunks: list[str] = []
    output = getattr(resp, "output", None) or []
    for item in output:
        if getattr(item, "type", None) != "message":
            continue
        for part in getattr(item, "content", None) or []:
            ptype = getattr(part, "type", None)
            if ptype == "output_text":
                chunks.append(str(getattr(part, "text", "") or ""))
            elif isinstance(part, dict) and part.get("type") == "output_text":
                chunks.append(str(part.get("text") or ""))
    return "".join(chunks).strip()


def _ping_model_live(
    rt: Dict[str, Any],
    model_id: str,
    *,
    timeout: float,
) -> Tuple[bool, str]:
    """Send one minimal user message; return (ok, reply_text_or_error)."""
    api_mode = str(rt.get("api_mode") or "chat_completions").strip()
    base_url = str(rt.get("base_url") or "").strip().rstrip("/")
    api_key = str(rt.get("api_key") or "").strip()
    if not model_id:
        return False, "merged config has no model.default — set model.default in config.yaml"
    if not base_url or not api_key:
        return False, "resolved runtime missing base_url or api_key"

    try:
        from openai import OpenAI
    except ImportError:
        return False, "openai package not installed (pip install openai)"

    client = OpenAI(base_url=base_url, api_key=api_key, timeout=timeout)
    prompt = "Reply with exactly one word: pong"

    try:
        if api_mode == "codex_responses":
            from agent.transports.codex import ResponsesApiTransport

            transport = ResponsesApiTransport()
            kwargs = transport.build_kwargs(
                model=model_id,
                messages=[{"role": "user", "content": prompt}],
                tools=None,
                session_id="test_config_model_ping",
                max_tokens=96,
                is_github_responses=False,
                is_codex_backend=False,
                is_xai_responses=False,
                instructions=(
                    "You are a connectivity check. Follow the user format exactly; "
                    "output only the requested word, no punctuation or explanation."
                ),
            )
            if kwargs.get("tools") is None:
                kwargs.pop("tool_choice", None)
                kwargs.pop("parallel_tool_calls", None)
                kwargs.pop("tools", None)
            # Azure Foundry rejects explicit null for optional fields (e.g. tools must be array or omitted).
            kwargs = {k: v for k, v in kwargs.items() if v is not None}
            resp = client.responses.create(**kwargs)
            text = _extract_responses_text(resp)
            if not text:
                return False, f"empty model output (raw output items: {len(getattr(resp, 'output', None) or [])})"
            return True, text

        if api_mode == "anthropic_messages":
            return (
                False,
                "api_mode=anthropic_messages is not covered by --ping-model "
                "(OpenAI-compatible chat/codex only)",
            )

        # chat_completions (default)
        try:
            cr = client.chat.completions.create(
                model=model_id,
                messages=[{"role": "user", "content": prompt}],
                max_completion_tokens=64,
            )
        except TypeError:
            cr = client.chat.completions.create(
                model=model_id,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=64,
            )
        msg = cr.choices[0].message
        text = (getattr(msg, "content", None) or "").strip()
        if not text:
            return False, "empty chat completion content"
        return True, text
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"


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
    parser.add_argument(
        "--json",
        action="store_true",
        dest="json_out",
        help="Print a single JSON result on stdout (omit human-readable sections)",
    )
    parser.add_argument(
        "--ping-model",
        action="store_true",
        help="After resolve, send one minimal completion to prove base_url + key + model id work",
    )
    parser.add_argument(
        "--ping-timeout",
        type=float,
        default=120.0,
        metavar="SEC",
        help="Timeout seconds for --ping-model (default: 120)",
    )
    args = parser.parse_args()

    if args.skip_resolve and args.ping_model:
        print("ERROR: --ping-model cannot be used with --skip-resolve", file=sys.stderr)
        return 2

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
    if not args.json_out:
        print("=== Raw YAML: model ===")
        if raw_model is None:
            print("  (missing top-level 'model:' — Hermes will use defaults from DEFAULT_CONFIG only)")
        elif isinstance(raw_model, dict):
            for k in sorted(raw_model.keys()):
                print(f"  {k}: {raw_model[k]!r}")
        else:
            print(f"  (unexpected type {type(raw_model).__name__!r}, value {raw_model!r})")

    tmp = Path(tempfile.mkdtemp(prefix="lingtan-config-test-"))
    json_payload: dict = {
        "config_path": str(cfg_path),
        "raw_model": raw_model if isinstance(raw_model, (dict, type(None))) else repr(raw_model),
    }
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
        json_payload["merged_model"] = _json_safe_model(
            model_merged if isinstance(model_merged, dict) else {"_error": type(model_merged).__name__}
        )

        if not args.json_out:
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
            json_payload["resolve"] = {"skipped": True}
            if args.json_out:
                print(json.dumps(json_payload, ensure_ascii=False, indent=2))
            else:
                print("\n=== resolve_runtime_provider() ===")
                print("  (skipped --skip-resolve)")
            return 0

        if not args.json_out:
            print("\n=== resolve_runtime_provider() ===")
        from hermes_cli.runtime_provider import resolve_runtime_provider

        try:
            rt = resolve_runtime_provider()
        except Exception as e:
            json_payload["resolve"] = {"ok": False, "error": str(e)}
            if args.json_out:
                print(json.dumps(json_payload, ensure_ascii=False, indent=2))
            else:
                print(f"  FAILED: {e}")
                if args.traceback:
                    traceback.print_exc()
            return 1 if args.strict else 0

        json_payload["resolve"] = {"ok": True, "runtime": _json_safe_runtime(rt)}

        if not args.json_out:
            for k in sorted(rt.keys()):
                v = rt[k]
                if k == "api_key" and v:
                    s = str(v)
                    print(f"  {k}: <set, length {len(s)}>")
                else:
                    print(f"  {k}: {v!r}")

        if args.ping_model:
            mid = (
                str(model_merged.get("default") or "").strip()
                if isinstance(model_merged, dict)
                else ""
            )
            if not args.json_out:
                print("\n=== --ping-model (live request) ===")
            ok, detail = _ping_model_live(rt, mid, timeout=args.ping_timeout)
            ping_obj: Dict[str, Union[bool, str, None]] = {
                "ok": ok,
                "model": mid or None,
                "reply_preview": detail[:400] if ok else None,
                "error": None if ok else detail,
            }
            json_payload["ping_model"] = ping_obj
            if not args.json_out:
                if ok:
                    print(f"  OK - model replied (preview): {detail[:400]!r}")
                else:
                    print(f"  FAILED: {detail}")
            if args.json_out:
                print(json.dumps(json_payload, ensure_ascii=False, indent=2))
            if not ok:
                return 1 if args.strict else 0
        elif args.json_out:
            print(json.dumps(json_payload, ensure_ascii=False, indent=2))

    finally:
        if args.keep_hermes_home:
            msg = f"\n(temp HERMES_HOME kept at {tmp})"
            print(msg, file=sys.stderr if args.json_out else sys.stdout)
        else:
            shutil.rmtree(tmp, ignore_errors=True)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
