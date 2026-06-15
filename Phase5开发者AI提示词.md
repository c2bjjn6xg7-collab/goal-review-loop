---
schema_version: 1
document_type: developer-ai-prompt
phase: 5
status: READY_TO_USE
created_at: "2026-06-14"
---

# 给开发者 AI 的提示词：Phase 5 Finalization、本地提交与终态闭环

你现在接手的是：

```text
/Users/dengyidong/Desktop/cc劳工系统
```

不要切到其它仓库。不要从 Phase 1/2/3/4 重新做。

当前实现基线：

```text
95a0444 fix(agent): address F-402R1/R2, F-403R1, F-404R1, F-406R1 — Phase 4 re-verification
```

当前文档基线可能包含后续 docs commit。代码实现以 Phase 4 PASS 状态为基础继续。

你的任务是实现 **Phase 5：Final Audit、pre-commit digest check、本地 commit/tag、PASSED 终态和 finalizing resume**。

## 必须先读

按顺序阅读：

1. `需求文档.md`
2. `DECT落地设计文档.md`
3. `Phase3开发需求文档.md`
4. `Phase4开发需求文档.md`
5. `Phase5开发需求文档.md`
6. `.agent/plan.md`
7. `.agent/audit-report.md`
8. `.agent/developer-handoff.md`
9. `README.md`

然后再读当前代码：

```text
src/cli/index.ts
src/cli/start.ts
src/cli/resume.ts
src/cli/status.ts
src/orchestrator/run-orchestrator.ts
src/orchestrator/state-store.ts
src/orchestrator/state-machine.ts
src/runtime/lock-manager.ts
src/runtime/process-runner.ts
src/artifacts/artifact-store.ts
src/artifacts/artifact-schemas.ts
src/artifacts/json-schemas.ts
src/artifacts/config.ts
src/agents/*
src/git/*
src/scope/scope-guard.ts
src/verification/verification-runner.ts
tests/fixtures/fake-agent.mjs
tests/integration/run-orchestrator.test.ts
tests/integration/rework-loop.test.ts
```

## 本轮目标

实现 Phase 5，不实现 Phase 6。

必须完成：

1. Auditor PASS 后继续执行 Finalization，而不是停在 FINALIZING。
2. 新增或完善 `.agent/final-audit.md` 生成与校验。
3. 新增 `prompts/final-auditor.md` 或等价 Final Auditor prompt。
4. commit 前重新采集 diff/scope/verification evidence。
5. 校验 GOAL、audit-report、final-audit、verification manifest 和当前 diff digest 一致。
6. 默认本地 `git commit`。
7. 可选本地 tag。
8. `--no-commit` 明确跳过 commit，但仍完成 Final Audit 和 digest check。
9. `resume from FINALIZING` 可继续 finalization。
10. commit 成功但 tag 失败时，resume 只补 tag，不重复 commit。
11. `status`/`status --json` 显示 final audit、commit、tag 状态。
12. 自动化测试覆盖成功、失败、篡改、恢复、tag、no-commit 和 local-only artifact 边界。

## 严格禁止

不要实现：

- Codex 插件/Skill 包装。
- Provider Profile 管理命令。
- CodeBuddy/OpenCode/custom provider 配置向导。
- `start --watch`、`status --watch`。
- `.agent/progress.json`、`.agent/progress.md` 实时展示。
- `.agent/transcripts/` 历史对话展示。
- push。
- PR。
- 远程仓库创建。
- GUI。
- prompt 自动进化。
- `git reset --hard`。
- `git clean -fd`。

不要要求用户手动测试。用户希望等到插件状态再亲自测试。

如果需要 smoke，请在隔离临时仓库中用 Fake Agent 或真实模型完成，并记录结果。

## 实现原则

### 1. 复用现有模块

必须复用已有模块，不要另写平行系统：

- Agent 调用走 `src/agents/agent-adapter.ts`。
- 外部命令走 `src/runtime/process-runner.ts`。
- Git 操作走 `src/git/git-manager.ts` 和 `src/git/diff-collector.ts`。
- 范围检查走 `src/scope/scope-guard.ts`。
- 验证走 `src/verification/verification-runner.ts`。
- artifact 读写走 `src/artifacts/*`。
- 状态转换走 `src/orchestrator/state-store.ts` 和 `state-machine.ts`。

### 2. Final Audit 是提交前确认

普通 Auditor PASS 只能进入 `FINALIZING`。

`PASSED` 必须等待：

```text
Final Audit PASS
+ GOAL digest match
+ diff digest match
+ audit-report digest match
+ verification manifest passed/current
+ Scope Guard PASS
+ commit/tag rule satisfied
```

### 3. commit 由编排器执行

Developer、Planner、Auditor、Final Auditor 都不能执行：

```bash
git add
git commit
git tag
git push
```

只有 Orchestrator/Git Manager 在所有最终检查通过后才能执行本地 commit/tag。

### 4. commit 范围必须可证明

默认进入 commit：

```text
.agent/plan.md
.agent/GOAL.md
.agent/developer-handoff.md
.agent/audit-report.md
.agent/final-audit.md
```

