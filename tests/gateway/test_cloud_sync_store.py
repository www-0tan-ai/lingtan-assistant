from pathlib import Path

from gateway.cloud_sync_store import CloudSyncStore


def test_register_login_refresh_and_revoke(tmp_path: Path) -> None:
    store = CloudSyncStore(db_path=str(tmp_path / "cloud_sync.db"))

    user = store.register_user("demo@example.com", "password123")
    assert user["email"] == "demo@example.com"
    assert user.get("default_workspace_id")

    ws = store.get_default_workspace_id(user["user_id"])
    assert ws == user["default_workspace_id"]

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
        device_id=device["device_id"],
    )
    assert accepted == ["evt-1"]
    assert rejected == []
    assert next_cursor >= 1

    events, cursor = store.pull_events(user_id, 0, limit=10)
    assert len(events) == 1
    assert events[0]["payload"]["summary"] == "ok"
    assert cursor == events[-1]["event_version"]


def test_collector_tasks_and_reports(tmp_path: Path) -> None:
    store = CloudSyncStore(db_path=str(tmp_path / "cloud_sync.db"))
    user = store.register_user("tasks@example.com", "password123")
    uid = user["user_id"]
    ws = user["default_workspace_id"]
    row = store.create_collector_task(
        uid, ws, name="scan ~/data", source_type="file", config={"glob": "*.csv"}
    )
    tid = row["task_id"]
    listings = store.list_collector_tasks(uid, ws)
    assert len(listings) == 1 and listings[0]["task_id"] == tid

    run = store.run_collector_task(uid, ws, tid)
    assert run and run["ok"]

    rep = store.create_report(uid, ws, summary="hello", tags=["a"], score=0.42)
    assert rep["report_id"]
    fetched = store.get_report(uid, rep["report_id"])
    assert fetched and fetched["summary"] == "hello"
    assert len(store.list_reports(uid, ws, limit=5)) >= 1


def test_push_version_conflict(tmp_path: Path) -> None:
    store = CloudSyncStore(db_path=str(tmp_path / "cloud_sync.db"))
    user = store.register_user("conflict@example.com", "password123")["user_id"]
    ws = store.get_default_workspace_id(user)
    device = store.register_device(user, "d", "linux", device_id="dev-static")
    acc, rej, cur = store.push_events(
        user,
        [{"event_id": "a1", "object_type": "x", "object_id": "o1", "op": "upsert", "payload": {"v": 1}}],
        device_id=device["device_id"],
    )
    assert acc == ["a1"] and not rej

    acc2, rej2, cur2 = store.push_events(
        user,
        [
            {
                "event_id": "a2",
                "object_type": "x",
                "object_id": "o1",
                "op": "upsert",
                "client_version": 0,
                "payload": {"v": 2},
            },
        ],
        device_id=device["device_id"],
    )
    assert acc2 == []
    assert any(r.get("reason") == "version_conflict" for r in rej2)
