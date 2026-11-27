/**
 * dsh-sendcomfy —— /api/sendcomfy/* 的 HTTP 适配层
 * ============================================================================
 * 只做「请求 → actions → JSON」的翻译，不写业务逻辑：
 *   - 浏览器半端（client.js）全部走这些同源路由，不直连 ComfyUI；
 *   - 路由由 Host 插件的 ctx.webServer.register({ kind:'prefix', path:'/api/sendcomfy' }) 挂上。
 *
 * 响应约定：动作级失败也返回 HTTP 200 + `{ ok:false, error }`（面板统一看 json.ok），
 * 只有协议错误（坏 JSON / 超大 body / 未知路由）用 4xx/5xx。
 *
 * 诊断：每个请求完成时追加一行到 `$DSH_HOME/sendcomfy/requests.log`
 * （method / 路由 / HTTP 状态 / 耗时 / 请求体摘要；不含图片二进制与完整工作流 JSON），
 * 用于排查「点了按钮没反应」这类前端问题。日志写失败绝不影响请求。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_PREFIX = '/api/sendcomfy'
const MAX_BODY_BYTES = 5 * 1024 * 1024
const MAX_LOG_BYTES = 1024 * 1024

let requestLogPath = null
function resolveRequestLogPath() {
  if (requestLogPath) return requestLogPath
  try {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    const dir = path.join(home, 'sendcomfy')
    fs.mkdirSync(dir, { recursive: true })
    requestLogPath = path.join(dir, 'requests.log')
    return requestLogPath
  } catch {
    return null
  }
}

function summarizeBody(value) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'object') return String(value).slice(0, 120)
  const parts = []
  for (const key of ['action', 'id', 'name', 'path', 'workflow', 'baseUrl']) {
    if (value[key] !== undefined && value[key] !== null && typeof value[key] !== 'object') {
      parts.push(`${key}=${String(value[key]).slice(0, 80)}`)
    }
  }
  if (typeof value.json === 'string') parts.push(`jsonLen=${value.json.length}`)
  if (value.prompt !== undefined) parts.push('prompt=…')
  if (value.params !== undefined) parts.push('params=…')
  return parts.join(' ')
}

function appendRequestLog(line) {
  try {
    const file = resolveRequestLogPath()
    if (!file) return
    try {
      if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`)
    } catch {
      /* 文件还不存在 */
    }
    fs.appendFileSync(file, `${line}\n`)
  } catch {
    /* 日志失败不影响请求 */
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value === undefined ? null : value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw httpError(413, '请求体过大（上限 5MB）')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

async function readJson(req) {
  const buffer = await readBody(req)
  if (buffer.length === 0) return {}
  const text = buffer.toString('utf8').trim()
  if (text === '') return {}
  try {
    const value = JSON.parse(text)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw httpError(400, '请求体必须是 JSON 对象')
    }
    req.__sendcomfyBody = value
    return value
  } catch (error) {
    if (error?.status) throw error
    throw httpError(400, `请求体不是合法 JSON：${error?.message || error}`)
  }
}

function truthyQuery(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase())
}

/** 回环主机名（Host 头去掉端口后的小写形式）。 */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1', '[::ffff:127.0.0.1]'])

function hostnameOf(authority) {
  const text = String(authority || '').trim().toLowerCase()
  if (text.startsWith('[')) return text.slice(0, text.indexOf(']') + 1)
  return text.replace(/:\d+$/, '')
}

function isLoopbackHostname(hostname) {
  return LOOPBACK_HOSTNAMES.has(hostname) || /^127\.\d+\.\d+\.\d+$/.test(hostname)
}

