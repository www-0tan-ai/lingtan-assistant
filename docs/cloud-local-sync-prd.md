# 灵探助手产品设计文档（PRD v1.0）

## 1. 文档信息
- 产品名称：灵探助手（Lingtan Assistant）
- 版本：v1.0（MVP 到 v1.2 演进）
- 目标：构建“账号统一 + 云本地协同 + 本地采集分析”的双端智能助手产品
- 适用范围：基于当前仓库能力（Hermes Agent 架构）设计，不推翻现有底座

## 2. 背景与目标

### 2.1 背景
当前工程已有较强的本地工具执行能力、网关/API 能力、会话存储能力，但缺少面向终端用户的产品层能力：
- 缺统一用户账号体系
- 缺云本地双向数据同步协议
- 缺标准化本地采集任务体系

### 2.2 产品目标
1. 用户可通过账号登录，在多个端（本地客户端、云端入口）访问同一工作空间。
2. 本地端可读取本机软件/数据源，进行采集与分析。
3. 采集结果可同步到云端，云端任务也可下发到本地执行。
4. 保证安全、可控、可追踪。

### 2.3 非目标（v1 不做）
- 企业级多租户复杂组织架构（部门/审批流）
- 复杂 CRDT 级实时协同编辑
- 全量第三方生态连接器市场

## 3. 用户与核心场景

### 3.1 目标用户
- 个人技术用户：希望本地自动采集 + 云端统一查看分析报告
- 小团队负责人：希望集中查看多个设备的分析结果
- 业务用户：希望从本地业务软件抽取数据，云端汇总洞察

### 3.2 核心场景
- 场景 A：首次使用（注册/登录 -> 绑定本地设备 -> 初始化同步）
- 场景 B：本地采集（配置任务 -> 采集 -> 分析 -> 产出）
- 场景 C：双向同步（本地上行结果，云端下行任务）
- 场景 D：跨端连续工作（云端发起，本地执行，云端查看结果）

## 4. 需求范围（MVP）

### 4.1 功能需求

#### F1 账号与身份
- 邮箱 + 密码登录（MVP 先邮箱）
- Access Token + Refresh Token
- 设备绑定（每台本地端一个 Device ID）
- 登出与令牌失效

#### F2 工作空间与数据对象
- 每个用户至少一个工作空间
- 同步对象包含：
  - 会话元数据（可配置是否同步全量消息）
  - 采集任务定义
  - 采集结果摘要
  - 分析结果（报告、结论、标签）

#### F3 本地采集
- 采集来源（MVP）：
  - 本地文件/目录
  - 本地命令执行结果
  - CSV/JSON/TXT 文件
- 任务触发：手动 + 定时
- 本地结构化分析输出

#### F4 同步引擎
- 双向增量同步（拉 + 推）
- 幂等提交（request_id/event_id）
- 断网重试
- 基础冲突策略（LWW + 冲突日志）

#### F5 云端管理
- 任务管理：创建/禁用/查看状态
- 设备管理：在线状态、最后同步时间
- 报告中心：查看本地上报分析结果

#### F6 安全与隐私
- 本地敏感字段脱敏上传（规则可配置）
- 传输加密（HTTPS）
- 最小权限访问（用户仅访问本人数据）

## 5. 非功能需求（NFR）
- 可用性：核心 API 可用性 >= 99.9%
- 性能：同步请求 P95 < 800ms（不含大文件上传）
- 可靠性：断网后自动重试，保证最终一致
- 安全性：令牌过期、刷新、吊销机制完整
- 可扩展性：采集器插件化，同步对象可扩展

## 6. 信息架构与数据模型

### 6.1 核心实体
- User
- Workspace
- Device
- CollectorTask
- CollectedRecord
- AnalysisReport
- SyncEvent
- SyncCursor
- AuthSession

### 6.2 关键字段建议
- Device：`device_id`, `user_id`, `name`, `os`, `last_seen_at`, `status`
- CollectorTask：`task_id`, `workspace_id`, `source_type`, `schedule`, `config`, `enabled`
- CollectedRecord：`record_id`, `task_id`, `collected_at`, `payload_hash`, `payload_ref`
- AnalysisReport：`report_id`, `source_record_ids`, `summary`, `score`, `tags`
- SyncEvent：`event_id`, `workspace_id`, `object_type`, `object_id`, `version`, `op`, `created_at`
- SyncCursor：`device_id`, `workspace_id`, `last_event_version`

## 7. 系统架构设计（基于当前工程）

