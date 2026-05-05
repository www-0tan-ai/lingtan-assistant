/**
 * 与 `lingtan-auth-contract.js` / `GET /v1/capabilities` → `lingtan_browser_sdk` 对齐。
 * 自建前端 dev server：请复制 `lingtan-auth-contract.js`，勿改 wb_* 键名。
 */
function lingtanContract() {
  const c = typeof window !== "undefined" && window.LINGTAN_AUTH_CONTRACT ? window.LINGTAN_AUTH_CONTRACT : null;
  if (c) return c;
  return {
    CONTRACT_VERSION: 0,
    localStorageKeys: {
      accessToken: "wb_access_token",
      refreshToken: "wb_refresh_token",
      gatewayBearer: "wb_gateway_bearer",
      deviceId: "wb_device_id",
      syncCursor: "wb_sync_cursor",
      hermesSessionId: "wb_hermes_session_id",
      chatFork: "wb_chat_fork",
      subagent: "wb_subagent",
      subagentLegacy: "wb_sunagent",
    },
    paths: {
      register: "/v1/auth/register",
      login: "/v1/auth/login",
      refresh: "/v1/auth/refresh",
      logout: "/v1/auth/logout",
      capabilities: "/v1/capabilities",
    },
    jsonFields: { accessToken: "access_token", refreshToken: "refresh_token" },
  };
}

const LC = lingtanContract();
const LS = LC.localStorageKeys;
const LP = LC.paths;
const LF = LC.jsonFields;

/** One-time: rename mistaken "sunagent" localStorage key → subagent delegate mode. */
function migrateSubagentLocalStorage(keys) {
  if (localStorage.getItem(keys.subagent) != null) return;
  const legacy = localStorage.getItem(keys.subagentLegacy);
  if (legacy != null) {
    localStorage.setItem(keys.subagent, legacy);
    localStorage.removeItem(keys.subagentLegacy);
  }
}
migrateSubagentLocalStorage(LS);

function getApiBase() {
  try {
    const fromBody = (document.body && document.body.dataset && document.body.dataset.apiBase) || "";
    const win =
      typeof window !== "undefined" ? String(window.__LINGTAN_API_BASE__ || window.__HERMES_UI_API_BASE__ || "") : "";
    const b = String(fromBody || win).trim().replace(/\/$/, "");
    return b;
  } catch (_) {
    return "";
  }
}

/** Absolute or same-origin relative URL for fetch. */
function apiUrl(path) {
  const p = path.startsWith("/") ? path : `/${path}`;
  const base = getApiBase();
  if (!base) return p;
  return `${base}${p}`;
}

function showOriginWarnings() {
  const el = $("origin-warning");
  if (!el) return;
  const badFile = typeof location !== "undefined" && location.protocol === "file:";
  if (badFile) el.classList.remove("hidden");
}

const state = {
  accessToken: localStorage.getItem(LS.accessToken) || "",
  /** 与网关 API_SERVER_KEY 相同，用于 OpenAI 兼容鉴权下浏览 Skills/Agents（无需灵碳账号） */
  gatewayBearer: localStorage.getItem(LS.gatewayBearer) || "",
  deviceId: localStorage.getItem(LS.deviceId) || "",
  pullCursor: Number(localStorage.getItem(LS.syncCursor)) || 0,
  email: "",
  hermesSessionId: localStorage.getItem(LS.hermesSessionId) || "",
  subagentDelegateMode: localStorage.getItem(LS.subagent) === "1",
};

/** Full skill payloads from GET /v1/assistant/skills (for filtering). */
let skillsCatalogCache = [];
/** Full agent payloads from GET /v1/assistant/agents */
let agentsCatalogCache = [];
/** GET /v1/workspaces — 左侧栏灵碳云端工作空间 */
let workspacesRailCache = [];

const RAIL_SKILLS_CAP = 100;
const RAIL_AGENTS_CAP = 80;

function $(id) {
  return document.getElementById(id);
}

function setPanel(id, obj) {
  $(id).textContent = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
}

function setLoginError(text = "") {
  const el = $("login-error");
  if (el) el.textContent = text;
}

function syncHeaders(includeDevice) {
  const h = {};
  if (includeDevice && state.deviceId) {
    h["X-Lingtan-Device-Id"] = state.deviceId;
  }
  return h;
}

/** 灵碳 JWT 优先；否则使用本地保存的网关 API_SERVER_KEY（与服务端 _check_auth_openai_compat 一致）。 */
function bearerForOpenAICompat() {
  return String(state.accessToken || "").trim() || String(state.gatewayBearer || "").trim();
}

