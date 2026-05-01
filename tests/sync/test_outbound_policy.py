from sync.outbound_policy import LingtanOutboundPolicy, partition_upload_events, sanitize_sync_event_for_upload


def test_local_only_blocks() -> None:
    pol = LingtanOutboundPolicy(
        outbound_enabled=True,
        require_explicit_allow=False,
        blocked_object_types=frozenset(),
        max_event_json_bytes=1024,
    )
    ev = {"event_id": "a", "object_type": "x", "object_id": "1", "payload": {}, "local_only": True}
    assert pol.event_allowed(ev) == (False, "local_only")


def test_visibility_local_only_blocks() -> None:
    pol = LingtanOutboundPolicy(True, False, frozenset(), 1024)
    ev = {"event_id": "b", "object_type": "x", "object_id": "1", "payload": {}, "visibility": "local_only"}
    assert pol.event_allowed(ev) == (False, "visibility_local_only")


def test_require_explicit_allow() -> None:
    pol = LingtanOutboundPolicy(True, True, frozenset(), 1024)
    ev = {"event_id": "c", "object_type": "x", "object_id": "1", "payload": {}}
    assert pol.event_allowed(ev) == (False, "missing_cloud_allow")
    ev2 = {**ev, "cloud_allow": True}
    assert pol.event_allowed(ev2)[0] is True


def test_blocked_object_type() -> None:
    pol = LingtanOutboundPolicy(True, False, frozenset({"secret_blob"}), 1024)
    ev = {"event_id": "d", "object_type": "secret_blob", "object_id": "1", "payload": {}}
    assert pol.event_allowed(ev) == (False, "blocked_object_type")


def test_partition_strips_metadata() -> None:
    pol = LingtanOutboundPolicy(True, False, frozenset(), 1024)
    ev = {
        "event_id": "e",
        "object_type": "analysis_report",
        "object_id": "r1",
        "payload": {"summary": "ok"},
        "cloud_allow": True,
        "visibility": "aggregate_ok",
    }
    allowed, rej = partition_upload_events([ev], pol)
    assert not rej
    assert "cloud_allow" not in allowed[0]
    assert sanitize_sync_event_for_upload(ev) == allowed[0]
