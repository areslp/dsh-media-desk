// 工作台对话的 agent 版：每条灵感挂一个真实的 DSH agent session，借用 Harness 的工具和 skill。
// 面板只管发消息和轮询状态，模型调用、工具、审批、session 日志都由 Harness 负责。
import { defaultSelection } from './ai.js'
import { registerAgentTools } from './agent-tools.js'
import { newId } from './ops.js'

/** 每条灵感一个 agent：itemId -> { handle, sessionId, preset } */
const agents = new Map()
/** 正在跑的回合：itemId -> { status, startedAt, error, tools, text, pending } */
const runs = new Map()
/** 等待用户决定的审批：requestId -> { finish, itemId } */
const approvals = new Map()

const IDLE = { status: 'idle' }
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000

/**
 * 把这个 agent 的审批请求接到面板上：请求挂起，等用户在对话框里点允许/拒绝。
 * @param {object} handle - agents.create 返回的 handle。
 * @param {string} itemId - 面板上的条目 id。
 */
function bridgeApproval(handle, itemId) {
  // prepend：抢在 Harness 自带的审批界面之前拿到请求，否则会被它先接管
  handle.agent.ctx.on('approval/request', async (req, next) => {
    // 没有界面在等（比如面板关了）就交回原链路
    const run = runs.get(itemId)
    if (!run) return next()
    const id = newId('ap')
    const decision = new Promise((resolve) => {
      let settled = false
      const finish = (outcome) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        approvals.delete(id)
        resolve(outcome)
      }
      const timer = setTimeout(() => finish('cancelled'), APPROVAL_TIMEOUT_MS)
      approvals.set(id, { finish, itemId })
      req.signal?.addEventListener('abort', () => finish('cancelled'), { once: true })
    })
    run.pending = {
      id,
      toolName: req.toolName,
      reason: req.reason ?? null,
      displayReason: req.displayReason ?? null,
      at: new Date().toISOString(),
    }
    try {
      return await decision
    } finally {
      if (run.pending?.id === id) run.pending = null
    }
  }, { prepend: true })
}

/** 用户在面板里点了允许/拒绝。 */
export function decideApproval(itemId, requestId, allow) {
  const entry = approvals.get(requestId)
  if (!entry || entry.itemId !== itemId) return false
  entry.finish(allow ? 'allowed-once' : 'rejected')
  return true
}

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

/** 这次插件加载里的 session 后缀：同一个进程内复用，重启后重新开一条，避免 resume 到不在 store 里的旧 session。 */
const LOAD_ID = Date.now().toString(36)
let loadSeq = 0

/** 扔掉一条 agent：dispose 掉，之后重新开。 */
async function dropAgent(itemId) {
  const record = agents.get(itemId)
  if (!record) return
  agents.delete(itemId)
  try {
    await record.handle.dispose()
  } catch {
    // 已经没了就算了
  }
}

/** 插件卸载时把开过的 agent 都收掉。 */
export async function disposeAgents() {
  for (const itemId of [...agents.keys()]) await dropAgent(itemId)
}

/**
 * 按工作台设置给这个 agent 套权限。
 * ask = 沙箱 workspace-write + 敏感操作弹面板卡片；full = full access + 不再询问。
 * @param {object} ctx - 插件上下文。
 * @param {object} agent - agent 句柄。
 * @param {object} saved - 工作台设置。
 */
async function applyPermission(ctx, agent, saved) {
  const full = saved?.agentPermission === 'full'
  const presets = ctx.get('permissionPresets')
  const approval = ctx.get('approval')
  if (presets) {
    try {
      await presets.apply(agent.session, full ? 'danger-full-access' : 'workspace-write', policy => approval?.setPolicy(agent, policy))
      return
    } catch {
      // 预设切不了就只改审批策略
    }
  }
  try {
    approval?.setPolicy(agent, full ? 'never' : 'ask')
  } catch {
    // 审批服务不支持就按默认走
  }
}

