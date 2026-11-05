# 额度接力（Quota Takeover）插件 · 需求分析与完整设计方案

> 目标：在 `dsh-our-free-model`（Our Free Model，下称 OFM）之上，新做一个插件，
> 让任务**永不停摆**——某个平台额度/积分耗尽时，按用户设定的顺序自动换平台、
> 换模型，并在对话被中断后自动续跑，做到无缝衔接。
>
> 本文档为**设计方案**，不含实现代码。文中所有对现有能力的判断都给出 `文件:行号` 证据，
> 凡属推断的地方都显式标注「待验证」。

---

## 0. 结论摘要（先看这一页）

| 项 | 结论 |
| --- | --- |
| **可行性** | 高。用户要的 4 条需求里，**请求内故障转移**这一半已经被 OFM 的「combo（降级链）+ adapter 提交规则」实现；缺的是**编排层**（按「平台×模型」二维遍历编译出降级链）与**回合级续跑层**（中断后自动发「继续」）。 |
| **推荐架构** | **B 方案 · 双件套外部插件**：① `计划编译器`（把用户配置编译成 `combo:` 链，写入 OFM 的 combos API）② `续跑监督器`（`ctx.inject(['agents'])` + `agent.followup(createUserMessage)` 注入「继续」）。**不改 OFM 一行代码**，通过它已公开的 HTTP JSON API 与 harness 的 agents 服务协作。 |
| **不建议** | A 方案（自己注册 adapter + 回环 HTTP 转发）：多一跳、要重做流式/用量/思考档位，且无法复刻「首个正文 delta 之前才可切换」的提交规则。C 方案（fork OFM 加策略）：与上游强耦合，每次升级都要 rebase。 |
| **核心洞察 1** | 用户描述的遍历顺序，本质就是一个**嵌套循环**：`for 模型档 in 阶梯: for 平台 in 平台序: 若该平台有此模型则入链`。这个顺序可以直接编译成 OFM 的 combo 链，**需求 1/2/3 在数据面即可满足**。 |
| **核心洞察 2** | 把会话钉在**我们编译出来的链路模型**上，那么「换平台」对 harness 是透明的；续跑监督器只需要发一句「继续」，不需要改会话活动模型——这绕开了最不确定的接口（改活动模型）。 |
| **核心洞察 3（本次新验证）** | harness 给第三方插件开放了 `ctx.on('llm/stream', (options, next) => …)` 这个**真正的请求拦截点**（证据：`dsh-ops/lib/modes/native/read-dedup.js:67-121`，handler 形如 `(options, next)`，可在 `next()` 前后观察或包裹流）。于是 L1 除了「写 combos」还有第二条更直接的路：**在流开始前把这一次请求改道到接力链**——用户连模型都不用重选。 |
| **关键依赖** | OFM ≥ 2.8.0（combos 存在）；`~/.dsh` 下 channel-pack 状态文件；`@deepseek-ai/dsh-llm` 的 `createUserMessage`；harness 的 `agents` 服务。 |
| **必须先验证的 3 个接口** | 见 §10：`ctx.llm` 是否能在进程内调用别的 provider；agent 是否能改当前活动模型；回合失败事件的确切订阅点与 payload。 |
| **工作量** | M0 探针 0.5–1 天 → M1 编译器 1–2 天 → M2 续跑 2–3 天 → M3 UI/观测 2 天 → M4 硬化 1–2 天。 |

---

## 1. 需求分析

### 1.1 原始需求逐条拆解

原文（用户，m00001）：

> (1) 希望可以做一个插件可以在一个平台额度不够的时候按照我设定的顺序自动切换到下一个平台；
> (2) 并且可以设置一直保存的模型，如果另一个平台没有这个模型则跳过，到下一个平台；
> (3) 如果到最后都没有了，则按照我的设定更换模型重新遍历一遍，实现我的任务哪怕一个额度不够了也不会中断；
> (4) 如果因为没有积分或者额度之后任务中断了，可以自动切换模型或者平台并自动发送继续到中断的对话中，实现无缝衔接。

拆成可验收的条目：

| ID | 需求 | 可验收的判定 |
| --- | --- | --- |
| **R1** | 平台按用户设定顺序自动切换 | 平台 A 返回「额度不足」时，**同一个回合内**请求被平台 B 接管；调用方（模型选择器/网关）可见的模型 id 不变；日志里能看到 A→B 的推进记录 |
| **R2** | 钉住模型名；目标平台没有该模型则跳过 | 配置「钉住 = DeepSeek V4.1 Flash」，平台 B 无此模型 → B 被跳过，直接到 C；不得出现「在 B 上用别的模型顶上」 |
| **R3** | 全部翻遍后，按设定换模型再遍历一遍 | 第一档模型 × 全部平台耗尽 → 自动进入第二档模型 × 全部平台；轮次可见、可计数、有上限 |
| **R4** | 因额度/积分中断后，自动换模型或平台并自动向中断的对话发「继续」 | 回合以上游额度错误告终 → 会话空闲后自动注入一条与用户手打「继续」同形的消息 → 新回合在**不同的平台/模型**上继续原任务；有次数上限与退让规则，不无限重试 |

### 1.2 隐含需求（用户没说，但必须处理，否则方案会伤人）

| ID | 隐含需求 | 默认取值（建议，可配） |
| --- | --- | --- |
| N1 | **平台**与**模型**不是两个独立维度：同一模型在不同平台叫不同 id | 需要「模型档（tier）→ 各平台具体 id 的别名表」，见 §6.2 |
| N2 | 额度读数有**新鲜度**问题：刚耗尽 ≠ 一直耗尽（有的按天/按周重置） | 读数 ≤ 15 分钟才用于排序；过期读数不作为排除依据（与 OFM 现有策略一致，`src/combos.js:196-197`） |
| N3 | 「没有额度」与「凭据失效/被封/排队」是不同的病，药也不同 | 分类处理：额度→换平台；凭据→尝试刷新或通知；排队→短冷却重试；区域封锁→换平台 |
| N4 | 续跑必须**幂等、有上限、可停止**，否则会烧钱、刷屏、重复副作用 | 每会话上限 + 全局预算 + 冷却 + 「候选必须发生变化才续跑」 |
| N5 | 用户主动中断（Esc/停止）绝不能被自动续跑 | 只对上游失败续跑；用户中止→不再注入 |
| N6 | 与 OFM 自带的「思考循环自动续跑」不能打架 | 检测同形注入、让位、去重，见 §6.7.4 |
| N7 | 不能破坏 prompt cache | 粘滞策略：优先在同一平台换模型，或对同一候选连续粘滞 N 回合（`stickyLimit`） |
| N8 | 用户要看得见「现在在谁身上、为什么不在别人身上」 | 设置页一张「接力面板」：每格状态（可用/额度耗尽/无此模型/冷却中/凭据异常）+ 原因 + 时间 |

### 1.3 三个语义（用户已确认，2026-11-05）

1. **R3 的「换模型」= 换模型档（默认优先）**，同时支持换供应商车道。**用户拍板**：
   - `traversal.order` 支持 `tier-major` 与 `platform-major` 两种；
   - **默认 `tier-major`（档优先）**：钉住模型轮遍所有平台 → 换下一档 → 再轮遍。
2. **平台顺序用新设置项** `platformOrder`（用户拍板），不复用 OFM 的 `providerOrder`。
   证据：`pack.js:29253-29259` 明确 `providerOrder` 是「供应商开关弹窗拖拽排序」的**纯展示偏好**，
   由 `pool.providerOrder()` / `provider.setOrder`（`pack.js:56062-56065`）驱动。
   写它会让「拖一次顺序」变成改路由行为，故弃用。
3. **全部耗尽时的兜底 = 降到聚合渠道的用户设定模型（用户拍板）**：
   - 新增 `finalResort.fallbackModels`（用户设定的一组兜底模型 id，如 `groq/llama-3.3-70b`、`openrouter/…`）；
   - 模型档×平台全空 → 若 `fallbackModels` 非空 → 编译进入一条用户显式指定的兜底链（走 OFM 的聚合渠道，`README.md:67`）；
   - **若 `fallbackModels` 为空 → 才进入「等待恢复」**（按 `resetsAt` / `retryAfterMinutes` 自动再试，见 §6.2 终局判定）。

### 1.4 非目标（本轮不做）

- 不改 OFM 的解析/流式/思考档位实现。
- 不做多账号的自动注册、刷积分（已有 `auto-checkin.json` 负责每日领取）。
- 不做跨机器的额度池共享。
- 不保证「一定会成功」——只在候选池内尽力；池空时如实告知（对应 OFM 的哲学：`adapter.js:315-322`
  「不假装另一个模型能救这一回合」）。

---

## 2. 现状盘点：OFM v2.8.0 已经有什么

### 2.1 已具备的能力（可直接复用）

