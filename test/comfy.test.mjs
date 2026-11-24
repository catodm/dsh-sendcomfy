/**
 * dsh-sendcomfy — lib/comfy.mjs + lib/state.mjs 单元测试
 *
 * 运行（环境坑见 CONTRACT.md §10：node 不能用包目录当 cwd，必须在 /tmp 下用绝对路径）：
 *   bash { workdir: "/tmp", command:
 *     "node --test <本仓库目录>/test/comfy.test.mjs" }
 *
 * 临时文件一律写 os.tmpdir()/mkdtemp（从 /tmp 看 workspace 是只读的 EROFS）。
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { startMockComfy } from './mock-comfy.mjs'
import { gzipSync } from 'node:zlib'

import {
  DEFAULT_BASE_URL,
  ComfyError,
  normalizeBaseUrl,
  request,
  ping,
  getObjectInfo,
  invalidateObjectInfo,
  listModels,
  queuePrompt,
  getHistory,
  waitForPrompt,
  getQueue,
  interrupt,
  deleteQueued,
  clearQueue,
  fetchImage,
  uploadImage,
  listUserdataWorkflows,
  getUserdataWorkflow,
} from '../lib/comfy.mjs'
import {
  dataDir,
  defaultState,
  normalizeState,
  makeWorkflowId,
  createStateStore,
} from '../lib/state.mjs'

let TMP_ROOT

before(async () => {
  TMP_ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-sendcomfy-test-'))
})

after(async () => {
  if (TMP_ROOT) await fsp.rm(TMP_ROOT, { recursive: true, force: true })
})

function tmpDir(name) {
  const dir = path.join(TMP_ROOT, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}


/** 一份 UI 格式小样（带 nodes 数组），用于 userdata 读取类测试。 */
function loadUiFixture() {
  return {
    nodes: [
      { id: 1, type: 'CLIPTextEncode', mode: 0, inputs: [], outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [] }], widgets_values: ['a cat'] },
      { id: 2, type: 'SaveImage', mode: 0, inputs: [{ name: 'images', type: 'IMAGE', link: null }], outputs: [], widgets_values: ['x'] },
    ],
    links: [],
    groups: [],
    config: {},
    extra: {},
    version: 0.4,
  }
}

async function withMock(fn) {
  const mock = await startMockComfy()
  try {
    return await fn(mock)
  } finally {
    await mock.close()
  }
}

// ===========================================================================
// normalizeBaseUrl
// ===========================================================================

test('normalizeBaseUrl: 各种输入规范化', () => {
  assert.equal(normalizeBaseUrl(), DEFAULT_BASE_URL)
  assert.equal(normalizeBaseUrl(undefined), DEFAULT_BASE_URL)
  assert.equal(normalizeBaseUrl(null), DEFAULT_BASE_URL)
  assert.equal(normalizeBaseUrl('127.0.0.1:8188'), 'http://127.0.0.1:8188')
  assert.equal(normalizeBaseUrl('127.0.0.1'), 'http://127.0.0.1:8188')
  assert.equal(normalizeBaseUrl('192.168.1.5'), 'http://192.168.1.5:8188')
  assert.equal(normalizeBaseUrl('localhost'), 'http://localhost:8188')
  assert.equal(normalizeBaseUrl('127.0.0.1:9000'), 'http://127.0.0.1:9000')
  assert.equal(normalizeBaseUrl('http://host:8188/'), 'http://host:8188')
  assert.equal(normalizeBaseUrl('http://host:8188///'), 'http://host:8188')
  assert.equal(normalizeBaseUrl('  http://host:8188/  '), 'http://host:8188')
  assert.equal(normalizeBaseUrl('https://example.com'), 'https://example.com:8188')
  assert.equal(normalizeBaseUrl('HTTP://Host:8188'), 'http://Host:8188')
  assert.equal(normalizeBaseUrl('http://host:80'), 'http://host:80')
  assert.equal(normalizeBaseUrl('[::1]'), 'http://[::1]:8188')
  assert.equal(normalizeBaseUrl('[::1]:9000'), 'http://[::1]:9000')
})

test('normalizeBaseUrl: 非法输入抛 EINVALID_URL', () => {
  const bads = [
    '',
    '   ',
    'not a url',
    'http://ho st:8188',
    'ftp://host:8188',
    'http://host:abc',
    'http://host:70000',
    'http://',
    123,
  ]
  for (const bad of bads) {
    assert.throws(
      () => normalizeBaseUrl(bad),
      (err) => {
        assert.equal(err.code, 'EINVALID_URL', `输入 ${JSON.stringify(bad)} 的 code`)
        return true
      },
      `输入 ${JSON.stringify(bad)} 应抛错`,
    )
  }
})

