/**
 * Shared auth helpers for the 0tan Electron renderer.
 *
 *   - Login / register / refresh against the api_server (gateway/platforms/api_server.py)
 *   - Token storage in localStorage so the user is remembered across launches
 *   - "Local-only" skip path so the app remains usable when no cloud is configured
 *
 * Exposes window.zcAuth (UMD-ish) so other scripts can call it without imports.
 */
(() => {
  const LS_KEYS = {
    accessToken: "wb_access_token",
    refreshToken: "wb_refresh_token",
    user: "wb_user",
    userId: "wb_user_id",
    apiBase: "zc_api_base",
    skip: "zc_local_only",
  };

  function getApiBase() {
    const v = (localStorage.getItem(LS_KEYS.apiBase) || "").trim();
    if (v) return v.replace(/\/$/, "");
    const seeded = (window.__ZC_API_BASE_DEFAULT__ || "").trim();
    return seeded.replace(/\/$/, "");
  }

  /** Fetch the sidecar's bootstrap config (API_BASE preset etc.) once. */
  async function loadDesktopConfig() {
    try {
      const params = new URLSearchParams(window.location.search);
      const tok = params.get("token") || "";
      const url = tok ? `/api/desktop-config?token=${encodeURIComponent(tok)}` : "/api/desktop-config";
      const r = await fetch(url, { method: "GET" });
      if (!r.ok) return null;
      const data = await r.json();
      if (data && typeof data.api_base_default === "string" && data.api_base_default) {
        window.__ZC_API_BASE_DEFAULT__ = data.api_base_default;
      }
      return data;
    } catch (_) {
      return null;
    }
  }

  function setApiBase(value) {
    const v = String(value || "").trim().replace(/\/$/, "");
    if (v) localStorage.setItem(LS_KEYS.apiBase, v);
    else localStorage.removeItem(LS_KEYS.apiBase);
  }

  function getAccessToken() {
    return localStorage.getItem(LS_KEYS.accessToken) || "";
  }

  function isLocalOnly() {
    return localStorage.getItem(LS_KEYS.skip) === "1";
  }

  function isAuthed() {
    return Boolean(getAccessToken()) || isLocalOnly();
  }

  function clearTokens() {
    localStorage.removeItem(LS_KEYS.accessToken);
    localStorage.removeItem(LS_KEYS.refreshToken);
  }

  function clearAll() {
    Object.values(LS_KEYS).forEach((k) => localStorage.removeItem(k));
  }

  function persistSession({ access_token, refresh_token, email, user_id }) {
    if (access_token) localStorage.setItem(LS_KEYS.accessToken, access_token);
    if (refresh_token) localStorage.setItem(LS_KEYS.refreshToken, refresh_token);
    if (email) localStorage.setItem(LS_KEYS.user, email);
    if (user_id) localStorage.setItem(LS_KEYS.userId, user_id);
    localStorage.removeItem(LS_KEYS.skip);
  }

  function setLocalOnly() {
    clearTokens();
    localStorage.setItem(LS_KEYS.skip, "1");
    localStorage.setItem(LS_KEYS.user, "本机用户");
  }

  /**
   * @param {string} path  e.g. "/v1/auth/login"
   * @param {{method?: string, body?: any, retryAuthOn401?: boolean, _retried?: boolean}} opts
   */
  async function apiFetch(path, opts = {}) {
    const apiBase = getApiBase();
    if (!apiBase) {
      throw new Error("API_BASE_NOT_SET");
    }
    const headers = {
      "Content-Type": "application/json",
    };
    const tk = getAccessToken();
    if (tk) headers.Authorization = `Bearer ${tk}`;

    const url = `${apiBase}${path}`;
    const init = {
      method: opts.method || "GET",
      headers,
    };
    if (opts.body !== undefined) {
      init.body = JSON.stringify(opts.body);
    }

    const resp = await fetch(url, init);
    let data = null;
    try {
      data = await resp.json();
    } catch (_) {
      data = null;
    }

    if (!resp.ok) {
      if (
        resp.status === 401 &&
        opts.retryAuthOn401 &&
        !opts._retried &&
        getAccessToken()
      ) {
        const next = await refreshSession();
        if (next) {
          return apiFetch(path, { ...opts, _retried: true });
        }
      }
      const msg =
        (data && data.error && (data.error.message || data.error.code)) ||
        `HTTP ${resp.status}`;
      const err = new Error(msg);
      err.status = resp.status;
      throw err;
    }
    return data || {};
  }

  async function refreshSession() {
    const refresh_token = localStorage.getItem(LS_KEYS.refreshToken) || "";
    if (!refresh_token) return null;
    try {
      const data = await apiFetch("/v1/auth/refresh", {
        method: "POST",
        body: { refresh_token },
      });
      if (data && data.access_token) {
        localStorage.setItem(LS_KEYS.accessToken, data.access_token);
        if (data.refresh_token) {
          localStorage.setItem(LS_KEYS.refreshToken, data.refresh_token);
        }
        return data.access_token;
      }
    } catch (_) {
      /* fallthrough */
    }
    clearTokens();
    return null;
  }

  async function login(email, password) {
    const data = await apiFetch("/v1/auth/login", {
      method: "POST",
      body: { email, password },
    });
    persistSession({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      email: data.email || email,
      user_id: data.user_id,
    });
    return data;
  }

  async function register(email, password) {
    return apiFetch("/v1/auth/register", {
      method: "POST",
      body: { email, password },
    });
  }

  async function logout() {
    const tk = getAccessToken();
    if (tk && getApiBase()) {
      try {
        await apiFetch("/v1/auth/logout", { method: "POST" });
      } catch (_) {
        /* keep local cleanup even if remote fails */
      }
    }
    clearAll();
  }

  function navigate(target) {
    const params = new URLSearchParams(window.location.search);
    const tok = params.get("token");
    const url = new URL(target, window.location.href);
    if (tok && !url.searchParams.get("token")) url.searchParams.set("token", tok);
    window.location.href = url.toString();
  }

  function getUserEmail() {
    return localStorage.getItem(LS_KEYS.user) || "";
  }

  window.zcAuth = {
    LS_KEYS,
    getApiBase,
    setApiBase,
    getAccessToken,
    getUserEmail,
    isAuthed,
    isLocalOnly,
    persistSession,
    clearAll,
    setLocalOnly,
    apiFetch,
    refreshSession,
    login,
    register,
    logout,
    navigate,
    loadDesktopConfig,
  };
})();
