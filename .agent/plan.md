---
schema_version: 1
run_id: "20260619121841-cwn99t"
author_role: "planner"
---

# Phase 8D P5 Round 2B Parallel Opt-In Guard

## Requirement Understanding

Implement only Phase 8D P5 Round 2B from `docs/superpowers/plans/2026-06-19-phase-8d-p5-round2b-parallel-opt-in-seam.md`. This round is a seam, not real parallel execution.

The requested behavior is:

- Add a pure parallel-execution decision resolver in `src/scheduler/parallel-execution.ts`.
- Add resolver unit tests in `tests/unit/parallel-execution.test.ts`.
- Add CLI flags `--parallel` and `--max-parallel-workers <n>` in `src/cli/start.ts`, including validation and plumbing into `runOrchestrator`.
- Extend `tests/integration/no-commit-bypass.test.ts` only for Commander parsing coverage of the new flags.
- Extend `runOrchestrator` in `src/orchestrator/run-orchestrator.ts` to accept CLI overrides, resolve the decision after config load, and fail closed with `CONFIG_ERROR` when the resolved mode is `wave`.
- Preserve default serial behavior: no flags and default config continue on the existing path.
- Do not wire real wave execution yet: no `runWaveExecutorCore` call from `run-orchestrator`, no worktrees, no parallel agents, no resume behavior, no `.agent/task-runs`, no prompt changes, and no `src/orchestrator/task-graph-loop.ts` changes.

The acceptance edge cases are explicit:

- `max_parallel_workers` alone does not enable parallelism.
- `--max-parallel-workers` alone does not enable parallelism.
- `--parallel` or `config.parallel.enabled` is required for opt-in.
- Opt-in plus worker count greater than 1 resolves to `wave`.
- `runOrchestrator` blocks clear wave-mode requests until Round 2C wires worktree-backed execution.

## Current Project Status

At planning time, `git status --short` was clean.

Relevant existing surfaces:

- `src/types.ts` already contains `ReviewLoopConfig.parallel` and `ParallelConfig` from Phase 8D P5 Round 1.
- `src/artifacts/config.ts` already defines `DEFAULT_CONFIG.parallel` as disabled with one worker and fills parallel defaults when absent.
- `src/scheduler/parallel-execution.ts` does not exist yet.
- `tests/unit/parallel-execution.test.ts` does not exist yet.
- `src/scheduler/` already contains `wave-compute.ts`, `wave-executor.ts`, and `worktree-manager.ts`, but this round must not use the wave executor from the orchestrator.
- `src/cli/start.ts` currently supports request/config/max-iterations/commit/tag/watch options. It does not yet expose `--parallel` or `--max-parallel-workers`.
- `executeStart` already validates input before calling `runOrchestrator`; this is the right place for invalid CLI worker counts to fail before orchestrator work.
- `src/orchestrator/run-orchestrator.ts` currently accepts no parallel CLI override fields and loads config early in initialization before continuing into serial orchestration/task-graph logic.
- `tests/integration/no-commit-bypass.test.ts` already contains a Commander parsing regression test and can be extended without adding a new integration test file.

## Technical Approach

Add `src/scheduler/parallel-execution.ts` as a pure resolver module with no filesystem, process, git, agent, or orchestrator imports. It should export:

- `ParallelExecutionMode = 'serial' | 'wave'`.
- `ParallelExecutionSource = 'default' | 'config' | 'cli'`.
- `ParallelCliOverrides` with `parallel?: boolean` and `maxParallelWorkers?: number`.
- `ParallelExecutionDecision`.
- `ParallelExecutionConfigError`.
- `resolveParallelExecution(config, overrides?)`.

The resolver should validate both configured and CLI worker counts as integers from 1 to 16. A worker count alone never enables parallelism. If neither CLI nor config opts in, the decision is disabled serial with `maxParallelWorkers: 1`. If parallel is requested but workers resolve to 1, the decision is explicit serial. If parallel is requested and workers resolve above 1, the decision is `wave`.

Add focused unit coverage for:

- Absent/default parallel config.
- Config `max_parallel_workers` without `enabled`.
- CLI `--max-parallel-workers` without `--parallel`.
- Config opt-in with one worker.
- Config opt-in with workers above one.
- CLI opt-in using config worker count.
- CLI worker override while enabled.
- Invalid worker counts.
- A clear `wave` decision that the orchestrator can fail closed on.

In `src/cli/start.ts`, add the two options, extend `StartOptions`, validate `maxParallelWorkers`, and pass:

- `parallel: options.parallel === true`
- `max_parallel_workers: options.maxParallelWorkers`

Use strict integer validation for CLI worker counts so values like `0`, `17`, `NaN`, and fractional values do not reach the orchestrator. If Commander parsing is adjusted, avoid `parseInt` truncation of inputs such as `1.5`.

In `tests/integration/no-commit-bypass.test.ts`, extend the existing Commander parsing test with a third command instance that parses `--parallel --max-parallel-workers 3` and asserts `parallel === true` and `maxParallelWorkers === 3`.

In `src/orchestrator/run-orchestrator.ts`, add optional `parallel?: boolean` and `max_parallel_workers?: number` params. Immediately after `loadConfigWithDefaults(...)` succeeds, resolve the parallel decision using the new resolver. If resolver validation throws `ParallelExecutionConfigError`, return `makeBlockedResult(..., 'CONFIG_ERROR')` with a clear parallel configuration error. If `decision.mode === 'wave'`, return `BLOCKED`/`CONFIG_ERROR` explaining that wave mode was requested but worktree-backed wave execution is not wired until Phase 8D P5 Round 2C. Otherwise continue unchanged on the existing serial behavior path.

Do not import or call `runWaveExecutorCore` from `run-orchestrator.ts`. Do not modify `src/orchestrator/task-graph-loop.ts`.

## Work Breakdown

1. Add the pure resolver and resolver tests.
2. Add CLI flag parsing, strict validation, StartOptions fields, and Commander parsing coverage.
3. Add orchestrator override params, resolver integration after config load, and the fail-closed `CONFIG_ERROR` guard for wave mode.
4. Run targeted tests, then full engineering gates and scope checks.

## Risks

- **CLI parser truncation**: Commander parsers based on `parseInt` can turn `1.5` into `1`. The implementation should validate the final parsed value strictly and, if necessary, use a stricter parser for the new worker option.
- **Accidental behavior change on default runs**: The resolver must treat absent/default config and no flags as disabled serial, and the orchestrator should continue unchanged when the decision is serial.
- **Silent fake parallelism**: Requested wave mode must block with `CONFIG_ERROR`; it must not silently fall back to serial when workers exceed one.
- **Scope creep**: This round must not touch `task-graph-loop.ts`, prompts, worktree creation, resume behavior, `.agent/task-runs`, or actual parallel Developer/Auditor execution.
- **Validation timing**: Invalid CLI worker counts should fail in `executeStart` before orchestrator work; invalid config worker counts should become a clear orchestrator `CONFIG_ERROR`.
