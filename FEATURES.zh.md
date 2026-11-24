# dsh-sendcomfy 功能详解

> 版本：v0.5.0 · 2026-11-24  
> 一句话：把 ComfyUI 接进 DeepSeek Harness —— 面板里直接浏览 ComfyUI 服务器上的工作流与模型，会话里的文本模型也能自己选工作流、填提示词、调参数并出图。

---

## 1. 它解决什么问题

传统用法要在 ComfyUI 的网页里手动搭图、挑模型、填提示词、点运行，再把图拷来拷去。  
这个插件把 ComfyUI 变成 DSH 的「一个能力」：

- **看**：面板里就能看到 ComfyUI 服务器上有什么工作流、有什么模型；
- **用**：点一下工作流就能看参数、填提示词、运行；不需要导入、不需要把 JSON 拷进 DSH；
- **让 AI 用**：在聊天里说「用 ComfyUI 把这张图放大 4 倍」「画一只赛博朋克风格的猫」，会话里的文本模型会自己：
  1. 查看服务器上有哪些工作流（`comfy_workflows`）；
  2. 按任务挑一个（`comfy_choose_workflow`，服务器优先）；
  3. 看它的参数/提示词目标（`comfy_workflow`）；
  4. 直接运行（`comfy_run`，运行时才从服务器加载 JSON）；
  5. 把图片保存到工作区并展示（必要时 `comfy_result` 轮询、`comfy_cancel` 取消）。

---

## 2. 整体架构

```
┌─────────────── 浏览器（DSH Web UI） ───────────────┐
│ 侧边栏「ComfyUI 桥接」图标 → 主面板（client.js）    │
│   工作流 / 模型 / 记录 / 连接 四个页签              │
└───────────────┬───────────────────────────────────┘
                │ 同源 HTTP  /api/sendcomfy/*
┌───────────────▼───────────────────────────────────┐
│ Host 插件（index.js）                              │
│   ├─ lib/http.mjs      HTTP 路由                   │
│   ├─ lib/actions.mjs   业务逻辑（面板与工具共用）   │
│   ├─ lib/comfy.mjs     ComfyUI HTTP 客户端          │
│   ├─ lib/workflow.mjs  工作流解析/UI→API/参数推导   │
│   ├─ lib/capabilities.mjs 能力画像 + 选型打分       │
│   └─ lib/state.mjs     本地状态（配置/旧库存/记录） │
└───────────────┬───────────────────────────────────┘
                │ HTTP（Host 代理，浏览器不直连）
        ┌───────▼────────┐
        │  ComfyUI 服务器  │  /system_stats /object_info /prompt
        └────────────────┘  /history /view /upload /userdata
```

关键设计：

- **浏览器不直连 ComfyUI**：避免 CORS、跨网段、鉴权问题，所有请求都由 Host 代理；
- **业务逻辑只有一份**：面板动作和 Agent 工具调用同一套 `lib/actions.mjs`；
- **不导入工作流**：服务器 userdata 里的工作流是唯一主来源，运行时按需加载（见 §5）；
- **配置/旧库存/运行记录**存在 `$DSH_HOME/sendcomfy/state.json`（默认 `~/.dsh/sendcomfy/state.json`）。

---

## 3. 面板怎么用（v0.4.1）

点左侧栏「ComfyUI 桥接」图标打开主面板，顶部是标题、连接状态、刷新按钮和版本号，下面是四个页签。

### 3.1 连接（Connection）
- **ComfyUI 地址**：支持 `127.0.0.1:8188`、`192.168.1.10:8188`、`http://host:8188` 等写法，Host 会规范化；
- **超时（秒）**：单次运行最多等多久，默认 300，可 5–3600；
- **保存并测试**：保存配置后立即请求 `/system_stats`，显示延迟、ComfyUI 版本、设备；
- 状态 pill：已连接 / 未连接 / 未配置 / 检测中，一眼看出能不能用。