| 能力 | 位置 | 说明 |
| --- | --- | --- |
| 一个 adapter 挂两条 provider route | `index.js:447`、`src/adapter.js:78-85` | `ROUTE_MAIN='our-free-model'`、`ROUTE_REGION='our-free-model-region'` |
| **降级链（combo）** | `src/combos.js`、`README.md:69` | 一个「模型名」其实是一条有序链；链接在吐正文前失败会被整段丢弃，切换对调用方不可见 |
| 链路候选排序策略 | `src/combos.js:37` | `fallback` / `round-robin` / `smart` / `usage` / `pace` |
| **配额驱动的排序** | `src/combos.js:192-229` | 读 `options.quota[row.id]`：要求 15 分钟内、`status ∈ {ok, available}`、`windows[].remainingPercent` 合法；`exhausted` 排最后并被过滤 |
| 配额数据的真实来源 | `src/core.js:299`、`src/subscription-completion.js:471-480` | `subscriptionRuntime.routingQuota()`：把 `subscription:<账号id>/<模型id>` 映射成 `{status, checkedAt, windows:[{kind, remainingPercent, resetsAt, windowSeconds}]}` |
| 请求内故障转移 | `src/adapter.js:247-332` | `runCombo` 循环候选，`result.advance===true` 才继续下一个；全链耗尽给出一条明确错误 |
| 提交规则（魂） | `src/adapter.js:258-268`、`300-310` | chunk 先扣在 `held`，**第一个载有答案的 delta** 才 commit；reasoning 不算 commit |
| 单模型内的续写 | `src/adapter.js:633-663`、`src/recovery.js` | 撞输出上限/断流/空停 → 用剩余预算自动续写一次（注释明确：为替代宿主「发送继续」的手动接力，issue #28） |
| 平台内**账号轮换** | `pack.js:29944-29950`、`pack.js:28697-28700`、`pack.js:28015` | `getAvailableAccount(provider, modelId, tried)`：按 `modelRateLimits[modelId]` 的 `resetsAt` 判可用；没有备用账号时抛 `LlmError(..., 'QUEUE')` |
| 失败分类与冷却 | `src/route/classify.js:46-136`、`src/http.js:28-114`、`src/failure.js:17-35` | `FAILURE_KIND`（billing/rate_limit/auth/permission/overloaded/...）、`FAILURE_SCOPE`（request/account/provider/transient）、长冷却 2min / 短冷却 5s / 默认 30s / 限流指数退避 2s→5min |
| 隐藏/可见性控制 | `src/store.js:270-303` | `hiddenModelIds` 等（仅广告层，不移除 catalog） |
| 浏览器 JSON API | `index.js:1413-1417`、`1776-1902` | 见 §2.2 |
| 事件流 | `index.js:1417` | `GET /api/our-free-model/events`（SSE，热重载/拓扑推送） |
| 本地 OpenAI 兼容网关 | `README.md:72`、`src/chan-relay.js` | 账号渠道自带网关默认 `127.0.0.1:8326`；OFM 另有转发口与中继口 |
| **回合级自动续跑的先例** | `pack.js:58164-58279` | `installLoopResume(ctx)` → `ctx.inject(['agents'])` → `agent.followup(createUserMessage({content:[…], source:{kind:'user'}}))`；仅对 `REASONING_LOOP_CODE` 生效，上限默认 2（env `DSH_REASONING_LOOP_AUTO_RESUME[_MAX]`） |

### 2.2 OFM 已公开的 HTTP JSON API（集成面）

前缀 `{GUI 基址}/api/our-free-model`（`index.js:1413`）：

| 方法 | 路径 | 用途（对我们的价值） |
| --- | --- | --- |
| GET | `/summary` | 整体快照（含 catalog、settings、egress） |
| GET | `/stats` | 用量统计 |
| GET | `/subscriptions` | **账号（=平台）清单**；`?`/`/discover` 两种 |
| POST | `/subscriptions/quota` | **刷新某账号额度**（`deps.subscriptions.refreshQuota({id, signal})`，`index.js:1806-1809`）→ 返回 `{accounts:[…]}` |
| POST | `/subscriptions/enabled` \| `/remove` \| `/import` | 账号启停等 |
| GET/POST | `/providers` | 聚合渠道（自带 key 的 76 家，`README.md:67`） |
| **GET/POST** | **`/combos`** | **读写降级链**（`index.js:1840-1846`）——本方案的主要写入口 |
| POST | `/combos/preview` | 预演链路（`index.js:1847-1849`） |
| GET | `/pool` | 账号池快照（`index.js:1899`） |
| GET | `/meta` | 版本、feed、更新状态 |
| GET | `/events` | SSE 推送 |

> ⚠️ 这些是**插件自有**路由，不是内核契约。设计上必须做特性探测与降级（§7.6）。

### 2.3 持久化现状

| 文件 | 内容 |
| --- | --- |
| `~/.dsh/our-free-model/settings.json` | OFM 自己的设置（`combos`、`aggregate.providers`、`hiddenModelIds`、`forward`、`streamRecovery`…）；见 `src/store.js:158-265` |
| `~/.dsh/channel-pack/state.json` | 账号池：`{accounts:[{id, provider, nickname, enabled, credentialRef, refreshable, expiresAt, modelRateLimits{…}}], disabledModels, gatewayEnabled, providerOrder}` |
| `~/.dsh/channel-pack/token-ledger.json` | 按天按 `边\|provider\|accountId\|modelId` 记 token/请求/错误/首字/速度 |
| `~/.dsh/channel-pack/auto-checkin.json` | 每日积分领取记录 |
| 锁定表（独立文档） | `pack.js:29294-29298` 说明 `permanentLock` 的权威在独立文档 |

---

## 3. 差距分析：需求 → 现状 → 缺口

| 需求 | 现状 | 缺口 | 由谁补 |
| --- | --- | --- | --- |
| R1 平台顺序切换 | combo 支持任意有序链；账号轮换只在**同一 provider 内**（`getAvailableAccount` 按 provider 过滤） | 没有「跨 provider（平台）的顺序」这个概念；`providerOrder` 只是展示偏好 | **计划编译器**：把平台顺序编译成链 |
| R2 钉模型 + 缺则跳过 | `buildComboCatalog` 会剔除「此刻不在 catalog 里的模型」（`src/combos.js:140-143` 附近注释） | 没有「模型档 → 各平台别名」的映射；没有「钉住」语义（用户配的链不会自动跟随别名） | **计划编译器** + 别名表 |
| R3 换模型重遍历 | combo 是**一维**候选序列；`comboChain` 一次调用只给一个顺序 | 没有「外层阶梯 × 内层平台」的遍历与计数 | **计划编译器**（把二维展平成一维链） |
| R4 额度中断后续跑 | ① 请求内续写（`recovery.js`）② pack 的思考循环续跑（`pack.js:58164+`） | **没有针对「额度/积分」的回合级续跑**；OFM 明确不做宿主层接力 | **续跑监督器** |
| — 观测/可控 | OFM 有 eleven 页设置 + 日志 + SSE | 没有「接力面板」「为什么跳过」的可视化 | **新插件设置页** |

---

## 4. 总体方案

### 4.1 三层责任划分

```
┌──────────────────────────── 我们的新插件（Quota Takeover）────────────────────────────┐
│                                                                                      │
│  L1 控制面：计划编译器 Plan Compiler                                                  │
│   · 读平台序/模型阶梯/别名表 + 账号与额度读数 + 冷却表                                 │
│   · 展平成有序候选 → 编译成 combo 链 → 写回 OFM（POST /combos）                        │
│   · 或经 ctx.on('llm/stream') 钩子在流开始前改道（探针 4 通过时启用）                   │
│   · 事件驱动重编译（账号变更 / 额度刷新 / 冷却到期 / 用户改配置）                       │
│                                                                                      │
│  L3 恢复面：续跑监督器 Resume Supervisor                                              │
│   · ctx.inject(['agents'])，观察回合失败与会话空闲                                     │
│   · 判定「额度型中断」→ 冷却/上限/幂等检查 → agent.followup(createUserMessage「继续」)  │
│   · 与 pack 的 loop-recovery 互相让位                                                  │
└───────────────┬──────────────────────────────────────────────┬───────────────────────┘
                │ 写 combos（HTTP JSON API）                    │ 注入用户消息
                ▼                                              ▼
┌──────────────────────────── OFM v2.8.0（不改）──────────────┐   ┌──── harness agents 服务 ────┐
│  L2 数据面：catalog / combos / adapter.runCombo             │   │  会话回合、inbox、followup   │
│   · 首个正文 delta 前可整段丢弃并换候选（提交规则）           │   └─────────────────────────────┘
│   · 候选排序可读配额（smart/usage/pace）                     │
│   · 平台内账号轮换 + 冷却分类                                │
└──────────────────────────────────────────────────────────────┘
```

**为什么这样切？** 因为「请求内切换」必须发生在流式响应已经打开、但还没有交出正文的那个窗口里——
只有 adapter 内部能做（`src/adapter.js:258-268`）。外部插件无论怎么努力，都无法在「已经吐了 200 个字」
之后把这一回合改道；所以外部插件应当**只负责决定候选顺序**（L1）与**决定要不要再开一回合**（L3）。

### 4.2 四个候选架构与选型（A / A′ / B / C）

