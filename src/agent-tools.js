// 给工作台里的 agent 注册「自己的工具」：列条目、改条目、加灵感、成稿、换配图。
// 只注册在 agent 自己的作用域（agent.ctx）上，不会漏到别的会话。
import { copyFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join } from 'node:path'
import { applyOps, newId } from './ops.js'

const TEXT = value => [{ type: 'text', text: String(value) }]

/** 参数统一按 JSON Schema 形状给：工具注册表不会替我们包一层 object。 */
const schema = (properties, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}) })

/** 工具定义统一走这个壳：失败也返回文本，让模型自己决定下一步。 */
function tool(name, description, parameters, run) {
  return {
    name,
    description,
    parameters,
    output: { schema: { type: 'string' }, render: (_args, value) => TEXT(value) },
    async execute(args) {
      try {
        return await run(args ?? {})
      } catch (err) {
        return `失败：${err?.message ?? err}`
      }
    },
  }
}

const brief = item => ({
  id: item.id,
  title: item.title,
  kind: item.kind,
  status: item.status,
  tags: item.tags ?? [],
  ...(item.scheduledAt ? { scheduledAt: item.scheduledAt } : {}),
  ...(item.production ? { production: { status: item.production.status, title: item.production.title, figures: (item.production.images ?? []).length } } : {}),
})

/**
 * 把工作台工具挂到一个 agent 上。
 * @param {object} options
 * @param {object} options.agentCtx - agent.ctx，工具只对这个 agent 可见。
 * @param {object} options.store - 工作台的 state store。
 * @param {object} options.producer - 成稿流水线。
 * @param {string} options.itemId - 这条对话所属的条目，工具默认作用在它上面。
 * @param {number} [options.keepFiguresUnlocked] - 预留。
 * @returns {string[]} 注册成功的工具名。
 */
