/**
 * L1 计划编译器。
 *
 * 输入：用户配置（platformOrder / modelTiers / 别名表 / finalResort / 冷却）+
 *       OFM 的账号列表与额度读数 + 本地冷却表。
 * 输出：一条有序候选链（写回 OFM 的 combos），以及排除记录 excluded[]（用于面板与重编译 diff）。
 *
 * 遍历形状（用户确认：档优先）：
 *   for tier in modelTiers:
 *     for platform in platformOrder:
 *       该平台有该档 → 入链；否则跳过（R2）
 *
 * 终局（用户确认）：模型档×平台全空 → finalResort.fallbackModels 非空则编译兜底链，
 *   否则进入「等待恢复」（waiting=true, waitUntil=下一个 resetsAt / retryAfterMinutes）。
 */
import crypto from 'node:crypto'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

export function createCompiler({ logger, cfg, ofm, bridge, bench, stores, journal, onReplan, saveCfg }) {
  let busy = false
  let lastChangeSig = null

  function changeSig(plan, excluded) {
    const head = (plan.chain ?? []).slice(0, 4).map((c) => `${c.accountId}|${c.model}`).join(',')
    const ex = (excluded ?? []).filter((e) => e.why === 'exhausted' || e.why === 'cooling').map((e) => `${e.platform}|${e.tier}`).join(',')
    return crypto.createHash('sha256').update(`${head}|${ex}`).digest('hex').slice(0, 16)
  }

  /**
   * 主入口：读数据 → 编排 → 写回 OFM（必要时）→ 落盘 plan.json。
   * @param {{reason?: string, force?: boolean}} opts
   */
  async function replan({ reason = 'manual', force = false } = {}) {
    if (busy) return { busy: true }
    busy = true
    try {
      const config = cfg()
      if (config.enabled === false) {
        const plan = { at: Date.now(), reason, chain: [], excluded: [], waiting: false, disabled: true }
        stores.plan.update(plan)
        return plan
      }

      // 1) 读取 OFM 账号 + 额度（含按需刷新，受 per-hour 预算约束）
      const acct = await readAccounts(config)
      // 1b) 平台健康度：读不到的、以及「0 账号」的平台 → 自动清理 / 标记失效
      //     平台元数据（账号数）来自浏览器快照：channel-pack 里 0 账号的渠道不会出现在 accounts 里，
      //     只有 platforms[] 那一行知道它是 0。
      const platformMeta = bridge?.current?.()?.platforms ?? []
      const prune = pruneMissingPlatforms(config, acct, stores.platforms, journal, platformMeta)
      if (prune.changed) saveCfg?.({ platformOrder: config.platformOrder, platformPolicy: config.platformPolicy })
      // 2) 读本地冷却表
      const cooldownTable = bench.get() ?? {}
      // 3) 编排有序候选
      const { chain, excluded, warnings, waiting, waitUntil } = buildChain(config, acct, cooldownTable)
      // 4) 写回 OFM combos
      const writeResult = await writeBack(config, chain, excluded, bridge)
      // 5) 落盘 plan
      const plan = {
        at: Date.now(),
        reason,
        // 交给 /state 展示用：让「catalog 里自动发现的通道」(magpie 等) 也出现在平台表里
        accounts: acct.map((a) => ({ id: a.id, provider: a.provider, nickname: a.nickname, enabled: a.enabled !== false, kind: a.kind ?? 'account', models: a.models })),
        chain,
        excluded,
        warnings,
        waiting,
        waitUntil,
        candidateHash: hashChain(chain).slice(0, 16),
        writeBack: writeResult,
        // 平台健康度：missing = 配置里有、这轮读不到（UI 显示「已失效」+ 删除按钮）
        platformHealth: prune.health,
        platformsMissing: prune.missing,
        platformsPruned: prune.pruned,
      }
      stores.plan.update(plan)

      const sig = changeSig(plan, excluded)
      if (sig !== lastChangeSig || force) {
        lastChangeSig = sig
        journal({ kind: 'replan', reason, head: (chain[0]?.accountId ?? '-') + '/' + (chain[0]?.model ?? '-'), candidates: chain.length, excluded: excluded.length, waiting })
        try { onReplan?.(plan) } catch { /* ignore */ }
      }
      return plan
    } finally {
      busy = false
    }
  }

  async function readAccounts(config) {
    // 主来源：浏览器中继推上来的快照（带浏览器认证，是唯一有权限的通道，见 design §12）
    if (bridge?.fresh?.()) {
      const snap = bridge.current()
      return enrichAccounts(snap.accounts ?? [], snap.models ?? []).map((a) => ({ ...a, _source: 'browser' }))
    }

    // 降级 1：显式配置了带凭据的 HTTP 端点（DSH_OFM_BASE + 代理）
    if (config.quota.source === 'http') {
      const r = await ofm.listSubscriptions()
      if (r.ok) {
        const prog = budgetTracker(config.quota.probeBudgetPerHour)
        const out = []
        for (const a of r.accounts ?? []) {
          if (!a || typeof a !== 'object') continue
          if (a.enabled === false) { out.push({ ...a, _skip: 'disabled' }); continue }
          if (config.quota.probeOnPlan && prog.allow()) {
            const q = await ofm.refreshQuota(a.id).catch(() => null)
            const fresh = q?.ok ? q.json?.accounts?.find((x) => x.id === a.id) : null
            if (fresh) { out.push({ ...fresh, _source: 'api' }); continue }
          }
          out.push({ ...a, _source: 'api' })
        }
        return out
      }
    }

    // 降级 2：读盘（~/.dsh/channel-pack/state.json；账号与 enabled 可信，额度可能过期）
    const local = readLocalChannelPack()
    const accounts = local?.accounts ?? []
    return enrichAccounts(accounts, readLocalCatalogModels()).map((a) => ({ ...a, _source: 'local' }))
  }

  /** 编排有序候选链。核心逻辑（纯函数，见 design §6.2）。 */
  function buildChain(config, accounts, cooldownTable) {
    const warnings = []
    const excluded = []
    const chain = []
    const now = Date.now()

    // 未开启账号 / 被排除账号 / 被排除平台 / 用户手动删掉的平台
    const offPlatforms = new Set(config.platformPolicy?.excludePlatforms ?? [])
    const hiddenPlatforms = new Set(config.platformPolicy?.hiddenPlatforms ?? [])
    const usable = accounts.filter((a) => a._skip !== 'disabled' && a.enabled !== false)
      .filter((a) => !matchExclude(a.id, config.platformPolicy.excludeAccounts))
      .filter((a) => !offPlatforms.has(a.provider))
      .filter((a) => !hiddenPlatforms.has(a.provider))

    // 平台排序：显式顺序在前，未列出的按 unknownTail 决定
    const ordered = orderPlatforms(usable, config.platformOrder, config.platformPolicy.unknownTail)

    if (config.traversal.order === 'platform-major') {
      for (const a of ordered) {
        for (const tier of config.modelTiers) {
          appendCell(a, tier, config, cooldownTable, chain, excluded, warnings, now)
        }
      }
    } else {
      // tier-major（默认，档优先）
      for (const tier of config.modelTiers) {
        for (const a of ordered) {
          appendCell(a, tier, config, cooldownTable, chain, excluded, warnings, now)
        }
      }
    }

    const maxLen = Number(config.traversal.maxChainLength) || 16
    const truncated = chain.slice(0, maxLen)
    if (truncated.length < chain.length) warnings.push(`链超长，截断至 ${maxLen} 个候选`)

    // 终局尾巴：用户设定的兜底模型 → 官方额度（真正的最后一道闸）。
    // 两者都排在「遍历所得候选」之后，所以平台/模型都没倒的时候它们不会被碰。
    const tail = []
    const fb = (config.finalResort?.fallbackModels ?? []).filter(Boolean)
    for (const m of fb) {
      tail.push({ kind: 'fallback', accountId: null, platform: 'aggregate', model: m, resolved: m, tier: 'fallback', why: 'final-resort' })
    }
    const off = config.finalResort?.official
    if (off && off.enabled !== false && off.provider) {
      for (const m of (off.models ?? []).filter(Boolean)) {
        // 带 provider 前缀：聚合/内置 provider 的路由形式是 `provider/model`，
        // 这样写才不会和免费通道里同名的 `deepseek-flash` 撞车。
        const id = String(m).includes('/') ? String(m) : `${off.provider}/${m}`
        tail.push({ kind: 'fallback', accountId: null, platform: off.provider, model: id, resolved: id, tier: 'official', why: 'official-quota' })
      }
    }

    // 终局判定：档×平台全空 → 尾巴（兜底模型/官方额度）或等待恢复
    let waiting = false
    let waitUntil = 0
    if (truncated.length === 0) {
      if (tail.length > 0) {
        warnings.push(`档×平台全空，使用终局尾巴：${tail.map((t) => t.resolved).join(', ')}`)
      } else {
        waiting = true
        const next = nextReset(usable, now)
        waitUntil = next || now + (config.finalResort.retryAfterMinutes || 10) * 60_000
        warnings.push('档×平台全空且未配置兜底模型，进入等待恢复')
      }
    }

    return { chain: [...truncated, ...tail], excluded, warnings, waiting, waitUntil }
  }

  // 单个格子的判定（R2：缺模型即跳过；冷却/耗尽 → 记录原因并跳过）
  function appendCell(account, tier, config, cooldownTable, chain, excluded, warnings, now) {
    // 平台级冷却（上游对整个域名限流）：该平台的所有模型一起跳过
    const pkey = `provider:${account.provider}`
    const pcool = cooldownTable[pkey]
    if (pcool && pcool.until > now) {
      excluded.push({ platform: account.provider, accountId: account.id, tier: tier.id, model: tier.id, why: 'platform-cooling', reason: pcool.reason ?? 'cooldown', until: pcool.until, level: pcool.level })
      return
    }
    const known = account.models ?? account.modelList ?? []
    const modelId = resolveViaAliases(tier.aliases, known)
    if (!modelId && Array.isArray(known) && known.length === 0) {
      // 该平台的模型清单未知（本地 state.json 不存模型表）——乐观入链：
      // 未知 ≠ 不存在；真没有就让 OFM 的 combo 自然失败并前进，而不是提前跳过。
      if (config.traversal.optimisticOnUnknown !== false) {
        warnings.push(`${account.provider} 的模型清单未知，按别名原样尝试 ${tier.id}`)
        chain.push({ kind: 'account', platform: account.provider, accountId: account.id, model: tier.id, resolved: tier.aliases?.[0] ?? tier.id, tier: tier.id, why: 'unverified' })
      }
      return
    }
    if (!modelId) {
      excluded.push({ platform: account.provider, accountId: account.id, tier: tier.id, model: tier.id, why: 'missing', reason: '平台无此模型（R2 跳过）' })
      return
    }
    const key = `${account.id}|${modelId}`
    const cool = cooldownTable[key]
    if (cool && cool.until > now) {
      const reason = cool.reason ?? 'cooldown'
      excluded.push({ platform: account.provider, accountId: account.id, tier: tier.id, model: modelId, why: 'cooling', reason, until: cool.until, level: cool.level })
      return
    }
    if (isExhausted(account, modelId, config.quota)) {
      excluded.push({ platform: account.provider, accountId: account.id, tier: tier.id, model: modelId, why: 'exhausted', reason: resetsText(account, modelId) })
      return
    }
    chain.push({ kind: 'account', platform: account.provider, accountId: account.id, model: tier.id, resolved: modelId, tier: tier.id, why: 'ready' })
  }

  return { replan, buildChain, readAccounts, changeSig }
}

