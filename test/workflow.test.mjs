/**
 * dsh-sendcomfy — lib/workflow.mjs 测试
 *
 * 运行（必须用绝对路径的 node，且 cwd 不要设成包目录）：
 *   cd /tmp && node --test <本仓库目录>/test/workflow.test.mjs
 *
 * fixtures 一律用 import.meta.url 定位（不依赖 process.cwd()）；测试只读，不写包目录。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  parseWorkflowJson,
  uiToApiGraph,
  buildParamSpecs,
  applyParamOverrides,
  applyPrompts,
  mergeImport,
  summarizeGraph,
} from '../lib/workflow.mjs'

const fixtureUrl = (name) => new URL(`./fixtures/${name}`, import.meta.url)
const loadFixture = (name) => JSON.parse(readFileSync(fixtureUrl(name), 'utf8'))

const uiSimple = loadFixture('workflow-ui-simple.json')
const uiReroute = loadFixture('workflow-ui-reroute.json')
const objectInfo = loadFixture('object-info.json')
const apiFixture = loadFixture('workflow-api.json')

const byPath = (params, path) => params.find((param) => param.path === path)
const graphJson = (graph) => JSON.stringify(graph)

/** 由「简单 UI 图 + object_info」得到 API 图与参数，供多组测试复用。 */
function simpleFixture() {
  const converted = uiToApiGraph(uiSimple, objectInfo)
  const specs = buildParamSpecs(converted.apiGraph, objectInfo)
  return { apiGraph: converted.apiGraph, warnings: converted.warnings, ...specs }
}

function expectBadWorkflow(fn) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, 'EBAD_WORKFLOW')
    return true
  })
}

// ---------------------------------------------------------------------------
// fixtures 自检
// ---------------------------------------------------------------------------

describe('fixtures', () => {
  it('所有 fixture 都是合法 JSON 且形状符合 ComfyUI 真实导出', () => {
    for (const name of ['workflow-ui-simple.json', 'workflow-ui-reroute.json', 'object-info.json', 'workflow-api.json']) {
      const data = loadFixture(name)
      assert.equal(typeof data, 'object')
      assert.ok(data !== null)
    }
    assert.ok(Array.isArray(uiSimple.nodes) && uiSimple.nodes.length === 7)
    assert.ok(Array.isArray(uiSimple.links) && uiSimple.links.length === 9)
    assert.equal(uiSimple.version, 0.4)
    // UI 图里必须出现 Reroute / PrimitiveNode / Note / mode=4 bypass 的真实形态
    const types = uiReroute.nodes.map((node) => node.type)
    assert.ok(types.includes('Reroute'))
    assert.ok(types.includes('PrimitiveNode'))
    assert.ok(types.includes('Note'))
    assert.ok(types.includes('MarkdownNote'))
    assert.ok(uiReroute.nodes.some((node) => node.mode === 4))
    // API 图的链路值必须是 [String(id), slot]
    assert.deepEqual(apiFixture['3'].inputs.model, ['4', 0])
    assert.equal(typeof apiFixture['3'].class_type, 'string')
    // object_info 里既有老式枚举 [选项数组, opts]，也有 control_after_generate
    assert.ok(Array.isArray(objectInfo.KSampler.input.required.sampler_name[0]))
    assert.equal(objectInfo.KSampler.input.required.seed[1].control_after_generate, true)
    assert.equal(objectInfo.CLIPTextEncode.input.required.text[1].multiline, true)
  })
})

// ---------------------------------------------------------------------------
// parseWorkflowJson
// ---------------------------------------------------------------------------

describe('parseWorkflowJson', () => {
  it('识别 UI 格式对象', () => {
    const parsed = parseWorkflowJson(uiSimple)
    assert.equal(parsed.format, 'ui')
    assert.equal(parsed.raw, uiSimple)
  })

  it('识别 API 格式对象', () => {
    const parsed = parseWorkflowJson(apiFixture)
    assert.equal(parsed.format, 'api')
    assert.equal(parsed.raw, apiFixture)
  })

  it('识别 JSON 字符串（UI）', () => {
    const parsed = parseWorkflowJson(JSON.stringify(uiSimple))
    assert.equal(parsed.format, 'ui')
    assert.equal(parsed.raw.nodes.length, 7)
  })

  it('识别 JSON 字符串（API）', () => {
    const parsed = parseWorkflowJson(JSON.stringify(apiFixture))
    assert.equal(parsed.format, 'api')
    assert.equal(parsed.raw['3'].class_type, 'KSampler')
  })

  it('识别 { workflow: UI图 } 包装', () => {
    const parsed = parseWorkflowJson({ workflow: uiSimple })
    assert.equal(parsed.format, 'ui')
    assert.equal(parsed.raw.nodes.length, 7)
  })

  it('识别 { prompt: API图 } 包装', () => {
    const parsed = parseWorkflowJson({ prompt: apiFixture })
    assert.equal(parsed.format, 'api')
    assert.equal(parsed.raw['3'].class_type, 'KSampler')
  })

  it('同时有 workflow 与 prompt 时优先 workflow', () => {
    const parsed = parseWorkflowJson({ workflow: uiSimple, prompt: apiFixture })
    assert.equal(parsed.format, 'ui')
  })

  it('非法输入抛 EBAD_WORKFLOW', () => {
    for (const bad of [null, undefined, 42, [], {}, { nodes: [] }, { hello: 'world' }]) {
      expectBadWorkflow(() => parseWorkflowJson(bad))
    }
    expectBadWorkflow(() => parseWorkflowJson(''))
    expectBadWorkflow(() => parseWorkflowJson('   '))
    expectBadWorkflow(() => parseWorkflowJson('not json at all'))
    expectBadWorkflow(() => parseWorkflowJson('"just a string"'))
  })
})

// ---------------------------------------------------------------------------
// uiToApiGraph —— 简单官方模板
// ---------------------------------------------------------------------------

