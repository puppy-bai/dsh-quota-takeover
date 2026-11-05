/**
 * L3 失败分类：把一个流末的 failure 归到「该做什么」。
 *
 * 设计文档 §6.4 的映射表。原则：
 *  - 只有 quota-like 的失败才触发自动续跑（用户可关：resume.onlyQuotaLike=false 则扩大）；
 *  - 分类只读 code / status / message，绝不猜测；
 *  - 冷却时长与 OFM 的 classify.js 常量保持一致，避免两处打架。
 */

export const ACTION = {
  SWITCH: 'switch',   // 换平台/模型后重试本回合（交由 combo 链自然会做，插件只做记录）
  RESUME: 'resume',   // 注入「继续」并重启一回合
  WAIT: 'wait',       // 等 resetsAt / retryAfter 再试
  GIVEUP: 'giveup',   // 交给用户（凭据问题、请求本身非法、用户自己 abort）
  IGNORE: 'ignore',
}

export const COOLDOWN = {
  QUOTA_MS: 2 * 60 * 1000,
  // 60s 而不是 5s：宿主在上游连续限流后会自己放弃本回合（"stops amplifying after
  // 5 consecutive rate limits"）。5s 冷却意味着下一次 replan 又把同一格选回来，
  // candidateHash 不变 → requireCandidateChange 直接跳过续跑 → 任务还是断的。
  RATE_LIMIT_MS: 60 * 1000,
  AUTH_MS: 10 * 60 * 1000,
  TRANSIENT_MS: 30 * 1000,
  MAX_MS: 30 * 60 * 1000,
}

// 顺序敏感：先匹配到的规则赢（与 OFM ERROR_RULES 同构）
// 宿主的「放大熔断」文案（#4204）：连续 5 次上游限流后它不再自动重试本回合，
// 直接以失败收束 —— 这正是必须由我们接住的场景，且是 **provider 级** 的问题，
// 不是某个账号/模型的问题，所以要冷却整个平台。
const AMPLIFY_RE = /stops amplifying|consecutive rate.?limits?|upstream rate.?limit/i
const AMPLIFY_RULE = { kind: 'rate_limit', scope: 'provider', action: ACTION.RESUME, cooldownMs: COOLDOWN.RATE_LIMIT_MS, retryable: true }

const RULES = [
  { re: /insufficient_quota|quota exceeded|out of credits|no credits|余额不足|积分不足|额度(已)?(用完|耗尽|不足)|免费额度/i, kind: 'quota', scope: 'account', action: ACTION.RESUME, cooldownMs: COOLDOWN.QUOTA_MS, retryable: true },
  { re: AMPLIFY_RE, ...AMPLIFY_RULE },
  { re: /rate.?limit|too many requests|429|限流|请求过于频繁|频率过高/i, kind: 'rate_limit', scope: 'account', action: ACTION.RESUME, cooldownMs: COOLDOWN.RATE_LIMIT_MS, retryable: true },
  { re: /current account is unavailable|没有符合渠道策略的备用账号|QUEUE/i, kind: 'queue', scope: 'account', action: ACTION.RESUME, cooldownMs: COOLDOWN.RATE_LIMIT_MS, retryable: true },
  { re: /no credentials|invalid.*(api.?key|credential|token)|unauthor|401|认证|凭据/i, kind: 'auth', scope: 'account', action: ACTION.GIVEUP, cooldownMs: COOLDOWN.AUTH_MS, retryable: false },
  { re: /permission|forbidden|403|not allowed|region|区域/i, kind: 'permission', scope: 'account', action: ACTION.SWITCH, cooldownMs: COOLDOWN.AUTH_MS, retryable: false },
  { re: /overloaded|capacity|502|503|529|服务(器)?(繁忙|不可用)/i, kind: 'overloaded', scope: 'provider', action: ACTION.SWITCH, cooldownMs: COOLDOWN.TRANSIENT_MS, retryable: true },
  { re: /timeout|ETIMEDOUT|ECONNRESET|socket hang up|network|fetch failed|超时/i, kind: 'timeout', scope: 'transient', action: ACTION.SWITCH, cooldownMs: COOLDOWN.TRANSIENT_MS, retryable: true },
  { re: /context.*(length|window)|too long|maximum context|上下文/i, kind: 'context_window', scope: 'request', action: ACTION.GIVEUP, cooldownMs: 0, retryable: false },
  { re: /invalid.*(request|parameter)|improperly formed|400/i, kind: 'invalid_request', scope: 'request', action: ACTION.GIVEUP, cooldownMs: 0, retryable: false },
  { re: /abort|cancel/i, kind: 'aborted', scope: 'request', action: ACTION.IGNORE, cooldownMs: 0, retryable: false },
]

