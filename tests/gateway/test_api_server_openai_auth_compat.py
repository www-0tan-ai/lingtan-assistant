"""OpenAI-compat routes accept API_SERVER_KEY or a valid cloud-sync access token."""

from unittest.mock import MagicMock

import pytest

from gateway.config import PlatformConfig
from gateway.platforms.api_server import APIServerAdapter


@pytest.fixture
def adapter_with_key() -> APIServerAdapter:
    key = "k" * 32
    return APIServerAdapter(PlatformConfig(enabled=True, extra={"host": "127.0.0.1", "key": key}))


def test_openai_compat_accepts_matching_api_key(adapter_with_key: APIServerAdapter):
    req = MagicMock()
    req.headers = {"Authorization": f"Bearer {adapter_with_key._api_key}"}
    assert adapter_with_key._check_auth_openai_compat(req) is None


def test_openai_compat_accepts_valid_user_access_token(adapter_with_key: APIServerAdapter):
    adapter_with_key._cloud_sync_store.resolve_access_token = MagicMock(
        return_value={"user_id": "u1", "email": "a@b.c"},
    )
    req = MagicMock()
    req.headers = {"Authorization": "Bearer user-access-token-xyz"}
    assert adapter_with_key._check_auth_openai_compat(req) is None
    adapter_with_key._cloud_sync_store.resolve_access_token.assert_called_once_with(
        "user-access-token-xyz",
    )


def test_openai_compat_rejects_unknown_bearer(adapter_with_key: APIServerAdapter):
    adapter_with_key._cloud_sync_store.resolve_access_token = MagicMock(return_value=None)
    req = MagicMock()
    req.headers = {"Authorization": "Bearer not-a-valid-token"}
    resp = adapter_with_key._check_auth_openai_compat(req)
    assert resp is not None
    assert resp.status == 401
