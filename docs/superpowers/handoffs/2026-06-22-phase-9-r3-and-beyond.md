# Handoff: Phase 9 R3 and Beyond

> Date: 2026-06-22
> From: session that completed Phase 9 R1/R2A/R2B/R2C
> Base commit: `main@36c040e`
> Milestone doc: `docs/superpowers/specs/2026-06-22-phase-9-dogfood-lessons.md`

## TL;DR for the next AI

Phase 9 R1 (event stream + status --watch) and R2 (dashboard: read-only → SSE → cancel button) are **done, reviewed, merged, tagged**. 1269 tests pass, worktree is clean. The next step is **R3: historical run browser**, but **write the R3 spec/plan first** — do not start coding.

**Critical**: the user requires using **review-loop itself** to drive development. R2A/R2B/R2C were all written by real claude/codex agents via `review-loop start`. You are not the developer — you are the operator who writes requests, verifies output, and runs reviews.

## Current state

```
main @ 36c040e (docs: phase-9 dogfood lessons)
├── a8a79ea Merge R2C (cancel button)        [tag: phase-9-r2c-reviewed]
├── 195193d Merge R2B (SSE real-time)        [tag: phase-9-r2b-reviewed]
├── 1517753 Merge R2A (read-only dashboard)  [tag: phase-9-r2a-reviewed]
├── c7d3dac Merge R1 (event stream + watch)  [tag: phase-9-r1-reviewed]
```

- 1269 tests, all passing. typecheck/lint/build clean.
- `claude` (2.1.150) and `codex` (0.142.0-alpha.6) CLIs are installed and working.
- `review-loop.yaml` in repo root configures: planner=claude, developer=claude, auditor=codex, final_auditor=codex.
- No remote configured. Merges are local `--no-ff` + annotated tags.

## How to drive development with review-loop

This is the **required workflow**. Do NOT hand-write feature code unless fixing a review finding or a bug you found.

### Step 1: Clean environment

Before each review-loop run, remove stale state (but leave `events.jsonl` — the orchestrator archives it automatically on fresh run start):

```bash
rm -f .agent/state.json .agent/run.lock
```

### Step 2: Write a detailed request

The request is the only thing the planner sees. Be specific about scope, constraints, what NOT to do, and what existing code to reuse. Include file paths and API names. See the R2C request in this session's history for a good example.

### Step 3: Start review-loop in background

```bash
node dist/cli/main.js start \
  --request "<detailed request>" \
  --task-slug "<slug>" \
  > /tmp/rl-run.log 2>&1 &
```

Then monitor via the event stream you built:

```bash
# Watch events appear (dogfooding Phase 9 itself)
node -e "const l=require('fs').readFileSync('.agent/events.jsonl','utf8').split('\n').filter(Boolean);for(const x in l){const e=JSON.parse(l[x]);console.log(e.seq,e.kind,e.role||'',e.status||'')}"
```

### Step 4: Wait for completion (~20 min)

A typical run: planner 3-5 min → developer 5-10 min → auditor 3-5 min → final-auditor 3-5 min. The background task will notify on completion (exit code 0 = PASSED).

### Step 5: Independently verify (do NOT trust the PASS)

```bash
git checkout agent/<run-id>-<task-slug>
npm run typecheck && npm run lint -- --max-warnings 0 && npm run build
npm test -- --run
```

Then do targeted e2e checks of the new feature (curl the routes, start the dashboard, etc.).

### Step 6: Review, fix, merge

1. Hand the branch to the user for review (or do a self-review pass).
2. Fix findings on the same branch.
3. `git checkout main && git merge --no-ff <branch> -m "..." && git tag -a phase-9-rN-reviewed -m "..."`
4. `git branch -d <branch>`
5. Rebase any sibling branches onto the new main.

## What R3 should build

**R3 = historical run browser / multi-run management.**

The event layer supports live view + cancel + per-run isolation with archive. The gap: the dashboard only shows the current run. Past runs (archived in `.agent/history/events-*.jsonl`) have no entry point.

Likely scope (define precisely in spec):
- `GET /api/runs` — enumerate runs from `.agent/history/` + active `events.jsonl`, returning run_id/phase/started_at/event_count.
- Dashboard run switcher — select which run's events to display.
- `GET /api/events?run_id=<id>` — read a specific run's events (active or archived).
- Do NOT build JSON-RPC or complex multi-run orchestration. That's later.

## Design guardrails (mandatory — from dogfood lessons)

Read `docs/superpowers/specs/2026-06-22-phase-9-dogfood-lessons.md` in full. Summary:

1. **Per-run isolation is mandatory.** Never read/write `events.jsonl` without respecting `run_id`.
2. **Use the last terminal event, not the first.** Resumed histories contain superseded terminals.
3. **Keep serial and task-graph event wiring equivalent.** Grep all call sites of a role across both paths.
4. **UI consumes events via EventStore, not raw file reads.** Do not re-implement JSONL parsing.
5. **Action buttons reuse existing mechanisms.** Delegate to existing orchestrator entry points.

## Boundaries — do NOT touch

- `.agent/state.json` is the resume authority. Events are observability-only.
- Event emission is **fail-soft** — never throws, never affects scheduling.
- Auditor and Final Auditor must remain codex (configured in `review-loop.yaml`).
- Do not expose raw chain-of-thought in events or dashboard.
- Do not change the scheduler semantics. The UI reads events; it does not own scheduling.
- Do not modify `src/cli/status.ts` unless directly relevant.

## Suggested first commands

```bash
git log --oneline -8                          # confirm you're on main@36c040e
npm test -- --run                              # confirm 1269 tests pass
cat docs/superpowers/specs/2026-06-22-phase-9-dogfood-lessons.md  # read the lessons
# Then write R3 spec/plan BEFORE any code.
```
