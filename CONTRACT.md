# dsh-sendcomfy — 共享接口契约（Lead 维护，其他人只读）

> 目标：DSH（DeepSeek Harness）持久插件。侧边栏一个 ComfyUI 面板（配置 Comfy IP、看模型、导入/管理/运行工作流、填提示词、调参数），
> 同时 Host 注册 `comfy_*` 工具，让会话里的文本模型直接调用 ComfyUI。
> 包目录：`<本仓库目录>`
> 包名：`dsh-sendcomfy`；**本文件是各文件之间的唯一契约，改接口先改这里并通知 Lead。**

## 0. 运行环境与硬约束

- Node：`node`（v24.22.3）。shell 里直接 `node` 会因 snap 封装 + 无 DBus 失败，**一律用绝对路径**。
- 全部 ESM（`type: module`），**零第三方依赖**（只用 Node 内建 + 全局 fetch/FormData/Blob），不 import `@deepseek-ai/*`。
- 不用 TypeScript、不用打包；`client.js` 是浏览器自注册脚本（见 §6）。
- 工作流/配置持久化在 `$DSH_HOME/sendcomfy/state.json`（默认 `~/.dsh/sendcomfy/state.json`），**不改 profile 的 patch/package**。
- 本包不导出 Schemastery `Config`（避免 schema 校验失败导致整条插件不激活）。
- 文案：Host 侧错误信息可用中文；客户端 UI 文案走 locale（§7）。
- 测试命令：`node --test test/xxx.test.mjs`

## 1. 文件归属（写作用域，互不重叠）

| 文件 | 归属 | 内容 |
|---|---|---|
| `CONTRACT.md`, `index.js`, `lib/actions.mjs`, `lib/http.mjs`, `package.json`, `cordis.patch.yml`, `icon.svg`, `locale/*.json`, `README.md`, `client.js` | **Lead** | 客户端也由 Lead 之外的独立人写，但只有 Lead 安装 |
| `lib/comfy.mjs`, `lib/state.mjs`, `test/mock-comfy.mjs`, `test/comfy.test.mjs` | host-comfy | ComfyUI HTTP 客户端 + 本地状态存储 + mock 服务器 |
| `lib/workflow.mjs`, `test/workflow.test.mjs`, `test/fixtures/*` | host-workflow | 工作流解析/转换/参数推导 |
| `client.js` | client-panel | 浏览器端面板 |

## 2. ComfyUI HTTP 客户端 —— `lib/comfy.mjs`

纯函数模块，**所有函数显式传 `baseUrl`**，不读全局状态；网络失败抛错，健康检查类函数自己吞错返回 `ok:false`。

```js
export function normalizeBaseUrl(input) // '127.0.0.1:8188' | '192.168.1.5' | 'http://host:8188/' -> 'http://127.0.0.1:8188'
// 规则：去空白；无 scheme 补 http://；无端口补 :8188；去尾部 '/'；非法(非 http/https、含空格)抛 Error(code='EINVALID_URL')。
// 空/undefined -> 返回默认 'http://127.0.0.1:8188'（normalizeBaseUrl(undefined) 用默认值；normalizeBaseUrl('') 抛错）

export class ComfyError extends Error {   // .code: string, .status?: number, .detail?: string
}

export async function request(baseUrl, path, { method='GET', body, timeoutMs=15000, headers } = {})
// -> { status, json } ；非 2xx 抛 ComfyError(code='EHTTP', status)；网络/超时抛 ComfyError(code='ENET'|'ETIMEDOUT')
// body 为普通对象时自动 JSON.stringify + content-type；支持 body 为 FormData 时原样发送；AbortSignal.timeout

export async function ping(baseUrl, { timeoutMs=5000 } = {})
// -> { ok:true, baseUrl, latencyMs, comfyuiVersion?, device?, system? } | { ok:false, baseUrl, latencyMs, error }
// 用 GET /system_stats；永远不抛错（URL 非法也返回 ok:false）

export async function getObjectInfo(baseUrl, { refresh=false, timeoutMs=30000 } = {})
// -> object_info 原始对象。模块内按 baseUrl 缓存 60s；refresh=true 绕过。
export function invalidateObjectInfo(baseUrl?)             // 清缓存（不给 baseUrl 清全部）

export async function listModels(baseUrl, { refresh=false } = {})
// -> { ok, baseUrl, total, categories: [{ id, label, count, files: string[] }], warnings?: string[], error? }
// 从 object_info 枚举里抽模型文件。至少覆盖这些 id/label：
//   checkpoints(Checkpoints) loras(LoRAs) vae(VAE) clip(CLIP) unet(UNET/Diffusion)
//   controlnet(ControlNet) upscale(Upscale) clip_vision(CLIP Vision) style_models(Style models)
//   embeddings(Embeddings) ipadapter(IPAdapter) gligen(GLIGEN) other(Other models)
// 实现建议：已知节点类 → (categoryId)；兜底：枚举值后缀 .safetensors/.ckpt/.pt/.pth/.bin/.gguf/.onnx/.yaml/.sft
//   且输入名/节点类含 model|ckpt|lora|vae|clip|unet|controlnet|upscale|embedding|ipadapter|gligen 时归 other（去重）。
// 每个 files 排序去重；total = 全部文件数。同一文件出现在多类别时各归各类（不要求全局去重）。

export async function queuePrompt(baseUrl, apiGraph, { clientId, timeoutMs=30000 } = {})
// POST /prompt { prompt: apiGraph, client_id }
// -> { promptId, number, nodeErrors?: object }；node_errors 非空也照常返回（由调用方判断）

export async function getHistory(baseUrl, promptId, { timeoutMs=15000 } = {})
// GET /history/{promptId} -> entry | null

export async function waitForPrompt(baseUrl, promptId, { timeoutMs=300000, pollMs=800, signal } = {})
// 轮询 /history；-> { state:'done'|'error'|'timeout'|'missing', entry?, error? }
// entry.status.status_str === 'error' -> state:'error'，error 取 status.messages 里 execution_error 的 message
// 超时 state:'timeout'（不抛）；signal aborted 抛 AbortError

export async function getQueue(baseUrl, { timeoutMs=10000 } = {})
// GET /queue -> { running: [{prompt_id}], pending: [{prompt_id}] }

export async function interrupt(baseUrl, promptId) // POST /interrupt {prompt_id?} -> { ok:true }
export async function deleteQueued(baseUrl, promptIds) // POST /queue { delete:[ids] } -> { ok:true }
export async function clearQueue(baseUrl) // POST /queue { clear:true }

export async function fetchImage(baseUrl, { filename, subfolder='', type='output' }, { timeoutMs=60000 } = {})
// GET /view?filename=&subfolder=&type= -> { buffer: Buffer, contentType: string }

export async function uploadImage(baseUrl, { data, filename, subfolder='', type='input' })
// data: Buffer|Uint8Array；POST /upload/image multipart -> { name, subfolder, type }
// 失败抛 ComfyError

export async function listUserdataWorkflows(baseUrl, { timeoutMs=8000 } = {})
// GET /userdata?dir=workflows&recurse=true&split=false
// -> { ok:true, items:[{ path, name, size?, modified? }] } | { ok:false, error }
// 任何失败（404/网络/格式不符）都返回 ok:false 不抛；items 只保留 .json
export async function getUserdataWorkflow(baseUrl, path, { timeoutMs=15000 } = {})
// GET /userdata/{encodeURIComponent(path)}?dir=workflows -> 解析后的 JSON 对象；失败抛 ComfyError
```