| 方案 | 做法 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- | --- |
| **A 自建 adapter** | 注册自己的 route，自己实现 `listModels/resolveModel/prepareCall/stream`，逐候选通过回环 HTTP（`127.0.0.1:18899` 转发口 / `8326` 渠道网关）转发 | 完全自主，可做任意策略 | 多一跳；要重做 SSE 解析、usage、思考档位、图片计价；**无法复刻提交规则**（回环那侧已经在吐字）；必须处理转发口的密钥轮换与端口漂移 | ❌ 不推荐。已确认 `ctx.llm` **没有**独立的 `complete()` 接口（只有 `stream` / 模型解析 / 模型列表 / discovery / `registerAdapter`），自建 adapter 仍需自己实现全套流式语义 |
| **B 双件套外部插件** | L1 写 combos + L3 注入「继续」 | 零侵入、复用已验证的降级与配额排序、实现量小、随 OFM 升级基本不坏 | 依赖 OFM 的 HTTP API 形状（需特性探测）；不能控制「已吐字后」的切换 | ✅ **推荐（已采用）** |
| **C fork OFM** | 在 `src/combos.js` 里加二维策略 | 能力最全 | 与上游强耦合、每次升级 rebase、与用户「新做一个插件」的诉求不符 | ❌ |
| **A′ 拦截器（推荐与 B 并用）** | 不注册 adapter，只挂 `ctx.on('llm/stream', …)`：在 `next()` 之前把 `options.model` 改写成我们的 `combo:auto:main`（或直接选自己算出的候选），失败时可在流内重试另一个候选 | 不改用户的会话模型即可接管；策略可插拔；不依赖 OFM 的 combos 写入权限 | 拦截点能否改写 `pinned`（见下方 ⚠️）；流已经交给下游后无法收回，仍受同一提交规则约束 | ✅ **首选**（M0 探针 4 号见分晓） |

> ⚠️ **A′ 的唯一不确定性**：OFM 的 `runStream(options, pinned, snapshot)` 用的是
> `pinned ?? snapshot.catalog.find(c => c.id === baseModelId(options.model))`
> （`src/adapter.js:247-254`）。也就是说——**如果宿主在解析阶段就把 `entry` 定死成 `pinned` 传进来，
> 那么事后改 `options.model` 不会生效**；只有在 `pinned` 为 null 时改写才有效。
> 这一点必须用 M0 探针实测（打印 `options` 与 `pinned`）。若不生效，L1 回到「写 combos」这条路
> （让用户在会话里选用 `combo:auto:main`），B 方案不受影响。

### 4.3 运行时序（一次「额度墙」的完整接力）

```
用户任务 ──► 会话模型 = combo:auto-main（我们编译出来的链）
   │
   ├─ 候选1（lobsterai / deepseek-v4.1-flash）→ 429 insufficient_quota（未吐正文）
   │     adapter 丢弃整段，advance=true
   ├─ 候选2（trae / deepseek-v4.1-flash）→ 正常吐字 → 本回合归调用方 ✅
   │
   │  （L3 观察到候选1的失败 → 写冷却表 → 触发 L1 重编译，链头变成 trae）
   │
   若所有候选都失败：
   ├─ adapter 给出 `the chain "auto-main" exhausted every candidate: …`
   ├─ L3 判定为额度型中断 → 检查候选是否变化 + 上限
   │     ├─ 有变化：注入「继续」→ 新回合在新平台上重试
   │     └─ 无变化（池真的空了）：不注入，进入「等待恢复」，通知用户
```

---

### 4.4 harness 扩展点清单（已读代码确证 · 本方案可用的全部接缝）

| 扩展点 | 形态 | 证据 | 本方案用途 |
| --- | --- | --- | --- |
| `ctx.on('llm/stream', handler)` | `(options, next)`，可在 `next()` 前后观察/包裹流 | `dsh-ops/lib/modes/native/read-dedup.js:67-121` | **L1 改道入口**（A′）；也可只做观测（记录每次请求落到了哪个平台/模型） |
| `ctx.on('agent/created' / 'agent/disposed')` | 生命周期 | `read-dedup.js:114-155` | L3 建立/清理每会话状态 |
| `ctx.on('agent/pre-step', async (payload, next) => …)` | 步进前拦截，可 `await next()` | `read-dedup.js:114-155` | 备用的注入时机（比 followup 更早，但需谨慎） |
| `ctx.on('session/event', (session, event) => …)` | 会话事件流 | `dsh-ops/lib/ptc/index.js:289-312,379` | **L3 的主输入**：识别回合结束/失败 |
| `ctx.inject(['agents'], scope => …)` + `agent.followup(message)` | 注入一条用户消息 | `pack.js:58190-58279`（本项目内**已在实际运行**的一等公民代码） | **L3 的续跑执行器** |
| `ctx.llm.registerAdapter(providers, adapter)` | `{listModels, resolveModel, prepareCall, stream}` | `index.js:447`、`src/adapter.js:155-220` | 仅在我们决定自建 route 时才用（A 方案） |
| `ctx.inject(['webServer'], s => s.effect(() => server.register({kind:'prefix', path, handler})))` | 注册 HTTP 路由 | `index.js:1401-1413` | 自己的 `/api/quota-takeover/*` 与 SSE |
| `ctx.slots.inject('settings.section', () => ctx.slots.register({…}, Component))` | 设置页分区（客户端 slot） | `dsh-our-free-model/client.js:7623-7629` | 「接力」设置页与网格面板 |
| `session.append('user/message' \| 'system/message' \| 'request/header', …)` | 会话持久事件追加 | `DSH工具注入实现拆解.md:347-356` | 仅用于审计留痕；**不**用它来造对话轮次 |

**没有找到（不要指望）**：provider-selection middleware、`llm/request` 事件、
`agent.run()` / `agent.resume()` / `session.sendMessage()` / `session.history()`、
主会话的 `session.model = …` / `agent.setModel()`、`ctx.command()`。
→ 这三条恰好解释了为什么我们的 L3 走 `agent.followup`（现成先例）而不是「自己重跑一个回合」。

---

## 5. 数据模型

### 5.1 新插件的配置文件 `~/.dsh/quota-takeover/config.json`

```jsonc
{
  "version": 1,
  "enabled": true,

  // ── 平台（账号渠道）顺序：需要用户拖拽排序的，就是这一项 ──
  "platformOrder": ["lobsterai", "trae", "minimax", "loomy", "zcode", "gemini"],
  "platformPolicy": {
    "unknownTail": true,        // 未列入 platformOrder 的平台：true=排到最后兜底，false=完全不参与
    "excludeAccounts": [],      // 例如 ["qoder-*"]，按账号 id 通配排除
    "perPlatformAccountOrder": {} // 同平台多账号时的偏好（可选）
  },

  // ── 模型阶梯：钉住的那个 + 后续档位 ──
  "modelTiers": [
    { "id": "deepseek-flash", "label": "DeepSeek V4.1 Flash", "pinned": true,
      "aliases": ["deepseek-v4.1-flash", "deepseek-v4.1-flash-free", "eac:deepseek-v4.1-flash"] },
    { "id": "glm-flash", "label": "GLM 5.3 Flash",
      "aliases": ["glm-5.3-flash", "glm-5.3-flash-free"] },
    { "id": "minimax-m2.7", "label": "MiniMax M2.7", "aliases": ["minimax-m2.7"] }
  ],

  // ── 遍历形状 ──
  "traversal": {
    "order": "tier-major",     // tier-major（默认）: 钉住模型轮遍所有平台 → 换下一档
                               // platform-major     : 一个平台上的所有档试完 → 换下一个平台
    "maxChainLength": 16,      // 单条 combo 的最大候选数（防止一次失败尝试链太长）
    "skipTierWhenPinnedMissing": true
  },

  // ── 额度判定 ──
  "quota": {
    "freshnessMinutes": 15,
    "excludeBelowPercent": 1,  // remainingPercent < 1 视为耗尽
    "probeOnPlan": true,       // 编译前按需 POST /subscriptions/quota 刷新
    "probeBudgetPerHour": 12,
    "treatUnknownAsUsable": true // 读数缺失/过期 → 仍然入链（排在最后），宁可试一次
  },

  // ── 冷却（与 OFM 的分类保持同一套语义，见 src/route/classify.js:69-86）──
  "cooldown": {
    "quotaMs": 120000,         // 额度耗尽：长冷却，等下一个周期或让位给别的平台
    "rateLimitBackoff": true,  // 限流走指数退避 2s→5min
    "authMs": 600000,          // 凭据失效：长冷却 + 通知
    "queueMs": 5000            // QUEUE（同平台无可用账号）：短冷却
  },

  // ── 最后手段：阶梯×平台全空之后（用户已确认语义）──
  "finalResort": {
    "fallbackModels": [],       // 用户设定的兜底模型 id（聚合渠道，如 "groq/llama-3.3-70b"）
                                 // 非空 → 编译成兜底链；为空 → 进入「等待恢复」
    "fallbackStrategy": "fallback",
    "retryAfterMinutes": 10,     // 等待恢复模式下每隔多久自动再试一轮
    "maxWaitHours": 6
  },

  // ── 回合级续跑 ──
  "resume": {
    "enabled": true,
    "onlyQuotaLike": true,     // 只对额度/限流/账号类失败续跑，别的错误不装没事
    "maxPerSession": 5,
    "maxPerHour": 12,
    "minIntervalMs": 3000,
    "requireCandidateChange": true, // 候选没有变化就不续跑（核心防呆）
    "respectUserAbort": true,
    "prompt": "继续未完成的任务。上一次尝试因上游额度或平台限制被中断；请不要重述已经完成的部分，直接从断点继续。",
    "notifyOnGiveUp": true
  },

  // ── 写回 OFM ──
  "writeBack": {
    "target": "combos",
    "prefix": "auto:",
    "mainComboId": "auto:main",
    "perTierCombos": true,     // 每个档位额外生成 auto:tier:<id>，方便手动指定
    "pruneOrphans": true,      // 清掉上一代我们生成、这次不再需要的链
    "dryRun": false
  }
}
```

