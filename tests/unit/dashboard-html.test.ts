import { describe, it, expect } from 'vitest';
import {
  renderDashboardHtml,
  getLiveOutputLines,
  getHeartbeatIndicator,
  labelPhase,
  labelRole,
  labelEventKind,
  labelProvider,
  formatDuration,
  formatLocalTime,
  deriveDisplayTitle,
} from '../../src/web/dashboard-html.js';
import type { ReviewLoopEvent } from '../../src/runtime/event-store.js';

function makeEvent(over: Partial<ReviewLoopEvent> & { kind: ReviewLoopEvent['kind'] }): ReviewLoopEvent {
  return {
    schema_version: 1 as never,
    run_id: 'r1',
    seq: 0,
    event_id: 'e',
    ts: new Date(0).toISOString(),
    phase: 'DEVELOPING',
    level: 'info',
    message: '',
    ...over,
  };
}

describe('renderDashboardHtml', () => {
  const html = renderDashboardHtml();

  it('starts with a DOCTYPE and html tag', () => {
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<html');
    expect(html).toContain('</html>');
  });

  it('sets lang="zh-CN" on the html tag', () => {
    expect(html).toContain('<html lang="zh-CN">');
  });

  it('polls /api/events every 2000ms', () => {
    expect(html).toContain("fetch('/api/events'");
    expect(html).toContain('setInterval');
    expect(html).toContain('2000');
  });

  it('prefers EventSource for /api/events/stream and falls back to polling', () => {
    expect(html).toContain("new EventSource('/api/events/stream')");
    expect(html).toContain("typeof EventSource");
    expect(html).toContain('onerror');
    expect(html).toContain('startPolling');
  });

  it('uses textContent / createTextNode to avoid XSS injection', () => {
    expect(html).toContain('textContent');
    expect(html).toContain('createTextNode');
    expect(html).not.toContain('innerHTML');
  });

  it('contains all required DOM anchors', () => {
    expect(html).toContain('id="dashboard-app"');
    expect(html).toContain('id="run-select"');
    expect(html).toContain('id="connection-status"');
    expect(html).toContain('id="updated-at"');
    expect(html).toContain('id="cancel-btn"');
    expect(html).toContain('id="current-title"');
    expect(html).toContain('id="current-phase-label"');
    expect(html).toContain('id="current-role-label"');
    expect(html).toContain('id="current-model-label"');
    expect(html).toContain('id="current-iteration-label"');
    expect(html).toContain('id="current-elapsed-label"');
    expect(html).toContain('id="current-event-label"');
    expect(html).toContain('id="stage-progress"');
    expect(html).toContain('id="agent-status-list"');
    expect(html).toContain('id="next-step"');
    expect(html).toContain('id="timeline-list"');
    expect(html).toContain('id="live-output"');
    expect(html).toContain('id="artifacts-list"');
  });

  it('renders the cancel button with Chinese label states', () => {
    expect(html).toContain('cancel-btn');
    expect(html).toContain('取消运行');
    expect(html).toContain('取消中');
    expect(html).toContain('运行已结束');
  });

  it('posts to /api/cancel from the cancel handler', () => {
    expect(html).toContain("fetch('/api/cancel'");
    expect(html).toContain("method: 'POST'");
  });

  it('renders a <select id="run-select"> for the historical run browser', () => {
    expect(html).toContain('<select id="run-select"');
  });

  it('fetches /api/runs to populate the run selector', () => {
    expect(html).toContain("fetch('/api/runs'");
  });

  it("fetches per-run snapshots via /api/events?run_id=", () => {
    expect(html).toContain("'/api/events?run_id=' +");
  });

  it('refreshes the run list every 15 seconds', () => {
    expect(html).toContain('15000');
  });

  it('renders a Live Output section with a <pre id="live-output" aria-live="polite"> anchor', () => {
    expect(html).toContain('实时输出');
    expect(html).toContain('<pre id="live-output"');
    expect(html).toContain('aria-live="polite"');
  });

  it('renders Chinese filter tabs for live output', () => {
    expect(html).toContain('全部');
    expect(html).toContain('规划师 Planner');
    expect(html).toContain('开发者 Developer');
    expect(html).toContain('审计员 Auditor');
    expect(html).toContain('验证');
  });

  it('renders the stage progress bar with correct Chinese labels', () => {
    expect(html).toContain('阶段进度');
    expect(html).toContain('初始化');
    expect(html).toContain('规划');
    expect(html).toContain('开发');
    expect(html).toContain('验证');
    expect(html).toContain('审计');
    expect(html).toContain('最终复核');
    expect(html).toContain('完成');
  });

  it('renders the agent status panel with 4 agents and Chinese labels', () => {
    expect(html).toContain('代理状态');
    expect(html).toContain('规划师 Planner');
    expect(html).toContain('开发者 Developer');
    expect(html).toContain('审计员 Auditor');
    expect(html).toContain('最终复核 Final Auditor');
  });

  it('renders the next-step card with checklist items', () => {
    expect(html).toContain('下一步');
    expect(html).toContain('生成修改');
    expect(html).toContain('本地验证');
    expect(html).toContain('审计员 Auditor 审计');
    expect(html).toContain('最终复核 Final Auditor 复核');
    expect(html).toContain('写入最终结果');
  });

  it('renders the event timeline section', () => {
    expect(html).toContain('事件时间线');
    expect(html).toContain('id="timeline-list"');
  });

  it('renders artifacts section as 运行产物', () => {
    expect(html).toContain('运行产物');
    expect(html).toContain('id="artifacts-list"');
  });

  it('renders current status summary card', () => {
    expect(html).toContain('当前状态');
    expect(html).toContain('id="current-title"');
    expect(html).toContain('id="current-phase-label"');
    expect(html).toContain('id="current-role-label"');
    expect(html).toContain('id="current-model-label"');
    expect(html).toContain('id="current-iteration-label"');
    expect(html).toContain('id="current-elapsed-label"');
    expect(html).toContain('id="current-event-label"');
  });

  it('contains connection status indicator', () => {
    expect(html).toContain('id="connection-status"');
    expect(html).toContain('已连接');
    expect(html).toContain('已断开');
  });

  it('includes label maps embedded as JSON constants', () => {
    expect(html).toContain('LABEL_PHASE');
    expect(html).toContain('LABEL_ROLE');
    expect(html).toContain('LABEL_EVENT_KIND');
    expect(html).toContain('LABEL_PROVIDER');
  });

  it('returns the same content on repeated calls', () => {
    expect(renderDashboardHtml()).toBe(html);
  });

  it('inline render script filters role.output events from latest_events', () => {
    expect(html).toContain('role.output');
    expect(html).toContain('live-output');
  });
});

