/**
 * Phase 8D P6.5: unit tests for the task graph scope preflight helper.
 *
 * Covers the core detection rule — a required integration-test verification
 * command combined with a test-only allowed_changes (no source/docs/config
 * path) — plus the negative cases that must NOT warn, and the invariant that
 * the preflight is always non-blocking.
 *
 * The helper is pure, so every case is a direct input/output assertion with no
 * filesystem, clock, or fake timers.
 */
import { describe, it, expect } from 'vitest';
import {
  runTaskGraphPreflight,
  TASK_GRAPH_PREFLIGHT_WARNING_CODE,
  type TaskGraphPreflightInput,
} from '../../src/orchestrator/task-graph-preflight.js';
import type { VerificationCommand } from '../../src/types.js';

function cmd(id: string, argv: string[], required = true): VerificationCommand {
  return { id, argv, cwd: '.', required, timeout_seconds: 300 };
}

function integrationCmd(id = 'integration-tests', required = true): VerificationCommand {
  return cmd(id, ['npm', 'test', '--', '--run', 'tests/integration/task-graph.test.ts'], required);
}

function input(
  overrides: Partial<TaskGraphPreflightInput> & { allowed_changes?: string[] } = {},
): TaskGraphPreflightInput {
  return {
    task_id: 'task-x',
    allowed_changes: ['tests/integration/task-graph.test.ts'],
    verification_commands: [integrationCmd()],
    ...overrides,
  };
}

describe('task-graph-preflight', () => {
  it('warns when a required integration-test cmd pairs with a test-only scope', () => {
    const res = runTaskGraphPreflight(input({ allowed_changes: ['tests/integration/task-graph.test.ts'] }));
    expect(res.blocked).toBe(false);
    expect(res.warnings).toHaveLength(1);
    const w = res.warnings[0];
    expect(w.code).toBe(TASK_GRAPH_PREFLIGHT_WARNING_CODE);
    expect(w.task_id).toBe('task-x');
    expect(w.verification_command_ids).toEqual(['integration-tests']);
    expect(w.allowed_changes).toEqual(['tests/integration/task-graph.test.ts']);
    expect(w.message).toContain('integration-test verification');
    expect(w.message).toContain('task-x');
    expect(w.message.toLowerCase()).toContain('not blocked');
  });

  it('does NOT warn when allowed_changes includes a source path', () => {
    const res = runTaskGraphPreflight(
      input({ allowed_changes: ['src/orchestrator/task-graph-loop.ts', 'tests/integration/task-graph.test.ts'] }),
    );
    expect(res.warnings).toHaveLength(0);
    expect(res.blocked).toBe(false);
  });

  it('does NOT warn when allowed_changes includes a docs path', () => {
    const res = runTaskGraphPreflight(
      input({ allowed_changes: ['docs/configuration.md', 'tests/integration/foo.test.ts'] }),
    );
    expect(res.warnings).toHaveLength(0);
  });

  it('does NOT warn when allowed_changes includes a config path', () => {
    const res = runTaskGraphPreflight(
      input({ allowed_changes: ['package.json', 'tests/integration/foo.test.ts'] }),
    );
    expect(res.warnings).toHaveLength(0);
  });

  it('does NOT warn when allowed_changes includes a config-style file (src/artifacts/config.ts counts as source)', () => {
    // src/* is a source path, so the scope is not test-only.
    const res = runTaskGraphPreflight(
      input({ allowed_changes: ['src/artifacts/config.ts', 'tests/integration/foo.test.ts'] }),
    );
    expect(res.warnings).toHaveLength(0);
  });

  it('does NOT warn when no required verification command references tests/integration', () => {
    const res = runTaskGraphPreflight(
      input({
        allowed_changes: ['tests/integration/foo.test.ts'],
        verification_commands: [cmd('unit-tests', ['npm', 'test', '--', '--run', 'tests/unit/foo.test.ts'])],
      }),
    );
    expect(res.warnings).toHaveLength(0);
  });

  it('does NOT warn when the integration-test command is optional (required: false)', () => {
    const res = runTaskGraphPreflight(
      input({
        allowed_changes: ['tests/integration/foo.test.ts'],
        verification_commands: [integrationCmd('integration-tests', false)],
      }),
    );
    expect(res.warnings).toHaveLength(0);
  });

  it('does NOT warn when allowed_changes is empty', () => {
    const res = runTaskGraphPreflight(input({ allowed_changes: [] }));
    expect(res.warnings).toHaveLength(0);
  });

  it('does NOT warn when allowed_changes contains a non-test path even if integration test is required', () => {
    // A scripts/ path is neither test nor source/docs/config — scope is not "only test paths".
    const res = runTaskGraphPreflight(
      input({ allowed_changes: ['scripts/run.sh', 'tests/integration/foo.test.ts'] }),
    );
    expect(res.warnings).toHaveLength(0);
  });

  it('warns when multiple required integration-test commands are present', () => {
    const res = runTaskGraphPreflight(
      input({
        allowed_changes: ['tests/integration/foo.test.ts'],
        verification_commands: [
          integrationCmd('integration-a'),
          integrationCmd('integration-b'),
          cmd('unit', ['npm', 'test', '--', '--run', 'tests/unit/foo.test.ts']),
        ],
      }),
    );
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0].verification_command_ids).toEqual(['integration-a', 'integration-b']);
  });

  it('warns for a globbed test-only scope (tests/**)', () => {
    const res = runTaskGraphPreflight(
      input({ allowed_changes: ['tests/**'] }),
    );
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0].allowed_changes).toEqual(['tests/**']);
  });

  it('normalizes leading ./ and backslashes in allowed_changes', () => {
    const res = runTaskGraphPreflight(
      input({ allowed_changes: ['.\\tests\\integration\\foo.test.ts'] }),
    );
    expect(res.warnings).toHaveLength(1);
  });

  it('is deterministic: identical input yields identical output', () => {
    const i = input({ allowed_changes: ['tests/integration/foo.test.ts'] });
    const a = runTaskGraphPreflight(i);
    const b = runTaskGraphPreflight(i);
    expect(a).toEqual(b);
  });

  it('is always non-blocking even when warning', () => {
    const res = runTaskGraphPreflight(input({ allowed_changes: ['tests/**'] }));
    expect(res.warnings.length).toBeGreaterThan(0);
    expect(res.blocked).toBe(false);
  });

  it('treats missing arrays defensively (no throw, no warning)', () => {
    const res = runTaskGraphPreflight({
      task_id: 'task-x',
      allowed_changes: undefined as unknown as string[],
      verification_commands: undefined as unknown as VerificationCommand[],
    });
    expect(res.warnings).toHaveLength(0);
    expect(res.blocked).toBe(false);
  });

  it('detects tests/integration reference anywhere in argv, not only the last token', () => {
    const res = runTaskGraphPreflight(
      input({
        allowed_changes: ['tests/integration/foo.test.ts'],
        verification_commands: [cmd('it', ['npm', 'test', '--', '-t', 'idle watchdog', 'tests/integration/task-graph.test.ts'])],
      }),
    );
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0].verification_command_ids).toEqual(['it']);
  });
});
