# Phase 8D 实现任务书:Worktree 并行执行

> Status: Ready for implementation (after pre-flight bug fixes, §2)
> Scope: Goal Review Loop repository
> Priority: Next major phase (10 ✓ → 9 可后置 → **8D** → 8E)
> Depends on: Phase 8B (serial task-graph, 已实现); Phase 10 (已实现,验证过)
> Source of truth for **design**: `docs/phase-8d-worktree-parallel-execution.md`
> Source of truth for **implementation**: 本文档
> Created: 2026-06-18(经两轮真实 smoke 后定稿)

本文档是给开发师的**实现导向任务书**。设计意图、wave 模型、失败策略、验收标准
见设计文档(`docs/phase-8d-worktree-parallel-execution.md` §1–§13);本文档规定
**怎么落地**:实现顺序、文件清单、函数签名、前置 bug、可增量验证的里程碑。
两文档冲突时,设计文档为准(它是 source of truth);本文档补充实现约束。

---

## 0. 关键背景(给开发师)

Phase 8D 是从**串行 task-graph(8B)**到**并发 task-graph**的跨越,是 8 系列最大
改动。核心不变量:**隔离**——每个 task 在独立 worktree + 独立分支跑,互不污染。

本次会话做了两轮真实 review-loop smoke(2026-06-18),产出三个直接影响 8D 实现的
发现,**必须先处理(§2)再开工 8D 本体**:

1. `--no-commit` 下 finalization 仍产生了 commit(`db359007`)——并发 N 个 task 时
   这会变成 N 个污染 commit,灾难。**前置必修**。
2. final audit FAIL → BLOCKED 后进程卡死挂起(CPU 0%,无子进程,需 kill)。并发下
   一个 task 卡死会拖住整个 wave。**前置必修**。
3. `.agent/` run 状态文件(state/lock/progress/transcripts)不在 `.gitignore` 全覆盖,
   新 run 启动会因残留 state 拒绝("state.json already exists")。并发下 worktree 间
   state 文件冲突是 8D 的核心难点之一。

---

## 1. 任务分解(按依赖顺序,每阶段可独立验证)

| # | 阶段 | 依赖 | 验证里程碑 |
|---|---|---|---|
| **P0** | 前置 bug 修复(§2) | 无 | `--no-commit` 真不 commit;BLOCKED 不卡死 |
| **P1** | LockManager 加 lockName 参数(§3.1) | P0 | 单测:两把锁不同文件 |
| **P2** | scope-guard 加 `.agent/worktrees/**` 白名单(§3.2) | 无(可与 P1 并行) | scope 测试:worktree 路径被保护 |
| **P3** | WorktreeManager(§4.1) | P1 | 单测:create/cleanup/prune/resume |
| **P4** | 路径冲突检测(§4.2) | 无(可与 P3 并行) | 单测:`src/auth/**` vs `src/auth/login.ts` 判冲突 |
| **P5** | Wave 调度器(§4.3)+ 替换 serial loop | P3,P4 | 集成:4-task 图产生正确 wave 分层 |
| **P6** | 失败策略 1-C + 2-C(§4.4)+ run 级熔断 §7.3 | P5 | 集成:fake-agent 跑全升级阶梯 |
| **P7** | Resume 按 status 驱动(§4.5)+ 孤儿回收 | P5,P6 | 集成:崩溃后 resume 跳过 passed task |
| **P8** | 子进程结果回传(§4.6) | P5 | 单测:result.json 读写 + 缺失处理 |
| **P9** | 验收清单逐条过(设计文档 §12) | 全部 | 见设计文档 §12.1 + §12.2 |

**建议节奏**:P0 先做(smoke 暴露的硬伤,不修 8D 没法安全并发);P1+P2 并行(小改);
P3+P4 并行(独立模块);P5 是核心重构(串行→并发,最难);P6/P7/P8 是行为完善。

---

## 2. P0 — 前置 bug 修复(smoke 发现,阻塞 8D)

### 2.1 `--no-commit` 失效

**现象**:本次 smoke 用 `review-loop start --no-commit`,final audit PASS 后仍产生
commit `db359007`(`feat(agent): complete ...`)。

