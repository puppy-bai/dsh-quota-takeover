import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createCompiler } from '../src/compiler.js'
import { DEFAULT_CONFIG, mergeConfig } from '../src/config.js'

const FRESH = () => new Date().toISOString()

function makeCfg(patch = {}) {
  return mergeConfig(structuredClone(DEFAULT_CONFIG), {
    platformOrder: ['p1', 'p2', 'p3'],
    // 官方额度尾默认是开的（生产行为）；这组用例只测「平台 × 档」的编排，
    // 所以默认关掉，官方尾单独在文件末尾那条用例里测。
    finalResort: { official: { enabled: false } },
    modelTiers: [
      { id: 'm-big', label: '大模型', aliases: ['m-big'] },
      { id: 'm-small', label: '小模型', aliases: ['m-small'] },
    ],
    ...patch,
  })
}

function compilerWith(cfg, accounts, bench = {}) {
  const c = createCompiler({
    logger: { warn() {}, info() {}, debug() {} },
    cfg: () => cfg,
    ofm: {
      listSubscriptions: async () => ({ ok: true, accounts }),
      refreshQuota: async () => ({ ok: false }),
      listCombos: async () => ({ ok: false }),
      saveCombos: async () => ({ ok: false }),
    },
    bench: { get: () => bench, edit: () => bench, update: () => bench },
    stores: { plan: { update() {}, get: () => ({}) } },
    journal: () => {},
  })
  return c
}

test('tier-major: 档优先于平台，缺模型的平台被跳过（R2）', async () => {
  const accounts = [
    { id: 'a1', provider: 'p1', enabled: true, models: ['m-big'], quota: { status: 'ok', checkedAt: FRESH(), windows: [{ remainingPercent: 50 }] } },
    { id: 'a2', provider: 'p2', enabled: true, models: ['m-small'], quota: { status: 'ok', checkedAt: FRESH(), windows: [{ remainingPercent: 30 }] } },
    { id: 'a3', provider: 'p3', enabled: true, models: ['m-big'], quota: { status: 'ok', checkedAt: FRESH(), windows: [{ remainingPercent: 80 }] } },
  ]
  const cfg = makeCfg()
  const { chain, excluded } = compilerWith(cfg, accounts).buildChain(cfg, accounts, {})

  assert.deepEqual(chain.map((c) => `${c.platform}/${c.resolved}`), [
    'p1/m-big',   // 档1: p1 有
    'p3/m-big',   // 档1: p2 无(跳过) → p3 有
    'p2/m-small', // 档2: p1 无 → p2 有
  ])
  const missing = excluded.filter((e) => e.why === 'missing')
  assert.equal(missing.length, 3, '应为 3 个 missing（p2@档1, p1@档2, p3@档2）')
})

test('tier-major 与 platform-major 顺序不同', async () => {
  const accounts = [
    { id: 'a1', provider: 'p1', enabled: true, models: ['m-big', 'm-small'], quota: { status: 'ok', checkedAt: FRESH(), windows: [{ remainingPercent: 50 }] } },
    { id: 'a2', provider: 'p2', enabled: true, models: ['m-big', 'm-small'], quota: { status: 'ok', checkedAt: FRESH(), windows: [{ remainingPercent: 50 }] } },
  ]
  const tierMajor = makeCfg({ traversal: { order: 'tier-major' } })
  const platformMajor = makeCfg({ traversal: { order: 'platform-major' } })

  const a = compilerWith(tierMajor, accounts).buildChain(tierMajor, accounts, {}).chain
  const b = compilerWith(platformMajor, accounts).buildChain(platformMajor, accounts, {}).chain

  assert.deepEqual(a.map((c) => `${c.platform}/${c.resolved}`), ['p1/m-big', 'p2/m-big', 'p1/m-small', 'p2/m-small'])
  assert.deepEqual(b.map((c) => `${c.platform}/${c.resolved}`), ['p1/m-big', 'p1/m-small', 'p2/m-big', 'p2/m-small'])
})

