/**
 * dsh-model-guard · 核心拦截器与装配
 *
 * 挂在 \`llm/stream\` waterfall 上。这是 DSH 中**每一次**模型调用的必经之路
 * （主对话、子 agent、上下文压缩、会话标题生成、其它插件的手工调用），
 * 因此在这里做名单判定可以做到零漏网。
 *
 * 契约（已对 cordis 源码核实，cordis/lib/index.js dispatch()）：
 *   ctx.waterfall(llmService, 'llm/stream', options, next)
 *   -> 首个对象参数被 dispatch 取作 thisArg 并 bind，不出现在监听器参数里
 *   -> 监听器被调用为 listener(options, next)
 *   -> 监听器必须**同步**返回 AsyncIterable<StreamChunk>（不能是 async 函数）
 *   -> 不调用 next() 即否决下游（内置适配器分发）
 */
import { decide, buildBlockedFinish, normalizeConfig } from './matcher.js'

export const LOG_PREFIX = '[model-guard]'

/** 被拦截调用的失败码：不在 dsh-llm-retry 的默认可重试集合内，因此不会被反复重试。 */
export const BLOCKED_CODE = 'POLICY_BLOCKED'

function describeCall(options) {
  const provider = options?.provider ?? '?'
  const model = options?.model ?? '?'
  const purpose = typeof options?.purpose === 'string' && options.purpose.length > 0 ? options.purpose : '(user)'
  return `provider=${provider} model=${model} purpose=${purpose}`
}

/** 产出单条终止 finish 分片的最小异步可迭代对象。 */
export function terminalStream(chunk) {
  return {
    [Symbol.asyncIterator]() {
      let done = false
      return {
        async next() {
          if (done) return { done: true, value: undefined }
          done = true
          return { done: false, value: chunk }
        },
        async return() {
          done = true
          return { done: true, value: undefined }
        },
      }
    },
  }
}

