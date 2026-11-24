/**
 * dsh-sendcomfy — 工作流能力画像与 AI 自主选型
 * ============================================================================
 * 契约：CONTRACT.md §11.1 / §11.2。
 *
 * 会话里的文本模型不该让用户「先挑工作流、再报名字」，它只需要知道用户想要什么：
 *   - describeWorkflow(apiGraph)  从 API 图推导「这个工作流是干什么的」
 *     （文生图 / 图生图 / 局部重绘 / 放大 / ControlNet / LoRA / 视频 / 音频、需要准备的输入、输出类型）
 *   - chooseCandidates(task, ...) 按确定性规则给「任务描述 × 候选工作流」打分排序，交给模型自己决定
 *
 * 纯函数、零第三方依赖、无 I/O、不修改入参；坏输入一律降级成 'other'，不抛错。
 */
import { summarizeGraph } from './workflow.mjs'

/** 能力标签顺序：既是 kinds 的输出顺序，也是 kindLabels 的顺序。 */
export const KINDS = ['txt2img', 'img2img', 'inpaint', 'upscale', 'controlnet', 'lora', 'video', 'audio', 'other']

/** 能力标签的中文名。 */
export const KIND_LABELS = {
  txt2img: '文生图',
  img2img: '图生图',
  inpaint: '局部重绘',
  upscale: '放大',
  controlnet: 'ControlNet',
  lora: 'LoRA',
  video: '视频',
  audio: '音频',
  other: '其他',
}

/** 意图词典：命中任意词条即把对应能力加入 intentKinds。 */
const INTENT_WORDS = {
  txt2img: [
    '文生图', '文转图', '文字生图', '生成图', '生成图片', '生成一张', '画一', '画个', '绘制', '出图',
    '插画', '海报', '头像', '壁纸', '想象', '创作', 'txt2img', 'text to image', 'text2img',
    'generate image', 'generate a', 'draw', 'paint', 'illustration', 'poster', 'avatar', 'wallpaper',
  ],
  img2img: [
    '图生图', '重绘', '改图', '换风格', '风格化', '垫图', '参考图', '以图生图', '把这张图', '这张图', '原图',
    'img2img', 'image to image', 'image2image', 'restyle', 'style transfer', 'reference image',
    'based on this image', 'this image', '输入图', '输入图片',
  ],
  inpaint: [
    '局部重绘', '遮罩', '蒙版', '修复', '抹除', '去掉', '擦除', '消除', '去除',
    'inpaint', 'inpainting', 'mask', 'remove', 'erase',
  ],
  upscale: [
    '放大', '超分', '高清', '清晰', '清晰化', '修复老照片', '提升分辨率',
    'upscale', 'upscaler', 'upscaling', 'super resolution', 'superres', 'hires', '4k', '8k',
    'sharpen', 'enhance resolution', 'higher resolution',
  ],
  video: ['视频', '动画', '动图', '图生视频', '文生视频', '补帧', '延长', 'video', 'animate', 'animation', 'gif', 'i2v', 't2v', 'motion'],
  audio: ['音频', '语音', '声音', '音乐', '配音', '朗读', 'audio', 'voice', 'speech', 'tts', 'music', 'sound'],
  controlnet: ['线稿', '姿势', '骨架', '深度', '边缘', '结构控制', 'controlnet', 'canny', 'pose', 'depth', 'openpose', 'lineart', 'scribble'],
  lora: ['lora', '风格模型', '微调模型', '角色模型', '画风', '风格'],
}

/** 英文分词停用词。 */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'for', 'with', 'is', 'are', 'my', 'this', 'that',
  'please', 'can', 'you', 'i', 'me', 'we', 'it', 'in', 'on', 'at', 'by', 'as', 'be', 'do', 'one',
  'image', 'picture', 'pic', 'photo', 'img', 'use', 'using', 'want', 'make', 'need', 'should',
])

/** 中文虚词/语气词：不参与「名称包含任务串」这类关键字面匹配。 */
const CJK_FILLERS = new Set([
  '的', '了', '吧', '呀', '啊', '呢', '一张', '一个', '帮我', '请', '用', '把', '张', '只', '下',
  '这张', '这个', '给我', '做成', '里', '一下', '图', '图片',
])

