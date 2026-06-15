---
schema_version: 1
document_type: phase-development-requirements
phase: 5
status: READY_FOR_DEVELOPMENT
phase4_audit_iteration: 7
phase4_audit_decision: PASS
primary_acceptance_platform: macOS
created_at: "2026-06-14"
---

# Phase 5 开发需求文档：Finalization、本地提交与终态闭环

## 1. 文档定位

本文档是 Phase 5 的开发执行规格，供开发 AI 直接读取和实施。

需求优先级如下：

1. `需求文档.md`：产品目标、角色边界和安全规则。
2. `DECT落地设计文档.md`：总体架构、状态机和协议设计。
3. `Phase3开发需求文档.md`：首轮真实模型编排基线。
4. `Phase4开发需求文档.md`：自动返工、resume、status、cancel 基线。
5. 本文档：Phase 5 的最终审计、commit/tag、终态和测试要求。
6. `.agent/plan.md`：阶段路线参考。

发生冲突时，先遵守更高优先级文档；但不得把 Phase 6 的插件包装、Provider Profile、
progress/transcript UI 能力提前实现为默认行为。

Phase 4 当前已通过：

- 自动返工循环。
- `resume` / `status` / `cancel`。
- 真实集成场景覆盖取消、恢复和归档幂等。
- 工程门禁：typecheck、lint、build、test、pack。
- 审核结论：`.agent/audit-report.md` 为 Phase 4 PASS。

Phase 5 必须复用 Phase 4 已有 Orchestrator、State Store、Lock Manager、Artifact Store、
Agent Adapter、Prompt Builder、Git Manager、Diff Collector、Scope Guard、Verification Runner
和错误归一化模型。不得绕过这些模块另写一套最终提交流程。

## 2. 用户目标

Phase 4 结束时，系统能走到：

```text
Planner → Developer/Rework → Verification → Auditor PASS → FINALIZING
```

但 `FINALIZING` 还不是“真正可交付”。Phase 5 要把这个状态收口为：

```text
FINALIZING
  → Final Audit
  → Pre-commit digest check
  → local git commit
  → optional local tag
  → PASSED
```

Phase 5 完成后，系统应达到 **本地可用 Beta**：

- 用户可以在可信本地仓库运行完整闭环。
- 通过审计的任务会生成最终审计报告。
- 默认只创建本地 commit，不 push，不创建 PR。
- 可选创建本地 tag。
- 失败、BLOCKED、CANCELLED 都不会 commit。
- `resume` 可以安全处理 finalizing 阶段，不重复提交。

Phase 5 完成后仍不是完整插件：

- 不实现 Codex 插件/Skill 包装。
- 不实现 Provider Profile 管理命令。
- 不实现 progress/transcript 桌面端展示。
- 不实现 GUI。
- 不实现自动 push、PR 或远程仓库创建。

## 3. Phase 5 目标

Phase 5 必须实现：

1. `FINALIZING → PASSED` 状态闭环。
2. Codex Final Audit 调用与 `.agent/final-audit.md` 校验。
3. commit 前重新采集 diff、scope、verification manifest 和 digest。
4. final audit 的 digest 与当前待提交工作区一致性校验。
5. 只在最终审计 PASS 时创建本地 Git commit。
6. 可选创建本地 tag。
7. `--no-commit` 的显式无提交路径。
8. `resume from FINALIZING` 的幂等恢复。
9. commit 成功但 tag 失败时的可恢复 BLOCKED 状态。
10. local-only artifact 不进入 commit。
11. `status` 输出 commit/tag/final audit 相关字段。
12. 完整自动化测试覆盖成功、失败、篡改、恢复和边界场景。

Phase 5 完成后，以下流程必须能在临时仓库中自动完成：

```text
INITIALIZING
  → PLANNING
  → DEVELOPING
  → VERIFYING
  → AUDITING
  → FINALIZING
  → PASSED
```

多轮返工情况下也必须能从最后一次 Auditor PASS 进入同一最终闭环。

