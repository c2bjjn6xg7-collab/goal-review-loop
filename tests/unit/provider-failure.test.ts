import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { classifyProviderFailure, type ProviderFailureClassification } from '../../src/runtime/provider-failure.js';

describe('classifyProviderFailure', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rl-provider-'));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  async function writeStderr(content: string): Promise<string> {
    const p = path.join(tmpDir, 'stderr.log');
    await fs.writeFile(p, content, 'utf8');
    return p;
  }

  it('classifies quota_exhausted when stderr contains quota/credits signals', async () => {
    const stderrPath = await writeStderr('Error: You have run out of credits. Billing limit reached.');
    const result = await classifyProviderFailure({ stderrPath, provider: 'openai', exitCode: 1 });
    expect(result).not.toBeNull();
    expect(result!.classification).toBe('quota_exhausted');
    expect(result!.retry_recommended).toBe(false);
  });

  it('classifies rate_limited when stderr contains 429 / rate limit', async () => {
    const stderrPath = await writeStderr('HTTP 429 Too Many Requests. Rate limit exceeded.');
    const result = await classifyProviderFailure({ stderrPath, provider: 'anthropic', exitCode: 1 });
    expect(result).not.toBeNull();
    expect(result!.classification).toBe('rate_limited');
    expect(result!.retry_recommended).toBe(true);
  });

  it('classifies overloaded when stderr contains overloaded / capacity', async () => {
    const stderrPath = await writeStderr('Error: The server is overloaded. Please try again later.');
    const result = await classifyProviderFailure({ stderrPath, provider: 'anthropic', exitCode: 1 });
    expect(result).not.toBeNull();
    expect(result!.classification).toBe('overloaded');
    expect(result!.retry_recommended).toBe(true);
  });

  it('returns null for non-provider errors (e.g. generic exit 1)', async () => {
    const stderrPath = await writeStderr('Some random error\ncommand not found');
    const result = await classifyProviderFailure({ stderrPath, provider: 'openai', exitCode: 1 });
    expect(result).toBeNull();
  });

  it('returns null when stderr file is missing', async () => {
    const result = await classifyProviderFailure({ stderrPath: path.join(tmpDir, 'nope.log'), provider: 'openai', exitCode: 1 });
    expect(result).toBeNull();
  });

  it('respects exitCode 0 (no failure)', async () => {
    const stderrPath = await writeStderr('out of credits');
    const result = await classifyProviderFailure({ stderrPath, provider: 'openai', exitCode: 0 });
    expect(result).toBeNull();
  });
});
