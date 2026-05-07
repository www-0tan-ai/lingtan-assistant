"""Transport that funnels tui_gateway JSON-RPC frames into a thread-safe queue."""

from __future__ import annotations

import queue
from typing import Any

from tui_gateway.transport import Transport


class QueueTransport(Transport):
    """Every ``write()`` enqueues one serialisable dict (JSON-RPC line payload)."""

    __slots__ = ("_q",)

    def __init__(self, q: queue.Queue[dict[str, Any]]) -> None:
        self._q = q

    def write(self, obj: dict) -> bool:
        self._q.put(obj)
        return True

    def close(self) -> None:
        pass
