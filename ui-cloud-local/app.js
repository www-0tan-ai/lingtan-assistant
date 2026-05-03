/** One-time: rename mistaken "sunagent" localStorage key → subagent delegate mode. */
function migrateSubagentLocalStorage() {
  if (localStorage.getItem("wb_subagent") != null) return;
  const legacy = localStorage.getItem("wb_sunagent");
  if (legacy != null) {
    localStorage.setItem("wb_subagent", legacy);
    localStorage.removeItem("wb_sunagent");
  }
}
migrateSubagentLocalStorage();

const state = {
  accessToken: localStorage.getItem("wb_access_token") || "",
  deviceId: localStorage.getItem("wb_device_id") || "",
  pullCursor: Number(localStorage.getItem("wb_sync_cursor")) || 0,
  email: "",
  hermesSessionId: localStorage.getItem("wb_hermes_session_id") || "",
  subagentDelegateMode: localStorage.getItem("wb_subagent") === "1",
};

/** Full skill payloads from GET /v1/assistant/skills (for filtering). */
let skillsCatalogCache = [];
/** Full agent payloads from GET /v1/assistant/agents */
let agentsCatalogCache = [];

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
 * - Forked (“新建对话”): random `web-…`, only stored locally (`wb_chat_fork=1`).
 */
async function hydrateHermesSessionFromServer() {
  if (!state.accessToken) return;
  const fork = localStorage.getItem("wb_chat_fork") === "1";
  if (fork) {
    if (!(state.hermesSessionId || "").trim()) {
      state.hermesSessionId = generateForkedWebSessionId();
      localStorage.setItem("wb_hermes_session_id", state.hermesSessionId);
    }
    updateSessionHint();
    return;
  }
  try {
    const data = await api("/v1/assistant/chat-session/default", { auth: true, method: "GET" });
    const sid = String(data.session_id || "").trim();
    if (!sid) throw new Error("empty session_id");
    state.hermesSessionId = sid;
    localStorage.setItem("wb_hermes_session_id", sid);
  } catch (e) {
    console.warn("chat-session/default failed:", e);
    if (!(state.hermesSessionId || "").trim()) {
      state.hermesSessionId = generateForkedWebSessionId();
      localStorage.setItem("wb_hermes_session_id", state.hermesSessionId);
    }
  }
  updateSessionHint();
}

async function bootstrapLoggedInUi() {
  await hydrateHermesSessionFromServer();
  await refreshSkillsCatalog();
  await refreshAgentsRoster();
  await loadConversationIntoChat();
}

function updateSessionHint() {
  const el = $("session-hint");
  if (!el) return;
  const sid = state.hermesSessionId || "";
  const fork = localStorage.getItem("wb_chat_fork") === "1";
  const label = fork ? "[分支会话] " : "[主会话·账号默认] ";
  el.textContent = sid ? `${label}${sid.slice(0, 40)}…` : `${label}(未就绪)`;
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
  if (options.auth && state.accessToken) {
    headers.Authorization = `Bearer ${state.accessToken}`;
  }
  const resp = await fetch(path, { ...options, headers });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data?.error?.message || data?.error || `HTTP ${resp.status}`);
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
  if (!state.accessToken) return;
  await hydrateHermesSessionFromServer();
  if (!state.hermesSessionId) return;
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

  if (!state.accessToken) {
    skillsCatalogCache = [];
    if (meta) meta.textContent = "";
    catalogPlaceholder(wrap, "请先登录后再加载 Skills 卡片列表");
    return;
  }

  catalogPlaceholder(wrap, "加载中…");
  try {
    const data = await api("/v1/assistant/skills", { auth: true, method: "GET" });
    if (!data.success) {
      catalogPlaceholder(wrap, `Skills 加载失败：${data.error || "未知错误"}`, "");
      skillsCatalogCache = [];
      if (meta) meta.textContent = "";
      return;
    }
    skillsCatalogCache = Array.isArray(data.skills) ? data.skills.slice() : [];
    applySkillsFilterAndRender();
  } catch (e) {
    skillsCatalogCache = [];
    if (meta) meta.textContent = "";
    catalogPlaceholder(wrap, `加载失败：${e.message}`);
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
    catalogPlaceholder(wrap, '暂无 Agents（请在 config.yaml 的 lingtan_ui.agents 中启用）');
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

  if (!state.accessToken) {
    agentsCatalogCache = [];
    if (meta) meta.textContent = "";
    catalogPlaceholder(wrap, "请先登录后再加载 Agents 卡片列表");
    return;
  }

  catalogPlaceholder(wrap, "加载中…");
  try {
    const data = await api("/v1/assistant/agents", { auth: true, method: "GET" });
    const agents = Array.isArray(data.agents) ? data.agents : [];
    renderAgentCardsIntoGrid(agents);
  } catch (e) {
    agentsCatalogCache = [];
    if (meta) meta.textContent = "";
    catalogPlaceholder(wrap, `加载失败：${e.message}`);
  }
}

