/**
 * dsh-model-guard · 规则匹配引擎（纯逻辑，无副作用、可单元测试）
 *
 * 职责：把用户配置归一化为规则表，并对一次模型调用（GenerateOptions）
 * 判定应当「放行 / 拦截 / 改道 / 仅告警」。
 */

/** 拦截动作。 */
export const ACTIONS = Object.freeze(['allow', 'block', 'redirect', 'warn'])
/** 作用域：all = 所有调用；auto = 仅自动调用（带 purpose 的后台调用）。 */
export const SCOPES = Object.freeze(['all', 'auto'])
/** 框中「自动调用」的默认 purpose 集合：上下文压缩 + 会话标题生成。 */
export const DEFAULT_AUTO_PURPOSES = Object.freeze(['compaction', 'session-title'])

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

/**
 * 解包 DSH / Cordis 的 volatile 配置取值器。
 *
 * schema 里声明为 `.volatile()` 的字段（也就是能在设置界面里编辑的那些），
 * 到达插件时不是裸值，而是 `{ get: () => 实际值 }` 形式的惰性取值器。
 * 不解包就会把取值器当成配置值——表现为「界面上改了、保存也成功，但 host 侧不生效」。
 * 这里递归解包，兼容嵌套取值器。
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

/** 判断一次调用是否属于「自动调用」（后台辅助调用，非用户直接发起）。 */
export function isAutomaticCall(options, autoPurposes) {
  const purpose = typeof options?.purpose === 'string' ? options.purpose : ''
  const list = toArray(autoPurposes).length > 0 ? toArray(autoPurposes) : [...DEFAULT_AUTO_PURPOSES]
  return list.some((p) => globMatch(p, purpose))
}

/**
 * 归一化用户配置。
 * @returns {{ cfg: object, warnings: string[] }}
 */
export function normalizeConfig(raw) {
  // 关键：先解包 volatile 取值器，否则设置界面写入的值会被当成非法值而回退默认。
  const input = unwrapConfig(raw)
  const warnings = []

  const enabled = input.enabled === undefined ? true : Boolean(input.enabled)
  const mode = normalizeAction(input.mode, 'block')
  const defaultScope = normalizeScope(input.scope, 'all')
  const autoPurposes = toArray(input.autoPurposes ?? input.autoPurpose).length > 0
    ? toArray(input.autoPurposes ?? input.autoPurpose)
    : [...DEFAULT_AUTO_PURPOSES]
  const log = input.log === undefined ? true : Boolean(input.log)
  const blockMessage = typeof input.blockMessage === 'string' && input.blockMessage.length > 0
    ? input.blockMessage
    : '已被 dsh-model-guard 拦截：该 API/模型处于禁止自动调用名单中。'

  if (input.mode !== undefined && !ACTIONS.includes(input.mode)) {
    warnings.push(`mode "${input.mode}" 不是合法动作（${ACTIONS.join(' | ')}），已回退为 "${mode}"`)
  }
  if (input.scope !== undefined && !SCOPES.includes(input.scope)) {
    warnings.push(`scope "${input.scope}" 不是合法作用域（${SCOPES.join(' | ')}），已回退为 "${defaultScope}"`)
  }

  const rules = []

  // 便捷字段：blockedProviders / blockedModels / blockedPurposes → 隐含规则
  const convenience = [
    { field: 'blockedProviders', key: 'provider', action: mode, scope: defaultScope },
    { field: 'blockedModels', key: 'model', action: mode, scope: defaultScope },
    { field: 'blockedPurposes', key: 'purpose', action: mode, scope: defaultScope },
  ]
  for (const { field, key, action, scope } of convenience) {
    const values = toArray(input[field])
    if (values.length > 0) {
      rules.push({ source: 'config.' + field, [key]: values, action, scope })
    }
  }

  // 白名单：命中即无条件放行（优先级最高）
  const allowedProviders = toArray(input.allowedProviders)
  const allowedModels = toArray(input.allowedModels)

  // 显式规则表
  if (input.rules !== undefined) {
    if (!Array.isArray(input.rules)) {
      warnings.push('rules 必须是数组，已忽略')
    } else {
      input.rules.forEach((rule, index) => {
        if (!rule || typeof rule !== 'object') {
          warnings.push(`rules[${index}] 不是对象，已忽略`)
          return
        }
        const normalized = {
          source: `rules[${index}]`,
          action: normalizeAction(rule.action, mode),
          scope: normalizeScope(rule.scope, defaultScope),
          note: typeof rule.note === 'string' ? rule.note : '',
        }
        if (rule.action !== undefined && !ACTIONS.includes(rule.action)) {
          warnings.push(`rules[${index}].action "${rule.action}" 非法，已回退为 "${normalized.action}"`)
        }
        if (rule.scope !== undefined && !SCOPES.includes(rule.scope)) {
          warnings.push(`rules[${index}].scope "${rule.scope}" 非法，已回退为 "${normalized.scope}"`)
        }
        for (const key of ['provider', 'model', 'purpose']) {
          // purpose 保留空字符串：'' 表示「用户主动发起（无 purpose）的调用」
          const values = key === 'purpose' ? toPatternArray(rule[key]) : toArray(rule[key])
          if (values.length > 0) normalized[key] = values
        }
        if (rule.allowPurposeless === true) normalized.purpose = ['']  // 仅匹配无 purpose 的调用
        if (rule.fallback && typeof rule.fallback === 'object') {
          normalized.fallback = {
            provider: typeof rule.fallback.provider === 'string' ? rule.fallback.provider : '',
            model: typeof rule.fallback.model === 'string' ? rule.fallback.model : '',
          }
        }
        const hasSelector = normalized.provider || normalized.model || normalized.purpose
        if (!hasSelector) {
          warnings.push(`rules[${index}] 没有任何匹配条件（provider/model/purpose），已忽略`)
          return
        }
        rules.push(normalized)
      })
    }
  }

  if (rules.length === 0) {
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
      enabled,
      mode,
      scope: defaultScope,
      autoPurposes,
      rules,
      allowedProviders,
      allowedModels,
      fallback: globalFallback,
      log,
      blockMessage,
    },
    warnings,
  }
}