describe('uiToApiGraph（简单官方模板 + objectInfo）', () => {
  const expected = {
    3: {
      class_type: 'KSampler',
      inputs: {
        model: ['4', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['5', 0],
        seed: 156680208700286,
        steps: 20,
        cfg: 8,
        sampler_name: 'euler',
        scheduler: 'normal',
        denoise: 1,
      },
    },
    4: {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: 'v1-5-pruned-emaonly-fp16.safetensors' },
    },
    5: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
    6: {
      class_type: 'CLIPTextEncode',
      inputs: { clip: ['4', 1], text: 'a beautiful landscape, masterpiece, best quality' },
      _meta: { title: 'Positive' },
    },
    7: {
      class_type: 'CLIPTextEncode',
      inputs: { clip: ['4', 1], text: 'blurry, low quality, watermark' },
      _meta: { title: 'Negative' },
    },
    8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    9: { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'ComfyUI' } },
  }

  it('逐节点转换结果正确（含 KSampler 小部件值、链路槽号、_meta.title）', () => {
    const { apiGraph, warnings } = uiToApiGraph(uiSimple, objectInfo)
    assert.deepEqual(warnings, [])
    assert.deepEqual(apiGraph, expected)
  })

  it('KSampler 的 seed 后控制值 "randomize" 被跳过', () => {
    const { apiGraph } = uiToApiGraph(uiSimple, objectInfo)
    assert.equal(apiGraph['3'].inputs.seed, 156680208700286)
    assert.equal(apiGraph['3'].inputs.steps, 20)
    assert.equal(apiGraph['3'].inputs.cfg, 8)
    assert.equal(apiGraph['3'].inputs.sampler_name, 'euler')
    assert.equal(apiGraph['3'].inputs.scheduler, 'normal')
    assert.equal(apiGraph['3'].inputs.denoise, 1)
  })

  it('链路值形如 [String(源节点id), 源输出槽]', () => {
    const { apiGraph } = uiToApiGraph(uiSimple, objectInfo)
    const model = apiGraph['3'].inputs.model
    assert.deepEqual(model, ['4', 0])
    assert.equal(typeof model[0], 'string')
    assert.equal(typeof model[1], 'number')
    assert.deepEqual(apiGraph['9'].inputs.images, ['8', 0])
  })

  it('objectInfo 缺失时降级：内置 schema 仍能正确转换，且给出 warnings', () => {
    const withInfo = uiToApiGraph(uiSimple, objectInfo)
    const without = uiToApiGraph(uiSimple)
    assert.deepEqual(without.apiGraph, withInfo.apiGraph)
    assert.ok(without.warnings.length > 0)
    assert.ok(without.warnings.some((warning) => warning.includes('object_info')))
  })

  it('空 objectInfo 对象等同于缺失', () => {
    const without = uiToApiGraph(uiSimple)
    const emptyInfo = uiToApiGraph(uiSimple, {})
    assert.deepEqual(emptyInfo.apiGraph, without.apiGraph)
    assert.ok(emptyInfo.warnings.length > 0)
  })

  it('objectInfo 缺某个类时只用该类降级，其余仍按 object_info 映射', () => {
    const partial = { ...objectInfo }
    delete partial.KSampler
    const { apiGraph, warnings } = uiToApiGraph(uiSimple, partial)
    assert.deepEqual(apiGraph, expected)
    assert.ok(warnings.some((warning) => warning.includes('KSampler')))
  })

  it('小部件数量与 object_info 预期不一致时给出警告', () => {
    const mutated = structuredClone(uiSimple)
    // 删掉 KSampler 的一个小部件值，制造错位
    mutated.nodes.find((node) => node.type === 'KSampler').widgets_values.pop()
    const { warnings } = uiToApiGraph(mutated, objectInfo)
    assert.ok(warnings.some((warning) => warning.includes('不一致')))
  })

  it('新版核心节点（PrimitiveInt/RandomNoise）无 objectInfo 时按内置 schema 映射', () => {
    const ui = {
      nodes: [
        {
          id: 1,
          type: 'PrimitiveInt',
          inputs: [{ name: 'value', type: 'INT', widget: { name: 'value' }, link: null }],
          outputs: [{ name: 'INT', type: 'INT', links: [1] }],
          widgets_values: [6, 'fixed'],
        },
        {
          id: 2,
          type: 'RandomNoise',
          inputs: [{ name: 'noise_seed', type: 'INT', widget: { name: 'noise_seed' }, link: null }],
          outputs: [{ name: 'NOISE', type: 'NOISE', links: [] }],
          widgets_values: [123456789, 'randomize'],
        },
      ],
      links: [],
    }
    const { apiGraph } = uiToApiGraph(ui)
    assert.deepEqual(apiGraph['1'].inputs, { value: 6 })
    assert.deepEqual(apiGraph['2'].inputs, { noise_seed: 123456789 })
  })

  it('新版导出 widgets_values_named：按名字对位，不认识的值不会混入 inputs', () => {
    const ui = {
      nodes: [
        {
          id: 1,
          type: 'CustomNode',
          inputs: [
            { name: 'clip', type: 'CLIP', link: null },
            { name: 'text', type: 'STRING', widget: { name: 'text' }, link: null },
            { name: 'strength', type: 'FLOAT', widget: { name: 'strength' }, link: null },
          ],
          outputs: [],
          widgets_values_named: { text: 'hello from named', strength: 0.75, upload: 'image', other: 1 },
        },
      ],
      links: [],
    }
    const { apiGraph, warnings } = uiToApiGraph(ui)
    assert.deepEqual(apiGraph['1'].inputs, { text: 'hello from named', strength: 0.75 })
    assert.ok(warnings.some((warning) => warning.includes('object_info')))
  })

  it('不支持子图节点时跳过并警告，但保留其余可执行节点', () => {
    const converted = uiToApiGraph(uiReroute, objectInfo)
    assert.equal(Object.keys(converted.apiGraph).length, 7)
    const subgraphUi = {
      nodes: [
        { id: 1, type: '9d2d6e1b-1111-2222-3333-444455556666', pos: [0, 0], inputs: [], outputs: [] },
        { id: 2, type: 'SaveImage', pos: [0, 0], inputs: [], outputs: [], widgets_values: ['x'] },
      ],
      links: [],
      definitions: { subgraphs: [{ id: '9d2d6e1b-1111-2222-3333-444455556666', nodes: [], links: [] }] },
    }
    const result = uiToApiGraph(subgraphUi, objectInfo)
    assert.deepEqual(Object.keys(result.apiGraph), ['2'])
    assert.ok(result.warnings.some((warning) => warning.includes('子图')))
  })
})

// ---------------------------------------------------------------------------
// uiToApiGraph —— Reroute / PrimitiveNode / bypass / Note
// ---------------------------------------------------------------------------