### 5.2 运行时状态（插件自己的目录，全部 0600 原子写）

| 文件 | 内容 | 用途 |
| --- | --- | --- |
| `plan.json` | 上一次编译产物：`{at, chain:[{platform, accountId, model, tier, why}], excluded:[{key, reason, until}], warnings[]}` | 可解释性、面板、重编译 diff |
| `bench.json` | 冷却表 `{"<accountId>/<model>": {level, until, reason, hits}}` | 熔断，避免每回合都撞同一面墙 |
| `resume.json` | 每会话计数 `{sessionId: {attempts, lastAt, injectedIds[], lastCandidateHash}}` | 上限、幂等、防重 |
| `journal.jsonl` | 追加式审计：每次切换/续跑/放弃一行 | 复盘「为什么当时没续上」 |

---

## 6. 详细设计

### 6.1 计划编译器：输入

| 输入 | 来源 | 备注 |
| --- | --- | --- |
| 用户配置 | `config.json` | §5.1 |
| 平台/账号清单 | `GET /api/our-free-model/subscriptions`（失败则退回读 `~/.dsh/channel-pack/state.json`） | 需要 `id / provider / enabled / models[]` |
| 额度读数 | 同上响应内 `quota{status, checkedAt, windows[]}`；必要时 `POST /subscriptions/quota {id}` 刷新 | 与 `src/subscription-completion.js:471-480` 同源 |
| 模型清单与可用性 | `GET /summary`（catalog），或 `POST /combos/preview` | 用来判定「这个平台有没有这个模型」 |
| 冷却表 | 本地 `bench.json`（由 L3 与 L2 的失败信号写入） | |
| 用量 | `GET /stats`、`token-ledger.json` | 用于 `usage`/`pace` 排序与面板 |

### 6.2 编译算法（核心）

```
compile(config, accounts, catalog, bench):
  tiers  ← config.modelTiers（按数组顺序 = 阶梯顺序）
  plats  ← orderPlatforms(config.platformOrder, accounts, config.platformPolicy)
  chain  ← []

  if config.traversal.order == "tier-major":          # 默认，对应 R1/R2/R3 原文
      for tier in tiers:
          for p in plats:
              cell ← resolveCell(p, tier, catalog)     # 别名匹配 → 具体 model id
              if cell == null:  record("missing", p, tier); continue   # R2：跳过
              if !cell.accountEnabled: record("disabled"); continue
              if isExhausted(cell, quota, config.quota): record("exhausted"); continue
              if cooled(cell, bench):  record("cooling", until); continue
              chain.push(cell)
  else:                                                # platform-major
      for p in plats:
          for tier in tiers: …（同上）

  # 未命中任何冷却/耗尽、但读数未知的格子：按 quota.treatUnknownAsUsable 追加到尾部
  # 冷却中的格子：既不丢弃也不前移——记录在 excluded，等冷却到期后由重编译复活
  chain  ← dedupe(chain).slice(0, config.traversal.maxChainLength)

  # 终局判定（用户拍板）：档×平台全空/不足
  if chain.length == 0 或 候选严重不足:
      if config.finalResort.fallbackModels 非空:
          # 编译成另一条兜底链（auto:fallback）：用户显式指定的聚合渠道模型
          chain ← resolveFallback(catalog, config.finalResort.fallbackModels)
      else:
          # 否则进入「等待恢复」：不续跑，按 resetsAt/retryAfterMinutes 定时再试
          return { chain: [], excluded, warnings, waiting: true, waitUntil: nextReset(...) }

  return { chain, excluded, warnings }
```

**三个细节，决定成败：**

1. **别名匹配** `resolveCell(p, tier, catalog)`：
   在该平台（账号）的模型清单里，按 `tier.aliases` 精确匹配；没有则尝试规范化匹配
   （小写、去 `-free`/`-preview` 后缀、去 `eac:` 前缀）。匹配结果记为 `{accountId, modelId}`。
   —— 需求 R2 的「平台没有这个模型就跳过」就落在这里：**匹配失败即跳过，绝不用别的模型顶替**。
2. **冷却中的格子**：不要从链里删掉。删掉会让重编译在冷却到期时需要外部事件唤醒；
   留在 `excluded` 里带 `until`，并注册一个定时器在到期时重编译。链本体里也不放它（否则每回合撞墙）。
3. **链头选择**：`strategy` 用 `fallback`（固定从链头开始）。因为链是**按当下可用性排序**编译出来的，
   所以「从链头开始」= 「从当前最该用的平台开始」，这也让 prompt cache 尽量稳定（粘滞）。

### 6.3 写回 OFM

```
POST {base}/api/our-free-model/combos
{ "combos": [ { "id":"auto:main", "name":"接力链 · 自动", "models":[…], "strategy":"fallback",
                "stickyLimit":1, "enabled":true },
              { "id":"auto:tier:deepseek-flash", "name":"接力 · DeepSeek Flash 跨平台", "models":[…], … } ] }
```

要点：

- **只动 `auto:` 前缀的行**，用户手工建的链一律不碰（`pruneOrphans` 也只删 `auto:` 前缀）。
- 写之前 `GET /combos` 读旧值，做 diff：只在**链内容变化**时写，避免无谓的落盘与拓扑推送抖动。
- 写失败（API 不存在/返回非 200）→ 记 warning、进入「只读模式」，并提示用户：
  「检测不到 OFM 的 combos 接口（版本 < 2.8.0？），接力链无法自动维护」。
- 用户在选择器里选 `combo:auto:main`（OFM 会把它展示为一个虚拟模型）即完成「钉住」。

### 6.3.1 L1 的两条实现路径与选择规则

| | 路径 B1（写 combos） | 路径 B2（llm/stream 改道） |
| --- | --- | --- |
| 做法 | 编译产物写成 `combo:auto:main`，由用户在会话里选用它 | 挂 `ctx.on('llm/stream')`，在 `next()` 前把 `options.model` 改写成我们的链 |
| 用户体验 | 需要**改一次**会话模型（之后永久自动接力） | 什么都不用改，老会话也自动受益 |
| 依赖 | `POST /api/our-free-model/combos` 可用 | 改写是否生效取决于 `pinned`（§4.2 ⚠️） |
| 失败影响 | 链没更新 → 回到「原平台重试」，功能退化为无 | 改写被忽略 → 与现状相同，无害 |
| 建议 | **必做**（作为能力的落地形态与可视化的载体） | **M0 探针 4 通过就做**，作为无感接管的增强 |

两条路径共用同一个编译产物（`plan.json`），所以不存在"两套逻辑"的维护成本。


L3 需要把「一次失败」翻译成动作。判据以 `src/route/classify.js:46-136` 的词汇表为基准，
并额外识别 adapter 的全链耗尽错误。

### 6.4 失败分类 → 动作映射（L3 的判据表）

| 观测到的信号 | 归类 | 冷却 | L3 动作 |
| --- | --- | --- | --- |
| `LlmError.code === 'QUOTA_EXHAUSTED'` / HTTP 429 + `insufficient_quota`（`src/failure.js:23`） | billing | `cooldown.quotaMs` | **换平台**：bench 该格 → 重编译 → 续跑 |
| 429 + `rate_limit`/`too many requests`/`quota exceeded` 文案（`classify.js:130-132`） | rate_limit（account 域） | 指数退避 2s→5min | 短等后重试；连续 N 次仍失败则视作额度 |
| `'QUEUE'`（同平台无可用账号，`pack.js:28698`） | queue（account 域） | `cooldown.queueMs` | 优先同平台换账号，其次换平台 |
| `'INVALID_CREDENTIAL'` / 401 / `'no credentials'` | auth | `cooldown.authMs` | 若该账号 `refreshable` 则触发刷新；否则 bench + 通知用户登录 |
| `'REGION_BLOCKED'` / 403 | permission（provider 域） | 长 | 排除该平台（本出口下不可用），换平台 |
| `'TIMEOUT'` / `'TRANSPORT'` / `'SERVER'` | transient | 30s | OFM 自身已有重试（`adapter.js:130`），L3 只在链全空时才介入 |
| `'CONTEXT_WINDOW'` / 400 `CLIENT_ERROR` | request | 无 | **不续跑**（换平台也一样失败），如实报错 |
| 用户中止 / `aborted` | — | — | **不续跑**（N5） |
| `message` 含 `exhausted every candidate: … (429 insufficient_quota …)`（`adapter.js:328-331`） | 链级耗尽 | 按其中每个候选各自的分类 | 重编译看链是否变化；有变化才续跑 |

