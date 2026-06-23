import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const { join, resolve } = path;
import { runOrchestrator } from '../../src/orchestrator/run-orchestrator.js';
import { EventStore } from '../../src/runtime/event-store.js';

function git(repoDir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim();
}

// Dispatcher script: for task-1 (identified by src/part-a/** in the prompt),
// fail the first 3 invocations with AGENT_ERROR (exit 1, no handoff), then
// delegate to fake-agent's task-success behavior on the 4th call. For all
// other tasks, delegate to task-success immediately. This exercises the
// per-task retry loop in runTaskInWorktree.
function writeDispatcherScript(repoDir: string): string {
  const fakeAgentPath = resolve(join(process.cwd(), 'tests', 'fixtures', 'fake-agent.mjs'));
  const scriptPath = join(repoDir, 'fake-agent-dispatcher.mjs');
  const script = `import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : null;
}

const promptFile = getArg('prompt-file');
const runId = getArg('run-id') || 'test-run';
const projectRoot = getArg('project-root') || process.cwd();

// Detect task-1 by its allowed_changes glob.
let isTask1 = false;
if (promptFile && existsSync(promptFile)) {
  const content = readFileSync(promptFile, 'utf8');
  if (content.includes('src/part-a/**')) {
    isTask1 = true;
  }
}

if (isTask1) {
  // Counter file in /tmp tracks invocations per run.
  const counterDir = join(tmpdir(), 'wave-task-retry-counters', runId);
  if (!existsSync(counterDir)) mkdirSync(counterDir, { recursive: true });
  const counterPath = join(counterDir, 'task-1-count');
  let count = 0;
  if (existsSync(counterPath)) {
    count = parseInt(readFileSync(counterPath, 'utf8').trim() || '0', 10) || 0;
  }
  count += 1;
  writeFileSync(counterPath, String(count), 'utf8');
  if (count <= 3) {
    // Fail with AGENT_ERROR: exit non-zero without writing a handoff.
    process.exit(1);
  }
}

// Delegate to fake-agent task-success behavior (writes handoff + impl file
// within the task's allowed_changes).
const fakeAgentPath = ${JSON.stringify(fakeAgentPath)};
const newArgs = [...args];
const idx = newArgs.indexOf('--behavior');
if (idx >= 0) {
  newArgs[idx + 1] = 'task-success';
} else {
  newArgs.push('--behavior', 'task-success');
}

try {
  execFileSync('node', [fakeAgentPath, ...newArgs], { stdio: 'inherit' });
} catch (e) {
  process.exit(typeof e.status === 'number' ? e.status : 1);
}
`;
  writeFileSync(scriptPath, script, 'utf8');
  return scriptPath;
}

function writeFakeAgentConfig(
  repoDir: string,
  dispatcherPath: string,
  maxAgentRetries: number,
): void {
  const fakeAgentPath = resolve(join(process.cwd(), 'tests', 'fixtures', 'fake-agent.mjs'));
  const config = {
    version: 1,
    agents: {
      planner: {
        command: ['node', fakeAgentPath, '--role', 'planner', '--run-id', '{run_id}', '--project-root', '{project_root}', '--prompt-file', '{prompt_file}', '--behavior', 'task-graph'],
        timeout_seconds: 60,
      },
      developer: {
        command: ['node', dispatcherPath, '--role', 'developer', '--run-id', '{run_id}', '--iteration', '{iteration}', '--project-root', '{project_root}', '--prompt-file', '{prompt_file}', '--behavior', 'task-success'],
        timeout_seconds: 60,
      },
      auditor: {
        command: ['node', fakeAgentPath, '--role', 'auditor', '--run-id', '{run_id}', '--iteration', '{iteration}', '--project-root', '{project_root}', '--prompt-file', '{prompt_file}', '--behavior', 'audit-pass'],
        timeout_seconds: 60,
      },
      final_auditor: {
        command: ['node', fakeAgentPath, '--role', 'final-auditor', '--run-id', '{run_id}', '--iteration', '{iteration}', '--project-root', '{project_root}', '--prompt-file', '{prompt_file}', '--behavior', 'audit-pass'],
        timeout_seconds: 60,
      },
    },
    loop: { max_iterations: 1, max_agent_retries: maxAgentRetries },
    git: {
      require_repository: true,
      require_head: true,
      require_clean_worktree: true,
      branch_template: 'agent/{run_id}-{task_slug}',
      commit_on_pass: true,
      commit_template: 'feat(agent): complete {task_slug} [{run_id}]',
      create_tag: false,
      tag_template: 'agent-{run_id}-pass',
      push: false,
    },
    runtime: {
      kill_grace_seconds: 5,
      max_log_bytes: 10485760,
      lock_stale_seconds: 86400,
      agent_idle_timeout_seconds: 30,
    },
  };
  writeFileSync(join(repoDir, 'review-loop.yaml'), JSON.stringify(config, null, 2), 'utf8');
}

