# dsh-sendcomfy

DeepSeek Harness（DSH）的 **ComfyUI 桥接**插件：在 Web UI 左侧栏放一个 ComfyUI 面板，配置 ComfyUI 地址、浏览它的模型、导入/管理工作流；同时把能力暴露成 `comfy_*` 工具，让会话里的文本模型直接调用 ComfyUI —— 填入提示词、覆盖任意节点参数、等出图结果。

## 它能做什么

- **侧边栏面板**（点左侧栏的 ComfyUI 图标）：配置 `IP:端口`（也接受完整 `http://…` URL）、测试连接、浏览模型库（Checkpoints / LoRAs / VAE / CLIP / ControlNet / Upscale …）。
- **工作流**
  - 粘贴 JSON / 选择 `.json` 文件导入 ComfyUI 导出的工作流（自动识别 UI 格式并转成 `/prompt` 需要的 API 格式，也支持 API 格式）。
  - 从 ComfyUI 服务器自己保存的工作流目录导入（ComfyUI 版本支持 `userdata` 接口时）。
  - 重命名 / 删除 / 详情查看。
- **运行与调参**：详情页有正向/负向提示词输入框 + 由工作流节点自动生成的参数表单（枚举下拉、数字、布尔、多行文本）；运行后直接看图片结果与耗时，最近运行有记录。
- **给文本模型的工具**（在任意会话里可用）：
  | 工具 | 用途 |
  |---|---|
  | `comfy_status` | 配置、连通性、模型分类计数、工作流清单 |
  | `comfy_models` | 模型清单（可按类别/关键词过滤） |
  | `comfy_workflows` | 已保存工作流清单 |
  | `comfy_workflow` | 单个工作流的可调参数（path/类型/当前值/枚举/min/max）与提示词目标 |
  | `comfy_run` | 运行工作流：`prompt` 自动写正向提示词，`params` 按 `节点id.输入名` 覆盖参数 |
  | `comfy_result` | 按 `promptId` 查结果（配合 `wait=false`） |
  | `comfy_cancel` | 中断当前任务 |
  | `comfy_import_workflow` | 把 JSON 文本或工作区文件导入为工作流 |
  | `comfy_server_workflows` | 列出 / 导入 ComfyUI 服务器上的工作流 |
  | `comfy_upload_image` | 上传工作区图片到 ComfyUI 的 input 目录（img2img 用） |

## 架构

```
浏览器（client.js）                      Host 进程（index.js）
┌──────────────────────────┐   fetch    ┌─────────────────────────────────────┐
│ 侧栏图标 + 主栏面板       │ ─────────► │ /api/sendcomfy/*  (lib/http.mjs)    │
│ 配置 / 模型 / 工作流 UI   │            │        │                            │
└──────────────────────────┘            │        ▼                            │
                                        │ lib/actions.mjs（唯一的业务实现）     │
会话里的文本模型 ──comfy_* 工具──────────► │        │                            │
                                        │  lib/comfy.mjs ──► ComfyUI HTTP API │
                                        │  lib/workflow.mjs（UI→API/参数/提示词）│
                                        │  lib/state.mjs ──► state.json       │
                                        └─────────────────────────────────────┘
```

- 浏览器**不直连** ComfyUI（避免 CORS / 跨网段问题），所有请求由 Host 代理。
- 业务逻辑只实现一次（`lib/actions.mjs`），网页动作与 Agent 工具共用同一份代码。
- 工作流/配置持久化在 `$DSH_HOME/sendcomfy/state.json`（默认 `~/.dsh/sendcomfy/state.json`），不改 profile 的 patch。
- 工具出图默认落盘到当前会话工作区的 `comfy-output/<promptId 前 8 位>/`，同时返回代理 URL；`present` 工具可直接展示这些文件。

## 安装

在本 Harness 里用 Plugin Manager 安装本目录（本地目录安装会链接源码，改完重启生效）：

```
plugin_manager { action: "install_bundle", target: "<本目录绝对路径>" }
```

或在 profile 的 `dsh.profile.bundles` 中已安装后由 `plugin_manager` 启用。首次使用：打开侧边栏的 ComfyUI 图标 → 填 ComfyUI 地址（如 `192.168.1.10:8188`）→「保存并测试」。

## 数据与状态

- `$DSH_HOME/sendcomfy/state.json`：`baseUrl` / `timeoutSec` / `clientId` / `workflows[]` / `lastRuns[]`（原子写；坏文件会备份成 `state.bad-<时间戳>.json` 后回默认值）。
- 工作流最多保留 100 个，运行记录最多 20 条。

## 开发与测试

- 纯 ESM、零第三方依赖；测试用 Node 内建 `node:test`。
- 本机会话环境里注意（详见 `CONTRACT.md` §10）：`node` 需用绝对路径 `node`，且命令工作目录用 `/tmp`，包内文件一律绝对路径引用。

```bash
NODE=node
$NODE --test <包目录>/test/comfy.test.mjs
$NODE --test <包目录>/test/workflow.test.mjs
$NODE --test <包目录>/test/http.test.mjs
$NODE --test <包目录>/test/actions.test.mjs
```