### 3.2 工作流（Workflows）
- 打开即列出 **ComfyUI 服务器上保存的工作流**（userdata/工作流目录），带名称、路径、大小、修改时间；
- **搜索框**按名称/路径过滤；
- 点任意一条 → 打开详情（此时才按需读取 JSON）：
  - 能力标签（文生图 / 图生图 / 局部重绘 / 放大 / ControlNet / LoRA / 视频 / 音频）；
  - 一句话能力说明；
  - **提示词**输入框（正向/负向，自动识别工作流里的文本节点）；
  - **参数表单**：枚举下拉、数字（带 min/max/step）、布尔开关、多行文本；每项旁边标注 `#节点.输入名`（就是给 AI 用的 path）；
  - **需要的输入文件**（如 LoadImage）：提示先用 `comfy_upload_image` 上传；
  - 运行按钮、重置默认值、耗时显示、结果图片网格；
  - 右上角可**复制工作流路径**（方便在聊天里让 AI 直接用）。
- 没有导入按钮 —— 因为不需要导入；运行前 Host 会自己从服务器加载最新版本。
- 旧版里已经导入到本地的存量工作流仍留在 state 里（兼容用），但不在这个页签主列表里显示。

### 3.3 模型（Models）
- 按分类列出 ComfyUI 里的模型文件：checkpoints / LoRAs / VAE / CLIP / UNET / ControlNet / Upscale / CLIP Vision / Style / Embeddings / IPAdapter / GLIGEN 等；
- **搜索框**输入即过滤，命中分类自动展开；
- 点击模型名复制到剪贴板（方便填进参数或提示词）；
- 未连接时给「去配置连接」入口。

### 3.4 记录（Runs）
- 最近 20 次运行的记录：状态、工作流名、时间、耗时、图片缩略图、错误；
- 面板每次运行后会自动刷新。

### 3.5 滚动与布局（v0.4.1 修复）
- 面板整体限高：`height:100%` + `max-height:100dvh`，内容区独立滚动（`overflow-y:auto`）；
- 页签栏/标题栏固定，只有内容滚动；
- 窗口变矮、工作流/模型列表很长时也能正常滚到底部。

---

## 4. AI 工具详解

会话里文本模型可以直接调用这些工具（共 12 个）。原则：**先看、再选、再运行**。

### 4.1 `comfy_status`
- 用途：看配置与连通性、模型分类计数、本地旧库存、最近运行。
- 参数：无。
- 典型：任何 comfy 操作失败后先调它确认 ComfyUI 是否可达。

### 4.2 `comfy_workflows`
- 用途：**查看 ComfyUI 服务器上有哪些工作流**（主入口，不需要导入）。
- 参数：无。
- 返回：
  - `serverReachable`、`serverWorkflows[{ path, name, size?, modified? }]`；
  - `localWorkflows[]`（旧库存，兼容）；
  - `hint`：path 可直接传给 `comfy_run` / `comfy_workflow`，不需要先导入。
- 例：拿到 126 条工作流，从里面挑 `krea2.json`。

### 4.3 `comfy_workflow`
- 用途：看某个工作流的详情（参数/提示词目标/节点）。
- 参数：`workflow` —— 服务器 path（如 `krea2.json`）或本地 id/名称。
- 返回：`params[]`（path/type/当前值/枚举 options/min/max/step/isPrompt）、`promptTargets.positive/negative`、`nodes[]`、`capabilities`、`hasPrompt/hasNegative`、`warnings`。
- 这是「调参数」的说明书：把返回的 `params[].path` 填进 `comfy_run.params`。

### 4.4 `comfy_choose_workflow`
- 用途：用户只说想要什么、没说用哪个工作流时，**AI 自主选型**。
- 参数：
  - `task`（必填）：用户想要的效果，保留风格/用途词；
  - `includeServer`（默认 true）：把服务器工作流纳入候选；
  - `includeLocal`（默认 false）：是否也把本地旧库存纳入（默认不参与，服务器优先）；
  - `limit`（默认 5，1–10）。
