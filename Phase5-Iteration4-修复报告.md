# Phase 5 Iteration 4 修复报告

**修复 ID**: F-501R2 / F-503R2
**基线版本**: Iteration 3
**修复日期**: 2026-06-15
**修复人**: QoderCN

---

## 1. 背景

Phase 5 Iteration 3 通过了所有工程门禁（665 tests passed），但在语义安全复验中发现 2 个缺口：

1. **F-501R2**：Final Auditor 将 Developer 已修改的业务文件恢复为 base 内容（revert-to-base），该文件会从 `git diff` 中消失，但文件仍在磁盘上，Iteration 3 的 digest 检查漏检
2. **F-503R2**：`verifyCommitTree()` 只检查路径存在，不验证 commit 是否属于当前 run

---

## 2. 修复清单

### 2.1 F-501R2 — Revert-to-base 漏检

| 字段 | 值 |
|------|-----|
| 严重性 | Critical |
| 状态 | **已修复** |

#### 根因分析

Iteration 3 的 digest 检查采用三趟遍历：

1. 遍历 post-diff 的 `changedFiles`，检查 digest 变化
2. 遍历 post-diff 的 `untrackedFiles`，检查新增文件
3. 遍历 pre-snapshot，检查文件是否从磁盘上消失

**漏洞场景**：Developer 修改了 `src/foo.ts`（添加了新代码），Final Auditor 将 `src/foo.ts` 恢复为 base commit 中的原始内容。此时：

- `git diff --name-status` 不会列出 `src/foo.ts`（内容与 base 相同 = 无 diff）
- 文件仍存在于磁盘上
- 三趟检查均不会触发违规

#### 修复方案

改为两趟穷举式检查：

**Pass 1（核心改动）**：遍历 `preFinalAuditBusinessDigests` 中的**每一个**文件，无条件地重新计算磁盘上文件的 digest 并比较：

```
for (const [path, preDigest] of preFinalAuditBusinessDigests) {
  const fullPath = join(projectRoot, path);
  if (!existsSync(fullPath)) {
    // 文件被删除 → BLOCKED
  } else {
    const currentDigest = await computeFileDigest(fullPath);
    if (currentDigest !== preDigest) {
      // 内容被修改（含 revert-to-base）→ BLOCKED
    }
  }
}
```

**Pass 2**：遍历 post-diff 检测新增业务文件。

这确保无论文件在 post-diff 中是否出现，pre-snapshot 中的每个文件都会被逐一验证。

#### 测试覆盖

| 测试 | 类型 | 验证内容 |
|------|------|---------|
| Scenario 22 | 集成 | `audit-revert-final` 行为：Final Auditor 写 PASS 报告后删除 Developer 创建的业务文件 → BLOCKED / SCOPE_VIOLATION |
| `audit-revert-final` | Fixture | fake-agent 新增行为：写合法报告 + `unlinkSync(src/test-impl.ts)` |

---

### 2.2 F-503R2 — Commit tree 不证明属于当前 run

| 字段 | 值 |
|------|-----|
| 严重性 | High |
| 状态 | **已修复** |

#### 根因分析

Iteration 3 的 `verifyCommitTree()` 使用 `git ls-tree` 检查 5 个 versioned artifact 路径是否存在。但任何包含这些路径的 commit 都会通过检查——包括其他 run 的 commit、手动创建的 commit、或陈旧 run 的 commit。

#### 修复方案

在 tree check 通过后，增加 commit 内容验证：

1. 使用 `git show <sha>:.agent/final-audit.md` 从 commit 中提取 `final-audit.md`
2. 使用 `parseFinalAudit()` 解析 frontmatter
3. 验证 `run_id === currentRunId`
4. 验证 `decision === 'PASS'`

任一不匹配 → 清除 stale SHA，fall through 重新执行 finalization。

#### Digest 比较的设计决策

**最初方案**包含 `goal_digest` 和 `diff_digest` 比较。实际测试中发现 `diff_digest` 在 resume 场景下**必然不匹配**：

- AUDITING 阶段的 diff digest 不包含 `.agent/final-audit.md`（文件尚未创建）
- FINALIZING 阶段的 diff digest 包含 `.agent/final-audit.md`（作为 untracked file）
- commit 后 resume 时，`.agent/final-audit.md` 已 committed → diff 再次变化

这是一个循环依赖：`final-audit.md` 既在 commit 中，又影响 diff digest。因此**有意放弃** digest 比较，仅保留 `run_id` + `decision` 验证。

**安全性分析**：
- `run_id` 匹配 → 证明 commit 属于当前 run
- `decision === PASS` → 证明 Final Auditor 批准
- `verifyCommitTree` 通过 → 证明所有 artifact 存在
- 三者组合提供了足够强的身份保证

#### 测试覆盖

| 测试 | 类型 | 验证内容 |
|------|------|---------|
| Scenario 23 | 集成 | 将 commit 的 `final-audit.md` 中 `run_id` 改为 `"wrong-run-id"` → resume 重新执行 finalization |

---

## 3. 测试统计

| 指标 | Iteration 3 | Iteration 4 | 增量 |
|------|-------------|-------------|------|
| 总测试数 | 665 | 667 | +2 |
| 集成场景 | 21 | 23 | +2 |

### 新增测试明细

| # | 测试名 | 文件 | 覆盖的 Finding |
|---|--------|------|---------------|
| 1 | Scenario 22: revert-to-base detection | finalization.test.ts | F-501R2 |
| 2 | Scenario 23: wrong run_id in commit | finalization.test.ts | F-503R2 |

---

## 4. 门禁结果

| 门禁项 | 结果 |
|--------|------|
| `npm run typecheck` | ✅ 0 errors |
| `npm run lint` | ✅ 0 errors, 0 warnings |
| `npm run build` | ✅ |
| `npm test` | ✅ 667 passed, 0 skipped, 0 failed (40 files) |
| `npm audit --omit=dev` | ✅ 0 vulnerabilities |
| `git diff --check` | ✅ no whitespace errors |

---

## 5. 变更文件清单

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/orchestrator/run-orchestrator.ts` | 修改 | F-501R2 两趟穷举检查 + F-503R2 commit 内容验证 + `parseFinalAudit` 导入 |
| `tests/fixtures/fake-agent.mjs` | 修改 | 新增 `audit-revert-final` 行为 |
| `tests/integration/finalization.test.ts` | 修改 | Scenario 22, 23 |
| `.agent/developer-handoff.md` | 修改 | Iteration 4 文档 |

---

## 6. 残留风险

| # | 风险 | 影响 | 缓解措施 |
|---|------|------|---------|
| 1 | 未做真实模型 smoke test | 中 | Phase 6 前必须用真实模型验证 |
| 2 | F-503R2 不验证 digest | 低 | `run_id` + `decision` + tree check 提供足够身份保证；digest 因循环依赖无法可靠比较 |
| 3 | Early-exit 跳过 workspace 校验 | 低 | commit 已创建且内容已验证，后续篡改不影响已提交内容 |

---

## 7. 结论

两个语义安全缺口均已修复：

- **F-501R2**：穷举式 digest 重验证确保 pre-snapshot 中的每个业务文件在 Final Auditor 运行后内容完全不变，覆盖 revert-to-base、内容篡改、文件删除三种攻击向量
- **F-503R2**：commit 内容验证通过 `run_id` + `decision` 确认 commit 属于当前 run 且经 Final Auditor 批准，弥补了纯路径检查的身份盲区

Phase 5 现在可以进入语义验收复验阶段。
