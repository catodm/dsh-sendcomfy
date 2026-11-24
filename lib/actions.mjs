/**
 * dsh-sendcomfy —— Host 动作层
 * ============================================================================
 * 所有「应用操作」都在这里实现一次（user-actions 原则），两个调用方共用：
 *   - lib/http.mjs 的 /api/sendcomfy/* 路由（网页面板）
 *   - index.js 注册的 comfy_* 工具（会话里的文本模型）
 *
 * 依赖（契约见 CONTRACT.md）：
 *   ./comfy.mjs    ComfyUI HTTP 客户端（显式传 baseUrl）
 *   ./workflow.mjs 工作流解析 / UI→API / 参数推导
 *   ./state.mjs    $DSH_HOME/sendcomfy/state.json 持久化
 *
 * 约定：对外方法一律 async、返回无损 JSON 可序列化对象；可预期的失败返回
 * `{ ok:false, error, warnings? }` 而不是抛异常（HTTP 层与工具层都直接透传）。
 */
import { randomBytes } from 'node:crypto'
import { mkdir, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'

import * as comfy from './comfy.mjs'
import * as capabilities from './capabilities.mjs'
import * as workflow from './workflow.mjs'
import { createStateStore } from './state.mjs'

const WORKFLOW_LIMIT = 100
const RUN_LIMIT = 20
const MAX_SAVE_BYTES = 64 * 1024 * 1024 // 单张输出图上限，防异常的 Comfy 返回把磁盘写爆

/* ───────────────────────────── 小工具 ───────────────────────────── */

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** 把异常翻成人话（不同 code 给不同提示，便于面板与模型都看懂）。 */
export function humanizeError(error, baseUrl) {
  if (!error) return '未知错误'
  const code = error.code || ''
  const where = baseUrl ? `（${baseUrl}）` : ''
  switch (code) {
    case 'EINVALID_URL':
      return `ComfyUI 地址无效${where}：${error.message}`
    case 'ENET':
      return `连不上 ComfyUI${where}，检查地址、端口以及 ComfyUI 是否已经启动：${error.message || ''}`
    case 'ETIMEDOUT':
      return `请求 ComfyUI 超时${where}：${error.message || ''}`
    case 'EHTTP':
      return `ComfyUI 返回 HTTP ${error.status ?? '?'}${where}${error.detail ? `：${String(error.detail).slice(0, 300)}` : ''}`
    default:
      return error.message || String(error)
  }
}

function clampTimeoutSec(value, fallback = 300) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(3600, Math.max(5, Math.round(n)))
}

function slugify(name) {
  const base = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return base || 'workflow'
}

function newWorkflowId(name, taken) {
  const slug = slugify(name)
  for (let i = 0; i < 50; i += 1) {
    const id = `${slug}-${randomBytes(3).toString('hex')}`
    if (!taken.has(id)) return id
  }
  return `${slug}-${Date.now().toString(36)}`
}

/** §11 能力画像：从 API 图推导「这个工作流是干什么的」。任何异常都降级成 other，不阻断动作。 */
function capabilitiesOf(record) {
  let result
  try {
    result = capabilities.describeWorkflow(record?.apiGraph || {})
  } catch (error) {
    // 能力推导是只读增强：失败时降级成 other，日志交给调用方（这里不依赖 createActions 内的 logger）
    result = {
      kinds: ['other'],
      kindLabels: ['其他'],
      hasPrompt: false,
      hasNegative: false,
      classes: [],
      models: [],
      neededInputs: [],
      outputKinds: [],
      summary: '无法识别的工作流',
    }
  }
  // describeWorkflow 只看图；promptTargets 是 buildParamSpecs 的拓扑推断结果，补上它更准
  const targets = record?.promptTargets
  if (targets && typeof targets === 'object') {
    if (Array.isArray(targets.negative) && targets.negative.length > 0) result.hasNegative = true
    if (Array.isArray(targets.positive) && targets.positive.length > 0) result.hasPrompt = true
  }
  return result
}

/** 按服务器工作流路径/文件名猜能力（仅用于选型排序；拿不到图时并非精确信息）。 */
function guessKindsFromName(path) {
  const name = String(path || '').toLowerCase()
  const kinds = []
  const add = (kind) => { if (!kinds.includes(kind)) kinds.push(kind) }
  if (/视频|video|h3|wan|ltx|moss|vhs|animate|动图|动画|导演台|i2v|t2v/.test(name)) add('video')
  if (/声音|音频|tts|audio|voice|voxcpm|音乐|克隆/.test(name)) add('audio')
  if (/放大|超分|upscale|hires/.test(name)) add('upscale')
  if (/局部|inpaint|修复|抹除/.test(name)) add('inpaint')
  if (/图生图|编辑|洗图|img2img|ref|重绘/.test(name)) add('img2img')
  if (/线稿|姿势|controlnet|canny|pose/.test(name)) add('controlnet')
  if (/lora/.test(name)) add('lora')
  if (/文生图|t2i|txt2img|krea|qwenimage|zimage|flux|sdxl|sd15|生成|closerai|minimax/.test(name)) add('txt2img')
  return kinds
}

/** 用户/AI 输错的 tags 宽容处理成干净数组。 */
function normalizeTagsInput(tags) {
  let list
  if (Array.isArray(tags)) list = tags
  else if (typeof tags === 'string') list = tags.split(/[，,、\n]/)
  else return null
  return [...new Set(
    list
      .map((tag) => String(tag ?? '').trim())
      .filter((tag) => tag.length > 0),
  )]
}

