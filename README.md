# dsh-sendcomfy

[![npm](https://img.shields.io/npm/v/dsh-sendcomfy.svg)](https://www.npmjs.com/package/dsh-sendcomfy)
[![tag](https://img.shields.io/github/v/tag/catodm/dsh-sendcomfy?label=dsh-plugin)](https://github.com/catodm/dsh-sendcomfy/releases)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](#许可)

**ComfyUI ↔ DeepSeek Harness（DSH）插件。** 在 DSH 侧边栏配置 ComfyUI 地址，直接浏览 ComfyUI 服务器上的工作流和模型；会话里的文本模型也能自己选工作流、填提示词、调参数、出图 —— **不需要导入工作流**。

---

## 为什么是「不导入」

传统做法要先把 ComfyUI 的工作流 JSON 拷进插件，再挑、再好同步。这个插件反过来：

- **看**：面板直接列 ComfyUI 服务器上已保存的工作流（`userdata/workflows`）与模型；
- **用**：选一条 → 调参数 → 运行；**运行前那一刻才从 ComfyUI 读取最新 JSON**；
- **AI 用**：`comfy_choose_workflow` 服务器优先选型 → `comfy_workflow(path)` 看参数 → `comfy_run({"workflow":"<path>"})` 直接跑。

服务器上是哪一版，跑的就是哪一版，没有同步问题。

---

## 安装

### 方式一：npm（推荐）

```bash
npm i -g dsh-sendcomfy        # 或 npm i dsh-sendcomfy（装到你自己的项目里）
```

然后在 DSH 里把它装成 bundle：

```
plugin_manager { action: "install_bundle", target: "dsh-sendcomfy" }
```

### 方式二：npx（不落盘试用）

```bash
npx dsh-sendcomfy setup        # 检查环境 & 打印安装指令
```

### 方式三：从源码 / GitHub

```bash
git clone https://github.com/catodm/dsh-sendcomfy.git
```

```
plugin_manager { action: "install_bundle", target: "<克隆目录绝对路径>" }
```

安装后：DSH 侧边栏出现 **ComfyUI 桥接** 图标 →「连接」页填 `127.0.0.1:8188` 或 `192.168.x.x:8188` →「保存并测试」。

> 要求：DSH（`@deepseek-ai/dsh`）已安装并运行；Node ≥ 22；ComfyUI 可从 DSH 所在机器访问。

---

## 面板

| 页签 | 能做什么 |
|---|---|
| **工作流** | 列出 ComfyUI 服务器工作流（名称/路径/大小/时间），可搜索；点开即加载参数表单、正负提示词、能力标签、需要的输入文件、运行与结果图片 |
| **模型** | 按 checkpoints / LoRAs / VAE / CLIP / UNET / ControlNet … 分类列出，可搜索、点击复制模型名 |
| **记录** | 最近 20 次运行（状态、耗时、缩略图、错误） |
| **连接** | ComfyUI 地址 + 超时 + 保存并测试（显示延迟、版本、设备） |

---

## AI 工具

会话里的文本模型可直接调用 12 个工具：

| 工具 | 用途 |
|---|---|
| `comfy_status` | 配置与连通性、模型计数、最近运行 |
| `comfy_workflows` | **列出 ComfyUI 服务器上的工作流**（主入口，不需要导入） |
| `comfy_workflow` | 按 path 或本地 id 看参数/提示词目标/能力 |
| `comfy_choose_workflow` | **AI 自主选型**（服务器优先，按文件名/目录猜能力并打分） |
| `comfy_run` | 运行；`workflow` 传服务器 path 时自动加载，支持 `prompt` / `negativePrompt` / `params` |
| `comfy_result` | 按 promptId 轮询结果 |
| `comfy_cancel` | 中断/清队列 |
| `comfy_upload_image` | 把工作区图片上传到 ComfyUI input（img2img / 图生视频） |
| `comfy_models` | 模型清单 |
| `comfy_import_workflow` / `comfy_server_workflows` / `comfy_describe_workflow` | 兼容旧用法的本地库能力，平时用不到 |

典型对话：

> 「用 ComfyUI 把这张图放大 4 倍」
> 「画一只赛博朋克风格的猫，步数 20」

AI 会自己 `comfy_choose_workflow` → `comfy_workflow` → `comfy_run`，并把图片存到会话工作区 `comfy-output/`。

---

## 工作流兼容性

- **新版 Subgraph（子图）**：自动展开（支持嵌套、提升输入默认值、bypass/静音实例）；
- **bypass（mode=4）**：按「下游输入类型 → 输出槽类型」全类型透传（`IMAGE,MASK` 宽类型、`*` 通配、多输出、链式）；
- **静音（mode=2）**：按 ComfyUI 语义视为无输出；
- **Reroute / PrimitiveNode / Note**：正确穿透或跳过；
- **gzip 存储的工作流**、**文件名含字面 `%20`** 的路径：均可读取。

---

## 数据与文件

| 位置 | 内容 |
|---|---|
| `$DSH_HOME/sendcomfy/state.json` | ComfyUI 地址、超时、本地旧库存、运行记录 |
| `$DSH_HOME/sendcomfy/requests.log` | 面板请求诊断日志（滚动 1MB） |
| `<会话工作区>/comfy-output/<promptId前8位>/` | 输出图片 |

---

## 访问控制

`/api/sendcomfy/*` 能改配置、触发跑图、上传图片，所以每条请求先过准入检查再分发：

- 有 `connection` 服务时走 `connection.requestRejection({ headers })`：Host/Origin 栅栏（挡 DNS rebinding 与跨站调用）+ 浏览器登录态，与官方插件同一口径；
- 取不到 `connection` 时退回本机回环栅栏：`Host` 必须回环、`Origin` 必须同源、`Origin: null` 拒绝；
- 拒绝返回 401/403，请求体不解析、不触达业务层。

`engines.dsh` 声明为 `>=0.2.2-rc.5`（`requestRejection` 从该版本可用）。

---

## 开发

```bash
npm test                     # node:test，169 个用例
```

纯 ESM、零运行时依赖，只用 Node 内建 + 全局 `fetch`/`FormData`/`Blob`。

目录：

- `index.js` — Host 插件：12 个工具 + `/api/sendcomfy/*` 路由
- `client.js` — 面板（自注册 `window.__ModuleLoader__`，只用 `react` 与 DSH 主题 token）
- `lib/comfy.mjs` — ComfyUI HTTP 客户端
- `lib/workflow.mjs` — UI→API 转换、子图展开、bypass、参数推导
- `lib/capabilities.mjs` — 能力画像与选型打分
- `lib/state.mjs` / `lib/http.mjs` / `lib/actions.mjs` — 状态、HTTP 路由、业务层
- `CONTRACT.md` / `FEATURES.zh.md` — 契约与功能详解

---

## 许可

MIT
