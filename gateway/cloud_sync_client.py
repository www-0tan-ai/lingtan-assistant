import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional


class CloudSyncClient:
    """HTTP client wrapper for Lingtan cloud/local sync REST APIs."""

    def __init__(
        self,
        base_url: str,
        access_token: Optional[str] = None,
        timeout: int = 15,
        device_id: Optional[str] = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.access_token = access_token
        self.timeout = timeout
        self.device_id = device_id

    def set_access_token(self, access_token: str) -> None:
        self.access_token = access_token

    def set_device_id(self, device_id: Optional[str]) -> None:
        self.device_id = device_id

    def _request(
        self,
        method: str,
        path: str,
        payload: Optional[Dict[str, Any]] = None,
        auth: bool = False,
        *,
        include_device_header: bool = False,
    ) -> Dict[str, Any]:
        url = f"{self.base_url}{path}"
        headers = {"Content-Type": "application/json"}
        if auth and self.access_token:
            headers["Authorization"] = f"Bearer {self.access_token}"
        if include_device_header and self.device_id and str(self.device_id).strip():
            headers["X-Lingtan-Device-Id"] = str(self.device_id).strip()
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
        lid = device_id or self.device_id
        if lid:
            payload["device_id"] = lid
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

    def list_workspaces(self) -> Dict[str, Any]:
        return self._request("GET", "/v1/workspaces", auth=True)

    def list_collector_tasks(self, workspace_id: Optional[str] = None) -> Dict[str, Any]:
        q = f"?workspace_id={urllib.parse.quote(workspace_id)}" if workspace_id else ""
        return self._request("GET", f"/v1/collector/tasks{q}", auth=True)

    def create_collector_task(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return self._request("POST", "/v1/collector/tasks", payload, auth=True)

    def patch_collector_task(self, task_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        return self._request("PATCH", f"/v1/collector/tasks/{urllib.parse.quote(task_id)}", payload, auth=True)

    def run_collector_task(self, task_id: str, workspace_id: Optional[str] = None) -> Dict[str, Any]:
        body: Dict[str, Any] = {}
        if workspace_id:
            body["workspace_id"] = workspace_id
        return self._request(
            "POST",
            f"/v1/collector/tasks/{urllib.parse.quote(task_id)}/run",
            body,
            auth=True,
        )

    def create_report(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return self._request("POST", "/v1/reports", payload, auth=True)

    def list_reports(self, workspace_id: Optional[str] = None, limit: int = 100) -> Dict[str, Any]:
        parts = []
        if workspace_id:
            parts.append(f"workspace_id={urllib.parse.quote(workspace_id)}")
        parts.append(f"limit={limit}")
        return self._request("GET", "/v1/reports?" + "&".join(parts), auth=True)

    def get_report(self, report_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/v1/reports/{urllib.parse.quote(report_id)}", auth=True)

    def push_events(
        self,
        events: List[Dict[str, Any]],
        *,
        device_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        did = device_id or self.device_id
        payload: Dict[str, Any] = {"events": events}
        if did:
            payload["device_id"] = str(did).strip()
        return self._request("POST", "/v1/sync/push", payload, auth=True, include_device_header=True)

    def pull_events(
        self,
        cursor: int = 0,
        limit: int = 100,
        device_id: Optional[str] = None,
        *,
        workspace_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        did = device_id or self.device_id
        query: Dict[str, str] = {"cursor": str(cursor), "limit": str(limit)}
        if did:
            query["device_id"] = str(did).strip()
        if workspace_id:
            query["workspace_id"] = str(workspace_id).strip()
        q = urllib.parse.urlencode(query)
        return self._request(
            "GET",
            f"/v1/sync/pull?{q}",
            auth=True,
            include_device_header=True,
        )
