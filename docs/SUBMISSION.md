# 发布到 DSH 插件市场 · 操作手册

> 依据：[awesome-dsh-plugin/awesome-dsh-plugin 的 contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)（2026-11 现行版）

---

## 0. 先看结论：市场只认两件事

| 要求 | 我们现在的状态 |
| --- | --- |
| `package.json` 里有 `dsh.bundle` manifest | ✅ `"bundle": { "patch": "./cordis.patch.yml" }` |
| 仓库里有真实可跑代码、创建满 1 天、带 `dsh-plugin` topic | ⏳ 需要你建 GitHub 仓库（仓库时间从建库那一刻算，所以**今天就建**） |

一键安装靠的是 `dsh.bundle`；**只写 `dsh.client` 会被拒**（这是最常见的退回原因），我们已经两者都有。

---

## 1. 打包（已完成）

```
quota-takeover/dsh-quota-takeover-0.1.0.tgz   51 KB / 22 文件
```

校验方式（已跑过，可复现）：

```bash
mkdir /tmp/pkgcheck && cd /tmp/pkgcheck
npm init -y && npm i /path/to/dsh-quota-takeover-0.1.0.tgz
cd node_modules/dsh-quota-takeover
npm test          # 42 pass
npm run smoke     # smoke-host: all good
```

`files` 白名单只放运行必需 + 探针 + 测试，不含 `.gitignore`、`*.tgz`、日志。

---

## 2. 建仓库并推送

```bash
cd quota-takeover
# 仓库名就用包名，贡献指南要求 url 与仓库完全一致
git remote add origin https://github.com/<你的账号>/dsh-quota-takeover.git
git branch -M main
git push -u origin main
```

然后到仓库页面 **About → Topics** 添加 topic：`dsh-plugin`
（指南明确要求这一项，CI 会看。）

> `package.json` 里的 `repository` / `homepage` / `bugs` 目前写的是 `puppy-bai`，如果你的 GitHub 用户名不同，先改这三处再 commit。

---

## 3. 发 npm 包（推荐，非强制）

```bash
npm login            # 需要你先在终端登录一次
npm publish --access public
```

- 包名 `dsh-quota-takeover` 目前**未被占用**（已查 npm registry，404）。
- 发了 npm，市场会显示「预构建安装」，用户不必再点构建授权（`allowBuilds`）。

## 3'. 不发 npm 的替代方案：GitHub Release 挂 tarball

指南要求：`https`、`.tgz`、GitHub 自家 release 托管，并用 `tarball:` 字段指向它。

```bash
gh release create v0.1.0 ./dsh-quota-takeover-0.1.0.tgz   # 或用网页上传
```

⚠️ 资产名**不要带版本号**，否则 `latest/download/` 的链接在你下次发版时静默变 404：

```yaml
tarball: https://github.com/<owner>/dsh-quota-takeover/releases/latest/download/dsh-quota-takeover.tgz
```

---

## 4. 提 PR：只加一个文件

Fork `awesome-dsh-plugin/awesome-dsh-plugin`，新增：

```
data/plugins/<owner>__dsh-quota-takeover.yml
```

内容（本仓库已备好同款：`docs/marketplace-entry.yml`；`owner` 换成你的 GitHub 用户名，两处都要换）：

```yaml
url: https://github.com/puppy-bai/dsh-quota-takeover
name: puppy-bai/dsh-quota-takeover
category: model
description:
  en: >-
    Quota takeover for DeepSeek Harness on top of Our Free Model: compiles your
    platform order and pinned model tiers into one ordered fallback chain,
    skipping platforms that lack the model, sit in cooldown or are out of quota,
    writes the result back as Our Free Model combos, and after a quota or
    rate-limit failure re-plans and injects a follow-up "continue" message into
    the interrupted session so the turn resumes on the next platform; the chain
    ends with your aggregate fallback model or the official DeepSeek quota.
  zh: 额度接力：在 Our Free Model 之上按你设定的平台顺序与模型档编排一条有序接力链，缺该模型、平台冷却、额度耗尽的格子自动跳过，结果写回 OFM 的 combos；因额度或限流中断后重新编排并向中断的会话补一条「继续」，让回合在下一个平台接着跑，链尾可选聚合渠道兜底模型或 DeepSeek 官方额度。
```