> 判据要**双通道**：既看结构化 `code`，也看 message 文案——因为 adapter 的链级错误把
> 各候选的原因打包进 message 文本（`adapter.js:324`），没有逐候选的结构化返回。

### 6.5 回合级续跑状态机（L3）

```
                  ┌──────────────┐
   加载/会话创建 →│    IDLE      │◄──────────── 用户新输入（observeInput）
                  └──────┬───────┘
                         │ 观察到回合以上游失败结束（observeFailure）
                         ▼
                  ┌──────────────┐  非额度类 / 用户中止 / 已吐正文失败 → 回 IDLE
                  │  CLASSIFY    │
                  └──────┬───────┘
                         │ 额度类
                         ▼
                  ┌──────────────┐   额度读数变为可用 / 链重编译后候选变化
                  │  REPLAN      │──► 触发 L1 重编译（写 combos + bench）
                  └──────┬───────┘
                         ▼
        ┌────────────────────────────────────┐
        │  GATE（全部通过才注入）             │
        │  · enabled && onlyQuotaLike 命中    │
        │  · agent.status === 'idle'          │
        │  · inbox 无 pending/nextTurn/nextStep│
        │  · attempts < maxPerSession/小时    │
        │  · now - lastAt ≥ minIntervalMs     │
        │  · candidateHash ≠ lastCandidateHash│
        │  · 该会话不是用户主动停止            │
        └──────────────┬─────────────────────┘
                       │ 通过
                       ▼
              ┌────────────────┐   注入成功 → attempts++，记 message.id
              │   RESUME(n)    │   （agent.followup(createUserMessage(...))）
              └───────┬────────┘
                      │ 新回合开始（observeInput 看到我们注入的 id → 复位）
                      │ 再次失败 → 回 CLASSIFY
                      ▼
              ┌────────────────┐
              │  GIVE_UP       │  任一闸门不过 → 不注入；notifyOnGiveUp 时发通知 + 面板红条
              └────────────────┘
```

#### 6.5.1 注入方式（照抄已被验证的形态）

```js
// 与 vendor/channel-pack/src/loop-recovery.ts（pack.js:58190-58245）同形
const message = createUserMessage({
  content: [{ type: 'text', text: config.resume.prompt }],
  source: { kind: 'user' },          // 与用户手打「继续」同形：UI/落盘/重放全走既有路径
})
agent.followup(message)
```

安装方式同样是 `ctx.inject(['agents'], scope => { … })`（`pack.js:58274`），并复用它的守卫：
`agent.status !== 'idle'`、`agent.inbox.hasPending`、`nextTurn/nextStep` 非空则不注入。

#### 6.5.2 `candidateHash`：本方案最重要的防呆

「续跑」的风险不是次数多，而是**续跑了却没有变化**——同一句话在同一个耗尽的平台上重试，
既浪费时间又烧配额。因此：

```
candidateHash = sha256(前 4 个候选的 (accountId|modelId) 序列)   # 来自 plan.json
```

只有 `candidateHash` 变化（或该会话首次出现）才允许注入。这自动带来两个正确行为：

- 池里还有别的平台 → 重编译后链头变了 → 允许续跑；
- 池真的空了 → 哈希不变 → 不续跑，转而进入「等待恢复 / 通知」。

#### 6.5.3 幂等与去重

- 注入前把 `message.id` 写入 `resume.json.injectedIds`；`observeInput` 看到该 id 时清 `pending` 并**不**重置 attempts（这次是我们的续跑，不是用户新指令）。
- 若 `observeInput` 看到的是**非我们注入**的 id，则视作用户新输入 → attempts 归零、`lastCandidateHash` 清空。

#### 6.5.4 与 pack 的 loop-recovery 让位（N6）

`pack.js:58166` 的续跑文案是固定字符串，且只对 `REASONING_LOOP_CODE` 生效。因此：

1. 我们只在**额度类**失败时动作，天然与它不重叠；
2. 但仍要防撞车：注入前检查 `inbox` 是否已有 pending（它的守卫与我们的相同），
   并记录「最近 5s 内是否已有他人注入」；若是，则本轮退让，`minIntervalMs` 后重判；
3. 允许用户在设置页里把我们的续跑关掉，或用 `DSH_REASONING_LOOP_AUTO_RESUME=false` 关掉它的。

### 6.6 请求内（L2）与回合级（L3）的分工边界

| 情形 | 谁处理 | 用户感知 |
| --- | --- | --- |
| 候选在**吐正文前**失败 | L2（adapter.runCombo） | 无感，同一回合内换平台 |
| 候选失败但**已经吐了正文** | L2 不再切换（`adapter.js:311-314` 的语义：答案已经归调用方），交给 `recovery` 的单模型续写预算 | 可能看到半截答案后本回合结束 |
| 单模型内断流/空停/撞输出上限 | L2（`adapter.js:633-663`） | 自动续写，基本无感 |
| **整条链耗尽** / 回合以上游额度错误结束 | **L3** | 会话短暂停顿后自动「继续」，面板提示「已从 A 接力到 B」 |
| 全部平台都空 | L3 的 `GIVE_UP` | 明确告知 + 等待恢复倒计时 + 一键重试按钮 |

### 6.7 可观测性与 UI

**设置页「接力」分区（新插件的 web 视图）**

1. **网格面板**：行 = 模型档，列 = 平台；每格显示状态与原因：
   `✓ 可用（剩 63%，5.2h 后重置）` / `✗ 额度耗尽（2h 后重置）` / `— 此平台无该模型` / `⏸ 冷却中（还有 42s）` / `⚠ 凭据异常`。
2. **顺序编辑**：拖动列调整 `platformOrder`；拖动行调整模型阶梯；勾选「钉住」。
3. **实时事件**：订阅 `GET /api/our-free-model/events`（SSE）+ 我们自己的推送，展示「刚刚从 X 切到 Y（原因）」。
4. **续跑历史**：最近 20 次注入（时间、会话、原因、链头 before/after、结果）。
5. **一键动作**：立即重编译 / 立即续跑 / 暂停 30 分钟 / 清空冷却表。

**日志**（沿用 OFM 的措辞风格，`src/adapter.js:325` 的 warn 格式）：

```
quota-takeover: chain "auto:main" replanned — head lobsterai/deepseek-v4.1-flash → trae/deepseek-v4.1-flash (reason: quota exhausted, resets 2.1h)
quota-takeover: session s-8f3 resumed (2/5) — candidate hash 4a91c2 → b7e310
quota-takeover: session s-8f3 gave up — every platform is exhausted; next retry in 10m
```

---

## 7. 风险与对策

| # | 风险 | 后果 | 对策 |
| --- | --- | --- | --- |
| 7.1 | 无限续跑 / 烧配额 | 成本、刷屏、掩盖真实错误 | 每会话上限 + 每小时上限 + `minIntervalMs` + **`requireCandidateChange`** + `GIVE_UP` 通知 |
| 7.2 | 重复副作用（续跑让模型重做已完成的工具调用） | 重复写文件/重复发请求 | ① 提示词显式要求「不要重述已完成的部分」② 只在**上游失败**时续跑（工具执行失败不续跑）③ 续跑前把上一回合的 `finish` 原因写进 journal 供复盘 |
| 7.3 | 与 pack 的思考循环续跑互相触发 | 两条消息叠发 | §6.5.4 让位规则；共用 inbox 守卫；提供总开关 |
| 7.4 | prompt cache 全丢 | 变慢、变贵 | 默认 `tier-major` 但链内**粘滞**：同一候选连续 N 回合优先（`stickyLimit`）；重编译只在**真的有变化**时写；面板显示「本次切换会重建缓存」 |
| 7.5 | 「额度耗尽」判定错误（把健康平台踢出） | 可用性反而下降 | ① 15 分钟新鲜度门槛（与 `src/combos.js:196-197` 一致）② `treatUnknownAsUsable` 默认 true ③ 冷却表可一键清空 ④ 全部排除时**回退到完整链**（宁可试，不可空） |
| 7.6 | OFM 升级改变 API 形状 | 接力链停止维护 | 启动时特性探测 `GET /combos`（404/形状不符 → 只读模式 + 显式告警）；把 API 访问集中在一个 `ofm-client.js` 里；设置页显示「兼容的 OFM 版本 ≥ 2.8.0」 |
| 7.7 | 依赖 `~/.dsh/channel-pack/*` 文件形状 | 读数错 | 文件只作**降级**来源；主来源是 HTTP API；解析容错（缺字段即视为 unknown，不抛异常） |
| 7.8 | 并发会话 | 会话 A 的续跑改了链，影响会话 B 正在跑的回合 | 链的编译产物**写时快照**；每个回合开始时读一次 plan；重编译不打断进行中的回合（OFM 的 catalog 是快照式的，`adapter.js:194-200` 的注释正是为此） |
| 7.9 | 多账号同平台 | 顺序含义模糊 | `platformOrder` 是平台级；平台内账号顺序交给 OFM 自己的 `getAvailableAccount`（`pack.js:29944`）；可选 `perPlatformAccountOrder` 覆盖 |
| 7.10 | 用户中止被当成失败 | 自动续跑违背用户意图 | 记录 abort 来源；`respectUserAbort` 默认 true；中止后 60s 内不注入 |
| 7.11 | 安全：本插件要调本地 HTTP 且能注入消息 | 权限面变大 | 只访问 `127.0.0.1` 的 GUI 基址；不落地任何凭据（凭据仍由 OFM/宿主凭据库持有）；注入消息不含外部内容；所有注入写 journal 可审计 |
| 7.12 | 环境：workspace-write 沙箱下 shell 无法启动（本机 exit `0xC0000142`，8/8 失败） | 开发/自测受阻 | 开发与验证需要 `danger-full-access`（或由用户在外部终端执行）；设计文档与代码可先落地，验证放到放开沙箱时 |