test('ComfyError: 形状与 toJSON', () => {
  const err = new ComfyError('boom', { code: 'EHTTP', status: 500, detail: 'x' })
  assert.ok(err instanceof Error)
  assert.equal(err.name, 'ComfyError')
  assert.equal(err.message, 'boom')
  assert.equal(err.code, 'EHTTP')
  assert.equal(err.status, 500)
  assert.equal(err.detail, 'x')
  assert.deepEqual(err.toJSON(), { name: 'ComfyError', code: 'EHTTP', message: 'boom', status: 500, detail: 'x' })
})

// ===========================================================================
// request
// ===========================================================================

test('request: 成功 / JSON body / headers / 非 2xx -> EHTTP', async () => {
  await withMock(async (mock) => {
    const res = await request(mock.url, '/system_stats')
    assert.equal(res.status, 200)
    assert.equal(res.json.system.comfyui_version, '0.3.0-mock')
    assert.equal(typeof res.text, 'string')

    const post = await request(mock.url, '/queue', { method: 'POST', body: { clear: true } })
    assert.equal(post.status, 200)
    const record = mock.requests.find((item) => item.method === 'POST' && item.path === '/queue')
    assert.ok(record)
    assert.deepEqual(record.body, { clear: true })
    assert.deepEqual(record.json, { clear: true })
    assert.match(String(record.headers['content-type']), /application\/json/)

    await request(mock.url, '/object_info', { headers: { 'x-test': 'yes' } })
    const withHeader = mock.requests.find((item) => item.path === '/object_info')
    assert.equal(withHeader.headers['x-test'], 'yes')

    await assert.rejects(
      () => request(mock.url, '/definitely-not-a-route'),
      (err) => {
        assert.ok(err instanceof ComfyError)
        assert.equal(err.code, 'EHTTP')
        assert.equal(err.status, 404)
        assert.equal(typeof err.detail, 'string')
        return true
      },
    )

    await assert.rejects(
      () => request('', '/system_stats'),
      (err) => {
        assert.equal(err.code, 'EINVALID_URL')
        return true
      },
    )
  })
})

test('request: 超时 -> ETIMEDOUT', async () => {
  await withMock(async (mock) => {
    mock.delayRoute('/system_stats', 400)
    await assert.rejects(
      () => request(mock.url, '/system_stats', { timeoutMs: 80 }),
      (err) => {
        assert.ok(err instanceof ComfyError)
        assert.equal(err.code, 'ETIMEDOUT')
        return true
      },
    )
  })
})

test('request: 连接不上 -> ENET', async () => {
  const mock = await startMockComfy()
  const deadUrl = mock.url
  await mock.close()
  await assert.rejects(
    () => request(deadUrl, '/system_stats', { timeoutMs: 2000 }),
    (err) => {
      assert.ok(err instanceof ComfyError)
      assert.equal(err.code, 'ENET')
      assert.equal(typeof err.detail, 'string')
      return true
    },
  )
})

// ===========================================================================
// ping
// ===========================================================================

test('ping: 成功与失败（永不抛错）', async () => {
  await withMock(async (mock) => {
    const ok = await ping(mock.url)
    assert.equal(ok.ok, true)
    assert.equal(ok.baseUrl, mock.url)
    assert.ok(ok.latencyMs >= 0)
    assert.equal(ok.comfyuiVersion, '0.3.0-mock')
    assert.match(String(ok.device), /Mock GPU/)
    assert.equal(ok.system.os, 'posix')

    mock.failNextRoute('/system_stats')
    const failed = await ping(mock.url)
    assert.equal(failed.ok, false)
    assert.equal(failed.baseUrl, mock.url)
    assert.equal(typeof failed.error, 'string')
    assert.match(failed.error, /500/)
  })

  const invalid = await ping('')
  assert.equal(invalid.ok, false)
  assert.equal(typeof invalid.error, 'string')

  const unreachable = await ping('http://127.0.0.1:1', { timeoutMs: 1000 })
  assert.equal(unreachable.ok, false)
  assert.equal(typeof unreachable.error, 'string')
})

// ===========================================================================
// getObjectInfo / listModels
// ===========================================================================

