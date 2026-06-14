---
schema_version: 1
document_type: phase-development-requirements
phase: 4
status: READY_FOR_DEVELOPMENT
phase3_audit_iteration: 5
phase3_audit_decision: PASS
phase3_smoke_run_id: "20260613160600-0s08po"
primary_acceptance_platform: macOS
created_at: "2026-06-13"
---

# Phase 4 开发需求文档：自动返工、恢复与运行控制

## 1. 文档定位

本文档是 Phase 4 的开发执行规格，供开发 AI 直接读取和实施。

需求优先级如下：

1. `需求文档.md`：产品目标、角色边界和安全规则。
2. `DECT落地设计文档.md`：总体架构和协议设计。
3. `Phase3开发需求文档.md`：已完成基线和 Phase 3 边界。
4. 本文档：Phase 4 的范围、接口、流程、测试和验收标准。
5. `.agent/plan.md`：阶段路线参考。

发生冲突时，先遵守更高优先级文档；但不得把 Phase 5/6 能力提前默认启用。

Phase 3 已通过：

- Fake Agent E2E。
- 真实模型 smoke：Planner → Developer → Verification → Auditor → FINALIZING。
- SC-15 macOS Trial：PASS。
- F-312R1 / F-315R1：CLOSED。

Phase 4 必须复用 Phase 3 已有 Agent Adapter、Prompt Builder、Orchestrator、Scope Guard、
Verification Runner、Diff Collector、State Store、Lock Manager、Artifact Store 和 Git Manager。
不得绕过这些模块重新发明并行流程。

## 2. 用户目标

用户当前不希望手动测试本系统。Phase 4 的验证应由开发者 AI 和审核 AI 完成。

用户只需要看到：

- 工程门禁结果。
- Fake Agent 自动化验证。
- 必要的真实模型 smoke 记录。
- 明确的 PASS / FAIL / BLOCKED 结论。

Phase 4 完成后，系统应达到 **日常 Beta**：

```text
用户需求
  → Planner 生成 plan/GOAL
  → Developer 首轮实现
  → Verification + Scope Guard
  → Auditor 审计
  → FAIL / 机械失败时自动进入下一轮返工
  → 达到 PASS、FAILED、BLOCKED 或 CANCELLED
```

Phase 4 完成后仍不是完整插件：

- 不自动 commit。
- 不创建 tag。
- 不 push。
- 不生成最终发布态插件包。
- 不提供 Codex 插件市场包装或 GUI。

Phase 4 的核心价值是：**不需要用户手动把审计意见复制给开发者，系统能自动返工并保留每轮证据。**

## 3. Phase 4 目标

Phase 4 必须实现：

1. 多轮自动返工循环。
2. 最大轮次控制。
3. 每轮 history 归档。
4. 返工 Prompt / rework input。
5. 机械失败转返工。
6. Auditor FAIL 转返工。
7. `review-loop resume`。
8. `review-loop status`。
9. `review-loop cancel`。
10. 错误归一化和可诊断输出。
11. 自动化测试覆盖返工、恢复、取消、最大轮次和安全边界。

Phase 4 完成后，以下流程必须能在临时仓库中自动完成：

```text
INITIALIZING
  → PLANNING
  → DEVELOPING
  → VERIFYING
  → AUDITING
  → REWORKING
  → DEVELOPING
  → VERIFYING
  → AUDITING
  → FINALIZING
```

其中 `FINALIZING` 仍表示等待 Phase 5 最终审计/commit，不代表已经提交。

## 4. 本阶段不实现

以下能力属于 Phase 5/6，Phase 4 禁止默认实现：

- Final Auditor。
- `final-audit.md` 的最终通过审计。
- 自动 `git add` / `git commit`。
- tag 创建。
- push、PR、远程仓库操作。
- 发布包文档和插件市场包装。
- GUI。
- Prompt 自动进化。
- 自动执行破坏性 Git 清理。
- 用户无需监督的无人值守长期运行。

允许为 Phase 5 保留接口，但不得在 Phase 4 默认执行 commit/tag/push。

## 5. 当前代码基线

必须基于提交：

```text
4a86b9f feat(agent): complete phase 3 review loop
```

必须复用：