/** 单条规则是否匹配一次调用。规则内所有已声明字段之间是「与」，字段值数组内部是「或」。 */
export function ruleMatches(rule, options, autoPurposes) {
  const provider = typeof options?.provider === 'string' ? options.provider : ''
  const model = typeof options?.model === 'string' ? options.model : ''
  const purpose = typeof options?.purpose === 'string' ? options.purpose : ''

  if (rule.provider && !matchesAny(rule.provider, provider)) return false
  if (rule.model && !matchesAny(rule.model, model)) return false
  if (rule.purpose) {
    // '' 表示「没有 purpose（用户主动发起的调用）」，与其它模式之间是「或」
    const patterns = Array.isArray(rule.purpose) ? rule.purpose.map(String) : [String(rule.purpose)]
    const wantsPurposeless = patterns.includes('')
    const named = patterns.filter((p) => p !== '')
    const hit = (wantsPurposeless && purpose === '') || (named.length > 0 && matchesAny(named, purpose))
    if (!hit) return false
  }
  if (rule.scope === 'auto' && !isAutomaticCall(options, autoPurposes)) return false
  return true
}

/**
 * 对一次调用作出判定。
 * @returns {{ action: 'allow'|'block'|'redirect'|'warn', rule: object|null, reason: string }}
 */
export function decide(cfg, options) {
  if (!cfg || cfg.enabled !== true) {
    return { action: 'allow', rule: null, reason: 'disabled' }
  }

  const provider = typeof options?.provider === 'string' ? options.provider : ''
  const model = typeof options?.model === 'string' ? options.model : ''

  // 白名单优先：显式放行永远压过黑名单
  if (matchesAny(cfg.allowedProviders, provider) || matchesAny(cfg.allowedModels, model)) {
    return { action: 'allow', rule: null, reason: 'allowlisted' }
  }

  for (const rule of cfg.rules) {
    if (!ruleMatches(rule, options, cfg.autoPurposes)) continue
    const action = ACTIONS.includes(rule.action) ? rule.action : cfg.mode
    if (action === 'allow') return { action: 'allow', rule, reason: 'rule-allow' }
    return { action, rule, reason: `matched ${rule.source}` }
  }

  return { action: 'allow', rule: null, reason: 'no-match' }
}

/** 构造终止 finish 分片（错误结局），用于短路一次被拦截的调用。 */
export function buildBlockedFinish(cfg, options, rule) {
  const fallbackMessage = cfg?.blockMessage || '已被 dsh-model-guard 拦截。'
  const message = `${fallbackMessage} [provider=${options?.provider ?? '?'} model=${options?.model ?? '?'} purpose=${options?.purpose ?? '(user)'} rule=${rule?.source ?? '-'}]`
  return {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: Object.freeze({ message, code: 'POLICY_BLOCKED' }),
    },
  }
}