/** 文件输入类（运行前必须先上传/准备）。 */
const FILE_INPUT_RULES = [
  { re: /^LoadImage(Mask|MaskOnly)?$/, label: '输入图片' },
  { re: /^LoadImageOutput$/, label: '输入图片（来自输出）' },
  { re: /^VHS_LoadImage$/, label: '输入图片' },
  { re: /^LoadVideo$|^VHS_LoadVideo|^LoadVideoUpload$/, label: '输入视频' },
  { re: /^VHS_LoadAudio|^LoadAudio$|^LoadAudioUpload$/, label: '输入音频' },
  { re: /^LoadMask$|^LoadImageMask$|^ImageToMask$|^LoadImageMaskUpload$/, label: '遮罩图片' },
]

const LOAD_FILE_CLASS_RE = /^(LoadImage|LoadImageMask|LoadImageMaskUpload|LoadImageOutput|LoadVideo|LoadVideoUpload|LoadAudio|LoadAudioUpload|VHS_LoadVideo|VHS_LoadAudio|VHS_LoadImage|LoadMask|ImageToMask)$/

const UPSCALE_CLASS_RE = /(UpscaleModelLoader|ImageUpscaleWithModel|UltimateSDUpscale|LatentUpscale|ImageScaleBy|ImageScale|NomosUpscaler)/
const CONTROLNET_CLASS_RE = /(ControlNetLoader|ControlNetApply|^ACN_|T2IAdapterLoader)/
const LORA_CLASS_RE = /^(LoraLoader|LoraLoaderModelOnly|LoraLoaderList)$/
const VIDEO_CLASS_RE = /(EmptyHunyuanLatentVideo|WanImageToVideo|WanFirstLastFrameToVideo|EmptyMochiLatentVideo|AnimateDiff|^VHS_|SaveAnimatedWEBP|SaveAnimatedPNG|^CreateVideo$|^SaveVideo$|^SaveWEBM$|SVD_|SamplerCustomVideo|CosmosVideo)/
const AUDIO_CLASS_RE = /(SaveAudio|PreviewAudio|LoadAudio|Audio|Voice|Speech|TTS)/
const INPAINT_CLASS_RE = /(VAEEncodeForInpaint|InpaintModelConditioning|SetLatentNoiseMask)/
const SAMPLER_CLASS_RE = /^(KSampler|KSamplerAdvanced|SamplerCustom|SamplerCustomAdvanced)$/
const EMPTY_LATENT_CLASS_RE = /^(EmptyLatentImage|EmptySD3LatentImage|EmptyFluxLatentImage|EmptyHunyuanLatentVideo|EmptyMochiLatentVideo)$/
const TEXT_ENCODE_CLASS_RE = /(CLIPTextEncode|TextEncode)/
const VAE_ENCODE_CLASS_RE = /^(VAEEncode|VAEEncodeForInpaint|VAEEncodeTiled)$/
const VAE_DECODE_CLASS_RE = /^(VAEDecode|VAEDecodeTiled|VAEDecodeAudio)$/

const OUT_IMAGE = new Set(['SaveImage', 'PreviewImage', 'SaveImagePlus'])
const OUT_VIDEO_RE = /(VHS_VideoCombine|SaveAnimatedWEBP|SaveAnimatedPNG|^CreateVideo$|^SaveVideo$|^SaveWEBM$|SaveGif)/
const OUT_AUDIO_RE = /(SaveAudio|PreviewAudio)/
const OUT_LATENT = new Set(['SaveLatent', 'PreviewLatent'])

const MODEL_FILE_RE = /\.(safetensors|ckpt|pt|pth|bin|gguf|onnx|sft)$/i
const MAX_CLASSES = 60
const MAX_MODELS = 20
const MAX_LIST = 10   // chooseCandidates(limit) 允许的候选上限

/* ───────────────────────────── 小工具 ───────────────────────────── */

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isLinkValue(value) {
  return Array.isArray(value)
    && value.length === 2
    && typeof value[0] === 'string'
    && (typeof value[1] === 'number' || typeof value[1] === 'string')
}

