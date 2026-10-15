/**
 * dsh-model-guard · 核心拦截器与装配
 *
 * 挂在 \`llm/stream\` waterfall 上——DSH 中**每一次**模型调用的必经之路
 * （主对话、子 agent、上下文压缩、会话标题生成、其它插件的手工调用）。
 *
 * 契约（已对 cordis 源码核实）：
 *   ctx.waterfall(llmService, 'llm/stream', options, next)
 *   -> 首个对象参数被 dispatch 取作 thisArg，不出现在监听器参数里
 *   -> 监听器被调用为 listener(options, next)，必须**同步**返回 AsyncIterable<StreamChunk>
 *   -> 不调用 next() 即否决下游
 *
 * 本模块承载：实时配置解析（热重载）、按预设/会话分流、服务商熔断、
 * 审计日志、权重软调度、插件冲突检测。
 */
import { appendFileSync } from 'node:fs'
import { decide, buildBlockedFinish, normalizeConfig, DEFAULT_AUTO_PURPOSES } from './matcher.js'

export const LOG_PREFIX = '[model-guard]'
/** 被名单拦截时使用的失败码：不在 dsh-llm-retry 的默认可重试集合内。 */
export const BLOCKED_CODE = 'POLICY_BLOCKED'
/** 熔断期间使用的失败码。 */
export const BREAKER_CODE = 'PROVIDER_CIRCUIT_OPEN'
/** 可能与本插件职责重叠的包名关键词。 */
const RIVAL_HINTS = ['model-gate', 'modelguard', 'model-guard', 'llm-guard', 'model-policy', 'llm-policy', 'model-router', 'llm-router']

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

