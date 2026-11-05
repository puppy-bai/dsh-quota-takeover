#!/usr/bin/env node
/**
 * 独立出口自检：在「当前这个 shell」里判断代理是否可用。
 * 用法：node probes/netcheck.mjs
 *
 * 注意：它测的是**你这个终端**的环境，不是宿主进程的。
 * 要看宿主进程的真实出口，重启 DSH 后读 ~/.dsh/quota-takeover/net.json。
 */
import { runNetCheck } from '../src/netcheck.js'

const report = await runNetCheck({ urls: ['https://api.deepseek.com/', 'https://example.com/'] })
console.log('代理变量：', JSON.stringify(report.proxy, null, 2))
for (const e of report.endpoints) {
  const fmt = (r) => (r.ok ? `HTTP ${r.status} (${r.ms}ms)` : `${r.code} ${r.message} (${r.ms}ms)`)
  console.log(`\n${e.url}`)
  console.log(`  走环境代理: ${fmt(e.env)}`)
  console.log(`  直连(无代理): ${fmt(e.direct)}`)
}
console.log(`\n结论：${report.verdict}`)
