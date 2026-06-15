# Review Loop — Automated Code Review & Development Orchestration

## When to use this skill

Use this skill for complex development tasks that benefit from:
- Multi-round automated review and rework
- Scope-guarded file modifications
- Verification command execution
- Final audit before commit

## How to invoke

Run the review loop with the user's request:

```bash
review-loop start --watch --request "<user's natural language request>"
```

Or for more control:

```bash
review-loop start --request "<request>" --max-iterations 5 --tag
```

## Reading results

After the run completes, read these files to understand the outcome:

1. `.agent/state.json` — Machine state (phase, iteration, commit SHA)
2. `.agent/progress.json` — Real-time progress (phase, stages, last event)
3. `.agent/progress.md` — Human-readable progress summary
4. `.agent/plan.md` — The plan that was created
5. `.agent/GOAL.md` — The goal specification
6. `.agent/developer-handoff.md` — Developer's summary of changes
7. `.agent/audit-report.md` — Auditor's decision and findings
8. `.agent/final-audit.md` — Final audit decision (PASS/FAILED)
9. `.agent/transcripts/` — Per-iteration agent output summaries

## Reporting to the user

After reading the artifacts, report:

- **Phase**: PASSED / FAILED / BLOCKED / CANCELLED
- **Files changed**: List from the diff or developer handoff
- **Verification results**: From the audit report
- **Commit**: Whether a local commit was created (and its SHA)
- **Next steps**: If BLOCKED, what needs to be fixed. If FAILED, suggest `review-loop resume` or splitting the task.

## Important rules

1. **Do NOT bypass Scope Guard or verification failures.** If the review loop reports BLOCKED, explain why — do not try to work around it.
2. **Do NOT run `git reset --hard`, `git clean`, or `git push`.** The review loop manages git state internally.
3. **Do NOT trust the Developer summary blindly.** Read the audit report and final audit for the ground truth.
4. **Long-running tasks are expected.** The review loop may take 5-30 minutes for complex tasks. Use `--watch` mode to monitor progress.
5. **Permission modes**: Default is `acceptEdits`. `bypassPermissions` requires explicit user consent. `--dangerously-skip-permissions` should never be used without a clear warning.

## Checking progress mid-run

```bash
review-loop status --json
```

Or read `.agent/progress.json` directly for real-time status.