test('getObjectInfo: 60s 缓存 / refresh / invalidate', async () => {
  await withMock(async (mock) => {
    const count = () => mock.requests.filter((item) => item.path === '/object_info').length

    const first = await getObjectInfo(mock.url)
    const second = await getObjectInfo(mock.url)
    assert.equal(count(), 1)
    assert.equal(first, second) // 命中缓存返回同一对象

    await getObjectInfo(mock.url, { refresh: true })
    assert.equal(count(), 2)

    invalidateObjectInfo(mock.url)
    await getObjectInfo(mock.url)
    assert.equal(count(), 3)

    invalidateObjectInfo() // 不给 baseUrl 清全部
    await getObjectInfo(mock.url)
    assert.equal(count(), 4)
  })
})

test('getObjectInfo: 失败抛 ComfyError', async () => {
  await withMock(async (mock) => {
    mock.failNextRoute('/object_info')
    await assert.rejects(
      () => getObjectInfo(mock.url),
      (err) => {
        assert.ok(err instanceof ComfyError)
        assert.equal(err.code, 'EHTTP')
        return true
      },
    )
  })
})

test('listModels: 分类抽取 / 排序去重 / 不混入非模型枚举 / other 兜底', async () => {
  await withMock(async (mock) => {
    const models = await listModels(mock.url)
    assert.equal(models.ok, true)
    assert.equal(models.baseUrl, mock.url)

    const byId = Object.fromEntries(models.categories.map((category) => [category.id, category]))
    const expectedIds = [
      'checkpoints', 'loras', 'vae', 'clip', 'unet', 'controlnet', 'upscale',
      'clip_vision', 'style_models', 'embeddings', 'ipadapter', 'gligen', 'other',
    ]
    for (const id of expectedIds) assert.ok(byId[id], `缺类别 ${id}`)
    assert.equal(byId.checkpoints.label, 'Checkpoints')
    assert.equal(byId.loras.label, 'LoRAs')
    assert.equal(byId.unet.label, 'UNET/Diffusion')
    assert.equal(byId.style_models.label, 'Style models')

    assert.deepEqual(byId.checkpoints.files, ['sd_xl_base_1.0.safetensors', 'v1-5-pruned-emaonly.safetensors'])
    assert.ok(byId.loras.files.includes('add_detail.safetensors'))
    assert.ok(byId.loras.files.includes('style_xl.safetensors'))
    assert.ok(byId.vae.files.includes('vae-ft-mse-840000-ema-pruned.safetensors'))
    assert.ok(byId.clip.files.includes('clip_l.safetensors'))
    assert.ok(byId.clip.files.includes('t5xxl_fp16.safetensors'))
    assert.ok(byId.unet.files.includes('flux1-dev.safetensors'))
    assert.ok(byId.controlnet.files.includes('control_v11p_sd15_canny.pth'))
    assert.ok(byId.upscale.files.includes('4x-UltraSharp.pth'))
    assert.ok(byId.clip_vision.files.includes('clip_vision_h.safetensors'))
    assert.ok(byId.style_models.files.includes('style_flux.safetensors'))
    assert.ok(byId.ipadapter.files.includes('ip-adapter_sd15.safetensors'))
    assert.ok(byId.gligen.files.includes('gligen_sd14_textbox_pruned.safetensors'))
    assert.equal(byId.embeddings.count, 0)

    // 非模型枚举（sampler/scheduler/CLIP type）不能混入
    const allFiles = models.categories.flatMap((category) => category.files)
    for (const forbidden of ['euler', 'normal', 'stable_diffusion', 'flux']) {
      assert.ok(!allFiles.includes(forbidden), `不应包含非模型枚举 ${forbidden}`)
    }
    // files 已排序、无重复
    for (const category of models.categories) {
      assert.deepEqual(category.files, [...category.files].sort((a, b) => a.localeCompare(b)))
      assert.equal(new Set(category.files).size, category.files.length)
    }
    assert.equal(models.total, models.categories.reduce((sum, category) => sum + category.count, 0))

    // 兜底：未知节点类的模型文件枚举 -> other
    mock.setObjectInfo({
      MyCustomLoader: {
        name: 'MyCustomLoader',
        input: { required: { custom_file: [['custom_thing.ckpt'], {}] } },
      },
    })
    const withOther = await listModels(mock.url, { refresh: true })
    const other = withOther.categories.find((category) => category.id === 'other')
    assert.ok(other.files.includes('custom_thing.ckpt'))
  })
})

