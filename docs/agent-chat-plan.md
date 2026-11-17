# 把工作台对话换成真正的 DSH agent

目标：面板里的那个对话框不再是「一句话 → 固定 ops」的翻译机，而是挂一个真实的 agent session，
从而继承 DSH 的工具、skill、审批和 session 日志。

状态：**可行性已验证，工具集还差一步**。

## 已验证（在 Desktop 0.2.2-rc.3 / 插件 2.7.2 上）

插件 Host 侧 `ctx.get('agents')` 可用，以下都跑通了：

| 能力 | 结论 |
| --- | --- |
| `ctx.agents.create({ sessionId, meta, agentOptions })` | 可用，返回 `{ agent, dispose }` |
| `handle.agent.followup({ content: [{type:'text',text}], source })` | 可用 |
| `handle.agent.whenIdle()` | 可用，一轮结束后 resolve |
| `handle.agent.session.snapshotEvents()` | 可用，能读到 `turn/start`、`assistant/message`、`turn/end` |
| `handle.agent.session.deriveMessages()` | 可用，拿到完整角色消息 |
| `handle.agent.session.toolHistory()` | 可用，能列出该 agent 的工具 |
| `handle.dispose()` | 可用 |

一轮真实对话（模型 `magpie/or/google/gemini-4-hydrogen`）跑通，`turn/end` 是 `completed`。

## 两个坑

1. **模型路由**：`defaultSelection(ctx)` 给的是 `deepseek-account / deepseek-flash`，在新建 session 里
   连续 5 次 `DeepSeek Messages transport failed`（`TRANSPORT`）。换成工作台自己配的
   `magpie`（`settings.assistant`）就正常。── 实现时应优先用 `settings.assistant`，没有才回退默认。
2. **工具集**：`meta.agentPreset: 'standard'` 没生效，agent 只拿到
   `working_directory`、`load_workspace_dependencies` 两个工具（等于 minimal preset）。
   需要找到真实 preset id，或在 `create({ setup(agentCtx, agent) })` 里把工具包挂到 agent 作用域。

## 设计（下一步实现）

- session id：`session-media-desk-<itemId>`，每条灵感一个；用 `resume()` 复用，失败再 `create()`。
- 收发：面板 `POST /media-desk/agent` → `followup()`；Host 订阅 `agent/assistant-stream` 流式写回，
  `turn/end` 时落盘到 `item.chat`，客户端沿用现有轮询。
- 工作台操作注册成 agent 工具（`agent.ctx.tools.register`）：`add_item` / `update_item` /
  `produce` / `set_figure` / `list_items`，让 agent 能直接改稿。
- 生图保持两条路：封面/配图默认走现行生图 API，agent 另有一个 `draw_figure` 工具按需重画。
- 风险：① 审批策略在自建面板里没有 UI，`ask` 会 fail-closed，需要给这类 session 指定 preset 或加授权卡片；
  ② 每个 item 一个 session 会在侧栏/存储里产生记录；③ token 成本比现在的单次调用高。