test('额度耗尽的格子被排除，并记录 resetsAt 文案', async () => {
  const resetsAt = new Date(Date.now() + 3_600_000).toISOString()
  const accounts = [
    { id: 'a1', provider: 'p1', enabled: true, models: ['m-big'], quota: { status: 'ok', checkedAt: FRESH(), windows: [{ remainingPercent: 0, resetsAt }] } },
    { id: 'a2', provider: 'p2', enabled: true, models: ['m-big'], quota: { status: 'ok', checkedAt: FRESH(), windows: [{ remainingPercent: 40 }] } },
  ]
  const cfg = makeCfg()
  const { chain, excluded } = compilerWith(cfg, accounts).buildChain(cfg, accounts, {})

  assert.deepEqual(chain.map((c) => c.platform), ['p2'])
  const ex = excluded.find((e) => e.why === 'exhausted')
  assert.ok(ex, '应有 exhausted 记录')
  assert.match(ex.reason, /重置/)
})

test('冷却中的格子被跳过（cooling）', async () => {
  const accounts = [
    { id: 'a1', provider: 'p1', enabled: true, models: ['m-big'], quota: { status: 'ok', checkedAt: FRESH(), windows: [{ remainingPercent: 90 }] } },
  ]
  const cfg = makeCfg()
  const bench = { 'a1|m-big': { until: Date.now() + 60_000, reason: 'quota', level: 1 } }
  const { chain, excluded } = compilerWith(cfg, accounts, bench).buildChain(cfg, accounts, bench)

  assert.equal(chain.length, 0)
  assert.equal(excluded[0].why, 'cooling')
})

test('别名解析：精确优先，其次去掉 -free/-preview/eac: 前缀', async () => {
  const accounts = [
    { id: 'a1', provider: 'p1', enabled: true, models: ['eac:m-big-free'], quota: { status: 'ok', checkedAt: FRESH(), windows: [{ remainingPercent: 90 }] } },
  ]
  const cfg = makeCfg()
  const { chain } = compilerWith(cfg, accounts).buildChain(cfg, accounts, {})
  const big = chain.find((c) => c.tier === 'm-big')
  assert.ok(big, '应通过规范化匹配到 m-big')
  assert.equal(big.resolved, 'eac:m-big-free')
})

test('终局：全空且无兜底 → waiting + waitUntil 落在最近的 resetsAt', async () => {
  const resetsAt = new Date(Date.now() + 1_800_000).toISOString()
  const accounts = [
    { id: 'a1', provider: 'p1', enabled: true, models: ['m-big'], quota: { status: 'ok', checkedAt: FRESH(), windows: [{ remainingPercent: 0, resetsAt }] } },
  ]
  const cfg = makeCfg()
  const r = compilerWith(cfg, accounts).buildChain(cfg, accounts, {})
  assert.equal(r.chain.length, 0)
  assert.equal(r.waiting, true)
  assert.equal(r.waitUntil, Date.parse(resetsAt))
})

test('终局：全空但有兜底模型 → 兜底进入链（不得丢失）', async () => {
  const accounts = [
    { id: 'a1', provider: 'p1', enabled: true, models: ['m-big'], quota: { status: 'ok', checkedAt: FRESH(), windows: [{ remainingPercent: 0 }] } },
  ]
  const cfg = makeCfg({ finalResort: { fallbackModels: ['groq/llama-3.3-70b'], fallbackStrategy: 'fallback', retryAfterMinutes: 10, maxWaitHours: 6, official: { enabled: false } } })
  const r = compilerWith(cfg, accounts).buildChain(cfg, accounts, {})

  assert.equal(r.waiting, false)
  assert.equal(r.chain.length, 1)
  assert.equal(r.chain[0].kind, 'fallback')
  assert.equal(r.chain[0].resolved, 'groq/llama-3.3-70b')
})