---

## 8. 分期实施计划

| 里程碑 | 内容 | 产出 | 预估 |
| --- | --- | --- | --- |
| **M0 探针** | 跑完 §10.2 的 4 个探针（`llm/stream` 能否改道 / 失败 payload / combos 写回 / 续跑注入），把结论填回 §10 | 一页结论 + 选型确认（B1 必做，B2 视探针 4） | 0.5–1 天 |
| **M1 计划编译器** | 账号/额度/目录采集 → 别名解析 → 嵌套循环展平 → 写回 combos；`plan.json` + 设置页网格（只读） | 需求 **R1/R2/R3** 达成（数据面） | 1–2 天 |
| **M2 续跑监督器** | agents 注入 + 分类表 + 状态机 + 冷却表 + 上限/幂等/防呆（含 `candidateHash`） | 需求 **R4** 达成 | 2–3 天 |
| **M3 UI 与观测** | 网格可编辑、顺序拖拽、续跑历史、通知、journal | 可用性 | 2 天 |
| **M4 硬化** | 特性探测/降级、并发、异常路径、E2E 回归、文档 | 可长期使用 | 1–2 天 |

**建议的 M1 验收脚本**（不依赖真实平台）：

1. 把一个测试账号的 `modelRateLimits` 改成未来时间戳（模拟额度耗尽）→ 重编译 → 断言该格被排除、链头改变；
2. 把某平台的模型清单改成不含钉住模型 → 断言该平台被跳过（R2）；
3. 把阶梯第一档全部平台都置为耗尽 → 断言链头进入第二档（R3）；
4. 全部平台耗尽 → 断言 `finalResort.fallbackModels` 生效且**不**续跑（若配置了兜底则进入兜底链；未配置则进入等待恢复）。

**M2 验收脚本**：用一个假的本地 OpenAI 端点返回 `429 insufficient_quota`，
断言：注入恰好一次「继续」、有上限、`candidateHash` 不变时**不**注入、用户中止后**不**注入。

---

## 9. 已确认的决策（2026-11-05）

用户已拍板以下 3 项（本节替代原先的「未决问题」）。第 4-5 条仍可后续加，默认不做：

1. **R3「换模型」= 换模型档，档优先**（默认 `tier-major`），同时支持换供应商车道。
2. **平台顺序用新设置项** `platformOrder`，不复用 OFM 的 `providerOrder`。
3. **全部平台耗尽 → 降到聚合渠道的用户设定兜底模型**；若 `finalResort.fallbackModels` 为空 → 才进入「等待恢复」。
4. （未启用）续跑提示词：暂用一句「继续」，不做 JSON 检查点（宿主层拿不到上一回合部分正文）。
5. （未启用）仅对特定会话/工作区启用的白名单。

---

## 10. 接口验证结论与剩余探针

### 10.1 已经有答案的（本轮读代码确证）

| 问题 | 结论 |
| --- | --- |
| `ctx.llm` 有没有「直接发起一次 completion」的接口？ | **没有**。可确认的只有 `registerAdapter` / `registerConfigurableProviders` / `registerModelDiscovery` / `stream` + 模型解析与列表（`index.js:445-469`、`adapter.js:155-220`）。→ A 方案必须先自建 adapter |
| 有没有「按请求选 provider/model / 改道」的钩子？ | **有**：`ctx.on('llm/stream', (options, next) => …)`（`read-dedup.js:67-121`）。这是本方案 L1 的第二条实现路径（A′） |
| 回合失败/中断怎么暴露？ | 流末 chunk：`{type:'finish', reason:{kind:'error'\|'aborted', failure:{message, code}}}`（`adapter.js:277-330`、`486-489`、`665-721`）；另有 `ctx.on('session/event')`、`agent/pre-step`、`agent/created/disposed` 可用 |
| 有没有专门的「quota exhausted」事件？ | **没有**。只能按 `failure.code` / `status` / message 文案分类（§6.4 的双通道判据） |
| 能否读历史 / 追加消息 / 重跑回合？ | `session.history()` / `sendMessage()` / `agent.run()` / `agent.resume()` 均**未证实存在**；`session.append(…)` 只用于持久事件（不是造对话轮次）。SDK 层的 `session/prompt|resume|wait` 属外部 SDK 协议，不能证明普通 Cordis 插件可调 |
| 运行期能否改主会话的活动模型？ | **未证实**（没有 `agent.setModel()` / `session.model=`）；已确认的模型切换只有：adapter 内部候选链、子 agent 的 route policy、新会话重新选模型。→ 这正是「核心洞察 2」（把会话钉在链上）必须成立的理由 |
| 斜杠命令 API？ | **未找到** `ctx.command()` / `ctx.commands.register()` 的可用证据，本方案不依赖它 |
| 设置页怎么加？ | 客户端 slot：`ctx.slots.inject('settings.section', …)`（`client.js:7623-7629`），package.json 里 `dsh.client = {platform:'web', immediately:true}` |
| 自动续跑真的可行吗？ | **可行，且本项目里已在跑**：`vendor/channel-pack/src/loop-recovery.ts`（`pack.js:58164-58279`）已经在用 `ctx.inject(['agents'])` + `agent.followup(createUserMessage({source:{kind:'user'}}))` 注入「继续」。这是 L3 的直接先例 |

### 10.2 M0 仍需实测的 4 个探针

| # | 探针 | 期望/分支 |
| --- | --- | --- |
| 4 | 在 `ctx.on('llm/stream', (options, next) => …)` 里打印 `options`，确认 `pinned` 的来源；然后试改 `options.model` 看是否真的换道 | 生效 → 走 A′（用户无需改模型）；不生效（`pinned` 已定死）→ 回到「写 combos + 用户选用链模型」 |
| 5 | 手工制造一次额度失败（把某账号 `modelRateLimits[model]` 改成未来时间戳），观察 `finish` chunk 与 `session/event` 的真实 payload | 定稿 §6.4 判据表 |
| 6 | `GET /api/our-free-model/combos` → 改一条 → `POST` 回写，确认选择器出现 `combo:auto:test`，并确认不影响用户手工建的链 | 定稿 §6.3 写回协议 |
| 7 | 触发一次续跑，确认注入的消息在 UI 里与用户手打「继续」完全同形，且 `observeInput` 能识别出「这是我自己注入的」 | 定稿 §6.5.3 幂等 |

> 探针 5–7 的失败模式都要"如实记录并降级"：宁可少做一半功能，也不要出现
> 「续跑了但没换平台」（烧配额、刷屏）或「把用户手工链改坏了」。

---

## 11. 附录：证据索引

**OFM 侧**
- `src/adapter.js:78-85`（route 常量）、`94`（`FreeModelAdapter`）、`121-135`（重试策略，明确不重试 429/额度）、`155-192`（`listModels`/`resolveModel`）、`199-206`（`prepareCall` → `{model, stream}`）、`247-332`（`runStream`/`runCombo`，提交规则与 `advance`）、`600-679`（续写与终点判定）
- `src/combos.js:37`（策略枚举）、`77-89`（归一化）、`140-143`（只保留 catalog 里存在的模型）、`187-247`（`comboChain`/`pruneRotation`，配额排序）
- `src/core.js:299-301`（把 `routingQuota()` 交给 combo）、`src/subscription-completion.js:471-480`（`subscription:<账号id>/<模型id>` → 配额窗口）
- `src/failure.js:17-35`、`src/http.js:28-114`、`src/route/classify.js:46-136`（失败词汇表/域/冷却/退避）
- `src/recovery.js`（单模型续写与检查点）、`src/store.js:24-31`、`158-265`、`270-303`（设置与可见性）
- `index.js:447-458`（注册）、`1413-1419`（路由挂载）、`1776-1902`（JSON API 全表，尤其 `1840-1849` combos）
- `README.md:67`（聚合 76 家）、`69`（路由/降级链）、`72`（十渠道 + 本地网关 8326）、`74`（十一页设置）