| 能力 | 当前模块 |
|---|---|
| CLI 骨架 | `src/cli/index.ts` |
| `start` 命令 | `src/cli/start.ts` |
| Orchestrator | `src/orchestrator/run-orchestrator.ts` |
| State Store | `src/orchestrator/state-store.ts` |
| State Machine | `src/orchestrator/state-machine.ts` |
| Lock Manager | `src/runtime/lock-manager.ts` |
| Agent Adapter | `src/agents/agent-adapter.ts` |
| Planner/Developer/Auditor Adapter | `src/agents/*-adapter.ts` |
| Prompt Builder | `src/agents/prompt-builder.ts` |
| Artifact Store | `src/artifacts/artifact-store.ts` |
| Artifact Schemas | `src/artifacts/artifact-schemas.ts` |
| JSON Schemas | `src/artifacts/json-schemas.ts` |
| Git Manager | `src/git/git-manager.ts` |
| Diff Collector | `src/git/diff-collector.ts` |
| Scope Guard | `src/scope/scope-guard.ts` |
| Verification Runner | `src/verification/verification-runner.ts` |
| Process Runner | `src/runtime/process-runner.ts` |

禁止：

- 在 Orchestrator 内直接手写 Git 命令绕过 Git Manager。
- 在 Agent Adapter 外另写一套子进程执行器。
- 放宽 Scope Guard 来让返工通过。
- 通过删除或弱化测试完成返工。

## 6. Phase 4 主流程

### 6.1 迭代定义

- iteration 1：首次开发。
- iteration 2..N：返工。
- `max_iterations` 表示最多允许的开发/返工轮次总数。
- 默认 `max_iterations` 继续来自 `review-loop.yaml` 的 `loop.max_iterations`。
- CLI `--max-iterations` 可覆盖配置，但必须是正整数。

### 6.2 自动返工循环

Phase 3 当前在以下情况会停止并提示 Phase 4：

- Scope Guard 失败。
- required verification 失败。
- Auditor FAIL。
- Auditor PASS 但机械校验失败。

Phase 4 必须把这些情况转为可机器消费的返工输入，然后自动进入下一轮，直到：

- Auditor PASS → FINALIZING。
- 达到最大轮次 → FAILED。
- Agent / Git / State / Artifact 出现不可恢复问题 → BLOCKED。
- 用户 cancel → CANCELLED。

伪代码：

```text
runOrchestrator():
  acquire lock
  preflight
  plan once
  create or reuse task branch

  for iteration in 1..max_iterations:
    if iteration == 1:
      phase = DEVELOPING
      run Developer with developer prompt
    else:
      phase = REWORKING
      archive previous iteration
      build rework input
      run Developer with rework prompt

    validate handoff

    phase = VERIFYING
    collect diff
    run scope guard
    run verification
    collect post-verification evidence

    if mechanical failure:
      write rework instructions
      if iteration == max_iterations:
        phase = FAILED
        return
      continue

    phase = AUDITING
    run Auditor
    validate audit report

    if audit PASS:
      phase = FINALIZING
      return

    if audit BLOCKED:
      phase = BLOCKED
      return

    if audit FAIL:
      write rework instructions from audit findings
      if iteration == max_iterations:
        phase = FAILED
        return
      continue
```

### 6.3 机械失败与模型审计优先级

优先级从高到低：

1. Git / state / lock 一致性。
2. 控制文件完整性。
3. Scope Guard。
4. Required Verification。
5. Artifact Schema。
6. Auditor 结论。

规则：

- Scope Guard 失败不得调用 Auditor 来“解释通过”。
- required verification 失败不得被 Auditor PASS 覆盖。
- Auditor FAIL 必须进入返工或 FAILED。
- Auditor BLOCKED 必须进入 BLOCKED。
- 机械失败的返工输入必须包含真实证据路径，不得只写自然语言总结。

## 7. Rework 输入协议

### 7.1 新增当前返工指令文件

建议新增：

```text
.agent/rework-instructions.md
```

该文件由 Orchestrator 写入，Developer 只读。Developer 不得修改它。

Front matter：

```yaml
---
schema_version: 1
run_id: "<run_id>"
iteration: 2
author_role: "orchestrator"
source: "scope" | "verification" | "audit" | "artifact"
status: "REWORK_REQUIRED"
---
```

正文必须包含：

