/**
 * 真实链路集成测试
 *
 * 与 guard.test.js 的区别：这里刻意使用 DSH 自带的真实模块，而不是复刻实现——
 *   1. 真实的 @deepseek-ai/cordis Context（waterfall 派发语义）
 *   2. 真实的 @deepseek-ai/dsh-llm/lib/invariant.js 流语法校验器
 * 若这些模块不可用（例如在别的机器上单独跑本仓库），整个文件跳过并给出说明。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { installGuard } from '../lib/guard.js'

const APP_ROOT = process.env.DSH_APP_ROOT || 'D:/dsh d/DSH Desktop Beta/resources/app'
const CORDIS_ENTRY = join(APP_ROOT, 'node_modules/@deepseek-ai/cordis/lib/index.js')
const INVARIANT_ENTRY = join(APP_ROOT, 'node_modules/@deepseek-ai/dsh-llm/lib/invariant.js')

async function loadReal() {
  try {
    const cordis = await import(pathToFileURL(CORDIS_ENTRY).href)
    const invariant = await import(pathToFileURL(INVARIANT_ENTRY).href)
    return { cordis, invariant }
  } catch {
    return null
  }
}

const real = await loadReal()
const skip = real ? false : '未找到 DSH 应用目录下的 cordis / dsh-llm（可用 DSH_APP_ROOT 指定）'

const OK_CHUNKS = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'hi' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } },
  { type: 'finish', reason: { kind: 'stop' } },
]

/** 搭一个：真实 cordis + 真实 llm-invariant 校验器 + 守卫 的最小宿主。 */
async function makeHost(guardConfig, { installInvariant = true } = {}) {
  const { Context } = real.cordis
  const root = new Context()
  const seenByLlm = []
  root.provide('llm', {
    stream(options) {
      seenByLlm.push(options)
      return (async function* () {
        for (const chunk of OK_CHUNKS) yield chunk
      })()
    },
  })

  const invariantErrors = []
  // 真实 invariant 的 apply 只依赖 ctx.invariants.register(name, install)
  root.provide('invariants', {
    register(_name, install) {
      install(root, (message) => invariantErrors.push(message))
    },
  })

  if (installInvariant) await real.invariant.apply(root)

  const messages = []
  const installed = installGuard(root, guardConfig, { log: (m) => messages.push(m) })

  const run = async (options) => {
    const out = []
    const calls = { downstream: 0 }
    const stream = root.waterfall('llm/stream', options, () => {
      calls.downstream += 1
      return (async function* () {
        for (const chunk of OK_CHUNKS) yield chunk
      })()
    })
    for await (const chunk of stream) out.push(chunk)
    return { out, calls }
  }

  return { root, installed, messages, invariantErrors, seenByLlm, run }
}

test('真实链路：被拦截的调用产出分片能通过 DSH 官方流语法校验器', { skip }, async () => {
  const host = await makeHost({ blockedProviders: ['nvida'] })
  const { out, calls } = await host.run({ provider: 'nvida', model: 'deepseek-ai/deepseek-v4.1-flash' })

  assert.equal(calls.downstream, 0, '下游适配器未被调用')
  assert.deepEqual(host.invariantErrors, [], '官方校验器未报任何不变式错误')
  assert.equal(out.length, 1)
  assert.equal(out[0].type, 'finish')
  assert.equal(out[0].reason.kind, 'error')
  assert.equal(out[0].reason.failure.code, 'POLICY_BLOCKED')
  assert.equal(host.seenByLlm.length, 0, '没有任何 HTTP 层调用被发起')
})

test('真实链路：放行的调用分片原样通过校验器', { skip }, async () => {
  const host = await makeHost({ blockedProviders: ['nvida'] })
  const { out, calls } = await host.run({ provider: 'other', model: 'y' })

  assert.equal(calls.downstream, 1)
  assert.deepEqual(host.invariantErrors, [])
  assert.deepEqual(out, OK_CHUNKS)
})

test('真实链路：改道后的调用同样通过校验器，且原目标未被触碰', { skip }, async () => {
  const host = await makeHost({
    mode: 'redirect',
    blockedProviders: ['expensive'],
    fallback: { provider: 'cheap', model: 'cheap-small' },
  })
  const { out, calls } = await host.run({ provider: 'expensive', model: 'big' })

  assert.equal(calls.downstream, 0)
  assert.deepEqual(host.invariantErrors, [])
  assert.equal(host.seenByLlm.length, 1)
  assert.equal(host.seenByLlm[0].provider, 'cheap')
  assert.equal(host.seenByLlm[0].model, 'cheap-small')
  assert.deepEqual(out, OK_CHUNKS)
})

test('真实链路：只禁自动调用时，压缩与标题被拦、主对话放行', { skip }, async () => {
  const host = await makeHost({ blockedProviders: ['nvida'], scope: 'auto' })

  const main = await host.run({ provider: 'nvida', model: 'm' })
  assert.equal(main.calls.downstream, 1, '主对话（无 purpose）放行')

  const compaction = await host.run({ provider: 'nvida', model: 'm', purpose: 'compaction' })
  assert.equal(compaction.calls.downstream, 0, '上下文压缩被拦')
  assert.equal(compaction.out[0].reason.failure.code, 'POLICY_BLOCKED')

  const title = await host.run({ provider: 'nvida', model: 'm', purpose: 'session-title' })
  assert.equal(title.calls.downstream, 0, '会话标题生成被拦')

  assert.deepEqual(host.invariantErrors, [], '所有路径都通过官方校验器')
})

test('真实链路：冻结的 loop 请求（deep-freeze）也能被正常拦截', { skip }, async () => {
  // DSH 的 agent loop 会把请求深度冻结后交给 waterfall，监听器只读不改写。
  const frozen = Object.freeze({
    provider: 'nvida',
    model: 'deepseek-ai/deepseek-v4.1-flash',
    messages: Object.freeze([]),
    purpose: 'compaction',
  })
  const host = await makeHost({ blockedProviders: ['nvida'] })
  const { out, calls } = await host.run(frozen)

  assert.equal(calls.downstream, 0)
  assert.deepEqual(host.invariantErrors, [])
  assert.equal(out[0].reason.failure.code, 'POLICY_BLOCKED')
  assert.equal(frozen.provider, 'nvida', '原请求未被改写')
})

test('真实链路：守卫卸载后不再拦截', { skip }, async () => {
  const host = await makeHost({ blockedProviders: ['nvida'] })
  const before = await host.run({ provider: 'nvida', model: 'm' })
  assert.equal(before.calls.downstream, 0)

  host.installed.dispose()
  const after = await host.run({ provider: 'nvida', model: 'm' })
  assert.equal(after.calls.downstream, 1, '卸载后恢复放行')
  assert.deepEqual(after.out, OK_CHUNKS)
  assert.ok(host.messages.some((m) => m.includes('已卸载')))
})
