/**
 * dsh-sendcomfy — ComfyUI HTTP 客户端（契约见 CONTRACT.md §2）
 *
 * 纯函数模块：
 *  - 所有网络函数都显式接收 `baseUrl`，不读全局业务状态；
 *  - 网络失败抛 `ComfyError`（带 code）；健康检查类（ping / listUserdataWorkflows）
 *    自己吞错并返回 `{ ok:false, error }`；
 *  - 模块内唯一的状态是 `/object_info` 的 60s 缓存（getObjectInfo / invalidateObjectInfo）。
 *
 * 零第三方依赖：只用 Node 内建 + 全局 fetch / FormData / Blob / AbortSignal.timeout。
 */

import { setTimeout as sleep } from 'node:timers/promises'
import { Buffer } from 'node:buffer'
import { gunzipSync, createInflateRaw, constants as zlibConstants } from 'node:zlib'
import { Readable } from 'node:stream'

export const DEFAULT_BASE_URL = 'http://127.0.0.1:8188'
const DEFAULT_COMFY_PORT = '8188'
const OBJECT_INFO_TTL_MS = 60_000

/** ComfyUI 请求错误。code: EINVALID_URL | EHTTP | ENET | ETIMEDOUT | EBAD_RESPONSE | EINVALID_ARG | ... */
export class ComfyError extends Error {
  constructor(message, options = {}) {
    const opts = typeof options === 'string' ? { code: options } : (options || {})
    super(message == null ? 'ComfyUI 请求失败' : String(message))
    this.name = 'ComfyError'
    this.code = opts.code || 'ECOMFY'
    if (opts.status !== undefined) this.status = opts.status
    if (opts.detail !== undefined) this.detail = opts.detail
    if (opts.cause !== undefined) this.cause = opts.cause
    if (opts.json !== undefined) this.json = opts.json
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      status: this.status,
      detail: this.detail,
    }
  }
}

function invalidUrlError(input) {
  return new ComfyError(`ComfyUI 地址不合法：${JSON.stringify(String(input))}`, {
    code: 'EINVALID_URL',
    detail: String(input),
  })
}

/**
 * 规范化 ComfyUI 地址：
 *  '127.0.0.1:8188' | '192.168.1.5' | 'http://host:8188/' -> 'http://127.0.0.1:8188'
 * 规则：去空白；无 scheme 补 http://；无端口补 :8188；去尾部 '/'；
 *      非 http/https、含空白、端口非法 -> 抛 ComfyError(code='EINVALID_URL')。
 * undefined / null -> 默认 'http://127.0.0.1:8188'；'' -> 抛错。
 */