**代码线索**:`src/orchestrator/run-orchestrator.ts:2293`
```ts
// §6.3: --no-commit path
if (noCommit || !config.git.commit_on_pass) { ... }
```
逻辑看起来对,但实际 commit 了。需调查:
- `noCommit` 是否正确从 CLI `--no-commit` 透传到 line 2293(追踪 line 316/341/610/633/1245/1428 的 `params.no_commit ?? !config.git.commit_on_pass` 链路)
- 是否 task-graph 模式走的是**另一条** finalization 路径(不经 line 2293),漏了 noCommit 判断
- commit 在 task 分支还是主分支(本次在 task 分支,但仍是未预期的行为)

**修复验收**:写一个集成测试,`--no-commit` 跑到 PASSED,断言**无新 commit**(`git rev-parse HEAD` 前后一致)。

### 2.2 BLOCKED 后进程卡死

**现象**:第一轮 smoke(需求 A)final audit FAIL → state 写入 BLOCKED 后,主进程
挂起 10+ 分钟:CPU 0%、无子进程、无新日志,需 `kill -9`。state.json 已是终态 BLOCKED
(数据没丢)。

**调查方向**:
- BLOCKED 收尾路径(finalization failed 分支)是否在等一个永不到来的信号/IO
- 是否 `--no-commit` + FAIL 的组合触发(和 2.1 可能同源)
- 是否归档 history/archive 阶段挂起(代理慢时 IO 超时?)

**修复验收**:集成测试,final audit 强制返回 FAIL,断言 run 在合理时间内(如 < 30s)
干净退出到 BLOCKED,进程不残留。

> 这两个 bug 不是 8D 引入的,但 8D 并发会**放大**它们(N 个 task 同时 commit 污染、
> 一个 task 卡死拖住整个 wave)。P0 必须先修。

### 2.3 `.agent/` state 残留阻断新 run(已知,非 bug)

**现象**:新 `review-loop start` 在 `.agent/state.json` 存在时报
"Cannot create initial state: state.json already exists"。

这是**设计行为**(防并发 run),但 smoke 时需要手动清 state.json/transcripts/ 等
才能重跑。8D 下每个 worktree 有独立 .agent(在 worktree 内),**主仓库 .agent/state.json
是调度器状态**,worktree 内是 task 状态——这点 §4.5 resume 要理清。不需要 P0 修,
但 P5 实现时要明确两套 state 的边界。

---

## 3. P1+P2 — 前置小改

### 3.1 P1:LockManager 加 lockName 参数(§Q1.2)

**问题**:`src/runtime/lock-manager.ts:27` 把锁文件名写死成 `run.lock`。8D 下主调度器
锁(主仓库)和 worktree 内 task 锁都需要,会撞名。

**改法**:给 `LockManager` 构造函数或 `acquire` 加 `lockName` 参数(默认 `run.lock`
保现状):
```ts
// 现状:new LockManager(agentDir)  → 固定 run.lock
// 改后:new LockManager(agentDir, { lockName: 'scheduler.lock' })
```
主调度器锁用 `scheduler.lock`,worktree task 锁仍用 `run.lock`。

**验收**:单测——同一 agentDir 下两把不同 lockName 的锁互不干扰;默认值行为不变。

### 3.2 P2:scope-guard 加 `.agent/worktrees/**`(设计文档 §6)

**问题**:8D worktree 默认放 `.agent/worktrees/{run_id}/{task_id}/`(项目内)。scope-guard
必须把该路径列为 system-protected,否则 worker 可能改到别的 task 的 worktree。

**改法**:`src/scope/scope-guard.ts` 的 `SYSTEM_PROTECTED_PATHS` 和
`ORCHESTRATOR_OWNED_PATTERNS` 各加 `'.agent/worktrees/**'`。

**验收**:`feedback-failure-safety.test.ts` 风格的测试——一个 worker 的 allowed_changes
即使写了 `.agent/worktrees/other-task/**` 也被拒。

> 这两个改动小、独立、不破坏现状(默认值保 byte-identical),适合作为 8D 的热身。

---

## 4. 8D 核心模块(P3–P8)

### 4.1 P3:WorktreeManager(新文件 `src/scheduler/worktree-manager.ts`)

职责:为每个 task 创建/清理 git worktree + 分支。设计文档 §5 定义命名规范:
- 分支:`agent/{run_id}/{task_id}-{slug}`
- worktree:`.agent/worktrees/{run_id}/{task_id}/`
- 基:所有 task 从同一 stable `base_commit` 分出