async function openAgent(ctx, itemId, saved, { store, producer }) {
  const existing = agents.get(itemId)
  if (existing) return existing
  const registry = ctx.get('agentPresets')
  const service = ctx.get('agents')
  if (!service || !registry) throw new Error('Harness 里没有 agent 服务')

  const route = routeFor(ctx, saved)
  // 每次创建都用没被占用的 id：不再 resume 旧 session，那个 session 可能不在当前 SessionStore 里
  let handle = null
  let forId = null
  for (let attempt = 0; attempt < 3 && !handle; attempt += 1) {
    loadSeq += 1
    forId = `${sessionIdFor(itemId)}-${LOAD_ID}${loadSeq === 1 ? '' : `-${loadSeq}`}`
    try {
      handle = await service.create({ sessionId: forId, meta: { cwd: process.cwd() }, ...(route ? { agentOptions: route } : {}) })
    } catch {
      handle = null
    }
  }
  if (!handle) throw new Error('开不了 agent session')
  // 第一轮之前才能选 preset；standard = pwsh/文件/web/skill/子 agent 全套
  try {
    const preset = await registry.select(handle.agent, 'standard')
    // 工作台自己的工具挂在 agent 作用域上，只有这个会话看得到
    const toolNames = registerAgentTools({ agentCtx: handle.agent.ctx, store, producer, itemId })
    // 审批走面板：请求挂起，用户在对话框里点允许/拒绝
    bridgeApproval(handle, itemId)
    await applyPermission(ctx, handle.agent, saved)
    // 新 session 不继承上一次的记忆：把这条稿子的现状和最近几轮对话重新喂给它
    await seedContext(handle.agent, store, itemId).catch(() => {})
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

/**
 * 把「这条稿件现在是什么样 + 最近聊过什么」注入给新开的 agent，
 * 让它在重载之后仍然接着上下文干活。
 * @param {object} agent - 刚创建的 agent。
 * @param {object} store - 工作台状态。
 * @param {string} itemId - 条目 id。
 */
async function seedContext(agent, store, itemId) {
  const state = await store.read()
  const item = state.items.find(row => row.id === itemId)
  const lines = ['<media-desk-context>', '你在自媒体工作台里，下面是背景资料（不是用户指令）。']
  if (item) {
    const production = item.production
    lines.push(`当前条目：${item.title}（id ${item.id}，状态 ${item.status}${item.tags?.length ? `，标签 ${item.tags.join('、')}` : ''}）`)
    if (item.body) lines.push(`正文：${String(item.body).slice(0, 1200)}`)
    if (production) {
      lines.push(`成稿：${production.title ?? '（无标题）'}，配图 ${(production.images ?? []).length} 张`)
      const figures = (production.images ?? []).map((image, index) => `${index + 1}. ${image.caption || '无图注'}${image.locked ? '（换成自己的图，已锁定）' : ''}`)
      if (figures.length) lines.push(`配图清单：\n${figures.join('\n')}`)
      if (production.article) lines.push(`脚本前 800 字：${String(production.article).slice(0, 800)}`)
    }
  } else {
    // 工作台级对话（不属于某条稿件）：给个条目概览当上下文
    const overview = (state.items ?? []).slice(0, 8).map(row => `- ${row.title}（id ${row.id}，${row.status}）`)
    if (overview.length) lines.push('工作台最近 8 条条目：', ...overview)
  }
  // 工作台级对话的 itemId 是 null（历史数据里可能写成 'wall'），两种都算
  const scopeOf = row => (row.itemId && row.itemId !== 'wall' ? row.itemId : null)
  const want = item ? itemId : null
  const recent = (state.chat ?? []).filter(row => scopeOf(row) === want).slice(-6)
  if (recent.length) {
    lines.push('最近的对话：')
    for (const row of recent) lines.push(`${row.role === 'user' ? '用户' : '你'}：${String(row.text ?? '').replace(/\s+/g, ' ').slice(0, 300)}`)
  }
  lines.push('</media-desk-context>')
  await agent.inject({ id: newId('msg'), content: [{ type: 'text', text: lines.join('\n') }], source: { kind: 'user' } })
}

/** 把一轮的事件折成给面板看的结果（结束时用）。 */
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

/**
 * 跑着的时候给面板看的实时状态：正在调用的工具行 + 已经产出的文字。
 * 直接从 session 事件折出来，避免为了流式再开一条通道。
 * @param {object} session - agent 的 session。
 * @returns {{tools: object[], text: string}}
 */
function readLive(session) {
  const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : []
  const list = Array.isArray(events) ? events : []
  const tools = []
  const byCall = new Map()
  let text = ''
  for (const event of list) {
    if (event?.type === 'tool/call') {
      const row = { id: event.data?.callId ?? '', name: event.data?.name ?? '工具', args: String(event.data?.arguments ?? '').slice(0, 180), status: 'running', result: '' }
      tools.push(row)
      if (row.id) byCall.set(row.id, row)
      continue
    }
    if (event?.type === 'tool/result') {
      const callId = event.data?.toolCallId ?? event.data?.message?.toolCallId
      const row = callId ? byCall.get(callId) : undefined
      if (!row) continue
      const content = event.data?.message?.content
      row.result = Array.isArray(content) ? content.filter(part => part?.type === 'text').map(part => part.text).join('\n').slice(0, 400) : ''
      row.status = event.data?.message?.isError ? 'error' : 'done'
      continue
    }
    if (event?.type === 'assistant/message') {
      const content = event.data?.message?.content
      if (!Array.isArray(content)) continue
      const value = content.filter(part => part?.type === 'text').map(part => part.text).join('\n').trim()
      if (value) text = value
    }
  }
  return { tools: tools.slice(-12), text }
}

export function agentRecordFor(itemId) {
  return agents.get(itemId) ?? null
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
    let record = await openAgent(ctx, itemId, saved, { store, producer })
    if (record.presetError) run.presetError = record.presetError

    // 跑一轮；如果撞上「session 不在 SessionStore 里」这类残留状态，扔掉重开一次
    const runOnce = async () => {
      // 每轮都套一次权限：改了设置不用重载插件也能生效（同预设是 no-op）
      await applyPermission(ctx, record.handle.agent, saved)
      await record.handle.agent.followup({ content: [{ type: 'text', text: message }], source: { kind: 'user' } })
      // 跑的过程中不断刷新可见状态：工具行 + 已产出的文字
      const ticker = setInterval(() => {
        try {
          run.live = readLive(record.handle.agent.session)
        } catch {
          // 读不到就等下一次
        }
      }, 700)
      try {
        await record.handle.agent.whenIdle()
      } finally {
        clearInterval(ticker)
        try {
          run.live = readLive(record.handle.agent.session)
        } catch {
          // 收尾读失败不影响落盘
        }
      }
    }

    try {
      await runOnce()
    } catch (err) {
      const message = String(err?.message ?? err)
      if (!/SessionStore|outside a Session/i.test(message)) throw err
      // 旧的 session 已经不在 store 里：收掉它，换一条新的再试一次
      await dropAgent(itemId)
      record = await openAgent(ctx, itemId, saved, { store, producer })
      if (record.presetError) run.presetError = record.presetError
      await runOnce()
    }

    const turn = readTurn(record.handle.agent.session)
    run.text = turn.text
    run.tools = turn.toolNames
    if (turn.failed) run.error = turn.failed
    await store.mutate('对话（agent）', (draft) => {
      const at = new Date().toISOString()
      // 工作台级对话（没有 focusId）写 null，面板就是按 null 过滤的；写 'wall' 会看不见
      const scoped = focusId ?? null
      const summary = turn.toolNames.length ? `（这一轮只调用了工具，没有文字回复：${turn.toolNames.join('、')}）` : '（这一轮没有文字回复）'
      draft.chat.push({ id: newId('c'), at, role: 'user', text: message, itemId: scoped })
      draft.chat.push({
        id: newId('c'), at, role: 'assistant', text: turn.failed ? `这一轮出错了：${turn.failed}` : (turn.text || summary),
        receipts: [], errors: turn.failed ? [turn.failed] : [], engine: `agent · ${record.preset ?? 'no-preset'}`, itemId: scoped,
        tools: turn.toolNames,
      })
      return draft
    })
  })().catch(async (err) => {
    run.error = String(err?.message ?? err)
    await store.mutate('对话（agent）', (draft) => {
      const at = new Date().toISOString()
      const scoped = focusId ?? null
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
