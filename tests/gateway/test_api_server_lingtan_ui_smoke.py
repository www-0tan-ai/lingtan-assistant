"""Smoke: routes used by 灵碳 Web UI return expected JSON shapes."""

import uuid

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from gateway.config import PlatformConfig
from gateway.platforms.api_server import APIServerAdapter, _lingtan_default_chat_session_id


def _lingtan_web_routes_app(adapter: APIServerAdapter) -> web.Application:
    """Minimal app: auth + assistant + workspaces (no background sweep)."""
    app = web.Application()
    app["api_server_adapter"] = adapter
    app.router.add_post("/v1/auth/register", adapter._handle_auth_register)
    app.router.add_post("/v1/auth/login", adapter._handle_auth_login)
    app.router.add_get("/v1/workspaces", adapter._handle_workspaces_list)
    app.router.add_get("/v1/assistant/skills", adapter._handle_assistant_skills)
    app.router.add_get("/v1/assistant/agents", adapter._handle_assistant_agents)
    app.router.add_get("/v1/assistant/chat-session/default", adapter._handle_assistant_chat_session_default)
    app.router.add_get("/v1/assistant/conversation", adapter._handle_assistant_conversation)
    return app


@pytest.mark.asyncio
async def test_lingtan_ui_routes_json_shapes(tmp_path):
    db = tmp_path / "cloud_sync.sqlite"
    api_key = "k" * 32
    adapter = APIServerAdapter(
        PlatformConfig(
            enabled=True,
            extra={
                "host": "127.0.0.1",
                "key": api_key,
                "cloud_sync_db_path": str(db),
            },
        ),
    )
    app = _lingtan_web_routes_app(adapter)
    uid_short = uuid.uuid4().hex[:10]
    email = f"smoke-{uid_short}@example.com"
    password = "password123"

    async with TestClient(TestServer(app)) as cli:
        reg = await cli.post("/v1/auth/register", json={"email": email, "password": password})
        assert reg.status == 201, await reg.text()
        reg_body = await reg.json()
        user_id = reg_body["user_id"]
        assert reg_body.get("default_workspace_id")

        unauth = await cli.get("/v1/assistant/skills")
        assert unauth.status == 401

        log = await cli.post("/v1/auth/login", json={"email": email, "password": password})
        assert log.status == 200, await log.text()
        body = await log.json()
        token = body["access_token"]

        user_hdr = {"Authorization": f"Bearer {token}"}
        key_hdr = {"Authorization": f"Bearer {api_key}"}

        sk_user = await cli.get("/v1/assistant/skills", headers=user_hdr)
        assert sk_user.status == 200, await sk_user.text()
        ski = await sk_user.json()
        assert ski.get("success") is True
        assert isinstance(ski.get("skills"), list)

        sk_key = await cli.get("/v1/assistant/skills", headers=key_hdr)
        assert sk_key.status == 200
        assert (await sk_key.json()).get("success") is True

        ag = await cli.get("/v1/assistant/agents", headers=user_hdr)
        assert ag.status == 200, await ag.text()
        agi = await ag.json()
        assert agi.get("object") == "lingtan.agent_roster"
        assert isinstance(agi.get("agents"), list)

        ws = await cli.get("/v1/workspaces", headers=user_hdr)
        assert ws.status == 200, await ws.text()
        wsi = await ws.json()
        wlist = wsi.get("workspaces")
        assert isinstance(wlist, list)
        assert len(wlist) >= 1
        assert any(w.get("is_default") for w in wlist)
        assert all("workspace_id" in w for w in wlist)

        ds = await cli.get("/v1/assistant/chat-session/default", headers=user_hdr)
        assert ds.status == 200, await ds.text()
        dsi = await ds.json()
        assert dsi.get("object") == "lingtan.chat_session"
        sid = dsi.get("session_id")
        assert sid and sid.startswith("lingtan-")
        assert sid == _lingtan_default_chat_session_id(user_id)

        conv = await cli.get("/v1/assistant/conversation", params={"session_id": sid}, headers=user_hdr)
        assert conv.status == 200, await conv.text()
        cov = await conv.json()
        assert cov.get("session_id") == sid
        assert isinstance(cov.get("messages"), list)
