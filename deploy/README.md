# 灵碳助手一键部署（Docker）

## 1) 准备

```bash
cd deploy
cp .env.example .env
```

编辑 `deploy/.env`，至少配置：

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
