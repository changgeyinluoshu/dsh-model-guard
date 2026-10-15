/**
 * 测试入口。
 *
 * 不用 \`node --test test/\`：那个形式会为每个文件 spawn 子进程，
 * 在受限运行环境（含 DSH 自身的 pwsh 沙箱）会以 EPERM 失败。
 * 这里直接在**当前进程**依次 import 各测试文件——node:test 会在导入时
 * 注册并运行测试，并自行设置进程退出码。
 */
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const files = [
  join(here, '..', 'test', 'matcher.test.js'),
  join(here, '..', 'test', 'guard.test.js'),
  join(here, '..', 'test', 'integration.test.js'),
  join(here, '..', 'test', 'client.test.js'),
  join(here, '..', 'test', 'features.test.js'),
]

let failed = 0
process.on('exit', (code) => {
  console.log(`\n=== dsh-model-guard 测试结束（退出码 ${code ?? 0}）===`)
})

for (const file of files) {
  try {
    await import(pathToFileURL(file).href)
  } catch (error) {
    failed += 1
    console.error(`加载测试文件失败：${file}`, error)
  }
}

if (failed > 0) process.exitCode = 1
