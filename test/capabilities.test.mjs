/**
 * capabilities.test.mjs — 工作流能力画像与 AI 选型测试
 * 纯函数、零依赖；fixture 用 fileURLToPath 推导，不依赖 cwd。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  KINDS,
  KIND_LABELS,
  describeWorkflow,
  chooseCandidates,
  tokenizeTask,
  detectIntentKinds,
} from '../lib/capabilities.mjs'
import { mergeImport } from '../lib/workflow.mjs'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const fixtures = join(packageRoot, 'test', 'fixtures')

async function readFixture(name) {
  return JSON.parse(await readFile(join(fixtures, name), 'utf8'))
}

const ROOT = join(packageRoot, 'test', 'fixtures')

async function loadFixtures() {
  const objectInfo = JSON.parse(await readFile(join(ROOT, 'object-info.json'), 'utf8'))
  const ui = JSON.parse(await readFile(join(ROOT, 'workflow-ui-simple.json'), 'utf8'))
  return { objectInfo, ui }
}

function img2imgUpscaleGraph() {
  return {
    '1': { class_type: 'LoadImage', inputs: { image: 'input.jpg', upload: 'image' } },
    '2': { class_type: 'VAEEncode', inputs: { pixels: ['1', 0], vae: ['4', 2] } },
    '3': {
      class_type: 'KSampler',
      inputs: {
        seed: 1, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 0.55,
        model: ['4', 0], positive: ['5', 0], negative: ['6', 0], latent_image: ['2', 0],
      },
    },
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' } },
    '5': { class_type: 'CLIPTextEncode', inputs: { text: 'x', clip: ['4', 1] }, _meta: { title: 'Positive' } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: 'y', clip: ['4', 1] }, _meta: { title: 'Negative' } },
    '7': { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['8', 0], image: ['9', 0] } },
    '8': { class_type: 'UpscaleModelLoader', inputs: { model_name: '4x-UltraSharp.pth' } },
    '9': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '10': { class_type: 'SaveImage', inputs: { images: ['7', 0], filename_prefix: 'up' } },
  }
}

test('KINDS / KIND_LABELS 覆盖全部能力标签', () => {
  assert.deepEqual(KINDS, ['txt2img', 'img2img', 'inpaint', 'upscale', 'controlnet', 'lora', 'video', 'audio', 'other'])
  for (const kind of KINDS) {
    assert.equal(typeof KIND_LABELS[kind], 'string')
    assert.ok(KIND_LABELS[kind].length > 0)
  }
})

test('describeWorkflow：官方 txt2img 模板 → 文生图 / 正负提示词 / 无需输入 / 输出图片', async () => {
  const { objectInfo, ui } = await loadFixtures()
  const graph = mergeImport({ name: 'simple', raw: ui, objectInfo }).apiGraph
  const caps = describeWorkflow(graph)
  assert.deepEqual(caps.kinds, ['txt2img'])
  assert.deepEqual(caps.kindLabels, ['文生图'])
  assert.equal(caps.hasPrompt, true)
  assert.equal(caps.hasNegative, true)
  assert.deepEqual(caps.neededInputs, [])
  assert.deepEqual(caps.outputKinds, ['image'])
  assert.ok(caps.models.includes('v1-5-pruned-emaonly-fp16.safetensors'), JSON.stringify(caps.models))
  assert.ok(caps.classes.includes('KSampler'))
  assert.match(caps.summary, /文生图/)
})

test('describeWorkflow：img2img + upscale → 图生图/放大 + 输入图片需求', () => {
  const caps = describeWorkflow(img2imgUpscaleGraph())
  assert.ok(caps.kinds.includes('img2img'), JSON.stringify(caps.kinds))
  assert.ok(caps.kinds.includes('upscale'), JSON.stringify(caps.kinds))
  assert.equal(caps.kinds[0], 'img2img')
  assert.equal(caps.neededInputs.length, 1)
  assert.equal(caps.neededInputs[0].param, '1.image')
  assert.equal(caps.neededInputs[0].nodeClass, 'LoadImage')
  assert.equal(caps.neededInputs[0].inputName, 'image')
  assert.equal(caps.neededInputs[0].label, '输入图片')
  assert.match(caps.neededInputs[0].hint, /comfy_upload_image/)
  assert.equal(caps.hasPrompt, true)
  assert.equal(caps.hasNegative, true)
  assert.deepEqual(caps.outputKinds, ['image'])
  assert.ok(caps.models.includes('sd_xl_base_1.0.safetensors'))
  assert.ok(caps.models.includes('4x-UltraSharp.pth'))
  assert.match(caps.summary, /图生图/)
  assert.match(caps.summary, /放大/)
})

test('describeWorkflow：空图 / 坏输入 → other，不抛错', () => {
  for (const input of [{}, null, undefined, [], 'oops', { 1: null, 2: { class_type: '' } }]) {
    const caps = describeWorkflow(input)
    assert.deepEqual(caps.kinds, ['other'], JSON.stringify(input))
    assert.equal(typeof caps.summary, 'string')
    assert.deepEqual(caps.neededInputs, [])
    assert.deepEqual(caps.models, [])
  }
})

test('describeWorkflow：不修改入参', async () => {
  const { objectInfo, ui } = await loadFixtures()
  const graph = mergeImport({ name: 'simple', raw: ui, objectInfo }).apiGraph
  const before = JSON.stringify(graph)
  describeWorkflow(graph)
  assert.equal(JSON.stringify(graph), before)
})

test('tokenizeTask / detectIntentKinds 基本信号', () => {
  assert.ok(tokenizeTask('把这张图放大').some((token) => token.includes('放大')))
  assert.ok(detectIntentKinds('把这张图放大').includes('upscale'))
  assert.ok(detectIntentKinds('画一只赛博朋克风格的猫').includes('txt2img'))
  assert.equal(detectIntentKinds('').length, 0)
  assert.ok(detectIntentKinds('upscale to 4x').includes('upscale'))
})

test('chooseCandidates：放大任务 → upscale 第一；画猫 → txt2img 第一；无匹配 matched:false；limit 生效', () => {
  const candidates = [
    { name: 'txt2img-workflow', description: '文生图 生成图片', tags: ['插画'], kinds: ['txt2img'] },
    { name: 'upscale-4x', description: '高清放大 超分', tags: ['放大'], kinds: ['upscale'] },
    { name: 'img2img-restyle', description: '图生图 换风格', kinds: ['img2img'] },
  ]
  const upscale = chooseCandidates('把这张图放大', candidates)
  assert.equal(upscale.matches[0].index, 1)
  assert.equal(upscale.matches[0].matched, true)
  assert.ok(upscale.matches[0].reasons.length > 0)
  assert.ok(upscale.intentKinds.includes('upscale'))

  const cat = chooseCandidates('画一只赛博朋克风格的猫', candidates)
  assert.equal(cat.matches[0].index, 0)
  assert.equal(cat.matches[0].matched, true)

  const none = chooseCandidates('zzzz qqqq', candidates)
  assert.equal(none.matches.length, 3)
  assert.equal(none.matches.every((match) => match.matched === false), true)

  const limited = chooseCandidates('画一只猫', candidates, { limit: 2 })
  assert.equal(limited.matches.length, 2)
  const capped = chooseCandidates('画一只猫', candidates, { limit: 99 })
  assert.equal(capped.matches.length, 3)

  assert.deepEqual(chooseCandidates('画一只猫', []).matches, [])
  assert.doesNotThrow(() => chooseCandidates('', candidates))
})

test('chooseCandidates：放大任务不被「视频+放大」杂能力流抢走；示例工作流降权', () => {
  const upscaleTask = '把这张图放大 4 倍高清'
  const ranked = chooseCandidates(upscaleTask, [
    { name: 'H3视频放大流', kinds: ['video', 'upscale', 'img2img', 'txt2img'] },
    { name: 'SeedVR2图像放大', kinds: ['upscale', 'txt2img'] },
  ])
  assert.equal(ranked.matches[0].index, 1, JSON.stringify(ranked.matches))

  const catTask = '画一只赛博朋克风格的猫'
  const examples = chooseCandidates(catTask, [
    { name: '示例：官方 txt2img', kinds: ['txt2img'] },
    { name: 'flux 文生图生产流', kinds: ['txt2img'] },
  ])
  assert.equal(examples.matches[0].index, 1, JSON.stringify(examples.matches))
  assert.ok(examples.matches.some((match) => match.reasons.some((reason) => reason.includes('示例'))))
})
