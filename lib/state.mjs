/**
 * dsh-sendcomfy — 本地状态存储（契约见 CONTRACT.md §3）
 *
 * 状态文件：`$DSH_HOME/sendcomfy/state.json`（DSH_HOME 缺省 `~/.dsh`）。
 *  - dataDir()：返回并确保目录存在。
 *  - createStateStore({ dir })：dir 可传（测试用临时目录），不依赖 cwd。
 *  - store.read()：不存在 -> 默认 State；坏 JSON -> 备份 state.bad-<ts>.json 后回默认。
 *  - store.write(state)：原子写（临时文件 + rename）；写前 normalize。
 *  - store.update(mutator)：read -> mutator -> write，串行化（并发不丢数据）。
 *
 * 零第三方依赖，只 import Node 内建。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { DEFAULT_BASE_URL, normalizeBaseUrl } from './comfy.mjs'

const STATE_FILE = 'state.json'
const DEFAULT_TIMEOUT_SEC = 300
const TIMEOUT_MIN_SEC = 5
const TIMEOUT_MAX_SEC = 3600
const MAX_WORKFLOWS = 100
const MAX_LAST_RUNS = 20
const VALID_SOURCES = new Set(['ui', 'api', 'server'])
const VALID_RUN_STATES = new Set(['queued', 'done', 'error', 'timeout'])
const VALID_PARAM_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'enum'])

/** `$DSH_HOME/sendcomfy`，确保 mkdir -p；DSH_HOME 缺省 ~/.dsh。 */
export function dataDir() {
  const rawHome = process.env.DSH_HOME
  const home = typeof rawHome === 'string' && rawHome.trim()
    ? rawHome.trim()
    : path.join(os.homedir(), '.dsh')
  const dir = path.join(home, 'sendcomfy')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 'dsh-sendcomfy-<随机>'，首次生成后持久。 */
export function newClientId() {
  return `dsh-sendcomfy-${crypto.randomBytes(6).toString('hex')}`
}

/** slug(name)+'-'+6位hex（契约 §3 WorkflowRecord.id）。 */
export function makeWorkflowId(name) {
  const slug = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'workflow'
  return `${slug}-${crypto.randomBytes(3).toString('hex')}`
}

function normalizeIsoString(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? new Date().toISOString() : value.toISOString()
  }
  if (typeof value === 'string' && value.trim()) {
    const time = Date.parse(value)
    if (!Number.isNaN(time)) return new Date(time).toISOString()
  }
  return new Date().toISOString()
}

function normalizeBaseUrlOr(value) {
  try {
    return normalizeBaseUrl(value)
  } catch {
    return DEFAULT_BASE_URL
  }
}

function normalizeTimeoutSec(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_TIMEOUT_SEC
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_TIMEOUT_SEC
  return Math.min(TIMEOUT_MAX_SEC, Math.max(TIMEOUT_MIN_SEC, Math.round(n)))
}

function normalizeClientId(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed && trimmed.length <= 200 && !/\s/.test(trimmed)) return trimmed
  }
  return newClientId()
}

function stringArray(value) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string' && item !== '')
}

function normalizePrimitive(value) {
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (value === undefined || value === null) return ''
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return ''
    }
  }
  return String(value)
}

function normalizeNodes(value) {
  if (!Array.isArray(value)) return []
  const nodes = []
  for (const node of value) {
    if (!node || typeof node !== 'object') continue
    const id = node.id === undefined || node.id === null ? '' : String(node.id)
    const nodeClass = typeof node.class === 'string' ? node.class : (typeof node.type === 'string' ? node.type : '')
    if (!id && !nodeClass) continue
    const out = { id, class: nodeClass }
    if (typeof node.title === 'string' && node.title) out.title = node.title
    nodes.push(out)
  }
  return nodes
}

