/**
 * dsh-sendcomfy — 可编程的本地 mock ComfyUI（node:http，零第三方依赖）
 *
 * 供 test/comfy.test.mjs 与 Lead 的 lib/actions 集成测试复用。
 *
 * 基本用法：
 *   import { startMockComfy } from './mock-comfy.mjs'
 *   const mock = await startMockComfy({ port: 0 })
 *   mock.url            // 'http://127.0.0.1:<port>'，可直接传给 comfy.* / actions.*
 *   mock.state.prompts  // 收到的每个 POST /prompt 的解析后 body（{ prompt, client_id }）
 *   mock.requests       // 每笔请求记录：{ method, path, query, body?, headers, at }
 *   mock.setHistory(entry)      // 此后 GET /history/{任意 id} 都返回 entry
 *   mock.clearHistory()         // 清掉 setHistory / 注入的 history，恢复「还在跑」
 *   mock.setNodeErrors(obj)     // 此后 POST /prompt 的 node_errors 返回 obj（传 {} 清掉）
 *   mock.userdataUnavailable = true   // GET /userdata 返回 404（模拟旧版 ComfyUI）
 *   mock.failNextRoute(path, { status?, body? })  // 下一次命中该路径的请求返回错误
 *   mock.delayRoute(path, ms)   // 命中该路径的请求延迟响应（测超时用）
 *   await mock.close()          // 停止监听、释放端口
 *
 * 默认行为（未编程时）：
 *  - GET  /system_stats -> 200 假系统信息
 *  - GET  /object_info  -> 200 一份真实形状的小样（checkpoints/loras/vae/... 枚举齐全）
 *  - POST /prompt       -> 200 { prompt_id:'mock-<n>', number:<n>, node_errors:{} }
 *  - GET  /history/{id} -> 200 {}  （即「还在跑」，客户端 getHistory -> null）
 *  - GET  /queue        -> 200 { queue_running:[], queue_pending:[] }
 *  - POST /interrupt、POST /queue -> 200 {}
 *  - GET  /view         -> 200 固定 1x1 PNG，Content-Type: image/png
 *  - POST /upload/image -> 200 { name:<原文件名>, subfolder:'', type:'input' }
 *  - GET  /userdata?... -> 200 [{ path:'default.json', size:123, modified:1700000000 }]
 *  - GET  /userdata/{file} -> 200 一份 api 格式工作流 JSON（default.json 有内容）
 *  - 其余路径 -> 404 { error: 'Not Found' }
 */

import http from 'node:http'
import { Buffer } from 'node:buffer'

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const MOCK_MODIFIED = 1700000000

