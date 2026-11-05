/**
 * Quota Takeover — plugin entry (Host half).
 *
 * 额度接力：在 Our Free Model 之上提供「平台/模型自动接力 + 回合级续跑」。
 *
 * - 不改 OFM。通过 OFM 的 HTTP JSON API（/api/our-free-model/*）维护 combos 链路，
 *   以及 harness 开放的 agents/llm 接缝观察失败并注入「继续」。
 *
 * 架构（见 docs/quota-takeover-plugin-design.md）：
 *   L1 控制面：计划编译器 Plan Compiler —— 读平台序/模型档/别名表/额度/冷却，
 *             展平成有序候选 → 编译成 combo 链 → 写回 OFM（POST /combos）。
 *   L3 恢复面：续跑监督器 Resume Supervisor —— ctx.inject(['agents']) 观察回合失败，
 *             判定额度型中断 → 冷却/上限/幂等检查 → agent.followup(createUserMessage「继续」)。
 *
 * @module index.js
 */

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import { DEFAULT_CONFIG, readConfig, saveConfig, mergeConfig } from './src/config.js'
import { JsonStore, DATA_DIR_NAME, resolveDshHome } from './src/store.js'
import { createCompiler } from './src/compiler.js'
import { createResumeSupervisor } from './src/resume.js'
import { createOfmClient } from './src/ofm-client.js'
import { createBridge } from './src/bridge.js'
import { runNetCheck, writeNetCheck } from './src/netcheck.js'

export const name = 'quota-takeover'

const PKG_URL = new URL('./', import.meta.url)
const PKG_DIR = fileURLToPath(PKG_URL)

/** Published version of the installed package, read once at load. */
function readPackageVersion() {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')).version ?? '')
  } catch {
    return ''
  }
}
export const version = readPackageVersion()

// eslint-disable-next-line no-unused-vars
const pkgStamp = `${name}@${version}`

/**
 * 依赖声明。
 *
 * 只用必不可能缺失的：llm 与 agents 是本插件存在的前提。
 * - `llm`：经 ctx.on('llm/stream') 观察/改道，或直接读 catalog。
 * - `agents`：观察回合失败并注入「继续」（唯一的续跑执行器）。
 * webServer / credentials 等都走 ctx.get() 或嵌套 ctx.inject（与 OFM 同策略，
 * 见 dsh-our-free-model/index.js:92-113），缺失则对应功能降级而不是整个插件失败。
 */
export const inject = ['llm']

