/**
 * Unit tests for OrchestratorFileRegistry and verifySystemProtectedPaths.
 * F-307R2: Developer evidence forgery prevention.
 *
 * These tests verify the explicit ownership tracking that replaces
 * pattern-based inference of orchestrator-owned files.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join, sep } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, lstatSync, symlinkSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// We need to test the OrchestratorFileRegistry class and verifySystemProtectedPaths
// which are not exported. We'll test them through the module's internal behavior
// by importing and re-testing via the integration test patterns.
//
// Since the registry class and verification function are private to run-orchestrator.ts,
// we test them indirectly through the scope guard integration.
// However, we can extract and test the core logic by duplicating the class
// for unit testing purposes.

// ─── OrchestratorFileRegistry (mirrored for unit testing) ─────────────

interface OrchestratorFileRegistryEntry {
  path: string;
  digest: string;
  registered_at: string;
}

class OrchestratorFileRegistry {
  private entries: OrchestratorFileRegistryEntry[] = [];

  register(filePath: string, digest: string): void {
    const existing = this.entries.findIndex(e => e.path === filePath);
    const entry: OrchestratorFileRegistryEntry = {
      path: filePath,
      digest,
      registered_at: new Date().toISOString(),
    };
    if (existing >= 0) {
      this.entries[existing] = entry;
    } else {
      this.entries.push(entry);
    }
  }

  getRelativePaths(projectRoot: string): string[] {
    return this.entries.map(e => {
      const rel = e.path.startsWith(projectRoot)
        ? e.path.slice(projectRoot.length + 1)
        : e.path;
      return rel.split(sep).join('/');
    });
  }

  getEntries(): ReadonlyArray<OrchestratorFileRegistryEntry> {
    return this.entries;
  }
}

// ─── verifySystemProtectedPaths (mirrored for unit testing) ──────────

interface OrchestratorRegistryViolation {
  path: string;
  violation: 'digest_mismatch' | 'deleted' | 'mode_changed' | 'symlink_created' | 'unregistered_new';
  message: string;
}

interface OrchestratorRegistryVerificationResult {
  valid: boolean;
  violations: OrchestratorRegistryViolation[];
}

function computeDigest(content: string): string {
  const { createHash } = require('node:crypto');
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

async function verifySystemProtectedPaths(
  projectRoot: string,
  registry: OrchestratorFileRegistry,
  preDevSystemPaths: Map<string, { digest: string; mode: number; isSymlink: boolean }>,
): Promise<OrchestratorRegistryVerificationResult> {
  const violations: OrchestratorRegistryViolation[] = [];
  const agentDir = join(projectRoot, '.agent');

  // 1. Verify all registered files that existed before Developer are intact
  for (const entry of registry.getEntries()) {
    const existedBeforeDev = preDevSystemPaths.has(entry.path);

    if (!existsSync(entry.path)) {
      if (existedBeforeDev) {
        violations.push({
          path: entry.path,
          violation: 'deleted',
          message: `Orchestrator-registered file was deleted: ${entry.path}`,
        });
      }
      continue;
    }

    const preDev = preDevSystemPaths.get(entry.path);
    if (preDev && !preDev.isSymlink) {
      try {
        const stat = lstatSync(entry.path);
        if (stat.isSymbolicLink()) {
          violations.push({
            path: entry.path,
            violation: 'symlink_created',
            message: `Orchestrator-registered file was replaced with symlink: ${entry.path}`,
          });
          continue;
        }
      } catch {
        violations.push({
          path: entry.path,
          violation: 'deleted',
          message: `Cannot stat orchestrator-registered file: ${entry.path}`,
        });
        continue;
      }
    }

    if (existedBeforeDev && preDev) {
      try {
        const currentDigest = computeDigest(readFileSync(entry.path, 'utf8'));
        if (currentDigest !== preDev.digest) {
          violations.push({
            path: entry.path,
            violation: 'digest_mismatch',
            message: `Orchestrator-registered file was modified: ${entry.path}`,
          });
        }
      } catch {
        violations.push({
          path: entry.path,
          violation: 'deleted',
          message: `Cannot read orchestrator-registered file: ${entry.path}`,
        });
      }
    }
  }

  // 2. Verify all pre-Developer system-protected paths still exist with matching digests
  for (const [filePath, preDevInfo] of preDevSystemPaths) {
    const relPath = filePath.startsWith(projectRoot)
      ? filePath.slice(projectRoot.length + 1).split(sep).join('/')
      : filePath;
    if (relPath === '.agent/developer-handoff.md') continue;
    if (registry.getEntries().some(e => e.path === filePath)) continue;

    if (!existsSync(filePath)) {
      violations.push({
        path: filePath,
        violation: 'deleted',
        message: `System-protected file was deleted: ${filePath}`,
      });
      continue;
    }

    if (!preDevInfo.isSymlink) {
      try {
        const stat = lstatSync(filePath);
        if (stat.isSymbolicLink()) {
          violations.push({
            path: filePath,
            violation: 'symlink_created',
            message: `System-protected file was replaced with symlink: ${filePath}`,
          });
          continue;
        }
      } catch {
        continue;
      }
    }

    try {
      const currentDigest = computeDigest(readFileSync(filePath, 'utf8'));
      if (currentDigest !== preDevInfo.digest) {
        violations.push({
          path: filePath,
          violation: 'digest_mismatch',
          message: `System-protected file was modified: ${filePath}`,
        });
      }
    } catch {
      violations.push({
        path: filePath,
        violation: 'deleted',
        message: `Cannot read system-protected file: ${filePath}`,
      });
    }
  }

  // 3. Scan system-protected directories for new unregistered files
  const protectedDirs = [
    join(agentDir, 'evidence'),
    join(agentDir, 'verification'),
    join(agentDir, 'history'),
    join(agentDir, 'debug'),
  ];

  const registeredPaths = new Set(registry.getEntries().map(e => e.path));
  const preDevPaths = new Set(preDevSystemPaths.keys());

  for (const dir of protectedDirs) {
    if (!existsSync(dir)) continue;
    try {
      const { readdirSync } = require('node:fs');
      const entries = readdirSync(dir, { recursive: true, withFileTypes: false });
      for (const entry of entries) {
        const fullPath = join(dir, String(entry));
        if (!existsSync(fullPath)) continue;
        try {
          const stat = lstatSync(fullPath);
          if (stat.isDirectory()) continue;
        } catch { continue; }

        if (!registeredPaths.has(fullPath) && !preDevPaths.has(fullPath)) {
          violations.push({
            path: fullPath,
            violation: 'unregistered_new',
            message: `New file in system-protected directory not registered by orchestrator: ${fullPath}`,
          });
        }
      }
    } catch {
      // Cannot read directory — skip
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

// ─── Test Helpers ─────────────────────────────────────────────────────

function makeTempDir(): string {
  const dir = join(tmpdir(), `registry-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, '.agent'), { recursive: true });
  mkdirSync(join(dir, '.agent', 'evidence'), { recursive: true });
  mkdirSync(join(dir, '.agent', 'verification'), { recursive: true });
  mkdirSync(join(dir, '.agent', 'debug'), { recursive: true });
  mkdirSync(join(dir, '.agent', 'history'), { recursive: true });
  return dir;
}

function writeFile(dir: string, relPath: string, content: string): string {
  const fullPath = join(dir, relPath);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, content, 'utf8');
  return fullPath;
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('OrchestratorFileRegistry', () => {
  it('registers files and returns relative paths', () => {
    const registry = new OrchestratorFileRegistry();
    const projectRoot = '/tmp/test-project';

    registry.register('/tmp/test-project/.agent/state.json', 'sha256:abc123');
    registry.register('/tmp/test-project/.agent/evidence/iteration-01/changed-files.json', 'sha256:def456');

    const paths = registry.getRelativePaths(projectRoot);
    expect(paths).toEqual([
      '.agent/state.json',
      '.agent/evidence/iteration-01/changed-files.json',
    ]);
  });

  it('de-duplicates entries on re-registration', () => {
    const registry = new OrchestratorFileRegistry();
    const projectRoot = '/tmp/test-project';

    registry.register('/tmp/test-project/.agent/state.json', 'sha256:abc123');
    registry.register('/tmp/test-project/.agent/state.json', 'sha256:updated');

    const entries = registry.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].digest).toBe('sha256:updated');
  });

  it('returns empty array when no files registered', () => {
    const registry = new OrchestratorFileRegistry();
    const paths = registry.getRelativePaths('/tmp/test-project');
    expect(paths).toEqual([]);
  });

  it('converts platform-specific separators to forward slashes', () => {
    const registry = new OrchestratorFileRegistry();
    const projectRoot = '/tmp/test-project';
    // Register with platform-native path (on macOS/Linux this uses /)
    registry.register(`${projectRoot}/.agent/state.json`, 'sha256:abc');

    const paths = registry.getRelativePaths(projectRoot);
    // Should always produce forward slashes regardless of platform
    expect(paths[0]).toBe('.agent/state.json');
  });

  it('preserves registration timestamp', () => {
    const registry = new OrchestratorFileRegistry();
    const before = new Date().toISOString();

    registry.register('/tmp/test-project/.agent/state.json', 'sha256:abc');

    const after = new Date().toISOString();
    const entry = registry.getEntries()[0];
    expect(entry.registered_at >= before).toBe(true);
    expect(entry.registered_at <= after).toBe(true);
  });
});

describe('verifySystemProtectedPaths', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns valid when no violations exist', async () => {
    const statePath = writeFile(tempDir, '.agent/state.json', '{"phase":"DEVELOPING"}');
    const digest = computeDigest('{"phase":"DEVELOPING"}');

    const registry = new OrchestratorFileRegistry();
    registry.register(statePath, digest);

    const preDevSystemPaths = new Map([
      [statePath, { digest, mode: 0o644, isSymlink: false }],
    ]);

    const result = await verifySystemProtectedPaths(tempDir, registry, preDevSystemPaths);
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('detects digest mismatch on pre-Developer files', async () => {
    const statePath = writeFile(tempDir, '.agent/state.json', '{"phase":"DEVELOPING"}');
    const originalDigest = computeDigest('{"phase":"DEVELOPING"}');

    const registry = new OrchestratorFileRegistry();
    registry.register(statePath, originalDigest);

    const preDevSystemPaths = new Map([
      [statePath, { digest: originalDigest, mode: 0o644, isSymlink: false }],
    ]);

    // Developer modifies the file
    writeFileSync(statePath, '{"phase":"FINALIZING"}', 'utf8');

    const result = await verifySystemProtectedPaths(tempDir, registry, preDevSystemPaths);
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].violation).toBe('digest_mismatch');
    expect(result.violations[0].path).toBe(statePath);
  });

  it('detects deletion of pre-Developer files', async () => {
    const statePath = writeFile(tempDir, '.agent/state.json', '{"phase":"DEVELOPING"}');
    const digest = computeDigest('{"phase":"DEVELOPING"}');

    const registry = new OrchestratorFileRegistry();
    registry.register(statePath, digest);

    const preDevSystemPaths = new Map([
      [statePath, { digest, mode: 0o644, isSymlink: false }],
    ]);

    // Developer deletes the file
    rmSync(statePath);

    const result = await verifySystemProtectedPaths(tempDir, registry, preDevSystemPaths);
    expect(result.valid).toBe(false);
    expect(result.violations.some(v => v.violation === 'deleted')).toBe(true);
  });

  it('detects unregistered new files in protected directories', async () => {
    const registry = new OrchestratorFileRegistry();
    const preDevSystemPaths = new Map<string, { digest: string; mode: number; isSymlink: boolean }>();

    // Developer creates a forged file in .agent/evidence/
    writeFile(tempDir, '.agent/evidence/forged.json', '{"fake": true}');

    const result = await verifySystemProtectedPaths(tempDir, registry, preDevSystemPaths);
    expect(result.valid).toBe(false);
    expect(result.violations.some(v => v.violation === 'unregistered_new')).toBe(true);
  });

  it('allows developer-handoff.md modification', async () => {
    const handoffPath = writeFile(tempDir, '.agent/developer-handoff.md', 'status: COMPLETED');
    const originalDigest = computeDigest('status: COMPLETED');

    const registry = new OrchestratorFileRegistry();
    const preDevSystemPaths = new Map([
      [handoffPath, { digest: originalDigest, mode: 0o644, isSymlink: false }],
    ]);

    // Developer modifies handoff (allowed)
    writeFileSync(handoffPath, 'status: BLOCKED', 'utf8');

    const result = await verifySystemProtectedPaths(tempDir, registry, preDevSystemPaths);
    // developer-handoff.md should be excluded from violation checks
    expect(result.valid).toBe(true);
  });

  it('does not check digest for files registered after Developer', async () => {
    // Files registered after Developer (e.g. evidence files) should not
    // cause digest_mismatch violations even if the orchestrator modifies them
    const evidencePath = writeFile(tempDir, '.agent/evidence/iteration-01/changed-files.json', '{"files":[]}');
    const digest = computeDigest('{"files":[]}');

    const registry = new OrchestratorFileRegistry();
    registry.register(evidencePath, digest);

    // No preDevSystemPaths entry for this file — it was registered after Developer
    const preDevSystemPaths = new Map<string, { digest: string; mode: number; isSymlink: boolean }>();

    // Orchestrator modifies the evidence file after registration
    writeFileSync(evidencePath, '{"files":[{"path":"src/test.ts"}]}', 'utf8');

    const result = await verifySystemProtectedPaths(tempDir, registry, preDevSystemPaths);
    expect(result.valid).toBe(true);
  });

  it('detects symlink replacement of registered files', async () => {
    const statePath = writeFile(tempDir, '.agent/state.json', '{"phase":"DEVELOPING"}');
    const digest = computeDigest('{"phase":"DEVELOPING"}');

    const registry = new OrchestratorFileRegistry();
    registry.register(statePath, digest);

    const preDevSystemPaths = new Map([
      [statePath, { digest, mode: 0o644, isSymlink: false }],
    ]);

    // Developer replaces the file with a symlink
    rmSync(statePath);
    const targetPath = writeFile(tempDir, 'malicious.json', '{"phase":"PASSED"}');
    try {
      symlinkSync(targetPath, statePath);
    } catch {
      // Symlinks may not be supported on this platform (Windows without admin)
      return;
    }

    const result = await verifySystemProtectedPaths(tempDir, registry, preDevSystemPaths);
    expect(result.valid).toBe(false);
    expect(result.violations.some(v => v.violation === 'symlink_created')).toBe(true);
  });

  it('detects unregistered new files in .agent/debug/', async () => {
    const registry = new OrchestratorFileRegistry();
    const preDevSystemPaths = new Map<string, { digest: string; mode: number; isSymlink: boolean }>();

    // Developer creates a forged file in .agent/debug/
    writeFile(tempDir, '.agent/debug/fake-debug.log', 'forged debug output');

    const result = await verifySystemProtectedPaths(tempDir, registry, preDevSystemPaths);
    expect(result.valid).toBe(false);
    expect(result.violations.some(v => v.violation === 'unregistered_new')).toBe(true);
  });

  it('detects unregistered new files in .agent/verification/', async () => {
    const registry = new OrchestratorFileRegistry();
    const preDevSystemPaths = new Map<string, { digest: string; mode: number; isSymlink: boolean }>();

    // Developer creates a forged file in .agent/verification/
    writeFile(tempDir, '.agent/verification/fake-result.json', '{"passed": true}');

    const result = await verifySystemProtectedPaths(tempDir, registry, preDevSystemPaths);
    expect(result.valid).toBe(false);
    expect(result.violations.some(v => v.violation === 'unregistered_new')).toBe(true);
  });

  it('detects unregistered new files in .agent/history/', async () => {
    const registry = new OrchestratorFileRegistry();
    const preDevSystemPaths = new Map<string, { digest: string; mode: number; isSymlink: boolean }>();

    // Developer creates a forged file in .agent/history/
    writeFile(tempDir, '.agent/history/fake-history.json', '{"forged": true}');

    const result = await verifySystemProtectedPaths(tempDir, registry, preDevSystemPaths);
    expect(result.valid).toBe(false);
    expect(result.violations.some(v => v.violation === 'unregistered_new')).toBe(true);
  });

  it('allows registered new files in protected directories', async () => {
    const evidencePath = writeFile(tempDir, '.agent/evidence/iteration-01/changed-files.json', '{"files":[]}');
    const digest = computeDigest('{"files":[]}');

    const registry = new OrchestratorFileRegistry();
    registry.register(evidencePath, digest);

    const preDevSystemPaths = new Map<string, { digest: string; mode: number; isSymlink: boolean }>();

    const result = await verifySystemProtectedPaths(tempDir, registry, preDevSystemPaths);
    expect(result.valid).toBe(true);
  });

  it('detects modification of pre-Developer files not in registry', async () => {
    const planPath = writeFile(tempDir, '.agent/plan.md', '# Plan v1');
    const originalDigest = computeDigest('# Plan v1');

    // plan.md is in preDevSystemPaths but NOT in the registry
    const registry = new OrchestratorFileRegistry();
    const preDevSystemPaths = new Map([
      [planPath, { digest: originalDigest, mode: 0o644, isSymlink: false }],
    ]);

    // Developer modifies plan.md
    writeFileSync(planPath, '# Plan v2 (modified by Developer)', 'utf8');

    const result = await verifySystemProtectedPaths(tempDir, registry, preDevSystemPaths);
    expect(result.valid).toBe(false);
    expect(result.violations.some(v => v.violation === 'digest_mismatch')).toBe(true);
  });

  it('reports multiple violations simultaneously', async () => {
    const statePath = writeFile(tempDir, '.agent/state.json', '{"phase":"DEVELOPING"}');
    const stateDigest = computeDigest('{"phase":"DEVELOPING"}');

    const registry = new OrchestratorFileRegistry();
    registry.register(statePath, stateDigest);

    const preDevSystemPaths = new Map([
      [statePath, { digest: stateDigest, mode: 0o644, isSymlink: false }],
    ]);

    // Multiple violations: modify state.json AND create forged evidence
    writeFileSync(statePath, '{"phase":"PASSED"}', 'utf8');
    writeFile(tempDir, '.agent/evidence/forged.json', '{"fake": true}');

    const result = await verifySystemProtectedPaths(tempDir, registry, preDevSystemPaths);
    expect(result.valid).toBe(false);
    expect(result.violations.length).toBeGreaterThanOrEqual(2);
    expect(result.violations.some(v => v.violation === 'digest_mismatch')).toBe(true);
    expect(result.violations.some(v => v.violation === 'unregistered_new')).toBe(true);
  });
});
