// 接线回归测试：host 半身的 llm/stream 观察 → 续跑监督器 是否真的串起来了。
//
// 背景：v0.1.0 这里有个静默 bug —— watchStream 把 meta.resume 解构进局部变量后
// 只把 `{...rest, reason}` 交给 reportFailure，监督器因此永远是 undefined，
// 于是「额度中断 → 自动继续」整条链路在生产里一次都没跑过，日志里也不留痕。
// 这个测试就钉住那条链路：一次失败的流必须最终产出一条 followup。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..')

function makeCtx(home) {
  const handlers = new Map()
  const agent = {
    id: 'sess-1',
    status: 'idle',
    session: { id: 'sess-1' },
    inbox: { hasPending: false, nextTurn: [], nextStep: [] },
    followup(msg) { agent.injected.push(msg) },
    injected: [],
  }
  const warnings = []
  const ctx = {
    fiber: { entry: { options: { id: 'quota-takeover' } } },
    logger: {
      info() {},
      warn: (m) => warnings.push(String(m)),
      error: (m) => warnings.push(String(m)),
      debug() {},
    },
    llm: { registerAdapter() {}, registerConfigurableProviders() {}, registerModelDiscovery() {} },
    on(ev, h) { handlers.set(ev, h); return () => {} },
    effect: (fn) => fn(),
    inject(_deps, cb) {
      // 模拟「服务已就绪」：立刻用 scope 调回调，与运行时一致
      const scope = { agents: {}, effect: (f) => f(), on(ev, h) { handlers.set(ev, h); return () => {} } }
      return cb(scope)
    },
  }
  return { ctx, handlers, agent, warnings, home }
}

test('失败的流最终会向会话注入一条「继续」', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qt-wiring-'))
  process.env.DSH_HOME = home
  fs.mkdirSync(path.join(home, 'channel-pack'), { recursive: true })
  fs.writeFileSync(path.join(home, 'channel-pack', 'state.json'), JSON.stringify({
    accounts: [{ id: 'a1', provider: 'trae', enabled: true, modelRateLimits: {} }],
    providerOrder: [],
  }))

  const { ctx, handlers, agent } = makeCtx(home)
  const mod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href)
  mod.apply(ctx, {})

  handlers.get('agent/created')?.(agent)

  const stream = handlers.get('llm/stream')
  assert.equal(typeof stream, 'function', 'llm/stream 钩子必须被注册')

  const failing = (async function* () {
    yield { type: 'start' }
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'insufficient_quota', code: 'QUOTA_EXHAUSTED', status: 429 } } }
  })()

  const out = stream({ provider: 'trae', model: 'DeepSeek-V4-Flash', accountId: 'a1', sessionId: 'sess-1' }, () => failing)
  for await (const _ of out) { /* 透传 */ }
  await new Promise((r) => setTimeout(r, 300))

  assert.equal(agent.injected.length, 1, '应当注入恰好一条消息（监督器必须拿到 resume）')
  const text = agent.injected[0].content[0].text
  assert.match(text, /继续/)
  assert.equal(agent.injected[0].source.kind, 'user', '必须与用户手打「继续」同形')

  const journal = fs.readFileSync(path.join(home, 'quota-takeover', 'journal.jsonl'), 'utf8')
  assert.match(journal, /"kind":"failure"/, '失败必须留痕')
  assert.match(journal, /"kind":"resume"/, '续跑必须留痕')
})

test('非额度类失败（凭据）不注入', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qt-wiring2-'))
  process.env.DSH_HOME = home
  fs.mkdirSync(path.join(home, 'channel-pack'), { recursive: true })
  fs.writeFileSync(path.join(home, 'channel-pack', 'state.json'), JSON.stringify({
    accounts: [{ id: 'a1', provider: 'trae', enabled: true, modelRateLimits: {} }],
    providerOrder: [],
  }))

  const { ctx, handlers, agent } = makeCtx(home)
  const mod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href + '?v=2')
  mod.apply(ctx, {})
  handlers.get('agent/created')?.(agent)

  const failing = (async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'no credentials', code: 'INVALID_CREDENTIAL', status: 401 } } }
  })()
  for await (const _ of handlers.get('llm/stream')({ provider: 'trae', model: 'm', accountId: 'a1', sessionId: 's2' }, () => failing)) {}
  await new Promise((r) => setTimeout(r, 300))

  assert.equal(agent.injected.length, 0, '凭据问题不应自动续跑（重试也不会好）')
})
