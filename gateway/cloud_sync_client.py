import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional


class CloudSyncClient:
    """Low-friction client wrapper for cloud/local sync APIs."""

    def __init__(self, base_url: str, access_token: Optional[str] = None, timeout: int = 15):
        self.base_url = base_url.rstrip("/")
        self.access_token = access_token
        self.timeout = timeout

    def set_access_token(self, access_token: str) -> None:
        self.access_token = access_token

    def _request(self, method: str, path: str, payload: Optional[Dict[str, Any]] = None, auth: bool = False) -> Dict[str, Any]:
        url = f"{self.base_url}{path}"
        headers = {"Content-Type": "application/json"}
        if auth and self.access_token:
            headers["Authorization"] = f"Bearer {self.access_token}"
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(url=url, method=method.upper(), data=data, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="ignore")
            try:
                body = json.loads(raw) if raw else {}
            except Exception:
                body = {"error": {"message": raw or str(exc)}}
            message = body.get("error", {}).get("message", f"HTTP {exc.code}")
            raise RuntimeError(message) from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"Network error: {exc}") from exc

    def register(self, email: str, password: str) -> Dict[str, Any]:
        return self._request("POST", "/v1/auth/register", {"email": email, "password": password})

    def login(self, email: str, password: str, device_id: Optional[str] = None) -> Dict[str, Any]:
        payload: Dict[str, Any] = {"email": email, "password": password}
        if device_id:
            payload["device_id"] = device_id
        data = self._request("POST", "/v1/auth/login", payload)
        token = data.get("access_token")
        if token:
            self.access_token = token
        return data

    def refresh(self, refresh_token: str) -> Dict[str, Any]:
        data = self._request("POST", "/v1/auth/refresh", {"refresh_token": refresh_token})
        token = data.get("access_token")
        if token:
            self.access_token = token
        return data

    def register_device(self, name: str, os_name: str, device_id: Optional[str] = None) -> Dict[str, Any]:
        payload: Dict[str, Any] = {"name": name, "os": os_name}
        if device_id:
            payload["device_id"] = device_id
        return self._request("POST", "/v1/devices/register", payload, auth=True)

    def list_devices(self) -> Dict[str, Any]:
        return self._request("GET", "/v1/devices", auth=True)

    def heartbeat(self, device_id: str) -> Dict[str, Any]:
        return self._request("POST", "/v1/devices/heartbeat", {"device_id": device_id}, auth=True)

    def push_events(self, events: List[Dict[str, Any]]) -> Dict[str, Any]:
        return self._request("POST", "/v1/sync/push", {"events": events}, auth=True)

    def pull_events(self, cursor: int = 0, limit: int = 100, device_id: Optional[str] = None) -> Dict[str, Any]:
        query = {"cursor": str(cursor), "limit": str(limit)}
        if device_id:
            query["device_id"] = device_id
        q = urllib.parse.urlencode(query)
        return self._request("GET", f"/v1/sync/pull?{q}", auth=True)
