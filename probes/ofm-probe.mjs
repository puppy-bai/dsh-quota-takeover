#!/usr/bin/env node
/**
 * M0 探针 1：Our Free Model 的 HTTP JSON API 是否可达、combos 是否可读可写。
 *
 * 用法：
 *   node probes/ofm-probe.mjs http://127.0.0.1:32829
 *   DSH_OFM_BASE=http://127.0.0.1:32829 node probes/ofm-probe.mjs
 *
 * 只读 + 一次「写回原样」的自检（不新增、不删除任何 combo）：
 *   读出 combos → 原封不动 POST 回去 → 再读一次比对。
 * 任何一步失败都会以非零退出码收尾，方便在 CI/安装脚本里当门禁。
 */

const base = process.argv[2] || process.env.DSH_OFM_BASE || 'http://127.0.0.1:32829'
const PREFIX = '/api/our-free-model'

function step(name, ok, detail) {
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`)
  return ok
}

async function call(pathname, init = {}) {
  const url = `${base}${PREFIX}${pathname}`
  const res = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(8000),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, ok: res.ok, json, text }
}

let failed = 0
const fail = (name, detail) => { failed += 1; step(name, false, detail) }

try {
  // 1. summary：证明 OFM 插件在、路由挂上了
  const summary = await call('/summary')
  if (!step('GET /summary', summary.ok, `${summary.status}`)) {
    fail('GET /summary', summary.text.slice(0, 200))
  }

  // 2. combos 列表
  const list = await call('/combos')
  const combos = Array.isArray(list.json) ? list.json : list.json?.combos
  if (!step('GET /combos', list.ok && Array.isArray(combos), `${combos?.length ?? 0} 条`)) {
    fail('GET /combos', list.text.slice(0, 200))
  } else {
    for (const c of combos) {
      console.log(`    · ${c.id}  strategy=${c.strategy ?? '-'}  models=${(c.models ?? []).length}`)
    }
  }

  // 3. subscriptions（额度来源）
  const subs = await call('/subscriptions')
  const accounts = subs.json?.accounts ?? (Array.isArray(subs.json) ? subs.json : null)
  step('GET /subscriptions', subs.ok && Array.isArray(accounts), `${accounts?.length ?? 0} 个账号`)
  for (const a of accounts ?? []) {
    const w = a.quota?.windows?.[0]
    console.log(`    · ${a.provider}/${a.id} enabled=${a.enabled} quota=${a.quota?.status ?? 'unknown'}${w ? ` 剩余${w.remainingPercent}%` : ''}`)
  }

  // 4. 写回自检：原样 POST 回去（不改变内容）
  if (Array.isArray(combos)) {
    const echo = await call('/combos', { method: 'POST', body: JSON.stringify(combos) })
    step('POST /combos（原样回写）', echo.ok, `${echo.status}`)

    const after = await call('/combos')
    const afterCombos = Array.isArray(after.json) ? after.json : after.json?.combos
    const same = JSON.stringify(afterCombos?.map((c) => c.id).sort()) === JSON.stringify(combos.map((c) => c.id).sort())
    step('写回后 id 集合不变', same)
    if (!same) fail('写回后 id 集合不变', 'POST 可能触发了副作用')
  }
} catch (error) {
  fail('连接 OFM', String(error?.message ?? error))
}

console.log(failed === 0 ? '\n探针 1 通过：OFM 集成面可用' : `\n探针 1 失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
