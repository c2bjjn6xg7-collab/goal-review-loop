/**
 * Unit tests for src/runtime/output-filter.ts
 */
import { describe, it, expect } from 'vitest';
import { filterAgentOutput } from '../../src/runtime/output-filter.js';

describe('filterAgentOutput', () => {
  it('passes plain text through unchanged', () => {
    expect(filterAgentOutput('Editing src/foo.ts')).toBe('Editing src/foo.ts');
  });

  it('strips a single thinking block', () => {
    const input = '<thinking>hidden reasoning</thinking>Visible output';
    expect(filterAgentOutput(input)).toBe('Visible output');
  });

  it('strips an antThinking block', () => {
    const input = '<antThinking>secret plans</antThinking>Visible output';
    expect(filterAgentOutput(input)).toBe('Visible output');
  });

  it('strips thinking blocks across newlines', () => {
    const input = 'before\n<thinking>multi\nline\nreasoning</thinking>\nafter';
    expect(filterAgentOutput(input)).toBe('before\n\nafter');
  });

  it('strips JSON tool_use lines', () => {
    const input = 'Doing work\n{"type":"tool_use","name":"edit","input":{}}';
    expect(filterAgentOutput(input)).toBe('Doing work');
  });

  it('strips JSON tool_result lines', () => {
    const input = 'Doing work\n{"type":"tool_result","content":"x"}';
    expect(filterAgentOutput(input)).toBe('Doing work');
  });

  it('strips JSON tool lines even with leading whitespace', () => {
    const input = 'Doing work\n   {"type":"tool_use","name":"edit"}';
    expect(filterAgentOutput(input)).toBe('Doing work');
  });

  it('handles mixed thinking + visible text', () => {
    const input =
      '<thinking>plan</thinking>Step 1\n{"type":"tool_use","name":"x"}\nStep 2<antThinking>note</antThinking>';
    expect(filterAgentOutput(input)).toBe('Step 1\nStep 2');
  });

  it('truncates to 500 chars with trailing ellipsis when exceeded', () => {
    const input = 'a'.repeat(600);
    const result = filterAgentOutput(input);
    expect(result.length).toBe(501);
    expect(result.endsWith('…')).toBe(true);
    expect(result.slice(0, 500)).toBe('a'.repeat(500));
  });

  it('does not truncate at exactly 500 chars', () => {
    const input = 'a'.repeat(500);
    expect(filterAgentOutput(input)).toBe('a'.repeat(500));
  });

  it('returns empty string when nothing visible remains', () => {
    expect(filterAgentOutput('<thinking>only thinking</thinking>')).toBe('');
  });

  it('returns empty string when only JSON tool lines remain', () => {
    expect(filterAgentOutput('{"type":"tool_use","name":"x"}')).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(filterAgentOutput('')).toBe('');
  });
});
