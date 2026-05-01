from pathlib import Path

import pytest

from sync.local_store import LocalSyncStore


def test_local_outbox_enqueue_idempotent(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    hh = tmp_path / ".hm"
    hh.mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(hh))
    db_path = hh / "outbox_only.db"

    ls = LocalSyncStore(db_path=str(db_path))
    ev = {"event_id": "e1", "object_type": "t", "object_id": "o", "payload": {}}
    assert ls.enqueue_event(ev) is True
    assert ls.enqueue_event(ev) is False
    rows = ls.list_outbox_rows()
    assert len(rows) == 1
    ls.delete_outbox_id(int(rows[0]["id"]))
    assert not ls.list_outbox_rows()


def test_local_cursor(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    hh = tmp_path / ".hm2"
    hh.mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(hh))

    ls = LocalSyncStore(db_path=str(hh / "c.db"))
    assert ls.get_cursor("k") == 0
    ls.set_cursor("k", 12)
    assert ls.get_cursor("k") == 12
