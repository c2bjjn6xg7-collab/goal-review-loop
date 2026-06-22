# Phase 9 R6 Requirements: Dashboard UX Refresh

> Date: 2026-06-22
> Status: Requirements — ready for implementation spec
> Parent: `2026-06-21-phase-9-review-loop-observability-requirements.md`
> Depends on: R1 event stream, R2 dashboard server, R2B SSE, R2C cancel, R3 historical run browser, R4 rich event metadata, R5 live output
> Visual reference: `../assets/phase-9-r6-dashboard-ux-reference.png`

## Goal

Upgrade the current Review-Loop dashboard from a raw event table into a Chinese-first, production-quality local control console. The operator should understand the run at a glance:

- What task is running.
- Which phase is active.
- Which agent is working.
- Whether the system is healthy, waiting, blocked, failed, or complete.
- What will happen next.
- Which files and logs were produced.

The approved visual direction is the latest "Review-Loop 控制台" mockup saved at `docs/superpowers/assets/phase-9-r6-dashboard-ux-reference.png`: a restrained light-theme engineering console with a top run selector, current status summary, stage progress bar, agent status panel, next-step panel, event timeline, live output, and run artifacts.

## Problem

The current dashboard is functional but too raw:

- It surfaces internal terms first: `Phase: DEVELOPING`, `Active role: planner`, `kind`, `seq`, `ts`.
- Progress is hidden in a table; users must interpret event kinds manually.
- The active agent, next step, and current safety gate are not visually obvious.
- The run selector prioritizes the machine run id over the human task name.
- The UI mixes English and Chinese without a consistent labeling policy.
- The event table and live output are useful for debugging but dominate the page instead of supporting the state summary.

## Users

Primary user: repository owner/operator watching review-loop run locally in a browser.

Secondary user: AI developer or auditor diagnosing a run from event details, artifacts, and live output.

## Product Principles

1. **Chinese first, raw terms second.** Show human labels first, preserve raw phase/kind/role as secondary debugging text when useful.
2. **Status before logs.** The first viewport must answer "现在到哪一步了？".
3. **Workflow is fixed and visible.** The UI should emphasize the pipeline: 初始化 → 规划 → 开发 → 验证 → 审计 → 最终复核 → 完成.
4. **Use existing observability data.** Consume `.agent/events.jsonl` through existing dashboard APIs and SSE. Do not invent a separate run database.
5. **Do not weaken review-loop safety.** The dashboard remains observational except for the existing cancel action.
6. **No private chain-of-thought.** Live output continues to use filtered `role.output` events only.
7. **Debuggability remains available.** The raw event kind and terminal-like output stay accessible, but they are not the primary UI.

## In Scope

### Header

The header must include:

- Product title: `Review-Loop 控制台`.
- Subtitle: `多 Agent 自动开发流程 · 本地运行中` or terminal equivalent.
- Run selector that prioritizes a human task title when available, for example `优化 planner prompt`; show `Run ID: 20260622154127` as secondary text.
- Live connection indicator:
  - `实时连接中` when SSE is connected.
  - `轮询更新中` when EventSource is unavailable and polling is active.
  - `连接中断` when both SSE and polling fail.
- Last updated time in local time format, for example `更新时间 08:43:48`.
- Existing cancel button, localized as `取消运行`.

### Current Status Summary

The first large card must include:

- A small process summary graphic, not a decorative-only illustration. It should show completed, active, and waiting macro stages.
- Main headline using Chinese phase copy, for example `正在开发`.
- One-sentence current explanation, for example `开发者 Developer 正在执行第 1 轮修改，等待完成后进入本地验证`.
- Key fields:
  - `阶段`: Chinese phase label.
  - `角色`: Chinese + raw role label.
  - `模型`: provider/model badge.
  - `轮次`: `iteration / max_iterations` when known.
  - `已运行`: friendly elapsed time.
  - `最近事件`: Chinese event label + raw event kind, for example `任务开始 task.started`.

### Stage Progress Bar

Show a horizontal stage progress bar:

