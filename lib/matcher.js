/**
 * dsh-model-guard · 规则匹配引擎（纯逻辑，无副作用、可单元测试）
 *
 * 职责：把用户配置归一化为规则表，并对一次模型调用（GenerateOptions）判定
 * 应当「放行 / 拦截 / 改道 / 仅告警」，以及选择权重软调度的目标。
 */

/** 拦截动作。 */
export const ACTIONS = Object.freeze(['allow', 'block', 'redirect', 'warn'])
/** 作用域：all = 所有调用；auto = 仅自动调用（带 purpose 的后台调用）。 */
export const SCOPES = Object.freeze(['all', 'auto'])
/** 名单策略：blocklist = 拉黑列表内的；allowlist = 只放行列表内的（其余全拦）。 */
export const POLICIES = Object.freeze(['blocklist', 'allowlist'])
/** 框中「自动调用」的默认 purpose 集合：上下文压缩 + 会话标题生成。 */
export const DEFAULT_AUTO_PURPOSES = Object.freeze(['compaction', 'session-title'])
/** 默认计入熔断的失败码（提供方侧故障，不含我们自己产生的 POLICY_BLOCKED）。 */
export const DEFAULT_BREAKER_CODES = Object.freeze(['SERVER', 'TRANSPORT', 'TIMEOUT', 'RATE_LIMIT'])