function summarizeWorkflow(record) {
  const capabilities = capabilitiesOf(record)
  const description = typeof record.description === 'string' && record.description.trim()
    ? record.description.trim()
    : capabilities.summary
  const nodeCount = Array.isArray(record.nodes) && record.nodes.length > 0
    ? record.nodes.length
    : Object.keys(record.apiGraph || {}).length
  const paramCount = Array.isArray(record.params) ? record.params.length : 0
  return {
    id: record.id,
    name: record.name,
    nodeCount,
    paramCount,
    source: record.source || 'api',
    ...(record.sourcePath ? { sourcePath: record.sourcePath } : {}),
    description,
    tags: Array.isArray(record.tags) ? record.tags : [],
    kinds: capabilities.kinds,
    kindLabels: capabilities.kindLabels,
    neededInputCount: Array.isArray(capabilities.neededInputs) ? capabilities.neededInputs.length : 0,
    createdAt: record.createdAt || null,
    updatedAt: record.updatedAt || null,
  }
}


function detailWorkflow(record) {
  const capabilities = capabilitiesOf(record)
  return {
    ...summarizeWorkflow(record),
    params: record.params || [],
    promptTargets: record.promptTargets || { positive: [], negative: [] },
    nodes: record.nodes || [],
    warnings: record.warnings || [],
    capabilities,
    hasPrompt: capabilities.hasPrompt,
    hasNegative: capabilities.hasNegative,
    neededInputs: capabilities.neededInputs,
  }
}

export function imageUrl(image) {
  const search = new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder || '',
    type: image.type || 'output',
  })
  return `/api/sendcomfy/image?${search.toString()}`
}

function imageMime(filename) {
  const lower = String(filename || '').toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.bmp')) return 'image/bmp'
  return 'application/octet-stream'
}

function findWorkflow(state, idOrName) {
  const wanted = trimmed(idOrName)
  if (!wanted) return undefined
  const list = Array.isArray(state.workflows) ? state.workflows : []
  return (
    list.find((w) => w.id === wanted)
    || list.find((w) => w.name === wanted)
    || list.find((w) => String(w.name || '').toLowerCase() === wanted.toLowerCase())
  )
}

