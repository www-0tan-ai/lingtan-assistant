"""
Lingtan cloud-sync outbound guards (local-first data stays off the cloud).

Validated on both the Python client path and sync/push handlers so rogue
clients cannot bypass local policy with a handcrafted HTTP POST.

Event envelope (recommended fields):

- ``visibility``: ``"aggregate_ok"`` for safe summaries; ``"local_only"`` blocks upload.
- ``local_only``: when true, blocks upload regardless of visibility.
- ``cloud_allow``: when ``lingtan_sync.require_explicit_allow`` is true, must be
  true for upload to proceed.

Environment overrides (take precedence after merge defaults→user YAML):

- ``LINGTAN_SYNC_OUTBOUND_ENABLED`` — ``0``, ``false``, ``no``, ``off`` disables all outbound uploads.
- ``LINGTAN_SYNC_REQUIRE_EXPLICIT_ALLOW`` — ``1``, ``true`` enables explicit-allow gate.
- ``LINGTAN_SYNC_MAX_EVENT_JSON_BYTES`` — override max JSON size for the serialized ``payload`` field.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from typing import Any, Dict, FrozenSet, List, Optional, Tuple

_TRUE = frozenset({"1", "true", "yes", "on"})
_FALSE = frozenset({"0", "false", "no", "off"})


# Outbox rows that violate these codes should not be retried endlessly.
PERMANENT_OUTBOUND_REJECTION_CODES = frozenset(
    {
        "local_only",
        "visibility_local_only",
        "blocked_object_type",
        "marker_raw_private",
        "missing_cloud_allow",
        "payload_too_large",
        "payload_not_serializable",
        "invalid_event",
    },
)


_METADATA_KEYS_DROP = frozenset(
    {
        "cloud_allow",
        "visibility",
        "local_only",
        "contains_raw_private_data",
    },
)


class LingtanOutboundBlocked(ValueError):
    """Raised when a sync event cannot be enqueued due to outbound policy."""


def is_permanent_outbound_rejection(code: str) -> bool:
    return str(code).strip() in PERMANENT_OUTBOUND_REJECTION_CODES


def sanitize_sync_event_for_upload(ev: Dict[str, Any]) -> Dict[str, Any]:
    """Strip policy/control keys before HTTP upload (privacy + smaller payloads)."""
    return {k: v for k, v in ev.items() if k not in _METADATA_KEYS_DROP and not str(k).startswith("_")}


def _parse_env_bool(value: Optional[str], default: Optional[bool] = None) -> Optional[bool]:
    if value is None or not str(value).strip():
        return default
    s = str(value).strip().lower()
    if s in _TRUE:
        return True
    if s in _FALSE:
        return False
    return default


def _norm_object_type(raw: Any) -> str:
    return str(raw or "").strip().lower()


@dataclass(frozen=True)
class LingtanOutboundPolicy:
    """Resolved outbound policy merged from defaults, config, and env."""

    outbound_enabled: bool
    require_explicit_allow: bool
    blocked_object_types: FrozenSet[str]
    max_event_json_bytes: int

    def event_allowed(self, event: Dict[str, Any]) -> Tuple[bool, str]:
        """Return (True, '') or (False, rejection_code)."""
        if not self.outbound_enabled:
            return False, "outbound_disabled"

        reason = self._blocked_by_envelope(event)
        if reason:
            return False, reason

        ot = _norm_object_type(event.get("object_type"))
        if ot in self.blocked_object_types:
            return False, "blocked_object_type"

        if self.require_explicit_allow and not bool(event.get("cloud_allow")):
            return False, "missing_cloud_allow"

        size_reason = self._payload_size_blocked(event.get("payload"))
        if size_reason:
            return False, size_reason

        return True, ""

    def _blocked_by_envelope(self, event: Dict[str, Any]) -> Optional[str]:
        if event.get("local_only") is True:
            return "local_only"
        vis_raw = event.get("visibility")
        vis = str(vis_raw).strip().lower()
        # Treat unknown visibility as legacy / permissive (deny_only local_only explicitly).
        if vis == "local_only":
            return "visibility_local_only"
        if bool(event.get("contains_raw_private_data")) is True:
            return "marker_raw_private"
        return None

    def _payload_size_blocked(self, payload: Any) -> Optional[str]:
        if self.max_event_json_bytes <= 0:
            return None
        try:
            serialized = json.dumps(payload, ensure_ascii=False)
            if len(serialized.encode("utf-8")) > self.max_event_json_bytes:
                return "payload_too_large"
        except (TypeError, ValueError):
            return "payload_not_serializable"
        return None


def _defaults_from_builtin() -> Dict[str, Any]:
    try:
        from hermes_cli.config import DEFAULT_CONFIG

        merged = DEFAULT_CONFIG.get("lingtan_sync") or {}
        if isinstance(merged, dict):
            return dict(merged)
    except Exception:
        pass
    return {
        "outbound_enabled": True,
        "require_explicit_allow": False,
        "blocked_object_types": [],
        "max_event_json_bytes": 524_288,
    }


def load_lingtan_outbound_policy() -> LingtanOutboundPolicy:
    """Merge ``lingtan_sync`` from user config + environment overrides."""
    blob = _defaults_from_builtin()
    try:
        from hermes_cli.config import load_config

        user = load_config() or {}
        sec = user.get("lingtan_sync")
        if isinstance(sec, dict):
            for k, v in sec.items():
                blob[k] = v
    except Exception:
        pass

    outbound = blob.get("outbound_enabled")
    enabled = outbound if isinstance(outbound, bool) else str(outbound).lower() not in {"0", "false", "no", "off"}

    explicit = blob.get("require_explicit_allow")
    req_explicit = explicit if isinstance(explicit, bool) else str(explicit).lower() in {"1", "true", "yes", "on"}

    raw_types = blob.get("blocked_object_types") or []
    if isinstance(raw_types, str):
        raw_types = re.split(r"[\s,]+", raw_types.strip())
    blocked: FrozenSet[str] = frozenset(_norm_object_type(x) for x in raw_types if _norm_object_type(x))

    max_raw = blob.get("max_event_json_bytes", 524_288)
    try:
        max_bytes = int(max_raw)
    except (TypeError, ValueError):
        max_bytes = 524_288

    env_disable = _parse_env_bool(os.getenv("LINGTAN_SYNC_OUTBOUND_ENABLED"))
    if env_disable is False:
        enabled = False
    elif env_disable is True:
        enabled = True

    env_req = _parse_env_bool(os.getenv("LINGTAN_SYNC_REQUIRE_EXPLICIT_ALLOW"))
    if env_req is True:
        req_explicit = True
    elif env_req is False:
        req_explicit = False

    env_max = os.getenv("LINGTAN_SYNC_MAX_EVENT_JSON_BYTES", "").strip()
    if env_max:
        try:
            max_bytes = int(env_max)
        except ValueError:
            pass

    return LingtanOutboundPolicy(
        outbound_enabled=enabled,
        require_explicit_allow=req_explicit,
        blocked_object_types=blocked,
        max_event_json_bytes=max(0, max_bytes),
    )


def partition_upload_events(
    events: List[Dict[str, Any]],
    policy: LingtanOutboundPolicy,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    allowed: List[Dict[str, Any]] = []
    rejected: List[Dict[str, Any]] = []
    for item in events:
        if not isinstance(item, dict):
            rejected.append({"reason": "invalid_event"})
            continue
        eid = str(item.get("event_id") or "").strip()
        ok, reason = policy.event_allowed(item)
        if ok:
            bare = {k: v for k, v in item.items() if not str(k).startswith("_")}
            allowed.append(sanitize_sync_event_for_upload(bare))
        elif eid:
            rejected.append({"event_id": eid, "reason": reason})
        else:
            rejected.append({"reason": reason})
    return allowed, rejected


__all__ = [
    "LingtanOutboundPolicy",
    "LingtanOutboundBlocked",
    "PERMANENT_OUTBOUND_REJECTION_CODES",
    "is_permanent_outbound_rejection",
    "sanitize_sync_event_for_upload",
    "load_lingtan_outbound_policy",
    "partition_upload_events",
]
