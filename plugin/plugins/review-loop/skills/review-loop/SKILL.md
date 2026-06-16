# Review Loop — Automated Code Review & Development Orchestration

## When to use this skill

Use this skill for complex development tasks that benefit from:
- Multi-round automated review and rework
- Scope-guarded file modifications
- Verification command execution
- Final audit before commit

## Available Commands

### Initialize

```bash
review-loop init
```

Initializes `.agent/` directory and creates `review-loop.yaml` if missing.

### Provider Management

List available providers:
```bash
review-loop providers list
```

Test a specific provider:
```bash
review-loop providers test claude-desktop
```

**Warning**: High-permission provider modes (`bypassPermissions`, `--dangerously-skip-permissions`) require explicit user consent. These modes should never be recommended without a clear warning.

### Start a Task

From a natural language request:
```bash
review-loop start --watch --request "<user's natural language request>"
```

With options:
```bash
review-loop start --request "<request>" --max-iterations 5 --tag
```

### Status Commands

Show current status:
```bash
review-loop status
```

JSON output (for programmatic use):
```bash
review-loop status --json
```

Watch mode (continuous polling):
```bash
review-loop status --watch
```

### Resume

Resume a blocked or interrupted run:
```bash
review-loop resume
```

### Cancel

Cancel a running task:
```bash
review-loop cancel
```

### Dashboard

Start local visual progress dashboard:
```bash
review-loop dashboard
```

Dashboard options:
```bash
review-loop dashboard --port 4317
review-loop dashboard --host 127.0.0.1
review-loop dashboard --no-open
```

The dashboard shows:
- Run summary (phase, iteration, status)
- Agent timeline (planning → developing → verifying → auditing → finalizing)
- Verification results
- Audit findings
- Transcript previews

Default: `http://127.0.0.1:4317`

## Reading Results

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

## Artifacts Summary

| Artifact | Purpose |
|----------|---------|
| `state.json` | Current run state (phase, iteration, lock) |
| `progress.json` | Real-time progress with stages |
| `plan.md` | Planner's implementation plan |
| `GOAL.md` | Goal specification with verification commands |
| `developer-handoff.md` | Developer's changes summary |
| `audit-report.md` | Auditor's findings and decision |
| `final-audit.md` | Final audit decision |
| `transcripts/` | Agent output logs per iteration |
| `verification/manifest.json` | Verification command results |

## Reporting to User

After reading the artifacts, report:

- **Command run**: What CLI command was executed
- **Success/Failure**: Whether the command succeeded
- **Project root**: Where the project is located
- **Artifact location**: Path to `.agent/` directory
- **Phase**: Current phase (if available)
- **Next step**: What the user should do next

Example output:
```
Command: review-loop start --watch --request "Add user authentication"
Status: SUCCESS
Project root: /path/to/project
Artifacts: .agent/
Phase: PASSED
Next step: Run completed. Check .agent/final-audit.md for results.
```

## Missing CLI Installation

If `review-loop` CLI is not installed, show clear instructions:

```
ERROR: 'review-loop' CLI is not installed or not in PATH.

Install it with:
  npm install -g goal-review-loop

Or run from source:
  git clone <repo-url>
  cd goal-review-loop
  npm install
  npm run build
  npm link
```

## Important Rules

1. **Do NOT bypass Scope Guard or verification failures.** If the review loop reports BLOCKED, explain why — do not try to work around it.
2. **Do NOT run `git reset --hard`, `git clean`, or `git push`.** The review loop manages git state internally.
3. **Do NOT trust the Developer summary blindly.** Read the audit report and final audit for the ground truth.
4. **Long-running tasks are expected.** The review loop may take 5-30 minutes for complex tasks. Use `--watch` mode to monitor progress.
5. **Permission modes**: Default is `acceptEdits`. `bypassPermissions` requires explicit user consent. `--dangerously-skip-permissions` should never be used without a clear warning.

## Checking Progress Mid-Run

```bash
review-loop status --json
```

Or read `.agent/progress.json` directly for real-time status.

Or launch the dashboard:
```bash
review-loop dashboard --no-open
```
