/**
 * lib/state.mjs 的 §11 扩展测试：description / tags 必须能写盘、读回、截断、去重，
 * 且旧 state.json（没有这两个字段）仍然可读。临时目录用 os.tmpdir()，不写 workspace。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStateStore, normalizeState } from '../lib/state.mjs'

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'sendcomfy-state-'))
  try {
    const store = createStateStore({ dir })
    await fn({ store, dir })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function record(overrides = {}) {
  return {
    id: 'flow-abc123',
    name: '示例工作流',
    source: 'ui',
    apiGraph: { 1: { class_type: 'SaveImage', inputs: {} } },
    nodes: [{ id: '1', class: 'SaveImage' }],
    params: [],
    promptTargets: { positive: [], negative: [] },
    createdAt: '2026-11-16T00:00:00.000Z',
    updatedAt: '2026-11-16T00:00:00.000Z',
    ...overrides,
  }
}

test('description / tags 写盘后读回仍在（§11.1）', async () => {
  await withStore(async ({ store }) => {
    await store.write({
      baseUrl: 'http://127.0.0.1:8188',
      timeoutSec: 300,
      clientId: 'dsh-sendcomfy-test',
      workflows: [record({ description: '画二次元头像的工作流', tags: ['二次元', '头像'] })],
      lastRuns: [],
    })
    const state = await store.read()
    assert.equal(state.workflows.length, 1)
    assert.equal(state.workflows[0].description, '画二次元头像的工作流')
    assert.deepEqual(state.workflows[0].tags, ['二次元', '头像'])
  })
})

test('description 超 500 字被截断；tags 去空/去重/截断到 12 个', async () => {
  await withStore(async ({ store }) => {
    const longDescription = '长'.repeat(700)
    const tags = ['  a  ', '', 'a', 'b', ...Array.from({ length: 20 }, (_, index) => 'tag-' + index)]
    await store.write({
      baseUrl: 'http://127.0.0.1:8188',
      timeoutSec: 300,
      clientId: 'dsh-sendcomfy-test',
      workflows: [record({ description: longDescription, tags })],
      lastRuns: [],
    })
    const state = await store.read()
    assert.equal(state.workflows[0].description.length, 500)
    assert.ok(state.workflows[0].tags.length <= 12)
    assert.equal(state.workflows[0].tags[0], 'a')
    assert.equal(new Set(state.workflows[0].tags).size, state.workflows[0].tags.length)
  })
})

test('旧 state.json（无 description/tags）可正常读取', async () => {
  await withStore(async ({ store, dir }) => {
    const legacy = {
      baseUrl: 'http://127.0.0.1:8188',
      timeoutSec: 300,
      clientId: 'dsh-sendcomfy-test',
      workflows: [record()],
      lastRuns: [],
    }
    await store.write(legacy)
    const raw = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
    assert.equal(raw.workflows[0].description, undefined)
    assert.equal(raw.workflows[0].tags, undefined)
    const state = await store.read()
    assert.equal(state.workflows[0].description, undefined)
    assert.equal(state.workflows[0].tags, undefined)
  })
})

test('normalizeState 保留未知字段的默认行为不变（顶层只保留白名单）', () => {
  const normalized = normalizeState({ baseUrl: 'x', workflows: [record({ description: '  hi  ', tags: [' t ', 't', ''] })] })
  assert.equal(normalized.workflows[0].description, 'hi')
  assert.deepEqual(normalized.workflows[0].tags, ['t'])
})