export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console
  const home = resolveDshHome()
  const dataDir = path.resolve(home, DATA_DIR_NAME)
  try {
    fs.mkdirSync(dataDir, { recursive: true })
  } catch (error) {
    logger.warn?.(`${name}: could not create data dir ${dataDir}: ${error?.message ?? error}`)
  }

  // 配置：合并 patch config + ~/.dsh/quota-takeover/config.json
  const patchConfig = readConfig(dataDir, {})          // user config.json overrides
  const cfg = mergeConfig({ ...DEFAULT_CONFIG, ...(config ?? {}) }, patchConfig)

  // OFM 客户端：特性探测 + HTTP 调用，全部集中在此（风险 7.6）
  const ofm = createOfmClient({ logger, home })

  // 持久化
  const bench = new JsonStore(path.join(dataDir, 'bench.json'), {})
  const planStore = new JsonStore(path.join(dataDir, 'plan.json'), {})
  const resumeStore = new JsonStore(path.join(dataDir, 'resume.json'), {})
  const journalStream = fs.createWriteStream(path.join(dataDir, 'journal.jsonl'), { flags: 'a' })
  // 目录被外部删除（清理/迁移）时不要炸掉整个插件
  journalStream.on('error', (error) => logger.warn?.(`${name}: journal write failed: ${error?.message ?? error}`))
  const journal = (entry) => {
    try {
      journalStream.write(JSON.stringify({ at: Date.now(), ...entry }) + '\n')
    } catch { /* best effort */ }
  }

  const onReplan = () => { /* invoked by compiler after a non-empty change; SSE will hook here */ }

  // 浏览器中继桥：OFM 的 API 在信任围栏后（插件进程内 401），只能由带 cookie 的浏览器代劳读写。
  // 见 docs/quota-takeover-plugin-design.md §12。
  const bridge = createBridge({ logger })

  // L1 计划编译器
  const compiler = createCompiler({
    logger,
    cfg: () => cfg,
    ofm,
    bridge,
    bench,
    stores: { plan: planStore },
    journal,
    onReplan,
  })

  // 出口自检：把「宿主进程到底能不能上网」写成一手证据（net.json + journal）。
  // 余额查询失败、上游全挂这类问题，先看这一行结论，别在外部 shell 里猜。
  const netPromise = runNetCheck()
    .then((report) => {
      writeNetCheck(dataDir, report)
      journal({ kind: 'net-check', verdict: report.verdict, proxy: report.proxy.HTTPS_PROXY ?? null })
      return report
    })
    .catch((error) => {
      journal({ kind: 'net-check-failed', error: String(error?.message ?? error).slice(0, 200) })
      return null
    })

  // 初始编译（非阻塞，失败只告警；OFM 未就绪时会在就绪后由 watch 重试）
  compiler.replan({ reason: 'startup' }).catch((error) => {
    logger.warn?.(`${name}: initial plan failed: ${error?.message ?? error}`)
  })

  // L3 续跑监督器 —— 通过嵌套 ctx.inject(['agents']) 装配，避免阻塞 llm 车道。
  // 参考 OFM 自家的 loop-recovery：ctx.inject(['agents'], scope => ...)（pack.js:58274）。
  let resume = null
  try {
    ctx.inject(['agents'], (scope) => {
      const agents = scope.agents
      resume = createResumeSupervisor({
        logger,
        agents,
        cfg: () => cfg,
        ofm,
        bench,
        stores: { plan: planStore, resume: resumeStore },
        journal,
        replan: (opts) => compiler.replan(opts),
      })
      // 绑定活着的会话句柄：agent/created 时记住，disposed 时忘掉。
      try {
        ctx.on('agent/created', (agent) => {
          const key = agent?.id ?? agent?.session?.id ?? agent?.sessionKey
          if (key) resume?.remember?.(key, agent)
        })
        ctx.on('agent/disposed', (agent) => {
          const key = agent?.id ?? agent?.session?.id ?? agent?.sessionKey
          if (key) resume?.forget?.(key)
        })
      } catch { /* 钩子缺失不致命 */ }
      return () => { resume?.dispose?.() }
    })
  } catch (error) {
    logger.warn?.(`${name}: agents service unavailable; auto-resume disabled: ${error?.message ?? error}`)
  }

  // llm/stream 观察：记录落点，并在流以「额度/限流类」error 结束时把失败交给续跑监督器。
  // 观察是零风险的（只透传，不改事件）；改道能力留给 M0 探针 4 的结论。
  try {
    ctx.on('llm/stream', (options, next) => {
      const provider = options?.provider
      const model = options?.model
      const accountId = options?.accountId ?? options?.credentialRef
      const sessionKey = options?.sessionId ?? options?.sessionKey ?? options?.agent?.id
      const start = Date.now()
      let out
      try {
        out = next()
      } catch (error) {
        void reportFailure({ provider, model, accountId, sessionKey, error, resume: () => resume })
        throw error
      }
      return watchStream(out, { provider, model, accountId, sessionKey, start, journal, resume: () => resume })
    })
  } catch (error) {
    logger.warn?.(`${name}: llm/stream hook unavailable: ${error?.message ?? error}`)
  }

  // 内部 HTTP API（供设置页读取）—— 挂 webServer，缺失则只能本地改文件
  try {
    ctx.inject(['webServer'], (scoped) => {
      // ⚠ cordis 把服务挂在**服务名**上：inject(['webServer']) 的回调里是
      // `scoped.webServer`，不是 `scoped.server`。早期版本写了后者（冒烟探针的假 ctx
      // 当时顺着这个错误给的是 `{server}`），真实环境里 server 就是 undefined，
      // 路由压根没注册 —— 表现是「宿主半身没有加载」。
      const server = scoped.webServer ?? scoped.server
      if (!server?.register) {
        logger.warn?.(`${name}: webServer has no register(); settings API not mounted`)
        journal({ kind: 'api-mount-failed', detail: 'no server.register' })
        return
      }
      const api = makeApiHandler({ compiler, cfg, bridge, ofm, bench, planStore, resumeStore, resume, journal, dataDir })
      scoped.effect(() => {
        server.register({ kind: 'prefix', path: '/api/quota-takeover', handler: api })
        journal({ kind: 'api-mounted', path: '/api/quota-takeover' })
      })
    })
  } catch (error) {
    logger.warn?.(`${name}: webServer unavailable; settings API not mounted: ${error?.message ?? error}`)
  }

  return () => {
    try { resume?.dispose?.() } catch { /* ignore */ }
    try { journalStream.end?.() } catch { /* ignore */ }
    for (const s of [bench, planStore, resumeStore]) s?.dispose?.()
  }
}

