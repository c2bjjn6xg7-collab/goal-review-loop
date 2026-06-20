import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

interface RootReviewLoopConfig {
  agents?: {
    planner?: {
      command?: unknown;
    };
    developer?: {
      command?: unknown;
    };
    auditor?: {
      command?: unknown;
    };
    final_auditor?: {
      command?: unknown;
    };
  };
}

describe('root review-loop.yaml', () => {
  it('uses Claude for Planner to reduce Codex usage', () => {
    const rawConfig = readFileSync('review-loop.yaml', 'utf8');
    const config = yaml.load(rawConfig) as RootReviewLoopConfig;
    const command = config.agents?.planner?.command;

    expect(Array.isArray(command)).toBe(true);

    const shellCommand = (command as string[]).join('\n');
    expect(shellCommand).toContain('claude -p');
    expect(shellCommand).toContain('REVIEW_LOOP_PLANNER_HEARTBEAT_SECONDS');
    expect(shellCommand).toContain('[review-loop heartbeat] claude planner still running');
    expect(shellCommand).toContain('env -u HTTP_PROXY');
    expect(shellCommand).toContain('kill "$heartbeat_pid"');
    expect(shellCommand).toContain('exit "$status"');
    expect(shellCommand).not.toContain('codex exec');
  });

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

  it('keeps Auditor and Final Auditor on Codex as the stronger review gates', () => {
    const rawConfig = readFileSync('review-loop.yaml', 'utf8');
    const config = yaml.load(rawConfig) as RootReviewLoopConfig;

    expect(config.agents?.auditor?.command).toEqual(['codex', 'exec', '-s', 'workspace-write', '{prompt_file}']);
    expect(config.agents?.final_auditor?.command).toEqual(['codex', 'exec', '-s', 'workspace-write', '{prompt_file}']);
  });
});
