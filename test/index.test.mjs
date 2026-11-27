/**
 * index.js 装配测试：用假的 Cordis ctx 验证
 *   - 挂载了 /api/sendcomfy 路由；
 *   - 注册了全部 comfy_* 工具（schema / description / output / execute 齐全）；
 *   - 工具真的能跑（对本地 mock ComfyUI 端到端：配置 → 导入 → 运行 → 结果落盘）；
 *   - effect disposer 能干净卸载。
 *
 * 不依赖 DSH Host 进程：ctx.tools / ctx.webServer / ctx.get('workingDirectory') 都是用内存假实现。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'
import { startMockComfy } from './mock-comfy.mjs'

const COMFY_TOOL_NAMES = [
  'comfy_status',
  'comfy_models',
  'comfy_workflows',
  'comfy_workflow',
  'comfy_run',
  'comfy_result',
  'comfy_cancel',
  'comfy_import_workflow',
  'comfy_server_workflows',
  'comfy_upload_image',
  // §11：工作流由 AI 自主选择
  'comfy_choose_workflow',
  'comfy_describe_workflow',
]

function makeCtx(workspace) {
  const disposers = []
  const tools = new Map()
  const routes = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get(name) {
      if (name === 'workingDirectory') {
        return { ensure: async () => workspace }
      }
      return undefined
    },
    effect(factory) {
      const cleanup = factory()
      disposers.push(cleanup)
      return () => {}
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
  }
  return { ctx, tools, routes, disposers }
}

async function startRouteServer(routes) {
  const server = createServer((req, res) => {
    const route = routes.find((item) => req.url.startsWith(item.path))
    if (!route) {
      res.writeHead(404)
      res.end()
      return
    }
    Promise.resolve(route.handler(req, res)).catch((error) => {
      res.writeHead(500)
      res.end(String(error))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) }
}

async function setup(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'sendcomfy-index-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  const mock = await startMockComfy()
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = root
  const { ctx, tools, routes, disposers } = makeCtx(workspace)
  if (options.connection !== undefined) ctx.connection = options.connection
  apply(ctx)
  const server = await startRouteServer(routes)
  return {
    root,
    workspace,
    mock,
    tools,
    routes,
    server,
    async close() {
      const cleanups = disposers.splice(0).reverse()
      for (const cleanup of cleanups) {
        try {
          if (typeof cleanup === 'function') await cleanup()
        } catch {
          /* ignore */
        }
      }
      await server.close()
      await mock.close()
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      await rm(root, { recursive: true, force: true })
    },
  }
}

async function postJson(url, path, body) {
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  return { status: response.status, json: await response.json() }
}

test('apply 挂载路由并注册全部 comfy_* 工具', async () => {
  const env = await setup()
  try {
    assert.equal(env.routes.length, 1)
    assert.equal(env.routes[0].path, '/api/sendcomfy')
    assert.equal(env.tools.size, COMFY_TOOL_NAMES.length)
    for (const name of COMFY_TOOL_NAMES) {
      const definition = env.tools.get(name)
      assert.ok(definition, `缺少工具 ${name}`)
      assert.equal(typeof definition.description, 'string')
      assert.ok(definition.description.length > 20, `${name} 描述太短`)
      assert.equal(definition.parameters.type, 'object')
      assert.equal(definition.parameters.additionalProperties, false)
      assert.equal(typeof definition.output?.schema, 'object')
      assert.equal(typeof definition.output?.render, 'function')
      assert.equal(typeof definition.execute, 'function')
    }
  } finally {
    await env.close()
  }
})