## 4. 本阶段不实现

以下能力属于 Phase 6 或更后续阶段，Phase 5 禁止默认实现：

- Codex 插件/Skill 打包。
- `review-loop providers list/test/set`。
- CodeBuddy/OpenCode/custom provider 配置向导。
- `start --watch`、`status --watch`。
- `.agent/progress.json`、`.agent/progress.md` 的实时进度写入。
- `.agent/transcripts/` 的可读历史对话展示。
- 自动 push。
- 自动创建 GitHub/GitLab PR。
- 远程私有仓库创建。
- GUI。
- Prompt 自动进化。
- 破坏性 Git 清理。

允许为 Phase 6 保留类型或配置字段，但不得在 Phase 5 默认启用。

## 5. 当前代码基线

必须基于 Phase 4 已验收代码：

```text
95a0444 fix(agent): address F-402R1/R2, F-403R1, F-404R1, F-406R1 — Phase 4 re-verification
```

若仓库后续包含文档提交，可以在不改变 Phase 4 实现基线的前提下继续开发。

必须复用：

| 能力 | 当前模块 |
|---|---|
| CLI 骨架 | `src/cli/index.ts` |
| `start` 命令 | `src/cli/start.ts` |
| `resume` 命令 | `src/cli/resume.ts` |
| `status` 命令 | `src/cli/status.ts` |
| Orchestrator | `src/orchestrator/run-orchestrator.ts` |
| State Store | `src/orchestrator/state-store.ts` |
| State Machine | `src/orchestrator/state-machine.ts` |
| Lock Manager | `src/runtime/lock-manager.ts` |
| Agent Adapter | `src/agents/agent-adapter.ts` |
| Auditor Adapter | `src/agents/auditor-adapter.ts` |
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

- 在 Orchestrator 内直接拼接危险 Git 命令绕过 Git Manager。
- 让 Developer 或 Auditor 执行 commit/tag/push。
- 为了 commit 通过而放宽 Scope Guard。
- 为了减少脏工作区而删除证据或运行破坏性清理。
- 在失败状态下伪造 `PASSED`。

## 6. Phase 5 主流程

### 6.1 正常成功路径

Phase 4 当前在 Auditor PASS 后进入 `FINALIZING`。Phase 5 应继续执行：

```text
Auditor PASS
  → transition FINALIZING
  → collect final diff artifacts
  → run final Scope Guard
  → verify required verification manifest is current and passed
  → run Codex Final Auditor
  → validate .agent/final-audit.md
  → compare goal/diff/final-audit digest
  → stage allowed business files + versioned artifacts
  → git commit
  → optional local tag
  → transition PASSED
```

Final Audit 不是替代 Auditor，而是“提交前最终确认”。它必须基于：

- `.agent/GOAL.md`
- `.agent/developer-handoff.md`
- `.agent/audit-report.md`
- 当前 diff evidence
- 当前 scope report
- 当前 verification manifest
- 当前 run state

### 6.2 失败路径

以下情况必须阻止 commit：

- final audit decision 不是 PASS。
- `.agent/final-audit.md` 缺失或 schema 不合法。
- GOAL digest 与 state 不一致。
- audit-report 的 audited diff digest 与当前 diff digest 不一致。
- final-audit 的 diff digest 与当前 diff digest 不一致。
- Scope Guard 失败。
- required verification 未通过、缺失或不是当前轮次。
- commit staging 集合包含 local-only artifact。
- Git commit 失败。
- `git.push` 被配置为 true。

阻止 commit 时：

- 不得进入 `PASSED`。
- 必须进入 `BLOCKED` 或保持可恢复的 `FINALIZING`，具体由错误是否可恢复决定。
- 必须写明错误分类、证据路径和下一步。
- 必须释放 lock。

### 6.3 `--no-commit`

`--no-commit` 是显式测试/演练模式，不是默认生产路径。

规则：