**关键方法签名**(参考现有 `src/git/git-manager.ts` 风格):
```ts
export class WorktreeManager {
  constructor(projectRoot: string);
  // 创建 task 的 worktree + 分支,返回 worktree 路径。幂等:已存在则复用。
  async createForTask(params: {
    runId: string; taskId: string; slug: string; baseCommit: string;
  }): Promise<{ worktreePath: string; branch: string }>;
  // 清理单个 task 的 worktree(保留分支供 8E cherry-pick)
  async cleanupTask(runId: string, taskId: string): Promise<void>;
  // prune 已不存在的 worktree 元数据(启动/resume 时调用)
  async prune(): Promise<void>;
  // 列出某 run 的所有残留 worktree(给 resume 用,检测孤儿)
  async listForRun(runId: string): Promise<WorktreeInfo[]>;
}
```

**铁律**:
- **fail closed**:worktree 创建/清理失败 → task 标 infra_error,不污染主仓库
- **绝不 `git worktree remove --force` 未确认的内容**:resume 时检测到孤儿 worktree,
  报告给用户,不自动删(设计文档 §11)
- 用 `child_process` 调 git,捕获 stderr,转成可读错误

**验收**:单测覆盖 create/cleanup/prune/list + 幂等(重复 create 复用)+ 孤儿检测。

### 4.2 P4:路径冲突检测(新文件 `src/scheduler/conflict-detector.ts`)

设计文档 §9 + 审查 Q1.3。**用项目已有的 `micromatch`**,不引入新库。

**算法**(双保险,保守优先):
1. **前缀快筛**:取每个 glob 第一个 `**` 或通配符前的字面量目录前缀。两前缀无
   包含关系 → 必不冲突。
2. **真实文件样本精筛**:用 `git ls-files` 拿全量跟踪文件(现有用法见
   `task-graph-loop.ts`),两 glob 命中同一文件 → 冲突。
3. 拿不准 → **判冲突**(保守,宁可串行)。

**关键 case(必须有测试,设计文档 §12.1 §30)**:
- `src/auth/**` vs `src/auth/login.ts` → **冲突**(前缀包含)
- `src/auth/**` vs `src/core/**` → 不冲突(前缀不交)
- `*.ts` vs `src/foo.ts` → 保守判冲突(`*.ts` 无目录前缀)

**方法签名**:
```ts
export function globsMayConflict(a: string, b: string, trackedFiles: string[]): boolean;
export function detectWaveConflicts(
  tasks: Task[], trackedFiles: string[]
): Map<TaskId, TaskId[]>;  // 返回每个 task 与同 wave 哪些 task 冲突
```

**验收**:设计文档 §12.1 §30——`src/auth/**` vs `src/auth/login.ts` 被正确识别且
**分到不同 wave**。bare-string-equality 实现必须过不了这测试。

### 4.3 P5:Wave 调度器(替换 serial loop)— 核心

**这是 8D 最难的改动**:把 `task-graph-loop.ts` 的串行 `current_task_index` 驱动
改成 wave 驱动。设计文档 §7.1 定义 wave 模型。

**关键改动**:
1. **wave 计算**:task 的 `wave_index` = 最长依赖链深度。无 depends_on → wave 0;
   最深依赖在 wave N → wave N+1。
2. **wave 内并发**:同 wave 的 task 在 `max_parallel_workers` + per-provider 限流内
   并发跑(各在独立 worktree)。冲突 task(P4)demote 到下一 wave。
3. **wave 闸门**:下一 wave 只在当前 wave 所有 task 到达 `passed`/`blocked` 时启动
   (设计文档 §12.1 §27a)。`blocked` 不阻塞下一 wave(隔离,进 8E excluded)。
4. **废弃 `current_task_index`**:并发下它无意义(设计文档 §7.1 末尾)。改成
   per-task status map 驱动。

**建议新文件** `src/scheduler/wave-executor.ts`,把 `task-graph-loop.ts` 的串行调度
逻辑抽出来,`task-graph-loop.ts` 改成根据 `config` 选 serial 或 wave executor
(默认 serial 保现状,`parallel: true` 走 wave)。这样 8D 是**增量**而非推翻 8B。

