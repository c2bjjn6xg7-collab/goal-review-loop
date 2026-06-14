---
schema_version: 1
document_type: developer-ai-prompt
phase: 4
status: READY_TO_USE
created_at: "2026-06-13"
---

# 给开发者 AI 的提示词：Phase 4 自动返工、恢复与运行控制

你现在接手的是：

```text
/Users/dengyidong/Desktop/cc劳工系统
```

不要切到其它仓库。不要从 Phase 3 重新做。

当前基线：

```text
4a86b9f feat(agent): complete phase 3 review loop
```

Phase 3 已完成并通过真实模型 smoke：

```text
Run ID: 20260613160600-0s08po
Planner → Developer → Verification → Auditor → FINALIZING
Auditor decision: PASS
SC-15 macOS Trial: PASS
```

你的任务是实现 **Phase 4：自动返工、history 归档、resume、status、cancel 和错误归一化**。

## 必须先读

按顺序阅读：

1. `需求文档.md`
2. `DECT落地设计文档.md`
3. `Phase3开发需求文档.md`
4. `Phase4开发需求文档.md`
5. `.agent/plan.md`
6. `.agent/audit-report.md`
7. `.agent/developer-handoff.md`
8. `.agent/smoke-report.md`

然后再读当前代码：

```text
src/cli/index.ts
src/cli/start.ts
src/orchestrator/run-orchestrator.ts
src/orchestrator/state-store.ts
src/orchestrator/state-machine.ts
src/runtime/lock-manager.ts
src/runtime/process-runner.ts
src/artifacts/artifact-store.ts
src/artifacts/artifact-schemas.ts
src/artifacts/json-schemas.ts
src/agents/*
src/git/*
src/scope/scope-guard.ts
src/verification/verification-runner.ts
tests/fixtures/fake-agent.mjs
tests/integration/run-orchestrator.test.ts
```

## 本轮目标

实现 Phase 4，不实现 Phase 5/6。

必须完成：

1. 多轮自动返工循环。
2. `max_iterations` 控制。
3. 每轮 history 归档。
4. `.agent/rework-instructions.md` 或等价机器可解析返工输入。
5. `prompts/rework.md` 或等价返工 Prompt。
6. Scope / Verification / Auditor FAIL 自动进入返工。
7. 达到最大轮次进入 FAILED。
8. `review-loop resume`。
9. `review-loop status` 和 `status --json`。
10. `review-loop cancel`。
11. 统一错误模型。
12. 完整自动化测试。

## 严格禁止

不要实现：

- final audit。
- `final-audit.md` 的最终通过流程。
- 自动 `git add` / `git commit`。
- tag。
- push。
- PR。
- Codex 插件市场包装。
- GUI。
- 自动清理失败任务。
- `git reset --hard`。
- `git clean -fd`。

不要要求用户手动测试。用户希望等到插件状态再亲自测试。

如果需要真实验证，请你在隔离临时仓库中用 Fake Agent 或真实模型 smoke 完成，并记录结果。

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

### 2. 返工是缩小任务，不是重新规划

返工轮次不要重跑 Planner。

Developer 返工时只允许读取：

- `.agent/GOAL.md`
- `.agent/rework-instructions.md`
- 最新 `.agent/audit-report.md`（如存在）
- 必要 evidence / verification 日志路径

Developer 只修复 findings 指定的问题及必要测试。

### 3. 每轮都完整验证

返工后必须重新运行所有 required verification commands。

不要只运行失败的命令。

### 4. 机械失败优先于模型判断

Scope Guard、required verification、artifact schema、digest 校验失败时，不允许 Auditor PASS 覆盖机械失败。

### 5. 不确定就 BLOCKED

resume 或 cancel 中遇到无法证明安全的状态，进入 BLOCKED，不要猜测继续。

## 允许修改范围

允许修改或新增：

```text
src/cli/**
src/orchestrator/**
src/agents/**
src/artifacts/**
src/runtime/**
src/types.ts
prompts/**
tests/**
.agent/developer-handoff.md
.agent/smoke-report.md
```

谨慎修改：

```text
src/git/**
src/scope/**
src/verification/**
```

只有 Phase 4 需要时才修改，且必须保持 Phase 2/3 已验收安全边界。

不要修改：

```text
.agent/GOAL.md
.agent/plan.md
.agent/state.json
```

除非你的任务明确要求生成新的运行状态测试 fixture。

不要提交 `.claude/`。

## 关键验收场景

你必须用自动化测试覆盖：

1. 首轮 PASS → FINALIZING。
2. 首轮 verification fail → 自动 iteration 2 → PASS。
3. 首轮 scope fail → 自动 iteration 2 → PASS。
4. Auditor FAIL → 自动 iteration 2 → PASS。
5. Auditor BLOCKED → BLOCKED。
6. 达到 max_iterations → FAILED。
7. history 每轮归档 handoff、audit、verification、evidence。
8. 返工不创建新分支。
9. 返工不能伪造 `.agent/evidence/**`。
10. resume from VERIFYING 重新完整验证。
11. resume with branch mismatch → BLOCKED。
12. resume with GOAL digest mismatch → BLOCKED。
13. cancel during long-running Developer → CANCELLED。
14. status `--json` 可解析且字段稳定。

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

## 真实 smoke

Phase 4 完成后，尽量在隔离临时仓库跑一次真实模型 smoke。

推荐任务：

```text
实现一个小函数和测试。
首轮让 Fake Agent 或真实 Developer 产生明确失败。
系统自动生成返工指令。
第二轮修复。
最终 Auditor PASS，phase 到 FINALIZING。
```

如果真实模型不可用，必须如实写：

- 哪个 CLI 不可用。
- 是额度、认证、网关还是模型行为问题。
- Fake Agent E2E 是否覆盖了同等流程。

不要伪造真实 smoke PASS。

## 交付格式

完成后更新：

```text
.agent/developer-handoff.md
```

handoff front matter：

```yaml
---
schema_version: 1
run_id: "phase4-dev"
iteration: 1
author_role: "developer"
status: "COMPLETED"
---
```

正文必须包含：

- Summary。
- Files Changed。
- Phase 4 features implemented。
- Tests added。
- Engineering gates。
- Smoke result。
- Known risks。
- Explicit non-goals：Phase 5 commit/tag/push 未实现。

如果无法完成，写：

```yaml
status: "BLOCKED"
```

并说明阻断原因、已完成内容、下一步建议。

## 最终判断标准

只有同时满足以下条件，才能标记 COMPLETED：

1. 自动返工能从 FAIL 走到 PASS。
2. max_iterations 能停止在 FAILED。
3. history 证据完整。
4. resume 可安全恢复或安全 BLOCKED。
5. cancel 可进入 CANCELLED。
6. status 可读。
7. 工程门禁全绿。
8. 不包含 Phase 5/6 越界能力。