export function normalizeBaseUrl(input) {
  if (input === undefined || input === null) return DEFAULT_BASE_URL
  if (typeof input !== 'string') throw invalidUrlError(input)

  const raw = input.trim()
  if (!raw) throw invalidUrlError(input)
  if (/\s/.test(raw)) throw invalidUrlError(input)

  // scheme
  let scheme = 'http'
  let rest = raw
  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(raw)
  if (schemeMatch) {
    scheme = schemeMatch[1].toLowerCase()
    rest = raw.slice(schemeMatch[0].length)
  }
  if (scheme !== 'http' && scheme !== 'https') throw invalidUrlError(input)

  // authority + path
  const sepIdx = rest.search(/[/?#]/)
  const authority = sepIdx < 0 ? rest : rest.slice(0, sepIdx)
  let tail = sepIdx < 0 ? '' : rest.slice(sepIdx)
  if (!authority) throw invalidUrlError(input)

  let hostPart = authority
  let port = ''
  if (hostPart.startsWith('[')) {
    // IPv6 字面量：[::1] / [::1]:8188
    const close = hostPart.indexOf(']')
    if (close < 0) throw invalidUrlError(input)
    const after = hostPart.slice(close + 1)
    hostPart = hostPart.slice(0, close + 1)
    if (after) {
      if (!after.startsWith(':')) throw invalidUrlError(input)
      port = after.slice(1)
    }
  } else {
    const colon = hostPart.lastIndexOf(':')
    if (colon >= 0) {
      port = hostPart.slice(colon + 1)
      hostPart = hostPart.slice(0, colon)
    }
  }
  if (!hostPart) throw invalidUrlError(input)
  if (!port) {
    port = DEFAULT_COMFY_PORT
  } else if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw invalidUrlError(input)
  }

  // path（丢弃 query/hash，去掉尾部 '/'）
  const qIdx = tail.search(/[?#]/)
  if (qIdx >= 0) tail = tail.slice(0, qIdx)
  const pathname = tail.replace(/\/+$/, '')
  return `${scheme}://${hostPart}:${port}${pathname}`
}

/** 错误 -> 给人类看的中文字符串（ping/listUserdataWorkflows 的 error 字段用）。 */
export function humanError(err) {
  if (err === undefined || err === null) return '未知错误'
  if (typeof err === 'string') return err
  if (err instanceof ComfyError) return err.message
  if (err.name === 'AbortError') return '已取消'
  const message = typeof err.message === 'string' && err.message ? err.message : String(err)
  const causeCode = err.cause && typeof err.cause === 'object' ? err.cause.code : undefined
  if (causeCode && !message.includes(String(causeCode))) return `${message}（${causeCode}）`
  return message
}

function normalizeRequestPath(path) {
  const p = path === undefined || path === null ? '' : String(path)
  if (!p) return ''
  return p.startsWith('/') ? p : `/${p}`
}

function isFormDataBody(body) {
  return typeof FormData !== 'undefined' && body instanceof FormData
}

function isBinaryBody(body) {
  return body instanceof ArrayBuffer
    || ArrayBuffer.isView(body)
    || (typeof Blob !== 'undefined' && body instanceof Blob)
}

function hasHeader(headers, name) {
  const lower = name.toLowerCase()
  return Object.keys(headers || {}).some((key) => key.toLowerCase() === lower)
}

function normalizeTimeout(timeoutMs, fallback) {
  const n = Number(timeoutMs)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(1, Math.floor(n))
}

function networkError(err, target, timeoutMs) {
  const name = err && err.name
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new ComfyError(`ComfyUI 请求超时（${timeoutMs}ms）：${target}`, {
      code: 'ETIMEDOUT',
      detail: `timeout after ${timeoutMs}ms`,
      cause: err,
    })
  }
  const cause = err && err.cause
  const detail = (cause && (cause.code || cause.message)) || (err && err.message) || String(err)
  return new ComfyError(`无法连接 ComfyUI：${target}（${detail}）`, {
    code: 'ENET',
    detail: String(detail),
    cause: err,
  })
}

function extractDetail(json, text) {
  if (json && typeof json === 'object') {
    if (typeof json.error === 'string' && json.error) return json.error
    if (json.error && typeof json.error === 'object') {
      if (typeof json.error.message === 'string' && json.error.message) return json.error.message
      if (typeof json.error.detail === 'string' && json.error.detail) return json.error.detail
    }
    if (typeof json.message === 'string' && json.message) return json.message
    if (json.node_errors && typeof json.node_errors === 'object' && Object.keys(json.node_errors).length) {
      return `节点错误：${JSON.stringify(json.node_errors).slice(0, 500)}`
    }
  }
  const trimmed = typeof text === 'string' ? text.trim() : ''
  return trimmed.slice(0, 500)
}

async function rawFetch(target, { method = 'GET', body, timeoutMs = 15000, headers } = {}) {
  const timeout = normalizeTimeout(timeoutMs, 15000)
  const init = { method: method.toUpperCase(), signal: AbortSignal.timeout(timeout) }
  if (headers) init.headers = { ...headers }
  if (body !== undefined && body !== null) init.body = body
  try {
    return await fetch(target, init)
  } catch (err) {
    throw networkError(err, target, timeout)
  }
}

/**
 * 通用请求。
 * -> { status, json }（附带 text；json 为解析后的 JSON，非 JSON 响应为 undefined）
 * 非 2xx -> ComfyError(code='EHTTP', status, detail, json)；网络/超时 -> ENET / ETIMEDOUT。
 * body 为普通对象时自动 JSON.stringify + content-type: application/json；
 * body 为 FormData / Uint8Array / Blob 时原样发送。
 */
export async function request(baseUrl, path, { method = 'GET', body, timeoutMs = 15000, headers } = {}) {
  const base = normalizeBaseUrl(baseUrl)
  const target = `${base}${normalizeRequestPath(path)}`
  const timeout = normalizeTimeout(timeoutMs, 15000)

  const init = {
    method: String(method || 'GET').toUpperCase(),
    headers: { ...(headers || {}) },
    signal: AbortSignal.timeout(timeout),
  }
  if (body !== undefined && body !== null) {
    if (isFormDataBody(body) || isBinaryBody(body) || typeof body === 'string') {
      init.body = body
    } else {
      init.body = JSON.stringify(body)
      if (!hasHeader(init.headers, 'content-type')) init.headers['content-type'] = 'application/json'
    }
  }

  let res
  try {
    res = await fetch(target, init)
  } catch (err) {
    throw networkError(err, target, timeout)
  }

  let buffer
  try {
    buffer = Buffer.from(await res.arrayBuffer())
  } catch {
    buffer = Buffer.alloc(0)
  }
  const text = buffer.toString('utf8')
  let json
  if (text) {
    try {
      json = JSON.parse(text.replace(/^\uFEFF/, ''))
    } catch {
      json = undefined
    }
  }

  if (!res.ok) {
    const detail = extractDetail(json, text)
    throw new ComfyError(
      `ComfyUI 请求失败：${init.method} ${target} -> HTTP ${res.status}${detail ? `（${detail}）` : ''}`,
      { code: 'EHTTP', status: res.status, detail, json },
    )
  }
  return { status: res.status, json, text, buffer }
}

// ---------------------------------------------------------------------------
// /system_stats
// ---------------------------------------------------------------------------

/**
 * 连通性检查（永远不抛错）。
 * -> { ok:true, baseUrl, latencyMs, comfyuiVersion?, device?, system? }
 *  | { ok:false, baseUrl, latencyMs, error }
 */
export async function ping(baseUrl, { timeoutMs = 5000 } = {}) {
  const started = Date.now()
  let normalized
  try {
    normalized = normalizeBaseUrl(baseUrl)
  } catch (err) {
    return {
      ok: false,
      baseUrl: baseUrl === undefined || baseUrl === null ? '' : String(baseUrl),
      latencyMs: 0,
      error: humanError(err),
    }
  }
  try {
    const timeout = normalizeTimeout(timeoutMs, 5000)
    const res = await request(normalized, '/system_stats', { timeoutMs: timeout })
    const stats = res.json && typeof res.json === 'object' ? res.json : {}
    const system = stats.system && typeof stats.system === 'object' ? stats.system : undefined
    const devices = Array.isArray(stats.devices) ? stats.devices : []
    const firstDevice = devices[0]
    const device = firstDevice && typeof firstDevice === 'object'
      ? (firstDevice.name ?? firstDevice.type ?? undefined)
      : undefined
    return {
      ok: true,
      baseUrl: normalized,
      latencyMs: Math.max(0, Date.now() - started),
      comfyuiVersion: system ? system.comfyui_version : undefined,
      device: device === undefined ? undefined : String(device),
      system,
    }
  } catch (err) {
    return {
      ok: false,
      baseUrl: normalized,
      latencyMs: Math.max(0, Date.now() - started),
      error: humanError(err),
    }
  }
}

// ---------------------------------------------------------------------------
// /object_info（60s 缓存）
// ---------------------------------------------------------------------------

const objectInfoCache = new Map() // baseUrl -> { data, at } | { promise }

/**
 * 原始 object_info 对象。模块内按 baseUrl 缓存 60s；refresh=true 绕过缓存。
 * 失败抛 ComfyError。
 */
export async function getObjectInfo(baseUrl, { refresh = false, timeoutMs = 30000 } = {}) {
  const base = normalizeBaseUrl(baseUrl)
  const cached = objectInfoCache.get(base)
  if (cached && cached.promise) return cached.promise
  if (!refresh && cached && typeof cached.at === 'number' && Date.now() - cached.at < OBJECT_INFO_TTL_MS) {
    return cached.data
  }

  const promise = (async () => {
    const res = await request(base, '/object_info', { timeoutMs })
    const data = res.json
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new ComfyError('ComfyUI /object_info 返回格式不正确', { code: 'EBAD_RESPONSE' })
    }
    objectInfoCache.set(base, { data, at: Date.now() })
    return data
  })()

  objectInfoCache.set(base, { promise })
  try {
    return await promise
  } catch (err) {
    const current = objectInfoCache.get(base)
    if (current && current.promise === promise) objectInfoCache.delete(base)
    throw err
  }
}

/** 清 object_info 缓存；不给 baseUrl 清全部。 */
export function invalidateObjectInfo(baseUrl) {
  if (baseUrl === undefined || baseUrl === null) {
    objectInfoCache.clear()
    return
  }
  try {
    objectInfoCache.delete(normalizeBaseUrl(baseUrl))
  } catch {
    // 非法 URL 不可能有缓存键，忽略
  }
}

// ---------------------------------------------------------------------------
// 模型清单（从 object_info 的模型枚举里抽）
// ---------------------------------------------------------------------------

const MODEL_EXT_RE = /\.(safetensors|sft|ckpt|pt|pth|bin|gguf|onnx|yaml)$/i

/** 契约 §2 要求的固定类别顺序与展示名。 */
const MODEL_CATEGORIES = [
  ['checkpoints', 'Checkpoints'],
  ['loras', 'LoRAs'],
  ['vae', 'VAE'],
  ['clip', 'CLIP'],
  ['unet', 'UNET/Diffusion'],
  ['controlnet', 'ControlNet'],
  ['upscale', 'Upscale'],
  ['clip_vision', 'CLIP Vision'],
  ['style_models', 'Style models'],
  ['embeddings', 'Embeddings'],
  ['ipadapter', 'IPAdapter'],
  ['gligen', 'GLIGEN'],
  ['other', 'Other models'],
]

/**
 * 已知的「模型加载节点类 -> 类别」映射（可识别标准节点与常见自定义节点族）。
 * 未命中的类走兜底：枚举值是模型文件后缀 -> other。
 */
const KNOWN_CLASS_CATEGORY = [
  [/^CheckpointLoader/i, 'checkpoints'],
  [/LoraLoader|LoraModelLoader|LyCORISLoader|LoRALoader/i, 'loras'],
  [/^VAELoader$|^VAELoader\b/i, 'vae'],
  [/^CLIPVisionLoader$|^CLIPVisionLoader\b/i, 'clip_vision'],
  [/^DualCLIPLoader|^CLIPLoader$|^CLIPLoader\b|^CLIPLoaderGGUF/i, 'clip'],
  [/^UNETLoader$|^UNETLoader\b|^UnetLoaderGGUF/i, 'unet'],
  [/ControlNet/i, 'controlnet'],
  [/UpscaleModel/i, 'upscale'],
  [/StyleModel/i, 'style_models'],
  [/GLIGEN/i, 'gligen'],
  [/IPAdapter/i, 'ipadapter'],
  [/^Embedding/i, 'embeddings'],
]

function enumOptionValues(def) {
  if (Array.isArray(def)) {
    const type = def[0]
    if (Array.isArray(type)) return type.filter((v) => typeof v === 'string')
    return []
  }
  if (def && typeof def === 'object' && Array.isArray(def.options)) {
    return def.options.filter((v) => typeof v === 'string')
  }
  return []
}

function collectInputDefs(spec) {
  const out = []
  const input = spec && typeof spec === 'object' ? spec.input : undefined
  if (!input || typeof input !== 'object') return out
  const groups = [input.required, input.optional].filter((g) => g && typeof g === 'object')
  if (!groups.length) groups.push(input) // 极旧的格式：input 直接是 map
  for (const group of groups) {
    for (const [inputName, def] of Object.entries(group)) out.push([inputName, def])
  }
  return out
}

function classifyModelInput(classType, inputName) {
  const cls = String(classType || '')
  const name = String(inputName || '')

  for (const [re, category] of KNOWN_CLASS_CATEGORY) {
    if (re.test(cls)) return category
  }
  // 兜底：输入名/节点类含模型关键词 -> other
  if (/model|ckpt|checkpoint|lora|vae|clip|unet|diffusion|control.?net|upscale|embedding|ip.?adapter|gligen/i.test(`${name} ${cls}`)) {
    return 'other'
  }
  // 仍然是模型文件枚举（带模型后缀）但没关键词：归 other，别丢模型
  return 'other'
}

/**
 * 从 object_info 抽模型文件。
 * -> { ok, baseUrl, total, categories: [{ id, label, count, files }], warnings?, error? }
 * 失败不抛（ok:false + error）。
 */
export async function listModels(baseUrl, { refresh = false } = {}) {
  let normalized
  try {
    normalized = normalizeBaseUrl(baseUrl)
  } catch (err) {
    return {
      ok: false,
      baseUrl: baseUrl === undefined || baseUrl === null ? '' : String(baseUrl),
      total: 0,
      categories: MODEL_CATEGORIES.map(([id, label]) => ({ id, label, count: 0, files: [] })),
      error: humanError(err),
    }
  }

  let objectInfo
  try {
    objectInfo = await getObjectInfo(normalized, { refresh })
  } catch (err) {
    return {
      ok: false,
      baseUrl: normalized,
      total: 0,
      categories: MODEL_CATEGORIES.map(([id, label]) => ({ id, label, count: 0, files: [] })),
      error: humanError(err),
    }
  }

  const buckets = new Map(MODEL_CATEGORIES.map(([id]) => [id, new Set()]))
  const warnings = []

  try {
    for (const [classType, spec] of Object.entries(objectInfo)) {
      for (const [inputName, def] of collectInputDefs(spec)) {
        const values = enumOptionValues(def)
        if (!values.length) continue
        const files = values.map((v) => v.trim()).filter((v) => v && MODEL_EXT_RE.test(v))
        if (!files.length) continue // 例如 KSampler 的 sampler_name/scheduler、CLIPLoader 的 type
        const categoryId = classifyModelInput(classType, inputName)
        const bucket = buckets.get(categoryId) || buckets.get('other')
        for (const file of files) bucket.add(file)
      }
    }
  } catch (err) {
    warnings.push(`解析 object_info 时出错：${humanError(err)}`)
  }

  const categories = MODEL_CATEGORIES.map(([id, label]) => {
    const files = [...buckets.get(id)].sort((a, b) => a.localeCompare(b))
    return { id, label, count: files.length, files }
  })
  const total = categories.reduce((sum, category) => sum + category.count, 0)
  if (!total) warnings.push('未能从 object_info 中识别出模型文件；请确认 ComfyUI 已加载模型。')

  return { ok: true, baseUrl: normalized, total, categories, warnings }
}

// ---------------------------------------------------------------------------
// /prompt、/history
// ---------------------------------------------------------------------------

/** POST /prompt -> { promptId, number, nodeErrors? }；node_errors 非空也照常返回。 */
export async function queuePrompt(baseUrl, apiGraph, { clientId, timeoutMs = 30000 } = {}) {
  const body = { prompt: apiGraph }
  if (clientId !== undefined && clientId !== null && clientId !== '') body.client_id = String(clientId)
  const res = await request(baseUrl, '/prompt', { method: 'POST', body, timeoutMs })
  const json = res.json && typeof res.json === 'object' ? res.json : {}
  const promptId = json.prompt_id ?? json.promptId
  if (promptId === undefined || promptId === null || promptId === '') {
    throw new ComfyError('ComfyUI /prompt 未返回 prompt_id', {
      code: 'EBAD_RESPONSE',
      detail: JSON.stringify(json).slice(0, 500),
    })
  }
  const out = { promptId: String(promptId) }
  if (json.number !== undefined) out.number = json.number
  const nodeErrors = json.node_errors
  if (nodeErrors && typeof nodeErrors === 'object' && Object.keys(nodeErrors).length) {
    out.nodeErrors = nodeErrors
  }
  return out
}

/** GET /history/{promptId} -> entry | null（没有该 promptId 时 null）。 */
export async function getHistory(baseUrl, promptId, { timeoutMs = 15000 } = {}) {
  const id = String(promptId)
  const res = await request(baseUrl, `/history/${encodeURIComponent(id)}`, { timeoutMs })
  const json = res.json
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null
  if (json[id] && typeof json[id] === 'object') return json[id]
  // 兼容个别网关直接返回 entry
  if (json.status || json.outputs || json.prompt) return json
  const first = Object.values(json).find((v) => v && typeof v === 'object' && ('status' in v || 'outputs' in v))
  return first || null
}

function extractExecutionError(entry) {
  const status = entry && typeof entry.status === 'object' ? entry.status : {}
  const messages = Array.isArray(status.messages) ? status.messages : (Array.isArray(entry?.messages) ? entry.messages : undefined)
  if (Array.isArray(messages)) {
    for (const item of messages) {
      const type = Array.isArray(item) ? item[0] : (item && item.type)
      const data = Array.isArray(item) ? item[1] : item
      if (type === 'execution_error') {
        const message = data && (data.message ?? data.exception_message ?? data.exception_type)
        if (message) return String(message)
      }
    }
  }
  if (status && typeof status.status_str === 'string' && status.status_str === 'error') {
    return 'ComfyUI 工作流执行出错'
  }
  return undefined
}

function classifyHistoryEntry(entry) {
  const status = entry && typeof entry.status === 'object' && entry.status ? entry.status : {}
  const statusStr = status.status_str ?? (entry && typeof entry.status_str === 'string' ? entry.status_str : undefined)
  if (statusStr === 'error') {
    return { state: 'error', error: extractExecutionError(entry) || 'ComfyUI 工作流执行出错' }
  }
  if (statusStr === 'success' || status.completed === true) return { state: 'done' }
  const outputs = entry && entry.outputs
  if (outputs && typeof outputs === 'object' && Object.keys(outputs).length) return { state: 'done' }
  return { state: 'pending' }
}

function makeAbortError(signal) {
  const err = new Error('已取消')
  err.name = 'AbortError'
  err.code = 'EABORT'
  if (signal && signal.reason !== undefined) err.cause = signal.reason
  return err
}

async function sleepOrAbort(ms, signal) {
  if (!(ms > 0)) return
  try {
    await sleep(ms, undefined, signal ? { signal } : undefined)
  } catch (err) {
    if (err && err.name === 'AbortError') throw makeAbortError(signal)
    throw err
  }
}

/**
 * 轮询 /history 直到完成/出错/超时。
 * -> { state:'done'|'error'|'timeout'|'missing', entry?, error? }（超时不抛）
 * signal aborted -> 抛 AbortError。
 */
export async function waitForPrompt(baseUrl, promptId, { timeoutMs = 300000, pollMs = 800, signal } = {}) {
  const totalMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Math.floor(Number(timeoutMs)) : 300000
  const interval = Number.isFinite(Number(pollMs)) && Number(pollMs) > 0 ? Math.max(10, Math.floor(Number(pollMs))) : 800
  const deadline = Date.now() + totalMs
  let lastEntry
  let lastError

  while (true) {
    if (signal && signal.aborted) throw makeAbortError(signal)

    const remaining = deadline - Date.now()
    const requestTimeout = Math.max(1000, Math.min(15000, remaining > 0 ? remaining : 1000))
    try {
      const entry = await getHistory(baseUrl, promptId, { timeoutMs: requestTimeout })
      if (entry) {
        lastEntry = entry
        const verdict = classifyHistoryEntry(entry)
        if (verdict.state === 'done') return { state: 'done', entry }
        if (verdict.state === 'error') return { state: 'error', entry, error: verdict.error }
      }
    } catch (err) {
      if (err && err.name === 'AbortError') throw makeAbortError(signal)
      lastError = err
    }

    if (signal && signal.aborted) throw makeAbortError(signal)
    const left = deadline - Date.now()
    if (left <= 0) {
      const out = { state: 'timeout' }
      if (lastEntry) out.entry = lastEntry
      if (lastError) out.error = humanError(lastError)
      return out
    }
    await sleepOrAbort(Math.min(interval, left), signal)
  }
}

// ---------------------------------------------------------------------------
// /queue、/interrupt
// ---------------------------------------------------------------------------

function normalizeQueueList(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const item of list) {
    let promptId
    let number
    if (Array.isArray(item)) {
      number = item[0]
      promptId = item[1]
    } else if (item && typeof item === 'object') {
      promptId = item.prompt_id ?? item.promptId
      number = item.number
    }
    if (promptId === undefined || promptId === null || promptId === '') continue
    const entry = { prompt_id: String(promptId) }
    if (number !== undefined) entry.number = number
    entry.promptId = entry.prompt_id // 兼容别名（契约 §2 用 snake_case）
    out.push(entry)
  }
  return out
}

