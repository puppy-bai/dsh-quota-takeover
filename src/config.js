/**
 * 配置模型与加载/保存。见 docs/quota-takeover-plugin-design.md §5.1。
 * 所有字段带默认值；用户 patch 只覆盖存在的键。
 */
import path from 'node:path'
import fs from 'node:fs'
import { atomicWrite } from './store.js'

export const DATA_DIR_NAME_LOCAL = 'quota-takeover'

export const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  enabled: true,

  // 平台（账号渠道）顺序 —— 用户拖拽排序的对象（不复用 OFM 的 providerOrder）
  platformOrder: [],
  platformPolicy: {
    unknownTail: true,        // 未列出的平台：true=排到最后兜底，false=不参与
    excludeAccounts: [],      // 账号 id 通配排除
    excludePlatforms: [],     // 平台（provider id）整体排除
    perPlatformAccountOrder: {}, // 同平台多账号顺序（可选）
  },

  // 模型阶梯：钉住（第一档） + 后续档
  // 模型档（tier）：每档 = 一个用户想「一直用」的模型，aliases 是各平台对它的叫法。
  // 遍历顺序 = 档优先：先在所有平台找第 1 档，再找第 2 档……（用户已确认）
  modelTiers: [
    { id: 'deepseek-flash', label: 'DeepSeek V4.1 Flash', pinned: true,
      aliases: [
        'deepseek-v4.1-flash', 'deepseek-v4.1-flash-free', 'eac:deepseek-v4.1-flash',
        'deepseek-v4-flash', 'deepseek-v4-flash-0731', 'deepseek-flash', 'sn-deepseek-v4-1-flash',
      ] },
    { id: 'glm-flash', label: 'GLM 5.3 Flash',
      aliases: ['glm-5.3-flash', 'glm-5.3-flash-free', 'glm-4.6', 'glm-4.6-flash'] },
    { id: 'minimax', label: 'MiniMax',
      aliases: ['minimax-m2.7', 'minimax-m2.5', 'minimax-m2'] },
    { id: 'any-free', label: '任意免费模型（兜底档）',
      aliases: ['space-bunny-free', 'big-pickle', 'beam-free', 'flint-40b-free'] },
  ],

  // 遍历形状
  traversal: {
    order: 'tier-major',         // tier-major（默认，档优先，用户已确认） | platform-major
    maxChainLength: 16,
    skipTierWhenPinnedMissing: true,
    // 平台模型清单未知时是否乐观入链（未知 ≠ 不存在；真没有就让链路自然失败前进）
    optimisticOnUnknown: true,
  },

  // 额度判定
  quota: {
    freshnessMinutes: 15,
    excludeBelowPercent: 1,      // remainingPercent < 1 视为耗尽
    probeOnPlan: true,           // 编译前按需刷新 quota
    probeBudgetPerHour: 12,
    treatUnknownAsUsable: true,  // 读数缺失/过期 → 仍入链（排最后）
  },

  // 冷却（与 OFM 分类同语义：src/route/classify.js:69-86）
  cooldown: {
    quotaMs: 120000,
    rateLimitBackoff: true,
    authMs: 600000,
    queueMs: 5000,
  },

  // 最后手段（用户已确认）：fallbackModels 非空 → 兜底链；为空 → 等待恢复
  finalResort: {
    fallbackModels: [],
    // 官方额度兜底（用户 2026-11-05 追加）：所有平台/兜底聚合模型都不行时，
    // 最后交给官方账户。id 会写成 `provider/model`，避免与免费通道同名的
    // `deepseek-flash` 撞车（journal 里官方通道 provider=deepseek-account，
    // 模型 id 就是 deepseek-flash）。
    official: {
      enabled: true,
      provider: 'deepseek-account',
      models: ['deepseek-flash'],
    },
    fallbackStrategy: 'fallback',
    retryAfterMinutes: 10,
    maxWaitHours: 6,
  },

  // 回合级续跑
  resume: {
    enabled: true,
    onlyQuotaLike: true,
    maxPerSession: 8,
    maxPerHour: 24,
    minIntervalMs: 3000,
    requireCandidateChange: true,  // 核心防呆：候选没变就不续跑
    respectUserAbort: true,
    prompt: '继续未完成的任务。上一次尝试因上游额度或平台限制被中断；请不要重述已经完成的部分，直接从断点继续。',
    notifyOnGiveUp: true,
  },

  // 写回 OFM
  writeBack: {
    // 'browser' = 由带 cookie 的设置页代为 POST /combos（唯一有权限的通道，见 design §12）
    // 'file'    = 直接改 ~/.dsh/our-free-model/settings.json（需重启 OFM 才生效）
    mode: 'browser',
    target: 'combos',
    prefix: 'auto:',
    mainComboId: 'auto:main',
    perTierCombos: true,
    pruneOrphans: true,
    dryRun: false,
  },
})

export function configFile(dataDir) {
  return path.join(dataDir, 'config.json')
}

export function readConfig(dataDir, fallback = DEFAULT_CONFIG) {
  const file = configFile(dataDir)
  let raw = null
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch { /* absent is normal */ }
  return mergeConfig(fallback, raw ?? {})
}

export function saveConfig(dataDir, patch) {
  const file = configFile(dataDir)
  const current = readConfig(dataDir, {})
  atomicWrite(file, { ...current, ...patch })
}

/** 深层合并已知嵌套对象；标量直接覆盖；数组整体替换。 */
export function mergeConfig(base, patch) {
  if (!patch || typeof patch !== 'object') return structuredClone(base)
  const out = structuredClone(base)
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    const bv = out[k]
    if (bv && typeof bv === 'object' && !Array.isArray(bv) && v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = mergeConfig(bv, v)
    } else {
      out[k] = v
    }
  }
  return out
}