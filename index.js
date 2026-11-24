/**
 * dsh-sendcomfy —— Host 半端（Cordis 插件入口）
 * ============================================================================
 * 挂载两件事：
 *   1. /api/sendcomfy/*  —— 网页面板（client.js）的同源代理路由，浏览器不直连 ComfyUI；
 *   2. comfy_* 工具      —— 会话里的文本模型拿它调用 ComfyUI 的模型/工作流：
 *                           填提示词、覆盖节点参数、等结果/查结果、导入工作流。
 *
 * 业务逻辑全在 lib/actions.mjs（网页与工具共用一份实现），本文件只做 Host 装配。
 */
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import { createActions, humanizeError } from './lib/actions.mjs'
import { createApiHandler } from './lib/http.mjs'
import { createStateStore } from './lib/state.mjs'

export const name = 'dsh-sendcomfy'
export const inject = ['webServer', 'tools']

const ROUTE_PREFIX = '/api/sendcomfy'
const MAX_IMPORT_BYTES = 8 * 1024 * 1024

/* ───────────────────────── 工具定义辅助 ───────────────────────── */

/** 工具统一以 JSON 文本渲染结果（结果本身必须是无损 JSON）。 */
const textOutput = {
  schema: { type: 'object', properties: {}, additionalProperties: true },
  render(_args, value) {
    return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
  },
}

function jsonSafe(value) {
  if (value === undefined || value === null) return value
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return { ok: false, error: '工具结果无法序列化为 JSON' }
  }
}

function objectSchema(properties = {}, required = []) {
  return { type: 'object', properties, required, additionalProperties: false }
}

const stringParam = (description) => ({ type: 'string', description })
const numberParam = (description) => ({ type: 'number', description })
const booleanParam = (description) => ({ type: 'boolean', description })
/** 参数覆盖表：键是 `节点id.输入名`，值是标量。 */
const overridesParam = (description) => ({ type: 'object', description, additionalProperties: true })

/* ───────────────────────── Host 插件装配 ───────────────────────── */

