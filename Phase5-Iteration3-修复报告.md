# Phase 5 Iteration 3 修复报告

**修复 ID**: F-501R1 / F-503R1 / F-504R1
**基线版本**: Iteration 2 (commit d381ad3)
**修复日期**: 2026-06-15
**修复人**: QoderCN

---

## 1. 背景

Phase 5 Iteration 2 通过了基础门禁（typecheck / lint / build / test / audit），但在复验阶段被发现存在 3 个阻断/准阻断问题，导致无法进入 Phase 6。本报告记录这三个问题的根因分析、修复方案、测试覆盖和验证结果。

---

## 2. 修复清单

### 2.1 F-501R1 — Final Auditor 修改已存在业务 diff 仍会漏检

| 字段 | 值 |
|------|-----|
| 严重性 | Critical |
| 状态 | **已修复** |

#### 根因

Iteration 2 在 Final Auditor 运行后重新采集 diff（`postFinalAuditDiffResult`），但校验逻辑仅比较：

1. **路径是否存在**：新增的业务文件路径是否出现在 pre-diff 中
2. **git status 是否变化**：同一路径的 status 字段（如 `modified` → `added`）

**漏洞场景**：Developer 已修改 `src/foo.ts`（status = `modified`），Final Auditor 再向同一文件追加内容。路径仍存在，status 仍为 `modified`，当前逻辑**不会发现**。

#### 修复方案

在 Final Auditor 运行**之前**，对 diff 中所有非 `.agent/` 文件（`changedFiles` + `untrackedFiles`）计算 SHA-256 digest，存入 `preFinalAuditBusinessDigests: Map<string, Digest>`。

Final Auditor 运行后，重新采集 diff 并逐文件重算 digest，与快照比较：

| 检测项 | 判定逻辑 |
|--------|---------|
| 新增业务文件 | `changedFiles` 中路径不在快照中 |
| 新增未跟踪文件 | `untrackedFiles` 中路径不在快照中 |
| 内容篡改 | 路径在快照中但 digest 不匹配 |
| 文件删除 | 快照中路径在 post-diff 和文件系统中均不存在 |

任何违规 → BLOCKED，错误码 `SCOPE_VIOLATION`。

#### 变更文件

- `src/orchestrator/run-orchestrator.ts`
  - 新增 `computeFileDigest` 导入（L29）
  - 新增 pre-Final-Auditor digest 快照逻辑（L1893–L1907）
  - 替换 post-Final-Auditor 校验：路径/status → digest 比较（L2020–L2087）

#### 测试覆盖

| 测试 | 类型 | 验证内容 |
|------|------|---------|
| Scenario 19 | 集成 | Final Auditor 写 PASS 报告后 append 业务文件 → BLOCKED / SCOPE_VIOLATION |
| `audit-tamper-final` | Fixture | fake-agent 新增行为：写合法报告 + 篡改 `src/test-impl.ts` |

---

### 2.2 F-503R1 — Resume 信任已存在 commit 但未验证 commit tree

| 字段 | 值 |
|------|-----|
| 严重性 | High |
| 状态 | **已修复** |

#### 根因

Iteration 2 添加了 `commitExists()` 检查（`git cat-file -t <sha>`），确认 SHA 在 git 对象库中存在。但 Phase 5 要求的是确认该 commit **是本 run 的最终 commit**，即包含所有 5 个 versioned artifacts：

```
.agent/plan.md
.agent/GOAL.md
.agent/developer-handoff.md
.agent/audit-report.md
.agent/final-audit.md
```

当前只证明 SHA 存在，不证明其内容正确。一个初始 commit 或手动 commit 也能通过检查，导致跳过整个 finalization 管线。

#### 修复方案

新增 `verifyCommitTree()` 函数：

```typescript
export async function verifyCommitTree(
  projectRoot: string,
  sha: string,
  requiredPaths: string[],
): Promise<{ valid: boolean; missing: string[] }>
```

使用 `git ls-tree -r --name-only -z <sha>` 枚举 commit tree 中的所有文件路径，与 required paths 做差集。

在 `runFinalization()` 的 early-exit 路径中，`commitExists()` 通过后立即调用 `verifyCommitTree()`。若缺失任何 artifact → 清除 stale SHA，fall through 到完整 finalization 管线重新执行。

#### 变更文件

- `src/git/commit-manager.ts`
  - 新增 `verifyCommitTree()` 函数（L277–L293）
- `src/orchestrator/run-orchestrator.ts`
  - 新增 `verifyCommitTree` 导入（L45）
  - 新增 tree 验证逻辑（L1653–L1672）
  - 新增 `else` 分支关闭（L1773）

#### 测试覆盖

| 测试 | 类型 | 验证内容 |
|------|------|---------|
| Scenario 20 | 集成 | 将 `final_commit_sha` 指向不含 artifacts 的旧 commit → resume 重新执行 finalization 并生成新 commit |
| `verifyCommitTree` valid | 单元 | commit 包含所有 required paths → `valid: true, missing: []` |
| `verifyCommitTree` missing | 单元 | commit 缺少 `.agent/plan.md` 等 → `valid: false, missing: [...]` |

---

### 2.3 F-504R1 — Commit failure 覆盖不真实

| 字段 | 值 |
|------|-----|
| 严重性 | Medium |
| 状态 | **已修复** |

#### 根因

