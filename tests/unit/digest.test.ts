/**
 * Unit tests for src/runtime/digest.ts
 */
import { describe, it, expect } from 'vitest';
import { computeDigest, computeDigestFromBuffer, verifyDigest, computeFileDigest, verifyFileDigest, recordArtifactDigests, verifyArtifactDigests } from '../../src/runtime/digest.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('digest', () => {
  describe('computeDigest', () => {
    it('computes sha256 digest with prefix', () => {
      const result = computeDigest('hello');
      expect(result).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it('produces stable digest for same input', () => {
      const a = computeDigest('test content');
      const b = computeDigest('test content');
      expect(a).toBe(b);
    });

    it('produces different digest for different input', () => {
      const a = computeDigest('content a');
      const b = computeDigest('content b');
      expect(a).not.toBe(b);
    });
  });

  describe('computeDigestFromBuffer', () => {
    it('computes digest from Buffer', () => {
      const result = computeDigestFromBuffer(Buffer.from('hello'));
      expect(result).toBe(computeDigest('hello'));
    });
  });

  describe('verifyDigest', () => {
    it('returns true for matching digest', () => {
      const digest = computeDigest('test');
      expect(verifyDigest('test', digest)).toBe(true);
    });

    it('returns false for mismatched digest', () => {
      const digest = computeDigest('test');
      expect(verifyDigest('other', digest)).toBe(false);
    });
  });

  describe('computeFileDigest', () => {
    const testDir = join(tmpdir(), `digest-test-${Date.now()}`);

    afterAll(() => {
      try { rmSync(testDir, { recursive: true }); } catch { /* ok */ }
    });

    it('computes digest of a file', async () => {
      mkdirSync(testDir, { recursive: true });
      const filePath = join(testDir, 'test.txt');
      writeFileSync(filePath, 'file content');
      const digest = await computeFileDigest(filePath);
      expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    });
  });

  describe('verifyFileDigest', () => {
    const testDir = join(tmpdir(), `digest-verify-${Date.now()}`);

    afterAll(() => {
      try { rmSync(testDir, { recursive: true }); } catch { /* ok */ }
    });

    it('returns true for matching file digest', async () => {
      mkdirSync(testDir, { recursive: true });
      const filePath = join(testDir, 'test.txt');
      writeFileSync(filePath, 'file content');
      const digest = await computeFileDigest(filePath);
      expect(await verifyFileDigest(filePath, digest)).toBe(true);
    });

    it('returns false for non-existent file', async () => {
      expect(await verifyFileDigest('/nonexistent/file', 'sha256:' + 'a'.repeat(64))).toBe(false);
    });

    it('returns false for mismatched digest', async () => {
      mkdirSync(testDir, { recursive: true });
      const filePath = join(testDir, 'mismatch.txt');
      writeFileSync(filePath, 'content');
      expect(await verifyFileDigest(filePath, 'sha256:' + '0'.repeat(64))).toBe(false);
    });
  });

  describe('recordArtifactDigests / verifyArtifactDigests', () => {
    const testDir = join(tmpdir(), `digest-record-${Date.now()}`);

    afterAll(() => {
      try { rmSync(testDir, { recursive: true }); } catch { /* ok */ }
    });

    it('records existing and non-existing files', async () => {
      mkdirSync(testDir, { recursive: true });
      const existingPath = join(testDir, 'exists.txt');
      writeFileSync(existingPath, 'content');
      const missingPath = join(testDir, 'missing.txt');

      const records = await recordArtifactDigests([existingPath, missingPath]);
      expect(records).toHaveLength(2);
      expect(records[0].exists).toBe(true);
      expect(records[1].exists).toBe(false);
    });

    it('detects no violations when files unchanged', async () => {
      mkdirSync(testDir, { recursive: true });
      const filePath = join(testDir, 'stable.txt');
      writeFileSync(filePath, 'stable content');

      const records = await recordArtifactDigests([filePath]);
      const violations = await verifyArtifactDigests(records);
      expect(violations).toHaveLength(0);
    });

    it('detects modified file', async () => {
      mkdirSync(testDir, { recursive: true });
      const filePath = join(testDir, 'modified.txt');
      writeFileSync(filePath, 'original');

      const records = await recordArtifactDigests([filePath]);
      writeFileSync(filePath, 'modified');
      const violations = await verifyArtifactDigests(records);
      expect(violations).toHaveLength(1);
      expect(violations[0].violation).toBe('modified');
    });

    it('detects deleted file', async () => {
      mkdirSync(testDir, { recursive: true });
      const filePath = join(testDir, 'deleted.txt');
      writeFileSync(filePath, 'to be deleted');

      const records = await recordArtifactDigests([filePath]);
      rmSync(filePath);
      const violations = await verifyArtifactDigests(records);
      expect(violations).toHaveLength(1);
      expect(violations[0].violation).toBe('deleted');
    });

    it('detects created file', async () => {
      mkdirSync(testDir, { recursive: true });
      const filePath = join(testDir, 'created.txt');

      const records = await recordArtifactDigests([filePath]);
      writeFileSync(filePath, 'new file');
      const violations = await verifyArtifactDigests(records);
      expect(violations).toHaveLength(1);
      expect(violations[0].violation).toBe('created');
    });
  });
});