/**
 * 写回 OFM 的 combos。
 * 只动 `auto:` 前缀的行（prefix），绝不碰用户手工建的链；
 * 做 diff，仅在内容变化时才写；失败 → dryRun/降级返回，不抛（风险 7.6）。
 */
async function writeBack(config, chain, excluded, bridge) {
  const wb = config.writeBack ?? {}
  const wanted = buildCombos(config, chain)

  if (wb.dryRun === true) {
    return { ok: true, dryRun: true, combos: wanted }
  }

  // 合并规则：只替换 `auto:` 前缀的行，用户手工链原样保留。
  const existing = (bridge?.current()?.combos ?? []).map((c) => ({ ...c }))
  const merged = existing.filter((c) => !isAuto(c.id, wb.prefix)).concat(wanted)

  if (wb.mode === 'file') {
    // 退化路径：直接改 OFM 的 settings.json。OFM 常驻内存，需重启才生效 —— UI 会标注。
    return writeSettingsFile(merged, wanted)
  }

  // 默认：浏览器中继。host 只把「想写什么」挂出去，由带 cookie 的浏览器执行 POST /combos。
  // 若合并结果与 OFM 现有内容一致（含「只有用户手工链、我们没有要加的东西」），不必写。
  if (JSON.stringify(existing) === JSON.stringify(merged)) {
    return { ok: true, unchanged: true, mode: 'browser', combos: merged }
  }
  const prev = bridge?.peek?.()
  if (prev && JSON.stringify(prev.combos) === JSON.stringify(merged)) {
    return { ok: true, unchanged: true, mode: 'browser', combos: merged }
  }
  // 与「上一次真正写进 OFM 的内容」比：peek() 在取走后就是 null，
  // 只跟它比会让每次 replan 都重写一遍（每 15s 一次 POST /combos），
  // 而 OFM 每次保存都可能触发自己的探测，实测会把上游打到 429、
  // 连余额查询一起挂掉。
  if (bridge?.lastApplied?.() && bridge.lastApplied() === JSON.stringify(merged)) {
    return { ok: true, unchanged: true, mode: 'browser', combos: merged }
  }

  if (!bridge?.setPending) {
    return { ok: false, mode: 'browser', error: 'bridge unavailable; cannot queue write', combos: merged }
  }
  bridge.setPending(merged, 'replan')
  return { ok: true, mode: 'browser', pending: true, count: wanted.length, combos: merged }
}

