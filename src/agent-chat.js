// 工作台对话的 agent 版：每条灵感挂一个真实的 DSH agent session，借用 Harness 的工具和 skill。
// 面板只管发消息和轮询状态，模型调用、工具、审批、session 日志都由 Harness 负责。
import { defaultSelection } from './ai.js'
import { registerAgentTools } from './agent-tools.js'
import { newId } from './ops.js'

/** 每条灵感一个 agent：itemId -> { handle, sessionId, preset } */
const agents = new Map()
/** 正在跑的回合：itemId -> { status, startedAt, error, tools, text } */
const runs = new Map()

const IDLE = { status: 'idle' }

export function agentChatAvailable(ctx) {
  try {
    return Boolean(ctx.get('agents') && ctx.get('agentPresets'))
  } catch {
    return false
  }
}

/** 用工作台里配的助手模型，没有就跟随 Harness 默认。 */
function routeFor(ctx, saved) {
  const assistant = saved?.assistant
  if (assistant?.provider && assistant?.model) return { provider: assistant.provider, model: assistant.model }
  return defaultSelection(ctx) ?? null
}

const sessionIdFor = itemId => `session-media-desk-${String(itemId).replace(/[^\w-]/g, '').slice(0, 48)}`

async function openAgent(ctx, itemId, saved, { store, producer }) {
  const existing = agents.get(itemId)
  if (existing) return existing
  const registry = ctx.get('agentPresets')
  const service = ctx.get('agents')
  if (!service || !registry) throw new Error('Harness 里没有 agent 服务')

  const sessionId = sessionIdFor(itemId)
  const route = routeFor(ctx, saved)
  let handle = null
  try {
    handle = await service.resume(sessionId)
  } catch {
    handle = null
  }
  if (!handle) {
    try {
      handle = await service.create({ sessionId, meta: { cwd: process.cwd() }, ...(route ? { agentOptions: route } : {}) })
    } catch (err) {
      // 同 id 的 session 已存在但恢复失败时，换一个新 id，别把用户卡死
      const fallback = `${sessionId}-${Date.now().toString(36)}`
      handle = await service.create({ sessionId: fallback, meta: { cwd: process.cwd() }, ...(route ? { agentOptions: route } : {}) })
    }
  }
  // 第一轮之前才能选 preset；standard = pwsh/文件/web/skill/子 agent 全套
  try {
    const preset = await registry.select(handle.agent, 'standard')
    // 工作台自己的工具挂在 agent 作用域上，只有这个会话看得到
    const toolNames = registerAgentTools({ agentCtx: handle.agent.ctx, store, producer, itemId })
    // 面板里没有审批 UI，ask 会 fail-closed；这些会话统一 never，沙箱仍是 workspace-write
    try {
      ctx.get('approval')?.setPolicy(handle.agent, 'never')
    } catch {
      // 审批服务不支持就按默认走
    }
    const record = { handle, sessionId: handle.agent.id, preset, toolNames }
    agents.set(itemId, record)
    return record
  } catch (err) {
    // 选不上 preset 也要能聊，只是工具少
    const record = { handle, sessionId: handle.agent.id, preset: null, presetError: err.message }
    agents.set(itemId, record)
    return record
  }
}

/** 把一轮的新事件折成给面板看的结果。 */
function readTurn(session) {
  const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : []
  const list = Array.isArray(events) ? events : []
  const assistant = [...list].reverse().find(event => event?.type === 'assistant/message')
  const end = [...list].reverse().find(event => event?.type === 'turn/end')
  const toolNames = []
  for (const event of list) {
    if (event?.type !== 'tool/call') continue
    const name = event?.data?.name
    if (name && !toolNames.includes(name)) toolNames.push(name)
  }
  let text = ''
  const content = assistant?.data?.message?.content
  if (Array.isArray(content)) text = content.filter(part => part?.type === 'text').map(part => part.text).join('\n').trim()
  const reason = end?.data?.reason
  const failed = reason && reason.kind !== 'completed' ? (reason.error?.message ?? '这一轮没跑完') : null
  return { text, toolNames, failed }
}

export function chatState(itemId) {
  return runs.get(itemId) ?? IDLE
}

/**
 * 跑一轮对话：先落用户消息，等 agent 结束，再落助手消息。
 * 立即返回，面板靠 chatState() 轮询。
 */
export function startTurn({ ctx, store, settings, producer, itemId, message, focusId }) {
  if (runs.get(itemId)?.status === 'running') throw Object.assign(new Error('这条还在跑，等它说完'), { status: 429 })
  const run = { status: 'running', startedAt: new Date().toISOString(), error: null, text: '', tools: [] }
  runs.set(itemId, run)

  const task = (async () => {
    const saved = await settings.read().catch(() => null)
    const record = await openAgent(ctx, itemId, saved, { store, producer })
    if (record.presetError) run.presetError = record.presetError
    await record.handle.agent.followup({ content: [{ type: 'text', text: message }], source: { kind: 'user' } })
    await record.handle.agent.whenIdle()
    const turn = readTurn(record.handle.agent.session)
    run.text = turn.text
    run.tools = turn.toolNames
    if (turn.failed) run.error = turn.failed
    await store.mutate('对话（agent）', (draft) => {
      const at = new Date().toISOString()
      const scoped = focusId ?? itemId
      draft.chat.push({ id: newId('c'), at, role: 'user', text: message, itemId: scoped })
      draft.chat.push({
        id: newId('c'), at, role: 'assistant', text: turn.failed ? `这一轮出错了：${turn.failed}` : (turn.text || '（这轮没有文字回复）'),
        receipts: [], errors: turn.failed ? [turn.failed] : [], engine: `agent · ${record.preset ?? 'no-preset'}`, itemId: scoped,
        tools: turn.toolNames,
      })
      return draft
    })
  })().catch(async (err) => {
    run.error = String(err?.message ?? err)
    await store.mutate('对话（agent）', (draft) => {
      const at = new Date().toISOString()
      const scoped = focusId ?? itemId
      draft.chat.push({ id: newId('c'), at, role: 'user', text: message, itemId: scoped })
      draft.chat.push({ id: newId('c'), at, role: 'assistant', text: `这一轮出错了：${run.error}`, receipts: [], errors: [run.error], engine: 'agent', itemId: scoped })
      return draft
    }).catch(() => {})
  }).finally(() => {
    run.status = 'idle'
    run.finishedAt = new Date().toISOString()
  })

  run.done = task
  return run
}