export function apply(ctx) {
  const logger = (...args) => {
    try {
      const sink = ctx.logger
      if (sink && typeof sink.info === 'function') sink.info('[dsh-sendcomfy]', ...args)
    } catch {
      /* 日志不可用不影响功能 */
    }
  }

  const store = createStateStore()
  const actions = createActions({ store, logger })

  /* ── 1. 浏览器面板 API ─────────────────────────────────────── */
  const handler = createApiHandler(actions, { prefix: ROUTE_PREFIX })
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        try {
          await handler(req, res)
        } catch (error) {
          try {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: humanizeError(error) }))
          } catch {
            /* 响应已结束 */
          }
        }
      },
    }),
    'dsh-sendcomfy: /api/sendcomfy 路由',
  )

  /* ── 2. 会话工具 ───────────────────────────────────────────── */

  /** 当前会话的工作目录（拿不到就返回 undefined，调用方降级为不落盘）。 */
  async function workspaceOf(agent) {
    try {
      const service = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined
      if (service && typeof service.ensure === 'function' && agent) {
        return await service.ensure(agent)
      }
    } catch (error) {
      logger('拿工作目录失败：', error?.message || error)
    }
    return undefined
  }

  /** 工具入参里的相对路径按会话工作目录解析。 */
  async function resolveInputPath(agent, inputPath) {
    const raw = String(inputPath || '').trim()
    if (!raw) throw new Error('需要文件路径')
    if (isAbsolute(raw)) return raw
    const base = await workspaceOf(agent)
    if (!base) throw new Error(`无法确定工作区目录，请给绝对路径：${raw}`)
    return resolve(base, raw)
  }

  /** 运行输出落盘目录：<工作区>/comfy-output（actions 会再按 promptId 分子目录）。 */
  async function outputDirOf(agent, saveOutputs) {
    if (saveOutputs === false) return undefined
    const base = await workspaceOf(agent)
    return base ? join(base, 'comfy-output') : undefined
  }

  /** 把一条 warning 追加进动作结果（失败结果没有 warnings 也补上）。 */
  function appendWarning(result, message) {
    if (!result || typeof result !== 'object') return result
    return {
      ...result,
      warnings: [...(Array.isArray(result.warnings) ? result.warnings : []), message],
    }
  }

  const definitions = [
    {
      name: 'comfy_status',
      description:
        '看 ComfyUI 桥接的当前配置与连通性：ComfyUI 地址、是否连得上、模型分类计数、已保存的工作流清单、最近运行。'
        + '第一次用或运行失败后先调它。ComfyUI 地址由用户在侧边栏「ComfyUI 桥接」面板里配置。',
      parameters: objectSchema(),
      async execute() {
        const state = await actions.getState()
        const live = await actions.test({})
        return jsonSafe({
          ...state,
          live: {
            reachable: live.reachable === true,
            latencyMs: live.latencyMs,
            comfyuiVersion: live.comfyuiVersion,
            device: live.device,
            error: live.error,
          },
        })
      },
    },

    {
      name: 'comfy_models',
      description:
        '列出 ComfyUI 里可用的模型文件（checkpoints / LoRAs / VAE / CLIP / UNET / ControlNet / Upscale 等），'
        + '用来选风格模型或确认某个工作流需要的模型在不在。模型名也可以直接作为 comfy_run 的 params 值写进工作流。',
      parameters: objectSchema({
        category: stringParam('只看某一类，如 checkpoints / loras / vae；省略=全部类别'),
        keyword: stringParam('按文件名过滤的关键词（不区分大小写），如 sdxl、qwen'),
        refresh: booleanParam('true=绕过 60 秒缓存，重新从 ComfyUI 拉取'),
      }),
      async execute(args) {
        const result = await actions.listModels({ refresh: args?.refresh === true })
        if (!result.ok) return jsonSafe(result)
        const category = String(args?.category || '').toLowerCase()
        const keyword = String(args?.keyword || '').toLowerCase()
        let total = 0
        const categories = []
        for (const entry of result.categories || []) {
          if (category && String(entry.id).toLowerCase() !== category && String(entry.label).toLowerCase() !== category) continue
          const files = keyword
            ? (entry.files || []).filter((file) => String(file).toLowerCase().includes(keyword))
            : (entry.files || [])
          total += files.length
          const limit = 200
          categories.push({
            id: entry.id,
            label: entry.label,
            count: files.length,
            files: files.slice(0, limit),
            ...(files.length > limit ? { truncated: true } : {}),
          })
        }
        return jsonSafe({ ok: true, baseUrl: result.baseUrl, total, categories })
      },
    },

    {
      name: 'comfy_workflows',
      description:
        '查看 ComfyUI 服务器上有哪些工作流（主用法，**不需要导入**）。返回每个工作流的 path / 名称 / 大小 / 修改时间。'
        + '用 comfy_workflow 传 path 看可调参数与提示词目标，再 comfy_run({workflow:"<path>"}) 直接运行'
        + '（运行前插件会自动从 ComfyUI 加载该工作流）。本地已保存的旧工作流也会一并列出，仅作兼容。',
      parameters: objectSchema(),
      async execute() {
        const server = await actions.listServerWorkflows()
        const local = await actions.listWorkflows()
        return jsonSafe({
          ok: true,
          baseUrl: server.baseUrl || undefined,
          serverReachable: server.ok === true,
          serverWorkflows: server.ok ? server.items || [] : [],
          ...(server.ok ? {} : { serverError: server.error }),
          localWorkflows: (local && local.workflows) || [],
          hint: 'serverWorkflows[].path 可直接传给 comfy_run / comfy_workflow；不需要先导入。',
        })
      },
    },

    {
      name: 'comfy_workflow',
      description:
        '看一个工作流的详情：可调参数清单（path 形如 `节点id.输入名`、类型、当前值、枚举 options、min/max/step）、'
        + '提示词目标（positive/negative 参数 path）和节点摘要。workflow 可填 comfy_workflows 返回的服务器 path'
        + '（如 "krea2.json"，会按需从 ComfyUI 加载，不需要导入），也可填本地保存的 id / 名称。',
      parameters: objectSchema({ workflow: stringParam('服务器工作流 path（如 krea2.json）或本地工作流 id/名称') }, ['workflow']),
      async execute(args) {
        return jsonSafe(await actions.getWorkflow(String(args?.workflow || '')))
      },
    },

    {
      name: 'comfy_run',
      description:
        '用 ComfyUI 工作流出图。workflow 可以直接填服务器 path（comfy_workflows 返回的 path，运行前自动从 ComfyUI 加载，'
        + '**不需要先导入**），也可以填本地保存的 id/名称。prompt 会自动写进检测到的正向提示词节点（negativePrompt 写负向）；'
        + 'params 可按 `节点id.输入名` 覆盖任意可调参数（先用 comfy_workflow 拿 path）。默认等出图结束并返回图片路径；'
        + '长任务可传 wait=false 立刻拿 promptId，再用 comfy_result 查结果。',
      parameters: objectSchema({
        workflow: stringParam('工作流 id 或名称（先用 comfy_workflows 查）'),
        prompt: stringParam('正向提示词；省略=沿用工作流里原来的提示词'),
        negativePrompt: stringParam('负向提示词；省略=沿用原值'),
        params: overridesParam('参数覆盖表：键为 comfy_workflow 返回的 path（如 "6.steps"），值为数字/字符串/布尔。不要在键里加引号。'),
        wait: booleanParam('是否等出图结束（默认 true）。长任务设 false，然后用 comfy_result 轮询'),
        timeoutSec: numberParam('本次最多等多少秒（默认用面板里配置的超时，通常 300）'),
        saveOutputs: booleanParam('是否把输出图片下载到当前会话工作区的 comfy-output/ 下（默认 true；false 只返回代理 URL）'),
      }, ['workflow']),
      // 宿主 tool-call-timeout-policy 会按 timeoutMs 强杀；这里留出 3600s 可配等待 + 余量。
      timeoutMs: 3_700_000,
      async execute(args, exec) {
        const wantSave = args?.saveOutputs !== false
        const saveDir = wantSave ? await outputDirOf(exec?.agent, true) : undefined
        const result = await actions.run({
          workflow: String(args?.workflow || ''),
          prompt: args?.prompt,
          negativePrompt: args?.negativePrompt,
          params: args?.params,
          wait: args?.wait === false ? false : true,
          timeoutSec: args?.timeoutSec,
          saveDir,
          signal: exec?.signal,
        })
        return jsonSafe(wantSave && !saveDir
          ? appendWarning(result, '没拿到会话工作目录，输出图片只返回代理 URL（未落盘到工作区）。')
          : result)
      },
    },

    {
      name: 'comfy_result',
      description: '按 promptId 查一次 ComfyUI 任务的最终结果（图片路径/URL/状态）。配合 comfy_run 的 wait=false 使用。',
      parameters: objectSchema({
        promptId: stringParam('comfy_run 返回的 promptId'),
        timeoutSec: numberParam('本次最多等多少秒（默认用面板里配置的超时）'),
        saveOutputs: booleanParam('是否把输出图片下载到当前会话工作区（默认 true）'),
      }, ['promptId']),
      timeoutMs: 3_700_000,
      async execute(args, exec) {
        const wantSave = args?.saveOutputs !== false
        const saveDir = wantSave ? await outputDirOf(exec?.agent, true) : undefined
        const result = await actions.pollResult({
          promptId: String(args?.promptId || ''),
          timeoutSec: args?.timeoutSec,
          saveDir,
          signal: exec?.signal,
        })
        return jsonSafe(wantSave && !saveDir
          ? appendWarning(result, '没拿到会话工作目录，输出图片只返回代理 URL（未落盘到工作区）。')
          : result)
      },
    },

    {
      name: 'comfy_cancel',
      description: '中断 ComfyUI 当前运行的任务（给了 promptId 就中断/删除那一条）。不影响已完成的图片。',
      parameters: objectSchema({
        promptId: stringParam('要取消的 promptId；省略=中断当前正在跑的任务并清空排队'),
      }),
      async execute(args) {
        return jsonSafe(await actions.cancel({ promptId: args?.promptId }))
      },
    },

    {
      name: 'comfy_import_workflow',
      description:
        '把一个 ComfyUI 工作流 JSON 保存进插件（之后就能用 comfy_run 运行）。支持 ComfyUI 里「导出（UI 格式）」和「导出 API 格式」两种 JSON；'
        + 'json 与 path 二选一。UI 格式会自动转换成 ComfyUI /prompt 需要的 API 格式。',
      parameters: objectSchema({
        name: stringParam('保存用的工作流名称（重复会自动加后缀）'),
        json: stringParam('工作流 JSON 文本（可直接把文件内容传进来）'),
        path: stringParam('工作区内的 .json 文件路径（绝对路径或相对当前会话工作目录）'),
      }, ['name']),
      timeoutMs: 120_000,
      async execute(args, exec) {
        let raw = args?.json
        if ((raw === undefined || raw === null || raw === '') && args?.path) {
          const file = await resolveInputPath(exec?.agent, args.path)
          const info = await stat(file).catch(() => null)
          if (!info || !info.isFile()) return { ok: false, error: `文件不存在：${file}` }
          if (info.size > MAX_IMPORT_BYTES) return { ok: false, error: `工作流文件过大（上限 ${MAX_IMPORT_BYTES} 字节）` }
          raw = await readFile(file, 'utf8')
        }
        if (raw === undefined || raw === null || raw === '') {
          return { ok: false, error: '需要 json（JSON 文本）或 path（工作区文件路径）之一' }
        }
        return jsonSafe(await actions.importWorkflow({ name: String(args?.name || ''), json: raw }))
      },
    },

    {
      name: 'comfy_server_workflows',
      description:
        '兼容旧用法：列出 ComfyUI 服务器工作流，或按 importPath 把其中一个导入本地库。'
        + '**通常不需要导入** —— 直接 comfy_run({workflow:"<path>"}) 即可，运行时会自动加载。',
      parameters: objectSchema({
        importPath: stringParam('要导入的服务器工作流路径（省略=只列出，不导入）'),
        name: stringParam('导入后保存的名称（省略=用文件名）'),
      }),
      async execute(args) {
        if (args?.importPath) {
          return jsonSafe(await actions.importServerWorkflow({ path: String(args.importPath), name: args?.name }))
        }
        return jsonSafe(await actions.listServerWorkflows())
      },
    },

    {
      name: 'comfy_choose_workflow',
      description:
        '用户只说「想要什么」、没说用哪个工作流时先调它：按任务描述给 ComfyUI 服务器上的工作流打分排序（按文件名/目录猜能力），'
        + '挑最合适的一个直接 comfy_run({"workflow":"<sourcePath>"}) 运行 —— use 时自动从服务器加载，**不需要导入**。'
        + '返回每个候选的匹配分、原因、sourcePath 和下一步；服务器候选可用 comfy_workflow 传 path 看具体参数。'
        + '本地已保存的旧工作流默认不参与排序（includeLocal=true 才加入）。',
      parameters: objectSchema({
        task: stringParam('用户想要的效果/用途描述，尽量保留原话里的风格、用途词（比如「把它放大成高清头像」「画一只赛博朋克风格的猫」）'),
        includeServer: booleanParam('是否把 ComfyUI 服务器工作流纳入候选（默认 true；服务器连不上会返回 warning 并用本地兜底）'),
        includeLocal: booleanParam('是否也把本地已保存的旧工作流纳入排序（默认 false）'),
        limit: numberParam('最多返回几个候选（1–10，默认 5）'),
      }, ['task']),
      async execute(args) {
        return jsonSafe(await actions.chooseWorkflow({
          task: String(args?.task || ''),
          includeServer: args?.includeServer !== false,
          includeLocal: args?.includeLocal === true,
          limit: args?.limit,
        }))
      },
    },

    {
      name: 'comfy_describe_workflow',
      description:
        '给一个已保存的工作流补上「用途说明 + 标签」，让下次 AI 选型更准。'
        + '例如用户说过「这个工作流是画二次元头像的」「那个是修复老照片的」，就把它记下来；之后 comfy_choose_workflow 会用到这些说明/标签，comfy_status 与 comfy_workflows 也会显示。',
      parameters: objectSchema({
        workflow: stringParam('工作流 id 或名称（先用 comfy_workflows 查）'),
        description: stringParam('用途说明：一句话讲清什么时候该用它、它需要什么输入、输出什么（≤500 字）'),
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '标签（≤12 个，每个 ≤40 字），如 ["二次元", "头像", "不需要输入图"]',
        },
      }, ['workflow']),
      async execute(args5) {
        const result = await actions.updateWorkflowMeta({
          id: String(args5?.workflow || ''),
          description: args5?.description,
          tags: args5?.tags,
        })
        const wf = result.workflow
        return jsonSafe({
          ...result,
          hint: wf ? `已保存：${wf.name}。下次选型会参考这段说明和标签。` : '没有更新内容（description / tags 至少给一个）',
        })
      },
    },

    {
      name: 'comfy_upload_image',
      description:
        '把当前会话工作区里的一张图片上传到 ComfyUI 的 input 目录，返回可填进 LoadImage 节点 image 参数的文件名（img2img / 图生视频用）。',
      parameters: objectSchema({
        path: stringParam('工作区内图片路径（绝对路径或相对当前会话工作目录）'),
        subfolder: stringParam('上传到 ComfyUI input 下的子目录（可选）'),
      }, ['path']),
      timeoutMs: 150_000,
      async execute(args, exec) {
        const file = await resolveInputPath(exec?.agent, args?.path)
        const info = await stat(file).catch(() => null)
        if (!info || !info.isFile()) return { ok: false, error: `文件不存在：${file}` }
        if (info.size > 64 * 1024 * 1024) return { ok: false, error: '图片超过 64MB，拒绝上传' }
        const data = await readFile(file)
        const filename = file.replace(/\\/g, '/').split('/').pop() || 'image.png'
        return jsonSafe(await actions.uploadImage({
          data,
          filename,
          subfolder: args?.subfolder ? String(args.subfolder) : '',
        }))
      },
    },
  ]

  ctx.effect(() => {
    const disposers = []
    for (const definition of definitions) {
      try {
        const disposer = ctx.tools.register({
          ...definition,
          output: textOutput,
          async execute(args, exec) {
            try {
              return jsonSafe(await definition.execute(args ?? {}, exec))
            } catch (error) {
              return { ok: false, error: error?.message || String(error) }
            }
          },
        })
        disposers.push(disposer)
      } catch (error) {
        logger(`注册工具 ${definition.name} 失败：`, error?.message || error)
      }
    }
    logger(`已注册 ${disposers.length}/${definitions.length} 个 comfy_* 工具`)
    return () => {
      while (disposers.length > 0) {
        try {
          disposers.pop()()
        } catch {
          /* 已释放 */
        }
      }
    }
  }, 'dsh-sendcomfy: comfy_* 工具')

  logger('已挂载（面板：侧边栏 ComfyUI 桥接；工具：comfy_status / comfy_run …）')
}
