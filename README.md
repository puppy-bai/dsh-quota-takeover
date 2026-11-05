# dsh-quota-takeover · 额度接力

> 在 [Our Free Model](https://github.com/Ebony-Vinyl/dsh-our-free-model) 之上加一层「接力」：
> 一个平台额度不够就按你设定的顺序换下一个平台；某个平台没有你要的模型就跳过；
> 全都没有就换下一档模型再遍历一遍；实在不行用你指定的兜底模型。
> 任务因额度中断时，自动切到新平台并往中断的会话里发一条「继续」。

设计文档（含需求分析、失败分类表、风险对策、能力边界、终局兜底）：
[`docs/quota-takeover-plugin-design.md`](docs/quota-takeover-plugin-design.md)
上架市场的步骤：[`docs/SUBMISSION.md`](docs/SUBMISSION.md)

## 它做什么

| 你的需求 | 本插件的实现 |
| --- | --- |
| 平台额度不够 → 按我设定的顺序换下一个 | 把「平台顺序 × 模型档」编译成一条有序候选链，写回 OFM 的 combo（`auto:main`），由 OFM 的 `fallback` 策略逐项尝试 |
| 我一直用的模型，别的平台没有就跳过 | 每个「模型档」有别名表；平台模型清单里匹配不到 → 记为 `missing` 并跳过 |
| 全都换完还没有 → 换模型再遍历一遍 | 遍历形状 `tier-major`（档优先）：先全平台找第 1 档，再全平台找第 2 档…… |
| 最后兜底 | `finalResort.fallbackModels`（如 `groq/llama-3.3-70b`）非空 → 编译兜底链；为空 → 进入「等待恢复」 |
| 因额度中断 → 自动换平台并续跑 | 监听 `llm/stream` 的错误终点，分类为额度/限流后写冷却、重编译计划、向该会话 `agent.followup(一条「继续」消息)` |

## 两个半身（为什么必须这样）

```
浏览器（带 DSH 认证 cookie）                插件 host 进程
  │ ① GET /api/our-free-model/combos         │
  │ ① GET /api/our-free-model/subscriptions  │
  │ ② POST /api/quota-takeover/snapshot ────▶│ 编译计划（平台顺序 × 模型档 × 额度 × 冷却）
  │ ③ GET /api/quota-takeover/pending ◀──────│ 待写回的 combos
  │ ④ POST /api/our-free-model/combos        │   （只有浏览器有写权限）
  │ ⑤ POST /api/quota-takeover/applied ─────▶│ 记录已写回
```

OFM 的 API 挂在 harness 的信任围栏后，插件进程内的 `fetch` 一律 401（实测，见设计文档 §12.1）。
所以读账号/额度、写 combos 这两件事只能由浏览器半身代劳；**续跑不受影响**——它是进程内
`agent.followup()`，不经过 HTTP。

## 安装

**前提**：先装好 [Our Free Model](https://github.com/Ebony-Vinyl/dsh-our-free-model)。本插件从它那里取「平台 × 模型 × 剩余额度」，并把接力链写回它的 combos；没有 OFM 时只剩续跑能力，没有可接力的平台。

从市场装（发布后可用）：

```
DSH → Plugins → Discover 里搜 quota-takeover
```

手动装（开发/未发布时）：

```bash
cd ~/.dsh/profiles/desktop
npm i /path/to/dsh-quota-takeover-0.1.0.tgz   # 或把源码目录拷到 node_modules/dsh-quota-takeover

# 然后在 package.json 的 dsh.profile.bundles 数组里追加 "dsh-quota-takeover"
# 被 bundles 引用的包，其自带 cordis.patch.yml 自动生效；
# 别再往 cordis.patch.yml 手写同名条目，否则报 duplicate loader entry id
```

最后**完全退出 DeepSeek Harness 再打开**——host 半身只在进程启动时 `apply` 一次，刷新页面只重载浏览器半身。

装好后的三个检查点：

| 检查点 | 期望 |
| --- | --- |
| 设置 → 「额度接力」 | 页面出现，且没有红色「宿主半身没有加载」告警 |
| 平台顺序 / 模型档 | 列出 channel-pack 里启用的平台与它们的真实模型 |
| `~/.dsh/quota-takeover/journal.jsonl` | 有 `api-mounted`；发生过失败时有 `failure` / `resume` |

运行期数据：`~/.dsh/quota-takeover/{config,plan,bench,resume}.json` + `journal.jsonl`

## 配置

`~/.dsh/quota-takeover/config.json`（也可由设置页「额度接力」写入）：

```jsonc
{
  "enabled": true,
  "platformOrder": ["trae", "minimax", "zcode", "loomy", "raccoon", "gemini"],
  "modelTiers": [
    { "id": "deepseek-flash", "label": "DeepSeek V4.1 Flash", "pinned": true,
      "aliases": ["deepseek-v4.1-flash", "deepseek-v4-flash-0731", "deepseek-flash"] },
    { "id": "glm-flash", "label": "GLM 5.3 Flash", "aliases": ["glm-5.3-flash"] }
  ],
  "traversal": { "order": "tier-major", "maxChainLength": 16, "optimisticOnUnknown": true },
  "finalResort": { "fallbackModels": [], "retryAfterMinutes": 10 },
  "resume": { "enabled": true, "onlyQuotaLike": true, "maxPerSession": 5, "requireCandidateChange": true }
}
```

- **`platformOrder`**：没列出的平台排在后面（`platformPolicy.unknownTail`）。
- **`modelTiers`**：`aliases` 是同一模型在各平台的叫法；匹配时先精确、再去 `-free`/`-preview`/`eac:` 前缀小写比较。
- **`optimisticOnUnknown`**：平台模型清单未知时（本地 `state.json` 不存模型表）先把格子放进链，
  真没有会让 OFM 的 combo 自然失败并前进——**未知 ≠ 不存在**。
- **`resume.requireCandidateChange`**：核心防呆，候选没变就不重复注入「继续」。

## HTTP API（浏览器侧用，带 cookie）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/quota-takeover/status` | 计划 + 桥状态 + 配置 |
| POST | `/api/quota-takeover/compile` | 手动重编译 |
| POST | `/api/quota-takeover/snapshot` | 浏览器推账号/额度/模型快照 |
| GET | `/api/quota-takeover/pending` | 取待写回的 combos |
| POST | `/api/quota-takeover/applied` | 回报写回成功 |
| GET | `/api/quota-takeover/bridge` | 中继健康状况 |
| POST | `/api/quota-takeover/config` | 改配置（合并后重编译） |
| POST | `/api/quota-takeover/bench/clear` | 清空冷却表 |

## 开发

```bash
node --test tests/*.test.js     # 32 个单测（编译器 / 分类器 / 续跑状态机）
node probes/smoke-host.mjs      # 假 ctx 装载 host 半身，跑通中继闭环
node probes/plan-preview.mjs    # 用本地 state.json 预演一次编译
node probes/ofm-probe.mjs <gui 地址>   # 探针：OFM API 可达性（预期 401）
```

## 已知限制

1. **写回依赖 GUI 打开**：浏览器关掉时链停在旧计划上（候选里已带 resolved 模型 id，旧链仍能跑）。
2. **不直接改 OFM 的 settings.json**（除显式 `writeBack.mode: "file"`）：OFM 把设置常驻内存，改盘不热生效且会被下次保存覆盖。
3. **续跑只在「额度/限流」类失败上生效**（`onlyQuotaLike`）；用户主动 abort 绝不续跑。
4. `llm/stream` 目前只观察不改道（探针 4 未验），改道能力留作 M2。
