# 灵探助手技术实现方案（TDD/MVP Plan v1.0）

## 1. 目标与范围

基于现有仓库能力，采用最小侵入改造，落地以下 MVP 能力：
- 账号登录（注册/登录/刷新/登出）
- 单用户多设备绑定
- 云本地双向同步（事件 + cursor）
- 本地采集（文件/命令/结构化文件）与分析结果上报

非目标（本阶段不做）：
- 企业级组织权限模型
- 复杂实时协同（CRDT）
- 大规模第三方连接器生态

## 2. 总体技术路线

- 架构模式：Event + Cursor 的最终一致同步架构
- 数据策略：摘要上云，原文默认本地保留
- 范围控制：先支持单用户多设备，再扩展团队能力
- 实施原则：优先复用 `gateway`、`hermes_state.py`、`tools` 基础能力

## 3. 目标架构（模块拆分）

### 3.1 云端模块
- API 入口：扩展 `gateway/platforms/api_server.py`
- 新增服务层：
  - `gateway/auth_service.py`
  - `gateway/device_service.py`
  - `gateway/sync_service.py`
  - `gateway/repos/`（数据访问层）

### 3.2 本地模块
- 采集执行：
  - `collector/runner.py`
  - `collector/sources/file_scan_source.py`
  - `collector/sources/command_source.py`
  - `collector/sources/structured_file_source.py`
- 同步客户端：
  - `sync/client.py`
  - `sync/local_store.py`

### 3.3 共享模型
- `sync/models.py`：
  - `SyncEvent`
  - `SyncCursor`
  - `ConflictRecord`
  - `ObjectEnvelope`

## 4. 数据模型设计（MVP）

### 4.1 云端数据表
- `users`：`id`, `email`, `password_hash`, `status`, `created_at`
- `auth_sessions`：`id`, `user_id`, `refresh_token_hash`, `device_id`, `expires_at`, `revoked_at`
- `devices`：`id`, `user_id`, `name`, `os`, `last_seen_at`, `status`
- `collector_tasks`：`id`, `user_id`, `name`, `source_type`, `schedule`, `config_json`, `enabled`, `version`
- `analysis_reports`：`id`, `user_id`, `task_id`, `summary`, `tags_json`, `score`, `created_at`, `version`
- `sync_events`：`id`, `user_id`, `event_version`, `object_type`, `object_id`, `op`, `payload_json`, `created_at`
- `sync_cursors`：`id`, `user_id`, `device_id`, `last_event_version`, `updated_at`
- `sync_conflicts`：`id`, `user_id`, `device_id`, `object_type`, `object_id`, `client_version`, `server_version`, `resolved_by`, `created_at`

### 4.2 本地存储（SQLite）
- `local_tasks_cache`
- `local_reports_queue`
- `local_sync_outbox`
- `local_sync_state`

说明：可在现有 `hermes_state.py` 扩展，或新增 `workspace_state.py` 托管业务对象。

## 5. API 设计（MVP）

### 5.1 认证
- `POST /v1/auth/register`
- `POST /v1/auth/login`
- `POST /v1/auth/refresh`
- `POST /v1/auth/logout`

### 5.2 设备
- `POST /v1/devices/register`
- `POST /v1/devices/heartbeat`
- `GET /v1/devices`

### 5.3 同步
- `POST /v1/sync/push`
  - 入参：`device_id`, `events[]`
  - 出参：`accepted_event_ids`, `rejected`, `next_cursor`
- `GET /v1/sync/pull?cursor=...&limit=...`
  - 出参：`events[]`, `next_cursor`, `has_more`

### 5.4 采集任务
- `GET /v1/collector/tasks`
- `POST /v1/collector/tasks`
- `PATCH /v1/collector/tasks/{task_id}`
- `POST /v1/collector/tasks/{task_id}/run`

### 5.5 报告
- `POST /v1/reports`
- `GET /v1/reports`
- `GET /v1/reports/{id}`