`request` 的错误对象必须带 `code`，`ping`/`listUserdataWorkflows` 这类返回 `error` 时给人类可读字符串。

## 3. 本地状态 —— `lib/state.mjs`

```js
export function dataDir()                    // $DSH_HOME/sendcomfy，确保 mkdir -p；DSH_HOME 缺省 ~/.dsh
export function createStateStore({ dir } = {}) // dir 可选（测试用临时目录）
// store.read(): Promise<State>（不存在 -> 默认 State；坏 JSON -> 备份 state.bad-<ts>.json 后返回默认）
// store.write(state): Promise<State>（原子写：临时文件 + rename；写前 normalize）
// store.update(mutator): Promise<State>（read -> mutator(state) 原地或返回新对象 -> write；串行化，避免并发写丢数据）
```

```ts
type State = {
  baseUrl: string,          // 默认 'http://127.0.0.1:8188'
  timeoutSec: number,       // 默认 300；clamp 5..3600
  clientId: string,         // 'dsh-sendcomfy-<随机>'，首次生成后持久
  workflows: WorkflowRecord[],   // 最多 100 条，新的在前
  lastRuns: RunRecord[],         // 最多 20 条，新的在前
}

type WorkflowRecord = {
  id: string,               // slug(name)+'-'+6位hex，唯一
  name: string,
  source: 'ui' | 'api' | 'server',
  apiGraph: Record<string, { class_type: string, inputs: Record<string, unknown>, _meta?: { title?: string } }>,
  uiGraph?: unknown,        // 原始 UI 格式（source==='ui' 时保留，便于以后重新解析）
  nodes: { id: string, class: string, title?: string }[],
  params: ParamSpec[],      // 见 §4；导入时推导，读工作流时可由 actions 重新推导
  promptTargets: { positive: string[], negative: string[] },
  warnings?: string[],
  createdAt: string,        // ISO
  updatedAt: string,
}

type ParamSpec = {
  path: string,             // `${nodeId}.${inputName}`，运行覆盖参数用这个键
  nodeId: string, inputName: string, nodeClass: string, nodeTitle?: string,
  type: 'string'|'number'|'integer'|'boolean'|'enum',
  value: string|number|boolean,
  options?: string[],       // enum 才有，来自 object_info
  min?: number, max?: number, step?: number,
  multiline?: boolean,
  isPrompt?: boolean,       // 参与提示词注入的目标
}

type RunRecord = {
  promptId: string, workflowId?: string, workflowName: string,
  state: 'queued'|'done'|'error'|'timeout',
  createdAt: string, durationMs?: number,
  images?: { filename: string, subfolder: string, type: string, contentType?: string }[],
  error?: string,
}
```

`normalize(state)`：非法/缺失字段回默认，`workflows` 去重（id 冲突丢旧），`lastRuns` 截断。

## 4. 工作流解析 —— `lib/workflow.mjs`

