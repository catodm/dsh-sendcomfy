/**
 * lib/actions.mjs 的集成测试：真实 state store（临时目录）+ 本地 mock ComfyUI（node:http）。
 * 覆盖：配置/连通性、模型、工作流导入与详情、运行（提示词注入 + 参数覆盖）、
 *       wait=false + poll、服务器工作流、队列/取消、上传/取图。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createActions } from '../lib/actions.mjs'
import { createStateStore } from '../lib/state.mjs'
import { startMockComfy } from './mock-comfy.mjs'

/** 一个 API 格式的最小工作流（不依赖 UI→API 转换，专门测 actions 层）。 */
function apiWorkflow() {
  return {
    3: { class_type: 'CLIPTextEncode', inputs: { text: 'an old cat' }, _meta: { title: 'Positive' } },
    4: { class_type: 'CLIPTextEncode', inputs: { text: 'blurry' }, _meta: { title: 'Negative' } },
    5: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
    6: {
      class_type: 'KSampler',
      inputs: {
        seed: 1,
        steps: 20,
        cfg: 7,
        sampler_name: 'euler',
        scheduler: 'normal',
        denoise: 1,
        model: ['7', 0],
        positive: ['3', 0],
        negative: ['4', 0],
        latent_image: ['5', 0],
      },
    },
    8: { class_type: 'VAEDecode', inputs: { samples: ['6', 0], vae: ['7', 2] } },
    9: { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'ComfyUI' } },
    7: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' } },
  }
}

async function withEnv(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'sendcomfy-test-'))
  const mock = await startMockComfy()
  try {
    const store = createStateStore({ dir })
    const actions = createActions({ store })
    await fn({ actions, mock, store, dir })
  } finally {
    try {
      await mock.close()
    } catch {
      /* ignore */
    }
    await rm(dir, { recursive: true, force: true })
  }
}

function lastPromptGraph(mock) {
  const received = mock.state?.prompts || mock.requests?.filter?.((r) => r.path === '/prompt') || []
  const last = received.at(-1)
  if (!last) return null
  return last.prompt || last.body?.prompt || last
}

