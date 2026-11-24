/**
 * lib/http.mjs 的路由层测试：用真实 node:http 服务器 + 假 actions，
 * 覆盖每个端点、错误码与图片二进制路径（不依赖 ComfyUI / 网络）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { createApiHandler } from '../lib/http.mjs'

function makeActions(overrides = {}) {
  const calls = []
  const base = {
    getState: async () => ({ ok: true, baseUrl: 'http://127.0.0.1:8188', timeoutSec: 300, workflows: [], lastRuns: [] }),
    setConfig: async (body) => {
      calls.push(['setConfig', body])
      return { ok: true, baseUrl: body.baseUrl || 'http://127.0.0.1:8188', timeoutSec: body.timeoutSec ?? 300 }
    },
    test: async (body) => {
      calls.push(['test', body])
      return { ok: true, reachable: true, baseUrl: 'http://127.0.0.1:8188', latencyMs: 3 }
    },
    listModels: async ({ refresh } = {}) => {
      calls.push(['listModels', refresh])
      return { ok: true, total: 1, categories: [{ id: 'checkpoints', label: 'Checkpoints', count: 1, files: ['a.safetensors'] }] }
    },
    listWorkflows: async () => ({ ok: true, workflows: [{ id: 'w1', name: 'wf' }] }),
    getWorkflow: async (id) => ({ ok: true, workflow: { id, name: 'wf' } }),
    importWorkflow: async (body) => {
      calls.push(['importWorkflow', body])
      return { ok: true, workflow: { id: 'w1', name: body.name } }
    },
    renameWorkflow: async (body) => ({ ok: true, workflows: [], echo: body }),
    deleteWorkflow: async (id) => ({ ok: true, workflows: [], echo: id }),
    listServerWorkflows: async () => ({ ok: true, items: [{ path: 'default.json', name: 'default.json' }] }),
    importServerWorkflow: async (body) => {
      calls.push(['importServerWorkflow', body])
      return { ok: true, workflow: { id: 'w2' } }
    },
    run: async (body) => {
      calls.push(['run', body])
      return { ok: true, promptId: 'p1', state: body.wait === false ? 'queued' : 'done', images: [] }
    },
    getImage: async ({ filename }) => {
      if (filename === 'missing.png') return { ok: false, error: 'not found' }
      return { ok: true, buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]), contentType: 'image/png' }
    },
    getQueue: async () => ({ ok: true, running: [], pending: [] }),
    cancel: async (body) => ({ ok: true, interrupted: true, echo: body }),
  }
  return { actions: { ...base, ...overrides }, calls }
}

async function startServer(actions) {
  const handler = createApiHandler(actions)
  const server = createServer((req, res) => {
    handler(req, res).catch((error) => {
      res.writeHead(500)
      res.end(String(error))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

async function getJson(url, init) {
  const response = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers || {}) } })
  const json = await response.json()
  return { response, json }
}

test('GET /api/sendcomfy/state 返回状态', async () => {
  const { actions } = makeActions()
  const server = await startServer(actions)
  try {
    const { response, json } = await getJson(`${server.url}/api/sendcomfy/state`)
    assert.equal(response.status, 200)
    assert.equal(json.ok, true)
    assert.equal(json.baseUrl, 'http://127.0.0.1:8188')
  } finally {
    await server.close()
  }
})

test('POST /config 与 /test 透传 JSON', async () => {
  const { actions, calls } = makeActions()
  const server = await startServer(actions)
  try {
    const config = await getJson(`${server.url}/api/sendcomfy/config`, {
      method: 'POST',
      body: JSON.stringify({ baseUrl: '192.168.1.9:8188', timeoutSec: 120 }),
    })
    assert.equal(config.json.ok, true)
    assert.equal(calls[0][1].baseUrl, '192.168.1.9:8188')

    const ping = await getJson(`${server.url}/api/sendcomfy/test`, { method: 'POST', body: JSON.stringify({}) })
    assert.equal(ping.json.reachable, true)
  } finally {
    await server.close()
  }
})

test('GET /models 支持 refresh 查询参数', async () => {
  const { actions, calls } = makeActions()
  const server = await startServer(actions)
  try {
    const { json } = await getJson(`${server.url}/api/sendcomfy/models?refresh=1`)
    assert.equal(json.ok, true)
    assert.equal(calls[0][1], true)
    const again = await getJson(`${server.url}/api/sendcomfy/models`)
    assert.equal(again.json.ok, true)
    assert.equal(calls[1][1], false)
  } finally {
    await server.close()
  }
})

test('工作流增删改查与参数解码', async () => {
  const { actions, calls } = makeActions()
  const server = await startServer(actions)
  try {
    const list = await getJson(`${server.url}/api/sendcomfy/workflows`)
    assert.equal(list.json.workflows.length, 1)

    const detail = await getJson(`${server.url}/api/sendcomfy/workflows/w%201`)
    assert.equal(detail.json.workflow.id, 'w 1')

    const imported = await getJson(`${server.url}/api/sendcomfy/workflows`, {
      method: 'POST',
      body: JSON.stringify({ action: 'import', name: 'my flow', json: '{}' }),
    })
    assert.equal(imported.json.workflow.name, 'my flow')
    assert.equal(calls.at(-1)[1].name, 'my flow')

    const renamed = await getJson(`${server.url}/api/sendcomfy/workflows`, {
      method: 'POST',
      body: JSON.stringify({ action: 'rename', id: 'w1', name: 'new' }),
    })
    assert.equal(renamed.json.echo.name, 'new')

    const deleted = await getJson(`${server.url}/api/sendcomfy/workflows`, {
      method: 'POST',
      body: JSON.stringify({ action: 'delete', id: 'w1' }),
    })
    assert.equal(deleted.json.echo, 'w1')

    const bad = await getJson(`${server.url}/api/sendcomfy/workflows`, {
      method: 'POST',
      body: JSON.stringify({ action: 'nope' }),
    })
    assert.equal(bad.response.status, 400)
    assert.equal(bad.json.ok, false)
  } finally {
    await server.close()
  }
})

test('服务器工作流列表与导入', async () => {
  const { actions } = makeActions()
  const server = await startServer(actions)
  try {
    const list = await getJson(`${server.url}/api/sendcomfy/server-workflows`)
    assert.equal(list.json.items.length, 1)
    const imported = await getJson(`${server.url}/api/sendcomfy/server-workflows`, {
      method: 'POST',
      body: JSON.stringify({ action: 'import', path: 'default.json' }),
    })
    assert.equal(imported.json.ok, true)
    const bad = await getJson(`${server.url}/api/sendcomfy/server-workflows`, {
      method: 'POST',
      body: JSON.stringify({ action: 'delete' }),
    })
    assert.equal(bad.response.status, 400)
  } finally {
    await server.close()
  }
})

test('POST /run：默认 wait=true，wait=false 透传，图片 url 由 actions 决定', async () => {
  const { actions, calls } = makeActions()
  const server = await startServer(actions)
  try {
    const first = await getJson(`${server.url}/api/sendcomfy/run`, {
      method: 'POST',
      body: JSON.stringify({ workflow: 'w1', prompt: 'a cat' }),
    })
    assert.equal(first.json.state, 'done')
    assert.equal(calls.at(-1)[1].wait, true)
    assert.equal(calls.at(-1)[1].saveDir, null)

    const second = await getJson(`${server.url}/api/sendcomfy/run`, {
      method: 'POST',
      body: JSON.stringify({ workflow: 'w1', wait: false }),
    })
    assert.equal(second.json.state, 'queued')
    assert.equal(calls.at(-1)[1].wait, false)
  } finally {
    await server.close()
  }
})

test('GET /image 返回二进制；缺图 404', async () => {
  const { actions } = makeActions()
  const server = await startServer(actions)
  try {
    const response = await fetch(`${server.url}/api/sendcomfy/image?filename=a.png&subfolder=&type=output`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/png')
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0x89, 0x50, 0x4e, 0x47])

    const missing = await fetch(`${server.url}/api/sendcomfy/image?filename=missing.png`)
    assert.equal(missing.status, 404)
    assert.equal((await missing.json()).ok, false)
  } finally {
    await server.close()
  }
})

test('queue / cancel 路由', async () => {
  const { actions } = makeActions()
  const server = await startServer(actions)
  try {
    const queue = await getJson(`${server.url}/api/sendcomfy/queue`)
    assert.equal(queue.json.ok, true)
    const cancel = await getJson(`${server.url}/api/sendcomfy/cancel`, {
      method: 'POST',
      body: JSON.stringify({ promptId: 'p1' }),
    })
    assert.equal(cancel.json.echo.promptId, 'p1')
  } finally {
    await server.close()
  }
})

test('协议错误：坏 JSON 400、未知路由 404、超大 body 413', async () => {
  const { actions } = makeActions()
  const server = await startServer(actions)
  try {
    const badJson = await getJson(`${server.url}/api/sendcomfy/config`, { method: 'POST', body: '{not json' })
    assert.equal(badJson.response.status, 400)

    const unknown = await getJson(`${server.url}/api/sendcomfy/nope`)
    assert.equal(unknown.response.status, 404)

    const wrongMethod = await getJson(`${server.url}/api/sendcomfy/state`, { method: 'DELETE' })
    assert.equal(wrongMethod.response.status, 404)

    const huge = await fetch(`${server.url}/api/sendcomfy/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pad: 'x'.repeat(5 * 1024 * 1024 + 32) }),
    })
    assert.equal(huge.status, 413)
  } finally {
    await server.close()
  }
})

test('前缀不匹配的请求不会被本插件处理', async () => {
  const { actions, calls } = makeActions()
  const server = await startServer(actions)
  try {
    const response = await fetch(`${server.url}/api/other/state`)
    assert.equal(response.status, 404)
    assert.equal(calls.length, 0)
  } finally {
    await server.close()
  }
})

test('畸形 URL 编码的工作流 id 返回 400 而不是 500', async () => {
  const { actions } = makeActions()
  const server = await startServer(actions)
  try {
    const response = await fetch(`${server.url}/api/sendcomfy/workflows/%E0%A4%A`)
    assert.equal(response.status, 400)
    assert.equal((await response.json()).ok, false)
  } finally {
    await server.close()
  }
})

test('POST /workflows action=update 透传 description/tags；未知 action 400', async () => {
  const { actions, calls } = makeActions({
    updateWorkflowMeta: async (body) => {
      calls.push(['updateWorkflowMeta', body])
      return { ok: true, workflow: { id: body.id, description: body.description, tags: body.tags }, workflows: [] }
    },
  })
  const server = await startServer(actions)
  try {
    const updated = await getJson(`${server.url}/api/sendcomfy/workflows`, {
      method: 'POST',
      body: JSON.stringify({ action: 'update', id: 'w1', description: '画二次元头像', tags: ['二次元', '头像'] }),
    })
    assert.equal(updated.json.ok, true)
    assert.equal(updated.json.workflow.description, '画二次元头像')
    assert.deepEqual(updated.json.workflow.tags, ['二次元', '头像'])
    assert.equal(calls.at(-1)[1].description, '画二次元头像')

    const bad = await getJson(`${server.url}/api/sendcomfy/workflows`, {
      method: 'POST',
      body: JSON.stringify({ action: 'explode', id: 'w1' }),
    })
    assert.equal(bad.response.status, 400)
    assert.equal(bad.json.ok, false)
  } finally {
    await server.close()
  }
})

test('GET /server-workflows/detail 透传 path 并返回详情', async () => {
  const { actions, calls } = makeActions({
    getServerWorkflowDetail: async (body) => {
      calls.push(['getServerWorkflowDetail', body])
      return { ok: true, fromServer: true, sourcePath: body.path, workflow: { name: 'w', sourcePath: body.path } }
    },
  })
  const server = await startServer(actions)
  try {
    const res = await getJson(`${server.url}/api/sendcomfy/server-workflows/detail?path=krea2.json&name=krea2`)
    assert.equal(res.response.status, 200)
    assert.equal(res.json.workflow.sourcePath, 'krea2.json')
    assert.deepEqual(calls.at(-1)[1], { path: 'krea2.json', name: 'krea2' })
  } finally {
    await server.close()
  }
})