test('listModels: 服务器不可达 -> ok:false 不抛', async () => {
  const mock = await startMockComfy()
  const deadUrl = mock.url
  await mock.close()
  const result = await listModels(deadUrl)
  assert.equal(result.ok, false)
  assert.equal(typeof result.error, 'string')
  assert.equal(result.categories.length, 13)
  assert.equal(result.total, 0)
  assert.ok(result.categories.every((category) => category.files.length === 0))
})

// ===========================================================================
// queuePrompt / getHistory / waitForPrompt
// ===========================================================================

test('queuePrompt + waitForPrompt: 完成态 done', async () => {
  await withMock(async (mock) => {
    const graph = { 3: { class_type: 'KSampler', inputs: { seed: 1 } } }
    mock.setHistory({
      status: { status_str: 'success', completed: true, messages: [] },
      outputs: { 9: { images: [{ filename: 'done.png', subfolder: '', type: 'output' }] } },
    })

    const queued = await queuePrompt(mock.url, graph, { clientId: 'test-client' })
    assert.match(queued.promptId, /^mock-\d+$/)
    assert.equal(queued.number, 1)
    assert.equal(queued.nodeErrors, undefined)

    const record = mock.requests.find((item) => item.method === 'POST' && item.path === '/prompt')
    assert.deepEqual(record.body.prompt, graph)
    assert.equal(record.body.client_id, 'test-client')
    assert.deepEqual(mock.state.prompts[0], { prompt: graph, client_id: 'test-client' })

    const waited = await waitForPrompt(mock.url, queued.promptId, { timeoutMs: 3000, pollMs: 20 })
    assert.equal(waited.state, 'done')
    assert.equal(waited.entry.prompt_id, queued.promptId)
    assert.equal(waited.entry.outputs[9].images[0].filename, 'done.png')

    const history = await getHistory(mock.url, queued.promptId)
    assert.equal(history.prompt_id, queued.promptId)
  })
})

test('getHistory: 默认「还在跑」返回 null', async () => {
  await withMock(async (mock) => {
    const queued = await queuePrompt(mock.url, { 1: { class_type: 'X', inputs: {} } })
    assert.equal(await getHistory(mock.url, queued.promptId), null)
    assert.equal(await getHistory(mock.url, 'never-existed'), null)
  })
})

test('waitForPrompt: error 取 status.messages 的 execution_error.message', async () => {
  await withMock(async (mock) => {
    mock.setHistory({
      status: {
        status_str: 'error',
        completed: false,
        messages: [['execution_error', { message: 'CUDA out of memory', node_id: '3' }]],
      },
    })
    const queued = await queuePrompt(mock.url, { 3: { class_type: 'KSampler', inputs: {} } })
    const waited = await waitForPrompt(mock.url, queued.promptId, { timeoutMs: 3000, pollMs: 20 })
    assert.equal(waited.state, 'error')
    assert.equal(waited.error, 'CUDA out of memory')
    assert.ok(waited.entry)
  })
})

test('waitForPrompt: 无 history -> timeout（不抛）', async () => {
  await withMock(async (mock) => {
    const queued = await queuePrompt(mock.url, { 1: { class_type: 'X', inputs: {} } })
    const started = Date.now()
    const waited = await waitForPrompt(mock.url, queued.promptId, { timeoutMs: 250, pollMs: 30 })
    assert.equal(waited.state, 'timeout')
    assert.ok(Date.now() - started >= 200, '至少等满 timeoutMs')
  })
})

test('waitForPrompt: signal aborted -> 抛 AbortError', async () => {
  await withMock(async (mock) => {
    const queued = await queuePrompt(mock.url, { 1: { class_type: 'X', inputs: {} } })
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      () => waitForPrompt(mock.url, queued.promptId, { timeoutMs: 2000, pollMs: 20, signal: controller.signal }),
      (err) => {
        assert.equal(err.name, 'AbortError')
        return true
      },
    )
  })
})

test('queuePrompt: node_errors 非空照常返回', async () => {
  await withMock(async (mock) => {
    const nodeErrors = { 3: { errors: [{ message: 'invalid input', type: 'invalid_input' }] } }
    mock.setNodeErrors(nodeErrors)
    const queued = await queuePrompt(mock.url, { 3: { class_type: 'KSampler', inputs: {} } })
    assert.deepEqual(queued.nodeErrors, nodeErrors)

    mock.setNodeErrors({})
    const clean = await queuePrompt(mock.url, { 3: { class_type: 'KSampler', inputs: {} } })
    assert.equal(clean.nodeErrors, undefined)
  })
})

// ===========================================================================
// queue / interrupt
// ===========================================================================