test('getState 默认值 + setConfig 规范化 + test 连通性', async () => {
  await withEnv(async ({ actions, mock }) => {
    const initial = await actions.getState()
    assert.equal(initial.ok, true)
    assert.match(initial.baseUrl, /^https?:\/\//)
    assert.equal(initial.workflows.length, 0)

    const saved = await actions.setConfig({ baseUrl: mock.url, timeoutSec: 123 })
    assert.equal(saved.ok, true)
    assert.equal(saved.baseUrl, mock.url)
    assert.equal(saved.timeoutSec, 123)

    const ping = await actions.test({})
    assert.equal(ping.ok, true)
    assert.equal(ping.reachable, true)

    const bad = await actions.setConfig({ baseUrl: 'http:// has space' })
    assert.equal(bad.ok, false)
  })
})

test('listModels 返回分类模型', async () => {
  await withEnv(async ({ actions, mock }) => {
    await actions.setConfig({ baseUrl: mock.url })
    const models = await actions.listModels({ refresh: true })
    assert.equal(models.ok, true)
    assert.ok(Array.isArray(models.categories))
    const total = models.categories.reduce((sum, c) => sum + c.files.length, 0)
    assert.ok(total > 0, 'mock 的 object_info 里应该有模型文件')
    const checkpoints = models.categories.find((c) => c.id === 'checkpoints')
    assert.ok(checkpoints && checkpoints.files.some((file) => file.endsWith('.safetensors') || file.endsWith('.ckpt')))
  })
})

test('import → getWorkflow → rename → delete', async () => {
  await withEnv(async ({ actions, mock }) => {
    await actions.setConfig({ baseUrl: mock.url })
    const imported = await actions.importWorkflow({ name: 't2i', json: JSON.stringify(apiWorkflow()) })
    assert.equal(imported.ok, true)
    assert.equal(imported.workflow.name, 't2i')

    const detail = await actions.getWorkflow(imported.workflow.id)
    assert.equal(detail.ok, true)
    const paths = new Set(detail.workflow.params.map((p) => p.path))
    assert.ok(paths.has('6.steps'), `params 应包含 6.steps，实际：${[...paths].join(',')}`)
    assert.ok(paths.has('3.text'))
    assert.ok(detail.workflow.promptTargets.positive.includes('3.text'))
    assert.ok(detail.workflow.promptTargets.negative.includes('4.text'))

    const renamed = await actions.renameWorkflow({ id: imported.workflow.id, name: 't2i-v2' })
    assert.equal(renamed.ok, true)
    assert.equal(renamed.workflows[0].name, 't2i-v2')

    const removed = await actions.deleteWorkflow(imported.workflow.id)
    assert.equal(removed.ok, true)
    assert.equal(removed.workflows.length, 0)
  })
})

test('run：提示词写正向/负向，params 覆盖节点参数，输出图片落盘 + url', async () => {
  await withEnv(async ({ actions, mock, dir }) => {
    await actions.setConfig({ baseUrl: mock.url })
    const imported = await actions.importWorkflow({ name: 't2i', json: apiWorkflow() })
    assert.equal(imported.ok, true)

    mock.setHistory({
      status: { status_str: 'success', completed: true, messages: [] },
      outputs: { 9: { images: [{ filename: 'mock-out.png', subfolder: '', type: 'output' }] } },
    })

    const saveDir = join(dir, 'comfy-output')
    const result = await actions.run({
      workflow: imported.workflow.id,
      prompt: 'a red fox',
      negativePrompt: 'low quality',
      params: { '6.steps': '30', '6.seed': 42, '7.ckpt_name': 'sd_xl_base_1.0.safetensors' },
      saveDir,
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.state, 'done')
    assert.equal(result.promptId, 'mock-1')
    assert.equal(result.images.length, 1)
    assert.ok(result.images[0].url.startsWith('/api/sendcomfy/image?'))
    assert.ok(result.images[0].path, '默认应把图片落到 saveDir')

    const graph = lastPromptGraph(mock)
    assert.equal(graph['3'].inputs.text, 'a red fox')
    assert.equal(graph['4'].inputs.text, 'low quality')
    assert.equal(graph['6'].inputs.steps, 30)
    assert.equal(graph['6'].inputs.seed, 42)
    assert.equal(graph['6'].inputs.cfg, 7)
    assert.deepEqual(graph['6'].inputs.model, ['7', 0])

    const state = await actions.getState()
    assert.equal(state.lastRuns.length, 1)
    assert.equal(state.lastRuns[0].state, 'done')
    assert.ok(state.lastRuns[0].images[0].url.startsWith('/api/sendcomfy/image?'))
  })
})

test('run wait=false → queued；pollResult 拿到完成态', async () => {
  await withEnv(async ({ actions, mock }) => {
    await actions.setConfig({ baseUrl: mock.url })
    const imported = await actions.importWorkflow({ name: 't2i', json: apiWorkflow() })
    mock.clearHistory?.()
    const queued = await actions.run({ workflow: imported.workflow.name, wait: false })
    assert.equal(queued.ok, true)
    assert.equal(queued.state, 'queued')

    mock.setHistory({
      status: { status_str: 'success', completed: true, messages: [] },
      outputs: { 9: { images: [{ filename: 'later.png', subfolder: 'sub', type: 'output' }] } },
    })
    const polled = await actions.pollResult({ promptId: queued.promptId })
    assert.equal(polled.ok, true)
    assert.equal(polled.state, 'done')
    assert.equal(polled.images.length, 1)
  })
})

test('run 失败：ComfyUI 报执行错误时 ok=false 且带错误信息', async () => {
  await withEnv(async ({ actions, mock }) => {
    await actions.setConfig({ baseUrl: mock.url })
    const imported = await actions.importWorkflow({ name: 't2i', json: apiWorkflow() })
    mock.setHistory({
      status: {
        status_str: 'error',
        completed: false,
        messages: [['execution_error', { node_type: 'KSampler', exception_message: 'CUDA out of memory' }]],
      },
      outputs: {},
    })
    const result = await actions.run({ workflow: imported.workflow.id, wait: true })
    assert.equal(result.ok, false)
    assert.equal(result.state, 'error')
    assert.match(String(result.error), /CUDA out of memory|执行失败/)
  })
})

test('服务器工作流列表 / userdata 不可用时优雅降级', async () => {
  await withEnv(async ({ actions, mock }) => {
    await actions.setConfig({ baseUrl: mock.url })
    mock.userdataUnavailable = false
    const list = await actions.listServerWorkflows()
    assert.equal(list.ok, true)
    assert.ok(Array.isArray(list.items))

    mock.userdataUnavailable = true
    const degraded = await actions.listServerWorkflows()
    assert.equal(degraded.ok, false)
    assert.ok(degraded.error)
  })
})

test('上传图片 / 取图 / 队列 / 取消', async () => {
  await withEnv(async ({ actions, mock }) => {
    await actions.setConfig({ baseUrl: mock.url })
    const uploaded = await actions.uploadImage({ data: Buffer.from([1, 2, 3]), filename: 'input.png' })
    assert.equal(uploaded.ok, true)
    assert.equal(uploaded.name, 'input.png')

    const image = await actions.getImage({ filename: 'x.png', subfolder: '', type: 'output' })
    assert.equal(image.ok, true)
    assert.ok(image.buffer.length > 0)

    const queue = await actions.getQueue()
    assert.equal(queue.ok, true)
    assert.ok(Array.isArray(queue.running))

    const cancelled = await actions.cancel({ promptId: 'mock-1' })
    assert.equal(cancelled.ok, true)
  })
})

test('配置/工作流错误输入返回 ok:false 而不是抛异常', async () => {
  await withEnv(async ({ actions }) => {
    const noName = await actions.importWorkflow({ name: '', json: apiWorkflow() })
    assert.equal(noName.ok, false)
    const badJson = await actions.importWorkflow({ name: 'x', json: '{oops' })
    assert.equal(badJson.ok, false)
    const badWorkflow = await actions.importWorkflow({ name: 'x', json: JSON.stringify({ hello: 1 }) })
    assert.equal(badWorkflow.ok, false)
    const missing = await actions.getWorkflow('不存在的')
    assert.equal(missing.ok, false)
  })
})

test('ComfyUI 以 HTTP 400 + node_errors 拒绝时，nodeErrors 透传给调用方', async () => {
  await withEnv(async ({ actions, mock }) => {
    await actions.setConfig({ baseUrl: mock.url })
    const imported = await actions.importWorkflow({ name: 't2i', json: apiWorkflow() })
    mock.failNextRoute('/prompt', {
      status: 400,
      body: {
        error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation' },
        node_errors: { 6: { class_type: 'KSampler', errors: [{ message: 'Value not in list: ckpt_name' }] } },
      },
    })
    const result = await actions.run({ workflow: imported.workflow.id, wait: true })
    assert.equal(result.ok, false)
    assert.ok(result.nodeErrors, '应透传 nodeErrors')
    assert.ok(result.nodeErrors['6'])
    assert.match(String(result.error), /400|validation/i)
  })
})

test('ComfyUI 不可达时仍可导入，但带「启发式推导」warning', async () => {
  await withEnv(async ({ actions }) => {
    await actions.setConfig({ baseUrl: 'http://127.0.0.1:1' })
    const imported = await actions.importWorkflow({ name: 'offline', json: JSON.stringify(apiWorkflow()) })
    assert.equal(imported.ok, true)
    assert.equal(imported.live, false)
    assert.ok(Array.isArray(imported.warnings))
    assert.ok(imported.warnings.some((message) => /连不上|启发式/.test(message)), JSON.stringify(imported.warnings))
  })
})

test('pollResult 与 run 终态字段一致（elapsedMs/workflow 可缺省但不报错）', async () => {
  await withEnv(async ({ actions, mock }) => {
    await actions.setConfig({ baseUrl: mock.url })
    const imported = await actions.importWorkflow({ name: 't2i', json: apiWorkflow() })
    mock.clearHistory?.()
    const queued = await actions.run({ workflow: imported.workflow.id, wait: false })
    mock.setHistory({
      status: { status_str: 'success', completed: true, messages: [] },
      outputs: { 9: { images: [{ filename: 'again.png', subfolder: '', type: 'output' }] } },
    })
    const polled = await actions.pollResult({ promptId: queued.promptId })
    assert.equal(polled.ok, true)
    assert.equal(polled.state, 'done')
    assert.ok(Array.isArray(polled.images))
    assert.ok(polled.workflow && polled.workflow.id === imported.workflow.id)
    assert.equal(typeof polled.warnings, 'object')
  })
})

test('§11：导入自动写 description；getWorkflow 返回 capabilities/neededInputs', async () => {
  await withEnv(async ({ actions, mock }) => {
    await actions.setConfig({ baseUrl: mock.url })
    const imported = await actions.importWorkflow({ name: 't2i', json: JSON.stringify(apiWorkflow()) })
    assert.equal(imported.ok, true)
    assert.equal(typeof imported.workflow.description, 'string')
    assert.ok(imported.workflow.description.length > 0)
    assert.deepEqual(imported.workflow.kinds, ['txt2img'])
    assert.deepEqual(imported.workflow.kindLabels, ['文生图'])

    const detail = await actions.getWorkflow(imported.workflow.id)
    assert.equal(detail.ok, true)
    assert.equal(typeof detail.workflow.capabilities, 'object')
    assert.deepEqual(detail.workflow.capabilities.kinds, ['txt2img'])
    assert.equal(detail.workflow.capabilities.hasPrompt, true)
    assert.equal(detail.workflow.capabilities.hasNegative, true)
    assert.deepEqual(detail.workflow.neededInputs, [])
    assert.ok(Array.isArray(detail.workflow.capabilities.classes))
  })
})

test('§11：updateWorkflowMeta 持久化 description/tags（写回 state 后仍在）', async () => {
  await withEnv(async ({ actions }) => {
    const imported = await actions.importWorkflow({ name: 't2i', json: JSON.stringify(apiWorkflow()) })
    const id = imported.workflow.id
    const updated = await actions.updateWorkflowMeta({ id, description: '画二次元头像', tags: '二次元，头像、 头像 ' })
    assert.equal(updated.ok, true, JSON.stringify(updated))
    assert.equal(updated.workflow.description, '画二次元头像')
    assert.deepEqual(updated.workflow.tags, ['二次元', '头像'])

    const state = await actions.getState()
    const found = state.workflows.find((workflow) => workflow.id === id)
    assert.equal(found.description, '画二次元头像')
    assert.deepEqual(found.tags, ['二次元', '头像'])

    const detail = await actions.getWorkflow(id)
    assert.equal(detail.workflow.description, '画二次元头像')
    assert.deepEqual(detail.workflow.tags, ['二次元', '头像'])

    const tooLong = await actions.updateWorkflowMeta({ id, description: 'x'.repeat(501) })
    assert.equal(tooLong.ok, false)
    const tooMany = await actions.updateWorkflowMeta({ id, tags: Array.from({ length: 13 }, (_, index) => 't' + index) })
    assert.equal(tooMany.ok, false)
    const empty = await actions.updateWorkflowMeta({ id })
    assert.equal(empty.ok, false)
    const missing = await actions.updateWorkflowMeta({ id: 'nope', description: 'x' })
    assert.equal(missing.ok, false)
  })
})

test('§11：chooseWorkflow 本地排序 + 服务器候选 + 空库报错', async () => {
  await withEnv(async ({ actions, mock }) => {
    const empty = await actions.chooseWorkflow({ task: '画一只猫', includeServer: false })
    assert.equal(empty.ok, false)

    await actions.setConfig({ baseUrl: mock.url })
    const txt2img = await actions.importWorkflow({ name: 'txt2img', json: JSON.stringify(apiWorkflow()) })
    assert.equal(txt2img.ok, true)
    await actions.updateWorkflowMeta({ id: txt2img.workflow.id, description: '文生图，画插画/头像', tags: ['插画', '头像'] })

    const upscaleGraph = {
      1: { class_type: 'LoadImage', inputs: { image: 'in.png' } },
      2: { class_type: 'UpscaleModelLoader', inputs: { model_name: '4x.pth' } },
      3: { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['2', 0], image: ['1', 0] } },
      4: { class_type: 'SaveImage', inputs: { images: ['3', 0] } },
    }
    const upscale = await actions.importWorkflow({ name: 'upscale-4x', json: JSON.stringify(upscaleGraph) })
    assert.equal(upscale.ok, true)
    await actions.updateWorkflowMeta({ id: upscale.workflow.id, description: '高清放大 4x 超分', tags: ['放大', '高清'] })

    const picked = await actions.chooseWorkflow({ task: '把这张图放大成 4k 高清', includeServer: false })
    assert.equal(picked.ok, true, JSON.stringify(picked))
    assert.equal(picked.candidates[0].source, 'local')
    assert.equal(picked.candidates[0].name, 'upscale-4x')
    assert.ok(picked.candidates[0].matched)
    assert.ok(picked.intentKinds.includes('upscale'))
    assert.ok(Array.isArray(picked.candidates[0].neededInputs))
    assert.ok(typeof picked.candidates[0].next === 'string')

    const cat = await actions.chooseWorkflow({ task: '画一只赛博朋克风格的猫', includeServer: false, limit: 1 })
    assert.equal(cat.ok, true)
    assert.equal(cat.candidates.length, 1)
    assert.equal(cat.candidates[0].name, 'txt2img')

    const missingTask = await actions.chooseWorkflow({ task: '' })
    assert.equal(missingTask.ok, false)
  })
})

test('§12 服务器工作流：按需加载 + 直接运行，不写本地库', async () => {
  await withEnv(async ({ actions, mock }) => {
    await actions.setConfig({ baseUrl: mock.url })
    const list = await actions.listServerWorkflows()
    assert.equal(list.ok, true)
    const path = list.items.find((item) => item.path === 'default.json').path
    assert.ok(path)

    const detail = await actions.getServerWorkflowDetail({ path })
    assert.equal(detail.ok, true, JSON.stringify(detail))
    assert.equal(detail.fromServer, true)
    assert.equal(detail.workflow.sourcePath, path)
    assert.ok(detail.workflow.params.length > 0)
    assert.ok(detail.workflow.capabilities.kinds.length > 0)

    mock.setHistory({
      status: { status_str: 'success', completed: true, messages: [] },
      outputs: { 9: { images: [{ filename: 'on-demand.png', subfolder: '', type: 'output' }] } },
    })
    const run = await actions.run({ workflow: path, prompt: 'a cat' })
    assert.equal(run.ok, true, JSON.stringify(run))
    assert.equal(run.state, 'done')
    assert.equal(run.workflow.source, 'server')
    assert.equal(run.workflow.sourcePath, path)

    // 关键：按需加载不会把工作流写进本地库
    const state = await actions.getState()
    assert.equal(state.workflows.length, 0)
  })
})

test('§13 chooseWorkflow：服务器优先（默认只从服务器选），并能按文件名猜能力', async () => {
  await withEnv(async ({ actions, mock }) => {
    await actions.setConfig({ baseUrl: mock.url })
    // 服务器上有 3 个不同用途的工作流（mock 内置 setUserdataWorkflows）
    mock.setUserdataWorkflows([
      { path: 'flux2工作流/文生图.json', name: '文生图' },
      { path: 'h3工作流/图生视频.json', name: '图生视频' },
      { path: '放大/4x超分.json', name: '4x超分' },
    ])
    mock.setUserdata('放大/4x超分.json', {
      1: { class_type: 'LoadImage', inputs: { image: 'in.png' } },
      2: { class_type: 'UpscaleModelLoader', inputs: { model_name: '4x.pth' } },
      3: { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['2', 0], image: ['1', 0] } },
      4: { class_type: 'SaveImage', inputs: { images: ['3', 0], filename_prefix: 'up' } },
    })
    const picked = await actions.chooseWorkflow({ task: '把这张图放大成 4k 高清' })
    assert.equal(picked.ok, true, JSON.stringify(picked))
    assert.equal(picked.mode, 'server')
    assert.equal(picked.serverReachable, true)
    assert.equal(picked.candidates.length > 0, true)
    assert.ok(picked.candidates.every((item) => item.source === 'server'))
    const first = picked.candidates[0]
    assert.equal(first.sourcePath, '放大/4x超分.json')
    assert.ok(first.kinds.includes('upscale'), JSON.stringify(first.kinds))
    assert.equal(first.needsInput, true)
    assert.match(first.next, /comfy_workflow/)
    assert.match(first.next, /comfy_upload_image/)
    assert.match(first.next, /comfy_run/)

    // 服务器候选带 path 时可直接喂给 comfy_run（use 时加载，不写本地库）
    const detail = await actions.getServerWorkflowDetail({ path: first.sourcePath })
    assert.equal(detail.ok, true, JSON.stringify(detail))
    assert.equal(detail.workflow.sourcePath, first.sourcePath)
    const state = await actions.getState()
    assert.equal(state.workflows.length, 0)
  })
})