function inputEntries(apiGraph) {
  if (!isPlainObject(apiGraph)) return []
  const list = []
  for (const [id, node] of Object.entries(apiGraph)) {
    if (!isPlainObject(node)) continue
    const classType = typeof node.class_type === 'string' ? node.class_type : ''
    if (!classType) continue
    list.push({ id: String(id), node, classType })
  }
  return list
}

function nodeInputs(node) {
  return isPlainObject(node) && isPlainObject(node.inputs) ? Object.entries(node.inputs) : []
}

function titleOf(node) {
  if (!isPlainObject(node) || !isPlainObject(node._meta)) return ''
  return typeof node._meta.title === 'string' ? node._meta.title.trim() : ''
}

/** 顶点出发可达的所有节点 id 集合（带上限，防环）。 */
function reachableFrom(apiGraph, startId, limit = 500) {
  const seen = new Set()
  const stack = [String(startId)]
  while (stack.length > 0 && seen.size < limit) {
    const id = stack.pop()
    if (seen.has(id)) continue
    seen.add(id)
    const node = apiGraph[id]
    if (!isPlainObject(node)) continue
    for (const [, value] of nodeInputs(node)) {
      if (isLinkValue(value) && !seen.has(String(value[0]))) stack.push(String(value[0]))
    }
  }
  return seen
}

/** 中文一句话总结：能力 + 提示词 + 需要准备的输入 + 输出。 */
function summarizeCapabilities(kinds, hasPrompt, hasNegative, neededInputs, outputKinds) {
  const parts = []
  const kindLabels = kinds
    .filter((kind) => kind !== 'other')
    .map((kind) => KIND_LABELS[kind])
  parts.push(kindLabels.length > 0 ? `${kindLabels.join(' + ')} 工作流` : '未识别的执行工作流')
  if (hasPrompt) parts.push(hasNegative ? '支持正负提示词' : '支持正向提示词')
  else parts.push('没有可注入的提示词文本节点')
  if (neededInputs.length > 0) parts.push(`运行前需准备 ${neededInputs.length} 个输入文件（${neededInputs.map((item) => item.label).join('、')}）`)
  else parts.push('无需上传输入文件')
  if (outputKinds.length > 0) parts.push(`输出${outputKinds.map((kind) => ({ image: '图片', video: '视频', audio: '音频', latent: '潜空间' }[kind] || kind)).join('/')}`)
  let text = parts.join('，')
  if (text.length > 120) text = `${text.slice(0, 117)}…`
  return text
}

const IMAGE_OUTPUTS = new Set(['SaveImage', 'PreviewImage', 'SaveImagePlus'])
const LATENT_OUTPUTS = new Set(['SaveLatent', 'PreviewLatent'])

// ---------------------------------------------------------------------------
// describeWorkflow
// ---------------------------------------------------------------------------

/**
 * 从 API 格式的图推导能力画像（CONTRACT §11.2）。
 * 防御式：非对象 / 空图 / 坏节点一律返回 kinds:['other'] 的结果，不抛错。
 *
 * @param {Record<string, unknown>} apiGraph
 * @returns {{ kinds: string[], kindLabels: string[], hasPrompt: boolean, hasNegative: boolean,
 *   classes: string[], models: string[], neededInputs: {param:string,nodeClass:string,inputName:string,label:string,hint:string}[],
 *   outputKinds: string[], summary: string }}
 */