**问题 A**：Scenario 12 实际测试的是 Final Audit FAIL 后 lock 释放（`finalAuditor: 'audit-fail'`），不是 commit failure。测试标题和注释误导性地声称 "commit failure covered by unit tests"。

**问题 B**：`commit-manager.test.ts` 仅测试纯函数（`renderCommitMessage`、`isLocalOnlyPath` 等），未覆盖 `createCommit()` 和 `createTag()` 的失败路径。

#### 修复方案

**问题 A — Scenario 12 标题修正**：更新标题和注释，明确其测试的是 "BLOCKED state lock release guarantee"，不再声称覆盖 commit failure。

**问题 B — 新增真实失败路径测试**：

| 测试层 | 新增内容 |
|--------|---------|
| 单元测试 `commit-manager.test.ts` | `createCommit` success + failure（read-only `.git/objects`）、`createTag` success + duplicate failure、`commitExists` exists + missing、`verifyCommitTree` valid + missing |
| 集成测试 `finalization.test.ts` | Scenario 21：read-only `.git/objects` → 真实 git commit 失败 → BLOCKED + lock 释放 |

#### 变更文件

- `tests/unit/commit-manager.test.ts`
  - 新增 imports：`createCommit`, `createTag`, `commitExists`, `verifyCommitTree`, `getHeadSha`, `execSync`, `chmodSync` 等
  - 新增 `createTestRepo()` helper
  - 新增 4 个 describe 块、8 个测试用例
- `tests/integration/finalization.test.ts`
  - 新增 imports：`chmodSync`, `renameSync`
  - Scenario 12 标题更新（L397）
  - 新增 Scenario 21（L693–L724）
- `tests/fixtures/fake-agent.mjs`
  - 新增 `audit-tamper-final` 行为（L619–L629）

---

## 3. 测试统计

| 指标 | Iteration 2 | Iteration 3 | 增量 |
|------|-------------|-------------|------|
| 总测试数 | 654 | 665 | +11 |
| 测试文件 | 40 | 40 | 0 |
| 集成场景 | 18 | 21 | +3 |
| commit-manager 单元测试 | 21 | 29 | +8 |

### 新增测试明细

| # | 测试名 | 文件 | 覆盖的 Finding |
|---|--------|------|---------------|
| 1 | `createCommit` → valid SHA | commit-manager.test.ts | F-504R1 |
| 2 | `createCommit` → failure | commit-manager.test.ts | F-504R1 |
| 3 | `createTag` → success | commit-manager.test.ts | F-504R1 |
| 4 | `createTag` → duplicate failure | commit-manager.test.ts | F-504R1 |
| 5 | `commitExists` → true | commit-manager.test.ts | F-503R1 |
| 6 | `commitExists` → false | commit-manager.test.ts | F-503R1 |
| 7 | `verifyCommitTree` → valid | commit-manager.test.ts | F-503R1 |
| 8 | `verifyCommitTree` → missing | commit-manager.test.ts | F-503R1 |
| 9 | Scenario 19: tamper detection | finalization.test.ts | F-501R1 |
| 10 | Scenario 20: missing tree artifacts | finalization.test.ts | F-503R1 |
| 11 | Scenario 21: real commit failure | finalization.test.ts | F-504R1 |

---

## 4. 门禁结果

| 门禁项 | 结果 |
|--------|------|
| `npm run typecheck` | ✅ 0 errors |
| `npm run lint` | ✅ 0 errors, 0 warnings |
| `npm run build` | ✅ tsc 编译成功 |
| `npm test` | ✅ 665 passed, 0 skipped, 0 failed (40 files) |
| `npm audit --omit=dev` | ✅ 0 vulnerabilities |
| `npm pack --dry-run` | ✅ 147 files, 162.7 kB |
| `git diff --check` | ✅ no whitespace errors |

---

## 5. 变更文件清单

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/orchestrator/run-orchestrator.ts` | 修改 | digest 快照 + tree 验证 + import 更新 |
| `src/git/commit-manager.ts` | 修改 | 新增 `verifyCommitTree()` |
| `tests/fixtures/fake-agent.mjs` | 修改 | 新增 `audit-tamper-final` 行为 |
| `tests/integration/finalization.test.ts` | 修改 | Scenario 12 标题 + Scenario 19/20/21 |
| `tests/unit/commit-manager.test.ts` | 修改 | 8 个新 git 操作测试 |
| `.agent/developer-handoff.md` | 修改 | Iteration 3 文档 |

---

## 6. 残留风险

| # | 风险 | 影响 | 缓解措施 |
|---|------|------|---------|
| 1 | 未做真实模型 smoke test | 中 | Phase 6 前必须用真实模型验证 |
| 2 | Early-exit 路径跳过 workspace 校验 | 低 | commit 已创建且 tree 已验证，workspace 后续篡改不影响已提交内容 |
| 3 | Scenario 21 依赖 `chmod` 行为 | 低 | `finally` 块恢复权限，跨平台兼容（macOS/Linux） |

---

## 7. 结论

三个复验阻断问题均已修复并通过新增测试覆盖：

- **F-501R1**：Final Auditor 内容级篡改现在通过 SHA-256 digest 快照检测，替代了不可靠的路径/status 比较
- **F-503R1**：Resume 不再仅凭 commit 存在性跳过 finalization，而是验证 commit tree 包含所有必需 artifacts
- **F-504R1**：`createCommit()` / `createTag()` 失败路径现在有真实的单元和集成测试覆盖

Phase 5 现在可以进入复验阶段。
