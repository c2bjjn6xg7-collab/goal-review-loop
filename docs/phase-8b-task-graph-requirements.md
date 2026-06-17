# Phase 8B: Task Graph Generation and Sequential Execution

## Stock Audit

Audit date: 2026-06-17

Current main repository HEAD: `de4a34f`

### What works now

- Review Loop runs end-to-end through PLANNING with Codex + safe config.
- Developer (Claude) starts correctly with argv launch, proxy stripping, non-login shell.
- Developer retry on `AGENT_ERROR` is implemented (`1be853a`).
- Phase 8F per-provider network/proxy isolation is live.
- `review-loop.yaml` shipped with dogfood-safe defaults.

### What blocks progress

- **Developer cannot complete large tasks**: domestic Claude API (`xopglm51` via 讯飞星火) returns `empty or malformed response (HTTP 200)` when Developer accumulates long context over many turns of reading and editing. This is a stable failure, not transient. Verified across 3 test runs (`48rdmu`, `ysoj7w`).
- **No task decomposition**: Planner generates one monolithic plan. Developer must implement everything in one run, accumulating too much context.
- **No task graph types in main**: `TaskGraph`, `TaskNode`, `WorkerCategory`, `ParallelConfig`, `WorkerConfig`, `RoutingPolicy` etc. exist only in the dirty public repo branch, not in source repo main.
- **BLOCKED is terminal**: Developer failure kills the entire run. Partial work is lost. Cannot resume.

### External state

- Public repo `/Users/dengyidong/Desktop/goal-review-loop-public` has partial Phase 8B work on branch `agent/20260616092159-ecuq26-phase-8b-task-graph` (dirty, 9 modified + 3 new files). Can be used as reference but must not be treated as clean baseline.
- `review-loop-test-report.md` remains user-owned untracked.

## Objective

Enable Planner to decompose a requirement into a task graph, and have the orchestrator execute tasks sequentially. Each task is a smaller Developer run with its own scope, verification, and handoff. This keeps individual Developer context short enough for the domestic API to handle reliably.

This phase delivers the minimum viable task graph: generation, validation, and sequential execution. Multi-worker parallelism, worktree isolation, and merge orchestration are explicitly out of scope.

## Motivation

Test evidence (`docs/phase-8f-r1-plugin-test-report.md`) shows Developer fails on tasks that require reading many source files and making many edits. The domestic API cannot sustain the context length. Splitting one large Developer run into 3-5 smaller task runs, each with a narrow scope, keeps context manageable.

## Requirements

### 1. Task graph types

Add types to `src/types.ts`:

- `TaskDifficulty`: `'low' | 'medium' | 'high'`
- `TaskRisk`: `'low' | 'medium' | 'high' | 'critical'`
- `TaskStatus`: `'pending' | 'running' | 'passed' | 'failed' | 'skipped'`
- `TaskVerificationCommand`: `{ id: string; command: string[]; cwd: string; required: boolean; timeout_seconds: number }`
- `TaskNode`: `{ id: string; title: string; description: string; difficulty: TaskDifficulty; risk: TaskRisk; parallelizable: boolean; depends_on: string[]; allowed_changes: string[]; disallowed_changes: string[]; verification_commands: TaskVerificationCommand[]; status: TaskStatus }`
- `TaskGraph`: `{ schema_version: 1; run_id: string; goal_digest: string; tasks: TaskNode[]; created_at: string }`

Do not add `WorkerCategory`, `WorkerConfig`, `ParallelConfig`, `RoutingPolicy`, or `EscalationRule` in this phase. Those belong to Phase 8C/8D/8E/9.

### 2. Task graph generation

Extend the Planner to produce a task graph in addition to plan.md and GOAL.md:

- Planner output adds `.agent/task-graph.json`.
- Planner prompt must instruct: decompose the requirement into 2-6 tasks, each with narrow `allowed_changes`, explicit `verification_commands`, and correct `depends_on` edges.
- Each task must be small enough for a single Developer run to complete without exceeding domestic API context limits.
- Tasks must form a DAG (directed acyclic graph). No cycles.
- The first task must have no dependencies. The last task must be a verification/integration task.

### 3. Task graph validation

Add validation after Planner output:

- `task-graph.json` exists and parses as `TaskGraph`.
- At least 1 task, at most 10 tasks.
- All `depends_on` references point to existing task IDs.
- No cycles (topological sort succeeds).
- Every task has at least one `verification_commands` entry.
- `allowed_changes` is non-empty for each task.

### 4. Sequential task execution

Extend the orchestrator to execute tasks in topological order:

