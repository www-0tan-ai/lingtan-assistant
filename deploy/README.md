# 灵碳助手一键部署（Docker）

## 1) 准备

```bash
cd deploy
cp .env.example .env
```

编辑 `deploy/.env`，至少配置：

- 若提示容器名冲突，在 `.env` 里设置 `BACKEND_CONTAINER_NAME` / `FRONTEND_CONTAINER_NAME`（默认已改为 `lingtan-api`、`lingtan-ui`，与旧的 `lingtan-backend` 不重名）。
- **`API_SERVER_KEY`（公网部署必填）**：绑定 `0.0.0.0` 时网关要求非空密钥，否则 API 不启动 → **502**。在 `.env` 中设置随机串（如 `openssl rand -hex 32`）。未写该项时 `docker compose` 仍可解析，但容器内服务起不来。
- **`API_SERVER_CORS_ORIGINS`**：须包含用户浏览器里的前端地址（例如 `http://你的公网IP:6121`），否则注册/登录在浏览器里会因 CORS 失败（与 502 不同，但常被一起排查）。

- `HERMES_BASE_URL` + `CUSTOM_API_KEY`（或 `OPENAI_API_KEY`）：与 `HERMES_DEFAULT_PROVIDER=custom` 一起供网关推理；仅写进 compose 不够时，默认 `config.yaml` 仍是 `provider: auto` + OpenRouter，会导致上游 **401 Missing Authentication**。
- 至少一个可用密钥（如 `OPENAI_API_KEY` 或 `CUSTOM_API_KEY`）

## 自建前端 dev server 与内置 `/app` 登录对齐（与 Hermes 一致）

Hermes CLI **没有**邮箱密码登录；浏览器里的「灵碳账号」只属于 **当前 API Server 进程**内置的 SQLite（CloudSync）。

- **接口**：一律走 `POST {BACKEND_URL}/v1/auth/register`、`POST …/v1/auth/login`，请求体 `{ email, password }`（可选 `device_id`），响应里令牌字段 **`access_token` / `refresh_token`**。
- **鉴权**：`Authorization: Bearer <access_token>`；若部署了 **`API_SERVER_KEY`**，同类 OpenAI 兼容路由也可 Bearer 该密钥（白牌壳层已支持「网关密钥」入口）。
- **localStorage 键名（勿另起炉灶）**：以 `GET {BACKEND_URL}/v1/capabilities` 返回的 **`lingtan_browser_sdk.local_storage_keys`** 为准（与仓库内 **`ui-cloud-local/lingtan-auth-contract.js`** 同步）；自建 Vue/React（如 compose 指向的私有前端镜像）应复制该文件或启动时 fetch capabilities 对齐键名。
- **Vite/webpack**：把 `LINGTAN_API_BASE`/`__HERMES_UI_API_BASE__` 指到后端根（例如 `http://localhost:8650`，无路径尾 `/`）；并保证 **`API_SERVER_CORS_ORIGINS`** 包含前端的 Origin。

## 2) 启动

```bash
docker compose -f docker-compose.lingtan.yml --env-file .env up -d --build
```

## 3) 访问

- 前端：`http://<服务器IP>:${FRONTEND_PORT}`（默认 `8080`）
- 后端健康检查：`http://<服务器IP>:${BACKEND_PORT}/health`（默认 `8650`）

## 4) 停止

```bash
docker compose -f docker-compose.lingtan.yml --env-file .env down
```

## 5) 更新代码后重建

```bash
docker compose -f docker-compose.lingtan.yml --env-file .env up -d --build
```

## 6) 浏览器访问前端报 502（`/v1/...`）

多为后端未监听：检查 `deploy/.env` 是否已设置 **`API_SERVER_KEY`**，以及 `lingtan-api` 容器日志是否出现 `Refusing to start: binding to 0.0.0.0 requires API_SERVER_KEY`。

## 6b) 报 **403**（`/v1/auth/register` 等）

多为 **CORS 中间件**拒绝：浏览器带 `Origin: http://公网IP:6121`，而 `API_SERVER_CORS_ORIGINS` 里只有 `http://localhost:…`。新版本在 **Origin 的主机名与请求 `Host` 一致**（经 nginx 反代到后端）时会自动放行；若仍 403，请把真实前端 Origin 写进 `API_SERVER_CORS_ORIGINS`，并确认 `docker logs lingtan-api` 里 API 已 `listening`。

## 7) 构建失败：`npm ERR! network aborted`

`lingtan-backend` 使用 `deploy/Dockerfile.backend`，**不跑**仓库根目录 Dockerfile 里的 npm / Playwright。若仍在前端构建阶段失败，可在 `deploy/.env` 中设置：

- `NPM_REGISTRY=https://registry.npmmirror.com`（或你信任的 registry）
- 必要时在构建主机上使用稳定网络，或对 Docker 配置 HTTP(S) 代理

`docker compose build` 会把 `NPM_*` 作为 build-arg 传给前端镜像。
