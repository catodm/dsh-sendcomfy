/**
 * dsh-sendcomfy — ComfyUI 工作流解析 / UI→API 转换 / 参数推导
 *
 * 契约见 CONTRACT.md §4。本模块是纯 ESM、零第三方依赖的纯函数集合：
 *   parseWorkflowJson / uiToApiGraph / buildParamSpecs / applyParamOverrides
 *   / applyPrompts / mergeImport / summarizeGraph
 *
 * 关于 ComfyUI 真实格式的两个关键事实（以本机 0.44 导出的工作流核对过）：
 *  1) UI 导出里 `widgets_values` 是「小部件值数组」，顺序 = 节点类 INPUT_TYPES
 *     里 required→optional 的小部件输入顺序；seed/noise_seed 后通常紧跟一个
 *     'fixed'|'increment'|'decrement'|'randomize' 控制值（也占一个数组槽）。
 *     被「转成输入」的小部件（inputs[].widget.name）在旧导出里仍占 widgets_values
 *     的槽位，因此必须按名字/顺序对位读取，不能把 link 输入算进去。
 *  2) object_info 的输入描述有两种形态：老式 combo 是 `[[选项...], {opts}]`，
 *     新式（io.Combo）是 `["COMBO", {options:[...], image_upload:true, ...}]`。
 *     两者都要支持。
 */

const CONTROL_VALUES = new Set(['fixed', 'increment', 'decrement', 'randomize'])
const NOTE_TYPES = new Set(['Note', 'MarkdownNote', 'NoteNode'])
const REROUTE_TYPE = 'Reroute'
const PRIMITIVE_NODE_TYPE = 'PrimitiveNode'
const MAX_WARNINGS = 200

/** 输入名命中这些（且值是字符串）即视为提示词候选。 */
const PROMPT_INPUT_NAMES = new Set(['text', 'text_g', 'text_l', 'prompt'])

/** object_info 类型名 -> ParamSpec.type */
const WIDGET_KIND_BY_TYPE = {
  INT: 'integer',
  FLOAT: 'number',
  STRING: 'string',
  BOOLEAN: 'boolean',
  COMBO: 'enum',
}

/**
 * objectInfo 缺失时的内置小部件顺序表（只覆盖官方常用节点，尽力而为）。
 * 每项: { name, control?: true（后面可能跟一个生成控制值）, upload?: true（后面可能跟一个上传按钮值） }
 */
