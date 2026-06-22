# Phase 9 R6 Implementation Spec: Dashboard UX Refresh

> Date: 2026-06-22
> Status: Spec — ready for AI developer implementation
> Requirements: `2026-06-22-phase-9-r6-dashboard-ux-refresh-requirements.md`
> Base expectation: current `main` already has dashboard server, run browser, SSE, cancel, event refs, and live output
> Visual reference: `../assets/phase-9-r6-dashboard-ux-reference.png`

## Summary

Implement the approved Chinese-first dashboard redesign using the existing dashboard server and event stream. Use `docs/superpowers/assets/phase-9-r6-dashboard-ux-reference.png` as the visual target. The implementation may add backward-compatible computed fields to existing API responses, but it must not add new endpoints or change review-loop orchestration behavior.

Primary production files:

- `src/web/dashboard-html.ts`
- `src/web/event-source.ts`
- `src/web/run-lister.ts`

Primary tests:

- `tests/unit/dashboard-html.test.ts`
- `tests/unit/event-source.test.ts`
- `tests/unit/run-lister.test.ts`
- Dashboard server tests only if response shapes change

## Implementation Boundaries

### Allowed

- Rewrite the inline dashboard HTML/CSS/JS inside `renderDashboardHtml()`.
- Add exported pure helper functions/constants in `dashboard-html.ts` for unit tests.
- Add `display_title` to `RunSummary`.
- Add `ui_summary` to `DashboardSnapshot`.
- Add unit tests for mapping/derivation helpers.
- Add browser/screenshot verification script or documented manual check.

### Not Allowed

- New HTTP endpoints.
- New frontend framework dependency.
- Changing event store append/read semantics.
- Changing scheduler/state machine behavior.
- Changing cancel request protocol.
- Exposing unfiltered agent stdout beyond `role.output`.
- Using `innerHTML` for dynamic content.

## Data Model Changes

### `RunSummary.display_title`

Extend `RunSummary` in `src/web/run-lister.ts`:

```ts
export interface RunSummary {
  run_id: string;
  phase: string;
  started_at: string;
  event_count: number;
  is_active: boolean;
  source: 'history' | 'active';
  friendly_time: string;
  display_title?: string;
}
```

Derive `display_title` from the first available source:

1. First `run.started` event message, stripping a leading `Run started:` prefix.
2. `payload.goal`, `payload.task`, or `payload.task_slug` if present and string-like.
3. The first non-empty event message.
4. Fallback to the full `run_id`.

Normalize:

- Trim whitespace.
- Collapse repeated spaces/newlines.
- Remove Markdown heading markers at the beginning.
- Cap to around 48 Chinese/Latin display characters for the selector label.

Do not mutate event messages.

### `DashboardSnapshot.ui_summary`

Extend `DashboardSnapshot` in `src/web/event-source.ts` with an optional computed field:

```ts
export interface DashboardUiSummary {
  display_title: string;
  started_at?: string;
  updated_at?: string;
  elapsed_ms?: number;
  active_role?: string;
  active_stage: 'initializing' | 'planning' | 'developing' | 'verifying' | 'auditing' | 'final_auditing' | 'complete' | 'blocked' | 'failed' | 'cancelled' | 'unknown';
  iteration?: number;
  max_iterations?: number;
  last_event_kind?: string;
  last_event_label?: string;
  roles: DashboardAgentStatus[];
}

export interface DashboardAgentStatus {
  role: 'planner' | 'developer' | 'auditor' | 'final-auditor';
  label: string;
  provider?: string;
  model?: string;
  status: 'waiting' | 'running' | 'completed' | 'failed' | 'blocked' | 'cancelled';
  started_at?: string;
  ended_at?: string;
  duration_ms?: number;
}
```

Rules:

- Build `ui_summary` from the full sorted event array, not only `latest_events`.
- Preserve all existing snapshot fields exactly.
- For archived runs, compute from archive events.
- For active runs, merge `iteration` and `max_iterations` from `state.json` when available.

## Derivation Rules

### Active Stage

Use terminal event first:

- Last `run.completed` → `complete`
- Last `run.failed` → `failed`
- Last `run.blocked` → `blocked`
- `current_phase === CANCELLED` or cancel terminal event → `cancelled`

For non-terminal:

- `INITIALIZING` → `initializing`
- `PLANNING` → `planning`
- `DEVELOPING` or `REWORKING` → `developing`
- `VERIFYING` → `verifying`
- `AUDITING` → `auditing`
- `FINALIZING`:
  - if the latest active role is `final-auditor`, use `final_auditing`
  - otherwise use `final_auditing` for the UI stage label and "收尾中" in body copy
- unknown values → `unknown`

### Stage Progress

Dashboard stages:

1. `initializing`
2. `planning`
3. `developing`
4. `verifying`
5. `auditing`
6. `final_auditing`
7. `complete`