function persistGatewayBearer(raw) {
  const v = String(raw || "").trim();
  state.gatewayBearer = v;
  if (v) localStorage.setItem(LS.gatewayBearer, v);
  else localStorage.removeItem(LS.gatewayBearer);
}

/** 写入灵碳 JWT / refresh_token（键名见 LINGTAN_AUTH_CONTRACT）。 */
function persistTokensFromLogin(body) {
  const atRaw = body && body[LF.accessToken];
  state.accessToken = atRaw ? String(atRaw).trim() : "";
  if (state.accessToken) localStorage.setItem(LS.accessToken, state.accessToken);
  else localStorage.removeItem(LS.accessToken);
  const rtRaw = body && body[LF.refreshToken];
  if (rtRaw) localStorage.setItem(LS.refreshToken, String(rtRaw).trim());
  else localStorage.removeItem(LS.refreshToken);
}

/** 仅网关密钥、无灵碳账号时，用本地 web- 会话走 SessionDB。 */
async function ensureLocalWebSessionForGatewayOnly() {
  if (state.accessToken) return;
  if ((state.hermesSessionId || "").trim()) return;
  state.hermesSessionId = generateForkedWebSessionId();
  localStorage.setItem(LS.hermesSessionId, state.hermesSessionId);
  localStorage.setItem(LS.chatFork, "1");
  updateSessionHint();
}

