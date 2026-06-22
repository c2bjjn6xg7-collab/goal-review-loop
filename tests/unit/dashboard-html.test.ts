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
});
