/**
 * dsh-model-guard · 插件入口（Host 半身）
 *
 * 「禁止自动调用某个 API 或某个模型」的守卫插件：
 * 在 DSH 每一次模型调用的必经之路 —— \`llm/stream\` waterfall —— 上做名单判定，
 * 命中即可拦截、改道到备用模型或仅告警。
 *
 * 核心逻辑在 ./matcher.js（规则引擎）与 ./guard.js（拦截器装配），
 * 本文件只负责声明插件元信息与 schemastery 配置表。
 */
import z from '@deepseek-ai/schemastery'
import { installGuard } from './guard.js'
import { DEFAULT_AUTO_PURPOSES } from './matcher.js'

/** Cordis 插件名（供 cordis.patch.yml 的 name 字段引用）。 */
export const name = 'model-guard'

/** 需要 LLM 服务就绪后再注册（拦截需要 ctx.llm，改道也需要它）。 */
export const inject = ['llm']

/**
 * 配置表。刻意使用宽容类型：本插件的定位是「守卫」，
 * 配置写错时应当继续运行并给出提醒，而不是让宿主加载失败。
 * 所有字段的语义与容错都在 matcher.js 的 normalizeConfig() 中处理。
 */
export const Config = z.object({
  // 带 .volatile() 的字段会出现在「设置 → 插件 → 模型调用守卫」界面里，
  // 由 lib/client.js 渲染成可视化选择器，并通过 dsh-settings 服务写回 profile。
  /** 总开关。 */
  enabled: z.boolean().default(true).volatile(),
  /** 名单策略：blocklist（拉黑列表内的）/ allowlist（只放行列表内的，其余全拦）。 */
  policy: z.string().default('blocklist').volatile(),
  /** 命中后的默认动作：block（拦截）/ redirect（改道）/ warn（仅告警）。 */
  mode: z.string().default('block').volatile(),
  /** 默认作用域：all（所有调用）/ auto（仅自动调用，即带 purpose 的后台调用）。 */
  scope: z.string().default('all').volatile(),
  /** 禁止使用的 provider（API 渠道），支持 * 通配。 */
  blockedProviders: z.array(z.string()).default([]).volatile(),
  /** 禁止使用的模型 id，支持 * 通配。 */
  blockedModels: z.array(z.string()).default([]).volatile(),
  /** 禁止的调用用途，如 compaction、session-title。 */
  blockedPurposes: z.any(),
  /** 白名单：命中的 provider 一律放行（优先级高于黑名单）。 */
  allowedProviders: z.any(),
  /** 白名单：命中的模型一律放行（优先级高于黑名单）。 */
  allowedModels: z.any(),
  /** 视为「自动调用」的 purpose 集合。 */
  autoPurposes: z.array(z.string()).default([...DEFAULT_AUTO_PURPOSES]),
  /** redirect 模式下的备用模型（可被单条规则覆盖）。 */
  fallback: z.any(),
  /** 精确规则表，每条规则可自带 action / scope / fallback。 */
  rules: z.any(),
  /** 按 Agent 预设 / 会话独立起的规则作用域（数组，命中第一条即生效）。 */
  scopes: z.any(),
  /** 权重软调度：命中 match 后按 weight 抽一条路线（allow / redirect / block）。 */
  softRules: z.any(),
  /** 服务商熔断：连续失败达阈值后临时拦截，冷却后自动恢复。 */
  breaker: z.any(),
  /** 审计日志：内存环形缓冲 + 会话日志 + 可选 JSONL 文件。 */
  audit: z.any(),
  /** 是否在启动时提示可能与其它守卫类插件冲突。 */
  conflictCheck: z.boolean().default(true),
  /** 是否输出拦截日志。 */
  log: z.boolean().default(true),
  /** 自定义拦截提示语。 */
  blockMessage: z.string().default(''),
})

/**
 * Cordis 入口。
 * @param ctx - 宿主上下文。
 * @param config - cordis.patch.yml 中该插件行的 config 节点。
 * @param hooks - 可选：{ log, onEvent } 注入点，宿主不会传，仅供测试与复用。
 */
export function apply(ctx, config = {}, hooks = {}) {
  return installGuard(ctx, config, hooks)
}

export { DEFAULT_AUTO_PURPOSES }
