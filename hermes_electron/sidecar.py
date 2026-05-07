"""
Minimal loopback server for the Electron shell: static UI + ``/api/ws``.

Run with env ``HERMES_ELECTRON_RENDERER`` pointing at the ``electron/renderer``
directory. Prints one line to stdout for the Electron main process::

    HERMES_ELECTRON_READY{"port":<int>,"token":"<str>"}
"""

from __future__ import annotations

import hmac
import json
import os
import secrets
import socket
from pathlib import Path

from fastapi import FastAPI, WebSocket
from fastapi.staticfiles import StaticFiles

_LOOPBACK = frozenset({"127.0.0.1", "::1", "localhost", "", "testclient"})


def _pick_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return int(port)


def _build_app(static_dir: Path, token: str) -> FastAPI:
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @app.websocket("/api/ws")
    async def gateway_ws(ws: WebSocket) -> None:
        qtok = ws.query_params.get("token", "")
        if not hmac.compare_digest(qtok.encode("utf-8"), token.encode("utf-8")):
            await ws.close(code=4401)
            return
        host = ws.client.host if ws.client else ""
        if host and host not in _LOOPBACK:
            await ws.close(code=4403)
            return

        from tui_gateway.ws import handle_ws

        await handle_ws(ws)

    app.mount(
        "/",
        StaticFiles(directory=str(static_dir), html=True),
        name="ui",
    )
    return app


def main() -> None:
    raw = (os.environ.get("HERMES_ELECTRON_RENDERER") or "").strip()
    if not raw:
        raise SystemExit(
            "HERMES_ELECTRON_RENDERER must be set to the electron/renderer directory"
        )
    static_dir = Path(raw).resolve()
    if not static_dir.is_dir():
        raise SystemExit(f"HERMES_ELECTRON_RENDERER is not a directory: {static_dir}")

    port = _pick_port()
    token = secrets.token_urlsafe(32)
    app = _build_app(static_dir, token)

    line = json.dumps({"port": port, "token": token}, separators=(",", ":"))
    print(f"HERMES_ELECTRON_READY{line}", flush=True)

    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning", access_log=False)


if __name__ == "__main__":
    main()