/** GET /queue -> { running: [{ prompt_id }], pending: [{ prompt_id }] } */
export async function getQueue(baseUrl, { timeoutMs = 10000 } = {}) {
  const res = await request(baseUrl, '/queue', { timeoutMs })
  const json = res.json && typeof res.json === 'object' ? res.json : {}
  return {
    running: normalizeQueueList(json.queue_running ?? json.running),
    pending: normalizeQueueList(json.queue_pending ?? json.pending),
  }
}

/** POST /interrupt { prompt_id? } -> { ok:true } */
export async function interrupt(baseUrl, promptId) {
  const body = promptId === undefined || promptId === null || promptId === ''
    ? {}
    : { prompt_id: String(promptId) }
  await request(baseUrl, '/interrupt', { method: 'POST', body, timeoutMs: 10000 })
  return { ok: true }
}

/** POST /queue { delete: [...ids] } -> { ok:true } */
export async function deleteQueued(baseUrl, promptIds) {
  const ids = Array.isArray(promptIds) ? promptIds : [promptIds]
  await request(baseUrl, '/queue', {
    method: 'POST',
    body: { delete: ids.filter((id) => id !== undefined && id !== null).map(String) },
    timeoutMs: 10000,
  })
  return { ok: true }
}

/** POST /queue { clear:true } -> { ok:true } */
export async function clearQueue(baseUrl) {
  await request(baseUrl, '/queue', { method: 'POST', body: { clear: true }, timeoutMs: 10000 })
  return { ok: true }
}