/** 组装内部 HTTP handler（prefix handler 签名见 dsh-our-free-model/index.js:1725）。 */
function makeApiHandler(opts) {
  const { compiler, cfg, bridge, ofm, bench, planStore, resumeStore, resume, journal, dataDir } = opts
  return async function handler(req, res) {
    // ⚠ prefix handler 拿到的是**完整** req.url（OFM 自己做的是同一件事：
    // 在 url.pathname 里找 marker 再 slice 掉前缀）。早期版本误以为第三个参数
    // 会传 {url, method}，于是 new URL(undefined) 抛错 → 每个路由都 404，
    // 设置页的「尚无快照 / 候选 0」就是这个 bug 的面孔。
    const method = String(req?.method ?? 'GET').toUpperCase()
    const u = new URL(String(req?.url ?? '/'), 'http://127.0.0.1')
    const rp = u.pathname.replace(/^\/api\/quota-takeover/, '').replace(/\/+$/, '') || '/'
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    try {
      if (method === 'GET' && rp === '/status') {
        return send(200, {
          name, version,
          config: cfg,
          plan: planStore.get(),
          bench: bench.get(),
          resume: resumeStore.get(),
          waiting: planStore.get().waiting ?? false,
        })
      }
      if (method === 'POST' && rp === '/compile') {
        const result = await compiler.replan({ reason: 'api', force: true })
        return send(200, result)
      }
      if (method === 'POST' && rp === '/resume') {
        // 手动触发一次续跑（可 fallback 到 bench 上的「重试」语义）
        if (!resume) return send(409, { error: 'resume supervisor unavailable' })
        resume.manualResume?.()
        return send(200, { ok: true })
      }
      if (method === 'POST' && rp === '/config') {
        const body = await readJson(req)
        // 深合并：设置页只发自己动过的键（如 platformOrder），不能把别的字段冲掉
        const merged = mergeConfig(cfg, body ?? {})
        saveConfig(dataDir, body ?? {})
        for (const key of Object.keys(merged)) cfg[key] = merged[key]
        await compiler.replan({ reason: 'config', force: true })
        return send(200, { ok: true, config: cfg })
      }
      if (method === 'POST' && rp === '/bench/clear') {
        bench.edit(() => null)
        bench.update({})
        return send(200, { ok: true })
      }
      // ── 浏览器中继三端点（见 design §12.2） ──────────────────────────
      if (method === 'POST' && rp === '/snapshot') {
        // 浏览器把 channel-pack RPC（账号/模型）+ OFM combos 的结果推上来
        const body = await readJson(req)
        const snap = bridge.ingest({
          accounts: body?.accounts, combos: body?.combos, models: body?.models,
          platforms: body?.platforms, source: body?.source ?? 'browser',
        })
        await compiler.replan({ reason: 'snapshot' }).catch(() => null)
        return send(200, { ok: true, at: snap.at, accounts: snap.accounts.length, combos: snap.combos.length, models: snap.models.length })
      }
      if (method === 'GET' && rp === '/pending') {
        const pending = bridge.peek()
        bridge.takeRefreshRequest()
        return send(200, { pending: pending ? { combos: pending.combos, reason: pending.reason } : null })
      }
      if (method === 'POST' && rp === '/applied') {
        const body = await readJson(req)
        const applied = bridge.markApplied({ combos: body?.combos, hash: body?.hash, sent: body?.sent })
        // OFM 的 buildComboCatalog 会静默剔除它不认识的模型 id（比如官方通道路由不进去时）。
        // 让设置页把「我要求的 vs 它真存下的」差额带回来，面板才能报出来，
        // 否则用户只会看到「兜底没生效」而不知道为什么。
        const dropped = Array.isArray(body?.dropped) ? body.dropped.filter(Boolean) : []
        if (dropped.length) {
          planStore.update((p) => ({ ...(p ?? {}), writeBack: { ...(p?.writeBack ?? {}), dropped } }))
          journal({ kind: 'fallback-dropped', dropped })
        } else if ((planStore.get()?.writeBack?.dropped ?? []).length) {
          planStore.update((p) => ({ ...(p ?? {}), writeBack: { ...(p?.writeBack ?? {}), dropped: [] } }))
        }
        journal({ kind: 'applied', ...applied })
        return send(200, { ok: true, ...applied, dropped })
      }
      if (method === 'GET' && rp === '/net') {
        const report = await netPromise
        return send(200, report ?? { error: 'net check unavailable' })
      }
      if (method === 'GET' && rp === '/bridge') {
        return send(200, bridge.status())
      }
      // 设置页要拿「平台 × 模型」网格来渲染排序界面：直接回中继里最新的快照
      if (method === 'GET' && rp === '/state') {
        const snap = bridge.current() ?? {}
        return send(200, {
          at: snap.at ?? 0,
          source: snap.source ?? null,
          accounts: snap.accounts ?? [],
          models: snap.models ?? [],
          platforms: snap.platforms ?? [],
          combos: snap.combos ?? [],
          bridge: bridge.status(),
        })
      }
      if (method === 'POST' && rp === '/refresh') {
        bridge.requestRefresh()
        return send(200, { ok: true })
      }
      if (method === 'GET' && rp === '/ofm') {
        const status = ofm.status()
        return send(200, { ofm: status })
      }
      return send(404, { error: 'not found' })
    } catch (error) {
      logger.warn?.(`${name}: api error: ${error?.message ?? error}`)
      return send(500, { error: error?.message ?? String(error) })
    }
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) }
      catch (error) { reject(error) }
    })
    req.on('error', reject)
  })
}

