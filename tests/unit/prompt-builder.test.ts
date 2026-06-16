/**
 * Unit tests for src/agents/prompt-builder.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildPlannerPrompt, buildDeveloperPrompt, buildAuditorPrompt, computePromptDigest, PROMPT_TEMPLATE_VERSION, writePromptFile, deletePromptFile, loadPromptTemplate, getBundledTemplatesDir } from '../../src/agents/prompt-builder.js';

describe('prompt-builder', () => {
  describe('PROMPT_TEMPLATE_VERSION', () => {
    it('is a positive integer', () => {
      expect(PROMPT_TEMPLATE_VERSION).toBeGreaterThanOrEqual(1);
    });
  });

  describe('computePromptDigest', () => {
    it('produces stable sha256 digest', () => {
      const d1 = computePromptDigest('test prompt');
      const d2 = computePromptDigest('test prompt');
      expect(d1).toBe(d2);
      expect(d1).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it('produces different digests for different prompts', () => {
      const d1 = computePromptDigest('prompt a');
      const d2 = computePromptDigest('prompt b');
      expect(d1).not.toBe(d2);
    });
  });

  describe('buildPlannerPrompt', () => {
    it('replaces all placeholders', () => {
      const template = '{{USER_REQUEST}} {{RUN_ID}} {{PROJECT_ROOT}} {{BASE_COMMIT}} {{TEMPLATE_VERSION}}';
      const result = buildPlannerPrompt(template, {
        user_request: 'Add feature X',
        run_id: 'run-001',
        project_root: '/tmp/project',
        base_commit: 'abc123',
      });
      expect(result).toContain('Add feature X');
      expect(result).toContain('run-001');
      expect(result).toContain('/tmp/project');
      expect(result).toContain('abc123');
      expect(result).toContain(String(PROMPT_TEMPLATE_VERSION));
    });

    it('handles missing optional fields', () => {
      const template = '{{AGENTS_MD_PATH}}: {{AGENTS_MD_CONTENT}}';
      const result = buildPlannerPrompt(template, {
        user_request: 'test',
        run_id: 'run-1',
        project_root: '/tmp',
        base_commit: 'abc',
      });
      expect(result).toContain('(not available)');
    });
  });

  describe('buildDeveloperPrompt', () => {
    it('replaces all placeholders', () => {
      const template = '{{RUN_ID}} {{ITERATION}} {{PLAN_PATH}} {{GOAL_PATH}} {{HANDOFF_PATH}}';
      const result = buildDeveloperPrompt(template, {
        run_id: 'run-001',
        iteration: 1,
        project_root: '/tmp/project',
        plan_path: '/tmp/project/.agent/plan.md',
        goal_path: '/tmp/project/.agent/GOAL.md',
        handoff_path: '/tmp/project/.agent/developer-handoff.md',
      });
      expect(result).toContain('run-001');
      expect(result).toContain('1');
      expect(result).toContain('plan.md');
      expect(result).toContain('GOAL.md');
      expect(result).toContain('developer-handoff.md');
    });
  });

  describe('buildAuditorPrompt', () => {
    it('replaces all placeholders', () => {
      const template = '{{RUN_ID}} {{ITERATION}} {{GOAL_DIGEST}} {{DIFF_DIGEST}}';
      const result = buildAuditorPrompt(template, {
        run_id: 'run-001',
        iteration: 1,
        project_root: '/tmp/project',
        plan_path: '/tmp/plan.md',
        goal_path: '/tmp/GOAL.md',
        handoff_path: '/tmp/handoff.md',
        verification_manifest_path: '/tmp/manifest.json',
        changed_files_path: '/tmp/changed.json',
        untracked_files_path: '/tmp/untracked.json',
        scope_report_path: '/tmp/scope.json',
        tracked_diff_path: '/tmp/diff.patch',
        diff_metadata_path: '/tmp/metadata.json',
        audit_report_path: '/tmp/audit.md',
        goal_digest: 'sha256:abc',
        diff_digest: 'sha256:def',
      });
      expect(result).toContain('run-001');
      expect(result).toContain('1');
      expect(result).toContain('sha256:abc');
      expect(result).toContain('sha256:def');
    });
  });

  // ─── SF-4: Replace ALL occurrences of each placeholder ──────────
  describe('SF-4: all placeholder occurrences replaced', () => {
    it('buildPlannerPrompt replaces all 4 occurrences of {{RUN_ID}}', () => {
      const template = '{{RUN_ID}} {{RUN_ID}} {{RUN_ID}} {{RUN_ID}}';
      const result = buildPlannerPrompt(template, {
        user_request: 'test',
        run_id: 'run-abc',
        project_root: '/tmp',
        base_commit: 'abc',
      });
      // Must not contain any residual placeholder
      expect(result).not.toContain('{{RUN_ID}}');
      // Must contain the value 4 times
      const count = result.split('run-abc').length - 1;
      expect(count).toBe(4);
    });

    it('buildDeveloperPrompt replaces all occurrences of {{RUN_ID}} and {{ITERATION}}', () => {
      const template = '{{RUN_ID}} {{ITERATION}} {{RUN_ID}} {{ITERATION}}';
      const result = buildDeveloperPrompt(template, {
        run_id: 'run-xyz',
        iteration: 3,
        project_root: '/tmp',
        plan_path: '/tmp/plan.md',
        goal_path: '/tmp/GOAL.md',
        handoff_path: '/tmp/handoff.md',
      });
      expect(result).not.toContain('{{RUN_ID}}');
      expect(result).not.toContain('{{ITERATION}}');
      expect(result.split('run-xyz').length - 1).toBe(2);
      expect(result.split('3').length - 1).toBe(2);
    });

    it('buildAuditorPrompt replaces all occurrences of {{RUN_ID}}, {{ITERATION}}, {{GOAL_DIGEST}}, {{DIFF_DIGEST}}', () => {
      const template = '{{RUN_ID}} {{ITERATION}} {{GOAL_DIGEST}} {{DIFF_DIGEST}} {{RUN_ID}} {{ITERATION}} {{GOAL_DIGEST}} {{DIFF_DIGEST}} {{GOAL_DIGEST}} {{DIFF_DIGEST}}';
      const result = buildAuditorPrompt(template, {
        run_id: 'run-aud',
        iteration: 2,
        project_root: '/tmp',
        plan_path: '/tmp/plan.md',
        goal_path: '/tmp/GOAL.md',
        handoff_path: '/tmp/handoff.md',
        verification_manifest_path: '/tmp/manifest.json',
        changed_files_path: '/tmp/changed.json',
        untracked_files_path: '/tmp/untracked.json',
        scope_report_path: '/tmp/scope.json',
        tracked_diff_path: '/tmp/diff.patch',
        diff_metadata_path: '/tmp/metadata.json',
        audit_report_path: '/tmp/audit.md',
        goal_digest: 'sha256:aaa',
        diff_digest: 'sha256:bbb',
      });
      expect(result).not.toContain('{{RUN_ID}}');
      expect(result).not.toContain('{{ITERATION}}');
      expect(result).not.toContain('{{GOAL_DIGEST}}');
      expect(result).not.toContain('{{DIFF_DIGEST}}');
      expect(result.split('run-aud').length - 1).toBe(2);
      expect(result.split('sha256:aaa').length - 1).toBe(3);
      expect(result.split('sha256:bbb').length - 1).toBe(3);
    });

    it('replacement values with $&, $1, $$ are preserved verbatim', () => {
      // These are special replacement patterns in String.replace
      const template = '{{RUN_ID}} {{GOAL_DIGEST}}';
      const result = buildPlannerPrompt(template, {
        user_request: 'test',
        run_id: 'run-$&-special',
        project_root: '/tmp',
        base_commit: 'abc',
      });
      // The $& must appear literally, not be interpreted as a replacement pattern
      expect(result).toContain('run-$&-special');
      expect(result).not.toContain('{{RUN_ID}}');
    });

    it('replacement value with $$ in developer prompt is preserved', () => {
      const template = '{{RUN_ID}} {{ITERATION}}';
      const result = buildDeveloperPrompt(template, {
        run_id: 'run-$$-test',
        iteration: 1,
        project_root: '/tmp',
        plan_path: '/tmp/plan.md',
        goal_path: '/tmp/GOAL.md',
        handoff_path: '/tmp/handoff.md',
      });
      expect(result).toContain('run-$$-test');
      expect(result).not.toContain('{{RUN_ID}}');
    });

    it('replacement value with $1 in auditor prompt is preserved', () => {
      const template = '{{GOAL_DIGEST}} {{DIFF_DIGEST}}';
      const result = buildAuditorPrompt(template, {
        run_id: 'run-test',
        iteration: 1,
        project_root: '/tmp',
        plan_path: '/tmp/plan.md',
        goal_path: '/tmp/GOAL.md',
        handoff_path: '/tmp/handoff.md',
        verification_manifest_path: '/tmp/manifest.json',
        changed_files_path: '/tmp/changed.json',
        untracked_files_path: '/tmp/untracked.json',
        scope_report_path: '/tmp/scope.json',
        tracked_diff_path: '/tmp/diff.patch',
        diff_metadata_path: '/tmp/metadata.json',
        audit_report_path: '/tmp/audit.md',
        goal_digest: 'sha256:$1-capture',
        diff_digest: 'sha256:$$-dollar',
      });
      expect(result).toContain('sha256:$1-capture');
      expect(result).toContain('sha256:$$-dollar');
      expect(result).not.toContain('{{GOAL_DIGEST}}');
      expect(result).not.toContain('{{DIFF_DIGEST}}');
    });

    it('real bundled planner template has no residual {{RUN_ID}} after building', async () => {
      const { loadPromptTemplate, getBundledTemplatesDir } = await import('../../src/agents/prompt-builder.js');
      const bundledDir = getBundledTemplatesDir();
      const { content: template } = await loadPromptTemplate(bundledDir, 'planner.md');
      const result = buildPlannerPrompt(template, {
        user_request: 'Implement hello function',
        run_id: 'run-20260613-test',
        project_root: '/tmp/project',
        base_commit: 'abc123def',
        project_files_summary: '5 files',
        agents_md_path: '/tmp/AGENTS.md',
        agents_md_content: 'agent rules',
        claude_md_path: '/tmp/CLAUDE.md',
        claude_md_content: 'claude rules',
        package_json_summary: 'node project',
      });
      // No residual placeholders of any known token
      expect(result).not.toContain('{{RUN_ID}}');
      expect(result).not.toContain('{{USER_REQUEST}}');
      expect(result).not.toContain('{{PROJECT_ROOT}}');
      expect(result).not.toContain('{{BASE_COMMIT}}');
      expect(result).not.toContain('{{TEMPLATE_VERSION}}');
      expect(result).not.toContain('{{PROJECT_FILES_SUMMARY}}');
      expect(result).not.toContain('{{AGENTS_MD_PATH}}');
      expect(result).not.toContain('{{AGENTS_MD_CONTENT}}');
      expect(result).not.toContain('{{CLAUDE_MD_PATH}}');
      expect(result).not.toContain('{{CLAUDE_MD_CONTENT}}');
      expect(result).not.toContain('{{PACKAGE_JSON_SUMMARY}}');
    });

    it('real bundled developer template has no residual placeholders after building', async () => {
      const { loadPromptTemplate, getBundledTemplatesDir } = await import('../../src/agents/prompt-builder.js');
      const bundledDir = getBundledTemplatesDir();
      const { content: template } = await loadPromptTemplate(bundledDir, 'developer.md');
      const result = buildDeveloperPrompt(template, {
        run_id: 'run-20260613-test',
        iteration: 1,
        project_root: '/tmp/project',
        plan_path: '/tmp/project/.agent/plan.md',
        goal_path: '/tmp/project/.agent/GOAL.md',
        handoff_path: '/tmp/project/.agent/developer-handoff.md',
      });
      expect(result).not.toContain('{{RUN_ID}}');
      expect(result).not.toContain('{{ITERATION}}');
      expect(result).not.toContain('{{PROJECT_ROOT}}');
      expect(result).not.toContain('{{PLAN_PATH}}');
      expect(result).not.toContain('{{GOAL_PATH}}');
      expect(result).not.toContain('{{HANDOFF_PATH}}');
      expect(result).not.toContain('{{TEMPLATE_VERSION}}');
    });

    it('real bundled auditor template has no residual placeholders after building', async () => {
      const { loadPromptTemplate, getBundledTemplatesDir } = await import('../../src/agents/prompt-builder.js');
      const bundledDir = getBundledTemplatesDir();
      const { content: template } = await loadPromptTemplate(bundledDir, 'auditor.md');
      const result = buildAuditorPrompt(template, {
        run_id: 'run-20260613-test',
        iteration: 1,
        project_root: '/tmp/project',
        plan_path: '/tmp/project/.agent/plan.md',
        goal_path: '/tmp/project/.agent/GOAL.md',
        handoff_path: '/tmp/project/.agent/developer-handoff.md',
        verification_manifest_path: '/tmp/project/.agent/verification/manifest.json',
        changed_files_path: '/tmp/project/.agent/evidence/changed-files.json',
        untracked_files_path: '/tmp/project/.agent/evidence/untracked-files.json',
        scope_report_path: '/tmp/project/.agent/verification/scope-report.json',
        tracked_diff_path: '/tmp/project/.agent/evidence/tracked.diff',
        diff_metadata_path: '/tmp/project/.agent/evidence/diff-metadata.json',
        audit_report_path: '/tmp/project/.agent/audit-report.md',
        goal_digest: 'sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        diff_digest: 'sha256:fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321',
      });
      expect(result).not.toContain('{{RUN_ID}}');
      expect(result).not.toContain('{{ITERATION}}');
      expect(result).not.toContain('{{GOAL_DIGEST}}');
      expect(result).not.toContain('{{DIFF_DIGEST}}');
      expect(result).not.toContain('{{PLAN_PATH}}');
      expect(result).not.toContain('{{GOAL_PATH}}');
      expect(result).not.toContain('{{HANDOFF_PATH}}');
      expect(result).not.toContain('{{VERIFICATION_MANIFEST_PATH}}');
      expect(result).not.toContain('{{CHANGED_FILES_PATH}}');
      expect(result).not.toContain('{{UNTRACKED_FILES_PATH}}');
      expect(result).not.toContain('{{SCOPE_REPORT_PATH}}');
      expect(result).not.toContain('{{TRACKED_DIFF_PATH}}');
      expect(result).not.toContain('{{DIFF_METADATA_PATH}}');
      expect(result).not.toContain('{{AUDIT_REPORT_PATH}}');
      expect(result).not.toContain('{{TEMPLATE_VERSION}}');
    });
  });

  // ─── SF-3: Developer termination protocol ──────────────────────
  describe('SF-3: developer prompt termination protocol', () => {
    it('developer template contains hard termination protocol', async () => {
      const bundledDir = getBundledTemplatesDir();
      const { content: template } = await loadPromptTemplate(bundledDir, 'developer.md');
      // Must contain the Termination Protocol section
      expect(template).toContain('Termination Protocol');
      expect(template).toContain('CRITICAL');
      // Must contain key protocol rules
      expect(template).toContain('at most once');
      expect(template).toContain('STOP immediately');
      expect(template).toContain('COMPLETED');
      expect(template).toContain('BLOCKED');
      // Must mention verification_commands from GOAL (not hardcoded npm test)
      expect(template).toContain('verification_commands');
      // Must explicitly prohibit re-running
      expect(template).toContain('Do not re-run');
    });

    it('built developer prompt contains termination protocol with real values', async () => {
      const bundledDir = getBundledTemplatesDir();
      const { content: template } = await loadPromptTemplate(bundledDir, 'developer.md');
      const result = buildDeveloperPrompt(template, {
        run_id: 'run-20260613-test',
        iteration: 1,
        project_root: '/tmp/project',
        plan_path: '/tmp/project/.agent/plan.md',
        goal_path: '/tmp/project/.agent/GOAL.md',
        handoff_path: '/tmp/project/.agent/developer-handoff.md',
      });
      // The built prompt must still contain the termination protocol
      expect(result).toContain('Termination Protocol');
      expect(result).toContain('STOP immediately');
      expect(result).toContain('at most once');
      // No residual placeholders
      expect(result).not.toContain('{{RUN_ID}}');
      expect(result).not.toContain('{{ITERATION}}');
    });
  });

  // ─── F-306R2: deletePromptFile structured result ─────────────
  describe('deletePromptFile (F-306R2)', () => {
    let testDir: string;

    beforeEach(() => {
      testDir = join(tmpdir(), `prompt-cleanup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      mkdirSync(join(testDir, '.agent', 'debug'), { recursive: true });
    });

    afterEach(() => {
      // Restore permissions before cleanup so rmSync can delete
      try { chmodSync(join(testDir, '.agent', 'debug'), 0o755); } catch { /* ok */ }
      try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ok */ }
    });

    it('returns success=true when file is deleted', async () => {
      const promptPath = await writePromptFile(
        join(testDir, '.agent'),
        'secret content',
        'test-run',
        'planner',
      );
      expect(existsSync(promptPath)).toBe(true);

      const result = await deletePromptFile(promptPath);
      expect(result.success).toBe(true);
      expect(result.path).toBe(promptPath);
      expect(result.error).toBeNull();
      expect(existsSync(promptPath)).toBe(false);
    });

    it('returns success=true when file does not exist (idempotent)', async () => {
      const nonExistentPath = join(testDir, '.agent', 'debug', 'nonexistent.md');
      const result = await deletePromptFile(nonExistentPath);
      expect(result.success).toBe(true);
      expect(result.error).toBeNull();
    });

    it('returns structured failure result when deletion fails', async () => {
      // Create a prompt file in a read-only directory so unlink fails
      const debugDir = join(testDir, '.agent', 'debug');
      const promptPath = await writePromptFile(
        join(testDir, '.agent'),
        'secret content',
        'test-run',
        'planner',
      );
      expect(existsSync(promptPath)).toBe(true);

      // Make the directory read-only (and the file) so unlink fails
      // On macOS/Linux, removing a file requires write permission on the directory
      chmodSync(debugDir, 0o555);

      const result = await deletePromptFile(promptPath);
      // Deletion should fail — result must report failure (NOT silently succeed)
      expect(result.success).toBe(false);
      expect(result.path).toBe(promptPath);
      expect(result.error).toBeTruthy();
      expect(typeof result.error).toBe('string');

      // Restore permissions for cleanup
      chmodSync(debugDir, 0o755);
    });
  });
});
