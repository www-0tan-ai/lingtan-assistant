import random
import time
from typing import Any, Callable, Dict, List, Optional

from gateway.cloud_sync_client import CloudSyncClient

from sync.local_store import LocalSyncStore


class ResilientCloudSync:
    """Client-side resilient push/pull with local outbox and exponential backoff."""

    def __init__(
        self,
        base_url: str,
        access_token: Optional[str] = None,
        device_id: Optional[str] = None,
        store: Optional[LocalSyncStore] = None,
        timeout: int = 15,
    ):
        self.remote = CloudSyncClient(
            base_url,
            access_token=access_token,
            timeout=timeout,
            device_id=device_id,
        )
        self.store = store or LocalSyncStore()

    def enqueue(self, event: Dict[str, Any]) -> bool:
        return self.store.enqueue_event(event)

    def flush_outbox(
        self,
        *,
        max_rows: int = 100,
        sleep_fn: Optional[Callable[[float], None]] = None,
        backoff_floor: float = 0.8,
        backoff_cap: float = 300.0,
    ) -> Dict[str, Any]:
        nap = sleep_fn or time.sleep
        rows_meta = self.store.list_outbox_rows(limit=max_rows)
        if not rows_meta:
            return {"flushed": 0, "pending": 0}

        payloads: List[Dict[str, Any]] = []
        id_by_event: Dict[str, int] = {}
        rid_by_event: Dict[str, int] = {}
        for row in rows_meta:
            rid, payload = self.store.decode_row(row)
            eid = str(payload.get("event_id") or "")
            payloads.append(payload)
            id_by_event[eid] = int(row["id"])
            rid_by_event[eid] = rid

        try:
            resp = self.remote.push_events(payloads)
        except Exception as exc:
            err_msg = str(exc)
            max_n = 0
            for row in rows_meta:
                rid = int(row["id"])
                n = int(row["attempts"] or 0) + 1
                max_n = max(max_n, n)
                self.store.mark_outbox_attempt(rid, n, err_msg)
            delay = min(backoff_cap, backoff_floor * (2 ** min(max_n, 16)))
            delay *= 0.85 + random.random() * 0.3
            nap(delay)
            return {"flushed": 0, "pending": len(rows_meta), "error": err_msg}

        accepted = set(str(x) for x in resp.get("accepted_event_ids") or [])
        rejected = resp.get("rejected") or []
        deleted = 0
        for eid in accepted:
            row_id = id_by_event.get(eid)
            if row_id is not None:
                self.store.delete_outbox_id(row_id)
                deleted += 1

        rej_by_eid = {str(x.get("event_id")): x for x in rejected if isinstance(x, dict)}
        transient = {"version_conflict", "invalid_workspace"}

        err_msg: Optional[str] = None

        def _rej_reason(item: Dict[str, Any]) -> str:
            return str(item.get("reason") or "rejected")

        for ev in payloads:
            eid = str(ev.get("event_id"))
            rej = rej_by_eid.get(eid)
            if rej is None or eid in accepted:
                continue
            rid = rid_by_event.get(eid)
            reason = _rej_reason(rej)
            if rid is None:
                continue
            n = None
            for row in rows_meta:
                if int(row["id"]) == rid:
                    n = int(row["attempts"] or 0) + 1
                    break
            if n is None:
                n = 1
            fatal = reason not in transient
            if fatal:
                self.store.delete_outbox_id(rid)
                err_msg = err_msg or f"fatal:{reason}:{eid}"
            else:
                self.store.mark_outbox_attempt(rid, n, reason)
                nap(min(backoff_cap, backoff_floor * (2 ** min(n, 10))))

        remaining = len(self.store.list_outbox_rows(limit=max_rows))
        summary: Dict[str, Any] = {
            "accepted": sorted(accepted),
            "removed_from_outbox": deleted,
            "rejected": rejected,
            "next_cursor": resp.get("next_cursor"),
            "pending": remaining,
        }
        if err_msg:
            summary["error"] = err_msg
        return summary

    def pull(
        self,
        cursor_key: str = "pull_cursor",
        limit: int = 100,
        *,
        workspace_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        cur = self.store.get_cursor(cursor_key)
        resp = self.remote.pull_events(cursor=cur, limit=limit, workspace_id=workspace_id)
        nxt = int(resp.get("next_cursor") or cur)
        if nxt >= cur:
            self.store.set_cursor(cursor_key, nxt)
        return resp
