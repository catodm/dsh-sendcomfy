/**
 * dsh-sendcomfy —— 浏览器半端（侧边栏图标 + 主栏 ComfyUI 面板）
 * ============================================================================
 * 自注册脚本（不是 ESM）：window.__ModuleLoader__.load({ id, factory(require) })，只 require('react')。
 * 注册两个入口（id/key 都是 'dsh-sendcomfy'）：
 *   - slots.inject('sidebar.panellist') —— 侧栏内联 SVG 图标（props: size / active）
 *   - slots.inject('main')              —— 主栏面板（root scope，无 Session 也能打开）
 * 所有数据走同源 /api/sendcomfy/*（CONTRACT §6），不直连 ComfyUI、不碰其他插件 DOM。
 * 文案全部走 ctx.locale（zh 默认 / en），缺 locale 服务时降级到内置 zh 字典。
 */
window.__ModuleLoader__.load({
  id: 'dsh-sendcomfy',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef } = React

    const NS = 'dsh-sendcomfy'
    const PANEL_ID = 'dsh-sendcomfy'
    const API = '/api/sendcomfy'
    const IMAGE_PATH = '/api/sendcomfy/image'
    const RUN_ROWS = 8
    const IMPORT_LIMIT_BYTES = 4 * 1024 * 1024

    /* ── locale 字典（key 至少覆盖 CONTRACT §7.3） ───────────────────────── */
    const ZH = {
      'panel.title': 'ComfyUI 桥接',
      'panel.subtitle': '配置 ComfyUI 服务器、浏览模型、导入并运行工作流',
      'common.refresh': '刷新',
      'common.retry': '重试',
      'common.cancel': '取消',
      'common.close': '关闭',
      'common.loading': '加载中…',
      'conn.title': '连接配置',
      'conn.url': 'ComfyUI 地址',
      'conn.urlHint': '可填 IP、IP:端口或 http URL；Host 会自动规范化（默认 127.0.0.1:8188）',
      'conn.timeout': '运行超时（秒）',
      'conn.timeoutHint': '留空使用默认 300；范围 5–3600',
      'conn.timeoutInvalid': '超时需为 5–3600 的整数秒',
      'conn.urlRequired': '请填写 ComfyUI 地址',
      'conn.saveTest': '保存并测试',
      'conn.saving': '保存中…',
      'conn.testing': '连接中…',
      'conn.connected': '已连接',
      'conn.disconnected': '未连接',
      'conn.unknown': '未检测',
      'conn.unconfigured': '未配置',
      'conn.unsaved': '有未保存修改',
      'conn.saved': '配置已保存',
      'conn.latency': '延迟',
      'conn.version': '版本',
      'conn.device': '设备',
      'conn.testFailed': '测试连接失败',
      'models.title': '模型库',
      'models.refresh': '刷新',
      'models.empty': 'ComfyUI 没有返回任何模型文件',
      'models.loading': '正在读取模型…',
      'models.error': '模型读取失败',
      'models.copy': '复制文件名',
      'models.copied': '已复制',
      'models.total': '共 {n} 个文件',
      'models.files': '{n} 个',
      'models.expand': '展开分类',
      'models.collapse': '收起分类',
      'wf.title': '工作流',
      'wf.import': '导入 JSON',
      'wf.importPlaceholder': '粘贴 ComfyUI 导出的工作流 JSON…',
      'wf.importFromFile': '选择 .json 文件',
      'wf.importName': '工作流名称（可选）',
      'wf.importNamePlaceholder': '留空时用文件名或自动命名',
      'wf.importDropHint': '也可以把 .json 文件拖到上面的输入框里。',
      'wf.importNeedJson': '请先粘贴工作流 JSON 或选择文件',
      'wf.importFileError': '文件读取失败',
      'wf.importFileTooBig': '文件过大（上限 4MB）',
      'wf.importing': '导入中…',
      'wf.importedAs': '已导入：{name}',
      'panel.version': 'v0.5.1',
      'tab.workflows': '工作流',
      'conn.configureCta': '去配置连接',
      'tab.models': '模型',
      'tab.runs': '记录',
      'tab.connection': '连接',
      'wf.emptyTitle': '还没有工作流',
      'wf.emptyHint': '导入一个 ComfyUI 工作流后，会话里的 AI 就能用它出图',
      'wf.importWorkflow': '导入工作流',
      'models.search': '搜索模型名…',
      'models.noMatch': '没有匹配的模型',
      'wf.serverHint': '先在「连接」页填好 ComfyUI 地址并保存，这里会直接列出 ComfyUI 服务器上的工作流，不需要导入。',
      'wf.serverEmptyTitle': 'ComfyUI 服务器上没有工作流',
      'wf.serverEmptyHint': '在 ComfyUI 里保存工作流（Workflows 面板）后，点刷新即可看到。',
      'wf.serverLoadError': '读取 ComfyUI 服务器工作流失败',
      'wf.searchServer': '搜索工作流名或路径…',
      'wf.serverCount': '共 {n} 个',
      'wf.use': '使用',
      'wf.useHint': '点击任意工作流即可打开并运行；运行时自动从 ComfyUI 加载，不需要导入。',
      'wf.serverNoMatch': '没有匹配的工作流',
      'wf.serverReadonly': '服务器工作流：每次运行前自动从 ComfyUI 加载（无需导入）。用途说明/标签只对本地库工作流可用。',
      'wf.copyPath': '复制路径',
      'wf.copiedPath': '已复制路径',
      'wf.importOk': '导入成功',
      'wf.importWarnings': '导入提示',
      'wf.capabilities': '能力',
      'wf.description': '用途说明（AI 选型会用）',
      'wf.descriptionHint': '一句话讲清什么时候该用它、需要什么输入、输出什么',
      'wf.tags': '标签',
      'wf.tagsHint': '用逗号分隔，最多 12 个',
      'wf.saveMeta': '保存说明',
      'wf.savedMeta': '已保存',
      'wf.metaInvalid': '说明 ≤500 字；标签 ≤12 个、每个 ≤40 字',
      'wf.needsInput': '需输入文件 {n}',
      'wf.needsInputTitle': '需要的输入文件',
      'common.save': '保存',
      'common.saving': '保存中…',
      'wf.kind.txt2img': '文生图',
      'wf.kind.img2img': '图生图',
      'wf.kind.inpaint': '局部重绘',
      'wf.kind.upscale': '放大',
      'wf.kind.controlnet': 'ControlNet',
      'wf.kind.lora': 'LoRA',
      'wf.kind.video': '视频',
      'wf.kind.audio': '音频',
      'wf.kind.other': '其他',
      'wf.fromServer': '从 ComfyUI 服务器导入',
      'wf.listEmpty': '还没有工作流，先导入一个 ComfyUI 的 JSON',
      'wf.open': '打开',
      'wf.rename': '重命名',
      'wf.renamePrompt': '新名称',
      'wf.renameSave': '保存',
      'wf.renameEmpty': '名称不能为空',
      'wf.renamedOk': '已重命名',
      'wf.deletedOk': '已删除',
      'wf.delete': '删除',
      'wf.deleteConfirm': '删除这个工作流？此操作不可撤销。',
      'wf.nodes': '{n} 个节点',
      'wf.params': '{n} 个参数',
      'wf.source': '来源',
      'wf.sourceUi': '网页导出',
      'wf.sourceApi': 'API 格式',
      'wf.sourceServer': '服务器',
      'wf.detailBack': '返回列表',
      'wf.prompt': '提示词',
      'wf.negativePrompt': '负向提示词',
      'wf.promptNone': '没有检测到提示词输入节点，可以直接在下方参数里编辑文本。',
      'wf.promptTargets': '目标',
      'wf.paramsTitle': '参数',
      'wf.paramsEmpty': '这个工作流没有可调参数',
      'wf.paramPath': '参数路径',
      'wf.nodesTitle': '节点摘要',
      'wf.run': '运行',
      'wf.running': '运行中…',
      'wf.resetDefaults': '重置为默认值',
      'wf.result': '运行结果',
      'wf.resultEmpty': '还没有运行结果',
      'wf.noImages': '本次运行没有输出图片',
      'wf.elapsed': '耗时 {v}',
      'wf.failed': '运行失败',
      'wf.nodeErrors': '节点错误',
      'wf.runWarnings': '运行提示',
      'wf.applied': '生效参数',
      'wf.promptId': '任务 ID',
      'wf.loading': '正在读取工作流…',
      'wf.loadError': '工作流详情读取失败',
      'wf.serverListTitle': '服务器上的工作流',
      'wf.serverLoading': '正在读取服务器工作流…',
      'wf.serverEmpty': '服务器上没有可导入的工作流',
      'wf.serverError': '读取服务器工作流失败',
      'wf.serverUnsupported': 'ComfyUI 未提供服务器工作流接口，可以改用粘贴 JSON 导入。',
      'runs.title': '运行记录',
      'runs.count': '最近 {n} 条',
      'runs.empty': '最近还没有运行过',
      'runs.stateQueued': '排队中',
      'runs.stateDone': '已完成',
      'runs.stateError': '失败',
      'runs.stateTimeout': '超时',
      'error.network': '网络请求失败，请确认 Host 正在运行',
      'error.http': '请求失败（HTTP {status}）',
      'error.timeout': '请求超时：ComfyUI 可能不可达；若导入的是很大的 JSON 请换小一点的文件',
    }

    const EN = {
      'panel.title': 'ComfyUI bridge',
      'panel.subtitle': 'Configure a ComfyUI server, browse its models, import and run workflows',
      'common.refresh': 'Refresh',
      'common.retry': 'Retry',
      'common.cancel': 'Cancel',
      'common.close': 'Close',
      'common.loading': 'Loading…',
      'conn.title': 'Connection',
      'conn.url': 'ComfyUI address',
      'conn.urlHint': 'IP, IP:port or an http URL; the Host normalizes it (default 127.0.0.1:8188)',
      'conn.timeout': 'Run timeout (seconds)',
      'conn.timeoutHint': 'Leave empty to use the default 300; range 5–3600',
      'conn.timeoutInvalid': 'Timeout must be an integer between 5 and 3600 seconds',
      'conn.urlRequired': 'Enter the ComfyUI address',
      'conn.saveTest': 'Save and test',
      'conn.saving': 'Saving…',
      'conn.testing': 'Connecting…',
      'conn.connected': 'Connected',
      'conn.disconnected': 'Disconnected',
      'conn.unknown': 'Not tested',
      'conn.unconfigured': 'Not configured',
      'conn.unsaved': 'Unsaved changes',
      'conn.saved': 'Configuration saved',
      'conn.latency': 'Latency',
      'conn.version': 'Version',
      'conn.device': 'Device',
      'conn.testFailed': 'Connection test failed',
      'models.title': 'Models',
      'models.refresh': 'Refresh',
      'models.empty': 'ComfyUI returned no model files',
      'models.loading': 'Loading models…',
      'models.error': 'Could not load models',
      'models.copy': 'Copy file name',
      'models.copied': 'Copied',
      'models.total': '{n} files in total',
      'models.files': '{n}',
      'models.expand': 'Expand category',
      'models.collapse': 'Collapse category',
      'wf.title': 'Workflows',
      'wf.import': 'Import JSON',
      'wf.importPlaceholder': 'Paste the workflow JSON exported by ComfyUI…',
      'wf.importFromFile': 'Choose a .json file',
      'wf.importName': 'Workflow name (optional)',
      'wf.importNamePlaceholder': 'Defaults to the file name or an automatic name',
      'wf.importDropHint': 'You can also drop a .json file onto the box above.',
      'wf.importNeedJson': 'Paste the workflow JSON or choose a file first',
      'wf.importFileError': 'Could not read the file',
      'wf.importFileTooBig': 'File is too large (4MB limit)',
      'wf.importing': 'Importing…',
      'wf.importedAs': 'Imported: {name}',
      'panel.version': 'v0.5.1',
      'tab.workflows': 'Workflows',
      'conn.configureCta': 'Configure connection',
      'tab.models': 'Models',
      'tab.runs': 'Runs',
      'tab.connection': 'Connection',
      'wf.emptyTitle': 'No workflows yet',
      'wf.emptyHint': 'Import a ComfyUI workflow so the session AI can run it',
      'wf.importWorkflow': 'Import workflow',
      'models.search': 'Search model names…',
      'models.noMatch': 'No matching models',
      'wf.serverHint': 'Set your ComfyUI address on the Connection tab first. Workflows stored on the server will be listed here — no import needed.',
      'wf.serverEmptyTitle': 'No workflows on the ComfyUI server',
      'wf.serverEmptyHint': 'Save a workflow in ComfyUI (Workflows panel), then hit Refresh.',
      'wf.serverLoadError': 'Failed to read server workflows',
      'wf.searchServer': 'Search workflow name or path…',
      'wf.serverCount': '{n} total',
      'wf.use': 'Use',
      'wf.useHint': 'Click a workflow to open and run it. It is loaded from ComfyUI on demand — no import step.',
      'wf.serverNoMatch': 'No matching workflows',
      'wf.serverReadonly': 'Server workflow: loaded from ComfyUI before every run (no import). Purpose notes/tags only apply to saved local workflows.',
      'wf.copyPath': 'Copy path',
      'wf.copiedPath': 'Path copied',
      'wf.importOk': 'Imported',
      'wf.importWarnings': 'Import notices',
      'wf.capabilities': 'Capabilities',
      'wf.description': 'Purpose note (used by the AI to pick workflows)',
      'wf.descriptionHint': 'One line: when to use it, what input it needs, what it outputs',
      'wf.tags': 'Tags',
      'wf.tagsHint': 'Comma-separated, up to 12',
      'wf.saveMeta': 'Save note',
      'wf.savedMeta': 'Saved',
      'wf.metaInvalid': 'Note ≤500 chars; tags ≤12, each ≤40 chars',
      'wf.needsInput': 'Needs {n} input file(s)',
      'wf.needsInputTitle': 'Required input files',
      'common.save': 'Save',
      'common.saving': 'Saving…',
      'wf.kind.txt2img': 'Text to image',
      'wf.kind.img2img': 'Image to image',
      'wf.kind.inpaint': 'Inpaint',
      'wf.kind.upscale': 'Upscale',
      'wf.kind.controlnet': 'ControlNet',
      'wf.kind.lora': 'LoRA',
      'wf.kind.video': 'Video',
      'wf.kind.audio': 'Audio',
      'wf.kind.other': 'Other',
      'wf.fromServer': 'Import from ComfyUI server',
      'wf.listEmpty': 'No workflows yet. Import a ComfyUI JSON to start.',
      'wf.open': 'Open',
      'wf.rename': 'Rename',
      'wf.renamePrompt': 'New name',
      'wf.renameSave': 'Save',
      'wf.renameEmpty': 'Name cannot be empty',
      'wf.renamedOk': 'Renamed',
      'wf.deletedOk': 'Deleted',
      'wf.delete': 'Delete',
      'wf.deleteConfirm': 'Delete this workflow? This cannot be undone.',
      'wf.nodes': '{n} nodes',
      'wf.params': '{n} parameters',
      'wf.source': 'Source',
      'wf.sourceUi': 'UI export',
      'wf.sourceApi': 'API format',
      'wf.sourceServer': 'Server',
      'wf.detailBack': 'Back to list',
      'wf.prompt': 'Prompt',
      'wf.negativePrompt': 'Negative prompt',
      'wf.promptNone': 'No prompt input node was detected; edit the text in the parameters below.',
      'wf.promptTargets': 'Target',
      'wf.paramsTitle': 'Parameters',
      'wf.paramsEmpty': 'This workflow has no editable parameters',
      'wf.paramPath': 'Parameter path',
      'wf.nodesTitle': 'Node summary',
      'wf.run': 'Run',
      'wf.running': 'Running…',
      'wf.resetDefaults': 'Reset to defaults',
      'wf.result': 'Result',
      'wf.resultEmpty': 'No result yet',
      'wf.noImages': 'This run produced no images',
      'wf.elapsed': 'Elapsed {v}',
      'wf.failed': 'Run failed',
      'wf.nodeErrors': 'Node errors',
      'wf.runWarnings': 'Run notices',
      'wf.applied': 'Applied overrides',
      'wf.promptId': 'Prompt ID',
      'wf.loading': 'Loading workflow…',
      'wf.loadError': 'Could not load the workflow',
      'wf.serverListTitle': 'Workflows on the server',
      'wf.serverLoading': 'Loading server workflows…',
      'wf.serverEmpty': 'The server has no importable workflows',
      'wf.serverError': 'Could not load server workflows',
      'wf.serverUnsupported': 'ComfyUI does not expose the server workflow API; paste the JSON instead.',
      'runs.title': 'Run history',
      'runs.count': 'latest {n}',
      'runs.empty': 'No runs yet',
      'runs.stateQueued': 'Queued',
      'runs.stateDone': 'Done',
      'runs.stateError': 'Failed',
      'runs.stateTimeout': 'Timed out',
      'error.network': 'Network request failed; check that the Host is running',
      'error.http': 'Request failed (HTTP {status})',
      'error.timeout': 'Request timed out: ComfyUI may be unreachable (or the JSON is very large)',
    }

    /* ── 样式：只用 DSH 主题 token（--dsw-alias-* / --dsw-radius-* / --dsw-focus-ring-*） ── */
    const CSS = `
.sc-page{
  box-sizing:border-box;height:100%;max-height:100vh;max-height:100dvh;min-height:0;
  display:flex;flex-direction:column;overflow:hidden;position:relative;
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
  font-size:13px;line-height:20px;--sc-pad:clamp(20px,4vw,48px);
}
.sc-page,.sc-page *,.sc-page *::before,.sc-page *::after{box-sizing:border-box}

/* 顶部固定标题栏 */
.sc-head{flex:none;display:flex;flex-wrap:wrap;align-items:flex-start;gap:10px 16px;width:100%;
  max-width:calc(960px + 2 * var(--sc-pad));margin:0 auto;padding:20px var(--sc-pad) 12px}
.sc-titleGroup{flex:1 1 260px;min-width:0;display:flex;flex-direction:column;gap:2px}
.sc-title{margin:0;font-size:20px;font-weight:500;line-height:28px;overflow-wrap:anywhere}
.sc-sub{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;overflow-wrap:anywhere}
.sc-headActions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-left:auto;flex:none;max-width:100%}
.sc-headError{flex-basis:100%;margin:2px 0 0}

/* 可滚动主区 */
.sc-scroll{flex:1 1 auto;min-height:120px;max-height:calc(100vh - 150px);max-height:calc(100dvh - 150px);
  overflow-y:auto;overscroll-behavior:contain;width:100%;padding:16px var(--sc-pad) 48px;
  display:flex;flex-direction:column;align-items:center;gap:16px;
  scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2) transparent}

/* 卡片 */
.sc-card{width:100%;max-width:960px;min-width:0;overflow:hidden;
  border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-xl);
  background:var(--dsw-alias-bg-layer-2)}
.sc-cardHead{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;min-width:0;
  padding:12px 16px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.sc-cardTitle{display:flex;align-items:center;gap:8px;margin:0;min-width:0;
  font-size:14px;font-weight:500;line-height:22px}
.sc-cardTitle>svg{flex:none;color:var(--dsw-alias-label-secondary)}
.sc-cardTitleText{min-width:0;overflow-wrap:anywhere}
.sc-cardCount{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;
  font-variant-numeric:tabular-nums}
.sc-cardActions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-left:auto;min-width:0}
.sc-cardBody{display:flex;flex-direction:column;gap:14px;padding:16px;min-width:0}

/* 顶部页签（连接 / 工作流 / 模型 / 记录） */
.sc-tabs{flex:none;width:100%;border-bottom:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
.sc-tabsInner{display:flex;flex-wrap:wrap;gap:2px;width:100%;
  max-width:calc(960px + 2 * var(--sc-pad));margin:0 auto;padding:0 var(--sc-pad)}
.sc-tab{display:inline-flex;align-items:center;gap:6px;height:38px;padding:0 10px;border:0;
  border-bottom:2px solid transparent;margin-bottom:-.5px;background:transparent;
  color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;
  white-space:nowrap;cursor:pointer;transition:color .12s ease,border-color .12s ease}
.sc-tab>svg{flex:none;color:currentColor;opacity:.85}
.sc-tab:hover{color:var(--dsw-alias-label-primary)}
.sc-tab[aria-selected="true"]{color:var(--dsw-alias-label-primary);
  border-bottom-color:var(--dsw-alias-state-business-primary);font-weight:500}
.sc-tab:focus-visible{outline:var(--dsw-focus-ring-width,1px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));
  outline-offset:-2px;border-radius:var(--dsw-radius-sm)}
.sc-tabCount{flex:none;min-width:16px;height:16px;padding:0 5px;border-radius:999px;
  background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary);
  font-size:10.5px;line-height:16px;text-align:center;font-variant-numeric:tabular-nums}

/* 空状态 */
.sc-emptyState{display:flex;flex-direction:column;align-items:center;gap:6px;
  padding:36px 16px;text-align:center;min-width:0}
.sc-emptyIcon{width:44px;height:44px;border-radius:50%;display:flex;align-items:center;
  justify-content:center;background:var(--dsw-alias-bg-layer-1);
  border:.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);margin-bottom:2px}
.sc-emptyTitle{margin:0;font-size:14px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary)}
.sc-emptyHint{margin:0;max-width:420px;font-size:12px;line-height:19px;color:var(--dsw-alias-label-tertiary)}
.sc-emptyActions{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin-top:8px}

/* 模型搜索栏 */
.sc-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}
.sc-search{flex:1 1 220px;min-width:160px}

/* 服务器工作流列表（不导入，点击打开） */
.sc-serverWfList{display:flex;flex-direction:column;gap:6px;min-width:0}
.sc-serverWfRow{display:flex;align-items:center;gap:10px;width:100%;min-width:0;
  padding:10px 12px;border:.5px solid var(--dsw-alias-border-l1);
  border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer;
  transition:background-color .12s ease,border-color .12s ease}
.sc-serverWfRow:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2)}
.sc-serverWfRow:focus-visible{outline:var(--dsw-focus-ring-width,1px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));
  outline-offset:-1px}
.sc-serverWfLead{flex:none;display:flex;color:var(--dsw-alias-label-secondary)}
.sc-serverWfMain{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}
.sc-serverWfName{font-size:13px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sc-serverWfPath{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sc-serverWfUse{flex:none;display:inline-flex;align-items:center;gap:2px;
  color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.sc-serverWfRow:hover .sc-serverWfUse{color:var(--dsw-alias-label-primary)}

/* 按钮 */
.sc-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;flex:none;
  height:32px;padding:0 12px;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l4);
  background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;
  white-space:nowrap;cursor:pointer;transition:background-color .12s ease,color .12s ease,border-color .12s ease}
.sc-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.sc-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}
.sc-btn:disabled{opacity:.5;cursor:default}
.sc-btnPrimary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;
  color:var(--dsw-alias-label-primary-foreground)}
.sc-btnPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.sc-btnPrimary:active:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.sc-btnDanger{color:var(--dsw-alias-state-error-primary)}
.sc-btnDanger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger,var(--dsw-alias-interactive-bg-hover))}
.sc-iconBtn{display:inline-flex;align-items:center;justify-content:center;flex:none;
  width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm);
  background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.sc-iconBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.sc-iconBtn:disabled{opacity:.5;cursor:default}
.sc-linkBtn{padding:0;border:0;background:none;font:inherit;font-size:12px;line-height:18px;
  color:var(--dsw-alias-link);text-decoration:underline;text-underline-offset:2px;cursor:pointer}
.sc-page button:focus-visible,.sc-page summary:focus-visible{
  outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));
  outline-offset:1px}
.sc-btnRow{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}

/* 表单 */
.sc-field{display:flex;flex-wrap:wrap;align-items:flex-start;gap:6px 12px;min-width:0}
.sc-fieldLabel{flex:0 0 auto;min-width:96px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:32px}
.sc-fieldCtl{display:flex;flex-direction:column;gap:5px;flex:1 1 240px;min-width:0}
.sc-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.sc-input,.sc-textarea,.sc-select{width:100%;min-width:0;border:.5px solid var(--dsw-alias-border-l4);
  border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);
  color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}
.sc-input,.sc-select{height:32px;padding:0 10px}
.sc-inputShort{width:140px;max-width:100%}
.sc-textarea{min-height:72px;padding:8px 10px;line-height:20px;resize:vertical}
.sc-input::placeholder,.sc-textarea::placeholder{color:var(--dsw-alias-label-tertiary)}
.sc-input:focus,.sc-textarea:focus,.sc-select:focus{
  border-color:var(--dsw-alias-state-business-primary);
  box-shadow:inset 0 0 0 .5px var(--dsw-alias-state-business-primary)}
.sc-input[aria-invalid="true"]{border-color:var(--dsw-alias-state-error-primary);box-shadow:none}
.sc-selectWrap{position:relative;display:flex;min-width:0;flex:1 1 auto}
.sc-select{appearance:none;-webkit-appearance:none;padding-right:28px}
.sc-selectWrap::after{content:"";position:absolute;right:10px;top:50%;margin-top:-2px;width:0;height:0;
  border-left:4px solid transparent;border-right:4px solid transparent;
  border-top:5px solid var(--dsw-alias-label-secondary);pointer-events:none}
.sc-dropActive{border-color:var(--dsw-alias-state-business-primary);
  box-shadow:inset 0 0 0 .5px var(--dsw-alias-state-business-primary)}
.sc-srOnly{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
  clip:rect(0 0 0 0);white-space:nowrap;border:0}
.sc-fileLabel{position:relative;cursor:pointer}
.sc-fileLabel:focus-within{
  outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));
  outline-offset:1px}
.sc-stack{display:flex;flex-direction:column;gap:6px;min-width:0}

/* 状态 pill / 提示行 */
.sc-pill{display:inline-flex;align-items:center;gap:6px;flex:none;height:22px;padding:0 8px;
  border:.5px solid var(--dsw-alias-border-l3);border-radius:999px;color:var(--dsw-alias-label-secondary);
  font-size:12px;line-height:18px;white-space:nowrap}
.sc-pill[data-tone="ok"]{color:var(--dsw-alias-state-success-primary)}
.sc-pill[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}
.sc-pill[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary)}
.sc-pill[data-tone="busy"]{color:var(--dsw-alias-state-business-primary)}
.sc-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-caption)}
.sc-dot[data-tone="ok"]{background:var(--dsw-alias-state-success-primary)}
.sc-dot[data-tone="error"]{background:var(--dsw-alias-state-error-primary)}
.sc-dot[data-tone="warn"]{background:var(--dsw-alias-state-warn-primary)}
.sc-dot[data-tone="busy"]{background:var(--dsw-alias-state-business-primary)}
.sc-errorLine{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0;
  color:var(--dsw-alias-state-error-primary);font-size:12.5px;line-height:18px}
.sc-errorText{min-width:0;overflow-wrap:anywhere}
.sc-okLine{margin:0;color:var(--dsw-alias-state-success-primary);font-size:12.5px;line-height:18px;overflow-wrap:anywhere}
.sc-warnLine{margin:0;color:var(--dsw-alias-state-warn-primary);font-size:12.5px;line-height:18px;overflow-wrap:anywhere}
.sc-muted{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12.5px;line-height:18px;overflow-wrap:anywhere}
.sc-empty{margin:0;padding:4px 0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;text-align:center}
.sc-noteList{margin:0;padding-left:16px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-primary);overflow-wrap:anywhere}
.sc-noteTitle{font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-state-warn-primary)}
.sc-loadingRow{display:flex;flex-wrap:wrap;align-items:center;gap:8px;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.sc-loading{display:flex;align-items:center;justify-content:center;gap:8px;padding:36px 0;
  color:var(--dsw-alias-label-tertiary);font-size:13px}
.sc-errorBox{display:flex;flex-direction:column;align-items:flex-start;gap:12px;padding:20px 16px}
.sc-spinner{flex:none;width:12px;height:12px;border-radius:50%;
  border:1.5px solid var(--dsw-alias-border-l3);border-top-color:var(--dsw-alias-state-business-primary);
  animation:sc-spin .8s linear infinite;display:inline-block}
@keyframes sc-spin{to{transform:rotate(360deg)}}

/* 测试结果事实行 */
.sc-facts{display:flex;flex-wrap:wrap;align-items:center;gap:6px 16px;min-width:0}
.sc-fact{display:inline-flex;align-items:center;gap:6px;min-width:0;color:var(--dsw-alias-label-secondary);
  font-size:12.5px;line-height:18px}
.sc-factLabel{color:var(--dsw-alias-label-tertiary)}
.sc-factValue{min-width:0;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
.sc-fact code{font-size:11.5px;background:var(--dsw-alias-bg-layer-3);border-radius:var(--dsw-radius-xs);
  color:var(--dsw-alias-label-secondary);padding:1px 5px}

/* 模型分类 / 文件名 */
.sc-catList{display:flex;flex-direction:column;min-width:0}
.sc-cat{border-bottom:.5px solid var(--dsw-alias-border-l2);min-width:0}
.sc-cat:last-child{border-bottom:0}
.sc-catHead{display:flex;align-items:center;gap:8px;width:100%;min-width:0;padding:9px 0;
  border:0;background:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;
  line-height:20px;text-align:left;cursor:pointer}
.sc-chev{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .15s ease}
.sc-catLabel{flex:1;min-width:0;font-weight:500;overflow-wrap:anywhere}
.sc-catCount{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.sc-files{display:flex;flex-wrap:wrap;gap:6px;padding:0 0 10px;min-width:0}
.sc-file{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:min(100%,420px);
  height:26px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font:inherit;
  font-size:12px;line-height:18px;text-align:left;cursor:pointer}
.sc-file:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3)}
.sc-file>.sc-fileName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.sc-fileCopied{flex:none;color:var(--dsw-alias-state-success-primary);font-size:11.5px}
.sc-fileDone{color:var(--dsw-alias-state-success-primary)}

/* 工作流列表 */
.sc-wfList{display:flex;flex-direction:column;min-width:0}
.sc-wfRow{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;min-width:0;
  padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.sc-wfRow:last-child{border-bottom:0;padding-bottom:0}
.sc-wfMain{display:flex;flex-direction:column;gap:3px;flex:1 1 240px;min-width:0}
.sc-wfNameBtn{padding:0;border:0;background:none;font:inherit;font-size:14px;font-weight:500;
  line-height:20px;color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer;
  overflow-wrap:anywhere;max-width:100%}
.sc-wfNameBtn:hover{text-decoration:underline;text-underline-offset:3px}
.sc-wfMeta{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;min-width:0;
  color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.sc-metaTime{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.sc-wfDescRow{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;min-width:0;width:100%;margin-top:2px}
.sc-subRow{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 10px;min-width:0}
.sc-version{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);
  border:0.5px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 6px}
.sc-kindChips{display:inline-flex;flex-wrap:wrap;align-items:center;gap:4px;min-width:0}
.sc-kindChip{display:inline-flex;align-items:center;padding:0 6px;height:18px;border-radius:var(--dsw-radius-sm,8px);
  border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;white-space:nowrap}
.sc-wfDesc{flex:1 1 120px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.sc-needBadge{flex:none;display:inline-flex;align-items:center;padding:0 6px;height:18px;border-radius:var(--dsw-radius-sm,8px);
  border:0.5px solid var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);
  font-size:11px;line-height:16px;white-space:nowrap}
.sc-needList{display:flex;flex-direction:column;gap:4px;margin-top:4px}
.sc-needRow{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 8px;min-width:0;font-size:12px;line-height:18px}
.sc-needPath{flex:none;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;
  color:var(--dsw-alias-label-secondary)}
.sc-needLabel{flex:none;color:var(--dsw-alias-label-primary)}
.sc-needHint{flex:1 1 180px;min-width:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px;overflow-wrap:anywhere}
.sc-wfActions{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-left:auto}
.sc-renameRow{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}
.sc-renameRow>.sc-input{flex:1 1 160px}
.sc-badge{display:inline-flex;align-items:center;flex:none;height:20px;padding:0 6px;
  border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);
  color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px;white-space:nowrap}

/* 导入 / 服务器工作流 */
.sc-import{display:flex;flex-direction:column;gap:12px;min-width:0;padding:12px;
  border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);
  background:var(--dsw-alias-bg-layer-1)}
.sc-serverList{display:flex;flex-direction:column;min-width:0;max-height:260px;overflow-y:auto;
  padding:0 10px;border:.5px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3)}
.sc-serverRow{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;min-width:0;
  padding:8px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.sc-serverRow:last-child{border-bottom:0}
.sc-serverMain{display:flex;flex-direction:column;gap:2px;flex:1 1 200px;min-width:0}
.sc-serverName{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.sc-serverPath{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.sc-warnBox{display:flex;flex-direction:column;gap:4px;min-width:0;padding:8px 10px;
  border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);
  background:var(--dsw-alias-bg-layer-1)}

/* 提示词 / 参数 */
.sc-promptGroup{display:flex;flex-direction:column;gap:12px;min-width:0}
.sc-promptBlock{display:flex;flex-direction:column;gap:5px;min-width:0}
.sc-promptHead{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;min-width:0}
.sc-promptLabel{font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary)}
.sc-promptHead .sc-chipRow{margin-left:auto}
.sc-chipRow{display:flex;flex-wrap:wrap;gap:4px;min-width:0}
.sc-chip{display:inline-flex;align-items:center;max-width:100%;height:20px;padding:0 6px;
  border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-3);
  color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:18px;
  font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.sc-section{display:flex;flex-direction:column;gap:8px;min-width:0;padding-top:12px;
  border-top:.5px solid var(--dsw-alias-border-l2)}
.sc-sectionHead{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;min-width:0}
.sc-sectionTitle{font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary)}
.sc-params{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(260px,100%),1fr));gap:12px 16px;min-width:0}
.sc-param{display:flex;flex-direction:column;gap:4px;min-width:0}
.sc-paramHead{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 8px;min-width:0}
.sc-paramLabel{min-width:0;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.sc-paramPath{min-width:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);
  font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.sc-paramCtl{display:flex;align-items:center;gap:8px;min-width:0}
.sc-switch{position:relative;display:inline-flex;align-items:center;flex:none;width:34px;height:20px;
  padding:0;border:.5px solid var(--dsw-alias-border-l3);border-radius:999px;
  background:var(--dsw-alias-bg-module-platform);cursor:pointer;transition:background-color .15s ease,border-color .15s ease}
.sc-switch::after{content:"";position:absolute;left:2px;top:2px;width:14px;height:14px;border-radius:50%;
  background:var(--dsw-alias-switch-thumb);transition:transform .15s ease}
.sc-switch[aria-checked="true"]{background:var(--dsw-alias-state-business-primary);border-color:transparent}
.sc-switch[aria-checked="true"]::after{transform:translateX(14px)}
.sc-switch:disabled{opacity:.5;cursor:default}

/* 节点摘要 */
.sc-details{border-top:.5px solid var(--dsw-alias-border-l2);padding-top:10px;min-width:0}
.sc-detailsSummary{cursor:pointer;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.sc-detailsSummary:hover{color:var(--dsw-alias-label-primary)}
.sc-nodeList{display:flex;flex-direction:column;gap:2px;margin:8px 0 0;padding:0;list-style:none;
  max-height:220px;overflow-y:auto;font-size:12px;line-height:18px}
.sc-nodeItem{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 8px;min-width:0;color:var(--dsw-alias-label-secondary)}
.sc-nodeId{flex:none;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.sc-nodeClass{min-width:0;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.sc-nodeTitle{min-width:0;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}

/* 运行 / 结果 */
.sc-runBar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0;padding-top:12px;
  border-top:.5px solid var(--dsw-alias-border-l2)}
.sc-runInfo{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;
  font-variant-numeric:tabular-nums}
.sc-result{display:flex;flex-direction:column;gap:10px;min-width:0;padding-top:12px;
  border-top:.5px solid var(--dsw-alias-border-l2)}
.sc-resultHead{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:13px;font-weight:500;line-height:20px}
.sc-applied{display:flex;flex-direction:column;gap:6px;min-width:0}
.sc-nodeErrors{display:flex;flex-direction:column;gap:4px;min-width:0;padding:8px 10px;
  border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);
  background:var(--dsw-alias-bg-layer-1)}
.sc-images{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(150px,100%),1fr));gap:8px;min-width:0}
.sc-imageBtn{display:block;min-width:0;padding:0;cursor:zoom-in;overflow:hidden;
  border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);
  background:var(--dsw-alias-bg-layer-3)}
.sc-image{display:block;width:100%;height:auto}
.sc-runList{display:flex;flex-direction:column;min-width:0}
.sc-runRow{display:flex;flex-wrap:wrap;align-items:flex-start;gap:8px 12px;min-width:0;
  padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.sc-runRow:last-child{border-bottom:0;padding-bottom:0}
.sc-runMain{display:flex;flex-direction:column;gap:3px;flex:1 1 200px;min-width:0}
.sc-runTitle{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.sc-runMeta{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;min-width:0;
  color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.sc-thumbRow{display:flex;flex-wrap:wrap;gap:6px;flex:none;max-width:100%}
.sc-thumbWrap{display:block;flex:none;width:44px;height:44px;padding:0;overflow:hidden;cursor:pointer;
  border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-bg-layer-3)}
.sc-thumb{display:block;width:100%;height:100%;object-fit:cover}

@media (max-width:560px){
  .sc-head{padding-top:20px;padding-bottom:10px}
  .sc-headActions{margin-left:0;width:100%}
  .sc-cardHead{padding:10px 12px}
  .sc-cardBody{padding:12px}
  .sc-fieldLabel{flex-basis:100%;min-width:0;line-height:20px}
  .sc-scroll{gap:12px}
}
@media (prefers-reduced-motion:reduce){
  .sc-btn,.sc-chev,.sc-switch,.sc-switch::after{transition:none}
  .sc-spinner{animation-duration:2.4s}
}
`

    /* ── 通用工具 ────────────────────────────────────────────────────────── */
    function fallbackT(key, params) {
      const table = ZH[key] !== undefined ? ZH : EN
      const template = table[key] !== undefined ? table[key] : key
      if (!params) return template
      return String(template).replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
    }

    function makeApiError(message, options) {
      const error = new Error(message || 'request failed')
      if (options) {
        if (options.status !== undefined) error.status = options.status
        if (options.code !== undefined) error.code = options.code
      }
      return error
    }

    /** 同源 JSON 请求：网络失败 / 非 2xx / json.ok===false 都抛结构化错误。 */
    async function api(path, options) {
      const opts = options || {}
      let response
      let timer = null
      const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 0
      const controller = timeoutMs > 0 && typeof AbortController === 'function' ? new AbortController() : null
      try {
        const init = { method: opts.method || 'GET', credentials: 'same-origin' }
        if (controller) {
          init.signal = controller.signal
          timer = setTimeout(() => controller.abort(), timeoutMs)
        }
        if (opts.body !== undefined) {
          init.headers = { 'content-type': 'application/json' }
          init.body = JSON.stringify(opts.body)
        }
        response = await fetch(API + path, init)
      } catch (cause) {
        if (controller && controller.signal.aborted) {
          throw makeApiError('', { code: 'TIMEOUT', status: 0 })
        }
        throw makeApiError('network', { code: 'NET' })
      } finally {
        if (timer !== null) clearTimeout(timer)
      }
      let text = ''
      try {
        text = await response.text()
      } catch (cause) {
        throw makeApiError('network', { code: 'NET' })
      }
      let data = null
      if (text) {
        try {
          data = JSON.parse(text)
        } catch (cause) {
          data = null
        }
      }
      if (!response.ok) {
        throw makeApiError(data && data.error ? String(data.error) : '', { status: response.status })
      }
      if (data && data.ok === false && !opts.allowFail) {
        throw makeApiError(String(data.error || ''), { status: response.status })
      }
      return data || {}
    }

    function humanError(error, t) {
      if (!error) return t('error.network')
      if (error.code === 'TIMEOUT') return t('error.timeout')
      if (error.code === 'NET') return t('error.network')
      const message = typeof error.message === 'string' ? error.message : ''
      if (message && message !== 'request failed' && message !== 'network') return message
      if (error.status) return t('error.http', { status: String(error.status) })
      return message || t('error.network')
    }

    function fmtDuration(ms) {
      const value = Number(ms)
      if (!Number.isFinite(value) || value < 0) return ''
      if (value < 950) return Math.round(value) + 'ms'
      if (value < 60000) return (value / 1000).toFixed(value < 10000 ? 1 : 0) + 's'
      const minutes = Math.floor(value / 60000)
      const seconds = Math.round((value % 60000) / 1000)
      return minutes + 'm ' + (seconds < 10 ? '0' : '') + seconds + 's'
    }

    function fmtTime(iso) {
      if (!iso) return ''
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return String(iso)
      try {
        return date.toLocaleString()
      } catch (cause) {
        return String(iso)
      }
    }

    function fmtBytes(bytes) {
      const value = Number(bytes)
      if (!Number.isFinite(value) || value < 0) return ''
      if (value < 1024) return value + ' B'
      if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
      return (value / (1024 * 1024)).toFixed(1) + ' MB'
    }

    function imageUrl(image) {
      const filename = image && image.filename ? String(image.filename) : ''
      if (!filename) return ''
      const search = '?filename=' + encodeURIComponent(filename)
        + '&subfolder=' + encodeURIComponent(image && image.subfolder ? String(image.subfolder) : '')
        + '&type=' + encodeURIComponent(image && image.type ? String(image.type) : 'output')
      return IMAGE_PATH + search
    }

    function resultImageUrl(image) {
      if (image && typeof image.url === 'string' && image.url) return image.url
      return imageUrl(image)
    }

    function openImage(url) {
      if (!url || typeof window === 'undefined') return
      try {
        window.open(url, '_blank', 'noopener,noreferrer')
      } catch (cause) {
        /* 弹窗被拦截时静默；图片本身仍可在网格里看 */
      }
    }

    async function copyText(text) {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch (cause) {
        /* 剪贴板不可用时静默（CONTRACT §7.1） */
      }
      return false
    }

    function readFileText(file) {
      if (typeof file.text === 'function') return file.text()
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result || ''))
        reader.onerror = () => reject(reader.error || new Error('read failed'))
        reader.readAsText(file)
      })
    }

    function normalizeState(data) {
      const source = data && typeof data === 'object' ? data : {}
      return {
        baseUrl: typeof source.baseUrl === 'string' ? source.baseUrl : '',
        timeoutSec: Number.isFinite(Number(source.timeoutSec)) ? Number(source.timeoutSec) : 300,
        clientId: typeof source.clientId === 'string' ? source.clientId : '',
        workflows: Array.isArray(source.workflows) ? source.workflows : [],
        lastRuns: Array.isArray(source.lastRuns) ? source.lastRuns : [],
      }
    }

    function sourceLabel(source, t) {
      if (source === 'ui') return t('wf.sourceUi')
      if (source === 'api') return t('wf.sourceApi')
      if (source === 'server') return t('wf.sourceServer')
      return source ? String(source) : ''
    }

    function runStateLabel(state, t) {
      if (state === 'done') return t('runs.stateDone')
      if (state === 'error') return t('runs.stateError')
      if (state === 'timeout') return t('runs.stateTimeout')
      return t('runs.stateQueued')
    }

    function runTone(state) {
      if (state === 'done') return 'ok'
      if (state === 'error') return 'error'
      if (state === 'timeout') return 'warn'
      return 'busy'
    }

    function pickCreated(response) {
      const created = response && response.workflow
      if (Array.isArray(created)) return created[0] || null
      return created && typeof created === 'object' ? created : null
    }

    function paramDefaults(params) {
      const values = {}
      for (const param of Array.isArray(params) ? params : []) {
        if (param && typeof param.path === 'string') values[param.path] = param.value
      }
      return values
    }

    function promptDefaults(workflow) {
      const targets = workflow && workflow.promptTargets && typeof workflow.promptTargets === 'object'
        ? workflow.promptTargets
        : {}
      const params = Array.isArray(workflow && workflow.params) ? workflow.params : []
      const read = (paths) => {
        for (const path of Array.isArray(paths) ? paths : []) {
          const param = params.find((item) => item && item.path === path)
          if (param && typeof param.value === 'string') return param.value
        }
        return ''
      }
      return { positive: read(targets.positive), negative: read(targets.negative) }
    }

    /** 参数值 → POST /run 的 params 对象（{ '节点id.输入名': 值 }）。 */
    function buildParamValues(params, values) {
      const out = {}
      for (const param of Array.isArray(params) ? params : []) {
        if (!param || typeof param.path !== 'string') continue
        const value = values[param.path]
        if (value === undefined || value === null) continue
        if (param.type === 'boolean') {
          out[param.path] = Boolean(value)
          continue
        }
        if (param.type === 'integer' || param.type === 'number') {
          const text = String(value).trim()
          if (text === '') continue
          const number = Number(text)
          if (!Number.isFinite(number)) continue
          out[param.path] = number
          continue
        }
        out[param.path] = value
      }
      return out
    }

    function nodeErrorRows(nodeErrors) {
      if (!nodeErrors || typeof nodeErrors !== 'object') return []
      const rows = []
      for (const id of Object.keys(nodeErrors)) {
        const entry = nodeErrors[id]
        const messages = []
        if (entry && Array.isArray(entry.errors)) {
          for (const item of entry.errors) {
            if (item && item.message) messages.push(String(item.message))
          }
        }
        if (messages.length === 0) {
          try {
            messages.push(typeof entry === 'string' ? entry : JSON.stringify(entry))
          } catch (cause) {
            messages.push(String(entry))
          }
        }
        rows.push({
          id,
          classType: entry && typeof entry.class_type === 'string' ? entry.class_type : '',
          messages,
        })
      }
      return rows
    }

    function useAlive() {
      const ref = useRef(true)
      useEffect(() => {
        ref.current = true
        return () => {
          ref.current = false
        }
      }, [])
      return ref
    }

    /** locale 切换时让整棵面板重新渲染（t() 本身由 locale 服务更新）。 */
    function useLocaleTick(locale) {
      const [, setVersion] = useState(0)
      useEffect(() => {
        if (!locale || typeof locale.subscribe !== 'function') return undefined
        return locale.subscribe(() => setVersion((value) => value + 1))
      }, [locale])
    }

    /* ── 图标（内联 SVG，颜色一律 currentColor） ─────────────────────────── */
    const ICONS = {
      refresh: ['M20 12a8 8 0 1 1-2.34-5.66', 'M20 4.5v6h-6'],
      chevron: ['M9.5 6.5L15 12l-5.5 5.5'],
      copy: ['M9 9h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z', 'M6 15H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v1'],
      check: ['M5 12.5L9.5 17L19 7'],
      trash: ['M4.5 6.5h15', 'M9 6.5V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1.5', 'M6.5 6.5l.9 12a1 1 0 0 0 1 .9h7.2a1 1 0 0 0 1-.9l.9-12', 'M10 10.5v6', 'M14 10.5v6'],
      pencil: ['M4.5 19.5l.7-4.2 9.9-9.9a2.1 2.1 0 0 1 3 3l-9.9 9.9z', 'M13.2 6.7l3.1 3.1'],
      plus: ['M12 5v14', 'M5 12h14'],
      back: ['M14.5 5.5L8 12l6.5 6.5'],
      alert: ['M12 4.2L21 19.5H3z', 'M12 10v4.5', 'M12 17.2v.1'],
      download: ['M12 4.5v9', 'M8.5 10L12 13.5L15.5 10', 'M5 16.5v2a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2'],
      file: ['M13 4.5H7a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9.5z', 'M13 4.5v5h5'],
      server: ['M4.5 5.5h15v5h-15z', 'M4.5 13.5h15v5h-15z', 'M8 8h.1', 'M8 16h.1'],
      stack: ['M12 4.5L19.5 8.5L12 12.5L4.5 8.5z', 'M4.5 12.5L12 16.5L19.5 12.5', 'M4.5 16.5L12 20.5L19.5 16.5'],
      workflow: ['M6 6.5h3', 'M6 17.5h3', 'M15 6.5v11', 'M15 12h3.5'],
      clock: ['M12 5a7 7 0 1 0 0 14a7 7 0 0 0 0-14z', 'M12 8.5V12l2.6 2'],
      x: ['M6 6l12 12', 'M18 6L6 18'],
      play: { solid: 'M8.5 5.4v13.2L19 12z' },
    }

    function Icon(props) {
      const definition = ICONS[props.name]
      let children = null
      if (Array.isArray(definition)) {
        children = definition.map((d, index) => h('path', { key: index, d }))
      } else if (definition && definition.solid) {
        children = h('path', { d: definition.solid, fill: 'currentColor', stroke: 'none' })
      }
      return h('svg', {
        className: props.className || undefined,
        width: props.size || 14,
        height: props.size || 14,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        style: props.style || undefined,
      }, children)
    }

    /** 侧栏图标：props = { size, active }。 */
    function ComfyIcon(props) {
      const size = props && Number.isFinite(Number(props.size)) ? Number(props.size) : 20
      const active = props && props.active
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block', opacity: active ? 1 : 0.82 },
      },
        h('path', { d: 'M7.8 7h4.6M7.8 17h4.6M15.4 7v10M15.4 12h3' }),
        h('circle', { cx: 6, cy: 7, r: 1.7, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 6, cy: 17, r: 1.7, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 20.2, cy: 12, r: 1.7, fill: 'currentColor', stroke: 'none' }))
    }

    /* ── 小组件 ──────────────────────────────────────────────────────────── */
    function Spinner() {
      return h('span', { className: 'sc-spinner', 'aria-hidden': 'true' })
    }

    function Pill(props) {
      const tone = props.tone || 'neutral'
      return h('span', { className: 'sc-pill', 'data-tone': tone },
        h('span', { className: 'sc-dot', 'data-tone': tone, 'aria-hidden': 'true' }),
        props.children)
    }

    function InlineError(props) {
      return h('div', { className: 'sc-errorLine', role: 'alert' },
        h(Icon, { name: 'alert', size: 14 }),
        h('span', { className: 'sc-errorText' }, props.message),
        props.onRetry
          ? h('button', { type: 'button', className: 'sc-linkBtn', onClick: props.onRetry }, props.t('common.retry'))
          : null)
    }

    function LoadingRow(props) {
      return h('div', { className: 'sc-loadingRow' },
        h(Spinner),
        h('span', null, props.label || props.t('common.loading')))
    }

    function WarnList(props) {
      const warnings = Array.isArray(props.warnings) ? props.warnings : []
      if (warnings.length === 0) return null
      return h('div', { className: 'sc-warnBox' },
        props.title ? h('div', { className: 'sc-noteTitle' }, props.title) : null,
        h('ul', { className: 'sc-noteList' }, warnings.map((warning, index) => h('li', { key: index }, String(warning)))))
    }

    function Switch(props) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': props.checked ? 'true' : 'false',
        'aria-label': props.label || undefined,
        className: 'sc-switch',
        disabled: Boolean(props.disabled),
        onClick: () => props.onChange(!props.checked),
      })
    }

    function Card(props) {
      return h('section', { className: 'sc-card' },
        h('div', { className: 'sc-cardHead' },
          h('h2', { className: 'sc-cardTitle' },
            props.icon ? h(Icon, { name: props.icon, size: 16 }) : null,
            h('span', { className: 'sc-cardTitleText' }, props.title),
            props.count !== undefined && props.count !== null
              ? h('span', { className: 'sc-cardCount' }, props.count)
              : null),
          props.actions ? h('div', { className: 'sc-cardActions' }, props.actions) : null),
        h('div', { className: 'sc-cardBody' }, props.children))
    }

    function Field(props) {
      return h('div', { className: 'sc-field' },
        props.htmlFor
          ? h('label', { className: 'sc-fieldLabel', htmlFor: props.htmlFor }, props.label)
          : h('span', { className: 'sc-fieldLabel' }, props.label),
        h('div', { className: 'sc-fieldCtl' }, props.children))
    }

    /* ── 连接配置卡 ──────────────────────────────────────────────────────── */
    function ConnectionCard(props) {
      const t = props.t
      const data = props.data
      const test = props.test
      const alive = useAlive()
      const savedTimeout = String(data.timeoutSec === undefined || data.timeoutSec === null ? 300 : data.timeoutSec)
      const [url, setUrl] = useState(data.baseUrl || '')
      const [timeoutValue, setTimeoutValue] = useState(savedTimeout)
      const [baseline, setBaseline] = useState({ url: data.baseUrl || '', timeout: savedTimeout })
      const [saving, setSaving] = useState(false)
      const [saveError, setSaveError] = useState(null)
      const [saved, setSaved] = useState(false)

      useEffect(() => {
        setBaseline({
          url: data.baseUrl || '',
          timeout: String(data.timeoutSec === undefined || data.timeoutSec === null ? 300 : data.timeoutSec),
        })
      }, [data.baseUrl, data.timeoutSec])

      const dirty = url.trim() !== baseline.url || timeoutValue.trim() !== baseline.timeout

      function editUrl(value) {
        setUrl(value)
        setSaveError(null)
        setSaved(false)
      }

      function editTimeout(value) {
        setTimeoutValue(value)
        setSaveError(null)
        setSaved(false)
      }

      async function save() {
        const nextUrl = url.trim()
        if (!nextUrl) {
          setSaveError(t('conn.urlRequired'))
          setSaved(false)
          return
        }
        let timeoutSec
        if (timeoutValue.trim() !== '') {
          const parsed = Number(timeoutValue.trim())
          if (!Number.isFinite(parsed) || parsed < 5 || parsed > 3600) {
            setSaveError(t('conn.timeoutInvalid'))
            setSaved(false)
            return
          }
          timeoutSec = parsed
        }
        setSaveError(null)
        setSaved(false)
        setSaving(true)
        try {
          const body = timeoutSec === undefined ? { baseUrl: nextUrl } : { baseUrl: nextUrl, timeoutSec }
          const response = await api('/config', { method: 'POST', body })
          if (!alive.current) return
          if (typeof response.baseUrl === 'string' && response.baseUrl) {
            setUrl(response.baseUrl)
            setBaseline({
              url: response.baseUrl,
              timeout: String(response.timeoutSec === undefined || response.timeoutSec === null ? baseline.timeout : response.timeoutSec),
            })
          }
          setSaved(true)
          props.onSaved()
        } catch (error) {
          if (alive.current) setSaveError(humanError(error, t))
        } finally {
          if (alive.current) setSaving(false)
        }
      }

      let facts
      if (test.phase === 'loading') {
        facts = h(LoadingRow, { t, label: t('conn.testing') })
      } else if (test.phase === 'ok' && test.data) {
        const info = test.data
        const items = []
        if (Number.isFinite(Number(info.latencyMs))) {
          items.push(h('span', { key: 'latency', className: 'sc-fact' },
            h('span', { className: 'sc-factLabel' }, t('conn.latency')),
            h('span', { className: 'sc-factValue' }, Math.round(Number(info.latencyMs)) + 'ms')))
        }
        if (typeof info.comfyuiVersion === 'string' && info.comfyuiVersion) {
          items.push(h('span', { key: 'version', className: 'sc-fact' },
            h('span', { className: 'sc-factLabel' }, t('conn.version')),
            h('span', { className: 'sc-factValue' }, info.comfyuiVersion)))
        }
        if (typeof info.device === 'string' && info.device) {
          items.push(h('span', { key: 'device', className: 'sc-fact' },
            h('span', { className: 'sc-factLabel' }, t('conn.device')),
            h('span', { className: 'sc-factValue' }, info.device)))
        }
        facts = items.length > 0 ? h('div', { className: 'sc-facts' }, items) : h('p', { className: 'sc-muted' }, t('conn.connected'))
      } else if (test.phase === 'error') {
        facts = h(InlineError, {
          t,
          message: typeof test.error === 'string' && test.error ? test.error : t('conn.testFailed'),
          onRetry: props.onRetest,
        })
      } else {
        facts = h('p', { className: 'sc-muted' }, t('conn.unknown'))
      }

      return h(Card, { icon: 'server', title: t('conn.title') },
        h(Field, { label: t('conn.url'), htmlFor: 'sc-conn-url' },
          h('input', {
            id: 'sc-conn-url',
            className: 'sc-input',
            type: 'text',
            inputMode: 'url',
            placeholder: '127.0.0.1:8188',
            value: url,
            disabled: saving,
            onChange: (event) => editUrl(event.target.value),
          }),
          h('p', { className: 'sc-hint' }, t('conn.urlHint'))),
        h(Field, { label: t('conn.timeout'), htmlFor: 'sc-conn-timeout' },
          h('input', {
            id: 'sc-conn-timeout',
            className: 'sc-input sc-inputShort',
            type: 'number',
            min: 5,
            max: 3600,
            step: 1,
            value: timeoutValue,
            disabled: saving,
            onChange: (event) => editTimeout(event.target.value),
          }),
          h('p', { className: 'sc-hint' }, t('conn.timeoutHint'))),
        h('div', { className: 'sc-btnRow' },
          h('button', {
            type: 'button',
            className: 'sc-btn sc-btnPrimary',
            onClick: save,
            disabled: saving,
            'aria-busy': saving ? 'true' : 'false',
          }, saving ? h(Spinner) : null, saving ? t('conn.saving') : t('conn.saveTest')),
          dirty ? h('span', { className: 'sc-warnLine' }, t('conn.unsaved')) : null,
          saved && !dirty ? h('span', { className: 'sc-okLine' }, t('conn.saved')) : null),
        saveError ? h(InlineError, { t, message: saveError }) : null,
        facts)
    }

    /* ── 模型库卡 ────────────────────────────────────────────────────────── */
    function ModelsCard(props) {
      const t = props.t
      const alive = useAlive()
      const seq = useRef(0)
      const [models, setModels] = useState({ phase: 'idle', data: null, error: null })
      const [expanded, setExpanded] = useState({})
      const [copied, setCopied] = useState(null)
      const [query, setQuery] = useState('')

      async function load(refresh) {
        const requestId = seq.current + 1
        seq.current = requestId
        setModels((previous) => ({ phase: 'loading', data: previous.data, error: null }))
        try {
          const data = await api('/models' + (refresh ? '?refresh=1' : ''), { allowFail: true })
          if (requestId !== seq.current || !alive.current) return
          if (!data || data.ok === false) {
            setModels({ phase: 'error', data: null, error: (data && data.error) || t('models.error') })
            return
          }
          setModels({ phase: 'ok', data, error: null })
          setExpanded((previous) => {
            if (Object.keys(previous).length > 0) return previous
            const next = {}
            const categories = Array.isArray(data.categories) ? data.categories : []
            for (const category of categories.slice(0, 2)) {
              if (category && category.id) next[category.id] = true
            }
            return next
          })
        } catch (error) {
          if (requestId !== seq.current || !alive.current) return
          setModels({ phase: 'error', data: null, error: humanError(error, t) })
        }
      }

      useEffect(() => {
        if (!props.ready) return undefined
        load(false)
        return undefined
      }, [props.ready, props.baseUrl])

      useEffect(() => {
        if (!copied) return undefined
        const timer = setTimeout(() => setCopied(null), 1200)
        return () => clearTimeout(timer)
      }, [copied])

      async function copyName(name) {
        const ok = await copyText(name)
        if (ok && alive.current) setCopied(name)
      }

      function toggle(categoryId) {
        setExpanded((previous) => ({ ...previous, [categoryId]: !previous[categoryId] }))
      }

      const loading = models.phase === 'loading'
      const categories = models.phase === 'ok' && models.data && Array.isArray(models.data.categories)
        ? models.data.categories
        : []
      const total = models.phase === 'ok' && models.data && Number.isFinite(Number(models.data.total))
        ? Number(models.data.total)
        : null

      let body
      if (models.phase === 'error') {
        body = h(InlineError, { t, message: models.error, onRetry: () => load(true) })
      } else if (models.phase === 'idle' || (loading && !models.data)) {
        body = h(LoadingRow, { t, label: t('models.loading') })
      } else if (categories.length === 0 || total === 0) {
        body = h('div', { className: 'sc-emptyState' },
          h('div', { className: 'sc-emptyIcon' }, h(Icon, { name: 'stack', size: 22 })),
          h('p', { className: 'sc-emptyTitle' }, t('models.empty')),
          props.baseUrl ? null : h('button', {
            type: 'button',
            className: 'sc-btn sc-btnPrimary',
            onClick: props.onOpenConnection,
          }, t('conn.configureCta')))
      } else {
        const items = []
        const q = query.trim().toLowerCase()
        const visibleCategories = q
          ? categories
            .map((category) => ({
              ...category,
              files: (category && Array.isArray(category.files) ? category.files : [])
                .filter((file) => String(file).toLowerCase().includes(q)),
            }))
            .filter((category) => category.files.length > 0)
          : categories
        if (Array.isArray(models.data.warnings) && models.data.warnings.length > 0) {
          items.push(h(WarnList, { key: 'warnings', warnings: models.data.warnings, title: t('wf.importWarnings') }))
        }
        items.push(h('div', { key: 'toolbar', className: 'sc-toolbar' },
          h('input', {
            className: 'sc-input sc-search',
            type: 'search',
            placeholder: t('models.search'),
            'aria-label': t('models.search'),
            value: query,
            onChange: (event) => setQuery(event.target.value),
          })))
        if (q && visibleCategories.length === 0) {
          items.push(h('p', { key: 'noMatch', className: 'sc-empty' }, t('models.noMatch')))
        } else {
        items.push(h('div', { key: 'categories', className: 'sc-catList' }, visibleCategories.map((category) => {
          const id = category && category.id ? String(category.id) : ''
          const files = category && Array.isArray(category.files) ? category.files : []
          const open = Boolean(expanded[id]) || q.length > 0
          return h('div', { key: id || category.label, className: 'sc-cat' },
            h('button', {
              type: 'button',
              className: 'sc-catHead',
              'aria-expanded': open ? 'true' : 'false',
              'aria-label': (open ? t('models.collapse') : t('models.expand')) + ': ' + String((category && category.label) || id),
              onClick: () => toggle(id),
            },
              h(Icon, {
                name: 'chevron',
                size: 12,
                className: 'sc-chev',
                style: { transform: open ? 'rotate(90deg)' : 'none' },
              }),
              h('span', { className: 'sc-catLabel' }, (category && category.label) || id),
              h('span', { className: 'sc-catCount' }, t('models.files', { n: String(files.length) }))),
            open
              ? h('div', { className: 'sc-files' }, files.map((file) => {
                const name = String(file)
                const isCopied = copied === name
                return h('button', {
                  key: name,
                  type: 'button',
                  className: 'sc-file' + (isCopied ? ' sc-fileDone' : ''),
                  title: t('models.copy') + ': ' + name,
                  onClick: () => copyName(name),
                },
                  h('span', { className: 'sc-fileName' }, name),
                  isCopied
                    ? h('span', { className: 'sc-fileCopied' }, t('models.copied'))
                    : h(Icon, { name: 'copy', size: 12 }))
              }))
              : null)
        })))
        }
        body = items
      }

      return h(Card, {
        icon: 'stack',
        title: t('models.title'),
        count: total !== null ? t('models.total', { n: String(total) }) : null,
        actions: [
          h('button', {
            key: 'refresh',
            type: 'button',
            className: 'sc-btn',
            onClick: () => load(true),
            disabled: loading,
            'aria-busy': loading ? 'true' : 'false',
          }, loading ? h(Spinner) : h(Icon, { name: 'refresh' }), t('models.refresh')),
        ],
      }, body)
    }

    /* ── 工作流卡（列表 / 详情两态） ─────────────────────────────────────── */
    function WorkflowsCard(props) {
      const t = props.t
      const workflows = Array.isArray(props.workflows) ? props.workflows : []
      const alive = useAlive()
      const [view, setView] = useState({ kind: 'list' })
      const [renaming, setRenaming] = useState(null)
      const [busyId, setBusyId] = useState(null)
      const [actionError, setActionError] = useState(null)
      const [notice, setNotice] = useState(null)
      const [importOpen, setImportOpen] = useState(false)
      const [importText, setImportText] = useState('')
      const [importName, setImportName] = useState('')
      const [importing, setImporting] = useState(false)
      const [importError, setImportError] = useState(null)
      const [importResult, setImportResult] = useState(null)
      const [dragging, setDragging] = useState(false)
      const [serverOpen, setServerOpen] = useState(false)
      const [server, setServer] = useState({ phase: 'idle', items: [], error: null })
      const [serverBusy, setServerBusy] = useState(null)
      const [serverError, setServerError] = useState(null)
      const [serverResult, setServerResult] = useState(null)

      function openDetail(workflow) {
        setActionError(null)
        setNotice(null)
        setView({ kind: 'detail', id: workflow.id, name: workflow.name })
      }

      function editImportText(value) {
        setImportText(value)
        setImportError(null)
        setImportResult(null)
      }

      function editImportName(value) {
        setImportName(value)
        setImportError(null)
      }

      function toggleImport() {
        setImportOpen((previous) => !previous)
        setImportError(null)
        setImportResult(null)
        setActionError(null)
      }

      function autoImportName() {
        const explicit = importName.trim()
        if (explicit) return explicit
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
        return 'workflow-' + stamp
      }

      async function doImport(textOverride) {
        const json = String(textOverride === undefined ? importText : textOverride).trim()
        if (!json) {
          setImportError(t('wf.importNeedJson'))
          return
        }
        const name = autoImportName()
        setImportError(null)
        setImportResult(null)
        setNotice({ tone: 'ok', text: t('wf.importing') })
        setImporting(true)
        try {
          const response = await api('/workflows', {
            method: 'POST',
            body: { action: 'import', name, json },
            timeoutMs: 60000,
          })
          if (!alive.current) return
          setNotice({ tone: 'ok', text: t('wf.importedAs', { name: (response && response.workflow && response.workflow.name) || name }) })
          setImportResult({
            text: t('wf.importOk'),
            warnings: Array.isArray(response.warnings) ? response.warnings : [],
          })
          setImportText('')
          setImportName('')
          props.onChanged()
          const created = pickCreated(response)
          if (created && created.id) setView({ kind: 'detail', id: created.id, name: created.name })
        } catch (error) {
          if (alive.current) {
            setNotice(null)
            setImportError(humanError(error, t))
          }
        } finally {
          if (alive.current) setImporting(false)
        }
      }

      async function readWorkflowFile(file) {
        if (!file) return
        setImportError(null)
        setImportResult(null)
        if (Number(file.size) > IMPORT_LIMIT_BYTES) {
          setImportError(t('wf.importFileTooBig'))
          return
        }
        try {
          const text = await readFileText(file)
          if (!alive.current) return
          setImportText(text)
          if (!importName.trim()) setImportName(String(file.name || '').replace(/\.json$/i, ''))
        } catch (cause) {
          if (alive.current) setImportError(t('wf.importFileError'))
        }
      }

      function onDrop(event) {
        event.preventDefault()
        setDragging(false)
        const file = event.dataTransfer && event.dataTransfer.files ? event.dataTransfer.files[0] : null
        if (file) readWorkflowFile(file)
      }

      function startRename(workflow) {
        setActionError(null)
        setNotice(null)
        setRenaming({ id: workflow.id, name: workflow.name })
      }

      async function saveRename() {
        if (!renaming) return
        const name = renaming.name.trim()
        if (!name) {
          setActionError(t('wf.renameEmpty'))
          return
        }
        setActionError(null)
        setBusyId(renaming.id)
        try {
          await api('/workflows', { method: 'POST', body: { action: 'rename', id: renaming.id, name } })
          if (!alive.current) return
          setRenaming(null)
          setNotice({ tone: 'ok', text: t('wf.renamedOk') })
          props.onChanged()
        } catch (error) {
          if (alive.current) setActionError(humanError(error, t))
        } finally {
          if (alive.current) setBusyId(null)
        }
      }

      async function removeWorkflow(workflow) {
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(t('wf.deleteConfirm'))) {
          return
        }
        setActionError(null)
        setNotice(null)
        setBusyId(workflow.id)
        try {
          await api('/workflows', { method: 'POST', body: { action: 'delete', id: workflow.id } })
          if (!alive.current) return
          setNotice({ tone: 'ok', text: t('wf.deletedOk') })
          props.onChanged()
        } catch (error) {
          if (alive.current) setActionError(humanError(error, t))
        } finally {
          if (alive.current) setBusyId(null)
        }
      }

      async function loadServer() {
        setServer({ phase: 'loading', items: [], error: null })
        try {
          const data = await api('/server-workflows', { allowFail: true, timeoutMs: 25000 })
          if (!alive.current) return
          if (!data || data.ok === false) {
            setServer({ phase: 'error', items: [], error: (data && data.error) || t('wf.serverError') })
            return
          }
          setServer({ phase: 'ok', items: Array.isArray(data.items) ? data.items : [], error: null })
        } catch (error) {
          if (alive.current) setServer({ phase: 'error', items: [], error: humanError(error, t) })
        }
      }

      function toggleServer() {
        const next = !serverOpen
        setServerOpen(next)
        setServerError(null)
        setServerResult(null)
        setActionError(null)
        if (next && server.phase !== 'ok' && server.phase !== 'loading') loadServer()
      }

      async function importServer(item) {
        setServerError(null)
        setServerResult(null)
        setNotice({ tone: 'ok', text: t('wf.importing') })
        setServerBusy(item.path)
        try {
          const response = await api('/server-workflows', {
            method: 'POST',
            body: { action: 'import', path: item.path },
            timeoutMs: 60000,
          })
          if (!alive.current) return
          setNotice({ tone: 'ok', text: t('wf.importedAs', { name: (response && response.workflow && response.workflow.name) || item.name || item.path || '' }) })
          setServerResult({
            text: t('wf.importOk'),
            warnings: Array.isArray(response.warnings) ? response.warnings : [],
          })
          props.onChanged()
          const created = pickCreated(response)
          if (created && created.id) setView({ kind: 'detail', id: created.id, name: created.name })
        } catch (error) {
          if (alive.current) {
            setNotice(null)
            setServerError(humanError(error, t))
          }
        } finally {
          if (alive.current) setServerBusy(null)
        }
      }

      if (view.kind === 'detail') {
        return h(WorkflowDetail, {
          key: view.id,
          id: view.id,
          fallbackName: view.name,
          t,
          onBack: () => setView({ kind: 'list' }),
          onChanged: props.onChanged,
        })
      }

      const actions = [
        h('button', {
          key: 'import',
          type: 'button',
          className: 'sc-btn sc-btnPrimary',
          onClick: toggleImport,
          'aria-expanded': importOpen ? 'true' : 'false',
        }, h(Icon, { name: 'plus', size: 13 }), t('wf.importWorkflow')),
        h('button', {
          key: 'server',
          type: 'button',
          className: 'sc-btn',
          onClick: toggleServer,
          'aria-expanded': serverOpen ? 'true' : 'false',
        }, h(Icon, { name: 'download', size: 13 }), t('wf.fromServer')),
      ]

      const body = []
      if (importOpen) {
        body.push(h('div', { key: 'importPanel', className: 'sc-import' },
          h(Field, { label: t('wf.import'), htmlFor: 'sc-import-json' },
            h('textarea', {
              id: 'sc-import-json',
              className: 'sc-textarea' + (dragging ? ' sc-dropActive' : ''),
              rows: 6,
              spellCheck: false,
              placeholder: t('wf.importPlaceholder'),
              value: importText,
              onChange: (event) => editImportText(event.target.value),
              onDragOver: (event) => {
                event.preventDefault()
                setDragging(true)
              },
              onDragLeave: () => setDragging(false),
              onDrop: onDrop,
            }),
            h('p', { className: 'sc-hint' }, t('wf.importDropHint'))),
          h(Field, { label: t('wf.importName'), htmlFor: 'sc-import-name' },
            h('input', {
              id: 'sc-import-name',
              className: 'sc-input',
              type: 'text',
              placeholder: t('wf.importNamePlaceholder'),
              value: importName,
              onChange: (event) => editImportName(event.target.value),
            })),
          h('div', { className: 'sc-btnRow' },
            h('button', {
              type: 'button',
              className: 'sc-btn sc-btnPrimary',
              onClick: () => doImport(),
              disabled: importing,
              'aria-busy': importing ? 'true' : 'false',
            }, importing ? h(Spinner) : null, importing ? t('wf.importing') : t('wf.import')),
            h('label', { className: 'sc-btn sc-fileLabel' },
              h(Icon, { name: 'file', size: 13 }),
              t('wf.importFromFile'),
              h('input', {
                type: 'file',
                accept: 'application/json,.json',
                className: 'sc-srOnly',
                onChange: (event) => {
                  const file = event.target.files ? event.target.files[0] : null
                  readWorkflowFile(file)
                  event.target.value = ''
                },
              })),
            h('button', {
              type: 'button',
              className: 'sc-btn',
              onClick: () => {
                setImportOpen(false)
                setImportError(null)
                setImportResult(null)
              },
            }, t('common.cancel'))),
          importError ? h(InlineError, { t, message: importError }) : null,
          importResult
            ? h('div', { className: 'sc-warnBox' },
              h('p', { className: 'sc-okLine' }, importResult.text),
              h(WarnList, { warnings: importResult.warnings, title: t('wf.importWarnings') }))
            : null))
      }

      if (serverOpen) {
        let serverBody
        if (server.phase === 'loading') {
          serverBody = h(LoadingRow, { t, label: t('wf.serverLoading') })
        } else if (server.phase === 'error') {
          serverBody = h('div', { className: 'sc-stack' },
            h(InlineError, { t, message: server.error, onRetry: loadServer }),
            h('p', { className: 'sc-hint' }, t('wf.serverUnsupported')))
        } else if (server.items.length === 0) {
          serverBody = h('p', { className: 'sc-empty' }, t('wf.serverEmpty'))
        } else {
          serverBody = h('div', { className: 'sc-serverList' }, server.items.map((item, index) => {
            const path = typeof item.path === 'string' ? item.path : ''
            const busy = serverBusy === path
            const meta = []
            if (item.size !== undefined) meta.push(fmtBytes(item.size))
            if (item.modified) meta.push(fmtTime(item.modified))
            return h('div', { key: path || index, className: 'sc-serverRow' },
              h('div', { className: 'sc-serverMain' },
                h('span', { className: 'sc-serverName' }, item.name || path),
                h('span', { className: 'sc-serverPath' }, path + (meta.length > 0 ? ' · ' + meta.join(' · ') : ''))),
              h('button', {
                type: 'button',
                className: 'sc-btn',
                disabled: serverBusy !== null,
                'aria-busy': busy ? 'true' : 'false',
                onClick: () => importServer(item),
              }, busy ? h(Spinner) : null, busy ? t('wf.importing') : t('wf.import')))
          }))
        }
        body.push(h('div', { key: 'serverPanel', className: 'sc-import' },
          h('div', { className: 'sc-sectionHead' },
            h('span', { className: 'sc-sectionTitle' }, t('wf.serverListTitle')),
            h('button', {
              type: 'button',
              className: 'sc-iconBtn',
              title: t('models.refresh'),
              'aria-label': t('models.refresh'),
              onClick: loadServer,
              disabled: server.phase === 'loading',
            }, h(Icon, { name: 'refresh', size: 13 }))),
          serverError ? h(InlineError, { t, message: serverError }) : null,
          serverBody,
          serverResult
            ? h('div', { className: 'sc-warnBox' },
              h('p', { className: 'sc-okLine' }, serverResult.text),
              h(WarnList, { warnings: serverResult.warnings, title: t('wf.importWarnings') }))
            : null,
          h('div', { className: 'sc-btnRow' },
            h('button', {
              type: 'button',
              className: 'sc-btn',
              onClick: () => {
                setServerOpen(false)
                setServerError(null)
                setServerResult(null)
              },
            }, t('common.close')))))
      }

      if (notice) body.push(h('p', { key: 'notice', className: 'sc-okLine', role: 'status' }, notice.text))
      if (actionError) body.push(h(InlineError, { key: 'actionError', t, message: actionError }))

      if (workflows.length === 0) {
        body.push(h('div', { key: 'empty', className: 'sc-emptyState' },
          h('div', { className: 'sc-emptyIcon' }, h(Icon, { name: 'workflow', size: 22 })),
          h('p', { className: 'sc-emptyTitle' }, t('wf.emptyTitle')),
          h('p', { className: 'sc-emptyHint' }, t('wf.emptyHint')),
          h('div', { className: 'sc-emptyActions' },
            h('button', {
              type: 'button',
              className: 'sc-btn sc-btnPrimary',
              onClick: toggleImport,
            }, h(Icon, { name: 'plus', size: 13 }), t('wf.importWorkflow')),
            h('button', {
              type: 'button',
              className: 'sc-btn',
              onClick: toggleServer,
            }, h(Icon, { name: 'download', size: 13 }), t('wf.fromServer')))))
      } else {
        body.push(h('div', { key: 'list', className: 'sc-wfList' }, workflows.map((workflow) => {
          const busy = busyId === workflow.id
          const isRenaming = Boolean(renaming && renaming.id === workflow.id)
          const meta = [
            h('span', { key: 'source', className: 'sc-badge', title: t('wf.source') }, sourceLabel(workflow.source, t)),
            h('span', { key: 'nodes' }, t('wf.nodes', { n: String(workflow.nodeCount === undefined ? 0 : workflow.nodeCount) })),
            h('span', { key: 'params' }, t('wf.params', { n: String(workflow.paramCount === undefined ? 0 : workflow.paramCount) })),
          ]
          if (workflow.updatedAt) meta.push(h('span', { key: 'time', className: 'sc-metaTime' }, fmtTime(workflow.updatedAt)))
          const kindChips = Array.isArray(workflow.kindLabels) ? workflow.kindLabels.slice(0, 3) : []
          const needCount = Number(workflow.neededInputCount) || 0
          const summaryLine = h('div', { key: 'descRow', className: 'sc-wfDescRow' },
            kindChips.length > 0
              ? h('span', { className: 'sc-kindChips' }, kindChips.map((label, index) => h('span', { key: index, className: 'sc-kindChip' }, String(label))))
              : null,
            workflow.description
              ? h('span', { className: 'sc-wfDesc', title: String(workflow.description) }, String(workflow.description))
              : null,
            needCount > 0
              ? h('span', { className: 'sc-needBadge', title: t('wf.needsInput', { n: String(needCount) }) }, t('wf.needsInput', { n: String(needCount) }))
              : null)
          return h('div', { key: workflow.id, className: 'sc-wfRow' },
            h('div', { className: 'sc-wfMain' },
              isRenaming
                ? h('div', { className: 'sc-renameRow' },
                  h('input', {
                    className: 'sc-input',
                    type: 'text',
                    value: renaming.name,
                    placeholder: t('wf.renamePrompt'),
                    'aria-label': t('wf.renamePrompt'),
                    disabled: busy,
                    onChange: (event) => setRenaming({ id: workflow.id, name: event.target.value }),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') saveRename()
                      if (event.key === 'Escape') setRenaming(null)
                    },
                  }),
                  h('button', {
                    type: 'button',
                    className: 'sc-btn sc-btnPrimary',
                    onClick: saveRename,
                    disabled: busy,
                    'aria-busy': busy ? 'true' : 'false',
                  }, busy ? h(Spinner) : null, t('wf.renameSave')),
                  h('button', {
                    type: 'button',
                    className: 'sc-btn',
                    onClick: () => setRenaming(null),
                    disabled: busy,
                  }, t('common.cancel')))
                : h('button', {
                  type: 'button',
                  className: 'sc-wfNameBtn',
                  title: t('wf.open'),
                  onClick: () => openDetail(workflow),
                }, workflow.name),
              h('div', { className: 'sc-wfMeta' }, meta)),
            summaryLine,
            h('div', { className: 'sc-wfActions' },
              h('button', {
                type: 'button',
                className: 'sc-btn',
                onClick: () => openDetail(workflow),
                disabled: busy,
              }, t('wf.open')),
              h('button', {
                type: 'button',
                className: 'sc-btn',
                onClick: () => startRename(workflow),
                disabled: busy,
              }, h(Icon, { name: 'pencil', size: 13 }), t('wf.rename')),
              h('button', {
                type: 'button',
                className: 'sc-btn sc-btnDanger',
                onClick: () => removeWorkflow(workflow),
                disabled: busy,
                'aria-busy': busy ? 'true' : 'false',
              }, busy ? h(Spinner) : h(Icon, { name: 'trash', size: 13 }), t('wf.delete'))))
        })))
      }

      return h(Card, {
        icon: 'workflow',
        title: t('wf.title'),
        count: String(workflows.length),
        actions,
      }, body)
    }

    /* ── 服务器工作流浏览器（不导入：直接查看 + 使用时按需加载） ────────────── */
    function ServerWorkflowsCard(props) {
      const t = props.t
      const alive = useAlive()
      const [list, setList] = useState({ phase: 'idle', items: [], error: null })
      const [query, setQuery] = useState('')
      const [view, setView] = useState({ kind: 'list' })

      async function load(force) {
        if (!props.baseUrl) {
          setList({ phase: 'noConfig', items: [], error: null })
          return
        }
        setList((previous) => ({ phase: 'loading', items: previous.items || [], error: null }))
        try {
          const data = await api('/server-workflows?refresh=' + (force ? '1' : '0'), {
            allowFail: true,
            timeoutMs: 25000,
          })
          if (!alive.current) return
          if (!data || data.ok === false) {
            setList({ phase: 'error', items: [], error: (data && data.error) || t('wf.serverLoadError') })
            return
          }
          setList({ phase: 'ok', items: Array.isArray(data.items) ? data.items : [], error: null })
        } catch (error) {
          if (!alive.current) return
          setList({ phase: 'error', items: [], error: humanError(error, t) })
        }
      }

      useEffect(() => {
        load(false)
        return undefined
      }, [props.baseUrl])

      function openDetail(item) {
        setView({ kind: 'detail', path: String(item.path || ''), name: String(item.name || item.path || '') })
      }

      if (view.kind === 'detail') {
        return h(WorkflowDetail, {
          key: 'server:' + view.path,
          path: view.path,
          fallbackName: view.name,
          t,
          onBack: () => {
            setView({ kind: 'list' })
            load(false)
          },
          onChanged: () => load(false),
        })
      }

      const items = list.phase === 'ok' || list.phase === 'loading' ? list.items || [] : []
      const q = query.trim().toLowerCase()
      const visible = q
        ? items.filter((item) => String(item.name || '').toLowerCase().includes(q) || String(item.path || '').toLowerCase().includes(q))
        : items
      const loading = list.phase === 'loading'

      const actions = [
        h('button', {
          key: 'refresh',
          type: 'button',
          className: 'sc-btn',
          onClick: () => load(true),
          disabled: loading || !props.baseUrl,
          'aria-busy': loading ? 'true' : 'false',
        }, loading ? h(Spinner) : h(Icon, { name: 'refresh', size: 13 }), t('common.refresh')),
      ]

      let body
      if (!props.baseUrl || list.phase === 'noConfig') {
        body = h('div', { className: 'sc-emptyState' },
          h('div', { className: 'sc-emptyIcon' }, h(Icon, { name: 'server', size: 22 })),
          h('p', { className: 'sc-emptyTitle' }, t('conn.unconfigured')),
          h('p', { className: 'sc-emptyHint' }, t('wf.serverHint')),
          h('div', { className: 'sc-emptyActions' },
            h('button', {
              type: 'button',
              className: 'sc-btn sc-btnPrimary',
              onClick: props.onOpenConnection,
            }, t('conn.configureCta'))))
      } else if (loading && items.length === 0) {
        body = h(LoadingRow, { t, label: t('wf.serverLoading') })
      } else if (list.phase === 'error') {
        body = h(InlineError, { t, message: list.error, onRetry: () => load(true) })
      } else if (items.length === 0) {
        body = h('div', { className: 'sc-emptyState' },
          h('div', { className: 'sc-emptyIcon' }, h(Icon, { name: 'workflow', size: 22 })),
          h('p', { className: 'sc-emptyTitle' }, t('wf.serverEmptyTitle')),
          h('p', { className: 'sc-emptyHint' }, t('wf.serverEmptyHint')),
          h('div', { className: 'sc-emptyActions' },
            h('button', { type: 'button', className: 'sc-btn', onClick: () => load(true) }, t('common.refresh'))))
      } else {
        body = []
        body.push(h('div', { key: 'toolbar', className: 'sc-toolbar' },
          h('input', {
            className: 'sc-input sc-search',
            type: 'search',
            placeholder: t('wf.searchServer'),
            'aria-label': t('wf.searchServer'),
            value: query,
            onChange: (event) => setQuery(event.target.value),
          }),
          h('span', { className: 'sc-cardCount' }, t('wf.serverCount', { n: String(visible.length) }))))
        body.push(h('p', { key: 'hint', className: 'sc-muted' }, t('wf.useHint')))
        if (visible.length === 0) {
          body.push(h('p', { key: 'noMatch', className: 'sc-empty' }, t('wf.serverNoMatch')))
        } else {
          body.push(h('div', { key: 'list', className: 'sc-serverWfList' }, visible.map((item, index) => {
            const path = String(item.path || '')
            const name = String(item.name || path)
            const meta = []
            if (item.size !== undefined) meta.push(fmtBytes(item.size))
            if (item.modified) meta.push(fmtTime(item.modified))
            return h('button', {
              key: path || index,
              type: 'button',
              className: 'sc-serverWfRow',
              title: path,
              onClick: () => openDetail(item),
            },
              h('span', { className: 'sc-serverWfLead' }, h(Icon, { name: 'workflow', size: 15 })),
              h('span', { className: 'sc-serverWfMain' },
                h('span', { className: 'sc-serverWfName' }, name),
                h('span', { className: 'sc-serverWfPath' }, path + (meta.length > 0 ? ' · ' + meta.join(' · ') : ''))),
              h('span', { className: 'sc-serverWfUse' }, t('wf.use'), h(Icon, { name: 'chevron', size: 12 })))
          })))
        }
      }

      return h(Card, {
        icon: 'workflow',
        title: t('wf.title'),
        count: items.length > 0 ? t('wf.serverCount', { n: String(items.length) }) : null,
        actions,
      }, body)
    }

    /* ── 提示词输入 ──────────────────────────────────────────────────────── */
    function PromptField(props) {
      return h('div', { className: 'sc-promptBlock' },
        h('div', { className: 'sc-promptHead' },
          h('label', { className: 'sc-promptLabel', htmlFor: props.id }, props.label),
          Array.isArray(props.targets) && props.targets.length > 0
            ? h('div', { className: 'sc-chipRow' }, props.targets.map((path) => h('span', {
              key: path,
              className: 'sc-chip',
              title: props.t('wf.promptTargets'),
            }, path)))
            : null),
        h('textarea', {
          id: props.id,
          className: 'sc-textarea',
          rows: 3,
          spellCheck: false,
          value: props.value || '',
          disabled: Boolean(props.disabled),
          onChange: (event) => props.onChange(event.target.value),
        }))
    }

    /* ── 参数控件 ────────────────────────────────────────────────────────── */
    function ParamControl(props) {
      const t = props.t
      const param = props.param
      const value = props.value
      const inputId = 'sc-param-' + String(param.path || '').replace(/[^a-zA-Z0-9_-]/g, '_')
      const textValue = value === undefined || value === null ? '' : String(value)
      const disabled = Boolean(props.disabled)
      let control
      if (param.type === 'enum') {
        const options = Array.isArray(param.options) ? param.options.slice() : []
        if (textValue !== '' && options.indexOf(textValue) === -1) options.unshift(textValue)
        control = h('div', { className: 'sc-selectWrap' },
          h('select', {
            id: inputId,
            className: 'sc-select',
            value: textValue,
            disabled: disabled || undefined,
            onChange: (event) => props.onChange(event.target.value),
          }, options.map((option) => h('option', { key: option, value: option }, option))))
      } else if (param.type === 'boolean') {
        control = h('div', { className: 'sc-paramCtl' },
          h(Switch, {
            checked: Boolean(value),
            label: param.path,
            disabled,
            onChange: (next) => props.onChange(next),
          }))
      } else if (param.type === 'number' || param.type === 'integer') {
        control = h('input', {
          id: inputId,
          className: 'sc-input',
          type: 'number',
          inputMode: 'decimal',
          value: textValue,
          disabled: disabled || undefined,
          min: typeof param.min === 'number' ? param.min : undefined,
          max: typeof param.max === 'number' ? param.max : undefined,
          step: param.type === 'integer' ? 1 : (typeof param.step === 'number' ? param.step : 'any'),
          onChange: (event) => props.onChange(event.target.value),
        })
      } else if (param.multiline) {
        control = h('textarea', {
          id: inputId,
          className: 'sc-textarea',
          rows: 3,
          spellCheck: false,
          value: textValue,
          disabled: disabled || undefined,
          onChange: (event) => props.onChange(event.target.value),
        })
      } else {
        control = h('input', {
          id: inputId,
          className: 'sc-input',
          type: 'text',
          value: textValue,
          disabled: disabled || undefined,
          onChange: (event) => props.onChange(event.target.value),
        })
      }
      return h('div', { className: 'sc-param' },
        h('div', { className: 'sc-paramHead' },
          h('label', { className: 'sc-paramLabel', htmlFor: inputId }, param.inputName || param.path),
          h('span', { className: 'sc-paramPath', title: t('wf.paramPath') }, '#' + String(param.path || ''))),
        control)
    }

    /* ── 结果图片网格 ────────────────────────────────────────────────────── */
    function ResultImages(props) {
      const images = Array.isArray(props.images) ? props.images : []
      return h('div', { className: 'sc-images' }, images.map((image, index) => {
        const url = resultImageUrl(image)
        if (!url) return null
        const filename = image && image.filename ? String(image.filename) : 'image-' + (index + 1)
        return h('button', {
          key: index,
          type: 'button',
          className: 'sc-imageBtn',
          title: filename + (image && image.path ? '\n' + image.path : ''),
          onClick: () => openImage(url),
        }, h('img', { className: 'sc-image', src: url, alt: filename, loading: 'lazy' }))
      }))
    }

    function NodeErrors(props) {
      const rows = nodeErrorRows(props.nodeErrors)
      if (rows.length === 0) return null
      return h('div', { className: 'sc-nodeErrors' },
        h('span', { className: 'sc-sectionTitle' }, props.t('wf.nodeErrors')),
        rows.map((row, index) => h('p', { key: index, className: 'sc-errorLine' },
          h('code', null, '#' + row.id + (row.classType ? ' ' + row.classType : '')),
          h('span', { className: 'sc-errorText' }, row.messages.join(' · ')))))
    }

    /* ── 运行结果区 ──────────────────────────────────────────────────────── */
    function RunResult(props) {
      const t = props.t
      const run = props.run
      const elapsed = props.elapsedMs
      function head(extra) {
        return h('div', { className: 'sc-resultHead' },
          h('span', null, t('wf.result')),
          extra || null)
      }
      if (!run || run.phase === 'idle') {
        return h('div', { className: 'sc-result' },
          head(),
          h('p', { className: 'sc-muted' }, t('wf.resultEmpty')))
      }
      if (run.phase === 'running') {
        return h('div', { className: 'sc-result' },
          head(),
          h('div', { className: 'sc-loadingRow' },
            h(Spinner),
            h('span', null, t('wf.running')),
            elapsed !== null && elapsed !== undefined
              ? h('span', { className: 'sc-muted' }, t('wf.elapsed', { v: fmtDuration(elapsed) }))
              : null))
      }
      if (run.phase === 'error') {
        const data = run.data && typeof run.data === 'object' ? run.data : {}
        const images = Array.isArray(data.images) ? data.images.filter((image) => resultImageUrl(image)) : []
        return h('div', { className: 'sc-result' },
          head(h(Pill, { tone: 'error' }, t('wf.failed'))),
          h(InlineError, { t, message: run.error || (data.error ? String(data.error) : t('wf.failed')) }),
          images.length > 0 ? h(ResultImages, { images }) : null,
          h(NodeErrors, { t, nodeErrors: run.nodeErrors || data.nodeErrors }),
          h(WarnList, {
            warnings: run.warnings && run.warnings.length > 0 ? run.warnings : data.warnings,
            title: t('wf.runWarnings'),
          }))
      }
      const data = run.data && typeof run.data === 'object' ? run.data : {}
      const state = data.state ? String(data.state) : 'done'
      const images = Array.isArray(data.images) ? data.images.filter((image) => resultImageUrl(image)) : []
      const applied = Array.isArray(data.applied) ? data.applied : []
      const elapsedValue = elapsed !== null && elapsed !== undefined
        ? elapsed
        : (Number.isFinite(Number(data.elapsedMs)) ? Number(data.elapsedMs) : null)
      const facts = []
      if (elapsedValue !== null) {
        facts.push(h('span', { key: 'elapsed', className: 'sc-fact' },
          h('span', { className: 'sc-factLabel' }, t('wf.elapsed')),
          h('span', { className: 'sc-factValue' }, fmtDuration(elapsedValue))))
      }
      if (data.promptId) {
        facts.push(h('span', { key: 'prompt', className: 'sc-fact' },
          h('span', { className: 'sc-factLabel' }, t('wf.promptId')),
          h('code', null, String(data.promptId))))
      }
      return h('div', { className: 'sc-result' },
        head(h(Pill, { tone: runTone(state) }, runStateLabel(state, t))),
        facts.length > 0 ? h('div', { className: 'sc-facts' }, facts) : null,
        images.length > 0
          ? h(ResultImages, { images })
          : h('p', { className: 'sc-muted' }, t('wf.noImages')),
        state === 'error' && data.error ? h(InlineError, { t, message: String(data.error) }) : null,
        applied.length > 0
          ? h('div', { className: 'sc-applied' },
            h('span', { className: 'sc-sectionTitle' }, t('wf.applied')),
            h('div', { className: 'sc-chipRow' }, applied.map((item, index) => h('span', {
              key: index,
              className: 'sc-chip',
            }, String(item.path || '') + (item.field ? ' @' + item.field : '') + ' = ' + String(item.value)))))
          : null,
        h(NodeErrors, { t, nodeErrors: data.nodeErrors }),
        h(WarnList, { warnings: data.warnings, title: t('wf.runWarnings') }))
    }

    /* ── 工作流详情 ──────────────────────────────────────────────────────── */
    function WorkflowDetail(props) {
      const t = props.t
      const isServer = Boolean(props.path)
      const alive = useAlive()
      const [load, setLoad] = useState({ phase: 'loading', workflow: null, error: null })
      const [loadSeq, setLoadSeq] = useState(0)
      const [overrides, setOverrides] = useState({})
      const [prompts, setPrompts] = useState({ positive: '', negative: '' })
      const [run, setRun] = useState({ phase: 'idle' })
      const [elapsedMs, setElapsedMs] = useState(null)
      const [copiedPath, setCopiedPath] = useState(false)
      const [meta, setMeta] = useState({ description: '', tags: '', phase: 'idle', error: null, saved: false })

      useEffect(() => {
        let cancelled = false
        setLoad((previous) => (previous.phase === 'ok' ? previous : { phase: 'loading', workflow: null, error: null }))
        const url = props.path
          ? '/server-workflows/detail?path=' + encodeURIComponent(props.path)
            + (props.fallbackName ? '&name=' + encodeURIComponent(props.fallbackName) : '')
          : '/workflows/' + encodeURIComponent(props.id)
        api(url, { timeoutMs: 60000 }).then((response) => {
          if (cancelled) return
          const workflow = response && response.workflow ? response.workflow : null
          if (!workflow) {
            setLoad({ phase: 'error', workflow: null, error: t('wf.loadError') })
            return
          }
          setLoad({ phase: 'ok', workflow, error: null })
          setOverrides(paramDefaults(workflow.params))
          setPrompts(promptDefaults(workflow))
          setMeta({
            description: typeof workflow.description === 'string'
              ? workflow.description
              : (workflow.capabilities && typeof workflow.capabilities.summary === 'string' ? workflow.capabilities.summary : ''),
            tags: Array.isArray(workflow.tags) ? workflow.tags.join('，') : '',
            phase: 'idle',
            error: null,
            saved: false,
          })
          setRun({ phase: 'idle' })
          setElapsedMs(null)
        }).catch((error) => {
          if (cancelled) return
          setLoad({ phase: 'error', workflow: null, error: humanError(error, t) })
          setRun({ phase: 'idle' })
        })
        return () => {
          cancelled = true
        }
      }, [props.id, props.path, loadSeq])

      useEffect(() => {
        if (!run || run.phase === 'idle') {
          setElapsedMs(null)
          return undefined
        }
        if (run.phase === 'running') {
          const startedAt = run.startedAt || Date.now()
          setElapsedMs(0)
          const timer = setInterval(() => setElapsedMs(Date.now() - startedAt), 500)
          return () => clearInterval(timer)
        }
        const data = run.data && typeof run.data === 'object' ? run.data : {}
        let final = null
        if (Number.isFinite(Number(data.elapsedMs))) final = Number(data.elapsedMs)
        else if (run.endedAt && run.startedAt) final = run.endedAt - run.startedAt
        setElapsedMs(final)
        return undefined
      }, [run])

      useEffect(() => {
        if (!copiedPath) return undefined
        const timer = setTimeout(() => setCopiedPath(false), 1400)
        return () => clearTimeout(timer)
      }, [copiedPath])

      const workflow = load.phase === 'ok' ? load.workflow : null
      const params = workflow && Array.isArray(workflow.params) ? workflow.params : []
      const targets = workflow && workflow.promptTargets && typeof workflow.promptTargets === 'object'
        ? workflow.promptTargets
        : {}
      const positiveTargets = Array.isArray(targets.positive) ? targets.positive : []
      const negativeTargets = Array.isArray(targets.negative) ? targets.negative : []
      const promptPathSet = new Set([].concat(positiveTargets, negativeTargets))
      const shownParams = params.filter((param) => param && param.path && !promptPathSet.has(param.path))
      const running = run.phase === 'running'

      function setParam(path, value) {
        setOverrides((previous) => ({ ...previous, [path]: value }))
      }

      function setPrompt(field, value) {
        setPrompts((previous) => ({ ...previous, [field]: value }))
      }

      function resetDefaults() {
        setOverrides(paramDefaults(params))
        setPrompts(promptDefaults(workflow))
      }

      function parseTagsInput(text) {
        return [...new Set(String(text || '').split(/[，,、\n]/).map((item) => item.trim()).filter(Boolean))]
      }

      const metaTags = parseTagsInput(meta.tags)
      const metaInvalid = meta.description.length > 500
        || metaTags.length > 12
        || metaTags.some((tag) => tag.length > 40)

      async function saveMeta() {
        if (!workflow || meta.phase === 'saving' || metaInvalid) return
        setMeta((previous) => ({ ...previous, phase: 'saving', error: null, saved: false }))
        try {
          const response = await api('/workflows', {
            method: 'POST',
            body: { action: 'update', id: props.id, description: meta.description, tags: metaTags },
            allowFail: true,
          })
          if (!alive.current) return
          if (!response || response.ok === false) {
            setMeta((previous) => ({
              ...previous,
              phase: 'error',
              error: (response && response.error) ? String(response.error) : t('wf.failed'),
            }))
            return
          }
          setMeta((previous) => ({ ...previous, phase: 'idle', error: null, saved: true }))
          props.onChanged()
        } catch (error) {
          if (alive.current) {
            setMeta((previous) => ({ ...previous, phase: 'error', error: humanError(error, t) }))
          }
        }
      }

      async function runNow() {
        if (running || !workflow) return
        const startedAt = Date.now()
        setRun({ phase: 'running', startedAt })
        setElapsedMs(0)
        const builtParams = buildParamValues(shownParams, overrides)
        try {
          const response = await api('/run', {
            method: 'POST',
            body: {
              workflow: props.path || props.id,
              prompt: prompts.positive,
              negativePrompt: prompts.negative,
              params: builtParams,
            },
            allowFail: true,
          })
          if (!alive.current) return
          const endedAt = Date.now()
          if (!response || response.ok === false) {
            const data = response && typeof response === 'object' ? response : {}
            setRun({
              phase: 'error',
              data,
              error: data.error ? String(data.error) : t('wf.failed'),
              startedAt,
              endedAt,
              nodeErrors: data.nodeErrors,
              warnings: Array.isArray(data.warnings) ? data.warnings : [],
            })
          } else {
            setRun({ phase: 'done', data: response, startedAt, endedAt })
          }
          props.onChanged()
        } catch (error) {
          if (!alive.current) return
          setRun({ phase: 'error', error: humanError(error, t), startedAt, endedAt: Date.now() })
          props.onChanged()
        }
      }

      const actions = [
        h('button', {
          key: 'back',
          type: 'button',
          className: 'sc-btn',
          onClick: props.onBack,
        }, h(Icon, { name: 'back', size: 13 }), t('wf.detailBack')),
        isServer
          ? h('button', {
            key: 'copyPath',
            type: 'button',
            className: 'sc-btn',
            title: props.path,
            onClick: async () => {
              const ok = await copyText(props.path)
              if (ok && alive.current) setCopiedPath(true)
            },
          }, h(Icon, { name: 'copy', size: 13 }), copiedPath ? t('wf.copiedPath') : t('wf.copyPath'))
          : null,
      ]

      let body
      if (load.phase === 'loading') {
        body = h(LoadingRow, { t, label: t('wf.loading') })
      } else if (load.phase === 'error') {
        body = h(InlineError, {
          t,
          message: load.error,
          onRetry: () => setLoadSeq((value) => value + 1),
        })
      } else {
        const hasPrompts = positiveTargets.length > 0 || negativeTargets.length > 0
        const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : []
        const recordWarnings = Array.isArray(workflow.warnings) ? workflow.warnings : []
        body = []
        if (recordWarnings.length > 0) {
          body.push(h(WarnList, {
            key: 'recordWarnings',
            warnings: recordWarnings,
            title: t('wf.importWarnings'),
          }))
        }
        if (hasPrompts) {
          const promptItems = []
          if (positiveTargets.length > 0) {
            promptItems.push(h(PromptField, {
              key: 'positive',
              id: 'sc-prompt-positive',
              label: t('wf.prompt'),
              value: prompts.positive,
              targets: positiveTargets,
              t,
              disabled: running,
              onChange: (value) => setPrompt('positive', value),
            }))
          }
          if (negativeTargets.length > 0) {
            promptItems.push(h(PromptField, {
              key: 'negative',
              id: 'sc-prompt-negative',
              label: t('wf.negativePrompt'),
              value: prompts.negative,
              targets: negativeTargets,
              t,
              disabled: running,
              onChange: (value) => setPrompt('negative', value),
            }))
          }
          body.push(h('div', { key: 'prompts', className: 'sc-promptGroup' }, promptItems))
        } else {
          body.push(h('p', { key: 'noPrompts', className: 'sc-muted' }, t('wf.promptNone')))
        }
        const capabilities = workflow.capabilities && typeof workflow.capabilities === 'object' ? workflow.capabilities : {}
        const capabilityLabels = Array.isArray(capabilities.kindLabels) ? capabilities.kindLabels : []
        const neededInputs = Array.isArray(capabilities.neededInputs) ? capabilities.neededInputs : []
        body.push(h('div', { key: 'meta', className: 'sc-section' },
          h('div', { className: 'sc-sectionHead' },
            h('span', { className: 'sc-sectionTitle' }, t('wf.capabilities')),
            h('span', { className: 'sc-cardCount' }, String(capabilityLabels.length))),
          capabilityLabels.length > 0
            ? h('div', { className: 'sc-kindChips' }, capabilityLabels.map((label, index) => h('span', { key: index, className: 'sc-kindChip' }, String(label))))
            : null,
          typeof capabilities.summary === 'string' && capabilities.summary
            ? h('p', { className: 'sc-muted' }, capabilities.summary)
            : null,
          isServer
            ? h('p', { className: 'sc-muted' }, t('wf.serverReadonly'))
            : [
              h(Field, { key: 'desc', label: t('wf.description'), htmlFor: 'sc-meta-desc' },
                h('textarea', {
                  id: 'sc-meta-desc',
                  className: 'sc-textarea',
                  rows: 3,
                  maxLength: 500,
                  value: meta.description,
                  placeholder: t('wf.descriptionHint'),
                  disabled: running,
                  onChange: (event) => setMeta((previous) => ({ ...previous, description: event.target.value, saved: false, error: null })),
                })),
              h(Field, { key: 'tags', label: t('wf.tags'), htmlFor: 'sc-meta-tags' },
                h('input', {
                  id: 'sc-meta-tags',
                  className: 'sc-input',
                  type: 'text',
                  value: meta.tags,
                  placeholder: t('wf.tagsHint'),
                  disabled: running,
                  onChange: (event) => setMeta((previous) => ({ ...previous, tags: event.target.value, saved: false, error: null })),
                })),
              h('div', { key: 'save', className: 'sc-btnRow' },
                h('button', {
                  type: 'button',
                  className: 'sc-btn sc-btnPrimary',
                  onClick: saveMeta,
                  disabled: meta.phase === 'saving' || metaInvalid || running,
                  'aria-busy': meta.phase === 'saving' ? 'true' : 'false',
                },
                  meta.phase === 'saving' ? h(Spinner) : h(Icon, { name: 'check', size: 13 }),
                  meta.phase === 'saving' ? t('common.saving') : t('wf.saveMeta')),
                meta.saved ? h('span', { className: 'sc-okLine', role: 'status' }, t('wf.savedMeta')) : null,
                metaInvalid ? h('span', { className: 'sc-muted' }, t('wf.metaInvalid')) : null),
              meta.error ? h(InlineError, { key: 'metaError', t, message: meta.error }) : null,
            ],
          neededInputs.length > 0
            ? h('div', { className: 'sc-needList' },
              h('p', { className: 'sc-sectionTitle' }, t('wf.needsInputTitle')),
              neededInputs.map((item, index) => h('div', { key: index, className: 'sc-needRow' },
                h('code', { className: 'sc-needPath' }, '#' + String(item && item.param ? item.param : '')),
                h('span', { className: 'sc-needLabel' }, String(item && item.label ? item.label : '')),
                h('span', { className: 'sc-needHint' }, String(item && item.hint ? item.hint : '')))))
            : null))
        body.push(h('div', { key: 'params', className: 'sc-section' },
          h('div', { className: 'sc-sectionHead' },
            h('span', { className: 'sc-sectionTitle' }, t('wf.paramsTitle')),
            h('span', { className: 'sc-cardCount' }, t('wf.params', { n: String(shownParams.length) }))),
          shownParams.length > 0
            ? h('div', { className: 'sc-params' }, shownParams.map((param) => h(ParamControl, {
              key: param.path,
              param,
              value: overrides[param.path],
              t,
              disabled: running,
              onChange: (value) => setParam(param.path, value),
            })))
            : h('p', { className: 'sc-muted' }, t('wf.paramsEmpty'))))
        body.push(h('details', { key: 'nodes', className: 'sc-details' },
          h('summary', { className: 'sc-detailsSummary' }, t('wf.nodesTitle') + ' · ' + String(nodes.length)),
          h('ul', { className: 'sc-nodeList' }, nodes.map((node) => h('li', {
            key: node.id,
            className: 'sc-nodeItem',
          },
            h('span', { className: 'sc-nodeId' }, '#' + String(node.id)),
            h('span', { className: 'sc-nodeClass' }, node.class ? String(node.class) : ''),
            node.title ? h('span', { className: 'sc-nodeTitle' }, String(node.title)) : null)))))
        body.push(h('div', { key: 'runbar', className: 'sc-runBar' },
          h('button', {
            type: 'button',
            className: 'sc-btn sc-btnPrimary',
            onClick: runNow,
            disabled: running,
            'aria-busy': running ? 'true' : 'false',
          },
            running ? h(Spinner) : h(Icon, { name: 'play', size: 13 }),
            running ? t('wf.running') : t('wf.run')),
          h('button', {
            type: 'button',
            className: 'sc-btn',
            onClick: resetDefaults,
            disabled: running,
          }, h(Icon, { name: 'refresh', size: 13 }), t('wf.resetDefaults')),
          running && elapsedMs !== null
            ? h('span', { className: 'sc-runInfo' }, t('wf.elapsed', { v: fmtDuration(elapsedMs) }))
            : null))
        body.push(h(RunResult, { key: 'result', t, run, elapsedMs }))
      }

      return h(Card, {
        icon: 'workflow',
        title: workflow ? workflow.name : (props.fallbackName || t('wf.title')),
        count: workflow ? sourceLabel(workflow.source, t) : null,
        actions,
      }, body)
    }

    /* ── 运行记录卡 ──────────────────────────────────────────────────────── */
    function RunsCard(props) {
      const t = props.t
      const runs = Array.isArray(props.runs) ? props.runs.slice(0, RUN_ROWS) : []
      let body
      if (runs.length === 0) {
        body = h('p', { className: 'sc-empty' }, t('runs.empty'))
      } else {
        body = h('div', { className: 'sc-runList' }, runs.map((run, index) => {
          const state = run && run.state ? String(run.state) : 'queued'
          const images = run && Array.isArray(run.images)
            ? run.images.filter((image) => image && (image.url || image.filename))
            : []
          return h('div', { key: (run && run.promptId) || index, className: 'sc-runRow' },
            h(Pill, { tone: runTone(state) }, runStateLabel(state, t)),
            h('div', { className: 'sc-runMain' },
              h('div', { className: 'sc-runTitle' }, (run && run.workflowName) || '—'),
              h('div', { className: 'sc-runMeta' },
                h('span', null, fmtTime(run && run.createdAt)),
                run && Number.isFinite(Number(run.durationMs))
                  ? h('span', null, t('wf.elapsed', { v: fmtDuration(Number(run.durationMs)) }))
                  : null),
              run && run.error
                ? h('p', { className: 'sc-errorText sc-errorLine', role: 'alert' }, String(run.error))
                : null),
            images.length > 0
              ? h('div', { className: 'sc-thumbRow' }, images.slice(0, 3).map((image, imageIndex) => {
                const url = image.url || imageUrl(image)
                const filename = image.filename ? String(image.filename) : 'image-' + (imageIndex + 1)
                return h('button', {
                  key: imageIndex,
                  type: 'button',
                  className: 'sc-thumbWrap',
                  title: filename,
                  onClick: () => openImage(url),
                }, h('img', {
                  className: 'sc-thumb',
                  src: url,
                  alt: filename,
                  loading: 'lazy',
                  onError: (event) => {
                    const node = event.currentTarget
                    if (node && node.style) node.style.display = 'none'
                  },
                }))
              }))
              : null)
        }))
      }
      return h(Card, {
        icon: 'clock',
        title: t('runs.title'),
        count: runs.length > 0 ? t('runs.count', { n: String(runs.length) }) : null,
      }, body)
    }

    /* ── 主面板 ──────────────────────────────────────────────────────────── */
    function ComfyPanel(props) {
      const t = props.t
      const locale = props.locale
      useLocaleTick(locale)
      const [boot, setBoot] = useState({ phase: 'loading' })
      const [test, setTest] = useState({ phase: 'idle', data: null, error: null })
      const [stateSeq, setStateSeq] = useState(0)
      const [testSeq, setTestSeq] = useState(0)
      const [tab, setTab] = useState('workflows')
      const tabTouched = useRef(false)

      useEffect(() => {
        let cancelled = false
        setBoot((previous) => (previous.phase === 'ok' ? previous : { phase: 'loading' }))
        api('/state').then((data) => {
          if (cancelled) return
          const normalized = normalizeState(data)
          setBoot({ phase: 'ok', data: normalized, refreshError: null })
          if (!normalized.baseUrl && !tabTouched.current) setTab('connection')
        }).catch((error) => {
          if (cancelled) return
          setBoot((previous) => {
            if (previous.phase === 'ok') return { ...previous, refreshError: humanError(error, t) }
            return { phase: 'error', error }
          })
        })
        return () => {
          cancelled = true
        }
      }, [stateSeq])

      const baseUrl = boot.phase === 'ok' ? boot.data.baseUrl : ''

      useEffect(() => {
        if (boot.phase !== 'ok') return undefined
        let cancelled = false
        setTest({ phase: 'loading', data: null, error: null })
        api('/test', {
          method: 'POST',
          body: baseUrl ? { baseUrl } : {},
          allowFail: true,
        }).then((data) => {
          if (cancelled) return
          if (data && data.ok === true) {
            setTest({ phase: 'ok', data, error: null })
            return
          }
          setTest({
            phase: 'error',
            data: data || null,
            error: (data && typeof data.error === 'string' && data.error) || t('conn.testFailed'),
          })
        }).catch((error) => {
          if (cancelled) return
          setTest({ phase: 'error', data: null, error: humanError(error, t) })
        })
        return () => {
          cancelled = true
        }
      }, [boot.phase, baseUrl, testSeq])

      function reloadState() {
        setStateSeq((value) => value + 1)
      }

      function refreshAll() {
        setStateSeq((value) => value + 1)
        setTestSeq((value) => value + 1)
      }

      function selectTab(next) {
        tabTouched.current = true
        setTab(next)
      }

      let pill
      if (boot.phase === 'loading') pill = { tone: 'busy', label: t('common.loading') }
      else if (boot.phase === 'error') pill = { tone: 'error', label: t('conn.disconnected') }
      else if (!boot.data.baseUrl) pill = { tone: 'neutral', label: t('conn.unconfigured') }
      else if (test.phase === 'loading') pill = { tone: 'busy', label: t('conn.testing') }
      else if (test.phase === 'ok') pill = { tone: 'ok', label: t('conn.connected') }
      else if (test.phase === 'error') pill = { tone: 'error', label: t('conn.disconnected') }
      else pill = { tone: 'neutral', label: t('conn.unknown') }

      const busy = boot.phase === 'loading' || test.phase === 'loading'

      let tabsBar = null
      let body
      if (boot.phase === 'loading') {
        body = h('div', { className: 'sc-loading' }, h(Spinner), h('span', null, t('common.loading')))
      } else if (boot.phase === 'error') {
        body = h('div', { className: 'sc-card' },
          h('div', { className: 'sc-errorBox' },
            h(InlineError, { t, message: humanError(boot.error, t), onRetry: refreshAll })))
      } else {
        const tabs = [
          { id: 'workflows', label: t('tab.workflows'), icon: 'workflow', count: boot.data.workflows.length },
          { id: 'models', label: t('tab.models'), icon: 'stack', count: null },
          { id: 'runs', label: t('tab.runs'), icon: 'clock', count: boot.data.lastRuns.length },
          { id: 'connection', label: t('tab.connection'), icon: 'server', count: null },
        ]
        const activeTab = tabs.some((item) => item.id === tab) ? tab : 'workflows'
        tabsBar = h('nav', { className: 'sc-tabs', role: 'tablist', 'aria-label': t('panel.title') },
          h('div', { className: 'sc-tabsInner' },
            tabs.map((item) => h('button', {
              key: item.id,
              type: 'button',
              role: 'tab',
              'aria-selected': activeTab === item.id ? 'true' : 'false',
              className: 'sc-tab',
              onClick: () => selectTab(item.id),
            },
              h(Icon, { name: item.icon, size: 14 }),
              h('span', { className: 'sc-tabLabel' }, item.label),
              item.count !== null && item.count !== undefined && item.count > 0
                ? h('span', { className: 'sc-tabCount' }, String(item.count))
                : null))))
        if (activeTab === 'connection') {
          body = h(ConnectionCard, {
            key: 'connection', t, data: boot.data, test,
            onSaved: refreshAll, onRetest: refreshAll,
          })
        } else if (activeTab === 'models') {
          body = h(ModelsCard, {
            key: 'models',
            t,
            ready: true,
            baseUrl: boot.data.baseUrl,
            onOpenConnection: () => selectTab('connection'),
          })
        } else if (activeTab === 'runs') {
          body = h(RunsCard, { key: 'runs', t, runs: boot.data.lastRuns })
        } else {
          body = h(ServerWorkflowsCard, {
            key: 'workflows',
            t,
            baseUrl: boot.data.baseUrl,
            onOpenConnection: () => selectTab('connection'),
          })
        }
      }

      return h('div', { className: 'sc-page' },
        h('header', { className: 'sc-head' },
          h('div', { className: 'sc-titleGroup' },
            h('h1', { className: 'sc-title' }, t('panel.title')),
            h('div', { className: 'sc-subRow' },
              h('p', { className: 'sc-sub' }, t('panel.subtitle')),
              h('span', { className: 'sc-version', title: t('panel.version') }, t('panel.version')))),
          h('div', { className: 'sc-headActions' },
            h(Pill, { tone: pill.tone }, pill.label),
            h('button', {
              type: 'button',
              className: 'sc-btn',
              onClick: refreshAll,
              disabled: busy,
              'aria-busy': busy ? 'true' : 'false',
              title: t('common.refresh'),
            }, busy ? h(Spinner) : h(Icon, { name: 'refresh' }), t('common.refresh'))),
          boot.phase === 'ok' && boot.refreshError
            ? h('div', { className: 'sc-headError' },
              h(InlineError, { t, message: boot.refreshError, onRetry: refreshAll }))
            : null),
        tabsBar,
        h('div', { className: 'sc-scroll' }, body))
    }

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

        const locale = (typeof ctx.get === 'function' ? ctx.get('locale') : undefined) || ctx.locale
        let t = fallbackT
        if (locale && typeof locale.register === 'function' && typeof locale.bind === 'function') {
          ctx.effect(() => locale.register(NS, { zh: ZH, en: EN }), 'dsh-sendcomfy: dictionaries')
          t = locale.bind(NS)
        }

        // 侧栏图标：id 与 main 的 key 相同，shell 会自动按 id 派发到主面板
        slots.inject('sidebar.panellist', () => slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 6, label: () => t('panel.title') },
          (iconProps) => h(ComfyIcon, iconProps),
        ))
        // 主栏面板（root scope：不依赖 Session，点开即用）
        slots.inject('main', () => slots.register(
          { name: 'main', key: PANEL_ID },
          () => h(ComfyPanel, { t, locale }),
        ))
      },
    }
  },
})