// ---------------------------------------------------------------------------
// /view、/upload/image
// ---------------------------------------------------------------------------

/** GET /view?filename=&subfolder=&type= -> { buffer: Buffer, contentType } */
export async function fetchImage(baseUrl, { filename, subfolder = '', type = 'output' } = {}, { timeoutMs = 60000 } = {}) {
  const base = normalizeBaseUrl(baseUrl)
  if (!filename || typeof filename !== 'string') {
    throw new ComfyError('fetchImage 需要 filename', { code: 'EINVALID_ARG' })
  }
  const query = new URLSearchParams({
    filename: String(filename),
    subfolder: String(subfolder ?? ''),
    type: String(type ?? 'output'),
  })
  const res = await rawFetch(`${base}/view?${query.toString()}`, { method: 'GET', timeoutMs })
  if (!res.ok) {
    let detail = ''
    try {
      detail = (await res.text()).slice(0, 500)
    } catch {
      detail = ''
    }
    throw new ComfyError(`下载图片失败：HTTP ${res.status}${detail ? `（${detail}）` : ''}`, {
      code: 'EHTTP',
      status: res.status,
      detail,
    })
  }
  const buffer = Buffer.from(await res.arrayBuffer())
  return {
    buffer,
    contentType: res.headers.get('content-type') || 'application/octet-stream',
  }
}

