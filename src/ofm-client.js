/**
 * OFM HTTP 客户端 —— 整合所有对 Our Free Model 插件内部 API 的访问（风险 7.6）。
 *
 * 特性探测 + 降级：任何端点不存在/形状不符，都返回 rc 字段而不是抛异常。
 * base 默认取 harness GUI 基址；也允许 DSH_OFM_BASE 显式覆盖。
 */
import { request } from 'node:http'

const DEFAULT_BASE = 'http://127.0.0.1:39926'
const PREFIX = '/api/our-free-model'

export function createOfmClient({ logger, home }) {
  const state = {
    base: process.env.DSH_OFM_BASE || DEFAULT_BASE,
    ok: null,        // null=未探测, true/false
    probedAt: 0,
    lastError: null,
  }

  function status() {
    return { ok: state.ok, probedAt: state.probedAt, lastError: state.lastError, base: state.base }
  }

  function http(method, pathname, body) {
    return new Promise((resolve) => {
      const u = new URL(state.base)
      const payload = body === undefined ? undefined : JSON.stringify(body)
      const req = request(
        {
          hostname: u.hostname,
          port: u.port,
          path: `${PREFIX}${pathname}`,
          method,
          headers: {
            'content-type': 'application/json',
            ...(payload !== undefined ? { 'content-length': Buffer.byteLength(payload) } : {}),
          },
          timeout: 8000,
        },
        (res) => {
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            let json = null
            try { json = text ? JSON.parse(text) : null } catch { /* not json */ }
            resolve({ status: res.statusCode, json, text })
          })
          res.on('error', (error) => resolve({ status: 0, error }))
        },
      )
      req.on('timeout', () => { req.destroy(new Error('timeout')) })
      req.on('error', (error) => resolve({ status: 0, error }))
      if (payload !== undefined) req.write(payload)
      req.end()
    })
  }

  /** 探测 /combos 是否可用（版本 ≥ 2.8.0 才有）。 */
  async function probe() {
    const r = await http('GET', '/combos')
    const ok = r.status === 200 && Array.isArray(r.json?.combos)
    state.ok = ok
    state.probedAt = Date.now()
    state.lastError = ok ? null : `combos ${r.status} ${r.text?.slice(0, 120) ?? ''}`
    return ok
  }

  /** GET /combos → { combos: [...] }。 */
  async function listCombos() {
    const r = await http('GET', '/combos')
    if (r.status === 200 && Array.isArray(r.json?.combos)) return { ok: true, combos: r.json.combos }
    return { ok: false, error: `combos ${r.status}` }
  }

  /** POST /combos → { ok, combos? }。 */
  async function saveCombos(combos) {
    const r = await http('POST', '/combos', { combos })
    if (r.status === 200) return { ok: true, json: r.json }
    return { ok: false, status: r.status, error: r.text?.slice(0, 200) ?? '' }
  }

  /** GET /combos/preview (POST) — 预演一张链条。 */
  async function previewCombos(body) {
    const r = await http('POST', '/combos/preview', body)
    if (r.status === 200) return { ok: true, json: r.json }
    return { ok: false, status: r.status, error: r.text?.slice(0, 200) ?? '' }
  }

  /** GET /subscriptions → { accounts: [...] }。 */
  async function listSubscriptions() {
    const r = await http('GET', '/subscriptions')
    if (r.status === 200 && Array.isArray(r.json?.accounts)) return { ok: true, accounts: r.json.accounts }
    return { ok: false, error: `subscriptions ${r.status}` }
  }

  /** POST /subscriptions/quota {id} → 刷新某账号额度。 */
  async function refreshQuota(id) {
    const r = await http('POST', '/subscriptions/quota', { id })
    if (r.status === 200) return { ok: true, json: r.json }
    return { ok: false, status: r.status, error: r.text?.slice(0, 200) ?? '' }
  }

  /** GET /summary → 整体快照（catalog/settings/egress）。 */
  async function summary() {
    const r = await http('GET', '/summary')
    if (r.status === 200) return { ok: true, json: r.json }
    return { ok: false, status: r.status }
  }

  return { status, probe, listCombos, saveCombos, previewCombos, listSubscriptions, refreshQuota, summary }
}