function copyPrompts(repoDir: string): void {
  const promptsDir = join(repoDir, 'prompts');
  mkdirSync(promptsDir, { recursive: true });
  const srcPromptsDir = join(process.cwd(), 'prompts');
  for (const fileName of ['planner.md', 'developer.md', 'auditor.md', 'final-auditor.md', 'rework.md']) {
    const source = join(srcPromptsDir, fileName);
    if (existsSync(source)) {
      copyFileSync(source, join(promptsDir, fileName));
    }
  }
}

function createTestRepo(maxAgentRetries: number): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'wave-task-retry-'));
  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  git(repoDir, ['config', 'user.email', 'test@test.com']);
  git(repoDir, ['config', 'user.name', 'Test']);

  writeFileSync(join(repoDir, 'package.json'), JSON.stringify({
    name: 'wave-task-retry-test',
    version: '1.0.0',
    scripts: { test: 'node -e "process.exit(0)"' },
  }), 'utf8');
  writeFileSync(join(repoDir, '.gitignore'), '.agent/**\n', 'utf8');
  mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  writeFileSync(path.join(repoDir, 'src', 'index.ts'), 'export {};\n', 'utf8');
  const dispatcherPath = writeDispatcherScript(repoDir);
  writeFakeAgentConfig(repoDir, dispatcherPath, maxAgentRetries);
  copyPrompts(repoDir);

  git(repoDir, ['add', '-A']);
  git(repoDir, ['commit', '-q', '-m', 'initial']);
  expect(git(repoDir, ['status', '--short', '--untracked-files=all'])).toBe('');
  return repoDir;
}

describe('wave task retry', () => {
  let repoDir: string | undefined;

  afterEach(() => {
    if (repoDir) {
      try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* ok */ }
      repoDir = undefined;
    }
  });

  it('retries a failing task until it succeeds and the wave passes', async () => {
    // max_agent_retries = 3 → 4 total attempts. The dispatcher fails task-1
    // 3 times (exit 1 = AGENT_ERROR) then succeeds on the 4th call.
    repoDir = createTestRepo(3);

    const result = await runOrchestrator({
      project_root: repoDir,
      request: 'Add a two-part feature where part A crashes then recovers',
      task_slug: 'wave-retry',
      parallel: true,
      max_parallel_workers: 2,
    });

    expect(result.phase).toBe('PASSED');
    expect(result.exit_code).toBe(0);
    expect(result.error).toBeNull();

    // The iteration log should contain retry entries for task-1.
    const logPath = join(repoDir, '.agent', 'iteration-log.md');
    expect(existsSync(logPath)).toBe(true);
    const logContent = readFileSync(logPath, 'utf8');
    // Task-1 should have at least 2 retries logged (after the 2nd and 3rd
    // failures; the 4th call succeeds so no 3rd retry is logged).
    const retryLines = logContent.match(/task task-1 retry \d+/g) ?? [];
    expect(retryLines.length).toBeGreaterThanOrEqual(2);

    // Verify task-1 actually needed 4 developer invocations (3 fails + 1
    // success) by reading the dispatcher's counter file.
    const counterPath = path.join(tmpdir(), 'wave-task-retry-counters', result.run_id, 'task-1-count');
    expect(existsSync(counterPath)).toBe(true);
    const counterValue = parseInt(readFileSync(counterPath, 'utf8').trim(), 10);
    expect(counterValue).toBe(4);

    // events.jsonl should contain task.started events for task-1 (at least the
    // initial start). Multiple task.started events would appear if the wave
    // loop re-emits on retry; at minimum we verify the event stream captured
    // task-1's execution.
    const eventStore = new EventStore(join(repoDir, '.agent'), result.run_id);
    const events = await eventStore.readAll();
    const taskStartedEvents = events.filter((e) => e.kind === 'task.started');
    expect(taskStartedEvents.length).toBeGreaterThanOrEqual(1);
    expect(taskStartedEvents.some((e) => e.task_id === 'task-1')).toBe(true);
  }, 120000);
});