test('platformPolicy.excludeAccounts 支持精确与星号通配', async () => {
  const accounts = [
    { id: 'p1-free-1', provider: 'p1', enabled: true, models: ['m-big'], quota: { status: 'ok', checkedAt: FRESH(), windows: [{ remainingPercent: 90 }] } },
    { id: 'a2', provider: 'p2', enabled: true, models: ['m-big'], quota: { status: 'ok', checkedAt: FRESH(), windows: [{ remainingPercent: 90 }] } },
  ]
  const cfg = makeCfg({ platformPolicy: { unknownTail: true, excludeAccounts: ['p1*'], perPlatformAccountOrder: {} } })
  const { chain } = compilerWith(cfg, accounts).buildChain(cfg, accounts, {})
  assert.deepEqual(chain.map((c) => c.accountId), ['a2'])
})

test('maxChainLength 截断并告警', async () => {
  const accounts = []
  for (let i = 0; i < 4; i += 1) {
    accounts.push({ id: `a${i}`, provider: `p${i}`, enabled: true, models: ['m-big'], quota: { status: 'ok', checkedAt: FRESH(), windows: [{ remainingPercent: 90 }] } })
  }
  const cfg = makeCfg({ platformOrder: ['p0', 'p1', 'p2', 'p3'], traversal: { order: 'tier-major', maxChainLength: 2 } })
  const r = compilerWith(cfg, accounts).buildChain(cfg, accounts, {})
  assert.equal(r.chain.length, 2)
  assert.ok(r.warnings.some((w) => /截断/.test(w)))
})

test('官方额度兜底：永远排在整条链的最后，且带 provider 前缀', () => {
  const accounts = [
    { id: 'a1', provider: 'p1', enabled: true, models: ['m-big'], quota: { status: 'ok', checkedAt: FRESH(), windows: [{ remainingPercent: 80 }] } },
  ]
  const cfg = makeCfg({
    finalResort: {
      official: { enabled: true, provider: 'deepseek-account', models: ['deepseek-flash'] },
      fallbackModels: ['groq/llama-3.3-70b'],
    },
  })
  const r = compilerWith(cfg, accounts).buildChain(cfg, accounts, {})

  assert.equal(r.chain[0].kind, 'account', '平台候选在前')
  const tail = r.chain.slice(-2)
  assert.deepEqual(tail.map((c) => c.resolved), ['groq/llama-3.3-70b', 'deepseek-account/deepseek-flash'])
  assert.equal(tail[1].why, 'official-quota')
})

test('官方额度关掉后，尾巴只剩用户兜底模型', () => {
  const accounts = [
    { id: 'a1', provider: 'p1', enabled: true, models: ['m-big'], quota: { status: 'ok', checkedAt: FRESH(), windows: [{ remainingPercent: 0 }] } },
  ]
  const cfg = makeCfg({ finalResort: { official: { enabled: false }, fallbackModels: ['groq/x'] } })
  const r = compilerWith(cfg, accounts).buildChain(cfg, accounts, {})
  assert.deepEqual(r.chain.map((c) => c.resolved), ['groq/x'])
  assert.equal(r.waiting, false)
})

test('写回不重复：与「上次真正写进 OFM 的内容」相同就不再排队（防每 15s 重写）', async () => {
  const accounts = [
    { id: 'a1', provider: 'p1', enabled: true, models: ['m-big'], quota: { status: 'ok', checkedAt: FRESH(), windows: [{ remainingPercent: 80 }] } },
  ]
  const cfg = makeCfg()
  const pending = []
  let appliedJson = ''
  const bridge = {
    current: () => ({ combos: [] }),
    peek: () => null,                     // 浏览器已取走待写内容
    lastApplied: () => appliedJson,
    setPending: (combos) => { pending.push(combos) },
  }
  const compiler = createCompiler({
    logger: { warn() {} }, cfg: () => cfg, ofm: {}, bridge, bench: { get: () => ({}), edit: () => ({}), update() {} },
    stores: { plan: { update() {}, get: () => ({}) } }, journal() {},
  })
  const plan = compiler.buildChain(cfg, accounts, {})

  // 第一次：没有落地记录 → 应该排队
  await compiler.replan({ reason: 'snapshot' })
  assert.equal(pending.length, 1, '首次应排队写回')
  appliedJson = JSON.stringify(pending[0])

  // 第二次：同样的内容已经落地过 → 不应再排队
  await compiler.replan({ reason: 'snapshot' })
  assert.equal(pending.length, 1, '内容没变就不该重写')
})