```js
export function parseWorkflowJson(textOrObject)
// -> { format:'ui'|'api', raw } ；无法识别抛 Error(code='EBAD_WORKFLOW')
// 识别：对象值里有 class_type -> 'api'；有 Array.isArray(nodes) 且节点含 type -> 'ui'。
// 也支持 ComfyUI 新版 UI 导出的 { workflow: {...} } 包装（取 .workflow 或 .prompt）。

export function uiToApiGraph(ui, objectInfo)      // objectInfo 可 undefined
// -> { apiGraph, warnings: string[] }
// UI 格式：{ nodes:[{id,type,title?,inputs:[{name,type,link,widget?}],outputs,widgets_values:[]}], links:[[linkId,srcNode,srcSlot,dstNode,dstSlot,type]] }
// 转换规则：
//  - 遍历 nodes，跳过 type==='Reroute'|'Note'|'MarkdownNote'|'PrimitiveNode'（Reroute 在连线上透明穿透；PrimitiveNode 的值作为字面量）
//  - 每个普通节点 -> { class_type:type, inputs:{}, _meta:{title} }
//  - 对 node.inputs：link!=null -> 递归解析源（Reroute 穿透、PrimitiveNode 取 widgets_values[0]，否则 [String(srcNodeId), srcSlot]）
//    ; link==null 且 widget 存在（转成输入的小部件）-> 从 widgets_values 按 widget.name 取值
//  - 剩余 widgets_values 顺序映射到 objectInfo[type].input.required+optional 里的「小部件输入」（枚举/INT/FLOAT/STRING/BOOLEAN），
//    按 key 顺序；seed/noise_seed 后若紧跟 'fixed'|'increment'|'decrement'|'randomize' 控制值则跳过它
//  - objectInfo 缺失时按 UI 节点的 widgets_values 与 inputs 的 widget.name 尽力映射，warnings 记一条
//  - 无法解析的节点/连线写入 warnings，不抛错（除非一个可执行节点都没有 -> 抛 EBAD_WORKFLOW）

export function buildParamSpecs(apiGraph, objectInfo)
// -> { params: ParamSpec[], promptTargets: { positive: string[], negative: string[] } }
// 规则：
//  - 跳过 inputs 中的链路值（Array.isArray(v) && v.length===2 && typeof v[0]==='string'）
//  - 只看字面量 primitive（string/number/boolean）；数组/对象值跳过（warnings 不必须）
//  - 类型由 objectInfo 对应 input 类型决定：'INT'->integer, 'FLOAT'->number, 'BOOLEAN'->boolean, 'STRING'->string,
//    枚举（Array 首元素是数组）-> enum + options；缺失 objectInfo -> 按 JS 值推断（string/boolean/number）
//  - min/max/step 从 objectInfo 的 { min, max, step } 取；multiline: STRING 的 multiline===true 或值含 '\n' 或长度>120
//  - isPrompt 判定：CLIPTextEncode/含 TextEncode 类节点的 `text` 输入，或输入名 text/text_g/text_l/prompt 的 string；
//    positive/negative 归类：节点 title/_meta.title 含 negative/负 -> negative；含 positive/正 -> positive；
//    否则第一个非 negative 的候选 -> positive，其余默认不归类（可都算 positive？不：只算第一个，避免误改）
//  - 排序：先 prompt 目标（positive 在前），再按 nodeId 数值序 + input 顺序

export function applyParamOverrides(apiGraph, params, overrides)
// overrides: Record<path, string|number|boolean>；返回 { apiGraph(新对象，不改入参), applied:[{path,value}], warnings:[] }
// 规则：path 形如 '3.text' / '6.ckpt_name'；不存在 -> warnings；数字字符串按 number 转；枚举不在 options 里 -> warnings 但仍写入；
//       JSON 点路径不支持嵌套（只两级）

export function applyPrompts(apiGraph, promptTargets, { prompt, negativePrompt }, params)
// -> { apiGraph(新对象), applied:[{path,field,value}], warnings:[] }
// prompt 非空 -> 写 promptTargets.positive 全部路径（field='text' 时写 text，否则写原 inputName）；
// negativePrompt 同理写 negative；没有目标 -> warnings:['没有检测到提示词输入节点…']（有 prompt 时）

export function mergeImport({ name, raw, objectInfo })
// 一站式导入：parseWorkflowJson -> (ui ? uiToApiGraph) -> buildParamSpecs
// -> { name, format, source:'ui'|'api', apiGraph, uiGraph?, nodes:[{id,class,title?}], params, promptTargets, warnings }
// nodes 按 nodeId 数值升序；抛错场景同 parseWorkflowJson/空图

export function summarizeGraph(apiGraph)   // -> { nodeCount, classes: Record<string, number> }（可选，若非必需可不实现）
```

硬要求：`uiToApiGraph` 在 objectInfo 缺失时也不能把整张图搞坏；至少 90% 常见官方模板（KSampler/CLIPTextEncode/CheckpointLoaderSimple/EmptyLatentImage/VAEDecode/SaveImage）能正确转换。

## 5. Host actions（Lead 写，供 §6 与工具共用）—— `lib/actions.mjs`

```js
import * as comfy from './comfy.mjs'
import * as workflow from './workflow.mjs'
import { createStateStore } from './state.mjs'

export function createActions({ store = createStateStore(), logger = () => {} } = {})
```

方法（全部 async，返回 JSON 可序列化对象；**失败返回 `{ ok:false, error, warnings? }`，不抛**，除非说明）：

- `getState()` -> `{ ok:true, baseUrl, timeoutSec, clientId, workflows:[WorkflowSummary], lastRuns:[RunRecord] }`
  - `WorkflowSummary = { id, name, nodeCount, paramCount, source, createdAt, updatedAt }`
- `setConfig({ baseUrl, timeoutSec })` -> `{ ok:true, baseUrl, timeoutSec }`（normalize；非法 -> `{ok:false,error}`）
- `test({ baseUrl })` -> ping 结果 + 覆盖后的 baseUrl（**不写状态**）
- `listModels({ refresh })` -> `{ ok:true, baseUrl, total, categories, warnings? }` | `{ok:false,error}`
- `listWorkflows()` -> `{ ok:true, workflows:[WorkflowSummary] }`
- `getWorkflow(idOrName)` -> `{ ok:true, workflow: WorkflowDetail }` | `{ok:false,error}`
  - `WorkflowDetail = WorkflowSummary & { params, promptTargets, nodes, warnings? }`
  - 读时尽力用 objectInfo 重新推导 params（refresh 缓存 60s；服务器不可达就用记录里旧的），推导结果有变化则写回 store（updatedAt 不变或变均可）。
- `importWorkflow({ name, json, source='ui'|'api' })` -> `{ ok:true, workflow:[summary], warnings }` | `{ok:false,error}`
  - 先尝试 objectInfo（8s 超时）；失败仍导入（heuristic params）+ warnings
  - 名字重复时自动加 ` (2)` 后缀
- `renameWorkflow({ id, name })` / `deleteWorkflow(id)` -> `{ ok:true, workflows }`
- `listServerWorkflows()` -> `{ ok:true, items:[{path,name,size?,modified?}] }` | `{ok:false,error}`
- `importServerWorkflow({ path, name })` -> 读 userdata -> mergeImport -> 入库 -> `{ok:true, workflow, warnings}`
- `run({ workflow, prompt, negativePrompt, params, wait=true, timeoutSec, saveDir })`
  - 解析工作流（id 或 name）；merge buildParamSpecs（objectInfo 可用时）-> applyParamOverrides -> applyPrompts -> queuePrompt
  - `saveDir` 非空：把输出图片下载写入 `saveDir`（mkdir -p；文件名冲突加序号）并在结果里给绝对路径
  - 结果：
    ```
    { ok:true, promptId, state:'queued'|'done'|'error'|'timeout', elapsedMs?,
      images:[{filename,subfolder,type,mime,url?,path?}],
      applied:[{path,field?,value}], warnings:[], error? }
    ```
    `url` = `/api/sendcomfy/image?filename=..&subfolder=..&type=..`（给网页端）；`path` = 落盘绝对路径（给工具）。
    ComfyUI 明确拒绝（node_errors 非空）-> `{ok:false, error, nodeErrors}`。
    运行结果追加到 `state.lastRuns`（图片只存元数据）。
