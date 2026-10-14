import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { installGuard, createGuard, summarize, terminalStream } from '../lib/guard.js'
import { normalizeConfig } from '../lib/matcher.js'

/* ------------------------------------------------------------------ *
 * 测试用的 waterfall 宿主
 *
 * 优先使用 DSH 自带的真实 cordis Context；不可用时回退到等价的最小复刻。
 * 复刻依据（cordis/lib/index.js）：
 *   dispatch(type, args): 若 args[0] 是对象/函数则 shift 出来作为 thisArg 并 bind
 *   waterfall(...args):   args.pop() 取出最内层 next；
 *                         next = () => (cbs.shift() ?? inner)(...args)
 *                         args.push(next); return next()
 *   => 先注册者在外层；监听器签名 (options, next)；不调用 next() 即否决下游
 * ------------------------------------------------------------------ */

const CORDIS_CANDIDATES = [
  process.env.DSH_APP_ROOT ? join(process.env.DSH_APP_ROOT, 'node_modules/@deepseek-ai/cordis/lib/index.js') : null,
  'D:/dsh d/DSH Desktop Beta/resources/app/node_modules/@deepseek-ai/cordis/lib/index.js',
  'C:/Users/yk/.dsh-beta/profiles/desktop/node_modules/@deepseek-ai/cordis/lib/index.js',
].filter(Boolean)

/** 最小复刻：语义与 cordis 逐行对齐，供 cordis 不可用时使用。 */
function makeFallbackCtx() {
  const hooks = new Map()
  const ctx = {
    llm: { stream: null },
    on(name, callback, options) {
      const list = hooks.get(name) ?? []
      if (options?.prepend) list.unshift(callback)
      else list.push(callback)
      hooks.set(name, list)
      return () => {
        const index = list.indexOf(callback)
        if (index >= 0) list.splice(index, 1)
      }
    },
    /** 复刻 ctx.waterfall(service, name, options, inner)。 */
    waterfall(name, options, inner) {
      const cbs = [...(hooks.get(name) ?? [])]
      const next = () => (cbs.shift() ?? inner)(options)
      return next()
    },
    hookCount(name) {
      return (hooks.get(name) ?? []).length
    },
  }
  return ctx
}

/** 尝试加载真实 cordis，并挂上一个假的 llm 服务。 */
async function makeCtx() {
  for (const candidate of CORDIS_CANDIDATES) {
    try {
      const mod = await import(pathToFileURL(candidate).href)
      const Context = mod.Context ?? mod.default?.Context
      if (typeof Context !== 'function') continue
      const root = new Context()
      root.provide?.('llm', { stream: null })
      if (typeof root.on !== 'function' || typeof root.waterfall !== 'function') continue
      return { ctx: root, kind: 'cordis', entry: candidate }
    } catch {
      /* 换下一个候选 */
    }
  }
  return { ctx: makeFallbackCtx(), kind: 'fallback', entry: '' }
}

/** 一个可观测的下游流。 */
function downstream(chunks) {
  const state = { calls: 0 }
  const fn = () => {
    state.calls += 1
    return (async function* () {
      for (const chunk of chunks) yield chunk
    })()
  }
  fn.state = state
  return fn
}

const OK_CHUNKS = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'hi' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } },
  { type: 'finish', reason: { kind: 'stop' } },
]

async function drain(stream) {
  const out = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

test('waterfall 语义：命中拦截时下游完全不被调用，且产出终止 error 分片', async () => {
  const { ctx, kind } = await makeCtx()
  const { cfg } = normalizeConfig({ blockedProviders: ['nvida'] })
  const guard = createGuard(ctx, cfg, { log: () => {} })
  ctx.on('llm/stream', guard.listener, { prepend: true })

  const next = downstream(OK_CHUNKS)
  const chunks = await drain(ctx.waterfall('llm/stream', { provider: 'nvida', model: 'x' }, next))

  assert.equal(next.state.calls, 0, '下游适配器不应被调用')
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].type, 'finish')
  assert.equal(chunks[0].reason.kind, 'error')
  assert.equal(chunks[0].reason.failure.code, 'POLICY_BLOCKED')
  assert.equal(guard.stats.blocked, 1)
  assert.equal(guard.stats.allowed, 0)
  assert.ok(kind === 'cordis' || kind === 'fallback')
})

test('waterfall 语义：未命中时原样透传下游分片', async () => {
  const { ctx } = await makeCtx()
  const { cfg } = normalizeConfig({ blockedProviders: ['nvida'] })
  const guard = createGuard(ctx, cfg, { log: () => {} })
  ctx.on('llm/stream', guard.listener)

  const next = downstream(OK_CHUNKS)
  const chunks = await drain(ctx.waterfall('llm/stream', { provider: 'other', model: 'y' }, next))

  assert.equal(next.state.calls, 1)
  assert.deepEqual(chunks, OK_CHUNKS)
  assert.equal(guard.stats.allowed, 1)
})