describe('uiToApiGraph（Reroute / PrimitiveNode / bypass / Note）', () => {
  const expected = {
    3: {
      class_type: 'KSampler',
      inputs: {
        model: ['4', 0], // 穿过 mode=4 的 LoraLoaderModelOnly 透传到 checkpoint
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['5', 0],
        seed: 12345, // 来自 PrimitiveNode 的字面量，覆盖 widgets_values 里的 42
        steps: 25,
        cfg: 7.5,
        sampler_name: 'dpmpp_2m',
        scheduler: 'karras',
        denoise: 0.9,
      },
    },
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'dreamshaper_8.safetensors' } },
    5: { class_type: 'EmptyLatentImage', inputs: { width: 768, height: 512, batch_size: 1 } },
    6: {
      class_type: 'CLIPTextEncode',
      inputs: { clip: ['4', 1], text: 'a cat sitting on a windowsill, golden hour' },
      _meta: { title: 'Positive' },
    },
    7: {
      class_type: 'CLIPTextEncode',
      inputs: { clip: ['4', 1], text: 'ugly, blurry, low resolution' },
      _meta: { title: 'Negative' },
    },
    8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    9: { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'ComfyUI' } },
  }

  it('Reroute 透明穿透（两次串联），并保持真实源槽号', () => {
    const { apiGraph } = uiToApiGraph(uiReroute, objectInfo)
    assert.deepEqual(apiGraph['6'].inputs.clip, ['4', 1])
    assert.deepEqual(apiGraph['3'].inputs.negative, ['7', 0])
  })

  it('PrimitiveNode 的字面量作为输入值（且优先于 widgets_values 里的旧值）', () => {
    const { apiGraph } = uiToApiGraph(uiReroute, objectInfo)
    assert.equal(apiGraph['3'].inputs.seed, 12345)
    assert.notDeepEqual(apiGraph['3'].inputs.seed, ['12', 0])
  })

  it('mode=4 bypass 节点按同类型输入透传，并写 warnings', () => {
    const { apiGraph, warnings } = uiToApiGraph(uiReroute, objectInfo)
    assert.deepEqual(apiGraph['3'].inputs.model, ['4', 0])
    assert.ok(warnings.some((warning) => warning.includes('bypass')))
  })

  it('Reroute / PrimitiveNode / Note / MarkdownNote 不写入 API 图', () => {
    const { apiGraph } = uiToApiGraph(uiReroute, objectInfo)
    assert.deepEqual(Object.keys(apiGraph).sort((a, b) => Number(a) - Number(b)), ['3', '4', '5', '6', '7', '8', '9'])
    for (const id of ['10', '11', '12', '13', '14', '15']) assert.equal(apiGraph[id], undefined)
  })

  it('objectInfo 缺失时 reroute 图降级结果与有 object_info 时一致', () => {
    const withInfo = uiToApiGraph(uiReroute, objectInfo)
    const without = uiToApiGraph(uiReroute)
    assert.deepEqual(without.apiGraph, withInfo.apiGraph)
    assert.ok(without.warnings.length > 0)
  })

  it('mode=2 静音节点的下游连线无法解析但整图不崩', () => {
    const ui = {
      nodes: [
        {
          id: 1,
          type: 'VAEDecode',
          mode: 2,
          inputs: [],
          outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [1] }],
          widgets_values: [],
        },
        { id: 2, type: 'PreviewImage', inputs: [{ name: 'images', type: 'IMAGE', link: 1 }], outputs: [], widgets_values: [] },
      ],
      links: [[1, 1, 0, 2, 0, 'IMAGE']],
    }
    const { apiGraph, warnings } = uiToApiGraph(ui)
    assert.deepEqual(Object.keys(apiGraph), ['2'])
    assert.equal(apiGraph['2'].inputs.images, undefined)
    assert.ok(warnings.some((warning) => warning.includes('mode=2')))
  })

  it('悬空连线只出警告，不抛错', () => {
    const ui = {
      nodes: [{ id: 2, type: 'SaveImage', inputs: [{ name: 'images', type: 'IMAGE', link: 9 }], outputs: [], widgets_values: ['x'] }],
      links: [],
    }
    const { apiGraph, warnings } = uiToApiGraph(ui, objectInfo)
    assert.equal(apiGraph['2'].inputs.images, undefined)
    assert.equal(apiGraph['2'].inputs.filename_prefix, 'x')
    assert.ok(warnings.some((warning) => warning.includes('不存在')))
  })

  it('环形 Reroute 连线不会死循环，只写警告', () => {
    const ui = {
      nodes: [
        { id: 1, type: 'Reroute', inputs: [{ name: '', type: '*', link: 11 }], outputs: [{ name: '', type: '*', links: [12] }] },
        { id: 2, type: 'Reroute', inputs: [{ name: '', type: '*', link: 12 }], outputs: [{ name: '', type: '*', links: [11] }] },
        { id: 3, type: 'PreviewImage', inputs: [{ name: 'images', type: 'IMAGE', link: 13 }], outputs: [], widgets_values: [] },
      ],
      links: [
        [11, 2, 0, 1, 0, '*'],
        [12, 1, 0, 2, 0, '*'],
        [13, 2, 0, 3, 0, 'IMAGE'],
      ],
    }
    const { apiGraph, warnings } = uiToApiGraph(ui)
    assert.equal(apiGraph['3'].inputs.images, undefined)
    assert.ok(warnings.some((warning) => warning.includes('环形')))
  })

  it('全部节点都不可执行时抛 EBAD_WORKFLOW', () => {
    const onlyNotes = {
      nodes: [
        { id: 1, type: 'Note', inputs: [], outputs: [], widgets_values: ['note'] },
        { id: 2, type: 'Reroute', inputs: [], outputs: [], widgets_values: [] },
      ],
      links: [],
    }
    expectBadWorkflow(() => uiToApiGraph(onlyNotes))
    expectBadWorkflow(() => uiToApiGraph({ nodes: [], links: [] }))
  })

  it('纯子图工作流抛 EBAD_WORKFLOW，且错误信息给出可操作提示', () => {
    const onlySubgraph = {
      nodes: [{ id: 1, type: 'sg-1', inputs: [], outputs: [] }],
      links: [],
      definitions: { subgraphs: [{ id: 'sg-1', nodes: [], links: [] }] },
    }
    assert.throws(
      () => uiToApiGraph(onlySubgraph),
      (error) => {
        assert.equal(error.code, 'EBAD_WORKFLOW')
        assert.ok(error.message.includes('子图'))
        return true
      },
    )
  })
})

// ---------------------------------------------------------------------------
// buildParamSpecs
// ---------------------------------------------------------------------------