- 仍必须运行 Final Audit 和所有 pre-commit digest check。
- 不执行 `git add`、`git commit`、`git tag`。
- 若 Final Audit PASS 且所有机械检查通过，可以进入 `PASSED`。
- 结果对象、status 和 handoff 必须明确：

```text
commit_skipped: true
commit_sha: null
skip_reason: "--no-commit"
```

这样可以让 smoke 和开发测试完整验证 Phase 5 逻辑，同时不污染临时仓库 commit 历史。

### 6.4 tag

`--tag` 或配置 `git.create_tag: true` 时：

- 只允许创建本地 tag。
- tag 必须在 commit 成功后创建。
- tag 名称来自 `git.tag_template`，必须替换全部占位符。
- tag 已存在且指向当前 commit 时，resume 可视为完成。
- tag 已存在但指向其它 commit 时，进入 BLOCKED。
- tag 创建失败时：
  - 保留已经创建的 commit。
  - 进入 BLOCKED。
  - state 记录 `final_commit_sha`。
  - resume 只能补 tag，不得重复 commit。

### 6.5 push

Phase 5 不执行 push。

如果配置中出现：

```yaml
git:
  push: true
```

必须 fail closed：

- start/resume 阶段拒绝执行或进入 BLOCKED。
- 输出明确错误：`git.push is not supported in Phase 5`。
- 不得静默忽略后继续 commit。

## 7. Final Audit 协议

### 7.1 文件路径

```text
.agent/final-audit.md
prompts/final-auditor.md
```

`final-audit.md` 由 Codex Final Auditor 生成。Final Auditor 可以复用现有 Auditor Adapter，
但 prompt 必须单独区分，不要复用普通 audit prompt 造成职责混淆。

### 7.2 Front matter

`final-audit.md` front matter 至少包含：

```yaml
---
schema_version: 1
run_id: "<run_id>"
author_role: "auditor"
decision: "PASS"
final_iteration: 2
goal_digest: "sha256:..."
diff_digest: "sha256:..."
audit_report_digest: "sha256:..."
verification_manifest_digest: "sha256:..."
created_at: "2026-06-14T00:00:00.000Z"
---
```

`decision` 只允许：

- `PASS`
- `FAILED`
- `BLOCKED`

Phase 5 正常成功路径只在 `PASS` 时允许 commit。

### 7.3 正文要求

正文必须包含：

- Final Decision。
- Success Criteria 对照。
- Verification Summary。
- Scope Summary。
- Change Summary。
- Files To Commit。
- Versioned Artifacts。
- Local-only Artifacts Excluded。
- Accepted Residual Risks。
- Commit Recommendation。

Final Auditor 必须明确说明：

- 是否允许本地 commit。
- commit 前是否还存在阻断项。
- 是否发现未审计 diff。
- 是否发现 Developer/Auditor 产物与真实 diff 不一致。

### 7.4 校验规则

Artifact Schema 必须校验：

- front matter 字段完整。
- `run_id` 等于当前 run。
- `final_iteration` 等于当前 state iteration。
- digest 字段格式合法。
- `decision` 枚举合法。
- PASS 时正文中不存在未解决 Critical/High 阻断项。

机械校验必须进一步确认：

- `goal_digest` 等于当前 `.agent/GOAL.md` digest。
- `diff_digest` 等于 commit 前重新采集的 diff digest。
- `audit_report_digest` 等于当前 `.agent/audit-report.md` digest。
- `verification_manifest_digest` 等于当前 manifest digest。

## 8. Commit 边界

### 8.1 默认进入 commit 的文件

默认进入最终 commit：

```text
.agent/plan.md
.agent/GOAL.md
.agent/developer-handoff.md
.agent/audit-report.md
.agent/final-audit.md
```

以及 GOAL allowed_changes 中允许的业务文件。

### 8.2 默认不得进入 commit 的文件

默认不得进入最终 commit：

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

如果这些文件已被 Git 跟踪，pre-commit check 必须 BLOCKED，并提示用户先人工处理。

### 8.3 staging 规则