**验收**:
- 设计文档 §12.1 §26:T1/T2(root)+ T3(depends T1)→ wave `[T1,T2]` 然后 `[T3]`
- §27:wave 内中 task 失败,其余继续
- §27a:wave 闸门语义(blocked 不 gate,rework 中则 gate)

> P5 是风险最高的阶段。建议**先写 wave 计算的纯函数 + 单测**(拓扑分层),再改
> executor。纯函数先绿,降低集成风险。

### 4.4 P6:失败策略 1-C + 2-C + run 级熔断

设计文档 §7.2(1-C 隔离 + 2-C 升级阶梯)+ §7.3(run 级熔断)。

**1-C**:wave 内单 task 失败不 abort 兄弟(§7.2)。wave 报告 mixed counts 后再启下一 wave。

**2-C**:每个失败 task 按序:原 provider rework `max_agent_retries` 次(默认 1 = 现状)
→ 升级 `escalation_target` 1 次 → BLOCKED。**关键**:`max_agent_retries` 就是 §7.2
step-1 的预算,不是两套计数(设计文档 §7.3 "Reconciliation")。

**run 级熔断(§7.3)**:`consecutive_failure_count` 跨迭代累积,达 `max_consecutive_failures`
(默认 3)→ BLOCKED + `CONSECUTIVE_FAILURE_LIMIT`。tracked classes:Auditor BLOCK /
Developer BLOCKED / 验证失败 / infra error。PASS 重置。

**新增 config keys**(设计文档 §7.3):
- `config.loop.max_consecutive_failures`(1..10,默认 3)
- `config.loop.max_agent_retries`(1..10,默认 1)
- state 新增 `consecutive_failure_count`(持久化,resume 恢复)

**验收**:设计文档 §12.2 §35–44(10 条)。重点:
- §41:`max_agent_retries` 真正 bound 2-C step-1,无双重计数
- §40:resume 恢复 count(在 state-store 白名单)
- §43:wave 模式下跨 task 跨 wave 累积(单 run 计数)

### 4.5 P7:Resume 按 status 驱动 + 孤儿回收

设计文档 §11。**resume 不能用 `current_task_index`**(P5 已废)。

**resume 流程**(设计文档 §11):
1. 恢复 `scheduler.lock`(stale-lock recovery,不覆盖活锁)
2. 对每个 task(`task-results.json`):
   - `passed` → 跳过
   - `running` → 查 worktree 子锁存活;活则**等其自然完成**(轮询 task-results,
     绝不 spawn 重复);死则标 failed 走 2-C
   - `failed`/`blocked` → 2-C 阶梯(若还有 attempt)
   - `pending`/`queued` → 重新调度到对应 wave
3. `git worktree prune` + 检测孤儿 `agent/{run_id}/*` 分支(报告用户,不自动删)

**孤儿回收(设计文档 §11,审查 Q4.4)**:主调度器注册 `process.on('exit'/'SIGINT'/'SIGTERM')`
向所有活跃 worker 进程组发 kill。8D 用 `detached: true` spawn worker,崩溃时这些
进程组不会自动清理,变孤儿继续烧钱。这是 §8 主动 cancel 没覆盖的盲区。

**验收**:设计文档 §12.1 §31/§32。

### 4.6 P8:子进程结果回传

审查 Q1.4。每个 worker 结束写 `result.json` 到**主仓库**(不是 worktree 内,因为
worktree 会被清理):`.agent/task-runs/{task_id}/result.json`。

```ts
interface TaskRunResult {
  task_id: string;
  status: 'passed' | 'failed' | 'blocked';
  exit_code: number | null;
  final_commit_sha: string | null;  // worker 在自己分支的 commit
  diff_digest: string;
  branch: string;
  error: string | null;
  finished_at: string;
}
```

主调度器靠 `child_process` 的 `exit` 事件拿退出码 + 读 result.json。缺失/损坏 →
infra failure 走 2-C。**不依赖 Phase 9 事件流**(Q1.4 决策:文件回传解耦)。

**验收**:单测 result.json 写读 + 缺失处理。

---

## 5. 文件清单(开发师 checklist)

