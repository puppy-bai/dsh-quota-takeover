/**
 * 浏览器中继桥（browser-mediated bridge）。
 *
 * 背景（M0 探针 1 实测）：OFM 的 `/api/our-free-model/*` 挂在 harness 的信任围栏后，
 * 进程内请求没有浏览器认证 cookie，一律 401（见 docs/quota-takeover-plugin-design.md §12）。
 * 所以「读账号/额度」「写 combos」只能由**浏览器半身**代劳。
 *
 * 本模块是 host 侧的中继状态：吃浏览器推上来的快照，吐出待写回的 combos，
 * 并记下最后一次成功写回的时间。全部内存 + 可落盘，绝不直接改 OFM 的文件。
 */

export function createBridge({ logger, ttlMs = 120_000 } = {}) {
  let snapshot = null        // { accounts, combos, models, at, source }
  let pending = null         // { combos, at, reason }
  let appliedAt = 0
  let appliedHash = ''
  let appliedJson = ''   // 上次真正写进 OFM 的 combos（JSON 串），用于『没变化就不重复写』
  let refreshRequestedAt = 0

  const log = (level, msg) => logger?.[level]?.(`[quota-takeover] ${msg}`)

  /** 浏览器推快照（GET /combos + /subscriptions 的结果）。 */
  function ingest({ accounts, combos, models, platforms, source } = {}) {
    snapshot = {
      accounts: Array.isArray(accounts) ? accounts : [],
      combos: Array.isArray(combos) ? combos : [],
      // combos.list() 的 models[]：OFM 此刻能路由的每个模型 id（订阅型带账号前缀），
      // 这是「平台 × 模型」网格的来源之一（design §12.5）
      models: Array.isArray(models) ? models : [],
      // provider.status 的摘要：设置页拿它渲染「平台顺序」而不用再问一次 RPC
      platforms: Array.isArray(platforms) ? platforms : [],
      at: Date.now(),
      source: source ?? 'browser',
    }
    return snapshot
  }

  /** 快照是否还新鲜（超过 ttl 视为过期，host 会退化到读盘）。 */
  function fresh(now = Date.now()) {
    return snapshot !== null && now - snapshot.at <= ttlMs
  }

  function current() { return snapshot }

  /** host 算好要写的 combos，等浏览器来取。 */
  function setPending(combos, reason = 'replan') {
    pending = { combos, at: Date.now(), reason }
    return pending
  }

  /** 浏览器取走待写内容（取走即清，避免重复写）。 */
  function takePending() {
    const p = pending
    pending = null
    return p
  }

  function peek() { return pending }

  /** 浏览器报告写回成功（带回 OFM 实际返回的 combos，用于二次比对）。 */
  function markApplied({ combos, hash, sent } = {}) {
    appliedAt = Date.now()
    appliedHash = String(hash ?? '')
    if (Array.isArray(combos)) {
      // 记住『我们发出去的那份』而不是『OFM 存下的那份』：
      // 若 OFM 剔除了某些 id，存下的永远不等于想要的，会变成每 15s 重写一次的死循环。
      appliedJson = JSON.stringify(Array.isArray(sent) ? sent : combos)
      snapshot = { ...(snapshot ?? { accounts: [] }), combos, at: snapshot?.at ?? Date.now(), source: snapshot?.source ?? 'browser' }
    }
    log('info', `combos 已由浏览器写回（${combos?.length ?? '?'} 条）`)
    return { appliedAt, appliedHash }
  }

  /**
   * 上一次「真正写进 OFM」的 combos（JSON 串）。
   *
   * 存在的理由：`peek()` 在浏览器取走待写内容后就变成 null，如果只跟它比，
   * 每次 replan 都会认为「变了」，于是每 15 秒就把同一份 combos 再 POST 一次。
   * OFM 每次保存 combine 都可能触发它自己的探测/刷新，实测会把上游打到 429，
   * 连带余额查询一起挂 —— 所以必须跟「已落地的内容」比，而不是跟待写队列比。
   */
  function lastApplied() { return appliedJson }

  /** 请求浏览器立刻刷新一次额度（host 自己刷不了）。 */
  function requestRefresh() { refreshRequestedAt = Date.now() }
  function takeRefreshRequest() {
    if (!refreshRequestedAt) return false
    refreshRequestedAt = 0
    return true
  }

  function status(now = Date.now()) {
    return {
      hasSnapshot: snapshot !== null,
      snapshotAt: snapshot?.at ?? 0,
      snapshotAgeMs: snapshot ? now - snapshot.at : null,
      fresh: fresh(now),
      accounts: snapshot?.accounts?.length ?? 0,
      combos: snapshot?.combos?.length ?? 0,
      pendingWrite: pending ? { at: pending.at, count: pending.combos?.length ?? 0, reason: pending.reason } : null,
      appliedAt,
      appliedHash,
      refreshPending: Boolean(refreshRequestedAt),
    }
  }

  return { ingest, current, fresh, setPending, takePending, peek, markApplied, lastApplied, requestRefresh, takeRefreshRequest, status }
}