function guessMime(filename) {
  const lower = String(filename || '').toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  return 'application/octet-stream'
}

/**
 * 上传图片到 ComfyUI input 目录。
 * data: Buffer | Uint8Array；POST /upload/image multipart。
 * -> { name, subfolder, type }；失败抛 ComfyError。
 */
export async function uploadImage(baseUrl, { data, filename, subfolder = '', type = 'input' } = {}, { timeoutMs = 120000 } = {}) {
  const base = normalizeBaseUrl(baseUrl)
  if (!data) throw new ComfyError('uploadImage 需要 data（Buffer/Uint8Array）', { code: 'EINVALID_ARG' })
  const name = typeof filename === 'string' && filename ? filename : 'image.png'
  const bytes = Buffer.isBuffer(data) ? data : new Uint8Array(data)
  const form = new FormData()
  form.append('image', new Blob([bytes], { type: guessMime(name) }), name)
  if (subfolder) form.append('subfolder', String(subfolder))
  form.append('type', String(type ?? 'input'))

  const res = await rawFetch(`${base}/upload/image`, { method: 'POST', body: form, timeoutMs })
  let text = ''
  try {
    text = await res.text()
  } catch {
    text = ''
  }
  let json
  if (text) {
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
  }
  if (!res.ok) {
    const detail = extractDetail(json, text)
    throw new ComfyError(`上传图片失败：HTTP ${res.status}${detail ? `（${detail}）` : ''}`, {
      code: 'EHTTP',
      status: res.status,
      detail,
      json,
    })
  }
  const body = json && typeof json === 'object' ? json : {}
  return {
    name: String(body.name ?? body.filename ?? name),
    subfolder: String(body.subfolder ?? subfolder ?? ''),
    type: String(body.type ?? type ?? 'input'),
  }
}