- For each task in dependency order:
  1. Build a Developer prompt scoped to that task's `allowed_changes`, `description`, and `verification_commands`.
  2. Run Developer (Claude) with the task-scoped prompt.
  3. Run that task's `verification_commands`.
  4. If verification passes, proceed to next task.
  5. If verification fails, enter rework for that task (up to `max_iterations`).
  6. If a task fails after max rework, BLOCKED the entire run.
- Task results are accumulated in `.agent/task-results.json`.
- After all tasks complete, run a final integration verification using the GOAL's `verification_commands`.

### 5. Task-scoped Developer prompts

Each task's Developer prompt must include:

- The task title and description.
- The task's `allowed_changes` (scope guard enforces these).
- The task's `verification_commands` (Developer must ensure these pass).
- The GOAL's success criteria (for context).
- Instructions to only modify files within `allowed_changes`.

The prompt must NOT include the full plan or all tasks — only the current task. This keeps context short.

### 6. Scope guard per task

The existing Scope Guard must enforce each task's `allowed_changes` instead of the GOAL's global `allowed_changes`. This prevents Developer from modifying files outside the current task's scope.

### 7. Progress tracking

`progress.json` must report:

- Current task ID and title.
- Task index (e.g. "Task 2 of 5").
- Task status: running / passed / failed / rework.
- Overall graph progress.

### 8. State and resume

- `state.json` must record current task index and task statuses.
- If the run BLOCKS on a specific task, `resume` must restart from that task, not from scratch.
- Successfully completed tasks must not be re-run on resume.

## Acceptance Criteria

1. Planner produces a valid `task-graph.json` with 2-6 tasks for a non-trivial requirement.
2. Task graph validation rejects cycles, missing dependencies, and empty scopes.
3. Orchestrator executes tasks in topological order.
4. Each task's Developer run has a shorter prompt than a monolithic run would.
5. Scope Guard enforces per-task `allowed_changes`.
6. Verification runs per-task and as final integration.
7. `progress.json` shows current task and overall progress.
8. `review-loop resume` restarts from the failed task.
9. Required gates pass: `npm run typecheck`, `npm run lint`, `npm run build`, `npm test`, `git diff --check`.
10. A smoke run with a small multi-part requirement completes all tasks without API empty response.

## Non-Goals

- Do not implement multi-worker parallel execution (Phase 8C).
- Do not implement worktree or branch isolation per task (Phase 8D).
- Do not implement merge orchestration (Phase 8E).
- Do not implement model routing or escalation (Phase 9).
- Do not implement dashboard visualization (Phase 8H).
- Do not implement task difficulty-based worker assignment.
- Do not change Phase 8F network/proxy behavior.
- Do not push to remote.

## Constraints

- Source repo: `/Users/dengyidong/Desktop/cc劳工系统`, branch `main`.
- TypeScript ESM project; build via `tsc`, tests via `vitest run`, lint via `eslint src/ --max-warnings=0`.
- Keep changes consistent with existing code style.
- Do not use the dirty public repo as a baseline. Use it only as reference for type shapes and prompt patterns.
- Do not store API keys, tokens, or proxy credentials in configs, tests, or docs.
- Preserve backwards compatibility: a GOAL without a task graph must still work as a single-task run.

## Suggested Work Breakdown

1. Add task graph types to `src/types.ts`.
2. Add `task-graph.json` schema to `src/artifacts/artifact-schemas.ts`.
3. Extend Planner prompt (`prompts/planner.md`) to instruct task decomposition.
4. Extend `buildPlannerPrompt` and `validatePlannerOutput` in `src/agents/planner-adapter.ts` for task graph generation and validation.
5. Add topological sort and cycle detection utility.
6. Extend orchestrator `runIterationLoop` to loop over tasks in dependency order.
7. Add per-task scope guard enforcement.
8. Add per-task Developer prompt builder.
9. Add per-task verification execution.
10. Add task results tracking and state persistence.
11. Extend `resume` to restart from failed task.
12. Update `progress.json` and `status` output for task progress.
13. Add unit tests for task graph validation, topological sort, per-task scope, and prompt building.
14. Add integration test for sequential task execution with a fake provider.
15. Run all gates and a real-model smoke test.

## Reference Material

- Public repo partial work: `agent/20260616092159-ecuq26-phase-8b-task-graph` branch in `/Users/dengyidong/Desktop/goal-review-loop-public`. Has `task-graph-summary.ts`, `planner-adapter` extensions, and tests. Use as reference for type shapes and prompt patterns, but do not copy directly — it may depend on types not in main.
- Test report: `docs/phase-8f-r1-plugin-test-report.md` — documents the Developer API context-length failure that motivates this phase.
- Fix plan: `docs/phase-8f-r1-fix-plan.md` — remaining P1 fixes (TimeoutNaNWarning, progress events, DEFAULT_CONFIG) can be done before or during this phase.
