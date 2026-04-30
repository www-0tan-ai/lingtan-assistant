import hashlib
import json
import os
import secrets
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from hermes_constants import get_hermes_home


def _now_ts() -> int:
    return int(time.time())


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _hash_password(password: str, salt_hex: str) -> str:
    salt = bytes.fromhex(salt_hex)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 120_000)
    return digest.hex()


class CloudSyncStore:
    """SQLite-backed auth/device/sync store for API server MVP."""

    def __init__(self, db_path: Optional[str] = None):
        default_path = Path(get_hermes_home()) / "cloud_sync.db"
        self._db_path = str(Path(db_path).expanduser()) if db_path else str(default_path)
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        os.makedirs(str(Path(self._db_path).parent), exist_ok=True)
        with self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY,
                    email TEXT NOT NULL UNIQUE,
                    password_hash TEXT NOT NULL,
                    password_salt TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'active',
                    created_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS auth_sessions (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    device_id TEXT,
                    access_token_hash TEXT NOT NULL UNIQUE,
                    refresh_token_hash TEXT NOT NULL UNIQUE,
                    access_expires_at INTEGER NOT NULL,
                    refresh_expires_at INTEGER NOT NULL,
                    revoked_at INTEGER,
                    created_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS devices (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    name TEXT,
                    os TEXT,
                    status TEXT NOT NULL DEFAULT 'active',
                    last_seen_at INTEGER NOT NULL,
                    created_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS sync_events (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    event_version INTEGER NOT NULL,
                    object_type TEXT NOT NULL,
                    object_id TEXT NOT NULL,
                    op TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    occurred_at INTEGER NOT NULL,
                    created_at INTEGER NOT NULL
                );
                CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_events_user_event_id
                    ON sync_events (user_id, id);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_events_user_version
                    ON sync_events (user_id, event_version);

                CREATE TABLE IF NOT EXISTS sync_cursors (
                    user_id TEXT NOT NULL,
                    device_id TEXT NOT NULL,
                    last_event_version INTEGER NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY (user_id, device_id)
                );
                """
            )

    def register_user(self, email: str, password: str) -> Dict[str, Any]:
        normalized = email.strip().lower()
        if not normalized or "@" not in normalized:
            raise ValueError("Invalid email")
        if len(password) < 8:
            raise ValueError("Password must be at least 8 characters")
        user_id = str(uuid.uuid4())
        salt = secrets.token_hex(16)
        password_hash = _hash_password(password, salt)
        now = _now_ts()
        with self._connect() as conn:
            try:
                conn.execute(
                    "INSERT INTO users (id, email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)",
                    (user_id, normalized, password_hash, salt, now),
                )
            except sqlite3.IntegrityError:
                raise ValueError("Email already registered")
        return {"user_id": user_id, "email": normalized}

    def authenticate_user(self, email: str, password: str) -> Optional[Dict[str, Any]]:
        normalized = email.strip().lower()
        with self._connect() as conn:
            row = conn.execute(
                "SELECT id, email, password_hash, password_salt, status FROM users WHERE email = ?",
                (normalized,),
            ).fetchone()
            if row is None or row["status"] != "active":
                return None
            expected = row["password_hash"]
            candidate = _hash_password(password, row["password_salt"])
            if not secrets.compare_digest(expected, candidate):
                return None
            return {"user_id": row["id"], "email": row["email"]}

    def create_session(self, user_id: str, device_id: Optional[str] = None) -> Dict[str, Any]:
        now = _now_ts()
        access_ttl = 3600
        refresh_ttl = 30 * 24 * 3600
        access_token = f"lt_access_{secrets.token_urlsafe(32)}"
        refresh_token = f"lt_refresh_{secrets.token_urlsafe(40)}"
        session_id = str(uuid.uuid4())
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO auth_sessions
                (id, user_id, device_id, access_token_hash, refresh_token_hash, access_expires_at, refresh_expires_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    session_id,
                    user_id,
                    device_id,
                    _sha256(access_token),
                    _sha256(refresh_token),
                    now + access_ttl,
                    now + refresh_ttl,
                    now,
                ),
            )
        return {
            "session_id": session_id,
            "access_token": access_token,
            "refresh_token": refresh_token,
            "access_expires_in": access_ttl,
            "refresh_expires_in": refresh_ttl,
        }

    def refresh_session(self, refresh_token: str) -> Optional[Dict[str, Any]]:
        now = _now_ts()
        token_hash = _sha256(refresh_token)
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT id, user_id, device_id, refresh_expires_at, revoked_at
                FROM auth_sessions
                WHERE refresh_token_hash = ?
                """,
                (token_hash,),
            ).fetchone()
            if row is None or row["revoked_at"] is not None or now > int(row["refresh_expires_at"]):
                return None
            conn.execute("UPDATE auth_sessions SET revoked_at = ? WHERE id = ?", (now, row["id"]))
        return self.create_session(row["user_id"], row["device_id"])

    def resolve_access_token(self, access_token: str) -> Optional[Dict[str, Any]]:
        now = _now_ts()
        token_hash = _sha256(access_token)
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT user_id, device_id, access_expires_at, revoked_at
                FROM auth_sessions
                WHERE access_token_hash = ?
                """,
                (token_hash,),
            ).fetchone()
            if row is None or row["revoked_at"] is not None or now > int(row["access_expires_at"]):
                return None
            return {"user_id": row["user_id"], "device_id": row["device_id"]}

    def revoke_access_token(self, access_token: str) -> bool:
        token_hash = _sha256(access_token)
        now = _now_ts()
        with self._connect() as conn:
            cur = conn.execute(
                "UPDATE auth_sessions SET revoked_at = ? WHERE access_token_hash = ? AND revoked_at IS NULL",
                (now, token_hash),
            )
            return cur.rowcount > 0

    def register_device(self, user_id: str, name: str, os_name: str, device_id: Optional[str] = None) -> Dict[str, Any]:
        now = _now_ts()
        resolved_device_id = device_id or str(uuid.uuid4())
        with self._connect() as conn:
            existing = conn.execute(
                "SELECT id FROM devices WHERE id = ? AND user_id = ?",
                (resolved_device_id, user_id),
            ).fetchone()
            if existing is None:
                conn.execute(
                    """
                    INSERT INTO devices (id, user_id, name, os, status, last_seen_at, created_at)
                    VALUES (?, ?, ?, ?, 'active', ?, ?)
                    """,
                    (resolved_device_id, user_id, name, os_name, now, now),
                )
            else:
                conn.execute(
                    "UPDATE devices SET name = ?, os = ?, status = 'active', last_seen_at = ? WHERE id = ? AND user_id = ?",
                    (name, os_name, now, resolved_device_id, user_id),
                )
        return {"device_id": resolved_device_id, "name": name, "os": os_name, "last_seen_at": now}

    def heartbeat_device(self, user_id: str, device_id: str) -> bool:
        now = _now_ts()
        with self._connect() as conn:
            cur = conn.execute(
                "UPDATE devices SET last_seen_at = ?, status = 'active' WHERE id = ? AND user_id = ?",
                (now, device_id, user_id),
            )
            return cur.rowcount > 0

    def list_devices(self, user_id: str) -> List[Dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT id, name, os, status, last_seen_at, created_at
                FROM devices
                WHERE user_id = ?
                ORDER BY last_seen_at DESC
                """,
                (user_id,),
            ).fetchall()
        return [
            {
                "device_id": row["id"],
                "name": row["name"],
                "os": row["os"],
                "status": row["status"],
                "last_seen_at": row["last_seen_at"],
                "created_at": row["created_at"],
            }
            for row in rows
        ]

    def push_events(self, user_id: str, events: List[Dict[str, Any]]) -> Tuple[List[str], List[Dict[str, Any]], int]:
        accepted: List[str] = []
        rejected: List[Dict[str, Any]] = []
        now = _now_ts()
        with self._connect() as conn:
            row = conn.execute(
                "SELECT COALESCE(MAX(event_version), 0) AS max_version FROM sync_events WHERE user_id = ?",
                (user_id,),
            ).fetchone()
            next_version = int(row["max_version"] or 0) + 1

            for item in events:
                event_id = str(item.get("event_id") or "").strip()
                if not event_id:
                    rejected.append({"reason": "missing_event_id"})
                    continue
                exists = conn.execute(
                    "SELECT 1 FROM sync_events WHERE user_id = ? AND id = ?",
                    (user_id, event_id),
                ).fetchone()
                if exists is not None:
                    accepted.append(event_id)
                    continue
                object_type = str(item.get("object_type") or "").strip() or "unknown"
                object_id = str(item.get("object_id") or "").strip() or event_id
                op = str(item.get("op") or "upsert").strip()
                payload = item.get("payload", {})
                occurred_at = int(item.get("occurred_at") or now)
                conn.execute(
                    """
                    INSERT INTO sync_events
                    (id, user_id, event_version, object_type, object_id, op, payload_json, occurred_at, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        event_id,
                        user_id,
                        next_version,
                        object_type,
                        object_id,
                        op,
                        json.dumps(payload, ensure_ascii=False) if not isinstance(payload, str) else payload,
                        occurred_at,
                        now,
                    ),
                )
                accepted.append(event_id)
                next_version += 1

            latest = next_version - 1
        return accepted, rejected, latest

    def pull_events(self, user_id: str, cursor: int, limit: int = 100) -> Tuple[List[Dict[str, Any]], int]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT id, event_version, object_type, object_id, op, payload_json, occurred_at, created_at
                FROM sync_events
                WHERE user_id = ? AND event_version > ?
                ORDER BY event_version ASC
                LIMIT ?
                """,
                (user_id, cursor, max(1, min(500, int(limit)))),
            ).fetchall()
        events = [
            {
                "event_id": row["id"],
                "event_version": row["event_version"],
                "object_type": row["object_type"],
                "object_id": row["object_id"],
                "op": row["op"],
                "payload": self._decode_payload(row["payload_json"]),
                "occurred_at": row["occurred_at"],
                "created_at": row["created_at"],
            }
            for row in rows
        ]
        next_cursor = cursor if not events else int(events[-1]["event_version"])
        return events, next_cursor

    @staticmethod
    def _decode_payload(payload_json: str) -> Any:
        try:
            return json.loads(payload_json)
        except Exception:
            return payload_json

    def update_cursor(self, user_id: str, device_id: str, cursor: int) -> None:
        now = _now_ts()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO sync_cursors (user_id, device_id, last_event_version, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(user_id, device_id)
                DO UPDATE SET last_event_version = excluded.last_event_version, updated_at = excluded.updated_at
                """,
                (user_id, device_id, cursor, now),
            )
