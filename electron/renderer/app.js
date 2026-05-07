/**
 * tui_gateway JSON-RPC over WebSocket — WorkBuddy-style nav + full-width workspace views.
 */
(() => {
  const REQUEST_TIMEOUT_MS = 120000;
  const AGENT_POLL_MS = 4000;
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");
  if (!token) {
    document.body.innerHTML =
      '<p style="padding:24px;font-family:sans-serif">缺少 token 查询参数。请通过 Electron 启动。</p>';
    throw new Error("missing token");
  }

  const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${wsProto}//${location.host}/api/ws?token=${encodeURIComponent(token)}`;

  class GatewayWs {
    constructor(url) {
      this.url = url;
      this.ws = null;
      this.reqId = 0;
      /** @type {Map<string, {resolve: Function, reject: Function, t: number}>} */
      this.pending = new Map();
      this.onEvent = () => {};
    }

    connect() {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(this.url);
        this.ws = ws;
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("WebSocket 连接失败"));
        ws.onclose = () => {
          for (const [, p] of this.pending) {
            clearTimeout(p.t);
            p.reject(new Error("连接已关闭"));
          }
          this.pending.clear();
        };
        ws.onmessage = (ev) => this._onMessage(ev.data);
      });
    }

    _onMessage(raw) {
      const line = String(raw).trim();
      if (!line) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      const id = msg.id;
      if (id != null && this.pending.has(String(id))) {
        const p = this.pending.get(String(id));
        clearTimeout(p.t);
        this.pending.delete(String(id));
        if (msg.error) {
          const m = msg.error.message || "request failed";
          p.reject(new Error(m));
        } else {
          p.resolve(msg.result);
        }
        return;
      }
      if (msg.method === "event" && msg.params && typeof msg.params.type === "string") {
        this.onEvent(msg.params);
      }
    }

    request(method, params = {}) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error("未连接"));
      }
      const id = `r${++this.reqId}`;
      const payload = JSON.stringify({ id, jsonrpc: "2.0", method, params });
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`timeout: ${method}`));
        }, REQUEST_TIMEOUT_MS);
        this.pending.set(id, { resolve, reject, t });
        try {
          this.ws.send(payload);
        } catch (e) {
          clearTimeout(t);
          this.pending.delete(id);
          reject(e);
        }
      });
    }
  }

  const gw = new GatewayWs(wsUrl);
  const transcript = document.getElementById("transcript");
  const input = document.getElementById("input");
  const btnSend = document.getElementById("btn-send");
  const btnStop = document.getElementById("btn-stop");
  const btnNew = document.getElementById("btn-new");
  const btnRefresh = document.getElementById("btn-refresh");
  const connPill = document.getElementById("conn-pill");
  const agentCard = document.getElementById("agent-card");
  const skillsList = document.getElementById("skills-list");
  const skillsCount = document.getElementById("skills-count");
  const skillsSearch = document.getElementById("skills-search");
  const skillsFilters = document.getElementById("skills-filters");
  const toolsetsList = document.getElementById("toolsets-list");
  const activityList = document.getElementById("activity-list");
  const subagentList = document.getElementById("subagent-list");
  const bgProcsList = document.getElementById("bg-procs-list");
  const modal = document.getElementById("modal");
  const quickPills = document.getElementById("quick-pills");
  const viewChat = document.getElementById("view-chat");
  const viewSkills = document.getElementById("view-skills");
  const viewTools = document.getElementById("view-tools");
  const navMenu = document.getElementById("nav-menu");
  const sessionHistoryList = document.getElementById("session-history-list");

  let sessionId = null;
  /** @type {string | null} DB session id when last opened via resume; null after brand-new session.create */
  let activeDbSessionId = null;
  let turnBusy = false;
  /** @type {HTMLElement | null} */
  let assistantEl = null;
  let assistantText = "";
  /** @type {ReturnType<typeof setInterval> | null} */
  let pollTimer = null;
  /** @type {Record<string, string[]> | null} */
  let skillsByCategory = null;
  /** @type {string} */
  let skillsFilterCat = "__all__";

  function setView(name) {
    const v = name === "skills" || name === "tools" ? name : "chat";
    viewChat.classList.toggle("view-active", v === "chat");
    viewSkills.classList.toggle("view-active", v === "skills");
    viewTools.classList.toggle("view-active", v === "tools");
    navMenu.querySelectorAll(".nav-item").forEach((el) => {
      el.classList.toggle("active", el.getAttribute("data-view") === v);
    });
  }

  function setConn(ok, text) {
    connPill.textContent = text;
    connPill.classList.toggle("err", !ok);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatRelativeTime(ts) {
    const n = Number(ts);
    if (!n || n <= 0) return "";
    const ms = n > 1e12 ? n : n * 1000;
    const diff = Date.now() - ms;
    const sec = Math.floor(diff / 1000);
    if (sec < 45) return "刚刚";
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}分钟前`;
    const hr = Math.floor(min / 60);
    if (hr < 36) return `${hr}小时前`;
    const days = Math.floor(hr / 24);
    if (days < 45) return `${days}天前`;
    return new Date(ms).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
  }

  function historyTitleLine(s) {
    const t = (s.title || "").trim();
    if (t) return t.length > 100 ? `${t.slice(0, 100)}…` : t;
    const p = (s.preview || "").trim().replace(/\s+/g, " ");
    if (p) return p.length > 90 ? `${p.slice(0, 90)}…` : p;
    return "(无标题)";
  }

  function renderTranscriptFromGatewayMessages(messages) {
    transcript.innerHTML = "";
    if (!Array.isArray(messages)) return;
    for (const m of messages) {
      const role = m.role;
      const textRaw = m.text != null ? String(m.text) : "";
      const ctx = m.context ? String(m.context) : "";
      const text = ctx ? `${textRaw}\n${ctx}`.trim() : textRaw;
      if (role === "tool") {
        const nm = m.name ? String(m.name) : "tool";
        bubble("system", `${nm}: ${text.slice(0, 2000)}`);
        continue;
      }
      if (role === "user" || role === "assistant" || role === "system") {
        bubble(role, text);
      }
    }
    transcript.scrollTop = transcript.scrollHeight;
  }

  function renderHistoryList(sessions) {
    if (!Array.isArray(sessions) || !sessions.length) {
      sessionHistoryList.innerHTML =
        '<div class="session-history-empty muted">暂无历史会话（或数据库未就绪）</div>';
      return;
    }
    sessionHistoryList.innerHTML = sessions
      .map((s) => {
        const id = String(s.id || "");
        const active = activeDbSessionId && id === activeDbSessionId ? " active" : "";
        const title = escapeHtml(historyTitleLine(s));
        const cnt = Number(s.message_count) || 0;
        const src = escapeHtml(String(s.source || "").slice(0, 12) || "—");
        const when = formatRelativeTime(s.started_at);
        return `<button type="button" class="session-history-item${active}" data-db-id="${escapeHtml(id)}" role="listitem" title="${title}">
<span class="hi-ico" aria-hidden="true">✓</span>
<span class="session-history-body">
<span class="session-history-title">${title}</span>
<span class="session-history-meta">
<span class="session-history-sub">${cnt} 条 · ${src}</span>
<span class="session-history-time">${escapeHtml(when)}</span>
</span>
</span>
</button>`;
      })
      .join("");
  }

  async function loadSessionHistory() {
    try {
      const r = await gw.request("session.list", { limit: 50 });
      renderHistoryList(r.sessions || []);
    } catch (e) {
      sessionHistoryList.innerHTML = `<div class="session-history-empty muted">${escapeHtml(
        String(e.message || e),
      )}</div>`;
    }
  }

  async function resumeFromHistory(dbSessionId) {
    const target = String(dbSessionId || "").trim();
    if (!target) return;
    if (turnBusy) {
      bubble("system", "当前正在回复，请稍后再打开历史会话。");
      return;
    }
    try {
      if (sessionId) {
        try {
          await gw.request("session.close", { session_id: sessionId });
        } catch {
          /* ignore */
        }
      }
      sessionId = null;
      assistantEl = null;
      assistantText = "";
      turnBusy = false;
      btnStop.disabled = true;
      btnSend.disabled = false;
      clearTranscript();
      activityList.innerHTML = "";

      const res = await gw.request("session.resume", { session_id: target, cols: 100 });
      sessionId = res.session_id;
      activeDbSessionId = res.resumed || target;
      renderTranscriptFromGatewayMessages(res.messages);
      if (res.info) {
        renderAgentCard(res.info);
        renderSkills(res.info.skills);
      }
      bubble("system", `已打开历史会话 · ${activeDbSessionId}`);
      await refreshSidebars();
      await loadSessionHistory();
      setView("chat");
    } catch (e) {
      bubble("system", `恢复会话失败：${String(e.message || e)}`);
      await loadSessionHistory();
    }
  }

  function countToolsFromSessionInfo(tools) {
    if (!tools || typeof tools !== "object") return 0;
    return Object.values(tools).reduce((n, arr) => n + (Array.isArray(arr) ? arr.length : 0), 0);
  }

  function countSkills(skills) {
    if (!skills || typeof skills !== "object") return 0;
    return Object.values(skills).reduce((n, arr) => n + (Array.isArray(arr) ? arr.length : 0), 0);
  }

  function skillHue(name) {
    let h = 0;
    const s = String(name);
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % 360;
  }

  function skillLetterIcon(name) {
    const s = String(name).trim();
    if (!s) return "?";
    const ch = s[0];
    return /^[\x00-\x7f]$/.test(ch) ? ch.toUpperCase() : ch;
  }

  function renderFilterPills() {
    if (!skillsByCategory || !countSkills(skillsByCategory)) {
      skillsFilters.innerHTML = "";
      return;
    }
    const cats = Object.keys(skillsByCategory)
      .filter((c) => Array.isArray(skillsByCategory[c]) && skillsByCategory[c].length)
      .sort();
    const parts = [
      `<button type="button" class="filter-pill${skillsFilterCat === "__all__" ? " active" : ""}" data-cat="__all__">全部</button>`,
    ];
    for (const c of cats) {
      const active = skillsFilterCat === c ? " active" : "";
      parts.push(
        `<button type="button" class="filter-pill${active}" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`,
      );
    }
    skillsFilters.innerHTML = parts.join("");
  }

  function paintSkillsGrid() {
    const q = (skillsSearch.value || "").trim().toLowerCase();
    if (!skillsByCategory || !countSkills(skillsByCategory)) {
      skillsCount.textContent = "";
      skillsList.className = "skills-list skill-grid skill-grid-page muted";
      skillsList.textContent = "暂无可用 Skills（或仍在加载）";
      return;
    }
    const items = [];
    for (const [cat, names] of Object.entries(skillsByCategory)) {
      if (!Array.isArray(names)) continue;
      if (skillsFilterCat !== "__all__" && skillsFilterCat !== cat) continue;
      for (const name of names) {
        const ns = String(name);
        if (q && !ns.toLowerCase().includes(q)) continue;
        items.push({ cat, name: ns });
      }
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    skillsCount.textContent = items.length ? `${items.length} 项` : "0 项";
    skillsList.className = "skills-list skill-grid skill-grid-page";
    if (!items.length) {
      skillsList.innerHTML =
        '<div class="muted" style="grid-column:1/-1;padding:8px;font-size:0.75rem;line-height:1.4">无匹配技能，可切换分类或清空搜索</div>';
      return;
    }
    skillsList.innerHTML = items
      .map(({ cat, name }) => {
        const h = skillHue(name);
        const L = escapeHtml(skillLetterIcon(name));
        const safeName = escapeHtml(name);
        return `<button type="button" class="skill-card" data-skill="${safeName}" title="${safeName}">
<span class="skill-card-icon" style="background:hsl(${h},68%,90%)">${L}</span>
<span class="skill-card-body"><span class="skill-card-name">${safeName}</span><span class="skill-card-cat">${escapeHtml(cat)}</span></span>
</button>`;
      })
      .join("");
  }

  function renderAgentCard(info) {
    if (!info || typeof info !== "object") {
      agentCard.className = "agent-card muted";
      agentCard.textContent = "无 Agent 信息";
      return;
    }
    agentCard.className = "agent-card";
    const model = escapeHtml(String(info.model || "—"));
    const cwd = escapeHtml(String(info.cwd || "—"));
    const ver = escapeHtml(String(info.version || "—"));
    const rel = info.release_date ? escapeHtml(String(info.release_date)) : "";
    const tier = info.service_tier ? escapeHtml(String(info.service_tier)) : "—";
    const reas = info.reasoning_effort ? escapeHtml(String(info.reasoning_effort)) : "—";
    const nTools = countToolsFromSessionInfo(info.tools);
    const mcp = Array.isArray(info.mcp_servers) ? info.mcp_servers : [];
    const mcpOn = mcp.filter((s) => s && s.connected).length;
    const mcpLine = mcp.length ? `${mcpOn} / ${mcp.length} 已连接` : "—";

    const u = info.usage && typeof info.usage === "object" ? info.usage : {};
    const tokIn = u.input != null ? Number(u.input) : null;
    const tokOut = u.output != null ? Number(u.output) : null;
    const tokTot = u.total != null ? Number(u.total) : null;
    const tokStr =
      tokTot != null && tokTot > 0
        ? `${tokTot.toLocaleString()}（入 ${tokIn ?? "—"} / 出 ${tokOut ?? "—"}）`
        : "—";
    const cost =
      u.cost_usd != null && !Number.isNaN(Number(u.cost_usd))
        ? `≈ $${Number(u.cost_usd).toFixed(4)}${u.cost_status ? ` · ${escapeHtml(String(u.cost_status))}` : ""}`
        : "—";
    const ctx =
      u.context_percent != null
        ? `${u.context_percent}%${u.context_max ? ` / ${Number(u.context_max).toLocaleString()} ctx` : ""}`
        : "—";

    agentCard.innerHTML = `
      <div class="model-line">${model}</div>
      <div class="kv"><span class="k">工作目录</span><span class="v" title="${cwd}">${cwd}</span></div>
      <div class="kv"><span class="k">版本</span><span class="v">${ver}${rel ? ` · ${rel}` : ""}</span></div>
      <div class="kv"><span class="k">推理</span><span class="v">${reas}</span></div>
      <div class="kv"><span class="k">服务层级</span><span class="v">${tier}</span></div>
      <div class="kv"><span class="k">工具</span><span class="v">${nTools ? `${nTools} 个（按 toolset 分组）` : "—"}</span></div>
      <div class="kv"><span class="k">MCP</span><span class="v">${escapeHtml(mcpLine)}</span></div>
      <div class="kv"><span class="k">Token</span><span class="v">${escapeHtml(tokStr)}</span></div>
      <div class="kv"><span class="k">费用</span><span class="v">${cost}</span></div>
      <div class="kv"><span class="k">上下文</span><span class="v">${escapeHtml(ctx)}</span></div>
    `;
  }

  function renderSkills(skills) {
    skillsByCategory = skills && typeof skills === "object" ? skills : null;
    skillsFilterCat = "__all__";
    renderFilterPills();
    paintSkillsGrid();
  }

  function renderToolsets(toolsets) {
    if (!Array.isArray(toolsets) || !toolsets.length) {
      toolsetsList.className = "toolsets-list muted";
      toolsetsList.textContent = "无法加载工具集（会话未就绪？）";
      return;
    }
    toolsetsList.className = "toolsets-list";
    toolsetsList.innerHTML = toolsets
      .map((ts) => {
        const name = escapeHtml(String(ts.name || ""));
        const desc = escapeHtml(String(ts.description || "").slice(0, 200));
        const en = ts.enabled !== false;
        const tag = en ? `<span class="tag tag-on">开</span>` : `<span class="tag tag-off">关</span>`;
        const cnt = ts.tool_count != null ? Number(ts.tool_count) : (ts.tools && ts.tools.length) || 0;
        const tools = Array.isArray(ts.tools) ? ts.tools.map((t) => escapeHtml(String(t))).join("\n") : "";
        return `<details class="toolset-item" ${en ? "open" : ""}>
<summary><span>${name}</span><span class="toolset-meta">${tag}<span class="muted">${cnt}</span></span></summary>
<div class="toolset-desc">${desc}</div>
<pre class="toolset-tools">${tools || "—"}</pre>
</details>`;
      })
      .join("");
  }

  function renderSubagents(data) {
    const active = (data && data.active) || [];
    if (!active.length) {
      subagentList.className = "compact-list muted";
      subagentList.textContent = "无运行中的子 Agent";
      return;
    }
    subagentList.className = "compact-list";
    subagentList.innerHTML = active
      .map((a) => {
        const id = escapeHtml(String(a.subagent_id || "?"));
        const model = escapeHtml(String(a.model || "—"));
        const goal = escapeHtml(String(a.goal || "").slice(0, 120));
        const st = escapeHtml(String(a.status || "—"));
        return `<div class="compact-row"><div class="r-title">${id} · ${model}</div><div class="r-sub">${st}${goal ? ` · ${goal}` : ""}</div></div>`;
      })
      .join("");
  }

  function renderBgProcs(data) {
    const procs = (data && data.processes) || [];
    if (!procs.length) {
      bgProcsList.className = "compact-list muted";
      bgProcsList.textContent = "无登记的后台进程";
      return;
    }
    bgProcsList.className = "compact-list";
    bgProcsList.innerHTML = procs
      .map((p) => {
        const sid = escapeHtml(String(p.session_id || "?"));
        const cmd = escapeHtml(String(p.command || "").slice(0, 100));
        const st = escapeHtml(String(p.status || "—"));
        const up = p.uptime != null ? `${Math.round(Number(p.uptime))}s` : "";
        return `<div class="compact-row"><div class="r-title">${sid}</div><div class="r-sub">${st}${up ? ` · ${up}` : ""} · ${cmd}</div></div>`;
      })
      .join("");
  }

  async function refreshSidebars() {
    if (!sessionId) return;
    const tasks = [
      gw.request("tools.list", { session_id: sessionId }).then((r) => renderToolsets(r.toolsets)).catch(() => {
        toolsetsList.className = "toolsets-list muted";
        toolsetsList.textContent = "tools.list 失败";
      }),
      gw
        .request("skills.manage", { action: "list" })
        .then((r) => renderSkills(r.skills))
        .catch(() => {}),
      gw
        .request("delegation.status", {})
        .then((r) => renderSubagents(r))
        .catch(() => {}),
      gw
        .request("agents.list", {})
        .then((r) => renderBgProcs(r))
        .catch(() => {}),
    ];
    await Promise.all(tasks);
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (!sessionId) return;
      gw
        .request("delegation.status", {})
        .then((r) => renderSubagents(r))
        .catch(() => {});
      gw
        .request("agents.list", {})
        .then((r) => renderBgProcs(r))
        .catch(() => {});
    }, AGENT_POLL_MS);
  }

  function bubble(role, text) {
    const el = document.createElement("div");
    el.className = `bubble ${role}`;
    el.textContent = text;
    transcript.appendChild(el);
    transcript.scrollTop = transcript.scrollHeight;
    return el;
  }

  function clearTranscript() {
    transcript.innerHTML = "";
    activityList.innerHTML = "";
  }

  function resetSidebarsLoading() {
    agentCard.className = "agent-card muted";
    agentCard.textContent = "正在初始化 Agent…";
    skillsByCategory = null;
    skillsFilterCat = "__all__";
    skillsSearch.value = "";
    skillsFilters.innerHTML = "";
    skillsList.className = "skills-list skill-grid skill-grid-page muted";
    skillsList.textContent = "加载中…";
    skillsCount.textContent = "";
    toolsetsList.className = "toolsets-list muted";
    toolsetsList.textContent = "加载中…";
    subagentList.className = "compact-list muted";
    subagentList.textContent = "—";
    bgProcsList.className = "compact-list muted";
    bgProcsList.textContent = "—";
  }

  async function newSession() {
    if (sessionId) {
      try {
        await gw.request("session.close", { session_id: sessionId });
      } catch {
        /* ignore */
      }
    }
    sessionId = null;
    activeDbSessionId = null;
    turnBusy = false;
    assistantEl = null;
    assistantText = "";
    btnStop.disabled = true;
    btnSend.disabled = false;
    clearTranscript();
    resetSidebarsLoading();
    const res = await gw.request("session.create", { cols: 100 });
    sessionId = res.session_id;
    if (res.info) {
      renderAgentCard(res.info);
      renderSkills(res.info.skills);
    }
    bubble("system", `会话已创建 · ${sessionId}`);
    loadSessionHistory().catch(() => {});
    setTimeout(() => refreshSidebars(), 400);
    setTimeout(() => refreshSidebars(), 2500);
  }

  function ensureAssistantBubble() {
    if (assistantEl) return assistantEl;
    assistantEl = bubble("assistant", "");
    assistantText = "";
    return assistantEl;
  }

  function resetAssistantBubble() {
    assistantEl = null;
    assistantText = "";
  }

  function onGatewayEvent(ev) {
    const { type, session_id: sid, payload } = ev;
    if (sid && sessionId && sid !== sessionId) return;

    switch (type) {
      case "gateway.ready":
        setConn(true, "已连接");
        break;
      case "session.info": {
        if (sessionId && sid && sid !== sessionId) break;
        renderAgentCard(payload);
        if (payload && payload.skills) renderSkills(payload.skills);
        refreshSidebars().catch(() => {});
        break;
      }
      case "message.start":
        activityList.innerHTML = "";
        resetAssistantBubble();
        ensureAssistantBubble();
        turnBusy = true;
        btnStop.disabled = false;
        break;
      case "message.delta": {
        const t = (payload && payload.text) || "";
        assistantText += t;
        const el = ensureAssistantBubble();
        el.textContent = assistantText;
        transcript.scrollTop = transcript.scrollHeight;
        break;
      }
      case "message.complete": {
        const text = (payload && payload.text) || assistantText;
        const el = ensureAssistantBubble();
        el.textContent = text;
        if (payload && payload.warning) {
          bubble("system", payload.warning);
        }
        resetAssistantBubble();
        turnBusy = false;
        btnStop.disabled = true;
        btnSend.disabled = false;
        transcript.scrollTop = transcript.scrollHeight;
        refreshSidebars().catch(() => {});
        loadSessionHistory().catch(() => {});
        break;
      }
      case "error": {
        const m = (payload && payload.message) || "错误";
        bubble("system", m);
        resetAssistantBubble();
        turnBusy = false;
        btnStop.disabled = true;
        btnSend.disabled = false;
        break;
      }
      case "tool.start":
      case "tool.progress":
      case "tool.complete":
      case "tool.generating": {
        const li = document.createElement("li");
        const name = (payload && payload.name) || type;
        const preview = (payload && payload.preview) || "";
        li.textContent = preview ? `${name}: ${preview}` : name;
        activityList.appendChild(li);
        li.scrollIntoView({ block: "nearest", behavior: "smooth" });
        break;
      }
      case "approval.request": {
        showApprovalModal(payload || {});
        break;
      }
      default:
        break;
    }
  }

  function showApprovalModal(payload) {
    const summary =
      typeof payload.summary === "string"
        ? payload.summary
        : JSON.stringify(payload, null, 2);
    modal.innerHTML = `
      <div class="modal-card">
        <h2 style="margin:0 0 8px;font-size:1rem">需要审批</h2>
        <pre>${escapeHtml(summary)}</pre>
        <div class="modal-actions">
          <button type="button" class="btn primary" data-choice="approve">允许</button>
          <button type="button" class="btn secondary" data-choice="deny">拒绝</button>
        </div>
      </div>`;
    modal.classList.remove("hidden");
    modal.querySelectorAll("[data-choice]").forEach((btn) => {
      btn.onclick = async () => {
        const choice = btn.getAttribute("data-choice");
        modal.classList.add("hidden");
        modal.innerHTML = "";
        try {
          await gw.request("approval.respond", { session_id: sessionId, choice });
        } catch (e) {
          bubble("system", String(e.message || e));
        }
      };
    });
  }

  async function sendMessage(text) {
    const t = text.trim();
    if (!t || !sessionId || turnBusy) return;
    bubble("user", t);
    input.value = "";
    turnBusy = true;
    btnSend.disabled = true;
    btnStop.disabled = false;
    try {
      await gw.request("prompt.submit", { session_id: sessionId, text: t });
    } catch (e) {
      bubble("system", String(e.message || e));
      turnBusy = false;
      btnSend.disabled = false;
      btnStop.disabled = true;
    }
  }

  async function stopTurn() {
    if (!sessionId) return;
    try {
      await gw.request("session.interrupt", { session_id: sessionId });
    } catch {
      /* ignore */
    }
  }

  const quicks = ["你好，介绍一下你自己", "今天天气怎么样？", "用一句话总结 Hermes 项目"];
  quicks.forEach((q) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = q;
    b.onclick = () => sendMessage(q);
    quickPills.appendChild(b);
  });

  btnSend.onclick = () => sendMessage(input.value);
  btnStop.onclick = () => stopTurn();
  btnRefresh.onclick = () => {
    refreshSidebars().catch((e) => bubble("system", String(e.message || e)));
    loadSessionHistory().catch((e) => bubble("system", String(e.message || e)));
  };

  sessionHistoryList.addEventListener("click", (e) => {
    const row = e.target.closest(".session-history-item");
    if (!row) return;
    const id = row.getAttribute("data-db-id");
    if (id) resumeFromHistory(id).catch(() => {});
  });

  skillsFilters.addEventListener("click", (e) => {
    const btn = e.target.closest(".filter-pill");
    if (!btn) return;
    skillsFilterCat = btn.getAttribute("data-cat") || "__all__";
    renderFilterPills();
    paintSkillsGrid();
  });

  skillsSearch.addEventListener("input", () => paintSkillsGrid());

  navMenu.addEventListener("click", (e) => {
    const btn = e.target.closest(".nav-item");
    if (!btn) return;
    const v = btn.getAttribute("data-view");
    if (v) setView(v);
  });

  skillsList.addEventListener("click", (e) => {
    const card = e.target.closest(".skill-card");
    if (!card) return;
    const skill = card.getAttribute("data-skill");
    if (!skill) return;
    const prefix = skill.startsWith("/") ? skill : `/${skill}`;
    setView("chat");
    input.value = `${prefix} `;
    input.focus();
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input.value);
    }
  });

  btnNew.onclick = () => {
    newSession().catch((e) => bubble("system", String(e.message || e)));
  };

  gw.onEvent = onGatewayEvent;

  (async () => {
    try {
      await gw.connect();
      setConn(true, "已连接");
      await newSession();
      startPolling();
    } catch (e) {
      setConn(false, "未连接");
      bubble("system", String(e.message || e));
    }
  })();
})();