要点：

- `category: model`（Models & Providers）最贴合。选不准不会被退回，维护者会改。
- **描述里不要有营销词**（"最好用/最强"），会被打回；我们的描述只陈述行为。
- 英文描述若含 `: `（冒号+空格）必须用引号包起来 —— 上面的 `>-` 折叠写法天然规避。
- 一个 PR 最多 3 条，我们 1 条。

---

## 5. CI 会按顺序查什么

1. 每个 PR 最多 3 条（先查，不联网）
2. 从你仓库 `package.json`（根，或 `packages/`·`plugins/`·`apps/` 子包）读 `dsh.bundle`
3. 仓库创建满 1 天
4. `awesome-lint` + 站点构建（双语、分隔符、日期、截图）

失败会明确说改什么，**在同一分支 push 修复即可**，不用重开 PR。

---

## 6. 评审真正在看什么（决定我们要怎么说）

1. 代码是否真做到描述里写的（我们会写"跳过缺模型的平台""自动补一条继续"，这两处都能在 `src/compiler.js` 与 `src/resume.js` 里点到）
2. 分类是否合理
3. 是不是真代码
4. **是否与已有条目重复** —— 这条我们必须正面回答，见下
5. 源码有没有可疑行为（混淆、凭据外传）
6. PR 有没有动别人的条目（只改自己那个 yml）

### 与已有插件的区别（评审大概率会问）

市场里已有若干"模型故障转移"类插件，都能自动换模型：

| 已有 | 它们做什么 | 我们多出来的是什么 |
| --- | --- | --- |
| `dsh-model-failover` | 多级熔断（模型/provider 连续失败后跳下一个） | 我们的候选来自 **OFM 的真实额度网格**（平台 × 模型），不是手写 fallback 列表 |
| `@visol-456/dsh-llm-fallback` | provider 级 fallback 链 | 我们**跨平台**按「模型档」对齐（同一档在各平台叫法不同也能对上） |
| `dsh-shift-router` | 两档 LLM-Judge 路由 + 多模型 fallback | 我们不做语义路由，只做**额度驱动的接力**，且带平台级冷却 |
| `dsh-xdpool` | WorkBuddy 多账号池 + 429 冷却 | 我们是订阅渠道（trae/minimax/gemini/…）+ 官方额度，且**负责断点续跑** |
| — | — | **我们是唯一在失败后向会话注入「继续」的**：换平台只是手段，让被打断的回合接着跑才是目的 |

一句话差异：**别人换模型，我们换"还没用完额度的那个平台"，并把被打断的对话接上。**

---

## 7. 另一个市场（可选）

`dshmarketplace.dev`（install-verified 市场）的索引是 `https://dshmarketplace.dev/market/index.json`，条目按 **npm 包 + sandbox 实装**生成，字段是 `name/author/homepage/repository/versions[].source`。发 npm 之后它通常会自己入库；若想主动申请，看该站首页的提交入口（索引里没有写提交 URL）。

---

## 8. 清单（对照打勾）

- [x] `dsh.bundle` + `cordis.patch.yml`
- [x] `dsh.client`（浏览器设置页）
- [x] README / LICENSE（MIT）/ `files` 白名单
- [x] `npm pack` 产物可从零安装并跑通测试
- [x] 本地 git 仓库已 init 并提交
- [ ] 建 GitHub 仓库、push、加 `dsh-plugin` topic
- [ ] （可选）`npm publish` / 挂 Release tarball
- [ ] Fork 并提 PR（加 `data/plugins/<owner>__dsh-quota-takeover.yml`）