test('waterfall 语义：本插件未拦截时不会吞掉其它插件的否决', async () => {
  const { ctx } = await makeCtx()
  const { cfg } = normalizeConfig({ blockedProviders: ['nvida'] })
  const guard = createGuard(ctx, cfg, { log: () => {} })
  // 外层插件（后注册）先否决
  ctx.on('llm/stream', () => terminalStream({ type: 'finish', reason: { kind: 'stop' } }))
  ctx.on('llm/stream', guard.listener)

  const next = downstream(OK_CHUNKS)
  const chunks = await drain(ctx.waterfall('llm/stream', { provider: 'other', model: 'y' }, next))
  assert.equal(next.state.calls, 0, '外层否决后下游不应被调用')
  assert.equal(chunks.length, 1)
  assert.equal(guard.stats.seen, 0, '我们的监听器根本没被调用')
})

test('scope=auto：用户主动调用放行，自动调用拦截', async () => {
  const { ctx } = await makeCtx()
  const { cfg } = normalizeConfig({ blockedProviders: ['nvida'], scope: 'auto' })
  const guard = createGuard(ctx, cfg, { log: () => {} })
  ctx.on('llm/stream', guard.listener)

  const userCall = downstream(OK_CHUNKS)
  await drain(ctx.waterfall('llm/stream', { provider: 'nvida', model: 'x' }, userCall))
  assert.equal(userCall.state.calls, 1, '用户主动调用应放行')

  const autoCall = downstream(OK_CHUNKS)
  const chunks = await drain(ctx.waterfall('llm/stream', { provider: 'nvida', model: 'x', purpose: 'session-title' }, autoCall))
  assert.equal(autoCall.state.calls, 0, '自动调用应被拦截')
  assert.equal(chunks[0].reason.failure.code, 'POLICY_BLOCKED')
})

test('redirect：改道到 fallback 并逐分片转发', async () => {
  const { ctx } = await makeCtx()
  const { cfg } = normalizeConfig({
    mode: 'redirect',
    blockedProviders: ['expensive'],
    fallback: { provider: 'cheap', model: 'cheap-small' },
  })
  const guard = createGuard(ctx, cfg, { log: () => {} })

  const seen = []
  ctx.llm.stream = (options) => {
    seen.push(options)
    return (async function* () {
      for (const chunk of OK_CHUNKS) yield chunk
    })()
  }
  ctx.on('llm/stream', guard.listener)

  const next = downstream(OK_CHUNKS)
  const chunks = await drain(ctx.waterfall('llm/stream', { provider: 'expensive', model: 'big' }, next))

  assert.equal(next.state.calls, 0, '原目标不应被调用')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].provider, 'cheap')
  assert.equal(seen[0].model, 'cheap-small')
  assert.deepEqual(chunks, OK_CHUNKS, '改道后的分片被完整转发')
  assert.equal(guard.stats.redirected, 1)
})

test('redirect：fallback 命中同一规则时不会无限递归', async () => {
  const { ctx } = await makeCtx()
  const { cfg } = normalizeConfig({
    mode: 'redirect',
    blockedProviders: ['*'],
    fallback: { provider: 'anywhere', model: 'any-model' },
  })
  const guard = createGuard(ctx, cfg, { log: () => {} })

  let forwarded = 0
  ctx.llm.stream = (options) => {
    forwarded += 1
    // 模拟宿主再次走完整 waterfall：把请求交回链路
    return ctx.waterfall('llm/stream', options, () => (async function* () {
      for (const chunk of OK_CHUNKS) yield chunk
    })())
  }
  ctx.on('llm/stream', guard.listener)

  const next = downstream(OK_CHUNKS)
  const chunks = await drain(ctx.waterfall('llm/stream', { provider: 'blocked', model: 'x' }, next))

  assert.equal(forwarded, 1, '只改道一次')
  assert.deepEqual(chunks, OK_CHUNKS, '改道后放行，不再被拦截')
  assert.equal(guard.stats.blocked, 0)
})

test('redirect：未配置 fallback 时降级为拦截', async () => {
  const { ctx } = await makeCtx()
  const { cfg } = normalizeConfig({ mode: 'redirect', blockedProviders: ['nvida'] })
  const guard = createGuard(ctx, cfg, { log: () => {} })
  ctx.on('llm/stream', guard.listener)

  const next = downstream(OK_CHUNKS)
  const chunks = await drain(ctx.waterfall('llm/stream', { provider: 'nvida', model: 'x' }, next))
  assert.equal(next.state.calls, 0)
  assert.equal(chunks[0].reason.failure.code, 'POLICY_BLOCKED')
})

