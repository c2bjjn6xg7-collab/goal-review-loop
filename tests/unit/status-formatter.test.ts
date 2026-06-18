/**
 * Unit tests for status formatter.
 * Phase 4 §9.2: StatusOutput structure and formatting.
 * Phase 10: feedback_summary field and human-readable output behavior.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { StatusOutput, StatusFeedbackSummary } from '../../src/types.js';
import { printHumanReadable } from '../../src/cli/status.js';

function emptyFeedbackSummary(): StatusFeedbackSummary {
  return {
    blocks_total: 0,
    parse_warnings: 0,
    unknown_role_blocks: 0,
    by_type: {
      clarify: 0,
      followup_task: 0,
      risk_note: 0,
      scope_concern: 0,
      verification_suggestion: 0,
    },
    by_role: {
      planner: 0,
      developer: 0,
      auditor: 0,
      final_auditor: 0,
    },
    present_files: [],
  };
}

function baseStatus(overrides: Partial<StatusOutput> = {}): StatusOutput {
  return {
    run_id: 'run-001',
    phase: 'DEVELOPING',
    iteration: 1,
    max_iterations: 3,
    branch: 'agent/run-001-feature',
    base_commit: 'abc123',
    goal_digest: 'sha256:' + 'a'.repeat(64),
    audited_diff_digest: null,
    last_error: null,
    lock_status: 'held',
    lock_info: {
      run_id: 'run-001',
      pid: 12345,
      hostname: 'localhost',
      created_at: '2026-06-13T10:00:00.000Z',
    },
    started_at: '2026-06-13T10:00:00.000Z',
    updated_at: '2026-06-13T10:05:00.000Z',
    next_step: 'Developer is running (iteration 1/3). Wait for it to complete.',
    final_audit_decision: null,
    final_audit_path: null,
    commit_on_pass: true,
    commit_skipped: false,
    final_commit_sha: null,
    tag_requested: false,
    tag_name: null,
    tag_created: false,
    push_enabled: false,
    finalization_next_step: null,
    feedback_summary: emptyFeedbackSummary(),
    ...overrides,
  };
}

describe('StatusOutput structure', () => {
  it('has all required fields', () => {
    const output = baseStatus();
    expect(output.run_id).toBe('run-001');
    expect(output.phase).toBe('DEVELOPING');
    expect(output.iteration).toBe(1);
    expect(output.max_iterations).toBe(3);
    expect(output.lock_status).toBe('held');
    expect(output.next_step).toBeTruthy();
  });

  it('serializes to stable JSON', () => {
    const output = baseStatus({
      phase: 'VERIFYING',
      iteration: 2,
      audited_diff_digest: 'sha256:' + 'b'.repeat(64),
      lock_status: 'none',
      lock_info: null,
      next_step: 'Verification is running (iteration 2/3). Wait for it to complete.',
    });

    const json = JSON.stringify(output, null, 2);
    const parsed = JSON.parse(json);
    expect(parsed.run_id).toBe('run-001');
    expect(parsed.phase).toBe('VERIFYING');
    expect(parsed.iteration).toBe(2);
  });

  it('handles terminal state hints', () => {
    const failedOutput = baseStatus({
      phase: 'FAILED',
      iteration: 3,
      last_error: {
        code: 'VERIFICATION_FAILED',
        message: 'Tests still fail',
        resumable: false,
        suggested_action: 'Fix tests',
      },
      lock_status: 'none',
      lock_info: null,
      next_step: 'Run failed after 3 iteration(s). Review errors and adjust configuration.',
    });

    expect(failedOutput.phase).toBe('FAILED');
    expect(failedOutput.last_error).not.toBeNull();
    expect(failedOutput.next_step).toContain('failed');
  });
});

describe('StatusOutput.feedback_summary', () => {
  it('exposes a default empty feedback_summary structure', () => {
    const output = baseStatus();
    expect(output.feedback_summary).toBeDefined();
    expect(output.feedback_summary.blocks_total).toBe(0);
    expect(output.feedback_summary.parse_warnings).toBe(0);
    expect(output.feedback_summary.unknown_role_blocks).toBe(0);
    expect(output.feedback_summary.present_files).toEqual([]);
    expect(Object.keys(output.feedback_summary.by_type).sort()).toEqual(
      ['clarify', 'followup_task', 'risk_note', 'scope_concern', 'verification_suggestion'].sort(),
    );
    expect(Object.keys(output.feedback_summary.by_role).sort()).toEqual(
      ['auditor', 'developer', 'final_auditor', 'planner'].sort(),
    );
  });

  it('JSON-serializes feedback_summary as a top-level object field', () => {
    const output = baseStatus({
      feedback_summary: {
        blocks_total: 4,
        parse_warnings: 1,
        unknown_role_blocks: 1,
        by_type: {
          clarify: 1,
          followup_task: 1,
          risk_note: 1,
          scope_concern: 0,
          verification_suggestion: 1,
        },
        by_role: {
          planner: 1,
          developer: 2,
          auditor: 0,
          final_auditor: 0,
        },
        present_files: [
          '.agent/clarifications.md',
          '.agent/feedback-notes.md',
          '.agent/followups.md',
          '.agent/parse-warnings.md',
        ],
      },
    });
    const parsed = JSON.parse(JSON.stringify(output));
    expect(parsed.feedback_summary).toBeDefined();
    expect(parsed.feedback_summary.blocks_total).toBe(4);
    expect(parsed.feedback_summary.parse_warnings).toBe(1);
    expect(parsed.feedback_summary.unknown_role_blocks).toBe(1);
    expect(parsed.feedback_summary.by_type.clarify).toBe(1);
    expect(parsed.feedback_summary.by_role.developer).toBe(2);
    expect(parsed.feedback_summary.present_files).toHaveLength(4);
    expect(typeof parsed.feedback_summary.blocks_total).toBe('number');
    expect(Array.isArray(parsed.feedback_summary.present_files)).toBe(true);
  });
});

describe('printHumanReadable', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let lines: string[];

  beforeEach(() => {
    lines = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it('prints the existing core fields and omits the Phase 10 section when no feedback present', () => {
    printHumanReadable(baseStatus());
    const out = lines.join('\n');
    expect(out).toContain('Run: run-001');
    expect(out).toContain('Phase: DEVELOPING');
    expect(out).toContain('Next step:');
    expect(out).not.toContain('Phase 10 feedback:');
  });

  it('prints a Phase 10 section with type, role, and parse-warning counts when present', () => {
    printHumanReadable(
      baseStatus({
        feedback_summary: {
          blocks_total: 3,
          parse_warnings: 1,
          unknown_role_blocks: 1,
          by_type: {
            clarify: 1,
            followup_task: 1,
            risk_note: 1,
            scope_concern: 0,
            verification_suggestion: 0,
          },
          by_role: {
            planner: 1,
            developer: 0,
            auditor: 1,
            final_auditor: 0,
          },
          present_files: [
            '.agent/clarifications.md',
            '.agent/feedback-notes.md',
            '.agent/followups.md',
            '.agent/parse-warnings.md',
          ],
        },
      }),
    );
    const out = lines.join('\n');
    expect(out).toContain('Phase 10 feedback:');
    expect(out).toContain('Blocks: 3');
    expect(out).toContain('parse warnings: 1');
    expect(out).toContain('clarify=1');
    expect(out).toContain('risk_note=1');
    expect(out).toContain('followup_task=1');
    expect(out).toContain('planner=1');
    expect(out).toContain('auditor=1');
    expect(out).toContain('unknown=1');
    expect(out).toContain('.agent/clarifications.md');
    expect(out).toContain('.agent/parse-warnings.md');
  });

  it('prints the Phase 10 section when only parse warnings exist (no blocks)', () => {
    printHumanReadable(
      baseStatus({
        feedback_summary: {
          blocks_total: 0,
          parse_warnings: 2,
          unknown_role_blocks: 0,
          by_type: {
            clarify: 0,
            followup_task: 0,
            risk_note: 0,
            scope_concern: 0,
            verification_suggestion: 0,
          },
          by_role: {
            planner: 0,
            developer: 0,
            auditor: 0,
            final_auditor: 0,
          },
          present_files: ['.agent/parse-warnings.md'],
        },
      }),
    );
    const out = lines.join('\n');
    expect(out).toContain('Phase 10 feedback:');
    expect(out).toContain('Blocks: 0');
    expect(out).toContain('parse warnings: 2');
    expect(out).not.toContain('By type:');
    expect(out).not.toContain('By role:');
    expect(out).toContain('.agent/parse-warnings.md');
  });

  it('does not print the Phase 10 section for a fully empty summary with no present files', () => {
    printHumanReadable(baseStatus());
    const out = lines.join('\n');
    expect(out).not.toContain('Phase 10 feedback:');
    expect(out).not.toContain('parse warnings:');
  });

  it('prints the Phase 10 section when only present_files is non-empty', () => {
    printHumanReadable(
      baseStatus({
        feedback_summary: {
          ...emptyFeedbackSummary(),
          present_files: ['.agent/followups.md'],
        },
      }),
    );
    const out = lines.join('\n');
    expect(out).toContain('Phase 10 feedback:');
    expect(out).toContain('Files: .agent/followups.md');
  });
});
