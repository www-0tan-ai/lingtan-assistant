import pytest

from sync.client import ResilientCloudSync
from sync.local_store import LocalSyncStore


def _sample_event(event_id: str = "evt-1") -> dict:
    return {
        "event_id": event_id,
        "object_type": "analysis_report",
        "object_id": "r1",
        "op": "upsert",
        "payload": {"summary": "x"},
        "occurred_at": 1,
        "visibility": "aggregate_ok",
        "cloud_allow": True,
    }


def test_enqueue_ignores_transmit_gate_when_outbound_disabled(monkeypatch, tmp_path) -> None:
    monkeypatch.delenv("LINGTAN_SYNC_CLOUD_BASE_URL", raising=False)
    monkeypatch.delenv("CLOUD_SYNC_BASE_URL", raising=False)
    monkeypatch.setenv("LINGTAN_SYNC_OUTBOUND_ENABLED", "0")

    store = LocalSyncStore(str(tmp_path / "ldb.db"))
    hub = ResilientCloudSync(base_url="", store=store)
    ok = hub.enqueue(_sample_event())
    assert ok is True


@pytest.mark.parametrize("base_url", ["", None])
def test_flush_outbox_skips_without_upload_ready(monkeypatch, tmp_path, base_url) -> None:
    monkeypatch.delenv("LINGTAN_SYNC_CLOUD_BASE_URL", raising=False)
    monkeypatch.delenv("CLOUD_SYNC_BASE_URL", raising=False)
    monkeypatch.setenv("LINGTAN_SYNC_OUTBOUND_ENABLED", "1")

    store = LocalSyncStore(str(tmp_path / "ldb.db"))
    hub = ResilientCloudSync(base_url=base_url, store=store)
    assert hub.enqueue(_sample_event())

    summary = hub.flush_outbox(max_rows=10)
    assert summary["flushed"] == 0
    assert summary["pending"] == 1
    assert summary.get("skipped") == "offline_or_no_endpoint"


@pytest.mark.parametrize("base_url", ["", None])
def test_pull_skips_without_upload_ready(monkeypatch, tmp_path, base_url) -> None:
    monkeypatch.delenv("LINGTAN_SYNC_CLOUD_BASE_URL", raising=False)
    monkeypatch.delenv("CLOUD_SYNC_BASE_URL", raising=False)
    monkeypatch.setenv("LINGTAN_SYNC_OUTBOUND_ENABLED", "1")

    hub = ResilientCloudSync(base_url=base_url, store=LocalSyncStore(str(tmp_path / "ldb.db")))
    summary = hub.pull()
    assert summary.get("skipped") == "offline_or_no_endpoint"
    assert summary.get("next_cursor") == 0