function generateForkedWebSessionId() {
  let id = "";
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      id = `web-${crypto.randomUUID()}`;
    }
  } catch (_) {
    id = "";
  }
  if (!id) id = `web-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return id;
}

/**
 * Align Web UI Hermes SessionDB id with gateway policy:
 * - Normal: Lingtan-account default (`GET /v1/assistant/chat-session/default`) → same thread after clearing storage.
 * - Forked (“新建对话”): random `web-…`, only stored locally（`LINGTAN_AUTH_CONTRACT.localStorageKeys.chatFork`）。
 */
async function hydrateHermesSessionFromServer() {
  if (!state.accessToken) return;
  const fork = localStorage.getItem(LS.chatFork) === "1";
  if (fork) {
    if (!(state.hermesSessionId || "").trim()) {
      state.hermesSessionId = generateForkedWebSessionId();
      localStorage.setItem(LS.hermesSessionId, state.hermesSessionId);
    }
    updateSessionHint();
    return;
  }
  try {
    const data = await api("/v1/assistant/chat-session/default", { auth: true, method: "GET" });
    const sid = String(data.session_id || "").trim();
    if (!sid) throw new Error("empty session_id");
    state.hermesSessionId = sid;
    localStorage.setItem(LS.hermesSessionId, sid);
  } catch (e) {
    console.warn("chat-session/default failed:", e);
    if (!(state.hermesSessionId || "").trim()) {
      state.hermesSessionId = generateForkedWebSessionId();
      localStorage.setItem(LS.hermesSessionId, state.hermesSessionId);
    }
  }
  updateSessionHint();
}

async function bootstrapLoggedInUi() {
  await hydrateHermesSessionFromServer();
  await refreshSkillsCatalog();
  await refreshAgentsRoster();
  await refreshWorkspacesRail();
  await loadConversationIntoChat();
}

/** 仅配置了网关 API_SERVER_KEY、未登录灵碳时：拉目录 + 本地会话。 */
async function bootstrapGatewayBearerOnlyUi() {
  await ensureLocalWebSessionForGatewayOnly();
  await refreshSkillsCatalog();
  await refreshAgentsRoster();
  workspacesRailCache = [];
  const rw = $("rail-workspaces-list");
  if (rw) rw.innerHTML = "<p class='rail-empty'>工作空间需灵碳账号登录</p>";
  await loadConversationIntoChat();
}

function updateSessionHint() {
  const el = $("session-hint");
  if (!el) return;
  const sid = state.hermesSessionId || "";
  const fork = localStorage.getItem(LS.chatFork) === "1";
  const label = fork ? "[分支会话] " : "[主会话·账号默认] ";
  el.textContent = sid ? `${label}${sid.slice(0, 40)}…` : `${label}(未就绪)`;
}

function railCatalogQuery() {
  return (($("rail-catalog-filter") && $("rail-catalog-filter").value) || "").trim().toLowerCase();
}

function showTab(tab, opts = {}) {
  const doRefetch = opts.refetch !== false;
  document.querySelectorAll(".nav-btn").forEach((x) => x.classList.remove("active"));
  document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
  document.querySelectorAll(`.nav-btn[data-tab="${tab}"]`).forEach((nav) => nav.classList.add("active"));
  const panel = document.getElementById(`tab-${tab}`);
  if (panel) panel.classList.add("active");
  if (!doRefetch) return;
  if (tab === "skills" && bearerForOpenAICompat()) refreshSkillsCatalog();
  if (tab === "agents" && bearerForOpenAICompat()) refreshAgentsRoster();
  if (tab === "chat" && bearerForOpenAICompat()) loadConversationIntoChat();
}

function renderRailSkills() {
  const wrap = $("rail-skills-list");
  const countEl = $("rail-skills-count");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (countEl) countEl.textContent = "";
  if (!bearerForOpenAICompat()) {
    wrap.innerHTML = "<p class='rail-empty'>登录或配置网关 Key 后加载</p>";
    return;
  }
  const q = railCatalogQuery();
  let list = skillsCatalogCache.slice();
  if (q) {
    list = list.filter((s) => {
      const hay = `${s.name || ""}\n${s.description || ""}\n${s.category || ""}`.toLowerCase();
      return hay.includes(q);
    });
  }
  const total = skillsCatalogCache.length;
  if (countEl) countEl.textContent = total ? `· ${list.length}/${total}` : "";
  if (!total) {
    wrap.innerHTML = "<p class='rail-empty'>主区刷新 Skills 后与这里同步</p>";
    return;
  }
  if (!list.length) {
    wrap.innerHTML = "<p class='rail-empty'>无匹配项</p>";
    return;
  }
  const slice = list.slice(0, RAIL_SKILLS_CAP);
  for (const s of slice) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rail-item" + (s.enabled_in_config === false ? " is-disabled" : "");
    const nm = String(s.name || "").trim() || "(未命名)";
    btn.textContent = nm;
    btn.title = String(s.description || "").slice(0, 280);
    btn.addEventListener("click", () => {
      showTab("skills", { refetch: false });
      const sf = $("skills-filter");
      if (sf) sf.value = nm;
      applySkillsFilterAndRender();
    });
    wrap.appendChild(btn);
  }
  if (list.length > RAIL_SKILLS_CAP) {
    const p = document.createElement("p");
    p.className = "rail-more";
    p.textContent = `另有 ${list.length - RAIL_SKILLS_CAP} 项未显示，请收窄筛选或看主区完整列表`;
    wrap.appendChild(p);
  }
}

function renderRailAgents() {
  const wrap = $("rail-agents-list");
  const countEl = $("rail-agents-count");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (countEl) countEl.textContent = "";
  if (!bearerForOpenAICompat()) {
    wrap.innerHTML = "<p class='rail-empty'>登录或配置网关 Key 后加载</p>";
    return;
  }
  const q = railCatalogQuery();
  let list = agentsCatalogCache.slice();
  if (q) {
    list = list.filter((a) => {
      const hay = `${a.name || ""}\n${a.id || ""}\n${a.description || ""}`.toLowerCase();
      return hay.includes(q);
    });
  }
  const total = agentsCatalogCache.length;
  if (countEl) countEl.textContent = total ? `· ${list.length}/${total}` : "";
  if (!total) {
    wrap.innerHTML = "<p class='rail-empty'>主区刷新 Agents 后与这里同步</p>";
    return;
  }
  if (!list.length) {
    wrap.innerHTML = "<p class='rail-empty'>无匹配项</p>";
    return;
  }
  const slice = list.slice(0, RAIL_AGENTS_CAP);
  for (const a of slice) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rail-item";
    const label = String(a.name || "").trim() || String(a.id || "").trim() || "Agent";
    btn.textContent = label;
    btn.title = `${String(a.id || "").trim()} · ${String(a.description || "").slice(0, 220)}`;
    btn.addEventListener("click", () => {
      showTab("agents", { refetch: false });
    });
    wrap.appendChild(btn);
  }
  if (list.length > RAIL_AGENTS_CAP) {
    const p = document.createElement("p");
    p.className = "rail-more";
    p.textContent = `另有 ${list.length - RAIL_AGENTS_CAP} 项未显示，请收窄筛选`;
    wrap.appendChild(p);
  }
}

function renderRailWorkspaces() {
  const wrap = $("rail-workspaces-list");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (!state.accessToken) {
    wrap.innerHTML = "<p class='rail-empty'>工作空间需灵碳账号登录</p>";
    return;
  }
  if (!workspacesRailCache.length) {
    wrap.innerHTML = "<p class='rail-empty'>暂无工作空间（新账号请先完成登录）</p>";
    return;
  }
  for (const w of workspacesRailCache) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rail-item" + (w.is_default ? " is-default" : "");
    const nm = String(w.name || "").trim() || String(w.workspace_id || "").trim() || "(工作空间)";
    btn.textContent = w.is_default ? `${nm}（默认）` : nm;
    btn.title = String(w.workspace_id || "");
    btn.addEventListener("click", () => {
      setPanel("sync-result", {
        workspace_id: w.workspace_id,
        name: w.name,
        is_default: w.is_default,
        created_at: w.created_at,
      });
      showTab("sync", { refetch: false });
    });
    wrap.appendChild(btn);
  }
}

async function refreshWorkspacesRail() {
  const wrap = $("rail-workspaces-list");
  if (!wrap) return;
  if (!state.accessToken) {
    workspacesRailCache = [];
    renderRailWorkspaces();
    return;
  }
  wrap.innerHTML = "<p class='rail-empty'>加载工作空间…</p>";
  try {
    const data = await api("/v1/workspaces", { auth: true, method: "GET" });
    workspacesRailCache = Array.isArray(data.workspaces) ? data.workspaces.slice() : [];
    renderRailWorkspaces();
  } catch (e) {
    workspacesRailCache = [];
    wrap.innerHTML = "";
    const p = document.createElement("p");
    p.className = "rail-empty";
    p.textContent = `工作空间加载失败：${e.message}`;
    wrap.appendChild(p);
  }
}

function messageTextContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === "string") return p;
        if (!p || typeof p !== "object") return "";
        if (p.text != null) return String(p.text);
        if (p.input_text != null) return String(p.input_text);
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return String(content);
}

function showApp() {
  $("login-screen").classList.add("hidden");
  $("app-shell").classList.remove("hidden");
}

function showLogin() {
  $("app-shell").classList.add("hidden");
  $("login-screen").classList.remove("hidden");
}

/**
 * HTTP helper. Set options.rawResponse to read response headers (e.g. X-Hermes-Session-Id).
 */
async function api(path, options = {}) {
  const headers = {
    ...syncHeaders(Boolean(options.attachDevice)),
    "Content-Type": "application/json",
    ...(options.headers || {}),
    ...(options.extraHeaders || {}),
  };
  if (options.auth && bearerForOpenAICompat()) {
    headers.Authorization = `Bearer ${bearerForOpenAICompat()}`;
  }
  const url = apiUrl(path);
  let resp;
  try {
    resp = await fetch(url, { ...options, headers });
  } catch (e) {
    const hint =
      getApiBase() || typeof location === "undefined"
        ? ""
        : ` 当前页：${location.origin || ""}。若接口在其它主机，请在 body 上设置 data-api-base 指向网关根 URL（无尾斜杠）。`;
    throw new Error(`${e && e.message ? e.message : "网络错误"}。${hint}`.trim());
  }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    let msg = data?.error?.message || data?.error || `HTTP ${resp.status}`;
    if (resp.status === 401) {
      msg = `${msg}（401：须从运行 API Server 的 /app 打开；或 Bearer 与 API_SERVER_KEY 不一致 / 登录 token 已失效——请清除本站数据后重新登录，或在账号中心填入网关密钥。）`;
    }
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  if (options.rawResponse) {
    return { data, resp };
  }
  return data;
}

function appendMessage(role, content) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = content;
  $("chat-log").appendChild(div);
  $("chat-log").scrollTop = $("chat-log").scrollHeight;
}

function clearChatLog() {
  const el = $("chat-log");
  if (el) el.innerHTML = "";
}

async function loadConversationIntoChat() {
  if (!bearerForOpenAICompat()) return;
  await hydrateHermesSessionFromServer();
  if (!(state.hermesSessionId || "").trim()) await ensureLocalWebSessionForGatewayOnly();
  if (!(state.hermesSessionId || "").trim()) return;
  try {
    const sid = encodeURIComponent(state.hermesSessionId);
    const data = await api(`/v1/assistant/conversation?session_id=${sid}`, {
      auth: true,
      method: "GET",
    });
    clearChatLog();
    const msgs = data.messages || [];
    for (const m of msgs) {
      const role = m.role === "assistant" || m.role === "user" ? m.role : "assistant";
      const text = messageTextContent(m.content);
      if (!text.trim() && role === "assistant") continue;
      appendMessage(role, text || `[${m.role}]`);
    }
  } catch (err) {
    clearChatLog();
    appendMessage("assistant", `无法加载会话历史（将从此刻起继续记录）：${err.message}`);
  }
}

function catalogPlaceholder(wrapEl, text, classExtra = "") {
  if (!wrapEl) return;
  wrapEl.innerHTML = "";
  const p = document.createElement("p");
  p.className = `catalog-empty muted ${classExtra}`.trim();
  p.textContent = text;
  wrapEl.appendChild(p);
}

function renderSkillCardsIntoGrid(skills) {
  const wrap = $("skills-cards");
  const meta = $("skills-meta");
  if (!wrap) return;
  wrap.innerHTML = "";
  const total = skillsCatalogCache.length;
  const filt = skills.length;
  if (meta) {
    meta.textContent = total ? `共 ${total} 项 · 显示 ${filt}` : "";
  }

  if (!skills.length && total === 0) {
    catalogPlaceholder(wrap, "暂无 Skill（请检查 ~/.hermes/skills 与本仓库 skills/）");
    return;
  }
  if (!skills.length) {
    catalogPlaceholder(wrap, "没有匹配的 Skill（清空搜索框试试看）");
    return;
  }

  for (const s of skills) {
    const card = document.createElement("article");
    card.className = "catalog-card skill-card";
    if (s.enabled_in_config === false) card.classList.add("is-disabled");

    const head = document.createElement("div");
    head.className = "card-head";
    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = String(s.name || "").trim() || "(未命名 Skill)";
    head.appendChild(title);

    const badges = document.createElement("div");
    badges.className = "card-badges";
    const cat = (s.category && String(s.category).trim()) || "";
    if (cat) {
      const b = document.createElement("span");
      b.className = "badge badge-muted";
      b.textContent = cat;
      badges.appendChild(b);
    }
    const st = document.createElement("span");
    st.className = "badge " + (s.enabled_in_config !== false ? "badge-on" : "badge-off");
    st.textContent = s.enabled_in_config !== false ? "启用" : "已停用";
    badges.appendChild(st);
    head.appendChild(badges);
    card.appendChild(head);

    const desc = document.createElement("p");
    desc.className = "card-desc";
    const d = String(s.description || "").trim();
    desc.textContent = d || "（尚无描述）";
    card.appendChild(desc);

    wrap.appendChild(card);
  }
}

function applySkillsFilterAndRender() {
  const raw = (($("skills-filter") && $("skills-filter").value) || "").trim().toLowerCase();
  if (!raw) {
    renderSkillCardsIntoGrid(skillsCatalogCache.slice());
    return;
  }
  const filtered = skillsCatalogCache.filter((s) => {
    const hay = `${s.name || ""}\n${s.description || ""}\n${s.category || ""}`.toLowerCase();
    return hay.includes(raw);
  });
  renderSkillCardsIntoGrid(filtered);
}

async function refreshSkillsCatalog() {
  const wrap = $("skills-cards");
  const meta = $("skills-meta");
  if (!wrap) return;

  if (!bearerForOpenAICompat()) {
    skillsCatalogCache = [];
    if (meta) meta.textContent = "";
    catalogPlaceholder(
      wrap,
      "请先登录灵碳账号，或在登录页 / 账号中心填写「网关 API Key」（与 API_SERVER_KEY 相同）后再点「刷新」。",
    );
    renderRailSkills();
    return;
  }

  const rw = $("rail-skills-list");
  if (rw) rw.innerHTML = "<p class='rail-empty'>加载中…</p>";

  catalogPlaceholder(wrap, "加载中…");
  try {
    const data = await api("/v1/assistant/skills", { auth: true, method: "GET" });
    if (!data.success) {
      catalogPlaceholder(wrap, `Skills 加载失败：${data.error || "未知错误"}`, "");
      skillsCatalogCache = [];
      if (meta) meta.textContent = "";
      renderRailSkills();
      return;
    }
    skillsCatalogCache = Array.isArray(data.skills) ? data.skills.slice() : [];
    applySkillsFilterAndRender();
    renderRailSkills();
  } catch (e) {
    skillsCatalogCache = [];
    if (meta) meta.textContent = "";
    catalogPlaceholder(wrap, `加载失败：${e.message}`);
    renderRailSkills();
  }
}

function renderAgentCardsIntoGrid(agents) {
  const wrap = $("agents-cards");
  const meta = $("agents-meta");
  if (!wrap) return;
  wrap.innerHTML = "";
  agentsCatalogCache = Array.isArray(agents) ? agents.slice() : [];
  const n = agentsCatalogCache.length;
  if (meta) meta.textContent = n ? `已配置 Agents：${n}` : "";

  if (!n) {
    catalogPlaceholder(
      wrap,
      "暂无 Agents：服务器 config 里 lingtan_ui.agents 为空或全部 enabled:false。若你从未改过该项，检查 ~/.hermes/config.yaml 是否误写了 lingtan_ui.agents: []；删掉该项可恢复内置默认专家列表。",
    );
    return;
  }

  for (const a of agentsCatalogCache) {
    const card = document.createElement("article");
    card.className = "catalog-card agent-card";

    const head = document.createElement("div");
    head.className = "card-head";
    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = String(a.name || "").trim() || String(a.id || "").trim() || "Agent";
    head.appendChild(title);

    const badges = document.createElement("div");
    badges.className = "card-badges";
    const bd = document.createElement("span");
    bd.className = "badge badge-on";
    bd.textContent = "子代理";
    badges.appendChild(bd);
    head.appendChild(badges);
    card.appendChild(head);

    const sid = document.createElement("p");
    sid.className = "card-agent-id";
    sid.textContent = `id · ${String(a.id || "").trim() || "(无)"}`;
    card.appendChild(sid);

    const desc = document.createElement("p");
    desc.className = "card-desc";
    desc.textContent = String(a.description || "").trim() || "（暂无说明）";
    card.appendChild(desc);

    const toolsets = Array.isArray(a.toolsets) ? a.toolsets.filter(Boolean) : [];
    const row = document.createElement("div");
    row.className = "toolset-row";
    if (toolsets.length) {
      for (const t of toolsets) {
        const chip = document.createElement("span");
        chip.className = "toolset-chip";
        chip.textContent = String(t);
        row.appendChild(chip);
      }
    } else {
      const chip = document.createElement("span");
      chip.className = "toolset-chip";
      chip.textContent = "（未声明 toolsets）";
      row.appendChild(chip);
    }
    card.appendChild(row);

    wrap.appendChild(card);
  }
}

async function refreshAgentsRoster() {
  const wrap = $("agents-cards");
  const meta = $("agents-meta");
  if (!wrap) return;

  if (!bearerForOpenAICompat()) {
    agentsCatalogCache = [];
    if (meta) meta.textContent = "";
    catalogPlaceholder(
      wrap,
      "请先登录灵碳账号，或在登录页 / 账号中心填写「网关 API Key」（与 API_SERVER_KEY 相同）后再点「刷新」。",
    );
    renderRailAgents();
    return;
  }

  const ra = $("rail-agents-list");
  if (ra) ra.innerHTML = "<p class='rail-empty'>加载中…</p>";

  catalogPlaceholder(wrap, "加载中…");
  try {
    const data = await api("/v1/assistant/agents", { auth: true, method: "GET" });
    const agents = Array.isArray(data.agents) ? data.agents : [];
    renderAgentCardsIntoGrid(agents);
    renderRailAgents();
  } catch (e) {
    agentsCatalogCache = [];
    if (meta) meta.textContent = "";
    catalogPlaceholder(wrap, `加载失败：${e.message}`);
    renderRailAgents();
  }
}

async function sendChat() {
  const input = $("chat-input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  appendMessage("user", text);
  await hydrateHermesSessionFromServer();
  if (!(state.hermesSessionId || "").trim()) await ensureLocalWebSessionForGatewayOnly();
  const sid = (state.hermesSessionId || "").trim();
  if (!sid) {
    appendMessage("assistant", "无法发送：会话未就绪（请稍后重试或重新登录）。");
    return;
  }
  try {
    const extraHeaders = { "X-Hermes-Session-Id": sid };
    if (state.subagentDelegateMode) extraHeaders["X-Lingtan-Subagent"] = "1";

    const { data, resp } = await api("/v1/chat/completions", {
      method: "POST",
      auth: true,
      rawResponse: true,
      extraHeaders,
      body: JSON.stringify({
        model: "assistant-core",
        messages: [{ role: "user", content: text }],
        stream: false,
        subagent: Boolean(state.subagentDelegateMode),
      }),
    });

    const hdrSid = resp.headers.get("X-Hermes-Session-Id");
    if (hdrSid && hdrSid.trim()) {
      state.hermesSessionId = hdrSid.trim();
      localStorage.setItem(LS.hermesSessionId, state.hermesSessionId);
      updateSessionHint();
    }

    const msg = data?.choices?.[0]?.message?.content || "（无回复）";
    appendMessage("assistant", typeof msg === "string" ? msg : messageTextContent(msg));
  } catch (err) {
    appendMessage("assistant", `请求失败: ${err.message}`);
  }
}

async function register() {
  try {
    const email = $("email").value.trim();
    const password = $("password").value;
    const data = await api(LP.register, {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    state.email = email;
    setPanel("account-result", data);
  } catch (err) {
    setPanel("account-result", `注册失败: ${err.message}`);
  }
}

async function login() {
  try {
    const email = $("email").value.trim();
    const password = $("password").value;
    const data = await api(LP.login, {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    persistTokensFromLogin(data);
    setPanel("account-result", data);
    showApp();
    await bootstrapLoggedInUi();
  } catch (err) {
    setPanel("account-result", `登录失败: ${err.message}`);
  }
}

async function landingLogin() {
  try {
    const email = $("login-email").value.trim();
    const password = $("login-password").value;
    if (!email || !password) {
      setLoginError("请输入邮箱和密码");
      return;
    }
    const data = await api(LP.login, {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    persistTokensFromLogin(data);
    $("email").value = email;
    $("password").value = password;
    setPanel("account-result", data);
    setLoginError("");
    showApp();
    await bootstrapLoggedInUi();
  } catch (err) {
    setLoginError(`登录失败: ${err.message}`);
  }
}

async function landingRegister() {
  try {
    const email = $("login-email").value.trim();
    const password = $("login-password").value;
    if (!email || !password) {
      setLoginError("请输入邮箱和密码");
      return;
    }
    await api(LP.register, {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    setLoginError("注册成功，请点击登录。");
  } catch (err) {
    setLoginError(`注册失败: ${err.message}`);
  }
}

async function bindDevice() {
  try {
    const data = await api("/v1/devices/register", {
      method: "POST",
      auth: true,
      attachDevice: false,
      body: JSON.stringify({
        name: "lingtan-web",
        os: navigator.platform || "web",
      }),
    });
    if (data.device_id) {
      state.deviceId = data.device_id;
      localStorage.setItem(LS.deviceId, state.deviceId);
    }
    setPanel("account-result", data);
  } catch (err) {
    setPanel("account-result", `绑定失败: ${err.message}`);
  }
}

async function pushSample() {
  try {
    if (!state.deviceId) {
      setPanel("sync-result", "请先在「账号中心」点击「绑定设备」，再推送或拉取同步。");
      return;
    }
    const event = {
      event_id: `evt-${Date.now()}`,
      object_type: "analysis_report",
      object_id: `report-${Date.now()}`,
      op: "upsert",
      payload: { summary: "来自灵碳助手 UI 的样例同步数据" },
      occurred_at: Math.floor(Date.now() / 1000),
      visibility: "aggregate_ok",
      cloud_allow: true,
    };
    const data = await api("/v1/sync/push", {
      method: "POST",
      auth: true,
      attachDevice: true,
      body: JSON.stringify({ events: [event], device_id: state.deviceId }),
    });
    setPanel("sync-result", data);
  } catch (err) {
    setPanel("sync-result", `推送失败: ${err.message}`);
  }
}

async function pullEvents() {
  try {
    if (!state.deviceId) {
      setPanel("sync-result", "请先在「账号中心」绑定设备后再拉取同步。");
      return;
    }
    const qs = new URLSearchParams({
      cursor: String(state.pullCursor),
      limit: "50",
      device_id: state.deviceId,
    });
    const data = await api(`/v1/sync/pull?${qs.toString()}`, {
      method: "GET",
      auth: true,
      attachDevice: true,
    });
    state.pullCursor = data.next_cursor ?? state.pullCursor;
    localStorage.setItem(LS.syncCursor, String(state.pullCursor));
    setPanel("sync-result", data);
  } catch (err) {
    setPanel("sync-result", `拉取失败: ${err.message}`);
  }
}

function bindTabs() {
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => showTab(btn.getAttribute("data-tab")));
  });
}

function logout() {
  skillsCatalogCache = [];
  agentsCatalogCache = [];
  workspacesRailCache = [];
  const sf = $("skills-filter");
  if (sf) sf.value = "";
  const rcf = $("rail-catalog-filter");
  if (rcf) rcf.value = "";
  state.accessToken = "";
  localStorage.removeItem(LS.accessToken);
  localStorage.removeItem(LS.refreshToken);
  localStorage.removeItem(LS.chatFork);
  localStorage.removeItem(LS.deviceId);
  localStorage.removeItem(LS.syncCursor);
  localStorage.removeItem(LS.hermesSessionId);
  localStorage.removeItem(LS.subagent);
  localStorage.removeItem(LS.subagentLegacy);
  state.deviceId = "";
  state.pullCursor = 0;
  state.hermesSessionId = "";
  state.subagentDelegateMode = false;
  state.email = "";
  const chk = $("chk-subagent-delegate");
  if (chk) chk.checked = false;
  catalogPlaceholder(
    $("skills-cards"),
    "请登录或配置网关 API Key（与 API_SERVER_KEY 相同）后刷新 Skills。",
  );
  catalogPlaceholder(
    $("agents-cards"),
    "请登录或配置网关 API Key（与 API_SERVER_KEY 相同）后刷新 Agents。",
  );
  const sm = $("skills-meta");
  const am = $("agents-meta");
  if (sm) sm.textContent = "";
  if (am) am.textContent = "";
  clearChatLog();
  renderRailSkills();
  renderRailAgents();
  renderRailWorkspaces();
  updateSessionHint();
  showLogin();
}

function syncSubagentDelegateCheckbox() {
  const chk = $("chk-subagent-delegate");
  if (!chk) return;
  chk.checked = Boolean(state.subagentDelegateMode);
  chk.addEventListener("change", () => {
    state.subagentDelegateMode = chk.checked;
    localStorage.setItem(LS.subagent, state.subagentDelegateMode ? "1" : "0");
  });
}

function init() {
  showOriginWarnings();
  bindTabs();
  syncSubagentDelegateCheckbox();
  $("skills-filter")?.addEventListener("input", () => applySkillsFilterAndRender());
  $("rail-catalog-filter")?.addEventListener("input", () => {
    renderRailSkills();
    renderRailAgents();
  });

  updateSessionHint();

  if (state.accessToken) {
    showApp();
    bootstrapLoggedInUi().catch((e) => console.error(e));
  } else if (bearerForOpenAICompat()) {
    showApp();
    bootstrapGatewayBearerOnlyUi().catch((e) => console.error(e));
  } else {
    showLogin();
  }

  $("landing-login")?.addEventListener("click", landingLogin);
  $("landing-register")?.addEventListener("click", landingRegister);
  $("save-gateway-preview")?.addEventListener("click", () => {
    const inp = $("gateway-bearer-landing");
    persistGatewayBearer((inp && inp.value) || "");
    if (!bearerForOpenAICompat()) {
      setLoginError("请填写网关 API Key");
      return;
    }
    setLoginError("");
    showApp();
    bootstrapGatewayBearerOnlyUi().catch((e) => console.error(e));
  });
  $("logout-btn")?.addEventListener("click", logout);

  $("send-chat")?.addEventListener("click", sendChat);
  $("chat-input")?.addEventListener("keydown", (evt) => {
    if (evt.key === "Enter" && !evt.shiftKey) {
      evt.preventDefault();
      sendChat();
    }
  });

  $("save-gateway-bearer-account")?.addEventListener("click", () => {
    const inp = $("gateway-bearer-account");
    persistGatewayBearer((inp && inp.value) || "");
    setPanel("account-result", { ok: true, saved: "网关 API Key 已保存（与 API_SERVER_KEY 相同）。Skills/Agents 将使用该 Bearer。" });
    refreshSkillsCatalog();
    refreshAgentsRoster();
  });

  $("register")?.addEventListener("click", register);
  $("login")?.addEventListener("click", login);
  $("bind-device")?.addEventListener("click", bindDevice);
  $("push-sample")?.addEventListener("click", pushSample);
  $("pull-events")?.addEventListener("click", pullEvents);
  $("refresh-skills")?.addEventListener("click", refreshSkillsCatalog);
  $("refresh-agents")?.addEventListener("click", refreshAgentsRoster);
  $("new-chat")?.addEventListener("click", async () => {
    localStorage.setItem(LS.chatFork, "1");
    clearChatLog();
    state.hermesSessionId = "";
    localStorage.removeItem(LS.hermesSessionId);
    await hydrateHermesSessionFromServer();
    if (!(state.hermesSessionId || "").trim()) await ensureLocalWebSessionForGatewayOnly();
  });

  $("restore-main-chat")?.addEventListener("click", async () => {
    localStorage.removeItem(LS.chatFork);
    clearChatLog();
    state.hermesSessionId = "";
    localStorage.removeItem(LS.hermesSessionId);
    await hydrateHermesSessionFromServer();
    if (!(state.hermesSessionId || "").trim()) await ensureLocalWebSessionForGatewayOnly();
    await loadConversationIntoChat();
  });

  document.querySelectorAll(".quick-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const prompt = chip.getAttribute("data-prompt") || "";
      $("chat-input").value = prompt;
      sendChat();
    });
  });

  if (state.accessToken) {
    setPanel("account-result", "已检测到本地登录态 — Skills · Agents · 会话 已就绪。");
  } else if (bearerForOpenAICompat()) {
    setPanel(
      "account-result",
      "当前使用网关 API Key — 可浏览 Skills/Agents；云端同步与灵碳主会话请登录账号。",
    );
  }
  const gba = $("gateway-bearer-account");
  const gbl = $("gateway-bearer-landing");
  if (gba && state.gatewayBearer) gba.value = state.gatewayBearer;
  if (gbl && state.gatewayBearer) gbl.value = state.gatewayBearer;
}

init();