describe('getLiveOutputLines', () => {
  it('returns only role.output events formatted as [ts] role: text', () => {
    const events: ReviewLoopEvent[] = [
      makeEvent({ kind: 'role.started', role: 'developer', ts: '2026-06-22T00:00:00.000Z', message: 'started' }),
      makeEvent({ kind: 'role.output', role: 'developer', ts: '2026-06-22T00:00:01.000Z', message: 'Editing src/foo.ts', payload: { text: 'Editing src/foo.ts' } }),
      makeEvent({ kind: 'role.heartbeat', role: 'developer', ts: '2026-06-22T00:00:02.000Z', message: 'still running' }),
      makeEvent({ kind: 'role.output', role: 'planner', ts: '2026-06-22T00:00:03.000Z', message: 'Planning', payload: { text: 'Planning the work' } }),
    ];
    const lines = getLiveOutputLines(events);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ ts: '2026-06-22T00:00:01.000Z', role: 'developer', text: 'Editing src/foo.ts' });
    expect(lines[1]).toEqual({ ts: '2026-06-22T00:00:03.000Z', role: 'planner', text: 'Planning the work' });
  });

  it('falls back to message when payload.text is missing', () => {
    const events: ReviewLoopEvent[] = [
      makeEvent({ kind: 'role.output', role: 'developer', ts: '2026-06-22T00:00:01.000Z', message: 'fallback message' }),
    ];
    const lines = getLiveOutputLines(events);
    expect(lines[0].text).toBe('fallback message');
  });

  it('enforces a 500-line FIFO cap when 600 role.output events are present', () => {
    const events: ReviewLoopEvent[] = [];
    for (let i = 0; i < 600; i++) {
      events.push(makeEvent({
        kind: 'role.output',
        role: 'developer',
        ts: new Date(i * 1000).toISOString(),
        seq: i + 1,
        message: `line ${i}`,
        payload: { text: `line ${i}` },
      }));
    }
    const lines = getLiveOutputLines(events);
    expect(lines).toHaveLength(500);
    // FIFO: drop the oldest 100, keep the last 500
    expect(lines[0].text).toBe('line 100');
    expect(lines[499].text).toBe('line 599');
  });

  it('returns an empty array when there are no role.output events', () => {
    const events: ReviewLoopEvent[] = [
      makeEvent({ kind: 'role.started', role: 'developer' }),
      makeEvent({ kind: 'role.exited', role: 'developer' }),
    ];
    expect(getLiveOutputLines(events)).toEqual([]);
  });
});

