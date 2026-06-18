import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import { checkScope } from '../../src/scope/scope-guard.js';
import { parseFeedbackBlocks } from '../../src/artifacts/feedback-block-parser.js';
import { dispatchFeedbackBlocks } from '../../src/orchestrator/feedback-dispatcher.js';
import type { ChangedFilesSchema, FeedbackProtocolConfig } from '../../src/types.js';

function cf(files: Array<{ path: string; status: string }>): ChangedFilesSchema {
  return {
    schema_version: 1,
    base_commit: 'abc',
    files: files.map((f) => ({ path: f.path, status: f.status as any, tracked: true, additions: 1, deletions: 0 })),
  };
}

function defaultConfig(overrides: Partial<FeedbackProtocolConfig> = {}): FeedbackProtocolConfig {
  return {
    enabled: true,
    self_correction: false,
    max_blocks_per_document: 10,
    allowed_types_per_role: {
      planner: ['clarify', 'risk_note', 'followup_task'],
      developer: ['scope_concern', 'verification_suggestion', 'risk_note', 'followup_task'],
      auditor: ['risk_note', 'followup_task'],
      final_auditor: ['risk_note', 'followup_task'],
    },
    ...overrides,
  };
}

describe('Phase 10 failure-safety', () => {
  let tmp: string;
  beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'fb-safe-')); });
  afterEach(async () => { await fs.remove(tmp); });

  describe('scope-guard whitelist for byproduct files', () => {
    it('does not deny orchestrator-owned clarifications.md / followups.md / feedback-notes.md / parse-warnings.md', () => {
      const files = cf([
        { path: '.agent/clarifications.md', status: 'modified' },
        { path: '.agent/followups.md', status: 'modified' },
        { path: '.agent/feedback-notes.md', status: 'modified' },
        { path: '.agent/parse-warnings.md', status: 'modified' },
      ]);
      const res = checkScope({
        allowedChanges: ['src/**'],
        disallowedChanges: [],
        changedFiles: files,
        orchestratorOwnedFiles: [
          '.agent/clarifications.md',
          '.agent/followups.md',
          '.agent/feedback-notes.md',
          '.agent/parse-warnings.md',
        ],
      });
      expect(res.passed).toBe(true);
      expect(res.report.excluded_orchestrator_owned).toEqual(
        expect.arrayContaining([
          '.agent/clarifications.md',
          '.agent/followups.md',
          '.agent/feedback-notes.md',
          '.agent/parse-warnings.md',
        ]),
      );
    });
  });

  describe('parser is not responsible for main-artifact validity', () => {
    it('parses blocks from a valid artifact; an invalid artifact is simply not parsed by the caller', () => {
      const garbage = '```ReviewLoopRequest\nnot: valid: yaml: at: all\n```';
      const res = parseFeedbackBlocks(garbage, 'auditor', 10);
      expect(res.blocks).toHaveLength(0);
      expect(res.errors.length).toBeGreaterThan(0);
      expect(res.errors[0]?.reason).toMatch(/yaml|schema|parse|required/i);
    });
  });

  describe('enabled:false byte-identical inertness', () => {
    it('dispatcher returns all-zero counts and creates no byproduct files when disabled', async () => {
      const artifact = path.join(tmp, '.agent', 'developer-handoff.md');
      await fs.outputFile(
        artifact,
        '```ReviewLoopRequest\ntype: risk_note\norigin_agent: developer\nmessage: m\ncategory: other\ndescription: d\n```',
      );
      const res = await dispatchFeedbackBlocks({
        projectRoot: tmp,
        runId: 'r1',
        role: 'developer',
        artifactPath: artifact,
        config: defaultConfig({ enabled: false }),
      });

      expect(res.blocks_accepted).toBe(0);
      expect(res.blocks_rejected).toBe(0);
      expect(res.clarifications_written).toBe(0);
      expect(res.followups_written).toBe(0);
      expect(res.notes_written).toBe(0);
      expect(res.warnings_written).toBe(0);
      expect(res.notes).toEqual([]);

      expect(fs.existsSync(path.join(tmp, '.agent/clarifications.md'))).toBe(false);
      expect(fs.existsSync(path.join(tmp, '.agent/followups.md'))).toBe(false);
      expect(fs.existsSync(path.join(tmp, '.agent/feedback-notes.md'))).toBe(false);
      expect(fs.existsSync(path.join(tmp, '.agent/parse-warnings.md'))).toBe(false);
    });

    it('dispatcher is inert even when artifact does not exist and disabled', async () => {
      const res = await dispatchFeedbackBlocks({
        projectRoot: tmp,
        runId: 'r1',
        role: 'developer',
        artifactPath: path.join(tmp, 'missing.md'),
        config: defaultConfig({ enabled: false }),
      });

      expect(res.blocks_accepted).toBe(0);
      expect(res.notes).toEqual([]);
    });

    it('parseFeedbackBlocks is a pure function with no side effects', () => {
      const md = '```ReviewLoopRequest\ntype: risk_note\norigin_agent: auditor\nmessage: m\ncategory: other\ndescription: d\n```';
      const res = parseFeedbackBlocks(md, 'auditor', 10);
      expect(res.blocks).toHaveLength(1);
      expect(fs.existsSync(path.join(tmp, '.agent/followups.md'))).toBe(false);
    });
  });
});