function normalizeParams(value) {
  if (!Array.isArray(value)) return []
  const params = []
  for (const param of value) {
    if (!param || typeof param !== 'object' || Array.isArray(param)) continue
    const nodeId = param.nodeId === undefined || param.nodeId === null ? '' : String(param.nodeId)
    const inputName = typeof param.inputName === 'string' ? param.inputName : ''
    let paramPath = typeof param.path === 'string' ? param.path : ''
    if (!paramPath && (nodeId || inputName)) paramPath = `${nodeId}.${inputName}`
    if (!paramPath) continue
    const dot = paramPath.indexOf('.')
    const fallbackNodeId = dot >= 0 ? paramPath.slice(0, dot) : nodeId
    const fallbackInputName = dot >= 0 ? paramPath.slice(dot + 1) : inputName
    if (!fallbackInputName) continue
    const value = normalizePrimitive(param.value)
    let type = VALID_PARAM_TYPES.has(param.type) ? param.type : undefined
    if (!type) {
      if (typeof value === 'boolean') type = 'boolean'
      else if (typeof value === 'number') type = Number.isInteger(value) ? 'integer' : 'number'
      else type = 'string'
    }
    const out = {
      path: paramPath,
      nodeId: fallbackNodeId,
      inputName: fallbackInputName,
      nodeClass: typeof param.nodeClass === 'string' ? param.nodeClass : '',
      type,
      value,
    }
    if (typeof param.nodeTitle === 'string' && param.nodeTitle) out.nodeTitle = param.nodeTitle
    const options = stringArray(param.options)
    if (options.length) out.options = options
    for (const key of ['min', 'max', 'step']) {
      const raw = param[key]
      if (raw === undefined || raw === null || raw === '') continue
      const n = Number(raw)
      if (Number.isFinite(n)) out[key] = n
    }
    if (param.multiline === true) out.multiline = true
    if (param.isPrompt === true) out.isPrompt = true
    params.push(out)
  }
  return params
}

function normalizeWorkflow(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const rawName = typeof value.name === 'string' ? value.name.trim() : ''
  const name = rawName ? rawName.slice(0, 200) : '未命名工作流'
  const source = VALID_SOURCES.has(value.source)
    ? value.source
    : (value.uiGraph && typeof value.uiGraph === 'object' ? 'ui' : 'api')
  const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : makeWorkflowId(name)
  const apiGraph = value.apiGraph && typeof value.apiGraph === 'object' && !Array.isArray(value.apiGraph)
    ? value.apiGraph
    : {}
  const workflow = {
    id,
    name,
    source,
    apiGraph,
    nodes: normalizeNodes(value.nodes),
    params: normalizeParams(value.params),
    promptTargets: {
      positive: stringArray(value.promptTargets && value.promptTargets.positive),
      negative: stringArray(value.promptTargets && value.promptTargets.negative),
    },
    createdAt: normalizeIsoString(value.createdAt),
    updatedAt: normalizeIsoString(value.updatedAt),
  }
  if (value.uiGraph !== undefined && value.uiGraph !== null) workflow.uiGraph = value.uiGraph
  const warnings = stringArray(value.warnings)
  if (warnings.length) workflow.warnings = warnings
  // §11：AI 选型用的用途说明 / 标签（缺省不落盘，读取时由 describeWorkflow().summary 兜底）
  const description = typeof value.description === 'string' ? value.description.trim().slice(0, 500) : ''
  if (description) workflow.description = description
  const tags = [...new Set(
    stringArray(value.tags)
      .map((tag) => tag.trim().slice(0, 40))
      .filter(Boolean),
  )].slice(0, 12)
  if (tags.length) workflow.tags = tags
  return workflow
}

function normalizeWorkflows(value) {
  if (!Array.isArray(value)) return []
  const workflows = []
  const seen = new Set()
  for (const item of value) {
    const workflow = normalizeWorkflow(item)
    if (!workflow) continue
    if (seen.has(workflow.id)) continue // id 冲突：新的在前，丢旧的
    seen.add(workflow.id)
    workflows.push(workflow)
    if (workflows.length >= MAX_WORKFLOWS) break
  }
  return workflows
}

function normalizeRunImages(value) {
  if (!Array.isArray(value)) return []
  const images = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    if (typeof item.filename !== 'string' || !item.filename) continue
    const image = {
      filename: item.filename,
      subfolder: typeof item.subfolder === 'string' ? item.subfolder : '',
      type: typeof item.type === 'string' && item.type ? item.type : 'output',
    }
    if (typeof item.contentType === 'string' && item.contentType) image.contentType = item.contentType
    images.push(image)
  }
  return images
}