// ---------------------------------------------------------------------------
// /userdata（服务器侧工作流）
// ---------------------------------------------------------------------------

function parseUserdataList(json) {
  let raw
  if (Array.isArray(json)) {
    raw = json
  } else if (json && typeof json === 'object') {
    for (const key of ['items', 'files', 'workflows', 'data']) {
      if (Array.isArray(json[key])) {
        raw = json[key]
        break
      }
    }
    if (!raw) {
      // { "path/name.json": { size, modified } } 形式
      raw = Object.entries(json).map(([key, value]) => (
        value && typeof value === 'object' ? { path: key, ...value } : { path: key }
      ))
    }
  }
  if (!Array.isArray(raw)) {
    throw new ComfyError('ComfyUI /userdata 返回格式无法识别', { code: 'EBAD_RESPONSE' })
  }

  const items = []
  const seen = new Set()
  for (const entry of raw) {
    let pathValue
    let size
    let modified
    if (typeof entry === 'string') {
      pathValue = entry
    } else if (entry && typeof entry === 'object') {
      pathValue = entry.path ?? entry.name ?? entry.file ?? entry.filename
      size = entry.size ?? entry.bytes
      modified = entry.modified ?? entry.mtime ?? entry.updatedAt
    }
    if (typeof pathValue !== 'string') continue
    const relPath = pathValue.trim().replace(/^\/+/, '')
    if (!relPath || !/\.json$/i.test(relPath)) continue
    if (seen.has(relPath)) continue
    seen.add(relPath)
    const baseName = relPath.split('/').pop() || relPath
    const item = { path: relPath, name: baseName.replace(/\.json$/i, '') }
    const sizeNumber = Number(size)
    if (Number.isFinite(sizeNumber) && sizeNumber >= 0) item.size = sizeNumber
    if (typeof modified === 'string' || typeof modified === 'number') item.modified = modified
    items.push(item)
  }
  return items
}

