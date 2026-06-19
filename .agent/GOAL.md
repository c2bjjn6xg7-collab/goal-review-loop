---
schema_version: 1
run_id: "20260619121841-cwn99t"
goal_id: "phase-8d-p5-round2b-parallel-opt-in-guard"
title: "Phase 8D P5 Round 2B Parallel Opt-In Guard"
allowed_changes:
  - "src/scheduler/parallel-execution.ts"
  - "src/cli/start.ts"
  - "src/orchestrator/run-orchestrator.ts"
  - "tests/unit/parallel-execution.test.ts"
  - "tests/integration/no-commit-bypass.test.ts"
disallowed_changes:
  - ".git/**"
  - ".agent/state.json"
  - ".agent/GOAL.md"
  - ".agent/audit-report.md"
  - ".agent/final-audit.md"
  - "src/orchestrator/task-graph-loop.ts"
  - ".agent/task-runs/**"
  - "prompts/**"
verification_commands:
  - id: "unit-tests"
    command: ["npm", "test"]
    cwd: "."
    required: true
    timeout_seconds: 900
  - id: "typecheck"
    command: ["npm", "run", "typecheck"]
    cwd: "."
    required: true
    timeout_seconds: 300
  - id: "lint"
    command: ["npm", "run", "lint"]
    cwd: "."
    required: true
    timeout_seconds: 300
  - id: "build"
    command: ["npm", "run", "build"]
    cwd: "."
    required: true
    timeout_seconds: 300
  - id: "diff-check"
    command: ["git", "diff", "--check"]
    cwd: "."
    required: true
    timeout_seconds: 120
---

# Phase 8D P5 Round 2B Parallel Opt-In Guard

## Objective

Implement Phase 8D P5 Round 2B only: add an explicit parallel opt-in resolver, CLI plumbing for `--parallel` and `--max-parallel-workers`, and a fail-closed orchestrator guard for requested wave mode. Follow `docs/superpowers/plans/2026-06-19-phase-8d-p5-round2b-parallel-opt-in-seam.md` as the implementation guide.

## Success Criteria

1. `src/scheduler/parallel-execution.ts` exists and exports a pure resolver API for deciding between `serial` and `wave` mode from `ReviewLoopConfig.parallel` plus CLI overrides.
2. The resolver validates worker counts as integers from 1 to 16 and throws `ParallelExecutionConfigError` for invalid counts.
3. Default config with no CLI flags resolves to disabled serial mode and preserves existing orchestrator behavior.
4. `max_parallel_workers` alone does not enable parallelism when config `parallel.enabled` is false or absent.
5. `--max-parallel-workers` alone does not enable parallelism when `--parallel` is not passed and config parallel is not enabled.
6. `--parallel` or `config.parallel.enabled: true` is required for explicit parallel opt-in.
7. Explicit opt-in with a resolved worker count of 1 resolves to serial mode, not wave mode.
8. Explicit opt-in with a resolved worker count greater than 1 resolves to wave mode.
9. `src/cli/start.ts` parses `--parallel` and `--max-parallel-workers <n>`, exposes them on `StartOptions`, validates invalid CLI worker counts before orchestrator work, and passes valid overrides to `runOrchestrator`.
10. `tests/integration/no-commit-bypass.test.ts` extends existing Commander parsing coverage to assert the new flags parse as `parallel === true` and `maxParallelWorkers === 3`.
11. `src/orchestrator/run-orchestrator.ts` accepts optional CLI overrides, resolves the parallel decision after `loadConfigWithDefaults(...)`, converts resolver config errors into clear `CONFIG_ERROR` blocked results, and blocks `decision.mode === 'wave'` with a clear message stating that worktree-backed wave execution is not wired until Phase 8D P5 Round 2C.
12. `runOrchestrator` does not call `runWaveExecutorCore` and does not silently fall back to serial when real wave mode is requested.
13. No changes are made to `src/orchestrator/task-graph-loop.ts`, prompts, worktree creation, resume behavior, `.agent/task-runs`, or parallel Developer/Auditor execution.
14. Required gates pass: `npm run typecheck`, `npm run lint`, `npm run build`, `npm test`, and `git diff --check`.

## Non-Goals

- Do not implement real worktree-backed wave execution.
- Do not call `runWaveExecutorCore` from `run-orchestrator.ts`.
- Do not create worktrees.
- Do not run Developer or Auditor agents in parallel.
- Do not add resume behavior.
- Do not create or use `.agent/task-runs`.
- Do not change prompts.
- Do not modify `src/orchestrator/task-graph-loop.ts`.
- Do not modify files outside the allowed implementation and test files listed in front matter.

## Constraints

- Keep changes tightly scoped to the five allowed files.
- Preserve default serial behavior when no explicit parallel opt-in is provided.
- Treat worker-count-only settings as sizing data, not an opt-in signal.
- Fail closed for requested `wave` mode until Phase 8D P5 Round 2C wires actual worktree-backed execution.
- Use existing project style, TypeScript ESM imports, Commander conventions, and Vitest test patterns.
- Do not perform git commits, tags, pushes, destructive git operations, or broad refactors.
