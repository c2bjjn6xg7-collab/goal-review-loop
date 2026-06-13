/**
 * Digest utilities for artifact ownership verification.
 * Phase 3 — §6.2 Role Artifact Ownership
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

/** SHA-256 digest with explicit prefix for unambiguous identification. */
export type Digest = `sha256:${string}`;

/**
 * Compute SHA-256 digest of a string.
 */
export function computeDigest(content: string): Digest {
  const hash = createHash('sha256').update(content, 'utf8').digest('hex');
  return `sha256:${hash}` as Digest;
}

/**
 * Compute SHA-256 digest of a Buffer.
 */
export function computeDigestFromBuffer(content: Buffer): Digest {
  const hash = createHash('sha256').update(content).digest('hex');
  return `sha256:${hash}` as Digest;
}

/**
 * Compute SHA-256 digest of a file's contents.
 */
export async function computeFileDigest(filePath: string): Promise<Digest> {
  const content = await readFile(filePath);
  return computeDigestFromBuffer(content);
}

/**
 * Verify that a digest matches the given content.
 */
export function verifyDigest(content: string, expected: Digest): boolean {
  const actual = computeDigest(content);
  return actual === expected;
}

/**
 * Verify that a file's digest matches the expected value.
 */
export async function verifyFileDigest(filePath: string, expected: Digest): Promise<boolean> {
  if (!existsSync(filePath)) {
    return false;
  }
  try {
    const actual = await computeFileDigest(filePath);
    return actual === expected;
  } catch {
    return false;
  }
}

/**
 * Record of artifact path → digest, used for ownership tracking.
 */
export interface ArtifactDigestRecord {
  readonly path: string;
  readonly digest: Digest;
  readonly exists: boolean;
}

/**
 * Record digests for a set of artifact paths.
 */
export async function recordArtifactDigests(
  paths: string[],
): Promise<ArtifactDigestRecord[]> {
  const records: ArtifactDigestRecord[] = [];
  for (const p of paths) {
    if (existsSync(p)) {
      const digest = await computeFileDigest(p);
      records.push({ path: p, digest, exists: true });
    } else {
      records.push({ path: p, digest: `sha256:${'0'.repeat(64)}` as Digest, exists: false });
    }
  }
  return records;
}

/**
 * Verify that recorded artifacts have not changed.
 */
export async function verifyArtifactDigests(
  records: ArtifactDigestRecord[],
): Promise<ArtifactDigestViolation[]> {
  const violations: ArtifactDigestViolation[] = [];
  for (const record of records) {
    const currentlyExists = existsSync(record.path);
    if (record.exists && !currentlyExists) {
      violations.push({
        path: record.path,
        violation: 'deleted',
        expected: record.digest,
        actual: null,
      });
    } else if (!record.exists && currentlyExists) {
      const actual = await computeFileDigest(record.path);
      violations.push({
        path: record.path,
        violation: 'created',
        expected: null,
        actual,
      });
    } else if (record.exists && currentlyExists) {
      const actual = await computeFileDigest(record.path);
      if (actual !== record.digest) {
        violations.push({
          path: record.path,
          violation: 'modified',
          expected: record.digest,
          actual,
        });
      }
    }
  }
  return violations;
}

export interface ArtifactDigestViolation {
  readonly path: string;
  readonly violation: 'modified' | 'deleted' | 'created';
  readonly expected: Digest | null;
  readonly actual: Digest | null;
}