/**
 * 列出服务器侧（ComfyUI userdata）工作流。
 * -> { ok:true, items:[{ path, name, size?, modified? }] } | { ok:false, error }
 * 任何失败（404 / 网络 / 格式不符）都返回 ok:false，不抛。
 */
export async function listUserdataWorkflows(baseUrl, { timeoutMs = 8000 } = {}) {
  let normalized
  try {
    normalized = normalizeBaseUrl(baseUrl)
  } catch (err) {
    return { ok: false, items: [], error: humanError(err) }
  }
  try {
    const res = await request(normalized, '/userdata?dir=workflows&recurse=true&split=false', { timeoutMs })
    const items = parseUserdataList(res.json)
    return { ok: true, items }
  } catch (err) {
    return { ok: false, items: [], error: humanError(err) }
  }
}

/**
 * 读取服务器侧工作流内容（解析后的 JSON 对象）。
 *
 * ⚠️ ComfyUI 的读取接口与列表接口语义不同（app/user_manager.py 实测）：
 *   - 列表：GET /userdata?dir=workflows&recurse=true&split=false → 文件名相对 workflows/
 *   - 读取：GET /userdata/{file}，其中 file 是**相对 user 根目录**的路径（要带 `workflows/` 前缀），
 *     且 aiohttp 的 `{file}` 不匹配 `/`，所以整条相对路径必须整体 encodeURIComponent（`/` → `%2F`）。
 *     例如：GET /userdata/workflows%2Fdefault.json
 * 之前少了前缀、还多余地带 ?dir=workflows，会对所有文件 404（用户报的「导入没反应」根因）。
 */