test('工具端到端：配置 → 模型 → 导入 → 运行 → 结果落盘', async () => {
  const env = await setup()
  try {
    // 1) 通过 HTTP 路由配置（与网页面板同一条路径）
    const configured = await postJson(env.server.url, '/api/sendcomfy/config', { baseUrl: env.mock.url, timeoutSec: 60 })
    assert.equal(configured.json.ok, true)

    // 2) comfy_status：连得上
    const status = await env.tools.get('comfy_status').execute({})
    assert.equal(status.ok, true)
    assert.equal(status.live.reachable, true)
    assert.ok(status.baseUrl.endsWith(env.mock.url.replace(/^https?:\/\//, '').replace(/:\d+$/, '') + '') || status.baseUrl === env.mock.url)

    // 3) comfy_models
    const models = await env.tools.get('comfy_models').execute({ category: 'checkpoints' })
    assert.equal(models.ok, true)
    assert.ok(models.total > 0)

    // 4) 导入 API 格式工作流
    const graph = {
      3: { class_type: 'CLIPTextEncode', inputs: { text: 'old prompt' }, _meta: { title: 'Positive' } },
      4: { class_type: 'CLIPTextEncode', inputs: { text: 'bad' }, _meta: { title: 'Negative' } },
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
      7: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' } },
      8: { class_type: 'VAEDecode', inputs: { samples: ['6', 0], vae: ['7', 2] } },
      9: { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'ComfyUI' } },
    }
    const imported = await env.tools.get('comfy_import_workflow').execute({ name: 'tool-t2i', json: JSON.stringify(graph) })
    assert.equal(imported.ok, true, JSON.stringify(imported))

    // 5) comfy_workflows（主用法：服务器清单，不需要导入）+ comfy_workflow
    const list = await env.tools.get('comfy_workflows').execute({})
    assert.equal(list.localWorkflows.length, 1)
    assert.equal(list.serverReachable, true)
    assert.ok(list.serverWorkflows.some((item) => item.path === 'default.json'))
    const detail = await env.tools.get('comfy_workflow').execute({ workflow: 'tool-t2i' })
    assert.equal(detail.ok, true)
    const paths = new Set(detail.workflow.params.map((param) => param.path))
    assert.ok(paths.has('6.steps'))
    assert.ok(Array.isArray(detail.workflow.capabilities.kinds))
    assert.ok(detail.workflow.capabilities.kinds.includes('txt2img'))

    // 5.2) 服务器工作流：按 path 查看 + 直接运行（use 时自动加载，不写本地库）
    const serverDetail = await env.tools.get('comfy_workflow').execute({ workflow: 'default.json' })
    assert.equal(serverDetail.ok, true, JSON.stringify(serverDetail))
    assert.equal(serverDetail.workflow.sourcePath, 'default.json')
    assert.ok(serverDetail.workflow.params.length > 0)
    env.mock.setHistory({
      status: { status_str: 'success', completed: true, messages: [] },
      outputs: { 9: { images: [{ filename: 'server-path.png', subfolder: '', type: 'output' }] } },
    })
    const serverRun = await env.tools.get('comfy_run').execute(
      { workflow: 'default.json', prompt: 'a cat' },
      { agent: { id: 'test-agent' } },
    )
    assert.equal(serverRun.ok, true, JSON.stringify(serverRun))
    assert.equal(serverRun.workflow.source, 'server')
    const statusAfter = await env.tools.get('comfy_status').execute({})
    assert.equal(statusAfter.workflows.length, 1)

    // 5.1) §11：AI 自主选型 —— 先登记用途说明/标签，再按任务描述选工作流
    const described = await env.tools.get('comfy_describe_workflow').execute({
      workflow: 'tool-t2i',
      description: '画二次元头像/插画的工作流',
      tags: ['二次元', '头像'],
    })
    assert.equal(described.ok, true, JSON.stringify(described))
    assert.deepEqual(described.workflow.tags, ['二次元', '头像'])

    const chosen = await env.tools.get('comfy_choose_workflow').execute({
      task: '画一个二次元头像',
      includeServer: false,
      limit: 3,
    })
    assert.equal(chosen.ok, true, JSON.stringify(chosen))
    assert.equal(chosen.candidates.length > 0, true)
    assert.equal(chosen.candidates[0].name, 'tool-t2i')
    assert.equal(chosen.candidates[0].matched, true)
    assert.ok(chosen.candidates[0].workflow.id)
    assert.ok(Array.isArray(chosen.candidates[0].kinds))
    assert.ok(typeof chosen.candidates[0].next === 'string')

    // 6) comfy_run：提示词 + 参数覆盖 + 图片落盘到工作区
    env.mock.setHistory({
      status: { status_str: 'success', completed: true, messages: [] },
      outputs: { 9: { images: [{ filename: 'tool-out.png', subfolder: '', type: 'output' }] } },
    })
    const run = await env.tools.get('comfy_run').execute({
      workflow: 'tool-t2i',
      prompt: 'a green owl',
      negativePrompt: 'bad anatomy',
      params: { '6.steps': 12 },
    }, { agent: { id: 'test-agent' } })
    assert.equal(run.ok, true, JSON.stringify(run))
    assert.equal(run.state, 'done')
    assert.ok(run.images[0].path.startsWith(join(env.workspace, 'comfy-output')))
    const lastPrompt = env.mock.state.prompts.at(-1)
    assert.equal(lastPrompt.prompt['3'].inputs.text, 'a green owl')
    assert.equal(lastPrompt.prompt['6'].inputs.steps, 12)

    // 7) comfy_result（wait=false 后的轮询）
    env.mock.clearHistory()
    const queued = await env.tools.get('comfy_run').execute({ workflow: 'tool-t2i', wait: false })
    assert.equal(queued.state, 'queued')
    env.mock.setHistory({
      status: { status_str: 'success', completed: true, messages: [] },
      outputs: {},
    })
    const polled = await env.tools.get('comfy_result').execute({ promptId: queued.promptId })
    assert.equal(polled.ok, true)

    // 8) comfy_cancel / comfy_server_workflows
    const cancelled = await env.tools.get('comfy_cancel').execute({ promptId: queued.promptId })
    assert.equal(cancelled.ok, true)
    const serverList = await env.tools.get('comfy_server_workflows').execute({})
    assert.equal(serverList.ok, true)

    // 9) comfy_upload_image：工作区相对路径
    const imagePath = join(env.workspace, 'input.png')
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const uploaded = await env.tools.get('comfy_upload_image').execute({ path: 'input.png' }, { agent: { id: 'test-agent' } })
    assert.equal(uploaded.ok, true)
    assert.equal(uploaded.name, 'input.png')
  } finally {
    await env.close()
  }
})

test('effect disposer 卸载后工具与路由都清掉', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sendcomfy-index-dispose-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = root
  const workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  const { ctx, tools, routes, disposers } = makeCtx(workspace)
  try {
    apply(ctx)
    assert.equal(tools.size, COMFY_TOOL_NAMES.length)
    assert.equal(routes.length, 1)
    for (const cleanup of disposers.splice(0).reverse()) {
      if (typeof cleanup === 'function') await cleanup()
    }
    assert.equal(tools.size, 0)
    assert.equal(routes.length, 0)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})

/* ── 准入检查接线（index.js ← connection 服务）───────────────────────────── */

test('准入检查：connection.requestRejection 拒绝时面板路由返回 401，业务层不执行', async () => {
  const seen = []
  const env = await setup({
    connection: {
      requestRejection({ headers }) {
        seen.push(headers.host)
        return 401
      },
    },
  })
  try {
    const response = await fetch(`${env.server.url}/api/sendcomfy/state`)
    assert.equal(response.status, 401)
    const json = await response.json()
    assert.equal(json.ok, false)
    assert.equal(seen.length, 1, 'requestRejection 应当被调用一次')
  } finally {
    await env.close()
  }
})

test('准入检查：connection 放行时面板路由照常返回', async () => {
  const env = await setup({ connection: { requestRejection: () => undefined } })
  try {
    const response = await fetch(`${env.server.url}/api/sendcomfy/state`)
    assert.equal(response.status, 200)
    const json = await response.json()
    assert.equal(json.ok, true)
  } finally {
    await env.close()
  }
})

test('准入检查：没有 connection 时退回回环栅栏，非回环 Host 被拒', async () => {
  const env = await setup()
  try {
    const status = await new Promise((resolve, reject) => {
      const req = request(
        `${env.server.url}/api/sendcomfy/state`,
        { headers: { host: 'evil.example.com' } },
        (res) => {
          res.resume()
          resolve(res.statusCode)
        },
      )
      req.on('error', reject)
      req.end()
    })
    assert.equal(status, 403)
    // 同一条路由在回环 Host 下仍然正常
    const ok = await fetch(`${env.server.url}/api/sendcomfy/state`)
    assert.equal(ok.status, 200)
  } finally {
    await env.close()
  }
})