describe('buildParamSpecs', () => {
  it('参数按「prompt 目标（positive 在前）→ 节点数值序 → 输入顺序」排序', () => {
    const { params } = simpleFixture()
    assert.deepEqual(
      params.map((param) => param.path),
      [
        '6.text',
        '7.text',
        '3.seed',
        '3.steps',
        '3.cfg',
        '3.sampler_name',
        '3.scheduler',
        '3.denoise',
        '4.ckpt_name',
        '5.width',
        '5.height',
        '5.batch_size',
        '9.filename_prefix',
      ],
    )
  })

  it('提示词目标按 title 正负归类', () => {
    const { promptTargets } = simpleFixture()
    assert.deepEqual(promptTargets, { positive: ['6.text'], negative: ['7.text'] })
  })

  it('提示词参数带 isPrompt / multiline / nodeTitle', () => {
    const { params } = simpleFixture()
    const positive = byPath(params, '6.text')
    assert.equal(positive.type, 'string')
    assert.equal(positive.isPrompt, true)
    assert.equal(positive.multiline, true)
    assert.equal(positive.nodeTitle, 'Positive')
    assert.equal(positive.nodeClass, 'CLIPTextEncode')
    assert.equal(byPath(params, '7.text').isPrompt, true)
    assert.equal(byPath(params, '7.text').nodeTitle, 'Negative')
  })

  it('枚举参数带 options（老式 [选项数组, opts] 形态）', () => {
    const { params } = simpleFixture()
    const sampler = byPath(params, '3.sampler_name')
    assert.equal(sampler.type, 'enum')
    assert.deepEqual(sampler.options, ['euler', 'euler_ancestral', 'heun', 'dpmpp_2m', 'dpmpp_sde', 'ddim', 'lcm'])
    const scheduler = byPath(params, '3.scheduler')
    assert.equal(scheduler.type, 'enum')
    assert.deepEqual(scheduler.options, ['normal', 'karras', 'exponential', 'sgm_uniform', 'simple', 'ddim_uniform', 'beta'])
    assert.equal(byPath(params, '4.ckpt_name').type, 'enum')
    assert.deepEqual(byPath(params, '4.ckpt_name').options, [
      'v1-5-pruned-emaonly-fp16.safetensors',
      'sd_xl_base_1.0.safetensors',
      'dreamshaper_8.safetensors',
    ])
  })

  it('INT/FLOAT 约束转成 min/max/step，类型正确', () => {
    const { params } = simpleFixture()
    const seed = byPath(params, '3.seed')
    assert.equal(seed.type, 'integer')
    assert.equal(seed.min, 0)
    assert.equal(seed.max, Number('18446744073709551615'))
    const steps = byPath(params, '3.steps')
    assert.equal(steps.type, 'integer')
    assert.equal(steps.min, 1)
    assert.equal(steps.max, 10000)
    assert.equal(steps.step, undefined)
    const cfg = byPath(params, '3.cfg')
    assert.equal(cfg.type, 'number')
    assert.equal(cfg.min, 0)
    assert.equal(cfg.max, 100)
    assert.equal(cfg.step, 0.1)
    const denoise = byPath(params, '3.denoise')
    assert.equal(denoise.type, 'number')
    assert.equal(denoise.min, 0)
    assert.equal(denoise.max, 1)
    assert.equal(denoise.step, 0.01)
    const width = byPath(params, '5.width')
    assert.equal(width.type, 'integer')
    assert.equal(width.min, 16)
    assert.equal(width.step, 8)
    const filenamePrefix = byPath(params, '9.filename_prefix')
    assert.equal(filenamePrefix.type, 'string')
    assert.equal(filenamePrefix.multiline, undefined)
  })

  it('跳过链路值、数组、对象（不生成参数）', () => {
    const graph = {
      1: {
        class_type: 'Whatever',
        inputs: { model: ['2', 0], list: [1, 2], nested: { a: 1 }, text: 'hi' },
      },
    }
    const { params } = buildParamSpecs(graph)
    assert.deepEqual(
      params.map((param) => param.path),
      ['1.text'],
    )
  })

  it('objectInfo 缺失时按 JS 值推断类型', () => {
    const { params, promptTargets } = simpleFixture()
    const noInfo = buildParamSpecs(JSON.parse(JSON.stringify(simpleFixture().apiGraph)))
    const find = (path) => byPath(noInfo.params, path)
    assert.equal(find('3.seed').type, 'integer')
    assert.equal(find('3.steps').type, 'integer')
    assert.equal(find('3.cfg').type, 'integer') // 8 是整数，按值推断
    assert.equal(find('3.sampler_name').type, 'string')
    assert.equal(find('3.sampler_name').options, undefined)
    assert.equal(find('4.ckpt_name').type, 'string')
    // 提示词归类来自 _meta.title，与 objectInfo 无关
    assert.deepEqual(noInfo.promptTargets, promptTargets)
    assert.equal(params.length, noInfo.params.length)
  })

  it('没有 title 的多个文本节点：第一个非 negative 归 positive，其余不归类', () => {
    const graph = {
      1: { class_type: 'CLIPTextEncode', inputs: { text: 'first', clip: ['9', 0] } },
      2: { class_type: 'CLIPTextEncode', inputs: { text: 'second', clip: ['9', 0] } },
    }
    const { params, promptTargets } = buildParamSpecs(graph)
    assert.deepEqual(promptTargets.positive, ['1.text'])
    assert.deepEqual(promptTargets.negative, [])
    assert.equal(byPath(params, '1.text').isPrompt, true)
    assert.equal(byPath(params, '2.text').isPrompt, undefined)
  })

  it('未命名文本节点按 KSampler positive/negative 连线归类（官方默认模板场景）', () => {
    const graph = {
      3: {
        class_type: 'KSampler',
        inputs: { model: ['4', 0], positive: ['6', 0], negative: ['7', 0] },
      },
      6: { class_type: 'CLIPTextEncode', inputs: { text: 'pos prompt', clip: ['4', 1] } },
      7: { class_type: 'CLIPTextEncode', inputs: { text: 'neg prompt', clip: ['4', 1] } },
    }
    const { promptTargets } = buildParamSpecs(graph)
    assert.deepEqual(promptTargets, { positive: ['6.text'], negative: ['7.text'] })
  })

  it('拓扑归类可以穿过中间 conditioning 节点', () => {
    const graph = {
      3: { class_type: 'KSampler', inputs: { positive: ['5', 0], negative: ['8', 0] } },
      5: { class_type: 'ConditioningSetArea', inputs: { conditioning: ['6', 0], width: 512 } },
      6: { class_type: 'CLIPTextEncode', inputs: { text: 'pos' } },
      8: { class_type: 'CLIPTextEncode', inputs: { text: 'neg' } },
    }
    const { promptTargets } = buildParamSpecs(graph)
    assert.deepEqual(promptTargets, { positive: ['6.text'], negative: ['8.text'] })
  })

  it('显式 title 优先于拓扑推断', () => {
    const graph = {
      3: { class_type: 'KSampler', inputs: { positive: ['7', 0], negative: ['6', 0] } },
      6: { class_type: 'CLIPTextEncode', inputs: { text: 'a' }, _meta: { title: 'Positive' } },
      7: { class_type: 'CLIPTextEncode', inputs: { text: 'b' }, _meta: { title: 'Negative' } },
    }
    const { promptTargets } = buildParamSpecs(graph)
    assert.deepEqual(promptTargets, { positive: ['6.text'], negative: ['7.text'] })
  })

  it('中文标题 / 正向 负向 也能归类', () => {
    const graph = {
      1: { class_type: 'CLIPTextEncode', inputs: { text: 'a', clip: ['9', 0] }, _meta: { title: '正面提示词' } },
      2: { class_type: 'CLIPTextEncode', inputs: { text: 'b', clip: ['9', 0] }, _meta: { title: '负面提示词' } },
    }
    const { promptTargets } = buildParamSpecs(graph)
    assert.deepEqual(promptTargets, { positive: ['1.text'], negative: ['2.text'] })
  })

  it('提示词经连线转接到 PrimitiveString 节点时，把上游字符串参数登记为提示词目标', () => {
    // 子图展开后的典型形态：CLIPTextEncode.text 是连线（来自子图外的 PrimitiveStringMultiline）
    const graph = {
      10: { class_type: 'CFGGuider', inputs: { positive: ['20', 0], negative: ['21', 0], cfg: 3 } },
      20: { class_type: 'CLIPTextEncode', inputs: { text: ['30', 0], clip: ['9', 0] }, _meta: { title: 'CLIP Text Encode (Positive Prompt)' } },
      21: { class_type: 'CLIPTextEncode', inputs: { text: 'bad quality' } },
      30: { class_type: 'PrimitiveStringMultiline', inputs: { value: 'a cyberpunk cat' }, _meta: { title: 'Prompt' } },
    }
    const { params, promptTargets } = buildParamSpecs(graph)
    assert.deepEqual(promptTargets.positive, ['30.value'])
    assert.deepEqual(promptTargets.negative, ['21.text'])
    assert.equal(params.find((param) => param.path === '30.value').isPrompt, true)
  })

  it('API 格式图推导结果与 UI 转换图一致', () => {
    const fromUi = buildParamSpecs(uiToApiGraph(uiSimple, objectInfo).apiGraph, objectInfo)
    const fromApi = buildParamSpecs(apiFixture, objectInfo)
    assert.deepEqual(
      fromApi.params.map((param) => param.path),
      fromUi.params.map((param) => param.path),
    )
    assert.deepEqual(fromApi.promptTargets, fromUi.promptTargets)
    assert.equal(byPath(fromApi.params, '3.sampler_name').type, 'enum')
  })
})

