# 云本地双端快速上手

这个文档是“低门槛封装入口”，用于快速跑通：
- 账号注册/登录
- 本地设备绑定
- 本地事件上报（push）
- 云端事件拉取（pull）

## 1. 启动 API Server

先确保 API Server 已启动并监听 `http://127.0.0.1:8642`。  
如果你已有网关启动方式，继续沿用即可。

## 2. 一键初始化（注册 + 登录 + 绑定设备）

```bash
python scripts/cloud_local_easy_start.py init --email demo@example.com --password password123
```

输出会包含：
- `access_token`
- `refresh_token`
- `device_id`

## 3. 推送一条本地分析结果（示例）

```bash
python scripts/cloud_local_easy_start.py push-sample --access-token <ACCESS_TOKEN> --summary "本地数据分析结果示例"
```

## 4. 拉取云端同步事件

```bash
python scripts/cloud_local_easy_start.py pull --access-token <ACCESS_TOKEN> --cursor 0
```

## 5. 开发侧封装接口（可直接在 UI/本地客户端调用）

`gateway/cloud_sync_client.py` 提供了统一接口：
- `register()`
- `login()`
- `refresh()`
- `register_device()`
- `list_devices()`
- `heartbeat()`
- `push_events()`
- `pull_events()`

建议本地端 UI 直接调用这层封装，避免散落 HTTP 细节。
