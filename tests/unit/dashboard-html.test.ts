import { describe, it, expect } from 'vitest';
import { renderDashboardHtml } from '../../src/web/dashboard-html.js';

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
});
