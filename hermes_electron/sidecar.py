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
import sys
import threading
import time
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

    @app.get("/api/desktop-config")
    async def desktop_config() -> dict:
        """Surface bootstrap config (API_BASE, app metadata) to the renderer.

        ``HERMES_DESKTOP_API_BASE`` lets a bundled build pre-populate the cloud
        endpoint shown on the login screen so end-users don't have to know the
        URL. Empty value keeps the renderer in local-only mode.
        """
        api_base = (os.environ.get("HERMES_DESKTOP_API_BASE") or "").strip().rstrip("/")
        return {
            "api_base_default": api_base,
            "app_name": "0tan",
            "version": os.environ.get("HERMES_DESKTOP_VERSION", "0.1.0"),
        }

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

    def _serve() -> None:
        import uvicorn

        uvicorn.run(
            app,
            host="127.0.0.1",
            port=port,
            log_level="warning",
            access_log=False,
        )

    # READY must be emitted only after the port accepts connections; otherwise
    # Electron often hits ERR_NETWORK_CHANGED / connection refused on Windows.
    th = threading.Thread(target=_serve, name="hermes-electron-uvicorn", daemon=False)
    th.start()

    deadline = time.monotonic() + 30.0
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.25):
                pass
            break
        except OSError:
            time.sleep(0.05)
        if not th.is_alive():
            print(
                "HERMES_ELECTRON_ERR uvicorn thread exited before listen",
                file=sys.stderr,
                flush=True,
            )
            raise SystemExit(1)
    else:
        print("HERMES_ELECTRON_ERR timeout waiting for port to listen", file=sys.stderr, flush=True)
        raise SystemExit(1)

    print(f"HERMES_ELECTRON_READY{line}", flush=True)
    th.join()


if __name__ == "__main__":
    main()
