from gateway.cloud_sync_client import CloudSyncClient


def test_push_events_without_base_url_skips_http() -> None:
    c = CloudSyncClient(base_url="")
    resp = c.push_events(
        [
            {
                "event_id": "e1",
                "object_type": "analysis_report",
                "object_id": "r1",
                "op": "upsert",
                "payload": {},
            },
        ],
    )
    assert resp.get("skipped") == "no_cloud_endpoint"
    assert resp.get("accepted_event_ids") == []


def test_pull_events_without_base_url_returns_empty() -> None:
    c = CloudSyncClient(base_url="")
    r = c.pull_events(cursor=42, limit=5)
    assert r.get("skipped") == "no_cloud_endpoint"
    assert r["next_cursor"] == 42
    assert r.get("events") == []