- `pollResult({ promptId, timeoutSec=300, saveDir })` -> 同 run 的终态结构（不重新入队）
- `getQueue()` -> `{ ok:true, running:[{promptId}], pending:[{promptId}] }`
- `cancel({ promptId })` -> `{ ok:true, interrupted:boolean, removed:number }`
- `getImage({ filename, subfolder, type })` -> `{ ok:true, buffer, contentType }` | `{ok:false,error}`
- `invalidateModels()`（可选，等价 comfy.invalidateObjectInfo 当前 baseUrl）

`state` 与 `comfy` 的 baseUrl 读取点：每次动作 `const state = await store.read()` 取 `state.baseUrl`，不要缓存。

## 6. HTTP API（`/api/sendcomfy`，Host 注册，浏览器 fetch 同源）

`lib/http.mjs` 导出：
```js
export function createApiHandler(actions)   // -> async (req, res) => void ；内部自己 new URL(req.url,'http://127.0.0.1')
```
路由（全部 JSON；`Content-Type: application/json; charset=utf-8`；异常 -> 500 `{ok:false,error}`；未知 -> 404）：

| 方法 路径 | 请求体 | 响应 |
|---|---|---|
| GET `/api/sendcomfy/state` | – | `getState()` |
| POST `/api/sendcomfy/config` | `{baseUrl?,timeoutSec?}` | `setConfig` |
| POST `/api/sendcomfy/test` | `{baseUrl?}` | `test` |
| GET `/api/sendcomfy/models?refresh=1` | – | `listModels` |
| GET `/api/sendcomfy/workflows` | – | `listWorkflows` |
| GET `/api/sendcomfy/workflows/{id}` | – | `getWorkflow` |
| POST `/api/sendcomfy/workflows` | `{action:'import',name,json}` / `{action:'rename',id,name}` / `{action:'delete',id}` | 对应动作 |
| GET `/api/sendcomfy/server-workflows` | – | `listServerWorkflows` |
| POST `/api/sendcomfy/server-workflows` | `{action:'import',path,name?}` | `importServerWorkflow` |
| POST `/api/sendcomfy/run` | `{workflow,prompt?,negativePrompt?,params?,wait?,timeoutSec?}` | `run`（网页端 saveDir=null） |
| GET `/api/sendcomfy/image?filename=&subfolder=&type=` | – | 图片二进制（content-type 原样；失败 JSON 404） |
| GET `/api/sendcomfy/queue` | – | `getQueue` |
| POST `/api/sendcomfy/cancel` | `{promptId?}` | `cancel` |

请求体上限 5MB；非法 JSON -> 400 `{ok:false,error}`。

## 7. 浏览器端 —— `client.js`（DSH Client 插件约定）

自注册脚本，**必须**严格按这个外形（已从本机已安装且正在工作的第三方插件抄来，勿改协议）：

```js
window.__ModuleLoader__.load({
  id: 'dsh-sendcomfy',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    // ……组件……
    return {
      inject: ['slots', 'layout', 'locale'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-sendcomfy')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-sendcomfy: styles')
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        // 侧边栏图标（id 与 main key 相同；点图标 -> 主栏显示面板，shell 自动按 id 派发）
        slots.inject('sidebar.panellist', () => slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 6, label: () => t('panel.title') },
          (props) => h(ComfyIcon, props),
        ))
        // 主栏面板
        slots.inject('main', () => slots.register(
          { name: 'main', key: PANEL_ID },
          () => h(ComfyPanel),
        ))
      },
    }
  },
})
```

- `PANEL_ID = 'dsh-sendcomfy'`。
- 图标组件 props: `{ size:number, active:boolean }`，用内联 SVG，颜色走 `currentColor`。
- `ctx.locale`：`const NS = 'dsh-sendcomfy'; ctx.locale.register(NS, { zh:{...}, en:{...} }); const t = ctx.locale.bind(NS)`（在 apply 里注册一次；若 `ctx.locale` 不存在则退化：`t = (k, p) => p?.fallback ?? k`）。文案 key 见 §7.3。
- 样式：只允许 `--dsw-alias-*` / `--dsw-radius-*` / `--dsw-focus-ring-*` 主题 token，**禁止写死颜色**（图标 artwork 除外）；亮/暗自动跟随。控件尺寸参考宿主：高 32px、圆角 6-8px、字号 13px；页面最大宽约 880px、内边距 24-32px、卡片 `bg-layer-2` + `border-l1`。
- 不要 `require('@deepseek-ai/...')`（只 `require('react')`）；不要写 `document.body`/替换根节点；不读别的插件 DOM。
- 数据全部走 `fetch('/api/sendcomfy/...')`（§6），不直连 ComfyUI。所有 fetch 都要检查 `res.ok` 与 `json.ok`，错误显示在页面里（红字），不要静默。

### 7.1 面板信息架构（满足用户原话：配置 IP / 用 models / 用 workflows / 输提示词 / 调参数）

一个可滚动主面板，顶部固定标题栏「ComfyUI 桥接」+ 连接状态 pill（已连接/未连接/未配置）+ 刷新按钮。下面分区：

1. **连接配置卡**
   - 单行输入「ComfyUI 地址」：placeholder `127.0.0.1:8188`，说明可填 IP、IP:端口或 http URL（Host 自动规范化）
   - 超时输入（秒，默认 300，选填）
   - 按钮「保存并测试」：POST /config 后 POST /test；状态 pill 与延迟/版本/设备显示
   - 未保存时提示"有未保存修改"
2. **模型库卡**
   - `GET /models`，按分类折叠列出（Checkpoints/LoRAs/VAE/...），每类显示数量；文件可点击复制名称（`navigator.clipboard` 失败静默）；「刷新」按钮；服务不可达时显示错误 + 重试
   - 若工作流参数里有 enum（如 ckpt_name），参数控件直接用 options 下拉 —— 两种使用方式都满足
