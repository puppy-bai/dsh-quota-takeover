/**
 * 出口自检（netcheck）
 *
 * 为什么需要它：本插件跑在宿主进程里，这个进程的环境变量（尤其
 * `NODE_USE_ENV_PROXY` + `HTTP(S)_PROXY`）决定了它能不能上网。
 * 一旦代理地址是个死端口，Node 的 fetch 会立刻 ECONNREFUSED ——
 * 而且**只有宿主进程知道**，外部 shell 里跑 curl 得到的是另一套环境，
 * 结论不可信（实测：shell 里 curl 全 000，加 `--noproxy '*'` 又全通）。
 *
 * 所以这里在插件自己的进程里发一次真实的 HTTPS 请求，把
 * 「代理变量长什么样 / 直连能不能通 / 走环境代理能不能通」写进
 * ~/.dsh/quota-takeover/net.json，并在 journal 里留一行摘要。
 * 这是排查「余额查不到」「上游全挂」这类问题时唯一可信的一手证据。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const PROXY_KEYS = [
  'NODE_USE_ENV_PROXY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
]

/** 隐去代理 URL 里的口令，保留 host:port 供定位。 */
export function redactProxy(value) {
  if (!value) return value
  try {
    const url = new URL(value)
    if (url.username || url.password) {
      url.username = '***'
      url.password = '***'
    }
    return url.toString()
  } catch {
    return String(value).replace(/\/\/[^@/]+@/, '//***@')
  }
}

export function proxyEnv(env = process.env) {
  const out = {}
  for (const key of PROXY_KEYS) {
    if (env[key] === undefined) continue
    out[key] = key.includes('PROXY') || key.includes('proxy') ? redactProxy(env[key]) : env[key]
  }
  return out
}

/**
 * 发一次 GET，返回结构化结果（永不抛）。
 * @param {string} url
 * @param {{timeoutMs?: number, env?: Record<string,string|undefined>}} [options]
 */
export async function probeUrl(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 8000
  const started = Date.now()
  try {
    // `env` 里的代理变量只有在 NODE_USE_ENV_PROXY 打开时才被 undici 采信；
    // 要测「直连」就传一个删掉代理变量的 env —— 但不能改 process.env（会影响别的插件），
    // 所以直连用第二个子进程来做，见 probeDirect()。
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return {
      url,
      via: 'env',
      ok: true,
      status: response.status,
      ms: Date.now() - started,
    }
  } catch (error) {
    return {
      url,
      via: 'env',
      ok: false,
      code: error?.cause?.code ?? error?.code ?? error?.name ?? 'UNKNOWN',
      message: String(error?.cause?.message ?? error?.message ?? error).slice(0, 200),
      ms: Date.now() - started,
    }
  }
}

/**
 * 在干净环境（无代理变量）里跑一次同样的请求。
 * 用 `node -e` 子进程实现，避免动 process.env：这是唯一能同时测出
 * 「代理坏了」和「网络本身没问题」的办法。
 */
export function probeDirect(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 8000
  const started = Date.now()
  try {
    const code = `
      const t = Date.now();
      fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(${timeoutMs}) })
        .then(r => { console.log(JSON.stringify({ ok: true, status: r.status, ms: Date.now() - t })) })
        .catch(e => { console.log(JSON.stringify({ ok: false, code: e?.cause?.code ?? e?.name, message: String(e?.cause?.message ?? e?.message ?? e).slice(0,200), ms: Date.now() - t })) })
    `
    const env = { ...process.env }
    for (const key of PROXY_KEYS) delete env[key]
    const stdout = execFileSync(process.execPath, ['-e', code], {
      env,
      encoding: 'utf8',
      timeout: timeoutMs + 4000,
      windowsHide: true,
    })
    const parsed = JSON.parse(stdout.trim().split('\n').pop())
    return { url, via: 'direct', ...parsed }
  } catch (error) {
    return {
      url,
      via: 'direct',
      ok: false,
      code: error?.code ?? error?.name ?? 'UNKNOWN',
      message: String(error?.message ?? error).slice(0, 200),
      ms: Date.now() - started,
    }
  }
}

/**
 * 跑一整套自检：{ at, proxy, endpoints: [{url, env:{...}, direct:{...}}] }
 * 另外给一句人话结论，方便直接显示在设置页上。
 */
export async function runNetCheck(options = {}) {
  const env = options.env ?? process.env
  const urls = options.urls ?? ['https://api.deepseek.com/', 'https://example.com/']
  const endpoints = []
  for (const url of urls) {
    const viaEnv = await probeUrl(url, { timeoutMs: options.timeoutMs, env })
    const direct = probeDirect(url, { timeoutMs: options.timeoutMs })
    endpoints.push({ url, env: viaEnv, direct })
  }
  const proxy = proxyEnv(env)
  const envBroken = endpoints.some((e) => !e.env.ok)
  const directOk = endpoints.every((e) => e.direct.ok)
  let verdict
  if (!envBroken) verdict = 'ok: 宿主进程可以直接访问外网'
  else if (directOk)
    verdict =
      'proxy-dead: 直连正常、走代理失败 —— ~/.dsh/.env 里的 HTTP(S)_PROXY 指向了一个没在监听的端口。' +
      '打开代理客户端，或删掉那几行。'
  else verdict = 'offline: 直连也失败 —— 本机网络/DNS/防火墙问题，与代理无关'
  return { at: Date.now(), proxy, endpoints, verdict }
}

/** 落盘 + 返回结论（写失败不影响主流程）。 */
export function writeNetCheck(dataDir, report) {
  try {
    const file = path.join(dataDir, 'net.json')
    fs.writeFileSync(file, JSON.stringify(report, null, 2), { mode: 0o600 })
    return file
  } catch {
    return null
  }
}
