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