/** 写 OFM 的 settings.json（仅在 writeBack.mode==='file' 时）。 */
function writeSettingsFile(merged, wanted) {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const file = path.join(home, 'our-free-model', 'settings.json')
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const next = { ...raw, combos: merged }
    const tmp = `${file}.qt-${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, file)
    return { ok: true, mode: 'file', requiresRestart: true, count: wanted.length, combos: merged }
  } catch (error) {
    return { ok: false, mode: 'file', error: String(error?.message ?? error), combos: merged }
  }
}

function buildCombos(config, chain) {
  const wb = config.writeBack ?? {}
  const prefix = wb.prefix ?? 'auto:'
  const mainId = wb.mainComboId ?? 'auto:main'
  const main = {
    id: mainId,
    name: '接力链 · 自动',
    models: chain.filter((c) => c.resolved || c.kind === 'fallback').map((c) => c.kind === 'fallback' ? c.model : c.resolved),
    strategy: 'fallback',
    stickyLimit: 1,
    enabled: true,
  }
  const out = [main]
  if (wb.perTierCombos === true && config.modelTiers?.length) {
    for (const tier of config.modelTiers) {
      const ids = chain.filter((c) => c.tier === tier.id && c.resolved).map((c) => c.resolved)
      if (ids.length) {
        out.push({
          id: `${prefix}tier:${tier.id}`,
          name: `接力 · ${tier.label ?? tier.id} 跨平台`,
          models: ids,
          strategy: 'fallback',
          stickyLimit: 1,
          enabled: true,
        })
      }
    }
  }
  return out.filter((c) => c.models && c.models.length > 0)
}

function isAuto(id, prefix) {
  return typeof id === 'string' && id.startsWith(prefix ?? 'auto:')
}

// ── helpers ────────────────────────────────────────────────────────────────

/** 别名解析：在该平台模型清单里找第一个能在 aliases/规范化后匹配的 id。 */
export function resolveViaAliases(aliases = [], models = []) {
  const list = Array.isArray(models) ? models : []
  const inList = list.map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean)
  for (const al of aliases ?? []) {
    if (!al) continue
    if (inList.includes(al)) return al
    // 规范化：去 -free / -preview / eac: 前缀，小写
    const norm = normalizeModel(al)
    // 聚合渠道的模型 id 形如 `siliconflow/deepseek-ai/DeepSeek-V3`：
    // 先按整串比，再按最后一段比，这样别名 `DeepSeek-V3` 也能命中。
    const hit = inList.find((m) => normalizeModel(m) === norm)
      ?? inList.find((m) => normalizeModel(String(m).split('/').pop()) === norm)
    if (hit) return hit
  }
  return null
}

function normalizeModel(m) {
  return String(m).toLowerCase()
    .replace(/^eac:/, '')
    .replace(/-free$/, '')
    .replace(/-preview$/, '')
    .replace(/-$/, '')
}

/** 用 catalog 里的订阅型模型 id（`subscription:<accountId>/<model>`）补齐账号的模型清单。 */
export function enrichAccounts(accounts, catalogModels) {
  const byAccount = new Map()
  for (const m of catalogModels ?? []) {
    const id = typeof m === 'string' ? m : m?.id
    if (typeof id !== 'string') continue
    const hit = /^subscription:([^/]+)\/(.+)$/.exec(id)
    if (!hit) continue
    const [, accountId] = hit
    const arr = byAccount.get(accountId) ?? []
    // 存**完整**的 catalog id（combos 只认原样 id）；别名匹配靠最后一段兜底。
    arr.push(id)
    byAccount.set(accountId, arr)
  }
  const list = (accounts ?? []).map((a) => {
    const own = Array.isArray(a.models) && a.models.length ? a.models : (byAccount.get(a.id) ?? [])
    return { ...a, models: own }
  })
  // catalog 里出现、但账号池里没有的通道（例如 magpie 引擎自己的
  // `subscription:magpie/siliconflow/…`）也当成一个平台：这样用户新接的
  // 聚合渠道（硅基流动等）不用改插件就能出现在顺序表里。
  const known = new Set(list.map((a) => a.id))
  for (const [accountId, models] of byAccount) {
    if (known.has(accountId)) continue
    list.push({
      id: accountId,
      provider: accountId,
      nickname: accountId === 'magpie' ? 'Magpie（硅基流动等）' : accountId,
      enabled: true,
      models,
      kind: 'lane',
    })
  }
  return list
}

/**
 * 平台健康度 + 自动清理。
 *
 * 解决的问题：用户接了又撤掉的渠道、以及「0 账号」的空渠道，会永远留在顺序表里，
 * 列表越来越长。三条规则（保守优先，避免一次探测失败就删光）：
 *
 *   1. 缺席：配置里有、本轮没读到 → missingSyncs +1；连续 >= pruneAfterMisses 轮 → 移除。
 *   2. 0 账号：本轮读到了，但该平台账号数是 0 → 立刻隐藏（用户明确要求「0 账号的都自动删掉」）。
 *   3. 自愈：被自动隐藏的平台后来又有账号了 → 自动放回来（只有 autoHidden 的会自愈，
 *      用户手动删的保持删除状态）。
 *
 * 「隐藏」= 写进 platformPolicy.hiddenPlatforms 并从 platformOrder / excludePlatforms 移除；
 * 同时写 excludePlatforms 让**旧版宿主**（只认 excludePlatforms）也立刻不再用它接力。
 *
 * 空观测保护：一轮连一个平台都没读到 = 数据源整个坏了（中继断线 / OFM 重启），
 * 这时既不计数也不删，原样带回上一轮健康度。
 *
 * @param {object} config 运行时配置（会被就地修改）
 * @param {Array} accounts 账号列表（含 provider）
 * @param {{get?:Function, edit?:Function, update?:Function}} store platforms.json
 * @param {Function} [journal]
 * @param {Array} [platformMeta] 浏览器快照的 platforms[]（{provider, accounts, models}）
 * @returns {{health: object, missing: Array, pruned: string[], hidden: string[], restored: string[], changed: boolean}}
 */
export function pruneMissingPlatforms(config, accounts, store, journal, platformMeta) {
  const policy = config?.platformPolicy ?? {}
  const prev = store?.get?.() ?? {}
  const now = Date.now()
  const health = {}
  const pruned = []
  const hiddenNow = []
  const restored = []

  // 每平台账号数：优先用快照里的 platforms[]（channel-pack 里 0 账号的渠道不会出现在
  // accounts 里，只有那一行知道它是 0）；没有元数据时退回数账号。
  const countByProvider = new Map()
  for (const a of accounts ?? []) {
    if (!a?.provider) continue
    countByProvider.set(a.provider, (countByProvider.get(a.provider) ?? 0) + 1)
  }
  const metaCount = new Map()
  for (const p of platformMeta ?? []) {
    if (!p?.provider) continue
    metaCount.set(p.provider, Number(p.accounts) || 0)
  }
  const accountsOf = (id) => (metaCount.has(id) ? Math.min(metaCount.get(id), countByProvider.get(id) ?? metaCount.get(id)) : (countByProvider.get(id) ?? 0))

  const observed = new Set([...countByProvider.keys(), ...metaCount.keys()])

  if (observed.size === 0) {
    const keep = { ...(prev ?? {}) }
    return {
      health: keep,
      missing: Object.entries(keep)
        .filter(([, v]) => (Number(v?.missingSyncs) || 0) > 0)
        .map(([id, v]) => ({ id, missingSyncs: v.missingSyncs, lastSeenAt: v.lastSeenAt ?? 0 })),
      pruned: [], hidden: [], restored: [], changed: false, skipped: true,
    }
  }

  const configured = new Set([
    ...(config?.platformOrder ?? []),
    ...(policy.excludePlatforms ?? []),
    ...(policy.hiddenPlatforms ?? []),
  ])

  // ── 规则 1 / 2：缺席与 0 账号
  for (const id of configured) {
    const before = prev[id] ?? {}
    if (!observed.has(id)) {
      const missingSyncs = (Number(before.missingSyncs) || 0) + 1
      health[id] = { lastSeenAt: Number(before.lastSeenAt) || 0, missingSyncs, accounts: 0, autoHidden: before.autoHidden === true }
      if (policy.pruneMissing !== false && missingSyncs >= (Number(policy.pruneAfterMisses) || 3)) pruned.push(id)
      continue
    }
    const n = accountsOf(id)
    health[id] = { lastSeenAt: now, missingSyncs: 0, accounts: n, autoHidden: before.autoHidden === true }
    if (n === 0 && policy.pruneZeroAccounts !== false) hiddenNow.push(id)
  }
  for (const id of observed) {
    if (!health[id]) health[id] = { lastSeenAt: now, missingSyncs: 0, accounts: accountsOf(id), autoHidden: false }
  }

  // ── 规则 3：自愈（只有 autoHidden 的会回来）
  const hiddenSet = new Set(policy.hiddenPlatforms ?? [])
  for (const id of [...hiddenSet]) {
    const row = health[id]
    if (!row) continue
    if (prev[id]?.autoHidden === true && row.accounts > 0 && row.missingSyncs === 0) {
      hiddenSet.delete(id)
      restored.push(id)
      health[id] = { ...row, autoHidden: false }
    }
  }
  for (const id of hiddenNow) {
    hiddenSet.add(id)
    health[id] = { ...health[id], autoHidden: true }
  }
  // 用户「手动删除」过的（旧版本没记 autoHidden 的那种）保持隐藏，不参与自愈

  if (store?.edit) store.edit(() => health)
  else store?.update?.(health)

  const drop = new Set([...pruned, ...hiddenNow])
  let changed = false
  if (drop.size > 0) {
    config.platformOrder = (config.platformOrder ?? []).filter((id) => !drop.has(id))
    const excl = new Set(policy.excludePlatforms ?? [])
    for (const id of drop) excl.add(id)
    for (const id of restored) excl.delete(id)
    config.platformPolicy = { ...policy, excludePlatforms: [...excl], hiddenPlatforms: [...hiddenSet] }
    changed = true
    if (pruned.length) journal?.({ kind: 'platform-prune', ids: pruned })
    if (hiddenNow.length) journal?.({ kind: 'platform-hide-zero', ids: hiddenNow })
    if (restored.length) journal?.({ kind: 'platform-restore', ids: restored })
  } else if (restored.length > 0) {
    const excl = new Set(policy.excludePlatforms ?? [])
    for (const id of restored) excl.delete(id)
    config.platformPolicy = { ...policy, excludePlatforms: [...excl], hiddenPlatforms: [...hiddenSet] }
    changed = true
    journal?.({ kind: 'platform-restore', ids: restored })
  }

  const missing = Object.entries(health)
    .filter(([, v]) => (Number(v?.missingSyncs) || 0) > 0)
    .map(([id, v]) => ({ id, missingSyncs: v.missingSyncs, lastSeenAt: v.lastSeenAt ?? 0 }))
  const zeroAccounts = Object.entries(health)
    .filter(([, v]) => v.missingSyncs === 0 && v.accounts === 0)
    .map(([id]) => id)
  return { health, missing, pruned, hidden: hiddenNow, restored, zeroAccounts, changed }
}

/** 本地 catalog.json 的模型 id 列表（无账号前缀的那种，用于降级路径）。 */
function readLocalCatalogModels() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(home, 'our-free-model', 'catalog.json'), 'utf8'))
    return Array.isArray(raw?.entries) ? raw.entries : []
  } catch {
    return []
  }
}

function matchExclude(id, patterns = []) {
  for (const p of patterns) {
    if (!p) continue
    if (p.endsWith('*')) { if (id.startsWith(p.slice(0, -1))) return true }
    else if (p.startsWith('*')) { if (id.endsWith(p.slice(1))) return true }
    else if (id === p) return true
  }
  return false
}

function orderPlatforms(accounts, explicitOrder, unknownTail) {
  const byProvider = new Map()
  for (const a of accounts) {
    const arr = byProvider.get(a.provider) ?? []
    arr.push(a)
    byProvider.set(a.provider, arr)
  }
  const out = []
  for (const p of explicitOrder ?? []) {
    for (const a of byProvider.get(p) ?? []) out.push(a)
    byProvider.delete(p)
  }
  const tail = []
  for (const arr of byProvider.values()) tail.push(...arr)
  if (unknownTail !== false) return [...out, ...tail]
  return out
}

function isExhausted(account, modelId, quotaCfg) {
  const windows = account.quota?.windows ?? []
  const threshold = Number(quotaCfg.excludeBelowPercent) || 1
  const checkedAt = Date.parse(account.quota?.checkedAt ?? '')
  const fresh = Number.isFinite(checkedAt)
    && (Date.now() - checkedAt) / 60000 < (Number(quotaCfg.freshnessMinutes) || 15)

  // 显式耗尽永远优先：任一窗口剩余 <= 0（或低于阈值）即视为耗尽
  if (windows.some((w) => Number(w.remainingPercent) <= 0)) return true
  if (windows.some((w) => Number(w.remainingPercent) < threshold)) return true
  // 读数缺失/过期：参照 treatUnknownAsUsable —— 默认保留（宁可试一次，不可漏可用平台）
  if (!fresh) return quotaCfg.treatUnknownAsUsable === false
  return false
}

function resetsText(account, modelId) {
  const w = (account.quota?.windows ?? []).find((x) => x.resetsAt)
  if (!w) return '额度耗尽'
  return `额度耗尽，${w.resetsAt} 后重置`
}

function nextReset(accounts, now) {
  const times = []
  for (const a of accounts ?? []) {
    for (const w of (a.quota?.windows ?? [])) {
      const t = Date.parse(w.resetsAt ?? '')
      if (Number.isFinite(t) && t > now) times.push(t)
    }
  }
  if (times.length === 0) return 0
  return Math.min(...times)
}

function hashChain(chain) {
  return crypto.createHash('sha256')
    .update(chain.map((c) => `${c.accountId ?? c.model}|${c.model}`).join(','))
    .digest('hex')
}

function readLocalChannelPack() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  try {
    return JSON.parse(fs.readFileSync(path.join(home, 'channel-pack', 'state.json'), 'utf8'))
  } catch {
    return null
  }
}

/** 简单 per-hour 预算桶。 */
function budgetTracker(perHour) {
  const bucket = perHour || 12
  let windowStart = Date.now()
  let used = 0
  return {
    allow() {
      if (Date.now() - windowStart >= 3600_000) { windowStart = Date.now(); used = 0 }
      if (used >= bucket) return false
      used += 1
      return true
    },
  }
}