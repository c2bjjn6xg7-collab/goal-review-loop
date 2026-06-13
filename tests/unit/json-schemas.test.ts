import { describe, it, expect } from 'vitest';
import {
  validateChangedFiles,
  validateDiffMetadata,
  validateVerificationManifest,
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
});