test('聚合渠道：别名按最后一段匹配（siliconflow/deepseek-ai/DeepSeek-V3 ← DeepSeek-V3）', async () => {
  const accounts = [
    { id: 'aggregate:siliconflow', provider: 'siliconflow', enabled: true, kind: 'aggregate',
      models: ['siliconflow/deepseek-ai/DeepSeek-V3', 'siliconflow/Qwen/Qwen3-32B'] },
  ]
  const base = makeCfg()
  const cfg = mergeConfig(base, {
    modelTiers: [{ id: 'v3', label: 'V3', pinned: false, aliases: ['DeepSeek-V3'] }],
    finalResort: { official: { enabled: false }, fallbackModels: [] },
  })
  const compiler = createCompiler({
    logger: { warn() {} }, cfg: () => cfg, ofm: {}, bridge: null,
    bench: { get: () => ({}), edit: () => ({}), update() {} },
    stores: { plan: { update() {}, get: () => ({}) } }, journal() {},
  })
  const plan = compiler.buildChain(cfg, accounts, {})
  assert.deepEqual(plan.chain.map((c) => c.resolved), ['siliconflow/deepseek-ai/DeepSeek-V3'])
})

test('新接入通道自动出现：catalog 里的 subscription:magpie/* 会变成平台，别名按最后一段命中', async () => {
  const { enrichAccounts } = await import('../src/compiler.js')
  const catalog = [
    { id: 'subscription:magpie/siliconflow/deepseek-ai/DeepSeek-V4.1-Flash', name: 'V4.1 Flash' },
    { id: 'free-model-a', name: 'free' },
  ]
  const accounts = enrichAccounts([], catalog)
  assert.equal(accounts.length, 1)
  assert.equal(accounts[0].provider, 'magpie')

  const base = makeCfg()
  const cfg = mergeConfig(base, {
    modelTiers: [{ id: 'flash', label: 'Flash', pinned: false, aliases: ['DeepSeek-V4.1-Flash'] }],
    finalResort: { official: { enabled: false }, fallbackModels: [] },
  })
  const compiler = createCompiler({
    logger: { warn() {} }, cfg: () => cfg, ofm: {}, bridge: null,
    bench: { get: () => ({}), edit: () => ({}), update() {} },
    stores: { plan: { update() {}, get: () => ({}) } }, journal() {},
  })
  const plan = compiler.buildChain(cfg, accounts, {})
  assert.deepEqual(plan.chain.map((c) => c.resolved),
    ['subscription:magpie/siliconflow/deepseek-ai/DeepSeek-V4.1-Flash'])
})