/** 默认 object_info 小样：真实形状（枚举输入是 [ [选项...], {opts} ]）。 */
function makeDefaultObjectInfo() {
  return {
    CheckpointLoaderSimple: {
      name: 'CheckpointLoaderSimple',
      display_name: 'Load Checkpoint',
      category: 'loaders',
      input: {
        required: {
          ckpt_name: [['v1-5-pruned-emaonly.safetensors', 'sd_xl_base_1.0.safetensors'], {}],
        },
      },
      input_order: { required: ['ckpt_name'] },
      output: ['MODEL', 'CLIP', 'VAE'],
      output_name: ['MODEL', 'CLIP', 'VAE'],
      output_node: false,
    },
    CheckpointLoader: {
      name: 'CheckpointLoader',
      display_name: 'Load Checkpoint With Config',
      category: 'loaders',
      input: {
        required: {
          config_name: ['STRING', { default: 'anything_v1.yaml' }],
          ckpt_name: [['v1-5-pruned-emaonly.safetensors'], {}],
        },
      },
      output: ['MODEL', 'CLIP', 'VAE'],
      output_name: ['MODEL', 'CLIP', 'VAE'],
      output_node: false,
    },
    LoraLoader: {
      name: 'LoraLoader',
      display_name: 'Load LoRA',
      category: 'loaders',
      input: {
        required: {
          model: ['MODEL'],
          clip: ['CLIP'],
          lora_name: [['add_detail.safetensors', 'style_xl.safetensors'], {}],
          strength_model: ['FLOAT', { default: 1, min: -100, max: 100, step: 0.01 }],
          strength_clip: ['FLOAT', { default: 1, min: -100, max: 100, step: 0.01 }],
        },
      },
      input_order: { required: ['model', 'clip', 'lora_name', 'strength_model', 'strength_clip'] },
      output: ['MODEL', 'CLIP'],
      output_name: ['MODEL', 'CLIP'],
      output_node: false,
    },
    VAELoader: {
      name: 'VAELoader',
      display_name: 'Load VAE',
      category: 'loaders',
      input: {
        required: {
          vae_name: [['vae-ft-mse-840000-ema-pruned.safetensors', 'sdxl_vae.safetensors'], {}],
        },
      },
      output: ['VAE'],
      output_name: ['VAE'],
      output_node: false,
    },
    CLIPLoader: {
      name: 'CLIPLoader',
      display_name: 'Load CLIP',
      category: 'advanced/loaders',
      input: {
        required: {
          clip_name: [['clip_l.safetensors', 't5xxl_fp16.safetensors'], {}],
          type: [['stable_diffusion', 'stable_cascade', 'sd3', 'flux'], {}],
        },
      },
      output: ['CLIP'],
      output_name: ['CLIP'],
      output_node: false,
    },
    DualCLIPLoader: {
      name: 'DualCLIPLoader',
      display_name: 'DualCLIPLoader',
      category: 'advanced/loaders',
      input: {
        required: {
          clip_name1: [['clip_l.safetensors'], {}],
          clip_name2: [['t5xxl_fp16.safetensors'], {}],
          type: [['sdxl', 'sd3', 'flux'], {}],
        },
      },
      output: ['CLIP'],
      output_name: ['CLIP'],
      output_node: false,
    },
    CLIPVisionLoader: {
      name: 'CLIPVisionLoader',
      display_name: 'Load CLIP Vision',
      category: 'loaders',
      input: {
        required: {
          clip_name: [['clip_vision_h.safetensors', 'clip_vision_g.safetensors'], {}],
        },
      },
      output: ['CLIP_VISION'],
      output_name: ['CLIP_VISION'],
      output_node: false,
    },
    UNETLoader: {
      name: 'UNETLoader',
      display_name: 'Load Diffusion Model',
      category: 'advanced/loaders',
      input: {
        required: {
          unet_name: [['flux1-dev.safetensors', 'flux1-schnell.safetensors'], {}],
          weight_dtype: [['default', 'fp8_e4m3fn', 'fp8_e5m2'], {}],
        },
      },
      output: ['MODEL'],
      output_name: ['MODEL'],
      output_node: false,
    },
    ControlNetLoader: {
      name: 'ControlNetLoader',
      display_name: 'Load ControlNet Model',
      category: 'loaders',
      input: {
        required: {
          control_net_name: [['control_v11p_sd15_canny.pth', 'control_v11f1p_sd15_depth.pth'], {}],
        },
      },
      output: ['CONTROL_NET'],
      output_name: ['CONTROL_NET'],
      output_node: false,
    },
    UpscaleModelLoader: {
      name: 'UpscaleModelLoader',
      display_name: 'Load Upscale Model',
      category: 'loaders',
      input: {
        required: {
          model_name: [['4x-UltraSharp.pth', 'RealESRGAN_x4plus.pth'], {}],
        },
      },
      output: ['UPSCALE_MODEL'],
      output_name: ['UPSCALE_MODEL'],
      output_node: false,
    },
    StyleModelLoader: {
      name: 'StyleModelLoader',
      display_name: 'Load Style Model',
      category: 'loaders',
      input: {
        required: {
          style_model_name: [['style_flux.safetensors'], {}],
        },
      },
      output: ['STYLE_MODEL'],
      output_name: ['STYLE_MODEL'],
      output_node: false,
    },
    GLIGENLoader: {
      name: 'GLIGENLoader',
      display_name: 'GLIGENLoader',
      category: 'loaders',
      input: {
        required: {
          gligen_name: [['gligen_sd14_textbox_pruned.safetensors'], {}],
        },
      },
      output: ['GLIGEN'],
      output_name: ['GLIGEN'],
      output_node: false,
    },
    IPAdapterModelLoader: {
      name: 'IPAdapterModelLoader',
      display_name: 'IPAdapter Model Loader',
      category: 'ipadapter',
      input: {
        required: {
          ipadapter_file: [['ip-adapter_sd15.safetensors', 'ip-adapter-plus_sd15.safetensors'], {}],
        },
      },
      output: ['IPADAPTER'],
      output_name: ['IPADAPTER'],
      output_node: false,
    },
    CLIPTextEncode: {
      name: 'CLIPTextEncode',
      display_name: 'CLIP Text Encode (Prompt)',
      category: 'conditioning',
      input: {
        required: {
          text: ['STRING', { multiline: true, dynamicPrompts: true, default: '' }],
          clip: ['CLIP'],
        },
      },
      input_order: { required: ['text', 'clip'] },
      output: ['CONDITIONING'],
      output_name: ['CONDITIONING'],
      output_node: false,
    },
    KSampler: {
      name: 'KSampler',
      display_name: 'KSampler',
      category: 'sampling',
      input: {
        required: {
          model: ['MODEL'],
          seed: ['INT', { default: 0, min: 0, max: 18446744073709551615 }],
          steps: ['INT', { default: 20, min: 1, max: 10000, step: 1 }],
          cfg: ['FLOAT', { default: 8, min: 0, max: 100, step: 0.1 }],
          sampler_name: [['euler', 'euler_ancestral', 'dpmpp_2m', 'ddim', 'uni_pc'], {}],
          scheduler: [['normal', 'karras', 'exponential', 'sgm_uniform'], {}],
          positive: ['CONDITIONING'],
          negative: ['CONDITIONING'],
          latent_image: ['LATENT'],
          denoise: ['FLOAT', { default: 1, min: 0, max: 1, step: 0.01 }],
        },
      },
      input_order: {
        required: ['model', 'seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'positive', 'negative', 'latent_image', 'denoise'],
      },
      output: ['LATENT'],
      output_name: ['LATENT'],
      output_node: false,
    },
    EmptyLatentImage: {
      name: 'EmptyLatentImage',
      display_name: 'Empty Latent Image',
      category: 'latent',
      input: {
        required: {
          width: ['INT', { default: 512, min: 16, max: 16384, step: 8 }],
          height: ['INT', { default: 512, min: 16, max: 16384, step: 8 }],
          batch_size: ['INT', { default: 1, min: 1, max: 4096 }],
        },
      },
      output: ['LATENT'],
      output_name: ['LATENT'],
      output_node: false,
    },
    VAEDecode: {
      name: 'VAEDecode',
      display_name: 'VAE Decode',
      category: 'latent',
      input: {
        required: {
          samples: ['LATENT'],
          vae: ['VAE'],
        },
      },
      output: ['IMAGE'],
      output_name: ['IMAGE'],
      output_node: false,
    },
    SaveImage: {
      name: 'SaveImage',
      display_name: 'Save Image',
      category: 'image',
      input: {
        required: {
          images: ['IMAGE'],
          filename_prefix: ['STRING', { default: 'ComfyUI' }],
        },
      },
      output: [],
      output_name: [],
      output_node: true,
    },
    LoadImage: {
      name: 'LoadImage',
      display_name: 'Load Image',
      category: 'image',
      input: {
        required: {
          image: [['example.png', 'cat.png'], { image_upload: true }],
        },
      },
      output: ['IMAGE', 'MASK'],
      output_name: ['IMAGE', 'MASK'],
      output_node: false,
    },
  }
}

function makeDefaultSystemStats() {
  return {
    system: {
      os: 'posix',
      ram_total: 64000000000,
      ram_free: 32000000000,
      comfyui_version: '0.3.0-mock',
      python_version: '3.11.0',
      pytorch_version: '2.1.0',
      embedded_python: false,
      argv: ['main.py', '--listen', '127.0.0.1'],
    },
    devices: [
      {
        name: 'cuda:0 Mock GPU : cudaMallocAsync',
        type: 'cuda',
        index: 0,
        vram_total: 25600000000,
        vram_free: 22000000000,
        torch_vram_total: 0,
        torch_vram_free: 0,
      },
    ],
  }
}

/** 一份最小但完整的 api 格式工作流（用默认 object_info 里的节点类）。 */
export function sampleApiWorkflow() {
  return {
    3: {
      class_type: 'KSampler',
      inputs: {
        seed: 42,
        steps: 20,
        cfg: 7,
        sampler_name: 'euler',
        scheduler: 'normal',
        denoise: 1,
        model: ['4', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['5', 0],
      },
      _meta: { title: 'KSampler' },
    },
    4: {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: 'v1-5-pruned-emaonly.safetensors' },
      _meta: { title: 'Load Checkpoint' },
    },
    5: {
      class_type: 'EmptyLatentImage',
      inputs: { width: 512, height: 512, batch_size: 1 },
      _meta: { title: 'Empty Latent Image' },
    },
    6: {
      class_type: 'CLIPTextEncode',
      inputs: { text: 'a photograph of a cat, masterpiece', clip: ['4', 1] },
      _meta: { title: 'Positive Prompt' },
    },
    7: {
      class_type: 'CLIPTextEncode',
      inputs: { text: 'blurry, low quality', clip: ['4', 1] },
      _meta: { title: 'Negative Prompt' },
    },
    8: {
      class_type: 'VAEDecode',
      inputs: { samples: ['3', 0], vae: ['4', 2] },
      _meta: { title: 'VAE Decode' },
    },
    9: {
      class_type: 'SaveImage',
      inputs: { images: ['8', 0], filename_prefix: 'mock' },
      _meta: { title: 'Save Image' },
    },
  }
}

/** 一份 UI 格式工作流小样（给需要 /userdata 返回 UI 格式的测试用）。 */
export function sampleUiWorkflow() {
  return {
    last_node_id: 9,
    last_link_id: 9,
    nodes: [
      {
        id: 4,
        type: 'CheckpointLoaderSimple',
        pos: [26, 474],
        size: [315, 98],
        flags: {},
        order: 0,
        mode: 0,
        inputs: [],
        outputs: [
          { name: 'MODEL', type: 'MODEL', links: [1] },
          { name: 'CLIP', type: 'CLIP', links: [2, 3] },
          { name: 'VAE', type: 'VAE', links: [9] },
        ],
        properties: { 'Node name for S&R': 'CheckpointLoaderSimple' },
        widgets_values: ['v1-5-pruned-emaonly.safetensors'],
      },
      {
        id: 5,
        type: 'EmptyLatentImage',
        pos: [26, 614],
        size: [315, 106],
        flags: {},
        order: 1,
        mode: 0,
        inputs: [],
        outputs: [{ name: 'LATENT', type: 'LATENT', links: [4] }],
        properties: { 'Node name for S&R': 'EmptyLatentImage' },
        widgets_values: [512, 512, 1],
      },
      {
        id: 6,
        type: 'CLIPTextEncode',
        pos: [473, 186],
        size: [422, 164],
        flags: {},
        order: 2,
        mode: 0,
        inputs: [{ name: 'clip', type: 'CLIP', link: 2 }],
        outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [5] }],
        properties: { 'Node name for S&R': 'CLIPTextEncode' },
        widgets_values: ['a photograph of a cat, masterpiece'],
      },
      {
        id: 7,
        type: 'CLIPTextEncode',
        pos: [473, 386],
        size: [422, 164],
        flags: {},
        order: 3,
        mode: 0,
        inputs: [{ name: 'clip', type: 'CLIP', link: 3 }],
        outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [6] }],
        properties: { 'Node name for S&R': 'CLIPTextEncode' },
        widgets_values: ['blurry, low quality'],
      },
      {
        id: 3,
        type: 'KSampler',
        pos: [968, 186],
        size: [315, 262],
        flags: {},
        order: 4,
        mode: 0,
        inputs: [
          { name: 'model', type: 'MODEL', link: 1 },
          { name: 'positive', type: 'CONDITIONING', link: 5 },
          { name: 'negative', type: 'CONDITIONING', link: 6 },
          { name: 'latent_image', type: 'LATENT', link: 4 },
        ],
        outputs: [{ name: 'LATENT', type: 'LATENT', links: [7] }],
        properties: { 'Node name for S&R': 'KSampler' },
        widgets_values: [42, 'randomize', 20, 7, 'euler', 'normal', 1],
      },
      {
        id: 8,
        type: 'VAEDecode',
        pos: [26, 764],
        size: [210, 46],
        flags: {},
        order: 5,
        mode: 0,
        inputs: [
          { name: 'samples', type: 'LATENT', link: 7 },
          { name: 'vae', type: 'VAE', link: 9 },
        ],
        outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [8] }],
        properties: { 'Node name for S&R': 'VAEDecode' },
        widgets_values: [],
      },
      {
        id: 9,
        type: 'SaveImage',
        pos: [288, 764],
        size: [400, 450],
        flags: {},
        order: 6,
        mode: 0,
        inputs: [{ name: 'images', type: 'IMAGE', link: 8 }],
        outputs: [],
        properties: {},
        widgets_values: ['ComfyUI'],
      },
    ],
    links: [
      [1, 4, 0, 3, 0, 'MODEL'],
      [2, 4, 1, 6, 0, 'CLIP'],
      [3, 4, 1, 7, 0, 'CLIP'],
      [4, 5, 0, 3, 3, 'LATENT'],
      [5, 6, 0, 3, 1, 'CONDITIONING'],
      [6, 7, 0, 3, 2, 'CONDITIONING'],
      [7, 3, 0, 8, 0, 'LATENT'],
      [8, 8, 0, 9, 0, 'IMAGE'],
      [9, 4, 2, 8, 1, 'VAE'],
    ],
    groups: [],
    config: {},
    extra: {},
    version: 0.4,
  }
}

