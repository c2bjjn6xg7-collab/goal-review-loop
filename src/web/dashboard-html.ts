/**
 * Phase 9 R2A — Inline HTML page for the read-only dashboard.
 *
 * Phase 9 R2C — Adds Cancel Run button that POSTs /api/cancel.
 *
 * Phase 9 R3 — Adds a `<select id="run-select">` historical run browser.
 *   - The client fetches `/api/runs` on load and every 15 s.
 *   - Selecting the active run keeps SSE + snapshot polling and shows the
 *     cancel button. Selecting an archived run closes the EventSource,
 *     stops the snapshot polling timer, fetches `/api/events?run_id=<id>`
 *     exactly once, and hides the cancel button.
 *
 * The page polls `/api/events` every 2 seconds (active only) and renders
 * the snapshot using `textContent` / `createTextNode` only so user/run-
 * supplied strings cannot inject HTML.
 */

import type { ReviewLoopEvent } from '../runtime/event-store.js';

/** Maximum number of live-output lines retained, FIFO. */
const LIVE_OUTPUT_MAX_LINES = 500;

export interface LiveOutputLine {
  ts: string;
  role: string;
  text: string;
}

// ── Label helpers (exported for testing) ───────────────────────────────────

const PHASE_LABELS: Record<string, string> = {
  INITIALIZING: '初始化',
  PLANNING: '规划中',
  DEVELOPING: '开发中',
  REWORKING: '返工中',
  VERIFYING: '验证中',
  AUDITING: '审计中',
  FINALIZING: '最终复核',
  PASSED: '已完成',
  FAILED: '失败',
  BLOCKED: '已阻塞',
  CANCELLED: '已取消',
  initializing: '初始化',
  planning: '规划中',
  developing: '开发中',
  verifying: '验证中',
  auditing: '审计中',
  final_auditing: '最终复核',
  complete: '完成',
  blocked: '已阻塞',
  failed: '失败',
  cancelled: '已取消',
  unknown: '未知',
};

const ROLE_LABELS: Record<string, string> = {
  planner: '规划师 Planner',
  developer: '开发者 Developer',
  auditor: '审计员 Auditor',
  'final auditor': '最终复核 Final Auditor',
  'final_auditor': '最终复核 Final Auditor',
  'final-auditor': '最终复核 Final Auditor',
};

const EVENT_KIND_LABELS: Record<string, string> = {
  'run.started': '运行开始',
  'run.resumed': '恢复运行',
  'run.completed': '运行完成',
  'run.blocked': '运行阻塞',
  'run.failed': '运行失败',
  'phase.changed': '阶段切换',
  'role.started': '角色开始',
  'role.output': '输出',
  'role.heartbeat': '心跳',
  'role.exited': '角色结束',
  'role.error': '角色错误',
  'verification.started': '本地验证开始',
  'verification.completed': '本地验证通过',
  'verification.failed': '本地验证失败',
  'audit.decision': '审计结论',
  'rework.requested': '请求返工',
  'task.started': '任务开始',
  'task.completed': '任务完成',
  'task.blocked': '任务阻塞',
  'wave.started': '开发波次开始',
  'wave.completed': '开发波次完成',
  'integration.started': '集成开始',
  'integration.completed': '集成完成',
  'integration.blocked': '集成阻塞',
  'provider.failure': '模型调用失败',
  'artifact.created': '产物生成',
};

const PROVIDER_LABELS: Record<string, string> = {
  openai: 'Codex',
  codex: 'Codex',
  anthropic: 'Claude',
  claude: 'Claude',
  google: 'Google',
  local: '本地',
  unknown: '未知',
};

/** Return a Chinese label for a phase slug. */
export function labelPhase(phase: string | null | undefined): string {
  if (phase == null) return PHASE_LABELS.unknown;
  return PHASE_LABELS[phase] ?? phase;
}

/** Return a Chinese label for a role slug. */
export function labelRole(role: string | null | undefined): string {
  if (role == null) return '';
  const key = role.toLowerCase().trim();
  return ROLE_LABELS[key] ?? role;
}

/** Return a Chinese label for an event kind. */
export function labelEventKind(kind: string | null | undefined): string {
  if (kind == null) return '';
  return EVENT_KIND_LABELS[kind] ?? kind;
}

/** Return a friendly label for a provider slug. */
export function labelProvider(provider: string | null | undefined): string {
  if (provider == null) return PROVIDER_LABELS.unknown;
  const key = provider.toLowerCase().trim();
  return PROVIDER_LABELS[key] ?? provider;
}

/** Format a duration in milliseconds as a human-readable string. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || ms < 0) return '—';
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}天 ${String(hours % 24).padStart(2, '0')}时`;
  if (hours > 0) return `${hours}时${String(minutes % 60).padStart(2, '0')}分`;
  if (minutes > 0) return `${minutes}分${String(seconds % 60).padStart(2, '0')}秒`;
  return `${seconds}秒`;
}

/** Format an ISO timestamp as local HH:mm:ss. */
export function formatLocalTime(ts: string | null | undefined): string {
  if (!ts) return '—';
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '—';
  }
}

/** Derive a display title from events and runId. */
export function deriveDisplayTitle(
  events: ReviewLoopEvent[] | undefined | null,
  runId: string,
): string {
  if (!Array.isArray(events) || events.length === 0) return runId;

  // Prefer the first run.started event message (strip "Run started:" prefix)
  const startedEvents = events.filter((e) => e && e.kind === 'run.started');
  if (startedEvents.length > 0) {
    const msg = startedEvents[0].message ?? '';
    const cleaned = msg.replace(/^Run started:\s*/i, '').trim();
    if (cleaned) return collapseTitle(cleaned);
  }

  // Fallback: payload.goal or payload.task
  for (const ev of events) {
    if (!ev || !ev.payload) continue;
    if (typeof ev.payload.goal === 'string' && ev.payload.goal.trim()) {
      return collapseTitle(ev.payload.goal);
    }
    if (typeof ev.payload.task === 'string' && ev.payload.task.trim()) {
      return collapseTitle(ev.payload.task);
    }
  }

  // Fallback: first non-empty event message
  for (const ev of events) {
    if (ev && ev.message && ev.message.trim()) {
      return collapseTitle(ev.message);
    }
  }

  return runId;
}