test('平台自动清理：连续缺席到阈值才移除，未到阈值只标记；关掉开关只标记不删', async () => {
  const { pruneMissingPlatforms } = await import('../src/compiler.js')
  let stored = {}
  const store = { get: () => stored, update: (value) => { stored = value } }
  const events = []
  const journal = (entry) => events.push(entry)
  const accounts = [{ id: 'a1', provider: 'p1', enabled: true, models: ['m'] }]

  const cfg = mergeConfig(makeCfg(), {
    platformOrder: ['p1', 'gone'],
    platformPolicy: { pruneMissing: true, pruneAfterMisses: 2, excludePlatforms: [] },
  })

  // 第 1 轮：只标记，不删
  let result = pruneMissingPlatforms(cfg, accounts, store, journal)
  assert.deepEqual(result.pruned, [])
  assert.equal(result.missing.find((m) => m.id === 'gone')?.missingSyncs, 1)
  assert.deepEqual(cfg.platformOrder, ['p1', 'gone'])

  // 第 2 轮：达到阈值 → 从顺序里移除，并留一条 journal
  result = pruneMissingPlatforms(cfg, accounts, store, journal)
  assert.deepEqual(result.pruned, ['gone'])
  assert.deepEqual(cfg.platformOrder, ['p1'])
  assert.equal(events.filter((e) => e.kind === 'platform-prune').length, 1)

  // 关掉开关：就算连缺 10 次也不删
  const cfg2 = mergeConfig(makeCfg(), {
    platformOrder: ['gone'],
    platformPolicy: { pruneMissing: false, pruneAfterMisses: 1, excludePlatforms: [] },
  })
  const result2 = pruneMissingPlatforms(cfg2, accounts, { get: () => ({}), update() {} }, journal)
  assert.deepEqual(result2.pruned, [])
  assert.deepEqual(cfg2.platformOrder, ['gone'])
  assert.equal(result2.missing[0].missingSyncs, 1)

  // 回来的平台：missingSyncs 归零
  const cfg3 = mergeConfig(makeCfg(), { platformOrder: ['p1'], platformPolicy: { pruneMissing: true, excludePlatforms: [] } })
  const back = pruneMissingPlatforms(cfg3, accounts, { get: () => ({ p1: { missingSyncs: 5, lastSeenAt: 1 } }), update() {} }, journal)
  assert.equal(back.missing.length, 0)
})

test('空观测保护：一轮读不到任何平台时不计数、不删除（中继断线不等于渠道被删）', async () => {
  const { pruneMissingPlatforms } = await import('../src/compiler.js')
  const store = { get: () => ({ gone: { missingSyncs: 2, lastSeenAt: 1 } }), update() {} }
  const cfg = mergeConfig(makeCfg(), {
    platformOrder: ['gone'],
    platformPolicy: { pruneMissing: true, pruneAfterMisses: 3, excludePlatforms: [] },
  })
  const result = pruneMissingPlatforms(cfg, [], store, () => {})
  assert.deepEqual(result.pruned, [], '空观测时绝不能删平台')
  assert.deepEqual(cfg.platformOrder, ['gone'])
  assert.equal(result.health.gone.missingSyncs, 2, '计数应保持不变')
})

test('手动删除：hiddenPlatforms 里的平台不参与接力（否则下一轮同步会把它捡回来）', async () => {
  const accounts = [
    { id: 'a1', provider: 'p1', enabled: true, models: ['m'] },
    { id: 'a2', provider: 'p2', enabled: true, models: ['m'] },
  ]
  const base = mergeConfig(makeCfg(), {
    modelTiers: [{ id: 't', label: 'T', pinned: false, aliases: ['m'] }],
    platformOrder: ['p1', 'p2'],
    platformPolicy: { excludePlatforms: [], hiddenPlatforms: ['p1'], unknownTail: true },
    finalResort: { official: { enabled: false }, fallbackModels: [] },
  })
  const compiler = createCompiler({
    logger: { warn() {} }, cfg: () => base, ofm: {}, bridge: null,
    bench: { get: () => ({}), edit: () => ({}), update() {} },
    stores: { plan: { update() {}, get: () => ({}) } }, journal() {},
  })
  const plan = compiler.buildChain(base, accounts, {})
  assert.deepEqual(plan.chain.map((c) => c.platform), ['p2'], '被删掉的 p1 不应出现在链里')
})