/**
 * 本机回环栅栏 —— 在没有 DSH `connection` 服务可用时的兜底准入检查。
 *
 * 规则（比 connection 的弱，但挡住主要的两种攻击）：
 *   1. `Host` 必须是回环地址，挡住 DNS rebinding（把 evil.com 解析到 127.0.0.1）；
 *   2. 若带 `Origin`，必须与 `Host` 同源，挡住别的网页对我们发起跨站请求；
 *      `Origin: null`（sandbox iframe / file://）一律拒绝。
 *
 * 拿到 `connection` 服务时不会走到这里 —— 那条路径额外带浏览器登录态校验。
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {403 | undefined} 拒绝状态码，或 undefined 表示放行
 */
export function loopbackAdmission(req) {
  const headers = (req && req.headers) || {}
  const host = String(headers.host || '')
  if (!isLoopbackHostname(hostnameOf(host))) return 403
  const origin = headers.origin
  if (origin === undefined || origin === '') return undefined
  if (String(origin).toLowerCase() === 'null') return 403
  try {
    const originAuthority = new URL(String(origin)).host
    return originAuthority.toLowerCase() === host.toLowerCase() ? undefined : 403
  } catch {
    return 403
  }
}

/**
 * @param {ReturnType<import('./actions.mjs').createActions>} actions
 * @param {{
 *   prefix?: string,
 *   admit?: (req: import('node:http').IncomingMessage) => (401 | 403 | undefined),
 * }} [options]
 *   `admit` 是准入检查：返回 401/403 表示拒绝，返回 undefined 表示放行。
 *   不给时不做检查（仅供测试与无宿主场景），Host 插件总会传一个。
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createApiHandler(actions, { prefix = DEFAULT_PREFIX, admit } = {}) {
  return async function handle(req, res) {
    if (!req || !res) return
    const startedAt = Date.now()
    let responseStatus = 200
    try {
      const originalWriteHead = res.writeHead
      res.writeHead = function writeHeadPatched(status, ...rest) {
        responseStatus = Number(status) || 200
        return originalWriteHead.call(this, status, ...rest)
      }
      res.once('finish', () => {
        const pathname = (() => {
          try {
            return new URL(req.url || '/', 'http://127.0.0.1').pathname
          } catch {
            return String(req.url || '')
          }
        })()
        appendRequestLog([
          new Date().toISOString(),
          String(req.method || 'GET').toUpperCase(),
          pathname,
          String(responseStatus),
          `${Date.now() - startedAt}ms`,
          summarizeBody(req.__sendcomfyBody),
        ].filter(Boolean).join(' '))
      })
    } catch {
      /* 诊断失败不影响请求 */
    }
    // 准入检查必须在任何路由分发之前：所有 /api/sendcomfy/* 都能读到配置、
    // 触发 ComfyUI 生成、上传图片，未鉴权的请求一条也不该被处理。
    if (typeof admit === 'function') {
      let rejection
      try {
        rejection = admit(req)
      } catch {
        rejection = 403
      }
      if (rejection === 401 || rejection === 403) {
        sendJson(res, rejection, {
          ok: false,
          error: '请求未通过 DSH 准入检查（Host/Origin 栅栏或浏览器登录态）',
        })
        return
      }
    }
    let url
    try {
      url = new URL(req.url || '/', 'http://127.0.0.1')
    } catch {
      sendJson(res, 400, { ok: false, error: '非法请求 URL' })
      return
    }
    const { pathname } = url
    if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) {
      sendJson(res, 404, { ok: false, error: `未知接口：${pathname}` })
      return
    }
    const sub = pathname.slice(prefix.length).replace(/\/+$/, '') || '/'
    const method = String(req.method || 'GET').toUpperCase()
    const wfMatch = /^\/workflows\/([^/]+)$/.exec(sub)

    try {
      /* ── 状态 / 连接 ─────────────────────────────────────── */
      if (method === 'GET' && sub === '/state') {
        sendJson(res, 200, await actions.getState())
        return
      }
      if (method === 'POST' && sub === '/config') {
        sendJson(res, 200, await actions.setConfig(await readJson(req)))
        return
      }
      if (method === 'POST' && sub === '/test') {
        sendJson(res, 200, await actions.test(await readJson(req)))
        return
      }

      /* ── 模型 ────────────────────────────────────────────── */
      if (method === 'GET' && sub === '/models') {
        sendJson(res, 200, await actions.listModels({ refresh: truthyQuery(url.searchParams.get('refresh')) }))
        return
      }

      /* ── 工作流 ──────────────────────────────────────────── */
      if (method === 'GET' && sub === '/workflows') {
        sendJson(res, 200, await actions.listWorkflows())
        return
      }
      if (method === 'GET' && wfMatch) {
        let workflowId
        try {
          workflowId = decodeURIComponent(wfMatch[1])
        } catch {
          throw httpError(400, '工作流 id 的 URL 编码不合法')
        }
        sendJson(res, 200, await actions.getWorkflow(workflowId))
        return
      }
      if (method === 'POST' && sub === '/workflows') {
        const body = await readJson(req)
        const action = String(body.action || '')
        if (action === 'import') {
          sendJson(res, 200, await actions.importWorkflow({ name: body.name, json: body.json, source: body.source }))
          return
        }
        if (action === 'rename') {
          sendJson(res, 200, await actions.renameWorkflow({ id: body.id, name: body.name }))
          return
        }
        if (action === 'update') {
          sendJson(res, 200, await actions.updateWorkflowMeta({
            id: body.id,
            description: body.description,
            tags: body.tags,
          }))
          return
        }
        if (action === 'delete') {
          sendJson(res, 200, await actions.deleteWorkflow(body.id))
          return
        }
        throw httpError(400, `未知 action：${action || '(空)'}（可用 import / rename / delete）`)
      }

      /* ── ComfyUI 服务器上的工作流 ─────────────────────────── */
      if (method === 'GET' && sub === '/server-workflows') {
        sendJson(res, 200, await actions.listServerWorkflows())
        return
      }
      if (method === 'GET' && sub === '/server-workflows/detail') {
        sendJson(res, 200, await actions.getServerWorkflowDetail({
          path: url.searchParams.get('path') || '',
          name: url.searchParams.get('name') || undefined,
        }))
        return
      }
      if (method === 'POST' && sub === '/server-workflows') {
        const body = await readJson(req)
        if (String(body.action || '') !== 'import') {
          throw httpError(400, `未知 action：${body.action || '(空)'}（可用 import）`)
        }
        sendJson(res, 200, await actions.importServerWorkflow({ path: body.path, name: body.name }))
        return
      }

      /* ── 运行 / 结果 / 队列 ──────────────────────────────── */
      if (method === 'POST' && sub === '/run') {
        const body = await readJson(req)
        sendJson(res, 200, await actions.run({
          workflow: body.workflow,
          prompt: body.prompt,
          negativePrompt: body.negativePrompt,
          params: body.params,
          wait: body.wait === false ? false : true,
          timeoutSec: body.timeoutSec,
          saveDir: null,
        }))
        return
      }
      if (method === 'GET' && sub === '/image') {
        const result = await actions.getImage({
          filename: url.searchParams.get('filename') || '',
          subfolder: url.searchParams.get('subfolder') || '',
          type: url.searchParams.get('type') || 'output',
        })
        if (!result.ok || !result.buffer) {
          sendJson(res, 404, { ok: false, error: result.error || '图片不存在' })
          return
        }
        res.writeHead(200, {
          'Content-Type': result.contentType || 'application/octet-stream',
          'Content-Length': result.buffer.length,
          'Cache-Control': 'no-store',
        })
        res.end(result.buffer)
        return
      }
      if (method === 'GET' && sub === '/queue') {
        sendJson(res, 200, await actions.getQueue())
        return
      }
      if (method === 'POST' && sub === '/cancel') {
        const body = await readJson(req)
        sendJson(res, 200, await actions.cancel({ promptId: body.promptId }))
        return
      }

      sendJson(res, 404, { ok: false, error: `未知接口：${method} ${pathname}` })
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500
      sendJson(res, status, { ok: false, error: error?.message || String(error) })
    }
  }
}

export default createApiHandler
