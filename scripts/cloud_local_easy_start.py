"""
Cloud/local sync quickstart helper.

Usage examples:
  python scripts/cloud_local_easy_start.py init --email demo@example.com --password password123
  python scripts/cloud_local_easy_start.py push-sample --access-token <token>
  python scripts/cloud_local_easy_start.py pull --access-token <token> --cursor 0
"""

import argparse
import json
import os
import platform
import time
import uuid

from gateway.cloud_sync_client import CloudSyncClient


def _default_base_url() -> str:
    return os.getenv("CLOUD_SYNC_BASE_URL", "http://127.0.0.1:8642")


def cmd_init(args: argparse.Namespace) -> int:
    client = CloudSyncClient(base_url=args.base_url)
    if not args.skip_register:
        try:
            reg = client.register(args.email, args.password)
            print(f"[ok] registered: {reg['email']}")
        except RuntimeError as exc:
            print(f"[warn] register skipped: {exc}")

    login = client.login(args.email, args.password)
    access_token = login["access_token"]
    refresh_token = login["refresh_token"]
    print("[ok] login success")
    print(f"access_token={access_token}")
    print(f"refresh_token={refresh_token}")

    device = client.register_device(
        name=args.device_name or platform.node() or "local-device",
        os_name=platform.system().lower() or "unknown",
        device_id=args.device_id,
    )
    print(f"[ok] device bound: {device['device_id']}")
    print(json.dumps({"access_token": access_token, "refresh_token": refresh_token, "device": device}, ensure_ascii=False))
    return 0


def cmd_push_sample(args: argparse.Namespace) -> int:
    client = CloudSyncClient(base_url=args.base_url, access_token=args.access_token)
    event_id = args.event_id or str(uuid.uuid4())
    payload = {
        "summary": args.summary,
        "source": "local_quickstart",
        "created_at": int(time.time()),
    }
    resp = client.push_events(
        [
            {
                "event_id": event_id,
                "object_type": "analysis_report",
                "object_id": args.object_id or f"report-{event_id[:8]}",
                "op": "upsert",
                "payload": payload,
                "occurred_at": int(time.time()),
            }
        ]
    )
    print(json.dumps(resp, ensure_ascii=False))
    return 0


def cmd_pull(args: argparse.Namespace) -> int:
    client = CloudSyncClient(base_url=args.base_url, access_token=args.access_token)
    resp = client.pull_events(cursor=args.cursor, limit=args.limit, device_id=args.device_id)
    print(json.dumps(resp, ensure_ascii=False))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Cloud/local sync quickstart wrapper")
    parser.add_argument("--base-url", default=_default_base_url(), help="API server base url, e.g. http://127.0.0.1:8642")

    sub = parser.add_subparsers(dest="command", required=True)

    init_cmd = sub.add_parser("init", help="Register + login + bind local device")
    init_cmd.add_argument("--email", required=True)
    init_cmd.add_argument("--password", required=True)
    init_cmd.add_argument("--device-id", default=None)
    init_cmd.add_argument("--device-name", default=None)
    init_cmd.add_argument("--skip-register", action="store_true")
    init_cmd.set_defaults(func=cmd_init)

    push_cmd = sub.add_parser("push-sample", help="Push one sample report event")
    push_cmd.add_argument("--access-token", required=True)
    push_cmd.add_argument("--event-id", default=None)
    push_cmd.add_argument("--object-id", default=None)
    push_cmd.add_argument("--summary", default="sample local analysis output")
    push_cmd.set_defaults(func=cmd_push_sample)

    pull_cmd = sub.add_parser("pull", help="Pull events by cursor")
    pull_cmd.add_argument("--access-token", required=True)
    pull_cmd.add_argument("--cursor", type=int, default=0)
    pull_cmd.add_argument("--limit", type=int, default=100)
    pull_cmd.add_argument("--device-id", default=None)
    pull_cmd.set_defaults(func=cmd_pull)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
