import { describe, it, expect } from 'vitest';
import {
  validateChangedFiles,
  validateDiffMetadata,
  validateVerificationManifest,
  validateStatusOutput,
} from '../../src/artifacts/json-schemas.js';

describe('JSON Schemas', () => {
  describe('changedFilesSchema', () => {
    const validChangedFiles = {
      schema_version: 1,
      base_commit: 'a'.repeat(40),
      files: [{
        path: 'src/foo.ts',
        status: 'modified',
        tracked: true,
        additions: 10,
        deletions: 5,
      }],
    };

    it('should accept valid changed files', () => {
      expect(validateChangedFiles(validChangedFiles)).toBe(true);
    });

    it('should reject fractional additions', () => {
      expect(validateChangedFiles({
        ...validChangedFiles,
        files: [{ ...validChangedFiles.files[0], additions: 1.5 }],
      })).toBe(false);
    });

    it('should reject negative additions', () => {
      expect(validateChangedFiles({
        ...validChangedFiles,
        files: [{ ...validChangedFiles.files[0], additions: -1 }],
      })).toBe(false);
    });

    it('should reject dangerous path with ..', () => {
      expect(validateChangedFiles({
        ...validChangedFiles,
        files: [{ ...validChangedFiles.files[0], path: '../../outside' }],
      })).toBe(false);
    });

    it('should reject absolute path', () => {
      expect(validateChangedFiles({
        ...validChangedFiles,
        files: [{ ...validChangedFiles.files[0], path: '/etc/passwd' }],
      })).toBe(false);
    });

    it('should reject backslash path', () => {
      expect(validateChangedFiles({
        ...validChangedFiles,
        files: [{ ...validChangedFiles.files[0], path: 'src\\foo.ts' }],
      })).toBe(false);
    });

    it('should reject invalid status enum', () => {
      expect(validateChangedFiles({
        ...validChangedFiles,
        files: [{ ...validChangedFiles.files[0], status: 'invalid' }],
      })).toBe(false);
    });

    it('should reject extra fields', () => {
      expect(validateChangedFiles({
        ...validChangedFiles,
        files: [{ ...validChangedFiles.files[0], extra: 'field' }],
      })).toBe(false);
    });

    it('should reject missing required fields', () => {
      expect(validateChangedFiles({
        schema_version: 1,
        base_commit: 'a'.repeat(40),
      })).toBe(false);
    });
  });

  describe('diffMetadataSchema', () => {
    const validMetadata = {
      schema_version: 1,
      base_commit: 'a'.repeat(40),
      generated_at: '2026-06-11T00:00:00.000Z',
      tracked_diff_summary: { files_changed: 1, insertions: 10, deletions: 5 },
      changed_files_summary: { total: 1, added: 0, modified: 1, deleted: 0, renamed: 0, untracked: 0 },
      untracked_files_summary: { total: 0, text_files: 0, binary_files: 0 },
      diff_digest: 'a'.repeat(64),
    };

    it('should accept valid metadata', () => {
      expect(validateDiffMetadata(validMetadata)).toBe(true);
    });

    it('should reject fractional files_changed', () => {
      expect(validateDiffMetadata({
        ...validMetadata,
        tracked_diff_summary: { ...validMetadata.tracked_diff_summary, files_changed: 1.5 },
      })).toBe(false);
    });

    it('should reject impossible date', () => {
      expect(validateDiffMetadata({
        ...validMetadata,
        generated_at: '2026-99-99T99:99:99.000Z',
      })).toBe(false);
    });

    it('should reject invalid diff_digest', () => {
      expect(validateDiffMetadata({
        ...validMetadata,
        diff_digest: 'not-a-sha',
      })).toBe(false);
    });
  });

  describe('verificationManifestSchema', () => {
    const validManifest = {
      schema_version: 1,
      run_id: 'run-1',
      iteration: 1,
      passed: true,
      started_at: '2026-06-11T00:00:00.000Z',
      finished_at: '2026-06-11T00:01:00.000Z',
      commands: [{
        id: 'test-cmd',
        argv: ['npm', 'test'],
        cwd: '.',
        required: true,
        status: 'success',
        exit_code: 0,
        timed_out: false,
        duration_ms: 60000,
        stdout_path: 'iteration-01/test-cmd.stdout.log',
        stderr_path: 'iteration-01/test-cmd.stderr.log',
      }],
    };

    it('should accept valid manifest', () => {
      expect(validateVerificationManifest(validManifest)).toBe(true);
    });

    it('should reject fractional iteration', () => {
      expect(validateVerificationManifest({
        ...validManifest,
        iteration: 1.5,
      })).toBe(false);
    });

    it('should reject fractional duration_ms', () => {
      expect(validateVerificationManifest({
        ...validManifest,
        commands: [{ ...validManifest.commands[0], duration_ms: 1.5 }],
      })).toBe(false);
    });

    it('should reject empty argv item', () => {
      expect(validateVerificationManifest({
        ...validManifest,
        commands: [{ ...validManifest.commands[0], argv: [''] }],
      })).toBe(false);
    });

    it('should reject empty argv array', () => {
      expect(validateVerificationManifest({
        ...validManifest,
        commands: [{ ...validManifest.commands[0], argv: [] }],
      })).toBe(false);
    });

    it('should reject absolute cwd', () => {
      expect(validateVerificationManifest({
        ...validManifest,
        commands: [{ ...validManifest.commands[0], cwd: '/etc' }],
      })).toBe(false);
    });

    it('should reject cwd with ..', () => {
      expect(validateVerificationManifest({
        ...validManifest,
        commands: [{ ...validManifest.commands[0], cwd: '../../outside' }],
      })).toBe(false);
    });

    it('should reject absolute stdout_path', () => {
      expect(validateVerificationManifest({
        ...validManifest,
        commands: [{ ...validManifest.commands[0], stdout_path: '/tmp/log.txt' }],
      })).toBe(false);
    });

    it('should reject invalid command id', () => {
      expect(validateVerificationManifest({
        ...validManifest,
        commands: [{ ...validManifest.commands[0], id: '../escaped' }],
      })).toBe(false);
    });
  });

  describe('statusOutputSchema', () => {
    const emptyFeedbackSummary = {
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

    const validStatus = {
      run_id: 'run-001',
      phase: 'DEVELOPING',
      iteration: 1,
      max_iterations: 3,
      branch: 'agent/run-001',
      base_commit: 'abc123',
      goal_digest: null,
      audited_diff_digest: null,
      last_error: null,
      lock_status: 'none',
      lock_info: null,
      started_at: '2026-06-13T10:00:00.000Z',
      updated_at: '2026-06-13T10:05:00.000Z',
      next_step: 'Developer is running.',
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
      feedback_summary: emptyFeedbackSummary,
    };

    it('accepts a status output with an empty feedback_summary', () => {
      expect(validateStatusOutput(validStatus)).toBe(true);
    });

    it('accepts a status output with a populated feedback_summary', () => {
      expect(
        validateStatusOutput({
          ...validStatus,
          feedback_summary: {
            blocks_total: 3,
            parse_warnings: 1,
            unknown_role_blocks: 1,
            by_type: {
              clarify: 1,
              followup_task: 1,
              risk_note: 0,
              scope_concern: 0,
              verification_suggestion: 1,
            },
            by_role: {
              planner: 1,
              developer: 1,
              auditor: 0,
              final_auditor: 0,
            },
            present_files: [
              '.agent/clarifications.md',
              '.agent/followups.md',
              '.agent/parse-warnings.md',
            ],
          },
        }),
      ).toBe(true);
    });

    it('rejects a status output missing feedback_summary', () => {
      const { feedback_summary, ...withoutSummary } = validStatus;
      void feedback_summary;
      expect(validateStatusOutput(withoutSummary)).toBe(false);
    });

    it('rejects a feedback_summary missing canonical type keys', () => {
      expect(
        validateStatusOutput({
          ...validStatus,
          feedback_summary: {
            ...emptyFeedbackSummary,
            by_type: {
              clarify: 0,
              followup_task: 0,
              risk_note: 0,
              scope_concern: 0,
              // verification_suggestion missing
            },
          },
        }),
      ).toBe(false);
    });

    it('rejects a feedback_summary with an unknown role key', () => {
      expect(
        validateStatusOutput({
          ...validStatus,
          feedback_summary: {
            ...emptyFeedbackSummary,
            by_role: {
              planner: 0,
              developer: 0,
              auditor: 0,
              final_auditor: 0,
              orchestrator: 1,
            },
          },
        }),
      ).toBe(false);
    });

    it('rejects negative counts in feedback_summary', () => {
      expect(
        validateStatusOutput({
          ...validStatus,
          feedback_summary: { ...emptyFeedbackSummary, blocks_total: -1 },
        }),
      ).toBe(false);
    });

    it('rejects fractional counts in feedback_summary', () => {
      expect(
        validateStatusOutput({
          ...validStatus,
          feedback_summary: { ...emptyFeedbackSummary, parse_warnings: 1.5 },
        }),
      ).toBe(false);
    });

    it('rejects unsafe paths in feedback_summary.present_files', () => {
      expect(
        validateStatusOutput({
          ...validStatus,
          feedback_summary: {
            ...emptyFeedbackSummary,
            present_files: ['../escaped/path.md'],
          },
        }),
      ).toBe(false);
    });

    it('rejects extra fields on feedback_summary', () => {
      expect(
        validateStatusOutput({
          ...validStatus,
          feedback_summary: { ...emptyFeedbackSummary, extra: 'field' },
        }),
      ).toBe(false);
    });

    it('rejects extra fields on the status output itself', () => {
      expect(
        validateStatusOutput({
          ...validStatus,
          unexpected_field: 'nope',
        }),
      ).toBe(false);
    });
  });
});
