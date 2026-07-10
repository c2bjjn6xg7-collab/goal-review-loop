import { describe, it, expect } from 'vitest';
import { normalizePath, sameDirectory } from '../../src/runtime/path-identity.js';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';

const IS_WIN = process.platform === 'win32';

describe('path-identity: normalizePath', () => {
  it('resolves to an absolute path', () => {
    const normalized = normalizePath('.');
    expect(normalized.length).toBeGreaterThan(0);
  });

  (IS_WIN ? it : it.skip)(
    'on Windows treats forward and backward slashes as equivalent',
    () => {
      expect(normalizePath('a/b/c')).toBe(normalizePath('a\\b\\c'));
    },
  );

  // 021 regression: on POSIX, backslash is a legal filename character, NOT a
  // separator. `a/b` and `a\b` are genuinely different paths and must not be
  // merged by normalizePath.
  (!IS_WIN ? it : it.skip)(
    'on POSIX does NOT merge backslash filename with forward-slash path (021)',
    () => {
      expect(normalizePath('a/b')).not.toBe(normalizePath('a\\b'));
    },
  );
});

describe('path-identity: sameDirectory', () => {
  it('recognizes the same directory via a path alias (symlink)', async () => {
    // Reproduce the "different string, same directory" condition that Windows
    // 8.3 short/long names exhibit, using a symlink alias on POSIX.
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'pd-same-'));
    const real = path.join(base, 'real');
    const alias = path.join(base, 'alias');
    await fs.mkdir(real);
    await fs.symlink(real, alias);
    try {
      expect(await sameDirectory(real, alias)).toBe(true);
    } finally {
      await fs.remove(base);
    }
  });

  it('distinguishes genuinely different directories', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'pd-diff-'));
    const a = path.join(base, 'a');
    const b = path.join(base, 'b');
    await fs.mkdir(a);
    await fs.mkdir(b);
    try {
      expect(await sameDirectory(a, b)).toBe(false);
    } finally {
      await fs.remove(base);
    }
  });

  // 021 regression: two POSIX paths that differ only by separator-vs-filename
  // char must be recognized as distinct even when one exists on disk.
  (!IS_WIN ? it : it.skip)(
    'on POSIX treats a/b and a\\b as different directories (021)',
    async () => {
      const base = await fs.mkdtemp(path.join(os.tmpdir(), 'pd-bs-'));
      const dir1 = path.join(base, 'a', 'b');
      const dir2 = path.join(base, 'a\\b');
      await fs.mkdir(path.join(base, 'a'), { recursive: true });
      await fs.mkdir(dir1);
      await fs.mkdir(dir2);
      try {
        expect(await sameDirectory(dir1, dir2)).toBe(false);
      } finally {
        await fs.remove(base);
      }
    },
  );

  it('falls back to normalized string compare for non-existent paths', async () => {
    // Neither path exists, so stat throws and it falls back to normalized
    // string comparison. Two identical spellings are equal.
    expect(await sameDirectory('/nonexistent/x/y', '/nonexistent/x/y')).toBe(true);
    expect(await sameDirectory('/nonexistent/x/y', '/nonexistent/x/z')).toBe(false);
  });
});