## 已知边界

- ComfyUI「UI 格式」工作流转换覆盖常见节点（KSampler/CLIPTextEncode/CheckpointLoader 等）；极老的模板或含 bypass/mute 复杂子图的转换可能不完整，导入时的 `warnings` 会提示。
- 服务器工作流列表依赖 ComfyUI 的 `userdata` 接口；旧版本会提示改用粘贴 JSON。
- 面板视觉在本会话无法由 Agent 截图验证（无浏览器控制）；客户端只做静态/语法校验，需用户在实际页面确认。
- 输出图片通过 Host 代理转发，超大图（>64MB/张）会跳过落盘但仍给 URL。

## 本机安装状态（2026-11-16 验收记录）

- 已用 `plugin_manager install_bundle` 安装到 `web` profile（`link:` 到本目录，改动代码后重启 DSH 生效），`application: applied`。
- 已确认生效：
  - Client：`sidebar.panellist` 出现 `dsh-sendcomfy`（order 6，active）、`main` 出现 key `dsh-sendcomfy`（active）。若页面没看到图标，刷新一次浏览器页面。
  - Host：`/api/sendcomfy/*` 路由 + 10 个 `comfy_*` 工具均已注册，工具可直接在任意会话里调用。
- 端到端验收（用本机临时假 ComfyUI 服务，非真实 GPU 服务）：配置 `127.0.0.1:8299` → 测试连接 → 读模型 → 导入 UI 格式工作流（自动 13 个可调参数、正负提示词目标识别）→ 运行（提示词 + steps/cfg/seed/尺寸/模型覆盖全部生效，ComfyUI 收到的图与参数已逐项核对）→ 图片经 `/api/sendcomfy/image` 代理返回并落盘到工作区 → 运行记录、队列、服务器工作流导入均正常。验收后已把 ComfyUI 地址重置回默认 `127.0.0.1:8188`。
- 状态里保留了 1 个示例工作流「示例：官方 txt2img」和 3 条验收运行记录（`live-1/2/3`，对应图片是验收用的渐变占位图，可忽略/删除）。要彻底清空：关闭 DSH 后删除 `$DSH_HOME/sendcomfy/state.json` 再启动。
- 测试：`node --test test/*.test.mjs` 共 7 个测试文件、127 个用例全绿。
- 验收边界：本会话没有浏览器控制，**面板视觉（间距/亮暗主题/窄屏）未由 Agent 截图验证**，需使用者实际看一眼；交互与数据链路已通过上面那轮真实 HTTP 端到端验证。

## 工作流由 AI 自己选（2026-11-17）

用户在会话里只说「想要什么」即可，不需要先挑工作流、也不需要报工作流名：

- 每个工作流都有**自动能力画像**（`lib/capabilities.mjs`）：文生图 / 图生图 / 局部重绘 / 放大 / ControlNet / LoRA / 视频 / 音频，
  支持正负提示词与否、运行前需要先上传哪些文件（`neededInputs`）、输出什么，以及一句中文说明。
- 新增两个 Agent 工具：
  - `comfy_choose_workflow({ task, includeServer?, limit? })`：按任务描述给「已保存工作流」+「ComfyUI 服务器上的工作流」打分排序，
    返回候选、匹配原因、需要准备的输入、下一步怎么调；模型据此自己挑一个。
  - `comfy_describe_workflow({ workflow, description?, tags? })`：给工作流登记/修改「用途说明 + 标签」，让以后选型更准。
- 面板里也能看到能力 chips 与说明，并且可以编辑「用途说明 / 标签」（保存到 `state.json` 的 `description` / `tags`）。
- `comfy_run` 的 `workflow` 找不到时，错误信息会提示先调 `comfy_choose_workflow`。

选型打分是确定性的（名称/说明/标签/能力/节点类/模型名 + 中文意图词），不依赖额外模型调用；工作流为空时返回带提示的 `ok:false`。

## v0.3.0 UI 改版（2026-11-18）

- **顶部页签**代替四块卡片长列表：工作流 / 模型 / 记录 / 连接；打开时按状态自动落到合适页签（未配置地址 → 连接）。
- 工作流页：主操作「导入工作流」升级为品牌色主按钮；空列表时给图标 + 说明 + 两个导入入口（本地 JSON / 从 ComfyUI 服务器）。
- 模型页：新增搜索框，输入即过滤（自动展开命中的分类）；未连接时给「去配置连接」按钮。
- 连接页：配置表单 + 测试结果集中在一页；页签上不再堆所有内容，面板更短。
- 版本号在副标题右侧显示（当前 v0.3.0），方便确认页面是否已加载最新前端。

## v0.4.0「不导入」模式（2026-11-20）

按需求调整：**不再要求先把工作流导入插件**。

