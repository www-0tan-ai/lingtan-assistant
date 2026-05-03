"""Lingtan default Hermes session id + tenant checks for ``lingtan-*`` SessionDB threads."""

from unittest.mock import MagicMock

import pytest

from gateway.config import PlatformConfig
from gateway.platforms.api_server import APIServerAdapter, _lingtan_default_chat_session_id


def test_lingtan_default_session_id_stable_per_user():
    a = _lingtan_default_chat_session_id("user-abc")
    b = _lingtan_default_chat_session_id("user-abc")
    assert a == b
    assert a.startswith("lingtan-")
    assert _lingtan_default_chat_session_id("other") != a


@pytest.fixture
def adapter_with_key() -> APIServerAdapter:
    key = "k" * 32
    return APIServerAdapter(PlatformConfig(enabled=True, extra={"host": "127.0.0.1", "key": key}))


def test_lingtan_session_ownership_denies_cross_user_jwt(adapter_with_key: APIServerAdapter):
    adapter = adapter_with_key
    uid = "u-own"
    sid_ok = _lingtan_default_chat_session_id(uid)
    sid_bad = _lingtan_default_chat_session_id("u-other")

    adapter._cloud_sync_store.resolve_access_token = MagicMock(return_value={"user_id": uid})
    req = MagicMock()
    req.headers = {"Authorization": "Bearer jwt-token"}

    deny = adapter._enforce_lingtan_assigned_session_ownership(req, sid_bad)
    assert deny is not None
    assert deny.status == 403

    allow = adapter._enforce_lingtan_assigned_session_ownership(req, sid_ok)
    assert allow is None


def test_lingtan_session_ownership_api_server_key_bypasses_tenancy(adapter_with_key: APIServerAdapter):
    adapter = adapter_with_key
    sid_bad = _lingtan_default_chat_session_id("someone-else")

    req = MagicMock()
    req.headers = {"Authorization": f"Bearer {adapter._api_key}"}

    allow = adapter._enforce_lingtan_assigned_session_ownership(req, sid_bad)
    assert allow is None