/** 把 glob 模式编译为正则；`*` 匹配任意字符（含空），`?` 匹配单个字符。 */
export function globToRegExp(pattern) {
  const source = String(pattern)
  let out = '^'
  for (const ch of source) {
    if (ch === '*') out += '[\\s\\S]*'
    else if (ch === '?') out += '[\\s\\S]'
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(out + '$')
}

/** 大小写不敏感的 glob 匹配。空模式永不匹配。 */
export function globMatch(pattern, value) {
  if (typeof pattern !== 'string' || pattern.length === 0) return false
  if (typeof value !== 'string' || value.length === 0) return false
  return globToRegExp(pattern.toLowerCase()).test(value.toLowerCase())
}

/** 模式列表任一命中即真；接受单个字符串或字符串数组。 */
export function matchesAny(patterns, value) {
  const list = toArray(patterns)
  if (list.length === 0) return false
  return list.some((p) => globMatch(p, value))
}

function toArray(value) {
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string' && v.length > 0)
  if (typeof value === 'string') return value.length > 0 ? [value] : []
  return []
}

/**
 * 与 toArray 类似，但**保留空字符串**。
 * purpose 维度上空字符串有语义：「没有 purpose」= 用户主动发起的调用。
 */
function toPatternArray(value) {
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string')
  return typeof value === 'string' ? [value] : []
}

function normalizeAction(value, fallback) {
  return ACTIONS.includes(value) ? value : fallback
}

function normalizeScope(value, fallback) {
  return SCOPES.includes(value) ? value : fallback
}

function normalizePolicy(value, fallback) {
  return POLICIES.includes(value) ? value : fallback
}

function asPositiveInt(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/**
 * 解包 DSH / Cordis 的 volatile 配置取值器。
 *
 * schema 里声明为 `.volatile()` 的字段（也就是能在设置界面里编辑的那些），
 * 到达插件时不是裸值，而是 `{ get: () => 实际值 }` 形式的惰性取值器。
 * 不解包就会把取值器当成配置值——表现为「界面上改了、保存也成功，但 host 侧不生效」。
 * 每次判定都重新解包，配置改动因此无需重启即可生效（热重载）。
 */
export function unwrapVolatile(value) {
  let current = value
  let depth = 0
  while (current !== null && typeof current === 'object' && typeof current.get === 'function' && depth < 16) {
    try {
      current = current.get()
    } catch {
      return undefined
    }
    depth += 1
  }
  return current
}

/** 对配置对象的每个顶层字段解包一次 volatile 取值器。 */
export function unwrapConfig(raw) {
  const source = unwrapVolatile(raw)
  if (source === null || typeof source !== 'object') return {}
  const out = {}
  for (const key of Object.keys(source)) out[key] = unwrapVolatile(source[key])
  return out
}

/** 判断一次调用是否属于「自动调用」（后台辅助调用，非用户直接发起）。 */
export function isAutomaticCall(options, autoPurposes) {
  const purpose = typeof options?.purpose === 'string' ? options.purpose : ''
  const list = toArray(autoPurposes).length > 0 ? toArray(autoPurposes) : [...DEFAULT_AUTO_PURPOSES]
  return list.some((p) => globMatch(p, purpose))
}

/** 归一化一条匹配条件（provider / model / purpose / preset / session）。 */
export function normalizeMatch(raw) {
  if (!raw || typeof raw !== 'object') return null
  const match = {}
  for (const key of ['provider', 'model']) {
    const values = toArray(raw[key])
    if (values.length > 0) match[key] = values
  }
  const purposes = toPatternArray(raw.purpose)
  if (purposes.length > 0) match.purpose = purposes
  for (const key of ['preset', 'session']) {
    const values = toArray(raw[key])
    if (values.length > 0) match[key] = values
  }
  return Object.keys(match).length > 0 ? match : null
}

function normalizeRuleList(raw, warnings, sourceLabel) {
  const rules = []
  if (!Array.isArray(raw)) return rules
  for (let index = 0; index < raw.length; index += 1) {
    const rule = raw[index]
    if (!rule || typeof rule !== 'object') {
      warnings.push(sourceLabel + '[' + index + '] 不是对象，已忽略')
      continue
    }
    const normalized = {
      source: sourceLabel + '[' + index + ']',
      action: normalizeAction(rule.action, 'block'),
      scope: normalizeScope(rule.scope, 'all'),
      note: typeof rule.note === 'string' ? rule.note : '',
    }
    for (const key of ['provider', 'model', 'purpose']) {
      const values = key === 'purpose' ? toPatternArray(rule[key]) : toArray(rule[key])
      if (values.length > 0) normalized[key] = values
    }
    if (rule.allowPurposeless === true) normalized.purpose = ['']
    if (rule.fallback && typeof rule.fallback === 'object') {
      normalized.fallback = {
        provider: typeof rule.fallback.provider === 'string' ? rule.fallback.provider : '',
        model: typeof rule.fallback.model === 'string' ? rule.fallback.model : '',
      }
    }
    if (!normalized.provider && !normalized.model && !normalized.purpose) {
      warnings.push(sourceLabel + '[' + index + '] 没有任何匹配条件（provider/model/purpose），已忽略')
      continue
    }
    rules.push(normalized)
  }
  return rules
}

/** 归一化「权重软调度」规则。 */
function normalizeSoftRules(raw, warnings) {
  const softRules = []
  if (raw === undefined || raw === null) return softRules
  if (!Array.isArray(raw)) {
    warnings.push('softRules 必须是数组，已忽略')
    return softRules
  }
  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      warnings.push('softRules[' + index + '] 不是对象，已忽略')
      return
    }
    const match = normalizeMatch(entry.match ?? entry)
    if (match === null) {
      warnings.push('softRules[' + index + '] 缺少 match 条件，已忽略')
      return
    }
    const routes = []
    for (const route of Array.isArray(entry.routes) ? entry.routes : []) {
      if (!route || typeof route !== 'object') continue
      const weight = Number(route.weight)
      routes.push({
        action: normalizeAction(route.action, 'allow'),
        weight: Number.isFinite(weight) && weight > 0 ? weight : 1,
        provider: typeof route.provider === 'string' ? route.provider : '',
        model: typeof route.model === 'string' ? route.model : '',
        note: typeof route.note === 'string' ? route.note : '',
      })
    }
    if (routes.length === 0) {
      warnings.push('softRules[' + index + '] 没有有效 routes，已忽略')
      return
    }
    softRules.push({ source: 'softRules[' + index + ']', match, routes, note: typeof entry.note === 'string' ? entry.note : '' })
  })
  return softRules
}

