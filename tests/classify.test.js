import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyFailure, failureOf, ACTION } from '../src/classify.js'

test('结构化 code 优先于文本', () => {
  const v = classifyFailure({ code: 'QUOTA_EXHAUSTED', message: 'rate limit exceeded' })
  assert.equal(v.kind, 'quota')
  assert.equal(v.action, ACTION.RESUME)
  assert.equal(v.matchedBy, 'code:QUOTA_EXHAUSTED')
})

test('中文额度文案也能识别', () => {
  for (const message of ['额度已用完，请充值', '积分不足', '免费额度耗尽', '余额不足']) {
    const v = classifyFailure({ message })
    assert.equal(v.kind, 'quota', message)
    assert.equal(v.action, ACTION.RESUME, message)
  }
})

test('限流 → RESUME，凭据问题 → GIVEUP，权限 → SWITCH', () => {
  assert.equal(classifyFailure({ message: '429 Too Many Requests' }).action, ACTION.RESUME)
  assert.equal(classifyFailure({ message: 'invalid api key' }).action, ACTION.GIVEUP)
  assert.equal(classifyFailure({ message: 'request not allowed in your region' }).action, ACTION.SWITCH)
})

test('channel-pack 的排队错误 → RESUME', () => {
  const v = classifyFailure({ code: 'QUEUE', message: 'loomy: 当前账号不可用或无法确认余额，且没有符合渠道策略的备用账号' })
  assert.equal(v.kind, 'queue')
  assert.equal(v.action, ACTION.RESUME)
})

test('上下文超限 / 非法请求 → GIVEUP（重放无用）', () => {
  assert.equal(classifyFailure({ message: 'maximum context length exceeded' }).action, ACTION.GIVEUP)
  assert.equal(classifyFailure({ message: 'improperly formed request' }).action, ACTION.GIVEUP)
})

test('用户 abort → IGNORE', () => {
  const v = classifyFailure({ message: 'request aborted by user' })
  assert.equal(v.kind, 'aborted')
  assert.equal(v.action, ACTION.IGNORE)
})

test('状态码兜底', () => {
  assert.equal(classifyFailure({ status: 429 }).kind, 'rate_limit')
  assert.equal(classifyFailure({ status: 401 }).kind, 'auth')
  assert.equal(classifyFailure({ status: 503 }).kind, 'overloaded')
})

test('无信息 → unknown/IGNORE，不猜', () => {
  const v = classifyFailure({})
  assert.equal(v.kind, 'unknown')
  assert.equal(v.action, ACTION.IGNORE)
})

test('冷却时长有上限（不外溢到 30 分钟以上）', () => {
  for (const f of [{ message: 'quota exceeded' }, { message: 'unauthorized' }, { code: 'SERVER' }]) {
    assert.ok(classifyFailure(f).cooldownMs <= 30 * 60_000, JSON.stringify(f))
  }
})

test('failureOf 兼容多种流末形态', () => {
  assert.deepEqual(failureOf({ kind: 'error', failure: { message: 'x' } }), { message: 'x' })
  assert.deepEqual(failureOf({ failure: { message: 'y' } }), { message: 'y' })
  assert.equal(failureOf({ kind: 'stop' }), null)
  assert.equal(failureOf(null), null)
})