test('0 账号的空渠道自动隐藏；给它加了账号后自动放回来（只自愈 autoHidden 的）', async () => {
  const { pruneMissingPlatforms } = await import('../src/compiler.js')
  let stored = {}
  const store = { get: () => stored, edit: (fn) => { stored = fn(structuredClone(stored)) } }
  const events = []
  const journal = (e) => events.push(e)

  const accounts = [{ id: 'a1', provider: 'trae', enabled: true, models: ['m'] }]
  const meta = [
    { provider: 'trae', accounts: 1, models: 25 },
    { provider: 'qoder', accounts: 0, models: 17 },
  ]
  const cfg = mergeConfig(makeCfg(), {
    platformOrder: ['trae', 'qoder'],
    platformPolicy: { pruneMissing: true, pruneZeroAccounts: true, excludePlatforms: [], hiddenPlatforms: [] },
  })

  const first = pruneMissingPlatforms(cfg, accounts, store, journal, meta)
  assert.deepEqual(first.hidden, ['qoder'], 'qoder 是 0 账号，应被自动隐藏')
  assert.deepEqual(cfg.platformOrder, ['trae'])
  assert.ok(cfg.platformPolicy.hiddenPlatforms.includes('qoder'))
  assert.ok(cfg.platformPolicy.excludePlatforms.includes('qoder'), '旧宿主只认 excludePlatforms，也要写')
  assert.equal(events.filter((e) => e.kind === 'platform-hide-zero').length, 1)

  // 用户给 qoder 加了一个账号 → 下一轮应自动放回
  const accounts2 = [...accounts, { id: 'q1', provider: 'qoder', enabled: true, models: ['m'] }]
  const meta2 = [
    { provider: 'trae', accounts: 1, models: 25 },
    { provider: 'qoder', accounts: 1, models: 17 },
  ]
  const second = pruneMissingPlatforms(cfg, accounts2, store, journal, meta2)
  assert.deepEqual(second.restored, ['qoder'])
  assert.ok(!cfg.platformPolicy.hiddenPlatforms.includes('qoder'))
  assert.ok(!cfg.platformPolicy.excludePlatforms.includes('qoder'))

  // 用户手动删（没有 autoHidden 标记）的平台：即便有账号也保持隐藏
  let stored2 = { manually: { lastSeenAt: 1, missingSyncs: 0, accounts: 3, autoHidden: false } }
  const store2 = { get: () => stored2, edit: (fn) => { stored2 = fn(structuredClone(stored2)) } }
  const cfg2 = mergeConfig(makeCfg(), {
    platformOrder: ['manually'],
    platformPolicy: { pruneMissing: true, pruneZeroAccounts: true, excludePlatforms: [], hiddenPlatforms: ['manually'] },
  })
  const third = pruneMissingPlatforms(cfg2, [{ id: 'x', provider: 'manually', enabled: true, models: ['m'] }], store2, journal,
    [{ provider: 'manually', accounts: 3, models: 5 }])
  assert.deepEqual(third.restored, [], '手动删的不自愈')
  assert.ok(cfg2.platformPolicy.hiddenPlatforms.includes('manually'))
})

test('pruneZeroAccounts=false：0 账号只标记不隐藏', async () => {
  const { pruneMissingPlatforms } = await import('../src/compiler.js')
  let stored = {}
  const store = { get: () => stored, edit: (fn) => { stored = fn(structuredClone(stored)) } }
  const cfg = mergeConfig(makeCfg(), {
    platformOrder: ['qoder'],
    platformPolicy: { pruneMissing: true, pruneZeroAccounts: false, excludePlatforms: [], hiddenPlatforms: [] },
  })
  const result = pruneMissingPlatforms(cfg, [], store, () => {}, [{ provider: 'qoder', accounts: 0, models: 0 }])
  assert.deepEqual(result.hidden, [])
  assert.deepEqual(result.zeroAccounts, ['qoder'], '仍然报出「0 账号」给 UI')
  assert.deepEqual(cfg.platformOrder, ['qoder'])
})