// ---------------------------------------------------------------------------
// applyParamOverrides
// ---------------------------------------------------------------------------

describe('applyParamOverrides', () => {
  it('数字字符串按 number 转，不改入参', () => {
    const { apiGraph, params } = simpleFixture()
    const before = graphJson(apiGraph)
    const result = applyParamOverrides(apiGraph, params, {
      '3.seed': '777',
      '3.steps': '30',
      '3.cfg': '4.5',
      '3.sampler_name': 'dpmpp_2m',
      '3.scheduler': 'karras',
      '4.ckpt_name': 'dreamshaper_8.safetensors',
    })
    assert.deepEqual(result.warnings, [])
    assert.equal(result.applied.length, 6)
    assert.equal(result.apiGraph['3'].inputs.seed, 777)
    assert.equal(result.apiGraph['3'].inputs.steps, 30)
    assert.equal(result.apiGraph['3'].inputs.cfg, 4.5)
    assert.equal(result.apiGraph['3'].inputs.sampler_name, 'dpmpp_2m')
    assert.equal(result.apiGraph['4'].inputs.ckpt_name, 'dreamshaper_8.safetensors')
    assert.equal(typeof result.apiGraph['3'].inputs.seed, 'number')
    assert.equal(graphJson(apiGraph), before, '入参 apiGraph 不能被修改')
    assert.notEqual(result.apiGraph, apiGraph)
  })

  it('字符串类型的数字保持字符串', () => {
    const { apiGraph, params } = simpleFixture()
    const result = applyParamOverrides(apiGraph, params, { '9.filename_prefix': '123' })
    assert.deepEqual(result.warnings, [])
    assert.equal(result.apiGraph['9'].inputs.filename_prefix, '123')
    assert.equal(typeof result.apiGraph['9'].inputs.filename_prefix, 'string')
  })

  it('不存在的 path 给警告且不写入', () => {
    const { apiGraph, params } = simpleFixture()
    const before = graphJson(apiGraph)
    const result = applyParamOverrides(apiGraph, params, { '99.nope': 1 })
    assert.equal(result.applied.length, 0)
    assert.equal(result.warnings.length, 1)
    assert.ok(result.warnings[0].includes('99.nope'))
    assert.equal(graphJson(result.apiGraph), before)
  })

  it('枚举值越界给警告但仍写入', () => {
    const { apiGraph, params } = simpleFixture()
    const result = applyParamOverrides(apiGraph, params, { '3.sampler_name': 'not_a_sampler' })
    assert.equal(result.warnings.length, 1)
    assert.ok(result.warnings[0].includes('3.sampler_name'))
    assert.equal(result.apiGraph['3'].inputs.sampler_name, 'not_a_sampler')
    assert.deepEqual(result.applied, [{ path: '3.sampler_name', value: 'not_a_sampler' }])
  })

  it('非数字 / 非整数 / 非法路径 / 连线输入的容错', () => {
    const { apiGraph, params } = simpleFixture()
    const result = applyParamOverrides(apiGraph, params, {
      '3.steps': 'abc',
      '3.denoise': '12.6',
      '5.width': '513.6',
      '3.foo.bar': 1,
      'nodot': 1,
      '3.model': ['1', 0],
    })
    assert.equal(result.apiGraph['3'].inputs.steps, 20, '非法数字不写入')
    assert.equal(result.apiGraph['3'].inputs.denoise, 12.6, 'FLOAT 参数保留小数')
    assert.equal(result.apiGraph['5'].inputs.width, 514, 'INT 参数取整')
    assert.equal(result.apiGraph['3'].inputs.model[0], '4', '连线输入不能被覆盖')
    assert.ok(result.warnings.some((warning) => warning.includes('3.steps')))
    assert.ok(result.warnings.some((warning) => warning.includes('取整')))
    assert.ok(result.warnings.some((warning) => warning.includes('两级')))
    assert.ok(result.warnings.some((warning) => warning.includes('连线输入')))
  })

  it('布尔与字符串转换（合成图）', () => {
    const graph = { 1: { class_type: 'Whatever', inputs: { flag: true, title: 'hello', n: 2 } } }
    const { params } = buildParamSpecs(graph)
    const result = applyParamOverrides(graph, params, { '1.flag': 'false', '1.title': 42, '1.n': '3' })
    assert.deepEqual(result.warnings, [])
    assert.equal(result.apiGraph['1'].inputs.flag, false)
    assert.equal(result.apiGraph['1'].inputs.title, '42')
    assert.equal(result.apiGraph['1'].inputs.n, 3)
    assert.equal(graph['1'].inputs.flag, true, '合成图入参不被修改')
  })

  it('overrides 为空/非法时安全', () => {
    const { apiGraph, params } = simpleFixture()
    const empty = applyParamOverrides(apiGraph, params, {})
    assert.deepEqual(empty.applied, [])
    assert.deepEqual(empty.warnings, [])
    assert.deepEqual(empty.apiGraph, apiGraph)
    const nullOverrides = applyParamOverrides(apiGraph, params, null)
    assert.deepEqual(nullOverrides.applied, [])
    const invalid = applyParamOverrides(apiGraph, params, 'oops')
    assert.ok(invalid.warnings.length > 0)
  })
})

