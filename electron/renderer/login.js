/**
 * Login screen controller.
 *
 * Reads /auth.js (window.zcAuth) for API plumbing. Form posts to api_server's
 * /v1/auth/login + /v1/auth/register. The "本机使用" path skips network entirely.
 */
(() => {
  const auth = window.zcAuth;
  if (!auth) {
    document.body.innerHTML =
      '<p style="padding:24px;font-family:sans-serif">auth.js failed to load.</p>';
    return;
  }

  /* If already authed (or in local-only mode), bounce straight to the app. */
  if (auth.isAuthed()) {
    auth.navigate("/index.html");
    return;
  }

  /* Pull the sidecar's bootstrap config so the API base presets without
   * forcing the user to type it. Errors are non-fatal — local-only still works. */
  auth.loadDesktopConfig().then(() => {
    const el = document.getElementById("api-base");
    if (el) el.value = auth.getApiBase();
  }).catch(() => {});

  const form = document.getElementById("login-form");
  const emailEl = /** @type {HTMLInputElement} */ (document.getElementById("login-email"));
  const passEl = /** @type {HTMLInputElement} */ (document.getElementById("login-password"));
  const errEl = document.getElementById("login-error");
  const infoEl = document.getElementById("login-info");
  const submitBtn = /** @type {HTMLButtonElement} */ (document.getElementById("login-submit"));
  const labelEl = submitBtn.querySelector(".zc-login-label");
  const spinEl = submitBtn.querySelector(".zc-login-spin");
  const btnRegister = document.getElementById("btn-register");
  const btnSkip = document.getElementById("btn-skip");
  const apiBaseEl = /** @type {HTMLInputElement} */ (document.getElementById("api-base"));
  const btnSaveApiBase = document.getElementById("btn-save-api-base");

  apiBaseEl.value = auth.getApiBase();

  function setBusy(busy) {
    submitBtn.disabled = busy;
    btnRegister.disabled = busy;
    btnSkip.disabled = busy;
    if (busy) {
      labelEl.style.display = "none";
      spinEl.removeAttribute("hidden");
    } else {
      labelEl.style.display = "";
      spinEl.setAttribute("hidden", "");
    }
  }

  function showError(msg) {
    errEl.hidden = false;
    errEl.textContent = String(msg || "请求失败");
    infoEl.hidden = true;
  }

  function showInfo(msg) {
    infoEl.hidden = false;
    infoEl.textContent = msg;
    errEl.hidden = true;
  }

  function clearMessages() {
    errEl.hidden = true;
    infoEl.hidden = true;
  }

  function ensureApiBase() {
    const v = auth.getApiBase();
    if (!v) {
      showError("尚未设置服务端地址。展开「高级 · 服务端地址」填写后再试。");
      return false;
    }
    return true;
  }

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    clearMessages();
    const email = emailEl.value.trim();
    const password = passEl.value;
    if (!email || !password) return;
    if (!ensureApiBase()) return;
    setBusy(true);
    try {
      await auth.login(email, password);
      auth.navigate("/index.html");
    } catch (e) {
      showError(e?.message || "登录失败");
    } finally {
      setBusy(false);
    }
  });

  btnRegister.addEventListener("click", async () => {
    clearMessages();
    const email = emailEl.value.trim();
    const password = passEl.value;
    if (!email || !password) {
      showError("请先填写邮箱和密码后再注册");
      return;
    }
    if (!ensureApiBase()) return;
    setBusy(true);
    try {
      await auth.register(email, password);
      showInfo("注册成功，可直接点击「进入灵碳助手」登录。");
    } catch (e) {
      showError(e?.message || "注册失败");
    } finally {
      setBusy(false);
    }
  });

  btnSkip.addEventListener("click", () => {
    clearMessages();
    auth.setLocalOnly();
    auth.navigate("/index.html");
  });

  btnSaveApiBase.addEventListener("click", () => {
    auth.setApiBase(apiBaseEl.value);
    apiBaseEl.value = auth.getApiBase();
    showInfo(auth.getApiBase() ? `已保存：${auth.getApiBase()}` : "已清除服务端地址（本机模式）");
  });
})();