禁止无保护地执行：

```bash
git add -A
```

允许两种安全方式：

1. Git Manager 根据 changed-files、allowed_changes 和 versioned artifacts 构造精确 pathspec。
2. 如必须使用 `git add -A`，必须先证明所有 local-only artifact 已被 `.gitignore` 忽略且未被 tracked，
   并在 add 后再次检查 staged set，只要 staged set 超出允许集合就撤销本次提交流程并 BLOCKED。

推荐实现方式是精确 pathspec。

### 8.4 commit message

commit message 来自配置：

```yaml
git:
  commit_template: "feat(agent): complete {task_slug} [{run_id}]"
```

必须替换全部占位符。

最低要求支持：

- `{task_slug}`
- `{run_id}`
- `{iteration}`
- `{short_goal_digest}`

未知占位符必须 BLOCKED，不得原样进入 commit message。

### 8.5 commit 结果记录

成功 commit 后必须记录：

- `final_commit_sha`
- `final_commit_message`
- `finalized_at`
- `commit_skipped`
- `tag_name`（如有）
- `tag_created`

这些字段可以写入 state 或 result 对象。若 state 在 commit 后写入 `PASSED` 导致工作区脏，必须保证
`.agent/state.json` 是 local-only，不进入 commit。

## 9. Resume

### 9.1 resume from FINALIZING

`review-loop resume` 遇到 `FINALIZING` 时，不再 BLOCKED，而是执行 Finalization 恢复逻辑：

1. 获取 lock。
2. 检查 branch、base_commit、GOAL digest。
3. 检查是否已有 final commit。
4. 如没有 commit：
   - 重新采集 final evidence。
   - 若 final-audit 缺失或 digest 过期，重跑 Final Auditor。
   - 重新执行 pre-commit check。
   - commit/tag。
5. 如已有 commit：
   - 确认 commit tree 包含允许文件和版本化 artifacts。
   - 若 tag 未完成且配置要求 tag，则只补 tag。
   - 不得重复 commit。
6. 成功后进入 PASSED。

### 9.2 resume from BLOCKED with committed code

如果状态为 BLOCKED，但 state 记录了 `final_commit_sha` 且错误是 tag 创建失败：

- resume 可以补 tag。
- 不能重新 commit。
- tag 成功后进入 PASSED。

其它 BLOCKED 不自动继续。

## 10. Status

`review-loop status` 和 `status --json` 必须补充：

- `final_audit_decision`
- `final_audit_path`
- `commit_on_pass`
- `commit_skipped`
- `final_commit_sha`
- `tag_requested`
- `tag_name`
- `tag_created`
- `push_enabled`
- `finalization_next_step`

人类可读输出规则：

- `FINALIZING`：显示“正在等待或执行最终审计/本地提交”。
- `PASSED`：显示 commit sha；如果 `--no-commit`，显示 commit skipped。
- `BLOCKED`：如果已有 commit 但 tag 失败，明确提示“代码已提交，tag 未完成”。
- `FAILED/CANCELLED`：明确显示不会 commit。

## 11. 错误归一化

Phase 5 必须复用现有错误模型，并补充或使用以下分类：

| code | phase | 说明 |
|---|---|---|
| FINAL_AUDIT_FAILED | BLOCKED 或 FAILED | final-audit decision 非 PASS |
| FINAL_AUDIT_SCHEMA_ERROR | BLOCKED | final-audit front matter 或正文不合法 |
| PRE_COMMIT_DIGEST_MISMATCH | BLOCKED | commit 前 digest 与审计版本不一致 |
| PRE_COMMIT_SCOPE_VIOLATION | BLOCKED | commit 前 scope guard 失败 |
| PRE_COMMIT_STAGED_SET_VIOLATION | BLOCKED | staged 文件超出允许集合 |
| GIT_COMMIT_ERROR | BLOCKED | commit 创建失败 |
| GIT_TAG_ERROR | BLOCKED | tag 创建失败 |
| UNSUPPORTED_PUSH | BLOCKED | 配置要求 push |

