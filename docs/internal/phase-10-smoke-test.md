# Phase 10 Smoke Test 执行手册

> 用途:在投入下一个 phase 前,用最小成本验证"真实 LLM + Phase 10 prompt 工程"
> 是否协同工作。单测用的是硬编码字符串,验证不了 LLM 的实际输出行为。
> 本手册让你自己跑,不自动执行(会消耗真实 token)。
>
> 预计耗时:15–30 分钟 + 1 次 run 的 LLM 费用。

## 0. 这个 smoke test 要回答的核心问题

工程门全绿只证明"代码逻辑对"。它回答不了三件事,而这三件是 Phase 10 真正
成败的关键:

1. **标签契合度**:真实 LLM 按修改后的 prompt 输出时,会不会恰好写出
   `ReviewLoopRequest`(大小写、连字符、空格)?解析器是严格匹配,LLM 拼错
   一个字符,整条副指令就静默进 parse-warnings.md,副指令通道实际是空的。
   严格匹配的真实代价只有真实 run 才暴露。
2. **反激励是否生效**:Developer 真的报了 risk_note 后,Auditor 会不会"独立验证"
   而不是直接 REWORK?prompt 文案改一行就可能反转语义。
3. **反馈注入闭环**:下一轮 Planner 的 prompt 里到底有没有 clarifications 内容?

如果这三个都过,Phase 10 可以放心交付;如果标签契合度差,说明要回头调 prompt
(放宽策略)或在解析器加 fuzzy 匹配——这会直接影响 Phase 9/8D 的优先级判断。

## 1. 准备:挑一个会触发副指令的 request

关键:request 要**天然包含三种触发点**:

- **模糊点** → 激发 clarify(Planner 不确定该怎么做)
- **潜在并发风险** → 激发 risk_note(Developer 写代码时发现 race)
- **小越界诱惑** → 激发 scope_concern(需要改的文件略微超出常规)

推荐用一个**真实存在的小重构**,这样 LLM 有具体抓手,不是凭空捏造。

### 推荐 request(可直接用)

选一个项目里现有的、带并发风险的函数做目标。例如 `src/runtime/lock-manager.ts`
的 `acquire`(O_EXCL 创建 + stale 检测)——它天然有 TOCTOU 讨论(检查 stale 到
删除之间窗口),Developer 很可能想报 race condition 风险。

request 文本草稿(根据你挑的目标微调):

```
给 src/runtime/lock-manager.ts 的 acquire 方法补充一段注释,说明它的 stale-lock
恢复逻辑存在 TOCTOU 窗口(检测到 stale 到执行恢复之间,原持有者可能复活)。
同时在注释里指出这是已知限制,不需要现在修复。兼容旧版调用方。
```

设计要点:
- "补充注释 + 不修复" → 范围极小,run 快,且明确"不要改代码逻辑"避免 Developer 真去动 acquire
- "TOCTOU 窗口" → Developer/Planner 大概率会想发 risk_note 或 scope_concern
- "兼容旧版调用方" → **故意模糊**(哪个旧版?API 层还是行为层?)→ 激发 clarify
- 如果 Developer 觉得"应该在注释里给出缓解建议"但那超出"只写注释",→ 激发 scope_concern

## 2. 执行

```bash
# 在一个干净的 git 状态上跑(避免和已有 .agent/ run 产物混淆)
git status       # 确认干净或已 commit

# 注意:.agent/ 里有已跟踪文件(GOAL.md/audit-report.md 等),不要 mv 整个目录。
# smoke run 会覆盖它们,跑完用 git checkout 恢复即可(见 §6)。

# 跑(smoke 用低 max-iterations,省时省钱)
review-loop start --max-iterations 2 --request "给 src/runtime/lock-manager.ts 的 acquire 方法补充一段注释,说明它的 stale-lock 恢复逻辑存在 TOCTOU 窗口(检测到 stale 到执行恢复之间,原持有者可能复活)。同时在注释里指出这是已知限制,不需要现在修复。兼容旧版调用方。"
```

注意:
- `--max-iterations 2`:smoke 不需要跑到完美 PASS,2 轮足够观察副指令行为。
- 如果你的 provider 配置(claude/codex)默认较贵,这轮大概几毛到几块,可接受。
- run 过程中**不要** Ctrl+C,让它自然结束(哪怕 BLOCKED 也行,BLOCKED 反而能观察 clarify blocking 行为)。

## 3. 验证 checklist(run 结束后逐项查)

### 3.1 标签契合度(最重要)

