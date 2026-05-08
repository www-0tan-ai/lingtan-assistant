/**
 * tui_gateway JSON-RPC over WebSocket — 0tan 桌面壳
 */
(() => {
  const REQUEST_TIMEOUT_MS = 120000;
  const AGENT_POLL_MS = 4000;
  const VIEWS = [
    "chat",
    "experts",
    "skills",
    "explore",
    "connectors",
    "library",
    "automation",
  ];

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
  const btnChatPlus = document.getElementById("btn-chat-plus");
  const connPill = document.getElementById("conn-pill");
  const connStatus = document.getElementById("conn-status");
  const chatTaskTitle = document.getElementById("chat-task-title");
  const taskStatusLine = document.getElementById("task-status-line");
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
  const navMenu = document.getElementById("nav-menu");
  const sessionHistoryList = document.getElementById("session-history-list");
  const sidebarSearch = document.getElementById("sidebar-search");
  const taskStrip = document.getElementById("task-strip");
  const navLibraryToggle = document.getElementById("nav-library-toggle");
  const navLibrarySub = document.getElementById("nav-library-sub");
  const expertCatPills = document.getElementById("expert-cat-pills");
  const expertGroupsGrid = document.getElementById("expert-groups-grid");
  const expertRosterGrid = document.getElementById("expert-roster-grid");
  const workspaceFolderName = document.getElementById("workspace-folder-name");

  let sessionId = null;
  /** @type {string | null} */
  let activeDbSessionId = null;
  let turnBusy = false;
  /** @type {HTMLElement | null} */
  let assistantEl = null;
  let assistantText = "";
  /** @type {ReturnType<typeof setInterval> | null} */
  let pollTimer = null;
  /** @type {Record<string, string[]> | null} */
  let skillsByCategory = null;
  let skillsFilterCat = "__all__";
  /** @type {any[]} */
  let lastSessions = [];
  /** @type {any[]} */
  let lastRosterAgents = [];
  /** @type {any[]} */
  let lastToolsets = [];
  let expertFilter = "all";
  /** @type {"rec"|"hub"|"bundles"} */
  let skillsMarketTab = "rec";
  let skillsHubTimer = null;
  let browsePage = 1;

  function closeModal() {
    modal.classList.add("hidden");
    modal.innerHTML = "";
  }

  function openModal(html) {
    modal.innerHTML = html;
    modal.classList.remove("hidden");
    modal.querySelectorAll("[data-modal-close]").forEach((b) => {
      b.onclick = () => closeModal();
    });
    modal.onclick = (ev) => {
      if (ev.target === modal) closeModal();
    };
  }

  async function cliExecStdout(argv) {
    try {
      const r = await gw.request("cli.exec", { argv, timeout: 60 });
      if (r && r.blocked) return "";
      return String(r.output || "").trim();
    } catch {
      return "";
    }
  }

  async function saveLingtanRoster(agents) {
    await gw.request("config.set", { key: "lingtan.roster", value: { agents } });
    lastRosterAgents = Array.isArray(agents) ? agents : [];
    renderExpertViews();
    bubble("system", `已保存 ${lastRosterAgents.length} 条专家配置到 config.yaml`);
  }

  async function configureToolsets(names, action) {
    if (!sessionId) {
      bubble("system", "请先等待会话就绪");
      return;
    }
    const arr = (names || []).filter(Boolean);
    if (!arr.length) return;
    try {
      const r = await gw.request("tools.configure", {
        session_id: sessionId,
        action,
        names: arr,
      });
      const unk = (r && r.unknown) || [];
      if (unk.length) bubble("system", `未识别工具集：${unk.join(", ")}`);
      if (r && r.missing_servers && r.missing_servers.length) {
        bubble("system", `MCP 未就绪：${r.missing_servers.join(", ")}`);
      }
      await refreshSidebars();
      bubble("system", (r && r.changed && r.changed.length ? `已更新：${r.changed.join(", ")}` : "工具集已同步") + "");
    } catch (e) {
      bubble("system", String(e.message || e));
    }
  }

  async function runCliExec(argv, hintLabel) {
    try {
      const r = await gw.request("cli.exec", { argv, timeout: 300 });
      if (r && r.blocked) {
        bubble("system", r.hint || "CLI 被拦截");
        return r;
      }
      const out = String(r.output || "").trim();
      if (r.code !== 0) {
        bubble("system", `${hintLabel} 退出码 ${r.code}${out ? `\n${out.slice(0, 2000)}` : ""}`);
      } else if (out) {
        bubble("system", `${hintLabel}\n${out.slice(0, 2000)}`);
      } else {
        bubble("system", `${hintLabel} 完成`);
      }
      return r;
    } catch (e) {
      bubble("system", String(e.message || e));
      return null;
    }
  }

  function setView(name) {
    const v = VIEWS.includes(name) ? name : "chat";
    VIEWS.forEach((id) => {
      const el = document.getElementById(`view-${id}`);
      if (el) el.classList.toggle("wb-view-active", id === v);
    });
    navMenu.querySelectorAll(".wb-nav-item[data-view]").forEach((el) => {
      const dv = el.getAttribute("data-view");
      el.classList.toggle("active", dv === v);
    });
    onViewShown(v).catch(() => {});
  }

  function hashStr(s) {
    let h = 0;
    const t = String(s);
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
    return h;
  }

  async function loadProfileHome() {
    try {
      const r = await gw.request("config.get", { key: "profile" });
      if (workspaceFolderName && r && r.display) {
        const norm = String(r.display).replace(/\\/g, "/");
        const parts = norm.split("/").filter(Boolean);
        workspaceFolderName.textContent = parts[parts.length - 1] || "0tan_data";
      }
    } catch {
      /* keep HTML default */
    }
  }

  async function loadRoster() {
    try {
      const r = await gw.request("config.get", { key: "lingtan.roster" });
      lastRosterAgents = Array.isArray(r.agents) ? r.agents : [];
    } catch {
      lastRosterAgents = [];
    }
    renderExpertViews();
  }

  function renderExpertViews() {
    if (!expertGroupsGrid || !expertRosterGrid) return;
    const agents = lastRosterAgents.filter((a) => {
      if (expertFilter === "on") return a.enabled !== false;
      if (expertFilter === "off") return a.enabled === false;
      return true;
    });
    const labels = lastRosterAgents.map((a) => a.name || a.id).filter(Boolean);
    const names = labels.join("、");
    expertGroupsGrid.innerHTML = `
      <article class="wb-card-team" style="grid-column:1/-1;max-width:720px">
        <div class="wb-card-team-art">◆</div>
        <h3 class="wb-card-team-name">委派子代理</h3>
        <div class="wb-card-tags"><span>lingtan_ui.agents</span><span>delegate_task</span></div>
        <p class="wb-card-desc">${escapeHtml(names || "尚未配置子代理，点击「新建专家」写入 config。")}</p>
        <div class="wb-card-team-foot"><span class="wb-avatars">${"●".repeat(Math.min(lastRosterAgents.length, 6)) || "—"}</span><span class="wb-use-count">${lastRosterAgents.length} 个角色</span></div>
      </article>`;
    if (!agents.length) {
      expertRosterGrid.innerHTML =
        '<div class="muted" style="grid-column:1/-1;padding:12px">当前筛选下无条目</div>';
      expertRosterGrid.onclick = null;
      return;
    }
    const avatars = ["👤", "🎯", "📎", "🔍", "📋", "⚡"];
    expertRosterGrid.innerHTML = agents
      .map((a, idx) => {
        const idRaw = String(a.id || "");
        const id = escapeHtml(idRaw);
        const nm = escapeHtml(String(a.name || a.id || "未命名"));
        const desc = escapeHtml(String(a.description || "").slice(0, 220));
        const ts = Array.isArray(a.toolsets) ? a.toolsets : [];
        const tags = ts
          .slice(0, 6)
          .map((t) => `<span>${escapeHtml(String(t))}</span>`)
          .join("");
        const av = avatars[idx % avatars.length];
        const on = a.enabled !== false;
        const onLabel = on ? "已启用" : "未启用";
        const toggleLabel = on ? "停用" : "启用";
        return `<article class="wb-card-expert" data-agent-id="${id}">
        <div class="wb-ex-avatar">${av}</div>
        <div class="wb-ex-body">
          <div class="wb-ex-title">${nm}</div>
          <div class="wb-card-tags">${tags || "<span>—</span>"}</div>
          <p class="wb-card-desc">${desc}</p>
          <div class="wb-ex-foot"><span>${id}</span><span class="wb-use-count">${onLabel}</span></div>
          <div class="wb-ex-actions">
            <button type="button" class="wb-btn-xs" data-agent-act="toggle" data-agent-id="${id}">${toggleLabel}</button>
            <button type="button" class="wb-btn-xs danger" data-agent-act="delete" data-agent-id="${id}">删除</button>
          </div>
        </div>
      </article>`;
      })
      .join("");

    expertRosterGrid.onclick = async (ev) => {
      const b = ev.target.closest("[data-agent-act]");
      if (!b) return;
      const idRaw = b.getAttribute("data-agent-id") || "";
      const act = b.getAttribute("data-agent-act");
      if (!idRaw) return;
      if (act === "toggle") {
        const next = lastRosterAgents.map((x) => {
          if (String(x.id) !== idRaw) return { ...x };
          const wasOn = x.enabled !== false;
          return { ...x, enabled: !wasOn };
        });
        try {
          await saveLingtanRoster(next);
        } catch (e) {
          bubble("system", String(e.message || e));
        }
      }
      if (act === "delete") {
        if (!confirm(`删除专家「${idRaw}」？`)) return;
        const next = lastRosterAgents.filter((x) => String(x.id) !== idRaw);
        try {
          await saveLingtanRoster(next);
        } catch (e) {
          bubble("system", String(e.message || e));
        }
      }
    };
  }

  function renderConnectorCards(toolsets) {
    const grid = document.getElementById("connector-toolset-grid");
    if (!grid) return;
    if (!Array.isArray(toolsets) || !toolsets.length) {
      grid.innerHTML =
        '<div class="muted" style="grid-column:1/-1;padding:12px">无工具集数据（会话未就绪？）</div>';
      grid.onclick = null;
      return;
    }
    const icons = ["📦", "🔧", "🌐", "💾", "📊", "🧠", "⚙️", "🔌", "📝", "🗂"];
    grid.innerHTML = toolsets
      .map((ts) => {
        const raw = String(ts.name || "");
        const ico = icons[hashStr(raw) % icons.length];
        const name = escapeHtml(raw);
        const desc = escapeHtml(String(ts.description || "").slice(0, 160));
        const cnt = ts.tool_count != null ? Number(ts.tool_count) : (ts.tools && ts.tools.length) || 0;
        const en = ts.enabled !== false;
        const cls = en ? "wb-conn-card" : "wb-conn-card wb-conn-off";
        const safeAttr = encodeURIComponent(raw);
        const act = en ? "disable" : "enable";
        const actLabel = en ? "关闭" : "启用";
        return `<article class="${cls}" data-toolset="${safeAttr}">
<span class="wb-conn-ico">${ico}</span><div class="wb-conn-body"><div class="wb-conn-name">${name}</div><p class="wb-conn-desc">${desc}</p>
<p class="muted" style="margin:6px 0 0;font-size:11px">${en ? "已启用" : "未启用"} · ${cnt} 个工具</p>
<div class="wb-conn-actions">
<button type="button" class="wb-btn-xs" data-ts-act="${act}" data-toolset="${safeAttr}">${actLabel}</button>
<button type="button" class="wb-btn-xs" data-ts-act="mention" data-toolset="${safeAttr}">引用到输入</button>
</div></div>
</article>`;
      })
      .join("");
    grid.onclick = (ev) => {
      const b = ev.target.closest("[data-ts-act]");
      if (b) {
        ev.stopPropagation();
        const n = decodeURIComponent(b.getAttribute("data-toolset") || "");
        const act = b.getAttribute("data-ts-act");
        if (act === "mention" && n) {
          setView("chat");
          input.value = `（优先使用工具集「${n}」内能力） `;
          input.focus();
        }
        if ((act === "enable" || act === "disable") && n) {
          configureToolsets([n], act).catch(() => {});
        }
        return;
      }
    };
  }

  async function loadExplorePlugins() {
    const el = document.getElementById("explore-plugins");
    if (!el) return;
    try {
      const r = await gw.request("plugins.list", {});
      const pl = r.plugins || [];
      if (!pl.length) {
        el.className = "wb-market-list muted";
        el.innerHTML = "<div class=\"muted\">当前未加载任何插件目录条目</div>";
        return;
      }
      el.className = "wb-market-list";
      el.innerHTML = pl
        .map((p) => {
          const rawName = String(p.name);
          const nm = escapeHtml(rawName);
          const en = p.enabled !== false;
          const safeName = encodeURIComponent(rawName);
          return `<div class="wb-market-row" data-plugin-row="${nm}">
<span class="wb-m-ico">🔌</span>
<div class="wb-market-row-body">
<div class="wb-m-title">${nm} <span class="muted">${en ? "启用" : "停用"}</span> · 版本 ${escapeHtml(String(p.version))}</div>
<div class="wb-row-actions">
${en ? `<button type="button" class="wb-btn-xs" data-pl-act="disable" data-pl-name="${safeName}">停用</button>` : `<button type="button" class="wb-btn-xs" data-pl-act="enable" data-pl-name="${safeName}">启用</button>`}
<button type="button" class="wb-btn-xs danger" data-pl-act="remove" data-pl-name="${safeName}">卸载</button>
</div></div></div>`;
        })
        .join("");

      el.onclick = async (ev) => {
        const b = ev.target.closest("[data-pl-act]");
        if (!b) return;
        const name = decodeURIComponent(b.getAttribute("data-pl-name") || "");
        const act = b.getAttribute("data-pl-act");
        if (!name) return;
        if (act === "remove" && !confirm(`卸载插件「${name}」？`)) return;
        const argv =
          act === "enable"
            ? ["plugins", "enable", name]
            : act === "disable"
              ? ["plugins", "disable", name]
              : ["plugins", "remove", name];
        await runCliExec(argv, `plugins ${act}`);
        await loadExplorePlugins();
      };
    } catch (e) {
      el.className = "wb-market-list muted";
      el.textContent = String(e.message || e);
    }
  }

  async function loadCronJobs() {
    const grid = document.getElementById("cron-jobs-grid");
    if (!grid) return;
    try {
      const r = await gw.request("cron.manage", { action: "list" });
      const jobs = (r && r.jobs) || [];
      if (!jobs.length) {
        grid.innerHTML =
          '<div class="muted" style="grid-column:1/-1;padding:12px">暂无定时任务</div>';
        return;
      }
      grid.innerHTML = jobs
        .map((j) => {
          const jid = escapeHtml(String(j.job_id || ""));
          const title = escapeHtml(String(j.name || j.job_id || "任务"));
          const sub = escapeHtml(String(j.prompt_preview || j.schedule || "").slice(0, 100));
          const st = escapeHtml(String(j.state || j.last_status || "—"));
          const paused = String(j.state || "").toLowerCase() === "paused" || j.enabled === false;
          return `<article class="wb-auto-card" data-cron-job="${jid}">
<strong>${title}</strong><p>${sub}</p>
<p class="muted" style="margin-top:6px;font-size:11px">状态：${st} · <code>${jid}</code></p>
<div class="wb-cron-card-actions">
<button type="button" class="wb-btn-xs" data-cron-act="${paused ? "resume" : "pause"}" data-cron-job="${jid}">${paused ? "恢复" : "暂停"}</button>
<button type="button" class="wb-btn-xs danger" data-cron-act="remove" data-cron-job="${jid}">删除</button>
</div></article>`;
        })
        .join("");

      grid.onclick = async (ev) => {
        const b = ev.target.closest("[data-cron-act]");
        if (!b) return;
        const jid = b.getAttribute("data-cron-job") || "";
        const act = b.getAttribute("data-cron-act");
        if (!jid || !act) return;
        if (act === "remove" && !confirm(`删除定时任务 ${jid}？`)) return;
        try {
          await gw.request("cron.manage", {
            action: act === "remove" ? "remove" : act,
            job_id: jid,
          });
          bubble("system", `定时任务 ${act} 已提交`);
          await loadCronJobs();
        } catch (e) {
          bubble("system", String(e.message || e));
        }
      };
    } catch (e) {
      grid.innerHTML = `<div class="muted" style="grid-column:1/-1;padding:12px">${escapeHtml(
        String(e.message || e),
      )}</div>`;
    }
  }

  async function loadLibraryPanel() {
    const el = document.getElementById("library-panel");
    if (!el) return;
    el.className = "wb-library-panel";
    el.innerHTML = "<p class=\"muted\">加载中…</p>";
    try {
      const prof = await gw.request("config.get", { key: "profile" });
      const cfgPath = await cliExecStdout(["config", "path"]);
      const envPath = await cliExecStdout(["config", "env-path"]);
      const home = escapeHtml(String((prof && prof.display) || ""));
      const cfgOut = escapeHtml(cfgPath || "（未知）");
      const envOut = escapeHtml(envPath || "（未知）");
      el.innerHTML = `
        <p><strong>数据目录（显示名）</strong><br/><code>${home}</code></p>
        <p><strong>config.yaml</strong><br/><code>${cfgOut}</code></p>
        <p><strong>.env</strong><br/><code>${envOut}</code></p>
        <p class="muted" style="font-size:12px">在文件管理器中打开上述路径即可编辑；修改后部分项需重启侧车。</p>`;
    } catch (e) {
      el.innerHTML = `<p class="muted">${escapeHtml(String(e.message || e))}</p>`;
    }
  }

  async function paintSkillsMarket() {
    const market = document.getElementById("skills-market-list");
    if (!market) return;
    if (skillsMarketTab === "rec") {
      const n = countSkills(skillsByCategory);
      market.className = "wb-market-list";
      market.innerHTML = `<div class="wb-market-row"><span class="wb-m-ico">✨</span><div><div class="wb-m-title">已安装技能</div>
        <div class="wb-m-desc">共 <strong>${n}</strong> 条（见上方卡片）。切换到 SkillHub 可按关键词检索远程技能并安装；安装完成后点刷新或新开会话。</div></div></div>`;
      return;
    }
    if (skillsMarketTab === "hub") {
      const q = (skillsSearch && skillsSearch.value) || "";
      if (!q.trim()) {
        market.className = "wb-market-list muted";
        market.innerHTML =
          "<div class=\"muted\" style=\"padding:8px 0\">在顶部搜索框输入关键词，将调用侧车 <code>skills.manage search</code>。</div>";
        return;
      }
      market.className = "wb-market-list";
      market.innerHTML = "<div class=\"muted\">检索中…</div>";
      try {
        const r = await gw.request("skills.manage", { action: "search", query: q.trim() });
        const rows = (r && r.results) || [];
        if (!rows.length) {
          market.innerHTML = "<div class=\"muted\">无匹配结果，可换关键词或尝试完整 owner/repo。</div>";
          return;
        }
        market.innerHTML = rows
          .map((row) => {
            const raw = String(row.name || "");
            const nm = escapeHtml(raw);
            const enc = encodeURIComponent(raw);
            const ds = escapeHtml(String(row.description || "").slice(0, 220));
            return `<div class="wb-market-row"><span class="wb-m-ico">📦</span><div class="wb-market-row-body">
<div class="wb-m-title">${nm}</div><div class="wb-m-desc">${ds}</div>
<div class="wb-row-actions"><button type="button" class="wb-btn-xs primary" data-skill-install="${enc}">安装</button></div>
</div></div>`;
          })
          .join("");
        market.onclick = async (ev) => {
          const b = ev.target.closest("[data-skill-install]");
          if (!b) return;
          const spec = decodeURIComponent(b.getAttribute("data-skill-install") || "");
          if (!spec) return;
          b.disabled = true;
          try {
            await gw.request("skills.manage", { action: "install", query: spec });
            bubble("system", `已请求安装：${spec}`);
            await refreshSidebars();
            await paintSkillsMarket();
          } catch (e) {
            bubble("system", String(e.message || e));
          } finally {
            b.disabled = false;
          }
        };
      } catch (e) {
        market.className = "wb-market-list muted";
        market.textContent = String(e.message || e);
      }
      return;
    }
    market.className = "wb-market-list";
    market.innerHTML = "<div class=\"muted\">加载套件目录…</div>";
    try {
      const r = await gw.request("skills.manage", {
        action: "browse",
        query: String(browsePage),
        page_size: 15,
      });
      const items = (r && r.items) || [];
      const tp = Math.max(1, Number(r && r.total_pages) || 1);
      const pg = Math.min(tp, Math.max(1, Number(r && r.page) || browsePage));
      browsePage = pg;
      if (!items.length) {
        market.innerHTML = "<div class=\"muted\">目录为空或上游暂不可用。</div>";
        return;
      }
      const nav = `<div class="wb-browse-nav muted" style="margin-bottom:10px">第 ${pg} / ${tp} 页 · 共 ${Number(r.total) || items.length} 条
<button type="button" class="wb-btn-xs" data-browse-delta="-1" ${pg <= 1 ? "disabled" : ""}>上一页</button>
<button type="button" class="wb-btn-xs" data-browse-delta="1" ${pg >= tp ? "disabled" : ""}>下一页</button></div>`;
      market.innerHTML =
        nav +
        items
          .map((row) => {
            const raw = String(row.name || "");
            const nm = escapeHtml(raw);
            const enc = encodeURIComponent(raw);
            const ds = escapeHtml(String(row.description || "").slice(0, 200));
            const src = escapeHtml(String(row.source || ""));
            return `<div class="wb-market-row"><span class="wb-m-ico">🗂</span><div class="wb-market-row-body">
<div class="wb-m-title">${nm} <span class="muted">${src}</span></div><div class="wb-m-desc">${ds}</div>
<div class="wb-row-actions"><button type="button" class="wb-btn-xs primary" data-skill-install="${enc}">安装</button></div>
</div></div>`;
          })
          .join("");
      market.querySelectorAll("[data-browse-delta]").forEach((btn) => {
        btn.onclick = () => {
          const d = Number(btn.getAttribute("data-browse-delta"));
          browsePage = Math.max(1, Math.min(tp, pg + d));
          paintSkillsMarket().catch(() => {});
        };
      });
      market.onclick = async (ev) => {
        if (ev.target.closest("[data-browse-delta]")) return;
        const b = ev.target.closest("[data-skill-install]");
        if (!b) return;
        const spec = decodeURIComponent(b.getAttribute("data-skill-install") || "");
        if (!spec) return;
        b.disabled = true;
        try {
          await gw.request("skills.manage", { action: "install", query: spec });
          bubble("system", `已请求安装：${spec}`);
          await refreshSidebars();
        } catch (e) {
          bubble("system", String(e.message || e));
        } finally {
          b.disabled = false;
        }
      };
    } catch (e) {
      market.className = "wb-market-list muted";
      market.textContent = String(e.message || e);
    }
  }

  function onSkillsSearchInput() {
    if (skillsMarketTab === "hub") {
      if (skillsHubTimer) clearTimeout(skillsHubTimer);
      skillsHubTimer = setTimeout(() => paintSkillsMarket().catch(() => {}), 400);
    } else {
      paintSkillsGrid();
    }
  }

  function showCronJobModal(preset) {
    const p = preset || {};
    const name0 = escapeHtml(String(p.name || ""));
    const sch0 = escapeHtml(String(p.schedule || "0 9 * * *"));
    const pr0 = escapeHtml(String(p.prompt || ""));
    openModal(`<div class="wb-modal-card wb-modal-wide">
      <h2 style="margin:0 0 12px;font-size:1.05rem">新建定时任务</h2>
      <label class="wb-form-label">名称</label>
      <input type="text" id="cron-f-name" class="wb-modal-input" value="${name0}" />
      <label class="wb-form-label">Cron（五段）</label>
      <input type="text" id="cron-f-schedule" class="wb-modal-input" value="${sch0}" />
      <label class="wb-form-label">提示词</label>
      <textarea id="cron-f-prompt" class="wb-modal-textarea" rows="5">${pr0}</textarea>
      <div class="wb-modal-actions">
        <button type="button" class="wb-btn-outline" data-modal-close>取消</button>
        <button type="button" class="wb-btn-primary" id="cron-f-save">创建</button>
      </div></div>`);
    const saveBtn = document.getElementById("cron-f-save");
    if (saveBtn) {
      saveBtn.onclick = async () => {
        const n = document.getElementById("cron-f-name").value.trim();
        const sch = document.getElementById("cron-f-schedule").value.trim();
        const pr = document.getElementById("cron-f-prompt").value.trim();
        if (!n || !sch || !pr) {
          bubble("system", "请填写名称、计划与提示词");
          return;
        }
        try {
          await gw.request("cron.manage", { action: "add", name: n, schedule: sch, prompt: pr });
          bubble("system", "定时任务已创建");
          closeModal();
          await loadCronJobs();
        } catch (e) {
          bubble("system", String(e.message || e));
        }
      };
    }
  }

  function showExpertNewModal() {
    openModal(`<div class="wb-modal-card wb-modal-wide">
      <h2 style="margin:0 0 12px;font-size:1.05rem">新建委派专家</h2>
      <p class="muted" style="font-size:12px;margin:0 0 12px">写入 <code>lingtan_ui.agents</code>，需唯一 <code>id</code>；工具集名与连接器列表一致。</p>
      <label class="wb-form-label">ID（英文/数字/横线）</label>
      <input type="text" id="ex-f-id" class="wb-modal-input" placeholder="my-worker" />
      <label class="wb-form-label">显示名</label>
      <input type="text" id="ex-f-name" class="wb-modal-input" placeholder="我的专员" />
      <label class="wb-form-label">说明</label>
      <textarea id="ex-f-desc" class="wb-modal-textarea" rows="3" placeholder="子代理职责简述"></textarea>
      <label class="wb-form-label">工具集（逗号分隔）</label>
      <input type="text" id="ex-f-ts" class="wb-modal-input" placeholder="file, terminal, web" />
      <label class="wb-form-row"><input type="checkbox" id="ex-f-en" checked /> 启用</label>
      <div class="wb-modal-actions">
        <button type="button" class="wb-btn-outline" data-modal-close>取消</button>
        <button type="button" class="wb-btn-primary" id="ex-f-save">保存</button>
      </div></div>`);
    document.getElementById("ex-f-save").onclick = async () => {
      const id = document.getElementById("ex-f-id").value.trim();
      const nm = document.getElementById("ex-f-name").value.trim();
      const desc = document.getElementById("ex-f-desc").value.trim();
      const tsRaw = document.getElementById("ex-f-ts").value.trim();
      const en = document.getElementById("ex-f-en").checked;
      if (!id || !nm) {
        bubble("system", "请填写 ID 与显示名");
        return;
      }
      const toolsets = tsRaw
        ? tsRaw
            .split(/[,，\s]+/)
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      const row = { id, name: nm, description: desc, toolsets, enabled: en };
      const next = lastRosterAgents.slice();
      if (next.some((a) => String(a.id) === id)) {
        bubble("system", "ID 已存在");
        return;
      }
      next.push(row);
      try {
        await saveLingtanRoster(next);
        closeModal();
      } catch (e) {
        bubble("system", String(e.message || e));
      }
    };
  }

  async function onViewShown(v) {
    if (v === "experts") await loadRoster();
    if (v === "explore") await loadExplorePlugins();
    if (v === "automation") await loadCronJobs();
    if (v === "library") await loadLibraryPanel();
    if (v === "skills") {
      browsePage = 1;
      await paintSkillsMarket();
    }
    if (v === "connectors" && sessionId) {
      if (lastToolsets.length) {
        renderConnectorCards(lastToolsets);
      } else {
        try {
          const r = await gw.request("tools.list", { session_id: sessionId });
          lastToolsets = r.toolsets || [];
          renderConnectorCards(lastToolsets);
        } catch {
          renderConnectorCards([]);
        }
      }
    }
  }

  function setConn(ok, text) {
    if (connPill) {
      connPill.textContent = text;
      connPill.classList.toggle("err", !ok);
    }
    if (connStatus) {
      connStatus.classList.toggle("ok", ok);
      connStatus.classList.toggle("err", !ok);
      connStatus.title = text;
    }
  }

  function setTaskStatus(text) {
    if (taskStatusLine) taskStatusLine.textContent = text;
  }

  function setChatTitle(t) {
    const s = (t || "").trim() || "新任务";
    const short = s.length > 48 ? `${s.slice(0, 48)}…` : s;
    if (chatTaskTitle) chatTaskTitle.textContent = short;
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

  function filterSessionsByQuery(sessions, q) {
    const needle = (q || "").trim().toLowerCase();
    if (!needle) return sessions;
    return sessions.filter((s) => {
      const t = historyTitleLine(s).toLowerCase();
      const id = String(s.id || "").toLowerCase();
      return t.includes(needle) || id.includes(needle);
    });
  }

  function updateTaskStrip(sessions) {
    if (!taskStrip) return;
    if (!Array.isArray(sessions) || !sessions.length) {
      taskStrip.textContent = "暂无任务摘要";
      taskStrip.classList.add("muted");
      return;
    }
    const top = sessions[0];
    taskStrip.classList.remove("muted");
    taskStrip.textContent = historyTitleLine(top);
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
    lastSessions = Array.isArray(sessions) ? sessions : [];
    const q = sidebarSearch ? sidebarSearch.value : "";
    const list = filterSessionsByQuery(lastSessions, q);
    updateTaskStrip(lastSessions);

    if (!list.length) {
      sessionHistoryList.innerHTML =
        '<div class="muted" style="padding:8px 10px;font-size:12px;line-height:1.45">暂无历史会话（或数据库未就绪）</div>';
      return;
    }
    sessionHistoryList.innerHTML = list
      .map((s) => {
        const id = String(s.id || "");
        const active = activeDbSessionId && id === activeDbSessionId ? " active" : "";
        const title = escapeHtml(historyTitleLine(s));
        const cnt = Number(s.message_count) || 0;
        const src = escapeHtml(String(s.source || "").slice(0, 12) || "—");
        const when = formatRelativeTime(s.started_at);
        return `<button type="button" class="wb-history-item${active}" data-db-id="${escapeHtml(id)}" role="listitem" title="${title}">
<span class="wb-hi-ico" aria-hidden="true">✓</span>
<span class="wb-history-body">
<span class="wb-history-title">${title}</span>
<span class="wb-history-meta">
<span class="wb-history-sub">${cnt} 条 · ${src}</span>
<span class="wb-history-time">${escapeHtml(when)}</span>
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
      sessionHistoryList.innerHTML = `<div class="muted" style="padding:8px 10px;font-size:12px">${escapeHtml(
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
      setChatTitle(historyTitleLine({ title: "", preview: (res.messages || []).find((m) => m.role === "user")?.text }));
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
      `<button type="button" class="wb-cat-pill${skillsFilterCat === "__all__" ? " active" : ""}" data-cat="__all__">全部</button>`,
    ];
    for (const c of cats) {
      const active = skillsFilterCat === c ? " active" : "";
      parts.push(
        `<button type="button" class="wb-cat-pill${active}" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`,
      );
    }
    skillsFilters.innerHTML = parts.join("");
  }

  function paintSkillsGrid() {
    const q = (skillsSearch.value || "").trim().toLowerCase();
    if (!skillsByCategory || !countSkills(skillsByCategory)) {
      skillsCount.textContent = "0";
      skillsList.className = "wb-skills-installed muted";
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
    skillsCount.textContent = String(items.length);
    skillsList.className = "wb-skills-installed";
    if (!items.length) {
      skillsList.innerHTML =
        '<div class="muted" style="grid-column:1/-1;padding:12px;font-size:13px">无匹配技能，可切换分类或清空搜索</div>';
      return;
    }
    skillsList.innerHTML = items
      .map(({ cat, name }) => {
        const h = skillHue(name);
        const L = escapeHtml(skillLetterIcon(name));
        const safeName = escapeHtml(name);
        return `<button type="button" class="wb-skill-card" data-skill="${safeName}" title="${safeName}">
<span class="wb-skill-ico" style="background:hsl(${h},68%,90%)">${L}</span>
<span class="wb-skill-body"><span class="wb-skill-name">${safeName}</span><span class="wb-skill-cat">${escapeHtml(cat)}</span></span>
</button>`;
      })
      .join("");
  }

  function renderAgentCard(info) {
    if (!info || typeof info !== "object") {
      agentCard.className = "wb-agent-card muted";
      agentCard.textContent = "无 Agent 信息";
      return;
    }
    agentCard.className = "wb-agent-card";
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
      toolsetsList.className = "wb-toolsets muted";
      toolsetsList.textContent = "无法加载工具集（会话未就绪？）";
      return;
    }
    toolsetsList.className = "wb-toolsets";
    toolsetsList.innerHTML = toolsets
      .map((ts) => {
        const name = escapeHtml(String(ts.name || ""));
        const desc = escapeHtml(String(ts.description || "").slice(0, 200));
        const en = ts.enabled !== false;
        const tag = en ? `<span class="tag tag-on">开</span>` : `<span class="tag tag-off">关</span>`;
        const cnt = ts.tool_count != null ? Number(ts.tool_count) : (ts.tools && ts.tools.length) || 0;
        const tools = Array.isArray(ts.tools) ? ts.tools.map((t) => escapeHtml(String(t))).join("\n") : "";
        return `<details class="wb-toolset-item" ${en ? "open" : ""}>
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
      subagentList.className = "wb-compact muted";
      subagentList.textContent = "无运行中的子 Agent";
      return;
    }
    subagentList.className = "wb-compact";
    subagentList.innerHTML = active
      .map((a) => {
        const id = escapeHtml(String(a.subagent_id || "?"));
        const model = escapeHtml(String(a.model || "—"));
        const goal = escapeHtml(String(a.goal || "").slice(0, 120));
        const st = escapeHtml(String(a.status || "—"));
        return `<div class="wb-row"><div class="wb-r-title">${id} · ${model}</div><div class="wb-r-sub">${st}${goal ? ` · ${goal}` : ""}</div></div>`;
      })
      .join("");
  }

  function renderBgProcs(data) {
    const procs = (data && data.processes) || [];
    if (!procs.length) {
      bgProcsList.className = "wb-compact muted";
      bgProcsList.textContent = "无登记的后台进程";
      return;
    }
    bgProcsList.className = "wb-compact";
    bgProcsList.innerHTML = procs
      .map((p) => {
        const sid = escapeHtml(String(p.session_id || "?"));
        const cmd = escapeHtml(String(p.command || "").slice(0, 100));
        const st = escapeHtml(String(p.status || "—"));
        const up = p.uptime != null ? `${Math.round(Number(p.uptime))}s` : "";
        return `<div class="wb-row"><div class="wb-r-title">${sid}</div><div class="wb-r-sub">${st}${up ? ` · ${up}` : ""} · ${cmd}</div></div>`;
      })
      .join("");
  }

  async function refreshSidebars() {
    if (!sessionId) return;
    const tasks = [
      gw
        .request("tools.list", { session_id: sessionId })
        .then((r) => {
          lastToolsets = r.toolsets || [];
          renderToolsets(r.toolsets);
          renderConnectorCards(lastToolsets);
        })
        .catch(() => {
          lastToolsets = [];
          toolsetsList.className = "wb-toolsets muted";
          toolsetsList.textContent = "工具列表加载失败";
          renderConnectorCards([]);
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
    el.className = `wb-bubble ${role}`;
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
    agentCard.className = "wb-agent-card muted";
    agentCard.textContent = "正在初始化 Agent…";
    skillsByCategory = null;
    skillsFilterCat = "__all__";
    skillsSearch.value = "";
    skillsFilters.innerHTML = "";
    skillsList.className = "wb-skills-installed muted";
    skillsList.textContent = "加载中…";
    skillsCount.textContent = "0";
    toolsetsList.className = "wb-toolsets muted";
    toolsetsList.textContent = "加载中…";
    subagentList.className = "wb-compact muted";
    subagentList.textContent = "—";
    bgProcsList.className = "wb-compact muted";
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
    lastToolsets = [];
    turnBusy = false;
    assistantEl = null;
    assistantText = "";
    btnStop.disabled = true;
    btnSend.disabled = false;
    clearTranscript();
    resetSidebarsLoading();
    setChatTitle("新任务");
    setTaskStatus("就绪");
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
        setTaskStatus("正在生成…");
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
        setTaskStatus("就绪");
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
        setTaskStatus("出错");
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
      <div class="wb-modal-card">
        <h2 style="margin:0 0 8px;font-size:1rem">需要审批</h2>
        <pre>${escapeHtml(summary)}</pre>
        <div class="wb-modal-actions">
          <button type="button" class="btn primary" data-choice="approve">允许</button>
          <button type="button" class="btn secondary" data-choice="deny">拒绝</button>
        </div>
      </div>`;
    modal.classList.remove("hidden");
    modal.querySelectorAll("[data-choice]").forEach((btn) => {
      btn.onclick = async () => {
        const choice = btn.getAttribute("data-choice");
        closeModal();
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
    setChatTitle(t);
    input.value = "";
    turnBusy = true;
    btnSend.disabled = true;
    btnStop.disabled = false;
    setTaskStatus("等待回复…");
    try {
      await gw.request("prompt.submit", { session_id: sessionId, text: t });
    } catch (e) {
      bubble("system", String(e.message || e));
      turnBusy = false;
      btnSend.disabled = false;
      btnStop.disabled = true;
      setTaskStatus("就绪");
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

  const quicks = ["你好，介绍一下你自己", "今天天气怎么样？", "用一句话总结当前代码仓库"];
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
    loadRoster().catch(() => {});
    loadExplorePlugins().catch(() => {});
    loadCronJobs().catch(() => {});
  };

  if (btnChatPlus) {
    btnChatPlus.onclick = () => {
      newSession().catch((e) => bubble("system", String(e.message || e)));
    };
  }

  sessionHistoryList.addEventListener("click", (e) => {
    const row = e.target.closest(".wb-history-item");
    if (!row) return;
    const id = row.getAttribute("data-db-id");
    if (id) resumeFromHistory(id).catch(() => {});
  });

  skillsFilters.addEventListener("click", (e) => {
    const btn = e.target.closest(".wb-cat-pill");
    if (!btn) return;
    skillsFilterCat = btn.getAttribute("data-cat") || "__all__";
    renderFilterPills();
    paintSkillsGrid();
  });

  skillsSearch.addEventListener("input", () => onSkillsSearchInput());

  navMenu.addEventListener("click", (e) => {
    const btn = e.target.closest(".wb-nav-item[data-view]");
    if (!btn || btn.id === "nav-library-toggle") return;
    const v = btn.getAttribute("data-view");
    if (v) setView(v);
  });

  document.querySelector(".wb-composer-toolbar")?.addEventListener("click", (e) => {
    const sw = e.target.closest("[data-view-switch]");
    if (!sw) return;
    const v = sw.getAttribute("data-view-switch");
    if (v) setView(v);
  });

  skillsList.addEventListener("click", (e) => {
    const card = e.target.closest(".wb-skill-card");
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

  if (navLibraryToggle && navLibrarySub) {
    navLibraryToggle.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const open = navLibrarySub.hasAttribute("hidden");
      if (open) {
        navLibrarySub.removeAttribute("hidden");
        navLibraryToggle.setAttribute("aria-expanded", "true");
      } else {
        navLibrarySub.setAttribute("hidden", "");
        navLibraryToggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  if (sidebarSearch) {
    sidebarSearch.addEventListener("input", () => {
      renderHistoryList(lastSessions);
    });
  }

  if (expertCatPills) {
    expertCatPills.addEventListener("click", (e) => {
      const p = e.target.closest(".wb-cat-pill");
      if (!p) return;
      expertCatPills.querySelectorAll(".wb-cat-pill").forEach((x) => x.classList.remove("active"));
      p.classList.add("active");
      expertFilter = p.getAttribute("data-filter") || "all";
      renderExpertViews();
    });
  }

  document.getElementById("skills-market-tabs")?.addEventListener("click", (e) => {
    const t = e.target.closest("[data-skills-tab]");
    if (!t) return;
    skillsMarketTab = t.getAttribute("data-skills-tab") || "rec";
    if (skillsMarketTab === "bundles") browsePage = 1;
    document.querySelectorAll("#skills-market-tabs .wb-mtab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    if (skillsMarketTab !== "hub") paintSkillsGrid();
    paintSkillsMarket().catch(() => {});
  });

  document.getElementById("btn-expert-new")?.addEventListener("click", () => showExpertNewModal());

  document.getElementById("btn-add-skill")?.addEventListener("click", () => {
    openModal(`<div class="wb-modal-card"><h2 style="margin:0 0 10px;font-size:1rem">安装技能</h2>
      <p class="muted" style="font-size:12px;margin:0 0 8px">传入 SkillHub 标识（如 <code>owner/repo</code>）或 CLI 支持的安装串。</p>
      <input type="text" id="skill-in-spec" class="wb-modal-input" placeholder="例如 official/github/my-skill" />
      <div class="wb-modal-actions">
        <button type="button" class="wb-btn-outline" data-modal-close>取消</button>
        <button type="button" class="wb-btn-primary" id="skill-in-go">安装</button>
      </div></div>`);
    document.getElementById("skill-in-go").onclick = async () => {
      const q = document.getElementById("skill-in-spec").value.trim();
      if (!q) return;
      try {
        await gw.request("skills.manage", { action: "install", query: q });
        bubble("system", `已请求安装：${q}`);
        closeModal();
        await refreshSidebars();
        await paintSkillsMarket();
      } catch (e) {
        bubble("system", String(e.message || e));
      }
    };
  });

  document.getElementById("btn-plugin-install")?.addEventListener("click", async () => {
    const el = document.getElementById("plugin-install-id");
    const id = (el && el.value.trim()) || "";
    if (!id) {
      bubble("system", "请填写 Git URL 或 owner/repo");
      return;
    }
    await runCliExec(["plugins", "install", id, "--enable"], "plugins install");
    await loadExplorePlugins();
  });

  document.getElementById("btn-cron-add")?.addEventListener("click", () => showCronJobModal({}));

  document.getElementById("cron-templates-grid")?.addEventListener("click", (e) => {
    const card = e.target.closest(".wb-cron-template");
    if (!card) return;
    showCronJobModal({
      name: card.getAttribute("data-cron-name") || "",
      schedule: card.getAttribute("data-cron-schedule") || "0 9 * * *",
      prompt: card.getAttribute("data-cron-prompt") || "",
    });
  });

  gw.onEvent = onGatewayEvent;

  (async () => {
    try {
      await gw.connect();
      setConn(true, "已连接");
      await newSession();
      startPolling();
      await loadProfileHome();
      await loadRoster();
      await loadExplorePlugins();
      await loadCronJobs();
    } catch (e) {
      setConn(false, "未连接");
      bubble("system", String(e.message || e));
    }
  })();
})();
