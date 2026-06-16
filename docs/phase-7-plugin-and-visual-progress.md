# Phase 7 Requirement: Plugin Experience And Visual Progress

> Status: Planned
> Scope: Goal Review Loop repository
> Priority: High
> Non-goal: intelligent task routing, multi-worker parallel execution, and model cost optimization. Those belong to a later phase.

## 1. Background

`goal-review-loop` already has a working local CLI foundation:

- `review-loop init`
- `review-loop start --watch`
- `review-loop status --watch`
- `review-loop resume`
- `review-loop cancel`
- provider profiles for Claude, Codex, CodeBuddy, OpenCode, and custom CLIs
- progress files under `.agent/`
- transcripts under `.agent/transcripts/`
- audit and final audit artifacts

The next product problem is usability. A user can run the tool today, but they still need to understand terminal output and inspect `.agent/` files manually. Phase 7 should turn the existing CLI into a clearer product experience for Codex Desktop users and local terminal users.

The goal is not to change the core orchestration model. The goal is to make the existing process visible, controllable, and easy to start.

## 2. Product Goal

Phase 7 should make users able to answer these questions without reading raw artifact files:

- Has the run started correctly?
- Which phase is running now?
- Which agent is currently active?
- How many iterations have happened?
- Did verification pass or fail?
- Did audit pass or fail?
- Is the run blocked, cancelled, passed, or still running?
- Where can I open the relevant evidence, transcript, audit report, and final result?

The target experience should support two entry points:

1. Codex Desktop plugin / skill workflow
2. Local visual dashboard served by the CLI

## 3. Phase 7A: Plugin Experience

### 3.1 Objective

Make the bundled Codex plugin wrapper practically useful as a front door for the CLI.

The plugin should not reimplement orchestration. It should call and inspect the local `review-loop` CLI.

### 3.2 Required User Flows

The plugin/skill should support these flows from Codex Desktop:

- Initialize Goal Review Loop in the current project
- Test available providers
- Start a task from a natural language request
- Show current status
- Watch progress or explain how to watch progress
- Resume a blocked or interrupted run
- Cancel a running task
- Open or summarize key artifacts

### 3.3 Required Commands

The plugin scripts should expose safe wrappers around these CLI commands:

```bash
review-loop init
review-loop providers list
review-loop providers test <provider>
review-loop start --watch --request "..."
review-loop status
review-loop status --json
review-loop status --watch
review-loop resume
review-loop cancel
```

If a command cannot be run because the CLI is missing, the plugin should show installation instructions instead of failing silently.

### 3.4 Plugin Response Requirements

The plugin/skill response should always tell the user:

- what command was run
- whether it succeeded
- where the project root is
- where `.agent/` artifacts are located
- the current run phase, if available
- the next safe action

For dangerous or high-permission provider modes, the plugin must warn before recommending them.

### 3.5 Plugin Non-Goals

The plugin must not:

- store API keys
- ask the user to paste provider tokens into the repository
- bypass provider login flows
- auto-push to GitHub
- modify `review-loop.yaml` without telling the user
- replace the CLI as the source of truth

## 4. Phase 7B: Visual Progress Dashboard

### 4.1 Objective

Add a local visual dashboard that shows run progress from existing `.agent/` artifacts.

Suggested command:

```bash
review-loop dashboard
```

Suggested default URL:

```text
http://127.0.0.1:4317
```

The dashboard should be local-only by default.

### 4.2 Data Sources

The dashboard should read from existing runtime files:

```text
.agent/state.json
.agent/progress.json
.agent/progress.md
.agent/audit-report.md
.agent/final-audit.md
.agent/developer-handoff.md
.agent/rework-instructions.md
.agent/transcripts/
.agent/verification/
.agent/evidence/
```

If a file is missing, the dashboard should degrade gracefully and show `not available` rather than crashing.

### 4.3 Dashboard Views

The first version should include these sections.

#### Run Summary

Show:

- project root
- run ID
- task slug
- current phase
- current iteration
- started time
- last event time
- final status, if terminal

#### Agent Timeline

Show the main lifecycle:

```text
Planning -> Developing -> Verifying -> Auditing -> Reworking -> Finalizing -> Passed/Blocked/Cancelled
```

Each stage should display one of:

- pending
- running
- passed
- failed
- blocked
- cancelled
- skipped
- unknown

#### Verification Panel

Show verification commands and their status:

- command
- exit code
- duration
- stdout/stderr summary or log path
- log I/O error, if any

#### Audit Panel

Show:

- audit decision
- finding count
- finding severity
- finding ID
- short finding summary
- whether a rework instruction was generated

#### Transcript Panel

Show available transcript files:

- iteration number
- role
- timestamp
- path
- short preview

The dashboard should not expose prompt files or secrets. It should rely on already redacted outputs.

#### Action Panel

The first version may implement actions as command hints rather than clickable mutations.

Show copyable commands:

```bash
review-loop status --watch
review-loop resume
review-loop cancel
```

Optional enhancement: add clickable local actions later, but they must be protected against accidental destructive operations.

### 4.4 Dashboard API

The dashboard should expose local JSON endpoints for the browser UI.

Suggested endpoints:

```text
GET /api/status
GET /api/artifacts
GET /api/transcripts
GET /api/verification
GET /api/audit
```

