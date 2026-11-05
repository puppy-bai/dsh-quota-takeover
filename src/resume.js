/**
 * L3 续跑监督器。
 *
 * 职责：当一回合以「额度/限流类」失败结束时，自动
 *   1) 把这次失败记进冷却表（bench.json），让 L1 下次编译时避开它；
 *   2) 立即触发一次 replan（换平台/换模型）；
 *   3) 确认候选确实变了（candidateHash 防呆）之后，
 *      向该会话注入一条「继续」的用户消息（与用户手打继续同形）。
 *
 * 注入手段与 OFM 内置的 loop-recovery 完全一致：
 *   agent.followup(createUserMessage({ content:[{type:'text',text}], source:{kind:'user'} }))
 *
 * 安全阀：respectUserAbort（用户自己按停就不续）、maxPerSession / maxPerHour、
 * minIntervalMs、requireCandidateChange（候选没变就不空转）、enabled 开关。
 */
import { classifyFailure, failureOf, ACTION, QUOTA_LIKE } from './classify.js'

export function createResumeSupervisor({ logger, agents, cfg, ofm, bench, stores, journal, replan }) {
  const sessions = new Map()   // key → { attempts, lastAt, hash, pending, giveUp }
  let hourBucket = { start: Date.now(), used: 0 }
  let disposed = false

  const log = (level, msg) => logger?.[level]?.(`[quota-takeover] ${msg}`)

  function keyOf(meta) {
    return meta.sessionKey ?? meta.sessionId ?? meta.agent?.id ?? meta.agent?.session?.id ?? 'unknown'
  }

  function stateOf(key) {
    let s = sessions.get(key)
    if (!s) { s = { attempts: 0, lastAt: 0, hash: null, pending: false, giveUp: false }; sessions.set(key, s) }
    return s
  }

  function hourAllow() {
    const c = cfg().resume ?? {}
    if (Date.now() - hourBucket.start >= 3600_000) hourBucket = { start: Date.now(), used: 0 }
    if (hourBucket.used >= (c.maxPerHour ?? 12)) return false
    hourBucket.used += 1
    return true
  }

  /** 记录一次失败，返回决定（供上层日志/面板）。 */
  async function noteFailure(meta = {}) {
    if (disposed) return { action: ACTION.IGNORE, why: 'disposed' }
    const c = cfg().resume ?? {}
    if (c.enabled === false) return { action: ACTION.IGNORE, why: 'resume disabled' }

    const failure = meta.failure ?? failureOf(meta.reason)
    if (!failure) return { action: ACTION.IGNORE, why: 'no failure' }

    const verdict = classifyFailure(failure)
    // 冷却表：不论是否续跑，先把这次失败记下来，L1 下次就不会再选中它
    if (meta.accountId && meta.model) {
      bench.edit((t) => {
        const k = `${meta.accountId}|${meta.model}`
        const prev = t[k]
        const level = Math.min((prev?.level ?? 0) + 1, 15)
        t[k] = { until: Date.now() + Math.min(verdict.cooldownMs || 0, 30 * 60_000), reason: verdict.kind, level, at: Date.now() }
        // provider 级故障（上游对整个域名限流）：把整个平台一起冷掉，
        // 否则换到同平台的下一个模型还是撞同一面墙。
        if (verdict.scope === 'provider' && meta.provider) {
          const pk = `provider:${meta.provider}`
          const pprev = t[pk]
          t[pk] = {
            until: Date.now() + Math.min(verdict.cooldownMs || 0, 30 * 60_000),
            reason: verdict.kind,
            level: Math.min((pprev?.level ?? 0) + 1, 15),
            at: Date.now(),
          }
        }
        return t
      })
    }

    // 原会话里的 query 需要看得见这次切换
    journal({ kind: 'failure', provider: meta.provider, model: meta.model, accountId: meta.accountId, kindOf: verdict.kind, action: verdict.action, matchedBy: verdict.matchedBy })

    if (verdict.action === ACTION.IGNORE) {
      if (verdict.kind === 'aborted' && c.respectUserAbort !== false) {
        stateOf(keyOf(meta)).giveUp = true
        return { action: ACTION.IGNORE, why: 'user abort' }
      }
      return { action: verdict.action, verdict, why: verdict.matchedBy }
    }

    if (c.onlyQuotaLike !== false && !QUOTA_LIKE.has(verdict.kind) && verdict.action !== ACTION.SWITCH) {
      return { action: verdict.action, verdict, why: `not quota-like (${verdict.kind})` }
    }

    if (verdict.action === ACTION.GIVEUP) {
      log('warn', `放弃自动续跑：${verdict.kind}（${failure.message ?? ''}）`)
      if (c.notifyOnGiveUp) journal({ kind: 'giveup', kindOf: verdict.kind, message: failure.message })
      return { action: ACTION.GIVEUP, verdict, why: verdict.matchedBy }
    }

    // 重新编译，让链避开刚耗尽的平台
    await replan?.({ reason: `failure:${verdict.kind}` }).catch(() => null)

    const plan = stores.plan.get() ?? {}
    const key = keyOf(meta)
    const s = stateOf(key)

    if (s.giveUp) return { action: ACTION.IGNORE, why: 'gave up earlier' }
    if (s.attempts >= (c.maxPerSession ?? 5)) return { action: ACTION.GIVEUP, verdict, why: 'maxPerSession' }
    if (!hourAllow()) return { action: ACTION.GIVEUP, verdict, why: 'maxPerHour' }
    if (Date.now() - s.lastAt < (c.minIntervalMs ?? 3000)) return { action: ACTION.IGNORE, verdict, why: 'minInterval' }

    const newHash = plan.candidateHash ?? null
    if (c.requireCandidateChange !== false && s.hash && newHash && s.hash === newHash) {
      journal({ kind: 'resume-skip', why: 'candidate unchanged', hash: newHash })
      return { action: ACTION.IGNORE, verdict, why: 'candidate unchanged' }
    }

    if (plan.waiting === true) {
      // 用户没配兜底模型且所有平台都耗尽 → 不空转，交给等待/用户
      return { action: ACTION.WAIT, verdict, until: plan.waitUntil, why: 'all exhausted, waiting' }
    }

    return deliver(meta, verdict, plan)
  }

  /** 真正注入「继续」。 */
  async function deliver(meta, verdict, plan) {
    const c = cfg().resume ?? {}
    const key = keyOf(meta)
    const s = stateOf(key)
    const agent = meta.agent ?? agentOf(meta.sessionKey)

    if (!agent || typeof agent.followup !== 'function') {
      journal({ kind: 'resume-skip', why: 'no agent.followup', sessionKey: key })
      return { action: ACTION.IGNORE, verdict, why: 'no agent handle' }
    }
    // 与 loop-recovery 同构的守卫：忙 / 有排队就不塞
    const inbox = agent.inbox
    if (agent.status && agent.status !== 'idle') return { action: ACTION.IGNORE, verdict, why: `agent busy (${agent.status})` }
    if (inbox && (inbox.hasPending || (inbox.nextTurn?.length ?? 0) > 0 || (inbox.nextStep?.length ?? 0) > 0)) {
      return { action: ACTION.IGNORE, verdict, why: 'inbox pending' }
    }

    const lead = plan?.chain?.[0]
    const text = buildPrompt(c.prompt, { verdict, plan, lead, from: meta })
    const message = await makeUserMessage(text)

    try {
      await agent.followup(message)
    } catch (err) {
      journal({ kind: 'resume-error', error: String(err?.message ?? err) })
      return { action: ACTION.IGNORE, verdict, why: 'followup failed' }
    }

    s.attempts += 1
    s.lastAt = Date.now()
    s.hash = plan?.candidateHash ?? s.hash
    stores.resume.update((st) => {
      st.sessions = st.sessions ?? {}
      st.sessions[key] = { attempts: s.attempts, lastAt: s.lastAt, hash: s.hash }
      st.total = (st.total ?? 0) + 1
      return st
    })
    journal({ kind: 'resume', sessionKey: key, attempt: s.attempts, next: lead ? `${lead.platform}/${lead.resolved ?? lead.model}` : '-', kindOf: verdict.kind })
    return { action: ACTION.RESUME, verdict, attempt: s.attempts, next: lead ?? null }
  }

  function buildPrompt(base, { verdict, plan, lead }) {
    const head = lead ? `\n\n（已自动切换到 ${lead.platform} 的 ${lead.resolved ?? lead.model}）` : ''
    const why = `\n（中断原因：${verdict.kind}）`
    return `${base || '继续未完成的任务。'}${why}${head}`
  }

  const liveAgents = new Map()
  function remember(sessionKey, agent) { if (sessionKey && agent) liveAgents.set(sessionKey, agent) }
  function agentOf(sessionKey) { return sessionKey ? liveAgents.get(sessionKey) : undefined }
  function forget(sessionKey) { liveAgents.delete(sessionKey); sessions.delete(sessionKey) }

  /** 面板上的手动「立即接力」。 */
  async function manualResume({ sessionKey, agent } = {}) {
    if (agent) remember(sessionKey, agent)
    const plan = stores.plan.get() ?? {}
    const lead = plan.chain?.[0]
    const verdict = { kind: 'manual' }
    return deliver({ sessionKey, agent, provider: lead?.platform, model: lead?.resolved, accountId: lead?.accountId }, verdict, plan)
  }

  function snapshot() {
    return {
      sessions: Object.fromEntries([...sessions].map(([k, v]) => [k, { ...v }])),
      hourUsed: hourBucket.used,
      attached: [...liveAgents.keys()],
    }
  }

  function dispose() { disposed = true; sessions.clear(); liveAgents.clear() }

  return { noteFailure, manualResume, snapshot, remember, agentOf, forget, dispose }
}

// ── createUserMessage：优先用宿主的，取不到就退回同形对象 ──────────────────
let cachedCreate = null
async function makeUserMessage(text) {
  if (cachedCreate === null) {
    try {
      const mod = await import('@deepseek-ai/dsh-llm')
      cachedCreate = mod?.createUserMessage ?? mod?.default?.createUserMessage ?? false
    } catch {
      cachedCreate = false
    }
  }
  const content = [{ type: 'text', text }]
  if (typeof cachedCreate === 'function') {
    try { return cachedCreate({ content, source: { kind: 'user' } }) } catch { /* fall through */ }
  }
  // 与宿主 createUserMessage 同形的兜底（loop-recovery 也是 kind:'user'）
  return { role: 'user', content, source: { kind: 'user' } }
}