describe('getHeartbeatIndicator', () => {
  const nowMs = new Date('2026-06-22T00:01:00.000Z').getTime();

  it('renders "Last heartbeat: Ns ago" when a recent heartbeat is present and no newer role.exited', () => {
    const events: ReviewLoopEvent[] = [
      makeEvent({ kind: 'role.started', role: 'developer', ts: '2026-06-22T00:00:00.000Z' }),
      makeEvent({ kind: 'role.heartbeat', role: 'developer', ts: '2026-06-22T00:00:50.000Z', message: 'still running' }),
    ];
    expect(getHeartbeatIndicator(events, 'developer', nowMs)).toBe('Last heartbeat: 10s ago');
  });

  it('returns null when a role.exited for the same role is newer than the heartbeat', () => {
    const events: ReviewLoopEvent[] = [
      makeEvent({ kind: 'role.started', role: 'developer', ts: '2026-06-22T00:00:00.000Z' }),
      makeEvent({ kind: 'role.heartbeat', role: 'developer', ts: '2026-06-22T00:00:50.000Z' }),
      makeEvent({ kind: 'role.exited', role: 'developer', ts: '2026-06-22T00:00:55.000Z' }),
    ];
    expect(getHeartbeatIndicator(events, 'developer', nowMs)).toBeNull();
  });

  it('returns null when there is no active role', () => {
    const events: ReviewLoopEvent[] = [
      makeEvent({ kind: 'role.heartbeat', role: 'developer', ts: '2026-06-22T00:00:50.000Z' }),
    ];
    expect(getHeartbeatIndicator(events, undefined, nowMs)).toBeNull();
  });

  it('returns null when no heartbeat exists for the active role', () => {
    const events: ReviewLoopEvent[] = [
      makeEvent({ kind: 'role.started', role: 'developer', ts: '2026-06-22T00:00:00.000Z' }),
    ];
    expect(getHeartbeatIndicator(events, 'developer', nowMs)).toBeNull();
  });

  it('ignores heartbeats for a different role', () => {
    const events: ReviewLoopEvent[] = [
      makeEvent({ kind: 'role.heartbeat', role: 'planner', ts: '2026-06-22T00:00:50.000Z' }),
    ];
    expect(getHeartbeatIndicator(events, 'developer', nowMs)).toBeNull();
  });
});

describe('labelPhase', () => {
  it('returns Chinese labels for known phases', () => {
    expect(labelPhase('initializing')).toBe('初始化');
    expect(labelPhase('planning')).toBe('规划中');
    expect(labelPhase('developing')).toBe('开发中');
    expect(labelPhase('verifying')).toBe('验证中');
    expect(labelPhase('auditing')).toBe('审计中');
    expect(labelPhase('final_auditing')).toBe('最终复核');
    expect(labelPhase('complete')).toBe('完成');
    expect(labelPhase('blocked')).toBe('已阻塞');
    expect(labelPhase('failed')).toBe('失败');
    expect(labelPhase('cancelled')).toBe('已取消');
    expect(labelPhase('unknown')).toBe('未知');
  });

  it('falls back to the raw value for unknown phases', () => {
    expect(labelPhase('custom_phase')).toBe('custom_phase');
  });

  it('returns "未知" for null/undefined', () => {
    expect(labelPhase(null)).toBe('未知');
    expect(labelPhase(undefined)).toBe('未知');
  });
});

describe('labelRole', () => {
  it('returns Chinese labels for known roles', () => {
    expect(labelRole('planner')).toBe('规划师 Planner');
    expect(labelRole('developer')).toBe('开发者 Developer');
    expect(labelRole('auditor')).toBe('审计员 Auditor');
    expect(labelRole('final auditor')).toBe('最终复核 Final Auditor');
    expect(labelRole('final_auditor')).toBe('最终复核 Final Auditor');
    expect(labelRole('final-auditor')).toBe('最终复核 Final Auditor');
  });

  it('is case-insensitive', () => {
    expect(labelRole('PLANNER')).toBe('规划师 Planner');
    expect(labelRole('Developer')).toBe('开发者 Developer');
  });

  it('falls back to raw value for unknown roles', () => {
    expect(labelRole('unknown_role')).toBe('unknown_role');
  });

  it('returns empty string for null/undefined', () => {
    expect(labelRole(null)).toBe('');
    expect(labelRole(undefined)).toBe('');
  });
});