/** 归一化「按预设/会话」的作用域覆盖。 */
function normalizeScopes(raw, defaults, warnings) {
  const scopes = []
  if (raw === undefined || raw === null) return scopes
  if (!Array.isArray(raw)) {
    warnings.push('scopes 必须是数组，已忽略')
    return scopes
  }
  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      warnings.push('scopes[' + index + '] 不是对象，已忽略')
      return
    }
    const match = normalizeMatch(entry.match ?? entry)
    if (match === null) {
      warnings.push('scopes[' + index + '] 缺少 match 条件（preset / session / provider / model），已忽略')
      return
    }
    const normalized = {
      source: 'scopes[' + index + ']',
      match,
      policy: normalizePolicy(entry.policy, defaults.policy),
      mode: normalizeAction(entry.mode, defaults.mode),
      scope: normalizeScope(entry.scope, defaults.scope),
      blockedProviders: toArray(entry.blockedProviders),
      blockedModels: toArray(entry.blockedModels),
      allowedProviders: toArray(entry.allowedProviders),
      allowedModels: toArray(entry.allowedModels),
      rules: normalizeRuleList(entry.rules, warnings, 'scopes[' + index + '].rules'),
      note: typeof entry.note === 'string' ? entry.note : '',
    }
    const hasEffect = normalized.policy === 'allowlist'
      || normalized.rules.length > 0
      || normalized.blockedProviders.length > 0
      || normalized.blockedModels.length > 0
      || toArray(entry.blockedPurposes).length > 0
      || normalized.allowedProviders.length > 0
      || normalized.allowedModels.length > 0
    if (!hasEffect) {
      warnings.push('scopes[' + index + '] 没有任何名单内容，已忽略')
      return
    }
    // blockedPurposes 以隐含规则形式并入 rules
    for (const purpose of toArray(entry.blockedPurposes)) {
      normalized.rules.push({ source: 'scopes[' + index + '].blockedPurposes', purpose: [purpose], action: normalized.mode, scope: 'all' })
    }
    scopes.push(normalized)
  })
  return scopes
}

/**
 * 归一化用户配置。每次判定都会调用它，因此配置改动即时生效（热重载）。
 * @returns {{ cfg: object, warnings: string[] }}
 */