// ---------------------------------------------------------------------------
// applyPrompts
// ---------------------------------------------------------------------------

describe('applyPrompts', () => {
  it('正负提示词分别只写目标路径，不改入参', () => {
    const { apiGraph, promptTargets } = simpleFixture()
    const before = graphJson(apiGraph)
    const result = applyPrompts(apiGraph, promptTargets, {
      prompt: 'a red fox in a snowy forest',
      negativePrompt: 'text, watermark',
    })
    assert.deepEqual(result.warnings, [])
    assert.deepEqual(result.applied, [
      { path: '6.text', field: 'text', value: 'a red fox in a snowy forest' },
      { path: '7.text', field: 'text', value: 'text, watermark' },
    ])
    assert.equal(result.apiGraph['6'].inputs.text, 'a red fox in a snowy forest')
    assert.equal(result.apiGraph['7'].inputs.text, 'text, watermark')
    assert.equal(graphJson(apiGraph), before)
  })

  it('只给 positive 时 negative 不变', () => {
    const { apiGraph, promptTargets } = simpleFixture()
    const result = applyPrompts(apiGraph, promptTargets, { prompt: 'only positive' })
    assert.deepEqual(result.applied, [{ path: '6.text', field: 'text', value: 'only positive' }])
    assert.equal(result.apiGraph['7'].inputs.text, 'blurry, low quality, watermark')
  })

  it('空提示词不动图', () => {
    const { apiGraph, promptTargets } = simpleFixture()
    const result = applyPrompts(apiGraph, promptTargets, { prompt: '', negativePrompt: '' })
    assert.deepEqual(result.applied, [])
    assert.deepEqual(result.warnings, [])
    assert.deepEqual(result.apiGraph, apiGraph)
  })

  it('没有目标时给出 warnings', () => {
    const graph = { 1: { class_type: 'Whatever', inputs: { n: 1 } } }
    const result = applyPrompts(graph, { positive: [], negative: [] }, { prompt: 'hello', negativePrompt: 'bad' })
    assert.deepEqual(result.applied, [])
    assert.equal(result.warnings.length, 2)
    assert.ok(result.warnings[0].includes('没有检测到'))
  })

  it('只有 positive 目标时 negativePrompt 给警告但不误写', () => {
    const graph = { 1: { class_type: 'CLIPTextEncode', inputs: { text: 'one', clip: ['9', 0] } } }
    const { promptTargets } = buildParamSpecs(graph)
    const result = applyPrompts(graph, promptTargets, { negativePrompt: 'bad' })
    assert.deepEqual(result.applied, [])
    assert.ok(result.warnings.some((warning) => warning.includes('负面')))
    assert.equal(result.apiGraph['1'].inputs.text, 'one')
  })

  it('目标路径不存在时给警告', () => {
    const { apiGraph } = simpleFixture()
    const result = applyPrompts(apiGraph, { positive: ['42.text'], negative: [] }, { prompt: 'hi' })
    assert.deepEqual(result.applied, [])
    assert.ok(result.warnings.some((warning) => warning.includes('42.text')))
  })
})

// ---------------------------------------------------------------------------
// mergeImport 端到端
// ---------------------------------------------------------------------------

describe('mergeImport', () => {
  it('UI 图 + objectInfo 全流程', () => {
    const result = mergeImport({ name: 'Simple UI Flow', raw: uiSimple, objectInfo })
    assert.equal(result.format, 'ui')
    assert.equal(result.source, 'ui')
    assert.equal(result.name, 'Simple UI Flow')
    assert.deepEqual(result.warnings, [])
    assert.ok(result.uiGraph)
    assert.deepEqual(result.uiGraph, uiSimple)
    assert.deepEqual(result.nodes, [
      { id: '3', class: 'KSampler' },
      { id: '4', class: 'CheckpointLoaderSimple' },
      { id: '5', class: 'EmptyLatentImage' },
      { id: '6', class: 'CLIPTextEncode', title: 'Positive' },
      { id: '7', class: 'CLIPTextEncode', title: 'Negative' },
      { id: '8', class: 'VAEDecode' },
      { id: '9', class: 'SaveImage' },
    ])
    assert.deepEqual(result.promptTargets, { positive: ['6.text'], negative: ['7.text'] })
    assert.equal(result.params[0].path, '6.text')
    assert.equal(result.params[1].path, '7.text')
    assert.equal(result.apiGraph['3'].inputs.seed, 156680208700286)
  })

  it('UI 图在 objectInfo 缺失时仍能导入（启发式参数 + warnings）', () => {
    const result = mergeImport({ name: 'No Object Info', raw: JSON.stringify(uiSimple) })
    assert.equal(result.format, 'ui')
    assert.ok(result.warnings.length > 0)
    assert.deepEqual(result.promptTargets, { positive: ['6.text'], negative: ['7.text'] })
    assert.equal(byPath(result.params, '3.steps').value, 20)
    assert.equal(byPath(result.params, '3.sampler_name').type, 'string')
  })

  it('API 图全流程（无 uiGraph）', () => {
    const result = mergeImport({ name: 'API Flow', raw: apiFixture, objectInfo })
    assert.equal(result.format, 'api')
    assert.equal(result.source, 'api')
    assert.equal('uiGraph' in result, false)
    assert.deepEqual(result.warnings, [])
    assert.deepEqual(result.promptTargets, { positive: ['6.text'], negative: ['7.text'] })
    assert.deepEqual(
      result.nodes.map((node) => node.id),
      ['3', '4', '5', '6', '7', '8', '9'],
    )
    assert.equal(byPath(result.params, '3.sampler_name').type, 'enum')
  })

  it('name 去空白、缺省兜底', () => {
    const trimmed = mergeImport({ name: '  Trimmed Name  ', raw: uiSimple, objectInfo })
    assert.equal(trimmed.name, 'Trimmed Name')
    const fallback = mergeImport({ raw: apiFixture, objectInfo })
    assert.equal(typeof fallback.name, 'string')
    assert.ok(fallback.name.length > 0)
  })

  it('无法识别/空图抛 EBAD_WORKFLOW', () => {
    expectBadWorkflow(() => mergeImport({ name: 'x', raw: '{}' }))
    expectBadWorkflow(() => mergeImport({ name: 'x', raw: { hello: 'world' } }))
    expectBadWorkflow(() => mergeImport({ name: 'x', raw: { nodes: [], links: [] } }))
    expectBadWorkflow(() => mergeImport({ name: 'x', raw: 'not json' }))
  })
})

// ---------------------------------------------------------------------------
// summarizeGraph
// ---------------------------------------------------------------------------