`初始化 → 规划 → 开发 → 验证 → 审计 → 最终复核 → 完成`

Stage states:

- Completed: green check.
- Active: blue ring/dot.
- Waiting: gray clock/dot.
- Failed/blocked/cancelled: red or amber terminal marker.

The progress bar must derive state from actual phase/events, not hard-coded demo state.

### Agent Status

Show the four fixed review-loop agents:

- `规划师 Planner`
- `开发者 Developer`
- `审计员 Auditor`
- `最终复核 Final Auditor`

Each row must show:

- Status: `已完成`, `运行中`, `等待中`, `失败`, `已取消`, or `已阻塞`.
- Provider/model badge: for example `Claude`, `Codex`.
- Duration when known.

Auditor and Final Auditor must remain visually present even before they start.

### Next Step

The next-step card must show a human explanation first, not only a phase mapping. Examples:

- Planning: `现在不用操作，系统正在等待规划师完成计划。`
- Developing: `现在不用操作，系统正在等待 Developer 完成修改。`
- Verifying: `系统正在运行 typecheck / lint / test，通过后进入 Codex 审计。`
- Auditing: `Codex 正在审计本轮 diff，若不通过会回到开发者返工。`
- Finalizing: `最终复核通过后，系统会写入最终结果。`
- Blocked: `运行已阻塞，需要人工处理后再 resume。`
- Failed: `运行失败，请查看错误事件和日志。`
- Passed: `运行已完成。`
- Cancelled: `运行已取消。`

Below the explanation, show a checklist:

1. `生成修改`
2. `本地验证`
3. `审计员 Auditor 审计`
4. `最终复核 Final Auditor 复核`
5. `写入最终结果`

The current item is blue, completed items are green, future items are gray.

### Event Timeline

Replace the raw event table as the primary event view with a timeline list:

- Time column in local `HH:mm:ss`.
- Event type badge using Chinese label.
- Message text in Chinese-friendly form.
- Raw event kind can remain inline as secondary code text when useful.
- The newest active row should be highlighted lightly.
- Include a small legend:
  - `已完成`
  - `进行中`
  - `心跳/等待`
  - `失败`

The raw table can be removed or moved behind an "完整日志/原始事件" affordance; it must not dominate the first viewport.

### Live Output

Keep the terminal-like live output panel:

- Localized title: `实时输出`.
- Filter tabs:
  - `全部`
  - `规划师 Planner`
  - `开发者 Developer`
  - `审计员 Auditor`
  - `验证`
- Auto-scroll toggle: `自动滚动`.
- Button: `展开完整日志`.
- Preserve monospace output and max line cap.
- Continue to avoid raw chain-of-thought.

### Run Artifacts

Rename `Artifacts` to `运行产物`.

Show artifact cards or compact rows for:

- `plan.md`
- `GOAL.md`
- `verification.log`
- `audit-report.md`
- `final-audit.md`
- `state.json`
- Any artifact refs emitted by events.

Each item should show:

- File name.
- Type label or icon-like marker.
- Size/time when available.
- Disabled/empty state when the artifact has not been created.

### Historical Runs

The existing historical run browser must remain:

- Active run uses SSE and shows cancel when non-terminal.
- Archived run closes SSE, fetches `GET /api/events?run_id=<id>`, and hides cancel.
- The UI should clearly mark archived runs as non-live, for example `历史运行`.

### Responsive Behavior

The dashboard must remain usable at:

- Desktop: 1440×900.
- Wide desktop: 1920×1080.
- Narrow desktop/tablet: 1024×768.

At narrow widths, the right column may stack below the main column. Text must not overlap.

### Accessibility and Safety

- All dynamic user/run-provided strings must be rendered with `textContent` or `createTextNode`.
- Do not introduce `innerHTML` for event messages, run ids, file paths, model names, or output text.
- Buttons must have clear disabled states.
- Color cannot be the only status signal; use text labels too.

## Label Requirements

### Phase Labels