```bash
# 看 Planner 产物里有没有合法的 ReviewLoopRequest 块
grep -c '```ReviewLoopRequest' .agent/plan.md 2>/dev/null
# 看 Developer 产物
grep -c '```ReviewLoopRequest' .agent/developer-handoff.md 2>/dev/null
# 看 Auditor 产物
grep -c '```ReviewLoopRequest' .agent/audit-report.md 2>/dev/null
```

**判定**:
- 计数 ≥ 1 → 标签契合,LLM 听懂了 prompt ✓
- 计数 = 0 但 `parse-warnings.md` 非空 → **标签拼错**,看 warnings 里 LLM 实际写的标签长啥样 ✗(这是关键发现)
- 计数 = 0 且 `parse-warnings.md` 也空 → LLM 这次没发副指令(可能 request 不够触发,换个 request 重跑)

```bash
# 如果上面计数为 0,看 LLM 到底写了什么标签
cat .agent/parse-warnings.md 2>/dev/null
# 或直接搜任何形如 ```xxxRequest 的 fence
grep -nE '```[A-Za-z-]+[Rr]equest' .agent/plan.md .agent/developer-handoff.md .agent/audit-report.md 2>/dev/null
```

### 3.2 副指令路由正确性

```bash
# risk_note / scope_concern 应该进 feedback-notes.md(不是 followups.md)
cat .agent/feedback-notes.md 2>/dev/null
# followup_task / verification_suggestion 应该进 followups.md
cat .agent/followups.md 2>/dev/null
# clarify 应该进 clarifications.md
cat .agent/clarifications.md 2>/dev/null
```

**判定**:
- risk_note 出现在 feedback-notes.md(不在 followups.md)→ 路由对 ✓
- 如果 risk_note 跑到 followups.md → dispatcher 路由 bug(但单测覆盖了,不太可能)

### 3.3 反激励是否生效(核心行为)

这一步要人工看 Auditor 的实际决策:

```bash
# 看 Auditor 最终决策 + 它对 risk_note 的处理
cat .agent/audit-report.md 2>/dev/null | head -60
```

**判定**(对照 auditor.md 的反激励语义):
- Developer 报了 TOCTOU risk_note,Auditor **没有仅因 risk_note 存在就 REWORK**,而是独立判断"注释是否写到位" → 反激励生效 ✓
- Auditor 看到 risk_note 就 REWORK("developer 报了风险所以不合格")→ 反激励失效,prompt 需要调强 ✗
- 如果 Developer 根本没报 risk_note → 触发不足,看 Developer 产物里有没有相关讨论但没结构化

### 3.4 注入闭环(多轮才看得到)

如果 run 跑了 ≥ 2 轮,且第 1 轮 Planner 发了 clarify:

```bash
# 第 2 轮的 Planner prompt 里有没有注入 clarifications?
# (需要看 orchestrator 日志或第 2 轮的 plan.md 是否回应了 clarify)
cat .agent/plan.md 2>/dev/null | grep -i "compatib\|旧版\|backward" | head
```

**判定**:第 2 轮 plan 如果回应了"兼容旧版"的澄清 → 闭环通 ✓。

## 4. 结果记录模板

跑完填这个,贴回来我帮你判断下一步:

```
标签契合度:  plan.md N块 / handoff N块 / audit N块  (parse-warnings 有/无)
副指令路由:  feedback-notes 内容摘要 / followups 内容摘要
反激励:      Developer 报 risk_note 了吗?Auditor 决策是?因 risk_note REWORK 了吗?
注入闭环:    多轮了吗?第2轮回应 clarify 了吗?
run 结果:    PASSED / REWORKED / BLOCKED / FAILED,耗时?,大概费用?
意外:       任何不符合预期的现象
```

## 5. 结果如何决定下一步(8D vs 9)

| smoke 结果 | 含义 | 下一步 |
|---|---|---|
| 标签契合 + 反激励生效 + 闭环通 | Phase 10 真稳 | **8D 优先**(并发收益直接) |
| 标签契合差(LLM 频繁拼错,副指令大量丢失) | 严格匹配策略代价大,且**你看不见丢失**(静默进 warnings) | **9 优先**(事件流让你看见副指令在丢,否则上 8D 后并发更难发现) |
| 反激励失效(Auditor 仍因 risk_note REWORK) | prompt 工程没到位 | **先修 prompt**,8D/9 都往后 |
| 触发不足(LLM 没发副指令) | request 设计问题,不是 Phase 10 问题 | 换 request 重跑,不影响路线图 |

## 6. 清理

> ⚠️ **注意:`.agent/` 不是整个被 gitignore。** `.gitignore` 只忽略了
> `.agent/state.json`、`run.lock`、`progress*`、`verification/`、`evidence/`、
> `history/`、`debug/`、`transcripts/`。而 `GOAL.md`、`audit-report.md`、
> `developer-handoff.md`、`final-audit.md` 等**已被 git 跟踪**。Phase 10 新增的
> 副产物(`feedback-notes.md` / `clarifications.md` / `followups.md` /
> `parse-warnings.md`)**当前未被忽略,会显示为 untracked**。
>
> 所以**不要 `rm -rf .agent`**——会删掉已跟踪文件。按下面精确清理:

```bash
# 1. 先备份你想留档的副指令产物(研究用)
cp .agent/feedback-notes.md .agent/clarifications.md .agent/followups.md .agent/parse-warnings.md /tmp/phase10-smoke-artifacts/ 2>/dev/null || true

# 2. 恢复被 smoke run 改动的已跟踪文件(GOAL.md/audit-report.md 等会被 run 覆盖)
git checkout -- .agent/GOAL.md .agent/audit-report.md .agent/developer-handoff.md .agent/final-audit.md 2>/dev/null

# 3. 删除 smoke 产生的 untracked 副产物(这些未被 gitignore,会显示为 ??)
rm -f .agent/feedback-notes.md .agent/clarifications.md .agent/followups.md .agent/parse-warnings.md

# 4. 确认回到干净状态
git status
```

> **Phase 10 副产物的 gitignore 状态(已修复 2026-06-18):**
> `feedback-notes.md` / `clarifications.md` / `followups.md` / `parse-warnings.md`
> 已加入 `.gitignore`,跑完不会在 `git status` 冒出来。下面 §6 的清理仍需要,
> 但只是为了恢复 smoke 覆盖掉的**已跟踪**文件(GOAL.md/audit-report.md 等)。