3. **工作流卡**（列表 + 详情两栏/两态）
   - 列表：每条显示名称、节点数、可调参数数、来源（本地/服务器/导入）；操作：打开、重命名（inline prompt）、删除（confirm）
   - 顶部操作：「导入 JSON」—— 一个 `<textarea>` 粘贴 ComfyUI 的工作流 JSON（也支持拖拽/选择 .json 文件读取文本）→ POST import；成功提示 + warnings 列表
   - 「从 ComfyUI 服务器导入」：GET /server-workflows 列表 → 选择后 POST import（服务器不支持时显示"ComfyUI 未提供服务器工作流接口"并允许手动粘贴）
   - 详情：显示节点摘要；**提示词** textarea（正/负两条，预填 promptTargets 当前值）；**参数表单**：由 params 生成控件
     - enum -> select；boolean -> checkbox/switch；integer/number -> number input（带 min/max/step）；string 多行 -> textarea，否则 text input
     - 参数按 prompt 目标分区置顶；每个控件旁显示 `节点#id.输入名`（小字提示，便于模型用 `comfy_run` 时对齐 path）
     - 「重置为默认值」「运行」按钮；运行中禁用 + 显示 loading
   - 运行结果：图片网格（`<img src={url}>`，url 来自 §6；点击新窗口打开），耗时、状态、错误；失败时展示 nodeErrors 摘要
4. **运行记录卡**：`GET /state` 里的 `lastRuns`，最近 8 条，含状态、工作流名、时间、耗时、缩略图（有图时用 `/api/sendcomfy/image?...`）

### 7.2 交互细节
- 组件内数据加载用 `useState/useEffect`；避免在渲染里发请求。
- 失败/成功提示用内联状态行，不引入第三方 UI 库；不弹 `alert`（confirm 可以用 window.confirm 做删除确认）。
- 关键按钮 `disabled` 与 `aria-busy`；输入控件有 label（视觉隐藏或可见均可）。
- 中文为默认（语言跟随 locale：`ctx.locale.getSnapshot()` 或在 `t()` 里已处理）；不做语言切换 UI。
- 图片结果、文件内容都来自本插件 API，不要拼接 ComfyUI 的绝对 URL（浏览器够不着）。

### 7.3 locale key（至少这些；en 必填，zh 为默认）
`panel.title`（侧栏/面板标题）、`conn.title`、`conn.url`、`conn.urlHint`、`conn.timeout`、`conn.saveTest`、`conn.saving`、`conn.connected`、`conn.disconnected`、`conn.unsaved`、`conn.latency`、`conn.version`、`conn.device`、`models.title`、`models.refresh`、`models.empty`、`models.loading`、`models.error`、`models.copy`、`models.copied`、`models.total`、`wf.title`、`wf.import`、`wf.importPlaceholder`、`wf.importFromFile`、`wf.fromServer`、`wf.listEmpty`、`wf.open`、`wf.rename`、`wf.renamePrompt`、`wf.delete`、`wf.deleteConfirm`、`wf.nodes`、`wf.params`、`wf.source`、`wf.sourceUi`、`wf.sourceApi`、`wf.sourceServer`、`wf.detailBack`、`wf.prompt`、`wf.negativePrompt`、`wf.run`、`wf.running`、`wf.resetDefaults`、`wf.result`、`wf.resultEmpty`、`wf.elapsed`、`wf.failed`、`wf.importOk`、`wf.importWarnings`、`wf.serverUnsupported`、`runs.title`、`runs.empty`、`common.cancel`、`common.close`、`error.network`

## 8. 工具（Lead 写，`index.js` 内注册；客户端不用管）
工具名以 `comfy_` 开头，参数用标准 JSON Schema（`{type:'object',properties,required,additionalProperties:false}`），全部返回无损 JSON，输出 render 统一 text(JSON)。
- `comfy_status` — 当前配置/连通性/模型分类计数/本地工作流列表
- `comfy_models` — 模型清单（`category`、`keyword`、`refresh` 可选）
- `comfy_workflows` — 本地工作流清单（id/name/参数数）
- `comfy_workflow` — 单个工作流详情：可调参数 path/type/当前值/options/min/max/step、提示词目标、节点摘要
- `comfy_run` — 运行：`workflow`（id 或名字）、`prompt`、`negativePrompt`、`params`（`{ "节点id.输入名": 值 }`）、`wait`、`timeoutSec`、`saveOutputs`
- `comfy_result` — 按 `promptId` 轮询结果
- `comfy_cancel` — 中断当前/删除排队
- `comfy_import_workflow` — 从 `json`（字符串）或 `path`（工作区文件路径）导入工作流
- `comfy_server_workflows` — 列出/导入 ComfyUI 服务器工作流（`importPath` 可选）
- `comfy_upload_image` — 上传本地图片到 ComfyUI 的 input 目录（img2img 用），返回可填进 LoadImage 的文件名

工具描述按 agent-experience 规范：先说用途与前提，参数规则写在参数里，不写实现细节。图片输出落盘到「当前会话工作目录/comfy-output/<promptId 前 8 位>/」。

## 9. 安装与验证（只有 Lead 做）
- 安装：`plugin_manager { action:'install_bundle', target:'<本仓库目录>' }`
- 验证：`cordis_inspect_query` Client `Slots.listSubTree`（root=`sidebar.panellist`/`main`）确认注册；Host `Tool.listTools` 确认工具；页面视觉由用户确认（本会话无浏览器控制）。
- 安装前 Lead 会：`node --check` 全部 js、`node --test test/`、locale JSON 校验、manifest 校验。

## 10. 环境坑（2026-11-16 实测，所有人必读）

1. shell 里直接 `node` 坏（snap 封装 + 无 DBus）。必须用绝对路径：`node`。
2. **node 进程不能在 workspace 目录作为 cwd 启动**（`process.cwd` 报 ENOENT，bootstrap 就崩）。所有 node 命令都必须 `workdir: "/tmp"`（bash 工具参数），再用**绝对路径**引用包内文件，例如：
   `bash { workdir: "/tmp", command: "node --check <本仓库目录>/lib/comfy.mjs" }`
   `bash { workdir: "/tmp", command: "node --test <本仓库目录>/test/comfy.test.mjs" }`
3. 从 /tmp cwd 的 node 进程看，**workspace 是只读的（EROFS）**：测试里要写临时文件/状态目录，用 `node:os.tmpdir()` + `mkdtemp`，**不要写包目录 / workspace**。要落盘新文件就用 write/edit 工具或 bash（bash 默认 workdir=workspace 时可写）。
4. bash 沙箱偶发 bwrap 报错（"sandbox backend unusable"）或偶发 EROFS，重试即可。
5. 测试读 fixture 用 `new URL('./fixtures/x.json', import.meta.url)` 或 `fileURLToPath(import.meta.url)` 推导，不要用 process.cwd()。

