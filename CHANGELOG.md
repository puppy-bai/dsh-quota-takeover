# Changelog

## 0.1.1 — 2026-11-06

**平台表的自我维护。** 之前平台列表要靠人手工维护：接过的渠道撤了、账号全删了，它还会一直留在顺序里，接力链里也跟着留一串永远失败的格子。这一版让列表能自己收敛，同时保留「我删掉的别自己回来」这个手感。

### 自动清理

- **撤掉的平台自动消失**：连续 `platformPolicy.pruneAfterMisses`（默认 3）轮读不到 → 从 `platformOrder` 里清掉。次数记在 `~/.dsh/quota-takeover/platforms.json`。
  - 一轮**一个平台都没读到**时整轮跳过：那说明中继断了或 OFM 在重启，不是渠道被删了。宁可多留一轮，也不要把好平台删光。
  - `pruneMissing: false` 可关掉自动删除（只标记为「已失效」，由你决定）。
- **0 账号的空渠道自动隐藏**：`pruneZeroAccounts`（默认开）。channel-pack 里 0 账号的渠道不会出现在账号列表里，只有浏览器快照的 `platforms[]` 知道它是 0，所以由设置页直接下发 `/config`，**刷新即生效，不用重启宿主**。
- **自愈**：被自动隐藏的平台后来有账号了 → 自动放回顺序表。**用户手动删掉的不自愈**，避免「删了又冒出来」。

### 手动删除

- 设置页每行常驻红色「删除」（以前要等它变失效才能点）。
- 删除同时写三处：`platformOrder`（移出）、`platformPolicy.hiddenPlatforms`（记住是你删的）、`platformPolicy.excludePlatforms`（**旧版宿主也立刻不再用它接力**）。
- 底部「已隐藏 N 个」可展开点 ↺ 放回。
- 新端点 `POST /api/quota-takeover/platforms/forget`，比前端自己改数组再保存少漏字段。

### 平台发现

- 平台表新增第三处来源：**catalog 里自动发现的通道**（Magpie 接的硅基流动等，形如 `subscription:magpie/siliconflow/…`），不再只认 channel-pack 的账号池与 OFM 聚合渠道。
- 不在 channel-pack 平台表里的通道，也用账号数据现算「N 账号 / M 模型」，不再显示「未探测」。
- 别名匹配最后再按 id 的**最后一段**比较：聚合渠道的 `siliconflow/deepseek-ai/DeepSeek-V3` 能被 `DeepSeek-V3` 命中。

### 修复

- `saveConfig` 改深合并 —— 只写 `platformOrder` 时不再把 `platformPolicy` 的其它开关一起冲掉。
- `index.js` 的 500 分支引用了未定义的 `logger`（会抛 `ReferenceError`，把真实错误盖掉）。
- 设置页「刷新」按钮不再依赖新增端点，走通用 `/config`。

### 兼容

- 新配置项都有默认值，旧 `config.json` 直接可用，不需要迁移。
- 写回仍是「只碰 `auto:` 前缀的链」，用户手工链不受影响。

---

## 0.1.0 — 2026-11-05

首个公开版本。

- **接力链**：按你设定的平台顺序 × 模型档编排一条有序链，写回 Our Free Model 的 `combos`（`combo:auto:main`）。平台没有该模型 / 额度耗尽 / 平台冷却 → 跳过该格。
- **档优先遍历**：先在所有平台找钉住的第 1 档，都没有才换第 2 档，依次下探；也可切 `platform-major`。
- **终局兜底**：`finalResort.fallbackModels` 或官方额度（`deepseek-account/deepseek-flash`）排在链尾；两者都空才进入「等待恢复」。
- **额度中断自动续跑**：监听 `llm/stream` 的错误终点 → 分类为额度/限流 → 写冷却 + 重编译 → 向该会话注入一条「继续」（`source.kind='user'`，与手打同形），并带 `candidateHash` 防呆：候选没变就不重复注入。
- **浏览器中继**：OFM 的 API 在信任围栏后（403/401），所以由页面读 `channel-pack` RPC 与 `combos`，把快照推给宿主半身，再把编译结果写回 —— 插件进程自己不碰 OFM 的 HTTP。
- **设置页**：平台顺序拖拽/上下移、模型档与别名编辑、终局兜底、节奏参数（冷却 / 每会话上限）、事件日志。
- 43 个单测 + 冒烟探针；MIT。