## 6. 同步协议与冲突策略

### 6.1 事件结构
- `event_id`（UUID，幂等键）
- `object_type`
- `object_id`
- `op`（create/update/delete/upsert）
- `client_version`
- `payload`
- `occurred_at`

### 6.2 协议规则
- 幂等：服务端按 `event_id` 去重
- 顺序：服务端按 `event_version` 递增推进
- 断点恢复：本地持久化 `cursor + outbox`
- 重试：指数退避（上限 5 分钟）

### 6.3 冲突处理（MVP）
- 默认 LWW（最后写入优先）
- 冲突写入 `sync_conflicts`
- 关键对象冲突返回 `409` 并附 `server_snapshot`

## 7. 本地采集实现细节

### 7.1 首批采集源
- 文件目录扫描（含文件摘要提取）
- 受控命令执行并解析输出
- CSV/JSON/TXT 结构化读取

### 7.2 执行流程
1. 加载本地任务缓存
2. 调用对应 source adapter 执行采集
3. 执行脱敏与结构化归一
4. 本地分析生成 report
5. 写入 `local_sync_outbox`
6. 同步客户端 push 到云端

## 8. 安全实现要点

- Token 策略：短期 Access + 长期 Refresh
- Refresh Token 仅存哈希值
- 本地密钥使用系统安全存储
- API 鉴权：`user_id + device_id` 双校验
- 默认脱敏上传，原文本地保留
- 审计日志覆盖登录、设备注册、同步失败、权限拒绝

## 9. 与现有代码衔接策略（最小侵入）

- 在 `gateway/platforms/api_server.py` 增加新路由
- 复用 `gateway/session.py` 的管理思路，但业务对象独立实现
- 扩展 `hermes_state.py` 或新增状态文件承载同步状态
- 在 `tools/` 增加采集工具并注册到对应 toolset
- 避免改动 `run_agent.py` 主循环，减少风险面

## 10. 分阶段落地计划

### Phase 1（第 1-2 周）：闭环骨架
- 完成 auth/device/sync 基础接口
- 打通本地 outbox + cursor
- 空对象同步链路联调成功

### Phase 2（第 3-4 周）：对象同步
- 任务对象下行同步
- 报告对象上行同步
- 幂等去重、断网重试、409 冲突处理

### Phase 3（第 5-6 周）：本地采集上线
- 文件/命令/结构化文件采集器
- 本地分析输出与云端展示接口
- 端到端业务流程稳定运行

### Phase 4（第 7 周+）：稳定性增强
- 审计日志完善
- 可观测性与告警
- 脱敏规则可配置化

## 11. 测试策略

### 11.1 单元测试
- Token 生命周期与刷新流程
- `event_id` 幂等去重
- cursor 推进与断点恢复
- 冲突判定与 409 返回

### 11.2 集成测试
- 登录 -> 设备注册 -> 下发任务 -> 本地执行 -> 上报报告
- 多设备同步一致性验证

### 11.3 故障注入测试
- 断网重试
- 重复投递
- 服务重启恢复

### 11.4 安全测试
- 越权访问
- 伪造 `device_id`
- token 重放与失效令牌访问

## 12. 完成标准（工程 DoD）

- 用户可注册登录并绑定设备
- 本地采集任务结果可在云端查询
- 断网恢复后可自动补传且无重复对象
- 权限隔离正确（不可访问他人数据）
- 具备最小监控与审计能力

## 13. 风险与决策待确认

- 账号体系：自建或接入第三方 IdP（如 Auth0/Keycloak）
- 同步边界：是否上报原始数据
- 读取本地软件的优先级清单与接入方式
- 同步时效目标：秒级或分钟级

## 14. 推荐默认决策（便于尽快开工）

- 先做“摘要上云，原文本地”
- 先做“单用户多设备”
- 先做“事件同步 + cursor”而非实时协同
- 采集源先覆盖文件与命令，再扩展软件连接器