function collapseTitle(raw: string): string {
  let s = raw.trim();
  // Strip markdown headings
  s = s.replace(/^#{1,6}\s+/, '');
  // Collapse multiple spaces
  s = s.replace(/\s+/g, ' ');
  // Cap at ~48 display characters
  if (s.length > 48) {
    s = s.slice(0, 48) + '…';
  }
  return s;
}

// ── Existing helpers ───────────────────────────────────────────────────────

/**
 * Pure helper: extract the last 500 `role.output` events from `events`,
 * formatted as `{ ts, role, text }`. `text` prefers `payload.text` and
 * falls back to `message`. Exposed for unit testing.
 */
export function getLiveOutputLines(events: ReviewLoopEvent[] | undefined | null): LiveOutputLine[] {
  if (!Array.isArray(events)) return [];
  const out: LiveOutputLine[] = [];
  for (const ev of events) {
    if (!ev || ev.kind !== 'role.output') continue;
    const text =
      ev.payload && typeof ev.payload.text === 'string'
        ? ev.payload.text
        : ev.message ?? '';
    out.push({ ts: ev.ts, role: ev.role ?? '', text });
  }
  if (out.length > LIVE_OUTPUT_MAX_LINES) {
    return out.slice(out.length - LIVE_OUTPUT_MAX_LINES);
  }
  return out;
}

/**
 * Pure helper: returns `"Last heartbeat: Ns ago"` when `activeRole` has a
 * `role.heartbeat` event with no newer `role.exited` for the same role.
 * Returns `null` otherwise. Exposed for unit testing.
 */
export function getHeartbeatIndicator(
  events: ReviewLoopEvent[] | undefined | null,
  activeRole: string | undefined | null,
  nowMs: number = Date.now(),
): string | null {
  if (!activeRole || !Array.isArray(events)) return null;
  let lastHeartbeat: ReviewLoopEvent | undefined;
  let exitedAfterHeartbeat = false;
  for (const ev of events) {
    if (!ev || ev.role !== activeRole) continue;
    if (ev.kind === 'role.heartbeat') {
      lastHeartbeat = ev;
      exitedAfterHeartbeat = false;
    } else if (ev.kind === 'role.exited' && lastHeartbeat) {
      if (Date.parse(ev.ts) > Date.parse(lastHeartbeat.ts)) {
        exitedAfterHeartbeat = true;
      }
    }
  }
  if (!lastHeartbeat || exitedAfterHeartbeat) return null;
  const ageMs = nowMs - Date.parse(lastHeartbeat.ts);
  const secs = Math.max(0, Math.floor(ageMs / 1000));
  return `Last heartbeat: ${secs}s ago`;
}

// ── Inline HTML ────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Review-Loop 控制台</title>
<style>
  :root {
    color-scheme: light;
    --bg: #f5f6f8;
    --panel: #ffffff;
    --panel-soft: #fbfcfd;
    --line: #e7eaf0;
    --line-strong: #d9dee8;
    --text: #111827;
    --muted: #687386;
    --muted-2: #98a1b2;
    --blue: #1778ff;
    --blue-soft: #eaf3ff;
    --green: #18be72;
    --green-soft: #e8f8ef;
    --amber: #f59e0b;
    --amber-soft: #fff7dc;
    --red: #ef4444;
    --red-soft: #fff1f1;
    --terminal: #111c2b;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    font-size: 14px;
  }
  button, select { font: inherit; }
  code, .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }
  #dashboard-app { min-height: 100vh; }
  .topbar {
    height: 72px;
    padding: 0 28px;
    display: grid;
    grid-template-columns: minmax(260px, 1fr) minmax(320px, 420px) minmax(420px, 1fr);
    align-items: center;
    gap: 24px;
    background: rgba(255, 255, 255, 0.94);
    border-bottom: 1px solid var(--line);
    box-shadow: 0 8px 26px rgba(15, 23, 42, 0.04);
  }
  .brand { display: flex; align-items: center; gap: 22px; min-width: 0; }
  .menu-button {
    width: 28px;
    height: 28px;
    border: 0;
    background: transparent;
    color: #4b5563;
    font-size: 24px;
    line-height: 1;
    padding: 0;
  }
  .brand-title { font-size: 20px; line-height: 1.1; font-weight: 760; letter-spacing: 0; }
  .brand-subtitle { margin-top: 6px; color: var(--muted); font-size: 12px; }
  .run-picker {
    height: 48px;
    display: grid;
    grid-template-columns: 10px 1fr 18px;
    align-items: center;
    gap: 12px;
    padding: 7px 14px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(15, 23, 42, 0.035);
  }
  .run-live-dot, .connection-dot {
    width: 9px;
    height: 9px;
    border-radius: 999px;
    background: var(--green);
  }
  .run-select-wrap { min-width: 0; }
  #run-select {
    width: 100%;
    appearance: none;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--text);
    font-weight: 720;
    font-size: 14px;
    padding: 0;
  }
  .run-meta { color: var(--muted); font-size: 12px; margin-top: 2px; }
  .run-chevron { color: var(--muted); text-align: right; font-size: 16px; }
  .top-actions {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 20px;
    min-width: 0;
  }
  #connection-status {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-width: 92px;
    font-weight: 680;
    color: #1f2937;
    white-space: nowrap;
  }
  #connection-status .dot {
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: var(--amber);
  }
  #connection-status .dot.connected { background: var(--green); }
  #connection-status .dot.disconnected { background: var(--red); }
  #connection-status .dot.connecting { background: var(--amber); }
  .updated-label { display: flex; gap: 8px; white-space: nowrap; color: var(--muted); }
  .updated-label strong { color: var(--text); }
  #cancel-btn {
    height: 36px;
    padding: 0 15px;
    border: 1px solid #ffd9d9;
    border-radius: 7px;
    background: var(--red-soft);
    color: #e11d48;
    font-weight: 760;
  }
  #cancel-btn[disabled] {
    opacity: 0.58;
    cursor: not-allowed;
  }
  #cancel-error {
    color: var(--red);
    font-size: 12px;
    min-width: 0;
  }
  .dashboard-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 450px;
    gap: 14px;
    padding: 14px 18px 18px;
    max-width: 1600px;
    margin: 0 auto;
  }
  .main-column, .side-column { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  .side-column { gap: 12px; }
  .panel {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    box-shadow: 0 10px 30px rgba(15, 23, 42, 0.05);
  }
  .panel-header {
    min-height: 42px;
    padding: 16px 18px 0;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
  }
  .panel-header h2 {
    margin: 0;
    font-size: 18px;
    line-height: 1.1;
    font-weight: 760;
  }
  .panel-action {
    border: 0;
    background: transparent;
    color: #4b5563;
    font-weight: 650;
    padding: 0;
  }
  .status-panel {
    min-height: 174px;
    display: grid;
    grid-template-columns: 280px 1fr;
    align-items: center;
    padding: 22px 28px;
    gap: 18px;
  }
  .flow-mini {
    display: grid;
    grid-template-columns: 58px 1fr 58px;
    align-items: center;
    gap: 10px;
  }
  .flow-mini-label {
    text-align: center;
    color: var(--muted);
    font-weight: 700;
    font-size: 13px;
  }
  .flow-dot {
    width: 24px;
    height: 24px;
    margin: 0 auto 7px;
    border-radius: 999px;
    display: grid;
    place-items: center;
    color: #fff;
    font-weight: 900;
    background: var(--green);
    font-size: 13px;
  }
  .flow-dot.waiting { background: #c7cdd7; color: #fff; }
  .summary-ring {
    width: 104px;
    height: 104px;
    margin: 0 auto;
    border-radius: 999px;
    display: grid;
    place-items: center;
    background:
      radial-gradient(circle at center, #fff 0 44%, transparent 45%),
      conic-gradient(var(--blue) 0 56%, #ddecff 56% 74%, #f0f4f9 74% 100%);
    box-shadow: 0 16px 32px rgba(23, 120, 255, 0.22);
  }
  .summary-ring-inner {
    width: 62px;
    height: 62px;
    border-radius: 999px;
    display: grid;
    place-items: center;
    background: #f8fbff;
    color: #354052;
    font-size: 28px;
    font-weight: 800;
    box-shadow: inset 0 0 0 1px #e1e9f5;
  }
  .status-main h2 {
    margin: 0;
    font-size: 28px;
    line-height: 1.1;
    letter-spacing: 0;
  }
  .status-desc {
    margin-top: 10px;
    color: #111827;
    font-size: 16px;
    line-height: 1.55;
    text-wrap: pretty;
  }
  .status-stats {
    margin-top: 26px;
    display: grid;
    grid-template-columns: minmax(62px, 0.7fr) minmax(84px, 0.85fr) minmax(70px, 0.7fr) minmax(48px, 0.5fr) minmax(112px, 1.05fr) minmax(140px, 1.35fr);
    gap: 0;
  }
  .stat {
    min-width: 0;
    padding: 0 12px;
    border-left: 1px solid var(--line);
  }
  .stat:first-child { border-left: 0; padding-left: 0; }
  .stat:last-child { padding-right: 0; }
  .stat-label {
    color: var(--muted-2);
    font-size: 12px;
    font-weight: 650;
    margin-bottom: 8px;
  }
  .stat-value {
    color: var(--text);
    font-size: 15px;
    line-height: 1.2;
    font-weight: 760;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .stat-value.blue { color: var(--blue); }
  .stage-panel { padding: 18px 22px 16px; }
  .stage-bar {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    align-items: start;
    gap: 0;
  }
  .stage-item {
    position: relative;
    min-width: 0;
    text-align: center;
    color: #111827;
    font-weight: 720;
    font-size: 13px;
    padding-top: 36px;
  }
  .stage-item::before {
    content: "";
    position: absolute;
    top: 12px;
    left: calc(-50% + 16px);
    right: calc(50% + 16px);
    height: 3px;
    background: var(--line-strong);
  }
  .stage-item:first-child::before { display: none; }
  .stage-item::after {
    content: "";
    position: absolute;
    top: 0;
    left: 50%;
    transform: translateX(-50%);
    width: 26px;
    height: 26px;
    border-radius: 999px;
    background: #fff;
    border: 3px solid #c7cdd7;
    box-shadow: 0 0 0 4px #fff;
  }
  .stage-item.completed::before { background: var(--green); }
  .stage-item.completed::after {
    background: var(--green);
    border-color: var(--green);
  }
  .stage-item.active { color: var(--blue); }
  .stage-item.active::before { background: linear-gradient(90deg, var(--green), var(--blue)); }
  .stage-item.active::after {
    background: var(--blue);
    border-color: #d7e8ff;
    box-shadow: 0 0 0 5px #eef6ff, 0 8px 18px rgba(23, 120, 255, 0.25);
  }
  .stage-item.error::after {
    background: var(--red);
    border-color: #ffe1e1;
  }
  .timeline-panel { min-height: 348px; overflow: hidden; }
  #timeline-list {
    list-style: none;
    margin: 0;
    padding: 6px 18px 14px;
  }
  #timeline-list li {
    display: grid;
    grid-template-columns: 92px 26px 72px minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px;
    min-height: 36px;
    border-bottom: 1px solid var(--line);
    color: #111827;
  }
  #timeline-list li:last-child { border-bottom: 0; }
  #timeline-list li.latest {
    margin: 0 -18px;
    padding: 0 18px;
    background: #eef6ff;
  }
  .timeline-time {
    color: #647084;
    font-size: 13px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }
  .timeline-dot {
    width: 14px;
    height: 14px;
    border-radius: 999px;
    background: var(--blue);
    justify-self: center;
    box-shadow: 0 0 0 4px #eff6ff;
  }
  .timeline-dot.done { background: var(--green); box-shadow: 0 0 0 4px #ecfdf3; }
  .timeline-dot.wait { background: var(--amber); box-shadow: 0 0 0 4px #fff7dc; }
  .timeline-dot.fail { background: var(--red); box-shadow: 0 0 0 4px #fff1f1; }
  .timeline-badge {
    display: inline-flex;
    justify-content: center;
    min-width: 48px;
    padding: 4px 8px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 750;
    white-space: nowrap;
    background: var(--blue-soft);
    color: var(--blue);
  }
  .timeline-badge.done { background: var(--green-soft); color: #06945a; }
  .timeline-badge.wait { background: var(--amber-soft); color: #c77400; }
  .timeline-badge.fail { background: var(--red-soft); color: var(--red); }
  .timeline-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 14px;
    line-height: 1.3;
  }
  .timeline-state {
    color: var(--blue);
    background: var(--blue-soft);
    border-radius: 6px;
    padding: 4px 8px;
    font-size: 13px;
    font-weight: 760;
  }
  .legend {
    display: flex;
    gap: 16px;
    padding: 0 18px 12px;
    color: var(--muted);
    font-size: 12px;
  }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .legend i {
    width: 9px;
    height: 9px;
    border-radius: 999px;
    display: inline-block;
  }
  .legend .done { background: var(--green); }
  .legend .active { background: var(--blue); }
  .legend .wait { background: var(--amber); }
  .legend .fail { background: var(--red); }
  .live-panel { overflow: hidden; }
  .live-controls {
    padding: 0 18px 12px;
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: center;
  }
  .filter-tabs { display: flex; gap: 6px; flex-wrap: wrap; }
  .filter-tab {
    min-height: 30px;
    padding: 0 12px;
    border: 1px solid transparent;
    border-radius: 7px;
    color: #394150;
    background: #f1f3f6;
    font-weight: 650;
    cursor: pointer;
  }
  .filter-tab.active {
    color: var(--blue);
    background: var(--blue-soft);
    border-color: #cfe4ff;
  }
  .live-actions {
    display: flex;
    align-items: center;
    gap: 12px;
    color: #111827;
    white-space: nowrap;
  }
  .toggle {
    width: 38px;
    height: 22px;
    border-radius: 999px;
    background: var(--blue);
    position: relative;
    display: inline-block;
    vertical-align: middle;
  }
  .toggle::after {
    content: "";
    position: absolute;
    right: 3px;
    top: 3px;
    width: 16px;
    height: 16px;
    border-radius: 999px;
    background: #fff;
    box-shadow: 0 1px 4px rgba(0,0,0,0.18);
  }
  .log-button {
    min-height: 30px;
    border: 0;
    border-radius: 7px;
    background: #f1f3f6;
    padding: 0 12px;
    color: #1f2937;
    font-weight: 650;
  }
  #live-output {
    margin: 0 18px 16px;
    height: 206px;
    overflow: auto;
    padding: 16px 18px;
    border-radius: 7px;
    background:
      linear-gradient(135deg, rgba(255,255,255,0.05), transparent 26%),
      var(--terminal);
    color: #d7e1ee;
    border: 1px solid #1f3046;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 13px;
    line-height: 1.7;
    white-space: pre-wrap;
  }
  #live-output div { white-space: pre-wrap; }
  .side-card {
    padding: 18px 20px;
  }
  .side-card h2 {
    margin: 0 0 14px;
    font-size: 20px;
    line-height: 1.1;
  }
  .agent-list { display: flex; flex-direction: column; }
  .agent-card {
    display: grid;
    grid-template-columns: 24px minmax(0, 1fr) auto auto auto;
    gap: 12px;
    align-items: center;
    min-height: 46px;
    border-bottom: 1px solid var(--line);
  }
  .agent-card:last-child { border-bottom: 0; }
  .agent-light {
    width: 16px;
    height: 16px;
    border-radius: 999px;
    background: #c7cdd7;
    box-shadow: 0 0 0 4px #f0f2f5;
  }
  .agent-light.running { background: var(--blue); box-shadow: 0 0 0 4px #eaf3ff; }
  .agent-light.completed { background: var(--green); box-shadow: 0 0 0 4px #e8f8ef; }
  .agent-light.failed, .agent-light.blocked { background: var(--red); box-shadow: 0 0 0 4px #fff1f1; }
  .agent-name {
    min-width: 0;
    font-weight: 760;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .agent-provider, .agent-status-badge {
    border-radius: 6px;
    padding: 3px 8px;
    font-size: 12px;
    font-weight: 720;
    white-space: nowrap;
  }
  .agent-provider { background: #eef0f3; color: #697386; }
  .agent-status-badge.waiting { background: #f1f3f6; color: #4b5563; }
  .agent-status-badge.running { background: var(--blue-soft); color: var(--blue); }
  .agent-status-badge.completed { background: var(--green-soft); color: #04945a; }
  .agent-status-badge.failed, .agent-status-badge.blocked { background: var(--red-soft); color: var(--red); }
  .agent-status-badge.cancelled { background: #f1f3f6; color: #4b5563; }
  .agent-duration {
    color: var(--blue);
    font-weight: 760;
    text-align: right;
    white-space: nowrap;
  }
  .agent-footer {
    padding-top: 13px;
    text-align: right;
  }
  .link-button {
    border: 0;
    background: transparent;
    color: var(--blue);
    font-weight: 760;
    padding: 0;
  }
  .notice {
    border-radius: 7px;
    padding: 12px 14px;
    margin-bottom: 13px;
    background: var(--amber-soft);
    color: #4f3b04;
    font-weight: 690;
    line-height: 1.45;
  }
  .next-body {
    margin: 0 0 14px;
    line-height: 1.7;
    color: #1f2937;
  }
  .checklist {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .checklist li {
    display: flex;
    gap: 10px;
    align-items: center;
    min-height: 32px;
    color: #111827;
    font-weight: 650;
  }
  .checklist li::before {
    content: "";
    width: 18px;
    height: 18px;
    border: 2px solid #8b95a7;
    border-radius: 999px;
    flex: 0 0 auto;
  }
  .checklist li.done { color: var(--blue); }
  .checklist li.done::before {
    border-color: var(--blue);
    background: radial-gradient(circle at center, var(--blue) 0 46%, transparent 50%);
  }
  #artifacts-list {
    display: grid;
    grid-template-columns: 1fr 1fr;
    list-style: none;
    padding: 0;
    margin: 0;
    gap: 0;
  }
  #artifacts-list li {
    min-width: 0;
    min-height: 58px;
    display: grid;
    grid-template-columns: 36px minmax(0, 1fr);
    gap: 10px;
    align-items: center;
    border-bottom: 1px solid var(--line);
    padding: 9px 8px;
  }
  #artifacts-list li:nth-child(odd) { border-right: 1px solid var(--line); }
  .artifact-icon {
    width: 32px;
    height: 36px;
    border-radius: 6px;
    display: grid;
    place-items: center;
    background: #eef4ff;
    color: var(--blue);
    font-weight: 850;
  }
  .artifact-body { min-width: 0; display: block; }
  .artifact-name {
    display: block;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 760;
  }
  .artifact-meta {
    display: block;
    color: var(--muted);
    font-size: 12px;
    margin-top: 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .muted { color: var(--muted); font-size: 12px; }
  .hidden-compat { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  @media (max-width: 1180px) {
    .topbar { grid-template-columns: 1fr; height: auto; padding: 14px 18px; gap: 12px; }
    .top-actions { justify-content: flex-start; flex-wrap: wrap; }
    .dashboard-grid { grid-template-columns: 1fr; }
    .status-panel { grid-template-columns: 1fr; }
    .flow-mini { max-width: 280px; }
    .status-stats { grid-template-columns: repeat(3, 1fr); row-gap: 18px; }
    .stat:nth-child(4) { border-left: 0; padding-left: 0; }
  }
  @media (max-width: 760px) {
    .dashboard-grid { padding: 10px; }
    .status-stats { grid-template-columns: 1fr 1fr; }
    .stage-bar { grid-template-columns: repeat(4, 1fr); row-gap: 14px; }
    #timeline-list li { grid-template-columns: 72px 18px 64px minmax(0, 1fr); }
    .timeline-state { display: none; }
    #artifacts-list { grid-template-columns: 1fr; }
    #artifacts-list li:nth-child(odd) { border-right: 0; }
  }
</style>
</head>
<body>
<div id="dashboard-app">
<header class="topbar">
  <div class="brand">
    <button class="menu-button" type="button" aria-label="菜单">≡</button>
    <div>
      <div class="brand-title">Review-Loop 控制台</div>
      <div class="brand-subtitle">多 Agent 自动开发流程 · 本地运行中</div>
    </div>
  </div>
  <div class="run-picker">
    <span class="run-live-dot" aria-hidden="true"></span>
    <div class="run-select-wrap">
      <select id="run-select" aria-label="选择运行"></select>
      <div class="run-meta">Run ID: <span id="run-id">—</span></div>
    </div>
    <span class="run-chevron" aria-hidden="true">⌄</span>
  </div>
  <div class="top-actions">
    <span id="connection-status"><span class="dot connecting"></span><span class="connection-text">连接中</span></span>
    <span class="updated-label">更新时间 <strong id="updated-at">—</strong></span>
    <button id="cancel-btn" type="button" disabled>取消运行</button>
    <span id="cancel-error" role="alert"></span>
  </div>
</header>

<main class="dashboard-grid">
  <div class="main-column">
    <section class="panel status-panel" aria-label="当前状态">
      <div class="flow-mini" aria-label="流程运行摘要">
        <div class="flow-mini-label">
          <div class="flow-dot">✓</div>
          <div>规划</div>
        </div>
        <div>
          <div class="muted" style="text-align:center;margin-bottom:10px;">流程运行摘要</div>
          <div class="summary-ring">
            <div class="summary-ring-inner">&lt;/&gt;</div>
          </div>
        </div>
        <div class="flow-mini-label">
          <div class="flow-dot waiting">⌕</div>
          <div>复核</div>
        </div>
      </div>
      <div class="status-main">
        <h2 id="current-headline">正在初始化</h2>
        <div id="current-description" class="status-desc">正在读取运行事件，请稍候。</div>
        <div class="status-stats">
          <div class="stat">
            <div class="stat-label">阶段</div>
            <div id="current-phase-label" class="stat-value blue">—</div>
          </div>
          <div class="stat">
            <div class="stat-label">角色</div>
            <div id="current-role-label" class="stat-value">—</div>
          </div>
          <div class="stat">
            <div class="stat-label">模型</div>
            <div id="current-model-label" class="stat-value">—</div>
          </div>
          <div class="stat">
            <div class="stat-label">轮次</div>
            <div id="current-iteration-label" class="stat-value">—</div>
          </div>
          <div class="stat">
            <div class="stat-label">已运行</div>
            <div id="current-elapsed-label" class="stat-value">—</div>
          </div>
          <div class="stat">
            <div class="stat-label">最近事件</div>
            <div id="current-event-label" class="stat-value blue">—</div>
          </div>
        </div>
        <span id="current-title" class="hidden-compat">—</span>
      </div>
    </section>

    <section class="panel stage-panel" aria-label="阶段进度">
      <div id="stage-progress" class="stage-bar">
        <div class="stage-item waiting" data-stage="initializing">初始化</div>
        <div class="stage-item waiting" data-stage="planning">规划</div>
        <div class="stage-item waiting" data-stage="developing">开发</div>
        <div class="stage-item waiting" data-stage="verifying">验证</div>
        <div class="stage-item waiting" data-stage="auditing">审计</div>
        <div class="stage-item waiting" data-stage="final_auditing">最终复核</div>
        <div class="stage-item waiting" data-stage="complete">完成</div>
      </div>
    </section>

    <section class="panel timeline-panel">
      <div class="panel-header">
        <h2>执行时间线</h2>
        <button class="panel-action" type="button">⌃ 折叠</button>
      </div>
      <span class="hidden-compat">事件时间线</span>
      <ul id="timeline-list"></ul>
      <p id="timeline-empty" class="muted" hidden>暂无事件。</p>
      <div class="legend">
        <span><i class="done"></i>已完成</span>
        <span><i class="active"></i>进行中</span>
        <span><i class="wait"></i>心跳/等待</span>
        <span><i class="fail"></i>失败</span>
      </div>
    </section>

    <section class="panel live-panel">
      <div class="panel-header">
        <h2>实时输出</h2>
      </div>
      <div class="live-controls">
        <div class="filter-tabs">
          <button class="filter-tab active" data-filter="all" type="button">全部</button>
          <button class="filter-tab" data-filter="planner" type="button">规划师 Planner</button>
          <button class="filter-tab" data-filter="developer" type="button">开发者 Developer</button>
          <button class="filter-tab" data-filter="auditor" type="button">审计员 Auditor</button>
          <button class="filter-tab" data-filter="verifying" type="button">验证</button>
        </div>
        <div class="live-actions">
          <span>自动滚动 <span class="toggle" aria-hidden="true"></span></span>
          <button class="log-button" type="button">展开完整日志 ↗</button>
        </div>
      </div>
      <pre id="live-output" aria-live="polite"></pre>
    </section>
  </div>

  <aside class="side-column">
    <section class="panel side-card" aria-label="代理状态">
      <h2>Agent 状态</h2>
      <span class="hidden-compat">代理状态</span>
      <div id="agent-status-list" class="agent-list">
        <div class="agent-card" data-role="planner">
          <span class="agent-light waiting"></span>
          <div class="agent-name">规划师 Planner</div>
          <span class="agent-provider">—</span>
          <span class="agent-status-badge waiting">等待中</span>
          <span class="agent-duration">—</span>
        </div>
        <div class="agent-card" data-role="developer">
          <span class="agent-light waiting"></span>
          <div class="agent-name">开发者 Developer</div>
          <span class="agent-provider">—</span>
          <span class="agent-status-badge waiting">等待中</span>
          <span class="agent-duration">—</span>
        </div>
        <div class="agent-card" data-role="auditor">
          <span class="agent-light waiting"></span>
          <div class="agent-name">审计员 Auditor</div>
          <span class="agent-provider">—</span>
          <span class="agent-status-badge waiting">等待中</span>
          <span class="agent-duration">—</span>
        </div>
        <div class="agent-card" data-role="final-auditor">
          <span class="agent-light waiting"></span>
          <div class="agent-name">最终复核 Final Auditor</div>
          <span class="agent-provider">—</span>
          <span class="agent-status-badge waiting">等待中</span>
          <span class="agent-duration">—</span>
        </div>
      </div>
      <div class="agent-footer"><button class="link-button" type="button">查看 Agent 日志 ›</button></div>
    </section>

    <section class="panel side-card">
      <h2>下一步</h2>
      <div id="next-step" class="next-step-card">
        <div id="next-step-title" class="notice">现在不用操作，系统正在等待运行继续。</div>
        <p id="next-step-body" class="next-body">系统会根据当前阶段自动进入下一道安全门。</p>
        <ul class="checklist" id="next-step-checklist">
          <li id="check-generate">生成修改（当前步骤）</li>
          <li id="check-validate">本地验证（typecheck / lint / test）</li>
          <li id="check-audit">审计员 Auditor 审计</li>
          <li id="check-final">最终复核 Final Auditor 复核</li>
          <li id="check-write">写入最终结果</li>
        </ul>
      </div>
    </section>

    <section class="panel side-card">
      <h2>运行产物 <span id="artifact-count" class="muted">(0)</span></h2>
      <ul id="artifacts-list"></ul>
      <p id="artifacts-empty" class="muted" hidden>暂无运行产物。</p>
      <div class="agent-footer"><button class="link-button" type="button">查看全部文件产物 ›</button></div>
    </section>
  </aside>
</main>
</div>

<script>
(function () {
  // ── Label maps (embedded as JSON for the browser) ──────────────────────
  var LABEL_PHASE = ${JSON.stringify(PHASE_LABELS)};
  var LABEL_ROLE = ${JSON.stringify(ROLE_LABELS)};
  var LABEL_EVENT_KIND = ${JSON.stringify(EVENT_KIND_LABELS)};
  var LABEL_PROVIDER = ${JSON.stringify(PROVIDER_LABELS)};

  var runSelectEl = document.getElementById('run-select');
  var runIdEl = document.getElementById('run-id');
  var connectionStatusEl = document.getElementById('connection-status');
  var connectionTextEl = connectionStatusEl.querySelector('.connection-text');
  var updatedEl = document.getElementById('updated-at');
  var cancelBtn = document.getElementById('cancel-btn');
  var cancelErr = document.getElementById('cancel-error');
  var currentTitleEl = document.getElementById('current-title');
  var currentHeadlineEl = document.getElementById('current-headline');
  var currentDescriptionEl = document.getElementById('current-description');
  var currentPhaseLabelEl = document.getElementById('current-phase-label');
  var currentRoleLabelEl = document.getElementById('current-role-label');
  var currentModelLabelEl = document.getElementById('current-model-label');
  var currentIterationLabelEl = document.getElementById('current-iteration-label');
  var currentElapsedLabelEl = document.getElementById('current-elapsed-label');
  var currentEventLabelEl = document.getElementById('current-event-label');
  var stageProgressEl = document.getElementById('stage-progress');
  var agentStatusListEl = document.getElementById('agent-status-list');
  var nextStepEl = document.getElementById('next-step');
  var nextStepTitleEl = document.getElementById('next-step-title');
  var nextStepBodyEl = document.getElementById('next-step-body');
  var nextStepChecklistEl = document.getElementById('next-step-checklist');
  var timelineListEl = document.getElementById('timeline-list');
  var timelineEmpty = document.getElementById('timeline-empty');
  var liveOutEl = document.getElementById('live-output');
  var artsEl = document.getElementById('artifacts-list');
  var artsEmpty = document.getElementById('artifacts-empty');
  var artifactCountEl = document.getElementById('artifact-count');

  var LIVE_OUTPUT_MAX_LINES = 500;
  var TERMINAL = { PASSED: 1, FAILED: 1, BLOCKED: 1, CANCELLED: 1 };
  var cancelInFlight = false;

  // Tracks the currently selected run and whether it is the active run.
  var activeRunId = null;
  var selectedRunId = null;
  var selectedIsActive = false;
  var currentFilter = 'all';

  function setText(el, value) {
    el.textContent = value == null ? '' : String(value);
  }

  function labelPhase(phase) {
    return LABEL_PHASE[phase] || phase || LABEL_PHASE.unknown;
  }

  function labelRole(role) {
    if (!role) return '';
    return LABEL_ROLE[role.toLowerCase().trim()] || role;
  }

  function labelEventKind(kind) {
    return LABEL_EVENT_KIND[kind] || kind || '';
  }

  function labelProvider(provider) {
    if (!provider) return LABEL_PROVIDER.unknown;
    return LABEL_PROVIDER[provider.toLowerCase().trim()] || provider;
  }

  function formatDuration(ms) {
    if (ms == null || ms < 0) return '—';
    var seconds = Math.floor(ms / 1000);
    var minutes = Math.floor(seconds / 60);
    var hours = Math.floor(minutes / 60);
    var days = Math.floor(hours / 24);
    if (days > 0) return days + '天 ' + String(hours % 24).padStart(2, '0') + '时';
    if (hours > 0) return hours + '时' + String(minutes % 60).padStart(2, '0') + '分';
    if (minutes > 0) return minutes + '分' + String(seconds % 60).padStart(2, '0') + '秒';
    return seconds + '秒';
  }

  function formatLocalTime(ts) {
    if (!ts) return '—';
    try {
      var d = new Date(ts);
      return d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch (e) {
      return '—';
    }
  }

  function deriveDisplayTitle(events, runId) {
    if (!Array.isArray(events) || events.length === 0) return runId;
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (ev && ev.kind === 'run.started' && ev.message) {
        var cleaned = ev.message.replace(/^Run started:\\s*/i, '').trim();
        if (cleaned) return cleaned.length > 48 ? cleaned.slice(0, 48) + '…' : cleaned;
      }
    }
    for (var j = 0; j < events.length; j++) {
      var ev2 = events[j];
      if (ev2 && ev2.payload) {
        if (typeof ev2.payload.goal === 'string' && ev2.payload.goal.trim()) {
          var g = ev2.payload.goal.trim();
          return g.length > 48 ? g.slice(0, 48) + '…' : g;
        }
        if (typeof ev2.payload.task === 'string' && ev2.payload.task.trim()) {
          var t = ev2.payload.task.trim();
          return t.length > 48 ? t.slice(0, 48) + '…' : t;
        }
      }
    }
    for (var k = 0; k < events.length; k++) {
      var ev3 = events[k];
      if (ev3 && ev3.message && ev3.message.trim()) {
        var m = ev3.message.trim();
        return m.length > 48 ? m.slice(0, 48) + '…' : m;
      }
    }
    return runId;
  }

  function renderCancelButton(phase) {
    if (!selectedIsActive) {
      cancelBtn.hidden = true;
      return;
    }
    cancelBtn.hidden = false;
    var isTerminal = phase == null || phase === 'unknown' || TERMINAL[phase] === 1;
    if (cancelInFlight) {
      cancelBtn.disabled = true;
      setText(cancelBtn, '取消中…');
      if (isTerminal) {
        cancelInFlight = false;
        setText(cancelBtn, '运行已结束');
      }
      return;
    }
    if (isTerminal) {
      cancelBtn.disabled = true;
      setText(cancelBtn, '运行已结束');
    } else {
      cancelBtn.disabled = false;
      setText(cancelBtn, '取消运行');
    }
  }

  function updateConnectionStatus(connected) {
    var dot = connectionStatusEl.querySelector('.dot');
    if (connected) {
      dot.className = 'dot connected';
      setText(connectionTextEl, selectedIsActive ? '实时连接中' : '历史运行');
    } else {
      dot.className = 'dot disconnected';
      setText(connectionTextEl, '已断开');
    }
  }

  function renderStageProgress(activeStage, displayStage) {
    var stages = ['initializing', 'planning', 'developing', 'verifying', 'auditing', 'final_auditing', 'complete'];
    var activeIndex = stages.indexOf(activeStage);
    var terminalError = displayStage === 'failed' || displayStage === 'blocked' || displayStage === 'cancelled';
    if (activeStage === 'complete') activeIndex = stages.length - 1;
    if (terminalError && activeIndex === -1) {
      activeIndex = stages.length - 1;
    }
    var items = stageProgressEl.querySelectorAll('.stage-item');
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      item.classList.remove('completed', 'active', 'waiting', 'error');
      if (i < activeIndex) {
        item.classList.add('completed');
      } else if (i === activeIndex) {
        item.classList.add(terminalError ? 'error' : 'active');
      } else {
        item.classList.add('waiting');
      }
    }
  }

  function renderAgentStatus(snapshot) {
    var roles = ['planner', 'developer', 'auditor', 'final-auditor'];
    var uiSummary = snapshot.ui_summary || {};
    var roleStatuses = uiSummary.roles || [];
    var cards = agentStatusListEl.querySelectorAll('.agent-card');
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var roleKey = card.getAttribute('data-role');
      var lightEl = card.querySelector('.agent-light');
      var providerEl = card.querySelector('.agent-provider');
      var statusEl = card.querySelector('.agent-status-badge');
      var durationEl = card.querySelector('.agent-duration');

      var roleData = null;
      for (var j = 0; j < roleStatuses.length; j++) {
        if (roleStatuses[j] && roleStatuses[j].role === roleKey) {
          roleData = roleStatuses[j];
          break;
        }
      }

      if (roleData) {
        var statusText = roleData.status || 'waiting';
        var statusMap = { waiting: '等待中', running: '运行中', completed: '已完成', failed: '失败', blocked: '已阻塞', cancelled: '已取消' };
        setText(statusEl, statusMap[statusText] || statusText);
        statusEl.className = 'agent-status-badge ' + statusText;
        lightEl.className = 'agent-light ' + statusText;
        var provider = labelProvider(roleData.provider || roleData.model);
        var dur = roleData.duration_ms != null ? formatDuration(roleData.duration_ms) : '—';
        setText(providerEl, provider);
        setText(durationEl, dur);
      } else {
        setText(statusEl, '等待中');
        statusEl.className = 'agent-status-badge waiting';
        lightEl.className = 'agent-light waiting';
        setText(providerEl, '—');
        setText(durationEl, '—');
      }
    }
  }

  function renderNextStep(snapshot) {
    var uiSummary = snapshot.ui_summary || {};
    var phase = uiSummary.active_stage || snapshot.current_phase || 'unknown';
    var steps = {
      initializing: { title: '正在初始化运行环境。', body: '系统正在读取配置、准备事件流和运行状态。', done: [] },
      planning: { title: '现在不用操作，系统正在等待规划师完成计划。', body: '规划完成后，会自动进入开发任务。', done: [] },
      developing: { title: '现在不用操作，系统正在等待 Developer 完成修改。', body: 'Developer 完成后，将自动运行 typecheck / lint / test。验证通过后进入 Codex 审计。', done: ['check-generate'] },
      verifying: { title: '系统正在运行本地验证。', body: '验证包含 typecheck / lint / test，通过后进入 Auditor 审计。', done: ['check-generate', 'check-validate'] },
      auditing: { title: 'Codex 正在审计本轮 diff。', body: '审计不通过会回到开发者返工，通过后进入最终复核。', done: ['check-generate', 'check-validate', 'check-audit'] },
      final_auditing: { title: '正在执行最终复核。', body: '最终复核通过后，系统会写入最终结果。', done: ['check-generate', 'check-validate', 'check-audit', 'check-final'] },
      complete: { title: '运行已完成。', body: '所有安全门已通过，最终结果已经写入。', done: ['check-generate', 'check-validate', 'check-audit', 'check-final', 'check-write'] },
      blocked: { title: '运行已阻塞，需要人工处理后再 resume。', body: '请查看错误事件、审计报告或运行产物定位阻塞原因。', done: [] },
      failed: { title: '运行失败，请查看错误事件和日志。', body: '修复配置或代码问题后，再重新启动。', done: [] },
      cancelled: { title: '运行已取消。', body: '取消请求已经写入，当前运行不再继续推进。', done: [] },
      unknown: { title: '准备就绪。', body: '等待事件流提供更多状态。', done: [] },
    };
    var step = steps[phase] || steps.unknown;
    setText(nextStepTitleEl, step.title);
    setText(nextStepBodyEl, step.body);
    var items = nextStepChecklistEl.querySelectorAll('li');
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (step.done.indexOf(item.id) !== -1) {
        item.classList.add('done');
      } else {
        item.classList.remove('done');
      }
    }
  }

  function renderTimeline(events) {
    while (timelineListEl.firstChild) timelineListEl.removeChild(timelineListEl.firstChild);
    var allEvents = Array.isArray(events) ? events : [];
    var evs = allEvents.length > 14 ? allEvents.slice(allEvents.length - 14) : allEvents;
    timelineEmpty.hidden = evs.length !== 0;
    for (var i = 0; i < evs.length; i++) {
      var ev = evs[i];
      if (!ev) continue;
      var li = document.createElement('li');
      if (i === evs.length - 1) li.classList.add('latest');

      var timeSpan = document.createElement('span');
      timeSpan.className = 'timeline-time';
      setText(timeSpan, formatLocalTime(ev.ts));
      li.appendChild(timeSpan);

      var dot = document.createElement('span');
      dot.className = 'timeline-dot';
      var tone = eventTone(ev);
      if (tone !== 'active') dot.classList.add(tone);
      li.appendChild(dot);

      var badge = document.createElement('span');
      badge.className = 'timeline-badge';
      if (tone !== 'active') badge.classList.add(tone);
      setText(badge, labelEventKind(ev.kind));
      li.appendChild(badge);

      var textSpan = document.createElement('span');
      textSpan.className = 'timeline-text';
      var msg = formatTimelineMessage(ev);
      setText(textSpan, msg);
      li.appendChild(textSpan);

      var stateSpan = document.createElement('span');
      stateSpan.className = 'timeline-state';
      setText(stateSpan, i === evs.length - 1 ? eventStateText(tone) : '');
      li.appendChild(stateSpan);

      timelineListEl.appendChild(li);
    }
  }

  function eventTone(ev) {
    if (!ev || ev.level === 'error' || (ev.kind && (ev.kind.indexOf('failed') >= 0 || ev.kind.indexOf('blocked') >= 0 || ev.kind.indexOf('failure') >= 0))) return 'fail';
    if (ev.kind === 'role.heartbeat') return 'wait';
    if (ev.kind && (ev.kind.indexOf('completed') >= 0 || ev.kind === 'role.exited' || ev.kind === 'run.completed')) return 'done';
    return 'active';
  }

  function eventStateText(tone) {
    if (tone === 'fail') return '失败';
    if (tone === 'done') return '已完成';
    if (tone === 'wait') return '等待中';
    return '进行中';
  }

  function formatTimelineMessage(ev) {
    var label = labelEventKind(ev.kind);
    var raw = ev.kind ? ' ' + ev.kind : '';
    var msg = ev.message || '';
    if (ev.kind === 'role.heartbeat' && ev.role) {
      return labelRole(ev.role) + ' 仍在运行 · ' + msg.replace(/^.*still running/i, '').trim();
    }
    if (ev.kind === 'role.output') {
      return (ev.role ? labelRole(ev.role) + ' ' : '') + '输出更新';
    }
    if (ev.kind === 'task.started') {
      return label + raw + ': ' + msg;
    }
    if (ev.role) {
      return labelRole(ev.role) + ' ' + msg;
    }
    return label + raw + (msg ? ': ' + msg : '');
  }

  function render(snapshot) {
    var uiSummary = snapshot.ui_summary || {};
    var displayTitle = uiSummary.display_title || snapshot.run_id || '—';
    setText(runIdEl, snapshot.run_id || '—');
    setText(currentTitleEl, displayTitle);
    var activeStage = uiSummary.active_stage || snapshot.current_phase || 'unknown';
    var activeRole = uiSummary.active_role || '';
    var activeProvider = uiSummary.active_provider || uiSummary.active_model || '';
    setText(currentHeadlineEl, headlineForStage(activeStage));
    setText(currentDescriptionEl, descriptionForStage(activeStage, activeRole, uiSummary.iteration, uiSummary.max_iterations));
    setText(currentPhaseLabelEl, labelPhase(activeStage));
    setText(currentRoleLabelEl, labelRoleShort(activeRole) || '—');
    currentRoleLabelEl.title = labelRole(activeRole) || '';
    setText(currentModelLabelEl, labelProvider(activeProvider));
    setText(currentIterationLabelEl, (uiSummary.iteration != null && uiSummary.max_iterations != null && uiSummary.max_iterations > 0 ? uiSummary.iteration + ' / ' + uiSummary.max_iterations : '—'));
    setText(currentElapsedLabelEl, formatDuration(uiSummary.elapsed_ms));
    setText(currentEventLabelEl, labelEventKind(uiSummary.last_event_kind) || '—');
    currentEventLabelEl.title = uiSummary.last_event_kind || '';

    renderCancelButton(snapshot.current_phase);
    renderStageProgress(stageForProgress(activeStage, activeRole), activeStage);
    renderAgentStatus(snapshot);
    renderNextStep(snapshot);
    renderTimeline(snapshot.latest_events);
    renderLiveOutput(snapshot.latest_events);
    renderArtifacts(snapshot.artifacts);
    setText(updatedEl, new Date().toLocaleTimeString('zh-CN'));
  }

  function headlineForStage(stage) {
    var map = {
      initializing: '正在初始化',
      planning: '正在规划',
      developing: '正在开发',
      verifying: '正在验证',
      auditing: '正在审计',
      final_auditing: '正在最终复核',
      complete: '已完成',
      blocked: '已阻塞',
      failed: '失败',
      cancelled: '已取消',
      unknown: '等待事件',
    };
    return map[stage] || labelPhase(stage);
  }

  function stageForProgress(stage, role) {
    if (stage !== 'blocked' && stage !== 'failed' && stage !== 'cancelled') return stage;
    var normalized = role ? String(role).toLowerCase().replace(/_/g, '-') : '';
    if (normalized === 'planner') return 'planning';
    if (normalized === 'developer') return 'developing';
    if (normalized === 'auditor') return 'auditing';
    if (normalized === 'final-auditor') return 'final_auditing';
    return stage;
  }

  function descriptionForStage(stage, role, iteration, maxIterations) {
    var roleText = labelRole(role);
    var iterText = iteration != null && maxIterations != null && maxIterations > 0 ? '第 ' + iteration + ' 轮' : '当前轮次';
    if (stage === 'planning') return '规划师 Planner 正在拆解任务，完成后会进入开发。';
    if (stage === 'developing') return (roleText || '开发者 Developer') + ' 正在执行' + iterText + '修改，等待完成后进入本地验证。';
    if (stage === 'verifying') return '系统正在运行本地验证，通过后进入 Codex 审计。';
    if (stage === 'auditing') return '审计员 Auditor 正在检查本轮 diff 和运行产物。';
    if (stage === 'final_auditing') return '最终复核 Final Auditor 正在进行最后一道安全检查。';
    if (stage === 'complete') return '所有阶段已通过，运行结果已经写入。';
    if (stage === 'blocked') return '运行遇到阻塞，需要人工处理后再恢复。';
    if (stage === 'failed') return '运行失败，请查看错误事件和日志。';
    if (stage === 'cancelled') return '运行已经取消。';
    return '正在读取运行事件，请稍候。';
  }

  function labelRoleShort(role) {
    var normalized = role ? String(role).toLowerCase().replace(/_/g, '-') : '';
    var map = {
      planner: '规划师',
      developer: '开发者',
      auditor: '审计员',
      'final-auditor': '最终复核',
    };
    return map[normalized] || labelRole(role);
  }

  function renderArtifacts(artifacts) {
    while (artsEl.firstChild) artsEl.removeChild(artsEl.firstChild);
    var arts = Array.isArray(artifacts) ? artifacts : [];
    setText(artifactCountEl, '(' + arts.length + ')');
    artsEmpty.hidden = arts.length !== 0;
    var important = ['plan.md', 'GOAL.md', 'verification.log', 'audit-report.md', 'final-audit.md', 'state.json'];
    arts.sort(function(a, b) {
      var ap = a && a.path ? a.path : '';
      var bp = b && b.path ? b.path : '';
      var ai = important.findIndex(function(name) { return ap.endsWith(name); });
      var bi = important.findIndex(function(name) { return bp.endsWith(name); });
      if (ai === -1) ai = 999;
      if (bi === -1) bi = 999;
      return ai - bi || ap.localeCompare(bp);
    });
    for (var i = 0; i < arts.length; i++) {
      var art = arts[i];
      var li = document.createElement('li');
      var icon = document.createElement('span');
      icon.className = 'artifact-icon';
      setText(icon, artifactIcon(art));
      li.appendChild(icon);

      var body = document.createElement('span');
      body.className = 'artifact-body';
      var name = document.createElement('span');
      name.className = 'artifact-name';
      setText(name, basename(art.path || ''));
      var meta = document.createElement('span');
      meta.className = 'artifact-meta';
      var label = art.label ? art.label + ' · ' : '';
      setText(meta, label + (art.type || 'artifact'));
      body.appendChild(name);
      body.appendChild(meta);
      li.appendChild(body);
      artsEl.appendChild(li);
    }
  }

  function artifactIcon(art) {
    var path = art && art.path ? art.path : '';
    if (path.endsWith('.json')) return '{}';
    if (path.endsWith('.log')) return '▤';
    if (path.endsWith('.md')) return '☷';
    return '□';
  }

  function basename(path) {
    if (!path) return '—';
    var parts = path.split('/');
    return parts[parts.length - 1] || path;
  }

  function renderLiveOutput(events) {
    if (!liveOutEl) return;
    var atBottom = liveOutEl.scrollTop + liveOutEl.clientHeight >= liveOutEl.scrollHeight - 32;
    while (liveOutEl.firstChild) liveOutEl.removeChild(liveOutEl.firstChild);

    var lines = [];
    var evs = Array.isArray(events) ? events : [];
    for (var i = 0; i < evs.length; i++) {
      var ev = evs[i];
      if (!ev || ev.kind !== 'role.output') continue;
      if (currentFilter !== 'all') {
        var roleKey = (ev.role || '').toLowerCase().trim();
        if (currentFilter === 'verifying') {
          if (roleKey !== 'auditor' && roleKey !== 'developer') continue;
        } else if (roleKey !== currentFilter) {
          continue;
        }
      }
      var text = (ev.payload && typeof ev.payload.text === 'string') ? ev.payload.text : (ev.message || '');
      lines.push({ ts: ev.ts, role: ev.role || '', text: text });
    }
    if (lines.length > LIVE_OUTPUT_MAX_LINES) {
      lines = lines.slice(lines.length - LIVE_OUTPUT_MAX_LINES);
    }

    for (var k = 0; k < lines.length; k++) {
      var div = document.createElement('div');
      var line = '[' + formatLocalTime(lines[k].ts) + '] ' + labelRole(lines[k].role) + ': ' + lines[k].text;
      div.appendChild(document.createTextNode(line));
      liveOutEl.appendChild(div);
    }

    if (atBottom) {
      liveOutEl.scrollTop = liveOutEl.scrollHeight;
    }
  }

  function onCancelClick() {
    if (cancelInFlight || cancelBtn.disabled) return;
    cancelInFlight = true;
    setText(cancelErr, '');
    cancelBtn.disabled = true;
    setText(cancelBtn, '取消中…');
    fetch('/api/cancel', { method: 'POST', cache: 'no-store' })
      .then(function (r) {
        if (r.status >= 200 && r.status < 300) {
          return null;
        }
        return r.text().then(function (txt) {
          var message = '取消失败 (HTTP ' + r.status + ')';
          try {
            var parsed = JSON.parse(txt);
            if (parsed && typeof parsed.message === 'string') {
              message = parsed.message;
            }
          } catch (e) {
            if (txt) message = txt;
          }
          throw new Error(message);
        });
      })
      .catch(function (err) {
        cancelInFlight = false;
        setText(cancelErr, err && err.message ? err.message : '取消失败');
        cancelBtn.disabled = false;
        setText(cancelBtn, '取消运行');
      });
  }

  cancelBtn.addEventListener('click', onCancelClick);

  // Filter tabs
  var filterTabs = document.querySelectorAll('.filter-tab');
  for (var ft = 0; ft < filterTabs.length; ft++) {
    (function(tab) {
      tab.addEventListener('click', function() {
        for (var t = 0; t < filterTabs.length; t++) {
          filterTabs[t].classList.remove('active');
        }
        tab.classList.add('active');
        currentFilter = tab.getAttribute('data-filter');
        // Re-render live output with new filter
        // We need to re-fetch or use cached events; for simplicity, trigger a fetch
        if (selectedIsActive) {
          fetchActiveSnapshot();
        } else if (selectedRunId) {
          fetchArchivedSnapshot(selectedRunId);
        }
      });
    })(filterTabs[ft]);
  }

  function fetchActiveSnapshot() {
    fetch('/api/events', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (snapshot) {
        updateConnectionStatus(true);
        render(snapshot);
      })
      .catch(function () {
        updateConnectionStatus(false);
        setText(updatedEl, '获取失败 ' + new Date().toLocaleTimeString('zh-CN'));
      });
  }

  function fetchArchivedSnapshot(runId) {
    fetch('/api/events?run_id=' + encodeURIComponent(runId), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (snapshot) {
        updateConnectionStatus(true);
        render(snapshot);
      })
      .catch(function () {
        updateConnectionStatus(false);
        setText(updatedEl, '获取失败 ' + new Date().toLocaleTimeString('zh-CN'));
      });
  }

  // 'idle' before start, 'sse' when EventSource is live, 'poll' otherwise.
  var mode = 'idle';
  var pollTimer = null;
  var es = null;

  function startPolling() {
    if (mode === 'poll') return;
    stopSse();
    mode = 'poll';
    if (pollTimer == null) {
      pollTimer = setInterval(fetchActiveSnapshot, 2000);
    }
  }

  function stopPolling() {
    if (pollTimer != null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function stopSse() {
    if (es != null) {
      try { es.close(); } catch (e) { /* ignore */ }
      es = null;
    }
  }

  function startSse() {
    if (typeof EventSource !== 'function') {
      startPolling();
      return;
    }
    try {
      es = new EventSource('/api/events/stream');
    } catch (e) {
      es = null;
      startPolling();
      return;
    }
    mode = 'sse';
    stopPolling();
    es.addEventListener('hello', function () {
      setText(updatedEl, new Date().toLocaleTimeString('zh-CN'));
      fetchActiveSnapshot();
    });
    es.onmessage = function () {
      fetchActiveSnapshot();
    };
    es.onerror = function () {
      stopSse();
      mode = 'idle';
      startPolling();
    };
  }

  function switchToActive() {
    selectedIsActive = true;
    startSse();
    fetchActiveSnapshot();
  }

  function switchToArchived(runId) {
    selectedIsActive = false;
    stopSse();
    stopPolling();
    mode = 'idle';
    fetchArchivedSnapshot(runId);
  }

  function populateRunSelect(listing) {
    var runs = Array.isArray(listing.runs) ? listing.runs : [];
    activeRunId = typeof listing.active_run_id === 'string' ? listing.active_run_id : null;

    var previous = selectedRunId;

    while (runSelectEl.firstChild) runSelectEl.removeChild(runSelectEl.firstChild);
    var foundPrevious = false;
    var defaultRunId = null;
    for (var i = 0; i < runs.length; i++) {
      var r = runs[i];
      var opt = document.createElement('option');
      opt.value = r.run_id;
      var label = (r.display_title || r.run_id) + ' · ' + (r.friendly_time || '—') + ' · ' + labelPhase(r.phase || 'unknown');
      opt.appendChild(document.createTextNode(label));
      runSelectEl.appendChild(opt);
      if (r.run_id === previous) foundPrevious = true;
      if (r.is_active) defaultRunId = r.run_id;
    }

    if (defaultRunId == null && runs.length > 0) {
      defaultRunId = runs[runs.length - 1].run_id;
    }

    var nextSelection = foundPrevious ? previous : defaultRunId;
    if (nextSelection != null) {
      runSelectEl.value = nextSelection;
    }

    if (selectedRunId !== nextSelection) {
      selectedRunId = nextSelection;
      if (selectedRunId != null) {
        if (selectedRunId === activeRunId) {
          switchToActive();
        } else {
          switchToArchived(selectedRunId);
        }
      } else {
        selectedIsActive = true;
        fetchActiveSnapshot();
      }
    }
  }

  function refreshRuns() {
    fetch('/api/runs', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(populateRunSelect)
      .catch(function () { /* ignore listing failures */ });
  }

  runSelectEl.addEventListener('change', function () {
    var runId = runSelectEl.value;
    selectedRunId = runId;
    if (runId === activeRunId) {
      switchToActive();
    } else {
      switchToArchived(runId);
    }
  });

  refreshRuns();
  setInterval(refreshRuns, 15000);
})();
</script>
</body>
</html>
`;

export function renderDashboardHtml(): string {
  return HTML;
}