export function registerAgentTools({ agentCtx, store, producer, itemId }) {
  const tools = agentCtx.get('tools')
  if (!tools) return []
  const names = []
  const current = id => id || itemId
  const add = definition => {
    tools.register(definition)
    names.push(definition.name)
  }

  add(tool(
    'media_desk_items',
    '列出自媒体工作台里的条目（灵感/草稿/成稿），可按关键词或状态过滤。返回 id、标题、状态、标签。',
    schema({
      query: { type: 'string', description: '标题/正文关键词，可省略' },
      status: { type: 'string', description: 'idea|outline|draft|ready|published，可省略' },
      limit: { type: 'number', description: '最多返回多少条，默认 20' },
    }),
    async ({ query, status, limit }) => {
      const state = await store.read()
      const needle = String(query ?? '').trim().toLowerCase()
      const rows = state.items
        .filter(item => !status || item.status === status)
        .filter(item => !needle || `${item.title} ${item.body}`.toLowerCase().includes(needle))
        .slice(0, Math.min(Number(limit) || 20, 50))
      return JSON.stringify(rows.map(brief), null, 2)
    },
  ))

  add(tool(
    'media_desk_item',
    '读一条条目的完整内容：正文、标签、成稿的标题/脚本/配图。默认读当前这条。',
    schema({ itemId: { type: 'string', description: '条目 id，省略则读当前这条' } }),
    async ({ itemId: id }) => {
      const state = await store.read()
      const item = state.items.find(row => row.id === current(id))
      if (!item) return `没有找到条目 ${current(id)}`
      const production = item.production
      return JSON.stringify({
        ...brief(item),
        body: item.body,
        production: production ? {
          status: production.status,
          title: production.title,
          article: production.article,
          coverText: production.coverText,
          images: (production.images ?? []).map((image, index) => ({ index, caption: image.caption, src: image.src, status: image.status })),
          shots: (production.shots ?? []).length,
        } : null,
      }, null, 2)
    },
  ))

  add(tool(
    'media_desk_add',
    '在灵感墙上加一条：标题/正文/类型（note|quote|link|image|video）/标签。',
    schema({
      title: { type: 'string', description: '标题，可省略，会用正文首句' },
      body: { type: 'string', description: '正文' },
      kind: { type: 'string', description: 'note|quote|link|image|video，默认 note' },
      tags: { type: 'array', description: '标签数组', items: { type: 'string' } },
    }),
    async ({ title, body, kind, tags }) => {
      if (!title && !body) return '失败：标题和正文至少给一个'
      const ops = [{ op: 'add_item', kind: kind || 'note', title: title ?? '', body: body ?? '', tags: Array.isArray(tags) ? tags : [] }]
      const result = await store.mutate('agent：加灵感', draft => ({ ...applyOps(draft, ops), state: draft }))
      if (result.errors.length) return `失败：${result.errors.join('；')}`
      const created = result.state.items[0]
      return `已加一条：${created.title}（id ${created.id}）`
    },
  ))

  add(tool(
    'media_desk_update',
    '改一条条目的字段（标题/正文/标签/状态）。默认改当前这条。',
    schema({
      itemId: { type: 'string', description: '条目 id，省略则改当前这条' },
      title: { type: 'string', description: '新标题' },
      body: { type: 'string', description: '新正文' },
      tags: { type: 'array', description: '新标签数组', items: { type: 'string' } },
      status: { type: 'string', description: 'idea|outline|draft|ready|published' },
    }),
    async ({ itemId: id, ...fields }) => {
      const target = current(id)
      const patch = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== null))
      if (!Object.keys(patch).length) return '失败：没有要改的字段'
      const result = await store.mutate('agent：改条目', draft => ({ ...applyOps(draft, [{ op: 'update_item', id: target, ...patch }]), state: draft }))
      if (result.errors.length) return `失败：${result.errors.join('；')}`
      return `已更新 ${target}：${Object.keys(patch).join('、')}`
    },
  ))

  add(tool(
    'media_desk_produce',
    '给一条已有正文的条目跑「一键成稿」：生成标题、脚本、封面、配图和分镜。默认跑当前这条。',
    schema({ itemId: { type: 'string', description: '条目 id，省略则跑当前这条' } }),
    async ({ itemId: id }) => {
      const target = current(id)
      const started = await producer.start(target)
      return started ? `已开始成稿：${target}（进度可在面板里看）` : `失败：${target} 已经在成稿中`
    },
  ))

  add(tool(
    'media_desk_set_figure',
    '把成稿某一张配图换成指定的图片文件，并锁定它（重新成稿不会覆盖）。src 支持 media-desk/files/xxx.png 或本机绝对路径；本机文件会被复制进工作台。',
    schema({
      itemId: { type: 'string', description: '条目 id，省略则改当前这条' },
      index: { type: 'number', description: '第几张配图，从 0 开始' },
      src: { type: 'string', description: '图片来源：media-desk/files/... 或绝对路径' },
      caption: { type: 'string', description: '顺手改图注，可省略' },
    }, ['index', 'src']),
    async ({ itemId: id, index, src, caption }) => {
      const target = current(id)
      let value = String(src ?? '').trim()
      if (!value) return '失败：要给 src'
      if (!/^media-desk\/files\//.test(value)) {
        if (!isAbsolute(value)) return '失败：src 要么是 media-desk/files/...，要么是绝对路径'
        const ext = extname(value).toLowerCase()
        if (!['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) return '失败：只支持 png/jpg/webp/gif'
        const name = `f_${newId('a')}${ext}`
        await copyFile(value, join(store.filesDir, name))
        value = `media-desk/files/${name}`
      }
      const op = { op: 'set_figure', id: target, index: Number(index), src: value, ...(caption ? { caption: String(caption) } : {}) }
      const result = await store.mutate('agent：换配图', draft => ({ ...applyOps(draft, [op]), state: draft }))
      if (result.errors.length) return `失败：${result.errors.join('；')}`
      return `已把 ${target} 的第 ${Number(index) + 1} 张配图换成 ${basename(value)}（已锁定）`
    },
  ))

  return names
}