describe('summarizeGraph', () => {
  it('统计节点数与类分布', () => {
    assert.deepEqual(summarizeGraph(apiFixture), {
      nodeCount: 7,
      classes: {
        KSampler: 1,
        CheckpointLoaderSimple: 1,
        EmptyLatentImage: 1,
        CLIPTextEncode: 2,
        VAEDecode: 1,
        SaveImage: 1,
      },
    })
  })

  it('空图/非法输入返回零值', () => {
    assert.deepEqual(summarizeGraph({}), { nodeCount: 0, classes: {} })
    assert.deepEqual(summarizeGraph(null), { nodeCount: 0, classes: {} })
  })
})

// ===========================================================================
// uiToApiGraph —— bypass（mode=4）完整透传
// ===========================================================================

describe('uiToApiGraph（bypass 全部支持）', () => {
  const makeUi = (nodes, links = []) => ({ nodes, links, groups: [], config: {}, extra: {}, version: 0.4 })

  it('链式 bypass 一路透传到最初的源节点', () => {
    const ui = makeUi([
      { id: 1, type: 'LoadImage', mode: 0, inputs: [], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [1] }], widgets_values: ['a.png'] },
      { id: 2, type: 'ImageScale', mode: 4, inputs: [{ name: 'image', type: 'IMAGE', link: 1 }], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [2] }], widgets_values: [] },
      { id: 3, type: 'ImageScaleBy', mode: 4, inputs: [{ name: 'image', type: 'IMAGE', link: 2 }], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [3] }], widgets_values: [] },
      { id: 4, type: 'SaveImage', mode: 0, inputs: [{ name: 'images', type: 'IMAGE', link: 3 }], outputs: [], widgets_values: ['x'] },
    ], [
      [1, 1, 0, 2, 0, 'IMAGE'],
      [2, 2, 0, 3, 0, 'IMAGE'],
      [3, 3, 0, 4, 0, 'IMAGE'],
    ])
    const { apiGraph, warnings } = uiToApiGraph(ui)
    assert.deepEqual(apiGraph['4'].inputs.images, ['1', 0])
    assert.equal(apiGraph['2'], undefined)
    assert.equal(apiGraph['3'], undefined)
    assert.ok(warnings.some((message) => message.includes('bypass')), JSON.stringify(warnings))
  })

  it('宽类型输出（IMAGE,MASK）按消费者类型 IMAGE 匹配透传', () => {
    const ui = makeUi([
      { id: 1, type: 'LoadImage', mode: 0, inputs: [], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [1] }], widgets_values: ['a.png'] },
      { id: 2, type: 'MaskComposite', mode: 4, inputs: [{ name: 'image', type: 'IMAGE', link: 1 }], outputs: [{ name: 'IMAGE', type: 'IMAGE,MASK', links: [2] }], widgets_values: [] },
      { id: 3, type: 'SaveImage', mode: 0, inputs: [{ name: 'images', type: 'IMAGE', link: 2 }], outputs: [], widgets_values: ['x'] },
    ], [
      [1, 1, 0, 2, 0, 'IMAGE'],
      [2, 2, 0, 3, 0, 'IMAGE,MASK'],
    ])
    const { apiGraph } = uiToApiGraph(ui)
    assert.deepEqual(apiGraph['3'].inputs.images, ['1', 0])
  })

  it('多输出 bypass：MODEL/CLIP/VAE 各自接到同类型输入', () => {
    const ui = makeUi([
      { id: 1, type: 'SourceModel', mode: 0, inputs: [], outputs: [{ name: 'MODEL', type: 'MODEL', links: [1] }] },
      { id: 2, type: 'SourceClip', mode: 0, inputs: [], outputs: [{ name: 'CLIP', type: 'CLIP', links: [2] }] },
      { id: 3, type: 'SourceVae', mode: 0, inputs: [], outputs: [{ name: 'VAE', type: 'VAE', links: [3] }] },
      {
        id: 4, type: 'CheckpointLoaderSimple', mode: 4,
        inputs: [
          { name: 'model', type: 'MODEL', link: 1 },
          { name: 'clip', type: 'CLIP', link: 2 },
          { name: 'vae', type: 'VAE', link: 3 },
        ],
        outputs: [
          { name: 'MODEL', type: 'MODEL', links: [4] },
          { name: 'CLIP', type: 'CLIP', links: [5] },
          { name: 'VAE', type: 'VAE', links: [6] },
        ],
        widgets_values: [],
      },
      { id: 5, type: 'KSampler', mode: 0, inputs: [{ name: 'model', type: 'MODEL', link: 4 }], outputs: [] },
      { id: 6, type: 'CLIPTextEncode', mode: 0, inputs: [{ name: 'clip', type: 'CLIP', link: 5 }], outputs: [] },
      { id: 7, type: 'VAEDecode', mode: 0, inputs: [{ name: 'vae', type: 'VAE', link: 6 }], outputs: [] },
    ], [
      [1, 1, 0, 4, 0, 'MODEL'],
      [2, 2, 0, 4, 1, 'CLIP'],
      [3, 3, 0, 4, 2, 'VAE'],
      [4, 4, 0, 5, 0, 'MODEL'],
      [5, 4, 1, 6, 0, 'CLIP'],
      [6, 4, 2, 7, 0, 'VAE'],
    ])
    const { apiGraph } = uiToApiGraph(ui)
    assert.deepEqual(apiGraph['5'].inputs.model, ['1', 0])
    assert.deepEqual(apiGraph['6'].inputs.clip, ['2', 0])
    assert.deepEqual(apiGraph['7'].inputs.vae, ['3', 0])
  })

  it('找不到同类型输入：下游输入被忽略 + 明确 warning', () => {
    const ui = makeUi([
      { id: 1, type: 'SourceMask', mode: 0, inputs: [], outputs: [{ name: 'MASK', type: 'MASK', links: [1] }] },
      {
        id: 2, type: 'ImageScale', mode: 4,
        inputs: [{ name: 'mask', type: 'MASK', link: 1 }],
        outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [2] }],
        widgets_values: [],
      },
      { id: 3, type: 'SaveImage', mode: 0, inputs: [{ name: 'images', type: 'IMAGE', link: 2 }], outputs: [], widgets_values: ['x'] },
    ], [
      [1, 1, 0, 2, 0, 'MASK'],
      [2, 2, 0, 3, 0, 'IMAGE'],
    ])
    const { apiGraph, warnings } = uiToApiGraph(ui)
    assert.equal(apiGraph['3'].inputs.images, undefined)
    assert.ok(warnings.some((message) => message.includes('找不到同类型输入')), JSON.stringify(warnings))
  })

  it('输出/输入都没有 type 且只有一条输入时兜底透传', () => {
    const ui = makeUi([
      { id: 1, type: 'Source', mode: 0, inputs: [], outputs: [{ name: 'OUT' }] },
      { id: 2, type: 'Passthrough', mode: 4, inputs: [{ name: 'in', link: 1 }], outputs: [{ name: 'OUT', links: [2] }] },
      { id: 3, type: 'Sink', mode: 0, inputs: [{ name: 'value', link: 2 }], outputs: [] },
    ], [
      [1, 1, 0, 2, 0, ''],
      [2, 2, 0, 3, 0, ''],
    ])
    const { apiGraph } = uiToApiGraph(ui)
    assert.deepEqual(apiGraph['3'].inputs.value, ['1', 0])
  })
})