- 返回：`mode`（server/local）、`intentKinds`、`candidates[]`（source/name/sourcePath/kinds/score/matched/reasons/next）、`totals`、`warnings`、`hint`。
- 排序规则（确定性）：
  - 中文意图词典 + 名称/路径 token；
  - 服务器候选按文件名/目录**猜能力**（视频/音频/放大/图生图/重绘/ControlNet/LoRA/文生图）；
  - 任务没要求却带视频/音频能力的候选重罚（避免「视频流」抢「单图放大」）；
  - 能力越杂越降权；名称含「示例/测试/demo」降权；
  - 本地旧库存默认不参与（有存量时会 `warnings` 说明）。
- 每个候选的 `next` 直接给出下一步调用；img2img/放大/视频类会提示先看 `neededInputs`（可能要 `comfy_upload_image`）。

### 4.5 `comfy_run`
- 用途：运行工作流出图。
- 参数：
  - `workflow`：服务器 path（推荐，如 `krea2.json`）或本地 id/名称；
  - `prompt` / `negativePrompt`：写进自动检测到的正向/负向提示词节点；
  - `params`：`{ "节点id.输入名": 值 }` 覆盖任意可调参数（先用 `comfy_workflow` 查 path）；
  - `wait`（默认 true）：false 时立刻返回 promptId，用 `comfy_result` 轮询；
  - `timeoutSec`；`saveOutputs`（默认 true）。
- 行为：
  - 如果 `workflow` 是服务器 path，**运行前才从 ComfyUI 加载 JSON**（use 时先加载再运行），不写本地库；
  - 把提示词/参数合并进图 → `/prompt` 入队；
  - 默认等完成，下载图片到工作区 `comfy-output/<promptId 前 8 位>/`，并返回图片路径 + 代理 URL；
  - 返回 `promptId/state/elapsedMs/images/applied/warnings/workflow`（含 `source:'server'`、`sourcePath`）。
- 长任务：`wait:false` + `comfy_result`。

### 4.6 `comfy_result`
- 用途：按 `promptId` 查任务最终结果（配合 `comfy_run(wait:false)`）。
- 参数：`promptId`、`timeoutSec?`、`saveOutputs?`。

### 4.7 `comfy_cancel`
- 用途：中断当前运行/删除排队任务。
- 参数：`promptId?`（省略=中断当前并清空队列）。

### 4.8 `comfy_upload_image`
- 用途：把**当前会话工作区**里的图片上传到 ComfyUI 的 input 目录，返回可填进 LoadImage 的 `name`（img2img/图生视频用）。
- 参数：`path`（工作区相对/绝对路径）、`subfolder?`。

### 4.9 `comfy_models`
- 用途：列出模型文件（可按类别/关键词过滤），用于选风格模型或确认模型是否存在。
- 参数：`category?`、`keyword?`、`refresh?`。

### 4.10 `comfy_import_workflow`（兼容）
- 用途：把一段工作流 JSON（文本或工作区文件）存进本地库后运行。**一般不需要** —— 直接 `comfy_run(path)` 即可。
- 参数：`name`、`json?` / `path?`。

### 4.11 `comfy_server_workflows`（兼容）
- 用途：旧用法里「列出/导入服务器工作流到本地库」。现在通常直接 `comfy_run(path)`，不需要导入。
- 参数：`importPath?`、`name?`。

### 4.12 `comfy_describe_workflow`（本地库）
- 用途：给**本地保存的**工作流写用途说明/标签，让 `comfy_choose_workflow(includeLocal:true)` 时更准。
- 参数：`workflow`、`description?`、`tags?`。
- 服务器工作流没有本地记录，不能写说明；AI 可以每次用 `comfy_workflow(path)` 现看参数。

---

## 5. 「use 时先加载再运行」具体发生了什么

以 `comfy_run({ workflow: "krea2.json", prompt: "..." })` 为例：

1. Host 先在本地库里找 `krea2.json`（没有）；
2. 识别为服务器 path → `GET /userdata/workflows%2Fkrea2.json` 读取最新 JSON；
3. 同时拉 `/object_info`，把 UI 格式图转成 `/prompt` 需要的 API 格式，并推导：
   - 可调参数（枚举值、min/max/step 来自服务器真实节点定义）；
   - 正向/负向提示词目标（按节点标题 + 图拓扑反查）；
   - 能力画像（文生图/图生图/放大/视频…）、需上传的输入文件；