---

# §11 增补：工作流由 AI 自主选择（2026-11-16 用户要求）

> 用户原话：「workflow 是 ai 自己选的」。目标是：用户只说想要什么（"画一只赛博朋克猫" / "把这张图放大" / "用这张图重绘"），
> 会话里的文本模型自己决定用哪个工作流、填什么提示词、调哪些参数 —— 不需要用户先在面板里挑工作流、也不需要用户报工作流名。
> 面板只负责「让 AI/人知道每个工作流是干什么的」+ 需要时补导入。

## 11.1 数据模型扩展（向后兼容，旧 state.json 自动可用）

`WorkflowRecord` 增加两个可选字段（`lib/state.mjs` 的 `normalizeWorkflow` 必须放行，否则写回会丢）：

```ts
description?: string   // 给 AI/人看的用途说明，≤500 字；导入时自动生成，可在面板/AI 工具里编辑
tags?: string[]        // ≤12 个，每个 ≤40 字；参与选型打分（如 ["二次元","写实","4k"]）
```

`description` 缺省时用 `describeWorkflow().summary` 实时推导，不落盘也行；`tags` 缺省 `[]`。

## 11.2 `lib/workflow.mjs` 新增纯函数（host-workflow 实现）

### `describeWorkflow(apiGraph) -> Capabilities`

```ts
type Capabilities = {
  kinds: string[],        // 有序去重；取值：'txt2img'|'img2img'|'inpaint'|'upscale'|'controlnet'|'lora'|'video'|'audio'|'other'
  kindLabels: string[],   // 与 kinds 对应的中文标签：文生图/图生图/局部重绘/放大/ControlNet/LoRA/视频/音频/其他
  hasPrompt: boolean,     // 有 CLIPTextEncode 等文本编码
  hasNegative: boolean,   // promptTargets.negative 非空 或 有 negative 标题文本节点
  classes: string[],      // apiGraph 里执行节点的 class_type 去重（按出现顺序，最多 60）
  models: string[],       // 字面量里看起来是模型文件的输入值（.safetensors/.ckpt/.pt/.pth/.bin/.gguf/.onnx），去重，最多 20
  neededInputs: {         // 运行前必须由用户/AI 准备的文件型输入（LoadImage / LoadVideo / LoadAudio 等）
    param: string,        // '1.image'（可直接填进 comfy_run.params 的 path）
    nodeClass: string,
    inputName: string,
    label: string,        // '输入图片' / '输入视频' / '遮罩图片'
    hint: string,         // '先用 comfy_upload_image 上传图片，再把返回的 name 填进这个参数'
  }[],
  outputKinds: ('image'|'video'|'audio')[],
  summary: string,        // 中文一句话：「文生图工作流，支持正负提示词，无需上传输入文件，输出图片」（≤120 字）
}
```

识别规则（实现建议）：
- 输出：`SaveImage`/`PreviewImage`/`ImageSave` → image；`VHS_VideoCombine`/`SaveAnimatedWEBP`/`SaveVideo`/`CreateVideo`/`SaveWEBM` → video；`SaveAudio`/`PreviewAudio` → audio；`SaveLatent` 视为 other。
- 能力：
  - `UpscaleModelLoader`/`ImageUpscaleWithModel`/`UltimateSDUpscale*` → upscale
  - `ControlNetLoader`/`ControlNetApply*`/`ACN_*` → controlnet
  - `LoraLoader*` → lora
  - 视频 latent/合成类（`EmptyHunyuanLatentVideo`/`WanImageToVideo`/`EmptyMochiLatentVideo`/`AnimateDiff*`/`VHS_*`）→ video
  - 有 `VAEEncode` 且其像素输入来自 `LoadImage` → img2img；同图带 `LoadImageMask`/`ImageToMask`/`InpaintModelConditioning`/`VAEEncodeForInpaint` → inpaint
  - 有 `LoadImage` 但不经过 VAEEncode（如 IPAdapter/ControlNet 参考图）→ 不算 img2img，但 `neededInputs` 要有它
  - sampler（`KSampler*`/`SamplerCustom*`）+ `EmptyLatentImage` 类 → txt2img（若同时有 img2img 也保留两种）
  - 都没有 → ['other']
- `neededInputs`：class 匹配 `/^(LoadImage|LoadImageMask|VHS_LoadVideo|VHS_LoadAudio|LoadVideo|LoadAudio)/` 或输入名是 `image|video|audio|mask` 且当前值是文件名字符串；param = `${nodeId}.${inputName}`；label 按 class/字段给中文；hint 固定提示先 `comfy_upload_image`。
- 全部实现为防御式：空图/坏输入返回 `{kinds:['other'], kindLabels:[...], classes:[], models:[], neededInputs:[], outputKinds:[], hasPrompt:false, hasNegative:false, summary:'无法识别的工作流'}`，不抛错（除非 apiGraph 不是对象）。

### `chooseCandidates(task, candidates, { limit = 5 } = {}) -> Ranking`

```ts
// candidates: { name: string, description?: string, tags?: string[], kinds?: string[], kindLabels?: string[],
//               classes?: string[], paramNames?: string[], models?: string[] }[]
type Ranking = {
  matches: { index: number, score: number, matched: boolean, reasons: string[] }[], // 按 score 降序、同分按原始 index
  tokens: string[],        // 任务分词结果（调试用）
  intentKinds: string[],   // 从任务推断出的能力标签
}
```

打分（确定性、可测）：
- 任务分词：小写；英文/数字按词（≥2 字符，去 a/the/for/of/to/and 等停用词）；连续 CJK 段拆 bigram（长度 1 的段保留单字）。
- 意图词典（命中即加入 intentKinds）：
  - 文生图：文生图/生成图/画/绘制/出图/插画/海报/头像/壁纸/想象
  - 图生图：图生图/重绘/改图/换风格/垫图/参考图/风格化
  - 局部重绘：局部重绘/遮罩/修复/inpaint/抹除
  - 放大：放大/超分/高清/清晰/修复老照片/upscale
  - 视频：视频/动画/动图/图生视频/延长/补帧
  - ControlNet：线稿/姿势/骨架/深度/边缘/controlnet/结构控制
  - LoRA：lora/风格模型/微调模型