Completed stages are all stages before the active one. For terminal states:

- `complete`: all stages completed.
- `blocked` or `failed`: mark stages before the last known active stage completed and the current/last stage as error.
- `cancelled`: mark stages before cancellation completed and current stage cancelled.

### Agent Status

Initialize all four roles as `waiting`.

Scan full events in ascending sequence order:

- `role.started` for a role → status `running`, set `started_at`, provider/model.
- `role.heartbeat` for a role with no exit → keep `running`.
- `role.exited` with `status === success` or level not error → `completed`, set `ended_at`, duration.
- `role.exited` with failure status or error level → `failed`.
- `role.error` → `failed`.
- `audit.decision` for auditor/final-auditor may confirm completed if no role exit exists.
- `provider.failure` for a role → `failed`.
- Terminal `CANCELLED` while a role is running → that role becomes `cancelled`.
- Terminal `BLOCKED` while a role is running → that role becomes `blocked`.

Provider/model:

- Prefer event-level `provider` and `model`.
- Fallback to previous known provider/model for the same role.
- Display provider title-cased (`claude`/`anthropic` family as `Claude`, `codex`/`openai` family as `Codex`) without changing stored values.

## Label Helpers

Add exported helpers in `src/web/dashboard-html.ts` or a small new module imported by it:

```ts
export function labelPhase(raw: string): string
export function labelRole(raw: string | undefined): string
export function labelEventKind(raw: string): string
export function labelProvider(raw: string | undefined, model?: string): string
export function formatDuration(ms: number | undefined): string
export function formatLocalTime(iso: string | undefined): string
export function deriveDisplayTitle(events: ReviewLoopEvent[], fallbackRunId: string): string
```

The browser script should receive these maps by embedding JSON constants generated in TypeScript, for example:

```ts
const LABELS_JSON = JSON.stringify(DASHBOARD_LABELS);
```

Avoid maintaining two divergent mapping tables.

## UI Structure

Keep a single inline HTML document. Use semantic regions and stable ids for tests.

Required top-level anchors:

- `id="dashboard-app"`
- `id="run-select"`
- `id="connection-status"`
- `id="updated-at"`
- `id="cancel-btn"`
- `id="current-title"`
- `id="current-phase-label"`
- `id="current-role-label"`
- `id="current-model-label"`
- `id="current-iteration-label"`
- `id="current-elapsed-label"`
- `id="current-event-label"`
- `id="stage-progress"`
- `id="agent-status-list"`
- `id="next-step"`
- `id="timeline-list"`
- `id="live-output"`
- `id="artifacts-list"`

Recommended layout:

```html
<body>
  <div id="dashboard-app">
    <header class="topbar">...</header>
    <main class="dashboard-grid">
      <section class="main-column">
        <section class="status-card">...</section>
        <section class="stage-card">...</section>
        <section class="timeline-card">...</section>
        <section class="live-output-card">...</section>
      </section>
      <aside class="side-column">
        <section class="agent-card">...</section>
        <section class="next-card">...</section>
        <section class="artifact-card">...</section>
      </aside>
    </main>
  </div>
</body>
```

CSS constraints:

- Light theme first.
- No large gradients or decorative blobs.
- Cards use border radius at or below 8px.
- Use an 8px spacing scale.
- Keep page background neutral (`#f5f6f8` class of color).
- Use status colors consistently:
  - green for completed
  - blue for active
  - amber for heartbeat/waiting
  - red for failed/cancelled
  - gray for future/unknown
- At width below 1100px, stack side column below main column.

## Rendering Logic

### Active Snapshot Flow

Existing behavior remains:

1. Fetch `/api/runs` on load and every 15 seconds.
2. Active selection uses SSE `/api/events/stream`.
3. SSE event triggers `fetch('/api/events')`.
4. If SSE fails, fall back to polling `/api/events` every 2 seconds.

Update the render path to use:

- `snapshot.ui_summary` when present.
- Existing fields as fallback when `ui_summary` is absent.

This keeps the dashboard compatible with older snapshots in tests.

### Archived Snapshot Flow

Existing behavior remains:

1. Selecting archived run closes SSE.
2. Fetch `/api/events?run_id=<id>` once.
3. Hide cancel button.
4. Show a non-live status label such as `历史运行`.

### Run Selector Labels

Each option should prefer:

`display_title · friendly_time · Chinese phase`

Example:

`优化 planner prompt · 6/22 08:41 · 开发中`

The selected control may show run id in secondary text elsewhere:

`Run ID: 20260622154127`

## Timeline Rendering

Render `snapshot.latest_events` as a timeline:

- Use local `HH:mm:ss` for time.
- Badge text is `labelEventKind(ev.kind)`.
- Main message should be:
  - `labelEventKind(ev.kind) + " " + ev.kind` when the raw kind is useful.
  - Existing `ev.message`, lightly normalized, after that.