function clone(value) {
  if (value === undefined) return undefined
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

function randomHex(bytes = 3) {
  let out = ''
  for (let i = 0; i < bytes; i += 1) out += Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
  return out
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function normalizeKey(pathValue) {
  const raw = String(pathValue || '')
  if (!raw) return '/'
  return raw.startsWith('/') ? raw.replace(/\/+$/, '') || '/' : `/${raw}`.replace(/\/+$/, '') || '/'
}

function routeMatches(routeKey, pathname) {
  if (routeKey === '*') return true
  if (routeKey === '/') return pathname === '/'
  return pathname === routeKey || pathname.startsWith(`${routeKey}/`)
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function multipartFilename(body) {
  const match = /filename="([^"]*)"/.exec(body || '')
  return match ? match[1] : ''
}

function multipartTextField(body, field) {
  if (!body) return ''
  const re = new RegExp(`name="${escapeRegExp(field)}"\\r\\n(?:[^\\r\\n]*\\r\\n)*?\\r\\n([^\\r\\n]*)`)
  const match = re.exec(body)
  return match ? match[1] : ''
}

function sendJson(res, status, body, record) {
  if (!res || res.writableEnded || res.destroyed) return
  let text
  try {
    text = JSON.stringify(body === undefined ? null : body)
  } catch {
    text = 'null'
  }
  if (record) record.responseStatus = status
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

function sendBuffer(res, status, buffer, contentType, record) {
  if (!res || res.writableEnded || res.destroyed) return
  if (record) record.responseStatus = status
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': buffer.length,
  })
  res.end(buffer)
}