export function normalizeConfig(raw) {
  const input = unwrapConfig(raw)
  const warnings = []

  const enabled = input.enabled === undefined ? true : Boolean(input.enabled)
  const mode = normalizeAction(input.mode, 'block')
  const policy = normalizePolicy(input.policy, 'blocklist')
  const defaultScope = normalizeScope(input.scope, 'all')
  const autoPurposes = toArray(input.autoPurposes).length > 0 ? toArray(input.autoPurposes) : [...DEFAULT_AUTO_PURPOSES]
  const log = input.log === undefined ? true : Boolean(input.log)
  const blockMessage = typeof input.blockMessage === 'string' && input.blockMessage.length > 0
    ? input.blockMessage
    : '已被 dsh-model-guard 拦截：该 API/模型处于禁止自动调用名单中。'

  if (input.mode !== undefined && !ACTIONS.includes(input.mode)) {
    warnings.push('mode "' + input.mode + '" 不是合法动作，已回退为 "' + mode + '"')
  }
  if (input.scope !== undefined && !SCOPES.includes(input.scope)) {
    warnings.push('scope "' + input.scope + '" 不是合法作用域，已回退为 "' + defaultScope + '"')
  }
  if (input.policy !== undefined && !POLICIES.includes(input.policy)) {
    warnings.push('policy "' + input.policy + '" 不是合法策略，已回退为 "' + policy + '"')
  }

  const blockedProviders = toArray(input.blockedProviders)
  const blockedModels = toArray(input.blockedModels)
  const allowedProviders = toArray(input.allowedProviders)
  const allowedModels = toArray(input.allowedModels)

  const rules = []
  for (const [field, key] of [['blockedProviders', 'provider'], ['blockedModels', 'model'], ['blockedPurposes', 'purpose']]) {
    const values = toArray(input[field])
    if (values.length > 0) rules.push({ source: 'config.' + field, [key]: values, action: mode, scope: defaultScope })
  }
  rules.push(...normalizeRuleList(input.rules, warnings, 'rules'))

  const softRules = normalizeSoftRules(input.softRules, warnings)
  const scopes = normalizeScopes(input.scopes, { policy, mode, scope: defaultScope }, warnings)

  const breakerInput = input.breaker && typeof input.breaker === 'object' ? input.breaker : {}
  const breaker = {
    enabled: breakerInput.enabled === undefined ? false : Boolean(breakerInput.enabled),
    failureThreshold: asPositiveInt(breakerInput.failureThreshold, 3),
    cooldownMs: asPositiveInt(breakerInput.cooldownMs, 60000),
    codes: toArray(breakerInput.codes).length > 0 ? toArray(breakerInput.codes) : [...DEFAULT_BREAKER_CODES],
    message: typeof breakerInput.message === 'string' && breakerInput.message.length > 0
      ? breakerInput.message
      : '已被 dsh-model-guard 熔断：该服务商连续报错，临时停止调用，冷却后自动恢复。',
  }

  const auditInput = input.audit && typeof input.audit === 'object' ? input.audit : {}
  const audit = {
    enabled: auditInput.enabled === undefined ? true : Boolean(auditInput.enabled),
    toSession: auditInput.toSession === undefined ? true : Boolean(auditInput.toSession),
    file: typeof auditInput.file === 'string' ? auditInput.file : '',
    maxEntries: asPositiveInt(auditInput.maxEntries, 200),
  }

  const conflictCheck = input.conflictCheck === undefined ? true : Boolean(input.conflictCheck)

  if (rules.length === 0 && scopes.length === 0 && softRules.length === 0 && policy === 'blocklist') {
    warnings.push('当前没有任何拦截规则：插件已加载但不会拦截任何调用')
  }

  const globalFallback = input.fallback && typeof input.fallback === 'object'
    ? {
        provider: typeof input.fallback.provider === 'string' ? input.fallback.provider : '',
        model: typeof input.fallback.model === 'string' ? input.fallback.model : '',
      }
    : { provider: '', model: '' }

  return {
    cfg: {
      enabled, mode, policy,
      scope: defaultScope,
      autoPurposes, rules, softRules, scopes,
      blockedProviders, blockedModels, allowedProviders, allowedModels,
      breaker, audit, conflictCheck,
      fallback: globalFallback,
      log, blockMessage,
    },
    warnings,
  }
}

function callFacts(options) {
  return {
    provider: typeof options?.provider === 'string' ? options.provider : '',
    model: typeof options?.model === 'string' ? options.model : '',
    purpose: typeof options?.purpose === 'string' ? options.purpose : '',
    sessionId: typeof options?.sessionId === 'string' ? options.sessionId : '',
  }
}

function matchPatterns(patterns, value, allowEmpty) {
  const list = Array.isArray(patterns) ? patterns.map(String) : [String(patterns)]
  const wantsEmpty = allowEmpty === true && list.includes('')
  const named = list.filter((p) => p !== '')
  const hit = (wantsEmpty && value === '') || (named.length > 0 && matchesAny(named, value))
  return hit
}

/** 单条规则是否匹配一次调用。规则内所有已声明字段之间是「与」，字段值数组内部是「或」。 */
export function ruleMatches(rule, options, autoPurposes) {
  const facts = callFacts(options)
  if (rule.provider && !matchesAny(rule.provider, facts.provider)) return false
  if (rule.model && !matchesAny(rule.model, facts.model)) return false
  if (rule.purpose && !matchPatterns(rule.purpose, facts.purpose, true)) return false
  if (rule.scope === 'auto' && !isAutomaticCall(options, autoPurposes)) return false
  return true
}

/** 一条作用域（scopes 条目）是否适用于本次调用。 */
export function scopeMatches(scope, options, context) {
  const facts = callFacts(options)
  const match = scope.match ?? {}
  if (match.provider && !matchesAny(match.provider, facts.provider)) return false
  if (match.model && !matchesAny(match.model, facts.model)) return false
  if (match.preset && !matchesAny(match.preset, context?.preset ?? '')) return false
  if (match.session && (!facts.sessionId || !matchesAny(match.session, facts.sessionId))) return false
  if (match.purpose && !matchPatterns(match.purpose, facts.purpose, true)) return false
  return true
}

