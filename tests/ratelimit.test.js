/**
 * 限流/上游频率过高的接管路径（用户 19:20 追加的需求）。
 *
 * 关键场景来自真实文案（宿主放大熔断，#4204）：
 *   "raccoon: upstream rate-limited 6 consecutive request(s) to xiaohuanxiong.com;
 *    bili stops amplifying after 5 consecutive rate limits — resend manually
 *    once the provider recovers (a background probe keeps checking at most every 30s)"
 * 它必须以 rate_limit 分类、以 provider 作用域冷却整个平台、并注入「继续」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyFailure, ACTION, COOLDOWN } from '../src/classify.js'
import { createResumeSupervisor } from '../src/resume.js'
import { createCompiler } from '../src/compiler.js'
import { DEFAULT_CONFIG, mergeConfig } from '../src/config.js'

const UPSTREAM_RATE_LIMIT = 'raccoon: upstream rate-limited 6 consecutive request(s) to xiaohuanxiong.com; ' +
  'bili stops amplifying after 5 consecutive rate limits — resend manually once the provider recovers ' +
  '(a background probe keeps checking at most every 30s) (#4204)'

test('放大熔断文案 → rate_limit + provider 作用域 + resume', () => {
  const v = classifyFailure({ message: UPSTREAM_RATE_LIMIT, code: 'RATE_LIMIT' })
  assert.equal(v.kind, 'rate_limit')
  assert.equal(v.scope, 'provider')
  assert.equal(v.action, ACTION.RESUME)
})

test('纯文本（无 code）也能认出限流，且识别为熔断文案', () => {
  const v = classifyFailure({ message: UPSTREAM_RATE_LIMIT })
  assert.equal(v.kind, 'rate_limit')
  assert.equal(v.scope, 'provider')
  assert.equal(v.matchedBy, 'text:amplify')
})

test('冷却时长 ≥ 30s：否则 replan 会把同一格选回来，候选没变就不续跑', () => {
  assert.ok(COOLDOWN.RATE_LIMIT_MS >= 30_000)
  const v = classifyFailure({ message: 'rate-limited' })
  assert.ok(v.cooldownMs >= 30_000)
})

function resumeHarness() {
  const cfg = mergeConfig(structuredClone(DEFAULT_CONFIG), {})
  const journal = []
  const bench = {}
  let plan = { chain: [{ platform: 'raccoon', resolved: 'm1', accountId: 'a1' }], candidateHash: 'h1' }
  const agent = {
    id: 'sess-1',
    status: 'idle',
    inbox: { hasPending: false, nextTurn: [], nextStep: [] },
    followups: [],
    followup(msg) { this.followups.push(msg) },
  }
  const supervisor = createResumeSupervisor({
    logger: { warn() {}, info() {} },
    agents: {},
    cfg: () => cfg,
    ofm: {},
    bench: { get: () => bench, edit: (fn) => fn(bench), update: (v) => Object.assign(bench, v) },
    stores: { plan: { get: () => plan, update() {} }, resume: { get: () => ({}), update() {} } },
    journal: (e) => journal.push(e),
    replan: async () => { plan = { ...plan, candidateHash: 'h2' }; return plan },
  })
  supervisor.remember('sess-1', agent)
  return { supervisor, journal, bench, agent }
}

test('限流失败 → 冷却整个平台 + 注入「继续」', async () => {
  const h = resumeHarness()
  const r = await h.supervisor.noteFailure({
    sessionKey: 'sess-1', accountId: 'a1', model: 'm1', provider: 'raccoon',
    failure: { message: UPSTREAM_RATE_LIMIT },
  })

  assert.equal(r.action, ACTION.RESUME)
  assert.ok(h.bench['a1|m1'], '该格子应进冷却')
  assert.ok(h.bench['provider:raccoon'], '整个平台应一起冷却（换同平台其它模型也撞同一面墙）')
  assert.equal(h.agent.followups.length, 1)
  assert.match(h.agent.followups[0].content[0].text, /继续/)
})

test('平台冷却期间，编译器跳过该平台的全部档位', () => {
  const cfg = mergeConfig(structuredClone(DEFAULT_CONFIG), {})
  const compiler = createCompiler({ logger: { warn() {} }, cfg: () => cfg, ofm: {}, journal() {} })
  const now = Date.now()
  const accounts = [
    { id: 'a1', provider: 'raccoon', enabled: true, models: ['deepseek-v4.1-flash', 'glm-5.3-flash'] },
    { id: 'a2', provider: 'trae', enabled: true, models: ['deepseek-v4.1-flash'] },
  ]
  const out = compiler.buildChain(
    cfg,
    accounts,
    { 'provider:raccoon': { until: now + 60_000, reason: 'rate_limit', level: 1 } },
    now,
  )
  assert.ok(out.chain.every((c) => c.platform !== 'raccoon'), 'raccoon 不应出现在链里')
  assert.ok(out.excluded.some((e) => e.platform === 'raccoon' && e.why === 'platform-cooling'))
  assert.ok(out.chain.some((c) => c.platform === 'trae'))
})