function uniqueRunImageName(filename) {
  const safe = String(filename || 'image.png').replace(/[/\\:*?"<>|]/g, '_').replace(/^\.+/, '') || 'image.png'
  return safe
}

async function fileExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function objectInfoSafe(baseUrl, { refresh = false } = {}) {
  try {
    return await comfy.getObjectInfo(baseUrl, { refresh, timeoutMs: 8000 })
  } catch {
    return null
  }
}

/** 从 history entry 里收集输出图片，可选落盘。 */
async function collectImages(baseUrl, entry, saveDir, warnings) {
  const images = []
  const outputs = entry && typeof entry === 'object' ? entry.outputs || {} : {}
  for (const nodeId of Object.keys(outputs)) {
    const nodeOutput = outputs[nodeId]
    const list = nodeOutput && Array.isArray(nodeOutput.images) ? nodeOutput.images : []
    for (const item of list) {
      if (!item || typeof item.filename !== 'string' || item.filename === '') continue
      images.push({
        filename: item.filename,
        subfolder: typeof item.subfolder === 'string' ? item.subfolder : '',
        type: typeof item.type === 'string' ? item.type : 'output',
        mime: imageMime(item.filename),
      })
    }
  }
  if (!saveDir || images.length === 0) return images

  let dir = saveDir
  try {
    await mkdir(dir, { recursive: true })
  } catch (error) {
    warnings.push(`输出目录不可用，图片只返回代理链接：${error?.message || error}`)
    return images
  }
  for (const image of images) {
    try {
      const { buffer, contentType } = await comfy.fetchImage(baseUrl, image)
      if (buffer.length > MAX_SAVE_BYTES) {
        warnings.push(`图片 ${image.filename} 超过 ${MAX_SAVE_BYTES} 字节，跳过落盘`)
        continue
      }
      const name = uniqueRunImageName(image.filename)
      let target = join(dir, name)
      if (await fileExists(target)) {
        const dot = name.lastIndexOf('.')
        const stem = dot > 0 ? name.slice(0, dot) : name
        const ext = dot > 0 ? name.slice(dot) : ''
        let i = 2
        while (await fileExists(target)) {
          target = join(dir, `${stem}-${i}${ext}`)
          i += 1
        }
      }
      await writeFile(target, buffer)
      image.path = target
      if (contentType) image.mime = contentType
    } catch (error) {
      warnings.push(`图片 ${image.filename} 下载失败：${humanizeError(error, baseUrl)}`)
    }
  }
  return images
}

/* ─────────────────────────── 动作工厂 ─────────────────────────── */

export function createActions({ store = createStateStore(), logger = () => {} } = {}) {
  const log = (...args) => {
    try {
      logger(...args)
    } catch {
      /* 日志失败不影响动作 */
    }
  }

  async function recordRun(run) {
    try {
      await store.update((state) => {
        const list = Array.isArray(state.lastRuns) ? state.lastRuns : []
        const index = list.findIndex((item) => item.promptId === run.promptId)
        if (index >= 0) list.splice(index, 1, { ...list[index], ...run })
        else list.unshift(run)
        state.lastRuns = list.slice(0, RUN_LIMIT)
        return state
      })
    } catch (error) {
      log('记录运行历史失败：', error?.message || error)
    }
  }

  /**
   * 读取工作流时尽量用当前 ComfyUI 的 object_info 刷新参数元数据
   * （枚举选项、min/max 会随 ComfyUI 版本/自定义节点变化）。
   */
  async function refreshRecord(record, baseUrl, info) {
    if (!info) return { record, changed: false }
    try {
      const built = workflow.buildParamSpecs(record.apiGraph, info)
      const before = JSON.stringify([record.params || [], record.promptTargets || {}])
      const after = JSON.stringify([built.params || [], built.promptTargets || {}])
      if (before === after) return { record, changed: false }
      const next = {
        ...record,
        params: built.params,
        promptTargets: built.promptTargets,
        updatedAt: new Date().toISOString(),
      }
      return { record: next, changed: true }
    } catch (error) {
      log('刷新工作流参数失败：', error?.message || error)
      return { record, changed: false }
    }
  }

  async function persistRecord(next) {
    try {
      await store.update((state) => {
        const index = state.workflows.findIndex((w) => w.id === next.id)
        if (index >= 0) state.workflows.splice(index, 1, next)
        return state
      })
    } catch (error) {
      log('写回工作流失败：', error?.message || error)
    }
  }

  /** 服务器工作流路径 → 默认显示名（去目录与 .json）。 */
  function serverNameOf(path) {
    const base = String(path || '').replace(/\\/g, '/').split('/').pop() || 'server-workflow'
    return base.replace(/\.json$/i, '')
  }

  /** 去掉可能带上的 `server:` 前缀。 */
  function serverPathOf(ref) {
    return trimmed(ref).replace(/^server:/i, '')
  }

  /** 看起来像服务器工作流路径（以 .json 结尾）。 */
  function looksLikeServerPath(ref) {
    return /\.json$/i.test(serverPathOf(ref))
  }

  /**
   * 按需从 ComfyUI 服务器加载工作流（不写本地库）。「use 时先加载再运行」的核心。
   * -> { record, live }；失败抛 ComfyError。
   */
  async function loadServerRecord({ baseUrl, path, name } = {}) {
    const target = trimmed(path)
    if (!target) throw new Error('需要 ComfyUI 服务器上的工作流路径')
    const raw = await comfy.getUserdataWorkflow(baseUrl, target)
    const info = await objectInfoSafe(baseUrl)
    const merged = workflow.mergeImport({ name: trimmed(name) || serverNameOf(target), raw, objectInfo: info || undefined })
    const capabilities = capabilitiesOf({ apiGraph: merged.apiGraph })
    const now = new Date().toISOString()
    return {
      live: Boolean(info),
      record: {
        id: `server:${target}`,
        name: merged.name,
        source: 'server',
        sourcePath: target,
        apiGraph: merged.apiGraph,
        uiGraph: merged.uiGraph,
        nodes: merged.nodes || [],
        params: merged.params || [],
        promptTargets: merged.promptTargets || { positive: [], negative: [] },
        description: capabilities.summary,
        tags: [],
        warnings: merged.warnings || [],
        createdAt: now,
        updatedAt: now,
      },
    }
  }

  const api = {
    /* ── 状态 / 配置 ─────────────────────────────────────────── */

    async getState() {
      const state = await store.read()
      const lastRuns = (state.lastRuns || []).map((run) => ({
        ...run,
        images: (run.images || []).map((image) => ({ ...image, url: imageUrl(image) })),
      }))
      return {
        ok: true,
        baseUrl: state.baseUrl,
        timeoutSec: state.timeoutSec,
        clientId: state.clientId,
        workflows: (state.workflows || []).map(summarizeWorkflow),
        lastRuns,
      }
    },

    async setConfig({ baseUrl, timeoutSec } = {}) {
      const patch = {}
      if (baseUrl !== undefined && baseUrl !== null) {
        try {
          patch.baseUrl = comfy.normalizeBaseUrl(String(baseUrl))
        } catch (error) {
          return { ok: false, error: humanizeError(error) }
        }
      }
      if (timeoutSec !== undefined && timeoutSec !== null && timeoutSec !== '') {
        const n = Number(timeoutSec)
        if (!Number.isFinite(n) || n <= 0) return { ok: false, error: '超时必须是正数（秒）' }
        patch.timeoutSec = clampTimeoutSec(n)
      }
      if (Object.keys(patch).length === 0) return { ok: false, error: '没有要保存的配置' }
      const state = await store.update((current) => {
        Object.assign(current, patch)
        return current
      })
      return { ok: true, baseUrl: state.baseUrl, timeoutSec: state.timeoutSec }
    },

    async test({ baseUrl } = {}) {
      const state = await store.read()
      let target = state.baseUrl
      if (baseUrl !== undefined && baseUrl !== null && String(baseUrl).trim() !== '') {
        try {
          target = comfy.normalizeBaseUrl(String(baseUrl))
        } catch (error) {
          return { ok: false, baseUrl: String(baseUrl), reachable: false, error: humanizeError(error) }
        }
      }
      const result = await comfy.ping(target)
      const pingError = result.ok === true
        ? undefined
        : typeof result.error === 'string'
          ? result.error
          : humanizeError({ code: result.error?.code, message: result.error?.message, status: result.error?.status }, target)
      return { ...result, baseUrl: target, reachable: result.ok === true, error: pingError }
    },

    async invalidateModels() {
      try {
        const state = await store.read()
        comfy.invalidateObjectInfo(state.baseUrl)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: humanizeError(error) }
      }
    },

    /* ── 模型 ────────────────────────────────────────────────── */

    async listModels({ refresh = false } = {}) {
      const state = await store.read()
      try {
        const result = await comfy.listModels(state.baseUrl, { refresh: Boolean(refresh) })
        if (!result || result.ok === false) {
          return {
            ok: false,
            baseUrl: state.baseUrl,
            error: result?.error || '拿不到 ComfyUI 模型列表',
          }
        }
        return { ...result, ok: true, baseUrl: state.baseUrl }
      } catch (error) {
        return { ok: false, baseUrl: state.baseUrl, error: humanizeError(error, state.baseUrl) }
      }
    },

    /* ── 工作流 ──────────────────────────────────────────────── */

    async listWorkflows() {
      const state = await store.read()
      return { ok: true, workflows: (state.workflows || []).map(summarizeWorkflow) }
    },

    async getWorkflow(idOrName) {
      const state = await store.read()
      let record = findWorkflow(state, idOrName)
      let fromServer = false
      if (!record && looksLikeServerPath(idOrName)) {
        try {
          const loaded = await loadServerRecord({ baseUrl: state.baseUrl, path: serverPathOf(idOrName) })
          record = loaded.record
          fromServer = true
        } catch (error) {
          return { ok: false, error: humanizeError(error, state.baseUrl) }
        }
      }
      if (!record) {
        return {
          ok: false,
          error: `没有找到工作流：${trimmed(idOrName) || '(空)'}。本地库没有的话，用 comfy_workflows 查看 ComfyUI 服务器上的工作流，再用它的 path 直接 comfy_run`,
        }
      }
      if (fromServer) {
        return {
          ok: true,
          live: true,
          fromServer: true,
          sourcePath: record.sourcePath,
          workflow: detailWorkflow(record),
          warnings: record.warnings || [],
        }
      }
      const info = await objectInfoSafe(state.baseUrl)
      const refreshed = await refreshRecord(record, state.baseUrl, info)
      if (refreshed.changed) await persistRecord(refreshed.record)
      return {
        ok: true,
        live: Boolean(info),
        workflow: detailWorkflow(refreshed.record),
        warnings: info ? [] : [`ComfyUI 暂时连不上（${state.baseUrl}），参数按上次记录的元数据显示。`],
      }
    },

    async importWorkflow({ name, json, source } = {}) {
      const cleanName = trimmed(name)
      if (!cleanName) return { ok: false, error: '需要工作流名称' }
      let raw = json
      if (typeof raw === 'string') {
        try {
          raw = JSON.parse(raw)
        } catch (error) {
          return { ok: false, error: `工作流 JSON 解析失败：${error?.message || error}` }
        }
      }
      if (!raw || typeof raw !== 'object') return { ok: false, error: '工作流 JSON 必须是对象' }

      const state = await store.read()
      const info = await objectInfoSafe(state.baseUrl)
      let merged
      try {
        merged = workflow.mergeImport({ name: cleanName, raw, objectInfo: info || undefined })
      } catch (error) {
        return { ok: false, error: `无法识别这个工作流：${error?.message || error}` }
      }
      if (!info) {
        merged.warnings = [
          ...(merged.warnings || []),
          `ComfyUI 暂时连不上（${state.baseUrl}），参数按启发式推导，可能不完整；连上后打开工作流会自动刷新。`,
        ]
      }

      let importedCaps = null
      try {
        importedCaps = capabilities.describeWorkflow(merged.apiGraph || {})
      } catch {
        importedCaps = null
      }
      const importedDescription = typeof merged.description === 'string' && merged.description.trim()
        ? merged.description.trim().slice(0, 500)
        : (importedCaps?.summary || '').slice(0, 500)

      const takenIds = new Set((state.workflows || []).map((w) => w.id))
      const takenNames = new Set((state.workflows || []).map((w) => w.name))
      const baseName = merged.name || cleanName
      let finalName = baseName
      let suffix = 2
      while (takenNames.has(finalName)) {
        finalName = `${baseName} (${suffix})`
        suffix += 1
      }
      const now = new Date().toISOString()
      const record = {
        id: newWorkflowId(finalName, takenIds),
        name: finalName,
        source: source === 'server' ? 'server' : merged.source || 'api',
        apiGraph: merged.apiGraph,
        uiGraph: merged.uiGraph,
        nodes: merged.nodes || [],
        params: merged.params || [],
        promptTargets: merged.promptTargets || { positive: [], negative: [] },
        description: importedDescription,
        tags: [],
        warnings: merged.warnings || [],
        createdAt: now,
        updatedAt: now,
      }
      const next = await store.update((current) => {
        current.workflows.unshift(record)
        current.workflows = current.workflows.slice(0, WORKFLOW_LIMIT)
        return current
      })
      log(`导入工作流「${record.name}」（${record.source}，${record.nodes.length} 节点）`)
      return {
        ok: true,
        workflow: summarizeWorkflow(record),
        workflows: (next.workflows || []).map(summarizeWorkflow),
        warnings: record.warnings,
        live: Boolean(info),
      }
    },

    async renameWorkflow({ id, name } = {}) {
      const cleanName = trimmed(name)
      if (!cleanName) return { ok: false, error: '新名称不能为空' }
      const state = await store.read()
      const record = findWorkflow(state, id)
      if (!record) return { ok: false, error: `没有找到工作流：${trimmed(id) || '(空)'}` }
      const clash = (state.workflows || []).some((w) => w.id !== record.id && w.name === cleanName)
      if (clash) return { ok: false, error: `已有同名工作流：${cleanName}` }
      record.name = cleanName
      record.updatedAt = new Date().toISOString()
      const next = await store.update((current) => {
        const index = current.workflows.findIndex((w) => w.id === record.id)
        if (index >= 0) current.workflows[index] = { ...current.workflows[index], name: cleanName, updatedAt: record.updatedAt }
        return current
      })
      return { ok: true, workflows: (next.workflows || []).map(summarizeWorkflow) }
    },

    /** §11：写/改工作流的「用途说明 + 标签」（AI 工具与面板共用）。 */
    async updateWorkflowMeta({ id, description, tags } = {}) {
      const state = await store.read()
      const record = findWorkflow(state, id)
      if (!record) return { ok: false, error: `没有找到工作流：${trimmed(id) || '(空)'}` }
      const patch = {}
      if (description !== undefined) {
        if (typeof description !== 'string') return { ok: false, error: 'description 必须是字符串' }
        const clean = description.trim()
        if (clean.length > 500) return { ok: false, error: '用途说明最多 500 字' }
        patch.description = clean
      }
      if (tags !== undefined) {
        const clean = normalizeTagsInput(tags)
        if (clean === null) return { ok: false, error: 'tags 必须是字符串数组，或逗号/顿号分隔的字符串' }
        if (clean.length > 12) return { ok: false, error: '标签最多 12 个' }
        const tooLong = clean.find((tag) => tag.length > 40)
        if (tooLong) return { ok: false, error: `单个标签最多 40 字：${tooLong.slice(0, 20)}…` }
        patch.tags = clean
      }
      if (Object.keys(patch).length === 0) {
        return { ok: false, error: '没有要更新的内容（description / tags 至少给一个）' }
      }
      const updatedAt = new Date().toISOString()
      const next = await store.update((current) => {
        const index = current.workflows.findIndex((w) => w.id === record.id)
        if (index >= 0) current.workflows[index] = { ...current.workflows[index], ...patch, updatedAt }
        return current
      })
      const saved = (next.workflows || []).find((w) => w.id === record.id) || { ...record, ...patch }
      return {
        ok: true,
        workflow: summarizeWorkflow(saved),
        workflows: (next.workflows || []).map(summarizeWorkflow),
      }
    },

    /**
     * §11：AI 自主选型。按任务描述给「本地已导入工作流」+「ComfyUI 服务器工作流」打分排序，
     * 返回候选、匹配原因、需要准备的输入和下一步怎么调 —— 由会话里的模型自己决定用哪个。
     */
    /**
     * §11 / §13：AI 自主选型。**服务器优先**：ComfyUI 服务器上的工作流直接参与候选，
     * 选中后 comfy_run({workflow:"<path>"}) 即可（use 时自动加载，不需要先导入）。
     * 本地已保存的旧工作流默认不参与；includeLocal=true 时才一起排序（服务器会用路径猜能力）。
     */
    async chooseWorkflow({ task, includeServer = true, includeLocal = false, limit = 5 } = {}) {
      const cleanTask = trimmed(task)
      if (!cleanTask) return { ok: false, error: '需要 task：用户想要的效果描述' }
      const maxLimit = Math.min(10, Math.max(1, Math.round(Number(limit) || 5)))
      const state = await store.read()
      const warnings = []

      const locals = (state.workflows || []).map((record) => {
        const capabilitiesInfo = capabilitiesOf(record)
        return {
          kind: 'local',
          record,
          capabilities: capabilitiesInfo,
          candidate: {
            name: record.name,
            description: typeof record.description === 'string' && record.description.trim()
              ? record.description.trim()
              : capabilitiesInfo.summary,
            tags: Array.isArray(record.tags) ? record.tags : [],
            kinds: capabilitiesInfo.kinds,
            kindLabels: capabilitiesInfo.kindLabels,
            classes: capabilitiesInfo.classes,
            models: capabilitiesInfo.models,
            paramNames: (record.params || []).map((param) => param.inputName),
          },
        }
      })

      const servers = []
      let serverReachable = false
      if (includeServer) {
        try {
          const listed = await comfy.listUserdataWorkflows(state.baseUrl)
          if (listed && listed.ok === true && Array.isArray(listed.items)) {
            serverReachable = true
            for (const item of listed.items) {
              const path = typeof item?.path === 'string' ? item.path : ''
              if (!path) continue
              const name = String(item.name || path).replace(/\.json$/i, '')
              const guessed = guessKindsFromName(path)
              servers.push({
                kind: 'server',
                importPath: path,
                candidate: {
                  name,
                  description: '',
                  tags: [],
                  kinds: guessed,
                  kindLabels: guessed.map((kind) => capabilities.KIND_LABELS[kind] || kind),
                  classes: [],
                  models: [],
                  paramNames: [],
                },
              })
            }
          } else if (listed && listed.ok === false) {
            warnings.push(`没读到 ComfyUI 服务器工作流：${listed.error || '未知原因'}（会退回本地已保存的工作流）`)
          }
        } catch (error) {
          warnings.push(`没读到 ComfyUI 服务器工作流：${humanizeError(error, state.baseUrl)}`)
        }
      }

      const useServer = servers.length > 0
      const pool = useServer
        ? (includeLocal ? [...servers, ...locals] : [...servers])
        : locals
      const mode = useServer ? 'server' : 'local'
      if (useServer && !includeLocal && locals.length > 0) {
        warnings.push(`本地已保存 ${locals.length} 个旧工作流，本次选型未参与（需要时传 includeLocal=true）`)
      }

      let ranked
      try {
        ranked = capabilities.chooseCandidates(cleanTask, pool.map((item) => item.candidate), { limit: maxLimit })
      } catch (error) {
        return { ok: false, error: `工作流选型失败：${error?.message || error}`, warnings }
      }

      const candidates = (ranked.matches || []).map((match) => {
        const item = pool[match.index]
        if (!item) return null
        if (item.kind === 'server') {
          const needsInput = item.candidate.kinds.some((kind) => ['img2img', 'inpaint', 'upscale', 'video', 'audio'].includes(kind))
          return {
            source: 'server',
            sourcePath: item.importPath,
            importPath: item.importPath,
            name: item.candidate.name,
            description: 'ComfyUI 服务器上的工作流（运行时自动加载，不需要导入）',
            kinds: item.candidate.kinds,
            kindLabels: item.candidate.kindLabels,
            neededInputs: [],
            outputKinds: [],
            needsDetail: true,
            needsInput: needsInput || undefined,
            score: match.score,
            matched: match.matched,
            reasons: match.reasons,
            next: needsInput
              ? `先 comfy_workflow({"workflow":"${item.importPath}"}) 看 neededInputs（可能要先 comfy_upload_image 传图），再 comfy_run({"workflow":"${item.importPath}", ...})；use 时自动加载，不需要导入`
              : `comfy_run({"workflow":"${item.importPath}", "prompt":"…"})（use 时自动从 ComfyUI 加载，不需要导入）；看参数先 comfy_workflow({"workflow":"${item.importPath}"})`,
          }
        }
        return {
          source: 'local',
          workflow: { id: item.record.id, name: item.record.name },
          name: item.record.name,
          description: item.candidate.description,
          kinds: item.capabilities.kinds,
          kindLabels: item.capabilities.kindLabels,
          neededInputs: item.capabilities.neededInputs,
          outputKinds: item.capabilities.outputKinds,
          score: match.score,
          matched: match.matched,
          reasons: match.reasons,
          next: `comfy_run({"workflow":"${item.record.id}", "prompt":"…"})；要调参数先 comfy_workflow({"workflow":"${item.record.id}"})`,
        }
      }).filter(Boolean)

      if (candidates.length === 0) {
        return {
          ok: false,
          task: cleanTask,
          error: '还没有任何可用工作流：确认 ComfyUI 已配置且连得上，或在 ComfyUI 里保存过工作流',
          warnings,
        }
      }
      return {
        ok: true,
        task: cleanTask,
        intentKinds: ranked.intentKinds || [],
        mode,
        serverReachable,
        candidates,
        totals: { local: locals.length, server: servers.length },
        warnings,
        hint: mode === 'server'
          ? '候选来自 ComfyUI 服务器，直接 comfy_run({workflow:"<sourcePath>"}) 即可（无需导入）。'
          : 'ComfyUI 服务器暂不可用，候选来自本地已保存工作流。',
      }
    },

    async deleteWorkflow(id) {
      const state = await store.read()
      const record = findWorkflow(state, id)
      if (!record) return { ok: false, error: `没有找到工作流：${trimmed(id) || '(空)'}` }
      const next = await store.update((current) => {
        current.workflows = (current.workflows || []).filter((w) => w.id !== record.id)
        return current
      })
      return { ok: true, workflows: (next.workflows || []).map(summarizeWorkflow) }
    },

    async listServerWorkflows() {
      const state = await store.read()
      try {
        const result = await comfy.listUserdataWorkflows(state.baseUrl)
        if (!result || result.ok === false) {
          return {
            ok: false,
            baseUrl: state.baseUrl,
            error: result?.error || `ComfyUI 没有提供服务器工作流接口（旧版本较常见），可以手动粘贴 JSON 导入。`,
          }
        }
        return { ok: true, baseUrl: state.baseUrl, items: result.items || [] }
      } catch (error) {
        return { ok: false, baseUrl: state.baseUrl, error: humanizeError(error, state.baseUrl) }
      }
    },

    /**
     * 「使用」服务器工作流前的按需加载：读取 JSON + 推导参数/提示词目标/能力，**不写本地库**。
     */
    async getServerWorkflowDetail({ path, name } = {}) {
      const target = serverPathOf(path)
      if (!target) return { ok: false, error: '需要 ComfyUI 服务器上的工作流路径' }
      const state = await store.read()
      try {
        const loaded = await loadServerRecord({ baseUrl: state.baseUrl, path: target, name })
        return {
          ok: true,
          live: loaded.live,
          fromServer: true,
          sourcePath: target,
          workflow: detailWorkflow(loaded.record),
          warnings: loaded.live ? [] : [`ComfyUI 暂时连不上（${state.baseUrl}），参数按启发式推导，可能不完整。`],
        }
      } catch (error) {
        return { ok: false, error: humanizeError(error, state.baseUrl) }
      }
    },

    async importServerWorkflow({ path, name } = {}) {
      const target = trimmed(path)
      if (!target) return { ok: false, error: '需要 ComfyUI 服务器上的工作流路径' }
      const state = await store.read()
      let raw
      try {
        raw = await comfy.getUserdataWorkflow(state.baseUrl, target)
      } catch (error) {
        return { ok: false, error: humanizeError(error, state.baseUrl) }
      }
      const fallbackName = target.replace(/\\/g, '/').split('/').pop()?.replace(/\.json$/i, '') || 'server-workflow'
      return api.importWorkflow({ name: trimmed(name) || fallbackName, json: raw, source: 'server' })
    },

    /* ── 运行 ────────────────────────────────────────────────── */

    async run({ workflow: wfRef, prompt, negativePrompt, params, wait = true, timeoutSec, saveDir, signal } = {}) {
      const state = await store.read()
      let record = findWorkflow(state, wfRef)
      let loadedFromServer = false
      if (!record) {
        const rawRef = trimmed(wfRef)
        const serverPath = serverPathOf(wfRef)
        if (serverPath && (/^server:/i.test(rawRef) || looksLikeServerPath(serverPath))) {
          try {
            const loaded = await loadServerRecord({ baseUrl: state.baseUrl, path: serverPath })
            record = loaded.record
            loadedFromServer = true
          } catch (error) {
            return {
              ok: false,
              error: `本地没有这个工作流，按 ComfyUI 服务器路径加载也失败了：${humanizeError(error, state.baseUrl)}`,
              warnings: [],
            }
          }
        }
      }
      if (!record) {
        return {
          ok: false,
          error: `没有找到工作流：${trimmed(wfRef) || '(空)'}。不知道用哪个就先调 comfy_choose_workflow（按任务推荐）；想看 ComfyUI 服务器上有什么工作流用 comfy_workflows，然后直接传它的 path 运行`,
        }
      }

      const baseUrl = state.baseUrl
      const info = await objectInfoSafe(baseUrl)
      const built = info ? workflow.buildParamSpecs(record.apiGraph, info) : null
      const spec = built ? built.params : record.params || []
      const targets = built ? built.promptTargets : record.promptTargets || { positive: [], negative: [] }

      const warnings = []
      let graph = record.apiGraph
      const applied = []

      try {
        const overrides = params && typeof params === 'object' && !Array.isArray(params) ? params : {}
        if (Object.keys(overrides).length > 0) {
          const overrideResult = workflow.applyParamOverrides(graph, spec, overrides)
          graph = overrideResult.apiGraph
          for (const item of overrideResult.applied || []) applied.push({ path: item.path, value: item.value })
          for (const message of overrideResult.warnings || []) warnings.push(message)
        }
        if ((trimmed(prompt) || trimmed(negativePrompt))) {
          const promptResult = workflow.applyPrompts(
            graph,
            targets,
            { prompt: trimmed(prompt) || undefined, negativePrompt: trimmed(negativePrompt) || undefined },
            spec,
          )
          graph = promptResult.apiGraph
          for (const item of promptResult.applied || []) {
            applied.push({ path: item.path, field: item.field, value: item.value })
          }
          for (const message of promptResult.warnings || []) warnings.push(message)
        }
      } catch (error) {
        return { ok: false, error: `组装工作流失败：${error?.message || error}`, warnings }
      }
      if (!info) warnings.push(`ComfyUI 暂时连不上（${baseUrl}），本次参数没有按服务器 schema 校验。`)

      let queued
      try {
        queued = await comfy.queuePrompt(baseUrl, graph, { clientId: state.clientId })
      } catch (error) {
        // ComfyUI 拒绝非法 prompt 的标准行为：HTTP 400 + { error, node_errors }，
        // 原始响应体挂在 ComfyError.json 上，要把 node_errors 透传给面板/模型。
        const nodeErrors = error?.json?.node_errors
        const hasNodeErrors = nodeErrors && typeof nodeErrors === 'object' && Object.keys(nodeErrors).length > 0
        return {
          ok: false,
          error: humanizeError(error, baseUrl),
          ...(hasNodeErrors ? { nodeErrors } : {}),
          warnings,
        }
      }
      const promptId = queued?.promptId
      if (!promptId) return { ok: false, error: 'ComfyUI 没有返回 prompt_id（可能拒绝了请求）', nodeErrors: queued?.nodeErrors, warnings }
      if (queued?.nodeErrors && Object.keys(queued.nodeErrors).length > 0) {
        return {
          ok: false,
          promptId,
          error: 'ComfyUI 拒绝了工作流（节点参数校验失败），看 nodeErrors',
          nodeErrors: queued.nodeErrors,
          warnings,
        }
      }

      const timeout = clampTimeoutSec(timeoutSec ?? state.timeoutSec, state.timeoutSec)
      const runDir = saveDir ? join(saveDir, String(promptId).slice(0, 8)) : null

      if (wait === false) {
        const run = {
          promptId,
          workflowId: record.id,
          workflowName: record.name,
          state: 'queued',
          createdAt: new Date().toISOString(),
          images: [],
        }
        await recordRun(run)
        return { ok: true, promptId, state: 'queued', images: [], applied, warnings, workflow: summarizeWorkflow(record) }
      }

      const startedAt = Date.now()
      let waited
      try {
        waited = await comfy.waitForPrompt(baseUrl, promptId, { timeoutMs: timeout * 1000, signal })
      } catch (error) {
        return { ok: false, promptId, error: humanizeError(error, baseUrl), warnings }
      }
      const durationMs = Date.now() - startedAt
      const images = (await collectImages(baseUrl, waited.entry, runDir, warnings))
        .map((image) => ({ ...image, url: imageUrl(image) }))
      const runState = waited.state === 'done' ? 'done' : waited.state === 'error' ? 'error' : waited.state === 'timeout' ? 'timeout' : 'error'
      await recordRun({
        promptId,
        workflowId: record.id,
        workflowName: record.name,
        state: runState,
        createdAt: new Date(startedAt).toISOString(),
        durationMs,
        images: images.map(({ filename, subfolder, type, mime }) => ({ filename, subfolder, type, contentType: mime })),
        error: waited.error || undefined,
      })

      if (runState === 'timeout') {
        return {
          ok: true,
          promptId,
          state: 'timeout',
          elapsedMs: durationMs,
          images,
          applied,
          warnings: [...warnings, `等待超时（${timeout}s），任务可能还在跑：用 comfy_result 按 promptId 继续查。`],
          workflow: summarizeWorkflow(record),
        }
      }
      if (runState === 'error') {
        return {
          ok: false,
          promptId,
          state: 'error',
          error: waited.error || 'ComfyUI 执行失败',
          elapsedMs: durationMs,
          images,
          applied,
          warnings,
          workflow: summarizeWorkflow(record),
        }
      }
      return {
        ok: true,
        promptId,
        state: 'done',
        elapsedMs: durationMs,
        images,
        applied,
        warnings,
        workflow: summarizeWorkflow(record),
      }
    },

    async pollResult({ promptId, timeoutSec, saveDir, signal } = {}) {
      const id = trimmed(promptId)
      if (!id) return { ok: false, error: '需要 promptId' }
      const state = await store.read()
      const timeout = clampTimeoutSec(timeoutSec ?? state.timeoutSec, state.timeoutSec)
      const warnings = []
      const runDir = saveDir ? join(saveDir, id.slice(0, 8)) : null
      let waited
      try {
        waited = await comfy.waitForPrompt(state.baseUrl, id, { timeoutMs: timeout * 1000, signal })
      } catch (error) {
        return { ok: false, error: humanizeError(error, state.baseUrl), warnings }
      }
      const images = (await collectImages(state.baseUrl, waited.entry, runDir, warnings))
        .map((image) => ({ ...image, url: imageUrl(image) }))
      const runState = waited.state === 'done' ? 'done' : waited.state === 'error' ? 'error' : waited.state === 'timeout' ? 'timeout' : 'error'
      const previous = (state.lastRuns || []).find((item) => item.promptId === id)
      const record = previous?.workflowId
        ? (state.workflows || []).find((item) => item.id === previous.workflowId)
        : undefined
      const workflow = record ? summarizeWorkflow(record) : undefined
      await recordRun({
        promptId: id,
        workflowId: previous?.workflowId,
        workflowName: previous?.workflowName || '(未记录)',
        state: runState,
        createdAt: previous?.createdAt || new Date().toISOString(),
        durationMs: previous?.durationMs,
        images: images.map(({ filename, subfolder, type, mime }) => ({ filename, subfolder, type, contentType: mime })),
        error: waited.error || undefined,
      })
      if (runState === 'done') {
        return {
          ok: true,
          promptId: id,
          state: 'done',
          images,
          ...(previous?.durationMs ? { elapsedMs: previous.durationMs } : {}),
          ...(workflow ? { workflow } : {}),
          warnings,
        }
      }
      if (runState === 'timeout') {
        return {
          ok: true,
          promptId: id,
          state: 'timeout',
          images,
          ...(previous?.durationMs ? { elapsedMs: previous.durationMs } : {}),
          ...(workflow ? { workflow } : {}),
          warnings: [...warnings, '还没跑完，稍后再查。'],
        }
      }
      return {
        ok: false,
        promptId: id,
        state: 'error',
        error: waited.error || 'ComfyUI 执行失败',
        images,
        ...(previous?.durationMs ? { elapsedMs: previous.durationMs } : {}),
        ...(workflow ? { workflow } : {}),
        warnings,
      }
    },

    async getQueue() {
      const state = await store.read()
      try {
        const queue = await comfy.getQueue(state.baseUrl)
        return {
          ok: true,
          baseUrl: state.baseUrl,
          running: (queue.running || []).map((item) => ({ promptId: item.prompt_id ?? item.promptId ?? null })),
          pending: (queue.pending || []).map((item) => ({ promptId: item.prompt_id ?? item.promptId ?? null })),
        }
      } catch (error) {
        return { ok: false, error: humanizeError(error, state.baseUrl) }
      }
    },

    async cancel({ promptId } = {}) {
      const state = await store.read()
      const id = trimmed(promptId)
      let interrupted = false
      let removed = 0
      try {
        await comfy.interrupt(state.baseUrl, id || undefined)
        interrupted = true
      } catch (error) {
        if (id) return { ok: false, error: humanizeError(error, state.baseUrl) }
      }
      try {
        if (id) {
          await comfy.deleteQueued(state.baseUrl, [id])
          removed = 1
        } else {
          await comfy.clearQueue(state.baseUrl)
        }
      } catch {
        /* 队列里没有/已执行 都算正常 */
      }
      return { ok: true, interrupted, removed }
    },

    /** 上传图片到 ComfyUI 的 input 目录（工具层读文件后传进来）。 */
    async uploadImage({ data, filename, subfolder = '' } = {}) {
      if (!data) return { ok: false, error: '需要图片数据' }
      const state = await store.read()
      try {
        const uploaded = await comfy.uploadImage(state.baseUrl, {
          data: Buffer.isBuffer(data) ? data : Buffer.from(data),
          filename: trimmed(filename) || 'image.png',
          subfolder: trimmed(subfolder),
        })
        return {
          ok: true,
          name: uploaded?.name || '',
          subfolder: uploaded?.subfolder || '',
          type: uploaded?.type || 'input',
          baseUrl: state.baseUrl,
        }
      } catch (error) {
        return { ok: false, error: humanizeError(error, state.baseUrl) }
      }
    },

    async getImage({ filename, subfolder = '', type = 'output' } = {}) {
      const name = trimmed(filename)
      if (!name) return { ok: false, error: '需要 filename' }
      const state = await store.read()
      try {
        const { buffer, contentType } = await comfy.fetchImage(state.baseUrl, {
          filename: name,
          subfolder: trimmed(subfolder),
          type: trimmed(type) || 'output',
        })
        return { ok: true, buffer, contentType: contentType || imageMime(name) }
      } catch (error) {
        return { ok: false, error: humanizeError(error, state.baseUrl) }
      }
    },
  }
  return api
}

export default createActions