以及 GOAL allowed_changes 中允许的业务文件。

默认不得进入 commit：

```text
.agent/state.json
.agent/run.lock
.agent/cancel-request.json
.agent/iteration-log.md
.agent/progress.json
.agent/progress.md
.agent/verification/
.agent/evidence/
.agent/history/
.agent/debug/
.agent/transcripts/
node_modules/
dist/
```

不要无保护地使用 `git add -A`。优先用精确 pathspec；如果使用 `git add -A`，必须在 add 前后验证 staged set，发现越界立即 BLOCKED。

### 5. 不确定就 BLOCKED

遇到以下情况不要猜测继续：

- commit 前 digest 不一致。
- final-audit 缺字段。
- final-audit PASS 但正文仍有阻断项。
- tag 已存在但指向其它 commit。
- local-only artifact 已被 Git 跟踪。
- commit 失败且无法证明副作用。
- resume 时无法判断是否已经提交。

## 允许修改范围

允许修改或新增：

```text
src/cli/**
src/orchestrator/**
src/agents/**
src/artifacts/**
src/git/**
src/scope/**
src/verification/**
src/runtime/**
src/types.ts
prompts/**
tests/**
.agent/developer-handoff.md
.agent/audit-report.md
.agent/smoke-report.md
```

谨慎修改：

```text
README.md
需求文档.md
DECT落地设计文档.md
```

只有发现 Phase 5 需求与代码实现必须同步时才改文档，并说明原因。

不要修改：

```text
.agent/GOAL.md
.agent/plan.md
.agent/state.json
```

除非测试 fixture 或运行时状态生成明确需要。

不要提交 `.claude/`。

## 关键验收场景

你必须用自动化测试覆盖：

1. 首轮 PASS → Final Audit PASS → commit → PASSED。
2. 二轮返工 PASS → Final Audit PASS → commit → PASSED。
3. `--no-commit` → Final Audit PASS → PASSED，且无新 commit。
4. `--tag` → commit 成功 → tag 指向该 commit。
5. final-audit FAIL → 不 commit。
6. final-audit schema 错误 → 不 commit。
7. Auditor PASS 后 diff 被改 → digest mismatch → 不 commit。
8. GOAL 被改 → 不 commit。
9. required verification stale/fail → 不 commit。
10. Scope Guard 失败 → 不 commit。
11. local-only artifact 被 tracked → 不 commit。
12. commit 失败 → BLOCKED，lock 释放。
13. commit 成功但 tag 失败 → BLOCKED，state 记录 commit sha。
14. resume 补 tag → PASSED，不重复 commit。
15. resume from FINALIZING 无 final-audit → 重跑 final audit 并 commit。
16. resume from FINALIZING 已 commit → 不重复 commit。
17. `git.push: true` → BLOCKED，不 commit。
18. cancel during Final Auditor → CANCELLED，不 commit。

## 工程门禁

完成后必须运行：

```bash
npm run typecheck
npm run lint
npm run build
npm test
npm audit --omit=dev
git diff --check
npm pack --dry-run
```

如果任何一项失败，不得写 COMPLETED。

如果 `npm pack --dry-run` 出现 Node engines warning，但退出码为 0，可以记录为 warning。

## Smoke 要求

Phase 5 完成后，至少执行一次隔离临时仓库 smoke。

推荐任务：

```text
实现一个 hello(name: string): string 函数。
添加 vitest 测试。
要求完整流程走到 PASSED。
默认 commit_on_pass=true。
```

期望结果：

```text
Planner → Developer → Verification → Auditor → Final Auditor → git commit → PASSED
```

记录：

- run_id。
- 模型或 Fake Agent。
- phase。
- exit_code。
- final-audit decision。
- commit_sha。
- tag_name/tag_created。
- 关键 artifact 路径。
- 临时仓库是否清理。

不要伪造真实模型 smoke PASS。

## 交付格式

完成后更新：

```text
.agent/developer-handoff.md
```

handoff front matter：

```yaml
---
schema_version: 1
run_id: "phase5-dev"
iteration: 1
author_role: "developer"
status: "COMPLETED"
---
```

正文必须包含：

- Summary。
- Files Changed。
- Final Audit implementation。
- Commit/tag implementation。
- Resume/status changes。
- Tests added。
- Engineering gates。
- Smoke result。
- Known risks。
- Explicit non-goals：Phase 6 插件、Provider Profile、progress/transcript、push/PR 未实现。

如果无法完成，写：

```yaml
status: "BLOCKED"
```

并说明阻断原因、已完成内容、下一步建议。

## 最终判断标准

只有同时满足以下条件，才能标记 COMPLETED：

1. `FINALIZING → PASSED` 已实现。
2. Final Audit schema 和 digest check 已实现。
3. 默认 PASS 后会创建本地 commit。
4. `--no-commit` 行为明确且可测试。
5. tag 可选且可恢复。
6. resume 不重复 commit。
7. 失败路径不 commit。
8. status 能显示最终状态。
9. local-only artifact 不进入 commit。
10. 工程门禁全绿。
11. 未实现 Phase 6 越界能力。
