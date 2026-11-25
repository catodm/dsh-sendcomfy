#!/usr/bin/env node
/**
 * dsh-sendcomfy 安装助手。
 *
 *   npx sendcomfy            # 打印安装说明
 *   npx sendcomfy setup      # 同上（显式）
 *   npx sendcomfy --check    # 只做环境自检
 *
 * 插件本体由 DSH 的 plugin_manager 安装，这里只负责打印准确指令与环境检查。
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
// bin/ 的上一级才是包根
const PACKAGE_DIR = path.resolve(HERE, '..')

function pkg() {
  try {
    return JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8'))
  } catch {
    return { name: 'dsh-sendcomfy', version: '0.0.0' }
  }
}

function tint(text, code) {
  return process.stdout.isTTY ? `\u001b[${code}m${text}\u001b[0m` : text
}

function checkNode() {
  const major = Number(process.versions.node.split('.')[0])
  const ok = major >= 22
  console.log(`${ok ? tint('✔', 32) : tint('✖', 31)} Node ${process.versions.node}${ok ? '' : '（需要 ≥ 22）'}`)
  return ok
}

function checkPackageDir() {
  const dir = PACKAGE_DIR
  let ok = true
  for (const file of ['index.js', 'client.js', 'cordis.patch.yml']) {
    const exists = fs.existsSync(path.join(dir, file))
    console.log(`${exists ? tint('✔', 32) : tint('✖', 31)} ${file}`)
    if (!exists) ok = false
  }
  return { ok, dir }
}

function main() {
  const meta = pkg()
  const args = process.argv.slice(2)
  console.log(`\n${tint(`${meta.name} v${meta.version}`, 1)} — ComfyUI ↔ DeepSeek Harness 插件\n`)

  const nodeOk = checkNode()
  const { ok, dir } = checkPackageDir()

  console.log('\n安装到 DSH（在你的 DSH 会话里执行）：\n')
  console.log(`  plugin_manager { action: "install_bundle", target: ${JSON.stringify(dir)} }\n`)
  console.log('装好后：DSH 侧边栏 → ComfyUI 桥接 →「连接」页填 ComfyUI 地址（如 127.0.0.1:8188）→ 保存并测试。')
  console.log('工作流不需要导入：面板和 AI 直接读 ComfyUI 服务器上的清单，运行时按需加载。\n')

  if (args.includes('--check')) {
    process.exitCode = nodeOk && ok ? 0 : 1
    return
  }
  if (!(nodeOk && ok)) {
    console.log(tint('环境检查未通过：请先修复上面标 ✖ 的项。', 33))
    process.exitCode = 1
  }
}

main()