describe('labelEventKind', () => {
  it('returns Chinese labels for known event kinds', () => {
    expect(labelEventKind('run.started')).toBe('运行开始');
    expect(labelEventKind('run.ended')).toBe('运行结束');
    expect(labelEventKind('phase.changed')).toBe('阶段切换');
    expect(labelEventKind('role.started')).toBe('角色开始');
    expect(labelEventKind('role.output')).toBe('角色输出');
    expect(labelEventKind('role.heartbeat')).toBe('心跳');
    expect(labelEventKind('role.exited')).toBe('角色退出');
    expect(labelEventKind('role.error')).toBe('角色错误');
    expect(labelEventKind('tool.called')).toBe('工具调用');
    expect(labelEventKind('tool.result')).toBe('工具结果');
    expect(labelEventKind('artifact.created')).toBe('产物创建');
    expect(labelEventKind('artifact.updated')).toBe('产物更新');
    expect(labelEventKind('comment.added')).toBe('评论添加');
    expect(labelEventKind('iteration.completed')).toBe('迭代完成');
    expect(labelEventKind('iteration.started')).toBe('迭代开始');
  });

  it('falls back to raw value for unknown event kinds', () => {
    expect(labelEventKind('custom.event')).toBe('custom.event');
  });

  it('returns empty string for null/undefined', () => {
    expect(labelEventKind(null)).toBe('');
    expect(labelEventKind(undefined)).toBe('');
  });
});

describe('labelProvider', () => {
  it('returns friendly labels for known providers', () => {
    expect(labelProvider('openai')).toBe('OpenAI');
    expect(labelProvider('anthropic')).toBe('Anthropic');
    expect(labelProvider('google')).toBe('Google');
    expect(labelProvider('local')).toBe('本地');
    expect(labelProvider('unknown')).toBe('未知');
  });

  it('is case-insensitive', () => {
    expect(labelProvider('OpenAI')).toBe('OpenAI');
    expect(labelProvider('ANTHROPIC')).toBe('Anthropic');
  });

  it('falls back to raw value for unknown providers', () => {
    expect(labelProvider('custom')).toBe('custom');
  });

  it('returns "未知" for null/undefined', () => {
    expect(labelProvider(null)).toBe('未知');
    expect(labelProvider(undefined)).toBe('未知');
  });
});

describe('formatDuration', () => {
  it('formats seconds correctly', () => {
    expect(formatDuration(5000)).toBe('5秒');
    expect(formatDuration(59000)).toBe('59秒');
  });

  it('formats minutes and seconds', () => {
    expect(formatDuration(65000)).toBe('1分 05秒');
    expect(formatDuration(125000)).toBe('2分 05秒');
  });

  it('formats hours and minutes', () => {
    expect(formatDuration(3661000)).toBe('1时 01分');
  });

  it('formats days and hours', () => {
    expect(formatDuration(90061000)).toBe('1天 01时');
  });

  it('returns "—" for null, undefined, or negative values', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(undefined)).toBe('—');
    expect(formatDuration(-1)).toBe('—');
  });
});