/** 人类可读的运行统计。 */
export function summarize(stats) {
  if (!stats) return ''
  const lines = [
    '总调用 ' + stats.seen + '：放行 ' + stats.allowed + ' / 拦截 ' + stats.blocked
      + ' / 改道 ' + stats.redirected + ' / 告警 ' + stats.warned
      + (stats.softRouted > 0 ? ' / 软调度 ' + stats.softRouted : '')
      + (stats.breakerBlocked > 0 ? ' / 熔断 ' + stats.breakerBlocked : ''),
  ]
  const entries = [...stats.byTarget.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
  for (const [key, count] of entries) lines.push('  ' + key + ' x' + count)
  return lines.join('\n')
}

function describeCall(options) {
  const purpose = typeof options?.purpose === 'string' && options.purpose.length > 0 ? options.purpose : '(user)'
  return 'provider=' + (options?.provider ?? '?') + ' model=' + (options?.model ?? '?') + ' purpose=' + purpose
}

function snapshot(options, extra) {
  return Object.assign({
    provider: options?.provider ?? '',
    model: options?.model ?? '',
    purpose: typeof options?.purpose === 'string' ? options.purpose : '',
    sessionId: typeof options?.sessionId === 'string' ? options.sessionId : '',
  }, extra ?? {})
}

/* ------------------------------------------------------------------ *
 * 熔断器：连续失败 -> 临时拦截 -> 冷却后自动恢复
 * 冷却判定基于时间戳，因此不需要任何定时器。
 * ------------------------------------------------------------------ */
export function createBreaker() {
  const state = new Map()
  return {
    state,
    isOpen(provider, now = Date.now()) {
      const entry = state.get(provider)
      if (!entry || entry.openedUntil === 0) return false
      if (now < entry.openedUntil) return true
      state.delete(provider)
      return false
    },
    record(provider, failure, cfg, now = Date.now()) {
      if (!provider) return null
      if (failure === null || failure === undefined) {
        state.delete(provider)
        return null
      }
      const codes = cfg?.breaker?.codes ?? []
      if (!codes.includes(failure.code)) return null
      const entry = state.get(provider) ?? { failures: 0, openedUntil: 0, lastCode: '' }
      entry.failures += 1
      entry.lastCode = failure.code
      let opened = null
      if (cfg?.breaker?.enabled === true && entry.failures >= cfg.breaker.failureThreshold) {
        entry.openedUntil = now + cfg.breaker.cooldownMs
        entry.failures = 0
        opened = { until: entry.openedUntil, code: failure.code }
      }
      state.set(provider, entry)
      return opened
    },
    snapshot(now = Date.now()) {
      const out = []
      for (const [provider, entry] of state) {
        if (entry.openedUntil > now) out.push({ provider, until: entry.openedUntil, lastCode: entry.lastCode })
      }
      return out
    },
  }
}

/**
 * 构造 waterfall 监听器与运行状态。
 * @param ctx - 宿主上下文（redirect 需要 ctx.llm.stream；审计/预设需要 ctx.sessions）
 * @param rawConfig - **原始**配置对象（可能是 volatile 取值器）。每次判定实时解包 => 热重载。
 * @param hooks - { log, onEvent } 可选回调
 */
export function createGuard(ctx, rawConfig, hooks = {}) {
  const stats = { seen: 0, allowed: 0, blocked: 0, redirected: 0, warned: 0, softRouted: 0, breakerBlocked: 0, byTarget: new Map() }
  const forwarded = new WeakSet()
  const breaker = createBreaker()
  const auditLog = []
  let conflictChecked = false

  const resolveCfg = () => normalizeConfig(rawConfig)
  let bootCfg = resolveCfg().cfg

  const emit = (message) => {
    try {
      if (typeof hooks.log === 'function') hooks.log(message)
      else console.warn(LOG_PREFIX, message)
    } catch {
      /* 日志失败绝不影响模型调用 */
    }
  }
  const log = (message) => {
    if (bootCfg?.log === false) return
    emit(message)
  }

  /** 取会话对象与 agent 预设，供按会话/预设分流使用。 */
  const resolveSession = (options) => {
    const sessionId = typeof options?.sessionId === 'string' ? options.sessionId : ''
    if (sessionId.length === 0) return { session: null, preset: '' }
    try {
      const session = ctx?.sessions?.get?.(sessionId) ?? null
      const preset = session?.header?.agentPreset
      return { session, preset: typeof preset === 'string' ? preset : '' }
    } catch {
      return { session: null, preset: '' }
    }
  }

  /** 审计：内存环形缓冲 + 会话日志 + 可选 JSONL 文件。 */
  const record = (entry) => {
    try {
      const cfg = bootCfg
      if (cfg?.audit?.enabled !== false) {
        auditLog.push(entry)
        const max = cfg?.audit?.maxEntries ?? 200
        while (auditLog.length > max) auditLog.shift()
        if (cfg?.audit?.toSession === true && entry.session) {
          try {
            entry.session.append?.('model-guard/blocked', {
              action: entry.action,
              provider: entry.provider,
              model: entry.model,
              purpose: entry.purpose,
              rule: entry.rule,
              detail: entry.detail ?? '',
              at: entry.at,
            })
          } catch {
            /* 会话不支持该事件类型时忽略 */
          }
        }
        if (typeof cfg?.audit?.file === 'string' && cfg.audit.file.length > 0) {
          try {
            const plain = Object.assign({}, entry)
            delete plain.session
            appendFileSync(cfg.audit.file, JSON.stringify(plain) + '\n', 'utf8')
          } catch {
            /* 文件不可写时忽略 */
          }
        }
      }
      if (typeof hooks.onEvent === 'function') hooks.onEvent(entry)
    } catch {
      /* 审计失败不影响调用 */
    }
  }

  /** 冲突检测：同一 waterfall 上是否还有别的守卫类插件。 */
  const checkConflicts = () => {
    if (conflictChecked || bootCfg?.conflictCheck === false) return
    conflictChecked = true
    try {
      const hooksList = ctx?.events?._hooks?.['llm/stream']
      if (!Array.isArray(hooksList)) return
      const names = new Set()
      for (const hook of hooksList) {
        const pluginName = hook?.ctx?.plugin?.name ?? hook?.ctx?.fiber?.name ?? hook?.ctx?.name ?? ''
        const display = typeof pluginName === 'string' && pluginName.length > 0 ? pluginName : '(未命名插件)'
        if (display === 'model-guard') continue
        names.add(display)
      }
      const rivals = [...names].filter((n) => RIVAL_HINTS.some((h) => n.toLowerCase().includes(h)))
      if (rivals.length > 0) {
        log('检测到可能职责重叠的插件同时挂在 llm/stream 上：' + rivals.join(', ')
          + '。两者同时启用可能造成重复拦截或互相看不到对方的改道，建议只保留一个。')
      } else if (names.size > 0) {
        log('llm/stream 上还有 ' + names.size + ' 个其它监听者：' + [...names].join(', ') + '（未发现明确冲突）。')
      }
    } catch {
      /* 宿主内部结构变化时静默跳过 */
    }
  }

  const bump = (options, field) => {
    stats[field] += 1
    const purpose = typeof options?.purpose === 'string' && options.purpose.length > 0 ? options.purpose : 'user'
    const key = (options?.provider ?? '?') + '/' + (options?.model ?? '?') + '#' + purpose
    stats.byTarget.set(key, (stats.byTarget.get(key) ?? 0) + 1)
  }

  /** 包装下游流以观察结果，用于熔断计数。 */
  const observe = (stream, provider) => {
    if (bootCfg?.breaker?.enabled !== true) return stream
    return (async function* observed() {
      let failure = null
      try {
        for await (const chunk of stream) {
          if (chunk && chunk.type === 'finish' && chunk.reason) {
            failure = chunk.reason.kind === 'error' ? (chunk.reason.failure ?? { code: 'UNKNOWN', message: '' }) : null
          }
          yield chunk
        }
      } finally {
        try {
          const cfg = resolveCfg().cfg
          const opened = breaker.record(provider, failure, cfg)
          if (opened !== null) {
            log('熔断开启：provider=' + provider + ' 连续失败达到 ' + cfg.breaker.failureThreshold
              + ' 次（最后 code=' + opened.code + '），暂停 ' + Math.round(cfg.breaker.cooldownMs / 1000) + ' 秒后自动恢复')
          }
        } catch {
          /* 观察失败不影响流 */
        }
      }
    })()
  }

  /** 真正的 llm/stream 监听器：必须同步返回 AsyncIterable。 */
  const listener = (options, next) => {
    stats.seen += 1
    checkConflicts()

    if (forwarded.has(options)) {
      stats.allowed += 1
      return next()
    }

    // 热重载：每次调用重新读取配置，设置界面一保存立即生效，无需重启 DSH。
    let cfg
    try {
      cfg = resolveCfg().cfg
      bootCfg = cfg
    } catch (error) {
      log('配置解析失败，本次放行：' + (error?.message ?? error))
      stats.allowed += 1
      return next()
    }

    if (cfg.enabled !== true) {
      stats.allowed += 1
      return next()
    }

    const { session, preset } = resolveSession(options)
    const provider = typeof options?.provider === 'string' ? options.provider : ''
    const breakerOpen = breaker.isOpen(provider)
    const decision = decide(cfg, options, { preset, breakerOpen })

    if (decision.action === 'allow') {
      stats.allowed += 1
      return observe(next(), provider)
    }

    if (decision.action === 'warn') {
      bump(options, 'warned')
      log('告警（放行）' + describeCall(options) + ' preset=' + (preset || '-') + ' rule=' + (decision.rule?.source ?? '-'))
      record(snapshot(options, { at: new Date().toISOString(), action: 'warn', preset, rule: decision.rule?.source ?? '', session }))
      return observe(next(), provider)
    }

    if (decision.action === 'redirect') {
      const route = decision.rule?.route
      const fromRule = decision.rule?.fallback ?? {}
      const global = cfg.fallback ?? {}
      const targetProvider = route?.provider || fromRule.provider || global.provider || ''
      const targetModel = route?.model || fromRule.model || global.model || ''
      if ((targetProvider || targetModel) && typeof ctx?.llm?.stream === 'function') {
        const target = { ...options, provider: targetProvider || options.provider, model: targetModel || options.model }
        forwarded.add(target)
        bump(options, decision.reason === 'soft-route' ? 'softRouted' : 'redirected')
        log('改道 ' + describeCall(options) + ' -> provider=' + target.provider + ' model=' + target.model
          + ' rule=' + (decision.rule?.source ?? '-') + (route?.note ? ' (' + route.note + ')' : ''))
        record(snapshot(options, {
          at: new Date().toISOString(), action: 'redirect', preset,
          rule: decision.rule?.source ?? '', session,
          detail: 'to ' + target.provider + '/' + target.model,
        }))
        return observe(ctx.llm.stream(target), targetProvider || provider)
      }
      log('改道失败（未配置 fallback 目标）→ 改为拦截 ' + describeCall(options))
    }

    const isBreaker = decision.rule?.breaker === true
    if (isBreaker) bump(options, 'breakerBlocked')
    else if (decision.reason === 'soft-route') bump(options, 'softRouted')
    else bump(options, 'blocked')

    log((isBreaker ? '熔断拦截 ' : '已拦截 ') + describeCall(options) + ' preset=' + (preset || '-')
      + ' rule=' + (decision.rule?.source ?? '-'))
    record(snapshot(options, {
      at: new Date().toISOString(), action: isBreaker ? 'breaker' : 'block',
      preset, rule: decision.rule?.source ?? '', session,
    }))

    if (options?.signal?.aborted === true) {
      return terminalStream({
        type: 'finish',
        reason: { kind: 'aborted', failure: Object.freeze({ message: '调用在拦截前已被取消', code: 'ABORTED' }) },
      })
    }
    return terminalStream(buildBlockedFinish(cfg, options, decision.rule))
  }

  return {
    listener, stats, breaker, auditLog, describeCall,
    /** 供测试与诊断：当前实时解析出的配置。 */
    currentConfig: () => resolveCfg().cfg,
  }
}

/**
 * 装配插件：注册 llm/stream 监听器。
 * 配置保持**原始引用**，每次判定实时解包，因此支持热重载。
 * @returns {null | { cfg, guard, dispose }}
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

  const initial = normalizeConfig(rawConfig)
  for (const warning of initial.warnings) emit('配置提醒：' + warning)

  if (initial.cfg.enabled !== true) {
    emit('插件已加载但处于禁用状态（enabled: false），不会拦截任何调用。')
    return null
  }
  if (typeof ctx?.on !== 'function') {
    emit('宿主未提供事件系统（ctx.on 缺失），插件无法注册拦截器。')
    return null
  }

  const guard = createGuard(ctx, rawConfig, hooks)
  const off = ctx.on('llm/stream', guard.listener, { prepend: true })
  const cfg = initial.cfg

  const lines = ['已启用：policy=' + cfg.policy + ' mode=' + cfg.mode + ' scope=' + cfg.scope
    + '，共 ' + cfg.rules.length + ' 条规则'
    + (cfg.scopes.length > 0 ? '、' + cfg.scopes.length + ' 条预设/会话作用域' : '')
    + (cfg.softRules.length > 0 ? '、' + cfg.softRules.length + ' 条软调度' : '')]
  if (cfg.breaker.enabled) {
    lines.push('熔断：连续 ' + cfg.breaker.failureThreshold + ' 次失败后暂停 ' + Math.round(cfg.breaker.cooldownMs / 1000) + ' 秒')
  }
  if (cfg.audit.enabled) {
    lines.push('审计：' + (cfg.audit.toSession ? '写入会话日志' : '仅内存') + (cfg.audit.file ? '，文件 ' + cfg.audit.file : ''))
  }
  for (const rule of cfg.rules) {
    const parts = []
    if (rule.provider) parts.push('provider=' + rule.provider.join('|'))
    if (rule.model) parts.push('model=' + rule.model.join('|'))
    if (rule.purpose) parts.push('purpose=' + rule.purpose.map((p) => (p === '' ? '(user)' : p)).join('|'))
    lines.push('  - [' + rule.action + '/' + rule.scope + '] ' + parts.join(' ') + (rule.note ? ' // ' + rule.note : ''))
  }
  for (const scope of cfg.scopes) {
    const parts = []
    if (scope.match.preset) parts.push('preset=' + scope.match.preset.join('|'))
    if (scope.match.session) parts.push('session=' + scope.match.session.join('|'))
    if (scope.match.provider) parts.push('provider=' + scope.match.provider.join('|'))
    if (scope.match.model) parts.push('model=' + scope.match.model.join('|'))
    lines.push('  - [作用域 ' + scope.source + '] ' + parts.join(' ') + ' -> policy=' + scope.policy
      + ' 黑名单模型=' + scope.blockedModels.length + ' 白名单模型=' + scope.allowedModels.length)
  }
  for (const soft of cfg.softRules) {
    lines.push('  - [软调度 ' + soft.source + '] ' + soft.routes.map((r) => r.action + ':' + r.weight).join(' / '))
  }
  emit(lines.join('\n'))

  const dispose = () => {
    try {
      if (typeof off === 'function') off()
    } catch {
      /* 忽略 */
    }
    emit('已卸载。本次运行统计：\n' + summarize(guard.stats))
  }
  try {
    if (typeof ctx.on === 'function') ctx.on('dispose', dispose)
  } catch {
    /* 宿主不支持 dispose 事件时忽略 */
  }

  return { cfg, guard, dispose }
}

export { DEFAULT_AUTO_PURPOSES }
