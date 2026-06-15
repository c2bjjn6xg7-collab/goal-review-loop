---
schema_version: 1
document_type: phase-development-requirements
phase: 7
status: DRAFT
depends_on: "Phase 6 PASS"
primary_acceptance_platform: macOS
created_at: "2026-06-14"
---

# Phase 7 需求草案：智能模型路由与多 worktree 并发调度

## 1. 文档定位

本文档记录后续增强方向：在项目开始时根据任务复杂度、风险和依赖关系，把不同任务交给不同
Developer Provider，并在安全隔离的 Git worktree 中并发执行。

Phase 7 不应在 Phase 6 之前实施。Phase 1-6 的目标仍是稳定的单 Goal 闭环：

```text
Planner → Developer/Rework → Verification → Auditor → Final Audit → local commit/tag
```

Phase 7 在此基础上增加项目级调度层。

## 2. 用户目标

用户希望：

- 困难任务交给更强模型，减少返工和误改。
- 简单任务交给低成本国产模型或 custom CLI，降低成本。
- 互不影响的任务可以多开 CLI 并发处理，缩短项目总耗时。
- 并发不会污染同一个工作区，也不会把冲突任务自动合并坏。

## 3. 核心原则

1. 同一个工作区仍只能有一个活动 run。
2. 并发必须通过独立 Git worktree 和独立任务分支实现。
3. 模型只处理分配给它的任务，不自行抢任务。
4. Provider 选择由系统根据规则和证据决定，不由 Developer 自己决定。
5. 每个子任务仍必须走完整 Review Loop。
6. 子任务通过不等于项目通过；最终必须经过 Integration Audit。

## 4. Worker 分层

Phase 7 不应写死“Plus 插件”或某个具体商业入口，而应抽象为 worker 类型：

| worker | 推荐实现 | 职责 |
|---|---|---|
| `planner` | Codex / GPT 高质量模型 | 项目理解、任务拆解、DAG、风险和复杂度评估 |
| `premium_worker` | 高质量 Developer Provider | 核心架构、高风险、安全、跨模块、复杂 bug |
| `balanced_worker` | 中等成本 Provider | 普通 feature、中等 bugfix、局部重构 |
| `cheap_worker` | 国产模型 / 低成本 custom Provider | 文档、测试、小功能、明确边界内的机械改动 |
| `auditor` | Codex / GPT 高质量模型 | 子任务 diff 审计、返工判断 |
| `integration_auditor` | Codex / GPT 高质量模型 | 多任务合并后的最终集成审计 |

命名原则：

- 文档和配置使用 `premium_worker`，不要直接写死 `Plus`。
- `premium_worker` 可以映射到 Codex 高质量模型、Claude 高配模型、OpenRouter 高质量模型、
  本地高质量 CLI 或其它官方可用能力。
- 不通过第三方不可信中转服务发送敏感项目代码。
- Worker 的实际命令仍由 Provider Profile 提供。

推荐执行模型：

```text
planner
  → task-graph.json
  → Provider Router
  → premium_worker / balanced_worker / cheap_worker
  → per-task handoff
  → auditor
  → rework or escalation
  → integration_auditor
```

## 5. 任务复杂度分类

Planner 在项目开始时生成 Task Graph，每个 task 至少包含：

```yaml
task_id: "T-001"
title: "实现用户登录表单校验"
description: "..."
dependencies: []
allowed_changes:
  - "src/auth/**"
  - "tests/auth/**"
verification_commands:
  - "npm test -- auth"
complexity:
  level: "low" | "medium" | "high" | "critical"
  reasons:
    - "single module"
    - "has existing tests"
risk:
  level: "low" | "medium" | "high" | "critical"
  dimensions:
    security: "low"
    data_migration: "none"
    cross_module: "medium"
parallelism:
  eligible: true
  conflict_paths:
    - "src/auth/**"
recommended_provider:
  tier: "cheap" | "balanced" | "strong"
recommended_worker: "cheap_worker" | "balanced_worker" | "premium_worker"
route_reason:
  - "single module"
  - "low security risk"
escalation:
  max_attempts_before_upgrade: 2
  upgrade_to: "premium_worker"
  upgrade_on_severity:
    - "high"
    - "critical"
```

建议分类规则：

| 任务类型 | 推荐模型 |
|---|---|
| 架构设计、跨模块重构、状态机、安全策略、数据迁移 | strong |
| 中等 bugfix、局部 feature、需要读多文件的改动 | balanced |
| 单文件小改、补测试、文档、样式、机械重命名 | cheap |
| 需求不清或验收不完整 | strong Planner 先澄清 |

推荐给 `premium_worker` 的任务：

1. 核心架构或状态机。
2. 多模块联动。
3. 安全、权限、支付、数据一致性。
4. 复杂 bug 定位。
5. 大范围重构。
6. 一旦做错返工成本很高。
7. 需要强推理或深代码理解。

推荐给 `cheap_worker` 的任务：

1. 明确的小功能。
2. UI 文案和简单样式调整。
3. 文档补充。
4. 测试用例补充。
5. 类型修复。
6. 简单 bugfix。
7. 重复性代码改造。
8. 明确文件范围内的实现。

## 6. Provider Router

Provider Profile 应增加：

