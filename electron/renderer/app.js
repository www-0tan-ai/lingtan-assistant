/**
 * Minimal tui_gateway JSON-RPC over WebSocket (same wire as Ink / dashboard PTY).
 */
(() => {
  const REQUEST_TIMEOUT_MS = 120000;
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
  const connPill = document.getElementById("conn-pill");
  const toolList = document.getElementById("tool-list");
  const modal = document.getElementById("modal");
  const quickPills = document.getElementById("quick-pills");

  let sessionId = null;
  /** @type {boolean} */
  let turnBusy = false;
  /** @type {HTMLElement | null} */
  let assistantEl = null;
  let assistantText = "";

  function setConn(ok, text) {
    connPill.textContent = text;
    connPill.classList.toggle("err", !ok);
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
    toolList.innerHTML = "";
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
    turnBusy = false;
    assistantEl = null;
    assistantText = "";
    btnStop.disabled = true;
    btnSend.disabled = false;
    clearTranscript();
    const res = await gw.request("session.create", { cols: 100 });
    sessionId = res.session_id;
    bubble("system", `会话已创建 · ${sessionId}`);
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
      case "message.start":
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
        toolList.appendChild(li);
        toolList.parentElement.scrollTop = toolList.parentElement.scrollHeight;
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

  function escapeHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
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
    } catch (e) {
      setConn(false, "未连接");
      bubble("system", String(e.message || e));
    }
  })();
})();
