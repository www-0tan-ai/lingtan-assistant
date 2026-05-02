# 灵碳 Web UI · 能力与执行清单（Skills / Sunagent / 真实会话）

## 1. 目标（来自需求）

| 诉求 | 预期行为 | 验收 |
|------|----------|------|
| Skills 展示区 | UI 罗列**当前环境里能发现的全部 Skill**（含仓库内置 `skills/` 与用户目录，标注是否在配置里启用） | 「Skills」 Tab 可调 API 拉到完整列表并可滚动查看 |
| Agent 模块 | 展示 **`lingtan_ui.agents`** 中**当前启用**的专家代理 | 「Agents」Tab 仅显示 `enabled: true` |
| Sunagent（子代理编排） | 用户发话时可选开启：由**编排代理**按需调用 `delegate_task`，把子任务派给配置里不同 toolsets 的**子代理** | 聊天请求带 `sunagent: true`，模型可使用 `delegate_task`（依赖 `hermes-api-server` 默认含 delegation） |
| 真实对话记录 | 服务端 **SessionDB (`state.db`)** 持久化多轮上下文；前端用 **固定 `X-Hermes-Session-Id`** 续聊，并可拉取历史渲染 | 刷新页面后仍能加载同一 session 的对话；服务端 `hermes sessions` 可见 |

## 2. 技术决策

- **列表数据来源**：Python 侧 `tools/skills_tool.py` 发现逻辑 + 追加扫描仓库根目录 **`skills/`**（与用户 `~/.hermes/skills` 去重合并，同名优先用户侧）。
- **Agent  roster**：不做硬编码运行时注册表；以 **`DEFAULT_CONFIG["lingtan_ui"]["agents"]`** 为默认值，可由用户 `config.yaml` 合并覆盖。
- **编排提示**：`/v1/chat/completions` 在 `sunagent: true` 或 `X-Lingtan-Sunagent: 1` 时在 **临时 system** 附加 Sunagent 说明与 JSON roster。
- **会话门禁**：原先仅 `API_SERVER_KEY` 存在时才允许 `X-Hermes-Session-Id` 续聊；现扩展为：**Bearer 与 `API_SERVER_KEY` 匹配，或 Bearer 为有效 Lingtan access token**，即可续聊（仍拒绝完全匿名环境下的 session 头枚举）。

## 3. API 增量

| Method | Path | 说明 |
|--------|------|------|
| GET | `/v1/assistant/skills` | 全量 Skill 目录（含 `enabled_in_config`） |
| GET | `/v1/assistant/agents` | 启用中的 Sunagent 子代理清单 |
| GET | `/v1/assistant/conversation` | Query `session_id`，返回 OpenAI 形 `messages[]` |

以上与 `/v1/chat/completions` 相同鉴权：**`Authorization: Bearer`**（API key 或 Lingtan JWT）。

## 4. Web UI

- **Tab**：Skills / Agents / （原）智能助手 / 云端同步 / 账号。
- **状态**：`localStorage`：`wb_access_token`、`wb_hermes_session_id`、`wb_device_id`、`wb_sunagent`。
- **新对话**：重置 `wb_hermes_session_id`，清空聊天面板。
- **发送**：附带 `X-Hermes-Session-Id`、`X-Lingtan-Sunagent`（按需）；读响应头 `X-Hermes-Session-Id` 回填。

## 5. 配置示例（可选）

```yaml
lingtan_ui:
  agents:
    - id: coder
      name: 代码与仓库
      description: 读写代码、补丁、终端构建
      toolsets: [file, terminal, debugging]
      enabled: true
```

（`toolsets` 必须使用 `toolsets.py` 中存在的工具集名称；可参考 `DEFAULT_CONFIG["lingtan_ui"]`。）

## 6. 风险与边界

- **插件技能**：`namespace:skill` 形式的插件技能未合并进本目录 API（会话内仍可用 `skills_list`）。
- **模型是否真的会 delegate**：取决于模型能力与提示；编排提示为软性约束。
- **Skill 特别多**：Skills Tab 只做列表摘要，不提供全文（全文仍通过 `skill_view` 工具 / CLI）。
- **多用户 session 隔离**：当前 session id 由客户端随机生成并在服务端存消息；不靠 user_id 绑表（若要强隔离需在 SessionDB 层按 user_id 分区）。