- For `role.heartbeat`, prefer friendly copy:
  - `规划师 Planner 仍在思考 · 已 90 秒`
- For `task.started`, prefer:
  - `任务开始 task.started: task-1 开始执行（修改 prompts/planner.md）`
- For `role.output`, do not duplicate full output in timeline; show a short preview.

Highlight the newest non-heartbeat active event.

## Live Output Rendering

Keep the existing `role.output` filtering behavior.

Add tab filtering on the client:

- `all`
- `planner`
- `developer`
- `auditor`
- `verification`

Filtering must only hide displayed lines; it must not alter the stored event list.

Keep auto-scroll:

- If the user is already near the bottom, new output keeps the panel pinned to bottom.
- If the user has scrolled up, do not force scroll.

## Artifact Rendering

Use `snapshot.artifacts`.

Display known important artifacts first when present:

1. `.agent/plan.md`
2. `.agent/GOAL.md`
3. `.agent/verification.log`
4. `.agent/audit-report.md`
5. `.agent/final-audit.md`
6. `.agent/state.json`

Then append any other artifact refs.

If size is not available from the API, omit size rather than fabricating one. Do not add filesystem reads from the browser. Server-side size enrichment is optional; if implemented, it must be fail-soft and stay inside `.agent`.

## Security

The current tests assert no `innerHTML`; keep that invariant.

Required:

- Dynamic strings use `textContent` or `createTextNode`.
- Run id validation remains server-side for `/api/events?run_id=`.
- Artifact paths are displayed as text only.
- No clickable file opening endpoint in this phase.

## Tests

### Unit Tests

Extend `tests/unit/dashboard-html.test.ts`:

- HTML contains Chinese dashboard anchors:
  - `Review-Loop 控制台`
  - `执行时间线`
  - `实时输出`
  - `运行产物`
  - `Agent 状态`
  - `下一步`
- HTML contains required ids listed above.
- HTML still contains `/api/runs`, `/api/events`, `/api/events/stream`, `/api/cancel`.
- HTML still contains `textContent` / `createTextNode` and does not contain `innerHTML`.
- Label helpers map all known phases, roles, and event kinds.
- Duration formatting:
  - `121000` → `2分01秒` or equivalent stable format.
  - undefined → `—`.
- Display title derivation:
  - `Run started: 优化 planner prompt (...)` → `优化 planner prompt`.
  - empty events → fallback run id.
- Agent status derivation:
  - planner started/exited → completed.
  - developer started/no exit → running.
  - provider.failure → failed.
  - terminal cancel while running → cancelled.
- Stage derivation:
  - `DEVELOPING` → developing active.
  - `PASSED` → all complete.
  - resumed history with earlier blocked and later completed uses the later terminal event.

Extend `tests/unit/run-lister.test.ts`:

- `display_title` is derived from first `run.started`.
- Missing title falls back to run id.
- Existing run list fields remain intact.

Extend `tests/unit/event-source.test.ts`:

- `ui_summary` exists for active snapshot with events.
- `ui_summary.roles` includes all four fixed roles.
- `ui_summary` derives active role and stage from full event history, not only `latest_events`.
- Archived snapshot also includes `ui_summary`.

### API Tests

If `display_title` or `ui_summary` changes server response shape, update dashboard server tests to assert:

- Old fields still exist.
- New fields are additive.
- `/api/events?run_id=<archive>` includes the same `ui_summary` shape as active snapshots.

### Browser Verification

Start dashboard locally and verify:

```bash
npm run build
node dist/cli/index.js dashboard --port 8800
```

Then capture with Playwright or manually inspect:

- 1440×900
- 1920×1080
- 1024×768

Pass criteria:

- No overlapping text.
- Header run selector is readable.
- Current status card answers "到哪一步了".
- Right column does not cover or squeeze main content.
- Timeline and live output both fit without taking over the whole first viewport.

## Validation Commands

Run at minimum:

```bash
npm test -- --run tests/unit/dashboard-html.test.ts tests/unit/event-source.test.ts tests/unit/run-lister.test.ts tests/unit/dashboard-server.test.ts tests/unit/dashboard-server-runs.test.ts
npm run typecheck
npm run lint -- --max-warnings 0
npm run build
git diff --check
```

If the implementation touches shared web/server types, run the full suite:

```bash
npm test
```

## Review Checklist

- The dashboard is Chinese-first but raw terms remain available for debugging.
- No event protocol change.
- No scheduler behavior change.
- No new endpoint.
- SSE/polling/archive behavior remains intact.
- Cancel remains active-only and uses existing `/api/cancel`.
- Auditor and Final Auditor remain visible and labeled as Codex when events provide that provider/model.
- UI does not expose chain-of-thought.
- Unit tests cover helper logic instead of only string snapshots.
- Browser screenshot matches the approved design direction closely enough without overfitting to exact pixels.
