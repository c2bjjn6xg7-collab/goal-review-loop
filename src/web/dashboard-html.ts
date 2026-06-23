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
  'run.ended': '运行结束',
  'phase.changed': '阶段切换',
  'role.started': '角色开始',
  'role.output': '角色输出',
  'role.heartbeat': '心跳',
  'role.exited': '角色退出',
  'role.error': '角色错误',
  'tool.called': '工具调用',
  'tool.result': '工具结果',
  'artifact.created': '产物创建',
  'artifact.updated': '产物更新',
  'comment.added': '评论添加',
  'iteration.completed': '迭代完成',
  'iteration.started': '迭代开始',
};

const PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
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
  if (hours > 0) return `${hours}时 ${String(minutes % 60).padStart(2, '0')}分`;
  if (minutes > 0) return `${minutes}分 ${String(seconds % 60).padStart(2, '0')}秒`;
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
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; margin: 0; padding: 1.5rem; }
  header { display: flex; flex-wrap: wrap; gap: 1rem; align-items: center; margin-bottom: 1.5rem; padding-bottom: 1rem; border-bottom: 1px solid #ccc4; }
  header h1 { font-size: 1.25rem; margin: 0; }
  .pill { padding: 0.15rem 0.6rem; border-radius: 999px; background: #eef; font-size: 0.85rem; }
  .pill.completed { background: #d4edda; color: #155724; }
  .pill.active { background: #fff3cd; color: #856404; }
  .pill.waiting { background: #e2e3e5; color: #383d41; }
  section { margin-bottom: 1.5rem; }
  h2 { font-size: 1rem; margin: 0 0 0.5rem 0; }
  .card { border: 1px solid #ccc4; border-radius: 0.5rem; padding: 1rem; background: #fafafa; }
  .card-row { display: flex; flex-wrap: wrap; gap: 1rem; margin-bottom: 0.5rem; }
  .card-row:last-child { margin-bottom: 0; }
  .card-label { color: #666; font-size: 0.8rem; min-width: 4rem; }
  .card-value { font-weight: 500; font-size: 0.9rem; }
  .muted { color: #888; font-size: 0.8rem; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  #run-select { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85rem; min-width: 12rem; }
  #cancel-btn { padding: 0.25rem 0.75rem; font-size: 0.85rem; }
  #cancel-btn[disabled] { opacity: 0.6; cursor: not-allowed; }
  #cancel-error { color: #b00; font-size: 0.8rem; }
  #connection-status { font-size: 0.8rem; display: flex; align-items: center; gap: 0.3rem; }
  #connection-status .dot { width: 0.5rem; height: 0.5rem; border-radius: 50%; display: inline-block; }
  #connection-status .dot.connected { background: #28a745; }
  #connection-status .dot.disconnected { background: #dc3545; }
  #connection-status .dot.connecting { background: #ffc107; }
  .stage-bar { display: flex; gap: 0.25rem; margin: 0.5rem 0; }
  .stage-item { flex: 1; text-align: center; padding: 0.4rem 0.2rem; border-radius: 0.25rem; font-size: 0.8rem; }
  .stage-item.completed { background: #d4edda; color: #155724; }
  .stage-item.active { background: #fff3cd; color: #856404; font-weight: 600; }
  .stage-item.waiting { background: #e2e3e5; color: #383d41; }
  .agent-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: 0.75rem; }
  .agent-card { border: 1px solid #ccc4; border-radius: 0.4rem; padding: 0.75rem; }
  .agent-card .agent-name { font-weight: 600; font-size: 0.85rem; margin-bottom: 0.25rem; }
  .agent-card .agent-meta { font-size: 0.75rem; color: #666; }
  .agent-status-badge { display: inline-block; padding: 0.1rem 0.4rem; border-radius: 999px; font-size: 0.75rem; margin-left: 0.25rem; }
  .agent-status-badge.waiting { background: #e2e3e5; color: #383d41; }
  .agent-status-badge.running { background: #fff3cd; color: #856404; }
  .agent-status-badge.completed { background: #d4edda; color: #155724; }
  .agent-status-badge.failed { background: #f8d7da; color: #721c24; }
  .agent-status-badge.blocked { background: #f8d7da; color: #721c24; }
  .agent-status-badge.cancelled { background: #e2e3e5; color: #383d41; }
  .next-step-card { border: 1px solid #b8daff; border-radius: 0.4rem; padding: 0.75rem; background: #f0f8ff; }
  .next-step-card h3 { font-size: 0.9rem; margin: 0 0 0.5rem 0; }
  .checklist { list-style: none; padding: 0; margin: 0; }
  .checklist li { padding: 0.25rem 0; font-size: 0.85rem; }
  .checklist li::before { content: "☐ "; margin-right: 0.3rem; }
  .checklist li.done::before { content: "☑ "; }
  #timeline-list { list-style: none; padding: 0; margin: 0; }
  #timeline-list li { padding: 0.5rem 0; border-bottom: 1px solid #eee; display: flex; gap: 0.75rem; align-items: flex-start; }
  #timeline-list li:last-child { border-bottom: none; }
  .timeline-time { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.75rem; color: #888; min-width: 5rem; padding-top: 0.15rem; }
  .timeline-badge { padding: 0.1rem 0.4rem; border-radius: 0.25rem; font-size: 0.75rem; white-space: nowrap; }
  .timeline-badge.run { background: #d4edda; color: #155724; }
  .timeline-badge.phase { background: #cce5ff; color: #004085; }
  .timeline-badge.role { background: #e2e3e5; color: #383d41; }
  .timeline-badge.output { background: #fff3cd; color: #856404; }
  .timeline-badge.error { background: #f8d7da; color: #721c24; }
  .timeline-badge.artifact { background: #d1ecf1; color: #0c5460; }
  .timeline-text { font-size: 0.85rem; flex: 1; }
  #live-output { max-height: 16rem; overflow: auto; padding: 0.5rem; background: #f6f6f6; border: 1px solid #ccc4; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8rem; white-space: pre-wrap; }
  #live-output div { white-space: pre-wrap; }
  .filter-tabs { display: flex; gap: 0.25rem; margin-bottom: 0.5rem; }
  .filter-tab { padding: 0.2rem 0.6rem; border: 1px solid #ccc4; border-radius: 0.25rem; font-size: 0.8rem; cursor: pointer; background: #fff; }
  .filter-tab.active { background: #007bff; color: #fff; border-color: #007bff; }
  #artifacts-list { list-style: none; padding: 0; margin: 0; }
  #artifacts-list li { padding: 0.3rem 0; font-size: 0.85rem; }
  #artifacts-list li.important { font-weight: 500; }
</style>
</head>
<body>
<div id="dashboard-app">
<header>
  <h1>Review-Loop 控制台</h1>
  <div>
    <select id="run-select"></select>
    <span id="connection-status"><span class="dot connecting"></span>连接中</span>
    <button id="cancel-btn" type="button" disabled>取消运行</button>
  </div>
  <div class="muted">更新于: <span id="updated-at">—</span></div>
  <div id="cancel-error" role="alert"></div>
</header>

<!-- Current Status Summary Card -->
<section>
  <h2>当前状态</h2>
  <div class="card">
    <div class="card-row">
      <div><span class="card-label">标题</span> <span id="current-title" class="card-value">—</span></div>
      <div><span class="card-label">阶段</span> <span id="current-phase-label" class="pill">—</span></div>
      <div><span class="card-label">角色</span> <span id="current-role-label" class="card-value">—</span></div>
    </div>
    <div class="card-row">
      <div><span class="card-label">模型</span> <span id="current-model-label" class="card-value">—</span></div>
      <div><span class="card-label">迭代</span> <span id="current-iteration-label" class="card-value">—</span></div>
      <div><span class="card-label">耗时</span> <span id="current-elapsed-label" class="card-value">—</span></div>
    </div>
    <div class="card-row">
      <div><span class="card-label">事件</span> <span id="current-event-label" class="card-value">—</span></div>
    </div>
  </div>
</section>

<!-- Stage Progress Bar -->
<section>
  <h2>阶段进度</h2>
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

<!-- Agent Status Panel -->
<section>
  <h2>代理状态</h2>
  <div id="agent-status-list" class="agent-list">
    <div class="agent-card" data-role="planner">
      <div class="agent-name">规划师 Planner <span class="agent-status-badge waiting">等待中</span></div>
      <div class="agent-meta">—</div>
    </div>
    <div class="agent-card" data-role="developer">
      <div class="agent-name">开发者 Developer <span class="agent-status-badge waiting">等待中</span></div>
      <div class="agent-meta">—</div>
    </div>
    <div class="agent-card" data-role="auditor">
      <div class="agent-name">审计员 Auditor <span class="agent-status-badge waiting">等待中</span></div>
      <div class="agent-meta">—</div>
    </div>
    <div class="agent-card" data-role="final_auditor">
      <div class="agent-name">最终复核 Final Auditor <span class="agent-status-badge waiting">等待中</span></div>
      <div class="agent-meta">—</div>
    </div>
  </div>
</section>

<!-- Next Step Card -->
<section>
  <h2>下一步</h2>
  <div id="next-step" class="next-step-card">
    <h3 id="next-step-title">准备就绪</h3>
    <ul class="checklist" id="next-step-checklist">
      <li id="check-generate">生成修改</li>
      <li id="check-validate">本地验证</li>
      <li id="check-audit">审计员 Auditor 审计</li>
      <li id="check-final">最终复核 Final Auditor 复核</li>
      <li id="check-write">写入最终结果</li>
    </ul>
  </div>
</section>

<!-- Event Timeline -->
<section>
  <h2>事件时间线</h2>
  <ul id="timeline-list"></ul>
  <p id="timeline-empty" class="muted" hidden>暂无事件。</p>
</section>

<!-- Live Output -->
<section>
  <h2>实时输出</h2>
  <div class="filter-tabs">
    <button class="filter-tab active" data-filter="all">全部</button>
    <button class="filter-tab" data-filter="planner">规划师 Planner</button>
    <button class="filter-tab" data-filter="developer">开发者 Developer</button>
    <button class="filter-tab" data-filter="auditor">审计员 Auditor</button>
    <button class="filter-tab" data-filter="verifying">验证</button>
  </div>
  <pre id="live-output" aria-live="polite"></pre>
</section>

<!-- Artifacts -->
<section>
  <h2>运行产物</h2>
  <ul id="artifacts-list"></ul>
  <p id="artifacts-empty" class="muted" hidden>暂无运行产物。</p>
</section>
</div>

<script>
(function () {
  // ── Label maps (embedded as JSON for the browser) ──────────────────────
  var LABEL_PHASE = ${JSON.stringify(PHASE_LABELS)};
  var LABEL_ROLE = ${JSON.stringify(ROLE_LABELS)};
  var LABEL_EVENT_KIND = ${JSON.stringify(EVENT_KIND_LABELS)};
  var LABEL_PROVIDER = ${JSON.stringify(PROVIDER_LABELS)};

  var runSelectEl = document.getElementById('run-select');
  var connectionStatusEl = document.getElementById('connection-status');
  var updatedEl = document.getElementById('updated-at');
  var cancelBtn = document.getElementById('cancel-btn');
  var cancelErr = document.getElementById('cancel-error');
  var currentTitleEl = document.getElementById('current-title');
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
  var nextStepChecklistEl = document.getElementById('next-step-checklist');
  var timelineListEl = document.getElementById('timeline-list');
  var timelineEmpty = document.getElementById('timeline-empty');
  var liveOutEl = document.getElementById('live-output');
  var artsEl = document.getElementById('artifacts-list');
  var artsEmpty = document.getElementById('artifacts-empty');

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
    if (hours > 0) return hours + '时 ' + String(minutes % 60).padStart(2, '0') + '分';
    if (minutes > 0) return minutes + '分 ' + String(seconds % 60).padStart(2, '0') + '秒';
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
      setText(connectionStatusEl, '已连接');
      connectionStatusEl.insertBefore(dot, connectionStatusEl.firstChild);
    } else {
      dot.className = 'dot disconnected';
      setText(connectionStatusEl, '已断开');
      connectionStatusEl.insertBefore(dot, connectionStatusEl.firstChild);
    }
  }

  function renderStageProgress(activeStage) {
    var stages = ['initializing', 'planning', 'developing', 'verifying', 'auditing', 'final_auditing', 'complete'];
    var activeIndex = stages.indexOf(activeStage);
    var items = stageProgressEl.querySelectorAll('.stage-item');
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var stage = item.getAttribute('data-stage');
      item.classList.remove('completed', 'active', 'waiting');
      if (i < activeIndex) {
        item.classList.add('completed');
      } else if (i === activeIndex) {
        item.classList.add('active');
      } else {
        item.classList.add('waiting');
      }
      if (stage === 'complete' && (activeStage === 'complete' || activeStage === 'failed' || activeStage === 'cancelled' || activeStage === 'blocked')) {
        item.classList.remove('waiting');
        item.classList.add('completed');
      }
    }
  }

  function renderAgentStatus(snapshot) {
    var roles = ['planner', 'developer', 'auditor', 'final_auditor'];
    var uiSummary = snapshot.ui_summary || {};
    var roleStatuses = uiSummary.roles || [];
    var cards = agentStatusListEl.querySelectorAll('.agent-card');
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var roleKey = card.getAttribute('data-role');
      var nameEl = card.querySelector('.agent-name');
      var metaEl = card.querySelector('.agent-meta');
      var statusEl = nameEl.querySelector('.agent-status-badge');

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
        var provider = labelProvider(roleData.provider);
        var model = roleData.model || '—';
        var dur = roleData.duration_ms != null ? formatDuration(roleData.duration_ms) : '—';
        setText(metaEl, provider + ' / ' + model + ' | ' + dur);
      } else {
        setText(statusEl, '等待中');
        statusEl.className = 'agent-status-badge waiting';
        setText(metaEl, '—');
      }
    }
  }

  function renderNextStep(snapshot) {
    var phase = snapshot.current_phase || 'unknown';
    var steps = {
      initializing: { title: '正在初始化', done: [] },
      planning: { title: '正在规划', done: [] },
      developing: { title: '正在开发', done: ['check-generate'] },
      verifying: { title: '正在验证', done: ['check-generate', 'check-validate'] },
      auditing: { title: '正在审计', done: ['check-generate', 'check-validate', 'check-audit'] },
      final_auditing: { title: '正在最终复核', done: ['check-generate', 'check-validate', 'check-audit', 'check-final'] },
      complete: { title: '已完成', done: ['check-generate', 'check-validate', 'check-audit', 'check-final', 'check-write'] },
      blocked: { title: '已阻塞', done: [] },
      failed: { title: '失败', done: [] },
      cancelled: { title: '已取消', done: [] },
      unknown: { title: '准备就绪', done: [] },
    };
    var step = steps[phase] || steps.unknown;
    setText(nextStepTitleEl, step.title);
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
    var evs = Array.isArray(events) ? events : [];
    timelineEmpty.hidden = evs.length !== 0;
    for (var i = 0; i < evs.length; i++) {
      var ev = evs[i];
      if (!ev) continue;
      var li = document.createElement('li');
      var timeSpan = document.createElement('span');
      timeSpan.className = 'timeline-time';
      setText(timeSpan, formatLocalTime(ev.ts));
      li.appendChild(timeSpan);

      var badge = document.createElement('span');
      badge.className = 'timeline-badge';
      var badgeClass = 'output';
      if (ev.kind && ev.kind.startsWith('run.')) badgeClass = 'run';
      else if (ev.kind && ev.kind.startsWith('phase.')) badgeClass = 'phase';
      else if (ev.kind && ev.kind.startsWith('role.')) badgeClass = 'role';
      else if (ev.kind && ev.kind.startsWith('artifact.')) badgeClass = 'artifact';
      else if (ev.kind && ev.kind.includes('error')) badgeClass = 'error';
      badge.classList.add(badgeClass);
      setText(badge, labelEventKind(ev.kind));
      li.appendChild(badge);

      var textSpan = document.createElement('span');
      textSpan.className = 'timeline-text';
      var msg = (ev.message || '');
      if (ev.role) msg = '[' + labelRole(ev.role) + '] ' + msg;
      setText(textSpan, msg);
      li.appendChild(textSpan);

      timelineListEl.appendChild(li);
    }
  }

  function render(snapshot) {
    var uiSummary = snapshot.ui_summary || {};
    var displayTitle = uiSummary.display_title || snapshot.run_id || '—';
    setText(currentTitleEl, displayTitle);
    setText(currentPhaseLabelEl, labelPhase(uiSummary.active_stage || snapshot.current_phase));
    setText(currentRoleLabelEl, labelRole(uiSummary.active_role));
    setText(currentModelLabelEl, (uiSummary.active_model || '—'));
    setText(currentIterationLabelEl, (uiSummary.iteration != null ? uiSummary.iteration + '/' + (uiSummary.max_iterations || '—') : '—'));
    setText(currentElapsedLabelEl, formatDuration(uiSummary.elapsed_ms));
    setText(currentEventLabelEl, labelEventKind(uiSummary.last_event_kind) + (uiSummary.last_event_label ? ' — ' + uiSummary.last_event_label : ''));

    renderCancelButton(snapshot.current_phase);
    renderStageProgress(uiSummary.active_stage || snapshot.current_phase);
    renderAgentStatus(snapshot);
    renderNextStep(snapshot);
    renderTimeline(snapshot.latest_events);
    renderLiveOutput(snapshot.latest_events);
    renderArtifacts(snapshot.artifacts);
    setText(updatedEl, new Date().toLocaleTimeString('zh-CN'));
  }

  function renderArtifacts(artifacts) {
    while (artsEl.firstChild) artsEl.removeChild(artsEl.firstChild);
    var arts = Array.isArray(artifacts) ? artifacts : [];
    artsEmpty.hidden = arts.length !== 0;
    var important = ['plan.md', 'GOAL.md', 'verification.log', 'audit-report.md', 'final-audit.md', 'state.json'];
    for (var i = 0; i < arts.length; i++) {
      var art = arts[i];
      var li = document.createElement('li');
      var isImportant = false;
      for (var j = 0; j < important.length; j++) {
        if (art.path && art.path.endsWith(important[j])) {
          isImportant = true;
          break;
        }
      }
      if (isImportant) li.classList.add('important');
      var label = art.label ? art.label + ' — ' : '';
      li.appendChild(document.createTextNode('[' + (art.type || '') + '] ' + label + (art.path || '')));
      artsEl.appendChild(li);
    }
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
      var label = (r.display_title || r.run_id) + ' (' + (r.friendly_time || '—') + ') [' + (r.phase || '—') + ']';
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