4. 应用 `prompt` / `negativePrompt` / `params`（数字字符串自动转数字、枚举校验、越界警告）；
5. `POST /prompt` 入队，等 `/history`，下载 `/view` 图片到工作区；
6. 返回结果并写一条运行记录（不写本地工作流库）。

> 代价：每次 use 都会重新读取一次服务器 JSON + object_info（缓存 60 秒），首次通常 1–6 秒；换来的是永远用服务器上最新版本，不需要同步/导入。

---

## 6. 数据与文件

| 位置 | 内容 |
|---|---|
| `$DSH_HOME/sendcomfy/state.json` | ComfyUI 地址、超时、clientId、本地旧库存、最近运行记录 |
| `$DSH_HOME/sendcomfy/requests.log` | 面板请求诊断日志（method/路径/状态/耗时/请求体摘要，滚动 1MB） |
| `<会话工作区>/comfy-output/<promptId 前 8 位>/` | `comfy_run` 下载的输出图片（工作区可读、可直接展示） |
| `~/.dsh/sendcomfy/state.bad-*.json` | state 损坏时的自动备份 |

---

## 7. 错误与边界

- **连不上 ComfyUI**：`comfy_status` / 面板会显示具体错误（ECONNREFUSED、超时、HTTP 状态），先检查地址/服务；
- **服务器工作流 404**：已适配 ComfyUI userdata 路径语义（`/userdata/workflows%2F<file>`）；旧版 ComfyUI 没有该接口时面板会提示；
- **新版 Subgraph（子图）已支持**：定义在 `definitions.subgraphs` 里的子图会在转换时自动展开成普通节点（节点 id 形如 `实例路径:内部id`，与 ComfyUI 执行 id 一致）；支持跨子图边界连线、未连接提升输入取实例 `widgets_values` 默认值、嵌套子图、bypass/静音的子图实例；
- **bypass（mode=4）已全支持**：按「下游消费者类型 → 输出槽类型」匹配透传，兼容 `IMAGE,MASK` 宽类型与 `*` 通配、多输出节点、链式 bypass；多个同类型输入时优先同名；找不到可透传输入时按 ComfyUI 语义视为该输出无数据，只在**必填输入**缺失时提示（不会因 bypass 导致整个工作流转换失败）；
- **工作流文件读取兼容**：ComfyUI userdata 里 gzip 存储、甚至「gzip 前缀 + 明文后缀」的半损坏工作流也能还原；文件名含字面 `%20` 的路径也不会 404；
- **参数被 ComfyUI 拒绝**：返回 `nodeErrors`，按提示改 `params`（如枚举值不在列表）；
- **AI 选型不准**：选型按文件名/目录启发式 + 确定性打分，不做图像语义理解；可先 `comfy_workflow(path)` 看参数，或把更对口的工作流放前面/改名；
- **超时**：面板运行默认等 300s（可配），工具层最长 3600s；超时后任务可能还在跑，用 `comfy_result` 按 promptId 续查。

---

## 8. 快速上手

1. 刷新 DSH 页面（版本号应为 v0.4.1）；
2. 侧边栏打开「ComfyUI 桥接」→「连接」页填 `IP:端口` → 保存并测试；
3. 「工作流」页搜索/点开一个工作流 → 填提示词、调参数 → 运行；
4. 或在聊天里直接说：「用 ComfyUI 把这张图放大 4 倍」「画一只赛博朋克风格的猫，用 krea2」——AI 会自己选型、看参数、运行、回图。

---

## 9. 目录导航

- 面板：`client.js`（页签/列表/详情/参数表单）
- 工具与挂载：`index.js`（12 个 `comfy_*` 工具 + `/api/sendcomfy/*` 路由）
- 业务层：`lib/actions.mjs`
- ComfyUI 客户端：`lib/comfy.mjs`
- 工作流解析/转换/参数：`lib/workflow.mjs`
- 能力画像/选型：`lib/capabilities.mjs`
- 本地状态：`lib/state.mjs`
- HTTP 路由：`lib/http.mjs`
- 测试：`test/*.test.mjs`（147 个用例）