const CODE_MAP = {
  QUOTA_EXHAUSTED: 'quota',
  RATE_LIMIT: 'rate_limit',
  INVALID_CREDENTIAL: 'auth',
  AUTHORIZATION_REQUIRED: 'auth',
  PERMISSION_DENIED: 'permission',
  REGION_BLOCKED: 'permission',
  LANE_LOCKED: 'permission',
  TIMEOUT: 'timeout',
  TRANSPORT: 'timeout',
  SERVER: 'overloaded',
  NO_PROGRESS: 'timeout',
  STREAM_CUT: 'timeout',
  CLIENT_ERROR: 'invalid_request',
  ABORTED: 'aborted',
}

const KIND_TO_RULE = new Map(RULES.map((r) => [r.kind, r]))

/**
 * @param {{message?:string, code?:string, status?:number}} failure
 * @returns {{kind:string, scope:string, action:string, cooldownMs:number, retryable:boolean, matchedBy:string}}
 */
export function classifyFailure(failure = {}) {
  const text = String(failure.message ?? '')
  const code = String(failure.code ?? '')
  const status = Number(failure.status ?? 0)

  // 0) 熔断文案比 code 更具体：宿主报的 code 可能只是泛化的 RATE_LIMIT，
  //    但它同时告诉了我们「整个上游域名都在限流」，作用域必须升到 provider。
  if (AMPLIFY_RE.test(text)) return { ...AMPLIFY_RULE, matchedBy: 'text:amplify' }

  // 1) 结构化 code 优先（宿主自己的枚举最可信）
  if (code && CODE_MAP[code]) {
    const rule = KIND_TO_RULE.get(CODE_MAP[code])
    if (rule) return { ...pick(rule), matchedBy: `code:${code}` }
  }

  // 2) 文本规则
  for (const rule of RULES) {
    if (rule.re.test(text)) return { ...pick(rule), matchedBy: 'text' }
  }

  // 3) 状态码兜底
  if (status === 429) return { ...pick(KIND_TO_RULE.get('rate_limit')), matchedBy: 'status:429' }
  if (status === 401 || status === 403) return { ...pick(KIND_TO_RULE.get('auth')), matchedBy: `status:${status}` }
  if (status >= 500) return { ...pick(KIND_TO_RULE.get('overloaded')), matchedBy: `status:${status}` }

  return { kind: 'unknown', scope: 'transient', action: ACTION.IGNORE, cooldownMs: COOLDOWN.TRANSIENT_MS, retryable: false, matchedBy: 'default' }
}

function pick(rule) {
  return { kind: rule.kind, scope: rule.scope, action: rule.action, cooldownMs: rule.cooldownMs, retryable: rule.retryable }
}

/** 从流末 reason 里取出 failure（兼容 finish/error 与直接 throw 的形态）。 */
export function failureOf(reason) {
  if (!reason) return null
  if (reason.kind === 'error' && reason.failure) return reason.failure
  if (reason.failure) return reason.failure
  if (reason.error) return reason.error
  return null
}

export const QUOTA_LIKE = new Set(['quota', 'rate_limit', 'queue', 'overloaded'])