- 本轮返工目标。
- 失败来源。
- findings 列表。
- 对应证据路径。
- 必须重新执行的 verification commands。
- 禁止事项。
- “只修复这些问题，不扩大范围”的明确说明。

### 7.2 Finding 结构

每个 finding 至少包含：

```yaml
- id: "R-001"
  severity: "critical" | "high" | "medium" | "low"
  source: "scope" | "verification" | "audit" | "artifact"
  path: "relative/path"
  evidence: "short evidence or log path"
  required_fix: "actionable instruction"
```

如果 finding 来自 verification，必须包含：

- command id。
- argv。
- exit code。
- stdout/stderr log path。
- timeout / cancellation 状态。

如果 finding 来自 scope，必须包含：

- denied path。
- denial reason。
- scope-report path。

如果 finding 来自 Auditor FAIL，必须从 `audit-report.md` 提取或传递：

- severity。
- 文件/行号证据。
- required fix / rework instruction。

### 7.3 Rework Prompt

建议新增：

```text
prompts/rework.md
```

Rework Prompt 必须要求 Developer：

1. 读取 `.agent/GOAL.md`。
2. 读取 `.agent/rework-instructions.md`。
3. 必要时读取 `.agent/audit-report.md` 和最新证据路径。
4. 只修复返工指令列出的问题。
5. 不扩大 allowed_changes。
6. 不重写 Planner 产物。
7. 不修改 `.agent/state.json`、`.agent/plan.md`、`.agent/GOAL.md`、`.agent/audit-report.md`。
8. 执行 GOAL 中每条 verification command 最多一次。
9. 写 `.agent/developer-handoff.md`。
10. handoff 写完立即停止。

Rework Prompt 不得把所有历史日志全文塞给模型；应提供摘要和路径，必要时让 Developer 按需读取。

## 8. History 归档

### 8.1 归档时机

进入下一轮返工前，必须归档上一轮产物。

归档目录：

```text
.agent/history/iteration-01/
.agent/history/iteration-02/
```

### 8.2 归档内容

每轮至少归档：

- `.agent/developer-handoff.md`
- `.agent/audit-report.md`（如存在）
- `.agent/rework-instructions.md`（如存在）
- `.agent/verification/iteration-XX/`
- `.agent/evidence/iteration-XX/`
- 本轮 agent stdout/stderr 日志路径清单或副本

不得覆盖已有 history。重复 resume 时，归档操作必须幂等：

- 如果同一 iteration 已归档且 digest 一致，允许继续。
- 如果已归档但 digest 不一致，进入 BLOCKED。

### 8.3 当前文件覆盖规则

`.agent/developer-handoff.md` 和 `.agent/audit-report.md` 始终表示“当前最新轮次”。

历史版本必须从 `.agent/history/iteration-XX/` 读取，不得依赖 Git 历史。

## 9. Resume

### 9.1 CLI

Phase 4 必须实现：

```bash
review-loop resume [--recover-lock] [--config <path>]
```

`resume` 不接收新的 user request，不重新规划新任务。

### 9.2 恢复前一致性检查

必须检查：

- `.agent/state.json` 存在且 schema 合法。
- 当前项目路径与 state.project_root 一致。
- 当前分支与 state.branch 一致。
- state.base_commit 仍存在。
- `.agent/GOAL.md` digest 与 state.goal_digest 一致。
- run.lock 状态合法。
- 当前 phase 可恢复。
- 当前 diff 没有无法解释的外部改动。

任何无法证明安全的情况进入 BLOCKED，不得自动清理。

### 9.3 阶段恢复策略

| 当前 phase | 恢复动作 |
|---|---|
| INITIALIZING | 重新执行 preflight；若 state 不完整则 BLOCKED |
| PLANNING | 若 plan/GOAL 合法则继续；否则重跑 Planner |
| DEVELOPING | 若 handoff 合法则进入 VERIFYING；否则谨慎重跑 Developer 或 BLOCKED |
| REWORKING | 若 handoff 合法则进入 VERIFYING；否则重跑当前返工或 BLOCKED |
| VERIFYING | 丢弃本轮不完整 verification manifest，重新执行完整验证 |
| AUDITING | 若证据 digest 未变且 audit 合法则继续；否则重跑 Auditor |
| FINALIZING | Phase 4 不执行 commit；报告等待 Phase 5 |
| PASSED/FAILED/BLOCKED/CANCELLED | 不自动继续 |

