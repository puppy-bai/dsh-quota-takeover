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
          body: JSON.stringify({ combos, accounts, models: grid.models.length ? grid.models : catalog, platforms: grid.platforms, source: 'browser' }),
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
      const [rhythm, setRhythm] = useState({})
      const [dirty, setDirty] = useState(false)
      const timer = useRef(0)
      const alive = useRef(true)
      const transportRef = useRef(null)

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
        return [...seen]
      }, [order, discovered, state])

      const platformInfo = (id) => discovered.find(d => d.provider === id) ?? null

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
        platformPolicy: { excludePlatforms: offPlatforms },
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
          platformIds.length === 0
            ? h('div', { className: 'qt-dim' }, '还没读到平台 —— 检查 OFM 的渠道账号是否启用。')
            : h('div', { className: 'qt-chain' },
              platformIds.map((id, i) => {
                const info = platformInfo(id)
                const off = offPlatforms.includes(id)
                return h('div', { key: id, className: `qt-item${off ? ' off' : ''}` },
                  h('span', { className: 'qt-dim qt-mono' }, String(i + 1).padStart(2, '0')),
                  h('span', { style: { minWidth: 82 } }, PROVIDER_LABEL[id] ?? id),
                  info ? h('span', { className: 'qt-dim' }, `${info.accounts} 账号 / ${info.models} 模型`) : h('span', { className: 'qt-dim' }, '未探测'),
                  info?.closed ? h('span', { className: 'qt-badge qt-warn' }, '全部模型关闭') : null,
                  h('span', { className: 'qt-grow' }),
                  h('button', { className: 'qt-btn', onClick: () => { setOrder(move(platformIds, i, -1)); setDirty(true) } }, '↑'),
                  h('button', { className: 'qt-btn', onClick: () => { setOrder(move(platformIds, i, 1)); setDirty(true) } }, '↓'),
                  h('button', {
                    className: 'qt-btn',
                    onClick: () => { setOff(v => v.includes(id) ? v.filter(x => x !== id) : [...v, id]); setDirty(true) },
                  }, off ? '启用' : '跳过'),
                )
              })),
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
                  const aliases = e.target.value.split(/[,，、s]+/).map(x => x.trim()).filter(Boolean)
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
              platformsWithModels.map(pm => h('optgroup', { key: pm.provider, label: `${PROVIDER_LABEL[pm.provider] ?? pm.provider}（${pm.models.length}）` },
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
                  `${PROVIDER_LABEL[pm.provider] ?? pm.provider} · ${pm.models.length} 个`),
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
