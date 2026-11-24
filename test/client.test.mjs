/**
 * client.js 的「无浏览器」装载测试：
 * 用假的 window.__ModuleLoader__ / document / React / Cordis ctx 跑一遍插件工厂与 apply，
 * 验证注册协议（sidebar.panellist + main）、locale 字典完整性、样式注入与清理。
 * 不做渲染（没有真实 React/DOM），只验证注册面与 can-load 性。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const clientPath = join(packageRoot, 'client.js')

const REQUIRED_LOCALE_KEYS = [
  'panel.title', 'conn.title', 'conn.url', 'conn.urlHint', 'conn.timeout', 'conn.saveTest',
  'conn.saving', 'conn.connected', 'conn.disconnected', 'conn.unsaved', 'conn.latency',
  'conn.version', 'conn.device', 'models.title', 'models.refresh', 'models.empty',
  'models.loading', 'models.error', 'models.copy', 'models.copied', 'models.total',
  'wf.title', 'wf.import', 'wf.importPlaceholder', 'wf.importFromFile', 'wf.fromServer',
  'wf.listEmpty', 'wf.open', 'wf.rename', 'wf.renamePrompt', 'wf.delete', 'wf.deleteConfirm',
  'wf.nodes', 'wf.params', 'wf.source', 'wf.sourceUi', 'wf.sourceApi', 'wf.sourceServer',
  'wf.detailBack', 'wf.prompt', 'wf.negativePrompt', 'wf.run', 'wf.running',
  'wf.resetDefaults', 'wf.result', 'wf.resultEmpty', 'wf.elapsed', 'wf.failed',
  'wf.importOk', 'wf.importWarnings', 'wf.serverUnsupported', 'runs.title', 'runs.empty',
  'common.cancel', 'common.close', 'error.network',
  // §11：工作流由 AI 自主选择 —— 能力画像与用途说明/标签编辑
  'wf.capabilities', 'wf.description', 'wf.descriptionHint', 'wf.tags', 'wf.tagsHint',
  'wf.saveMeta', 'wf.savedMeta', 'wf.needsInput', 'wf.needsInputTitle', 'common.save', 'common.saving',
  'wf.kind.txt2img', 'wf.kind.img2img', 'wf.kind.inpaint', 'wf.kind.upscale', 'wf.kind.controlnet',
  'wf.kind.lora', 'wf.kind.video', 'wf.kind.audio', 'wf.kind.other',
  // v0.3.0：页签式布局 + 空状态引导 + 模型搜索
  'tab.workflows', 'tab.models', 'tab.runs', 'tab.connection',
  'wf.emptyTitle', 'wf.emptyHint', 'wf.importWorkflow',
  'models.search', 'models.noMatch', 'conn.configureCta',
  // v0.4.0：不导入模式 —— 服务器工作流浏览 + 使用时按需加载
  'wf.serverHint', 'wf.serverEmptyTitle', 'wf.serverEmptyHint', 'wf.serverLoadError',
  'wf.searchServer', 'wf.serverCount', 'wf.use', 'wf.useHint', 'wf.serverNoMatch',
  'wf.serverReadonly', 'wf.copyPath', 'wf.copiedPath',
]

function makeReactStub() {
  const createElement = (...args) => ({ args })
  const hook = (initial) => [typeof initial === 'function' ? initial() : initial, () => {}]
  return {
    createElement,
    useState: hook,
    useMemo: (factory) => factory(),
    useCallback: (fn) => fn,
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
    Fragment: Symbol('Fragment'),
  }
}

async function loadClientModule() {
  const source = await readFile(clientPath, 'utf8')
  const captured = { definition: null }
  globalThis.window = {
    __ModuleLoader__: {
      load(definition) {
        captured.definition = definition
      },
    },
  }
  const styleNodes = []
  const headNodes = []
  globalThis.document = {
    head: {
      appendChild(node) {
        headNodes.push(node)
      },
    },
    createElement(tag) {
      const node = {
        tagName: tag,
        setAttribute() {},
        remove() {},
        textContent: '',
        _removed: false,
      }
      styleNodes.push(node)
      return node
    },
  }
  await import(`${pathToFileURL(clientPath).href}?v=${Date.now()}-${Math.random()}`)
  return { captured, styleNodes, headNodes, source }
}

test('client.js 通过 window.__ModuleLoader__ 注册，id 与包名一致', async () => {
  const { captured } = await loadClientModule()
  assert.ok(captured.definition, '没有调用 window.__ModuleLoader__.load')
  assert.equal(captured.definition.id, 'dsh-sendcomfy')
  assert.equal(typeof captured.definition.factory, 'function')
})

test('factory/apply 注册 sidebar.panellist + main，label 是 locale thunk', async () => {
  const { captured } = await loadClientModule()
  const registrations = []
  const injected = []
  const effects = []
  const localeDicts = []
  const translations = {}

  const slots = {
    inject(key, callback) {
      injected.push(key)
      const cleanup = callback()
      effects.push(cleanup)
      return cleanup
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  }
  const locale = {
    register(namespace, dicts) {
      localeDicts.push({ namespace, dicts })
      return () => {}
    },
    bind(namespace) {
      return (key, params) => {
        const dict = localeDicts.find((item) => item.namespace === namespace)
        const zh = dict?.dicts?.zh || dict?.dicts?.['zh-CN'] || {}
        const en = dict?.dicts?.en || {}
        const value = zh[key] ?? en[key] ?? key
        translations[key] = value
        return value
      }
    },
    getSnapshot() {
      return { locale: 'zh', language: 'zh' }
    },
  }
  const ctx = {
    get(name) {
      if (name === 'slots') return slots
      if (name === 'layout') return { selectPanel() {} }
      if (name === 'locale') return locale
      return undefined
    },
    slots,
    locale,
    effect(factory) {
      effects.push(factory())
      return () => {}
    },
  }

  const plugin = captured.definition.factory((id) => {
    assert.equal(id, 'react')
    return makeReactStub()
  })
  assert.ok(Array.isArray(plugin.inject))
  for (const required of ['slots', 'layout', 'locale']) {
    assert.ok(plugin.inject.includes(required), `inject 缺少 ${required}`)
  }
  plugin.apply(ctx)

  const side = registrations.find((item) => item.options.name === 'sidebar.panellist')
  const main = registrations.find((item) => item.options.name === 'main')
  assert.ok(side, '没有注册 sidebar.panellist')
  assert.ok(main, '没有注册 main')
  assert.equal(side.options.id, 'dsh-sendcomfy')
  assert.equal(main.options.key, 'dsh-sendcomfy')
  assert.equal(typeof side.options.label, 'function')
  assert.equal(typeof side.options.label(), 'string')
  assert.ok(side.options.label().length > 0)
  assert.equal(typeof side.component, 'function')
  assert.equal(typeof main.component, 'function')

  assert.ok(localeDicts.length >= 1, '没有通过 ctx.locale.register 注册文案')
  const dicts = localeDicts.reduce((acc, item) => ({ ...acc, ...item.dicts }), {})
  assert.ok(dicts.zh, '缺少 zh 字典')
  assert.ok(dicts.en, '缺少 en 字典')

  // 源码里所有 t('key') 的 key 都应该有中文文案
  const { source } = await loadClientModule()
  const usedKeys = new Set([...source.matchAll(/\bt\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1]))
  const missing = [...usedKeys].filter((key) => !(key in dicts.zh))
  assert.deepEqual(missing, [], `以下 t() key 缺中文文案：${missing.join(', ')}`)
  const missingEn = [...usedKeys].filter((key) => !(key in dicts.en))
  assert.deepEqual(missingEn, [], `以下 t() key 缺英文文案：${missingEn.join(', ')}`)
  const requiredMissing = REQUIRED_LOCALE_KEYS.filter((key) => !(key in dicts.zh))
  assert.deepEqual(requiredMissing, [], `CONTRACT §7.3 要求的 key 缺失：${requiredMissing.join(', ')}`)
})

test('样式注入 <style data-plugin-css="dsh-sendcomfy"> 且只在 apply 里注入一次', async () => {
  const { captured } = await loadClientModule()
  const styles = []
  const ctx = {
    get(name) {
      if (name === 'slots') {
        return { inject() {}, register() { return () => {} } }
      }
      if (name === 'locale') {
        return {
          register() { return () => {} },
          bind() { return (key) => key },
          getSnapshot() { return { locale: 'zh' } },
        }
      }
      if (name === 'layout') return { selectPanel() {} }
      return undefined
    },
    effect(factory) {
      factory()
      return () => {}
    },
  }
  const originalCreate = globalThis.document.createElement
  globalThis.document.createElement = (tag) => {
    const node = { tagName: tag, setAttribute(name, value) { node[name] = value }, remove() {}, textContent: '' }
    styles.push(node)
    return node
  }
  try {
    const plugin = captured.definition.factory(() => makeReactStub())
    plugin.apply(ctx)
  } finally {
    globalThis.document.createElement = originalCreate
  }
  assert.equal(styles.length, 1, '应只创建一个 <style> 节点')
  assert.equal(styles[0].tagName, 'style')
  assert.equal(styles[0]['data-plugin-css'], 'dsh-sendcomfy')
  assert.ok(styles[0].textContent.length > 200, '样式内容太少')
})

test('client.js 不 import @deepseek-ai 包、不使用硬编码颜色（图标 currentColor 除外）', async () => {
  const source = await readFile(clientPath, 'utf8')
  assert.equal(/require\(['"]@deepseek-ai\//.test(source), false, '不允许 require @deepseek-ai/*')
  assert.equal(/^import .*@deepseek-ai/m.test(source), false, '不允许 import @deepseek-ai/*')
  const colorLiterals = source.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g) || []
  assert.deepEqual(colorLiterals, [], `发现硬编码颜色：${colorLiterals.slice(0, 8).join(', ')}`)
  assert.match(source, /--dsw-alias-/, '应使用 --dsw-alias-* 主题 token')
  assert.equal(/document\.body/.test(source), false, '不允许操作 document.body')
})
