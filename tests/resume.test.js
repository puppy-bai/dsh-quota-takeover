import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createResumeSupervisor } from '../src/resume.js'
import { DEFAULT_CONFIG, mergeConfig } from '../src/config.js'
import { ACTION } from '../src/classify.js'

function harness({ cfgPatch = {}, plan = {}, agent, staticHash = false } = {}) {
  const cfg = mergeConfig(structuredClone(DEFAULT_CONFIG), cfgPatch)
  const journal = []
  let currentPlan = { chain: [{ platform: 'p1', resolved: 'm-big', accountId: 'a1' }], candidateHash: 'h1', ...plan }
  const bench = {}
  const replans = []

  const supervisor = createResumeSupervisor({
    logger: { warn() {}, info() {} },
    agents: {},
    cfg: () => cfg,
    ofm: {},
    bench: { get: () => bench, edit: (fn) => fn(bench), update: (v) => Object.assign(bench, v) },
    stores: {
      plan: { get: () => currentPlan, update() {} },
      resume: { get: () => ({}), update: () => {} },
    },
    journal: (e) => journal.push(e),
    replan: async (opts) => {
      replans.push(opts)
      // 模拟重新编译：默认每次候选都变；staticHash=true 时保持不变（测「不空转」）
      if (!staticHash) currentPlan = { ...currentPlan, candidateHash: `h${replans.length + 1}` }
      return currentPlan
    },
  })

  const fakeAgent = agent ?? {
    id: 'sess-1',
    status: 'idle',
    inbox: { hasPending: false, nextTurn: [], nextStep: [] },
    followups: [],
    followup(msg) { this.followups.push(msg) },
  }
  supervisor.remember('sess-1', fakeAgent)
  return { supervisor, journal, bench, replans, fakeAgent, cfg, setPlan: (p) => { currentPlan = p } }
}

test('额度型失败 → 冷却入表 + 重编译 + 注入「继续」', async () => {
  const h = harness()
  const r = await h.supervisor.noteFailure({
    sessionKey: 'sess-1', accountId: 'a1', model: 'm-big', provider: 'p1',
    failure: { message: 'insufficient_quota', code: 'QUOTA_EXHAUSTED' },
  })

  assert.equal(r.action, ACTION.RESUME)
  assert.equal(h.replans.length, 1)
  assert.ok(h.bench['a1|m-big'], '冷却表应写入 a1|m-big')
  assert.equal(h.fakeAgent.followups.length, 1)

  const msg = h.fakeAgent.followups[0]
  assert.equal(msg.source.kind, 'user', 'source.kind 必须是 user（与 loop-recovery 同构）')
  assert.match(msg.content[0].text, /继续/)
  assert.match(msg.content[0].text, /quota/)
})

test('注入内容带上「已切换到哪个平台/模型」', async () => {
  const h = harness()
  await h.supervisor.noteFailure({
    sessionKey: 'sess-1', accountId: 'a1', model: 'm-big', provider: 'p1',
    failure: { message: 'quota exceeded' },
  })
  assert.match(h.fakeAgent.followups[0].content[0].text, /p1/)
})

test('用户自己 abort → 不注入', async () => {
  const h = harness()
  const r = await h.supervisor.noteFailure({
    sessionKey: 'sess-1', accountId: 'a1', model: 'm-big', provider: 'p1',
    failure: { message: 'request aborted' },
  })
  assert.equal(r.action, ACTION.IGNORE)
  assert.equal(h.fakeAgent.followups.length, 0)
})

test('凭据问题 → GIVEUP，不注入', async () => {
  const h = harness()
  const r = await h.supervisor.noteFailure({
    sessionKey: 'sess-1', accountId: 'a1', model: 'm-big', provider: 'p1',
    failure: { message: 'invalid api key' },
  })
  assert.equal(r.action, ACTION.GIVEUP)
  assert.equal(h.fakeAgent.followups.length, 0)
})

test('onlyQuotaLike=true 时，非额度类失败不续跑', async () => {
  const h = harness()
  const r = await h.supervisor.noteFailure({
    sessionKey: 'sess-1', accountId: 'a1', model: 'm-big', provider: 'p1',
    failure: { message: 'some weird upstream thing' },
  })
  assert.notEqual(r.action, ACTION.RESUME)
  assert.equal(h.fakeAgent.followups.length, 0)
})

