const state = {
  accessToken: localStorage.getItem("wb_access_token") || "",
  deviceId: localStorage.getItem("wb_device_id") || "",
  pullCursor: Number(localStorage.getItem("wb_sync_cursor")) || 0,
  email: "",
};

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

function showApp() {
  $("login-screen").classList.add("hidden");
  $("app-shell").classList.remove("hidden");
}

function showLogin() {
  $("app-shell").classList.add("hidden");
  $("login-screen").classList.remove("hidden");
}

async function api(path, options = {}) {
  const headers = {
    ...syncHeaders(Boolean(options.attachDevice)),
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  if (options.auth && state.accessToken) {
    headers.Authorization = `Bearer ${state.accessToken}`;
  }
  const resp = await fetch(path, { ...options, headers });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data?.error?.message || `HTTP ${resp.status}`);
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

async function sendChat() {
  const input = $("chat-input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  appendMessage("user", text);
  try {
    const payload = {
      model: "assistant-core",
      messages: [{ role: "user", content: text }],
      stream: false,
    };
    const data = await api("/v1/chat/completions", { method: "POST", body: JSON.stringify(payload) });
    const msg = data?.choices?.[0]?.message?.content || "（无回复）";
    appendMessage("assistant", msg);
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
    });
  });
}

function logout() {
  state.accessToken = "";
  localStorage.removeItem("wb_access_token");
  localStorage.removeItem("wb_device_id");
  localStorage.removeItem("wb_sync_cursor");
  state.deviceId = "";
  state.pullCursor = 0;
  showLogin();
}

function init() {
  bindTabs();
  if (state.accessToken) {
    showApp();
  } else {
    showLogin();
  }

  $("landing-login").addEventListener("click", landingLogin);
  $("landing-register").addEventListener("click", landingRegister);
  $("logout-btn").addEventListener("click", logout);

  $("send-chat").addEventListener("click", sendChat);
  $("chat-input").addEventListener("keydown", (evt) => {
    if (evt.key === "Enter" && !evt.shiftKey) {
      evt.preventDefault();
      sendChat();
    }
  });
  $("register").addEventListener("click", register);
  $("login").addEventListener("click", login);
  $("bind-device").addEventListener("click", bindDevice);
  $("push-sample").addEventListener("click", pushSample);
  $("pull-events").addEventListener("click", pullEvents);
  document.querySelectorAll(".quick-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const prompt = chip.getAttribute("data-prompt") || "";
      $("chat-input").value = prompt;
      sendChat();
    });
  });
  if (state.accessToken) {
    setPanel("account-result", "已检测到本地登录态，可直接绑定设备和同步。");
  }
}

init();