// ===========================================================================
// uiToApiGraph —— 新版子图（definitions.subgraphs）
// ===========================================================================

describe('uiToApiGraph（新版子图 Subgraph）', () => {
  const makeUi = (nodes, links, subgraphs) => ({
    nodes,
    links,
    groups: [],
    definitions: { subgraphs },
    config: {},
    extra: {},
    version: 0.4,
  })

  const subgraphDef = ({ id, name, inputs = [], outputs = [], nodes = [], links = [] }) => ({
    id,
    name,
    inputs: inputs.map((slot) => ({ id: `${id}-${slot.name}`, ...slot })),
    outputs: outputs.map((slot) => ({ id: `${id}-out-${slot.name}`, ...slot })),
    inputNode: { id: -10, slots: [] },
    outputNode: { id: -20, slots: [] },
    nodes,
    links,
    groups: [],
    widgets: [],
    extra: {},
  })

  it('子图实例展开为内部节点，跨边界输入/输出正确连线', () => {
    const ui = makeUi([
      { id: 1, type: 'LoadImage', mode: 0, inputs: [], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [10] }], widgets_values: ['a.png'] },
      { id: 5, type: 'sg-a', mode: 0, inputs: [{ name: 'image', type: 'IMAGE', link: 10 }], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [11] }], widgets_values: [] },
      { id: 9, type: 'SaveImage', mode: 0, inputs: [{ name: 'images', type: 'IMAGE', link: 11 }], outputs: [], widgets_values: ['out'] },
    ], [
      [10, 1, 0, 5, 0, 'IMAGE'],
      [11, 5, 0, 9, 0, 'IMAGE'],
    ], [subgraphDef({
      id: 'sg-a',
      name: 'A',
      inputs: [{ name: 'image', type: 'IMAGE' }],
      outputs: [{ name: 'IMAGE', type: 'IMAGE' }],
      nodes: [{ id: 2, type: 'ImageInvert', mode: 0, inputs: [{ name: 'image', type: 'IMAGE', link: 20 }], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [21] }], widgets_values: [] }],
      links: [
        { id: 20, origin_id: -10, origin_slot: 0, target_id: 2, target_slot: 0, type: 'IMAGE' },
        { id: 21, origin_id: 2, origin_slot: 0, target_id: -20, target_slot: 0, type: 'IMAGE' },
      ],
    })])
    const { apiGraph, warnings } = uiToApiGraph(ui)
    assert.deepEqual(apiGraph['5:2'].inputs.image, ['1', 0])
    assert.deepEqual(apiGraph['9'].inputs.images, ['5:2', 0])
    assert.equal(apiGraph['5'], undefined, '子图实例本身不应进入 API 图')
    assert.ok(warnings.some((message) => message.includes('子图实例')), JSON.stringify(warnings))
  })

  it('未连接的提升输入用实例 widgets_values 默认值（合成字面量）', () => {
    const ui = makeUi([
      { id: 6, type: 'sg-b', mode: 0, inputs: [{ name: 'steps', type: 'INT', link: null, widget: { name: 'steps' } }], outputs: [], widgets_values: [33], properties: { proxyWidgets: [['-1', 'steps']] } },
    ], [], [subgraphDef({
      id: 'sg-b',
      name: 'B',
      inputs: [{ name: 'steps', type: 'INT' }],
      outputs: [],
      nodes: [{ id: 3, type: 'KSampler', mode: 0, inputs: [{ name: 'steps', type: 'INT', link: 30 }], outputs: [], widgets_values: [] }],
      links: [{ id: 30, origin_id: -10, origin_slot: 0, target_id: 3, target_slot: 0, type: 'INT' }],
    })])
    const { apiGraph } = uiToApiGraph(ui)
    assert.equal(apiGraph['6:3'].inputs.steps, 33)
  })

  it('支持嵌套子图（id 形如 外层实例:内层实例:内部节点）', () => {
    const inner = subgraphDef({
      id: 'sg-inner',
      name: 'Inner',
      inputs: [{ name: 'image', type: 'IMAGE' }],
      outputs: [{ name: 'IMAGE', type: 'IMAGE' }],
      nodes: [{ id: 8, type: 'ImageInvert', mode: 0, inputs: [{ name: 'image', type: 'IMAGE', link: 50 }], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [51] }], widgets_values: [] }],
      links: [
        { id: 50, origin_id: -10, origin_slot: 0, target_id: 8, target_slot: 0, type: 'IMAGE' },
        { id: 51, origin_id: 8, origin_slot: 0, target_id: -20, target_slot: 0, type: 'IMAGE' },
      ],
    })
    const outer = subgraphDef({
      id: 'sg-outer',
      name: 'Outer',
      inputs: [{ name: 'image', type: 'IMAGE' }],
      outputs: [{ name: 'IMAGE', type: 'IMAGE' }],
      nodes: [{ id: 7, type: 'sg-inner', mode: 0, inputs: [{ name: 'image', type: 'IMAGE', link: 40 }], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [41] }], widgets_values: [] }],
      links: [
        { id: 40, origin_id: -10, origin_slot: 0, target_id: 7, target_slot: 0, type: 'IMAGE' },
        { id: 41, origin_id: 7, origin_slot: 0, target_id: -20, target_slot: 0, type: 'IMAGE' },
      ],
    })
    const ui = makeUi([
      { id: 1, type: 'LoadImage', mode: 0, inputs: [], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [10] }], widgets_values: ['a.png'] },
      { id: 5, type: 'sg-outer', mode: 0, inputs: [{ name: 'image', type: 'IMAGE', link: 10 }], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [11] }], widgets_values: [] },
      { id: 9, type: 'SaveImage', mode: 0, inputs: [{ name: 'images', type: 'IMAGE', link: 11 }], outputs: [], widgets_values: ['out'] },
    ], [
      [10, 1, 0, 5, 0, 'IMAGE'],
      [11, 5, 0, 9, 0, 'IMAGE'],
    ], [inner, outer])
    const { apiGraph } = uiToApiGraph(ui)
    assert.deepEqual(apiGraph['5:7:8'].inputs.image, ['1', 0])
    assert.deepEqual(apiGraph['9'].inputs.images, ['5:7:8', 0])
  })
})