test('候选没变（candidateHash 相同）→ 不空转', async () => {
  const h = harness({
    cfgPatch: { resume: { ...DEFAULT_CONFIG.resume, minIntervalMs: 0 } },
    staticHash: true,
  })
  const first = await h.supervisor.noteFailure({ sessionKey: 'sess-1', accountId: 'a1', model: 'm-big', failure: { message: 'quota exceeded' } })
  assert.equal(first.action, ACTION.RESUME)

  const second = await h.supervisor.noteFailure({ sessionKey: 'sess-1', accountId: 'a1', model: 'm-big', failure: { message: 'quota exceeded' } })
  assert.equal(second.action, ACTION.IGNORE)
  assert.equal(second.why, 'candidate unchanged')
  assert.equal(h.fakeAgent.followups.length, 1, '只应注入一次')
})

test('候选变了就会再次注入', async () => {
  const h = harness({ cfgPatch: { resume: { ...DEFAULT_CONFIG.resume, minIntervalMs: 0 } } })
  await h.supervisor.noteFailure({ sessionKey: 'sess-1', accountId: 'a1', model: 'm-big', failure: { message: 'quota exceeded' } })
  const second = await h.supervisor.noteFailure({ sessionKey: 'sess-1', accountId: 'a2', model: 'm-big', failure: { message: 'quota exceeded' } })
  assert.equal(second.action, ACTION.RESUME)
  assert.equal(h.fakeAgent.followups.length, 2)
})

test('minIntervalMs 内的连续失败被抑制', async () => {
  const h = harness({ cfgPatch: { resume: { ...DEFAULT_CONFIG.resume, minIntervalMs: 60_000 } } })
  await h.supervisor.noteFailure({ sessionKey: 'sess-1', accountId: 'a1', model: 'm-big', failure: { message: 'quota exceeded' } })
  const r = await h.supervisor.noteFailure({ sessionKey: 'sess-1', accountId: 'a2', model: 'm-big', failure: { message: 'quota exceeded' } })
  assert.equal(r.action, ACTION.IGNORE)
  assert.equal(r.why, 'minInterval')
  assert.equal(h.fakeAgent.followups.length, 1)
})

test('maxPerSession 上限后转 GIVEUP', async () => {
  const h = harness({
    cfgPatch: { resume: { ...DEFAULT_CONFIG.resume, maxPerSession: 2, minIntervalMs: 0 } },
  })
  for (let i = 0; i < 2; i += 1) {
    const r = await h.supervisor.noteFailure({ sessionKey: 'sess-1', accountId: `a${i}`, model: 'm-big', failure: { message: 'quota exceeded' } })
    assert.equal(r.action, ACTION.RESUME, `第 ${i + 1} 次应续跑`)
  }
  const r = await h.supervisor.noteFailure({ sessionKey: 'sess-1', accountId: 'a9', model: 'm-big', failure: { message: 'quota exceeded' } })
  assert.equal(r.action, ACTION.GIVEUP)
  assert.equal(r.why, 'maxPerSession')
  assert.equal(h.fakeAgent.followups.length, 2)
})

test('agent 忙 / inbox 有排队 → 不注入', async () => {
  const busy = { id: 'sess-busy', status: 'running', inbox: { hasPending: false }, followup() { throw new Error('should not be called') } }
  const h = harness({ agent: busy })
  h.supervisor.remember('sess-1', busy)
  const r = await h.supervisor.noteFailure({ sessionKey: 'sess-1', accountId: 'a1', model: 'm-big', failure: { message: 'quota exceeded' } })
  assert.equal(r.action, ACTION.IGNORE)
  assert.match(String(r.why), /busy|inbox/)
})

test('全部平台耗尽且无兜底 → WAIT，不注入', async () => {
  const h = harness()
  h.setPlan({ chain: [], candidateHash: 'h0', waiting: true, waitUntil: Date.now() + 60_000 })
  const r = await h.supervisor.noteFailure({ sessionKey: 'sess-1', accountId: 'a1', model: 'm-big', failure: { message: 'quota exceeded' } })
  assert.equal(r.action, ACTION.WAIT)
  assert.equal(h.fakeAgent.followups.length, 0)
})

test('resume.enabled=false 时完全不介入', async () => {
  const h = harness({ cfgPatch: { resume: { ...DEFAULT_CONFIG.resume, enabled: false } } })
  const r = await h.supervisor.noteFailure({ sessionKey: 'sess-1', accountId: 'a1', model: 'm-big', failure: { message: 'quota exceeded' } })
  assert.equal(r.action, ACTION.IGNORE)
  assert.equal(h.fakeAgent.followups.length, 0)
})

test('dispose 后不再介入', async () => {
  const h = harness()
  h.supervisor.dispose()
  const r = await h.supervisor.noteFailure({ sessionKey: 'sess-1', accountId: 'a1', model: 'm-big', failure: { message: 'quota exceeded' } })
  assert.equal(r.action, ACTION.IGNORE)
})
