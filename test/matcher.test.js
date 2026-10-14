import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  unwrapVolatile,
  unwrapConfig,
  globMatch,
  matchesAny,
  isAutomaticCall,
  normalizeConfig,
  decide,
  buildBlockedFinish,
  DEFAULT_AUTO_PURPOSES,
} from '../lib/matcher.js'

test('globMatch：通配符、大小写与空模式', () => {
  assert.equal(globMatch('deepseek-ai/*', 'deepseek-ai/deepseek-v4.1-flash'), true)
  assert.equal(globMatch('deepseek-ai/*', 'deepseek-ai/'), true)
  assert.equal(globMatch('*v4*', 'DEEPSEEK-ai/DeepSeek-V4.1-Flash'), true, '大小写不敏感')
  assert.equal(globMatch('nvida', 'nvidia'), false)
  assert.equal(globMatch('', 'anything'), false, '空模式永不匹配')
  assert.equal(globMatch('a.b', 'axb'), false, '正则元字符被转义')
  assert.equal(globMatch('a?b', 'a/b'), true, '? 匹配任意单字符')
  assert.equal(globMatch('a?b', 'a/bc'), false)
})

test('matchesAny：数组任一命中，兼容单字符串', () => {
  assert.equal(matchesAny(['foo', 'bar*'], 'bar-baz'), true)
  assert.equal(matchesAny('foo', 'foo'), true)
  assert.equal(matchesAny([], 'foo'), false)
  assert.equal(matchesAny(undefined, 'foo'), false)
})

test('isAutomaticCall：purpose 决定是否为自动调用', () => {
  assert.equal(isAutomaticCall({ purpose: 'session-title' }, DEFAULT_AUTO_PURPOSES), true)
  assert.equal(isAutomaticCall({ purpose: 'compaction' }, DEFAULT_AUTO_PURPOSES), true)
  assert.equal(isAutomaticCall({ purpose: undefined }, DEFAULT_AUTO_PURPOSES), false, '无 purpose 即用户主动调用')
  assert.equal(isAutomaticCall({ purpose: 'subagent' }, ['subagent']), true, '自动调用集合可自定义')
})

test('unwrapVolatile：解包 DSH 的 volatile 取值器', () => {
  assert.equal(unwrapVolatile('warn'), 'warn', '裸值原样返回')
  assert.equal(unwrapVolatile({ get: () => 'warn' }), 'warn')
  assert.equal(unwrapVolatile({ get: () => ({ get: () => 42 }) }), 42, '兼容嵌套取值器')
  assert.deepEqual(unwrapVolatile({ get: () => ['a', 'b'] }), ['a', 'b'])
  assert.equal(unwrapVolatile(undefined), undefined)
  assert.equal(unwrapVolatile(null), null)
  assert.equal(unwrapVolatile({ get() { throw new Error('boom') } }), undefined, '取值抛错时安全降级')
  assert.deepEqual(unwrapConfig({ a: { get: () => 1 }, b: 2 }), { a: 1, b: 2 })
  assert.deepEqual(unwrapConfig(null), {})
})

test('normalizeConfig：能读出被 volatile 包装的配置（设置界面保存后的形态）', () => {
  // DSH 把 .volatile() 字段以取值器形态交给插件——这正是界面保存后 host 收到的样子。
  const volatileConfig = {
    enabled: { get: () => true },
    mode: { get: () => 'warn' },
    scope: { get: () => 'all' },
    blockedProviders: { get: () => ['nvida'] },
    blockedModels: { get: () => ['deepseek-ai/*'] },
  }
  const { cfg, warnings } = normalizeConfig(volatileConfig)
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.mode, 'warn', '不能回退成默认的 block')
  assert.equal(cfg.scope, 'all')
  assert.equal(cfg.rules.length, 2)
  assert.equal(decide(cfg, { provider: 'nvida', model: 'x' }).action, 'warn')
  assert.equal(decide(cfg, { provider: 'p', model: 'deepseek-ai/y' }).action, 'warn')
  assert.ok(!warnings.some((w) => w.includes('mode')), '包装值不应被当成非法值')
})

test('normalizeConfig：无规则时给出提醒', () => {
  const { cfg, warnings } = normalizeConfig({})
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.mode, 'block')
  assert.equal(cfg.scope, 'all')
  assert.equal(cfg.rules.length, 0)
  assert.ok(warnings.some((w) => w.includes('没有任何拦截规则')))
})

test('normalizeConfig：非法 mode/scope 回退并告警', () => {
  const { cfg, warnings } = normalizeConfig({ mode: 'destroy', scope: 'sometimes' })
  assert.equal(cfg.mode, 'block')
  assert.equal(cfg.scope, 'all')
  assert.ok(warnings.some((w) => w.includes('mode')), '应提醒 mode 非法')
  assert.ok(warnings.some((w) => w.includes('scope')), '应提醒 scope 非法')
})