/**
 * 选出本次调用适用的名单配置：第一个命中的 scopes 条目，否则用全局配置。
 * 这是「按 Agent 预设 / 会话独立配置」的落点。
 */
export function resolveProfile(cfg, options, context) {
  for (const scope of Array.isArray(cfg?.scopes) ? cfg.scopes : []) {
    if (!scopeMatches(scope, options, context)) continue
    return {
      source: scope.source, policy: scope.policy, mode: scope.mode, scope: scope.scope,
      rules: scope.rules,
      blockedProviders: scope.blockedProviders, blockedModels: scope.blockedModels,
      allowedProviders: scope.allowedProviders, allowedModels: scope.allowedModels,
      note: scope.note,
    }
  }
  return {
    source: 'config',
    policy: cfg?.policy === 'allowlist' ? 'allowlist' : 'blocklist',
    mode: cfg?.mode ?? 'block',
    scope: cfg?.scope ?? 'all',
    rules: Array.isArray(cfg?.rules) ? cfg.rules : [],
    blockedProviders: toArray(cfg?.blockedProviders),
    blockedModels: toArray(cfg?.blockedModels),
    allowedProviders: toArray(cfg?.allowedProviders),
    allowedModels: toArray(cfg?.allowedModels),
    note: '',
  }
}

/** 命中该 profile 的黑名单/规则；返回触发的来源或 null。 */
function hitRules(profile, options, autoPurposes) {
  if (profile.scope === 'auto' && !isAutomaticCall(options, autoPurposes)) {
    // auto 作用域下仍允许显式 action:allow 的规则命中
    for (const rule of profile.rules) {
      if (rule.scope !== 'auto' && rule.action === 'allow' && ruleMatches(rule, options, autoPurposes)) {
        return { allow: true, source: rule.source, fallback: rule.fallback }
      }
    }
    return null
  }
  const facts = callFacts(options)
  if (matchesAny(profile.blockedProviders, facts.provider)) return { source: profile.source + '.blockedProviders' }
  if (matchesAny(profile.blockedModels, facts.model)) return { source: profile.source + '.blockedModels' }
  for (const rule of profile.rules) {
    if (!ruleMatches(rule, options, autoPurposes)) continue
    const action = ACTIONS.includes(rule.action) ? rule.action : profile.mode
    if (action === 'allow') return { allow: true, source: rule.source, fallback: rule.fallback }
    return { source: rule.source, action, fallback: rule.fallback }
  }
  return null
}

/** 是否命中该 profile 的白名单。 */
function hitAllow(profile, options, autoPurposes) {
  const facts = callFacts(options)
  if (matchesAny(profile.allowedProviders, facts.provider)) return { source: profile.source + '.allowedProviders' }
  if (matchesAny(profile.allowedModels, facts.model)) return { source: profile.source + '.allowedModels' }
  for (const rule of profile.rules) {
    if (rule.action !== 'allow') continue
    if (ruleMatches(rule, options, autoPurposes)) return { source: rule.source }
  }
  return null
}

/**
 * 对一次调用作出判定。
 * @param cfg - normalizeConfig() 的产物
 * @param options - llm/stream 的 GenerateOptions
 * @param context - 可选 { preset, breakerOpen, random }
 */