- 计分：name 精确含任务串 +10；name token 命中 +6；description token 命中 +2/个（≤6）；tags 命中 +3/个（≤9）；kinds ∩ intentKinds +5/个；models/classes token 命中 +2/个（≤6）。
- `matched`：score>0。`reasons`：中文，最多 4 条，如 `命中能力：图生图`、`说明/标签提到「重绘」`、`名称包含「放大」`。
- 全部 0 分时仍返回候选（按原顺序），`matched:false`，reason `没有明显匹配，按可用工作流列出`。
- `limit` clamp 1..10。

## 11.3 `lib/actions.mjs` 增补（Lead 实现）

- `summarizeWorkflow(record)` 增加：`description`（record.description || describeWorkflow().summary）、`kinds`、`kindLabels`、`tags`、`neededInputCount`。
- `getWorkflow` 的 detail 增加：`description`、`tags`、`capabilities`（完整 describeWorkflow 结果，含 neededInputs/classes/models/outputKinds）。
- `importWorkflow`：入库时写 `description = merged.description || capabilities.summary`、`tags = []`。
- 新增 `updateWorkflowMeta({ id, description?, tags? })`：校验（description ≤500 字、tags ≤12×40 字、去重去空白），写回并返回 `{ ok:true, workflow: summary }`；id/name 均接受。
- 新增 `chooseWorkflow({ task, includeServer = true, limit = 5 })`：
  1. 本地候选：每个 workflow → `{ name, description, tags, kinds, kindLabels, classes, paramNames: params.map(p=>p.inputName), models }`
  2. 服务器候选（includeServer 且 ComfyUI 可达时，best-effort 8s）：`comfy.listUserdataWorkflows` 的 items → `{ source:'server', name: 文件名去 .json, importPath: path }`，能力未知
  3. `workflow.chooseCandidates(task, candidates, {limit})` 排序
  4. 返回：
     ```
     { ok:true, task, intentKinds,
       candidates: [{
         source:'local'|'server',
         name, description,
         ...(local ? { workflow:{id,name} } : { importPath, needsImport:true }),
         kinds, kindLabels, neededInputs, outputKinds,
         score, matched, reasons,
         next: local ? 'comfy_run({"workflow":"<id 或 name>", ...})' : 'comfy_server_workflows({"importPath":"..."}) 导入后 comfy_run({"workflow":"<name>"})'
       }],
       totals:{ local, server }, warnings }
     ```
  5. 本地和服务器都空 → `{ ok:false, error:'还没有任何可用工作流：先在面板导入，或让 ComfyUI 服务器上存有 workflows' }`。
- `run`：保持 `workflow` 必填；若没找到并收到空引用，错误信息里提示"不知道用哪个就先 comfy_choose_workflow"。

## 11.4 HTTP 增补（Lead）

- `POST /api/sendcomfy/workflows` 增加 `{ action:'update', id, description?, tags? }` → `updateWorkflowMeta`。
- `/state`、`/workflows` 的 summary 自动带上 §11.3 新字段（客户端只增不改）。
- 不新增面板用的 choose 端点（选型只给 Agent 工具用）。

## 11.5 Agent 工具增补（Lead，`index.js`）

- 新增 `comfy_choose_workflow`（§8 风格描述）：
  - 用途：用户只说想要什么、没说用哪个工作流时先调它；按任务给本地+ComfyUI 服务器工作流打分排序。
  - 参数：`task`（string，必填：用户想要的效果，尽量保留原话里的风格/用途词）、`includeServer`（boolean，默认 true）、`limit`（number，默认 5）。
- 新增 `comfy_describe_workflow`：
  - 用途：给工作流写/改「用途说明 + 标签」，让以后 AI 选型更准（例如用户说过"这个工作流是画二次元头像的"，就记下来）。
  - 参数：`workflow`（必填 id/name）、`description`（string 可选）、`tags`（array[string] 可选）。
- 更新 `comfy_workflows` / `comfy_workflow` / `comfy_run` 的 description：明确"不知道选哪个先 comfy_choose_workflow"、"选好后可用 comfy_workflow 看参数"。
- 工具总数 10 → 12。

## 11.6 面板增补（client-panel，只改 client.js）

- 工作流列表每条：能力 chips（kinds/kindLabels，最多 3 个）、描述（单行截断）、需要上传文件时的小标记（如「需输入图片」）。
- 工作流详情：
  - 顶部能力 chips + 一句话说明；
  - 「用途说明（AI 选型会用）」textarea + 「标签」输入（逗号分隔）+ 「保存说明」按钮 → `POST /workflows {action:'update', id, description, tags}`；成功/失败内联提示；保存后刷新 state 与详情；
  - `neededInputs` 列表：每项显示 `#节点.输入名` + hint（如先 comfy_upload_image）。
- locale 新增 key（zh/en 都要有，禁止硬编码文案）：
  `wf.capabilities`、`wf.description`、`wf.descriptionHint`、`wf.tags`、`wf.tagsHint`、`wf.saveMeta`、`wf.savedMeta`、`wf.needsInput`、`common.save`、
  `wf.kind.txt2img`、`wf.kind.img2img`、`wf.kind.inpaint`、`wf.kind.upscale`、`wf.kind.controlnet`、`wf.kind.lora`、`wf.kind.video`、`wf.kind.audio`、`wf.kind.other`（中文标签服务端也会给 kindLabels，但前端保留兜底）。
- 其余行为/样式规范不变（CONTRACT §7）。

## 11.7 测试与验收（Lead）

- `test/workflow.test.mjs`：describeWorkflow（txt2img fixture / 合成 img2img+upscale 图 / 空图）、chooseCandidates（放大任务→upscale 第一；画猫→txt2img；无匹配 matched:false；limit 生效）。
- `test/actions.test.mjs`：import 自动 description、updateWorkflowMeta 持久化（写回 state 仍在）、chooseWorkflow 本地排序 + 无工作流报错。
- `test/index.test.mjs`：工具数 12、`comfy_choose_workflow` / `comfy_describe_workflow` 可执行（describe→choose 端到端）。
- `test/client.test.mjs`：REQUIRED_LOCALE_KEYS 更新为新列表。
- 部署：本插件是 **linked package**，改完后用 Plugin Manager 触发一次 profile recomposition（`plugin_manager set_bundle` 先 false 再 true，或 install_bundle）即可热替换 Host 代码，无需重启 DSH；随后用 `Tool.listTools` + 实调 `comfy_choose_workflow` 验证。

