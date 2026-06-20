import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

interface RootReviewLoopConfig {
  agents?: {
    developer?: {
      command?: unknown;
    };
  };
}

describe('root review-loop.yaml', () => {
  it('keeps a Claude Developer heartbeat to avoid false idle timeouts', () => {
    const rawConfig = readFileSync('review-loop.yaml', 'utf8');
    const config = yaml.load(rawConfig) as RootReviewLoopConfig;
    const command = config.agents?.developer?.command;

    expect(Array.isArray(command)).toBe(true);

    const shellCommand = (command as string[]).join('\n');
    expect(shellCommand).toContain('claude -p');
    expect(shellCommand).toContain('REVIEW_LOOP_DEVELOPER_HEARTBEAT_SECONDS');
    expect(shellCommand).toContain('[review-loop heartbeat] claude developer still running');
    expect(shellCommand).toContain('env -u HTTP_PROXY');
    expect(shellCommand).toContain('kill "$heartbeat_pid"');
    expect(shellCommand).toContain('exit "$status"');
  });
});