export function decide(cfg, options, context = {}) {
  const profile = resolveProfile(cfg, options, context)
  const base = { rule: null, profile }

  if (!cfg || cfg.enabled !== true) return { ...base, action: 'allow', reason: 'disabled' }

  // 熔断优先于名单判断：服务商整体不可用时不必再发请求。
  if (context.breakerOpen === true) {
    return { ...base, action: 'block', rule: { source: 'breaker', breaker: true }, reason: 'breaker-open' }
  }

  const soft = pickSoftRoute(cfg, options, context)

  if (profile.policy === 'allowlist') {
    const allowed = hitAllow(profile, options, cfg.autoPurposes)
    if (allowed !== null) return { ...base, action: 'allow', rule: { source: allowed.source }, reason: 'allowlisted' }
    const hit = hitRules(profile, options, cfg.autoPurposes)
    if (hit !== null && hit.allow === true) return { ...base, action: 'allow', rule: { source: hit.source }, reason: 'rule-allow' }
    if (soft !== null) return { ...base, action: soft.route.action, rule: { source: soft.source, soft: true, route: soft.route }, reason: 'soft-route' }
    const source = profile.source === 'config' ? 'policy:allowlist' : profile.source + ':policy:allowlist'
    return { ...base, action: profile.mode, rule: { source }, reason: 'allowlist-miss' }
  }

  // 黑名单策略：白名单是黑名单的例外，优先级最高。
  const facts = callFacts(options)
  if (matchesAny(profile.allowedProviders, facts.provider) || matchesAny(profile.allowedModels, facts.model)) {
    return { ...base, action: 'allow', rule: null, reason: 'allowlisted' }
  }

  const hit = hitRules(profile, options, cfg.autoPurposes)
  if (hit !== null) {
    if (hit.allow === true) return { ...base, action: 'allow', rule: { source: hit.source }, reason: 'rule-allow' }
    const action = ACTIONS.includes(hit.action) ? hit.action : profile.mode
    return { ...base, action, rule: { source: hit.source, fallback: hit.fallback }, reason: 'matched ' + hit.source }
  }

  if (soft !== null) {
    return { ...base, action: soft.route.action, rule: { source: soft.source, soft: true, route: soft.route }, reason: 'soft-route' }
  }

  return { ...base, action: 'allow', rule: null, reason: 'no-match' }
}

/** 找出第一条命中的软调度规则，并按权重抽一条路线。 */
export function pickSoftRoute(cfg, options, context = {}) {
  for (const entry of Array.isArray(cfg?.softRules) ? cfg.softRules : []) {
    if (!softMatch(entry.match, options, context)) continue
    const route = pickWeighted(entry.routes, context.random ?? Math.random)
    if (route !== null) return { source: entry.source, route, note: entry.note }
  }
  return null
}

function softMatch(match, options, context) {
  const facts = callFacts(options)
  if (match.provider && !matchesAny(match.provider, facts.provider)) return false
  if (match.model && !matchesAny(match.model, facts.model)) return false
  if (match.preset && !matchesAny(match.preset, context?.preset ?? '')) return false
  if (match.session && (!facts.sessionId || !matchesAny(match.session, facts.sessionId))) return false
  if (match.purpose && !matchPatterns(match.purpose, facts.purpose, true)) return false
  return true
}

/** 按权重随机选一条路线。 */
export function pickWeighted(routes, random = Math.random) {
  if (!Array.isArray(routes) || routes.length === 0) return null
  const total = routes.reduce((sum, r) => sum + (Number.isFinite(r.weight) && r.weight > 0 ? r.weight : 0), 0)
  if (total <= 0) return routes[0] ?? null
  let roll = random() * total
  for (const route of routes) {
    const weight = Number.isFinite(route.weight) && route.weight > 0 ? route.weight : 0
    roll -= weight
    if (roll < 0) return route
  }
  return routes[routes.length - 1]
}

/** 构造终止 finish 分片（错误结局），用于短路一次被拦截的调用。 */
export function buildBlockedFinish(cfg, options, rule) {
  const isBreaker = rule?.breaker === true
  const fallbackMessage = isBreaker
    ? (cfg?.breaker?.message || '已被 dsh-model-guard 熔断。')
    : (cfg?.blockMessage || '已被 dsh-model-guard 拦截。')
  const message = fallbackMessage + ' [provider=' + (options?.provider ?? '?') + ' model=' + (options?.model ?? '?')
    + ' purpose=' + (options?.purpose ?? '(user)') + ' rule=' + (rule?.source ?? '-') + ']'
  return {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: Object.freeze({ message, code: isBreaker ? 'PROVIDER_CIRCUIT_OPEN' : 'POLICY_BLOCKED' }),
    },
  }
}
