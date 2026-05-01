import json
import os
import sqlite3
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from hermes_constants import get_hermes_home


def _now() -> int:
    return int(time.time())


class LocalSyncStore:
    """SQLite outbox + cursor for Lingtan resilient push sync."""

    def __init__(self, db_path: Optional[str] = None):
        root = Path(get_hermes_home())
        os.makedirs(root, exist_ok=True)
        self._db_path = str(Path(db_path).expanduser()) if db_path else str(root / "local_sync.db")
        self._init()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init(self) -> None:
        os.makedirs(str(Path(self._db_path).parent), exist_ok=True)
        with self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS outbox (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_id TEXT NOT NULL UNIQUE,
                    payload TEXT NOT NULL,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT,
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_outbox_created ON outbox(created_at);
                CREATE TABLE IF NOT EXISTS meta (
                    k TEXT PRIMARY KEY,
                    v TEXT NOT NULL
                );
                """
            )
            conn.commit()

    def enqueue_event(self, event: Dict[str, Any]) -> bool:
        eid = str(event.get("event_id") or "").strip()
        if not eid:
            raise ValueError("event.event_id required")
        payload = json.dumps(event, ensure_ascii=False)
        now = _now()
        with self._connect() as conn:
            try:
                conn.execute(
                    "INSERT INTO outbox (event_id, payload, created_at) VALUES (?, ?, ?)",
                    (eid, payload, now),
                )
                conn.commit()
                return True
            except sqlite3.IntegrityError:
                conn.commit()
                return False

    def list_outbox_rows(self, limit: int = 200) -> List[sqlite3.Row]:
        lim = max(1, min(2000, int(limit)))
        with self._connect() as conn:
            return list(
                conn.execute(
                    "SELECT id, event_id, payload, attempts FROM outbox ORDER BY created_at ASC, id ASC LIMIT ?",
                    (lim,),
                ).fetchall()
            )

    def delete_outbox_id(self, row_id: int) -> None:
        with self._connect() as conn:
            conn.execute("DELETE FROM outbox WHERE id = ?", (int(row_id),))
            conn.commit()

    def mark_outbox_attempt(self, row_id: int, attempts: int, error: Optional[str]) -> None:
        with self._connect() as conn:
            conn.execute(
                "UPDATE outbox SET attempts = ?, last_error = ? WHERE id = ?",
                (int(attempts), error, int(row_id)),
            )
            conn.commit()

    def get_cursor(self, key: str = "sync") -> int:
        with self._connect() as conn:
            row = conn.execute("SELECT v FROM meta WHERE k = ?", (key,)).fetchone()
            if row is None:
                return 0
            try:
                return max(0, int(row["v"]))
            except (TypeError, ValueError):
                return 0

    def set_cursor(self, key: str, cursor: int) -> None:
        sv = str(max(0, int(cursor)))
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
                (key, sv),
            )
            conn.commit()

    def decode_row(self, row: sqlite3.Row) -> Tuple[int, Dict[str, Any]]:
        return int(row["id"]), json.loads(row["payload"])