**新增**:
- `src/scheduler/worktree-manager.ts`(P3)
- `src/scheduler/conflict-detector.ts`(P4)
- `src/scheduler/wave-executor.ts`(P5)
- `tests/unit/worktree-manager.test.ts`
- `tests/unit/conflict-detector.test.ts`
- `tests/unit/wave-executor.test.ts`
- `tests/integration/parallel-task-graph.test.ts`(端到端并发)
- `tests/integration/concurrent-failure-policy.test.ts`(1-C + 2-C)

**修改**:
- `src/runtime/lock-manager.ts`(P1:加 lockName)
- `src/scope/scope-guard.ts`(P2:加 worktrees 白名单)
- `src/orchestrator/run-orchestrator.ts`(P0 bug + P5 wave 入口)
- `src/orchestrator/task-graph-loop.ts`(P5:serial/wave 分流,废弃 current_task_index)
- `src/types.ts`(P6:config keys + state field + TaskRunResult)
- `src/artifacts/config.ts`(P6:默认值 + schema)
- `src/orchestrator/state-store.ts`(P6/P7:consecutive_failure_count 白名单)

**不动**:`prompts/`、`src/git/commit-manager.ts`(commit 归 finalization,8D 不碰)、
provider 代码、Phase 10 feedback 代码。

---

## 6. 验收(设计文档 §12 为准,这里只补实现侧)

设计文档 §12.1(wave + failure + isolation,§26–§34)+ §12.2(熔断,§35–§44)
是验收 source of truth。开发师照做即可。

**补充(实现侧)**:
1. **`parallel: false` 默认 byte-identical**:不开并发时,现有全部测试输出不变
   (8B 串行行为零回归)。这是红线,同 Phase 10 的 `enabled: false` 红线。
2. **P0 两个 bug 的回归测试**:`--no-commit` 真不 commit;BLOCKED 不卡死(§2)。
3. **工程门**:typecheck/lint(0 warning)/build/test 全过 + `git diff --check`。
4. **并发正确性**:并发跑 N 个独立 task,各 worktree 产物不串、不漏、不重。

---

## 7. 开发师执行指引(可自举)

8D 可以用 review-loop 自己实现自己(像 Phase 10 那样)。但 8D 是**大重构**,建议
**分阶段自举**:每个 P 阶段作为一个独立 review-loop run,而非一个大 run。

建议 start request(分阶段,这里给 P0+P1+P2 合并的第一轮):

```text
Implement Phase 8D pre-flight per docs/phase-8d-implementation-brief.md §2 and §3.
Design source of truth: docs/phase-8d-worktree-parallel-execution.md.

P0: fix two bugs found in smoke — (1) --no-commit still produces a commit on
final audit PASS (investigate run-orchestrator.ts:2293 noCommit path + the
task-graph finalization path that may bypass it); (2) run hangs after final
audit FAIL → BLOCKED (process idle, no children, needs kill). Add regression
tests for both.

P1: add lockName option to LockManager (src/runtime/lock-manager.ts:27), default
'run.lock' preserves current behavior; scheduler will use 'scheduler.lock'.

P2: add '.agent/worktrees/**' to SYSTEM_PROTECTED_PATHS and
ORCHESTRATOR_OWNED_PATTERNS in src/scope/scope-guard.ts.

Keep parallel:false default byte-identical. All gates green.
```

后续 P3–P8 各起一轮 run,每轮引用本任务书对应章节 + 设计文档对应 §。

---

## 8. 风险提示(给开发师)

1. **P5(wave 替换 serial)是最大风险点**。建议先抽 wave 计算纯函数 + 单测绿,
   再动 executor。不要一次性重写 task-graph-loop.ts。
2. **P0 的 `--no-commit` bug 可能在 task-graph finalization 专属路径**,和 8D
   强相关(8D 全程 task-graph)。先修 P0 再做 P5,否则 P5 测试会被 P0 bug 污染。
3. **smoke 还暴露一个非 bug 但要记的**:`.agent/` 不是整个 gitignore,8D 的 worktree
   在 `.agent/worktrees/` 内,P2 白名单 + worktree 自身 .git 嵌套要小心(git 嵌套
   仓库风险)。如果嵌套出问题,改用项目外 worktree(设计文档 §6 提了备选)。
4. **代理慢会显著拖慢 8D 验收**(每个并发 task 都调 LLM)。集成测试尽量用
   fake-agent(现有 `tests/integration/` 已有此模式),不要每个测试都真调 codex/claude。
