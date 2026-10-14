/**
 * 宿主加载验证（离线复现 DSH 加载插件时的模块解析环境）。
 *
 * 验证内容：
 *   1. 按**包名**解析插件入口（Node self-reference），检查 name / inject / Config / apply 元信息；
 *   2. schemastery 配置表能解析默认值、保留未知键（这决定「配置写错会不会让宿主起不来」）；
 *   3. 在**真实 cordis Context** 里执行 apply，演练拦截与放行；
 *   4. 挂上 **DSH 官方 \`@deepseek-ai/dsh-llm\` 流语法校验器**，复核被拦分片的合法性。
 *
 * 用法：node scripts/verify-load.mjs
 * 若 DSH 不在默认位置，设置环境变量 DSH_APP_ROOT 指向 resources/app。
 */
import { register } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

register('./hooks.mjs', import.meta.url)

/** DSH 应用目录（与 hooks.mjs 的解析根保持一致）。 */
const APP = process.env.DSH_APP_ROOT || 'D:/dsh d/DSH Desktop Beta/resources/app'

let failed = 0
const check = (label, ok, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? '✔' : '✘'} ${label}${detail ? '  ' + detail : ''}`)
}

const mod = await import('dsh-model-guard')
check('包名可解析入口', mod.name === 'model-guard', `name=${mod.name}`)
check('inject 声明正确', JSON.stringify(mod.inject) === '["llm"]', JSON.stringify(mod.inject))
check('导出 schemastery Config', Boolean(mod.Config))
check('导出 apply 函数', typeof mod.apply === 'function')

// 注意：schema 对 .volatile() 字段返回的是 `{ get: () => 值 }` 取值器，
// 这是 DSH 的正常形态，插件侧必须解包——这里也按真实形态来断言。
const unwrap = (value) => (value !== null && typeof value === 'object' && typeof value.get === 'function' ? unwrap(value.get()) : value)
const empty = mod.Config({})
check('空配置填入默认值', unwrap(empty.enabled) === true && unwrap(empty.mode) === 'block' && unwrap(empty.scope) === 'all', `mode=${unwrap(empty.mode)}`)
const custom = mod.Config({ mode: 'redirect', scope: 'auto', blockedProviders: ['x'], unknownKey: 1 })
check('配置表保留未知键', custom.unknownKey === 1, `mode=${unwrap(custom.mode)}`)

const { Context } = await import('@deepseek-ai/cordis')

// --- 真实 cordis 上下文：拦截与放行 ---
const root = new Context()
root.provide('llm', { stream: async function* () { yield { type: 'finish', reason: { kind: 'stop' } } } })
const logs = []
const handle = mod.apply(root, { enabled: true, scope: 'auto', blockedProviders: ['nvida'] }, { log: (m) => logs.push(m) })
check('apply 返回安装句柄', handle !== null)
check('输出启动日志与规则清单', logs.some((l) => l.includes('已启用')) && logs.some((l) => l.includes('provider=nvida')))

let downstream = 0
const run = async (options) => {
  const out = []
  for await (const chunk of root.waterfall('llm/stream', options, () => {
    downstream += 1
    return (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })()
  })) out.push(chunk)
  return out
}

const blocked = await run({ provider: 'nvida', model: 'deepseek-ai/deepseek-v4.1-flash', purpose: 'session-title' })
check('自动调用被拦截且下游未被触达', blocked[0]?.reason?.failure?.code === 'POLICY_BLOCKED' && downstream === 0)
const allowed = await run({ provider: 'nvida', model: 'deepseek-ai/deepseek-v4.1-flash' })
check('用户主动调用放行', allowed[0]?.reason?.kind === 'stop' && downstream === 1)
check('拦截已写日志', logs.some((l) => l.includes('已拦截')))

// --- 官方流语法校验器复核 ---
const invariant = await import('@deepseek-ai/dsh-llm/lib/invariant.js')
const root2 = new Context()
root2.provide('llm', { stream: async function* () { yield { type: 'finish', reason: { kind: 'stop' } } } })
const errors = []
root2.provide('invariants', { register: (_name, install) => install(root2, (m) => errors.push(m)) })
await invariant.apply(root2)
mod.apply(root2, { blockedProviders: ['nvida'] }, { log: () => {} })
const checked = []
for await (const chunk of root2.waterfall('llm/stream', { provider: 'nvida', model: 'x' }, () => (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })())) checked.push(chunk)
check('被拦分片通过 DSH 官方校验器', errors.length === 0 && checked.length === 1, errors.join('; '))

// --- 卸载可恢复 ---
handle.dispose()
const after = await run({ provider: 'nvida', model: 'deepseek-ai/deepseek-v4.1-flash', purpose: 'session-title' })
check('卸载后恢复放行', after[0]?.reason?.kind === 'stop')
check('卸载时输出统计摘要', logs.some((l) => l.includes('已卸载') && l.includes('总调用')))

// --- 回归：设置界面保存后的配置形态（volatile 取值器）必须被 host 正确消费 ---
{
  const root3 = new Context()
  root3.provide('llm', { stream: async function* () { yield { type: 'finish', reason: { kind: 'stop' } } } })
  const logs3 = []
  // DSH 的 settings 服务把 .volatile() 字段以 { get } 取值器交给插件，
  // 这正是用户在设置界面点「保存」之后 host 收到的样子。
  const volatileConfig = {
    enabled: { get: () => true },
    mode: { get: () => 'warn' },
    scope: { get: () => 'all' },
    blockedProviders: { get: () => ['nvida'] },
    blockedModels: { get: () => [] },
  }
  const handle3 = mod.apply(root3, volatileConfig, { log: (m) => logs3.push(m) })
  check('volatile 形态配置能被解析', handle3 !== null && handle3.cfg.mode === 'warn', handle3 ? `mode=${handle3.cfg.mode}` : '未安装')
  let downstream3 = 0
  for await (const _ of root3.waterfall('llm/stream', { provider: 'nvida', model: 'x' }, () => {
    downstream3 += 1
    return (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })()
  })) { /* 消费完 */ }
  check('volatile 形态配置下拦截规则生效', downstream3 === 1 && logs3.some((l) => l.includes('告警')), `下游调用 ${downstream3} 次`)
}

// --- 客户端半身：声明、文件、依赖、可加载性 ---
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const clientEntry = manifest.exports?.['./client']
check('package.json 声明了 ./client 导出', typeof clientEntry === 'string', String(clientEntry))
check('dsh.client.platform 为 web', manifest.dsh?.client?.platform === 'web')

const clientPath = new URL('../' + String(clientEntry || 'lib/client.js').replace(/^\.\//, ''), import.meta.url)
check('客户端入口文件存在', existsSync(clientPath), fileURLToPath(clientPath))

const declared = manifest.dsh?.client?.inject ?? []
const PLATFORM_MODULES = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', 'cordis', '@deepseek-ai/cordis'])
const clientSource = readFileSync(clientPath, 'utf8')
const required = [...clientSource.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2])
const undeclared = required.filter((name) => !PLATFORM_MODULES.has(name) && !declared.includes(name))
check('客户端 require 的模块都已声明', undeclared.length === 0, undeclared.length ? '未声明: ' + undeclared.join(', ') : required.join(', ') || '（无外部模块）')

const appModules = join(APP, 'node_modules')
const missingDeclared = declared.filter((name) => !existsSync(join(appModules, name)))
check('dsh.client.inject 的模块在宿主中都存在', missingDeclared.length === 0, missingDeclared.length ? '缺失: ' + missingDeclared.join(', ') : declared.length + ' 个')

// 在模拟的 __ModuleLoader__ 下真正加载一次浏览器半身
let captured = null
const previousWindow = globalThis.window
globalThis.window = { __ModuleLoader__: { load(definition) { captured = definition } } }
let clientExports = null
try {
  await import(pathToFileURL(fileURLToPath(clientPath)).href + '?verify=' + Date.now())
  check('客户端 bundle 注册到 __ModuleLoader__', captured !== null)
  check('客户端 bundle id 与包名一致', captured?.id === manifest.name, captured?.id)
  const react = await import(pathToFileURL(join(appModules, 'react/index.js')).href)
  clientExports = captured.factory((name) => {
    if (name === 'react') return react.default ?? react
    throw new Error('未声明的模块请求: ' + name)
  })
  check('客户端 factory 可执行', clientExports !== null)
  check('客户端导出 apply 函数', typeof clientExports.apply === 'function')
  check('客户端导出 inject 声明', Array.isArray(clientExports.inject), JSON.stringify(clientExports.inject))
  const requiredServices = ['slots', 'configForms', 'remote', 'remote.session']
  const missingService = requiredServices.filter((name) => !clientExports.inject.includes(name))
  check('客户端注入覆盖界面所需服务', missingService.length === 0, missingService.join(', ') || requiredServices.join(', '))
} finally {
  if (previousWindow === undefined) delete globalThis.window
  else globalThis.window = previousWindow
}

console.log(`\n=== 宿主加载验证${failed === 0 ? '全部通过' : `失败 ${failed} 项`} ===`)
process.exitCode = failed > 0 ? 1 : 0