function normalizeLastRuns(value) {
  if (!Array.isArray(value)) return []
  const runs = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    let promptId = ''
    if (typeof item.promptId === 'string') promptId = item.promptId
    else if (typeof item.prompt_id === 'string') promptId = item.prompt_id
    if (!promptId) continue
    const run = {
      promptId,
      workflowName: typeof item.workflowName === 'string' ? item.workflowName : '',
      state: VALID_RUN_STATES.has(item.state) ? item.state : 'queued',
      createdAt: normalizeIsoString(item.createdAt),
    }
    if (typeof item.workflowId === 'string' && item.workflowId) run.workflowId = item.workflowId
    if (item.durationMs !== undefined && item.durationMs !== null && item.durationMs !== '') {
      const duration = Number(item.durationMs)
      if (Number.isFinite(duration)) run.durationMs = Math.max(0, Math.round(duration))
    }
    const images = normalizeRunImages(item.images)
    if (images.length) run.images = images
    if (typeof item.error === 'string' && item.error) run.error = item.error
    runs.push(run)
    if (runs.length >= MAX_LAST_RUNS) break
  }
  return runs
}

/** 默认 State（每次调用生成新的 clientId）。 */
export function defaultState() {
  return {
    baseUrl: DEFAULT_BASE_URL,
    timeoutSec: DEFAULT_TIMEOUT_SEC,
    clientId: newClientId(),
    workflows: [],
    lastRuns: [],
  }
}

/** 把任意输入 normalize 成合法 State（非法字段回默认、去重、截断）。 */
export function normalizeState(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  return {
    baseUrl: normalizeBaseUrlOr(source.baseUrl),
    timeoutSec: normalizeTimeoutSec(source.timeoutSec),
    clientId: normalizeClientId(source.clientId),
    workflows: normalizeWorkflows(source.workflows),
    lastRuns: normalizeLastRuns(source.lastRuns),
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 创建状态仓库。
 * @param {{ dir?: string }} [options] dir 可选（测试用临时目录）；不传则用 dataDir()。
 */
export function createStateStore({ dir } = {}) {
  const baseDir = typeof dir === 'string' && dir.trim() ? dir.trim() : dataDir()
  fs.mkdirSync(baseDir, { recursive: true })
  const file = path.join(baseDir, STATE_FILE)

  // 所有 read/write/update 走同一条串行队列：并发 update 不会丢数据。
  let chain = Promise.resolve()
  function enqueue(task) {
    const run = chain.then(task, task)
    chain = run.then(() => undefined, () => undefined)
    return run
  }

  async function readFromDisk() {
    let text
    try {
      text = await fsp.readFile(file, 'utf8')
    } catch (err) {
      if (err && err.code === 'ENOENT') return defaultState()
      throw err
    }
    if (!text || !text.trim()) return defaultState()
    try {
      return normalizeState(JSON.parse(text))
    } catch {
      // 坏 JSON：备份后回默认
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const backup = path.join(baseDir, `state.bad-${stamp}-${crypto.randomBytes(2).toString('hex')}.json`)
      try {
        await fsp.rename(file, backup)
      } catch {
        // 备份失败也继续回默认
      }
      return defaultState()
    }
  }

  async function writeToDisk(state) {
    const normalized = normalizeState(state)
    const tmpFile = path.join(
      baseDir,
      `.state.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`,
    )
    const text = `${JSON.stringify(normalized, null, 2)}\n`
    await fsp.writeFile(tmpFile, text, 'utf8')
    try {
      await fsp.rename(tmpFile, file)
    } catch (err) {
      try {
        await fsp.unlink(tmpFile)
      } catch {
        // ignore
      }
      throw err
    }
    return normalized
  }

  return {
    dir: baseDir,
    file,
    /** -> Promise<State>；不存在/坏 JSON 回默认（坏 JSON 先备份）。 */
    read() {
      return enqueue(() => readFromDisk())
    },
    /** -> Promise<State>；原子写，返回 normalize 后的实际内容。 */
    write(state) {
      return enqueue(() => writeToDisk(state))
    },
    /**
     * read -> mutator(state)（原地改或返回新对象）-> write，串行化。
     * -> Promise<State>
     */
    update(mutator) {
      return enqueue(async () => {
        const current = await readFromDisk()
        const result = typeof mutator === 'function' ? await mutator(current) : undefined
        const target = isPlainObject(result) ? result : current
        return writeToDisk(target)
      })
    },
  }
}