原则：

- 不能证明安全就 BLOCKED。
- 不能为了进入 PASSED 而降级错误。
- 任何 Git 错误都必须附带 stderr 摘要和已发生的副作用说明。

## 12. 测试要求

### 12.1 单元测试

至少覆盖：

1. final-audit front matter schema。
2. final-audit decision 枚举。
3. final-audit digest 校验。
4. commit message 模板替换。
5. 未知 commit message 占位符拒绝。
6. local-only artifact 分类。
7. staged set 允许/拒绝判断。
8. tag 名称模板替换。
9. `git.push: true` 拒绝。
10. `--no-commit` result 字段。

### 12.2 集成测试

使用临时 Git 仓库和 Fake Agent，至少覆盖：

1. 首轮 PASS → Final Audit PASS → commit → PASSED。
2. 二轮返工 PASS → Final Audit PASS → commit → PASSED。
3. `--no-commit` → Final Audit PASS → PASSED 且无 commit。
4. `--tag` → commit 成功 → tag 指向该 commit。
5. final-audit FAIL → 不 commit → BLOCKED 或 FAILED。
6. final-audit schema 错误 → 不 commit → BLOCKED。
7. Auditor PASS 后业务 diff 被篡改 → digest mismatch → 不 commit。
8. GOAL 被篡改 → 不 commit。
9. verification manifest 过期或失败 → 不 commit。
10. Scope Guard 发现越界文件 → 不 commit。
11. local-only artifact 被 tracked → 不 commit。
12. commit 失败 → BLOCKED 且 lock 释放。
13. commit 成功但 tag 失败 → BLOCKED，state 记录 commit sha。
14. resume 补 tag → PASSED，不重复 commit。
15. resume from FINALIZING 无 final-audit → 重跑 final audit 并 commit。
16. resume from FINALIZING 已 commit → 不重复 commit。
17. `git.push: true` → BLOCKED，不 commit。
18. cancel during Final Auditor → CANCELLED，不 commit。

### 12.3 smoke

Phase 5 完成后，应在隔离临时仓库跑一次真实模型或 Fake Agent smoke：

```text
需求：实现一个最小 hello 函数和测试
期望：Planner → Developer → Verification → Auditor → Final Audit → commit → PASSED
```

如果真实模型不可用，可以先用 Fake Agent 完成工程验收，但必须如实记录：

- 未执行真实模型的原因。
- Fake Agent 覆盖的路径。
- 后续真实模型 smoke 的建议命令。

## 13. 工程门禁

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

`npm pack --dry-run` 如因本机 Node 版本与 engines 不匹配出现 `EBADENGINE` warning，但最终退出码为 0，
可以记录为 warning，不算失败。

## 14. 交付格式

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
- Phase 5 features implemented。
- Final Audit protocol implemented。
- Commit/tag behavior。
- Resume/status changes。
- Tests added。
- Engineering gates。
- Smoke result。
- Known risks。
- Explicit non-goals：Phase 6 插件包装、Provider Profile、progress/transcript、push/PR 未实现。

如果无法完成，写：

```yaml
status: "BLOCKED"
```

并说明阻断原因、已完成内容、下一步建议。

## 15. 最终判断标准

只有同时满足以下条件，才能标记 COMPLETED：

1. Auditor PASS 后能生成合法 `.agent/final-audit.md`。
2. Final Audit PASS 后默认创建本地 commit。
3. `PASSED` 只在 final audit、digest、scope、verification 和 commit/tag 规则满足后出现。
4. `--no-commit` 路径明确标记 commit skipped。
5. 失败、BLOCKED、CANCELLED 不会 commit。
6. tag 可选且只在 commit 成功后创建。
7. resume 不重复 commit，可补 tag。
8. status 能展示最终审计、commit 和 tag 状态。
9. local-only artifact 不进入 commit。
10. 工程门禁全绿。
11. 不包含 Phase 6 越界能力。