const BUILTIN_WIDGET_SCHEMAS = {
  KSampler: [
    { name: 'seed', control: true },
    { name: 'steps' },
    { name: 'cfg' },
    { name: 'sampler_name' },
    { name: 'scheduler' },
    { name: 'denoise' },
  ],
  KSamplerAdvanced: [
    { name: 'add_noise' },
    { name: 'noise_seed', control: true },
    { name: 'steps' },
    { name: 'cfg' },
    { name: 'sampler_name' },
    { name: 'scheduler' },
    { name: 'start_at_step' },
    { name: 'end_at_step' },
    { name: 'return_with_leftover_noise' },
  ],
  CLIPTextEncode: [{ name: 'text' }],
  CheckpointLoaderSimple: [{ name: 'ckpt_name' }],
  EmptyLatentImage: [{ name: 'width' }, { name: 'height' }, { name: 'batch_size' }],
  EmptySD3LatentImage: [{ name: 'width' }, { name: 'height' }, { name: 'batch_size' }],
  VAEDecode: [],
  VAEEncode: [],
  SaveImage: [{ name: 'filename_prefix' }],
  PreviewImage: [],
  LoadImage: [{ name: 'image', upload: true }],
  LoadImageMask: [{ name: 'image', upload: true }, { name: 'channel' }],
  LoraLoader: [{ name: 'lora_name' }, { name: 'strength_model' }, { name: 'strength_clip' }],
  LoraLoaderModelOnly: [{ name: 'lora_name' }, { name: 'strength_model' }],
  UNETLoader: [{ name: 'unet_name' }, { name: 'weight_dtype' }],
  CLIPLoader: [{ name: 'clip_name' }, { name: 'type' }, { name: 'device' }],
  VAELoader: [{ name: 'vae_name' }],
  CLIPSetLastLayer: [{ name: 'stop_at_clip_layer' }],
  LatentUpscale: [{ name: 'upscale_method' }, { name: 'width' }, { name: 'height' }, { name: 'crop' }],
  LatentUpscaleBy: [{ name: 'upscale_method' }, { name: 'scale_by' }],
  ImageScale: [{ name: 'upscale_method' }, { name: 'width' }, { name: 'height' }, { name: 'crop' }],
  ImageScaleBy: [{ name: 'upscale_method' }, { name: 'scale_by' }],
  ControlNetLoader: [{ name: 'control_net_name' }],
  UpscaleModelLoader: [{ name: 'model_name' }],
  ModelSamplingAuraFlow: [{ name: 'shift' }],
  // ComfyUI 0.4x 起的新版核心节点（io.ComfyNode，现代模板常用）
  PrimitiveInt: [{ name: 'value', control: true }],
  PrimitiveFloat: [{ name: 'value' }],
  PrimitiveString: [{ name: 'value' }],
  PrimitiveStringMultiline: [{ name: 'value' }],
  PrimitiveBoolean: [{ name: 'value' }],
  RandomNoise: [{ name: 'noise_seed', control: true }],
  SamplerCustom: [{ name: 'add_noise' }, { name: 'noise_seed', control: true }, { name: 'cfg' }],
  SamplerCustomAdvanced: [],
  KSamplerSelect: [{ name: 'sampler_name' }],
  BasicScheduler: [{ name: 'scheduler' }, { name: 'steps' }, { name: 'denoise' }],
  SplitSigmas: [{ name: 'step' }],
  SplitSigmasDenoise: [{ name: 'denoise' }],
  CFGGuider: [{ name: 'cfg' }],
  BasicGuider: [],
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function fail(message) {
  const err = new Error(message)
  err.code = 'EBAD_WORKFLOW'
  return err
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPrimitiveValue(value) {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

/** API 格式里的链路值：[String(源节点id), 输出槽号] */
function isLinkValue(value) {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'number'
}

/** ComfyUI 槽位类型可能是 'IMAGE' / 'IMAGE,MASK' / '*' 等，按集合比较兼容性。 */
function normalizeSlotType(type) {
  if (typeof type !== 'string') return []
  return type
    .split(/[,|]/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
}

function slotTypesCompatible(a, b) {
  const left = normalizeSlotType(a)
  const right = normalizeSlotType(b)
  if (left.length === 0 || right.length === 0) return false
  if (left.includes('*') || right.includes('*')) return true
  return left.some((type) => right.includes(type))
}

function isSeedLikeName(name) {
  return /(^|_)seed$/.test(name)
}

function cloneValue(value) {
  try {
    return structuredClone(value)
  } catch {
    try {
      return JSON.parse(JSON.stringify(value))
    } catch {
      return value
    }
  }
}

function compareNodeIds(a, b) {
  const sa = String(a)
  const sb = String(b)
  const na = Number(sa)
  const nb = Number(sb)
  const aNum = sa !== '' && Number.isFinite(na)
  const bNum = sb !== '' && Number.isFinite(nb)
  if (aNum && bNum) return na - nb
  if (aNum) return -1
  if (bNum) return 1
  return sa < sb ? -1 : sa > sb ? 1 : 0
}

/** 有序节点 id 列表（数值序优先）。 */
function orderedNodeIds(graph) {
  if (!isPlainObject(graph)) return []
  return Object.keys(graph).sort(compareNodeIds)
}

/** 按插入顺序遍历「所有可迭代字符串」并附加未列出的键（兼容 input_order 缺项）。 */
function orderedNames(specs, listed) {
  const own = Object.keys(specs)
  if (!Array.isArray(listed)) return own
  const seen = new Set()
  const out = []
  for (const name of listed) {
    if (typeof name === 'string' && Object.prototype.hasOwnProperty.call(specs, name) && !seen.has(name)) {
      out.push(name)
      seen.add(name)
    }
  }
  for (const name of own) if (!seen.has(name)) out.push(name)
  return out
}

/** 收集 warnings：去重 + 上限。 */
function createWarningCollector() {
  const warnings = []
  const seen = new Set()
  return {
    warnings,
    add(message) {
      if (!message || seen.has(message)) return
      if (warnings.length >= MAX_WARNINGS) {
        const note = `警告过多，已省略后续 ${MAX_WARNINGS} 条之后的提示`
        if (!seen.has(note)) {
          seen.add(note)
          warnings.push(note)
        }
        return
      }
      seen.add(message)
      warnings.push(message)
    },
  }
}

// ---------------------------------------------------------------------------
// object_info 解析
// ---------------------------------------------------------------------------

/**
 * 解析 object_info 里单个输入声明。
 * @returns null | { kind:'integer'|'number'|'string'|'boolean'|'enum'|'link',
 *                   typeName:string, options?:unknown[], min?:number, max?:number,
 *                   step?:number, multiline?:boolean, controlFlag?:boolean,
 *                   upload?:boolean }
 */
function parseInputSpec(spec) {
  let type
  let opts = {}
  if (Array.isArray(spec)) {
    type = spec[0]
    if (spec.length > 1) {
      if (isPlainObject(spec[1])) opts = spec[1]
      else if (Array.isArray(spec[1])) opts = { options: spec[1] }
    }
  } else if (typeof spec === 'string') {
    type = spec
  } else {
    return null
  }

  let kind
  let options
  if (Array.isArray(type)) {
    kind = 'enum'
    options = type
  } else if (type === 'COMBO') {
    kind = 'enum'
    options = Array.isArray(opts.options) ? opts.options : Array.isArray(opts.values) ? opts.values : undefined
  } else if (typeof type === 'string' && WIDGET_KIND_BY_TYPE[type]) {
    kind = WIDGET_KIND_BY_TYPE[type]
  } else {
    kind = 'link'
  }
  if (opts.forceInput || opts.force_input) kind = 'link'

  const numberOpt = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

  return {
    kind,
    typeName: typeof type === 'string' ? type : 'COMBO',
    options,
    min: numberOpt(opts.min),
    max: numberOpt(opts.max),
    step: numberOpt(opts.step),
    multiline: opts.multiline === true,
    controlFlag: opts.control_after_generate,
    upload:
      opts.image_upload === true || opts.video_upload === true || opts.audio_upload === true || opts.upload === true,
  }
}

/** 从 object_info[class] 提取有序的小部件输入定义；无法识别返回 null。 */
function widgetDefsFromObjectInfo(nodeDef) {
  if (!isPlainObject(nodeDef) || !isPlainObject(nodeDef.input)) return null
  const input = nodeDef.input
  const order = isPlainObject(nodeDef.input_order) ? nodeDef.input_order : {}
  const defs = []
  for (const group of ['required', 'optional']) {
    const specs = input[group]
    if (!isPlainObject(specs)) continue
    for (const name of orderedNames(specs, order[group])) {
      const spec = parseInputSpec(specs[name])
      if (!spec || spec.kind === 'link') continue
      const control =
        spec.controlFlag === true || (spec.controlFlag === undefined && isSeedLikeName(name))
      defs.push({
        name,
        control,
        upload: spec.upload === true,
        spec,
      })
    }
  }
  return defs
}

/** 取某个节点类的小部件顺序表（object_info 优先，其次内置，最后启发式）。 */
function widgetSchemaFor(nodeClass, objectInfo, warn) {
  const nodeDef = isPlainObject(objectInfo) ? objectInfo[nodeClass] : undefined
  const hasObjectInfo = isPlainObject(objectInfo) && Object.keys(objectInfo).length > 0
  if (isPlainObject(nodeDef)) {
    const defs = widgetDefsFromObjectInfo(nodeDef)
    if (defs) return { defs, source: 'object_info' }
  }
  const builtin = BUILTIN_WIDGET_SCHEMAS[nodeClass]
  if (builtin) {
    if (isPlainObject(nodeDef)) {
      warn(`object_info 中节点类型 ${nodeClass} 的输入描述不可用，改用内置 schema 转换小部件`)
    } else if (hasObjectInfo) {
      warn(`object_info 缺少节点类型 ${nodeClass}，改用内置 schema 转换小部件`)
    } else {
      warn(`未提供 object_info：节点类型 ${nodeClass} 使用内置 schema 映射小部件（结果可能不完整）`)
    }
    return { defs: builtin, source: 'builtin' }
  }
  if (isPlainObject(nodeDef)) {
    warn(`object_info 中节点类型 ${nodeClass} 的输入描述不可用，且没有内置 schema，只能启发式映射小部件`)
  } else if (hasObjectInfo) {
    warn(`object_info 缺少节点类型 ${nodeClass}，且没有内置 schema，只能按 inputs[].widget.name 启发式映射小部件`)
  } else {
    warn(
      `未提供 object_info：节点类型 ${nodeClass} 没有内置 schema，按 inputs[].widget.name 启发式映射小部件（结果可能不完整）`,
    )
  }
  return { defs: null, source: 'none' }
}

// ---------------------------------------------------------------------------
// parseWorkflowJson
// ---------------------------------------------------------------------------

function detectFormat(value) {
  if (!isPlainObject(value)) return null
  for (const item of Object.values(value)) {
    if (isPlainObject(item) && typeof item.class_type === 'string') return 'api'
  }
  if (Array.isArray(value.nodes) && value.nodes.some((n) => isPlainObject(n) && typeof n.type === 'string')) {
    return 'ui'
  }
  return null
}

function decodeWorkflowText(input) {
  if (typeof input === 'string') return input
  if (input instanceof Uint8Array) return new TextDecoder('utf-8').decode(input)
  return null
}

/**
 * 解析工作流 JSON（字符串或已解析对象）。
 * @returns {{format:'ui'|'api', raw:object}}
 * @throws Error code='EBAD_WORKFLOW'
 */
export function parseWorkflowJson(textOrObject) {
  let value = textOrObject
  const text = decodeWorkflowText(textOrObject)
  if (text !== null) {
    if (!text.trim()) throw fail('工作流内容为空')
    try {
      value = JSON.parse(text)
    } catch (err) {
      throw fail(`工作流不是合法 JSON：${err && err.message ? err.message : String(err)}`)
    }
  }
  if (!isPlainObject(value)) {
    throw fail('无法识别工作流格式：期望 JSON 对象（ComfyUI UI 导出或 API 格式）')
  }

  let format = detectFormat(value)
  let raw = value
  if (!format) {
    // ComfyUI 新版/服务器保存的包装：{ workflow: UI 图 } 或 { prompt: API 图 }
    for (const key of ['workflow', 'prompt']) {
      const inner = value[key]
      const innerFormat = detectFormat(inner)
      if (innerFormat) {
        format = innerFormat
        raw = inner
        break
      }
    }
  }
  if (!format || !raw) {
    throw fail('无法识别工作流格式：既没有 UI 格式的 nodes/type，也没有 API 格式的 class_type')
  }
  return { format, raw }
}

// ---------------------------------------------------------------------------
// UI -> API 转换
// ---------------------------------------------------------------------------

function pickUiGraph(input) {
  if (!isPlainObject(input)) return null
  if (Array.isArray(input.nodes)) return input
  for (const key of ['workflow', 'graph']) {
    if (isPlainObject(input[key]) && Array.isArray(input[key].nodes)) return input[key]
  }
  return null
}

/** 兼容 links 的数组形态 [id, src, srcSlot, dst, dstSlot, type] 与对象形态。 */
function normalizeLinkEntry(entry) {
  if (Array.isArray(entry)) {
    if (entry.length < 5) return null
    const [id, srcNode, srcSlot, dstNode, dstSlot, typeName] = entry
    if (id == null || srcNode == null) return null
    return {
      id: String(id),
      srcNode: String(srcNode),
      srcSlot: Number(srcSlot) || 0,
      dstNode: dstNode == null ? '' : String(dstNode),
      dstSlot: Number(dstSlot) || 0,
      typeName: typeof typeName === 'string' ? typeName : undefined,
    }
  }
  if (isPlainObject(entry)) {
    const id = entry.id ?? entry.linkId
    const srcNode = entry.origin_id ?? entry.originId ?? entry.srcNode ?? entry.source
    const srcSlot = entry.origin_slot ?? entry.originSlot ?? entry.srcSlot
    if (id == null || srcNode == null) return null
    return {
      id: String(id),
      srcNode: String(srcNode),
      srcSlot: Number(srcSlot) || 0,
      dstNode: entry.target_id == null ? '' : String(entry.target_id ?? entry.targetId ?? entry.dstNode ?? entry.target),
      dstSlot: Number(entry.target_slot ?? entry.targetSlot ?? entry.dstSlot) || 0,
      typeName: entry.type,
    }
  }
  return null
}

/**
 * 把 ComfyUI「UI 格式」工作流（nodes/links/widgets_values）转换成 /prompt 需要的 API 格式。
 *
 * 处理规则（见 CONTRACT.md §4）：
 *  - Reroute 在连线上透明穿透（保持真实源的输出槽号）
 *  - PrimitiveNode 的 widgets_values[0] 作为字面量
 *  - Note/MarkdownNote/mode=2(静音) 跳过；mode=4(bypass) 按输入类型透传
 *  - 链路值 -> [String(源节点id), 源输出槽]；字面量 -> 值本身
 *  - 转成输入的小部件（inputs[].widget.name）改由 link 提供值
 *  - 其余 widgets_values 按 object_info 的小部件输入顺序映射；seed 后跟生成控制值时跳过
 *  - objectInfo 缺失时用内置 schema / inputs[].widget.name 尽力映射并写 warnings
 *
 * @param {object} ui UI 格式工作流
 * @param {object} [objectInfo] /object_info 结果（可缺省）
 * @returns {{apiGraph:Record<string,{class_type:string,inputs:Record<string,unknown>,_meta?:{title?:string}}>, warnings:string[]}}
 */
/** 新版 ComfyUI 子图的虚拟输入/输出节点 id。 */
const SUBGRAPH_INPUT_ID = -10
const SUBGRAPH_OUTPUT_ID = -20

/** 收集 definitions.subgraphs（id → 定义）。 */
function collectSubgraphDefinitions(graph) {
  const definitions = new Map()
  const raw = isPlainObject(graph) && isPlainObject(graph.definitions) && Array.isArray(graph.definitions.subgraphs)
    ? graph.definitions.subgraphs
    : []
  for (const def of raw) {
    if (!isPlainObject(def) || def.id == null) continue
    definitions.set(String(def.id), def)
  }
  return definitions
}

function instanceWidgetValues(instance) {
  const raw = instance && instance.widgets_values
  if (Array.isArray(raw)) return raw
  if (isPlainObject(raw)) return Object.values(raw)
  return []
}

/** 取子图实例上「提升输入」的默认值（实例输入没有外链时使用）。 */
function promotedInputDefault(instance, def, slotIndex) {
  const slots = def && Array.isArray(def.inputs) ? def.inputs : []
  const slot = slots[slotIndex]
  if (!slot) return { found: false }
  const values = instanceWidgetValues(instance)
  const proxy = isPlainObject(instance && instance.properties) && Array.isArray(instance.properties.proxyWidgets)
    ? instance.properties.proxyWidgets
    : null
  if (proxy) {
    const serializable = proxy.filter((entry) => Array.isArray(entry) && !String(entry[1] ?? '').startsWith('$$'))
    const index = serializable.findIndex((entry) => String(entry[0]) === '-1' && String(entry[1]) === String(slot.name))
    if (index >= 0 && index < values.length) return { found: true, value: values[index] }
  }
  // 优先用实例 inputs 上的 widget 元数据对齐（ComfyUI 只给可小部件化的提升输入带 widget）
  const instanceInputs = instance && Array.isArray(instance.inputs) ? instance.inputs : []
  if (instanceInputs.length > 0) {
    let widgetIndex = -1
    for (let i = 0; i <= slotIndex && i < instanceInputs.length; i += 1) {
      if (instanceInputs[i] && instanceInputs[i].widget) widgetIndex += 1
    }
    if (widgetIndex >= 0 && widgetIndex < values.length) return { found: true, value: values[widgetIndex] }
  }
  // 再退一步：按「可小部件化的提升输入」类型启发式兜底（跳过纯连接型槽位）
  const NON_WIDGET_TYPES = new Set([
    'MODEL', 'CLIP', 'VAE', 'CONDITIONING', 'LATENT', 'IMAGE', 'MASK', 'GUIDER', 'SAMPLER',
    'SIGMAS', 'NOISE', 'AUDIO', 'VIDEO', 'CONTROL_NET', 'UPSCALE_MODEL',
  ])
  let widgetIndex = -1
  for (let i = 0; i <= slotIndex; i += 1) {
    const item = slots[i]
    if (!item) continue
    if (NON_WIDGET_TYPES.has(String(item.type))) continue
    widgetIndex += 1
  }
  if (widgetIndex >= 0 && widgetIndex < values.length) return { found: true, value: values[widgetIndex] }
  return { found: false }
}

/**
 * 展开新版 ComfyUI 子图（definitions.subgraphs）：
 *  - 每个子图实例替换成定义内部的真实节点，节点 id 用 `实例路径:内部id`（与 ComfyUI 执行 id 一致）；
 *  - 子图输入 -10 / 输出 -20 视为虚拟端口，跨边界连线解析成直连；
 *  - 未连接外链的提升输入用实例 widgets_values 的默认值（合成 PrimitiveNode 字面量）；
 *  - bypass 的子图实例按「同类型输入透传」处理；
 *  - 支持嵌套子图（带环检测）。
 * 返回 { nodes, links, instanceCount }。
 */
function expandSubgraphs(graph, definitions, warn) {
  function scopeOf(nodes, links, path, parent, instance, def, chain) {
    const nodesById = new Map()
    for (const node of nodes || []) {
      if (node && node.id != null) nodesById.set(String(node.id), node)
    }
    const linksById = new Map()
    for (const raw of links || []) {
      const link = normalizeLinkEntry(raw)
      if (link) linksById.set(link.id, link)
    }
    return { nodes: nodes || [], linksById, nodesById, path, parent, instance, def, chain: chain || [] }
  }

  const flatNodes = []
  const flatLinks = []
  let linkSeq = 0
  let literalSeq = 0
  let instanceCount = 0
  const resolving = new Set()

  function flatId(scope, nodeId) {
    return [...scope.path, String(nodeId)].join(':')
  }

  function makeFlatLink(originId, originSlot, targetId, targetSlot, type) {
    linkSeq += 1
    const id = `sg-link-${linkSeq}`
    flatLinks.push({
      id,
      origin_id: String(originId),
      origin_slot: Number(originSlot) || 0,
      target_id: String(targetId),
      target_slot: Number(targetSlot) || 0,
      type,
    })
    return id
  }

  function addLiteralNode(value) {
    literalSeq += 1
    const id = `sg-literal-${literalSeq}`
    flatNodes.push({ id, type: 'PrimitiveNode', mode: 0, inputs: [], outputs: [], widgets_values: [value] })
    return id
  }

  function isInstance(node) {
    return Boolean(node && definitions.has(String(node.type)))
  }

  function missingSubgraphDefinition(node) {
    return Boolean(node && definitions.size > 0 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i.test(String(node.type)))
  }

  function resolveLink(scope, linkId, consumerType) {
    const link = scope.linksById.get(String(linkId))
    if (!link) return { kind: 'missing', reason: `连线 ${linkId} 在子图内部不存在` }
    return resolveOrigin(scope, link.srcNode, link.srcSlot, consumerType)
  }

  function resolveOrigin(scope, originId, originSlot, consumerType) {
    const rawId = String(originId)
    if (rawId === String(SUBGRAPH_INPUT_ID)) {
      if (!scope.parent) return { kind: 'missing', reason: '子图输入端口 -10 出现在根图上' }
      const instance = scope.instance
      const input = instance && Array.isArray(instance.inputs) ? instance.inputs[originSlot] : null
      if (!input) return { kind: 'missing', reason: `子图输入槽 ${originSlot} 不存在` }
      if (input.link != null) return resolveLink(scope.parent, input.link, consumerType)
      const promoted = promotedInputDefault(scope.instance, scope.def, originSlot)
      if (promoted.found) return { kind: 'literal', value: promoted.value }
      return { kind: 'missing', reason: `子图输入「${input.name || originSlot}」没有连接，也没有默认值` }
    }
    const node = scope.nodesById.get(rawId)
    if (!node) return { kind: 'missing', reason: `连线指向子图内不存在的节点 #${rawId}` }
    if (isInstance(node)) {
      if (node.mode === 2) return { kind: 'missing', reason: `子图节点 #${node.id} 已静音` }
      if (node.mode === 4) return bypassInstance(scope, node, originSlot, consumerType)
      return resolveSubgraphOutput(scope, node, originSlot, consumerType)
    }
    return { kind: 'link', nodeId: flatId(scope, node.id), slot: Number(originSlot) || 0 }
  }

  function resolveSubgraphOutput(scope, instanceNode, outSlot, consumerType) {
    const def = definitions.get(String(instanceNode.type))
    if (!def) return { kind: 'missing', reason: `缺少子图定义：${instanceNode.type}` }
    const key = `${scope.path.join(':')}>${instanceNode.id}:${outSlot}`
    if (resolving.has(key)) return { kind: 'missing', reason: `子图输出解析出现环（#${instanceNode.id} slot ${outSlot}）` }
    resolving.add(key)
    try {
      const links = Array.isArray(def.links) ? def.links : []
      const outputId = def.outputNode && def.outputNode.id != null ? String(def.outputNode.id) : String(SUBGRAPH_OUTPUT_ID)
      const inner = links
        .map(normalizeLinkEntry)
        .find((link) => link && String(link.dstNode) === outputId && link.dstSlot === Number(outSlot))
      if (!inner) return { kind: 'missing', reason: `子图「${def.name || instanceNode.type}」的输出 ${outSlot} 没有内部连线` }
      const innerScope = scopeOf(def.nodes, def.links, [...scope.path, String(instanceNode.id)], scope, instanceNode, def, scope.chain)
      return resolveOrigin(innerScope, inner.srcNode, inner.srcSlot, consumerType)
    } finally {
      resolving.delete(key)
    }
  }

  function bypassInstance(scope, instanceNode, outSlot, consumerType) {
    const def = definitions.get(String(instanceNode.type))
    const outputs = Array.isArray(instanceNode.outputs) ? instanceNode.outputs : []
    const output = outputs[outSlot]
    const outputType = output && typeof output.type === 'string' ? output.type : undefined
    const inputs = Array.isArray(instanceNode.inputs) ? instanceNode.inputs : []
    const candidates = inputs
      .map((input, index) => ({ input, index }))
      .filter((item) => item.input && item.input.link != null)
    const pickByType = (type) => {
      const found = candidates.find((item) => slotTypesCompatible(item.input.type, type))
      return found
    }
    let picked = null
    if (consumerType) picked = pickByType(consumerType)
    if (!picked && outputType) picked = pickByType(outputType)
    if (!picked) return { kind: 'missing', reason: `bypass 的子图节点 #${instanceNode.id} 找不到同类型输入可透传` }
    return resolveLink(scope.parent, picked.input.link, consumerType)
  }

  function emitScope(scope) {
    for (const node of scope.nodes) {
      if (!node || node.id == null) continue
      if (isInstance(node)) continue
      if (missingSubgraphDefinition(node)) {
        warn(`节点 #${node.id} 看起来是子图实例（${node.type}），但工作流里缺少它的子图定义，已跳过`)
        continue
      }
      const id = flatId(scope, node.id)
      const silentInputs = node.mode === 2 || node.mode === 4
      const inputs = Array.isArray(node.inputs) ? node.inputs.map((input) => ({ ...input })) : []
      const outputs = Array.isArray(node.outputs) ? node.outputs.map((output) => ({ ...output })) : []
      flatNodes.push({ ...node, id, inputs, outputs })
      for (let slot = 0; slot < inputs.length; slot += 1) {
        const input = inputs[slot]
        if (!input || input.link == null) continue
        const resolved = resolveLink(scope, input.link, input.type)
        if (!resolved || resolved.kind === 'missing') {
          if (!silentInputs && resolved && resolved.reason) {
            warn(`节点 #${node.id} (${node.type}) 的输入 "${input.name}" 展开子图后无法解析：${resolved.reason}`)
          }
          input.link = null
          continue
        }
        if (resolved.kind === 'literal') {
          const literalId = addLiteralNode(resolved.value)
          input.link = makeFlatLink(literalId, 0, id, slot, input.type)
        } else {
          input.link = makeFlatLink(resolved.nodeId, resolved.slot, id, slot, input.type)
        }
      }
    }
    // 递归展开这一层里的子图实例
    for (const node of scope.nodes) {
      if (!node || !isInstance(node)) continue
      instanceCount += 1
      const def = definitions.get(String(node.type))
      if (!def) {
        warn(`子图实例 #${node.id} 缺少定义（${node.type}），已跳过`)
        continue
      }
      if (node.mode === 2 || node.mode === 4) {
        warn(`子图实例 #${node.id} 处于${node.mode === 2 ? '静音' : 'bypass'}模式，已按其输入透传（不展开内部节点）`)
        continue
      }
      if (scope.chain.includes(String(node.type))) {
        warn(`子图 #${node.id}（${def.name || node.type}）出现循环引用，已跳过`)
        continue
      }
      const innerScope = scopeOf(
        def.nodes,
        def.links,
        [...scope.path, String(node.id)],
        scope,
        node,
        def,
        [...scope.chain, String(node.type)],
      )
      emitScope(innerScope)
    }
  }

  const rootScope = scopeOf(graph.nodes, graph.links, [], null, null, null, [])
  emitScope(rootScope)
  return { nodes: flatNodes, links: flatLinks, instanceCount }
}

export function uiToApiGraph(ui, objectInfo) {
  const graph = pickUiGraph(ui)
  if (!graph) throw fail('不是 ComfyUI UI 格式工作流：缺少 nodes 数组')

  const collector = createWarningCollector()
  const warn = (message) => collector.add(message)

  const definitions = collectSubgraphDefinitions(graph)
  let rawNodes = Array.isArray(graph.nodes) ? graph.nodes : []
  let rawLinks = Array.isArray(graph.links) ? graph.links : []
  if (definitions.size > 0) {
    const expanded = expandSubgraphs(graph, definitions, warn)
    rawNodes = expanded.nodes
    rawLinks = expanded.links
    if (expanded.instanceCount > 0) {
      warn(`工作流里有 ${expanded.instanceCount} 个子图实例，已展开为普通节点（id 形如「实例路径:内部id」）`)
    }
  }

  const nodes = rawNodes.filter((node) => node != null)
  const nodeMap = new Map()
  for (const node of nodes) {
    if (node.id == null) continue
    const key = String(node.id)
    if (nodeMap.has(key)) warn(`节点 id 重复：#${key}，后出现的定义覆盖前者`)
    nodeMap.set(key, node)
  }

  const linkMap = new Map()
  if (Array.isArray(rawLinks)) {
    for (const rawLink of rawLinks) {
      const link = normalizeLinkEntry(rawLink)
      if (!link) continue
      linkMap.set(link.id, link)
    }
  }


  // ---- 连线解析（递归处理 Reroute / PrimitiveNode / bypass） -----------------
  const resolving = new Set()

  function primitiveLiteral(node) {
    const values = node.widgets_values
    let value
    if (Array.isArray(values)) value = values[0]
    else if (isPlainObject(values)) value = values.value ?? Object.values(values)[0]
    if (value === undefined) {
      warn(`PrimitiveNode #${node.id} 没有可用的字面量值，已忽略其连线`)
      return null
    }
    return { kind: 'literal', value }
  }

  /**
   * 处理 bypass（mode=4）节点的输出透传（ComfyUI 语义：给输出找同类型的输入链路，把下游接到它上游）。
   *  - 优先按下游消费者的类型匹配（兼容 'IMAGE,MASK' 宽类型与 '*' 通配）；
   *  - 其次按输出槽自身类型匹配；多个同类型输入时优先名字与输出槽一致的；
   *  - 信息不足且只有一条输入链路时兜底透传；
   *  - 找不到可透传输入 → 输出视为「无输出」，下游该输入被忽略（ComfyUI 同样会判缺失）。
   */
  function bypassOutput(node, outSlot, consumerType) {
    const inputs = Array.isArray(node.inputs) ? node.inputs.filter((input) => input && input.link != null) : []
    if (!inputs.length) {
      return {
        kind: 'missing',
        reason: `节点 #${node.id} (${node.type}) 是 bypass 的源节点（没有输入），输出 ${outSlot} 没有数据`,
      }
    }
    const output = Array.isArray(node.outputs) ? node.outputs[outSlot] : undefined
    const outputType = output && typeof output.type === 'string' ? output.type : undefined
    const outputName = output && typeof output.name === 'string' ? output.name : ''

    const pickByType = (type) => {
      const candidates = inputs.filter((input) => slotTypesCompatible(input.type, type))
      if (candidates.length <= 1) return candidates[0]
      return candidates.find((input) => outputName && String(input.name || '').toLowerCase() === outputName.toLowerCase()) || candidates[0]
    }

    let picked = null
    if (consumerType) picked = pickByType(consumerType)
    if (!picked && outputType) picked = pickByType(outputType)
    if (!picked && !consumerType && !outputType && inputs.length === 1) picked = inputs[0]
    if (!picked) {
      return {
        kind: 'missing',
        reason: `bypass 节点 #${node.id} (${node.type}) 的输出 ${outSlot}`
          + `${outputType ? ` (${outputType})` : ''} 找不到同类型输入可透传`,
      }
    }
    return resolveLink(picked.link, consumerType)
  }

  function resolveFromSource(srcNodeId, srcSlot, expectedType) {
    const source = nodeMap.get(String(srcNodeId))
    if (!source) {
      warn(`连线指向不存在的节点 #${srcNodeId}，已忽略`)
      return null
    }
    const type = source.type
    if (typeof type !== 'string') {
      warn(`节点 #${source.id} 缺少 type，无法解析连线`)
      return null
    }
    if (type === REROUTE_TYPE) {
      const upstream = Array.isArray(source.inputs) ? source.inputs.find((input) => input && input.link != null) : null
      if (!upstream) {
        warn(`Reroute #${source.id} 没有上游连线，已忽略`)
        return null
      }
      return resolveLink(upstream.link, expectedType)
    }
    if (type === PRIMITIVE_NODE_TYPE) return primitiveLiteral(source)
    if (NOTE_TYPES.has(type)) {
      warn(`连线源节点 #${source.id} 是 ${type}（不产生数据），已忽略`)
      return null
    }
    if (source.mode === 2) {
      warn(`节点 #${source.id} (${type}) 已静音 (mode=2)，其下游连线无法解析`)
      return null
    }
    if (source.mode === 4) return bypassOutput(source, srcSlot, expectedType)
    return { kind: 'link', nodeId: String(source.id), slot: Number.isFinite(srcSlot) ? srcSlot : 0 }
  }

  function resolveLink(linkId, expectedType) {
    const key = String(linkId)
    if (resolving.has(key)) {
      warn(`检测到环形连线 (link ${key})，已忽略`)
      return null
    }
    const link = linkMap.get(key)
    if (!link) {
      warn(`连线 ${key} 不存在，已忽略`)
      return null
    }
    resolving.add(key)
    try {
      return resolveFromSource(link.srcNode, link.srcSlot, expectedType)
    } finally {
      resolving.delete(key)
    }
  }

  /** 某个节点类的某输入是否 required（没有 object_info 时保守当作必填）。 */
  function inputIsRequired(nodeType, inputName) {
    if (!isPlainObject(objectInfo)) return true
    const def = objectInfo[nodeType]
    if (!isPlainObject(def) || !isPlainObject(def.input)) return true
    if (isPlainObject(def.input.required) && Object.prototype.hasOwnProperty.call(def.input.required, inputName)) return true
    if (isPlainObject(def.input.optional) && Object.prototype.hasOwnProperty.call(def.input.optional, inputName)) return false
    return true
  }

  // ---- 小部件值映射 ---------------------------------------------------------
  function widgetNamesFromInputs(node) {
    const names = []
    if (Array.isArray(node.inputs)) {
      for (const input of node.inputs) {
        if (input && isPlainObject(input.widget) && typeof input.widget.name === 'string') {
          names.push(input.widget.name)
        }
      }
    }
    return names
  }

  function mapWidgetValues(node, schema) {
    const nodeLabel = `节点 #${node.id} (${node.type})`
    const values = new Map()
    const named = isPlainObject(node.widgets_values_named)
      ? node.widgets_values_named
      : isPlainObject(node.widgets_values)
        ? node.widgets_values
        : null

    // 新导出格式：widgets_values_named 直接按名字对位，不会错位。
    if (named) {
      if (schema.defs) {
        for (const def of schema.defs) {
          if (Object.prototype.hasOwnProperty.call(named, def.name) && named[def.name] != null) {
            values.set(def.name, named[def.name])
          }
        }
      } else {
        // 没有 schema：只取能从 inputs[].widget.name 确认名字的那些值
        const names = widgetNamesFromInputs(node).filter((name) =>
          Object.prototype.hasOwnProperty.call(named, name),
        )
        if (!names.length) warn(`${nodeLabel}：缺少小部件定义，已忽略 widgets_values_named`)
        for (const name of names) {
          if (named[name] != null) values.set(name, named[name])
        }
      }
      return values
    }

    const positional = Array.isArray(node.widgets_values) ? node.widgets_values : null
    if (!positional) return values

    if (schema.defs) {
      const expected = schema.defs.reduce(
        (total, def) => total + 1 + (def.control ? 1 : 0) + (def.upload ? 1 : 0),
        0,
      )
      if (positional.length !== expected) {
        if (schema.source === 'object_info') {
          warn(
            `${nodeLabel}：widgets_values 数量 ${positional.length} 与 object_info 预期 ${expected} 不一致，参数可能错位`,
          )
        } else if (schema.source === 'builtin') {
          warn(`${nodeLabel}：widgets_values 数量 ${positional.length} 与内置 schema 预期 ${expected} 不一致`)
        }
      }
      let position = 0
      for (let index = 0; index < schema.defs.length; index += 1) {
        const def = schema.defs[index]
        if (position >= positional.length) break
        const value = positional[position]
        position += 1
        // seed 后面可能跟一个生成控制值（fixed/increment/decrement/randomize）
        if (def.control && position < positional.length) {
          const next = positional[position]
          if (typeof next === 'string' && CONTROL_VALUES.has(next)) position += 1
        }
        // 上传按钮等 UI 专用小部件会多占一个值；只在“确实有多余值”时占用
        if (def.upload) {
          const remainingExpected = schema.defs
            .slice(index + 1)
            .reduce((total, rest) => total + 1 + (rest.control ? 1 : 0) + (rest.upload ? 1 : 0), 0)
          const surplus = positional.length - position - remainingExpected
          if (surplus > 0) position += 1
        }
        if (value !== undefined && value !== null) values.set(def.name, value)
      }
      return values
    }

    // 没有 object_info 也没有内置 schema：按 inputs[].widget.name 的顺序尽力对位。
    const widgetNames = widgetNamesFromInputs(node)
    if (!widgetNames.length) {
      warn(`${nodeLabel}：缺少 object_info 且无法从 inputs 推断小部件名称，已跳过其小部件值`)
      return values
    }
    if (positional.length !== widgetNames.length) {
      warn(
        `${nodeLabel}：按 inputs[].widget.name 顺序启发式映射 ${Math.min(
          positional.length,
          widgetNames.length,
        )} 个小部件值，可能与真实顺序不一致`,
      )
    }
    const count = Math.min(positional.length, widgetNames.length)
    for (let index = 0; index < count; index += 1) {
      const value = positional[index]
      if (value !== undefined && value !== null) values.set(widgetNames[index], value)
    }
    return values
  }

  // ---- 主循环 ---------------------------------------------------------------
  const apiGraph = {}
  let bypassedCount = 0
  for (const node of nodes) {
    if (node.id == null) {
      warn('跳过缺少 id 的节点')
      continue
    }
    const type = node.type
    if (typeof type !== 'string' || !type) {
      warn(`节点 #${node.id} 缺少 type，已跳过`)
      continue
    }
    if (type === REROUTE_TYPE || type === PRIMITIVE_NODE_TYPE || NOTE_TYPES.has(type)) continue
    if (node.mode === 2) {
      warn(`节点 #${node.id} (${type}) 已静音 (mode=2)，已跳过`)
      continue
    }
    if (node.mode === 4) {
      bypassedCount += 1
      continue
    }

    const nodeId = String(node.id)
    if (apiGraph[nodeId]) {
      warn(`节点 #${nodeId} 重复，后者覆盖前者`)
    }

    const inputs = {}
    // 1) 链路输入（含被“转成输入”的小部件，此时 link 优先于 widgets_values）
    if (Array.isArray(node.inputs)) {
      for (const input of node.inputs) {
        if (!input || typeof input.name !== 'string' || !input.name) continue
        if (input.link == null) continue
        const resolved = resolveLink(input.link, input.type)
        if (!resolved) continue
        if (resolved.kind === 'missing') {
          if (inputIsRequired(type, input.name)) {
            warn(`输入 "${input.name}" 依赖的链路没有数据：${resolved.reason}（ComfyUI 运行时可能报缺少输入）`)
          }
          continue
        }
        if (resolved.kind === 'literal') inputs[input.name] = resolved.value
        else inputs[input.name] = [resolved.nodeId, resolved.slot]
      }
    }

    // 2) 小部件值
    const schema = widgetSchemaFor(type, objectInfo, warn)
    const widgetValues = mapWidgetValues(node, schema)
    for (const [name, value] of widgetValues) {
      if (Object.prototype.hasOwnProperty.call(inputs, name)) continue
      inputs[name] = value
    }

    const apiNode = { class_type: type, inputs }
    if (typeof node.title === 'string' && node.title) apiNode._meta = { title: node.title }
    apiGraph[nodeId] = apiNode
  }

  if (bypassedCount > 0) {
    warn(`工作流里有 ${bypassedCount} 个 bypass 节点，已按同类型输入自动透传（不写入 API 图）`)
  }

  if (Object.keys(apiGraph).length === 0) {
    throw fail('工作流中没有可执行节点（全是 Note/Reroute/Primitive、子图实例或被静音/bypass 的节点）')
  }
  return { apiGraph, warnings: collector.warnings }
}

// ---------------------------------------------------------------------------
// buildParamSpecs
// ---------------------------------------------------------------------------

/** 收集 objectInfo 里某个节点类的「输入名 -> 解析后的 spec」。 */
function inputSpecMapForClass(objectInfo, nodeClass) {
  const map = new Map()
  const nodeDef = isPlainObject(objectInfo) ? objectInfo[nodeClass] : undefined
  if (!isPlainObject(nodeDef) || !isPlainObject(nodeDef.input)) return map
  for (const group of ['required', 'optional']) {
    const specs = nodeDef.input[group]
    if (!isPlainObject(specs)) continue
    for (const [name, rawSpec] of Object.entries(specs)) {
      const spec = parseInputSpec(rawSpec)
      if (spec) map.set(name, spec)
    }
  }
  return map
}

function describeParamType(value, spec) {
  let type
  let options
  if (spec && spec.kind !== 'link') {
    if (spec.kind === 'enum') {
      type = 'enum'
      if (Array.isArray(spec.options) && spec.options.length) {
        options = spec.options.filter(isPrimitiveValue).map((option) => String(option))
      }
    } else {
      type = spec.kind
    }
  }
  if (!type || (type === 'enum' && !options)) {
    // objectInfo 缺失 / 枚举没有选项时按 JS 值推断
    if (typeof value === 'boolean') type = 'boolean'
    else if (typeof value === 'number') type = Number.isInteger(value) ? 'integer' : 'number'
    else if (typeof value === 'string') type = 'string'
    else return null
    options = undefined
  }
  return { type, options }
}

function isPromptCandidate(inputName, value) {
  return typeof value === 'string' && PROMPT_INPUT_NAMES.has(inputName)
}

function classifyPromptTitle(title) {
  const text = String(title || '').toLowerCase()
  if (/negative|负/.test(text)) return 'negative'
  if (/positive|正/.test(text)) return 'positive'
  return null
}

/**
 * 按拓扑补充提示词归类：沿着其它节点的 `positive`/`negative` 输入反向追溯，
 * 把链路尽头的文本编码节点分别归到正/负。
 * ComfyUI 官方默认模板的两个 CLIPTextEncode 常常没有 title，标题规则会漏掉负面提示词，
 * 而 KSampler.positive/negative 的连线是最可靠的语义来源（此处只用于「标题未给出」的节点）。
 * @returns {Map<string,'positive'|'negative'>} nodeId -> category
 */
function inferPromptCategoriesFromTopology(apiGraph, candidateNodeIds) {
  const categories = new Map()
  const candidateSet = new Set(candidateNodeIds)
  const visited = new Set()
  if (!candidateSet.size) return categories

  const trace = (nodeId, category, depth) => {
    const key = `${category}|${nodeId}`
    if (depth > 16 || visited.has(key)) return
    visited.add(key)
    const node = apiGraph[nodeId]
    if (!isPlainObject(node)) return
    if (candidateSet.has(nodeId)) {
      if (!categories.has(nodeId)) categories.set(nodeId, category)
      return
    }
    const inputs = isPlainObject(node.inputs) ? node.inputs : {}
    for (const value of Object.values(inputs)) {
      if (isLinkValue(value)) trace(String(value[0]), category, depth + 1)
    }
  }

  for (const node of Object.values(apiGraph)) {
    if (!isPlainObject(node) || !isPlainObject(node.inputs)) continue
    for (const [inputName, value] of Object.entries(node.inputs)) {
      if (!isLinkValue(value)) continue
      const lower = inputName.toLowerCase()
      if (lower !== 'positive' && lower !== 'negative') continue
      trace(String(value[0]), lower, 0)
    }
  }
  return categories
}

/**
 * 从 API 图推导可调参数（ParamSpec[]）与提示词注入目标。
 * @returns {{params:object[], promptTargets:{positive:string[],negative:string[]}}}
 */
/**
 * 补充「提示词经过连线转接」的情况：例如子图展开后的 CLIPTextEncode.text 来自
 * 一个 PrimitiveStringMultiline 节点（value 是一个字符串参数），此时 text 输入没有
 * 对应参数，需要把上游字符串参数登记为正/负提示词目标。
 * 沿 guider/sampler 的 positive/negative 输入反向追到能提供字符串参数的节点。
 */
function augmentLinkedPromptTargets(apiGraph, params, promptTargets) {
  if (!isPlainObject(apiGraph) || !Array.isArray(params)) return
  const paramsByNode = new Map()
  for (const param of params) {
    if (!param || param.type !== 'string') continue
    const list = paramsByNode.get(String(param.nodeId)) || []
    list.push(param)
    paramsByNode.set(String(param.nodeId), list)
  }
  const stringParamFor = (nodeId) => {
    const list = paramsByNode.get(String(nodeId)) || []
    return list.find((param) => /value|text|prompt|string|positive|negative/i.test(param.inputName)) || list[0]
  }

  const additions = []
  for (const node of Object.values(apiGraph)) {
    if (!isPlainObject(node) || !isPlainObject(node.inputs)) continue
    for (const [name, value] of Object.entries(node.inputs)) {
      if (!isLinkValue(value)) continue
      const category = /positive|正向/.test(name)
        ? 'positive'
        : (/negative|负向/.test(name) ? 'negative' : null)
      if (!category) continue
      let cursor = String(value[0])
      const seen = new Set()
      for (let depth = 0; depth < 8 && cursor; depth += 1) {
        if (seen.has(cursor)) break
        seen.add(cursor)
        const param = stringParamFor(cursor)
        if (param) {
          additions.push({ category, path: param.path })
          break
        }
        const upstream = isPlainObject(apiGraph[cursor]) && isPlainObject(apiGraph[cursor].inputs)
          ? apiGraph[cursor].inputs
          : {}
        // 优先沿着「文本类」输入往上游走（text/prompt/value…），避免误跟 clip/model 这类连线
        const linkEntries = Object.entries(upstream).filter(([, item]) => isLinkValue(item))
        if (linkEntries.length === 0) break
        const preferred = linkEntries.find(([name]) => /text|prompt|string|value/i.test(name))
        const chosen = preferred || linkEntries[0]
        cursor = String(chosen[1][0])
      }
    }
  }

  for (const item of additions) {
    // 已经有明确归类（例如节点标题写了 Positive/Negative）的目标不再按连线改判
    const already = promptTargets.positive.includes(item.path) || promptTargets.negative.includes(item.path)
    if (already) continue
    const list = promptTargets[item.category]
    if (Array.isArray(list) && !list.includes(item.path)) list.push(item.path)
    const param = params.find((entry) => entry.path === item.path)
    if (param) param.isPrompt = true
  }
}

export function buildParamSpecs(apiGraph, objectInfo) {
  const graph = isPlainObject(apiGraph) ? apiGraph : {}
  const entries = []
  const specMapCache = new Map()

  for (const nodeId of orderedNodeIds(graph)) {
    const node = graph[nodeId]
    if (!isPlainObject(node) || typeof node.class_type !== 'string') continue
    const nodeClass = node.class_type
    const inputs = isPlainObject(node.inputs) ? node.inputs : {}
    if (!specMapCache.has(nodeClass)) specMapCache.set(nodeClass, inputSpecMapForClass(objectInfo, nodeClass))
    const specMap = specMapCache.get(nodeClass)
    const nodeTitle =
      isPlainObject(node._meta) && typeof node._meta.title === 'string' && node._meta.title
        ? node._meta.title
        : undefined

    let inputIndex = 0
    for (const [inputName, value] of Object.entries(inputs)) {
      const index = inputIndex++
      if (isLinkValue(value)) continue
      if (!isPrimitiveValue(value)) continue // 数组/对象/空值不是可调参数
      const spec = specMap.get(inputName) || null
      const described = describeParamType(value, spec)
      if (!described) continue
      entries.push({
        nodeId,
        inputName,
        nodeClass,
        nodeTitle,
        index,
        value,
        spec,
        type: described.type,
        options: described.options,
        candidate: isPromptCandidate(inputName, value),
        category: null,
      })
    }
  }

  // 提示词正负归类：标题 -> 图拓扑（KSampler.positive/negative 等连线反查）-> 兜底。
  const candidates = entries.filter((entry) => entry.candidate)
  for (const entry of candidates) {
    entry.category = classifyPromptTitle(entry.nodeTitle)
  }
  const topologyCategories = inferPromptCategoriesFromTopology(
    graph,
    [...new Set(candidates.map((entry) => entry.nodeId))],
  )
  for (const entry of candidates) {
    if (!entry.category && topologyCategories.has(entry.nodeId)) {
      entry.category = topologyCategories.get(entry.nodeId)
    }
  }
  // 兜底（契约 §4）：没有显式 positive 时，第一个非 negative 的候选当 positive，其余不归类。
  if (!candidates.some((entry) => entry.category === 'positive')) {
    const first = candidates.find((entry) => entry.category !== 'negative')
    if (first) first.category = 'positive'
  }

  const rank = (entry) => (entry.category === 'positive' ? 0 : entry.category === 'negative' ? 1 : 2)
  const sorted = entries.slice().sort((a, b) => {
    const byRank = rank(a) - rank(b)
    if (byRank !== 0) return byRank
    const byNode = compareNodeIds(a.nodeId, b.nodeId)
    if (byNode !== 0) return byNode
    return a.index - b.index
  })

  const params = []
  const promptTargets = { positive: [], negative: [] }
  for (const entry of sorted) {
    const multiline =
      (entry.spec && entry.spec.kind === 'string' && entry.spec.multiline) ||
      (typeof entry.value === 'string' && (entry.value.includes('\n') || entry.value.length > 120))
    const param = {
      path: `${entry.nodeId}.${entry.inputName}`,
      nodeId: entry.nodeId,
      inputName: entry.inputName,
      nodeClass: entry.nodeClass,
      type: entry.type,
      value: entry.value,
    }
    if (entry.nodeTitle) param.nodeTitle = entry.nodeTitle
    if (entry.type === 'enum' && entry.options) param.options = entry.options
    if (entry.spec) {
      if (entry.spec.min !== undefined) param.min = entry.spec.min
      if (entry.spec.max !== undefined) param.max = entry.spec.max
      if (entry.spec.step !== undefined) param.step = entry.spec.step
    }
    if (multiline) param.multiline = true
    if (entry.category) {
      param.isPrompt = true
      promptTargets[entry.category].push(param.path)
    }
    params.push(param)
  }
  augmentLinkedPromptTargets(apiGraph, params, promptTargets)
  return { params, promptTargets }
}

// ---------------------------------------------------------------------------
// applyParamOverrides
// ---------------------------------------------------------------------------

function inferTypeFromValue(value) {
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  if (typeof value === 'string') return 'string'
  return null
}

function convertOverrideValue(rawValue, type, options, path, warnings) {
  const numeric = (value) => {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
    return undefined
  }

  if (type === 'integer' || type === 'number') {
    const parsed = numeric(rawValue)
    if (parsed === undefined) {
      warnings.push(`参数 ${path} 需要${type === 'integer' ? '整数' : '数字'}，收到：${JSON.stringify(rawValue)}`)
      return undefined
    }
    if (type === 'integer' && !Number.isInteger(parsed)) {
      const rounded = Math.round(parsed)
      warnings.push(`参数 ${path} 需要整数，已将 ${parsed} 取整为 ${rounded}`)
      return rounded
    }
    return parsed
  }

  if (type === 'boolean') {
    if (typeof rawValue === 'boolean') return rawValue
    if (typeof rawValue === 'number' && (rawValue === 0 || rawValue === 1)) return rawValue === 1
    if (typeof rawValue === 'string') {
      const text = rawValue.trim().toLowerCase()
      if (['true', '1', 'yes', 'on'].includes(text)) return true
      if (['false', '0', 'no', 'off'].includes(text)) return false
    }
    warnings.push(`参数 ${path} 需要布尔值，收到：${JSON.stringify(rawValue)}`)
    return undefined
  }

  if (type === 'enum') {
    if (Array.isArray(options) && options.length) {
      if (typeof rawValue === 'string' && options.includes(rawValue)) return rawValue
      const asText = String(rawValue)
      if (options.includes(asText)) return asText
      warnings.push(`参数 ${path} 的值 ${JSON.stringify(rawValue)} 不在枚举选项内（仍已写入）`)
    }
    return rawValue
  }

  if (type === 'string') {
    if (typeof rawValue === 'string') return rawValue
    if (typeof rawValue === 'number' || typeof rawValue === 'boolean') return String(rawValue)
    warnings.push(`参数 ${path} 需要字符串，收到：${JSON.stringify(rawValue)}`)
    return undefined
  }

  // 未知类型：按 JS 值原样写入
  return rawValue
}

/**
 * 应用参数覆盖。path 形如 '3.seed' / '6.ckpt_name'（只支持两级）。
 * @param {object} apiGraph
 * @param {object[]} params buildParamSpecs 的结果
 * @param {Record<string,string|number|boolean>} overrides
 * @returns {{apiGraph:object, applied:{path:string,value:unknown}[], warnings:string[]}}
 */
export function applyParamOverrides(apiGraph, params, overrides) {
  const graph = cloneValue(isPlainObject(apiGraph) ? apiGraph : {})
  const applied = []
  const warnings = []
  const paramByPath = new Map()
  for (const param of Array.isArray(params) ? params : []) {
    if (isPlainObject(param) && typeof param.path === 'string') paramByPath.set(param.path, param)
  }

  if (overrides == null) return { apiGraph: graph, applied, warnings }
  if (!isPlainObject(overrides)) {
    warnings.push('params 必须是对象，形如 { "节点id.输入名": 值 }')
    return { apiGraph: graph, applied, warnings }
  }

  for (const [path, rawValue] of Object.entries(overrides)) {
    if (typeof path !== 'string') continue
    const dot = path.indexOf('.')
    if (dot <= 0 || dot === path.length - 1 || path.indexOf('.', dot + 1) !== -1) {
      warnings.push(`不支持嵌套参数路径：${path}（只支持 "节点id.输入名" 两级）`)
      continue
    }
    const nodeId = path.slice(0, dot)
    const inputName = path.slice(dot + 1)
    const node = graph[nodeId]
    if (!isPlainObject(node) || !isPlainObject(node.inputs) || !Object.prototype.hasOwnProperty.call(node.inputs, inputName)) {
      warnings.push(`找不到参数路径：${path}`)
      continue
    }
    const existing = node.inputs[inputName]
    if (isLinkValue(existing)) {
      warnings.push(`参数 ${path} 当前是连线输入，不能直接覆盖`)
      continue
    }
    if (rawValue === undefined) {
      warnings.push(`参数 ${path} 的值为 undefined，已忽略`)
      continue
    }
    if (rawValue === null || typeof rawValue === 'object') {
      warnings.push(`参数 ${path} 只支持字符串/数字/布尔值`)
      continue
    }
    const param = paramByPath.get(path)
    const type = (param && param.type) || inferTypeFromValue(existing)
    const options = param && Array.isArray(param.options) ? param.options : undefined
    const converted = convertOverrideValue(rawValue, type, options, path, warnings)
    if (converted === undefined) continue
    node.inputs[inputName] = converted
    applied.push({ path, value: converted })
  }
  return { apiGraph: graph, applied, warnings }
}

// ---------------------------------------------------------------------------
// applyPrompts
// ---------------------------------------------------------------------------

/**
 * 把提示词写入 buildParamSpecs 推导出的目标路径。
 * @param {object} apiGraph
 * @param {{positive:string[],negative:string[]}} promptTargets
 * @param {{prompt?:string,negativePrompt?:string}} prompts
 * @param {object[]} [params] 预留（路径中的 inputName 已足够定位字段）
 * @returns {{apiGraph:object, applied:{path:string,field:string,value:string}[], warnings:string[]}}
 */
export function applyPrompts(apiGraph, promptTargets, { prompt, negativePrompt } = {}, params) {
  void params
  const graph = cloneValue(isPlainObject(apiGraph) ? apiGraph : {})
  const applied = []
  const warnings = []
  const hasPrompt = typeof prompt === 'string' && prompt.length > 0
  const hasNegativePrompt = typeof negativePrompt === 'string' && negativePrompt.length > 0
  if (!hasPrompt && !hasNegativePrompt) return { apiGraph: graph, applied, warnings }

  const targets = isPlainObject(promptTargets) ? promptTargets : {}
  const positive = Array.isArray(targets.positive) ? targets.positive : []
  const negative = Array.isArray(targets.negative) ? targets.negative : []

  const write = (path, value) => {
    if (typeof path !== 'string') return false
    const dot = path.indexOf('.')
    if (dot <= 0 || dot === path.length - 1) {
      warnings.push(`提示词目标路径不合法：${String(path)}`)
      return false
    }
    const nodeId = path.slice(0, dot)
    const inputName = path.slice(dot + 1)
    const node = graph[nodeId]
    if (!isPlainObject(node) || !isPlainObject(node.inputs) || !Object.prototype.hasOwnProperty.call(node.inputs, inputName)) {
      warnings.push(`提示词目标不存在：${path}`)
      return false
    }
    node.inputs[inputName] = value
    applied.push({ path, field: inputName, value })
    return true
  }

  if (hasPrompt) {
    if (!positive.length) warnings.push('没有检测到正向提示词输入节点（text/positive），prompt 未写入')
    for (const path of positive) write(path, prompt)
  }
  if (hasNegativePrompt) {
    if (!negative.length) warnings.push('没有检测到负面提示词输入节点（negative），negativePrompt 未写入')
    for (const path of negative) write(path, negativePrompt)
  }
  return { apiGraph: graph, applied, warnings }
}

// ---------------------------------------------------------------------------
// mergeImport
// ---------------------------------------------------------------------------

function listGraphNodes(apiGraph) {
  const nodes = []
  for (const nodeId of orderedNodeIds(apiGraph)) {
    const node = apiGraph[nodeId]
    if (!isPlainObject(node) || typeof node.class_type !== 'string') continue
    const item = { id: nodeId, class: node.class_type }
    if (isPlainObject(node._meta) && typeof node._meta.title === 'string' && node._meta.title) {
      item.title = node._meta.title
    }
    nodes.push(item)
  }
  return nodes
}

function normalizeApiGraph(raw) {
  if (!isPlainObject(raw)) throw fail('不是 ComfyUI API 格式工作流：期望 { 节点id: { class_type, inputs } }')
  const apiGraph = {}
  for (const [nodeId, node] of Object.entries(raw)) {
    if (!isPlainObject(node) || typeof node.class_type !== 'string') continue
    const copy = cloneValue(node)
    if (!isPlainObject(copy.inputs)) copy.inputs = {}
    apiGraph[nodeId] = copy
  }
  if (!Object.keys(apiGraph).length) throw fail('工作流中没有可执行节点（API 格式为空）')
  return apiGraph
}

/**
 * 一站式导入：parse -> (UI ? uiToApiGraph) -> buildParamSpecs。
 * @param {{name?:string, raw?:unknown, objectInfo?:object}} input
 * @returns {{name:string, format:'ui'|'api', source:'ui'|'api', apiGraph:object, uiGraph?:object,
 *            nodes:{id:string,class:string,title?:string}[], params:object[],
 *            promptTargets:{positive:string[],negative:string[]}, warnings:string[]}}
 */
export function mergeImport({ name, raw, objectInfo } = {}) {
  const parsed = parseWorkflowJson(raw)
  let apiGraph
  let uiGraph
  let warnings = []

  if (parsed.format === 'ui') {
    const converted = uiToApiGraph(parsed.raw, objectInfo)
    apiGraph = converted.apiGraph
    warnings = converted.warnings.slice()
    uiGraph = cloneValue(parsed.raw)
  } else {
    apiGraph = normalizeApiGraph(parsed.raw)
  }

  const { params, promptTargets } = buildParamSpecs(apiGraph, objectInfo)
  const cleanName = typeof name === 'string' && name.trim() ? name.trim() : '未命名工作流'
  const result = {
    name: cleanName,
    format: parsed.format,
    source: parsed.format,
    apiGraph,
    nodes: listGraphNodes(apiGraph),
    params,
    promptTargets,
    warnings,
  }
  if (uiGraph !== undefined) result.uiGraph = uiGraph
  return result
}

// ---------------------------------------------------------------------------
// summarizeGraph
// ---------------------------------------------------------------------------

/** 图摘要（可选辅助函数）：{ nodeCount, classes: Record<string, number> } */
export function summarizeGraph(apiGraph) {
  const classes = {}
  let nodeCount = 0
  if (isPlainObject(apiGraph)) {
    for (const node of Object.values(apiGraph)) {
      if (!isPlainObject(node) || typeof node.class_type !== 'string') continue
      nodeCount += 1
      classes[node.class_type] = (classes[node.class_type] || 0) + 1
    }
  }
  return { nodeCount, classes }
}
