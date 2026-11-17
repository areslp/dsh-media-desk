// 成稿配图用用户自己的图：op 写入/锁定/解锁，重新成稿不覆盖、不重画。
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { applyOps } from '../src/ops.js'
import { mergeLockedImages, Producer } from '../src/produce.js'
import { buildSeed } from '../src/seed.js'
import { Settings } from '../src/settings.js'
import { Store } from '../src/store.js'

const NOW = new Date('2026-10-31T15:00:00+08:00')
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PLAN = JSON.stringify({
  title: '最终标题',
  cover: 'cover',
  characters: 'a man',
  images: [{ anchor: '第一节', caption: '图注一', prompt: 'fig1' }, { anchor: '第二节', caption: '图注二', prompt: 'fig2' }],
  shots: [{ shot: '特写', visual: '手', voice: '说', seconds: 4, prompt: 's1' }],
})

function withProduction() {
  const state = buildSeed(NOW)
  const item = state.items[0]
  item.production = {
    status: 'done',
    article: '原文',
    cover: null,
    images: [
      { caption: 'AI 图', anchor: '第一节', prompt: 'p', status: 'done', src: 'media-desk/files/g_ai.png' },
    ],
    shots: [],
  }
  return { state, item }
}

test('set_figure：换成自己的图后写入 src 并锁定', () => {
  const { state, item } = withProduction()
  const { errors } = applyOps(state, [{ op: 'set_figure', id: item.id, index: 0, src: 'media-desk/files/f_mine.png' }])
  assert.deepEqual(errors, [])
  const figure = item.production.images[0]
  assert.equal(figure.src, 'media-desk/files/f_mine.png')
  assert.equal(figure.locked, true)
  assert.equal(figure.origin, 'upload')
  assert.equal(figure.status, 'done')
  assert.equal(figure.caption, 'AI 图', '没传图注时保留原图注')
})

test('set_figure：图注可以一起换，最多 60 字', () => {
  const { state, item } = withProduction()
  applyOps(state, [{ op: 'set_figure', id: item.id, index: 0, src: 'media-desk/files/f_mine.png', caption: '  我自己的图  ' }])
  assert.equal(item.production.images[0].caption, '我自己的图')
})

test('set_figure：拒绝非法来源和非图片路径', () => {
  const { state, item } = withProduction()
  for (const src of ['https://example.com/a.png', 'media-desk/assets/x.jpg', '/etc/passwd', 'media-desk/files/../../x.png']) {
    const { errors } = applyOps(state, [{ op: 'set_figure', id: item.id, index: 0, src }])
    assert.equal(errors.length, 1, `${src} 应该被拒绝`)
  }
  assert.equal(item.production.images[0].src, 'media-desk/files/g_ai.png', '被拒绝时不能改动原图')
})

test('set_figure：序号越界报错，缺成稿也报错', () => {
  const { state, item } = withProduction()
  assert.equal(applyOps(state, [{ op: 'set_figure', id: item.id, index: 9, src: 'media-desk/files/f.png' }]).errors.length, 1)
  delete item.production
  assert.equal(applyOps(state, [{ op: 'set_figure', id: item.id, index: 0, src: 'media-desk/files/f.png' }]).errors.length, 1)
})

test('set_figure：src 传 null 解锁，之后可以重画', () => {
  const { state, item } = withProduction()
  applyOps(state, [{ op: 'set_figure', id: item.id, index: 0, src: 'media-desk/files/f_mine.png' }])
  const { errors } = applyOps(state, [{ op: 'set_figure', id: item.id, index: 0, src: null }])
  assert.deepEqual(errors, [])
  const figure = item.production.images[0]
  assert.equal(figure.locked, undefined)
  assert.equal(figure.origin, undefined)
  assert.equal(figure.src, undefined)
  assert.equal(figure.status, 'idle')
  // 本来就没锁的再解锁要报错，避免误以为动过
  assert.equal(applyOps(state, [{ op: 'set_figure', id: item.id, index: 0, src: null }]).errors.length, 1)
})

test('mergeLockedImages：锁定的图回到原位，计划只填其余位置', () => {
  const locked = new Map([[1, { caption: 'mine', src: 'media-desk/files/f.png', locked: true }]])
  const merged = mergeLockedImages([{ caption: 'a' }, { caption: 'b' }, { caption: 'c' }], locked, 'pending')
  assert.equal(merged.length, 3)
  assert.equal(merged[0].caption, 'a')
  assert.equal(merged[0].status, 'pending')
  assert.equal(merged[1].caption, 'mine')
  assert.equal(merged[1].status, 'done')
  assert.equal(merged[2].caption, 'c')
})

test('mergeLockedImages：没有锁定时原样返回计划', () => {
  const merged = mergeLockedImages([{ caption: 'a' }], new Map(), 'pending')
  assert.deepEqual(merged, [{ caption: 'a', status: 'pending' }])
})

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'media-desk-fig-'))
  const store = new Store(dir)
  await store.read()
  const settings = new Settings(dir)
  await settings.update({ imageCount: 3, shotCount: 1, image: { baseUrl: 'https://i.example/v1', model: 'm', apiKey: 'k' } })
  await store.mutate('setup', (draft) => {
    const item = draft.items[0]
    item.production = {
      status: 'done',
      article: '# 旧标题\n\n旧正文',
      cover: null,
      images: [{ caption: '我的图', anchor: '', prompt: '', status: 'done', src: 'media-desk/files/f_mine.png', locked: true, origin: 'upload' }],
      shots: [],
    }
    return draft
  })
  return { dir, store, settings }
}

test('重新成稿：自己的配图留在原位，只重画其他位置', async () => {
  const { dir, store, settings } = await fixture()
  try {
    const generated = []
    const producer = new Producer({
      store,
      settings,
      callText: async ({ system }) => (system.includes('策划案') ? { text: PLAN, model: 'stub' } : { text: '# 新标题\n\n新正文', model: 'stub' }),
      generate: async (_, prompt) => {
        generated.push(prompt)
        return { buffer: PNG, ext: '.png' }
      },
    })
    const id = (await store.read()).items[0].id
    await producer.start(id)
    for (let i = 0; i < 400 && producer.isRunning(id); i += 1) await new Promise(resolve => setTimeout(resolve, 5))

    const production = (await store.read()).items.find(row => row.id === id).production
    assert.equal(production.status, 'done')
    assert.equal(production.images[0].src, 'media-desk/files/f_mine.png', '自己的图不能被顶掉')
    assert.equal(production.images[0].locked, true)
    assert.equal(production.images[0].caption, '我的图')
    assert.equal(production.images.length, 3, '其余位置按计划补齐')
    assert.match(production.images[1].src, /^media-desk\/files\/g_/, '其他位置照常生图')
    assert.equal(production.shots.length, 1)
    // 封面 1 张 + 配图 2 张 + 分镜 1 张 = 4 次生图；自己的那一格没有重画
    assert.equal(generated.length, 4)
    assert.ok(!generated.some(prompt => prompt.includes('mine')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('重画锁定的配图会被拒绝', async () => {
  const { dir, store, settings } = await fixture()
  try {
    const producer = new Producer({ store, settings, callText: async () => ({ text: '', model: 'stub' }), generate: async () => ({ buffer: PNG, ext: '.png' }) })
    const id = (await store.read()).items[0].id
    await assert.rejects(() => producer.regenerate(id, 'image:0'), /解锁/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