## 11.8 实现落点（2026-11-18 修订）

- 能力画像与选型打分最终放在 **`lib/capabilities.mjs`**（`describeWorkflow` / `chooseCandidates` / `tokenizeTask` / `detectIntentKinds`），
  由 `lib/actions.mjs` 引入使用；`lib/workflow.mjs` 仍只负责解析/转换/参数/提示词（§4），不再新增这两个函数。
- `lib/state.mjs` 的 `normalizeWorkflow` 已放行 `description` / `tags`（缺省不写、写回不丢）。
- 面板 `client.js` 已展示能力 chips / 说明 / 需输入标记，并支持编辑「用途说明 + 标签」（`POST /workflows {action:'update'}`）。
- 部署：linked package 改完后用 Plugin Manager 触发一次 recomposition（set_bundle 关→开）即热加载，无需重启 DSH。

## §13 v0.4.0「不导入」模式（2026-11-20）

- 工作流来源改为 **ComfyUI 服务器 userdata**：面板与 `comfy_workflows` 直接列服务器工作流，不要求导入本地库。
- 新增 actions：
  - `getServerWorkflowDetail({ path, name })`：读取 + `mergeImport` + `buildParamSpecs`，返回 `{ok, fromServer, sourcePath, workflow: detail, warnings}`，**不写 state**。
  - `getWorkflow(idOrName)`：本地找不到且参数以 `.json` 结尾时，按服务器路径加载返回详情（同样不落盘）。
  - `run({ workflow })`：本地找不到且 `workflow` 形如服务器路径（`.json` 或 `server:` 前缀）时，先 `loadServerRecord` 再入队；返回的 workflow summary 带 `source:'server'`、`sourcePath`。
  - `chooseWorkflow`：服务器候选的 `next` 改为 `comfy_run({"workflow":"<path>"})`，不再要求先导入。
- 新增 HTTP `GET /server-workflows/detail?path=&name=`。
- 面板：`ServerWorkflowsCard`（列表 + 搜索 + 使用）取代旧 `WorkflowsCard` 的导入逻辑；`WorkflowDetail` 支持 `path`（服务器）与本地 `id` 两种来源，run 时分别传 path / id；服务器详情不提供本地说明/标签编辑，改为「运行时自动加载」提示 + 复制路径。
- 本地保存的工作流与 `comfy_import_workflow` / `comfy_server_workflows` 导入接口保留兼容，但不再是主路径。

## §14 v0.4.2：bypass 全支持与 userdata 兼容（2026-11-20）

- `uiToApiGraph` 的 bypass 透传升级：
  - `bypassOutput(node, outSlot, consumerType)` 匹配顺序：消费者类型（`input.type`）→ 输出槽类型 → 信息不足且唯一输入时兜底；
  - 类型兼容用集合比较（`IMAGE,MASK` / `*`），支持多输出节点与链式 bypass；
  - 找不到透传输入时返回 `{kind:'missing', reason}`，由主循环按 `inputIsRequired()`（object_info）决定是否 warning —— 只有必填输入缺失才提示；
  - 汇总一条「工作流里有 N 个 bypass 节点」的提示，不再逐节点刷屏。
- `getUserdataWorkflow`：
  - 路径编码改为 `encodeURIComponent(...).replace(/%/g,'%25')`，抵消 ComfyUI `user_manager` 对 `match_info` 的二次 unquote（字面 `%20` 文件名）；
  - `request()` 增加 `buffer` 返回；gzip 检测 `1f 8b`，先用 `gunzipSync`，失败时用 `InflateRaw + Z_SYNC_FLUSH` 容错还原「gzip 前缀 + 明文后缀」的半损坏文件（优先取能独立解析的完整 JSON）。
- 实测：126 个真实服务器工作流 126/126 转换成功；74 个含 bypass，10 个存在「bypass 掉源节点后必填输入确实没数据」的 warning（语义正确，ComfyUI 运行也会缺输入）。

## §15 v0.5.0：新版 Subgraph 展开（2026-11-24）

- `uiToApiGraph` 在建立 nodeMap 之前调用 `expandSubgraphs(graph, definitions, warn)`：
  - 提前收集 `definitions.subgraphs`（id → def），把子图实例替换成内部节点；
  - 节点 id：`[...实例路径, 内部id].join(':')`（与 ComfyUI `ExecutableNodeDTO.id` 一致）；
  - 虚拟端口：子图输入 `-10`、输出 `-20`；
  - 跨边界解析：
    - 内部链接 `origin_id === -10` → 取实例 inputs[slot]：有外链则递归解析父图链接；否则取提升输入默认值（`properties.proxyWidgets` + `widgets_values`；再退回实例 inputs 的 `widget` 元数据顺序），合成 `PrimitiveNode` 字面量；
    - 输出 `-20` → 找 `def.links` 里 `target_id === -20 && target_slot === slot` 的内部链接，递归解析其源；
    - 嵌套子图实例 → 在内部作用域递归；
  - 子图实例本身不进入 API 图；bypass 实例按 bypass 语义透传，静音实例输出视为无数据；
  - 定义缺失 / 循环引用给出 warning（`节点 #x 看起来是子图实例但缺少定义` / `出现循环引用`）。
- 测试：`test/workflow.test.mjs` 增加「跨边界连线 / 提升输入默认值 / 嵌套子图」3 个用例；真实服务器 3 个子图工作流验证通过（127/127 转换成功）。

## §15.1 提示词目标沿连线补充（2026-11-24）

- `buildParamSpecs` 末尾调用 `augmentLinkedPromptTargets`：
  - 从每个节点的 `positive` / `negative` 输入出发，沿子图展开后的 API 链接反查；
  - 遇到没有字符串 widget 的编码节点（如 `CLIPTextEncode.text` 是连线）继续沿 `text/prompt/value` 优先的上游链接追溯；
  - 找到可写的字符串参数后登记到 `promptTargets` 并标记 `isPrompt`；
  - 已有显式标题归类（Positive/Negative）的目标不覆盖。
- 例：ComfyUI 官方 FLUX.2 Klein 子图工作流的正向提示词目标是 `76.value`（PrimitiveStringMultiline），负向是 `75:67.text`。
