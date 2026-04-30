# 灵碳助手一键部署（Docker）

## 1) 准备

```bash
cd deploy
cp .env.example .env
```

编辑 `deploy/.env`，至少配置：

- 若提示容器名冲突，在 `.env` 里设置 `BACKEND_CONTAINER_NAME` / `FRONTEND_CONTAINER_NAME`（默认已改为 `lingtan-api`、`lingtan-ui`，与旧的 `lingtan-backend` 不重名）。
- **`API_SERVER_KEY`（必填）**：绑定 `0.0.0.0` 时网关要求配置该密钥，否则 API 进程不启动，经 nginx 反代会出现 **502**。在 `.env` 中设置随机串（如 `openssl rand -hex 32`）。
- **`API_SERVER_CORS_ORIGINS`**：须包含用户浏览器里的前端地址（例如 `http://你的公网IP:6121`），否则注册/登录在浏览器里会因 CORS 失败（与 502 不同，但常被一起排查）。

- `HERMES_BASE_URL`（如果用 custom provider）
- 至少一个可用密钥（如 `OPENAI_API_KEY` 或 `CUSTOM_API_KEY`）

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

## 7) 构建失败：`npm ERR! network aborted`

`lingtan-backend` 使用 `deploy/Dockerfile.backend`，**不跑**仓库根目录 Dockerfile 里的 npm / Playwright。若仍在前端构建阶段失败，可在 `deploy/.env` 中设置：

- `NPM_REGISTRY=https://registry.npmmirror.com`（或你信任的 registry）
- 必要时在构建主机上使用稳定网络，或对 Docker 配置 HTTP(S) 代理

`docker compose build` 会把 `NPM_*` 作为 build-arg 传给前端镜像。
