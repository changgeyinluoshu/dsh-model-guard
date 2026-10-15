/**
 * 新功能测试：白名单、预设/会话作用域、权重软调度、熔断、热重载、审计、冲突检测。
 *
 * 用真实的 cordis Context 驱动 waterfall；sessions / events 用最小替身，
 * 以便精确控制「agent 预设」「会话」「已有监听器」这些外部事实。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createGuard, installGuard, createBreaker, summarize } from '../lib/guard.js'
import { normalizeConfig, decide, pickWeighted, pickSoftRoute, POLICIES } from '../lib/matcher.js'

const CORDIS = [
  process.env.DSH_APP_ROOT ? join(process.env.DSH_APP_ROOT, 'node_modules/@deepseek-ai/cordis/lib/index.js') : null,
  'D:/dsh d/DSH Desktop Beta/resources/app/node_modules/@deepseek-ai/cordis/lib/index.js',
].filter(Boolean)

function fallbackCtx() {
  const hooks = new Map()
  return {
    llm: { stream: null },
    on(name, cb) {
      const list = hooks.get(name) ?? []
      list.push(cb)
      hooks.set(name, list)
      return () => { const i = list.indexOf(cb); if (i >= 0) list.splice(i, 1) }
    },
    waterfall(name, options, inner) {
      const cbs = [...(hooks.get(name) ?? [])]
      // 与真实 cordis 一致：监听器收到 (options, next)
      const next = () => (cbs.shift() ?? inner)(options, next)
      return next()
    },
  }
}

/**
 * @param extra - 需要注入的替身（sessions / events / llm）
 * @param plain - 强制用普通对象上下文。cordis 的 Context 是 Proxy，
 *   不允许直接挂 events 之类的属性，这类测试需要 plain 模式。
 */
async function makeCtx(extra = {}, plain = false) {
  if (plain) return Object.assign(fallbackCtx(), extra)
  for (const candidate of CORDIS) {
    try {
      const mod = await import(pathToFileURL(candidate).href)
      const Context = mod.Context ?? mod.default?.Context
      if (typeof Context !== 'function') continue
      const root = new Context()
      root.provide?.('llm', { stream: null })
      if (typeof root.on === 'function' && typeof root.waterfall === 'function') {
        return Object.assign(root, extra)
      }
    } catch {
      /* 下一个候选 */
    }
  }
  return Object.assign(fallbackCtx(), extra)
}

const OK = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'hi' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } },
  { type: 'finish', reason: { kind: 'stop' } },
]
const ERR = [{ type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'SERVER' } } }]

function streamOf(chunks) {
  return (async function* () { for (const c of chunks) yield c })()
}
async function drain(stream) {
  const out = []
  for await (const c of stream) out.push(c)
  return out
}
/** 终止分片总是流的最后一个；放行时流里还有 block-start 等内容分片。 */
const last = (chunks) => chunks[chunks.length - 1]
const finishCode = (chunks) => last(chunks)?.reason?.failure?.code
const finishKind = (chunks) => last(chunks)?.reason?.kind

function makeRun(ctx, chunks = OK) {
  const state = { downstream: 0 }
  return {
    state,
    run: async (options) => {
      const out = await drain(ctx.waterfall('llm/stream', options, () => {
        state.downstream += 1
        return streamOf(chunks)
      }))
      return out
    },
  }
}

/* ---------------- ① 白名单模式 ---------------- */

test('白名单模式：仅放行名单内的模型，其余全部拦截', async () => {
  const ctx = await makeCtx()
  const guard = createGuard(ctx, { policy: 'allowlist', allowedModels: ['deepseek-ai/*'], mode: 'block' }, { log: () => {} })
  ctx.on('llm/stream', guard.listener)
  const { run, state } = makeRun(ctx)

  const ok = await run({ provider: 'nvida', model: 'deepseek-ai/deepseek-v4.1-flash' })
  assert.equal(finishKind(ok), 'stop', '白名单内放行')
  assert.equal(state.downstream, 1)

  const denied = await run({ provider: 'nvida', model: 'meta/llama-3.2-90b' })
  assert.equal(finishCode(denied), 'POLICY_BLOCKED', '白名单外拦截')
  assert.equal(state.downstream, 1, '被拦时下游不再收到请求')
})

