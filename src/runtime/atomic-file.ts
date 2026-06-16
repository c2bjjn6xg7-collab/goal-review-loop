/**
 * Atomic file write — write-then-rename for crash safety.
 * Design doc §7.1: "先写临时文件，再 fsync，最后原子 rename"
 */
import fs from 'fs-extra';
import path from 'path';

/**
 * Write data to a file atomically using write-then-rename.
 * 1. Write to a temp file in the same directory
 * 2. fsync the temp file
 * 3. Rename temp file to target (atomic on same filesystem)
 */
export async function atomicWriteFile(filePath: string, data: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.ensureDir(dir);

  const tmpFile = path.join(dir, `.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  try {
    // Write to temp file using fs.promises for proper FileHandle support
    const fileHandle = await fs.promises.open(tmpFile, 'w');
    try {
      await fileHandle.writeFile(data, 'utf8');
      await fileHandle.sync(); // fsync
    } finally {
      await fileHandle.close();
    }

    // Atomic rename
    await fs.rename(tmpFile, filePath);
  } catch (err) {
    // Clean up temp file on failure
    try {
      await fs.unlink(tmpFile);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}

/**
 * Write JSON data atomically with pretty formatting.
 */
export async function atomicWriteJSON(filePath: string, data: unknown): Promise<void> {
  const json = JSON.stringify(data, null, 2) + '\n';
  await atomicWriteFile(filePath, json);
}