export function describeWorkflow(apiGraph) {
  const empty = {
    kinds: ['other'],
    kindLabels: [KIND_LABELS.other],
    hasPrompt: false,
    hasNegative: false,
    classes: [],
    models: [],
    neededInputs: [],
    outputKinds: [],
    summary: '无法识别的工作流（不是 ComfyUI API 格式，或图里没有可执行节点）',
  }
  if (!isPlainObject(apiGraph)) return empty
  const entries = inputEntries(apiGraph)
  if (entries.length === 0) return empty

  const classList = [...new Set(entries.map((entry) => entry.classType))].slice(0, MAX_CLASSES)
  const hasClass = (re) => classList.some((name) => re.test(name))

  /* ── 输出类型 ── */
  const outputKinds = []
  for (const classType of classList) {
    if (IMAGE_OUTPUTS.has(classType) && !outputKinds.includes('image')) outputKinds.push('image')
    else if (OUT_VIDEO_RE.test(classType) && !outputKinds.includes('video')) outputKinds.push('video')
    else if (OUT_AUDIO_RE.test(classType) && !outputKinds.includes('audio')) outputKinds.push('audio')
    else if (LATENT_OUTPUTS.has(classType) && !outputKinds.includes('latent')) outputKinds.push('latent')
  }

  /* ── 提示词节点 ── */
  const textNodes = entries.filter((entry) => TEXT_ENCODE_CLASS_RE.test(entry.classType))
  let hasPrompt = false
  let hasNegative = false
  for (const { node } of textNodes) {
    const title = titleOf(node)
    if (/negative|负/i.test(title)) hasNegative = true
    for (const [inputName] of nodeInputs(node)) {
      const name = inputName.toLowerCase()
      if (name === 'negative') hasNegative = true
      if (['text', 'text_g', 'text_l', 'prompt', 'positive'].includes(name) && !/negative|负/.test(title)) hasPrompt = true
    }
  }

  /* ── 原图是否经 VAEEncode 进采样（图生图） ── */
  let imageEncoded = false
  for (const { node } of entries) {
    const classType = String(node.class_type || '')
    if (!VAE_ENCODE_CLASS_RE.test(classType)) continue
    for (const [, value] of nodeInputs(node)) {
      if (!isLinkValue(value)) continue
      for (const upstreamId of reachableFrom(apiGraph, value[0])) {
        const upstream = apiGraph[upstreamId]
        if (!isPlainObject(upstream)) continue
        if (/^LoadImage$|^LoadImageOutput$|^VHS_LoadImage$|^LoadImageMask$/.test(String(upstream.class_type || ''))) {
          imageEncoded = true
        }
      }
    }
  }

  const hasSampler = hasClass(SAMPLER_CLASS_RE)
  const hasEmptyLatent = hasClass(EMPTY_LATENT_CLASS_RE)
  const inpaintish = hasClass(INPAINT_CLASS_RE) || classList.includes('LoadImageMask')

  /* ── kinds（按 KINDS 顺序组装） ── */
  const kinds = []
  if (outputKinds.includes('video') || hasClass(VIDEO_CLASS_RE)) kinds.push('video')
  if (outputKinds.includes('audio') || hasClass(AUDIO_CLASS_RE)) kinds.push('audio')
  if (hasClass(UPSCALE_CLASS_RE)) kinds.push('upscale')
  if (hasClass(CONTROLNET_CLASS_RE)) kinds.push('controlnet')
  if (hasClass(LORA_CLASS_RE)) kinds.push('lora')
  if (imageEncoded && inpaintish) kinds.push('inpaint')
  if (imageEncoded) kinds.push('img2img')
  if (hasSampler && (hasEmptyLatent || !imageEncoded)) kinds.push('txt2img')
  if (kinds.length === 0) kinds.push('other')
  const orderedKinds = KINDS.filter((kind) => kinds.includes(kind))

  /* ── 需要准备的输入文件 ── */
  const neededInputs = []
  for (const { id, node, classType } of entries) {
    const rule = FILE_INPUT_RULES.find((item) => item.re.test(classType))
    if (!rule) continue
    for (const [inputName, value] of nodeInputs(node)) {
      if (value === null || value === undefined) continue
      if (typeof value === 'object') continue
      neededInputs.push({
        param: `${id}.${inputName}`,
        nodeClass: classType,
        inputName,
        label: rule.label,
        hint: `先用 comfy_upload_image 上传文件（path 填工作区路径），再把返回的 name 填进参数 "${id}.${inputName}"`,
      })
      break
    }
  }

  /* ── 模型文件：字面量里像 *.safetensors 之类的值 ── */
  const models = []
  for (const { node } of entries) {
    for (const [inputName, value] of nodeInputs(node)) {
      if (typeof value !== 'string' || !MODEL_FILE_RE.test(value.trim())) continue
      const normalized = value.trim()
      if (models.includes(normalized) || models.length >= MAX_MODELS) continue
      models.push(normalized)
    }
  }

  return {
    kinds: orderedKinds,
    kindLabels: orderedKinds.map((kind) => KIND_LABELS[kind]),
    hasPrompt,
    hasNegative,
    classes: classList,
    models,
    neededInputs,
    outputKinds,
    summary: summarizeCapabilities(orderedKinds, hasPrompt, hasNegative, neededInputs, outputKinds),
  }
}