对于 DEVELOPING / REWORKING：

- 如果无 handoff 且业务 diff 已存在，默认进入 BLOCKED，提示人工检查。
- 不得执行 `git reset` 或 `git clean` 来恢复。
- 可以提供明确诊断和下一步建议。

## 10. Status

### 10.1 CLI

Phase 4 必须实现：

```bash
review-loop status [--json]
```

默认人类可读输出必须包含：

- run_id。
- phase。
- iteration / max_iterations。
- branch。
- base_commit。
- goal_digest。
- audited_diff_digest（如存在）。
- 最近错误。
- lock 状态。
- 最近 artifacts。
- 下一步建议。

`--json` 输出必须是稳定 JSON，供审核 AI 和脚本读取。

### 10.2 终态提示

- FINALIZING：提示 Phase 5 尚未 commit。
- FAILED：提示最大返工次数已用尽。
- BLOCKED：提示需要用户或基础设施处理。
- CANCELLED：提示证据已保留，可检查或人工清理。

## 11. Cancel

### 11.1 CLI

Phase 4 必须实现：

```bash
review-loop cancel
```

行为：

1. 读取 `.agent/state.json` 和 `.agent/run.lock`。
2. 如果无运行中进程，输出当前状态，不伪造取消。
3. 如果有运行中进程：
   - 写入取消请求 artifact。
   - 向 orchestrator pid 发送温和终止信号。
   - Orchestrator 捕获后 abort 当前 Agent / Verification 子进程。
   - phase 更新为 CANCELLED。
4. 保留工作区和全部证据。
5. 不执行 Git 清理。

### 11.2 取消请求文件

建议新增：

```text
.agent/cancel-request.json
```

内容：

```json
{
  "schema_version": 1,
  "run_id": "...",
  "requested_at": "...",
  "requested_by": "review-loop cancel"
}
```

Orchestrator 在阶段边界和长耗时命令前检查该文件。

## 12. 错误归一化

Phase 4 必须引入统一错误模型，至少覆盖：

| code | 默认 phase | 示例 |
|---|---|---|
| AGENT_FAILED | BLOCKED 或 REWORKING | agent 非零退出 |
| AGENT_TIMEOUT | BLOCKED | 模型超时 |
| ARTIFACT_ERROR | BLOCKED 或 REWORKING | handoff/audit 缺失或 schema 错 |
| SCOPE_VIOLATION | REWORKING 或 FAILED | allowed_changes 外改动 |
| VERIFICATION_FAILED | REWORKING 或 FAILED | required command failed |
| AUDIT_FAILED | REWORKING 或 FAILED | Auditor decision FAIL |
| AUDIT_BLOCKED | BLOCKED | Auditor decision BLOCKED |
| STATE_CONFLICT | BLOCKED | branch/base/digest 不一致 |
| LOCK_CONFLICT | BLOCKED | 有运行中锁 |
| USER_CANCELLED | CANCELLED | 用户取消 |
| INFRASTRUCTURE_ERROR | BLOCKED | CLI 不存在、认证失败、额度不足 |

错误记录必须包含：

- code。
- message。
- phase。
- iteration。
- retryable。
- resumable。
- evidence paths。
- suggested next action。

不得把基础设施错误自动转成代码返工。

## 13. 配置

`review-loop.yaml` 继续使用 Phase 3 配置。

Phase 4 可扩展：

```yaml
loop:
  max_iterations: 3
  archive_history: true
  stop_on_infrastructure_error: true
runtime:
  lock_stale_seconds: 86400
  cancel_grace_seconds: 10
```

要求：

- 新字段必须有默认值。
- 旧配置仍可加载。
- `git.push: true` 在 MVP 仍必须拒绝。
- Phase 4 不得开启 commit/tag。

## 14. 安全边界

必须保持：

- 一个任务一个分支。
- 返工不创建新分支。
- 不自动 push。
- 不执行破坏性 Git 清理。
- Developer 不得修改控制文件。
- Auditor 不得修改业务文件。
- Scope Guard 不能因返工而放宽。
- 每轮验证都必须重新执行所有 required commands。
- 不得只运行失败命令。

特别注意：

- 返工 Prompt 是缩窄任务范围，不是重新规划。
- Planner 不应在 Phase 4 每轮重跑。
- GOAL 默认不变；除非进入 BLOCKED 并等待用户/Planner 明确处理。

