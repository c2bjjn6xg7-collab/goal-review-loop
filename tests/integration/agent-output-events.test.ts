/**
 * Integration test for Phase 9 R5: real-time agent output streaming.
 *
 * Spawns a fake agent that writes a <thinking> block, visible text, and a
 * JSON tool_use line to stdout, then sleeps until aborted. Verifies that
 * events.jsonl contains role.output events with filtered text (no 'secret',
 * no 'tool_use'), a role.heartbeat event, and that the on-disk stdout
 * transcript still contains the raw thinking block and JSON line.
 *
 * The heartbeat interval is shortened via the AGENT_HEARTBEAT_INTERVAL_MS env
 * var (a test-only injection point in agent-adapter.ts) so the test does not
 * wait 30 seconds for a heartbeat.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runAgent } from '../../src/agents/agent-adapter.js';
import { EventBus } from '../../src/runtime/event-bus.js';
import { EventStore } from '../../src/runtime/event-store.js';

describe('Phase 9 R5 agent output events', () => {
  let repoDir: string;
  let agentDir: string;
  let prevHeartbeatEnv: string | undefined;

  beforeEach(() => {
    repoDir = join(
      tmpdir(),
      `review-loop-aoe-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(repoDir, { recursive: true });
    agentDir = join(repoDir, '.agent');
    mkdirSync(agentDir, { recursive: true });
    prevHeartbeatEnv = process.env.AGENT_HEARTBEAT_INTERVAL_MS;
    process.env.AGENT_HEARTBEAT_INTERVAL_MS = '50';
  });

  afterEach(() => {
    if (prevHeartbeatEnv === undefined) {
      delete process.env.AGENT_HEARTBEAT_INTERVAL_MS;
    } else {
      process.env.AGENT_HEARTBEAT_INTERVAL_MS = prevHeartbeatEnv;
    }
    if (repoDir) {
      try {
        rmSync(repoDir, { recursive: true });
      } catch {
        /* ok */
      }
    }
  });

  it('emits role.output and role.heartbeat with filtered text', async () => {
    // Fake agent: writes a thinking block, visible text, and a JSON tool_use
    // line to stdout, creates the expected artifact, then exits 0 normally.
    const fakeAgentScript = `import { writeFileSync } from 'node:fs';
process.stdout.write('<thinking>secret</thinking>\\n');
process.stdout.write('Editing src/foo.ts\\n');
process.stdout.write('{\"type\":\"tool_use\",\"name\":\"edit\",\"input\":{}}\\n');
writeFileSync(process.argv[2], 'artifact content\\n');
// Exit cleanly so the test exercises the success path.
process.exit(0);
`;
    const scriptPath = join(repoDir, 'fake-agent.mjs');
    writeFileSync(scriptPath, fakeAgentScript, 'utf8');
    const artifactPath = join(repoDir, 'out.txt');
    const promptFilePath = join(repoDir, 'prompt.txt');
    writeFileSync(promptFilePath, 'test prompt', 'utf8');

    const eventBus = new EventBus(agentDir, 'test-run-aoe-001');

    const result = await runAgent(
      {
        role: 'developer',
        project_root: repoDir,
        run_id: 'test-run-aoe-001',
        iteration: 1,
        prompt: 'test prompt',
        prompt_file: promptFilePath,
        expected_artifacts: [artifactPath],
        timeout_seconds: 30,
        command_template: ['node', scriptPath, artifactPath, '{prompt_file}'],
        signal: new AbortController().signal,
        eventBus,
      },
      repoDir,
    );

    expect(result.status).toBe('success');

    // Give pending eventBus.emit writes a chance to flush to disk.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const store = new EventStore(agentDir, 'test-run-aoe-001');
    const events = await store.readAll();

    const outputEvents = events.filter((e) => e.kind === 'role.output');
    expect(outputEvents.length).toBeGreaterThanOrEqual(1);
    const outputTexts = outputEvents
      .map((e) => ((e.payload?.text as string) || ''))
      .join('');
    expect(outputTexts).toContain('Editing src/foo.ts');
    expect(outputTexts).not.toContain('secret');
    expect(outputTexts).not.toContain('tool_use');

    // On-disk stdout transcript still has the raw thinking block and JSON line
    // (filter is observer-only).
    const stdoutPath = result.stdout_path;
    expect(stdoutPath).toBeTruthy();
    if (stdoutPath && existsSync(stdoutPath)) {
      const onDisk = readFileSync(stdoutPath, 'utf8');
      expect(onDisk).toContain('<thinking>secret</thinking>');
      expect(onDisk).toContain('{"type":"tool_use"');
    }
  }, 15000);
});
