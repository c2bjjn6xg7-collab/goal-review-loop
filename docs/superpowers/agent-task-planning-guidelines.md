# Agent Task Planning Guidelines

These guidelines are standing instructions for future review-loop Planner, Developer, Auditor, and human handoff documents.

## Core Rule

Plan work around the **smallest complete module that can independently pass engineering gates**, not around the smallest possible file or concern.

Over-decomposition is unsafe when a feature requires coordinated changes across source, tests, config, prompts, schemas, and integration wiring. Splitting those changes into narrow partial tasks can create impossible `allowed_changes` scopes, force a Developer to BLOCKED, or leave the repository in a half-compiled state between tasks.

## When To Keep One Atomic Task

Use one broader task when any of these are true:

- The change must touch multiple files together to typecheck or pass tests.
- The request says `atomic`, `do not split`, `single task`, or `follow the existing plan exactly`.
- The work changes an orchestrator flow, task-graph/wave execution path, state schema, prompt contract, or integration boundary.
- Tests and implementation must land together to avoid false failures.
- The selected execution model has enough context to handle the full module.

## When To Split

Split into multiple tasks only when each task is genuinely independently verifiable:

- Each task can compile, typecheck, and pass its targeted tests on its own.
- Each task has complete `allowed_changes` for all companion files it plausibly needs.
- Later tasks do not require immediate scope expansion to fix omissions from earlier tasks.
- Dependencies form a clear DAG and do not require half-implemented code to sit in the repository.

## Allowed Changes Policy

`allowed_changes` should be focused but complete. Do not make scopes so narrow that they exclude obvious companion files, such as:

- Source + adjacent tests.
- Schema/type changes + adapters/builders that consume them.
- Prompt changes + prompt-builder/context tests.
- Orchestrator wiring + integration tests that prove the wiring.
- Config/default changes + config schema/tests/docs when required.

If a task cannot be completed within its `allowed_changes`, the correct outcome is a BLOCKED handoff with a scope expansion request. The better planning outcome is to avoid that dead end by sizing the task as an atomic module up front.

## Practical Heuristic

Ask: "Can this task leave the repository green by itself?"

- If yes, it can be a task.
- If no, merge it into the surrounding atomic module instead of splitting it smaller.

## Long-Prompt Provider Patience

When dogfooding Review Loop with real providers, do not treat heartbeat-only output
as immediate failure for large Planner or Developer prompts. Large atomic
orchestrator tasks can spend several minutes reasoning before writing files.

Recommended operator behavior:

- Keep long provider timeouts for large prompts: at least 60 minutes for Planner
  and 90-120 minutes for Developer when the task is an atomic orchestrator
  module.
- Keep heartbeat output enabled at roughly 30 second intervals, but use it only
  as liveness evidence, not as proof of progress.
- Give Claude Planner or Claude Developer a 10-20 minute observation window
  before cancelling, unless there is clear evidence of workspace contamination,
  prompt transport failure, runaway process fan-out, or wrong-run writes.
- During the observation window, monitor task worktree file mtimes, debug
  stdout/stderr, handoff file creation, process CPU, and `.agent/state.json`.
  Any legitimate file activity should reset the patience window.
- Before starting a new dogfood run, clear or back up stale `.agent/` runtime
  state and terminate old provider child processes for the same repository.
  This prevents orphaned provider processes from writing artifacts for an old
  run into a fresh `.agent` directory.
- If Codex CLI reports account or workspace credit exhaustion, record it as an
  external provider blocker. Do not misclassify that as a Review Loop code
  failure, and do not burn more retries on alternate Codex models unless a quick
  smoke prompt proves the model is available.

Cancellation is appropriate before the 10-20 minute window only when there is
direct evidence that the provider is damaging correctness, such as an orphaned
old-run process writing into the current `.agent`, invalid run IDs in generated
artifacts, or a provider error that has already returned.
