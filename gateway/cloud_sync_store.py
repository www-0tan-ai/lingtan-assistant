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


def _norm_ws(value: Optional[str]) -> str:
    return str(value or "").strip()


class CloudSyncStore:
    """SQLite-backed auth/device/sync/workspace store for Lingtan cloud-local MVP."""

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

                CREATE TABLE IF NOT EXISTS workspaces (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    is_default INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_workspaces_user ON workspaces(user_id);

                CREATE TABLE IF NOT EXISTS collector_tasks (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    workspace_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    source_type TEXT NOT NULL,
                    schedule TEXT,
                    config_json TEXT NOT NULL,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    version INTEGER NOT NULL DEFAULT 1,
                    last_run_at INTEGER,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_collector_tasks_ws ON collector_tasks(workspace_id);

                CREATE TABLE IF NOT EXISTS analysis_reports (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    workspace_id TEXT NOT NULL,
                    task_id TEXT,
                    summary TEXT NOT NULL,
                    tags_json TEXT,
                    score REAL,
                    payload_json TEXT,
                    version INTEGER NOT NULL DEFAULT 1,
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_reports_ws ON analysis_reports(workspace_id);

                CREATE TABLE IF NOT EXISTS sync_events (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    event_version INTEGER NOT NULL,
                    object_type TEXT NOT NULL,
                    object_id TEXT NOT NULL,
                    op TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    occurred_at INTEGER NOT NULL,
                    created_at INTEGER NOT NULL,
                    workspace_id TEXT,
                    client_version INTEGER
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

                CREATE TABLE IF NOT EXISTS sync_object_heads (
                    user_id TEXT NOT NULL,
                    workspace_id TEXT NOT NULL,
                    object_type TEXT NOT NULL,
                    object_id TEXT NOT NULL,
                    version INTEGER NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY (user_id, workspace_id, object_type, object_id)
                );

                CREATE TABLE IF NOT EXISTS sync_conflicts (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    device_id TEXT,
                    workspace_id TEXT NOT NULL,
                    object_type TEXT NOT NULL,
                    object_id TEXT NOT NULL,
                    client_version INTEGER,
                    server_version INTEGER NOT NULL,
                    created_at INTEGER NOT NULL
                );
                """
            )
            self._migrate_legacy_columns(conn)
            self._backfill_workspaces(conn)
            self._backfill_sync_workspace_ids(conn)
            conn.commit()

    def _migrate_legacy_columns(self, conn: sqlite3.Connection) -> None:
        for ddl in (
            "ALTER TABLE sync_events ADD COLUMN workspace_id TEXT",
            "ALTER TABLE sync_events ADD COLUMN client_version INTEGER",
        ):
            try:
                conn.execute(ddl)
            except sqlite3.OperationalError:
                pass

    def _backfill_workspaces(self, conn: sqlite3.Connection) -> None:
        missing = conn.execute(
            """
            SELECT u.id FROM users u
            WHERE NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.user_id = u.id)
            """
        ).fetchall()
        now = _now_ts()
        for row in missing:
            uid = row["id"]
            conn.execute(
                """
                INSERT INTO workspaces (id, user_id, name, is_default, created_at)
                VALUES (?, ?, ?, 1, ?)
                """,
                (str(uuid.uuid4()), uid, "默认工作空间", now),
            )

    def _backfill_sync_workspace_ids(self, conn: sqlite3.Connection) -> None:
        rows = conn.execute(
            """
            SELECT e.user_id AS uid, e.id AS eid FROM sync_events e
            WHERE e.workspace_id IS NULL
            """
        ).fetchall()
        for row in rows:
            ws = conn.execute(
                """
                SELECT id FROM workspaces WHERE user_id = ? AND is_default = 1 ORDER BY created_at ASC LIMIT 1
                """,
                (row["uid"],),
            ).fetchone()
            if ws is None:
                continue
            conn.execute(
                "UPDATE sync_events SET workspace_id = ? WHERE user_id = ? AND id = ?",
                (ws["id"], row["uid"], row["eid"]),
            )

    def get_default_workspace_id(self, user_id: str) -> Optional[str]:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT id FROM workspaces WHERE user_id = ? AND is_default = 1
                ORDER BY created_at ASC LIMIT 1
                """,
                (user_id,),
            ).fetchone()
            return str(row["id"]) if row else None

    def resolve_workspace(self, user_id: str, workspace_id: Optional[str]) -> Optional[str]:
        ws = _norm_ws(workspace_id)
        if not ws:
            return self.get_default_workspace_id(user_id)
        with self._connect() as conn:
            row = conn.execute(
                "SELECT id FROM workspaces WHERE user_id = ? AND id = ?",
                (user_id, ws),
            ).fetchone()
            return str(row["id"]) if row else None

    def list_workspaces(self, user_id: str) -> List[Dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT id, name, is_default, created_at FROM workspaces
                WHERE user_id = ? ORDER BY is_default DESC, created_at ASC
                """,
                (user_id,),
            ).fetchall()
        return [
            {
                "workspace_id": r["id"],
                "name": r["name"],
                "is_default": bool(r["is_default"]),
                "created_at": r["created_at"],
            }
            for r in rows
        ]

    def verify_device_owned(self, user_id: str, device_id: str) -> bool:
        if not _norm_ws(device_id):
            return False
        with self._connect() as conn:
            row = conn.execute(
                "SELECT 1 FROM devices WHERE user_id = ? AND id = ?",
                (user_id, device_id.strip()),
            ).fetchone()
            return row is not None

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
        workspace_id = str(uuid.uuid4())
        with self._connect() as conn:
            try:
                conn.execute(
                    "INSERT INTO users (id, email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)",
                    (user_id, normalized, password_hash, salt, now),
                )
            except sqlite3.IntegrityError:
                raise ValueError("Email already registered")
            conn.execute(
                """
                INSERT INTO workspaces (id, user_id, name, is_default, created_at)
                VALUES (?, ?, ?, 1, ?)
                """,
                (workspace_id, user_id, "默认工作空间", now),
            )
            conn.commit()
        return {"user_id": user_id, "email": normalized, "default_workspace_id": workspace_id}

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
                    device_id.strip() if device_id else None,
                    _sha256(access_token),
                    _sha256(refresh_token),
                    now + access_ttl,
                    now + refresh_ttl,
                    now,
                ),
            )
            conn.commit()
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
            conn.commit()
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
            conn.commit()
            return cur.rowcount > 0

    def register_device(self, user_id: str, name: str, os_name: str, device_id: Optional[str] = None) -> Dict[str, Any]:
        now = _now_ts()
        resolved_device_id = device_id.strip() if device_id and device_id.strip() else str(uuid.uuid4())
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
            conn.commit()
        ws = self.get_default_workspace_id(user_id)
        return {"device_id": resolved_device_id, "name": name, "os": os_name, "last_seen_at": now, "default_workspace_id": ws}

    def heartbeat_device(self, user_id: str, device_id: str) -> bool:
        now = _now_ts()
        with self._connect() as conn:
            cur = conn.execute(
                "UPDATE devices SET last_seen_at = ?, status = 'active' WHERE id = ? AND user_id = ?",
                (now, device_id, user_id),
            )
            conn.commit()
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

    def _record_conflict(
        self,
        conn: sqlite3.Connection,
        user_id: str,
        device_id: Optional[str],
        workspace_id: str,
        object_type: str,
        object_id: str,
        client_version: Optional[int],
        server_version: int,
    ) -> None:
        cid = str(uuid.uuid4())
        conn.execute(
            """
            INSERT INTO sync_conflicts
            (id, user_id, device_id, workspace_id, object_type, object_id, client_version, server_version, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                cid,
                user_id,
                device_id.strip() if device_id else None,
                workspace_id,
                object_type,
                object_id,
                client_version,
                server_version,
                _now_ts(),
            ),
        )

    def _get_head_version(self, conn: sqlite3.Connection, user_id: str, workspace_id: str, object_type: str, object_id: str) -> int:
        row = conn.execute(
            """
            SELECT version FROM sync_object_heads
            WHERE user_id = ? AND workspace_id = ? AND object_type = ? AND object_id = ?
            """,
            (user_id, workspace_id, object_type, object_id),
        ).fetchone()
        return int(row["version"]) if row else 0

    def _bump_head(self, conn: sqlite3.Connection, user_id: str, workspace_id: str, object_type: str, object_id: str) -> int:
        now = _now_ts()
        cur_v = self._get_head_version(conn, user_id, workspace_id, object_type, object_id)
        next_v = cur_v + 1
        conn.execute(
            """
            INSERT INTO sync_object_heads (user_id, workspace_id, object_type, object_id, version, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, workspace_id, object_type, object_id)
            DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at
            """,
            (user_id, workspace_id, object_type, object_id, next_v, now),
        )
        return next_v

    def _materialize_from_event(
        self,
        conn: sqlite3.Connection,
        user_id: str,
        workspace_id: str,
        object_type: str,
        object_id: str,
        op: str,
        payload: Any,
        server_version: int,
    ) -> None:
        if op == "delete":
            if object_type == "collector_task":
                conn.execute(
                    "DELETE FROM collector_tasks WHERE id = ? AND user_id = ? AND workspace_id = ?",
                    (object_id, user_id, workspace_id),
                )
            elif object_type == "analysis_report":
                conn.execute(
                    "DELETE FROM analysis_reports WHERE id = ? AND user_id = ? AND workspace_id = ?",
                    (object_id, user_id, workspace_id),
                )
            return
        if not isinstance(payload, dict):
            payload = {}
        now = _now_ts()
        if object_type == "collector_task":
            name = str(payload.get("name") or object_id)
            source_type = str(payload.get("source_type") or "file")
            schedule = payload.get("schedule")
            if schedule is not None:
                schedule = str(schedule)
            config = payload.get("config") if isinstance(payload.get("config"), dict) else {}
            enabled = 1 if payload.get("enabled", True) else 0
            row = conn.execute(
                "SELECT id FROM collector_tasks WHERE id = ? AND user_id = ?",
                (object_id, user_id),
            ).fetchone()
            if row is None:
                conn.execute(
                    """
                    INSERT INTO collector_tasks
                    (id, user_id, workspace_id, name, source_type, schedule, config_json, enabled, version,
                     last_run_at, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        object_id,
                        user_id,
                        workspace_id,
                        name,
                        source_type,
                        schedule,
                        json.dumps(config, ensure_ascii=False),
                        enabled,
                        server_version,
                        None,
                        now,
                        now,
                    ),
                )
            else:
                conn.execute(
                    """
                    UPDATE collector_tasks SET
                      name = ?, source_type = ?, schedule = ?, config_json = ?, enabled = ?, version = ?, updated_at = ?
                    WHERE id = ? AND user_id = ? AND workspace_id = ?
                    """,
                    (
                        name,
                        source_type,
                        schedule,
                        json.dumps(config, ensure_ascii=False),
                        enabled,
                        server_version,
                        now,
                        object_id,
                        user_id,
                        workspace_id,
                    ),
                )
        elif object_type == "analysis_report":
            summary = str(payload.get("summary") or "")
            tags = payload.get("tags")
            tags_json = json.dumps(tags, ensure_ascii=False) if tags is not None else None
            score = payload.get("score")
            task_id = str(payload.get("task_id")) if payload.get("task_id") else None
            extra = {k: v for k, v in payload.items() if k not in {"summary", "tags", "score", "task_id"}}
            payload_json = json.dumps(extra, ensure_ascii=False) if extra else None
            row = conn.execute(
                "SELECT id FROM analysis_reports WHERE id = ? AND user_id = ?",
                (object_id, user_id),
            ).fetchone()
            if row is None:
                conn.execute(
                    """
                    INSERT INTO analysis_reports
                    (id, user_id, workspace_id, task_id, summary, tags_json, score, payload_json, version, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        object_id,
                        user_id,
                        workspace_id,
                        task_id,
                        summary,
                        tags_json,
                        score,
                        payload_json,
                        server_version,
                        now,
                    ),
                )
            else:
                conn.execute(
                    """
                    UPDATE analysis_reports SET
                      task_id = ?, summary = ?, tags_json = ?, score = ?, payload_json = ?, version = ?
                    WHERE id = ? AND user_id = ? AND workspace_id = ?
                    """,
                    (task_id, summary, tags_json, score, payload_json, server_version, object_id, user_id, workspace_id),
                )

    def append_server_event(
        self,
        user_id: str,
        workspace_id: str,
        object_type: str,
        object_id: str,
        op: str,
        payload: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Append one sync event originating from cloud control-plane APIs."""
        evt_id = str(uuid.uuid4())
        now = _now_ts()
        with self._connect() as conn:
            mx = conn.execute(
                "SELECT COALESCE(MAX(event_version), 0) AS mv FROM sync_events WHERE user_id = ?",
                (user_id,),
            ).fetchone()
            nv = int(mx["mv"] or 0) + 1
            server_ver = self._bump_head(conn, user_id, workspace_id, object_type, object_id)
            conn.execute(
                """
                INSERT INTO sync_events
                (id, user_id, event_version, object_type, object_id, op, payload_json, occurred_at, created_at, workspace_id, client_version)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    evt_id,
                    user_id,
                    nv,
                    object_type,
                    object_id,
                    op,
                    json.dumps(payload, ensure_ascii=False),
                    now,
                    now,
                    workspace_id,
                    server_ver,
                ),
            )
            self._materialize_from_event(conn, user_id, workspace_id, object_type, object_id, op, payload, server_ver)
            conn.commit()
        return {"event_id": evt_id, "event_version": nv, "server_version": server_ver}

    def push_events(
        self,
        user_id: str,
        events: List[Dict[str, Any]],
        *,
        device_id: Optional[str] = None,
        default_workspace_id: Optional[str] = None,
    ) -> Tuple[List[str], List[Dict[str, Any]], int]:
        accepted: List[str] = []
        rejected: List[Dict[str, Any]] = []
        now = _now_ts()
        dws = default_workspace_id or self.get_default_workspace_id(user_id) or ""

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
                ws_in = item.get("workspace_id")
                if ws_in is None or not _norm_ws(str(ws_in)):
                    ws_resolved = dws
                else:
                    row_ws = conn.execute(
                        "SELECT id FROM workspaces WHERE user_id = ? AND id = ?",
                        (user_id, _norm_ws(str(ws_in))),
                    ).fetchone()
                    ws_resolved = str(row_ws["id"]) if row_ws else None
                if not ws_resolved:
                    rejected.append({"event_id": event_id, "reason": "invalid_workspace"})
                    continue
                ws_resolved = str(ws_resolved)

                exists = conn.execute(
                    "SELECT event_version FROM sync_events WHERE user_id = ? AND id = ?",
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

                cv_raw = item.get("client_version")
                client_version: Optional[int]
                try:
                    client_version = int(cv_raw) if cv_raw is not None else None
                except (TypeError, ValueError):
                    client_version = None

                srv_head = self._get_head_version(conn, user_id, ws_resolved, object_type, object_id)
                if client_version is not None and client_version < srv_head:
                    self._record_conflict(
                        conn, user_id, device_id, ws_resolved, object_type, object_id, client_version, srv_head
                    )
                    rejected.append(
                        {
                            "event_id": event_id,
                            "reason": "version_conflict",
                            "server_version": srv_head,
                        }
                    )
                    continue

                server_ver = self._bump_head(conn, user_id, ws_resolved, object_type, object_id)
                conn.execute(
                    """
                    INSERT INTO sync_events
                    (id, user_id, event_version, object_type, object_id, op, payload_json, occurred_at, created_at, workspace_id, client_version)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                        ws_resolved,
                        client_version,
                    ),
                )
                self._materialize_from_event(conn, user_id, ws_resolved, object_type, object_id, op, payload, server_ver)
                accepted.append(event_id)
                next_version += 1

            latest = next_version - 1
            conn.commit()
        return accepted, rejected, latest

    def pull_events(
        self,
        user_id: str,
        cursor: int,
        limit: int = 100,
        *,
        workspace_id: Optional[str] = None,
    ) -> Tuple[List[Dict[str, Any]], int]:
        ws_filter = None
        if workspace_id:
            ws_filter = self.resolve_workspace(user_id, workspace_id)
        lim = max(1, min(500, int(limit)))
        with self._connect() as conn:
            if ws_filter:
                rows = conn.execute(
                    """
                    SELECT id, event_version, object_type, object_id, op, payload_json, occurred_at, created_at,
                           workspace_id, client_version
                    FROM sync_events
                    WHERE user_id = ? AND event_version > ?
                      AND (workspace_id IS NULL OR workspace_id = ?)
                    ORDER BY event_version ASC
                    LIMIT ?
                    """,
                    (user_id, cursor, ws_filter, lim),
                ).fetchall()
            else:
                rows = conn.execute(
                    """
                    SELECT id, event_version, object_type, object_id, op, payload_json, occurred_at, created_at,
                           workspace_id, client_version
                    FROM sync_events
                    WHERE user_id = ? AND event_version > ?
                    ORDER BY event_version ASC
                    LIMIT ?
                    """,
                    (user_id, cursor, lim),
                ).fetchall()
        events = []
        for row in rows:
            payload = self._decode_payload(row["payload_json"])
            events.append(
                {
                    "event_id": row["id"],
                    "event_version": row["event_version"],
                    "object_type": row["object_type"],
                    "object_id": row["object_id"],
                    "op": row["op"],
                    "payload": payload,
                    "occurred_at": row["occurred_at"],
                    "created_at": row["created_at"],
                    "workspace_id": row["workspace_id"],
                    "client_version": row["client_version"],
                }
            )
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
            conn.commit()

    def list_collector_tasks(self, user_id: str, workspace_id: str) -> List[Dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT id, workspace_id, name, source_type, schedule, config_json, enabled, version,
                       last_run_at, created_at, updated_at
                FROM collector_tasks
                WHERE user_id = ? AND workspace_id = ?
                ORDER BY updated_at DESC
                """,
                (user_id, workspace_id),
            ).fetchall()
        out = []
        for r in rows:
            try:
                cfg = json.loads(r["config_json"])
            except Exception:
                cfg = {}
            out.append(
                {
                    "task_id": r["id"],
                    "workspace_id": r["workspace_id"],
                    "name": r["name"],
                    "source_type": r["source_type"],
                    "schedule": r["schedule"],
                    "config": cfg,
                    "enabled": bool(r["enabled"]),
                    "version": r["version"],
                    "last_run_at": r["last_run_at"],
                    "created_at": r["created_at"],
                    "updated_at": r["updated_at"],
                }
            )
        return out

    def create_collector_task(
        self,
        user_id: str,
        workspace_id: str,
        *,
        name: str,
        source_type: str,
        schedule: Optional[str] = None,
        config: Optional[Dict[str, Any]] = None,
        enabled: bool = True,
    ) -> Dict[str, Any]:
        tid = str(uuid.uuid4())
        now = _now_ts()
        cfg = dict(config or {})
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO collector_tasks
                (id, user_id, workspace_id, name, source_type, schedule, config_json, enabled, version, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
                """,
                (
                    tid,
                    user_id,
                    workspace_id,
                    name.strip() or tid,
                    source_type.strip() or "file",
                    schedule.strip() if schedule else None,
                    json.dumps(cfg, ensure_ascii=False),
                    1 if enabled else 0,
                    now,
                    now,
                ),
            )
            conn.commit()
        payload = {"name": name, "source_type": source_type, "schedule": schedule, "config": cfg, "enabled": enabled}
        ev = self.append_server_event(user_id, workspace_id, "collector_task", tid, "upsert", payload)
        row = {"task_id": tid, **payload, "workspace_id": workspace_id}
        row["event"] = ev
        return row

    def patch_collector_task(
        self,
        user_id: str,
        workspace_id: str,
        task_id: str,
        *,
        name: Optional[str] = None,
        source_type: Optional[str] = None,
        schedule: Any = ...,
        config: Optional[Dict[str, Any]] = None,
        enabled: Optional[bool] = None,
    ) -> Optional[Dict[str, Any]]:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT id, name, source_type, schedule, config_json, enabled, version
                FROM collector_tasks
                WHERE id = ? AND user_id = ? AND workspace_id = ?
                """,
                (task_id, user_id, workspace_id),
            ).fetchone()
            if row is None:
                return None
            try:
                cfg = dict(json.loads(row["config_json"]))
            except Exception:
                cfg = {}
            if config is not None:
                cfg.update(config)
            new_name = row["name"] if name is None else name.strip() or row["name"]
            new_st = row["source_type"] if source_type is None else source_type.strip()
            if schedule is ...:
                new_sched = row["schedule"]
            else:
                new_sched = str(schedule).strip() if schedule else None
            new_en = row["enabled"] if enabled is None else (1 if enabled else 0)
            now = _now_ts()
            new_ver = int(row["version"]) + 1
            conn.execute(
                """
                UPDATE collector_tasks SET
                  name = ?, source_type = ?, schedule = ?, config_json = ?, enabled = ?, version = ?, updated_at = ?
                WHERE id = ? AND user_id = ? AND workspace_id = ?
                """,
                (
                    new_name,
                    new_st,
                    new_sched,
                    json.dumps(cfg, ensure_ascii=False),
                    new_en,
                    new_ver,
                    now,
                    task_id,
                    user_id,
                    workspace_id,
                ),
            )
            conn.commit()

        payload = {
            "name": new_name,
            "source_type": new_st,
            "schedule": new_sched,
            "config": cfg,
            "enabled": bool(new_en),
            "version": new_ver,
        }
        ev = self.append_server_event(user_id, workspace_id, "collector_task", task_id, "upsert", payload)
        return {"task_id": task_id, **payload, "workspace_id": workspace_id, "event": ev}

    def run_collector_task(self, user_id: str, workspace_id: str, task_id: str) -> Optional[Dict[str, Any]]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT id, name FROM collector_tasks WHERE id = ? AND user_id = ? AND workspace_id = ?",
                (task_id, user_id, workspace_id),
            ).fetchone()
            if row is None:
                return None
        now = _now_ts()
        with self._connect() as conn:
            conn.execute(
                "UPDATE collector_tasks SET last_run_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND workspace_id = ?",
                (now, now, task_id, user_id, workspace_id),
            )
            conn.commit()
        rid = str(uuid.uuid4())
        payload = {"task_id": task_id, "task_name": row["name"], "status": "requested", "ran_at": now, "run_id": rid}
        ev = self.append_server_event(user_id, workspace_id, "collector_run", rid, "create", payload)
        return {"ok": True, "run_id": rid, **payload, "event": ev}

    def create_report(
        self,
        user_id: str,
        workspace_id: str,
        *,
        summary: str,
        task_id: Optional[str] = None,
        tags: Optional[List[str]] = None,
        score: Optional[float] = None,
        extra_payload: Optional[Dict[str, Any]] = None,
        report_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        rid = (report_id.strip() if report_id and str(report_id).strip() else "") or str(uuid.uuid4())
        payload = dict(extra_payload or {})
        payload.update({"summary": summary, "task_id": task_id, "tags": tags, "score": score})
        now = _now_ts()
        tags_json = json.dumps(tags, ensure_ascii=False) if tags is not None else None
        extra_only = dict(extra_payload or {})
        payload_json = json.dumps(extra_only, ensure_ascii=False) if extra_only else None
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO analysis_reports
                (id, user_id, workspace_id, task_id, summary, tags_json, score, payload_json, version, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
                """,
                (rid, user_id, workspace_id, task_id, summary.strip(), tags_json, score, payload_json, now),
            )
            conn.commit()
        ev = self.append_server_event(user_id, workspace_id, "analysis_report", rid, "upsert", payload)
        return {"report_id": rid, "workspace_id": workspace_id, "summary": summary, "event": ev}

    def list_reports(self, user_id: str, workspace_id: str, *, limit: int = 100) -> List[Dict[str, Any]]:
        lim = max(1, min(500, int(limit)))
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT id, workspace_id, task_id, summary, tags_json, score, payload_json, version, created_at
                FROM analysis_reports
                WHERE user_id = ? AND workspace_id = ?
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (user_id, workspace_id, lim),
            ).fetchall()
        out = []
        for r in rows:
            try:
                tags = json.loads(r["tags_json"]) if r["tags_json"] else []
            except Exception:
                tags = []
            extra = {}
            if r["payload_json"]:
                try:
                    extra = json.loads(r["payload_json"])
                except Exception:
                    pass
            out.append(
                {
                    "report_id": r["id"],
                    "workspace_id": r["workspace_id"],
                    "task_id": r["task_id"],
                    "summary": r["summary"],
                    "tags": tags,
                    "score": r["score"],
                    "extra": extra,
                    "version": r["version"],
                    "created_at": r["created_at"],
                }
            )
        return out

    def get_report(self, user_id: str, report_id: str) -> Optional[Dict[str, Any]]:
        with self._connect() as conn:
            r = conn.execute(
                """
                SELECT id, workspace_id, task_id, summary, tags_json, score, payload_json, version, created_at
                FROM analysis_reports WHERE id = ? AND user_id = ?
                """,
                (report_id, user_id),
            ).fetchone()
            if r is None:
                return None
        try:
            tags = json.loads(r["tags_json"]) if r["tags_json"] else []
        except Exception:
            tags = []
        extra = {}
        if r["payload_json"]:
            try:
                extra = json.loads(r["payload_json"])
            except Exception:
                pass
        return {
            "report_id": r["id"],
            "workspace_id": r["workspace_id"],
            "task_id": r["task_id"],
            "summary": r["summary"],
            "tags": tags,
            "score": r["score"],
            "extra": extra,
            "version": r["version"],
            "created_at": r["created_at"],
        }