describe('formatLocalTime', () => {
  it('formats an ISO timestamp to HH:mm:ss', () => {
    const result = formatLocalTime('2026-06-22T12:34:56.000Z');
    // Result depends on timezone, but should match HH:mm:ss pattern
    expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it('returns "—" for null/undefined/empty', () => {
    expect(formatLocalTime(null)).toBe('—');
    expect(formatLocalTime(undefined)).toBe('—');
    expect(formatLocalTime('')).toBe('—');
  });

  it('returns "—" for invalid timestamps', () => {
    expect(formatLocalTime('not-a-date')).toBe('—');
  });
});

describe('deriveDisplayTitle', () => {
  it('prefers run.started message with prefix stripped', () => {
    const events: ReviewLoopEvent[] = [
      makeEvent({ kind: 'run.started', message: 'Run started: Fix the login bug' }),
    ];
    expect(deriveDisplayTitle(events, 'r1')).toBe('Fix the login bug');
  });

  it('strips Run started: with varying case', () => {
    const events: ReviewLoopEvent[] = [
      makeEvent({ kind: 'run.started', message: 'RUN STARTED: Some task' }),
    ];
    expect(deriveDisplayTitle(events, 'r1')).toBe('Some task');
  });

  it('falls back to payload.goal', () => {
    const events: ReviewLoopEvent[] = [
      makeEvent({ kind: 'phase.changed', payload: { goal: 'Refactor the auth module' } }),
    ];
    expect(deriveDisplayTitle(events, 'r1')).toBe('Refactor the auth module');
  });

  it('falls back to payload.task', () => {
    const events: ReviewLoopEvent[] = [
      makeEvent({ kind: 'phase.changed', payload: { task: 'Update tests' } }),
    ];
    expect(deriveDisplayTitle(events, 'r1')).toBe('Update tests');
  });

  it('falls back to first non-empty event message', () => {
    const events: ReviewLoopEvent[] = [
      makeEvent({ kind: 'phase.changed', message: 'Switched to planning' }),
    ];
    expect(deriveDisplayTitle(events, 'r1')).toBe('Switched to planning');
  });

  it('returns runId when no events', () => {
    expect(deriveDisplayTitle([], 'r1')).toBe('r1');
    expect(deriveDisplayTitle(null, 'r1')).toBe('r1');
  });

  it('truncates long titles to ~48 chars with ellipsis', () => {
    const longTitle = 'A'.repeat(60);
    const events: ReviewLoopEvent[] = [
      makeEvent({ kind: 'phase.changed', message: longTitle }),
    ];
    expect(deriveDisplayTitle(events, 'r1')).toBe('A'.repeat(48) + '…');
  });

  it('strips markdown headings from title', () => {
    const events: ReviewLoopEvent[] = [
      makeEvent({ kind: 'run.started', message: 'Run started: ## Important Task' }),
    ];
    expect(deriveDisplayTitle(events, 'r1')).toBe('Important Task');
  });

  it('collapses multiple spaces', () => {
    const events: ReviewLoopEvent[] = [
      makeEvent({ kind: 'run.started', message: 'Run started: Fix    the    bug' }),
    ];
    expect(deriveDisplayTitle(events, 'r1')).toBe('Fix the bug');
  });
});

describe('security invariants', () => {
  const html = renderDashboardHtml();

  it('never uses innerHTML for dynamic content', () => {
    expect(html).not.toContain('innerHTML');
  });

  it('always uses textContent or createTextNode', () => {
    expect(html).toContain('textContent');
    expect(html).toContain('createTextNode');
  });
});

describe('stage derivation', () => {
  const html = renderDashboardHtml();

  it('renders all 7 stage items in the progress bar', () => {
    expect(html).toContain('data-stage="initializing"');
    expect(html).toContain('data-stage="planning"');
    expect(html).toContain('data-stage="developing"');
    expect(html).toContain('data-stage="verifying"');
    expect(html).toContain('data-stage="auditing"');
    expect(html).toContain('data-stage="final_auditing"');
    expect(html).toContain('data-stage="complete"');
  });

  it('has CSS classes for completed, active, and waiting states', () => {
    expect(html).toContain('completed');
    expect(html).toContain('active');
    expect(html).toContain('waiting');
  });
});

describe('agent status derivation', () => {
  const html = renderDashboardHtml();

  it('always renders 4 agent cards', () => {
    const plannerMatches = html.match(/data-role="planner"/g);
    const devMatches = html.match(/data-role="developer"/g);
    const auditorMatches = html.match(/data-role="auditor"/g);
    const finalAuditorMatches = html.match(/data-role="final_auditor"/g);
    expect(plannerMatches).toHaveLength(1);
    expect(devMatches).toHaveLength(1);
    expect(auditorMatches).toHaveLength(1);
    expect(finalAuditorMatches).toHaveLength(1);
  });

  it('has status badge CSS classes for all statuses', () => {
    expect(html).toContain('agent-status-badge.waiting');
    expect(html).toContain('agent-status-badge.running');
    expect(html).toContain('agent-status-badge.completed');
    expect(html).toContain('agent-status-badge.failed');
    expect(html).toContain('agent-status-badge.blocked');
    expect(html).toContain('agent-status-badge.cancelled');
  });
});

describe('duration formatting edge cases', () => {
  it('handles exactly 0 ms', () => {
    expect(formatDuration(0)).toBe('0秒');
  });

  it('handles exactly 60 seconds', () => {
    expect(formatDuration(60000)).toBe('1分 00秒');
  });

  it('handles exactly 1 hour', () => {
    expect(formatDuration(3600000)).toBe('1时 00分');
  });

  it('handles exactly 1 day', () => {
    expect(formatDuration(86400000)).toBe('1天 00时');
  });
});