| 字段 | 说明 |
|---|---|
| `provider_id` | `claude`、`codebuddy`、`opencode`、`custom` |
| `capability_tier` | `strong`、`balanced`、`cheap` |
| `cost_tier` | `high`、`medium`、`low` |
| `recommended_task_types` | 适合任务类型 |
| `max_parallel_runs` | 允许并发数 |
| `timeout_ms` | 默认超时 |
| `sensitive_task_allowed` | 是否允许处理敏感任务 |
| `historical_pass_rate` | 历史通过率，可后续统计 |
| `worker_roles` | 该 Provider 可承担的 worker 类型 |
| `escalation_target` | 失败后升级到哪个 Provider 或 worker |

路由规则：

- `critical/high` 风险任务只能路由到 strong 或用户明确允许的 Provider。
- 安全、密钥、支付、数据迁移任务默认禁止 cheap Provider。
- cheap Provider 连续失败达到阈值后，自动升级到 balanced/strong。
- Provider 认证失败或健康检查失败时，不自动降级到更弱模型处理敏感任务。

## 7. 失败升级机制

Escalation 是 Phase 7 的成本控制核心：先让低成本模型处理边界清晰的小任务，但在失败信号足够强时自动升级。

建议规则：

- Low/Medium finding：默认退回原 worker 返工。
- High/Critical finding：升级到 `premium_worker`。
- 同一任务连续失败 2 次：升级到 `premium_worker`。
- Scope Guard 越界且涉及核心路径：升级到 `premium_worker` 或 BLOCKED。
- 架构方向偏离、需求理解错误：退回 `planner` 重新拆解，不让 Developer 硬修。
- Provider 认证失败、命令不可用、额度不足：BLOCKED，不自动换弱模型处理敏感任务。

升级后的任务必须保留：

- 原 worker 的 handoff。
- 审计 findings。
- verification 结果。
- diff 摘要。
- 升级原因。

`premium_worker` 返工时仍只能修改该任务的 Allowed Changes，不得借升级扩大任务范围。

## 8. 并发分类

任务可并发必须同时满足：

- 依赖关系为空或依赖已通过并合并。
- `allowed_changes` 与其它并发任务不重叠。
- 不修改共享高风险文件，例如 package manager lockfile、数据库 migration、全局配置、鉴权核心。
- verification commands 可独立运行。
- 任务分支能从同一 base commit 创建。

任务不得并发的常见情况：

- 都会修改同一个文件或同一路径。
- 一个任务依赖另一个任务的类型、接口或数据结构。
- 都需要修改 `package.json`、`package-lock.json`、`tsconfig`、构建配置。
- 涉及 migration 顺序或数据兼容。
- 全量测试无法拆分，且局部验证没有意义。

## 9. Worktree Scheduler

调度器负责：

1. 从 Task Graph 选择可运行任务。
2. 为每个任务创建独立 Git worktree。
3. 在每个 worktree 内运行独立 `review-loop start`。
4. 限制全局并发数和每个 Provider 并发数。
5. 收集每个任务的状态、commit sha、final-audit 和验证结果。
6. 失败任务进入 FAILED/BLOCKED，不影响其它独立任务继续。

建议目录：

```text
.agent/scheduler/
  task-graph.json
  scheduler-state.json
  runs/
    T-001/
    T-002/

../cc劳工系统-worktrees/
  T-001/
  T-002/
```

## 10. Integration 阶段

所有可合并任务通过后，Integration Orchestrator 必须：

1. 回到主集成分支。
2. 按 DAG 顺序逐个 merge 或 cherry-pick 子任务 commit。
3. 每合并一个任务后检查冲突。
4. 所有任务合并后运行全量 verification。
5. 采集集成 diff。
6. 运行 Integration Auditor。
7. 只有集成审计 PASS 后，才创建项目级最终 commit/tag 或标记项目批次 PASSED。

子任务 PASS 不代表项目整体 PASS。

## 11. CLI 草案

后续可新增：

```bash
review-loop plan-project --request <file> --output .agent/scheduler/task-graph.json
review-loop schedule --task-graph .agent/scheduler/task-graph.json --max-parallel 3
review-loop scheduler status --json
review-loop scheduler cancel
review-loop scheduler integrate
```

Phase 7 之前，这些命令不得出现在可用 CLI 中。

## 12. 验收标准草案

Phase 7 完成条件：

1. 能生成合法 Task Graph。
2. 能把任务分为 high/medium/low/critical。
3. 能根据 Provider Profile 选择合适 Developer Provider。
4. 能识别可并发和不可并发任务。
5. 可并发任务在独立 Git worktree 中运行。
6. 同一工作区并发仍被 lock 阻止。
7. 两个独立任务可以并发通过并保留各自证据。
8. 路径冲突任务不会并发。
9. cheap Provider 失败后可升级到更强 Provider。
10. Integration 阶段能顺序合并并重新全量验证。
11. 集成审计失败时不会标记项目 PASSED。
12. 不执行自动 push 或破坏性 Git 清理。
13. High/Critical finding 能触发升级到 `premium_worker`。
14. 连续失败 2 次的 cheap 任务能自动升级。
15. 架构方向错误能退回 `planner` 重新拆解。