- **查看**：面板「工作流」页直接列出 ComfyUI 服务器上的工作流（`GET /userdata`），AI 用 `comfy_workflows` 看到的也是同一份服务器清单；本地已保存的旧工作流会作为兼容项保留，但不再是主路径。
- **使用**：面板点任意工作流即可打开详情（参数/提示词/能力按需加载），点「运行」时 Host 才 `GET /userdata/{file}` 读取 JSON 并当场入队（use 时先加载再运行）。
- **AI**：`comfy_workflows` 拿服务器清单 → `comfy_workflow({"workflow":"<path>"})` 看参数 → `comfy_run({"workflow":"<path>", ...})` 直接运行；`comfy_choose_workflow` 返回的服务器候选也会提示「直接 comfy_run(path)，无需导入」。
- 新增只读接口 `GET /api/sendcomfy/server-workflows/detail?path=...`（返回解析后的参数/提示词目标/能力，不写磁盘）。
- 面板「工作流」页：服务器清单 + 搜索（名称/路径）+「使用」入口；未配置 ComfyUI 时直接引导到连接页；详情页可复制路径。
- `comfy_server_workflows` 的导入能力保留，仅作兼容；平时不需要。

### v0.4.0 补丁：服务器优先选型

- `comfy_choose_workflow` 默认**只从 ComfyUI 服务器工作流里选**（`includeLocal` 默认 false）；本地旧库存仅在服务器不可用时兜底，或在显式 `includeLocal=true` 时参与。
- 服务器候选按**文件名/目录猜能力**（视频/音频/放大/图生图/重绘/ControlNet/LoRA/文生图），用于匹配任务意图；并加入降权规则：
  任务没要视频/音频却带这些能力的候选重罚（避免「视频流」抢「单图放大」）、能力越杂越降权、名称含「示例/测试/demo」降权。
- 候选的 `next` 按能力区分：文生图直接 `comfy_run(path)`；img2img/inpaint/upscale/video/audio 会提示先 `comfy_workflow` 看 `neededInputs`（可能要先 `comfy_upload_image`）。
- 本地存量未参与选型时会在 `warnings` 说明；详情返回顶层 `hasPrompt` / `hasNegative`。

## v0.4.1 修复：面板内容区不支持滚动

- 问题：工作流/模型列表很长、或窗口变矮时，面板底部内容被裁掉且无法滚动。
- 修复：面板根节点限高 `height:100% / max-height:100dvh` 并 `overflow:hidden`；内容区改为 `flex:1` + `max-height:calc(100dvh - 150px)` + `overflow-y:auto`，标题栏和页签固定、只有内容滚动（`overscroll-behavior:contain`）。
- 详细功能说明见 [FEATURES.zh.md](FEATURES.zh.md)。

## v0.4.2：bypass 全支持 + 工作流读取兼容

- **bypass（mode=4）全类型透传**：按「下游输入类型 → 输出槽类型」匹配，支持 `IMAGE,MASK` 这类宽类型与 `*` 通配、多输出节点（MODEL/CLIP/VAE 各自回连同类型输入）、链式 bypass、多个同类型输入时按名字优先；找不到可透传输入时按 ComfyUI 语义视为该输出无数据，并只在**必填输入**上给出明确 warning。
- **gzip 工作流读取**：ComfyUI 目录里 gzip 存储、或「gzip 前缀 + 明文后缀」的半损坏文件（如 `▶flux-2-klein-图生图洗图流.json`）现在都能还原并运行。
- **文件名含字面 `%20`**（如 `moss/Character%20Studio%20-%20Reference.json`）：兼容 ComfyUI `user_manager` 的二次 unquote，不再 404。
- 实测：服务器上 **126/126 个工作流全部可转换**（74 个含 bypass）。

## v0.5.0：新版 Subgraph（子图）支持

- 转换器现在会展开 ComfyUI 新版子图（`definitions.subgraphs`）：
  - 子图实例替换为内部真实节点，节点 id 用 `实例路径:内部id`（与 ComfyUI 执行 id 一致，如 `75:68`）；
  - 跨子图边界的输入/输出（虚拟端口 `-10` / `-20`）自动解析成直连；
  - 未连接外链的提升输入使用实例 `widgets_values` 的默认值（按 `properties.proxyWidgets` 对齐，缺失时按 inputs 的 widget 元数据兜底）；
  - 支持嵌套子图（带环检测）、bypass（mode=4）/静音（mode=2）的子图实例（按同类型输入透传）；
  - 子图定义缺失、循环引用会给出明确 warning，不再直接报「暂不支持子图」。
- 实测：服务器上 3 个子图工作流全部正确展开（FLUX.2 Klein 官方模板、千问2.1 整合、Z-Image 角色三视图），127/127 个工作流转换成功、0 个未解析子图输入。

### v0.5.0 补丁：提示词经连线转接

- 子图官方模板里常见 `CLIPTextEncode.text` 由子图外的 `PrimitiveStringMultiline` 提供（prompt 不是一个 widget 值而是连线）。转换器现在会沿 guider/sampler 的 `positive`/`negative` 输入反向追溯，把上游真正承载字符串的参数（如 `76.value`）登记为提示词目标，`comfy_run` 的 `prompt`/`negativePrompt` 可以正确注入。