### 7.1 组件分层
1. 本地端（Agent + Local Collector）：复用现有 tools，新增采集调度器与本地同步客户端
2. 云端 API 层（Gateway/APIServer 扩展）：承载账号认证、同步接口、任务管理
3. 同步服务层（新增）：事件存储、游标推进、冲突处理
4. 存储层：本地 SQLite（可扩现有 SessionDB）+ 云端数据库

### 7.2 与现有仓库映射（建议）
- 认证：扩展 `gateway/platforms/api_server.py`，新增 `gateway/auth_service.py`
- 同步：新增 `sync/` 模块（`models.py`, `engine.py`, `conflict.py`, `cursor.py`）
- 本地采集：新增 `tools/collector_*` + `collector/runner.py`
- 持久化：扩展 `hermes_state.py` 或新增 `workspace_state.py`

## 8. 关键业务流程

### 8.1 登录与设备绑定
1. 用户登录，获取 `access_token + refresh_token`
2. 本地端调用 `/devices/register` 绑定 `device_id`
3. 返回设备密钥与同步初始游标

### 8.2 本地采集上行
1. 任务触发采集
2. 本地预处理/脱敏/摘要
3. 写入待同步队列
4. 调用 `/sync/push`
5. 云端返回 ack + 新 cursor

### 8.3 云端任务下行
1. 云端创建/更新采集任务
2. 生成 `SyncEvent`
3. 本地轮询 `/sync/pull?cursor=x`
4. 本地应用变更并回传执行状态

## 9. API 设计草案（MVP）

### 9.1 认证
- `POST /v1/auth/register`
- `POST /v1/auth/login`
- `POST /v1/auth/refresh`
- `POST /v1/auth/logout`

### 9.2 设备
- `POST /v1/devices/register`
- `GET /v1/devices`
- `POST /v1/devices/{id}/heartbeat`

### 9.3 同步
- `POST /v1/sync/push`
- `GET /v1/sync/pull?cursor=...&limit=...`

### 9.4 采集任务
- `POST /v1/collector/tasks`
- `GET /v1/collector/tasks`
- `PATCH /v1/collector/tasks/{task_id}`
- `POST /v1/collector/tasks/{task_id}/run`

### 9.5 报告
- `GET /v1/reports`
- `GET /v1/reports/{id}`

## 10. 冲突处理策略

### MVP
- 同一对象冲突优先服务端版本（或时间戳 LWW）
- 冲突写入审计日志，不阻断主流程

### v1.1+
- 任务配置：字段级 merge
- 报告：追加型，不覆盖
- 状态字段：时间戳优先

## 11. 安全与合规设计
- Token：短期 Access + 长期 Refresh
- 权限：用户 + 设备双重校验
- 本地密钥：系统安全存储（Windows Credential Manager/macOS Keychain）
- 数据策略：默认“摘要上云，原文可本地保留”
- 审计：登录、设备绑定、同步异常、权限拒绝均记录

## 12. 可观测性与运维
- 指标：`sync_push_success_rate`, `sync_pull_latency_p95`, `conflict_count`, `device_online_count`
- 日志：同步事件、错误码、请求链路 ID
- 告警：连续同步失败、冲突激增、设备长时间离线

## 13. 里程碑规划

### M1（2-3 周）：MVP 闭环
- 登录、设备绑定、最小双向同步、基础任务管理

### M2（2 周）：稳定性
- 断网重试、幂等去重、冲突日志、审计日志

### M3（2-4 周）：产品化增强
- 更多本地数据源连接器
- 报告中心完善
- 权限模型扩展（团队/角色）

## 14. 验收标准（DoD）
- 新设备登录后可访问同一工作空间
- 本地任务执行后 1 分钟内云端可见（正常网络）
- 断网恢复后自动补传且无重复数据
- 未授权用户不可访问他人数据
- 覆盖登录 -> 绑定 -> 采集 -> 同步 -> 报告查看的端到端测试

## 15. 风险与待确认事项
- 账号体系自建还是对接第三方 IdP（Auth0/Keycloak）
- 同步对象是否包含原始数据（合规与成本影响显著）
- 本地“读取软件”的优先软件清单与接入方式
- 对同步时效要求（秒级或分钟级）

## 16. 产品决策建议
- 先做“摘要上云、原文本地”
- 先做“单用户多设备”，不做团队协作
- 同步先用“增量事件 + cursor”
- 本地采集先从“文件 + 命令”启动，后续再扩展连接器