test('白名单模式：allowedProviders 同样生效，rules 里的 allow 也算放行', async () => {
  const cfg = normalizeConfig({
    policy: 'allowlist',
    allowedProviders: ['trusted'],
    rules: [{ model: 'special-*', action: 'allow' }],
  }).cfg
  assert.equal(decide(cfg, { provider: 'trusted', model: 'anything' }).action, 'allow')
  assert.equal(decide(cfg, { provider: 'other', model: 'special-1' }).action, 'allow')
  assert.equal(decide(cfg, { provider: 'other', model: 'random' }).action, 'block')
  assert.equal(decide(cfg, { provider: 'other', model: 'random' }).reason, 'allowlist-miss')
})

test('POLICIES 常量与非法 policy 回退', () => {
  assert.deepEqual([...POLICIES], ['blocklist', 'allowlist'])
  const { cfg, warnings } = normalizeConfig({ policy: 'unknown-mode' })
  assert.equal(cfg.policy, 'blocklist')
  assert.ok(warnings.some((w) => w.includes('policy')))
})

/* ---------------- ② 按预设 / 会话 ---------------- */

test('作用域：按 agent 预设分流，命中后只应用该作用域的名单', async () => {
  const sessions = new Map()
  const ctx = await makeCtx({
    sessions: { get: (id) => sessions.get(id) ?? null },
  })
  sessions.set('s-ptc', { header: { agentPreset: 'ptc' } })
  sessions.set('s-std', { header: { agentPreset: 'standard' } })

  const guard = createGuard(ctx, {
    blockedModels: [],
    scopes: [
      { match: { preset: 'ptc' }, policy: 'allowlist', allowedModels: ['cheap/*'] },
    ],
  }, { log: () => {} })
  ctx.on('llm/stream', guard.listener)
  const { run, state } = makeRun(ctx)

  // ptc 预设：白名单，cheap/* 放行，其它拦
  const a = await run({ provider: 'p', model: 'cheap/small', sessionId: 's-ptc' })
  assert.equal(finishKind(a), 'stop')
  const b = await run({ provider: 'p', model: 'expensive/big', sessionId: 's-ptc' })
  assert.equal(finishCode(b), 'POLICY_BLOCKED', 'ptc 预设下白名单外被拦')

  // standard 预设：不命中作用域，走全局（无规则 => 放行）
  const c = await run({ provider: 'p', model: 'expensive/big', sessionId: 's-std' })
  assert.equal(finishKind(c), 'stop', '未命中作用域的会话走全局配置')
  assert.equal(state.downstream, 2)
})

test('作用域：按 sessionId 通配匹配', async () => {
  const ctx = await makeCtx()
  const guard = createGuard(ctx, {
    scopes: [{ match: { session: 'auto-*' }, blockedModels: ['*'] }],
  }, { log: () => {} })
  ctx.on('llm/stream', guard.listener)
  const { run } = makeRun(ctx)

  const auto = await run({ provider: 'p', model: 'm', sessionId: 'auto-task-1' })
  assert.equal(finishCode(auto), 'POLICY_BLOCKED', '自动任务会话被整段拦截')
  const manual = await run({ provider: 'p', model: 'm', sessionId: 'human-1' })
  assert.equal(finishKind(manual), 'stop', '普通会话不受该作用域影响')
})

test('作用域：第一条命中的生效，名单为空的作用域被忽略', () => {
  const { cfg, warnings } = normalizeConfig({
    scopes: [
      { match: { preset: 'x' } },
      { match: { preset: 'x' }, blockedModels: ['a'] },
      { match: { preset: 'y' }, blockedModels: ['b'] },
    ],
  })
  assert.equal(cfg.scopes.length, 2, '空名单作用域被丢弃')
  assert.ok(warnings.some((w) => w.includes('没有任何名单内容')))
  assert.equal(decide(cfg, { provider: 'p', model: 'a' }, { preset: 'x' }).action, 'block')
  assert.equal(decide(cfg, { provider: 'p', model: 'b' }, { preset: 'x' }).action, 'allow', '只应用第一条命中的作用域')
  assert.equal(decide(cfg, { provider: 'p', model: 'b' }, { preset: 'z' }).action, 'allow')
})

