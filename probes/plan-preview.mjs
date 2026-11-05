/**
 * 用「本地 state.json + catalog.json」跑一次真正的编译，打印接力链。
 * 这是没有浏览器快照时的降级路径，用来检查默认配置是否产出合理结果。
 *
 * 用法：node probes/plan-preview.mjs [config.json 路径]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const { DEFAULT_CONFIG, mergeConfig } = await import('../src/config.js')
const { createCompiler } = await import('../src/compiler.js')

let cfg = DEFAULT_CONFIG
if (process.argv[2]) cfg = mergeConfig(DEFAULT_CONFIG, JSON.parse(fs.readFileSync(process.argv[2], 'utf8')))

const noop = () => {}
const store = { get: () => ({}), update: noop, edit: noop }
const compiler = createCompiler({
  logger: { warn: console.warn, info: console.log },
  cfg: () => cfg,
  ofm: { listSubscriptions: async () => ({ ok: false }), listCombos: async () => ({ ok: false }) },
  bridge: undefined,
  bench: store,
  stores: { plan: store },
  journal: noop,
  onReplan: noop,
})

const accounts = await compiler.readAccounts(cfg)
const table = accounts.map((a) => ({
  provider: a.provider,
  id: a.id,
  enabled: a.enabled !== false,
  models: (a.models ?? []).length,
  source: a._source,
}))
console.table(table)

const { buildChain } = compiler
const plan = buildChain(cfg, accounts, {})
console.log(`\n候选项 ${plan.chain.length} · 排除 ${plan.excluded.length} · waiting=${plan.waiting}`)
for (const [i, c] of plan.chain.entries()) {
  console.log(`  ${String(i + 1).padStart(2)}. [${c.tier}] ${c.platform} · ${c.resolved ?? c.model}  (${c.why})`)
}
const byWhy = {}
for (const e of plan.excluded) byWhy[e.why] = (byWhy[e.why] ?? 0) + 1
console.log('\n排除原因：', byWhy)
if (plan.warnings.length) console.log('告警：', plan.warnings.slice(0, 5))
console.log('\nDSH_HOME =', home)