async function sendChat() {
  const input = $("chat-input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  appendMessage("user", text);
  await hydrateHermesSessionFromServer();
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
      localStorage.setItem("wb_hermes_session_id", state.hermesSessionId);
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
    const data = await api("/v1/auth/register", {
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
    const data = await api("/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    state.accessToken = data.access_token;
    localStorage.setItem("wb_access_token", state.accessToken);
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
    const data = await api("/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    state.accessToken = data.access_token;
    localStorage.setItem("wb_access_token", state.accessToken);
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
    await api("/v1/auth/register", {
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
      localStorage.setItem("wb_device_id", state.deviceId);
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
    localStorage.setItem("wb_sync_cursor", String(state.pullCursor));
    setPanel("sync-result", data);
  } catch (err) {
    setPanel("sync-result", `拉取失败: ${err.message}`);
  }
}

function bindTabs() {
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".nav-btn").forEach((x) => x.classList.remove("active"));
      document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.getAttribute("data-tab");
      document.getElementById(`tab-${tab}`).classList.add("active");
      if (tab === "skills" && state.accessToken) refreshSkillsCatalog();
      if (tab === "agents" && state.accessToken) refreshAgentsRoster();
      if (tab === "chat" && state.accessToken) loadConversationIntoChat();
    });
  });
}

function logout() {
  skillsCatalogCache = [];
  agentsCatalogCache = [];
  const sf = $("skills-filter");
  if (sf) sf.value = "";
  state.accessToken = "";
  localStorage.removeItem("wb_access_token");
  localStorage.removeItem("wb_chat_fork");
  localStorage.removeItem("wb_device_id");
  localStorage.removeItem("wb_sync_cursor");
  localStorage.removeItem("wb_hermes_session_id");
  localStorage.removeItem("wb_subagent");
  localStorage.removeItem("wb_sunagent");
  state.deviceId = "";
  state.pullCursor = 0;
  state.hermesSessionId = "";
  state.subagentDelegateMode = false;
  state.email = "";
  const chk = $("chk-subagent-delegate");
  if (chk) chk.checked = false;
  catalogPlaceholder($("skills-cards"), "请先登录后再加载 Skills 卡片列表");
  catalogPlaceholder($("agents-cards"), "请先登录后再加载 Agents 卡片列表");
  const sm = $("skills-meta");
  const am = $("agents-meta");
  if (sm) sm.textContent = "";
  if (am) am.textContent = "";
  clearChatLog();
  updateSessionHint();
  showLogin();
}

function syncSubagentDelegateCheckbox() {
  const chk = $("chk-subagent-delegate");
  if (!chk) return;
  chk.checked = Boolean(state.subagentDelegateMode);
  chk.addEventListener("change", () => {
    state.subagentDelegateMode = chk.checked;
    localStorage.setItem("wb_subagent", state.subagentDelegateMode ? "1" : "0");
  });
}

function init() {
  bindTabs();
  syncSubagentDelegateCheckbox();
  $("skills-filter")?.addEventListener("input", () => applySkillsFilterAndRender());

  updateSessionHint();

  if (state.accessToken) {
    showApp();
    bootstrapLoggedInUi().catch((e) => console.error(e));
  } else {
    showLogin();
  }

  $("landing-login")?.addEventListener("click", landingLogin);
  $("landing-register")?.addEventListener("click", landingRegister);
  $("logout-btn")?.addEventListener("click", logout);

  $("send-chat")?.addEventListener("click", sendChat);
  $("chat-input")?.addEventListener("keydown", (evt) => {
    if (evt.key === "Enter" && !evt.shiftKey) {
      evt.preventDefault();
      sendChat();
    }
  });

  $("register")?.addEventListener("click", register);
  $("login")?.addEventListener("click", login);
  $("bind-device")?.addEventListener("click", bindDevice);
  $("push-sample")?.addEventListener("click", pushSample);
  $("pull-events")?.addEventListener("click", pullEvents);
  $("refresh-skills")?.addEventListener("click", refreshSkillsCatalog);
  $("refresh-agents")?.addEventListener("click", refreshAgentsRoster);
  $("new-chat")?.addEventListener("click", async () => {
    localStorage.setItem("wb_chat_fork", "1");
    clearChatLog();
    state.hermesSessionId = "";
    localStorage.removeItem("wb_hermes_session_id");
    await hydrateHermesSessionFromServer();
  });

  $("restore-main-chat")?.addEventListener("click", async () => {
    localStorage.removeItem("wb_chat_fork");
    clearChatLog();
    state.hermesSessionId = "";
    localStorage.removeItem("wb_hermes_session_id");
    await hydrateHermesSessionFromServer();
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
  }
}

init();