/* ---------------- ⑦ 权重软调度 ---------------- */

test('权重软调度：按权重抽路线，权重为 0 的路线不被选中', () => {
  const routes = [{ action: 'allow', weight: 3 }, { action: 'block', weight: 1 }]
  assert.equal(pickWeighted(routes, () => 0).action, 'allow')
  assert.equal(pickWeighted(routes, () => 0.74).action, 'allow')
  assert.equal(pickWeighted(routes, () => 0.99).action, 'block')
  assert.equal(pickWeighted([{ action: 'block', weight: 0 }], () => 0.5).action, 'block', '全零时退化为第一条')
  assert.equal(pickWeighted([], () => 0.5), null)
})

test('权重软调度：命中 softRules 时按权重决定放行/拦截/改道', async () => {
  const ctx = await makeCtx()
  let roll = 0
  const raw = {
    softRules: [{
      match: { model: 'expensive-*' },
      routes: [
        { action: 'allow', weight: 1 },
        { action: 'block', weight: 1 },
      ],
    }],
  }
  const guard = createGuard(ctx, raw, { log: () => {} })
  const hook = { preset: '', breakerOpen: false, random: () => roll }
  // 直接经由 decide 验证权重分支，避免随机性影响 waterfall 断言
  const cfg = normalizeConfig(raw).cfg
  assert.equal(decide(cfg, { provider: 'p', model: 'expensive-1' }, hook).action, 'allow')
  roll = 0.99
  assert.equal(decide(cfg, { provider: 'p', model: 'expensive-1' }, hook).action, 'block')
  assert.equal(decide(cfg, { provider: 'p', model: 'cheap-1' }, hook).action, 'allow', '未命中 softRules 的走常规判定')
  assert.notEqual(pickSoftRoute(cfg, { provider: 'p', model: 'cheap-1' }, hook), null === true)

  // 端到端：软调度唯一路线是 block 时，下游不应被调用
  const guard2 = createGuard(ctx, { softRules: [{ match: { model: 'expensive-*' }, routes: [{ action: 'block', weight: 1 }] }] }, { log: () => {} })
  ctx.on('llm/stream', guard2.listener)
  const { run, state } = makeRun(ctx)
  const denied = await run({ provider: 'p', model: 'expensive-1' })
  assert.equal(finishCode(denied), 'POLICY_BLOCKED')
  assert.equal(state.downstream, 0, '软调度判定为拦截时下游不被调用')
})

test('软调度：改道路线会落到 fallback 目标', async () => {
  const ctx = await makeCtx()
  const seen = []
  ctx.llm.stream = (options) => { seen.push(options); return streamOf(OK) }
  const raw = {
    softRules: [{
      match: { model: 'big-*' },
      routes: [{ action: 'redirect', provider: 'cheap', model: 'small', weight: 1 }],
    }],
  }
  const guard = createGuard(ctx, raw, { log: () => {} })
  ctx.on('llm/stream', guard.listener)
  const { run, state } = makeRun(ctx)

  const out = await run({ provider: 'p', model: 'big-1' })
  assert.equal(state.downstream, 0, '原目标未被调用')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].provider, 'cheap')
  assert.equal(seen[0].model, 'small')
  assert.deepEqual(out, OK)
  assert.equal(guard.stats.softRouted, 1)
})

/* ---------------- ④ 熔断 ---------------- */

test('createBreaker：连续失败开路、冷却后自动恢复', () => {
  const b = createBreaker()
  const cfg = { breaker: { enabled: true, failureThreshold: 2, cooldownMs: 1000, codes: ['SERVER'] } }
  const failure = { code: 'SERVER', message: 'x' }

  assert.equal(b.isOpen('p', 0), false)
  assert.equal(b.record('p', failure, cfg, 0), null)
  assert.equal(b.isOpen('p', 0), false)
  assert.notEqual(b.record('p', failure, cfg, 0), null, '第二次达到阈值应开路')
  assert.equal(b.isOpen('p', 500), true, '冷却期内保持开路')
  assert.equal(b.isOpen('p', 1001), false, '冷却结束自动恢复')
  assert.equal(b.isOpen('p', 1001), false)

  // 成功一次即清零
  b.record('q', failure, cfg, 0)
  b.record('q', null, cfg, 0)
  assert.equal(b.record('q', failure, cfg, 0), null, '中途成功会清零计数')

  // 不在 codes 里的失败不计入
  assert.equal(b.record('r', { code: 'POLICY_BLOCKED' }, cfg, 0), null)
})

