/**
 * 包清单与展示资源校验（安装前必过）。
 * 覆盖 CONTRACT §9 / host-plugin.md 的 display checklist：
 * 标题描述、图标、locale 导出、patch、文件清单、语法。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))

async function readJson(relative) {
  return JSON.parse(await readFile(join(packageRoot, relative), 'utf8'))
}

test('package.json：bundle / client / exports / files 完整', async () => {
  const pkg = await readJson('package.json')
  assert.equal(pkg.name, 'dsh-sendcomfy')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'index.js')
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh?.client?.platform, 'web')

  for (const key of ['.', './client', './icon', './package.json']) {
    assert.ok(pkg.exports?.[key], `exports 缺少 ${key}`)
  }
  assert.ok(pkg.exports?.['./locale/*.json'], 'exports 缺少 ./locale/*.json')

  const files = new Set(pkg.files || [])
  for (const required of ['index.js', 'client.js', 'lib', 'icon.svg', 'cordis.patch.yml', 'locale/*.json']) {
    assert.ok(files.has(required), `files 缺少 ${required}`)
  }
})

test('入口与运行时文件存在且可解析', async () => {
  await stat(join(packageRoot, 'index.js'))
  await stat(join(packageRoot, 'client.js'))
  await stat(join(packageRoot, 'cordis.patch.yml'))
  for (const name of ['lib/actions.mjs', 'lib/comfy.mjs', 'lib/http.mjs', 'lib/state.mjs', 'lib/workflow.mjs']) {
    const info = await stat(join(packageRoot, name))
    assert.ok(info.size > 0, `${name} 不应为空`)
  }
})

test('cordis.patch.yml 声明了本 bundle 的唯一 row', async () => {
  const patch = await readFile(join(packageRoot, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /^\s*-\s*insert:/m)
  assert.match(patch, /name:\s*['"]?dsh-sendcomfy['"]?/)
  const ids = [...patch.matchAll(/^\s*-\s*id:\s*(\S+)/gm)].map((match) => match[1])
  assert.equal(new Set(ids).size, ids.length, 'row id 不应重复')
})

test('locale：en/zh 都有 meta.title / meta.description', async () => {
  const en = await readJson('locale/en.json')
  const zh = await readJson('locale/zh.json')
  for (const [locale, dict] of [['en', en], ['zh', zh]]) {
    assert.equal(typeof dict.meta?.title, 'string', `${locale} meta.title 缺失`)
    assert.ok(dict.meta.title.trim().length > 0)
    assert.equal(typeof dict.meta?.description, 'string', `${locale} meta.description 缺失`)
    assert.ok(dict.meta.description.trim().length > 20, `${locale} description 太短，应说明能力`)
  }
  assert.notEqual(en.meta.title, zh.meta.title)
})

test('icon：SVG、体积合规、不是空文件', async () => {
  const iconPath = join(packageRoot, 'icon.svg')
  const info = await stat(iconPath)
  assert.ok(info.size > 0 && info.size <= 256 * 1024, `icon 体积 ${info.size} 超出限制`)
  const svg = await readFile(iconPath, 'utf8')
  assert.match(svg, /<svg[\s>]/)
  assert.match(svg, /viewBox="0 0 64 64"/)
})

test('locale 目录可被 ./locale/*.json 导出覆盖', async () => {
  const entries = await readdir(join(packageRoot, 'locale'))
  const json = entries.filter((name) => name.endsWith('.json'))
  assert.ok(json.includes('en.json') && json.includes('zh.json'))
})