test('normalizeConfig：简洁字段转成规则', () => {
  const { cfg } = normalizeConfig({
    blockedProviders: ['nvida'],
    blockedModels: 'deepseek-ai/*',
    blockedPurposes: ['session-title'],
    scope: 'auto',
  })
  assert.equal(cfg.rules.length, 3)
  for (const rule of cfg.rules) {
    assert.equal(rule.scope, 'auto')
    assert.equal(rule.action, 'block')
  }
})

test('normalizeConfig：非法规则被丢弃并告警，合法规则保留', () => {
  const { cfg, warnings } = normalizeConfig({
    rules: [null, { note: '没有条件' }, { model: 'x', action: 'allow' }],
  })
  assert.equal(cfg.rules.length, 1)
  assert.equal(cfg.rules[0].model[0], 'x')
  assert.equal(warnings.filter((w) => w.includes('rules[')).length, 2)
})

test('decide：禁用时不拦任何调用', () => {
  const { cfg } = normalizeConfig({ enabled: false, blockedModels: ['*'] })
  assert.equal(decide(cfg, { provider: 'p', model: 'm' }).action, 'allow')
})

test('decide：按 provider 拦截', () => {
  const { cfg } = normalizeConfig({ blockedProviders: ['nvida'] })
  assert.equal(decide(cfg, { provider: 'nvida', model: 'x' }).action, 'block')
  assert.equal(decide(cfg, { provider: 'other', model: 'x' }).action, 'allow')
})

test('decide：按模型通配拦截', () => {
  const { cfg } = normalizeConfig({ blockedModels: ['deepseek-ai/*'] })
  assert.equal(decide(cfg, { provider: 'p', model: 'deepseek-ai/deepseek-v4.1-flash' }).action, 'block')
  assert.equal(decide(cfg, { provider: 'p', model: 'moonshot/kimi-k3' }).action, 'allow')
})

test('decide：scope=auto 只拦自动调用，用户主动调用放行', () => {
  const { cfg } = normalizeConfig({ blockedProviders: ['nvida'], scope: 'auto' })
  assert.equal(decide(cfg, { provider: 'nvida', model: 'x', purpose: 'compaction' }).action, 'block')
  assert.equal(decide(cfg, { provider: 'nvida', model: 'x', purpose: 'session-title' }).action, 'block')
  assert.equal(decide(cfg, { provider: 'nvida', model: 'x' }).action, 'allow', '无 purpose = 用户主动调用')
})

test('decide：白名单优先于黑名单', () => {
  const { cfg } = normalizeConfig({
    blockedProviders: ['*'],
    allowedModels: ['deepseek-ai/deepseek-v4.1-flash'],
  })
  assert.equal(decide(cfg, { provider: 'any', model: 'deepseek-ai/deepseek-v4.1-flash' }).action, 'allow')
  assert.equal(decide(cfg, { provider: 'any', model: 'other' }).action, 'block')
})

test('decide：规则内多条件是「与」', () => {
  const { cfg } = normalizeConfig({
    rules: [{ provider: 'nvida', model: 'deepseek-ai/*', action: 'block' }],
  })
  assert.equal(decide(cfg, { provider: 'nvida', model: 'deepseek-ai/x' }).action, 'block')
  assert.equal(decide(cfg, { provider: 'nvida', model: 'other/x' }).action, 'allow', '模型不符则不命中')
  assert.equal(decide(cfg, { provider: 'other', model: 'deepseek-ai/x' }).action, 'allow', '渠道不符则不命中')
})

test('decide：allowPurposeless 只匹配用户主动调用', () => {
  const { cfg } = normalizeConfig({
    rules: [{ model: 'expensive-*', allowPurposeless: true, action: 'block' }],
  })
  assert.equal(decide(cfg, { provider: 'p', model: 'expensive-1' }).action, 'block')
  assert.equal(decide(cfg, { provider: 'p', model: 'expensive-1', purpose: 'compaction' }).action, 'allow')
})

test('decide：redirect 与 warn 动作', () => {
  const { cfg } = normalizeConfig({ mode: 'redirect', blockedProviders: ['nvida'] })
  assert.equal(decide(cfg, { provider: 'nvida', model: 'x' }).action, 'redirect')
  const warnCfg = normalizeConfig({ mode: 'warn', blockedProviders: ['nvida'] }).cfg
  assert.equal(decide(warnCfg, { provider: 'nvida', model: 'x' }).action, 'warn')
})

test('buildBlockedFinish：产出合规的终止 error 分片', () => {
  const { cfg } = normalizeConfig({ blockedProviders: ['nvida'] })
  const chunk = buildBlockedFinish(cfg, { provider: 'nvida', model: 'x' }, { source: 'config.blockedProviders' })
  assert.equal(chunk.type, 'finish')
  assert.equal(chunk.reason.kind, 'error')
  assert.equal(chunk.reason.failure.code, 'POLICY_BLOCKED')
  assert.ok(chunk.reason.failure.message.includes('nvida'))
  assert.ok(Object.isFrozen(chunk.reason.failure))
})