/* ───────────────────────────── 任务选型 ───────────────────────────── */

/** 词条归一：小写、去空白。 */
function normalizeWord(word) {
  return String(word || '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/** 中文段 → bigram（长度 ≤2 的段保留原串）。 */
function cjkBigrams(segment) {
  const chars = [...segment]
  if (chars.length <= 2) return [segment]
  const grams = []
  for (let i = 0; i < chars.length - 1; i += 1) grams.push(`${chars[i]}${chars[i + 1]}`)
  return grams
}

/**
 * 任务分词（确定性，不做魔法）。
 *  - 英文/数字：按非字母数字切词，小写、去停用词、长度 ≥3
 *  - 中文：连续 CJK 段拆 bigram
 * @param {string} text
 * @returns {string[]} 去重后的词条
 */
export function tokenizeTask(text) {
  const raw = String(text || '')
  const out = new Set()
  const segments = raw.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  for (const segment of segments) {
    const lower = segment.toLowerCase()
    if (/^[a-z0-9]+$/.test(lower)) {
      if (STOP_WORDS.has(lower)) continue
      if (lower.length >= 3) out.add(lower)
      continue
    }
    if (/^\p{Script=Han}+$/u.test(segment)) {
      for (const gram of cjkBigrams(lower)) {
        if (!CJK_FILLERS.has(gram)) out.add(gram)
      }
      continue
    }
    // 中英混合段：中文部分拆 bigram，英文/数字部分保留
    for (const match of lower.matchAll(/\p{Script=Han}+|[a-z0-9]{3,}/gu)) {
      const token = match[0]
      if (/^\p{Script=Han}+$/u.test(token)) {
        for (const gram of cjkBigrams(token)) {
          if (!CJK_FILLERS.has(gram)) out.add(gram)
        }
      } else if (!STOP_WORDS.has(token)) {
        out.add(token)
      }
    }
  }
  return [...out]
}

/**
 * 从任务描述推断能力意图（CONTRACT §11.2 意图词典）。
 * @param {string} task
 * @returns {string[]} intentKinds，按 KINDS 顺序
 */
export function detectIntentKinds(task) {
  const haystack = ` ${String(task || '').toLowerCase()} `
  if (!haystack.trim()) return []
  const found = []
  for (const [kind, words] of Object.entries(INTENT_WORDS)) {
    if (words.some((word) => haystack.includes(String(word).toLowerCase()))) found.push(kind)
  }
  return KINDS.filter((kind) => found.includes(kind))
}

/**
 * 按任务给候选工作流打分排序（CONTRACT §11.2 的 chooseCandidates）。
 *
 * candidates: { name, description?, tags?, kinds?, kindLabels?, classes?, paramNames?, models? }[]
 * 返回 { matches:[{index,score,matched,reasons}], tokens, intentKinds }
 *  - 确定性、可复现；同分按原始 index 升序
 *  - 无任何命中时仍按原顺序返回前 limit 个，matched:false，附「没有明显匹配」理由
 */
export function chooseCandidates(task, candidates, { limit = 5 } = {}) {
  const taskText = String(task || '')
  const tokens = tokenizeTask(taskText)
  const intentKinds = detectIntentKinds(taskText)
  const list = Array.isArray(candidates) ? candidates : []
  const safeLimit = Math.max(1, Math.min(MAX_LIST, Math.round(Number(limit) || 5)))
  const taskCore = normalizeWord(taskText.replace(/[\s\p{P}]/gu, ''))

  const scored = list.map((candidate, index) => {
    if (!isPlainObject(candidate)) return { index, score: 0, matched: false, reasons: [] }
    let score = 0
    const reasons = []
    const nameText = normalizeWord(candidate.name)
    const nameTokens = tokenizeTask(candidate.name)
    const descriptionText = normalizeWord(candidate.description)
    const tags = Array.isArray(candidate.tags)
      ? candidate.tags.map((tag) => normalizeWord(tag)).filter(Boolean)
      : []
    const kinds = Array.isArray(candidate.kinds) ? candidate.kinds : []
    const extraWords = [
      ...(Array.isArray(candidate.classes) ? candidate.classes : []),
      ...(Array.isArray(candidate.paramNames) ? candidate.paramNames : []),
      ...(Array.isArray(candidate.models) ? candidate.models : []),
    ].map((word) => normalizeWord(word)).filter(Boolean)

    // 1) 名称包含任务串（6–12 字，足够长才算「精确」）
    if (taskCore.length >= 6 && taskCore.length <= 12 && nameText.includes(taskCore)) {
      score += 10
      reasons.push(`名称包含「${String(taskText).trim().slice(0, 12)}」`)
    }

    // 2) 名称 token 命中（每个 +6，封顶 +18）
    const nameHits = tokens.filter((token) => nameTokens.includes(token) || nameText.includes(token))
    if (nameHits.length > 0) {
      score += 6 * Math.min(nameHits.length, 3)
      reasons.push(`名称命中：${nameHits.slice(0, 3).join(' / ')}`)
    }

    // 3) 说明 token 命中（每个 +2，封顶 +6）
    const descriptionHits = tokens.filter((token) => descriptionText.includes(token))
    if (descriptionHits.length > 0) {
      score += Math.min(6, 2 * descriptionHits.length)
      reasons.push(`说明提到：${descriptionHits.slice(0, 3).join(' / ')}`)
    }

    // 4) 标签命中（每个 +3，封顶 +9）
    const tagHits = tokens.filter((token) => tags.includes(token))
    if (tagHits.length > 0) {
      score += Math.min(9, 3 * tagHits.length)
      reasons.push(`标签命中：${tagHits.slice(0, 3).join(' / ')}`)
    }

    // 5) 能力命中意图（每个 +5，封顶 +15）
    const kindHits = intentKinds.filter((kind) => kinds.includes(kind))
    if (kindHits.length > 0) {
      score += 5 * Math.min(kindHits.length, 3)
      reasons.push(`能力匹配：${kindHits.map((kind) => KIND_LABELS[kind] || kind).join(' / ')}`)
    }

    // 6) 节点类 / 参数名 / 模型名命中（每个 +2，封顶 +6）
    const extraHits = tokens.filter((token) => extraWords.some((word) => word.includes(token)))
    if (extraHits.length > 0) {
      score += Math.min(6, 2 * extraHits.length)
      reasons.push(`节点/参数/模型提到：${extraHits.slice(0, 3).join(' / ')}`)
    }

    // 7) 误配高危媒体类型（视频/音频）且任务没要求 → 重罚（避免「视频流」抢「单图放大」这类任务）
    const risky = kinds.filter((kind) => (kind === 'video' || kind === 'audio') && !intentKinds.includes(kind))
    if (risky.length > 0) {
      score -= 8 * risky.length
      reasons.push(`候选包含未要求的${risky.map((kind) => KIND_LABELS[kind] || kind).join('/')}，降权`)
    }

    // 8) 与意图无关的额外能力轻度降权（能力越杂越不专）
    const unrelated = kinds.filter((kind) => ['controlnet', 'inpaint', 'upscale', 'lora'].includes(kind) && !intentKinds.includes(kind))
    if (unrelated.length > 0) score -= 2 * Math.min(unrelated.length, 2)

    // 9) 示例/测试类工作流降权（「示例」流通常不是最佳生产选择）
    if (/示例|example|test|测试|demo|副本|copy/i.test(nameText)) {
      score -= 3
      reasons.push('名称像示例/测试工作流，降权')
    }

    const matched = score > 0
    if (!matched) reasons.push('没有明显匹配，按可用工作流列出')
    return { index, score, matched, reasons: reasons.slice(0, 4) }
  })

  scored.sort((a, b) => (b.score - a.score) || (a.index - b.index))
  return { matches: scored.slice(0, safeLimit), tokens, intentKinds }
}