/**
 * 启动 mock ComfyUI。
 * @param {{ port?: number, host?: string }} [options]
 * @returns {Promise<object>} 见文件头注释
 */
export async function startMockComfy({ port = 0, host = '127.0.0.1' } = {}) {
  const requests = []

  const state = {
    // —— 请求记录（requests 与 state.requests 是同一个数组）——
    requests,
    prompts: [], // POST /prompt 的解析后 body
    uploads: [], // POST /upload/image 的请求记录
    interrupts: [], // POST /interrupt 的解析后 body
    queueOps: [], // POST /queue 的解析后 body
    // —— 可编程响应 ——
    objectInfo: makeDefaultObjectInfo(),
    systemStats: makeDefaultSystemStats(),
    history: {}, // promptId -> entry（setHistory(id, entry) 写入）
    historyTemplate: null, // setHistory(entry) 写入；null = 「还在跑」
    promptCounter: 0,
    nodeErrors: {}, // setNodeErrors(obj) 写入，POST /prompt 直接返回
    promptResponse: {}, // 额外合并进 POST /prompt 响应的字段
    queueRunning: [],
    queuePending: [],
    viewBytes: Buffer.from(PNG_1PX),
    viewContentType: 'image/png',
    userdataUnavailable: false,
    userdataList: [{ path: 'default.json', size: 123, modified: MOCK_MODIFIED }],
    userdata: { 'default.json': sampleApiWorkflow() },
    delays: {}, // 路径 -> 延迟 ms
    failures: new Map(), // 路径 -> [{status, body}]
  }

  async function readBody(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 8 * 1024 * 1024) throw new Error('mock: request body too large')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }

  function pickDelay(pathname) {
    let max = 0
    for (const [key, ms] of Object.entries(state.delays)) {
      if (routeMatches(key, pathname)) max = Math.max(max, Number(ms) || 0)
    }
    return max
  }

  function takeFailure(pathname) {
    for (const [key, list] of state.failures) {
      if (!list.length) continue
      if (routeMatches(key, pathname)) return list.shift()
    }
    return null
  }

  function autoHistoryEntry(id) {
    return {
      prompt_id: id,
      outputs: {
        9: { images: [{ filename: `mock_${id}.png`, subfolder: '', type: 'output' }] },
      },
      status: { status_str: 'success', completed: true, messages: [] },
    }
  }

  function materializeHistoryEntry(template, id) {
    const entry = clone(template)
    entry.prompt_id = id
    if (!entry.status || typeof entry.status !== 'object') {
      entry.status = { status_str: 'success', completed: true, messages: [] }
    }
    if (!entry.outputs && entry.status.status_str === 'success') {
      entry.outputs = autoHistoryEntry(id).outputs
    }
    return entry
  }

  function resolveHistoryEntry(id) {
    if (state.history[id]) return state.history[id]
    const template = state.historyTemplate
    if (template === null || template === undefined) return null
    return materializeHistoryEntry(template, id)
  }

  async function handle(req, res) {
    const rawUrl = req.url || '/'
    const parsed = new URL(rawUrl, `http://${host}`)
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/'
    const rawBody = await readBody(req)

    const contentType = String(req.headers['content-type'] || '')
    let parsedJson
    if (rawBody.length && /json/i.test(contentType)) {
      try {
        parsedJson = JSON.parse(rawBody.toString('utf8'))
      } catch {
        parsedJson = undefined
      }
    }

    const record = {
      method: (req.method || 'GET').toUpperCase(),
      path: pathname,
      rawPath: parsed.pathname,
      query: Object.fromEntries(parsed.searchParams),
      url: rawUrl,
      headers: req.headers,
      body: parsedJson !== undefined ? parsedJson : (rawBody.length ? rawBody.toString('utf8') : undefined),
      json: parsedJson,
      rawBody,
      at: Date.now(),
    }
    requests.push(record)

    const delay = pickDelay(pathname)
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    if (res.writableEnded || res.destroyed) return

    const failure = takeFailure(pathname)
    if (failure) {
      sendJson(res, failure.status, failure.body, record)
      return
    }

    // —— /system_stats ——
    if (record.method === 'GET' && pathname === '/system_stats') {
      sendJson(res, 200, state.systemStats, record)
      return
    }

    // —— /object_info ——
    if (record.method === 'GET' && pathname === '/object_info') {
      sendJson(res, 200, state.objectInfo, record)
      return
    }

    // —— POST /prompt ——
    if (record.method === 'POST' && pathname === '/prompt') {
      const body = parsedJson && typeof parsedJson === 'object' ? parsedJson : {}
      state.prompts.push(body)
      state.promptCounter += 1
      const response = {
        prompt_id: `mock-${state.promptCounter}`,
        number: state.promptCounter,
        node_errors: state.nodeErrors,
        ...state.promptResponse,
      }
      if (response.node_errors === undefined) response.node_errors = {}
      sendJson(res, 200, response, record)
      return
    }

    // —— GET /history/{promptId} ——
    if (record.method === 'GET' && pathname.startsWith('/history/')) {
      const id = safeDecode(pathname.slice('/history/'.length))
      const entry = resolveHistoryEntry(id)
      sendJson(res, 200, entry ? { [id]: entry } : {}, record)
      return
    }
    if (record.method === 'GET' && pathname === '/history') {
      sendJson(res, 200, {}, record)
      return
    }

    // —— GET /queue ——
    if (record.method === 'GET' && pathname === '/queue') {
      sendJson(res, 200, {
        queue_running: state.queueRunning,
        queue_pending: state.queuePending,
      }, record)
      return
    }

    // —— POST /queue（delete / clear）——
    if (record.method === 'POST' && pathname === '/queue') {
      const body = parsedJson && typeof parsedJson === 'object' ? parsedJson : {}
      state.queueOps.push(body)
      if (Array.isArray(body.delete)) {
        const deleting = new Set(body.delete.map(String))
        const filter = (list) => list.filter((item) => {
          const id = Array.isArray(item) ? item[1] : (item && (item.prompt_id ?? item.promptId))
          return !deleting.has(String(id))
        })
        state.queueRunning = filter(state.queueRunning)
        state.queuePending = filter(state.queuePending)
      }
      if (body.clear === true) {
        state.queueRunning = []
        state.queuePending = []
      }
      sendJson(res, 200, {}, record)
      return
    }

    // —— POST /interrupt ——
    if (record.method === 'POST' && pathname === '/interrupt') {
      const body = parsedJson && typeof parsedJson === 'object' ? parsedJson : {}
      state.interrupts.push(body)
      sendJson(res, 200, {}, record)
      return
    }

    // —— GET /view ——
    if (record.method === 'GET' && pathname === '/view') {
      const bytes = typeof state.viewBytes === 'function' ? state.viewBytes(record.query) : state.viewBytes
      if (!bytes) {
        sendJson(res, 404, { error: 'Not Found' }, record)
        return
      }
      sendBuffer(res, 200, Buffer.from(bytes), state.viewContentType || 'image/png', record)
      return
    }

    // —— POST /upload/image ——
    if (record.method === 'POST' && pathname === '/upload/image') {
      state.uploads.push(record)
      const bodyText = rawBody.toString('utf8')
      const uploadedName = multipartFilename(bodyText) || `uploaded_${state.uploads.length}.png`
      const subfolder = multipartTextField(bodyText, 'subfolder') || ''
      const type = multipartTextField(bodyText, 'type') || 'input'
      sendJson(res, 200, { name: uploadedName, subfolder, type }, record)
      return
    }

    // —— GET /userdata（列表）——
    if (record.method === 'GET' && pathname === '/userdata') {
      if (state.userdataUnavailable) {
        sendJson(res, 404, { error: 'Not Found' }, record)
        return
      }
      sendJson(res, 200, state.userdataList, record)
      return
    }

    // —— GET /userdata/{file}（内容）——
    if (record.method === 'GET' && pathname.startsWith('/userdata/')) {
      if (state.userdataUnavailable) {
        sendJson(res, 404, { error: 'Not Found' }, record)
        return
      }
      const encoded = pathname.slice('/userdata/'.length)
      const first = safeDecode(encoded)
      // 真实 ComfyUI 的 user_manager 会对含 '%' 的 match_info 再做一次 unquote，这里照样模拟
      const decodedVariants = [first]
      const second = safeDecode(first)
      if (second !== first) decodedVariants.push(second)
      const candidates = []
      for (const decoded of decodedVariants) {
        candidates.push(decoded, decoded.replace(/^workflows\//, ''), `workflows/${decoded}`)
      }
      for (const candidate of candidates) {
        const content = state.userdata[candidate]
        if (content !== undefined) {
          if (Buffer.isBuffer(content)) {
            sendBuffer(res, 200, content, 'application/json', record)
          } else if (typeof content === 'string') {
            try {
              sendJson(res, 200, JSON.parse(content), record)
            } catch {
              sendJson(res, 200, content, record)
            }
          } else {
            sendJson(res, 200, content, record)
          }
          return
        }
      }
      sendJson(res, 404, { error: 'Not Found' }, record)
      return
    }

    sendJson(res, 404, { error: 'Not Found', path: pathname }, record)
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      try {
        sendJson(res, 500, { error: `mock error: ${String(err && err.message ? err.message : err)}` })
      } catch {
        try {
          res.destroy()
        } catch {
          // ignore
        }
      }
    })
  })
  server.on('clientError', (_err, socket) => {
    try {
      socket.destroy()
    } catch {
      // ignore
    }
  })

  await new Promise((resolve, reject) => {
    const onError = (err) => reject(err)
    server.once('error', onError)
    server.listen(port, host, () => {
      server.off('error', onError)
      resolve()
    })
  })
  const actualPort = server.address().port
  const url = `http://${host}:${actualPort}`
  server.unref()

  function close() {
    return new Promise((resolve) => {
      let finished = false
      const finish = () => {
        if (finished) return
        finished = true
        resolve()
      }
      try {
        server.close(finish)
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
      } catch {
        finish()
      }
      const timer = setTimeout(finish, 1000)
      if (typeof timer.unref === 'function') timer.unref()
    })
  }

  function setHistory(promptIdOrEntry, maybeEntry) {
    if (maybeEntry !== undefined) {
      state.history[String(promptIdOrEntry)] = maybeEntry
      return
    }
    if (promptIdOrEntry === null || promptIdOrEntry === undefined) {
      state.historyTemplate = null
      return
    }
    if (typeof promptIdOrEntry === 'object' && (promptIdOrEntry.prompt_id || promptIdOrEntry.promptId)) {
      const id = String(promptIdOrEntry.prompt_id ?? promptIdOrEntry.promptId)
      state.history[id] = promptIdOrEntry
      return
    }
    state.historyTemplate = promptIdOrEntry
  }

  function clearHistory() {
    state.historyTemplate = null
    state.history = {}
  }

  function setNodeErrors(errors) {
    state.nodeErrors = errors && typeof errors === 'object' ? errors : {}
  }

  function failNextRoute(pathValue, options = {}) {
    const key = normalizeKey(pathValue)
    const status = Number(options && options.status) || 500
    const body = options && options.body !== undefined
      ? options.body
      : { error: `mock failure for ${key}`, route: key }
    const list = state.failures.get(key) || []
    list.push({ status, body })
    state.failures.set(key, list)
  }

  function delayRoute(pathValue, ms) {
    const key = normalizeKey(pathValue)
    const value = Number(ms)
    if (!Number.isFinite(value) || value <= 0) delete state.delays[key]
    else state.delays[key] = value
  }

  function setObjectInfo(objectInfo, { merge = true } = {}) {
    if (!objectInfo || typeof objectInfo !== 'object') return
    state.objectInfo = merge ? { ...state.objectInfo, ...objectInfo } : clone(objectInfo)
  }

  function setUserdataWorkflows(list) {
    state.userdataList = Array.isArray(list) ? clone(list) : []
  }

  function setUserdata(pathValue, content) {
    state.userdata[String(pathValue).replace(/^\/+/, '')] = content
  }

  function setQueue({ running, pending } = {}) {
    if (Array.isArray(running)) state.queueRunning = clone(running)
    if (Array.isArray(pending)) state.queuePending = clone(pending)
  }

  function clearRequests() {
    requests.length = 0
  }

  function reset() {
    requests.length = 0
    state.prompts.length = 0
    state.uploads.length = 0
    state.interrupts.length = 0
    state.queueOps.length = 0
    state.history = {}
    state.historyTemplate = null
    state.promptCounter = 0
    state.nodeErrors = {}
    state.promptResponse = {}
    state.queueRunning = []
    state.queuePending = []
    state.userdataUnavailable = false
    state.userdataList = [{ path: 'default.json', size: 123, modified: MOCK_MODIFIED }]
    state.userdata = { 'default.json': sampleApiWorkflow() }
    state.delays = {}
    state.failures = new Map()
  }

  const api = {
    url,
    host,
    port: actualPort,
    server,
    state,
    requests,
    close,
    setHistory,
    clearHistory,
    setNodeErrors,
    failNextRoute,
    delayRoute,
    setObjectInfo,
    setUserdataWorkflows,
    setUserdata,
    setQueue,
    clearRequests,
    reset,
    // 便捷常量
    png: Buffer.from(PNG_1PX),
  }

  // Lead 约定：mock.userdataUnavailable = true 时 GET /userdata 返回 404
  Object.defineProperty(api, 'userdataUnavailable', {
    enumerable: true,
    get() {
      return state.userdataUnavailable
    },
    set(value) {
      state.userdataUnavailable = Boolean(value)
    },
  })

  return api
}