/** gzip 头长度（处理 FEXTRA/FNAME/FCOMMENT/FHCRC 这些可选字段）。 */
function gzipHeaderLength(buffer) {
  if (buffer.length < 10) return buffer.length
  let offset = 10
  const flags = buffer[3]
  if (flags & 0x04) {
    if (offset + 2 > buffer.length) return buffer.length
    offset += 2 + buffer.readUInt16LE(offset)
  }
  if (flags & 0x08) {
    while (offset < buffer.length && buffer[offset] !== 0) offset += 1
    offset += 1
  }
  if (flags & 0x10) {
    while (offset < buffer.length && buffer[offset] !== 0) offset += 1
    offset += 1
  }
  if (flags & 0x02) offset += 2
  return Math.min(offset, buffer.length)
}

/**
 * 解码 userdata 里的工作流内容：
 *  - 正常情况是明文 JSON；
 *  - 少数 ComfyUI 目录里的文件是 gzip（甚至「gzip 前缀 + 明文后缀」的半损坏 gzip，
 *    例如 "▶flux-2-klein-图生图洗图流.json"），这里尽力还原成完整 JSON。
 */
async function decodeWorkflowBuffer(buffer) {
  if (!(buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b)) return buffer
  try {
    return gunzipSync(buffer)
  } catch {
    // 继续尝试容错解析
  }
  const headerLength = gzipHeaderLength(buffer)
  const inflater = createInflateRaw({ finishFlush: zlibConstants.Z_SYNC_FLUSH })
  const chunks = []
  try {
    for await (const chunk of Readable.from(buffer.subarray(headerLength)).pipe(inflater)) {
      chunks.push(Buffer.from(chunk))
    }
  } catch {
    // 尾部不是合法 deflate：保留已经解出的部分，后面再拼明文后缀
  }
  const decoded = Buffer.concat(chunks)
  const consumed = Number(inflater.bytesWritten) || 0
  if (decoded.length === 0 || consumed === 0) {
    throw new ComfyError('ComfyUI 返回的工作流是 gzip 且无法解压', { code: 'EBAD_RESPONSE' })
  }
  // 先看解出的部分是不是完整 JSON（有些文件是「完整 gzip 工作流 + 明文垃圾尾巴」）
  try {
    JSON.parse(decoded.toString('utf8').replace(/^\uFEFF/, ''))
    return decoded
  } catch {
    // 继续尝试拼回明文后缀
  }
  // deflate 结束后还有 8 字节 gzip 尾部（CRC32 + ISIZE），其余部分当作明文后缀拼回去
  const suffixStart = headerLength + consumed + 8
  const candidate = Buffer.concat([decoded, buffer.subarray(Math.min(suffixStart, buffer.length))])
  try {
    JSON.parse(candidate.toString('utf8').replace(/^\uFEFF/, ''))
  } catch {
    throw new ComfyError('ComfyUI 返回的工作流既不是合法 gzip 也不是合法 JSON', { code: 'EBAD_RESPONSE' })
  }
  return candidate
}

export async function getUserdataWorkflow(baseUrl, path, { timeoutMs = 15000 } = {}) {
  const base = normalizeBaseUrl(baseUrl)
  if (!path || typeof path !== 'string') {
    throw new ComfyError('getUserdataWorkflow 需要 path', { code: 'EINVALID_ARG' })
  }
  const clean = path.trim().replace(/^\/+/, '')
  const relative = /^workflows\//i.test(clean) ? clean : `workflows/${clean}`
  // ⚠️ ComfyUI 的 user_manager 会对 match_info 里含 '%' 的值再做一次 unquote；
  //    所以先把 encodeURIComponent 结果中的 '%' 再转义一层（% → %25），
  //    否则文件名里字面带 %20 的工作流（如 "Character%20Studio..."）会 404。
  const encoded = encodeURIComponent(relative).replace(/%/g, '%25')
  const res = await request(base, `/userdata/${encoded}`, { timeoutMs })
  let buffer = res.buffer || Buffer.alloc(0)
  // 有些 ComfyUI 用户目录里的工作流是 gzip（或半损坏 gzip），统一走容错解码
  buffer = await decodeWorkflowBuffer(buffer)
  let parsed
  try {
    parsed = JSON.parse(buffer.toString('utf8').replace(/^\uFEFF/, ''))
  } catch {
    parsed = undefined
  }
  if (parsed === undefined || parsed === null) {
    throw new ComfyError('ComfyUI 工作流内容为空或不是 JSON', {
      code: 'EBAD_RESPONSE',
      detail: clean,
    })
  }
  return parsed
}
