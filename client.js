/**
 * Quota Takeover — browser half（设置页 + 中继）。
 *
 * 为什么需要浏览器半身（design §12）：
 * OFM 的 HTTP API 挂在 harness 的信任围栏后，只放行带浏览器认证 cookie 的同源请求；
 * 插件的 host 进程直接 fetch 一律 401。而**账号与模型清单根本不在那套 HTTP API 里**
 * —— 它们在 channel-pack 的 RPC（`/api/channel-pack`）后面，只有页面里的
 * `connection.rpc.call` 能调到。所以这一侧做三件事：
 *
 *   ① 用 RPC 读「平台 → 账号 / 模型」真实网格（account.list / model.list），
 *      HTTP 读 combos（GET /api/our-free-model/combos）
 *   ② POST /api/quota-takeover/snapshot 交给 host 编译
 *   ③ GET pending → POST /api/our-free-model/combos（带 cookie 写）→ POST applied
 *
 * 另外提供设置页：平台顺序、模型档顺序、重试节奏都可直接改。
 *
 * Hand-written ModuleLoader bundle: no build step, only the `react` the shell provides.
 */
window.__ModuleLoader__.load({
  id: 'dsh-quota-takeover',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useState, useEffect, useCallback, useRef, useMemo } = React

    const inject = ['slots']
    const OFM = '/api/our-free-model'
    const QT = '/api/quota-takeover'
    const SYNC_MS = 60000 // 60s：channel-pack 的 provider.status/account.list/model.list 是重活，
    // 15s 一轮会把可刷新账号的探测节奏压到极限（实测曾把上游打成 429）。

    // channel-pack 支持的 provider（顺序即上游声明顺序；未知 id 会被服务端忽略）
    const PROVIDERS = ['lobsterai', 'qoder', 'qodercn', 'trae', 'cline', 'loomy', 'raccoon', 'minimax', 'zcode', 'opencode', 'gemini']
    const PROVIDER_LABEL = {
      lobsterai: 'LobsterAI', qoder: 'Qoder', qodercn: 'Qoder CN', trae: 'TRAE', cline: 'Cline',
      loomy: 'Loomy', raccoon: 'Raccoon', minimax: 'MiniMax', zcode: 'ZCode', opencode: 'OpenCode', gemini: 'Gemini',
    }

    // ── transport ────────────────────────────────────────────────────────────
    async function json(url, init) {
      const res = await fetch(url, { credentials: 'same-origin', ...init })
      const text = await res.text()
      let body = null
      try { body = text ? JSON.parse(text) : null } catch { body = { raw: text } }
      if (!res.ok) throw new Error(`${url} → ${res.status} ${text.slice(0, 120)}`)
      return body
    }

    /** OFM 的 payload 可能是数组也可能是 {combos:[…]}。 */
    function combosOf(payload) {
      if (Array.isArray(payload)) return payload
      if (Array.isArray(payload?.combos)) return payload.combos
      return []
    }

    /** 拿到 channel-pack 的 RPC 传输（与 OFM 设置页同一手法）。 */
    function readRpc(ctx) {
      let connection
      try { connection = ctx?.connection } catch { /* not provided */ }
      if (connection === undefined || connection === null) {
        try { connection = ctx?.get?.('connection') } catch { /* not provided */ }
      }
      try {
        const call = connection?.rpc?.call
        return typeof call === 'function' ? { connection, call } : null
      } catch { return null }
    }

    async function callRpc(transport, method, payload, timeoutMs = 20000) {
      if (!transport) throw new Error('no-connection')
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const result = await transport.call.call(transport.connection.rpc, '/api', 'channel-pack', { method, payload }, controller.signal)
        if (result?.ok === true) return result.value
        if (result?.ok === false) throw new Error(result.error?.message ?? result.error?.code ?? 'rpc-failed')
        return result
      } finally { clearTimeout(timer) }
    }

    /**
     * 读「平台 × 模型」网格。
     * 返回 accounts: [{id, provider, nickname, enabled, models:[modelId…]}]。
     */
    async function readGrid(transport) {
      const { statuses } = await callRpc(transport, 'provider.status', { providers: PROVIDERS })
      const rows = Object.entries(statuses ?? {})
      const accounts = []
      const models = []
      const platforms = []
      for (const [provider, st] of rows) {
        const total = st?.accounts?.total ?? 0
        const modelTotal = st?.models?.total ?? 0
        if (total === 0 && modelTotal === 0) continue
        let providerModels = []
        try {
          const value = await callRpc(transport, 'model.list', { provider })
          providerModels = Array.isArray(value?.models) ? value.models : []
        } catch { /* 模型清单读不到就留空：host 会按 unverified 处理 */ }
        for (const m of providerModels) models.push({ id: m.id, provider, name: m.name ?? m.id, disabled: m.disabled === true })
        let list = []
        if (total > 0) {
          try {
            const value = await callRpc(transport, 'account.list', { provider })
            list = Array.isArray(value?.accounts) ? value.accounts : []
          } catch { list = [] }
        }
        for (const a of list) {
          accounts.push({
            id: a.id, provider, nickname: a.nickname ?? a.id, enabled: a.enabled !== false,
            models: providerModels.map(m => m.id),
          })
        }
        platforms.push({
          provider, accounts: total, models: modelTotal,
          enabled: st?.accounts?.enabled ?? 0, closed: st?.closed === true,
        })
      }
      return { accounts, models, platforms }
    }

    /**
     * 聚合渠道（自带 API key 的 provider，例如硅基流动）：来自 OFM 的 `/providers`。
     * 这些平台不在 channel-pack 的账号池里，`provider.status` 永远看不到，所以单独读一次。
     * 模型表从 catalog 行里按 `<providerId>/` 前缀切出来，账号用合成 id `aggregate:<pid>`。
     */
    async function readAggregate(catalog) {
      const out = { accounts: [], models: [], platforms: [] }
      let payload = null
      try { payload = await json(`${OFM}/providers`) } catch { return out }
      const section = payload?.configured ?? {}
      const configured = section?.providers ?? {}
      const registry = payload?.registry
      const regRows = Array.isArray(registry) ? registry : Object.values(registry ?? {})
      const label = new Map()
      const registryModels = new Map()
      for (const row of regRows) {
        if (!row?.id) continue
        label.set(row.id, row.name ?? row.id)
        const ids = (Array.isArray(row.models) ? row.models : []).map((m) => m?.id).filter(Boolean)
        registryModels.set(row.id, ids)
      }

      // catalog 里 channel==='aggregate' 的行才是聚合渠道；
      // 按 id 的第一段（providerId）分组，这样模型 id 自带斜杠也不会分错。
      const byProvider = new Map()
      for (const m of Array.isArray(catalog) ? catalog : []) {
        if (m?.channel !== 'aggregate' || typeof m.id !== 'string') continue
        const pid = m.id.slice(0, m.id.indexOf('/'))
        if (!pid) continue
        const arr = byProvider.get(pid) ?? []
        arr.push(m)
        byProvider.set(pid, arr)
      }
      // 没进 catalog 的已配置平台：先用 registry 的静态模型表兜底，
      // 这样「刚接入、还没探测完」的平台也能立刻出现在顺序表里。
      for (const [pid, cfg] of Object.entries(configured)) {
        if (!pid || byProvider.has(pid)) continue
        if (cfg?.enabled === false) continue
        const ids = registryModels.get(pid) ?? []
        byProvider.set(pid, ids.map((mid) => ({ id: `${pid}/${mid}`, name: mid, channel: 'aggregate' })))
      }

      for (const [pid, rows] of byProvider) {
        const cfg = configured[pid] ?? null
        const enabled = section?.enabled !== false && cfg?.enabled !== false
        for (const m of rows) out.models.push({ id: m.id, provider: pid, name: m.name ?? m.id })
        // 没有模型清单时不要合成账号：否则每个档都会变成 unverified 候选。
        if (rows.length > 0) {
          out.accounts.push({
            id: `aggregate:${pid}`,
            provider: pid,
            nickname: label.get(pid) ?? pid,
            enabled,
            models: rows.map((m) => m.id),
            kind: 'aggregate',
          })
        }
        out.platforms.push({
          provider: pid,
          label: label.get(pid) ?? pid,
          accounts: rows.length > 0 ? 1 : 0,
          models: rows.length,
          enabled: enabled ? 1 : 0,
          closed: false,
          kind: 'aggregate',
        })
      }
      return out
    }

    /** 合并两个模型表（按 id 去重），保留 catalog 里的通道前缀行（如 subscription:magpie/…）。 */
    function mergeModels(...lists) {
      const seen = new Set()
      const out = []
      for (const list of lists) {
        for (const row of Array.isArray(list) ? list : []) {
          const id = typeof row === 'string' ? row : row?.id
          if (!id || seen.has(id)) continue
          seen.add(id)
          out.push(typeof row === 'string' ? { id } : row)
        }
      }
      return out
    }

    /** 一轮完整同步：读 → 交快照 → 取待写 → 写 → 回报。 */
    async function syncOnce(report, transport) {
      const step = (name, state) => report?.({ step: name, state, at: Date.now() })
      try {
        step('read', 'running')
        const combosPayload = await json(`${OFM}/combos`).catch(() => null)
        const combos = combosOf(combosPayload)
        const catalog = Array.isArray(combosPayload?.models) ? combosPayload.models : []

        let accounts = []
        let grid = { accounts: [], models: [], platforms: [] }
        if (transport) {
          try {
            grid = await readGrid(transport)
            accounts = grid.accounts
          } catch (error) {
            step('read', `RPC 失败：${String(error?.message ?? error).slice(0, 80)}`)
          }
        }
        // 聚合渠道（硅基流动等自带 key 的平台）不在账号池里，单独并进来。
        try {
          const agg = await readAggregate(catalog)
          if (agg.accounts.length > 0) {
            grid = {
              accounts: [...grid.accounts, ...agg.accounts],
              models: [...grid.models, ...agg.models],
              platforms: [...grid.platforms, ...agg.platforms],
            }
            accounts = grid.accounts
          }
        } catch { /* 聚合渠道读不到不影响主流程 */ }
        if (accounts.length === 0) {
          // 退化路径 1：OFM 的 /subscriptions（订阅型账号；channel-pack 账号读不到时用它兜底）
          const subs = await json(`${OFM}/subscriptions`).catch(() => null)
          const list = Array.isArray(subs) ? subs : Array.isArray(subs?.accounts) ? subs.accounts : []
          accounts = list.map(a => ({ ...a, models: [] }))
        }
        if (accounts.length === 0) {
          // 退化路径 2：/summary 的 catalog[] 每个 entry 带 channel，可按平台聚合出模型表
          const summary = await json(`${OFM}/summary`).catch(() => null)
          const byChannel = new Map()
          for (const entry of summary?.catalog ?? []) {
            const channel = entry?.channel ?? 'unknown'
            const arr = byChannel.get(channel) ?? []
            arr.push(entry.id)
            byChannel.set(channel, arr)
          }
          for (const [channel, ids] of byChannel) {
            accounts.push({ id: `platform:${channel}`, provider: channel, nickname: channel, enabled: true, models: ids })
          }
          step('read', `退化：/summary 聚合出 ${accounts.length} 个平台`)
        }
        step('read', `ok（${combos.length} 链 / ${accounts.length} 账号 / ${grid.models.length} 模型）`)

        step('snapshot', 'running')
        await json(`${QT}/snapshot`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ combos, accounts, models: mergeModels(grid.models, catalog), platforms: grid.platforms, source: 'browser' }),
        })
        step('snapshot', 'ok')

        step('pending', 'running')
        const { pending } = await json(`${QT}/pending`)
        if (!pending?.combos?.length) { step('pending', '无待写内容'); return { written: 0 } }

        step('write', 'running')
        await json(`${OFM}/combos`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(pending.combos),
        })

        step('applied', 'running')
        const after = await json(`${OFM}/combos`).catch(() => null)
        // 核对：OFM 会静默剔除它 catalog 里没有的模型 id（官方通道路由要不要得到就看这里）
        const mainId = (pending.combos.find(c => /main/.test(String(c.id))) ?? pending.combos[0])?.id
        const wanted = (pending.combos.find(c => c.id === mainId)?.models) ?? []
        const stored = (after ? combosOf(after).find(c => c.id === mainId)?.models : null) ?? []
        const dropped = wanted.filter(m => !stored.includes(m))
        await json(`${QT}/applied`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ combos: after ? combosOf(after) : undefined, hash: String(pending.reason ?? ''), dropped, sent: pending.combos }),
        })
        step('applied', dropped.length ? `ok，但 OFM 剔除了 ${dropped.length} 个 id` : `ok（写回 ${pending.combos.length} 条链）`)
        return { written: pending.combos.length, dropped }
      } catch (error) {
        report?.({ step: 'error', state: String(error?.message ?? error), at: Date.now() })
        return { error: String(error?.message ?? error) }
      }
    }

    // ── UI ───────────────────────────────────────────────────────────────────
    const CSS = `
.qt-wrap{display:flex;flex-direction:column;gap:14px;padding:4px 0 24px;font-size:13px}
.qt-card{border:1px solid var(--border-color,#3334);border-radius:10px;padding:12px 14px}
.qt-card h4{margin:0 0 10px;font-size:13px;font-weight:600;opacity:.9}
.qt-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.qt-dim{opacity:.6}
.qt-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.qt-badge{display:inline-block;padding:1px 6px;border-radius:999px;border:1px solid currentColor;font-size:11px;line-height:1.6}
.qt-ok{color:#3fb950}.qt-warn{color:#d29922}.qt-bad{color:#f85149}
.qt-chain{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none}
.qt-chain li{display:flex;gap:8px;align-items:center;padding:3px 6px;border-radius:6px;background:var(--hover-bg,#8881)}
.qt-btn{border:1px solid var(--border-color,#3334);background:transparent;color:inherit;border-radius:7px;padding:3px 9px;cursor:pointer;font-size:12px}
.qt-btn:hover{background:var(--hover-bg,#8881)}
.qt-btn:disabled{opacity:.45;cursor:default}
.qt-item{display:flex;gap:8px;align-items:center;padding:3px 6px;border-radius:6px;background:var(--hover-bg,#8881)}
.qt-item.off{opacity:.45}
.qt-item.qt-stale{background:transparent;border:1px dashed var(--border-color,#3336)}
.qt-btn.qt-danger{color:#f85149;border-color:#f8514966}
.qt-grow{flex:1}
.qt-alias{flex:1;min-width:150px;background:transparent;color:inherit;border:1px solid var(--border-color,#3334);border-radius:6px;padding:2px 6px;font-size:12px}
.qt-select{max-width:320px;background:transparent;color:inherit;border:1px solid var(--border-color,#3334);border-radius:6px;padding:2px 6px;font-size:12px}
.qt-num{width:64px;background:transparent;color:inherit;border:1px solid var(--border-color,#3334);border-radius:6px;padding:2px 6px;font-size:12px}
.qt-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:8px}
`

    function move(arr, i, delta) {
      const j = i + delta
      if (j < 0 || j >= arr.length) return arr
      const next = arr.slice()
      const [x] = next.splice(i, 1)
      next.splice(j, 0, x)
      return next
    }

    function Section({ ctx, props }) {
      const [status, setStatus] = useState(null)
      const [hostOk, setHostOk] = useState(true)
      const [newModel, setNewModel] = useState('')
      const [state, setState] = useState(null)
      const [log, setLog] = useState([])
      const [busy, setBusy] = useState(false)
      const [order, setOrder] = useState([])
      const [tiers, setTiers] = useState([])
      const [offPlatforms, setOff] = useState([])
      const [hidden, setHidden] = useState([])
      const [rhythm, setRhythm] = useState({})
      const [dirty, setDirty] = useState(false)
      const timer = useRef(0)
      const alive = useRef(true)
      const transportRef = useRef(null)
      // 自动隐藏「0 账号」渠道时记一笔：避免同一轮反复 POST，也避免用户点 ↺ 放回后又被立刻藏起来
      const zeroHiddenRef = useRef(new Set())

      const report = useCallback((entry) => {
        if (!alive.current) return
        setLog(prev => [entry, ...prev].slice(0, 10))
      }, [])

      const refresh = useCallback(async () => {
        try {
          const [s, st] = await Promise.all([json(`${QT}/status`), json(`${QT}/state`)])
          if (alive.current) setHostOk(true)
          if (!alive.current) return
          setStatus(s); setState(st)
          if (!dirty) {
            const cfg = s?.config ?? {}
            setOrder(Array.isArray(cfg.platformOrder) ? cfg.platformOrder : [])
            setTiers(Array.isArray(cfg.modelTiers) ? cfg.modelTiers : [])
            setOff(Array.isArray(cfg?.platformPolicy?.excludePlatforms) ? cfg.platformPolicy.excludePlatforms : [])
            setHidden(Array.isArray(cfg?.platformPolicy?.hiddenPlatforms) ? cfg.platformPolicy.hiddenPlatforms : [])
            setRhythm({
              quotaMs: Math.round((cfg?.cooldown?.quotaMs ?? 120000) / 60000),
              rateLimitMs: Math.round((cfg?.cooldown?.rateLimitMs ?? 60000) / 1000),
              authMs: Math.round((cfg?.cooldown?.authMs ?? 600000) / 60000),
              retryAfterMinutes: cfg?.finalResort?.retryAfterMinutes ?? 10,
              maxPerSession: cfg?.resume?.maxPerSession ?? 8,
              maxPerHour: cfg?.resume?.maxPerHour ?? 24,
              minIntervalMs: Math.round((cfg?.resume?.minIntervalMs ?? 3000) / 1000),
              freshnessMinutes: cfg?.quota?.freshnessMinutes ?? 15,
              officialOn: cfg?.finalResort?.official?.enabled !== false,
              officialProvider: cfg?.finalResort?.official?.provider ?? 'deepseek-account',
              officialModels: (cfg?.finalResort?.official?.models ?? ['deepseek-flash']).join(', '),
              fallbackModels: (cfg?.finalResort?.fallbackModels ?? []).join(', '),
              autoPrune: cfg?.platformPolicy?.pruneMissing !== false,
              pruneAfter: cfg?.platformPolicy?.pruneAfterMisses ?? 3,
              autoHideZero: cfg?.platformPolicy?.pruneZeroAccounts !== false,
            })
          }
        } catch { if (alive.current) setHostOk(false) }
      }, [dirty])

      const runSync = useCallback(async () => {
        setBusy(true)
        try {
          if (!transportRef.current) transportRef.current = readRpc(ctx)
          await syncOnce(report, transportRef.current)
        } finally { setBusy(false); void refresh() }
      }, [report, refresh, ctx])

      useEffect(() => {
        alive.current = true
        transportRef.current = readRpc(ctx)
        void refresh(); void runSync()
        timer.current = window.setInterval(() => { void runSync() }, SYNC_MS)
        return () => { alive.current = false; window.clearInterval(timer.current) }
      }, [refresh, runSync, ctx])

      // 发现到的平台（RPC 快照）∪ 配置里的顺序
      const discovered = state?.platforms ?? state?.bridge?.platforms ?? []
      const platformIds = useMemo(() => {
        const seen = new Set([...order, ...discovered.map(p => p.provider)])
        for (const a of state?.accounts ?? []) seen.add(a.provider)
        for (const p of PROVIDERS) if (discovered.some(d => d.provider === p)) seen.add(p)
        for (const id of hidden) seen.delete(id)
        return [...seen]
      }, [order, discovered, state, hidden])

      // 「恢复」：把删掉的平台从 hiddenPlatforms 里放出来
      const restore = useCallback(async (id) => {
        setHidden(v => v.filter(x => x !== id))
        setOff(v => v.filter(x => x !== id))
        zeroHiddenRef.current.add(id)   // 用户明确要它，别再自动藏
        try {
          const s = await json(`${QT}/status`)
          const cfg = s?.config ?? {}
          await json(`${QT}/config`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              platformPolicy: {
                ...(cfg?.platformPolicy ?? {}),
                hiddenPlatforms: (cfg?.platformPolicy?.hiddenPlatforms ?? []).filter(x => x !== id),
                excludePlatforms: (cfg?.platformPolicy?.excludePlatforms ?? []).filter(x => x !== id),
              },
            }),
          })
          report({ step: 'restore', state: `已恢复平台 ${id}` })
        } catch (error) {
          report({ step: 'restore', state: String(error?.message ?? error).slice(0, 90) })
        }
        void refresh()
      }, [refresh, report])

      const platformInfo = (id) => {
        const row = discovered.find(d => d.provider === id)
        if (row) return row
        // 不在 channel-pack 平台表里、但账号表里有（例：host 从 catalog 自动发现的
        // 「Magpie（硅基流动等）」）——用账号数据现算一份，别显示「未探测」。
        const mine = (state?.accounts ?? []).filter(a => a.provider === id)
        if (mine.length === 0) return null
        const modelSet = new Set()
        for (const a of mine) for (const m of a.models ?? []) modelSet.add(typeof m === 'string' ? m : m?.id)
        return {
          provider: id,
          accounts: mine.length,
          models: modelSet.size,
          enabled: mine.filter(a => a.enabled !== false).length,
          closed: false,
          label: mine[0]?.nickname,
          kind: mine[0]?.kind ?? 'account',
        }
      }
      const platformLabel = (id) => {
        if (PROVIDER_LABEL[id]) return PROVIDER_LABEL[id]
        const row = platformInfo(id)
        if (row?.label) return row.label
        const acc = (state?.accounts ?? []).find(a => a.provider === id)
        return acc?.nickname ?? id
      }

      // 「这轮真的读到了」的平台：平台表 ∪ 账号表。不在里面的就是已失效（撤掉的渠道）。
      const observedSet = useMemo(() => {
        const set = new Set()
        for (const p of discovered) if (p?.provider) set.add(p.provider)
        for (const a of state?.accounts ?? []) if (a?.provider) set.add(a.provider)
        return set
      }, [discovered, state])
      const healthMap = state?.platformHealth ?? {}

      /**
       * 0 账号的空渠道：客户端侧先自动藏起来。
       *
       * 为什么放在浏览器半身做：host 侧的 prune 规则要重启才生效，而这里是
       * 「读到了 platforms[] 就能判断」的事 —— 由页面直接下发一次 /config，
       * 用户刷新即可，不必为了一个空渠道重启 harness。
       * 同时写 excludePlatforms，旧版宿主的接力链也会立刻跳过它。
       */
      useEffect(() => {
        if (rhythm.autoHideZero === false) return
        // 反向：之前因为 0 账号被自动藏起来的，现在有账号了 → 放回来
        const revived = hidden.filter((id) => {
          if (zeroHiddenRef.current.has(id)) return false
          const row = (state?.platforms ?? []).find(p => p?.provider === id)
          const auto = healthMap[id]?.autoHidden === true
          return auto && (Number(row?.accounts) || 0) > 0
        })
        if (revived.length > 0) {
          for (const id of revived) zeroHiddenRef.current.add(id)
          ;(async () => {
            try {
              const s = await json(`${QT}/status`)
              const live = s?.config ?? {}
              const pol = live?.platformPolicy ?? {}
              await json(`${QT}/config`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  platformPolicy: {
                    ...pol,
                    excludePlatforms: (pol.excludePlatforms ?? []).filter(x => !revived.includes(x)),
                    hiddenPlatforms: (pol.hiddenPlatforms ?? []).filter(x => !revived.includes(x)),
                  },
                }),
              })
              report({ step: 'auto-restore', state: `已有账号，自动放回：${revived.join(', ')}` })
            } catch (error) {
              report({ step: 'auto-restore', state: String(error?.message ?? error).slice(0, 90) })
            }
            void refresh()
          })()
        }
        const zeros = (state?.platforms ?? [])
          .filter(p => p?.provider && (Number(p.accounts) || 0) === 0)
          .filter(p => !hidden.includes(p.provider) && !zeroHiddenRef.current.has(p.provider))
        if (zeros.length === 0) return
        const ids = zeros.map(p => p.provider)
        for (const id of ids) zeroHiddenRef.current.add(id)
        ;(async () => {
          try {
            const s = await json(`${QT}/status`)
            const live = s?.config ?? {}
            const pol = live?.platformPolicy ?? {}
            await json(`${QT}/config`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                platformOrder: (live.platformOrder ?? []).filter(x => !ids.includes(x)),
                platformPolicy: {
                  ...pol,
                  excludePlatforms: [...new Set([...(pol.excludePlatforms ?? []), ...ids])],
                  hiddenPlatforms: [...new Set([...(pol.hiddenPlatforms ?? []), ...ids])],
                },
              }),
            })
            report({ step: 'auto-hide', state: `0 账号，自动隐藏：${ids.join(', ')}` })
          } catch (error) {
            report({ step: 'auto-hide', state: String(error?.message ?? error).slice(0, 90) })
          }
          void refresh()
        })()
      }, [state, hidden, rhythm.autoHideZero, refresh, report])

      /**
       * 手动删除一个平台。
       *
       * 走的是通用的 `/config`（而不是 `/platforms/forget`），原因很实际：
       * `/config` 在任何版本里都有，而新增端点只有重启后的宿主才有 —— 走它就不必
       * 让用户为了删一个平台去重启一次 harness。
       * 三处一起写：从顺序里去掉、写进 hiddenPlatforms（不再显示）、同时写进
       * excludePlatforms（旧版宿主只认这个字段，接力链也会立刻停止用它）。
       */
      const forget = useCallback(async (id) => {
        setOrder(v => v.filter(x => x !== id))
        setOff(v => v.filter(x => x !== id))
        setHidden(v => (v.includes(id) ? v : [...v, id]))
        try {
          const s = await json(`${QT}/status`)
          const live = s?.config ?? {}
          const pol = live?.platformPolicy ?? {}
          await json(`${QT}/config`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              platformOrder: (live.platformOrder ?? []).filter(x => x !== id),
              platformPolicy: {
                ...pol,
                excludePlatforms: [...new Set([...(pol.excludePlatforms ?? []), id])],
                hiddenPlatforms: [...new Set([...(pol.hiddenPlatforms ?? []), id])],
              },
            }),
          })
          report({ step: 'forget', state: `已删除平台 ${id}（底部「已删除」可放回）` })
        } catch (error) {
          report({ step: 'forget', state: String(error?.message ?? error).slice(0, 90) })
        }
        void refresh()
      }, [refresh, report])

      // 「平台 → 模型清单」：优先用 /state 的 models[]（RPC 读到的真实清单），
      // 读不到时退回账号自带 models。
      const platformsWithModels = useMemo(() => {
        const byProvider = new Map()
        for (const m of state?.models ?? []) {
          const id = m?.id ?? m
          if (!id) continue
          const provider = m?.provider ?? 'unknown'
          const arr = byProvider.get(provider) ?? []
          arr.push(String(id))
          byProvider.set(provider, arr)
        }
        if (byProvider.size === 0) {
          for (const a of state?.accounts ?? []) {
            const arr = byProvider.get(a.provider) ?? []
            for (const id of a.models ?? []) if (!arr.includes(id)) arr.push(String(id))
            byProvider.set(a.provider, arr)
          }
        }
        return [...byProvider.entries()]
          .filter(([, models]) => models.length > 0)
          .map(([provider, models]) => ({ provider, models: [...new Set(models)].sort() }))
      }, [state])

      const plan = status?.plan ?? {}
      const bridge = status?.bridge ?? {}
      const cfg = status?.config ?? {}
      const chain = Array.isArray(plan.chain) ? plan.chain : []
      const excluded = Array.isArray(plan.excluded) ? plan.excluded : []
      const quotaFresh = bridge.fresh === true

      const save = async (patch) => {
        setBusy(true)
        try {
          await json(`${QT}/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
          setDirty(false)
          await runSync()
        } catch (error) { report({ step: 'config', state: String(error?.message ?? error) }) }
        finally { setBusy(false); void refresh() }
      }

      const saveAll = () => save({
        platformOrder: order,
        modelTiers: tiers,
        platformPolicy: {
          excludePlatforms: offPlatforms,
          hiddenPlatforms: hidden,
          pruneMissing: rhythm.autoPrune !== false,
          pruneZeroAccounts: rhythm.autoHideZero !== false,
          pruneAfterMisses: Number(rhythm.pruneAfter) || 3,
        },
        cooldown: { quotaMs: rhythm.quotaMs * 60000, rateLimitMs: rhythm.rateLimitMs * 1000, authMs: rhythm.authMs * 60000 },
        finalResort: {
          retryAfterMinutes: rhythm.retryAfterMinutes,
          fallbackModels: String(rhythm.fallbackModels ?? '').split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean),
          official: {
            enabled: rhythm.officialOn !== false,
            provider: String(rhythm.officialProvider ?? 'deepseek-account').trim() || 'deepseek-account',
            models: String(rhythm.officialModels ?? '').split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean),
          },
        },
        resume: { maxPerSession: rhythm.maxPerSession, maxPerHour: rhythm.maxPerHour, minIntervalMs: rhythm.minIntervalMs * 1000 },
        quota: { freshnessMinutes: rhythm.freshnessMinutes },
      })

      const num = (key, unit) => h('input', {
        className: 'qt-num', type: 'number', min: 0, value: rhythm[key] ?? 0,
        onChange: (e) => { setRhythm(r => ({ ...r, [key]: Number(e.target.value) })); setDirty(true) },
      })

      return h('div', { className: 'qt-wrap' },
        h('style', null, CSS),

        hostOk ? null : h('div', { className: 'qt-card', style: { borderColor: '#f85149' } },
          h('h4', { style: { color: '#f85149' } }, '宿主半身没有加载'),
          h('div', null, '页面只加载了浏览器半身，`/api/quota-takeover/*` 全部 404 —— 说明插件 host 代码是旧的或没装。'),
          h('div', { className: 'qt-dim', style: { marginTop: 6 } },
            '解决：完全退出 DeepSeek Harness 再重新打开（host 代码只在进程启动时执行一次），然后刷新本页。'),
        ),

        // 概览
        h('div', { className: 'qt-card' },
          h('h4', null, '额度接力（Quota Takeover）'),
          h('div', { className: 'qt-row' },
            h('span', { className: `qt-badge ${quotaFresh ? 'qt-ok' : 'qt-warn'}` },
              quotaFresh ? '快照新鲜' : (bridge.hasSnapshot ? `快照 ${Math.round((bridge.snapshotAgeMs ?? 0) / 1000)}s 前` : '尚无快照')),
            h('span', { className: 'qt-badge' }, `平台 ${platformIds.length}`),
            h('span', { className: 'qt-badge' }, `账号 ${state?.accounts?.length ?? 0}`),
            h('span', { className: 'qt-badge' }, `模型 ${Array.isArray(state?.models) ? state.models.length : 0}`),
            h('span', { className: 'qt-badge' }, `候选 ${chain.length}`),
            h('span', { className: 'qt-badge' }, `排除 ${excluded.length}`),
            plan.waiting ? h('span', { className: 'qt-badge qt-warn' }, '等待额度恢复') : null,
            h('span', { className: 'qt-grow' }),
            h('button', { className: 'qt-btn', disabled: busy, onClick: runSync }, '立即同步'),
            h('button', { className: 'qt-btn', disabled: busy || !dirty, onClick: saveAll }, dirty ? '保存并重编译' : '已保存'),
          ),
          plan.at ? h('div', { className: 'qt-dim', style: { marginTop: 6 } },
            `上次编译 ${new Date(plan.at).toLocaleTimeString()} · 原因 ${plan.reason ?? '-'} · 顺序 ${cfg?.traversal?.order ?? '-'}`) : null,
        ),

        // 平台顺序
        h('div', { className: 'qt-card' },
          h('h4', null, '平台顺序（额度不够时按这个顺序往下找）'),
          h('div', { className: 'qt-row', style: { marginBottom: 8 } },
            h('label', { className: 'qt-dim' },
              h('input', {
                type: 'checkbox',
                checked: rhythm.autoPrune !== false,
                onChange: (e) => { setRhythm(r => ({ ...r, autoPrune: e.target.checked })); setDirty(true) },
              }),
              ' 自动删除读不到的渠道',
            ),
            h('span', { className: 'qt-dim' }, '连续缺席'),
            h('input', {
              className: 'qt-num', type: 'number', min: 1, max: 20,
              value: rhythm.pruneAfter ?? 3,
              onChange: (e) => { setRhythm(r => ({ ...r, pruneAfter: Number(e.target.value) })); setDirty(true) },
            }),
            h('span', { className: 'qt-dim' }, '次后清掉（默认 3，防止一次探测失败就误删）'),
            h('span', { className: 'qt-grow' }),
            h('span', { className: 'qt-dim' }, '也可以点每行的「删除」手动清'),
          ),
          h('div', { className: 'qt-row', style: { marginBottom: 8 } },
            h('label', { className: 'qt-dim' },
              h('input', {
                type: 'checkbox',
                checked: rhythm.autoHideZero !== false,
                onChange: (e) => { setRhythm(r => ({ ...r, autoHideZero: e.target.checked })); setDirty(true) },
              }),
              ' 0 账号的空渠道自动隐藏',
            ),
            h('span', { className: 'qt-dim' }, '（比如账号全撤掉的 Qoder / Cline；给它加了账号后会自动放回来）'),
          ),
          platformIds.length === 0
            ? h('div', { className: 'qt-dim' }, '还没读到平台 —— 检查 OFM 的渠道账号是否启用。')
            : h('div', { className: 'qt-chain' },
              platformIds.map((id, i) => {
                const info = platformInfo(id)
                const off = offPlatforms.includes(id)
                const stale = !observedSet.has(id)
                const miss = healthMap[id]?.missingSyncs ?? 0
                return h('div', { key: id, className: `qt-item${off ? ' off' : ''}${stale ? ' qt-stale' : ''}` },
                  h('span', { className: 'qt-dim qt-mono' }, String(i + 1).padStart(2, '0')),
                  h('span', { style: { minWidth: 82 } }, platformLabel(id),
                  stale
                    ? h('span', { className: 'qt-badge qt-warn' }, miss > 0 ? `已失效 · 连缺 ${miss} 次` : '本轮未读到')
                    : (info ? h('span', { className: 'qt-dim' }, `${info.accounts} 账号 / ${info.models} 模型`) : h('span', { className: 'qt-dim' }, '未探测')),
                  !stale && info?.closed ? h('span', { className: 'qt-badge qt-warn' }, '全部模型关闭') : null,
                  ),
                  h('span', { className: 'qt-grow' }),
                  // 每行都有删除按钮（用户要求「我可以手动删除」）：不必等它变失效
                  h('button', {
                    className: 'qt-btn qt-danger',
                    title: '从这个列表里删掉这个平台（同时清掉它的跳过标记与缺席记录）',
                    onClick: () => { void forget(id) },
                  }, '删除'),
                  h('button', { className: 'qt-btn', onClick: () => { setOrder(move(platformIds, i, -1)); setDirty(true) } }, '↑'),
                  h('button', { className: 'qt-btn', onClick: () => { setOrder(move(platformIds, i, 1)); setDirty(true) } }, '↓'),
                  h('button', {
                    className: 'qt-btn',
                    onClick: () => { setOff(v => v.includes(id) ? v.filter(x => x !== id) : [...v, id]); setDirty(true) },
                  }, off ? '启用' : '跳过'),
                )
              })),
          (hidden ?? []).length > 0
            ? h('div', { className: 'qt-row', style: { marginTop: 8 } },
              h('span', { className: 'qt-dim' }, `已隐藏 ${hidden.length} 个：`),
              ...hidden.map(id => h('button', {
                key: id, className: 'qt-btn', title: '放回平台顺序',
                onClick: () => { void restore(id) },
              }, `${platformLabel(id)} ↺`)),
              h('span', { className: 'qt-dim' }, '（隐藏的渠道不显示、也不参与接力；点 ↺ 可放回）'),
            )
            : null,
        ),

        // 模型档顺序
        h('div', { className: 'qt-card' },
          h('h4', null, '模型档顺序（平台都没有上一档时才往下换）'),
          h('div', { className: 'qt-dim', style: { marginBottom: 8 } },
            '一「档」= 一个抽象模型名；下面的别名是各平台对它的叫法（逗号分隔）。换档时仍会遍历所有平台。'),
          h('div', { className: 'qt-chain' },
            (tiers ?? []).map((t, i) => h('div', { key: t.id ?? i, className: 'qt-item' },
              h('span', { className: 'qt-dim qt-mono' }, String(i + 1).padStart(2, '0')),
              h('span', { style: { minWidth: 96 } }, t.label ?? t.id),
              t.pinned ? h('span', { className: 'qt-badge qt-ok' }, '钉住') : null,
              h('input', {
                className: 'qt-alias',
                value: (t.aliases ?? []).join(', '),
                placeholder: '模型别名，逗号分隔',
                onChange: (e) => {
                  const aliases = e.target.value.split(/[,，、\s]+/).map(x => x.trim()).filter(Boolean)
                  setTiers(tiers.map((x, k) => k === i ? { ...x, aliases } : x)); setDirty(true)
                },
              }),
              h('button', { className: 'qt-btn', onClick: () => { setTiers(move(tiers, i, -1)); setDirty(true) } }, '↑'),
              h('button', { className: 'qt-btn', onClick: () => { setTiers(move(tiers, i, 1)); setDirty(true) } }, '↓'),
              h('button', {
                className: 'qt-btn',
                onClick: () => { setTiers(tiers.map((x, k) => k === i ? { ...x, pinned: !x.pinned } : x)); setDirty(true) },
              }, t.pinned ? '取消钉住' : '钉住'),
              h('button', { className: 'qt-btn', onClick: () => { setTiers(tiers.filter((_, k) => k !== i)); setDirty(true) } }, '删除'),
            )),
          ),
          h('div', { className: 'qt-row', style: { marginTop: 10 } },
            h('select', {
              className: 'qt-select',
              value: newModel,
              onChange: (e) => setNewModel(e.target.value),
            },
              h('option', { value: '' }, '从已发现的模型里选一个…'),
              platformsWithModels.map(pm => h('optgroup', { key: pm.provider, label: `${platformLabel(pm.provider)}（${pm.models.length}）` },
                pm.models.map(m => h('option', { key: m, value: m }, m)),
              )),
            ),
            h('button', {
              className: 'qt-btn',
              disabled: !newModel,
              onClick: () => {
                const id = `tier:${newModel.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()}`
                if (tiers.some(t => t.id === id)) return
                setTiers([...tiers, { id, label: newModel, pinned: false, aliases: [newModel] }])
                setNewModel(''); setDirty(true)
              },
            }, '添加档位'),
            h('span', { className: 'qt-dim' }, `共 ${Array.isArray(state?.models) ? state.models.length : 0} 个模型 / ${platformsWithModels.length} 个平台`),
          ),
          h('div', { className: 'qt-dim', style: { marginTop: 8 } },
            '档位的别名只影响「哪些平台的模型算作同一档」；平台本身的顺序在上面的卡片里调。'),
        ),

        // 已发现的模型（点一下就能加成档位）
        h('details', { className: 'qt-card' },
          h('summary', { style: { cursor: 'pointer', fontWeight: 600 } },
            `已发现的模型（${platformsWithModels.reduce((n, p) => n + p.models.length, 0)} 个，点模型名可加档位）`),
          h('div', { style: { marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 } },
            platformsWithModels.length === 0
              ? h('div', { className: 'qt-dim' }, '还没有模型清单 —— 先点「立即同步」。')
              : platformsWithModels.map(pm => h('div', { key: pm.provider },
                h('div', { className: 'qt-dim', style: { marginBottom: 4 } },
                  `${platformLabel(pm.provider)} · ${pm.models.length} 个`),
                h('div', { className: 'qt-row' },
                  pm.models.map(m => h('button', {
                    key: m,
                    className: 'qt-btn',
                    title: '加成一档',
                    onClick: () => {
                      const id = `tier:${m.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()}`
                      if (tiers.some(t => t.id === id)) return
                      setTiers([...tiers, { id, label: m, pinned: false, aliases: [m] }])
                      setDirty(true)
                    },
                  }, m)),
                ),
              )),
          ),
        ),
        // 重试节奏
        h('div', { className: 'qt-card' },
          h('h4', null, '重试节奏'),
          h('div', { className: 'qt-grid' },
            h('label', { className: 'qt-row' }, '额度冷却（分钟）', num('quotaMs')),
            h('label', { className: 'qt-row' }, '限流冷却（秒）', num('rateLimitMs')),
            h('label', { className: 'qt-row' }, '鉴权冷却（分钟）', num('authMs')),
            h('label', { className: 'qt-row' }, '全耗尽后重试间隔（分钟）', num('retryAfterMinutes')),
            h('label', { className: 'qt-row' }, '每会话最多续跑', num('maxPerSession')),
            h('label', { className: 'qt-row' }, '每小时最多续跑', num('maxPerHour')),
            h('label', { className: 'qt-row' }, '两次续跑最小间隔（秒）', num('minIntervalMs')),
            h('label', { className: 'qt-row' }, '额度读数保鲜（分钟）', num('freshnessMinutes')),
          ),
          h('div', { className: 'qt-dim', style: { marginTop: 8 } },
            '「额度冷却」= 撞到额度墙后这个「账号×模型」多久不再尝试；改完点上面的「保存并重编译」。'),
        ),

        // 接力链
        h('div', { className: 'qt-card' },
          h('h4', null, '接力链（按顺序尝试）'),
          chain.length === 0
            ? h('div', { className: 'qt-dim' }, plan.waiting ? '档位×平台全部不可用，等待恢复中。' : '尚未生成候选 —— 先点「立即同步」。')
            : h('ol', { className: 'qt-chain' },
              chain.slice(0, 24).map((c, i) => h('li', { key: `${c.accountId ?? c.model}-${i}` },
                h('span', { className: 'qt-dim qt-mono' }, String(i + 1).padStart(2, '0')),
                h('span', { className: 'qt-badge' }, c.tier ?? '-'),
                h('span', { className: 'qt-mono' }, c.platform ?? '-'),
                h('span', { className: 'qt-mono' }, c.resolved ?? c.model ?? '-'),
                c.why === 'unverified' ? h('span', { className: 'qt-badge qt-warn' }, '未验证') : null,
                c.kind === 'fallback' ? h('span', { className: 'qt-badge qt-warn' }, '兜底') : null,
              )),
            ),
        ),

        // 终局兜底（含官方额度）
        h('div', { className: 'qt-card' },
          h('h4', null, '终局兜底'),
          h('div', { className: 'qt-dim', style: { marginBottom: 8 } },
            '平台 × 模型档全部耗尽后，按顺序用下面这些模型接着干活。官方额度是最后一道闸。'),
          h('div', { className: 'qt-row' },
            h('label', { className: 'qt-row', style: { gap: 6 } },
              h('input', {
                type: 'checkbox',
                checked: rhythm.officialOn !== false,
                onChange: (e) => { setRhythm(r => ({ ...r, officialOn: e.target.checked })); setDirty(true) },
              }),
              h('span', null, '官方额度兜底'),
            ),
            h('input', {
              className: 'qt-alias', value: rhythm.officialProvider ?? '', placeholder: 'provider',
              onChange: (e) => { setRhythm(r => ({ ...r, officialProvider: e.target.value })); setDirty(true) },
            }),
            h('input', {
              className: 'qt-alias', value: rhythm.officialModels ?? '', placeholder: '模型 id，逗号分隔',
              onChange: (e) => { setRhythm(r => ({ ...r, officialModels: e.target.value })); setDirty(true) },
            }),
          ),
          h('div', { className: 'qt-row', style: { marginTop: 8 } },
            h('span', { className: 'qt-dim' }, '聚合兜底模型'),
            h('input', {
              className: 'qt-alias', value: rhythm.fallbackModels ?? '', placeholder: '如 groq/llama-3.3-70b（可留空）',
              onChange: (e) => { setRhythm(r => ({ ...r, fallbackModels: e.target.value })); setDirty(true) },
            }),
          ),
          (plan.writeBack?.dropped?.length ?? 0) > 0
            ? h('div', { className: 'qt-warn', style: { marginTop: 8 } },
              `⚠ OFM 没接受这些兜底 id（已从链里剔除）：${plan.writeBack.dropped.join(', ')} —— 换一个它认识的模型 id。`)
            : null,
        ),

        // 被排除
        excluded.length > 0 && h('div', { className: 'qt-card' },
          h('h4', null, `被排除的格子（${excluded.length}）`),
          h('div', { className: 'qt-chain' },
            excluded.slice(0, 24).map((e, i) => h('div', { key: i, className: 'qt-row' },
              h('span', { className: 'qt-mono' }, `${e.platform ?? '-'} / ${e.tier ?? '-'}`),
              h('span', { className: `qt-badge ${e.why === 'missing' ? 'qt-dim' : 'qt-warn'}` },
                { missing: '无此模型', exhausted: '额度耗尽', cooling: '冷却中', server: '服务端' }[e.why] ?? e.why),
              h('span', { className: 'qt-dim' }, e.reason ?? ''),
            )),
          ),
        ),

        // 日志
        h('div', { className: 'qt-card' },
          h('h4', null, '同步日志'),
          log.length === 0 ? h('div', { className: 'qt-dim' }, '等待第一轮…')
            : h('div', { className: 'qt-chain' }, log.map((l, i) => h('div', { key: i, className: 'qt-mono qt-dim' },
              `${new Date(l.at).toLocaleTimeString()} ${l.step} · ${l.state}`))),
        ),
      )
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'quota-takeover',
        order: 36,
        label: () => '额度接力',
      }, props => h(Section, { ...props, ctx })))
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'quota-takeover'
    return module.exports
  },
})