test('熔断联动：服务商连续报错后临时拦截，冷却后恢复放行', async () => {
  const ctx = await makeCtx()
  const raw = { breaker: { enabled: true, failureThreshold: 2, cooldownMs: 50, codes: ['SERVER'] } }
  const guard = createGuard(ctx, raw, { log: () => {} })
  ctx.on('llm/stream', guard.listener)

  // 连续两次真实失败（下游返回 error finish，被 observe 观察到）
  const failing = makeRun(ctx, ERR)
  await failing.run({ provider: 'nvida', model: 'm' })
  await failing.run({ provider: 'nvida', model: 'm' })
  assert.equal(guard.breaker.isOpen('nvida'), true, '达到阈值后应熔断')

  const blocked = makeRun(ctx)
  const out = await blocked.run({ provider: 'nvida', model: 'm' })
  assert.equal(finishCode(out), 'PROVIDER_CIRCUIT_OPEN', '熔断期间直接拦截')
  assert.equal(blocked.state.downstream, 0, '熔断时下游不被调用')
  assert.equal(guard.stats.breakerBlocked, 1)

  // 其它 provider 不受影响
  const other = makeRun(ctx)
  const okOut = await other.run({ provider: 'other', model: 'm' })
  assert.equal(finishKind(okOut), 'stop')

  // 冷却结束自动恢复
  await new Promise((r) => setTimeout(r, 70))
  const recovered = makeRun(ctx)
  const rec = await recovered.run({ provider: 'nvida', model: 'm' })
  assert.equal(finishKind(rec), 'stop', '冷却后自动恢复放行')
})

/* ---------------- ⑥ 热重载 ---------------- */

test('热重载：配置对象原地变化后立即生效，无需重建监听器', async () => {
  const ctx = await makeCtx()
  // 模拟 settings 服务写入后的形态：volatile 取值器每次读最新值
  const live = { providers: [], models: [] }
  const raw = {
    blockedProviders: { get: () => live.providers },
    blockedModels: { get: () => live.models },
    mode: { get: () => 'block' },
  }
  const guard = createGuard(ctx, raw, { log: () => {} })
  ctx.on('llm/stream', guard.listener)
  const { run, state } = makeRun(ctx)

  const before = await run({ provider: 'nvida', model: 'm' })
  assert.equal(finishKind(before), 'stop', '初始无规则时放行')

  live.providers = ['nvida']          // 等价于「设置界面点了保存」
  const after = await run({ provider: 'nvida', model: 'm' })
  assert.equal(finishCode(after), 'POLICY_BLOCKED', '改配置后下一次调用立刻生效')
  assert.equal(state.downstream, 1)

  live.providers = []                 // 再改回来
  const restored = await run({ provider: 'nvida', model: 'm' })
  assert.equal(finishKind(restored), 'stop', '撤销后同样立即生效')
})

test('热重载：currentConfig 返回实时解析结果', async () => {
  const ctx = await makeCtx()
  const raw = { blockedModels: { get: () => ['a'] } }
  const guard = createGuard(ctx, raw, { log: () => {} })
  assert.deepEqual(guard.currentConfig().blockedModels, ['a'])
})

/* ---------------- ③ 审计日志 ---------------- */