All endpoints should be read-only in the first version.

### 4.5 Refresh Behavior

The UI should auto-refresh while the run is not terminal.

Suggested default:

- poll every 2 seconds
- stop polling when terminal status is reached
- show last refresh time

Terminal phases:

- PASSED
- BLOCKED
- CANCELLED

### 4.6 CLI Options

Suggested command options:

```bash
review-loop dashboard
review-loop dashboard --port 4317
review-loop dashboard --host 127.0.0.1
review-loop dashboard --no-open
```

Default behavior:

- host: `127.0.0.1`
- port: `4317`
- open browser: true, if supported

The command should fail closed if someone tries to bind to `0.0.0.0` without an explicit flag such as `--allow-network`.

## 5. Safety Requirements

Phase 7 must preserve the existing security model.

Required safety behavior:

- dashboard binds to localhost by default
- dashboard is read-only in the first version
- do not serve prompt files by default
- do not serve unredacted process logs if they may contain secrets
- do not serve arbitrary files by path parameter
- only read known artifact paths under `.agent/`
- do not create commits, tags, pushes, or provider calls from the dashboard in v1
- plugin must not hide high-permission provider warnings

## 6. Suggested Implementation Plan

### Step 1: Artifact Reader Layer

Add a small module that reads current `.agent/` state into one normalized object.

Suggested file:

```text
src/dashboard/artifact-reader.ts
```

Responsibilities:

- read JSON artifacts safely
- read Markdown artifacts safely
- tolerate missing files
- summarize transcripts
- expose a typed `DashboardSnapshot`

### Step 2: Dashboard Server

Suggested file:

```text
src/dashboard/dashboard-server.ts
```

Responsibilities:

- create local HTTP server
- serve static HTML/CSS/JS
- expose read-only JSON API
- implement polling-friendly endpoints
- avoid dependencies unless clearly needed

Using Node built-in `http` is acceptable for v1. Avoid adding a frontend framework unless there is a strong reason.

### Step 3: CLI Command

Suggested file:

```text
src/cli/dashboard.ts
```

Register in:

```text
src/cli/index.ts
```

### Step 4: Plugin Wrapper Update

Update plugin skill and scripts so Codex Desktop can:

- explain dashboard usage
- run `review-loop dashboard --no-open` when appropriate
- point the user to the local URL
- summarize status via `review-loop status --json`

### Step 5: Tests

Add focused tests for:

- artifact reader with missing files
- artifact reader with valid state/progress/audit files
- server API endpoints
- localhost binding default
- rejection or warning for network binding
- CLI option parsing
- plugin script command mapping

## 7. Acceptance Criteria

Phase 7 is complete when all items below are true.

### Plugin Experience

- `plugin/` documentation explains init/start/status/resume/cancel/provider-test flows.
- Plugin scripts can call the local CLI without hardcoded user paths.
- Missing CLI produces a clear installation message.
- Provider test failures produce actionable messages.
- High-permission provider modes are documented with warnings.

### Dashboard

- `review-loop dashboard` starts a local dashboard on `127.0.0.1:4317` by default.
- Dashboard shows run ID, phase, iteration, status, and last event time.
- Dashboard shows verification summary when available.
- Dashboard shows audit findings when available.
- Dashboard shows transcript list when available.
- Dashboard tolerates missing `.agent/` files without crashing.
- Dashboard does not expose prompt files or arbitrary filesystem paths.
- Dashboard has read-only API endpoints.
- Dashboard auto-refreshes while a run is active.

### Engineering Gates

These commands must pass:

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm audit --omit=dev
npm pack --dry-run
```

## 8. Out Of Scope For Phase 7

Do not implement these in Phase 7:

- multi-worker parallel execution
- task complexity classification
- model routing by difficulty or cost
- automatic escalation from cheap worker to premium worker
- remote web dashboard
- team account management
- GitHub push automation from dashboard
- cloud-hosted state synchronization

These are candidates for Phase 8 or later.

## 9. Developer Prompt

Use this prompt when handing Phase 7 to a development agent:

```text
You are implementing Phase 7 for the goal-review-loop repository.

Read docs/phase-7-plugin-and-visual-progress.md first and treat it as the source of truth.

Goal:
Implement Plugin Experience improvements and a local read-only Visual Progress Dashboard.

Scope:
- Add dashboard artifact reader, dashboard server, and CLI command.
- Update plugin skill/scripts/docs so Codex Desktop users can start, inspect, resume, cancel, test providers, and open/understand dashboard usage.
- Add focused unit/integration tests.

Hard constraints:
- Do not implement Phase 8 features: no parallel workers, no model routing, no task difficulty classifier.
- Dashboard must bind to 127.0.0.1 by default.
- Dashboard v1 must be read-only.
- Do not expose prompt files or arbitrary filesystem reads.
- Do not store or request API keys.
- Preserve existing CLI behavior and existing tests.
- Keep dependencies minimal; prefer Node built-in http for v1 unless a dependency is clearly justified.

Acceptance gates:
- npm run typecheck
- npm run lint
- npm test
- npm run build
- npm audit --omit=dev
- npm pack --dry-run

Deliverables:
- Code changes
- Tests
- Updated README/plugin docs if needed
- A concise developer handoff summarizing what changed, how to use it, and any known risks
```
