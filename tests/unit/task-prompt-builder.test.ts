/**
 * Unit tests for buildTaskDeveloperPrompt — Phase 8B.
 */
import { describe, it, expect } from 'vitest';
import { buildTaskDeveloperPrompt } from '../../src/agents/prompt-builder.js';

const baseCtx = {
  run_id: 'run-001',
  project_root: '/proj',
  task_index: 2,
  task_total: 5,
  task_id: 'task-2',
  task_title: 'Add logger',
  task_description: 'Add a logging module',
  allowed_changes: ['src/logger/**'],
  disallowed_changes: ['.git/**', '.agent/state.json'],
  verification_commands: [
    { id: 'logger-test', command: ['npm', 'test', '--', 'logger'], cwd: '.', required: true, timeout_seconds: 120 },
  ],
  goal_success_criteria: ['Logs are written', 'Tests pass'],
  goal_path: '/proj/.agent/GOAL.md',
  handoff_path: '/proj/.agent/developer-handoff.md',
};

describe('buildTaskDeveloperPrompt', () => {
  it('includes task id, title, and description', () => {
    const p = buildTaskDeveloperPrompt(baseCtx);
    expect(p).toContain('task-2');
    expect(p).toContain('Add logger');
    expect(p).toContain('Add a logging module');
  });

  it('includes task index label (Task 2 of 5)', () => {
    const p = buildTaskDeveloperPrompt(baseCtx);
    expect(p.toLowerCase()).toContain('task **2 of 5**');
  });

  it('includes allowed_changes scope', () => {
    const p = buildTaskDeveloperPrompt(baseCtx);
    expect(p).toContain('src/logger/**');
  });

  it('includes verification commands', () => {
    const p = buildTaskDeveloperPrompt(baseCtx);
    expect(p).toContain('logger-test');
    expect(p).toContain('npm test -- logger');
  });

  it('includes GOAL success criteria for context', () => {
    const p = buildTaskDeveloperPrompt(baseCtx);
    expect(p).toContain('Logs are written');
    expect(p).toContain('Tests pass');
  });

  it('includes handoff front matter instructions', () => {
    const p = buildTaskDeveloperPrompt(baseCtx);
    expect(p).toContain('developer-handoff.md');
    expect(p).toContain('COMPLETED');
  });

  it('includes scope guard warning', () => {
    const p = buildTaskDeveloperPrompt(baseCtx);
    expect(p).toMatch(/MUST NOT modify any file outside/i);
  });

  it('instructs developer to write a BLOCKED handoff when scope is insufficient', () => {
    const p = buildTaskDeveloperPrompt(baseCtx);
    expect(p).toMatch(/status: "BLOCKED"/);
    expect(p).toMatch(/scope_expansion_request/i);
  });

  it('tells the developer not to widen scope themselves', () => {
    const p = buildTaskDeveloperPrompt(baseCtx);
    expect(p).toMatch(/do not.*widen.*scope|no automatic scope widening/i);
  });

  it('keeps scope_expansion_request as body prose, not a new schema field', () => {
    const p = buildTaskDeveloperPrompt(baseCtx);
    // The front matter schema fields are fixed; the request lives in the handoff body.
    expect(p).toMatch(/in the handoff body/i);
    expect(p).toMatch(/NOT a new front-matter field|not.*new handoff schema field/i);
  });

  it('asks the developer to name needed paths and reasons', () => {
    const p = buildTaskDeveloperPrompt(baseCtx);
    expect(p).toMatch(/path.*required|needed.*path|each path you needed/i);
    expect(p).toMatch(/reason/i);
  });

  it('does not reference other tasks or the full plan', () => {
    const p = buildTaskDeveloperPrompt(baseCtx);
    // Should not leak other tasks' scope
    expect(p).not.toContain('src/other-module');
  });

  it('handles empty disallowed_changes gracefully', () => {
    const p = buildTaskDeveloperPrompt({ ...baseCtx, disallowed_changes: [] });
    expect(p).toContain('(none)');
  });

  it('handles empty goal_success_criteria gracefully', () => {
    const p = buildTaskDeveloperPrompt({ ...baseCtx, goal_success_criteria: [] });
    expect(p).toContain('GOAL.md');
  });
});
