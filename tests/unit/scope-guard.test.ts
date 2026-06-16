import { describe, it, expect } from 'vitest';
import {
  checkScope,
  checkSuspiciousTestMarkers,
  checkTestConfigDisabled,
} from '../../src/scope/scope-guard.js';
import type { ChangedFilesSchema } from '../../src/types.js';

describe('ScopeGuard', () => {
  const createChangedFiles = (files: Array<{ path: string; status: string }>): ChangedFilesSchema => ({
    schema_version: 1,
    base_commit: 'abc123',
    files: files.map((f) => ({
      path: f.path,
      status: f.status as any,
      tracked: true,
      additions: 1,
      deletions: 0,
    })),
  });

  describe('checkScope', () => {
    it('should allow changes within allowed_changes', () => {
      const changedFiles = createChangedFiles([{ path: 'src/foo.ts', status: 'modified' }]);
      const result = checkScope({
        allowedChanges: ['src/**'],
        disallowedChanges: [],
        changedFiles,
      });

      expect(result.passed).toBe(true);
      expect(result.report.allowed).toContain('src/foo.ts');
      expect(result.report.denied).toHaveLength(0);
    });

    it('should deny changes outside allowed_changes', () => {
      const changedFiles = createChangedFiles([{ path: 'package.json', status: 'modified' }]);
      const result = checkScope({
        allowedChanges: ['src/**'],
        disallowedChanges: [],
        changedFiles,
      });

      expect(result.passed).toBe(false);
      expect(result.report.denied).toHaveLength(1);
      expect(result.report.denied[0].reason).toBe('outside_allowed_changes');
    });

    it('should deny changes in disallowed_changes even if in allowed', () => {
      const changedFiles = createChangedFiles([{ path: 'src/secret.ts', status: 'modified' }]);
      const result = checkScope({
        allowedChanges: ['src/**'],
        disallowedChanges: ['src/secret.ts'],
        changedFiles,
      });

      expect(result.passed).toBe(false);
      expect(result.report.denied).toHaveLength(1);
      expect(result.report.denied[0].reason).toBe('disallowed_change');
    });

    it('should protect system paths', () => {
      const changedFiles = createChangedFiles([{ path: '.git/config', status: 'modified' }]);
      const result = checkScope({
        allowedChanges: ['**'],
        disallowedChanges: [],
        changedFiles,
      });

      expect(result.passed).toBe(false);
      expect(result.report.denied).toHaveLength(1);
      expect(result.report.denied[0].reason).toBe('system_protected');
    });

    it('should protect .agent/state.json', () => {
      const changedFiles = createChangedFiles([{ path: '.agent/state.json', status: 'modified' }]);
      const result = checkScope({
        allowedChanges: ['**'],
        disallowedChanges: [],
        changedFiles,
      });

      expect(result.passed).toBe(false);
      expect(result.report.denied).toHaveLength(1);
      expect(result.report.denied[0].reason).toBe('system_protected');
    });

    it('should allow developer-handoff.md exception', () => {
      const changedFiles = createChangedFiles([
        { path: '.agent/developer-handoff.md', status: 'modified' },
      ]);
      const result = checkScope({
        allowedChanges: ['**'],
        disallowedChanges: [],
        changedFiles,
      });

      expect(result.passed).toBe(true);
      expect(result.report.allowed).toContain('.agent/developer-handoff.md');
    });

    it('should exclude orchestrator-owned files', () => {
      const changedFiles = createChangedFiles([
        { path: '.agent/evidence/iteration-01/changed-files.json', status: 'modified' },
      ]);
      const result = checkScope({
        allowedChanges: ['**'],
        disallowedChanges: [],
        changedFiles,
        orchestratorOwnedFiles: ['.agent/evidence/iteration-01/changed-files.json'],
      });

      expect(result.passed).toBe(true);
      expect(result.report.excluded_orchestrator_owned).toContain(
        '.agent/evidence/iteration-01/changed-files.json',
      );
    });

    it('should deny non-orchestrator files in protected paths', () => {
      const changedFiles = createChangedFiles([
        { path: '.agent/evidence/fake.json', status: 'modified' },
      ]);
      const result = checkScope({
        allowedChanges: ['**'],
        disallowedChanges: [],
        changedFiles,
        orchestratorOwnedFiles: [],
      });

      expect(result.passed).toBe(false);
      expect(result.report.denied).toHaveLength(1);
      expect(result.report.denied[0].reason).toBe('system_protected');
    });

    it('should detect test file deletion', () => {
      const changedFiles = createChangedFiles([
        { path: 'tests/unit/foo.test.ts', status: 'deleted' },
      ]);
      const result = checkScope({
        allowedChanges: ['tests/**'],
        disallowedChanges: [],
        changedFiles,
      });

      expect(result.report.warnings).toHaveLength(1);
      expect(result.report.warnings[0].code).toBe('TEST_FILE_DELETED');
    });

    it('should deny unauthorized test deletion', () => {
      const changedFiles = createChangedFiles([
        { path: 'tests/unit/foo.test.ts', status: 'deleted' },
      ]);
      const result = checkScope({
        allowedChanges: ['src/**'],
        disallowedChanges: [],
        changedFiles,
      });

      expect(result.passed).toBe(false);
      expect(result.report.denied).toHaveLength(1);
      expect(result.report.denied[0].reason).toBe('unauthorized_test_deletion');
    });
  });

  describe('checkScope with fileContents', () => {
    it('should detect skip markers in test files', () => {
      const changedFiles = createChangedFiles([{ path: 'tests/unit/foo.test.ts', status: 'modified' }]);
      const fileContents = new Map([
        ['tests/unit/foo.test.ts', 'describe.skip("test", () => {});'],
      ]);
      const result = checkScope({
        allowedChanges: ['tests/**'],
        disallowedChanges: [],
        changedFiles,
        fileContents,
      });

      expect(result.passed).toBe(true);
      expect(result.report.warnings).toHaveLength(1);
      expect(result.report.warnings[0].code).toBe('SUSPICIOUS_TEST_MARKER');
    });

    it('should detect disabled test script in package.json', () => {
      const changedFiles = createChangedFiles([{ path: 'package.json', status: 'modified' }]);
      const fileContents = new Map([
        ['package.json', JSON.stringify({ scripts: { test: 'true' } })],
      ]);
      const result = checkScope({
        allowedChanges: ['**'],
        disallowedChanges: [],
        changedFiles,
        fileContents,
      });

      expect(result.passed).toBe(true);
      expect(result.report.warnings).toHaveLength(1);
      expect(result.report.warnings[0].code).toBe('TEST_SCRIPT_DISABLED');
    });
  });

  const createChangedFilesFull = (
    files: Array<{ path: string; status: string; tracked?: boolean }>,
  ): ChangedFilesSchema => ({
    schema_version: 1,
    base_commit: 'abc123',
    files: files.map((f) => ({
      path: f.path,
      status: f.status as any,
      tracked: f.tracked ?? true,
      additions: 1,
      deletions: 0,
    })),
  });

  describe('F-315R1: dependency cache exclusion (untracked only)', () => {
    it('should exclude untracked node_modules/.vite/** from scope checking', () => {
      const changedFiles = createChangedFilesFull([
        { path: 'node_modules/.vite/vitest/results.json', status: 'untracked', tracked: false },
      ]);
      const result = checkScope({
        allowedChanges: ['src/**'],
        disallowedChanges: [],
        changedFiles,
      });

      expect(result.passed).toBe(true);
      expect(result.report.denied).toHaveLength(0);
      expect(result.report.excluded_dependency_cache).toContain(
        'node_modules/.vite/vitest/results.json',
      );
      expect(result.report.allowed).not.toContain(
        'node_modules/.vite/vitest/results.json',
      );
    });

    it('should deny tracked node_modules/** modifications outside allowed_changes', () => {
      const changedFiles = createChangedFilesFull([
        { path: 'node_modules/my-pkg/index.js', status: 'modified', tracked: true },
      ]);
      const result = checkScope({
        allowedChanges: ['src/**'],
        disallowedChanges: [],
        changedFiles,
      });

      expect(result.passed).toBe(false);
      expect(result.report.denied).toHaveLength(1);
      expect(result.report.denied[0].reason).toBe('outside_allowed_changes');
      expect(result.report.excluded_dependency_cache).toHaveLength(0);
    });

    it('should deny tracked .pnp.cjs modifications', () => {
      const changedFiles = createChangedFilesFull([
        { path: '.pnp.cjs', status: 'modified', tracked: true },
      ]);
      const result = checkScope({
        allowedChanges: ['src/**'],
        disallowedChanges: [],
        changedFiles,
      });

      expect(result.passed).toBe(false);
      expect(result.report.denied).toHaveLength(1);
      expect(result.report.denied[0].reason).toBe('outside_allowed_changes');
    });

    it('should deny tracked .yarn/plugins/** modifications', () => {
      const changedFiles = createChangedFilesFull([
        { path: '.yarn/plugins/@yarnpkg/plugin-interactive-tools.cjs', status: 'modified', tracked: true },
      ]);
      const result = checkScope({
        allowedChanges: ['src/**'],
        disallowedChanges: [],
        changedFiles,
      });

      expect(result.passed).toBe(false);
      expect(result.report.denied).toHaveLength(1);
      expect(result.report.denied[0].reason).toBe('outside_allowed_changes');
    });

    it('should exclude untracked .yarn/cache/** and .pnpm-store/**', () => {
      const changedFiles = createChangedFilesFull([
        { path: '.yarn/cache/lodash-npm-4.17.21.zip', status: 'untracked', tracked: false },
        { path: '.pnpm-store/lodash@4.17.21/index.js', status: 'untracked', tracked: false },
        { path: '.yarn/unplugged/some-pkg/index.js', status: 'untracked', tracked: false },
        { path: '.yarn/install-state.gz', status: 'untracked', tracked: false },
      ]);
      const result = checkScope({
        allowedChanges: ['src/**'],
        disallowedChanges: [],
        changedFiles,
      });

      expect(result.passed).toBe(true);
      expect(result.report.denied).toHaveLength(0);
      expect(result.report.excluded_dependency_cache).toHaveLength(4);
    });

    it('should still deny real business files outside allowed_changes', () => {
      const changedFiles = createChangedFilesFull([
        { path: 'src/utils.ts', status: 'modified' },
        { path: 'config/production.yaml', status: 'modified' },
        { path: 'README.md', status: 'modified' },
      ]);
      const result = checkScope({
        allowedChanges: ['src/core/**'],
        disallowedChanges: [],
        changedFiles,
      });

      expect(result.passed).toBe(false);
      expect(result.report.denied.length).toBeGreaterThanOrEqual(2);
      expect(result.report.denied.some((d) => d.path === 'config/production.yaml')).toBe(true);
      expect(result.report.denied.some((d) => d.path === 'README.md')).toBe(true);
    });

    it('should still intercept Developer forging .agent/evidence', () => {
      const changedFiles = createChangedFilesFull([
        { path: '.agent/evidence/iteration-01/fake-evidence.json', status: 'added' },
      ]);
      const result = checkScope({
        allowedChanges: ['src/**'],
        disallowedChanges: [],
        changedFiles,
        orchestratorOwnedFiles: [],
      });

      expect(result.passed).toBe(false);
      expect(result.report.denied).toHaveLength(1);
      expect(result.report.denied[0].reason).toBe('system_protected');
    });

    it('should still intercept Developer modifying protected files', () => {
      const changedFiles = createChangedFilesFull([
        { path: '.agent/GOAL.md', status: 'modified' },
        { path: '.agent/state.json', status: 'modified' },
      ]);
      const result = checkScope({
        allowedChanges: ['src/**'],
        disallowedChanges: [],
        changedFiles,
        orchestratorOwnedFiles: [],
      });

      expect(result.passed).toBe(false);
      expect(result.report.denied).toHaveLength(2);
      expect(result.report.denied.every((d) => d.reason === 'system_protected')).toBe(true);
    });

    it('should handle mixed: untracked cache excluded + tracked cache denied + business denied', () => {
      const changedFiles = createChangedFilesFull([
        { path: 'node_modules/.vite/vitest/results.json', status: 'untracked', tracked: false },
        { path: 'node_modules/my-pkg/hack.js', status: 'modified', tracked: true },
        { path: 'src/hack.ts', status: 'modified' },
      ]);
      const result = checkScope({
        allowedChanges: ['src/core/**'],
        disallowedChanges: [],
        changedFiles,
      });

      expect(result.passed).toBe(false);
      expect(result.report.excluded_dependency_cache).toContain(
        'node_modules/.vite/vitest/results.json',
      );
      // tracked node_modules + src/hack.ts are outside src/core/**
      expect(result.report.denied.length).toBeGreaterThanOrEqual(2);
      expect(result.report.denied.some((d) => d.path === 'node_modules/my-pkg/hack.js')).toBe(true);
      expect(result.report.denied.some((d) => d.path === 'src/hack.ts')).toBe(true);
    });
  });

  describe('checkSuspiciousTestMarkers', () => {
    it('should detect .skip', () => {
      const content = 'describe.skip("test", () => {});';
      const warnings = checkSuspiciousTestMarkers(content, 'test.ts');
      expect(warnings).toHaveLength(1);
      expect(warnings[0].code).toBe('SUSPICIOUS_TEST_MARKER');
    });

    it('should detect .only', () => {
      const content = 'it.only("test", () => {});';
      const warnings = checkSuspiciousTestMarkers(content, 'test.ts');
      expect(warnings).toHaveLength(1);
      expect(warnings[0].code).toBe('SUSPICIOUS_TEST_MARKER');
    });

    it('should detect xit', () => {
      const content = 'xit("test", () => {});';
      const warnings = checkSuspiciousTestMarkers(content, 'test.ts');
      expect(warnings).toHaveLength(1);
      expect(warnings[0].code).toBe('SUSPICIOUS_TEST_MARKER');
    });

    it('should detect xdescribe', () => {
      const content = 'xdescribe("test", () => {});';
      const warnings = checkSuspiciousTestMarkers(content, 'test.ts');
      expect(warnings).toHaveLength(1);
      expect(warnings[0].code).toBe('SUSPICIOUS_TEST_MARKER');
    });

    it('should not report normal tests', () => {
      const content = 'describe("test", () => { it("should work", () => {}); });';
      const warnings = checkSuspiciousTestMarkers(content, 'test.ts');
      expect(warnings).toHaveLength(0);
    });
  });

  describe('checkTestConfigDisabled', () => {
    it('should detect disabled test script', () => {
      const content = JSON.stringify({ scripts: { test: 'true' } });
      const warnings = checkTestConfigDisabled(content, 'package.json');
      expect(warnings).toHaveLength(1);
      expect(warnings[0].code).toBe('TEST_SCRIPT_DISABLED');
    });

    it('should detect no-op test script', () => {
      const content = JSON.stringify({ scripts: { test: ':' } });
      const warnings = checkTestConfigDisabled(content, 'package.json');
      expect(warnings).toHaveLength(1);
      expect(warnings[0].code).toBe('TEST_SCRIPT_DISABLED');
    });

    it('should not report normal test script', () => {
      const content = JSON.stringify({ scripts: { test: 'vitest run' } });
      const warnings = checkTestConfigDisabled(content, 'package.json');
      expect(warnings).toHaveLength(0);
    });

    it('should ignore non-package.json files', () => {
      const content = JSON.stringify({ scripts: { test: 'true' } });
      const warnings = checkTestConfigDisabled(content, 'config.json');
      expect(warnings).toHaveLength(0);
    });
  });
});
