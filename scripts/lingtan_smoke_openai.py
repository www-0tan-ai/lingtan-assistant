#!/usr/bin/env python3
"""Minimal OpenAI-compatible chat.completions probe for Lingtan / Azure Foundry.

Reads (in order):
  - deploy/.env if present (KEY=VALUE lines, no export)
  - process environment
  - deploy/hermes-docker/config.yaml for model.default + model.base_url

API key: CUSTOM_API_KEY, then OPENAI_API_KEY.

Usage (from repo root):
  .venv/Scripts/python.exe scripts/lingtan_smoke_openai.py
  # or with explicit env:
  set CUSTOM_API_KEY=... && set HERMES_BASE_URL=... && python scripts/lingtan_smoke_openai.py
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DEPLOY_ENV = REPO / "deploy" / ".env"
HERMES_DOTENV = Path.home() / ".hermes" / ".env"
CONFIG_YAML = REPO / "deploy" / "hermes-docker" / "config.yaml"


def _parse_dotenv(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.is_file():
        return out
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        k, _, v = line.partition("=")
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if k:
            out[k] = v
    return out


def _read_yaml_model(repo: Path) -> tuple[str, str]:
    default, base_url = "", ""
    if not CONFIG_YAML.is_file():
        return default, base_url
    text = CONFIG_YAML.read_text(encoding="utf-8", errors="replace")
    m_def = re.search(r"^\s*default:\s*[\"']?([^\"'\n#]+)", text, re.MULTILINE)
    m_url = re.search(r"^\s*base_url:\s*[\"']?([^\"'\n#]+)", text, re.MULTILINE)
    if m_def:
        default = m_def.group(1).strip().strip('"').strip("'")
    if m_url:
        base_url = m_url.group(1).strip().strip('"').strip("'")
    return default, base_url


def main() -> int:
    # Merge file-backed env: deploy/.env then ~/.hermes/.env (do not override os.environ)
    merged: dict[str, str] = {}
    merged.update(_parse_dotenv(DEPLOY_ENV))
    for k, v in _parse_dotenv(HERMES_DOTENV).items():
        merged.setdefault(k, v)

    def pick(*keys: str) -> str:
        for k in keys:
            v = os.environ.get(k) or merged.get(k) or ""
            if v:
                return v
        return ""

    api_key = pick("CUSTOM_API_KEY", "OPENAI_API_KEY")
    base_url = pick("HERMES_BASE_URL", "OPENAI_BASE_URL") or _read_yaml_model(REPO)[1]
    model = pick("HERMES_DEFAULT_MODEL") or _read_yaml_model(REPO)[0]

    if not base_url:
        print("FAIL: no base_url (set HERMES_BASE_URL or add model.base_url in deploy/hermes-docker/config.yaml)", file=sys.stderr)
        return 2
    if not api_key:
        print("FAIL: no API key (set CUSTOM_API_KEY or OPENAI_API_KEY in deploy/.env or environment)", file=sys.stderr)
        return 2
    if not model:
        print("FAIL: no model id (set HERMES_DEFAULT_MODEL or model.default in config.yaml)", file=sys.stderr)
        return 2

    print(f"Probe: base_url={base_url}")
    print(f"Probe: model={model}")
    print(f"Probe: api_key={'set (' + str(len(api_key)) + ' chars)' if api_key else 'missing'}")

    try:
        from openai import OpenAI
    except ImportError:
        print("FAIL: openai package not installed (use repo .venv)", file=sys.stderr)
        return 2

    client = OpenAI(api_key=api_key, base_url=base_url.rstrip("/"))
    # Strict Azure-friendly body: no reasoning / extra_body.
    # Some Azure OpenAI / Foundry deployments reject max_tokens — use max_completion_tokens.
    kwargs = dict(
        model=model,
        messages=[{"role": "user", "content": "Reply with exactly: OK"}],
        temperature=0,
        timeout=60.0,
    )
    bu = base_url.lower()
    if "azure.com" in bu or "openai.azure.com" in bu:
        kwargs["max_completion_tokens"] = 16
    else:
        kwargs["max_tokens"] = 16

    try:
        resp = client.chat.completions.create(**kwargs)
    except Exception as e:
        err = str(e)
        if "max_completion_tokens" in err and "max_tokens" in err:
            kwargs.pop("max_tokens", None)
            kwargs["max_completion_tokens"] = 16
            try:
                resp = client.chat.completions.create(**kwargs)
            except Exception as e2:
                print(f"FAIL: request error: {type(e2).__name__}: {e2}", file=sys.stderr)
                return 1
        else:
            print(f"FAIL: request error: {type(e).__name__}: {e}", file=sys.stderr)
            return 1

    try:
        content = (resp.choices[0].message.content or "").strip()
    except (AttributeError, IndexError) as e:
        print(f"FAIL: unexpected response shape: {e!r}", file=sys.stderr)
        print(json.dumps(resp.model_dump() if hasattr(resp, "model_dump") else str(resp))[:2000], file=sys.stderr)
        return 1

    print(f"OK: assistant reply (first 200 chars): {content[:200]!r}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
