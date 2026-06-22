import { describe, it, expect } from 'vitest';
import {
  renderDashboardHtml,
  getLiveOutputLines,
  getHeartbeatIndicator,
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

  it('exposes anchors for the dynamic fields', () => {
    expect(html).toContain('id="run-id"');
    expect(html).toContain('id="current-phase"');
    expect(html).toContain('id="events-body"');
    expect(html).toContain('id="artifacts-list"');
  });

  it('returns the same content on repeated calls', () => {
    expect(renderDashboardHtml()).toBe(html);
  });

  it('renders the cancel button with all label states', () => {
    expect(html).toContain('cancel-btn');
    expect(html).toContain('Cancel Run');
    expect(html).toContain('Cancelling');
    expect(html).toContain('Run ended');
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
    expect(html).toContain('Live Output');
    expect(html).toContain('<pre id="live-output"');
    expect(html).toContain('aria-live="polite"');
  });

  it('inline render script filters role.output events from latest_events', () => {
    expect(html).toContain("role.output");
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
