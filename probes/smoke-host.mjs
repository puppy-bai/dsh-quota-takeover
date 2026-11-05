/**
 * Host 半身的冒烟测试：用一个假的 Cordis ctx 装载 index.js 的 apply，
 * 验证（1）模块能加载、（2）API handler 能响应、（3）snapshot → pending 的中继闭环能走通。
 *
 * 不碰真实 OFM、不写用户文件（DSH_HOME 指向临时目录）。
 *
 * 用法：node probes/smoke-host.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qt-smoke-'))
process.env.DSH_HOME = tmp

const mod = await import('../index.js')

/** 极简的 ctx：只实现本插件用到的四件事。 */
function makeCtx(routes) {
  const ctx = {
    fiber: { entry: { options: { id: 'quota-takeover' } } },
    inject(deps, cb) {
      if (deps.includes('webServer')) {
        // 真 Cordis 把服务挂在服务名上：webServer
        cb({ webServer: { register(route) { routes.push(route); return () => {} } }, effect: (fn) => fn() })
      }
      return () => {}
    },
    on() { return () => {} },
    effect(fn) { return fn() },
    get() { return undefined },
  }
  return ctx
}

const routes = []
const ctx = makeCtx(routes)
mod.apply(ctx, {})

assert.equal(routes.length, 1, '应注册一个 prefix 路由')
assert.equal(routes[0].path, '/api/quota-takeover')
const handler = routes[0].handler

/** 假 req/res：handler 从 req.url 取路径（真实 prefix handler 就是这样）。 */
function call(method, url, body) {
  return new Promise((resolve) => {
    const req = {
      method,
      url: `/api/quota-takeover${url}`,
      on(ev, fn) {
        if (ev === 'end') fn()
        if (ev === 'data' && body !== undefined) fn(Buffer.from(JSON.stringify(body)))
      },
    }
    const res = {
      statusCode: 0,
      writeHead(code) { this.statusCode = code },
      end(text) { resolve({ status: this.statusCode, body: JSON.parse(text || 'null') }) },
    }
    handler(req, res)
  })
}

const status0 = await call('GET', '/status')
assert.equal(status0.status, 200)
assert.equal(status0.body.name, 'quota-takeover')
console.log('✔ GET /status 200, plan keys:', Object.keys(status0.body.plan ?? {}).join(','))

// 模拟浏览器推快照（一个平台、一个模型）
const snap = await call('POST', '/snapshot', {
  source: 'smoke',
  accounts: [{ id: 'acct-1', provider: 'p1', enabled: true, models: ['m-big'] }],
  combos: [{ id: 'combo:manual', name: '手工链', models: ['x'], strategy: 'fallback' }],
})
assert.equal(snap.status, 200)
console.log('✔ POST /snapshot →', JSON.stringify(snap.body))

const pending = await call('GET', '/pending')
console.log('✔ GET /pending →', JSON.stringify(pending.body).slice(0, 200))

// 默认配置下 modelTiers 为空 → 链为空；给一个档位再编译一次，验证 true 写回意图
const cfgRes = await call('POST', '/config', {
  modelTiers: [{ id: 'big', label: '大模型', aliases: ['m-big'] }],
  platformOrder: ['p1'],
})
if (cfgRes.status !== 200) console.log('!! /config failed', cfgRes.status, JSON.stringify(cfgRes.body))
const st = await call('GET', '/status')
console.log('!! plan', JSON.stringify(st.body.plan).slice(0,400))
const pending2 = await call('GET', '/pending')
console.log('!! pending2 raw', JSON.stringify(pending2.body).slice(0,300))
const combos = pending2.body?.pending?.combos ?? []
assert.ok(combos.length >= 1, '应产生待写 combos')
assert.equal(combos.filter((c) => c.id.startsWith('auto:')).length >= 1, true)
assert.equal(combos.some((c) => c.id === 'combo:manual'), true, '用户手工链必须保留')
console.log('✔ 待写 combos:', combos.map((c) => `${c.id}[${c.models.join(',')}]`).join(' | '))

// 回报 applied
const applied = await call('POST', '/applied', { combos, hash: 'smoke' })
assert.equal(applied.status, 200)

const bridge = await call('GET', '/bridge')
assert.equal(bridge.body.hasSnapshot, true)
console.log('✔ GET /bridge →', JSON.stringify(bridge.body))

fs.rmSync(tmp, { recursive: true, force: true })
console.log('\nsmoke-host: all good')