test('getQueue / interrupt / deleteQueued / clearQueue', async () => {
  await withMock(async (mock) => {
    mock.setQueue({
      running: [[0, 'p-running', {}, {}, []]],
      pending: [[1, 'p-pending', {}, {}, []]],
    })
    const queue = await getQueue(mock.url)
    assert.equal(queue.running.length, 1)
    assert.equal(queue.running[0].prompt_id, 'p-running')
    assert.equal(queue.pending.length, 1)
    assert.equal(queue.pending[0].prompt_id, 'p-pending')

    assert.deepEqual(await interrupt(mock.url, 'p-running'), { ok: true })
    assert.deepEqual(mock.state.interrupts.at(-1), { prompt_id: 'p-running' })
    const interruptRecord = mock.requests.find((item) => item.method === 'POST' && item.path === '/interrupt')
    assert.deepEqual(interruptRecord.body, { prompt_id: 'p-running' })

    assert.deepEqual(await deleteQueued(mock.url, ['p-pending']), { ok: true })
    assert.deepEqual(mock.state.queueOps.at(-1), { delete: ['p-pending'] })
    assert.equal(mock.state.queuePending.length, 0)

    assert.deepEqual(await clearQueue(mock.url), { ok: true })
    assert.deepEqual(mock.state.queueOps.at(-1), { clear: true })
    assert.equal(mock.state.queueRunning.length, 0)

    assert.deepEqual(await interrupt(mock.url), { ok: true })
    assert.deepEqual(mock.state.interrupts.at(-1), {})
  })
})

// ===========================================================================
// fetchImage / uploadImage
// ===========================================================================

