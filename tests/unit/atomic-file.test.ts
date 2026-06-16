import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { atomicWriteFile, atomicWriteJSON } from '../../src/runtime/atomic-file.js';

describe('Atomic File Write', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-loop-test-'));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('should write file content atomically', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    await atomicWriteFile(filePath, 'hello world');
    const content = await fs.readFile(filePath, 'utf8');
    expect(content).toBe('hello world');
  });

  it('should overwrite existing file', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    await atomicWriteFile(filePath, 'first');
    await atomicWriteFile(filePath, 'second');
    const content = await fs.readFile(filePath, 'utf8');
    expect(content).toBe('second');
  });

  it('should create parent directories', async () => {
    const filePath = path.join(tmpDir, 'sub', 'dir', 'test.txt');
    await atomicWriteFile(filePath, 'nested');
    const content = await fs.readFile(filePath, 'utf8');
    expect(content).toBe('nested');
  });

  it('should write JSON atomically', async () => {
    const filePath = path.join(tmpDir, 'test.json');
    await atomicWriteJSON(filePath, { key: 'value', num: 42 });
    const content = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(content);
    expect(parsed).toEqual({ key: 'value', num: 42 });
  });

  it('should produce pretty-printed JSON', async () => {
    const filePath = path.join(tmpDir, 'test.json');
    await atomicWriteJSON(filePath, { a: 1 });
    const content = await fs.readFile(filePath, 'utf8');
    expect(content).toContain('\n'); // pretty printed
    expect(content.endsWith('\n')).toBe(true); // trailing newline
  });

  it('should not leave temp files on success', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    await atomicWriteFile(filePath, 'clean');
    const files = await fs.readdir(tmpDir);
    expect(files).toEqual(['test.txt']);
  });

  it('should not leave temp files on failure', async () => {
    // Create a read-only directory to force write failure
    const readOnlyDir = path.join(tmpDir, 'readonly');
    await fs.ensureDir(readOnlyDir);
    await fs.chmod(readOnlyDir, 0o444);

    const filePath = path.join(readOnlyDir, 'subdir', 'test.txt');
    try {
      await atomicWriteFile(filePath, 'fail');
    } catch {
      // Expected to fail
    }

    // No temp files should remain
    const files = await fs.readdir(readOnlyDir);
    const tmpFiles = files.filter((f) => f.startsWith('.tmp-'));
    expect(tmpFiles).toHaveLength(0);

    // Restore permissions for cleanup
    await fs.chmod(readOnlyDir, 0o755);
  });
});