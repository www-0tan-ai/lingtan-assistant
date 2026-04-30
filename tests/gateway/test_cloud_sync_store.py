from pathlib import Path

from gateway.cloud_sync_store import CloudSyncStore


def test_register_login_refresh_and_revoke(tmp_path: Path) -> None:
    store = CloudSyncStore(db_path=str(tmp_path / "cloud_sync.db"))

    user = store.register_user("demo@example.com", "password123")
    assert user["email"] == "demo@example.com"

    auth_user = store.authenticate_user("demo@example.com", "password123")
    assert auth_user is not None
    assert auth_user["user_id"] == user["user_id"]

    session = store.create_session(user["user_id"])
    token_data = store.resolve_access_token(session["access_token"])
    assert token_data is not None
    assert token_data["user_id"] == user["user_id"]

    refreshed = store.refresh_session(session["refresh_token"])
    assert refreshed is not None
    assert store.resolve_access_token(refreshed["access_token"]) is not None

    assert store.revoke_access_token(refreshed["access_token"]) is True
    assert store.resolve_access_token(refreshed["access_token"]) is None


def test_device_registration_and_sync_roundtrip(tmp_path: Path) -> None:
    store = CloudSyncStore(db_path=str(tmp_path / "cloud_sync.db"))
    user = store.register_user("sync@example.com", "password123")
    user_id = user["user_id"]

    device = store.register_device(user_id, name="dev-laptop", os_name="windows")
    assert device["device_id"]
    assert len(store.list_devices(user_id)) == 1
    assert store.heartbeat_device(user_id, device["device_id"]) is True

    accepted, rejected, next_cursor = store.push_events(
        user_id,
        [
            {
                "event_id": "evt-1",
                "object_type": "report",
                "object_id": "rep-1",
                "op": "upsert",
                "payload": {"summary": "ok"},
            }
        ],
    )
    assert accepted == ["evt-1"]
    assert rejected == []
    assert next_cursor >= 1

    events, cursor = store.pull_events(user_id, 0, limit=10)
    assert len(events) == 1
    assert events[0]["payload"]["summary"] == "ok"
    assert cursor == events[-1]["event_version"]
