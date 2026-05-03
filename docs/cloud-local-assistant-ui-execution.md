# 灵碳 Web UI · 能力与执行清单（Skills / 子代理(subagent) / 真实会话）

## 1. 目标（与用户表述对照）

| 你的意图 | 本项目实现 | 验收 |
|----------|------------|------|
| **灵碳里有 subagent**（非笔误 Sunagent） | 复用 Hermes 已有 **`delegate_task`**：spawn 子 `AIAgent`，与 TUI/gateway 的子代理一致 | 勾选「子代理模式」后服务端在临时 system 中注入编排说明 + roster |
| **子代理在界面上列出，和 Skills 一样** | 左侧 **「子代理」** Tab：`GET /v1/assistant/agents` 返回 `lingtan_ui.agents` 中 **enabled** 的条目，UI 用与 Skills 相同的 **`pre` JSON 面板 + 刷新按钮** | 与「Skills 目录」Tab 交互一致 |
| **Skills 全部展示** | `GET /v1/assistant/skills` → `list_skills_catalog()`（含 `skills/` 与 `~/.hermes/skills` 等） | Skills Tab |
| **真实多轮会话** | `X-Hermes-Session-Id` + SessionDB + `GET /v1/assistant/conversation` | 刷新后仍可拉历史 |

## 2. 术语

- **Subagent / 子代理**：Hermes `tools/delegate_tool.py` → `delegate_task` 产生的独立子 agent（隔离上下文与 toolsets）。
- **Roster（本 UI 列表）**：只是 **配置里声明可派任务的专家档案**（id、name、toolsets），**不是**运行时「正在跑的子进程」列表；运行中的子代理会话由模型在回合内创建，Web 端不单独罗列进程。

## 3. API（子代理模式）

| 条件 | 说明 |
|------|------|
| JSON body | `subagent: true`（**仍接受**旧字段 `sunagent: true` 以兼容） |
| 请求头 | `X-Lingtan-Subagent: 1`（**仍接受**旧头 `X-Lingtan-Sunagent: 1`） |
| 能力发现 | `GET /v1/capabilities` → `subagent_delegate_mode_*` 与 `*_legacy` |

编排提示读取 `lingtan_ui.subagent_prompt_extra`；若仍存在旧键 **`sunagent_prompt_extra`** 也会回退读取。

## 4. 配置

- 默认 roster：`DEFAULT_CONFIG["lingtan_ui"]["agents"]`，用户可在 `config.yaml` 的 **`lingtan_ui`** 下合并覆盖。
- 附加说明：`lingtan_ui.subagent_prompt_extra`（字符串，拼在编排模板后）。

## 5. Web UI 状态键

- `wb_subagent`：是否开启子代理模式（`1` / 删除即关）。曾误用 `wb_sunagent` 的浏览器会在启动时 **自动迁移** 到 `wb_subagent`。

## 6. 边界

- 是否在每一轮 **真的** 调用 `delegate_task` 由 **模型** 决定；模板为软引导。
- `/v1/assistant/agents` 展示的是 **配置的子代理专员列表**，不是运行时任务看板。
- 插件 `namespace:skill` 未并进 Skills 目录 API（见旧版说明）；子代理 roster 与 Skills 无关。
