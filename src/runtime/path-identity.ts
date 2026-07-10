import path from 'path';
import fs from 'fs-extra';

/**
 * Cross-platform path identity helpers shared by git-manager (016) and
 * worktree-manager (017). Windows aliases the same directory through short
 * (8.3) and long names, forward and backward slashes, and ASCII case folding
 * (NTFS). A raw string compare of paths obtained from different sources (Git
 * porcelain output vs Node fs) therefore misidentifies the same physical
 * directory as two different ones.
 *
 * Strategy: prefer FILESYSTEM IDENTITY (fs.stat dev+ino) when both paths exist
 * on disk — this is authoritative across symlinks and 8.3 aliases because the
 * OS resolves any spelling of a path to the same inode/file-id. Fall back to
 * normalized string compare only when a path does not yet exist (e.g. a
 * worktree about to be created). One rule, used by both call sites.
 *
 * NOTE: fs.realpath is NOT used for identity, because on Windows it does not
 * expand 8.3 short names to long names (that is a separate GetLongPathName
 * operation). stat, by contrast, resolves any alias to the same file-id.
 */

const IS_WIN = process.platform === 'win32';

/**
 * Normalize a path string for identity comparison: resolve to absolute, unify
 * separators to forward slashes, and on Windows lowercase the drive letter and
 * whole path (NTFS is case-insensitive). POSIX paths are case-sensitive, so
 * they are left as-is apart from separator unification.
 *
 * IMPORTANT: backslash unification happens ONLY on Windows. On POSIX a
 * backslash is a legal filename character (not a separator), so `a/b` and
 * `a\b` are genuinely different paths and must not be merged.
 */
export function normalizePath(p: string): string {
  const resolved = path.resolve(p);
  if (IS_WIN) {
    return resolved.replace(/\\/g, '/').toLowerCase();
  }
  // POSIX: backslash is a filename character, leave it untouched.
  return resolved;
}

/**
 * Whether two path strings refer to the same physical directory. When both
 * paths exist on disk, compares filesystem identity (stat dev+ino), which is
 * authoritative across symlinks and 8.3 short/long name aliases — the same
 * directory always has the same file-id regardless of how its path is spelled.
 * Falls back to normalized string compare when a path does not exist (e.g. a
 * worktree path before it is created). Never throws.
 */
export async function sameDirectory(a: string, b: string): Promise<boolean> {
  if (normalizePath(a) === normalizePath(b)) return true;
  try {
    const [statA, statB] = await Promise.all([fs.stat(a), fs.stat(b)]);
    return statA.dev === statB.dev && statA.ino === statB.ino;
  } catch {
    return normalizePath(a) === normalizePath(b);
  }
}
