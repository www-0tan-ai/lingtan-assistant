#!/usr/bin/env python3
"""Probe OpenAI-compatible ``/chat/completions`` (Azure / custom ``HERMES_BASE_URL``).

- **No secrets** in this file. Set ``HERMES_BASE_URL`` and ``CUSTOM_API_KEY`` or
  ``OPENAI_API_KEY`` in the environment, or place them in ``deploy/.env`` (not
  committed) for local runs.
- Tries ``api-key`` header first (typical Azure), then ``Authorization: Bearer``.
- Marked ``integration`` — excluded from the default ``pytest -m 'not integration'`` CI run.

**Pytest**

```bash
python -m pytest tests/integration/test_custom_inference_env_connectivity.py -m integration --override-ini="addopts="
```

**Direct run** (loads ``deploy/.env`` if present and vars are not already set):

```bash
python tests/integration/test_custom_inference_env_connectivity.py
```
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

pytestmark = pytest.mark.integration


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _maybe_load_deploy_dotenv() -> None:
    env_path = _repo_root() / "deploy" / ".env"
    if not env_path.is_file():
        return
    try:
        from dotenv import dotenv_values
    except ImportError:
        return
    for key, val in dotenv_values(env_path).items():
        if not key or val is None:
            continue
        s = str(val).strip()
        if s and key not in os.environ:
            os.environ[key] = s


def _resolve_base_key_model() -> tuple[str, str, str]:
    _maybe_load_deploy_dotenv()
    base = (os.environ.get("HERMES_BASE_URL") or "").strip().rstrip("/")
    key = (
        (os.environ.get("CUSTOM_API_KEY") or "").strip()
        or (os.environ.get("OPENAI_API_KEY") or "").strip()
    )
    model = (os.environ.get("HERMES_DEFAULT_MODEL") or "gpt-4o-mini").strip()
    return base, key, model


def _missing_creds() -> bool:
    _maybe_load_deploy_dotenv()
    b, k, _m = _resolve_base_key_model()
    return not (b and k)


def probe_chat_completions() -> tuple[bool, str]:
    try:
        import httpx
    except ImportError as exc:
        return False, f"httpx import failed: {exc}"

    base, key, model = _resolve_base_key_model()
    if not base:
        return False, "HERMES_BASE_URL is unset"
    if not key:
        return False, "CUSTOM_API_KEY or OPENAI_API_KEY is unset"

    url = f"{base}/chat/completions"
    body: dict = {
        "model": model,
        "messages": [{"role": "user", "content": "Reply with the single word: ok"}],
    }
    # GPT-5 / some Azure deployments reject ``max_tokens``; keep payload minimal.
    ml = model.lower()
    if any(x in ml for x in ("gpt-5", "o1", "o3", "o4")):
        body["max_completion_tokens"] = 32
    else:
        body["max_tokens"] = 32

    attempts: list[tuple[str, dict[str, str]]] = [
        ("api-key", {"Content-Type": "application/json", "api-key": key}),
        ("Authorization: Bearer", {"Content-Type": "application/json", "Authorization": f"Bearer {key}"}),
    ]

    last = ""
    for label, headers in attempts:
        try:
            r = httpx.post(url, headers=headers, json=body, timeout=120.0)
        except Exception as exc:
            last = f"{label}: request error: {exc}"
            continue
        snippet = (r.text or "")[:800]
        last = f"{label}: HTTP {r.status_code} body={snippet!r}"
        if r.status_code == 200:
            try:
                data = r.json()
            except json.JSONDecodeError:
                return False, f"{label}: 200 but body is not JSON"
            choices = data.get("choices")
            if isinstance(choices, list) and choices:
                msg = data["choices"][0].get("message", {}) if isinstance(data["choices"][0], dict) else {}
                content = msg.get("content", "") if isinstance(msg, dict) else ""
                return True, f"{label}: ok model={model!r} assistant_preview={content!r}"[:600]
            return False, f"{label}: 200 but no choices: {str(data)[:400]}"
        if r.status_code != 401:
            return False, last
    return False, last


@pytest.mark.skipif(_missing_creds(), reason="HERMES_BASE_URL and API key not configured")
def test_custom_openai_compatible_chat_completions():
    ok, msg = probe_chat_completions()
    assert ok, msg


if __name__ == "__main__":
    _maybe_load_deploy_dotenv()
    ok, msg = probe_chat_completions()
    print(msg)
    sys.exit(0 if ok else 1)