**channel-pack（OFM 内 vendor）**
- `pack.js:28015`（`queue-rotation.ts`）、`28697-28700`（QUEUE 与备用账号）、`29944-29950`（`getAvailableAccount` 的额度闸门）、`29253-29259`（`providerOrder` 仅为展示偏好）、`56062-56065`（`provider.setOrder`）、`58164-58279`（loop-recovery：`installLoopResume` / `agent.followup` / `createUserMessage(source.kind='user')`）
- `~/.dsh/channel-pack/state.json`、`token-ledger.json`、`auto-checkin.json`

**harness 扩展点（第三方插件可用，本轮读代码确证）**
- `dsh-ops/lib/modes/native/read-dedup.js:67-121`（`ctx.on('llm/stream', (options,next))`）、`114-155`（`agent/created`、`agent/pre-step`、`agent/disposed`）
- `dsh-ops/lib/ptc/index.js:289-312,379`（`session/event`、`session/disposed`）
- `dsh-our-free-model/index.js:1401-1413`（`ctx.inject(['webServer'])` + `server.register({kind:'prefix'})`）、`client.js:7623-7629`（`ctx.slots.inject('settings.section')`）
- `selfcheck/pkgs/x/dsh-ops-0.4.4/package/docs/DSH工具注入实现拆解.md:163-169`（`Service` + `static inject`）、`:337-360`、`:698-710`（`ctx.llm.stream(request)` 与 `session.append(…)`）
- `@deepseek-ai/dsh-sdk-protocol/lib/types/types.d.ts:14-24`（`InitializeParams{provider,model,…}`）、`:34-39,52-64,128-144`（`session/prompt|resume|wait`，外部 SDK 层）
- `@deepseek-ai/dsh-tool-subagent/lib/index.js:46-97,285-293`（子 agent 的 provider/model route policy）
- ⚠️ `@deepseek-ai/dsh-llm` / `dsh-agent` / `dsh-session` / `dsh-commands` / `dsh-credentials` 的包与 `.d.ts` **不在本机安装目录**（profile 的 `@deepseek-ai/` 下只有 cosmokit、dsh-brand、dsh-sdk-protocol、dsh-subagent-codex、dsh-tool-subagent、schemastery），上述结论来自真实插件用法与已装文档，未证实者已在 §10.1 显式标注

**环境**
- cwd：`C:\Users\Puppy\Documents\deepseek-harness\default-workspace`；文件策略 `workspace-write`；GUI `http://127.0.0.1:39926`
- 限制：`workspace-write` 下 shell 无法启动（`exit 0xC0000142`），需 `danger-full-access` 才能跑命令

---

## §12 M0 探针结果与架构修正（2026-11-05 实测）

### 12.1 探针 1（OFM HTTP JSON API 可达性）— **失败，但结论比失败更有价值**

用 `node probes/ofm-probe.mjs http://127.0.0.1:32829` 直连 `GET /api/our-free-model/summary`：

```
✖ GET /summary — 401  {"error":"unauthorized"}
✖ GET /combos — 401   {"error":"unauthorized"}
✖ GET /subscriptions — 401
```

**原因（已读代码确证，不是猜）**：OFM 的整个 API 前缀挂在 harness 的信任围栏后面 ——
`dsh-our-free-model/index.js:1422-1427` 每个请求先过 `rejectionFor(req, fenceConnection, …)`；
`src/trust.js:87-125` 的判定顺序是「有 `connection` 服务就**完全采信它的 `admit(req)`**」，
而 `connection.admit` 检查的是 DSH 的**浏览器认证 cookie**。插件进程内发起的 HTTP 请求没有这个 cookie，
于是被 401。`src/trust.js:9-17` 的注释也写明这是两层设计：第一层就是「composition 自己的 `connection` 服务」。

**这直接推翻了设计初稿里 L1「host 直接调 OFM HTTP API 写回 combos」的假设**（原 §6.3.1 路径 B1）。
任何在 `apply()` 里 `fetch('http://127.0.0.1:<port>/api/our-free-model/combos')` 的写法都会 401。

### 12.2 修正后的 L1 写回路径：**浏览器中继（browser-mediated bridge）**

翻遍 `dsh-our-free-model/index.js`：`ctx.provide|ctx.set|provide(` **0 命中** —— OFM 没有把任何服务发布到 Cordis，
所以 host 侧也没有进程内 API 可用（不能 `ctx.get('our-free-model')`）。

唯一同时满足「有权限」与「被官方支持」的通道是**浏览器半身**：

```
 浏览器 (client.js, 带 cookie)
    │ ① GET /api/our-free-model/combos, /subscriptions      ← 有权限
    │ ② POST /api/quota-takeover/snapshot  {combos, accounts}
    ▼
 本插件 host 半身
    │ ③ 编译出计划 → GET /api/quota-takeover/pending 返回待写 combos
    ▼
 浏览器
    │ ④ POST /api/our-free-model/combos  （原样带回 cookie）
    │ ⑤ POST /api/quota-takeover/applied  {ok}
    ▼
 完成一轮接管
```

- **读**：host 也可以退化读盘（`~/.dsh/our-free-model/settings.json` 的 `combos`、`~/.dsh/channel-pack/state.json` 的 `accounts`），
  实测两文件都存在且结构符合预期（`settings.json` 里已有 `combo:recommended-free`，`subscriptions/` 目录为空 —— 账号真相在 channel-pack）。
  但**额度读数是实时的**，只有订阅 API 给得准，所以默认仍走浏览器中继。
- **写**：host 绝不直接写 `settings.json` —— OFM 把 settings 常驻内存，外部改盘不会热生效，且用户下次在设置页点保存会把我们写的内容冲掉。
  只有在用户显式选 `writeBack.mode: 'file'` 时才退化写盘，并在 UI 标注「需重启 OFM 生效」。
- **代价**：接管依赖 GUI 打开（client bundle 在浏览器里跑）。这是硬限制，写进 §12.4 风险。

### 12.3 L3 续跑不受此限制

`agent.followup(createUserMessage(...))` 是进程内调用，不经过 HTTP 围栏；`bench.json` / `plan.json` 是本插件自己的文件。
因此**「额度中断 → 自动续跑」这条主链路在 host 侧完整可用**，不依赖浏览器。
浏览器只在「重新编译链并写回 OFM」时需要在线。

### 12.4 新增风险

| 风险 | 后果 | 对策 |
| --- | --- | --- |
| GUI 关闭时无法写回 combos | 链停在旧计划上，新平台不会被自动选用 | 计划里每个候选都带 `resolved` 模型 id，旧链仍能跑；重开 GUI 后 15s 内自愈；`status.bridge.stale` 在面板上报红 |
| 浏览器中继与用户手改并发 | 短暂不一致 | `POST /combos` 是整表覆盖，合并规则「只替换 `auto:` 前缀行」在 host 侧算好后整表提交；`applied` 带回 OFM 返回的实际列表再比对一次 |
| 探针 4（`llm/stream` 改道）仍未验 | 无法做「不落 combo 也改道」的增强 | 保持 B1 为唯一写回路径；探针 4 降级为 M2 可选增强 |


### 12.5 「平台 × 模型」网格的真实来源（探针 1 之后的第二个发现）

最初假设 host 能直接问 OFM「某个平台有哪些模型」。**做不到**，而且本地也没有现成数据：

- `~/.dsh/channel-pack/state.json` 的账号对象只有
  `{id, provider, nickname, enabled, credentialRef, refreshable, createdAt, expiresAt, modelRateLimits}`
  —— **没有 `models` 字段**；`modelRateLimits` 只记录「撞过墙的模型」，实测 8 个账号里 7 个为空。
- `~/.dsh/our-free-model/catalog.json` 的 `entries` 是**模型 id 数组**（如 `big-pickle`、`beam-free`），不含平台归属。
- `~/.dsh/our-free-model/availability.json` 的 `results` 是**按模型 id** 的可用性探测结果，也不含平台归属。

真正的网格在 OFM 的 `combos.list()` 响应里（`dsh-our-free-model/index.js:1185-1191`）：

```js
models: state().catalog.map(entry => ({ id, name, channel, vision, contextWindow, maxOutput }))
```

订阅型模型的 id 形如 `subscription:<accountId>/<model>`（见 `src/subscription-completion.js:471-480`
里 `routingQuota()` 用的同一套键），于是 `accountId → [model…]` 可以直接从这份列表还原。

因此中继快照从三项扩到四项，`src/bridge.js` 的 `ingest({accounts, combos, models, source})`
与 `src/compiler.js` 的 `enrichAccounts(accounts, catalogModels)` 一一对应：

| 数据 | 来自 | 用途 |
| --- | --- | --- |
| `accounts[]` | `GET /subscriptions` | 启停、额度窗口、重置时间 |
| `combos[]` | `GET /combos` | 合并时保留用户手工链 |
| `models[]` | `GET /combos` 的 `models` 字段 | `subscription:<accountId>/<model>` 还原平台模型清单 |

### 12.5.1 未知模型清单下的乐观入链（`traversal.optimisticOnUnknown`）

