/**
 * Unit tests for history archiving extension.
 * Phase 4 §7: archiveIterationFull, isIterationArchived, verifyArchiveIdempotent.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import { ArtifactStore } from '../../src/artifacts/artifact-store.js';
import { atomicWriteFile } from '../../src/runtime/atomic-file.js';

describe('archiveIterationFull', () => {
  let tmpDir: string;
  let store: ArtifactStore;

  beforeEach(async () => {
    tmpDir = path.join(process.cwd(), '.test-archive-' + Date.now());
    await fs.ensureDir(tmpDir);
    store = new ArtifactStore(tmpDir);
    await store.init();
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('archives handoff, audit-report, and rework-instructions', async () => {
    // Write artifacts
    await atomicWriteFile(path.join(tmpDir, '.agent', 'developer-handoff.md'), 'handoff content');
    await atomicWriteFile(path.join(tmpDir, '.agent', 'audit-report.md'), 'audit content');
    await atomicWriteFile(path.join(tmpDir, '.agent', 'rework-instructions.md'), 'rework content');

    await store.archiveIterationFull(1);

    const historyDir = path.join(tmpDir, '.agent', 'history', 'iteration-01');
    expect(await fs.pathExists(path.join(historyDir, 'developer-handoff.md'))).toBe(true);
    expect(await fs.pathExists(path.join(historyDir, 'audit-report.md'))).toBe(true);
    expect(await fs.pathExists(path.join(historyDir, 'rework-instructions.md'))).toBe(true);
  });

  it('archives verification directory', async () => {
    const verDir = path.join(tmpDir, '.agent', 'verification', 'iteration-01');
    await fs.ensureDir(verDir);
    await atomicWriteFile(path.join(verDir, 'manifest.json'), '{"passed": true}');

    await store.archiveIterationFull(1);

    const archivedVerDir = path.join(tmpDir, '.agent', 'history', 'iteration-01', 'verification');
    expect(await fs.pathExists(archivedVerDir)).toBe(true);
    expect(await fs.pathExists(path.join(archivedVerDir, 'manifest.json'))).toBe(true);
  });

  it('archives evidence directory', async () => {
    const evDir = path.join(tmpDir, '.agent', 'evidence', 'iteration-01');
    await fs.ensureDir(evDir);
    await atomicWriteFile(path.join(evDir, 'scope-report.json'), '{"passed": true}');

    await store.archiveIterationFull(1);

    const archivedEvDir = path.join(tmpDir, '.agent', 'history', 'iteration-01', 'evidence');
    expect(await fs.pathExists(archivedEvDir)).toBe(true);
    expect(await fs.pathExists(path.join(archivedEvDir, 'scope-report.json'))).toBe(true);
  });

  it('handles missing artifacts gracefully', async () => {
    // Only write handoff, not audit or rework
    await atomicWriteFile(path.join(tmpDir, '.agent', 'developer-handoff.md'), 'handoff content');

    await store.archiveIterationFull(1);

    const historyDir = path.join(tmpDir, '.agent', 'history', 'iteration-01');
    expect(await fs.pathExists(path.join(historyDir, 'developer-handoff.md'))).toBe(true);
    expect(await fs.pathExists(path.join(historyDir, 'audit-report.md'))).toBe(false);
    expect(await fs.pathExists(path.join(historyDir, 'rework-instructions.md'))).toBe(false);
  });
});

describe('isIterationArchived', () => {
  let tmpDir: string;
  let store: ArtifactStore;

  beforeEach(async () => {
    tmpDir = path.join(process.cwd(), '.test-archive-check-' + Date.now());
    await fs.ensureDir(tmpDir);
    store = new ArtifactStore(tmpDir);
    await store.init();
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('returns false when not archived', async () => {
    expect(await store.isIterationArchived(1)).toBe(false);
  });

  it('returns true after archiving', async () => {
    await store.archiveIterationFull(1);
    expect(await store.isIterationArchived(1)).toBe(true);
  });
});

describe('verifyArchiveIdempotent', () => {
  let tmpDir: string;
  let store: ArtifactStore;

  beforeEach(async () => {
    tmpDir = path.join(process.cwd(), '.test-archive-idempotent-' + Date.now());
    await fs.ensureDir(tmpDir);
    store = new ArtifactStore(tmpDir);
    await store.init();
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('returns safe when no previous archive exists', async () => {
    const result = await store.verifyArchiveIdempotent(1, {});
    expect(result.safe).toBe(true);
  });

  it('returns safe when digests match', async () => {
    // Archive first
    await atomicWriteFile(path.join(tmpDir, '.agent', 'developer-handoff.md'), 'handoff content');
    await store.archiveIterationFull(1);

    // Compute digest of archived file
    const archivedContent = await fs.readFile(
      path.join(tmpDir, '.agent', 'history', 'iteration-01', 'developer-handoff.md'),
      'utf8',
    );
    const crypto = await import('node:crypto');
    const digest = `sha256:${crypto.createHash('sha256').update(archivedContent).digest('hex')}`;

    const result = await store.verifyArchiveIdempotent(1, {
      'developer-handoff.md': digest,
    });
    expect(result.safe).toBe(true);
  });

  it('returns unsafe when digests mismatch', async () => {
    // Archive first
    await atomicWriteFile(path.join(tmpDir, '.agent', 'developer-handoff.md'), 'handoff content');
    await store.archiveIterationFull(1);

    const result = await store.verifyArchiveIdempotent(1, {
      'developer-handoff.md': 'sha256:' + '0'.repeat(64),
    });
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('does not match');
  });
});