| Raw phase | Chinese label |
|---|---|
| `INITIALIZING` | `初始化` |
| `PLANNING` | `规划中` |
| `DEVELOPING` | `开发中` |
| `REWORKING` | `返工中` |
| `VERIFYING` | `验证中` |
| `AUDITING` | `审计中` |
| `FINALIZING` | `最终复核` or `收尾中` based on active event context |
| `PASSED` | `已完成` |
| `FAILED` | `失败` |
| `BLOCKED` | `已阻塞` |
| `CANCELLED` | `已取消` |
| `unknown` | `未知` |

### Role Labels

| Raw role | UI label |
|---|---|
| `planner` | `规划师 Planner` |
| `developer` | `开发者 Developer` |
| `auditor` | `审计员 Auditor` |
| `final-auditor` | `最终复核 Final Auditor` |
| verification/local commands | `本地验证` |
| orchestrator/system | `调度器` |

### Event Labels

| Event kind | UI label |
|---|---|
| `run.started` | `运行开始` |
| `run.resumed` | `恢复运行` |
| `run.completed` | `运行完成` |
| `run.blocked` | `运行阻塞` |
| `run.failed` | `运行失败` |
| `phase.changed` | `阶段切换` |
| `role.started` | `角色开始` |
| `role.heartbeat` | `心跳` |
| `role.output` | `输出` |
| `role.error` | `角色错误` |
| `role.exited` | `角色结束` |
| `verification.started` | `本地验证开始` |
| `verification.completed` | `本地验证通过` |
| `verification.failed` | `本地验证失败` |
| `audit.decision` | `审计结论` |
| `rework.requested` | `请求返工` |
| `task.started` | `任务开始` |
| `task.completed` | `任务完成` |
| `task.blocked` | `任务阻塞` |
| `wave.started` | `开发波次开始` |
| `wave.completed` | `开发波次完成` |
| `integration.started` | `集成开始` |
| `integration.completed` | `集成完成` |
| `integration.blocked` | `集成阻塞` |
| `provider.failure` | `模型调用失败` |
| `artifact.created` | `产物生成` |

## API Requirements

No new endpoint is required.

Backward-compatible additions to existing JSON responses are allowed when they improve accuracy:

- `GET /api/runs` may add `display_title` derived from the run's first `run.started` message or task slug.
- `GET /api/events` may add a `ui_summary` object derived from the full event stream so the dashboard does not infer role/stage status from only the last 20 events.

Existing response fields must remain intact:

- `run_id`
- `current_phase`
- `next_action`
- `latest_events`
- `artifacts`
- `runs`
- `active_run_id`

## Non-Goals

- Do not change review-loop scheduling, state-machine transitions, resume behavior, or event emission semantics.
- Do not change Auditor or Final Auditor provider routing.
- Do not replace SSE with JSON-RPC in this phase.
- Do not add remote access, authentication, or multi-user support.
- Do not add a frontend framework unless the implementation already has one.
- Do not expose full raw agent transcripts or private chain-of-thought in the browser.
- Do not make the dashboard a marketing page or landing page.

## Acceptance Criteria

1. Header shows task title first and run id second when a title is available.
2. Current phase is readable in Chinese without understanding raw enum names.
3. Stage progress bar correctly reflects active, completed, waiting, and terminal states.
4. Agent status panel always shows Planner, Developer, Auditor, and Final Auditor.
5. Next-step panel gives a human-readable action hint and checklist.
6. Primary event view is a timeline, not a raw table.
7. Live output keeps filtered text, tabs, and auto-scroll behavior.
8. Artifacts are shown under `运行产物`.
9. Archived run selection still works and hides cancel.
10. Active run still uses SSE and falls back to polling.
11. Cancel still writes through the existing `/api/cancel` path.
12. No `innerHTML` is used for dynamic run/event/artifact/output content.
13. Existing unit and integration tests continue to pass.
14. New tests cover label mapping, stage derivation, agent status derivation, run-title derivation, and key rendered anchors.
15. A Playwright/browser screenshot at 1440×900 shows no overlap, no clipped primary text, and first-viewport comprehension of current progress.
