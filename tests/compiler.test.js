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