/**
 * 透明地观察一条 llm 流：逐事件转发，仅在「以 error 结束」时把 failure 交给续跑监督器。
 * 绝不改写事件、绝不吞异常 —— 观察者不能改变被观察者的语义。
 */
function watchStream(stream, meta) {
  // next() 可能同步返回流，也可能返回 Promise<流>
  if (stream && typeof stream.then === 'function') {
    return stream.then((s) => watchStream(s, meta))
  }
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
    return stream
  }
  const { journal, resume, start, ...rest } = meta
  return (async function* observed() {
    let failure = null
    try {
      for await (const ev of stream) {
        if (ev?.type === 'finish') {
          if (ev.reason?.kind === 'error') failure = ev.reason
          // 宿主的「放大熔断」（#4204）收束时可能是 aborted 而不是 error：
          // 文案里带 rate-limited / stops amplifying 就当作限流故障接住，
          // 用户自己按停的 aborted 不会被误判（它的文案里没有这些词）。
          else if (ev.reason?.kind === 'aborted' && /stops amplifying|rate.?limit|too many requests|限流/i.test(String(ev.reason?.failure?.message ?? ev.reason?.message ?? ''))) {
            failure = { kind: 'error', failure: { ...(ev.reason.failure ?? {}), message: String(ev.reason?.failure?.message ?? ev.reason?.message ?? '') } }
          }
        }
        yield ev
      }
    } catch (error) {
      failure = { kind: 'error', failure: { message: String(error?.message ?? error), code: error?.code, status: error?.status } }
      throw error
    } finally {
      journal?.({ kind: 'stream', provider: rest.provider, model: rest.model, ms: Date.now() - start, failed: Boolean(failure) })
      if (failure) {
        // 不阻塞流关闭；失败上报是旁路
        queueMicrotask(() => {
          // ⚠ resume 在上面被解构出了 rest —— 必须显式带回，
          // 否则 reportFailure 拿不到监督器，静默什么都不做（v0.1.0 的真 bug）。
          void reportFailure({ ...rest, resume, reason: failure })
        })
      }
    }
  })()
}

async function reportFailure(meta) {
  try {
    const supervisor = typeof meta.resume === 'function' ? meta.resume() : meta.resume
    if (!supervisor) return
    const failure = meta.failure ?? meta.reason?.failure ?? (meta.error ? { message: String(meta.error?.message ?? meta.error), code: meta.error?.code, status: meta.error?.status } : null)
    if (!failure) return
    await supervisor.noteFailure({ ...meta, failure })
  } catch { /* 续跑是尽力而为，绝不影响主流程 */ }
}