浏览器还没推快照时（GUI 没打开 / 刚重启），host 只能读到本地 `state.json`，而它没有模型表。
此时若按「匹配不到就跳过」处理，整条链会变成空的 —— 这不是用户想要的语义。

因此 `appendCell` 增加第三种结局：

```js
if (!modelId && Array.isArray(known) && known.length === 0) {
  // 未知 ≠ 不存在：先把格子放进链，真没有就让 OFM 的 combo 自然失败并前进
  if (config.traversal.optimisticOnUnknown !== false) chain.push({ …, why: 'unverified' })
  return
}
```

这跟 OFM 自己的行为是自洽的：`buildComboCatalog`（`src/combos.js`）会**把此刻不在 catalog 里的模型从链里剔除**，
所以即使我们乐观放进一个该平台不存在的 id，写回后 OFM 也会自动丢掉这一环，链不会卡住。
乐观格子只在「清单未知」时出现；一旦浏览器快照到了，`resolveViaAliases` 会用真实 id 替换它们。

## 13. 能力边界（v0.2.0，按「已验证 / 未验证 / 做不到」三档）

> 这一节是交付时对用户的诚实口径：凡是标「已验证」的都有测试或真机证据；
> 标「未验证」的是代码写了、但没在真实场景里跑过；标「做不到」的是架构或平台限制，不是待办。

### 13.1 已验证能做的

| 能力 | 证据 |
| --- | --- |
| 按「平台顺序 × 模型档」编译有序候选链（`tier-major` / `platform-major`） | `tests/compiler.test.js` 9 例；真机 `probes/plan-preview.mjs` 产出 16 个候选、0 排除 |
| 平台没有该模型 → 跳过（`missing`） | `compiler.test.js`「缺失模型被排除」 |
| 额度为 0 → 跳过并按 `resetsAt` 记 `exhausted` | 同上；`waitUntil === Date.parse(resetsAt)` 有断言 |
| 冷却期内 → 跳过（`cooling`） | 同上 |
| 模型清单未知 → 乐观入链（`unverified`），不会把整条链清空 | `appendCell` 第三结局；与 OFM `buildComboCatalog` 剔除行为自洽 |
| 全部为空 + 未配兜底 → `waiting:true` + `waitUntil` | `compiler.test.js` |
| 全部为空 + 配了兜底 → 链尾出现 `kind:'fallback'` | `compiler.test.js` |
| 写回时只替换 `auto:` 前缀行，**用户手工 combo 原样保留** | `probes/smoke-host.mjs`（断言 `combo:manual` 仍在） |
| 内容没变就不写（幂等，`unchanged:true`） | `smoke-host` + 真机 `plan.json` 首次即 `unchanged` |
| 8 个 HTTP 端点（status/compile/snapshot/pending/applied/bridge/config/bench-clear） | `smoke-host` 全绿 |
| 观察全部 `llm/stream` 流量 | 真机 `journal.jsonl` 已有 200+ 条 `kind:'stream'` |
| 额度/限流失败 → 写冷却 → 重编译 → **注入「继续」**（`source.kind='user'`） | `tests/wiring.test.js`（端到端，见 13.4 的 bug）；注入文案含原因与切换目标 |
| 四道安全阀：`enabled`、`onlyQuotaLike`、用户 abort、`maxPerSession/maxPerHour/minInterval`、`requireCandidateChange` | `tests/resume.test.js` 13 例 |

### 13.2 写了但**未验证**的

| 能力 | 为什么没验证 | 风险 |
| --- | --- | --- |
| 设置页「额度接力」卡片 + 15s 同步循环 | 需要浏览器加载新的 client bundle（刷新页面后才生效） | 若 `settings.section` slot 注册姿势不对，页面会不显示（不影响 host 逻辑） |
| 浏览器中继真的能读 OFM 并写回 combos | 需要 GUI 打开且已登录 | 写不回去 → `bridge.status.pendingWrite` 挂起，链停在旧计划 |
| 在**真实额度墙**上完成一次接力 | 你还没撞到过额度墙（现有 12 次失败都是 `trae/DeepSeek-V4-Flash` 的秒失败，属凭据/模型问题，不是额度） | 分类器对真实文案的召回率未实测 |

### 13.3 做不到（架构或平台限制，不是待办）

1. **中途换模型**：`llm/stream` 只观察不改道（探针 4 未验），所以「切换」发生在**下一回合**，
   而不是同一回合中途。同回合内的候选接力由 OFM 的 combo `fallback` 负责（我们只提供链）。
2. **host 直接读写 OFM**：401 信任围栏（§12.1），必须借浏览器。GUI 关着 → 只读本地
   `state.json`（没有模型表）且**不写回**。
3. **安全地改 OFM 的 settings.json**：OFM 设置常驻内存，改盘不热生效且会被下次保存覆盖；
   只有显式 `writeBack.mode:'file'`（+ 重启 OFM）才行。
4. **恢复时刻自动重试**：`waitUntil` 只是**记录**，没有定时器在那一刻唤醒 —— 全部平台耗尽且
   未配兜底时，回合停在那里等下一次触发（用户发言 / 新失败 / 手动 `/compile`）。
   这是 M3 的待做项，不是已实现能力。
5. **对插件加载前就已存在的会话续跑**：注入需要 `agent` 句柄，句柄来自 `agent/created`
   事件；插件启动前创建的会话只能用 `POST /api/quota-takeover/resume` 手动触发。
6. **非额度类失败续跑**：上下文超限、请求格式错、用户 abort 一律不续（`onlyQuotaLike`）——
   这些重放同样会失败，续跑只会浪费额度。
7. **验证续跑是否真的成功**：注入后不做结果校验，也没有「续跑连续失败 N 次就停」的熔断
   （目前靠 `maxPerSession` 兜底）。
8. **多标签页并发**：两个 GUI 标签会各跑一份同步循环，`applied.hash` 只做软校验，不保证互斥。
9. **冷却到期清理**：bench 条目按时间过期（封顶 30 分钟），**不会**在额度真正重置时被主动清掉。

### 13.4 交付过程中发现并修掉的静默 bug（v0.1.0 → v0.2.0）

`watchStream` 里 `const { journal, resume, start, ...rest } = meta` 之后，
失败上报写的是 `reportFailure({ ...rest, reason: failure })` —— **`resume` 被解构走了**，
于是 `reportFailure` 拿到的 `meta.resume` 是 `undefined`，`if (!supervisor) return` 静默返回。

后果：真机上 12 次失败流一条 `failure` 日志都没有、`bench.json` 从未生成、
一次注入都没发生 —— 而 `llm/stream` 的 `stream` 日志照常写，看起来「插件在跑」。
这是最坏的一类 bug：**观察者正常、执行者静默**。

修复：`reportFailure({ ...rest, resume, reason: failure })`，并新增
`tests/wiring.test.js`（两个用例：额度失败必须注入且留痕；凭据失败必须不注入）钉住这条链路。

## 14. 终局兜底：聚合模型 → 官方额度（2026-11-05 追加）

用户要求：所有平台额度都不够时，**还要能用 DeepSeek 官方额度兜底**，任务不能停。

### 14.1 链尾结构

`buildChain` 的返回值从「平台 × 档 的候选」扩展成：

```
[...平台候选（受 maxChainLength 截断）] + [聚合兜底模型...] + [官方额度模型...]
```

- 聚合兜底：`finalResort.fallbackModels`，形如 `groq/llama-3.3-70b`（聚合渠道 `provider/model` 形式）。
- 官方额度：`finalResort.official = { enabled, provider: 'deepseek-account', models: ['deepseek-flash'] }`，
  编译出的 id 是 **`deepseek-account/deepseek-flash`**——带 provider 前缀，否则会和免费通道里
  同名的 `deepseek-flash` 撞车（journal 实测：官方通道路由 `provider=deepseek-account`、
  `model=deepseek-flash`）。
- 两者都在平台候选**之后**，所以只有当前面全都不可用/失败到链尾时才会轮到它们。
- 「链空 + 尾巴空」才进入等待恢复（`waiting: true` + `waitUntil`）。

### 14.2 一个未验证的假设（已内建自检）

`deepseek-account` 不是 OFM 的 catalog 成员，而 OFM 的 `buildComboCatalog` 会把
**不在 catalog 里的模型从链里静默剔除**。因此这条尾能不能真的落到官方额度，取决于
OFM 是否接受 `provider/model` 形式指向它自己之外的 provider。

处理方式：设置页写完 combo 后会**再读一遍**，把「我要求的 id」与「它真存下的 id」求差，
差集通过 `POST /applied { dropped }` 回传，host 写进 `plan.writeBack.dropped` 并在
设置页「终局兜底」卡片里报红：

> ⚠ OFM 没接受这些兜底 id（已从链里剔除）：… —— 换一个它认识的模型 id。

journal 对应事件 `{ kind: 'fallback-dropped', dropped }`。

若实测确实被剔除，下一版改用「续跑时把会话模型切到官方 provider」（需要先确认
`agent`/`session` 是否有可写的模型字段——§13.3 里这条目前记为做不到）。