test('审计：记录到内存环形缓冲，并写入会话日志', async () => {
  const appended = []
  const session = { header: { agentPreset: 'ptc' }, append: (type, data) => appended.push({ type, data }) }
  const ctx = await makeCtx({ sessions: { get: (id) => (id === 's1' ? session : null) } })
  const guard = createGuard(ctx, { blockedProviders: ['nvida'], audit: { maxEntries: 3 } }, { log: () => {} })
  ctx.on('llm/stream', guard.listener)
  const { run } = makeRun(ctx)

  await run({ provider: 'nvida', model: 'm', sessionId: 's1', purpose: 'compaction' })
  assert.equal(guard.auditLog.length, 1)
  const entry = guard.auditLog[0]
  assert.equal(entry.action, 'block')
  assert.equal(entry.provider, 'nvida')
  assert.equal(entry.purpose, 'compaction')
  assert.equal(entry.preset, 'ptc')
  assert.ok(entry.rule.includes('blockedProviders'))

  assert.equal(appended.length, 1, '应写入会话日志')
  assert.equal(appended[0].type, 'model-guard/blocked')
  assert.equal(appended[0].data.model, 'm')

  // 环形缓冲上限
  for (let i = 0; i < 5; i += 1) await run({ provider: 'nvida', model: 'm', sessionId: 's1' })
  assert.equal(guard.auditLog.length, 3, '不超过 maxEntries')
})

test('审计：会话 append 抛错不影响拦截行为', async () => {
  const session = { header: {}, append: () => { throw new Error('session closed') } }
  const ctx = await makeCtx({ sessions: { get: () => session } })
  const guard = createGuard(ctx, { blockedProviders: ['nvida'] }, { log: () => {} })
  ctx.on('llm/stream', guard.listener)
  const { run } = makeRun(ctx)
  const out = await run({ provider: 'nvida', model: 'm', sessionId: 's1' })
  assert.equal(finishCode(out), 'POLICY_BLOCKED', '审计异常不影响拦截')
})

/* ---------------- ⑥ 冲突检测 ---------------- */

test('冲突检测：发现职责重叠的监听器时给出提示', async () => {
  const logs = []
  const hooks = {
    'llm/stream': [
      { ctx: { plugin: { name: 'other-model-gate' } } },
      { ctx: { plugin: { name: 'some-observer' } } },
    ],
  }
  const ctx = await makeCtx({ events: { _hooks: hooks } }, true)
  const guard = createGuard(ctx, { blockedProviders: ['nvida'] }, { log: (m) => logs.push(m) })
  ctx.on('llm/stream', guard.listener)
  const { run } = makeRun(ctx)

  await run({ provider: 'ok', model: 'm' })
  assert.ok(logs.some((l) => l.includes('职责重叠') && l.includes('other-model-gate')), '应提示冲突插件')
})

test('冲突检测：无冲突时不误报', async () => {
  const logs = []
  const ctx = await makeCtx({ events: { _hooks: { 'llm/stream': [{ ctx: { plugin: { name: 'session-title' } } }] } } }, true)
  const guard = createGuard(ctx, { blockedProviders: ['nvida'] }, { log: (m) => logs.push(m) })
  ctx.on('llm/stream', guard.listener)
  const { run } = makeRun(ctx)
  await run({ provider: 'ok', model: 'm' })
  assert.ok(!logs.some((l) => l.includes('职责重叠')), '不应误报')
  assert.ok(logs.some((l) => l.includes('其它监听者')), '但会如实列出')
})

/* ---------------- 统计与启动日志 ---------------- */

test('summarize：包含软调度与熔断计数', () => {
  const text = summarize({ seen: 5, allowed: 1, blocked: 1, redirected: 1, warned: 1, softRouted: 2, breakerBlocked: 3, byTarget: new Map([['p/m#user', 5]]) })
  assert.ok(text.includes('软调度 2'))
  assert.ok(text.includes('熔断 3'))
})

test('installGuard：启动日志列出作用域、软调度与熔断配置', async () => {
  const ctx = await makeCtx()
  const logs = []
  const installed = installGuard(ctx, {
    policy: 'allowlist',
    allowedModels: ['a/*'],
    breaker: { enabled: true, failureThreshold: 4, cooldownMs: 30000 },
    scopes: [{ match: { preset: 'ptc' }, blockedModels: ['b'] }],
    softRules: [{ match: { model: 'c' }, routes: [{ action: 'allow', weight: 2 }, { action: 'block', weight: 1 }] }],
  }, { log: (m) => logs.push(m) })
  assert.ok(installed)
  const text = logs.join('\n')
  assert.ok(text.includes('policy=allowlist'))
  assert.ok(text.includes('作用域'))
  assert.ok(text.includes('软调度'))
  assert.ok(text.includes('熔断：连续 4 次失败'))
})