/** 人类可读的统计摘要（用于启动/卸载日志与排障）。 */
export function summarize(stats) {
  if (!stats) return ''
  const lines = [
    `总调用 ${stats.seen}：放行 ${stats.allowed} / 拦截 ${stats.blocked} / 改道 ${stats.redirected} / 告警 ${stats.warned}`,
  ]
  const entries = [...stats.byTarget.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
  for (const [key, count] of entries) lines.push(`  ${key} x${count}`)
  return lines.join('\n')
}

/**
 * 构造 waterfall 监听器与运行统计。
 * @param ctx - 宿主上下文（redirect 时需要 ctx.llm.stream）
 * @param cfg - normalizeConfig() 产出的已归一化配置
 * @param hooks - { log(message), onEvent(record) } 可选回调
 */
export function createGuard(ctx, cfg, hooks = {}) {
  const stats = { seen: 0, allowed: 0, blocked: 0, redirected: 0, warned: 0, byTarget: new Map() }
  /** 已改道过的请求对象，防止 fallback 再次命中同一规则造成无限递归。 */
  const forwarded = new WeakSet()

  const log = (message) => {
    if (cfg?.log === false) return
    try {
      if (typeof hooks.log === 'function') hooks.log(message)
      else console.warn(LOG_PREFIX, message)
    } catch {
      /* 日志失败绝不影响模型调用 */
    }
  }

  const record = (entry) => {
    try {
      if (typeof hooks.onEvent === 'function') hooks.onEvent(entry)
    } catch {
      /* 审计失败不影响调用 */
    }
  }

  const bump = (options, field) => {
    stats[field] += 1
    const purpose = typeof options?.purpose === 'string' && options.purpose.length > 0 ? options.purpose : 'user'
    const key = `${options?.provider ?? '?'}/${options?.model ?? '?'}#${purpose}`
    stats.byTarget.set(key, (stats.byTarget.get(key) ?? 0) + 1)
  }

  const resolveFallback = (rule) => {
    const fromRule = rule?.fallback ?? {}
    const global = cfg?.fallback ?? {}
    return {
      provider: fromRule.provider || global.provider || '',
      model: fromRule.model || global.model || '',
    }
  }

  /** 真正的 llm/stream 监听器：必须同步返回 AsyncIterable。 */
  const listener = (options, next) => {
    stats.seen += 1

    // 改道后的二次进入：直接放行，避免递归。
    if (forwarded.has(options)) {
      stats.allowed += 1
      return next()
    }

    const decision = decide(cfg, options)

    if (decision.action === 'allow') {
      stats.allowed += 1
      return next()
    }

    if (decision.action === 'warn') {
      bump(options, 'warned')
      log(`告警（放行）${describeCall(options)} rule=${decision.rule?.source ?? '-'}`)
      record({ at: new Date().toISOString(), action: 'warn', ...snapshot(options), rule: decision.rule?.source ?? '' })
      return next()
    }

    if (decision.action === 'redirect') {
      const fallback = resolveFallback(decision.rule)
      const canRedirect = Boolean(fallback.provider || fallback.model) && typeof ctx?.llm?.stream === 'function'
      if (canRedirect) {
        const target = {
          ...options,
          provider: fallback.provider || options.provider,
          model: fallback.model || options.model,
        }
        forwarded.add(target)
        bump(options, 'redirected')
        log(`改道 ${describeCall(options)} -> provider=${target.provider} model=${target.model} rule=${decision.rule?.source ?? '-'}`)
        record({
          at: new Date().toISOString(),
          action: 'redirect',
          ...snapshot(options),
          to: { provider: target.provider, model: target.model },
          rule: decision.rule?.source ?? '',
        })
        return ctx.llm.stream(target)
      }
      log(`改道失败（未配置 fallback）→ 改为拦截 ${describeCall(options)} rule=${decision.rule?.source ?? '-'}`)
    }

    // block（以及 redirect 缺少目标时的降级）
    bump(options, 'blocked')
    log(`已拦截 ${describeCall(options)} rule=${decision.rule?.source ?? '-'}`)
    record({ at: new Date().toISOString(), action: 'block', ...snapshot(options), rule: decision.rule?.source ?? '' })

    if (options?.signal?.aborted === true) {
      return terminalStream({
        type: 'finish',
        reason: {
          kind: 'aborted',
          failure: Object.freeze({ message: '调用在拦截前已被取消', code: 'ABORTED' }),
        },
      })
    }
    return terminalStream(buildBlockedFinish(cfg, options, decision.rule))
  }

  return { listener, stats, describeCall }
}

function snapshot(options) {
  return {
    provider: options?.provider ?? '',
    model: options?.model ?? '',
    purpose: typeof options?.purpose === 'string' ? options.purpose : '',
    sessionId: typeof options?.sessionId === 'string' ? options.sessionId : '',
  }
}

/**
 * 装配插件：归一化配置 → 注册 llm/stream 监听器。
 * 与 schemastery 解耦，便于在任意 Node 环境中单元测试。
 * @returns {null | { cfg, guard, dispose }} 插件被禁用时返回 null
 */
export function installGuard(ctx, rawConfig = {}, hooks = {}) {
  const emit = (message) => {
    try {
      if (typeof hooks.log === 'function') hooks.log(message)
      else console.warn(LOG_PREFIX, message)
    } catch {
      /* 忽略 */
    }
  }

  const { cfg, warnings } = normalizeConfig(rawConfig)
  for (const warning of warnings) emit(`配置提醒：${warning}`)

  if (!cfg.enabled) {
    emit('插件已加载但处于禁用状态（enabled: false），不会拦截任何调用。')
    return null
  }

  const guard = createGuard(ctx, cfg, hooks)

  if (typeof ctx?.on !== 'function') {
    emit('宿主未提供事件系统（ctx.on 缺失），插件无法注册拦截器。')
    return null
  }
  const off = ctx.on('llm/stream', guard.listener)

  const summary = cfg.rules
    .map((rule) => {
      const parts = []
      if (rule.provider) parts.push(`provider=${rule.provider.join('|')}`)
      if (rule.model) parts.push(`model=${rule.model.join('|')}`)
      if (rule.purpose) parts.push(`purpose=${rule.purpose.map((p) => (p === '' ? '(user)' : p)).join('|')}`)
      return `  - [${rule.action}/${rule.scope}] ${parts.join(' ')}${rule.note ? ' // ' + rule.note : ''}`
    })
    .join('\n')

  emit(`已启用：mode=${cfg.mode} scope=${cfg.scope}，共 ${cfg.rules.length} 条规则`)
  if (summary) emit(`规则清单：\n${summary}`)

  const dispose = () => {
    try {
      if (typeof off === 'function') off()
    } catch {
      /* 忽略 */
    }
    emit(`已卸载。本次运行统计：\n${summarize(guard.stats)}`)
  }

  try {
    if (typeof ctx.on === 'function') ctx.on('dispose', dispose)
  } catch {
    /* 宿主不支持 dispose 事件时忽略 */
  }

  return { cfg, guard, dispose }
}
