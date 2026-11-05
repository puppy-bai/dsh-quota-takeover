/**
 * 持久化与路径辅助。
 * 存储是插件自己拥有的 JSON 文件（原子写、0600），不依赖 harness 服务——与 OFM 一致
 * （dsh-our-free-model/src/store.js）。配置与状态分文件，避免把高基数 / 易腐数据写进设置文档。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/** Same resolution the harness home-paths helper uses: `$DSH_HOME` else `~/.dsh`. */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return path.join(os.homedir(), '.dsh')
}

export const DATA_DIR_NAME = 'quota-takeover'

/** Temp-file + rename atomic writer. */
export function atomicWrite(file, value, { log } = {}) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, file)
  } catch (error) {
    log?.(`quota-takeover: could not persist ${path.basename(file)} (${error?.message ?? error})`)
  }
}

export class JsonStore {
  constructor(file, initial, { log } = {}) {
    this.file = file
    this.value = initial
    this.log = log
    this.disposed = false
    this.timer = undefined
    this.dirty = false
    this.load()
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.value = { ...this.value, ...parsed }
      }
    } catch (error) {
      // 损坏文件：备份后覆盖（不是配置文档时直接重建即可）
      if (error?.code === 'ENOENT') return
      try {
        if (fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`)
      } catch { /* ignore */ }
    }
  }

  get() { return this.value }

  update(patch) {
    if (this.disposed) return this.value
    this.value = { ...this.value, ...patch }
    this.schedule()
    return this.value
  }

  edit(mutate) {
    if (this.disposed) return this.value
    const next = mutate(structuredClone(this.value))
    if (next !== undefined) this.value = next
    this.schedule()
    return this.value
  }

  schedule(delayMs = 500) {
    if (this.disposed) return
    this.dirty = true
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, delayMs)
    this.timer.unref?.()
  }

  flush() {
    if (!this.dirty || this.disposed) return
    this.dirty = false
    atomicWrite(this.file, this.value, { log: this.log })
  }

  dispose() {
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined }
    this.flush()
    this.disposed = true
    this.dirty = false
  }
}

/** `YYYY-MM-DD` in local time. */
export function dayKey(at = Date.now()) {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}