## 15. 测试要求

### 15.1 单元测试

必须覆盖：

- rework-instructions schema。
- rework prompt builder。
- history archive 幂等性。
- status formatter。
- resume decision matrix。
- cancel request parser。
- error normalization。
- max_iterations 边界。

### 15.2 集成测试

使用临时 Git 仓库 + Fake Agent，必须覆盖：

1. 首轮 PASS → FINALIZING。
2. 首轮 verification fail → iteration 2 rework → PASS → FINALIZING。
3. 首轮 scope fail → iteration 2 rework → PASS。
4. Auditor FAIL → iteration 2 rework → PASS。
5. Auditor BLOCKED → BLOCKED，不返工。
6. 达到 max_iterations → FAILED。
7. 每轮 handoff/audit/evidence/verification 被归档。
8. 返工不创建新分支。
9. 返工仍拒绝 Developer 伪造 `.agent/evidence/**`。
10. resume from VERIFYING reruns full verification。
11. resume from AUDITING reruns or validates Auditor evidence。
12. resume with branch mismatch → BLOCKED。
13. resume with changed GOAL digest → BLOCKED。
14. cancel during long-running Developer → CANCELLED。
15. status `--json` 输出稳定可解析。

### 15.3 真实模型 smoke

Phase 4 完成后，开发者 AI 应在隔离临时仓库运行真实模型 smoke。

推荐任务：

1. 首轮故意让 Developer 写一个会被测试抓住的小 bug。
2. Auditor 或 verification 产生明确返工项。
3. 第二轮 Developer 修复。
4. 最终 Auditor PASS，phase 到 FINALIZING。

如果真实模型不可用，必须如实记录为外部阻断；不得伪造 PASS。

## 16. 验收标准

### SC-4.1 自动返工

verification、scope 或 Auditor FAIL 时，系统能自动进入下一轮 Developer。

### SC-4.2 最大轮次

达到 `max_iterations` 后进入 FAILED，不继续消耗模型额度。

### SC-4.3 History

每轮产物归档完整，且 resume 不会破坏历史证据。

### SC-4.4 Rework Prompt

返工 Prompt 只包含 GOAL、当前 findings 和必要证据路径，不扩大任务范围。

### SC-4.5 Scope 安全

返工轮次仍能拦截越权业务文件、控制文件和伪造 evidence。

### SC-4.6 Verification

每轮重新执行所有 required verification commands，并保存真实退出码和日志。

### SC-4.7 Resume

关键阶段中断后可安全恢复；无法证明安全时进入 BLOCKED。

### SC-4.8 Status

`review-loop status` 和 `status --json` 可准确报告状态。

### SC-4.9 Cancel

运行中 cancel 能终止当前子进程，状态进入 CANCELLED，证据保留。

### SC-4.10 错误模型

所有失败路径都有稳定 code、evidence paths 和 suggested next action。

### SC-4.11 工程质量

必须通过：

```bash
npm run typecheck
npm run lint
npm run build
npm test
npm audit --omit=dev
git diff --check
npm pack --dry-run
```

### SC-4.12 真实 smoke

至少一次真实模型 smoke 证明：

```text
首轮 FAIL/verification fail
  → 自动返工
  → 第二轮 PASS
  → FINALIZING
```

## 17. 交付物

开发完成后必须更新：

- `.agent/developer-handoff.md`
- `.agent/audit-report.md`（由审核 AI 或复验方生成）
- 必要时 `.agent/smoke-report.md`

handoff 必须说明：

- 实现了哪些 Phase 4 能力。
- 改了哪些文件。
- 新增了哪些测试。
- 哪些场景已验证。
- 哪些能力仍属于 Phase 5/6。
- 真实 smoke 是否执行；若未执行，原因是什么。

## 18. 对开发者 AI 的特别要求

1. 不要要求用户手动测试。
2. 所有测试和 smoke 尽量由开发者 AI / 审核 AI 完成。
3. 不要把 Phase 4 描述成“插件已完成”。
4. 不要自动 commit、tag、push。
5. 不要把外部模型额度、认证、网关问题写成代码 PASS。
6. 遇到不确定的恢复状态时，宁可 BLOCKED，不要猜测继续。
