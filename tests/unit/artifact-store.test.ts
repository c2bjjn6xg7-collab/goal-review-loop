import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { ArtifactStore, ARTIFACT_FILES } from '../../src/artifacts/artifact-store.js';

describe('Artifact Store', () => {
  let tmpDir: string;
  let store: ArtifactStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-loop-test-'));
    store = new ArtifactStore(tmpDir);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  describe('init', () => {
    it('should create .agent/ directory structure', async () => {
      await store.init();
      expect(await fs.pathExists(store.agentDir)).toBe(true);
      expect(await fs.pathExists(path.join(store.agentDir, 'verification'))).toBe(true);
      expect(await fs.pathExists(path.join(store.agentDir, 'history'))).toBe(true);
      expect(await fs.pathExists(path.join(store.agentDir, 'evidence'))).toBe(true);
      expect(await fs.pathExists(path.join(store.agentDir, 'debug'))).toBe(true);
    });
  });

  describe('write and read', () => {
    beforeEach(async () => {
      await store.init();
    });

    it('should write and read an artifact', async () => {
      await store.write(ARTIFACT_FILES.PLAN, '# Plan\nContent');
      const content = await store.read(ARTIFACT_FILES.PLAN);
      expect(content).toBe('# Plan\nContent');
    });

    it('should throw when reading non-existent artifact', async () => {
      await expect(store.read(ARTIFACT_FILES.GOAL)).rejects.toThrow('not found');
    });

    it('should check if artifact exists', async () => {
      expect(await store.has(ARTIFACT_FILES.PLAN)).toBe(false);
      await store.write(ARTIFACT_FILES.PLAN, 'content');
      expect(await store.has(ARTIFACT_FILES.PLAN)).toBe(true);
    });
  });

  describe('archiveIteration', () => {
    beforeEach(async () => {
      await store.init();
    });

    it('should archive handoff and audit to history', async () => {
      // Write handoff and audit
      await store.write(ARTIFACT_FILES.HANDOFF, 'handoff content');
      await store.write(ARTIFACT_FILES.AUDIT_REPORT, 'audit content');

      // Archive iteration 1
      await store.archiveIteration(1);

      // Check history
      const historyDir = path.join(store.agentDir, 'history', 'iteration-01');
      expect(await fs.pathExists(historyDir)).toBe(true);
      expect(await fs.readFile(path.join(historyDir, ARTIFACT_FILES.HANDOFF), 'utf8')).toBe('handoff content');
      expect(await fs.readFile(path.join(historyDir, ARTIFACT_FILES.AUDIT_REPORT), 'utf8')).toBe('audit content');
    });

    it('should handle missing handoff gracefully', async () => {
      await store.write(ARTIFACT_FILES.AUDIT_REPORT, 'audit content');
      await store.archiveIteration(1);

      const historyDir = path.join(store.agentDir, 'history', 'iteration-01');
      expect(await fs.pathExists(path.join(historyDir, ARTIFACT_FILES.HANDOFF))).toBe(false);
      expect(await fs.pathExists(path.join(historyDir, ARTIFACT_FILES.AUDIT_REPORT))).toBe(true);
    });
  });

  describe('appendIterationLog', () => {
    beforeEach(async () => {
      await store.init();
    });

    it('should append entries to iteration log', async () => {
      await store.appendIterationLog('preflight PASS');
      await store.appendIterationLog('planning completed');

      const content = await fs.readFile(
        path.join(store.agentDir, ARTIFACT_FILES.ITERATION_LOG),
        'utf8',
      );

      expect(content).toContain('preflight PASS');
      expect(content).toContain('planning completed');
    });
  });

  describe('updateGitignore', () => {
    beforeEach(async () => {
      await store.init();
    });

    it('should create .gitignore if it does not exist', async () => {
      await store.updateGitignore();
      const gitignorePath = path.join(tmpDir, '.gitignore');
      expect(await fs.pathExists(gitignorePath)).toBe(true);

      const content = await fs.readFile(gitignorePath, 'utf8');
      // Catch-all .agent/** ignores all runtime artifacts
      expect(content).toContain('.agent/**');
    });

    it('should append to existing .gitignore', async () => {
      const gitignorePath = path.join(tmpDir, '.gitignore');
      await fs.writeFile(gitignorePath, 'node_modules/\n', 'utf8');

      await store.updateGitignore();
      const content = await fs.readFile(gitignorePath, 'utf8');
      expect(content).toContain('node_modules/');
      expect(content).toContain('.agent/**');
    });

    it('should not duplicate entries', async () => {
      await store.updateGitignore();
      await store.updateGitignore(); // Second call

      const content = await fs.readFile(path.join(tmpDir, '.gitignore'), 'utf8');
      // Count occurrences of .agent/**
      const matches = content.match(/\.agent\/\*\*/g);
      expect(matches).toHaveLength(1);
    });
  });

  describe('verificationDir / evidenceDir', () => {
    it('should return correct paths', () => {
      expect(store.verificationDir(1)).toMatch(/verification\/iteration-01$/);
      expect(store.verificationDir(10)).toMatch(/verification\/iteration-10$/);
      expect(store.evidenceDir(1)).toMatch(/evidence\/iteration-01$/);
    });
  });
});