test('fetchImage: 返回 Buffer 与 contentType', async () => {
  await withMock(async (mock) => {
    const image = await fetchImage(mock.url, { filename: 'mock.png', subfolder: '', type: 'output' })
    assert.ok(Buffer.isBuffer(image.buffer))
    assert.ok(image.buffer.length > 0)
    assert.equal(image.buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    assert.equal(image.contentType, 'image/png')

    const record = mock.requests.find((item) => item.path === '/view')
    assert.equal(record.query.filename, 'mock.png')
    assert.equal(record.query.type, 'output')

    await assert.rejects(
      () => fetchImage(mock.url, {}),
      (err) => {
        assert.equal(err.code, 'EINVALID_ARG')
        return true
      },
    )

    mock.failNextRoute('/view')
    await assert.rejects(
      () => fetchImage(mock.url, { filename: 'x.png' }),
      (err) => {
        assert.equal(err.code, 'EHTTP')
        return true
      },
    )
  })
})

test('uploadImage: multipart 上传并返回 {name, subfolder, type}', async () => {
  await withMock(async (mock) => {
    const data = Buffer.from('fake image bytes')
    const uploaded = await uploadImage(mock.url, { data, filename: 'test.png' })
    assert.deepEqual(uploaded, { name: 'test.png', subfolder: '', type: 'input' })
    assert.equal(mock.state.uploads.length, 1)

    const record = mock.requests.find((item) => item.path === '/upload/image')
    assert.match(String(record.headers['content-type']), /^multipart\/form-data; boundary=/)
    assert.match(String(record.body), /filename="test\.png"/)
    assert.match(String(record.body), /name="type"\r\n\r\ninput/)

    await assert.rejects(
      () => uploadImage(mock.url, {}),
      (err) => {
        assert.equal(err.code, 'EINVALID_ARG')
        return true
      },
    )
  })
})

// ===========================================================================
// listUserdataWorkflows / getUserdataWorkflow
// ===========================================================================

test('listUserdataWorkflows: 默认列表 / 过滤非 json / 404 降级', async () => {
  await withMock(async (mock) => {
    const listed = await listUserdataWorkflows(mock.url)
    assert.equal(listed.ok, true)
    assert.equal(listed.items.length, 1)
    assert.equal(listed.items[0].path, 'default.json')
    assert.equal(listed.items[0].name, 'default')
    assert.equal(listed.items[0].size, 123)
    assert.equal(listed.items[0].modified, 1700000000)

    mock.setUserdataWorkflows([
      { path: 'default.json', size: 1, modified: 1700000000 },
      'sdxl/portrait.json',
      { path: 'notes.txt', size: 2 },
    ])
    const custom = await listUserdataWorkflows(mock.url)
    assert.equal(custom.ok, true)
    assert.equal(custom.items.length, 2)
    assert.ok(custom.items.every((item) => item.path.endsWith('.json')))
    assert.ok(custom.items.some((item) => item.path === 'sdxl/portrait.json' && item.name === 'portrait'))
  })

  // 旧版 ComfyUI：/userdata 404 -> ok:false 不抛
  await withMock(async (mock) => {
    mock.userdataUnavailable = true
    assert.equal(mock.state.userdataUnavailable, true)
    const listed = await listUserdataWorkflows(mock.url)
    assert.equal(listed.ok, false)
    assert.equal(typeof listed.error, 'string')
    assert.match(listed.error, /404/)
    assert.deepEqual(listed.items, [])
  })

  // 网络不可达 -> ok:false 不抛
  const dead = await startMockComfy()
  const deadUrl = dead.url
  await dead.close()
  const netFail = await listUserdataWorkflows(deadUrl)
  assert.equal(netFail.ok, false)
  assert.equal(typeof netFail.error, 'string')
})

test('getUserdataWorkflow: 读取内容 / 404 抛 EHTTP', async () => {
  await withMock(async (mock) => {
    const workflow = await getUserdataWorkflow(mock.url, 'default.json')
    assert.equal(typeof workflow, 'object')
    assert.equal(workflow['3'].class_type, 'KSampler')

    await assert.rejects(
      () => getUserdataWorkflow(mock.url, 'missing.json'),
      (err) => {
        assert.ok(err instanceof ComfyError)
        assert.equal(err.code, 'EHTTP')
        assert.equal(err.status, 404)
        return true
      },
    )
  })
})

// ===========================================================================
// lib/state.mjs
// ===========================================================================

test('defaultState / makeWorkflowId', () => {
  const state = defaultState()
  assert.equal(state.baseUrl, DEFAULT_BASE_URL)
  assert.equal(state.timeoutSec, 300)
  assert.match(state.clientId, /^dsh-sendcomfy-[0-9a-f]{12}$/)
  assert.deepEqual(state.workflows, [])
  assert.deepEqual(state.lastRuns, [])

  const id = makeWorkflowId('My Flow!!')
  assert.match(id, /^my-flow-[0-9a-f]{6}$/)
  assert.match(makeWorkflowId('中文名字'), /^workflow-[0-9a-f]{6}$/)
  assert.equal(new Set([makeWorkflowId('a'), makeWorkflowId('a')]).size, 2)
})

test('normalizeState: 非法字段回默认 / clamp / 去重 / 截断', () => {
  const invalid = normalizeState({
    baseUrl: 'ftp://nope',
    timeoutSec: 'abc',
    clientId: '',
    workflows: 'nope',
    lastRuns: null,
  })
  assert.equal(invalid.baseUrl, DEFAULT_BASE_URL)
  assert.equal(invalid.timeoutSec, 300)
  assert.match(invalid.clientId, /^dsh-sendcomfy-[0-9a-f]{12}$/)
  assert.deepEqual(invalid.workflows, [])
  assert.deepEqual(invalid.lastRuns, [])

  assert.equal(normalizeState({}).timeoutSec, 300)
  assert.equal(normalizeState({ timeoutSec: 1 }).timeoutSec, 5)
  assert.equal(normalizeState({ timeoutSec: 999999 }).timeoutSec, 3600)
  assert.equal(normalizeState({ timeoutSec: 42.6 }).timeoutSec, 43)
  assert.equal(normalizeState({ clientId: 'dsh-sendcomfy-keepme' }).clientId, 'dsh-sendcomfy-keepme')
  assert.equal(normalizeState({ baseUrl: '192.168.1.7' }).baseUrl, 'http://192.168.1.7:8188')

  const workflow = (i) => ({
    id: `wf-${i}`,
    name: `w${i}`,
    source: 'api',
    apiGraph: {},
    nodes: [],
    params: [],
    promptTargets: { positive: [], negative: [] },
  })
  const workflows = []
  for (let i = 0; i < 105; i += 1) workflows.push(workflow(i))
  workflows.splice(50, 0, workflow(3)) // 后出现的 id 冲突 -> 丢旧
  const runs = []
  for (let i = 0; i < 25; i += 1) runs.push({ promptId: `p-${i}`, workflowName: 'w', state: 'done' })

  const normalized = normalizeState({ workflows, lastRuns: runs })
  assert.equal(normalized.workflows.length, 100)
  assert.equal(new Set(normalized.workflows.map((item) => item.id)).size, 100)
  assert.equal(normalized.lastRuns.length, 20)

  const semi = normalizeState({
    workflows: [{
      id: 'x-1',
      name: 'n',
      source: 'bogus',
      apiGraph: {},
      nodes: [{ id: 1, class: 'KSampler' }, null],
      params: [
        { path: '3.text', inputName: 'text', type: 'string', value: 'hi', multiline: true },
        { nodeId: 6 },
        null,
      ],
      promptTargets: { positive: ['3.text'], negative: [] },
    }],
  })
  assert.equal(semi.workflows.length, 1)
  const record = semi.workflows[0]
  assert.equal(record.source, 'api')
  assert.equal(record.nodes.length, 1)
  assert.equal(record.nodes[0].id, '1')
  assert.equal(record.params.length, 1)
  assert.equal(record.params[0].path, '3.text')
  assert.equal(record.params[0].type, 'string')
  assert.equal(record.params[0].multiline, true)
})

test('dataDir: $DSH_HOME/sendcomfy 且目录存在', () => {
  const previous = process.env.DSH_HOME
  const home = path.join(TMP_ROOT, 'dsh-home')
  process.env.DSH_HOME = home
  try {
    const dir = dataDir()
    assert.equal(dir, path.join(home, 'sendcomfy'))
    assert.ok(fs.statSync(dir).isDirectory())
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('createStateStore: 默认 State / 原子写 / clientId 持久', async () => {
  const dir = tmpDir('store-basic')
  const store = createStateStore({ dir })

  const first = await store.read()
  assert.equal(first.baseUrl, DEFAULT_BASE_URL)
  assert.equal(first.timeoutSec, 300)
  assert.match(first.clientId, /^dsh-sendcomfy-[0-9a-f]{12}$/)
  assert.deepEqual(first.workflows, [])
  assert.deepEqual(first.lastRuns, [])
  assert.equal(fs.existsSync(path.join(dir, 'state.json')), false)

  const written = await store.write({ ...first, timeoutSec: 120 })
  assert.equal(written.timeoutSec, 120)
  assert.ok(fs.existsSync(path.join(dir, 'state.json')))
  const onDisk = JSON.parse(await fsp.readFile(path.join(dir, 'state.json'), 'utf8'))
  assert.equal(onDisk.clientId, first.clientId)
  assert.equal(onDisk.timeoutSec, 120)
  assert.deepEqual((await fsp.readdir(dir)).filter((name) => name.endsWith('.tmp')), [])

  const second = await createStateStore({ dir }).read()
  assert.equal(second.clientId, first.clientId)
  assert.equal(second.timeoutSec, 120)
})

test('createStateStore: 坏 JSON 备份后回默认', async () => {
  const dir = tmpDir('store-bad')
  const store = createStateStore({ dir })
  await fsp.writeFile(path.join(dir, 'state.json'), '{ this is not json', 'utf8')

  const recovered = await store.read()
  assert.equal(recovered.baseUrl, DEFAULT_BASE_URL)
  assert.match(recovered.clientId, /^dsh-sendcomfy-/)

  const files = await fsp.readdir(dir)
  const backup = files.find((name) => name.startsWith('state.bad-') && name.endsWith('.json'))
  assert.ok(backup, `应有 state.bad-*.json 备份，实际: ${files.join(', ')}`)
  assert.equal(fs.existsSync(path.join(dir, 'state.json')), false)
  assert.equal((await store.read()).baseUrl, DEFAULT_BASE_URL) // 备份后仍可读
})

test('createStateStore: workflows≤100 / lastRuns≤20', async () => {
  const dir = tmpDir('store-limits')
  const store = createStateStore({ dir })
  const base = (await store.read()).clientId

  const workflows = []
  for (let i = 0; i < 105; i += 1) {
    workflows.push({
      id: `wf-${i}`,
      name: `w${i}`,
      source: 'ui',
      apiGraph: { 1: { class_type: 'X', inputs: {} } },
      uiGraph: { nodes: [] },
      nodes: [],
      params: [],
      promptTargets: { positive: [], negative: [] },
      createdAt: new Date(1700000000000 + i).toISOString(),
      updatedAt: new Date(1700000000000 + i).toISOString(),
    })
  }
  const lastRuns = []
  for (let i = 0; i < 25; i += 1) {
    lastRuns.push({ promptId: `p-${i}`, workflowName: 'w', state: 'done', durationMs: i })
  }

  const written = await store.write({
    baseUrl: '192.168.1.7',
    timeoutSec: 0,
    clientId: base,
    workflows,
    lastRuns,
  })
  assert.equal(written.baseUrl, 'http://192.168.1.7:8188')
  assert.equal(written.timeoutSec, 5)
  assert.equal(written.workflows.length, 100)
  assert.equal(written.lastRuns.length, 20)
  assert.equal(written.workflows[0].id, 'wf-0')
  assert.equal(written.workflows[0].source, 'ui')
  assert.equal(written.workflows[0].uiGraph.nodes.length, 0)
  assert.equal(written.lastRuns[0].promptId, 'p-0')
})

test('createStateStore: 并发 update 串行化不丢数据 / 支持返回新对象', async () => {
  const dir = tmpDir('store-concurrent')
  const store = createStateStore({ dir })
  await store.write(defaultState())

  await Promise.all(
    Array.from({ length: 10 }, (_, i) => store.update((state) => {
      state.lastRuns.unshift({
        promptId: `p-${i}`,
        workflowName: 'w',
        state: 'done',
        createdAt: new Date().toISOString(),
      })
    })),
  )
  const afterUpdates = await store.read()
  assert.equal(afterUpdates.lastRuns.length, 10)
  assert.equal(new Set(afterUpdates.lastRuns.map((run) => run.promptId)).size, 10)

  const replaced = await store.update((state) => ({ ...state, baseUrl: '127.0.0.1:9000' }))
  assert.equal(replaced.baseUrl, 'http://127.0.0.1:9000')
  assert.equal((await store.read()).baseUrl, 'http://127.0.0.1:9000')
  assert.equal((await store.read()).clientId, afterUpdates.clientId)
})

test('getUserdataWorkflow: 按 ComfyUI 语义请求 /userdata/workflows%2F<file>（回归：服务器导入 404）', async () => {
  await withMock(async (mock) => {
    const workflow = await getUserdataWorkflow(mock.url, 'default.json')
    assert.equal(typeof workflow, 'object')
    assert.equal(workflow['3'].class_type, 'KSampler')
    const last = mock.requests
      .filter((item) => item.path && item.path.startsWith('/userdata/') && item.path !== '/userdata')
      .at(-1)
    assert.ok(last, '没有记录到 /userdata/{file} 请求')
    // ComfyUI user_manager 会对含 '%' 的值再 unquote 一次，所以插件对 '%' 多转义一层（%2F → %252F）
    assert.match(last.path, /^\/userdata\/workflows%252Fdefault\.json$/)
    assert.equal(last.path.includes('?dir=workflows'), false)
  })
})

// ---------------------------------------------------------------------------
// getUserdataWorkflow：gzip / 半损坏 gzip / 字面 % 文件名
// ---------------------------------------------------------------------------

test('getUserdataWorkflow: gzip 内容自动解压', async () => {
  await withMock(async (mock) => {
    const ui = loadUiFixture()
    mock.setUserdata('gz.json', gzipSync(Buffer.from(JSON.stringify(ui))))
    const workflow = await getUserdataWorkflow(mock.url, 'gz.json')
    assert.equal(Array.isArray(workflow.nodes), true)
    assert.equal(workflow.nodes.length, ui.nodes.length)
  })
})

test('getUserdataWorkflow: 半损坏 gzip（gzip 前缀 + 明文后缀）也能还原成完整 JSON', async () => {
  await withMock(async (mock) => {
    const ui = loadUiFixture()
    const full = JSON.stringify(ui)
    const cut = Math.floor(full.length / 2)
    const gz = gzipSync(Buffer.from(full.slice(0, cut)))
    const broken = Buffer.concat([gz, Buffer.from(full.slice(cut))])
    mock.setUserdata('broken.json', broken)
    const workflow = await getUserdataWorkflow(mock.url, 'broken.json')
    assert.deepEqual(workflow, ui)
  })
})

test('getUserdataWorkflow: 文件名里字面带 %20 也能读取（ComfyUI 二次 unquote 兼容）', async () => {
  await withMock(async (mock) => {
    const ui = loadUiFixture()
    mock.setUserdata('moss/Character%20Studio.json', ui)
    const workflow = await getUserdataWorkflow(mock.url, 'moss/Character%20Studio.json')
    assert.equal(Array.isArray(workflow.nodes), true)
  })
})

test('getUserdataWorkflow: 完整 gzip + 尾部垃圾时，取合法的那份 JSON', async () => {
  await withMock(async (mock) => {
    const ui = loadUiFixture()
    const gz = gzipSync(Buffer.from(JSON.stringify(ui)))
    mock.setUserdata('gz-tail.json', Buffer.concat([gz, Buffer.from('this is trailing garbage, not json')]))
    const workflow = await getUserdataWorkflow(mock.url, 'gz-tail.json')
    assert.deepEqual(workflow, ui)
  })
})