test('warn：只告警不阻断', async () => {
  const { ctx } = await makeCtx()
  const { cfg } = normalizeConfig({ mode: 'warn', blockedProviders: ['nvida'] })
  const messages = []
  const guard = createGuard(ctx, cfg, { log: (m) => messages.push(m) })
  ctx.on('llm/stream', guard.listener)

  const next = downstream(OK_CHUNKS)
  const chunks = await drain(ctx.waterfall('llm/stream', { provider: 'nvida', model: 'x' }, next))
  assert.equal(next.state.calls, 1)
  assert.deepEqual(chunks, OK_CHUNKS)
  assert.equal(guard.stats.warned, 1)
  assert.ok(messages.some((m) => m.includes('告警')))
})

test('协议合规：产出流能通过 dsh-llm 的流语法校验', async () => {
  const { ctx } = await makeCtx()
  const { cfg } = normalizeConfig({ blockedProviders: ['nvida'] })
  const guard = createGuard(ctx, cfg, { log: () => {} })

  // 复刻 @deepseek-ai/dsh-llm 的 invariant.js validateStream 关键约束
  const fail = (message) => { throw new Error('INVARIANT: ' + message) }
  const validator = (_options, next) => (async function* () {
    const source = next()
    let finished = false
    for await (const chunk of source) {
      if (finished) fail('emitted chunk after terminal finish')
      if (chunk.type === 'finish') {
        if (chunk.reason?.kind !== 'error' && chunk.reason?.kind !== 'aborted' && chunk.reason?.kind !== 'stop') {
          fail('unknown finish reason kind')
        }
        finished = true
      }
      yield chunk
    }
    if (!finished) fail('stream ended without a terminal finish chunk')
  })()

  ctx.on('llm/stream', validator, { prepend: true }) // 最外层，模拟 llm-invariant
  ctx.on('llm/stream', guard.listener)

  const next = downstream(OK_CHUNKS)
  const chunks = await drain(ctx.waterfall('llm/stream', { provider: 'nvida', model: 'x' }, next))
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].type, 'finish')
})

test('installGuard：注册监听器、输出规则清单、禁用时不注册', async () => {
  const { ctx } = await makeCtx()
  const messages = []
  const hooks = { log: (m) => messages.push(m) }

  const installed = installGuard(ctx, { blockedProviders: ['nvida'], scope: 'auto' }, hooks)
  assert.ok(installed, '应返回安装句柄')
  assert.equal(installed.cfg.rules.length, 1)
  assert.ok(messages.some((m) => m.includes('已启用')))
  assert.ok(messages.some((m) => m.includes('provider=nvida')))

  const next = downstream(OK_CHUNKS)
  await drain(ctx.waterfall('llm/stream', { provider: 'nvida', model: 'x', purpose: 'compaction' }, next))
  assert.equal(next.state.calls, 0, '安装后即生效')

  const { ctx: ctx2 } = await makeCtx()
  const offMessages = []
  const off = installGuard(ctx2, { enabled: false }, { log: (m) => offMessages.push(m) })
  assert.equal(off, null)
  assert.ok(offMessages.some((m) => m.includes('禁用')))

  const next2 = downstream(OK_CHUNKS)
  await drain(ctx2.waterfall('llm/stream', { provider: 'nvida', model: 'x' }, next2))
  assert.equal(next2.state.calls, 1, '禁用时下游照常调用')
})

test('installGuard：配置写错时给出提醒但仍然工作', async () => {
  const { ctx } = await makeCtx()
  const messages = []
  const installed = installGuard(ctx, { mode: 'nonsense', blockedModels: ['x'] }, { log: (m) => messages.push(m) })
  assert.ok(installed)
  assert.ok(messages.some((m) => m.includes('配置提醒')))
  assert.equal(installed.cfg.mode, 'block', '非法动作回退为 block')
})

test('summarize：统计摘要包含各类计数', async () => {
  const { ctx } = await makeCtx()
  const { cfg } = normalizeConfig({ blockedProviders: ['nvida'] })
  const guard = createGuard(ctx, cfg, { log: () => {} })
  ctx.on('llm/stream', guard.listener)
  await drain(ctx.waterfall('llm/stream', { provider: 'nvida', model: 'x' }, downstream(OK_CHUNKS)))
  await drain(ctx.waterfall('llm/stream', { provider: 'ok', model: 'y' }, downstream(OK_CHUNKS)))

  const text = summarize(guard.stats)
  assert.ok(text.includes('总调用 2'))
  assert.ok(text.includes('拦截 1'))
  assert.ok(text.includes('放行 1'))
  assert.ok(text.includes('nvida/x'))
})

test('signal 已取消时产出 aborted 结局而非 error', async () => {
  const { ctx } = await makeCtx()
  const { cfg } = normalizeConfig({ blockedProviders: ['nvida'] })
  const guard = createGuard(ctx, cfg, { log: () => {} })
  ctx.on('llm/stream', guard.listener)

  const controller = new AbortController()
  controller.abort()
  const chunks = await drain(ctx.waterfall('llm/stream', { provider: 'nvida', model: 'x', signal: controller.signal }, downstream(OK_CHUNKS)))
  assert.equal(chunks[0].reason.kind, 'aborted')
})
